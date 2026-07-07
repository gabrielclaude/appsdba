import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-adop-checkfile-failure-runbook';

const content = `
## Purpose

Structured response for \`adop phase=apply\` failures during the checkfile phase. Checkfile runs at the start of apply and compares patch filesystem files against the run filesystem and the AD_FILE_VERSIONS database table. Failures here do not modify any application files — the system is in the same state it was after prepare completed.

---

## Phase 1 — Fast Triage (5 minutes)

Run these four commands immediately. They identify which failure pattern you have and determine the correct recovery path.

### 1. Confirm the failure is in checkfile

\`\`\`bash
# Source patch environment
source /u01/oracle/EBS/EBSapps.env patch

ADOPLOG=\$APPL_TOP/admin/adop_logs
LATEST_LOG=\$(ls -t "\$ADOPLOG"/adop*.log 2>/dev/null | head -1)

echo "=== Checkfile error signature ==="
grep -iE 'checkfile|CHECK FILE|check_file' "\$LATEST_LOG" | tail -20

echo ""
echo "=== ORA errors during checkfile ==="
grep -iE 'ORA-[0-9]+' "\$LATEST_LOG" | tail -20

echo ""
echo "=== adop exit line ==="
grep -iE 'exiting|FAILED|ERROR|INCOMPLETE' "\$LATEST_LOG" | tail -10
\`\`\`

**Expected output confirming checkfile failure:**
\`\`\`
[ERROR] Checkfile phase failed for patch 35789012
[ERROR] File version mismatch detected: 847 files differ between patch and run filesystems
\`\`\`

### 2. Check the adop session state

\`\`\`sql
-- Run in APPS schema
SELECT s.adop_session_id,
       s.status,
       s.prepare_status,
       s.apply_status,
       TO_CHAR(s.start_date, 'YYYY-MM-DD HH24:MI:SS') AS start_date,
       TO_CHAR(s.end_date,   'YYYY-MM-DD HH24:MI:SS') AS end_date
FROM   ad_adop_sessions s
ORDER  BY s.start_date DESC
FETCH  FIRST 3 ROWS ONLY;
\`\`\`

**Interpret:**
- \`prepare_status = C\`, \`apply_status = F\` → prepare completed; apply failed in checkfile → restart is viable
- \`status = INCOMPLETE\` → session exists and must be restarted or aborted before a new one can begin

### 3. Count the AD_FILE_VERSIONS discrepancies

\`\`\`sql
-- Files where DB-recorded version does not match the patch filesystem
-- Replace 35789012 with your adop_session_id from the previous query
SELECT COUNT(*) AS mismatch_count
FROM   ad_file_versions afv
JOIN   ad_files af ON af.file_id = afv.file_id
WHERE  afv.containing_file_id IS NULL
  AND  afv.version_segment_1 IS NOT NULL
  AND  NOT EXISTS (
    SELECT 1
    FROM   dual
    WHERE  afv.file_version = afv.file_version   -- placeholder; see full discrepancy query below
  );
\`\`\`

*Use the full discrepancy query in Phase 2 for the detailed list.*

### 4. Check for ORA errors

\`\`\`bash
# Scan adop log for database errors
grep -E 'ORA-01653|ORA-01555|ORA-00060|ORA-04031' "\$LATEST_LOG" | sort | uniq -c | sort -rn
\`\`\`

| ORA error | Meaning |
|---|---|
| ORA-01653 | Unable to extend table — tablespace full |
| ORA-01555 | Snapshot too old — UNDO exhausted |
| ORA-00060 | Deadlock during checkfile queries |
| ORA-04031 | Shared pool exhausted — SGA too small |

---

## Phase 2 — Detailed Diagnosis

### Discrepancy details

\`\`\`sql
-- Files recorded in AD_FILE_VERSIONS whose version does not match what adop expects
-- This surfaces Pattern 1 (stale entries) and Pattern 2 (missing files)
SELECT af.filename,
       af.subdirectory,
       afv.file_version,
       afv.file_size,
       TO_CHAR(afv.last_update_date, 'YYYY-MM-DD HH24:MI:SS') AS last_update_date,
       afv.patch_file_version,
       afv.patch_file_size
FROM   ad_file_versions afv
JOIN   ad_files af ON af.file_id = afv.file_id
WHERE  afv.patch_file_version IS NOT NULL
  AND  afv.file_version != afv.patch_file_version
ORDER  BY afv.last_update_date DESC
FETCH  FIRST 50 ROWS ONLY;
\`\`\`

### Filesystem file count comparison

\`\`\`bash
# Count files in run vs patch editions for the five most common tops
for TOP in appl/fnd appl/inv appl/ont appl/qp appl/wf; do
  RUN_COUNT=\$(find /u01/oracle/EBS/fs1/EBSapps/\$TOP -type f 2>/dev/null | wc -l)
  PATCH_COUNT=\$(find /u01/oracle/EBS/fs2/EBSapps/\$TOP -type f 2>/dev/null | wc -l)
  echo "\$TOP: run=\$RUN_COUNT  patch=\$PATCH_COUNT"
done
\`\`\`

A patch edition count significantly lower than the run edition count in any subtree confirms that fs_clone did not complete for that product.

### Worker OOM check

\`\`\`bash
# Check kernel OOM killer log for adop/java processes
dmesg | grep -iE 'oom|killed process|out of memory' | grep -iE 'java|adop|perl' | tail -20

# Check for abrupt termination in adop log
grep -E 'signal|killed|oom|Killed' "\$LATEST_LOG" | tail -10

# Memory state at time of failure
grep -iE 'heap|memory|java.lang.OutOfMemoryError' "\$LATEST_LOG" | tail -10
\`\`\`

### Tablespace state (if ORA-01653 seen)

\`\`\`sql
SELECT t.tablespace_name,
       ROUND(t.bytes / 1048576)         AS size_mb,
       ROUND(NVL(f.free_bytes, 0) / 1048576) AS free_mb,
       ROUND((1 - NVL(f.free_bytes, 0) / t.bytes) * 100, 1) AS pct_used,
       t.autoextend
FROM (
  SELECT tablespace_name, SUM(bytes) AS bytes,
         MAX(CASE WHEN autoextensible = 'YES' THEN 'YES' ELSE 'NO' END) AS autoextend
  FROM   dba_data_files
  GROUP  BY tablespace_name
) t
LEFT JOIN (
  SELECT tablespace_name, SUM(bytes) AS free_bytes
  FROM   dba_free_space
  GROUP  BY tablespace_name
) f ON f.tablespace_name = t.tablespace_name
WHERE  t.tablespace_name IN ('APPS_TS_TX_DATA', 'SYSTEM', 'UNDOTBS1', 'SYSAUX')
ORDER  BY pct_used DESC;
\`\`\`

### UNDO configuration (if ORA-01555 seen)

\`\`\`sql
-- Check UNDO retention and extent state
SELECT name, value FROM v\$parameter WHERE name IN ('undo_retention', 'undo_tablespace');

SELECT t.tablespace_name,
       ROUND(SUM(s.bytes) / 1048576) AS total_undo_mb,
       COUNT(CASE WHEN s.status = 'ACTIVE'   THEN 1 END) AS active_extents,
       COUNT(CASE WHEN s.status = 'UNEXPIRED' THEN 1 END) AS unexpired_extents,
       COUNT(CASE WHEN s.status = 'EXPIRED'   THEN 1 END) AS expired_extents
FROM   dba_undo_extents s
JOIN   dba_tablespaces t ON t.tablespace_name = s.tablespace_name
GROUP  BY t.tablespace_name;
\`\`\`

---

## Phase 3 — Resolution

### 3A — Pattern 1: Stale AD_FILE_VERSIONS (most common)

**Symptom:** Checkfile reports version mismatches; ORA errors absent; filesystem file counts match between run and patch editions.

**Cause:** A prior adop cycle that ended without cleanup left AD_FILE_VERSIONS with stale version records that disagree with the current patch.

\`\`\`bash
# Step 1: Run cleanup for the previous session if it was not run
adop phase=cleanup

# Step 2: Restart apply — adop re-runs checkfile against the now-consistent AD tables
adop phase=apply restart=yes
\`\`\`

If cleanup fails because the previous session is in an inconsistent state:

\`\`\`bash
# Force cleanup of the previous adop session ID
adop phase=cleanup adop_session_id=<previous_session_id>
\`\`\`

After cleanup completes, the AD_FILE_VERSIONS discrepancy count should drop to zero. Restart apply.

### 3B — Pattern 2: Files missing from patch filesystem

**Symptom:** Checkfile fails; patch filesystem file count is significantly lower than run filesystem for one or more product areas; fs_clone log shows rsync ended early or with errors.

**Cause:** fs_clone (rsync) did not complete — disk full, NFS timeout, or process kill during prepare.

\`\`\`bash
# Step 1: Check disk space on the patch filesystem
df -h /u01/oracle/EBS/fs2

# Step 2: Re-run fs_clone (re-syncs run → patch without starting a new adop session)
adop phase=fs_clone

# Monitor rsync progress
tail -f \$APPL_TOP/admin/adop_logs/\$(ls -t \$APPL_TOP/admin/adop_logs/ | head -1)

# Step 3: After fs_clone completes, restart apply
adop phase=apply restart=yes
\`\`\`

### 3C — Pattern 3: ORA errors during checkfile

**For ORA-01653 (tablespace full):**

\`\`\`sql
-- Add space to the full tablespace
-- Identify which datafile to extend
SELECT file_name, bytes/1048576 AS size_mb, maxbytes/1048576 AS maxsize_mb, autoextensible
FROM   dba_data_files
WHERE  tablespace_name = 'APPS_TS_TX_DATA'
ORDER  BY file_name;

-- Enable autoextend or add a datafile
ALTER DATABASE DATAFILE '/u01/oradata/PROD/apps_ts_tx_data01.dbf' AUTOEXTEND ON NEXT 512M MAXSIZE 30G;
-- Or add a new datafile:
ALTER TABLESPACE APPS_TS_TX_DATA ADD DATAFILE '/u01/oradata/PROD/apps_ts_tx_data02.dbf' SIZE 2G AUTOEXTEND ON;
\`\`\`

After resolving space:

\`\`\`bash
adop phase=apply restart=yes
\`\`\`

**For ORA-01555 (snapshot too old):**

\`\`\`sql
-- Increase UNDO retention to cover the checkfile query duration
ALTER SYSTEM SET undo_retention = 10800 SCOPE=BOTH;  -- 3 hours

-- Guarantee retention (prevents UNDO from being overwritten before expiry)
ALTER TABLESPACE UNDOTBS1 RETENTION GUARANTEE;
\`\`\`

\`\`\`bash
adop phase=apply restart=yes
\`\`\`

**For ORA-00060 (deadlock):**

\`\`\`sql
-- Verify no other adop or adpatch sessions are running
SELECT s.sid, s.serial#, s.username, s.program, s.status,
       TO_CHAR(s.logon_time, 'HH24:MI:SS') AS logon_time
FROM   v\$session s
WHERE  s.username IN ('APPS', 'APPLSYS')
  AND  s.program LIKE '%adop%'
ORDER  BY s.logon_time;

-- Kill any stale adop sessions from the prior failed run
ALTER SYSTEM KILL SESSION 'sid,serial#' IMMEDIATE;
\`\`\`

\`\`\`bash
adop phase=apply restart=yes
\`\`\`

### 3D — Pattern 4: Checkfile worker OOM-killed

**Symptom:** adop log ends abruptly; dmesg shows Java or Perl process killed; \`apply_status\` is F in AD_ADOP_SESSIONS.

\`\`\`bash
# Step 1: Check current Java heap allocation for adop
grep -iE 'Xmx|Xms|heap' "\$APPL_TOP/admin/adop_setup" 2>/dev/null | head -10
grep -iE 'java_args|Xmx' "\$AD_TOP/bin/adop" 2>/dev/null | head -10

# Step 2: Check available memory
free -m
cat /proc/meminfo | grep -E 'MemAvailable|SwapFree'

# Step 3: Free memory and restart
# Identify and kill non-essential Java processes
ps aux --sort=-%mem | grep java | head -10

# Step 4: If checkfile is consistently killed due to memory, bypass it
# Use only when you have confirmed the patch filesystem is complete (file counts match)
adop phase=apply restart=yes checkfile=no
\`\`\`

### 3E — Skip checkfile (bypass option)

Use when: ORA errors or OOM are transient; you have verified via file count comparison that the patch filesystem is intact; or a DBA has confirmed the AD_FILE_VERSIONS discrepancies are known-stale from a prior incomplete session.

**Do not use if:** you cannot confirm the patch filesystem is complete (Pattern 2 missing files). Skipping checkfile with an incomplete patch edition leads to apply workers failing on missing files midway through the patch.

\`\`\`bash
# Restart apply without re-running checkfile
adop phase=apply restart=yes checkfile=no

# Monitor apply progress
tail -f \$APPL_TOP/admin/adop_logs/\$(ls -t \$APPL_TOP/admin/adop_logs/ | head -1)
\`\`\`

### 3F — Abort and start fresh (last resort)

Use when: the adop session is in a state that cannot be restarted (multiple failed phases, mixed node states, or a prepare that is too old to be valid).

\`\`\`bash
# Abort the current session
adop phase=abort

# Start a fresh cycle
adop phase=prepare
adop phase=apply patches=<patch_id>
adop phase=finalize
adop phase=cutover
adop phase=cleanup
\`\`\`

---

## Phase 4 — Post-Fix Verification

After any recovery action, verify that apply progressed past checkfile and is processing patch files.

\`\`\`sql
-- Confirm apply_status moved from F to R (running) or C (complete)
SELECT s.adop_session_id,
       s.status,
       s.prepare_status,
       s.apply_status,
       s.finalize_status,
       TO_CHAR(s.start_date, 'YYYY-MM-DD HH24:MI:SS') AS start_date
FROM   ad_adop_sessions s
ORDER  BY s.start_date DESC
FETCH  FIRST 3 ROWS ONLY;
\`\`\`

\`\`\`sql
-- Watch worker activity — should show RUNNING workers processing files
SELECT w.worker_id,
       w.status,
       w.last_update_time,
       w.started,
       w.ended
FROM   ad_pm_workers w
WHERE  w.session_id = (
  SELECT MAX(adop_session_id) FROM ad_adop_sessions
)
ORDER  BY w.worker_id;
\`\`\`

\`\`\`bash
# Watch the apply log for worker progress
ADOPLOG=\$APPL_TOP/admin/adop_logs
tail -f "\$ADOPLOG"/\$(ls -t "\$ADOPLOG" | head -1)

# In a second terminal: watch for errors
watch -n 30 'grep -c "error\|ERROR\|FAILED" \$APPL_TOP/admin/adop_logs/\$(ls -t \$APPL_TOP/admin/adop_logs/ | head -1)'
\`\`\`

---

## Automated Diagnostic Script

Save to \`/u01/scripts/ebs_adop_checkfile_diagnose.sh\`. Run as the applmgr OS user with the patch EBS environment sourced.

\`\`\`bash
#!/bin/bash
# ebs_adop_checkfile_diagnose.sh
# Diagnoses adop checkfile failures and recommends a recovery path.
# Run as: source /u01/oracle/EBS/EBSapps.env patch && bash ebs_adop_checkfile_diagnose.sh

set -euo pipefail

SCRIPT_NAME=\$(basename "\$0")
LOG_DIR="/u01/logs/adop_diag"
mkdir -p "\$LOG_DIR"
REPORT="\$LOG_DIR/checkfile_diag_\$(date +%Y%m%d_%H%M%S).txt"

log() { echo "\$1" | tee -a "\$REPORT"; }
log_section() { log ""; log "=== \$1 ==="; log ""; }

log "EBS adop Checkfile Failure Diagnostic"
log "Generated: \$(date)"
log "Report:    \$REPORT"

# --- 0. Environment check ---
log_section "0. Environment"
if [ -z "\${APPL_TOP:-}" ]; then
  log "ERROR: EBS environment not sourced. Run: source /u01/oracle/EBS/EBSapps.env patch"
  exit 1
fi
log "APPL_TOP : \$APPL_TOP"
log "TWO_TASK : \${TWO_TASK:-not set}"
log "ORACLE_HOME: \${ORACLE_HOME:-not set}"

# --- 1. adop log analysis ---
log_section "1. adop Log Analysis"
ADOPLOG="\$APPL_TOP/admin/adop_logs"
LATEST_LOG=\$(ls -t "\$ADOPLOG"/adop*.log 2>/dev/null | head -1)

if [ -z "\$LATEST_LOG" ]; then
  log "WARNING: No adop logs found in \$ADOPLOG"
else
  log "Latest log: \$LATEST_LOG"
  log ""
  log "--- Checkfile error lines ---"
  grep -iE 'checkfile|check.file|CHECK FILE' "\$LATEST_LOG" | tail -15 | tee -a "\$REPORT"
  log ""
  log "--- ORA error lines ---"
  ORA_LINES=\$(grep -E 'ORA-[0-9]+' "\$LATEST_LOG" | sort | uniq -c | sort -rn | head -10)
  if [ -n "\$ORA_LINES" ]; then
    echo "\$ORA_LINES" | tee -a "\$REPORT"
  else
    log "(none)"
  fi
  log ""
  log "--- OOM / kill lines ---"
  OOM_LINES=\$(grep -iE 'outofmemory|OOM|Killed|heap space|signal 9' "\$LATEST_LOG" | tail -5)
  if [ -n "\$OOM_LINES" ]; then
    echo "\$OOM_LINES" | tee -a "\$REPORT"
  else
    log "(none)"
  fi
fi

# --- 2. Kernel OOM log ---
log_section "2. Kernel OOM Log"
OOM_KERNEL=\$(dmesg 2>/dev/null | grep -iE 'oom|killed process|out of memory' | grep -iE 'java|adop|perl' | tail -5)
if [ -n "\$OOM_KERNEL" ]; then
  log "WARNING: OOM events found in kernel log:"
  echo "\$OOM_KERNEL" | tee -a "\$REPORT"
else
  log "OK: No OOM kill events for Java/adop/Perl in kernel log."
fi

# --- 3. Filesystem comparison ---
log_section "3. Filesystem Comparison (run vs patch editions)"
PRODUCTS="appl/fnd appl/inv appl/ont appl/qp appl/wf appl/po appl/ar"
FS1_BASE="/u01/oracle/EBS/fs1/EBSapps"
FS2_BASE="/u01/oracle/EBS/fs2/EBSapps"
MISMATCH_COUNT=0

printf "%-30s  %8s  %8s  %s\n" "Product" "Run(fs1)" "Patch(fs2)" "Status" | tee -a "\$REPORT"
printf "%-30s  %8s  %8s  %s\n" "-------" "--------" "----------" "------" | tee -a "\$REPORT"

for P in \$PRODUCTS; do
  RUN_COUNT=\$(find "\$FS1_BASE/\$P" -type f 2>/dev/null | wc -l)
  PATCH_COUNT=\$(find "\$FS2_BASE/\$P" -type f 2>/dev/null | wc -l)
  if [ "\$RUN_COUNT" -eq 0 ] && [ "\$PATCH_COUNT" -eq 0 ]; then
    STATUS="SKIP (not installed)"
  elif [ "\$PATCH_COUNT" -eq 0 ]; then
    STATUS="MISSING from patch FS"
    MISMATCH_COUNT=\$((MISMATCH_COUNT + 1))
  else
    DIFF=\$((RUN_COUNT - PATCH_COUNT))
    if [ "\$DIFF" -gt 100 ]; then
      STATUS="WARNING: patch has \$DIFF fewer files"
      MISMATCH_COUNT=\$((MISMATCH_COUNT + 1))
    else
      STATUS="OK"
    fi
  fi
  printf "%-30s  %8d  %8d  %s\n" "\$P" "\$RUN_COUNT" "\$PATCH_COUNT" "\$STATUS" | tee -a "\$REPORT"
done

# --- 4. Disk space check ---
log_section "4. Disk Space"
df -hT /u01/oracle/EBS/fs1 /u01/oracle/EBS/fs2 /u01/oracle/EBS/fs_ne 2>/dev/null | tee -a "\$REPORT" || \
df -hT "\$APPL_TOP" /tmp 2>/dev/null | tee -a "\$REPORT"

# --- 5. Recommendation ---
log_section "5. Recommendation"

# Detect ORA errors
HAS_ORA01653=\$(grep -c 'ORA-01653' "\${LATEST_LOG:-/dev/null}" 2>/dev/null || echo 0)
HAS_ORA01555=\$(grep -c 'ORA-01555' "\${LATEST_LOG:-/dev/null}" 2>/dev/null || echo 0)
HAS_ORA00060=\$(grep -c 'ORA-00060' "\${LATEST_LOG:-/dev/null}" 2>/dev/null || echo 0)
HAS_OOM=\$(grep -ic 'outofmemory\|heap space\|Killed' "\${LATEST_LOG:-/dev/null}" 2>/dev/null || echo 0)

if [ "\$MISMATCH_COUNT" -gt 0 ]; then
  log "PATTERN 2 — Files missing from patch filesystem."
  log "Action:"
  log "  1. Check disk space on /u01/oracle/EBS/fs2 (see section 4)"
  log "  2. Re-run fs_clone:  adop phase=fs_clone"
  log "  3. After fs_clone completes: adop phase=apply restart=yes"
elif [ "\$HAS_ORA01653" -gt 0 ]; then
  log "PATTERN 3A — ORA-01653: Tablespace full."
  log "Action:"
  log "  1. Extend the full tablespace (see Phase 3C in the runbook)"
  log "  2. adop phase=apply restart=yes"
elif [ "\$HAS_ORA01555" -gt 0 ]; then
  log "PATTERN 3B — ORA-01555: Snapshot too old."
  log "Action:"
  log "  1. ALTER SYSTEM SET undo_retention = 10800 SCOPE=BOTH;"
  log "  2. adop phase=apply restart=yes"
elif [ "\$HAS_ORA00060" -gt 0 ]; then
  log "PATTERN 3C — ORA-00060: Deadlock during checkfile."
  log "Action:"
  log "  1. Kill any stale adop sessions in v\$session"
  log "  2. adop phase=apply restart=yes"
elif [ "\$HAS_OOM" -gt 0 ]; then
  log "PATTERN 4 — Checkfile worker OOM-killed."
  log "Action:"
  log "  1. Confirm patch filesystem is complete (all products show OK above)"
  log "  2. If complete: adop phase=apply restart=yes checkfile=no"
  log "  3. If not complete: adop phase=fs_clone then adop phase=apply restart=yes"
else
  log "PATTERN 1 — Likely stale AD_FILE_VERSIONS (most common)."
  log "Action:"
  log "  1. Run cleanup for prior session: adop phase=cleanup"
  log "  2. Restart apply: adop phase=apply restart=yes"
  log ""
  log "If restart fails again after cleanup, run the AD_FILE_VERSIONS discrepancy"
  log "query from Phase 2 of the runbook to confirm the mismatch scope."
fi

log ""
log "Full report saved to: \$REPORT"
\`\`\`

Make the script executable and test it:

\`\`\`bash
chmod +x /u01/scripts/ebs_adop_checkfile_diagnose.sh

# Run with patch environment sourced
source /u01/oracle/EBS/EBSapps.env patch
bash /u01/scripts/ebs_adop_checkfile_diagnose.sh
\`\`\`

---

## Prevention Checklist

| Check | Command | When |
|---|---|---|
| Run cleanup after every adop cycle | \`adop phase=cleanup\` | After successful cutover |
| Verify no INCOMPLETE sessions before patching | \`SELECT status FROM ad_adop_sessions ORDER BY start_date DESC\` | Before each adop session |
| Gather stats on AD tables | \`EXEC DBMS_STATS.GATHER_TABLE_STATS('APPLSYS','AD_FILE_VERSIONS')\` | Monthly or after large patches |
| Verify patch filesystem completeness after prepare | File count comparison (Phase 2 script) | After \`adop phase=prepare\` |
| Check tablespace free space | Tablespace query (Phase 2) | Before each adop session |
| Check UNDO retention | \`SELECT value FROM v\$parameter WHERE name='undo_retention'\` | Before long patching sessions |

---

## Quick Reference

| Pattern | Key symptom | Fix |
|---|---|---|
| Stale AD_FILE_VERSIONS | Version mismatch errors, no ORA errors, filesystems match | \`adop phase=cleanup\` then \`restart=yes\` |
| Missing files in patch FS | File count gap between fs1 and fs2 | \`adop phase=fs_clone\` then \`restart=yes\` |
| ORA-01653 | Tablespace full ORA error in adop log | Extend tablespace, \`restart=yes\` |
| ORA-01555 | Snapshot too old ORA error | Increase undo_retention, \`restart=yes\` |
| ORA-00060 | Deadlock ORA error | Kill stale sessions, \`restart=yes\` |
| OOM-killed | Abrupt log end, dmesg OOM entry | Free memory, \`restart=yes checkfile=no\` |
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'EBS adop Checkfile Failure: Runbook',
    slug,
    excerpt: 'Structured response procedure for adop phase=apply failures during the checkfile phase. Covers fast triage, detailed diagnosis for all four failure patterns (stale AD_FILE_VERSIONS, missing patch filesystem files, ORA errors, OOM-killed worker), pattern-specific resolution steps, automated diagnostic script, and prevention checklist.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
