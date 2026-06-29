import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS Concurrent Manager Runbook: Operations, Diagnostics, and Recovery',
  slug: 'oracle-ebs-concurrent-manager-runbook',
  excerpt:
    'Complete operational runbook for the Oracle EBS Concurrent Manager covering start, stop, and status commands via adcmctl.sh; the cmclean.sh stale process cleanup sequence required after abnormal termination; SQL diagnostics for pending/no-manager/stuck-running requests; OPP recovery; incompatibility rule investigation; dedicated manager tuning; and three monitoring scripts — a queue health dashboard, a stuck-running request alerter, and an error-rate trend report — for daily DBA operations in Oracle EBS 12.2 environments.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-29'),
  youtubeUrl: null,
  content: `## Introduction

This runbook covers day-to-day operations and incident response for the Oracle EBS Concurrent Manager in EBS 12.2 environments. It is organized into phases that match the most common operational scenarios: normal lifecycle management (start, stop, status), post-crash cleanup when the manager terminates abnormally, diagnosing specific request failures, OPP recovery, and incompatibility investigation.

**Environment assumptions**: Oracle EBS 12.2, Oracle 19c database, application tier running on Oracle Linux. All shell commands run as the \`applmgr\` (or \`oracle\`) OS user on the application tier. SQL commands run as \`APPS\` or \`SYS\`.

---

## Phase 1: Normal Lifecycle Management

### Step 1.1 — Check Current Status

\`\`\`bash
# As applmgr on the application tier node
# Source the EBS environment
source /u01/app/oracle/apps/fs1/EBSapps/appl/APPS<SID>_<hostname>.env

# Check Concurrent Manager status
cd $ADMIN_SCRIPTS_HOME
./adcmctl.sh status apps/<apps_password>
\`\`\`

Expected healthy output:

\`\`\`
Concurrent manager process is running
Internal Concurrent Manager
  Process Id         : 24311
  Status             : Active
  Manager Name       : Internal Concurrent Manager

Standard Manager
  Status             : Active
  Running/Max Procs  : 5/10

Output Post Processor
  Status             : Active
  Running/Max Procs  : 1/1
\`\`\`

Check from the database side (can be run from any connected session):

\`\`\`sql
-- Manager status from the database perspective
SELECT fcq.concurrent_queue_name,
       fcq.max_processes,
       fcq.running_processes,
       fcq.enabled_flag,
       DECODE(fcq.running_processes, 0, 'DOWN', 'RUNNING') AS status
FROM fnd_concurrent_queues fcq
WHERE fcq.application_id = 0
ORDER BY fcq.concurrent_queue_name;
\`\`\`

### Step 1.2 — Start the Concurrent Manager

\`\`\`bash
cd $ADMIN_SCRIPTS_HOME
./adcmctl.sh start apps/<apps_password>
\`\`\`

The start sequence:
1. FNDSM (Service Manager) starts first
2. ICM starts and registers in the database
3. ICM reads manager definitions from \`FND_CONCURRENT_QUEUES\`
4. ICM spawns the Standard Manager, OPP, and CRM processes
5. Each manager spawns its configured worker processes

Allow 60–90 seconds for all managers to reach Active status before verifying:

\`\`\`bash
# Wait 90 seconds then verify
sleep 90
./adcmctl.sh status apps/<apps_password>
\`\`\`

### Step 1.3 — Stop the Concurrent Manager

**Normal stop** (waits for running requests to complete):

\`\`\`bash
cd $ADMIN_SCRIPTS_HOME
./adcmctl.sh stop apps/<apps_password>
\`\`\`

**Abort stop** (immediate — in-flight requests are terminated):

\`\`\`bash
./adcmctl.sh abort apps/<apps_password>
\`\`\`

**Verify all processes are stopped before proceeding with patching or maintenance**:

\`\`\`bash
# No FNDLIBR or FNDSM processes should remain
ps aux | grep -iE "(fndlibr|fndsm|fndopp)" | grep -v grep
# Expected: no output
\`\`\`

\`\`\`sql
-- Confirm no active manager processes in the database
SELECT COUNT(*) AS active_processes
FROM fnd_concurrent_processes
WHERE process_status_code = 'A';
-- Expected: 0
\`\`\`

### Step 1.4 — Bounce (Stop + Start)

When bouncing the Concurrent Manager for a configuration change (worker count, new manager, schedule update), always allow the stop to complete fully before starting:

\`\`\`bash
cd $ADMIN_SCRIPTS_HOME
./adcmctl.sh stop apps/<apps_password>

# Verify stopped
sleep 60
ps aux | grep -iE "(fndlibr|fndsm)" | grep -v grep

# Start
./adcmctl.sh start apps/<apps_password>
sleep 90
./adcmctl.sh status apps/<apps_password>
\`\`\`

---

## Phase 2: Recovery After Abnormal Termination

When the Concurrent Manager crashes (ICM killed by OOM killer, database connection lost, OS crash followed by restart), the \`FND_CONCURRENT_PROCESSES\` table retains rows with \`PROCESS_STATUS_CODE = 'A'\` for processes that no longer exist. These stale records prevent a clean restart.

### Step 2.1 — Confirm the Manager Is Not Running

\`\`\`bash
# If any FNDLIBR processes remain, stop them before cleanup
ps aux | grep -iE "fndlibr|fndsm|fndopp" | grep -v grep
# Kill any zombie processes if found:
# kill -9 <pid>
\`\`\`

### Step 2.2 — Run cmclean.sh (Stale Process Cleanup)

\`\`\`bash
# cmclean.sh clears stale FND_CONCURRENT_PROCESSES records
# and resets FND_CONCURRENT_REQUESTS stuck in Running status
cd $FND_TOP/bin
./cmclean.sh

# Enter the APPS password when prompted
# The script will report the number of processes and requests cleaned
\`\`\`

Alternatively, perform the cleanup manually from SQL (if cmclean.sh is unavailable):

\`\`\`sql
-- Manual cleanup of stale manager processes
-- Step 1: Mark stale Active processes as Terminated
UPDATE fnd_concurrent_processes
SET process_status_code = 'K'  -- K = Terminated
WHERE process_status_code = 'A'
  AND last_update_date < SYSDATE - 1/24  -- older than 1 hour
  AND os_process_id NOT IN (
    -- Exclude PIDs that are genuinely still running (cross-reference not possible in SQL)
    -- Provide the list of live PIDs from 'ps aux | grep fndlibr'
    SELECT -1 FROM DUAL  -- placeholder; replace with actual live PIDs if known
  );

-- Step 2: Reset Requests stuck in Running status (no active manager process)
UPDATE fnd_concurrent_requests fcr
SET    phase_code  = 'P',
       status_code = 'N',
       actual_start_date = NULL,
       controlling_manager = NULL
WHERE  fcr.phase_code  = 'R'
  AND  fcr.status_code = 'R'
  AND  NOT EXISTS (
    SELECT 1 FROM fnd_concurrent_processes fcp
    WHERE fcp.concurrent_process_id = fcr.controlling_manager
      AND fcp.process_status_code = 'A'
  );

COMMIT;
\`\`\`

### Step 2.3 — Restart After Cleanup

\`\`\`bash
cd $ADMIN_SCRIPTS_HOME
./adcmctl.sh start apps/<apps_password>
sleep 90
./adcmctl.sh status apps/<apps_password>
\`\`\`

### Step 2.4 — Verify Reset Requests Were Requeued

\`\`\`sql
-- Confirm previously stuck requests are now Pending/Normal and eligible for pickup
SELECT request_id, phase_code, status_code, actual_start_date
FROM fnd_concurrent_requests
WHERE phase_code = 'P'
  AND status_code = 'N'
  AND requested_start_date <= SYSDATE
ORDER BY priority, requested_start_date;
\`\`\`

---

## Phase 3: Diagnosing Request Failures

### Step 3.1 — Identify Pending Requests and Their Status

\`\`\`sql
-- Current request queue snapshot
SELECT fcr.request_id,
       fcpt.user_concurrent_program_name AS program_name,
       fcr.phase_code,
       fcr.status_code,
       DECODE(fcr.phase_code || '/' || fcr.status_code,
              'P/N','Pending-Normal',
              'P/B','Pending-Standby (incompatibility)',
              'P/M','Pending-No Manager',
              'P/H','Pending-On Hold',
              'P/S','Pending-Scheduled',
              'R/R','Running',
              'C/N','Completed-Normal',
              'C/E','Completed-Error',
              'C/G','Completed-Warning',
              fcr.phase_code || '/' || fcr.status_code) AS human_status,
       fcr.requested_start_date,
       fcr.actual_start_date,
       ROUND((SYSDATE - NVL(fcr.actual_start_date, fcr.requested_start_date)) * 60, 1) AS minutes_waiting,
       fcr.priority,
       fu.user_name AS submitted_by
FROM fnd_concurrent_requests fcr
JOIN fnd_concurrent_programs_tl fcpt
  ON fcr.concurrent_program_id = fcpt.concurrent_program_id
 AND fcpt.language = 'US'
JOIN fnd_user fu ON fcr.requested_by = fu.user_id
WHERE fcr.phase_code IN ('P','R')
ORDER BY fcr.phase_code, minutes_waiting DESC;
\`\`\`

### Step 3.2 — Diagnose "No Manager" (P/M) Requests

\`\`\`sql
-- Find which application owns the stuck program
SELECT fcr.request_id,
       fa.application_short_name AS app_code,
       fcpt.user_concurrent_program_name AS program_name,
       fcr.status_code
FROM fnd_concurrent_requests fcr
JOIN fnd_concurrent_programs fcp
  ON fcr.concurrent_program_id = fcp.concurrent_program_id
JOIN fnd_application fa ON fcp.application_id = fa.application_id
JOIN fnd_concurrent_programs_tl fcpt
  ON fcp.concurrent_program_id = fcpt.concurrent_program_id
 AND fcpt.language = 'US'
WHERE fcr.phase_code = 'P'
  AND fcr.status_code = 'M';

-- Find which managers are supposed to handle this application
SELECT fcq.concurrent_queue_name,
       fcq.running_processes,
       fcq.max_processes,
       fcq.enabled_flag
FROM fnd_concurrent_queues fcq
JOIN fnd_concurrent_queue_content fcqc
  ON fcq.concurrent_queue_id   = fcqc.concurrent_queue_id
 AND fcq.application_id        = fcqc.queue_application_id
WHERE fcqc.type_application_id = (
  SELECT application_id FROM fnd_application WHERE application_short_name = '&app_short_name'
)
  AND fcqc.include_flag = 'I';  -- I=Include, E=Exclude
\`\`\`

**Resolution options**:
1. If no manager includes the application: add it to the Standard Manager's work shift specialization rules via the EBS Administer Concurrent Managers form
2. If the correct manager exists but has 0 running processes: restart that manager

### Step 3.3 — Diagnose Standby (P/B) Requests — Incompatibility Blockage

\`\`\`sql
-- Find what is blocking a specific standby request
-- First, find what the blocked request is incompatible with
SELECT fcpi.concurrent_program_id     AS blocked_program_id,
       p1.user_concurrent_program_name AS blocked_program,
       fcpi.to_run_concurrent_program_id AS blocking_program_id,
       p2.user_concurrent_program_name   AS blocking_program,
       fcpi.running_type
FROM fnd_concurrent_program_incompatibilities fcpi
JOIN fnd_concurrent_programs_tl p1
  ON fcpi.concurrent_program_id = p1.concurrent_program_id AND p1.language = 'US'
JOIN fnd_concurrent_programs_tl p2
  ON fcpi.to_run_concurrent_program_id = p2.concurrent_program_id AND p2.language = 'US'
WHERE fcpi.concurrent_program_id = (
  SELECT concurrent_program_id FROM fnd_concurrent_requests WHERE request_id = &standby_request_id
);

-- Check if the blocking program is currently running
SELECT fcr.request_id, p.user_concurrent_program_name, fcr.actual_start_date,
       ROUND((SYSDATE - fcr.actual_start_date) * 60, 1) AS minutes_running
FROM fnd_concurrent_requests fcr
JOIN fnd_concurrent_programs_tl p
  ON fcr.concurrent_program_id = p.concurrent_program_id AND p.language = 'US'
WHERE fcr.phase_code = 'R'
  AND fcr.concurrent_program_id IN (
    SELECT to_run_concurrent_program_id
    FROM fnd_concurrent_program_incompatibilities
    WHERE concurrent_program_id = (
      SELECT concurrent_program_id FROM fnd_concurrent_requests WHERE request_id = &standby_request_id
    )
  );
\`\`\`

### Step 3.4 — Identify and Clear Stuck Running Requests

\`\`\`sql
-- Requests in Running status with no corresponding active OS process
-- (Requires cross-referencing with OS process list)
SELECT fcr.request_id,
       fcpt.user_concurrent_program_name AS program_name,
       fcr.actual_start_date,
       ROUND((SYSDATE - fcr.actual_start_date) * 24, 2) AS hours_running,
       fcp.os_process_id,
       fcp.process_status_code,
       fcr.logfile_name
FROM fnd_concurrent_requests fcr
JOIN fnd_concurrent_processes fcp
  ON fcr.controlling_manager = fcp.concurrent_process_id
JOIN fnd_concurrent_programs_tl fcpt
  ON fcr.concurrent_program_id = fcpt.concurrent_program_id
 AND fcpt.language = 'US'
WHERE fcr.phase_code  = 'R'
  AND fcr.status_code = 'R'
  AND fcr.actual_start_date < SYSDATE - 2/24  -- running > 2 hours
ORDER BY hours_running DESC;
\`\`\`

After confirming via \`ps aux | grep <os_process_id>\` that the OS process is gone, terminate the stuck request from EBS (System Administrator → Requests → View → find request → Terminate) or directly:

\`\`\`sql
-- Terminate a stuck request (after confirming OS process is gone)
-- Use the EBS form first; use SQL only if form termination fails
UPDATE fnd_concurrent_requests
SET    phase_code   = 'C',
       status_code  = 'X',
       actual_completion_date = SYSDATE,
       completion_text = 'Terminated by DBA — OS process not found'
WHERE  request_id  = &stuck_request_id
  AND  phase_code  = 'R'
  AND  status_code = 'R';
COMMIT;
\`\`\`

---

## Phase 4: OPP (Output Post Processor) Recovery

### Step 4.1 — Confirm OPP Is Down

\`\`\`bash
ps aux | grep -i fndopp | grep -v grep
# No output = OPP not running
\`\`\`

\`\`\`sql
-- Check OPP process status in the database
SELECT fcp.os_process_id,
       fcp.process_status_code,
       fcp.last_update_date,
       fcp.logfile_name
FROM fnd_concurrent_processes fcp
JOIN fnd_concurrent_queues fcq
  ON fcp.concurrent_queue_id = fcq.concurrent_queue_id
WHERE UPPER(fcq.concurrent_queue_name) = 'FNDOPP';
\`\`\`

### Step 4.2 — Check OPP Log for Root Cause

\`\`\`bash
# OPP log is typically in the CM log directory
ls -lt $APPLCSF/$APPLLOG/FNDOPP*.mgr 2>/dev/null | head -5
tail -200 $APPLCSF/$APPLLOG/FNDOPP.mgr

# Common causes in the log:
# - java.lang.OutOfMemoryError → OPP JVM heap exhausted
# - ORA-01017 → database password issue
# - java.net.ConnectException → cannot connect to database
\`\`\`

### Step 4.3 — Restart OPP

The OPP restarts automatically when the Concurrent Manager is restarted via \`adcmctl.sh\`. If the CM is already running but OPP is down, restart the OPP service specifically:

From the EBS System Administrator responsibility:
\`\`\`
Navigate: Concurrent → Manager → Administer
Find: Output Post Processor
Click: Start
\`\`\`

Or restart the full Concurrent Manager:

\`\`\`bash
cd $ADMIN_SCRIPTS_HOME
./adcmctl.sh stop apps/<apps_password>
sleep 60
./adcmctl.sh start apps/<apps_password>
\`\`\`

### Step 4.4 — Reprocess Failed OPP Requests

Requests that completed with Warning due to OPP failure can be reprocessed:

\`\`\`sql
-- Find requests that failed OPP post-processing in the last 24 hours
SELECT fcr.request_id,
       fcpt.user_concurrent_program_name AS program_name,
       fcr.actual_completion_date,
       fcr.completion_text
FROM fnd_concurrent_requests fcr
JOIN fnd_concurrent_programs_tl fcpt
  ON fcr.concurrent_program_id = fcpt.concurrent_program_id
 AND fcpt.language = 'US'
WHERE fcr.phase_code  = 'C'
  AND fcr.status_code = 'G'
  AND fcr.actual_completion_date >= SYSDATE - 1
  AND fcr.completion_text LIKE '%post-processing%'
ORDER BY fcr.actual_completion_date DESC;
\`\`\`

Re-run the original request, or use the Republish option from the View Concurrent Request form to re-trigger post-processing for requests that already have output files.

---

## Phase 5: Manager Configuration and Tuning

### Step 5.1 — View Current Manager Configuration

\`\`\`sql
-- Full manager configuration
SELECT fcq.concurrent_queue_name,
       fcqt.user_concurrent_queue_name,
       fcq.max_processes,
       fcq.running_processes,
       fcq.cache_size,
       fcq.enabled_flag,
       fcq.sleep_seconds
FROM fnd_concurrent_queues fcq
JOIN fnd_concurrent_queues_tl fcqt
  ON fcq.concurrent_queue_id    = fcqt.concurrent_queue_id
 AND fcq.application_id         = fcqt.application_id
WHERE fcqt.language = 'US'
  AND fcq.application_id = 0
ORDER BY fcq.concurrent_queue_name;
\`\`\`

### Step 5.2 — Adjust Worker Count for Standard Manager

From EBS (recommended — takes effect on next ICM wake cycle without restart):
\`\`\`
System Administrator → Concurrent → Manager → Define
Select: Standard Manager
Work Shifts tab: update Processes for the relevant shift
\`\`\`

The change takes effect within 1–2 minutes as ICM reads the updated configuration.

To verify the change was applied:

\`\`\`sql
SELECT fcq.concurrent_queue_name, fcq.max_processes, fcq.running_processes
FROM fnd_concurrent_queues fcq
WHERE UPPER(fcq.concurrent_queue_name) = 'STANDARD';
\`\`\`

### Step 5.3 — Create a Dedicated Manager for a High-Volume Program

\`\`\`sql
-- Example: create a dedicated manager for Payroll via the API
-- (In practice, use the EBS Define Concurrent Manager form)

-- Step 1: Insert the new queue definition
INSERT INTO fnd_concurrent_queues (
  concurrent_queue_id, application_id, concurrent_queue_name,
  max_processes, running_processes, cache_size, sleep_seconds,
  enabled_flag, manager_type, work_assignment,
  created_by, creation_date, last_updated_by, last_update_date, last_update_login
)
VALUES (
  fnd_concurrent_queues_s.NEXTVAL, 0, 'PAYROLL_MANAGER',
  4, 0, 10, 15,
  'Y', 'C', 'N',
  -1, SYSDATE, -1, SYSDATE, -1
);

-- Step 2: Add the translated name
INSERT INTO fnd_concurrent_queues_tl (
  concurrent_queue_id, application_id, language, source_lang,
  user_concurrent_queue_name,
  created_by, creation_date, last_updated_by, last_update_date, last_update_login
)
VALUES (
  (SELECT MAX(concurrent_queue_id) FROM fnd_concurrent_queues WHERE concurrent_queue_name = 'PAYROLL_MANAGER'),
  0, 'US', 'US',
  'Payroll Manager',
  -1, SYSDATE, -1, SYSDATE, -1
);

COMMIT;
-- Then configure the work shift and specialization rules via the EBS form
\`\`\`

### Step 5.4 — Check and Tune the ICM Cache Size

The ICM \`CACHE_SIZE\` controls how many pending requests it pre-loads per query cycle. For environments with > 100 requests pending at peak times, increase from the default of 1:

\`\`\`sql
-- Check current ICM cache size
SELECT fcq.concurrent_queue_name, fcq.cache_size
FROM fnd_concurrent_queues fcq
WHERE UPPER(fcq.concurrent_queue_name) = 'INTERNAL';

-- Increase cache size for busy environments
-- Do this via the EBS Define Concurrent Manager form for ICM
-- Or directly (restart required):
UPDATE fnd_concurrent_queues
SET cache_size = 20
WHERE UPPER(concurrent_queue_name) = 'INTERNAL';
COMMIT;
\`\`\`

---

## Phase 6: Submitting and Managing Requests via Command Line

### Step 6.1 — Submit a Request from the OS Shell

For automation and testing, the \`CONCSUB\` utility submits concurrent requests without requiring a Forms session:

\`\`\`bash
# CONCSUB syntax:
# CONCSUB <APPS_USER>/<APPS_PASS> <RESP_APP> <RESP_NAME> <USER_NAME> WAIT=Y \
#   CONCURRENT <PROGRAM_APP> <PROGRAM_NAME> [parameters...]

# Example: submit Purge Concurrent Request and Manager Data
CONCSUB apps/<apps_password> SYSADMIN 'System Administrator' SYSADMIN WAIT=N \
  CONCURRENT FND FNDCPPUR \
  1 'Y' '' '' '' 'Y' 0

# Example: submit Apply Autoinvoice for OU=101
CONCSUB apps/<apps_password> AR 'Receivables Manager' SYSADMIN WAIT=N \
  CONCURRENT AR RAXTRX \
  101
\`\`\`

### Step 6.2 — Cancel a Running Request from SQL

\`\`\`sql
-- Cancel (request continues to completion but is flagged for cancellation)
UPDATE fnd_concurrent_requests
SET status_code = 'X'
WHERE request_id = &request_id
  AND phase_code = 'R';
COMMIT;

-- Cancel all pending requests for a specific program (use with caution)
UPDATE fnd_concurrent_requests
SET status_code = 'D',
    phase_code  = 'C',
    actual_completion_date = SYSDATE,
    completion_text = 'Cancelled by DBA'
WHERE phase_code = 'P'
  AND concurrent_program_id = (
    SELECT concurrent_program_id FROM fnd_concurrent_programs
    WHERE concurrent_program_name = '&program_name'
      AND application_id = (SELECT application_id FROM fnd_application WHERE application_short_name = '&app_short_name')
  );
COMMIT;
\`\`\`

---

## Monitoring Scripts

### Script 1: Concurrent Manager Queue Health Dashboard

Runs every 15 minutes and emails the DBA team if any alert threshold is breached.

\`\`\`bash
#!/bin/bash
# cm_health_monitor.sh
# Monitor Concurrent Manager queue health and manager process status.
# Schedule: */15 * * * * /opt/oracle/scripts/cm_health_monitor.sh

ORACLE_SID=EBSPRD
ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
PATH=\${ORACLE_HOME}/bin:\${PATH}
RECIPIENT="dba-team@example.com"
LOG=/var/log/cm_health_monitor.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
HOST=\$(hostname -s)

export ORACLE_SID ORACLE_HOME PATH

# Thresholds
PENDING_WARN=50      # alert if > 50 pending requests
PENDING_CRIT=200
NO_MANAGER_WARN=1    # alert on any P/M request
STUCK_HOURS=4        # alert if any request running > 4 hours

RESULT=\$(sqlplus -s / as sysdba << 'ENDSQL'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF VERIFY OFF LINESIZE 300
SELECT
  SUM(CASE WHEN phase_code='P' AND status_code='N' THEN 1 ELSE 0 END) || '|' ||
  SUM(CASE WHEN phase_code='P' AND status_code='M' THEN 1 ELSE 0 END) || '|' ||
  SUM(CASE WHEN phase_code='P' AND status_code='B' THEN 1 ELSE 0 END) || '|' ||
  SUM(CASE WHEN phase_code='R' THEN 1 ELSE 0 END) || '|' ||
  SUM(CASE WHEN phase_code='C' AND status_code='E'
            AND actual_completion_date >= SYSDATE - 1/24 THEN 1 ELSE 0 END) || '|' ||
  SUM(CASE WHEN phase_code='R' AND actual_start_date < SYSDATE - 4/24 THEN 1 ELSE 0 END)
FROM fnd_concurrent_requests;
ENDSQL
)

IFS='|' read -r pending no_manager standby running errors_1h stuck <<< "\${RESULT}"
pending=\$(echo "\${pending}" | tr -d ' ')
no_manager=\$(echo "\${no_manager}" | tr -d ' ')
standby=\$(echo "\${standby}" | tr -d ' ')
running=\$(echo "\${running}" | tr -d ' ')
errors_1h=\$(echo "\${errors_1h}" | tr -d ' ')
stuck=\$(echo "\${stuck}" | tr -d ' ')

# Manager process status
MGR_STATUS=\$(sqlplus -s / as sysdba << 'ENDSQL'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF VERIFY OFF LINESIZE 200
SELECT fcq.concurrent_queue_name || '|' || fcq.running_processes || '/' || fcq.max_processes
FROM fnd_concurrent_queues fcq
WHERE fcq.application_id = 0
  AND fcq.enabled_flag = 'Y'
ORDER BY fcq.concurrent_queue_name;
ENDSQL
)

ALERTS=""
EXIT_CODE=0

[ "\${pending}" -ge "\${PENDING_CRIT}" ] && \
  ALERTS="\${ALERTS}\n  CRITICAL: \${pending} pending requests (threshold \${PENDING_CRIT})" && EXIT_CODE=2
[ "\${pending}" -ge "\${PENDING_WARN}" ] && [ "\${EXIT_CODE}" -lt 2 ] && \
  ALERTS="\${ALERTS}\n  WARNING: \${pending} pending requests (threshold \${PENDING_WARN})" && EXIT_CODE=1
[ "\${no_manager}" -ge "\${NO_MANAGER_WARN}" ] && \
  ALERTS="\${ALERTS}\n  CRITICAL: \${no_manager} requests in No Manager status" && EXIT_CODE=2
[ "\${stuck}" -gt 0 ] && \
  ALERTS="\${ALERTS}\n  WARNING: \${stuck} request(s) running > \${STUCK_HOURS} hours" && \
  { [ "\${EXIT_CODE}" -lt 2 ] && EXIT_CODE=1; }

echo "[\${TIMESTAMP}] pending=\${pending} no_manager=\${no_manager} standby=\${standby} running=\${running} errors_1h=\${errors_1h} stuck=\${stuck}" >> "\${LOG}"

if [ -n "\${ALERTS}" ]; then
  SUBJECT="[\${ORACLE_SID}] Concurrent Manager Alert on \${HOST}"
  BODY="Oracle EBS Concurrent Manager Health Alert
Instance: \${ORACLE_SID} | Host: \${HOST} | \${TIMESTAMP}

ALERTS:
\$(printf '%b' "\${ALERTS}")

QUEUE SNAPSHOT:
  Pending/Normal   : \${pending}
  Pending/No Mgr   : \${no_manager}
  Pending/Standby  : \${standby}
  Currently Running: \${running}
  Errors (last 1h) : \${errors_1h}
  Stuck Running    : \${stuck}

MANAGER STATUS:
\$(echo "\${MGR_STATUS}" | awk -F'|' '{printf "  %-35s %s\n", \$1, \$2}')

Runbook: https://appsdba.vercel.app/blog/oracle-ebs-concurrent-manager-runbook"

  printf "From: oracle-monitor@%s\nTo: %s\nSubject: %s\n\n%s\n" \
    "\$(hostname -f)" "\${RECIPIENT}" "\${SUBJECT}" "\${BODY}" \
    | /usr/sbin/sendmail -t -oi

  echo "[\${TIMESTAMP}] Alert sent: EXIT_CODE=\${EXIT_CODE}" >> "\${LOG}"
fi
exit "\${EXIT_CODE}"
\`\`\`

### Script 2: Daily Error Rate Report

Identifies programs with the highest error rates and longest average run times over the past 24 hours — the foundation for weekly tuning reviews.

\`\`\`sql
-- cm_daily_error_report.sql
-- Run as APPS daily to identify problem programs

SET LINESIZE 140 PAGESIZE 50
COLUMN program_name FORMAT A45
COLUMN total FORMAT 9999
COLUMN errors FORMAT 9999
COLUMN warnings FORMAT 9999
COLUMN error_pct FORMAT 999.9
COLUMN avg_minutes FORMAT 9999.9
COLUMN max_minutes FORMAT 9999.9

SELECT
  fcpt.user_concurrent_program_name AS program_name,
  COUNT(*)                          AS total,
  SUM(CASE WHEN fcr.status_code = 'E' THEN 1 ELSE 0 END) AS errors,
  SUM(CASE WHEN fcr.status_code = 'G' THEN 1 ELSE 0 END) AS warnings,
  ROUND(SUM(CASE WHEN fcr.status_code = 'E' THEN 1 ELSE 0 END) /
        NULLIF(COUNT(*),0) * 100, 1) AS error_pct,
  ROUND(AVG((fcr.actual_completion_date - fcr.actual_start_date) * 24 * 60), 1) AS avg_minutes,
  ROUND(MAX((fcr.actual_completion_date - fcr.actual_start_date) * 24 * 60), 1) AS max_minutes
FROM fnd_concurrent_requests fcr
JOIN fnd_concurrent_programs_tl fcpt
  ON fcr.concurrent_program_id = fcpt.concurrent_program_id
 AND fcpt.language = 'US'
WHERE fcr.phase_code = 'C'
  AND fcr.actual_completion_date >= SYSDATE - 1
  AND fcr.actual_start_date IS NOT NULL
GROUP BY fcpt.user_concurrent_program_name
HAVING COUNT(*) >= 3  -- at least 3 runs to be meaningful
ORDER BY error_pct DESC, total DESC
FETCH FIRST 25 ROWS ONLY;
\`\`\`

### Script 3: Stuck Request Detector and Auto-Reporter

Runs every 30 minutes and reports requests that have been in Running status longer than expected for their program type.

\`\`\`sql
-- stuck_request_report.sql
-- Identify requests running significantly longer than their historical average

SELECT fcr.request_id,
       fcpt.user_concurrent_program_name AS program_name,
       fcr.actual_start_date,
       ROUND((SYSDATE - fcr.actual_start_date) * 60, 1) AS minutes_running,
       fcp.os_process_id,
       fu.user_name AS submitted_by,
       fcr.argument_text,
       -- Historical average runtime for this program
       (SELECT ROUND(AVG((r2.actual_completion_date - r2.actual_start_date) * 60), 1)
        FROM fnd_concurrent_requests r2
        WHERE r2.concurrent_program_id = fcr.concurrent_program_id
          AND r2.phase_code = 'C'
          AND r2.status_code = 'N'
          AND r2.actual_completion_date >= SYSDATE - 30) AS avg_runtime_minutes,
       fcr.logfile_name
FROM fnd_concurrent_requests fcr
JOIN fnd_concurrent_programs_tl fcpt
  ON fcr.concurrent_program_id = fcpt.concurrent_program_id
 AND fcpt.language = 'US'
JOIN fnd_concurrent_processes fcp
  ON fcr.controlling_manager = fcp.concurrent_process_id
JOIN fnd_user fu
  ON fcr.requested_by = fu.user_id
WHERE fcr.phase_code  = 'R'
  AND fcr.status_code = 'R'
  AND fcr.actual_start_date < SYSDATE - 2/24  -- running > 2 hours
ORDER BY minutes_running DESC;
\`\`\`

---

## Quick Reference

### adcmctl.sh Commands

\`\`\`bash
# Source EBS environment first
source $APPL_TOP/APPS<SID>_<host>.env

cd $ADMIN_SCRIPTS_HOME

# Status
./adcmctl.sh status   apps/<password>

# Start
./adcmctl.sh start    apps/<password>

# Normal stop (wait for running requests)
./adcmctl.sh stop     apps/<password>

# Abort stop (immediate)
./adcmctl.sh abort    apps/<password>

# Stale process cleanup (after crash)
cd $FND_TOP/bin
./cmclean.sh
\`\`\`

### Key Diagnostic Queries

\`\`\`sql
-- Queue snapshot
SELECT phase_code, status_code, COUNT(*) AS cnt
FROM fnd_concurrent_requests WHERE phase_code IN ('P','R')
GROUP BY phase_code, status_code ORDER BY 1,2;

-- Manager status
SELECT concurrent_queue_name, running_processes, max_processes, enabled_flag
FROM fnd_concurrent_queues WHERE application_id = 0 ORDER BY 1;

-- Running > 2 hours
SELECT fcr.request_id, fcpt.user_concurrent_program_name,
       ROUND((SYSDATE-fcr.actual_start_date)*60,1) AS minutes,
       fcp.os_process_id
FROM fnd_concurrent_requests fcr
JOIN fnd_concurrent_programs_tl fcpt ON fcr.concurrent_program_id=fcpt.concurrent_program_id AND fcpt.language='US'
JOIN fnd_concurrent_processes fcp ON fcr.controlling_manager=fcp.concurrent_process_id
WHERE fcr.phase_code='R' AND fcr.actual_start_date < SYSDATE-2/24;

-- Errors last hour
SELECT fcpt.user_concurrent_program_name, fcr.request_id, fcr.completion_text
FROM fnd_concurrent_requests fcr
JOIN fnd_concurrent_programs_tl fcpt ON fcr.concurrent_program_id=fcpt.concurrent_program_id AND fcpt.language='US'
WHERE fcr.phase_code='C' AND fcr.status_code='E'
  AND fcr.actual_completion_date >= SYSDATE-1/24
ORDER BY fcr.actual_completion_date DESC;
\`\`\`

### Phase/Status Code Cheat Sheet

\`\`\`
P/N  Pending Normal         — waiting for a free worker
P/S  Pending Scheduled      — has a future start time
P/B  Pending Standby        — blocked by incompatibility rule
P/M  Pending No Manager     — no manager assigned to run this program
P/H  Pending On Hold        — manually held
R/R  Running                — currently executing
R/T  Running Terminating    — stop requested, waiting for completion
C/N  Completed Normal       — success
C/E  Completed Error        — program returned error
C/G  Completed Warning      — completed but OPP or partial failure
C/X  Completed Terminated   — killed
C/D  Completed Cancelled    — cancelled before running
\`\`\`

---

## Summary

The Oracle EBS Concurrent Manager is a multi-process framework whose operational health directly determines whether batch processing, period-end work, and scheduled reporting continue uninterrupted. Normal lifecycle management centers on three commands: \`adcmctl.sh start\`, \`adcmctl.sh stop\`, and \`adcmctl.sh status\`. After any abnormal termination, \`cmclean.sh\` must run before restart to clear stale \`FND_CONCURRENT_PROCESSES\` records — skipping this step leaves orphaned rows that prevent the ICM from registering new processes correctly.

Diagnosing request failures follows a precise path driven by the \`PHASE_CODE\` and \`STATUS_CODE\` columns in \`FND_CONCURRENT_REQUESTS\`: Pending/No Manager indicates a missing manager assignment; Pending/Standby indicates an incompatibility rule is blocking the request; stuck Running requests indicate a zombie OS process whose database record was not cleaned up. Each state has a specific diagnostic query and a bounded resolution path that does not require a full Concurrent Manager restart.

OPP failures cause requests to complete with Warning status rather than Error — the data processing succeeded, but formatted output was not generated. OPP recovers automatically when the Concurrent Manager is restarted, and affected requests can be reprocessed via the Republish function.

The three monitoring scripts — the 15-minute queue health monitor, the daily error rate report, and the stuck request detector — provide continuous operational awareness without requiring manual log review. The queue health monitor alerts at configurable thresholds for pending request backlog, No Manager requests, and long-running stuck processes; the daily error rate report surfaces programs with degrading reliability that warrant investigation before they become incidents.`,
};

async function main() {
  console.log('Inserting Concurrent Manager runbook...');
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
