import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-forms-frm40735-ora01001-runbook';

const content = `
## Purpose

Structured response for Oracle EBS Forms sessions crashing with \`FRM-40735: ON-ERROR trigger raised unhandled exception ORA-01001\`. This error indicates an invalid cursor state caused by external termination of the \`frmweb\` process — not by application code.

---

## Phase 1 — Fast Triage (5 minutes)

Run these checks immediately when users report FRM-40735 crashes.

### 1. Confirm FORMS_CATCHTERM is enabled

\`\`\`bash
# Application server — source EBS environment first
source /u01/oracle/EBS/EBSapps.env run

grep FORMS_CATCHTERM \$INST_TOP/ora/10.1.2/forms/server/default.env
\`\`\`

- Returns \`FORMS_CATCHTERM=1\` → trace files will be written on crash
- Returns \`FORMS_CATCHTERM=0\` or absent → **enable it now** (see Phase 3A)

### 2. Check for recent crash trace files

\`\`\`bash
TRACE_DIR=\$(grep FORMS_TRACE_DIR \$INST_TOP/ora/10.1.2/forms/server/default.env 2>/dev/null | cut -d= -f2)
TRACE_DIR=\${TRACE_DIR:-\$ORACLE_HOME/forms/trace}

echo "Trace directory: \$TRACE_DIR"
ls -lhrt "\$TRACE_DIR"/*.trc 2>/dev/null | tail -10
\`\`\`

### 3. Check active frmweb processes and their age

\`\`\`bash
# List all frmweb processes with start time and CPU time
ps -eo pid,ppid,user,etime,pcpu,pmem,comm --sort=-etime | grep frmweb | head -20

# Count frmweb processes
echo "Active frmweb count: \$(pgrep -c frmweb 2>/dev/null || echo 0)"
\`\`\`

### 4. Check database IDLE_TIME profile for APPS user

\`\`\`sql
-- Run in SYSDBA or DBA-privileged session
SELECT u.username, u.profile,
       p.resource_name, p.limit
FROM   dba_users u
JOIN   dba_profiles p ON p.profile = u.profile
WHERE  u.username = 'APPS'
  AND  p.resource_name IN ('IDLE_TIME', 'CONNECT_TIME', 'SESSIONS_PER_USER');
\`\`\`

An \`IDLE_TIME\` value less than 30 minutes is a likely contributor to intermittent session kills.

---

## Phase 2 — Detailed Diagnosis

### Correlate crash time with trace files

\`\`\`bash
TRACE_DIR=\$(grep FORMS_TRACE_DIR \$INST_TOP/ora/10.1.2/forms/server/default.env 2>/dev/null | cut -d= -f2)
TRACE_DIR=\${TRACE_DIR:-\$ORACLE_HOME/forms/trace}

# Show trace files modified in the last 2 hours with timestamps
find "\$TRACE_DIR" -name "*.trc" -mmin -120 -exec ls -lh {} \\; | sort -k6,7

# Read the most recent crash trace
LATEST=\$(ls -t "\$TRACE_DIR"/*.trc 2>/dev/null | head -1)
if [ -n "\$LATEST" ]; then
  echo "=== Latest trace: \$LATEST ==="
  cat "\$LATEST"
else
  echo "No .trc files found. Confirm FORMS_CATCHTERM=1 is set and a crash has occurred since."
fi
\`\`\`

### Decode the signal in the trace

\`\`\`bash
# Extract signal information from all recent traces
for TRC in \$(ls -t "\$TRACE_DIR"/*.trc 2>/dev/null | head -5); do
  echo "--- \$(basename \$TRC) ---"
  grep -iE 'signal|ORA-0|terminate|killed|timeout|idle' "\$TRC" | head -10
  echo ""
done
\`\`\`

| Signal / ORA in trace | Root cause |
|---|---|
| \`signal 9 (SIGKILL)\` | OS kill script or OOM killer |
| \`signal 15 (SIGTERM)\` | Graceful shutdown script or system reboot |
| \`ORA-02396\` | Database IDLE_TIME profile enforced |
| \`ORA-03113\` | TCP connection dropped by network device |
| \`ORA-03135\` | Connection lost — SQL*Net keepalive expired |
| No signal, clean exit | Session-kill script ended process before Forms could write signal |

### Audit crontabs for session-kill scripts

\`\`\`bash
# Check all system crontabs on the application server
echo "=== applmgr crontab ==="
crontab -u applmgr -l 2>/dev/null || crontab -l 2>/dev/null

echo "=== oracle user crontab ==="
sudo crontab -u oracle -l 2>/dev/null

echo "=== root crontab ==="
sudo crontab -l 2>/dev/null

echo "=== /etc/cron.d ==="
ls -la /etc/cron.d/ 2>/dev/null
for F in /etc/cron.d/*; do
  echo "--- \$F ---"
  cat "\$F" 2>/dev/null
done

# Search for scripts that reference frmweb, kill, or idle
grep -rl 'frmweb\|kill\|idle' /etc/cron.d/ \$HOME/cron* 2>/dev/null
\`\`\`

### Check sqlnet.ora keepalive configuration

\`\`\`bash
# Application server
echo "=== Application server sqlnet.ora ==="
cat \$TNS_ADMIN/sqlnet.ora 2>/dev/null | grep -iE 'expire_time|timeout|keepalive|recv_buf|send_buf'

# Database server (if accessible)
echo "=== Database server sqlnet.ora ==="
ssh oracle@ebsdb01.corp.example.com "cat \\\$ORACLE_HOME/network/admin/sqlnet.ora | grep -iE 'expire_time|timeout|keepalive'" 2>/dev/null || \
  echo "(run manually on DB server)"
\`\`\`

### Verify active database sessions for APPS

\`\`\`sql
-- Identify long-running APPS sessions and their idle time
SELECT s.sid,
       s.serial#,
       s.username,
       s.program,
       s.status,
       s.last_call_et AS idle_seconds,
       ROUND(s.last_call_et / 60, 1) AS idle_minutes,
       s.machine,
       s.logon_time
FROM   v\$session s
WHERE  s.username = 'APPS'
  AND  s.program LIKE '%frmweb%'
ORDER  BY s.last_call_et DESC;
\`\`\`

---

## Phase 3 — Fixes

### 3A — Enable FORMS_CATCHTERM (if not already set)

\`\`\`bash
# Back up default.env before editing
cp \$INST_TOP/ora/10.1.2/forms/server/default.env \
   \$INST_TOP/ora/10.1.2/forms/server/default.env.bak.\$(date +%Y%m%d)

# Check current setting
grep FORMS_CATCHTERM \$INST_TOP/ora/10.1.2/forms/server/default.env

# If not present or set to 0:
# Edit and set to 1
# Use your preferred editor — vi example:
vi \$INST_TOP/ora/10.1.2/forms/server/default.env
# Find line: FORMS_CATCHTERM=0
# Change to: FORMS_CATCHTERM=1
# Save and exit

# Verify the change
grep FORMS_CATCHTERM \$INST_TOP/ora/10.1.2/forms/server/default.env
\`\`\`

New Forms sessions pick up this change immediately. No middle-tier bounce required.

### 3B — Fix: Disable or reschedule session-kill scripts

\`\`\`bash
# Comment out the kill-script cron entry (do not delete — you may need to restore it)
crontab -e
# Add # before the offending cron line

# Example: change this:
#   0 */2 * * * /u01/scripts/cleanup_idle_sessions.sh
# To this:
#   # DISABLED 2026-07-07 - investigating FRM-40735
#   # 0 */2 * * * /u01/scripts/cleanup_idle_sessions.sh

# Verify no kill scripts are running
ps aux | grep -iE 'cleanup|kill.*session|idle.*frmweb' | grep -v grep
\`\`\`

If the cleanup script must remain active, modify it to skip frmweb processes that have active child connections:

\`\`\`bash
#!/bin/bash
# Safer frmweb cleanup — skip processes with active sub-form children
IDLE_THRESHOLD_MINUTES=90

for PID in \$(pgrep -x frmweb 2>/dev/null); do
  CHILDREN=\$(pgrep -P "\$PID" 2>/dev/null | wc -l)
  ELAPSED_SECONDS=\$(ps -p "\$PID" -o etimes= 2>/dev/null | tr -d ' ')
  ELAPSED_MIN=\$(( ELAPSED_SECONDS / 60 ))

  if [ "\$CHILDREN" -gt 0 ]; then
    echo "SKIP: PID \$PID has \$CHILDREN child processes — session may be active"
    continue
  fi

  if [ "\$ELAPSED_MIN" -gt "\$IDLE_THRESHOLD_MINUTES" ]; then
    echo "TERMINATE: PID \$PID (elapsed \${ELAPSED_MIN}m, no children)"
    kill -15 "\$PID"
  fi
done
\`\`\`

### 3C — Fix: Set IDLE_TIME=UNLIMITED on APPS user profile

\`\`\`sql
-- Run as SYSDBA

-- Option A: Modify the existing profile (if it is used only by APPS and APPLSYS)
ALTER PROFILE <current_profile_name> LIMIT IDLE_TIME UNLIMITED;

-- Option B: Create a dedicated profile for the application tier (recommended)
CREATE PROFILE ebs_appsession_profile LIMIT
  IDLE_TIME            UNLIMITED
  CONNECT_TIME         UNLIMITED
  SESSIONS_PER_USER    DEFAULT
  FAILED_LOGIN_ATTEMPTS 10
  PASSWORD_LIFE_TIME   UNLIMITED;

ALTER USER apps    PROFILE ebs_appsession_profile;
ALTER USER applsys PROFILE ebs_appsession_profile;

-- Verify
SELECT u.username, u.profile, p.resource_name, p.limit
FROM   dba_users u
JOIN   dba_profiles p ON p.profile = u.profile
WHERE  u.username IN ('APPS', 'APPLSYS')
  AND  p.resource_name = 'IDLE_TIME';
\`\`\`

### 3D — Fix: Add SQL*Net keepalive probe

\`\`\`bash
# Application server
SQLNET_FILE=\$TNS_ADMIN/sqlnet.ora

# Back up first
cp "\$SQLNET_FILE" "\$SQLNET_FILE.bak.\$(date +%Y%m%d)"

# Add SQLNET.EXPIRE_TIME if not present
if ! grep -qi 'SQLNET.EXPIRE_TIME' "\$SQLNET_FILE"; then
  echo "" >> "\$SQLNET_FILE"
  echo "# Send TCP keepalive probes every 10 minutes to prevent silent connection drops" >> "\$SQLNET_FILE"
  echo "SQLNET.EXPIRE_TIME = 10" >> "\$SQLNET_FILE"
  echo "Added SQLNET.EXPIRE_TIME = 10 to \$SQLNET_FILE"
else
  echo "SQLNET.EXPIRE_TIME is already configured:"
  grep -i 'SQLNET.EXPIRE_TIME' "\$SQLNET_FILE"
fi

# Verify
grep -i 'SQLNET.EXPIRE_TIME' "\$SQLNET_FILE"
\`\`\`

Repeat on the database server's \`\$ORACLE_HOME/network/admin/sqlnet.ora\`. Takes effect on the next new connection.

### 3E — Fix: Set Forms session idle timeout

\`\`\`bash
# In default.env — set Forms timeout below the network/DB idle limit
# If IDLE_TIME is 30 min on the DB, set Forms to 25 min = 1500 seconds

vi \$INST_TOP/ora/10.1.2/forms/server/default.env
# Add or modify:
# FORMS_TIMEOUT=1500

# Verify
grep FORMS_TIMEOUT \$INST_TOP/ora/10.1.2/forms/server/default.env
\`\`\`

With \`FORMS_TIMEOUT=1500\`, the Forms runtime presents users with a clean timeout message at 25 minutes of idle instead of crashing with FRM-40735 when the infrastructure kills the connection at 30 minutes.

---

## Phase 4 — Post-Fix Verification

\`\`\`bash
# 1. Confirm FORMS_CATCHTERM and FORMS_TIMEOUT are set
grep -E 'FORMS_CATCHTERM|FORMS_TIMEOUT|FORMS_TRACE_DIR' \
  \$INST_TOP/ora/10.1.2/forms/server/default.env

# 2. Confirm SQLNET.EXPIRE_TIME is set
grep -i 'SQLNET.EXPIRE_TIME' \$TNS_ADMIN/sqlnet.ora

# 3. Monitor trace directory for 48 hours — new .trc files should show clean exits
TRACE_DIR=\$(grep FORMS_TRACE_DIR \$INST_TOP/ora/10.1.2/forms/server/default.env 2>/dev/null | cut -d= -f2)
TRACE_DIR=\${TRACE_DIR:-\$ORACLE_HOME/forms/trace}
watch -n 60 "ls -lhrt \$TRACE_DIR/*.trc 2>/dev/null | tail -10"
\`\`\`

\`\`\`sql
-- 4. Confirm APPS user IDLE_TIME after profile change
SELECT u.username, u.profile, p.resource_name, p.limit
FROM   dba_users u
JOIN   dba_profiles p ON p.profile = u.profile
WHERE  u.username = 'APPS'
  AND  p.resource_name = 'IDLE_TIME';
\`\`\`

---

## Monitoring Script

Save to \`/u01/scripts/ebs_forms_monitor.sh\`. Runs on the application server as the applmgr OS user with the EBS environment sourced.

\`\`\`bash
#!/bin/bash
# ebs_forms_monitor.sh
# Monitors for new EBS Forms crash trace files and alerts on ORA errors.
# Designed for cron scheduling — exits 0 if clean, 1 if issues found.

set -euo pipefail

# --- Configuration ---
ALERT_EMAIL="dba-alerts@corp.example.com"
LOG_FILE="/u01/logs/forms_monitor/forms_monitor_\$(date +%Y%m%d).log"
STATE_FILE="/u01/logs/forms_monitor/.last_check_ts"
IDLE_THRESHOLD_MIN=60          # alert if frmweb process is older than N minutes
MIN_FRMWEB_COUNT=0             # alert if fewer than N frmweb processes (0 = disabled)

mkdir -p "$(dirname \$LOG_FILE)"
mkdir -p "$(dirname \$STATE_FILE)"

log() { echo "\$(date '+%Y-%m-%d %H:%M:%S') \$1" | tee -a "\$LOG_FILE"; }
alert() {
  local SUBJECT="\$1"
  local BODY="\$2"
  log "ALERT: \$SUBJECT"
  echo "\$BODY" | mail -s "[EBS Forms Alert] \$SUBJECT" "\$ALERT_EMAIL" 2>/dev/null || true
}

# --- 0. Environment ---
if [ -z "\${APPL_TOP:-}" ]; then
  log "ERROR: EBS environment not sourced"
  exit 1
fi

TRACE_DIR=\$(grep FORMS_TRACE_DIR "\$INST_TOP/ora/10.1.2/forms/server/default.env" 2>/dev/null | cut -d= -f2)
TRACE_DIR=\${TRACE_DIR:-\$ORACLE_HOME/forms/trace}

ISSUES=0
REPORT=""

# --- 1. FORMS_CATCHTERM check ---
CATCHTERM=\$(grep FORMS_CATCHTERM "\$INST_TOP/ora/10.1.2/forms/server/default.env" 2>/dev/null | cut -d= -f2)
if [ "\${CATCHTERM:-0}" != "1" ]; then
  MSG="FORMS_CATCHTERM is not set to 1 — crash traces will not be written"
  log "WARNING: \$MSG"
  REPORT="\${REPORT}\\n[WARNING] \$MSG"
  ISSUES=\$((ISSUES + 1))
fi

# --- 2. New crash trace files since last check ---
LAST_TS=\$(cat "\$STATE_FILE" 2>/dev/null || echo "1970-01-01 00:00:00")
NEW_TRACES=\$(find "\$TRACE_DIR" -name "*.trc" -newer "\$STATE_FILE" 2>/dev/null)

if [ -n "\$NEW_TRACES" ]; then
  TRACE_COUNT=\$(echo "\$NEW_TRACES" | wc -l)
  log "Found \$TRACE_COUNT new crash trace(s) since \$LAST_TS"

  TRACE_SUMMARY=""
  for TRC in \$NEW_TRACES; do
    SIGNAL_LINE=\$(grep -iE 'signal|ORA-0[0-9]+|terminate|killed|timeout' "\$TRC" 2>/dev/null | head -3)
    TRACE_SUMMARY="\${TRACE_SUMMARY}\\n  \$(basename \$TRC):\\n    \$SIGNAL_LINE"
    log "  Trace: \$(basename \$TRC) — \$(echo "\$SIGNAL_LINE" | head -1)"
  done

  alert "FRM-40735 crash traces detected (\$TRACE_COUNT files)" \
    "New Forms crash traces found since last check (\$LAST_TS).\\n\\nHost: \$(hostname)\\nTrace dir: \$TRACE_DIR\\n\$TRACE_SUMMARY\\n\\nInvestigate: cat <trace_file> for signal source"
  ISSUES=\$((ISSUES + TRACE_COUNT))
fi

# Update state file timestamp
touch "\$STATE_FILE"

# --- 3. frmweb process count ---
FRMWEB_COUNT=\$(pgrep -c frmweb 2>/dev/null || echo 0)
log "Active frmweb processes: \$FRMWEB_COUNT"

if [ "\$MIN_FRMWEB_COUNT" -gt 0 ] && [ "\$FRMWEB_COUNT" -lt "\$MIN_FRMWEB_COUNT" ]; then
  MSG="Low frmweb count: \$FRMWEB_COUNT (threshold: \$MIN_FRMWEB_COUNT)"
  log "WARNING: \$MSG"
  REPORT="\${REPORT}\\n[WARNING] \$MSG"
  ISSUES=\$((ISSUES + 1))
fi

# --- 4. Long-lived frmweb processes (potential zombie/stuck sessions) ---
STUCK_PROCS=""
while IFS= read -r LINE; do
  PID=\$(echo "\$LINE" | awk '{print \$1}')
  ETIME=\$(echo "\$LINE" | awk '{print \$2}')
  # Convert etime (hh:mm or dd-hh:mm:ss) to minutes
  if echo "\$ETIME" | grep -q '-'; then
    DAYS=\$(echo "\$ETIME" | cut -d- -f1)
    HOURS=\$(echo "\$ETIME" | cut -d- -f2 | cut -d: -f1)
    MINS=\$((DAYS * 1440 + HOURS * 60))
  else
    HOURS=\$(echo "\$ETIME" | cut -d: -f1)
    MINS_PART=\$(echo "\$ETIME" | cut -d: -f2)
    MINS=\$((10#\$HOURS * 60 + 10#\$MINS_PART))
  fi
  if [ "\$MINS" -gt "\$IDLE_THRESHOLD_MIN" ]; then
    STUCK_PROCS="\${STUCK_PROCS}\\n  PID \$PID — running for \${MINS} minutes"
  fi
done < <(ps -eo pid,etime,comm --no-headers | grep frmweb)

if [ -n "\$STUCK_PROCS" ]; then
  MSG="Long-running frmweb processes (>\${IDLE_THRESHOLD_MIN}m):\$STUCK_PROCS"
  log "INFO: \$MSG"
  REPORT="\${REPORT}\\n[INFO] \$MSG"
fi

# --- 5. sqlnet.ora keepalive check ---
if ! grep -qi 'SQLNET.EXPIRE_TIME' "\$TNS_ADMIN/sqlnet.ora" 2>/dev/null; then
  MSG="SQLNET.EXPIRE_TIME is not configured in \$TNS_ADMIN/sqlnet.ora — TCP keepalive probes disabled"
  log "WARNING: \$MSG"
  REPORT="\${REPORT}\\n[WARNING] \$MSG"
  ISSUES=\$((ISSUES + 1))
fi

# --- Final summary ---
if [ "\$ISSUES" -gt 0 ]; then
  log "Check complete — \$ISSUES issue(s) found"
  exit 1
else
  log "Check complete — no issues"
  exit 0
fi
\`\`\`

---

## Scheduling Instructions

### Setup

\`\`\`bash
# 1. Create log and state directories
mkdir -p /u01/logs/forms_monitor
chown applmgr:oinstall /u01/logs/forms_monitor

# 2. Copy the script
cp ebs_forms_monitor.sh /u01/scripts/ebs_forms_monitor.sh
chmod 750 /u01/scripts/ebs_forms_monitor.sh
chown applmgr:oinstall /u01/scripts/ebs_forms_monitor.sh

# 3. Create an EBS environment wrapper (required because cron does not source .profile)
cat > /u01/scripts/ebs_forms_monitor_wrapper.sh << 'WRAPPER'
#!/bin/bash
# Wrapper that sources the EBS environment before running the monitor script
source /u01/oracle/EBS/EBSapps.env run > /dev/null 2>&1
exec /u01/scripts/ebs_forms_monitor.sh
WRAPPER

chmod 750 /u01/scripts/ebs_forms_monitor_wrapper.sh
chown applmgr:oinstall /u01/scripts/ebs_forms_monitor_wrapper.sh
\`\`\`

### Add to crontab (as applmgr user)

\`\`\`bash
crontab -e
\`\`\`

Add these lines:

\`\`\`cron
# EBS Forms crash trace monitor — runs every 15 minutes
*/15 * * * * /u01/scripts/ebs_forms_monitor_wrapper.sh >> /u01/logs/forms_monitor/cron.log 2>&1

# Daily log rotation — remove logs older than 30 days
0 2 * * * find /u01/logs/forms_monitor -name "forms_monitor_*.log" -mtime +30 -delete
\`\`\`

### Verify cron is running

\`\`\`bash
# View the crontab to confirm
crontab -l

# Manually run the wrapper to test before the first scheduled execution
/u01/scripts/ebs_forms_monitor_wrapper.sh
echo "Exit code: \$?"

# Check the log after first run
cat /u01/logs/forms_monitor/forms_monitor_\$(date +%Y%m%d).log
\`\`\`

### Email alert configuration

The script uses the \`mail\` command. If your application server does not have a mail transfer agent configured, replace the \`alert()\` function body with a curl-based notification or write to a shared alert log instead:

\`\`\`bash
# Alternative: write alerts to a shared file monitored by your central SIEM
alert() {
  local SUBJECT="\$1"
  local BODY="\$2"
  echo "\$(date '+%Y-%m-%d %H:%M:%S') [ALERT] \$SUBJECT: \$BODY" >> /u01/logs/forms_monitor/alerts.log
}
\`\`\`

---

## Quick Reference

| Symptom | Check | Fix |
|---|---|---|
| FRM-40735 + ORA-01001, no trace files | FORMS_CATCHTERM not set | Set FORMS_CATCHTERM=1 in default.env |
| Trace shows signal 9 | OS kill script killing frmweb | Audit crontab, modify kill script to check children |
| Trace shows ORA-02396 | IDLE_TIME profile too low | Set IDLE_TIME=UNLIMITED on APPS user profile |
| Trace shows ORA-03113 / ORA-03135 | TCP connection dropped | Add SQLNET.EXPIRE_TIME=10 to sqlnet.ora |
| Error occurs at exactly N minutes | FORMS_TIMEOUT too low or network timeout | Set FORMS_TIMEOUT below network idle limit |
| Error only during peak hours | frmweb overloaded — high CPU/memory | Check Forms server capacity, add middleware nodes |

---

## Key File Locations

| File | Path |
|---|---|
| default.env | \`\$INST_TOP/ora/10.1.2/forms/server/default.env\` |
| sqlnet.ora (app server) | \`\$TNS_ADMIN/sqlnet.ora\` |
| Forms trace directory | Value of FORMS_TRACE_DIR in default.env |
| Forms services log | \`\$INST_TOP/logs/ora/10.1.2/forms/\` |
| Apache / OHS access log | \`\$INST_TOP/logs/ora/10.1.2/Apache/\` |
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'EBS Forms FRM-40735 / ORA-01001: Runbook',
    slug,
    excerpt: 'Structured response runbook for Oracle EBS Forms FRM-40735 / ORA-01001 (invalid cursor) crashes. Covers fast triage, trace file collection and decode, fixes for OS kill scripts, IDLE_TIME profile restrictions and TCP keepalive gaps, monitoring script with cron scheduling instructions, and post-fix verification queries.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
