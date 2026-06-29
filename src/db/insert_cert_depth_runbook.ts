import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'SSL Certificate Chain Depth Diagnostic and Trust Store Runbook',
  slug: 'ssl-certificate-chain-depth-runbook',
  excerpt:
    'Step-by-step runbook for diagnosing and resolving SSL certificate chain depth failures across Oracle EBS components: fetching and parsing the full certificate chain with openssl s_client, identifying which trust store is failing and why, updating Oracle Wallet with orapki, updating Java cacerts with keytool, updating WebLogic custom truststores, updating the OS trust store, PL/SQL validation, and crontab monitoring scripts that detect chain depth changes and certificate expiry before they cause production outages.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-29'),
  youtubeUrl: null,
  content: `## Overview

This runbook provides the complete diagnostic and remediation sequence for SSL certificate chain depth failures in Oracle EBS environments. The symptoms are typically: an outbound HTTPS connection from EBS fails with ORA-29024, a PKIX path building failed error in WebLogic logs, or an SSL handshake failure in Oracle HTTP Server — while the same endpoint is reachable from a browser.

Work through Phase 1 (evidence collection) before touching any trust store. The root cause is almost always a missing intermediate CA in the specific trust store used by the failing component — not a depth limit configuration change.

**Components and their trust stores**:

| Component | Trust Store | Location |
|---|---|---|
| UTL_HTTP (PL/SQL) | Oracle Wallet | SET_WALLET path or sqlnet.ora WALLET_LOCATION |
| WebLogic Server | Java cacerts or custom JKS | \$JAVA_HOME/jre/lib/security/cacerts or domain config |
| EBS Java Concurrent Programs | Java cacerts | \$JAVA_HOME/jre/lib/security/cacerts |
| Oracle HTTP Server (inbound) | OHS Wallet | \$INSTANCE_HOME/config/OHS/ohs1/keystores/ |
| Oracle HTTP Server (outbound proxy) | OS trust store | /etc/pki/ca-trust/ (RHEL) |
| OS / curl / wget | OS trust store | /etc/pki/ca-trust/ |

---

## Phase 1: Collect the Evidence

### 1.1 Confirm the Error and Component

\`\`\`sql
-- PL/SQL (UTL_HTTP) failure — run this first to confirm the exact error
SET SERVEROUTPUT ON SIZE 1000000

DECLARE
  v_req  UTL_HTTP.REQ;
  v_resp UTL_HTTP.RESP;
BEGIN
  -- Use the wallet path from the failing PL/SQL package
  UTL_HTTP.SET_WALLET('file:/path/to/oracle/wallet', 'wallet_password');
  UTL_HTTP.SET_TRANSFER_TIMEOUT(30);
  v_req  := UTL_HTTP.BEGIN_REQUEST(
    url    => 'https://failing-endpoint.example.com/',
    method => 'GET'
  );
  v_resp := UTL_HTTP.GET_RESPONSE(v_req);
  DBMS_OUTPUT.PUT_LINE('Status: ' || v_resp.status_code);
  UTL_HTTP.END_RESPONSE(v_resp);
EXCEPTION
  WHEN OTHERS THEN
    DBMS_OUTPUT.PUT_LINE('SQLERRM: ' || SQLERRM);
    DBMS_OUTPUT.PUT_LINE('SQLCODE: ' || SQLCODE);
END;
/
-- ORA-29024 confirms: Oracle Wallet trust chain failure
-- ORA-29273 with different sub-code: network or timeout issue
\`\`\`

\`\`\`bash
# WebLogic / Java failure — check the WebLogic server log
grep -i "PKIX\|certificate\|SSL\|handshake" \
  \${DOMAIN_HOME}/servers/oacore_server1/logs/oacore_server1.log | tail -30

# Oracle HTTP Server failure — check OHS error log
grep -i "ssl\|certificate\|alert" \
  \${INSTANCE_HOME}/diagnostics/logs/OHS/ohs1/ohs1.log | tail -30
\`\`\`

### 1.2 Fetch the Full Certificate Chain from the Failing Endpoint

Run this **from the database server** (for UTL_HTTP failures) or **from the application server** (for WebLogic/OHS failures). The source server matters — some load balancers present different chains based on client IP.

\`\`\`bash
TARGET_HOST=failing-endpoint.example.com
TARGET_PORT=443

# Fetch the full chain and display each certificate
openssl s_client -connect \${TARGET_HOST}:\${TARGET_PORT} \\
  -showcerts 2>/dev/null | \\
  awk '/BEGIN CERT/,/END CERT/' > /tmp/full_chain.pem

# Count how many certificates the server sends
CERT_COUNT=\$(grep -c "BEGIN CERTIFICATE" /tmp/full_chain.pem)
echo "Server-sent certificates: \${CERT_COUNT}"
echo "Total chain depth (including trust store root): \$((CERT_COUNT + 1))"
\`\`\`

### 1.3 Parse and Inspect Each Certificate in the Chain

\`\`\`bash
# Split the chain into individual files
csplit /tmp/full_chain.pem '/-----BEGIN CERTIFICATE-----/' '{*}' \\
  --prefix=/tmp/chain_cert --suffix-format='_%02d.pem' -z 2>/dev/null

# Inspect each certificate
for CERT in /tmp/chain_cert_*.pem; do
  echo "=== \${CERT} ==="
  openssl x509 -in \${CERT} -noout \\
    -subject -issuer -dates \\
    -ext basicConstraints 2>/dev/null
  echo ""
done
\`\`\`

\`\`\`bash
# Quick summary table — subject, issuer, and expiry for each cert
openssl s_client -connect \${TARGET_HOST}:\${TARGET_PORT} -showcerts 2>/dev/null | \\
  awk '
    /BEGIN CERT/ { cert=""; in_cert=1 }
    in_cert { cert = cert "\n" \$0 }
    /END CERT/ {
      in_cert=0
      cmd = "echo \"" cert "\" | openssl x509 -noout -subject -issuer -dates 2>/dev/null"
      system(cmd)
      print "---"
    }
  '
\`\`\`

### 1.4 Map the Chain Depth

After inspecting the certificates, draw the trust chain:

\`\`\`
Chain position  Cert type       Signed by
Depth 0         Leaf (server)   → Intermediate CA 1
Depth 1         Intermediate 1  → Intermediate CA 2 (or Root)
Depth 2         Intermediate 2  → Root CA (if present)
Depth N         Root CA         → self-signed

The Root CA is usually NOT sent by the server — it must be in the trust store.
\`\`\`

Record:
- Total depth (leaf + intermediates + root)
- The Subject CN of every intermediate CA
- The Subject CN and fingerprint of the root CA
- Whether any certificate has expired or is near expiry

---

## Phase 2: Identify Which Trust Store Is Missing the CA

### 2.1 Test Oracle Wallet

\`\`\`bash
WALLET_PATH=/path/to/oracle/wallet

# Display all certificates currently trusted in the wallet
orapki wallet display -wallet \${WALLET_PATH} -complete | \\
  grep -A5 "Trusted Certificates"

# Check if the root CA is in the wallet (match by Subject)
orapki wallet display -wallet \${WALLET_PATH} -complete | \\
  grep -i "DigiCert\|Sectigo\|GlobalSign\|EnterpriseRootCA"
# Replace with the actual root CA name from Phase 1
\`\`\`

\`\`\`bash
# Export wallet contents to PEM for openssl verification
# (requires the wallet password)
openssl pkcs12 -in \${WALLET_PATH}/ewallet.p12 \\
  -nokeys -cacerts -passin pass:\${WALLET_PWD} \\
  -out /tmp/wallet_cacerts.pem 2>/dev/null

# Verify the server's leaf certificate against the wallet CAs
openssl verify -CAfile /tmp/wallet_cacerts.pem /tmp/chain_cert_00.pem
# "OK" = wallet has the needed CAs
# "unable to get local issuer certificate" = wallet is missing an intermediate or root
\`\`\`

### 2.2 Test Java cacerts

\`\`\`bash
# Find the active cacerts file
JAVA_HOME=\$(readlink -f \$(which java) | sed 's|/bin/java||')
CACERTS=\${JAVA_HOME}/lib/security/cacerts

# List trusted root CAs in cacerts (filter for relevant CA name)
keytool -list -keystore \${CACERTS} -storepass changeit 2>/dev/null | \\
  grep -i "digicert\|sectigo\|globalsign\|enterprise"

# Test the full chain against Java cacerts
# (requires the chain in a format keytool can read)
openssl verify -CAfile \${CACERTS} /tmp/chain_cert_00.pem 2>/dev/null
# If this fails, cacerts needs updating
\`\`\`

### 2.3 Test OS Trust Store (RHEL)

\`\`\`bash
# Test against the OS trust bundle
openssl verify \\
  -CAfile /etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem \\
  /tmp/chain_cert_00.pem

# Or use -untrusted to provide the intermediates separately
openssl verify \\
  -CAfile /etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem \\
  -untrusted /tmp/chain_cert_01.pem \\
  /tmp/chain_cert_00.pem
\`\`\`

---

## Phase 3: Update the Oracle Wallet

### 3.1 Download Missing CA Certificates

\`\`\`bash
# For public CAs (DigiCert, Sectigo, GlobalSign, Let's Encrypt, etc.)
# download the CA bundle from the CA's official repository
# For internal/enterprise CAs: obtain from your PKI team

# Verify each downloaded cert matches the chain
openssl x509 -in /tmp/intermediate_ca1.pem -noout -subject -issuer -fingerprint -sha256
openssl x509 -in /tmp/root_ca.pem -noout -subject -issuer -fingerprint -sha256
# Compare fingerprints against what Phase 1 showed in the chain
\`\`\`

### 3.2 Back Up the Wallet

\`\`\`bash
WALLET_PATH=/path/to/oracle/wallet
BACKUP_DIR=/tmp/wallet_backup_\$(date +%Y%m%d_%H%M)
mkdir -p \${BACKUP_DIR}
cp \${WALLET_PATH}/ewallet.p12 \${BACKUP_DIR}/
cp \${WALLET_PATH}/cwallet.sso \${BACKUP_DIR}/ 2>/dev/null
echo "Wallet backed up to \${BACKUP_DIR}"
\`\`\`

### 3.3 Import CA Certificates into the Wallet

Import from Root CA downward (root first, then intermediates):

\`\`\`bash
WALLET_PATH=/path/to/oracle/wallet
WALLET_PWD=\${ORACLE_WALLET_PASSWORD}

# Import the Root CA
orapki wallet add \\
  -wallet \${WALLET_PATH} \\
  -trusted_cert \\
  -cert /tmp/root_ca.pem \\
  -pwd \${WALLET_PWD}

# Import Intermediate CA 2 (policy/issuing CA if present)
orapki wallet add \\
  -wallet \${WALLET_PATH} \\
  -trusted_cert \\
  -cert /tmp/intermediate_ca2.pem \\
  -pwd \${WALLET_PWD}

# Import Intermediate CA 1 (closest to leaf)
orapki wallet add \\
  -wallet \${WALLET_PATH} \\
  -trusted_cert \\
  -cert /tmp/intermediate_ca1.pem \\
  -pwd \${WALLET_PWD}

# Verify all new certs appear in the wallet
orapki wallet display -wallet \${WALLET_PATH} -complete
\`\`\`

### 3.4 Remove Expired CA Certificates

\`\`\`bash
# List all certs with expiry dates
orapki wallet display -wallet \${WALLET_PATH} -complete | \\
  grep -E "Subject:|Valid until:"

# Remove an expired certificate by its DN
# (get exact DN from the orapki display output)
orapki wallet remove \\
  -wallet \${WALLET_PATH} \\
  -trusted_cert_dn "CN=Old Root CA, O=Example Corp, C=US" \\
  -pwd \${WALLET_PWD}
\`\`\`

### 3.5 Validate the Wallet Fix via PL/SQL

\`\`\`sql
SET SERVEROUTPUT ON SIZE 1000000
DECLARE
  v_req  UTL_HTTP.REQ;
  v_resp UTL_HTTP.RESP;
BEGIN
  UTL_HTTP.SET_WALLET('file:/path/to/oracle/wallet', 'wallet_password');
  UTL_HTTP.SET_TRANSFER_TIMEOUT(30);
  v_req  := UTL_HTTP.BEGIN_REQUEST('https://failing-endpoint.example.com/', 'GET');
  v_resp := UTL_HTTP.GET_RESPONSE(v_req);
  DBMS_OUTPUT.PUT_LINE('TLS handshake: SUCCESSFUL');
  DBMS_OUTPUT.PUT_LINE('HTTP status: ' || v_resp.status_code);
  UTL_HTTP.END_RESPONSE(v_resp);
EXCEPTION
  WHEN OTHERS THEN
    DBMS_OUTPUT.PUT_LINE('STILL FAILING: ' || SQLERRM);
END;
/
\`\`\`

---

## Phase 4: Update Java cacerts (WebLogic / Java Concurrent Programs)

### 4.1 Import CA Certificate into cacerts

\`\`\`bash
JAVA_HOME=\$(readlink -f \$(which java) | sed 's|/bin/java||')
CACERTS=\${JAVA_HOME}/lib/security/cacerts

# Import root CA (alias must be unique and descriptive)
keytool -import -noprompt \\
  -alias "enterprise-root-ca-2024" \\
  -file /tmp/root_ca.pem \\
  -keystore \${CACERTS} \\
  -storepass changeit

# Import intermediate CA
keytool -import -noprompt \\
  -alias "enterprise-intermediate-ca1-2024" \\
  -file /tmp/intermediate_ca1.pem \\
  -keystore \${CACERTS} \\
  -storepass changeit

# Verify
keytool -list -keystore \${CACERTS} -storepass changeit 2>/dev/null | \\
  grep "enterprise-"
\`\`\`

### 4.2 Update WebLogic Custom Truststore (if not using cacerts)

\`\`\`bash
# If WebLogic uses a custom JKS truststore (configured in domain/config/config.xml)
# Find the truststore path
grep -i "truststoretype\|truststore" \${DOMAIN_HOME}/config/config.xml | head -5

CUSTOM_TRUST=/path/to/weblogic_trust.jks
TRUST_PWD=\${WL_TRUST_PASSWORD}

keytool -import -noprompt \\
  -alias "enterprise-root-ca-2024" \\
  -file /tmp/root_ca.pem \\
  -keystore \${CUSTOM_TRUST} \\
  -storepass \${TRUST_PWD}

keytool -import -noprompt \\
  -alias "enterprise-intermediate-ca1-2024" \\
  -file /tmp/intermediate_ca1.pem \\
  -keystore \${CUSTOM_TRUST} \\
  -storepass \${TRUST_PWD}
\`\`\`

### 4.3 Bounce WebLogic Managed Servers

\`\`\`bash
# Java truststore changes require a JVM restart to take effect
source /u01/oracle/EBS/EBSapps.env run
\${ADMIN_SCRIPTS_HOME}/admanagedsrvctl.sh stop oacore_server1
\${ADMIN_SCRIPTS_HOME}/admanagedsrvctl.sh start oacore_server1
\`\`\`

---

## Phase 5: Update OS Trust Store (RHEL — OHS Outbound and curl/wget)

\`\`\`bash
# Copy CA certificates into the OS trust anchor directory
cp /tmp/root_ca.pem /etc/pki/ca-trust/source/anchors/enterprise-root-ca-2024.pem
cp /tmp/intermediate_ca1.pem /etc/pki/ca-trust/source/anchors/enterprise-intermediate-ca1.pem

# Rebuild the OS trust bundle (requires root)
sudo update-ca-trust extract

# Verify
openssl verify \\
  -CAfile /etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem \\
  /tmp/chain_cert_00.pem
\`\`\`

---

## Phase 6: Monitoring Scripts

### Script 1: Certificate Chain Depth and Expiry Monitor

\`\`\`bash
#!/bin/bash
# File: /home/oracle/scripts/cert_chain_monitor.sh
# Monitors remote endpoints for certificate chain depth changes and expiry

ENDPOINTS=(
  "payment-gateway.example.com:443"
  "tax-engine.example.com:443"
  "edi-partner.example.com:443"
)

WARN_DAYS=30
CRIT_DAYS=14
ALERT_EMAIL="dba-alerts@example.com"
LOG=/home/oracle/scripts/logs/cert_chain.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')

for ENDPOINT in "\${ENDPOINTS[@]}"; do
  HOST=\$(echo \${ENDPOINT} | cut -d: -f1)
  PORT=\$(echo \${ENDPOINT} | cut -d: -f2)

  # Fetch the leaf certificate expiry
  EXPIRY=\$(echo | openssl s_client -connect \${ENDPOINT} 2>/dev/null | \\
    openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)

  if [[ -z "\${EXPIRY}" ]]; then
    echo "\${TIMESTAMP} | \${ENDPOINT} | UNREACHABLE" >> \${LOG}
    MSG="Subject: [CERT ALERT] Cannot reach \${ENDPOINT}\n\nEndpoint is not responding to TLS connection."
    echo -e "\${MSG}" | /usr/sbin/sendmail \${ALERT_EMAIL}
    continue
  fi

  EXPIRY_EPOCH=\$(date -d "\${EXPIRY}" +%s 2>/dev/null)
  NOW_EPOCH=\$(date +%s)
  DAYS_LEFT=\$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))

  # Get chain depth
  DEPTH=\$(echo | openssl s_client -connect \${ENDPOINT} -showcerts 2>/dev/null | \\
    grep -c "BEGIN CERTIFICATE")

  echo "\${TIMESTAMP} | \${ENDPOINT} | Depth: \${DEPTH} | Expires: \${EXPIRY} | Days left: \${DAYS_LEFT}" >> \${LOG}

  if [ \${DAYS_LEFT} -le \${CRIT_DAYS} ]; then
    MSG="Subject: [CERT CRITICAL] Certificate expires in \${DAYS_LEFT} days on \${HOST}\n\nEndpoint: \${ENDPOINT}\nExpiry: \${EXPIRY}\nChain depth: \${DEPTH}\n\nUpdate Oracle Wallet and Java cacerts immediately."
    echo -e "\${MSG}" | /usr/sbin/sendmail \${ALERT_EMAIL}
  elif [ \${DAYS_LEFT} -le \${WARN_DAYS} ]; then
    MSG="Subject: [CERT WARN] Certificate expires in \${DAYS_LEFT} days on \${HOST}\n\nEndpoint: \${ENDPOINT}\nExpiry: \${EXPIRY}\nChain depth: \${DEPTH}"
    echo -e "\${MSG}" | /usr/sbin/sendmail \${ALERT_EMAIL}
  fi
done
\`\`\`

### Script 2: Oracle Wallet Expiry Audit

\`\`\`bash
#!/bin/bash
# File: /home/oracle/scripts/wallet_expiry_audit.sh
# Checks all trusted CA certificates in the Oracle Wallet for upcoming expiry

WALLETS=(
  "/path/to/db/wallet"
  "/path/to/ohs/wallet"
)

WARN_DAYS=60
CRIT_DAYS=30
ALERT_EMAIL="dba-alerts@example.com"
LOG=/home/oracle/scripts/logs/wallet_expiry.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')

for WALLET in "\${WALLETS[@]}"; do
  [[ -f "\${WALLET}/ewallet.p12" ]] || { echo "\${TIMESTAMP} | \${WALLET} | NOT FOUND" >> \${LOG}; continue; }

  # Extract all CA certificates and check expiry
  openssl pkcs12 -in "\${WALLET}/ewallet.p12" \\
    -nokeys -cacerts -passin pass:\${ORACLE_WALLET_PASSWORD} 2>/dev/null | \\
  awk '/BEGIN CERT/,/END CERT/' | \\
  csplit - '/BEGIN CERT/' '{*}' --prefix=/tmp/wc_ --suffix-format='%03d.pem' -z 2>/dev/null

  for CERT in /tmp/wc_*.pem; do
    SUBJECT=\$(openssl x509 -in \${CERT} -noout -subject 2>/dev/null | sed 's/subject=//')
    EXPIRY=\$(openssl x509 -in \${CERT} -noout -enddate 2>/dev/null | cut -d= -f2)
    EXPIRY_EPOCH=\$(date -d "\${EXPIRY}" +%s 2>/dev/null)
    NOW_EPOCH=\$(date +%s)
    DAYS_LEFT=\$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))

    echo "\${TIMESTAMP} | \${WALLET} | \${SUBJECT} | Expires: \${EXPIRY} | Days: \${DAYS_LEFT}" >> \${LOG}

    if [ \${DAYS_LEFT} -le \${CRIT_DAYS} ]; then
      MSG="Subject: [WALLET CRITICAL] CA cert expires in \${DAYS_LEFT} days\n\nWallet: \${WALLET}\nCert: \${SUBJECT}\nExpiry: \${EXPIRY}\n\nRenew and reimport immediately."
      echo -e "\${MSG}" | /usr/sbin/sendmail \${ALERT_EMAIL}
    elif [ \${DAYS_LEFT} -le \${WARN_DAYS} ]; then
      MSG="Subject: [WALLET WARN] CA cert expires in \${DAYS_LEFT} days\n\nWallet: \${WALLET}\nCert: \${SUBJECT}\nExpiry: \${EXPIRY}"
      echo -e "\${MSG}" | /usr/sbin/sendmail \${ALERT_EMAIL}
    fi
    rm -f \${CERT}
  done
done
\`\`\`

### Script 3: Java cacerts Expiry Audit

\`\`\`bash
#!/bin/bash
# File: /home/oracle/scripts/cacerts_expiry_audit.sh
# Audits all non-standard entries in Java cacerts for expiry

JAVA_HOME=\$(readlink -f \$(which java) | sed 's|/bin/java||')
CACERTS=\${JAVA_HOME}/lib/security/cacerts
WARN_DAYS=60
ALERT_EMAIL="dba-alerts@example.com"
LOG=/home/oracle/scripts/logs/cacerts_expiry.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')

# List all aliases in cacerts and check expiry
keytool -list -v -keystore \${CACERTS} -storepass changeit 2>/dev/null | \\
  awk '
    /Alias name:/ { alias = \$NF }
    /Valid from:/ {
      # Parse "Valid from: ... until: <date>"
      match(\$0, /until: (.+)/, arr)
      if (arr[1]) print alias "|" arr[1]
    }
  ' | while IFS="|" read ALIAS EXPIRY; do
    EXPIRY_EPOCH=\$(date -d "\${EXPIRY}" +%s 2>/dev/null) || continue
    NOW_EPOCH=\$(date +%s)
    DAYS_LEFT=\$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))

    echo "\${TIMESTAMP} | \${ALIAS} | Days left: \${DAYS_LEFT}" >> \${LOG}

    if [ \${DAYS_LEFT} -le \${WARN_DAYS} ] && [ \${DAYS_LEFT} -ge 0 ]; then
      MSG="Subject: [CACERTS WARN] Java cacerts entry expires in \${DAYS_LEFT} days\n\nAlias: \${ALIAS}\nExpiry: \${EXPIRY}\n\nRun: keytool -delete -alias \"\${ALIAS}\" then re-import."
      echo -e "\${MSG}" | /usr/sbin/sendmail \${ALERT_EMAIL}
    fi
  done
\`\`\`

### Crontab Setup

\`\`\`bash
# Add to oracle user crontab: crontab -e

# Remote endpoint chain depth and expiry: daily at 07:00
0 7 * * * /home/oracle/scripts/cert_chain_monitor.sh >> /dev/null 2>&1

# Oracle Wallet expiry audit: daily at 07:15
15 7 * * * /home/oracle/scripts/wallet_expiry_audit.sh >> /dev/null 2>&1

# Java cacerts expiry audit: weekly on Monday
0 7 * * 1 /home/oracle/scripts/cacerts_expiry_audit.sh >> /dev/null 2>&1

# Log rotation
0 3 * * 0 find /home/oracle/scripts/logs -name "cert_*.log" -mtime +60 -delete
\`\`\`

---

## Quick Reference: Trust Store Update Commands

\`\`\`bash
# Oracle Wallet — add trusted CA
orapki wallet add -wallet /path/wallet -trusted_cert -cert /tmp/ca.pem -pwd <pwd>

# Oracle Wallet — display contents
orapki wallet display -wallet /path/wallet -complete

# Oracle Wallet — remove expired cert by DN
orapki wallet remove -wallet /path/wallet \\
  -trusted_cert_dn "CN=Old CA, O=Example, C=US" -pwd <pwd>

# Java cacerts — add CA
keytool -import -noprompt -alias "new-ca-2024" -file /tmp/ca.pem \\
  -keystore \$JAVA_HOME/lib/security/cacerts -storepass changeit

# Java cacerts — list
keytool -list -keystore \$JAVA_HOME/lib/security/cacerts -storepass changeit

# Java cacerts — delete entry
keytool -delete -alias "old-ca" \\
  -keystore \$JAVA_HOME/lib/security/cacerts -storepass changeit

# OS trust store (RHEL) — add and rebuild
cp ca.pem /etc/pki/ca-trust/source/anchors/
sudo update-ca-trust extract

# openssl — verify leaf against a CA bundle
openssl verify -CAfile /path/to/ca-bundle.pem /tmp/leaf.pem

# openssl — fetch and display full chain
openssl s_client -connect host:443 -showcerts 2>/dev/null | \\
  awk '/BEGIN CERT/,/END CERT/'
\`\`\``,
};

async function main() {
  console.log('Inserting certificate chain depth runbook...');
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
