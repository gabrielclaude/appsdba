import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-adop-checkfile-failure-troubleshooting';

const content = `
You submit \`adop phase=apply\` on an EBS 12.2 system. Workers start. Then, minutes in, the session stops with a message you have not seen before:

\`\`\`
adop: ERROR: Checkfile phase failed.
Please review the log file for details.
\`\`\`

The patch has not been applied. Nothing in the AD tables is marked failed. The workers exited cleanly. The log file runs to hundreds of lines. This failure belongs to one of the more misunderstood corners of EBS 12.2 online patching: the **checkfile** phase.

---

## What adop checkfile Does

In EBS 12.2, every file that adop copies to the patch filesystem is tracked in a set of AD tables — specifically \`AD_FILE_VERSIONS\`, \`AD_FILES\`, and \`AD_PATCH_COMMON_ACTIONS\`. Before adop applies any file action in a new session, it runs a **checkfile** pass that compares three states for each file:

\`\`\`
For each file the patch wants to modify:
  1. Current state in PATCH filesystem (fs2) — actual file on disk
  2. Current state in RUN filesystem (fs1)   — actual file on disk
  3. Recorded state in AD_FILE_VERSIONS      — what the DB thinks is on disk

If any two of the three disagree beyond acceptable tolerance
→ checkfile flags the file as needing action or raises an error
\`\`\`

The purpose is efficiency: checkfile lets adop skip re-copying files that are already at the correct version in the patch filesystem, saving significant time on incremental patch applications. In a clean environment it is invisible. When something has disrupted the three-way consistency — a failed previous session, an NFS event, a manual file edit, a disk event — checkfile exposes the discrepancy and either flags files for re-copy or, in severe cases, fails the apply phase entirely.

---

## Where Checkfile Sits in the adop Lifecycle

\`\`\`
adop phase=prepare
  └── fs_clone: rsync RUN → PATCH filesystem

adop phase=apply
  ├── CHECKFILE PHASE ← failure occurs here
  │     Workers compare on-disk state vs AD_FILE_VERSIONS
  │     Flags files: NEEDS_COPY | ALREADY_DONE | ERROR
  │
  ├── COPY PHASE
  │     Copies flagged files from patch staging to patch filesystem
  │
  ├── GENERATE PHASE
  │     Compiles forms, generates JSPs, runs autoconfig
  │
  └── DB phase (SQL/EXEC/RELOAD drivers)

adop phase=finalize
adop phase=cutover
adop phase=cleanup
\`\`\`

Checkfile runs at the **beginning of the apply phase** — before any files are touched. A checkfile failure therefore leaves both filesystems completely unchanged. There is nothing to roll back and no partial state to clean up. The failure is diagnostic, not destructive.

---

## The Four Checkfile Failure Patterns

### Pattern 1 — Stale AD_FILE_VERSIONS Entries

The most common cause. A previous adop session failed mid-apply, or a cutover was interrupted, leaving \`AD_FILE_VERSIONS\` rows that describe a file state that no longer matches what is on disk. When the next apply session runs checkfile, the mismatch between the database record and the actual file causes an error.

\`\`\`
adop: ERROR: File version mismatch detected during checkfile.
  File: \$ONT_TOP/patch/115/import/ontatpicx.ldt
  Expected version (AD_FILE_VERSIONS): patch_level=12.2.0.1.0, size=48391
  Actual on disk:                       patch_level=12.2.0.0.0, size=43217
  Status: CHECKFILE_ERROR
\`\`\`

### Pattern 2 — File Missing from Patch Filesystem

An expected file exists in \`AD_FILE_VERSIONS\` and in the run filesystem (fs1) but is absent from the patch filesystem (fs2). This typically happens when:
- fs_clone was interrupted (disk full, NFS timeout) and did not complete
- A manual file deletion occurred in fs2 during troubleshooting
- The patch filesystem was rolled back or restored independently

\`\`\`
adop: ERROR: Checkfile expected file not found in patch filesystem.
  File: \$APPL_TOP/ont/12.0.0/forms/US/ONTPORD.fmx
  Path checked: /u01/oracle/EBS/fs2/EBSapps/appl/ont/12.0.0/forms/US/ONTPORD.fmx
  Result: FILE_NOT_FOUND
\`\`\`

### Pattern 3 — Database Error During Checkfile Query

Checkfile reads and writes extensively to AD tables during its comparison phase. An ORA error during these queries — tablespace full, lock contention, connection drop — aborts the checkfile pass entirely.

\`\`\`
adop: ERROR: Database error encountered during checkfile phase.
  ORA-01653: unable to extend table APPLSYS.AD_FILE_VERSIONS by 128 in tablespace SYSTEM
  ORA-01555: snapshot too old: rollback segment too small
  ORA-00060: deadlock detected while waiting for resource
\`\`\`

### Pattern 4 — Checkfile Worker Process Killed by OS

On systems with aggressive OOM killers or resource limits, the checkfile worker processes can be killed mid-execution by the OS. The adop session sees the worker exit unexpectedly and reports a checkfile phase failure.

\`\`\`
adop: ERROR: Checkfile worker process exited unexpectedly (signal 9).
  Worker PID 24817 terminated during file comparison pass.
\`\`\`

Check \`/var/log/messages\` or \`dmesg\` for OOM killer entries matching the worker PID and timestamp.

---

## Investigation

### Step 1 — Read the adop checkfile log

\`\`\`bash
# adop log directory
ADOPLOG=\$APPL_TOP/admin/adop_logs

# Most recent adop session log
LATEST=\$(ls -t "\$ADOPLOG"/adop*.log 2>/dev/null | head -1)
echo "Session log: \$LATEST"

# Find the checkfile-specific error block
grep -n -A5 -B2 "checkfile\|CHECKFILE\|File version mismatch\|FILE_NOT_FOUND\|checkfile_error" "\$LATEST" | head -60

# Get all ERROR lines from the session
grep -iE '^.*ERROR.*$|ORA-[0-9]+' "\$LATEST" | head -40

# Worker-level checkfile logs (one per worker process)
ls -lhrt "\$ADOPLOG"/adchkwrk*.log 2>/dev/null | tail -10
# Read the most recent worker log
tail -100 "\$(ls -t "\$ADOPLOG"/adchkwrk*.log 2>/dev/null | head -1)"
\`\`\`

### Step 2 — Check the adop session status in the database

\`\`\`sql
-- Current and recent sessions
SELECT s.adop_session_id,
       s.status,
       TO_CHAR(s.start_date, 'YYYY-MM-DD HH24:MI') started,
       s.prepare_status,
       s.apply_status,
       s.finalize_status,
       s.cutover_status,
       s.cleanup_status
FROM   ad_adop_sessions s
ORDER  BY s.start_date DESC
FETCH  FIRST 5 ROWS ONLY;

-- Specific failed apply phase detail
SELECT p.patch_name,
       p.patch_type,
       n.node_name,
       n.status,
       n.apply_status,
       TO_CHAR(n.start_date, 'YYYY-MM-DD HH24:MI') started,
       TO_CHAR(n.end_date,   'YYYY-MM-DD HH24:MI') ended
FROM   ad_adop_sessions     s
JOIN   ad_adop_session_patches p ON p.adop_session_id = s.adop_session_id
JOIN   ad_adop_patch_nodes     n ON n.adop_session_id = s.adop_session_id
WHERE  s.status IN ('INCOMPLETE', 'FAILED', 'RUNNING')
ORDER  BY s.start_date DESC;
\`\`\`

### Step 3 — Identify files with checkfile discrepancies

\`\`\`sql
-- Files where the AD record does not match expected state
-- (rows with DEST_FILE_SIZE or DEST_FILE_CHECKSUM populated but flagged)
SELECT afv.file_id,
       af.filename,
       af.subdir,
       afv.file_version,
       afv.translation_level,
       afv.dest_file_size,
       afv.dest_file_checksum,
       afv.last_update_date
FROM   applsys.ad_file_versions afv
JOIN   applsys.ad_files         af  ON af.file_id = afv.file_id
WHERE  afv.last_update_date >= SYSDATE - 1
  AND  af.filename LIKE '%.ldt'     -- change to the specific file type if known
ORDER  BY afv.last_update_date DESC
FETCH  FIRST 30 ROWS ONLY;

-- Check for bloating or lock contention on AD tables
SELECT segment_name,
       ROUND(bytes/1024/1024, 1) size_mb
FROM   dba_segments
WHERE  owner = 'APPLSYS'
  AND  segment_name IN ('AD_FILE_VERSIONS', 'AD_FILES', 'AD_PATCH_COMMON_ACTIONS')
ORDER  BY bytes DESC;

-- Any lock contention on AD tables during checkfile
SELECT s.sid, s.serial#, s.username, s.program,
       l.type, l.mode_held, o.object_name
FROM   v\$lock l
JOIN   dba_objects o ON o.object_id = l.id1
JOIN   v\$session   s ON s.sid = l.sid
WHERE  o.owner       = 'APPLSYS'
  AND  o.object_name IN ('AD_FILE_VERSIONS', 'AD_FILES')
  AND  l.type        = 'TM';
\`\`\`

### Step 4 — Verify the patch filesystem is complete

\`\`\`bash
# Compare file counts between run and patch filesystems for the affected module
# (use module short name from the checkfile log — e.g. ont, inv, ar)
MODULE="ont"

RUN_COUNT=\$(find /u01/oracle/EBS/fs1/EBSapps/appl/\$MODULE -type f 2>/dev/null | wc -l)
PATCH_COUNT=\$(find /u01/oracle/EBS/fs2/EBSapps/appl/\$MODULE -type f 2>/dev/null | wc -l)

echo "Run  filesystem (\$MODULE): \$RUN_COUNT files"
echo "Patch filesystem (\$MODULE): \$PATCH_COUNT files"

if [ \$RUN_COUNT -ne \$PATCH_COUNT ]; then
  echo "WARNING: File count mismatch — fs_clone may be incomplete"
  echo "  Difference: \$((RUN_COUNT - PATCH_COUNT)) files"
fi

# Check if a specific missing file exists in run but not patch
MISSING_FILE="ONTPORD.fmx"
ls /u01/oracle/EBS/fs1/EBSapps/appl/ont/12.0.0/forms/US/\$MISSING_FILE 2>/dev/null && echo "RUN: present" || echo "RUN: MISSING"
ls /u01/oracle/EBS/fs2/EBSapps/appl/ont/12.0.0/forms/US/\$MISSING_FILE 2>/dev/null && echo "PATCH: present" || echo "PATCH: MISSING"
\`\`\`

---

## Resolution Options

### Option 1 — Restart the apply phase (Pattern 1 and 2)

If the root cause is stale metadata from a previous incomplete session, adop's \`restart=yes\` forces a fresh checkfile pass that resets the comparison state.

\`\`\`bash
source /u01/oracle/EBS/EBSapps.env patch

# Restart apply — forces checkfile to re-evaluate from scratch
adop phase=apply restart=yes patches=35789012

# Monitor progress
tail -f "\$(ls -t \$APPL_TOP/admin/adop_logs/adop*.log | head -1)"
\`\`\`

### Option 2 — Re-run fs_clone then restart (Pattern 2 — missing files)

If files are genuinely absent from the patch filesystem, the clone must be completed before checkfile can succeed.

\`\`\`bash
source /u01/oracle/EBS/EBSapps.env patch

# Re-run the clone to fill in missing files
adop phase=prepare restart=yes

# Verify the missing file is now present
ls -lh /u01/oracle/EBS/fs2/EBSapps/appl/ont/12.0.0/forms/US/ONTPORD.fmx

# Then apply
adop phase=apply patches=35789012
\`\`\`

### Option 3 — Bypass checkfile with checkfile=no (Pattern 3 and 4)

When the checkfile failure is caused by a transient error (ORA-01555, OOM kill, NFS timeout) and you need the patch applied urgently, adop can skip the optimisation phase and copy all files unconditionally.

\`\`\`bash
# WARNING: checkfile=no causes adop to re-copy ALL patch files regardless of state.
# Apply time will be longer. Use only when:
#   - Root cause is confirmed as transient (OOM, ORA-01555, NFS)
#   - Underlying condition is fixed
#   - You need to apply urgently and cannot wait for checkfile investigation

source /u01/oracle/EBS/EBSapps.env patch
adop phase=apply patches=35789012 checkfile=no
\`\`\`

### Option 4 — Fix ORA errors blocking checkfile (Pattern 3)

\`\`\`sql
-- ORA-01653: tablespace full — extend it
ALTER TABLESPACE SYSTEM ADD DATAFILE
  '/u01/oracle/oradata/EBSPROD/system02.dbf' SIZE 2G AUTOEXTEND ON NEXT 512M;

-- Or extend the APPLSYS tablespace (more likely for AD tables)
ALTER TABLESPACE APPS_TS_TX_DATA ADD DATAFILE
  '/u01/oracle/oradata/EBSPROD/apps_ts_tx_data02.dbf' SIZE 2G AUTOEXTEND ON NEXT 256M;

-- ORA-01555: undo too small — increase undo retention
ALTER SYSTEM SET UNDO_RETENTION = 3600 SCOPE=BOTH;

-- After fixing the ORA error, restart the apply
\`\`\`

\`\`\`bash
source /u01/oracle/EBS/EBSapps.env patch
adop phase=apply restart=yes patches=35789012
\`\`\`

### Option 5 — Abort and start fresh (last resort)

Use only when the session state is too corrupted to restart and you have confirmed no partial file changes are at risk.

\`\`\`bash
source /u01/oracle/EBS/EBSapps.env patch
adop phase=abort

# Confirm abort
adop phase=status

# Start a new complete cycle
adop phase=prepare
adop phase=apply patches=35789012
\`\`\`

---

## Preventing Checkfile Failures

### Maintain AD table health

\`\`\`sql
-- Monitor AD_FILE_VERSIONS growth — should not exceed 3–4 GB in normal operations
SELECT ROUND(SUM(bytes)/1024/1024/1024, 2) size_gb
FROM   dba_segments
WHERE  owner        = 'APPLSYS'
  AND  segment_name = 'AD_FILE_VERSIONS';

-- Run GATHER_TABLE_STATS after large patch cycles to keep optimizer statistics current
-- (stale stats cause slow checkfile scans on large AD tables)
EXEC DBMS_STATS.GATHER_TABLE_STATS('APPLSYS', 'AD_FILE_VERSIONS', cascade => TRUE);
EXEC DBMS_STATS.GATHER_TABLE_STATS('APPLSYS', 'AD_FILES', cascade => TRUE);
EXEC DBMS_STATS.GATHER_TABLE_STATS('APPLSYS', 'AD_PATCH_COMMON_ACTIONS', cascade => TRUE);
\`\`\`

### Run adop cleanup after every successful patch cycle

\`\`\`bash
# Cleanup removes stale file version records and resets the patch filesystem
# to a known clean state — the single most effective checkfile failure prevention

adop phase=cleanup
\`\`\`

\`adop phase=cleanup\` is the step most frequently skipped under time pressure. Every skipped cleanup is a risk factor for the next checkfile run.

### Verify fs_clone completion before apply

\`\`\`bash
# Always check file counts after prepare before running apply
RUN_TOTAL=\$(find /u01/oracle/EBS/fs1/EBSapps/appl -type f 2>/dev/null | wc -l)
PATCH_TOTAL=\$(find /u01/oracle/EBS/fs2/EBSapps/appl -type f 2>/dev/null | wc -l)
DELTA=\$((RUN_TOTAL - PATCH_TOTAL))

echo "Run: \$RUN_TOTAL  Patch: \$PATCH_TOTAL  Delta: \$DELTA"
# Delta > 1000 files suggests an incomplete fs_clone
# Investigate before running adop phase=apply
\`\`\`

---

## Summary

An adop checkfile failure is diagnostic, not destructive — nothing has been applied and nothing needs to be rolled back. The failure means adop detected an inconsistency between the patch filesystem, the run filesystem, and the file version records in the AD tables before it risked copying anything. The investigation follows a short path: read the checkfile log for the specific file and error, check whether the patch filesystem is complete, check whether the ORA error visible in the log points to a tablespace or undo problem. In the majority of cases, \`adop phase=apply restart=yes\` with the underlying issue fixed is sufficient to recover. The \`checkfile=no\` bypass exists for genuine emergencies but should not become a habit — it exists to skip an optimisation, not to hide the problem that caused checkfile to fail.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'EBS 12.2 adop: Diagnosing and Fixing Checkfile Phase Failures',
    slug,
    excerpt: 'adop phase=apply fails during the checkfile phase — four distinct patterns: stale AD_FILE_VERSIONS metadata, missing files in the patch filesystem, ORA errors during checkfile queries, and OOM-killed worker processes. Covers log reading, AD table investigation, filesystem comparison, and five resolution paths from restart=yes through checkfile=no bypass.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
