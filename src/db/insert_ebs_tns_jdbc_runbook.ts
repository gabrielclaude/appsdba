import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-custom-jdbc-tns-descriptors-runbook';

const content = `
## Purpose

Inject and validate custom Oracle Net connection descriptor parameters — such as \`(ENABLE=BROKEN)\` for dead connection detection — across EBS 11i, 12.1.3, and 12.2.x, and confirm that each parameter survives an AutoConfig cycle. Includes an automated validation script and cron scheduling instructions.

---

## Phase 1 — Capture the Existing Descriptor Before Changing Anything

This step is critical. Construct the new descriptor by modifying the live value, not from memory. A missed \`ADDRESS\` entry, \`FAILOVER=on\`, or \`LOAD_BALANCE\` flag in a RAC environment is easy to lose in transcription.

\`\`\`bash
# EBS 12.1.3 and 12.2 — application tier
source \$EBS_ENV_FILE   # e.g. /u01/oracle/EBS/EBSapps.env run

echo "=== Current JDBC descriptor in context file ==="
grep -A 10 's_apps_jdbc_connect_descriptor' "\$CONTEXT_FILE" | head -12

echo ""
echo "=== Current tnsnames.ora (app tier) ==="
cat "\$TNS_ADMIN/tnsnames.ora"

echo ""
echo "=== Current tnsnames.ora entry for primary service ==="
grep -A 12 'EBSPROD' "\$TNS_ADMIN/tnsnames.ora" | head -15
\`\`\`

Save both outputs before making any change.

---

## Phase 2 — Inject the Custom Parameter

### EBS 11i

\`\`\`bash
# Source the 11i environment
source \$APPL_TOP/APPSORA.env

# --- Application tier: appsweb.cfg ---
TEMPLATE_DIR="\$FND_TOP/admin/template"
mkdir -p "\$TEMPLATE_DIR/custom"

# Back up before modifying
cp "\$TEMPLATE_DIR/appsweb.cfg" "\$TEMPLATE_DIR/custom/appsweb.cfg"

# Edit custom/appsweb.cfg — add (ENABLE=BROKEN) after (DESCRIPTION= in connectString
vi "\$TEMPLATE_DIR/custom/appsweb.cfg"

# --- Database tier: adxdbctx.tmp ---
DB_TEMPLATE_DIR="\$ORACLE_HOME/appsutil/template"
mkdir -p "\$DB_TEMPLATE_DIR/custom"

cp "\$DB_TEMPLATE_DIR/adxdbctx.tmp" "\$DB_TEMPLATE_DIR/custom/adxdbctx.tmp"

# Edit custom/adxdbctx.tmp — insert (ENABLE=BROKEN) after (DESCRIPTION=
vi "\$DB_TEMPLATE_DIR/custom/adxdbctx.tmp"

# Run AutoConfig — application tier first, then database tier
"\$ADMIN_SCRIPTS_HOME/adautoconfig.sh"
# Then on the database server:
# "\$ORACLE_HOME/appsutil/scripts/\$CONTEXT_NAME/adautoconfig.sh"
\`\`\`

### EBS 12.1.3

\`\`\`bash
source \$APPL_TOP/APPSORA.env   # or equivalent 12.1.3 env script

# --- JDBC descriptor in context file ---
# 1. Read the current value
CURRENT=\$(grep -A5 's_apps_jdbc_connect_descriptor' "\$CONTEXT_FILE" | grep -v 'oa_var' | tr -d '\\n' | sed 's/.*>//;s/<.*//')
echo "Current: \$CURRENT"

# 2. Construct new value: prepend (ENABLE=BROKEN) immediately after (DESCRIPTION=
#    Edit $CONTEXT_FILE directly — safe in 12.1.3 (context file is the source of record)
vi "\$CONTEXT_FILE"
# Find: s_apps_jdbc_connect_descriptor
# Change: (DESCRIPTION= to (DESCRIPTION=(ENABLE=BROKEN)

# --- TNS template ---
mkdir -p "\$FND_TOP/admin/template/custom"
[ ! -f "\$FND_TOP/admin/template/custom/aftnsnm.tmp" ] && \
  cp "\$FND_TOP/admin/template/aftnsnm.tmp" "\$FND_TOP/admin/template/custom/aftnsnm.tmp"

vi "\$FND_TOP/admin/template/custom/aftnsnm.tmp"
# Add (ENABLE=BROKEN) after (DESCRIPTION= in each target descriptor block

# Run AutoConfig
"\$ADMIN_SCRIPTS_HOME/adautoconfig.sh"
\`\`\`

### EBS 12.2.x — RUN Edition

\`\`\`bash
source /u01/oracle/EBS/EBSapps.env run

# 1. Read current value before modifying
grep -A 8 's_apps_jdbc_connect_descriptor' "\$CONTEXT_FILE"

# 2. Update via txkSetContextParam.pl (do not hand-edit the context XML in 12.2)
# Replace the -paramvalue with your complete descriptor including (ENABLE=BROKEN):
perl "\$FND_TOP/bin/txkSetContextParam.pl" \\
  -contextfile="\$CONTEXT_FILE" \\
  -paramname=s_apps_jdbc_connect_descriptor \\
  -paramvalue="(DESCRIPTION=(ENABLE=BROKEN)(ADDRESS_LIST=(ADDRESS=(PROTOCOL=TCP)(HOST=ebsdb01.corp.example.com)(PORT=1521)))(CONNECT_DATA=(SERVICE_NAME=EBSPROD)))"

# 3. Set up the TNS custom template (one-time)
mkdir -p "\$FND_TOP/admin/template/custom"
[ ! -f "\$FND_TOP/admin/template/custom/aftnsnm.tmp" ] && \
  cp "\$FND_TOP/admin/template/aftnsnm.tmp" "\$FND_TOP/admin/template/custom/aftnsnm.tmp"

vi "\$FND_TOP/admin/template/custom/aftnsnm.tmp"
# Add (ENABLE=BROKEN) after (DESCRIPTION= in target descriptor blocks

# 4. Run AutoConfig on RUN edition
"\$ADMIN_SCRIPTS_HOME/adautoconfig.sh"
\`\`\`

### EBS 12.2.x — PATCH Edition (if adop session is open)

\`\`\`bash
source /u01/oracle/EBS/EBSapps.env patch

perl "\$FND_TOP/bin/txkSetContextParam.pl" \\
  -contextfile="\$CONTEXT_FILE" \\
  -paramname=s_apps_jdbc_connect_descriptor \\
  -paramvalue="(DESCRIPTION=(ENABLE=BROKEN)(ADDRESS_LIST=(ADDRESS=(PROTOCOL=TCP)(HOST=ebsdb01.corp.example.com)(PORT=1521)))(CONNECT_DATA=(SERVICE_NAME=EBSPROD)))"

# Verify the custom template exists in the patch edition too
ls "\$FND_TOP/admin/template/custom/aftnsnm.tmp"

"\$ADMIN_SCRIPTS_HOME/adautoconfig.sh"
\`\`\`

---

## Phase 3 — Post-AutoConfig Validation

Run these checks immediately after every AutoConfig execution to confirm the parameters survived.

\`\`\`bash
#!/bin/bash
# Quick post-AutoConfig validation — run after adautoconfig.sh completes

PARAM="ENABLE=BROKEN"   # change to your target parameter if different
PASS=0; FAIL=0

check() {
  local DESC="\$1"; local FILE="\$2"; local SEARCH="\$3"
  if grep -qi "\$SEARCH" "\$FILE" 2>/dev/null; then
    echo "  PASS: \$DESC"
    PASS=\$((PASS+1))
  else
    echo "  FAIL: \$DESC"
    echo "        File: \$FILE"
    FAIL=\$((FAIL+1))
  fi
}

echo "=== Post-AutoConfig TNS/JDBC Validation ==="
echo "Parameter: \$PARAM"
echo ""

# Source run environment
source /u01/oracle/EBS/EBSapps.env run 2>/dev/null || source "\$APPL_TOP/APPSORA.env" 2>/dev/null

echo "--- RUN edition ---"
check "tnsnames.ora (app tier)"             "\$TNS_ADMIN/tnsnames.ora"     "\$PARAM"
check "JDBC descriptor in context file"     "\$CONTEXT_FILE"               "\$PARAM"

# 12.2 only — check patch edition
if [ -f /u01/oracle/EBS/EBSapps.env ]; then
  source /u01/oracle/EBS/EBSapps.env patch 2>/dev/null
  echo ""
  echo "--- PATCH edition ---"
  check "tnsnames.ora (patch edition)"      "\$TNS_ADMIN/tnsnames.ora"     "\$PARAM"
  check "JDBC descriptor (patch edition)"   "\$CONTEXT_FILE"               "\$PARAM"
fi

echo ""
echo "Result: \$PASS passed, \$FAIL failed"
[ "\$FAIL" -gt 0 ] && exit 1 || exit 0
\`\`\`

---

## Automated Validation Script

Save to \`/u01/scripts/ebs_tns_validate.sh\`. Designed for both interactive use and cron scheduling.

\`\`\`bash
#!/bin/bash
# ebs_tns_validate.sh
# Validates that custom Oracle Net parameters are present in all generated
# TNS and JDBC configuration files after every AutoConfig cycle.
# Exit 0 = all parameters present. Exit 1 = one or more missing.
#
# Usage:
#   bash ebs_tns_validate.sh                    # uses defaults
#   bash ebs_tns_validate.sh "ENABLE=BROKEN"    # override target parameter
#   bash ebs_tns_validate.sh "RECV_BUF_SIZE"    # any custom Net parameter

set -euo pipefail

# --- Configuration ---
TARGET_PARAM="\${1:-ENABLE=BROKEN}"
ALERT_EMAIL="dba-alerts@corp.example.com"
LOG_DIR="/u01/logs/tns_validate"
LOG_FILE="\$LOG_DIR/tns_validate_\$(date +%Y%m%d).log"
EBS_ENV="/u01/oracle/EBS/EBSapps.env"    # 12.2 env script; adjust for 11i/12.1.3

mkdir -p "\$LOG_DIR"

log()    { echo "\$(date '+%Y-%m-%d %H:%M:%S') \$1" | tee -a "\$LOG_FILE"; }
pass()   { log "  PASS: \$1"; }
fail()   { log "  FAIL: \$1 — \$2"; FAILURES=\$((FAILURES+1)); FAIL_MSGS="\${FAIL_MSGS}\\n  ✗ \$1: \$2"; }
section(){ log ""; log "=== \$1 ==="; }

FAILURES=0
FAIL_MSGS=""

log "EBS TNS/JDBC Parameter Validation"
log "Target parameter : \$TARGET_PARAM"
log "Host             : \$(hostname)"

# --- Detect EBS version / environment ---
if [ -f "\$EBS_ENV" ]; then
  # 12.2
  EBS_VERSION="12.2"
  source "\$EBS_ENV" run > /dev/null 2>&1
elif [ -n "\${APPL_TOP:-}" ]; then
  EBS_VERSION="legacy"
else
  log "ERROR: EBS environment not sourced and \$EBS_ENV not found"
  exit 1
fi

log "EBS version      : \$EBS_VERSION"

# Helper: check a file for the target parameter
check_file() {
  local LABEL="\$1"
  local FILE="\$2"
  if [ ! -f "\$FILE" ]; then
    fail "\$LABEL" "File not found: \$FILE"
    return
  fi
  if grep -qi "\$TARGET_PARAM" "\$FILE" 2>/dev/null; then
    pass "\$LABEL"
  else
    fail "\$LABEL" "\$TARGET_PARAM not found in \$FILE"
  fi
}

# Helper: display the descriptor from a file
show_descriptor() {
  local LABEL="\$1"
  local FILE="\$2"
  local GREP_PATTERN="\$3"
  log "  [\$LABEL] relevant excerpt:"
  grep -A 10 "\$GREP_PATTERN" "\$FILE" 2>/dev/null | head -12 | while read LINE; do
    log "    \$LINE"
  done
}

# ─── RUN edition checks ───────────────────────────────────────────────────────
section "RUN Edition"

# tnsnames.ora
check_file "tnsnames.ora (app tier — run)" "\$TNS_ADMIN/tnsnames.ora"

# JDBC descriptor in context file
check_file "Context file JDBC descriptor (run)" "\$CONTEXT_FILE"

# Custom template — should be source of truth
CUSTOM_TNS="\$FND_TOP/admin/template/custom/aftnsnm.tmp"
if [ -f "\$CUSTOM_TNS" ]; then
  check_file "Custom aftnsnm.tmp template (run)" "\$CUSTOM_TNS"
else
  log "  INFO: No custom aftnsnm.tmp in \$FND_TOP/admin/template/custom/ — manual TNS edits may not survive AutoConfig"
fi

# Show excerpt for diagnostic context
show_descriptor "tnsnames.ora snippet" "\$TNS_ADMIN/tnsnames.ora" "EBSPROD"

# ─── PATCH edition checks (12.2 only) ─────────────────────────────────────────
if [ "\$EBS_VERSION" = "12.2" ]; then
  section "PATCH Edition"

  source "\$EBS_ENV" patch > /dev/null 2>&1

  check_file "tnsnames.ora (app tier — patch)" "\$TNS_ADMIN/tnsnames.ora"
  check_file "Context file JDBC descriptor (patch)" "\$CONTEXT_FILE"

  CUSTOM_TNS_PATCH="\$FND_TOP/admin/template/custom/aftnsnm.tmp"
  if [ -f "\$CUSTOM_TNS_PATCH" ]; then
    check_file "Custom aftnsnm.tmp template (patch)" "\$CUSTOM_TNS_PATCH"
  else
    log "  INFO: No custom aftnsnm.tmp in patch edition — parameter may be lost after cutover"
  fi

  # Switch back to run
  source "\$EBS_ENV" run > /dev/null 2>&1
fi

# ─── Database tier tnsnames.ora (optional — if accessible via SSH or shared mount) ─
section "Database Tier (if accessible)"
DB_TNS_CANDIDATES=(
  "/u01/oracle/product/19c/db/network/admin/tnsnames.ora"
  "/u01/oracle/product/12.1.0/db/network/admin/tnsnames.ora"
)
DB_FOUND=0
for DB_TNS in "\${DB_TNS_CANDIDATES[@]}"; do
  if [ -f "\$DB_TNS" ]; then
    check_file "tnsnames.ora (DB tier)" "\$DB_TNS"
    DB_FOUND=1
    break
  fi
done
[ "\$DB_FOUND" -eq 0 ] && log "  INFO: DB-tier tnsnames.ora not accessible from this host — validate manually on DB server"

# ─── sqlnet.ora keepalive cross-check ─────────────────────────────────────────
section "sqlnet.ora Cross-Check"
if [ -f "\$TNS_ADMIN/sqlnet.ora" ]; then
  EXPIRE=\$(grep -i 'SQLNET.EXPIRE_TIME' "\$TNS_ADMIN/sqlnet.ora" 2>/dev/null | head -1)
  if [ -n "\$EXPIRE" ]; then
    log "  INFO: \$EXPIRE (SQL*Net keepalive probe interval is configured)"
  else
    log "  WARN: SQLNET.EXPIRE_TIME not set in \$TNS_ADMIN/sqlnet.ora"
    log "        Consider adding: SQLNET.EXPIRE_TIME = 10"
  fi
fi

# ─── Summary ──────────────────────────────────────────────────────────────────
section "Summary"
log "Checks passed : \$((FAILURES == 0 ? 1 : 0)) — Failures: \$FAILURES"

if [ "\$FAILURES" -gt 0 ]; then
  log "FAILED — \$FAILURES check(s) did not find '\$TARGET_PARAM'"
  log "Missing in:\$FAIL_MSGS"
  log ""
  log "Recovery steps:"
  log "  12.2: perl \$FND_TOP/bin/txkSetContextParam.pl -contextfile=\$CONTEXT_FILE \\"
  log "          -paramname=s_apps_jdbc_connect_descriptor \\"
  log "          -paramvalue='(DESCRIPTION=(\$TARGET_PARAM)(...))'"
  log "        then: \$ADMIN_SCRIPTS_HOME/adautoconfig.sh"
  log "  12.1.3: edit \$CONTEXT_FILE directly, then adautoconfig.sh"
  log "  11i: edit \$FND_TOP/admin/template/custom/appsweb.cfg, then adautoconfig.sh"

  # Send alert
  {
    echo "EBS TNS/JDBC validation failed on \$(hostname)"
    echo "Target parameter: \$TARGET_PARAM"
    echo ""
    echo "Missing in:\$FAIL_MSGS"
    echo ""
    echo "Log: \$LOG_FILE"
  } | mail -s "[EBS Alert] TNS parameter missing: \$TARGET_PARAM" "\$ALERT_EMAIL" 2>/dev/null || true

  exit 1
fi

log "All checks passed — \$TARGET_PARAM is present in all required files"
exit 0
\`\`\`

---

## Scheduling Instructions

### Setup

\`\`\`bash
# Copy script to scripts directory
cp ebs_tns_validate.sh /u01/scripts/ebs_tns_validate.sh
chmod 750 /u01/scripts/ebs_tns_validate.sh
chown applmgr:oinstall /u01/scripts/ebs_tns_validate.sh

# Create log directory
mkdir -p /u01/logs/tns_validate
chown applmgr:oinstall /u01/logs/tns_validate

# Create wrapper that sources the OS environment
cat > /u01/scripts/ebs_tns_validate_wrapper.sh << 'WRAPPER'
#!/bin/bash
# Cron wrapper — environment variables are not inherited from cron
export ORACLE_BASE=/u01/oracle
source /u01/oracle/EBS/EBSapps.env run > /dev/null 2>&1
exec /u01/scripts/ebs_tns_validate.sh "ENABLE=BROKEN"
WRAPPER

chmod 750 /u01/scripts/ebs_tns_validate_wrapper.sh
chown applmgr:oinstall /u01/scripts/ebs_tns_validate_wrapper.sh
\`\`\`

### Add to crontab (as applmgr)

\`\`\`bash
crontab -e
\`\`\`

\`\`\`cron
# Validate TNS/JDBC custom parameters daily and after every AutoConfig window
# Daily at 06:00 — catches any overnight AutoConfig cycle that stripped the parameter
0 6 * * * /u01/scripts/ebs_tns_validate_wrapper.sh >> /u01/logs/tns_validate/cron.log 2>&1

# Also run at 10:00 and 14:00 Mon-Fri — business-hours coverage
0 10,14 * * 1-5 /u01/scripts/ebs_tns_validate_wrapper.sh >> /u01/logs/tns_validate/cron.log 2>&1

# Log cleanup — 30-day retention
0 3 * * * find /u01/logs/tns_validate -name "*.log" -mtime +30 -delete
\`\`\`

### Run manually after every AutoConfig cycle

\`\`\`bash
# Run immediately after adautoconfig.sh completes to confirm parameters survived
/u01/scripts/ebs_tns_validate_wrapper.sh
echo "Exit: \$?"

# Or run inline with a specific parameter to validate
bash /u01/scripts/ebs_tns_validate.sh "ENABLE=BROKEN"
bash /u01/scripts/ebs_tns_validate.sh "RECV_BUF_SIZE"
bash /u01/scripts/ebs_tns_validate.sh "SQLNET.EXPIRE_TIME"
\`\`\`

---

## Quick Reference: Where to Make Each Change

| What to change | 11i | 12.1.3 | 12.2.x |
|---|---|---|---|
| JDBC connect string | \`\$FND_TOP/admin/template/custom/appsweb.cfg\` | Edit \`s_apps_jdbc_connect_descriptor\` in \`\$CONTEXT_FILE\` directly | \`txkSetContextParam.pl\` — run on both RUN and PATCH editions |
| App-tier tnsnames.ora | \`\$FND_TOP/admin/template/custom/aftnsnm.tmp\` | \`\$FND_TOP/admin/template/custom/aftnsnm.tmp\` | \`\$FND_TOP/admin/template/custom/aftnsnm.tmp\` — in both editions |
| DB-tier tnsnames.ora | \`\$ORACLE_HOME/appsutil/template/custom/adxdbctx.tmp\` | \`\$ORACLE_HOME/appsutil/template/custom/adxdbctx.tmp\` | Managed outside adop; edit DB-tier custom template directly |
| After change: run | \`adautoconfig.sh\` (app) + \`adautoconfig.sh\` (DB) | \`adautoconfig.sh\` (app) | \`adautoconfig.sh\` (run edition) + \`adautoconfig.sh\` (patch edition) |
| Validate with | \`ebs_tns_validate.sh\` | \`ebs_tns_validate.sh\` | \`ebs_tns_validate.sh\` (checks both editions) |

---

## Key Rule

Never edit the generated output files directly:

| File | Do not edit | Edit instead |
|---|---|---|
| \`\$TNS_ADMIN/tnsnames.ora\` | Generated by AutoConfig | Custom template (\`aftnsnm.tmp\`) |
| \`\$CONTEXT_FILE\` (12.2) | Risk of edition sync overwrite | \`txkSetContextParam.pl\` |
| \`\$CONTEXT_FILE\` (12.1.3) | Safe to edit — it is the source | Edit directly |
| \`appsweb.cfg\` (11i) | Generated | \`\$FND_TOP/admin/template/custom/appsweb.cfg\` |
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'Preserving Custom JDBC and TNS Descriptors Across EBS Generations: Runbook',
    slug,
    excerpt: 'Runbook for injecting and permanently protecting custom Oracle Net parameters (ENABLE=BROKEN and others) across EBS 11i, 12.1.3, and 12.2 AutoConfig cycles. Covers per-version injection procedures, patch-edition synchronisation in 12.2, automated validation script with email alerting, cron scheduling instructions, and quick-reference tables.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
