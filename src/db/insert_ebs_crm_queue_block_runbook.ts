import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: EBS Concurrent Manager CRM Incompatibility Block — Diagnosis, Request Set Migration, and Queue Monitoring',
  slug: 'oracle-ebs-crm-incompatibility-queue-block-runbook',
  excerpt:
    'Step-by-step runbook for diagnosing and resolving Oracle EBS Conflict Resolution Manager incompatibility blocks during month-end close: distinguish PENDING from RUNNING via FND_CONCURRENT_REQUESTS, map the full incompatibility graph for affected programs, identify the real-time blocking chain, perform safe immediate relief, configure Request Sets for sequenced execution, audit and prune stale incompatibility rules, and a monitoring script that alerts on long-pending critical jobs before they derail the close window.',
  category: 'appsdba' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `## Scope

This runbook covers Oracle EBS concurrent program backlogs caused by Conflict Resolution Manager (CRM) incompatibility rules rather than database-layer performance problems. It applies to EBS 12.1.x and 12.2.x environments where month-end or period-close programs are stalling in PENDING state despite available manager worker slots.

**Phase 1 is [ACTIVE OUTAGE] triage. Phases 2–5 require DBA access to FND tables. Phases 6–7 require EBS System Administrator privileges and should be done outside a live close window.**

---

## Phase 1: Distinguish PENDING from RUNNING [ACTIVE OUTAGE]

The single most important step when a business user reports a slow job: verify whether it is actually executing.

### 1.1 Check phase and status for the affected programs

\`\`\`sql
-- Check current state of month-end programs
-- Common short names: PAXINPIR (Interface Invoices to Rec), RAXTRX (Autoinvoice Import)
SELECT fcr.request_id,
       fcr.concurrent_program_name,
       fcpt.user_concurrent_program_name,
       fcr.phase_code,
       fcr.status_code,
       fcr.requested_start_date,
       fcr.actual_start_date,
       fcr.actual_completion_date,
       ROUND((SYSDATE - fcr.requested_start_date) * 1440) AS mins_since_submit,
       ROUND((SYSDATE - fcr.actual_start_date) * 1440) AS mins_running,
       fcr.argument_text
FROM   fnd_concurrent_requests  fcr
JOIN   fnd_concurrent_programs_tl fcpt
       ON fcpt.concurrent_program_id = fcr.concurrent_program_id
      AND fcpt.application_id        = fcr.program_application_id
      AND fcpt.language              = 'US'
WHERE  fcr.phase_code IN ('P','R')
  AND  fcr.requested_start_date >= TRUNC(SYSDATE)
ORDER BY fcr.requested_start_date;
\`\`\`

**Interpret the result:**

| phase_code | status_code | actual_start_date | Meaning |
|------------|-------------|------------------|---------|
| P | I (Normal) | NULL | Waiting in queue — CRM or manager capacity block |
| P | Q (Standby) | NULL | On hold pending a scheduling condition |
| P | B (Blocked) | NULL | Explicitly blocked by an incompatibility check |
| R | R (Running) | Populated | Actually executing — investigate the database |
| R | W (Paused) | Populated | Running but waiting for a child request |

A job in \`phase_code = 'P'\` with \`actual_start_date IS NULL\` that has been waiting more than 10 minutes during a close window needs the CRM investigation below — not a database trace.

### 1.2 Quick check: are workers actually free?

\`\`\`sql
-- Standard Concurrent Manager capacity vs. active usage
SELECT fcq.concurrent_queue_name,
       fcq.max_processes            AS worker_slots,
       fcq.running_processes        AS active_workers,
       fcq.max_processes - fcq.running_processes AS free_slots,
       fcq.cache_size,
       fcq.sleep_seconds
FROM   fnd_concurrent_queues_vl fcq
WHERE  upper(fcq.concurrent_queue_name) LIKE '%STANDARD%'
   OR  upper(fcq.concurrent_queue_name) LIKE '%CONFLICT%'
ORDER BY fcq.concurrent_queue_name;
\`\`\`

If free slots > 10 but jobs are PENDING: the capacity is there. The CRM is holding them. Proceed to Phase 2.

If free slots = 0: capacity is the primary constraint. The CRM may be a secondary issue. Investigate both.

---

## Phase 2: Identify What Is Currently Blocking the Queue

### 2.1 Find the programs that are currently Running (the potential blockers)

\`\`\`sql
-- Currently running programs (potential incompatibility sources)
SELECT fcr.request_id,
       fcr.concurrent_program_name,
       fcpt.user_concurrent_program_name,
       fcr.actual_start_date,
       ROUND((SYSDATE - fcr.actual_start_date) * 60) AS mins_running,
       fcr.argument_text
FROM   fnd_concurrent_requests fcr
JOIN   fnd_concurrent_programs_tl fcpt
       ON fcpt.concurrent_program_id = fcr.concurrent_program_id
      AND fcpt.application_id        = fcr.program_application_id
      AND fcpt.language              = 'US'
WHERE  fcr.phase_code  = 'R'
  AND  fcr.status_code = 'R'
ORDER BY fcr.actual_start_date;
\`\`\`

### 2.2 Cross-reference running programs against the incompatibility table

\`\`\`sql
-- Which PENDING jobs are blocked by which RUNNING jobs?
SELECT
    pending.request_id                       AS pending_request_id,
    pending_prg.user_concurrent_program_name AS pending_program,
    pending.requested_start_date,
    ROUND((SYSDATE - pending.requested_start_date) * 1440) AS mins_waiting,
    running.request_id                       AS blocking_request_id,
    running_prg.user_concurrent_program_name AS blocking_program,
    running.actual_start_date,
    ROUND((SYSDATE - running.actual_start_date) * 60) AS blocker_mins_running,
    DECODE(fci.scope_code,'E','Exclusive','Set Check') AS scope
FROM   fnd_concurrent_requests pending
JOIN   fnd_concurrent_programs_tl pending_prg
       ON pending_prg.concurrent_program_id = pending.concurrent_program_id
      AND pending_prg.application_id        = pending.program_application_id
      AND pending_prg.language              = 'US'
-- Find the incompatibility rule that applies to this pending program
JOIN   fnd_concurrent_program_serial fci
       ON fci.to_run_concurrent_program_id = pending.concurrent_program_id
      AND fci.to_run_application_id        = pending.program_application_id
-- Find the running program that matches the other side of the rule
JOIN   fnd_concurrent_requests running
       ON running.concurrent_program_id = fci.running_concurrent_program_id
      AND running.program_application_id = fci.running_application_id
      AND running.phase_code  = 'R'
      AND running.status_code = 'R'
JOIN   fnd_concurrent_programs_tl running_prg
       ON running_prg.concurrent_program_id = running.concurrent_program_id
      AND running_prg.application_id        = running.program_application_id
      AND running_prg.language              = 'US'
WHERE  pending.phase_code = 'P'
ORDER BY mins_waiting DESC;
\`\`\`

This query produces the real-time blocking chain: for each PENDING job, it shows exactly which RUNNING job is preventing it from starting and why (the incompatibility rule).

---

## Phase 3: Map the Full Incompatibility Graph

Use this during and after an incident to understand the full scope of the incompatibility rules affecting the month-end programs.

### 3.1 All incompatibilities for month-end programs

\`\`\`sql
SELECT
    fcp.concurrent_program_name              AS short_name,
    fcpt.user_concurrent_program_name        AS program_name,
    fcip.concurrent_program_name             AS incompat_short_name,
    fcipt.user_concurrent_program_name       AS incompat_program_name,
    DECODE(fci.scope_code,'E','Exclusive','Set Check') AS scope,
    fcp.application_id                       AS prog_app_id,
    fcip.application_id                      AS incompat_app_id
FROM   apps.fnd_concurrent_programs     fcp
JOIN   apps.fnd_concurrent_programs_tl  fcpt
       ON  fcp.concurrent_program_id = fcpt.concurrent_program_id
      AND  fcp.application_id        = fcpt.application_id
      AND  fcpt.language             = 'US'
JOIN   apps.fnd_concurrent_program_serial fci
       ON  fcp.concurrent_program_id = fci.running_concurrent_program_id
      AND  fcp.application_id        = fci.running_application_id
JOIN   apps.fnd_concurrent_programs     fcip
       ON  fci.to_run_concurrent_program_id = fcip.concurrent_program_id
      AND  fci.to_run_application_id        = fcip.application_id
JOIN   apps.fnd_concurrent_programs_tl  fcipt
       ON  fcip.concurrent_program_id = fcipt.concurrent_program_id
      AND  fcip.application_id        = fcipt.application_id
      AND  fcipt.language             = 'US'
WHERE  (
    UPPER(fcpt.user_concurrent_program_name) LIKE '%AUTOINVOICE%'
    OR UPPER(fcpt.user_concurrent_program_name) LIKE '%INTERFACE INVOICES%'
    OR UPPER(fcpt.user_concurrent_program_name) LIKE '%TIEBACK INVOICES%'
    OR UPPER(fcpt.user_concurrent_program_name) LIKE '%DRAFT INVOICE%'
)
ORDER BY fcp.concurrent_program_name, fcip.concurrent_program_name;
\`\`\`

### 3.2 Find all programs that inherit Autoinvoice incompatibilities

This reveals regional/country programs that may be creating unexpected blocks:

\`\`\`sql
-- Find all programs incompatible with Autoinvoice (the hub blocker)
SELECT DISTINCT
    fcp.concurrent_program_name,
    fcpt.user_concurrent_program_name,
    fa.application_short_name
FROM   fnd_concurrent_programs     fcp
JOIN   fnd_concurrent_programs_tl  fcpt
       ON fcp.concurrent_program_id = fcpt.concurrent_program_id
      AND fcp.application_id        = fcpt.application_id
      AND fcpt.language             = 'US'
JOIN   fnd_application fa
       ON fa.application_id = fcp.application_id
WHERE  fcp.concurrent_program_id IN (
    SELECT fci.to_run_concurrent_program_id
    FROM   fnd_concurrent_program_serial fci
    JOIN   fnd_concurrent_programs fcp2
           ON fcp2.concurrent_program_id = fci.running_concurrent_program_id
          AND fcp2.application_id        = fci.running_application_id
    WHERE  UPPER(fcp2.concurrent_program_name) LIKE '%RAXTRX%'  -- Autoinvoice Import
)
   OR  fcp.concurrent_program_id IN (
    SELECT fci.running_concurrent_program_id
    FROM   fnd_concurrent_program_serial fci
    JOIN   fnd_concurrent_programs fcp2
           ON fcp2.concurrent_program_id = fci.to_run_concurrent_program_id
          AND fcp2.application_id        = fci.to_run_application_id
    WHERE  UPPER(fcp2.concurrent_program_name) LIKE '%RAXTRX%'
)
ORDER BY fcp.concurrent_program_name;
\`\`\`

Any program in this list that has unpredictable or long runtimes (regional variants, large-data variants) is a potential month-end blocker.

---

## Phase 4: Immediate Relief During an Active Close [ACTIVE OUTAGE]

### 4.1 Determine if the blocking job can safely be allowed to complete

Before any intervention, answer:
1. Is the blocking program actively making forward progress? (Check \`V\$SESSION\` for its database session)
2. What is its estimated completion time? (Ask the application team or check recent run history)
3. Can the blocked programs wait, or will missing the close window cause financial reporting failures?

\`\`\`sql
-- Find the database session for a specific concurrent request
SELECT s.sid,
       s.serial#,
       s.username,
       s.status,
       s.event,
       s.seconds_in_wait,
       s.sql_id,
       s.module,
       s.action,
       fcr.request_id
FROM   v\$session s
JOIN   fnd_concurrent_requests fcr
       ON fcr.oracle_session_id = s.audsid
WHERE  fcr.request_id = &blocking_request_id;
\`\`\`

If the blocking program is actively running (status = ACTIVE in V$SESSION, seconds_in_wait is low), the safest path is to let it complete.

### 4.2 Check historical runtime for the blocking program

\`\`\`sql
-- Historical runtime for the blocking program (last 30 days)
SELECT fcr.request_id,
       fcr.actual_start_date,
       fcr.actual_completion_date,
       ROUND((fcr.actual_completion_date - fcr.actual_start_date) * 60) AS runtime_mins,
       fcr.status_code,
       fcr.argument_text
FROM   fnd_concurrent_requests fcr
WHERE  fcr.concurrent_program_name = '&blocking_program_short_name'
  AND  fcr.phase_code = 'C'
  AND  fcr.actual_start_date >= SYSDATE - 30
ORDER BY fcr.actual_start_date DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

If the regional program normally runs 15 minutes but today has been running 3 hours, there may be a separate performance problem inside it. Investigate before waiting.

### 4.3 Place non-critical PENDING requests on hold to reduce queue pressure

If some PENDING jobs are lower priority and can be deferred:

Navigate to: System Administrator > Concurrent > Requests > View

Select the request → Actions → Hold

Or via SQL (confirm with application team first):

\`\`\`sql
-- Place a request on hold (prevents it from starting, does not affect already-running jobs)
BEGIN
  fnd_concurrent.hold_request(
    request_id => &request_id_to_hold
  );
  COMMIT;
END;
/
\`\`\`

---

## Phase 5: Verify Manager and CRM Are Functioning Correctly

### 5.1 Confirm the Conflict Resolution Manager is running

\`\`\`sql
SELECT concurrent_queue_name,
       max_processes,
       running_processes,
       worker_count,
       manager_type
FROM   fnd_concurrent_queues_vl
WHERE  manager_type = 'CRM'
   OR  upper(concurrent_queue_name) LIKE '%CONFLICT%';
\`\`\`

If the CRM shows \`running_processes = 0\`, it has stopped. The scheduler will not process incompatibility checks and all new submissions may remain in PENDING indefinitely.

Restart via: System Administrator > Concurrent > Manager > Administer > Activate the CRM row.

### 5.2 Confirm the Internal Concurrent Manager and Standard Manager are healthy

\`\`\`sql
SELECT concurrent_queue_name,
       max_processes            AS configured_workers,
       running_processes        AS active_workers,
       worker_count,
       sleep_seconds,
       cache_size
FROM   fnd_concurrent_queues_vl
WHERE  manager_type IN ('SFM','CRM','ICM')
   OR  upper(concurrent_queue_name) IN ('STANDARD','INTERNAL CONCURRENT MANAGER')
ORDER BY manager_type;
\`\`\`

### 5.3 Check for stale/orphaned running requests (ghost sessions)

A request stuck in phase_code = 'R' whose database session no longer exists is a ghost. It holds an incompatibility slot but is doing nothing. This can freeze the CRM queue indefinitely.

\`\`\`sql
-- Find requests marked as Running but with no live database session
SELECT fcr.request_id,
       fcpt.user_concurrent_program_name,
       fcr.actual_start_date,
       ROUND((SYSDATE - fcr.actual_start_date) * 60) AS mins_running,
       fcr.oracle_process_id,
       fcr.os_process_id
FROM   fnd_concurrent_requests fcr
JOIN   fnd_concurrent_programs_tl fcpt
       ON fcpt.concurrent_program_id = fcr.concurrent_program_id
      AND fcpt.application_id        = fcr.program_application_id
      AND fcpt.language              = 'US'
WHERE  fcr.phase_code  = 'R'
  AND  fcr.status_code = 'R'
  AND  fcr.oracle_session_id NOT IN (SELECT audsid FROM v\$session)
ORDER BY fcr.actual_start_date;
\`\`\`

If ghost requests exist, use the EBS Terminate option (Concurrent > Requests > View > Actions > Terminate) to clear them. Do not delete directly from FND tables without Oracle Support guidance.

---

## Phase 6: Long-Term Fix — Configure Request Sets for Sequenced Execution

The correct structural fix for regional programs that share incompatibilities with global programs is to place them in a **Request Set** that defines their execution order explicitly. When programs run inside a properly staged Request Set, they complete in order — the CRM incompatibility collision cannot occur because the next stage only starts after the previous one finishes.

### 6.1 Create the Request Set (EBS UI procedure)

Navigate to: System Administrator > Concurrent > Request > Set

1. Create a new Request Set named "Month-End Close — AR/PA Pipeline"
2. Add Stage 1 — Regional Programs:
   - GLO Poland Pay on Receipt Autoinvoice
   - GLO Brazil Pay on Receipt Autoinvoice
   - Set Stage Type: **All Complete** (all programs in Stage 1 must finish before Stage 2 starts)
3. Add Stage 2 — Global Interface Programs:
   - PRC: Interface Invoices to Receivables
   - GLO Draft Invoice Process
   - Set Stage Type: **All Complete**
4. Add Stage 3 — Downstream AR Programs:
   - Autoinvoice Import Program

### 6.2 Verify the Request Set definition

\`\`\`sql
-- Confirm the Request Set structure
SELECT rs.set_name,
       rs.user_set_name,
       rst.stage_name,
       rst.sequence,
       rst.complete_on_error,
       fcpt.user_concurrent_program_name,
       rsm.sequence AS prog_sequence_in_stage
FROM   fnd_request_sets        rs
JOIN   fnd_request_set_stages  rst ON rst.set_application_id = rs.application_id
                                   AND rst.request_set_id    = rs.request_set_id
JOIN   fnd_req_set_stage_members rsm ON rsm.request_set_id    = rst.request_set_id
                                    AND rsm.set_application_id = rst.set_application_id
                                    AND rsm.stage_id           = rst.stage_id
JOIN   fnd_concurrent_programs_tl fcpt
       ON fcpt.concurrent_program_id = rsm.concurrent_program_id
      AND fcpt.application_id        = rsm.program_application_id
      AND fcpt.language              = 'US'
WHERE  upper(rs.user_set_name) LIKE '%MONTH-END%'
ORDER BY rst.sequence, rsm.sequence;
\`\`\`

---

## Phase 7: Incompatibility Matrix Audit (Quarterly Maintenance)

Over time, incompatibility rules accumulate as programs are patched, cloned, or customized. A quarterly audit prevents the incompatibility graph from growing to the point where month-end close becomes unpredictable.

### 7.1 Full incompatibility inventory for financial programs

\`\`\`sql
-- All Exclusive incompatibilities across financial modules
SELECT
    fcpt.user_concurrent_program_name        AS program_name,
    fcipt.user_concurrent_program_name       AS incompatible_with,
    DECODE(fci.scope_code,'E','Exclusive','S','Set Check','?') AS scope,
    fci.running_application_id               AS app_id,
    fa_prog.application_short_name           AS app_name
FROM   fnd_concurrent_program_serial fci
JOIN   fnd_concurrent_programs     fcp
       ON fcp.concurrent_program_id = fci.running_concurrent_program_id
      AND fcp.application_id        = fci.running_application_id
JOIN   fnd_concurrent_programs_tl  fcpt
       ON fcpt.concurrent_program_id = fcp.concurrent_program_id
      AND fcpt.application_id        = fcp.application_id
      AND fcpt.language              = 'US'
JOIN   fnd_concurrent_programs     fcip
       ON fcip.concurrent_program_id = fci.to_run_concurrent_program_id
      AND fcip.application_id        = fci.to_run_application_id
JOIN   fnd_concurrent_programs_tl  fcipt
       ON fcipt.concurrent_program_id = fcip.concurrent_program_id
      AND fcipt.application_id        = fcip.application_id
      AND fcipt.language              = 'US'
JOIN   fnd_application fa_prog ON fa_prog.application_id = fci.running_application_id
WHERE  fci.scope_code = 'E'
  AND  fa_prog.application_short_name IN ('AR','PA','GL','AP','PO','FND')
ORDER BY fcpt.user_concurrent_program_name, fcipt.user_concurrent_program_name;
\`\`\`

For each Exclusive incompatibility pair, verify:
1. Are both programs still actively used?
2. Do they actually touch the same tables in conflicting ways? (Review program source or Oracle documentation)
3. If both are standard Oracle programs, check MetaLink/MOS for whether the incompatibility was removed in a later PSU

---

## Monitoring Script: crm_queue_monitor.sh

\`\`\`bash
#!/bin/bash
# crm_queue_monitor.sh
# Monitors EBS Concurrent Manager for long-pending jobs and CRM incompatibility blocks
# Cron: */5 * * * * /home/applmgr/scripts/crm_queue_monitor.sh >> /home/applmgr/logs/crm_queue_monitor.log 2>&1

set -euo pipefail

SCRIPT_NAME="crm_queue_monitor"
LOG_DATE=$(date '+%Y-%m-%d %H:%M:%S')
ALERT=0

ORACLE_USER=\${ORACLE_USER:-apps}
ORACLE_PASS=\${ORACLE_PASS:-apps}
ORACLE_SID=\${ORACLE_SID:-EBSPRD}
ALERT_EMAIL=\${ALERT_EMAIL:-dba-alerts@example.com}

PENDING_WARN_MINS=30          # Warn if a critical program has been PENDING this long
PENDING_ALERT_MINS=90         # Alert if a critical program has been PENDING this long
GHOST_RUNNING_MINS=480        # Alert if a Running request has no live DB session after this many mins
CRM_WORKER_MIN=1              # Alert if CRM active workers drop below this

export ORACLE_SID
export PATH=\${ORACLE_HOME:-/u01/app/oracle/product/12.2.0/dbhome_1}/bin:\${PATH}

log() { echo "[$LOG_DATE][$SCRIPT_NAME] $1"; }

send_alert() {
  local subject="$1" body="$2"
  log "ALERT: $subject"
  echo "$body" | mail -s "[$ORACLE_SID] ALERT: $subject" "$ALERT_EMAIL" 2>/dev/null || true
}

run_sql() {
  sqlplus -s "$ORACLE_USER/$ORACLE_PASS@$ORACLE_SID" <<SQL
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMOUT ON TRIMSPOOL ON
$1
EXIT;
SQL
}

# --- Check 1: Long-PENDING critical month-end programs ---
log "=== Check 1: Long-pending critical programs ==="

LONG_PENDING=$(run_sql "
SELECT request_id || ' ' || concurrent_program_name || ' pending_mins=' ||
       ROUND((SYSDATE - requested_start_date)*1440)
FROM fnd_concurrent_requests
WHERE phase_code = 'P'
  AND actual_start_date IS NULL
  AND ROUND((SYSDATE - requested_start_date)*1440) > $PENDING_WARN_MINS
  AND (
    upper(concurrent_program_name) LIKE '%PAXINPIR%'
    OR upper(concurrent_program_name) LIKE '%RAXTRX%'
    OR upper(concurrent_program_name) LIKE '%ARXTWAIT%'
  )
ORDER BY requested_start_date;
" | sed '/^$/d')

ALERT_PENDING=$(run_sql "
SELECT COUNT(*) FROM fnd_concurrent_requests
WHERE phase_code = 'P'
  AND actual_start_date IS NULL
  AND ROUND((SYSDATE - requested_start_date)*1440) > $PENDING_ALERT_MINS
  AND (
    upper(concurrent_program_name) LIKE '%PAXINPIR%'
    OR upper(concurrent_program_name) LIKE '%RAXTRX%'
    OR upper(concurrent_program_name) LIKE '%ARXTWAIT%'
  );
" | tr -d ' ')

log "Long-pending critical jobs: \${LONG_PENDING:-none}"
if [ -n "$LONG_PENDING" ]; then
  if [ "$ALERT_PENDING" -gt 0 ]; then
    ALERT=1
    send_alert "CRITICAL: month-end program PENDING >\${PENDING_ALERT_MINS} mins" \
      "Critical month-end program(s) have been PENDING for over \${PENDING_ALERT_MINS} minutes.
These jobs have NOT started — this is a CRM incompatibility block, not a database issue.

Stalled jobs:
$LONG_PENDING

Run Phase 2 of the CRM queue runbook to identify the blocking program."
  else
    log "WARNING: critical program pending >\${PENDING_WARN_MINS} min — monitoring"
  fi
fi

# --- Check 2: Active blocking chain (running programs vs pending programs) ---
log "=== Check 2: Active CRM blocking chain ==="

BLOCKING_CHAIN=$(run_sql "
SELECT pending.request_id || ' [' || pending_prg.user_concurrent_program_name ||
       '] blocked_by request ' || running.request_id ||
       ' [' || running_prg.user_concurrent_program_name || ']'
FROM fnd_concurrent_requests pending
JOIN fnd_concurrent_programs_tl pending_prg
     ON pending_prg.concurrent_program_id = pending.concurrent_program_id
    AND pending_prg.application_id        = pending.program_application_id
    AND pending_prg.language              = 'US'
JOIN fnd_concurrent_program_serial fci
     ON fci.to_run_concurrent_program_id = pending.concurrent_program_id
    AND fci.to_run_application_id        = pending.program_application_id
JOIN fnd_concurrent_requests running
     ON running.concurrent_program_id = fci.running_concurrent_program_id
    AND running.program_application_id = fci.running_application_id
    AND running.phase_code  = 'R'
    AND running.status_code = 'R'
JOIN fnd_concurrent_programs_tl running_prg
     ON running_prg.concurrent_program_id = running.concurrent_program_id
    AND running_prg.application_id        = running.program_application_id
    AND running_prg.language              = 'US'
WHERE pending.phase_code = 'P'
  AND ROUND((SYSDATE - pending.requested_start_date)*1440) > $PENDING_WARN_MINS
ORDER BY pending.requested_start_date;
" | sed '/^$/d')

log "Blocking chain: \${BLOCKING_CHAIN:-none}"
if [ -n "$BLOCKING_CHAIN" ]; then
  ALERT=1
  send_alert "CRM incompatibility block detected" \
    "Active CRM blocking chain found:
$BLOCKING_CHAIN

The PENDING job(s) cannot start because the listed RUNNING program is incompatible.
Check if the blocking program is making forward progress or is itself stalled."
fi

# --- Check 3: CRM manager active workers ---
log "=== Check 3: CRM manager status ==="

CRM_WORKERS=$(run_sql "
SELECT NVL(MAX(running_processes),0)
FROM fnd_concurrent_queues_vl
WHERE manager_type='CRM' OR upper(concurrent_queue_name) LIKE '%CONFLICT%';
" | tr -d ' ')

log "CRM active workers: $CRM_WORKERS (min required: $CRM_WORKER_MIN)"
if [ "$CRM_WORKERS" -lt "$CRM_WORKER_MIN" ]; then
  ALERT=1
  send_alert "CRM manager is DOWN ($CRM_WORKERS workers)" \
    "The Conflict Resolution Manager has $CRM_WORKERS active workers.
All new concurrent requests will remain PENDING indefinitely until CRM is restarted.

Navigate to: System Administrator > Concurrent > Manager > Administer
Activate the Conflict Resolution Manager."
fi

# --- Check 4: Ghost running requests (no live DB session) ---
log "=== Check 4: Ghost running requests ==="

GHOST_COUNT=$(run_sql "
SELECT COUNT(*)
FROM fnd_concurrent_requests fcr
WHERE fcr.phase_code  = 'R'
  AND fcr.status_code = 'R'
  AND ROUND((SYSDATE - fcr.actual_start_date)*60) > $GHOST_RUNNING_MINS
  AND fcr.oracle_session_id NOT IN (SELECT audsid FROM v\$session);
" | tr -d ' ')

log "Ghost running requests: $GHOST_COUNT"
if [ "$GHOST_COUNT" -gt 0 ]; then
  ALERT=1
  GHOST_DETAIL=$(run_sql "
SELECT request_id || ' ' || concurrent_program_name ||
       ' running_since=' || TO_CHAR(actual_start_date,'DD-MON HH24:MI')
FROM fnd_concurrent_requests
WHERE phase_code  = 'R'
  AND status_code = 'R'
  AND ROUND((SYSDATE - actual_start_date)*60) > $GHOST_RUNNING_MINS
  AND oracle_session_id NOT IN (SELECT audsid FROM v\$session)
ORDER BY actual_start_date;
")
  send_alert "Ghost running requests: $GHOST_COUNT" \
    "There are $GHOST_COUNT request(s) marked as Running with no live database session.
These are holding incompatibility slots and blocking the CRM queue.

$GHOST_DETAIL

Use Concurrent > Requests > View > Actions > Terminate to clear these requests.
Do NOT delete from FND tables directly."
fi

# --- Check 5: Standard Manager capacity ---
log "=== Check 5: Standard Manager worker capacity ==="

FREE_WORKERS=$(run_sql "
SELECT NVL(MAX(max_processes - running_processes), 0)
FROM fnd_concurrent_queues_vl
WHERE upper(concurrent_queue_name) = 'STANDARD';
" | tr -d ' ')

log "Standard Manager free workers: $FREE_WORKERS"
if [ "$FREE_WORKERS" -eq 0 ]; then
  ALERT=1
  send_alert "Standard Manager at capacity (0 free workers)" \
    "The Standard Concurrent Manager has no free worker slots.
Capacity saturation combined with CRM blocks will cause severe PENDING backlogs.

Check v\$session for long-running concurrent sessions:
SELECT s.sid, s.serial#, s.username, s.sql_id, s.seconds_in_wait
FROM v\$session s WHERE s.module LIKE 'FNDCPGSC%' ORDER BY s.seconds_in_wait DESC;"
fi

# --- Summary ---
log "=== Summary ==="
log "Long-pending: \${ALERT_PENDING:-0} | Blocking chain: \${BLOCKING_CHAIN:+yes}\${BLOCKING_CHAIN:-none} | CRM workers: $CRM_WORKERS | Ghosts: $GHOST_COUNT | SCM free: $FREE_WORKERS"
[ "$ALERT" -eq 0 ] && log "STATUS: OK" || log "STATUS: ALERT SENT"
\`\`\`

### Deploy and schedule

\`\`\`bash
mkdir -p /home/applmgr/scripts /home/applmgr/logs
cp crm_queue_monitor.sh /home/applmgr/scripts/
chmod 750 /home/applmgr/scripts/crm_queue_monitor.sh

# Source EBS environment before Oracle calls
# Add to top of script after shebang: source /u01/app/ebsprd/EBSapps.env run

(crontab -l 2>/dev/null; echo "*/5 * * * * /home/applmgr/scripts/crm_queue_monitor.sh >> /home/applmgr/logs/crm_queue_monitor.log 2>&1") | crontab -
\`\`\`

---

## Quick Reference

| Symptom | Phase |
|---------|-------|
| Job "slow" — unsure if PENDING or RUNNING | Phase 1.1 — check phase_code |
| Workers free but jobs stuck PENDING | Phase 1.2 + Phase 2 |
| Need to see what is blocking what right now | Phase 2.2 |
| Map full incompatibility graph | Phase 3 |
| Job has been running 8+ hours, may be a ghost | Phase 5.3 |
| CRM manager shows 0 workers | Phase 5.1 — restart CRM |
| Immediate relief during live close window | Phase 4 |
| Prevent recurrence with sequenced execution | Phase 6 — Request Sets |
| Quarterly hygiene on incompatibility rules | Phase 7 |

---

## FND Table Reference

| Table | Purpose |
|-------|---------|
| \`FND_CONCURRENT_REQUESTS\` | All request submissions — phase_code and status_code are the primary diagnostic columns |
| \`FND_CONCURRENT_PROGRAM_SERIAL\` | Incompatibility definitions — running_concurrent_program_id vs. to_run_concurrent_program_id |
| \`FND_CONCURRENT_QUEUES_VL\` | Manager definitions including capacity, active workers, and manager type |
| \`FND_REQUEST_SETS\` | Request Set header definitions |
| \`FND_REQUEST_SET_STAGES\` | Stage definitions within a Request Set |
| \`FND_REQ_SET_STAGE_MEMBERS\` | Programs within each stage |`,
};

async function main() {
  console.log('Inserting EBS CRM queue block runbook...');
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
