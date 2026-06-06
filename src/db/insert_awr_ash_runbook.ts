import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle AWR and ASH Performance Diagnostics',
  slug: 'oracle-awr-ash-diagnostics-runbook',
  excerpt:
    'A phased, production-ready runbook for Oracle AWR and ASH performance diagnostics — covering AWR configuration audits, snapshot and baseline management, top wait event and top SQL analysis, real-time and historical ASH queries, ADDM report generation, and an automated hourly shell script for threshold-based alerting. Requires Oracle Diagnostics Pack license.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-05'),
  youtubeUrl: null,
  content: `This runbook provides step-by-step procedures for Oracle AWR and ASH performance diagnostics. Assumptions: Oracle Database 12.2 or later; the executing user holds the DBA role or has been explicitly granted SELECT on the relevant DBA_HIST_* views and EXECUTE on DBMS_WORKLOAD_REPOSITORY and DBMS_ADDM; the Oracle Diagnostics Pack license is active (required for all DBA_HIST_* views, ADDM, and AWR reports); steps that modify AWR configuration or create advisor tasks require SYSDBA or appropriate DBA role privileges. All SQL runs in SQL*Plus or a compatible client connected to the target instance.

---

## Phase 0: AWR Configuration Audit

Before investigating a performance issue, verify that AWR is correctly configured for your retention and granularity requirements.

### Step 0.1 — Check AWR snapshot interval and retention

\`\`\`sql
SELECT snap_interval,
       retention,
       topnsql,
       most_recent_snap_id
FROM dba_hist_wr_control;
\`\`\`

Default values: \`snap_interval\` = +00000 01:00:00.0 (60 minutes), \`retention\` = +00008 00:00:00.0 (8 days). The \`topnsql\` column controls how many top SQL statements are captured per snapshot (default DEFAULT = 30). Adjust if you need higher SQL coverage.

### Step 0.2 — Verify STATISTICS_LEVEL

\`\`\`sql
SELECT name, value
FROM v\$parameter
WHERE name = 'statistics_level';
\`\`\`

Value must be \`TYPICAL\` or \`ALL\` for AWR and ASH collection to be active. A value of \`BASIC\` disables AWR entirely, which also disables the SGA/PGA advisors and SQL Tuning Advisor. If \`BASIC\` is set, AWR data will not exist for the problem period.

### Step 0.3 — Check SYSAUX space used by AWR

\`\`\`sql
SELECT occupant_name,
       schema_name,
       round(space_usage_kbytes / 1024, 1) AS space_mb
FROM v\$sysaux_occupants
WHERE occupant_name LIKE 'SM/%'
ORDER BY space_usage_kbytes DESC;
\`\`\`

The SM/AWR occupant is the primary AWR consumer. If SYSAUX is filling up due to AWR, shorten the retention period or truncate old snapshots using \`DBMS_WORKLOAD_REPOSITORY.DROP_SNAPSHOT_RANGE\`.

### Step 0.4 — Modify AWR retention and interval if needed

\`\`\`sql
-- Set snapshot every 30 minutes, retain 14 days (14 * 24 * 60 = 20160 minutes)
EXECUTE dbms_workload_repository.modify_snapshot_settings(
  interval  => 30,
  retention => 20160
);
\`\`\`

For production environments investigating recurring weekly patterns, increase retention to at least 14 days. For high-frequency diagnostics (active incidents), decrease the interval to 15 or 30 minutes to get finer-grained snapshots.

---

## Phase 1: Snapshot Management

### Step 1.1 — List recent snapshots

\`\`\`sql
SELECT snap_id,
       instance_number,
       begin_interval_time,
       end_interval_time
FROM dba_hist_snapshot
WHERE begin_interval_time > sysdate - 1
ORDER BY snap_id;
\`\`\`

Note the snap_id values bracketing the problem period. You will use these as \`start_snap\` and \`end_snap\` in subsequent queries throughout this runbook.

### Step 1.2 — Create a manual snapshot

\`\`\`sql
EXEC dbms_workload_repository.create_snapshot();
\`\`\`

Take a manual snapshot immediately before and after a planned change (patching, statistics refresh, index addition) to create precise before/after snapshot boundaries independent of the automatic 60-minute schedule.

### Step 1.3 — Create an AWR baseline for a known-good period

\`\`\`sql
EXEC dbms_workload_repository.create_baseline(
  start_snap_id => &start_snap,
  end_snap_id   => &end_snap,
  baseline_name => 'PRE_CHANGE_BASELINE'
);
\`\`\`

Replace \`&start_snap\` and \`&end_snap\` with the snap_id values from Step 1.1 that bracket the known-good period. Baseline names must be unique within the database. Fixed baselines are preserved indefinitely regardless of the AWR retention setting.

### Step 1.4 — List all existing baselines

\`\`\`sql
SELECT baseline_id,
       baseline_name,
       start_snap_id,
       end_snap_id,
       baseline_type
FROM dba_hist_baseline
ORDER BY baseline_id;
\`\`\`

Baseline types: STATIC (fixed, manually created), MOVING_WINDOW (tracks last N days automatically), DEFAULT (the built-in moving window baseline).

---

## Phase 2: AWR Report Generation

### Step 2.1 — Text-mode AWR report via SQL*Plus

\`\`\`sql
@?/rdbms/admin/awrrpt.sql
-- prompts for html|text, start snap_id, end snap_id, report name
\`\`\`

Use \`text\` format when piping to email or logging to a file. Use \`html\` for human review in a browser. The script prompts interactively for all parameters.

### Step 2.2 — Generate AWR report programmatically (non-interactive)

\`\`\`sql
SELECT output
FROM TABLE(
  dbms_workload_repository.awr_report_text(
    l_dbid     => (SELECT dbid FROM v\$database),
    l_inst_num => 1,
    l_bid      => &start_snap_id,
    l_eid      => &end_snap_id
  )
);
\`\`\`

This form is suitable for scripting from shell or scheduling. Spool the output to a file using SQL*Plus SPOOL. For HTML output, replace \`awr_report_text\` with \`awr_report_html\`.

### Step 2.3 — AWR diff report (compare two periods)

\`\`\`sql
@?/rdbms/admin/awrddrpt.sql
\`\`\`

The diff report prompts for two snapshot ranges and produces a side-by-side comparison of every AWR section. This is the fastest way to quantify regression: run it with the pre-change baseline snap range and the post-change snap range, and every metric that changed significantly will be immediately visible.

---

## Phase 3: Top Wait Event Analysis (AWR)

### Step 3.1 — Top foreground wait events for a snap range

\`\`\`sql
SELECT e.event_name,
       e.wait_class,
       sum(e.total_waits_fg)                                          AS total_waits,
       round(sum(e.time_waited_fg) / 1e6, 2)                         AS time_waited_sec,
       round(
         sum(e.time_waited_fg) /
         nullif(sum(e.total_waits_fg), 0) / 1e3,
         3
       )                                                              AS avg_wait_ms
FROM dba_hist_system_event e
JOIN dba_hist_snapshot s
  ON  s.snap_id          = e.snap_id
  AND s.dbid             = e.dbid
  AND s.instance_number  = e.instance_number
WHERE e.snap_id BETWEEN &start_snap AND &end_snap
  AND e.wait_class != 'Idle'
GROUP BY e.event_name, e.wait_class
ORDER BY sum(e.time_waited_fg) DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

The \`_fg\` suffix columns (foreground) exclude background process waits, isolating the wait experience of application-driven sessions. Sort by \`time_waited_sec\` to identify the biggest consumers of DB time. Sort by \`avg_wait_ms\` to identify events with high per-occurrence latency (useful for I/O response time analysis).

### Step 3.2 — DB time model breakdown

\`\`\`sql
SELECT stat_name,
       round(sum(value) / 1e6, 2) AS seconds
FROM dba_hist_sys_time_model
WHERE snap_id BETWEEN &start_snap AND &end_snap
  AND stat_name IN (
    'DB time',
    'DB CPU',
    'sql execute elapsed time',
    'parse time elapsed',
    'hard parse elapsed time',
    'PL/SQL execution elapsed time',
    'connection management call elapsed time'
  )
GROUP BY stat_name
ORDER BY sum(value) DESC;
\`\`\`

Compare \`DB CPU\` to \`DB time\`: if DB CPU approaches DB time, the workload is CPU-bound. If DB CPU is a small fraction of DB time, sessions are spending most of their time waiting. High \`hard parse elapsed time\` indicates cursor proliferation or missing bind variables.

---

## Phase 4: Top SQL Identification (AWR)

### Step 4.1 — Top SQL by elapsed time

\`\`\`sql
SELECT s.sql_id,
       round(sum(s.elapsed_time_delta) / 1e6, 2)                AS elapsed_sec,
       round(sum(s.cpu_time_delta) / 1e6, 2)                    AS cpu_sec,
       sum(s.executions_delta)                                   AS execs,
       round(
         sum(s.elapsed_time_delta) /
         nullif(sum(s.executions_delta), 0) / 1e3,
         2
       )                                                         AS avg_ms,
       sum(s.buffer_gets_delta)                                  AS buffer_gets,
       sum(s.disk_reads_delta)                                   AS disk_reads,
       t.sql_text
FROM dba_hist_sqlstat s
JOIN dba_hist_sqltext t
  ON  t.sql_id = s.sql_id
  AND t.dbid   = s.dbid
WHERE s.snap_id BETWEEN &start_snap AND &end_snap
  AND s.executions_delta > 0
GROUP BY s.sql_id, t.sql_text
ORDER BY sum(s.elapsed_time_delta) DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

The top SQL by elapsed time is almost always the right starting point for SQL tuning. Pay attention to \`avg_ms\`: a statement with high total elapsed time but low average elapsed time (high execution count) may indicate a lookup query that runs frequently but is individually fast — the fix is caching or batching, not query tuning.

### Step 4.2 — Detect plan regressions (same SQL_ID, multiple plan_hash_values)

\`\`\`sql
SELECT sql_id,
       plan_hash_value,
       min(snap_id)                                                       AS first_seen_snap,
       max(snap_id)                                                       AS last_seen_snap,
       round(
         sum(elapsed_time_delta) /
         nullif(sum(executions_delta), 0) / 1e3,
         2
       )                                                                  AS avg_ms,
       sum(executions_delta)                                              AS execs
FROM dba_hist_sqlstat
WHERE snap_id BETWEEN &start_snap AND &end_snap
  AND executions_delta > 0
GROUP BY sql_id, plan_hash_value
HAVING count(DISTINCT plan_hash_value)
         OVER (PARTITION BY sql_id) > 1
ORDER BY sql_id, min(snap_id);
\`\`\`

This query returns only SQL IDs that used more than one plan during the snap range, making plan regressions immediately visible. Compare \`avg_ms\` between the old and new \`plan_hash_value\` for the same \`sql_id\` to quantify the regression magnitude.

### Step 4.3 — Fetch full SQL text

\`\`\`sql
SELECT sql_text
FROM dba_hist_sqltext
WHERE sql_id = '&sql_id';
\`\`\`

SQL text in \`DBA_HIST_SQLTEXT\` may be truncated for very long statements. The full text is always available in \`V\$SQL\` if the statement is still in the shared pool: \`SELECT sql_fulltext FROM v\$sql WHERE sql_id = '&sql_id' AND rownum = 1\`.

### Step 4.4 — Fetch the execution plan from AWR

\`\`\`sql
SELECT *
FROM TABLE(
  dbms_xplan.display_awr('&sql_id', &plan_hash_value, null, 'ALL')
);
\`\`\`

The \`ALL\` format level includes predicate information, column projections, and notes sections which are essential for diagnosing filter vs. access predicate issues and identifying implicit type conversion problems. Pass \`null\` for \`plan_hash_value\` to retrieve all stored plans for the given SQL ID.

---

## Phase 5: Real-Time ASH Analysis

### Step 5.1 — Current active sessions (last 5 minutes)

\`\`\`sql
SELECT sql_id,
       event,
       wait_class,
       session_state,
       count(*)                                           AS samples,
       round(
         count(*) / sum(count(*)) OVER () * 100,
         1
       )                                                 AS pct
FROM v\$active_session_history
WHERE sample_time > sysdate - 5 / 1440
  AND session_type = 'FOREGROUND'
GROUP BY sql_id, event, wait_class, session_state
ORDER BY samples DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

Run this query during an active incident to immediately see where foreground sessions are spending time. The \`pct\` column shows the proportion of all active-session samples consumed by each SQL/event combination. A single SQL ID with \`session_state = 'WAITING'\` and an Application-class wait event accounting for over 50% of samples is a clear lock contention signal.

### Step 5.2 — Blocking session chains right now

\`\`\`sql
SELECT h.session_id   AS waiter,
       h.blocking_session AS blocker,
       h.event,
       h.sql_id,
       h.wait_time,
       s.username,
       s.module
FROM v\$active_session_history h
JOIN v\$session s
  ON s.sid = h.session_id
WHERE h.sample_time = (
        SELECT max(sample_time)
        FROM v\$active_session_history
      )
  AND h.blocking_session IS NOT NULL
ORDER BY h.wait_time DESC;
\`\`\`

This query returns all sessions in the most recent ASH sample that are blocked by another session. The \`blocker\` column is the SID of the lock holder. To find what the blocker is doing, query \`V\$SESSION\` or \`V\$ACTIVE_SESSION_HISTORY\` for that SID. The session with the longest \`wait_time\` has been blocked the longest and is likely the one causing the most application-tier timeout errors.

### Step 5.3 — ASH time-series to find when a problem started

\`\`\`sql
SELECT trunc(sample_time, 'MI') AS minute,
       wait_class,
       count(*)                 AS samples
FROM v\$active_session_history
WHERE sample_time > sysdate - 2 / 24
  AND session_type = 'FOREGROUND'
GROUP BY trunc(sample_time, 'MI'), wait_class
ORDER BY minute, samples DESC;
\`\`\`

This minute-by-minute breakdown of wait class counts is the fastest way to pinpoint the onset of a performance problem. Look for the first minute where a non-CPU wait class count spikes above the baseline. This timestamp is what you report to application teams and use to correlate with deployment or data events.

---

## Phase 6: Historical ASH Analysis (DBA_HIST_ACTIVE_SESS_HISTORY)

Historical ASH data uses a 1-in-10 sampling ratio: multiply \`count(*)\` by 10 to estimate actual active-session seconds. Replace \`&start_time\` and \`&end_time\` with the incident window in the format \`YYYY-MM-DD HH24:MI\`.

### Step 6.1 — Top events over a historical time range

\`\`\`sql
SELECT event,
       wait_class,
       count(*) * 10                                                    AS est_seconds,
       round(
         count(*) * 10 /
         (  extract(hour   FROM (max(sample_time) - min(sample_time))) * 3600
          + extract(minute FROM (max(sample_time) - min(sample_time))) * 60
          + extract(second FROM (max(sample_time) - min(sample_time))) + 1),
         1
       )                                                                AS avg_active_sessions
FROM dba_hist_active_sess_history
WHERE sample_time BETWEEN
        to_timestamp('&start_time', 'YYYY-MM-DD HH24:MI')
    AND to_timestamp('&end_time',   'YYYY-MM-DD HH24:MI')
  AND session_type = 'FOREGROUND'
GROUP BY event, wait_class
ORDER BY count(*) DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

The \`avg_active_sessions\` (AAS) metric is a normalized load measure: it represents the average number of sessions actively waiting for this event during the time range. An AAS above the number of available CPU cores for any single wait event indicates a clear bottleneck. AAS = 1.0 means one session was always waiting for this event throughout the window.

### Step 6.2 — Top SQL from historical ASH

\`\`\`sql
SELECT sql_id,
       count(*) * 10                                          AS est_seconds,
       round(count(*) * 10 / &duration_minutes / 60, 2)      AS avg_active_sessions
FROM dba_hist_active_sess_history
WHERE sample_time BETWEEN
        to_timestamp('&start_time', 'YYYY-MM-DD HH24:MI')
    AND to_timestamp('&end_time',   'YYYY-MM-DD HH24:MI')
  AND session_type = 'FOREGROUND'
  AND sql_id IS NOT NULL
GROUP BY sql_id
ORDER BY count(*) DESC
FETCH FIRST 15 ROWS ONLY;
\`\`\`

Replace \`&duration_minutes\` with the number of minutes in the time range. Cross-reference these SQL IDs against \`DBA_HIST_SQLSTAT\` (Phase 4) to get execution counts and per-execution averages for the same period.

### Step 6.3 — Top modules and application actions from historical ASH

\`\`\`sql
SELECT module,
       action,
       count(*) * 10                              AS est_db_time_sec,
       count(DISTINCT session_id)                 AS distinct_sessions
FROM dba_hist_active_sess_history
WHERE sample_time BETWEEN
        to_timestamp('&start_time', 'YYYY-MM-DD HH24:MI')
    AND to_timestamp('&end_time',   'YYYY-MM-DD HH24:MI')
GROUP BY module, action
ORDER BY count(*) DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

This query identifies which application modules and actions drove the most database load during the incident. Requires the application to set \`MODULE\` and \`ACTION\` via \`DBMS_APPLICATION_INFO\`. The \`distinct_sessions\` column distinguishes a single session generating a lot of work from many sessions each generating a little.

---

## Phase 7: ADDM Report

### Step 7.1 — Run ADDM interactively from SQL*Plus

\`\`\`sql
@?/rdbms/admin/addmrpt.sql
\`\`\`

Prompts for start snap ID, end snap ID, and report name. Produces a formatted text report showing the top finding, impact percentage, and recommendations. The most efficient path for ad-hoc incident analysis.

### Step 7.2 — Run ADDM programmatically and retrieve findings

\`\`\`sql
VARIABLE task_name VARCHAR2(30);

BEGIN
  :task_name := 'MY_ADDM_' || to_char(sysdate, 'YYYYMMDDHH24MI');
  dbms_addm.analyze_db(:task_name, &start_snap, &end_snap);
END;
/

SELECT type,
       attribute,
       impact_pct,
       message
FROM dba_advisor_findings
WHERE task_name = :task_name
ORDER BY impact_pct DESC;
\`\`\`

The \`impact_pct\` column quantifies each finding as a percentage of DB time affected. Focus on findings with \`type = 'PROBLEM'\` and \`impact_pct > 10\`. SYMPTOM-type findings are supporting evidence for PROBLEM findings, not independent issues. After review, clean up completed advisor tasks: \`EXECUTE DBMS_ADVISOR.DELETE_TASK(:task_name)\`.

---

## Phase 8: AWR Shell Report Script with Crontab Scheduling

Save the following script as \`/u01/app/oracle/scripts/awr_reports/awr_daily_report.sh\` and make it executable with \`chmod 755\`.

\`\`\`bash
#!/bin/bash
# awr_daily_report.sh — Generate hourly AWR report and alert on AAS thresholds
# Usage: awr_daily_report.sh <ORACLE_SID>
# Exit code: number of threshold breaches (0 = clean, for Nagios/Icinga)

set -euo pipefail

ORACLE_SID="\${1:?Usage: \$0 ORACLE_SID}"
export ORACLE_SID

# ── Environment ──────────────────────────────────────────────────────────────
ORACLE_HOME="\${ORACLE_HOME:-/u01/app/oracle/product/19.0.0/dbhome_1}"
export ORACLE_HOME
PATH="\${ORACLE_HOME}/bin:\${PATH}"
export PATH

REPORT_DIR="/u01/app/oracle/scripts/awr_reports"
LOG_DIR="\${REPORT_DIR}/logs"
REPORT_FILE="\${REPORT_DIR}/\${ORACLE_SID}_awr_\$(date +%Y%m%d_%H%M).txt"
ALERT_EMAIL="dba-alerts@example.com"
WARN_AAS=4      # average active sessions warning threshold
CRIT_AAS=8      # average active sessions critical threshold

mkdir -p "\${REPORT_DIR}" "\${LOG_DIR}"

echo "=== AWR Hourly Report: \${ORACLE_SID} at \$(date) ===" | tee "\${REPORT_FILE}"

# ── Get the two most recent snap IDs ─────────────────────────────────────────
read -r START_SNAP END_SNAP < <(sqlplus -s /nolog <<'SQLEOF'
CONNECT / AS SYSDBA
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF VERIFY OFF TRIMOUT ON
SELECT min(snap_id), max(snap_id)
FROM (
  SELECT snap_id
  FROM dba_hist_snapshot
  WHERE begin_interval_time > sysdate - 2/24
  ORDER BY snap_id DESC
  FETCH FIRST 2 ROWS ONLY
);
EXIT
SQLEOF
)

if [[ -z "\${START_SNAP}" || -z "\${END_SNAP}" || "\${START_SNAP}" == "\${END_SNAP}" ]]; then
  echo "ERROR: Could not retrieve two distinct recent snap IDs. AWR may not be configured." | tee -a "\${REPORT_FILE}"
  exit 1
fi

echo "Snap range: \${START_SNAP} -> \${END_SNAP}" | tee -a "\${REPORT_FILE}"

# ── Generate AWR text report ──────────────────────────────────────────────────
sqlplus -s /nolog >> "\${REPORT_FILE}" 2>&1 <<SQLEOF
CONNECT / AS SYSDBA
SET LONG 100000 LONGCHUNKSIZE 1000 LINESIZE 200 PAGESIZE 50000
SET FEEDBACK OFF HEADING OFF VERIFY OFF TRIMOUT ON
SELECT output
FROM TABLE(
  dbms_workload_repository.awr_report_text(
    l_dbid     => (SELECT dbid FROM v\$database),
    l_inst_num => 1,
    l_bid      => \${START_SNAP},
    l_eid      => \${END_SNAP}
  )
);
EXIT
SQLEOF

# ── Compute avg active sessions from top ASH wait classes ────────────────────
DURATION_MIN=60
AAS_RESULT=\$(sqlplus -s /nolog <<SQLEOF
CONNECT / AS SYSDBA
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF VERIFY OFF TRIMOUT ON
SELECT round(
         count(*) * 10 / (\${DURATION_MIN} * 60),
         2
       ) AS avg_active_sessions
FROM v\$active_session_history
WHERE sample_time > sysdate - \${DURATION_MIN}/1440
  AND session_type = 'FOREGROUND'
  AND session_state = 'WAITING'
  AND wait_class   != 'Idle';
EXIT
SQLEOF
)

AAS_RESULT=\$(echo "\${AAS_RESULT}" | tr -d ' ')

echo "" | tee -a "\${REPORT_FILE}"
echo "=== AAS (non-idle waits, last \${DURATION_MIN} min): \${AAS_RESULT} ===" | tee -a "\${REPORT_FILE}"

# ── Threshold evaluation ──────────────────────────────────────────────────────
BREACHES=0
STATUS="OK"

# Use awk for floating-point comparison (bash only handles integers)
if awk "BEGIN { exit !(\${AAS_RESULT} >= \${CRIT_AAS}) }"; then
  STATUS="CRITICAL"
  BREACHES=\$((BREACHES + 1))
  echo "CRITICAL: AAS \${AAS_RESULT} >= threshold \${CRIT_AAS}" | tee -a "\${REPORT_FILE}"
elif awk "BEGIN { exit !(\${AAS_RESULT} >= \${WARN_AAS}) }"; then
  STATUS="WARNING"
  BREACHES=\$((BREACHES + 1))
  echo "WARNING: AAS \${AAS_RESULT} >= threshold \${WARN_AAS}" | tee -a "\${REPORT_FILE}"
else
  echo "OK: AAS \${AAS_RESULT} is below warning threshold \${WARN_AAS}" | tee -a "\${REPORT_FILE}"
fi

# ── Email if threshold breached ───────────────────────────────────────────────
if [[ \${BREACHES} -gt 0 ]]; then
  if command -v mailx &>/dev/null; then
    mailx -s "[\${STATUS}] AWR Alert: \${ORACLE_SID} AAS=\${AAS_RESULT}" \
          "\${ALERT_EMAIL}" < "\${REPORT_FILE}"
  elif command -v sendmail &>/dev/null; then
    (
      echo "To: \${ALERT_EMAIL}"
      echo "Subject: [\${STATUS}] AWR Alert: \${ORACLE_SID} AAS=\${AAS_RESULT}"
      echo ""
      cat "\${REPORT_FILE}"
    ) | sendmail "\${ALERT_EMAIL}"
  else
    echo "WARNING: No mail command found. Report saved to \${REPORT_FILE}" | tee -a "\${LOG_DIR}/cron_awr.log"
  fi
fi

echo "Report written to: \${REPORT_FILE}" | tee -a "\${LOG_DIR}/cron_awr.log"

# Exit code = number of threshold breaches (0 = clean, for Nagios/Icinga)
exit \${BREACHES}
\`\`\`

### Crontab entry

\`\`\`
# AWR hourly report — run 5 min after the top of each hour (after AWR snapshot)
5  *  *  *  *  /u01/app/oracle/scripts/awr_reports/awr_daily_report.sh PRODDB >> /u01/app/oracle/scripts/awr_reports/logs/cron_awr.log 2>&1
\`\`\`

Install with: \`crontab -e\` as the oracle OS user. The script returns exit code 0 (no breach), 1 (warning or critical), or higher if multiple thresholds are breached — this integrates directly with Nagios/Icinga passive checks or NRPE.

---

## Phase 9: AWR Baselines and Comparative Analysis

### Step 9.1 — Create a fixed baseline for pre-change comparison

\`\`\`sql
-- Identify the snap IDs for the pre-change period
SELECT snap_id, begin_interval_time, end_interval_time
FROM dba_hist_snapshot
WHERE begin_interval_time BETWEEN
        to_timestamp('&baseline_start', 'YYYY-MM-DD HH24:MI')
    AND to_timestamp('&baseline_end',   'YYYY-MM-DD HH24:MI')
ORDER BY snap_id;

-- Create the fixed baseline (preserves these snaps beyond normal retention)
EXEC dbms_workload_repository.create_baseline(
  start_snap_id => &first_snap_in_range,
  end_snap_id   => &last_snap_in_range,
  baseline_name => 'PRE_DEPLOY_' || to_char(sysdate, 'YYYYMMDD')
);
\`\`\`

Create this baseline immediately before any change that might affect performance. Fixed baselines persist until explicitly dropped with \`DBMS_WORKLOAD_REPOSITORY.DROP_BASELINE\`.

### Step 9.2 — List all baselines and their snap ranges

\`\`\`sql
SELECT b.baseline_id,
       b.baseline_name,
       b.baseline_type,
       b.start_snap_id,
       b.end_snap_id,
       s1.begin_interval_time AS baseline_start,
       s2.end_interval_time   AS baseline_end,
       round(
         (cast(s2.end_interval_time AS date) -
          cast(s1.begin_interval_time AS date)) * 24, 1
       )                      AS duration_hours
FROM dba_hist_baseline b
JOIN dba_hist_snapshot s1
  ON  s1.snap_id        = b.start_snap_id
  AND s1.dbid           = b.dbid
JOIN dba_hist_snapshot s2
  ON  s2.snap_id        = b.end_snap_id
  AND s2.dbid           = b.dbid
ORDER BY b.baseline_id;
\`\`\`

### Step 9.3 — Compare SQL performance: baseline period vs. current period

\`\`\`sql
-- Elapsed time ratio: current avg_ms / baseline avg_ms for matching SQL
-- Values > 1.0 mean SQL is slower in the current period than in baseline
SELECT cur.sql_id,
       round(cur.avg_ms, 2)                                    AS current_avg_ms,
       round(base.avg_ms, 2)                                   AS baseline_avg_ms,
       round(cur.avg_ms / nullif(base.avg_ms, 0), 2)          AS regression_ratio,
       cur.current_execs,
       base.baseline_execs,
       substr(t.sql_text, 1, 80)                               AS sql_preview
FROM (
  -- Current period
  SELECT sql_id,
         sum(elapsed_time_delta) /
           nullif(sum(executions_delta), 0) / 1e3              AS avg_ms,
         sum(executions_delta)                                  AS current_execs
  FROM dba_hist_sqlstat
  WHERE snap_id BETWEEN &current_start_snap AND &current_end_snap
    AND executions_delta > 0
  GROUP BY sql_id
) cur
JOIN (
  -- Baseline period (use the snap IDs from the fixed baseline)
  SELECT sql_id,
         sum(elapsed_time_delta) /
           nullif(sum(executions_delta), 0) / 1e3              AS avg_ms,
         sum(executions_delta)                                  AS baseline_execs
  FROM dba_hist_sqlstat
  WHERE snap_id BETWEEN &baseline_start_snap AND &baseline_end_snap
    AND executions_delta > 0
  GROUP BY sql_id
) base
  ON base.sql_id = cur.sql_id
JOIN dba_hist_sqltext t
  ON  t.sql_id = cur.sql_id
  AND t.dbid   = (SELECT dbid FROM v\$database)
WHERE cur.avg_ms / nullif(base.avg_ms, 0) > 1.2   -- 20%+ regression threshold
ORDER BY regression_ratio DESC
FETCH FIRST 30 ROWS ONLY;
\`\`\`

A \`regression_ratio\` of 2.0 means the SQL is taking twice as long on average in the current period compared to the baseline. This query is the most efficient way to answer "which SQL statements got slower after the deployment?" without reading the full AWR diff report.

---

## Quick Reference

### Key Views

| View | Description |
|---|---|
| \`V\$ACTIVE_SESSION_HISTORY\` | In-memory ASH buffer, full 1-second sampling, ~30 min retention, free with EE |
| \`DBA_HIST_ACTIVE_SESS_HISTORY\` | Persistent ASH (1-in-10 sampled), stored in SYSAUX, requires Diagnostics Pack |
| \`DBA_HIST_SQLSTAT\` | Per-SQL execution statistics deltas per snapshot interval |
| \`DBA_HIST_SQLTEXT\` | SQL text for all SQL IDs captured in AWR |
| \`DBA_HIST_SQL_PLAN\` | Execution plan rows (from EXPLAIN PLAN) captured in AWR per plan_hash_value |
| \`DBA_HIST_SYSTEM_EVENT\` | Wait event totals per snapshot interval |
| \`DBA_HIST_SYS_TIME_MODEL\` | DB time model breakdown per snapshot interval |
| \`DBA_HIST_SNAPSHOT\` | Snapshot inventory: snap_id, begin/end interval_time, dbid, instance_number |
| \`DBA_HIST_BASELINE\` | Defined baselines (fixed and moving window) |
| \`DBA_HIST_WR_CONTROL\` | AWR configuration: snap_interval, retention, topnsql |

### Key Packages

| Package | Key Procedures / Functions |
|---|---|
| \`DBMS_WORKLOAD_REPOSITORY\` | \`CREATE_SNAPSHOT\`, \`MODIFY_SNAPSHOT_SETTINGS\`, \`CREATE_BASELINE\`, \`DROP_BASELINE\`, \`AWR_REPORT_TEXT\`, \`AWR_REPORT_HTML\` |
| \`DBMS_ADDM\` | \`ANALYZE_DB\` — creates an ADDM task for a snap range |
| \`DBMS_XPLAN\` | \`DISPLAY_AWR\` — retrieves a stored execution plan from AWR by sql_id and plan_hash_value |

### AWR Script Reference

| Script | Purpose |
|---|---|
| \`@\$ORACLE_HOME/rdbms/admin/awrrpt.sql\` | Interactive AWR text or HTML report |
| \`@\$ORACLE_HOME/rdbms/admin/awrddrpt.sql\` | AWR diff report: two periods side-by-side |
| \`@\$ORACLE_HOME/rdbms/admin/addmrpt.sql\` | Interactive ADDM report for a snap range |
| \`@\$ORACLE_HOME/rdbms/admin/ashrpt.sql\` | Interactive ASH report for a time range |
| \`@\$ORACLE_HOME/rdbms/admin/ashrpti.sql\` | ASH report: instance-level with SQL detail |

### Licensing Summary

- **Requires Diagnostics Pack**: All \`DBA_HIST_*\` views, AWR reports, ADDM, ASH reports against \`DBA_HIST_ACTIVE_SESS_HISTORY\`
- **Free with Enterprise Edition**: \`V\$ACTIVE_SESSION_HISTORY\` (in-memory buffer only)
- **Free alternative**: STATSPACK (\`@\$ORACLE_HOME/rdbms/admin/spcreate.sql\`)
- **STATISTICS_LEVEL**: Must be \`TYPICAL\` (default) or \`ALL\` for AWR/ASH collection`,
};

async function main() {
  console.log('Inserting Oracle AWR and ASH runbook post...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: { ...post },
  });
  console.log('Inserted: "' + post.title + '"');
}

main().catch(console.error);
