import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql);

const post = {
  title: 'Exadata Performance Tuning: Smart Scan, Storage Indexes, and IORM',
  slug: 'exadata-performance-tuning',
  excerpt:
    'Deep-dive into Exadata-specific performance tuning — enabling and diagnosing Smart Scan offloading, building effective storage indexes, configuring IORM resource plans, and eliminating the anti-patterns that silently bypass cell processing.',
  category: 'exadata' as const,
  published: true,
  publishedAt: new Date('2026-06-01'),
  content: `# Exadata Performance Tuning: Smart Scan, Storage Indexes, and IORM

Oracle Exadata moves query processing closer to the data. When tuned correctly, it reduces I/O by orders of magnitude; when misconfigured, it degrades silently to an expensive standard storage array. This guide covers the mechanisms that matter most — Smart Scan eligibility, storage index construction, Hybrid Columnar Compression, IORM resource management — and the diagnostics to verify each one is working.

---

## 1. Understanding the Exadata Offloading Stack

Before tuning, map the layers:

| Layer | Component | Where it runs |
|---|---|---|
| SQL parsing + CBO | Oracle RDBMS | Database node |
| Smart Scan filter | Cell Offload Engine | Storage cell |
| Storage Index | In-memory cell metadata | Storage cell |
| HCC decompression | RDMA/NFS-ODP | Cell (read), DB node (DML) |
| IORM scheduling | Cell I/O Resource Manager | Storage cell |
| Flash cache | Exadata Smart Flash Cache | Cell SSD tier |

Every offload decision is made at the storage cell. The database node sends predicates; the cell applies them before returning rows.

---

## 2. Smart Scan Eligibility

### 2.1 Requirements

Smart Scan fires when **all** of the following are true:

1. Full table scan or fast full index scan (no index range scan)
2. Table stored in Exadata-formatted segments (no CACHE option on small tables)
3. Direct path read (\`_serial_direct_read = auto\` or parallel)
4. No active row-level security (VPD) policies on the object (policies suppress offloading)
5. Not a cluster table

### 2.2 Checking Smart Scan at Session Level

\`\`\`sql
-- Before and after a query
SELECT name, value
FROM   v\$mystat ms JOIN v\$statname sn ON ms.statistic# = sn.statistic#
WHERE  sn.name IN (
         'cell physical IO bytes eligible for predicate offload',
         'cell physical IO bytes saved by storage index',
         'cell physical IO interconnect bytes',
         'cell physical IO interconnect bytes returned by smart scan',
         'cell scans',
         'cell blocks processed by cache layer',
         'cell blocks processed by data layer',
         'cell blocks processed by txn layer'
       )
ORDER BY sn.name;
\`\`\`

Key ratios:
- **Offload efficiency** = \`bytes returned by smart scan\` / \`bytes eligible for offload\` (lower is better — less data came back)
- **Storage index savings** = \`bytes saved by storage index\` / \`bytes eligible for offload\`

### 2.3 Forcing/Verifying Smart Scan

\`\`\`sql
-- Force direct path (bypasses buffer cache, enables Smart Scan)
ALTER SESSION SET "_serial_direct_read" = always;

-- Confirm in execution plan
EXPLAIN PLAN FOR SELECT /*+ FULL(t) */ count(*) FROM large_table t WHERE status = 'ACTIVE';
SELECT * FROM TABLE(dbms_xplan.display(format => 'ALL +PROJECTION'));
-- Look for: "Table Access Full" with "Batched" flag and "cell" note
\`\`\`

### 2.4 Common Smart Scan Killers

\`\`\`sql
-- 1. VPD policies — list all policies on a table
SELECT object_name, policy_name, enable
FROM   dba_policies
WHERE  object_name = 'YOUR_TABLE';

-- 2. CACHE hint or small-table cache promotion
SELECT table_name, cache FROM dba_tables WHERE cache = 'Y' AND owner = 'SCHEMA';

-- 3. Result cache on the query prevents direct path
-- Remove /*+ RESULT_CACHE */ hints on heavy scan queries

-- 4. Encrypted tablespace with no cellhdr — offloading limited pre-19c
SELECT ts.name, et.encryptedts
FROM   v\$tablespace ts JOIN v\$encrypted_tablespaces et ON ts.ts# = et.ts#;
\`\`\`

---

## 3. Storage Indexes

Storage indexes are in-memory min/max metadata structures maintained per 1 MB storage region. When a query predicate falls entirely outside a region's range, the cell skips reading it.

### 3.1 How Storage Indexes Are Built

- Built automatically on the first Smart Scan of a column
- Maintained per storage cell in non-persistent memory (survive cell restarts from 12c+ via persistence on flash)
- Up to **8 columns per table** are tracked
- Columnar predicates with equality, range, IN, and IS NULL benefit most

### 3.2 Diagnosing Storage Index Effectiveness

\`\`\`sql
-- AWR metric for storage index savings
SELECT snap_id,
       value - LAG(value) OVER (ORDER BY snap_id) AS delta_bytes_saved
FROM   dba_hist_sysstat
WHERE  stat_name = 'cell physical IO bytes saved by storage index'
ORDER BY snap_id DESC
FETCH FIRST 24 ROWS ONLY;
\`\`\`

\`\`\`bash
# On storage cell (dcli for all cells)
dcli -g /opt/oracle.SupportTools/onecommand/cell_group -l root \
  "cellcli -e list metriccurrent where name = 'CD_IO_BY_SK_SS_SAVED'"
\`\`\`

### 3.3 Maximizing Storage Index Benefit

**Column ordering matters:** the column most frequently used in WHERE clauses should appear first in the storage region scan order. You cannot directly control this, but you can influence it:

\`\`\`sql
-- Rebuild / reorganize table to improve storage region correlation
ALTER TABLE orders MOVE TABLESPACE exadata_tbs COMPRESS FOR QUERY HIGH;
-- After move, full scan warm-up builds fresh storage indexes
SELECT /*+ FULL(orders) */ count(*) FROM orders WHERE order_date BETWEEN ... AND ...;
\`\`\`

**Cardinality and clustering:** storage indexes work best when data has natural clustering (date columns in time-series tables, status columns in transactional tables). If the column value is uniformly scattered across all regions, no regions are skipped.

\`\`\`sql
-- Check clustering factor for candidate columns
SELECT index_name, clustering_factor, num_rows,
       ROUND(clustering_factor / num_rows * 100, 2) AS cluster_pct
FROM   dba_indexes
WHERE  table_name = 'YOUR_TABLE';
-- cluster_pct near 100% = poor clustering = poor storage index savings
\`\`\`

### 3.4 Storage Index Invalidation

Certain DML patterns degrade storage index quality:

| Pattern | Effect |
|---|---|
| Random INSERTs | New rows scatter across regions — min/max widens |
| UPDATE on indexed column | Region min/max expands |
| Bulk loads (INSERT /*+ APPEND */) | New HWM extents get fresh min/max |
| TRUNCATE + reload | Clears all storage indexes; rebuilds on next scan |

For DSS/warehouse tables, periodic reorganization with \`MOVE COMPRESS\` restores clustering.

---

## 4. Hybrid Columnar Compression (HCC)

HCC stores multiple rows per Oracle block in columnar format, achieving 10–50x compression over uncompressed data.

### 4.1 Compression Tiers

| Level | Use case | Compression ratio | DML overhead |
|---|---|---|---|
| \`COMPRESS FOR QUERY HIGH\` | Analytical queries, read-mostly | Very high | Row migration on UPDATE |
| \`COMPRESS FOR QUERY LOW\` | Query + moderate inserts | High | Moderate |
| \`COMPRESS FOR ARCHIVE HIGH\` | Cold data, retention | Extreme | High |
| \`COMPRESS FOR ARCHIVE LOW\` | Cold data | Very high | Moderate |

\`\`\`sql
-- Check current compression on a table
SELECT table_name, compression, compress_for
FROM   dba_tables
WHERE  owner = 'DW_SCHEMA'
ORDER BY table_name;

-- Compression ratio for a segment
SELECT owner, segment_name,
       ROUND(SUM(bytes)/1024/1024/1024, 2) AS size_gb,
       num_rows,
       ROUND(SUM(bytes) / NULLIF(num_rows, 0) / 8192, 4) AS rows_per_block
FROM   dba_segments ds JOIN dba_tables dt ON ds.owner = dt.owner
         AND ds.segment_name = dt.table_name
WHERE  dt.compression = 'ENABLED'
GROUP BY owner, segment_name, num_rows;
\`\`\`

### 4.2 HCC + Direct Path Requirement

HCC only writes via direct-path insert. Regular \`INSERT INTO ... VALUES\` produces uncompressed rows:

\`\`\`sql
-- Correct: triggers HCC compression
INSERT /*+ APPEND */ INTO fact_sales
SELECT * FROM stg_sales;
COMMIT;

-- Also correct: CTAS with COMPRESS FOR QUERY HIGH
CREATE TABLE fact_sales_new COMPRESS FOR QUERY HIGH
AS SELECT * FROM fact_sales;

-- Wrong: bypasses HCC
INSERT INTO fact_sales VALUES (...);  -- no APPEND hint
\`\`\`

### 4.3 HCC and Smart Scan Interaction

HCC-compressed blocks are decompressed at the cell during Smart Scan — only matching rows are sent to the DB node:

\`\`\`sql
-- Monitor HCC decompression at cell
SELECT name, value FROM v\$mystat ms JOIN v\$statname sn
  ON ms.statistic# = sn.statistic#
WHERE  sn.name LIKE 'cell%compress%';
\`\`\`

**Gotcha:** any UPDATE or DELETE on an HCC-compressed row migrates it to an uncompressed block (row piece). Use periodic reorganization to reclaim HCC after heavy DML:

\`\`\`sql
ALTER TABLE fact_sales MOVE COMPRESS FOR QUERY HIGH ONLINE;
\`\`\`

---

## 5. Exadata Flash Cache

The Smart Flash Cache (SFC) is a read/write cache in front of spinning disks on each cell.

### 5.1 Cache Statistics

\`\`\`bash
# Hit ratio per cell
dcli -g /opt/oracle.SupportTools/onecommand/cell_group -l root \
  "cellcli -e list metriccurrent where name like 'FC_%'"
# FC_IO_BY_R_SS_MISS = Smart Scan misses (went to disk)
# FC_IO_BY_R_CACHE   = reads served from flash
\`\`\`

\`\`\`sql
-- DB-side flash cache hits
SELECT name, value FROM v\$sysstat
WHERE  name LIKE 'cell flash cache%'
ORDER BY name;
\`\`\`

### 5.2 Pinning Objects in Flash Cache

Hot dimension tables and indexes can be pinned to prevent eviction:

\`\`\`sql
-- Pin a table in flash cache
ALTER TABLE dim_product STORAGE (CELL_FLASH_CACHE KEEP);

-- Pin an index
ALTER INDEX pk_dim_product STORAGE (CELL_FLASH_CACHE KEEP);

-- Verify
SELECT table_name, flash_cache FROM dba_tables WHERE flash_cache = 'KEEP';
\`\`\`

### 5.3 Excluding Objects from Flash Cache

Large sequential-scan fact tables that are already in flash don't need re-caching (they pollute flash with one-time-use data):

\`\`\`sql
ALTER TABLE fact_orders STORAGE (CELL_FLASH_CACHE NONE);
\`\`\`

---

## 6. I/O Resource Manager (IORM)

IORM controls how storage cell I/O is distributed among databases (inter-database IORM) and consumer groups (intra-database IORM).

### 6.1 Check Current IORM Plan

\`\`\`bash
# Check IORM plan on cells
dcli -g /opt/oracle.SupportTools/onecommand/cell_group -l root \
  "cellcli -e describe iormplan"

dcli -g /opt/oracle.SupportTools/onecommand/cell_group -l root \
  "cellcli -e list iormplan detail"
\`\`\`

\`\`\`sql
-- From DB: check which IORM plan is active
SELECT * FROM v\$iorm_plan;
SELECT * FROM v\$cell_config WHERE conftype = 'IORM';
\`\`\`

### 6.2 Configuring Inter-Database IORM

Set shares per database to control relative I/O weight:

\`\`\`bash
dcli -g /opt/oracle.SupportTools/onecommand/cell_group -l root \
  "cellcli -e alter iormplan
     dbplan = ((name=PROD, level=1, allocation=80),
               (name=DEV,  level=2, allocation=15),
               (name=other,level=3, allocation=5)),
   objective = balanced"
\`\`\`

### 6.3 Configuring Intra-Database IORM (DB Resource Manager)

\`\`\`sql
-- Create resource plan with I/O limits
BEGIN
  dbms_resource_manager.create_pending_area;

  dbms_resource_manager.create_plan(
    plan    => 'EXADATA_IORM_PLAN',
    comment => 'IORM-aware resource plan'
  );

  -- OLTP gets priority 1 with 60% CPU/IO
  dbms_resource_manager.create_plan_directive(
    plan                  => 'EXADATA_IORM_PLAN',
    group_or_subplan      => 'OLTP_GROUP',
    comment               => 'Interactive OLTP',
    cpu_p1                => 60,
    mgmt_p1               => 60
  );

  -- Batch gets priority 2 with 30% CPU/IO
  dbms_resource_manager.create_plan_directive(
    plan                  => 'EXADATA_IORM_PLAN',
    group_or_subplan      => 'BATCH_GROUP',
    comment               => 'Batch processing',
    cpu_p1                => 30,
    mgmt_p1               => 30
  );

  -- Catch-all
  dbms_resource_manager.create_plan_directive(
    plan             => 'EXADATA_IORM_PLAN',
    group_or_subplan => 'OTHER_GROUPS',
    cpu_p1           => 10,
    mgmt_p1          => 10
  );

  dbms_resource_manager.validate_pending_area;
  dbms_resource_manager.submit_pending_area;
END;
/

-- Activate the plan
ALTER SYSTEM SET resource_manager_plan = 'EXADATA_IORM_PLAN';
\`\`\`

### 6.4 IORM Objective Settings

| Objective | Behavior |
|---|---|
| \`balanced\` | Equal priority across databases (default) |
| \`auto\` | Automatic based on active workload |
| \`low_latency\` | Minimize latency for OLTP |
| \`high_throughput\` | Maximize throughput for DSS |

\`\`\`bash
dcli -g /opt/oracle.SupportTools/onecommand/cell_group -l root \
  "cellcli -e alter iormplan objective=low_latency"
\`\`\`

---

## 7. Parallel Query Tuning on Exadata

Exadata is designed for parallel query. Under-parallelism leaves Smart Scan and flash cache bandwidth unused.

### 7.1 Setting Parallelism

\`\`\`sql
-- Check default DOP for large tables
SELECT table_name, degree FROM dba_tables
WHERE  owner = 'DW' AND num_rows > 10000000;

-- Set DOP proportional to cell count (typical: 2x cell count)
ALTER TABLE fact_sales PARALLEL 16;

-- For one-off queries
SELECT /*+ PARALLEL(t, 16) */ count(*) FROM fact_sales t WHERE ...;
\`\`\`

### 7.2 Auto DOP (Parallel Statement Queuing)

\`\`\`sql
-- Enable auto DOP with statement queuing
ALTER SYSTEM SET parallel_degree_policy   = AUTO;
ALTER SYSTEM SET parallel_min_time_threshold = 10;  -- seconds
ALTER SYSTEM SET parallel_max_servers    = 128;
ALTER SYSTEM SET parallel_servers_target = 64;       -- queuing threshold
\`\`\`

### 7.3 Monitoring Parallel Execution

\`\`\`sql
-- Active PX servers
SELECT server_name, status, sessions_current, sessions_highwater
FROM   v\$px_buffer_advice;

SELECT px_servers_executions, px_servers_parallel_min_time
FROM   v\$sysstat WHERE name LIKE 'Parallel%';

-- Statement queuing wait
SELECT count(*) FROM v\$session WHERE wait_class = 'Scheduler'
  AND event = 'resmgr:statement queued';
\`\`\`

---

## 8. AWR Exadata Metrics

These AWR/ASH columns are Exadata-specific and belong in every performance review:

\`\`\`sql
-- Top Exadata metrics from latest AWR snapshot pair
SELECT metric_name, value, metric_unit
FROM   dba_hist_sysmetric_summary
WHERE  metric_name IN (
         'Cell Physical IO Interconnect Bytes',
         'Cell Offload Efficiency %',
         'Cell Physical IO Bytes Eligible for Predicate Offload',
         'Cell Physical IO Bytes Returned by Smart Scan'
       )
ORDER BY end_time DESC, metric_name;
\`\`\`

\`\`\`sql
-- Offload efficiency trend (last 7 days)
SELECT TO_CHAR(s.begin_interval_time, 'YYYY-MM-DD HH24') AS hour,
       ROUND(
         SUM(CASE WHEN sn.stat_name = 'cell physical IO interconnect bytes returned by smart scan'
                  THEN ss.value ELSE 0 END) * 100 /
         NULLIF(SUM(CASE WHEN sn.stat_name = 'cell physical IO bytes eligible for predicate offload'
                         THEN ss.value ELSE 0 END), 0)
       , 1) AS offload_return_pct
FROM   dba_hist_sysstat ss
JOIN   dba_hist_stat_name sn ON ss.stat_id = sn.stat_id
JOIN   dba_hist_snapshot s   ON ss.snap_id = s.snap_id AND ss.dbid = s.dbid
WHERE  sn.stat_name IN (
         'cell physical IO interconnect bytes returned by smart scan',
         'cell physical IO bytes eligible for predicate offload'
       )
  AND  s.begin_interval_time > SYSDATE - 7
GROUP BY TO_CHAR(s.begin_interval_time, 'YYYY-MM-DD HH24')
ORDER BY 1;
\`\`\`

---

## 9. Cell Offload Anti-Pattern Checklist

Run this checklist when Smart Scan offload efficiency is below 30%:

\`\`\`sql
-- 1. Find tables with VPD policies
SELECT object_name, policy_name FROM dba_policies
WHERE  object_owner = 'YOUR_SCHEMA';

-- 2. Find tables cached in buffer cache (small-table optimization)
SELECT table_name, cache, result_cache FROM dba_tables
WHERE  owner = 'YOUR_SCHEMA' AND cache != 'N';

-- 3. Check for buffer cache hints overriding direct path
-- Search SQLAREA for queries with CACHE or NO_PARALLEL hints
SELECT sql_id, SUBSTR(sql_text, 1, 120)
FROM   v\$sqlarea
WHERE  REGEXP_LIKE(sql_text, '/\*\+.*CACHE|buffer_cache', 'i')
  AND  last_active_time > SYSDATE - 1/24;

-- 4. Verify table storage format (must be Exadata-formatted)
SELECT ts.name, dp.param_value
FROM   v\$tablespace ts
JOIN   v\$cell_config dp ON 1=1
WHERE  dp.conftype = 'CELLDISKS'
FETCH FIRST 5 ROWS ONLY;

-- 5. Check for ROWID access (index range scans bypass Smart Scan)
SELECT sql_id, operation, options, object_name
FROM   v\$sql_plan
WHERE  operation = 'TABLE ACCESS' AND options != 'FULL'
  AND  object_owner = 'YOUR_SCHEMA'
  AND  last_active_time > SYSDATE - 1/24;
\`\`\`

---

## 10. Exadata Health and Cell Diagnostics

\`\`\`bash
# Overall cell health
dcli -g /opt/oracle.SupportTools/onecommand/cell_group -l root \
  "cellcli -e list cell attributes name,status,interconnectCount,flashCacheStatus"

# Disk health (watch for predictivefailure)
dcli -g /opt/oracle.SupportTools/onecommand/cell_group -l root \
  "cellcli -e list physicaldisk attributes name,diskType,status,errorCount"

# Flash disk status
dcli -g /opt/oracle.SupportTools/onecommand/cell_group -l root \
  "cellcli -e list flashdisk attributes name,status,temperature,lifeTimeUsed"

# Alert log on cells
dcli -g /opt/oracle.SupportTools/onecommand/cell_group -l root \
  "tail -20 /opt/oracle/cell/log/diag/asm/cell/*/alert/log.xml | grep -i error"

# Run exachk (comprehensive health check)
/opt/oracle.SupportTools/exachk/exachk -a
\`\`\`

\`\`\`bash
# Network latency between DB nodes and cells (should be < 100 µs)
dcli -g /opt/oracle.SupportTools/onecommand/cell_group -l root \
  "ping -c 100 <db_node_ib_ip> | tail -2"
\`\`\`

---

## 11. Summary Reference

| Tuning Lever | Goal | How |
|---|---|---|
| Enable direct path read | Activate Smart Scan | \`_serial_direct_read=auto\` (default) |
| Remove VPD on scan tables | Restore offloading | Redesign security policy |
| HCC COMPRESS FOR QUERY HIGH | Reduce I/O + enable cell decompression | \`INSERT /*+ APPEND */\` + \`ALTER TABLE MOVE COMPRESS\` |
| Flash Cache KEEP | Protect hot dimensions | \`ALTER TABLE … STORAGE (CELL_FLASH_CACHE KEEP)\` |
| Flash Cache NONE | Protect flash from cold scans | \`ALTER TABLE … STORAGE (CELL_FLASH_CACHE NONE)\` |
| IORM inter-DB allocation | Protect OLTP from DSS | CellCLI \`alter iormplan dbplan\` |
| IORM intra-DB plan | OLTP latency within one DB | DB Resource Manager + \`resource_manager_plan\` |
| Parallel DOP | Saturate Exadata bandwidth | \`parallel_degree_policy=AUTO\` or table-level PARALLEL |
| Storage Index | Skip cold regions | Natural data clustering; periodic \`MOVE COMPRESS\` |
| exachk | Baseline configuration drift | Monthly \`exachk -a\` |`,
};

async function main() {
  console.log('Inserting Exadata performance tuning post...');
  await db.insert(posts).values(post).onConflictDoNothing();
  console.log(`Inserted: "${post.title}"`);
}

main().catch(console.error);
