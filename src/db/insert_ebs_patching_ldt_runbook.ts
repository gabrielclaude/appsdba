import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-patching-fndload-ldt-worker-failure-runbook';

const content = `
Step-by-step runbook for diagnosing and recovering an EBS adpatch session halted by a FNDLOAD worker failure on an \`.ldt\` file. Includes SQL investigation queries, shell diagnostics, a full automated analysis script, and the complete adctrl recovery procedure.

**Applies to:** EBS 12.1.x / 12.2.x, adpatch, adadmin, adgadd

---

## Phase 1 — Stabilise the Session

Do not kill the adpatch manager process. The session state (completed jobs, applied file list) is held in the AD tables. Killing the OS process can orphan that state and force a full restart.

\`\`\`bash
# 1. Identify the adpatch manager PID (do NOT kill it)
ps -ef | grep adpatch | grep -v grep

# 2. Note the TWO_TASK / ORACLE_SID in use — needed for log paths
echo "TWO_TASK: \$TWO_TASK"
echo "APPL_TOP: \$APPL_TOP"

# 3. Confirm the worker log directory
ls -lrt \$APPL_TOP/admin/\$TWO_TASK/log/adwork*.log | tail -10
\`\`\`

---

## Phase 2 — Identify the Failing Job

### 2a. Read the adpatch screen output

The manager screen shows the last known state of each worker. Look for lines matching:

\`\`\`
FAILED:   file <name>.ldt on worker <N> for product <prod> username APPS.
DEFERRED: file <name>.ldt on worker <N> for product <prod> username APPS. (Deferment number <X>)
\`\`\`

A **Deferment number > 1** means the manager already retried the job automatically and it failed again. The error is deterministic — do not use adctrl to restart until the root cause is fixed.

### 2b. Read the specific worker log

\`\`\`bash
# Replace N with the failed worker number
WORKER_N=2
WORKER_LOG=\$APPL_TOP/admin/\$TWO_TASK/log/adwork00\${WORKER_N}.log

# Last 60 lines — contains the full FNDLOAD error block
tail -60 "\$WORKER_LOG"

# Pull out the exact error phrase
grep -A5 "entity data" "\$WORKER_LOG" | tail -20
\`\`\`

### 2c. SQL: Worker and job status

\`\`\`sql
-- Current patch session
SELECT patch_run_id,
       name                  patch_name,
       phase_name,
       start_date,
       end_date,
       apply_no_workers      workers_requested
FROM   applsys.ad_patch_runs
WHERE  end_date IS NULL
ORDER  BY start_date DESC
FETCH  FIRST 1 ROW ONLY;

-- All worker statuses for this session
SELECT w.worker_id,
       w.status,
       j.filename,
       j.product_short_name,
       j.execution_status,
       j.failure_count,
       j.start_date          job_start,
       j.end_date            job_end,
       j.log_filename
FROM   applsys.ad_workers   w
LEFT  JOIN applsys.ad_deferred_jobs j
  ON  j.worker_id = w.worker_id
ORDER  BY w.worker_id, j.start_date DESC;

-- Failed and deferred LDT jobs only
SELECT j.filename,
       j.product_short_name,
       j.execution_status,
       j.failure_count,
       j.log_filename,
       j.start_date,
       j.end_date
FROM   applsys.ad_deferred_jobs j
WHERE  j.execution_status IN ('F', 'D')
  AND  j.filename LIKE '%.ldt'
ORDER  BY j.failure_count DESC, j.start_date DESC;
\`\`\`

---

## Phase 3 — Diagnose Root Cause

### 3a. Locate the LDT file

\`\`\`bash
# Primary location: product top import directory
# Replace QP_TOP / qpprg.ldt with the actual product top and filename from the error
PROD_TOP=\$QP_TOP
LDT_FILE="qpprg.ldt"

# Search all likely paths
find "\$PROD_TOP"    -name "\$LDT_FILE" 2>/dev/null
find "\$APPL_TOP"    -name "\$LDT_FILE" 2>/dev/null
find /u01/patches   -name "\$LDT_FILE" 2>/dev/null
\`\`\`

### 3b. Check for truncation

\`\`\`bash
FULL_PATH=\$(find \$QP_TOP -name "qpprg.ldt" 2>/dev/null | head -1)

echo "=== File info ==="
ls -lh "\$FULL_PATH"

echo ""
echo "=== Last 15 lines (truncation check) ==="
tail -15 "\$FULL_PATH"

echo ""
echo "=== BEGIN/END balance (should be equal) ==="
BEGIN_COUNT=\$(grep -c '^BEGIN ' "\$FULL_PATH")
END_COUNT=\$(grep -c '^END '   "\$FULL_PATH")
echo "BEGIN markers: \$BEGIN_COUNT"
echo "END   markers: \$END_COUNT"

if [ "\$BEGIN_COUNT" -ne "\$END_COUNT" ]; then
  echo "RESULT: TRUNCATED — BEGIN/END mismatch"
else
  echo "RESULT: BEGIN/END balanced — not truncated at entity level"
fi

echo ""
echo "=== Zero-byte lines (possible corruption indicator) ==="
grep -c '^[[:space:]]*\$' "\$FULL_PATH"
\`\`\`

### 3c. Validate against the patch zip

\`\`\`bash
PATCH_NUMBER="28458567"
PATCH_ZIP=\$(find /u01/patches -name "p\${PATCH_NUMBER}*.zip" 2>/dev/null | head -1)

if [ -z "\$PATCH_ZIP" ]; then
  echo "Patch zip not found — re-download from MOS required"
else
  echo "Patch zip: \$PATCH_ZIP"
  # Extract to temp and compare
  mkdir -p /tmp/patch_verify/\$PATCH_NUMBER
  unzip -p "\$PATCH_ZIP" "*qpprg.ldt" > /tmp/patch_verify/\$PATCH_NUMBER/qpprg.ldt 2>/dev/null

  DISK_MD5=\$(md5sum "\$FULL_PATH"                                    | awk '{print \$1}')
  ZIP_MD5=\$(md5sum "/tmp/patch_verify/\$PATCH_NUMBER/qpprg.ldt"     | awk '{print \$1}')

  echo "Disk MD5: \$DISK_MD5"
  echo "Zip  MD5: \$ZIP_MD5"

  if [ "\$DISK_MD5" = "\$ZIP_MD5" ]; then
    echo "RESULT: File matches zip — corruption is NOT the cause"
    echo "        Investigate prerequisite / FND version mismatch"
  else
    echo "RESULT: MD5 MISMATCH — disk file is corrupted or truncated"
    echo "        ACTION: Re-extract from zip"
  fi
fi
\`\`\`

### 3d. Check FND / ATG patch level

\`\`\`sql
-- Installed FND and the patched product version
SELECT application_short_name,
       product_version,
       patch_level,
       status,
       last_update_date
FROM   applsys.fnd_product_installations
WHERE  application_short_name IN ('FND', 'QP', 'AD')
ORDER  BY application_short_name;

-- AD version (drives adpatch / FNDLOAD compatibility)
SELECT release_name
FROM   applsys.fnd_product_groups;

-- Check if the current patch's prerequisites have been applied
-- Replace list with values from patch Readme
SELECT ab.bug_number,
       ab.creation_date
FROM   applsys.ad_bugs ab
WHERE  ab.bug_number IN ('12345678', '23456789', '34567890')
ORDER  BY ab.bug_number;
\`\`\`

---

## Phase 4 — Fix the Root Cause

### Fix A: Re-extract from the patch zip (truncation / corruption)

\`\`\`bash
PATCH_NUMBER="28458567"
PATCH_ZIP=\$(find /u01/patches -name "p\${PATCH_NUMBER}*.zip" 2>/dev/null | head -1)
FULL_PATH=\$(find \$QP_TOP -name "qpprg.ldt" 2>/dev/null | head -1)

# Back up the bad file
cp "\$FULL_PATH" "\${FULL_PATH}.bak_\$(date +%Y%m%d_%H%M%S)"
echo "Backup: \${FULL_PATH}.bak_\$(date +%Y%m%d_%H%M%S)"

# Extract fresh copy from zip
mkdir -p /tmp/patch_reextract
unzip -o "\$PATCH_ZIP" "*qpprg.ldt" -d /tmp/patch_reextract/
FRESH=\$(find /tmp/patch_reextract -name "qpprg.ldt" | head -1)

cp "\$FRESH" "\$FULL_PATH"
echo "Replaced: \$FULL_PATH"

# Verify replacement
tail -5 "\$FULL_PATH"
BEGIN_COUNT=\$(grep -c '^BEGIN ' "\$FULL_PATH")
END_COUNT=\$(grep -c '^END '   "\$FULL_PATH")
echo "BEGIN: \$BEGIN_COUNT  END: \$END_COUNT"
\`\`\`

### Fix B: Re-download and re-extract (zip itself is corrupted)

If the zip MD5 does not match the MOS checksum:

\`\`\`bash
# 1. Check the MOS-listed checksum (from the patch download page)
# 2. Compare against local zip
md5sum /u01/patches/p28458567_121300_Linux-x86-64.zip

# 3. Re-download via wget or MOS browser download
# 4. Verify new download MD5 matches MOS
# 5. Re-extract the full patch
cd /u01/patches
unzip -o p28458567_121300_Linux-x86-64.zip

# 6. Re-run adpatch (the session is already broken beyond adctrl recovery
#    if you need to re-stage the full patch tree)
\`\`\`

### Fix C: Apply missing prerequisite (version mismatch)

\`\`\`bash
# 1. Note the current adpatch session — it must be stopped cleanly
#    Use adctrl → Option 5 (Tell manager to quit after current task)
#    OR if all workers have already failed, the manager is already waiting

# 2. Apply the prerequisite patch in a NEW adpatch session
cd /u01/patches/<prereq_patch_number>
adpatch

# 3. After prerequisite completes, restart the original failed session
cd /u01/patches/28458567
adpatch
# adpatch will detect the existing session state and resume
\`\`\`

---

## Phase 5 — Resume with adctrl

Use adctrl only **after the root cause is fixed** (file replaced or prereq applied).

\`\`\`
$ adctrl

Choice 1 — Show worker status
  Worker 2: FAILED — qpprg.ldt

Choice 2 — Tell worker to restart a failed job
  Enter worker number: 2
  → Worker 2 status: FIXED/RESTART

# Back on the adpatch manager screen, wait 30–60 seconds.
# The manager polls for FIXED/RESTART and resubmits the job.
\`\`\`

\`\`\`bash
# Monitor the worker log for completion
tail -f \$APPL_TOP/admin/\$TWO_TASK/log/adwork002.log

# Expected success line:
# COMPLETED: file qpprg.ldt on worker 2 for product qp username APPS.
\`\`\`

---

## Phase 6 — Verify Patch Completion

\`\`\`sql
-- No remaining failed jobs
SELECT COUNT(*) remaining_failures
FROM   applsys.ad_deferred_jobs
WHERE  execution_status = 'F';
-- Expected: 0

-- Patch run end_date populated (session closed)
SELECT patch_run_id,
       name,
       start_date,
       end_date,
       ROUND((end_date - start_date)*24*60, 1) elapsed_minutes
FROM   applsys.ad_patch_runs
ORDER  BY start_date DESC
FETCH  FIRST 3 ROWS ONLY;

-- Bug registered in ad_bugs
SELECT bug_number, creation_date, platform_code, language_code
FROM   applsys.ad_bugs
WHERE  bug_number = '28458567';

-- Product patch level updated
SELECT application_short_name,
       product_version,
       patch_level,
       last_update_date
FROM   applsys.fnd_product_installations
WHERE  application_short_name = 'QP';
\`\`\`

---

## Automated Analysis Script

Run this script as the applmgr OS user while the adpatch session is still in a FAILED/paused state. It collects everything into a single timestamped report.

\`\`\`bash
#!/bin/bash
# /u01/scripts/ebs_patch_ldt_analysis.sh
# Run as: applmgr OS user with EBS environment sourced
# Usage:  ./ebs_patch_ldt_analysis.sh <ldt_filename> <product_top_var> <patch_number>
# Example: ./ebs_patch_ldt_analysis.sh qpprg.ldt QP_TOP 28458567

LDT_NAME=\${1:-"qpprg.ldt"}
PROD_TOP_VAR=\${2:-"QP_TOP"}
PATCH_NUMBER=\${3:-"28458567"}

PROD_TOP=\$(eval echo "\\\$\$PROD_TOP_VAR")
REPORT=/tmp/ebs_patch_analysis_\$(date +%Y%m%d_%H%M%S).txt
DIVIDER="=================================================================="

report() { echo "\$1" | tee -a "\$REPORT"; }

report "\$DIVIDER"
report "EBS Patch LDT Worker Failure Analysis"
report "Generated: \$(date)"
report "LDT File:  \$LDT_NAME"
report "Product Top Variable: \$PROD_TOP_VAR = \$PROD_TOP"
report "Patch Number: \$PATCH_NUMBER"
report "\$DIVIDER"

# ── 1. Environment ──────────────────────────────────────────────────────────
report ""
report "1. ENVIRONMENT"
report "   TWO_TASK   : \$TWO_TASK"
report "   ORACLE_SID : \$ORACLE_SID"
report "   APPL_TOP   : \$APPL_TOP"
report "   PROD_TOP   : \$PROD_TOP"
report "   FNDLOAD    : \$(which FNDLOAD 2>/dev/null || echo 'not in PATH')"

# ── 2. Locate LDT file ──────────────────────────────────────────────────────
report ""
report "2. LDT FILE LOCATION"
LDT_PATH=\$(find "\$PROD_TOP" -name "\$LDT_NAME" 2>/dev/null | head -1)
if [ -z "\$LDT_PATH" ]; then
  LDT_PATH=\$(find "\$APPL_TOP" -name "\$LDT_NAME" 2>/dev/null | head -1)
fi
if [ -z "\$LDT_PATH" ]; then
  report "   ERROR: \$LDT_NAME not found under \$PROD_TOP or \$APPL_TOP"
else
  report "   Path: \$LDT_PATH"
  report "   \$(ls -lh "\$LDT_PATH")"
fi

# ── 3. Truncation check ─────────────────────────────────────────────────────
report ""
report "3. TRUNCATION CHECK"
if [ -n "\$LDT_PATH" ]; then
  BEGIN_COUNT=\$(grep -c '^BEGIN ' "\$LDT_PATH" 2>/dev/null || echo 0)
  END_COUNT=\$(grep -c   '^END '   "\$LDT_PATH" 2>/dev/null || echo 0)
  BLANK_COUNT=\$(grep -c '^[[:space:]]*\$' "\$LDT_PATH" 2>/dev/null || echo 0)
  report "   BEGIN markers : \$BEGIN_COUNT"
  report "   END   markers : \$END_COUNT"
  report "   Blank lines   : \$BLANK_COUNT"
  if [ "\$BEGIN_COUNT" -ne "\$END_COUNT" ]; then
    report "   VERDICT: TRUNCATED (BEGIN != END)"
  else
    report "   VERDICT: Entity markers balanced"
  fi
  report ""
  report "   Last 10 lines of file:"
  tail -10 "\$LDT_PATH" | while read -r line; do report "     \$line"; done
fi

# ── 4. Zip integrity ─────────────────────────────────────────────────────────
report ""
report "4. ZIP INTEGRITY"
PATCH_ZIP=\$(find /u01/patches -name "p\${PATCH_NUMBER}*.zip" 2>/dev/null | head -1)
if [ -z "\$PATCH_ZIP" ]; then
  report "   Patch zip not found under /u01/patches — re-download required"
elif [ -n "\$LDT_PATH" ]; then
  report "   Zip: \$PATCH_ZIP"
  mkdir -p /tmp/pa_verify_\$\$
  unzip -p "\$PATCH_ZIP" "*\$LDT_NAME" > /tmp/pa_verify_\$\$/\$LDT_NAME 2>/dev/null
  if [ -s /tmp/pa_verify_\$\$/\$LDT_NAME ]; then
    DISK_MD5=\$(md5sum "\$LDT_PATH"                   | awk '{print \$1}')
    ZIP_MD5=\$(md5sum "/tmp/pa_verify_\$\$/\$LDT_NAME" | awk '{print \$1}')
    report "   Disk MD5: \$DISK_MD5"
    report "   Zip  MD5: \$ZIP_MD5"
    if [ "\$DISK_MD5" = "\$ZIP_MD5" ]; then
      report "   VERDICT: File matches zip — corruption NOT the primary cause"
    else
      report "   VERDICT: MD5 MISMATCH — re-extract from zip"
    fi
  else
    report "   Could not extract \$LDT_NAME from zip — file may use different path in zip"
  fi
  rm -rf /tmp/pa_verify_\$\$
fi

# ── 5. Worker logs ───────────────────────────────────────────────────────────
report ""
report "5. WORKER LOG ERRORS"
LOG_DIR=\$APPL_TOP/admin/\$TWO_TASK/log
for LOG in "\$LOG_DIR"/adwork*.log; do
  HIT=\$(grep -l "entity data\|FAILED.*ldt\|DEFERRED.*ldt" "\$LOG" 2>/dev/null)
  if [ -n "\$HIT" ]; then
    report ""
    report "   >> \$LOG"
    grep -E "entity data|FAILED.*ldt|DEFERRED.*ldt|An entity" "\$LOG" | \
      head -10 | while read -r line; do report "      \$line"; done
  fi
done

# ── 6. SQL: AD job status ────────────────────────────────────────────────────
report ""
report "6. AD JOB STATUS (requires sqlplus access)"

sqlplus -S "apps/\$APPS_PASSWORD@\$TWO_TASK" << SQLEOF >> "\$REPORT" 2>&1
SET PAGESIZE 50 LINESIZE 150 FEEDBACK OFF HEADING ON
PROMPT --- Active patch run ---
SELECT patch_run_id, name, phase_name, start_date FROM applsys.ad_patch_runs
WHERE end_date IS NULL ORDER BY start_date DESC FETCH FIRST 1 ROW ONLY;

PROMPT --- Failed LDT jobs ---
SELECT j.filename, j.product_short_name, j.execution_status,
       j.failure_count, j.log_filename
FROM   applsys.ad_deferred_jobs j
WHERE  j.execution_status IN ('F','D') AND j.filename LIKE '%.ldt'
ORDER  BY j.failure_count DESC, j.start_date DESC;

PROMPT --- FND product versions ---
SELECT application_short_name, product_version, patch_level, last_update_date
FROM   applsys.fnd_product_installations
WHERE  application_short_name IN ('FND','AD','QP')
ORDER  BY application_short_name;
EXIT;
SQLEOF

# ── 7. Recommendation ────────────────────────────────────────────────────────
report ""
report "7. RECOMMENDED NEXT STEP"
if [ -n "\$LDT_PATH" ]; then
  if [ "\$BEGIN_COUNT" -ne "\$END_COUNT" ] 2>/dev/null; then
    report "   → Re-extract \$LDT_NAME from patch zip (file is truncated)"
  elif [ -n "\$PATCH_ZIP" ] && [ "\$DISK_MD5" != "\$ZIP_MD5" ] 2>/dev/null; then
    report "   → Re-extract \$LDT_NAME from patch zip (MD5 mismatch)"
  else
    report "   → Check FND/ATG patch level and prerequisite patch list in Readme"
    report "   → File appears intact — investigate version compatibility"
  fi
else
  report "   → LDT file not found — verify patch was extracted to APPL_TOP"
fi

report ""
report "\$DIVIDER"
report "Report saved to: \$REPORT"
report "\$DIVIDER"

echo ""
echo "Analysis complete. Report: \$REPORT"
\`\`\`

\`\`\`bash
chmod +x /u01/scripts/ebs_patch_ldt_analysis.sh

# Source EBS environment first
source /u01/app/oracle/prod/EBSapps.env run

# Run analysis
/u01/scripts/ebs_patch_ldt_analysis.sh qpprg.ldt QP_TOP 28458567
\`\`\`

---

## Quick Reference: adctrl Options Relevant to LDT Failures

| adctrl Option | When to Use |
|---|---|
| **1 — Show worker status** | Always first — confirm which workers are FAILED vs WAITING |
| **2 — Restart failed job** | After root cause is fixed — resubmits the job to the worker |
| **3 — Tell worker to quit** | Only if you need to change worker count and restart cleanly |
| **4 — Recalibrate workers** | After adding workers mid-session |
| **5 — Manager quit after current task** | Graceful stop of adpatch so you can apply a prereq patch |

---

## Common Mistakes to Avoid

| Mistake | Consequence |
|---|---|
| Killing the adpatch manager OS process | Orphans the session; may force a full restart |
| Running adctrl restart before fixing the root cause | Worker fails again immediately; deferment count increments |
| Re-running adpatch instead of using adctrl | Starts a new session; the old session state is preserved but the manager runs a fresh pass which takes much longer |
| Ignoring the deferment count | A count > 2 means the manager has already retried — fix is mandatory, not optional |
| Applying the patch on a different OS user than the one that extracted it | NLS_LANG or file permission difference can corrupt the re-extraction |
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'EBS Patching LDT Worker Failure — Operations Runbook',
    slug,
    excerpt: 'Operations runbook for recovering an EBS adpatch session halted by a FNDLOAD worker failure on an .ldt file. Includes phase-by-phase diagnosis (truncation check, MD5 validation, prerequisite gap detection), a fully automated analysis shell script, SQL queries against AD tables, adctrl recovery steps, and post-patch verification.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
