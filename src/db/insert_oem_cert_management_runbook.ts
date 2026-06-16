import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'OEM 13c Certificate Renewal Runbook: Expired CA, OMS, Console, Upload, and Agent Re-Registration',
  slug: 'oem-13c-certificate-renewal-runbook-expired-ca',
  excerpt:
    'Step-by-step runbook for recovering Oracle Enterprise Manager 13c when all certificates — CA, console (port 7799), and upload (port 1159) — have expired simultaneously. Covers the WebLogic Admin Server prerequisite for emctl secure oms, the correct renewal sequence, internal CA certificate import, agent re-registration, and post-renewal verification. Includes the internal CA creation procedure for enterprise PKI environments.',
  category: 'oracle-security' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-17'),
  youtubeUrl: null,
  content: `## Overview

This runbook recovers Oracle Enterprise Manager Cloud Control 13c when the OEM CA certificate and dependent OMS certificates (console port 7799, upload port 1159) have expired. It addresses the specific failure where \`emctl secure oms\` returns a WebLogic JMX connection error to port 7101 — a sequencing dependency issue, not a certificate file problem.

**Symptoms this runbook addresses:**
- Browser shows certificate error or connection refused on \`https://oemhost:7799\`
- Agents show upload errors or disconnect from OMS (port 1159 failures)
- \`emctl secure oms\` fails with \`t3s://oemhost:7101: Connection refused\`
- \`openssl s_client\` shows \`notAfter\` date in the past for ports 7799 and/or 1159
- \`orapki wallet display\` shows the CA certificate as expired

**OEM versions covered:** OEM 13c (13.3, 13.4, 13.5)

**Prerequisites:** OS-level access to the OMS host as the oracle user, sysman password, agent registration password, sudo or root access if ports below 1024 need firewall adjustments.

---

## Phase 1: Assess the Damage

### 1.1 Check All Certificate Expiration Dates

Run all three checks before starting renewal. The results determine the sequence.

\`\`\`bash
# Set OMS environment
source /u01/app/oracle/middleware/oms/bin/envvar.sh
# Or for OEM 13.5:
export OMS_HOME=/u01/app/oracle/middleware/oms
export PATH=$OMS_HOME/bin:$PATH

OEM_HOST=$(hostname -f)

echo "=== Console Certificate (port 7799) ==="
echo | openssl s_client -connect \${OEM_HOST}:7799 2>/dev/null | \
  openssl x509 -noout -subject -issuer -dates

echo "=== Upload Certificate (port 1159) ==="
echo | openssl s_client -connect \${OEM_HOST}:1159 2>/dev/null | \
  openssl x509 -noout -subject -issuer -dates

echo "=== OMS Wallet Contents ==="
orapki wallet display -wallet $OMS_HOME/sysman/config/monwallet
\`\`\`

Record the \`notAfter\` dates for each. If the CA certificate (the one whose Subject and Issuer match — it signs itself) shows an expired date, you are in the full CA renewal scenario. Proceed through all phases in order.

### 1.2 Check OMS and WebLogic Status

\`\`\`bash
# Check what OEM processes are running
$OMS_HOME/bin/emctl status oms

# Check if WebLogic Admin Server is listening on port 7101
netstat -tlnp 2>/dev/null | grep 7101
# or
ss -tlnp | grep 7101
\`\`\`

If WebLogic Admin Server is NOT listening on port 7101, note this — it is the reason \`emctl secure oms\` will fail and must be resolved in Phase 3.

### 1.3 Verify Agent Connectivity Status

\`\`\`bash
# Check how many agents are currently disconnected
$OMS_HOME/bin/emctl status agent
# On any agent host:
$AGENT_HOME/bin/emctl status agent
$AGENT_HOME/bin/emctl ping oms
\`\`\`

---

## Phase 2: Stop OMS Cleanly

\`\`\`bash
# Stop all OMS components
$OMS_HOME/bin/emctl stop oms -all

# Verify all OMS processes stopped
ps -ef | grep java | grep -i ems
ps -ef | grep EMGC

# Confirm ports are released
netstat -tlnp | grep -E "7799|1159|7101"
\`\`\`

All three ports should show no listeners after this step. If port 7101 still shows a listener, the WebLogic Admin Server did not stop — kill it explicitly:

\`\`\`bash
# Find and kill the WebLogic Admin Server process if stuck
ps -ef | grep weblogic | grep AdminServer
kill -9 <pid>
\`\`\`

---

## Phase 3: Start WebLogic Admin Server Only (Critical Prerequisite)

The \`emctl secure oms\` command connects to the WebLogic Admin Server via T3S on port 7101 to update WebLogic keystores as part of OMS re-securitization. If WebLogic is not running, the command fails immediately with a connection refused error — before any certificate work begins.

Start ONLY the WebLogic Admin Server, not the full OMS stack:

\`\`\`bash
# Method 1: Use emctl admin_only mode (OEM 13.3+)
$OMS_HOME/bin/emctl start oms -admin_only

# Wait for WebLogic Admin Server to fully start (typically 60-120 seconds)
sleep 90

# Confirm WebLogic Admin Server is listening on port 7101
netstat -tlnp | grep 7101
\`\`\`

If \`-admin_only\` is not available or fails, start WebLogic via Node Manager:

\`\`\`bash
# Method 2: Start via Node Manager + WLST
$OMS_HOME/oracle_common/common/bin/wlst.sh <<EOF
nmConnect('<nm_user>', '<nm_password>', '<oemhost>', '7403', 'GCDomain', '$OMS_HOME/gc_inst/em/EMGC_OMS1')
nmStart('EMGC_ADMINSERVER')
exit()
EOF

sleep 120
netstat -tlnp | grep 7101
\`\`\`

**Do not proceed to Phase 4 until port 7101 shows an active listener.**

---

## Phase 4: Renew the OMS CA and Upload Certificate (emctl secure oms)

With WebLogic Admin Server running on port 7101, run the full OMS re-securitization:

\`\`\`bash
$OMS_HOME/bin/emctl secure oms \
  -sysman_pwd <sysman_password> \
  -reg_pwd <agent_registration_password>
\`\`\`

This command:
1. Generates a new OEM CA certificate
2. Signs a new OMS upload certificate with the new CA
3. Updates the OMS wallet (\`monwallet\`)
4. Updates the WebLogic keystore via JMX on port 7101
5. Updates the agent registration password hash in the repository

Expected output on success:
\`\`\`
Securing OMS... Started.
Securing OMS... Successful
\`\`\`

If the command fails again with the T3S connection error, WebLogic did not fully start. Wait an additional 60 seconds and retry. Check the WebLogic Admin Server log for startup errors:

\`\`\`bash
tail -100 $OMS_HOME/gc_inst/em/EMGC_OMS1/sysman/log/emoms.log
tail -100 $OMS_HOME/gc_inst/WebLogicDomain/EMGC_OMS1/EMGC_ADMINSERVER/EMGC_ADMINSERVER.log
\`\`\`

---

## Phase 5: Renew the Console Certificate

The console certificate (port 7799) can be renewed as a self-signed certificate independent of the OEM CA, or it can be signed by the newly regenerated OEM CA:

\`\`\`bash
# Option A: Self-signed console certificate (fastest)
$OMS_HOME/bin/emctl secure console \
  -self_signed \
  -sysman_pwd <sysman_password>

# Option B: CA-signed console certificate (recommended for enterprise PKI)
# Generate CSR and sign with internal CA per Phase 8, then:
$OMS_HOME/bin/emctl secure console \
  -ca_signed \
  -sysman_pwd <sysman_password> \
  -cert_file /tmp/oms_console.crt \
  -key_file /tmp/oms_console.key \
  -ca_file /tmp/internal_ca_chain.pem
\`\`\`

---

## Phase 6: Restart OMS Fully

\`\`\`bash
# Stop WebLogic Admin Server
$OMS_HOME/bin/emctl stop oms -all

# Wait for clean shutdown
sleep 30

# Start full OMS stack
$OMS_HOME/bin/emctl start oms

# Monitor startup — wait for "Oracle Management Service Started" message
tail -f $OMS_HOME/gc_inst/em/EMGC_OMS1/sysman/log/emoms.log
\`\`\`

OMS startup typically takes 3–8 minutes. The key line to look for:

\`\`\`
Oracle Management Service is Up
\`\`\`

### 6.1 Verify New Certificates Are Active

\`\`\`bash
OEM_HOST=$(hostname -f)

echo "=== New Console Certificate ==="
echo | openssl s_client -connect \${OEM_HOST}:7799 2>/dev/null | \
  openssl x509 -noout -subject -issuer -dates

echo "=== New Upload Certificate ==="
echo | openssl s_client -connect \${OEM_HOST}:1159 2>/dev/null | \
  openssl x509 -noout -subject -issuer -dates
\`\`\`

Confirm both \`notAfter\` dates are in the future. The self-signed OEM certificates generated by \`emctl secure oms\` will be valid for another 10 years from today — schedule a reminder for year 9 using the monitoring approach in Phase 9.

---

## Phase 7: Re-Secure and Re-Register Agents

After the OEM CA is regenerated, all agents must be re-secured to obtain new certificates signed by the new CA. Agents that still hold certificates signed by the old (now-revoked) CA will not be trusted.

### 7.1 Re-Secure Agents from the OMS Side

\`\`\`bash
# Re-secure all agents from the OMS host (batch approach for large environments)
$OMS_HOME/bin/emcli login -username=sysman -password=<sysman_password>

# List all agent targets
$OMS_HOME/bin/emcli get_targets -targets="oracle_emd"

# Re-secure a specific agent
$OMS_HOME/bin/emcli secure_agent \
  -agent_name="<agenthost>:<agentport>" \
  -registration_password=<reg_password>
\`\`\`

### 7.2 Re-Secure Agents from the Agent Side

On each agent host:

\`\`\`bash
source $AGENT_HOME/bin/envvar.sh

# Stop the agent
$AGENT_HOME/bin/emctl stop agent

# Re-secure the agent against the OMS (this downloads the new CA from OMS)
$AGENT_HOME/bin/emctl secure agent -reg_password <agent_registration_password>

# Start the agent
$AGENT_HOME/bin/emctl start agent

# Verify connectivity to OMS
$AGENT_HOME/bin/emctl status agent
$AGENT_HOME/bin/emctl ping oms
\`\`\`

Expected output from \`emctl ping oms\`:
\`\`\`
EMD ping completed successfully
\`\`\`

### 7.3 Bulk Agent Re-Securitization Script

For environments with many agents, use this script on each agent host:

\`\`\`bash
#!/bin/bash
# run_on_each_agent.sh
AGENT_HOME=/u01/app/oracle/agent13c/agent_inst
REG_PWD="<agent_registration_password>"

source \${AGENT_HOME}/../agent_13.5.0.0.0/bin/envvar.sh

emctl stop agent
sleep 10
emctl secure agent -reg_password "\${REG_PWD}"
sleep 5
emctl start agent
sleep 30
emctl ping oms
\`\`\`

---

## Phase 8: Internal CA Certificate Import (Enterprise PKI Path)

If your organization uses an internal CA (Microsoft ADCS, HashiCorp Vault, EJBCA, or OpenSSL-based), use this procedure instead of the self-signed emctl path.

### 8.1 Generate OMS Private Key and CSR

\`\`\`bash
OEM_HOST=$(hostname -f)
CERT_DIR=$OMS_HOME/sysman/config/custom_certs
mkdir -p \${CERT_DIR}

# Generate 2048-bit RSA private key
openssl genrsa -out \${CERT_DIR}/oms.key 2048

# Generate CSR with SAN entries for all DNS names and IPs used to reach OMS
openssl req -new \
  -key \${CERT_DIR}/oms.key \
  -out \${CERT_DIR}/oms.csr \
  -subj "/CN=\${OEM_HOST}/O=YourOrg/OU=IT Operations/C=US" \
  -config <(cat /etc/ssl/openssl.cnf; printf "\n[SAN]\\nsubjectAltName=DNS:\${OEM_HOST},IP:$(hostname -i)")
\`\`\`

### 8.2 Sign with Internal CA (OpenSSL CA Example)

If you operate your own OpenSSL-based internal CA:

\`\`\`bash
# On the CA host
openssl ca \
  -config /etc/ssl/ca/openssl-ca.cnf \
  -policy policy_anything \
  -extensions server_cert \
  -days 730 \
  -notext \
  -in /tmp/oms.csr \
  -out /tmp/oms_signed.crt

# Bundle the signed cert with the CA chain
cat /tmp/oms_signed.crt /etc/ssl/ca/ca_chain.pem > /tmp/oms_full_chain.pem
\`\`\`

### 8.3 Create and Populate the OEM Wallet with the Signed Certificate

\`\`\`bash
# Back up existing wallet
cp -rp $OMS_HOME/sysman/config/monwallet \
       $OMS_HOME/sysman/config/monwallet.backup.$(date +%Y%m%d)

# Create a new wallet
orapki wallet create \
  -wallet \${CERT_DIR}/new_monwallet \
  -auto_login

# Import the CA certificate (trust anchor)
orapki wallet add \
  -wallet \${CERT_DIR}/new_monwallet \
  -trusted_cert \
  -cert /tmp/internal_ca.crt \
  -auto_login_only

# Import any intermediate CAs
orapki wallet add \
  -wallet \${CERT_DIR}/new_monwallet \
  -trusted_cert \
  -cert /tmp/intermediate_ca.crt \
  -auto_login_only

# Import the signed OMS certificate + private key
# First, create a PKCS12 bundle
openssl pkcs12 -export \
  -in /tmp/oms_signed.crt \
  -inkey \${CERT_DIR}/oms.key \
  -certfile /tmp/internal_ca.crt \
  -out /tmp/oms.p12 \
  -passout pass:changeit

# Import the PKCS12 into the wallet
orapki wallet import_pkcs12 \
  -wallet \${CERT_DIR}/new_monwallet \
  -pkcs12file /tmp/oms.p12 \
  -pkcs12pwd changeit \
  -auto_login_only

# Verify wallet contents
orapki wallet display -wallet \${CERT_DIR}/new_monwallet

# Replace production wallet
cp -rp \${CERT_DIR}/new_monwallet/* $OMS_HOME/sysman/config/monwallet/
\`\`\`

---

## Phase 9: Post-Renewal Verification

### 9.1 Full Certificate Check

\`\`\`bash
OEM_HOST=$(hostname -f)

for PORT in 7799 1159; do
  echo "--- Port \${PORT} ---"
  echo | openssl s_client -connect \${OEM_HOST}:\${PORT} 2>/dev/null | \
    openssl x509 -noout -subject -issuer -dates
  echo ""
done

# Verify OMS wallet shows valid (non-expired) CA
orapki wallet display -wallet $OMS_HOME/sysman/config/monwallet | \
  grep -A5 "Certificate:"
\`\`\`

### 9.2 Confirm OMS Is Fully Up

\`\`\`bash
$OMS_HOME/bin/emctl status oms -details
\`\`\`

Look for:
\`\`\`
Oracle Management Service is Up
JVMD Engine is Up
\`\`\`

### 9.3 Confirm Agents Are Connected

\`\`\`sql
-- Query the OEM repository for agent status (as SYSMAN)
SELECT target_name,
       target_type,
       availability_status,
       last_status_update_time
FROM   mgmt_targets
WHERE  target_type = 'oracle_emd'
AND    availability_status != 'Target Up'
ORDER  BY last_status_update_time DESC;
\`\`\`

Agents that remain disconnected after 15 minutes need manual re-securitization per Phase 7.

### 9.4 Set Up Certificate Expiration Monitoring

\`\`\`bash
# Add to crontab for the oracle OS user (runs first of each month)
(crontab -l 2>/dev/null; echo "0 8 1 * * /u01/scripts/check_oem_certs.sh") | crontab -

cat > /u01/scripts/check_oem_certs.sh <<'SCRIPT'
#!/bin/bash
OEM_HOST="oemcc.example.com"
WARN_DAYS=90
ALERT_EMAIL="dba-team@example.com"
SUBJECT_PREFIX="[OEM CERT ALERT]"

for PORT in 7799 1159; do
  EXPIRY=$(echo | openssl s_client -connect \${OEM_HOST}:\${PORT} 2>/dev/null | \
    openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)

  if [ -z "$EXPIRY" ]; then
    echo "\${SUBJECT_PREFIX} Port \${PORT} certificate UNREADABLE" | \
      mail -s "\${SUBJECT_PREFIX} \${OEM_HOST}:\${PORT} cert error" \${ALERT_EMAIL}
    continue
  fi

  EXPIRY_EPOCH=$(date -d "\${EXPIRY}" +%s 2>/dev/null)
  NOW_EPOCH=$(date +%s)
  DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))

  if [ \${DAYS_LEFT} -lt \${WARN_DAYS} ]; then
    echo "OEM certificate on \${OEM_HOST}:\${PORT} expires in \${DAYS_LEFT} days (\${EXPIRY})." | \
      mail -s "\${SUBJECT_PREFIX} \${PORT} expires in \${DAYS_LEFT} days" \${ALERT_EMAIL}
  fi
done
SCRIPT

chmod +x /u01/scripts/check_oem_certs.sh
\`\`\`

---

## Summary and Renewal Sequence Reference

| Phase | Action | Command | Prerequisite |
|-------|--------|---------|-------------|
| 1 | Assess expiration | openssl s_client + orapki | None |
| 2 | Stop OMS | emctl stop oms -all | None |
| 3 | Start WebLogic only | emctl start oms -admin_only | OMS stopped |
| 4 | Renew CA + Upload cert | emctl secure oms | WebLogic on port 7101 |
| 5 | Renew Console cert | emctl secure console -self_signed | None (independent) |
| 6 | Full OMS restart | emctl stop oms -all; emctl start oms | Phases 4 and 5 complete |
| 7 | Re-secure agents | emctl secure agent on each agent | OMS fully started |
| 8 | Import internal CA cert | orapki wallet add | Internal CA cert available |
| 9 | Verify and monitor | openssl s_client + monitoring cron | Phases 6-7 complete |

**The single most important lesson from this scenario:** \`emctl secure oms\` requires WebLogic Admin Server on port 7101 to be running. The error message ("Connection refused to t3s://oemhost:7101") is a WebLogic connectivity error, not a certificate error. Start WebLogic first with \`emctl start oms -admin_only\`, confirm port 7101 is listening, then run \`emctl secure oms\`.`,
};

async function main() {
  console.log('Inserting OEM certificate management runbook...');
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
