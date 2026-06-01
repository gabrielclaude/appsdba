import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Database Performance Tuning: A Systematic Approach',
  slug: 'oracle-database-performance-tuning',
  excerpt:
    'A comprehensive guide to Oracle Database performance tuning — AWR and ASH analysis, wait event interpretation, SGA and PGA memory sizing, SQL execution plan analysis, index strategy, statistics management, redo and undo tuning, and a repeatable diagnostic workflow for identifying and eliminating bottlenecks.',
  category: 'oracle-database' as const,
  published: true,
  publishedAt: new Date('2026-06-01'),
  youtubeUrl: null,
  content: `Performance problems in Oracle Database almost always have a measurable root cause. The goal of tuning is not to apply settings from a checklist — it is to find the specific resource or code path that is limiting throughput or inflating response time, and then address that specific thing. Working without measurement leads to optimizing components that are not the bottleneck, which wastes time and can introduce regressions.

This post walks through the Oracle performance tuning workflow: starting with measurement, progressing through wait events, memory, SQL, and I/O, and covering the key tools at each layer.

---

## The Tuning Hierarchy

Tune in this order. Fixing a higher layer often makes lower-layer issues disappear:

1. **Application and SQL design** — bad query plans and missing indexes account for the majority of Oracle performance problems
2. **Memory** — undersized SGA or PGA causes excessive I/O even for well-tuned SQL
3. **I/O** — redo log, datafile, and temp file placement and sizing
4. **OS and hardware** — network, CPU, and storage latency
5. **Oracle instance parameters** — only after the above layers are addressed

Do not start by changing \`db_cache_size\` or \`sga_target\` on a system you have not profiled. The bottleneck may be in a single poorly-written query that no amount of memory tuning will fix.

---

## Step 1: Establish Baseline Metrics

Before changing anything, collect an AWR (Automatic Workload Repository) snapshot pair that brackets the problem period.

### AWR snapshot and report

\`\`\`sql
-- Create manual snapshots (snapshots are also taken automatically every 60 min by default)
EXEC DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT();

-- ... wait through the problem period ...

EXEC DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT();

-- Generate the AWR report for the problem interval
SELECT snap_id, begin_interval_time, end_interval_time
FROM dba_hist_snapshot
ORDER BY snap_id DESC
FETCH FIRST 10 ROWS ONLY;

-- Run the text report (substitute snap IDs from above)
@\$ORACLE_HOME/rdbms/admin/awrrpt.sql
\`\`\`

AWR report sections to read first:

1. **Top 5 Timed Foreground Events** — the five wait events consuming the most DB time. This is the highest-value section.
2. **Load Profile** — logical reads per second, physical reads per second, parse rate, redo size. Compare to your baseline.
3. **Instance Efficiency Percentages** — buffer cache hit ratio, library cache hit ratio, soft parse ratio.
4. **SQL ordered by Elapsed Time** — the heaviest SQL during the interval. This is where SQL tuning starts.
5. **SQL ordered by Buffer Gets** — SQL causing the most logical I/O. High buffer gets on a single statement indicate a missing index or a full table scan on a large table.

### ASH (Active Session History) analysis

ASH samples active sessions every second. It answers "what was the database doing at 14:32 specifically?" — a question AWR cannot answer because AWR aggregates over intervals.

\`\`\`sql
-- Sessions active during a specific 5-minute window, grouped by wait event
SELECT event, session_state, COUNT(*) AS sample_count,
       ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS pct
FROM v\$active_session_history
WHERE sample_time BETWEEN TIMESTAMP '2026-06-01 14:30:00'
                      AND TIMESTAMP '2026-06-01 14:35:00'
GROUP BY event, session_state
ORDER BY sample_count DESC;

-- Top SQL during the same window
SELECT sql_id, COUNT(*) AS samples,
       ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS pct
FROM v\$active_session_history
WHERE sample_time BETWEEN TIMESTAMP '2026-06-01 14:30:00'
                      AND TIMESTAMP '2026-06-01 14:35:00'
  AND sql_id IS NOT NULL
GROUP BY sql_id
ORDER BY samples DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

---

## Step 2: Interpret Wait Events

The wait event model is Oracle's most important performance diagnostic tool. Every second a session is not on the CPU, it is waiting for something — and Oracle names and records that wait.

### Wait event categories

| Category | Examples | Typical cause |
|---|---|---|
| **User I/O** | \`db file sequential read\`, \`db file scattered read\` | Missing index (scattered = full scan); slow storage |
| **System I/O** | \`db file parallel read\`, \`direct path read\` | Full scan with direct path, PGA sort/hash spill to temp |
| **Commit** | \`log file sync\` | Excessive COMMIT frequency; slow redo log storage |
| **Concurrency** | \`buffer busy waits\`, \`read by other session\` | Hot block contention; reverse-key index needed |
| **Configuration** | \`log buffer space\`, \`log file switch\` | Redo log buffer undersized; redo logs too small |
| **Application** | \`enq: TX - row lock contention\`, \`library cache lock\` | Application-level lock contention; DDL during DML |
| **Network** | \`SQL*Net more data from client\` | Network latency; large result sets over slow network |
| **Idle** | \`SQL*Net message from client\`, \`rdbms ipc message\` | Normal idle waits — ignore these |

### Diagnosing the most common waits

**\`db file sequential read\` (single-block read):**
Each occurrence is one index range scan or table access by rowid. High total time indicates either a very high execution count on a query hitting many index entries, or slow storage. Check average wait time — if > 2ms, investigate storage latency. If < 2ms but total time is high, the query is simply executing too many times or reading too many rows.

\`\`\`sql
-- Find the SQL and object causing the most sequential reads
SELECT ash.sql_id, ash.current_obj#, o.object_name, o.object_type,
       COUNT(*) AS waits
FROM v\$active_session_history ash
LEFT JOIN dba_objects o ON ash.current_obj# = o.object_id
WHERE ash.event = 'db file sequential read'
  AND ash.sample_time > SYSDATE - 1/24
GROUP BY ash.sql_id, ash.current_obj#, o.object_name, o.object_type
ORDER BY waits DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

**\`log file sync\`:**
Occurs on every COMMIT — the foreground session waits for LGWR to write the redo to disk and confirm durability. High waits indicate either an application committing too frequently (autocommit in a loop, committing after every row insert) or slow redo log storage.

\`\`\`sql
-- Commit rate right now
SELECT s.name, s.value
FROM v\$sysstat s
WHERE s.name IN ('user commits','user rollbacks','redo writes','redo write time')
ORDER BY s.name;

-- Average log file sync wait time (target < 5ms)
SELECT event, total_waits, time_waited_micro / total_waits / 1000 AS avg_ms
FROM v\$system_event
WHERE event = 'log file sync'
  AND total_waits > 0;
\`\`\`

**\`enq: TX - row lock contention\`:**
One session is waiting for a row lock held by another. This is always an application problem — find the blocking session and what it is doing.

\`\`\`sql
-- Current blockers and waiters
SELECT l.sid AS waiter_sid,
       w.sid AS blocker_sid,
       w.username AS blocker_user,
       w.status AS blocker_status,
       w.event AS blocker_wait,
       SUBSTR(q.sql_text, 1, 100) AS blocker_sql
FROM v\$lock l
JOIN v\$session w ON l.id1 = (SELECT id1 FROM v\$lock WHERE sid = l.sid AND request > 0)
                  AND w.lockwait IS NULL AND w.sid != l.sid
LEFT JOIN v\$sql q ON w.sql_id = q.sql_id
WHERE l.request > 0;
\`\`\`

---

## Step 3: Memory Tuning

### SGA components

| Component | Purpose | Symptom of undersizing |
|---|---|---|
| **Buffer Cache** (\`db_cache_size\`) | Caches data blocks in memory | High \`db file sequential read\` wait time; low buffer cache hit ratio |
| **Shared Pool** (\`shared_pool_size\`) | SQL and PL/SQL parse cache, data dictionary cache | High \`library cache\` waits; excessive hard parses in Load Profile |
| **Large Pool** (\`large_pool_size\`) | RMAN backup buffers, parallel query message buffers, shared server session memory | \`resmgr:pq parcel\` waits for parallel query; RMAN slow |
| **Redo Log Buffer** (\`log_buffer\`) | Staging area for redo before LGWR writes to disk | \`log buffer space\` waits |

### Automatic Memory Management (AMM) and ASMM

For most environments, let Oracle manage SGA component sizing automatically:

\`\`\`sql
-- Check current memory management mode
SHOW PARAMETER memory_target;      -- AMM: Oracle manages total SGA+PGA
SHOW PARAMETER sga_target;         -- ASMM: Oracle manages SGA components
SHOW PARAMETER pga_aggregate_target; -- Automatic PGA management

-- Recommended for 12c+ on Linux: set memory_target or sga_target and let Oracle tune
-- Do NOT manually set individual component sizes when AMM/ASMM is active

-- Check current SGA component sizes
SELECT component, current_size/1048576 AS current_mb, min_size/1048576 AS min_mb
FROM v\$sga_dynamic_components
ORDER BY current_size DESC;
\`\`\`

### Buffer cache hit ratio

\`\`\`sql
SELECT ROUND((1 - (phy.value / (db.value + con.value))) * 100, 2) AS buffer_cache_hit_pct
FROM v\$sysstat phy, v\$sysstat db, v\$sysstat con
WHERE phy.name = 'physical reads'
  AND db.name  = 'db block gets'
  AND con.name = 'consistent gets';
-- Target: > 95% for OLTP; > 90% for mixed workloads
-- Note: a high hit ratio is necessary but not sufficient — a query doing 10M logical I/Os
-- on every execution has a perfect hit ratio and is still the problem
\`\`\`

### PGA and sort/hash spill to temp

PGA is the per-process memory used for sorts, hash joins, and bitmap operations. If PGA is undersized, these operations spill to the \`TEMP\` tablespace (disk), which is orders of magnitude slower.

\`\`\`sql
-- PGA advice — how much gain from more PGA memory
SELECT pga_target_for_estimate/1048576 AS target_mb,
       estd_pga_cache_hit_percentage AS cache_hit_pct,
       estd_overalloc_count
FROM v\$pga_target_advice
ORDER BY pga_target_for_estimate;

-- How many sorts/hash joins spilled to disk right now
SELECT name, value
FROM v\$sysstat
WHERE name IN ('sorts (disk)', 'workarea executions - onepass', 'workarea executions - multipass')
ORDER BY name;
-- Any value > 0 for 'sorts (disk)' means PGA is too small for your sort operations
\`\`\`

---

## Step 4: SQL Tuning

SQL is the highest-leverage tuning target. A single query with a bad execution plan can consume more resources than all other SQL combined.

### Obtain the execution plan

\`\`\`sql
-- Get the actual execution plan from the cursor cache (not EXPLAIN PLAN which may differ)
SELECT *
FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(
  sql_id    => '<sql_id from AWR>',
  cursor_child_no => 0,
  format    => 'ALLSTATS LAST +PEEKED_BINDS'
));
\`\`\`

Key plan operations and what they mean:

| Operation | Concern |
|---|---|
| \`TABLE ACCESS FULL\` on a large table | Missing index; or optimizer chose full scan because selectivity is low |
| \`NESTED LOOPS\` with large outer row count | Inner loop executes once per outer row — multiplies I/O |
| \`HASH JOIN\` with large build input | Build side does not fit in PGA — may spill to temp |
| \`SORT (DISK)\` | PGA too small for this sort |
| High \`Rows (E-Rows vs A-Rows)\` divergence | Stale or missing statistics causing optimizer misjudgment |
| \`BUFFER SORT\` | In-memory sort, but repeated — may indicate driving table is wrong |

### Statistics — the most important optimizer input

The optimizer makes decisions based on statistics. Stale statistics produce wrong cardinality estimates, which produce bad plans.

\`\`\`sql
-- Find tables with stale or missing statistics
SELECT owner, table_name, num_rows, last_analyzed, stale_stats
FROM dba_tab_statistics
WHERE owner NOT IN ('SYS','SYSTEM','DBSNMP','SYSMAN')
  AND (last_analyzed IS NULL OR stale_stats = 'YES')
ORDER BY num_rows DESC NULLS FIRST
FETCH FIRST 30 ROWS ONLY;

-- Gather statistics on a specific table
BEGIN
  DBMS_STATS.GATHER_TABLE_STATS(
    ownname          => 'FMW_SOAINFRA',
    tabname          => 'CUBE_INSTANCE',
    estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,
    cascade          => TRUE,
    degree           => 4,
    method_opt       => 'FOR ALL COLUMNS SIZE AUTO'
  );
END;
/

-- Gather statistics on all tables in a schema
BEGIN
  DBMS_STATS.GATHER_SCHEMA_STATS(
    ownname          => 'MYAPP',
    estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,
    cascade          => TRUE,
    degree           => 4,
    options          => 'GATHER AUTO'
  );
END;
/
\`\`\`

### Index strategy

Indexes are the most direct tool for improving SQL performance. The key is to create the right indexes, not more indexes.

**Index design principles:**

- **Selectivity** — index columns with high cardinality (many distinct values). An index on a column with only 3 distinct values across 10M rows is rarely useful.
- **Composite index column order** — put the most selective column, or the equality-filtered column, first. A composite index on \`(status, order_date)\` is efficient for queries filtering on both columns, but only for queries filtering on \`status\` alone — never for queries filtering on \`order_date\` alone.
- **Covering indexes** — an index that covers all columns referenced in a query (both filter and SELECT list) satisfies the query entirely from the index without touching the table. These eliminate the table access step entirely.
- **Function-based indexes** — when queries filter on a function of a column (\`UPPER(email) = :v\`), the index must match exactly: \`CREATE INDEX idx ON users (UPPER(email))\`.

\`\`\`sql
-- Find missing indexes using AWR SQL stats (high buffer gets = likely missing index)
SELECT sa.sql_id,
       ROUND(sa.buffer_gets / NULLIF(sa.executions, 0)) AS avg_lio,
       sa.executions,
       SUBSTR(sa.sql_text, 1, 100) AS sql_preview
FROM dba_hist_sqlstat sa
JOIN dba_hist_snapshot sn ON sa.snap_id = sn.snap_id
WHERE sn.begin_interval_time > SYSDATE - 1
  AND sa.buffer_gets / NULLIF(sa.executions, 0) > 100000
ORDER BY avg_lio DESC
FETCH FIRST 20 ROWS ONLY;

-- Index usage monitoring (find unused indexes — candidates for removal)
SELECT index_name, table_name, monitoring, used, start_monitoring
FROM v\$object_usage
WHERE used = 'NO'
  AND monitoring = 'YES'
ORDER BY table_name;
\`\`\`

### SQL Profiles and SQL Plan Baselines

When you cannot change application SQL, Oracle provides two mechanisms to enforce a better plan without code changes:

**SQL Profile** (generated by SQL Tuning Advisor):
\`\`\`sql
-- Run SQL Tuning Advisor on a known problem query
DECLARE
  l_task VARCHAR2(100);
BEGIN
  l_task := DBMS_SQLTUNE.CREATE_TUNING_TASK(
    sql_id      => '<problem_sql_id>',
    scope       => DBMS_SQLTUNE.SCOPE_COMPREHENSIVE,
    time_limit  => 300,
    task_name   => 'tune_problem_query',
    description => 'Tuning task for high-LIO query'
  );
  DBMS_SQLTUNE.EXECUTE_TUNING_TASK(task_name => 'tune_problem_query');
END;
/

-- Review recommendations
SELECT DBMS_SQLTUNE.REPORT_TUNING_TASK('tune_problem_query') FROM dual;

-- Accept the SQL Profile if recommended
EXEC DBMS_SQLTUNE.ACCEPT_SQL_PROFILE(task_name => 'tune_problem_query', replace => TRUE);
\`\`\`

**SQL Plan Baseline** (pin a known good plan):
\`\`\`sql
-- Capture the current good plan into a baseline
DECLARE
  l_count INTEGER;
BEGIN
  l_count := DBMS_SPM.LOAD_PLANS_FROM_CURSOR_CACHE(sql_id => '<sql_id>');
END;
/

-- Verify the baseline is fixed
SELECT sql_handle, plan_name, accepted, fixed, enabled, origin
FROM dba_sql_plan_baselines
WHERE sql_text LIKE '%<distinctive_snippet>%';
\`\`\`

---

## Step 5: Redo and Undo Tuning

### Redo log sizing

Redo log file switches cause brief waits (\`log file switch\` event). Frequent switches (more than 4 per hour) indicate logs are too small.

\`\`\`sql
-- Log switch frequency in the last 24 hours
SELECT TO_CHAR(first_time, 'YYYY-MM-DD HH24') AS hour,
       COUNT(*) AS switches
FROM v\$log_history
WHERE first_time > SYSDATE - 1
GROUP BY TO_CHAR(first_time, 'YYYY-MM-DD HH24')
ORDER BY hour;
-- Target: < 4 switches per hour; ideal is 1-2

-- Current redo log sizes
SELECT group#, members, bytes/1048576 AS size_mb, status
FROM v\$log
ORDER BY group#;
\`\`\`

To increase redo log size, add new groups and drop the old ones:

\`\`\`sql
-- Add three new larger redo log groups
ALTER DATABASE ADD LOGFILE GROUP 4 '/u01/oradata/redo04.log' SIZE 500M;
ALTER DATABASE ADD LOGFILE GROUP 5 '/u01/oradata/redo05.log' SIZE 500M;
ALTER DATABASE ADD LOGFILE GROUP 6 '/u01/oradata/redo06.log' SIZE 500M;

-- Force log switches to cycle all groups
ALTER SYSTEM SWITCH LOGFILE;
ALTER SYSTEM SWITCH LOGFILE;
ALTER SYSTEM SWITCH LOGFILE;
ALTER SYSTEM CHECKPOINT;

-- Drop old undersized groups (only when INACTIVE)
SELECT group#, status FROM v\$log;
ALTER DATABASE DROP LOGFILE GROUP 1;
ALTER DATABASE DROP LOGFILE GROUP 2;
ALTER DATABASE DROP LOGFILE GROUP 3;
\`\`\`

### UNDO management

\`ORA-01555: snapshot too old\` errors indicate the UNDO tablespace is not retaining old versions long enough for queries to complete. Tune \`UNDO_RETENTION\` and ensure the UNDO tablespace can accommodate it.

\`\`\`sql
-- Check UNDO usage and retention
SELECT tablespace_name, status, bytes/1048576 AS mb_used
FROM dba_undo_extents
WHERE status = 'ACTIVE'
ORDER BY bytes DESC;

-- How long UNDO is actually being retained (should meet or exceed longest query)
SELECT MAX(maxquerylen) AS longest_query_sec,
       MAX(tuned_undoretention) AS tuned_retention_sec
FROM v\$undostat;

-- Set explicit retention (example: 3600 seconds = 1 hour)
ALTER SYSTEM SET undo_retention = 3600 SCOPE=BOTH;

-- Enable UNDO tablespace guarantee (prevents UNDO from being reclaimed before retention expires)
ALTER TABLESPACE UNDOTBS1 RETENTION GUARANTEE;
\`\`\`

---

## Step 6: Parsing and Connection Management

### Hard parse rate

Every unique SQL string that has not been seen before triggers a hard parse — the optimizer generates a new execution plan. Hard parses consume shared pool memory and CPU. High hard parse rates degrade throughput.

\`\`\`sql
-- Parse rates from Load Profile section of AWR, or live:
SELECT name, value
FROM v\$sysstat
WHERE name IN ('parse count (hard)', 'parse count (total)', 'execute count')
ORDER BY name;

-- Hard parse ratio (target: < 5%)
SELECT ROUND(hp.value * 100.0 / NULLIF(tp.value, 0), 2) AS hard_parse_pct
FROM v\$sysstat hp, v\$sysstat tp
WHERE hp.name = 'parse count (hard)'
  AND tp.name = 'parse count (total)';
\`\`\`

A high hard parse ratio means application code is not using bind variables. SQL like \`WHERE id = 12345\` is unique for every value of \`id\`, generating a new plan each time. \`WHERE id = :id\` reuses the same parsed plan for every execution.

### Session and connection monitoring

\`\`\`sql
-- Current session count and state
SELECT status, COUNT(*) AS session_count
FROM v\$session
WHERE type = 'USER'
GROUP BY status
ORDER BY session_count DESC;

-- Sessions by program/application
SELECT program, username, COUNT(*) AS sessions,
       SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active
FROM v\$session
WHERE type = 'USER'
GROUP BY program, username
ORDER BY sessions DESC
FETCH FIRST 15 ROWS ONLY;
\`\`\`

---

## Step 7: Putting It Together — Diagnostic Workflow

\`\`\`
1. Problem reported: high response time or throughput degradation
   │
   ├── Pull AWR report for the problem window
   │     └── Check Top 5 Wait Events
   │
   ├── Is the top wait a USER I/O event? (db file sequential read)
   │     ├── YES → Find the SQL and object via ASH; check execution plan
   │     │         → Missing index? Bad plan? → Fix SQL or create index
   │     └── NO  → Continue
   │
   ├── Is the top wait log file sync?
   │     ├── YES → Check commit rate; check redo log switch frequency
   │     │         → Batch commits? Redo on slow storage? → Fix commit frequency or add redo groups
   │     └── NO  → Continue
   │
   ├── Is the top wait buffer busy waits or read by other session?
   │     ├── YES → Hot block contention; find the hot object
   │     │         → Reverse key index? Sequence cache? ASSM? → Reduce contention
   │     └── NO  → Continue
   │
   ├── Is there a high hard parse ratio (> 5%)?
   │     ├── YES → Application not using bind variables
   │     │         → cursor_sharing = FORCE as temporary fix; long term: fix code
   │     └── NO  → Continue
   │
   ├── Are sorts (disk) > 0?
   │     ├── YES → PGA too small for hash joins or large sorts
   │     │         → Increase pga_aggregate_target; check for missing indexes
   │     └── NO  → Continue
   │
   └── Is SOAINFRA CUBE_INSTANCE > 10M rows?
         ├── YES → Run purge_instances; gather stats after purge
         └── NO  → Review AWR SQL section for top elapsed time SQL
\`\`\`

---

## Key Performance Views Reference

| View | What it shows |
|---|---|
| \`v\$active_session_history\` | In-memory ASH (last ~1 hour at 1-sec samples) |
| \`dba_hist_active_sess_history\` | Persistent ASH in AWR (sampled 1-in-10) |
| \`v\$system_event\` | Cumulative system-wide wait event totals |
| \`v\$session_event\` | Per-session wait event totals |
| \`v\$sql\` | Current SQL in the shared pool with stats |
| \`dba_hist_sqlstat\` | Historical SQL stats per AWR snapshot |
| \`v\$sysstat\` | Cumulative system statistics (parses, reads, commits) |
| \`v\$session\` | Currently connected sessions with current wait |
| \`v\$lock\` | Current locks and waiters |
| \`v\$undostat\` | UNDO usage and tuned retention stats |
| \`v\$log_history\` | Historical redo log switch log |
| \`v\$pga_target_advice\` | Oracle's PGA sizing recommendations |
| \`dba_tab_statistics\` | Table statistics freshness and stale flags |
| \`v\$object_usage\` | Index usage monitoring (requires \`ALTER INDEX ... MONITORING USAGE\`) |

---

## Summary

Oracle performance tuning is a discipline of measurement and root cause analysis. The tools are all built into the database — AWR, ASH, execution plan history, and the V$ views give you everything you need to find and fix the actual bottleneck. The workflow is always: measure the wait event profile, identify the heaviest SQL, verify statistics are current, ensure memory is appropriately sized, and confirm I/O is not the limiting factor. Most production performance problems trace to one of three things: a missing index, stale optimizer statistics producing a bad plan, or an application committing far too frequently. Start there before touching any instance parameter.`,
};

async function main() {
  console.log('Inserting Oracle DB performance tuning post...');
  await db.insert(posts).values(post).onConflictDoNothing();
  console.log(`Inserted: "${post.title}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
