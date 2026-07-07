import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-adop-run-filesystem-sync-runbook';

const content = `
## Purpose

Detect, assess, and resolve out-of-sync state between the EBS 12.2 RUN and PATCH filesystem editions before \`adop phase=apply\`. Any change made to the RUN edition after \`adop phase=prepare\` runs will be absent from the PATCH edition and will disappear from the live system after cutover unless explicitly synchronised.

---

## Phase 1 — Identify Current Edition Layout

\`\`\`bash
# Source run environment
source /u01/oracle/EBS/EBSapps.env run

echo "Active RUN edition:"
echo "  APPL_TOP : \$APPL_TOP"
echo "  INST_TOP : \$INST_TOP"

# Determine which physical filesystem (fs1 or fs2) is RUN vs PATCH
if [[ "\$APPL_TOP" == *"/fs1/"* ]]; then
  RUN_FS="/u01/oracle/EBS/fs1/EBSapps"
  PATCH_FS="/u01/oracle/EBS/fs2/EBSapps"
  RUN_TAG="fs1"
  PATCH_TAG="fs2"
else
  RUN_FS="/u01/oracle/EBS/fs2/EBSapps"
  PATCH_FS="/u01/oracle/EBS/fs1/EBSapps"
  RUN_TAG="fs2"
  PATCH_TAG="fs1"
fi

echo ""
echo "RUN   edition : \$RUN_TAG  (\$RUN_FS)"
echo "PATCH edition : \$PATCH_TAG  (\$PATCH_FS)"
\`\`\`

### Confirm adop session is open (prepare has run)

\`\`\`sql
-- Check that a session is in RUNNING or INCOMPLETE state
-- prepare_status = C means fs_clone has completed
SELECT s.adop_session_id,
       s.status,
       s.prepare_status,
       s.apply_status,
       TO_CHAR(s.start_date, 'YYYY-MM-DD HH24:MI:SS') AS start_date
FROM   ad_adop_sessions s
WHERE  s.status IN ('RUNNING', 'INCOMPLETE')
ORDER  BY s.start_date DESC
FETCH  FIRST 3 ROWS ONLY;
\`\`\`

If no rows return, prepare has not run yet — there is nothing to sync.
If \`prepare_status = C\`, fs_clone ran and the gap window is open.

---

## Phase 2 — Detect Out-of-Sync Files

### Quick count

\`\`\`bash
source /u01/oracle/EBS/EBSapps.env run

if [[ "\$APPL_TOP" == *"/fs1/"* ]]; then
  RUN_FS="/u01/oracle/EBS/fs1/EBSapps"
  PATCH_FS="/u01/oracle/EBS/fs2/EBSapps"
else
  RUN_FS="/u01/oracle/EBS/fs2/EBSapps"
  PATCH_FS="/u01/oracle/EBS/fs1/EBSapps"
fi

echo "Counting files that differ between RUN and PATCH editions..."
DIFF_COUNT=\$(rsync --dry-run --checksum --delete --recursive \
  "\$RUN_FS/" "\$PATCH_FS/" 2>/dev/null \
  | grep -cE '^send |^del\.' || echo 0)

echo "Out-of-sync file count: \$DIFF_COUNT"
\`\`\`

- 0 → editions are in sync; proceed directly to \`adop phase=apply\`
- > 0 → review the detail report below before deciding whether to re-sync

### Detail report — what changed and where

\`\`\`bash
rsync --dry-run --checksum --delete --recursive \
  --out-format="%o %-60f %l bytes  %t" \
  "\$RUN_FS/" "\$PATCH_FS/" 2>/dev/null \
  | grep -E '^send|^del\.' \
  | sort -k2 \
  | tee /tmp/ebs_sync_diff_\$(date +%Y%m%d_%H%M).txt

echo ""
echo "Full report saved to /tmp/ebs_sync_diff_\$(date +%Y%m%d_%H%M).txt"
\`\`\`

### Classify the changes

\`\`\`bash
DIFF_FILE=\$(ls -t /tmp/ebs_sync_diff_*.txt 2>/dev/null | head -1)

echo "=== Files added or modified on RUN edition ==="
grep '^send' "\$DIFF_FILE" | awk '{print \$2}' | head -30

echo ""
echo "=== Files deleted from RUN edition (will be removed from PATCH on re-sync) ==="
grep '^del\.' "\$DIFF_FILE" | awk '{print \$2}' | head -30

echo ""
echo "=== Changes by product top ==="
grep '^send' "\$DIFF_FILE" | awk '{print \$2}' | cut -d/ -f1-3 | sort | uniq -c | sort -rn | head -20
\`\`\`

---

## Phase 3 — Re-synchronise

### Option A — Re-run fs_clone (recommended for any significant change)

\`\`\`bash
# Source PATCH environment — adop commands must run in patch context
source /u01/oracle/EBS/EBSapps.env patch

# Re-run fs_clone within the current adop session
# This resets the PATCH edition to an exact copy of the current RUN edition
adop phase=fs_clone

# Monitor progress in a second terminal
ADOPLOG=\$APPL_TOP/admin/adop_logs
tail -f "\$ADOPLOG"/\$(ls -t "\$ADOPLOG" | head -1)
\`\`\`

fs_clone uses \`--checksum\` mode — it only transfers files that have actually changed. On a system where only a few configuration files changed, the re-run will complete in minutes rather than the full 20–90 minutes of the initial clone.

After fs_clone completes:

\`\`\`bash
# Confirm editions are now in sync
source /u01/oracle/EBS/EBSapps.env run

if [[ "\$APPL_TOP" == *"/fs1/"* ]]; then
  RUN_FS="/u01/oracle/EBS/fs1/EBSapps"; PATCH_FS="/u01/oracle/EBS/fs2/EBSapps"
else
  RUN_FS="/u01/oracle/EBS/fs2/EBSapps"; PATCH_FS="/u01/oracle/EBS/fs1/EBSapps"
fi

REMAINING=\$(rsync --dry-run --checksum --delete --recursive "\$RUN_FS/" "\$PATCH_FS/" 2>/dev/null | grep -cE '^send |^del\.' || echo 0)
echo "Remaining out-of-sync files after fs_clone: \$REMAINING"
\`\`\`

### Option B — Manual copy of specific files

For a small number of known-changed files:

\`\`\`bash
source /u01/oracle/EBS/EBSapps.env run

# Determine PATCH INST_TOP and APPL_TOP
if [[ "\$APPL_TOP" == *"/fs1/"* ]]; then
  PATCH_APPL_TOP="/u01/oracle/EBS/fs2/EBSapps/appl"
  PATCH_INST_TOP="/u01/oracle/EBS/fs2/EBSapps/inst"
else
  PATCH_APPL_TOP="/u01/oracle/EBS/fs1/EBSapps/appl"
  PATCH_INST_TOP="/u01/oracle/EBS/fs1/EBSapps/inst"
fi

# Function to copy a RUN file to its PATCH equivalent
sync_file() {
  local SRC="\$1"
  local DEST=\$(echo "\$SRC" | sed "s|\$APPL_TOP|\$PATCH_APPL_TOP|; s|\$INST_TOP|\$PATCH_INST_TOP|")
  if [ "\$SRC" = "\$DEST" ]; then
    echo "ERROR: Could not determine PATCH path for: \$SRC"
    return 1
  fi
  mkdir -p "\$(dirname "\$DEST")"
  cp -p "\$SRC" "\$DEST"
  echo "Synced: \$SRC"
  echo "     → \$DEST"
}

# Example: sync specific changed files
sync_file "\$INST_TOP/ora/10.1.2/forms/server/default.env"
sync_file "\$TNS_ADMIN/sqlnet.ora"
sync_file "\$APPL_TOP/admin/scripts/ebs_session_monitor.sh"
\`\`\`

### Option B — Manual rsync of a specific product subtree

\`\`\`bash
source /u01/oracle/EBS/EBSapps.env run

if [[ "\$APPL_TOP" == *"/fs1/"* ]]; then
  PATCH_APPL_TOP="/u01/oracle/EBS/fs2/EBSapps/appl"
else
  PATCH_APPL_TOP="/u01/oracle/EBS/fs1/EBSapps/appl"
fi

# Sync only the custom top or a specific product directory
# Replace 'custom' with the product short name (fnd, inv, ont, etc.)
rsync --checksum --archive --delete \
  "\$APPL_TOP/custom/" "\$PATCH_APPL_TOP/custom/"
\`\`\`

---

## Phase 4 — Special Cases

### AutoConfig context file was changed

If \`\$CONTEXT_FILE\` or any \`\$FND_TOP/admin/template/\` file was edited on the RUN edition after prepare, AutoConfig must be re-run on the PATCH edition after fs_clone completes — not before. The adop \`finalize\` phase runs AutoConfig automatically, but if you need the PATCH edition to reflect RUN-edition context changes during apply, run it manually:

\`\`\`bash
source /u01/oracle/EBS/EBSapps.env patch

# Run AutoConfig on the PATCH edition application tier
\$INST_TOP/admin/scripts/adautocfg.sh
\`\`\`

### Symbolic links on the RUN edition

Symbolic links are copied by rsync with \`--archive\` mode (which fs_clone uses). Verify they transferred correctly:

\`\`\`bash
source /u01/oracle/EBS/EBSapps.env run

if [[ "\$APPL_TOP" == *"/fs1/"* ]]; then
  PATCH_APPL_TOP="/u01/oracle/EBS/fs2/EBSapps/appl"
else
  PATCH_APPL_TOP="/u01/oracle/EBS/fs1/EBSapps/appl"
fi

# List symbolic links in RUN APPL_TOP
echo "=== Symbolic links in RUN APPL_TOP ==="
find "\$APPL_TOP" -type l | head -20

# Verify each exists in PATCH
find "\$APPL_TOP" -type l | while read LINK; do
  PATCH_LINK=\$(echo "\$LINK" | sed "s|\$APPL_TOP|\$PATCH_APPL_TOP|")
  if [ -L "\$PATCH_LINK" ]; then
    echo "OK:      \$PATCH_LINK"
  else
    echo "MISSING: \$PATCH_LINK"
  fi
done
\`\`\`

### fs_ne (Non-Editioned) files

The \`fs_ne\` filesystem is shared between editions. Files here do not need synchronisation — both editions read from the same physical location. Do not run rsync against \`fs_ne\`.

\`\`\`bash
# Confirm fs_ne is mounted and accessible
ls -la /u01/oracle/EBS/fs_ne/EBSapps/ | head -10
df -hT /u01/oracle/EBS/fs_ne
\`\`\`

---

## Automated Sync Check and Alert Script

Save to \`/u01/scripts/ebs_adop_sync_check.sh\`. Run on the application server as the applmgr OS user with the EBS environment sourced.

\`\`\`bash
#!/bin/bash
# ebs_adop_sync_check.sh
# Checks whether the EBS 12.2 RUN and PATCH editions are in sync.
# If an open adop session exists and files have drifted, alerts and reports.
# Exit 0 = in sync or no open session. Exit 1 = drift detected.

set -euo pipefail

ALERT_EMAIL="dba-alerts@corp.example.com"
LOG_DIR="/u01/logs/adop_sync"
LOG_FILE="\$LOG_DIR/sync_check_\$(date +%Y%m%d).log"
DIFF_FILE="\$LOG_DIR/sync_diff_\$(date +%Y%m%d_%H%M%S).txt"
DRIFT_THRESHOLD=0          # alert on any drift (set higher to ignore trivial differences)

mkdir -p "\$LOG_DIR"

log()  { echo "\$(date '+%Y-%m-%d %H:%M:%S') \$1" | tee -a "\$LOG_FILE"; }
alert() {
  local SUBJECT="\$1"; local BODY="\$2"
  log "ALERT: \$SUBJECT"
  echo "\$BODY" | mail -s "[EBS adop Sync] \$SUBJECT" "\$ALERT_EMAIL" 2>/dev/null || true
}

# --- 0. Environment ---
if [ -z "\${APPL_TOP:-}" ]; then
  log "ERROR: EBS environment not sourced. Exiting."
  exit 1
fi

log "=== EBS adop Filesystem Sync Check ==="
log "Host:     \$(hostname)"
log "APPL_TOP: \$APPL_TOP"

# --- 1. Determine edition layout ---
if [[ "\$APPL_TOP" == *"/fs1/"* ]]; then
  RUN_FS="/u01/oracle/EBS/fs1/EBSapps"
  PATCH_FS="/u01/oracle/EBS/fs2/EBSapps"
  RUN_TAG="fs1"; PATCH_TAG="fs2"
else
  RUN_FS="/u01/oracle/EBS/fs2/EBSapps"
  PATCH_FS="/u01/oracle/EBS/fs1/EBSapps"
  RUN_TAG="fs2"; PATCH_TAG="fs1"
fi

log "RUN edition:   \$RUN_TAG (\$RUN_FS)"
log "PATCH edition: \$PATCH_TAG (\$PATCH_FS)"

# --- 2. Check for an open adop session via AD_ADOP_SESSIONS ---
# Use sqlplus with wallet or stored credentials — adjust for your authentication method
SESSION_OPEN=\$(sqlplus -s /nolog <<SQL 2>/dev/null | tr -d ' '
CONNECT apps/\$(cat /u01/secure/.apps_pass.txt 2>/dev/null)
SET HEADING OFF FEEDBACK OFF PAGESIZE 0
SELECT COUNT(*)
FROM   ad_adop_sessions
WHERE  status IN ('RUNNING', 'INCOMPLETE')
  AND  prepare_status = 'C';
EXIT
SQL
)

if [ "\${SESSION_OPEN:-0}" -eq 0 ]; then
  log "No open adop session with completed prepare. Nothing to check."
  exit 0
fi

log "Open adop session(s) with completed prepare detected: \$SESSION_OPEN session(s)"

# --- 3. Detect drift ---
log "Running rsync dry-run to detect drift..."
rsync --dry-run --checksum --delete --recursive \
  --out-format="%o %-70f %l bytes  %t" \
  "\$RUN_FS/" "\$PATCH_FS/" 2>/dev/null \
  | grep -E '^send |^del\.' > "\$DIFF_FILE" || true

DRIFT_COUNT=\$(wc -l < "\$DIFF_FILE")
log "Out-of-sync files: \$DRIFT_COUNT"

if [ "\$DRIFT_COUNT" -le "\$DRIFT_THRESHOLD" ]; then
  log "Editions are in sync (within threshold of \$DRIFT_THRESHOLD files)."
  rm -f "\$DIFF_FILE"
  exit 0
fi

# --- 4. Classify the drift ---
SENT_COUNT=\$(grep -c '^send' "\$DIFF_FILE" || echo 0)
DEL_COUNT=\$(grep -c '^del\.'  "\$DIFF_FILE" || echo 0)

log "  Files to send (RUN newer/added): \$SENT_COUNT"
log "  Files to delete (removed from RUN): \$DEL_COUNT"

# Top changed areas
TOP_AREAS=\$(grep '^send' "\$DIFF_FILE" | awk '{print \$2}' | cut -d/ -f1-3 | sort | uniq -c | sort -rn | head -10)
log "Top changed areas:"
echo "\$TOP_AREAS" | while read LINE; do log "  \$LINE"; done

# --- 5. Sample the diff for the alert body ---
SAMPLE=\$(head -20 "\$DIFF_FILE")

BODY="\$(cat <<ALERTBODY
EBS adop RUN→PATCH edition drift detected.

Host:          \$(hostname)
RUN edition:   \$RUN_TAG
PATCH edition: \$PATCH_TAG
Open sessions: \$SESSION_OPEN

Drift summary:
  Files to sync to PATCH (added/modified on RUN): \$SENT_COUNT
  Files to remove from PATCH (deleted from RUN):  \$DEL_COUNT

Top changed areas:
\$TOP_AREAS

First 20 changed files:
\$SAMPLE

Full diff: \$DIFF_FILE

Action required:
  source /u01/oracle/EBS/EBSapps.env patch
  adop phase=fs_clone
  adop phase=apply patches=<patch_id>
ALERTBODY
)"

alert "RUN→PATCH filesystem drift: \$DRIFT_COUNT files (\$RUN_TAG → \$PATCH_TAG)" "\$BODY"

exit 1
\`\`\`

Make the script executable:

\`\`\`bash
chmod 750 /u01/scripts/ebs_adop_sync_check.sh
chown applmgr:oinstall /u01/scripts/ebs_adop_sync_check.sh
\`\`\`

---

## Scheduling Instructions

### Environment wrapper

The cron daemon does not source the EBS environment. Create a wrapper:

\`\`\`bash
cat > /u01/scripts/ebs_adop_sync_check_wrapper.sh << 'WRAPPER'
#!/bin/bash
# Wrapper: sources EBS run environment then runs the sync check
source /u01/oracle/EBS/EBSapps.env run > /dev/null 2>&1
exec /u01/scripts/ebs_adop_sync_check.sh
WRAPPER

chmod 750 /u01/scripts/ebs_adop_sync_check_wrapper.sh
chown applmgr:oinstall /u01/scripts/ebs_adop_sync_check_wrapper.sh
\`\`\`

### Secure the database password file

\`\`\`bash
# The script reads the APPS password from a restricted file
mkdir -p /u01/secure
echo 'apps_password_here' > /u01/secure/.apps_pass.txt
chmod 600 /u01/secure/.apps_pass.txt
chown applmgr:oinstall /u01/secure/.apps_pass.txt
\`\`\`

### Add to crontab (as applmgr)

\`\`\`bash
crontab -e
\`\`\`

\`\`\`cron
# EBS adop sync check — runs every hour during business hours and at night during patching windows
# Alerts immediately if drift is detected while an adop session is open

# Business hours: every hour Mon–Fri 07:00–19:00
0 7-19 * * 1-5 /u01/scripts/ebs_adop_sync_check_wrapper.sh >> /u01/logs/adop_sync/cron.log 2>&1

# Off-hours: every 30 minutes during overnight patching windows
*/30 20-23 * * * /u01/scripts/ebs_adop_sync_check_wrapper.sh >> /u01/logs/adop_sync/cron.log 2>&1
*/30 0-6   * * * /u01/scripts/ebs_adop_sync_check_wrapper.sh >> /u01/logs/adop_sync/cron.log 2>&1

# Daily log cleanup — keep 14 days
0 3 * * * find /u01/logs/adop_sync -name "*.log" -mtime +14 -delete; find /u01/logs/adop_sync -name "sync_diff_*.txt" -mtime +14 -delete
\`\`\`

### Manual test before first scheduled run

\`\`\`bash
/u01/scripts/ebs_adop_sync_check_wrapper.sh
echo "Exit: \$?"

# View the log
tail -30 /u01/logs/adop_sync/sync_check_\$(date +%Y%m%d).log
\`\`\`

---

## Quick Reference

| Situation | Command |
|---|---|
| Check if editions are in sync | \`rsync --dry-run --checksum RUN/ PATCH/\` |
| Re-sync PATCH from RUN (full) | \`source EBSapps.env patch && adop phase=fs_clone\` |
| Copy one file to PATCH manually | \`cp -p \$RUN_FILE \$PATCH_FILE\` |
| Re-run AutoConfig on PATCH | \`source EBSapps.env patch && \$INST_TOP/admin/scripts/adautocfg.sh\` |
| Verify fs_ne is shared | \`df -hT /u01/oracle/EBS/fs_ne\` (do not rsync fs_ne) |
| Confirm editions after cutover | \`cat /u01/oracle/EBS/EBSapps.env \| grep APPL_TOP\` |

---

## Files at Highest Risk of Silent Loss at Cutover

| File | Path | Sync method |
|---|---|---|
| default.env | \`\$INST_TOP/ora/10.1.2/forms/server/default.env\` | Re-run fs_clone or manual copy |
| sqlnet.ora | \`\$TNS_ADMIN/sqlnet.ora\` | Re-run fs_clone or manual copy |
| tnsnames.ora | \`\$TNS_ADMIN/tnsnames.ora\` | Re-run fs_clone or manual copy |
| Custom scripts | \`\$APPL_TOP/admin/scripts/\` | Re-run fs_clone |
| Custom reports | \`\$APPL_TOP/custom/\` | Re-run fs_clone or rsync subtree |
| AutoConfig context | \`\$CONTEXT_FILE\` | fs_clone then adautocfg.sh on PATCH |
| Symbolic links | anywhere under \$APPL_TOP | fs_clone (rsync --archive preserves links) |
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'EBS 12.2 adop: Run Filesystem Synchronisation Runbook',
    slug,
    excerpt: 'Runbook for detecting and resolving out-of-sync state between EBS 12.2 RUN and PATCH filesystem editions before adop phase=apply. Covers edition layout identification, rsync dry-run drift detection, re-running fs_clone, manual file copy procedures, AutoConfig context file handling, symbolic link verification, an automated sync-check and alert script, and cron scheduling instructions.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
