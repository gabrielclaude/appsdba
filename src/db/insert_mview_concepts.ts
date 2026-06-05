import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Materialized Views: Concepts, Refresh Mechanics, and Common Problems',
  slug: 'oracle-mview-concepts-refresh-mechanics',
  excerpt:
    'A deep-dive into Oracle materialized views — what they are, how BUILD IMMEDIATE vs BUILD DEFERRED works, every refresh type (COMPLETE, FAST, FORCE, NEVER) and mode (ON DEMAND, ON COMMIT, ON STATEMENT, scheduled), materialized view logs, query rewrite mechanics, staleness states, Partition Change Tracking, out-of-place refresh, and a thorough guide to diagnosing the most common problems including fast refresh failures, log bloat, ORA-12034, and silent COMPLETE refreshes in production.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-05'),
  youtubeUrl: null,
  content: `A materialized view is one of those Oracle features that looks simple at first — it pre-computes a query and stores the result — but the details of refresh mechanics, log management, and query rewrite have enough edge cases to cause real production incidents. This post covers the entire feature in depth.

---

## 1. What Is a Materialized View?

A materialized view (mview) is a database object that stores the result of a query as a physical segment on disk. Unlike a regular view, which is just a stored query that Oracle re-executes every time you reference it, a materialized view holds the actual data rows.

**Regular view:**
\`\`\`sql
-- A view stores only the query definition. Every reference re-runs the full join.
CREATE VIEW order_summary_v AS
SELECT c.customer_id, c.customer_name,
       SUM(o.order_amount) AS total_ordered,
       COUNT(o.order_id)   AS order_count
FROM customers c
JOIN orders o ON c.customer_id = o.customer_id
GROUP BY c.customer_id, c.customer_name;

-- This executes the join and aggregation every single time:
SELECT * FROM order_summary_v WHERE total_ordered > 50000;
\`\`\`

**Materialized view:**
\`\`\`sql
-- An mview stores the result. Queries hit stored rows, not the base tables.
CREATE MATERIALIZED VIEW order_summary_mv
BUILD IMMEDIATE
REFRESH COMPLETE ON DEMAND
ENABLE QUERY REWRITE
AS
SELECT c.customer_id, c.customer_name,
       SUM(o.order_amount) AS total_ordered,
       COUNT(o.order_id)   AS order_count
FROM customers c
JOIN orders o ON c.customer_id = o.customer_id
GROUP BY c.customer_id, c.customer_name;

-- This reads from the mview segment — the join already happened at refresh time:
SELECT * FROM order_summary_mv WHERE total_ordered > 50000;
\`\`\`

The trade-off: the mview data is only as current as the last refresh. The application designer decides whether slightly stale aggregate data is acceptable in exchange for dramatically faster query execution.

### Physical segment

Oracle creates a table segment with the same name as the mview. You can query it directly like any table. It has its own statistics, indexes, and can be partitioned independently.

\`\`\`sql
-- The underlying table segment is visible in DBA_SEGMENTS
SELECT segment_name, segment_type, bytes/1048576 AS size_mb
FROM dba_segments
WHERE segment_name = 'ORDER_SUMMARY_MV'
  AND owner = 'MYAPP';

-- You can add indexes to an mview just like a table
CREATE INDEX order_summary_mv_cust_idx
ON order_summary_mv (customer_id);

-- Check mview metadata
SELECT mview_name, container_name, query, refresh_method, refresh_mode,
       last_refresh_type, last_refresh_date, staleness, compile_state
FROM all_mviews
WHERE owner = 'MYAPP';
\`\`\`

### Use cases

| Use case | Why mview helps |
|---|---|
| Pre-computed aggregates (SUM, COUNT, AVG) | Aggregation runs once at refresh, not at every query |
| Expensive joins across large tables | Join executes at refresh time; queries hit the stored result |
| Summary tables for reporting | Refresh nightly; OLTP tables unaffected during business hours |
| Remote data replication | Mview at the reporting site can replicate a table from a production site |
| Query rewrite acceleration | Optimizer transparently rewrites queries to use the mview |

---

## 2. Build Options: BUILD IMMEDIATE vs BUILD DEFERRED

### BUILD IMMEDIATE

Oracle populates the mview immediately when the CREATE statement executes. This is the default.

\`\`\`sql
-- Mview is populated at creation time.
-- If the base tables are large this can take minutes or hours.
CREATE MATERIALIZED VIEW sales_summary_mv
BUILD IMMEDIATE
REFRESH COMPLETE ON DEMAND
AS
SELECT region, product_id, SUM(amount) AS total_sales
FROM sales_fact
GROUP BY region, product_id;
\`\`\`

### BUILD DEFERRED

Oracle creates the metadata and the empty container segment, but does not execute the query. The mview starts in UNKNOWN staleness state and is not usable for query rewrite until the first explicit refresh.

\`\`\`sql
-- Create the empty mview structure without populating data.
-- Useful when the base tables are being loaded and you want to avoid contention.
CREATE MATERIALIZED VIEW sales_summary_mv
BUILD DEFERRED
REFRESH COMPLETE ON DEMAND
AS
SELECT region, product_id, SUM(amount) AS total_sales
FROM sales_fact
GROUP BY region, product_id;

-- Check that it is empty and in UNKNOWN state:
SELECT mview_name, staleness, last_refresh_date
FROM all_mviews WHERE mview_name = 'SALES_SUMMARY_MV';
-- STALENESS = UNKNOWN, LAST_REFRESH_DATE = null

-- Populate it when ready (e.g., after the bulk load window):
BEGIN
  DBMS_MVIEW.REFRESH(
    list   => 'MYAPP.SALES_SUMMARY_MV',
    method => 'C'   -- C = COMPLETE
  );
END;
/
\`\`\`

**When to use BUILD DEFERRED:**
- Base tables are being loaded during the maintenance window and you do not want the mview creation to block or compete with the load.
- You are creating many mviews in a script and want to defer all initial population to a single scheduled refresh window.
- Very large base tables where initial population would exceed the available maintenance window.

---

## 3. Refresh Types in Detail

### COMPLETE Refresh

Oracle truncates the mview container table and reinserts all rows by re-executing the defining query from scratch. It is always correct and always works, but it is the most expensive option.

\`\`\`sql
CREATE MATERIALIZED VIEW orders_mv
REFRESH COMPLETE ON DEMAND
AS
SELECT order_id, customer_id, order_date, order_amount, status
FROM orders;

-- Trigger a complete refresh manually:
BEGIN
  DBMS_MVIEW.REFRESH(
    list   => 'MYAPP.ORDERS_MV',
    method => 'C'
  );
END;
/
\`\`\`

**Cost:** Every complete refresh generates undo for the truncate, redo for the reinsert, and holds an exclusive lock on the container table for the duration. On a 500M-row fact table, a complete refresh may take 30 minutes and generate gigabytes of redo.

### FAST Refresh

Oracle applies only the changes since the last refresh by reading from a materialized view log on the base table. This is the efficient option — only changed rows are processed.

\`\`\`sql
-- Step 1: Create a mview log on the base table (prerequisite for FAST refresh)
CREATE MATERIALIZED VIEW LOG ON orders
WITH PRIMARY KEY, ROWID, SEQUENCE
INCLUDING NEW VALUES;

-- Step 2: Create the mview with FAST refresh
CREATE MATERIALIZED VIEW orders_mv
REFRESH FAST ON DEMAND
AS
SELECT order_id, customer_id, order_date, order_amount, status
FROM orders;

-- Trigger a fast refresh:
BEGIN
  DBMS_MVIEW.REFRESH(
    list   => 'MYAPP.ORDERS_MV',
    method => 'F'
  );
END;
/
\`\`\`

**Fast refresh prerequisites — this is where most failures originate:**

1. A materialized view log must exist on every base table referenced in the query.
2. The mview log must include the columns referenced in the query (or must use ROWID).
3. The mview log must have been created *before* the mview — if the log is newer than the mview, Oracle cannot fast refresh (ORA-12034).

**Query restrictions for FAST refresh:**

Fast refresh supports a limited subset of SQL. Oracle must be able to efficiently compute the delta. Restrictions include:

\`\`\`sql
-- These query patterns DO support fast refresh:
-- Simple projection (no aggregation):
SELECT order_id, customer_id, order_amount FROM orders;

-- Equi-join (both tables need mview logs):
SELECT o.order_id, o.customer_id, c.customer_name, o.order_amount
FROM orders o JOIN customers c ON o.customer_id = c.customer_id;

-- Aggregate with COUNT(*) (required alongside SUM for correct delta):
SELECT customer_id, SUM(order_amount) AS total, COUNT(*) AS cnt
FROM orders
GROUP BY customer_id;

-- These patterns do NOT support fast refresh:
-- UNION / UNION ALL / INTERSECT / MINUS
-- Subqueries in the SELECT list
-- CONNECT BY (hierarchical queries)
-- Aggregates without COUNT(*) alongside SUM (Oracle needs COUNT to recompute average correctly)
-- Outer joins without specific additional log configuration
-- DISTINCT (in most cases)
\`\`\`

**Mview log options and what they enable:**

\`\`\`sql
-- ROWID — log the physical rowid of changed rows
-- Best for simple projection mviews (no joins)
CREATE MATERIALIZED VIEW LOG ON orders WITH ROWID;

-- PRIMARY KEY — log the primary key values of changed rows
-- Required for mviews that join on the primary key
CREATE MATERIALIZED VIEW LOG ON orders WITH PRIMARY KEY;

-- SEQUENCE — adds a sequence number to log rows to preserve DML ordering
-- Required when multiple DML operations affect the same row between refreshes
CREATE MATERIALIZED VIEW LOG ON orders WITH PRIMARY KEY, SEQUENCE;

-- INCLUDING NEW VALUES — log both old and new column values
-- Required for aggregate fast refresh (to correctly compute sum deltas)
CREATE MATERIALIZED VIEW LOG ON orders
WITH PRIMARY KEY, ROWID, SEQUENCE
INCLUDING NEW VALUES;

-- Log specific columns (needed when the mview references only certain columns)
CREATE MATERIALIZED VIEW LOG ON orders
WITH PRIMARY KEY, ROWID, SEQUENCE
(order_amount, status, customer_id)
INCLUDING NEW VALUES;
\`\`\`

**Check what capabilities a query has for fast refresh before creating the mview:**

\`\`\`sql
-- Use EXPLAIN_MVIEW to determine refresh capabilities before creating the mview
-- First create the capability table if it doesn't exist:
BEGIN
  DBMS_MVIEW.EXPLAIN_MVIEW(
    mv          => 'SELECT o.order_id, o.customer_id, c.customer_name, o.order_amount
                    FROM orders o JOIN customers c ON o.customer_id = c.customer_id',
    stmt_id     => 'TEST_JOIN_MV'
  );
END;
/

-- Read the results:
SELECT capability_name, possible, msgtxt
FROM mv_capabilities_table
WHERE statement_id = 'TEST_JOIN_MV'
ORDER BY seq;
\`\`\`

### FORCE Refresh

Oracle tries a FAST refresh first. If the fast refresh is not possible (prerequisites not met, or the mview log has been invalidated), it silently falls back to a COMPLETE refresh.

\`\`\`sql
CREATE MATERIALIZED VIEW orders_mv
REFRESH FORCE ON DEMAND
AS
SELECT order_id, customer_id, order_date, order_amount, status
FROM orders;
\`\`\`

**The danger of FORCE in production:** If the mview log is dropped and recreated, or if a DDL change invalidates fast refresh capability, the next FORCE refresh becomes a complete refresh. On a large mview, this means gigabytes of unexpected redo generation and a long lock on the container table — during what the scheduler thought was a quick incremental refresh. Always monitor \`last_refresh_type\` in \`ALL_MVIEWS\` to detect when FORCE falls back to COMPLETE.

\`\`\`sql
-- Check whether the last refresh was fast (I = incremental) or complete (C):
SELECT mview_name, last_refresh_type, last_refresh_date, staleness
FROM all_mviews
WHERE owner = 'MYAPP'
ORDER BY last_refresh_date DESC;
-- last_refresh_type = 'C' means complete; 'F' means fast
\`\`\`

### NEVER Refresh

The mview is a snapshot — it is populated at creation time (if BUILD IMMEDIATE) and never refreshed automatically. Useful for point-in-time snapshots.

\`\`\`sql
CREATE MATERIALIZED VIEW orders_snapshot_20260601
BUILD IMMEDIATE
REFRESH NEVER
AS
SELECT * FROM orders WHERE order_date < DATE '2026-06-01';
\`\`\`

---

## 4. Refresh Modes

### ON DEMAND

The mview is refreshed only when you explicitly call \`DBMS_MVIEW.REFRESH\` or schedule it. This is the safest and most common mode for large mviews.

\`\`\`sql
-- Manual refresh on demand
BEGIN
  DBMS_MVIEW.REFRESH(
    list             => 'MYAPP.ORDERS_MV,MYAPP.CUSTOMERS_MV',
    method           => 'F',           -- F=fast, C=complete, ? or '' = force
    atomic_refresh   => FALSE,         -- FALSE = truncate/insert; TRUE = delete/insert (slower but avoids brief empty state)
    out_of_place     => FALSE
  );
END;
/
\`\`\`

### ON COMMIT

The mview is refreshed automatically after every COMMIT on the base table. The refresh runs synchronously within the committing transaction — the COMMIT does not return until the mview refresh completes.

\`\`\`sql
-- ON COMMIT mview: refreshed after every commit to the base table
CREATE MATERIALIZED VIEW orders_mv
REFRESH FAST ON COMMIT
AS
SELECT order_id, customer_id, order_date, order_amount, status
FROM orders;
\`\`\`

**Hazards of ON COMMIT:**
- Every COMMIT on the base table now takes longer. For a high-frequency OLTP table with thousands of commits per second, this causes severe latency spikes.
- The refresh runs inside the committing session's transaction — if the refresh fails, the COMMIT fails.
- Locking: the mview container is locked during the refresh portion of the commit. This serializes all writers who share that base table.
- ON COMMIT requires FAST refresh capability. COMPLETE refresh ON COMMIT is not allowed (would make every commit take as long as a full table scan).

**Appropriate use:** Small lookup tables that change infrequently and where the mview consumers need immediate consistency.

### ON STATEMENT (12c+)

Introduced in Oracle 12.2. The mview is refreshed after every DML *statement* on the base table, before the transaction commits.

\`\`\`sql
-- ON STATEMENT refresh (12.2+) — stricter than ON COMMIT
CREATE MATERIALIZED VIEW orders_mv
REFRESH FAST ON STATEMENT
AS
SELECT order_id, customer_id, order_date, order_amount, status
FROM orders;
\`\`\`

This is even more restrictive than ON COMMIT in terms of transaction cost. It is intended for very specific cases where data consumers require sub-transaction freshness.

### Scheduled Refresh via DBMS_SCHEDULER

The recommended approach for most production environments: refresh on a schedule during low-activity windows.

\`\`\`sql
-- Create a scheduler job to refresh a group of mviews nightly
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'REFRESH_SALES_MVIEWS',
    job_type        => 'PLSQL_BLOCK',
    job_action      => q'[
      BEGIN
        DBMS_MVIEW.REFRESH(
          list           => 'MYAPP.SALES_SUMMARY_MV,MYAPP.ORDERS_MV',
          method         => 'F',
          atomic_refresh => FALSE
        );
      END;
    ]',
    start_date      => SYSTIMESTAMP,
    repeat_interval => 'FREQ=DAILY;BYHOUR=2;BYMINUTE=0',
    enabled         => TRUE,
    comments        => 'Nightly fast refresh of sales mviews'
  );
END;
/

-- Check the job status after runs
SELECT job_name, last_start_date, last_run_duration, run_count, failure_count, status
FROM dba_scheduler_job_run_details
WHERE job_name = 'REFRESH_SALES_MVIEWS'
ORDER BY log_date DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

---

## 5. Materialized View Logs

The mview log is a system-managed table that tracks changes (INSERT, UPDATE, DELETE) to the base table since the last mview refresh. It is the data source for FAST refresh.

\`\`\`sql
-- Create a complete mview log suitable for aggregate fast refresh:
CREATE MATERIALIZED VIEW LOG ON sales_fact
WITH PRIMARY KEY, ROWID, SEQUENCE (region, product_id, amount)
INCLUDING NEW VALUES;

-- The log table name follows the pattern: MLOG$_<table_name>
SELECT log_table, log_trigger, rowids, primary_key, object_id,
       filter_columns, sequence, include_new_values
FROM dba_mview_logs
WHERE master = 'SALES_FACT'
  AND log_owner = 'MYAPP';

-- See the actual log table structure:
SELECT column_name, data_type
FROM dba_tab_columns
WHERE table_name = 'MLOG\$_SALES_FACT'
  AND owner = 'MYAPP'
ORDER BY column_id;
\`\`\`

### ROWID vs PRIMARY KEY

| Option | How it works | When to use |
|---|---|---|
| ROWID | Logs the physical rowid of changed rows | Simple projection mviews without joins; fastest log processing |
| PRIMARY KEY | Logs primary key column values | Join mviews; portable across row movement operations; required when mview uses PK columns for join |
| OBJECT ID | For object tables | Rarely used |

You can specify both ROWID and PRIMARY KEY. Specify the minimum required by your mviews to keep the log compact.

### SEQUENCE option

Adding SEQUENCE adds an ordering column to the log. This is required when a row might be inserted, updated, and deleted multiple times between refreshes. Without SEQUENCE, Oracle cannot correctly replay the delta in order.

\`\`\`sql
-- Without SEQUENCE: two updates to the same row both land in the log
-- Oracle may not know the correct ordering when applying the delta
-- With SEQUENCE: each DML operation gets a sequence number
CREATE MATERIALIZED VIEW LOG ON orders
WITH PRIMARY KEY, ROWID, SEQUENCE
INCLUDING NEW VALUES;
\`\`\`

### INCLUDING NEW VALUES

For aggregate fast refresh, Oracle must log both the before-image and after-image of changed rows. A row that changes from amount=100 to amount=150 must update the aggregate sum by +50. Without INCLUDING NEW VALUES, Oracle cannot compute that delta correctly for SUM and similar aggregates.

\`\`\`sql
-- Aggregate mview requires INCLUDING NEW VALUES on the base table log:
CREATE MATERIALIZED VIEW LOG ON sales_fact
WITH PRIMARY KEY, SEQUENCE (amount, region, product_id)
INCLUDING NEW VALUES;

CREATE MATERIALIZED VIEW sales_agg_mv
REFRESH FAST ON DEMAND
ENABLE QUERY REWRITE
AS
SELECT region, product_id,
       SUM(amount) AS total_amount,
       COUNT(*)    AS row_count
FROM sales_fact
GROUP BY region, product_id;
\`\`\`

**Note:** COUNT(*) in the aggregate mview is not just a convenience — it is a technical requirement. Oracle uses the count to correctly apply the delta when rows are deleted from the base table. Without COUNT(*), the mview cannot fast refresh aggregates.

### Log purge and space growth

The mview log is purged automatically after all mviews that depend on it have successfully refreshed. If even one dependent mview has not refreshed, the log continues to grow.

\`\`\`sql
-- Check mview log sizes — which logs are growing?
SELECT ml.log_owner, ml.master, ml.log_table,
       s.bytes / 1048576 AS log_size_mb,
       ml.last_purge_date,
       ml.last_purge_status
FROM dba_mview_logs ml
JOIN dba_segments s ON s.owner = ml.log_owner
                   AND s.segment_name = ml.log_table
ORDER BY s.bytes DESC;

-- How many rows are in each log (unprocessed changes)?
SELECT 'MLOG\$_SALES_FACT' AS log_table, COUNT(*) AS pending_rows
FROM myapp.mlog\$_sales_fact;

-- Which mviews depend on a specific base table log?
SELECT mview_name, owner, last_refresh_date, staleness
FROM all_mviews
WHERE owner = 'MYAPP'
  AND mview_name IN (
    SELECT mview_name FROM all_mview_detail_relations
    WHERE master_owner = 'MYAPP' AND master = 'SALES_FACT'
  );
\`\`\`

If a long-running transaction is actively modifying the base table, the log cannot be purged for those rows until the transaction commits. Monitor \`V\$TRANSACTION\` and \`DBA_MVIEW_LOGS.LAST_PURGE_DATE\` to detect this condition.

---

## 6. Query Rewrite

Query rewrite allows Oracle to transparently rewrite a user query against base tables to instead read from a materialized view. The user does not need to know the mview exists.

\`\`\`sql
-- Enable query rewrite on the mview:
CREATE MATERIALIZED VIEW sales_agg_mv
REFRESH FAST ON DEMAND
ENABLE QUERY REWRITE
AS
SELECT region, product_id,
       SUM(amount) AS total_amount,
       COUNT(*)    AS row_count
FROM sales_fact
GROUP BY region, product_id;

-- Set session/system parameter to allow query rewrite:
ALTER SESSION SET query_rewrite_enabled = TRUE;
ALTER SYSTEM SET query_rewrite_enabled = TRUE SCOPE=BOTH;

-- With QUERY_REWRITE_INTEGRITY:
-- ENFORCED (default): only rewrite if Oracle can prove the mview is fresh
-- TRUSTED: trust dimension relationships; rewrite even if not provably fresh
-- STALE_TOLERATED: rewrite even if the mview is stale (for reporting where stale is acceptable)
ALTER SESSION SET query_rewrite_integrity = ENFORCED;
\`\`\`

### How to verify query rewrite is firing

\`\`\`sql
-- Check the execution plan — look for MAT_VIEW REWRITE ACCESS
EXPLAIN PLAN FOR
SELECT region, SUM(amount) AS total
FROM sales_fact
GROUP BY region;

SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY);
-- If rewrite fires, you will see: MAT_VIEW REWRITE ACCESS (FULL) SALES_AGG_MV

-- Use DBMS_MVIEW.EXPLAIN_REWRITE for detailed diagnostics:
-- First create the rewrite table if it does not exist:
-- @\$ORACLE_HOME/rdbms/admin/utlxrw.sql

BEGIN
  DBMS_MVIEW.EXPLAIN_REWRITE(
    query    => 'SELECT region, SUM(amount) AS total FROM sales_fact GROUP BY region',
    mv       => 'MYAPP.SALES_AGG_MV',
    statement_id => 'REWRITE_TEST'
  );
END;
/

SELECT message, pass, mv_owner, mv_name
FROM rewrite_table
WHERE statement_id = 'REWRITE_TEST'
ORDER BY sequence;
\`\`\`

### Common reasons query rewrite fails silently

1. **Mview is STALE** — with ENFORCED integrity, Oracle will not rewrite to a stale mview. Refresh the mview first.
2. **QUERY_REWRITE_ENABLED = FALSE** at session or system level.
3. **QUERY_REWRITE_INTEGRITY = ENFORCED** but the mview has no reliable freshness proof (dimensions missing).
4. **Stale optimizer statistics on the mview** — Oracle does not automatically gather statistics after a refresh. If the mview statistics are old or missing, the optimizer may choose not to use it even when rewrite would fire.
5. **Missing dimension objects** — some rewrite scenarios require DIMENSION objects to be defined, connecting the base table to dimension hierarchies.
6. **The query includes columns not in the mview** — rewrite can only substitute the mview if all needed columns are present in it.

\`\`\`sql
-- Check whether statistics have been gathered on the mview:
SELECT table_name, num_rows, last_analyzed, stale_stats
FROM dba_tab_statistics
WHERE table_name = 'SALES_AGG_MV'
  AND owner = 'MYAPP';

-- Gather statistics manually after refresh:
BEGIN
  DBMS_STATS.GATHER_TABLE_STATS(
    ownname => 'MYAPP',
    tabname => 'SALES_AGG_MV',
    estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,
    degree => 4
  );
END;
/

-- Force query rewrite in a query (bypasses integrity check for testing):
SELECT /*+ REWRITE(sales_agg_mv) */
       region, SUM(amount) AS total
FROM sales_fact
GROUP BY region;
\`\`\`

---

## 7. Staleness States

Oracle tracks whether the mview data matches the base table data through the STALENESS column in \`ALL_MVIEWS\`.

\`\`\`sql
-- Check all mview staleness states:
SELECT mview_name, staleness, last_refresh_type, last_refresh_date,
       compile_state, refresh_method, refresh_mode
FROM all_mviews
WHERE owner = 'MYAPP'
ORDER BY last_refresh_date DESC;
\`\`\`

| State | Meaning |
|---|---|
| \`FRESH\` | Mview data matches base tables as of the last refresh; query rewrite will fire with ENFORCED integrity |
| \`STALE\` | Base table DML has occurred since last refresh; mview is out of date |
| \`UNKNOWN\` | Oracle cannot determine staleness — typically means no mview log exists or mview was BUILD DEFERRED and never refreshed |
| \`NEEDS_COMPILE\` | The mview definition references an object that has been modified (DDL on base table) and the mview needs to be recompiled/revalidated |

### What triggers each state

- **STALE:** Any DML (INSERT, UPDATE, DELETE) committed to a base table after the last mview refresh.
- **UNKNOWN:** CREATE MATERIALIZED VIEW with BUILD DEFERRED before first refresh; base table has no mview log (Oracle cannot track changes).
- **NEEDS_COMPILE:** A column referenced in the mview query was added/dropped/renamed on a base table; the base table was dropped and recreated; a synonym used in the query was changed.

\`\`\`sql
-- Recompile a NEEDS_COMPILE mview:
ALTER MATERIALIZED VIEW sales_agg_mv COMPILE;

-- Force mview to FRESH state after manual data load (use with caution):
EXECUTE DBMS_MVIEW.I_AM_A_FRESH_MV('MYAPP.SALES_AGG_MV');
-- WARNING: Use only if you are certain the mview data matches base tables.
-- This bypasses Oracle's staleness tracking and can cause incorrect query rewrite.
\`\`\`

---

## 8. Partition Change Tracking (PCT) Fast Refresh

PCT enables fast refresh for mviews whose base tables are partitioned, even for query patterns that would not normally support FAST refresh. Oracle can identify which partitions were modified and refresh only the corresponding portion of the mview.

\`\`\`sql
-- PCT works when:
-- 1. The base table is partitioned
-- 2. The mview partition key maps directly to the base table partition key
-- 3. No partition key rows were moved (no partition maintenance that moved data)

-- Example: partitioned base table
CREATE TABLE sales_fact (
  sale_date   DATE,
  region      VARCHAR2(50),
  product_id  NUMBER,
  amount      NUMBER
)
PARTITION BY RANGE (sale_date) (
  PARTITION p_2026_q1 VALUES LESS THAN (DATE '2026-04-01'),
  PARTITION p_2026_q2 VALUES LESS THAN (DATE '2026-07-01'),
  PARTITION p_2026_q3 VALUES LESS THAN (DATE '2026-10-01'),
  PARTITION p_2026_q4 VALUES LESS THAN (DATE '2027-01-01')
);

-- PCT-eligible mview: partition key (sale_date) must appear in the mview
-- No mview log is required on the base table for PCT!
CREATE MATERIALIZED VIEW sales_pct_mv
BUILD IMMEDIATE
REFRESH FAST ON DEMAND
ENABLE QUERY REWRITE
AS
SELECT sale_date, region, product_id,
       SUM(amount) AS total_amount,
       COUNT(*)    AS row_count
FROM sales_fact
GROUP BY sale_date, region, product_id;

-- Check PCT eligibility:
BEGIN
  DBMS_MVIEW.EXPLAIN_MVIEW(
    mv      => 'MYAPP.SALES_PCT_MV',
    stmt_id => 'PCT_CHECK'
  );
END;
/

SELECT capability_name, possible, msgtxt
FROM mv_capabilities_table
WHERE statement_id = 'PCT_CHECK'
  AND capability_name LIKE 'PCT%';
\`\`\`

When only one partition of \`sales_fact\` is loaded (e.g., the current quarter), a PCT fast refresh processes only the changed partition rows rather than re-aggregating the entire fact table. On large data warehouses this reduces refresh time from hours to minutes.

---

## 9. Out-of-Place Refresh (12.2+)

Out-of-place refresh addresses a key limitation of regular refresh: during a COMPLETE refresh, the mview container is locked (or briefly empty with non-atomic refresh), blocking readers. Out-of-place refresh builds a completely new segment in the background and then atomically swaps it with the current one, minimizing lock time.

\`\`\`sql
-- Out-of-place refresh: Oracle builds a new segment, then swaps
BEGIN
  DBMS_MVIEW.REFRESH(
    list         => 'MYAPP.SALES_SUMMARY_MV',
    method       => 'C',
    out_of_place => TRUE
  );
END;
/
\`\`\`

**How it works:**
1. Oracle creates a temporary "out of place" container segment (named with an internal \$TMP\$ suffix).
2. The defining query executes and populates this temporary segment — the original mview remains online and readable throughout.
3. Oracle atomically renames the segments: the new segment becomes the mview, and the old segment is dropped.
4. Readers see either the old data or the new data — they never see an empty or partially populated mview.

**Requirements:**
- The schema must have space for two copies of the mview data simultaneously.
- Works with COMPLETE refresh and some FAST refresh scenarios.
- Available from Oracle 12.2.

\`\`\`sql
-- Space check before out-of-place refresh:
SELECT s.segment_name, s.bytes / 1048576 AS current_size_mb,
       t.used_blocks * t.block_size / 1048576 AS used_mb
FROM dba_segments s
JOIN dba_tables t ON t.table_name = s.segment_name
                  AND t.owner = s.owner
WHERE s.owner = 'MYAPP'
  AND s.segment_name = 'SALES_SUMMARY_MV';

-- For large mviews, verify tablespace free space before running out-of-place:
SELECT tablespace_name, SUM(bytes)/1048576 AS free_mb
FROM dba_free_space
WHERE tablespace_name = 'USERS'
GROUP BY tablespace_name;
\`\`\`

---

## 10. Common Problems and Diagnostics

### Fast refresh failing silently (FORCE falling back to COMPLETE)

This is the most common production mview problem. The scheduler thinks it is doing a fast refresh; it is actually doing a COMPLETE refresh with all the associated redo and lock time.

\`\`\`sql
-- Detect unintended complete refreshes by monitoring last_refresh_type:
SELECT mview_name, last_refresh_type, last_refresh_date,
       CASE last_refresh_type WHEN 'C' THEN '*** COMPLETE — check for problem ***'
                              WHEN 'F' THEN 'fast (ok)'
                              ELSE last_refresh_type END AS status
FROM all_mviews
WHERE owner = 'MYAPP'
  AND refresh_method = 'FAST'   -- Expected to be fast
ORDER BY last_refresh_date DESC;

-- Check what capabilities the mview actually has:
BEGIN
  DBMS_MVIEW.EXPLAIN_MVIEW(
    mv      => 'MYAPP.ORDERS_MV',
    stmt_id => 'CAPABILITY_CHECK'
  );
END;
/

SELECT capability_name, possible, msgtxt
FROM mv_capabilities_table
WHERE statement_id = 'CAPABILITY_CHECK'
ORDER BY seq;
\`\`\`

### Mview log growing unboundedly

\`\`\`sql
-- Find logs that have not been purged recently:
SELECT ml.log_owner, ml.master, ml.log_table,
       ml.last_purge_date,
       ROUND(SYSDATE - ml.last_purge_date, 1) AS days_since_purge,
       s.bytes / 1048576 AS log_size_mb
FROM dba_mview_logs ml
JOIN dba_segments s ON s.owner = ml.log_owner
                   AND s.segment_name = ml.log_table
WHERE ml.last_purge_date < SYSDATE - 1   -- Not purged in 24 hours
   OR ml.last_purge_date IS NULL
ORDER BY s.bytes DESC;

-- Find long-running transactions that are blocking log purge:
-- A log cannot be purged past the SCN of an active transaction on the base table
SELECT s.sid, s.serial#, s.username, s.status,
       t.start_time, t.used_ublk AS undo_blocks,
       ROUND(SYSDATE - TO_DATE(t.start_time, 'MM/DD/YY HH24:MI:SS'), 4) * 24 * 60 AS min_active
FROM v\$session s
JOIN v\$transaction t ON s.taddr = t.addr
ORDER BY t.start_time;
\`\`\`

### ON COMMIT refresh causing transaction latency spikes

\`\`\`sql
-- Verify that ON COMMIT mviews are contributing to commit latency:
SELECT event, total_waits, time_waited_micro / 1000 AS total_ms,
       ROUND(time_waited_micro / 1000.0 / total_waits, 2) AS avg_ms_per_wait
FROM v\$system_event
WHERE event LIKE 'log file sync%'
   OR event LIKE 'buffer busy waits%'
ORDER BY time_waited_micro DESC;

-- Check which mviews are ON COMMIT:
SELECT mview_name, refresh_method, refresh_mode, last_refresh_type, last_refresh_date
FROM all_mviews
WHERE owner = 'MYAPP'
  AND refresh_mode = 'COMMIT';

-- To convert ON COMMIT to ON DEMAND (requires recreating the mview):
-- 1. Script the current mview definition
-- 2. Drop and recreate with ON DEMAND
-- 3. Set up a DBMS_SCHEDULER job for periodic refresh
\`\`\`

### Query rewrite not firing despite fresh mview

\`\`\`sql
-- Diagnose with EXPLAIN_REWRITE:
BEGIN
  DBMS_MVIEW.EXPLAIN_REWRITE(
    query        => 'SELECT region, SUM(amount) FROM sales_fact GROUP BY region',
    mv           => 'MYAPP.SALES_AGG_MV',
    statement_id => 'REWRITE_DIAG'
  );
END;
/

SELECT message, pass, mv_owner, mv_name, query_text
FROM rewrite_table
WHERE statement_id = 'REWRITE_DIAG'
ORDER BY sequence;

-- Common messages and what they mean:
-- "QSM-01150: query rewrite not possible: no suitable materialized view"
--   -> The mview does not cover the query columns or aggregation
-- "QSM-01039: query rewrite not possible due to data integrity constraints"
--   -> ENFORCED mode requires the mview to be provably FRESH; it is STALE
-- "QSM-00110: query rewrite not possible with deprecated hint"
--   -> Wrong hint syntax

-- Check integrity level mismatch:
SELECT name, value FROM v\$parameter
WHERE name IN ('query_rewrite_enabled', 'query_rewrite_integrity');
\`\`\`

### ORA-12034: mview log younger than mview

\`\`\`sql
-- ORA-12034 error text:
-- ORA-12034: materialized view log on "<table>" younger than last refresh

-- This happens when the mview log is dropped and recreated after the mview was
-- last refreshed. Oracle cannot guarantee the log contains all changes since
-- the last refresh, so fast refresh is impossible.

-- Diagnosis:
SELECT ml.master, ml.log_table, ml.log_creation_date,
       mv.last_refresh_date,
       CASE WHEN ml.log_creation_date > mv.last_refresh_date
            THEN '*** LOG IS NEWER — force complete refresh ***'
            ELSE 'ok'
       END AS status
FROM dba_mview_logs ml
JOIN all_mviews mv ON mv.owner = ml.log_owner
WHERE ml.log_owner = 'MYAPP';

-- Resolution: force a complete refresh to re-establish the baseline
BEGIN
  DBMS_MVIEW.REFRESH(
    list   => 'MYAPP.ORDERS_MV',
    method => 'C'   -- Force complete refresh to resync
  );
END;
/
-- After this, future fast refreshes will work again.
\`\`\`

### ORA-32311 / ORA-23413: fast refresh capability failures

\`\`\`sql
-- ORA-32311: FAST REFRESH is not supported for this type of materialized view
-- ORA-23413: table "<name>" does not have a materialized view log

-- Diagnosis: check whether the mview log exists with required options:
SELECT log_owner, master, log_table, rowids, primary_key,
       sequence, include_new_values
FROM dba_mview_logs
WHERE master IN (
  SELECT master_table FROM all_mview_detail_relations
  WHERE mview_owner = 'MYAPP' AND mview_name = 'ORDERS_MV'
);

-- If log is missing or has wrong options:
-- Drop and recreate with correct options, then do a complete refresh of the mview.

-- Run EXPLAIN_MVIEW to get specific failure reason:
BEGIN
  DBMS_MVIEW.EXPLAIN_MVIEW(
    mv      => 'MYAPP.ORDERS_MV',
    stmt_id => 'FAST_CHECK'
  );
END;
/
SELECT capability_name, possible, msgtxt
FROM mv_capabilities_table
WHERE statement_id = 'FAST_CHECK'
  AND capability_name LIKE 'REFRESH_FAST%';
\`\`\`

### Statistics on mview not gathered automatically

Oracle does not automatically gather statistics on a materialized view after a refresh. This means the mview can have zero-row statistics (from creation) even when it contains millions of rows, causing the optimizer to produce terrible plans for both direct queries and query rewrite.

\`\`\`sql
-- Find mviews with stale or missing statistics:
SELECT t.table_name, t.num_rows, t.last_analyzed,
       mv.last_refresh_date,
       CASE WHEN t.last_analyzed < mv.last_refresh_date
                OR t.last_analyzed IS NULL
            THEN '*** STALE STATS ***'
            ELSE 'ok'
       END AS stat_status
FROM dba_tab_statistics t
JOIN all_mviews mv ON mv.mview_name = t.table_name
                  AND mv.owner = t.owner
WHERE t.owner = 'MYAPP'
ORDER BY mv.last_refresh_date DESC;

-- Gather stats immediately after refresh:
BEGIN
  DBMS_MVIEW.REFRESH(
    list   => 'MYAPP.SALES_AGG_MV',
    method => 'F'
  );
  -- Gather stats right after refresh:
  DBMS_STATS.GATHER_TABLE_STATS(
    ownname          => 'MYAPP',
    tabname          => 'SALES_AGG_MV',
    estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,
    degree           => 4
  );
END;
/
\`\`\`

### Direct-path insert bypassing mview log

When you insert into a base table using direct-path INSERT (INSERT /*+ APPEND */) or SQL*Loader direct path, Oracle bypasses the mview log. The inserted rows are not tracked in the log, making fast refresh impossible for that batch.

\`\`\`sql
-- This INSERT bypasses the mview log:
INSERT /*+ APPEND */ INTO sales_fact
SELECT * FROM sales_stage;
COMMIT;

-- After this, fast refresh will fail or produce incorrect results.
-- You must do a complete refresh after any direct-path load:
BEGIN
  DBMS_MVIEW.REFRESH(
    list   => 'MYAPP.SALES_AGG_MV',
    method => 'C'
  );
END;
/

-- To avoid this: use conventional INSERT (without APPEND hint) if you need fast refresh.
-- Or: use direct-path insert and schedule a complete refresh immediately after.
-- Oracle will raise ORA-01735 or silently skip logging depending on configuration.

-- Check current direct-path insert setting:
SHOW PARAMETER enable_goldengate_replication;
-- If TRUE, direct-path inserts are logged for GoldenGate (and mview logs)
\`\`\`

---

## Key Reference Queries

\`\`\`sql
-- All mviews with health summary:
SELECT owner, mview_name, refresh_method, refresh_mode,
       last_refresh_type, last_refresh_date, staleness, compile_state
FROM all_mviews
WHERE owner NOT IN ('SYS','SYSTEM')
ORDER BY owner, mview_name;

-- Mview log summary:
SELECT log_owner, master, log_table,
       rowids, primary_key, sequence, include_new_values,
       last_purge_date
FROM dba_mview_logs
ORDER BY log_owner, master;

-- Mview-to-base-table relationships:
SELECT mview_owner, mview_name, master_owner, master, master_table
FROM all_mview_detail_relations
ORDER BY mview_owner, mview_name;

-- Mview refresh history (12c+):
SELECT mview_owner, name AS mview_name,
       refresh_id, start_time, end_time,
       elapsed_time, num_rows_ins, num_rows_del,
       num_rows_upd, num_rows, complete_stats
FROM dba_mview_refresh_times
ORDER BY start_time DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

---

## Summary

Materialized views are powerful but have real operational complexity. The key points:

- **Always check fast refresh capability with \`DBMS_MVIEW.EXPLAIN_MVIEW\` before creating the mview.** Discovering that fast refresh is impossible after the mview is in production leads to unplanned COMPLETE refreshes.
- **FORCE refresh hides problems.** Monitor \`last_refresh_type\` to detect when FORCE silently performs a COMPLETE refresh.
- **Mview logs grow without bound if dependent mviews stop refreshing.** Set up log size monitoring.
- **Gather statistics on mviews after refresh.** Oracle does not do this automatically.
- **ON COMMIT refresh adds latency to every base table COMMIT.** Use it only for small, infrequently-changing lookup tables.
- **Out-of-place refresh is the production-safe way to COMPLETE-refresh large mviews** — it keeps the mview readable throughout the refresh operation.`,
};

async function main() {
  console.log('Inserting mview concepts post...');
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
