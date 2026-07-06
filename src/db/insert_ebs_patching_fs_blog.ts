import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-patching-filesystem-sync-failure-stalled-workers';

const content = `
The patch has been running for two hours. Nothing appears on the adpatch or adop screen. The log shows the same line it showed forty minutes ago. Workers are in RUNNING state but producing no new output. This is not a database lock. It is not a FNDLOAD error. The application tier's filesystem has stalled — a full disk, an NFS mount that stopped responding, or a synchronization operation that never completed.

This post covers the three most common filesystem-related EBS patching failures, how to identify which one you have, and how to recover cleanly without discarding progress.

---

## The Three Filesystem Failure Modes

| Mode | Symptom | Root cause |
|---|---|---|
| **Disk full** | Workers stall mid-copy; OS error in worker logs | \`$APPL_TOP\` or \`/tmp\` partition exhausted during patch |
| **NFS stale handle** | "Stale file handle" or "No such file or directory" errors in worker logs | NFS server-side eviction or client cache inconsistency |
| **adop fs_clone hang** | adop phase=fs_clone stalls; no output; INCOMPLETE session in AD tables (EBS 12.2) | rsync between run and patch filesystems blocked by full disk or NFS timeout |

---

## EBS 12.2: The adop Filesystem Architecture

Understanding why filesystem failures are so disruptive in EBS 12.2 requires a brief look at the two-edition filesystem model.

\`\`\`
/u01/oracle/EBS/
├── fs1/                    ← EBSapps.env RUN edition (serving live traffic)
│   └── EBSapps/
│       ├── appl/           ← APPL_TOP for run edition
│       └── inst/           ← INST_TOP for run edition
│
├── fs2/                    ← PATCH edition (offline, where adop apply runs)
│   └── EBSapps/
│       ├── appl/           ← APPL_TOP for patch edition
│       └── inst/
│
└── fs_ne/                  ← Non-editioned files (shared, not edition-specific)
\`\`\`

The adop patch cycle proceeds through these phases:

\`\`\`
prepare  →  apply  →  finalize  →  cutover  →  cleanup
   ↑
   └── fs_clone runs here: rsync RUN edition → PATCH edition
       This sync must complete before any patch files are applied.
\`\`\`

**fs_clone** uses \`rsync\` to copy the run filesystem to the patch filesystem. On a large application tier (20–80 GB of \`$APPL_TOP\`), this can take 30–90 minutes. If the disk hosting \`fs2/\` fills up during the sync, or if an NFS mount times out mid-rsync, the clone stalls or fails. The adop session records an INCOMPLETE status in the database.

---

## Mode 1 — Disk Full During Patch Apply

### What happens

During adpatch's copy driver phase, workers extract and copy thousands of files to \`$APPL_TOP\`. If the partition fills up, the OS write fails with a "No space left on device" error. The worker process exits unexpectedly, leaving partial or zero-byte files on disk. adpatch records the job as FAILED, but the root cause is never "file corruption" — it is a capacity problem.

In adop (12.2), disk full during fs_clone produces:

\`\`\`
rsync: [sender] write error: No space left on device (28)
rsync error: error in file IO (code 11) at receiver.c(393)
\`\`\`

### Identification

\`\`\`bash
# Check all filesystems involved in EBS patching
df -h \$APPL_TOP \$INST_TOP /tmp /u01

# In 12.2, check both editions
df -h /u01/oracle/EBS/fs1 /u01/oracle/EBS/fs2 /u01/oracle/EBS/fs_ne

# Find what is consuming space — top directories under APPL_TOP
du -sh \$APPL_TOP/* 2>/dev/null | sort -rh | head -20

# Check /tmp — patch operations write large temp files
du -sh /tmp && ls -lhS /tmp/*.zip /tmp/*.jar 2>/dev/null | head -10

# Check AD patch staging area
du -sh \$APPL_TOP/../patch/* 2>/dev/null | sort -rh | head -10
\`\`\`

### Common space consumers during patching

| Location | Typical cause of growth |
|---|---|
| \`$APPL_TOP/admin/out\` | adpatch output files accumulate across sessions |
| \`$APPL_TOP/admin/log\` | Worker logs, especially from long sessions with many iterations |
| \`/tmp\` | Patch zip extraction, JVM temp classes |
| \`$APPL_TOP/../patch\` | Old patch staging directories not cleaned after apply |
| \`fs2/EBSapps/appl\` | fs_clone mid-run duplicates |

### Recovery: free space and resume

\`\`\`bash
# 1. Identify and remove old patch staging directories (keep current patch)
ls -lhd \$APPL_TOP/../patch/*/
# Remove old ones — verify none are for the current in-progress patch
rm -rf \$APPL_TOP/../patch/XXXXXXXX   # old patch number

# 2. Compress or archive old adpatch log and out directories
LOGDIR=\$APPL_TOP/admin/\$TWO_TASK/log
OUTDIR=\$APPL_TOP/admin/\$TWO_TASK/out

# Archive logs older than 30 days
find "\$LOGDIR" -name "*.log" -mtime +30 -exec gzip {} \\;
find "\$OUTDIR" -name "*.out" -mtime +30 -exec gzip {} \\;

# 3. Clean Java/JVM temp files
rm -f /tmp/hsperfdata_* /tmp/*.class /tmp/OraInstall* 2>/dev/null

# 4. Verify space recovered
df -h \$APPL_TOP

# 5. Resume (adpatch 12.1 — restart existing session)
cd /u01/patches/<patch_number>
adpatch

# 6. Resume (adop 12.2 — restart the failed phase)
adop phase=apply restart=yes

# Or restart the full cycle from the failed phase:
adop phase=fs_clone    # if clone did not complete
adop phase=apply       # if clone completed but apply failed
\`\`\`

---

## Mode 2 — NFS Stale File Handle

### What happens

EBS application tier files are commonly stored on NFS. When the NFS server reclaims a file handle — due to a server-side restart, an NFS lock daemon failure, or a client-side cache timeout — subsequent reads and writes to files through that handle return:

\`\`\`
ls: /u01/oracle/EBS/fs1/EBSapps/appl/inv/12.0.0/forms/US/INVIDITM.fmx:
Stale file handle

cp: cannot stat '/u01/oracle/EBS/fs1/EBSapps/appl/fnd/12.0.0/resource/fndrsrun.msg':
Stale file handle

rsync: [sender] change_dir "/u01/oracle/EBS/fs2/EBSapps/appl/qp/12.0.0":
failed: Stale file handle (116)
\`\`\`

Unlike a disk-full error, the filesystem is mounted and reports space, but file operations fail at random on the stale handles.

### Identification

\`\`\`bash
# Test for stale handles — try listing each EBS top-level directory
for TOP in \$APPL_TOP \$INST_TOP \$ORACLE_HOME; do
  ls "\$TOP" > /dev/null 2>&1
  if [ \$? -ne 0 ]; then
    echo "STALE: \$TOP"
  else
    echo "OK: \$TOP"
  fi
done

# Find the NFS mount points relevant to EBS
mount | grep nfs
df -hT | grep nfs

# Identify which NFS mount owns APPL_TOP
stat \$APPL_TOP 2>&1

# Check for active NFS errors in kernel ring buffer
dmesg | grep -iE 'nfs|stale|server not responding' | tail -20

# Check OS logs
grep -iE 'nfs|stale' /var/log/messages | tail -30
\`\`\`

### Recovery: remount the NFS filesystem

\`\`\`bash
# 1. Stop the adpatch/adop session first (if still running)
#    Use adctrl option 5 (tell manager to quit after current task)
#    or simply let workers fail and note their state

# 2. Identify the stale mount
STALE_MOUNT=/u01/oracle/EBS   # adjust to your mount point

# 3. Force unmount and remount
# First kill any processes holding file handles on this mount
fuser -km "\$STALE_MOUNT" 2>/dev/null

umount -f -l "\$STALE_MOUNT"
mount "\$STALE_MOUNT"
# Or: mount -a (remounts all /etc/fstab entries)

# 4. Verify the mount is clean
ls -la "\$STALE_MOUNT/fs1/EBSapps/appl" | head -5
ls -la "\$STALE_MOUNT/fs2/EBSapps/appl" | head -5

# 5. Re-source EBS environment after remount
source /u01/oracle/EBS/EBSapps.env run

# 6. Resume the patch session
# For adpatch (12.1): restart adpatch in the patch directory — it detects the existing session
# For adop (12.2): use restart=yes
adop phase=apply restart=yes
\`\`\`

---

## Mode 3 — adop fs_clone Stall / INCOMPLETE Session (EBS 12.2)

### What happens

The adop prepare phase clones the run filesystem to the patch filesystem using rsync. If:
- The patch filesystem disk fills mid-clone
- An NFS timeout interrupts the rsync
- An OS signal kills the adop process

Then adop exits without completing, leaving the session in INCOMPLETE status in the AD tables. On the next adop invocation, the tool detects the existing incomplete session and refuses to start a new one — it requires you to explicitly restart or abort the previous session.

\`\`\`
$ adop phase=prepare

ERROR: An adop session already exists in state INCOMPLETE.
Please use adop phase=prepare restart=yes to restart the failed session,
or adop phase=abort to abort it and begin a fresh session.
\`\`\`

### Identify the incomplete session

\`\`\`sql
-- Current adop session state
SELECT s.adop_session_id,
       s.node_name,
       s.status,
       s.start_date,
       s.end_date,
       s.prepare_status,
       s.apply_status,
       s.finalize_status,
       s.cutover_status,
       s.cleanup_status
FROM   ad_adop_sessions s
ORDER  BY s.start_date DESC
FETCH  FIRST 5 ROWS ONLY;

-- Per-node status breakdown
SELECT n.node_name,
       n.status,
       n.prepare_status,
       n.apply_status,
       n.finalize_status,
       n.cutover_status,
       n.cleanup_status
FROM   ad_adop_session_patches sp
JOIN   ad_adop_sessions s ON s.adop_session_id = sp.adop_session_id
JOIN   ad_adop_patch_nodes n ON n.adop_session_id = sp.adop_session_id
WHERE  s.status IN ('INCOMPLETE', 'FAILED', 'RUNNING')
ORDER  BY s.start_date DESC;
\`\`\`

### Check which phase failed and on which node

\`\`\`bash
# adop log location (12.2)
ADOPLOG=\$APPL_TOP/admin/adop_logs

ls -lhrt "\$ADOPLOG"

# Most recent adop session log
LATEST_LOG=\$(ls -t "\$ADOPLOG"/adop*.log 2>/dev/null | head -1)
tail -100 "\$LATEST_LOG"

# Filter for errors
grep -iE 'error|fail|stale|no space|rsync error|INCOMPLETE' "\$LATEST_LOG" | tail -30
\`\`\`

### Decision: restart vs abort

\`\`\`
INCOMPLETE adop session found
│
├── Failed phase = fs_clone or prepare?
│     └── Root cause fixed (space freed / NFS remounted)?
│           YES → adop phase=prepare restart=yes
│           NO  → Fix root cause first, then restart
│
├── Failed phase = apply?
│     └── adop phase=apply restart=yes
│         (adop resumes from the last successfully applied patch file)
│
├── Failed on multiple nodes but complete on primary?
│     └── adop phase=<failed_phase> restart=yes node=<node_name>
│         (target only the failed node)
│
└── Session too broken to restart (multiple failed phases, mixed state)?
      └── adop phase=abort
          Then start a fresh session: adop phase=prepare
\`\`\`

### Restart commands

\`\`\`bash
# Source PATCH edition environment for adop commands
source /u01/oracle/EBS/EBSapps.env patch

# Restart the failed prepare/fs_clone phase
adop phase=prepare restart=yes

# Restart apply phase only (if prepare completed)
adop phase=apply restart=yes

# Restart a specific node in a multi-node environment
adop phase=apply restart=yes node=ebsapp02

# Abort and start fresh (last resort — loses all progress)
adop phase=abort
adop phase=prepare
adop phase=apply patches=<patch_id>
\`\`\`

---

## Retry Limits and Deferment Counters

In adpatch (12.1), each job has a deferment counter in \`ad_deferred_jobs\`. The manager retries a failed job up to two times automatically. After two deferments the job is marked FAILED and the manager stops retrying. A filesystem failure that resolves itself (e.g., NFS recovers) within the first two retries will succeed silently. Beyond two retries you must use adctrl.

\`\`\`sql
-- Jobs that have been deferred multiple times (persistent failures)
SELECT j.filename,
       j.product_short_name,
       j.execution_status,
       j.failure_count,
       j.log_filename
FROM   applsys.ad_deferred_jobs j
WHERE  j.failure_count >= 2
ORDER  BY j.failure_count DESC, j.start_date DESC;
\`\`\`

After fixing the root cause, use adctrl option 2 (restart failed job) for each FAILED worker.

---

## Pre-Patch Filesystem Capacity Check

Run this before every adpatch or adop session. It tells you whether you have enough space to complete the patch safely.

\`\`\`bash
#!/bin/bash
# /u01/scripts/ebs_fs_prepatch_check.sh

echo "=== EBS Pre-Patch Filesystem Capacity Check ==="
echo "Generated: \$(date)"
echo ""

# Source EBS environment first
[ -z "\$APPL_TOP" ] && { echo "ERROR: EBS environment not sourced"; exit 1; }

echo "--- Filesystem usage (must be below 80% before patching) ---"
df -hT \$APPL_TOP \$INST_TOP /tmp 2>/dev/null | column -t
echo ""

# 12.2 — check both editions
if [ -d /u01/oracle/EBS/fs2 ]; then
  echo "--- EBS 12.2 edition filesystems ---"
  df -hT /u01/oracle/EBS/fs1 /u01/oracle/EBS/fs2 /u01/oracle/EBS/fs_ne 2>/dev/null | column -t
  echo ""
fi

echo "--- Top 10 space consumers under APPL_TOP ---"
du -sh \$APPL_TOP/* 2>/dev/null | sort -rh | head -10
echo ""

echo "--- Old patch staging directories (candidates for cleanup) ---"
find \$APPL_TOP/../patch -maxdepth 1 -mindepth 1 -type d -mtime +7 2>/dev/null | xargs du -sh 2>/dev/null | sort -rh
echo ""

echo "--- NFS mount health ---"
for MNT in \$(mount | grep nfs | awk '{print \$3}'); do
  ls "\$MNT" > /dev/null 2>&1
  if [ \$? -eq 0 ]; then
    echo "  OK: \$MNT"
  else
    echo "  STALE: \$MNT ← MUST REMOUNT BEFORE PATCHING"
  fi
done
echo ""

echo "--- Inode usage (low inodes cause copy failures without showing disk full) ---"
df -i \$APPL_TOP /tmp 2>/dev/null | column -t
echo ""

echo "=== End of check ==="
\`\`\`

---

## Summary

Filesystem failures in EBS patching fall into three patterns — disk full, NFS stale handle, and adop fs_clone stall — and all three share the same investigative starting point: check \`df\` and the worker logs for OS-level errors before assuming the problem is in the database or the patch files. Disk-full recovery requires freeing space and resuming the session; NFS stale handle recovery requires a forced remount and then a resume; adop INCOMPLETE sessions require an explicit \`restart=yes\` flag after fixing the underlying condition. None of these scenarios requires starting the patch from scratch, provided you identify the root cause before taking recovery action. The pre-patch filesystem capacity check script catches all three risk factors — utilisation over 80%, stale NFS mounts, and low inode counts — before adpatch or adop is invoked.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'EBS Patching: Filesystem Sync Failures, Stalled Workers, and Incomplete Sessions',
    slug,
    excerpt: 'Three EBS patching failures caused by filesystem problems — disk full during copy, NFS stale file handles, and adop fs_clone stalls leaving INCOMPLETE sessions. Covers identification via df, dmesg and worker logs, safe NFS remount procedure, adop restart vs abort decision, retry counter behaviour in adpatch, and a pre-patch filesystem capacity check script.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
