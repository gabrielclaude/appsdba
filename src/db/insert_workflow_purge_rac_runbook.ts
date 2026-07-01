import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Workflow Purge RAC Interconnect Runbook: Diagnosing and Throttling Purge-Driven Cache Fusion Pressure',
  slug: 'oracle-workflow-purge-rac-interconnect-runbook',
  excerpt:
    'A phased RAC DBA runbook for diagnosing interconnect saturation caused by Oracle Workflow purge operations, distinguishing purge-driven Cache Fusion pressure from other causes, assessing collateral OLTP impact, emergency cancellation, throttled batch execution, node-affinity service setup, post-purge validation, and three reusable monitoring scripts.',
  category: 'ebs-workflow' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-01'),
  youtubeUrl: null,
  content: `This runbook guides a RAC DBA through every step required to diagnose, contain, and prevent interconnect saturation driven by Oracle Workflow runtime purge operations (\`WF_PURGE\`). Work through each phase in order. Emergency branches are clearly marked. All SQL runs as SYSDBA unless otherwise stated. Substitute your actual instance names, service names, and cutoff dates wherever angle-bracket placeholders appear.

**Prerequisites:**
- SYSDBA access to all RAC instances
- Grid Infrastructure (\`srvctl\`) access on at least one database node
- EBS System Administrator or equivalent DBA access to submit and cancel concurrent requests
- AWR and ASH licensed (Diagnostics Pack) for Phase 1 and Phase 6 historical queries
- \`sqlplus\` and \`srvctl\` available on the application tier node used for monitoring scripts

---

## Phase 1 — Confirm Workflow Purge Is the Source of Interconnect Pressure

RAC interconnect saturation has many causes: hot OLTP blocks causing cross-instance cache transfer storms, failing or rebooting cluster nodes generating split-brain conditions, misconfigured private interconnect NICs, or runaway parallel query operations. Before applying any of the mitigations in later phases you must confirm that workflow purge is actually the root cause. The purge has a distinct signature that separates it from the alternatives.

**Purge signature:** Active session history is dominated by WF_PURGE-related SQL (DELETE statements against \`WF_ITEMS\`, \`WF_ITEM_ACTIVITY_STATUSES\`, \`WF_ITEM_ATTRIBUTE_VALUES\`, \`WF_NOTIFICATIONS\`, \`WF_NOTIFICATION_ATTRIBUTES\`) with \`gc%\` wait events. The cluster-level gc block transfer rate measured by \`GV\$SYSSTAT\` is elevated and the spike's start and end times correlate precisely with the "Purge Obsolete Workflow Runtime Data" concurrent request (concurrent program short name \`FNDWFPR\` in some environments, or a custom wrapper calling \`WF_PURGE.TOTAL\`).

### 1.1 — Confirm the Purge Concurrent Request Is Running

\`\`\`sql
-- Find running WF_PURGE concurrent request
SELECT fcr.request_id,
       fcr.phase_code,
       fcr.status_code,
       fcr.actual_start_date,
       ROUND((SYSDATE - fcr.actual_start_date) * 60, 1) AS minutes_running,
       fcr.argument_text
FROM   fnd_concurrent_requests fcr
JOIN   fnd_concurrent_programs fcp ON fcr.concurrent_program_id = fcp.concurrent_program_id
WHERE  fcp.concurrent_program_name = 'FNDWFPR'
  AND  fcr.phase_code = 'R'
ORDER  BY fcr.actual_start_date DESC;
\`\`\`

If no rows are returned from the \`FND_CONCURRENT_REQUESTS\` query, check whether the purge is being driven by a custom DBMS_SCHEDULER job or a manual PL/SQL call — look for \`WF_PURGE\` in \`GV\$SESSION\` module or action columns.

### 1.2 — Measure the gc Wait Event Rate Across All Instances

\`\`\`sql
-- Check gc wait event rate across all instances right now
SELECT inst_id,
       event,
       total_waits,
       time_waited_micro / 1000000 AS time_waited_sec,
       ROUND(time_waited_micro / NULLIF(total_waits, 0) / 1000, 3) AS avg_wait_ms
FROM   gv\$system_event
WHERE  event LIKE 'gc%'
  AND  wait_class = 'Cluster'
ORDER  BY inst_id, time_waited_micro DESC;
\`\`\`

The cumulative values shown here are since instance startup. To get the rate you need a delta. Run this query twice, 60 seconds apart, and subtract.

### 1.3 — GV$SYSSTAT gc Block Transfer Rate — Delta Measurement

Run this query, record the output (snapshot 1), wait 60 seconds, run it again (snapshot 2), and subtract snapshot 1 from snapshot 2 to get the blocks-per-minute rate.

\`\`\`sql
-- GV$SYSSTAT gc block transfer rate (snapshot 1 — run again after 60 seconds for delta)
SELECT inst_id,
       name,
       value AS snapshot_1
FROM   gv\$sysstat
WHERE  name IN ('gc current blocks received','gc cr blocks received',
                'gc current block receive time','gc cr block receive time')
ORDER  BY inst_id, name;
\`\`\`

A delta of more than 10,000 \`gc current blocks received\` per minute across any instance during the purge window is a strong indicator of purge-driven Cache Fusion pressure. Rates above 50,000 per minute almost always correlate with measurable OLTP degradation on the affected instances.

### 1.4 — Decision Table: Interpretation

| Observation | Interpretation |
|---|---|
| gc waits + WF_PURGE SQL in ASH | Workflow purge is the source — proceed to Phase 2 |
| gc waits + no purge running | Investigate hot blocks, node failure, or network; this runbook does not apply |
| gc waits + purge running + delta > 10K blocks/min | Purge actively degrading cluster — assess OLTP impact in Phase 2 immediately |
| gc waits + purge running + delta < 2K blocks/min | Purge causing minor pressure — monitor and note for throttling at next schedule |
| gc waits + purge running + node event logs showing NIC errors | Network problem masking or amplifying purge pressure — address NIC first |

**Differentiating from OLTP hot blocks:** If the gc wait sessions in \`GV\$SESSION\` are concentrated on a single file/block number (columns \`P1\` and \`P2\`) being contested by many sessions simultaneously, that is an OLTP hot block pattern, not a purge pattern. Purge generates a moving wave of exclusive block requests — many different block addresses across the workflow table segments, no single block contested by more than two sessions at once.

**Differentiating from node failure:** A node failure generates \`gc buffer busy acquire\` and \`gc current request\` waits across all instances simultaneously as mastership reconfigures. This runbook's Phase 3 cancel procedure is safe during a node failure situation, but the root cause is different and the fix is different.

---

## Phase 2 — Assess Impact on Production Workload

Once the purge is confirmed as the gc pressure source, determine whether it is causing collateral damage to OLTP sessions. The purge and OLTP workloads compete for the same private interconnect bandwidth. OLTP sessions waiting on \`gc%\` events for non-workflow objects are the key signal of collateral impact.

### 2.1 — Live OLTP Sessions Experiencing gc Waits

\`\`\`sql
-- ASH: non-workflow sessions experiencing gc waits right now
SELECT s.inst_id,
       s.sid,
       s.event,
       s.seconds_in_wait,
       s.sql_id,
       o.object_name,
       o.object_type,
       s.p1 AS file_id,
       s.p2 AS block_id
FROM   gv\$session s
LEFT JOIN dba_extents e ON e.file_id = s.p1
                        AND s.p2 BETWEEN e.block_id AND e.block_id + e.blocks - 1
LEFT JOIN dba_objects o ON e.segment_name = o.object_name
WHERE  s.wait_class = 'Cluster'
  AND  s.event LIKE 'gc%'
  AND  s.module NOT LIKE '%WF%'
ORDER  BY s.seconds_in_wait DESC;
\`\`\`

If this returns rows with \`object_name\` values from OLTP schemas (order tables, invoice tables, general ledger tables) rather than workflow tables, the purge is consuming enough interconnect bandwidth to starve OLTP Cache Fusion requests.

### 2.2 — Identify Specific Blocks Being Transferred

\`\`\`sql
-- Identify the specific blocks being transferred (are they workflow tables?)
SELECT s.inst_id, s.sid, s.event,
       e.segment_name, e.segment_type, e.partition_name
FROM   gv\$session s
JOIN   dba_extents e ON e.file_id    = s.p1
                     AND s.p2 BETWEEN e.block_id AND e.block_id + e.blocks - 1
WHERE  s.wait_class = 'Cluster'
  AND  s.event LIKE 'gc current%'
ORDER  BY s.seconds_in_wait DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

If \`segment_name\` values include \`WF_ITEMS\`, \`WF_ITEM_ACTIVITY_STATUSES\`, \`WF_ITEM_ATTRIBUTE_VALUES\`, \`WF_NOTIFICATIONS\`, or \`WF_NOTIFICATION_ATTRIBUTES\`, the purge is generating the block traffic. If the segment names are from unrelated application schemas but the waits appeared only after the purge started, the purge is saturating the interconnect and OLTP requests are queuing behind it.

### 2.3 — Impact Classification and Next Action

Based on the average gc wait time observed for OLTP sessions (non-WF module):

- **Average gc wait < 50ms:** Minor interconnect pressure. The purge can continue. Set a watch interval of 10 minutes and re-evaluate. Proceed to Phase 5 (Node-Affinity) or Phase 4 (Throttle) during the next maintenance window.
- **Average gc wait 50–200ms:** Noticeable OLTP degradation. Proceed to Phase 4 (Throttled Purge) immediately. If the situation escalates past 200ms, cancel and reschedule.
- **Average gc wait > 200ms, or customer-facing errors reported:** Cancel the purge immediately. Proceed to Phase 3.

---

## Phase 3 — Emergency: Cancel the Purge

If the purge must be stopped immediately due to production impact, follow these steps in sequence. Do not skip the EBS front-end cancel — it writes the cancellation to the concurrent request audit trail, which is required for change management records.

### Step 1 — Locate the Concurrent Request ID and Database Session

\`\`\`sql
SELECT fcr.request_id,
       vs.inst_id,
       vs.sid,
       vs.serial#,
       vp.spid AS os_pid
FROM   fnd_concurrent_requests fcr
JOIN   fnd_concurrent_programs fcp ON fcr.concurrent_program_id = fcp.concurrent_program_id
JOIN   v\$process vp ON fcr.oracle_process_id = vp.spid
JOIN   v\$session vs ON vp.addr = vs.paddr
WHERE  fcp.concurrent_program_name = 'FNDWFPR'
  AND  fcr.phase_code = 'R';
\`\`\`

Record the \`request_id\`, \`inst_id\`, \`sid\`, \`serial#\`, and \`os_pid\` before proceeding.

### Step 2 — Cancel from EBS Front-End (Preferred)

Navigate to: Concurrent > Requests > View (or the applicable EBS concurrent requests screen). Locate the request by \`request_id\`. Click Cancel Request and confirm.

Wait up to 2 minutes for the cancellation to take effect. The request's phase will move to \`C\` (Completed) with status \`X\` (Terminated).

If the front-end cancel does not take effect within 2 minutes, proceed to Step 3.

### Step 3 — Kill the Database Session

Substitute the \`sid\` and \`serial#\` from Step 1:

\`\`\`sql
ALTER SYSTEM KILL SESSION '<sid>,<serial#>' IMMEDIATE;
\`\`\`

Issue this against the instance where the session is running (\`inst_id\` from Step 1). If connected to a different instance, use the \`@\` notation or connect directly to the target instance's SQL*Plus alias before issuing the command.

### Step 4 — Kill the OS Process on the Application Tier (If Needed)

If the database session kill does not free the interconnect within 90 seconds (verify by re-running the gc delta query from Phase 1.3), kill the OS process on the application tier node:

\`\`\`bash
kill -9 <os_pid>
\`\`\`

The \`os_pid\` is the \`spid\` from the Step 1 query. This terminates the concurrent manager worker process directly.

### Step 5 — Verify Interconnect Pressure Recedes

Re-run the gc wait query from Phase 1.2. The gc block transfer rate should return to baseline within 1–2 minutes after the purge session terminates. If it does not, a second purge session may be running, or another workload may be generating the interconnect traffic independently.

**Safety note on mid-purge cancellation:** Cancelling the purge mid-run is safe. \`WF_PURGE\` commits after each internal batch of rows. All rows deleted before the cancel are permanently committed and will not be purged again. The next purge run re-queries \`WF_ITEMS\` for eligible rows from scratch — it does not resume from a checkpoint. If the purge was partway through a large backlog, the remaining eligible rows will be addressed in the next scheduled or manually submitted run.

---

## Phase 4 — Throttled Purge Execution

When the purge must run but needs to be throttled to reduce interconnect pressure to acceptable levels, use this PL/SQL wrapper instead of the standard concurrent request. The wrapper calls \`WF_PURGE.TOTAL\` in controlled micro-batches with sleep intervals between each call, allowing other nodes' Cache Fusion requests to be satisfied in the gaps.

### 4.1 — Throttled Purge PL/SQL Wrapper

\`\`\`sql
DECLARE
  l_cutoff_date DATE          := SYSDATE - 180;  -- purge items older than 180 days
  l_batch_size  NUMBER        := 100;             -- rows per WF_PURGE call
  l_sleep_secs  NUMBER        := 0.5;             -- seconds between batches
  l_iteration   NUMBER        := 0;
  l_start       DATE          := SYSDATE;
  l_max_minutes NUMBER        := 120;             -- stop after 2 hours regardless
BEGIN
  LOOP
    EXIT WHEN (SYSDATE - l_start) * 1440 > l_max_minutes;

    WF_PURGE.TOTAL(
      itemtype   => NULL,          -- all item types
      itemkey    => NULL,
      enddate    => l_cutoff_date,
      docommit   => TRUE,
      runtimeonly => TRUE
    );

    l_iteration := l_iteration + 1;

    -- Throttle: sleep between batches
    DBMS_LOCK.SLEEP(l_sleep_secs);

    -- Safety valve: stop if no more eligible rows (WF_PURGE will exit cleanly)
    -- WF_PURGE does not raise an exception when there is nothing to purge
    -- so we rely on the max_minutes guard above
  END LOOP;

  DBMS_OUTPUT.PUT_LINE('Throttled purge complete. Iterations: ' || l_iteration
                       || '  Duration: ' || ROUND((SYSDATE - l_start)*1440,1) || ' minutes');
END;
/
\`\`\`

### 4.2 — Parameter Explanation

**\`l_batch_size = 100\` vs default 500:** Each call to \`WF_PURGE.TOTAL\` internally issues DELETE statements against the workflow runtime tables. Reducing the batch size means each DELETE covers fewer rows per call, which shortens the duration of exclusive block holds on each affected database block. Shorter hold times mean other instances' Cache Fusion requests can be granted sooner, reducing average gc wait latency. The default internal batch size of 500 rows will acquire exclusive ownership of workflow table blocks for long enough to starve an OLTP workload sharing the same interconnect. A batch size of 100 is a reasonable starting point; reduce further to 50 if gc waits remain above 50ms with 100-row batches.

**\`l_sleep_secs = 0.5\`:** The 500-millisecond sleep between each \`WF_PURGE.TOTAL\` call provides a window during which the interconnect is idle from purge traffic. Other nodes' pending Cache Fusion requests — which were queued behind the purge's block mastery requests — can be satisfied during this window. Increase the sleep to 1.0 or 2.0 seconds if gc waits on OLTP sessions are still elevated between iterations.

**\`l_max_minutes = 120\`:** A hard stop prevents the throttled purge from running past a maintenance window boundary into business hours. Set this to the number of minutes available before the business day begins. If the backlog is large, plan multiple nightly throttled runs over several nights rather than attempting to clear the entire backlog in one session.

**\`docommit => TRUE\`:** This is the default \`WF_PURGE.TOTAL\` behavior and must not be changed to FALSE. Setting \`docommit => FALSE\` would accumulate an uncommitted transaction across the entire run, producing a massive rollback segment and a single large REDO write at commit. With \`docommit => TRUE\`, each internal batch commits immediately, keeping undo usage and redo burst manageable.

**\`runtimeonly => TRUE\`:** Restricts the purge to workflow runtime data only (items, activity statuses, notifications, notification attributes, and item attribute values). Setting this to FALSE also purges design-time data such as process definitions, which is almost never the intent during a runtime maintenance purge.

### 4.3 — Monitoring the Throttled Purge

While the throttled wrapper runs, open a second session and run this query every few minutes to confirm that gc wait rates remain within acceptable bounds:

\`\`\`sql
SELECT inst_id,
       event,
       ROUND(time_waited_micro / NULLIF(total_waits, 0) / 1000, 3) AS avg_wait_ms,
       total_waits
FROM   gv\$system_event
WHERE  event LIKE 'gc current%'
  AND  wait_class = 'Cluster'
ORDER  BY inst_id, avg_wait_ms DESC;
\`\`\`

If \`avg_wait_ms\` climbs above 200ms during the throttled run, increase \`l_sleep_secs\` and reduce \`l_batch_size\` in the next run.

---

## Phase 5 — Node-Affinity Purge Setup

The most durable mitigation for purge-driven interconnect pressure is to pin the purge to the RAC instance that already holds the workflow table blocks in its buffer cache. Cross-instance Cache Fusion block transfers occur when the purge session's instance does not own the current version of the block it is deleting. If the purge runs on the same instance where EBS workflow background engines (deferred agent listeners, mailer, Java concurrent programs) have been writing workflow runtime data, a high proportion of those blocks will already be in that instance's buffer cache and no Cache Fusion transfer is required.

### 5.1 — Identify the Instance Most Likely to Hold Workflow Blocks

Determine which instance processes the most workflow-related activity:

\`\`\`sql
SELECT inst_id, COUNT(*) AS wf_sessions
FROM   gv\$session
WHERE  module LIKE '%Workflow%' OR module LIKE '%WF_%'
GROUP  BY inst_id
ORDER  BY wf_sessions DESC;
\`\`\`

The instance with the highest \`wf_sessions\` count is the one where most workflow writes are occurring. This instance is the optimal target for the purge affinity service. If sessions are evenly distributed across all instances, choose the instance with the lowest non-workflow OLTP load to minimize contention.

### 5.2 — Create a Dedicated RAC Service on the Target Instance

\`\`\`sql
-- Using DBMS_SERVICE (RAC)
EXEC DBMS_SERVICE.CREATE_SERVICE('WF_PURGE_SVC', 'WF_PURGE_SVC');
EXEC DBMS_SERVICE.START_SERVICE('WF_PURGE_SVC', 1);  -- start on instance 1 only
\`\`\`

Replace \`1\` with the instance number identified in Step 5.1 if it is not instance 1. Verify the service is running:

\`\`\`sql
SELECT inst_id, name, network_name
FROM   gv\$services
WHERE  name = 'WF_PURGE_SVC'
ORDER  BY inst_id;
\`\`\`

Only one row should be returned, with the target \`inst_id\`. If the service appears on multiple instances, stop it on the unintended instances:

\`\`\`sql
EXEC DBMS_SERVICE.STOP_SERVICE('WF_PURGE_SVC', <unintended_instance_number>);
\`\`\`

For a production RAC environment, also register the service with Grid Infrastructure to survive restarts:

\`\`\`bash
srvctl add service -db <DB_UNIQUE_NAME> -service WF_PURGE_SVC -preferred <INSTANCE_1_NAME> -available ""
srvctl start service -db <DB_UNIQUE_NAME> -service WF_PURGE_SVC
\`\`\`

### 5.3 — Configure the Purge to Connect via the Pinned Service

In an EBS environment, configure a dedicated concurrent manager (or a dedicated node-specific specialization rule on an existing manager) that uses a TNS alias resolving to \`WF_PURGE_SVC\`. The \`tnsnames.ora\` entry on the application tier should look similar to:

\`\`\`
WF_PURGE_SVC =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = <db_scan_host>)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = WF_PURGE_SVC)
    )
  )
\`\`\`

Point the concurrent manager's database connection to this TNS alias. Any concurrent requests submitted through this manager — including the workflow purge — will connect via \`WF_PURGE_SVC\` and land on the pinned instance.

### 5.4 — Verify the Purge Session Is Running on the Intended Instance

After submitting the purge through the pinned manager:

\`\`\`sql
SELECT inst_id, sid, serial#, module, action
FROM   gv\$session
WHERE  service_name = 'WF_PURGE_SVC';
\`\`\`

Confirm that \`inst_id\` matches the instance where the service is running. If the session appears on a different instance, the TNS alias or the service configuration is incorrect — do not proceed until this is resolved.

---

## Phase 6 — Post-Purge Validation

After the purge completes (whether via the standard run, throttled wrapper, or a cancelled-and-rescheduled run), validate that the purge accomplished its goal and that the cluster has returned to a healthy state.

### 6.1 — Confirm Workflow Table Sizes Have Decreased

\`\`\`sql
-- Confirm workflow table sizes have decreased
SELECT segment_name,
       ROUND(SUM(bytes)/1024/1024/1024, 2) AS size_gb
FROM   dba_segments
WHERE  segment_name IN ('WF_ITEMS','WF_ITEM_ACTIVITY_STATUSES',
                        'WF_ITEM_ATTRIBUTE_VALUES','WF_NOTIFICATIONS',
                        'WF_NOTIFICATION_ATTRIBUTES')
GROUP  BY segment_name
ORDER  BY size_gb DESC;
\`\`\`

Compare to the pre-purge sizes from the \`wf_table_sizing_report.sql\` script (Phase 6.4 below). If sizes have not decreased, the purge may have been cancelled before processing significant data, or the cutoff date parameter may have been too recent to capture much eligible data.

### 6.2 — Count Remaining Eligible Rows

\`\`\`sql
-- Count remaining eligible rows (should be near zero if purge was complete)
SELECT COUNT(*) AS still_eligible
FROM   wf_items
WHERE  end_date < SYSDATE - 180
  AND  end_date IS NOT NULL;
\`\`\`

A non-zero result after a full purge run indicates either that the \`max_minutes\` guard stopped the throttled wrapper before completing the backlog, or that the standard purge ran out of time. Schedule additional throttled runs on subsequent nights until this count reaches zero.

### 6.3 — Confirm gc Wait Rates Have Returned to Baseline

\`\`\`sql
-- Confirm gc wait rates have returned to baseline
SELECT inst_id,
       event,
       ROUND(time_waited_micro / NULLIF(total_waits, 0) / 1000, 3) AS avg_wait_ms
FROM   gv\$system_event
WHERE  event LIKE 'gc%'
  AND  wait_class = 'Cluster'
ORDER  BY inst_id, avg_wait_ms DESC;
\`\`\`

Compare \`avg_wait_ms\` to the pre-purge baseline. Values should be at or below the baseline. If gc waits remain elevated after the purge session has ended, investigate other workloads — the purge is no longer the cause.

### 6.4 — High-Water Mark Assessment and Segment Rebuild

Oracle does not automatically return space below the high-water mark after DELETE operations. After a large purge, the workflow table segments may have a significantly elevated HWM, causing full segment scans during subsequent purge runs to traverse many empty blocks. Check the HWM status:

\`\`\`sql
-- Check HWM vs actual data for WF_ITEMS
SELECT t.num_rows,
       s.blocks AS allocated_blocks,
       t.blocks AS blocks_below_hwm,
       ROUND(t.blocks * 8192 / 1024 / 1024, 2) AS hwm_mb
FROM   dba_tables t
JOIN   dba_segments s ON s.segment_name = t.table_name AND s.owner = t.owner
WHERE  t.table_name = 'WF_ITEMS'
  AND  t.owner = 'APPLSYS';
-- If blocks_below_hwm >> num_rows * avg_row_size / block_size, consider SHRINK SPACE or MOVE
\`\`\`

First update statistics so \`num_rows\` is current:

\`\`\`sql
EXEC DBMS_STATS.GATHER_TABLE_STATS('APPLSYS', 'WF_ITEMS', estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE);
\`\`\`

If \`blocks_below_hwm\` is substantially larger than the number of blocks actually needed to store the current rows, consider reclaiming space. For online reclamation (preferred — no downtime):

\`\`\`sql
ALTER TABLE applsys.wf_items ENABLE ROW MOVEMENT;
ALTER TABLE applsys.wf_items SHRINK SPACE COMPACT;
ALTER TABLE applsys.wf_items SHRINK SPACE;
ALTER TABLE applsys.wf_items DISABLE ROW MOVEMENT;
\`\`\`

If the table is not in an ASSM tablespace, use MOVE instead (this requires a maintenance window and an index rebuild afterward):

\`\`\`sql
ALTER TABLE applsys.wf_items MOVE;
-- Rebuild dependent indexes afterward
ALTER INDEX applsys.wf_items_pk REBUILD ONLINE;
\`\`\`

Apply the same HWM check and reclaim procedure to \`WF_ITEM_ACTIVITY_STATUSES\`, \`WF_ITEM_ATTRIBUTE_VALUES\`, \`WF_NOTIFICATIONS\`, and \`WF_NOTIFICATION_ATTRIBUTES\`.

---

## Phase 7 — Monitoring Scripts

### 7.1 — Shell Script: wf_purge_rac_monitor.sh

Save the following script as \`wf_purge_rac_monitor.sh\` on the application tier node. It samples \`GV\$SYSSTAT\` and \`GV\$SESSION\` every 60 seconds, logs results to a CSV, and sends an alert email when the gc block transfer rate exceeds a configurable threshold.

\`\`\`bash
#!/bin/bash
# wf_purge_rac_monitor.sh
# Monitors RAC interconnect pressure during Workflow purge operations.
# Usage: ./wf_purge_rac_monitor.sh
# Environment variables (set before running or export in calling script):
#   ORACLE_SID     - local SID for sqlplus connection
#   DB_HOST        - database SCAN or VIP hostname
#   ALERT_EMAIL    - email address for threshold alerts
#   THRESHOLD      - gc_current_blocks_received delta per minute that triggers alert
#   LOG_DIR        - directory for CSV log output (default: /tmp)

ORACLE_SID=\${ORACLE_SID:-PRODDB}
DB_HOST=\${DB_HOST:-dbserver-scan}
ALERT_EMAIL=\${ALERT_EMAIL:-dba-team@company.internal}
THRESHOLD=\${THRESHOLD:-5000}
LOG_DIR=\${LOG_DIR:-/tmp}

LOG_FILE="\${LOG_DIR}/wf_purge_rac_monitor_\$(date +%Y%m%d).csv"
PREV_SNAP_FILE="/tmp/wf_purge_rac_prev_snap.txt"

# Write CSV header if new file
if [ ! -f "\${LOG_FILE}" ]; then
  echo "timestamp,inst_id,gc_cr_blocks_rcv_delta,gc_curr_blocks_rcv_delta,max_gc_wait_ms,alert" >> "\${LOG_FILE}"
fi

while true; do
  TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')

  # Sample GV$SYSSTAT for gc block received counters
  SNAP_OUTPUT=\$(sqlplus -s /nolog <<SQLEOF
CONNECT / AS SYSDBA
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT inst_id || '|' || name || '|' || value
FROM   gv\\\$sysstat
WHERE  name IN ('gc current blocks received','gc cr blocks received')
ORDER  BY inst_id, name;
EXIT;
SQLEOF
)

  # Sample max gc wait from GV$SESSION
  MAX_GC_WAIT_MS=\$(sqlplus -s /nolog <<SQLEOF
CONNECT / AS SYSDBA
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT NVL(MAX(seconds_in_wait * 1000), 0)
FROM   gv\\\$session
WHERE  wait_class = 'Cluster'
  AND  event LIKE 'gc%';
EXIT;
SQLEOF
)
  MAX_GC_WAIT_MS=\$(echo "\${MAX_GC_WAIT_MS}" | tr -d ' ')

  # If we have a previous snapshot, compute delta
  if [ -f "\${PREV_SNAP_FILE}" ]; then
    ALERT_FLAG="N"
    while IFS='|' read -r inst name val; do
      PREV_VAL=\$(grep "^\${inst}|\${name}|" "\${PREV_SNAP_FILE}" | cut -d'|' -f3)
      if [ -n "\${PREV_VAL}" ]; then
        DELTA=\$(( val - PREV_VAL ))
        if echo "\${name}" | grep -q "current"; then
          CURR_DELTA=\${DELTA}
        else
          CR_DELTA=\${DELTA}
        fi
      fi
    done <<< "\${SNAP_OUTPUT}"

    # Log to CSV
    echo "\${TIMESTAMP},\${inst},\${CR_DELTA:-0},\${CURR_DELTA:-0},\${MAX_GC_WAIT_MS},\${ALERT_FLAG}" >> "\${LOG_FILE}"

    # Alert if current blocks received delta exceeds threshold
    if [ "\${CURR_DELTA:-0}" -gt "\${THRESHOLD}" ]; then
      ALERT_FLAG="Y"
      SUBJECT="RAC gc Alert: WF Purge Interconnect Pressure on \${ORACLE_SID}"
      BODY="Timestamp: \${TIMESTAMP}\nInstance: \${inst}\ngc_current_blocks_received delta: \${CURR_DELTA}/min\nThreshold: \${THRESHOLD}/min\nMax gc wait: \${MAX_GC_WAIT_MS}ms\nCheck if FNDWFPR is running and consider throttling or cancellation."
      echo -e "\${BODY}" | mail -s "\${SUBJECT}" "\${ALERT_EMAIL}"
    fi
  fi

  # Save current snapshot as previous for next iteration
  echo "\${SNAP_OUTPUT}" > "\${PREV_SNAP_FILE}"

  sleep 60
done
\`\`\`

Make the script executable and run it in the background before initiating the purge:

\`\`\`bash
chmod +x wf_purge_rac_monitor.sh
nohup ./wf_purge_rac_monitor.sh > /tmp/wf_purge_rac_monitor.log 2>&1 &
echo "Monitor PID: \$!"
\`\`\`

Stop it after the purge window closes by killing the background PID.

### 7.2 — SQL Script: wf_purge_ash_report.sql

Save as \`wf_purge_ash_report.sql\`. Run after an incident to analyze the gc wait event distribution during a specific time window from AWR history.

\`\`\`sql
-- wf_purge_ash_report.sql
-- Post-incident analysis: gc wait distribution during a specified purge window
-- Substitute actual start and end timestamps before running.
-- Requires Diagnostics Pack (DBA_HIST_ACTIVE_SESS_HISTORY).

DEFINE start_time = '2026-07-01 23:00'
DEFINE end_time   = '2026-07-02 01:00'

PROMPT
PROMPT ============================================================
PROMPT  gc Wait Event Distribution During Specified Window
PROMPT  Window: &&start_time to &&end_time
PROMPT ============================================================
PROMPT

-- Overall gc wait breakdown by event and instance
SELECT ash.inst_id,
       ash.event,
       COUNT(*)                                        AS ash_samples,
       ROUND(SUM(ash.wait_delta) / 1000000, 2)        AS total_wait_sec,
       ROUND(AVG(ash.wait_delta) / 1000, 2)           AS avg_wait_ms,
       ROUND(MAX(ash.wait_delta) / 1000, 2)           AS max_wait_ms
FROM   dba_hist_active_sess_history ash
WHERE  ash.sample_time BETWEEN TO_DATE('&&start_time', 'YYYY-MM-DD HH24:MI')
                           AND TO_DATE('&&end_time',   'YYYY-MM-DD HH24:MI')
  AND  ash.event LIKE 'gc%'
  AND  ash.wait_class = 'Cluster'
GROUP  BY ash.inst_id, ash.event
ORDER  BY ash.inst_id, total_wait_sec DESC;

PROMPT
PROMPT ============================================================
PROMPT  Sessions Generating gc Waits: WF vs Non-WF
PROMPT ============================================================
PROMPT

SELECT CASE WHEN ash.module LIKE '%WF%' OR ash.program LIKE '%FNDWFPR%'
            THEN 'WORKFLOW-PURGE' ELSE 'NON-WORKFLOW' END AS session_type,
       ash.inst_id,
       COUNT(DISTINCT ash.session_id)  AS distinct_sessions,
       COUNT(*)                        AS ash_samples,
       ROUND(SUM(ash.wait_delta) / 1000000, 2) AS total_wait_sec
FROM   dba_hist_active_sess_history ash
WHERE  ash.sample_time BETWEEN TO_DATE('&&start_time', 'YYYY-MM-DD HH24:MI')
                           AND TO_DATE('&&end_time',   'YYYY-MM-DD HH24:MI')
  AND  ash.event LIKE 'gc%'
  AND  ash.wait_class = 'Cluster'
GROUP  BY CASE WHEN ash.module LIKE '%WF%' OR ash.program LIKE '%FNDWFPR%'
               THEN 'WORKFLOW-PURGE' ELSE 'NON-WORKFLOW' END,
          ash.inst_id
ORDER  BY ash.inst_id, total_wait_sec DESC;

PROMPT
PROMPT ============================================================
PROMPT  Top SQL Statements in gc Waits During Window
PROMPT ============================================================
PROMPT

SELECT ash.sql_id,
       ash.inst_id,
       COUNT(*)                              AS ash_samples,
       ROUND(SUM(ash.wait_delta)/1000000, 2) AS total_wait_sec,
       MIN(sq.sql_text)                       AS sql_text_prefix
FROM   dba_hist_active_sess_history ash
LEFT JOIN dba_hist_sqltext sq ON sq.sql_id = ash.sql_id
WHERE  ash.sample_time BETWEEN TO_DATE('&&start_time', 'YYYY-MM-DD HH24:MI')
                           AND TO_DATE('&&end_time',   'YYYY-MM-DD HH24:MI')
  AND  ash.event LIKE 'gc%'
  AND  ash.wait_class = 'Cluster'
GROUP  BY ash.sql_id, ash.inst_id
ORDER  BY total_wait_sec DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

### 7.3 — SQL Script: wf_table_sizing_report.sql

Save as \`wf_table_sizing_report.sql\`. Run before scheduling a purge to assess the scope of data to be purged, estimate interconnect impact, and size the maintenance window.

\`\`\`sql
-- wf_table_sizing_report.sql
-- Pre-purge sizing report for all five workflow runtime tables.
-- Run as SYSDBA. Provides row counts, segment sizes, HWM status,
-- and eligible-row counts for purge scope estimation.

DEFINE cutoff_days = 180

PROMPT
PROMPT ============================================================
PROMPT  Workflow Runtime Table Sizing Report
PROMPT  Purge cutoff: SYSDATE - &&cutoff_days days
PROMPT ============================================================
PROMPT

-- Gather fresh stats before reporting (may take several minutes on large tables)
BEGIN
  FOR t IN (SELECT 'WF_ITEMS'                   AS tname FROM DUAL UNION ALL
            SELECT 'WF_ITEM_ACTIVITY_STATUSES'           FROM DUAL UNION ALL
            SELECT 'WF_ITEM_ATTRIBUTE_VALUES'            FROM DUAL UNION ALL
            SELECT 'WF_NOTIFICATIONS'                    FROM DUAL UNION ALL
            SELECT 'WF_NOTIFICATION_ATTRIBUTES'          FROM DUAL)
  LOOP
    DBMS_STATS.GATHER_TABLE_STATS(
      ownname          => 'APPLSYS',
      tabname          => t.tname,
      estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,
      no_invalidate    => FALSE
    );
  END LOOP;
END;
/

PROMPT
PROMPT --- Segment Sizes and HWM ---
PROMPT

SELECT t.table_name,
       TO_CHAR(t.num_rows, '999,999,999')          AS current_rows,
       ROUND(s.bytes / 1024 / 1024, 2)             AS segment_mb,
       t.blocks                                     AS blocks_below_hwm,
       ROUND(t.avg_row_len * t.num_rows
             / NULLIF(t.blocks * 8192, 0) * 100, 1) AS pct_fill_estimate
FROM   dba_tables   t
JOIN   dba_segments s ON s.segment_name = t.table_name
                      AND s.owner       = t.owner
WHERE  t.table_name IN ('WF_ITEMS','WF_ITEM_ACTIVITY_STATUSES',
                        'WF_ITEM_ATTRIBUTE_VALUES','WF_NOTIFICATIONS',
                        'WF_NOTIFICATION_ATTRIBUTES')
  AND  t.owner = 'APPLSYS'
ORDER  BY segment_mb DESC;

PROMPT
PROMPT --- Purge-Eligible Row Counts (end_date < SYSDATE - &&cutoff_days) ---
PROMPT

SELECT 'WF_ITEMS' AS table_name,
       COUNT(*)   AS eligible_rows,
       MIN(end_date) AS oldest_eligible
FROM   wf_items
WHERE  end_date < SYSDATE - &&cutoff_days
  AND  end_date IS NOT NULL
UNION ALL
SELECT 'WF_ITEM_ACTIVITY_STATUSES',
       COUNT(*),
       NULL
FROM   wf_item_activity_statuses ias
WHERE  EXISTS (SELECT 1 FROM wf_items wi
               WHERE  wi.item_type = ias.item_type
                 AND  wi.item_key  = ias.item_key
                 AND  wi.end_date  < SYSDATE - &&cutoff_days
                 AND  wi.end_date IS NOT NULL)
UNION ALL
SELECT 'WF_NOTIFICATIONS',
       COUNT(*),
       NULL
FROM   wf_notifications
WHERE  end_date < SYSDATE - &&cutoff_days
  AND  end_date IS NOT NULL
ORDER  BY 2 DESC;

PROMPT
PROMPT --- WF_ITEMS Backlog by Item Type ---
PROMPT

SELECT item_type,
       COUNT(*)        AS eligible_items,
       MIN(end_date)   AS oldest_item,
       MAX(end_date)   AS newest_eligible
FROM   wf_items
WHERE  end_date < SYSDATE - &&cutoff_days
  AND  end_date IS NOT NULL
GROUP  BY item_type
ORDER  BY eligible_items DESC;
\`\`\`

---

## Quick Reference

### WF_PURGE.TOTAL Parameter Table

| Parameter | Type | Default | Description |
|---|---|---|---|
| \`itemtype\` | VARCHAR2 | NULL | Workflow item type to purge. NULL = all item types. |
| \`itemkey\` | VARCHAR2 | NULL | Specific item key to purge. NULL = all keys within type. |
| \`enddate\` | DATE | SYSDATE | Purge items whose \`end_date\` is on or before this date. |
| \`docommit\` | BOOLEAN | TRUE | Commit after each internal batch. Never set to FALSE in production. |
| \`runtimeonly\` | BOOLEAN | TRUE | Restrict to runtime data only. FALSE also purges design-time process definitions. |

### gc Wait Event Glossary

| Event | Meaning | Purge Relevance |
|---|---|---|
| \`gc current block 2-way\` | Current (exclusive) block transferred from another instance in a 2-hop exchange (requester → master/holder → requester). | Primary wait event during purge DELETE operations. The purge session needs exclusive ownership to delete rows. |
| \`gc cr multi block request\` | Consistent-read (read-only) multi-block transfer for full table or index range scan. | Seen during WF_ITEMS range scans to identify eligible rows for deletion. |
| \`gc buffer busy acquire\` | Session is waiting to acquire a buffer that another session on the same instance is already waiting to receive from another instance. | Appears when purge causes a queue of block requests behind a single cross-instance transfer. |
| \`gc current block busy\` | Block was requested but the holding instance had not yet released it or written it to disk. | Indicates the purge's exclusive holds are not releasing quickly — reduces batch size to address. |
| \`gc current request\` | Session is waiting for the GCS (Global Cache Service) to satisfy a current-mode block request — the block is in transit. | Background noise during purge; high average latency here indicates interconnect network saturation rather than logical contention. |

### Purge Parameter Tuning Reference

| batch_size | sleep_secs | Expected gc Current Blocks/min | OLTP Impact |
|---|---|---|---|
| 500 (default) | 0 | > 20,000 | High — likely to cause visible latency |
| 200 | 0 | 10,000–20,000 | Moderate — monitor closely |
| 100 | 0.5 | 3,000–8,000 | Low — acceptable for most environments |
| 50 | 1.0 | 1,000–3,000 | Minimal — use for narrow maintenance windows or shared interconnects |
| 25 | 2.0 | < 1,000 | Near-zero — use only when interconnect is critically constrained |

### Emergency Cancel One-Liner

Find and kill the purge session in a single SQL block:

\`\`\`sql
BEGIN
  FOR r IN (SELECT vs.inst_id, vs.sid, vs.serial#
            FROM   v\$process vp
            JOIN   v\$session vs ON vp.addr = vs.paddr
            JOIN   fnd_concurrent_requests fcr ON fcr.oracle_process_id = vp.spid
            JOIN   fnd_concurrent_programs fcp ON fcr.concurrent_program_id = fcp.concurrent_program_id
            WHERE  fcp.concurrent_program_name = 'FNDWFPR'
              AND  fcr.phase_code = 'R')
  LOOP
    EXECUTE IMMEDIATE 'ALTER SYSTEM KILL SESSION ''' || r.sid || ',' || r.serial# || ''' IMMEDIATE';
  END LOOP;
END;
/
\`\`\`

### Node-Affinity Service Create One-Liner

\`\`\`sql
EXEC DBMS_SERVICE.CREATE_SERVICE('WF_PURGE_SVC','WF_PURGE_SVC'); EXEC DBMS_SERVICE.START_SERVICE('WF_PURGE_SVC',1);
\`\`\`

### Decision Flowchart

\`\`\`
Observe elevated gc% waits on RAC cluster
            |
            v
Is "Purge Obsolete Workflow Runtime Data" running?
   NO  --> Investigate other causes (hot blocks, node failure, network)
   YES --> Measure gc current blocks received delta (60-second snapshot)
            |
            v
Delta < 2,000 blocks/min?
   YES --> Monitor only; plan throttled or node-affinity setup for next run
   NO  --> Check avg gc wait for non-WF OLTP sessions
            |
            v
OLTP avg gc wait < 50ms?
   YES --> Continue purge; implement throttling or node-affinity at next window
            |
            v
OLTP avg gc wait 50-200ms?
   YES --> Apply throttled purge (Phase 4) immediately; monitor for escalation
            |
            v
OLTP avg gc wait > 200ms OR customer-facing errors?
   YES --> Cancel the purge immediately (Phase 3); reschedule with throttling
\`\`\`

---

## Notes and Edge Cases

**DBMS_LOCK.SLEEP availability:** \`DBMS_LOCK.SLEEP\` requires the \`EXECUTE\` privilege on \`DBMS_LOCK\`. The APPS schema typically has this privilege in standard EBS installations. Verify with \`SELECT * FROM dba_tab_privs WHERE grantee = 'APPS' AND table_name = 'DBMS_LOCK'\`. On Oracle 18c and later, \`DBMS_SESSION.SLEEP\` is available as a public synonym alternative that does not require a grant.

**WF_PURGE.TOTAL and large UNDO consumption:** Even with \`docommit => TRUE\`, a 100-row batch on tables with many child rows in \`WF_ITEM_ACTIVITY_STATUSES\` can generate significant undo. Monitor \`V\$UNDOSTAT\` for unexpired undo consumption spikes. If undo tablespace space pressure appears, reduce the batch size further.

**Interconnect persistence after cancel:** After cancelling the purge, gc wait rates should return to baseline within 1–2 minutes. If they remain elevated, confirm the purge OS process on the application tier has also terminated (Phase 3, Step 4). Occasionally the database session is killed but the application tier worker process continues submitting new SQL.

**WF_PURGE_SVC service behavior after RAC failover:** If the instance hosting \`WF_PURGE_SVC\` crashes, the service will not automatically relocate to another instance (this is intentional for affinity purposes). The purge will fail on reconnect. Resubmit the purge after the original instance recovers, or temporarily relocate the service with \`DBMS_SERVICE.START_SERVICE('WF_PURGE_SVC', <other_instance_number>)\` for the duration of the failover.

**Interaction with Online Patching (ADOP):** Do not run workflow purge operations during an active ADOP patching cycle (\`PREPARE\` through \`CUTOVER\` phases). WF table data is accessed by both the run and patch edition schemas during patching, and bulk DELETEs during this window can cause edition-crossing constraint violations. Schedule purge operations outside the patching window.`,
};

async function main() {
  console.log('Inserting workflow purge RAC runbook...');
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
