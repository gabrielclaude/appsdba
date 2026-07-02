import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Autonomous Database Self-Monitoring Runbook: Complete Script Library for Proactive Observability',
  slug: 'oracle-autonomous-database-self-monitoring-runbook',
  excerpt: 'A script-heavy DBA runbook for Oracle Autonomous Database self-monitoring: environment setup, OCI CLI metrics polling, SQL health checks, auto-index reporting, lock detection, undo and storage tracking, security audit queries, OCI alarm wiring, crontab scheduling, and a complete daily report script.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-01'),
  youtubeUrl: null,
  content: `# Oracle Autonomous Database Self-Monitoring Runbook: Complete Script Library for Proactive Observability

Oracle Autonomous Database automates patching, tuning, and backups — but it does not automate the monitoring posture your team needs to catch performance degradation, storage creep, lock storms, security anomalies, and failed logins before they become incidents. This runbook provides every script your DBA team needs to build a complete, self-contained observability stack around an ADB Serverless or Dedicated instance: shell scripts, embedded SQL, OCI CLI alarm wiring, DBMS_SCHEDULER jobs, and crontab definitions. All scripts are production-ready and parameterised through a central configuration file.

---

## Phase 1: Environment Setup for Monitoring

### 1.1 Prerequisites

The monitoring host (a bastion, compute instance, or on-premises jump server with private endpoint access to the ADB) must have the following tools installed and configured before any script in this runbook will work:

- **OCI CLI** — installed and configured with a valid API key in \`~/.oci/config\`. Verify with \`oci iam region list\`.
- **SQLcl** — Oracle's replacement for SQL*Plus with JSON output and Liquibase integration. Download from oracle.com/sqlcl. Alternatively, SQL*Plus with Instant Client works for every SQL script in this runbook.
- **ADB wallet** — downloaded and extracted to a stable path (e.g., \`/opt/oracle/wallet/myadb\`). The \`sqlnet.ora\` inside the wallet must have the \`DIRECTORY\` path updated to the extraction location.
- **jq** — JSON command-line processor used heavily for OCI CLI output parsing. Install with \`yum install jq\` or \`apt install jq\`.
- **bc** — arbitrary precision calculator, used for floating-point threshold comparisons in bash. Usually pre-installed on Linux.
- **sendmail or curl** — used to deliver alert emails. OCI Notifications REST endpoint via \`curl\` is the preferred approach in cloud environments.

### 1.2 Monitoring Configuration File

Create the central configuration file that all scripts source at startup. Every threshold and path is defined here so that nothing is hard-coded in individual scripts.

\`\`\`bash
# Create the configuration directory
mkdir -p /etc/adb_monitor

cat > /etc/adb_monitor/adb_monitor.conf << 'EOF'
# ADB Monitor Configuration
ADB_OCID="ocid1.autonomousdatabase.oc1..."
COMPARTMENT_ID="ocid1.compartment.oc1..."
OCI_PROFILE="DEFAULT"
ADB_SERVICE="MYADB_high"
TNS_ADMIN="/opt/oracle/wallet/myadb"
ADMIN_USER="ADMIN"
ADMIN_PASSWORD="<password>"
REPORT_DIR="/var/log/adb_monitor"
ALERT_EMAIL="dba-oncall@company.com"
CPU_WARN_PCT=75
CPU_CRIT_PCT=90
STORAGE_WARN_PCT=80
STORAGE_CRIT_PCT=90
LOGON_WARN_COUNT=200
LOGON_CRIT_COUNT=280
FAILED_LOGIN_WARN=10
TXN_AGE_WARN_MIN=30
LOCK_WAIT_WARN_SEC=60
EOF

chmod 640 /etc/adb_monitor/adb_monitor.conf
chown root:oracledba /etc/adb_monitor/adb_monitor.conf
\`\`\`

Keep the file readable only by root and the monitoring OS user (\`oracledba\` in this example). The \`ADMIN_PASSWORD\` field is the highest-risk secret in this configuration — consider replacing it with a reference to OCI Vault using \`oci secrets secret-bundle get\` and sourcing it at script runtime instead of storing it in plaintext.

### 1.3 Monitoring Directories and Log Rotation

\`\`\`bash
mkdir -p /var/log/adb_monitor/daily
mkdir -p /var/log/adb_monitor/alerts

cat > /etc/logrotate.d/adb-monitor << 'EOF'
/var/log/adb_monitor/*.log {
    daily
    rotate 30
    compress
    missingok
    notifempty
}
EOF
\`\`\`

Verify logrotate picks up the new configuration: \`logrotate -d /etc/logrotate.d/adb-monitor\`. The \`-d\` flag dry-runs the rotation without touching any files.

---

## Phase 2: Core Health Check Script

Save the following script as \`/opt/adb_monitor/adb_health_check.sh\` and make it executable with \`chmod +x /opt/adb_monitor/adb_health_check.sh\`.

\`\`\`bash
#!/bin/bash
# /opt/adb_monitor/adb_health_check.sh
# Oracle ADB core health check — OCI CLI + SQLcl
# Sources: /etc/adb_monitor/adb_monitor.conf

set -uo pipefail
CONFIG_FILE="/etc/adb_monitor/adb_monitor.conf"
[ -f "\${CONFIG_FILE}" ] || { echo "ERROR: config not found at \${CONFIG_FILE}"; exit 1; }
# shellcheck source=/etc/adb_monitor/adb_monitor.conf
source "\${CONFIG_FILE}"

TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
DATESTAMP=\$(date '+%Y%m%d')
LOG_FILE="\${REPORT_DIR}/health_\${DATESTAMP}.log"
ALERT_FILE="\${REPORT_DIR}/alerts/alert_\${DATESTAMP}.txt"
CRIT_FOUND=0

mkdir -p "\${REPORT_DIR}/alerts"

log() { echo "\${1}" | tee -a "\${LOG_FILE}"; }
crit() { log "  [CRIT] \${1}"; CRIT_FOUND=1; echo "\${TIMESTAMP} CRIT: \${1}" >> "\${ALERT_FILE}"; }
warn() { log "  [WARN] \${1}"; }
pass() { log "  [PASS] \${1}"; }

log "================================================================"
log " Oracle ADB Health Check — \${TIMESTAMP}"
log " ADB OCID : \${ADB_OCID}"
log " Service  : \${ADB_SERVICE}"
log "================================================================"

# --- 1. Lifecycle State ---
log ""
log "--- Check 1: Lifecycle State"
LIFECYCLE=\$(oci db autonomous-database get \
  --autonomous-database-id "\${ADB_OCID}" \
  --profile "\${OCI_PROFILE}" \
  --query 'data."lifecycle-state"' \
  --raw-output 2>/dev/null || echo "ERROR")
if [ "\${LIFECYCLE}" = "AVAILABLE" ]; then
  pass "Lifecycle state: \${LIFECYCLE}"
else
  crit "Lifecycle state: \${LIFECYCLE} (expected AVAILABLE)"
fi

# --- 2. CPU Utilization ---
log ""
log "--- Check 2: CPU Utilization (5-min mean)"
CPU_UTIL=\$(oci monitoring metric-data summarize-metrics-data \
  --compartment-id "\${COMPARTMENT_ID}" \
  --profile "\${OCI_PROFILE}" \
  --namespace oracle_autonomous_database \
  --query-text "CpuUtilization[5m].mean()" \
  --query 'data[0]."aggregated-datapoints"[-1].value' \
  --raw-output 2>/dev/null || echo "N/A")
if [ "\${CPU_UTIL}" = "N/A" ] || [ -z "\${CPU_UTIL}" ]; then
  warn "CPU utilization: unable to retrieve metric"
elif (( \$(echo "\${CPU_UTIL} >= \${CPU_CRIT_PCT}" | bc -l) )); then
  crit "CPU utilization: \${CPU_UTIL}% (threshold: \${CPU_CRIT_PCT}%)"
elif (( \$(echo "\${CPU_UTIL} >= \${CPU_WARN_PCT}" | bc -l) )); then
  warn "CPU utilization: \${CPU_UTIL}% (threshold: \${CPU_WARN_PCT}%)"
else
  pass "CPU utilization: \${CPU_UTIL}%"
fi

# --- 3. Storage Utilization ---
log ""
log "--- Check 3: Storage Utilization (5-min mean)"
STORAGE_UTIL=\$(oci monitoring metric-data summarize-metrics-data \
  --compartment-id "\${COMPARTMENT_ID}" \
  --profile "\${OCI_PROFILE}" \
  --namespace oracle_autonomous_database \
  --query-text "StorageUtilization[5m].mean()" \
  --query 'data[0]."aggregated-datapoints"[-1].value' \
  --raw-output 2>/dev/null || echo "N/A")
if [ "\${STORAGE_UTIL}" = "N/A" ] || [ -z "\${STORAGE_UTIL}" ]; then
  warn "Storage utilization: unable to retrieve metric"
elif (( \$(echo "\${STORAGE_UTIL} >= \${STORAGE_CRIT_PCT}" | bc -l) )); then
  crit "Storage utilization: \${STORAGE_UTIL}% (threshold: \${STORAGE_CRIT_PCT}%)"
elif (( \$(echo "\${STORAGE_UTIL} >= \${STORAGE_WARN_PCT}" | bc -l) )); then
  warn "Storage utilization: \${STORAGE_UTIL}% (threshold: \${STORAGE_WARN_PCT}%)"
else
  pass "Storage utilization: \${STORAGE_UTIL}%"
fi

# --- 4. Current Logons ---
log ""
log "--- Check 4: Current Active Logons"
LOGON_COUNT=\$(oci monitoring metric-data summarize-metrics-data \
  --compartment-id "\${COMPARTMENT_ID}" \
  --profile "\${OCI_PROFILE}" \
  --namespace oracle_autonomous_database \
  --query-text "CurrentLogons[5m].mean()" \
  --query 'data[0]."aggregated-datapoints"[-1].value' \
  --raw-output 2>/dev/null || echo "N/A")
if [ "\${LOGON_COUNT}" = "N/A" ] || [ -z "\${LOGON_COUNT}" ]; then
  warn "Current logons: unable to retrieve metric"
elif (( \$(echo "\${LOGON_COUNT} >= \${LOGON_CRIT_COUNT}" | bc -l) )); then
  crit "Current logons: \${LOGON_COUNT} (threshold: \${LOGON_CRIT_COUNT})"
elif (( \$(echo "\${LOGON_COUNT} >= \${LOGON_WARN_COUNT}" | bc -l) )); then
  warn "Current logons: \${LOGON_COUNT} (threshold: \${LOGON_WARN_COUNT})"
else
  pass "Current logons: \${LOGON_COUNT}"
fi

# --- 5. SQL Health Queries via SQLcl ---
log ""
log "--- Check 5: In-Database SQL Health Queries"
export TNS_ADMIN

SQL_OUTPUT=\$(sql -s "\${ADMIN_USER}/\${ADMIN_PASSWORD}@\${ADB_SERVICE}" << 'SQLEOF'
SET FEEDBACK OFF HEADING ON LINESIZE 180 PAGESIZE 40
-- Active session count
PROMPT [SQL] Active user session count:
SELECT COUNT(*) AS active_sessions FROM v$session WHERE type='USER' AND status='ACTIVE';

-- Sessions waiting more than 30 seconds
PROMPT [SQL] Sessions waiting > 30 seconds:
SELECT sid, serial#, username, event, seconds_in_wait, sql_id
FROM   v$session
WHERE  type='USER' AND seconds_in_wait > 30
ORDER  BY seconds_in_wait DESC
FETCH FIRST 10 ROWS ONLY;

-- Locked objects
PROMPT [SQL] Locked database objects (TM/TX locks):
SELECT l.sid, s.username, l.type, l.lmode, l.request, l.block,
       o.object_name, s.seconds_in_wait
FROM   v$lock l
JOIN   v$session s ON l.sid = s.sid
LEFT JOIN dba_objects o ON l.id1 = o.object_id
WHERE  l.type IN ('TM','TX') AND l.block = 1
ORDER  BY s.seconds_in_wait DESC;

-- Tablespace usage summary
PROMPT [SQL] Tablespace usage:
SELECT tablespace_name,
       ROUND(used_space*8192/1073741824,2)     AS used_gb,
       ROUND(tablespace_size*8192/1073741824,2) AS alloc_gb,
       ROUND(used_percent,1)                    AS used_pct
FROM   dba_tablespace_usage_metrics
ORDER  BY used_percent DESC;

-- Auto-index today summary
PROMPT [SQL] Auto-index actions today:
SELECT indexing_status, COUNT(*) AS cnt
FROM   dba_auto_index_ind_actions
WHERE  action_time > SYSDATE - 1
GROUP  BY indexing_status;
SQLEOF
)

log "\${SQL_OUTPUT}"

# --- 6. Send alert email if CRIT found ---
if [ "\${CRIT_FOUND}" -eq 1 ]; then
  log ""
  log "  [ALERT] CRITICAL checks found — sending alert email to \${ALERT_EMAIL}"
  ALERT_BODY=\$(cat "\${ALERT_FILE}" 2>/dev/null || echo "See \${LOG_FILE}")
  echo -e "Subject: [ADB CRIT] Oracle ADB Health Alert \${TIMESTAMP}\\nTo: \${ALERT_EMAIL}\\n\\n\${ALERT_BODY}" \
    | sendmail "\${ALERT_EMAIL}" 2>/dev/null \
    || warn "sendmail delivery failed — check MTA configuration"
fi

log ""
log "================================================================"
log " Health check complete: \$([ \${CRIT_FOUND} -eq 1 ] && echo 'CRITICAL' || echo 'OK')"
log "================================================================"
\`\`\`

---

## Phase 3: OCI Metrics Polling Script

Save as \`/opt/adb_monitor/adb_metrics_poll.sh\`. This script pulls seven key OCI metrics for the last five minutes, writes a CSV line for trending, and prints ALERT lines for threshold violations.

\`\`\`bash
#!/bin/bash
# /opt/adb_monitor/adb_metrics_poll.sh
# Polls ADB OCI metrics every 5 minutes and writes a CSV trend line.
# CSV format: timestamp,metric_name,value,status

set -uo pipefail
CONFIG_FILE="/etc/adb_monitor/adb_monitor.conf"
source "\${CONFIG_FILE}"

DATESTAMP=\$(date '+%Y%m%d')
NOW_ISO=\$(date -u '+%Y-%m-%dT%H:%M:%SZ')
FIVE_MIN_AGO_ISO=\$(date -u -d '5 minutes ago' '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
  || date -u -v-5M '+%Y-%m-%dT%H:%M:%SZ')   # macOS fallback
CSV_FILE="\${REPORT_DIR}/metrics_\${DATESTAMP}.csv"

mkdir -p "\${REPORT_DIR}"

# Write CSV header if file does not exist
[ -f "\${CSV_FILE}" ] || echo "timestamp,metric_name,value,status" > "\${CSV_FILE}"

poll_metric() {
  local METRIC_NAME="\${1}"
  local THRESHOLD_WARN="\${2:-}"
  local THRESHOLD_CRIT="\${3:-}"

  # Build the OCI CLI metrics query JSON
  METRIC_JSON="{\"namespace\":\"oracle_autonomous_database\",\"queries\":[{\"metricName\":\"\${METRIC_NAME}\",\"statistics\":[\"mean\",\"max\"],\"resolution\":\"5m\"}],\"startTime\":\"\${FIVE_MIN_AGO_ISO}\",\"endTime\":\"\${NOW_ISO}\"}"

  RAW=\$(oci monitoring metric-data summarize-metrics-data \
    --compartment-id "\${COMPARTMENT_ID}" \
    --profile "\${OCI_PROFILE}" \
    --summarize-metrics-data-details "\${METRIC_JSON}" \
    2>/dev/null || echo "{}")

  VALUE=\$(echo "\${RAW}" | jq -r '.data[0]."aggregated-datapoints"[-1].value // "N/A"' 2>/dev/null || echo "N/A")
  STATUS="OK"

  if [ "\${VALUE}" = "N/A" ] || [ -z "\${VALUE}" ]; then
    STATUS="NODATA"
  elif [ -n "\${THRESHOLD_CRIT}" ] && (( \$(echo "\${VALUE} >= \${THRESHOLD_CRIT}" | bc -l) )); then
    STATUS="CRIT"
    echo "  ALERT [\${METRIC_NAME}] CRITICAL: \${VALUE} (threshold: \${THRESHOLD_CRIT})"
  elif [ -n "\${THRESHOLD_WARN}" ] && (( \$(echo "\${VALUE} >= \${THRESHOLD_WARN}" | bc -l) )); then
    STATUS="WARN"
    echo "  ALERT [\${METRIC_NAME}] WARNING: \${VALUE} (threshold: \${THRESHOLD_WARN})"
  fi

  echo "\${NOW_ISO},\${METRIC_NAME},\${VALUE},\${STATUS}" >> "\${CSV_FILE}"
  echo "  \${METRIC_NAME}: \${VALUE} [\${STATUS}]"
}

echo "=== ADB Metrics Poll — \${NOW_ISO} ==="

poll_metric "CpuUtilization"       "\${CPU_WARN_PCT}"     "\${CPU_CRIT_PCT}"
poll_metric "StorageUtilization"   "\${STORAGE_WARN_PCT}" "\${STORAGE_CRIT_PCT}"
poll_metric "CurrentLogons"        "\${LOGON_WARN_COUNT}"  "\${LOGON_CRIT_COUNT}"
poll_metric "TransactionsPerSec"
poll_metric "ExecuteCount"
poll_metric "UserCallsPerSec"
poll_metric "QueryExecutionCount"

echo "=== Poll complete. CSV appended to \${CSV_FILE} ==="
\`\`\`

The \`poll_metric\` function is reusable: add any OCI ADB metric name from the \`oracle_autonomous_database\` namespace with optional warn and crit thresholds. The CSV output feeds dashboards, capacity planning spreadsheets, or a Grafana CSV data source.

---

## Phase 4: SQL Performance Monitoring Scripts

### 4.1 Top SQL by Resource Consumption — top_sql_report.sql

\`\`\`sql
-- /opt/adb_monitor/sql/top_sql_report.sql
-- Top 20 SQL statements by elapsed time with resource breakdown
-- Usage: sql ADMIN/<pw>@MYADB_low @top_sql_report.sql | tee /var/log/adb_monitor/top_sql_$(date +%Y%m%d).txt

SET PAGESIZE 100 LINESIZE 220 TRIMSPOOL ON FEEDBACK OFF ECHO OFF

PROMPT ================================================================
PROMPT  Top 20 SQL by Elapsed Time — Last Hour
PROMPT ================================================================
SELECT sql_id,
       SUBSTR(sql_text, 1, 70)                              AS sql_preview,
       executions,
       ROUND(elapsed_time/1000000, 2)                       AS total_elapsed_sec,
       ROUND(elapsed_time/1000000/NULLIF(executions,0), 4)  AS avg_elapsed_sec,
       ROUND(cpu_time/1000000, 2)                           AS total_cpu_sec,
       ROUND(cpu_time/1000000/NULLIF(executions,0), 4)      AS avg_cpu_sec,
       buffer_gets,
       ROUND(buffer_gets/NULLIF(executions,0), 0)           AS bufgets_per_exec,
       disk_reads,
       ROUND(disk_reads/NULLIF(executions,0), 0)            AS diskrd_per_exec,
       parse_calls,
       ROUND(parse_calls/NULLIF(executions,0), 3)           AS parse_ratio
FROM   v\$sql
WHERE  last_active_time > SYSDATE - 1/24
  AND  executions       > 0
ORDER  BY elapsed_time DESC
FETCH FIRST 20 ROWS ONLY;

PROMPT
PROMPT ================================================================
PROMPT  Top 20 SQL by Buffer Gets (Memory-Intensive)
PROMPT ================================================================
SELECT sql_id,
       SUBSTR(sql_text, 1, 70)                              AS sql_preview,
       executions,
       buffer_gets,
       ROUND(buffer_gets/NULLIF(executions,0), 0)           AS bufgets_per_exec,
       disk_reads,
       ROUND(elapsed_time/1000000/NULLIF(executions,0), 4)  AS avg_elapsed_sec
FROM   v\$sql
WHERE  last_active_time > SYSDATE - 1/24
  AND  executions       > 0
ORDER  BY buffer_gets DESC
FETCH FIRST 20 ROWS ONLY;

PROMPT
PROMPT ================================================================
PROMPT  Top 20 SQL by Disk Reads (I/O-Intensive)
PROMPT ================================================================
SELECT sql_id,
       SUBSTR(sql_text, 1, 70)                              AS sql_preview,
       executions,
       disk_reads,
       ROUND(disk_reads/NULLIF(executions,0), 0)            AS diskrd_per_exec,
       buffer_gets,
       ROUND(elapsed_time/1000000/NULLIF(executions,0), 4)  AS avg_elapsed_sec
FROM   v\$sql
WHERE  last_active_time > SYSDATE - 1/24
  AND  executions       > 0
ORDER  BY disk_reads DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

### 4.2 SQL Plan Regression Detector — plan_regression_check.sql

\`\`\`sql
-- /opt/adb_monitor/sql/plan_regression_check.sql
-- Detect SQL plan regressions using DBA_SQL_PLAN_BASELINES

SET PAGESIZE 50 LINESIZE 220 TRIMSPOOL ON FEEDBACK OFF

PROMPT ================================================================
PROMPT  SQL Plan Baseline Status — Accepted Plans
PROMPT ================================================================
SELECT spb.sql_handle,
       spb.plan_name,
       spb.accepted,
       spb.enabled,
       spb.fixed,
       TO_CHAR(spb.created, 'YYYY-MM-DD HH24:MI') AS created,
       spb.origin,
       vs.executions,
       ROUND(vs.elapsed_time/1000000/NULLIF(vs.executions,0), 3) AS avg_elapsed_sec
FROM   dba_sql_plan_baselines spb
LEFT JOIN v\$sql vs ON vs.exact_matching_signature = spb.signature
WHERE  spb.accepted = 'YES'
ORDER  BY spb.created DESC
FETCH FIRST 20 ROWS ONLY;

PROMPT
PROMPT ================================================================
PROMPT  Unaccepted / Pending Plan Baselines (potential regressions)
PROMPT ================================================================
SELECT spb.sql_handle,
       spb.plan_name,
       spb.accepted,
       spb.enabled,
       TO_CHAR(spb.created, 'YYYY-MM-DD HH24:MI') AS created,
       spb.origin,
       spb.description
FROM   dba_sql_plan_baselines spb
WHERE  spb.accepted = 'NO'
ORDER  BY spb.created DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

### 4.3 Real-Time SQL Monitor — active Long-Running Statements

\`\`\`sql
-- /opt/adb_monitor/sql/realtime_sql_monitor.sql
-- Active and recently failed SQL with > 30 seconds elapsed

SET PAGESIZE 50 LINESIZE 220 TRIMSPOOL ON FEEDBACK OFF

PROMPT ================================================================
PROMPT  Real-Time SQL Monitor — Long-Running and Failed Statements
PROMPT ================================================================
SELECT sql_id,
       sql_exec_id,
       TO_CHAR(sql_exec_start, 'HH24:MI:SS')       AS started,
       ROUND(elapsed_time/1000000, 1)               AS elapsed_sec,
       ROUND(cpu_time/1000000, 1)                   AS cpu_sec,
       buffer_gets,
       disk_reads,
       ROUND(px_servers_allocated, 0)               AS parallel_servers,
       status,
       SUBSTR(sql_text, 1, 100)                     AS sql_preview
FROM   v\$sql_monitor
WHERE  status IN ('EXECUTING','DONE (ERROR)')
   OR  elapsed_time > 30 * 1000000
ORDER  BY elapsed_time DESC
FETCH FIRST 15 ROWS ONLY;
\`\`\`

Run this script every 60 seconds on a terminal during active incident investigations to track in-flight SQL progress without opening Performance Hub.

---

## Phase 5: Lock and Blocking Session Monitor

### 5.1 Full Lock Chain Query (Hierarchical Blocking Tree)

\`\`\`sql
-- /opt/adb_monitor/sql/lock_chain.sql
-- Full blocking session hierarchy with SQL preview
-- Reads from top-level blockers down to leaf waiters

SET PAGESIZE 100 LINESIZE 220 TRIMSPOOL ON FEEDBACK OFF

PROMPT ================================================================
PROMPT  Lock Chain — Blocking Session Tree
PROMPT ================================================================
SELECT LPAD(' ', 2*(LEVEL-1)) || s.sid || ',' || s.serial# AS session_tree,
       s.username,
       s.status,
       s.event,
       s.seconds_in_wait,
       s.blocking_session,
       s.sql_id,
       SUBSTR(sq.sql_text, 1, 80)                           AS sql_preview
FROM   v\$session s
LEFT JOIN v\$sql sq ON s.sql_id = sq.sql_id AND s.sql_child_number = sq.child_number
WHERE  s.type = 'USER'
START  WITH s.blocking_session IS NULL AND EXISTS (
         SELECT 1 FROM v\$session s2 WHERE s2.blocking_session = s.sid)
CONNECT BY PRIOR s.sid = s.blocking_session
ORDER  SIBLINGS BY s.seconds_in_wait DESC;
\`\`\`

### 5.2 DML Lock Detail (TM and TX Lock Modes)

\`\`\`sql
-- /opt/adb_monitor/sql/dml_lock_detail.sql
-- TM (table-level) and TX (transaction-level) lock detail

SET PAGESIZE 80 LINESIZE 180 TRIMSPOOL ON FEEDBACK OFF

PROMPT ================================================================
PROMPT  DML Lock Detail — TM/TX Lock Modes
PROMPT ================================================================
SELECT l.sid,
       s.serial#,
       s.username,
       l.type,
       l.lmode,
       l.request,
       l.block,
       o.object_name,
       o.object_type,
       s.seconds_in_wait
FROM   v\$lock l
JOIN   v\$session s ON l.sid = s.sid
LEFT JOIN dba_objects o ON l.id1 = o.object_id
WHERE  l.type IN ('TM','TX')
ORDER  BY l.block DESC, s.seconds_in_wait DESC;
\`\`\`

Lock mode reference: 0=None, 1=Null (N), 2=Row-Share (SS), 3=Row-Exclusive (SX), 4=Share (S), 5=Share Row-Exclusive (SSX), 6=Exclusive (X). A session with \`lmode=6\` (Exclusive) and \`block=1\` is your root blocker.

### 5.3 Automated Lock Alert Script

Save as \`/opt/adb_monitor/lock_monitor.sh\`.

\`\`\`bash
#!/bin/bash
# /opt/adb_monitor/lock_monitor.sh
# Checks for sessions blocked longer than LOCK_WAIT_WARN_SEC and sends email alert.

set -uo pipefail
CONFIG_FILE="/etc/adb_monitor/adb_monitor.conf"
source "\${CONFIG_FILE}"

DATESTAMP=\$(date '+%Y%m%d')
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
LOG_FILE="\${REPORT_DIR}/locks_\${DATESTAMP}.log"
export TNS_ADMIN

# Query for blocked sessions beyond threshold
LOCK_OUTPUT=\$(sql -s "\${ADMIN_USER}/\${ADMIN_PASSWORD}@\${ADB_SERVICE}" << SQLEOF
SET FEEDBACK OFF HEADING ON LINESIZE 180 PAGESIZE 50
SELECT s.sid,
       s.serial#,
       s.username,
       s.event,
       s.seconds_in_wait,
       s.blocking_session,
       s.sql_id,
       SUBSTR(sq.sql_text, 1, 100) AS sql_preview
FROM   v\$session s
LEFT JOIN v\$sql sq ON s.sql_id = sq.sql_id AND s.sql_child_number = sq.child_number
WHERE  s.type = 'USER'
  AND  s.blocking_session IS NOT NULL
  AND  s.seconds_in_wait >= \${LOCK_WAIT_WARN_SEC}
ORDER  BY s.seconds_in_wait DESC;
SQLEOF
)

echo "[\${TIMESTAMP}] Lock monitor run" >> "\${LOG_FILE}"

if echo "\${LOCK_OUTPUT}" | grep -qE '^[[:space:]]*[0-9]'; then
  echo "[\${TIMESTAMP}] WARNING: Blocked sessions detected beyond \${LOCK_WAIT_WARN_SEC}s threshold" >> "\${LOG_FILE}"
  echo "\${LOCK_OUTPUT}" >> "\${LOG_FILE}"

  # Also capture the full lock chain
  CHAIN_OUTPUT=\$(sql -s "\${ADMIN_USER}/\${ADMIN_PASSWORD}@\${ADB_SERVICE}" << SQLEOF2
SET FEEDBACK OFF HEADING ON LINESIZE 180 PAGESIZE 100
SELECT LPAD(' ', 2*(LEVEL-1)) || s.sid || ',' || s.serial# AS session_tree,
       s.username, s.status, s.event, s.seconds_in_wait,
       s.blocking_session, s.sql_id
FROM   v\$session s
WHERE  s.type = 'USER'
START  WITH s.blocking_session IS NULL AND EXISTS (
         SELECT 1 FROM v\$session s2 WHERE s2.blocking_session = s.sid)
CONNECT BY PRIOR s.sid = s.blocking_session
ORDER  SIBLINGS BY s.seconds_in_wait DESC;
SQLEOF2
)

  ALERT_BODY="ADB Lock Alert at \${TIMESTAMP}

Blocked sessions exceeding \${LOCK_WAIT_WARN_SEC} seconds threshold:

\${LOCK_OUTPUT}

Full lock chain tree:
\${CHAIN_OUTPUT}

Log file: \${LOG_FILE}"

  echo -e "Subject: [ADB LOCK ALERT] Blocked Sessions Detected \${TIMESTAMP}\\nTo: \${ALERT_EMAIL}\\n\\n\${ALERT_BODY}" \
    | sendmail "\${ALERT_EMAIL}" 2>/dev/null \
    || echo "[\${TIMESTAMP}] WARNING: sendmail delivery failed" >> "\${LOG_FILE}"
else
  echo "[\${TIMESTAMP}] No blocked sessions beyond threshold." >> "\${LOG_FILE}"
fi
\`\`\`

---

## Phase 6: Auto-Index Monitoring and Reporting

### 6.1 Auto-Index Daily Summary

\`\`\`sql
-- /opt/adb_monitor/sql/auto_index_daily.sql
-- Auto-index decisions in the last 24 hours

SET PAGESIZE 100 LINESIZE 200 TRIMSPOOL ON FEEDBACK OFF

PROMPT ================================================================
PROMPT  Auto-Index Daily Summary
PROMPT ================================================================
SELECT TO_CHAR(action_time, 'HH24:MI:SS')          AS action_time,
       index_name,
       table_name,
       indexing_status,
       CASE indexing_status
         WHEN 'CREATED'  THEN 'New index created and under test'
         WHEN 'ACTIVE'   THEN 'Index promoted to active use'
         WHEN 'DROPPED'  THEN 'Unused index removed'
         WHEN 'INVALID'  THEN 'Index rejected — no benefit found'
         ELSE indexing_status
       END                                          AS status_description,
       ROUND(index_size/1024/1024, 2)               AS index_mb,
       error_message
FROM   dba_auto_index_ind_actions
WHERE  action_time > SYSDATE - 1
ORDER  BY action_time DESC;
\`\`\`

### 6.2 Auto-Index Space Consumption Trend (30-Day)

\`\`\`sql
-- /opt/adb_monitor/sql/auto_index_trend.sql
-- 30-day auto-index volume and space trend for capacity planning

SET PAGESIZE 100 LINESIZE 160 TRIMSPOOL ON FEEDBACK OFF

PROMPT ================================================================
PROMPT  Auto-Index 30-Day Space Consumption Trend
PROMPT ================================================================
SELECT TRUNC(action_time, 'DD')             AS action_date,
       indexing_status,
       COUNT(*)                             AS action_count,
       ROUND(SUM(index_size)/1024/1024, 2)  AS total_mb
FROM   dba_auto_index_ind_actions
WHERE  action_time > SYSDATE - 30
GROUP  BY TRUNC(action_time, 'DD'), indexing_status
ORDER  BY action_date DESC, indexing_status;
\`\`\`

A sharp increase in \`total_mb\` for \`ACTIVE\` status entries over consecutive days signals that auto-indexing is creating many new indexes — possibly due to unoptimised application code or a new query pattern. Review \`DBA_AUTO_INDEX_CONFIG\` for space budget controls.

### 6.3 Queries That Benefited from Auto-Indexes

\`\`\`sql
-- /opt/adb_monitor/sql/auto_index_benefit.sql
-- Top 10 SQL statements that improved most from auto-indexes

SET PAGESIZE 50 LINESIZE 200 TRIMSPOOL ON FEEDBACK OFF

PROMPT ================================================================
PROMPT  SQL Statements Improved by Auto-Indexing
PROMPT ================================================================
SELECT e.sql_id,
       e.execution_type,
       ROUND(e.before_elapsed_time/1000000, 3)                          AS before_sec,
       ROUND(e.after_elapsed_time/1000000, 3)                           AS after_sec,
       ROUND((1 - e.after_elapsed_time/NULLIF(e.before_elapsed_time,0))
             * 100, 1)                                                   AS pct_improvement,
       a.index_name,
       a.table_name
FROM   dba_auto_index_executions e
JOIN   dba_auto_index_ind_actions a ON e.action_obj_no = a.index_obj_no
WHERE  e.before_elapsed_time > 0
  AND  e.after_elapsed_time  < e.before_elapsed_time
ORDER  BY pct_improvement DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

---

## Phase 7: Storage and Undo Monitoring

### 7.1 Tablespace Utilization with Status Classification

\`\`\`sql
-- /opt/adb_monitor/sql/tablespace_usage.sql

SET PAGESIZE 50 LINESIZE 160 TRIMSPOOL ON FEEDBACK OFF

PROMPT ================================================================
PROMPT  Tablespace Utilization with Threshold Status
PROMPT ================================================================
SELECT m.tablespace_name,
       ROUND(m.used_space * 8192/1024/1024/1024, 3)       AS used_gb,
       ROUND(m.tablespace_size * 8192/1024/1024/1024, 3)   AS allocated_gb,
       ROUND(m.used_percent, 2)                            AS used_pct,
       CASE
         WHEN m.used_percent >= 90 THEN 'CRITICAL'
         WHEN m.used_percent >= 80 THEN 'WARNING'
         ELSE 'OK'
       END                                                 AS status
FROM   dba_tablespace_usage_metrics m
ORDER  BY m.used_percent DESC;
\`\`\`

### 7.2 Undo Retention Compliance

\`\`\`sql
-- /opt/adb_monitor/sql/undo_retention.sql
-- ssolderrcnt > 0 indicates ORA-01555 (snapshot too old) errors in the sample window

SET PAGESIZE 50 LINESIZE 180 TRIMSPOOL ON FEEDBACK OFF

PROMPT ================================================================
PROMPT  Undo Statistics — Last Hour (12 x 5-minute samples)
PROMPT ================================================================
SELECT TO_CHAR(begin_time, 'HH24:MI')      AS sample_time,
       undoblks,
       txncount,
       maxquerylen,
       maxconcurrency,
       unxpstealcnt,
       expstealcnt,
       ssolderrcnt
FROM   v\$undostat
WHERE  begin_time > SYSDATE - 1/24
ORDER  BY begin_time DESC
FETCH FIRST 12 ROWS ONLY;
-- ssolderrcnt > 0 means ORA-01555 (snapshot too old) errors occurred
\`\`\`

If \`ssolderrcnt\` is non-zero, long-running queries are outliving undo retention. In ADB Serverless, contact Oracle Support to request an undo retention parameter increase, or redesign the application to avoid long-running read queries competing with high-DML transactions.

### 7.3 Temp Segment Usage by Session

\`\`\`sql
-- /opt/adb_monitor/sql/temp_segment_usage.sql
-- Identify sessions consuming large amounts of temporary space

SET PAGESIZE 50 LINESIZE 180 TRIMSPOOL ON FEEDBACK OFF

PROMPT ================================================================
PROMPT  Top 10 Sessions by Temp Segment Usage
PROMPT ================================================================
SELECT s.username,
       s.sid,
       s.serial#,
       s.sql_id,
       ROUND(SUM(u.blocks) * 8192/1024/1024, 2)  AS temp_mb
FROM   v\$tempseg_usage u
JOIN   v\$session s ON u.session_addr = s.saddr
GROUP  BY s.username, s.sid, s.serial#, s.sql_id
ORDER  BY temp_mb DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

---

## Phase 8: Security and Audit Monitoring

### 8.1 Failed Login Monitor (Last 24 Hours)

\`\`\`sql
-- /opt/adb_monitor/sql/failed_logins.sql
-- Accounts with 5 or more failed login attempts in the last 24 hours

SET PAGESIZE 50 LINESIZE 200 TRIMSPOOL ON FEEDBACK OFF

PROMPT ================================================================
PROMPT  Failed Login Summary — Last 24 Hours (>= 5 failures)
PROMPT ================================================================
SELECT db_username,
       userhost,
       os_username,
       COUNT(*)                              AS failures,
       MIN(event_timestamp)                  AS first_attempt,
       MAX(event_timestamp)                  AS last_attempt,
       LISTAGG(DISTINCT return_code, ', ')
         WITHIN GROUP (ORDER BY return_code) AS error_codes
FROM   unified_audit_trail
WHERE  action_name     = 'LOGON'
  AND  return_code     != 0
  AND  event_timestamp > SYSTIMESTAMP - INTERVAL '24' HOUR
GROUP  BY db_username, userhost, os_username
HAVING COUNT(*) >= 5
ORDER  BY failures DESC;
\`\`\`

### 8.2 Privilege Use Audit — Who Used DBA Privileges

\`\`\`sql
-- /opt/adb_monitor/sql/privilege_audit.sql
-- ADMIN and system schema actions in the last 24 hours

SET PAGESIZE 100 LINESIZE 220 TRIMSPOOL ON FEEDBACK OFF

PROMPT ================================================================
PROMPT  Privileged User Activity — Last 24 Hours
PROMPT ================================================================
SELECT event_timestamp,
       db_username,
       action_name,
       object_schema,
       object_name,
       sql_text
FROM   unified_audit_trail
WHERE  (unified_audit_policies LIKE '%LOGON%'
     OR object_schema IN ('SYS','SYSTEM','ADMIN')
     OR db_username   = 'ADMIN')
  AND  event_timestamp > SYSTIMESTAMP - INTERVAL '24' HOUR
ORDER  BY event_timestamp DESC
FETCH FIRST 50 ROWS ONLY;
\`\`\`

### 8.3 DDL Change Tracking — Who Created or Dropped Objects

\`\`\`sql
-- /opt/adb_monitor/sql/ddl_audit.sql
-- Schema-altering DDL events in the last 24 hours

SET PAGESIZE 100 LINESIZE 200 TRIMSPOOL ON FEEDBACK OFF

PROMPT ================================================================
PROMPT  DDL Change Audit — Last 24 Hours
PROMPT ================================================================
SELECT event_timestamp,
       db_username,
       action_name,
       object_schema,
       object_name,
       object_type
FROM   unified_audit_trail
WHERE  action_name IN ('CREATE TABLE','DROP TABLE','CREATE INDEX','DROP INDEX',
                       'CREATE USER','DROP USER','GRANT','REVOKE',
                       'CREATE PROCEDURE','ALTER TABLE')
  AND  event_timestamp > SYSTIMESTAMP - INTERVAL '24' HOUR
ORDER  BY event_timestamp DESC;
\`\`\`

The \`UNIFIED_AUDIT_TRAIL\` view requires the session user to have the \`AUDIT_VIEWER\` or \`AUDIT_ADMIN\` role. The ADMIN account on ADB holds these privileges by default. Application schema users should not be granted audit access.

---

## Phase 9: OCI Alarm and Notification Wiring

Build the OCI alarm infrastructure once, then reference the notification topic OCID in every alarm. All commands source \`adb_monitor.conf\` first.

\`\`\`bash
source /etc/adb_monitor/adb_monitor.conf
\`\`\`

### 9.1 Create an OCI Notification Topic

\`\`\`bash
TOPIC_OCID=\$(oci ons topic create \
  --compartment-id "\${COMPARTMENT_ID}" \
  --name "ADB-DBA-Alerts" \
  --description "Alerts for Autonomous Database monitoring" \
  --profile "\${OCI_PROFILE}" \
  --query 'data."topic-id"' \
  --raw-output)
echo "Topic OCID: \${TOPIC_OCID}"
\`\`\`

### 9.2 Subscribe Email Address to the Topic

\`\`\`bash
oci ons subscription create \
  --compartment-id "\${COMPARTMENT_ID}" \
  --topic-id "\${TOPIC_OCID}" \
  --protocol EMAIL \
  --endpoint "\${ALERT_EMAIL}" \
  --profile "\${OCI_PROFILE}"
# Check the inbox for the confirmation email and click the confirmation link.
\`\`\`

### 9.3 Create CPU Utilization Alarm (CRIT at 90%)

\`\`\`bash
oci monitoring alarm create \
  --compartment-id "\${COMPARTMENT_ID}" \
  --display-name "ADB-CPU-Critical" \
  --metric-compartment-id "\${COMPARTMENT_ID}" \
  --namespace "oracle_autonomous_database" \
  --query-text "CpuUtilization[5m].mean() > 90" \
  --severity "CRITICAL" \
  --pending-duration "PT5M" \
  --destinations "[\"ocid1.onstopic...\${TOPIC_OCID}\"]" \
  --is-enabled true \
  --body "ADB CPU utilization exceeded 90% for 5 minutes on \${ADB_OCID}" \
  --profile "\${OCI_PROFILE}"
\`\`\`

### 9.4 Create Storage Alarms (Warning at 80%, Critical at 90%)

\`\`\`bash
# Warning-level storage alarm
oci monitoring alarm create \
  --compartment-id "\${COMPARTMENT_ID}" \
  --display-name "ADB-Storage-Warning" \
  --namespace "oracle_autonomous_database" \
  --query-text "StorageUtilization[5m].mean() > 80" \
  --severity "WARNING" \
  --pending-duration "PT10M" \
  --destinations "[\"ocid1.onstopic...\${TOPIC_OCID}\"]" \
  --is-enabled true \
  --profile "\${OCI_PROFILE}"

# Critical-level storage alarm
oci monitoring alarm create \
  --compartment-id "\${COMPARTMENT_ID}" \
  --display-name "ADB-Storage-Critical" \
  --namespace "oracle_autonomous_database" \
  --query-text "StorageUtilization[5m].mean() > 90" \
  --severity "CRITICAL" \
  --pending-duration "PT5M" \
  --destinations "[\"ocid1.onstopic...\${TOPIC_OCID}\"]" \
  --is-enabled true \
  --profile "\${OCI_PROFILE}"
\`\`\`

### 9.5 Create an OCI Events Rule for ADB Lifecycle State Changes

\`\`\`bash
oci events rule create \
  --compartment-id "\${COMPARTMENT_ID}" \
  --display-name "ADB-Lifecycle-Events" \
  --is-enabled true \
  --condition '{"eventType":["com.oraclecloud.databaseservice.autonomous.database.update.end",
                              "com.oraclecloud.databaseservice.autonomous.database.stop.end",
                              "com.oraclecloud.databaseservice.backup.autonomous.database.end"]}' \
  --actions "{\"actions\":[{\"actionType\":\"ONS\",\"topicId\":\"ocid1.onstopic...\${TOPIC_OCID}\",\"isEnabled\":true}]}" \
  --profile "\${OCI_PROFILE}"
\`\`\`

This Events rule fires whenever the ADB lifecycle changes (e.g., AVAILABLE → STOPPED, patching completes, or a backup finishes). Lifecycle events do not go through OCI Monitoring metrics — they require the Events service. The rule is separate from metric-based alarms and catches stop/start operations, patch applications, and backup results.

---

## Phase 10: Automated Monitoring Crontab

### 10.1 OS-Level Crontab (Monitoring User)

Install the following crontab for the OS monitoring user (\`oracledba\`) with \`crontab -e\`:

\`\`\`bash
# ADB Monitoring Crontab
# Edit with: crontab -e

# Health check every 5 minutes
*/5 * * * * /opt/adb_monitor/adb_health_check.sh >> /var/log/adb_monitor/health_\$(date +\%Y\%m\%d).log 2>&1

# OCI Metrics poll every 5 minutes
*/5 * * * * /opt/adb_monitor/adb_metrics_poll.sh >> /var/log/adb_monitor/metrics_\$(date +\%Y\%m\%d).csv 2>&1

# Lock monitor every 2 minutes during business hours (Mon-Fri 08:00-18:00)
*/2 8-18 * * 1-5 /opt/adb_monitor/lock_monitor.sh >> /var/log/adb_monitor/locks_\$(date +\%Y\%m\%d).log 2>&1

# Detailed daily report at 06:00
0 6 * * * /opt/adb_monitor/adb_daily_report.sh >> /var/log/adb_monitor/daily/report_\$(date +\%Y\%m\%d).txt 2>&1

# Auto-index weekly summary on Monday 07:00
0 7 * * 1 /opt/adb_monitor/auto_index_weekly.sh >> /var/log/adb_monitor/daily/autoindex_\$(date +\%Y\%m\%d).txt 2>&1

# Security audit report daily at 07:00
0 7 * * * /opt/adb_monitor/security_audit_report.sh >> /var/log/adb_monitor/daily/security_\$(date +\%Y\%m\%d).txt 2>&1
\`\`\`

### 10.2 In-Database DBMS_SCHEDULER Alternative

For organisations that prefer running monitoring logic inside the database rather than on an external host, use \`DBMS_SCHEDULER\`. First, create the monitoring log table:

\`\`\`sql
-- Run as ADMIN
CREATE TABLE admin.monitoring_log (
  log_id        NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  log_time      TIMESTAMP    NOT NULL,
  check_name    VARCHAR2(60) NOT NULL,
  metric_value  NUMBER,
  status        VARCHAR2(10) NOT NULL,
  detail        VARCHAR2(500)
);
\`\`\`

Then create the scheduled job:

\`\`\`sql
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'ADMIN.ADB_HEALTH_SNAPSHOT',
    job_type        => 'PLSQL_BLOCK',
    job_action      => q'[
      BEGIN
        -- Session count check
        INSERT INTO admin.monitoring_log (
          log_time, check_name, metric_value, status)
        SELECT SYSTIMESTAMP,
               'SESSION_COUNT',
               COUNT(*),
               CASE WHEN COUNT(*) > 200 THEN 'WARN' ELSE 'OK' END
        FROM v$session WHERE type = ''USER'';

        -- Tablespace threshold check
        INSERT INTO admin.monitoring_log (
          log_time, check_name, metric_value, status, detail)
        SELECT SYSTIMESTAMP,
               'TABLESPACE_' || tablespace_name,
               ROUND(used_percent, 1),
               CASE WHEN used_percent >= 90 THEN 'CRIT'
                    WHEN used_percent >= 80 THEN 'WARN'
                    ELSE 'OK' END,
               tablespace_name
        FROM dba_tablespace_usage_metrics;

        COMMIT;
      END;
    ]',
    start_date      => SYSTIMESTAMP,
    repeat_interval => 'FREQ=MINUTELY;INTERVAL=5',
    enabled         => TRUE,
    comments        => 'ADB health snapshot every 5 minutes'
  );
END;
/

-- View recent job run status
SELECT job_name, last_start_date, last_run_duration, status
FROM   user_scheduler_job_run_details
WHERE  job_name = 'ADB_HEALTH_SNAPSHOT'
ORDER  BY last_start_date DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

---

## Phase 11: Daily Report Script

Save as \`/opt/adb_monitor/adb_daily_report.sh\` and make executable.

\`\`\`bash
#!/bin/bash
# /opt/adb_monitor/adb_daily_report.sh
# Comprehensive ADB daily report — SQL + OCI Metrics + email delivery
# Runs at 06:00 daily via crontab.

set -uo pipefail
CONFIG_FILE="/etc/adb_monitor/adb_monitor.conf"
source "\${CONFIG_FILE}"

DATESTAMP=\$(date '+%Y%m%d')
YESTERDAY=\$(date -d 'yesterday' '+%Y-%m-%d' 2>/dev/null || date -v-1d '+%Y-%m-%d')
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
REPORT_FILE="\${REPORT_DIR}/daily/report_\${DATESTAMP}.txt"
SCRIPT_DIR="/opt/adb_monitor/sql"
export TNS_ADMIN

mkdir -p "\${REPORT_DIR}/daily"

header() {
  echo ""
  echo "============================================================"
  echo "  \${1}"
  echo "============================================================"
}

{
  echo "Oracle ADB Daily Monitoring Report"
  echo "Database  : \${ADB_SERVICE}"
  echo "Report for: \${YESTERDAY}"
  echo "Generated : \${TIMESTAMP}"

  header "1. DATABASE IDENTITY AND STATUS"
  oci db autonomous-database get \
    --autonomous-database-id "\${ADB_OCID}" \
    --profile "\${OCI_PROFILE}" \
    --query 'data.{name:"display-name",state:"lifecycle-state",cpu:"cpu-core-count",storage_tb:"data-storage-size-in-tbs",autoscale:"is-auto-scaling-enabled",version:"db-version"}' \
    --output table 2>/dev/null || echo "  [ERROR] Could not retrieve ADB metadata"

  header "2. OCI METRICS 24-HOUR PEAKS"
  for METRIC in CpuUtilization StorageUtilization CurrentLogons TransactionsPerSec ExecuteCount; do
    PEAK=\$(oci monitoring metric-data summarize-metrics-data \
      --compartment-id "\${COMPARTMENT_ID}" \
      --profile "\${OCI_PROFILE}" \
      --namespace oracle_autonomous_database \
      --query-text "\${METRIC}[1h].max()" \
      --query 'data[0]."aggregated-datapoints" | max_by(@, &value).value' \
      --raw-output 2>/dev/null || echo "N/A")
    echo "  \${METRIC}: \${PEAK} (24h max)"
  done

  header "3. TOP 10 SQL BY ELAPSED TIME (LAST 24H)"
  sql -s "\${ADMIN_USER}/\${ADMIN_PASSWORD}@\${ADB_SERVICE}" << SQLEOF
SET FEEDBACK OFF HEADING ON LINESIZE 200 PAGESIZE 30
SELECT sql_id,
       SUBSTR(sql_text,1,60) AS sql_preview,
       executions,
       ROUND(elapsed_time/1000000,2) AS total_elapsed_sec,
       ROUND(elapsed_time/1000000/NULLIF(executions,0),4) AS avg_sec
FROM   v\$sql
WHERE  last_active_time > SYSDATE - 1
  AND  executions > 0
ORDER  BY elapsed_time DESC
FETCH FIRST 10 ROWS ONLY;
SQLEOF

  header "4. AUTO-INDEX SUMMARY (LAST 24H)"
  sql -s "\${ADMIN_USER}/\${ADMIN_PASSWORD}@\${ADB_SERVICE}" << SQLEOF
SET FEEDBACK OFF HEADING ON LINESIZE 160 PAGESIZE 20
SELECT indexing_status, COUNT(*) AS action_count,
       ROUND(SUM(index_size)/1024/1024,2) AS total_mb
FROM   dba_auto_index_ind_actions
WHERE  action_time > SYSDATE - 1
GROUP  BY indexing_status;
SQLEOF

  header "5. TABLESPACE STORAGE UTILIZATION"
  sql -s "\${ADMIN_USER}/\${ADMIN_PASSWORD}@\${ADB_SERVICE}" << SQLEOF
SET FEEDBACK OFF HEADING ON LINESIZE 140 PAGESIZE 20
SELECT tablespace_name,
       ROUND(used_space*8192/1073741824,3) AS used_gb,
       ROUND(tablespace_size*8192/1073741824,3) AS alloc_gb,
       ROUND(used_percent,1) AS used_pct,
       CASE WHEN used_percent>=90 THEN 'CRITICAL'
            WHEN used_percent>=80 THEN 'WARNING' ELSE 'OK' END AS status
FROM   dba_tablespace_usage_metrics
ORDER  BY used_percent DESC;
SQLEOF

  header "6. FAILED LOGINS (LAST 24H — >= 5 FAILURES)"
  sql -s "\${ADMIN_USER}/\${ADMIN_PASSWORD}@\${ADB_SERVICE}" << SQLEOF
SET FEEDBACK OFF HEADING ON LINESIZE 160 PAGESIZE 20
SELECT db_username, userhost, COUNT(*) AS failures,
       MIN(event_timestamp) AS first_try, MAX(event_timestamp) AS last_try
FROM   unified_audit_trail
WHERE  action_name='LOGON' AND return_code!=0
  AND  event_timestamp > SYSTIMESTAMP - INTERVAL '24' HOUR
GROUP  BY db_username, userhost
HAVING COUNT(*) >= 5
ORDER  BY failures DESC;
SQLEOF

  header "7. LOCK SUMMARY (LAST 24H — SESSIONS THAT BLOCKED > 60s)"
  sql -s "\${ADMIN_USER}/\${ADMIN_PASSWORD}@\${ADB_SERVICE}" << SQLEOF
SET FEEDBACK OFF HEADING ON LINESIZE 160 PAGESIZE 20
SELECT username, event, COUNT(*) AS occurrences,
       MAX(seconds_in_wait) AS max_wait_sec
FROM   v\$session
WHERE  type='USER' AND blocking_session IS NOT NULL
GROUP  BY username, event
ORDER  BY max_wait_sec DESC;
SQLEOF

  echo ""
  echo "============================================================"
  echo "  END OF REPORT"
  echo "  Report file: \${REPORT_FILE}"
  echo "============================================================"

} | tee "\${REPORT_FILE}"

# Email the report
if command -v sendmail &>/dev/null; then
  { echo "Subject: ADB Daily Report \${DATESTAMP} — \${ADB_SERVICE}"
    echo "To: \${ALERT_EMAIL}"
    echo ""
    cat "\${REPORT_FILE}"
  } | sendmail "\${ALERT_EMAIL}" 2>/dev/null \
    || echo "WARNING: sendmail delivery failed" >> "\${REPORT_FILE}"
fi

echo "Daily report complete: \${REPORT_FILE}"
\`\`\`

---

## Quick Reference

### ADB-Accessible V$ Views

| View | Available | Notes |
|---|---|---|
| \`V\$SESSION\` | Yes | Full access including \`blocking_session\` and \`sql_id\` |
| \`V\$SQL\` | Yes | Full access; \`sql_fulltext\` available in ADB |
| \`V\$SQL_MONITOR\` | Yes | Real-time monitoring for parallel and long-running SQL |
| \`V\$LOCK\` | Yes | Full TM/TX lock visibility |
| \`V\$TRANSACTION\` | Yes | Active transaction details |
| \`V\$DATABASE\` | Yes | DB name, DBID, open mode, log mode |
| \`V\$PARAMETER\` | Yes | Readable; most parameters are not modifiable in ADB |
| \`V\$RMAN_STATUS\` | Yes | Shows ADB-automated backup history |
| \`V\$DATABASE_BLOCK_CORRUPTION\` | Yes | Always empty on healthy ADB (Oracle manages block checking) |
| \`V\$RSRC_CONSUMER_GROUP\` | Yes | Resource Manager group assignments per service |
| \`V\$UNDOSTAT\` | Yes | 5-minute undo statistics samples |
| \`V\$TEMPSEG_USAGE\` | Yes | Active temp segment allocations by session |
| \`V\$DIAG_ALERT_EXT\` | Restricted | Alert log access limited to OCI Console in ADB Serverless |
| \`V\$ASM_*\` | Restricted | ASM views are not exposed to ADB users |

### DBA_ Views Available for Monitoring

| View | Purpose |
|---|---|
| \`DBA_AUTO_INDEX_IND_ACTIONS\` | Full history of auto-index create, validate, and drop events including \`index_size\` and \`error_message\` |
| \`DBA_AUTO_INDEX_EXECUTIONS\` | Before/after elapsed time comparison for SQL that auto-indexing evaluated |
| \`DBA_AUTO_INDEX_CONFIG\` | Active auto-indexing configuration parameters and space budget |
| \`DBA_SQL_PLAN_BASELINES\` | Accepted, pending, and fixed plan baselines for the workload |
| \`DBA_TABLESPACE_USAGE_METRICS\` | Current used and allocated space in 8KB blocks for each tablespace |
| \`DBA_OPTSTAT_OPERATIONS\` | History of \`DBMS_STATS\` gather operations and duration |
| \`UNIFIED_AUDIT_TRAIL\` | All audit events; requires \`AUDIT_VIEWER\` or \`AUDIT_ADMIN\` role |

### OCI Metrics Namespace: oracle_autonomous_database

| Metric Name | Unit | Description |
|---|---|---|
| \`CpuUtilization\` | % | Mean CPU utilization across all OCPUs |
| \`StorageUtilization\` | % | Storage used vs. provisioned |
| \`CurrentLogons\` | count | Active database sessions |
| \`TransactionsPerSec\` | count/s | Committed transactions per second |
| \`ExecuteCount\` | count/s | SQL executions per second |
| \`UserCallsPerSec\` | count/s | User calls per second (includes parse, execute, fetch) |
| \`QueryExecutionCount\` | count/s | SELECT statements executed per second |
| \`ParseCount\` | count/s | Total parse calls per second |
| \`HardParseCount\` | count/s | Hard parse calls (no matching cursor found) |
| \`BlockChangesPerSec\` | count/s | Database blocks modified per second (write activity indicator) |
| \`PhysicalReadBytesPerSec\` | bytes/s | Physical I/O read throughput |
| \`PhysicalWriteBytesPerSec\` | bytes/s | Physical I/O write throughput |
| \`RedoWritesPerSec\` | count/s | Redo log writes per second |
| \`ResponseTimeMsec\` | ms | Average database response time |

### Alert Threshold Recommendations

| Metric | Warning | Critical | Rationale |
|---|---|---|---|
| \`CpuUtilization\` | 75% | 90% | ADB auto-scaling activates at ~85%; WARN before auto-scale fires, CRIT if auto-scale maxed out |
| \`StorageUtilization\` | 80% | 90% | Storage expansion takes minutes; 80% gives headroom to act |
| \`CurrentLogons\` | 200 | 280 | Tune to your connection pool max; sudden spikes indicate retry storms |
| \`HardParseCount\` | 500/s | 1000/s | Sustained hard parsing indicates missing bind variables or cursor cache exhaustion |
| \`ResponseTimeMsec\` | 500ms | 2000ms | Baseline first; these thresholds are starting points for OLTP workloads |
| Failed Logins | 10 in 1h | 50 in 1h | Tune to environment; 10 failures/hour may indicate a legitimate user lockout |
| Lock wait (SQL) | 60s | 120s | Most OLTP locks should resolve in seconds; 60s is a conservative starting threshold |
| Temp segment | 50 GB | 80 GB | Set relative to your TEMP tablespace size; runaway sort operations fill temp fast |

### Script File Locations

| Script | Purpose | Frequency |
|---|---|---|
| \`/opt/adb_monitor/adb_health_check.sh\` | OCI lifecycle + metric thresholds + SQL health queries | Every 5 minutes |
| \`/opt/adb_monitor/adb_metrics_poll.sh\` | Seven OCI metrics to CSV for trending | Every 5 minutes |
| \`/opt/adb_monitor/lock_monitor.sh\` | Blocking session detection and email alert | Every 2 minutes (business hours) |
| \`/opt/adb_monitor/adb_daily_report.sh\` | Full daily text report with email delivery | Daily 06:00 |
| \`/opt/adb_monitor/auto_index_weekly.sh\` | 7-day auto-index volume and benefit summary | Monday 07:00 |
| \`/opt/adb_monitor/security_audit_report.sh\` | Failed logins, DDL changes, privilege use | Daily 07:00 |
| \`/opt/adb_monitor/sql/top_sql_report.sql\` | Top SQL by elapsed, buffer gets, disk reads | On-demand / daily |
| \`/opt/adb_monitor/sql/plan_regression_check.sql\` | SQL plan baseline status and regressions | On-demand |
| \`/opt/adb_monitor/sql/realtime_sql_monitor.sql\` | Long-running SQL during incidents | On-demand |
| \`/opt/adb_monitor/sql/lock_chain.sql\` | Hierarchical blocking tree | On-demand |
| \`/opt/adb_monitor/sql/dml_lock_detail.sql\` | TM/TX lock mode detail | On-demand |
| \`/opt/adb_monitor/sql/auto_index_daily.sql\` | Auto-index 24-hour summary | Daily |
| \`/opt/adb_monitor/sql/auto_index_trend.sql\` | 30-day auto-index space trend | Weekly |
| \`/opt/adb_monitor/sql/auto_index_benefit.sql\` | SQL statements benefiting from auto-index | Weekly |
| \`/opt/adb_monitor/sql/tablespace_usage.sql\` | Tablespace utilization with status | Daily |
| \`/opt/adb_monitor/sql/undo_retention.sql\` | Undo statistics and ORA-01555 detection | Daily |
| \`/opt/adb_monitor/sql/temp_segment_usage.sql\` | Temp segment usage by session | On-demand |
| \`/opt/adb_monitor/sql/failed_logins.sql\` | Failed login audit trail query | Daily |
| \`/opt/adb_monitor/sql/privilege_audit.sql\` | Privileged user activity audit | Daily |
| \`/opt/adb_monitor/sql/ddl_audit.sql\` | DDL change tracking | Daily |
| \`/etc/adb_monitor/adb_monitor.conf\` | Central configuration — all thresholds and paths | Edit as needed |
`,
};

async function main() {
  console.log('Inserting ADB self-monitoring runbook...');
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
