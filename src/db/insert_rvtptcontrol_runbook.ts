import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle EBS rvtptcontrol Failed — Interface Diagnosis, Lock Chain Resolution, and RVCTP Recovery',
  slug: 'oracle-ebs-rvtptcontrol-failed-receiving-runbook',
  excerpt:
    'Step-by-step runbook for resolving rvtptcontrol failures in Oracle EBS 12.1.3: interface table triage from RCV_TRANSACTIONS_INTERFACE and PO_INTERFACE_ERRORS, enabling debug profiles, mapping WebLogic thread dumps to V$SESSION CLIENT_IDENTIFIER, diagnosing blocking lock chains, archiving and clearing stale interface rows, restarting the RVCTP manager, and a monitoring script that watches ERROR row accumulation, lock waits on RCV tables, and WebLogic stuck thread counts.',
  category: 'appsdba' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `## Scope

This runbook covers an Oracle EBS 12.1.3 production issue where transactions submitted through Receiving or the Inspection workbench fail with "rvtptcontrol failed" and stop all downstream processing for the affected plant. It is written for an Apps DBA responding to an active outage.

**Time-sensitive phases are marked [ACTIVE OUTAGE]. Others can be deferred to a maintenance window.**

---

## Phase 1: Initial Triage — Interface Table Status [ACTIVE OUTAGE]

Before touching anything, get a complete picture of the interface table state. This tells you how many rows are failing, in which plants, and for which transaction types.

### 1.1 Overall interface status breakdown

\`\`\`sql
-- Connect to the EBS database as APPS or DBA user
sqlplus apps/apps@EBSPRD

-- Interface row counts by status and transaction type
SELECT process_status,
       transaction_type,
       COUNT(*)                             AS row_count,
       MIN(creation_date)                   AS oldest_row,
       MAX(last_update_date)                AS most_recent_activity
FROM   rcv_transactions_interface
GROUP BY process_status, transaction_type
ORDER BY process_status, transaction_type;
\`\`\`

| process_status | Meaning |
|---------------|---------|
| \`1\` | Ready for processing |
| \`3\` | Error — rvtptcontrol rejected this row |
| \`5\` | Pending — waiting for parent to complete |
| \`7\` | Frozen — held by AutoCreate |

Status 3 rows are your immediate target. Any rows stuck at status 1 for more than 10 minutes without progressing indicate RVCTP is not picking them up.

### 1.2 Read the actual error messages

\`\`\`sql
-- Most recent errors by source document
SELECT pie.interface_transaction_id,
       pie.column_name,
       pie.error_message,
       rti.shipment_header_id,
       rti.po_header_id,
       rti.item_id,
       rti.org_id,
       rti.transaction_type,
       rti.quantity,
       rti.unit_of_measure,
       rti.creation_date
FROM   po_interface_errors  pie
JOIN   rcv_transactions_interface rti
       ON rti.interface_transaction_id = pie.interface_transaction_id
WHERE  rti.processing_status_code IN ('ERROR','PENDING')
ORDER BY pie.creation_date DESC
FETCH FIRST 50 ROWS ONLY;
\`\`\`

Group the error messages. Most production outages are caused by one or two distinct error types affecting hundreds of rows.

### 1.3 Identify affected organizations and purchasing documents

\`\`\`sql
SELECT rti.org_id,
       hou.name                             AS org_name,
       rti.po_header_id,
       rti.transaction_type,
       COUNT(*)                             AS failing_rows,
       LISTAGG(DISTINCT pie.error_message, '; ')
         WITHIN GROUP (ORDER BY pie.error_message) AS distinct_errors
FROM   rcv_transactions_interface rti
JOIN   po_interface_errors pie
       ON pie.interface_transaction_id = rti.interface_transaction_id
JOIN   hr_organization_units hou
       ON hou.organization_id = rti.org_id
WHERE  rti.processing_status_code = 'ERROR'
GROUP BY rti.org_id, hou.name, rti.po_header_id, rti.transaction_type
ORDER BY failing_rows DESC;
\`\`\`

---

## Phase 2: Root Cause Diagnosis by Error Type

### 2.1 UOM mismatch

If \`PO_INTERFACE_ERRORS.error_message\` contains "unit of measure" or "UOM":

\`\`\`sql
-- Compare UOM on the interface row vs. the purchase order line
SELECT rti.interface_transaction_id,
       rti.unit_of_measure          AS interface_uom,
       pol.unit_meas_lookup_code    AS po_uom,
       msi.primary_uom_code         AS item_primary_uom,
       rti.item_id,
       rti.quantity
FROM   rcv_transactions_interface rti
JOIN   po_lines_all pol
       ON pol.po_line_id = rti.po_line_id
JOIN   mtl_system_items_b msi
       ON msi.inventory_item_id = rti.item_id
      AND msi.organization_id   = rti.to_organization_id
WHERE  rti.processing_status_code = 'ERROR'
  AND  rti.unit_of_measure != pol.unit_meas_lookup_code;
\`\`\`

**Fix:** Correct the UOM conversion definition in INV > Setup > Units of Measure > Conversions, or correct the interface row's \`unit_of_measure\` column if the source system sent the wrong value.

### 2.2 Closed accounting period

\`\`\`sql
-- Check whether the period for the transaction date is closed
SELECT gl.period_name,
       gl.status,
       gl.start_date,
       gl.end_date
FROM   rcv_transactions_interface rti
JOIN   gl_periods gl
       ON TRUNC(rti.transaction_date) BETWEEN gl.start_date AND gl.end_date
      AND gl.period_type = 'Month'
      AND gl.application_id = 200
WHERE  rti.processing_status_code = 'ERROR'
  AND  gl.status NOT IN ('O','F')   -- Not Open or Future
FETCH FIRST 10 ROWS ONLY;
\`\`\`

**Fix:** Open the period in General Ledger (or set to Future-Enterable if appropriate). Do not change the transaction date on bulk interface rows without understanding the downstream accounting impact.

### 2.3 Sequence exhaustion (ORA-08004)

\`\`\`sql
-- Sequences consumed by Receiving
SELECT sequence_name,
       last_number,
       increment_by,
       max_value,
       ROUND((max_value - last_number) / increment_by) AS remaining_values
FROM   all_sequences
WHERE  sequence_owner = 'RCV'
ORDER BY remaining_values ASC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

If \`remaining_values\` is zero or negative, the sequence has wrapped or exhausted. Contact Oracle Support — sequence reset in EBS requires a patched procedure to avoid downstream key conflicts.

### 2.4 Custom triggers blocking inserts

\`\`\`sql
-- Custom triggers on key Receiving tables
SELECT owner, trigger_name, trigger_type, triggering_event, status
FROM   all_triggers
WHERE  table_name IN ('RCV_TRANSACTIONS_INTERFACE',
                      'RCV_TRANSACTIONS',
                      'RCV_SHIPMENT_HEADERS',
                      'RCV_SHIPMENT_LINES')
  AND  owner != 'SYS'
  AND  status = 'ENABLED'
ORDER BY table_name, trigger_name;
\`\`\`

If any BEFORE INSERT triggers exist, check their code for hard-coded validations or lookups against tables that may have changed post-upgrade or post-clone.

---

## Phase 3: Enable Debug Logging for rvtptcontrol

If the error messages in \`PO_INTERFACE_ERRORS\` are insufficient, enable debug profiles to get the C-level trace from rvtptcontrol itself.

**Warning:** These profiles increase I/O significantly. Enable only while actively debugging and disable immediately after collecting the logs.

### 3.1 Set profiles via SQL (faster than EBS UI)

\`\`\`sql
-- Switch RVCTP processing mode to Online to see per-transaction errors immediately
-- (Online mode processes synchronously; Immediate and Batch defer)
BEGIN
  fnd_profile.save(
    x_name              => 'RCV_PROCESSING_MODE',
    x_value             => 'ONLINE',
    x_level_name        => 'SITE',
    x_level_value       => NULL,
    x_level_value_app   => NULL,
    x_responsibility_id => NULL,
    x_application_id    => NULL
  );
  COMMIT;
END;
/

-- Enable INV debug trace (this feeds the rvtptcontrol debug output)
BEGIN
  fnd_profile.save('INV_DEBUG_TRACE', 'Y', 'SITE', NULL, NULL, NULL, NULL);
  COMMIT;
END;
/

-- Set debug level (1-11; use 11 for maximum detail, 1 for entry/exit only)
BEGIN
  fnd_profile.save('INV_DEBUG_LEVEL', '11', 'SITE', NULL, NULL, NULL, NULL);
  COMMIT;
END;
/
\`\`\`

### 3.2 Locate debug output files

After reproducing the failure with one test transaction:

\`\`\`bash
# Debug output goes to the concurrent log directory or $APPLCSF/log
ls -lrt $APPLCSF/log/*.trc | tail -20

# Search for rvtptcontrol output specifically
find $APPLCSF/log -name "*.trc" -newer /tmp/debug_start_marker -type f 2>/dev/null | \
  xargs grep -l "rvtptcontrol" 2>/dev/null | head -5

# Or check the concurrent request output file for the RVCTP manager
ls -lrt $APPLCSF/log/RVCTP*.log 2>/dev/null | tail -5
\`\`\`

### 3.3 Disable debug profiles after collecting output

\`\`\`sql
BEGIN
  fnd_profile.save('INV_DEBUG_TRACE', 'N', 'SITE', NULL, NULL, NULL, NULL);
  fnd_profile.save('INV_DEBUG_LEVEL', '1', 'SITE', NULL, NULL, NULL, NULL);
  -- Restore processing mode to Immediate for normal operations
  fnd_profile.save('RCV_PROCESSING_MODE', 'IMMEDIATE', 'SITE', NULL, NULL, NULL, NULL);
  COMMIT;
END;
/
\`\`\`

---

## Phase 4: WebLogic Thread Dump — Mapping Hung Threads to Database Sessions

If RVCTP or the Receiving workbench is hanging (not erroring immediately), a WebLogic thread dump reveals which JVM thread is stuck and the database session it corresponds to.

### 4.1 Collect a WebLogic thread dump

\`\`\`bash
# As applmgr — identify the OAF/Forms managed server process
ps aux | grep java | grep oa_managed_server

# Collect three thread dumps 30 seconds apart (captures in-progress vs. stuck)
MSERVER_PID=$(ps aux | grep java | grep oa_managed_server | awk '{print $2}' | head -1)
echo "Managed server PID: $MSERVER_PID"

kill -3 $MSERVER_PID; echo "--- DUMP 1 $(date) ---"
sleep 30
kill -3 $MSERVER_PID; echo "--- DUMP 2 $(date) ---"
sleep 30
kill -3 $MSERVER_PID; echo "--- DUMP 3 $(date) ---"
\`\`\`

Thread dump output goes to the managed server's stdout/console log:

\`\`\`bash
# Typical path under $LOG_HOME or $DOMAIN_HOME
find $DOMAIN_HOME -name "*.out" -newer /tmp/debug_start_marker 2>/dev/null | head -3
# Often: $DOMAIN_HOME/servers/oa_managed_server1/logs/oa_managed_server1.out
\`\`\`

### 4.2 Extract CLIENT_IDENTIFIER from thread dump

In the thread dump output, search for the stuck thread:

\`\`\`
"ExecuteThread: '12' for queue: 'weblogic.kernel.Default'" daemon prio=10 tid=0x00007f2b1c0a4000 nid=0x2a7f waiting on condition [0x00007f2b0f3fd000]
   java.lang.Thread.State: WAITING (on object monitor)
        ...
        at oracle.apps.fnd.framework.webui.OAPageBean.processRequest(OAPageBean.java:2150)
\`\`\`

The CLIENT_IDENTIFIER Oracle sets in the database session follows the pattern:
\`\`\`
<USERNAME>/<FND_SESSION_ID>/<ICID>
\`\`\`

Search the dump for this pattern:

\`\`\`bash
grep -A 5 -B 5 "CLIENT_ID\|clientId\|oracle.jdbc" $DOMAIN_HOME/servers/oa_managed_server1/logs/oa_managed_server1.out | \
  grep -v "^--$" | tail -100
\`\`\`

### 4.3 Match thread to V$SESSION

\`\`\`sql
-- Find the database session corresponding to the stuck WebLogic thread
-- CLIENT_IDENTIFIER format: <APPS_USERNAME>/<ICX_SESSION_ID>/<ICID>
SELECT s.sid,
       s.serial#,
       s.username,
       s.status,
       s.wait_class,
       s.event,
       s.seconds_in_wait,
       s.blocking_session,
       s.client_identifier,
       s.module,
       s.action,
       s.sql_id,
       s.machine
FROM   v\$session s
WHERE  s.client_identifier LIKE '%<USERNAME_FROM_THREAD_DUMP>%'
  AND  s.username = 'APPS';

-- Or match by module/action which EBS sets during Receiving transactions
SELECT s.sid,
       s.serial#,
       s.status,
       s.event,
       s.seconds_in_wait,
       s.blocking_session,
       s.client_identifier,
       s.module,
       s.action
FROM   v\$session s
WHERE  (s.module LIKE '%RCV%' OR s.module LIKE '%RVCTP%' OR s.action LIKE '%Receive%')
  AND  s.status IN ('ACTIVE','INACTIVE')
ORDER BY s.seconds_in_wait DESC NULLS LAST;
\`\`\`

---

## Phase 5: Lock Chain Diagnosis and Resolution [ACTIVE OUTAGE]

If sessions are waiting on locks (event = "enq: TM - contention" or "enq: TX - row lock contention"), trace the full blocking chain.

### 5.1 Identify all sessions blocked on RCV tables

\`\`\`sql
-- Sessions waiting on RCV-related objects
SELECT s.sid,
       s.serial#,
       s.username,
       s.status,
       s.event,
       s.seconds_in_wait,
       s.blocking_session,
       s.blocking_session_serial#,
       s.sql_id,
       s.client_identifier,
       s.module,
       s.action
FROM   v\$session s
WHERE  s.event IN ('enq: TM - contention',
                   'enq: TX - row lock contention',
                   'enq: TX - allocate ITL entry')
  AND  s.status = 'ACTIVE'
ORDER BY s.seconds_in_wait DESC;
\`\`\`

### 5.2 Trace the full blocking chain (root blocker)

\`\`\`sql
-- Walk the blocking chain up to the root holder
SELECT LEVEL                             AS depth,
       SYS_CONNECT_BY_PATH(sid, ' -> ') AS chain,
       sid,
       serial#,
       username,
       status,
       event,
       seconds_in_wait,
       blocking_session,
       sql_id,
       module,
       action
FROM   v\$session
WHERE  blocking_session IS NOT NULL
   OR  sid IN (
       SELECT blocking_session
       FROM   v\$session
       WHERE  blocking_session IS NOT NULL
   )
START WITH blocking_session IS NULL
       AND sid IN (
           SELECT CONNECT_BY_ROOT(sid)
           FROM   v\$session
           WHERE  blocking_session IS NOT NULL
           CONNECT BY PRIOR blocking_session = sid
       )
CONNECT BY PRIOR sid = blocking_session
ORDER SIBLINGS BY seconds_in_wait DESC NULLS LAST;
\`\`\`

### 5.3 Identify what the root blocker is holding

\`\`\`sql
-- Object locks held by the blocking session
SELECT lo.session_id,
       lo.locked_mode,
       do.object_name,
       do.object_type,
       do.owner
FROM   v\$locked_object lo
JOIN   dba_objects do ON do.object_id = lo.object_id
WHERE  lo.session_id = &blocking_session_id
ORDER BY lo.locked_mode DESC;
\`\`\`

### 5.4 Check ASH for lock history (if the blocker already disconnected)

\`\`\`sql
-- ASH lock wait history for the past 2 hours on RCV tables
SELECT ash.sample_time,
       ash.session_id,
       ash.session_serial#,
       ash.blocking_session,
       ash.event,
       ash.current_obj#,
       do.object_name,
       do.object_type,
       ash.sql_id,
       ash.module
FROM   v\$active_session_history ash
LEFT JOIN dba_objects do ON do.object_id = ash.current_obj#
WHERE  ash.sample_time >= SYSDATE - 2/24
  AND  (ash.event LIKE 'enq: T%' OR do.object_name LIKE 'RCV%')
ORDER BY ash.sample_time DESC
FETCH FIRST 100 ROWS ONLY;
\`\`\`

### 5.5 Kill the blocking session (last resort)

Confirm with the application team that the blocking session's transaction can be safely rolled back before proceeding.

\`\`\`sql
-- Kill the root blocking session
-- Syntax: ALTER SYSTEM KILL SESSION 'sid,serial#' IMMEDIATE;
ALTER SYSTEM KILL SESSION '&blocking_sid,&blocking_serial' IMMEDIATE;
\`\`\`

After killing the session, confirm the blocked sessions resume within 30–60 seconds by re-running the lock wait query from step 5.1.

---

## Phase 6: Interface Cleanup and RVCTP Manager Restart

After resolving the root cause, clear the backlog of failed interface rows and restart the RVCTP manager cleanly.

### 6.1 Archive failed rows before deleting

Never delete interface rows without archiving — the data is needed for forensics and potential manual reprocessing.

\`\`\`sql
-- Create archive table if it doesn't exist
CREATE TABLE rcv_intf_error_archive AS
SELECT rti.*,
       SYSDATE AS archived_date,
       'rvtptcontrol_failed_' || TO_CHAR(SYSDATE,'YYYYMMDD') AS incident_tag
FROM   rcv_transactions_interface rti
WHERE  1 = 0;

-- Archive ERROR rows for this incident
INSERT INTO rcv_intf_error_archive
SELECT rti.*,
       SYSDATE,
       'rvtptcontrol_failed_' || TO_CHAR(SYSDATE,'YYYYMMDD')
FROM   rcv_transactions_interface rti
WHERE  processing_status_code = 'ERROR'
  AND  last_update_date < SYSDATE - 1/24;  -- Only rows stale >1 hour

COMMIT;

-- Verify count before deleting
SELECT COUNT(*) FROM rcv_intf_error_archive
WHERE  incident_tag = 'rvtptcontrol_failed_' || TO_CHAR(SYSDATE,'YYYYMMDD');
\`\`\`

### 6.2 Delete the archived ERROR rows from the interface table

\`\`\`sql
-- Only delete rows you have confirmed are archived
DELETE FROM rcv_transactions_interface
WHERE  processing_status_code = 'ERROR'
  AND  interface_transaction_id IN (
       SELECT interface_transaction_id
       FROM   rcv_intf_error_archive
       WHERE  incident_tag = 'rvtptcontrol_failed_' || TO_CHAR(SYSDATE,'YYYYMMDD')
  );

COMMIT;

-- Confirm the interface table is clean
SELECT process_status, COUNT(*)
FROM   rcv_transactions_interface
GROUP BY process_status;
\`\`\`

### 6.3 Clear PO_INTERFACE_ERRORS for the deleted rows

\`\`\`sql
DELETE FROM po_interface_errors
WHERE  interface_transaction_id NOT IN (
       SELECT interface_transaction_id
       FROM   rcv_transactions_interface
);
COMMIT;
\`\`\`

### 6.4 Restart the RVCTP manager

In the EBS UI:
1. Navigate to: System Administrator > Concurrent > Manager > Administer
2. Filter on Manager Name = "Receiving Transaction Processor"
3. Click **Deactivate**, wait 60 seconds, then click **Activate**
4. Verify the Actual Workers column returns to the configured value (typically 2–5 workers)

Or via SQL (confirm with your EBS team this is the correct request to use as a kickstart):

\`\`\`sql
-- Check current RVCTP manager status
SELECT concurrent_queue_name,
       max_processes,
       running_processes,
       worker_count,
       manager_type
FROM   fnd_concurrent_queues_vl
WHERE  upper(concurrent_queue_name) LIKE '%RCVTP%'
   OR  upper(concurrent_queue_name) LIKE '%RECEIVING%';
\`\`\`

### 6.5 Test with a single low-risk transaction

Before clearing the business team to resume bulk entry:

1. Ask a receiving clerk to process a single receipt on a known-good PO in a non-production-critical plant.
2. Verify the row moves from status 1 → disappears from \`RCV_TRANSACTIONS_INTERFACE\` (successful rows are moved to \`RCV_TRANSACTIONS\`).
3. Verify no new rows appear in \`PO_INTERFACE_ERRORS\`.
4. Confirm the receipt is visible in the PO workbench.

\`\`\`sql
-- Confirm the test transaction moved to RCV_TRANSACTIONS
SELECT rt.transaction_id,
       rt.transaction_type,
       rt.transaction_date,
       rt.quantity,
       rt.unit_of_measure,
       rt.shipment_header_id
FROM   rcv_transactions rt
WHERE  rt.creation_date >= SYSDATE - 1/24
ORDER BY rt.creation_date DESC
FETCH FIRST 5 ROWS ONLY;
\`\`\`

---

## Phase 7: Post-Resolution Verification

### 7.1 Confirm no remaining ERROR rows

\`\`\`sql
SELECT COUNT(*) AS remaining_error_rows
FROM   rcv_transactions_interface
WHERE  processing_status_code = 'ERROR';
-- Expected: 0

SELECT COUNT(*) AS pending_over_30_min
FROM   rcv_transactions_interface
WHERE  processing_status_code = 'PENDING'
  AND  creation_date < SYSDATE - 30/1440;
-- Expected: 0 (rows older than 30 minutes without status change are stalled)
\`\`\`

### 7.2 Confirm RVCTP manager is processing

\`\`\`sql
-- Recent RVCTP manager log entries (successful completions)
SELECT fcr.request_id,
       fcr.phase_code,
       fcr.status_code,
       fcr.requested_start_date,
       fcr.actual_start_date,
       fcr.actual_completion_date
FROM   fnd_concurrent_requests fcr
JOIN   fnd_concurrent_programs fcp
       ON fcp.concurrent_program_id = fcr.concurrent_program_id
      AND fcp.application_id = fcr.program_application_id
WHERE  upper(fcp.concurrent_program_name) LIKE '%RVCTP%'
ORDER BY fcr.actual_start_date DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

### 7.3 Confirm no lingering lock waits on RCV tables

\`\`\`sql
SELECT s.sid,
       s.serial#,
       s.event,
       s.seconds_in_wait,
       s.blocking_session,
       do.object_name
FROM   v\$session s
JOIN   v\$locked_object lo ON lo.session_id = s.sid
JOIN   dba_objects do ON do.object_id = lo.object_id
WHERE  do.object_name LIKE 'RCV%'
  AND  s.event LIKE 'enq:%';
-- Expected: 0 rows
\`\`\`

---

## Monitoring Script: rvtptcontrol_monitor.sh

Deploy this script on the application server and run it every 5 minutes via cron during and after the incident. It checks the five most important health signals for rvtptcontrol processing.

\`\`\`bash
#!/bin/bash
# rvtptcontrol_monitor.sh
# Run as: applmgr on the EBS application server
# Cron: */5 * * * * /home/applmgr/scripts/rvtptcontrol_monitor.sh >> /home/applmgr/logs/rvtptcontrol_monitor.log 2>&1

set -euo pipefail

SCRIPT_NAME="rvtptcontrol_monitor"
LOG_DATE=$(date '+%Y-%m-%d %H:%M:%S')
ALERT=0

# --- Configuration ---
ORACLE_USER=\${ORACLE_USER:-apps}
ORACLE_PASS=\${ORACLE_PASS:-apps}
ORACLE_SID=\${ORACLE_SID:-EBSPRD}
ALERT_EMAIL=\${ALERT_EMAIL:-dba-alerts@example.com}
ERROR_ROW_THRESHOLD=10        # Alert if ERROR rows exceed this count
STALE_PENDING_MINUTES=30      # Alert if PENDING rows are this old without progress
LOCK_WAIT_SECONDS=120         # Alert if a lock wait exceeds this duration
WL_STUCK_THRESHOLD=3          # Alert if stuck WebLogic threads exceed this count

log() {
  echo "[$LOG_DATE][$SCRIPT_NAME] $1"
}

send_alert() {
  local subject="$1"
  local body="$2"
  log "ALERT: $subject"
  echo "$body" | mail -s "[$ORACLE_SID] ALERT: $subject" "$ALERT_EMAIL" 2>/dev/null || true
}

run_sql() {
  sqlplus -s "$ORACLE_USER/$ORACLE_PASS@$ORACLE_SID" <<SQL
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMOUT ON
$1
EXIT;
SQL
}

# --- Check 1: ERROR row count in RCV_TRANSACTIONS_INTERFACE ---
log "=== Check 1: Interface ERROR rows ==="
ERROR_COUNT=$(run_sql "
SELECT COUNT(*) FROM rcv_transactions_interface WHERE processing_status_code = 'ERROR';
" | tr -d ' ')

log "ERROR rows: $ERROR_COUNT (threshold: $ERROR_ROW_THRESHOLD)"
if [ "$ERROR_COUNT" -gt "$ERROR_ROW_THRESHOLD" ]; then
  ALERT=1
  send_alert "rvtptcontrol ERROR rows: $ERROR_COUNT" \
    "RCV_TRANSACTIONS_INTERFACE has $ERROR_COUNT rows with status ERROR.
Run: SELECT pie.error_message, COUNT(*) FROM po_interface_errors pie
     JOIN rcv_transactions_interface rti USING (interface_transaction_id)
     WHERE rti.processing_status_code = 'ERROR'
     GROUP BY pie.error_message ORDER BY 2 DESC;"
fi

# --- Check 2: Stale PENDING rows (stuck without progressing) ---
log "=== Check 2: Stale PENDING rows ==="
STALE_PENDING=$(run_sql "
SELECT COUNT(*) FROM rcv_transactions_interface
WHERE processing_status_code = 'PENDING'
  AND creation_date < SYSDATE - $STALE_PENDING_MINUTES/1440;
" | tr -d ' ')

log "Stale PENDING rows (>$STALE_PENDING_MINUTES min): $STALE_PENDING"
if [ "$STALE_PENDING" -gt 0 ]; then
  ALERT=1
  send_alert "RVCTP stale PENDING rows: $STALE_PENDING" \
    "$STALE_PENDING PENDING rows in RCV_TRANSACTIONS_INTERFACE have not progressed in $STALE_PENDING_MINUTES minutes.
RVCTP manager may be down or overloaded. Check Administer Concurrent Managers."
fi

# --- Check 3: RVCTP manager active worker count ---
log "=== Check 3: RVCTP manager worker count ==="
RVCTP_WORKERS=$(run_sql "
SELECT NVL(running_processes, 0) FROM fnd_concurrent_queues_vl
WHERE UPPER(concurrent_queue_name) LIKE '%RCVTP%'
  OR  UPPER(concurrent_queue_name) LIKE '%RECEIVING%'
FETCH FIRST 1 ROWS ONLY;
" | tr -d ' ')

log "RVCTP active workers: $RVCTP_WORKERS"
if [ -z "$RVCTP_WORKERS" ] || [ "$RVCTP_WORKERS" -eq 0 ]; then
  ALERT=1
  send_alert "RVCTP manager has 0 active workers" \
    "The Receiving Transaction Processor manager reports 0 running processes.
Check System Administrator > Concurrent > Manager > Administer and restart RVCTP."
fi

# --- Check 4: Active lock waits on RCV tables ---
log "=== Check 4: RCV table lock waits ==="
LOCK_WAITS=$(run_sql "
SELECT COUNT(*) FROM v\$session s
JOIN v\$locked_object lo ON lo.session_id = s.sid
JOIN dba_objects do ON do.object_id = lo.object_id
WHERE do.object_name LIKE 'RCV%'
  AND s.event LIKE 'enq:%'
  AND s.seconds_in_wait > $LOCK_WAIT_SECONDS;
" | tr -d ' ')

log "Lock waits on RCV tables (>$LOCK_WAIT_SECONDS sec): $LOCK_WAITS"
if [ "$LOCK_WAITS" -gt 0 ]; then
  ALERT=1
  # Collect blocking chain summary
  LOCK_DETAIL=$(run_sql "
SELECT s.sid, s.serial#, s.username, s.blocking_session,
       s.seconds_in_wait, s.event, do.object_name
FROM v\$session s
JOIN v\$locked_object lo ON lo.session_id = s.sid
JOIN dba_objects do ON do.object_id = lo.object_id
WHERE do.object_name LIKE 'RCV%'
  AND s.event LIKE 'enq:%'
  AND s.seconds_in_wait > $LOCK_WAIT_SECONDS
ORDER BY s.seconds_in_wait DESC FETCH FIRST 5 ROWS ONLY;
")
  send_alert "RCV table lock contention ($LOCK_WAITS waits)" \
    "Lock waits detected on RCV tables exceeding $LOCK_WAIT_SECONDS seconds:
$LOCK_DETAIL

Use Phase 5 of the rvtptcontrol runbook to identify and resolve the blocking chain."
fi

# --- Check 5: ASH lock wait activity in last 15 minutes ---
log "=== Check 5: Recent ASH lock wait activity ==="
ASH_LOCK_SAMPLES=$(run_sql "
SELECT COUNT(*) FROM v\$active_session_history
WHERE sample_time >= SYSDATE - 15/1440
  AND event LIKE 'enq: T%'
  AND module LIKE '%RCV%';
" | tr -d ' ')

log "ASH RCV lock samples (last 15 min): $ASH_LOCK_SAMPLES"
if [ "$ASH_LOCK_SAMPLES" -gt 30 ]; then
  ALERT=1
  send_alert "High ASH lock activity for RCV: $ASH_LOCK_SAMPLES samples" \
    "ASH shows $ASH_LOCK_SAMPLES lock-wait samples for RCV module in the last 15 minutes.
This indicates persistent lock contention. Review Phase 5 of the rvtptcontrol runbook."
fi

# --- Summary ---
log "=== Monitor Summary ==="
log "ERROR rows: $ERROR_COUNT | Stale PENDING: $STALE_PENDING | RVCTP workers: $RVCTP_WORKERS | Lock waits: $LOCK_WAITS | ASH samples: $ASH_LOCK_SAMPLES"
if [ "$ALERT" -eq 0 ]; then
  log "STATUS: OK — All checks passed"
else
  log "STATUS: ALERT SENT — One or more checks failed"
fi
\`\`\`

### Deploy the monitoring script

\`\`\`bash
# As applmgr on the EBS application server
mkdir -p /home/applmgr/scripts /home/applmgr/logs
cp rvtptcontrol_monitor.sh /home/applmgr/scripts/
chmod 750 /home/applmgr/scripts/rvtptcontrol_monitor.sh

# Add cron entry (every 5 minutes)
(crontab -l 2>/dev/null; echo "*/5 * * * * /home/applmgr/scripts/rvtptcontrol_monitor.sh >> /home/applmgr/logs/rvtptcontrol_monitor.log 2>&1") | crontab -

# Source EBS environment variables in the script before Oracle calls
# Add to the top of the script after the shebang line:
# source /u01/app/ebsprd/EBSapps.env run

# Test manually first
/home/applmgr/scripts/rvtptcontrol_monitor.sh
\`\`\`

---

## Quick Reference: Symptoms and Phases

| Symptom | Go To |
|---------|-------|
| Users report "rvtptcontrol failed" error message | Phase 1: read PO_INTERFACE_ERRORS |
| Errors show "unit of measure" mismatch | Phase 2.1 |
| Errors show "period not open" or accounting date | Phase 2.2 |
| Errors show ORA-08004 or sequence-related | Phase 2.3 |
| Debug messages reference custom trigger | Phase 2.4 |
| RVCTP log is unhelpful — need more detail | Phase 3 |
| Receiving workbench freezes — no error | Phase 4: WebLogic thread dump |
| V\$SESSION shows enq: TM or TX waits | Phase 5: lock chain |
| Interface table cleaned — need clean restart | Phase 6 |
| Post-fix verification | Phase 7 |

---

## Profile Options Reference

| Profile Option | Recommended Value | Purpose |
|---------------|------------------|---------|
| RCV: Processing Mode | IMMEDIATE (production) | Controls sync vs. async processing |
| INV: Debug Trace | N (production) | Enables C-level debug output |
| INV: Debug Level | 1 (production) | Debug verbosity; use 11 only while diagnosing |
| RCV: Enforce UOM Conversion | Yes | Rejects mismatched UOM at entry |
| PO: Legal Requisition Type | Purchase | Controls document routing logic |`,
};

async function main() {
  console.log('Inserting rvtptcontrol runbook...');
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
