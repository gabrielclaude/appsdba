import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'PostgreSQL Performance Tuning: A Practical Guide',
  slug: 'postgresql-performance-tuning',
  excerpt:
    'A practical guide to PostgreSQL performance tuning — covering query analysis with EXPLAIN ANALYZE and pg_stat_statements, index strategy, memory and WAL configuration, autovacuum tuning for high-churn tables, lock and wait event diagnosis, and connection pooling with PgBouncer.',
  category: 'postgresql' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-09'),
  youtubeUrl: null,
  content: `PostgreSQL performance problems almost always fall into one of four buckets: slow queries, bad indexes, misconfigured memory, or table bloat. The tools to diagnose all four are built into the database itself. This guide walks through each layer systematically.

---

## Layer 1 — Finding Slow Queries with pg_stat_statements

Before tuning anything, you need to know what is actually slow. The \`pg_stat_statements\` extension (covered in the install runbook) aggregates execution statistics per normalised query text across all sessions.

### Top queries by total execution time

\`\`\`sql
SELECT
    left(query, 120)                                      AS query_preview,
    calls,
    ROUND(total_exec_time::numeric, 2)                    AS total_ms,
    ROUND(mean_exec_time::numeric, 2)                     AS mean_ms,
    ROUND(stddev_exec_time::numeric, 2)                   AS stddev_ms,
    rows,
    ROUND((shared_blks_hit * 100.0 /
           NULLIF(shared_blks_hit + shared_blks_read, 0))::numeric, 2) AS cache_hit_pct
FROM   pg_stat_statements
WHERE  calls > 10
ORDER BY total_exec_time DESC
LIMIT  20;
\`\`\`

**What to look for:**
- High \`total_exec_time\` with low \`calls\` — infrequent but expensive queries, often candidates for index or query rewrite
- High \`calls\` with moderate \`mean_exec_time\` — high-frequency queries where even small gains have large aggregate impact
- Low \`cache_hit_pct\` (under ~95%) — queries doing physical I/O; investigate whether shared_buffers needs increasing or whether data access patterns are inherently random

### Top queries by I/O

\`\`\`sql
SELECT
    left(query, 120)                AS query_preview,
    calls,
    shared_blks_read                AS physical_reads,
    shared_blks_hit                 AS buffer_hits,
    temp_blks_written               AS temp_writes,
    ROUND(mean_exec_time::numeric, 2) AS mean_ms
FROM   pg_stat_statements
WHERE  shared_blks_read > 1000
ORDER BY shared_blks_read DESC
LIMIT  20;
\`\`\`

Large \`temp_blks_written\` values indicate sort or hash operations that spilled to disk — a signal that \`work_mem\` is too low for that query's data volume.

### Reset statistics after a tuning change

\`\`\`sql
SELECT pg_stat_statements_reset();
\`\`\`

---

## Layer 2 — Reading EXPLAIN ANALYZE

\`EXPLAIN ANALYZE\` executes the query and returns the actual execution plan with real row counts, timing, and buffer usage. It is the primary diagnostic tool for a slow query.

\`\`\`sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT o.order_id, c.name, SUM(oi.quantity * oi.unit_price) AS total
FROM   orders     o
JOIN   customers  c  ON o.customer_id = c.id
JOIN   order_items oi ON o.order_id = oi.order_id
WHERE  o.created_at >= NOW() - INTERVAL '30 days'
GROUP  BY o.order_id, c.name
ORDER  BY total DESC
LIMIT  100;
\`\`\`

### Key nodes to understand

**Seq Scan** — a full table scan. Not always bad (small tables or low selectivity), but on large tables with a filter it usually indicates a missing index.

**Index Scan** — uses a B-tree index. Good for high-selectivity lookups.

**Index Only Scan** — the query is satisfied entirely from the index without touching the heap. The fastest index access type; achieved with covering indexes.

**Hash Join** — builds a hash table from the smaller side and probes it with the larger side. Efficient for large joins. If the hash table spills to disk (\`Batches: > 1\`), increase \`work_mem\`.

**Nested Loop** — iterates the outer set and for each row does an index lookup on the inner set. Efficient when the outer set is small and the inner index is selective. Catastrophic when the outer set is large and there is no index.

**Sort (disk)** — sort spilled to temporary files. The \`Sort Method: external merge\` label confirms this. Increase \`work_mem\` or add an index that provides pre-sorted output.

### Spotting row estimate problems

Compare \`rows=X\` (planner estimate) against \`(actual rows=Y)\` in the output. An estimate that is off by more than 10× usually means stale statistics:

\`\`\`sql
-- Update statistics for a specific table
ANALYZE orders;

-- Update statistics for all tables in the current database
ANALYZE;
\`\`\`

If estimates remain poor after ANALYZE, the column has a non-uniform distribution. Use extended statistics:

\`\`\`sql
-- Create a correlation statistic between two columns the planner treats as independent
CREATE STATISTICS orders_customer_status ON customer_id, status FROM orders;
ANALYZE orders;
\`\`\`

---

## Layer 3 — Index Strategy

Indexes are the highest-leverage tuning intervention. The wrong indexes (missing, unused, or duplicated) are the most common source of PostgreSQL performance problems.

### Finding missing indexes

Look for sequential scans on large tables with filter conditions:

\`\`\`sql
SELECT schemaname,
       relname                                     AS table_name,
       seq_scan,
       seq_tup_read,
       idx_scan,
       n_live_tup,
       ROUND(seq_tup_read::numeric /
             NULLIF(seq_scan, 0))                  AS avg_rows_per_seq_scan
FROM   pg_stat_user_tables
WHERE  seq_scan > 0
  AND  n_live_tup > 10000
ORDER BY seq_tup_read DESC
LIMIT  20;
\`\`\`

Tables with high \`seq_tup_read\` and a \`seq_scan / idx_scan\` ratio greater than ~10:1 on large tables are candidates for new indexes.

### Finding unused indexes

Indexes that are never used waste write overhead and storage:

\`\`\`sql
SELECT schemaname,
       relname        AS table_name,
       indexrelname   AS index_name,
       idx_scan,
       pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM   pg_stat_user_indexes
WHERE  idx_scan = 0
  AND  indexrelname NOT LIKE 'pg_%'
ORDER BY pg_relation_size(indexrelid) DESC;
\`\`\`

**Caution:** reset \`pg_stat_user_indexes\` statistics after a deployment or major schema change (\`SELECT pg_stat_reset();\`). An index created months ago may show low \`idx_scan\` because it only serves quarterly reports.

### Covering indexes

A covering index includes all columns referenced by a query, enabling Index Only Scans:

\`\`\`sql
-- Query: SELECT status, total FROM orders WHERE customer_id = $1 AND created_at > $2
-- Without covering index: Index Scan + heap fetch for status and total
CREATE INDEX idx_orders_customer_date
    ON orders (customer_id, created_at)
    INCLUDE (status, total);
-- With INCLUDE: Index Only Scan — no heap fetch needed
\`\`\`

### Partial indexes

Index only the rows that queries actually filter on:

\`\`\`sql
-- If 95% of queries only look at active orders
CREATE INDEX idx_orders_active_customer
    ON orders (customer_id, created_at)
    WHERE status = 'active';
\`\`\`

A partial index is smaller, faster to scan, and cheaper to maintain than a full index on the same columns.

### BRIN indexes for time-series data

B-tree indexes on timestamp columns in append-only or time-ordered tables are often overkill. A BRIN (Block Range Index) stores min/max values per page range — tiny footprint, effective for range queries:

\`\`\`sql
CREATE INDEX idx_events_created_brin ON events USING brin (created_at);
\`\`\`

BRIN is most effective when rows are physically stored in approximately the same order as the indexed column (i.e., new rows are always appended at the end of the table, which is typical for event/log tables).

---

## Layer 4 — Memory Configuration

### shared_buffers

The buffer cache. Most of PostgreSQL's read I/O should be served from here. The standard recommendation is **25% of total RAM**, with diminishing returns above 8 GB because the OS page cache also buffers PostgreSQL files.

\`\`\`sql
-- Current hit rate — should be > 99% on a warm production system
SELECT
    SUM(blks_hit)::float / NULLIF(SUM(blks_hit) + SUM(blks_read), 0) * 100 AS buffer_hit_rate_pct
FROM pg_stat_database;
\`\`\`

If the hit rate is consistently below 95%, \`shared_buffers\` is undersized or the working set is larger than available memory.

### work_mem

Allocated **per sort or hash operation**, not per connection. A complex query with multiple sorts and hash joins can allocate several multiples of \`work_mem\` simultaneously. Set it conservatively (16–64 MB) and override for specific heavy analytical queries:

\`\`\`sql
-- Set for the current session only
SET work_mem = '256MB';

-- Run the heavy analytical query here
-- ...

-- Restore default when done (or just close the session)
RESET work_mem;
\`\`\`

Detect sort spills to disk:

\`\`\`sql
SELECT query, temp_blks_written, calls
FROM   pg_stat_statements
WHERE  temp_blks_written > 0
ORDER BY temp_blks_written DESC
LIMIT 10;
\`\`\`

### effective_cache_size

This parameter does **not** allocate memory — it tells the planner how much total memory (shared_buffers + OS page cache) is likely available for caching. Setting it accurately lets the planner prefer index scans over sequential scans. A reasonable value is 50–75% of total RAM:

\`\`\`ini
effective_cache_size = 12GB   # on a 16 GB server
\`\`\`

---

## Layer 5 — Autovacuum and Table Bloat

In a high-churn table (frequent UPDATEs and DELETEs), dead tuples accumulate faster than the default autovacuum thresholds can clear them. The result is **table bloat**: the physical file grows far larger than the live data, and sequential scans become slow not because there are more rows but because there are more dead rows to skip.

### Identifying bloated tables

\`\`\`sql
SELECT
    schemaname,
    relname                                           AS table_name,
    n_live_tup,
    n_dead_tup,
    ROUND(n_dead_tup * 100.0 /
          NULLIF(n_live_tup + n_dead_tup, 0), 1)     AS dead_pct,
    last_autovacuum,
    last_autoanalyze,
    pg_size_pretty(pg_total_relation_size(relid))     AS total_size
FROM   pg_stat_user_tables
WHERE  n_dead_tup > 1000
ORDER BY dead_pct DESC
LIMIT  20;
\`\`\`

A \`dead_pct\` above 10–20% on a large table indicates autovacuum is not keeping up.

### Aggressive autovacuum for high-churn tables

Override autovacuum settings at the table level rather than changing global parameters:

\`\`\`sql
ALTER TABLE orders SET (
    autovacuum_vacuum_scale_factor    = 0.01,   -- vacuum when 1% of rows are dead
    autovacuum_vacuum_threshold       = 100,    -- or when 100 dead rows accumulate
    autovacuum_analyze_scale_factor   = 0.005,
    autovacuum_vacuum_cost_delay      = 2       -- ms — lower value = more aggressive I/O
);
\`\`\`

### Manual VACUUM for immediate relief

\`\`\`sql
-- Reclaim dead tuple storage (does not shrink the file, but marks space reusable)
VACUUM orders;

-- Full vacuum — rewrites the table to reclaim disk space (locks the table, use in maintenance window)
VACUUM FULL orders;

-- Concurrent index rebuild (no full table lock)
REINDEX INDEX CONCURRENTLY idx_orders_customer_date;
\`\`\`

---

## Layer 6 — Lock and Wait Event Analysis

Long-running locks are a common cause of application slowdowns that look like database performance problems.

### Active locks and waiters

\`\`\`sql
SELECT
    blocked.pid                     AS blocked_pid,
    blocked.usename                 AS blocked_user,
    blocked.query                   AS blocked_query,
    blocking.pid                    AS blocking_pid,
    blocking.usename                AS blocking_user,
    blocking.query                  AS blocking_query,
    now() - blocked.query_start     AS blocked_duration
FROM   pg_stat_activity blocked
JOIN   pg_stat_activity blocking
       ON  blocking.pid = ANY(pg_blocking_pids(blocked.pid))
WHERE  blocked.cardinality(pg_blocking_pids(blocked.pid)) > 0
ORDER  BY blocked_duration DESC;
\`\`\`

### Wait events summary

\`\`\`sql
SELECT wait_event_type,
       wait_event,
       COUNT(*) AS session_count,
       STRING_AGG(pid::text, ', ' ORDER BY pid) AS pids
FROM   pg_stat_activity
WHERE  state != 'idle'
  AND  wait_event IS NOT NULL
GROUP  BY wait_event_type, wait_event
ORDER  BY session_count DESC;
\`\`\`

Common wait events and their meaning:

| Wait Event | Type | Meaning |
|-----------|------|---------|
| \`Lock:relation\` | Lock | Table-level lock contention — often a DDL vs DML conflict |
| \`Lock:tuple\` | Lock | Row-level lock — one UPDATE waiting for another to commit |
| \`LWLock:buffer_mapping\` | LWLock | Heavy contention on shared_buffers — may need larger buffer pool |
| \`IO:DataFileRead\` | IO | Physical reads — working set not fitting in shared_buffers |
| \`Client:ClientRead\` | Client | PostgreSQL waiting for the client to send the next query — application-side delay |

---

## Layer 7 — Connection Pooling with PgBouncer

PostgreSQL's process-per-connection model means that each connection consumes approximately 5–10 MB of memory and has non-trivial startup cost. A spike to 500 simultaneous connections on a 16 GB server can exhaust memory regardless of query load.

**PgBouncer** is a lightweight connection pool that sits between the application and PostgreSQL, maintaining a smaller pool of actual database connections while serving thousands of application connections.

### PgBouncer pooling modes

| Mode | How it works | Best for |
|------|-------------|---------|
| \`transaction\` | Connection returned to pool after each transaction | Most OLTP applications |
| \`session\` | Connection held for the entire client session | Applications using session-level state (advisory locks, temp tables, \`SET\`) |
| \`statement\` | Connection returned after each statement | Rarely used; incompatible with multi-statement transactions |

### Basic pgbouncer.ini configuration

\`\`\`ini
[databases]
appdb = host=127.0.0.1 port=5432 dbname=appdb

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt

pool_mode = transaction
max_client_conn = 1000
default_pool_size = 25        ; actual PostgreSQL connections per database/user pair
min_pool_size = 5
reserve_pool_size = 5
reserve_pool_timeout = 3

server_idle_timeout = 600
client_idle_timeout = 0

log_connections = 0           ; disable in high-throughput environments
log_disconnections = 0
\`\`\`

With this configuration, up to 1,000 application connections are served by 25 real PostgreSQL connections, reducing server-side resource consumption by 97.5%.

---

## Putting It Together: The Tuning Workflow

A systematic performance investigation follows this order:

1. **Identify the top queries** via \`pg_stat_statements\` — total time, mean time, I/O, temp writes
2. **Run EXPLAIN ANALYZE** on the top offenders — look for Seq Scans on large tables, sort spills, row estimate mismatches
3. **Add or adjust indexes** — covering indexes, partial indexes, BRIN for time-series
4. **Run ANALYZE** to refresh statistics; re-run EXPLAIN ANALYZE to confirm plan changed
5. **Check buffer hit rate** — if below 95%, consider increasing \`shared_buffers\`
6. **Check for sort spills** — if present, increase \`work_mem\` for the sessions or queries involved
7. **Check autovacuum effectiveness** — dead tuple ratios on high-churn tables; tune per-table autovacuum settings
8. **Check for lock contention** — identify blockers and evaluate transaction duration or locking order
9. **Review connection count** — if hitting \`max_connections\`, deploy PgBouncer

The companion runbook provides the complete diagnostic procedure with all SQL queries and shell scripts ready to deploy.`,
};

async function main() {
  console.log('Inserting PostgreSQL performance tuning blog post...');
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
