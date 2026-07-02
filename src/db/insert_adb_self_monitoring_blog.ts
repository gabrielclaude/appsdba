import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Autonomous Database Self-Monitoring: Scripts, Observability, and the Future of Autonomous Operations',
  slug: 'oracle-autonomous-database-self-monitoring',
  excerpt: 'ADB heals and tunes itself silently — but your pager stays quiet. Learn what the database monitors internally, what DBAs must still watch externally, and how to build a complete observability layer using in-database V$ queries, OCI Metrics, OCI Alarms, and five production-ready monitoring scripts.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-01'),
  youtubeUrl: null,
  content: `## Introduction

Oracle Autonomous Database's "self-managing" promise covers provisioning, tuning, patching, and recovery. But one aspect of ADB operations is frequently misunderstood: ADB monitors itself for health and performance, but it does **not** automatically alert your operations team. The database detects a degraded query plan — and fixes it silently. It detects block corruption — and repairs it silently. It detects that a patch is needed — and schedules it. None of these trigger a notification unless you wire up OCI Alarms and Notifications explicitly.

This post covers what ADB monitors internally, the monitoring APIs exposed to DBAs, the OCI Metrics surface, and a complete set of self-monitoring scripts that build a proactive observability layer on top of ADB's autonomous operations. By the end, you will have five production-ready scripts covering in-database health snapshots, OCI metrics collection, auto-index effectiveness reporting, connection pool saturation detection, and alarm wiring via OCI CLI.

---

## A Brief History of Oracle Database Monitoring

Understanding where ADB fits in the monitoring story requires tracing how Oracle's monitoring philosophy evolved over three decades.

### Oracle 8i/9i: The Manual Era

In the Oracle 8i and 9i era, DBAs manually queried \`V$\` views. There was no built-in alerting infrastructure. AWR did not exist. Statspack was the primary performance capture tool — a manual snapshot process that required a DBA to schedule snapshot collection via \`STATSPACK.SNAP()\`, then run a report comparing two snapshot IDs. Performance diagnosis was entirely human-driven: a DBA received a complaint, ran Statspack, read the report, and formed a hypothesis.

Monitoring scripts were shell scripts that ran \`sqlplus\` queries against \`V$SESSION\`, \`V$LOCK\`, and \`V$SQL\` on a cron schedule and emailed results. There was no standardization across shops — every organization had its own monitoring library, and institutional knowledge walked out the door when DBAs left.

### Oracle 10g: AWR and ADDM — The First Automation Layer

Oracle 10g (2003) introduced AWR — Automatic Workload Repository. AWR replaced Statspack with a built-in, automatically scheduled snapshot mechanism. Snapshots were taken every hour by default and retained for 8 days. ADDM (Automatic Database Diagnostic Monitor) added the first automated analysis layer: after each AWR snapshot pair, ADDM analyzed the delta and generated findings with recommendations.

Enterprise Manager 10g Grid Control emerged as the central monitoring console, providing a GUI over AWR and ADDM data. For the first time, DBAs had a unified monitoring surface rather than hand-rolled scripts.

However, the automation stopped at analysis. ADDM generated a recommendation: "SQL statement X is consuming 40% of DB time. Consider creating an index on column Y." A DBA still had to read the finding and decide whether to act.

### Oracle 11g: ASH and Real-Time Visibility

Oracle 11g introduced Active Session History (ASH) — in-memory, second-by-second sampling of active sessions stored in \`V$ACTIVE_SESSION_HISTORY\` and persisted to AWR in \`DBA_HIST_ACTIVE_SESS_HISTORY\`. ASH gave DBAs a time-machine for performance diagnosis: even if a performance spike had resolved by the time the DBA looked, ASH data captured what happened at each second.

Real-Time SQL Monitoring (\`V$SQL_MONITOR\`, \`V$SQL_PLAN_MONITOR\`) provided per-execution visibility into parallel and long-running SQL, showing exactly which step in an execution plan was consuming time at that moment. SQL Tuning Advisor formalized the recommendation engine.

### Oracle 12c/18c/19c: Multitenant Complexity

The Multitenant architecture (CDB/PDB) complicated monitoring. \`V$\` views at the CDB level aggregated across all PDBs, making isolation of per-PDB issues harder. AWR at the PDB level was added in 19c (\`DBA_HIST_*\` views scoped to a PDB). Automatic Indexing was formalized as a background process that continuously evaluated the workload and created/dropped indexes.

By 19c, a large portion of routine DBA work — index management, statistics gathering, segment shrink — had been automated. But the monitoring model was still DBA-pull: the database generated data, and DBAs queried it.

### Oracle Autonomous Database (2018+): The Inversion

ADB inverted the monitoring model. Instead of a DBA pulling performance data from \`V$\` views, the database uses machine learning to monitor itself and act on findings. Automatic Indexing not only recommends — it creates. Automatic Statistics not only detects staleness — it gathers. SQL Plan Management not only identifies regressions — it pins the baseline.

The DBA lost direct access to many internal mechanisms in exchange for the simplified interface. You cannot schedule your own RMAN backup strategy, modify the Resource Manager plan directly, or disable Automatic Indexing for a specific table. The tradeoff: automation replaced manual analysis, but the visibility surface narrowed.

### ADB + 23ai (2023+): The Observability Layer

Operations Insights (OCI service) now provides long-term AWR-equivalent trending for ADB fleets. Performance Hub in the OCI Console provides the real-time ASH and SQL Monitoring view without requiring SQL*Plus access. The DBA's toolbox has shifted: from SQL*Plus scripts run by an on-call DBA to OCI Console dashboards, REST APIs, OCI CLI scripts, and custom SQL against the views ADB does expose.

This history matters because the monitoring scripts in this post are the 2026 equivalent of the 1999 Statspack scripts — adapted to the ADB environment, using the surfaces ADB exposes, and integrated with OCI's alarm and notification infrastructure.

---

## What ADB Monitors Internally (and Acts On)

ADB's autonomous operations cover seven major monitoring domains, each with an internal monitor and an exposed visibility surface.

### 1. Automatic Indexing Monitor

ADB continuously evaluates the SQL workload against index candidates. Every 15 minutes, the Automatic Indexing process samples recent SQL from the cursor cache, identifies columns appearing in WHERE clauses and JOIN conditions, and simulates whether candidate indexes would reduce plan cost.

**What it acts on**: creates candidate indexes as INVISIBLE indexes first, validates them by running the SQL with and without the index using the optimizer, then makes them VISIBLE if they improve performance. Drops unused indexes after a retention period.

**DBA visibility**:
- \`DBA_AUTO_INDEX_IND_ACTIONS\` — each action (CREATE, DROP) with timestamp, index name, table name, reason, and improvement metric
- \`DBA_AUTO_INDEX_EXECUTIONS\` — each evaluation cycle with number of candidates evaluated, indexes created, indexes dropped

### 2. Automatic Statistics Monitor

ADB tracks statistics staleness via internal monitors that compare the current row count and data distribution against the statistics timestamp. When staleness exceeds the threshold (default: 10% of rows changed), statistics gathering is scheduled.

**DBA visibility**:
- \`DBA_TAB_STATISTICS\` — last analyzed timestamp, staleness indicator, row count
- \`DBA_OPTSTAT_OPERATIONS\` — history of every statistics gathering operation with elapsed time, status (COMPLETED, FAILED), and the target object

### 3. SQL Plan Monitor

The Automatic SQL Tuning task runs during the maintenance window (or continuously on ADB). When a SQL execution plan degrades by more than 3x compared to the historical baseline stored in the SQL Management Base, ADB can create a SQL Plan Baseline to pin the better-performing plan.

**DBA visibility**:
- \`DBA_SQL_PLAN_BASELINES\` — all baselines, whether accepted or not, with origin (AUTO-CAPTURE, MANUAL) and enabled flag
- \`V$SQL_MONITOR\` — current and recent SQL execution monitoring data

### 4. Block Corruption Detection

RMAN block change tracking runs continuously on ADB. The standby database (ADB provisions a standby automatically) provides the repair source. When a corruption is detected in the primary, ADB repairs the block from the standby without human intervention and without I/O errors reaching the application (for media recovery scenarios).

**DBA visibility**:
- \`V$DATABASE_BLOCK_CORRUPTION\` — should always be empty in a healthy ADB; any rows indicate active corruption not yet repaired
- \`V$RMAN_STATUS\` — recent RMAN operations including repair operations

### 5. Resource Manager Monitor

ADB's Consumer Group mapping monitors session resource consumption and automatically moves sessions between resource groups when thresholds are exceeded. A long-running query consuming excessive CPU will be throttled by moving it to a lower-priority consumer group.

**DBA visibility**:
- \`V$RSRC_CONSUMER_GROUP\` — current CPU and session counts per consumer group
- \`V$RSRC_PLAN\` — the active Resource Manager plan

### 6. Undo and Temp Space Monitor

ADB monitors UNDO_RETENTION compliance and temp segment growth. Temp files are extended automatically when a sort or hash join operation requires more space than currently allocated.

**DBA visibility**:
- \`DBA_TABLESPACE_USAGE_METRICS\` — used space, allocated space, and usage percentage per tablespace including TEMP and UNDO

### 7. Auto-Scaling Trigger Monitor

When ECPU utilization exceeds the auto-scaling threshold (typically 75% of base ECPU for a sustained period), ADB scales up to 3x the base ECPU. This is an OCI-level operation — the database itself does not expose this via \`V$\` views.

**DBA visibility**: OCI Metrics only — \`CpuUtilization\` metric in the \`oci_autonomous_database\` namespace.

---

## The Monitoring Gap: What ADB Does NOT Do

ADB's internal monitors are comprehensive for infrastructure health. The gap is in application-level and operational observability.

**Application-level query performance SLAs**: ADB optimizes query plans but does not know if a query running in 5 seconds is acceptable or a violation of your application's SLA. You must define the SLA threshold and monitor \`V$SQL\` for queries exceeding it.

**Connection pool exhaustion**: ADB does not alert when your connection pool approaches the service limit. The \`_low\` service allows up to 300 concurrent sessions by default. At the limit, new connections receive \`ORA-12520: TNS:listener could not find available handler\`. You must monitor \`V$SESSION\` count against your service limits proactively.

**Excessive failed login attempts**: ADB does not alert on repeated authentication failures — a pattern consistent with brute-force attacks. You must query \`UNIFIED_AUDIT_TRAIL\` for \`LOGON\` actions with non-zero \`RETURN_CODE\` values.

**Long-running transactions holding locks**: ADB does not alert when transactions are blocked for more than N minutes, even when the blockage is causing application timeouts. You must monitor \`V$LOCK\` and \`V$SESSION\` for blocking lock chains.

**Storage approaching provisioned maximum**: ADB sends an OCI Event when storage hits 95% but does not auto-provision additional storage beyond the provisioned maximum without manual action (unless storage auto-scaling is enabled separately from compute auto-scaling). By the time the event fires at 95%, you have limited runway.

**Maintenance window impact on applications**: ADB does not notify application teams when a switchover for patching causes a brief connection interruption. Applications using connection pools with no reconnect logic will experience errors during the reconnect window. You must monitor application error logs or wire up OCI Events to ADB lifecycle state change notifications.

---

## The Monitoring Architecture: Three Layers

A complete ADB monitoring strategy uses three complementary layers, each with different granularity, latency, and use cases.

| Layer | Source | Latency | Best For |
|---|---|---|---|
| In-Database SQL | V$ and DBA_ views | Sub-second | Current state, active sessions, lock analysis, query snapshots |
| OCI Metrics | OCI Monitoring service | 1-minute resolution | Trending, capacity planning, automated alarms |
| OCI Events + Notifications | OCI Events service | Near-real-time | Lifecycle notifications, on-call alerting |

**Layer 1 — In-database SQL queries** are available via SQL Worksheet in Database Actions, SQL*Plus, or any JDBC/ODBC client with an ADB wallet. They give you the highest granularity and the most context — you can join \`V$SESSION\` to \`V$SQL\` to \`V$LOCK\` in a single query. The limitation: you must actively run the query. There is no push model.

**Layer 2 — OCI Metrics** are time-series metrics published by the ADB service every minute to OCI Monitoring. The metric namespace is \`oci_autonomous_database\`. Key metrics include \`CpuUtilization\`, \`StorageUtilization\`, \`CurrentLogons\`, \`ExecuteCount\`, \`UserCallsPerSec\`, and \`TransactionsPerSec\`. OCI Alarms evaluate these metrics and trigger notifications when thresholds are exceeded.

**Layer 3 — OCI Events + Notifications** provides event-driven alerts on ADB lifecycle state changes. When ADB transitions from AVAILABLE to UPDATING (during a patch), or from AVAILABLE to STOPPED, OCI Events publishes an event. You can route these events to an OCI Notification Topic (which can send email, SMS, PagerDuty webhook, or Slack) and to OCI Functions for automated remediation.

---

## The Complete Self-Monitoring Script Library

The following five scripts implement a complete monitoring layer. Design principles: all scripts are idempotent, produce structured output with clear section headers, and can be automated via cron or \`DBMS_SCHEDULER\`. SQL scripts assume connection as ADMIN or a user with DBA role on ADB.

---

### Script 1: In-Database Health Snapshot (SQL)

This SQL script produces a structured health report covering database identity, active connections, top SQL, waiting sessions, auto-index activity, storage, failed logins, and long-running transactions. Run this script at the start of every on-call shift or include it in an hourly \`DBMS_SCHEDULER\` job that spools output to a table.

\`\`\`sql
-- ADB Health Snapshot
-- Run as ADMIN or a DBA-privileged user
-- Compatible with Oracle Autonomous Database (all versions)
SET LINESIZE 200
SET PAGESIZE 50
SET FEEDBACK OFF
SET TRIMSPOOL ON

PROMPT ============================================================
PROMPT ADB HEALTH SNAPSHOT
PROMPT ============================================================

PROMPT
PROMPT --- DATABASE IDENTITY ---
SELECT name            AS db_name,
       db_unique_name,
       open_mode,
       database_role,
       current_scn,
       TO_CHAR(created, 'YYYY-MM-DD') AS created
FROM   v\$database;

PROMPT
PROMPT --- ACTIVE CONNECTIONS BY SERVICE ---
SELECT s.service_name,
       COUNT(*)                                                  AS session_count,
       SUM(CASE WHEN s.status = 'ACTIVE'   THEN 1 ELSE 0 END)  AS active,
       SUM(CASE WHEN s.status = 'INACTIVE' THEN 1 ELSE 0 END)  AS inactive
FROM   v\$session s
WHERE  s.type = 'USER'
GROUP  BY s.service_name
ORDER  BY session_count DESC;

PROMPT
PROMPT --- TOP 10 SQL BY ELAPSED TIME (LAST 1 HOUR) ---
SELECT sql_id,
       ROUND(elapsed_time / 1000000, 2)                              AS elapsed_sec,
       executions,
       ROUND(elapsed_time / 1000000 / NULLIF(executions, 0), 3)     AS avg_sec,
       buffer_gets,
       disk_reads,
       SUBSTR(sql_text, 1, 80)                                       AS sql_preview
FROM   v\$sql
WHERE  last_active_time > SYSDATE - 1/24
  AND  executions > 0
ORDER  BY elapsed_time DESC
FETCH FIRST 10 ROWS ONLY;

PROMPT
PROMPT --- SESSIONS WAITING MORE THAN 30 SECONDS ---
SELECT s.sid,
       s.serial#,
       s.username,
       s.event,
       s.seconds_in_wait,
       s.state,
       SUBSTR(s.sql_id, 1, 13) AS sql_id
FROM   v\$session s
WHERE  s.type = 'USER'
  AND  s.seconds_in_wait > 30
ORDER  BY s.seconds_in_wait DESC;

PROMPT
PROMPT --- AUTO-INDEX ACTIVITY (LAST 24 HOURS) ---
SELECT action_time,
       index_name,
       table_name,
       indexing_status,
       ROUND(index_size / 1024 / 1024, 2) AS index_mb,
       error_message
FROM   dba_auto_index_ind_actions
WHERE  action_time > SYSDATE - 1
ORDER  BY action_time DESC
FETCH FIRST 20 ROWS ONLY;

PROMPT
PROMPT --- STORAGE UTILIZATION BY TABLESPACE ---
SELECT tablespace_name,
       ROUND(used_space      * 8192 / 1024 / 1024 / 1024, 3) AS used_gb,
       ROUND(tablespace_size * 8192 / 1024 / 1024 / 1024, 3) AS allocated_gb,
       ROUND(used_percent, 1)                                 AS used_pct
FROM   dba_tablespace_usage_metrics
ORDER  BY used_pct DESC;

PROMPT
PROMPT --- FAILED LOGINS (LAST 24 HOURS) ---
SELECT db_username,
       os_username,
       userhost,
       COUNT(*)                AS failure_count,
       MAX(event_timestamp)    AS last_attempt
FROM   unified_audit_trail
WHERE  action_name  = 'LOGON'
  AND  return_code != 0
  AND  event_timestamp > SYSTIMESTAMP - INTERVAL '24' HOUR
GROUP  BY db_username, os_username, userhost
ORDER  BY failure_count DESC
FETCH FIRST 10 ROWS ONLY;

PROMPT
PROMPT --- LONG UNCOMMITTED TRANSACTIONS (MORE THAN 5 MINUTES) ---
SELECT s.sid,
       s.serial#,
       s.username,
       ROUND(
         (SYSDATE - TO_DATE('01-JAN-1970','DD-MON-YYYY'))
         - t.start_time / (60 * 60 * 24),
         4
       ) * 1440                    AS txn_age_min,
       t.used_ublk * 8192 / 1024  AS undo_kb
FROM   v\$transaction t
JOIN   v\$session s ON t.ses_addr = s.saddr
WHERE (
  (SYSDATE - TO_DATE('01-JAN-1970','DD-MON-YYYY'))
  - t.start_time / (60 * 60 * 24)
) > 5 / 1440
ORDER  BY txn_age_min DESC;
\`\`\`

Schedule this script using \`DBMS_SCHEDULER\` with a spool target, or run it on demand from SQL Worksheet in ADB's Database Actions console. The output is plain text, making it suitable for email delivery via an OCI Function.

---

### Script 2: OCI CLI Metrics Collector (Shell)

This script pulls OCI Metrics for an ADB instance, evaluates each metric against a threshold, and outputs a structured report with ALERT lines when thresholds are exceeded. It exits with code 1 if any alert fires, making it suitable for integration with monitoring frameworks that evaluate exit codes (Nagios, Icinga, Datadog agent checks).

The script runs from any machine with OCI CLI configured and network access to OCI APIs — not from within the database. Set environment variables \`ADB_OCID\`, \`COMPARTMENT_ID\`, and optionally \`OCI_PROFILE\` before running.

\`\`\`bash
#!/usr/bin/env bash
# adb_metrics_check.sh
# Usage: ADB_OCID=<ocid> COMPARTMENT_ID=<ocid> ./adb_metrics_check.sh
# Requires: OCI CLI configured, jq installed
set -euo pipefail

ADB_OCID="\${ADB_OCID:?Set ADB_OCID to the ADB instance OCID}"
COMPARTMENT_ID="\${COMPARTMENT_ID:?Set COMPARTMENT_ID}"
OCI_PROFILE="\${OCI_PROFILE:-DEFAULT}"
NAMESPACE="oci_autonomous_database"

# Thresholds
CPU_WARN=75
CPU_CRIT=85
STORAGE_WARN=80
STORAGE_CRIT=90
LOGONS_WARN=240   # 80% of 300 default _low limit
LOGONS_CRIT=285   # 95% of 300

ALERT_COUNT=0
END_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
START_TIME_5M=$(date -u -v-5M +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
  || date -u -d "5 minutes ago" +"%Y-%m-%dT%H:%M:%SZ")
START_TIME_1H=$(date -u -v-60M +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
  || date -u -d "60 minutes ago" +"%Y-%m-%dT%H:%M:%SZ")

echo "===================================================================="
echo "ADB OCI METRICS REPORT"
echo "ADB OCID : \${ADB_OCID}"
echo "Timestamp: \${END_TIME}"
echo "===================================================================="

fetch_metric() {
  local METRIC_NAME="\$1"
  local START="\$2"
  local STAT="\$3"   # mean | max
  oci monitoring metric-data summarize-metrics-data \
    --compartment-id "\${COMPARTMENT_ID}" \
    --namespace "\${NAMESPACE}" \
    --query-text "\${METRIC_NAME}[1m]{resourceId = \"\${ADB_OCID}\"}.\${STAT}()" \
    --start-time "\${START}" \
    --end-time "\${END_TIME}" \
    --profile "\${OCI_PROFILE}" \
    --output json 2>/dev/null \
  | jq -r '
      .data[0].aggregatedDatapoints
      | if . == null or length == 0 then "N/A"
        else (.[length-1].value | . * 100 | round / 100 | tostring)
        end
    '
}

check_threshold() {
  local LABEL="\$1"
  local VALUE="\$2"
  local WARN="\$3"
  local CRIT="\$4"
  local UNIT="\$5"

  if [ "\${VALUE}" = "N/A" ]; then
    echo "  \${LABEL}: N/A (no data returned)"
    return
  fi

  local INT_VAL
  INT_VAL=$(printf "%.0f" "\${VALUE}")

  if [ "\${INT_VAL}" -ge "\${CRIT}" ]; then
    echo "  ALERT CRITICAL \${LABEL}: \${VALUE}\${UNIT} (threshold: \${CRIT}\${UNIT})"
    ALERT_COUNT=$((ALERT_COUNT + 1))
  elif [ "\${INT_VAL}" -ge "\${WARN}" ]; then
    echo "  ALERT WARNING  \${LABEL}: \${VALUE}\${UNIT} (threshold: \${WARN}\${UNIT})"
    ALERT_COUNT=$((ALERT_COUNT + 1))
  else
    echo "  OK             \${LABEL}: \${VALUE}\${UNIT}"
  fi
}

echo ""
echo "--- CPU UTILIZATION ---"
CPU_5M=$(fetch_metric "CpuUtilization" "\${START_TIME_5M}" "mean")
CPU_1H_PEAK=$(fetch_metric "CpuUtilization" "\${START_TIME_1H}" "max")
echo "  5-min avg : \${CPU_5M}%"
echo "  1-hour max: \${CPU_1H_PEAK}%"
check_threshold "CpuUtilization (5m avg)" "\${CPU_5M}" "\${CPU_WARN}" "\${CPU_CRIT}" "%"

echo ""
echo "--- STORAGE UTILIZATION ---"
STORAGE=$(fetch_metric "StorageUtilization" "\${START_TIME_5M}" "mean")
check_threshold "StorageUtilization" "\${STORAGE}" "\${STORAGE_WARN}" "\${STORAGE_CRIT}" "%"

echo ""
echo "--- CURRENT LOGONS ---"
LOGONS=$(fetch_metric "CurrentLogons" "\${START_TIME_5M}" "mean")
check_threshold "CurrentLogons" "\${LOGONS}" "\${LOGONS_WARN}" "\${LOGONS_CRIT}" " sessions"

echo ""
echo "--- TRANSACTION RATE ---"
TPS=$(fetch_metric "TransactionsPerSec" "\${START_TIME_5M}" "mean")
echo "  TransactionsPerSec (5m avg): \${TPS}"

echo ""
echo "--- EXECUTE COUNT AND USER CALLS ---"
EXEC=$(fetch_metric "ExecuteCount" "\${START_TIME_5M}" "mean")
UCALLS=$(fetch_metric "UserCallsPerSec" "\${START_TIME_5M}" "mean")
echo "  ExecuteCount      (5m avg): \${EXEC}"
echo "  UserCallsPerSec   (5m avg): \${UCALLS}"

echo ""
echo "===================================================================="
echo "SUMMARY: \${ALERT_COUNT} alert(s) fired"
echo "===================================================================="

[ "\${ALERT_COUNT}" -eq 0 ] && exit 0 || exit 1
\`\`\`

Run this script from cron every 5 minutes. Pipe the output to a log file and send an email when the exit code is non-zero. Combine with the OCI Alarms in Script 5 for a belt-and-suspenders approach: the shell script provides per-run granularity with custom logic; OCI Alarms provide persistent alerting when you cannot run the script.

---

### Script 3: Auto-Index Effectiveness Report (SQL)

This report answers the question your storage and DBA team will ask: "Is automatic indexing helping or just consuming space?" It shows creation and drop activity over 30 days, net space consumed versus SQL performance improvement, and the top five queries that benefited most.

\`\`\`sql
-- Auto-Index Effectiveness Report
-- Run as ADMIN or user with SELECT on DBA_AUTO_INDEX_* and DBA_SEGMENTS
SET LINESIZE 200
SET PAGESIZE 100
SET FEEDBACK OFF

PROMPT ============================================================
PROMPT AUTO-INDEX EFFECTIVENESS REPORT (LAST 30 DAYS)
PROMPT ============================================================

PROMPT
PROMPT --- INDEX ACTION SUMMARY ---
SELECT indexing_status,
       COUNT(*)                                    AS action_count,
       ROUND(SUM(index_size) / 1024 / 1024, 1)   AS total_mb
FROM   dba_auto_index_ind_actions
WHERE  action_time > SYSDATE - 30
GROUP  BY indexing_status
ORDER  BY action_count DESC;

PROMPT
PROMPT --- EXECUTION CYCLE SUMMARY (LAST 30 DAYS) ---
SELECT TO_CHAR(execution_start, 'YYYY-MM-DD')   AS exec_date,
       COUNT(*)                                  AS cycles,
       SUM(indexes_created)                      AS created,
       SUM(indexes_dropped)                      AS dropped,
       SUM(indexes_verified)                     AS verified
FROM   dba_auto_index_executions
WHERE  execution_start > SYSDATE - 30
GROUP  BY TO_CHAR(execution_start, 'YYYY-MM-DD')
ORDER  BY exec_date DESC
FETCH FIRST 30 ROWS ONLY;

PROMPT
PROMPT --- SPACE CONSUMED BY AUTO-INDEXES CURRENTLY IN PLACE ---
SELECT a.index_name,
       a.table_name,
       a.indexing_status,
       TO_CHAR(a.action_time, 'YYYY-MM-DD HH24:MI')  AS created_at,
       ROUND(s.bytes / 1024 / 1024, 2)               AS current_mb
FROM   dba_auto_index_ind_actions a
LEFT JOIN dba_segments s ON s.segment_name = a.index_name
WHERE  a.indexing_status = 'ACTIVE'
ORDER  BY s.bytes DESC NULLS LAST
FETCH FIRST 20 ROWS ONLY;

PROMPT
PROMPT --- RECENT ERRORS IN AUTO-INDEX CYCLES ---
SELECT TO_CHAR(action_time, 'YYYY-MM-DD HH24:MI')  AS action_time,
       index_name,
       table_name,
       error_message
FROM   dba_auto_index_ind_actions
WHERE  error_message IS NOT NULL
  AND  action_time > SYSDATE - 30
ORDER  BY action_time DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

Review this report monthly. If \`indexes_created\` consistently exceeds \`indexes_dropped\`, your auto-index space consumption grows unbounded — set the \`AUTO_INDEX_MAX_SCHEMA_SIZE\` parameter to cap it. If the error section shows repeated failures for the same table, the table may have schema characteristics (e.g., long index key length) that prevent automatic index creation.

---

### Script 4: Connection Pool Saturation Monitor (SQL)

Connection exhaustion is one of the most operationally disruptive events on ADB — applications fail immediately when the limit is reached. This script monitors session counts per service and outputs a warning row when any service exceeds 80% of its target limit. Integrate this into an hourly \`DBMS_SCHEDULER\` job that writes results to a monitoring table.

\`\`\`sql
-- Connection Pool Saturation Monitor
-- Run as ADMIN or user with SELECT on V$SESSION, V$RSRC_CONSUMER_GROUP
SET LINESIZE 200
SET PAGESIZE 100
SET FEEDBACK OFF

PROMPT ============================================================
PROMPT CONNECTION POOL SATURATION MONITOR
PROMPT ============================================================

PROMPT
PROMPT --- SESSION COUNTS BY SERVICE AND STATUS ---
SELECT service_name,
       COUNT(*)                                                    AS total_sessions,
       SUM(CASE WHEN status = 'ACTIVE'   THEN 1 ELSE 0 END)      AS active,
       SUM(CASE WHEN status = 'INACTIVE' THEN 1 ELSE 0 END)      AS inactive,
       SUM(CASE WHEN status = 'KILLED'   THEN 1 ELSE 0 END)      AS killed
FROM   v\$session
WHERE  type = 'USER'
GROUP  BY service_name
ORDER  BY total_sessions DESC;

PROMPT
PROMPT --- RESOURCE MANAGER: CURRENT CONSUMER GROUP USAGE ---
SELECT name                                            AS consumer_group,
       active_sessions,
       execution_waiters,
       requests,
       cpu_wait_time,
       cpu_waits
FROM   v\$rsrc_consumer_group
WHERE  active_sessions > 0
   OR  execution_waiters > 0
ORDER  BY active_sessions DESC;

PROMPT
PROMPT --- SATURATION ALERT: SERVICES ABOVE 80 PERCENT OF 300-SESSION LIMIT ---
-- ADB default: 300 concurrent sessions on the _low service
-- Adjust the threshold (240 = 80% of 300) per your ADB shape and service limits
SELECT service_name,
       session_count,
       ROUND(session_count / 300 * 100, 1)   AS pct_of_300,
       CASE
         WHEN session_count >= 285 THEN 'CRITICAL (> 95%)'
         WHEN session_count >= 240 THEN 'WARNING  (> 80%)'
         ELSE 'OK'
       END                                    AS status
FROM (
  SELECT service_name,
         COUNT(*) AS session_count
  FROM   v\$session
  WHERE  type = 'USER'
  GROUP  BY service_name
)
WHERE session_count >= 240
ORDER  BY session_count DESC;

PROMPT
PROMPT --- SESSIONS BY PROGRAM (TOP 10) ---
SELECT program,
       COUNT(*)                                                    AS session_count,
       SUM(CASE WHEN status = 'ACTIVE'   THEN 1 ELSE 0 END)      AS active
FROM   v\$session
WHERE  type = 'USER'
  AND  program IS NOT NULL
GROUP  BY program
ORDER  BY session_count DESC
FETCH FIRST 10 ROWS ONLY;

PROMPT
PROMPT --- BLOCKING LOCK CHAINS ---
SELECT blocker.sid                                AS blocker_sid,
       blocker.username                           AS blocker_user,
       blocker.sql_id                             AS blocker_sql,
       waiter.sid                                 AS waiter_sid,
       waiter.username                            AS waiter_user,
       waiter.seconds_in_wait                     AS wait_seconds,
       waiter.event                               AS wait_event
FROM   v\$session blocker
JOIN   v\$session waiter ON waiter.blocking_session = blocker.sid
WHERE  waiter.blocking_session IS NOT NULL
ORDER  BY waiter.seconds_in_wait DESC;
\`\`\`

The blocking lock chain section is particularly important: ADB does not automatically kill blocking sessions. A blocker that has been idle for hours while holding a lock will block all dependent sessions indefinitely. This section identifies the chain so the on-call DBA can decide whether to kill the blocking session.

---

### Script 5: OCI Alarm and Notification Setup (CLI)

This script creates the full OCI alerting infrastructure: a Notification Topic, an email subscription, and four OCI Alarms covering critical ADB metrics, plus an OCI Events rule for lifecycle state changes.

Replace \`\${COMPARTMENT_ID}\`, \`\${ADB_OCID}\`, and \`\${ALERT_EMAIL}\` with your values before running. The script is idempotent in intent but not in implementation — running it twice creates duplicate alarms. Wrap in a check or use \`--if-not-exists\` where supported.

\`\`\`bash
#!/usr/bin/env bash
# adb_alarm_setup.sh
# Creates OCI Notification Topic, email subscription, and ADB metric alarms
set -euo pipefail

COMPARTMENT_ID="\${COMPARTMENT_ID:?}"
ADB_OCID="\${ADB_OCID:?}"
ALERT_EMAIL="\${ALERT_EMAIL:?}"
TOPIC_NAME="adb-monitoring-alerts"
PROFILE="\${OCI_PROFILE:-DEFAULT}"

echo "Creating Notification Topic..."
TOPIC_OCID=$(oci ons topic create \
  --compartment-id "\${COMPARTMENT_ID}" \
  --name "\${TOPIC_NAME}" \
  --description "ADB self-monitoring alert topic" \
  --profile "\${PROFILE}" \
  --query 'data."topic-id"' \
  --raw-output)
echo "Topic OCID: \${TOPIC_OCID}"

echo "Subscribing \${ALERT_EMAIL} to topic..."
oci ons subscription create \
  --compartment-id "\${COMPARTMENT_ID}" \
  --topic-id "\${TOPIC_OCID}" \
  --protocol "EMAIL" \
  --subscription-endpoint "\${ALERT_EMAIL}" \
  --profile "\${PROFILE}"
echo "Subscription created. Confirm the email before alarms can deliver."

# Helper to create an alarm
create_alarm() {
  local NAME="\$1"
  local QUERY="\$2"
  local OPERATOR="\$3"
  local VALUE="\$4"
  local PENDING_DURATION="\$5"
  local SEVERITY="\$6"
  local BODY="\$7"

  oci monitoring alarm create \
    --compartment-id "\${COMPARTMENT_ID}" \
    --display-name "\${NAME}" \
    --metric-compartment-id "\${COMPARTMENT_ID}" \
    --namespace "oci_autonomous_database" \
    --query-text "\${QUERY}" \
    --severity "\${SEVERITY}" \
    --destinations "[\"\\\${TOPIC_OCID}\"]" \
    --is-enabled true \
    --pending-duration "\${PENDING_DURATION}" \
    --body "\${BODY}" \
    --comparison-operator "\${OPERATOR}" \
    --threshold "\${VALUE}" \
    --profile "\${PROFILE}" \
    --output json | jq -r '.data."display-name" + " alarm created: " + .data.id'
}

echo ""
echo "Creating CPU alarm (critical >= 85% for 5 minutes)..."
create_alarm \
  "ADB-CPU-Critical" \
  "CpuUtilization[1m]{resourceId = \"\${ADB_OCID}\"}.mean()" \
  "GREATER_THAN_OR_EQUAL_TO" \
  "85" \
  "PT5M" \
  "CRITICAL" \
  "ADB CPU utilization is at or above 85% for 5 minutes. Review active sessions and consider scaling up."

echo "Creating Storage alarm (warning >= 80%)..."
create_alarm \
  "ADB-Storage-Warning" \
  "StorageUtilization[1m]{resourceId = \"\${ADB_OCID}\"}.mean()" \
  "GREATER_THAN_OR_EQUAL_TO" \
  "80" \
  "PT5M" \
  "WARNING" \
  "ADB storage utilization is at or above 80%. Review large segments and consider enabling storage auto-scaling."

echo "Creating Storage alarm (critical >= 90%)..."
create_alarm \
  "ADB-Storage-Critical" \
  "StorageUtilization[1m]{resourceId = \"\${ADB_OCID}\"}.mean()" \
  "GREATER_THAN_OR_EQUAL_TO" \
  "90" \
  "PT5M" \
  "CRITICAL" \
  "ADB storage utilization is at or above 90%. Immediate action required to avoid ORA-01654 errors."

echo "Creating CurrentLogons alarm (warning >= 240)..."
create_alarm \
  "ADB-Logons-Warning" \
  "CurrentLogons[1m]{resourceId = \"\${ADB_OCID}\"}.mean()" \
  "GREATER_THAN_OR_EQUAL_TO" \
  "240" \
  "PT2M" \
  "WARNING" \
  "ADB concurrent sessions are at or above 240 (80% of 300 default limit). Review connection pool configuration."

echo ""
echo "Creating OCI Events rule for ADB lifecycle state changes..."
oci events rule create \
  --compartment-id "\${COMPARTMENT_ID}" \
  --display-name "ADB-StateChange-Events" \
  --description "Notify on ADB state changes: patching, stopped, failed" \
  --is-enabled true \
  --condition '{
    "eventType": [
      "com.oraclecloud.databaseservice.autonomous.database.update.end",
      "com.oraclecloud.databaseservice.autonomous.database.stop.end",
      "com.oraclecloud.databaseservice.autonomous.database.autonomous.database.critical"
    ],
    "data": {
      "resourceId": ["\${ADB_OCID}"]
    }
  }' \
  --actions '{
    "actions": [{
      "actionType": "ONS",
      "topicId": "\${TOPIC_OCID}",
      "isEnabled": true,
      "description": "Send ADB lifecycle events to monitoring topic"
    }]
  }' \
  --profile "\${PROFILE}" \
  --output json | jq -r '.data."display-name" + " rule created"'

echo ""
echo "===================================================================="
echo "Setup complete."
echo "Topic OCID : \${TOPIC_OCID}"
echo "Confirm the email subscription at \${ALERT_EMAIL} to activate delivery."
echo "===================================================================="
\`\`\`

After running this script, OCI will send a confirmation email to \`\${ALERT_EMAIL}\`. The subscription is not active until the link in that email is clicked. Test each alarm by temporarily lowering the threshold, verifying you receive the notification, then restoring the original threshold.

---

## Putting It Together: An Operational Runbook

With all five scripts in place, the operational pattern for ADB monitoring looks like this:

1. **Hourly**: \`DBMS_SCHEDULER\` runs Script 1 (health snapshot) and Script 4 (connection saturation) inside the database. Results are written to a \`MONITORING_LOG\` table. A weekly batch query from that table detects trends.

2. **Every 5 minutes**: Script 2 (OCI CLI metrics collector) runs from an OCI Compute instance or an OCI DevOps build pipeline. Alert output is captured; non-zero exit triggers a PagerDuty call.

3. **Monthly**: Script 3 (auto-index effectiveness) runs manually or via scheduler. Output is reviewed in the DBA team's monthly capacity meeting.

4. **Continuously**: OCI Alarms from Script 5 evaluate metrics every minute. The OCI Events rule fires within seconds of an ADB state change. Your operations team receives email (and optionally SMS or Slack via the topic subscription) for any critical threshold breach or lifecycle event.

This four-layer cadence ensures no single monitoring gap: continuous OCI Alarms cover the metric surface, the 5-minute shell script provides custom logic and integrates with existing monitoring frameworks, hourly SQL snapshots capture session-level state that OCI Metrics do not expose, and the monthly effectiveness report closes the capacity planning loop.

---

## Future of ADB Observability

Oracle's roadmap for ADB monitoring addresses each of the current gaps with capabilities that push further toward autonomous observability.

### Operations Insights AI Recommendations

Oracle Operations Insights already provides SQL warehouse capacity planning and fleet-level AWR trending. The near-term roadmap adds AI-generated recommendations delivered as actionable suggestions in the OCI Console: "this database's workload pattern shows consistent idle periods on weekends — scaling down to 2 ECPU on Saturday and Sunday would reduce cost by approximately 28% with no performance impact." These recommendations will be dismissable, schedulable (apply this recommendation in the next maintenance window), and auditable (who approved this recommendation and when).

For teams managing ADB fleets of 10 or more instances, Operations Insights recommendations eliminate the manual capacity analysis that currently requires an experienced DBA to run AWR comparison reports across instances.

### Autonomous Health Framework Integration

AHF (Autonomous Health Framework, formerly TFA — Trace File Analyzer) is Oracle's support diagnostic tool. On ADB, AHF integration means Oracle Support can trigger diagnostic collection automatically when the cloud service detects anomalies, before you open a support request. The system detects an anomaly pattern (e.g., repeated ORA-600 internal errors during a specific operation), collects all relevant trace files, and associates them with your tenancy's support history. Time-to-resolution for support cases decreases because the diagnostic data is already collected by the time the support engineer looks at the ticket.

### Select AI for Monitoring Queries

The natural language interface Select AI is being extended to monitoring use cases. Instead of writing \`V$SESSION\` join queries, a DBA will type "show me all sessions that have been blocked for more than 10 minutes" into the SQL Worksheet prompt, and Select AI will generate and execute the query. More advanced queries — "which queries degraded in execution time compared to last week?" — currently require AWR comparison scripts; Select AI will translate the natural language intent into the appropriate AWR join against \`DBA_HIST_SQLSTAT\`.

This does not eliminate the need for DBAs to understand the underlying views — when Select AI generates an incorrect query, the DBA still needs to diagnose why. But it significantly reduces the time to first result for less-familiar team members handling an on-call incident.

### OCI Monitoring SQL Extension

Oracle is extending OCI Monitoring to support SQL-based custom metric definitions. Today, OCI Metrics are published by the ADB service and cover infrastructure metrics. The SQL Extension will allow DBAs to define custom metrics derived from \`V$\` queries that feed into the same OCI Alarms and Dashboards infrastructure. For example: a metric called "OrdersProcessedPerMinute" derived from a \`COUNT(*)\` against an application orders table, refreshed every minute. When this metric drops below the expected rate, an OCI Alarm fires — providing business-level observability alongside infrastructure metrics in the same alerting framework.

### Unified Observability with OpenTelemetry

Oracle is publishing OpenTelemetry-compatible metrics and traces from ADB, allowing ADB metrics to flow into third-party observability platforms — Grafana, Datadog, Splunk, New Relic — using the OTLP protocol without OCI-specific tooling. Organizations that have already invested in a central observability platform will be able to add ADB metrics to existing dashboards rather than building parallel OCI Monitoring dashboards.

The OTLP export covers the same metric namespace as OCI Monitoring (\`oci_autonomous_database\`) and adds query-level trace spans, allowing correlation between a slow database query and application-level traces in the same Grafana dashboard. This is the largest structural change to ADB observability: moving from a pull model (query OCI Metrics API) to a push model (ADB emits spans and metrics to your OTLP endpoint) aligns ADB with modern cloud-native observability architectures.

---

## Summary

ADB is self-healing and self-tuning, but it is not self-aware from your operations team's perspective. The database silently fixes itself — but your pager stays quiet unless you wire it up. The five scripts in this post build the wiring:

| Script | Purpose | Runtime |
|---|---|---|
| Script 1: Health Snapshot | In-database SQL covering sessions, SQL, storage, audit | DBMS_SCHEDULER or on-demand |
| Script 2: OCI Metrics Collector | Shell script pulling OCI Metrics with threshold alerting | Cron, every 5 minutes |
| Script 3: Auto-Index Effectiveness | SQL report on auto-index activity and space consumed | Monthly review |
| Script 4: Connection Saturation Monitor | Session count vs service limits, blocking lock chains | DBMS_SCHEDULER, hourly |
| Script 5: OCI Alarm Setup | CLI script creating OCI Alarms and Event rules | One-time setup |

The three-layer monitoring architecture — in-database SQL, OCI Metrics alarms, and OCI Events notifications — covers the gaps that ADB's autonomous operations leave open: application SLA enforcement, connection pool saturation, authentication anomalies, lock chain detection, and lifecycle event notification.

The future direction — AI recommendations from Operations Insights, Select AI for monitoring queries, SQL-based custom OCI metrics, and OpenTelemetry export — moves toward a monitoring layer that monitors itself as autonomously as ADB manages itself. Until that infrastructure matures, these scripts are the production-ready bridge between ADB's autonomous internals and your operations team's visibility.`,
};

async function main() {
  console.log('Inserting ADB self-monitoring blog post...');
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
