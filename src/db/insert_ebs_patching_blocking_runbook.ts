import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-patching-workers-stuck-running-blocking-locks-runbook';

const content = `
Operations runbook for diagnosing and resolving an EBS adpatch worker stuck in RUNNING state due to a database blocking lock. Includes phase-by-phase investigation, a fully automated lock analysis script, pre-patch session audit script, safe kill procedures, and post-resolution verification.

**Applies to:** EBS 12.1.x / 12.2.x — adpatch, adadmin, adgadd

---

## Phase 1 — Confirm the Worker Is Stuck (Not Just Slow)

### Time threshold

A worker executing a DDL against a large table may legitimately take 30–90 minutes. Before acting:

| Elapsed time | Assessment |
|---|---|
| < 30 min | Normal — monitor only |
| 30–90 min | Check worker log for progress indicators |
| > 90 min with no log progress | Almost certainly blocked |
| > 2 hours with no log progress | Confirmed stuck — investigate immediately |

### Read the worker log for the last SQL and timestamp

\`\`\`bash
WORKER_N=3    # Replace with actual failed worker number
WORKER_LOG=\$APPL_TOP/admin/\$TWO_TASK/log/adwork00\${WORKER_N}.log

# Last SQL executed and time since it started
tail -40 "\$WORKER_LOG"

# Pull start timestamp of current statement
grep -E "alter table|create index|truncate|insert into" "\$WORKER_LOG" | tail -5

# How many minutes since the last log activity?
LAST_LINE_TIME=\$(tail -1 "\$WORKER_LOG" | grep -oP '\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}')
echo "Last log activity: \$LAST_LINE_TIME"
\`\`\`

### Verify the worker OS process is alive

\`\`\`bash
# adpatch workers run as applmgr, connected as APPS to Oracle
ps -ef | grep -i "adwork\|sqlplus" | grep -v grep

# Check the worker PID is in sleep/wait state (S), not CPU-bound (R)
ps -ef | grep "adwork00\${WORKER_N}" | grep -v grep
\`\`\`

---

## Phase 2 — Locate the Blocked APPS Session

\`\`\`sql
-- APPS sessions waiting on lock events right now
SELECT s.sid,
       s.serial#,
       s.username,
       s.status,
       s.event,
       s.wait_class,
       s.seconds_in_wait,
       s.blocking_session,
       s.blocking_session_status,
       SUBSTR(q.sql_text, 1, 120) executing_sql
FROM   v\$session s
LEFT   JOIN v\$sql q ON s.sql_id = q.sql_id
                    AND s.sql_child_number = q.child_number
WHERE  s.username = 'APPS'
  AND  s.wait_class = 'Application'   -- lock waits fall here
ORDER  BY s.seconds_in_wait DESC;
\`\`\`

Note the **SID**, **SERIAL#**, and **BLOCKING_SESSION** of the APPS adpatch session. The BLOCKING_SESSION value is the SID holding the lock you need to clear.

---

## Phase 3 — Profile the Blocking Session

### Identity and current SQL

\`\`\`sql
-- Replace :blocker_sid with the BLOCKING_SESSION value from Phase 2
SELECT s.sid,
       s.serial#,
       s.username,
       s.osuser,
       s.machine,
       s.program,
       s.module,
       s.action,
       s.status,
       s.last_call_et        seconds_since_last_call,
       s.logon_time,
       s.wait_class,
       s.event,
       SUBSTR(q.sql_text, 1, 200) current_sql,
       q.last_active_time    sql_last_active
FROM   v\$session s
LEFT   JOIN v\$sql q ON s.sql_id = q.sql_id
                    AND s.sql_child_number = q.child_number
WHERE  s.sid = :blocker_sid;
\`\`\`

### What table lock does the blocker hold?

\`\`\`sql
SELECT l.sid,
       l.type          lock_type,
       DECODE(l.mode_held,
         0,'None', 1,'Null', 2,'Row-S(SS)', 3,'Row-X(SX)',
         4,'Share', 5,'S/Row-X(SSX)', 6,'Exclusive') mode_held,
       o.owner,
       o.object_name,
       o.object_type
FROM   v\$lock l
JOIN   dba_objects o ON o.object_id = l.id1
WHERE  l.sid  = :blocker_sid
  AND  l.type IN ('TM', 'TX')
ORDER  BY l.type;
\`\`\`

### Is the blocker a concurrent request?

\`\`\`sql
SELECT r.request_id,
       p.user_concurrent_program_name,
       r.status_code,
       r.phase_code,
       r.actual_start_date,
       ROUND((SYSDATE - r.actual_start_date)*24*60, 1) elapsed_min,
       r.completion_text,
       r.logfile_name
FROM   applsys.fnd_concurrent_requests r
JOIN   applsys.fnd_concurrent_programs p
  ON   p.concurrent_program_id = r.concurrent_program_id
  AND  p.application_id        = r.program_application_id
WHERE  r.oracle_session_id = :blocker_sid
  AND  r.phase_code        = 'R';
\`\`\`

### Is the blocker a Forms or idle session with an open transaction?

\`\`\`sql
SELECT s.sid,
       s.serial#,
       s.username,
       s.program,
       s.last_call_et   idle_seconds,
       t.start_time     txn_start,
       t.used_ublk      undo_blocks,
       t.log_io         log_ios
FROM   v\$session s
JOIN   v\$transaction t ON t.ses_addr = s.saddr
WHERE  s.sid = :blocker_sid;
\`\`\`

A large \`idle_seconds\` with an open transaction that has done very little work (\`log_io\` close to zero after minutes) is a strong indicator of an abandoned Forms session.

---

## Phase 4 — Resolve the Block

### 4A — Concurrent request: cancel via EBS

\`\`\`sql
-- Preferred: mark for cancellation — CM terminates cleanly
UPDATE applsys.fnd_concurrent_requests
SET    status_code    = 'X'
WHERE  request_id     = :request_id
  AND  phase_code     = 'R';

COMMIT;
\`\`\`

Wait up to 2 minutes for the Concurrent Manager to detect the status change and send SIGTERM to the request process. Confirm cancellation:

\`\`\`sql
SELECT request_id, status_code, phase_code, completion_text
FROM   applsys.fnd_concurrent_requests
WHERE  request_id = :request_id;
-- Expected: status_code = 'X', phase_code = 'C'
\`\`\`

Then verify the Oracle session is gone:

\`\`\`sql
SELECT COUNT(*) still_alive
FROM   v\$session
WHERE  sid = :blocker_sid;
-- Expected: 0
\`\`\`

### 4B — Direct database session kill

Use when: blocker is not a concurrent request, or 4A did not clear the lock within 3 minutes.

\`\`\`sql
-- Confirm once more before killing
SELECT sid, serial#, username, machine, program, seconds_in_wait, event
FROM   v\$session
WHERE  sid = :blocker_sid;

-- Kill with IMMEDIATE to avoid waiting for rollback acknowledgement
ALTER SYSTEM KILL SESSION ':sid,:serial#' IMMEDIATE;
-- Example: ALTER SYSTEM KILL SESSION '88,24617' IMMEDIATE;
\`\`\`

Verify the session is cleared and the patch worker's wait has lifted:

\`\`\`sql
-- Blocker should be gone or show status KILLED
SELECT sid, serial#, status FROM v\$session WHERE sid = :blocker_sid;

-- Patch worker should now show CPU or scheduler wait (no longer enq:)
SELECT sid, event, seconds_in_wait, status
FROM   v\$session
WHERE  username = 'APPS'
ORDER  BY seconds_in_wait DESC;
\`\`\`

### 4C — Kill the OS process (last resort)

If the database kill returns immediately but the session remains in KILLED status for more than 10 minutes (PMON rollback is very slow for large transactions):

\`\`\`bash
# Find the Oracle server process for the blocker (run on DB host as oracle OS user)
# Get SPID from v$process
# Run this SQL first:
# SELECT p.spid FROM v$session s JOIN v$process p ON p.addr = s.paddr WHERE s.sid = :blocker_sid;

SPID=<value from above>
kill -9 "\$SPID"
\`\`\`

This forces PMON to handle the rollback. The DB session disappears within seconds. Use this only when the KILLED session is holding up the patch and PMON rollback is taking too long.

---

## Phase 5 — Monitor Worker Recovery

The patch worker was RUNNING, not FAILED. Once the lock releases it will complete on its own — no adctrl needed.

\`\`\`bash
# Tail the worker log and wait for the COMPLETED line
tail -f \$APPL_TOP/admin/\$TWO_TASK/log/adwork003.log

# Confirm the adpatch manager screen updates
# The worker line changes from:
#   RUNNING: file oepatchu.sql on worker 3
# to:
#   COMPLETED: file oepatchu.sql on worker 3
\`\`\`

If instead the worker transitions to FAILED after the lock is cleared, the DDL itself failed (e.g., ORA-01653 tablespace full). Diagnose separately.

---

## Phase 6 — Verify Patch Completion

\`\`\`sql
-- No remaining running or waiting jobs
SELECT execution_status, COUNT(*)
FROM   applsys.ad_deferred_jobs
GROUP  BY execution_status;
-- All should be C (Completed)

-- No APPS sessions still waiting on locks
SELECT COUNT(*) lock_waiters
FROM   v\$session
WHERE  username   = 'APPS'
  AND  wait_class = 'Application';
-- Expected: 0

-- Patch bug registered
SELECT bug_number, creation_date, platform_code
FROM   applsys.ad_bugs
WHERE  bug_number = '35678901';

-- Product patch level updated
SELECT application_short_name, product_version, patch_level, last_update_date
FROM   applsys.fnd_product_installations
WHERE  application_short_name = 'OE';
\`\`\`

---

## Automated Lock Analysis Script

Run this as the oracle OS user (with \`sqlplus\` in PATH) when a worker is stuck. Produces a full lock report in 30 seconds.

\`\`\`bash
#!/bin/bash
# /u01/scripts/ebs_patch_lock_analysis.sh
# Usage: ./ebs_patch_lock_analysis.sh [apps_password] [db_connect_string]
# Example: ./ebs_patch_lock_analysis.sh apps_pwd PROD

APPS_PWD=\${1:-"apps"}
DB_CONN=\${2:-"\$TWO_TASK"}
REPORT=/tmp/ebs_lock_analysis_\$(date +%Y%m%d_%H%M%S).txt
DIVIDER="=================================================================="

report() { echo "\$1" | tee -a "\$REPORT"; }

report "\$DIVIDER"
report "EBS Patch Lock Analysis — \$(date)"
report "DB: \$DB_CONN"
report "\$DIVIDER"

# ── 1. Environment check ────────────────────────────────────────────────────
report ""
report "1. ENVIRONMENT"
report "   TWO_TASK : \$TWO_TASK"
report "   APPL_TOP : \$APPL_TOP"

# ── 2. Stuck workers ────────────────────────────────────────────────────────
report ""
report "2. ADPATCH WORKER LOG STATUS"
LOG_DIR=\$APPL_TOP/admin/\$TWO_TASK/log
for LOG in "\$LOG_DIR"/adwork*.log; do
  [ -f "\$LOG" ] || continue
  LAST_ACTIVITY=\$(stat -c %Y "\$LOG" 2>/dev/null || stat -f %m "\$LOG" 2>/dev/null)
  NOW=\$(date +%s)
  IDLE_MIN=\$(( (NOW - LAST_ACTIVITY) / 60 ))
  LAST_LINE=\$(tail -1 "\$LOG")
  report "   \$(basename "\$LOG"): idle \${IDLE_MIN}m — \$LAST_LINE"
done

# ── 3. Database lock analysis ────────────────────────────────────────────────
report ""
report "3. DATABASE LOCK ANALYSIS"

sqlplus -S "apps/\${APPS_PWD}@\${DB_CONN}" << SQLEOF >> "\$REPORT" 2>&1
SET PAGESIZE 80 LINESIZE 180 FEEDBACK OFF TRIMSPOOL ON

PROMPT
PROMPT --- APPS sessions waiting on locks ---
SELECT s.sid,
       s.serial#,
       s.status,
       s.event,
       s.seconds_in_wait,
       s.blocking_session,
       SUBSTR(q.sql_text,1,100) sql_text
FROM   v\$session s
LEFT JOIN v\$sql q ON s.sql_id=q.sql_id AND s.sql_child_number=q.child_number
WHERE  s.username='APPS' AND s.wait_class='Application'
ORDER  BY s.seconds_in_wait DESC;

PROMPT
PROMPT --- Full blocking chain ---
SELECT LPAD(' ',2*(LEVEL-1))||s.sid sid_tree, s.serial#,
       s.username, s.program, s.status,
       s.event, s.seconds_in_wait,
       SUBSTR(q.sql_text,1,80) sql_text
FROM   v\$session s
LEFT JOIN v\$sql q ON s.sql_id=q.sql_id AND s.sql_child_number=q.child_number
WHERE  s.type='USER'
START  WITH s.blocking_session IS NULL
  AND  EXISTS(SELECT 1 FROM v\$session s2 WHERE s2.blocking_session=s.sid)
CONNECT BY PRIOR s.sid=s.blocking_session
ORDER SIBLINGS BY s.sid;

PROMPT
PROMPT --- Locks held by blockers ---
SELECT l.sid, l.type,
       DECODE(l.mode_held,
         0,'None',1,'Null',2,'Row-S',3,'Row-X',4,'Share',5,'S/Row-X',6,'Exclusive') held,
       o.owner, o.object_name, o.object_type
FROM   v\$lock l JOIN dba_objects o ON o.object_id=l.id1
WHERE  l.type IN ('TM','TX')
  AND  l.sid IN (
    SELECT DISTINCT blocking_session FROM v\$session
    WHERE blocking_session IS NOT NULL)
ORDER  BY l.sid, l.type;

PROMPT
PROMPT --- Running concurrent requests (potential lock holders) ---
SELECT r.request_id,
       p.user_concurrent_program_name,
       r.actual_start_date,
       ROUND((SYSDATE-r.actual_start_date)*24*60,1) elapsed_min,
       r.oracle_session_id
FROM   applsys.fnd_concurrent_requests r
JOIN   applsys.fnd_concurrent_programs p
  ON   p.concurrent_program_id=r.concurrent_program_id
  AND  p.application_id=r.program_application_id
WHERE  r.phase_code='R'
ORDER  BY r.actual_start_date;

PROMPT
PROMPT --- Sessions with open transactions (idle time > 5 min) ---
SELECT s.sid, s.serial#, s.username, s.program,
       s.last_call_et idle_sec,
       t.start_time txn_start, t.used_ublk undo_blocks
FROM   v\$session s JOIN v\$transaction t ON t.ses_addr=s.saddr
WHERE  s.username NOT IN ('SYS','SYSTEM','DBSNMP')
  AND  s.last_call_et > 300
ORDER  BY s.last_call_et DESC;

EXIT;
SQLEOF

# ── 4. Recommendation ────────────────────────────────────────────────────────
report ""
report "4. ACTION REQUIRED"
report "   Review section 3 above:"
report "   a) If 'APPS sessions waiting on locks' is non-empty → blocking lock confirmed"
report "   b) Note the blocking_session SID"
report "   c) Check 'Running concurrent requests' — if request_id matches, cancel via EBS UI"
report "      SQL: UPDATE fnd_concurrent_requests SET status_code='X' WHERE request_id=<id>; COMMIT;"
report "   d) If not a concurrent request:"
report "      SQL: ALTER SYSTEM KILL SESSION '<sid>,<serial#>' IMMEDIATE;"
report "   e) Tail adwork00N.log and wait for COMPLETED line"

report ""
report "\$DIVIDER"
report "Report saved: \$REPORT"
\`\`\`

---

## Pre-Patch Session Audit Script

Run this **before** starting adpatch. If it returns output, resolve the sessions first.

\`\`\`bash
#!/bin/bash
# /u01/scripts/ebs_prepatch_audit.sh
# Usage: ./ebs_prepatch_audit.sh [apps_password] [db_connect_string]

APPS_PWD=\${1:-"apps"}
DB_CONN=\${2:-"\$TWO_TASK"}

echo "========================================"
echo " EBS Pre-Patch Session Audit — \$(date)"
echo "========================================"

sqlplus -S "apps/\${APPS_PWD}@\${DB_CONN}" << 'SQLEOF'
SET PAGESIZE 50 LINESIZE 150 FEEDBACK OFF

PROMPT
PROMPT *** 1. Open transactions (must be zero before patching) ***
SELECT s.sid, s.serial#, s.username, s.program,
       s.last_call_et idle_sec,
       t.start_time txn_start, t.used_ublk undo_blocks
FROM   v\$session s JOIN v\$transaction t ON t.ses_addr = s.saddr
WHERE  s.username NOT IN ('SYS','SYSTEM','DBSNMP','MDSYS','ORDSYS')
ORDER  BY t.start_time;

PROMPT
PROMPT *** 2. Running concurrent requests (coordinate shutdown before patching) ***
SELECT r.request_id,
       p.user_concurrent_program_name,
       r.actual_start_date,
       ROUND((SYSDATE - r.actual_start_date)*24*60, 1) elapsed_min
FROM   applsys.fnd_concurrent_requests r
JOIN   applsys.fnd_concurrent_programs p
  ON   p.concurrent_program_id = r.concurrent_program_id
  AND  p.application_id        = r.program_application_id
WHERE  r.phase_code = 'R'
ORDER  BY r.actual_start_date;

PROMPT
PROMPT *** 3. Active user sessions (Forms, JDBC app sessions) ***
SELECT s.sid, s.serial#, s.username, s.osuser,
       s.machine, s.program, s.status,
       s.last_call_et seconds_active
FROM   v\$session s
WHERE  s.username NOT IN ('SYS','SYSTEM','DBSNMP','MDSYS','ORDSYS')
  AND  s.type    = 'USER'
  AND  s.program NOT LIKE '%adpatch%'
  AND  s.program NOT LIKE '%adadmin%'
ORDER  BY s.last_call_et DESC;

PROMPT
PROMPT *** AUDIT COMPLETE — zero rows in all three sections = safe to start adpatch ***
EXIT;
SQLEOF
\`\`\`

---

## Quick Decision Guide

\`\`\`
Worker stuck on RUNNING > 90 minutes?
│
└── Check v$session for APPS session with event 'enq: TM - contention'
    │
    ├── blocking_session IS NULL → not a lock issue
    │     → check for long-running SQL (separate diagnosis)
    │
    └── blocking_session IS NOT NULL → confirmed lock
          │
          ├── Blocker = concurrent request?
          │     YES → UPDATE fnd_concurrent_requests SET status_code='X'; COMMIT;
          │            Wait 2 min → confirm session gone → worker finishes
          │
          ├── Blocker = idle Forms/JDBC session?
          │     YES → ALTER SYSTEM KILL SESSION 'sid,serial#' IMMEDIATE;
          │            Worker finishes automatically
          │
          └── Blocker = another adpatch worker?
                → This is a job dependency — adpatch manager controls ordering
                → Do NOT kill the other worker
                → Wait — the manager will sequence the jobs correctly
\`\`\`

---

## Common Mistakes

| Mistake | Consequence |
|---|---|
| Killing the stuck adpatch worker process | Worker transitions to FAILED; adctrl restart needed; patch partially applied |
| Killing a blocking adpatch worker | Creates cascading failures across dependent jobs |
| Running adctrl restart on a RUNNING worker | No effect — adctrl restart only applies to FAILED workers |
| Cancelling all concurrent requests without checking what they do | Incomplete business transactions; data integrity risk |
| Starting adpatch without the pre-patch audit | Predictable blocking lock after first DDL step |
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'EBS Patching Blocking Locks — Operations Runbook',
    slug,
    excerpt: 'Operations runbook for diagnosing and resolving EBS adpatch workers stuck in RUNNING state due to database blocking locks. Phase-by-phase investigation using v$session and v$lock, automated lock analysis script, pre-patch session audit script, safe concurrent request cancellation and session kill procedures, and a quick decision guide for every blocker type.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
