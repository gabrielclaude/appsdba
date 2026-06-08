import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Renewing Expired WebLogic Demo Certificates and OHS Wallets in EBS 12.2',
  slug: 'ebs-weblogic-ohs-demo-certificate-expiry-runbook',
  excerpt:
    'Operational runbook for recovering an Oracle E-Business Suite 12.2 environment from simultaneous WebLogic DemoIdentity JKS and OHS cwallet.sso certificate expiry. Covers pre-flight expiry diagnostics, CertGen/ImportPrivateKey procedures, orapki wallet rebuild, opmnctl restart sequence, and a cron-based cert expiry monitoring script.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-08'),
  youtubeUrl: null,
  content: `## Purpose and Scope

This runbook restores SSL communications on an Oracle E-Business Suite 12.2 environment after the simultaneous expiry of:

1. **WebLogic DemoIdentity.jks** — the self-signed certificate securing WebLogic Admin Server and all Managed Server (oacore, oafm, forms-c4ws, etc.) SSL listen ports.
2. **OHS ohs1_default** — the self-signed certificate inside the Oracle HTTP Server auto-login wallet (\`cwallet.sso\`), securing the OHS SSL virtual host.

Both are generated during domain provisioning and hardcoded to expire five years from that date, so they expire together.

**Reference post:** [The 5-Year Time Bomb: Resolving Expired WebLogic Demo Certificates and OHS Wallets in EBS](/posts/ebs-weblogic-ohs-demo-certificate-expiry)

---

## Environment Variables

Set these shell variables before running any command in this runbook. All subsequent commands reference them.

\`\`\`bash
# WebLogic domain home — adjust for your installation
export DOMAIN_HOME=/u01/oracle/middleware/user_projects/domains/EBS_domain_ebsdb

# Oracle Middleware home (contains WebLogic, OHS binaries)
export MW_HOME=/u01/oracle/middleware

# Oracle home for OHS/orapki (typically same as or under MW_HOME)
export ORACLE_HOME=/u01/oracle/middleware

# Oracle instance home (OHS config lives here in EBS 12.2)
export ORACLE_INSTANCE=/u01/oracle/middleware/user_projects/domains/EBS_domain_ebsdb

# OHS instance name — check opmnctl status output if unsure
export OHS_INSTANCE=ohs_1

# Java home — used for keytool and WebLogic utils
export JAVA_HOME=/u01/oracle/middleware/oracle_common/jdk
export PATH=\$JAVA_HOME/bin:\$MW_HOME/wlserver/server/bin:\$ORACLE_HOME/bin:\$PATH

# Load WebLogic domain environment
source \$DOMAIN_HOME/bin/setDomainEnv.sh
\`\`\`

---

## Phase 0 — Pre-Flight Expiry Diagnostics

Run all checks before touching any certificates. Capture the output for the post-incident record.

### 0.1 Check WebLogic DemoIdentity expiry

\`\`\`bash
keytool -list -v \
  -keystore \$DOMAIN_HOME/security/DemoIdentity.jks \
  -storepass DemoIdentityKeyStorePassPhrase \
  -alias demoidentity 2>/dev/null \
  | grep -E "Alias|Valid|Owner|Issuer|Serial"
\`\`\`

Expected output when expired:

\`\`\`
Alias name: demoidentity
Valid from: Mon Jun 08 09:00:00 UTC 2021 until: Sat Jun 07 09:00:00 UTC 2026
\`\`\`

If \`until\` is in the past, the DemoIdentity certificate requires renewal.

### 0.2 Check OHS wallet certificate expiry

\`\`\`bash
orapki wallet display \
  -wallet \$DOMAIN_HOME/config/fmwconfig/components/OHS/instances/\${OHS_INSTANCE}/keystores/default
\`\`\`

Look for the \`Valid Until\` field in the output. A date in the past confirms the OHS wallet certificate has expired.

### 0.3 Confirm from the live OHS SSL endpoint

\`\`\`bash
# Replace port 4443 with your OHS SSL port (check ssl.conf Listen directive)
openssl s_client -connect $(hostname -f):4443 -showcerts </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -dates
\`\`\`

### 0.4 Check all EBS managed server SSL ports

\`\`\`bash
for PORT in 4443 4444 9001 9002 9003; do
  echo -n "Port \$PORT: "
  openssl s_client -connect $(hostname -f):\$PORT </dev/null 2>/dev/null \
    | openssl x509 -noout -dates 2>/dev/null \
    || echo "no response / not SSL"
done
\`\`\`

### 0.5 Check DemoTrust.jks (should not need renewal but verify)

\`\`\`bash
keytool -list -v \
  -keystore \$DOMAIN_HOME/security/DemoTrust.jks \
  -storepass DemoTrustKeyStorePassPhrase 2>/dev/null \
  | grep -E "Alias|Valid"
\`\`\`

DemoTrust contains the corresponding CA certificate and is typically valid for much longer. If it is also expired, it must be replaced using the same CertGen flow.

---

## Phase 1 — Controlled Shutdown

Stop all processes in order before modifying any keystore or wallet. Do not attempt a hot replacement.

### 1.1 Stop all EBS Managed Servers

\`\`\`bash
# From the domain home — adjust managed server names for your EBS deployment
\$DOMAIN_HOME/bin/stopManagedWebLogic.sh oacore_server1      t3://localhost:7201
\$DOMAIN_HOME/bin/stopManagedWebLogic.sh oafm_server1        t3://localhost:7202
\$DOMAIN_HOME/bin/stopManagedWebLogic.sh forms-c4ws_server1  t3://localhost:9001
\`\`\`

Or stop all via WLST if Admin Server is still responsive:

\`\`\`python
# wlst_stop_all.py
connect('weblogic', 'your_admin_password', 't3://localhost:7001')
domainRuntime()
cd('ServerLifeCycleRuntimes')
for server in ls(returnMap='true'):
    if server != 'AdminServer':
        shutdown(server, 'Server', ignoreSessions='true', timeOut=60, force='true')
exit()
\`\`\`

\`\`\`bash
java weblogic.WLST wlst_stop_all.py
\`\`\`

### 1.2 Stop OHS via opmnctl

\`\`\`bash
\$ORACLE_INSTANCE/bin/opmnctl stopall
\$ORACLE_INSTANCE/bin/opmnctl status   # all components should show 'Down'
\`\`\`

### 1.3 Stop the Admin Server

\`\`\`bash
\$DOMAIN_HOME/bin/stopWebLogic.sh
\`\`\`

### 1.4 Stop Node Manager (if running)

\`\`\`bash
# Find and kill the Node Manager process
NM_PID=$(pgrep -f "weblogic.NodeManager")
[ -n "\$NM_PID" ] && kill "\$NM_PID" && echo "Node Manager stopped (PID \$NM_PID)" || echo "Node Manager not running"
\`\`\`

---

## Phase 2 — Back Up Existing Keystores and Wallets

Never delete before backing up. Tag backups with today's date.

\`\`\`bash
BACKUP_DATE=$(date +%Y%m%d_%H%M)

# Back up WebLogic keystores
cp \$DOMAIN_HOME/security/DemoIdentity.jks \$DOMAIN_HOME/security/DemoIdentity.jks.bak_\${BACKUP_DATE}
cp \$DOMAIN_HOME/security/DemoTrust.jks    \$DOMAIN_HOME/security/DemoTrust.jks.bak_\${BACKUP_DATE}

# Back up OHS wallet
WALLET_DIR=\$DOMAIN_HOME/config/fmwconfig/components/OHS/instances/\${OHS_INSTANCE}/keystores/default
cp \$WALLET_DIR/cwallet.sso \$WALLET_DIR/cwallet.sso.bak_\${BACKUP_DATE}
[ -f \$WALLET_DIR/ewallet.p12 ] && cp \$WALLET_DIR/ewallet.p12 \$WALLET_DIR/ewallet.p12.bak_\${BACKUP_DATE}

echo "Backups written with suffix _\${BACKUP_DATE}"
ls -lh \$DOMAIN_HOME/security/*.bak_* \$WALLET_DIR/*.bak_*
\`\`\`

---

## Phase 3 — Regenerate the WebLogic DemoIdentity Certificate

### 3.1 Navigate to the domain security directory

\`\`\`bash
cd \$DOMAIN_HOME/security
\`\`\`

### 3.2 Generate a new key pair with CertGen

\`\`\`bash
java utils.CertGen \
  -key_sz 2048 \
  -cert_value DemoIdentity
\`\`\`

This produces two files in the current directory:
- \`DemoIdentity.pem\` — the new self-signed certificate
- \`DemoIdentityKey.pem\` — the corresponding RSA private key

Verify both files were created:

\`\`\`bash
ls -lh DemoIdentity.pem DemoIdentityKey.pem
openssl x509 -noout -subject -dates -in DemoIdentity.pem
\`\`\`

### 3.3 Import the new certificate into DemoIdentity.jks

\`\`\`bash
java utils.ImportPrivateKey \
  -keystore DemoIdentity.jks \
  -storepass DemoIdentityKeyStorePassPhrase \
  -keypass DemoIdentityPassPhrase \
  -alias demoidentity \
  -certfile DemoIdentity.pem \
  -keyfile DemoIdentityKey.pem
\`\`\`

### 3.4 Verify the updated keystore

\`\`\`bash
keytool -list -v \
  -keystore DemoIdentity.jks \
  -storepass DemoIdentityKeyStorePassPhrase \
  -alias demoidentity \
  | grep -E "Alias|Valid|Owner"
\`\`\`

Confirm \`Valid until\` is approximately five years in the future.

### 3.5 Regenerate DemoTrust.jks (if also expired)

If Phase 0.5 showed DemoTrust is also expired:

\`\`\`bash
java utils.CertGen \
  -key_sz 2048 \
  -cert_value DemoTrust

java utils.ImportPrivateKey \
  -keystore DemoTrust.jks \
  -storepass DemoTrustKeyStorePassPhrase \
  -keypass DemoTrustPassPhrase \
  -alias demotrust \
  -certfile DemoTrust.pem \
  -keyfile DemoTrustKey.pem
\`\`\`

---

## Phase 4 — Rebuild the OHS Auto-Login Wallet

### 4.1 Navigate to the OHS keystore directory

\`\`\`bash
WALLET_DIR=\$DOMAIN_HOME/config/fmwconfig/components/OHS/instances/\${OHS_INSTANCE}/keystores/default
cd \$WALLET_DIR
\`\`\`

### 4.2 Remove the expired auto-login wallet

The backup was already taken in Phase 2. Now remove the active file so \`orapki\` can create a fresh one:

\`\`\`bash
rm -f cwallet.sso ewallet.p12
ls -la   # confirm directory is empty (only backup files should remain)
\`\`\`

### 4.3 Create a new empty wallet with auto-login

\`\`\`bash
# Replace YourSecureWalletPassword123 with a site-specific password
# Record this password in your password vault — it is needed if you ever export the wallet
orapki wallet create -wallet . -pwd YourSecureWalletPassword123 -auto_login
\`\`\`

This creates both \`cwallet.sso\` (auto-login, used by OHS at runtime) and \`ewallet.p12\` (password-protected, used for management operations).

### 4.4 Generate a new self-signed certificate in the wallet

\`\`\`bash
# Replace CN and O with your actual hostname and organisation
orapki wallet add \
  -wallet . \
  -pwd YourSecureWalletPassword123 \
  -dn "CN=$(hostname -f),O=Demo,C=US" \
  -keysize 2048 \
  -validity 1825 \
  -self_signed
\`\`\`

\`-validity 1825\` = 365 × 5 days. This aligns the new OHS expiry with the freshly regenerated WebLogic DemoIdentity certificate.

### 4.5 Verify the wallet contents

\`\`\`bash
orapki wallet display -wallet .
\`\`\`

Expected output:

\`\`\`
Oracle PKI Tool Release 12.2.1.4.0 ...
Requested Certificates:
User Certificates:
Subject:        CN=yourhost.domain.com,O=Demo,C=US
Valid From:     June 8, 2026
Valid Until:    June 7, 2031
\`\`\`

### 4.6 Confirm the SSLWallet path in ssl.conf

\`\`\`bash
grep -n "SSLWallet" \$DOMAIN_HOME/config/fmwconfig/components/OHS/instances/\${OHS_INSTANCE}/config/OHS/ohs_1/ssl.conf
\`\`\`

The path shown must match \`\$WALLET_DIR\`. If it points elsewhere, update \`ssl.conf\` to match where you placed the new wallet.

---

## Phase 5 — Restart All Components

Restart in order: Node Manager → Admin Server → OHS → Managed Servers.

### 5.1 Start Node Manager

\`\`\`bash
nohup \$DOMAIN_HOME/bin/startNodeManager.sh > /tmp/nodemanager.log 2>&1 &
sleep 15
grep -i "listening on" /tmp/nodemanager.log
\`\`\`

### 5.2 Start Admin Server

\`\`\`bash
nohup \$DOMAIN_HOME/bin/startWebLogic.sh > /tmp/adminserver.log 2>&1 &
# Wait for RUNNING state — typically 60-90 seconds
sleep 90
grep -i "RUNNING\|Server started" /tmp/adminserver.log | tail -5
\`\`\`

### 5.3 Start OHS

\`\`\`bash
\$ORACLE_INSTANCE/bin/opmnctl startall
sleep 10
\$ORACLE_INSTANCE/bin/opmnctl status
\`\`\`

All OHS components should show \`Alive\` status.

### 5.4 Start Managed Servers via Admin Console or WLST

\`\`\`bash
# Via WLST
java weblogic.WLST <<'WLST_EOF'
connect('weblogic', 'your_admin_password', 't3://localhost:7001')
start('oacore_server1', 'Server')
start('oafm_server1', 'Server')
start('forms-c4ws_server1', 'Server')
exit()
WLST_EOF
\`\`\`

---

## Phase 6 — Verification

### 6.1 Verify WebLogic SSL from the Admin Console

Open the WebLogic Admin Console at \`https://yourhost:7002/console\`. Confirm the SSL handshake completes (no certificate error in the browser) and log in successfully.

### 6.2 Verify the new DemoIdentity certificate via keytool

\`\`\`bash
keytool -list -v \
  -keystore \$DOMAIN_HOME/security/DemoIdentity.jks \
  -storepass DemoIdentityKeyStorePassPhrase \
  -alias demoidentity \
  | grep -E "Valid"
\`\`\`

### 6.3 Verify OHS SSL from the command line

\`\`\`bash
openssl s_client -connect $(hostname -f):443 -showcerts </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -dates
\`\`\`

The \`notAfter\` date should be five years from today.

### 6.4 Verify EBS login through the OHS front end

\`\`\`bash
# Confirm OHS is routing to EBS — expect HTTP 200 or 302
curl -sk -o /dev/null -w "%{http_code}" https://$(hostname -f)/OA_HTML/AppsLogin
\`\`\`

A \`200\` or \`302\` confirms OHS is handling SSL and forwarding to the WebLogic-hosted EBS application layer.

### 6.5 Check all Managed Server SSL ports

\`\`\`bash
for PORT in 7002 9001 9002 9003; do
  echo -n "Port \$PORT: "
  EXPIRY=$(openssl s_client -connect $(hostname -f):\$PORT </dev/null 2>/dev/null \
    | openssl x509 -noout -dates 2>/dev/null | grep notAfter)
  echo "\${EXPIRY:-no response}"
done
\`\`\`

---

## Proactive Monitoring: Certificate Expiry Alert Script

Deploy this script to catch future expiry events before they become incidents. It checks both the WebLogic JKS and the OHS wallet and sends an email if any certificate expires within 60 days.

\`\`\`bash
#!/bin/bash
# check_cert_expiry.sh — checks WLS JKS and OHS wallet, alerts at < 60 days remaining

export ORACLE_HOME=/u01/oracle/middleware
export DOMAIN_HOME=/u01/oracle/middleware/user_projects/domains/EBS_domain_ebsdb
export JAVA_HOME=/u01/oracle/middleware/oracle_common/jdk
export PATH=\$JAVA_HOME/bin:\$ORACLE_HOME/bin:\$PATH

ALERT_THRESHOLD_DAYS=60
EMAIL_RECEIVER="dba_team@yourcompany.com"
HOSTNAME_FQDN=$(hostname -f)
ALERT_MSG=""

check_jks() {
    local STORE="\$1"
    local PASS="\$2"
    local ALIAS="\$3"
    local LABEL="\$4"

    EXPIRY_STR=$(keytool -list -v -keystore "\$STORE" -storepass "\$PASS" \
                   -alias "\$ALIAS" 2>/dev/null | grep "until:" | sed 's/.*until: //')
    if [ -z "\$EXPIRY_STR" ]; then
        ALERT_MSG+="\$LABEL: Could not read certificate (store missing or wrong password)\n"
        return
    fi
    EXPIRY_EPOCH=$(date -d "\$EXPIRY_STR" +%s 2>/dev/null)
    NOW_EPOCH=$(date +%s)
    DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))
    if [ "\$DAYS_LEFT" -lt "\$ALERT_THRESHOLD_DAYS" ]; then
        ALERT_MSG+="\$LABEL: expires in \${DAYS_LEFT} days (\$EXPIRY_STR)\n"
    fi
}

check_ohs_wallet() {
    local WALLET_DIR="\$1"
    local LABEL="\$2"

    EXPIRY_STR=$(orapki wallet display -wallet "\$WALLET_DIR" 2>/dev/null \
                   | grep -i "valid until" | head -1 | sed 's/.*Valid Until: *//')
    if [ -z "\$EXPIRY_STR" ]; then
        ALERT_MSG+="\$LABEL: Could not read OHS wallet\n"
        return
    fi
    EXPIRY_EPOCH=$(date -d "\$EXPIRY_STR" +%s 2>/dev/null)
    NOW_EPOCH=$(date +%s)
    DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))
    if [ "\$DAYS_LEFT" -lt "\$ALERT_THRESHOLD_DAYS" ]; then
        ALERT_MSG+="\$LABEL: expires in \${DAYS_LEFT} days (\$EXPIRY_STR)\n"
    fi
}

# Check WebLogic keystores
check_jks "\$DOMAIN_HOME/security/DemoIdentity.jks" \
          "DemoIdentityKeyStorePassPhrase" \
          "demoidentity" \
          "WebLogic DemoIdentity (JKS)"

check_jks "\$DOMAIN_HOME/security/DemoTrust.jks" \
          "DemoTrustKeyStorePassPhrase" \
          "demotrust" \
          "WebLogic DemoTrust (JKS)"

# Check OHS wallet
check_ohs_wallet \
  "\$DOMAIN_HOME/config/fmwconfig/components/OHS/instances/ohs_1/keystores/default" \
  "OHS ohs1_default (Oracle Wallet)"

# Send alert if any threshold was breached
if [ -n "\$ALERT_MSG" ]; then
    (
      echo "To: \${EMAIL_RECEIVER}"
      echo "Subject: CERT EXPIRY WARNING on \${HOSTNAME_FQDN} — action required within \${ALERT_THRESHOLD_DAYS} days"
      echo "MIME-Version: 1.0"
      echo "Content-Type: text/plain; charset=UTF-8"
      echo ""
      echo "The following certificates on \${HOSTNAME_FQDN} are approaching expiry:"
      echo ""
      echo -e "\${ALERT_MSG}"
      echo "Run the EBS WLS/OHS certificate renewal runbook before these dates pass."
    ) | /usr/sbin/sendmail -t
fi
\`\`\`

Make it executable and schedule via crontab to run weekly:

\`\`\`bash
chmod +x /home/oracle/scripts/check_cert_expiry.sh

# Add to crontab — runs every Monday at 07:00
crontab -e
# 0 7 * * 1 /home/oracle/scripts/check_cert_expiry.sh > /dev/null 2>&1
\`\`\`

---

## Post-Incident Checklist

- [ ] WebLogic Admin Console accessible over HTTPS (port 7002)
- [ ] EBS login page loads through OHS front end without SSL errors
- [ ] \`openssl s_client\` confirms new expiry date is 5 years from today on all SSL ports
- [ ] OHS \`opmnctl status\` shows all components \`Alive\`
- [ ] All Managed Servers show \`RUNNING\` in Admin Console
- [ ] \`check_cert_expiry.sh\` deployed and crontab entry confirmed
- [ ] Backup files dated \`\${BACKUP_DATE}\` preserved and noted in the incident record
- [ ] Change request raised to migrate from demo certificates to CA-signed certificates

---

## Production Migration Path (Post-Recovery)

Demo certificates carry a hard security risk: their default passwords are public knowledge. After restoring operations, plan the following in the next maintenance window:

| Component | Target State | Tool |
|-----------|-------------|------|
| WebLogic DemoIdentity.jks | Replace with CA-signed cert in a custom JKS | \`keytool -importcert\` |
| WebLogic DemoTrust.jks | Add CA root and intermediates | \`keytool -importcert\` |
| OHS cwallet.sso | Replace self-signed with CA-signed cert | \`orapki wallet add\` with CSR flow |
| WebLogic SSL config | Update keystore paths and passwords in config.xml | WLST or Admin Console |
| OHS ssl.conf | Verify \`SSLWallet\` path points to new wallet | Manual edit + opmnctl restart |

The CSR flow for OHS wallets:

\`\`\`bash
# 1. Generate a certificate signing request from the wallet
orapki wallet add \
  -wallet \$WALLET_DIR \
  -pwd YourSecureWalletPassword123 \
  -dn "CN=yourhost.domain.com,O=YourOrg,C=US" \
  -keysize 2048 \
  -sign_alg sha256

# 2. Export the CSR for your CA to sign
orapki wallet export \
  -wallet \$WALLET_DIR \
  -pwd YourSecureWalletPassword123 \
  -dn "CN=yourhost.domain.com,O=YourOrg,C=US" \
  -request /tmp/ohs_server.csr

# 3. Submit /tmp/ohs_server.csr to your internal CA
# 4. Import the signed certificate and CA chain back:
orapki wallet add \
  -wallet \$WALLET_DIR \
  -pwd YourSecureWalletPassword123 \
  -trusted_cert \
  -cert /tmp/ca_chain.pem

orapki wallet add \
  -wallet \$WALLET_DIR \
  -pwd YourSecureWalletPassword123 \
  -user_cert \
  -cert /tmp/ohs_server_signed.pem

# 5. Recreate the auto-login layer after importing CA-signed content
orapki wallet create \
  -wallet \$WALLET_DIR \
  -pwd YourSecureWalletPassword123 \
  -auto_login
\`\`\``,
};

async function main() {
  console.log('Inserting EBS WebLogic/OHS demo certificate expiry runbook...');
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
