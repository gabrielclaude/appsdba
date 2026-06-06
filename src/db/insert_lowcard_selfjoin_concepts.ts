import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Tuning Oracle SQL: Low-Cardinality Index Contention and Explosive Self-Joins',
  slug: 'oracle-low-cardinality-index-self-join-tuning',
  excerpt:
    'A deep-dive case study into two of the most dangerous Oracle SQL anti-patterns: low-cardinality index contention that triggers buffer busy waits under skewed data distributions, and explosive self-joins that produce Cartesian cross-products forcing PGA spill to temp. Covers optimizer selectivity mechanics, histogram strategy, composite index design, function-based indexes for NVL patterns, and a complete query rewrite using EXISTS with GROUP BY / HAVING.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-06'),
  youtubeUrl: null,
  content: `## Introduction

Production SQL degradation is one of the most disorienting problems a DBA or developer can face. A query runs reliably for months — sometimes years — and then one morning it simply does not finish. The application stalls, the batch window blows past its SLA, and the first question everyone asks is: *what changed?*

The answer is frequently nothing in the code. No deployment happened. No patch was applied. What changed was the data itself — its volume, its distribution, or both — and that shift exposed a latent design flaw that was always present but never triggered at smaller scale.

Two anti-patterns are responsible for the majority of these events in Oracle environments running staging, processing, or reporting workloads:

**Low-cardinality index contention** arises when an index exists on a column with few distinct values — status flags, state codes, processing indicators — and the target value suddenly represents a large fraction of the table. The optimizer, relying on stale or histogram-free statistics, continues to choose an index range scan that is no longer selective, driving massive logical I/O and block-level latch contention.

**Explosive self-joins** arise when a table is joined to itself, which is often written to detect duplicates or compare rows within the same dataset. At low row counts the pattern is harmless. At millions of rows — especially with DISTINCT or analytic functions layered on top — the Cartesian intermediate result set overwhelms PGA memory and spills to temp, converting a seconds-long operation into one that runs for hours.

These two problems frequently co-occur because they share the same root condition: a query design that was sized for yesterday's data volumes applied to today's data reality.

This post works through a real production incident — a global retail platform whose inventory staging table went from sub-minute queries to hour-long hangs during a seasonal bulk load — and uses that incident as a precise lens into the Oracle internals that govern both failures. Each remediation step is explained not just as a fix but as a mechanism: why the optimizer made the decision it did, what changed when the fix was applied, and how to build systems that do not depend on data volumes staying within an invisible safety threshold.

---

## Part 1: How Oracle Chooses Between Index Range Scan and Full Table Scan

Understanding why Oracle sometimes makes the wrong access path decision requires understanding how the Cost-Based Optimizer (CBO) estimates selectivity, and what happens when those estimates are wrong.

### Selectivity: The Optimizer's Core Calculation

When Oracle evaluates a predicate like \`WHERE processing_status = 'PENDING'\`, it computes a **selectivity** — a number between 0 and 1 representing the fraction of rows the optimizer believes will satisfy the predicate. Selectivity drives cardinality estimates, which drive cost calculations, which drive access path choices.

For an equality predicate on a column without a histogram, Oracle uses the simplest possible formula:

\`\`\`
selectivity = 1 / NDV
\`\`\`

Where NDV is the **Number of Distinct Values** for the column. This figure is stored in \`ALL_TAB_COL_STATISTICS.NUM_DISTINCT\` and is gathered whenever \`DBMS_STATS\` runs.

\`\`\`sql
-- Check the optimizer's current view of a column
SELECT column_name,
       num_distinct,
       num_nulls,
       density,
       histogram,
       last_analyzed
FROM dba_tab_col_statistics
WHERE owner = 'INVENTORY_OWN'
  AND table_name = 'STAGE_INVENTORY_ITEMS'
  AND column_name = 'PROCESSING_STATUS';
\`\`\`

If \`NUM_DISTINCT = 5\` (five distinct status values), the optimizer computes selectivity as \`1/5 = 0.2\`, meaning it expects 20% of rows to match any given status value. On a 4 million row table, that is 800,000 rows — far too many for an index range scan to be efficient. The optimizer would correctly choose a full table scan.

But now suppose statistics were gathered when the distribution was:

| STATUS | COUNT |
|---|---|
| PROCESSED | 2,100,000 |
| ARCHIVED | 1,800,000 |
| FAILED | 95,000 |
| PENDING | 100 |
| HOLD | 1 |

At the time of that stats gather, \`NUM_DISTINCT = 5\` and the optimizer calculates selectivity for \`PENDING\` as \`1/5 = 0.2\`. But the **actual** selectivity is \`100 / 3,995,101 = 0.000025\` — roughly 8,000 times smaller. The optimizer believes PENDING is common. In reality it is extremely rare. And because it believes PENDING is rare at the stored selectivity, it will choose an index range scan — which for 100 rows is the right decision.

The trap is set. The moment PENDING rows grow from 100 to 100,000, the stored statistics are wrong, the optimizer still thinks PENDING is rare, and now the index range scan is executed on 100,000 rows — while Oracle expects to find only 800,000 rows total across all status values but is actually hitting a very different distribution.

### The Role of NUM_DISTINCT vs DENSITY

You will notice \`DENSITY\` in the statistics view. When no histogram exists, \`DENSITY = 1 / NUM_DISTINCT\`. The optimizer uses \`DENSITY\` as its per-row selectivity for equality predicates. When a histogram exists, \`DENSITY\` is recalculated to reflect actual bucket distributions and is no longer a simple reciprocal of NDV.

\`\`\`sql
-- Compare density to actual row distribution (no histogram case)
SELECT c.column_name,
       c.num_distinct,
       c.density,
       ROUND(1 / NULLIF(c.num_distinct, 0), 8) AS calculated_density,
       t.num_rows,
       ROUND(c.density * t.num_rows) AS optimizer_estimate_per_value
FROM dba_tab_col_statistics c
JOIN dba_tab_statistics t
  ON t.owner = c.owner
  AND t.table_name = c.table_name
WHERE c.owner = 'INVENTORY_OWN'
  AND c.table_name = 'STAGE_INVENTORY_ITEMS'
  AND c.column_name = 'PROCESSING_STATUS';
\`\`\`

If \`optimizer_estimate_per_value\` is wildly different from the actual count of PENDING rows in the table, you have a selectivity problem. The optimizer will make wrong access path decisions.

### Histograms: The Correct Solution for Skewed Data

The uniform distribution assumption (\`1/NDV\`) breaks down whenever a column has **skewed** data — when some values are much more or less frequent than others. Oracle solves this with histograms, which store the actual distribution of values and allow the optimizer to use value-specific selectivity estimates.

Oracle 12c and later supports three histogram types:

**Frequency Histogram** — used when \`NDV <= 254\`. Oracle stores one bucket per distinct value, recording the exact endpoint repeat count. For \`PROCESSING_STATUS\` with 5 distinct values, Oracle would store 5 buckets with exact counts. The optimizer then knows that PENDING = 100 rows vs PROCESSED = 2,100,000 rows and computes selectivity accordingly.

\`\`\`sql
-- View histogram buckets for a column
SELECT endpoint_number,
       endpoint_value,
       endpoint_actual_value,
       endpoint_repeat_count
FROM dba_tab_histograms
WHERE owner = 'INVENTORY_OWN'
  AND table_name = 'STAGE_INVENTORY_ITEMS'
  AND column_name = 'PROCESSING_STATUS'
ORDER BY endpoint_number;
\`\`\`

**Height-Balanced Histogram** — used on older Oracle versions (before 12c) when NDV > 254. Oracle divides the data into a fixed number of equal-height buckets and records the endpoint value of each bucket. Values that span many buckets are inferred to be popular. This was the classic histogram type but was replaced in 12c.

**Hybrid Histogram** (12c+) — combines height-balancing with per-endpoint repeat counts. Oracle uses this when \`NDV > 254\` and it is the default for 12c and later when SIZE AUTO detects skew. It provides the accuracy of frequency histograms for popular values while handling high-NDV columns that cannot fit in 254 buckets.

To check whether a histogram currently exists on a column:

\`\`\`sql
SELECT column_name, histogram, num_buckets, last_analyzed
FROM dba_tab_col_statistics
WHERE owner = 'INVENTORY_OWN'
  AND table_name = 'STAGE_INVENTORY_ITEMS'
ORDER BY column_name;
-- HISTOGRAM values: NONE, FREQUENCY, HEIGHT BALANCED, HYBRID, TOP-FREQUENCY
\`\`\`

A value of \`NONE\` on a low-cardinality column with skewed data is a red flag. This is precisely the configuration that leads to the crisis described in this case study.

---

## Part 2: Buffer Busy Waits — What Actually Happens at the Block Level

The index contention problem does not end at the access path decision. Even when the optimizer correctly chooses an index range scan for a genuinely selective predicate, high-concurrency environments introduce a second failure mode: buffer busy waits caused by multiple sessions competing for the same index leaf blocks.

### Oracle's Block-Level Architecture

Oracle stores data and index entries in fixed-size blocks (typically 8KB). Every block has a header containing transaction slots — entries that track which transactions currently have rows locked within that block. The number of transaction slots initially allocated per block is controlled by the **INITRANS** parameter of the segment. Additional transaction slots can be added dynamically up to MAXTRANS (255 in modern Oracle), but dynamic slot allocation requires free space in the block header, which is why PCTFREE matters.

When an index is created with the default \`INITRANS 2\`, each leaf block initially has two transaction slots. If three concurrent sessions simultaneously try to modify rows whose index entries happen to land on the same leaf block, the third session must wait for a slot to free up — or for free space to allocate a new slot.

### The Buffer Busy Wait Mechanism

\`buffer busy waits\` is the wait event recorded when a session wants to read or modify a block that is currently being read or modified by another session. The block exists in the buffer cache (so it is not an I/O wait), but the requesting session cannot access it because:

1. Another session is in the process of reading the block from disk into the buffer cache (read-by-other-session wait variant)
2. Another session holds an exclusive pin on the block for modification

During an index range scan on a low-cardinality column under high-concurrency inserts, hundreds of sessions may simultaneously try to insert new rows with the same status value. Because low-cardinality indexes tend to have very few leaf blocks for a given value range — all PENDING rows cluster together in the index — all concurrent insert sessions hammer the same small set of index leaf blocks.

### Diagnosing Buffer Busy Waits

\`\`\`sql
-- Current sessions waiting on buffer busy waits — find the hot object
SELECT s.sid,
       s.serial#,
       s.username,
       s.event,
       s.p1 AS file_id,
       s.p2 AS block_id,
       s.p3 AS reason_code,
       o.object_name,
       o.object_type,
       o.subobject_name
FROM v\$session s
LEFT JOIN dba_objects o
  ON o.data_object_id = (
       SELECT data_object_id FROM v\$bh
       WHERE file# = s.p1
         AND block# = s.p2
         AND rownum = 1
     )
WHERE s.event = 'buffer busy waits'
  AND s.type = 'USER'
ORDER BY s.sid;

-- Aggregate buffer busy waits by segment from V\$SEGMENT_STATISTICS
SELECT owner, object_name, object_type, statistic_name, value
FROM v\$segment_statistics
WHERE statistic_name = 'buffer busy waits'
  AND value > 0
ORDER BY value DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

The \`reason_code\` in P3 tells you the specific reason:

| Reason Code | Meaning |
|---|---|
| 17 | Block being read by another session |
| 20 | Write contention |
| 0 | ITL (Interested Transaction List) wait — no free transaction slot |

An ITL wait (code 0) specifically indicates INITRANS is too low.

### Rebuilding Indexes to Reduce Contention

When an index is identified as a hot contention point, rebuilding it with higher INITRANS and appropriate PCTFREE reduces future contention:

\`\`\`sql
-- Rebuild the index with increased transaction slots and free space
ALTER INDEX inventory_own.idx_stage_inv_status
  REBUILD
  INITRANS 8
  PCTFREE 20
  ONLINE
  PARALLEL 4;

-- Verify the new settings
SELECT index_name,
       ini_trans,
       max_trans,
       pct_free,
       status,
       last_analyzed
FROM dba_indexes
WHERE owner = 'INVENTORY_OWN'
  AND index_name = 'IDX_STAGE_INV_STATUS';
\`\`\`

\`INITRANS 8\` allocates 8 transaction slots per block from the start, avoiding dynamic slot allocation under load. \`PCTFREE 20\` reserves 20% of each block for row updates and dynamic slot expansion. \`ONLINE\` allows DML to continue against the table during the rebuild.

---

## Part 3: The Explosive Self-Join — Mechanics and Consequences

A self-join joins a table to itself. They are legitimate and sometimes the clearest way to express certain relational operations. The problem arises when a self-join is combined with imprecise join conditions on a large dataset, particularly when DISTINCT or analytic window functions are added to handle the resulting duplicates.

### How the Row Multiplication Happens

Consider a simplified scenario: a table has 10,000 rows with status = 'PENDING'. A self-join with the condition \`a.processing_status = b.processing_status\` on this subset produces a cross-product: 10,000 × 10,000 = 100,000,000 intermediate rows. Add the NVL-based join conditions and the optimizer cannot push them down as hash join conditions efficiently (more on this shortly), so the intermediate result may grow even larger.

The formal analysis:

If the outer query returns N rows from the table (all PENDING rows) and the inner side of the join also returns M rows (all PENDING rows where the NVL conditions match), then for each outer row that has K matching inner rows, you get K intermediate rows output. If K is large (say, all PENDING rows have the same warehouse_id and sku_number), then K ≈ N and the intermediate result is N × N rows.

### The DISTINCT Trap

DISTINCT at the top of a self-join forces the engine to:
1. Execute the full join and produce all N×K intermediate rows
2. Sort the entire intermediate result
3. Deduplicate by eliminating adjacent duplicate rows

The SORT UNIQUE operation in the execution plan is the signature of this. For 100 million intermediate rows, this sort requires enormous PGA memory. When PGA is exhausted, Oracle spills the sort to the TEMP tablespace — a disk write/read cycle that transforms a memory-speed operation into an I/O-bound operation.

\`\`\`sql
-- Execution plan signature of an explosive self-join:
-- SORT UNIQUE          <-- DISTINCT forces full sort of the cross-product
-- MERGE JOIN CARTESIAN <-- or HASH JOIN with no usable join keys
--   TABLE ACCESS BY INDEX ROWID
--     INDEX RANGE SCAN
--   TABLE ACCESS FULL  <-- second pass of the same table

-- Find plans with MERGE JOIN CARTESIAN in the shared pool
SELECT s.sql_id,
       s.executions,
       ROUND(s.buffer_gets / NULLIF(s.executions, 0)) AS avg_lio,
       p.operation,
       p.options,
       p.object_name
FROM v\$sql s
JOIN v\$sql_plan p ON s.sql_id = p.sql_id AND s.child_number = p.child_number
WHERE p.operation = 'MERGE JOIN'
  AND p.options = 'CARTESIAN'
ORDER BY avg_lio DESC NULLS LAST
FETCH FIRST 20 ROWS ONLY;
\`\`\`

### PGA Spill Diagnostics

\`\`\`sql
-- Currently active workareas that have spilled to temp
SELECT s.sql_id,
       s.sql_exec_id,
       wa.operation_type,
       wa.policy,
       ROUND(wa.estimated_optimal_size / 1048576) AS optimal_mb,
       ROUND(wa.actual_mem_used / 1048576) AS actual_mb,
       wa.number_passes,
       wa.tempseg_size / 1048576 AS temp_mb_used
FROM v\$sql_workarea_active wa
JOIN v\$sql_monitor s ON wa.sql_exec_id = s.sql_exec_id
WHERE wa.tempseg_size > 0
ORDER BY wa.tempseg_size DESC;

-- Historical PGA spill from workarea view
SELECT sql_id,
       operation_type,
       policy,
       ROUND(estimated_optimal_size / 1048576) AS optimal_mb,
       onepass_size / 1048576 AS onepass_mb,
       multipasses AS multipass_count
FROM v\$sql_workarea
WHERE sql_id = '9vtx2ws844123'
ORDER BY estimated_optimal_size DESC;
\`\`\`

\`number_passes > 1\` means multipass — the sort was so large it had to be divided into multiple merge passes. This is the worst case and corresponds to the \`workarea executions - multipass\` statistic in \`V\$SYSSTAT\`.

---

## Part 4: The Case Study — E-Commerce Staging Crisis

### The Environment

A global retail platform uses a table \`STAGE_INVENTORY_ITEMS\` to stage inventory updates before they are applied to the master catalog. During normal operations the table holds approximately 4 million rows. A nightly batch process reads PENDING items, validates them, and marks them PROCESSED.

An index \`IDX_STAGE_INV_STATUS\` exists on the \`PROCESSING_STATUS\` column. Statistics are gathered nightly as part of the maintenance window. Column distribution at the time of the last statistics gather:

| PROCESSING_STATUS | COUNT |
|---|---|
| PROCESSED | 2,100,000 |
| ARCHIVED | 1,800,000 |
| FAILED | 95,000 |
| PENDING | 4,999 |
| HOLD | 1 |

### The Problematic Query

The SQL that processes PENDING items (sql_id: 9vtx2ws844123):

\`\`\`sql
SELECT DISTINCT b.item_key, b.warehouse_id, b.batch_id
FROM stage_inventory_items a, stage_inventory_items b
WHERE a.processing_status = 'PENDING'
  AND a.processing_status = b.processing_status
  AND NVL(a.sku_number, '*') = NVL(b.sku_number, '*')
  AND NVL(a.warehouse_id, '*') = NVL(b.warehouse_id, '*');
\`\`\`

Under normal conditions this query completes in under a minute. PENDING rows number in the hundreds to low thousands, the index range scan quickly retrieves a small set, and the self-join on those few thousand rows is fast.

### The Breaking Point: The HSRI Bulk Load

A High-Skew Regional Inventory (HSRI) file arrived containing 100,000 new items all with status PENDING. This was loaded in a single batch at 02:00. The nightly maintenance window had already passed — statistics still reflect PENDING = 4,999.

By 02:15 the query had been running for 15 minutes. By 03:00 it had been running for 45 minutes. By 04:00 it was over an hour into execution.

**What was happening:**

1. Statistics showed PENDING = 4,999, giving selectivity = \`4999 / 3,995,001 = 0.00125\`. Oracle estimated ~5,000 rows from the index range scan.

2. The actual row count was 104,999 — roughly 21 times more than expected.

3. Oracle chose the index range scan because 5,000 rows is cheap. The actual 104,999 rows made every subsequent operation far more expensive.

4. The self-join on 104,999 PENDING rows produced up to 104,999 × 104,999 = approximately 11 billion intermediate rows before DISTINCT deduplication.

5. \`db file sequential read\` waits dominated as Oracle read hundreds of millions of index entries. \`buffer busy waits\` escalated as concurrent insert sessions competed for PENDING-range index leaf blocks.

6. The SORT UNIQUE for DISTINCT had to process billions of intermediate rows, triggering massive PGA spill to TEMP. The TEMP tablespace I/O generated \`direct path read temp\` and \`direct path write temp\` waits.

### Diagnosing the Incident

\`\`\`sql
-- Confirm the query is long-running and find its current state
SELECT sql_id,
       elapsed_time / 1e6 AS elapsed_sec,
       buffer_gets,
       disk_reads,
       rows_processed,
       executions,
       SUBSTR(sql_text, 1, 150) AS sql_preview
FROM v\$sql
WHERE sql_id = '9vtx2ws844123';

-- Confirm top waits during the incident window via ASH
SELECT event,
       COUNT(*) AS ash_samples,
       ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS pct_db_time
FROM dba_hist_active_sess_history
WHERE sample_time BETWEEN TIMESTAMP '2026-06-06 02:00:00'
                      AND TIMESTAMP '2026-06-06 04:30:00'
  AND sql_id = '9vtx2ws844123'
GROUP BY event
ORDER BY ash_samples DESC;

-- Confirm stale statistics were the root cause
SELECT num_rows,
       last_analyzed,
       stale_stats
FROM dba_tab_statistics
WHERE owner = 'INVENTORY_OWN'
  AND table_name = 'STAGE_INVENTORY_ITEMS';

-- Confirm actual PENDING count vs optimizer's estimate
SELECT processing_status, COUNT(*) AS actual_count
FROM stage_inventory_items
GROUP BY processing_status
ORDER BY actual_count DESC;
\`\`\`

### The Three-Step Remediation

**Step 1: Rebuild the index with INITRANS 8 and PCTFREE 20**

Reduces block contention during concurrent inserts. The ONLINE keyword allows DML to continue while the rebuild is in progress.

\`\`\`sql
ALTER INDEX inventory_own.idx_stage_inv_status
  REBUILD
  INITRANS 8
  PCTFREE 20
  ONLINE;
\`\`\`

**Step 2: Create a composite index on (processing_status, warehouse_id, sku_number)**

The single-column index on PROCESSING_STATUS has terrible selectivity when PENDING is common. A composite index spanning the three columns used in the join produces far better combined selectivity (details in Part 5 below).

\`\`\`sql
CREATE INDEX inventory_own.idx_stage_inv_comp
  ON stage_inventory_items (processing_status, warehouse_id, sku_number)
  INITRANS 8
  PCTFREE 20
  ONLINE
  PARALLEL 4;

-- Update statistics on the new index immediately
BEGIN
  DBMS_STATS.GATHER_INDEX_STATS(
    ownname  => 'INVENTORY_OWN',
    indname  => 'IDX_STAGE_INV_COMP'
  );
END;
/
\`\`\`

**Step 3: Rewrite the self-join using EXISTS with GROUP BY / HAVING**

The EXISTS rewrite eliminates the cross-product entirely:

\`\`\`sql
-- Rewritten query — eliminates self-join cross-product
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
\`\`\`

The EXISTS allows **short-circuit evaluation** — the moment Oracle finds a single matching row in the subquery, it stops evaluating and moves to the next outer row. The intermediate row count never approaches N×N. The GROUP BY / HAVING inside EXISTS also ensures Oracle can use the composite index efficiently.

**Performance improvement:** Query execution time went from over 60 minutes to under 45 seconds after all three steps. Buffer gets dropped from approximately 2.1 billion to 340,000. Temp segment usage dropped from 180GB to near zero.

---

## Part 5: Why Composite Indexes Solve the Cardinality Problem

### Combined Selectivity

When an index covers multiple columns, Oracle computes the combined selectivity as the product of individual column selectivities — subject to correlation adjustments when extended statistics are present. For the composite index \`(processing_status, warehouse_id, sku_number)\`:

\`\`\`
combined_selectivity = sel(processing_status) × sel(warehouse_id) × sel(sku_number)
\`\`\`

Even if \`processing_status\` alone has poor selectivity (say 0.025 = 2.5%), warehouse_id might have 50 distinct values (selectivity 0.02) and sku_number might have 200,000 distinct values (selectivity 0.000005). The combined selectivity becomes:

\`\`\`
0.025 × 0.02 × 0.000005 = 0.0000000025 = 2.5 × 10^-9
\`\`\`

This is extraordinarily selective. The optimizer correctly recognizes that the combination of all three predicates narrows the result to an extremely small number of rows, making the composite index range scan very efficient.

### Checking Combined NDV via Column Group Statistics

Oracle 11g+ supports extended statistics — statistics gathered on combinations of columns. When extended statistics exist, Oracle uses the combined NDV directly rather than multiplying individual selectivities:

\`\`\`sql
-- Create a column group for the combined columns
SELECT DBMS_STATS.CREATE_EXTENDED_STATS(
  ownname    => 'INVENTORY_OWN',
  tabname    => 'STAGE_INVENTORY_ITEMS',
  extension  => '(PROCESSING_STATUS, WAREHOUSE_ID, SKU_NUMBER)'
) AS extension_name
FROM dual;

-- Gather statistics to populate the new column group
BEGIN
  DBMS_STATS.GATHER_TABLE_STATS(
    ownname     => 'INVENTORY_OWN',
    tabname     => 'STAGE_INVENTORY_ITEMS',
    method_opt  => 'FOR ALL COLUMNS SIZE AUTO'
  );
END;
/

-- View the column group statistics
SELECT extension_name, extension, creator, droppable
FROM dba_stat_extensions
WHERE owner = 'INVENTORY_OWN'
  AND table_name = 'STAGE_INVENTORY_ITEMS';
\`\`\`

### Column Order Matters: The Leading Column Rule

The composite index \`(processing_status, warehouse_id, sku_number)\` can be used for:
- Queries filtering on \`processing_status\` alone
- Queries filtering on \`processing_status AND warehouse_id\`
- Queries filtering on \`processing_status AND warehouse_id AND sku_number\`

It cannot be used (without skip scan) for:
- Queries filtering on \`warehouse_id\` alone
- Queries filtering on \`sku_number\` alone

The leading column is the gateway. Even though \`processing_status\` has low cardinality as a standalone column, placing it first in the composite index is correct here because:

1. Every query against this table that cares about duplicates will filter on \`processing_status = 'PENDING'\` — it is the universal access filter
2. The subsequent columns \`warehouse_id\` and \`sku_number\` provide the high combined selectivity
3. The optimizer can probe the index at the \`(processing_status, warehouse_id, sku_number)\` boundary and retrieve only the rows that match all three conditions

---

## Part 6: Function-Based Indexes for NVL Patterns

The original query contains NVL predicates:

\`\`\`sql
NVL(a.sku_number, '*') = NVL(b.sku_number, '*')
NVL(a.warehouse_id, '*') = NVL(b.warehouse_id, '*')
\`\`\`

A regular index on \`sku_number\` cannot be used to satisfy \`NVL(sku_number, '*') = :value\` because the predicate operates on the function result, not the column value directly. Oracle would have to evaluate the NVL function for every row to determine what the index would contain at that position.

### Creating Function-Based Indexes

A function-based index stores the precomputed result of a function:

\`\`\`sql
-- Function-based index for the NVL pattern
CREATE INDEX inventory_own.idx_stage_nvl_sku
  ON stage_inventory_items (NVL(sku_number, '*'))
  INITRANS 4
  ONLINE;

CREATE INDEX inventory_own.idx_stage_nvl_wh
  ON stage_inventory_items (NVL(warehouse_id, '*'))
  INITRANS 4
  ONLINE;

-- Composite function-based index combining both NVL expressions
CREATE INDEX inventory_own.idx_stage_nvl_comp
  ON stage_inventory_items (
    processing_status,
    NVL(warehouse_id, '*'),
    NVL(sku_number, '*')
  )
  INITRANS 8
  PCTFREE 20
  ONLINE;
\`\`\`

### Enabling the Optimizer to Use Function-Based Indexes

Function-based indexes require specific conditions to be used by the optimizer:

1. The session or system must have \`QUERY_REWRITE_ENABLED = TRUE\` (default in 10g+)
2. Statistics must be gathered on the index after creation
3. The query predicate must match the function expression exactly

\`\`\`sql
-- Verify the function-based index is usable
SELECT index_name,
       funcidx_status,
       status,
       visibility
FROM dba_indexes
WHERE owner = 'INVENTORY_OWN'
  AND table_name = 'STAGE_INVENTORY_ITEMS'
  AND index_name = 'IDX_STAGE_NVL_COMP';
-- FUNCIDX_STATUS should be ENABLED

-- Check QUERY_REWRITE_ENABLED
SHOW PARAMETER query_rewrite_enabled;
-- Should return TRUE

-- Verify the optimizer uses the function-based index via EXPLAIN PLAN
EXPLAIN PLAN FOR
SELECT item_key, warehouse_id, batch_id
FROM stage_inventory_items b
WHERE b.processing_status = 'PENDING'
  AND EXISTS (
      SELECT 1
      FROM stage_inventory_items a
      WHERE a.processing_status = 'PENDING'
        AND NVL(a.sku_number, '*') = NVL(b.sku_number, '*')
        AND NVL(a.warehouse_id, '*') = NVL(b.warehouse_id, '*')
      GROUP BY NVL(sku_number, '*'), NVL(warehouse_id, '*')
      HAVING COUNT(*) > 1
  );

SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(format => 'TYPICAL +PREDICATE'));
\`\`\`

Look for \`INDEX RANGE SCAN IDX_STAGE_NVL_COMP\` in the plan output. The \`+PREDICATE\` format shows the access and filter predicates — confirm that the NVL expression appears as an access predicate (using the index) rather than a filter predicate (applied after the index, meaning the function-based index is not being used).

---

## Part 7: Histogram Collection Strategy

Gathering histograms on every column of every table wastes statistics gathering time and can cause plan regressions (histograms on high-NDV columns where data is uniformly distributed can sometimes destabilize plans). The goal is targeted histogram collection on columns where skew actually exists and affects optimizer decisions.

### When to Use Each METHOD_OPT Value

\`SIZE AUTO\` — Oracle uses its own algorithm to determine which columns need histograms and how many buckets. It looks at column usage (stored in SYS.COL_USAGE\$) to decide which columns appear in WHERE clauses, then uses the shape of the data to decide bucket counts. This is the recommended default.

\`SIZE SKEWONLY\` — Oracle gathers histograms only on columns that appear to have skewed distributions, using column usage information. More targeted than SIZE AUTO in some situations.

\`SIZE n\` — explicit bucket count (1–254). Use when you know a column has exactly k distinct values and you want exactly k buckets.

\`SIZE 1\` — forces deletion of the histogram for that column.

\`\`\`sql
-- Gather histogram on just the skewed column without regathering the full table
-- This is the key technique for emergency histogram correction in production
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
-- The key parameters:
-- method_opt => 'FOR COLUMNS SIZE AUTO PROCESSING_STATUS'
--   gathers histogram only on PROCESSING_STATUS, leaves all other column stats unchanged
-- no_invalidate => FALSE
--   immediately invalidates dependent cursors so they reparsed with new statistics
\`\`\`

### Verifying the New Selectivity Estimate

After gathering the histogram, verify that the optimizer's selectivity estimate matches reality:

\`\`\`sql
-- Check new histogram metadata
SELECT column_name,
       histogram,
       num_buckets,
       density,
       last_analyzed
FROM dba_tab_col_statistics
WHERE owner = 'INVENTORY_OWN'
  AND table_name = 'STAGE_INVENTORY_ITEMS'
  AND column_name = 'PROCESSING_STATUS';
-- HISTOGRAM should now be FREQUENCY (NDV <= 254) or HYBRID

-- View actual bucket counts
SELECT endpoint_actual_value,
       endpoint_repeat_count,
       endpoint_number
FROM dba_tab_histograms
WHERE owner = 'INVENTORY_OWN'
  AND table_name = 'STAGE_INVENTORY_ITEMS'
  AND column_name = 'PROCESSING_STATUS'
ORDER BY endpoint_number;

-- Verify the new execution plan reflects the corrected cardinality estimate
EXPLAIN PLAN FOR
SELECT DISTINCT b.item_key
FROM stage_inventory_items a, stage_inventory_items b
WHERE a.processing_status = 'PENDING'
  AND a.processing_status = b.processing_status;

SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(format => 'TYPICAL'));
-- Check the 'Rows' column in the plan — it should now show ~100000 (actual PENDING count)
-- rather than the previous stale estimate of ~800000
\`\`\`

The \`density\` value will change dramatically after histogram collection. For the PENDING value with 104,999 rows in a 4 million row table, density becomes approximately \`104999 / 4000000 = 0.0262\` — accurate for PENDING specifically. Without the histogram, density was \`1/5 = 0.2\`, causing the optimizer to overestimate selectivity by a factor of ~7.6x.

### Targeted Histogram in Emergency Situations

When you cannot wait for the next full statistics gather window and the query is actively causing production pain:

\`\`\`sql
-- Step 1: Lock existing statistics (prevents scheduled gather from overwriting)
EXEC DBMS_STATS.LOCK_TABLE_STATS('INVENTORY_OWN', 'STAGE_INVENTORY_ITEMS');

-- Step 2: Gather only the histogram on the problem column
BEGIN
  DBMS_STATS.GATHER_TABLE_STATS(
    ownname       => 'INVENTORY_OWN',
    tabname       => 'STAGE_INVENTORY_ITEMS',
    method_opt    => 'FOR COLUMNS SIZE 5 PROCESSING_STATUS',
    no_invalidate => FALSE
  );
END;
/
-- SIZE 5 = 5 buckets, one per distinct value (FREQUENCY histogram for 5 distinct values)

-- Step 3: Unlock when ready for normal statistics management
EXEC DBMS_STATS.UNLOCK_TABLE_STATS('INVENTORY_OWN', 'STAGE_INVENTORY_ITEMS');
\`\`\`

---

## Summary: Best Practices for Skewed Indexes and Self-Joins

### 1. Treat Low-Cardinality Index Columns as High-Risk by Default

Any column with fewer than 50 distinct values that appears in WHERE clauses of high-frequency queries should have a histogram. The cost of gathering a frequency histogram on a 5-value column is trivial. The cost of not having one — when data distribution skews — can be hours of degraded throughput.

**Implementation:** Include a \`METHOD_OPT => 'FOR ALL COLUMNS SIZE AUTO'\` in your scheduled statistics gathering jobs. Periodically audit \`DBA_TAB_COL_STATISTICS\` for low-NDV columns with \`HISTOGRAM = 'NONE'\` that appear in \`V\$SQL\` predicates.

### 2. Design Composite Indexes for Real Query Patterns

Do not create single-column indexes on filtering columns just because those columns appear in WHERE clauses. Model the full query — what columns appear in the predicates, what is the join condition, what are the typical filter combinations — and design composite indexes that serve the full access pattern.

**Implementation:** When designing an index for a query that filters on low-cardinality column C1 and joins on high-cardinality columns C2 and C3, create \`(C1, C2, C3)\`. The leading column gives the optimizer its entry point; the trailing columns provide the selectivity that makes the index range scan cheap.

### 3. Audit Self-Joins on Large Tables

A self-join is not inherently wrong, but a self-join on a large table with a DISTINCT is almost always a sign that the query was written to compensate for a duplicate problem that should be solved at the data model or application layer.

**Implementation:** Regularly query \`V\$SQL\` for SQL containing the same table name appearing multiple times in the FROM clause combined with SELECT DISTINCT. Rewrite using EXISTS, aggregation subqueries, or analytic window functions with DISTINCT elimination. An EXISTS subquery short-circuits on first match, fundamentally changing the complexity from O(N²) to O(N×log(K)) where K is the number of matches per outer row.

### 4. Build Statistics Freshness into Operational Procedures

The worst time to discover that statistics are stale is during an incident. Statistics should be gathered at critical transition points: after large bulk loads, after partition operations, after any operation that changes data distribution. The Oracle 12c+ \`DBMS_STATS.FLUSH_DATABASE_MONITORING_INFO\` call forces pending column usage data to flush before a statistics gather, ensuring the gather uses complete usage information.

\`\`\`sql
-- Flush monitoring info before gathering — ensures accuracy
EXEC DBMS_STATS.FLUSH_DATABASE_MONITORING_INFO;

-- Gather with stale-detection: only gather tables that have changed > 10%
BEGIN
  DBMS_STATS.GATHER_SCHEMA_STATS(
    ownname          => 'INVENTORY_OWN',
    estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,
    cascade          => TRUE,
    degree           => 4,
    options          => 'GATHER STALE',
    method_opt       => 'FOR ALL COLUMNS SIZE AUTO'
  );
END;
/
\`\`\`

\`options => 'GATHER STALE'\` checks \`DBA_TAB_MODIFICATIONS\` and only regathers tables where DML has modified more than 10% of rows since the last gather. This makes scheduled statistics gathering much faster while still catching the most critical cases — including exactly the HSRI bulk load scenario in this case study.

---

## Summary

The HSRI incident illustrates a class of production failure that is almost entirely preventable — but only if you understand the mechanics underneath the query plan.

**The low-cardinality index trap** is not a bug in Oracle; it is the optimizer doing exactly what its statistics tell it to do. When NUM_DISTINCT is small and no histogram exists, the optimizer's selectivity formula (1/NDV) assigns a low expected row count to any equality predicate on that column and chooses an index range scan accordingly. That assumption breaks the moment data distribution shifts. The fix is to give the optimizer the information it needs: frequency histograms on low-NDV columns encode the actual value distribution, letting the optimizer switch to a full table scan or composite index path when the target value is no longer rare.

**The explosive self-join trap** lies dormant at low volumes. The standard rewrite — replacing the self-join with an EXISTS correlated subquery using GROUP BY / HAVING — works because EXISTS uses short-circuit evaluation: the moment a single matching row is found, evaluation stops. The engine never materialises the full Cartesian product. For NVL-wrapped join predicates, function-based indexes on the NVL expressions close the remaining performance gap.

**The three-step remediation framework from this case study generalises directly:**

1. **Emergency stabilisation** — rebuild the contended index with higher INITRANS and PCTFREE to reduce block-level latch contention while the permanent fix is staged.
2. **Tactical tuning** — create a composite index leading with the status column followed by selective attributes; gather a targeted histogram on the low-cardinality column to correct the optimizer's selectivity estimates.
3. **Architectural rewrite** — eliminate the self-join by restructuring the query around EXISTS with GROUP BY / HAVING, and add function-based indexes to support the rewritten predicate.

**The deeper lesson** is about the relationship between data architecture and query design. Staging tables accumulate rows. Processing status columns start with a handful of PENDING rows and are expected to stay that way — until a bulk load changes that permanently. Queries designed around the original data profile will eventually fail under the evolved data reality. The safeguard is not to avoid status indexes or self-referencing queries entirely, but to design them with the assumption that data will eventually grow in unexpected ways: histograms from day one, composite indexes over single-column status indexes, and EXISTS patterns over self-joins wherever duplicate detection is needed.

The companion runbook to this post provides ready-to-run SQL scripts that scan your database for low-cardinality index risk, detect self-join patterns in the shared pool and AWR history, and automate the full diagnostic workflow as a scheduled DBMS_SCHEDULER job with email alerting.`,
};

async function main() {
  console.log('Inserting Oracle low-cardinality index and self-join tuning post...');
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
