import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Table Partitioning — Creation, Maintenance, and Performance Validation',
  slug: 'oracle-partitioning-runbook',
  excerpt:
    'A phased operational runbook for Oracle DBAs covering the complete partitioning lifecycle: pre-partitioning assessment, range/list/hash/composite/reference DDL, online table conversion (12.2+), local and global index creation, partition maintenance (add/drop/split/merge/exchange), pruning validation, partition-wise join demonstration, archival and purge workflow, index maintenance after DDL, and a comprehensive partitioning health dashboard.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-06'),
  youtubeUrl: null,
  content: `This runbook covers the complete Oracle table partitioning lifecycle. All commands are SQL or PL/SQL. Run each phase in order and verify the output at each step before proceeding.

**Assumptions:**
- Oracle Database 12.2 or later (Phase 2 online conversion requires 12.2+)
- Partitioning option is licensed (verify in Phase 0)
- DBA or equivalent privileges
- Working schema: \`SALES_OWN\`
- Primary table: \`ORDER_HISTORY\` (time-series orders, partitioned by \`order_date\`)

---

## Phase 0: Pre-Partitioning Assessment

### Step 0.1: Verify Partitioning Option Is Licensed

\`\`\`sql
SELECT value AS partitioning_licensed
FROM v\$option
WHERE parameter = 'Partitioning';
-- Must return TRUE before proceeding
\`\`\`

### Step 0.2: Identify Large Non-Partitioned Tables (Candidate Tables)

\`\`\`sql
-- Tables larger than 1 GB that are not yet partitioned
SELECT s.owner,
       s.segment_name AS table_name,
       ROUND(SUM(s.bytes) / 1073741824, 2) AS size_gb,
       t.num_rows,
       t.last_analyzed
FROM dba_segments s
JOIN dba_tables t
  ON t.owner = s.owner
  AND t.table_name = s.segment_name
WHERE s.segment_type = 'TABLE'
  AND t.partitioned = 'NO'
  AND s.owner NOT IN ('SYS','SYSTEM','DBSNMP','SYSMAN','OUTLN','XDB','WMSYS')
GROUP BY s.owner, s.segment_name, t.num_rows, t.last_analyzed
HAVING SUM(s.bytes) > 1073741824
ORDER BY SUM(s.bytes) DESC;
\`\`\`

### Step 0.3: Find DATE/TIMESTAMP Columns on Large Tables (Partition Key Candidates)

\`\`\`sql
-- DATE and TIMESTAMP columns on the candidate tables identified above
SELECT c.owner,
       c.table_name,
       c.column_name,
       c.data_type,
       c.nullable,
       c.num_distinct,
       c.num_nulls,
       c.density,
       c.last_analyzed
FROM dba_tab_col_statistics c
WHERE c.owner = 'SALES_OWN'
  AND c.data_type IN ('DATE', 'TIMESTAMP', 'TIMESTAMP WITH TIME ZONE',
                      'TIMESTAMP WITH LOCAL TIME ZONE')
  AND c.table_name IN (
      SELECT segment_name FROM dba_segments
      WHERE owner = 'SALES_OWN'
        AND segment_type = 'TABLE'
      GROUP BY segment_name
      HAVING SUM(bytes) > 1073741824
  )
ORDER BY c.table_name, c.column_name;
\`\`\`

### Step 0.4: Identify Full-Table-Scan Frequency on Large Tables from AWR

\`\`\`sql
-- Tables with the most full-table-scan operations in AWR history
SELECT sp.object_owner,
       sp.object_name,
       COUNT(DISTINCT sp.sql_id) AS distinct_sql_count,
       SUM(ss.executions_delta) AS total_executions,
       SUM(ss.buffer_gets_delta) AS total_buffer_gets
FROM dba_hist_sql_plan sp
JOIN dba_hist_sqlstat ss
  ON ss.sql_id = sp.sql_id
  AND ss.dbid = sp.dbid
WHERE sp.operation = 'TABLE ACCESS'
  AND sp.options = 'FULL'
  AND sp.object_owner = 'SALES_OWN'
  AND ss.buffer_gets_delta > 0
GROUP BY sp.object_owner, sp.object_name
ORDER BY total_buffer_gets DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

### Step 0.5: Estimate Row Distribution Across a Potential Range Partition Key

\`\`\`sql
-- Row count per month for ORDER_HISTORY to estimate partition sizes
SELECT TRUNC(order_date, 'MM') AS partition_month,
       COUNT(*) AS row_count,
       ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) AS pct_of_total
FROM sales_own.order_history_source
GROUP BY TRUNC(order_date, 'MM')
ORDER BY partition_month;
\`\`\`

### Step 0.6: Estimate Segment Size Per Partition Using DBMS_SPACE

\`\`\`sql
-- Average row length to estimate partition sizes
SELECT AVG_ROW_LEN, NUM_ROWS, BLOCKS,
       ROUND(AVG_ROW_LEN * NUM_ROWS / 1048576, 2) AS estimated_data_mb
FROM dba_tables
WHERE owner = 'SALES_OWN'
  AND table_name = 'ORDER_HISTORY_SOURCE';
\`\`\`

---

## Phase 1: Range Partitioning — Date-Based Table

### Step 1.1: Create the Partitioned Table with Interval Partitioning

\`\`\`sql
-- Create the new partitioned version of ORDER_HISTORY
-- Using interval partitioning so future months are created automatically
CREATE TABLE sales_own.order_history_new (
  order_id        NUMBER(12)    NOT NULL,
  order_date      DATE          NOT NULL,
  customer_id     NUMBER(10)    NOT NULL,
  order_total     NUMBER(14,2),
  status          VARCHAR2(20),
  created_by      VARCHAR2(100),
  last_updated    DATE          DEFAULT SYSDATE
)
PARTITION BY RANGE (order_date)
INTERVAL (NUMTOYMINTERVAL(1, 'MONTH'))
(
  -- Anchor partition: catches all historical data before 2024
  PARTITION oh_before_2024 VALUES LESS THAN (DATE '2024-01-01'),
  -- 2024 quarters
  PARTITION oh_2024_q1     VALUES LESS THAN (DATE '2024-04-01'),
  PARTITION oh_2024_q2     VALUES LESS THAN (DATE '2024-07-01'),
  PARTITION oh_2024_q3     VALUES LESS THAN (DATE '2024-10-01'),
  PARTITION oh_2024_q4     VALUES LESS THAN (DATE '2025-01-01'),
  -- 2025: monthly partitions for recent history
  PARTITION oh_2025_jan    VALUES LESS THAN (DATE '2025-02-01'),
  PARTITION oh_2025_feb    VALUES LESS THAN (DATE '2025-03-01'),
  PARTITION oh_2025_mar    VALUES LESS THAN (DATE '2025-04-01'),
  PARTITION oh_2025_apr    VALUES LESS THAN (DATE '2025-05-01'),
  PARTITION oh_2025_may    VALUES LESS THAN (DATE '2025-06-01'),
  PARTITION oh_2025_jun    VALUES LESS THAN (DATE '2025-07-01'),
  PARTITION oh_2025_jul    VALUES LESS THAN (DATE '2025-08-01'),
  PARTITION oh_2025_aug    VALUES LESS THAN (DATE '2025-09-01'),
  PARTITION oh_2025_sep    VALUES LESS THAN (DATE '2025-10-01'),
  PARTITION oh_2025_oct    VALUES LESS THAN (DATE '2025-11-01'),
  PARTITION oh_2025_nov    VALUES LESS THAN (DATE '2025-12-01'),
  PARTITION oh_2025_dec    VALUES LESS THAN (DATE '2026-01-01')
  -- 2026+ partitions will be auto-created by the INTERVAL clause
);
\`\`\`

### Step 1.2: Migrate Data from the Original Table

\`\`\`sql
-- Use direct-path INSERT for speed (minimal undo, direct writes to datafiles)
INSERT /*+ APPEND PARALLEL(4) */ INTO sales_own.order_history_new
  SELECT order_id, order_date, customer_id, order_total,
         status, created_by, last_updated
  FROM sales_own.order_history_source;
COMMIT;
\`\`\`

### Step 1.3: Verify Partition Creation and Segment Sizes

\`\`\`sql
-- Count partitions and verify each has the expected row count
SELECT tp.partition_name,
       tp.partition_position,
       tp.high_value,
       tp.num_rows,
       tp.interval,
       tp.segment_created,
       ROUND(NVL(s.bytes, 0) / 1048576, 2) AS size_mb
FROM dba_tab_partitions tp
LEFT JOIN dba_segments s
  ON s.owner = tp.table_owner
  AND s.segment_name = tp.table_name
  AND s.partition_name = tp.partition_name
WHERE tp.table_owner = 'SALES_OWN'
  AND tp.table_name = 'ORDER_HISTORY_NEW'
ORDER BY tp.partition_position;

-- Total row count should match the source
SELECT COUNT(*) FROM sales_own.order_history_new;
SELECT COUNT(*) FROM sales_own.order_history_source;
\`\`\`

### Step 1.4: Verify Partition Pruning Works

\`\`\`sql
EXPLAIN PLAN FOR
SELECT COUNT(*) FROM sales_own.order_history_new
WHERE order_date >= DATE '2026-06-01'
  AND order_date < DATE '2026-07-01';

SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(format => 'TYPICAL +PARTITION'));
-- Look for: PARTITION RANGE SINGLE and specific Pstart/Pstop values (not 1/1048575)
\`\`\`

### Step 1.5: Rename Tables to Cut Over

\`\`\`sql
-- Rename original to _OLD, rename new partitioned table to the original name
ALTER TABLE sales_own.order_history_source RENAME TO order_history_old;
ALTER TABLE sales_own.order_history_new RENAME TO order_history;

-- Recreate primary key and any indexes on the renamed table
ALTER TABLE sales_own.order_history ADD CONSTRAINT order_history_pk PRIMARY KEY (order_id);

-- Gather statistics on the new partitioned table
BEGIN
  DBMS_STATS.GATHER_TABLE_STATS(
    ownname          => 'SALES_OWN',
    tabname          => 'ORDER_HISTORY',
    estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,
    cascade          => TRUE,
    degree           => 4,
    granularity      => 'ALL'
  );
END;
/
\`\`\`

---

## Phase 2: Online Table Conversion to Partitioned (12.2+)

The \`ALTER TABLE ... MODIFY PARTITION BY\` command converts a non-partitioned heap table to a partitioned table online — concurrent DML is permitted throughout the operation.

### Step 2.1: Online Conversion with MODIFY PARTITION BY

\`\`\`sql
-- Convert ORDER_HISTORY_OLD (still non-partitioned) to partitioned online
-- This is an alternative to the rename-and-migrate approach in Phase 1
ALTER TABLE sales_own.order_history_old
  MODIFY PARTITION BY RANGE (order_date)
  INTERVAL (NUMTOYMINTERVAL(1, 'MONTH'))
  (
    PARTITION oh_before_2024 VALUES LESS THAN (DATE '2024-01-01'),
    PARTITION oh_2024_all    VALUES LESS THAN (DATE '2025-01-01')
  )
  ONLINE;
-- ONLINE keyword allows DML during conversion (may take longer)
-- Without ONLINE, a brief table-level lock is acquired at start and end
\`\`\`

### Step 2.2: Monitor Online Conversion Progress

\`\`\`sql
-- Monitor progress via V$LONG_OPERATIONS
SELECT sid,
       serial#,
       opname,
       target,
       sofar,
       totalwork,
       ROUND(sofar / NULLIF(totalwork, 0) * 100, 1) AS pct_done,
       time_remaining AS secs_remaining,
       message
FROM v\$session_longops
WHERE opname LIKE '%PARTITION%'
   OR opname LIKE '%CONVERT%'
ORDER BY start_time DESC;
\`\`\`

### Step 2.3: Post-Conversion Verification

\`\`\`sql
-- Verify table is now partitioned
SELECT table_name, partitioned, row_movement, status
FROM dba_tables
WHERE owner = 'SALES_OWN'
  AND table_name = 'ORDER_HISTORY_OLD';
-- PARTITIONED should now be YES

-- Verify all partitions are present and have correct row counts
SELECT partition_name, high_value, num_rows, segment_created
FROM dba_tab_partitions
WHERE table_owner = 'SALES_OWN'
  AND table_name = 'ORDER_HISTORY_OLD'
ORDER BY partition_position;
\`\`\`

---

## Phase 3: List and Composite Partitioning

### Step 3a: List Partition by Region with DEFAULT Partition

\`\`\`sql
CREATE TABLE sales_own.regional_sales (
  sale_id     NUMBER(12)   NOT NULL,
  region_code VARCHAR2(10) NOT NULL,
  sale_date   DATE         NOT NULL,
  amount      NUMBER(14,2),
  CONSTRAINT regional_sales_pk PRIMARY KEY (sale_id)
)
PARTITION BY LIST (region_code) (
  PARTITION rs_apac    VALUES ('APAC', 'ANZ', 'SEA', 'JP'),
  PARTITION rs_emea    VALUES ('EMEA', 'UK', 'DACH', 'FR', 'BENELUX'),
  PARTITION rs_americas VALUES ('NA', 'LATAM', 'CA', 'MX'),
  PARTITION rs_default VALUES (DEFAULT)
);

-- Verify list partitions
SELECT partition_name, high_value
FROM dba_tab_partitions
WHERE table_owner = 'SALES_OWN'
  AND table_name = 'REGIONAL_SALES'
ORDER BY partition_position;
\`\`\`

### Step 3b: Range-Hash Composite Partition

\`\`\`sql
-- Monthly range on order_date, hash on customer_id with 8 subpartitions
-- The subpartition template is applied automatically to every range partition
CREATE TABLE sales_own.orders_rh (
  order_id      NUMBER(12)   NOT NULL,
  order_date    DATE         NOT NULL,
  customer_id   NUMBER(10)   NOT NULL,
  order_total   NUMBER(14,2),
  status        VARCHAR2(20)
)
PARTITION BY RANGE (order_date)
INTERVAL (NUMTOYMINTERVAL(1, 'MONTH'))
SUBPARTITION BY HASH (customer_id)
SUBPARTITION TEMPLATE (
  SUBPARTITION sp_h1,
  SUBPARTITION sp_h2,
  SUBPARTITION sp_h3,
  SUBPARTITION sp_h4,
  SUBPARTITION sp_h5,
  SUBPARTITION sp_h6,
  SUBPARTITION sp_h7,
  SUBPARTITION sp_h8
)
(
  PARTITION orh_before_2025 VALUES LESS THAN (DATE '2025-01-01')
);

-- Verify subpartitions
SELECT partition_name,
       subpartition_name,
       high_value
FROM dba_tab_subpartitions
WHERE table_owner = 'SALES_OWN'
  AND table_name = 'ORDERS_RH'
ORDER BY partition_name, subpartition_name;
\`\`\`

### Step 3c: Reference Partition — Parent-Child FK Alignment

\`\`\`sql
-- Parent table: orders partitioned by range-interval
CREATE TABLE sales_own.orders_parent (
  order_id    NUMBER(12)  NOT NULL,
  order_date  DATE        NOT NULL,
  customer_id NUMBER(10)  NOT NULL,
  order_total NUMBER(14,2),
  CONSTRAINT orders_parent_pk PRIMARY KEY (order_id)
)
PARTITION BY RANGE (order_date)
INTERVAL (NUMTOYMINTERVAL(1, 'MONTH'))
(
  PARTITION op_before_2025 VALUES LESS THAN (DATE '2025-01-01')
);

-- Child table: reference-partitioned through the FK
-- No need to repeat the order_date column in the child
CREATE TABLE sales_own.order_lines (
  line_id       NUMBER(12)   NOT NULL,
  order_id      NUMBER(12)   NOT NULL,
  product_id    NUMBER(10)   NOT NULL,
  quantity      NUMBER(6)    NOT NULL,
  unit_price    NUMBER(10,2) NOT NULL,
  discount_pct  NUMBER(5,2),
  CONSTRAINT order_lines_pk PRIMARY KEY (line_id),
  CONSTRAINT order_lines_fk FOREIGN KEY (order_id)
    REFERENCES sales_own.orders_parent (order_id)
)
PARTITION BY REFERENCE (order_lines_fk);
-- The child table inherits monthly interval partitioning from the parent
-- New child partitions are auto-created when parent partitions are auto-created

-- Verify both tables have the same partition structure
SELECT 'PARENT' AS tbl, partition_name, partition_position
FROM dba_tab_partitions
WHERE table_owner = 'SALES_OWN' AND table_name = 'ORDERS_PARENT'
UNION ALL
SELECT 'CHILD', partition_name, partition_position
FROM dba_tab_partitions
WHERE table_owner = 'SALES_OWN' AND table_name = 'ORDER_LINES'
ORDER BY partition_position, tbl;
\`\`\`

---

## Phase 4: Local and Global Index Creation

### Step 4.1: Create Local Indexes

\`\`\`sql
-- Local index on the partition key (covering index pattern for range queries)
CREATE INDEX sales_own.idx_oh_date_local
  ON sales_own.order_history (order_date, order_total)
  LOCAL
  PARALLEL 4;

-- Local index on a non-key column (requires scanning all partitions for non-pruned queries)
CREATE INDEX sales_own.idx_oh_customer_local
  ON sales_own.order_history (customer_id)
  LOCAL
  PARALLEL 4;

-- Verify local index partitions
SELECT ip.index_name,
       ip.partition_name,
       ip.status,
       ip.blevel,
       ip.leaf_blocks
FROM dba_ind_partitions ip
WHERE ip.index_owner = 'SALES_OWN'
  AND ip.index_name IN ('IDX_OH_DATE_LOCAL', 'IDX_OH_CUSTOMER_LOCAL')
ORDER BY ip.index_name, ip.partition_position;
\`\`\`

### Step 4.2: Create a Global Non-Partitioned Unique Index

\`\`\`sql
-- Global unique index: spans all partitions, single probe for unique lookups
CREATE UNIQUE INDEX sales_own.idx_oh_orderid_global
  ON sales_own.order_history (order_id)
  GLOBAL
  PARALLEL 4;
-- After any partition DDL without UPDATE GLOBAL INDEXES, this becomes UNUSABLE
\`\`\`

### Step 4.3: Create a Global Range-Partitioned Index

\`\`\`sql
-- Global range-partitioned index on customer_id
-- Reduces index maintenance overhead vs a fully non-partitioned global index
CREATE INDEX sales_own.idx_oh_custid_gpart
  ON sales_own.order_history (customer_id)
  GLOBAL PARTITION BY RANGE (customer_id) (
    PARTITION gp_1       VALUES LESS THAN (100000),
    PARTITION gp_2       VALUES LESS THAN (500000),
    PARTITION gp_3       VALUES LESS THAN (1000000),
    PARTITION gp_max     VALUES LESS THAN (MAXVALUE)
  )
  PARALLEL 4;
\`\`\`

### Step 4.4: Verify All Indexes and Check Status

\`\`\`sql
-- All indexes on ORDER_HISTORY with type and status
SELECT i.index_name,
       i.index_type,
       i.partitioned,
       i.uniqueness,
       i.locality,
       i.status
FROM dba_indexes i
WHERE i.owner = 'SALES_OWN'
  AND i.table_name = 'ORDER_HISTORY'
ORDER BY i.index_name;

-- Check all index partition statuses (find any UNUSABLE)
SELECT index_name,
       partition_name,
       status,
       blevel,
       leaf_blocks,
       last_analyzed
FROM dba_ind_partitions
WHERE index_owner = 'SALES_OWN'
  AND index_name IN ('IDX_OH_DATE_LOCAL','IDX_OH_CUSTOMER_LOCAL','IDX_OH_CUSTID_GPART')
ORDER BY index_name, partition_position;
\`\`\`

---

## Phase 5: Partition Maintenance — Add, Drop, Split, Merge, Exchange

### Step 5a: ADD PARTITION to a Range-Partitioned Table

\`\`\`sql
-- Only needed for range-partitioned tables WITHOUT interval
-- With interval partitioning, Oracle auto-creates partitions; this is not needed
ALTER TABLE sales_own.order_history
  ADD PARTITION oh_2027_q1 VALUES LESS THAN (DATE '2027-04-01')
  TABLESPACE users;

-- Verify the new partition was added
SELECT partition_name, high_value, segment_created
FROM dba_tab_partitions
WHERE table_owner = 'SALES_OWN'
  AND table_name = 'ORDER_HISTORY'
  AND partition_name = 'OH_2027_Q1';
\`\`\`

### Step 5b: DROP PARTITION with UPDATE GLOBAL INDEXES

\`\`\`sql
-- Drop an old partition; UPDATE GLOBAL INDEXES keeps global indexes usable
ALTER TABLE sales_own.order_history
  DROP PARTITION oh_before_2024
  UPDATE GLOBAL INDEXES;

-- Verify the partition is gone and global indexes are still VALID
SELECT partition_name FROM dba_tab_partitions
WHERE table_owner = 'SALES_OWN' AND table_name = 'ORDER_HISTORY'
  AND partition_name = 'OH_BEFORE_2024';
-- Should return no rows

SELECT index_name, status FROM dba_indexes
WHERE owner = 'SALES_OWN' AND table_name = 'ORDER_HISTORY'
  AND partitioned = 'NO';
-- Status should be VALID
\`\`\`

### Step 5c: TRUNCATE PARTITION

\`\`\`sql
-- TRUNCATE removes all rows from a partition and resets the high-water mark
-- Faster than DELETE; generates minimal undo; space is reclaimed
ALTER TABLE sales_own.order_history
  TRUNCATE PARTITION oh_2024_q1
  UPDATE GLOBAL INDEXES;

-- Verify the partition is empty and space was reclaimed
SELECT tp.partition_name, tp.num_rows,
       NVL(s.bytes, 0) AS bytes_allocated
FROM dba_tab_partitions tp
LEFT JOIN dba_segments s
  ON s.owner = tp.table_owner
  AND s.segment_name = tp.table_name
  AND s.partition_name = tp.partition_name
WHERE tp.table_owner = 'SALES_OWN'
  AND tp.table_name = 'ORDER_HISTORY'
  AND tp.partition_name = 'OH_2024_Q1';
-- bytes_allocated should be 0 or minimal after TRUNCATE (segment may be dropped)
\`\`\`

### Step 5d: SPLIT PARTITION

\`\`\`sql
-- Split the OH_2025_H1 partition (containing Jan-Jun 2025) into two quarters
ALTER TABLE sales_own.order_history
  SPLIT PARTITION oh_2025_h1 AT (DATE '2025-04-01')
  INTO (
    PARTITION oh_2025_q1,
    PARTITION oh_2025_q2
  )
  UPDATE GLOBAL INDEXES;

-- Verify the split result
SELECT partition_name, high_value, num_rows
FROM dba_tab_partitions
WHERE table_owner = 'SALES_OWN'
  AND table_name = 'ORDER_HISTORY'
  AND partition_name IN ('OH_2025_Q1','OH_2025_Q2')
ORDER BY partition_position;
\`\`\`

### Step 5e: MERGE PARTITION

\`\`\`sql
-- Merge two small adjacent partitions into one (adjacent in partition key order)
ALTER TABLE sales_own.order_history
  MERGE PARTITIONS oh_2024_q3, oh_2024_q4
  INTO PARTITION oh_2024_h2
  UPDATE GLOBAL INDEXES;

-- Verify merged partition
SELECT partition_name, high_value, num_rows
FROM dba_tab_partitions
WHERE table_owner = 'SALES_OWN'
  AND table_name = 'ORDER_HISTORY'
  AND partition_name = 'OH_2024_H2';
\`\`\`

### Step 5f: EXCHANGE PARTITION — Complete Bulk Load Workflow

\`\`\`sql
-- Step 1: Create a staging table with the same structure (no partition clause)
CREATE TABLE sales_own.orders_stage_jun2026 AS
  SELECT * FROM sales_own.order_history WHERE 1 = 0;

-- Step 2: Load data into the staging table using direct-path INSERT
INSERT /*+ APPEND PARALLEL(4) */ INTO sales_own.orders_stage_jun2026
  SELECT order_id, order_date, customer_id, order_total,
         status, created_by, last_updated
  FROM sales_own.orders_feed_jun2026
  WHERE order_date >= DATE '2026-06-01'
    AND order_date < DATE '2026-07-01';
COMMIT;

-- Step 3: Create indexes on the staging table matching the local index structure
CREATE INDEX sales_own.idx_stg_jun2026_cust
  ON sales_own.orders_stage_jun2026 (customer_id)
  PARALLEL 4;

-- Step 4: Validate data before exchange (optional but recommended)
SELECT COUNT(*) FROM sales_own.orders_stage_jun2026
WHERE order_date < DATE '2026-06-01'
   OR order_date >= DATE '2026-07-01';
-- Must return 0 — all rows must fall within the partition bounds

-- Step 5: Exchange the staging table into the target partition
-- WITHOUT VALIDATION skips row-by-row bound checking (fast; safe when Step 4 passes)
-- INCLUDING INDEXES exchanges the index segments as well
ALTER TABLE sales_own.order_history
  EXCHANGE PARTITION oh_2026_jun   -- use the actual auto-created partition name
  WITH TABLE sales_own.orders_stage_jun2026
  INCLUDING INDEXES
  WITHOUT VALIDATION
  UPDATE GLOBAL INDEXES;
-- This completes in milliseconds regardless of row count

-- Step 6: Verify the exchange succeeded
SELECT COUNT(*) FROM sales_own.order_history
PARTITION (oh_2026_jun);   -- adjust partition name to actual

-- Step 7: The staging table now holds the old (empty) partition segment
-- Drop it or repurpose it for the next load
DROP TABLE sales_own.orders_stage_jun2026;
\`\`\`

---

## Phase 6: Partition Pruning Validation

### Step 6.1: Compare Plans With and Without the Partition Key Predicate

\`\`\`sql
-- Plan WITH partition key predicate — should show PARTITION RANGE SINGLE
EXPLAIN PLAN SET STATEMENT_ID = 'PRUNING_WITH' FOR
SELECT COUNT(*), SUM(order_total)
FROM sales_own.order_history
WHERE order_date >= DATE '2026-06-01'
  AND order_date < DATE '2026-07-01';

SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(
  'PLAN_TABLE', 'PRUNING_WITH', 'TYPICAL +PARTITION'));
-- Expect: PARTITION RANGE SINGLE, Pstart and Pstop show a single partition number

-- Plan WITHOUT partition key predicate — will show PARTITION RANGE ALL
EXPLAIN PLAN SET STATEMENT_ID = 'PRUNING_WITHOUT' FOR
SELECT COUNT(*), SUM(order_total)
FROM sales_own.order_history
WHERE customer_id = 98765;

SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(
  'PLAN_TABLE', 'PRUNING_WITHOUT', 'TYPICAL +PARTITION'));
-- Expect: PARTITION RANGE ALL, Pstart=1 Pstop=1048575 (all partitions scanned)
\`\`\`

### Step 6.2: Detect Pruning Failure Caused by Implicit Conversion

\`\`\`sql
-- BAD: TRUNC() applied to the partition key column — PRUNING FAILS
EXPLAIN PLAN SET STATEMENT_ID = 'PRUNING_FAIL' FOR
SELECT COUNT(*)
FROM sales_own.order_history
WHERE TRUNC(order_date) = DATE '2026-06-15';

SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(
  'PLAN_TABLE', 'PRUNING_FAIL', 'TYPICAL +PARTITION'));
-- Plan shows PARTITION RANGE ALL — Oracle cannot use the partition key value
-- because the column is wrapped in TRUNC()

-- GOOD: Range predicate without function on the column — PRUNING SUCCEEDS
EXPLAIN PLAN SET STATEMENT_ID = 'PRUNING_GOOD' FOR
SELECT COUNT(*)
FROM sales_own.order_history
WHERE order_date >= DATE '2026-06-15'
  AND order_date < DATE '2026-06-16';

SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(
  'PLAN_TABLE', 'PRUNING_GOOD', 'TYPICAL +PARTITION'));
-- Plan shows PARTITION RANGE SINGLE
\`\`\`

### Step 6.3: Verify Dynamic Pruning with Bind Variables

\`\`\`sql
VARIABLE v_start_date VARCHAR2(20);
VARIABLE v_end_date   VARCHAR2(20);
EXEC :v_start_date := '2026-06-01';
EXEC :v_end_date   := '2026-07-01';

EXPLAIN PLAN SET STATEMENT_ID = 'PRUNING_BIND' FOR
SELECT COUNT(*)
FROM sales_own.order_history
WHERE order_date >= TO_DATE(:v_start_date, 'YYYY-MM-DD')
  AND order_date < TO_DATE(:v_end_date, 'YYYY-MM-DD');

SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(
  'PLAN_TABLE', 'PRUNING_BIND', 'TYPICAL +PARTITION'));
-- Pstart/Pstop show KEY (bind variable peeking resolves at execution time)
-- At runtime with these bind values, Oracle will access only the June 2026 partition
\`\`\`

---

## Phase 7: Partition-Wise Join Demonstration

### Step 7.1: Setup — Two Tables Partitioned the Same Way

\`\`\`sql
-- For partition-wise joins, both tables must be partitioned on the same key
-- with the same number of partitions (or compatible interval)
-- ORDER_HISTORY: already range-interval partitioned on order_date
-- For this demo, create a second table range-interval partitioned on the same key:
CREATE TABLE sales_own.order_audit (
  audit_id    NUMBER(12)  NOT NULL,
  order_id    NUMBER(12)  NOT NULL,
  order_date  DATE        NOT NULL,
  action      VARCHAR2(50),
  action_date DATE        DEFAULT SYSDATE
)
PARTITION BY RANGE (order_date)
INTERVAL (NUMTOYMINTERVAL(1, 'MONTH'))
(
  PARTITION oa_before_2025 VALUES LESS THAN (DATE '2025-01-01')
);
\`\`\`

### Step 7.2: Verify Partition-Wise Join in Execution Plan

\`\`\`sql
-- Query joining two tables partitioned on the same key with PARALLEL hint
EXPLAIN PLAN SET STATEMENT_ID = 'PWJ_DEMO' FOR
SELECT /*+ PARALLEL(oh 4) PARALLEL(oa 4) */
       oh.order_id, oh.order_total, oa.action
FROM sales_own.order_history oh
JOIN sales_own.order_audit oa
  ON oh.order_id = oa.order_id
  AND oh.order_date = oa.order_date   -- join includes partition key
WHERE oh.order_date >= DATE '2026-01-01'
  AND oh.order_date < DATE '2027-01-01';

SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(
  'PLAN_TABLE', 'PWJ_DEMO', 'TYPICAL +PARTITION'));
-- Look for:
-- PX PARTITION RANGE ITERATOR  (partition-wise join in action)
-- HASH JOIN                    (joining within each partition pair)
-- No PX SEND / PX RECEIVE for the join rows (eliminated by partition-wise join)
\`\`\`

### Step 7.3: Contrast With Non-Partitioned Join Plan

\`\`\`sql
-- Same query on a non-partitioned version of order_audit
-- Shows the additional PX SEND PARTITION (KEY) / PX RECEIVE steps needed
-- to redistribute rows to matching hash buckets
EXPLAIN PLAN SET STATEMENT_ID = 'NO_PWJ' FOR
SELECT /*+ PARALLEL(oh 4) PARALLEL(oa 4) */
       oh.order_id, oh.order_total
FROM sales_own.order_history oh
JOIN sales_own.order_audit_flat oa   -- non-partitioned version
  ON oh.order_id = oa.order_id;

SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(
  'PLAN_TABLE', 'NO_PWJ', 'TYPICAL +PARTITION'));
-- Plan shows PX SEND PARTITION (KEY) and PX RECEIVE for redistribution
-- This is the cross-partition shuffle that partition-wise join eliminates
\`\`\`

---

## Phase 8: Archival and Purge Workflow

The recommended pattern for archiving historical partitions uses EXCHANGE PARTITION to preserve the data in an archive table, then DROP PARTITION to release space from the main table. This is far superior to DELETE-based purge: no undo is generated, no redo is generated for the data move (it is a data dictionary operation), and the HWM is definitively reset.

### Step 8.1: Create the Archive Table

\`\`\`sql
-- Create the archive table with the same structure as ORDER_HISTORY (non-partitioned)
CREATE TABLE sales_own.order_history_archive_2024q1 AS
  SELECT * FROM sales_own.order_history WHERE 1 = 0;

-- Add the same indexes for query access in the archive
CREATE INDEX sales_own.idx_arch_2024q1_cust
  ON sales_own.order_history_archive_2024q1 (customer_id);
\`\`\`

### Step 8.2: Exchange the Oldest Partition into the Archive Table

\`\`\`sql
-- Exchange: data moves from the partition to the archive table (data dictionary op)
ALTER TABLE sales_own.order_history
  EXCHANGE PARTITION oh_2024_q1
  WITH TABLE sales_own.order_history_archive_2024q1
  INCLUDING INDEXES
  WITHOUT VALIDATION
  UPDATE GLOBAL INDEXES;

-- Verify the archive table now contains the partition data
SELECT COUNT(*) FROM sales_own.order_history_archive_2024q1;

-- Verify the partition is now empty in the main table
SELECT COUNT(*) FROM sales_own.order_history
PARTITION (oh_2024_q1);
-- Should return 0
\`\`\`

### Step 8.3: Drop the Now-Empty Partition

\`\`\`sql
-- Drop the empty partition to release its segment from the main table
ALTER TABLE sales_own.order_history
  DROP PARTITION oh_2024_q1
  UPDATE GLOBAL INDEXES;

-- Verify space was released: the partition segment should no longer appear in DBA_SEGMENTS
SELECT bytes FROM dba_segments
WHERE owner = 'SALES_OWN'
  AND segment_name = 'ORDER_HISTORY'
  AND partition_name = 'OH_2024_Q1';
-- Should return no rows — segment has been deallocated
\`\`\`

### Step 8.4: Contrast With DELETE-Based Purge (Do Not Use)

\`\`\`sql
-- This is the WRONG approach for purging partition data:
-- DELETE generates undo (one undo record per row), generates redo,
-- blocks readers for the duration, and does NOT reset the HWM.
-- The segment remains the same size even after all rows are deleted.
-- DO NOT USE FOR PARTITION PURGE:
-- DELETE FROM sales_own.order_history WHERE order_date < DATE '2024-04-01';

-- After a DELETE (not exchange + drop), verify HWM has NOT been reset:
SELECT segment_name, partition_name,
       ROUND(bytes / 1048576, 2) AS size_mb
FROM dba_segments
WHERE owner = 'SALES_OWN'
  AND segment_name = 'ORDER_HISTORY'
  AND partition_name = 'OH_2024_Q1';
-- bytes stays the same as before the DELETE -- HWM was not reset
-- Only TRUNCATE PARTITION or DROP PARTITION resets the HWM and releases space
\`\`\`

---

## Phase 9: Index Maintenance After Partition DDL

### Step 9.1: Find All UNUSABLE Index Partitions

\`\`\`sql
-- Non-partitioned global indexes that are UNUSABLE
SELECT owner, index_name, table_name, status
FROM dba_indexes
WHERE owner = 'SALES_OWN'
  AND table_name = 'ORDER_HISTORY'
  AND status = 'UNUSABLE';

-- Partitioned index partitions that are UNUSABLE
SELECT index_owner, index_name, partition_name, status
FROM dba_ind_partitions
WHERE index_owner = 'SALES_OWN'
  AND status = 'UNUSABLE'
ORDER BY index_name, partition_position;

-- Partitioned index sub-partitions that are UNUSABLE
SELECT index_owner, index_name, partition_name, subpartition_name, status
FROM dba_ind_subpartitions
WHERE index_owner = 'SALES_OWN'
  AND status = 'UNUSABLE'
ORDER BY index_name, partition_name, subpartition_name;
\`\`\`

### Step 9.2: Rebuild UNUSABLE Index Partitions

\`\`\`sql
-- Rebuild a specific unusable global index partition
ALTER INDEX sales_own.idx_oh_custid_gpart
  REBUILD PARTITION gp_1 ONLINE PARALLEL 4;

-- Rebuild a specific unusable local index partition
ALTER INDEX sales_own.idx_oh_customer_local
  REBUILD PARTITION oh_2025_jan ONLINE PARALLEL 4;

-- Rebuild a non-partitioned global index (no PARTITION clause needed)
ALTER INDEX sales_own.idx_oh_orderid_global
  REBUILD ONLINE PARALLEL 4;
\`\`\`

### Step 9.3: Script to Rebuild All UNUSABLE Index Partitions (PL/SQL)

\`\`\`sql
-- Generate and execute REBUILD commands for all UNUSABLE index partitions
BEGIN
  FOR r IN (
    SELECT index_owner, index_name, partition_name
    FROM dba_ind_partitions
    WHERE index_owner = 'SALES_OWN'
      AND status = 'UNUSABLE'
    ORDER BY index_name, partition_position
  ) LOOP
    EXECUTE IMMEDIATE
      'ALTER INDEX ' || r.index_owner || '.' || r.index_name ||
      ' REBUILD PARTITION ' || r.partition_name || ' ONLINE PARALLEL 4';
    DBMS_OUTPUT.PUT_LINE('Rebuilt: ' || r.index_name || ' PARTITION ' || r.partition_name);
  END LOOP;

  -- Also rebuild any non-partitioned global indexes that are UNUSABLE
  FOR r IN (
    SELECT owner, index_name
    FROM dba_indexes
    WHERE owner = 'SALES_OWN'
      AND table_name = 'ORDER_HISTORY'
      AND status = 'UNUSABLE'
      AND partitioned = 'NO'
  ) LOOP
    EXECUTE IMMEDIATE
      'ALTER INDEX ' || r.owner || '.' || r.index_name || ' REBUILD ONLINE PARALLEL 4';
    DBMS_OUTPUT.PUT_LINE('Rebuilt global index: ' || r.index_name);
  END LOOP;
END;
/
\`\`\`

### Step 9.4: Validate All Index Partitions Are Usable After Rebuild

\`\`\`sql
-- Confirm no UNUSABLE partitions remain
SELECT COUNT(*) AS unusable_count
FROM dba_ind_partitions
WHERE index_owner = 'SALES_OWN'
  AND status = 'UNUSABLE';
-- Should return 0

SELECT COUNT(*) AS unusable_global_count
FROM dba_indexes
WHERE owner = 'SALES_OWN'
  AND table_name = 'ORDER_HISTORY'
  AND status = 'UNUSABLE';
-- Should return 0
\`\`\`

### Step 9.5: What Happens When an UNUSABLE Index Is Hit

\`\`\`sql
-- If SKIP_UNUSABLE_INDEXES = FALSE (default), a query that would use an UNUSABLE index
-- raises ORA-01502: index 'SALES_OWN.IDX_OH_ORDERID_GLOBAL' or partition of such index is in unusable state
-- Check current setting:
SHOW PARAMETER skip_unusable_indexes;

-- If SKIP_UNUSABLE_INDEXES = TRUE, Oracle silently falls back to a full table scan
-- instead of using the unusable index -- no error, but potentially much slower query
ALTER SESSION SET skip_unusable_indexes = FALSE;  -- strict mode: fail fast

-- Demonstrate the error (do NOT run against a real index in production):
-- CREATE INDEX sales_own.idx_test_unusable ON sales_own.order_history (status);
-- ALTER INDEX sales_own.idx_test_unusable UNUSABLE;
-- SELECT * FROM sales_own.order_history WHERE status = 'PENDING';
-- ORA-01502
\`\`\`

---

## Phase 10: Partitioning Health Dashboard

### Step 10.1: Comprehensive Partitioning Health Query

\`\`\`sql
-- Master health view: partition count, size, skew, interval status, row movement, index health
SELECT t.owner,
       t.table_name,
       COUNT(tp.partition_name)        AS partition_count,
       ROUND(SUM(NVL(s.bytes, 0)) / 1073741824, 2) AS total_size_gb,
       ROUND(MAX(NVL(s.bytes, 0)) / 1048576, 2)    AS largest_partition_mb,
       ROUND(MIN(NVL(s.bytes, 0)) / 1048576, 2)    AS smallest_partition_mb,
       ROUND(
         (MAX(NVL(s.bytes, 0)) - MIN(NVL(s.bytes, 0)))
         / NULLIF(AVG(NVL(s.bytes, 0)), 0), 2
       )                                             AS size_skew_ratio,
       t.row_movement,
       t.partitioning_type,
       t.interval                      AS interval_clause,
       MAX(o.last_ddl_time)            AS last_ddl_time,
       SUM(CASE WHEN ip.status = 'UNUSABLE' THEN 1 ELSE 0 END) AS unusable_index_parts,
       SUM(CASE WHEN ip.status = 'VALID'    THEN 1 ELSE 0 END) AS valid_index_parts
FROM dba_part_tables t
JOIN dba_tab_partitions tp
  ON tp.table_owner = t.owner
  AND tp.table_name = t.table_name
LEFT JOIN dba_segments s
  ON s.owner = tp.table_owner
  AND s.segment_name = tp.table_name
  AND s.partition_name = tp.partition_name
  AND s.segment_type = 'TABLE PARTITION'
LEFT JOIN dba_objects o
  ON o.owner = t.owner
  AND o.object_name = t.table_name
  AND o.object_type = 'TABLE'
LEFT JOIN dba_ind_partitions ip
  ON ip.index_owner = t.owner
LEFT JOIN dba_indexes i2
  ON i2.owner = ip.index_owner
  AND i2.index_name = ip.index_name
  AND i2.table_name = t.table_name
WHERE t.owner = 'SALES_OWN'
GROUP BY t.owner, t.table_name, t.row_movement,
         t.partitioning_type, t.interval
ORDER BY total_size_gb DESC;
\`\`\`

### Step 10.2: Recently Accessed Partitions from AWR (Hot Partition Detection)

\`\`\`sql
-- Hot partitions: highest logical reads in the last AWR snapshot window
SELECT o.owner,
       o.object_name AS table_name,
       o.subobject_name AS partition_name,
       SUM(st.logical_reads_delta) AS logical_reads,
       SUM(st.physical_reads_delta) AS physical_reads,
       SUM(st.buffer_busy_waits_delta) AS buffer_busy_waits,
       MAX(sn.end_interval_time) AS last_active
FROM dba_hist_seg_stat st
JOIN dba_hist_seg_stat_obj o
  ON o.dataobj# = st.dataobj#
  AND o.obj# = st.obj#
  AND o.dbid = st.dbid
JOIN dba_hist_snapshot sn
  ON sn.snap_id = st.snap_id
  AND sn.dbid = st.dbid
WHERE o.owner = 'SALES_OWN'
  AND o.object_name = 'ORDER_HISTORY'
  AND sn.end_interval_time >= SYSDATE - 7   -- last 7 days
GROUP BY o.owner, o.object_name, o.subobject_name
ORDER BY logical_reads DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

### Step 10.3: Full-Table-Scan Operations on Large Partitioned Tables from AWR (Pruning Failure Detection)

\`\`\`sql
-- SQL statements performing full scans on large partitioned tables
-- These are candidates for pruning fix (predicate review)
SELECT sp.sql_id,
       sp.object_owner,
       sp.object_name,
       sp.partition_start,
       sp.partition_stop,
       ss.executions_total,
       ss.buffer_gets_total,
       ROUND(ss.buffer_gets_total / NULLIF(ss.executions_total, 0)) AS avg_buffer_gets,
       SUBSTR(sq.sql_text, 1, 200) AS sql_preview
FROM dba_hist_sql_plan sp
JOIN dba_hist_sqlstat ss
  ON ss.sql_id = sp.sql_id
  AND ss.dbid = sp.dbid
JOIN dba_hist_sqltext sq
  ON sq.sql_id = sp.sql_id
  AND sq.dbid = sp.dbid
WHERE sp.operation = 'TABLE ACCESS'
  AND sp.options = 'FULL'
  AND sp.object_owner = 'SALES_OWN'
  AND sp.partition_start = '1'
  AND sp.partition_stop  = '1048575'   -- PARTITION RANGE ALL: no pruning
  AND ss.buffer_gets_total > 1000000   -- high-cost statements only
ORDER BY avg_buffer_gets DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

---

## Quick Reference: Partition DDL and Diagnostic Commands

\`\`\`sql
-- Check Partitioning option license
SELECT value FROM v\$option WHERE parameter = 'Partitioning';

-- List all partitions with size
SELECT partition_name, high_value, num_rows,
       ROUND(NVL(bytes,0)/1048576,2) AS size_mb
FROM dba_tab_partitions tp
LEFT JOIN dba_segments s ON s.owner=tp.table_owner
  AND s.segment_name=tp.table_name AND s.partition_name=tp.partition_name
WHERE tp.table_owner='SALES_OWN' AND tp.table_name='ORDER_HISTORY'
ORDER BY tp.partition_position;

-- Find all UNUSABLE index partitions
SELECT index_name, partition_name, status FROM dba_ind_partitions
WHERE index_owner='SALES_OWN' AND status='UNUSABLE';

-- Add partition (non-interval tables)
ALTER TABLE sales_own.order_history
  ADD PARTITION oh_new VALUES LESS THAN (DATE '2028-01-01');

-- Drop partition with global index maintenance
ALTER TABLE sales_own.order_history
  DROP PARTITION oh_2024_q1 UPDATE GLOBAL INDEXES;

-- Truncate partition (reset HWM, keep partition structure)
ALTER TABLE sales_own.order_history
  TRUNCATE PARTITION oh_2024_q2 UPDATE GLOBAL INDEXES;

-- Split partition
ALTER TABLE sales_own.order_history
  SPLIT PARTITION oh_maxval AT (DATE '2027-01-01')
  INTO (PARTITION oh_2026, PARTITION oh_maxval_new) UPDATE GLOBAL INDEXES;

-- Merge two adjacent partitions
ALTER TABLE sales_own.order_history
  MERGE PARTITIONS oh_2024_q3, oh_2024_q4
  INTO PARTITION oh_2024_h2 UPDATE GLOBAL INDEXES;

-- Exchange partition (bulk load pattern)
ALTER TABLE sales_own.order_history
  EXCHANGE PARTITION oh_2026_jun WITH TABLE sales_own.orders_staging
  INCLUDING INDEXES WITHOUT VALIDATION UPDATE GLOBAL INDEXES;

-- Online table conversion to partitioned (12.2+)
ALTER TABLE sales_own.order_history_old
  MODIFY PARTITION BY RANGE (order_date)
  INTERVAL (NUMTOYMINTERVAL(1,'MONTH'))
  ( PARTITION p_anchor VALUES LESS THAN (DATE '2025-01-01') ) ONLINE;

-- Enable row movement
ALTER TABLE sales_own.order_history ENABLE ROW MOVEMENT;

-- Rebuild unusable global index
ALTER INDEX sales_own.idx_oh_orderid_global REBUILD ONLINE PARALLEL 4;

-- Rebuild unusable local index partition
ALTER INDEX sales_own.idx_oh_customer_local REBUILD PARTITION oh_2025_jan ONLINE;

-- Explain plan with partition info
EXPLAIN PLAN FOR <query>;
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(format=>'TYPICAL +PARTITION'));

-- Gather partition statistics
BEGIN DBMS_STATS.GATHER_TABLE_STATS('SALES_OWN','ORDER_HISTORY',
  granularity=>'ALL',cascade=>TRUE,degree=>4); END;
/
\`\`\``,
};

async function main() {
  console.log('Inserting Oracle partitioning runbook post...');
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
