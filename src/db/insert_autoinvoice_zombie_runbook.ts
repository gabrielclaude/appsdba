import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'AutoInvoice Zombie Request Runbook: Diagnosing and Clearing Idle Concurrent Sessions in Oracle EBS',
  slug: 'oracle-ebs-autoinvoice-zombie-request-runbook',
  excerpt:
    'Step-by-step runbook for identifying and safely terminating zombie AutoInvoice Import (RAXTRX) concurrent requests in Oracle EBS — where the Concurrent Manager reports Running but the database session is completely idle. Covers the V$SESSION LAST_CALL_ET diagnostic query that maps a concurrent request ID to its database session and OS process, I/O delta sampling to confirm no work is occurring, the three-step termination sequence (EBS front-end cancel, ALTER SYSTEM KILL SESSION, OS kill -9), CMCLEAN cleanup for requests stuck in Terminating status, RA_INTERFACE_LINES_ALL and RA_INTERFACE_ERRORS_ALL pre-resubmission cleanup, and automated monitoring scripts that alert during month-end processing windows when any concurrent session enters the zombie pattern.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-30'),
  youtubeUrl: null,
  content: `## Introduction

This runbook resolves zombie AutoInvoice Import (RAXTRX) concurrent requests — processes reported as Running by the Oracle EBS Concurrent Manager that have an idle database session making no database calls. The zombie pattern is identified by \`V$SESSION.LAST_CALL_ET\` exceeding one hour combined with \`STATUS = 'INACTIVE'\` and wait event \`SQL*Net message from client\`.

**When to use this runbook**: An AutoInvoice Import concurrent request has been Running for 2+ hours with no completion, and a functional check confirms no unusual data volume that would explain the runtime. A database session check (Phase 1) confirms the session is idle.

**Environment assumptions**: Oracle EBS 12.2, Oracle 19c database. SQL queries run as SYS or Apps DBA. OS commands run as the application owner (\`applmgr\` or \`oracle\`) on the Concurrent Processing tier.

---

## Phase 1: Identify and Confirm the Zombie Session

### Step 1.1 — Find All Long-Running Concurrent Requests

Before targeting a specific request, get a picture of the entire running queue to identify all zombie candidates:

\`\`\`sql
-- All requests in Running status > 2 hours with session details
SELECT fcr.request_id,
       fcpt.user_concurrent_program_name  AS program_name,
       ROUND((SYSDATE - fcr.actual_start_date) * 60, 1) AS total_minutes_running,
       vs.sid,
       vs.serial#,
       vp.spid                            AS os_process_id,
       vs.status                          AS session_status,
       vs.last_call_et                    AS idle_seconds,
       ROUND(vs.last_call_et / 3600, 2)  AS idle_hours,
       vs.event                           AS wait_event,
       fu.user_name                       AS submitted_by
FROM fnd_concurrent_requests fcr
JOIN fnd_concurrent_programs_tl fcpt
  ON fcr.concurrent_program_id = fcpt.concurrent_program_id
 AND fcpt.language = 'US'
JOIN fnd_user fu ON fcr.requested_by = fu.user_id
JOIN v\$process vp ON fcr.oracle_process_id = vp.spid
JOIN v\$session vs ON vp.addr = vs.paddr
WHERE fcr.phase_code  = 'R'
  AND fcr.status_code = 'R'
  AND fcr.actual_start_date < SYSDATE - 2/24
ORDER BY vs.last_call_et DESC, total_minutes_running DESC;
\`\`\`

### Step 1.2 — Deep Diagnostic for a Specific Request

Once a suspect request is identified, gather the complete session profile:

\`\`\`sql
-- Full session diagnostic for a specific concurrent request ID
SELECT fcr.request_id,
       fcr.actual_start_date,
       ROUND((SYSDATE - fcr.actual_start_date) * 60, 1)  AS total_minutes_running,
       vs.sid,
       vs.serial#,
       vp.spid                            AS os_spid,
       vs.status                          AS session_status,
       vs.last_call_et                    AS idle_seconds,
       ROUND(vs.last_call_et / 3600, 2)  AS idle_hours,
       vs.event                           AS wait_event,
       vs.state,
       vs.seconds_in_wait,
       vs.machine,
       vs.program                         AS client_program,
       vs.module,
       vs.action,
       fcr.logfile_name,
       fcr.outfile_name
FROM apps.fnd_concurrent_requests fcr
JOIN v\$process vp ON fcr.oracle_process_id = vp.spid
JOIN v\$session vs ON vp.addr = vs.paddr
WHERE fcr.request_id = &target_request_id;
\`\`\`

Record the values for \`SID\`, \`SERIAL#\`, \`OS_SPID\`, and \`IDLE_HOURS\` — you will need all three in subsequent steps.

### Step 1.3 — Confirm No Active I/O (Two-Sample Test)

\`\`\`sql
-- Sample 1: record I/O counters
SELECT vs.sid,
       vs.status,
       vs.last_call_et,
       vsio.block_gets,
       vsio.consistent_gets,
       vsio.physical_reads,
       vsio.block_changes,
       TO_CHAR(SYSDATE, 'HH24:MI:SS') AS sample_time
FROM v\$session vs
JOIN v\$sess_io vsio ON vs.sid = vsio.sid
WHERE vs.sid = &target_sid;

-- Wait 60 seconds, then run Sample 2
-- (run in a second session or after a manual wait)

-- Sample 2: identical query — compare physical_reads and consistent_gets
-- Zombie: identical values between samples (zero I/O in 60 seconds)
-- Working: increasing values (active query execution)
\`\`\`

A zombie session shows no change in any I/O counter between samples. A genuinely slow request shows increasing \`physical_reads\` and \`consistent_gets\` as it works through its data set.

### Step 1.4 — Check for Locks Held by the Zombie

A zombie session may hold row or table locks that are blocking other sessions — a frequent cause of concurrent queue backup beyond the single zombie request:

\`\`\`sql
SELECT l.sid,
       l.type,
       DECODE(l.lmode,
              0,'None', 1,'Null', 2,'Row-S', 3,'Row-X',
              4,'Share', 5,'S/Row-X', 6,'Exclusive') AS lock_mode,
       l.block,
       o.object_name,
       o.object_type
FROM v\$lock l
JOIN dba_objects o ON l.id1 = o.object_id
WHERE l.sid = &zombie_sid
  AND l.type IN ('TM', 'TX')
ORDER BY l.block DESC, l.type;
\`\`\`

If \`BLOCK = 1\`, the zombie is actively blocking other sessions. Note the blocked session IDs:

\`\`\`sql
-- Find sessions waiting on the zombie's locks
SELECT w.sid AS waiting_sid, s.username, s.program, s.seconds_in_wait, s.event
FROM v\$lock w
JOIN v\$session s ON w.sid = s.sid
WHERE w.id1 IN (
  SELECT id1 FROM v\$lock WHERE sid = &zombie_sid AND block = 1
)
  AND w.request > 0
  AND w.sid <> &zombie_sid;
\`\`\`

### Step 1.5 — Confirm Zombie Diagnosis Criteria

Document all three criteria before proceeding to termination:

\`\`\`
☐ SESSION STATUS = INACTIVE
☐ LAST_CALL_ET > 3600 (idle > 1 hour; ideally > 7200 for higher confidence)
☐ WAIT EVENT = 'SQL*Net message from client'
☐ I/O delta = 0 between two 60-second samples (if time permits)
\`\`\`

All criteria must be met before terminating. A session with STATUS = ACTIVE and a high LAST_CALL_ET may be in a long-running PL/SQL block that does not issue SQL — this is a different failure mode that requires different handling.

---

## Phase 2: Front-End Cancellation (Attempt First)

Always attempt cancellation through the EBS UI before moving to backend termination. A successful front-end cancel updates \`FND_CONCURRENT_REQUESTS\` with the correct status transition and generates a proper completion record.

### Step 2.1 — Cancel from the View Concurrent Requests Form

1. Navigate to: **System Administrator → Concurrent → Requests → View**
2. Query by Request ID: enter \`&target_request_id\`
3. Select the request in the results list
4. Click **Cancel Request**
5. Confirm the cancellation dialog

### Step 2.2 — Monitor for Cancellation Response

\`\`\`sql
-- Check if the front-end cancel took effect
SELECT request_id, phase_code, status_code,
       actual_completion_date, completion_text
FROM fnd_concurrent_requests
WHERE request_id = &target_request_id;
\`\`\`

**Success** (within 1–2 minutes): \`PHASE_CODE = 'C'\`, \`STATUS_CODE = 'X'\` or \`'D'\`

**Pending** (request entered Terminating state): \`PHASE_CODE = 'R'\`, \`STATUS_CODE = 'T'\` → proceed to Phase 3

**No change** (zombie did not receive the signal): \`PHASE_CODE = 'R'\`, \`STATUS_CODE = 'R'\` → proceed to Phase 3

---

## Phase 3: Backend Session Termination

### Step 3.1 — Kill the Database Session

\`\`\`sql
-- Replace sid and serial# with values from Phase 1
-- IMMEDIATE forces immediate termination (does not wait for rollback completion)
ALTER SYSTEM KILL SESSION '&sid,&serial#' IMMEDIATE;
\`\`\`

Verify the session is gone:

\`\`\`sql
SELECT sid, serial#, status, last_call_et, event
FROM v\$session
WHERE sid = &zombie_sid;
-- Expected: no rows returned (session is gone)
-- If the row persists with STATUS = 'KILLED', the OS process cleanup is pending
\`\`\`

### Step 3.2 — Kill the OS Process

Even after \`ALTER SYSTEM KILL SESSION\`, the FNDLIBR OS process may remain alive, waiting to detect the disconnection. Kill it explicitly on the application tier:

\`\`\`bash
# Log into the application tier as applmgr or oracle
# Verify the process is the expected FNDLIBR process
ps -fp &os_spid
# Expected output: the process shows FNDLIBR in the command field

# Kill the process
kill -9 &os_spid

# Confirm the process is gone
ps -fp &os_spid
# Expected: no output (process is gone)
\`\`\`

If the application tier runs RAC-mode application servers, identify which node the SPID belongs to:

\`\`\`sql
-- Identify the application server hostname where the OS process runs
SELECT vs.machine, vp.spid
FROM v\$session vs
JOIN v\$process vp ON vs.paddr = vp.addr
WHERE vs.sid = &zombie_sid;
-- LOG INTO the returned MACHINE hostname to run kill
\`\`\`

### Step 3.3 — Verify Clean Termination

\`\`\`sql
-- Confirm the session is fully removed
SELECT COUNT(*) AS session_exists
FROM v\$session vs
JOIN v\$process vp ON vs.paddr = vp.addr
WHERE vp.spid = &os_spid;
-- Expected: 0

-- Confirm no locks remain from this session
SELECT COUNT(*) AS residual_locks
FROM v\$lock
WHERE sid = &zombie_sid;
-- Expected: 0
\`\`\`

---

## Phase 4: Concurrent Manager Status Cleanup

After backend termination, the Concurrent Manager may not immediately reflect the request as complete. The request can remain in \`R/R\` (Running) or transition to \`R/T\` (Terminating) and stay there.

### Step 4.1 — Check Request Status After Kill

\`\`\`sql
SELECT request_id, phase_code, status_code, actual_completion_date
FROM fnd_concurrent_requests
WHERE request_id = &target_request_id;
\`\`\`

| Phase/Status | Meaning | Action |
|---|---|---|
| C/X | Completed/Terminated | Done — proceed to Phase 5 |
| C/E | Completed/Error | Done — proceed to Phase 5 |
| R/T | Running/Terminating | Wait up to 5 minutes, then use Step 4.2 |
| R/R | Running/Running | Use Step 4.2 immediately |

### Step 4.2 — Manual Status Transition (If Stuck in R/R or R/T)

\`\`\`sql
-- Force the request to Completed/Error status after confirming backend cleanup
UPDATE fnd_concurrent_requests
SET phase_code             = 'C',
    status_code            = 'E',
    actual_completion_date = SYSDATE,
    completion_text        = 'Terminated by DBA — zombie session (LAST_CALL_ET exceeded threshold). Backend session killed.'
WHERE request_id  = &target_request_id
  AND phase_code  = 'R';

COMMIT;

-- Verify
SELECT request_id, phase_code, status_code, actual_completion_date, completion_text
FROM fnd_concurrent_requests
WHERE request_id = &target_request_id;
\`\`\`

### Step 4.3 — cmclean.sh (If Multiple Requests Are Affected)

If the zombie left multiple requests in a bad state or caused the Concurrent Manager to enter an inconsistent state:

\`\`\`bash
# Run cmclean.sh from the FND_TOP/bin directory
source $APPL_TOP/APPS<SID>_<host>.env
cd $FND_TOP/bin
./cmclean.sh
# Enter APPS password when prompted
\`\`\`

The cmclean.sh script scans \`FND_CONCURRENT_PROCESSES\` for processes with no active OS equivalent and resets their status, then resets any associated requests to a pending or error state so the Concurrent Manager can proceed.

---

## Phase 5: AutoInvoice Interface Table Cleanup

Before resubmitting AutoInvoice, verify and clean the interface tables. Skipping this step causes the resubmission to process zero lines — every line is still stamped with the failed request ID.

### Step 5.1 — Assess the Interface Table State

\`\`\`sql
-- Count lines under the failed request ID
SELECT COUNT(*) AS locked_lines,
       SUM(CASE WHEN interface_status IS NOT NULL THEN 1 ELSE 0 END) AS partially_processed
FROM ra_interface_lines_all
WHERE request_id = &failed_request_id;

-- Check for error records from the partial run
SELECT COUNT(*) AS error_records
FROM ra_interface_errors_all
WHERE request_id = &failed_request_id;

-- Sample the locked lines to understand their original status
SELECT transaction_type, COUNT(*) AS line_count,
       MIN(creation_date) AS earliest, MAX(creation_date) AS latest
FROM ra_interface_lines_all
WHERE request_id = &failed_request_id
GROUP BY transaction_type;
\`\`\`

### Step 5.2 — Clear REQUEST_ID and INTERFACE_STATUS

\`\`\`sql
-- Release lines locked under the failed request ID
-- These lines will be picked up by the next AutoInvoice submission
UPDATE ra_interface_lines_all
SET request_id       = NULL,
    interface_status = NULL
WHERE request_id = &failed_request_id;

COMMIT;

-- Verify the release
SELECT COUNT(*) AS still_locked
FROM ra_interface_lines_all
WHERE request_id = &failed_request_id;
-- Expected: 0
\`\`\`

### Step 5.3 — Clear Interface Error Records

Error records from the failed run should be removed to prevent confusion with errors from the resubmission:

\`\`\`sql
DELETE FROM ra_interface_errors_all
WHERE request_id = &failed_request_id;
COMMIT;

-- Also check RA_INTERFACE_DISTRIBUTIONS_ALL if the program uses distributions
SELECT COUNT(*) AS locked_distributions
FROM ra_interface_distributions_all
WHERE request_id = &failed_request_id;

UPDATE ra_interface_distributions_all
SET request_id = NULL
WHERE request_id = &failed_request_id;
COMMIT;
\`\`\`

### Step 5.4 — Verify No Remaining Locks on Interface Tables

\`\`\`sql
-- Confirm no residual locks on the AutoInvoice interface tables
SELECT l.sid, s.username, s.status, o.object_name, l.lmode, l.block
FROM v\$lock l
JOIN dba_objects o ON l.id1 = o.object_id
JOIN v\$session s ON l.sid = s.sid
WHERE o.object_name IN (
  'RA_INTERFACE_LINES_ALL',
  'RA_INTERFACE_ERRORS_ALL',
  'RA_INTERFACE_DISTRIBUTIONS_ALL'
)
  AND l.type = 'TM';
-- Expected: no rows (no sessions holding table locks)
\`\`\`

---

## Phase 6: Resubmission and Verification

### Step 6.1 — Resubmit AutoInvoice Import

Resubmit from the EBS UI with the same parameters as the original run:

**Navigation**: Receivables → Requests → Submit Request → AutoInvoice Import (RAXTRX)

Key parameters to verify match the original submission:
- Operating Unit / OU ID
- Invoice Class (Invoice, Credit Memo, Debit Memo)
- Batch Source
- Sales Date range
- Number of Parallel Workers (consider reducing temporarily if system is under stress)

### Step 6.2 — Monitor the Resubmission

\`\`\`sql
-- Watch the resubmitted request's progress (run every few minutes)
SELECT fcr.request_id,
       fcr.phase_code,
       fcr.status_code,
       ROUND((SYSDATE - fcr.actual_start_date) * 60, 1) AS minutes_running,
       vs.status  AS session_status,
       vs.last_call_et,
       vs.event
FROM fnd_concurrent_requests fcr
JOIN v\$process vp ON fcr.oracle_process_id = vp.spid
JOIN v\$session vs ON vp.addr = vs.paddr
WHERE fcr.request_id = &new_request_id;
\`\`\`

**Healthy running session signature**: STATUS = ACTIVE, LAST_CALL_ET < 60, EVENT showing database activity (db file sequential read, log file sync, direct path read, etc.)

### Step 6.3 — Verify Lines Are Being Processed

\`\`\`sql
-- Confirm the resubmitted request is claiming lines from the interface table
SELECT COUNT(*) AS lines_claimed_by_new_request
FROM ra_interface_lines_all
WHERE request_id = &new_request_id;

-- Monitor interface error count (rising errors indicate a data issue, not a zombie)
SELECT COUNT(*) AS current_errors
FROM ra_interface_errors_all
WHERE request_id = &new_request_id;
\`\`\`

---

## Monitoring Scripts

### Script 1: Real-Time Zombie Detector

Run continuously during month-end (every 15 minutes via crontab). Alerts when any concurrent session has been idle for more than one hour while the Concurrent Manager reports it as Running.

\`\`\`bash
#!/bin/bash
# zombie_request_monitor.sh
# Detect zombie concurrent requests during month-end processing.
# Schedule: */15 * * * * /opt/oracle/scripts/zombie_request_monitor.sh
#           (Activate via: crontab -e, comment out outside of month-end)

ORACLE_SID=EBSPRD
ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
PATH=\${ORACLE_HOME}/bin:\${PATH}
RECIPIENT="dba-team@example.com,ar-team@example.com"
ALERT_RECIPIENT="dba-oncall@example.com"
LOG=/var/log/zombie_request_monitor.log
IDLE_THRESHOLD=3600  # seconds — 1 hour

export ORACLE_SID ORACLE_HOME PATH

TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
HOST=\$(hostname -s)

ZOMBIES=\$(sqlplus -s / as sysdba << 'ENDSQL'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF VERIFY OFF LINESIZE 400
SELECT fcr.request_id || '|' ||
       SUBSTR(fcpt.user_concurrent_program_name, 1, 40) || '|' ||
       ROUND((SYSDATE - fcr.actual_start_date) * 60, 0) || '|' ||
       vs.sid || '|' || vs.serial# || '|' ||
       vp.spid || '|' ||
       vs.last_call_et || '|' ||
       ROUND(vs.last_call_et / 3600, 1) || '|' ||
       vs.event
FROM fnd_concurrent_requests fcr
JOIN fnd_concurrent_programs_tl fcpt
  ON fcr.concurrent_program_id = fcpt.concurrent_program_id AND fcpt.language = 'US'
JOIN v\$process vp ON fcr.oracle_process_id = vp.spid
JOIN v\$session vs ON vp.addr = vs.paddr
WHERE fcr.phase_code  = 'R'
  AND fcr.status_code = 'R'
  AND vs.status = 'INACTIVE'
  AND vs.last_call_et > 3600
ORDER BY vs.last_call_et DESC;
ENDSQL
)

if [ -z "\${ZOMBIES}" ]; then
  echo "[\${TIMESTAMP}] No zombie sessions detected" >> "\${LOG}"
  exit 0
fi

# Build alert
ZOMBIE_COUNT=0
ZOMBIE_DETAILS=""
while IFS='|' read -r req_id prog_name mins sid serial spid idle_sec idle_hrs event; do
  [ -z "\${req_id}" ] && continue
  ZOMBIE_COUNT=\$((ZOMBIE_COUNT + 1))
  ZOMBIE_DETAILS="\${ZOMBIE_DETAILS}
  Request ID  : \${req_id}
  Program     : \${prog_name}
  Running     : \${mins} minutes
  Session     : SID=\${sid} SERIAL#=\${serial}
  OS Process  : \${spid}
  Idle Time   : \${idle_hrs} hours (\${idle_sec} seconds)
  Wait Event  : \${event}
"
done <<< "\${ZOMBIES}"

echo "[\${TIMESTAMP}] ZOMBIE DETECTED: \${ZOMBIE_COUNT} idle session(s)" >> "\${LOG}"

SUBJECT="[\${ORACLE_SID}] ZOMBIE Concurrent Request Alert on \${HOST}: \${ZOMBIE_COUNT} idle session(s)"
BODY="Oracle EBS Zombie Concurrent Request Alert
Instance: \${ORACLE_SID} | Host: \${HOST} | \${TIMESTAMP}

\${ZOMBIE_COUNT} concurrent request(s) are in Running status but their database
sessions have been INACTIVE for over \$(( IDLE_THRESHOLD / 3600 )) hour(s).
These are zombie processes — no database work is occurring.

ZOMBIE SESSIONS:
\${ZOMBIE_DETAILS}

ACTION REQUIRED:
1. Verify zombie status: run the LAST_CALL_ET diagnostic query
2. Attempt front-end cancel in EBS Concurrent Requests form
3. If no response: ALTER SYSTEM KILL SESSION 'SID,SERIAL#' IMMEDIATE
4. Kill OS process: kill -9 <OS_PROCESS>
5. Clean interface tables before resubmission

Runbook: https://appsdba.vercel.app/blog/oracle-ebs-autoinvoice-zombie-request-runbook"

printf "From: oracle-monitor@%s\nTo: %s\nSubject: %s\n\n%s\n" \
  "\$(hostname -f)" "\${ALERT_RECIPIENT}" "\${SUBJECT}" "\${BODY}" \
  | /usr/sbin/sendmail -t -oi

echo "[\${TIMESTAMP}] Alert sent to \${ALERT_RECIPIENT}" >> "\${LOG}"
exit 2
\`\`\`

### Script 2: AutoInvoice Interface Table Health Check

Run before and after any AutoInvoice Import submission to verify the interface tables are in a clean state.

\`\`\`sql
-- autoinvoice_interface_health.sql
-- Run as APPS before submitting AutoInvoice Import during month-end

PROMPT ============================================================
PROMPT AutoInvoice Interface Table Health Check
PROMPT ============================================================

PROMPT
PROMPT -- Lines by status (NULL request_id = available for processing)
SELECT NVL(TO_CHAR(request_id), 'NULL (available)') AS request_id_status,
       NVL(interface_status, 'NULL') AS interface_status,
       COUNT(*) AS line_count
FROM ra_interface_lines_all
GROUP BY request_id, interface_status
ORDER BY request_id NULLS FIRST;

PROMPT
PROMPT -- Active requests claiming interface lines (should be only current run)
SELECT fcr.request_id,
       fcpt.user_concurrent_program_name AS program,
       fcr.phase_code,
       fcr.status_code,
       fcr.actual_start_date,
       COUNT(rail.rowid) AS lines_claimed
FROM fnd_concurrent_requests fcr
JOIN fnd_concurrent_programs_tl fcpt
  ON fcr.concurrent_program_id = fcpt.concurrent_program_id AND fcpt.language = 'US'
JOIN ra_interface_lines_all rail ON fcr.request_id = rail.request_id
WHERE fcr.phase_code IN ('R', 'P')
GROUP BY fcr.request_id, fcpt.user_concurrent_program_name,
         fcr.phase_code, fcr.status_code, fcr.actual_start_date
ORDER BY fcr.actual_start_date DESC;

PROMPT
PROMPT -- Completed/failed requests with lines still locked (orphans)
SELECT rail.request_id,
       fcr.phase_code,
       fcr.status_code,
       fcr.actual_completion_date,
       COUNT(*) AS orphaned_lines
FROM ra_interface_lines_all rail
JOIN fnd_concurrent_requests fcr ON rail.request_id = fcr.request_id
WHERE fcr.phase_code = 'C'
  AND fcr.status_code IN ('E', 'X', 'G')
GROUP BY rail.request_id, fcr.phase_code, fcr.status_code, fcr.actual_completion_date
ORDER BY fcr.actual_completion_date DESC;

PROMPT
PROMPT -- Interface errors by type (most recent 24 hours)
SELECT error_type, COUNT(*) AS error_count, MAX(creation_date) AS latest_error
FROM ra_interface_errors_all
WHERE creation_date >= SYSDATE - 1
GROUP BY error_type
ORDER BY error_count DESC;
\`\`\`

### Script 3: Session Activity Sampler (Distinguishes Working from Zombie)

Run this when a running request is suspected but not confirmed as a zombie. Samples I/O every 30 seconds over 3 minutes to establish whether the session is active.

\`\`\`bash
#!/bin/bash
# session_activity_sampler.sh
# Take 6 I/O samples 30 seconds apart for a specific SID.
# Usage: ./session_activity_sampler.sh <SID>

ORACLE_SID=EBSPRD
ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
PATH=\${ORACLE_HOME}/bin:\${PATH}
TARGET_SID=\$1

export ORACLE_SID ORACLE_HOME PATH

if [ -z "\${TARGET_SID}" ]; then
  echo "Usage: \$0 <SID>"
  exit 1
fi

echo "Sampling session SID=\${TARGET_SID} every 30 seconds (6 samples)..."
echo "$(printf '%s  %10s  %15s  %15s  %12s  %s' 'TIME' 'LAST_CALL_ET' 'PHYSICAL_READS' 'CONSISTENT_GETS' 'BLOCK_CHANGES' 'STATUS')"

for i in 1 2 3 4 5 6; do
  sqlplus -s / as sysdba << ENDSQL
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF VERIFY OFF LINESIZE 200
SELECT TO_CHAR(SYSDATE,'HH24:MI:SS') || '  ' ||
       LPAD(vs.last_call_et,12) || '  ' ||
       LPAD(vsio.physical_reads,15) || '  ' ||
       LPAD(vsio.consistent_gets,15) || '  ' ||
       LPAD(vsio.block_changes,12) || '  ' ||
       vs.status || '  ' || SUBSTR(vs.event,1,40)
FROM v\$session vs
JOIN v\$sess_io vsio ON vs.sid = vsio.sid
WHERE vs.sid = \${TARGET_SID};
ENDSQL
  [ \$i -lt 6 ] && sleep 30
done

echo ""
echo "Interpretation:"
echo "  PHYSICAL_READS / CONSISTENT_GETS not changing → ZOMBIE (no database work)"
echo "  Values increasing between samples → WORKING (genuine long-running query)"
echo "  LAST_CALL_ET > 3600 + INACTIVE + SQL*Net message from client → ZOMBIE"
\`\`\`

---

## Quick Reference

### Session Diagnostic Query

\`\`\`sql
SELECT fcr.request_id, vs.sid, vs.serial#, vp.spid,
       vs.status, vs.last_call_et, ROUND(vs.last_call_et/3600,2) AS idle_hrs, vs.event
FROM fnd_concurrent_requests fcr
JOIN v\$process vp ON fcr.oracle_process_id = vp.spid
JOIN v\$session vs ON vp.addr = vs.paddr
WHERE fcr.request_id = &request_id;
\`\`\`

### Termination Commands

\`\`\`sql
-- 1. Front-end cancel (EBS form first)
-- 2. Database session kill
ALTER SYSTEM KILL SESSION '&sid,&serial#' IMMEDIATE;

-- 3. Force request to Completed/Error if still stuck in R/R
UPDATE fnd_concurrent_requests
SET phase_code='C', status_code='E',
    actual_completion_date=SYSDATE,
    completion_text='Terminated by DBA — zombie session'
WHERE request_id=&request_id AND phase_code='R';
COMMIT;
\`\`\`

\`\`\`bash
# OS process kill (application tier)
kill -9 &spid
\`\`\`

### Interface Table Cleanup

\`\`\`sql
-- Clear orphaned lines from failed request
UPDATE ra_interface_lines_all
SET request_id=NULL, interface_status=NULL
WHERE request_id=&failed_request_id;
COMMIT;

DELETE FROM ra_interface_errors_all WHERE request_id=&failed_request_id;
COMMIT;

UPDATE ra_interface_distributions_all SET request_id=NULL WHERE request_id=&failed_request_id;
COMMIT;
\`\`\`

### Zombie Confirmation Criteria

\`\`\`
V$SESSION.STATUS       = INACTIVE
V$SESSION.LAST_CALL_ET > 3600 (1 hour minimum; >7200 for high confidence)
V$SESSION.EVENT        = 'SQL*Net message from client'
V$SESS_IO delta        = 0 across two 60-second samples (no I/O)
\`\`\`

---

## Summary

Zombie AutoInvoice concurrent requests — processes that the Concurrent Manager reports as Running but whose database sessions have been completely idle for hours — are diagnosed definitively using three columns in \`V$SESSION\`: \`STATUS = 'INACTIVE'\`, \`LAST_CALL_ET\` measured in hours, and \`EVENT = 'SQL*Net message from client'\`. Confirming zero I/O delta across two samples eliminates any residual doubt. The zombie may also hold table or row locks that are blocking the entire AutoInvoice queue behind it.

The termination sequence has three steps: front-end cancellation from the EBS Concurrent Requests form (always first — generates a clean status transition if the signal reaches the hung process), \`ALTER SYSTEM KILL SESSION 'sid,serial#' IMMEDIATE\` to release the database session, and \`kill -9 <spid>\` on the application tier to clean up the FNDLIBR process. If the \`FND_CONCURRENT_REQUESTS\` record remains in Running status after backend termination, a direct UPDATE to \`PHASE_CODE = 'C'\` and \`STATUS_CODE = 'E'\` completes the cleanup.

The interface table step — clearing \`REQUEST_ID\` and \`INTERFACE_STATUS\` to NULL in \`RA_INTERFACE_LINES_ALL\` for the failed request ID — is mandatory before resubmission. Without it, the next AutoInvoice Import run finds no eligible lines and completes with zero transactions processed, a silent failure that can delay month-end close by additional hours while the team investigates a second apparent failure.

The zombie detector monitoring script, running every 15 minutes during month-end, catches idle sessions before they accumulate into a multi-hour blockage — converting a potential 2 AM emergency into a routine alert that is investigated and resolved before the concurrent queue backs up.`,
};

async function main() {
  console.log('Inserting AutoInvoice zombie runbook...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: {
      title: post.title,
      excerpt: post.excerpt,
      content: post.content,
      category: post.category,
      published: post.published,
      isPremium: post.isPremium,
      publishedAt: post.publishedAt,
      youtubeUrl: post.youtubeUrl,
    },
  });
  console.log('Inserted:', JSON.stringify(post.title));
}

main().catch(console.error);
