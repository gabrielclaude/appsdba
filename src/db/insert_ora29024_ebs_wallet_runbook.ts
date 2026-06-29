import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'ORA-29024 EBS Runbook: Oracle Wallet Certificate Fix for Payment Gateway SSL Failures',
  slug: 'ora-29024-oracle-ebs-ssl-wallet-runbook',
  excerpt:
    'Step-by-step runbook for diagnosing and resolving ORA-29024 certificate validation failures in Oracle EBS 12.2 — locating the Oracle Wallet used by UTL_HTTP PL/SQL calls, fetching the current gateway certificate chain with openssl s_client, inspecting wallet contents with orapki, downloading and importing missing CA certificates, testing with an anonymous PL/SQL block, and a crontab monitoring script that checks wallet certificate expiry dates and remote endpoint certificate expiry against configurable thresholds.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-29'),
  youtubeUrl: null,
  content: `## Overview

This runbook resolves the ORA-29273 / ORA-29024 error that stops all outbound HTTPS calls from Oracle Database PL/SQL packages in Oracle EBS 12.2. The error occurs when the Oracle Wallet used by \`UTL_HTTP\` does not contain the Certificate Authority (CA) certificates needed to validate the remote server's SSL certificate chain.

**Environment**:
- Oracle EBS: 12.2.x
- Oracle Database: 19c
- OS: Oracle Linux / RHEL 8 or 9
- Wallet type: Oracle Wallet (orapki-managed \`ewallet.p12\` / \`cwallet.sso\`)
- Payment gateway endpoint: \`payment-gateway.example.com:443\`

**Wallet path placeholder**: \`/u01/oracle/product/19.3.0/dbhome_1/wallet\`
Replace this with the actual path found in Phase 1.

---

## Phase 1: Confirm the Error and Locate the Wallet

### 1.1 Reproduce the Error in SQL*Plus

\`\`\`sql
-- Connect to the database as APPS or the schema owner of the payment package
sqlplus apps/<password>

SET SERVEROUTPUT ON
DECLARE
  v_req  UTL_HTTP.REQ;
  v_resp UTL_HTTP.RESP;
BEGIN
  v_req := UTL_HTTP.BEGIN_REQUEST('https://payment-gateway.example.com/');
  v_resp := UTL_HTTP.GET_RESPONSE(v_req);
  DBMS_OUTPUT.PUT_LINE('HTTP Status: ' || v_resp.status_code);
  UTL_HTTP.END_RESPONSE(v_resp);
EXCEPTION
  WHEN OTHERS THEN
    DBMS_OUTPUT.PUT_LINE('Error: ' || SQLERRM);
END;
/
-- Expect: ORA-29273 / ORA-29024 to confirm the wallet is the issue
\`\`\`

### 1.2 Find the Wallet Path Used by the Payment Package

\`\`\`sql
-- Search PL/SQL source for SET_WALLET calls to find the wallet path
SELECT OWNER, NAME, LINE, TEXT
FROM DBA_SOURCE
WHERE UPPER(TEXT) LIKE '%SET_WALLET%'
ORDER BY OWNER, NAME, LINE;
\`\`\`

\`\`\`bash
# Check sqlnet.ora for a database-level wallet default
grep -i wallet \${ORACLE_HOME}/network/admin/sqlnet.ora

# Common output:
# WALLET_LOCATION =
#   (SOURCE =
#     (METHOD = FILE)
#     (METHOD_DATA =
#       (DIRECTORY = /u01/oracle/product/19.3.0/dbhome_1/wallet)
#     )
#   )
\`\`\`

\`\`\`sql
-- Check EBS system profiles for wallet path configuration
SELECT FPO.PROFILE_OPTION_NAME, FPOV.PROFILE_OPTION_VALUE
FROM FND_PROFILE_OPTION_VALUES FPOV
JOIN FND_PROFILE_OPTIONS FPO ON FPO.PROFILE_OPTION_ID = FPOV.PROFILE_OPTION_ID
WHERE (UPPER(FPO.PROFILE_OPTION_NAME) LIKE '%WALLET%'
    OR UPPER(FPO.PROFILE_OPTION_NAME) LIKE '%PAYMENT%GATEWAY%'
    OR UPPER(FPO.PROFILE_OPTION_NAME) LIKE '%HTTPS%')
AND FPOV.LEVEL_ID = 10001;
\`\`\`

Record the wallet path — it is used throughout this runbook as \`WALLET_PATH\`.

### 1.3 Verify the Wallet Files Exist

\`\`\`bash
WALLET_PATH=/u01/oracle/product/19.3.0/dbhome_1/wallet

ls -la \${WALLET_PATH}/
# Expect:
#   ewallet.p12   — password-protected PKCS#12 wallet
#   cwallet.sso   — auto-login wallet (if configured)

# If cwallet.sso exists: background processes access the wallet without a password
# If only ewallet.p12: processes need the wallet password at runtime
\`\`\`

---

## Phase 2: Fetch the Gateway's Current Certificate Chain

Run all openssl commands from the **database server**, not the app tier. The error originates from the DB tier's network stack.

### 2.1 Display the Full Certificate Chain

\`\`\`bash
GATEWAY_HOST=payment-gateway.example.com
GATEWAY_PORT=443

# Show all certificates presented by the server (server + intermediates)
openssl s_client -connect \${GATEWAY_HOST}:\${GATEWAY_PORT} -showcerts 2>/dev/null

# Count how many certificates are in the chain:
openssl s_client -connect \${GATEWAY_HOST}:\${GATEWAY_PORT} -showcerts 2>/dev/null \\
  | grep -c "BEGIN CERTIFICATE"
# Typical result: 2 (server cert + 1 intermediate) or 3 (server + 2 intermediates)
\`\`\`

### 2.2 Extract Each Certificate to a File

\`\`\`bash
mkdir -p /tmp/gateway_certs
cd /tmp/gateway_certs

# Extract all certificates in the chain to individual numbered files
# The server leaf cert will be cert_0.pem, intermediate(s) will be cert_1.pem, cert_2.pem etc.
openssl s_client -connect \${GATEWAY_HOST}:\${GATEWAY_PORT} -showcerts 2>/dev/null \\
  | awk '/BEGIN CERTIFICATE/{n++; f="cert_"(n-1)".pem"} f{print > f} /END CERTIFICATE/{f=""}'

# Display subject, issuer, and validity for each extracted cert
for CERT in /tmp/gateway_certs/cert_*.pem; do
  echo "=== \${CERT} ==="
  openssl x509 -in "\${CERT}" -noout -subject -issuer -dates
  echo ""
done
\`\`\`

**Interpret the output**: Identify which certificates are CA certificates (their Subject and Issuer will differ from the server leaf cert, and the Subject of a CA cert will match the Issuer field of another cert in the chain). You need to import only the CA certificates (Intermediate CAs and Root CA) — never the server leaf certificate.

### 2.3 Identify the Root CA

\`\`\`bash
# The Root CA is self-signed: its Subject and Issuer are identical
for CERT in /tmp/gateway_certs/cert_*.pem; do
  SUBJ=\$(openssl x509 -in "\${CERT}" -noout -subject)
  ISSU=\$(openssl x509 -in "\${CERT}" -noout -issuer)
  if [ "\${SUBJ}" = "\${ISSU}" ]; then
    echo "ROOT CA: \${CERT}"
    echo "\${SUBJ}"
  else
    echo "INTERMEDIATE or LEAF: \${CERT}"
    echo "Subject: \${SUBJ}"
    echo "Issuer:  \${ISSU}"
  fi
  echo ""
done
\`\`\`

---

## Phase 3: Inspect the Oracle Wallet Contents

\`\`\`bash
WALLET_PATH=/u01/oracle/product/19.3.0/dbhome_1/wallet

# List all certificates currently in the wallet
orapki wallet display -wallet \${WALLET_PATH}

# Full display including validity dates (requires wallet password)
orapki wallet display -wallet \${WALLET_PATH} -complete -pwd <wallet_password>
\`\`\`

### 3.1 Check for Expired Wallet Certificates

\`\`\`bash
# Extract all certs from the wallet's PKCS12 file and check expiry dates
openssl pkcs12 -in \${WALLET_PATH}/ewallet.p12 \\
  -nokeys -passin pass:<wallet_password> 2>/dev/null \\
  | openssl crl2pkcs7 -nocrl -certfile /dev/stdin 2>/dev/null \\
  | openssl pkcs7 -print_certs -noout 2>/dev/null

# Alternative: list cert subjects and expiry one-liner
openssl pkcs12 -in \${WALLET_PATH}/ewallet.p12 \\
  -nokeys -passin pass:<wallet_password> 2>/dev/null \\
  | awk '/BEGIN CERTIFICATE/{n++; f="/tmp/wlt_cert_"n".pem"} f{print > f} /END CERTIFICATE/{f=""}'

for C in /tmp/wlt_cert_*.pem; do
  echo "=== \$C ==="
  openssl x509 -in "\$C" -noout -subject -dates 2>/dev/null
done

rm -f /tmp/wlt_cert_*.pem
\`\`\`

### 3.2 Cross-Reference Wallet vs Gateway Chain

Create a comparison table:

\`\`\`bash
echo "--- CERTIFICATES IN WALLET ---"
orapki wallet display -wallet \${WALLET_PATH} | grep -E "(Subject|Valid)"

echo ""
echo "--- CERTIFICATES FROM GATEWAY ---"
for CERT in /tmp/gateway_certs/cert_*.pem; do
  openssl x509 -in "\${CERT}" -noout -subject -dates
done
\`\`\`

Note any CA Subject that appears in the gateway chain but is absent from the wallet — these are the certificates you need to import.

---

## Phase 4: Download Missing CA Certificates

For public CAs, download the correct PEM-format certificates:

\`\`\`bash
# Example: download from CA's official repository
# Adjust URLs to match the actual CA identified in Phase 2

# DigiCert example:
curl -s -o /tmp/gateway_certs/root_ca.pem \
  'https://cacerts.digicert.com/DigiCertGlobalRootCA.crt.pem'

curl -s -o /tmp/gateway_certs/intermediate_ca.pem \
  'https://cacerts.digicert.com/DigiCertTLSRSASHA2562020CA1.crt.pem'

# Verify what you downloaded matches what the gateway presented:
DOWNLOADED_SUBJ=\$(openssl x509 -in /tmp/gateway_certs/root_ca.pem -noout -subject)
GATEWAY_ISSUER=\$(openssl x509 -in /tmp/gateway_certs/cert_1.pem -noout -issuer)
echo "Downloaded Root Subject: \${DOWNLOADED_SUBJ}"
echo "Gateway Chain Issuer:    \${GATEWAY_ISSUER}"
# These must match for the trust chain to complete
\`\`\`

For internal/private CAs, obtain the PEM-format certificate from your PKI or security team and copy it to the database server.

---

## Phase 5: Import Certificates into the Oracle Wallet

### 5.1 Back Up the Wallet Before Modifying

\`\`\`bash
BACKUP_DIR=/backup/oracle_wallet/\$(date +%Y%m%d_%H%M%S)
mkdir -p \${BACKUP_DIR}
cp \${WALLET_PATH}/ewallet.p12 \${BACKUP_DIR}/
[ -f \${WALLET_PATH}/cwallet.sso ] && cp \${WALLET_PATH}/cwallet.sso \${BACKUP_DIR}/
echo "Wallet backed up to \${BACKUP_DIR}"
\`\`\`

### 5.2 Import Each Missing CA Certificate

Import the Root CA first, then Intermediate CAs (order matters — import from root down):

\`\`\`bash
WALLET_PATH=/u01/oracle/product/19.3.0/dbhome_1/wallet

# Import Root CA
orapki wallet add \\
  -wallet \${WALLET_PATH} \\
  -trusted_cert \\
  -cert /tmp/gateway_certs/root_ca.pem \\
  -pwd <wallet_password>

# Import Intermediate CA (repeat for each intermediate in the chain)
orapki wallet add \\
  -wallet \${WALLET_PATH} \\
  -trusted_cert \\
  -cert /tmp/gateway_certs/intermediate_ca.pem \\
  -pwd <wallet_password>

# Verify the new certificates are now in the wallet
orapki wallet display -wallet \${WALLET_PATH}
\`\`\`

### 5.3 Remove Expired Certificates from the Wallet

If inspection found expired CA certificates:

\`\`\`bash
# List certificates with their serial numbers (needed for removal)
orapki wallet display -wallet \${WALLET_PATH} -complete -pwd <wallet_password> \\
  | grep -A 5 "Trusted"

# Remove an expired certificate by its Subject DN
# Note: orapki remove requires the exact DN as shown in the wallet display
orapki wallet remove \\
  -wallet \${WALLET_PATH} \\
  -trusted_cert_all \\
  -dn "CN=Old Root CA,O=Old CA Org,C=US" \\
  -pwd <wallet_password>

# After removing, verify the expired cert is gone:
orapki wallet display -wallet \${WALLET_PATH}
\`\`\`

---

## Phase 6: Test the Fix via PL/SQL

Do not restart any EBS services — test directly from the database first.

### 6.1 Basic Handshake Test

\`\`\`sql
-- Run in SQL*Plus as a privileged user (SYS or APPS)
SET SERVEROUTPUT ON SIZE 1000000

DECLARE
  v_req    UTL_HTTP.REQ;
  v_resp   UTL_HTTP.RESP;
  v_buffer VARCHAR2(4000);
BEGIN
  -- Specify the updated wallet
  UTL_HTTP.SET_WALLET(
    'file:/u01/oracle/product/19.3.0/dbhome_1/wallet',
    '<wallet_password>'
  );
  UTL_HTTP.SET_TRANSFER_TIMEOUT(30);

  -- Attempt HTTPS connection to the payment gateway
  v_req  := UTL_HTTP.BEGIN_REQUEST(
              'https://payment-gateway.example.com/',
              'GET', 'HTTP/1.1');
  UTL_HTTP.SET_HEADER(v_req, 'Host', 'payment-gateway.example.com');
  UTL_HTTP.SET_HEADER(v_req, 'User-Agent', 'OracleDB-UTL_HTTP/19c');
  UTL_HTTP.SET_HEADER(v_req, 'Connection', 'close');

  v_resp := UTL_HTTP.GET_RESPONSE(v_req);
  DBMS_OUTPUT.PUT_LINE('TLS Handshake: SUCCESS');
  DBMS_OUTPUT.PUT_LINE('HTTP Status:   ' || v_resp.status_code || ' ' || v_resp.reason_phrase);

  UTL_HTTP.END_RESPONSE(v_resp);
EXCEPTION
  WHEN OTHERS THEN
    DBMS_OUTPUT.PUT_LINE('FAILED: ' || SQLERRM);
    IF v_resp.status_code IS NOT NULL THEN
      UTL_HTTP.END_RESPONSE(v_resp);
    END IF;
END;
/
\`\`\`

**Success**: Any HTTP status code is returned (200, 301, 400, 403, 405). The SSL/TLS handshake completed.
**Failure**: ORA-29024 still appears — return to Phase 2 and check for additional intermediate CAs in the chain that were not imported.

### 6.2 Test via the EBS Payment Package

If the PL/SQL block succeeds, trigger a small test transaction via the EBS payment module (a small-value authorisation request, not a settlement) to confirm the fix propagates to the full EBS call stack:

\`\`\`
System Administrator → Requests → Run
  Program: [Payment Gateway Connectivity Test] (or equivalent diagnostic program)
  Submit → Wait for Completed Normal
\`\`\`

---

## Phase 7: Monitoring Scripts

### 7.1 Oracle Wallet Certificate Expiry Monitor

Create \`/home/oracle/scripts/check_wallet_expiry.sh\`:

\`\`\`bash
#!/bin/bash
# Oracle Wallet Certificate Expiry Monitor
# Alerts when any trusted certificate in the Oracle Wallet is near expiry

ORACLE_HOME=/u01/oracle/product/19.3.0/dbhome_1
WALLET_PATH=\${ORACLE_HOME}/wallet
WALLET_PWD="<wallet_password>"
WARN_DAYS=60
CRIT_DAYS=30
LOG_FILE="/home/oracle/logs/wallet_expiry_\$(date +%Y%m%d).log"
ALERT_EMAIL="dba-alerts@example.com"

mkdir -p /home/oracle/logs

export ORACLE_HOME
export PATH=\${ORACLE_HOME}/bin:\${PATH}

TODAY_EPOCH=\$(date +%s)
WARN_EPOCH=\$(( TODAY_EPOCH + WARN_DAYS * 86400 ))
CRIT_EPOCH=\$(( TODAY_EPOCH + CRIT_DAYS * 86400 ))

OVERALL_STATUS="OK"
ALERT_MSGS=""
CERT_COUNT=0

echo "=== Oracle Wallet Cert Expiry Check: \$(date) ===" > "\${LOG_FILE}"
echo "Wallet: \${WALLET_PATH}" >> "\${LOG_FILE}"
echo "" >> "\${LOG_FILE}"

# Extract all certificates from the wallet to temp files
TMPDIR=/tmp/wallet_check_\$\$
mkdir -p "\${TMPDIR}"
trap "rm -rf \${TMPDIR}" EXIT

openssl pkcs12 -in "\${WALLET_PATH}/ewallet.p12" \\
  -nokeys -passin pass:"\${WALLET_PWD}" 2>/dev/null \\
  | awk '/BEGIN CERTIFICATE/{n++; f="'"\${TMPDIR}"'/cert_"n".pem"} f{print > f} /END CERTIFICATE/{f=""}'

for CERT_FILE in "\${TMPDIR}"/cert_*.pem; do
  [ -f "\${CERT_FILE}" ] || continue
  CERT_COUNT=\$(( CERT_COUNT + 1 ))

  SUBJECT=\$(openssl x509 -in "\${CERT_FILE}" -noout -subject 2>/dev/null | sed 's/subject=//')
  NOT_AFTER=\$(openssl x509 -in "\${CERT_FILE}" -noout -enddate 2>/dev/null | sed 's/notAfter=//')
  EXPIRY_EPOCH=\$(date -d "\${NOT_AFTER}" +%s 2>/dev/null)
  DAYS_LEFT=\$(( (EXPIRY_EPOCH - TODAY_EPOCH) / 86400 ))

  if [ "\${DAYS_LEFT}" -lt 0 ] 2>/dev/null; then
    STATUS="EXPIRED"
    OVERALL_STATUS="CRITICAL"
    MSG="EXPIRED: \${SUBJECT} | Expired: \${NOT_AFTER}"
    ALERT_MSGS+="  \${MSG}\n"
    echo "\${MSG}" | tee -a "\${LOG_FILE}"
  elif [ "\${EXPIRY_EPOCH}" -le "\${CRIT_EPOCH}" ] 2>/dev/null; then
    STATUS="CRITICAL"
    OVERALL_STATUS="CRITICAL"
    MSG="CRITICAL (\${DAYS_LEFT} days): \${SUBJECT} | Expires: \${NOT_AFTER}"
    ALERT_MSGS+="  \${MSG}\n"
    echo "\${MSG}" | tee -a "\${LOG_FILE}"
  elif [ "\${EXPIRY_EPOCH}" -le "\${WARN_EPOCH}" ] 2>/dev/null; then
    STATUS="WARNING"
    [ "\${OVERALL_STATUS}" = "OK" ] && OVERALL_STATUS="WARNING"
    MSG="WARNING (\${DAYS_LEFT} days): \${SUBJECT} | Expires: \${NOT_AFTER}"
    ALERT_MSGS+="  \${MSG}\n"
    echo "\${MSG}" | tee -a "\${LOG_FILE}"
  else
    echo "OK (\${DAYS_LEFT} days): \${SUBJECT}" >> "\${LOG_FILE}"
  fi
done

echo "" >> "\${LOG_FILE}"
echo "Total certificates checked: \${CERT_COUNT}" >> "\${LOG_FILE}"
echo "Overall status: \${OVERALL_STATUS}" >> "\${LOG_FILE}"

if [ "\${OVERALL_STATUS}" != "OK" ]; then
  SUBJECT_LINE="Oracle Wallet Cert Alert [\${OVERALL_STATUS}] on \$(hostname)"
  BODY="Oracle Wallet Certificate Alert\nHost: \$(hostname)\nWallet: \${WALLET_PATH}\nTime: \$(date)\n\nIssues:\n\${ALERT_MSGS}\nAction: Review and import replacement certificates using orapki.\nRunbook: https://appsdba.example.com/posts/ora-29024-oracle-ebs-ssl-wallet-runbook"
  echo -e "\${BODY}" | mail -s "\${SUBJECT_LINE}" "\${ALERT_EMAIL}"
  exit 2
fi

echo "All \${CERT_COUNT} wallet certificates OK." >> "\${LOG_FILE}"
\`\`\`

### 7.2 Remote Gateway Certificate Expiry Monitor

Create \`/home/oracle/scripts/check_gateway_cert_expiry.sh\`:

\`\`\`bash
#!/bin/bash
# Check the SSL certificate expiry date of the payment gateway endpoint
# This catches gateway certificate rollovers BEFORE they cause ORA-29024

WARN_DAYS=30
CRIT_DAYS=14
LOG_FILE="/home/oracle/logs/gateway_cert_\$(date +%Y%m%d).log"
ALERT_EMAIL="dba-alerts@example.com"

# Define gateway endpoints to monitor (name:host:port)
GATEWAYS=(
  "Payment-Gateway-Primary:payment-gateway.example.com:443"
  "Payment-Gateway-DR:payment-gateway-dr.example.com:443"
)

TODAY_EPOCH=\$(date +%s)
WARN_EPOCH=\$(( TODAY_EPOCH + WARN_DAYS * 86400 ))
CRIT_EPOCH=\$(( TODAY_EPOCH + CRIT_DAYS * 86400 ))

echo "=== Gateway Cert Expiry Check: \$(date) ===" > "\${LOG_FILE}"
OVERALL_STATUS="OK"
ALERT_MSGS=""

for GATEWAY_ENTRY in "\${GATEWAYS[@]}"; do
  GW_NAME=\$(echo "\${GATEWAY_ENTRY}" | cut -d: -f1)
  GW_HOST=\$(echo "\${GATEWAY_ENTRY}" | cut -d: -f2)
  GW_PORT=\$(echo "\${GATEWAY_ENTRY}" | cut -d: -f3)

  # Fetch the server certificate (not the chain, just the leaf)
  NOT_AFTER=\$(echo | timeout 10 openssl s_client -connect "\${GW_HOST}:\${GW_PORT}" \\
    -servername "\${GW_HOST}" 2>/dev/null \\
    | openssl x509 -noout -enddate 2>/dev/null \\
    | sed 's/notAfter=//')

  if [ -z "\${NOT_AFTER}" ]; then
    MSG="\${GW_NAME}: UNKNOWN — could not reach \${GW_HOST}:\${GW_PORT} or parse cert"
    echo "\${MSG}" | tee -a "\${LOG_FILE}"
    OVERALL_STATUS="WARNING"
    ALERT_MSGS+="\${MSG}\n"
    continue
  fi

  EXPIRY_EPOCH=\$(date -d "\${NOT_AFTER}" +%s 2>/dev/null)
  DAYS_LEFT=\$(( (EXPIRY_EPOCH - TODAY_EPOCH) / 86400 ))

  if [ "\${EXPIRY_EPOCH}" -le "\${CRIT_EPOCH}" ] 2>/dev/null; then
    OVERALL_STATUS="CRITICAL"
    MSG="\${GW_NAME}: CRITICAL — server cert expires in \${DAYS_LEFT} days (\${NOT_AFTER})"
    ALERT_MSGS+="\${MSG}\n"
    echo "\${MSG}" | tee -a "\${LOG_FILE}"
  elif [ "\${EXPIRY_EPOCH}" -le "\${WARN_EPOCH}" ] 2>/dev/null; then
    [ "\${OVERALL_STATUS}" = "OK" ] && OVERALL_STATUS="WARNING"
    MSG="\${GW_NAME}: WARNING — server cert expires in \${DAYS_LEFT} days (\${NOT_AFTER})"
    ALERT_MSGS+="\${MSG}\n"
    echo "\${MSG}" | tee -a "\${LOG_FILE}"
  else
    echo "\${GW_NAME}: OK — server cert valid \${DAYS_LEFT} more days (\${NOT_AFTER})" >> "\${LOG_FILE}"
  fi
done

if [ "\${OVERALL_STATUS}" != "OK" ]; then
  echo -e "Gateway Certificate Alert [\${OVERALL_STATUS}]\n\${ALERT_MSGS}\nContact gateway provider if their cert is expiring." \\
    | mail -s "Gateway Cert Alert [\${OVERALL_STATUS}]: \$(hostname)" "\${ALERT_EMAIL}"
  exit 2
fi

echo "All gateway certificates OK." >> "\${LOG_FILE}"
\`\`\`

### 7.3 Crontab Setup

\`\`\`
# crontab -e (as oracle user on the EBS database server)

# Wallet certificate expiry — check daily at 06:00
0 6 * * * /home/oracle/scripts/check_wallet_expiry.sh >> /home/oracle/logs/wallet_cron.log 2>&1

# Gateway certificate expiry — check daily at 06:15
15 6 * * * /home/oracle/scripts/check_gateway_cert_expiry.sh >> /home/oracle/logs/gateway_cron.log 2>&1

# Weekly full report — Sunday at 07:00
0 7 * * 0 /home/oracle/scripts/check_wallet_expiry.sh && /home/oracle/scripts/check_gateway_cert_expiry.sh
\`\`\`

Make scripts executable:
\`\`\`bash
chmod 750 /home/oracle/scripts/check_wallet_expiry.sh
chmod 750 /home/oracle/scripts/check_gateway_cert_expiry.sh
\`\`\`

---

## Phase 8: Rollback Procedure

If the wallet update causes unexpected issues:

\`\`\`bash
# Stop all EBS services on the app tier first (if in a maintenance window)
# Then restore the original wallet from backup

BACKUP_DIR=/backup/oracle_wallet/<date>_<time>
WALLET_PATH=/u01/oracle/product/19.3.0/dbhome_1/wallet

cp \${BACKUP_DIR}/ewallet.p12 \${WALLET_PATH}/ewallet.p12
[ -f \${BACKUP_DIR}/cwallet.sso ] && cp \${BACKUP_DIR}/cwallet.sso \${WALLET_PATH}/cwallet.sso

# Verify rollback
orapki wallet display -wallet \${WALLET_PATH}

# No database restart required — next UTL_HTTP call reads the restored wallet
\`\`\`

---

## Quick Reference

| Task | Command |
|------|---------|
| Display wallet contents | \`orapki wallet display -wallet <path>\` |
| Display wallet with expiry dates | \`orapki wallet display -wallet <path> -complete -pwd <pwd>\` |
| Add trusted cert to wallet | \`orapki wallet add -wallet <path> -trusted_cert -cert <file.pem> -pwd <pwd>\` |
| Remove cert from wallet | \`orapki wallet remove -wallet <path> -trusted_cert_all -dn "<DN>" -pwd <pwd>\` |
| Fetch gateway cert chain | \`openssl s_client -connect <host>:<port> -showcerts\` |
| Check cert expiry from endpoint | \`echo \| openssl s_client -connect <host>:<port> 2>/dev/null \| openssl x509 -noout -dates\` |
| Read cert file details | \`openssl x509 -in <file.pem> -noout -subject -issuer -dates\` |
| Test wallet in PL/SQL | \`UTL_HTTP.SET_WALLET('file:<path>', '<pwd>'); UTL_HTTP.BEGIN_REQUEST(...)\` |
| Locate wallet in sqlnet.ora | \`grep -i wallet \$ORACLE_HOME/network/admin/sqlnet.ora\` |
| Find SET_WALLET in packages | \`SELECT OWNER,NAME,TEXT FROM DBA_SOURCE WHERE UPPER(TEXT) LIKE '%SET_WALLET%'\` |

| Error Code | Meaning | Action |
|------------|---------|--------|
| ORA-29273 | HTTP request failed at SSL layer | Check wallet — start Phase 1 |
| ORA-29024 | Certificate validation failure | CA cert missing or expired in wallet |
| ORA-29024 -70 | SSL_ERROR_BAD_SERVER_CERTIFICATE | Import missing CA cert from gateway chain |
| ORA-24247 | Network access denied by ACL | Grant UTL_HTTP ACL for the gateway host |
| ORA-29261 | Bad argument to UTL_HTTP | Check wallet path syntax — must use \`file:<path>\` |`,
};

async function main() {
  console.log('Inserting ORA-29024 EBS wallet runbook...');
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
