import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Installing CA-Signed TLS 1.2 Certificates on Oracle Enterprise Manager 13c',
  slug: 'oracle-oem-13c-tls-certificate-installation-runbook',
  excerpt:
    'A phased production runbook for replacing Oracle Enterprise Manager 13c self-signed certificates with enterprise CA-signed TLS 1.2 certificates across all three communication layers: OMS WebLogic console (JKS), OMS upload service (Oracle Wallet), and Management Agent wallets. Includes CSR generation with correct SANs, wallet and keystore update procedures, agent re-securing, TLS 1.2 enforcement, cipher suite hardening, and an automated certificate expiry monitoring script.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-05'),
  youtubeUrl: null,
  content: `## Introduction

This runbook covers the complete replacement of Oracle Enterprise Manager 13c self-signed certificates with enterprise CA-signed TLS 1.2 certificates across all three OEM communication layers.

**Assumptions:** OEM 13.5, RHEL/Oracle Linux 8, \`oracle\` OS user, OMS running and fully operational before starting, enterprise CA available to sign CSRs (process may take 1–3 business days — factor into maintenance window planning), \`openssl\` and \`orapki\` available on the OMS host, full backup taken before any certificate operations. All commands run as the \`oracle\` OS user unless explicitly noted as root.

**Three-layer scope reminder:**
- Layer 1: OMS WebLogic console HTTPS listener on port 7803 — uses Java KeyStore (JKS), managed with \`keytool\`
- Layer 2: OMS upload service on port 4900 — uses Oracle Wallet (\`ewallet.p12\` / \`cwallet.sso\`), managed with \`orapki\` or \`emctl secure oms\`
- Layer 3: Each Management Agent wallet — updated via \`emctl secure agent\` after Layer 2 is replaced

Complete all phases in order. Do not skip the backup step. Do not attempt to update layers out of sequence.

---

## Phase 0: Pre-Work — Backup and Certificate Inventory

### Step 0.1: Backup Existing Wallets and Keystores

\`\`\`bash
export OMS_HOME=/u01/app/oracle/product/13.5/oms
export AGENT_HOME=/u01/app/oracle/product/13.5/agent/agent_13.5.0.0.0
BACKUP_DIR=/u01/backup/oem_certs_\$(date +%Y%m%d)
mkdir -p \${BACKUP_DIR}

# Backup OMS wallet
cp -rp \${OMS_HOME}/sysman/config/b64LocalCertificate.txt \${BACKUP_DIR}/
cp -rp \${OMS_HOME}/sysman/config/emkey.ora \${BACKUP_DIR}/
cp -rp \${OMS_HOME}/sysman/config/ewallet.p12 \${BACKUP_DIR}/
cp -rp \${OMS_HOME}/sysman/config/cwallet.sso \${BACKUP_DIR}/

# Backup WebLogic keystore files
find \${OMS_HOME} -name "*.jks" -o -name "*.keystore" 2>/dev/null | \
  xargs -I{} cp -p {} \${BACKUP_DIR}/

echo "Backup complete: \${BACKUP_DIR}"
ls -lh \${BACKUP_DIR}/
\`\`\`

Do not proceed without confirming all wallet and keystore files are in the backup directory. This backup is your only recovery path if a wallet operation corrupts the active wallet.

### Step 0.2: Check Current Certificate Expiry Dates

\`\`\`bash
# Check OMS Oracle Wallet certificate expiry
\${OMS_HOME}/bin/orapki wallet display -wallet \${OMS_HOME}/sysman/config/ \
  -pwd \$(cat \${OMS_HOME}/sysman/config/emkey.ora 2>/dev/null || echo "changeit")

# Check WebLogic keystore certificate
\${OMS_HOME}/oracle_common/jdk/bin/keytool -list -v \
  -keystore \${OMS_HOME}/wlserver/server/lib/DemoTrust.jks \
  -storepass DemoTrustKeyStorePassPhrase 2>/dev/null | grep -E "Alias|Valid|until"

# Check agent certificate status
\${AGENT_HOME}/bin/emctl status agent | grep -i cert
\`\`\`

Document the current certificate expiry dates and issuer before making changes. This establishes a baseline and confirms which certificates are currently self-signed.

### Step 0.3: Verify Current TLS Version and Cipher on OMS Console Port

\`\`\`bash
# Test what TLS versions are currently accepted
openssl s_client -connect oms-host.yourdomain.com:7803 -tls1_2 \
  -servername oms-host.yourdomain.com < /dev/null 2>&1 | grep -E "Protocol|Cipher|subject|issuer"

# Check if TLS 1.0 is still enabled (should be disabled after Phase 5)
openssl s_client -connect oms-host.yourdomain.com:7803 -tls1 \
  < /dev/null 2>&1 | grep -E "handshake|alert|Protocol"
\`\`\`

Record the current state. After Phase 5, TLS 1.0 and 1.1 connections should be rejected.

---

## Phase 1: Generate CSR for OMS Certificate

### Step 1.1: Generate Private Key and CSR with SANs

\`\`\`bash
mkdir -p /u01/certs/oem
cd /u01/certs/oem

# Generate 2048-bit RSA private key
openssl genrsa -out oms_server.key 2048

# Restrict private key permissions immediately
chmod 600 oms_server.key

# Generate CSR with SANs using openssl config extension
cat > /u01/certs/oem/oms_san.cnf << 'EOF'
[req]
default_bits       = 2048
prompt             = no
default_md         = sha256
distinguished_name = dn
req_extensions     = req_ext

[dn]
C  = US
ST = California
L  = Redwood City
O  = YourCompany Inc
OU = Database Operations
CN = oms-host.yourdomain.com

[req_ext]
subjectAltName = @alt_names

[alt_names]
DNS.1 = oms-host.yourdomain.com
DNS.2 = oms-host
DNS.3 = oem.yourdomain.com
DNS.4 = oem-console.yourdomain.com
EOF

openssl req -new -key oms_server.key \
  -out oms_server.csr \
  -config /u01/certs/oem/oms_san.cnf

# Verify the CSR contains correct SANs before submitting
openssl req -text -noout -in oms_server.csr | grep -A5 "Subject Alternative"
\`\`\`

Update the \`[dn]\` and \`[alt_names]\` sections with your actual organisation details and all hostnames used to access the OEM console. Omitting any access hostname from \`alt_names\` will cause browser certificate warnings for that hostname after the certificate is deployed.

### Step 1.2: Submit CSR to Enterprise CA and Receive Signed Certificate

\`\`\`bash
# Submit oms_server.csr to your enterprise CA (process varies by CA vendor)
# After CA signs it, you should receive:
#   oms_server.crt      — signed server certificate (PEM format)
#   intermediate_ca.crt — intermediate CA certificate
#   root_ca.crt         — root CA certificate
# Place all received files in /u01/certs/oem/

# Verify the signed certificate content
openssl x509 -text -noout -in oms_server.crt | grep -E "Subject:|DNS:|Not After"

# Verify the signed certificate matches the private key (modulus must match)
openssl x509 -modulus -noout -in oms_server.crt | openssl md5
openssl rsa  -modulus -noout -in oms_server.key | openssl md5
# Both MD5 values must be identical — if they differ, the CA returned the wrong certificate
\`\`\`

Do not proceed to Phase 2 until the private key modulus check passes. A certificate that does not match the key cannot be imported and will cause errors in all subsequent steps.

### Step 1.3: Create the Full Certificate Chain File

\`\`\`bash
cat oms_server.crt intermediate_ca.crt root_ca.crt > oms_chain.crt

# Verify the chain
openssl verify -CAfile root_ca.crt -untrusted intermediate_ca.crt oms_server.crt
# Expected output: oms_server.crt: OK

# Verify chain order (server cert should be first)
openssl crl2pkcs7 -nocrl -certfile oms_chain.crt | \
  openssl pkcs7 -print_certs -noout | grep "subject="
\`\`\`

---

## Phase 2: Update OMS Oracle Wallet (Layer 2 — Upload Port 4900)

### Step 2.1: Stop OMS Before Wallet Update

\`\`\`bash
\${OMS_HOME}/bin/emctl stop oms -all

# Wait for clean shutdown
sleep 30
\${OMS_HOME}/bin/emctl status oms
# Expected: Oracle Management Server is Down
\`\`\`

The OMS must be fully stopped before modifying the Oracle Wallet. Modifying a wallet that is in active use by a running OMS can corrupt the wallet and require a restore from backup.

### Step 2.2: Use emctl secure oms to Replace the OMS Wallet Certificate (Recommended Method)

\`\`\`bash
# emctl secure oms handles wallet update and triggers agent re-trust automatically
\${OMS_HOME}/bin/emctl secure oms \
  -host oms-host.yourdomain.com \
  -secure_port 4900 \
  -console_port 7803 \
  -ms_port 7301 \
  -pem_file /u01/certs/oem/oms_server.crt \
  -pem_key_file /u01/certs/oem/oms_server.key \
  -pem_rootca_file /u01/certs/oem/oms_chain.crt

# Enter OMS sysman password when prompted
\`\`\`

This is the recommended approach because \`emctl secure oms\` handles the Oracle Wallet update atomically and ensures the auto-login wallet (\`cwallet.sso\`) is regenerated consistently. Proceed to Step 2.4 to verify; use Step 2.3 only if \`emctl secure oms\` fails.

### Step 2.3: Alternative — Manual Oracle Wallet Update with orapki

Use this alternative only if \`emctl secure oms\` is unavailable or produces an error that cannot be resolved.

\`\`\`bash
WALLET_DIR=\${OMS_HOME}/sysman/config

# Create a new wallet with auto-login
\${OMS_HOME}/bin/orapki wallet create \
  -wallet \${WALLET_DIR} \
  -pwd <wallet_password> \
  -auto_login

# Import root CA as trusted certificate
\${OMS_HOME}/bin/orapki wallet add \
  -wallet \${WALLET_DIR} \
  -trusted_cert -cert /u01/certs/oem/root_ca.crt \
  -pwd <wallet_password>

# Import intermediate CA as trusted certificate
\${OMS_HOME}/bin/orapki wallet add \
  -wallet \${WALLET_DIR} \
  -trusted_cert -cert /u01/certs/oem/intermediate_ca.crt \
  -pwd <wallet_password>

# Convert server certificate and private key to PKCS12 format for wallet import
openssl pkcs12 -export \
  -in oms_server.crt \
  -inkey oms_server.key \
  -certfile oms_chain.crt \
  -out oms_server.p12 \
  -name "oms_server" \
  -passout pass:<p12_password>

# Import the PKCS12 bundle into the Oracle Wallet
\${OMS_HOME}/bin/orapki wallet import_pkcs12 \
  -wallet \${WALLET_DIR} \
  -pkcs12file /u01/certs/oem/oms_server.p12 \
  -pkcs12pwd <p12_password> \
  -pwd <wallet_password>

# Verify wallet contents after import
\${OMS_HOME}/bin/orapki wallet display \
  -wallet \${WALLET_DIR} \
  -pwd <wallet_password>
\`\`\`

After the manual wallet update, confirm that both \`ewallet.p12\` and \`cwallet.sso\` exist in \`\$OMS_HOME/sysman/config/\`. The auto-login wallet \`cwallet.sso\` is required for the OMS to start without a password prompt. If \`cwallet.sso\` is missing, re-run \`orapki wallet create -auto_login\` to regenerate it.

### Step 2.4: Verify Oracle Wallet Contents

\`\`\`bash
\${OMS_HOME}/bin/orapki wallet display \
  -wallet \${OMS_HOME}/sysman/config/

# Confirm the output shows:
# - Requested Certificate: (the new CA-signed server cert)
# - User Certificates: with the correct CN and issuer
# - Trusted Certificates: Root CA and Intermediate CA

ls -lh \${OMS_HOME}/sysman/config/ewallet.p12 \${OMS_HOME}/sysman/config/cwallet.sso
\`\`\`

---

## Phase 3: Update WebLogic JKS (Layer 1 — Console Port 7803)

### Step 3.1: Convert PEM Certificate to PKCS12 for Java Import

\`\`\`bash
cd /u01/certs/oem
openssl pkcs12 -export \
  -in oms_server.crt \
  -inkey oms_server.key \
  -certfile oms_chain.crt \
  -out oms_weblogic.p12 \
  -name "oem_console" \
  -passout pass:changeit

# Verify PKCS12 contents
openssl pkcs12 -info -nokeys -in oms_weblogic.p12 -passin pass:changeit 2>/dev/null | \
  grep -E "subject=|issuer="
\`\`\`

### Step 3.2: Create New JKS Keystore from PKCS12

\`\`\`bash
JAVA_HOME=\${OMS_HOME}/oracle_common/jdk

# Import server certificate and private key from PKCS12 into JKS
\${JAVA_HOME}/bin/keytool -importkeystore \
  -srckeystore /u01/certs/oem/oms_weblogic.p12 \
  -srcstoretype PKCS12 \
  -srcstorepass changeit \
  -destkeystore /u01/certs/oem/em.keystore \
  -deststoretype JKS \
  -deststorepass changeit \
  -srcalias oem_console \
  -destalias oem_console \
  -noprompt

# Import Root CA into the JKS trust store
\${JAVA_HOME}/bin/keytool -importcert \
  -keystore /u01/certs/oem/em.keystore \
  -storepass changeit \
  -alias root_ca \
  -file /u01/certs/oem/root_ca.crt \
  -noprompt

# Import Intermediate CA into the JKS trust store
\${JAVA_HOME}/bin/keytool -importcert \
  -keystore /u01/certs/oem/em.keystore \
  -storepass changeit \
  -alias intermediate_ca \
  -file /u01/certs/oem/intermediate_ca.crt \
  -noprompt

# Verify all entries in the keystore
\${JAVA_HOME}/bin/keytool -list -v \
  -keystore /u01/certs/oem/em.keystore \
  -storepass changeit | grep -E "Alias|Valid|until|Owner"
\`\`\`

The JKS should contain three entries: the \`oem_console\` key entry (private key + server certificate), and two trusted certificate entries (\`root_ca\` and \`intermediate_ca\`).

### Step 3.3: Update WebLogic Domain to Use the New Keystore (via WLST)

\`\`\`bash
cat > /u01/certs/oem/update_wl_keystore.py << 'EOF'
import sys
connect('weblogic', '<wl_admin_password>', 't3://oms-host.yourdomain.com:7301')
edit()
startEdit()

cd('/Servers/EMGC_OMS1/SSL/EMGC_OMS1')
set('HostnameVerificationIgnored', 'true')
set('TwoWaySSLEnabled', 'false')

cd('/Servers/EMGC_OMS1/KeyStores/EMGC_OMS1')
set('KeyStores', 'CustomIdentityAndCustomTrust')
set('CustomIdentityKeyStoreFileName', '/u01/certs/oem/em.keystore')
set('CustomIdentityKeyStorePassPhraseEncrypted', 'changeit')
set('CustomIdentityKeyStoreType', 'JKS')
set('CustomTrustKeyStoreFileName', '/u01/certs/oem/em.keystore')
set('CustomTrustKeyStorePassPhraseEncrypted', 'changeit')
set('CustomTrustKeyStoreType', 'JKS')

cd('/Servers/EMGC_OMS1/SSL/EMGC_OMS1')
set('PrivateKeyAlias', 'oem_console')
set('PrivateKeyPassPhraseEncrypted', 'changeit')

save()
activate()
disconnect()
exit()
EOF

\${OMS_HOME}/oracle_common/common/bin/wlst.sh /u01/certs/oem/update_wl_keystore.py
\`\`\`

Replace \`EMGC_OMS1\` with the actual WebLogic managed server name for your OEM installation. In a two-OMS HA deployment, run this script for both managed server names (\`EMGC_OMS1\` and \`EMGC_OMS2\`). Confirm the WLST script completes without errors before proceeding to Phase 4.

---

## Phase 4: Re-Secure Management Agents (Layer 3)

### Step 4.1: Start OMS with New Certificates

\`\`\`bash
\${OMS_HOME}/bin/emctl start oms

# Wait for OMS to be fully up before re-securing agents
sleep 60
\${OMS_HOME}/bin/emctl status oms
# Expected: Oracle Management Server is Up
\`\`\`

Confirm the OMS is fully started and showing \`Up\` before proceeding. Attempting to re-secure agents against an OMS that is still starting will produce misleading errors.

### Step 4.2: Re-Secure a Management Agent to Trust the New OMS Certificate

Run on each agent host as the \`oracle\` OS user:

\`\`\`bash
export AGENT_HOME=/u01/app/oracle/product/13.5/agent/agent_13.5.0.0.0

\${AGENT_HOME}/bin/emctl secure agent \
  -emdWalletSrcUrl https://oms-host.yourdomain.com:4900/em

# Enter the agent registration password when prompted
# This re-downloads the current OMS certificate chain into the agent wallet
\`\`\`

### Step 4.3: Verify Agent Communication After Re-Secure

\`\`\`bash
\${AGENT_HOME}/bin/emctl status agent
# Expected: Agent is Running and Ready
# OMS URL line should show: https://oms-host.yourdomain.com:4900/em

# Force a metric upload to verify end-to-end connectivity
\${AGENT_HOME}/bin/emctl upload agent
# Expected: EMD upload completed successfully
\`\`\`

If the upload fails with a certificate or SSL error, the agent wallet did not update correctly. Re-run \`emctl secure agent\` on that host. If it continues to fail, check that the OMS is serving the correct certificate on port 4900 using \`openssl s_client -connect oms-host:4900\` from the agent host.

### Step 4.4: Bulk Re-Secure All Agents from OMS (for Large Deployments)

\`\`\`bash
# Login to emcli from the OMS host
\${OMS_HOME}/bin/emcli login -username=sysman -password=<password>

# Re-secure all agents — use this when you have many agents to update
\${OMS_HOME}/bin/emcli resecure_agents \
  -agent_names="*" \
  -force

# Alternatively, use the OEM console:
# Setup -> Manage Cloud Control -> Agents
# Select all agents -> Action -> Resecure
\`\`\`

Monitor agent status in the OEM console after bulk re-secure. Agents should return to \`Up\` status within a few minutes. Agents that remain \`Blocked\` after re-secure may have network connectivity issues to port 4900 in addition to the certificate problem.

---

## Phase 5: TLS 1.2 Enforcement and Cipher Hardening

### Step 5.1: Disable TLS 1.0 and 1.1 on WebLogic (OMS Console Port)

\`\`\`bash
# Locate the WebLogic domain environment script
grep -n "JAVA_OPTIONS" \${OMS_HOME}/domain/GCDomain/bin/setDomainEnv.sh | head -5

# Edit setDomainEnv.sh to append TLS version restriction to JAVA_OPTIONS
# Add these properties to the JAVA_OPTIONS export line:
#   -Dweblogic.security.SSL.minimumProtocolVersion=TLSv1.2
#   -Djavax.net.ssl.keyStore=/u01/certs/oem/em.keystore
#   -Djavax.net.ssl.keyStorePassword=changeit
\`\`\`

Edit \`setDomainEnv.sh\` to include the TLS minimum version property. Locate the line that sets or exports \`JAVA_OPTIONS\` and append the \`-Dweblogic.security.SSL.minimumProtocolVersion=TLSv1.2\` flag. Verify the edit before restarting.

### Step 5.2: Set TLS Version in sqlnet.ora for Agent Upload Channel

\`\`\`bash
# Append TLS configuration to OMS sqlnet.ora
cat >> \${OMS_HOME}/network/admin/sqlnet.ora << 'EOF'
SSL_VERSION = 1.2
SSL_CIPHER_SUITES = (TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384, TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256, TLS_RSA_WITH_AES_256_GCM_SHA384, TLS_RSA_WITH_AES_128_GCM_SHA256)
EOF

# Verify the addition
grep -E "SSL_VERSION|SSL_CIPHER" \${OMS_HOME}/network/admin/sqlnet.ora
\`\`\`

### Step 5.3: Restart OMS and Verify TLS 1.2 Only

\`\`\`bash
\${OMS_HOME}/bin/emctl stop oms -all
sleep 30
\${OMS_HOME}/bin/emctl start oms
sleep 60

# Verify TLS 1.2 is accepted on console port
openssl s_client -connect oms-host.yourdomain.com:7803 -tls1_2 \
  < /dev/null 2>&1 | grep -E "Protocol|Cipher|Verify"
# Expected: Protocol: TLSv1.2

# Verify TLS 1.0 is now rejected
openssl s_client -connect oms-host.yourdomain.com:7803 -tls1 \
  < /dev/null 2>&1 | grep -E "alert|handshake|error"
# Expected: handshake failure or alert protocol version
\`\`\`

### Step 5.4: Verify Certificate in Browser and via openssl

\`\`\`bash
# Full certificate chain verification
openssl s_client -connect oms-host.yourdomain.com:7803 -showcerts \
  -servername oms-host.yourdomain.com < /dev/null 2>&1 | \
  openssl x509 -noout -text | grep -E "Subject:|DNS:|Not After|Issuer:"

# Verify SANs match all expected access hostnames
openssl s_client -connect oms-host.yourdomain.com:7803 \
  -servername oms-host.yourdomain.com < /dev/null 2>&1 | \
  openssl x509 -noout -ext subjectAltName
\`\`\`

After this step, open the OEM console in a browser. The padlock icon should be green (or equivalent trust indicator) with no warnings. Click the certificate to verify the issuer is the enterprise CA, not a self-signed certificate.

---

## Phase 6: Certificate Expiry Monitoring Script

### Step 6.1: Create the Certificate Monitoring Script

\`\`\`bash
mkdir -p /u01/app/oracle/scripts/oem_cert_check/logs
\`\`\`

Create \`/u01/app/oracle/scripts/oem_cert_check/oem_cert_check.sh\`:

\`\`\`bash
#!/bin/bash
# oem_cert_check.sh — OEM TLS certificate expiry monitor
# Usage: oem_cert_check.sh <OMS_HOST> [OMS_PORT]
# Exit code = number of issues found (Nagios-compatible)

OMS_HOST=\${1:?"Usage: \$0 <OMS_HOST> [OMS_PORT]"}
OMS_PORT=\${2:-7803}
OMS_HOME=\${OMS_HOME:-/u01/app/oracle/product/13.5/oms}
AGENT_HOME=\${AGENT_HOME:-/u01/app/oracle/product/13.5/agent/agent_13.5.0.0.0}
LOG_DIR=/u01/app/oracle/scripts/oem_cert_check/logs
LOG_FILE=\${LOG_DIR}/cert_check_\$(date +%Y%m%d).log
WARN_DAYS=60
CRIT_DAYS=30
ISSUES=0
NOTIFY_EMAIL="dba-alerts@yourdomain.com"

mkdir -p "\${LOG_DIR}"

log() {
    echo "\$(date '+%Y-%m-%d %H:%M:%S') \$*" | tee -a "\${LOG_FILE}"
}

log "=== OEM Certificate Expiry Check: \${OMS_HOST}:\${OMS_PORT} ==="

# --- Layer 1: OMS Console Certificate (port 7803 / OMS_PORT) ---
log "Checking OMS console certificate on \${OMS_HOST}:\${OMS_PORT} ..."
CONSOLE_EXPIRY_STR=\$(openssl s_client -connect "\${OMS_HOST}:\${OMS_PORT}" \
  -servername "\${OMS_HOST}" < /dev/null 2>/dev/null | \
  openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)

if [ -z "\${CONSOLE_EXPIRY_STR}" ]; then
    log "ERROR: Could not retrieve certificate from \${OMS_HOST}:\${OMS_PORT}"
    ISSUES=\$((ISSUES + 1))
else
    CONSOLE_EXPIRY_EPOCH=\$(date -d "\${CONSOLE_EXPIRY_STR}" +%s 2>/dev/null)
    NOW_EPOCH=\$(date +%s)
    DAYS_LEFT=\$(( (CONSOLE_EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))

    if [ "\${DAYS_LEFT}" -le "\${CRIT_DAYS}" ]; then
        log "CRITICAL: OMS console cert expires in \${DAYS_LEFT} days (\${CONSOLE_EXPIRY_STR})"
        ISSUES=\$((ISSUES + 1))
    elif [ "\${DAYS_LEFT}" -le "\${WARN_DAYS}" ]; then
        log "WARNING: OMS console cert expires in \${DAYS_LEFT} days (\${CONSOLE_EXPIRY_STR})"
        ISSUES=\$((ISSUES + 1))
    else
        log "OK: OMS console cert expires in \${DAYS_LEFT} days (\${CONSOLE_EXPIRY_STR})"
    fi
fi

# --- Layer 2: OMS Oracle Wallet Certificate ---
log "Checking OMS Oracle Wallet certificate ..."
if [ -f "\${OMS_HOME}/sysman/config/ewallet.p12" ]; then
    WALLET_OUTPUT=\$(\${OMS_HOME}/bin/orapki wallet display \
      -wallet "\${OMS_HOME}/sysman/config/" 2>/dev/null)

    WALLET_EXPIRY_STR=\$(echo "\${WALLET_OUTPUT}" | \
      grep -i "Valid Until" | head -1 | awk -F: '{print \$2}' | xargs)

    if [ -z "\${WALLET_EXPIRY_STR}" ]; then
        log "WARNING: Could not parse wallet expiry from orapki output"
        ISSUES=\$((ISSUES + 1))
    else
        WALLET_EXPIRY_EPOCH=\$(date -d "\${WALLET_EXPIRY_STR}" +%s 2>/dev/null)
        NOW_EPOCH=\$(date +%s)
        DAYS_LEFT=\$(( (WALLET_EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))

        if [ "\${DAYS_LEFT}" -le "\${CRIT_DAYS}" ]; then
            log "CRITICAL: OMS Oracle Wallet cert expires in \${DAYS_LEFT} days (\${WALLET_EXPIRY_STR})"
            ISSUES=\$((ISSUES + 1))
        elif [ "\${DAYS_LEFT}" -le "\${WARN_DAYS}" ]; then
            log "WARNING: OMS Oracle Wallet cert expires in \${DAYS_LEFT} days (\${WALLET_EXPIRY_STR})"
            ISSUES=\$((ISSUES + 1))
        else
            log "OK: OMS Oracle Wallet cert expires in \${DAYS_LEFT} days (\${WALLET_EXPIRY_STR})"
        fi
    fi
else
    log "INFO: OMS Oracle Wallet not found at \${OMS_HOME}/sysman/config/ — skipping wallet check"
fi

# --- Layer 3: Management Agent Certificate (local host only) ---
if [ -f "\${AGENT_HOME}/bin/emctl" ]; then
    log "Checking Management Agent certificate on local host ..."
    AGENT_STATUS=\$(\${AGENT_HOME}/bin/emctl status agent 2>/dev/null)
    AGENT_CERT_LINE=\$(echo "\${AGENT_STATUS}" | grep -i "cert\|wallet" | head -3)

    if echo "\${AGENT_STATUS}" | grep -qi "agent is running"; then
        log "OK: Management Agent is running"
        if [ -n "\${AGENT_CERT_LINE}" ]; then
            log "Agent cert info: \${AGENT_CERT_LINE}"
        fi
    else
        log "WARNING: Management Agent may not be running or has certificate issue"
        log "Agent status: \$(echo "\${AGENT_STATUS}" | head -5)"
        ISSUES=\$((ISSUES + 1))
    fi
else
    log "INFO: No Management Agent found at \${AGENT_HOME} — skipping agent check"
fi

# --- Summary and Notification ---
log "=== Check complete: \${ISSUES} issue(s) found ==="

if [ "\${ISSUES}" -gt 0 ]; then
    SUBJECT="[OEM CERT ALERT] \${ISSUES} certificate issue(s) on \${OMS_HOST}"
    if command -v mailx > /dev/null 2>&1; then
        mailx -s "\${SUBJECT}" "\${NOTIFY_EMAIL}" < "\${LOG_FILE}"
        log "Notification sent to \${NOTIFY_EMAIL}"
    elif command -v sendmail > /dev/null 2>&1; then
        { echo "Subject: \${SUBJECT}"; echo ""; cat "\${LOG_FILE}"; } | \
          sendmail "\${NOTIFY_EMAIL}"
        log "Notification sent via sendmail to \${NOTIFY_EMAIL}"
    else
        log "WARNING: No mail client found (mailx/sendmail) — email notification skipped"
    fi
fi

exit \${ISSUES}
\`\`\`

### Step 6.2: Set Script Permissions and Test

\`\`\`bash
chmod 750 /u01/app/oracle/scripts/oem_cert_check/oem_cert_check.sh

# Test run
/u01/app/oracle/scripts/oem_cert_check/oem_cert_check.sh oms-host.yourdomain.com 7803
echo "Exit code: \$?"

# Review log
cat /u01/app/oracle/scripts/oem_cert_check/logs/cert_check_\$(date +%Y%m%d).log
\`\`\`

### Step 6.3: Add Crontab Entry (Daily at 6 AM)

\`\`\`bash
# Add to oracle user's crontab:
crontab -e
\`\`\`

Add the following crontab entry:

\`\`\`
0  6  *  *  *  /u01/app/oracle/scripts/oem_cert_check/oem_cert_check.sh oms-host.yourdomain.com 7803 >> /u01/app/oracle/scripts/oem_cert_check/logs/cron_cert.log 2>&1
\`\`\`

---

## Quick Reference

### Key Commands Summary

\`\`\`bash
# OMS Oracle Wallet operations
orapki wallet display -wallet \$OMS_HOME/sysman/config/ -pwd <pwd>
orapki wallet add -wallet <dir> -trusted_cert -cert ca.crt -pwd <pwd>
orapki wallet import_pkcs12 -wallet <dir> -pkcs12file server.p12 -pkcs12pwd <pwd> -pwd <pwd>

# emctl secure commands
emctl secure oms -pem_file server.crt -pem_key_file server.key -pem_rootca_file chain.crt
emctl secure agent -emdWalletSrcUrl https://oms-host:4900/em

# keytool JKS operations
keytool -list -v -keystore em.keystore -storepass changeit
keytool -importkeystore -srckeystore server.p12 -srcstoretype PKCS12 -destkeystore em.keystore
keytool -importcert -keystore em.keystore -alias root_ca -file root_ca.crt

# openssl verification
openssl s_client -connect host:7803 -tls1_2 -showcerts
openssl x509 -text -noout -in server.crt
openssl verify -CAfile root_ca.crt -untrusted intermediate.crt server.crt
\`\`\`

### Certificate File Reference

\`\`\`
oms_server.key      — private key (protect strictly, 600 permissions, never share)
oms_server.csr      — certificate signing request (submitted to CA)
oms_server.crt      — CA-signed server certificate (PEM)
intermediate_ca.crt — intermediate CA certificate (from CA)
root_ca.crt         — root CA certificate (from CA)
oms_chain.crt       — full chain: server + intermediate + root (concatenated PEM)
oms_server.p12      — PKCS12 bundle used for Oracle Wallet import
oms_weblogic.p12    — PKCS12 bundle used for WebLogic JKS import
em.keystore         — WebLogic JKS keystore (Layer 1)
ewallet.p12         — Oracle Wallet PKCS12 container (Layer 2 OMS, Layer 3 Agent)
cwallet.sso         — Oracle auto-login wallet companion (required for service startup)
\`\`\`

### TLS Enforcement Checklist

\`\`\`
[ ] Layer 2 OMS wallet updated (emctl secure oms or orapki)
[ ] Layer 3 all agents re-secured (emctl secure agent on each host)
[ ] Layer 1 WebLogic JKS updated (keytool + WLST)
[ ] OMS restarted cleanly after all certificate changes
[ ] Browser shows CA-signed certificate with no warnings on port 7803
[ ] openssl s_client confirms TLS 1.2 on ports 7803 and 4900
[ ] openssl s_client confirms TLS 1.0 is rejected on port 7803
[ ] All agents showing Up/Ready in OEM console
[ ] emctl upload agent succeeds on at least one agent per host
[ ] Certificate expiry monitoring cron job scheduled
[ ] Backup wallet and keystore files stored in secure location
[ ] Certificate renewal date added to DBA operational calendar
\`\`\``,
};

async function main() {
  console.log('Inserting OEM TLS certificate installation runbook...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: { ...post },
  });
  console.log('Inserted: "' + post.title + '"');
}

main().catch(console.error);
