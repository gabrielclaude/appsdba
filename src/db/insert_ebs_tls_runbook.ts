import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Installing TLS 1.2 Certificates on Oracle E-Business Suite 12.2.9',
  slug: 'oracle-ebs-12-2-tls-certificate-installation-runbook',
  excerpt:
    'Step-by-step runbook for installing TLS 1.2 certificates across all three tiers of Oracle EBS 12.2.9: OHS Oracle Wallet replacement with orapki, ssl.conf TLS 1.2 enforcement with AutoConfig template persistence, WebLogic JKS keystore update with keytool, database TCPS listener configuration, and a certificate expiry monitoring script with crontab scheduling.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-05'),
  youtubeUrl: null,
  content: `## Overview

This runbook installs TLS 1.2 certificates across Oracle EBS 12.2.9: Oracle HTTP Server (OHS) Oracle Wallet, WebLogic Server (WLS) JKS keystore, and the Oracle Database TCPS listener. Execute phases in order. Estimated time: 3–4 hours for a single-node EBS instance; 5–6 hours for multi-node.

**Prerequisites**
- EBS 12.2.9 running and accessible
- CA-signed certificate files: \`server.crt\`, \`intermediate.crt\`, \`root-ca.crt\`, \`server.key\` (or PKCS12 \`server.p12\`)
- \`orapki\` available (ships with Oracle Fusion Middleware / EBS)
- \`keytool\` available (\`\${JAVA_HOME}/bin/keytool\`)
- Maintenance window scheduled — OHS and WLS restarts required
- sudo / oracle OS user access

---

## Phase 1: Backup Existing Configuration

\`\`\`bash
# Set environment
source /u01/install/APPS/EBSapps.env run

# Record current certificate details before changes
echo "=== Current OHS Certificate ===" > /tmp/tls_pre_backup.txt
orapki wallet display -wallet \${INST_TOP}/certs/ohs -complete 2>&1 >> /tmp/tls_pre_backup.txt

# Backup OHS wallet
BACKUP_DATE=\$(date +%Y%m%d_%H%M%S)
cp -rp \${INST_TOP}/certs/ohs /tmp/ohs_wallet_backup_\${BACKUP_DATE}
echo "OHS wallet backed up to /tmp/ohs_wallet_backup_\${BACKUP_DATE}"

# Backup ssl.conf
cp \${INST_TOP}/ora/10.1.3/Apache/Apache/conf/ssl.conf \\
   /tmp/ssl.conf_backup_\${BACKUP_DATE}

# Backup WLS keystore (adjust path to your domain)
WLS_DOMAIN=\${INST_TOP}/ora/10.1.3/j2ee/forms
cp \${WLS_DOMAIN}/config/fmwconfig/keystores/appKeystore.jks \\
   /tmp/appKeystore_backup_\${BACKUP_DATE}.jks 2>/dev/null || \\
  echo "WLS keystore path differs — locate manually"

# Backup listener.ora and sqlnet.ora
cp \${ORACLE_HOME}/network/admin/listener.ora \\
   /tmp/listener.ora_backup_\${BACKUP_DATE}
cp \${ORACLE_HOME}/network/admin/sqlnet.ora \\
   /tmp/sqlnet.ora_backup_\${BACKUP_DATE}

echo "All backups completed"
\`\`\`

---

## Phase 2: Prepare Certificate Files

\`\`\`bash
# Working directory for cert files
CERT_DIR=/tmp/tls_certs_\$(date +%Y%m%d)
mkdir -p \${CERT_DIR}
cd \${CERT_DIR}

# If you received a PKCS12 bundle from your CA, extract components:
# openssl pkcs12 -in server.p12 -nokeys -clcerts -out server.crt
# openssl pkcs12 -in server.p12 -nokeys -cacerts -out chain.crt
# openssl pkcs12 -in server.p12 -nocerts -nodes -out server.key

# Verify certificate details
echo "=== Server Certificate ==="
openssl x509 -in server.crt -noout -subject -issuer -dates -fingerprint

echo "=== Intermediate CA ==="
openssl x509 -in intermediate.crt -noout -subject -issuer -dates

echo "=== Root CA ==="
openssl x509 -in root-ca.crt -noout -subject -dates

# Verify chain integrity — issuer of server.crt should match subject of intermediate.crt
openssl verify -CAfile <(cat root-ca.crt intermediate.crt) server.crt
# Expected: server.crt: OK

# Verify private key matches certificate
CERT_MOD=\$(openssl x509 -noout -modulus -in server.crt | md5)
KEY_MOD=\$(openssl rsa -noout -modulus -in server.key | md5)
if [ "\${CERT_MOD}" = "\${KEY_MOD}" ]; then
  echo "Certificate and private key MATCH"
else
  echo "ERROR: Certificate and private key DO NOT MATCH — stop and reissue CSR"
  exit 1
fi

# Verify SAN includes the EBS hostname
openssl x509 -in server.crt -noout -text | grep -A1 "Subject Alternative Name"
\`\`\`

---

## Phase 3: Create New OHS Oracle Wallet

\`\`\`bash
cd \${CERT_DIR}

# Create new auto-login wallet
NEW_WALLET=/tmp/ohs_new_wallet
mkdir -p \${NEW_WALLET}

orapki wallet create -wallet \${NEW_WALLET} -auto_login -pwd WalletPasswd123
# -auto_login creates both ewallet.p12 and cwallet.sso (auto-login file)

# Add Root CA certificate first
orapki wallet add -wallet \${NEW_WALLET} -trusted_cert \\
  -cert root-ca.crt -pwd WalletPasswd123
echo "Root CA added"

# Add Intermediate CA certificate
orapki wallet add -wallet \${NEW_WALLET} -trusted_cert \\
  -cert intermediate.crt -pwd WalletPasswd123
echo "Intermediate CA added"

# Add server certificate (user cert) — must be last, after full chain is present
orapki wallet add -wallet \${NEW_WALLET} -user_cert \\
  -cert server.crt -pwd WalletPasswd123
echo "Server certificate added"

# Verify wallet contents
echo "=== New Wallet Contents ==="
orapki wallet display -wallet \${NEW_WALLET} -complete

# Should show:
# Requested Certificates: (empty)
# User Certificates: CN=your-ebs-hostname,...
# Trusted Certificates: Root CA, Intermediate CA (+ Oracle defaults)
\`\`\`

---

## Phase 4: Deploy New OHS Wallet and Update ssl.conf

\`\`\`bash
# Stop OHS before replacing wallet
\${ADMIN_SCRIPTS_HOME}/adapcctl.sh stop
sleep 10

# Replace wallet — copy new files over existing
cp \${NEW_WALLET}/ewallet.p12 \${INST_TOP}/certs/ohs/ewallet.p12
cp \${NEW_WALLET}/cwallet.sso \${INST_TOP}/certs/ohs/cwallet.sso

# Set correct permissions
chown oracle:oinstall \${INST_TOP}/certs/ohs/ewallet.p12
chown oracle:oinstall \${INST_TOP}/certs/ohs/cwallet.sso
chmod 600 \${INST_TOP}/certs/ohs/ewallet.p12
chmod 600 \${INST_TOP}/certs/ohs/cwallet.sso

echo "Wallet deployed"

# Update ssl.conf for TLS 1.2
SSL_CONF=\${INST_TOP}/ora/10.1.3/Apache/Apache/conf/ssl.conf

# Enforce TLS 1.2 only — disable SSLv2, SSLv3, TLSv1.0, TLSv1.1
# First check current value
grep "SSLProtocol" \${SSL_CONF}

# Update SSLProtocol directive (handles both existing and missing lines)
if grep -q "^SSLProtocol" \${SSL_CONF}; then
  sed -i 's/^SSLProtocol.*/SSLProtocol -ALL +TLSv1.2/' \${SSL_CONF}
else
  # Add after SSLWallet line
  sed -i '/^SSLWallet/a SSLProtocol -ALL +TLSv1.2' \${SSL_CONF}
fi

# Set hardened cipher suites
CIPHER_LINE='SSLCipherSuite ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256'
if grep -q "^SSLCipherSuite" \${SSL_CONF}; then
  sed -i "s|^SSLCipherSuite.*|\${CIPHER_LINE}|" \${SSL_CONF}
else
  sed -i "/^SSLProtocol/a \${CIPHER_LINE}" \${SSL_CONF}
fi

# Add HSTS header inside VirtualHost block (if not already present)
if ! grep -q "Strict-Transport-Security" \${SSL_CONF}; then
  sed -i 's|</VirtualHost>|    Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"\n</VirtualHost>|' \${SSL_CONF}
fi

# Verify changes
echo "=== Updated ssl.conf TLS directives ==="
grep -E "SSLProtocol|SSLCipherSuite|SSLWallet|Strict-Transport" \${SSL_CONF}
\`\`\`

---

## Phase 5: Persist TLS Settings Through AutoConfig

\`\`\`bash
# Find the AutoConfig ssl.conf template
# Templates are named ssl.conf_<CONTEXT_NAME> or ssl.conf.tmp
CONTEXT_NAME=\$(grep "^s_contextname" \${CONTEXT_FILE} | awk -F= '{print \$2}' | tr -d ' ')
TMPL_BASE=\${APPL_TOP}/../inst/apps/\${CONTEXT_NAME}/ora/10.1.3/Apache/Apache/conf

# Check for template file
ls \${TMPL_BASE}/ssl.conf* 2>/dev/null || \\
  find \${AD_TOP}/admin/templates -name "ssl.conf*" 2>/dev/null | head -5

# Edit the template to include TLS 1.2 directives permanently
# This prevents AutoConfig from reverting your changes
# Locate the SSLProtocol line in the template and update it:
TMPL_FILE=\${TMPL_BASE}/ssl.conf   # adjust to actual template path

if [ -f "\${TMPL_FILE}" ]; then
  cp \${TMPL_FILE} \${TMPL_FILE}.bak_\$(date +%Y%m%d)

  if grep -q "SSLProtocol" \${TMPL_FILE}; then
    sed -i 's/^SSLProtocol.*/SSLProtocol -ALL +TLSv1.2/' \${TMPL_FILE}
  else
    sed -i '/^SSLWallet/a SSLProtocol -ALL +TLSv1.2' \${TMPL_FILE}
  fi

  CIPHER_LINE='SSLCipherSuite ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256'
  if grep -q "^SSLCipherSuite" \${TMPL_FILE}; then
    sed -i "s|^SSLCipherSuite.*|\${CIPHER_LINE}|" \${TMPL_FILE}
  else
    sed -i "/^SSLProtocol/a \${CIPHER_LINE}" \${TMPL_FILE}
  fi

  echo "AutoConfig template updated"
else
  echo "WARNING: Template file not found at \${TMPL_FILE}"
  echo "Manually identify your ssl.conf AutoConfig template path"
  echo "Without template update, changes will revert on next AutoConfig run"
fi

# Test that AutoConfig preserves the changes by running it now
# (do this in a test environment first)
# \${ADMIN_SCRIPTS_HOME}/adautocfg.sh
# grep "SSLProtocol" \${SSL_CONF}
\`\`\`

---

## Phase 6: Start OHS and Validate

\`\`\`bash
# Start OHS
\${ADMIN_SCRIPTS_HOME}/adapcctl.sh start
sleep 15

# Check OHS status
\${ADMIN_SCRIPTS_HOME}/adapcctl.sh status

# Check OHS error log for SSL errors
tail -50 \${INST_TOP}/logs/ora/10.1.3/Apache/error.log
tail -20 \${INST_TOP}/logs/ora/10.1.3/Apache/ssl_error.log

# Test TLS 1.2 connection from server
EBS_HOST=\$(grep "s_webhost" \${CONTEXT_FILE} | head -1 | awk -F= '{print \$2}' | tr -d ' ')
EBS_PORT=443   # adjust if using non-standard HTTPS port

# Test TLS 1.2 negotiation
openssl s_client -connect \${EBS_HOST}:\${EBS_PORT} -tls1_2 </dev/null 2>&1 | \\
  grep -E "Protocol|Cipher|subject|issuer|Verify"

# Verify TLS 1.0 and 1.1 are rejected
openssl s_client -connect \${EBS_HOST}:\${EBS_PORT} -tls1 </dev/null 2>&1 | \\
  grep -E "handshake|alert|error" || echo "TLS 1.0 rejected (expected)"
openssl s_client -connect \${EBS_HOST}:\${EBS_PORT} -tls1_1 </dev/null 2>&1 | \\
  grep -E "handshake|alert|error" || echo "TLS 1.1 rejected (expected)"

# Check certificate served matches what was installed
openssl s_client -connect \${EBS_HOST}:\${EBS_PORT} </dev/null 2>/dev/null | \\
  openssl x509 -noout -subject -issuer -dates

# Check HSTS header
curl -sI https://\${EBS_HOST}:\${EBS_PORT}/OA_HTML/AppsLogin | \\
  grep -i "strict-transport"

echo "OHS TLS 1.2 validation complete"
\`\`\`

---

## Phase 7: Update WebLogic JKS Keystore

\`\`\`bash
cd \${CERT_DIR}

# Convert PEM cert + key to PKCS12 for keytool import
openssl pkcs12 -export -in server.crt -inkey server.key \\
  -certfile intermediate.crt -out server_bundle.p12 \\
  -name "ebs-server" -passout pass:changeit

# Locate WLS keystore (typical EBS paths)
WLS_KEYSTORE=\${DOMAIN_HOME}/config/fmwconfig/keystores/appKeystore.jks
# If not found, check:
# find \${WLS_DOMAIN} -name "*.jks" 2>/dev/null

# Import server cert+key into JKS keystore
keytool -importkeystore \\
  -srckeystore server_bundle.p12 -srcstoretype PKCS12 \\
  -srcstorepass changeit -srcalias ebs-server \\
  -destkeystore \${WLS_KEYSTORE} -deststoretype JKS \\
  -deststorepass <keystore_password> -destalias ebs-server \\
  -noprompt

# Import CA chain into WLS truststore
WLS_TRUSTSTORE=\${DOMAIN_HOME}/config/fmwconfig/keystores/appTrustKeyStore.jks
# If separate truststore does not exist, use same keystore or DemoTrust.jks

keytool -import -alias root-ca \\
  -keystore \${WLS_TRUSTSTORE} -storepass <truststore_password> \\
  -file root-ca.crt -noprompt

keytool -import -alias intermediate-ca \\
  -keystore \${WLS_TRUSTSTORE} -storepass <truststore_password> \\
  -file intermediate.crt -noprompt

# Verify keystore contents
echo "=== WLS Keystore ==="
keytool -list -v -keystore \${WLS_KEYSTORE} -storepass <keystore_password> \\
  2>/dev/null | grep -E "Alias|Valid|Owner"

# Configure WLS minimum TLS version via WLST (offline)
cat > /tmp/set_tls.py <<'WLST_EOF'
import sys
domainHome = sys.argv[1]
readDomain(domainHome)
cd('/')
servers = cmo.getServers()
for server in servers:
    cd('/Servers/' + server.getName() + '/SSL/' + server.getName())
    set('MinimumTLSProtocolVersion', 'TLSv1.2')
    print('Set TLS 1.2 minimum on: ' + server.getName())
updateDomain()
closeDomain()
WLST_EOF

\${WL_HOME}/oracle_common/common/bin/wlst.sh /tmp/set_tls.py \${DOMAIN_HOME}

echo "WLS keystore and TLS configuration updated"
\`\`\`

---

## Phase 8: Configure Database TCPS Listener

\`\`\`bash
# Switch to oracle user / DB ORACLE_HOME environment
export ORACLE_HOME=/u01/app/oracle/product/19c/db_1
export ORACLE_SID=EBSDB   # adjust to your SID

WALLET_DIR=\${ORACLE_HOME}/network/admin/wallet
mkdir -p \${WALLET_DIR}

# Create DB server wallet
orapki wallet create -wallet \${WALLET_DIR} -auto_login -pwd DBWalletPass1

# Add Root CA
orapki wallet add -wallet \${WALLET_DIR} -trusted_cert \\
  -cert \${CERT_DIR}/root-ca.crt -pwd DBWalletPass1

# Add Intermediate CA
orapki wallet add -wallet \${WALLET_DIR} -trusted_cert \\
  -cert \${CERT_DIR}/intermediate.crt -pwd DBWalletPass1

# Add DB server cert (use same cert as OHS or generate a separate DB CSR)
# If using same cert:
orapki wallet add -wallet \${WALLET_DIR} -user_cert \\
  -cert \${CERT_DIR}/server.crt -pwd DBWalletPass1

# Verify DB wallet
orapki wallet display -wallet \${WALLET_DIR} -complete

# Update listener.ora — add TCPS endpoint
cat >> \${ORACLE_HOME}/network/admin/listener.ora <<'LSTN_EOF'

# TCPS endpoint for EBS TLS 1.2
LISTENER_TCPS =
  (DESCRIPTION_LIST =
    (DESCRIPTION =
      (ADDRESS = (PROTOCOL = TCPS)(HOST = \$(hostname -f))(PORT = 2484))
    )
  )

SSL_CLIENT_AUTHENTICATION = FALSE
WALLET_LOCATION =
  (SOURCE =
    (METHOD = FILE)
    (METHOD_DATA =
      (DIRECTORY = \${ORACLE_HOME}/network/admin/wallet)))
LSTN_EOF

# Update sqlnet.ora
cat >> \${ORACLE_HOME}/network/admin/sqlnet.ora <<'NET_EOF'

# TLS 1.2 enforcement for TCPS
SSL_VERSION = 1.2
SSL_CIPHER_SUITES = (SSL_RSA_WITH_AES_256_CBC_SHA256, SSL_RSA_WITH_AES_128_CBC_SHA256)
WALLET_LOCATION =
  (SOURCE =
    (METHOD = FILE)
    (METHOD_DATA =
      (DIRECTORY = \${ORACLE_HOME}/network/admin/wallet)))
NET_EOF

# Reload listener
lsnrctl reload
sleep 5
lsnrctl status | grep -E "TCPS|2484|Listening"

# Test TCPS connection
sqlplus -L /nolog <<'SQL_EOF'
CONNECT apps/<apps_password>@"(DESCRIPTION=(ADDRESS=(PROTOCOL=TCPS)(HOST=\$(hostname -f))(PORT=2484))(CONNECT_DATA=(SERVICE_NAME=EBSDB)))"
SELECT 'TCPS connection successful' FROM dual;
EXIT
SQL_EOF

echo "Database TCPS configuration complete"
\`\`\`

---

## Phase 9: Restart WLS and Full Stack Validation

\`\`\`bash
# Restart WebLogic managed servers
\${ADMIN_SCRIPTS_HOME}/adadminsrvctl.sh stop
\${ADMIN_SCRIPTS_HOME}/admanagedsrvctl.sh stop all
sleep 30
\${ADMIN_SCRIPTS_HOME}/adadminsrvctl.sh start
sleep 60
\${ADMIN_SCRIPTS_HOME}/admanagedsrvctl.sh start all
sleep 60

# Check WLS server status
\${ADMIN_SCRIPTS_HOME}/admanagedsrvctl.sh status all

# Check WLS logs for SSL errors
find \${DOMAIN_HOME}/servers -name "*.log" -newer /tmp/tls_pre_backup.txt \\
  -exec grep -l "SSL\|certificate\|handshake\|TLS" {} \; 2>/dev/null | head -5

# Validate EBS login page loads over HTTPS
EBS_URL="https://\${EBS_HOST}:\${EBS_PORT}/OA_HTML/AppsLogin"
HTTP_CODE=\$(curl -sk -o /dev/null -w "%{http_code}" \${EBS_URL})
echo "EBS Login page HTTP status: \${HTTP_CODE}"
# Expected: 200

# Full TLS scan with cipher details (requires openssl 1.1.1+)
openssl s_client -connect \${EBS_HOST}:\${EBS_PORT} -tls1_2 </dev/null 2>&1 | \\
  grep -E "Protocol|Cipher|subject|Verify return"

echo "Full stack validation complete"
\`\`\`

---

## Phase 10: Certificate Expiry Monitoring Script

\`\`\`bash
cat > /u01/scripts/ebs_cert_expiry_check.sh <<'SCRIPT_EOF'
#!/bin/bash
# EBS Certificate Expiry Monitor
# Checks OHS wallet, WLS keystore, and live HTTPS certificate
# Nagios-compatible exit codes: 0=OK, 1=WARNING, 2=CRITICAL

set -euo pipefail

WARN_DAYS=30
CRIT_DAYS=7
EMAIL="dba-alerts@example.com"
HOSTNAME=\$(hostname -f)
LOG="/var/log/ebs_cert_check.log"

# Source EBS environment
source /u01/install/APPS/EBSapps.env run 2>/dev/null || true

STATUS=0
MESSAGES=""

check_days_remaining() {
  local end_date="\$1"
  local label="\$2"
  # Convert date to epoch (handles "Month DD HH:MM:SS YYYY GMT" format)
  local end_epoch=\$(date -d "\${end_date}" +%s 2>/dev/null || \
                    date -jf "%b %d %H:%M:%S %Y %Z" "\${end_date}" +%s 2>/dev/null)
  local now_epoch=\$(date +%s)
  local days_left=\$(( (end_epoch - now_epoch) / 86400 ))

  if [ "\${days_left}" -le "\${CRIT_DAYS}" ]; then
    MESSAGES+="\${label}: CRITICAL - expires in \${days_left} days (\${end_date})\n"
    STATUS=2
  elif [ "\${days_left}" -le "\${WARN_DAYS}" ]; then
    MESSAGES+="\${label}: WARNING - expires in \${days_left} days (\${end_date})\n"
    [ \${STATUS} -lt 1 ] && STATUS=1
  else
    MESSAGES+="\${label}: OK - \${days_left} days remaining\n"
  fi
}

# Check OHS Oracle Wallet certificate
if command -v orapki &>/dev/null && [ -d "\${INST_TOP}/certs/ohs" ]; then
  OHS_EXPIRY=\$(orapki wallet display -wallet \${INST_TOP}/certs/ohs -complete 2>/dev/null | \
    grep -A2 "User Certificates" | grep "Valid" | awk -F': ' '{print \$2}' | head -1)
  if [ -n "\${OHS_EXPIRY}" ]; then
    check_days_remaining "\${OHS_EXPIRY}" "OHS Oracle Wallet"
  else
    MESSAGES+="OHS Oracle Wallet: UNKNOWN - could not parse expiry\n"
    [ \${STATUS} -lt 1 ] && STATUS=1
  fi
fi

# Check live HTTPS certificate
EBS_HOST=\$(grep "s_webhost" \${CONTEXT_FILE} 2>/dev/null | head -1 | awk -F= '{print \$2}' | tr -d ' ')
EBS_PORT=443
if [ -n "\${EBS_HOST}" ]; then
  LIVE_EXPIRY=\$(openssl s_client -connect \${EBS_HOST}:\${EBS_PORT} </dev/null 2>/dev/null | \
    openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  if [ -n "\${LIVE_EXPIRY}" ]; then
    check_days_remaining "\${LIVE_EXPIRY}" "Live HTTPS cert (\${EBS_HOST})"
  fi
fi

# Check WLS keystore
WLS_KEYSTORE=\${DOMAIN_HOME}/config/fmwconfig/keystores/appKeystore.jks
WLS_PASS="<keystore_password>"
if [ -f "\${WLS_KEYSTORE}" ]; then
  WLS_EXPIRY=\$(keytool -list -v -keystore \${WLS_KEYSTORE} -storepass \${WLS_PASS} 2>/dev/null | \
    grep "Valid until" | head -1 | sed 's/.*Valid until: //')
  if [ -n "\${WLS_EXPIRY}" ]; then
    check_days_remaining "\${WLS_EXPIRY}" "WLS JKS Keystore"
  fi
fi

# Emit result
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
echo "[\${TIMESTAMP}] STATUS=\${STATUS}" >> \${LOG}
echo -e "\${MESSAGES}" >> \${LOG}

if [ \${STATUS} -ne 0 ]; then
  echo -e "EBS Certificate Alert on \${HOSTNAME}\n\n\${MESSAGES}" | \
    mailx -s "EBS TLS Certificate Alert [\${STATUS}] - \${HOSTNAME}" \${EMAIL}
fi

echo -e "\${MESSAGES}"
exit \${STATUS}
SCRIPT_EOF

chmod +x /u01/scripts/ebs_cert_expiry_check.sh

# Test the script
/u01/scripts/ebs_cert_expiry_check.sh
echo "Exit code: \$?"

# Schedule in crontab (run daily at 7:00 AM)
(crontab -l 2>/dev/null; echo "0 7 * * * /u01/scripts/ebs_cert_expiry_check.sh >> /var/log/ebs_cert_check.log 2>&1") | crontab -
crontab -l | grep ebs_cert

echo "Certificate expiry monitoring configured"
\`\`\`

---

## Rollback Procedure

If any phase fails and OHS cannot start:

\`\`\`bash
BACKUP_DATE=<timestamp_from_phase_1>

# Restore OHS wallet
cp -rp /tmp/ohs_wallet_backup_\${BACKUP_DATE}/* \${INST_TOP}/certs/ohs/

# Restore ssl.conf
cp /tmp/ssl.conf_backup_\${BACKUP_DATE} \\
   \${INST_TOP}/ora/10.1.3/Apache/Apache/conf/ssl.conf

# Restore WLS keystore
cp /tmp/appKeystore_backup_\${BACKUP_DATE}.jks \\
   \${DOMAIN_HOME}/config/fmwconfig/keystores/appKeystore.jks

# Restore listener.ora and sqlnet.ora
cp /tmp/listener.ora_backup_\${BACKUP_DATE} \${ORACLE_HOME}/network/admin/listener.ora
cp /tmp/sqlnet.ora_backup_\${BACKUP_DATE} \${ORACLE_HOME}/network/admin/sqlnet.ora

# Restart OHS
\${ADMIN_SCRIPTS_HOME}/adapcctl.sh start

echo "Rollback complete — verify OHS status"
\${ADMIN_SCRIPTS_HOME}/adapcctl.sh status
\`\`\`

---

## Validation Checklist

After completing all phases:

- [ ] OHS starts without SSL errors in error.log
- [ ] \`openssl s_client -tls1_2\` to EBS hostname returns cipher and valid certificate
- [ ] \`openssl s_client -tls1\` is rejected (connection fails)
- [ ] Browser shows padlock with TLS 1.2 on EBS login page
- [ ] HSTS header present in HTTP response
- [ ] Certificate chain is complete (no "incomplete chain" warnings)
- [ ] Certificate subject/SAN matches EBS hostname
- [ ] WLS managed servers running (admanagedsrvctl.sh status all)
- [ ] EBS functional test: login, run a responsibility, open a form
- [ ] TCPS listener responding on port 2484 (lsnrctl status)
- [ ] sqlplus test connection via TCPS succeeds
- [ ] AutoConfig template updated (run adautocfg.sh and re-verify ssl.conf)
- [ ] Monitoring crontab active (crontab -l | grep ebs_cert)`,
};

async function main() {
  console.log('Inserting EBS 12.2 TLS certificate installation runbook...');
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
