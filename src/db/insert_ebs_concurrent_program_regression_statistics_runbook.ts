import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: EBS Concurrent Program Performance Regression — Statistical Triage and AWR/ASH/ADDM Investigation',
  slug: 'ebs-concurrent-program-regression-z-score-pvalue-awr-ash-addm-runbook',
  excerpt:
    'Step-by-step runbook for triaging EBS concurrent program slowness using z-score against 90-day FND_CONC_REQUESTS history, then drilling into AWR snapshot windows, ASH session activity, ADDM findings, and execution plan changes. Includes cp_regression_check.sh automation script that computes z-score and identifies the AWR bracket for any request ID.',
  category: 'performance-dw' as const,
  isPremium: false,
  published: true,
  publishedAt: new Date('2026-07-20T12:05:00.000Z'),
  youtubeUrl: null,
  content: `## Phase 1: Identify the Concurrent Program

Get the concurrent program's numeric ID and confirm recent run history exists:

\`\`\`sql
SELECT
  cp.concurrent_program_id,
  cp.concurrent_program_name,
  fa.application_short_name,
  cp.user_concurrent_program_name
FROM fnd_concurrent_programs cp
JOIN fnd_application fa ON fa.application_id = cp.application_id
WHERE UPPER(cp.concurrent_program_name) LIKE UPPER('%PROGRAM_SHORT_NAME%')
   OR UPPER(cp.user_concurrent_program_name) LIKE UPPER('%Display Name%');
\`\`\`

Count available history to determine whether n ≥ 30 (minimum for reliable z-score; use t-distribution for smaller samples):

\`\`\`sql
SELECT COUNT(*) AS completed_runs_90d
FROM fnd_conc_requests r
WHERE r.concurrent_program_id    = :prog_id
  AND r.program_application_id   = :prog_app_id
  AND r.phase_code  = 'C'
  AND r.status_code = 'C'
  AND r.actual_start_date >= SYSDATE - 90;
\`\`\`

---

## Phase 2: Pull Full Statistical Baseline (Last 90 Days, Exclude Today)

\`\`\`sql
WITH history AS (
  SELECT
    r.request_id,
    r.actual_start_date,
    ROUND((r.actual_completion_date - r.actual_start_date) * 24 * 60, 4) AS duration_min
  FROM fnd_conc_requests r
  WHERE r.concurrent_program_id  = :prog_id
    AND r.program_application_id = :prog_app_id
    AND r.phase_code  = 'C'
    AND r.status_code = 'C'
    AND r.actual_start_date BETWEEN SYSDATE - 91 AND SYSDATE - 1
)
SELECT
  COUNT(*)                                                              AS n,
  ROUND(AVG(duration_min), 2)                                          AS mean_min,
  ROUND(STDDEV(duration_min), 2)                                       AS stddev_min,
  ROUND(STDDEV(duration_min) / AVG(duration_min) * 100, 1)            AS cv_pct,
  ROUND(MIN(duration_min), 2)                                          AS min_min,
  ROUND(MAX(duration_min), 2)                                          AS max_min,
  ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY duration_min), 2) AS median_min,
  ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_min), 2) AS p95_min
FROM history;
\`\`\`

Record the output. If \`cv_pct\` > 40 proceed to the robust z-score in Phase 3b; otherwise use standard z-score in Phase 3a.

---

## Phase 3a: Compute Standard Z-Score for the Target Request

Replace 123456789 with the actual request_id under investigation:

\`\`\`sql
WITH history AS (
  SELECT
    ROUND((r.actual_completion_date - r.actual_start_date) * 24 * 60, 4) AS duration_min
  FROM fnd_conc_requests r
  WHERE r.concurrent_program_id  = :prog_id
    AND r.program_application_id = :prog_app_id
    AND r.phase_code  = 'C'
    AND r.status_code = 'C'
    AND r.actual_start_date BETWEEN SYSDATE - 91 AND SYSDATE - 1
),
baseline AS (
  SELECT AVG(duration_min) AS mu, STDDEV(duration_min) AS sigma, COUNT(*) AS n
  FROM history
),
current_run AS (
  SELECT request_id,
         ROUND((actual_completion_date - actual_start_date) * 24 * 60, 2) AS current_min,
         argument_text
  FROM fnd_conc_requests
  WHERE request_id = 123456789
)
SELECT
  c.request_id,
  c.current_min,
  c.argument_text,
  ROUND(b.mu, 2)                                               AS historical_mean,
  ROUND(b.sigma, 2)                                            AS historical_stddev,
  b.n                                                          AS sample_size,
  ROUND((c.current_min - b.mu) / NULLIF(b.sigma, 0), 3)       AS z_score,
  CASE
    WHEN (c.current_min - b.mu) / NULLIF(b.sigma, 0) > 3.09
      THEN 'p < 0.001  CRITICAL'
    WHEN (c.current_min - b.mu) / NULLIF(b.sigma, 0) > 2.58
      THEN 'p < 0.01   SEVERE'
    WHEN (c.current_min - b.mu) / NULLIF(b.sigma, 0) > 1.96
      THEN 'p < 0.05   SIGNIFICANT'
    WHEN (c.current_min - b.mu) / NULLIF(b.sigma, 0) > 1.645
      THEN 'p < 0.10   MARGINAL'
    ELSE
      'NOT SIGNIFICANT'
  END AS significance
FROM current_run c, baseline b;
\`\`\`

Decision: if \`significance\` is NOT SIGNIFICANT — document and close. Otherwise continue to Phase 4.

---

## Phase 3b: Robust Z-Score for High-Variance Programs (CV > 40%)

\`\`\`sql
WITH history AS (
  SELECT
    ROUND((r.actual_completion_date - r.actual_start_date) * 24 * 60, 4) AS duration_min
  FROM fnd_conc_requests r
  WHERE r.concurrent_program_id  = :prog_id
    AND r.program_application_id = :prog_app_id
    AND r.phase_code  = 'C'
    AND r.status_code = 'C'
    AND r.actual_start_date BETWEEN SYSDATE - 91 AND SYSDATE - 1
),
med AS (
  SELECT PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY duration_min) AS median_val
  FROM history
),
mad_tbl AS (
  SELECT
    PERCENTILE_CONT(0.50) WITHIN GROUP (
      ORDER BY ABS(h.duration_min - m.median_val)
    ) AS mad_val
  FROM history h, med m
),
current_run AS (
  SELECT ROUND((actual_completion_date - actual_start_date) * 24 * 60, 2) AS current_min
  FROM fnd_conc_requests WHERE request_id = 123456789
)
SELECT
  ROUND(c.current_min, 2)                                           AS current_minutes,
  ROUND(m.median_val, 2)                                            AS historical_median,
  ROUND(d.mad_val, 2)                                               AS mad,
  ROUND(0.6745 * (c.current_min - m.median_val) / NULLIF(d.mad_val, 0), 3) AS modified_z,
  CASE
    WHEN 0.6745 * (c.current_min - m.median_val) / NULLIF(d.mad_val, 0) > 3.5
      THEN 'CRITICAL OUTLIER'
    WHEN 0.6745 * (c.current_min - m.median_val) / NULLIF(d.mad_val, 0) > 2.5
      THEN 'SUSPICIOUS — Investigate'
    ELSE 'Within expected range'
  END AS classification
FROM current_run c, med m, mad_tbl d;
\`\`\`

---

## Phase 4: Check Whether Argument Changes Explain the Duration

Before pulling AWR, check if the program arguments changed — different data range or entity scope can legitimately cause a longer run:

\`\`\`sql
SELECT
  r.request_id,
  r.actual_start_date,
  ROUND((r.actual_completion_date - r.actual_start_date) * 24 * 60, 1) AS duration_min,
  r.argument_text
FROM fnd_conc_requests r
WHERE r.concurrent_program_id  = :prog_id
  AND r.program_application_id = :prog_app_id
  AND r.phase_code  = 'C'
  AND r.status_code = 'C'
  AND r.actual_start_date >= SYSDATE - 30
ORDER BY r.actual_start_date DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

If \`argument_text\` for the slow run is identical to recent fast runs → proceed to AWR. If arguments differ (wider date range, more orgs) → note this in the ticket but still investigate with ASH.

---

## Phase 5: Locate AWR Snapshot Window

Find the AWR snapshots that bracket the concurrent request run:

\`\`\`sql
SELECT
  s.snap_id,
  s.instance_number,
  TO_CHAR(s.begin_interval_time, 'YYYY-MM-DD HH24:MI:SS') AS begin_time,
  TO_CHAR(s.end_interval_time,   'YYYY-MM-DD HH24:MI:SS') AS end_time
FROM dba_hist_snapshot s
JOIN fnd_conc_requests r ON r.request_id = 123456789
WHERE s.dbid = (SELECT dbid FROM v$database)
  AND s.end_interval_time   >= r.actual_start_date      - INTERVAL '1' HOUR
  AND s.begin_interval_time <= NVL(r.actual_completion_date, SYSDATE) + INTERVAL '1' HOUR
ORDER BY s.snap_id;
\`\`\`

Record the minimum snap_id as \`begin_snap\` and maximum as \`end_snap\`. Record \`instance_number\` — for RAC clusters, the concurrent program ran on a specific node.

---

## Phase 6: ASH — Session Activity During the Run

For a completed run older than 1 hour (uses DBA_HIST_ACTIVE_SESS_HISTORY):

\`\`\`sql
SELECT
  ash.sql_id,
  ash.event,
  ash.wait_class,
  SUBSTR(sq.sql_text, 1, 100)                                      AS sql_snippet,
  COUNT(*)                                                          AS ash_samples,
  ROUND(COUNT(*) / SUM(COUNT(*)) OVER () * 100, 1)                AS pct_db_time,
  ROUND(COUNT(*) * 10, 0)                                          AS approx_seconds
FROM dba_hist_active_sess_history ash
JOIN fnd_conc_requests r       ON r.oracle_session_id = ash.session_id
                             AND r.request_id          = 123456789
LEFT JOIN dba_hist_sqltext sq  ON sq.sql_id = ash.sql_id
                             AND sq.dbid    = ash.dbid
WHERE ash.sample_time BETWEEN r.actual_start_date
                          AND r.actual_completion_date
GROUP BY ash.sql_id, ash.event, ash.wait_class, SUBSTR(sq.sql_text, 1, 100)
ORDER BY ash_samples DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

For a run still in progress or completed in the last hour (V$ACTIVE_SESSION_HISTORY):

\`\`\`sql
SELECT
  ash.sql_id,
  ash.event,
  ash.wait_class,
  COUNT(*)                                                          AS ash_samples,
  ROUND(COUNT(*) / SUM(COUNT(*)) OVER () * 100, 1)                AS pct_db_time
FROM v$active_session_history ash
JOIN fnd_conc_requests r ON r.oracle_session_id = ash.session_id
WHERE r.request_id = 123456789
  AND ash.sample_time BETWEEN r.actual_start_date
                          AND NVL(r.actual_completion_date, SYSDATE)
GROUP BY ash.sql_id, ash.event, ash.wait_class
ORDER BY ash_samples DESC
FETCH FIRST 15 ROWS ONLY;
\`\`\`

Wait event interpretation table:

| Event | Wait Class | Likely Cause |
|---|---|---|
| db file sequential read | User I/O | Index scan — check plan change |
| db file scattered read | User I/O | Full table scan — missing stats or index |
| log file sync | Commit | Excessive per-row commits in PL/SQL |
| enq: TX - row lock contention | Concurrency | Blocked by another session |
| latch: shared pool | Concurrency | Hard parse storm |
| NULL (CPU) | — | Parse-heavy PL/SQL or computation loop |
| read by other session | User I/O | Another session loading same blocks |

---

## Phase 7: ADDM — Automated Bottleneck Analysis

Run ADDM against the snapshot window identified in Phase 5:

\`\`\`sql
DECLARE
  l_task_name VARCHAR2(100) := 'ADDM_CP_123456789';
BEGIN
  DBMS_ADDM.ANALYZE_DB(
    task_name  => l_task_name,
    begin_snap => 12045,
    end_snap   => 12047,
    db_id      => (SELECT dbid FROM v$database)
  );
END;
/

SELECT
  f.type,
  SUBSTR(f.message, 1, 200) AS finding,
  ROUND(f.benefit, 1)       AS benefit_pct
FROM dba_advisor_tasks t
JOIN dba_advisor_findings f ON f.task_id = t.task_id
WHERE t.task_name    = 'ADDM_CP_123456789'
  AND t.advisor_name = 'ADDM'
ORDER BY f.benefit DESC;
\`\`\`

Note: on EBS 12.2.x, ADDM may run automatically every AWR snapshot interval — check \`DBA_ADVISOR_TASKS\` for existing tasks covering the window before creating a new one.

---

## Phase 8: Drill Down — Execution Plan Change for the Dominant SQL

From Phase 6 ASH output, identify the SQL_ID with the most samples. Check if its execution plan changed:

\`\`\`sql
SELECT DISTINCT
  p.sql_id,
  p.plan_hash_value,
  s.executions,
  ROUND(s.elapsed_time / 1e6 / NULLIF(s.executions, 0), 2) AS avg_elapsed_sec,
  ROUND(s.cpu_time / 1e6 / NULLIF(s.executions, 0), 2)     AS avg_cpu_sec,
  TO_CHAR(sn.begin_interval_time, 'YYYY-MM-DD HH24:MI')     AS first_seen
FROM dba_hist_sql_plan p
JOIN dba_hist_sqlstat s   ON s.sql_id         = p.sql_id
                         AND s.plan_hash_value = p.plan_hash_value
                         AND s.dbid            = p.dbid
JOIN dba_hist_snapshot sn ON sn.snap_id = s.snap_id AND sn.dbid = s.dbid
WHERE p.sql_id = 'abc123defg456'
ORDER BY sn.begin_interval_time DESC;
\`\`\`

If multiple plan_hash_values appear:

\`\`\`sql
-- Display the fast historical plan
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_AWR('abc123defg456', :fast_plan_hash, NULL, 'ALL'));

-- Display the current (slow) plan
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_AWR('abc123defg456', :slow_plan_hash, NULL, 'ALL'));
\`\`\`

Look for: join order reversal, index scan switched to full table scan, nested loops replaced by hash join on a large table, missing or wrong cardinality estimates. A plan change is the most common cause of sudden single-program regression.

---

## Phase 9: Weekly Trend — Gradual vs Sudden Regression

\`\`\`sql
SELECT
  TRUNC(r.actual_start_date, 'IW')                                  AS week_start,
  COUNT(*)                                                           AS runs,
  ROUND(AVG((r.actual_completion_date - r.actual_start_date) * 24 * 60), 1) AS avg_min,
  ROUND(MIN((r.actual_completion_date - r.actual_start_date) * 24 * 60), 1) AS min_min,
  ROUND(MAX((r.actual_completion_date - r.actual_start_date) * 24 * 60), 1) AS max_min
FROM fnd_conc_requests r
WHERE r.concurrent_program_id  = :prog_id
  AND r.program_application_id = :prog_app_id
  AND r.phase_code  = 'C'
  AND r.status_code = 'C'
  AND r.actual_start_date >= SYSDATE - 90
GROUP BY TRUNC(r.actual_start_date, 'IW')
ORDER BY week_start;
\`\`\`

A flat trend with a sudden spike in the most recent week → acute regression (plan change, stats change, missing index). A steady upward week-over-week trend → data growth, index bloat, or I/O capacity constraint.

---

## Phase 10: Automation Script — cp_regression_check.sh

Save the following script as \`cp_regression_check.sh\` and make it executable with \`chmod +x cp_regression_check.sh\`.

\`\`\`bash
#!/bin/bash
# cp_regression_check.sh
# Usage: ./cp_regression_check.sh <PROGRAM_SHORT_NAME> [REQUEST_ID]
# Exit 0 = NOT SIGNIFICANT, Exit 1 = significant regression detected

# ---------------------------------------------------------------------------
# CONFIGURATION — edit before running
# ---------------------------------------------------------------------------
ORACLE_SID="EBSPROD"
ORACLE_HOME="/u01/app/oracle/product/19.3.0/dbhome_1"
APPS_USER="apps"
APPS_PASS="apps_password"
LOG_DIR="/tmp/cp_regression"
# ---------------------------------------------------------------------------

export ORACLE_HOME ORACLE_SID
export PATH=$ORACLE_HOME/bin:$PATH
export LD_LIBRARY_PATH=$ORACLE_HOME/lib:$LD_LIBRARY_PATH

PROGRAM_NAME="$1"
REQUEST_ID="$2"

if [ -z "$PROGRAM_NAME" ]; then
  echo "Usage: $0 <PROGRAM_SHORT_NAME> [REQUEST_ID]"
  exit 2
fi

mkdir -p "$LOG_DIR"
TIMESTAMP=$(date '+%Y%m%d_%H%M%S')
LOGFILE="$LOG_DIR/cp_regression_\${TIMESTAMP}.log"

log() {
  echo "$1" | tee -a "$LOGFILE"
}

log "=========================================="
log "EBS Concurrent Program Regression Check"
log "Program  : $PROGRAM_NAME"
log "Timestamp: $TIMESTAMP"
log "=========================================="

# ---------------------------------------------------------------------------
# Step 1: Look up program_id and program_application_id
# ---------------------------------------------------------------------------
log ""
log "--- Step 1: Resolving program metadata ---"

PROG_META=$(sqlplus -s "$APPS_USER/$APPS_PASS@$ORACLE_SID" <<ENDSQL
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF VERIFY OFF TRIMOUT ON TRIMSPOOL ON
SELECT cp.concurrent_program_id || '|' || cp.application_id
FROM fnd_concurrent_programs cp
WHERE UPPER(cp.concurrent_program_name) = UPPER('$PROGRAM_NAME')
  AND ROWNUM = 1;
EXIT;
ENDSQL
)

PROG_META=$(echo "$PROG_META" | tr -d ' \r')

if [ -z "$PROG_META" ] || echo "$PROG_META" | grep -q "ORA-"; then
  log "ERROR: Program '$PROGRAM_NAME' not found or SQL error."
  log "$PROG_META"
  exit 2
fi

PROG_ID=$(echo "$PROG_META" | cut -d'|' -f1)
PROG_APP_ID=$(echo "$PROG_META" | cut -d'|' -f2)

log "  concurrent_program_id   : $PROG_ID"
log "  program_application_id  : $PROG_APP_ID"

# ---------------------------------------------------------------------------
# Step 2: If REQUEST_ID not supplied, find the most recent completed run
# ---------------------------------------------------------------------------
if [ -z "$REQUEST_ID" ]; then
  log ""
  log "--- Step 2: Finding most recent completed request ---"

  REQUEST_ID=$(sqlplus -s "$APPS_USER/$APPS_PASS@$ORACLE_SID" <<ENDSQL
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF VERIFY OFF TRIMOUT ON TRIMSPOOL ON
SELECT MAX(request_id)
FROM fnd_conc_requests
WHERE concurrent_program_id  = $PROG_ID
  AND program_application_id = $PROG_APP_ID
  AND phase_code  = 'C'
  AND status_code = 'C'
  AND actual_start_date >= SYSDATE - 7;
EXIT;
ENDSQL
  )

  REQUEST_ID=$(echo "$REQUEST_ID" | tr -d ' \r')

  if [ -z "$REQUEST_ID" ] || [ "$REQUEST_ID" = "" ]; then
    log "ERROR: No completed runs found in the last 7 days for '$PROGRAM_NAME'."
    exit 2
  fi
  log "  Using request_id: $REQUEST_ID"
else
  log "  Using supplied request_id: $REQUEST_ID"
fi

# ---------------------------------------------------------------------------
# Step 3: Baseline statistics (90 days, exclude today)
# ---------------------------------------------------------------------------
log ""
log "--- Step 3: 90-day baseline statistics ---"

BASELINE=$(sqlplus -s "$APPS_USER/$APPS_PASS@$ORACLE_SID" <<ENDSQL
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF VERIFY OFF TRIMOUT ON TRIMSPOOL ON NUMWIDTH 12
WITH history AS (
  SELECT
    ROUND((r.actual_completion_date - r.actual_start_date) * 24 * 60, 4) AS duration_min
  FROM fnd_conc_requests r
  WHERE r.concurrent_program_id  = $PROG_ID
    AND r.program_application_id = $PROG_APP_ID
    AND r.phase_code  = 'C'
    AND r.status_code = 'C'
    AND r.actual_start_date BETWEEN SYSDATE - 91 AND SYSDATE - 1
)
SELECT
  COUNT(*) || '|' ||
  ROUND(AVG(duration_min), 4) || '|' ||
  ROUND(STDDEV(duration_min), 4) || '|' ||
  ROUND(STDDEV(duration_min) / NULLIF(AVG(duration_min), 0) * 100, 1) || '|' ||
  ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY duration_min), 4) || '|' ||
  ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_min), 4)
FROM history;
EXIT;
ENDSQL
)

BASELINE=$(echo "$BASELINE" | tr -d ' \r')

N=$(echo "$BASELINE"      | cut -d'|' -f1)
MEAN=$(echo "$BASELINE"   | cut -d'|' -f2)
STDDEV=$(echo "$BASELINE" | cut -d'|' -f3)
CV=$(echo "$BASELINE"     | cut -d'|' -f4)
MEDIAN=$(echo "$BASELINE" | cut -d'|' -f5)
P95=$(echo "$BASELINE"    | cut -d'|' -f6)

log "  Sample size (n) : $N"
log "  Mean            : $MEAN minutes"
log "  Std dev         : $STDDEV minutes"
log "  CV%             : $CV"
log "  Median          : $MEDIAN minutes"
log "  P95             : $P95 minutes"

if [ -z "$N" ] || [ "$N" -lt 2 ] 2>/dev/null; then
  log "WARNING: Fewer than 2 historical runs found — cannot compute reliable z-score."
  log "         Extend the history window or compare against median manually."
  exit 2
fi

# ---------------------------------------------------------------------------
# Step 4: Z-score for the target request
# ---------------------------------------------------------------------------
log ""
log "--- Step 4: Z-score significance test (request_id=$REQUEST_ID) ---"

ZSCORE_ROW=$(sqlplus -s "$APPS_USER/$APPS_PASS@$ORACLE_SID" <<ENDSQL
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF VERIFY OFF TRIMOUT ON TRIMSPOOL ON NUMWIDTH 14
WITH history AS (
  SELECT
    ROUND((r.actual_completion_date - r.actual_start_date) * 24 * 60, 4) AS duration_min
  FROM fnd_conc_requests r
  WHERE r.concurrent_program_id  = $PROG_ID
    AND r.program_application_id = $PROG_APP_ID
    AND r.phase_code  = 'C'
    AND r.status_code = 'C'
    AND r.actual_start_date BETWEEN SYSDATE - 91 AND SYSDATE - 1
),
baseline AS (
  SELECT AVG(duration_min) AS mu, STDDEV(duration_min) AS sigma, COUNT(*) AS n
  FROM history
),
current_run AS (
  SELECT ROUND((actual_completion_date - actual_start_date) * 24 * 60, 2) AS current_min
  FROM fnd_conc_requests
  WHERE request_id = $REQUEST_ID
)
SELECT
  ROUND(c.current_min, 2) || '|' ||
  ROUND((c.current_min - b.mu) / NULLIF(b.sigma, 0), 3) || '|' ||
  CASE
    WHEN (c.current_min - b.mu) / NULLIF(b.sigma, 0) > 3.09 THEN 'p_lt_0.001_CRITICAL'
    WHEN (c.current_min - b.mu) / NULLIF(b.sigma, 0) > 2.58 THEN 'p_lt_0.01_SEVERE'
    WHEN (c.current_min - b.mu) / NULLIF(b.sigma, 0) > 1.96 THEN 'p_lt_0.05_SIGNIFICANT'
    WHEN (c.current_min - b.mu) / NULLIF(b.sigma, 0) > 1.645 THEN 'p_lt_0.10_MARGINAL'
    ELSE 'NOT_SIGNIFICANT'
  END
FROM current_run c, baseline b;
EXIT;
ENDSQL
)

ZSCORE_ROW=$(echo "$ZSCORE_ROW" | tr -d ' \r')

CURRENT_MIN=$(echo "$ZSCORE_ROW"  | cut -d'|' -f1)
Z_SCORE=$(echo "$ZSCORE_ROW"      | cut -d'|' -f2)
SIGNIFICANCE=$(echo "$ZSCORE_ROW" | cut -d'|' -f3)

log "  Current duration: $CURRENT_MIN minutes"
log "  Z-score         : $Z_SCORE"
log "  Significance    : $SIGNIFICANCE"

# ---------------------------------------------------------------------------
# Step 5: If significant — find AWR snapshot bracket
# ---------------------------------------------------------------------------
if echo "$SIGNIFICANCE" | grep -q "NOT_SIGNIFICANT"; then
  log ""
  log "RESULT: Regression NOT SIGNIFICANT. No AWR investigation required."
  log "        Document and close the ticket."
  echo "" | tee -a "$LOGFILE"
  echo "Log written to: $LOGFILE"
  exit 0
fi

log ""
log "RESULT: Regression is $SIGNIFICANCE — proceeding to AWR/ASH investigation."

log ""
log "--- Step 5: AWR snapshot window ---"

AWR_SNAPS=$(sqlplus -s "$APPS_USER/$APPS_PASS@$ORACLE_SID" <<ENDSQL
SET PAGESIZE 50 FEEDBACK OFF HEADING ON VERIFY OFF TRIMOUT ON TRIMSPOOL ON LINESIZE 120
COLUMN snap_id          FORMAT 99999999    HEADING 'SNAP_ID'
COLUMN instance_number  FORMAT 99          HEADING 'INST'
COLUMN begin_time       FORMAT A22         HEADING 'BEGIN_TIME'
COLUMN end_time         FORMAT A22         HEADING 'END_TIME'
SELECT
  s.snap_id,
  s.instance_number,
  TO_CHAR(s.begin_interval_time, 'YYYY-MM-DD HH24:MI:SS') AS begin_time,
  TO_CHAR(s.end_interval_time,   'YYYY-MM-DD HH24:MI:SS') AS end_time
FROM dba_hist_snapshot s
JOIN fnd_conc_requests r ON r.request_id = $REQUEST_ID
WHERE s.dbid = (SELECT dbid FROM v\$database)
  AND s.end_interval_time   >= r.actual_start_date      - INTERVAL '1' HOUR
  AND s.begin_interval_time <= NVL(r.actual_completion_date, SYSDATE) + INTERVAL '1' HOUR
ORDER BY s.snap_id;
EXIT;
ENDSQL
)

log "$AWR_SNAPS" | tee -a "$LOGFILE"

# ---------------------------------------------------------------------------
# Step 6: ASH wait event summary for the session
# ---------------------------------------------------------------------------
log ""
log "--- Step 6: ASH wait event summary (DBA_HIST_ACTIVE_SESS_HISTORY) ---"

ASH_SUMMARY=$(sqlplus -s "$APPS_USER/$APPS_PASS@$ORACLE_SID" <<ENDSQL
SET PAGESIZE 50 FEEDBACK OFF HEADING ON VERIFY OFF TRIMOUT ON TRIMSPOOL ON LINESIZE 140
COLUMN sql_id       FORMAT A14    HEADING 'SQL_ID'
COLUMN event        FORMAT A40    HEADING 'WAIT_EVENT'
COLUMN wait_class   FORMAT A15    HEADING 'WAIT_CLASS'
COLUMN ash_samples  FORMAT 999999 HEADING 'SAMPLES'
COLUMN pct_db_time  FORMAT 999.9  HEADING 'PCT_TIME'
COLUMN approx_sec   FORMAT 999999 HEADING 'APPROX_SEC'
SELECT
  ash.sql_id,
  NVL(ash.event, '(CPU / on CPU)') AS event,
  NVL(ash.wait_class, 'CPU')       AS wait_class,
  COUNT(*)                                                AS ash_samples,
  ROUND(COUNT(*) / SUM(COUNT(*)) OVER () * 100, 1)      AS pct_db_time,
  ROUND(COUNT(*) * 10, 0)                                AS approx_sec
FROM dba_hist_active_sess_history ash
JOIN fnd_conc_requests r ON r.oracle_session_id = ash.session_id
                        AND r.request_id         = $REQUEST_ID
WHERE ash.sample_time BETWEEN r.actual_start_date
                          AND NVL(r.actual_completion_date, SYSDATE)
GROUP BY ash.sql_id, ash.event, ash.wait_class
ORDER BY ash_samples DESC
FETCH FIRST 15 ROWS ONLY;
EXIT;
ENDSQL
)

log "$ASH_SUMMARY" | tee -a "$LOGFILE"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
log ""
log "=========================================="
log "INVESTIGATION SUMMARY"
log "=========================================="
log "  Program       : $PROGRAM_NAME"
log "  Request ID    : $REQUEST_ID"
log "  Duration      : $CURRENT_MIN minutes  (baseline mean: $MEAN min, stddev: $STDDEV min)"
log "  Z-score       : $Z_SCORE"
log "  Significance  : $SIGNIFICANCE"
log "  Next steps    : Review AWR snaps and ASH output above."
log "                  If plan change detected — pin fast plan with SQL Plan Baseline."
log "                  If I/O wait — gather stats on top tables, check index health."
log "                  If lock waits — identify blocking session from V\$SESSION."
log "Log file        : $LOGFILE"
log "=========================================="

exit 1
\`\`\`

---

## Phase 11: Troubleshooting

**\`oracle_session_id\` is NULL in FND_CONC_REQUESTS**

The request may have run through a PL/SQL wrapper rather than directly. Look for child requests:

\`\`\`sql
SELECT * FROM fnd_conc_requests WHERE parent_request_id = :request_id;
\`\`\`

**STDDEV returns NULL**

Only 1 distinct run in the history — cannot compute stddev; need at least 2 runs. Fall back to comparing against median from a longer window. Extend the BETWEEN clause to \`SYSDATE - 181\` or use the modified z-score (Phase 3b).

**AWR snapshot does not bracket the run**

AWR retention may be shorter than the run date. Check:

\`\`\`sql
SELECT * FROM dba_hist_wr_control;
\`\`\`

Increase retention with:

\`\`\`sql
BEGIN
  DBMS_WORKLOAD_REPOSITORY.MODIFY_SNAPSHOT_SETTINGS(
    retention => 43200,  -- 30 days in minutes
    interval  => 60      -- snapshot every 60 minutes
  );
END;
/
\`\`\`

**DBA_HIST_ACTIVE_SESS_HISTORY shows no rows for the session**

The session completed very quickly (< 10 seconds) and may have been missed by 10-second ASH sampling. For sub-10-second programs, use SQL Trace instead:

\`\`\`sql
EXEC DBMS_MONITOR.SESSION_TRACE_ENABLE(session_id => :sid, serial_num => :serial, waits => TRUE, binds => TRUE);
\`\`\`

Then run the program and retrieve the trace file from \`$ORACLE_BASE/diag/rdbms/$ORACLE_SID/$ORACLE_SID/trace/\`.

**EBS 11i on Oracle 9i**

AWR and ASH do not exist. Use \`V$SESSION_LONGOPS\` for in-progress monitoring and Statspack for historical SQL analysis. The z-score baseline query against \`fnd_conc_requests\` still works on 9i — only the AWR/ASH phases differ.

**ADDM task fails with ORA-13717**

ADDM requires the Diagnostic Pack license (included with Oracle Tuning Pack on Enterprise Edition). If not licensed, generate a manual AWR HTML report instead:

\`\`\`sql
SELECT * FROM TABLE(
  DBMS_WORKLOAD_REPOSITORY.AWR_REPORT_HTML(
    l_dbid       => (SELECT dbid FROM v$database),
    l_inst_num   => 1,
    l_bid        => :begin_snap,
    l_eid        => :end_snap
  )
);
\`\`\`

Spool the output to an HTML file and open in a browser.

---

## Quick Reference Table

| Step | Command / Query | Purpose |
|---|---|---|
| Find program ID | FND_CONCURRENT_PROGRAMS join | Locate prog_id for history query |
| Baseline stats | FND_CONC_REQUESTS + STDDEV/AVG | Build 90-day statistical baseline |
| Z-score | Formula query with CASE | Classify regression significance |
| Robust z-score | Median + MAD | High-variance programs (CV > 40%) |
| Argument check | FND_CONC_REQUESTS argument_text | Rule out legitimate scope changes |
| AWR bracket | DBA_HIST_SNAPSHOT join | Find begin_snap / end_snap |
| ASH activity | DBA_HIST_ACTIVE_SESS_HISTORY join | Top waits and SQL during run |
| Plan history | DBA_HIST_SQL_PLAN join | Detect plan change |
| ADDM | DBMS_ADDM.ANALYZE_DB | Automated bottleneck ranking |
| Trend | Weekly GROUP BY | Gradual vs sudden regression |
| Automation | cp_regression_check.sh | One-command triage with exit codes |`,
};

async function main() {
  console.log('Inserting EBS concurrent program regression statistics runbook...');
  await db.insert(posts).values(post);
  console.log('Inserted:', post.slug);
}

main().catch(console.error);
