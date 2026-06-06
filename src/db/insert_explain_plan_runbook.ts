import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Execution Plan Diagnosis, Tuning, and Stabilisation',
  slug: 'oracle-explain-plan-execution-runbook',
  excerpt:
    'A phased operational runbook for diagnosing Oracle execution plan problems from live cursor cache through AWR historical analysis, covering cardinality estimation errors, statistics quality, index usage, plan stability via SQL Plan Baselines, and emergency plan patching without application changes. Includes a production shell script that detects plan regressions and cardinality gaps on a cron schedule with email alerting.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-05'),
  youtubeUrl: null,
  content: `# Runbook: Oracle Execution Plan Diagnosis, Tuning, and Stabilisation

## Overview

This runbook provides a structured, phased approach to diagnosing Oracle execution plan problems and applying stable, production-safe resolutions. Work through the phases sequentially during an active incident, or use individual phases for targeted investigation. All queries are tested against Oracle 12.2 and later (19c recommended).

**Assumptions:**
- Oracle 12.2 or later
- DBA role required for V$ views and DBA_HIST views
- Diagnostics Pack licensed for AWR and ASH queries (\`DBA_HIST_*\` views)
- SYSDBA is not required for any phase in this runbook
- SQL Plan Management (SPM) requires no additional licensing in Enterprise Edition

**Variable placeholders used throughout:**
- \`&sql_id\` — the SQL_ID of the statement under investigation
- \`&child_number\` — child cursor number from V\$SQL
- \`&plan_hash_value\` — numeric plan hash from V\$SQL or DBA_HIST_SQLSTAT
- \`&schema_name\` — owner of the objects being examined
- \`&table_name\` — specific table name
- \`&column_name\` — specific column name

---

## Phase 0: Getting the Execution Plan

### Step 0.1: EXPLAIN PLAN for a Statement

Generates the estimated plan without executing the statement. Safe to run on any production system.

\`\`\`sql
EXPLAIN PLAN FOR
SELECT /* test */ e.employee_id, e.last_name, d.department_name
FROM employees e
JOIN departments d ON d.department_id = e.department_id
WHERE e.hire_date > date '2020-01-01';

SELECT * FROM TABLE(dbms_xplan.display(NULL, NULL, 'ALL'));
\`\`\`

**Note:** EXPLAIN PLAN shows estimated values only. Bind variable values are unknown; the optimizer uses default selectivity assumptions. Use this step to compare against the real plan from Step 0.3.

---

### Step 0.2: Find the SQL_ID for a Statement

Query V\$SQL to locate the SQL_ID and child cursor number for a statement currently in the shared pool.

\`\`\`sql
-- Find the SQL_ID
SELECT sql_id,
       child_number,
       executions,
       round(elapsed_time / 1e6, 2)        AS elapsed_sec,
       round(cpu_time / 1e6, 2)            AS cpu_sec,
       round(disk_reads / nullif(executions, 0), 0) AS disk_reads_per_exec,
       plan_hash_value,
       substr(sql_text, 1, 120)            AS sql_text
FROM v\$sql
WHERE sql_text LIKE '%your_search_term%'
  AND sql_text NOT LIKE '%v\$sql%'
ORDER BY elapsed_time DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

---

### Step 0.3: Display Real Plan with Actual Row Counts (ALLSTATS LAST)

This is the primary diagnostic query. The ALLSTATS LAST format shows E-Rows (estimated) and A-Rows (actual) side by side for each plan step, revealing cardinality estimation errors.

\`\`\`sql
SELECT * FROM TABLE(
  dbms_xplan.display_cursor(
    sql_id          => '&sql_id',
    cursor_child_no => &child_number,
    format          => 'ALLSTATS LAST +PEEKED_BINDS'
  )
);
\`\`\`

**What to look for:**
- Steps where A-Rows diverges from E-Rows by more than 10×
- Filter predicates on TABLE ACCESS steps (rows fetched and discarded)
- PEEKED_BINDS section showing bind values used at parse time

---

### Step 0.4: Display Plan from AWR (Statement No Longer in Shared Pool)

Use this when the slow execution already completed and the cursor has been aged out of the shared pool.

\`\`\`sql
SELECT * FROM TABLE(
  dbms_xplan.display_awr(
    sql_id          => '&sql_id',
    plan_hash_value => &plan_hash_value,
    db_id           => NULL,
    format          => 'ALL'
  )
);
\`\`\`

---

### Step 0.5: List All Known Plans for a SQL_ID (Detect Plan Regressions)

Compare performance across all plan_hash_values ever used for a given SQL_ID. A plan regression appears as a new plan_hash_value with significantly higher avg_ms.

\`\`\`sql
SELECT sql_id,
       plan_hash_value,
       min(snap_id)                                                         AS first_seen,
       max(snap_id)                                                         AS last_seen,
       round(sum(elapsed_time_delta) / nullif(sum(executions_delta), 0) / 1e3, 2) AS avg_ms,
       sum(executions_delta)                                                AS execs
FROM dba_hist_sqlstat
WHERE sql_id = '&sql_id'
  AND executions_delta > 0
GROUP BY sql_id, plan_hash_value
ORDER BY min(snap_id);
\`\`\`

If two plan_hash_values appear for the same SQL_ID, compare the avg_ms values. The regressed plan will have the higher value. Use Step 0.4 to retrieve and compare both plans.

---

## Phase 1: Reading the Plan — Key Columns and Red Flags

### Step 1.1: Measure the E-Rows vs A-Rows Cardinality Gap

Quantify cardinality estimation errors for each plan step. A ratio > 10 at any step is the root cause of most plan problems.

\`\`\`sql
SELECT id,
       operation,
       options,
       object_name,
       cardinality                                              AS e_rows,
       last_output_rows                                        AS a_rows,
       round(last_output_rows / nullif(cardinality, 0), 2)    AS ratio,
       round(last_elapsed_time / 1e6, 4)                      AS step_sec
FROM v\$sql_plan_statistics_all
WHERE sql_id      = '&sql_id'
  AND child_number = &child_number
ORDER BY id;
\`\`\`

**Interpretation:**
- ratio < 0.1: CBO massively overestimated — may have chosen Hash Join when Nested Loops was optimal
- ratio > 10: CBO massively underestimated — may have chosen Nested Loops when Hash Join was needed
- Identify the lowest-level step (smallest id) with the largest ratio — that is the root estimation error; all ratios above it are compounded effects

---

### Step 1.2: Identify Filter vs Access Predicates

Filter predicates on TABLE ACCESS steps mean rows are being fetched and then discarded — a strong signal that a better index exists or the existing index needs to include additional columns.

\`\`\`sql
SELECT id,
       operation,
       options,
       object_name,
       access_predicates,
       filter_predicates
FROM v\$sql_plan
WHERE sql_id      = '&sql_id'
  AND child_number = &child_number
  AND (access_predicates IS NOT NULL OR filter_predicates IS NOT NULL)
ORDER BY id;
\`\`\`

**Red flags:**
- \`TABLE ACCESS FULL\` with \`filter_predicates\` IS NOT NULL: selective predicate with no supporting index
- \`TABLE ACCESS BY INDEX ROWID\` with \`filter_predicates\` IS NOT NULL: index does not cover all predicate columns; rows fetched and discarded
- \`FILTER\` operation with a high ratio in Step 1.1: subquery or OR predicate evaluated as a filter rather than accessed via join

---

## Phase 2: Statistics Quality Check

### Step 2.1: Check Table and Index Statistics Age

Identify tables with stale or missing statistics. Sort by last_analyzed ascending to find the most neglected tables first.

\`\`\`sql
SELECT owner,
       table_name,
       num_rows,
       blocks,
       last_analyzed,
       round((sysdate - last_analyzed), 1) AS days_old,
       stale_stats
FROM dba_tab_statistics
WHERE owner = upper('&schema_name')
ORDER BY last_analyzed ASC NULLS FIRST
FETCH FIRST 30 ROWS ONLY;
\`\`\`

---

### Step 2.2: Check Column Histograms for Key Predicate Columns

For columns appearing in WHERE clause predicates of the slow query, verify histogram quality. A column with high skew and no histogram will receive default selectivity estimates.

\`\`\`sql
SELECT column_name,
       histogram,
       num_distinct,
       num_nulls,
       density,
       last_analyzed
FROM dba_tab_col_statistics
WHERE owner      = upper('&schema_name')
  AND table_name = upper('&table_name')
ORDER BY column_name;
\`\`\`

**Interpretation:**
- \`NONE\`: no histogram; optimizer uses \`density = 1/num_distinct\` for all values (correct only if data is uniform)
- \`FREQUENCY\` or \`TOP-FREQUENCY\`: full histogram for low-NDV columns — most accurate for skewed data
- \`HEIGHT BALANCED\`: sampling-based histogram for high-NDV columns
- If \`density > 1/num_distinct\` for a column with high \`num_distinct\`, the column has skew that warrants a histogram

---

### Step 2.3: Gather Fresh Statistics on a Specific Table

Refresh statistics with automatic histogram decisions (SIZE AUTO lets Oracle decide which columns need histograms based on workload monitoring data).

\`\`\`sql
EXEC dbms_stats.gather_table_stats(
  ownname     => '&schema_name',
  tabname     => '&table_name',
  cascade     => TRUE,
  method_opt  => 'FOR ALL COLUMNS SIZE AUTO',
  degree      => 4,
  no_invalidate => FALSE
);
\`\`\`

Set \`no_invalidate => FALSE\` to force immediate cursor invalidation so the new statistics take effect on the next execution rather than waiting for the next shared pool flush cycle.

---

### Step 2.4: Gather Histogram for a Specific Skewed Column

When a specific column has a known skewed distribution and needs a histogram immediately, target it directly without re-sampling all columns.

\`\`\`sql
EXEC dbms_stats.gather_table_stats(
  ownname    => '&schema_name',
  tabname    => '&table_name',
  method_opt => 'FOR COLUMNS &column_name SIZE 254',
  no_invalidate => FALSE
);
\`\`\`

SIZE 254 creates a frequency histogram with up to 254 buckets — appropriate for columns with fewer than 254 distinct values. For high-NDV columns, use SIZE AUTO.

---

### Step 2.5: Check for Stale Statistics Across a Schema

Identify all tables in a schema that Oracle has flagged as stale (more than 10% of rows changed since last statistics gather).

\`\`\`sql
SELECT owner,
       table_name,
       stale_stats,
       last_analyzed
FROM dba_tab_statistics
WHERE owner      = upper('&schema_name')
  AND stale_stats = 'YES'
ORDER BY table_name;
\`\`\`

---

## Phase 3: Index Usage Analysis

### Step 3.1: Check Index Statistics and Clustering Factor

The clustering_factor is the most important index statistic after num_rows. It estimates the number of table block reads needed to retrieve all rows through the index in key order. A high clustering_factor (close to num_rows) means table rows are randomly distributed relative to the index key — range scans through this index will require many random I/Os.

\`\`\`sql
SELECT i.index_name,
       i.index_type,
       i.uniqueness,
       i.num_rows,
       i.distinct_keys,
       i.clustering_factor,
       i.last_analyzed,
       round(i.clustering_factor / nullif(t.num_rows, 0), 4) AS cf_ratio
FROM dba_indexes i
JOIN dba_tables t
  ON t.owner      = i.table_owner
  AND t.table_name = i.table_name
WHERE i.table_owner = upper('&schema_name')
  AND i.table_name  = upper('&table_name')
ORDER BY i.index_name;
\`\`\`

**Interpretation:**
- cf_ratio near 0: index key order closely matches physical row order — very efficient for range scans
- cf_ratio near 1.0: completely random order — index range scans require one table block read per row; the optimizer may correctly prefer a full table scan

---

### Step 3.2: Check Whether an Index Is Actually Being Used (12c+)

Enable monitoring on an index, then query V\$OBJECT_USAGE after a representative workload period (at least one business day or one full batch cycle).

\`\`\`sql
-- Enable monitoring if not already on:
-- ALTER INDEX &index_name MONITORING USAGE;

SELECT index_name,
       table_name,
       monitoring,
       used,
       start_monitoring,
       end_monitoring
FROM v\$object_usage
WHERE table_name = upper('&table_name');
\`\`\`

---

### Step 3.3: Find Indexes Never Used (Candidates for Dropping)

Indexes that are monitored but never used are candidates for removal. Dropping unused indexes eliminates their maintenance overhead on DML operations.

\`\`\`sql
SELECT u.index_name,
       u.table_name,
       i.index_type,
       i.num_rows
FROM v\$object_usage u
JOIN dba_indexes i
  ON i.index_name = u.index_name
  AND i.owner     = upper('&schema_name')
WHERE u.used      = 'NO'
  AND u.monitoring = 'YES'
ORDER BY i.num_rows DESC;
\`\`\`

**Caution:** Before dropping, verify the index is not used as a constraint enforcement mechanism (UNIQUE or PRIMARY KEY indexes) and is not referenced by any SQL Plan Baseline.

---

### Step 3.4: Identify Missing Indexes — High-Cost Filter Predicates from V\$SQL_PLAN

Find TABLE ACCESS FULL operations with filter predicates that are executed frequently — the strongest signal that a missing index is causing repeated full table scans.

\`\`\`sql
SELECT p.sql_id,
       p.object_owner,
       p.object_name,
       p.filter_predicates,
       s.executions,
       round(s.elapsed_time / 1e6, 2)                   AS elapsed_sec,
       round(s.disk_reads / nullif(s.executions, 0), 0) AS disk_reads_per_exec
FROM v\$sql_plan p
JOIN v\$sql s
  ON s.sql_id        = p.sql_id
  AND s.child_number = p.child_number
WHERE p.operation        = 'TABLE ACCESS'
  AND p.options          = 'FULL'
  AND p.filter_predicates IS NOT NULL
  AND s.executions       > 10
ORDER BY s.elapsed_time DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

---

## Phase 4: Plan Stability — SQL Plan Baselines

### Step 4.1: Check Existing Baselines for a SQL_ID

Before creating a new baseline, check whether one already exists. The \`fixed\` column indicates whether the baseline is locked to a specific plan regardless of optimizer evolution.

\`\`\`sql
SELECT sql_handle,
       plan_name,
       sql_text,
       enabled,
       accepted,
       fixed,
       origin,
       created,
       last_modified
FROM dba_sql_plan_baselines
WHERE sql_text LIKE '%&search_term%'
ORDER BY created DESC;
\`\`\`

---

### Step 4.2: Load a Good Plan from Cursor Cache into a Baseline

Use this when a SQL statement is currently using a good plan that you want to preserve against future regressions. The plan from the cursor cache is loaded as an accepted baseline plan.

\`\`\`sql
DECLARE
  l_plans INTEGER;
BEGIN
  l_plans := dbms_spm.load_plans_from_cursor_cache(
    sql_id          => '&sql_id',
    plan_hash_value => &plan_hash_value
  );
  dbms_output.put_line('Plans loaded: ' || l_plans);
END;
/
\`\`\`

A return value of 0 means the SQL_ID was not found in the cursor cache or the plan_hash_value did not match. Verify the SQL_ID and CHILD_NUMBER using Step 0.2 first.

---

### Step 4.3: Evolve (Accept) a New Plan into an Existing Baseline

When Oracle generates a new plan for a SQL statement that has a baseline, and you want to consider adopting the new plan, use SPM Evolve. The \`verify => 'YES'\` option runs the new plan in a controlled test to confirm it performs at least as well as the current baseline before accepting it.

\`\`\`sql
DECLARE
  l_report CLOB;
BEGIN
  l_report := dbms_spm.evolve_sql_plan_baseline(
    sql_handle  => '&sql_handle',
    plan_name   => '&plan_name',
    verify      => 'YES',
    commit      => 'YES'
  );
  dbms_output.put_line(l_report);
END;
/
\`\`\`

---

### Step 4.4: Drop a Bad Baseline Plan

Remove a baseline plan that represents a known bad execution path, forcing the optimizer to use remaining accepted plans.

\`\`\`sql
DECLARE
  l_dropped INTEGER;
BEGIN
  l_dropped := dbms_spm.drop_sql_plan_baseline(
    sql_handle => '&sql_handle',
    plan_name  => '&plan_name'
  );
  dbms_output.put_line('Plans dropped: ' || l_dropped);
END;
/
\`\`\`

---

## Phase 5: Emergency Plan Fix — SQL Patch (Hint Injection)

Use SQL Patches when a plan regression has occurred in production, the application source cannot be changed, and there is no time to evolve a baseline. A SQL Patch injects optimizer hints as if they were written directly into the SQL text.

### Step 5.1: Create a SQL Patch to Inject a Hint

The sql_text parameter must exactly match the SQL text as it appears in V\$SQL (whitespace, case, and all characters must match precisely).

\`\`\`sql
EXEC dbms_sqldiag.create_sql_patch(
  sql_text  => 'SELECT /* original SQL text exactly as it appears in V\$SQL */ ...',
  hint_text => 'INDEX(e IDX_EMPLOYEES_HIRE_DATE)',
  name      => 'PATCH_EMPLOYEES_HIREDATE'
);
\`\`\`

**Common hint_text values:**
- \`INDEX(alias index_name)\` — force a specific index
- \`NO_INDEX(alias index_name)\` — prevent use of a specific index
- \`USE_NL(alias)\` — force Nested Loops for a join
- \`USE_HASH(alias)\` — force Hash Join for a join
- \`LEADING(alias1 alias2)\` — force join order
- \`FULL(alias)\` — force full table scan

---

### Step 5.2: List Active SQL Patches

\`\`\`sql
SELECT name,
       created,
       status,
       hint_text,
       substr(sql_text, 1, 100) AS sql_text
FROM dba_sql_patches
ORDER BY created DESC;
\`\`\`

---

### Step 5.3: Drop a SQL Patch

Once the root cause is fixed (statistics refreshed, index created, baseline loaded), remove the patch to allow the optimizer to run freely again.

\`\`\`sql
EXEC dbms_sqldiag.drop_sql_patch(name => 'PATCH_EMPLOYEES_HIREDATE');
\`\`\`

---

## Phase 6: Adaptive Plans and Cursor Sharing Diagnostics

### Step 6.1: Check If a Cursor Is Using an Adaptive Plan

\`\`\`sql
SELECT sql_id,
       child_number,
       is_resolved_adaptive_plan,
       is_shareable
FROM v\$sql
WHERE sql_id = '&sql_id';
\`\`\`

If \`is_resolved_adaptive_plan = 'Y'\`, the adaptive plan mechanism triggered during execution and the final plan may differ from the compile-time default plan.

---

### Step 6.2: Identify Cursors with Many Child Cursors (Bind Sensitivity / ACS)

A SQL_ID with many child cursors is a signal of Adaptive Cursor Sharing activity or cursor unsharability. Each child cursor represents a different execution plan optimized for a different bind value distribution.

\`\`\`sql
SELECT sql_id,
       count(*)                     AS child_count,
       sum(executions)              AS total_execs,
       max(substr(sql_text, 1, 80)) AS sql_text
FROM v\$sql
GROUP BY sql_id
HAVING count(*) > 5
ORDER BY count(*) DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

---

### Step 6.3: Check Why a Cursor Is Not Shared

V\$SQL_SHARED_CURSOR records the reason each child cursor was created rather than sharing an existing cursor. Each column in the view represents a specific reason; a value of 'Y' means that reason caused a new child cursor to be created.

\`\`\`sql
SELECT sql_id,
       child_number,
       reason
FROM v\$sql_shared_cursor
WHERE sql_id = '&sql_id'
ORDER BY child_number;
\`\`\`

**Common non-sharing reasons:**
- \`BIND_EQUIV_FAILURE\`: ACS determined bind values warrant a different plan
- \`OPTIMIZER_MISMATCH\`: different optimizer parameters between sessions
- \`AUTH_CHECK_MISMATCH\`: different schema visibility or role grants
- \`ROW_LEVEL_SEC_MISMATCH\`: VPD policies differ between sessions

---

## Phase 7: Execution Plan Monitoring Shell Script

Save as \`/u01/app/oracle/scripts/plan_monitor/plan_regression_check.sh\`.

\`\`\`bash
#!/bin/bash
# plan_regression_check.sh
# Detects Oracle execution plan regressions and cardinality gaps.
# Usage: plan_regression_check.sh <ORACLE_SID>
# Exit code: number of regressions found (0 = clean)

set -euo pipefail

ORACLE_SID=\${1:?Usage: plan_regression_check.sh ORACLE_SID}
export ORACLE_SID
export ORAENV_ASK=NO
# shellcheck source=/dev/null
. /usr/local/bin/oraenv

SCRIPT_DIR="/u01/app/oracle/scripts/plan_monitor"
LOG_DIR="\${SCRIPT_DIR}/logs"
LOG_FILE="\${LOG_DIR}/plan_check_\$(date +%Y%m%d_%H%M%S).log"
ALERT_EMAIL="dba-alerts@example.com"
REGRESSION_THRESHOLD=2       # flag if new plan is > 2x slower than old plan
CARDINALITY_THRESHOLD=100     # flag if A-Rows / E-Rows > 100
LOOKBACK_DAYS=7               # compare against plan_hash_value seen N days ago

mkdir -p "\${LOG_DIR}"

log() {
  local msg="\$1"
  echo "\$(date '+%Y-%m-%d %H:%M:%S') [\${ORACLE_SID}] \${msg}" | tee -a "\${LOG_FILE}"
}

REGRESSION_COUNT=0
ISSUES=""

log "Starting plan regression check for SID=\${ORACLE_SID}"

# --------------------------------------------------------------------------
# Section 1: Plan regression detection via DBA_HIST_SQLSTAT
# Find SQL_IDs where the plan_hash_value changed in the last 24 hours
# and the new plan is > REGRESSION_THRESHOLD times slower.
# --------------------------------------------------------------------------
log "Checking for plan regressions in DBA_HIST_SQLSTAT (lookback: \${LOOKBACK_DAYS} days)..."

REGRESSION_OUTPUT=\$(sqlplus -s / as sysdba <<'SQLEOF'
SET PAGESIZE 0
SET FEEDBACK OFF
SET HEADING OFF
SET LINESIZE 200
SET TRIMOUT ON
SET TRIMSPOOL ON

WITH plan_history AS (
  SELECT sql_id,
         plan_hash_value,
         MIN(snap_id) AS first_snap,
         MAX(snap_id) AS last_snap,
         ROUND(
           SUM(elapsed_time_delta) / NULLIF(SUM(executions_delta), 0) / 1e3,
           2
         ) AS avg_ms,
         SUM(executions_delta) AS total_execs
  FROM dba_hist_sqlstat
  WHERE executions_delta > 0
    AND snap_id >= (
      SELECT MIN(snap_id)
      FROM dba_hist_snapshot
      WHERE begin_interval_time >= SYSDATE - 8
    )
  GROUP BY sql_id, plan_hash_value
),
recent_plans AS (
  SELECT sql_id,
         plan_hash_value AS new_phv,
         avg_ms          AS new_ms,
         total_execs     AS new_execs
  FROM plan_history
  WHERE last_snap = (SELECT MAX(snap_id) FROM dba_hist_snapshot WHERE begin_interval_time >= SYSDATE - 1)
),
old_plans AS (
  SELECT sql_id,
         plan_hash_value AS old_phv,
         avg_ms          AS old_ms
  FROM plan_history
  WHERE last_snap <= (
    SELECT MAX(snap_id)
    FROM dba_hist_snapshot
    WHERE begin_interval_time BETWEEN SYSDATE - 8 AND SYSDATE - 7
  )
)
SELECT r.sql_id,
       r.new_phv,
       o.old_phv,
       o.old_ms,
       r.new_ms,
       ROUND(r.new_ms / NULLIF(o.old_ms, 0), 2) AS regression_ratio,
       r.new_execs
FROM recent_plans r
JOIN old_plans o
  ON o.sql_id = r.sql_id
WHERE r.new_phv <> o.old_phv
  AND r.new_ms > 0
  AND o.old_ms > 0
  AND r.new_ms / NULLIF(o.old_ms, 0) > 2
ORDER BY regression_ratio DESC
FETCH FIRST 10 ROWS ONLY;

EXIT;
SQLEOF
)

if [[ -n "\${REGRESSION_OUTPUT}" ]]; then
  while IFS= read -r line; do
    [[ -z "\${line}" ]] && continue
    SQL_ID=\$(echo "\${line}" | awk '{print \$1}')
    NEW_PHV=\$(echo "\${line}" | awk '{print \$2}')
    OLD_PHV=\$(echo "\${line}" | awk '{print \$3}')
    OLD_MS=\$(echo "\${line}" | awk '{print \$4}')
    NEW_MS=\$(echo "\${line}" | awk '{print \$5}')
    RATIO=\$(echo "\${line}" | awk '{print \$6}')
    EXECS=\$(echo "\${line}" | awk '{print \$7}')
    log "REGRESSION DETECTED: sql_id=\${SQL_ID} old_phv=\${OLD_PHV} (\${OLD_MS}ms) -> new_phv=\${NEW_PHV} (\${NEW_MS}ms) ratio=\${RATIO}x execs=\${EXECS}"
    ISSUES+="\nREGRESSION: sql_id=\${SQL_ID} | old_phv=\${OLD_PHV} (\${OLD_MS}ms) -> new_phv=\${NEW_PHV} (\${NEW_MS}ms) | ratio=\${RATIO}x | execs_since_change=\${EXECS}"
    REGRESSION_COUNT=\$((REGRESSION_COUNT + 1))
  done <<< "\${REGRESSION_OUTPUT}"
else
  log "No plan regressions detected."
fi

# --------------------------------------------------------------------------
# Section 2: Cardinality gap check from V$SQL_PLAN_STATISTICS_ALL
# Find top 5 plan steps with worst E-Rows vs A-Rows ratio (> THRESHOLD)
# --------------------------------------------------------------------------
log "Checking for cardinality estimation gaps > \${CARDINALITY_THRESHOLD}x ..."

CARDINALITY_OUTPUT=\$(sqlplus -s / as sysdba <<'SQLEOF'
SET PAGESIZE 0
SET FEEDBACK OFF
SET HEADING OFF
SET LINESIZE 200
SET TRIMOUT ON
SET TRIMSPOOL ON

SELECT sql_id,
       child_number,
       id             AS plan_step_id,
       operation,
       object_name,
       cardinality    AS e_rows,
       last_output_rows AS a_rows,
       ROUND(last_output_rows / NULLIF(cardinality, 0), 0) AS ratio
FROM v\$sql_plan_statistics_all
WHERE cardinality      > 0
  AND last_output_rows > 0
  AND last_output_rows / NULLIF(cardinality, 0) > 100
  AND last_starts      > 0
ORDER BY last_output_rows / NULLIF(cardinality, 0) DESC
FETCH FIRST 5 ROWS ONLY;

EXIT;
SQLEOF
)

if [[ -n "\${CARDINALITY_OUTPUT}" ]]; then
  log "WARNING: High cardinality estimation gaps found:"
  while IFS= read -r line; do
    [[ -z "\${line}" ]] && continue
    SQL_ID=\$(echo "\${line}" | awk '{print \$1}')
    CHILD=\$(echo "\${line}" | awk '{print \$2}')
    STEP=\$(echo "\${line}" | awk '{print \$3}')
    OP=\$(echo "\${line}" | awk '{print \$4}')
    OBJ=\$(echo "\${line}" | awk '{print \$5}')
    EROWS=\$(echo "\${line}" | awk '{print \$6}')
    AROWS=\$(echo "\${line}" | awk '{print \$7}')
    RATIO=\$(echo "\${line}" | awk '{print \$8}')
    log "  CARDINALITY GAP: sql_id=\${SQL_ID} child=\${CHILD} step=\${STEP} op=\${OP} obj=\${OBJ} e_rows=\${EROWS} a_rows=\${AROWS} ratio=\${RATIO}x"
    ISSUES+="\nCARDINALITY GAP: sql_id=\${SQL_ID} step=\${STEP} (\${OP} \${OBJ}) e_rows=\${EROWS} a_rows=\${AROWS} ratio=\${RATIO}x"
  done <<< "\${CARDINALITY_OUTPUT}"
else
  log "No high cardinality gaps found."
fi

# --------------------------------------------------------------------------
# Section 3: Send alert email if issues were found
# --------------------------------------------------------------------------
if [[ -n "\${ISSUES}" ]]; then
  log "Sending alert email to \${ALERT_EMAIL}..."
  SUBJECT="[ORACLE PLAN ALERT] \${ORACLE_SID}: \${REGRESSION_COUNT} regression(s) detected \$(date '+%Y-%m-%d %H:%M')"
  BODY="Oracle Execution Plan Monitor Report
SID: \${ORACLE_SID}
Host: \$(hostname)
Time: \$(date '+%Y-%m-%d %H:%M:%S')
Regression threshold: \${REGRESSION_THRESHOLD}x
Cardinality gap threshold: \${CARDINALITY_THRESHOLD}x

Issues found:
\$(echo -e "\${ISSUES}")

Log file: \${LOG_FILE}

Action required:
1. Run DBMS_XPLAN.DISPLAY_CURSOR with 'ALLSTATS LAST' for each flagged SQL_ID
2. Compare E-Rows vs A-Rows to identify cardinality estimation errors
3. Gather fresh statistics on involved tables if statistics are stale
4. Load a SQL Plan Baseline if a known-good plan exists in the cursor cache
5. Apply a SQL Patch via DBMS_SQLDIAG if immediate plan control is needed
"
  echo "\${BODY}" | mailx -s "\${SUBJECT}" "\${ALERT_EMAIL}" 2>/dev/null || \
    sendmail "\${ALERT_EMAIL}" <<MAILEOF
Subject: \${SUBJECT}
To: \${ALERT_EMAIL}

\${BODY}
MAILEOF
  log "Alert sent."
fi

log "Plan regression check complete. Regressions found: \${REGRESSION_COUNT}"

# Exit code = number of regressions found (0 = clean)
exit \${REGRESSION_COUNT}
\`\`\`

**Crontab entry** — runs at 15 minutes past every hour (allowing the AWR snapshot at the top of the hour to complete before querying DBA_HIST_SQLSTAT):

\`\`\`
15  *  *  *  *  /u01/app/oracle/scripts/plan_monitor/plan_regression_check.sh PRODDB >> /u01/app/oracle/scripts/plan_monitor/logs/cron_plan.log 2>&1
\`\`\`

Install the crontab entry:

\`\`\`bash
crontab -e
# Add the line above, then save and exit
crontab -l  # verify
\`\`\`

---

## Quick Reference

### Key V$ Views
| View | Purpose |
|---|---|
| \`V\$SQL\` | Current SQL statements in shared pool with aggregate statistics |
| \`V\$SQL_PLAN\` | Execution plans for cursors in shared pool |
| \`V\$SQL_PLAN_STATISTICS_ALL\` | Per-step actual row counts and timing (requires STATISTICS_LEVEL=ALL or SQL hint) |
| \`V\$SQL_SHARED_CURSOR\` | Reasons why a new child cursor was created instead of sharing |
| \`V\$OBJECT_USAGE\` | Index usage monitoring data |

### Key AWR Views (Diagnostics Pack Required)
| View | Purpose |
|---|---|
| \`DBA_HIST_SQLSTAT\` | Historical SQL aggregate stats per AWR snapshot |
| \`DBA_HIST_SQL_PLAN\` | Historical execution plans from AWR |
| \`DBA_HIST_SQLTEXT\` | Full SQL text for historical SQL_IDs |

### Statistics and Index Views
| View | Purpose |
|---|---|
| \`DBA_TAB_STATISTICS\` | Table-level statistics including stale_stats flag |
| \`DBA_TAB_COL_STATISTICS\` | Column-level statistics and histogram type |
| \`DBA_INDEXES\` | Index statistics including clustering_factor |

### Plan Stability Views
| View | Purpose |
|---|---|
| \`DBA_SQL_PLAN_BASELINES\` | All SQL Plan Management baselines |
| \`DBA_SQL_PATCHES\` | All active SQL Patches |

### Key Packages
| Package | Purpose |
|---|---|
| \`DBMS_XPLAN\` | Format and display execution plans |
| \`DBMS_SPM\` | SQL Plan Management: load, evolve, drop baselines |
| \`DBMS_STATS\` | Gather and manage optimizer statistics |
| \`DBMS_SQLDIAG\` | Create and drop SQL Patches |

### DBMS_XPLAN Format Options
| Format String | Shows |
|---|---|
| \`'ALLSTATS LAST'\` | Actual rows, memory, time per step for last execution |
| \`'+PEEKED_BINDS'\` | Bind variable values used at parse time |
| \`'ALL'\` | All plan columns including predicates and notes |
| \`'ADAPTIVE'\` | Adaptive plan decision points and alternative subplans |
| \`'BASIC'\` | Operation and object name only — minimal output |
`,
};

async function main() {
  console.log('Inserting Oracle Execution Plan Runbook post...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: { ...post },
  });
  console.log('Inserted: "' + post.title + '"');
}

main().catch(console.error);
