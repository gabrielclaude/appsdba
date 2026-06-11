import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'EBS ASCP MSCNSP Signal 11: Post-Clone Verification and Monitoring Runbook',
  slug: 'ebs-ascp-mscnsp-signal11-post-clone-runbook',
  excerpt:
    'Step-by-step runbook for resolving EBS ASCP Memory-Based Snapshot (MSCNSP) Signal 11 crashes after a production clone: OS ulimit configuration, 64-bit profile option restoration, MSCCPP relinking, planning data validation, and a monitoring script that detects MSCNSP failures before they block plan launches.',
  category: 'appsdba' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `## Scope

This runbook applies to Oracle EBS R12.2.x environments running Oracle Advanced Supply Chain Planning (ASCP) or Value Chain Planning. It covers Signal 11 (segmentation fault) crashes of the MSCNSP or MSCCPP concurrent program executable, specifically in environments that were recently cloned from production.

**Symptoms triggering this runbook:**
- Concurrent request log ends with: \`Program was terminated by signal 11\`
- MSCNSP or MSCPLAN request fails immediately without spawning child workers
- APP-MRP-22075 internal errors in mrnspxt or mrnspgpt routines
- Planning snapshot completes but plan launch fails with no data

---

## Phase 1: Baseline Information Gathering

### 1.1 Identify the failing request

\`\`\`sql
-- As APPS user — find the last MSCNSP failures
SELECT r.request_id,
       r.phase_code,
       r.status_code,
       r.actual_start_date,
       r.actual_completion_date,
       ROUND((r.actual_completion_date - r.actual_start_date) * 86400) AS duration_sec,
       r.logfile_name
FROM   fnd_concurrent_requests  r
JOIN   fnd_concurrent_programs  p
       ON  p.concurrent_program_id = r.concurrent_program_id
       AND p.application_id        = r.program_application_id
WHERE  p.concurrent_program_name IN ('MSCNSP', 'MSCCPP', 'MSCPLAN')
  AND  r.actual_start_date        > SYSDATE - 7
ORDER BY r.actual_start_date DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

### 1.2 Read the concurrent request log

\`\`\`bash
# Log path is in logfile_name column — tail the last 100 lines
tail -100 /u01/<inst>/fs_ne/EBSapps/log/msc/<REQUEST_ID>.req

# Search for signal or error keywords
grep -iE 'signal|segfault|core|APP-MRP|error' \
  /u01/<inst>/fs_ne/EBSapps/log/msc/<REQUEST_ID>.req
\`\`\`

### 1.3 Check the OS alert log for OOM kills

\`\`\`bash
# OOM killer would also produce Signal 11-like symptoms
grep -iE 'killed|oom|out of memory' /var/log/messages | tail -50
dmesg | grep -iE 'killed|oom' | tail -20
\`\`\`

---

## Phase 2: OS ulimit Configuration

All commands in this phase require **root** access. Perform as your system administrator if you do not have root.

### 2.1 Check current limits as the appldev user

\`\`\`bash
su - appldev -c "ulimit -a"
\`\`\`

Critical values to check:

| Parameter | Required | Typical Bad Value |
|-----------|----------|------------------|
| core file size | unlimited | 0 |
| stack size | unlimited | 10240 |

### 2.2 Permanently enable core dumps and expand stack

\`\`\`bash
# Edit limits.conf as root
vi /etc/security/limits.conf
\`\`\`

Add or update these lines (replace \`appldev\` with the actual EBS app-tier OS user):

\`\`\`
appldev  soft  core      unlimited
appldev  hard  core      unlimited
appldev  soft  stack     unlimited
appldev  hard  stack     unlimited
\`\`\`

Or use wildcards to apply to all users (check with your security team):

\`\`\`
*  soft  core  unlimited
*  hard  core  unlimited
*  soft  stack unlimited
*  hard  stack unlimited
\`\`\`

### 2.3 Ensure /etc/profile does not suppress core dumps

\`\`\`bash
grep ulimit /etc/profile /etc/bashrc /etc/profile.d/*.sh 2>/dev/null
\`\`\`

If any line reads \`ulimit -c 0\` or \`ulimit -S -c 0\`, comment it out. These override limits.conf at login time.

### 2.4 Set the core dump path

\`\`\`bash
# Direct core files to a known location with enough space
echo '/tmp/core.%e.%p' > /proc/sys/kernel/core_pattern

# Make permanent via sysctl
echo 'kernel.core_pattern = /tmp/core.%e.%p' >> /etc/sysctl.conf
sysctl -p
\`\`\`

### 2.5 Restart middle tier and re-verify

\`\`\`bash
su - appldev -c "source /u01/<inst>/fs1/EBSapps/appl/dev_<hostname>.env && \
  perl $AD_TOP/bin/adstrtal.pl apps/<APPSPASSWORD>"

# Verify limits are applied in the new session
su - appldev -c "ulimit -a" | grep -E 'core|stack'
# Expected:
# core file size (blocks, -c)  unlimited
# stack size (kbytes, -s)      unlimited
\`\`\`

---

## Phase 3: Check MSC 64-Bit Profile Options

### 3.1 Query current profile option values

\`\`\`sql
-- As APPS user
SELECT pov.level_id,
       DECODE(pov.level_id, 10001,'Site',10002,'App',10003,'Resp',10004,'User') AS level_name,
       po.profile_option_name,
       pov.profile_option_value
FROM   fnd_profile_options        po
JOIN   fnd_profile_option_values  pov
       ON pov.profile_option_id = po.profile_option_id
WHERE  po.profile_option_name IN (
         'MSC_64BIT_PLATFORM',
         'MSC_ENABLE_64BIT_SNAPSHOT',
         'MSC_NUM_OF_WORKERS'
       )
ORDER BY po.profile_option_name, pov.level_id;
\`\`\`

### 3.2 Required values

| Profile Option Name | Required Value | Notes |
|--------------------|---------------|-------|
| MSC_64BIT_PLATFORM | Linux 64 bit | Must match actual OS. Blank = treated as 32-bit |
| MSC_ENABLE_64BIT_SNAPSHOT | Y | Enables 64-bit memory addressing for the snapshot engine |
| MSC_NUM_OF_WORKERS | 4–8 (typical) | Should match CPU count; can be left at default |

### 3.3 Set profile options via UI

1. Log in as **SYSADMIN**
2. Navigate: **System Administrator → Profiles → System**
3. Search: \`MSC%\` at Site level
4. Set **MSC 64-bit Platform** to the correct OS value (Linux 64 bit for Oracle Linux x86_64)
5. Set **MSC Enable 64 bit snapshot** to **Yes**
6. Save

### 3.4 Verify via SQL after setting

\`\`\`sql
SELECT profile_option_name,
       profile_option_value
FROM   fnd_profile_option_values pov
JOIN   fnd_profile_options       po USING (profile_option_id)
WHERE  po.profile_option_name IN ('MSC_64BIT_PLATFORM','MSC_ENABLE_64BIT_SNAPSHOT')
  AND  pov.level_id = 10001;
-- Both rows must be present with non-null values
\`\`\`

---

## Phase 4: Relink the MSC Executable

Only required if Phase 3 does not resolve the Signal 11, or if the clone was performed via file system copy that may have produced a binary with mismatched shared library paths.

### 4.1 Run adadmin relink

\`\`\`bash
su - appldev
source /u01/<inst>/fs1/EBSapps/appl/dev_<hostname>.env
cd $ADMIN_SCRIPTS_HOME
perl adadmin.pl
\`\`\`

In adadmin menus:
- **Maintain Applications Executables** → **Relink Applications programs**
- Choose **MSC** product
- When prompted: **Specific executables?** → Yes
- Enter: \`MSCCPP\`
- **Enable link debug?** → Yes

### 4.2 Confirm clean relink

\`\`\`bash
grep -E 'exit|status|error|FAIL' \
  /u01/<inst>/fs_ne/EBSapps/log/adadmin/log/adrelink.log | tail -20
# Expected:
# adrelink is exiting with status 0
\`\`\`

### 4.3 Verify binary timestamp

\`\`\`bash
ls -la $MSC_TOP/bin/MSCNSP $MSC_TOP/bin/MSCCPP
# Timestamp should match the time of relink, not the clone timestamp
\`\`\`

---

## Phase 5: Planning Data Validation

When MSCNSP gets past Signal 11 but fails with APP-MRP-22075, the problem is in the planning data. Run these queries as **APPS** user before resubmitting.

### 5.1 Check for items with missing UOM

\`\`\`sql
SELECT COUNT(*) AS items_missing_uom
FROM   msc_system_items
WHERE  plan_id              = -1
  AND  primary_uom_code    IS NULL;
-- Expected: 0
\`\`\`

### 5.2 Check for null calendar boundaries

\`\`\`sql
SELECT calendar_code,
       calendar_start_date,
       calendar_end_date
FROM   msc_calendars
WHERE  calendar_start_date IS NULL
   OR  calendar_end_date   IS NULL;
-- Expected: no rows
\`\`\`

### 5.3 Verify org structure

\`\`\`sql
-- Count of distinct orgs in planning data vs HR org hierarchy
SELECT 'MSC orgs'  AS source, COUNT(DISTINCT organization_id) AS org_count
FROM   msc_system_items
WHERE  plan_id = -1
UNION ALL
SELECT 'HR orgs',  COUNT(*)
FROM   org_organization_definitions
WHERE  operating_unit IS NOT NULL;
\`\`\`

### 5.4 Check for invalid sourcing rules

\`\`\`sql
SELECT COUNT(*) AS bad_sourcing_rules
FROM   msc_sourcing_rules sr
WHERE  NOT EXISTS (
         SELECT 1 FROM msc_companies mc
         WHERE  mc.company_id = sr.company_id
       );
-- Expected: 0
\`\`\`

### 5.5 Check for orphaned BOM components

\`\`\`sql
SELECT COUNT(*) AS orphan_bom_rows
FROM   msc_bom_components bc
WHERE  NOT EXISTS (
         SELECT 1 FROM msc_bom_headers bh
         WHERE  bh.assembly_item_id  = bc.assembly_item_id
           AND  bh.organization_id   = bc.organization_id
           AND  bh.plan_id           = bc.plan_id
       )
  AND  bc.plan_id = -1;
-- Expected: 0
\`\`\`

---

## Phase 6: Enabling Debug Trace for Deeper Diagnosis

If the problem persists after all fixes above, capture a full SQL trace of the failing MSCNSP run.

### 6.1 Set debug profile options

As SYSADMIN, set at Site level:

| Profile Option | Value |
|---------------|-------|
| Concurrent: Allow Debugging | Yes |
| FND: Debug Log Enabled | Yes |
| FND: Debug Log Level | Statement |
| FND: Debug Log Module | \`%MSC%\` |

### 6.2 Submit MSCNSP with SQL trace

1. Navigate to the concurrent request submission form for the MSC plan
2. Before clicking **Submit**, click the **Debug** button
3. Select: **SQL Trace** → enable **Binds** and **Waits**
4. Submit the request

### 6.3 Locate and format the trace file

\`\`\`bash
# Find the trace file generated during this request
ORACLE_SID=<your_sid>
ls -lt $ORACLE_BASE/diag/rdbms/$ORACLE_SID/$ORACLE_SID/trace/*.trc | head -5

# Format with tkprof
tkprof /path/to/trace.trc /tmp/mscnsp_trace.txt \
  sort=exeela waits=yes sys=no
\`\`\`

---

## Phase 7: MSCNSP Monitoring Script

Save as \`/usr/local/bin/mscnsp_monitor.sh\` and schedule via cron. This script checks for Signal 11 failures in the last 24 hours, validates the 64-bit profile options, and verifies OS limits are correctly configured.

\`\`\`bash
#!/bin/bash
# mscnsp_monitor.sh — EBS ASCP MSCNSP health check
# Run as: appldev or a user with APPS DB access
# Schedule: 0 6 * * * /usr/local/bin/mscnsp_monitor.sh >> /var/log/mscnsp_monitor.log 2>&1

set -euo pipefail

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
ALERT_LOG="/var/log/mscnsp_monitor_alerts.log"
DB_CONNECT="\${ORACLE_USER:-apps}/\${ORACLE_PASS:-apps}@\${ORACLE_SID:-EBSPRD}"
FAILURES=0

log()   { echo "[$TIMESTAMP] $*"; }
alert() { echo "[$TIMESTAMP] ALERT: $*" | tee -a "$ALERT_LOG"; FAILURES=$((FAILURES + 1)); }

log "=== MSCNSP Monitor Start ==="

# -----------------------------------------------------------------------
# CHECK 1: Signal 11 failures in last 24 hours
# -----------------------------------------------------------------------
log "Checking for Signal 11 concurrent request failures..."

SIGNAL11_COUNT=$(sqlplus -s "$DB_CONNECT" <<'EOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT COUNT(*)
FROM   fnd_concurrent_requests  r
JOIN   fnd_concurrent_programs  p
       ON  p.concurrent_program_id = r.concurrent_program_id
       AND p.application_id        = r.program_application_id
WHERE  p.concurrent_program_name IN ('MSCNSP','MSCCPP','MSCPLAN')
  AND  r.status_code               = 'E'
  AND  r.actual_start_date         > SYSDATE - 1;
EXIT;
EOF
)

SIGNAL11_COUNT=$(echo "$SIGNAL11_COUNT" | tr -d '[:space:]')
if [[ "$SIGNAL11_COUNT" -gt 0 ]]; then
  alert "$SIGNAL11_COUNT MSCNSP/MSCPLAN request(s) failed in the last 24 hours"
  # Get details
  sqlplus -s "$DB_CONNECT" <<'EOF'
SET LINESIZE 200 PAGESIZE 50 HEADING ON
SELECT r.request_id,
       p.concurrent_program_name,
       TO_CHAR(r.actual_start_date,'YYYY-MM-DD HH24:MI') AS started,
       TO_CHAR(r.actual_completion_date,'YYYY-MM-DD HH24:MI') AS ended,
       r.logfile_name
FROM   fnd_concurrent_requests r
JOIN   fnd_concurrent_programs p
       ON p.concurrent_program_id = r.concurrent_program_id
       AND p.application_id       = r.program_application_id
WHERE  p.concurrent_program_name IN ('MSCNSP','MSCCPP','MSCPLAN')
  AND  r.status_code              = 'E'
  AND  r.actual_start_date        > SYSDATE - 1
ORDER BY r.actual_start_date DESC;
EXIT;
EOF
else
  log "No MSCNSP failures in last 24 hours. OK."
fi

# -----------------------------------------------------------------------
# CHECK 2: 64-bit profile options
# -----------------------------------------------------------------------
log "Checking MSC 64-bit profile options..."

PROFILE_CHECK=$(sqlplus -s "$DB_CONNECT" <<'EOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT COUNT(*)
FROM   fnd_profile_option_values  pov
JOIN   fnd_profile_options         po USING (profile_option_id)
WHERE  po.profile_option_name IN ('MSC_64BIT_PLATFORM','MSC_ENABLE_64BIT_SNAPSHOT')
  AND  pov.level_id                = 10001
  AND  pov.profile_option_value   IS NOT NULL;
EXIT;
EOF
)

PROFILE_CHECK=$(echo "$PROFILE_CHECK" | tr -d '[:space:]')
if [[ "$PROFILE_CHECK" -lt 2 ]]; then
  alert "One or both MSC 64-bit profile options are not set at Site level (found $PROFILE_CHECK of 2 required)"
  sqlplus -s "$DB_CONNECT" <<'EOF'
SET LINESIZE 120 PAGESIZE 20 HEADING ON
SELECT po.profile_option_name,
       NVL(pov.profile_option_value,'*** NOT SET ***') AS value
FROM   fnd_profile_options po
LEFT JOIN fnd_profile_option_values pov
       ON  pov.profile_option_id = po.profile_option_id
       AND pov.level_id          = 10001
WHERE  po.profile_option_name IN ('MSC_64BIT_PLATFORM','MSC_ENABLE_64BIT_SNAPSHOT');
EXIT;
EOF
else
  log "MSC 64-bit profile options: both set at Site level. OK."
fi

# -----------------------------------------------------------------------
# CHECK 3: OS ulimit for appldev
# -----------------------------------------------------------------------
log "Checking OS ulimit for app-tier user..."

CORE_LIMIT=$(su - appldev -c "ulimit -c" 2>/dev/null || echo "UNKNOWN")
STACK_LIMIT=$(su - appldev -c "ulimit -s" 2>/dev/null || echo "UNKNOWN")

if [[ "$CORE_LIMIT" != "unlimited" ]]; then
  alert "Core dump limit is '$CORE_LIMIT' for appldev — should be 'unlimited'. Signal 11 crashes will not produce core files."
else
  log "Core file limit: unlimited. OK."
fi

if [[ "$STACK_LIMIT" != "unlimited" ]]; then
  alert "Stack size limit is '$STACK_LIMIT' KB for appldev — should be 'unlimited'."
else
  log "Stack size limit: unlimited. OK."
fi

# -----------------------------------------------------------------------
# CHECK 4: Planning data sanity
# -----------------------------------------------------------------------
log "Running planning data validation queries..."

UOM_ISSUES=$(sqlplus -s "$DB_CONNECT" <<'EOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT COUNT(*) FROM msc_system_items
WHERE plan_id = -1 AND primary_uom_code IS NULL;
EXIT;
EOF
)
UOM_ISSUES=$(echo "$UOM_ISSUES" | tr -d '[:space:]')
if [[ "$UOM_ISSUES" -gt 0 ]]; then
  alert "$UOM_ISSUES item(s) in msc_system_items (plan_id=-1) have NULL primary_uom_code"
else
  log "UOM check: no null primary_uom_code. OK."
fi

CAL_ISSUES=$(sqlplus -s "$DB_CONNECT" <<'EOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT COUNT(*) FROM msc_calendars
WHERE calendar_start_date IS NULL OR calendar_end_date IS NULL;
EXIT;
EOF
)
CAL_ISSUES=$(echo "$CAL_ISSUES" | tr -d '[:space:]')
if [[ "$CAL_ISSUES" -gt 0 ]]; then
  alert "$CAL_ISSUES calendar record(s) have NULL start or end date"
else
  log "Calendar check: no null boundaries. OK."
fi

# -----------------------------------------------------------------------
# CHECK 5: MSCNSP binary age (detect stale clone binary)
# -----------------------------------------------------------------------
log "Checking MSCNSP binary timestamp..."

MSCNSP_PATH=$(su - appldev -c "echo \$MSC_TOP/bin/MSCNSP" 2>/dev/null)
if [[ -f "$MSCNSP_PATH" ]]; then
  BINARY_AGE_DAYS=$(( ( $(date +%s) - $(stat -c %Y "$MSCNSP_PATH") ) / 86400 ))
  if [[ "$BINARY_AGE_DAYS" -gt 30 ]]; then
    alert "MSCNSP binary at $MSCNSP_PATH is $BINARY_AGE_DAYS days old — consider relinking after a clone"
  else
    log "MSCNSP binary age: $BINARY_AGE_DAYS days. OK."
  fi
else
  alert "MSCNSP binary not found at $MSCNSP_PATH"
fi

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
log "=== Monitor Complete: $FAILURES alert(s) generated ==="

if [[ "$FAILURES" -gt 0 ]]; then
  echo ""
  echo "ACTION REQUIRED: $FAILURES issue(s) detected. See $ALERT_LOG for details."
  exit 1
else
  log "All checks passed."
  exit 0
fi
\`\`\`

### Schedule the monitor

\`\`\`bash
chmod +x /usr/local/bin/mscnsp_monitor.sh

# Add to appldev crontab — run daily at 6 AM
crontab -e
\`\`\`

Add:
\`\`\`
0 6 * * * /usr/local/bin/mscnsp_monitor.sh >> /var/log/mscnsp_monitor.log 2>&1
\`\`\`

To configure email alerting, pipe the output through \`mailx\`:
\`\`\`bash
0 6 * * * /usr/local/bin/mscnsp_monitor.sh | mailx -s "MSCNSP Health Check - $(hostname)" dba-alerts@example.com
\`\`\`

---

## Post-Clone Checklist (Quick Reference)

After every production-to-lower-environment clone, perform these steps **before** testing ASCP:

\`\`\`
[ ] Verify appldev ulimit -c = unlimited
[ ] Verify appldev ulimit -s = unlimited
[ ] Set MSC_64BIT_PLATFORM = Linux 64 bit   (System Admin → Profiles)
[ ] Set MSC_ENABLE_64BIT_SNAPSHOT = Yes      (System Admin → Profiles)
[ ] Run UOM validation query — COUNT(*) = 0
[ ] Run calendar validation query — COUNT(*) = 0
[ ] Run MSCNSP monitor script — exit 0
[ ] Submit MSCNSP test run — status = Complete Normal
\`\`\`

---

## Troubleshooting Table

| Symptom | First Check | Fix |
|---------|-------------|-----|
| Signal 11 immediately on start | MSC_64BIT_PLATFORM profile | Set to Linux 64 bit at Site level |
| Signal 11 with core dump | Review \`/tmp/core.MSCNSP.*\` with gdb | Identify faulting address; escalate to Oracle if in EBS code |
| Signal 11 only in cloned env | ulimit comparison with PRD | Enable unlimited core and stack in limits.conf |
| APP-MRP-22075 mrnspxt | Planning data integrity | Run Phase 5 validation queries; reclone if data is corrupt |
| MSCNSP spawns workers then hangs | MSC_NUM_OF_WORKERS too high | Reduce to match available CPU cores |
| Plan launches but returns no data | MSCNSP completed with warning | Check request log for APP-MSC- warnings about skipped orgs |
| Relink fails with undefined symbol | Shared library mismatch after clone | Verify \`$ORACLE_HOME\` matches the library path in the relink |
| pstack not installed | Cannot collect thread dump | Ask sysadmin to install \`gdb\` package: \`yum install gdb\` |`,
};

async function main() {
  console.log('Inserting EBS ASCP MSCNSP Signal 11 runbook...');
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
