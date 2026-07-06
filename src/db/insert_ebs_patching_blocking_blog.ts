import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-patching-workers-stuck-running-blocking-locks';

const content = `
You have been watching the adpatch manager screen for three hours. Every other worker finished long ago. Worker 3 still shows **RUNNING**. The file it is processing is not an LDT — it is a SQL script, and it has not moved. No error. No failure. Just silence.

This is the other classic EBS patching trap: a patch worker blocked by a live database session holding a lock on the table that the patch's DDL needs to modify. Until the blocker is gone, the worker will wait forever — and because the adpatch manager interprets RUNNING as progress, it will not raise any alert.

This post shows how to confirm the block, find the guilty session, resolve it, and get the patch moving again.

---

## The Scenario

You are applying patch **35678901** on an EBS 12.2.x environment. The patch includes SQL scripts that modify the Order Management schema. Worker 3 picks up a file and begins executing. The adpatch screen shows:

\`\`\`
RUNNING: file oepatchu.sql on worker 3 for product oe username APPS.
\`\`\`

After one hour that line has not changed. Other workers have completed their jobs and sit idle. The worker log (\`adwork003.log\`) shows the SQL statement started but no completion line follows it.

---

## Why Workers Get Stuck

EBS patches frequently include DDL statements: \`ALTER TABLE\`, \`CREATE INDEX\`, \`DROP COLUMN\`, \`TRUNCATE\`. Oracle DDL requires an exclusive lock on the target object. If any session holds even a row-level DML lock (\`TX\` lock) on that table — from an uncommitted transaction, a concurrent request, or an idle-in-transaction session — the DDL waits indefinitely.

The adpatch worker's APPS database session is enqueued behind the blocker in the lock manager. From adpatch's perspective the session is active and running SQL, which is technically true. It is not hung; it is waiting on a lock event.

\`\`\`
adpatch worker 3 (APPS session, SID 245)
  → executing: ALTER TABLE oe_order_lines_all ADD ...
  → wait event: "enq: TM - contention"
  → blocked by: SID 88 (Concurrent Manager: Order Import)
       → holding TX lock on oe_order_lines_all (uncommitted DML)
\`\`\`

---

## Step 1 — Confirm the Worker Is Truly Blocked

### Read the worker log

\`\`\`bash
WORKER_N=3
WORKER_LOG=\$APPL_TOP/admin/\$TWO_TASK/log/adwork00\${WORKER_N}.log

# Last 30 lines — look for a SQL statement with no subsequent COMPLETED line
tail -30 "\$WORKER_LOG"

# Find the last SQL statement executed and its start timestamp
grep -E "RUNNING|sqlplus|ALTER|CREATE|TRUNCATE|INSERT" "\$WORKER_LOG" | tail -20

# How long ago did it start?
grep "RUNNING" "\$WORKER_LOG" | tail -3
\`\`\`

A stuck worker log typically ends like this — the statement started, then nothing:

\`\`\`
[2025-11-14 02:14:37] Executing SQL file: oepatchu.sql
[2025-11-14 02:14:38] alter table oe_order_lines_all add (attribute21 varchar2(240))
\`\`\`

No completion line for hours = the SQL is waiting.

### Confirm the worker session is waiting — not running

\`\`\`sql
-- Find the APPS sessions currently waiting on lock events
SELECT s.sid,
       s.serial#,
       s.username,
       s.status,
       s.wait_class,
       s.event,
       s.seconds_in_wait,
       s.blocking_session,
       SUBSTR(q.sql_text, 1, 100) sql_text
FROM   v\$session s
LEFT   JOIN v\$sql q ON s.sql_id = q.sql_id
                    AND s.sql_child_number = q.child_number
WHERE  s.username = 'APPS'
  AND  s.event LIKE '%enq%'
ORDER  BY s.seconds_in_wait DESC;
\`\`\`

If you see an APPS session waiting on **enq: TM - contention** or **enq: TX - row lock contention** with a non-null \`BLOCKING_SESSION\`, you have confirmed the block.

---

## Step 2 — Find the Blocking Session

### Identify the full blocking chain

\`\`\`sql
-- Full lock chain — shows blocker → waiter hierarchy
SELECT LPAD(' ', 2*(LEVEL-1)) || s.sid          sid_tree,
       s.serial#,
       s.username,
       s.status,
       s.osuser,
       s.machine,
       s.program,
       s.wait_class,
       s.event,
       s.seconds_in_wait,
       SUBSTR(q.sql_text, 1, 80)                 sql_text
FROM   v\$session s
LEFT   JOIN v\$sql q ON s.sql_id = q.sql_id
                    AND s.sql_child_number = q.child_number
WHERE  s.type = 'USER'
START  WITH s.blocking_session IS NULL
  AND  EXISTS (SELECT 1 FROM v\$session s2
               WHERE  s2.blocking_session = s.sid)
CONNECT BY PRIOR s.sid = s.blocking_session
ORDER  SIBLINGS BY s.sid;
\`\`\`

### Find what the blocker is actually doing

\`\`\`sql
-- Detailed profile of the blocking session
SELECT s.sid,
       s.serial#,
       s.username,
       s.osuser,
       s.machine,
       s.program,
       s.module,
       s.action,
       s.status,
       s.last_call_et        seconds_active,
       s.logon_time,
       s.blocking_session,
       s.wait_class,
       s.event,
       q.sql_text            current_sql,
       q.last_active_time
FROM   v\$session s
LEFT   JOIN v\$sql q ON s.sql_id = q.sql_id
                    AND s.sql_child_number = q.child_number
WHERE  s.sid = :blocking_sid;   -- substitute from previous query
\`\`\`

### Check whether the blocker is a concurrent request

The \`MODULE\` and \`ACTION\` columns in \`v\$session\` carry EBS context. A session started by the Concurrent Manager shows the concurrent program short name in \`MODULE\` or \`ACTION\`.

\`\`\`sql
-- Cross-reference v$session with fnd_concurrent_requests
SELECT r.request_id,
       r.concurrent_program_id,
       p.concurrent_program_name,
       p.user_concurrent_program_name,
       r.status_code,
       r.phase_code,
       r.requested_start_date,
       r.actual_start_date,
       r.oracle_session_id
FROM   applsys.fnd_concurrent_requests r
JOIN   applsys.fnd_concurrent_programs p
  ON   p.concurrent_program_id = r.concurrent_program_id
  AND  p.application_id        = r.program_application_id
WHERE  r.oracle_session_id = :blocking_sid   -- SID from v$session
  AND  r.phase_code = 'R';                  -- Running phase
\`\`\`

### Identify which table the blocker holds a lock on

\`\`\`sql
SELECT l.sid,
       l.type          lock_type,
       l.mode_held,
       l.mode_requested,
       o.object_name,
       o.object_type,
       o.owner
FROM   v\$lock l
JOIN   dba_objects o ON o.object_id = l.id1
WHERE  l.sid = :blocking_sid
  AND  l.type IN ('TM', 'TX')
ORDER  BY l.type;
\`\`\`

If the blocker holds a TM lock on the same table the patch DDL is targeting, you have the full picture.

---

## Step 3 — Assess and Resolve the Block

### Option A — Wait for the concurrent request to finish naturally

If the blocking session is a concurrent request that is nearly complete, the safest option is to wait. Check elapsed time and estimated remaining work:

\`\`\`sql
SELECT r.request_id,
       p.user_concurrent_program_name,
       r.actual_start_date,
       ROUND((SYSDATE - r.actual_start_date) * 24 * 60, 1) elapsed_min,
       r.completion_text
FROM   applsys.fnd_concurrent_requests r
JOIN   applsys.fnd_concurrent_programs p
  ON   p.concurrent_program_id = r.concurrent_program_id
  AND  p.application_id        = r.program_application_id
WHERE  r.oracle_session_id = :blocking_sid;
\`\`\`

If it has been running for 30 seconds, wait. If it has been running for 4 hours with no completion estimate, proceed to Option B.

### Option B — Cancel the concurrent request via EBS

If the blocker is a concurrent request, cancel it through EBS rather than killing the OS process — the Concurrent Manager cleans up cleanly this way.

\`\`\`sql
-- Mark the request for cancellation
UPDATE applsys.fnd_concurrent_requests
SET    status_code = 'X'   -- X = Terminated
WHERE  request_id  = :request_id
  AND  phase_code  = 'R';

COMMIT;
\`\`\`

Then in the EBS UI: Concurrent → Requests → Find the running request → Cancel.

The Concurrent Manager detects the status change at its next poll and sends a SIGTERM to the concurrent request OS process.

### Option C — Kill the database session directly

Use this when the blocker is not a concurrent request, or when Option B has not cleared the lock within a few minutes.

\`\`\`sql
-- Confirm the session before killing
SELECT sid, serial#, username, machine, program, seconds_in_wait
FROM   v\$session
WHERE  sid = :blocking_sid;

-- Kill the session
ALTER SYSTEM KILL SESSION ':sid,:serial#' IMMEDIATE;

-- Example:
-- ALTER SYSTEM KILL SESSION '88,24617' IMMEDIATE;
\`\`\`

After the kill, verify the session is gone:

\`\`\`sql
-- Session should no longer appear (or shows status = 'KILLED' briefly)
SELECT sid, serial#, status
FROM   v\$session
WHERE  sid = :blocking_sid;

-- The APPS patch worker session should now be waiting → active → completed
SELECT sid, serial#, event, seconds_in_wait, status
FROM   v\$session
WHERE  username = 'APPS'
  AND  event LIKE '%enq%';
\`\`\`

---

## Step 4 — Monitor the Worker Recovery

Once the blocker is gone, the patch worker's DDL acquires its lock and executes. You do not need to use adctrl — the worker was never in FAILED state, it was RUNNING. It completes on its own.

\`\`\`bash
# Watch the worker log for the completion line
tail -f \$APPL_TOP/admin/\$TWO_TASK/log/adwork003.log

# Expected:
# [timestamp] alter table oe_order_lines_all add (attribute21 varchar2(240))
# [timestamp] COMPLETED: file oepatchu.sql on worker 3 for product oe username APPS.
\`\`\`

If the worker shows FAILED after the lock releases, the DDL itself encountered an error — follow the FNDLOAD runbook pattern to diagnose the SQL failure separately.

---

## Blocking Lock Patterns in EBS Patching

| Blocker type | Typical program column | Typical wait event on worker |
|---|---|---|
| Concurrent request | \`FNDLIBR\` or program name | enq: TM - contention |
| Forms session with open transaction | \`frmweb\` | enq: TM - contention |
| Idle-in-transaction SQL*Plus | \`sqlplus\` | enq: TM - contention |
| Another adpatch worker (dependency) | \`adwork\` | enq: TX - row lock contention |
| Background job (DBMS_SCHEDULER) | \`oracle@hostname\` | enq: TM - contention |

---

## Pre-Patch Session Audit

Run this before starting any EBS patch session. If active DML transactions exist on tables the patch targets, resolve them first.

\`\`\`sql
-- Active non-system sessions with open transactions
SELECT s.sid,
       s.serial#,
       s.username,
       s.program,
       s.module,
       s.status,
       s.last_call_et  seconds_idle,
       t.used_ublk     undo_blocks_used,
       t.log_io,
       t.start_time    txn_start
FROM   v\$session s
JOIN   v\$transaction t ON t.ses_addr = s.saddr
WHERE  s.username NOT IN ('SYS', 'SYSTEM', 'DBSNMP')
ORDER  BY t.start_time;

-- Running concurrent requests (potential lock holders during patching)
SELECT r.request_id,
       p.user_concurrent_program_name,
       r.actual_start_date,
       ROUND((SYSDATE - r.actual_start_date)*60*24, 1) elapsed_min
FROM   applsys.fnd_concurrent_requests r
JOIN   applsys.fnd_concurrent_programs p
  ON   p.concurrent_program_id = r.concurrent_program_id
  AND  p.application_id        = r.program_application_id
WHERE  r.phase_code = 'R'   -- Running
ORDER  BY r.actual_start_date;
\`\`\`

If the second query returns rows, either wait for them to complete or coordinate with the business team before starting adpatch.

---

## Summary

An EBS patch worker stuck on RUNNING is almost always waiting on a database lock, not computing. The tell is the combination of an unchanged RUNNING status line in the adpatch manager, a worker log that stops after a DDL statement, and a \`v\$session\` row for that APPS session showing **enq: TM - contention** with a non-null \`BLOCKING_SESSION\`. The fix is to identify the blocker (often a concurrent request or an idle-in-transaction Forms session), cancel or kill it, and let the patch worker acquire the lock and finish. No adctrl intervention is needed — the worker was never failed, just blocked. Prevention is straightforward: run a pre-patch session audit before every adpatch invocation and ensure no long-running concurrent programs hold DML locks on tables the patch is known to touch.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'EBS Patching: Workers Stuck in RUNNING State — Diagnosing and Breaking Database Blocking Locks',
    slug,
    excerpt: 'An EBS patch worker stuck on RUNNING for hours without failing is almost always waiting on a database lock. Covers how to confirm the block via v$session wait events, trace the full blocking chain, identify whether the blocker is a concurrent request or a rogue session, resolve it cleanly, and prevent it with a pre-patch session audit.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
