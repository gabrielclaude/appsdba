import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Exadata Performance Tuning: Storage Cell Offloading, Smart Scan, and Workload-Specific Strategies for EBS, ASCP, Workflow, and OBIEE',
  slug: 'exadata-smart-scan-workload-tuning-ebs-obiee',
  excerpt:
    'A deep-dive guide to how Exadata storage cell servers transform SQL execution, what Smart Scan offloading actually does at the cell level, and the specific tuning strategies that matter most for EBS OLTP, ASCP planning, Oracle Workflow, and OBIEE analytics workloads.',
  category: 'exadata' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-22'),
  youtubeUrl: null,
  content: `The most common Exadata disappointment occurs when a team migrates an Oracle EBS OLTP database to Exadata, expects dramatic performance improvement, and finds that interactive transaction response times improved only marginally. The expectation was wrong — not the hardware. Understanding which workloads benefit from Exadata's storage intelligence, and which do not, determines whether an Exadata investment delivers its promised return.

---

## Exadata Architecture: What Makes It Different

### Compute Nodes and Storage Cells

An Exadata Database Machine consists of two types of servers connected by a high-bandwidth InfiniBand (or RoCE on X9M) network:

**Compute nodes (database servers)**: Run Oracle Database instances. Standard Oracle DB kernel, standard SQL processing, standard buffer cache. Nothing special happens on the compute nodes that wouldn't happen on a regular server. The intelligence is in the storage layer.

**Storage cells**: Dedicated servers running Oracle Exadata Storage Server Software (CELLSRV). Each storage cell has enterprise SSDs (Flash cache), HDD spindles, a multi-core CPU, and a network interface. CELLSRV on each cell is a full Oracle process that can execute SQL predicates and column projections — this is the Smart Scan engine.

\`\`\`
┌──────────────────────────────────────────────────────────┐
│  Exadata X9M Full Rack                                   │
│                                                          │
│  Compute Nodes (8x)          Storage Cells (14x)        │
│  ┌──────────────┐            ┌──────────────────────┐   │
│  │ Oracle DB    │            │ CELLSRV              │   │
│  │ (standard)   │            │ ┌─────────────────┐  │   │
│  │              │←─InfiniBand│ │ Smart Scan       │  │   │
│  │              │  (800 Gbps)│ │ Storage Index    │  │   │
│  └──────────────┘            │ │ Flash Cache      │  │   │
│                              │ │ HDD spindles     │  │   │
│                              │ └─────────────────┘  │   │
│                              └──────────────────────┘   │
└──────────────────────────────────────────────────────────┘
\`\`\`

### What Smart Scan Actually Does

For a conventional Oracle database on regular storage, a full table scan works like this:
1. Compute node issues block read requests to the storage device
2. Storage device returns raw data blocks
3. Compute node reads each block, applies WHERE clause predicate for each row, discards non-matching rows
4. Compute node returns matching rows to the query

On Exadata, for eligible full table scans:
1. Compute node sends the SQL predicate and column list to CELLSRV on each storage cell
2. CELLSRV reads the raw data blocks, applies the predicate at the cell, returns only matching rows and only the columns requested
3. The InfiniBand network carries only filtered results — not raw blocks

The key measurement: "cell physical IO interconnect bytes returned by smart scan" vs "cell physical IO bytes eligible for predicate offload". If a 500 GB table scan returns only 1 GB of matching rows, 499 GB of data was filtered at the storage cell and never traversed the InfiniBand to the compute node. This is the I/O reduction that makes Smart Scan powerful for large analytical queries.

### Smart Scan Eligibility Requirements

Smart Scan fires only when **all** of these conditions are true:

1. **Full table scan** (or full index scan): row-by-row indexed access does not use Smart Scan
2. **Direct path reads**: the data must be read via direct path I/O, bypassing the buffer cache. Large tables read via full scans automatically use direct path reads. Small tables cached in the buffer cache do not.
3. **Table not in buffer cache**: if the entire table fits in the buffer cache, Oracle serves it from there (which is faster than any scan). Smart Scan fires when the table is too large for the buffer cache.
4. **No unsupported SQL constructs**: certain SQL features (some function applications, certain join types) prevent offloading. Oracle documents the offload restrictions.

The most critical implication: **Smart Scan does NOT fire for OLTP index range scans**. If your EBS AP invoice lookup uses an index on VENDOR_ID, that query does not benefit from Smart Scan at all.

### Storage Index

Each storage cell maintains a 1MB Storage Region Index in memory. For every 1MB extent of table data stored on that cell, CELLSRV records the minimum and maximum value of each column in that extent.

When a Smart Scan runs with a predicate like \`WHERE period_name = 'JAN-2026'\`, CELLSRV checks the Storage Index first. If an entire 1MB extent has \`period_name\` values only between MAR-2020 and DEC-2025, CELLSRV skips reading that extent entirely — zero I/O. Storage Index eliminates I/O before it occurs, unlike Smart Scan which eliminates I/O after reading blocks.

Storage Index is most effective when data in a table is stored in correlated sort order. A GL_BALANCES table loaded month-by-month will naturally have period-correlated storage order — Storage Index eliminates most historical periods for current-period queries.

### Hybrid Columnar Compression (HCC)

HCC is an Exadata-only compression format. Oracle compresses data column-by-column within a Compression Unit (CU, approximately 1MB). Within a CU, all values of Column A are compressed together, then all values of Column B, etc. Column compression achieves 10–50x compression ratios for typical analytical data (much better than OLTP row-level compression).

HCC types and their trade-offs:

| HCC Type | Compression | Query Speed | DML Overhead |
|----------|------------|------------|-------------|
| QUERY LOW | ~6–8x | Fastest | Medium |
| QUERY HIGH | ~10–15x | Fast | Medium |
| ARCHIVE LOW | ~15–25x | Moderate | Higher |
| ARCHIVE HIGH | ~30–50x | Slowest | Highest |

HCC is incompatible with row-level DML at the block level — updates and deletes on HCC blocks require decompression of the entire Compression Unit. This makes HCC appropriate only for **read-mostly or append-only data**: historical tables, archived data, data warehouse fact tables. Never use HCC on EBS OLTP tables (AP_INVOICE_DISTRIBUTIONS_ALL, GL_JE_LINES, etc.).

---

## IORM: I/O Resource Manager

IORM (I/O Resource Manager) manages I/O priority across databases, services, and consumer groups at the storage cell level. Unlike Oracle's database-level Resource Manager (DBRM), IORM operates below the database layer — it controls the actual disk I/O queue on each storage cell.

This is critical on multi-workload Exadata machines where EBS OLTP, ASCP planning, and OBIEE analytics share the same Exadata infrastructure. Without IORM, an ASCP plan run launching 32 parallel queries can saturate the storage cells and degrade EBS OLTP user response times.

\`\`\`sql
-- Example IORM plan: EBS gets highest priority, OBIEE medium, ASCP low
-- (Run on each storage cell via CellCLI, or via dcli for all cells)
ALTER IORMPLAN
  dbplans = (
    (name='EBS_PROD',    level=1, allocation=40),   -- highest priority
    (name='OBIEE',       level=2, allocation=30),
    (name='ASCP_PROD',   level=3, allocation=20),
    (name='OTHER',       level=4, allocation=10)
  ),
  objective=auto;
\`\`\`

---

## Workload-Specific Tuning

### EBS OLTP on Exadata

EBS is an OLTP application. Most user-facing transactions — submitting an AP invoice, querying a sales order, running a GL drilldown — use indexed access paths. Smart Scan does not fire for these operations.

**Where Exadata genuinely helps EBS:**

1. **Concurrent Manager batch programs**: AutoInvoice, GL Transfer, MRP/ASCP collection, Order Import — these do full table scans on large tables. GL_BALANCES, AP_INVOICES_ALL, FND_CONCURRENT_REQUESTS all benefit from Smart Scan when scanned in batch programs.

2. **Period close**: GL period close involves large table scans across multiple GL tables. On an un-partitioned GL schema, these scans benefit significantly from Smart Scan + Storage Index (which eliminates prior-period data from current-period scans).

3. **Flash cache for hot OLTP blocks**: Exadata's Smart Flash Cache keeps frequently accessed OLTP blocks (index leaf blocks, frequently accessed table blocks) in fast flash storage. Even without Smart Scan, Exadata's flash cache often improves OLTP response times by 30–50%.

**EBS-specific configuration:**

\`\`\`sql
-- Verify EBS OLTP service is defined for IORM prioritization
SELECT name, network_name FROM dba_services WHERE name = 'EBS_OLTP_SVC';

-- Create the EBS service for IORM if not exists
BEGIN
  DBMS_SERVICE.CREATE_SERVICE(
    service_name    => 'EBS_OLTP_SVC',
    network_name    => 'EBS_OLTP_SVC.your_domain.com'
  );
  DBMS_SERVICE.START_SERVICE('EBS_OLTP_SVC');
END;
/

-- Key parameter: ensure COMPATIBLE is set for full Exadata features
SELECT name, value FROM v$parameter WHERE name = 'compatible';
-- Should be: 12.2.0.0 or higher for all Exadata 19c features
\`\`\`

**What NOT to do for EBS on Exadata:**

Never apply HCC compression to EBS OLTP tables. \`AP_INVOICE_DISTRIBUTIONS_ALL\`, \`GL_JE_LINES\`, \`FND_CONCURRENT_REQUESTS\` — these have constant row-level UPDATE and DELETE operations. HCC on these tables causes massive CPU overhead for every DML operation.

### ASCP Planning Workload

ASCP's plan solver does massive sequential reads across MSC schema tables (MSC_SUPPLIES, MSC_DEMANDS, MSC_BOM_COMPONENTS, MSC_SYSTEM_ITEMS). This is exactly the workload Smart Scan is designed for.

**HCC on MSC tables:**

\`\`\`sql
-- MSC_SUPPLIES: written during collection, read sequentially during planning
-- QUERY LOW is appropriate: good compression, fast for sequential scan
ALTER TABLE msc.msc_supplies COMPRESS FOR QUERY LOW;

-- Verify HCC compression applied
SELECT table_name, compress_for, num_rows, blocks
FROM dba_tables
WHERE owner = 'MSC'
  AND table_name IN ('MSC_SUPPLIES', 'MSC_DEMANDS', 'MSC_SYSTEM_ITEMS');
\`\`\`

**Storage Index for ASCP:**

ASCP queries filter heavily by PLAN_ID and ORG_ID. If MSC tables are physically organised with data from each plan run written in contiguous extents, Storage Index will eliminate entire extents for other plan IDs.

\`\`\`sql
-- Measure Storage Index effectiveness (run during plan execution)
SELECT stat_name, value
FROM v$mystat ms JOIN v$statname sn ON ms.statistic# = sn.statistic#
WHERE sn.name LIKE '%cell%storage%'
ORDER BY value DESC;
-- 'cell storage index bytes eligible' vs 'cell storage index bytes saved'
-- High ratio = Storage Index is working effectively
\`\`\`

**IORM for ASCP:**

Schedule ASCP plan runs to use lower IORM priority than EBS OLTP. Most ASCP plans run overnight — set ASCP database to IORM level 3, EBS OLTP to level 1.

### Oracle Workflow on Exadata

Oracle Workflow has a persistent performance antipattern. WF_ITEM_ACTIVITY_STATUSES and WF_NOTIFICATION_ATTRIBUTES accumulate millions of rows from completed workflow instances that were never purged. The Workflow background processes (Deferred Activity Agent, Notification Mailer) run full table scans on these bloated tables continuously.

**Smart Scan helps here** — the Workflow background processes' FTS on WF_ITEM_ACTIVITY_STATUSES benefit from Smart Scan + Storage Index once the table grows large enough to bypass buffer cache.

**But the real fix is purging:**

\`\`\`sql
-- Check WF table sizes
SELECT s.segment_name, ROUND(s.bytes/1024/1024/1024, 2) size_gb
FROM dba_segments s
WHERE s.owner = 'APPLSYS'
  AND s.segment_name IN ('WF_ITEM_ACTIVITY_STATUSES', 'WF_NOTIFICATION_ATTRIBUTES',
                          'WF_ITEMS', 'WF_ITEM_ATTRIBUTE_VALUES')
ORDER BY s.bytes DESC;

-- Purge completed workflow instances older than 60 days
BEGIN
  WF_PURGE.Total(
    itemtype  => NULL,    -- all item types
    itemkey   => NULL,    -- all keys
    enddate   => SYSDATE - 60,
    docommit  => TRUE,
    raiseerror => FALSE
  );
END;
/
\`\`\`

Exadata does not eliminate the need for WF purging — it reduces the pain until purging is scheduled. Run WF_PURGE.Total weekly.

**HCC for WF historical tables:**

\`\`\`sql
-- WF_ITEM_ACTIVITY_STATUSES_H (historical archive) is a good HCC candidate
-- It is rarely updated post-archival
ALTER TABLE applsys.wf_item_activity_statuses_h COMPRESS FOR ARCHIVE LOW;
\`\`\`

### OBIEE Analytics on Exadata

OBIEE (Oracle Business Intelligence Enterprise Edition) generates SQL queries with large date-range joins between fact and dimension tables. This is textbook Smart Scan territory.

**Key OBIEE performance patterns on Exadata:**

1. **Star schema full scans**: OBIEE queries join large fact tables (GL_BALANCES_CUBE, custom star schema facts) to date dimensions with range filters. Smart Scan eliminates all non-matching fact rows at the storage cell.

2. **HCC on fact tables**: OBIEE fact tables loaded nightly (not updated in place) are ideal HCC ARCHIVE HIGH candidates.

\`\`\`sql
-- Apply HCC ARCHIVE HIGH to a nightly-refreshed OBIEE fact table
CREATE TABLE bi_schema.sales_fact_new COMPRESS FOR ARCHIVE HIGH
AS SELECT * FROM bi_schema.sales_fact WHERE 1=0;

-- Load into new table
INSERT /*+ APPEND */ INTO bi_schema.sales_fact_new SELECT * FROM bi_schema.sales_fact;
COMMIT;

-- Atomic swap
ALTER TABLE bi_schema.sales_fact RENAME TO sales_fact_old;
ALTER TABLE bi_schema.sales_fact_new RENAME TO sales_fact;
DROP TABLE bi_schema.sales_fact_old;
\`\`\`

3. **OBIEE service IORM**: create a separate Oracle service for OBIEE and assign it IORM level 2 (lower priority than EBS OLTP, higher than development/test databases).

4. **Parallel query for OBIEE**: enable parallel query at the table level for large OBIEE fact tables:

\`\`\`sql
ALTER TABLE bi_schema.sales_fact PARALLEL 8;
-- Or control at session level to prevent parallel query from overwhelming Exadata
ALTER SESSION FORCE PARALLEL QUERY PARALLEL 8;
\`\`\`

---

## Measuring Smart Scan Effectiveness

\`\`\`sql
-- Instance-level Smart Scan statistics
SELECT sn.name, ms.value
FROM v$sysstat ms JOIN v$statname sn ON ms.statistic# = sn.statistic#
WHERE sn.name IN (
  'cell physical IO bytes eligible for predicate offload',
  'cell physical IO interconnect bytes returned by smart scan',
  'cell physical IO bytes saved by storage index',
  'cell blocks processed by cache layer',
  'cell blocks processed by txn layer'
)
ORDER BY ms.value DESC;
\`\`\`

Target offload ratio: "interconnect bytes returned" / "eligible bytes" < 20% indicates Smart Scan is eliminating > 80% of I/O — excellent efficiency. A ratio > 80% indicates the table data has low selectivity for Smart Scan predicates, or Smart Scan is not firing.

The companion runbook provides step-by-step procedures for establishing baselines, diagnosing eligibility issues, applying HCC to target tables, and configuring IORM.`,
};

async function main() {
  console.log('Inserting Exadata Smart Scan EBS OBIEE blog post...');
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
  console.log('Inserted:', JSON.stringify(post.title));
}

main().catch(console.error);
