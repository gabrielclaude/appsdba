import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Scanning for Low-Cardinality Index Contention and Self-Join Anti-Patterns',
  slug: 'oracle-low-cardinality-self-join-scan-runbook',
  excerpt:
    'A phased diagnostic and remediation runbook for Oracle DBAs covering the complete workflow for detecting and fixing low-cardinality index contention and explosive self-join anti-patterns: AWR/ASH symptom identification, low-cardinality index scanning, skewed distribution detection, self-join pattern detection in SQL cache and AWR, PGA spill measurement, targeted histogram gathering, index rebuild with INITRANS/PCTFREE, composite index creation and validation, query rewrite comparison, and a fully automated PL/SQL scanner procedure with DBMS_SCHEDULER integration.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-06'),
  youtubeUrl: null,
  content: `This runbook provides a complete diagnostic and remediation workflow for two related Oracle SQL performance anti-patterns: low-cardinality index contention and explosive self-join queries. All code is SQL/PL/SQL. Execute phases in order; validate at each step before proceeding.

**Assumptions:**
- Oracle Database 12.2 or later
- AWR license (Diagnostic Pack) for DBA_HIST_* views
- DBA role or equivalent for V\$ and DBA_* access
- Working schema: \`INVENTORY_OWN\` (substitute your schema throughout)
- Reference table: \`STAGE_INVENTORY_ITEMS\` (substitute your table throughout)

---

## Phase 0: Spot the Symptoms in AWR and ASH

### Step 0.1: Find buffer busy waits and db file sequential read together in AWR

The co-occurrence of these two events is the signature of index contention on a hot low-cardinality index. Neither event alone is definitive — it is the combination, during the same interval, that points to this root cause.

\`\`\`sql
-- Top wait events from recent AWR snapshots
-- Look for buffer busy waits and db file sequential read both in the top 5
SELECT s.begin_interval_time,
       s.end_interval_time,
       e.event_name,
       ROUND(e.total_waits_fg / ((EXTRACT(HOUR FROM (s.end_interval_time - s.begin_interval_time)) * 3600
             + EXTRACT(MINUTE FROM (s.end_interval_time - s.begin_interval_time)) * 60
             + EXTRACT(SECOND FROM (s.end_interval_time - s.begin_interval_time))), 0)) AS waits_per_sec,
       ROUND(e.time_waited_fg_micro / 1e6) AS total_wait_sec,
       ROUND(e.time_waited_fg_micro / NULLIF(e.total_waits_fg, 0) / 1000, 2) AS avg_wait_ms
FROM dba_hist_system_event e
JOIN dba_hist_snapshot s
  ON e.snap_id = s.snap_id AND e.dbid = s.dbid
WHERE s.begin_interval_time > SYSDATE - 1
  AND e.event_name IN (
        'buffer busy waits',
        'db file sequential read',
        'read by other session',
        'direct path read temp',
        'direct path write temp'
      )
  AND e.wait_class != 'Idle'
ORDER BY s.snap_id DESC, e.time_waited_fg_micro DESC;
\`\`\`

### Step 0.2: Correlate wait events to specific SQL_IDs using ASH

\`\`\`sql
-- ASH correlation: which SQL_IDs are responsible for the elevated waits
SELECT ash.sql_id,
       ash.event,
       COUNT(*) AS ash_samples,
       ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (PARTITION BY ash.event), 1) AS pct_of_event,
       MAX(ash.sql_plan_hash_value) AS plan_hash
FROM dba_hist_active_sess_history ash
WHERE ash.sample_time > SYSDATE - 2/24
  AND ash.event IN ('buffer busy waits', 'db file sequential read')
  AND ash.sql_id IS NOT NULL
GROUP BY ash.sql_id, ash.event
ORDER BY ash.event, ash_samples DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

### Step 0.3: Query V\$SQL for high buffer_gets per execution (index contention smell)

\`\`\`sql
-- High average logical I/O per execution is a strong indicator of
-- either a missing index (full scan) or index contention (many index entries scanned)
SELECT sql_id,
       plan_hash_value,
       executions,
       ROUND(buffer_gets / NULLIF(executions, 0)) AS avg_lio_per_exec,
       ROUND(elapsed_time / NULLIF(executions, 0) / 1e6, 2) AS avg_elapsed_sec,
       ROUND(rows_processed / NULLIF(executions, 0)) AS avg_rows_per_exec,
       SUBSTR(sql_text, 1, 120) AS sql_preview
FROM v\$sql
WHERE executions > 0
  AND buffer_gets / NULLIF(executions, 0) > 100000
  AND parsing_schema_name NOT IN ('SYS', 'SYSTEM', 'DBSNMP', 'SYSMAN')
ORDER BY avg_lio_per_exec DESC
FETCH FIRST 30 ROWS ONLY;
\`\`\`

### Step 0.4: Identify PGA spill candidates from V\$SQL_WORKAREA

\`\`\`sql
-- SQL statements whose workareas have estimated optimal size much larger
-- than the actual memory they received — these are candidates for temp spill
SELECT sql_id,
       operation_type,
       policy,
       ROUND(estimated_optimal_size / 1048576) AS optimal_mb,
       ROUND(onepass_size / 1048576) AS onepass_mb,
       active_time / 1000 AS active_ms,
       multipasses AS multipass_executions
FROM v\$sql_workarea
WHERE sql_id IN (
    SELECT sql_id FROM v\$sql
    WHERE parsing_schema_name NOT IN ('SYS', 'SYSTEM', 'DBSNMP')
)
  AND estimated_optimal_size > 10 * 1048576  -- flag workareas needing > 10MB optimal
ORDER BY estimated_optimal_size DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

---

## Phase 1: Identify Low-Cardinality Indexes

### Step 1.1: Comprehensive low-cardinality index scanner

This query identifies all indexes where the leading column has low NDV relative to table size, and labels each by risk level. Run as DBA.

\`\`\`sql
-- Low-cardinality index scanner
-- HIGH_RISK:   selectivity > 10% (index retrieves > 10% of table on average)
-- MEDIUM_RISK: selectivity 1-10%
-- LOW_RISK:    selectivity < 1% (generally fine, but watch for data skew)
SELECT
    i.owner,
    i.table_name,
    i.index_name,
    ic.column_name,
    ic.column_position,
    cs.num_distinct,
    t.num_rows,
    ROUND(cs.num_distinct / NULLIF(t.num_rows, 0) * 100, 4) AS selectivity_pct,
    cs.histogram,
    cs.num_buckets,
    cs.last_analyzed,
    CASE
        WHEN cs.num_distinct / NULLIF(t.num_rows, 0) > 0.10 THEN 'HIGH_RISK'
        WHEN cs.num_distinct / NULLIF(t.num_rows, 0) > 0.01 THEN 'MEDIUM_RISK'
        ELSE 'LOW_RISK'
    END AS risk_label,
    CASE
        WHEN cs.histogram = 'NONE' AND cs.num_distinct < 50 THEN 'NO_HISTOGRAM_LOW_NDV'
        WHEN cs.histogram != 'NONE' THEN 'HISTOGRAM_EXISTS'
        ELSE 'OK'
    END AS histogram_status
FROM dba_indexes i
JOIN dba_ind_columns ic
  ON ic.index_owner = i.owner
  AND ic.index_name = i.index_name
  AND ic.column_position = 1  -- leading column only
JOIN dba_tab_col_statistics cs
  ON cs.owner = i.owner
  AND cs.table_name = i.table_name
  AND cs.column_name = ic.column_name
JOIN dba_tab_statistics t
  ON t.owner = i.owner
  AND t.table_name = i.table_name
  AND t.partition_name IS NULL
WHERE i.owner NOT IN ('SYS', 'SYSTEM', 'DBSNMP', 'SYSMAN', 'WMSYS', 'XDB',
                       'OUTLN', 'APEX_050000', 'ORDDATA', 'CTXSYS', 'MDSYS')
  AND cs.num_distinct < 50         -- configurable: leading column NDV threshold
  AND t.num_rows > 100000          -- configurable: minimum table size
  AND i.status = 'VALID'
  AND i.visibility = 'VISIBLE'
ORDER BY
    CASE WHEN cs.num_distinct / NULLIF(t.num_rows, 0) > 0.10 THEN 1
         WHEN cs.num_distinct / NULLIF(t.num_rows, 0) > 0.01 THEN 2
         ELSE 3 END,
    t.num_rows DESC NULLS LAST;
\`\`\`

---

## Phase 2: Detect Skewed Column Distributions

### Step 2.1: Show actual value distribution for a low-cardinality column

\`\`\`sql
-- Value distribution from histogram buckets
-- Requires a histogram to have been gathered previously
SELECT h.endpoint_actual_value AS column_value,
       h.endpoint_repeat_count AS row_count,
       ROUND(h.endpoint_repeat_count / t.num_rows * 100, 2) AS pct_of_table,
       CASE
           WHEN h.endpoint_repeat_count / t.num_rows > 0.20 THEN 'DOMINANT_VALUE'
           WHEN h.endpoint_repeat_count / t.num_rows > 0.05 THEN 'FREQUENT_VALUE'
           ELSE 'RARE_VALUE'
       END AS value_class
FROM dba_tab_histograms h
JOIN dba_tab_statistics t
  ON t.owner = h.owner AND t.table_name = h.table_name AND t.partition_name IS NULL
WHERE h.owner = 'INVENTORY_OWN'
  AND h.table_name = 'STAGE_INVENTORY_ITEMS'
  AND h.column_name = 'PROCESSING_STATUS'
ORDER BY h.endpoint_repeat_count DESC;
\`\`\`

### Step 2.2: Identify columns with no histogram on low-NDV columns

\`\`\`sql
-- Columns with low NDV and no histogram — blind spots for the optimizer
SELECT c.owner,
       c.table_name,
       c.column_name,
       c.num_distinct,
       c.density,
       ROUND(c.density * t.num_rows) AS optimizer_rows_per_value_estimate,
       c.histogram,
       c.last_analyzed
FROM dba_tab_col_statistics c
JOIN dba_tab_statistics t
  ON t.owner = c.owner
  AND t.table_name = c.table_name
  AND t.partition_name IS NULL
WHERE c.owner NOT IN ('SYS', 'SYSTEM', 'DBSNMP', 'SYSMAN', 'WMSYS', 'XDB')
  AND c.histogram = 'NONE'
  AND c.num_distinct BETWEEN 2 AND 50
  AND t.num_rows > 100000
  AND c.num_nulls < t.num_rows  -- ignore columns that are almost entirely null
ORDER BY t.num_rows DESC NULLS LAST, c.num_distinct
FETCH FIRST 50 ROWS ONLY;
\`\`\`

### Step 2.3: Compare optimizer estimate to actual distribution (skew detection)

\`\`\`sql
-- Identify where the optimizer's selectivity estimate is likely wrong
-- by comparing estimated rows per value vs actual histogram bucket counts
SELECT c.column_name,
       c.num_distinct,
       c.density,
       ROUND(c.density * t.num_rows) AS estimated_rows_per_value,
       h_min.min_actual_rows,
       h_max.max_actual_rows,
       CASE
           WHEN h_max.max_actual_rows > c.density * t.num_rows * 10
           THEN 'SEVERE_SKEW_UNDERESTIMATE'
           WHEN h_max.max_actual_rows > c.density * t.num_rows * 2
           THEN 'MODERATE_SKEW'
           ELSE 'DISTRIBUTION_OK'
       END AS skew_diagnosis
FROM dba_tab_col_statistics c
JOIN dba_tab_statistics t
  ON t.owner = c.owner AND t.table_name = c.table_name AND t.partition_name IS NULL
LEFT JOIN (
    SELECT owner, table_name, column_name, MIN(endpoint_repeat_count) AS min_actual_rows
    FROM dba_tab_histograms
    GROUP BY owner, table_name, column_name
) h_min ON h_min.owner = c.owner
       AND h_min.table_name = c.table_name
       AND h_min.column_name = c.column_name
LEFT JOIN (
    SELECT owner, table_name, column_name, MAX(endpoint_repeat_count) AS max_actual_rows
    FROM dba_tab_histograms
    GROUP BY owner, table_name, column_name
) h_max ON h_max.owner = c.owner
       AND h_max.table_name = c.table_name
       AND h_max.column_name = c.column_name
WHERE c.owner = 'INVENTORY_OWN'
  AND c.table_name = 'STAGE_INVENTORY_ITEMS'
  AND c.num_distinct < 50
ORDER BY c.num_distinct;
\`\`\`

---

## Phase 3: Detect Self-Join Patterns in SQL Cache and AWR

### Step 3.1: Find self-join patterns in V\$SQL

\`\`\`sql
-- Detect SQL with the same table name appearing multiple times in the FROM clause
-- Combined with SELECT DISTINCT and high buffer_gets — self-join anti-pattern signature
SELECT s.sql_id,
       s.executions,
       ROUND(s.buffer_gets / NULLIF(s.executions, 0)) AS avg_lio,
       ROUND(s.elapsed_time / NULLIF(s.executions, 0) / 1e6, 2) AS avg_elapsed_sec,
       ROUND(s.rows_processed / NULLIF(s.executions, 0)) AS avg_rows,
       SUBSTR(s.sql_fulltext, 1, 200) AS sql_preview
FROM v\$sql s
WHERE s.executions > 0
  AND s.buffer_gets / NULLIF(s.executions, 0) > 50000
  AND (
        -- Self-join pattern: same table alias appearing more than once
        REGEXP_COUNT(UPPER(s.sql_fulltext), 'STAGE_INVENTORY_ITEMS') >= 2
        OR
        -- Generic self-join detection: FROM clause has repeated table name
        REGEXP_COUNT(
            UPPER(s.sql_fulltext),
            'FROM[[:space:]]+([A-Z_][A-Z0-9_\$#]*)[[:space:]]'
        ) >= 2
      )
  AND UPPER(s.sql_fulltext) LIKE '%DISTINCT%'
  AND s.parsing_schema_name NOT IN ('SYS', 'SYSTEM')
ORDER BY avg_lio DESC;
\`\`\`

### Step 3.2: Find MERGE JOIN CARTESIAN in execution plans — the Cartesian product smoking gun

\`\`\`sql
-- Plans in the shared pool containing MERGE JOIN CARTESIAN
-- This is the definitive sign of an unintentional Cartesian product
SELECT s.sql_id,
       s.executions,
       ROUND(s.buffer_gets / NULLIF(s.executions, 0)) AS avg_lio,
       p.operation,
       p.options,
       p.cost,
       p.cardinality AS estimated_rows,
       SUBSTR(s.sql_fulltext, 1, 150) AS sql_preview
FROM v\$sql s
JOIN v\$sql_plan p
  ON p.sql_id = s.sql_id AND p.child_number = s.child_number
WHERE p.operation = 'MERGE JOIN'
  AND p.options = 'CARTESIAN'
  AND s.parsing_schema_name NOT IN ('SYS', 'SYSTEM', 'DBSNMP')
ORDER BY s.buffer_gets / NULLIF(s.executions, 0) DESC NULLS LAST;
\`\`\`

### Step 3.3: Find SORT UNIQUE combined with large cardinality estimates in plans

\`\`\`sql
-- SORT UNIQUE with large estimated rows = DISTINCT on a large intermediate result
-- This is the plan signature of a DISTINCT applied to a cross-product
SELECT p.sql_id,
       p.plan_hash_value,
       p.operation,
       p.options,
       p.cardinality AS estimated_rows,
       p.bytes AS estimated_bytes,
       p.cost,
       s.executions,
       ROUND(s.buffer_gets / NULLIF(s.executions, 0)) AS avg_lio
FROM v\$sql_plan p
JOIN v\$sql s
  ON s.sql_id = p.sql_id AND s.child_number = p.child_number
WHERE p.operation = 'SORT'
  AND p.options = 'UNIQUE'
  AND p.cardinality > 100000
  AND s.parsing_schema_name NOT IN ('SYS', 'SYSTEM', 'DBSNMP')
ORDER BY p.cardinality DESC NULLS LAST;
\`\`\`

### Step 3.4: Scan AWR historical SQL text for self-join patterns

\`\`\`sql
-- Find self-join patterns in AWR historical SQL text
SELECT t.sql_id,
       ss.executions_delta AS executions_last_snap,
       ROUND(ss.buffer_gets_delta / NULLIF(ss.executions_delta, 0)) AS avg_lio,
       ROUND(ss.elapsed_time_delta / NULLIF(ss.executions_delta, 0) / 1e6, 2) AS avg_sec,
       SUBSTR(t.sql_text, 1, 200) AS sql_preview
FROM dba_hist_sqltext t
JOIN dba_hist_sqlstat ss
  ON ss.sql_id = t.sql_id AND ss.dbid = t.dbid
JOIN dba_hist_snapshot sn
  ON sn.snap_id = ss.snap_id AND sn.dbid = ss.dbid
WHERE sn.begin_interval_time > SYSDATE - 7
  AND ss.executions_delta > 0
  AND ss.buffer_gets_delta / NULLIF(ss.executions_delta, 0) > 100000
  AND REGEXP_COUNT(UPPER(t.sql_text), 'STAGE_INVENTORY_ITEMS') >= 2
ORDER BY avg_lio DESC;
\`\`\`

---

## Phase 4: Measure PGA Spill Impact

### Step 4.1: Currently spilling operations (live capture)

\`\`\`sql
-- Active workareas currently spilling to temp
SELECT wa.sql_id,
       wa.sql_exec_id,
       wa.operation_type,
       wa.policy,
       ROUND(wa.estimated_optimal_size / 1048576) AS optimal_mb,
       ROUND(wa.actual_mem_used / 1048576) AS actual_mb,
       wa.number_passes AS passes,
       ROUND(wa.tempseg_size / 1048576) AS temp_spill_mb,
       wa.work_area_size / 1048576 AS allocated_mb
FROM v\$sql_workarea_active wa
WHERE wa.tempseg_size > 0
ORDER BY wa.tempseg_size DESC;
\`\`\`

### Step 4.2: Find active temp segment consumers

\`\`\`sql
-- Current temp segment usage by session and SQL
SELECT s.sid,
       s.serial#,
       s.username,
       s.sql_id,
       s.event,
       ROUND(su.blocks * 8192 / 1048576) AS temp_mb,
       su.segtype
FROM v\$tempseg_usage su
JOIN v\$session s
  ON s.saddr = su.session_addr
ORDER BY su.blocks DESC;
\`\`\`

### Step 4.3: Historical PGA spill analysis for a specific SQL_ID

\`\`\`sql
-- Historical sort-to-disk stats for a specific SQL_ID from DBA_HIST_SQLSTAT
SELECT sn.begin_interval_time,
       ss.executions_delta,
       ss.buffer_gets_delta,
       ss.sorts_delta,
       ROUND(ss.elapsed_time_delta / NULLIF(ss.executions_delta, 0) / 1e6, 2) AS avg_elapsed_sec,
       ROUND(ss.buffer_gets_delta / NULLIF(ss.executions_delta, 0)) AS avg_lio
FROM dba_hist_sqlstat ss
JOIN dba_hist_snapshot sn
  ON sn.snap_id = ss.snap_id AND sn.dbid = ss.dbid
WHERE ss.sql_id = '9vtx2ws844123'  -- substitute target SQL_ID
ORDER BY sn.begin_interval_time DESC;

-- Workarea profile for the SQL_ID from the shared pool
SELECT sql_id,
       operation_type,
       policy,
       ROUND(estimated_optimal_size / 1048576) AS optimal_mb,
       ROUND(onepass_size / 1048576) AS onepass_mb,
       multipasses,
       active_time / 1000 AS active_ms
FROM v\$sql_workarea
WHERE sql_id = '9vtx2ws844123'
ORDER BY estimated_optimal_size DESC;
\`\`\`

---

## Phase 5: Gather Targeted Histograms

### Step 5.1: Baseline — capture current statistics before histogram gather

\`\`\`sql
-- Capture pre-histogram state
SELECT column_name,
       num_distinct,
       density,
       histogram,
       num_buckets,
       last_analyzed,
       ROUND(density * (SELECT num_rows FROM dba_tab_statistics
                        WHERE owner = 'INVENTORY_OWN'
                          AND table_name = 'STAGE_INVENTORY_ITEMS'
                          AND partition_name IS NULL)) AS estimated_rows_per_value
FROM dba_tab_col_statistics
WHERE owner = 'INVENTORY_OWN'
  AND table_name = 'STAGE_INVENTORY_ITEMS'
  AND column_name = 'PROCESSING_STATUS';
\`\`\`

### Step 5.2: Gather histogram on the skewed column only

\`\`\`sql
-- Targeted histogram gather — does NOT touch other column statistics
-- no_invalidate => FALSE forces immediate cursor invalidation
BEGIN
  DBMS_STATS.GATHER_TABLE_STATS(
    ownname          => 'INVENTORY_OWN',
    tabname          => 'STAGE_INVENTORY_ITEMS',
    estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,
    method_opt       => 'FOR COLUMNS SIZE AUTO PROCESSING_STATUS',
    no_invalidate    => FALSE,
    degree           => 4
  );
END;
/
\`\`\`

### Step 5.3: Verify the histogram was gathered and new density is accurate

\`\`\`sql
-- Post-histogram state comparison
SELECT column_name,
       num_distinct,
       density,
       histogram,
       num_buckets,
       last_analyzed,
       ROUND(density * (SELECT num_rows FROM dba_tab_statistics
                        WHERE owner = 'INVENTORY_OWN'
                          AND table_name = 'STAGE_INVENTORY_ITEMS'
                          AND partition_name IS NULL)) AS new_estimated_rows_per_value
FROM dba_tab_col_statistics
WHERE owner = 'INVENTORY_OWN'
  AND table_name = 'STAGE_INVENTORY_ITEMS'
  AND column_name = 'PROCESSING_STATUS';
-- Expect: HISTOGRAM = 'FREQUENCY', NUM_BUCKETS = 5 (one per distinct value)
-- Expect: DENSITY is now specific to the least-frequent value (not 1/NDV)
\`\`\`

### Step 5.4: Verify the optimizer's new cardinality estimate via EXPLAIN PLAN

\`\`\`sql
EXPLAIN PLAN FOR
SELECT DISTINCT b.item_key, b.warehouse_id, b.batch_id
FROM stage_inventory_items a, stage_inventory_items b
WHERE a.processing_status = 'PENDING'
  AND a.processing_status = b.processing_status
  AND NVL(a.sku_number, '*') = NVL(b.sku_number, '*')
  AND NVL(a.warehouse_id, '*') = NVL(b.warehouse_id, '*');

SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(format => 'TYPICAL'));
-- After histogram gather:
-- The cardinality estimate for the INDEX RANGE SCAN on PROCESSING_STATUS
-- should now show a number close to the actual PENDING count (~104999)
-- rather than the uniform estimate of ~800000
\`\`\`

---

## Phase 6: Rebuild Index with INITRANS / PCTFREE

### Step 6.1: Find indexes with low INITRANS on high-DML tables

\`\`\`sql
-- Find indexes with INI_TRANS < 4 on tables that have had significant DML
-- since last statistics gather (potential hotspot for buffer busy waits)
SELECT i.owner,
       i.index_name,
       i.table_name,
       i.ini_trans,
       i.max_trans,
       i.pct_free,
       i.status,
       m.inserts + m.updates + m.deletes AS total_dml_since_analyze,
       m.timestamp AS last_modification_tracked
FROM dba_indexes i
JOIN dba_tab_modifications m
  ON m.table_owner = i.owner
  AND m.table_name = i.table_name
  AND m.partition_name IS NULL
WHERE i.owner NOT IN ('SYS', 'SYSTEM', 'DBSNMP', 'SYSMAN')
  AND i.ini_trans < 4
  AND m.inserts + m.updates + m.deletes > 10000
  AND i.status = 'VALID'
ORDER BY m.inserts + m.updates + m.deletes DESC;
\`\`\`

### Step 6.2: Rebuild the index with increased concurrency parameters

\`\`\`sql
-- Rebuild with ONLINE (allows concurrent DML), INITRANS 8 (8 initial transaction slots),
-- PCTFREE 20 (reserve 20% of each block for updates and dynamic ITL growth)
ALTER INDEX inventory_own.idx_stage_inv_status
  REBUILD
  INITRANS 8
  PCTFREE 20
  ONLINE
  PARALLEL 4;

-- After rebuild, reset degree to 1 (parallel is for build only)
ALTER INDEX inventory_own.idx_stage_inv_status NOPARALLEL;

-- Verify new settings
SELECT index_name,
       ini_trans,
       max_trans,
       pct_free,
       status,
       last_analyzed,
       leaf_blocks,
       distinct_keys
FROM dba_indexes
WHERE owner = 'INVENTORY_OWN'
  AND index_name = 'IDX_STAGE_INV_STATUS';
\`\`\`

### Step 6.3: Monitor buffer busy wait reduction post-rebuild

\`\`\`sql
-- Capture baseline buffer busy waits for the index segment
-- Run this BEFORE the rebuild, then run again 1 hour AFTER the rebuild
SELECT statistic_name, value
FROM v\$segment_statistics
WHERE owner = 'INVENTORY_OWN'
  AND object_name = 'IDX_STAGE_INV_STATUS'
  AND statistic_name IN ('buffer busy waits', 'ITL waits', 'row lock waits')
ORDER BY statistic_name;
-- A reduction in 'buffer busy waits' and 'ITL waits' confirms the rebuild helped
\`\`\`

---

## Phase 7: Create and Validate Composite Index

### Step 7.1: Create the composite index

\`\`\`sql
-- Create composite index covering all three join/filter columns
-- Column order: processing_status first (the universal filter),
-- then warehouse_id and sku_number (provide combined selectivity)
CREATE INDEX inventory_own.idx_stage_inv_comp
  ON stage_inventory_items (processing_status, warehouse_id, sku_number)
  INITRANS 8
  PCTFREE 20
  ONLINE
  PARALLEL 4;

-- Reset parallel after build
ALTER INDEX inventory_own.idx_stage_inv_comp NOPARALLEL;

-- Gather index statistics immediately
BEGIN
  DBMS_STATS.GATHER_INDEX_STATS(
    ownname  => 'INVENTORY_OWN',
    indname  => 'IDX_STAGE_INV_COMP'
  );
END;
/
\`\`\`

### Step 7.2: Verify the optimizer uses the new composite index

\`\`\`sql
-- Force the composite index with a hint and compare plans
-- Plan WITH composite index hint
EXPLAIN PLAN SET STATEMENT_ID = 'WITH_COMP_IDX' FOR
SELECT /*+ INDEX(b IDX_STAGE_INV_COMP) INDEX(a IDX_STAGE_INV_COMP) */
    item_key, warehouse_id, batch_id
FROM stage_inventory_items b
WHERE b.processing_status = 'PENDING'
  AND EXISTS (
      SELECT 1 FROM stage_inventory_items a
      WHERE a.processing_status = 'PENDING'
        AND NVL(a.sku_number, '*') = NVL(b.sku_number, '*')
        AND NVL(a.warehouse_id, '*') = NVL(b.warehouse_id, '*')
      GROUP BY sku_number, warehouse_id
      HAVING COUNT(*) > 1
  );

SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(
    statement_id => 'WITH_COMP_IDX',
    format       => 'TYPICAL +PREDICATE'
));
\`\`\`

### Step 7.3: Identify and drop the now-superseded single-column index

\`\`\`sql
-- Find single-column indexes whose column is the leading column of the new composite index
-- These are now redundant: any query that could use the single-column index
-- can instead use the composite index (which provides equal or better coverage)
SELECT sc.owner,
       sc.index_name AS single_col_index,
       sc.column_name,
       comp.index_name AS superseding_composite_index
FROM (
    SELECT i.owner, i.index_name, ic.column_name
    FROM dba_indexes i
    JOIN dba_ind_columns ic
      ON ic.index_owner = i.owner AND ic.index_name = i.index_name
    WHERE i.owner = 'INVENTORY_OWN'
      AND i.table_name = 'STAGE_INVENTORY_ITEMS'
    HAVING COUNT(*) = 1
    GROUP BY i.owner, i.index_name, ic.column_name
) sc
JOIN (
    SELECT i.owner, i.index_name, ic.column_name
    FROM dba_indexes i
    JOIN dba_ind_columns ic
      ON ic.index_owner = i.owner
      AND ic.index_name = i.index_name
      AND ic.column_position = 1
    WHERE i.owner = 'INVENTORY_OWN'
      AND i.table_name = 'STAGE_INVENTORY_ITEMS'
      AND i.index_name = 'IDX_STAGE_INV_COMP'
) comp ON comp.owner = sc.owner AND comp.column_name = sc.column_name;

-- After validating no application explicitly references the single-column index:
-- DROP INDEX inventory_own.idx_stage_inv_status;
\`\`\`

---

## Phase 8: Rewrite Validation — Before and After

### Step 8.1: Side-by-side execution plan comparison

\`\`\`sql
-- BEFORE: original self-join with DISTINCT
EXPLAIN PLAN SET STATEMENT_ID = 'BEFORE_REWRITE' FOR
SELECT DISTINCT b.item_key, b.warehouse_id, b.batch_id
FROM stage_inventory_items a, stage_inventory_items b
WHERE a.processing_status = 'PENDING'
  AND a.processing_status = b.processing_status
  AND NVL(a.sku_number, '*') = NVL(b.sku_number, '*')
  AND NVL(a.warehouse_id, '*') = NVL(b.warehouse_id, '*');

-- AFTER: EXISTS rewrite with GROUP BY / HAVING
EXPLAIN PLAN SET STATEMENT_ID = 'AFTER_REWRITE' FOR
SELECT item_key, warehouse_id, batch_id
FROM stage_inventory_items b
WHERE b.processing_status = 'PENDING'
  AND EXISTS (
      SELECT 1
      FROM stage_inventory_items a
      WHERE a.processing_status = 'PENDING'
        AND NVL(a.sku_number, '*') = NVL(b.sku_number, '*')
        AND NVL(a.warehouse_id, '*') = NVL(b.warehouse_id, '*')
      GROUP BY sku_number, warehouse_id
      HAVING COUNT(*) > 1
  );

-- Compare both plans
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(statement_id => 'BEFORE_REWRITE', format => 'TYPICAL'));
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(statement_id => 'AFTER_REWRITE', format => 'TYPICAL'));
-- Key differences to look for:
-- BEFORE: SORT UNIQUE + MERGE JOIN CARTESIAN (or HASH JOIN without usable keys)
-- AFTER:  HASH JOIN SEMI or NESTED LOOPS SEMI — no SORT UNIQUE, no CARTESIAN
\`\`\`

### Step 8.2: Actual execution statistics comparison using gather_plan_statistics

\`\`\`sql
-- Run both versions with gather_plan_statistics hint to capture actual row counts
-- Run BEFORE version:
SELECT /*+ GATHER_PLAN_STATISTICS */
    DISTINCT b.item_key, b.warehouse_id, b.batch_id
FROM stage_inventory_items a, stage_inventory_items b
WHERE a.processing_status = 'PENDING'
  AND a.processing_status = b.processing_status
  AND NVL(a.sku_number, '*') = NVL(b.sku_number, '*')
  AND NVL(a.warehouse_id, '*') = NVL(b.warehouse_id, '*');

-- Capture actual plan with runtime stats
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(
    sql_id         => NULL,  -- uses the last executed SQL in the session
    cursor_child_no => 0,
    format         => 'ALLSTATS LAST'
));

-- Run AFTER version:
SELECT /*+ GATHER_PLAN_STATISTICS */
    item_key, warehouse_id, batch_id
FROM stage_inventory_items b
WHERE b.processing_status = 'PENDING'
  AND EXISTS (
      SELECT 1
      FROM stage_inventory_items a
      WHERE a.processing_status = 'PENDING'
        AND NVL(a.sku_number, '*') = NVL(b.sku_number, '*')
        AND NVL(a.warehouse_id, '*') = NVL(b.warehouse_id, '*')
      GROUP BY sku_number, warehouse_id
      HAVING COUNT(*) > 1
  );

SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(
    sql_id          => NULL,
    cursor_child_no  => 0,
    format          => 'ALLSTATS LAST'
));
-- In ALLSTATS output, compare:
-- Buffers (E-Rows vs A-Rows divergence — before version will show massive overcount)
-- Actual time (Starts column — EXISTS stops early, reducing total row evaluations)
-- Temp usage (disappears in the AFTER version)
\`\`\`

### Step 8.3: V\$SQL comparison after both versions have run

\`\`\`sql
-- Compare buffer_gets, elapsed_time, rows_processed between the two SQL_IDs
SELECT sql_id,
       executions,
       ROUND(buffer_gets / NULLIF(executions, 0)) AS avg_lio,
       ROUND(elapsed_time / NULLIF(executions, 0) / 1e6, 2) AS avg_elapsed_sec,
       ROUND(rows_processed / NULLIF(executions, 0)) AS avg_rows,
       SUBSTR(sql_text, 1, 100) AS sql_preview
FROM v\$sql
WHERE sql_text LIKE '%STAGE_INVENTORY_ITEMS%'
  AND sql_text LIKE '%PENDING%'
  AND parsing_schema_name NOT IN ('SYS', 'SYSTEM')
ORDER BY avg_lio DESC;
\`\`\`

---

## Phase 9: The Full Automated Scanner Procedure

### Step 9.1: Create the logging table

\`\`\`sql
CREATE TABLE lowcard_index_risk_log (
    log_id         NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    check_date     DATE NOT NULL,
    schema_name    VARCHAR2(128) NOT NULL,
    table_name     VARCHAR2(128) NOT NULL,
    index_name     VARCHAR2(128) NOT NULL,
    column_name    VARCHAR2(128) NOT NULL,
    num_distinct   NUMBER,
    num_rows       NUMBER,
    selectivity_pct NUMBER(10,4),
    histogram_type VARCHAR2(30),
    risk_flag      VARCHAR2(50),
    stale_mods     NUMBER,
    recent_lio     NUMBER,
    notes          VARCHAR2(500),
    run_id         VARCHAR2(36)
);

CREATE INDEX lowcard_log_date_idx ON lowcard_index_risk_log (check_date, schema_name);
\`\`\`

### Step 9.2: The full automated scanner procedure

\`\`\`sql
CREATE OR REPLACE PROCEDURE check_lowcard_index_risk (
    p_schema_name    IN VARCHAR2 DEFAULT NULL,  -- NULL = all non-SYS schemas
    p_min_table_rows IN NUMBER   DEFAULT 100000,
    p_ndv_threshold  IN NUMBER   DEFAULT 50
)
AS
    v_run_id     VARCHAR2(36) := SYS_GUID();
    v_email_body CLOB         := 'Low-Cardinality Index Risk Scan Results' || CHR(10)
                                 || 'Run ID: ' || v_run_id || CHR(10)
                                 || 'Scan Date: ' || TO_CHAR(SYSDATE, 'YYYY-MM-DD HH24:MI:SS')
                                 || CHR(10) || CHR(10);
    v_risk_count NUMBER       := 0;
    v_stale_mods NUMBER;
    v_recent_lio NUMBER;
BEGIN
    -- Step 1: Flush pending monitoring info to DBA_TAB_MODIFICATIONS
    DBMS_STATS.FLUSH_DATABASE_MONITORING_INFO;

    -- Step 2: Scan all qualifying single-column and leading-column indexes
    FOR rec IN (
        SELECT i.owner,
               i.table_name,
               i.index_name,
               ic.column_name,
               cs.num_distinct,
               ts.num_rows,
               ROUND(cs.num_distinct / NULLIF(ts.num_rows, 0) * 100, 4) AS selectivity_pct,
               cs.histogram,
               CASE
                   WHEN cs.histogram = 'NONE' AND cs.num_distinct < p_ndv_threshold
                   THEN 'UNHISTOGRAMED_LOW_CARDINALITY'
                   WHEN cs.num_distinct / NULLIF(ts.num_rows, 0) > 0.10
                   THEN 'HIGH_RISK_SELECTIVITY'
                   WHEN cs.num_distinct / NULLIF(ts.num_rows, 0) > 0.01
                   THEN 'MEDIUM_RISK_SELECTIVITY'
                   ELSE 'MONITOR'
               END AS risk_flag
        FROM dba_indexes i
        JOIN dba_ind_columns ic
          ON ic.index_owner = i.owner
          AND ic.index_name = i.index_name
          AND ic.column_position = 1
        JOIN dba_tab_col_statistics cs
          ON cs.owner = i.owner
          AND cs.table_name = i.table_name
          AND cs.column_name = ic.column_name
        JOIN dba_tab_statistics ts
          ON ts.owner = i.owner
          AND ts.table_name = i.table_name
          AND ts.partition_name IS NULL
        WHERE (p_schema_name IS NULL OR i.owner = UPPER(p_schema_name))
          AND i.owner NOT IN ('SYS','SYSTEM','DBSNMP','SYSMAN','WMSYS','XDB','CTXSYS','MDSYS')
          AND cs.num_distinct < p_ndv_threshold
          AND ts.num_rows > p_min_table_rows
          AND i.status = 'VALID'
    ) LOOP

        -- Step 3: Check DBA_TAB_MODIFICATIONS for stale stats indicator
        BEGIN
            SELECT NVL(inserts + updates + deletes, 0)
            INTO v_stale_mods
            FROM dba_tab_modifications
            WHERE table_owner = rec.owner
              AND table_name   = rec.table_name
              AND partition_name IS NULL;
        EXCEPTION WHEN NO_DATA_FOUND THEN
            v_stale_mods := 0;
        END;

        -- Step 4: Check V\$SQL for recent high-buffer_gets executions on this table
        BEGIN
            SELECT NVL(MAX(ROUND(buffer_gets / NULLIF(executions, 0))), 0)
            INTO v_recent_lio
            FROM v\$sql
            WHERE UPPER(sql_fulltext) LIKE '%' || UPPER(rec.table_name) || '%'
              AND parsing_schema_name = rec.owner
              AND executions > 0
              AND last_active_time > SYSDATE - 1;
        EXCEPTION WHEN OTHERS THEN
            v_recent_lio := 0;
        END;

        -- Step 5: Log the finding
        INSERT INTO lowcard_index_risk_log (
            check_date, schema_name, table_name, index_name, column_name,
            num_distinct, num_rows, selectivity_pct, histogram_type,
            risk_flag, stale_mods, recent_lio, notes, run_id
        ) VALUES (
            SYSDATE,
            rec.owner,
            rec.table_name,
            rec.index_name,
            rec.column_name,
            rec.num_distinct,
            rec.num_rows,
            rec.selectivity_pct,
            rec.histogram,
            rec.risk_flag,
            v_stale_mods,
            v_recent_lio,
            CASE WHEN v_stale_mods > rec.num_rows * 0.10
                 THEN 'STALE_STATS_LIKELY: ' || v_stale_mods || ' mods since last analyze'
                 WHEN v_recent_lio > 500000
                 THEN 'HIGH_LIO_RECENT: avg ' || v_recent_lio || ' LIO/exec in last 24h'
                 ELSE NULL
            END,
            v_run_id
        );

        v_risk_count := v_risk_count + 1;

        -- Append to email body for each HIGH_RISK finding
        IF rec.risk_flag IN ('HIGH_RISK_SELECTIVITY', 'UNHISTOGRAMED_LOW_CARDINALITY') THEN
            v_email_body := v_email_body
                || rec.owner || '.' || rec.table_name || ' -> ' || rec.index_name
                || ' [' || rec.column_name || '] NDV=' || rec.num_distinct
                || ' Rows=' || rec.num_rows
                || ' Sel%=' || rec.selectivity_pct
                || ' ' || rec.risk_flag
                || CHR(10);
        END IF;

    END LOOP;

    COMMIT;

    -- Step 6: Send email summary
    v_email_body := v_email_body || CHR(10) || 'Total findings: ' || v_risk_count;

    UTL_MAIL.SEND(
        sender     => 'oracle-monitor@company.com',
        recipients => 'dba-team@company.com',
        subject    => 'Low-Cardinality Index Risk Scan: ' || v_risk_count || ' findings',
        message    => DBMS_LOB.SUBSTR(v_email_body, 32000, 1)
    );

EXCEPTION
    WHEN OTHERS THEN
        ROLLBACK;
        RAISE;
END check_lowcard_index_risk;
/
\`\`\`

### Step 9.3: Schedule the procedure via DBMS_SCHEDULER

\`\`\`sql
-- Create a daily job to run the scanner
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'LOWCARD_INDEX_RISK_SCAN',
    job_type        => 'STORED_PROCEDURE',
    job_action      => 'CHECK_LOWCARD_INDEX_RISK',
    number_of_arguments => 0,
    start_date      => SYSTIMESTAMP,
    repeat_interval => 'FREQ=DAILY; BYHOUR=6; BYMINUTE=0; BYSECOND=0',
    end_date        => NULL,
    enabled         => TRUE,
    auto_drop        => FALSE,
    comments        => 'Daily low-cardinality index risk scan with email alert'
  );
END;
/

-- Verify the job was created
SELECT job_name, enabled, state, next_run_date, last_run_duration
FROM dba_scheduler_jobs
WHERE job_name = 'LOWCARD_INDEX_RISK_SCAN';

-- Run on demand immediately
EXEC DBMS_SCHEDULER.RUN_JOB('LOWCARD_INDEX_RISK_SCAN');
\`\`\`

---

## Phase 10: Preventive Design Standards

### Step 10.1: Audit all single-column indexes on low-NDV columns across application schemas

\`\`\`sql
-- Periodic audit query: find all single-column indexes on columns with NDV < 100
-- Run weekly and review HIGH_RISK entries
SELECT i.owner,
       i.table_name,
       i.index_name,
       ic.column_name,
       cs.num_distinct,
       ts.num_rows,
       ROUND(1 / NULLIF(cs.num_distinct, 0) * 100, 2) AS naive_selectivity_pct,
       cs.histogram,
       i.status
FROM dba_indexes i
JOIN dba_ind_columns ic
  ON ic.index_owner = i.owner
  AND ic.index_name = i.index_name
JOIN dba_tab_col_statistics cs
  ON cs.owner = i.owner
  AND cs.table_name = i.table_name
  AND cs.column_name = ic.column_name
JOIN dba_tab_statistics ts
  ON ts.owner = i.owner
  AND ts.table_name = i.table_name
  AND ts.partition_name IS NULL
WHERE i.owner NOT IN ('SYS','SYSTEM','DBSNMP','SYSMAN','WMSYS','XDB','CTXSYS','MDSYS','ORDDATA')
  AND cs.num_distinct < 100
  AND ts.num_rows > 50000
  AND i.status = 'VALID'
HAVING COUNT(ic.column_name) = 1  -- single-column indexes only
GROUP BY i.owner, i.table_name, i.index_name, ic.column_name,
         cs.num_distinct, ts.num_rows, cs.histogram, i.status
ORDER BY ts.num_rows DESC NULLS LAST, cs.num_distinct;
\`\`\`

### Step 10.2: Find self-join patterns in the shared pool across all schemas

\`\`\`sql
-- Scan the entire shared pool for potential self-join patterns on large tables
-- Detects same table name appearing multiple times with DISTINCT
SELECT s.parsing_schema_name,
       s.sql_id,
       s.executions,
       ROUND(s.buffer_gets / NULLIF(s.executions, 0)) AS avg_lio,
       SUBSTR(s.sql_fulltext, 1, 200) AS sql_preview
FROM v\$sql s
WHERE s.executions > 0
  AND UPPER(s.sql_fulltext) LIKE '%DISTINCT%'
  AND s.parsing_schema_name NOT IN ('SYS', 'SYSTEM', 'DBSNMP', 'SYSMAN')
  AND (
      -- Match any table that appears at least twice in the FROM clause
      REGEXP_COUNT(
          UPPER(s.sql_fulltext),
          'FROM[[:space:]]+(.*?)[[:space:]]+(WHERE|JOIN|ON)',
          1, 'n'
      ) >= 2
  )
  AND s.buffer_gets / NULLIF(s.executions, 0) > 100000
ORDER BY avg_lio DESC
FETCH FIRST 30 ROWS ONLY;
\`\`\`

### Step 10.3: Detect STATUS / FLAG / CODE columns with no histogram (naming convention check)

\`\`\`sql
-- Columns named with common status/flag/type patterns that have no histogram
-- These are almost always low-cardinality columns that need histograms
SELECT c.owner,
       c.table_name,
       c.column_name,
       c.num_distinct,
       c.histogram,
       t.num_rows,
       c.last_analyzed
FROM dba_tab_col_statistics c
JOIN dba_tab_statistics t
  ON t.owner = c.owner
  AND t.table_name = c.table_name
  AND t.partition_name IS NULL
WHERE c.owner NOT IN ('SYS','SYSTEM','DBSNMP','SYSMAN','WMSYS','XDB','CTXSYS','MDSYS')
  AND c.histogram = 'NONE'
  AND c.num_distinct < 100
  AND t.num_rows > 50000
  AND REGEXP_LIKE(
        c.column_name,
        '(STATUS|FLAG|TYPE|INDICATOR|CODE|STATE|PHASE|STAGE|MODE|CLASS)',
        'i'
      )
ORDER BY t.num_rows DESC NULLS LAST, c.num_distinct;
\`\`\`

### Step 10.4: Weekly DBMS_SCHEDULER job for the full scanner

\`\`\`sql
-- Weekly version of the scanner — runs Sunday at 05:00
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'LOWCARD_WEEKLY_FULL_SCAN',
    job_type        => 'STORED_PROCEDURE',
    job_action      => 'CHECK_LOWCARD_INDEX_RISK',
    number_of_arguments => 0,
    start_date      => NEXT_DAY(TRUNC(SYSDATE), 'SUNDAY')
                       + INTERVAL '5' HOUR,
    repeat_interval => 'FREQ=WEEKLY; BYDAY=SUN; BYHOUR=5; BYMINUTE=0',
    enabled         => TRUE,
    auto_drop        => FALSE,
    comments        => 'Weekly comprehensive low-cardinality index risk scan'
  );
END;
/

-- Query recent scan results from the log table
SELECT risk_flag,
       COUNT(*) AS finding_count,
       COUNT(CASE WHEN stale_mods > 0 THEN 1 END) AS with_stale_mods,
       COUNT(CASE WHEN recent_lio > 500000 THEN 1 END) AS with_high_lio
FROM lowcard_index_risk_log
WHERE check_date > SYSDATE - 7
GROUP BY risk_flag
ORDER BY finding_count DESC;
\`\`\`

---

## Quick Reference

| Phase | Key Action | Critical Query / Command |
|---|---|---|
| 0 | Spot symptoms | \`DBA_HIST_SYSTEM_EVENT\` for buffer busy + db file sequential read co-occurrence |
| 1 | Find risky indexes | Join \`DBA_INDEXES + DBA_IND_COLUMNS + DBA_TAB_COL_STATISTICS\` where leading NDV < 50 |
| 2 | Confirm skew | \`DBA_TAB_HISTOGRAMS\` for bucket distribution; compare to \`DENSITY * NUM_ROWS\` |
| 3 | Find self-joins | \`V\$SQL_PLAN\` for MERGE JOIN CARTESIAN; \`REGEXP_COUNT\` on sql_fulltext for table repeat |
| 4 | Measure PGA spill | \`V\$SQL_WORKAREA_ACTIVE\` where \`tempseg_size > 0\`; \`V\$TEMPSEG_USAGE\` |
| 5 | Fix histogram | \`DBMS_STATS.GATHER_TABLE_STATS\` with \`METHOD_OPT => 'FOR COLUMNS SIZE AUTO col'\` |
| 6 | Reduce block contention | \`ALTER INDEX ... REBUILD INITRANS 8 PCTFREE 20 ONLINE\` |
| 7 | Add composite index | \`CREATE INDEX (status, warehouse_id, sku_number)\` with INITRANS 8 |
| 8 | Validate rewrite | Compare EXPLAIN PLAN before/after; look for SORT UNIQUE elimination |
| 9 | Automate scanning | \`CHECK_LOWCARD_INDEX_RISK\` procedure + DBMS_SCHEDULER daily job |
| 10 | Preventive audit | Weekly query on NDV < 100 single-column indexes; STATUS/FLAG column histogram check |`,
};

async function main() {
  console.log('Inserting Oracle low-cardinality self-join scan runbook post...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: {
      title: post.title,
      excerpt: post.excerpt,
      content: post.content,
      published: post.published,
      publishedAt: post.publishedAt,
      isPremium: post.isPremium,
    },
  });
  console.log(`Inserted: "${post.title}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
