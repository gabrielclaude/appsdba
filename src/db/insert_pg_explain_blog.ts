import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Tracing a PostgreSQL SQL Session and Reading EXPLAIN Plans',
  slug: 'postgresql-sql-session-tracing-explain-plan',
  excerpt:
    'A practical guide to tracing what PostgreSQL is doing with your SQL — covering pg_stat_activity, pg_stat_statements, auto_explain, log_min_duration_statement, and how to read every node in an EXPLAIN ANALYZE output to diagnose sequential scans, bad row estimates, sort spills, and join strategy mismatches.',
  category: 'postgresql' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-14'),
  youtubeUrl: null,
  content: `When a query is slow, the first instinct is often to reach for an index. But before creating anything, you need to understand what PostgreSQL is actually doing — what plan it chose, why it chose it, and where the time is going. PostgreSQL provides a complete set of tools for this: \`EXPLAIN\`, \`pg_stat_statements\`, \`auto_explain\`, and a family of system views that expose live session state, I/O statistics, and planner inputs. This post walks through how to use all of them together.

---

## How PostgreSQL Processes a Query

Before reading an execution plan, it helps to understand what produced it. Every query goes through four stages:

\`\`\`
SQL text
    │
    ▼
┌─────────────────────────────┐
│ Parser                      │
│ SQL → parse tree            │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ Rewriter                    │
│ Applies rules and views     │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ Planner / Optimizer         │
│ Generates candidate plans   │
│ Estimates cost using stats  │
│ Picks lowest-cost plan      │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ Executor                    │
│ Runs the plan node tree     │
│ Returns rows to client      │
└─────────────────────────────┘
\`\`\`

The planner's decisions are driven entirely by **statistics** — row counts, column value distributions, and index selectivity estimates stored in \`pg_statistic\` and summarised in \`pg_stats\`. When plans are wrong, stale or missing statistics are usually the first thing to check.

---

## pg_stat_activity: Seeing Live Sessions

\`pg_stat_activity\` shows one row per backend process. It is the first place to look when a query is running (or stuck):

\`\`\`sql
SELECT
  pid,
  usename,
  application_name,
  state,
  wait_event_type,
  wait_event,
  query_start,
  now() - query_start AS duration,
  LEFT(query, 120)    AS query
FROM pg_stat_activity
WHERE state != 'idle'
  AND pid != pg_backend_pid()
ORDER BY duration DESC NULLS LAST;
\`\`\`

### Key Columns

| Column | What it tells you |
|--------|------------------|
| \`state\` | \`active\` = query running; \`idle in transaction\` = holding locks |
| \`wait_event_type\` | \`Lock\` = blocked on a lock; \`IO\` = waiting on disk; \`Client\` = waiting for client |
| \`wait_event\` | Specific event: \`relation\`, \`tuple\`, \`WALWrite\`, \`DataFileRead\` |
| \`query_start\` | When the current query started |
| \`state_change\` | When the state last changed — useful for idle-in-transaction detection |

### Detecting Blocked Queries

\`\`\`sql
-- Queries waiting on locks, with the blocking query:
SELECT
  blocked.pid,
  blocked.usename,
  blocked.query                           AS blocked_query,
  blocking.pid                            AS blocking_pid,
  blocking.query                          AS blocking_query,
  now() - blocked.query_start             AS blocked_for
FROM pg_stat_activity AS blocked
JOIN pg_stat_activity AS blocking
  ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))
WHERE blocked.wait_event_type = 'Lock';
\`\`\`

---

## pg_stat_statements: Aggregate Query Statistics

\`pg_stat_statements\` accumulates statistics across all executions of each normalised query — total time, call count, rows returned, buffer hits and reads. It answers "which queries are consuming the most database time" without needing to catch them live.

\`\`\`sql
-- Enable in postgresql.conf (requires restart):
-- shared_preload_libraries = 'pg_stat_statements'

-- Then in the database:
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
\`\`\`

### Finding the Most Expensive Queries

\`\`\`sql
-- Top 10 by total execution time:
SELECT
  LEFT(query, 100)                             AS query,
  calls,
  ROUND(total_exec_time::numeric, 2)           AS total_ms,
  ROUND(mean_exec_time::numeric, 2)            AS mean_ms,
  ROUND(stddev_exec_time::numeric, 2)          AS stddev_ms,
  rows,
  shared_blks_hit,
  shared_blks_read,
  ROUND(100.0 * shared_blks_hit /
    NULLIF(shared_blks_hit + shared_blks_read, 0), 1) AS cache_hit_pct
FROM pg_stat_statements
WHERE calls > 10
ORDER BY total_exec_time DESC
LIMIT 10;
\`\`\`

\`\`\`sql
-- Queries with the highest I/O (most physical reads):
SELECT
  LEFT(query, 100) AS query,
  calls,
  shared_blks_read,
  ROUND(mean_exec_time::numeric, 2) AS mean_ms
FROM pg_stat_statements
WHERE shared_blks_read > 1000
ORDER BY shared_blks_read DESC
LIMIT 10;
\`\`\`

\`\`\`sql
-- High-variance queries (inconsistent performance — possible plan instability):
SELECT
  LEFT(query, 100) AS query,
  calls,
  ROUND(mean_exec_time::numeric, 2)   AS mean_ms,
  ROUND(stddev_exec_time::numeric, 2) AS stddev_ms,
  ROUND(max_exec_time::numeric, 2)    AS max_ms
FROM pg_stat_statements
WHERE calls > 20
  AND stddev_exec_time > mean_exec_time * 0.5
ORDER BY stddev_exec_time DESC
LIMIT 10;
\`\`\`

---

## EXPLAIN: Reading the Execution Plan

\`EXPLAIN\` shows the plan the planner chose without running the query. \`EXPLAIN ANALYZE\` runs the query and shows both the planner's estimates and the actual measured values side by side — the discrepancy between them is where most performance problems live.

### EXPLAIN Options

\`\`\`sql
-- Basic plan (estimates only, no execution):
EXPLAIN SELECT ...;

-- Full analysis — run the query, measure every node:
EXPLAIN (ANALYZE, BUFFERS) SELECT ...;

-- Machine-readable JSON for tooling:
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT ...;

-- Include I/O timing (requires track_io_timing = on in postgresql.conf):
EXPLAIN (ANALYZE, BUFFERS, TIMING) SELECT ...;
\`\`\`

### Anatomy of a Plan Node

\`\`\`
Hash Join  (cost=412.50..1843.20 rows=8500 width=64)
           (actual time=12.3..89.4 rows=8312 loops=1)
  Buffers: shared hit=234 read=891
  ->  Seq Scan on orders  (cost=0.00..920.00 rows=50000 width=32)
                          (actual time=0.1..34.2 rows=50000 loops=1)
  ->  Hash  (cost=207.00..207.00 rows=4000 width=32)
            (actual time=8.1..8.1 rows=4000 loops=1)
       Buckets: 4096  Batches: 1  Memory Usage: 221kB
        ->  Seq Scan on customers  (cost=0.00..207.00 rows=4000 width=32)
\`\`\`

| Field | Meaning |
|-------|---------|
| \`cost=0.00..920.00\` | Estimated startup cost .. total cost (in arbitrary planner units, not milliseconds) |
| \`rows=50000\` | Estimated row count |
| \`width=32\` | Estimated average row width in bytes |
| \`actual time=0.1..34.2\` | Measured: first row time .. last row time in ms |
| \`rows=50000\` (actual) | Rows actually returned |
| \`loops=1\` | How many times this node was executed |
| \`shared hit=234\` | Blocks found in shared_buffers (no I/O) |
| \`shared read=891\` | Blocks read from disk or OS page cache |

**The critical comparison:** estimated \`rows\` vs actual \`rows\`. A factor of 10× or more signals that the planner's statistics are wrong — it made a join or sort decision based on a false premise.

---

## Plan Node Types

### Scan Nodes

| Node | Condition | Notes |
|------|-----------|-------|
| \`Seq Scan\` | Full table scan | Expected for small tables or low selectivity; alarming on large tables with a WHERE clause |
| \`Index Scan\` | Index used, heap fetched for each row | Efficient for high selectivity (small fraction of rows) |
| \`Index Only Scan\` | Index covers all needed columns | Fastest — no heap access; requires visibility map to be current |
| \`Bitmap Heap Scan\` | Index narrows candidates, heap fetched in block order | Used for moderate selectivity; reduces random I/O |
| \`Bitmap Index Scan\` | Builds the bitmap; child of Bitmap Heap Scan | — |

### Join Nodes

| Node | Algorithm | When chosen |
|------|-----------|------------|
| \`Nested Loop\` | For each outer row, scan inner relation | Efficient when inner is indexed and outer is small |
| \`Hash Join\` | Build hash table of smaller relation, probe with larger | Large unsorted inputs; requires \`work_mem\` for hash table |
| \`Merge Join\` | Both sides sorted on join key, merge | Both inputs already sorted (e.g., both indexed); avoids a sort step |

### Sort and Aggregate Nodes

| Node | Watch for |
|------|----------|
| \`Sort\` | Check whether sort is \`external merge\` (spilled to disk due to insufficient \`work_mem\`) |
| \`Hash\` | Check \`Batches\`: if > 1, hash table spilled to disk |
| \`Gather\` / \`Gather Merge\` | Parallel query; multiple workers converging |
| \`Incremental Sort\` | Added in PG 13; sorts only new keys when leading keys already sorted |

---

## Spotting and Diagnosing Common Problems

### 1. Seq Scan When You Expect an Index Scan

\`\`\`sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM orders WHERE customer_id = 12345;
-- Plan shows: Seq Scan on orders  (rows=50000 loops=1)
\`\`\`

**Check selectivity:**
\`\`\`sql
SELECT n_distinct, correlation, most_common_vals, most_common_freqs
FROM pg_stats
WHERE tablename = 'orders' AND attname = 'customer_id';
\`\`\`

- If \`n_distinct\` is very low (few unique values), the planner is right — the index is not selective enough.
- If \`correlation\` is close to 1 (data physically sorted by this column), consider a clustered index or \`CLUSTER\`.

**Check if the index exists and is valid:**
\`\`\`sql
SELECT indexname, indexdef, indisvalid
FROM pg_indexes
JOIN pg_index ON pg_index.indexrelid = (indexname::regclass)
WHERE tablename = 'orders';
\`\`\`

**Force the planner to test with the index** (never in production — diagnostic only):
\`\`\`sql
SET enable_seqscan = off;
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM orders WHERE customer_id = 12345;
SET enable_seqscan = on;
\`\`\`

If the index plan is faster when forced, the planner's cost model is off — usually because \`random_page_cost\` is set too high relative to \`seq_page_cost\` (common on SSD storage):
\`\`\`sql
-- For SSD storage — reduces the penalty on random I/O:
SET random_page_cost = 1.1;   -- default is 4.0 (tuned for spinning disk)
\`\`\`

### 2. Bad Row Estimates

\`\`\`
Seq Scan on orders  (cost=0.00..920.00 rows=1 width=32)
                    (actual time=45.2..45.2 rows=8500 loops=1)
\`\`\`

Estimated 1 row, got 8500. The planner serialised a join badly because it thought this scan would return almost nothing.

**Fix: run ANALYZE** (or it runs automatically via autovacuum, but may be behind):
\`\`\`sql
ANALYZE orders;
-- Or increase statistics target for a skewed column:
ALTER TABLE orders ALTER COLUMN status SET STATISTICS 500;  -- default is 100
ANALYZE orders;
\`\`\`

**Multi-column correlation:** if the WHERE clause uses multiple columns, the planner multiplies individual selectivities — which underestimates if columns are correlated. Extended statistics fix this:
\`\`\`sql
CREATE STATISTICS orders_status_region ON status, region FROM orders;
ANALYZE orders;
EXPLAIN SELECT * FROM orders WHERE status = 'shipped' AND region = 'EU';
-- Row estimate should now be closer to reality
\`\`\`

### 3. Sort Spilling to Disk

\`\`\`
Sort  (cost=...)  (actual time=2341.0..2892.0 rows=500000 loops=1)
  Sort Key: created_at DESC
  Sort Method: external merge  Disk: 18432kB
\`\`\`

\`external merge\` means the sort could not fit in \`work_mem\` and spilled to disk. Fix: increase \`work_mem\` for the session (not globally — the setting applies per sort operation per backend):

\`\`\`sql
SET work_mem = '256MB';
EXPLAIN (ANALYZE, BUFFERS) SELECT ... ORDER BY created_at DESC;
-- Sort Method should now show: quicksort  Memory: NNkB
\`\`\`

The safe global value depends on max_connections. With 100 connections and \`work_mem = 256MB\`, worst-case memory use is 25 GB. Tune session-level for known heavy queries:
\`\`\`sql
ALTER ROLE reporting_user SET work_mem = '512MB';
\`\`\`

### 4. Hash Batches > 1

\`\`\`
Hash  (actual time=...)
  Buckets: 32768  Batches: 4  Memory Usage: 4096kB
\`\`\`

\`Batches: 4\` means the hash table spilled to disk in 4 passes — same root cause as sort spill. Increase \`work_mem\`.

### 5. Nested Loop on Large Tables

\`\`\`
Nested Loop  (cost=0.43..8920000.00 rows=50000000 width=64)
  ->  Seq Scan on large_table  (rows=10000000 loops=1)
  ->  Index Scan on other_table  (loops=10000000)
\`\`\`

10 million inner index scans. The planner chose nested loop because it estimated the outer to be small (but it wasn't — a row estimate problem). Fix: \`ANALYZE\`, extended statistics, or explicitly disable nested loop for the session:
\`\`\`sql
SET enable_nestloop = off;
EXPLAIN (ANALYZE, BUFFERS) <query>;
SET enable_nestloop = on;
\`\`\`

---

## auto_explain: Capturing Plans Automatically

Manually running \`EXPLAIN\` only works for queries you can identify in advance. \`auto_explain\` logs the plan of any query exceeding a threshold, automatically, in the PostgreSQL log. It is the right tool for intermittent slow queries.

\`\`\`
# postgresql.conf:
shared_preload_libraries = 'pg_stat_statements,auto_explain'
auto_explain.log_min_duration = 1000   # log plans for queries > 1 second
auto_explain.log_analyze = on          # include ANALYZE data (runs the query for real)
auto_explain.log_buffers = on          # include buffer statistics
auto_explain.log_timing = on           # requires track_io_timing = on
auto_explain.log_nested_statements = on # log plans inside PL/pgSQL functions
auto_explain.sample_rate = 1.0         # 0.01 = sample 1% of queries above threshold
\`\`\`

Reload without restart:
\`\`\`sql
SELECT pg_reload_conf();
-- Or: pg_ctl reload
\`\`\`

The plan appears in the PostgreSQL log (\`/var/log/postgresql/\` or \`pg_log/\`) alongside the query text. Grep for \`duration:\` to find them:

\`\`\`bash
grep -A 50 "duration: [0-9]\{4,\}" /var/log/postgresql/postgresql-*.log | head -100
\`\`\`

Note: \`auto_explain.log_analyze = on\` executes the statement to measure it. For \`SELECT\` this is safe. For DML (\`INSERT\`, \`UPDATE\`, \`DELETE\`), the statement runs and is then rolled back — the plan is captured but the data change is undone. Use \`sample_rate\` to limit the overhead.

---

## Logging Slow Queries Without Plans

If auto_explain overhead is a concern, log only the query text (not the plan) for slow queries:

\`\`\`
# postgresql.conf:
log_min_duration_statement = 500    # log queries taking > 500 ms
log_line_prefix = '%t [%p]: [%l-1] user=%u,db=%d,app=%a,client=%h '
\`\`\`

This adds lines like:

\`\`\`
2026-06-14 09:23:41 UTC [12345]: [1-1] user=app,db=production,app=rails,client=10.0.0.5
  duration: 1842.321 ms  statement: SELECT * FROM orders WHERE ...
\`\`\`

Use \`pgBadger\` to parse the log into a report of slow queries, lock waits, and error frequencies.

---

## Table and Index Statistics Views

These views show cumulative I/O since the last \`pg_stat_reset()\` and are essential for understanding whether indexes are being used:

\`\`\`sql
-- Table-level: are sequential scans dominating?
SELECT
  relname,
  seq_scan,
  idx_scan,
  n_live_tup,
  n_dead_tup,
  ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS bloat_pct,
  last_vacuum,
  last_autovacuum,
  last_analyze,
  last_autoanalyze
FROM pg_stat_user_tables
ORDER BY seq_scan DESC
LIMIT 20;
\`\`\`

\`\`\`sql
-- Index-level: which indexes are never used?
SELECT
  t.relname  AS table,
  ix.relname AS index,
  s.idx_scan,
  s.idx_tup_read,
  pg_size_pretty(pg_relation_size(ix.oid)) AS index_size
FROM pg_stat_user_indexes s
JOIN pg_class ix ON ix.oid = s.indexrelid
JOIN pg_class t  ON t.oid  = s.relid
WHERE s.idx_scan = 0
  AND ix.relname NOT LIKE 'pg_%'
ORDER BY pg_relation_size(ix.oid) DESC;
\`\`\`

An index with \`idx_scan = 0\` since the last statistics reset is a candidate for removal — it costs write overhead and storage but is never used. Verify by checking the index age and whether the statistics have been reset recently before dropping.

---

## Putting It Together: A Diagnostic Workflow

\`\`\`
1. pg_stat_activity
   → Find which query is slow or blocked right now
   → Check wait_event for Lock / IO

2. pg_stat_statements
   → Find which queries consume the most total time historically
   → Identify high-I/O or high-variance queries

3. EXPLAIN (ANALYZE, BUFFERS) on the target query
   → Get the actual plan and measured row counts
   → Compare estimated vs actual rows at each node

4. pg_stats / ANALYZE
   → Check statistics freshness if estimates are wrong
   → Adjust statistics target or create extended statistics

5. auto_explain in staging / dev
   → Capture full plans for intermittent slow queries automatically

6. pg_stat_user_tables / pg_stat_user_indexes
   → Validate that new indexes are being used
   → Find bloated tables needing VACUUM
\`\`\`

The companion runbook covers the complete step-by-step procedure: enabling the required extensions, configuring logging, running a session trace from \`pg_stat_activity\` to \`EXPLAIN ANALYZE\`, diagnosing each of the common problems, and setting up \`auto_explain\` for production monitoring.`,
};

async function main() {
  console.log('Inserting PostgreSQL EXPLAIN blog post...');
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
