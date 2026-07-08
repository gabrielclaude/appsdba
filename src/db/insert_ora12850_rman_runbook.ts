import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ora-12850-rman-catalog-resync-runbook';

const content = `
## Purpose

Diagnose and resolve ORA-12850 failures during RMAN implicit recovery catalog resynchronisation in RAC environments after an Oracle Data Guard switchover. The error occurs before any backup data is written — RMAN fails in its pre-backup GV$ metadata phase. This runbook covers triage, root cause identification, permanent fixes, and an immediate workaround to keep scheduled backups running.

---

## Phase 1 — Confirm the Error Pattern (2 minutes)

Verify the failure is in the resync phase, not in the backup itself.

\`\`\`bash
# Check the RMAN log for the failure sequence
grep -E 'RMAN-03014|RMAN-03009|ORA-12850|resync|catalog' /u01/oracle/rman/logs/rman_backup_latest.log | head -20
\`\`\`

Expected pattern confirming a resync failure:
\`\`\`
RMAN-03002: failure of backup command
RMAN-03014: implicit resync of recovery catalog failed
RMAN-03009: failure of full resync command on default channel
ORA-12850: Could not allocate slaves on all specified instances: needed, allocated
\`\`\`

If \`RMAN-03014\` appears before any \`RMAN-06056\` (channel not allocated) or data transfer errors, the resync phase failed — proceed with this runbook.

---

## Phase 2 — Fast Triage: Two Queries (5 minutes)

Connect to the target RAC database on the new primary cluster and run these two queries.

### Query 1 — Instance states

\`\`\`sql
SELECT inst_id,
       instance_name,
       host_name,
       status,
       database_status,
       active_state,
       TO_CHAR(startup_time, 'YYYY-MM-DD HH24:MI:SS') AS startup_time
FROM   gv\$instance
ORDER  BY inst_id;
\`\`\`

**Expected — all instances healthy:**
\`\`\`
INST_ID  INSTANCE_NAME  HOST_NAME             STATUS  DATABASE_STATUS  ACTIVE_STATE
-------  -------------  --------------------  ------  ---------------  ------------
1        EBSPROD1       ebsrac01.example.com  OPEN    ACTIVE           NORMAL
2        EBSPROD2       ebsrac02.example.com  OPEN    ACTIVE           NORMAL
\`\`\`

**Problem indicators:**
| Column value | Root cause |
|---|---|
| \`STATUS = MOUNTED\` on any node | Instance did not fully open after switchover |
| \`DATABASE_STATUS = SUSPENDED\` | Instance is in a transitional state |
| \`ACTIVE_STATE = QUIESCING\` or \`RESTRICTED\` | Instance restricted — parallel slaves blocked |
| \`DATABASE_ROLE = STANDBY\` in \`gv\$database\` | Switchover did not complete for this node |

If this query itself returns ORA-12850, the cluster cannot coordinate GV$ queries at all — skip to Phase 3A (cluster bounce) immediately.

### Query 2 — Parameter consistency

\`\`\`sql
SELECT inst_id,
       name,
       value
FROM   gv\$parameter
WHERE  name IN (
         'parallel_execution_message_size',
         'parallel_max_servers',
         'parallel_degree_policy'
       )
ORDER  BY name, inst_id;
\`\`\`

**Expected — values identical across all inst_id rows for each parameter.**

**Problem indicator:** Any parameter where the value differs between instances — especially \`parallel_execution_message_size\`. A mismatch here prevents cross-instance parallel channel establishment.

---

## Phase 3A — Permanent Fix: Coordinated Cluster Bounce

Use when: Query 1 shows any instance in a non-OPEN or non-ACTIVE state, or when the switchover left stale process state across nodes. This is the cleanest resolution.

\`\`\`bash
# Run as oracle OS user on any node in the new primary cluster

# 1. Confirm current cluster status before stopping
srvctl status database -d EBSPROD

# 2. Stop all instances cleanly
srvctl stop database -d EBSPROD -o immediate

# 3. Confirm all instances are stopped
srvctl status database -d EBSPROD
# Expected: Instance EBSPROD1 is not running on node ebsrac01
#           Instance EBSPROD2 is not running on node ebsrac02

# 4. Start the cluster uniformly
srvctl start database -d EBSPROD

# 5. Confirm all instances are OPEN
srvctl status database -d EBSPROD

# 6. Verify from SQL*Plus
sqlplus / as sysdba << 'EOF'
SELECT inst_id, instance_name, status, database_status, active_state
FROM   gv\$instance
ORDER  BY inst_id;

SELECT inst_id, db_unique_name, database_role, open_mode
FROM   gv\$database
ORDER  BY inst_id;
EOF
\`\`\`

After all instances confirm \`OPEN / ACTIVE / NORMAL\` and \`DATABASE_ROLE = PRIMARY\`, re-run the RMAN backup script without any workaround parameters.

---

## Phase 3B — Permanent Fix: Align PARALLEL_EXECUTION_MESSAGE_SIZE

Use when: Query 2 shows differing \`parallel_execution_message_size\` values across instances. Can be combined with a rolling restart to avoid full downtime.

\`\`\`sql
-- Connect to any instance as SYSDBA
-- Step 1: Record current SPFILE values for all SIDs
SELECT name, value, sid, ordinal
FROM   v\$spparameter
WHERE  name = 'parallel_execution_message_size';

-- Step 2: Set the parameter uniformly for ALL instances
-- Use SID='*' to ensure no instance-specific overrides remain
ALTER SYSTEM SET parallel_execution_message_size = 16384
  SCOPE = SPFILE SID = '*';

-- Step 3: Confirm the SPFILE change
SELECT name, value, sid
FROM   v\$spparameter
WHERE  name = 'parallel_execution_message_size';
-- All rows should show value=16384 with sid='*'
\`\`\`

Then perform a rolling restart to pick up the new value on each node without full cluster downtime:

\`\`\`bash
# Rolling restart — one node at a time
# Wait for each instance to return to OPEN before stopping the next

for INST in EBSPROD1 EBSPROD2; do
  echo "Stopping \$INST..."
  srvctl stop instance  -d EBSPROD -i "\$INST" -o immediate
  sleep 5
  echo "Starting \$INST..."
  srvctl start instance -d EBSPROD -i "\$INST"
  sleep 30
  echo "Status after restart:"
  srvctl status instance -d EBSPROD -i "\$INST"
  echo "---"
done

# Confirm all instances healthy after rolling restart
sqlplus / as sysdba << 'EOF'
SELECT inst_id, instance_name, status, database_status FROM gv\$instance ORDER BY inst_id;
SELECT inst_id, name, value FROM gv\$parameter
WHERE  name = 'parallel_execution_message_size' ORDER BY inst_id;
EOF
\`\`\`

---

## Phase 3C — Immediate Workaround: Bypass Cross-Instance Coordination

Use when: The cluster cannot be bounced immediately (production is live, maintenance window not available) but scheduled RMAN backups must continue running.

This workaround forces RMAN to resolve GV$ views from the local instance only, eliminating the need to spawn parallel slaves on remote nodes during the catalog resync.

**RMAN script with workaround:**

\`\`\`
RMAN> RUN {
  -- Constrain parallel degree policy so Oracle does not auto-allocate cross-instance slaves
  SQL "ALTER SESSION SET PARALLEL_DEGREE_POLICY = MANUAL";

  -- Direct all GV$ resolution to instance 1 only (no cross-node parallel coordination)
  SQL "ALTER SESSION SET INSTANCE = 1";

  -- Standard backup channels and strategy
  ALLOCATE CHANNEL ch1 DEVICE TYPE DISK FORMAT '/u01/backup/rman/%d_%T_%U.bkp';
  ALLOCATE CHANNEL ch2 DEVICE TYPE DISK FORMAT '/u01/backup/rman/%d_%T_%U.bkp';

  BACKUP DATABASE PLUS ARCHIVELOG DELETE INPUT;

  RELEASE CHANNEL ch1;
  RELEASE CHANNEL ch2;
}
\`\`\`

**If using a shell script wrapper:**

\`\`\`bash
rman target / catalog rman_catalog_user/password@RMANCAT << 'RMANEOF'
RUN {
  SQL "ALTER SESSION SET PARALLEL_DEGREE_POLICY = MANUAL";
  SQL "ALTER SESSION SET INSTANCE = 1";

  ALLOCATE CHANNEL ch1 DEVICE TYPE DISK FORMAT '/u01/backup/rman/%d_%T_%U.bkp';
  BACKUP DATABASE PLUS ARCHIVELOG DELETE INPUT;
  RELEASE CHANNEL ch1;
}
EXIT;
RMANEOF
\`\`\`

**Important — change \`INSTANCE = 1\` if node 1 is the problem node:**

\`\`\`sql
-- Identify which instance is healthy and use that instance number
SELECT inst_id, instance_name, status FROM gv\$instance WHERE status = 'OPEN';
\`\`\`

Set \`INSTANCE\` to the \`inst_id\` of a node confirmed \`OPEN\` and \`ACTIVE\`.

---

## Phase 4 — Post-Fix Verification

After applying any permanent fix, confirm the catalog resync works before removing the workaround from scheduled scripts.

### Manual resync test

\`\`\`
rman target / catalog rman_catalog_user/password@RMANCAT

RESYNC CATALOG;
EXIT;
\`\`\`

A clean resync with no ORA-12850 confirms the cluster coordination is functional.

### Full backup without workaround

\`\`\`
rman target / catalog rman_catalog_user/password@RMANCAT << 'EOF'
RUN {
  ALLOCATE CHANNEL ch1 DEVICE TYPE DISK FORMAT '/u01/backup/rman/%d_%T_%U.bkp';
  BACKUP DATABASE PLUS ARCHIVELOG DELETE INPUT;
  RELEASE CHANNEL ch1;
}
EOF
\`\`\`

If this completes without RMAN-03014 or ORA-12850, remove the \`ALTER SESSION\` workaround lines from the production RMAN script.

---

## Automated Diagnostic Script

Save to \`/u01/scripts/rman_cluster_health_check.sh\`. Run before any scheduled RMAN backup to detect conditions that will cause ORA-12850.

\`\`\`bash
#!/bin/bash
# rman_cluster_health_check.sh
# Pre-backup RAC cluster health check for RMAN resync readiness.
# Detects asymmetric instance states and PARALLEL_EXECUTION_MESSAGE_SIZE mismatches.
# Exit 0 = cluster ready. Exit 1 = issue detected, backup will likely fail.

set -euo pipefail

ALERT_EMAIL="dba-alerts@corp.example.com"
DB_NAME="EBSPROD"
LOG_DIR="/u01/logs/rman_health"
LOG_FILE="\$LOG_DIR/cluster_health_\$(date +%Y%m%d_%H%M%S).log"

mkdir -p "\$LOG_DIR"

log()   { echo "\$(date '+%Y-%m-%d %H:%M:%S') \$1" | tee -a "\$LOG_FILE"; }
alert() {
  local SUBJECT="\$1"; local BODY="\$2"
  log "ALERT: \$SUBJECT"
  echo "\$BODY" | mail -s "[RMAN Alert] \$SUBJECT" "\$ALERT_EMAIL" 2>/dev/null || true
}

log "=== RMAN Pre-Backup Cluster Health Check ==="
log "Database: \$DB_NAME  Host: \$(hostname)"

ISSUES=0
ISSUE_DETAIL=""

# ── 1. Check instance states via srvctl ────────────────────────────────────────
log ""
log "--- Instance states (srvctl) ---"
SRVCTL_OUT=\$(srvctl status database -d "\$DB_NAME" 2>&1)
echo "\$SRVCTL_OUT" | tee -a "\$LOG_FILE"

NOT_RUNNING=\$(echo "\$SRVCTL_OUT" | grep -c 'is not running' || true)
if [ "\$NOT_RUNNING" -gt 0 ]; then
  MSG="\$NOT_RUNNING instance(s) not running — GV\$ queries will fail"
  log "FAIL: \$MSG"
  ISSUE_DETAIL="\${ISSUE_DETAIL}\\n  ✗ \$MSG"
  ISSUES=\$((ISSUES+1))
else
  log "PASS: All instances reported running by srvctl"
fi

# ── 2. Check gv\$instance via sqlplus ──────────────────────────────────────────
log ""
log "--- GV\$INSTANCE states ---"
INST_CHECK=\$(sqlplus -s / as sysdba << 'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0
SELECT inst_id || '|' || instance_name || '|' || status || '|' || database_status || '|' || active_state
FROM   gv\$instance
ORDER  BY inst_id;
EXIT;
SQLEOF
)

if echo "\$INST_CHECK" | grep -qi 'ORA-12850\|ORA-00600\|ORA-'; then
  MSG="GV\$INSTANCE query itself failed — cluster cannot coordinate parallel queries"
  log "FAIL: \$MSG"
  log "      Output: \$INST_CHECK"
  ISSUE_DETAIL="\${ISSUE_DETAIL}\\n  ✗ \$MSG"
  ISSUES=\$((ISSUES+1))
else
  echo "\$INST_CHECK" | tee -a "\$LOG_FILE"
  PROBLEM_STATES=\$(echo "\$INST_CHECK" | grep -v '^$' | grep -v 'OPEN|ACTIVE|NORMAL' | wc -l || true)
  if [ "\$PROBLEM_STATES" -gt 0 ]; then
    MSG="\$PROBLEM_STATES instance(s) not in OPEN/ACTIVE/NORMAL state"
    log "FAIL: \$MSG"
    ISSUE_DETAIL="\${ISSUE_DETAIL}\\n  ✗ \$MSG"
    ISSUES=\$((ISSUES+1))
  else
    log "PASS: All instances OPEN / ACTIVE / NORMAL"
  fi
fi

# ── 3. Check PARALLEL_EXECUTION_MESSAGE_SIZE consistency ──────────────────────
log ""
log "--- PARALLEL_EXECUTION_MESSAGE_SIZE across all instances ---"
PARAM_CHECK=\$(sqlplus -s / as sysdba << 'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0
SELECT inst_id || '|' || value
FROM   gv\$parameter
WHERE  name = 'parallel_execution_message_size'
ORDER  BY inst_id;
EXIT;
SQLEOF
)

echo "\$PARAM_CHECK" | tee -a "\$LOG_FILE"

UNIQUE_VALUES=\$(echo "\$PARAM_CHECK" | grep -v '^$' | awk -F'|' '{print \$2}' | sort -u | wc -l)
if [ "\$UNIQUE_VALUES" -gt 1 ]; then
  MSG="PARALLEL_EXECUTION_MESSAGE_SIZE differs across instances — parallel coordination will fail"
  log "FAIL: \$MSG"
  ISSUE_DETAIL="\${ISSUE_DETAIL}\\n  ✗ \$MSG"
  ISSUES=\$((ISSUES+1))
else
  log "PASS: PARALLEL_EXECUTION_MESSAGE_SIZE is consistent across all instances"
fi

# ── 4. Check Data Guard role ──────────────────────────────────────────────────
log ""
log "--- Data Guard roles ---"
ROLE_CHECK=\$(sqlplus -s / as sysdba << 'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0
SELECT inst_id || '|' || database_role || '|' || open_mode || '|' || switchover_status
FROM   gv\$database
ORDER  BY inst_id;
EXIT;
SQLEOF
)

echo "\$ROLE_CHECK" | tee -a "\$LOG_FILE"

NON_PRIMARY=\$(echo "\$ROLE_CHECK" | grep -v '^$' | grep -v 'PRIMARY' | wc -l || true)
if [ "\$NON_PRIMARY" -gt 0 ]; then
  MSG="\$NON_PRIMARY instance(s) not reporting PRIMARY role — switchover may be incomplete"
  log "FAIL: \$MSG"
  ISSUE_DETAIL="\${ISSUE_DETAIL}\\n  ✗ \$MSG"
  ISSUES=\$((ISSUES+1))
else
  log "PASS: All instances reporting PRIMARY role"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
log ""
log "=== Result: \$ISSUES issue(s) found ==="

if [ "\$ISSUES" -gt 0 ]; then
  log "Cluster is NOT ready for RMAN resync. Issues:\$ISSUE_DETAIL"
  log ""
  log "Options:"
  log "  1. Permanent fix: srvctl stop/start database -d \$DB_NAME"
  log "  2. Workaround:    Add 'SQL ALTER SESSION SET INSTANCE=1' to RMAN script"
  log "  3. Parameter fix: ALTER SYSTEM SET parallel_execution_message_size=16384 SCOPE=SPFILE SID='*'"

  alert "ORA-12850 risk: \$ISSUES cluster issue(s) on \$(hostname)" \
    "Pre-backup cluster health check detected \$ISSUES issue(s) on \$(hostname).\\n\\nDatabase: \$DB_NAME\\n\\nIssues:\$ISSUE_DETAIL\\n\\nLog: \$LOG_FILE"
  exit 1
fi

log "Cluster is ready for RMAN backup and catalog resync"
exit 0
\`\`\`

---

## Scheduling Instructions

### Setup

\`\`\`bash
cp rman_cluster_health_check.sh /u01/scripts/rman_cluster_health_check.sh
chmod 750 /u01/scripts/rman_cluster_health_check.sh
chown oracle:oinstall /u01/scripts/rman_cluster_health_check.sh

mkdir -p /u01/logs/rman_health
chown oracle:oinstall /u01/logs/rman_health

# Wrapper to source the Oracle environment for cron
cat > /u01/scripts/rman_cluster_health_check_wrapper.sh << 'WRAPPER'
#!/bin/bash
export ORACLE_SID=EBSPROD1
export ORACLE_HOME=/u01/oracle/product/19c/db
export PATH=\$ORACLE_HOME/bin:\$PATH
export LD_LIBRARY_PATH=\$ORACLE_HOME/lib
exec /u01/scripts/rman_cluster_health_check.sh
WRAPPER

chmod 750 /u01/scripts/rman_cluster_health_check_wrapper.sh
chown oracle:oinstall /u01/scripts/rman_cluster_health_check_wrapper.sh
\`\`\`

### Add to crontab (as oracle user)

\`\`\`bash
crontab -e
\`\`\`

\`\`\`cron
# Run cluster health check 30 minutes before the scheduled RMAN backup window
# Adjust timing to match your backup schedule

# If RMAN backup runs at 02:00 daily — check at 01:30
30 1 * * * /u01/scripts/rman_cluster_health_check_wrapper.sh >> /u01/logs/rman_health/cron.log 2>&1

# Also check at 06:00 for any post-switchover issues discovered in business hours
0 6 * * * /u01/scripts/rman_cluster_health_check_wrapper.sh >> /u01/logs/rman_health/cron.log 2>&1

# Log cleanup — 30-day retention
0 4 * * * find /u01/logs/rman_health -name "*.log" -mtime +30 -delete
\`\`\`

### Integrate the check into the RMAN backup script

\`\`\`bash
#!/bin/bash
# rman_backup.sh — with pre-flight cluster health check

export ORACLE_SID=EBSPROD1
export ORACLE_HOME=/u01/oracle/product/19c/db
export PATH=\$ORACLE_HOME/bin:\$PATH

LOG=/u01/logs/rman/rman_\$(date +%Y%m%d_%H%M%S).log

echo "=== Pre-flight: cluster health check ===" | tee "\$LOG"
/u01/scripts/rman_cluster_health_check.sh >> "\$LOG" 2>&1
HEALTH_RC=\$?

if [ "\$HEALTH_RC" -ne 0 ]; then
  echo "Cluster health check FAILED — see \$LOG" | tee -a "\$LOG"
  echo "Applying INSTANCE=1 workaround for this run..." | tee -a "\$LOG"
  WORKAROUND="SQL \"ALTER SESSION SET PARALLEL_DEGREE_POLICY = MANUAL\"; SQL \"ALTER SESSION SET INSTANCE = 1\";"
else
  echo "Cluster health check PASSED — running standard backup" | tee -a "\$LOG"
  WORKAROUND=""
fi

rman target / catalog rman_catalog_user/password@RMANCAT >> "\$LOG" 2>&1 << RMANEOF
RUN {
  \${WORKAROUND}
  ALLOCATE CHANNEL ch1 DEVICE TYPE DISK FORMAT '/u01/backup/rman/%d_%T_%U.bkp';
  ALLOCATE CHANNEL ch2 DEVICE TYPE DISK FORMAT '/u01/backup/rman/%d_%T_%U.bkp';
  BACKUP DATABASE PLUS ARCHIVELOG DELETE INPUT;
  RELEASE CHANNEL ch1;
  RELEASE CHANNEL ch2;
}
EXIT;
RMANEOF

RMAN_RC=\$?
echo "RMAN exit code: \$RMAN_RC" | tee -a "\$LOG"
exit \$RMAN_RC
\`\`\`

---

## Quick Reference

| Symptom | Root cause | Fix |
|---|---|---|
| ORA-12850 on RMAN-03014 only | Cluster state mismatch post-switchover | \`srvctl stop/start database\` |
| GV\$INSTANCE query itself returns ORA-12850 | Cluster interconnect coordination broken | Cluster bounce (Phase 3A) |
| PARALLEL_EXECUTION_MESSAGE_SIZE differs across nodes | SPFILE edit with SID= specific instance, or node started from old PFILE | \`ALTER SYSTEM SET … SID='*'\` + rolling restart (Phase 3B) |
| Any instance shows MOUNTED, not OPEN | Node did not fully open after switchover | Open the instance manually: \`srvctl start instance -d DB -i INST\` |
| DATABASE_ROLE shows STANDBY on one node | Switchover incomplete on that node | Complete the switchover on that node or bounce the cluster |
| Backup must run now — no maintenance window | Any of the above | RMAN workaround: \`ALTER SESSION SET INSTANCE=1\` (Phase 3C) |
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'ORA-12850 and RMAN Catalog Resync After Data Guard Switchover: Runbook',
    slug,
    excerpt: 'Runbook for diagnosing and resolving ORA-12850 during RMAN implicit catalog resync after a Data Guard switchover. Covers two-query fast triage (gv$instance states and PARALLEL_EXECUTION_MESSAGE_SIZE consistency), coordinated cluster bounce, SPFILE parameter alignment with rolling restart, immediate ALTER SESSION SET INSTANCE workaround for live systems, automated pre-backup health check script, and cron scheduling instructions.',
    content,
    category: 'disaster-recovery',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
