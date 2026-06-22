import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Exadata Performance Tuning for EBS, ASCP, Workflow, and OBIEE',
  slug: 'exadata-performance-tuning-ebs-obiee-runbook',
  excerpt:
    'Step-by-step operational runbook for establishing Exadata baselines, diagnosing Smart Scan eligibility, tuning Storage Index effectiveness, applying HCC, configuring IORM, and resolving performance issues specific to EBS, Workflow, ASCP, and OBIEE workloads.',
  category: 'exadata' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-22'),
  youtubeUrl: null,
  content: `This runbook provides step-by-step procedures for tuning Oracle Database workloads on Exadata. Assumptions: Oracle Exadata X7M or later, Oracle Database 19c, DBA access to compute nodes, cellcli or dcli access to storage cells, Oracle EBS R12.2.x with ASCP, Oracle Workflow, and OBIEE running on the same Exadata.

---

## Phase 0: Establish Exadata Baselines

### Step 0.1 — Check Exadata Version and Patch Level

\`\`\`bash
# From compute node (as root or oracle user with dcli access)
# Check storage cell software version
dcli -g /home/oracle/cell_group -l celladmin \
  "cellcli -e list cell attributes softwareversion"

# Check database node OS and hardware
uname -r
dmidecode -t system | grep -E "Manufacturer|Product Name"
\`\`\`

\`\`\`sql
-- Check Oracle Database version and active RU
SELECT banner_full FROM v$version WHERE banner_full LIKE 'Oracle Database%';
\`\`\`

### Step 0.2 — Baseline Smart Scan Statistics

Run this query to capture a baseline of Smart Scan offload metrics. Run again after tuning to measure improvement.

\`\`\`sql
-- Smart Scan baseline metrics (instance-level cumulative statistics)
SELECT sn.name stat_name, ms.value
FROM v$sysstat ms
JOIN v$statname sn ON ms.statistic# = sn.statistic#
WHERE sn.name IN (
  'cell physical IO bytes eligible for predicate offload',
  'cell physical IO interconnect bytes returned by smart scan',
  'cell physical IO bytes saved by storage index',
  'cell blocks processed by cache layer',
  'cell IO uncompressed bytes',
  'physical reads',
  'physical read bytes'
)
ORDER BY ms.value DESC;

-- Calculate current offload ratio
SELECT ROUND(
  (SELECT value FROM v$sysstat s JOIN v$statname n ON s.statistic# = n.statistic#
   WHERE n.name = 'cell physical IO interconnect bytes returned by smart scan') * 100.0
  /
  NULLIF(
    (SELECT value FROM v$sysstat s JOIN v$statname n ON s.statistic# = n.statistic#
     WHERE n.name = 'cell physical IO bytes eligible for predicate offload'), 0),
  1) offload_pct_returned;
-- Lower is better: 10% = 90% of data was filtered at the cell. Above 80% = Smart Scan is not filtering effectively.
\`\`\`

### Step 0.3 — Baseline IORM Configuration

\`\`\`bash
# View current IORM plan on all cells
dcli -g /home/oracle/cell_group -l celladmin \
  "cellcli -e list iormplan detail"

# View current database IORM directives
dcli -g /home/oracle/cell_group -l celladmin \
  "cellcli -e list databaseplan detail"
\`\`\`

### Step 0.4 — Baseline Flash Cache Effectiveness

\`\`\`sql
-- Flash cache hit rate
SELECT metric_name, value, metric_unit
FROM v$cell_global
WHERE metric_name LIKE '%flash%'
ORDER BY metric_name;

-- Also check per-cell flash cache usage
-- (Run on each storage cell via CellCLI)
\`\`\`

\`\`\`bash
dcli -g /home/oracle/cell_group -l celladmin \
  "cellcli -e list metriccurrent where metricObjectName='FLASHCACHE' and metricType='Instantaneous'"
\`\`\`

### Step 0.5 — Baseline SGA and Buffer Cache

\`\`\`sql
-- Buffer cache configuration and hit ratio
SELECT name, bytes/1024/1024/1024 size_gb
FROM v$sgainfo
WHERE name IN ('Buffer Cache Size', 'Shared Pool Size', 'Large Pool Size');

SELECT ROUND(1 - (phy.value / (con.value + phy.value)), 4) buffer_cache_hit_ratio
FROM v$sysstat phy, v$sysstat con
WHERE phy.name = 'physical reads'
  AND con.name = 'consistent gets';
-- Target for Exadata OLTP workload: > 0.95 (95%+ logical reads served from cache)
\`\`\`

---

## Phase 1: Diagnose Smart Scan Eligibility for Problem SQL

### Step 1.1 — Find SQL Not Using Smart Scan Despite Large I/O

\`\`\`sql
-- SQL doing large physical I/O but no Smart Scan (check last 7 days in AWR)
SELECT ss.sql_id,
       SUBSTR(st.sql_text, 1, 80) sql_preview,
       ss.physical_read_bytes / 1024 / 1024 / 1024 phys_read_gb,
       ss.executions,
       ss.elapsed_time / 1000000 / ss.executions secs_per_exec
FROM dba_hist_sqlstat ss
JOIN dba_hist_sqltext st ON ss.sql_id = st.sql_id AND ss.dbid = st.dbid
WHERE ss.physical_read_bytes > 10 * 1024 * 1024 * 1024  -- > 10 GB physical reads
  AND ss.snap_id > (SELECT MAX(snap_id) - 168 FROM dba_hist_snapshot)  -- last week
ORDER BY ss.physical_read_bytes DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

### Step 1.2 — Check Execution Plan for Smart Scan Operations

\`\`\`sql
-- Check if SQL uses Smart Scan (look for 'cell smart table scan' in plan)
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR('&sql_id', NULL, 'IOSTATS LAST'));

-- In the plan output, look for:
-- Operation: TABLE ACCESS FULL → check Notes column
-- Notes should show: "cell smart table scan" if Smart Scan fired
-- If Notes is empty or shows "Parallel Full Table Scan" without cell smart: Smart Scan did NOT fire
\`\`\`

### Step 1.3 — Diagnose Why Smart Scan Is Not Firing

\`\`\`sql
-- Check if the table is being served from buffer cache (too small for direct path reads)
SELECT table_name,
       num_rows,
       blocks,
       ROUND(blocks * 8192 / 1024 / 1024 / 1024, 3) table_size_gb
FROM dba_tables
WHERE owner = '&owner'
  AND table_name = '&table_name';

-- Check buffer cache size vs table size
-- If table_size_gb < (buffer_cache_gb * 0.02) → table may be cached; Smart Scan won't fire
SELECT ROUND(bytes/1024/1024/1024, 1) buffer_cache_gb
FROM v$sgainfo WHERE name = 'Buffer Cache Size';

-- Force direct path reads for a test query (non-production testing only):
ALTER SESSION SET "_serial_direct_read" = ALWAYS;
-- Re-run the query and check v$mystat for 'cell physical IO bytes eligible for predicate offload'
ALTER SESSION SET "_serial_direct_read" = AUTO;  -- reset after test
\`\`\`

### Step 1.4 — Check for SQL Hints Preventing Smart Scan

\`\`\`sql
-- Get full SQL text for the problem SQL ID
SELECT sql_fulltext FROM v$sql WHERE sql_id = '&sql_id';
-- Look for hints: /*+ NO_RESULT_CACHE */ /*+ INDEX(t idx_name) */ that might force index access
-- Also look for hints applied via SQL Plan Baselines or SQL Profiles
SELECT name, category, sql_text FROM dba_sql_profiles
WHERE name IN (SELECT profile_name FROM dba_sql_plan_baselines WHERE sql_id = '&sql_id');
\`\`\`

---

## Phase 2: Tune Storage Index Effectiveness

### Step 2.1 — Measure Storage Index Hit Rate

\`\`\`bash
# Check Storage Index effectiveness on each storage cell
dcli -g /home/oracle/cell_group -l celladmin \
  "cellcli -e list metriccurrent where metricType='Instantaneous' and metricObjectName like 'DB%' and name like '%storageIndex%'"
\`\`\`

\`\`\`sql
-- Oracle-level Storage Index stats
SELECT sn.name, ms.value
FROM v$sysstat ms JOIN v$statname sn ON ms.statistic# = sn.statistic#
WHERE sn.name LIKE '%storage index%';
-- 'cell physical IO bytes saved by storage index' → higher = more data bypassed via SI
\`\`\`

### Step 2.2 — Identify Tables with Poor Storage Index Benefit

Poor Storage Index benefit occurs when column values are randomly distributed across extents (e.g., table filled via round-robin partition exchange, or ORDER BY omitted on bulk insert). Storage Index cannot exclude extents when min/max values overlap between extents.

\`\`\`sql
-- Check column value distribution for a key filter column
-- High NDV (distinct values) with good clustering = good Storage Index candidate
SELECT num_distinct, low_value, high_value, density, avg_col_len
FROM dba_tab_col_statistics
WHERE owner = 'MSC'
  AND table_name = 'MSC_SUPPLIES'
  AND column_name = 'PLAN_ID';
\`\`\`

### Step 2.3 — Re-cluster Table Data for Better Storage Index Benefit

If data is not correlated, CTAS with ORDER BY re-clusters data physically:

\`\`\`sql
-- CTAS with ORDER BY for better Storage Index clustering
-- (Do during maintenance window — requires table rebuild)
CREATE TABLE msc.msc_supplies_new AS
  SELECT * FROM msc.msc_supplies
  ORDER BY plan_id, organization_id, inventory_item_id;

-- Gather statistics
EXEC DBMS_STATS.GATHER_TABLE_STATS('MSC', 'MSC_SUPPLIES_NEW', CASCADE => TRUE);

-- Atomic rename
ALTER TABLE msc.msc_supplies RENAME TO msc_supplies_old;
ALTER TABLE msc.msc_supplies_new RENAME TO msc_supplies;

-- Recreate indexes (they were on the old table)
-- Then drop old table after validation
\`\`\`

---

## Phase 3: Apply HCC to Eligible Tables

### Step 3.1 — Identify HCC Candidates

\`\`\`sql
-- Large tables with read-mostly access pattern (minimal DML)
SELECT owner, table_name,
       num_rows,
       ROUND(blocks * 8192 / 1024 / 1024 / 1024, 2) size_gb,
       last_analyzed,
       compress_for
FROM dba_tables
WHERE owner IN ('MSC', 'GL', 'BI')
  AND blocks * 8192 > 500 * 1024 * 1024  -- > 500 MB
  AND (compress_for IS NULL OR compress_for NOT LIKE '%HCC%')
ORDER BY blocks DESC;
\`\`\`

Confirm each candidate is truly read-mostly:

\`\`\`sql
-- Check DML frequency from AWR (modifications per day)
SELECT object_name, modifications, inserts, updates, deletes,
       timestamp last_analyzed
FROM dba_tab_modifications
WHERE table_owner = 'MSC'
  AND object_name = 'MSC_SUPPLIES'
ORDER BY modifications DESC;
-- If updates + deletes are significant: do NOT use HCC for this table
\`\`\`

### Step 3.2 — Apply HCC Using CTAS

\`\`\`sql
-- Apply QUERY LOW to MSC_SUPPLIES (frequently queried by planning engine)
CREATE TABLE msc.msc_supplies_hcc COMPRESS FOR QUERY LOW
AS SELECT * FROM msc.msc_supplies WHERE 1=0;  -- structure only first

-- Load data (use parallel insert for large tables)
INSERT /*+ APPEND PARALLEL(4) */ INTO msc.msc_supplies_hcc
SELECT * FROM msc.msc_supplies;
COMMIT;

-- Gather statistics
EXEC DBMS_STATS.GATHER_TABLE_STATS('MSC', 'MSC_SUPPLIES_HCC', CASCADE => TRUE, DEGREE => 4);

-- Verify HCC applied and measure compression
SELECT table_name, compress_for, num_rows,
       blocks old_blocks_equivalent,
       ROUND(blocks * 8192 / 1024 / 1024 / 1024, 2) compressed_gb
FROM dba_tables WHERE owner='MSC' AND table_name='MSC_SUPPLIES_HCC';

-- Compare to original size
SELECT table_name, blocks,
       ROUND(blocks * 8192 / 1024 / 1024 / 1024, 2) original_gb
FROM dba_tables WHERE owner='MSC' AND table_name='MSC_SUPPLIES';
\`\`\`

### Step 3.3 — Atomic Swap

After validation that HCC table is complete and statistics are gathered:

\`\`\`sql
ALTER TABLE msc.msc_supplies RENAME TO msc_supplies_original;
ALTER TABLE msc.msc_supplies_hcc RENAME TO msc_supplies;
-- Recreate any grants and synonyms on the new table
-- Test ASCP planning query against new HCC table
-- DROP TABLE msc.msc_supplies_original after 1 week validation
\`\`\`

---

## Phase 4: Configure IORM

### Step 4.1 — Define IORM Plan

\`\`\`bash
# Create IORM plan with database-level directives
# Run on ONE storage cell (plan replicates to all cells)
dcli -g /home/oracle/cell_group -l celladmin "cellcli -e ALTER IORMPLAN \
  dbplans = ( \
    (name='EBS_PROD', level=1, allocation=40), \
    (name='OBIEE_PROD', level=2, allocation=25), \
    (name='ASCP_PROD', level=3, allocation=20), \
    (name='EBS_DEV', level=4, allocation=10), \
    (name='other', level=5, allocation=5) \
  ), \
  objective=auto"
\`\`\`

### Step 4.2 — Verify IORM Active

\`\`\`bash
dcli -g /home/oracle/cell_group -l celladmin "cellcli -e list iormplan detail"
# Confirm: 'status' = 'active'
\`\`\`

### Step 4.3 — Test IORM Under Load

Run an ASCP plan during EBS business hours. Monitor EBS user response times before and after IORM is activated. EBS OLTP queries should not show increased latency despite ASCP running simultaneously.

\`\`\`sql
-- Monitor IORM effectiveness during ASCP plan run
SELECT inst_id, wait_class, event, COUNT(*) sessions,
       ROUND(AVG(seconds_in_wait), 2) avg_wait_secs
FROM gv$session
WHERE wait_class != 'Idle'
  AND username IS NOT NULL
GROUP BY inst_id, wait_class, event
ORDER BY sessions DESC;
-- EBS user sessions should NOT show 'cell smart table scan' or I/O waits during ASCP plan
\`\`\`

---

## Phase 5: EBS-Specific Tuning

### Step 5.1 — Verify EBS Uses an IORM-Eligible Service

\`\`\`sql
SELECT name, network_name, goal
FROM dba_services
WHERE name LIKE '%EBS%' OR network_name LIKE '%ebs%';
\`\`\`

If no EBS-specific service exists: create one and configure EBS to connect via that service (update EBS tnsnames.ora to use the service name, run AutoConfig).

### Step 5.2 — Verify OLTP Tables Are Not HCC-Compressed

\`\`\`sql
-- Ensure key EBS OLTP tables are NOT HCC
SELECT table_name, compress_for
FROM dba_tables
WHERE owner IN ('AP', 'GL', 'AR', 'INV', 'APPLSYS')
  AND table_name IN (
    'AP_INVOICE_DISTRIBUTIONS_ALL',
    'GL_JE_LINES',
    'AR_RECEIVABLE_APPLICATIONS_ALL',
    'MTL_MATERIAL_TRANSACTIONS',
    'FND_CONCURRENT_REQUESTS'
  );
-- compress_for must be NULL or BASIC (not QUERY LOW/HIGH or ARCHIVE)
\`\`\`

### Step 5.3 — Review Top EBS Batch Programs for Smart Scan Eligibility

\`\`\`sql
-- Top 10 EBS concurrent programs by elapsed time in last 7 days
SELECT cp.concurrent_program_name, COUNT(*) runs,
       AVG(ROUND((fcr.actual_completion_date - fcr.actual_start_date) * 60, 1)) avg_mins
FROM applsys.fnd_concurrent_requests fcr
JOIN applsys.fnd_concurrent_programs cp
  ON fcr.concurrent_program_id = cp.concurrent_program_id
  AND fcr.program_application_id = cp.application_id
WHERE fcr.actual_start_date > SYSDATE - 7
  AND fcr.phase_code = 'C' AND fcr.status_code = 'C'
GROUP BY cp.concurrent_program_name
ORDER BY avg_mins DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

For each top program: capture the AWR SQL profile during a run, check whether the top SQL statements use "cell smart table scan". If not, investigate eligibility using Phase 1 procedures.

---

## Phase 6: ASCP-Specific Tuning

### Step 6.1 — Apply HCC to MSC Planning Tables

Follow Phase 3 procedure for:
- \`MSC.MSC_SUPPLIES\` → COMPRESS FOR QUERY LOW
- \`MSC.MSC_DEMANDS\` → COMPRESS FOR QUERY LOW
- \`MSC.MSC_SYSTEM_ITEMS\` → COMPRESS FOR QUERY LOW
- \`MSC.MSC_BOM_COMPONENTS\` → COMPRESS FOR ARCHIVE LOW (rarely updated post-collection)

### Step 6.2 — Tune Parallel Degree for ASCP Collection

\`\`\`sql
-- Set parallel degree for MSC tables during collection phase
ALTER TABLE msc.msc_supplies PARALLEL 8;
ALTER TABLE msc.msc_demands PARALLEL 8;
-- Reduces collection run time for large planning databases
-- Reset after collection if IORM conflict with EBS OLTP:
ALTER TABLE msc.msc_supplies NOPARALLEL;
\`\`\`

---

## Phase 7: Oracle Workflow-Specific Tuning

### Step 7.1 — Check WF Table Sizes (Purge First)

\`\`\`sql
SELECT segment_name, ROUND(bytes/1024/1024/1024, 2) gb
FROM dba_segments
WHERE owner = 'APPLSYS'
  AND segment_name IN ('WF_ITEM_ACTIVITY_STATUSES', 'WF_NOTIFICATION_ATTRIBUTES',
                        'WF_ITEMS', 'WF_ITEM_ATTRIBUTE_VALUES')
ORDER BY bytes DESC;
\`\`\`

If WF_ITEM_ACTIVITY_STATUSES > 5 GB: run WF_PURGE.Total before applying HCC. HCC on a table with 80% old/purgeable data wastes compression on rows that will be deleted.

### Step 7.2 — Apply HCC to WF Historical Tables

\`\`\`sql
-- WF_ITEM_ACTIVITY_STATUSES_H (historical archive) - ARCHIVE LOW
ALTER TABLE applsys.wf_item_activity_statuses_h COMPRESS FOR ARCHIVE LOW;
-- Rebuild: populate into new HCC table using CTAS if alter in-place is too slow
\`\`\`

### Step 7.3 — Schedule Regular WF Purge

\`\`\`sql
-- Create a DBMS_SCHEDULER job for weekly WF purge
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'WF_WEEKLY_PURGE',
    job_type        => 'PLSQL_BLOCK',
    job_action      => 'BEGIN WF_PURGE.Total(itemtype=>NULL, itemkey=>NULL, enddate=>SYSDATE-60, docommit=>TRUE, raiseerror=>FALSE); END;',
    start_date      => TRUNC(NEXT_DAY(SYSDATE, 'SUNDAY')) + 2/24,  -- Sunday 2 AM
    repeat_interval => 'FREQ=WEEKLY; BYDAY=SUN; BYHOUR=2; BYMINUTE=0',
    enabled         => TRUE
  );
END;
/
\`\`\`

---

## Phase 8: OBIEE-Specific Tuning

### Step 8.1 — Create OBIEE Service for IORM

\`\`\`sql
BEGIN
  DBMS_SERVICE.CREATE_SERVICE(
    service_name    => 'OBIEE_SVC',
    network_name    => 'OBIEE_SVC.company.com'
  );
  DBMS_SERVICE.START_SERVICE('OBIEE_SVC');
END;
/
\`\`\`

Configure the OBIEE RPD (Repository) connection pool to use the OBIEE_SVC service name. IORM will then throttle OBIEE I/O relative to EBS OLTP.

### Step 8.2 — Apply HCC to OBIEE Fact Tables

For each nightly-refreshed OBIEE fact table:

\`\`\`sql
-- Create HCC version of fact table
CREATE TABLE bi.gl_fact_hcc COMPRESS FOR ARCHIVE HIGH
PARALLEL 8
AS SELECT * FROM bi.gl_fact ORDER BY fiscal_year, period_name, ledger_id;

-- Verify row counts match
SELECT COUNT(*) FROM bi.gl_fact;
SELECT COUNT(*) FROM bi.gl_fact_hcc;

-- Atomic swap and validate query performance
ALTER TABLE bi.gl_fact RENAME TO gl_fact_old;
ALTER TABLE bi.gl_fact_hcc RENAME TO gl_fact;
\`\`\`

### Step 8.3 — Configure Parallel Query for OBIEE

\`\`\`sql
-- Set optimal DOP for OBIEE star schema queries
-- Too high a DOP saturates Exadata InfiniBand
ALTER TABLE bi.gl_fact PARALLEL 8;
ALTER TABLE bi.gl_fact_dim PARALLEL 4;

-- Or control at the session level via OBIEE connection pool init command:
-- ALTER SESSION FORCE PARALLEL QUERY PARALLEL 8;
\`\`\`

### Step 8.4 — Monitor OBIEE Smart Scan Effectiveness

After applying HCC and enabling parallel queries, measure Smart Scan effectiveness during an OBIEE report run:

\`\`\`sql
-- During an OBIEE dashboard load
SELECT sn.name, ms.value - lag(ms.value, 1, 0) OVER (ORDER BY sn.name) delta
FROM v$mystat ms JOIN v$statname sn ON ms.statistic# = sn.statistic#
WHERE sn.name IN (
  'cell physical IO bytes eligible for predicate offload',
  'cell physical IO interconnect bytes returned by smart scan',
  'cell physical IO bytes saved by storage index'
)
ORDER BY sn.name;
-- Target: 'interconnect bytes returned' should be < 20% of 'eligible bytes'
\`\`\``,
};

async function main() {
  console.log('Inserting Exadata performance tuning runbook...');
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
