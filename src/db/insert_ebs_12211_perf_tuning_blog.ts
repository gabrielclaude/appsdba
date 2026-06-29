import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS 12.2.11 Performance Tuning: Database Tier, Application Tier, and Concurrent Manager',
  slug: 'oracle-ebs-12211-performance-tuning',
  excerpt:
    'A technical guide to Oracle EBS 12.2.11 performance tuning across all three tiers — the EBS-specific Oracle 19c database parameters that adaptive plans and bitmap plans break, why FND_STATS must be used instead of plain DBMS_STATS for APPS schema statistics, SGA and PGA sizing for EBS workloads, WebLogic JVM and connection pool tuning for the OA Framework managed servers, Concurrent Manager queue specialization and workshift configuration, and the AWR and ASH queries that isolate EBS performance bottlenecks quickly.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-29'),
  youtubeUrl: null,
  content: `## Overview

Oracle E-Business Suite 12.2.11 is a multi-tier application that creates performance problems at three independent layers: the Oracle 19c database tier, the WebLogic and Oracle HTTP Server application tier, and the Oracle Concurrent Manager batch processing layer. A slowdown in any one tier produces symptoms in all of them — slow forms, slow OAF pages, and long-running concurrent programs often have different root causes even when they appear simultaneously.

Effective EBS performance tuning requires isolating which tier is the bottleneck before changing any parameter. This post covers the tuning levers at each tier, the EBS-specific constraints that prevent certain standard Oracle database tuning practices from being applied, and the diagnostic queries that identify where time is being lost.

---

## The EBS Performance Architecture

Understanding what runs where is the foundation of EBS performance diagnosis:

\`\`\`
Browser / Forms Client
    ↓ HTTP/HTTPS
Oracle HTTP Server (OHS)        ← Application Tier (prod-app)
    ↓ mod_wl_ohs
WebLogic Managed Servers         ← Application Tier (prod-app)
  ├── oacore  (OA Framework pages)
  ├── oafm    (ADF, utilities)
  └── oapls   (PL/SQL gateway)
    ↓ JDBC (APPS password, thin driver)
Oracle 19c Database (APPS schema) ← Database Tier (prod-db)
    ↓
Data files, Undo, Redo
\`\`\`

Oracle Forms connects directly to the database listener — it does not route through WebLogic. Forms performance is primarily a database-tier and network-latency concern.

Concurrent programs run as OS processes spawned by the Concurrent Manager on the application tier, connecting to the database as APPS. Concurrent program performance is almost always a database-tier issue (SQL execution, statistics quality, I/O throughput).

OA Framework pages run inside WebLogic managed servers. Slow OAF pages are either a database issue (slow SQL from the OAF model layer), a WebLogic JVM issue (GC pauses, heap exhaustion), or a connection pool starvation issue (all JDBC connections are in use).

---

## Database Tier: EBS-Specific Parameters

Oracle 19c introduces several optimizer features that are beneficial for general OLTP workloads but produce plan instability in EBS. Oracle's own recommendations for running EBS on Oracle 19c require several of these features to be disabled.

### Adaptive Plans and Statistics Feedback

Oracle 19c adaptive SQL plan management (introduced in 12c) allows the optimizer to switch execution plans mid-execution based on observed cardinality errors. While this sounds beneficial, EBS has thousands of SQL statements with complex joins across the APPS schema. Mid-execution plan changes produce unpredictable response times — a query that ran in 2 seconds may suddenly take 45 seconds if the adaptive plan mechanism switches to a different join order.

\`\`\`sql
-- Disable adaptive plans for EBS (recommended by Oracle MOS Note 2626517.1)
ALTER SYSTEM SET "_optimizer_adaptive_plans" = FALSE SCOPE=BOTH;
ALTER SYSTEM SET "_optimizer_adaptive_statistics" = FALSE SCOPE=BOTH;
ALTER SYSTEM SET "_optimizer_use_feedback" = FALSE SCOPE=BOTH;
\`\`\`

### Bitmap Join Plans

The EBS APPS schema uses surrogate keys extensively, and many fact-style tables in EBS (transaction headers, transaction lines) have low-cardinality columns that the optimizer can misidentify as good candidates for bitmap join plans. Bitmap join plans in OLTP environments cause significant row-level locking contention.

\`\`\`sql
-- Disable bitmap join plans for EBS OLTP workloads
ALTER SYSTEM SET "_b_tree_bitmap_plans" = FALSE SCOPE=BOTH;
\`\`\`

### Cursor Sharing

EBS is designed to use bind variables, but some EBS modules and custom code use literal SQL. Setting \`CURSOR_SHARING=FORCE\` causes excessive library cache activity in EBS because the optimizer must parse each "similified" cursor separately. Oracle recommends \`EXACT\` for EBS.

\`\`\`sql
ALTER SYSTEM SET CURSOR_SHARING = EXACT SCOPE=BOTH;
\`\`\`

### Parallel Execution Degree Limit

EBS concurrent programs can generate SQL with high parallelism hints. Without a degree limit, parallel execution can monopolise all CPU cores during a concurrent program run, starving interactive forms users. Setting a maximum degree and enabling the parallel statement queuing mechanism prevents this.

\`\`\`sql
ALTER SYSTEM SET PARALLEL_MAX_SERVERS = 32 SCOPE=BOTH;
ALTER SYSTEM SET PARALLEL_MIN_SERVERS = 4 SCOPE=BOTH;
ALTER SYSTEM SET PARALLEL_DEGREE_LIMIT = 8 SCOPE=BOTH;
ALTER SYSTEM SET PARALLEL_DEGREE_POLICY = AUTO SCOPE=BOTH;
\`\`\`

---

## Database Tier: Memory Sizing for EBS

### SGA Components

EBS has a large shared pool requirement because thousands of PL/SQL packages (the APPS schema contains over 50,000 PL/SQL objects) must be kept in the shared pool to avoid hard parses. The buffer cache must be large enough to keep frequently accessed EBS reference tables (GL_CODE_COMBINATIONS, FND_LOOKUPS, HR_ALL_ORGANIZATION_UNITS) in memory.

| SGA Component | EBS Guidance | Why |
|--------------|-------------|-----|
| Shared Pool | 4–8 GB | PL/SQL package bodies, cursor cache |
| Buffer Cache | 60–70% of SGA | Reference tables, transaction blocks |
| Large Pool | 1–2 GB | Parallel execution message buffers, RMAN |
| Java Pool | 1 GB | Java-based EBS concurrent programs |
| Streams Pool | 512 MB–1 GB | GoldenGate if in use |

For a database server with 256 GB RAM:
\`\`\`sql
ALTER SYSTEM SET SGA_TARGET = 160G SCOPE=SPFILE;
ALTER SYSTEM SET SGA_MAX_SIZE = 160G SCOPE=SPFILE;
ALTER SYSTEM SET SHARED_POOL_SIZE = 6G SCOPE=SPFILE;
ALTER SYSTEM SET DB_CACHE_SIZE = 120G SCOPE=SPFILE;
ALTER SYSTEM SET LARGE_POOL_SIZE = 2G SCOPE=SPFILE;
ALTER SYSTEM SET JAVA_POOL_SIZE = 1G SCOPE=SPFILE;
ALTER SYSTEM SET PGA_AGGREGATE_TARGET = 32G SCOPE=SPFILE;
ALTER SYSTEM SET PGA_AGGREGATE_LIMIT = 64G SCOPE=SPFILE;
\`\`\`

### Shared Pool Pinning for Core EBS Packages

Several core EBS PL/SQL packages should be pinned into the shared pool to prevent them from aging out during high-load periods. Pinning prevents a hard parse storm when these packages are needed after being flushed.

\`\`\`sql
-- Pin core EBS packages into the shared pool (run at startup)
BEGIN
  DBMS_SHARED_POOL.KEEP('FND_GLOBAL', 'P');
  DBMS_SHARED_POOL.KEEP('FND_PROFILE', 'P');
  DBMS_SHARED_POOL.KEEP('FND_REQUEST', 'P');
  DBMS_SHARED_POOL.KEEP('MO_GLOBAL', 'P');
  DBMS_SHARED_POOL.KEEP('HR_GENERAL', 'P');
  DBMS_SHARED_POOL.KEEP('HR_SECURITY', 'P');
  DBMS_SHARED_POOL.KEEP('FND_DATE', 'P');
  DBMS_SHARED_POOL.KEEP('FND_NUMBER', 'P');
END;
/
\`\`\`

---

## Database Tier: Statistics Management with FND_STATS

The most common cause of sudden plan changes and performance regression in EBS is stale or incorrect optimizer statistics. EBS provides its own statistics gathering procedure — \`FND_STATS\` — that must be used instead of plain \`DBMS_STATS\` for the APPS schema.

### Why FND_STATS Instead of DBMS_STATS

\`FND_STATS\` does several things that \`DBMS_STATS\` does not:
- Populates the \`FND_HISTOGRAM_COLS\` table to control which columns receive histograms (EBS has specific columns that benefit from histograms and others that produce bad plans when histogrammed)
- Manages fixed-size table statistics for small EBS reference tables (which DBMS_STATS may underestimate)
- Integrates with EBS concurrent program infrastructure for scheduled execution
- Calls \`FND_STATS.LOAD_XCLUD_TAB\` to exclude certain volatile EBS tables from statistics gathering

### Gathering Statistics via FND_STATS

\`\`\`sql
-- Gather stats for a single EBS schema
BEGIN
  FND_STATS.GATHER_SCHEMA_STATISTICS(
    schemaname  => 'APPS',
    percent     => 10,          -- 10% sample, appropriate for most tables
    degree      => 4,           -- parallel degree for stats gathering
    internal_flag => 'NOBACKUP' -- do not back up existing stats
  );
END;
/

-- Gather stats for all EBS product schemas (long-running, run as concurrent program)
BEGIN
  FND_STATS.GATHER_ALL_COLUMN_STATS(
    percent => 10,
    degree  => 4
  );
END;
/
\`\`\`

### Schedule the EBS Gather Schema Statistics Concurrent Program

The correct way to keep EBS statistics current is via the seeded concurrent program **Gather Schema Statistics** (program name: FNDGSCST):

\`\`\`
System Administrator → Requests → Run
  Program: Gather Schema Statistics
  Parameters:
    Schema Name: ALL   (or specific schema)
    Percent:     10
    Degree:      4
    Backup Flag: NOBACKUP
  Schedule: Weekly on Sunday at 01:00 (or after weekend batch close)
\`\`\`

---

## Database Tier: Key Wait Events to Monitor

EBS-specific wait event analysis focuses on a different set of events than a generic OLTP database:

| Wait Event | EBS Interpretation | Common Cause |
|------------|-------------------|-------------|
| \`log file sync\` | Commit latency — interactive user impact | Slow redo storage, excessive small commits |
| \`db file sequential read\` | Index scan latency | Missing index, stale statistics causing full scans |
| \`library cache lock\` | Package compilation or invalidation | Stats gather invalidating dependent objects |
| \`library cache: mutex X\` | Shared pool contention | Shared pool too small, cursor sharing issues |
| \`latch: row cache objects\` | Data dictionary cache miss | Shared pool undersized for EBS package count |
| \`enq: TX - row lock contention\` | Application-level row locking | Long-running concurrent programs holding locks |
| \`enq: TM - contention\` | Table-level lock | DDL during business hours, missing FK indexes |
| \`buffer busy waits\` | Hot block in buffer cache | High-volume EBS sequence generators (FND_CONCURRENT_REQUESTS) |
| \`cursor: pin S wait on X\` | Parallel SQL cursor pinning | High-degree parallel programs contending with interactive sessions |

The most impactful EBS performance lever after statistics is the shared pool. A correctly sized shared pool with the core EBS packages pinned eliminates \`library cache\` and \`row cache\` waits that cumulatively add seconds to every EBS page load and form open.

---

## Application Tier: WebLogic JVM Tuning

Each WebLogic managed server (oacore, oafm, oapls) is a JVM process. JVM sizing and garbage collection configuration directly affects OAF page response time and throughput.

### Heap Sizing for oacore (OA Framework)

The oacore managed server handles all OA Framework page requests. It maintains an in-memory OAF page metadata cache that grows proportionally with the number of distinct OAF pages accessed. Insufficient heap causes excessive GC pauses.

For a server with 64 GB physical RAM running a standard EBS installation:
\`\`\`
oacore JVM arguments:
  -Xms8192m            Initial heap: 8 GB
  -Xmx8192m            Max heap: 8 GB (same as initial to prevent resizing pauses)
  -XX:+UseG1GC         G1 Garbage Collector (recommended over CMS for EBS)
  -XX:MaxGCPauseMillis=500
  -XX:G1HeapRegionSize=32m
  -XX:InitiatingHeapOccupancyPercent=45
  -XX:+ParallelRefProcEnabled
  -XX:+DisableExplicitGC  (prevents System.gc() calls from EBS code)
\`\`\`

Set in WebLogic Console → Servers → oacore → Server Start → Arguments, or in \`setUserOverridesLax.sh\`:

\`\`\`bash
# $EBS_DOMAIN_HOME/bin/setUserOverridesLax.sh
USER_MEM_ARGS="-Xms8192m -Xmx8192m -XX:+UseG1GC -XX:MaxGCPauseMillis=500 -XX:G1HeapRegionSize=32m -XX:InitiatingHeapOccupancyPercent=45 -XX:+ParallelRefProcEnabled -XX:+DisableExplicitGC"
export USER_MEM_ARGS
\`\`\`

### Connection Pool Sizing

JDBC connection pools are the bridge between WebLogic and the Oracle database. Pool exhaustion — all connections in use — causes OAF page requests to queue inside WebLogic, producing timeouts that appear as application slowness but are actually connection starvation.

\`\`\`
WebLogic Console → Services → Data Sources → EBSDataSource → Connection Pool:
  Initial Capacity:          10
  Maximum Capacity:          200   (size to peak concurrent user count)
  Minimum Capacity:          10
  Statement Cache Size:      100   (caches prepared statements — critical for EBS)
  Statement Cache Type:      LRU
  Test Connections on Reserve: true
  Test Table Name:           SQL SELECT 1 FROM DUAL
  Test Frequency:            300   (seconds between background tests)
  Seconds to Trust Idle Pool: 10
\`\`\`

### OAF Page Metadata Cache

The OA Framework caches compiled page metadata and profile values in memory. The cache size is controlled by an EBS system profile:

\`\`\`sql
-- Increase the OAF metadata cache size at site level
-- Default is typically 1000 pages; increase for large EBS installations
BEGIN
  FND_PROFILE.SAVE(
    X_NAME        => 'FND_CACHE_MAX_PAGES',
    X_VALUE       => '5000',
    X_LEVEL_NAME  => 'SITE',
    X_LEVEL_VALUE => NULL
  );
  COMMIT;
END;
/

-- Force profile cache refresh after change
EXECUTE FND_CACHE_VERSIONS_PKG.UPDATE_ALL_VERSIONS;
COMMIT;
\`\`\`

---

## Concurrent Manager Performance

Concurrent programs are the most common performance complaint in EBS. Slow batch programs affect period-close cycles, financial reporting, and supply chain planning runs.

### Manager Specialization and Workshift Configuration

The Standard Manager processes all programs by default and is the most common bottleneck. Specialization moves high-volume or long-running programs to dedicated managers:

\`\`\`
System Administrator → Concurrent → Manager → Define
  Manager: PAYABLES_MANAGER
  Type:    Concurrent Manager
  Work Shifts: Standard (08:00–18:00, 5 target processes)
               Overnight (18:00–08:00, 10 target processes)
  Specialization Rules:
    Include: Program = AP Invoice Import
    Include: Program = AP Payment Batch
    Include: Application = Oracle Payables
\`\`\`

### Target Processes and Resource Manager Integration

The **target processes** setting on each work shift controls how many concurrent program processes that manager starts. Over-provisioning target processes on a small database server starves the database of CPU; under-provisioning serializes programs that could run in parallel.

Right-sizing rule: start with 2× the number of database CPUs as the maximum across all managers, then reduce based on observed database CPU wait.

\`\`\`sql
-- Check concurrent manager target process counts
SELECT CONCURRENT_QUEUE_NAME,
       RUNNING_PROCESSES,
       TARGET_PROCESSES,
       MAX_PROCESSES
FROM FND_CONCURRENT_QUEUES
WHERE ENABLED_FLAG = 'Y'
ORDER BY RUNNING_PROCESSES DESC;
\`\`\`

### Oracle Database Resource Manager for EBS

Resource Manager integration allows the DBA to prioritize interactive EBS sessions over batch concurrent programs during business hours:

\`\`\`sql
-- Create consumer groups for EBS sessions
BEGIN
  DBMS_RESOURCE_MANAGER.CREATE_PENDING_AREA();

  DBMS_RESOURCE_MANAGER.CREATE_CONSUMER_GROUP(
    consumer_group => 'EBS_INTERACTIVE',
    comment        => 'EBS Forms and OAF user sessions');

  DBMS_RESOURCE_MANAGER.CREATE_CONSUMER_GROUP(
    consumer_group => 'EBS_BATCH',
    comment        => 'EBS Concurrent Manager programs');

  DBMS_RESOURCE_MANAGER.CREATE_PLAN(
    plan    => 'EBS_RESOURCE_PLAN',
    comment => 'EBS business hours plan');

  -- Interactive sessions get 70% CPU, batch gets 30%
  DBMS_RESOURCE_MANAGER.CREATE_PLAN_DIRECTIVE(
    plan            => 'EBS_RESOURCE_PLAN',
    group_or_subplan => 'EBS_INTERACTIVE',
    comment         => 'Interactive priority',
    cpu_p1          => 70);

  DBMS_RESOURCE_MANAGER.CREATE_PLAN_DIRECTIVE(
    plan            => 'EBS_RESOURCE_PLAN',
    group_or_subplan => 'EBS_BATCH',
    comment         => 'Batch lower priority',
    cpu_p1          => 30);

  DBMS_RESOURCE_MANAGER.SUBMIT_PENDING_AREA();
END;
/

-- Activate the plan during business hours
ALTER SYSTEM SET RESOURCE_MANAGER_PLAN = 'EBS_RESOURCE_PLAN' SCOPE=BOTH;
\`\`\`

---

## Forms Performance

Oracle Forms connects directly to the database listener — each Forms session is a dedicated database server process. Forms performance issues are almost always database-tier issues: slow SQL in form triggers, missing indexes on queried columns, or lock contention.

**Key Forms performance diagnostics**:
- Enable the Forms Server trace: set \`FORMS_TRACE_DIR\` and \`FORMS60_TRACE_FILE\` in the Forms configuration
- Oracle Forms statistics are visible in \`V\$SESSION\` with \`MODULE = 'FRMWEB'\`
- Long-running Forms SQL appears in \`V\$SQL\` filtered by module

**Common Forms performance fixes**:
- Add indexes on columns used in Forms LOV queries (List of Values queries are one of the top Forms SQL hot spots)
- Reduce the default LOV record count via EBS profile \`FND_LOV_THRESHOLD\` to limit rows fetched
- Set \`FORMS_TIMEOUT\` appropriately — too short causes premature disconnections; too long holds database connections idle

---

## Summary

Oracle EBS 12.2.11 performance tuning is a layered problem that must be addressed tier by tier:

**Database tier**: Disable Oracle 19c features that destabilise EBS — adaptive plans (\`_optimizer_adaptive_plans=FALSE\`), statistics feedback (\`_optimizer_use_feedback=FALSE\`), and bitmap join plans (\`_b_tree_bitmap_plans=FALSE\`). Use \`FND_STATS\` instead of \`DBMS_STATS\` for APPS schema statistics; the distinction prevents histogram misapplication on EBS-specific column distributions. Size the shared pool at 4–8 GB and pin core EBS packages to eliminate library cache waits. Monitor \`log file sync\`, \`library cache lock\`, and \`latch: row cache objects\` as the primary EBS wait event indicators.

**Application tier**: Size WebLogic JVM heaps at 8 GB for oacore with G1GC and fixed Xms=Xmx to prevent heap resizing pauses. Size the JDBC connection pool maximum capacity to peak concurrent user count. Increase the OAF metadata cache size via \`FND_CACHE_MAX_PAGES\` for large EBS installations.

**Concurrent Manager**: Specialise managers for high-volume programs to prevent serialization at the Standard Manager. Right-size target processes to 2× database CPUs. Use Oracle Resource Manager to protect interactive EBS sessions from batch program CPU consumption during business hours.

The companion runbook provides the complete command sequence for each tuning phase, including AWR and ASH diagnostic queries for EBS-specific wait event isolation, FND_STATS scheduling, WebLogic JVM configuration, connection pool sizing, and crontab monitoring scripts for session wait time, shared pool hit rate, and concurrent program queue depth.`,
};

async function main() {
  console.log('Inserting EBS 12.2.11 performance tuning blog post...');
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
