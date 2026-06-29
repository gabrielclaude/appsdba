import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Wallet Certificate Monitor Runbook: Integrated SOA Gateway Edition',
  slug: 'oracle-wallet-certificate-monitoring-runbook',
  excerpt:
    'Complete installation and configuration runbook for the Oracle Wallet certificate monitoring script in an EBS 12.2 Integrated SOA Gateway environment. Covers locating the ISG wallet path from the EBS context file, understanding the ISG-specific SSL chain requirements for UTL_HTTP outbound calls, directory layout, secure wallet password file, vendor certificate reference store population from live SOA endpoints, the full monitoring shell script with expiry and fingerprint comparison logic, sendmail recipient list configuration, crontab scheduling, log rotation, and an end-to-end validation sequence confirming alert delivery before going live.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-29'),
  youtubeUrl: null,
  content: `## Introduction

Oracle EBS Integrated SOA Gateway (ISG) exposes EBS business objects as SOAP and REST web services and allows EBS to call external web services from PL/SQL via \`UTL_HTTP\`. Every outbound HTTPS call ISG makes — to payment gateways, tax authority endpoints, third-party SaaS platforms, or internal middleware — is secured by SSL, and the trust chain for each of those connections is validated against certificates in the Oracle Wallet configured on the database tier.

When a certificate in that wallet expires or when a certificate authority reissues an intermediate CA with a new key, outbound ISG calls fail silently with:

\`\`\`
ORA-29273: HTTP request failed
ORA-06512: at "SYS.UTL_HTTP", line 1519
ORA-29024: Certificate validation failure
\`\`\`

or, if the wallet is not configured at all:

\`\`\`
ORA-28759: failure to open file
\`\`\`

Neither error identifies which certificate failed or why. The monitoring script in this runbook catches these failures before they occur — checking every certificate in the ISG wallet daily, alerting the Apps DBA team via email when any certificate is within the warning window or when a fingerprint mismatch with the vendor reference indicates a CA has reissued its certificate.

---

## ISG Wallet Architecture

### The Two Wallets in an EBS Environment

An EBS 12.2 environment may have up to three distinct Oracle Wallets:

\`\`\`
1. OHS Wallet (application tier)
   Path: \$OHS_INSTANCE_HOME/config/OHS/<ohs_name>/keystores/default/
   Purpose: OHS server identity certificate — what browsers connect to
   Monitored by: network/load balancer monitoring
   Not the focus of this runbook

2. Database-tier Wallet for UTL_HTTP (ISG outbound calls)
   Path: \$ORACLE_HOME/ssl/client/  OR  \$TNS_ADMIN/wallet/
   OR: configured in \$ORACLE_HOME/network/admin/sqlnet.ora
   Purpose: trusted CAs for HTTPS endpoints called from PL/SQL
   This is the ISG wallet — the focus of this runbook

3. JDBC Wallet (WebLogic to DB TCPS — optional)
   Purpose: encrypts JDBC connections
   Not relevant to ISG outbound SSL
\`\`\`

### Locating the ISG Wallet Path

The database-tier wallet path is defined in the database server's \`sqlnet.ora\`. Find it:

\`\`\`bash
# On the database server as oracle
grep -i WALLET \$ORACLE_HOME/network/admin/sqlnet.ora
grep -i WALLET \$TNS_ADMIN/sqlnet.ora 2>/dev/null

# Example output:
# WALLET_LOCATION =
#   (SOURCE =
#     (METHOD = FILE)
#     (METHOD_DATA =
#       (DIRECTORY = /u01/app/oracle/product/19.0.0/dbhome_1/ssl/client)))
# SSL_CLIENT_AUTHENTICATION = FALSE
\`\`\`

Alternatively, check the EBS context file for the wallet path used by AutoConfig:

\`\`\`bash
# On the application tier, find the context file
ls \$CONTEXT_FILE

# Search for wallet references
grep -i wallet \$CONTEXT_FILE

# Example context file entries:
# <s_oracle_wallet_loc oa_var="s_oracle_wallet_loc">/u01/app/oracle/wallet</s_oracle_wallet_loc>
\`\`\`

If ISG is configured to use a specific wallet path in PL/SQL, find it in the EBS profile:

\`\`\`sql
-- On the primary database as APPS
SELECT PROFILE_OPTION_VALUE
FROM FND_PROFILE_OPTION_VALUES
WHERE PROFILE_OPTION_ID = (
  SELECT PROFILE_OPTION_ID
  FROM FND_PROFILE_OPTIONS
  WHERE PROFILE_OPTION_NAME = 'FND_DB_WALLET_DIR'
)
AND LEVEL_ID = 10001;
\`\`\`

Record the wallet path — you will use it as \`WALLET_PATH\` in the monitoring configuration.

### Verify the Wallet Is Used by UTL_HTTP

Confirm which wallet the database is using for outbound SSL calls:

\`\`\`sql
-- As SYS on the primary database
SELECT VALUE FROM V\$PARAMETER WHERE NAME = 'ssl_client_authentication';

-- Check the current UTL_HTTP wallet setting for a test call
-- (requires SYS or DBA privilege)
DECLARE
  l_wallet_path VARCHAR2(500);
BEGIN
  l_wallet_path := UTL_HTTP.GET_WALLET_PATH;
  DBMS_OUTPUT.PUT_LINE('Current wallet path: ' || l_wallet_path);
EXCEPTION
  WHEN OTHERS THEN
    DBMS_OUTPUT.PUT_LINE('No wallet explicitly set — using sqlnet.ora configuration');
END;
/
\`\`\`

---

## Phase 1: Prerequisites

### Required Software

\`\`\`bash
# Verify OpenSSL is available (standard on Oracle Linux)
openssl version
# OpenSSL 3.0.x or 1.1.x — both work

# Verify orapki is available (for wallet display reference)
which orapki || echo "orapki not in PATH — add \$ORACLE_HOME/bin to PATH"

# Verify sendmail is available
which sendmail
# If not found:
sudo dnf install -y postfix && sudo systemctl enable --now postfix
\`\`\`

### OS User and Permissions

The monitoring script runs as the \`oracle\` OS user. Verify wallet file permissions:

\`\`\`bash
# As root or oracle
ls -la /path/to/wallet/
# ewallet.p12 should be readable by oracle (600 or 640)
# cwallet.sso is the auto-login wallet (SSO) — readable by oracle

# If oracle cannot read the wallet:
sudo chown oracle:oinstall /path/to/wallet/ewallet.p12
sudo chmod 640 /path/to/wallet/ewallet.p12
\`\`\`

---

## Phase 2: Directory Layout

\`\`\`bash
# As oracle — create the monitoring directory structure
MONITOR_BASE=/opt/oracle/scripts/wallet_monitor
mkdir -p \${MONITOR_BASE}/{vendor_certs,logs,archive}
chmod 750 \${MONITOR_BASE}
chmod 700 \${MONITOR_BASE}/vendor_certs   # contains sensitive reference certs

# Directory structure:
# /opt/oracle/scripts/wallet_monitor/
# ├── oracle_wallet_cert_monitor.sh    ← main monitoring script
# ├── fetch_vendor_cert.sh             ← helper: fetch certs from live endpoints
# ├── wallet_monitor.conf              ← configuration (wallet path, recipients, thresholds)
# ├── .wallet_pwd                      ← wallet password file (600, oracle only)
# ├── vendor_certs/                    ← reference PEM files from CAs
# │   ├── DigiCert_Root_CA.pem
# │   ├── DigiCert_SHA2_Intermediate.pem
# │   └── <vendor_cn>.pem             ← one file per trusted cert in wallet
# └── logs/
#     └── wallet_monitor.log
\`\`\`

---

## Phase 3: Wallet Password File

The PKCS12 wallet (\`ewallet.p12\`) requires a password to export its contents. Store the password in a restricted file, not in the script itself:

\`\`\`bash
# As oracle — create the password file
MONITOR_BASE=/opt/oracle/scripts/wallet_monitor
echo 'WalletPassword123!' > \${MONITOR_BASE}/.wallet_pwd
chmod 600 \${MONITOR_BASE}/.wallet_pwd
chown oracle:oinstall \${MONITOR_BASE}/.wallet_pwd

# Verify permissions — must be exactly 600
ls -la \${MONITOR_BASE}/.wallet_pwd
# -rw------- 1 oracle oinstall 20 Jun 29 06:00 .wallet_pwd

# Test that openssl can read the wallet with this password
WALLET_PATH=/path/to/wallet
openssl pkcs12 \
  -in \${WALLET_PATH}/ewallet.p12 \
  -nokeys \
  -passin "pass:\$(cat \${MONITOR_BASE}/.wallet_pwd)" \
  -out /tmp/wallet_test_extract.pem 2>&1
# Should produce: MAC verified OK
# Should NOT produce: Mac verify error

rm -f /tmp/wallet_test_extract.pem
\`\`\`

If the wallet uses the auto-login format (\`cwallet.sso\`) without a password, set the password field to empty in the config and adjust the openssl command in the script (the SSO wallet can be read with an empty password or requires the \`orapki\` tool instead).

---

## Phase 4: Configuration File

\`\`\`bash
cat > /opt/oracle/scripts/wallet_monitor/wallet_monitor.conf << 'ENDCONF'
# wallet_monitor.conf — Oracle Wallet Certificate Monitor Configuration
# Edit for each environment (PROD, TEST, DEV)

# ── Wallet ──────────────────────────────────────────────────────────────────
# Path to the Oracle Wallet directory (must contain ewallet.p12)
WALLET_PATH=/u01/app/oracle/product/19.0.0/dbhome_1/ssl/client

# File containing the wallet password (must be chmod 600, owned by oracle)
WALLET_PWD_FILE=/opt/oracle/scripts/wallet_monitor/.wallet_pwd

# ── Thresholds ───────────────────────────────────────────────────────────────
# Days before expiry to issue a WARNING alert
WARN_DAYS=60

# Days before expiry to issue a CRITICAL alert
CRIT_DAYS=30

# ── Vendor Reference Store ───────────────────────────────────────────────────
# Directory containing vendor CA PEM files for fingerprint comparison
VENDOR_CERT_DIR=/opt/oracle/scripts/wallet_monitor/vendor_certs

# ── Notification ─────────────────────────────────────────────────────────────
# Comma-separated list of email recipients for alerts
RECIPIENT_LIST=dba-team@example.com,security-ops@example.com

# Additional recipients for CRITICAL alerts only (leave blank to use RECIPIENT_LIST)
CRITICAL_RECIPIENT_LIST=dba-oncall@example.com,infra-oncall@example.com

# Email from address
FROM_ADDRESS=oracle-wallet-monitor@ebsprd.example.com

# ── Paths ────────────────────────────────────────────────────────────────────
ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
LOG_FILE=/opt/oracle/scripts/wallet_monitor/logs/wallet_monitor.log
ARCHIVE_DIR=/opt/oracle/scripts/wallet_monitor/archive

# ── Environment Label ────────────────────────────────────────────────────────
# Used in email subject line to distinguish PROD, TEST, DEV alerts
ENV_LABEL=PROD
ENDCONF

chmod 640 /opt/oracle/scripts/wallet_monitor/wallet_monitor.conf
\`\`\`

---

## Phase 5: Vendor Certificate Reference Store Population

Populate the vendor_certs directory with the current version of each CA certificate in the wallet. This is a one-time setup; update individual files when a CA reissues.

### Method A: Fetch from a Live ISG Endpoint

For each HTTPS endpoint that ISG calls, fetch its full certificate chain and save each intermediate and root:

\`\`\`bash
cat > /opt/oracle/scripts/wallet_monitor/fetch_vendor_cert.sh << 'ENDFETCH'
#!/bin/bash
# fetch_vendor_cert.sh — fetch certificate chain from a live HTTPS endpoint
# Usage: ./fetch_vendor_cert.sh <hostname> <port> [output_dir]

HOSTNAME=\$1
PORT=\${2:-443}
OUTPUT_DIR=\${3:-/opt/oracle/scripts/wallet_monitor/vendor_certs}

if [ -z "\${HOSTNAME}" ]; then
  echo "Usage: \$0 <hostname> [port] [output_dir]"
  exit 1
fi

echo "Fetching certificate chain from \${HOSTNAME}:\${PORT} ..."

# Fetch all certs in the chain (including root if presented)
CHAIN_PEM=\$(openssl s_client -showcerts -connect "\${HOSTNAME}:\${PORT}" \\
  -servername "\${HOSTNAME}" </dev/null 2>/dev/null)

if [ -z "\${CHAIN_PEM}" ]; then
  echo "ERROR: could not connect to \${HOSTNAME}:\${PORT}"
  exit 1
fi

# Split and save each certificate in the chain
CERT_INDEX=0
IN_CERT=false
CURRENT_CERT=""

while IFS= read -r line; do
  if [[ "\${line}" == "-----BEGIN CERTIFICATE-----" ]]; then
    IN_CERT=true
    CURRENT_CERT="\${line}\n"
  elif [[ "\${line}" == "-----END CERTIFICATE-----" ]]; then
    CURRENT_CERT="\${CURRENT_CERT}\${line}\n"

    # Get the CN for this cert
    CN=\$(printf "%b" "\${CURRENT_CERT}" | openssl x509 -noout -subject 2>/dev/null \\
      | grep -oP 'CN\s*=\s*\K[^,/]+' | tr ' ' '_' | tr -d '*/')

    # Get SHA-256 fingerprint (first 16 chars for filename uniqueness)
    FP_SHORT=\$(printf "%b" "\${CURRENT_CERT}" | openssl x509 -noout -fingerprint -sha256 2>/dev/null \\
      | cut -d= -f2 | tr -d ':' | cut -c1-16)

    OUTFILE="\${OUTPUT_DIR}/\${CN}_\${FP_SHORT}.pem"
    printf "%b" "\${CURRENT_CERT}" > "\${OUTFILE}"
    echo "Saved cert \${CERT_INDEX}: CN=\${CN} → \${OUTFILE}"

    CERT_INDEX=\$((CERT_INDEX + 1))
    IN_CERT=false
    CURRENT_CERT=""
  elif [ "\${IN_CERT}" = true ]; then
    CURRENT_CERT="\${CURRENT_CERT}\${line}\n"
  fi
done <<< "\${CHAIN_PEM}"

echo "Fetched \${CERT_INDEX} certificate(s) from \${HOSTNAME}:\${PORT}"
ENDFETCH

chmod 750 /opt/oracle/scripts/wallet_monitor/fetch_vendor_cert.sh
\`\`\`

Run it for each ISG external endpoint:

\`\`\`bash
cd /opt/oracle/scripts/wallet_monitor

# Example: fetch certs from your external SOAP endpoints
./fetch_vendor_cert.sh payment-gateway.vendor.com 443
./fetch_vendor_cert.sh taxapi.government.gov 443
./fetch_vendor_cert.sh erp-integration.partner.com 8443

# Verify what was saved
ls -la vendor_certs/
openssl x509 -in vendor_certs/<filename>.pem -noout -subject -dates -fingerprint -sha256
\`\`\`

### Method B: Extract from Wallet and Save as Baseline

If no live endpoints are available (air-gapped environment), extract the wallet's current certs as the initial baseline. This creates a reference at the moment of setup; update when vendors notify you of CA renewals.

\`\`\`bash
WALLET_PATH=/path/to/wallet
WALLET_PWD=\$(cat /opt/oracle/scripts/wallet_monitor/.wallet_pwd)
VENDOR_DIR=/opt/oracle/scripts/wallet_monitor/vendor_certs

# Export all trusted CAs from the wallet
openssl pkcs12 \
  -in "\${WALLET_PATH}/ewallet.p12" \
  -nokeys \
  -passin "pass:\${WALLET_PWD}" \
  -out /tmp/wallet_all_certs.pem 2>/dev/null

# Split and save each cert with CN-based filename
cert_index=0
in_cert=false
current_cert=""

while IFS= read -r line; do
  if [[ "\${line}" == "-----BEGIN CERTIFICATE-----" ]]; then
    in_cert=true; current_cert="\${line}\n"
  elif [[ "\${line}" == "-----END CERTIFICATE-----" ]]; then
    current_cert="\${current_cert}\${line}\n"
    CN=\$(printf "%b" "\${current_cert}" | openssl x509 -noout -subject 2>/dev/null \\
      | grep -oP 'CN\s*=\s*\K[^,/]+' | tr ' ' '_' | tr -d '*/')
    FP_SHORT=\$(printf "%b" "\${current_cert}" | openssl x509 -noout -fingerprint -sha256 2>/dev/null \\
      | cut -d= -f2 | tr -d ':' | cut -c1-16)
    printf "%b" "\${current_cert}" > "\${VENDOR_DIR}/\${CN:-cert_\${cert_index}}_\${FP_SHORT}.pem"
    echo "Saved: CN=\${CN}"
    cert_index=\$((cert_index+1)); in_cert=false; current_cert=""
  elif [ "\${in_cert}" = true ]; then
    current_cert="\${current_cert}\${line}\n"
  fi
done < /tmp/wallet_all_certs.pem

rm -f /tmp/wallet_all_certs.pem
echo "Saved \${cert_index} reference certificate(s) to \${VENDOR_DIR}"
\`\`\`

---

## Phase 6: The Monitoring Script

\`\`\`bash
cat > /opt/oracle/scripts/wallet_monitor/oracle_wallet_cert_monitor.sh << 'ENDSCRIPT'
#!/bin/bash
# oracle_wallet_cert_monitor.sh
# Monitor Oracle Wallet certificates for the EBS Integrated SOA Gateway environment.
# Checks every certificate in ewallet.p12 for:
#   1. Expiry (Not After vs WARN_DAYS and CRIT_DAYS thresholds)
#   2. Fingerprint drift (SHA-256 vs vendor_certs/ reference store)
# Sends email alerts via sendmail when issues are found.

# ── Load Configuration ─────────────────────────────────────────────────────────
SCRIPT_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="\${SCRIPT_DIR}/wallet_monitor.conf"

if [ ! -f "\${CONFIG_FILE}" ]; then
  echo "ERROR: configuration file not found: \${CONFIG_FILE}" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "\${CONFIG_FILE}"

# ── Defaults ──────────────────────────────────────────────────────────────────
WARN_DAYS="\${WARN_DAYS:-60}"
CRIT_DAYS="\${CRIT_DAYS:-30}"
ENV_LABEL="\${ENV_LABEL:-PROD}"
LOG_FILE="\${LOG_FILE:-\${SCRIPT_DIR}/logs/wallet_monitor.log}"

export PATH="\${ORACLE_HOME}/bin:\${PATH}"

# ── Temp workspace (auto-cleaned on exit) ─────────────────────────────────────
TMP_DIR="\$(mktemp -d /tmp/wallet_monitor_XXXXXX)"
trap 'rm -rf "\${TMP_DIR}"' EXIT

# ── State tracking ────────────────────────────────────────────────────────────
TIMESTAMP="\$(date '+%Y-%m-%d %H:%M:%S')"
HOSTNAME="\$(hostname -s)"
ALERTS_CRIT=""
ALERTS_WARN=""
REPORT_OK=""
CERT_COUNT=0
EXIT_CODE=0

# ── Logging ───────────────────────────────────────────────────────────────────
log() {
  echo "[\${TIMESTAMP}] \$*" >> "\${LOG_FILE}"
}

# ── Alert collection ──────────────────────────────────────────────────────────
add_critical() {
  ALERTS_CRIT="\${ALERTS_CRIT}  CRITICAL: \$*\n"
  EXIT_CODE=2
}

add_warning() {
  ALERTS_WARN="\${ALERTS_WARN}  WARNING:  \$*\n"
  [ "\${EXIT_CODE}" -lt 2 ] && EXIT_CODE=1
}

add_ok() {
  REPORT_OK="\${REPORT_OK}  OK:       \$*\n"
}

# ── Wallet password ───────────────────────────────────────────────────────────
get_wallet_password() {
  if [ ! -f "\${WALLET_PWD_FILE}" ]; then
    log "ERROR: wallet password file not found: \${WALLET_PWD_FILE}"
    echo "ERROR: wallet password file not found" >&2
    exit 1
  fi
  local perm
  perm="\$(stat -c '%a' "\${WALLET_PWD_FILE}")"
  if [ "\${perm}" != "600" ]; then
    log "SECURITY WARNING: \${WALLET_PWD_FILE} permissions are \${perm}, expected 600"
  fi
  tr -d '\n' < "\${WALLET_PWD_FILE}"
}

# ── Certificate extraction ────────────────────────────────────────────────────
extract_wallet_certs() {
  local ewallet="\${WALLET_PATH}/ewallet.p12"
  local wallet_pwd
  wallet_pwd="\$(get_wallet_password)"

  if [ ! -f "\${ewallet}" ]; then
    add_critical "Wallet file not found: \${ewallet}"
    log "CRITICAL: wallet file not found: \${ewallet}"
    return 1
  fi

  # Export all certificates (no private keys) from PKCS12
  openssl pkcs12 \
    -in "\${ewallet}" \
    -nokeys \
    -out "\${TMP_DIR}/all_certs.pem" \
    -passin "pass:\${wallet_pwd}" 2>"\${TMP_DIR}/openssl_err.txt"

  if [ \$? -ne 0 ]; then
    local err
    err="\$(cat "\${TMP_DIR}/openssl_err.txt" | grep -v '^#' | head -3)"
    add_critical "Failed to extract certs from wallet \${ewallet}: \${err}"
    log "CRITICAL: openssl pkcs12 extraction failed: \${err}"
    return 1
  fi

  # Split concatenated PEM into individual files
  local index=0
  local in_cert=false
  local buf=""

  while IFS= read -r line; do
    if [[ "\${line}" == "-----BEGIN CERTIFICATE-----" ]]; then
      in_cert=true
      buf="\${line}\n"
    elif [[ "\${line}" == "-----END CERTIFICATE-----" ]]; then
      buf="\${buf}\${line}\n"
      printf "%b" "\${buf}" > "\${TMP_DIR}/cert_\${index}.pem"
      index=\$((index + 1))
      in_cert=false
      buf=""
    elif [ "\${in_cert}" = true ]; then
      buf="\${buf}\${line}\n"
    fi
  done < "\${TMP_DIR}/all_certs.pem"

  CERT_COUNT="\${index}"
  log "Extracted \${CERT_COUNT} certificate(s) from \${ewallet}"
}

# ── Certificate field extraction ──────────────────────────────────────────────
cert_field() {
  local pem="\$1" field="\$2"
  case "\${field}" in
    cn)
      openssl x509 -in "\${pem}" -noout -subject 2>/dev/null \
        | grep -oP 'CN\s*=\s*\K[^,/]+' | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*\$//'
      ;;
    subject)
      openssl x509 -in "\${pem}" -noout -subject 2>/dev/null \
        | sed 's/^subject=//' | sed 's/^subject = //'
      ;;
    not_after)
      openssl x509 -in "\${pem}" -noout -enddate 2>/dev/null | cut -d= -f2
      ;;
    not_before)
      openssl x509 -in "\${pem}" -noout -startdate 2>/dev/null | cut -d= -f2
      ;;
    sha256)
      openssl x509 -in "\${pem}" -noout -fingerprint -sha256 2>/dev/null \
        | sed 's/SHA256 Fingerprint=//' | sed 's/sha256 Fingerprint=//'
      ;;
    serial)
      openssl x509 -in "\${pem}" -noout -serial 2>/dev/null | cut -d= -f2
      ;;
    issuer_cn)
      openssl x509 -in "\${pem}" -noout -issuer 2>/dev/null \
        | grep -oP 'CN\s*=\s*\K[^,/]+' | sed 's/^[[:space:]]*//'
      ;;
  esac
}

# ── Expiry check ──────────────────────────────────────────────────────────────
check_expiry() {
  local pem="\$1" label="\$2"

  local not_after
  not_after="\$(cert_field "\${pem}" not_after)"
  if [ -z "\${not_after}" ]; then
    add_warning "\${label}: could not read Not After date"
    return
  fi

  # Convert to epoch (Linux date)
  local exp_epoch
  exp_epoch="\$(date -d "\${not_after}" +%s 2>/dev/null)"
  if [ -z "\${exp_epoch}" ]; then
    add_warning "\${label}: could not parse Not After date: \${not_after}"
    return
  fi

  local now_epoch days_left
  now_epoch="\$(date +%s)"
  days_left=\$(( (exp_epoch - now_epoch) / 86400 ))

  if [ "\${days_left}" -le 0 ]; then
    add_critical "\${label} — EXPIRED as of \${not_after} (\$(( -days_left )) days ago)"
  elif [ "\${days_left}" -le "\${CRIT_DAYS}" ]; then
    add_critical "\${label} — expires \${not_after} (\${days_left} days remaining)"
  elif [ "\${days_left}" -le "\${WARN_DAYS}" ]; then
    add_warning "\${label} — expires \${not_after} (\${days_left} days remaining)"
  else
    add_ok "\${label} — valid \${days_left} more days (expires \${not_after})"
  fi
}

# ── Fingerprint comparison against vendor reference store ─────────────────────
check_fingerprint() {
  local wallet_pem="\$1" label="\$2"

  local wallet_cn wallet_fp
  wallet_cn="\$(cert_field "\${wallet_pem}" cn)"
  wallet_fp="\$(cert_field "\${wallet_pem}" sha256)"

  if [ ! -d "\${VENDOR_CERT_DIR}" ] || [ -z "\$(ls "\${VENDOR_CERT_DIR}"/*.pem 2>/dev/null)" ]; then
    log "INFO: vendor_certs directory is empty — skipping fingerprint comparison"
    return
  fi

  # Search vendor reference store for a cert with matching CN
  local vendor_match="" vendor_fp=""
  for vendor_pem in "\${VENDOR_CERT_DIR}"/*.pem; do
    [ -f "\${vendor_pem}" ] || continue
    local vendor_cn
    vendor_cn="\$(cert_field "\${vendor_pem}" cn)"
    if [ "\${vendor_cn}" = "\${wallet_cn}" ]; then
      vendor_match="\${vendor_pem}"
      vendor_fp="\$(cert_field "\${vendor_pem}" sha256)"
      break
    fi
  done

  if [ -z "\${vendor_match}" ]; then
    log "INFO: no vendor reference for CN='\${wallet_cn}' in \${VENDOR_CERT_DIR} — add PEM to enable fingerprint check"
    return
  fi

  if [ "\${wallet_fp}" != "\${vendor_fp}" ]; then
    local ref_not_after
    ref_not_after="\$(cert_field "\${vendor_match}" not_after)"
    add_critical "\${label} FINGERPRINT MISMATCH — wallet does not match vendor reference" \
      "(CN=\${wallet_cn}, wallet SHA-256=\${wallet_fp}, vendor SHA-256=\${vendor_fp}," \
      "vendor ref expires \${ref_not_after}). CA may have reissued. Update wallet with vendor reference cert."
  else
    add_ok "\${label} fingerprint matches vendor reference (CN=\${wallet_cn})"
  fi
}

# ── Sendmail notification ─────────────────────────────────────────────────────
send_email() {
  local subject="\$1"
  local body="\$2"
  local recipients="\$3"

  # Build To: headers from comma-separated list
  local to_headers=""
  IFS=',' read -ra RCPT_ARRAY <<< "\${recipients}"
  for rcpt in "\${RCPT_ARRAY[@]}"; do
    rcpt="\$(echo "\${rcpt}" | tr -d ' ')"
    [ -n "\${rcpt}" ] && to_headers="\${to_headers}To: \${rcpt}\n"
  done

  {
    printf "From: Oracle Wallet Monitor [%s] <%s>\n" "\${ENV_LABEL}" "\${FROM_ADDRESS}"
    printf "%b" "\${to_headers}"
    printf "Subject: %s\n" "\${subject}"
    printf "Date: %s\n" "\$(date -R)"
    printf "MIME-Version: 1.0\n"
    printf "Content-Type: text/plain; charset=utf-8\n"
    printf "\n"
    printf "%s\n" "\${body}"
  } | /usr/sbin/sendmail -t -oi

  if [ \$? -eq 0 ]; then
    log "Email sent to \${recipients}: \${subject}"
  else
    log "ERROR: sendmail failed — subject: \${subject}"
  fi
}

# ── ISG-specific: check UTL_HTTP wallet configuration ────────────────────────
check_isg_wallet_config() {
  # Verify sqlnet.ora references the wallet we are monitoring
  local sqlnet_file="\${ORACLE_HOME}/network/admin/sqlnet.ora"
  if [ ! -f "\${sqlnet_file}" ]; then
    sqlnet_file="\${TNS_ADMIN}/sqlnet.ora"
  fi

  if [ -f "\${sqlnet_file}" ]; then
    if ! grep -qi "WALLET_LOCATION" "\${sqlnet_file}"; then
      add_warning "sqlnet.ora does not define WALLET_LOCATION — ISG outbound SSL may use system default trust store"
    else
      local sqlnet_wallet_dir
      sqlnet_wallet_dir="\$(grep -A4 'WALLET_LOCATION' "\${sqlnet_file}" | grep -i DIRECTORY | grep -oP 'DIRECTORY\s*=\s*\K[^)]+' | tr -d ' ')"
      if [ "\${sqlnet_wallet_dir}" != "\${WALLET_PATH}" ]; then
        add_warning "sqlnet.ora WALLET_LOCATION (\${sqlnet_wallet_dir}) does not match monitored WALLET_PATH (\${WALLET_PATH}) — verify configuration"
      else
        add_ok "sqlnet.ora WALLET_LOCATION matches monitored wallet path"
      fi
    fi
  fi
}

# ════════════════════════════════════════════════════════════════════════════════
# MAIN
# ════════════════════════════════════════════════════════════════════════════════

log "========================================================"
log "Oracle Wallet Certificate Monitor starting"
log "Wallet: \${WALLET_PATH}"
log "Thresholds: WARN=\${WARN_DAYS}d CRIT=\${CRIT_DAYS}d"

# ISG-specific configuration check
check_isg_wallet_config

# Extract certificates from wallet
extract_wallet_certs

if [ "\${CERT_COUNT}" -eq 0 ] && [ -z "\${ALERTS_CRIT}" ]; then
  add_critical "No certificates found in wallet: \${WALLET_PATH}"
fi

# Process each certificate
for cert_pem in "\${TMP_DIR}"/cert_*.pem; do
  [ -f "\${cert_pem}" ] || continue

  cn="\$(cert_field "\${cert_pem}" cn)"
  issuer_cn="\$(cert_field "\${cert_pem}" issuer_cn)"
  serial="\$(cert_field "\${cert_pem}" serial)"
  label="\${cn:-UNKNOWN} (issued by \${issuer_cn:-UNKNOWN}, serial \${serial:-?})"

  log "Checking: \${label}"
  check_expiry "\${cert_pem}" "\${label}"
  check_fingerprint "\${cert_pem}" "\${label}"
done

# ── Build and send notification ───────────────────────────────────────────────

HAS_CRIT="\$([ -n "\${ALERTS_CRIT}" ] && echo 1 || echo 0)"
HAS_WARN="\$([ -n "\${ALERTS_WARN}" ] && echo 1 || echo 0)"

if [ "\${HAS_CRIT}" = "1" ] || [ "\${HAS_WARN}" = "1" ]; then

  SUBJECT="[\${ENV_LABEL}] Oracle ISG Wallet Alert on \${HOSTNAME}: \${CERT_COUNT} certs checked"

  BODY="Oracle Integrated SOA Gateway — Wallet Certificate Alert
\$(printf '%0.s─' \$(seq 1 60))

Environment : \${ENV_LABEL}
Host        : \${HOSTNAME} (\$(hostname -f))
Wallet      : \${WALLET_PATH}
Certs found : \${CERT_COUNT}
Run time    : \${TIMESTAMP}

"

  if [ "\${HAS_CRIT}" = "1" ]; then
    BODY="\${BODY}CRITICAL ALERTS (immediate action required):
\$(printf '%b' "\${ALERTS_CRIT}")
"
  fi

  if [ "\${HAS_WARN}" = "1" ]; then
    BODY="\${BODY}WARNING ALERTS (action required before threshold):
\$(printf '%b' "\${ALERTS_WARN}")
"
  fi

  if [ -n "\${REPORT_OK}" ]; then
    BODY="\${BODY}CERTIFICATES OK:
\$(printf '%b' "\${REPORT_OK}")
"
  fi

  BODY="\${BODY}
REMEDIATION NOTES:
  Expiry: renew via your CA portal, import with orapki wallet add -wallet \${WALLET_PATH}
  Fingerprint mismatch: obtain new CA cert from vendor, update \${VENDOR_CERT_DIR}/
  ISG outbound SSL errors: ORA-29273 / ORA-29024 point to trust chain failure

Log file: \${LOG_FILE}"

  # Send to standard recipient list
  send_email "\${SUBJECT}" "\${BODY}" "\${RECIPIENT_LIST}"

  # Send critical-only alerts to oncall list if configured separately
  if [ "\${HAS_CRIT}" = "1" ] && [ -n "\${CRITICAL_RECIPIENT_LIST}" ] && \
     [ "\${CRITICAL_RECIPIENT_LIST}" != "\${RECIPIENT_LIST}" ]; then
    send_email "[CRITICAL] \${SUBJECT}" "\${BODY}" "\${CRITICAL_RECIPIENT_LIST}"
  fi

  log "Alert sent: CRIT=\${HAS_CRIT} WARN=\${HAS_WARN} recipients=\${RECIPIENT_LIST}"
else
  log "All \${CERT_COUNT} certificates OK — no alerts generated"
fi

log "Monitor complete — exit code \${EXIT_CODE}"
exit "\${EXIT_CODE}"
ENDSCRIPT

chmod 750 /opt/oracle/scripts/wallet_monitor/oracle_wallet_cert_monitor.sh
\`\`\`

---

## Phase 7: Sendmail Configuration

### Verify Sendmail / Postfix Is Running

\`\`\`bash
# Check which MTA is running
systemctl status postfix 2>/dev/null || systemctl status sendmail 2>/dev/null

# Test the sendmail interface directly
echo "Subject: Test from wallet monitor
From: oracle@\$(hostname -f)
To: dba-team@example.com

Test message from Oracle Wallet Monitor setup" | /usr/sbin/sendmail -t -oi dba-team@example.com

# Check mail queue
mailq | head -20
\`\`\`

### Configure Postfix Relay (If Direct SMTP Is Blocked)

Most data center environments block outbound SMTP on port 25 from application servers. Configure Postfix to relay through the corporate mail relay:

\`\`\`bash
# Edit /etc/postfix/main.cf as root
grep relayhost /etc/postfix/main.cf || \
  echo "relayhost = [smtp.example.com]:587" >> /etc/postfix/main.cf

# If relay requires authentication:
# Add to main.cf:
# smtp_sasl_auth_enable = yes
# smtp_sasl_password_maps = hash:/etc/postfix/sasl_passwd
# smtp_sasl_security_options = noanonymous
# smtp_tls_security_level = encrypt

systemctl reload postfix
\`\`\`

### Validate Alert Email Format

Run the script in test mode and inspect the email received:

\`\`\`bash
# Temporarily set CRIT_DAYS to a high value to force a warning alert for testing
CRIT_DAYS=9999 WARN_DAYS=9999 \
  /opt/oracle/scripts/wallet_monitor/oracle_wallet_cert_monitor.sh

# Check log for "Email sent" line
tail -20 /opt/oracle/scripts/wallet_monitor/logs/wallet_monitor.log
\`\`\`

---

## Phase 8: Crontab Installation

\`\`\`bash
# As oracle — edit crontab
crontab -e

# Add the following entries:

# Oracle ISG Wallet Certificate Monitor
# Daily check at 06:00 — primary monitoring run
0 6 * * * /opt/oracle/scripts/wallet_monitor/oracle_wallet_cert_monitor.sh >> /opt/oracle/scripts/wallet_monitor/logs/cron.log 2>&1

# Additional check at 18:00 — catches same-day changes (CA revocations, emergency renewals)
0 18 * * * /opt/oracle/scripts/wallet_monitor/oracle_wallet_cert_monitor.sh >> /opt/oracle/scripts/wallet_monitor/logs/cron.log 2>&1
\`\`\`

### Verify Crontab Is Installed

\`\`\`bash
crontab -l | grep wallet_monitor
# Should show both cron entries

# Verify cron daemon will execute oracle user's crontab
systemctl status crond || systemctl status cron

# Confirm oracle user is not in /etc/cron.deny
grep oracle /etc/cron.deny 2>/dev/null && echo "BLOCKED" || echo "OK — oracle not in cron.deny"
\`\`\`

### Log Rotation for Cron and Monitor Logs

\`\`\`bash
cat > /etc/logrotate.d/oracle_wallet_monitor << 'ENDLOGROTATE'
/opt/oracle/scripts/wallet_monitor/logs/wallet_monitor.log
/opt/oracle/scripts/wallet_monitor/logs/cron.log {
    daily
    rotate 90
    compress
    delaycompress
    missingok
    notifempty
    create 640 oracle oinstall
}
ENDLOGROTATE

# Test logrotate configuration
logrotate -d /etc/logrotate.d/oracle_wallet_monitor
\`\`\`

---

## Phase 9: Validation Checklist

### Step 9.1 — Manual Dry Run

\`\`\`bash
# Run manually as oracle and capture full output
/opt/oracle/scripts/wallet_monitor/oracle_wallet_cert_monitor.sh
echo "Exit code: \$?"

# Review log
tail -50 /opt/oracle/scripts/wallet_monitor/logs/wallet_monitor.log
\`\`\`

Expected output in log:
\`\`\`
[2026-06-29 06:00:01] ========================================================
[2026-06-29 06:00:01] Oracle Wallet Certificate Monitor starting
[2026-06-29 06:00:01] Wallet: /u01/app/oracle/product/19.0.0/dbhome_1/ssl/client
[2026-06-29 06:00:01] Thresholds: WARN=60d CRIT=30d
[2026-06-29 06:00:01] Extracted 4 certificate(s) from ewallet.p12
[2026-06-29 06:00:01] Checking: DigiCert Global Root CA (issued by DigiCert ...)
[2026-06-29 06:00:02] Checking: DigiCert SHA2 Secure Server CA (issued by ...)
[2026-06-29 06:00:02] Checking: *.vendor.com (issued by DigiCert SHA2 ...)
[2026-06-29 06:00:02] All 4 certificates OK — no alerts generated
[2026-06-29 06:00:02] Monitor complete — exit code 0
\`\`\`

### Step 9.2 — Force a Test Alert

Temporarily reduce CRIT_DAYS in the config to a value greater than the days remaining on any certificate, confirm an alert email is received, then restore:

\`\`\`bash
# Find the soonest-expiring cert
for pem in \${TMP_DIR}/cert_*.pem 2>/dev/null; do
  openssl x509 -in "\${pem}" -noout -subject -dates 2>/dev/null
done

# Or from the wallet directly:
WALLET_PWD=\$(cat /opt/oracle/scripts/wallet_monitor/.wallet_pwd)
openssl pkcs12 \
  -in /path/to/wallet/ewallet.p12 \
  -nokeys \
  -passin "pass:\${WALLET_PWD}" 2>/dev/null \
  | openssl x509 -noout -subject -dates 2>/dev/null

# Set CRIT_DAYS above the days remaining of the soonest cert
# Example: soonest cert expires in 400 days → set CRIT_DAYS=500
sed -i 's/^CRIT_DAYS=.*/CRIT_DAYS=500/' wallet_monitor.conf
/opt/oracle/scripts/wallet_monitor/oracle_wallet_cert_monitor.sh

# Confirm email received, then restore
sed -i 's/^CRIT_DAYS=500/CRIT_DAYS=30/' wallet_monitor.conf
\`\`\`

### Step 9.3 — Force a Fingerprint Mismatch Alert

Create a fake vendor reference cert with a different fingerprint for an existing CN to confirm mismatch detection fires:

\`\`\`bash
VENDOR_DIR=/opt/oracle/scripts/wallet_monitor/vendor_certs

# Generate a self-signed test cert with a specific CN
openssl req -new -x509 -days 1 -nodes \
  -subj "/CN=DigiCert Global Root CA/O=DigiCert Inc/C=US" \
  -out "\${VENDOR_DIR}/test_fake_DigiCert_Global_Root_CA.pem" 2>/dev/null

# Run monitor — should detect fingerprint mismatch for DigiCert Root CA
/opt/oracle/scripts/wallet_monitor/oracle_wallet_cert_monitor.sh

# Confirm CRITICAL fingerprint mismatch in log and email received
# Remove test cert after validation
rm "\${VENDOR_DIR}/test_fake_DigiCert_Global_Root_CA.pem"
\`\`\`

### Step 9.4 — Confirm Crontab Runs

After installing the crontab entries, verify the next scheduled run executes:

\`\`\`bash
# Check cron daemon logs for oracle user's job execution
grep CRON /var/log/cron | grep oracle | tail -10

# Or on systemd-based systems:
journalctl -u crond --since "today" | grep wallet_monitor | tail -10
\`\`\`

---

## Monitoring Scripts

### Supplemental: ISG Endpoint SSL Connectivity Test

Run this separately to confirm that ISG can actually complete an SSL handshake to each configured endpoint using the current wallet. This catches chain gaps that the expiry and fingerprint checks alone may not detect.

\`\`\`bash
#!/bin/bash
# isg_endpoint_ssl_test.sh
# Test SSL connectivity from the database server to each ISG external endpoint.
# Uses openssl s_client with the wallet's trusted CAs as the trust store.
# Run as oracle after any wallet change.

WALLET_PATH=/u01/app/oracle/product/19.0.0/dbhome_1/ssl/client
WALLET_PWD_FILE=/opt/oracle/scripts/wallet_monitor/.wallet_pwd
LOG=/opt/oracle/scripts/wallet_monitor/logs/isg_ssl_test.log

# ISG external endpoints — add all HTTPS services called from EBS
ENDPOINTS=(
  "payment-gateway.vendor.com:443"
  "taxapi.government.gov:443"
  "erp-integration.partner.com:8443"
)

WALLET_PWD=\$(tr -d '\n' < "\${WALLET_PWD_FILE}")

# Export wallet CA certs to PEM for use as trust store
TMPDIR=\$(mktemp -d)
trap 'rm -rf \${TMPDIR}' EXIT

openssl pkcs12 \
  -in "\${WALLET_PATH}/ewallet.p12" \
  -nokeys \
  -passin "pass:\${WALLET_PWD}" \
  -out "\${TMPDIR}/wallet_cas.pem" 2>/dev/null

TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
echo "[\${TIMESTAMP}] ISG Endpoint SSL Test" | tee -a "\${LOG}"

FAIL_COUNT=0
for endpoint in "\${ENDPOINTS[@]}"; do
  host="\$(echo \${endpoint} | cut -d: -f1)"
  port="\$(echo \${endpoint} | cut -d: -f2)"

  result=\$(echo "" | openssl s_client \
    -connect "\${host}:\${port}" \
    -servername "\${host}" \
    -CAfile "\${TMPDIR}/wallet_cas.pem" \
    -verify 5 \
    2>&1 | grep -E "(Verify return code|SSL handshake|error)" | head -3)

  if echo "\${result}" | grep -q "Verify return code: 0 (ok)"; then
    echo "  OK:   \${endpoint} — SSL handshake verified" | tee -a "\${LOG}"
  else
    echo "  FAIL: \${endpoint} — \${result}" | tee -a "\${LOG}"
    FAIL_COUNT=\$((FAIL_COUNT + 1))
  fi
done

echo "[\${TIMESTAMP}] ISG SSL test complete — \${FAIL_COUNT}/\${#ENDPOINTS[@]} failed" | tee -a "\${LOG}"
exit \${FAIL_COUNT}
\`\`\`

---

## Quick Reference

### Common orapki Commands (Reference)

\`\`\`bash
# Display all certificates in the wallet
orapki wallet display -wallet /path/to/wallet

# Add a trusted certificate to the wallet
orapki wallet add -wallet /path/to/wallet \
  -trusted_cert -cert /tmp/new_intermediate.pem \
  -pwd \$(cat .wallet_pwd)

# Remove a certificate by DN
orapki wallet remove -wallet /path/to/wallet \
  -dn "CN=Old Intermediate CA,O=Example Inc,C=US" \
  -pwd \$(cat .wallet_pwd)

# Create a new wallet
orapki wallet create -wallet /path/to/new_wallet \
  -pwd \$(cat .wallet_pwd) -auto_login
\`\`\`

### ISG SSL Error Quick Lookup

\`\`\`
ORA-29273: HTTP request failed       → SSL handshake failure; check wallet trust chain
ORA-29024: Certificate validation failure → cert not trusted or expired in wallet
ORA-28759: failure to open file      → wallet path incorrect in sqlnet.ora
ORA-24247: network access denied     → UTL_HTTP ACL not granted (not a cert issue)
ORA-28785: unable to initialize SSL  → wallet password incorrect or wallet corrupt
\`\`\`

### Monitoring Script Management

\`\`\`bash
# Run immediately
/opt/oracle/scripts/wallet_monitor/oracle_wallet_cert_monitor.sh

# Run with debug output to console
bash -x /opt/oracle/scripts/wallet_monitor/oracle_wallet_cert_monitor.sh 2>&1 | head -50

# View recent log
tail -100 /opt/oracle/scripts/wallet_monitor/logs/wallet_monitor.log

# Check crontab entries
crontab -l | grep wallet

# Update recipient list without editing script
sed -i 's/^RECIPIENT_LIST=.*/RECIPIENT_LIST=new-dba@example.com,old-dba@example.com/' \
  /opt/oracle/scripts/wallet_monitor/wallet_monitor.conf
\`\`\`

---

## Summary

This runbook deploys a fully automated Oracle Wallet certificate monitoring solution targeting the EBS Integrated SOA Gateway database-tier wallet — the PKCS12 container that \`UTL_HTTP\` uses to validate SSL trust chains for all outbound SOAP and REST calls. Certificate failures in this wallet surface as ORA-29273 / ORA-29024 errors in ISG at runtime, with no prior warning if monitoring is absent.

The deployed solution runs as the \`oracle\` OS user, extracts all certificates from \`ewallet.p12\` via \`openssl pkcs12\`, applies configurable WARN_DAYS and CRIT_DAYS expiry thresholds against every certificate's Not After date, and compares each certificate's SHA-256 fingerprint against the vendor certificate reference store. Alerts — including the certificate label, expiry date, and fingerprint delta on mismatch — are delivered via \`sendmail\` to the Apps DBA recipient list and to a separate oncall list for CRITICAL severity events.

The crontab runs the monitor at 06:00 and 18:00 daily. The vendor reference store requires updates when certificate authorities reissue intermediates — the fingerprint comparison enforces this discipline by alerting when wallet and reference diverge in either direction. The supplemental ISG endpoint SSL test script validates end-to-end connectivity after any wallet change, confirming that \`openssl s_client\` with the wallet's trusted CAs can complete a handshake to each configured external endpoint before the change is considered complete.`,
};

async function main() {
  console.log('Inserting Oracle Wallet certificate monitoring runbook...');
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
