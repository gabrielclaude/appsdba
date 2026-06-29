import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Demystifying ORA-29024: Solving Global Credit Card Processing Failures in Oracle EBS 12.2',
  slug: 'ora-29024-oracle-ebs-credit-card-ssl-wallet',
  excerpt:
    'A production incident guide for the ORA-29273 / ORA-29024 certificate validation failure that silently kills all outbound HTTPS calls from Oracle EBS — covering why the database tier uses an Oracle Wallet rather than the WebLogic truststore, the two triggers that cause overnight failures (gateway certificate rollover and wallet cert expiry), the exact diagnostic and fix sequence using openssl and orapki, PL/SQL validation before touching EBS, and a crontab monitoring script that alerts before certificates expire.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-29'),
  youtubeUrl: null,
  content: `## Introduction

Few alerts spike an Apps DBA's adrenaline like a global production outage on a Monday morning. When a critical third-party integration — such as a credit card payment gateway — suddenly breaks across all channels simultaneously, operations halt instantly. Phone calls start arriving before the first coffee.

The defining characteristic of this failure mode is its totality. It does not affect one user, one browser, or one geography. It breaks everything at once: front-end Oracle Forms users processing card payments, back-end Concurrent Programs running batch settlements, and any custom PL/SQL integration package that calls the payment gateway directly. All of them fail with the same error at the same moment:

\`\`\`
ORA-29273: HTTP request failed
ORA-29024: Certificate validation failure-70
\`\`\`

This guide explains exactly why this happens, why standard WebLogic truststore fixes do not resolve it, and the precise sequence of steps that restores secure outbound communication from the Oracle Database tier.

---

## Understanding the Error Chain

**ORA-29273: HTTP request failed** is the surface error. It means that a PL/SQL call using \`UTL_HTTP\` (Oracle's built-in HTTP client package) attempted to reach an external HTTPS endpoint and failed. The error does not indicate a network connectivity failure — the TCP connection was established successfully.

**ORA-29024: Certificate validation failure** is the root error, propagated from Oracle's SSL/TLS library. It means that the Oracle Database evaluated the SSL certificate presented by the remote server and rejected it because it could not build a valid trust chain from the remote server's certificate back to a trusted root Certificate Authority (CA) in its local trust store.

Error code **-70** is Oracle's internal SSL error code for \`SSL_ERROR_BAD_SERVER_CERTIFICATE\` — the server's certificate chain is structurally valid but not trusted because one or more certificates in the chain are absent from, or expired in, the local trust store.

The key word is **local**. This trust store is not the operating system's trust store. It is not WebLogic's Java truststore (\`cacerts\`). It is an **Oracle Wallet**.

---

## Why Oracle Wallet — Not the WebLogic Truststore

This distinction eliminates the majority of incorrect troubleshooting paths.

When EBS application tier components (WebLogic Managed Servers, Oracle HTTP Server, Java concurrent programs using Apache HttpClient) make outbound HTTPS calls, they use the JVM's truststore — typically \`\$JAVA_HOME/jre/lib/security/cacerts\` — or a custom WebLogic truststore configured in the domain. Standard Java certificate management tools (\`keytool\`, WebLogic console trust configuration) govern this layer.

When **PL/SQL packages** running inside the Oracle Database make outbound HTTPS calls via \`UTL_HTTP\`, the call originates from the database engine's SSL/TLS library — not from Java. The database engine has its own trust store: an **Oracle Wallet** (\`ewallet.p12\` or \`cwallet.sso\`). The wallet's location is specified either in the \`UTL_HTTP.SET_WALLET\` call within the PL/SQL package or as a database-level wallet path in the \`sqlnet.ora\` file.

\`\`\`
Payment Flow → PL/SQL package calls UTL_HTTP
  UTL_HTTP → Oracle Database SSL layer
  Oracle Database SSL layer → reads Oracle Wallet for trusted CAs
  Oracle Wallet missing gateway CA → ORA-29024
\`\`\`

No amount of \`keytool\` changes, WebLogic truststore updates, or OS \`update-ca-trust\` operations will resolve ORA-29024 for PL/SQL UTL_HTTP calls. Only the Oracle Wallet matters here.

---

## Why Did It Break Overnight?

If payment processing worked on Friday and failed on Monday, one of two things changed:

### Trigger 1: Gateway Certificate Rollover

Payment providers rotate their SSL/TLS certificates periodically — typically annually or when a CA audit requires it. When the provider replaces their server certificate, they may also use a different Intermediate CA or even a different Root CA than before. If the new Intermediate CA or Root CA is not present in your Oracle Wallet, the trust chain cannot be completed and ORA-29024 follows.

Gateway certificate rollovers happen on the provider's schedule, not yours. Providers typically announce this in maintenance notices that may not reach the DBA team.

### Trigger 2: Wallet Certificate Expiry

Root CA and Intermediate CA certificates have validity periods — typically 5–25 years for Root CAs and 1–10 years for Intermediates. If a CA certificate in your Oracle Wallet has expired, Oracle will not use it to validate a trust chain even if the remote server's certificate is technically signed by that CA. The result is the same ORA-29024.

Wallet certificate expiry is completely silent. There is no Oracle alert, no database log entry, no EBS notification. The certificate expires at midnight and the next outbound call fails.

---

## Diagnostic Sequence

### Step 1: Locate the Active Oracle Wallet

The Oracle Wallet path is referenced in one of three places:

\`\`\`sql
-- Option A: UTL_HTTP call within the payment PL/SQL package
-- Search for SET_WALLET calls in package source:
SELECT OWNER, NAME, TEXT
FROM DBA_SOURCE
WHERE TYPE IN ('PACKAGE','PACKAGE BODY','PROCEDURE')
AND UPPER(TEXT) LIKE '%SET_WALLET%'
ORDER BY OWNER, NAME, LINE;
\`\`\`

\`\`\`bash
# Option B: sqlnet.ora wallet configuration (database-level default)
grep -i wallet \$ORACLE_HOME/network/admin/sqlnet.ora
# Look for: WALLET_LOCATION = (SOURCE=(METHOD=FILE)(METHOD_DATA=(DIRECTORY=<path>)))

# Option C: EBS system profile option storing the wallet path
sqlplus apps/<password> << 'EOF'
SELECT PROFILE_OPTION_VALUE
FROM FND_PROFILE_OPTION_VALUES FPOV
JOIN FND_PROFILE_OPTIONS FPO ON FPO.PROFILE_OPTION_ID = FPOV.PROFILE_OPTION_ID
WHERE FPO.PROFILE_OPTION_NAME LIKE '%WALLET%'
AND FPOV.LEVEL_ID = 10001;
EOF
\`\`\`

Note the wallet path — you will need it for every subsequent step.

### Step 2: Fetch the Gateway's Current Certificate Chain

Run \`openssl\` from the **database server** (not the app tier — the error originates from the DB tier) to see exactly what the payment gateway is presenting:

\`\`\`bash
openssl s_client -connect payment-gateway.example.com:443 -showcerts 2>/dev/null
\`\`\`

The output will show the full certificate chain presented by the server. Each certificate block begins with \`-----BEGIN CERTIFICATE-----\` and ends with \`-----END CERTIFICATE-----\`. Extract each block — typically:
1. The server leaf certificate (you don't need to import this)
2. One or more Intermediate CA certificates (you need these)
3. The Root CA certificate (you need this)

Save each CA certificate to a separate \`.pem\` file on the database server:

\`\`\`bash
# Pipe through openssl x509 to get readable details about each cert:
echo | openssl s_client -connect payment-gateway.example.com:443 -showcerts 2>/dev/null \\
  | openssl x509 -noout -subject -issuer -dates
\`\`\`

### Step 3: Inspect the Current Oracle Wallet

\`\`\`bash
# Display all certificates currently in the wallet
WALLET_PATH=/path/to/oracle/wallet

orapki wallet display -wallet \${WALLET_PATH}

# For full certificate details including Subject, Issuer, and expiry dates:
orapki wallet display -wallet \${WALLET_PATH} -complete
\`\`\`

Compare the CA certificates shown in the wallet against the CA hierarchy fetched in Step 2. Look for:
- **Missing CAs**: Intermediate or Root CA from Step 2 not present in the wallet
- **Expired CAs**: Any wallet certificate with a \`Valid until\` date in the past

### Step 4: Download the Missing CA Certificates

For public CA certificates (DigiCert, Comodo, Sectigo, GlobalSign, etc.), download the correct PEM-format files from the CA's official certificate repository. For private or internal CAs, obtain the certificate from your PKI team.

Verify each downloaded certificate matches what the gateway presented:

\`\`\`bash
# Check the subject and validity of a downloaded cert file
openssl x509 -in /tmp/intermediate_ca.pem -noout -subject -issuer -dates
openssl x509 -in /tmp/root_ca.pem -noout -subject -issuer -dates
\`\`\`

The Subject CN of the Root CA certificate must match the Issuer field of the Intermediate CA, and the Subject CN of the Intermediate CA must match the Issuer field of the server certificate shown by \`openssl s_client\`.

### Step 5: Import Missing Certificates into the Wallet

\`\`\`bash
WALLET_PATH=/path/to/oracle/wallet

# Import the Intermediate CA certificate
orapki wallet add \\
  -wallet \${WALLET_PATH} \\
  -trusted_cert \\
  -cert /tmp/intermediate_ca.pem \\
  -pwd <wallet_password>

# Import the Root CA certificate
orapki wallet add \\
  -wallet \${WALLET_PATH} \\
  -trusted_cert \\
  -cert /tmp/root_ca.pem \\
  -pwd <wallet_password>

# Verify the new certificates appear in the wallet
orapki wallet display -wallet \${WALLET_PATH}
\`\`\`

**Auto-login wallets**: If the wallet uses an auto-login file (\`cwallet.sso\`) for background process access, the \`orapki wallet add\` command updates both \`ewallet.p12\` and \`cwallet.sso\` automatically. No database restart is required — the next UTL_HTTP call reads the updated wallet immediately.

**Password-only wallets**: If the wallet does not have auto-login and background database processes access it via a password configured in \`sqlnet.ora\` or in the PL/SQL code, ensure the password is consistent after the update.

---

## Validation: Test via PL/SQL Before Touching EBS

Before declaring success, test directly from the database via SQL*Plus. This is faster and more targeted than running a full EBS transaction or concurrent program:

\`\`\`sql
SET SERVEROUTPUT ON SIZE 1000000

DECLARE
  v_req    UTL_HTTP.REQ;
  v_resp   UTL_HTTP.RESP;
  v_buffer VARCHAR2(4000);
BEGIN
  -- Set the wallet to use for this session
  UTL_HTTP.SET_WALLET(
    'file:/path/to/oracle/wallet',
    'wallet_password'
  );

  -- Set a reasonable timeout (seconds)
  UTL_HTTP.SET_TRANSFER_TIMEOUT(30);

  -- Attempt the HTTPS connection
  v_req := UTL_HTTP.BEGIN_REQUEST(
    url    => 'https://payment-gateway.example.com/',
    method => 'GET'
  );

  v_resp := UTL_HTTP.GET_RESPONSE(v_req);

  DBMS_OUTPUT.PUT_LINE('HTTP Status Code : ' || v_resp.status_code);
  DBMS_OUTPUT.PUT_LINE('HTTP Status Reason: ' || v_resp.reason_phrase);
  DBMS_OUTPUT.PUT_LINE('TLS Handshake    : SUCCESSFUL');

  UTL_HTTP.END_RESPONSE(v_resp);

EXCEPTION
  WHEN OTHERS THEN
    DBMS_OUTPUT.PUT_LINE('ERROR: ' || SQLERRM);
    DBMS_OUTPUT.PUT_LINE('If ORA-29024 persists, check wallet path and CA certificates.');
END;
/
\`\`\`

A return of any HTTP status code (200, 301, 400, 403) confirms that the SSL handshake succeeded. The gateway's response code does not matter for this test — only the absence of ORA-29024 matters. If ORA-29024 still appears, re-examine the CA chain in Step 2 for additional intermediate certificates that may need importing.

---

## Summary

The ORA-29273/ORA-29024 error pattern in Oracle EBS 12.2 is a database-tier trust chain failure, not an application tier certificate problem. PL/SQL \`UTL_HTTP\` calls bypass WebLogic, the JVM, and the operating system's certificate store entirely — they use only the Oracle Wallet assigned to the database. When a payment provider rolls their SSL certificate to a new CA hierarchy, or when a CA certificate in the wallet silently expires, every outbound HTTPS call from PL/SQL fails simultaneously across all users and all batch programs.

The fix is always at the wallet level: fetch the current CA chain from the gateway using \`openssl s_client\`, compare against the wallet contents using \`orapki wallet display\`, and import any missing or replacement CA certificates using \`orapki wallet add\`. Because the Oracle Wallet is read at request time rather than at database startup, the fix takes effect on the next call without requiring a database or EBS restart.

**Key points**:
- The Oracle Wallet is independent of the WebLogic truststore, OS trust store, and Java \`cacerts\` — changes to those have no effect on UTL_HTTP
- Both trigger types (gateway cert rollover and wallet cert expiry) produce identical ORA-29024 symptoms
- Auto-login wallets (\`cwallet.sso\`) update immediately; password-only wallets require consistent password configuration
- Validate with an anonymous PL/SQL block before running EBS forms or concurrent programs
- Proactive monitoring of wallet certificate expiry dates prevents the overnight failure scenario

The companion runbook provides the complete command sequence for each phase, including the specific \`orapki\` flags, the PL/SQL test block, and crontab monitoring scripts that alert when any wallet certificate or remote gateway certificate approaches its expiry date.`,
};

async function main() {
  console.log('Inserting ORA-29024 EBS wallet blog post...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: {
      title: post.title,
      excerpt: post.excerpt,
      content: post.content,
      category: post.category,
      published: post.published,
      isPremium: post.isPremium,
      publishedAt: post.publishedAt,
      youtubeUrl: post.youtubeUrl,
    },
  });
  console.log('Inserted:', JSON.stringify(post.title));
}

main().catch(console.error);
