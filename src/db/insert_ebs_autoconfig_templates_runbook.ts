import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-autoconfig-appl-top-templates-runbook';

const content = `
This runbook covers the operational procedures for working with Oracle EBS AutoConfig templates: locating templates, tracing generated files back to their source, making durable configuration changes, and validating AutoConfig output. It includes an automated validation script that detects hand-edits to generated files before they are lost.

---

## Phase 1 — Environment Setup

Source the EBS environment before running any AutoConfig or template operations.

\`\`\`bash
# EBS 11i
. $APPL_TOP/APPSORA.env

# EBS 12.1.3
. $INST_TOP/ora/10.1.2/EBSapps.env

# EBS 12.2.x (run edition — always use run unless inside an adop apply)
. $EBS_DOMAIN_HOME/EBSapps.env run

# Confirm environment
echo "CONTEXT_FILE: $CONTEXT_FILE"
echo "APPL_TOP:     $APPL_TOP"
echo "AD_TOP:       $AD_TOP"
echo "TWO_TASK:     $TWO_TASK"
\`\`\`

---

## Phase 2 — Locate Templates

\`\`\`bash
# List all templates for the FND product top
find $FND_TOP/admin/template -name "*.tmp" | sort

# Find template for a specific generated file
find $APPL_TOP -name "httpd.conf.tmp"     # Apache config
find $APPL_TOP -name "tnsnames.ora.tmp"   # TNS descriptors
find $APPL_TOP -name "default.env.tmp"    # Forms environment
find $APPL_TOP -name "APPSORA.env.tmp"    # EBS environment script
find $APPL_TOP -name "wdbsvr.app.tmp"     # WebDB settings

# In 12.2.x, also check the patch edition template set
. $EBS_DOMAIN_HOME/EBSapps.env patch
find $FND_TOP/admin/template -name "tnsnames.ora.tmp"
. $EBS_DOMAIN_HOME/EBSapps.env run   # restore run edition env
\`\`\`

---

## Phase 3 — Trace a Generated File to Its Template

\`\`\`bash
# The AutoConfig driver file maps templates to output files
DRIVER=$AD_TOP/admin/driver/adautocfg.drv

# Find which template produces tnsnames.ora
grep -i "tnsnames" $DRIVER

# Find which template produces httpd.conf
grep -i "httpd.conf" $DRIVER

# Find which template produces the Forms default.env
grep -i "default.env" $DRIVER

# Show full driver entry (template → output path → perms)
grep -A2 "tnsnames.ora.tmp" $DRIVER | head -20
\`\`\`

---

## Phase 4 — Find the Token Controlling a Value

\`\`\`bash
# Find which template token controls FORMS_CATCHTERM
grep -rn "FORMS_CATCHTERM" $APPL_TOP/admin/template/ $FND_TOP/admin/template/ 2>/dev/null

# Find the token for PARALLEL_EXECUTION_MESSAGE_SIZE
grep -rn "PARALLEL_EXECUTION_MESSAGE_SIZE" $APPL_TOP/admin/template/ 2>/dev/null

# Find token for a specific hostname or service name
grep -rn "%s_dbhost%" $FND_TOP/admin/template/tnsnames.ora.tmp

# List all tokens in a template
grep -o '%[^%]*%' $FND_TOP/admin/template/tnsnames.ora.tmp | sort -u
\`\`\`

---

## Phase 5 — Check Context File for a Parameter

\`\`\`bash
# Find a parameter value in the context file
grep "s_dbhost" $CONTEXT_FILE
grep "s_forms_catchterm" $CONTEXT_FILE
grep "s_parallel" $CONTEXT_FILE

# Show parameter with surrounding XML context (3 lines)
grep -A3 "s_dbhost" $CONTEXT_FILE | head -20

# List all parameter names in the context file
grep 'oa_var=' $CONTEXT_FILE | sed 's/.*oa_var="\\([^"]*\\)".*/\\1/' | sort
\`\`\`

---

## Phase 6 — Change a Context Parameter

### EBS 11i and 12.1.3 — direct XML edit

\`\`\`bash
# Back up context file
cp \$CONTEXT_FILE \${CONTEXT_FILE}.bak.\$(date +%Y%m%d%H%M)

# Edit context file directly
# Change: <s_forms_catchterm oa_var="s_forms_catchterm">0</s_forms_catchterm>
# To:     <s_forms_catchterm oa_var="s_forms_catchterm">1</s_forms_catchterm>
vi $CONTEXT_FILE

# Verify the change
grep "s_forms_catchterm" $CONTEXT_FILE
\`\`\`

### EBS 12.2.x — use txkSetContextParam.pl (AutoConfig-safe)

\`\`\`bash
# Set a context parameter safely without hand-editing XML
perl $FND_TOP/patch/115/bin/txkSetContextParam.pl \
  --contextfile=$CONTEXT_FILE \
  --name=s_forms_catchterm \
  --value=1

# Verify
grep "s_forms_catchterm" $CONTEXT_FILE

# Set multiple parameters
for param in "s_forms_catchterm:1" "s_ohs_ssl_port:443"; do
  name=\${param%%:*}
  value=\${param##*:}
  perl $FND_TOP/patch/115/bin/txkSetContextParam.pl \
    --contextfile=$CONTEXT_FILE \
    --name=$name \
    --value=$value
done
\`\`\`

---

## Phase 7 — Run AutoConfig

\`\`\`bash
# Run AutoConfig (all versions — sources correct env first)
$AD_TOP/bin/adautocfg.sh

# Supply apps password if prompted (or use apps/<password> argument in some versions)
# In 12.2.x you may need to supply the WebLogic admin password as well

# Monitor log in real time
LOG=$(ls -t $APPL_TOP/admin/$TWO_TASK/log/adconfig*.log 2>/dev/null | head -1)
[ -z "$LOG" ] && LOG=$(ls -t $INST_TOP/admin/log/adconfig*.log 2>/dev/null | head -1)
tail -f $LOG
\`\`\`

---

## Phase 8 — Validate AutoConfig Output

\`\`\`bash
# Check AutoConfig completed successfully
grep -E "AutoConfig completed|ERROR|FAILED" $LOG

# Verify the context parameter appeared in the generated file
# Forms environment
grep "FORMS_CATCHTERM" $INST_TOP/ora/10.1.2/forms/server/default.env

# TNS descriptors
grep -A5 "MYAPP_SVC" $TNS_ADMIN/tnsnames.ora

# Apache config port
grep "Listen " $INST_TOP/ora/10.1.2/Apache/Apache/conf/httpd.conf | head -3

# EBS environment script
grep "TWO_TASK" $INST_TOP/ora/10.1.2/EBSapps.env | head -5
\`\`\`

---

## Phase 9 — Add a Custom TNS Entry via Template

\`\`\`bash
TEMPLATE=$(find $APPL_TOP -name "tnsnames.ora.tmp" | head -1)
echo "Template: $TEMPLATE"

# Back up
cp \$TEMPLATE \${TEMPLATE}.bak.\$(date +%Y%m%d)

# Add custom context variable to context file (11i/12.1.3)
# Or use txkSetContextParam.pl (12.2.x)
# Variable: s_custom_app_svc = MYAPP_SVC

# Append custom TNS entry to template
cat >> $TEMPLATE << 'EOF'

%s_custom_app_svc% =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = %s_apphost%)(PORT = %s_dbport%))
    (CONNECT_DATA =
      (SERVICE_NAME = %s_custom_app_svc%)
      (ENABLE = BROKEN)
    )
  )
EOF

# Run AutoConfig and verify
$AD_TOP/bin/adautocfg.sh
grep -A8 "MYAPP_SVC" $TNS_ADMIN/tnsnames.ora
\`\`\`

---

## Phase 10 — Post-AutoConfig Hook (12.2.x)

\`\`\`bash
# Create hook directory
mkdir -p $AD_TOP/custom

HOOK=$AD_TOP/custom/post_autoconfig_custom_tns.sh
cat > $HOOK << 'HOOK_EOF'
#!/bin/bash
# Post-AutoConfig hook: append custom TNS entries that are not in templates

TNSFILE=$TNS_ADMIN/tnsnames.ora
MARKER="# CUSTOM_ENTRIES_START"

if grep -q "$MARKER" "$TNSFILE"; then
  echo "Custom TNS entries already present in $TNSFILE"
  exit 0
fi

cat >> "$TNSFILE" << 'TNSEOF'

# CUSTOM_ENTRIES_START — managed by post_autoconfig_custom_tns.sh
MYAPP_SVC =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = appserver.example.com)(PORT = 1521))
    (CONNECT_DATA =
      (SERVICE_NAME = myapp_service)
      (ENABLE = BROKEN)
    )
  )
# CUSTOM_ENTRIES_END
TNSEOF

echo "Appended custom TNS entries to $TNSFILE"
HOOK_EOF

chmod 750 $HOOK
echo "Hook installed: $HOOK"

# Verify AutoConfig picks it up on next run
$AD_TOP/bin/adautocfg.sh
grep "MYAPP_SVC" $TNS_ADMIN/tnsnames.ora
\`\`\`

---

## Automated Validation Script

Save as \`ebs_autoconfig_validate.sh\`. Run before and after AutoConfig, or on a schedule to detect unexpected hand-edits to generated files.

\`\`\`bash
#!/bin/bash
# ebs_autoconfig_validate.sh
# Validates AutoConfig-generated files against expected context values
# Usage: ./ebs_autoconfig_validate.sh [--alert-email ops@example.com]

set -euo pipefail

ALERT_EMAIL="\${1:-}"
ERRORS=0
WARNINGS=0
REPORT=/tmp/autoconfig_validate_\$(date +%Y%m%d_%H%M%S).txt

log() { echo "\$1" | tee -a "\$REPORT"; }
fail() { log "FAIL: \$1"; ((ERRORS++)); }
warn() { log "WARN: \$1"; ((WARNINGS++)); }
pass() { log "OK:   \$1"; }

log "===== EBS AutoConfig Validation ====="
log "Date:         $(date)"
log "CONTEXT_FILE: \${{CONTEXT_FILE:-NOT SET}}"
log "APPL_TOP:     \${{APPL_TOP:-NOT SET}}"
log ""

# ── 1. Context file exists ────────────────────────────────────────────────
if [ -z "\${{CONTEXT_FILE:-}}" ]; then
  fail "CONTEXT_FILE is not set. Source EBS environment first."
  exit 1
fi

if [ ! -f "$CONTEXT_FILE" ]; then
  fail "Context file not found: $CONTEXT_FILE"
  exit 1
fi

pass "Context file found: $CONTEXT_FILE"

# ── 2. Extract key context values ─────────────────────────────────────────
get_ctx() {
  grep -o "oa_var=\"$1\">[^<]*" "$CONTEXT_FILE" 2>/dev/null \
    | sed "s/oa_var=\"$1\">//" | head -1
}

CTX_DBHOST=$(get_ctx "s_dbhost")
CTX_DBPORT=$(get_ctx "s_dbport")
CTX_DBSID=$(get_ctx "s_dbSid")

log "Context DB host:  $CTX_DBHOST"
log "Context DB port:  $CTX_DBPORT"
log "Context DB SID:   $CTX_DBSID"
log ""

# ── 3. Check tnsnames.ora matches context ─────────────────────────────────
if [ -n "\${{TNS_ADMIN:-}}" ] && [ -f "$TNS_ADMIN/tnsnames.ora" ]; then
  if grep -q "$CTX_DBHOST" "$TNS_ADMIN/tnsnames.ora"; then
    pass "tnsnames.ora contains context DB host ($CTX_DBHOST)"
  else
    fail "tnsnames.ora does NOT contain context DB host ($CTX_DBHOST). Possible hand-edit or stale file."
  fi

  if grep -q "$CTX_DBSID" "$TNS_ADMIN/tnsnames.ora"; then
    pass "tnsnames.ora contains context DB SID ($CTX_DBSID)"
  else
    warn "tnsnames.ora does not contain context DB SID ($CTX_DBSID). May be using service name instead."
  fi
else
  warn "TNS_ADMIN not set or tnsnames.ora not found. Skipping TNS check."
fi

# ── 4. Check Forms default.env ────────────────────────────────────────────
DEFAULT_ENV=$(find "\${{INST_TOP:-/dev/null}}/ora" -name "default.env" 2>/dev/null | head -1)
if [ -f "\${{DEFAULT_ENV:-}}" ]; then
  pass "Found Forms default.env: $DEFAULT_ENV"

  CTX_TWO_TASK=$(get_ctx "s_dbSid")
  if grep -q "TWO_TASK=$CTX_TWO_TASK" "$DEFAULT_ENV"; then
    pass "default.env TWO_TASK matches context ($CTX_TWO_TASK)"
  else
    warn "default.env TWO_TASK may not match context value ($CTX_TWO_TASK)"
  fi
else
  warn "Forms default.env not found (may be 11i or 12.2 with different INST_TOP)"
fi

# ── 5. Check AutoConfig log for last run status ───────────────────────────
LAST_LOG=$(ls -t "\${APPL_TOP}/admin/\${{TWO_TASK:-NONE}}/log/adconfig"*.log \
           "\${{INST_TOP:-/dev/null}}/admin/log/adconfig"*.log 2>/dev/null \
           | head -1)

if [ -f "\${{LAST_LOG:-}}" ]; then
  LAST_RUN=$(stat -c %y "$LAST_LOG" 2>/dev/null || stat -f "%Sm" "$LAST_LOG" 2>/dev/null)
  log "Last AutoConfig log: $LAST_LOG"
  log "Last AutoConfig run: $LAST_RUN"

  if grep -q "AutoConfig completed successfully" "$LAST_LOG"; then
    pass "Last AutoConfig run completed successfully"
  elif grep -q "ERROR\|FAILED" "$LAST_LOG"; then
    fail "Last AutoConfig run contained errors. Check: $LAST_LOG"
  else
    warn "Cannot determine last AutoConfig run status from log"
  fi
else
  warn "No AutoConfig log found. Has AutoConfig been run in this environment?"
fi

# ── 6. Check for templates modified after last AutoConfig run ─────────────
log ""
log "=== Checking for template modifications newer than last generated files ==="

TNS_FILE="\${{TNS_ADMIN:-/dev/null}}/tnsnames.ora"
TNS_TEMPLATE=$(find "$APPL_TOP" -name "tnsnames.ora.tmp" 2>/dev/null | head -1)

if [ -f "$TNS_FILE" ] && [ -f "\${{TNS_TEMPLATE:-}}" ]; then
  if [ "$TNS_TEMPLATE" -nt "$TNS_FILE" ]; then
    warn "Template $TNS_TEMPLATE is newer than generated $TNS_FILE. AutoConfig may need to be re-run."
  else
    pass "tnsnames.ora.tmp is not newer than generated tnsnames.ora"
  fi
fi

# ── 7. Summary ────────────────────────────────────────────────────────────
log ""
log "===== Summary ====="
log "ERRORS:   $ERRORS"
log "WARNINGS: $WARNINGS"
log "Report:   $REPORT"

if [ -n "$ALERT_EMAIL" ] && [ "$ERRORS" -gt 0 ]; then
  mail -s "EBS AutoConfig Validation FAILED on $(hostname)" "$ALERT_EMAIL" < "$REPORT"
  log "Alert sent to $ALERT_EMAIL"
fi

[ "$ERRORS" -eq 0 ] && exit 0 || exit 1
\`\`\`

---

## Cron Scheduling

Run the validation script nightly to catch unexpected hand-edits or failed AutoConfig runs before they cause incidents.

\`\`\`bash
# Add to crontab as the oracle OS user
crontab -e

# Run validation at 06:00 daily, alert on failure
0 6 * * * /home/oracle/scripts/ebs_autoconfig_validate.sh --alert-email ops@example.com >> /home/oracle/logs/autoconfig_validate.log 2>&1

# Also validate immediately after any AutoConfig run
# Create wrapper: /home/oracle/scripts/run_autoconfig.sh
cat > /home/oracle/scripts/run_autoconfig.sh << 'EOF'
#!/bin/bash
. $EBS_DOMAIN_HOME/EBSapps.env run
$AD_TOP/bin/adautocfg.sh "$@"
EC=$?
if [ $EC -eq 0 ]; then
  /home/oracle/scripts/ebs_autoconfig_validate.sh --alert-email ops@example.com
fi
exit $EC
EOF
chmod 750 /home/oracle/scripts/run_autoconfig.sh
\`\`\`

---

## Version-Specific Notes

### EBS 11i (Release 11.5.x)

**Description:** AutoConfig in 11i operates against a single APPL_TOP and ORACLE_HOME. Context file is at \`$APPL_TOP/admin/<SID>/<context>.xml\`. Templates are in \`$FND_TOP/admin/template/\`. The post-AutoConfig hook mechanism does not exist in 11i — use template modification only.

**Action plan:**
1. Source environment: \`. $APPL_TOP/APPSORA.env\`
2. Back up context file: \`cp $CONTEXT_FILE $CONTEXT_FILE.bak.$(date +%Y%m%d)\`
3. Edit context file directly in vi to change parameter values.
4. Run AutoConfig: \`$AD_TOP/bin/adautocfg.sh\`
5. Verify: \`grep <expected_value> $TNS_ADMIN/tnsnames.ora\`

### EBS 12.1.3

**Description:** AutoConfig in 12.1.3 populates both \`$APPL_TOP\` and \`$INST_TOP\`. Context file is at \`$APPL_TOP/admin/<SID>/<context>.xml\`. Templates cover OC4J, OHS, Forms, and TNS configurations. Direct XML editing is safe.

**Action plan:**
1. Source environment: \`. $INST_TOP/ora/10.1.2/EBSapps.env\`
2. Back up context file: \`cp $CONTEXT_FILE $CONTEXT_FILE.bak.$(date +%Y%m%d)\`
3. Edit context XML to change parameter. Verify token in template with \`grep -n %token% $FND_TOP/admin/template/\`
4. Run AutoConfig: \`$AD_TOP/bin/adautocfg.sh\`
5. Restart affected services: OHS, OC4J, Forms as needed.

### EBS 12.2.x

**Description:** AutoConfig in 12.2.x runs on both run and patch editions. Use \`txkSetContextParam.pl\` for all context edits — direct XML editing can break edition metadata. Post-AutoConfig hooks in \`$AD_TOP/custom/\` are supported and preferred for persistent additions not covered by templates.

**Action plan:**
1. Source run edition: \`. $EBS_DOMAIN_HOME/EBSapps.env run\`
2. Set context parameter: \`perl $FND_TOP/patch/115/bin/txkSetContextParam.pl --contextfile=$CONTEXT_FILE --name=<token> --value=<value>\`
3. Run AutoConfig on run edition: \`$AD_TOP/bin/adautocfg.sh\`
4. Source patch edition and repeat AutoConfig: \`. $EBS_DOMAIN_HOME/EBSapps.env patch && $AD_TOP/bin/adautocfg.sh\`
5. Verify generated files on both editions contain the expected value.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'Oracle EBS AutoConfig Templates Runbook: Context File Management, Template Modification, and Validation',
    slug,
    excerpt: 'Operational runbook for working with Oracle EBS AutoConfig templates in $APPL_TOP. Covers locating templates, tracing generated files to their template source, changing context file parameters safely (direct edit for 11i/12.1.3, txkSetContextParam.pl for 12.2.x), adding custom TNS entries via template or post-AutoConfig hook, and an automated validation script that detects hand-edits to generated files before they are lost on the next AutoConfig run.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
