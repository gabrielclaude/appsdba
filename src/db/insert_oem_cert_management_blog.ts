import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'OEM 13c Certificate Management: Internal CA, Certificate Renewal, and the WebLogic Dependency',
  slug: 'oem-13c-certificate-management-internal-ca-renewal',
  excerpt:
    'Oracle Enterprise Manager 13c ships with self-signed certificates that expire after ten years. When the CA certificate expires alongside the console and upload certificates, the standard emctl secure oms command fails with a WebLogic JMX connection error — not because the procedure is wrong, but because the WebLogic Admin Server must be running before emctl secure oms can execute. This guide covers the OEM certificate hierarchy, creating an internal CA, and the correct renewal sequence.',
  category: 'oracle-security' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-17'),
  youtubeUrl: null,
  content: `## Introduction

Oracle Enterprise Manager Cloud Control 13c (OEMCC) ships with a self-signed internal CA and a set of certificates it generates from that CA at installation time. Those certificates carry a ten-year validity period — long enough that most organizations install OEM, secure it, and then forget the certificates exist until the day everything expires simultaneously and the console becomes inaccessible.

When that day arrives, the failure is disorienting. The HTTPS console on port 7799 shows a certificate error. The upload service on port 1159 refuses agent connections. A telnet or openssl test confirms the certificates expired. You run the documented renewal command — \`emctl secure oms\` — and it fails immediately with a Java WebLogic JMX connection error to port 7101. The frustration is compounded because the console certificate can be renewed with a separate command, creating the impression that the OMS renewal is broken when in fact the issue is a sequencing dependency.

This guide covers the OEM 13c certificate architecture, how to create an internal CA for enterprise environments that need certificates with enterprise-controlled roots, and the correct renewal sequence when all certificates expire at once.

---

## OEM 13c Certificate Architecture

Oracle Enterprise Manager 13c uses certificates at three distinct layers:

**The OEM Certificate Authority (CA)**

At installation, OEM generates a self-signed root CA stored in the OMS wallet. This CA is the trust anchor for all other OEM certificates. Its subject typically looks like:

\`\`\`
/O=EnterpriseManager on <oemhost>/OU=EnterpriseManager on <oemhost>/CN=<oemhost>
\`\`\`

All other OEM certificates are signed by this CA. When the CA certificate expires, every certificate it signed is implicitly invalid even if those leaf certificates have not individually expired — because the chain of trust is broken at the root.

**The OMS Certificates**

The OMS (Oracle Management Service) holds two certificates signed by the internal CA:
- **Console certificate**: Secures HTTPS traffic on port 7799 (the EM Cloud Control web UI)
- **Upload certificate**: Secures HTTPS traffic on port 1159 (the agent-to-OMS upload channel)

Both are stored in the OMS wallet directory (typically \`$OMS_HOME/sysman/config/\`). They share the same CN as the OMS hostname but serve different ports and can have different expiration dates.

**Agent Certificates**

Each OEM agent has its own certificate signed by the OMS CA. Agent certificates are typically renewed automatically when the agent re-registers with the OMS, but if the OMS CA has expired, new agent registrations fail because agents cannot validate a CA that is itself expired.

### Port Reference

| Port | Service | Certificate |
|------|---------|-------------|
| 7799 | HTTPS Console (EM UI) | OMS Console cert, signed by OEM CA |
| 1159 | HTTPS Upload (Agent channel) | OMS Upload cert, signed by OEM CA |
| 7101 | WebLogic Admin Server (internal) | WebLogic keystore cert |
| 4889 | Agent HTTPS | Agent cert, signed by OEM CA |
| 3872 | Agent (alternate) | Agent cert, signed by OEM CA |

---

## Checking Certificate Expiration

Before starting any renewal procedure, establish the exact expiration dates for each component. This determines the order of urgency and whether the CA itself has expired (which changes the renewal sequence significantly).

### Check the Console Certificate (Port 7799)

\`\`\`bash
echo | openssl s_client -connect <oemhost>:7799 2>/dev/null | \
  openssl x509 -noout -subject -issuer -dates
\`\`\`

### Check the Upload Certificate (Port 1159)

\`\`\`bash
echo | openssl s_client -connect <oemhost>:1159 2>/dev/null | \
  openssl x509 -noout -subject -issuer -dates
\`\`\`

### Check the OEM CA Directly from the Wallet

\`\`\`bash
# On the OMS host, as the oracle OS user
source $OMS_HOME/bin/envvar.sh   # or equivalent environment setup

$OMS_HOME/bin/emctl status oms -details

# Check wallet contents
orapki wallet display -wallet $OMS_HOME/sysman/config/monwallet
orapki wallet display -wallet $OMS_HOME/sysman/config/bip/config/keystores/emgc.jks
\`\`\`

The output will show each certificate's subject, issuer, and validity period. Look for the certificate with the CA issuer — if its \`notAfter\` date has passed, you are in the "CA expired" scenario, which requires the full renewal sequence.

---

## Why emctl secure oms Fails When WebLogic Is Down

The most common diagnostic confusion when all OEM certificates expire at once is the failure of \`emctl secure oms\`. The error looks like this:

\`\`\`
2026-06-17 00:23:23,210 [main] ERROR oms.SecureOMSCmds processSecureOMS - Securing of OMS failed:
java.io.IOException
Caused by: javax.naming.CommunicationException:
  t3s://oemhost:7101: Destination unreachable;
  Connection refused; No available router to destination
\`\`\`

This error has nothing to do with the certificate files being missing or corrupted. The \`emctl secure oms\` command connects to the WebLogic Admin Server via the T3S protocol on port 7101 to update the WebLogic keystore as part of the OMS re-securitization. If the WebLogic Admin Server is not running — or if the existing expired certificates prevent the T3S TLS handshake from completing — the command fails before it can make any certificate changes.

The fix is not to re-run \`emctl secure oms\` repeatedly. The fix is to start the WebLogic Admin Server independently, confirm it is listening on port 7101, and then run \`emctl secure oms\`.

This is the sequencing dependency that catches most administrators:

\`\`\`
WRONG sequence:
  1. Run emctl secure oms → FAILS (WebLogic not running)
  2. Run emctl secure console → Works (different command, no WebLogic dependency)
  3. Conclude emctl secure oms is broken → Incorrect

CORRECT sequence:
  1. Start WebLogic Admin Server (nmConnect + startServer or wlst.sh)
  2. Confirm port 7101 is listening
  3. Run emctl secure oms → Works
  4. Run emctl secure console
  5. Restart OMS
  6. Re-secure agents
\`\`\`

---

## The Self-Signed Renewal Path

For environments that are comfortable with OEM's built-in self-signed certificates (the default for most internal deployments), renewal uses emctl commands. The self-signed path regenerates the OEM CA and all dependent certificates from scratch.

### Console Certificate Renewal (No WebLogic Dependency)

\`\`\`bash
$OMS_HOME/bin/emctl secure console -self_signed -sysman_pwd <sysman_password>
\`\`\`

This command renews only the console certificate. It does not require WebLogic to be running and can succeed even when the CA has expired, because it generates a new self-signed certificate independent of the CA chain. This is why organizations often renew the console first and then discover that \`emctl secure oms\` fails separately.

### Full OMS Re-Securitization (Requires WebLogic)

\`\`\`bash
# Step 1 — Start WebLogic Admin Server if not running
$OMS_HOME/bin/emctl start oms -admin_only

# Step 2 — Confirm WebLogic is listening on port 7101
netstat -tlnp | grep 7101

# Step 3 — Secure the OMS (regenerates CA, upload cert, and updates WebLogic keystores)
$OMS_HOME/bin/emctl secure oms -sysman_pwd <sysman_password> \
  -reg_pwd <agent_registration_password>

# Step 4 — Restart OMS fully
$OMS_HOME/bin/emctl stop oms -all
$OMS_HOME/bin/emctl start oms
\`\`\`

---

## Creating an Internal CA for OEM (Enterprise Approach)

The self-signed OEM CA has two organizational problems: it is not trusted by browsers (requiring manual certificate exception installation for every user), and it is not managed through the organization's PKI lifecycle processes. For enterprises with an internal PKI, the better approach is to sign OEM certificates with an organization-controlled CA.

### Generate the OEM Key and CSR

On the OMS host:

\`\`\`bash
# Create a private key for the OMS certificate
openssl genrsa -out $OMS_HOME/sysman/config/oms_server.key 2048

# Generate a Certificate Signing Request
openssl req -new \
  -key $OMS_HOME/sysman/config/oms_server.key \
  -out $OMS_HOME/sysman/config/oms_server.csr \
  -subj "/CN=<oemhost>/O=<YourOrg>/OU=IT/C=US" \
  -reqexts SAN \
  -config <(cat /etc/ssl/openssl.cnf <(printf "\n[SAN]\\nsubjectAltName=DNS:<oemhost>,DNS:<oemhost_fqdn>,IP:<oemhost_ip>"))
\`\`\`

### Submit to Internal CA

Send \`oms_server.csr\` to your internal CA team. They sign it and return a certificate (\`oms_server.crt\`) plus the CA chain (\`ca_chain.pem\`). Specify:
- Key usage: Digital Signature, Key Encipherment
- Extended key usage: Server Authentication (1.3.6.1.5.5.7.3.1)
- SAN entries: all DNS names and IPs that OEM agents and browsers will use to reach this host
- Validity: 2 years maximum (do not repeat the 10-year mistake)

### Import the Signed Certificate into the OMS Wallet

\`\`\`bash
# Import the CA chain into the OMS wallet first (trust anchor)
orapki wallet add \
  -wallet $OMS_HOME/sysman/config/monwallet \
  -trusted_cert -cert ca_chain.pem -auto_login_only

# Import the signed OMS certificate
orapki wallet add \
  -wallet $OMS_HOME/sysman/config/monwallet \
  -user_cert -cert oms_server.crt -auto_login_only

# Verify the wallet
orapki wallet display -wallet $OMS_HOME/sysman/config/monwallet
\`\`\`

---

## Preventing Future Certificate Expiration

The ten-year self-signed certificate trap is avoidable. Two controls prevent it:

**1. OEM Certificate Expiration Alert**

Create an OEM metric threshold alert against the \`oracle_emrep\` target type for certificate expiration. OEM 13c includes a built-in metric (available in 13.5 and later) for OMS certificate days-to-expiry. Set a warning threshold at 90 days and a critical threshold at 30 days.

**2. External openssl Monitoring (For Older OEM Versions)**

Schedule a cron job on the OMS host that checks certificate expiration and sends an alert email:

\`\`\`bash
#!/bin/bash
# /etc/cron.monthly/check_oem_certs.sh

OEM_HOST="oemcc.example.com"
WARN_DAYS=90
ALERT_EMAIL="dba-team@example.com"

for PORT in 7799 1159; do
  EXPIRY=$(echo | openssl s_client -connect \${OEM_HOST}:\${PORT} 2>/dev/null | \
    openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  EXPIRY_EPOCH=$(date -d "\${EXPIRY}" +%s)
  NOW_EPOCH=$(date +%s)
  DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))

  if [ \${DAYS_LEFT} -lt \${WARN_DAYS} ]; then
    echo "OEM certificate on port \${PORT} expires in \${DAYS_LEFT} days (\${EXPIRY})" | \
      mail -s "OEM CERT WARNING: \${PORT} expiring soon" \${ALERT_EMAIL}
  fi
done
\`\`\`

---

## Summary

Oracle Enterprise Manager 13c certificate failures follow a predictable pattern when the ten-year self-signed certificates expire: the console becomes inaccessible, agent uploads fail, and the standard renewal command (\`emctl secure oms\`) produces a misleading WebLogic connection error. The connection error is not a certificate problem — it is a sequencing problem. The WebLogic Admin Server must be running on port 7101 before \`emctl secure oms\` can execute, and when all certificates are expired simultaneously, WebLogic may not start cleanly on its own.

The console certificate can be renewed independently with \`emctl secure console -self_signed\`, which does not require WebLogic. The OMS CA and upload certificate require the full \`emctl secure oms\` path, which requires WebLogic Admin Server to be started first with \`emctl start oms -admin_only\`.

For enterprises that want browser-trusted certificates and PKI lifecycle management, replacing the self-signed CA with an internally controlled CA eliminates both the browser warning problem and the operational surprise of a single-day mass expiration. The companion runbook covers the complete renewal procedure for the expired CA scenario, the WebLogic Admin Server startup verification steps, the full emctl command sequence, agent re-registration, and post-renewal verification queries.`,
};

async function main() {
  console.log('Inserting OEM certificate management blog post...');
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
