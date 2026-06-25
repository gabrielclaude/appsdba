import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Data Pump: Architecture, Export Modes, and What Every DBA Needs to Know',
  slug: 'oracle-data-pump-expdp-impdp-guide',
  excerpt:
    'A technical deep-dive into Oracle Data Pump — how the master process, worker processes, and shadow processes coordinate to export and import data, the five export modes and when to use each, compression and encryption options, network mode imports without dump files, filtering and remapping during import, performance tuning with PARALLEL, and the failure modes most likely to catch a DBA off guard.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-24'),
  youtubeUrl: null,
  content: `## Overview

Oracle Data Pump, introduced in Oracle 10g, replaced the original \`exp\` and \`imp\` utilities and is now the standard mechanism for logical backup, schema migration, database cloning, and data subsetting in Oracle Database. The original utilities are still present in recent Oracle releases but are unsupported for new features — Data Pump is the correct tool for any serious data movement operation.

The performance difference between original export and Data Pump is significant for large datasets. Data Pump uses direct path reads, parallel worker processes, and server-side processing (the dump file I/O happens on the database server, not the client), making it typically 10–50× faster than original export for large schemas. Understanding how Data Pump works architecturally explains both its performance characteristics and why certain failure modes occur in ways that are not obvious from the command output.

---

## Architecture

Data Pump is a server-side operation. Unlike original \`exp\`, which ran entirely on the client machine and streamed data over SQL\*Net, Data Pump runs inside the Oracle database server. The client-side \`expdp\` and \`impdp\` commands are thin control programs — they instruct the database to start a Data Pump job, then attach to that job to display progress.

The server-side architecture:

**Master Process (DM\`nn\`)**: one per Data Pump job. Manages the overall job lifecycle, coordinates worker processes, writes the master table (a staging table in the user's schema during the job), and handles job restart and recovery. The master process is a single Oracle server process.

**Worker Processes (DW\`nn\`)**: one or more per job, controlled by the PARALLEL parameter. Each worker process handles a specific unit of work — exporting a table, loading a LOB segment, processing a partition. Workers read and write through direct path where possible, bypassing the buffer cache for full table scans, which is why Data Pump is faster than conventional export for large tables.

**Shadow Process**: one per connected client session. Handles the communication between the client-side \`expdp\`/\`impdp\` command and the server-side master process.

Because the job runs on the server, the client can be disconnected and the job continues. Reconnecting with \`expdp attach=job_name\` reattaches the client to the running job. This is architecturally different from original \`exp\`, where killing the client process killed the export.

The dump files are written to (or read from) a **directory object** — a server-side pointer to a filesystem path on the database server. The Oracle process user must have OS-level read/write access to that directory. This is also why the dump file path in the \`expdp\` command is specified by directory object name, not a filesystem path.

---

## Export Modes

Data Pump supports five export modes, selected by the parameter used:

### FULL

Exports the entire database: all schemas, all objects, the system configuration, and all data. Required parameters:

\`\`\`
FULL=Y
\`\`\`

FULL mode exports everything except the SYS and SYSTEM schemas (those are excluded by default). Full exports are used for:
- Complete database migrations to new hardware or new Oracle versions
- Full logical backups as a complement to RMAN physical backups
- Database cloning when the entire instance needs to be reproduced

Full export is the only mode that can be used with \`TRANSPORTABLE=ALWAYS\` for a full transportable export (full transportable export/import, available from Oracle 12c).

### SCHEMA

Exports one or more named schemas. The default mode when FULL, TABLES, or TABLESPACES is not specified. Most common mode for application migrations.

\`\`\`
SCHEMAS=APP_OWNER,APP_REPORTING
\`\`\`

When exporting multiple schemas that have object dependencies between them (foreign keys, views referencing objects in the other schema, synonyms), both schemas must be exported in the same Data Pump job — not separately — so the master table tracks dependencies correctly.

### TABLE

Exports specific named tables (and their associated indexes, constraints, grants, and statistics).

\`\`\`
TABLES=APP_OWNER.ORDERS,APP_OWNER.ORDER_LINES
\`\`\`

TABLE mode exports the table metadata and data only — it does not export sequences, procedures, or other schema-level objects. Use this mode for data extraction, table-level refresh, or exporting a subset of a schema.

### TABLESPACE

Exports all objects residing in specified tablespaces.

\`\`\`
TABLESPACES=APP_DATA,APP_IDX
\`\`\`

Objects that span multiple tablespaces (a table in APP_DATA with an index in APP_IDX) are exported completely when any of their tablespaces are specified.

### TRANSPORTABLE TABLESPACE

A special mode that exports only the metadata for a set of tablespaces. The data itself is transported by copying the datafiles directly (the tablespace must be made read-only before the export, and the datafiles are copied while it remains read-only). This produces the fastest possible migration for large tablespaces because the tablespace content is not re-read row by row — the datafiles are physically copied.

\`\`\`
TRANSPORT_TABLESPACES=APP_DATA
TRANSPORT_FULL_CHECK=Y
\`\`\`

Transportable tablespace requires both the source and destination databases to be the same endian format (both Linux x86-64, for example). Cross-endian transportable tablespace requires RMAN conversion.

---

## Directory Objects

Every Data Pump job requires a directory object. The directory object is a server-side database object that maps a name to a filesystem path:

\`\`\`sql
CREATE DIRECTORY dp_dir AS '/u01/datapump';
GRANT READ, WRITE ON DIRECTORY dp_dir TO app_owner;
\`\`\`

The Oracle database process user (typically \`oracle\`) must have OS-level read/write access to the underlying path. The GRANT on the directory controls which database users can use it in Data Pump jobs.

One predefined directory exists in every Oracle database: \`DATA_PUMP_DIR\`, which points to \`$ORACLE_BASE/admin/$DB_UNIQUE_NAME/dpdump/\`. This directory is usable without any setup, but for production jobs it is better practice to create a dedicated directory on a filesystem with adequate space.

**File size planning**: always estimate before exporting. Use \`ESTIMATE_ONLY=Y\` to get the export size estimate without writing any data, then provision sufficient space. A FULL export of a production database without adequate space planning is a common cause of failed exports that leave partial dump files.

---

## Filtering: INCLUDE, EXCLUDE, QUERY, and CONTENT

Data Pump's filtering capabilities make it possible to export precise subsets of data and metadata.

### INCLUDE and EXCLUDE

Select which object types are included or excluded from the export:

\`\`\`
EXCLUDE=INDEX              -- export everything except indexes
EXCLUDE=STATISTICS         -- skip optimizer statistics (they are regenerated post-import)
INCLUDE=TABLE:"IN ('ORDERS','ORDER_LINES','CUSTOMERS')"  -- only these tables
\`\`\`

INCLUDE and EXCLUDE cannot be combined in the same job — use one or the other.

Commonly excluded for performance:
- \`STATISTICS\` — statistics are recollected post-import; exporting and importing them is slow and often produces stale stats anyway
- \`INDEX\` — rebuild indexes post-import in parallel, often faster than importing them through Data Pump
- \`GRANT\` — if re-grants are handled separately in the target

### QUERY

Applies a WHERE clause to limit which rows are exported for a specific table:

\`\`\`
QUERY=APP_OWNER.ORDERS:"WHERE ORDER_DATE >= DATE '2025-01-01'"
\`\`\`

QUERY is the correct mechanism for data subsetting — exporting a date range, exporting records for a specific region, or extracting test data from production.

### CONTENT

Controls whether metadata, data, or both are exported:

\`\`\`
CONTENT=DATA_ONLY        -- rows only, no DDL
CONTENT=METADATA_ONLY    -- DDL only, no rows
CONTENT=ALL              -- default: both
\`\`\`

\`METADATA_ONLY\` exports are used to generate DDL scripts for schema documentation or to pre-create objects before a data-only import.

---

## Remapping During Import

Import's remapping parameters are among the most useful Data Pump features. They allow the import to redirect objects to different schemas, tablespaces, or datafile locations without modifying the dump file.

### REMAP_SCHEMA

Imports all objects from the source schema into a different target schema:

\`\`\`
REMAP_SCHEMA=PROD_APP:UAT_APP
\`\`\`

The target schema must already exist (or will be created by the import if schema creation is included in the dump).

### REMAP_TABLESPACE

Redirects all objects from one tablespace to another during import:

\`\`\`
REMAP_TABLESPACE=APP_DATA:APP_DATA_NEW
REMAP_TABLESPACE=APP_IDX:APP_IDX_NEW
\`\`\`

Used when the target database has different tablespace names, or when cloning a schema into the same database under a different tablespace.

### REMAP_DATAFILE

For transportable tablespace imports, redirects datafile path references from the source path to the target path:

\`\`\`
REMAP_DATAFILE='/u01/oradata/prod/app_data01.dbf':'/u02/oradata/clone/app_data01.dbf'
\`\`\`

### TRANSFORM

Removes or modifies storage attributes during import — useful when importing into a target with different storage configuration:

\`\`\`
TRANSFORM=SEGMENT_ATTRIBUTES:N         -- removes all storage, tablespace, logging clauses
TRANSFORM=STORAGE:N:TABLE              -- removes storage clauses for tables only
TRANSFORM=OID:N                        -- generates new OIDs for types (avoids OID conflicts)
\`\`\`

\`TRANSFORM=SEGMENT_ATTRIBUTES:N\` is the most commonly used option in cross-environment migrations — it drops all storage clauses from the import DDL and lets the target database apply its own defaults, avoiding failures caused by missing tablespace names or incompatible storage specifications.

---

## TABLE_EXISTS_ACTION

Controls what happens when an import encounters a table that already exists in the target schema:

| Value | Behaviour |
|-------|-----------|
| SKIP | Skip the table entirely (default) |
| APPEND | Load rows into the existing table without truncating |
| TRUNCATE | Truncate the existing table before loading |
| REPLACE | Drop and recreate the table, then load |

\`APPEND\` is used for incremental loads — adding new rows to an existing table without disturbing existing data. Be aware: APPEND does not check for duplicate rows; if the data being imported overlaps with existing rows on a primary key, the import will error on constraint violations unless \`DATA_OPTIONS=SKIP_CONSTRAINT_ERRORS\` is also specified.

---

## Network Mode

Network mode imports directly from a source database via a database link, without creating a dump file. This eliminates the dump file I/O entirely and is often the fastest method for schema cloning across databases on the same network:

\`\`\`
impdp system/password \\
  NETWORK_LINK=source_db_link \\
  SCHEMAS=APP_OWNER \\
  REMAP_SCHEMA=APP_OWNER:APP_OWNER_CLONE \\
  PARALLEL=4 \\
  LOGFILE=dp_dir:network_import.log
\`\`\`

The database link must exist in the target database, and the database link user must have \`EXP_FULL_DATABASE\` privilege in the source. No disk space is consumed for dump files — data streams directly from source to target through the link.

Network mode is the preferred approach for:
- Refreshing a clone environment from production without a staging filesystem
- Migrating schemas between databases on the same network
- Importing subsets using QUERY without producing a full export dump

---

## Compression and Encryption

**Compression** (requires Advanced Compression licence):

\`\`\`
COMPRESSION=ALL            -- compress both data and metadata
COMPRESSION=DATA_ONLY      -- compress only data (most impactful for size)
COMPRESSION=METADATA_ONLY  -- compress only metadata (always available)
COMPRESSION=NONE           -- no compression (default)
\`\`\`

For large exports, \`COMPRESSION=DATA_ONLY\` typically reduces dump file size by 60–80% for conventional OLTP data, at the cost of additional CPU on the database server during export.

**Encryption** (requires Advanced Security Option):

\`\`\`
ENCRYPTION=ALL
ENCRYPTION_PASSWORD=strong_passphrase
ENCRYPTION_ALGORITHM=AES256
\`\`\`

Encrypted dump files require the password to import. If the password is lost, the dump file is unrecoverable. Store encryption passwords in a password vault, not in the \`expdp\` command line (where it appears in process listings).

---

## PARALLEL and Performance

The PARALLEL parameter controls the number of worker processes. For large exports or imports, PARALLEL is the primary performance lever:

\`\`\`
PARALLEL=8
DUMPFILE=dp_dir:schema_%U.dmp  -- %U creates numbered files: schema_01.dmp, schema_02.dmp...
\`\`\`

The \`%U\` substitution in DUMPFILE is required when PARALLEL > 1 — each worker writes to its own file. If PARALLEL=4 but only one DUMPFILE is specified, Data Pump silently falls back to PARALLEL=1.

**Effective PARALLEL guidelines**:
- PARALLEL should not exceed the number of CPU cores available on the database server
- For imports, PARALLEL should not exceed the number of datafiles in the target tablespace (I/O is the bottleneck, and more workers than datafiles do not help)
- In a RAC environment, use \`CLUSTER=N\` to restrict the job to a single node — cross-node Data Pump jobs write dump files to different nodes, complicating the import

---

## Job Management and Monitoring

### Interactive Mode

Pressing Ctrl+C during a running \`expdp\` or \`impdp\` job drops the client into interactive mode without stopping the job:

\`\`\`
Export> STATUS           -- display current job status and progress
Export> STATUS=60        -- display status every 60 seconds
Export> PARALLEL=8       -- increase workers on a running job
Export> ADD_FILE=dp_dir:schema_05.dmp  -- add a dump file to an export in progress
Export> STOP_JOB=IMMEDIATE  -- stop the job cleanly (job state saved, can be restarted)
Export> KILL_JOB         -- kill the job and discard state
Export> CONTINUE_CLIENT  -- reattach output to the running job
\`\`\`

### Attaching to a Running Job

If the \`expdp\` client session is killed (SSH disconnect, terminal close), the job continues on the server. Reattach with:

\`\`\`bash
expdp system/password ATTACH=job_name
\`\`\`

The job name is visible in the log file header or via:

\`\`\`sql
SELECT JOB_NAME, STATE, DEGREE, JOB_MODE FROM DBA_DATAPUMP_JOBS;
\`\`\`

### Progress Monitoring via V$ Views

\`\`\`sql
-- Active Data Pump jobs and their state
SELECT JOB_NAME, STATE, DEGREE, JOB_MODE, ATTACHED_SESSIONS
FROM DBA_DATAPUMP_JOBS
WHERE STATE != 'NOT RUNNING';

-- Progress of objects being processed
SELECT SID, SERIAL#, OPNAME, SOFAR, TOTALWORK,
       ROUND(SOFAR/NULLIF(TOTALWORK,0)*100, 1) AS PCT_DONE,
       ELAPSED_SECONDS, TIME_REMAINING
FROM V\$SESSION_LONGOPS
WHERE OPNAME LIKE '%Data Pump%'
  AND TOTALWORK > 0
ORDER BY ELAPSED_SECONDS DESC;
\`\`\`

---

## VERSION Parameter for Cross-Version Migration

When exporting from a newer Oracle version to import into an older version, the VERSION parameter instructs Data Pump to generate metadata compatible with the target version:

\`\`\`
VERSION=19             -- generate metadata compatible with Oracle 19c
VERSION=COMPATIBLE     -- use the DB COMPATIBLE parameter setting
VERSION=LATEST         -- default: current database version
\`\`\`

Without VERSION, exporting from Oracle 21c and attempting to import into Oracle 19c will fail on metadata that uses 21c-specific syntax. VERSION=19 downgrades the DDL generation to 19c-compatible syntax.

---

## Common Failure Modes

**ORA-39070 / ORA-39001: directory object issues**: the directory object does not exist, the Oracle process user lacks OS write permission to the path, or the filesystem is full. Always verify the directory object path exists and is writable by the oracle OS user before starting a large export.

**ORA-31693 / ORA-02354: data object failed to load**: a constraint violation (NOT NULL, unique, foreign key) during import. Use \`DATA_OPTIONS=SKIP_CONSTRAINT_ERRORS\` to continue and identify violations, then fix data before re-running without the skip option.

**ORA-01555: snapshot too old**: during a long-running export, undo for the read-consistent snapshot of a table has been overwritten. Resolution: increase UNDO_RETENTION, schedule exports during low-DML periods, or use \`FLASHBACK_TIME\` to set the export SCN before the job starts.

**Job hangs with "resumable wait"**: the export or import encountered a space error (tablespace full, datafile maximum extent reached) but RESUMABLE=Y is set, so instead of erroring it waits. Extend the tablespace while the job waits; it will resume automatically.

**ORA-39171: job is experiencing a resumable wait**: the import is waiting for space. Check \`DBA_RESUMABLE\` for the wait reason, extend the relevant tablespace, and the job resumes without intervention.

**Workers fewer than PARALLEL**: if dump files are on a filesystem without space for additional files, or the DUMPFILE specification does not include \`%U\`, workers silently reduce to 1. Monitor \`V\$SESSION_LONGOPS\` to confirm the actual degree of parallelism.

---

## Summary

Oracle Data Pump is a server-side parallel data movement utility built on direct-path I/O and coordinated worker processes. Its five export modes (FULL, SCHEMA, TABLE, TABLESPACE, TRANSPORTABLE TABLESPACE) cover every use case from full database migration to targeted row-level extraction. Directory objects are the mandatory prerequisite — the dump file path must be a database object pointing to a server-side filesystem location writable by the Oracle process user. Import-time remapping (REMAP_SCHEMA, REMAP_TABLESPACE, TRANSFORM) makes cross-environment migration possible without modifying the dump file. Network mode eliminates dump files entirely for direct database-to-database migration over a database link. PARALLEL with \`%U\` file substitution is the primary performance lever for large jobs, but effective parallelism is bounded by available CPUs and target tablespace datafile count. The companion runbook covers the complete procedure for each export mode, parameter file best practices, monitoring and job management commands, cross-version migration, and the diagnostic scripts for identifying stuck or slow Data Pump jobs.`,
};

async function main() {
  console.log('Inserting Oracle Data Pump blog post...');
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
