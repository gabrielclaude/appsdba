import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'PostgreSQL Session Tracing and EXPLAIN Plan Analysis: Operations Runbook',
  slug: 'postgresql-sql-session-tracing-explain-plan-runbook',
  excerpt:
    'Step-by-step runbook for tracing a PostgreSQL SQL session from symptom to root cause — enabling pg_stat_statements and auto_explain, capturing live session state, running and interpreting EXPLAIN ANALYZE BUFFERS output, diagnosing sequential scans, bad row estimates, sort spills, join mismatches, and lock contention, with reusable diagnostic scripts.',
  category: 'postgresql' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-14'),
  youtubeUrl: null,
  content: `## Prerequisites

| Requirement | Default | Required |
|-------------|---------|---------|
| \`pg_stat_statements\` extension | not loaded | Yes — add to \`shared_preload_libraries\` |
| \`auto_explain\` module | not loaded | Recommended for production monitoring |
| \`track_io_timing\` | off | Recommended — enables per-node I/O timing in EXPLAIN |
| \`log_min_duration_statement\` | -1 (disabled) | Set to capture slow queries |
| PostgreSQL version | any | 14+ for best EXPLAIN output; 15+ for \`generic_plan\` option |

---

## Phase 1 — Enable Required Extensions and Settings

### 1.1 Edit postgresql.conf

\`\`\`bash
# Locate postgresql.conf:
psql -c "SHOW config_file;"

# Add or update these lines:
shared_preload_libraries = 'pg_stat_statements,auto_explain'

# Slow query logging:
log_min_duration_statement = 1000      # ms — log queries taking longer than 1s
log_line_prefix = '%t [%p]: user=%u,db=%d,app=%a,client=%h '
log_lock_waits = on                    # log queries waiting on locks > deadlock_timeout

# I/O timing (low overhead on Linux with clock_gettime):
track_io_timing = on

# auto_explain settings:
auto_explain.log_min_duration = 2000   # log plans for queries > 2s
auto_explain.log_analyze = on
auto_explain.log_buffers = on
auto_explain.log_timing = on
auto_explain.log_nested_statements = on
auto_explain.sample_rate = 1.0
\`\`\`

\`shared_preload_libraries\` requires a full PostgreSQL restart. All other settings can be applied with \`pg_reload_conf()\`.

### 1.2 Restart PostgreSQL

\`\`\`bash
# systemd:
systemctl restart postgresql

# pg_ctl:
pg_ctl restart -D /var/lib/postgresql/data

# RDS / Aurora / managed:
# Modify parameter group, apply with reboot
\`\`\`

### 1.3 Create Extensions

\`\`\`sql
-- Run in each database you want to monitor:
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Verify:
SELECT extname, extversion FROM pg_extension WHERE extname = 'pg_stat_statements';
\`\`\`

### 1.4 Verify auto_explain is Loaded

\`\`\`sql
-- Test in a session (auto_explain logs to the server log, not psql output):
LOAD 'auto_explain';
SET auto_explain.log_min_duration = 0;
SELECT count(*) FROM pg_class;   -- any query
SET auto_explain.log_min_duration = -1;
-- Check PostgreSQL log — should see a plan entry
\`\`\`

---

## Phase 2 — Find the Problem Query

### 2.1 Check pg_stat_activity for Live Sessions

\`\`\`sql
-- All non-idle sessions, ordered by duration:
SELECT
  pid,
  usename,
  application_name,
  state,
  wait_event_type,
  wait_event,
  now() - query_start     AS duration,
  now() - state_change    AS state_age,
  LEFT(query, 200)        AS query
FROM pg_stat_activity
WHERE state NOT IN ('idle')
  AND pid <> pg_backend_pid()
ORDER BY duration DESC NULLS LAST;
\`\`\`

**Interpret the results:**

| state + wait_event | Diagnosis |
|--------------------|-----------|
| \`active\`, no wait | Query is running — CPU or I/O bound |
| \`active\`, \`IO\` / \`DataFileRead\` | Reading from disk — check EXPLAIN BUFFERS |
| \`active\`, \`Lock\` / \`relation\` | Waiting for a table lock |
| \`active\`, \`Lock\` / \`tuple\` | Waiting for a row-level lock |
| \`idle in transaction\` | Holding locks without doing work — likely application bug |
| \`active\`, \`Client\` / \`ClientRead\` | Waiting for the client to send next query — normal |

### 2.2 Find the Blocking Chain

\`\`\`sql
-- Full blocking chain with lock type and wait duration:
WITH RECURSIVE blocking AS (
  SELECT
    blocked.pid,
    blocked.query                         AS blocked_query,
    blocking_pids.blocker_pid,
    1                                     AS depth
  FROM pg_stat_activity AS blocked
  CROSS JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS blocking_pids(blocker_pid)
  WHERE blocked.wait_event_type = 'Lock'
  UNION ALL
  SELECT
    b.blocker_pid,
    a.query,
    (SELECT blocker_pid FROM pg_stat_activity AS aa
     CROSS JOIN LATERAL unnest(pg_blocking_pids(aa.pid)) AS bp(blocker_pid)
     WHERE aa.pid = b.blocker_pid LIMIT 1),
    b.depth + 1
  FROM blocking b
  JOIN pg_stat_activity a ON a.pid = b.blocker_pid
  WHERE b.depth < 5
)
SELECT * FROM blocking ORDER BY depth;
\`\`\`

### 2.3 pg_stat_statements — Worst Offenders

\`\`\`sql
-- Total time (most expensive overall):
SELECT
  queryid,
  calls,
  ROUND(total_exec_time::numeric, 0)             AS total_ms,
  ROUND(mean_exec_time::numeric, 2)              AS mean_ms,
  ROUND(stddev_exec_time::numeric, 2)            AS stddev_ms,
  ROUND(max_exec_time::numeric, 2)               AS max_ms,
  rows,
  ROUND(100.0 * shared_blks_hit
    / NULLIF(shared_blks_hit + shared_blks_read, 0), 1) AS cache_hit_pct,
  LEFT(query, 150)                               AS query
FROM pg_stat_statements
WHERE calls > 5
ORDER BY total_exec_time DESC
LIMIT 15;
\`\`\`

\`\`\`sql
-- High I/O (physical block reads):
SELECT
  LEFT(query, 150)                       AS query,
  calls,
  shared_blks_read,
  ROUND(shared_blks_read::numeric / NULLIF(calls, 0), 0) AS reads_per_call,
  ROUND(mean_exec_time::numeric, 2)      AS mean_ms
FROM pg_stat_statements
WHERE shared_blks_read > 0
ORDER BY shared_blks_read DESC
LIMIT 10;
\`\`\`

\`\`\`sql
-- Inconsistent queries (high stddev — possible plan flip or skew):
SELECT
  LEFT(query, 150)                           AS query,
  calls,
  ROUND(mean_exec_time::numeric, 2)          AS mean_ms,
  ROUND(stddev_exec_time::numeric, 2)        AS stddev_ms,
  ROUND(max_exec_time::numeric, 2)           AS max_ms,
  ROUND(min_exec_time::numeric, 2)           AS min_ms
FROM pg_stat_statements
WHERE calls > 20
  AND stddev_exec_time > mean_exec_time * 0.5
ORDER BY stddev_exec_time DESC
LIMIT 10;
\`\`\`

Record the \`queryid\` of the worst offender. Reset stats after investigation to get a fresh baseline:

\`\`\`sql
-- Reset stats for a specific query (by queryid) or all queries:
SELECT pg_stat_statements_reset(0, 0, <queryid>);
-- SELECT pg_stat_statements_reset();   -- resets everything
\`\`\`

---

## Phase 3 — Run EXPLAIN ANALYZE

### 3.1 Full Analysis with Buffer and Timing Detail

\`\`\`sql
-- Replace with the slow query, substituting literal values for $N parameters:
EXPLAIN (ANALYZE, BUFFERS, TIMING, FORMAT TEXT)
SELECT o.id, o.created_at, c.name
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.status = 'pending'
  AND o.created_at > NOW() - INTERVAL '7 days'
ORDER BY o.created_at DESC
LIMIT 100;
\`\`\`

### 3.2 Capture the Plan to a Table (for Comparison)

\`\`\`sql
CREATE TABLE IF NOT EXISTS explain_captures (
  id         SERIAL PRIMARY KEY,
  label      TEXT,
  plan       TEXT,
  captured_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO explain_captures (label, plan)
SELECT 'orders_pending_baseline',
       plan_row
FROM (
  EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
  SELECT o.id, o.created_at, c.name
  FROM orders o
  JOIN customers c ON c.id = o.customer_id
  WHERE o.status = 'pending'
    AND o.created_at > NOW() - INTERVAL '7 days'
  ORDER BY o.created_at DESC
  LIMIT 100
) AS p(plan_row);
\`\`\`

### 3.3 Read the Output — What to Look For

Work through the plan bottom-up (leaf nodes first, root last). At each node check:

**1. Estimated vs actual rows:**
\`\`\`
Index Scan ... (cost=0.43..8.45 rows=1 width=64)
               (actual time=0.1..892.3 rows=48920 loops=1)
\`\`\`
Estimated 1 row, got 48920 — massive underestimate. The planner made upstream decisions (join type, sort strategy) based on wrong input sizes.

**Action:** Run \`ANALYZE <table>\` and recheck. If still wrong, increase statistics target or add extended statistics.

**2. Scan type on large tables:**
\`\`\`
Seq Scan on orders  (cost=0.00..4920.00 rows=200000 width=64)
                    (actual time=0.1..3421.0 rows=200000 loops=1)
\`\`\`
A full sequential scan returning all rows — no WHERE clause selectivity. If the intent was to filter, check whether the column in the WHERE clause is indexed and whether the index is being found.

**3. Sort method:**
\`\`\`
Sort Method: external merge  Disk: 24576kB
\`\`\`
Sort spilled 24 MB to disk. Fix with \`SET work_mem = '128MB'\` and re-run EXPLAIN to confirm it fits in memory (\`Sort Method: quicksort\`).

**4. Hash batches:**
\`\`\`
Hash  (actual time=...)
  Buckets: 4096  Batches: 8  Memory Usage: 4096kB
\`\`\`
8 batches = 8 disk passes. Same fix — increase \`work_mem\`.

**5. Nested loop loops count:**
\`\`\`
Index Scan on customers  (actual time=0.01..0.02 rows=1 loops=50000)
\`\`\`
50,000 index lookups. Loops = outer relation row count. Normal for nested loop IF the outer is small. If the outer is large, this is a plan mistake.

**6. Parallel workers:**
\`\`\`
Gather  (actual time=...)
  Workers Planned: 4
  Workers Launched: 2
\`\`\`
Planned 4, launched 2 — \`max_worker_processes\` or \`max_parallel_workers\` limit hit. Can tune to allow more parallelism.

---

## Phase 4 — Diagnose and Fix

### 4.1 Stale Statistics

\`\`\`sql
-- Check when each table was last analyzed:
SELECT
  schemaname,
  relname,
  n_live_tup,
  n_dead_tup,
  last_analyze,
  last_autoanalyze,
  analyze_count
FROM pg_stat_user_tables
WHERE last_autoanalyze < NOW() - INTERVAL '24 hours'
   OR last_autoanalyze IS NULL
ORDER BY n_live_tup DESC;

-- Run ANALYZE on tables with stale stats:
ANALYZE VERBOSE orders;
ANALYZE VERBOSE customers;
\`\`\`

### 4.2 Column Statistics — Check Planner Inputs

\`\`\`sql
-- Statistics for the column(s) in your WHERE clause:
SELECT
  attname,
  n_distinct,
  correlation,
  null_frac,
  avg_width,
  most_common_vals,
  most_common_freqs,
  histogram_bounds
FROM pg_stats
WHERE tablename = 'orders'
  AND attname IN ('status', 'customer_id', 'created_at');
\`\`\`

**Interpreting \`n_distinct\`:**
- \`n_distinct > 0\`: absolute distinct count estimate
- \`n_distinct < 0\`: fraction of rows (e.g., -0.5 = 50% of rows are distinct)
- \`n_distinct = -1\`: every row is unique (sequential PK-like column)

**Interpreting \`correlation\`:**
- Close to 1 or -1: data is physically sorted by this column — Index Scan is very efficient
- Close to 0: data is randomly ordered — Index Scan causes random I/O; Seq Scan may be preferred

### 4.3 Fix Skewed Column Statistics

\`\`\`sql
-- Increase statistics target for a column with high cardinality or skew:
ALTER TABLE orders ALTER COLUMN status SET STATISTICS 500;
ANALYZE orders;

-- Verify the histogram has more buckets now:
SELECT array_length(histogram_bounds, 1) AS histogram_buckets
FROM pg_stats
WHERE tablename = 'orders' AND attname = 'status';
\`\`\`

### 4.4 Multi-Column Correlation — Extended Statistics

\`\`\`sql
-- If WHERE clause uses two correlated columns together:
CREATE STATISTICS ord_status_region (dependencies, ndistinct)
  ON status, region
  FROM orders;

ANALYZE orders;

-- Verify extended stats created:
SELECT stxname, stxkeys, stxkind FROM pg_statistic_ext;
\`\`\`

### 4.5 Missing or Unused Index

\`\`\`sql
-- Check whether an index exists for the column:
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'orders'
  AND indexdef ILIKE '%status%';

-- Check whether existing indexes are being scanned:
SELECT
  indexrelname,
  idx_scan,
  idx_tup_read,
  idx_tup_fetch
FROM pg_stat_user_indexes
WHERE relname = 'orders'
ORDER BY idx_scan DESC;
\`\`\`

Create a missing index and re-run EXPLAIN:

\`\`\`sql
CREATE INDEX CONCURRENTLY idx_orders_status_created
  ON orders (status, created_at DESC)
  WHERE status = 'pending';    -- partial index if status='pending' is the hot path

EXPLAIN (ANALYZE, BUFFERS)
SELECT id, created_at FROM orders
WHERE status = 'pending'
  AND created_at > NOW() - INTERVAL '7 days'
ORDER BY created_at DESC;
-- Should now show: Index Scan using idx_orders_status_created
\`\`\`

### 4.6 Type Cast Preventing Index Use

A common cause of Seq Scan despite an indexed column:

\`\`\`sql
-- Wrong — casts status (text) to integer, prevents index use:
WHERE status = 123

-- Wrong — function on indexed column prevents index use:
WHERE UPPER(status) = 'PENDING'

-- Correct:
WHERE status = 'pending'

-- Or create a functional index to support the query as written:
CREATE INDEX ON orders (UPPER(status));
\`\`\`

### 4.7 Sort / Hash Spill Fix

\`\`\`sql
-- Test with higher work_mem:
SET work_mem = '256MB';
EXPLAIN (ANALYZE, BUFFERS)
SELECT ...
ORDER BY created_at DESC;

-- If the sort now shows "quicksort Memory: NkB", make it permanent for the role:
RESET work_mem;   -- reset session
ALTER ROLE reporting SET work_mem = '256MB';
\`\`\`

### 4.8 Force Plan Comparison (Diagnostic Only)

\`\`\`sql
-- Test with index forced:
SET enable_seqscan = off;
EXPLAIN (ANALYZE, BUFFERS) <query>;
SET enable_seqscan = on;

-- Test with hash join disabled (forces nested loop or merge):
SET enable_hashjoin = off;
EXPLAIN (ANALYZE, BUFFERS) <query>;
SET enable_hashjoin = on;

-- Test with parallel query disabled:
SET max_parallel_workers_per_gather = 0;
EXPLAIN (ANALYZE, BUFFERS) <query>;
RESET max_parallel_workers_per_gather;
\`\`\`

Never leave these overrides in place in production. They exist only to measure whether the alternative plan is faster.

---

## Phase 5 — Table and Index Health Check

### 5.1 Tables with Excessive Sequential Scans

\`\`\`sql
SELECT
  relname,
  seq_scan,
  idx_scan,
  CASE WHEN idx_scan = 0 THEN 'NO INDEX USED'
       WHEN seq_scan > idx_scan * 10 THEN 'SEQ SCAN DOMINATES'
       ELSE 'OK'
  END AS assessment,
  n_live_tup,
  pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_stat_user_tables
WHERE n_live_tup > 10000
ORDER BY seq_scan DESC
LIMIT 20;
\`\`\`

### 5.2 Unused Indexes (Waste of Write Overhead)

\`\`\`sql
SELECT
  t.relname  AS table_name,
  i.relname  AS index_name,
  s.idx_scan AS scans_since_reset,
  pg_size_pretty(pg_relation_size(i.oid)) AS index_size
FROM pg_stat_user_indexes s
JOIN pg_class i ON i.oid = s.indexrelid
JOIN pg_class t ON t.oid = s.relid
JOIN pg_index x ON x.indexrelid = s.indexrelid
WHERE s.idx_scan = 0
  AND NOT x.indisprimary
  AND NOT x.indisunique
  AND pg_relation_size(i.oid) > 1024 * 1024   -- > 1MB
ORDER BY pg_relation_size(i.oid) DESC;
\`\`\`

### 5.3 Table Bloat Affecting Scans

\`\`\`sql
SELECT
  relname,
  n_live_tup,
  n_dead_tup,
  ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
  last_vacuum,
  last_autovacuum
FROM pg_stat_user_tables
WHERE n_dead_tup > 10000
ORDER BY dead_pct DESC
LIMIT 20;

-- Force vacuum on a bloated table:
VACUUM (ANALYZE, VERBOSE) orders;
\`\`\`

---

## Phase 6 — Interpret the PostgreSQL Log

### 6.1 Find Slow Queries

\`\`\`bash
# Find all slow query log entries (duration: NNNN ms):
grep "duration:" /var/log/postgresql/postgresql-$(date +%Y-%m-%d).log \
  | awk '{print $1, $NF"ms", $(NF-1)"ms"}' \
  | sort -t: -k2 -rn \
  | head -20

# Extract auto_explain plan blocks:
grep -A 100 "Query Text:" /var/log/postgresql/postgresql-$(date +%Y-%m-%d).log \
  | grep -B 1 "Seq Scan\|external merge\|Batches: [2-9]" \
  | head -40
\`\`\`

### 6.2 Lock Wait Entries

\`\`\`bash
# Show all lock wait events (requires log_lock_waits = on):
grep "lock\|Lock" /var/log/postgresql/postgresql-$(date +%Y-%m-%d).log \
  | grep -v "^--" \
  | tail -30
\`\`\`

---

## Phase 7 — Reusable Diagnostic Script

Save as \`/usr/local/bin/pg_diagnose.sh\`:

\`\`\`bash
#!/bin/bash
# pg_diagnose.sh — quick PostgreSQL session and plan diagnostic
# Usage: pg_diagnose.sh [dbname] [username]

DB=\${1:-postgres}
USER=\${2:-postgres}
PSQL="psql -U \${USER} -d \${DB} -P pager=off -A -F'|'"

echo "======================================"
echo " PostgreSQL Diagnostic: \$(date)"
echo " DB: \${DB}  User: \${USER}"
echo "======================================"

echo ""
echo "--- Active Sessions (non-idle) ---"
\${PSQL} -c "
SELECT pid, usename, state, wait_event_type, wait_event,
       ROUND(EXTRACT(EPOCH FROM now()-query_start)::numeric,1) AS secs,
       LEFT(query,100) AS query
FROM pg_stat_activity
WHERE state NOT IN ('idle')
  AND pid <> pg_backend_pid()
ORDER BY secs DESC NULLS LAST;"

echo ""
echo "--- Blocking Locks ---"
\${PSQL} -c "
SELECT blocked.pid, blocked.usename,
       blocking.pid AS blocking_pid, blocking.usename AS blocking_user,
       LEFT(blocked.query,80) AS blocked_query,
       LEFT(blocking.query,80) AS blocking_query
FROM pg_stat_activity blocked
JOIN pg_stat_activity blocking
  ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))
WHERE blocked.wait_event_type = 'Lock';"

echo ""
echo "--- Top 10 Queries by Total Time (pg_stat_statements) ---"
\${PSQL} -c "
SELECT calls,
       ROUND(total_exec_time::numeric,0) AS total_ms,
       ROUND(mean_exec_time::numeric,2) AS mean_ms,
       ROUND(max_exec_time::numeric,2) AS max_ms,
       LEFT(query,100) AS query
FROM pg_stat_statements
WHERE calls > 5
ORDER BY total_exec_time DESC
LIMIT 10;"

echo ""
echo "--- Tables: Sequential Scan Leaders ---"
\${PSQL} -c "
SELECT relname, seq_scan, idx_scan, n_live_tup, n_dead_tup,
       last_autoanalyze::date AS last_analyzed
FROM pg_stat_user_tables
WHERE n_live_tup > 1000
ORDER BY seq_scan DESC
LIMIT 10;"

echo ""
echo "--- Large Unused Indexes ---"
\${PSQL} -c "
SELECT t.relname AS tbl, i.relname AS idx,
       pg_size_pretty(pg_relation_size(i.oid)) AS size,
       s.idx_scan AS scans
FROM pg_stat_user_indexes s
JOIN pg_class i ON i.oid = s.indexrelid
JOIN pg_class t ON t.oid = s.relid
JOIN pg_index x ON x.indexrelid = s.indexrelid
WHERE s.idx_scan = 0
  AND NOT x.indisprimary
  AND NOT x.indisunique
  AND pg_relation_size(i.oid) > 1024*1024
ORDER BY pg_relation_size(i.oid) DESC
LIMIT 10;"

echo ""
echo "--- Tables Needing VACUUM (high dead tuple %) ---"
\${PSQL} -c "
SELECT relname,
       n_live_tup, n_dead_tup,
       ROUND(100.0*n_dead_tup/NULLIF(n_live_tup+n_dead_tup,0),1) AS dead_pct,
       last_autovacuum::date AS last_vacuumed
FROM pg_stat_user_tables
WHERE n_dead_tup > 5000
ORDER BY dead_pct DESC
LIMIT 10;"

echo ""
echo "======================================"
echo " Diagnostic complete."
echo "======================================"
\`\`\`

\`\`\`bash
chmod +x /usr/local/bin/pg_diagnose.sh

# Run:
pg_diagnose.sh mydb myuser

# Schedule nightly (crontab):
# 0 2 * * * /usr/local/bin/pg_diagnose.sh production postgres >> /var/log/pg_diagnose.log 2>&1
\`\`\`

---

## Quick Reference: EXPLAIN Output Patterns

| Pattern in EXPLAIN output | Diagnosis | Fix |
|--------------------------|-----------|-----|
| \`Seq Scan\` on large table with WHERE | Missing index or low selectivity | Add index; check \`pg_stats\` selectivity |
| \`rows=1\` estimated, many actual | Stale statistics | \`ANALYZE table\` |
| \`Sort Method: external merge\` | Sort spilled to disk | Increase \`work_mem\` |
| \`Batches: N\` where N > 1 on Hash | Hash table spilled | Increase \`work_mem\` |
| Nested Loop \`loops=\` very high | Bad cardinality estimate on outer | \`ANALYZE\`, extended statistics |
| \`Workers Planned: N  Workers Launched: 0\` | Parallel query blocked | Check \`max_worker_processes\` |
| \`Index Scan\` not used despite index existing | Type cast, function on column, or low selectivity | Fix query or create functional index |
| \`Bitmap Heap Scan\` with \`Recheck Cond\` | Normal for mid-selectivity queries | OK; check \`lossy\` flag for work_mem issue |
| \`Index Only Scan\` with many \`heap fetches\` | Visibility map not current | Run \`VACUUM table\` |`,
};

async function main() {
  console.log('Inserting PostgreSQL EXPLAIN runbook...');
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
