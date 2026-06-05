import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Data Pump: expdp/impdp Architecture, Modes, and Advanced Features',
  slug: 'oracle-datapump-expdp-impdp-architecture',
  excerpt:
    'A comprehensive guide to Oracle Data Pump — server-side architecture with master and worker processes, directory objects, all five export/import modes, INCLUDE/EXCLUDE filtering, QUERY row filtering, PARALLEL execution, COMPRESSION and ENCRYPTION options, FLASHBACK-consistent exports, network mode, TRANSFORM parameter, interactive job control, and diagnostics for the most common Data Pump errors.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-05'),
  youtubeUrl: null,
  content: `Oracle Data Pump (expdp/impdp) replaced the original exp/imp utilities starting in Oracle 10g. The architecture is fundamentally different: all processing runs inside the database as Oracle server processes, not on the client host. Understanding this model is the key to using Data Pump effectively and diagnosing problems when they arise.

---

## 1. Architecture

### How Data Pump differs from original exp/imp

The original \`exp\` and \`imp\` utilities ran as client-side processes. They connected to the database, read data across the network, and wrote dumpfiles locally on the machine where the command was issued. This meant export speed was limited by SQL*Net throughput, and the DBA had to be on the database server (or mount a remote filesystem) to write dumpfiles to server-local disk.

Data Pump inverts this model. When you run \`expdp\`, you are launching a thin client that sends a request to the database. The actual export work is done by Oracle server processes — the MCP (Master Control Process) and WRK (worker processes) — running inside the database. The dumpfile is written by the server, not the client. The client just displays status and waits for completion.

### Server-side process model

\`\`\`sql
-- View running Data Pump processes during an export
SELECT program, spid, pname, username
FROM v\$process
WHERE program LIKE '%DM%'    -- DM = Data Pump master (MCP)
   OR program LIKE '%DW%';   -- DW = Data Pump worker (WRK)
\`\`\`

- **MCP (Master Control Process)**: One per job. Coordinates the entire operation, writes the master table, manages the control queue. Named DM\${nn} in the process list.
- **WRK (Worker Processes)**: One or more per job depending on PARALLEL setting. Do the actual data read/write. Named DW\${nn}.
- **Shadow Process**: A short-lived server process that handles the initial client connection and spawns the MCP.

The **control queue** and **status table** are maintained in SYS-owned objects. When a job starts, Oracle creates a master table in the schema of the user running the export (e.g., \`SYS_EXPORT_SCHEMA_01\`). This table tracks the job state, objects processed, and restart information. It is dropped on successful completion but remains on failure — which is how interrupted jobs can be restarted.

\`\`\`sql
-- Find master tables for active or orphaned Data Pump jobs
SELECT owner, table_name, created
FROM dba_tables
WHERE table_name LIKE 'SYS_EXPORT_%'
   OR table_name LIKE 'SYS_IMPORT_%'
ORDER BY created DESC;
\`\`\`

### Directory objects as the only I/O path

Data Pump does not write to arbitrary filesystem paths. Every dumpfile and logfile path must be specified as an Oracle directory object. This is a deliberate security boundary — the DBA controls exactly which OS paths the database is permitted to write to, and users need explicit GRANT READ/WRITE on the directory to use it.

### Dumpfile format

Data Pump dumpfiles are proprietary binary files, not SQL scripts. They cannot be viewed with a text editor or replayed manually. An impdp job reads the binary format natively. The only way to get SQL DDL out of a dumpfile is \`impdp SQLFILE=...\` which writes the DDL statements to a file without executing them.

### Network mode

When \`NETWORK_LINK\` is specified, Data Pump reads directly from the remote database over a database link and writes into the local database. No dumpfile is created at all. This is covered in detail in Section 11.

---

## 2. Directory Objects

Directory objects are the only way Data Pump can locate files. The path must exist on the operating system of the database server (not the client), and the Oracle OS user (\`oracle\`) must have read and write permission on that directory.

### Creating and granting a directory

\`\`\`sql
-- Create the directory object (must be run as DBA)
CREATE OR REPLACE DIRECTORY datapump_dir AS '/u01/datapump/exports';

-- Grant read and write to the exporting/importing user
GRANT READ, WRITE ON DIRECTORY datapump_dir TO myapp_dba;

-- Verify the directory object exists
SELECT directory_name, directory_path
FROM dba_directories
WHERE directory_name = 'DATAPUMP_DIR';
\`\`\`

### OS-level permissions

Even after creating the directory object, the OS path must be accessible. The Oracle OS user (typically \`oracle\`) must own or have rwx on the directory. A common mistake is creating the directory object pointing to a path that does not exist on the DB server, or that is owned by root with no Oracle access:

\`\`\`bash
# On the DB server OS — create the path and set permissions
mkdir -p /u01/datapump/exports
chown oracle:oinstall /u01/datapump/exports
chmod 750 /u01/datapump/exports
\`\`\`

If the Oracle process cannot write to the directory, you will see ORA-39002 / ORA-39070 at job start.

---

## 3. Export Modes

Data Pump supports five export modes, controlled by the \`FULL\`, \`SCHEMAS\`, \`TABLES\`, \`TABLESPACE\`, or \`TRANSPORT_TABLESPACES\` parameter.

### FULL export

Exports the entire database — all schemas, objects, and data, plus the database-level metadata (tablespaces, profiles, roles, system grants).

\`\`\`bash
expdp system/password@mydb \\
  FULL=Y \\
  DIRECTORY=datapump_dir \\
  DUMPFILE=full_%U.dmp \\
  LOGFILE=full_export.log \\
  PARALLEL=4
\`\`\`

Requires the \`EXP_FULL_DATABASE\` role. Includes SYS-owned objects (selectively) and pluggable database metadata in CDB environments.

### SCHEMAS export

Exports one or more complete schemas: all tables, indexes, sequences, procedures, views, grants, and data owned by those schemas.

\`\`\`bash
expdp myapp_dba/password@mydb \\
  SCHEMAS=MYAPP,MYAPP_AUDIT \\
  DIRECTORY=datapump_dir \\
  DUMPFILE=schemas_%U.dmp \\
  LOGFILE=schemas_export.log
\`\`\`

A user can export their own schema without special privileges. Exporting another user's schema requires \`EXP_FULL_DATABASE\`.

### TABLES export

Exports specific tables and their dependent objects (indexes, constraints, triggers, grants on those tables).

\`\`\`bash
expdp myapp_dba/password@mydb \\
  TABLES=MYAPP.ORDERS,MYAPP.ORDER_LINES \\
  DIRECTORY=datapump_dir \\
  DUMPFILE=orders_tables.dmp \\
  LOGFILE=orders_export.log
\`\`\`

### TABLESPACE export

Exports all objects and data whose segments reside in the specified tablespaces. Useful for migrating a specific set of tablespaces.

\`\`\`bash
expdp system/password@mydb \\
  TABLESPACES=MYAPP_DATA,MYAPP_IDX \\
  DIRECTORY=datapump_dir \\
  DUMPFILE=tbsp_export.dmp \\
  LOGFILE=tbsp_export.log
\`\`\`

### TRANSPORTABLE_TABLESPACE export

Used with Transportable Tablespace sets — exports only the metadata (DDL) for the tablespaces. The datafiles themselves are copied separately at the OS level. Requires the tablespace to be read-only during the export:

\`\`\`sql
-- Set tablespace read-only before transport export
ALTER TABLESPACE myapp_data READ ONLY;
\`\`\`

\`\`\`bash
expdp system/password@mydb \\
  TRANSPORT_TABLESPACES=MYAPP_DATA \\
  TRANSPORT_FULL_CHECK=Y \\
  DIRECTORY=datapump_dir \\
  DUMPFILE=tts_export.dmp \\
  LOGFILE=tts_export.log
\`\`\`

After exporting, copy the datafiles to the target and run impdp with \`TRANSPORT_DATAFILES\` to register them.

---

## 4. Import Modes

Import uses the same five mode parameters. Additionally, import-only parameters remap and control how objects land in the target database.

### REMAP_SCHEMA

Redirects all objects from one source schema to a different target schema. Essential for environment cloning.

\`\`\`bash
impdp system/password@targetdb \\
  DUMPFILE=schemas_export.dmp \\
  DIRECTORY=datapump_dir \\
  REMAP_SCHEMA=MYAPP:MYAPP_TEST \\
  LOGFILE=import_remap.log
\`\`\`

### REMAP_TABLESPACE

Redirects segments from one tablespace to another. Use when the target database does not have the same tablespace names as the source.

\`\`\`bash
impdp system/password@targetdb \\
  DUMPFILE=schemas_export.dmp \\
  DIRECTORY=datapump_dir \\
  REMAP_SCHEMA=MYAPP:MYAPP_TEST \\
  REMAP_TABLESPACE=MYAPP_DATA:USERS \\
  REMAP_TABLESPACE=MYAPP_IDX:USERS \\
  LOGFILE=import_remap.log
\`\`\`

### REMAP_DATAFILE

For Transportable Tablespace imports — maps source datafile paths to target datafile paths when the directory structure differs between environments.

### TABLE_EXISTS_ACTION

Controls behavior when the target table already exists:

| Value | Behavior |
|---|---|
| \`SKIP\` (default) | Skip the table entirely — no data loaded, existing data untouched |
| \`APPEND\` | Add rows to the existing table without removing existing rows |
| \`TRUNCATE\` | Truncate the table first, then load |
| \`REPLACE\` | Drop and recreate the table, then load |

\`\`\`bash
impdp system/password@targetdb \\
  DUMPFILE=schemas_export.dmp \\
  DIRECTORY=datapump_dir \\
  SCHEMAS=MYAPP \\
  TABLE_EXISTS_ACTION=REPLACE \\
  LOGFILE=import_replace.log
\`\`\`

### CONTENT

Controls what is imported:

- \`ALL\` (default) — both metadata (DDL) and data (rows)
- \`DATA_ONLY\` — rows only, no DDL. Objects must already exist in the target.
- \`METADATA_ONLY\` — DDL only, no rows. Useful for creating a schema structure without loading data.

---

## 5. INCLUDE / EXCLUDE Filtering

INCLUDE and EXCLUDE let you filter which object types and specific objects are included in an export or import.

### Syntax

\`\`\`bash
INCLUDE=object_type[:name_clause]
EXCLUDE=object_type[:name_clause]
\`\`\`

The optional name clause is a SQL expression applied to the object name. It must be enclosed in double quotes inside the parameter, which requires careful quoting on the command line. Using a parameter file (.par) avoids shell quoting issues.

### Examples

Exclude statistics (always recommended — regather after import):

\`\`\`bash
EXCLUDE=STATISTICS
\`\`\`

Exclude grants:

\`\`\`bash
EXCLUDE=GRANT
\`\`\`

Include only specific tables:

\`\`\`bash
INCLUDE=TABLE:"IN ('ORDERS','ORDER_LINES','CUSTOMERS')"
\`\`\`

Exclude tables matching a pattern:

\`\`\`bash
EXCLUDE=TABLE:"LIKE 'TMP_%'"
\`\`\`

Exclude indexes (e.g., you want to rebuild them after import for performance):

\`\`\`bash
EXCLUDE=INDEX
\`\`\`

Combining multiple filters in a parameter file:

\`\`\`bash
# datapump_export.par
SCHEMAS=MYAPP
DIRECTORY=datapump_dir
DUMPFILE=myapp_filtered_%U.dmp
LOGFILE=myapp_filtered_export.log
EXCLUDE=STATISTICS
EXCLUDE=AUDIT_OBJ
INCLUDE=TABLE:"NOT LIKE 'TEMP_%'"
PARALLEL=4
\`\`\`

\`\`\`bash
expdp myapp_dba/password@mydb PARFILE=datapump_export.par
\`\`\`

---

## 6. QUERY Parameter — Row Filtering

The \`QUERY\` parameter adds a WHERE clause to filter rows during export. This lets you export a subset of data without pre-creating filtered views.

### Single-table QUERY

\`\`\`bash
expdp myapp_dba/password@mydb \\
  TABLES=MYAPP.ORDERS \\
  QUERY=MYAPP.ORDERS:'"WHERE order_date >= DATE '"'"'2025-01-01'"'"'"' \\
  DIRECTORY=datapump_dir \\
  DUMPFILE=orders_2025.dmp \\
  LOGFILE=orders_2025_export.log
\`\`\`

Using a parameter file to avoid shell quoting complexity:

\`\`\`bash
# orders_export.par
TABLES=MYAPP.ORDERS,MYAPP.ORDER_LINES
QUERY=MYAPP.ORDERS:"WHERE order_date >= DATE '2025-01-01'"
QUERY=MYAPP.ORDER_LINES:"WHERE order_id IN (SELECT order_id FROM myapp.orders WHERE order_date >= DATE '2025-01-01')"
DIRECTORY=datapump_dir
DUMPFILE=orders_2025.dmp
LOGFILE=orders_2025_export.log
\`\`\`

### Limitations

- The WHERE clause cannot reference other tables in TABLES mode in some Oracle versions. For complex filtering, export the full schema and use QUERY only for simple predicates.
- QUERY applies to individual tables. You cannot write a single QUERY that applies to all tables in a SCHEMAS export.
- QUERY is ignored for metadata — it only filters rows.

---

## 7. PARALLEL — Parallel Export and Import

Data Pump can use multiple worker processes to export or import simultaneously. This is controlled by the \`PARALLEL\` parameter.

### How parallel workers divide work

Workers operate at the table or partition level. For a schema export with PARALLEL=4, Oracle assigns up to 4 worker processes, each handling different tables (or partitions of a partitioned table) simultaneously. The MCP coordinates assignments from the control queue.

### Dumpfile wildcard requirement

**PARALLEL > 1 requires multiple dumpfiles.** Workers write to separate dumpfiles concurrently, so you must specify either multiple dumpfile names or use the \`%U\` wildcard, which expands to a two-digit sequence number (01, 02, 03...):

\`\`\`bash
expdp myapp_dba/password@mydb \\
  SCHEMAS=MYAPP \\
  PARALLEL=4 \\
  DIRECTORY=datapump_dir \\
  DUMPFILE=myapp_%U.dmp \\
  LOGFILE=myapp_export.log
\`\`\`

If you specify a single dumpfile without \`%U\` and use PARALLEL > 1, Data Pump will use only one worker (falling back to PARALLEL=1) or error.

### Optimal degree

A common starting point: PARALLEL = number of CPUs / 2. Parallel workers consume CPU, I/O bandwidth, and undo. Going beyond the number of available CPUs or I/O throughput ceiling will not speed up the job and may slow down other workloads.

### Monitoring parallel workers

\`\`\`sql
-- Monitor progress of a running Data Pump job
SELECT sid, serial#, context, sofar, totalwork,
       ROUND(sofar/NULLIF(totalwork,0)*100, 2) AS pct_done,
       time_remaining, message
FROM v\$session_longops
WHERE opname LIKE 'Data Pump%'
  AND totalwork > 0
ORDER BY start_time DESC;

-- Check the current degree and state of a running job
SELECT job_name, state, degree, job_mode, attached_sessions
FROM dba_datapump_jobs
WHERE state != 'NOT RUNNING';
\`\`\`

---

## 8. COMPRESSION

Data Pump can compress dumpfile content to reduce file size at the cost of CPU. Compression is controlled by the \`COMPRESSION\` parameter.

### Compression levels

| Value | What is compressed | Notes |
|---|---|---|
| \`METADATA_ONLY\` | Only DDL metadata | Default in 11g/12c without Advanced Compression license |
| \`ALL\` | Both metadata and data | Requires Advanced Compression option (separately licensed) |
| \`DATA_ONLY\` | Table data only | Requires Advanced Compression option |
| \`NONE\` | Nothing | Uncompressed output |

### COMPRESSION_ALGORITHM

When \`COMPRESSION=ALL\` (or \`DATA_ONLY\`) is licensed, you can select the algorithm:

\`\`\`bash
expdp myapp_dba/password@mydb \\
  SCHEMAS=MYAPP \\
  COMPRESSION=ALL \\
  COMPRESSION_ALGORITHM=MEDIUM \\
  DIRECTORY=datapump_dir \\
  DUMPFILE=myapp_compressed_%U.dmp \\
  LOGFILE=myapp_compressed.log
\`\`\`

- \`BASIC\` — fastest, least compression
- \`LOW\` — light LZO-based compression
- \`MEDIUM\` — balanced (default when COMPRESSION=ALL)
- \`HIGH\` — best compression ratio, highest CPU usage

Practical guidance: \`MEDIUM\` typically achieves 3–5x compression on typical OLTP data with moderate CPU overhead. Use \`HIGH\` only when disk space is severely constrained or network transfer time matters. Always check your license before using \`ALL\` or \`DATA_ONLY\` compression.

---

## 9. ENCRYPTION

Data Pump supports AES encryption of dumpfiles. This is important when dumpfiles will leave the DB server (copied to tape, cloud storage, or a different site) or when regulatory requirements mandate encrypted backups.

### ENCRYPTION_MODE

| Mode | Description |
|---|---|
| \`PASSWORD\` | Encrypted with a password you supply. Requires the same password on import. No dependency on the database wallet. |
| \`TRANSPARENT\` | Uses the database TDE (Transparent Data Encryption) wallet. Password-free but requires the wallet on both source and target. |
| \`DUAL\` | Both password and TDE wallet. Most flexible — can be decrypted with either the password or the wallet. |

### Password-encrypted export

\`\`\`bash
expdp myapp_dba/password@mydb \\
  SCHEMAS=MYAPP \\
  ENCRYPTION=ALL \\
  ENCRYPTION_MODE=PASSWORD \\
  ENCRYPTION_PASSWORD=V@ultP@ss2025 \\
  DIRECTORY=datapump_dir \\
  DUMPFILE=myapp_encrypted.dmp \\
  LOGFILE=myapp_encrypted_export.log
\`\`\`

\`\`\`bash
# Import with the same password
impdp system/password@targetdb \\
  DUMPFILE=myapp_encrypted.dmp \\
  DIRECTORY=datapump_dir \\
  ENCRYPTION_PASSWORD=V@ultP@ss2025 \\
  LOGFILE=myapp_encrypted_import.log
\`\`\`

Omitting \`ENCRYPTION_PASSWORD\` on import of an encrypted file causes an error immediately.

---

## 10. FLASHBACK-Consistent Exports

By default, a Data Pump export is not transactionally consistent across all tables — different tables may be exported at different times during the job, capturing different committed states. For a consistent snapshot, use \`FLASHBACK_TIME\` or \`FLASHBACK_SCN\`.

### FLASHBACK_SCN

Pins the export to an exact System Change Number. All tables are exported as they appeared at that SCN.

\`\`\`sql
-- Capture the current SCN immediately before starting the export
SELECT DBMS_FLASHBACK.GET_SYSTEM_CHANGE_NUMBER AS current_scn FROM dual;
-- Example result: 4892731500
\`\`\`

\`\`\`bash
expdp system/password@mydb \\
  FULL=Y \\
  FLASHBACK_SCN=4892731500 \\
  DIRECTORY=datapump_dir \\
  DUMPFILE=full_consistent_%U.dmp \\
  LOGFILE=full_consistent_export.log \\
  PARALLEL=4
\`\`\`

### FLASHBACK_TIME

Pins the export to a timestamp expression. Oracle converts the timestamp to an SCN internally.

\`\`\`bash
expdp system/password@mydb \\
  SCHEMAS=MYAPP \\
  FLASHBACK_TIME="TO_TIMESTAMP('2026-06-05 02:00:00','YYYY-MM-DD HH24:MI:SS')" \\
  DIRECTORY=datapump_dir \\
  DUMPFILE=myapp_consistent.dmp \\
  LOGFILE=myapp_consistent.log
\`\`\`

### UNDO retention requirement

For flashback-consistent exports to succeed, Oracle must be able to reconstruct the old versions of all rows from the UNDO tablespace. If the export runs for 2 hours and undo is only retained for 30 minutes, some workers will hit ORA-01555 (snapshot too old) when trying to read old row versions.

Before a long flashback export, verify undo retention:

\`\`\`sql
SELECT MAX(maxquerylen) AS longest_query_sec,
       MAX(tuned_undoretention) AS tuned_retention_sec
FROM v\$undostat;

-- Ensure undo retention covers the expected export duration + buffer
ALTER SYSTEM SET undo_retention = 14400 SCOPE=BOTH;  -- 4 hours
\`\`\`

---

## 11. Network Mode (NETWORK_LINK)

Network mode copies objects and data directly from a remote database to the local database over a database link. No dumpfile is written anywhere.

### Use cases

- Live schema migration between databases (no intermediate storage needed)
- Refreshing a test/dev database from production without staging dumpfiles
- Cross-platform or cross-version migrations where transportable tablespaces are not available

### Setting up and using NETWORK_LINK

The database link must exist in the **target** (local) database and point to the source. The expdp/impdp client always connects to the target database.

\`\`\`sql
-- Create the database link in the target DB pointing to the source
CREATE DATABASE LINK prod_link
  CONNECT TO myapp_dba IDENTIFIED BY password
  USING 'PRODDB';

-- Test the link works
SELECT 1 FROM dual@prod_link;
\`\`\`

\`\`\`bash
# Import schema directly from source to target via network link
impdp system/password@targetdb \\
  NETWORK_LINK=prod_link \\
  SCHEMAS=MYAPP \\
  REMAP_SCHEMA=MYAPP:MYAPP_TEST \\
  REMAP_TABLESPACE=MYAPP_DATA:USERS \\
  DIRECTORY=datapump_dir \\
  LOGFILE=network_import.log
\`\`\`

### Limitations

- In Oracle 11g and early 12c, \`PARALLEL\` is not supported with \`NETWORK_LINK\`. Parallel network mode was introduced in later patch sets.
- The DIRECTORY still needs to exist for the logfile, even though no dumpfile is written.
- Network link performance depends on the network bandwidth and latency between source and target databases.

---

## 12. TRANSFORM Parameter

TRANSFORM modifies how DDL is generated during export/import. This is primarily used on import to strip or alter storage attributes that are not appropriate for the target environment.

### Most important TRANSFORM values

**\`SEGMENT_ATTRIBUTES:N\`** — Strips tablespace, storage, and physical attributes from all CREATE statements. This is the most commonly used transform. When importing into an environment with different tablespace names, REMAP_TABLESPACE handles the mapping, but if you want completely clean DDL with no storage clauses at all, use this:

\`\`\`bash
impdp system/password@targetdb \\
  DUMPFILE=myapp.dmp \\
  DIRECTORY=datapump_dir \\
  SCHEMAS=MYAPP \\
  TRANSFORM=SEGMENT_ATTRIBUTES:N \\
  LOGFILE=import_clean.log
\`\`\`

**\`DISABLE_ARCHIVE_LOGGING:Y\`** — Suppresses redo log generation for table loads during import. Dramatically speeds up large imports by avoiding redo for INSERT operations. Data must be recoverable another way (e.g., re-run the import) because these operations are not logged.

\`\`\`bash
impdp system/password@targetdb \\
  DUMPFILE=full_export_%U.dmp \\
  DIRECTORY=datapump_dir \\
  FULL=Y \\
  TRANSFORM=DISABLE_ARCHIVE_LOGGING:Y \\
  LOGFILE=full_import_fast.log
\`\`\`

**\`STORAGE:N\`** — Strips STORAGE clauses specifically (a subset of what SEGMENT_ATTRIBUTES:N does).

**\`OID:N\`** — Suppresses OID (Object Identifier) preservation for object types. Useful when importing object type instances into a database that already has the type defined with a different OID.

**\`LOB_STORAGE:SECUREFILE\`** or **\`LOB_STORAGE:BASICFILE\`** — Controls the LOB storage format for imported LOB columns, overriding what was in the source.

Multiple TRANSFORM clauses can be combined:

\`\`\`bash
TRANSFORM=SEGMENT_ATTRIBUTES:N:TABLE
TRANSFORM=DISABLE_ARCHIVE_LOGGING:Y
\`\`\`

The optional third component (e.g., \`:TABLE\`) scopes the transform to a specific object type.

---

## 13. Interactive Mode

Data Pump jobs run asynchronously. The expdp/impdp client can be detached without stopping the job.

### Detaching without stopping the job

Press **Ctrl-C** during a running expdp or impdp. This drops the client back to the interactive command prompt without killing the job. The job continues running in the database. You will see a prompt like:

\`\`\`
Export>
\`\`\`

Type \`CONTINUE_CLIENT\` to reattach, or \`EXIT_CLIENT\` to disconnect cleanly.

### Reattaching to a running job

\`\`\`bash
# Find the job name from DBA_DATAPUMP_JOBS or from the log
expdp myapp_dba/password@mydb ATTACH=SYS_EXPORT_SCHEMA_01
\`\`\`

\`\`\`bash
# For an import job
impdp system/password@targetdb ATTACH=SYS_IMPORT_FULL_01
\`\`\`

### Interactive commands

Once attached (or after Ctrl-C):

| Command | Effect |
|---|---|
| \`STATUS\` | Show current job progress and worker status |
| \`ADD_FILE=datapump_dir:newfile_%U.dmp\` | Add more dumpfiles to an export job in progress |
| \`PARALLEL=8\` | Increase or decrease the degree of parallelism mid-job |
| \`CONTINUE_CLIENT\` | Re-enter logging mode (scroll output to terminal) |
| \`STOP_JOB\` | Gracefully stop the job after the current worker operations complete. Job can be restarted. |
| \`STOP_JOB=IMMEDIATE\` | Stop the job immediately without waiting for workers to finish. Job can be restarted. |
| \`KILL_JOB\` | Kill the job permanently. Master table is dropped. Job cannot be restarted. |

### STOP_JOB vs KILL_JOB

\`STOP_JOB\` places the job in \`NOT RUNNING\` state but leaves the master table intact. The job can be restarted with \`expdp ATTACH=job_name\` and then \`START_JOB\`. This is the right choice when you need to pause and resume later.

\`KILL_JOB\` drops the master table and terminates all associated processes. Use this only when you want to permanently abandon a job and clean up. After KILL_JOB, the job name is gone and the dumpfile (if partially written) is unusable.

---

## 14. Common Problems and Diagnostics

### ORA-39002 / ORA-39070 — Invalid operation / unable to open log

The most common startup error. Causes:
- The directory path does not exist on the DB server OS
- The Oracle OS user lacks write permission on the directory
- The directory object points to a path on the client machine, not the server

Resolution:
\`\`\`sql
-- Verify the directory exists and is readable
SELECT directory_name, directory_path FROM dba_directories
WHERE directory_name = 'DATAPUMP_DIR';
\`\`\`
\`\`\`bash
# On the DB server
ls -la /u01/datapump/exports
# Must be writable by the oracle OS user
\`\`\`

### ORA-31693 / ORA-02354 — Object load/unload errors

These indicate that a specific object could not be exported or imported. Common causes:
- Invalid or broken objects in the source schema (invalid views, broken PL/SQL)
- VPD (Virtual Private Database) policies preventing full data access
- The object has been dropped between export start and the worker reaching it

Check the log for which object caused the error and investigate that object specifically.

### ORA-39126 — Worker unexpected fatal error

Usually indicates a corrupt object, a dictionary inconsistency, or an Oracle bug. Check My Oracle Support with the ORA-39126 and the accompanying error for the specific version.

### Job hung in NOT RUNNING state

If a job appears in \`DBA_DATAPUMP_JOBS\` with state \`NOT RUNNING\` but has no attached client and was not intentionally stopped, it may be orphaned. This happens when the database was bounced during an export, or a network disconnect left the job without a controller.

\`\`\`sql
-- Find orphaned jobs
SELECT owner_name, job_name, state, degree, attached_sessions
FROM dba_datapump_jobs
ORDER BY owner_name, job_name;

-- Find the master table
SELECT owner, table_name FROM dba_tables
WHERE table_name LIKE 'SYS_EXPORT_SCHEMA_%'
   OR table_name LIKE 'SYS_EXPORT_FULL_%'
   OR table_name LIKE 'SYS_IMPORT_%';
\`\`\`

To clean up an orphaned job:
\`\`\`bash
# Try to attach and kill cleanly
expdp / as sysdba ATTACH=SYS_EXPORT_SCHEMA_01
# At the prompt:
# KILL_JOB
\`\`\`

If the job cannot be attached:
\`\`\`sql
-- Drop the master table directly (as the job owner or SYS)
DROP TABLE sys.sys_export_schema_01;
\`\`\`
\`\`\`bash
# Kill any remaining OS worker processes
ps -ef | grep ora_dw
# Kill processes that belong to this job (use OS kill -9 as oracle user)
\`\`\`

### Import failing — tablespace not found

If the target database does not have the same tablespace names as the source, use REMAP_TABLESPACE:

\`\`\`bash
impdp system/password@targetdb \\
  DUMPFILE=myapp.dmp \\
  DIRECTORY=datapump_dir \\
  REMAP_TABLESPACE=MYAPP_DATA:USERS \\
  REMAP_TABLESPACE=MYAPP_IDX:INDX \\
  LOGFILE=import_remap.log
\`\`\`

### Statistics not imported

By default, Data Pump imports optimizer statistics from the dumpfile. This is usually not what you want in a target environment — statistics gathered on a 500GB production schema may be misleading in a 10GB dev/test clone. Best practice:

\`\`\`bash
# Exclude statistics on import, regather after loading data
impdp system/password@targetdb \\
  DUMPFILE=myapp.dmp \\
  DIRECTORY=datapump_dir \\
  EXCLUDE=STATISTICS \\
  LOGFILE=import_no_stats.log
\`\`\`

\`\`\`sql
-- After import completes, regather statistics
BEGIN
  DBMS_STATS.GATHER_SCHEMA_STATS(
    ownname          => 'MYAPP',
    estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,
    cascade          => TRUE,
    degree           => 4
  );
END;
/
\`\`\`

### Direct path vs external table access method

Data Pump uses direct path for most table exports by default. However, certain table types force the slower "external table" access method:
- Tables with Virtual Private Database (VPD) / Fine Grained Access Control policies
- Clustered tables
- Tables with active Fine Grained Auditing
- Tables with encrypted columns (sometimes)

External table method is slower because it goes through the SQL engine rather than reading blocks directly. You will see \`Processing object type TABLE_EXPORT/TABLE/TABLE_DATA\` in the log with method type shown. This is not an error — just a performance note.

### Estimating export size before running

Use \`ESTIMATE_ONLY=Y\` to measure the export size without writing any dumpfiles:

\`\`\`bash
expdp system/password@mydb \\
  SCHEMAS=MYAPP \\
  ESTIMATE_ONLY=Y \\
  LOGFILE=myapp_estimate.log
\`\`\`

The log will show the estimated size. You can also use \`ESTIMATE=STATISTICS\` (uses optimizer statistics, faster) or \`ESTIMATE=BLOCKS\` (counts actual allocated blocks, more accurate for tables with lots of free space).

### Dumpfile already exists

By default, Data Pump will error if the target dumpfile already exists. To overwrite:

\`\`\`bash
expdp myapp_dba/password@mydb \\
  SCHEMAS=MYAPP \\
  DIRECTORY=datapump_dir \\
  DUMPFILE=myapp.dmp \\
  REUSE_DUMPFILES=Y \\
  LOGFILE=myapp_export.log
\`\`\`

---

## Summary

Oracle Data Pump is a server-side, parallel, binary export/import framework. The key mental model: jobs run inside the database as Oracle processes, dumpfiles are written from the server, and directory objects are the only I/O path. Understanding the master table, worker processes, and interactive mode gives you full control over running jobs. The most impactful advanced parameters are FLASHBACK_SCN for consistency, EXCLUDE=STATISTICS to avoid importing stale stats, TRANSFORM=DISABLE_ARCHIVE_LOGGING:Y for fast imports, and REMAP_SCHEMA / REMAP_TABLESPACE for environment cloning. Always use a parameter file for non-trivial jobs — it avoids shell quoting problems, documents the exact parameters used, and can be reused for re-runs.`,
};

async function main() {
  console.log('Inserting Oracle Data Pump concepts post...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: {
      title: post.title,
      excerpt: post.excerpt,
      content: post.content,
      published: post.published,
      publishedAt: post.publishedAt,
      isPremium: post.isPremium,
    },
  });
  console.log(`Inserted: "${post.title}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
