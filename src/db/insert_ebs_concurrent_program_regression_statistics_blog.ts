import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Detecting EBS Concurrent Program Performance Regression: Z-Scores, P-Values, and AWR/ASH/ADDM Investigation',
  slug: 'ebs-concurrent-program-regression-z-score-pvalue-awr-ash-addm',
  excerpt:
    'When an EBS concurrent program runs slower than usual, the question is whether the slowdown is statistically significant or just normal variation. By computing a z-score against 90 days of historical run data from FND_CONC_REQUESTS and applying hypothesis testing, you can objectively determine whether the current run is a genuine regression. Once confirmed, AWR snapshots bracket the run window, ASH shows exactly what the session was waiting on, and ADDM identifies the root cause. This post covers the full statistical triage and AWR/ASH/ADDM investigation workflow.',
  category: 'performance-dw' as const,
  isPremium: false,
  published: true,
  publishedAt: new Date('2026-07-20T12:00:00.000Z'),
  youtubeUrl: null,
  content: `## Introduction

The typical response to "concurrent program X is running slow" is to open ASH and start looking at wait events. But before spending an hour tracing wait events, there is a prior question: is this run actually slow compared to history, or is it within the normal range of variation? A program that usually takes 45–60 minutes is not slow at 62 minutes. A program that usually takes 12 minutes is critically slow at 62 minutes. Statistical methods answer this question objectively and decide whether escalation is warranted.

Z-score analysis against 90 days of FND_CONC_REQUESTS history gives you an objective regression verdict in under a minute, before you open a single AWR report. When z-score confirms a genuine regression, AWR, ASH, and ADDM provide the drill-down path to the specific SQL or wait event responsible. This workflow prevents two failure modes: escalating normal variation as an incident, and dismissing a genuine regression because it does not feel dramatic enough.

---

## The Data Source: FND_CONC_REQUESTS

\`FND_CONC_REQUESTS\` (and its synonym \`FND_CONCURRENT_REQUESTS\`) is the EBS operational table tracking every concurrent program execution. It is the only source of ground truth for concurrent program timing in EBS — Oracle AWR does not natively attribute elapsed time to a specific concurrent request.

Key columns used in statistical triage:

- \`concurrent_program_id\` — join to \`FND_CONCURRENT_PROGRAMS\` on \`CONCURRENT_PROGRAM_NAME\` (the developer short name) to look up the program
- \`request_id\` — unique run identifier; this is also stamped as the \`ACTION\` column in \`V$SESSION\` and \`DBA_HIST_ACTIVE_SESS_HISTORY\`
- \`actual_start_date\`, \`actual_completion_date\` — wall-clock duration; the difference (in fractional days) multiplied by 1440 gives minutes
- \`phase_code = 'C'\` (Completed), \`status_code = 'C'\` (Normal completion — not error, not warning, not terminated)
- \`oracle_session_id\` — the Oracle SID that executed the request; this is the critical join key for ASH
- \`argument_text\` — parameters passed to this run; useful for detecting whether the data volume changed between the current run and the baseline

The baseline query pulls 90 days of successfully completed runs for the target program by its developer short name:

\`\`\`sql
SELECT
  r.request_id,
  r.actual_start_date,
  r.actual_completion_date,
  ROUND((r.actual_completion_date - r.actual_start_date) * 24 * 60, 2) AS duration_min,
  r.argument_text
FROM fnd_conc_requests r
JOIN fnd_concurrent_programs p
  ON p.concurrent_program_id = r.concurrent_program_id
  AND p.application_id       = r.program_application_id
WHERE p.concurrent_program_name = 'XXCUSTOM_PROGRAM'
  AND r.phase_code    = 'C'
  AND r.status_code   = 'C'
  AND r.actual_start_date >= SYSDATE - 90
ORDER BY r.actual_start_date DESC;
\`\`\`

**EBS 11i version note.** On very old EBS 11i instances running Oracle 9i, \`PERCENTILE_CONT\` is not available — it was introduced in Oracle 10g. Use a manual NTILE or rank-based percentile calculation instead. The history and z-score queries using only \`AVG\`, \`STDDEV\`, \`MIN\`, and \`MAX\` work on all versions back to Oracle 8i.

---

## Building the Statistical Baseline

Before computing any z-score, characterize the historical distribution. The baseline query returns mean, standard deviation, coefficient of variation, min, max, median, and 95th percentile in a single pass:

\`\`\`sql
WITH history AS (
  SELECT
    ROUND((r.actual_completion_date - r.actual_start_date) * 24 * 60, 4) AS duration_min
  FROM fnd_conc_requests r
  JOIN fnd_concurrent_programs p
    ON p.concurrent_program_id = r.concurrent_program_id
   AND p.application_id        = r.program_application_id
  WHERE p.concurrent_program_name = 'XXCUSTOM_PROGRAM'
    AND r.phase_code    = 'C'
    AND r.status_code   = 'C'
    AND r.actual_start_date BETWEEN SYSDATE - 91 AND SYSDATE - 1
)
SELECT
  COUNT(*)                                                        AS n,
  ROUND(AVG(duration_min), 2)                                     AS mean_min,
  ROUND(STDDEV(duration_min), 2)                                  AS stddev_min,
  ROUND(STDDEV(duration_min) / AVG(duration_min) * 100, 1)       AS cv_pct,
  ROUND(MIN(duration_min), 2)                                     AS min_min,
  ROUND(MAX(duration_min), 2)                                     AS max_min,
  ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY duration_min), 2) AS median_min,
  ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_min), 2) AS p95_min
FROM history;
\`\`\`

The window is \`SYSDATE - 91 AND SYSDATE - 1\` rather than \`SYSDATE - 90\` — the upper bound excludes the current day so that a very slow run earlier today does not inflate the baseline mean and suppress the z-score for itself.

**Coefficient of variation (CV = stddev / mean × 100).** This single number tells you how reliable the standard z-score will be. Programs with CV below 15% are stable — their duration is highly predictable, the normal distribution assumption is reasonable, and a z-score above 2 reliably indicates a regression. Programs with CV between 15% and 40% have moderate variance, often driven by day-of-week or month-end data volume differences. Programs with CV above 40% have high natural variability — often driven by variable-volume interfaces or reports whose parameters change each run. For these, the standard z-score is less reliable and the modified z-score described later in this post should be used instead.

**Minimum sample size.** The Central Limit Theorem requires n ≥ 30 for the z-score and normal distribution p-values to be reliable. If the program has fewer than 30 completed runs in 90 days (it runs infrequently), use the t-distribution with (n − 1) degrees of freedom instead of the normal distribution. The t-distribution has heavier tails — a given z-like statistic maps to a larger p-value, reflecting the greater uncertainty from the small sample. Below n = 10, statistical testing is not reliable; rely on the p95 boundary instead (is the current run above the historical 95th percentile?).

---

## Computing the Z-Score for the Current Run

The z-score quantifies how many standard deviations the current run duration lies above the historical mean:

> z = (x − μ) / σ

Where x is the current run duration in minutes, μ is the historical mean, and σ is the historical standard deviation. A positive z-score means the run took longer than the mean; a negative z-score means it ran faster.

The following query computes the z-score and maps it to a significance classification in a single statement. Replace \`123456789\` with the actual REQUEST_ID:

\`\`\`sql
WITH history AS (
  SELECT
    ROUND((r.actual_completion_date - r.actual_start_date) * 24 * 60, 4) AS duration_min
  FROM fnd_conc_requests r
  JOIN fnd_concurrent_programs p
    ON p.concurrent_program_id = r.concurrent_program_id
   AND p.application_id        = r.program_application_id
  WHERE p.concurrent_program_name = 'XXCUSTOM_PROGRAM'
    AND r.phase_code    = 'C'
    AND r.status_code   = 'C'
    AND r.actual_start_date BETWEEN SYSDATE - 91 AND SYSDATE - 1
),
baseline AS (
  SELECT
    COUNT(*)             AS n,
    AVG(duration_min)    AS mu,
    STDDEV(duration_min) AS sigma
  FROM history
),
current_run AS (
  SELECT
    r.request_id,
    ROUND((r.actual_completion_date - r.actual_start_date) * 24 * 60, 2) AS current_min
  FROM fnd_conc_requests r
  WHERE r.request_id = 123456789
)
SELECT
  c.request_id,
  c.current_min                                                    AS current_minutes,
  ROUND(b.mu, 2)                                                   AS historical_mean,
  ROUND(b.sigma, 2)                                                AS historical_stddev,
  b.n                                                              AS sample_size,
  ROUND((c.current_min - b.mu) / NULLIF(b.sigma, 0), 3)           AS z_score,
  CASE
    WHEN (c.current_min - b.mu) / NULLIF(b.sigma, 0) > 3.09
      THEN 'p < 0.001  CRITICAL REGRESSION'
    WHEN (c.current_min - b.mu) / NULLIF(b.sigma, 0) > 2.58
      THEN 'p < 0.01   SEVERE REGRESSION'
    WHEN (c.current_min - b.mu) / NULLIF(b.sigma, 0) > 1.96
      THEN 'p < 0.05   SIGNIFICANT REGRESSION'
    WHEN (c.current_min - b.mu) / NULLIF(b.sigma, 0) > 1.645
      THEN 'p < 0.10   MARGINAL REGRESSION'
    WHEN (c.current_min - b.mu) / NULLIF(b.sigma, 0) < -1.96
      THEN 'p < 0.05   SIGNIFICANTLY FASTER'
    ELSE
      'NOT SIGNIFICANT -- Normal variation'
  END                                                              AS significance
FROM current_run c, baseline b;
\`\`\`

The \`NULLIF(b.sigma, 0)\` guard prevents a divide-by-zero error if the program always runs in exactly the same number of minutes (sigma = 0), which can happen for very short PL/SQL programs. In that case the current run duration either equals the historical mean (not significant) or does not — the z-score is undefined but the raw duration comparison is sufficient.

---

## P-Value Interpretation Table

The z-score thresholds below correspond to one-tailed p-values under the standard normal distribution. One-tailed is appropriate here because you are testing a directional hypothesis: "is this run slower than history?" A two-tailed test (detecting either faster or slower than expected) uses the same z-score boundaries but applies them to the absolute value of z.

| Z-Score | P-Value | Interpretation |
|---------|---------|----------------|
| < 1.645 | > 0.10 | Normal variation — no action needed |
| 1.645–1.96 | 0.05–0.10 | Marginal — monitor, check argument changes |
| 1.96–2.58 | 0.01–0.05 | Significant regression — investigate with AWR/ASH |
| 2.58–3.09 | 0.001–0.01 | Severe regression — escalate immediately |
| > 3.09 | < 0.001 | Critical regression — incident-level response |

A p-value of 0.05 means there is a 5% probability that a run this slow (or slower) would occur by chance alone if the program's performance had not changed. A p-value of 0.001 means there is a 0.1% chance — a run this slow happens by chance roughly once in every 1,000 normal runs. At z > 3.09, the probability of a false alarm is so low that investigation is always warranted regardless of other context.

The action thresholds are guidelines, not hard rules. For a month-end payroll program that must complete by 2 AM, a marginal z-score of 1.7 at 11 PM warrants investigation immediately regardless of the p-value. For a low-priority report that has no downstream dependencies, a significant z-score of 2.1 may be triaged during business hours.

---

## Robust Z-Score for High-Variance Programs

The standard z-score uses the mean and standard deviation, both of which are sensitive to outliers in the baseline. If a program ran for 3× its normal duration on three occasions in the past 90 days (perhaps during database maintenance windows), those outliers inflate σ and suppress the z-score for the current run — making a genuine regression appear statistically insignificant.

For programs with CV > 40%, use the modified z-score (Iglewicz and Hoaglin, 1993) based on the median and median absolute deviation (MAD):

> M = 0.6745 × (x − median) / MAD

Where MAD = median(|x_i − median|). The constant 0.6745 is the 75th percentile of the standard normal distribution, which scales the MAD to be consistent with the standard deviation when the data is normally distributed. Values of |M| above 3.5 are classified as outliers by Iglewicz and Hoaglin.

\`\`\`sql
WITH history AS (
  SELECT
    ROUND((r.actual_completion_date - r.actual_start_date) * 24 * 60, 4) AS duration_min
  FROM fnd_conc_requests r
  JOIN fnd_concurrent_programs p
    ON p.concurrent_program_id = r.concurrent_program_id
   AND p.application_id        = r.program_application_id
  WHERE p.concurrent_program_name = 'XXCUSTOM_PROGRAM'
    AND r.phase_code = 'C' AND r.status_code = 'C'
    AND r.actual_start_date BETWEEN SYSDATE - 91 AND SYSDATE - 1
),
med AS (
  SELECT PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY duration_min) AS median_val
  FROM history
),
mad_calc AS (
  SELECT PERCENTILE_CONT(0.50) WITHIN GROUP (
    ORDER BY ABS(h.duration_min - m.median_val)
  ) AS mad_val
  FROM history h, med m
),
current_run AS (
  SELECT ROUND((actual_completion_date - actual_start_date) * 24 * 60, 2) AS current_min
  FROM fnd_conc_requests WHERE request_id = 123456789
)
SELECT
  ROUND(c.current_min, 2)                                          AS current_minutes,
  ROUND(m.median_val, 2)                                           AS historical_median,
  ROUND(mad.mad_val, 2)                                            AS mad,
  ROUND(0.6745 * (c.current_min - m.median_val) / NULLIF(mad.mad_val, 0), 3) AS modified_z_score,
  CASE
    WHEN 0.6745 * (c.current_min - m.median_val) / NULLIF(mad.mad_val, 0) > 3.5
      THEN 'OUTLIER -- Statistically extreme'
    WHEN 0.6745 * (c.current_min - m.median_val) / NULLIF(mad.mad_val, 0) > 2.5
      THEN 'SUSPICIOUS -- Warrants investigation'
    ELSE 'Within expected range'
  END AS classification
FROM current_run c, med m, mad_calc mad;
\`\`\`

The modified z-score is more robust than the standard z-score for skewed or heavy-tailed distributions, which are common for concurrent programs whose duration depends on the volume of data processed in a given run.

---

## Historical Trend: Is the Program Getting Gradually Slower?

A single z-score shows the current run against the full 90-day baseline but does not distinguish between two very different scenarios: a sudden regression that happened on this specific run, and a gradual performance degradation that has been accumulating over weeks. The z-score will be high in both cases if the baseline was set before the degradation began — but the remediation is entirely different.

A weekly trend query reveals whether the program has been creeping slower over the past 90 days:

\`\`\`sql
SELECT
  TRUNC(r.actual_start_date, 'IW')                                 AS week_start,
  COUNT(*)                                                          AS runs,
  ROUND(AVG((r.actual_completion_date - r.actual_start_date) * 24 * 60), 1) AS avg_min,
  ROUND(MIN((r.actual_completion_date - r.actual_start_date) * 24 * 60), 1) AS min_min,
  ROUND(MAX((r.actual_completion_date - r.actual_start_date) * 24 * 60), 1) AS max_min
FROM fnd_conc_requests r
JOIN fnd_concurrent_programs p
  ON p.concurrent_program_id = r.concurrent_program_id
 AND p.application_id        = r.program_application_id
WHERE p.concurrent_program_name = 'XXCUSTOM_PROGRAM'
  AND r.phase_code = 'C' AND r.status_code = 'C'
  AND r.actual_start_date >= SYSDATE - 90
GROUP BY TRUNC(r.actual_start_date, 'IW')
ORDER BY week_start;
\`\`\`

\`TRUNC(date, 'IW')\` truncates to the start of the ISO week (Monday). Read the output from top to bottom. If avg_min is relatively flat for the first ten weeks and then jumps sharply in the most recent two weeks, this is an acute regression — something changed recently. If avg_min increases by a few percent each week across the full 90-day window, this is a data growth or index degradation problem — not an acute event but a persistent trend. A steady upward trend in avg_min over weeks points to table data growth (without corresponding statistics refresh), index fragmentation (right-edge inserts), or accumulating undo / temporary tablespace pressure.

---

## Step 2: Locating the AWR Snapshot Window

Once the z-score confirms a significant regression, the AWR snapshot window is the key to drill-down. You need the \`begin_snap_id\` and \`end_snap_id\` that bracket the concurrent request's execution. The join is straightforward — use the request's \`actual_start_date\` and \`actual_completion_date\` to find enclosing snapshots, with a 1-hour buffer on each side to catch the first and last snapshots that overlap the run:

\`\`\`sql
SELECT
  s.snap_id,
  TO_CHAR(s.begin_interval_time, 'YYYY-MM-DD HH24:MI') AS begin_time,
  TO_CHAR(s.end_interval_time,   'YYYY-MM-DD HH24:MI') AS end_time,
  s.instance_number
FROM dba_hist_snapshot s
JOIN fnd_conc_requests r ON r.request_id = 123456789
WHERE s.dbid = (SELECT dbid FROM v\$database)
  AND s.end_interval_time   >= r.actual_start_date - 1/24
  AND s.begin_interval_time <= NVL(r.actual_completion_date, SYSDATE) + 1/24
ORDER BY s.snap_id;
\`\`\`

This returns the set of snap_ids covering the request. The lowest snap_id is your \`begin_snap_id\`; the highest is your \`end_snap_id\`. These two values are the input to \`DBMS_WORKLOAD_REPOSITORY.AWR_SQL_REPORT_HTML\` for detailed SQL analysis and to \`DBMS_ADDM.ANALYZE_DB\` for automated bottleneck detection.

On a RAC cluster (which is common for EBS 12.1 and 12.2 deployments), note the \`instance_number\` in the result. AWR snapshots are per-instance in RAC. The concurrent program ran on a specific RAC node — identified by the \`oracle_session_id\` in FND_CONC_REQUESTS and crosswalked through \`V\$SESSION\` or \`GV\$SESSION\` to the instance number. Make sure your ADDM analysis targets the correct instance.

---

## Step 3: ASH — What Was the Session Doing?

The \`oracle_session_id\` column in FND_CONC_REQUESTS is the SID of the Oracle session that ran the request. This is the direct join key to ASH — no additional lookups are required.

**For a run that just completed or is in-flight (V$ACTIVE_SESSION_HISTORY, last hour):**

\`\`\`sql
SELECT
  ash.sql_id,
  ash.event,
  ash.wait_class,
  sql.sql_text,
  COUNT(*)                                                          AS sample_count,
  ROUND(COUNT(*) / SUM(COUNT(*)) OVER () * 100, 1)                AS pct_time,
  ROUND(COUNT(*) * 10, 0)                                          AS approx_seconds
FROM v\$active_session_history ash
JOIN fnd_conc_requests r       ON r.oracle_session_id = ash.session_id
LEFT JOIN v\$sqlarea sql        ON sql.sql_id = ash.sql_id
WHERE r.request_id = 123456789
  AND ash.sample_time BETWEEN r.actual_start_date
                           AND NVL(r.actual_completion_date, SYSDATE)
GROUP BY ash.sql_id, ash.event, ash.wait_class, sql.sql_text
ORDER BY sample_count DESC
FETCH FIRST 15 ROWS ONLY;
\`\`\`

**For a completed run older than one hour (DBA_HIST_ACTIVE_SESS_HISTORY):**

\`\`\`sql
SELECT
  ash.sql_id,
  ash.event,
  ash.wait_class,
  SUBSTR(sq.sql_text, 1, 80)                                        AS sql_text_snippet,
  COUNT(*)                                                           AS sample_count,
  ROUND(COUNT(*) / SUM(COUNT(*)) OVER () * 100, 1)                 AS pct_time,
  ROUND(COUNT(*) * 10, 0)                                           AS approx_seconds
FROM dba_hist_active_sess_history ash
JOIN fnd_conc_requests r      ON r.oracle_session_id = ash.session_id
                             AND r.request_id         = 123456789
LEFT JOIN dba_hist_sqltext sq ON sq.sql_id = ash.sql_id
                             AND sq.dbid   = ash.dbid
WHERE ash.sample_time BETWEEN r.actual_start_date
                          AND r.actual_completion_date
GROUP BY ash.sql_id, ash.event, ash.wait_class, SUBSTR(sq.sql_text, 1, 80)
ORDER BY sample_count DESC
FETCH FIRST 15 ROWS ONLY;
\`\`\`

**Reading the ASH output.** The sample_count column tells you how many 10-second ASH samples were taken while the session was active on each SQL_ID / event combination. Multiply by 10 to get the approximate number of seconds spent there. The pct_time column shows the proportion of total active time. Focus on the top one or two rows — in a genuine regression, a single SQL_ID or event typically dominates.

Common patterns and their meaning:

- **High \`db file sequential read\` on a single SQL_ID.** The session is doing single-block reads — an index scan — but spending a lot of time in I/O. The index exists, but either the index is bloated (right-edge fragmentation from inserts), the optimizer chose the wrong index, or the buffer cache does not have the relevant index blocks warm. Get the SQL_ID and check its execution plan.
- **High \`db file scattered read\`.** Full table scan. The optimizer chose a full scan, which may be correct for large data volumes but is a regression symptom if it was previously using an index. Check whether optimizer statistics are stale on the table.
- **High \`log file sync\`.** The concurrent program is committing frequently — a row-by-row commit pattern inside a PL/SQL loop. Each commit flushes the redo log buffer to disk. This is an application-level pattern that cannot be fixed at the database tier without changing the PL/SQL code.
- **High \`enq: TX - row lock contention\`.** The session was blocked by another session holding a row lock during the run. This is concurrency contention, not a performance regression in the program itself. Identify the blocking session from \`V\$SESSION\` (using BLOCKING_SESSION) or from the ASH BLOCKING_SESSION column.
- **High CPU (event = NULL, wait_class = 'CPU').** The session spent its time on CPU rather than waiting. This can mean excessive parsing (large number of distinct SQL statements being hard-parsed), a PL/SQL loop executing millions of iterations, or a sort or hash join consuming CPU on a large intermediate result set.

---

## Step 4: ADDM — Automated Findings for the Snapshot Window

ADDM analyzes the AWR snapshot range and ranks bottlenecks by their estimated contribution to total DB time during that window. It operates on the same data sources as AWR but performs automated root-cause attribution rather than requiring you to interpret raw metrics.

Create an ADDM task against the snapshot window identified in Step 2:

\`\`\`sql
-- Create a new ADDM task for the request's snapshot window
DECLARE
  l_task_id   NUMBER;
  l_task_name VARCHAR2(100) := 'ADDM_CP_123456789';
BEGIN
  DBMS_ADDM.ANALYZE_DB(
    task_name   => l_task_name,
    begin_snap  => 12045,
    end_snap    => 12047,
    db_id       => (SELECT dbid FROM v\$database)
  );
  DBMS_OUTPUT.PUT_LINE('Task created: ' || l_task_name);
END;
/

-- Query the findings
SELECT
  f.type,
  f.message,
  ROUND(f.benefit, 0) AS benefit_pct
FROM dba_advisor_tasks t
JOIN dba_advisor_findings f ON f.task_id = t.task_id
WHERE t.task_name   = 'ADDM_CP_123456789'
  AND t.advisor_name = 'ADDM'
ORDER BY f.benefit DESC;
\`\`\`

The \`benefit\` column is ADDM's estimate of the percentage of DB time that would be recovered if the finding were fully addressed. Sort descending by benefit and focus on the top findings.

**ADDM findings to act on for concurrent program regressions:**

- **SQL statements consuming significant database time.** ADDM names the specific SQL_IDs responsible for the most DB time during the snapshot window. Get each SQL_ID and check its execution plan in \`DBA_HIST_SQL_PLAN\` compared to what was used in previous snapshot windows. A plan change — indicated by a different \`PLAN_HASH_VALUE\` for the same SQL_ID — is the most common cause of sudden performance regression in EBS concurrent programs.
- **Hard parse rate high.** The number of hard parses per second during this window was elevated. This can happen after an application patch that changes SQL text, after a cursor sharing parameter change, or after \`CURSOR_SHARING\` is set differently. Hard parsing is CPU-intensive and serializes on library cache latches.
- **I/O throughput.** ADDM reports the read and write I/O rates during the snapshot window. If I/O was significantly higher than during baseline snapshot windows for the same program, the session was reading or writing more data — consistent with either a data volume increase or a plan change from an index path to a full scan.
- **Wait events: buffer busy waits or buffer deadlock.** Hot block contention, commonly seen when a concurrent program performs heavy INSERT activity into an index with a monotonically increasing key (such as a sequence-generated primary key). Multiple sessions competing to insert into the rightmost index block cause buffer busy waits. This is an index storage design issue.

---

## Step 5: Checking for an Execution Plan Change

If ASH shows a single SQL_ID dominating the concurrent program's run time, the most important next step is determining whether its execution plan changed between the current regression and historical normal runs. A plan change is the most common cause of sudden EBS concurrent program regression — it can happen because of an optimizer statistics refresh, a parameter change, an application patch that added or removed a hint, or an index being rebuilt or dropped.

Query the historical plans for the SQL_ID across AWR snapshots:

\`\`\`sql
-- Plans used historically
SELECT DISTINCT
  p.sql_id,
  p.plan_hash_value,
  s.executions,
  ROUND(s.elapsed_time / 1e6 / NULLIF(s.executions, 0), 2) AS avg_elapsed_sec,
  s.begin_interval_time
FROM dba_hist_sql_plan p
JOIN dba_hist_sqlstat s  ON s.sql_id         = p.sql_id
                        AND s.plan_hash_value = p.plan_hash_value
                        AND s.dbid            = p.dbid
JOIN dba_hist_snapshot sn ON sn.snap_id      = s.snap_id
                         AND sn.dbid          = s.dbid
WHERE p.sql_id = 'abc123defg456'
ORDER BY sn.begin_interval_time DESC;
\`\`\`

If this query returns multiple distinct \`plan_hash_value\` rows for the same \`sql_id\`, a plan change occurred. Compare the \`avg_elapsed_sec\` between the old and new plan hash values — the regression is proportional to the elapsed time increase.

Display the full plan text for comparison using \`DBMS_XPLAN.DISPLAY_AWR\`. Pass the SQL_ID and the specific plan hash value you want to examine:

\`\`\`sql
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_AWR('abc123defg456', 987654321, NULL, 'ALL'));
\`\`\`

Run this once for the plan hash value from before the regression and once for the hash value from during the regression. Look for:

- A switch from index range scan to full table scan on a large table
- An additional merge join or hash join step on an intermediate result set
- A changed join order that puts a larger driving table first
- A nested loops replaced by a hash join that spills to temporary tablespace

If a plan change is confirmed, the immediate remediation options are SQL Plan Baselines (\`DBMS_SPM.LOAD_PLANS_FROM_AWR\` to load the historical good plan as a fixed baseline) or SQL Profiles via the SQL Tuning Advisor. Both lock the optimizer into the known-good plan without changing application code.

---

## EBS Version Notes

The queries in this post are compatible with EBS 12.1, 12.2, and most EBS 11i environments running Oracle 10g or later. Version-specific notes:

- **EBS 11i on Oracle 9i.** AWR does not exist — AWR was introduced in Oracle Database 10g. Use Statspack instead: \`STATS\$SQL_SUMMARY\` replaces \`DBA_HIST_SQLSTAT\`, \`STATS\$SNAPSHOT\` replaces \`DBA_HIST_SNAPSHOT\`. The FND_CONC_REQUESTS baseline and z-score queries are identical. ADDM is also not available; use the Statspack report (\`SPREPORT.SQL\`) for the equivalent workload summary. \`PERCENTILE_CONT\` is not available on Oracle 9i — replace the percentile calculations with rank-based equivalents using \`NTILE\` or explicit rank/count arithmetic.
- **EBS 11i on Oracle 10g or later.** Full AWR and ASH support. The \`oracle_session_id\` column exists in FND_CONC_REQUESTS and can be used for the ASH join directly.
- **EBS 12.1.3.** AWR, ASH, and ADDM fully supported. Concurrent managers frequently run on a RAC cluster — verify that the \`instance_number\` in \`DBA_HIST_SNAPSHOT\` matches the RAC node where the concurrent program actually ran. The \`oracle_session_id\` in a RAC environment is the local SID on the instance that ran the request, not a globally unique identifier.
- **EBS 12.2.x.** Same as 12.1 for the database tier. Note that the Online Patching mechanism (adop) can cause concurrent program slowdowns during the cutover phase — when adop switches the file system editions, concurrent managers are briefly stopped and restarted, which can produce anomalously short or long runs. Filter the statistical baseline to exclude dates during active adop patch cycles by cross-referencing the adop phase log or by excluding dates where the \`PHASE_CODE\` history shows abnormal gaps in program scheduling.

---

## Building a Decision Tree

This workflow reduces the regression investigation to a structured sequence of decisions. Each step either closes the investigation or narrows to the next step:

**1. Pull z-score for the specific request_id against the 90-day baseline.**
   - Result: NOT SIGNIFICANT → document the actual and historical mean, close the investigation. The run was within normal variation.
   - Result: z ≥ 1.645 → continue to step 2.

**2. Check argument_text — did the data volume change?**
   - Compare the current run's \`argument_text\` to the same column in recent historical runs. Parameters like date ranges, organization IDs, or batch size values often explain duration increases. If the arguments changed (e.g., a quarterly run was submitted instead of a monthly run), the z-score is expected and no performance regression exists.
   - If arguments are the same → continue to step 3.

**3. Pull ASH for the session (oracle_session_id) during the request window.**
   - If ASH shows one SQL_ID dominating → continue to step 5 (plan change check).
   - If ASH shows wait events dominating (not CPU, not a single SQL_ID) → continue to step 4.

**4. Pull ADDM findings for the AWR snapshot window enclosing the request.**
   - ADDM finds SQL consuming DB time → continue to step 5.
   - ADDM finds I/O throughput degradation → investigate storage and I/O subsystem changes during the window (ASM rebalance, storage maintenance, concurrent I/O from other workloads).
   - ADDM finds parse rate high → investigate cursor sharing and library cache contention; look for recent parameter changes or application patches.
   - ADDM finds buffer busy waits → investigate hot block contention; look for right-edge index inserts or missing reverse-key index.

**5. Check for execution plan change using DBA_HIST_SQL_PLAN.**
   - Single plan hash value across all AWR snapshots → no plan change; investigate bind variable peeking or statistics freshness on the involved tables.
   - Multiple plan hash values, new one correlated with regression start date → plan change confirmed. Load the historical good plan as an SPM baseline and escalate to the application team for a permanent fix.

---

## Summary

Z-score triage prevents two forms of wasted effort: opening a full AWR investigation for a run that is simply at the upper end of its normal variation, and dismissing a genuine regression because it does not feel dramatically slow in absolute terms. Running the baseline and z-score query against FND_CONC_REQUESTS takes under a minute and provides an objective, statistically grounded verdict before any diagnostic tool is opened. When z-score confirms a regression, the AWR snapshot window bridges the EBS request record to the Oracle performance data tier, and ASH provides a direct attribution of the session's wait time to specific SQL_IDs or event categories. For high-variance programs where the standard z-score is unreliable because of outliers in the baseline, the modified z-score based on the median and MAD gives a more robust outlier classification that is not distorted by the occasional abnormal historical run. Together, these four tools — FND_CONC_REQUESTS statistics, AWR snapshots, ASH session profiling, and ADDM automated findings — form a complete, repeatable workflow for diagnosing EBS concurrent program performance regressions from first report to root cause.`,
};

async function main() {
  console.log('Inserting EBS concurrent program regression statistics blog post...');
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
  console.log('Inserted:', JSON.stringify(post.slug));
}

main().catch(console.error);
