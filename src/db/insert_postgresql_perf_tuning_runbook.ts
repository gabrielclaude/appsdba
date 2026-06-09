import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: PostgreSQL Performance Diagnosis and Tuning',
  slug: 'postgresql-performance-tuning-runbook',
  excerpt:
    'Hands-on performance runbook for PostgreSQL — slow query triage with pg_stat_statements, EXPLAIN ANALYZE interpretation, missing and bloated index detection, shared_buffers and work_mem sizing, autovacuum per-table tuning, lock contention resolution, and a deployable pg_perf_report.sh script for baseline collection.',
  category: 'postgresql' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-09'),
  youtubeUrl: null,
  content: `## Purpose and Scope

This runbook provides the complete, hands-on procedure for diagnosing and resolving PostgreSQL performance problems in a production environment. It is a companion to [PostgreSQL Performance Tuning: A Practical Guide](/posts/postgresql-performance-tuning).

Work through the phases in order during a performance incident. Each phase includes the SQL or shell command to run, what to look for in the output, and the action to take.

---

## Prerequisites

- \`pg_stat_statements\` extension installed and active (see the [install runbook](/posts/postgresql-linux-install-runbook))
- psql access with a superuser or the \`pg_monitor\` built-in role
- OS access to the database server (for \`pg_ctl\`, config file edits, and TKPROF-equivalent analysis)

\`\`\`sql
-- Confirm pg_stat_statements is loaded
SELECT * FROM pg_extension WHERE extname = 'pg_stat_statements';
\`\`\`

If it returns no rows, enable it first:

\`\`\`sql
-- Add to postgresql.conf then restart
-- shared_preload_libraries = 'pg_stat_statements'
CREATE EXTENSION pg_stat_statements;
\`\`\`

---

## Phase 1 — Establish a Performance Baseline

Run these before making any changes. Save the output — you need the before-state to measure whether a change helped.

### 1.1 Database-level cache hit rate

\`\`\`sql
SELECT datname,
       blks_hit,
       blks_read,
       ROUND(blks_hit * 100.0 / NULLIF(blks_hit + blks_read, 0), 2) AS cache_hit_pct,
       tup_returned,
       tup_fetched,
       deadlocks,
       conflicts
FROM   pg_stat_database
WHERE  datname NOT IN ('template0', 'template1')
ORDER BY blks_read DESC;
\`\`\`

**Target:** \`cache_hit_pct\` >= 99% on OLTP workloads. Values below 95% indicate the working set is larger than \`shared_buffers\`.

### 1.2 Top 20 queries by total CPU time

\`\`\`sql
SELECT
    queryid,
    left(query, 100)                                            AS query_preview,
    calls,
    ROUND(total_exec_time::numeric, 1)                          AS total_ms,
    ROUND(mean_exec_time::numeric, 1)                           AS mean_ms,
    ROUND(stddev_exec_time::numeric, 1)                         AS stddev_ms,
    rows,
    ROUND((100.0 * shared_blks_hit /
           NULLIF(shared_blks_hit + shared_blks_read, 0))::numeric, 1) AS buf_hit_pct,
    temp_blks_written                                           AS disk_sort_blks
FROM   pg_stat_statements
WHERE  calls > 5
ORDER BY total_exec_time DESC
LIMIT  20;
\`\`\`

### 1.3 Queries with the most disk sorts (work_mem candidates)

\`\`\`sql
SELECT
    left(query, 100)            AS query_preview,
    calls,
    temp_blks_written,
    ROUND(mean_exec_time::numeric, 1) AS mean_ms
FROM   pg_stat_statements
WHERE  temp_blks_written > 100
ORDER BY temp_blks_written DESC
LIMIT  10;
\`\`\`

### 1.4 Current active sessions snapshot

\`\`\`sql
SELECT pid,
       usename,
       application_name,
       state,
       wait_event_type,
       wait_event,
       ROUND(EXTRACT(EPOCH FROM (now() - query_start))::numeric, 1) AS query_age_sec,
       left(query, 80) AS query_preview
FROM   pg_stat_activity
WHERE  state != 'idle'
  AND  pid != pg_backend_pid()
ORDER BY query_age_sec DESC NULLS LAST;
\`\`\`

### 1.5 Table I/O — which tables are doing the most physical reads

\`\`\`sql
SELECT schemaname,
       relname                                               AS table_name,
       heap_blks_read                                        AS physical_reads,
       heap_blks_hit                                         AS buffer_hits,
       ROUND(heap_blks_hit * 100.0 /
             NULLIF(heap_blks_hit + heap_blks_read, 0), 1)  AS hit_pct,
       idx_blks_read                                         AS idx_physical_reads,
       idx_blks_hit                                          AS idx_buffer_hits
FROM   pg_statio_user_tables
WHERE  heap_blks_read + heap_blks_hit > 0
ORDER BY heap_blks_read DESC
LIMIT  20;
\`\`\`

---

## Phase 2 — EXPLAIN ANALYZE Deep Dive

For each slow query identified in Phase 1, run a full EXPLAIN ANALYZE with buffers:

\`\`\`sql
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT TEXT)
<your slow query here>;
\`\`\`

### 2.1 Interpretation checklist

Work through the plan output top-down:

**Seq Scan on large table?**
Check the filter and estimated rows. If \`rows removed by filter\` is high, an index is needed.
\`\`\`
Seq Scan on orders  (cost=0.00..45821.00 rows=3 width=40) (actual rows=3 loops=1)
  Filter: (customer_id = 12345)
  Rows Removed by Filter: 1200000     <-- scanning 1.2M rows to find 3
\`\`\`
Action: \`CREATE INDEX ON orders (customer_id);\`

**Nested Loop with high loops count?**
\`\`\`
Nested Loop  (actual rows=50000 loops=1)
  -> Seq Scan on orders  (actual rows=50000 loops=1)
  -> Index Scan on order_items  (actual rows=1 loops=50000)
\`\`\`
50,000 index lookups is fine if each is fast. Check \`actual time\` on the inner node.

**Hash Join with Batches > 1?**
\`\`\`
Hash  (actual rows=800000 loops=1)
  Buckets: 65536  Batches: 16  Memory Usage: 4096kB
\`\`\`
\`Batches: 16\` means the hash table spilled to disk 16 times. Increase \`work_mem\` for this query type.

**Row estimate vs actual mismatch > 10×?**
\`\`\`
(cost=0.00..100.00 rows=1 width=40) (actual rows=85000 loops=1)
\`\`\`
Planner expected 1 row, got 85,000. Run \`ANALYZE <table>;\` and re-check. If it persists, the column has a non-uniform distribution — create extended statistics.

### 2.2 Extended statistics for correlated columns

\`\`\`sql
-- Check if extended statistics already exist
SELECT stxname, stxkeys, stxkind FROM pg_statistic_ext;

-- Create correlation statistics for columns frequently used together in WHERE clauses
CREATE STATISTICS stat_orders_cust_status
    ON customer_id, status
    FROM orders;

ANALYZE orders;

-- Verify planner uses it
EXPLAIN (ANALYZE) SELECT * FROM orders WHERE customer_id = 1 AND status = 'active';
\`\`\`

---

## Phase 3 — Index Analysis

### 3.1 Find missing indexes (large sequential scans)

\`\`\`sql
SELECT schemaname,
       relname                     AS table_name,
       seq_scan,
       seq_tup_read,
       idx_scan,
       n_live_tup,
       ROUND(seq_tup_read::numeric / NULLIF(seq_scan, 0)) AS avg_rows_per_seq_scan,
       pg_size_pretty(pg_total_relation_size(relid))      AS total_size
FROM   pg_stat_user_tables
WHERE  n_live_tup > 50000
  AND  seq_scan > 100
ORDER BY seq_tup_read DESC
LIMIT  20;
\`\`\`

### 3.2 Find unused indexes

\`\`\`sql
SELECT schemaname,
       relname                                            AS table_name,
       indexrelname                                       AS index_name,
       idx_scan                                           AS times_used,
       pg_size_pretty(pg_relation_size(indexrelid))       AS index_size,
       pg_size_pretty(pg_total_relation_size(relid))      AS table_size
FROM   pg_stat_user_indexes ui
JOIN   pg_index i ON ui.indexrelid = i.indexrelid
WHERE  idx_scan = 0
  AND  NOT i.indisunique          -- keep unique constraints
  AND  NOT i.indisprimary         -- keep primary keys
ORDER BY pg_relation_size(indexrelid) DESC;
\`\`\`

Drop confirmed unused indexes during a maintenance window:
\`\`\`sql
DROP INDEX CONCURRENTLY idx_name;  -- CONCURRENTLY avoids a full table lock
\`\`\`

### 3.3 Find duplicate indexes

\`\`\`sql
SELECT indrelid::regclass                  AS table_name,
       array_agg(indexrelid::regclass)     AS indexes,
       (array_agg(indexrelid::regclass))[1] AS keep,
       (array_agg(indexrelid::regclass))[2] AS drop_candidate
FROM   pg_index
GROUP  BY indrelid, indkey
HAVING COUNT(*) > 1;
\`\`\`

### 3.4 Find bloated indexes

Bloated indexes (where the index has grown much larger relative to the table) degrade scan performance:

\`\`\`sql
SELECT schemaname,
       relname                                           AS table_name,
       indexrelname                                      AS index_name,
       pg_size_pretty(pg_relation_size(indexrelid))      AS index_size,
       pg_size_pretty(pg_relation_size(relid))           AS table_size,
       ROUND(pg_relation_size(indexrelid)::numeric /
             NULLIF(pg_relation_size(relid), 0), 2)      AS index_to_table_ratio
FROM   pg_stat_user_indexes
ORDER BY pg_relation_size(indexrelid) DESC
LIMIT  20;
\`\`\`

Rebuild a bloated index concurrently:
\`\`\`sql
REINDEX INDEX CONCURRENTLY idx_orders_customer_date;
\`\`\`

### 3.5 Create a covering index for a specific slow query

Pattern: identify the columns in WHERE, JOIN conditions, and SELECT list of the slow query.

\`\`\`sql
-- Slow query: SELECT status, total FROM orders WHERE customer_id = $1 AND created_at > $2
-- Index the WHERE columns; INCLUDE the SELECT columns
CREATE INDEX CONCURRENTLY idx_orders_cov_cust_date
    ON orders (customer_id, created_at DESC)
    INCLUDE (status, total);
\`\`\`

Confirm the plan changed to Index Only Scan:
\`\`\`sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT status, total FROM orders WHERE customer_id = 12345 AND created_at > NOW() - INTERVAL '90 days';
\`\`\`

---

## Phase 4 — Memory Configuration Review

### 4.1 Check current settings

\`\`\`sql
SELECT name,
       setting,
       unit,
       pg_size_pretty(setting::bigint *
           CASE unit WHEN '8kB' THEN 8192 WHEN 'kB' THEN 1024 ELSE 1 END) AS human_value,
       source
FROM   pg_settings
WHERE  name IN ('shared_buffers', 'work_mem', 'maintenance_work_mem',
                'effective_cache_size', 'max_connections', 'wal_buffers')
ORDER  BY name;
\`\`\`

### 4.2 Recommended values by server RAM

| Parameter | 8 GB server | 16 GB server | 32 GB server |
|-----------|------------|-------------|-------------|
| \`shared_buffers\` | 2 GB | 4 GB | 8 GB |
| \`work_mem\` | 16 MB | 32 MB | 64 MB |
| \`maintenance_work_mem\` | 256 MB | 512 MB | 1 GB |
| \`effective_cache_size\` | 6 GB | 12 GB | 24 GB |
| \`max_connections\` | 100–200 | 200–400 | 400–600 |

### 4.3 Apply changes

Edit \`postgresql.conf\` and reload or restart as appropriate:

\`\`\`bash
# Parameters that need only a reload
sudo -u postgres psql -c "ALTER SYSTEM SET work_mem = '32MB';"
sudo -u postgres psql -c "ALTER SYSTEM SET maintenance_work_mem = '512MB';"
sudo -u postgres psql -c "SELECT pg_reload_conf();"

# Parameters that need a restart
sudo -u postgres psql -c "ALTER SYSTEM SET shared_buffers = '4GB';"
sudo -u postgres psql -c "ALTER SYSTEM SET max_connections = 300;"
systemctl restart postgresql-17   # RHEL; use postgresql@17-main for Ubuntu
\`\`\`

\`ALTER SYSTEM\` writes to \`postgresql.auto.conf\`, which overrides \`postgresql.conf\` values cleanly.

### 4.4 Per-session work_mem override for analytical queries

\`\`\`sql
-- In the application connection for heavy analytics
SET work_mem = '256MB';
-- run the complex sort-heavy query
RESET work_mem;
\`\`\`

Or set at the role level so all connections for that role get more memory:
\`\`\`sql
ALTER ROLE analyst SET work_mem = '128MB';
\`\`\`

---

## Phase 5 — Autovacuum and Bloat Remediation

### 5.1 Identify tables autovacuum is not keeping up with

\`\`\`sql
SELECT schemaname,
       relname                                                    AS table_name,
       n_live_tup,
       n_dead_tup,
       ROUND(n_dead_tup * 100.0 / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
       last_autovacuum,
       last_autoanalyze,
       autovacuum_count,
       pg_size_pretty(pg_total_relation_size(relid))              AS total_size
FROM   pg_stat_user_tables
WHERE  n_dead_tup > 5000
ORDER BY n_dead_tup DESC
LIMIT  20;
\`\`\`

### 5.2 Tune autovacuum per table for high-churn tables

\`\`\`sql
-- Aggressive settings for a table with millions of updates/deletes per day
ALTER TABLE orders SET (
    autovacuum_vacuum_scale_factor  = 0.01,
    autovacuum_vacuum_threshold     = 500,
    autovacuum_analyze_scale_factor = 0.005,
    autovacuum_vacuum_cost_delay    = 2
);

-- Verify the storage parameters were applied
SELECT reloptions FROM pg_class WHERE relname = 'orders';
\`\`\`

### 5.3 Manual vacuum for immediate relief

\`\`\`sql
-- Non-blocking vacuum (runs concurrently with reads and writes)
VACUUM (VERBOSE, ANALYZE) orders;

-- Check the output for: "pages removed", "tuples vacuumed", "index scans performed"
\`\`\`

### 5.4 Emergency VACUUM FULL (table lock — maintenance window only)

\`\`\`sql
-- Rewrites the entire table — shrinks the file on disk
-- BLOCKS all reads and writes for the duration
VACUUM FULL orders;
\`\`\`

After VACUUM FULL, rebuild all indexes:
\`\`\`sql
REINDEX TABLE orders;
-- or concurrently per index:
REINDEX INDEX CONCURRENTLY idx_orders_customer_date;
\`\`\`

### 5.5 Monitor autovacuum workers in real time

\`\`\`sql
SELECT pid,
       usename,
       state,
       wait_event,
       ROUND(EXTRACT(EPOCH FROM (now() - query_start))::numeric) AS running_sec,
       left(query, 80) AS query
FROM   pg_stat_activity
WHERE  query LIKE 'autovacuum:%'
ORDER  BY running_sec DESC;
\`\`\`

---

## Phase 6 — Lock Contention Analysis

### 6.1 Show all blocked queries and their blockers

\`\`\`sql
SELECT
    blocked.pid                                         AS blocked_pid,
    blocked.usename                                     AS blocked_user,
    blocked.application_name,
    ROUND(EXTRACT(EPOCH FROM now() - blocked.query_start)::numeric) AS blocked_sec,
    left(blocked.query, 80)                             AS blocked_query,
    blocking.pid                                        AS blocker_pid,
    blocking.usename                                    AS blocker_user,
    ROUND(EXTRACT(EPOCH FROM now() - blocking.query_start)::numeric) AS blocker_running_sec,
    left(blocking.query, 80)                            AS blocker_query
FROM   pg_stat_activity blocked
JOIN   pg_stat_activity blocking
       ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))
ORDER  BY blocked_sec DESC;
\`\`\`

### 6.2 Show all current lock holders

\`\`\`sql
SELECT
    l.pid,
    a.usename,
    a.application_name,
    l.relation::regclass           AS locked_object,
    l.locktype,
    l.mode,
    l.granted,
    ROUND(EXTRACT(EPOCH FROM now() - a.query_start)::numeric) AS lock_age_sec,
    left(a.query, 60)              AS query
FROM   pg_locks       l
JOIN   pg_stat_activity a ON l.pid = a.pid
WHERE  NOT l.granted
   OR  l.mode IN ('AccessExclusiveLock', 'ExclusiveLock')
ORDER  BY lock_age_sec DESC NULLS LAST;
\`\`\`

### 6.3 Terminate a blocking query

\`\`\`sql
-- Graceful — sends cancellation signal (interrupts the query, keeps the connection)
SELECT pg_cancel_backend(<blocking_pid>);

-- Hard terminate — closes the connection
SELECT pg_terminate_backend(<blocking_pid>);
\`\`\`

### 6.4 Set lock timeout to prevent runaway lock waits

Add to \`postgresql.conf\` or set per role:

\`\`\`sql
-- Cancel any query that waits more than 30 seconds for a lock
ALTER SYSTEM SET lock_timeout = '30s';
SELECT pg_reload_conf();

-- Or per role
ALTER ROLE appuser SET lock_timeout = '15s';
\`\`\`

---

## Phase 7 — WAL and Checkpoint Tuning

### 7.1 Diagnose excessive checkpoints

\`\`\`sql
SELECT checkpoints_timed,
       checkpoints_req,
       ROUND(checkpoint_write_time / 1000.0, 1)  AS checkpoint_write_sec,
       ROUND(checkpoint_sync_time  / 1000.0, 1)  AS checkpoint_sync_sec,
       buffers_checkpoint,
       buffers_clean,
       buffers_backend,
       buffers_alloc
FROM   pg_stat_bgwriter;
\`\`\`

If \`checkpoints_req\` (forced checkpoints) is greater than ~10% of \`checkpoints_timed\`, WAL is filling up before the scheduled checkpoint interval. Increase \`max_wal_size\`:

\`\`\`sql
ALTER SYSTEM SET max_wal_size = '4GB';
ALTER SYSTEM SET checkpoint_timeout = '15min';
ALTER SYSTEM SET checkpoint_completion_target = 0.9;
SELECT pg_reload_conf();
\`\`\`

### 7.2 Check for WAL write bottleneck

\`\`\`sql
SELECT wait_event, COUNT(*) AS sessions
FROM   pg_stat_activity
WHERE  wait_event_type = 'IO'
  AND  wait_event LIKE 'WAL%'
GROUP  BY wait_event
ORDER  BY sessions DESC;
\`\`\`

Persistent \`WALWrite\` or \`WALSync\` waits indicate the WAL device is saturated. Solutions: move \`pg_wal\` to a dedicated NVMe disk, or evaluate \`synchronous_commit = local\` for workloads that can tolerate a brief crash window.

---

## Phase 8 — Deployable Performance Report Script

Save this as \`pg_perf_report.sh\` and run it to collect a full performance snapshot. Schedule via cron to build a history baseline, or run on-demand during an incident.

\`\`\`bash
#!/bin/bash
# pg_perf_report.sh — PostgreSQL performance snapshot
# Usage: ./pg_perf_report.sh [dbname] [output_file]

export PGDATABASE=\${1:-appdb}
export PGUSER=postgres
OUTFILE=\${2:-/tmp/pg_perf_\$(date +%Y%m%d_%H%M%S).txt}

psql -X -A -t -F $'\\t' > "\$OUTFILE" <<'PSQL'
\\echo '=== PostgreSQL Performance Report ==='
\\echo ''
\\echo '--- Version ---'
SELECT version();

\\echo ''
\\echo '--- Uptime ---'
SELECT now() - pg_postmaster_start_time() AS uptime;

\\echo ''
\\echo '--- Database Cache Hit Rate ---'
SELECT datname,
       ROUND(blks_hit * 100.0 / NULLIF(blks_hit + blks_read, 0), 2) AS cache_hit_pct,
       deadlocks
FROM   pg_stat_database
WHERE  datname NOT IN ('template0','template1')
ORDER  BY blks_read DESC;

\\echo ''
\\echo '--- Top 10 Queries by Total Time ---'
SELECT left(query,80), calls,
       ROUND(total_exec_time::numeric,1) AS total_ms,
       ROUND(mean_exec_time::numeric,1)  AS mean_ms,
       temp_blks_written
FROM   pg_stat_statements
WHERE  calls > 5
ORDER  BY total_exec_time DESC
LIMIT  10;

\\echo ''
\\echo '--- Top 10 Tables by Dead Tuple Ratio ---'
SELECT relname,
       n_live_tup,
       n_dead_tup,
       ROUND(n_dead_tup*100.0/NULLIF(n_live_tup+n_dead_tup,0),1) AS dead_pct,
       last_autovacuum
FROM   pg_stat_user_tables
WHERE  n_dead_tup > 1000
ORDER  BY dead_pct DESC
LIMIT  10;

\\echo ''
\\echo '--- Top 10 Tables by Sequential Scans ---'
SELECT relname, seq_scan, seq_tup_read, idx_scan,
       pg_size_pretty(pg_total_relation_size(relid)) AS size
FROM   pg_stat_user_tables
WHERE  seq_scan > 0 AND n_live_tup > 10000
ORDER  BY seq_tup_read DESC
LIMIT  10;

\\echo ''
\\echo '--- Unused Indexes (idx_scan = 0, non-PK/unique) ---'
SELECT ui.relname AS table, ui.indexrelname AS index,
       pg_size_pretty(pg_relation_size(ui.indexrelid)) AS size
FROM   pg_stat_user_indexes ui
JOIN   pg_index i ON ui.indexrelid = i.indexrelid
WHERE  ui.idx_scan = 0
  AND  NOT i.indisunique AND NOT i.indisprimary
ORDER  BY pg_relation_size(ui.indexrelid) DESC
LIMIT  10;

\\echo ''
\\echo '--- Current Lock Waits ---'
SELECT blocked.pid, blocked.usename, left(blocked.query,60) AS blocked_q,
       blocking.pid AS blocker_pid, left(blocking.query,60) AS blocker_q
FROM   pg_stat_activity blocked
JOIN   pg_stat_activity blocking
       ON blocking.pid = ANY(pg_blocking_pids(blocked.pid));

\\echo ''
\\echo '--- Active Wait Events ---'
SELECT wait_event_type, wait_event, COUNT(*) AS sessions
FROM   pg_stat_activity
WHERE  state != 'idle' AND wait_event IS NOT NULL
GROUP  BY wait_event_type, wait_event
ORDER  BY sessions DESC;

\\echo ''
\\echo '--- Checkpoint Statistics ---'
SELECT checkpoints_timed, checkpoints_req,
       ROUND(checkpoint_write_time/1000.0,1) AS write_sec,
       buffers_checkpoint, buffers_backend
FROM   pg_stat_bgwriter;
PSQL

echo "Report written to \$OUTFILE"
cat "\$OUTFILE"
\`\`\`

Make it executable and run:

\`\`\`bash
chmod +x /home/postgres/scripts/pg_perf_report.sh
/home/postgres/scripts/pg_perf_report.sh appdb /tmp/perf_baseline.txt
\`\`\`

---

## Post-Tuning Verification

After making changes, reset \`pg_stat_statements\` and collect a fresh baseline after one hour of production load:

\`\`\`sql
SELECT pg_stat_statements_reset();
SELECT pg_stat_reset();   -- resets pg_stat_user_tables, pg_stat_bgwriter, etc.
\`\`\`

After one hour, compare:
- Mean query times for the top 10 queries vs. the pre-change baseline
- Cache hit rate (should be >= 99%)
- Dead tuple ratios on previously bloated tables
- Checkpoint frequency (\`checkpoints_req\` / \`checkpoints_timed\` ratio)

---

## Quick Reference

\`\`\`sql
-- Identify the single slowest query right now
SELECT pid, now() - query_start AS duration, left(query,80)
FROM   pg_stat_activity
WHERE  state = 'active'
ORDER  BY duration DESC NULLS LAST LIMIT 5;

-- Kill a long-running query
SELECT pg_cancel_backend(<pid>);

-- Force an immediate ANALYZE on a specific table
ANALYZE VERBOSE orders;

-- Force a checkpoint (useful after bulk loads)
CHECKPOINT;

-- Show which parameters need a restart vs reload
SELECT name, setting, pending_restart FROM pg_settings WHERE pending_restart;

-- Reload config without restart
SELECT pg_reload_conf();

-- Show index usage for a specific table
SELECT indexrelname, idx_scan, idx_tup_read, idx_tup_fetch
FROM   pg_stat_user_indexes
WHERE  relname = 'orders'
ORDER  BY idx_scan DESC;
\`\`\``,
};

async function main() {
  console.log('Inserting PostgreSQL performance tuning runbook...');
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
