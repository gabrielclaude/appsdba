import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-patching-filesystem-sync-failure-runbook';

const content = `
Operations runbook for diagnosing and recovering EBS patch sessions stalled by filesystem failures — disk full, NFS stale file handles, and adop fs_clone INCOMPLETE sessions. Includes phase-by-phase investigation procedures, a fully automated filesystem analysis script, safe recovery commands for both adpatch (12.1) and adop (12.2), and a pre-patch capacity validation script.

**Applies to:** EBS 12.1.x (adpatch), EBS 12.2.x (adop), single-node and multi-node environments

---

## Phase 1 — Triage: Identify the Failure Mode

Run these commands immediately when a patch stalls. Outcome determines which recovery path to follow.

\`\`\`bash
# ── Step 1: Check OS-level disk state ──────────────────────────────────────
df -hT

# In 12.2 — both editions plus shared
df -hT /u01/oracle/EBS/fs1 /u01/oracle/EBS/fs2 /u01/oracle/EBS/fs_ne /tmp 2>/dev/null

# ── Step 2: Check for NFS errors in the kernel ring buffer ──────────────────
dmesg | grep -iE 'nfs|stale|server not responding|RPC|timed out' | tail -20

# ── Step 3: Test NFS mount accessibility ───────────────────────────────────
for MNT in \$(mount | grep nfs | awk '{print \$3}'); do
  timeout 5 ls "\$MNT" > /dev/null 2>&1
  [ \$? -eq 0 ] && echo "OK:    \$MNT" || echo "STALE: \$MNT"
done

# ── Step 4: Read the most recently modified worker log ─────────────────────
LOG_DIR=\$APPL_TOP/admin/\$TWO_TASK/log      # 12.1
# For 12.2 adop: LOG_DIR=\$APPL_TOP/admin/adop_logs

LATEST=\$(ls -t "\$LOG_DIR"/adwork*.log 2>/dev/null | head -1)
[ -z "\$LATEST" ] && LATEST=\$(ls -t "\$LOG_DIR"/adop*.log 2>/dev/null | head -1)
echo "Most recent log: \$LATEST"
tail -40 "\$LATEST"
grep -iE 'no space|stale|rsync error|errno|Error 28|disk full|write error|Input/output' "\$LATEST" | tail -20
\`\`\`

### Triage outcome table

| Evidence | Failure mode | Go to |
|---|---|---|
| "No space left on device" in worker log | Disk full | Phase 3A |
| "Stale file handle" in log or dmesg | NFS stale handle | Phase 3B |
| adop reports "session already exists in state INCOMPLETE" | adop fs_clone / phase stall | Phase 3C |
| Worker shows FAILED with failure_count >= 2 and no OS error | Investigate separately (likely SQL or LDT error) | — |

---

## Phase 2 — Preserve State Before Any Action

\`\`\`bash
# Record all worker statuses before making changes
TIMESTAMP=\$(date +%Y%m%d_%H%M%S)
SNAPSHOT_DIR=/tmp/ebs_patch_snapshot_\$TIMESTAMP
mkdir -p "\$SNAPSHOT_DIR"

# Copy all worker logs
cp \$APPL_TOP/admin/\$TWO_TASK/log/adwork*.log "\$SNAPSHOT_DIR/" 2>/dev/null

# Snapshot filesystem state
df -hT > "\$SNAPSHOT_DIR/df_at_failure.txt"
du -sh \$APPL_TOP/* >> "\$SNAPSHOT_DIR/df_at_failure.txt" 2>/dev/null

# Snapshot database job state
sqlplus -S apps/"\$APPS_PASSWORD"@"\$TWO_TASK" << 'SQLEOF' > "\$SNAPSHOT_DIR/ad_jobs_at_failure.txt" 2>&1
SET PAGESIZE 100 LINESIZE 150 FEEDBACK OFF
SELECT filename, product_short_name, execution_status, failure_count, log_filename
FROM   applsys.ad_deferred_jobs
WHERE  execution_status IN ('F','D','R')
ORDER  BY failure_count DESC, start_date DESC;
EXIT;
SQLEOF

echo "State snapshot saved to: \$SNAPSHOT_DIR"
\`\`\`

---

## Phase 3A — Recovery: Disk Full

### Identify what consumed space

\`\`\`bash
# Top consumers under APPL_TOP
echo "--- APPL_TOP ---"
du -sh \$APPL_TOP/* 2>/dev/null | sort -rh | head -15

# Check old patch staging directories
echo "--- Patch staging (old patches safe to remove) ---"
ls -lhd \$APPL_TOP/../patch/*/ 2>/dev/null | sort -k6,7
find \$APPL_TOP/../patch -maxdepth 1 -mindepth 1 -type d | while read D; do
  echo "\$(du -sh "\$D" 2>/dev/null | cut -f1)   \$D   (mtime: \$(stat -c %y "\$D" | cut -d' ' -f1))"
done

# Check log and out directories
du -sh \$APPL_TOP/admin/\$TWO_TASK/log
du -sh \$APPL_TOP/admin/\$TWO_TASK/out

# Check /tmp
du -sh /tmp && ls -lhS /tmp | head -20
\`\`\`

### Free space safely

\`\`\`bash
# 1. Remove old patch staging directories (NOT the current patch)
CURRENT_PATCH="24915769"   # replace with the patch currently being applied
for D in \$APPL_TOP/../patch/*/; do
  PATCH_NUM=\$(basename "\$D")
  if [ "\$PATCH_NUM" != "\$CURRENT_PATCH" ] && [ "\$PATCH_NUM" != "." ]; then
    echo "Removing old staging: \$D (\$(du -sh "\$D" 2>/dev/null | cut -f1))"
    rm -rf "\$D"
  fi
done

# 2. Compress old log and out files (older than 14 days)
find \$APPL_TOP/admin/\$TWO_TASK/log -name "*.log" -mtime +14 ! -name "adwork*.log" -exec gzip -q {} \;
find \$APPL_TOP/admin/\$TWO_TASK/out -name "*.out" -mtime +14 -exec gzip -q {} \;

# 3. Clean /tmp of EBS-related temp files
rm -f /tmp/hsperfdata_\$USER/* /tmp/Orainstall* /tmp/*.class 2>/dev/null
# Remove large zip/jar files in /tmp if they are from an earlier extraction
find /tmp -name "*.zip" -o -name "*.jar" 2>/dev/null | xargs ls -lh 2>/dev/null

# 4. In 12.2 — clean the failed fs2 partial clone
# Only if fs_clone failed partway through. Verify with: du -sh /u01/oracle/EBS/fs2
# A partially cloned fs2 may contain stale copies using more space than expected.
# DO NOT remove fs2 if adop apply has already completed on it.

# 5. Verify space recovered
df -hT \$APPL_TOP /tmp
\`\`\`

### Resume after disk-full fix

\`\`\`bash
# 12.1 — adpatch detects existing session and resumes
cd /u01/patches/\$CURRENT_PATCH
adpatch

# 12.2 — adop restart
source /u01/oracle/EBS/EBSapps.env patch

# If disk full happened during fs_clone / prepare:
adop phase=prepare restart=yes

# If disk full happened during apply:
adop phase=apply restart=yes patches=\$CURRENT_PATCH

# Verify resumed session
adop phase=status
\`\`\`

---

## Phase 3B — Recovery: NFS Stale File Handle

### Confirm NFS is the problem

\`\`\`bash
# Identify the NFS server and mount options
mount | grep nfs

# Check NFS client statistics — retransmissions and timeouts
nfsstat -c 2>/dev/null | head -30

# Test reads and writes on the stale mount
STALE_MNT=\$APPL_TOP    # adjust to the stale mount point
timeout 10 ls "\$STALE_MNT" > /dev/null 2>&1 || echo "CONFIRMED STALE: \$STALE_MNT"

# Check which processes hold file handles on this mount
fuser "\$STALE_MNT" 2>/dev/null
lsof +D "\$STALE_MNT" 2>/dev/null | head -20
\`\`\`

### Stop EBS processes using the mount

Before remounting, ensure no EBS process has open file handles. If adpatch/adop workers are still running, let them fail rather than killing them mid-write.

\`\`\`bash
# 1. If adpatch manager is still up — use adctrl to stop gracefully
#    adctrl → Option 5 (Tell manager to quit after current task)

# 2. Kill the Concurrent Manager if it uses this mount
# Do NOT kill CM in production — coordinate with the team

# 3. Kill any stale EBS OS processes holding the mount
fuser -km "\$STALE_MNT" 2>/dev/null
\`\`\`

### Remount the NFS filesystem

\`\`\`bash
STALE_MNT=/u01/oracle/EBS    # adjust to your NFS mount point

# Lazy unmount — detaches the mount from the filesystem namespace immediately
# Active processes get I/O errors, file handles will be released
umount -l "\$STALE_MNT"

# Wait 5 seconds for kernel to clear
sleep 5

# Remount from /etc/fstab
mount "\$STALE_MNT"

# Verify
ls -la "\$STALE_MNT/fs1/EBSapps/appl" | head -5
ls -la "\$STALE_MNT/fs2/EBSapps/appl" | head -5
echo "NFS remount: OK"

# Re-source EBS environment (paths may have been invalidated)
source /u01/oracle/EBS/EBSapps.env run
\`\`\`

### If the NFS server itself is unreachable

\`\`\`bash
NFS_SERVER="nfsserver01"   # replace with actual NFS server hostname

# Ping test
ping -c 4 \$NFS_SERVER

# RPC portmapper test
rpcinfo -p \$NFS_SERVER 2>&1 | head -10

# NFS export test
showmount -e \$NFS_SERVER 2>&1

# If NFS server is down — escalate to storage team before proceeding
# Do not attempt to resume adpatch while the NFS server is unavailable
\`\`\`

### Resume after NFS fix

\`\`\`bash
# 12.1
cd /u01/patches/\$CURRENT_PATCH
adpatch
# adpatch will restart failed workers (use adctrl if any are in FAILED state)

# 12.2
source /u01/oracle/EBS/EBSapps.env patch
adop phase=apply restart=yes patches=\$CURRENT_PATCH
\`\`\`

---

## Phase 3C — Recovery: adop INCOMPLETE Session (EBS 12.2 Only)

### Check which phases completed and on which nodes

\`\`\`sql
SELECT s.adop_session_id,
       s.status,
       s.start_date,
       s.prepare_status,
       s.apply_status,
       s.finalize_status,
       s.cutover_status,
       s.cleanup_status
FROM   ad_adop_sessions s
WHERE  s.status IN ('INCOMPLETE', 'FAILED', 'RUNNING')
ORDER  BY s.start_date DESC
FETCH  FIRST 3 ROWS ONLY;
\`\`\`

\`\`\`sql
-- Per-node status (multi-node environments)
SELECT n.node_name,
       n.status,
       n.prepare_status,
       n.apply_status,
       n.finalize_status,
       n.cutover_status
FROM   ad_adop_sessions s
JOIN   ad_adop_patch_nodes n ON n.adop_session_id = s.adop_session_id
WHERE  s.status IN ('INCOMPLETE', 'FAILED', 'RUNNING')
ORDER  BY s.start_date DESC, n.node_name;
\`\`\`

### Decision: restart vs abort

\`\`\`bash
# ── RESTART: root cause is fixed, session state is consistent ──────────────
source /u01/oracle/EBS/EBSapps.env patch

# Restart the failed prepare phase (fs_clone)
adop phase=prepare restart=yes

# Restart the failed apply phase
adop phase=apply restart=yes patches=\$CURRENT_PATCH

# Restart on a specific node only
adop phase=apply restart=yes patches=\$CURRENT_PATCH node=ebsapp02

# ── ABORT: session state is inconsistent or too many phases failed ─────────
# WARNING: abort discards all patch progress — the patch must be re-applied
adop phase=abort
\`\`\`

### After restart: monitor progress

\`\`\`bash
# Watch adop log in real time
ADOPLOG=\$APPL_TOP/admin/adop_logs
tail -f "\$(ls -t "\$ADOPLOG"/adop*.log | head -1)"

# In a separate terminal — check adop status every 30 seconds
watch -n 30 "adop phase=status 2>/dev/null"
\`\`\`

---

## Automated Filesystem Analysis Script

\`\`\`bash
#!/bin/bash
# /u01/scripts/ebs_fs_analysis.sh
# Run as applmgr with EBS environment sourced when a patch stalls.
# Usage: ./ebs_fs_analysis.sh [apps_password] [db_connect_string]

APPS_PWD=\${1:-"apps"}
DB_CONN=\${2:-"\$TWO_TASK"}
REPORT=/tmp/ebs_fs_analysis_\$(date +%Y%m%d_%H%M%S).txt
DIV="=================================================================="

r() { echo "\$1" | tee -a "\$REPORT"; }

r "\$DIV"
r "EBS Filesystem Failure Analysis — \$(date)"
r "TWO_TASK=\$TWO_TASK | APPL_TOP=\$APPL_TOP"
r "\$DIV"

# ── 1. Disk usage ────────────────────────────────────────────────────────────
r ""
r "1. DISK USAGE"
df -hT 2>/dev/null | tee -a "\$REPORT"

if [ -d /u01/oracle/EBS/fs2 ]; then
  r ""
  r "   adop edition filesystems:"
  df -hT /u01/oracle/EBS/fs1 /u01/oracle/EBS/fs2 /u01/oracle/EBS/fs_ne 2>/dev/null | tee -a "\$REPORT"
fi

r ""
r "   Inode usage (low inodes cause write failures without disk-full errors):"
df -i \$APPL_TOP /tmp 2>/dev/null | tee -a "\$REPORT"

# ── 2. Top consumers ─────────────────────────────────────────────────────────
r ""
r "2. TOP SPACE CONSUMERS"
r "   Under APPL_TOP:"
du -sh \$APPL_TOP/* 2>/dev/null | sort -rh | head -10 | tee -a "\$REPORT"
r "   /tmp:"
du -sh /tmp/\$USER 2>/dev/null | tee -a "\$REPORT"

# ── 3. Old patch staging ─────────────────────────────────────────────────────
r ""
r "3. OLD PATCH STAGING DIRECTORIES (safe to remove if not current patch)"
find \$APPL_TOP/../patch -maxdepth 1 -mindepth 1 -type d 2>/dev/null | while read D; do
  SIZE=\$(du -sh "\$D" 2>/dev/null | cut -f1)
  AGE=\$(stat -c %y "\$D" 2>/dev/null | cut -d' ' -f1)
  r "   \$SIZE   \$D   (modified: \$AGE)"
done

# ── 4. NFS health ────────────────────────────────────────────────────────────
r ""
r "4. NFS MOUNT HEALTH"
mount | grep nfs | tee -a "\$REPORT"
r ""
for MNT in \$(mount | grep nfs | awk '{print \$3}'); do
  timeout 8 ls "\$MNT" > /dev/null 2>&1
  if [ \$? -eq 0 ]; then
    r "   OK:    \$MNT"
  else
    r "   STALE: \$MNT  ← REMOUNT REQUIRED"
  fi
done

# ── 5. Kernel NFS errors ─────────────────────────────────────────────────────
r ""
r "5. KERNEL / OS ERRORS (last 50 lines of dmesg)"
dmesg | grep -iE 'nfs|stale|no space|i/o error|server not responding' | tail -20 | tee -a "\$REPORT"

# ── 6. Worker log errors ─────────────────────────────────────────────────────
r ""
r "6. WORKER LOG ERRORS"
LOG_DIR=\$APPL_TOP/admin/\$TWO_TASK/log
for LOG in "\$LOG_DIR"/adwork*.log; do
  [ -f "\$LOG" ] || continue
  HITS=\$(grep -icE 'no space|stale|rsync error|Error 28|Input/output|write error' "\$LOG" 2>/dev/null)
  if [ "\${HITS:-0}" -gt 0 ]; then
    r ""
    r "   \$(basename "\$LOG") — \$HITS filesystem error(s):"
    grep -iE 'no space|stale|rsync error|Error 28|Input/output|write error' "\$LOG" | tail -5 | \
      while read -r line; do r "     \$line"; done
  fi
done

# ── 7. adop session state (12.2) ─────────────────────────────────────────────
if command -v adop > /dev/null 2>&1; then
  r ""
  r "7. ADOP SESSION STATE (12.2)"
  sqlplus -S "apps/\${APPS_PWD}@\${DB_CONN}" << 'SQLEOF' 2>&1 | tee -a "\$REPORT"
SET PAGESIZE 20 LINESIZE 150 FEEDBACK OFF
SELECT s.adop_session_id, s.status,
       TO_CHAR(s.start_date,'YYYY-MM-DD HH24:MI') started,
       s.prepare_status, s.apply_status, s.finalize_status
FROM   ad_adop_sessions s
ORDER  BY s.start_date DESC
FETCH  FIRST 3 ROWS ONLY;
EXIT;
SQLEOF
fi

# ── 8. AD deferred jobs ──────────────────────────────────────────────────────
r ""
r "8. AD DEFERRED JOB FAILURES (adpatch)"
sqlplus -S "apps/\${APPS_PWD}@\${DB_CONN}" << 'SQLEOF' 2>&1 | tee -a "\$REPORT"
SET PAGESIZE 30 LINESIZE 150 FEEDBACK OFF
SELECT filename, product_short_name, execution_status,
       failure_count, log_filename
FROM   applsys.ad_deferred_jobs
WHERE  execution_status IN ('F','D')
ORDER  BY failure_count DESC, start_date DESC
FETCH  FIRST 20 ROWS ONLY;
EXIT;
SQLEOF

# ── 9. Recommendation ────────────────────────────────────────────────────────
r ""
r "9. RECOMMENDED ACTION"
DISK_FULL=\$(df -hT 2>/dev/null | awk 'NR>1 {gsub(/%/,""); if (\$6+0 >= 90) print \$7 " at " \$6"%"}')
NFS_STALE=\$(for MNT in \$(mount | grep nfs | awk '{print \$3}'); do
  timeout 8 ls "\$MNT" > /dev/null 2>&1 || echo "\$MNT"
done)

if [ -n "\$DISK_FULL" ]; then
  r "   → DISK FULL DETECTED: \$DISK_FULL"
  r "     1. Free space (remove old patch staging, compress old logs)"
  r "     2. Verify df shows < 80% usage"
  r "     3. Resume: adpatch (12.1) or adop phase=apply restart=yes (12.2)"
elif [ -n "\$NFS_STALE" ]; then
  r "   → NFS STALE HANDLE: \$NFS_STALE"
  r "     1. umount -l <mount> && mount <mount>"
  r "     2. Re-source EBS environment"
  r "     3. Resume: adpatch or adop phase=apply restart=yes"
else
  r "   → No filesystem issue detected from OS metrics"
  r "     Check worker logs in section 6 for specific SQL or LDT errors"
fi

r ""
r "\$DIV"
r "Report: \$REPORT"
echo ""
echo "Analysis complete. Report: \$REPORT"
\`\`\`

---

## Pre-Patch Filesystem Validation Script

\`\`\`bash
#!/bin/bash
# /u01/scripts/ebs_prepatch_fs_check.sh
# Run before every adpatch / adop session. Must pass all checks before starting.

[ -z "\$APPL_TOP" ] && { echo "ERROR: Source EBS environment first"; exit 1; }

PASS=0; FAIL=0
check() {
  local desc="\$1" result="\$2"
  if [ "\$result" = "OK" ]; then
    echo "  PASS: \$desc"
    PASS=\$((PASS+1))
  else
    echo "  FAIL: \$desc — \$result"
    FAIL=\$((FAIL+1))
  fi
}

echo "========================================"
echo " EBS Pre-Patch Filesystem Check"
echo " \$(date)"
echo "========================================"
echo ""

echo "--- Disk capacity (must be < 80%) ---"
while read -r LINE; do
  PCT=\$(echo "\$LINE" | awk '{gsub(/%/,""); print \$6+0}' 2>/dev/null)
  MNT=\$(echo "\$LINE" | awk '{print \$7}')
  [ -z "\$MNT" ] || [ "\$MNT" = "Mounted" ] && continue
  if [ "\${PCT:-0}" -ge 90 ]; then
    check "Disk \$MNT" "CRITICAL — \${PCT}% used"
  elif [ "\${PCT:-0}" -ge 80 ]; then
    check "Disk \$MNT" "WARNING — \${PCT}% used (risky)"
  else
    check "Disk \$MNT" "OK"
  fi
done < <(df -hT 2>/dev/null | tail -n +2)

echo ""
echo "--- Inode availability ---"
while read -r LINE; do
  PCT=\$(echo "\$LINE" | awk '{gsub(/%/,""); print \$5+0}' 2>/dev/null)
  MNT=\$(echo "\$LINE" | awk '{print \$6}')
  [ -z "\$MNT" ] || [ "\$MNT" = "Mounted" ] && continue
  [ "\${PCT:-0}" -ge 80 ] && \
    check "Inodes \$MNT" "WARNING — \${PCT}% used" || \
    check "Inodes \$MNT" "OK"
done < <(df -i \$APPL_TOP /tmp 2>/dev/null | tail -n +2)

echo ""
echo "--- NFS mount health ---"
for MNT in \$(mount | grep nfs | awk '{print \$3}'); do
  timeout 8 ls "\$MNT" > /dev/null 2>&1
  [ \$? -eq 0 ] && check "NFS \$MNT" "OK" || check "NFS \$MNT" "STALE — remount before patching"
done

echo ""
echo "--- /tmp space for patch extraction ---"
TMP_FREE=\$(df /tmp | tail -1 | awk '{print int(\$4/1024)}')
[ "\$TMP_FREE" -ge 2048 ] && check "/tmp free space (\${TMP_FREE}MB)" "OK" || \
  check "/tmp free space (\${TMP_FREE}MB)" "< 2GB — patch extraction may fail"

echo ""
echo "========================================"
echo " Results: \$PASS passed, \$FAIL failed"
[ "\$FAIL" -gt 0 ] && echo " STATUS: NOT SAFE — fix failures before starting adpatch" && exit 1
echo " STATUS: SAFE TO PROCEED"
echo "========================================"
exit 0
\`\`\`

\`\`\`bash
chmod +x /u01/scripts/ebs_prepatch_fs_check.sh /u01/scripts/ebs_fs_analysis.sh

# Run pre-patch check (must exit 0 before starting adpatch or adop)
source /u01/oracle/EBS/EBSapps.env run
/u01/scripts/ebs_prepatch_fs_check.sh

# Run analysis when a session is already stalled
/u01/scripts/ebs_fs_analysis.sh "\$APPS_PASSWORD" "\$TWO_TASK"
\`\`\`

---

## Common Mistakes

| Mistake | Consequence |
|---|---|
| Removing the current patch's staging directory to free space | Patch files gone — must re-download and re-extract the full patch |
| Running \`adop phase=abort\` before trying \`restart=yes\` | All patch progress lost; patch must be re-applied from scratch |
| Force-unmounting an NFS filesystem while adpatch workers are mid-write | Partial files on disk; workers exit with I/O errors; additional cleanup needed |
| Ignoring inode exhaustion (disk shows free but writes fail) | Patch copy phase fails silently until worker logs reveal ENOSPC errors |
| Remounting NFS without re-sourcing the EBS environment | Symlinks and environment variables pointing to stale paths; worker launches fail |
| Freeing space by removing adwork*.log files from the current session | adpatch loses recovery information needed for adctrl restart operations |
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'EBS Patching Filesystem Failures — Operations Runbook',
    slug,
    excerpt: 'Operations runbook for recovering EBS patch sessions stalled by filesystem problems — disk full, NFS stale file handles, and adop INCOMPLETE sessions. Phase-by-phase triage, safe space recovery procedures, NFS remount steps, adop restart vs abort decision, an automated filesystem analysis script, and a pre-patch capacity validation script.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
