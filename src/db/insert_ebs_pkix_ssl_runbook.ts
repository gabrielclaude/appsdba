import { config } from 'dotenv';
config({ path: '.env.local' });
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'EBS 12.2 Outbound SOAP PKIX SSL Runbook: Certificate Import, AutoConfig Persistence, and Endpoint Monitoring',
  slug: 'ebs-outbound-soap-pkix-ssl-truststore-runbook',
  excerpt:
    'Premium operational runbook for resolving Oracle EBS 12.2 outbound SOAP SSLHandshakeException PKIX failures. Covers root-cause confirmation via FND log SQL, all JDK truststore locations in an EBS landscape, certificate chain extraction scripts, keytool import for both FMW and RDBMS JDKs, AutoConfig persistence via txkSetContextEV.sh, pre-restart TLS verification, service bounce procedure, a complete endpoint monitoring script, and a post-fix validation matrix.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-17'),
  youtubeUrl: null,
  content: `## Purpose and Scope

This runbook provides step-by-step procedures for diagnosing and resolving \`javax.net.ssl.SSLHandshakeException: PKIX path building failed\` errors on outbound SOAP calls from Oracle E-Business Suite 12.2.

It covers all JVM tiers in a typical EBS 12.2 installation — WebLogic Managed Servers and the Concurrent Processing tier — and ensures that every fix survives the next AutoConfig run.

**Reference post:** [Oracle EBS 12.2 Outbound SOAP SSLHandshakeException: Fixing PKIX Path Validation Failures](/posts/ebs-12-2-outbound-soap-pkix-ssl-truststore-fix)

---

## Environment Variables

Set these shell variables before running any command in this runbook. All subsequent commands reference them by name.

\`\`\`bash
# EBS application tier environment — source from the EBS environment script first
source /u01/oracle/apps/EBSapps.env run

# Middleware home (contains WebLogic, OHS, FMW Oracle Common JDK)
export FMW_HOME=/u01/oracle/apps/fs1/FMW_Home

# WebLogic domain home
export DOMAIN_HOME=/u01/oracle/apps/fs1/FMW_Home/user_projects/domains/EBS_domain_ebsdb

# RDBMS Oracle home (contains the JDK used by concurrent manager Java programs)
export ORACLE_HOME=/u01/oracle/db/tech_st/19.0.0

# EBS admin scripts home
export ADMIN_SCRIPTS_HOME=/u01/oracle/apps/fs1/inst/apps/ebsdb_apphost/appl/admin/scripts

# EBS context file (adjust SID and hostname for your installation)
export CONTEXT_FILE=/u01/oracle/apps/fs1/inst/apps/ebsdb_apphost/appl/admin/ebsdb_apphost.xml

# FMW JDK (used by WebLogic managed servers)
export FMW_JDK=\${FMW_HOME}/oracle_common/jdk
export FMW_CACERTS=\${FMW_JDK}/jre/lib/security/cacerts

# RDBMS JDK (used by Concurrent Manager Java concurrent programs)
export RDBMS_JDK=\${ORACLE_HOME}/jdk
export RDBMS_CACERTS=\${RDBMS_JDK}/jre/lib/security/cacerts

# Default keystore password (change if your site has customised this)
export KS_PASS=changeit
\`\`\`

---

## Phase 1 — Confirm PKIX Is the Root Cause

Before touching any certificate or truststore, confirm that the error is definitively a PKIX trust failure and not a different SSL problem (certificate hostname mismatch, expired leaf certificate, connection timeout).

### 1.1 Query FND Log for SSL Exceptions

\`\`\`sql
-- Find failing concurrent requests with SSL errors in the last 24 hours
SELECT fcr.request_id,
       fcr.concurrent_program_name,
       fcr.argument_text,
       fcr.logfile_name,
       flt.message_text
FROM fnd_concurrent_requests fcr
JOIN fnd_log_messages flt
  ON flt.module LIKE '%' || fcr.concurrent_program_name || '%'
WHERE fcr.phase_code  = 'C'
  AND fcr.status_code = 'E'
  AND flt.message_text LIKE '%SSLHandshakeException%'
  AND fcr.actual_completion_date > SYSDATE - 1
ORDER BY fcr.actual_completion_date DESC;

-- Narrow to PKIX specifically
SELECT flt.timestamp,
       flt.module,
       flt.message_text
FROM fnd_log_messages flt
WHERE flt.message_text LIKE '%PKIX%'
   OR flt.message_text LIKE '%SunCertPathBuilder%'
   OR flt.message_text LIKE '%unable to find valid certification path%'
ORDER BY flt.timestamp DESC
FETCH FIRST 50 ROWS ONLY;
\`\`\`

A result containing \`PKIX path building failed\` or \`SunCertPathBuilderException\` confirms the trust failure. Note the failing endpoint hostname from the \`argument_text\` or from the full message text.

### 1.2 Scan WLS Managed Server Logs for PKIX Errors

Run from the EBS application tier OS as the Oracle software owner:

\`\`\`bash
# Search all managed server log files for PKIX / SSL handshake errors (last 24h)
grep -rl "PKIX\|SSLHandshakeException\|SunCertPathBuilder" \
  \${DOMAIN_HOME}/servers/*/logs/ 2>/dev/null

# Show the context lines around the error in the matching files
grep -r "PKIX\|SSLHandshakeException\|SunCertPathBuilder" \
  \${DOMAIN_HOME}/servers/*/logs/*.log 2>/dev/null \
  | head -30
\`\`\`

### 1.3 Determine the Failing Endpoint Hostname

Extract the remote host from the error message or from the integration configuration:

\`\`\`bash
# The PKIX error usually names the host in the stack trace
grep -r "SSLHandshakeException" \${DOMAIN_HOME}/servers/*/logs/*.log 2>/dev/null \
  | grep -oE "[a-zA-Z0-9._-]+\.(com|net|org|io|gov|co\.[a-z]{2})" \
  | sort -u
\`\`\`

Record the hostname — it is used in every subsequent step.

---

## Phase 2 — Identify All JDK Truststore Locations

\`\`\`bash
#!/bin/bash
# Enumerate all JDKs in use by EBS components and their cacerts paths

echo "=== EBS JDK Truststore Locations ==="
echo ""

# FMW JDK (WebLogic managed servers: oacore, oafm, forms-c4ws, oaea)
FMW_JDK_REAL=\$(readlink -f \${FMW_HOME}/oracle_common/jdk 2>/dev/null || echo "NOT FOUND")
echo "FMW JDK path  : \${FMW_JDK_REAL}"
echo "FMW cacerts   : \${FMW_JDK_REAL}/jre/lib/security/cacerts"
if [ -f "\${FMW_JDK_REAL}/jre/lib/security/cacerts" ]; then
  echo "FMW cacerts exists: YES"
  ls -lh "\${FMW_JDK_REAL}/jre/lib/security/cacerts"
else
  echo "FMW cacerts exists: NO — check FMW_HOME"
fi

echo ""

# RDBMS JDK (Concurrent Manager Java concurrent programs)
RDBMS_JDK_REAL=\$(readlink -f \${ORACLE_HOME}/jdk 2>/dev/null || echo "NOT FOUND")
echo "RDBMS JDK path: \${RDBMS_JDK_REAL}"
echo "RDBMS cacerts : \${RDBMS_JDK_REAL}/jre/lib/security/cacerts"
if [ -f "\${RDBMS_JDK_REAL}/jre/lib/security/cacerts" ]; then
  echo "RDBMS cacerts exists: YES"
  ls -lh "\${RDBMS_JDK_REAL}/jre/lib/security/cacerts"
else
  echo "RDBMS cacerts exists: NO — check ORACLE_HOME"
fi

echo ""
echo "=== Custom Truststore JVM Arguments (check for -Djavax.net.ssl.trustStore) ==="
grep -r "trustStore" \${DOMAIN_HOME}/config/config.xml 2>/dev/null | head -20
grep -r "trustStore" \${ADMIN_SCRIPTS_HOME}/*.sh 2>/dev/null | head -10
grep -r "trustStore" \${DOMAIN_HOME}/bin/ 2>/dev/null | head -10
\`\`\`

**Decision point:** If \`-Djavax.net.ssl.trustStore\` points to a custom file, all imports go into that file. If no custom truststore is found, import into \`\${FMW_CACERTS}\` and \`\${RDBMS_CACERTS}\`.

---

## Phase 3 — Extract the Remote Certificate Chain

\`\`\`bash
#!/bin/bash
# Usage: ./extract_certs.sh <host> [port]
# Example: ./extract_certs.sh external-api.example.com 443

HOST=\${1:-"external-api.example.com"}
PORT=\${2:-443}
CERT_DIR="/tmp/ssl_certs_\$(date +%Y%m%d_%H%M%S)"
mkdir -p "\${CERT_DIR}"

echo "Connecting to \${HOST}:\${PORT} — extracting certificate chain..."
echo "Output directory: \${CERT_DIR}"
echo ""

# Retrieve the full chain presented by the server
openssl s_client -connect "\${HOST}:\${PORT}" -showcerts 2>/dev/null \
  > "\${CERT_DIR}/full_chain.pem"

# Count the certificates in the chain
CERT_COUNT=\$(grep -c "BEGIN CERTIFICATE" "\${CERT_DIR}/full_chain.pem")
echo "Certificates in chain: \${CERT_COUNT}"
echo ""

# Split the chain into individual files
# Each file: cert_01.pem (leaf), cert_02.pem (intermediate), cert_03.pem (root)
csplit -z -f "\${CERT_DIR}/cert_" -b "%02d.pem" \
  "\${CERT_DIR}/full_chain.pem" \
  '/-----BEGIN CERTIFICATE-----/' '{*}' 2>/dev/null

echo "=== Certificate Chain Details ==="
for cert in "\${CERT_DIR}"/cert_*.pem; do
  echo "--- \${cert} ---"
  openssl x509 -in "\${cert}" -noout -subject -issuer -dates 2>/dev/null
  # Flag self-signed (root): Subject == Issuer
  SUBJ=\$(openssl x509 -in "\${cert}" -noout -subject 2>/dev/null)
  ISSR=\$(openssl x509 -in "\${cert}" -noout -issuer  2>/dev/null)
  if [ "\${SUBJ}" = "\${ISSR}" ]; then
    echo "  *** This is the ROOT CA (self-signed) — import this into cacerts ***"
  fi
  echo ""
done

LAST_CERT=\$(ls "\${CERT_DIR}"/cert_*.pem | tail -1)
echo "=== Import Commands ==="
echo "Root CA to import: \${LAST_CERT}"
echo ""
echo "FMW cacerts import:"
echo "  \${FMW_JDK}/bin/keytool -importcert -trustcacerts -noprompt \\"
echo "    -file \${LAST_CERT} -alias vendor_root_ca \\"
echo "    -keystore \${FMW_CACERTS} -storepass \${KS_PASS}"
\`\`\`

Save this as \`/u01/oracle/scripts/extract_certs.sh\` and make it executable:

\`\`\`bash
chmod +x /u01/oracle/scripts/extract_certs.sh
/u01/oracle/scripts/extract_certs.sh external-api.example.com 443
\`\`\`

---

## Phase 4 — Import Certificates into All Affected Keystores

\`\`\`bash
#!/bin/bash
# Usage: ./import_certs.sh <cert_dir> [alias_prefix]
# Example: ./import_certs.sh /tmp/ssl_certs_20260617_083012 vendor_endpoint

CERT_DIR=\${1:-"/tmp/ssl_certs"}
ALIAS_PREFIX=\${2:-"vendor_endpoint"}

if [ ! -d "\${CERT_DIR}" ]; then
  echo "ERROR: Certificate directory not found: \${CERT_DIR}"
  exit 1
fi

BACKUP_DATE=\$(date +%Y%m%d_%H%M%S)

echo "=== Phase 4: Importing Certificates ==="
echo "Certificate directory : \${CERT_DIR}"
echo "Alias prefix          : \${ALIAS_PREFIX}"
echo "Backup suffix         : \${BACKUP_DATE}"
echo ""

# --- Step 4.1: Backup both keystores before any modification ---
for KS in "\${FMW_CACERTS}" "\${RDBMS_CACERTS}"; do
  if [ -f "\${KS}" ]; then
    cp "\${KS}" "\${KS}.bak_\${BACKUP_DATE}"
    echo "Backed up: \${KS}.bak_\${BACKUP_DATE}"
  else
    echo "WARNING: Keystore not found (skipping backup): \${KS}"
  fi
done
echo ""

# --- Step 4.2: Import into FMW JDK cacerts (WebLogic managed servers) ---
echo "=== Importing into FMW cacerts: \${FMW_CACERTS} ==="
idx=0
for cert in "\${CERT_DIR}"/cert_*.pem; do
  idx=\$((idx + 1))
  alias="\${ALIAS_PREFIX}_cert\${idx}"
  echo "  Importing \${cert} as alias '\${alias}'..."
  "\${FMW_JDK}/bin/keytool" -importcert -trustcacerts -noprompt \
    -file "\${cert}" \
    -alias "\${alias}" \
    -keystore "\${FMW_CACERTS}" \
    -storepass "\${KS_PASS}" 2>&1 | grep -v "^$"
done
echo ""

# --- Step 4.3: Import into RDBMS JDK cacerts (Concurrent Manager Java programs) ---
echo "=== Importing into RDBMS cacerts: \${RDBMS_CACERTS} ==="
idx=0
for cert in "\${CERT_DIR}"/cert_*.pem; do
  idx=\$((idx + 1))
  alias="\${ALIAS_PREFIX}_rdbms_cert\${idx}"
  echo "  Importing \${cert} as alias '\${alias}'..."
  "\${RDBMS_JDK}/bin/keytool" -importcert -trustcacerts -noprompt \
    -file "\${cert}" \
    -alias "\${alias}" \
    -keystore "\${RDBMS_CACERTS}" \
    -storepass "\${KS_PASS}" 2>&1 | grep -v "^$"
done
echo ""

echo "=== Import Complete ==="
echo "Verify FMW import:"
echo "  \${FMW_JDK}/bin/keytool -list -v -keystore \${FMW_CACERTS} -storepass \${KS_PASS} | grep -A4 '\${ALIAS_PREFIX}'"
echo ""
echo "Verify RDBMS import:"
echo "  \${RDBMS_JDK}/bin/keytool -list -v -keystore \${RDBMS_CACERTS} -storepass \${KS_PASS} | grep -A4 '\${ALIAS_PREFIX}'"
\`\`\`

Save as \`/u01/oracle/scripts/import_certs.sh\`, make executable, and run:

\`\`\`bash
chmod +x /u01/oracle/scripts/import_certs.sh
/u01/oracle/scripts/import_certs.sh /tmp/ssl_certs_20260617_083012 vendor_endpoint
\`\`\`

### Verify the Imports

\`\`\`bash
# FMW cacerts — list all vendor_endpoint aliases
"\${FMW_JDK}/bin/keytool" -list -v \
  -keystore "\${FMW_CACERTS}" \
  -storepass "\${KS_PASS}" \
  | grep -A 6 "vendor_endpoint"

# RDBMS cacerts — list all vendor_endpoint_rdbms aliases
"\${RDBMS_JDK}/bin/keytool" -list -v \
  -keystore "\${RDBMS_CACERTS}" \
  -storepass "\${KS_PASS}" \
  | grep -A 6 "vendor_endpoint_rdbms"
\`\`\`

Each alias should show \`Entry type: trustedCertEntry\` with the correct subject and a validity date that is current and future.

---

## Phase 5 — Persist the Truststore Path Through AutoConfig

This phase applies **only** if a custom truststore path is being used (i.e., \`-Djavax.net.ssl.trustStore\` is configured). If you are importing into the default \`\$JAVA_HOME/jre/lib/security/cacerts\` with no custom path, skip to Phase 6.

### 5.1 Determine Whether a Custom Path Is in Use

\`\`\`bash
# Check running WLS processes for -Djavax.net.ssl.trustStore
ps -ef | grep -E "java.*oacore|java.*oafm" | grep trustStore

# Check the WLS domain config.xml
grep -i "trustStore" "\${DOMAIN_HOME}/config/config.xml" | head -10
\`\`\`

### 5.2 Persist the Custom Truststore via txkSetContextEV.sh

\`\`\`bash
# Method 1: txkSetContextEV.sh (preferred — EBS 12.2 R12.AD.C.Delta.9 and later)
# Adjust the path and password to match your custom truststore location
\${FND_TOP}/bin/txkSetContextEV.sh \
  -contextfile="\${CONTEXT_FILE}" \
  -evname=s_wls_java_options \
  -evvalue="-Djavax.net.ssl.trustStore=/u01/oracle/custom_cacerts -Djavax.net.ssl.trustStorePassword=changeit"

# Verify the context file was updated
grep -A 2 "trustStore" "\${CONTEXT_FILE}"
\`\`\`

\`\`\`bash
# Method 2: Direct context file edit (use only if txkSetContextEV.sh is unavailable)
# Back up the context file first
cp "\${CONTEXT_FILE}" "\${CONTEXT_FILE}.bak_\$(date +%Y%m%d_%H%M%S)"

# Then manually edit $CONTEXT_FILE to add or update the oa_jvm_options section:
# <oa_jvm_options oa_var="s_oa_jvm_options">
#   -Djavax.net.ssl.trustStore=/u01/oracle/custom_cacerts
#   -Djavax.net.ssl.trustStorePassword=changeit
# </oa_jvm_options>
\`\`\`

### 5.3 Run AutoConfig to Propagate the Change

\`\`\`bash
# Run AutoConfig (this regenerates WLS config files from the updated context file)
\${ADMIN_SCRIPTS_HOME}/adautocfg.sh apps/<apps_password>

# Monitor the AutoConfig log for errors
tail -50 \${INST_TOP}/admin/log/adautocfg*.log | grep -E "ERROR|WARNING|completed"
\`\`\`

### 5.4 Verify the WLS Configuration Reflects the Truststore Path

\`\`\`bash
# After AutoConfig, check that config.xml now has the trustStore arg
grep -i "trustStore" "\${DOMAIN_HOME}/config/config.xml"

# Also check the WLS startup scripts
grep -i "trustStore" \${ADMIN_SCRIPTS_HOME}/*.sh 2>/dev/null | head -10
\`\`\`

---

## Phase 6 — Pre-Restart SSL Verification

Verify the TLS handshake succeeds using the updated truststore before cycling services. This confirms the certificate was imported correctly without requiring a service bounce to test.

\`\`\`bash
# Test 1: OpenSSL trust check against the updated FMW cacerts
echo "=== FMW cacerts TLS trust check ==="
openssl s_client -connect external-api.example.com:443 \
  -CAfile "\${FMW_CACERTS}" \
  -verify_return_error 2>&1 \
  | grep -E "Verify return code|subject|issuer|Acceptable client certificate"
# Expected: Verify return code: 0 (ok)

echo ""
echo "=== RDBMS cacerts TLS trust check ==="
openssl s_client -connect external-api.example.com:443 \
  -CAfile "\${RDBMS_CACERTS}" \
  -verify_return_error 2>&1 \
  | grep -E "Verify return code|subject|issuer"
# Expected: Verify return code: 0 (ok)
\`\`\`

\`\`\`bash
# Test 2: Confirm both aliases are present
echo "=== FMW alias check ==="
"\${FMW_JDK}/bin/keytool" -list \
  -keystore "\${FMW_CACERTS}" \
  -storepass "\${KS_PASS}" \
  -alias vendor_endpoint_cert1 2>&1
# Expected: vendor_endpoint_cert1, trustedCertEntry, ...

echo ""
echo "=== RDBMS alias check ==="
"\${RDBMS_JDK}/bin/keytool" -list \
  -keystore "\${RDBMS_CACERTS}" \
  -storepass "\${KS_PASS}" \
  -alias vendor_endpoint_rdbms_cert1 2>&1
\`\`\`

If the \`openssl\` test returns \`Verify return code: 0 (ok)\` but the JVM test still fails after restart, check whether the running JVM process is using a different truststore than the one you updated:

\`\`\`bash
# Check the actual -Djavax.net.ssl.trustStore being used by the running oacore JVM
ps -ef | grep oacore | grep -o "\-Djavax.net.ssl.trustStore=[^ ]*"
\`\`\`

---

## Phase 7 — Service Restart

After confirming the import via OpenSSL, restart all EBS application services to force the JVMs to reload the truststore.

\`\`\`bash
# Stop all EBS application tier services
echo "=== Stopping all EBS application services ==="
\${ADMIN_SCRIPTS_HOME}/adstpall.sh apps/<apps_password>

# Allow time for clean shutdown
sleep 60

# Confirm no lingering managed server processes
echo "=== Checking for lingering Java processes ==="
ps -ef | grep -E "oacore|oafm|forms|AdminServer|FNDLIBR" | grep -v grep

# Start all EBS application tier services
echo "=== Starting all EBS application services ==="
\${ADMIN_SCRIPTS_HOME}/adstrtal.sh apps/<apps_password>

# Monitor the Admin Server startup
echo "=== Monitoring Admin Server startup ==="
tail -f \${DOMAIN_HOME}/servers/AdminServer/logs/AdminServer.log &
TAIL_PID=\$!
sleep 120
kill \${TAIL_PID} 2>/dev/null

# Confirm oacore is running
echo "=== oacore process check ==="
ps -ef | grep oacore | grep -v grep | head -3
\`\`\`

For a targeted restart of only the affected managed server (if you prefer to avoid a full bounce):

1. Log into the WLS Admin Console.
2. Navigate to Environment → Servers.
3. Select the affected managed server (e.g., \`oacore_server1\`).
4. Go to Control → Restart.

A full bounce is still recommended after a truststore change to ensure all JVMs pick up the new certificates — a targeted restart risks leaving other managed servers or the concurrent tier using the old (cached) truststore state.

---

## Phase 8 — Comprehensive Endpoint Monitoring Script

Deploy this script to detect trust failures and expiring certificates before they cause outages. Schedule it weekly via cron.

\`\`\`bash
#!/bin/bash
# /u01/oracle/scripts/check_soap_endpoints.sh
#
# Purpose : Check all EBS outbound SOAP/HTTPS endpoints for:
#           1. TLS trust failure (certificate not trusted by EBS cacerts)
#           2. Certificate expiry within WARN_DAYS days
#
# Schedule: 0 8 * * 1  (every Monday at 08:00)
# Alert   : Sends email to ALERT_EMAIL if any check fails
#
# Setup   : chmod +x /u01/oracle/scripts/check_soap_endpoints.sh
#           crontab -l | { cat; echo "0 8 * * 1 /u01/oracle/scripts/check_soap_endpoints.sh"; } | crontab -

# -----------------------------------------------------------------------
# Configuration — edit this section for your environment
# -----------------------------------------------------------------------

ENDPOINTS=(
  "external-api.example.com:443"
  "compliance-service.example.com:443"
  "logistics-api.example.com:443"
  "financial-data.example.com:443"
)

# Load EBS environment
source /u01/oracle/apps/EBSapps.env run 2>/dev/null

CACERTS="\${FMW_HOME}/oracle_common/jdk/jre/lib/security/cacerts"
WARN_DAYS=60
ALERT_EMAIL="dba-team@example.com"
LOG_DIR="/u01/oracle/logs/ssl_checks"
LOG_FILE="\${LOG_DIR}/ssl_check_\$(date +%Y%m%d_%H%M%S).log"
ALERTS=""

# -----------------------------------------------------------------------
mkdir -p "\${LOG_DIR}"
exec > >(tee -a "\${LOG_FILE}") 2>&1

echo "========================================================"
echo " EBS SOAP Endpoint SSL Check"
echo " Timestamp : \$(date)"
echo " Truststore: \${CACERTS}"
echo " Warn threshold: \${WARN_DAYS} days"
echo "========================================================"

for ENDPOINT in "\${ENDPOINTS[@]}"; do
  HOST=\$(echo "\${ENDPOINT}" | cut -d: -f1)
  PORT=\$(echo "\${ENDPOINT}" | cut -d: -f2)

  echo ""
  echo "--- Checking \${HOST}:\${PORT} ---"

  # ---- 1. TLS trust check ----
  TRUST_OUT=\$(openssl s_client -connect "\${HOST}:\${PORT}" \
    -CAfile "\${CACERTS}" \
    -verify_return_error 2>&1 \
    | grep "Verify return code")

  if echo "\${TRUST_OUT}" | grep -q "0 (ok)"; then
    echo "  [PASS] TRUST: Verify return code: 0 (ok)"
  else
    echo "  [FAIL] TRUST: \${TRUST_OUT:-no output — connection failed}"
    ALERTS="\${ALERTS}TRUST FAILURE: \${HOST}:\${PORT} — certificate not trusted by EBS cacerts\n"
    ALERTS="\${ALERTS}  Detail: \${TRUST_OUT}\n\n"
  fi

  # ---- 2. Expiry check ----
  EXPIRY_RAW=\$(echo | openssl s_client -connect "\${HOST}:\${PORT}" 2>/dev/null \
    | openssl x509 -noout -enddate 2>/dev/null \
    | cut -d= -f2)

  if [ -n "\${EXPIRY_RAW}" ]; then
    # Parse expiry date — handle both Linux (date -d) and macOS (date -j -f)
    EXPIRY_EPOCH=\$(date -d "\${EXPIRY_RAW}" +%s 2>/dev/null || \
                   date -j -f "%b %d %H:%M:%S %Y %Z" "\${EXPIRY_RAW}" +%s 2>/dev/null)
    NOW_EPOCH=\$(date +%s)
    DAYS_LEFT=\$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))

    if [ "\${DAYS_LEFT}" -ge "\${WARN_DAYS}" ]; then
      echo "  [PASS] EXPIRY: \${EXPIRY_RAW} (\${DAYS_LEFT} days remaining)"
    elif [ "\${DAYS_LEFT}" -ge 0 ]; then
      echo "  [WARN] EXPIRY: \${EXPIRY_RAW} — only \${DAYS_LEFT} days remaining!"
      ALERTS="\${ALERTS}EXPIRY WARNING: \${HOST}:\${PORT} — cert expires in \${DAYS_LEFT} days (\${EXPIRY_RAW})\n\n"
    else
      echo "  [CRIT] EXPIRY: \${EXPIRY_RAW} — EXPIRED \$(( -DAYS_LEFT )) days ago!"
      ALERTS="\${ALERTS}CERT EXPIRED: \${HOST}:\${PORT} — expired \$(( -DAYS_LEFT )) days ago (\${EXPIRY_RAW})\n\n"
    fi
  else
    echo "  [WARN] EXPIRY: Could not retrieve certificate (connection refused or blocked)"
    ALERTS="\${ALERTS}UNREACHABLE: \${HOST}:\${PORT} — could not connect to retrieve certificate\n\n"
  fi
done

echo ""
echo "========================================================"
if [ -n "\${ALERTS}" ]; then
  echo " ALERTS DETECTED:"
  echo -e "\${ALERTS}"
  echo "========================================================"
  # Send alert email
  (
    echo "Subject: [EBS SSL ALERT] Endpoint trust or expiry issue on \$(hostname -s)"
    echo "To: \${ALERT_EMAIL}"
    echo "Content-Type: text/plain; charset=UTF-8"
    echo ""
    echo "EBS SSL Endpoint Monitoring detected issues on \$(hostname -f) at \$(date)"
    echo ""
    echo -e "\${ALERTS}"
    echo "Full log: \${LOG_FILE}"
    echo ""
    echo "Reference runbook: EBS 12.2 Outbound SOAP PKIX SSL Runbook"
  ) | /usr/sbin/sendmail -t 2>/dev/null || \
    mail -s "[EBS SSL ALERT] Endpoint issue on \$(hostname -s)" "\${ALERT_EMAIL}" \
      <<< "\$(echo -e "\${ALERTS}\n\\$1Full log: \${LOG_FILE}")"
  echo " Alert email sent to: \${ALERT_EMAIL}"
else
  echo " All endpoints PASSED trust and expiry checks."
fi
echo "========================================================"
echo " Check complete: \$(date)"
echo "========================================================"
\`\`\`

### Deploy and Schedule

\`\`\`bash
# Save and make executable
chmod 750 /u01/oracle/scripts/check_soap_endpoints.sh

# Add ENDPOINTS array entries for your actual integration partners
# (edit the ENDPOINTS array at the top of the script)

# Add to the oracle user's crontab — runs every Monday at 08:00
( crontab -l 2>/dev/null; echo "0 8 * * 1 /u01/oracle/scripts/check_soap_endpoints.sh" ) | crontab -

# Verify the cron entry
crontab -l | grep check_soap_endpoints

# Run a manual test
/u01/oracle/scripts/check_soap_endpoints.sh
\`\`\`

---

## Phase 9 — Post-Fix Verification and Validation Matrix

### SQL Verification — Confirm the Integration Now Succeeds

\`\`\`sql
-- Check if the previously failing concurrent program now completes normally
SELECT fcr.request_id,
       fcr.concurrent_program_name,
       fcr.phase_code,
       fcr.status_code,
       fcr.actual_start_date,
       fcr.actual_completion_date,
       ROUND((fcr.actual_completion_date - fcr.actual_start_date) * 1440, 2) AS run_minutes
FROM fnd_concurrent_requests fcr
WHERE fcr.concurrent_program_name = 'YOUR_PROGRAM_NAME'
  AND fcr.actual_start_date > SYSDATE - 1/24  -- last 1 hour
ORDER BY fcr.actual_start_date DESC
FETCH FIRST 10 ROWS ONLY;

-- Confirm zero PKIX errors in FND log since the fix was applied
SELECT COUNT(*) AS pkix_errors_since_fix
FROM fnd_log_messages
WHERE message_text LIKE '%PKIX%'
  AND timestamp > SYSTIMESTAMP - INTERVAL '1' HOUR;
-- Expected: 0
\`\`\`

### Validation Matrix

| # | Check | Command / Query | Pass Criterion |
|---|-------|----------------|----------------|
| 1 | Cert chain extracted from remote server | \`openssl s_client -connect host:443 -showcerts 2>/dev/null \| grep -c "BEGIN CERT"\` | Result ≥ 2 |
| 2 | FMW cacerts backup exists | \`ls -la \${FMW_CACERTS}.bak_*\` | Backup file present, dated today |
| 3 | RDBMS cacerts backup exists | \`ls -la \${RDBMS_CACERTS}.bak_*\` | Backup file present, dated today |
| 4 | Alias imported into FMW cacerts | \`\${FMW_JDK}/bin/keytool -list -keystore \${FMW_CACERTS} -alias vendor_endpoint_cert1 -storepass changeit\` | Entry type: trustedCertEntry |
| 5 | Alias imported into RDBMS cacerts | \`\${RDBMS_JDK}/bin/keytool -list -keystore \${RDBMS_CACERTS} -alias vendor_endpoint_rdbms_cert1 -storepass changeit\` | Entry type: trustedCertEntry |
| 6 | TLS handshake passes (FMW cacerts) | \`openssl s_client -connect host:443 -CAfile \${FMW_CACERTS} -verify_return_error 2>&1 \| grep "Verify"\` | Verify return code: 0 (ok) |
| 7 | TLS handshake passes (RDBMS cacerts) | \`openssl s_client -connect host:443 -CAfile \${RDBMS_CACERTS} -verify_return_error 2>&1 \| grep "Verify"\` | Verify return code: 0 (ok) |
| 8 | Context file updated (if custom truststore) | \`grep trustStore \${CONTEXT_FILE}\` | Line present with correct path |
| 9 | AutoConfig completed (if custom truststore) | \`grep "autoconfig completed" \${INST_TOP}/admin/log/adautocfg*.log\` | Exit status: Completed successfully |
| 10 | WLS config reflects trustStore arg | \`grep -i trustStore \${DOMAIN_HOME}/config/config.xml\` | Line present with correct path |
| 11 | Services restarted | \`ps -ef \| grep -c oacore\` | ≥ 1 oacore process running |
| 12 | Concurrent request succeeds | FND query from Phase 9 | status_code = 'C' (Complete Normal) |
| 13 | No new PKIX errors in FND log | FND log count query from Phase 9 | 0 errors in last 1 hour |
| 14 | Monitoring script deployed | \`ls -l /u01/oracle/scripts/check_soap_endpoints.sh\` | File exists, executable |
| 15 | Monitoring cron scheduled | \`crontab -l \| grep check_soap_endpoints\` | Cron entry present |

---

## Post-Incident Actions

After the fix is confirmed, complete these administrative tasks:

**1. Document the imported certificates.** Export the current cacerts alias list and save it to version control or the DBA runbook repository:

\`\`\`bash
"\${FMW_JDK}/bin/keytool" -list \
  -keystore "\${FMW_CACERTS}" \
  -storepass "\${KS_PASS}" \
  | grep "vendor_" \
  > /u01/oracle/scripts/vendor_cert_inventory_\$(date +%Y%m%d).txt
\`\`\`

**2. Register the external endpoint in the monitoring script.** If the failing endpoint was not already in the \`ENDPOINTS\` array of \`check_soap_endpoints.sh\`, add it now.

**3. Contact the external service provider.** Request advance notification (minimum 90 days) before any future certificate rotations or CA changes. Capture the contact name and process in the integration runbook.

**4. Plan for JDK replacement events.** Any future EBS patching that replaces the FMW or RDBMS JDK will overwrite \`cacerts\`. Add a step to the EBS patching runbook to re-apply vendor certificate imports after any JDK-level patch.

**5. Evaluate migration to a managed truststore.** For environments with many external integrations, maintaining per-JDK \`cacerts\` files manually is error-prone. Consider a site-wide custom truststore file (outside the JDK installation path) referenced by all JVMs via \`-Djavax.net.ssl.trustStore\`, persisted through AutoConfig, and managed as a version-controlled artifact.`,
};

async function main() {
  console.log('Inserting EBS PKIX SSL truststore runbook...');
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
