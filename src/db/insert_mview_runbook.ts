import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Materialized View Creation, Refresh, and Monitoring with Notifications',
  slug: 'oracle-mview-creation-monitoring-runbook',
  excerpt:
    'A phased runbook for Oracle DBAs covering the complete materialized view lifecycle: capability analysis with DBMS_MVIEW.EXPLAIN_MVIEW, mview log creation, mview creation patterns (join, aggregate, ON COMMIT, deferred), refresh management (single, group, atomic, out-of-place, scheduled), comprehensive monitoring dashboards, log growth diagnostics, automated staleness alert notifications via UTL_MAIL, query rewrite diagnostics with EXPLAIN_REWRITE, and troubleshooting common failures including ORA-12034 and blocked log purge.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-05'),
  youtubeUrl: null,
  content: `This runbook walks through the complete Oracle materialized view lifecycle from pre-creation analysis through production monitoring and alerting. All scripts are SQL and PL/SQL — no shell scripting. Run each phase sequentially, verify the results, then proceed.

**Assumptions:**
- Oracle Database 12.2 or later (some features require 19c+)
- DBA or appropriate object owner privileges
- UTL_MAIL configured for notification phases (Phase 6)
- Working schema: \`MYAPP\` (substitute your schema throughout)

---

## Phase 0: MView Capability Analysis

Before creating any materialized view, run \`DBMS_MVIEW.EXPLAIN_MVIEW\` to determine exactly which refresh types the target query supports. This prevents discovering after deployment that fast refresh is impossible.

### Step 0.1: Create the capability output table

The procedure writes to \`MV_CAPABILITIES_TABLE\`. Create it once per schema.

\`\`\`sql
-- Create the capability table if it does not already exist
-- Run the Oracle-supplied script:
@\$ORACLE_HOME/rdbms/admin/utlxmv.sql

-- Verify it was created:
SELECT table_name FROM user_tables WHERE table_name = 'MV_CAPABILITIES_TABLE';
\`\`\`

### Step 0.2: Analyse a join mview query

\`\`\`sql
-- Clear any previous results for this test:
DELETE FROM mv_capabilities_table WHERE statement_id = 'JOIN_MV_TEST';
COMMIT;

-- Run capability analysis on the target query:
DECLARE
  v_query VARCHAR2(4000) :=
    'SELECT o.order_id, o.customer_id, c.customer_name, ' ||
    '       o.order_date, o.order_amount, o.status ' ||
    'FROM myapp.orders o ' ||
    'JOIN myapp.customers c ON o.customer_id = c.customer_id';
BEGIN
  DBMS_MVIEW.EXPLAIN_MVIEW(
    mv          => v_query,
    stmt_id     => 'JOIN_MV_TEST'
  );
END;
/

-- Read the results:
SELECT seq, capability_name, possible,
       SUBSTR(msgtxt, 1, 120) AS message
FROM mv_capabilities_table
WHERE statement_id = 'JOIN_MV_TEST'
ORDER BY seq;
\`\`\`

**Interpreting the output:**

| Capability name | Possible = Y means... |
|---|---|
| \`REFRESH_COMPLETE\` | Complete refresh is supported (always Y) |
| \`REFRESH_FAST\` | Fast refresh is possible with a suitable mview log |
| \`REFRESH_FAST_AFTER_INSERT\` | Fast refresh works after INSERTs |
| \`REFRESH_FAST_AFTER_ANY_DML\` | Fast refresh works after INSERT/UPDATE/DELETE |
| \`REWRITE\` | Query rewrite can use this mview |
| \`PCT\` | Partition Change Tracking is applicable |

### Step 0.3: Analyse an aggregate mview query

\`\`\`sql
DELETE FROM mv_capabilities_table WHERE statement_id = 'AGG_MV_TEST';
COMMIT;

DECLARE
  v_query VARCHAR2(4000) :=
    'SELECT region, product_id, ' ||
    '       SUM(amount) AS total_amount, COUNT(*) AS row_count ' ||
    'FROM myapp.sales_fact ' ||
    'GROUP BY region, product_id';
BEGIN
  DBMS_MVIEW.EXPLAIN_MVIEW(
    mv      => v_query,
    stmt_id => 'AGG_MV_TEST'
  );
END;
/

SELECT seq, capability_name, possible, SUBSTR(msgtxt, 1, 120) AS message
FROM mv_capabilities_table
WHERE statement_id = 'AGG_MV_TEST'
ORDER BY seq;
\`\`\`

### Step 0.4: Verify base table prerequisites

\`\`\`sql
-- Check whether mview logs already exist on base tables:
SELECT log_owner, master, log_table, rowids, primary_key,
       sequence, include_new_values, log_creation_date, last_purge_date
FROM dba_mview_logs
WHERE log_owner = 'MYAPP'
  AND master IN ('ORDERS', 'CUSTOMERS', 'SALES_FACT')
ORDER BY master;

-- Check primary key constraints exist (required for PRIMARY KEY mview logs):
SELECT c.table_name, c.constraint_name, c.constraint_type,
       cc.column_name
FROM dba_constraints c
JOIN dba_cons_columns cc ON c.owner = cc.owner
                         AND c.constraint_name = cc.constraint_name
WHERE c.owner = 'MYAPP'
  AND c.constraint_type = 'P'
  AND c.table_name IN ('ORDERS', 'CUSTOMERS', 'SALES_FACT')
ORDER BY c.table_name, cc.position;
\`\`\`

---

## Phase 1: Materialized View Log Creation

Create mview logs on base tables before creating the materialized views. The log must pre-date the mview for fast refresh to work.

### Step 1.1: ROWID-only log (simple projection mview)

\`\`\`sql
-- Minimal log for a simple projection mview with no aggregation or join
-- ROWID is sufficient when the mview only projects rows from a single table
CREATE MATERIALIZED VIEW LOG ON myapp.orders
WITH ROWID;

-- Verify:
SELECT log_table, rowids, primary_key, sequence, include_new_values
FROM dba_mview_logs
WHERE log_owner = 'MYAPP' AND master = 'ORDERS';
\`\`\`

### Step 1.2: PRIMARY KEY + SEQUENCE + INCLUDING NEW VALUES (aggregate mview)

\`\`\`sql
-- Full-featured log required for aggregate fast refresh
-- PRIMARY KEY: enables joining and tracking by logical key
-- SEQUENCE: preserves DML ordering when multiple operations touch the same row
-- INCLUDING NEW VALUES: logs both before and after images for delta computation
-- Column list: only columns referenced in the mview query are needed

-- Drop existing log first if it was created without the required options:
-- DROP MATERIALIZED VIEW LOG ON myapp.sales_fact;

CREATE MATERIALIZED VIEW LOG ON myapp.sales_fact
WITH PRIMARY KEY, ROWID, SEQUENCE (region, product_id, amount)
INCLUDING NEW VALUES;

-- Verify log structure:
SELECT log_table, rowids, primary_key, sequence, include_new_values
FROM dba_mview_logs
WHERE log_owner = 'MYAPP' AND master = 'SALES_FACT';

-- Verify logged columns:
SELECT column_name, column_expression
FROM dba_mview_log_filter_columns
WHERE log_owner = 'MYAPP' AND master = 'SALES_FACT';
\`\`\`

### Step 1.3: Log for join mview (both base tables need logs)

\`\`\`sql
-- Both sides of a join need mview logs for fast refresh after any DML
CREATE MATERIALIZED VIEW LOG ON myapp.orders
WITH PRIMARY KEY, ROWID, SEQUENCE (customer_id, order_date, order_amount, status)
INCLUDING NEW VALUES;

CREATE MATERIALIZED VIEW LOG ON myapp.customers
WITH PRIMARY KEY, ROWID, SEQUENCE (customer_name, region)
INCLUDING NEW VALUES;

-- Verify both logs exist:
SELECT log_owner, master, log_table, primary_key, rowids, sequence, include_new_values
FROM dba_mview_logs
WHERE log_owner = 'MYAPP'
  AND master IN ('ORDERS', 'CUSTOMERS')
ORDER BY master;
\`\`\`

### Step 1.4: Check log table physical structure

\`\`\`sql
-- See the actual columns in a specific mview log:
SELECT column_name, data_type, data_length, nullable
FROM dba_tab_columns
WHERE owner = 'MYAPP'
  AND table_name = 'MLOG\$_SALES_FACT'
ORDER BY column_id;

-- Key columns in an mview log:
-- SNAPTIME\$\$ : timestamp of last refresh that purged up to this row
-- DMLTYPE\$\$  : I=Insert, U=Update, D=Delete
-- OLD_NEW\$\$  : N=New image, O=Old image, U=Update (both)
-- CHANGE_VECTOR\$\$ : bitmap of changed columns
-- XID\$\$      : transaction identifier
-- SEQUENCE\$\$ : ordering sequence (if WITH SEQUENCE was specified)
\`\`\`

---

## Phase 2: Materialized View Creation

### Step 2.1: Simple join mview with fast refresh on demand

\`\`\`sql
-- Join mview: two tables, fast refresh on demand
-- Requires mview logs on both orders and customers (created in Phase 1)
CREATE MATERIALIZED VIEW myapp.order_customer_mv
BUILD IMMEDIATE
REFRESH FAST ON DEMAND
ENABLE QUERY REWRITE
AS
SELECT o.order_id,
       o.customer_id,
       c.customer_name,
       c.region        AS customer_region,
       o.order_date,
       o.order_amount,
       o.status
FROM myapp.orders   o
JOIN myapp.customers c ON o.customer_id = c.customer_id;

-- Verification:
SELECT mview_name, refresh_method, refresh_mode,
       staleness, compile_state, last_refresh_date
FROM all_mviews
WHERE owner = 'MYAPP' AND mview_name = 'ORDER_CUSTOMER_MV';

-- Confirm row count matches expected:
SELECT COUNT(*) FROM myapp.order_customer_mv;
SELECT COUNT(*) FROM myapp.orders;   -- Should be equal for an inner join
\`\`\`

### Step 2.2: Aggregate mview (SUM / COUNT(*) with GROUP BY)

\`\`\`sql
-- Aggregate mview with fast refresh support
-- COUNT(*) is REQUIRED alongside SUM for correct delta computation
CREATE MATERIALIZED VIEW myapp.sales_agg_mv
BUILD IMMEDIATE
REFRESH FAST ON DEMAND
ENABLE QUERY REWRITE
AS
SELECT region,
       product_id,
       SUM(amount)  AS total_amount,
       COUNT(*)     AS row_count,
       COUNT(amount) AS non_null_count   -- Optional: track non-null count separately
FROM myapp.sales_fact
GROUP BY region, product_id;

-- Verify fast refresh is supported:
DELETE FROM mv_capabilities_table WHERE statement_id = 'SALES_AGG_CAP';
COMMIT;

BEGIN
  DBMS_MVIEW.EXPLAIN_MVIEW(
    mv      => 'MYAPP.SALES_AGG_MV',
    stmt_id => 'SALES_AGG_CAP'
  );
END;
/

SELECT capability_name, possible, SUBSTR(msgtxt, 1, 100) AS message
FROM mv_capabilities_table
WHERE statement_id = 'SALES_AGG_CAP'
  AND capability_name IN ('REFRESH_FAST', 'REFRESH_FAST_AFTER_ANY_DML', 'REWRITE');

-- Gather initial statistics:
BEGIN
  DBMS_STATS.GATHER_TABLE_STATS(
    ownname          => 'MYAPP',
    tabname          => 'SALES_AGG_MV',
    estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,
    degree           => 4
  );
END;
/
\`\`\`

### Step 2.3: ON COMMIT mview (small lookup table)

\`\`\`sql
-- Only appropriate for small, infrequently-modified tables
-- The refresh runs synchronously inside every COMMIT on the base table
-- Use only when consumers require immediate post-commit consistency

-- First create the log:
CREATE MATERIALIZED VIEW LOG ON myapp.product_categories
WITH PRIMARY KEY, ROWID
INCLUDING NEW VALUES;

-- Create ON COMMIT mview:
CREATE MATERIALIZED VIEW myapp.product_categories_mv
BUILD IMMEDIATE
REFRESH FAST ON COMMIT
ENABLE QUERY REWRITE
AS
SELECT category_id, category_name, parent_category_id, active_flag
FROM myapp.product_categories
WHERE active_flag = 'Y';

-- Verify:
SELECT mview_name, refresh_method, refresh_mode, staleness
FROM all_mviews
WHERE owner = 'MYAPP' AND mview_name = 'PRODUCT_CATEGORIES_MV';

-- Test: insert a row and commit — the mview should refresh automatically
-- INSERT INTO myapp.product_categories VALUES (999, 'Test Cat', NULL, 'Y');
-- COMMIT;
-- SELECT * FROM myapp.product_categories_mv WHERE category_id = 999;
\`\`\`

### Step 2.4: BUILD DEFERRED + populate later

\`\`\`sql
-- Create the structure without populating — useful during load windows
CREATE MATERIALIZED VIEW myapp.large_fact_summary_mv
BUILD DEFERRED
REFRESH COMPLETE ON DEMAND
ENABLE QUERY REWRITE
AS
SELECT region,
       TO_CHAR(sale_date, 'YYYY-MM') AS sale_month,
       product_id,
       SUM(amount)  AS total_amount,
       COUNT(*)     AS transaction_count
FROM myapp.sales_fact
GROUP BY region, TO_CHAR(sale_date, 'YYYY-MM'), product_id;

-- Confirm it is empty and UNKNOWN:
SELECT mview_name, staleness, last_refresh_date
FROM all_mviews
WHERE owner = 'MYAPP' AND mview_name = 'LARGE_FACT_SUMMARY_MV';
-- staleness = UNKNOWN, last_refresh_date = null

SELECT COUNT(*) FROM myapp.large_fact_summary_mv;   -- Should return 0

-- Later, during the maintenance window, populate it:
BEGIN
  DBMS_MVIEW.REFRESH(
    list   => 'MYAPP.LARGE_FACT_SUMMARY_MV',
    method => 'C'
  );
END;
/

-- Verify it is now FRESH:
SELECT mview_name, staleness, last_refresh_date, last_refresh_type
FROM all_mviews
WHERE owner = 'MYAPP' AND mview_name = 'LARGE_FACT_SUMMARY_MV';

-- Gather statistics immediately after first population:
BEGIN
  DBMS_STATS.GATHER_TABLE_STATS(
    ownname          => 'MYAPP',
    tabname          => 'LARGE_FACT_SUMMARY_MV',
    estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,
    degree           => 4
  );
END;
/
\`\`\`

---

## Phase 3: Refresh Management

### Step 3.1: Single mview refresh

\`\`\`sql
-- Refresh a single mview using FAST method:
BEGIN
  DBMS_MVIEW.REFRESH(
    list             => 'MYAPP.SALES_AGG_MV',
    method           => 'F',        -- F=fast, C=complete, ?=force
    atomic_refresh   => FALSE,      -- FALSE: truncate+insert (faster); TRUE: delete+insert (avoids empty state)
    parallelism      => 4,          -- Degree of parallelism for complete refresh
    out_of_place     => FALSE
  );
END;
/

-- Check the result:
SELECT mview_name, last_refresh_type, last_refresh_date, staleness
FROM all_mviews
WHERE owner = 'MYAPP' AND mview_name = 'SALES_AGG_MV';
\`\`\`

### Step 3.2: Refresh all mviews in a schema

\`\`\`sql
-- Refresh all mviews owned by MYAPP:
BEGIN
  DBMS_MVIEW.REFRESH_ALL_MVIEWS(
    number_of_failures => 0,    -- OUT parameter: set to a variable in real scripts
    method             => 'F',
    atomic_refresh     => FALSE
  );
END;
/

-- In a real script, capture failure count:
DECLARE
  v_failures NUMBER;
BEGIN
  DBMS_MVIEW.REFRESH_ALL_MVIEWS(
    number_of_failures => v_failures,
    method             => 'F',
    atomic_refresh     => FALSE
  );
  IF v_failures > 0 THEN
    RAISE_APPLICATION_ERROR(-20001, 'REFRESH_ALL_MVIEWS reported ' || v_failures || ' failure(s)');
  END IF;
END;
/
\`\`\`

### Step 3.3: Refresh a dependency group (ordered list)

\`\`\`sql
-- When mviews build on each other, refresh them in dependency order
-- DBMS_MVIEW.REFRESH with a comma-separated list processes them in order
BEGIN
  DBMS_MVIEW.REFRESH(
    list           => 'MYAPP.ORDER_CUSTOMER_MV,MYAPP.SALES_AGG_MV,MYAPP.LARGE_FACT_SUMMARY_MV',
    method         => 'F',
    atomic_refresh => FALSE,
    nested         => FALSE    -- FALSE: refresh in list order; TRUE: dependency-aware reorder
  );
END;
/
\`\`\`

### Step 3.4: Atomic vs non-atomic refresh

\`\`\`sql
-- ATOMIC_REFRESH = TRUE (default):
-- Oracle uses DELETE + INSERT instead of TRUNCATE + INSERT
-- The mview is never empty from a reader's perspective
-- Much slower because DELETE generates undo for every row
-- Use for small mviews or when zero-downtime reads are required

-- ATOMIC_REFRESH = FALSE:
-- Oracle truncates the container, inserts new data
-- Readers briefly see an empty mview during the insert phase
-- Significantly faster for large mviews
-- Use with OUT_OF_PLACE = TRUE to get fast refresh without the empty-window problem

-- Fast complete refresh with no empty window (12.2+):
BEGIN
  DBMS_MVIEW.REFRESH(
    list           => 'MYAPP.LARGE_FACT_SUMMARY_MV',
    method         => 'C',
    atomic_refresh => FALSE,
    out_of_place   => TRUE     -- Build new segment, then atomic swap
  );
END;
/
\`\`\`

### Step 3.5: Out-of-place refresh (12.2+)

\`\`\`sql
-- Out-of-place refresh: Oracle builds a new segment and atomically renames it
-- The original mview remains readable throughout the refresh
-- Requires 2x the space in the tablespace temporarily

-- Check available tablespace space before running:
SELECT t.tablespace_name,
       ROUND(t.free_space_mb, 1) AS free_mb,
       ROUND(s.used_mb, 1) AS mview_size_mb,
       CASE WHEN t.free_space_mb > s.used_mb * 1.5
            THEN 'SUFFICIENT SPACE'
            ELSE '*** INSUFFICIENT — need ~' || ROUND(s.used_mb * 1.5, 0) || ' MB free ***'
       END AS space_check
FROM (
  SELECT tablespace_name, SUM(bytes) / 1048576 AS free_space_mb
  FROM dba_free_space GROUP BY tablespace_name
) t
JOIN (
  SELECT tablespace_name, SUM(bytes) / 1048576 AS used_mb
  FROM dba_segments
  WHERE owner = 'MYAPP' AND segment_name = 'LARGE_FACT_SUMMARY_MV'
  GROUP BY tablespace_name
) s ON t.tablespace_name = s.tablespace_name;

-- Run out-of-place refresh:
BEGIN
  DBMS_MVIEW.REFRESH(
    list         => 'MYAPP.LARGE_FACT_SUMMARY_MV',
    method       => 'C',
    out_of_place => TRUE
  );
END;
/

-- Verify:
SELECT mview_name, last_refresh_type, last_refresh_date, staleness
FROM all_mviews
WHERE owner = 'MYAPP' AND mview_name = 'LARGE_FACT_SUMMARY_MV';
\`\`\`

### Step 3.6: Schedule refresh via DBMS_SCHEDULER

\`\`\`sql
-- Create a nightly refresh job:
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'MYAPP_MVIEW_NIGHTLY_REFRESH',
    job_type        => 'PLSQL_BLOCK',
    job_action      => q'[
      DECLARE
        v_failures NUMBER;
      BEGIN
        -- Refresh in dependency order, fast method
        DBMS_MVIEW.REFRESH(
          list           => 'MYAPP.ORDER_CUSTOMER_MV,' ||
                            'MYAPP.SALES_AGG_MV,' ||
                            'MYAPP.LARGE_FACT_SUMMARY_MV',
          method         => 'F',
          atomic_refresh => FALSE
        );

        -- Gather statistics on all refreshed mviews
        DBMS_STATS.GATHER_TABLE_STATS(
          ownname => 'MYAPP', tabname => 'SALES_AGG_MV',
          estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE, degree => 4
        );
        DBMS_STATS.GATHER_TABLE_STATS(
          ownname => 'MYAPP', tabname => 'ORDER_CUSTOMER_MV',
          estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE, degree => 4
        );
      END;
    ]',
    start_date      => TRUNC(SYSTIMESTAMP) + 2/24,   -- 2:00 AM tonight
    repeat_interval => 'FREQ=DAILY;BYHOUR=2;BYMINUTE=0;BYSECOND=0',
    enabled         => TRUE,
    comments        => 'Nightly mview refresh and stats gather for MYAPP schema'
  );
END;
/

-- Verify the job was created:
SELECT job_name, enabled, state, last_start_date, next_run_date
FROM dba_scheduler_jobs
WHERE job_name = 'MYAPP_MVIEW_NIGHTLY_REFRESH';
\`\`\`

---

## Phase 4: Monitoring Scripts

### Step 4.1: Comprehensive mview health dashboard

\`\`\`sql
-- Full mview health dashboard: staleness, refresh times, sizes, log sizes
SELECT
  mv.owner,
  mv.mview_name,
  mv.staleness,
  mv.last_refresh_type,
  TO_CHAR(mv.last_refresh_date, 'YYYY-MM-DD HH24:MI') AS last_refresh,
  ROUND(SYSDATE - mv.last_refresh_date, 2) AS hours_since_refresh,
  mv.refresh_method,
  mv.refresh_mode,
  mv.compile_state,
  ROUND(mv_seg.bytes / 1048576, 1) AS mview_mb,
  ROUND(log_seg.bytes / 1048576, 1) AS log_mb,
  mv.query_rewrite_enabled
FROM all_mviews mv
LEFT JOIN dba_segments mv_seg
  ON mv_seg.owner = mv.owner
  AND mv_seg.segment_name = mv.mview_name
  AND mv_seg.segment_type = 'TABLE'
LEFT JOIN dba_mview_logs ml
  ON ml.log_owner = mv.owner
LEFT JOIN dba_segments log_seg
  ON log_seg.owner = ml.log_owner
  AND log_seg.segment_name = ml.log_table
  AND log_seg.segment_type = 'TABLE'
WHERE mv.owner NOT IN ('SYS', 'SYSTEM', 'SYSMAN', 'DBSNMP')
ORDER BY mv.owner, mv.mview_name;
\`\`\`

### Step 4.2: Staleness summary

\`\`\`sql
-- Count mviews by staleness state per owner:
SELECT owner, staleness, COUNT(*) AS mview_count
FROM all_mviews
WHERE owner NOT IN ('SYS', 'SYSTEM', 'SYSMAN', 'DBSNMP')
GROUP BY owner, staleness
ORDER BY owner, staleness;

-- Mviews that have not refreshed in more than 24 hours:
SELECT owner, mview_name, last_refresh_date,
       ROUND((SYSDATE - last_refresh_date) * 24, 1) AS hours_stale,
       staleness
FROM all_mviews
WHERE owner NOT IN ('SYS', 'SYSTEM', 'SYSMAN', 'DBSNMP')
  AND (last_refresh_date < SYSDATE - 1 OR last_refresh_date IS NULL)
ORDER BY last_refresh_date NULLS FIRST;
\`\`\`

### Step 4.3: Query DBA_MVIEW_REFRESH_TIMES

\`\`\`sql
-- Refresh history (available from 12c):
SELECT name AS mview_name,
       master_owner,
       master AS master_table,
       TO_CHAR(last_refresh, 'YYYY-MM-DD HH24:MI:SS') AS last_refresh_time
FROM dba_mview_refresh_times
WHERE owner = 'MYAPP'
ORDER BY last_refresh DESC;

-- Find mviews whose refresh is lagging behind others:
SELECT name, last_refresh,
       ROUND(SYSDATE - last_refresh, 3) AS days_since_refresh,
       RANK() OVER (ORDER BY last_refresh) AS staleness_rank
FROM dba_mview_refresh_times
WHERE owner = 'MYAPP';
\`\`\`

### Step 4.4: Segment sizes for mviews and logs

\`\`\`sql
-- All mview and mview log segment sizes in a schema:
SELECT s.segment_name,
       s.segment_type,
       CASE
         WHEN s.segment_name LIKE 'MLOG\$_%' THEN 'MVIEW LOG'
         ELSE 'MVIEW CONTAINER'
       END AS object_role,
       s.tablespace_name,
       ROUND(s.bytes / 1048576, 1) AS size_mb,
       s.blocks,
       s.extents
FROM dba_segments s
WHERE s.owner = 'MYAPP'
  AND (s.segment_name IN (
         SELECT mview_name FROM all_mviews WHERE owner = 'MYAPP'
       )
   OR s.segment_name IN (
         SELECT log_table FROM dba_mview_logs WHERE log_owner = 'MYAPP'
       ))
ORDER BY s.bytes DESC;
\`\`\`

---

## Phase 5: Log Growth Monitoring and Purge

### Step 5.1: Find logs that are growing excessively

\`\`\`sql
-- Logs that are large or have not been purged recently:
SELECT
  ml.log_owner,
  ml.master AS base_table,
  ml.log_table,
  ROUND(seg.bytes / 1048576, 1) AS log_size_mb,
  ml.last_purge_date,
  ROUND(SYSDATE - ml.last_purge_date, 1) AS days_since_purge,
  ml.last_purge_status
FROM dba_mview_logs ml
JOIN dba_segments seg
  ON seg.owner = ml.log_owner
  AND seg.segment_name = ml.log_table
ORDER BY seg.bytes DESC;

-- Identify which mviews depend on each log and when they last refreshed:
SELECT
  ml.log_owner,
  ml.master,
  mv.mview_name,
  mv.last_refresh_date,
  ROUND(SYSDATE - mv.last_refresh_date, 1) AS days_since_mv_refresh,
  mv.staleness
FROM dba_mview_logs ml
JOIN all_mview_detail_relations rel
  ON rel.master_owner = ml.log_owner
  AND rel.master = ml.master
JOIN all_mviews mv
  ON mv.owner = rel.mview_owner
  AND mv.mview_name = rel.mview_name
WHERE ml.log_owner = 'MYAPP'
ORDER BY ml.master, mv.last_refresh_date;
\`\`\`

### Step 5.2: Find transactions blocking log purge

The mview log cannot be purged past the SCN of any active transaction on the base table.

\`\`\`sql
-- Active transactions that have been running long enough to block log purge:
SELECT
  s.sid,
  s.serial#,
  s.username,
  s.status,
  s.program,
  TO_CHAR(TO_DATE(t.start_time, 'MM/DD/YY HH24:MI:SS'), 'YYYY-MM-DD HH24:MI') AS tx_start,
  ROUND((SYSDATE - TO_DATE(t.start_time, 'MM/DD/YY HH24:MI:SS')) * 24 * 60, 1) AS min_active,
  t.used_ublk AS undo_blocks_used,
  t.used_urec AS undo_records_used,
  s.event AS current_wait_event
FROM v\$session s
JOIN v\$transaction t ON s.taddr = t.addr
ORDER BY TO_DATE(t.start_time, 'MM/DD/YY HH24:MI:SS');

-- Current DML activity on mview base tables:
SELECT s.sid, s.serial#, s.username, s.status,
       o.object_name AS locked_object,
       l.lmode, l.request
FROM v\$lock l
JOIN v\$session s ON l.sid = s.sid
JOIN dba_objects o ON l.id1 = o.object_id
WHERE o.owner = 'MYAPP'
  AND o.object_name IN ('ORDERS', 'CUSTOMERS', 'SALES_FACT')
  AND l.type = 'TM';
\`\`\`

### Step 5.3: Manual log purge

\`\`\`sql
-- Purge the log for a specific base table up to the current time.
-- This removes rows that ALL dependent mviews have already processed.
-- If a dependent mview has not refreshed, purge will not remove those rows.

BEGIN
  DBMS_MVIEW.PURGE_LOG(
    master     => 'MYAPP.SALES_FACT',
    num        => 9999999,       -- Max rows to purge in this call
    flag       => 'DELETE'       -- DELETE: remove rows; 'NO DELETE': just report count
  );
END;
/

-- Check log row count after purge:
SELECT COUNT(*) AS remaining_log_rows FROM myapp.mlog\$_sales_fact;
\`\`\`

---

## Phase 6: Alert and Notification Setup

### Step 6.1: Configure UTL_MAIL

\`\`\`sql
-- Set the SMTP outbound server (run as SYSDBA):
ALTER SYSTEM SET smtp_out_server = 'smtp.yourcompany.com:25' SCOPE=BOTH;

-- Grant UTL_MAIL execute to the monitoring user:
GRANT EXECUTE ON utl_mail TO myapp;

-- Test UTL_MAIL is working:
BEGIN
  UTL_MAIL.SEND(
    sender     => 'oracle-dba@yourcompany.com',
    recipients => 'dba-alerts@yourcompany.com',
    subject    => 'UTL_MAIL test from Oracle',
    message    => 'UTL_MAIL is configured correctly.'
  );
END;
/
\`\`\`

### Step 6.2: Create the monitoring table

\`\`\`sql
-- DDL for the mview monitoring log table:
CREATE TABLE myapp.mview_monitor_log (
  log_id           NUMBER GENERATED ALWAYS AS IDENTITY,
  check_time       TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  mview_owner      VARCHAR2(128) NOT NULL,
  mview_name       VARCHAR2(128) NOT NULL,
  staleness        VARCHAR2(30),
  last_refresh_date TIMESTAMP,
  hours_stale      NUMBER(10, 2),
  last_refresh_type VARCHAR2(10),
  log_size_mb      NUMBER(15, 2),
  alert_sent       CHAR(1) DEFAULT 'N',
  alert_message    VARCHAR2(4000),
  CONSTRAINT mview_monitor_log_pk PRIMARY KEY (log_id)
);

CREATE INDEX mview_monitor_log_time_idx
ON myapp.mview_monitor_log (check_time);

CREATE INDEX mview_monitor_log_mv_idx
ON myapp.mview_monitor_log (mview_owner, mview_name, check_time);

COMMENT ON TABLE myapp.mview_monitor_log IS
  'Log of materialized view monitoring checks and alerts sent';
\`\`\`

### Step 6.3: Create the notification procedure

\`\`\`sql
CREATE OR REPLACE PROCEDURE myapp.check_mview_health (
  p_stale_threshold_hours  NUMBER DEFAULT 24,
  p_log_size_threshold_mb  NUMBER DEFAULT 500,
  p_alert_recipients       VARCHAR2 DEFAULT 'dba-alerts@yourcompany.com',
  p_sender                 VARCHAR2 DEFAULT 'oracle-dba@yourcompany.com'
)
AS
  -- Monitoring configuration
  c_schema         CONSTANT VARCHAR2(128) := 'MYAPP';

  -- Counters
  v_stale_count    NUMBER := 0;
  v_log_alert_count NUMBER := 0;
  v_force_complete NUMBER := 0;

  -- Report buffer
  v_report         CLOB;
  v_line           VARCHAR2(4000);
  v_subject        VARCHAR2(200);
  v_has_alerts     BOOLEAN := FALSE;

  PROCEDURE append_line (p_text VARCHAR2) IS
  BEGIN
    v_report := v_report || p_text || CHR(10);
  END;

BEGIN
  -- Initialize report
  DBMS_LOB.CREATETEMPORARY(v_report, TRUE);
  append_line('Oracle Materialized View Health Report');
  append_line('Generated: ' || TO_CHAR(SYSTIMESTAMP, 'YYYY-MM-DD HH24:MI:SS TZR'));
  append_line('Schema: ' || c_schema);
  append_line(RPAD('-', 70, '-'));
  append_line('');

  -- ── Section 1: Stale mviews ──────────────────────────────────────────────
  append_line('[1] STALE MVIEWS (threshold: ' || p_stale_threshold_hours || ' hours)');
  append_line('');

  FOR r IN (
    SELECT mv.mview_name, mv.staleness,
           mv.last_refresh_date,
           mv.last_refresh_type,
           ROUND((SYSDATE - mv.last_refresh_date) * 24, 1) AS hours_stale
    FROM all_mviews mv
    WHERE mv.owner = c_schema
      AND (
        mv.staleness = 'STALE'
        OR (mv.last_refresh_date IS NULL)
        OR ((SYSDATE - mv.last_refresh_date) * 24 > p_stale_threshold_hours)
      )
    ORDER BY mv.last_refresh_date NULLS FIRST
  ) LOOP
    v_stale_count := v_stale_count + 1;
    v_has_alerts := TRUE;

    v_line := '  STALE: ' || r.mview_name
      || ' | last_refresh: '
      || NVL(TO_CHAR(r.last_refresh_date, 'YYYY-MM-DD HH24:MI'), 'NEVER')
      || ' | hours_stale: ' || NVL(TO_CHAR(r.hours_stale), 'N/A')
      || ' | staleness: ' || r.staleness;
    append_line(v_line);

    -- Log to monitoring table
    INSERT INTO myapp.mview_monitor_log (
      mview_owner, mview_name, staleness,
      last_refresh_date, hours_stale, last_refresh_type, alert_sent, alert_message
    ) VALUES (
      c_schema, r.mview_name, r.staleness,
      r.last_refresh_date, r.hours_stale, r.last_refresh_type,
      'Y', v_line
    );
  END LOOP;

  IF v_stale_count = 0 THEN
    append_line('  All mviews are fresh (within threshold).');
  END IF;

  -- ── Section 2: FORCE mviews that ran COMPLETE unexpectedly ───────────────
  append_line('');
  append_line('[2] FORCE MVIEWS WITH UNEXPECTED COMPLETE REFRESH');
  append_line('');

  FOR r IN (
    SELECT mview_name, last_refresh_type, last_refresh_date
    FROM all_mviews
    WHERE owner = c_schema
      AND refresh_method = 'FORCE'
      AND last_refresh_type = 'C'
      AND last_refresh_date > SYSDATE - 1   -- In the last 24 hours
    ORDER BY last_refresh_date DESC
  ) LOOP
    v_force_complete := v_force_complete + 1;
    v_has_alerts := TRUE;
    v_line := '  *** COMPLETE REFRESH: ' || r.mview_name
      || ' at ' || TO_CHAR(r.last_refresh_date, 'YYYY-MM-DD HH24:MI')
      || ' (was expected to be FAST)';
    append_line(v_line);
    INSERT INTO myapp.mview_monitor_log (
      mview_owner, mview_name, last_refresh_date, last_refresh_type,
      alert_sent, alert_message
    ) VALUES (c_schema, r.mview_name, r.last_refresh_date, 'C', 'Y', v_line);
  END LOOP;

  IF v_force_complete = 0 THEN
    append_line('  No unexpected complete refreshes in the last 24 hours.');
  END IF;

  -- ── Section 3: Large mview logs ──────────────────────────────────────────
  append_line('');
  append_line('[3] LARGE MVIEW LOGS (threshold: ' || p_log_size_threshold_mb || ' MB)');
  append_line('');

  FOR r IN (
    SELECT ml.master, ml.log_table,
           ROUND(seg.bytes / 1048576, 1) AS log_size_mb,
           ml.last_purge_date,
           ROUND(SYSDATE - ml.last_purge_date, 1) AS days_since_purge
    FROM dba_mview_logs ml
    JOIN dba_segments seg
      ON seg.owner = ml.log_owner
      AND seg.segment_name = ml.log_table
    WHERE ml.log_owner = c_schema
      AND seg.bytes / 1048576 > p_log_size_threshold_mb
    ORDER BY seg.bytes DESC
  ) LOOP
    v_log_alert_count := v_log_alert_count + 1;
    v_has_alerts := TRUE;
    v_line := '  LOG TOO LARGE: ' || r.log_table
      || ' (' || r.log_size_mb || ' MB for ' || r.master
      || ') | last_purge: '
      || NVL(TO_CHAR(r.last_purge_date, 'YYYY-MM-DD'), 'NEVER')
      || ' | days_since_purge: ' || NVL(TO_CHAR(r.days_since_purge), 'N/A');
    append_line(v_line);
    INSERT INTO myapp.mview_monitor_log (
      mview_owner, mview_name, log_size_mb, alert_sent, alert_message
    ) VALUES (c_schema, r.log_table, r.log_size_mb, 'Y', v_line);
  END LOOP;

  IF v_log_alert_count = 0 THEN
    append_line('  No mview logs exceed the size threshold.');
  END IF;

  COMMIT;

  -- ── Send email if there are alerts ───────────────────────────────────────
  IF v_has_alerts THEN
    v_subject := 'ORACLE MVIEW ALERT: '
      || v_stale_count || ' stale, '
      || v_force_complete || ' unexpected complete, '
      || v_log_alert_count || ' large logs — '
      || SYS_CONTEXT('USERENV', 'DB_NAME');

    UTL_MAIL.SEND(
      sender     => p_sender,
      recipients => p_alert_recipients,
      subject    => v_subject,
      message    => DBMS_LOB.SUBSTR(v_report, 32767, 1)
    );
  END IF;

  DBMS_LOB.FREETEMPORARY(v_report);

EXCEPTION
  WHEN OTHERS THEN
    -- Log the error but do not re-raise (monitoring job should not block)
    INSERT INTO myapp.mview_monitor_log (
      mview_owner, mview_name, alert_sent, alert_message
    ) VALUES ('SYSTEM', 'CHECK_MVIEW_HEALTH', 'N',
      'ERROR: ' || SQLERRM || CHR(10) || DBMS_UTILITY.FORMAT_ERROR_BACKTRACE);
    COMMIT;
    RAISE;
END check_mview_health;
/

-- Verify procedure compiled without errors:
SELECT object_name, object_type, status, last_ddl_time
FROM dba_objects
WHERE owner = 'MYAPP' AND object_name = 'CHECK_MVIEW_HEALTH';
\`\`\`

### Step 6.4: Schedule the monitoring job

\`\`\`sql
-- Create a scheduler job to run the health check every 6 hours:
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'MYAPP_MVIEW_HEALTH_CHECK',
    job_type        => 'PLSQL_BLOCK',
    job_action      => q'[
      BEGIN
        myapp.check_mview_health(
          p_stale_threshold_hours => 24,
          p_log_size_threshold_mb => 500,
          p_alert_recipients      => 'dba-alerts@yourcompany.com',
          p_sender                => 'oracle-alerts@yourcompany.com'
        );
      END;
    ]',
    start_date      => SYSTIMESTAMP,
    repeat_interval => 'FREQ=HOURLY;INTERVAL=6',
    enabled         => TRUE,
    comments        => 'Mview health check with email alerts every 6 hours'
  );
END;
/

-- Confirm:
SELECT job_name, enabled, state, repeat_interval, next_run_date
FROM dba_scheduler_jobs
WHERE job_name = 'MYAPP_MVIEW_HEALTH_CHECK';

-- Run it manually to test:
BEGIN
  DBMS_SCHEDULER.RUN_JOB('MYAPP_MVIEW_HEALTH_CHECK');
END;
/

-- Check results:
SELECT log_id, check_time, mview_name, staleness, hours_stale,
       log_size_mb, alert_sent, SUBSTR(alert_message, 1, 150)
FROM myapp.mview_monitor_log
ORDER BY log_id DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

---

## Phase 7: Query Rewrite Diagnostics

### Step 7.1: Set up the rewrite diagnostics table

\`\`\`sql
-- Create the rewrite output table (Oracle-supplied script):
@\$ORACLE_HOME/rdbms/admin/utlxrw.sql

-- Verify:
SELECT table_name FROM user_tables WHERE table_name = 'REWRITE_TABLE';
\`\`\`

### Step 7.2: Run EXPLAIN_REWRITE

\`\`\`sql
-- Test whether a specific query will rewrite to a specific mview:
DELETE FROM rewrite_table WHERE statement_id = 'SALES_REWRITE_TEST';
COMMIT;

BEGIN
  DBMS_MVIEW.EXPLAIN_REWRITE(
    query        => 'SELECT region, SUM(amount) AS total FROM myapp.sales_fact GROUP BY region',
    mv           => 'MYAPP.SALES_AGG_MV',
    statement_id => 'SALES_REWRITE_TEST'
  );
END;
/

-- Read the output — pay attention to PASS and message:
SELECT sequence AS seq,
       rewrite_id,
       pass,
       mv_owner || '.' || mv_name AS mv_qualified_name,
       SUBSTR(message, 1, 150) AS message
FROM rewrite_table
WHERE statement_id = 'SALES_REWRITE_TEST'
ORDER BY sequence;
\`\`\`

**Interpreting the PASS column:**

| PASS value | Meaning |
|---|---|
| \`QSM\` | Query Suboptimizer Mview — passed to query rewrite phase |
| \`EXP\` | Expansion — the mview was expanded to check text match |
| \`VM\` | View Merging pass |
| \`GEN\` | General analysis pass |
| Empty / no rows | Rewrite was rejected before reaching the mview-specific phase |

### Step 7.3: Check current query rewrite parameter settings

\`\`\`sql
-- System-level settings:
SELECT name, value, description
FROM v\$parameter
WHERE name IN ('query_rewrite_enabled', 'query_rewrite_integrity')
ORDER BY name;

-- Session-level override:
SELECT SYS_CONTEXT('USERENV', 'SESSION_USER') AS current_user FROM dual;
ALTER SESSION SET query_rewrite_enabled = TRUE;
ALTER SESSION SET query_rewrite_integrity = ENFORCED;  -- or TRUSTED or STALE_TOLERATED
\`\`\`

### Step 7.4: Force query rewrite for testing (hint)

\`\`\`sql
-- Force rewrite to a specific mview to test its correctness:
SELECT /*+ REWRITE(myapp.sales_agg_mv) */
       region, SUM(amount) AS total
FROM myapp.sales_fact
GROUP BY region;

-- Check the plan to confirm the mview was used:
EXPLAIN PLAN FOR
SELECT /*+ REWRITE(myapp.sales_agg_mv) */
       region, SUM(amount) AS total
FROM myapp.sales_fact
GROUP BY region;

SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY);
-- Look for: MAT_VIEW REWRITE ACCESS (FULL) SALES_AGG_MV in the plan
\`\`\`

### Step 7.5: Diagnose rewrite failure with TRUSTED integrity

\`\`\`sql
-- If ENFORCED integrity is blocking rewrite on a logically fresh mview:
ALTER SESSION SET query_rewrite_integrity = TRUSTED;

EXPLAIN PLAN FOR
SELECT region, SUM(amount) AS total FROM myapp.sales_fact GROUP BY region;

SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY);

-- Reset:
ALTER SESSION SET query_rewrite_integrity = ENFORCED;
\`\`\`

---

## Phase 8: Troubleshooting Common Failures

### Step 8.1: Diagnose ORA-12034 (mview log younger than mview)

\`\`\`sql
-- ORA-12034: materialized view log on "MYAPP"."ORDERS" younger than last refresh
-- Root cause: the mview log was dropped and recreated after the last mview refresh

-- Identify affected mview/log combinations:
SELECT
  ml.log_owner,
  ml.master,
  ml.log_table,
  ml.log_creation_date,
  mv.mview_name,
  mv.last_refresh_date,
  CASE
    WHEN ml.log_creation_date > mv.last_refresh_date
    THEN '*** LOG NEWER THAN MVIEW — complete refresh required ***'
    ELSE 'ok'
  END AS ora12034_status
FROM dba_mview_logs ml
JOIN all_mview_detail_relations rel
  ON rel.master_owner = ml.log_owner
  AND rel.master = ml.master
JOIN all_mviews mv
  ON mv.owner = rel.mview_owner
  AND mv.mview_name = rel.mview_name
WHERE ml.log_owner = 'MYAPP'
ORDER BY ml.master, mv.mview_name;

-- Resolution: run a complete refresh to re-establish the baseline
BEGIN
  DBMS_MVIEW.REFRESH(
    list   => 'MYAPP.ORDERS_MV',    -- Substitute your mview name
    method => 'C'
  );
END;
/

-- After the complete refresh, future fast refreshes will work again.
-- Verify:
SELECT mview_name, last_refresh_type, last_refresh_date, staleness
FROM all_mviews
WHERE owner = 'MYAPP' AND mview_name = 'ORDERS_MV';
\`\`\`

### Step 8.2: Fast refresh failure analysis

\`\`\`sql
-- Step 1: Run EXPLAIN_MVIEW to find why fast refresh is not possible:
DELETE FROM mv_capabilities_table WHERE statement_id = 'FAIL_ANALYSIS';
COMMIT;

BEGIN
  DBMS_MVIEW.EXPLAIN_MVIEW(
    mv      => 'MYAPP.ORDERS_MV',   -- Substitute failing mview
    stmt_id => 'FAIL_ANALYSIS'
  );
END;
/

SELECT seq, capability_name, possible, SUBSTR(msgtxt, 1, 200) AS message
FROM mv_capabilities_table
WHERE statement_id = 'FAIL_ANALYSIS'
  AND (possible = 'N' OR capability_name LIKE 'REFRESH_FAST%')
ORDER BY seq;

-- Step 2: Check whether all required mview logs exist with correct options:
SELECT ml.master, ml.log_table,
       ml.rowids, ml.primary_key, ml.sequence, ml.include_new_values,
       ml.log_creation_date
FROM dba_mview_logs ml
WHERE ml.log_owner = 'MYAPP'
  AND ml.master IN (
    SELECT master FROM all_mview_detail_relations
    WHERE mview_owner = 'MYAPP' AND mview_name = 'ORDERS_MV'
  );

-- Step 3: Compare log creation date vs mview last refresh:
SELECT ml.master, ml.log_creation_date,
       mv.last_refresh_date,
       CASE WHEN ml.log_creation_date > mv.last_refresh_date
            THEN 'ORA-12034 condition'
            ELSE 'ok'
       END AS log_age_check
FROM dba_mview_logs ml
JOIN all_mviews mv ON mv.owner = ml.log_owner
WHERE ml.log_owner = 'MYAPP'
  AND mv.mview_name = 'ORDERS_MV';
\`\`\`

### Step 8.3: Find transactions blocking log purge

\`\`\`sql
-- Long-running transactions that are preventing mview log purge:
SELECT
  s.sid,
  s.serial#,
  s.username,
  s.osuser,
  s.machine,
  s.program,
  s.status,
  TO_CHAR(TO_DATE(t.start_time, 'MM/DD/YY HH24:MI:SS'),
          'YYYY-MM-DD HH24:MI') AS tx_start_time,
  ROUND((SYSDATE - TO_DATE(t.start_time, 'MM/DD/YY HH24:MI:SS')) * 60 * 24, 0)
    AS tx_duration_minutes,
  t.used_ublk AS undo_blocks,
  t.used_urec AS undo_records,
  t.xidusn || '.' || t.xidslot || '.' || t.xidsqn AS xid,
  s.event AS current_wait_event,
  SUBSTR(sq.sql_text, 1, 100) AS current_sql
FROM v\$session s
JOIN v\$transaction t ON s.taddr = t.addr
LEFT JOIN v\$sql sq ON s.sql_id = sq.sql_id
ORDER BY TO_DATE(t.start_time, 'MM/DD/YY HH24:MI:SS');

-- To investigate a specific SID further:
-- SELECT * FROM v\$session WHERE sid = <sid>;
-- SELECT sql_text FROM v\$sql WHERE sql_id = '<sql_id>';
\`\`\`

### Step 8.4: Check mview compilation errors

\`\`\`sql
-- Mviews with NEEDS_COMPILE or INVALID state:
SELECT mv.owner, mv.mview_name, mv.compile_state, mv.staleness,
       mv.last_refresh_date
FROM all_mviews mv
WHERE mv.owner NOT IN ('SYS', 'SYSTEM')
  AND mv.compile_state != 'VALID'
ORDER BY mv.owner, mv.mview_name;

-- Check DBA_ERRORS for MATERIALIZED VIEW compilation errors:
SELECT owner, name, type, sequence, line, position,
       text AS error_text
FROM dba_errors
WHERE type = 'MATERIALIZED VIEW'
  AND owner = 'MYAPP'
ORDER BY name, sequence;

-- Recompile an invalid mview:
ALTER MATERIALIZED VIEW myapp.orders_mv COMPILE;

-- If compile fails, check dba_errors again for the new error:
SELECT name, sequence, line, text
FROM dba_errors
WHERE type = 'MATERIALIZED VIEW'
  AND name = 'ORDERS_MV'
  AND owner = 'MYAPP';
\`\`\`

### Step 8.5: Verify FORCE refresh is not silently doing COMPLETE

\`\`\`sql
-- Compare expected vs actual refresh type for all FORCE-method mviews:
SELECT
  mview_name,
  refresh_method,
  last_refresh_type,
  last_refresh_date,
  CASE
    WHEN refresh_method = 'FORCE' AND last_refresh_type = 'C'
    THEN '*** UNEXPECTED COMPLETE — investigate fast refresh failure ***'
    WHEN last_refresh_type = 'F'
    THEN 'fast (expected)'
    ELSE last_refresh_type
  END AS assessment
FROM all_mviews
WHERE owner = 'MYAPP'
  AND refresh_method IN ('FORCE', 'FAST')
ORDER BY last_refresh_date DESC;
\`\`\`

---

## Quick Reference: Key Commands

\`\`\`sql
-- ── Capability analysis ────────────────────────────────────────────────────
-- Check mview query capabilities before creation:
EXEC DBMS_MVIEW.EXPLAIN_MVIEW(mv => '<query or mview_name>', stmt_id => 'TEST');
SELECT capability_name, possible, msgtxt FROM mv_capabilities_table
WHERE statement_id = 'TEST' ORDER BY seq;

-- ── Log management ─────────────────────────────────────────────────────────
-- Create log:
CREATE MATERIALIZED VIEW LOG ON <table>
  WITH PRIMARY KEY, ROWID, SEQUENCE (<col1>, <col2>)
  INCLUDING NEW VALUES;

-- Drop log (causes ORA-12034 on dependent mviews until they complete refresh):
DROP MATERIALIZED VIEW LOG ON <schema>.<table>;

-- Manual purge:
EXEC DBMS_MVIEW.PURGE_LOG(master => '<schema>.<table>', num => 9999999, flag => 'DELETE');

-- ── Refresh ────────────────────────────────────────────────────────────────
-- Single mview fast:
EXEC DBMS_MVIEW.REFRESH(list => '<owner>.<mview>', method => 'F');

-- Single mview complete:
EXEC DBMS_MVIEW.REFRESH(list => '<owner>.<mview>', method => 'C');

-- Complete out-of-place (12.2+, no lock on readers):
EXEC DBMS_MVIEW.REFRESH(list => '<owner>.<mview>', method => 'C', out_of_place => TRUE);

-- All mviews in schema:
DECLARE v_fail NUMBER;
BEGIN DBMS_MVIEW.REFRESH_ALL_MVIEWS(v_fail, 'F', FALSE); END;
/

-- ── Status queries ─────────────────────────────────────────────────────────
-- Staleness:
SELECT mview_name, staleness, last_refresh_type, last_refresh_date
FROM all_mviews WHERE owner = 'MYAPP';

-- Log sizes:
SELECT ml.master, ml.log_table, ROUND(s.bytes/1048576,1) AS mb,
       ml.last_purge_date
FROM dba_mview_logs ml JOIN dba_segments s
  ON s.owner = ml.log_owner AND s.segment_name = ml.log_table
WHERE ml.log_owner = 'MYAPP';

-- ── Query rewrite ──────────────────────────────────────────────────────────
-- Diagnose rewrite failure:
EXEC DBMS_MVIEW.EXPLAIN_REWRITE(query => '<sql>', mv => '<owner>.<mview>', statement_id => 'T');
SELECT sequence, pass, mv_name, SUBSTR(message,1,150) FROM rewrite_table
WHERE statement_id = 'T' ORDER BY sequence;

-- Force rewrite hint for testing:
SELECT /*+ REWRITE(<owner>.<mview>) */ ... FROM <base_table> ...;

-- ── Compilation ────────────────────────────────────────────────────────────
ALTER MATERIALIZED VIEW <owner>.<mview> COMPILE;

SELECT name, text FROM dba_errors
WHERE type = 'MATERIALIZED VIEW' AND owner = '<owner>';
\`\`\``,
};

async function main() {
  console.log('Inserting mview runbook post...');
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
