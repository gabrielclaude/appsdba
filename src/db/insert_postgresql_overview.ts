import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'PostgreSQL: A Comprehensive Overview for Database Professionals',
  slug: 'postgresql-overview',
  excerpt:
    'A deep-dive introduction to PostgreSQL for database professionals — covering its architecture, MVCC concurrency model, process layout, WAL, extensions ecosystem, and how its core concepts map to Oracle and other enterprise databases.',
  category: 'postgresql' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-09'),
  youtubeUrl: null,
  content: `PostgreSQL is one of the most capable open-source relational database management systems available today. With over 35 years of active development, it consistently sits alongside Oracle and SQL Server in capability benchmarks while carrying no licensing cost and a permissive open-source licence. For database professionals coming from an Oracle background, PostgreSQL feels both familiar and refreshingly different.

---

## A Brief History

PostgreSQL traces its lineage to the POSTGRES project at UC Berkeley, started by Michael Stonebraker in 1986. The project pioneered object-relational concepts and extensibility features that were years ahead of commercial databases. The SQL query interface was added in 1994 and the project was renamed PostgreSQL in 1996 to reflect its standard query language support.

The PostgreSQL Global Development Group — an entirely volunteer and corporate-contributor-driven open source community — releases a major version annually. Each major version is supported for five years. As of 2026, PostgreSQL 17 is the current release.

---

## Core Architecture

### Process Model

PostgreSQL uses a **multi-process** architecture rather than a multi-threaded one. Every client connection spawns a dedicated backend process on the server. A central process called the **postmaster** (or \`postgres\` supervisor) listens for incoming connections and forks a new backend for each one.

Key background processes:

| Process | Role |
|---------|------|
| \`postmaster\` | Listener, forks backends, restarts crashed workers |
| \`checkpointer\` | Writes dirty pages from shared buffers to disk at checkpoint intervals |
| \`background writer\` | Proactively flushes dirty pages to reduce checkpoint I/O spikes |
| \`walwriter\` | Flushes the WAL buffer to the WAL segment files on disk |
| \`autovacuum launcher\` | Triggers per-table autovacuum and autoanalyze workers |
| \`stats collector\` | Accumulates query and table-level statistics (folded into postmaster in PG 15+) |
| \`logical replication launcher\` | Manages logical replication worker processes |

This is analogous to Oracle's background process model (DBWn, LGWR, CKPT, SMON, PMON) but each PostgreSQL process is a standalone OS process rather than a thread within a single Oracle instance.

### Memory Architecture

PostgreSQL memory is split between per-process memory and the shared memory segment:

**Shared memory (configured in postgresql.conf):**
- **shared_buffers** — the main buffer cache, analogous to Oracle's Buffer Cache. The rule of thumb is 25% of total RAM, up to 8 GB for dedicated servers.
- **WAL buffers** — in-memory write-ahead log buffer before fsync to disk.
- **lock table** — shared memory structure for lock management.

**Per-process memory:**
- **work_mem** — memory allocated per sort or hash operation within a single query. Multiplied by the number of concurrent sort/hash operations in complex queries — set conservatively.
- **maintenance_work_mem** — memory for VACUUM, CREATE INDEX, and ALTER TABLE operations. Can be set higher than work_mem since these are less frequent.
- **temp_buffers** — per-session buffer for temporary tables.

### Storage Layout

A PostgreSQL installation is organised around a **data directory** (also called \`PGDATA\`). Everything — tables, indexes, WAL, configuration files, and the system catalog — lives under this single directory tree.

\`\`\`
$PGDATA/
├── base/           # one subdirectory per database (by OID)
├── global/         # cluster-wide catalog tables (pg_database, pg_authid)
├── pg_wal/         # write-ahead log segments
├── pg_xact/        # transaction commit status (CLOG)
├── pg_stat_tmp/    # transient statistics files
├── postgresql.conf # main configuration file
├── pg_hba.conf     # client authentication rules
└── pg_ident.conf   # OS username → PostgreSQL role mapping
\`\`\`

Each table and index is stored as one or more **relation files**, named by their OID. A table larger than 1 GB is split into 1 GB segments automatically (configurable at compile time).

---

## MVCC: The Concurrency Engine

PostgreSQL's concurrency model is **Multi-Version Concurrency Control (MVCC)**. Rather than locking rows for reads, PostgreSQL maintains multiple versions of each row. Readers never block writers and writers never block readers.

Each row carries two hidden system columns:
- **xmin** — the transaction ID of the transaction that inserted this row version
- **xmax** — the transaction ID of the transaction that deleted or updated this row version (0 if still live)

When a query runs, PostgreSQL computes a **snapshot** — the set of transaction IDs that were committed at the moment the query (or transaction) started. A row is visible to a query if its \`xmin\` is committed and in the snapshot, and its \`xmax\` is either 0 or not yet committed relative to the snapshot.

This means an \`UPDATE\` in PostgreSQL does not modify the row in place. It writes a **new row version** with the new data and marks the old version as deleted by setting \`xmax\`. Old row versions accumulate until **VACUUM** reclaims them.

### VACUUM and Autovacuum

Because old row versions accumulate, PostgreSQL requires periodic vacuuming to:
1. Reclaim dead tuple storage for reuse
2. Update the visibility map (used by index-only scans)
3. Prevent **transaction ID wraparound** — a 32-bit XID counter that must not overflow

In production, **autovacuum** handles this automatically based on a per-table threshold (configurable via \`autovacuum_vacuum_scale_factor\`, \`autovacuum_vacuum_threshold\`, etc.). For high-churn tables, tuning autovacuum aggressiveness is one of the most important PostgreSQL performance tasks.

---

## Write-Ahead Logging (WAL)

PostgreSQL's WAL is conceptually identical to Oracle's redo log. Before any change is written to a data file, the change record is written to the WAL. This guarantees durability (a committed transaction's WAL is always flushed to disk before the commit returns to the client) and is the foundation of both crash recovery and replication.

WAL is stored in \`$PGDATA/pg_wal/\` as a sequence of 16 MB segment files (configurable). The position within WAL is tracked by a **Log Sequence Number (LSN)** — analogous to Oracle's SCN.

Key WAL configuration parameters:

| Parameter | Default | Purpose |
|-----------|---------|---------|
| \`wal_level\` | \`replica\` | \`minimal\`, \`replica\`, or \`logical\` — determines what is written to WAL |
| \`synchronous_commit\` | \`on\` | Whether commit waits for WAL flush. \`off\` risks data loss of last ~1 commit on crash but improves throughput |
| \`wal_buffers\` | \`-1\` (auto) | Size of the WAL buffer in shared memory |
| \`checkpoint_timeout\` | \`5min\` | Maximum time between automatic checkpoints |
| \`max_wal_size\` | \`1GB\` | Soft limit on WAL size before triggering a checkpoint |

---

## Replication

PostgreSQL supports both physical and logical replication out of the box.

**Physical (streaming) replication** ships WAL byte-for-byte from a primary to one or more standbys. Standbys can be:
- **Hot standby** — read-only queries allowed while replaying WAL (the standard HA configuration)
- **Warm standby** — WAL is applied but no queries are accepted

**Logical replication** decodes WAL into a row-change stream and ships it to subscribers. Unlike physical replication, logical replication can replicate individual tables, replicate to a different PostgreSQL major version, or replicate to non-PostgreSQL targets. It is the basis for tools like pglogical and Debezium's PostgreSQL connector.

---

## The Extensions Ecosystem

PostgreSQL's most distinctive architectural feature is its extensibility. The \`CREATE EXTENSION\` command installs modules that integrate as first-class database objects — not just stored procedures but custom data types, index types, operators, and background workers.

Notable extensions:

| Extension | Purpose |
|-----------|---------|
| \`pg_stat_statements\` | Per-query execution statistics — essential for performance tuning |
| \`PostGIS\` | Full spatial database capabilities (geometry, geography, rasters) |
| \`TimescaleDB\` | Time-series data management with automated partitioning and compression |
| \`pgvector\` | Vector similarity search — used for AI embedding workloads |
| \`pg_partman\` | Automated partition management for time and serial range partitions |
| \`pg_cron\` | In-database job scheduler (analogous to DBMS_SCHEDULER) |
| \`uuid-ossp\` / \`pgcrypto\` | UUID generation and cryptographic functions |
| \`postgres_fdw\` | Foreign Data Wrapper — query remote PostgreSQL databases as local tables |
| \`oracle_fdw\` | Foreign Data Wrapper — query Oracle databases from PostgreSQL |

---

## Key Features at a Glance

**JSON and JSONB:** PostgreSQL has first-class support for semi-structured data. \`JSONB\` stores JSON in a parsed binary format with full indexing support (GIN indexes on any key path). Functions like \`jsonb_path_query\` provide XPath-style navigation over JSON documents.

**Table partitioning:** Declarative partitioning (range, list, hash) was significantly improved in PostgreSQL 10 and 12. Partitioned tables behave transparently to queries, with partition pruning handled by the planner.

**Row-level security (RLS):** Policies can be attached to tables to restrict which rows a given role can see or modify, enabling multi-tenant data isolation entirely within the database without application-level filtering.

**Full-text search:** Built-in \`tsvector\` / \`tsquery\` types and GIN indexes provide ranked full-text search without an external search engine.

**Advanced indexing:** B-tree (default), Hash, GiST (geometric and range types), SP-GiST, GIN (full-text and JSONB), and BRIN (block range — very efficient for naturally ordered data like time-series).

---

## Mapping Oracle Concepts to PostgreSQL

For DBAs migrating from Oracle, these equivalences help build the mental model quickly:

| Oracle | PostgreSQL | Notes |
|--------|-----------|-------|
| Instance + Database | Cluster | A PostgreSQL cluster is one \`PGDATA\` directory serving multiple databases |
| Tablespace | Tablespace | Similar concept — a directory path; most setups use the default \`pg_default\` |
| Schema | Schema | PostgreSQL has true schemas (namespaces) within each database |
| Redo Log | WAL (pg_wal) | Write-ahead log, same durability purpose |
| SCN | LSN (Log Sequence Number) | 64-bit position in the WAL stream |
| SYSDATE | \`now()\` / \`CURRENT_TIMESTAMP\` | |
| DUAL | Not needed | \`SELECT 1;\` works without a FROM clause |
| Sequences | Sequences | Syntax differs: \`CREATE SEQUENCE\`, \`nextval('seq')\` |
| DBMS_SCHEDULER | \`pg_cron\` extension | |
| AWR / ASH | \`pg_stat_statements\`, \`pg_stat_activity\` | |
| EXPLAIN PLAN | \`EXPLAIN ANALYZE\` | PostgreSQL's \`EXPLAIN ANALYZE\` actually executes and shows real row counts |
| Flashback | No native equivalent | Point-in-time recovery via PITR (WAL-based) |
| Data Guard | Streaming replication | Physical standby with hot standby queries |
| Golden Gate | pglogical, Debezium | Logical replication for heterogeneous CDC |

---

## Administration Tooling

**psql** — the standard command-line client. Far more capable than SQL*Plus, with tab completion, \`\\d\` meta-commands for schema exploration, and pipe-friendly output modes.

**pg_dump / pg_restore** — logical backup and restore, analogous to Oracle's Data Pump. Supports custom (compressed), directory, and plain SQL formats.

**pg_basebackup** — physical backup of the entire cluster, equivalent to RMAN's backup. Used as the starting point for creating streaming replication standbys.

**pgAdmin 4** — the primary GUI administration tool, available as a desktop application or web server.

**Patroni** — the most widely used high-availability framework for PostgreSQL, managing automatic failover and switchover for streaming replication clusters.

---

## When to Choose PostgreSQL

PostgreSQL is a strong fit for:
- New application development where Oracle licensing cost is a concern
- Workloads that benefit from the extensions ecosystem (geospatial, time-series, vector search)
- Environments requiring logical replication to heterogeneous targets
- Cloud-native deployments (every major cloud offers a managed PostgreSQL service)
- Oracle migration projects — PostgreSQL is the most common migration target for Oracle workloads

The companion runbook for this overview covers the complete PostgreSQL installation and initial configuration procedure on RHEL/OEL and Ubuntu Linux.`,
};

async function main() {
  console.log('Inserting PostgreSQL overview post...');
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
