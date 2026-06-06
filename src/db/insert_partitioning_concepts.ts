import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Partitioning: Strategies, Internals, and Query Performance',
  slug: 'oracle-partitioning-strategies-internals-performance',
  excerpt:
    'A comprehensive guide to Oracle table partitioning covering range, list, hash, composite, reference, and interval strategies with deep dives into partition pruning internals, local vs global indexes, partition maintenance operations, and common diagnostic patterns for pruning failures and index maintenance issues.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-06'),
  youtubeUrl: null,
  content: `## Introduction

Oracle partitioning is the mechanism by which a single logical table or index is physically divided into multiple independent segments called partitions. From the application's perspective, a partitioned table is indistinguishable from a non-partitioned one — SQL queries, DML statements, and constraints work identically. Underneath the surface, however, Oracle stores each partition as a separate segment with its own extent allocation, high-water mark, and storage parameters. This physical separation is the foundation for everything partitioning delivers: query pruning, parallel execution affinity, and surgical maintenance operations.

The most important benefit partitioning delivers to query performance is **partition pruning**. When a query includes a predicate on the partition key column, the Oracle optimizer can determine at parse time (or execution time) which partitions could possibly contain qualifying rows and eliminate all others from consideration entirely. A query that would otherwise perform a full table scan across 500 GB of data may instead touch only 4 GB stored in a single monthly partition. No blocks from the other partitions are read, no buffer cache entries are created for them, and the I/O savings translate directly into elapsed time reduction. Partition pruning is not a hint or a workaround — it is a fundamental property of the optimizer when the partition key is present in the predicate.

Beyond pruning, partitioning enables **partition-wise joins**, where parallel slaves each process one partition pair independently without cross-partition shuffling — a dramatic reduction in sort and merge overhead for large analytical joins. It also enables **operational agility**: dropping the oldest monthly partition instead of running a DELETE that generates undo, redo, and blocks readers; exchanging a staging table into a partition in milliseconds as a data dictionary operation rather than a data move; splitting or merging partitions to rebalance storage without downtime. These maintenance capabilities are especially valuable for time-series data — transaction histories, log tables, sensor readings — where data naturally ages and the oldest data can be archived or discarded on a predictable schedule.

It is important to note that Oracle Partitioning is a separately licensed database option. It is included with Oracle Database Enterprise Edition when the Partitioning option license is purchased, but it is not available in Standard Edition. Before implementing any partitioning strategy in a production environment, verify that the Partitioning option is licensed. The query \`SELECT value FROM v\\$option WHERE parameter = 'Partitioning'\` returns TRUE or FALSE. This post covers all major partitioning strategies in depth, the internals of partition pruning, local versus global index design, partition maintenance operations, and common diagnostic patterns. The companion runbook provides ready-to-run SQL for every operation described here.

---

## Part 1: Partitioning Fundamentals

A partitioned table is defined by a **partition key** — one or more columns whose values determine which partition each row belongs to. The partitioning strategy (range, list, hash, or composite) defines the mapping rules from key values to partition segments. Oracle stores the partition metadata in the data dictionary: \`DBA_TAB_PARTITIONS\` lists every partition with its name, high value, and segment creation status; \`DBA_SEGMENTS\` holds the physical extent information.

\`\`\`sql
-- View all partitions and their segment sizes for a table
SELECT tp.partition_name,
       tp.high_value,
       tp.num_rows,
       tp.blocks,
       tp.last_analyzed,
       tp.segment_created,
       ROUND(s.bytes / 1048576, 2) AS size_mb
FROM dba_tab_partitions tp
LEFT JOIN dba_segments s
  ON s.owner = tp.table_owner
  AND s.segment_name = tp.table_name
  AND s.partition_name = tp.partition_name
WHERE tp.table_owner = 'SALES_OWN'
  AND tp.table_name = 'ORDER_HISTORY'
ORDER BY tp.partition_position;
\`\`\`

The \`SEGMENT_CREATED\` column in \`DBA_TAB_PARTITIONS\` reflects Oracle's **deferred segment creation** feature (introduced in 11g). When a partitioned table is created, segments for empty partitions may not be allocated until the first row is inserted. This conserves space in environments where many partitions are pre-created but only a few currently hold data.

### Global vs Local Indexes

Every index on a partitioned table is either **local** or **global**:

- A **local index** has one index partition per table partition. Each index partition covers exactly the rows in its corresponding table partition. Local indexes are automatically maintained in sync with partition operations — dropping a table partition also drops the corresponding index partition. After a partition DDL operation, all local index partitions remain usable.

- A **global index** spans all table partitions in a single index structure (or in multiple index partitions for a global partitioned index). Global indexes must be maintained explicitly when partition DDL operations occur. If a partition is dropped without \`UPDATE GLOBAL INDEXES\`, the global index is marked UNUSABLE.

\`\`\`sql
-- Check index type and partition status
SELECT i.index_name,
       i.partitioned,
       i.locality,         -- LOCAL or GLOBAL (for partitioned indexes)
       i.status,
       ip.partition_name,
       ip.status AS partition_status
FROM dba_indexes i
LEFT JOIN dba_ind_partitions ip
  ON ip.index_owner = i.owner
  AND ip.index_name = i.index_name
WHERE i.owner = 'SALES_OWN'
  AND i.table_name = 'ORDER_HISTORY'
ORDER BY i.index_name, ip.partition_position;
\`\`\`

### Partition Pruning and Execution Plans

Partition pruning is visible in execution plans through the \`PARTITION RANGE\` operation row:

- **PARTITION RANGE SINGLE** — the optimizer determined exactly one partition needs to be accessed (equality predicate on the partition key with a literal value).
- **PARTITION RANGE ITERATOR** — the optimizer determined a range of partitions needs to be accessed (range predicate, or interval).
- **PARTITION RANGE ALL** — no pruning occurred; all partitions will be scanned. This is the warning sign indicating the predicate did not enable pruning.
- **PARTITION RANGE INLIST** — an IN-list predicate on the partition key; specific partitions are identified.

\`\`\`sql
-- Check for pruning in an execution plan
EXPLAIN PLAN FOR
SELECT COUNT(*) FROM sales_own.order_history
WHERE order_date >= DATE '2026-01-01'
  AND order_date < DATE '2026-02-01';

SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(format => 'TYPICAL +PARTITION'));
\`\`\`

The \`+PARTITION\` format element adds the \`Pstart\` and \`Pstop\` columns to the plan output, showing the start and stop partition numbers accessed. When pruning succeeds, \`Pstart\` and \`Pstop\` are specific partition numbers. When pruning fails, they show \`1\` and \`1048575\` (the maximum partition ID), meaning all partitions are scanned.

---

## Part 2: Range Partitioning

Range partitioning divides rows based on whether the partition key value falls within a defined range. It is the natural fit for time-series data — each range partition holds rows for a specific period (day, month, quarter, year). The partition key is almost always a DATE or TIMESTAMP column.

\`\`\`sql
-- Basic range partitioning by month (pre-create partitions)
CREATE TABLE sales_own.order_history (
  order_id        NUMBER(12)    NOT NULL,
  order_date      DATE          NOT NULL,
  customer_id     NUMBER(10)    NOT NULL,
  order_total     NUMBER(14,2),
  status          VARCHAR2(20)
)
PARTITION BY RANGE (order_date) (
  PARTITION oh_2025_q1 VALUES LESS THAN (DATE '2025-04-01'),
  PARTITION oh_2025_q2 VALUES LESS THAN (DATE '2025-07-01'),
  PARTITION oh_2025_q3 VALUES LESS THAN (DATE '2025-10-01'),
  PARTITION oh_2025_q4 VALUES LESS THAN (DATE '2026-01-01'),
  PARTITION oh_2026_q1 VALUES LESS THAN (DATE '2026-04-01'),
  PARTITION oh_maxval  VALUES LESS THAN (MAXVALUE)
);
\`\`\`

The \`MAXVALUE\` partition is a catch-all that receives any row whose key value exceeds all explicitly defined partition boundaries. It prevents \`ORA-14400: inserted partition key does not map to any partition\` errors when new data arrives before a new partition is added.

### Interval Partitioning (11g+)

Interval partitioning extends range partitioning by automatically creating new partitions when rows arrive that would fall beyond the last explicitly defined partition. You define the interval size, and Oracle handles partition creation transparently.

\`\`\`sql
-- Interval partitioning — monthly intervals, automatic partition creation
CREATE TABLE sales_own.order_history_iv (
  order_id        NUMBER(12)    NOT NULL,
  order_date      DATE          NOT NULL,
  customer_id     NUMBER(10)    NOT NULL,
  order_total     NUMBER(14,2),
  status          VARCHAR2(20)
)
PARTITION BY RANGE (order_date)
INTERVAL (NUMTOYMINTERVAL(1, 'MONTH'))
(
  -- Must define at least one partition to establish the range anchor
  PARTITION oh_before_2025 VALUES LESS THAN (DATE '2025-01-01')
);
\`\`\`

When the first row with \`order_date = DATE '2026-06-15'\` is inserted, Oracle automatically creates a partition for the June 2026 interval. The partition is named \`SYS_Pnnn\` by Oracle unless explicitly named. With \`NUMTOYMINTERVAL(1, 'MONTH')\`, each auto-created partition spans exactly one calendar month.

For daily intervals, use \`NUMTODSINTERVAL(1, 'DAY')\`. For weekly intervals, use \`NUMTODSINTERVAL(7, 'DAY')\`.

\`\`\`sql
-- Verify interval partitions were created automatically
SELECT partition_name,
       high_value,
       interval,
       segment_created
FROM dba_tab_partitions
WHERE table_owner = 'SALES_OWN'
  AND table_name = 'ORDER_HISTORY_IV'
ORDER BY partition_position;
-- INTERVAL column shows YES for auto-created partitions, NO for the manually defined anchor
\`\`\`

### Range Pruning with Date Predicates

The partition key predicate must use the same data type as the partition key to avoid implicit conversion failures. If the partition key is DATE, the predicate must be DATE:

\`\`\`sql
-- Correct: DATE literal matches DATE partition key — pruning fires
SELECT * FROM sales_own.order_history
WHERE order_date >= DATE '2026-01-01'
  AND order_date < DATE '2026-02-01';

-- Wrong: TO_DATE with format mask still produces DATE but can cause issues
-- with some optimizer versions — use DATE literal form when possible
SELECT * FROM sales_own.order_history
WHERE order_date >= TO_DATE('2026-01-01', 'YYYY-MM-DD');

-- Wrong: TIMESTAMP predicate on a DATE partition key may cause pruning failure
-- Oracle must convert DATE to TIMESTAMP for comparison, wrapping the column in a function
SELECT * FROM sales_own.order_history
WHERE order_date >= TIMESTAMP '2026-01-01 00:00:00';
-- Plan will show PARTITION RANGE ALL if the optimizer cannot resolve the type conflict
\`\`\`

---

## Part 3: List Partitioning

List partitioning maps rows to partitions based on a discrete set of column values. It is the right choice when the partition key is a categorical column — region codes, country codes, product type codes, status values — where the values do not have a natural ordering that range partitioning could exploit.

\`\`\`sql
-- List partitioning by region
CREATE TABLE sales_own.regional_sales (
  sale_id     NUMBER(12)  NOT NULL,
  region_code VARCHAR2(10) NOT NULL,
  sale_date   DATE        NOT NULL,
  amount      NUMBER(14,2)
)
PARTITION BY LIST (region_code) (
  PARTITION rs_apac    VALUES ('APAC', 'ANZ', 'SEA'),
  PARTITION rs_emea    VALUES ('EMEA', 'UK', 'DACH'),
  PARTITION rs_americas VALUES ('NA', 'LATAM', 'CA'),
  PARTITION rs_default VALUES (DEFAULT)
);
\`\`\`

The \`DEFAULT\` partition is the list partitioning equivalent of \`MAXVALUE\`. It catches any row whose partition key value does not match any explicitly listed value set. Without a DEFAULT partition, inserting a row with an unlisted region code raises \`ORA-14400\`.

### Composite List Partitioning

List partitioning can be combined with another strategy as the sub-partitioning level:

\`\`\`sql
-- List-Range composite: list on region, range on sale_date
CREATE TABLE sales_own.regional_sales_comp (
  sale_id     NUMBER(12)   NOT NULL,
  region_code VARCHAR2(10) NOT NULL,
  sale_date   DATE         NOT NULL,
  amount      NUMBER(14,2)
)
PARTITION BY LIST (region_code)
SUBPARTITION BY RANGE (sale_date)
SUBPARTITION TEMPLATE (
  SUBPARTITION sp_2025 VALUES LESS THAN (DATE '2026-01-01'),
  SUBPARTITION sp_2026 VALUES LESS THAN (DATE '2027-01-01'),
  SUBPARTITION sp_maxval VALUES LESS THAN (MAXVALUE)
)
(
  PARTITION rs_apac    VALUES ('APAC', 'ANZ', 'SEA'),
  PARTITION rs_emea    VALUES ('EMEA', 'UK', 'DACH'),
  PARTITION rs_default VALUES (DEFAULT)
);
\`\`\`

When list beats range: if the partition key is a nominal categorical variable with no inherent order (e.g., ISO country codes), range partitioning is meaningless — 'US' is not less than 'GB' in any analytically useful sense. List partitioning maps each discrete value set to a specific partition, enabling pruning on equality and IN-list predicates.

---

## Part 4: Hash Partitioning

Hash partitioning applies a hash function to the partition key value and uses the result to assign each row to one of N partitions. The distribution is determined entirely by the hash algorithm — you cannot predict or control which partition a specific row lands in. This is intentional: the goal of hash partitioning is to distribute rows as evenly as possible across all partitions.

\`\`\`sql
-- Hash partitioning on customer_id into 8 partitions
CREATE TABLE sales_own.customer_data (
  customer_id   NUMBER(10)   NOT NULL,
  customer_name VARCHAR2(200) NOT NULL,
  signup_date   DATE,
  tier          VARCHAR2(20)
)
PARTITION BY HASH (customer_id)
PARTITIONS 8
STORE IN (users_ts1, users_ts2, users_ts3, users_ts4,
          users_ts5, users_ts6, users_ts7, users_ts8);
\`\`\`

The number of hash partitions should be a **power of 2** (2, 4, 8, 16, 32...) for even distribution. Oracle's hash function is designed to distribute values uniformly across a power-of-2 partition count; using a non-power-of-2 count results in some partitions receiving more rows than others.

### When Hash Partitioning Delivers Value

Hash partitioning does not enable partition pruning for range queries (since the hash mapping is opaque). However, it provides two important benefits:

1. **Partition-wise joins**: When two tables are hash-partitioned on the same join key with the same number of partitions, a join between them becomes a partition-wise join — each parallel slave processes one partition pair independently, eliminating the cross-partition sort and redistribution that would otherwise be required.

2. **RAC affinity**: In an Oracle RAC environment, hash partitions can be assigned to specific RAC nodes, improving cache affinity and reducing inter-node traffic.

\`\`\`sql
-- Partition-wise join requires matching hash partition key and partition count
-- Both tables partitioned on customer_id PARTITIONS 8 enables partition-wise join
EXPLAIN PLAN FOR
SELECT c.customer_name, SUM(o.order_total)
FROM sales_own.customer_data c
JOIN sales_own.orders o ON c.customer_id = o.customer_id
GROUP BY c.customer_name;

SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(format => 'TYPICAL +PARTITION'));
-- Look for: PARTITION HASH ALL with PX SEND PARTITION (KEY) — indicates partition-wise join
\`\`\`

---

## Part 5: Composite Partitioning

Composite partitioning applies two levels of partitioning: each top-level partition is further subdivided into sub-partitions using a different strategy. This combines the benefits of both strategies — the top-level strategy for pruning and manageability, the sub-level strategy for fine-grained distribution or secondary pruning.

### Range-Hash (Most Common Composite Pattern)

Range on a date column for time-based pruning and maintenance, hash on a second column for even distribution within each range partition. This prevents "hot partition" problems where a single range partition receives a disproportionate share of DML activity.

\`\`\`sql
-- Range-Hash composite: monthly range on order_date, hash on customer_id
CREATE TABLE sales_own.orders_comp (
  order_id      NUMBER(12)   NOT NULL,
  order_date    DATE         NOT NULL,
  customer_id   NUMBER(10)   NOT NULL,
  order_total   NUMBER(14,2),
  status        VARCHAR2(20)
)
PARTITION BY RANGE (order_date)
INTERVAL (NUMTOYMINTERVAL(1, 'MONTH'))
SUBPARTITION BY HASH (customer_id)
SUBPARTITIONS 4
(
  PARTITION oc_before_2025 VALUES LESS THAN (DATE '2025-01-01')
);
-- Each range partition (month) is divided into 4 hash sub-partitions by customer_id
\`\`\`

### Range-List Composite

Range on date for time-based pruning, list on region for geographic partitioning:

\`\`\`sql
-- Range-List composite with subpartition template
CREATE TABLE sales_own.orders_rl (
  order_id      NUMBER(12)   NOT NULL,
  order_date    DATE         NOT NULL,
  region        VARCHAR2(10) NOT NULL,
  order_total   NUMBER(14,2)
)
PARTITION BY RANGE (order_date)
INTERVAL (NUMTOYMINTERVAL(1, 'MONTH'))
SUBPARTITION BY LIST (region)
SUBPARTITION TEMPLATE (
  SUBPARTITION sp_apac    VALUES ('APAC', 'ANZ'),
  SUBPARTITION sp_emea    VALUES ('EMEA', 'UK'),
  SUBPARTITION sp_amer    VALUES ('NA', 'LATAM'),
  SUBPARTITION sp_other   VALUES (DEFAULT)
)
(
  PARTITION orl_before_2025 VALUES LESS THAN (DATE '2025-01-01')
);
\`\`\`

The **subpartition template** defines the sub-partition structure once; it is automatically applied to every range partition created, including auto-created interval partitions. When both the range key and the list key appear in a query predicate, Oracle can prune at both levels — first to the correct month partition, then to the correct region sub-partition.

---

## Part 6: Reference Partitioning (11g+)

Reference partitioning allows a **child table** to inherit its partitioning structure from a **parent table** through a foreign key relationship. The child table does not need to store the partition key column — Oracle determines the correct partition for each child row by following the foreign key to the parent.

\`\`\`sql
-- Parent table: orders partitioned by range on order_date
CREATE TABLE sales_own.orders_ref_parent (
  order_id    NUMBER(12)  NOT NULL,
  order_date  DATE        NOT NULL,
  customer_id NUMBER(10)  NOT NULL,
  CONSTRAINT orders_ref_pk PRIMARY KEY (order_id)
)
PARTITION BY RANGE (order_date)
INTERVAL (NUMTOYMINTERVAL(1, 'MONTH'))
(
  PARTITION orp_before_2025 VALUES LESS THAN (DATE '2025-01-01')
);

-- Child table: order_lines reference-partitioned through the FK to orders
CREATE TABLE sales_own.order_lines_ref (
  line_id     NUMBER(12)  NOT NULL,
  order_id    NUMBER(12)  NOT NULL,
  product_id  NUMBER(10)  NOT NULL,
  quantity    NUMBER(6),
  unit_price  NUMBER(10,2),
  CONSTRAINT olr_pk  PRIMARY KEY (line_id),
  CONSTRAINT olr_fk  FOREIGN KEY (order_id)
    REFERENCES sales_own.orders_ref_parent (order_id)
)
PARTITION BY REFERENCE (olr_fk);
-- No PARTITION BY RANGE clause needed -- inherited from parent through FK
\`\`\`

When a query filters on \`order_date\` against the parent table, partition pruning propagates automatically to the child table. A join between \`orders_ref_parent\` and \`order_lines_ref\` filtered by date prunes both tables to the same partition — no cross-partition work required. This is the canonical example of reference partitioning's value: parent and child are co-partitioned by relationship rather than by duplicating the partition key in the child.

Requirements: the foreign key must be NOT NULL, enabled, and validated. The FK columns must form the complete primary key of the parent (or a unique key subset).

---

## Part 7: Interval-Reference Partitioning

Interval-reference partitioning combines interval partitioning on the parent with reference partitioning on the child. When a new interval partition is auto-created in the parent (because a row with a new date range arrives), a corresponding partition is automatically created in the child table.

\`\`\`sql
-- The same DDL as the reference partitioning example above already supports this:
-- The parent uses INTERVAL (NUMTOYMINTERVAL(1,'MONTH'))
-- The child uses PARTITION BY REFERENCE (olr_fk)
-- When a row is inserted into the parent with a new month, Oracle creates a new
-- partition in BOTH the parent and the child simultaneously.
-- No manual ADD PARTITION is needed for either table.

-- Verify both parent and child partitions stay in sync
SELECT p.partition_name AS parent_partition,
       c.partition_name AS child_partition,
       p.high_value
FROM dba_tab_partitions p
JOIN dba_tab_partitions c
  ON c.table_owner = 'SALES_OWN'
  AND c.table_name = 'ORDER_LINES_REF'
  AND c.partition_position = p.partition_position
WHERE p.table_owner = 'SALES_OWN'
  AND p.table_name = 'ORDERS_REF_PARENT'
ORDER BY p.partition_position;
\`\`\`

This combination eliminates all manual partition management for time-series parent-child table pairs. The DBA simply monitors partition growth; Oracle handles creation automatically at both levels.

---

## Part 8: Virtual Column Partitioning

Virtual column partitioning uses a column defined as an expression rather than a physically stored value as the partition key. The virtual column is computed on-the-fly during DML and queries but is never stored in the data block.

\`\`\`sql
-- Virtual column partitioning: partition by year extracted from order_date
CREATE TABLE sales_own.orders_vc (
  order_id    NUMBER(12)   NOT NULL,
  order_date  DATE         NOT NULL,
  customer_id NUMBER(10)   NOT NULL,
  order_total NUMBER(14,2),
  -- Virtual column: computed from order_date, not stored physically
  order_year  NUMBER(4)    GENERATED ALWAYS AS (EXTRACT(YEAR FROM order_date)) VIRTUAL
)
PARTITION BY RANGE (order_year) (
  PARTITION ovc_2023 VALUES LESS THAN (2024),
  PARTITION ovc_2024 VALUES LESS THAN (2025),
  PARTITION ovc_2025 VALUES LESS THAN (2026),
  PARTITION ovc_2026 VALUES LESS THAN (2027),
  PARTITION ovc_maxval VALUES LESS THAN (MAXVALUE)
);
\`\`\`

When a query includes \`WHERE EXTRACT(YEAR FROM order_date) = 2026\` or \`WHERE order_year = 2026\`, Oracle recognizes the match with the virtual column definition and applies partition pruning. The partition key is effectively a function of the physical column without the overhead of storing the computed result.

Virtual column partitioning is useful when the natural partition key is derived: partitioning by fiscal quarter (which may not align with calendar months), by a hash bucket of multiple columns, or by any deterministic expression over the physical columns.

---

## Part 9: Partition Pruning Internals

Understanding partition pruning at the engine level explains both why it works and why it sometimes fails.

### Static vs Dynamic Pruning

**Static pruning** is determined at parse time when the predicate contains a literal value. The optimizer knows at cursor compilation exactly which partitions will be accessed. The \`Pstart\` and \`Pstop\` columns in the plan show specific partition numbers.

**Dynamic pruning** is determined at execution time when the predicate contains a bind variable or a join condition (partition-wise join pruning). The plan shows \`KEY\` or \`KEY(AP)\` in \`Pstart\`/\`Pstop\`, indicating the partition number will be resolved at runtime.

\`\`\`sql
-- Static pruning: literal date -- Pstart/Pstop show specific partition numbers at parse time
EXPLAIN PLAN FOR
SELECT COUNT(*) FROM sales_own.order_history
WHERE order_date = DATE '2026-06-01';

-- Dynamic pruning: bind variable -- Pstart/Pstop show KEY, resolved at execution time
VARIABLE v_date VARCHAR2(20);
EXEC :v_date := '2026-06-01';

EXPLAIN PLAN FOR
SELECT COUNT(*) FROM sales_own.order_history
WHERE order_date = TO_DATE(:v_date, 'YYYY-MM-DD');

SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(format => 'TYPICAL +PARTITION'));
\`\`\`

### Bind Variable Peeking and Partition Pruning

Bind variable peeking allows Oracle to look at the actual bind variable value during the first hard parse and generate an execution plan optimized for that specific value. For partition pruning with bind variables, peeking enables dynamic pruning to behave like static pruning for the first execution. However, if the plan is shared from cursor cache by a subsequent call with a different bind value that maps to a different partition, the plan may still show the original partition numbers — adaptive cursor sharing (ACS) handles this by generating child cursors for significantly different bind values.

### Partition-Wise Joins

In a parallel query, when two tables are partitioned on the same join key with the same number of partitions, Oracle can assign each parallel slave a single partition pair to join independently. This eliminates the \`PX SEND PARTITION\` redistribution step that would otherwise be needed to bring matching rows together across partitions.

\`\`\`sql
-- Verify partition-wise join in a parallel query
EXPLAIN PLAN FOR
SELECT /*+ PARALLEL(o 4) PARALLEL(c 4) */
       c.customer_name, COUNT(*) AS order_count
FROM sales_own.orders o
JOIN sales_own.customer_data c ON o.customer_id = c.customer_id
GROUP BY c.customer_name;

SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(format => 'TYPICAL +PARTITION'));
-- Look for: PX PARTITION HASH ALL or PX PARTITION HASH JOIN-FILTER
-- indicating partition-wise join is being used
\`\`\`

### Common Reason Pruning Fails: Implicit Type Conversion

The single most common cause of partition pruning failure is an implicit data type conversion on the partition key predicate. If the partition key is defined as DATE and the predicate passes a TIMESTAMP, or if a function is applied to the column, Oracle cannot use the partition key value directly to determine the target partition.

\`\`\`sql
-- PRUNING FAILS: function applied to the partition key column
SELECT * FROM sales_own.order_history
WHERE TRUNC(order_date) = DATE '2026-06-01';
-- Plan shows PARTITION RANGE ALL — TRUNC() wraps the column, breaking pruning

-- PRUNING FAILS: TIMESTAMP predicate on DATE partition key
SELECT * FROM sales_own.order_history
WHERE order_date = TIMESTAMP '2026-06-01 00:00:00';
-- Oracle may convert DATE to TIMESTAMP for comparison, losing pruning

-- PRUNING WORKS: range predicate without function on the column
SELECT * FROM sales_own.order_history
WHERE order_date >= DATE '2026-06-01'
  AND order_date < DATE '2026-06-02';
-- Plan shows PARTITION RANGE SINGLE
\`\`\`

The fix is always the same: rewrite the predicate to use a range comparison against DATE literals rather than applying a function to the column.

---

## Part 10: Local vs Global Indexes

The choice between local and global indexes is one of the most consequential design decisions for a partitioned table. The tradeoffs are clear once the use cases are understood.

### Local Indexes

A local index has one index partition per table partition, co-located with its data partition. The partition key for the index matches the partition key for the table. After any partition DDL operation (DROP, TRUNCATE, SPLIT, MERGE, EXCHANGE), all remaining local index partitions are automatically updated and remain VALID — no rebuild is required.

\`\`\`sql
-- Create a local index on the non-key column (covers queries within a partition)
CREATE INDEX sales_own.idx_oh_customer_local
  ON sales_own.order_history (customer_id)
  LOCAL;

-- Create a local index on the partition key (typically for covering index patterns)
CREATE INDEX sales_own.idx_oh_date_local
  ON sales_own.order_history (order_date, order_total)
  LOCAL;
\`\`\`

**Best use case for local indexes**: DWH range queries that filter by the partition key (so pruning eliminates most partitions, and the local index handles the remaining work within the accessed partition); any table undergoing frequent partition DDL operations where rebuilding global indexes would be disruptive.

**Limitation**: If a query does not include the partition key in its predicate, a local index access requires Oracle to probe every index partition — there are N separate B-tree lookups for an N-partition table. For high-frequency OLTP lookups by a non-key column (e.g., lookup by order_id on a date-partitioned table), a local index on order_id forces N probes. A global index on order_id requires exactly one probe.

### Global Indexes

A global (non-partitioned) index spans all table partitions in a single B-tree structure. It provides exactly one probe regardless of how many partitions the table has.

\`\`\`sql
-- Global non-partitioned index: optimal for unique lookups not involving the partition key
CREATE UNIQUE INDEX sales_own.idx_oh_orderid_global
  ON sales_own.order_history (order_id)
  GLOBAL;
\`\`\`

**Best use case for global indexes**: Unique constraints that span partition key boundaries (order_id must be unique across all date partitions); high-frequency OLTP lookups by a non-partition-key column where single-probe access is critical.

**Limitation**: After partition DDL without \`UPDATE GLOBAL INDEXES\`, global indexes are marked UNUSABLE. Every partition maintenance operation must include the clause, or a post-DDL index rebuild must be scheduled.

### Global Partitioned Indexes

A global index can itself be partitioned (range or hash) to reduce index partition maintenance overhead and enable parallel DDL on the index:

\`\`\`sql
-- Global range-partitioned index
CREATE INDEX sales_own.idx_oh_custid_gpart
  ON sales_own.order_history (customer_id)
  GLOBAL PARTITION BY RANGE (customer_id) (
    PARTITION gp_low    VALUES LESS THAN (100000),
    PARTITION gp_mid    VALUES LESS THAN (500000),
    PARTITION gp_high   VALUES LESS THAN (MAXVALUE)
  );
\`\`\`

Global partitioned indexes still require \`UPDATE GLOBAL INDEXES\` after partition DDL, but the maintenance overhead is lower than a fully non-partitioned global index because only the affected index partition need be rebuilt.

---

## Part 11: Partition Maintenance Operations

### ADD PARTITION

For range-partitioned tables without interval, new partitions must be added explicitly before data arrives that would exceed the MAXVALUE boundary:

\`\`\`sql
-- Add a new quarterly partition before the MAXVALUE partition
ALTER TABLE sales_own.order_history
  ADD PARTITION oh_2026_q2 VALUES LESS THAN (DATE '2026-07-01');
-- With interval partitioning, this is not needed -- Oracle auto-creates partitions
\`\`\`

### DROP PARTITION

Dropping a partition is instantaneous and resets the HWM (high water mark) for the segment, releasing storage:

\`\`\`sql
-- Drop an old partition and maintain global indexes
ALTER TABLE sales_own.order_history
  DROP PARTITION oh_2025_q1
  UPDATE GLOBAL INDEXES;
-- Without UPDATE GLOBAL INDEXES, global indexes become UNUSABLE
\`\`\`

### TRUNCATE PARTITION

Truncating a partition removes all rows and resets the HWM without dropping the partition structure. Much faster than a DELETE and generates minimal undo:

\`\`\`sql
ALTER TABLE sales_own.order_history
  TRUNCATE PARTITION oh_2025_q2
  UPDATE GLOBAL INDEXES;
\`\`\`

### SPLIT PARTITION

Split divides one large partition into two:

\`\`\`sql
-- Split the MAXVALUE catch-all partition into two specific partitions
ALTER TABLE sales_own.order_history
  SPLIT PARTITION oh_maxval AT (DATE '2027-01-01')
  INTO (PARTITION oh_2026_all, PARTITION oh_maxval_new)
  UPDATE GLOBAL INDEXES;
\`\`\`

### MERGE PARTITION

Merge combines two adjacent partitions (must be adjacent in partition key order) into one:

\`\`\`sql
-- Merge two adjacent quarterly partitions into a semi-annual partition
ALTER TABLE sales_own.order_history
  MERGE PARTITIONS oh_2025_q3, oh_2025_q4
  INTO PARTITION oh_2025_h2
  UPDATE GLOBAL INDEXES;
\`\`\`

### EXCHANGE PARTITION — High-Speed Bulk Load

Exchange partition swaps the data and index segments between a partition and a non-partitioned staging table. It is a data dictionary operation — no data moves. The staging table becomes the partition and the old partition segment becomes the staging table. This is the fastest possible mechanism for loading data into a partitioned table in bulk.

\`\`\`sql
-- Step 1: Create a staging table with identical structure (no partition clause)
CREATE TABLE sales_own.orders_staging AS
  SELECT * FROM sales_own.order_history WHERE 1=0;

-- Step 2: Load data into the staging table (bulk insert, direct-path, etc.)
INSERT /*+ APPEND */ INTO sales_own.orders_staging
  SELECT * FROM sales_own.orders_source_data
  WHERE order_date >= DATE '2026-06-01'
    AND order_date < DATE '2026-07-01';
COMMIT;

-- Step 3: Create matching indexes on the staging table
CREATE INDEX sales_own.idx_stg_cust ON sales_own.orders_staging (customer_id);

-- Step 4: Exchange the staging table into the target partition
-- WITH VALIDATION checks all rows satisfy the partition bounds
ALTER TABLE sales_own.order_history
  EXCHANGE PARTITION oh_2026_q2
  WITH TABLE sales_own.orders_staging
  INCLUDING INDEXES
  WITHOUT VALIDATION   -- skip row validation for performance (ensure data is correct first)
  UPDATE GLOBAL INDEXES;
-- The staging table now holds the old (empty) partition segment
-- The partition now holds the loaded data
-- This operation takes milliseconds regardless of row count
\`\`\`

---

## Part 12: Row Movement

When the partition key value of a row is updated and the new value maps to a different partition, Oracle must physically move the row from its current partition to the target partition. This is only allowed when \`ENABLE ROW MOVEMENT\` is set on the table.

\`\`\`sql
-- Enable row movement to allow UPDATE to cross partition boundaries
ALTER TABLE sales_own.order_history ENABLE ROW MOVEMENT;

-- Without this, an UPDATE that changes order_date to a different partition raises:
-- ORA-14402: updating partition key column would cause a partition change

-- Verify row movement status
SELECT table_name, row_movement
FROM dba_tables
WHERE owner = 'SALES_OWN'
  AND table_name = 'ORDER_HISTORY';
-- ROW_MOVEMENT: ENABLED or DISABLED
\`\`\`

Row movement has a performance implication: moving a row requires a DELETE from the current partition and an INSERT into the target partition, not an in-place update. For tables where partition key corrections are rare or non-existent, it is safe to leave row movement disabled (the default) to prevent accidental data shuffling.

---

## Part 13: Partial Indexing (12c+)

Partial indexing allows individual partitions to be marked \`INDEXING OFF\`, meaning no index entries are maintained for rows in those partitions. Only partitions marked \`INDEXING ON\` (the default) participate in the index. This is valuable for time-series tables where recent "hot" partitions need index support for OLTP queries, but historical partitions are only accessed via full partition scans in batch analytics.

\`\`\`sql
-- Create a table with selective partitions marked INDEXING OFF
CREATE TABLE sales_own.orders_partial (
  order_id    NUMBER(12)  NOT NULL,
  order_date  DATE        NOT NULL,
  customer_id NUMBER(10)  NOT NULL,
  order_total NUMBER(14,2)
)
PARTITION BY RANGE (order_date)
INTERVAL (NUMTOYMINTERVAL(1, 'MONTH'))
(
  -- Historical partitions: INDEXING OFF to reduce index maintenance
  PARTITION op_2024 VALUES LESS THAN (DATE '2025-01-01') INDEXING OFF,
  PARTITION op_2025 VALUES LESS THAN (DATE '2026-01-01') INDEXING OFF,
  -- Current-year partitions: INDEXING ON (default) for OLTP access
  PARTITION op_2026_jan VALUES LESS THAN (DATE '2026-02-01') INDEXING ON
);

-- Create a partial local index (only covers partitions with INDEXING ON)
CREATE INDEX sales_own.idx_op_cust_partial
  ON sales_own.orders_partial (customer_id)
  LOCAL
  INDEXING PARTIAL;
-- The index will have entries only for partitions where INDEXING = ON
\`\`\`

When a query accesses a partition marked \`INDEXING OFF\`, Oracle cannot use the partial index for that partition and performs a partition full scan instead. For historical analytics where full scans are expected anyway, this eliminates the index maintenance overhead during bulk loads into new partitions.

---

## Part 14: Common Problems and Diagnostics

### Partition Pruning Not Firing

The most frequent cause is implicit conversion on the partition key. Diagnostic:

\`\`\`sql
-- Run EXPLAIN PLAN and look for PARTITION RANGE ALL
EXPLAIN PLAN FOR <your_query>;
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(format => 'TYPICAL +PARTITION'));

-- If Pstart=1 and Pstop=1048575, pruning failed.
-- Check the filter predicates section for function wrapping the partition key.
-- Common culprits: TRUNC(), TO_CHAR(), SUBSTR() applied to the partition key column,
-- or TIMESTAMP literal used against a DATE partition key.
\`\`\`

### Global Index Becomes UNUSABLE After Partition DDL

\`\`\`sql
-- Find all UNUSABLE global index partitions after a partition operation
SELECT index_owner, index_name, partition_name, status
FROM dba_ind_partitions
WHERE status = 'UNUSABLE'
ORDER BY index_owner, index_name;

-- Also check non-partitioned global indexes
SELECT owner, index_name, status
FROM dba_indexes
WHERE status = 'UNUSABLE'
  AND partitioned = 'NO';

-- Rebuild all unusable index partitions
ALTER INDEX sales_own.idx_oh_orderid_global REBUILD;
\`\`\`

### MAXVALUE Partition Filling Up

If interval partitioning is not enabled, new data beyond the last explicit boundary goes to MAXVALUE. Monitor MAXVALUE partition size:

\`\`\`sql
SELECT tp.partition_name, tp.high_value, tp.num_rows,
       ROUND(s.bytes / 1048576, 2) AS size_mb
FROM dba_tab_partitions tp
JOIN dba_segments s
  ON s.owner = tp.table_owner
  AND s.segment_name = tp.table_name
  AND s.partition_name = tp.partition_name
WHERE tp.table_owner = 'SALES_OWN'
  AND tp.table_name = 'ORDER_HISTORY'
  AND tp.high_value = 'MAXVALUE'
ORDER BY size_mb DESC;
\`\`\`

### Partition Skew

One partition vastly larger than others indicates a skewed partition key distribution (common with hash partitioning on a low-cardinality or skewed key, or range partitioning where historical catch-all partitions are not split):

\`\`\`sql
-- Identify partition size skew
SELECT partition_name, num_rows,
       ROUND(bytes / 1048576, 2) AS size_mb,
       ROUND(bytes / SUM(bytes) OVER () * 100, 1) AS pct_of_total
FROM dba_tab_partitions tp
JOIN dba_segments s
  ON s.owner = tp.table_owner
  AND s.segment_name = tp.table_name
  AND s.partition_name = tp.partition_name
WHERE tp.table_owner = 'SALES_OWN'
  AND tp.table_name = 'ORDER_HISTORY'
ORDER BY bytes DESC;
\`\`\`

### ORA-14402: Row Movement Not Enabled

If application code updates the partition key column and crosses a partition boundary:

\`\`\`sql
-- Check which tables have partition key update attempts without row movement
SELECT table_name, row_movement, partitioned
FROM dba_tables
WHERE owner = 'SALES_OWN'
  AND partitioned = 'YES'
  AND row_movement = 'DISABLED';

-- Enable row movement if needed
ALTER TABLE sales_own.order_history ENABLE ROW MOVEMENT;
\`\`\`

### Exchange Partition Leaves Global Indexes UNUSABLE

If \`UPDATE GLOBAL INDEXES\` was omitted from the EXCHANGE PARTITION command, rebuild them immediately:

\`\`\`sql
-- Rebuild specific global index after exchange without UPDATE GLOBAL INDEXES
ALTER INDEX sales_own.idx_oh_orderid_global REBUILD ONLINE;

-- Or rebuild only the unusable partitions if it is a global partitioned index
ALTER INDEX sales_own.idx_oh_custid_gpart
  REBUILD PARTITION gp_mid ONLINE;
\`\`\`

---

## Summary

Oracle partitioning delivers three compounding benefits: **query pruning** eliminates partitions from access paths, translating directly into reduced I/O and elapsed time; **operational manageability** enables surgical maintenance — drop an old partition in milliseconds, exchange a loaded staging table in seconds — without the undo/redo overhead of row-by-row DML; and **parallel execution affinity** enables partition-wise joins that eliminate cross-partition data shuffling in analytical workloads. These benefits scale together: the larger the table grows, the more valuable partitioning becomes, because the savings from each pruned partition compound as partition count grows.

Choosing the right partitioning strategy requires matching the strategy to the access pattern. Range partitioning on a date column is the default choice for time-series data — it delivers natural pruning on date range predicates, aligns with operational workflows (archive by month, purge by year), and works seamlessly with interval partitioning for automatic partition creation. List partitioning serves categorical access patterns where the partition key is a discrete code set with no natural ordering. Hash partitioning serves large reference tables in join-heavy DWH workloads where even distribution and partition-wise join affinity matter more than pruning. Composite strategies (Range-Hash, Range-List) combine the best of both: range-based pruning and maintenance at the top level, fine-grained distribution or secondary pruning at the sub-partition level.

The local versus global index decision is governed by two factors: the access pattern and the operational cadence. Local indexes are always safe from partition DDL operations and are the right default for tables that undergo frequent partition maintenance. They are ideal for range-based access patterns where the partition key is already in the predicate (meaning most partitions are pruned before the index is consulted). Global non-partitioned indexes are the right choice when high-frequency OLTP lookups by a non-partition-key column require single-probe access, or when unique constraints must span partition boundaries. The rule of thumb: any table with active partition DDL operations should default to local indexes unless there is a specific, measured requirement for a global index.

The companion runbook to this post provides the complete operational SQL for every concept covered here: pre-partitioning assessment queries to identify candidate tables, the full DDL for each partitioning strategy, the online conversion procedure using \`ALTER TABLE ... MODIFY PARTITION BY\` (12.2+), the exchange partition bulk load workflow, and a partitioning health dashboard query that surfaces UNUSABLE indexes, partition size skew, and pruning failures in a single report.

---`,
};

async function main() {
  console.log('Inserting Oracle partitioning concepts post...');
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
