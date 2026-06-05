import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Data Pump Export and Import Operations',
  slug: 'oracle-datapump-expdp-impdp-runbook',
  excerpt:
    'A phased operational runbook for Oracle DBAs covering the complete Data Pump workflow: environment setup, size estimation, schema and full database exports with parameter files, schema imports with remapping, network mode DB-to-DB copy, monitoring running jobs, interactive job control, orphaned job cleanup, and post-import validation with object count comparison and statistics regather.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-05'),
  youtubeUrl: null,
  content: `This runbook covers Oracle Data Pump export and import operations end to end. All commands are shell (expdp/impdp) and SQL/PL/SQL. Run each phase in order, verify the results at each step, then proceed.

**Assumptions:**
- Oracle Database 12.2 or later
- The DBA or a user with EXP_FULL_DATABASE / IMP_FULL_DATABASE role for full and schema-level operations
- An OS directory on the database server with write access for the oracle OS user
- Working schema: \`MYAPP\` (substitute your schema throughout)
- Target environment schema: \`MYAPP_TEST\` (for remap examples)

---

## Phase 0: Environment Setup and Pre-checks

### Step 0.1: Create the directory object and grant privileges

\`\`\`sql
-- Run as SYSDBA or DBA
CREATE OR REPLACE DIRECTORY datapump_dir AS '/u01/datapump/exports';

-- Grant read and write to the user who will run the export/import
GRANT READ, WRITE ON DIRECTORY datapump_dir TO myapp_dba;
GRANT READ, WRITE ON DIRECTORY datapump_dir TO system;

-- Verify the directory object
SELECT directory_name, directory_path
FROM dba_directories
WHERE directory_name = 'DATAPUMP_DIR';
\`\`\`

### Step 0.2: Verify the OS directory exists on the DB server

Data Pump writes to the server OS, not the client. Verify on the DB server host:

\`\`\`bash
# Run on the DB server as oracle OS user or root
ls -la /u01/datapump/exports
# Must show: drwxr-x--- or similar, owned by oracle:oinstall

# If the directory does not exist, create it:
mkdir -p /u01/datapump/exports
chown oracle:oinstall /u01/datapump/exports
chmod 750 /u01/datapump/exports

# Verify free space (need room for the dumpfiles)
df -h /u01/datapump/exports
\`\`\`

### Step 0.3: Verify the user has required roles

\`\`\`sql
-- Check DBA privileges for full and schema exports
SELECT grantee, granted_role, default_role, admin_option
FROM dba_role_privs
WHERE grantee = 'MYAPP_DBA'
  AND granted_role IN ('EXP_FULL_DATABASE', 'IMP_FULL_DATABASE', 'DBA')
ORDER BY granted_role;

-- If the role is missing, grant it:
-- GRANT EXP_FULL_DATABASE TO myapp_dba;
-- GRANT IMP_FULL_DATABASE TO myapp_dba;

-- Verify the user can see the directory
SELECT privilege
FROM dba_tab_privs
WHERE grantee = 'MYAPP_DBA'
  AND table_name = 'DATAPUMP_DIR'
ORDER BY privilege;
\`\`\`

### Step 0.4: Verify the database is open and undo retention is sufficient

\`\`\`sql
-- Database status
SELECT name, open_mode, log_mode FROM v\$database;
-- open_mode should be READ WRITE; log_mode should be ARCHIVELOG for production

-- Current undo retention and actual retention achieved
SELECT MAX(maxquerylen) AS longest_query_sec,
       MAX(tuned_undoretention) AS tuned_retention_sec,
       SUM(undoblks) AS total_undo_blocks_used
FROM v\$undostat;

-- For flashback-consistent exports, ensure undo retention covers export duration
-- If export is expected to run 2 hours, retention should be at least 7200 seconds
SELECT value FROM v\$parameter WHERE name = 'undo_retention';

-- Increase if needed for long flashback exports
-- ALTER SYSTEM SET undo_retention = 14400 SCOPE=BOTH;  -- 4 hours
\`\`\`

---

## Phase 1: Estimate Export Size

Always estimate before committing to disk space allocation.

### Step 1.1: Estimate a schema export

\`\`\`bash
expdp myapp_dba/password@mydb \
  SCHEMAS=MYAPP \
  ESTIMATE_ONLY=Y \
  ESTIMATE=BLOCKS \
  DIRECTORY=datapump_dir \
  LOGFILE=myapp_estimate.log
\`\`\`

Read the estimate from the log:

\`\`\`bash
grep -i "estimated" /u01/datapump/exports/myapp_estimate.log
# Example output:
# Estimated export file size (BLOCKS method): 42.50 GB for schema MYAPP
\`\`\`

\`ESTIMATE=BLOCKS\` counts actually allocated blocks (more accurate for tables with significant free space).
\`ESTIMATE=STATISTICS\` uses optimizer statistics (faster, less I/O, but may undercount if stats are stale).

### Step 1.2: Estimate a full database export

\`\`\`bash
expdp system/password@mydb \
  FULL=Y \
  ESTIMATE_ONLY=Y \
  ESTIMATE=BLOCKS \
  DIRECTORY=datapump_dir \
  LOGFILE=full_estimate.log
\`\`\`

\`\`\`bash
grep -E "(Estimated|Total)" /u01/datapump/exports/full_estimate.log
\`\`\`

If compression will be used with the actual export, the dumpfile will be smaller than the estimate (estimate is uncompressed). A rough guide: COMPRESSION=ALL with MEDIUM algorithm typically achieves 3–5x compression on typical OLTP data.

---

## Phase 2: Schema Export — Standard Patterns

Use parameter files (.par) for all non-trivial jobs. This avoids shell quoting issues, documents the exact parameters, and allows easy re-runs.

### Step 2a: Single schema export — full with compression and parallel

\`\`\`bash
# /u01/datapump/par/myapp_full_export.par
SCHEMAS=MYAPP
DIRECTORY=datapump_dir
DUMPFILE=myapp_full_%U.dmp
LOGFILE=myapp_full_export.log
PARALLEL=4
COMPRESSION=METADATA_ONLY
FLASHBACK_TIME="SYSTIMESTAMP"
\`\`\`

\`\`\`bash
expdp myapp_dba/password@mydb PARFILE=/u01/datapump/par/myapp_full_export.par
\`\`\`

To use ALL compression (requires Advanced Compression license):

\`\`\`bash
# /u01/datapump/par/myapp_compressed_export.par
SCHEMAS=MYAPP
DIRECTORY=datapump_dir
DUMPFILE=myapp_compressed_%U.dmp
LOGFILE=myapp_compressed_export.log
PARALLEL=4
COMPRESSION=ALL
COMPRESSION_ALGORITHM=MEDIUM
\`\`\`

### Step 2b: Multi-schema export

\`\`\`bash
# /u01/datapump/par/multischema_export.par
SCHEMAS=MYAPP,MYAPP_AUDIT,MYAPP_CONFIG
DIRECTORY=datapump_dir
DUMPFILE=multischema_%U.dmp
LOGFILE=multischema_export.log
PARALLEL=4
COMPRESSION=METADATA_ONLY
\`\`\`

\`\`\`bash
expdp system/password@mydb PARFILE=/u01/datapump/par/multischema_export.par
\`\`\`

### Step 2c: Schema export excluding statistics, grants, and audit policies

\`\`\`bash
# /u01/datapump/par/myapp_clean_export.par
SCHEMAS=MYAPP
DIRECTORY=datapump_dir
DUMPFILE=myapp_clean_%U.dmp
LOGFILE=myapp_clean_export.log
PARALLEL=4
EXCLUDE=STATISTICS
EXCLUDE=GRANT
EXCLUDE=AUDIT_OBJ
\`\`\`

\`\`\`bash
expdp myapp_dba/password@mydb PARFILE=/u01/datapump/par/myapp_clean_export.par
\`\`\`

### Step 2d: Schema export with QUERY filter to subset rows

\`\`\`bash
# /u01/datapump/par/myapp_recent_export.par
SCHEMAS=MYAPP
DIRECTORY=datapump_dir
DUMPFILE=myapp_recent_%U.dmp
LOGFILE=myapp_recent_export.log
QUERY=MYAPP.ORDERS:"WHERE order_date >= DATE '2025-01-01'"
QUERY=MYAPP.ORDER_LINES:"WHERE order_id IN (SELECT order_id FROM myapp.orders WHERE order_date >= DATE '2025-01-01')"
EXCLUDE=STATISTICS
\`\`\`

\`\`\`bash
expdp myapp_dba/password@mydb PARFILE=/u01/datapump/par/myapp_recent_export.par
\`\`\`

---

## Phase 3: Table-Level Export

### Step 3.1: Export specific tables with dependent objects

\`\`\`bash
# /u01/datapump/par/orders_tables_export.par
TABLES=MYAPP.ORDERS,MYAPP.ORDER_LINES,MYAPP.ORDER_STATUS_HISTORY
DIRECTORY=datapump_dir
DUMPFILE=orders_tables.dmp
LOGFILE=orders_tables_export.log
COMPRESSION=METADATA_ONLY
\`\`\`

\`\`\`bash
expdp myapp_dba/password@mydb PARFILE=/u01/datapump/par/orders_tables_export.par
\`\`\`

By default, table exports include indexes, constraints, and triggers for the listed tables.

### Step 3.2: Table export with QUERY predicate

\`\`\`bash
# /u01/datapump/par/orders_q1_export.par
TABLES=MYAPP.ORDERS
QUERY=MYAPP.ORDERS:"WHERE order_date BETWEEN DATE '2025-01-01' AND DATE '2025-03-31'"
DIRECTORY=datapump_dir
DUMPFILE=orders_q1_2025.dmp
LOGFILE=orders_q1_export.log
\`\`\`

\`\`\`bash
expdp myapp_dba/password@mydb PARFILE=/u01/datapump/par/orders_q1_export.par
\`\`\`

### Step 3.3: Data-only table export (rows only, no DDL)

\`\`\`bash
# /u01/datapump/par/orders_data_only.par
TABLES=MYAPP.ORDERS
CONTENT=DATA_ONLY
DIRECTORY=datapump_dir
DUMPFILE=orders_data_only.dmp
LOGFILE=orders_data_only_export.log
\`\`\`

\`\`\`bash
expdp myapp_dba/password@mydb PARFILE=/u01/datapump/par/orders_data_only.par
\`\`\`

---

## Phase 4: Full Database Export

### Step 4.1: Full export with parallel, compression, and flashback consistency

\`\`\`sql
-- Step 1: Capture the SCN for flashback consistency
SELECT DBMS_FLASHBACK.GET_SYSTEM_CHANGE_NUMBER AS export_scn,
       TO_CHAR(SYSDATE, 'YYYY-MM-DD HH24:MI:SS') AS export_start_time
FROM dual;
-- Record the SCN value (e.g., 4892731500)
\`\`\`

\`\`\`bash
# /u01/datapump/par/full_export.par
FULL=Y
DIRECTORY=datapump_dir
DUMPFILE=full_export_%U.dmp
LOGFILE=full_export.log
PARALLEL=8
COMPRESSION=METADATA_ONLY
FLASHBACK_SCN=4892731500
EXCLUDE=STATISTICS
\`\`\`

\`\`\`bash
expdp system/password@mydb PARFILE=/u01/datapump/par/full_export.par
\`\`\`

### Step 4.2: Monitor a running full export

\`\`\`sql
-- Progress from V$SESSION_LONGOPS
SELECT sid, serial#,
       ROUND(sofar / NULLIF(totalwork, 0) * 100, 1) AS pct_done,
       time_remaining AS secs_remaining,
       message
FROM v\$session_longops
WHERE opname LIKE 'Data Pump%'
  AND totalwork > 0
ORDER BY start_time DESC;

-- Job state and degree
SELECT job_name, state, degree, job_mode, attached_sessions
FROM dba_datapump_jobs
WHERE state != 'NOT RUNNING';
\`\`\`

---

## Phase 5: Schema Import — Standard Patterns

### Step 5a: Import to same schema/tablespace (clean re-import)

\`\`\`bash
# /u01/datapump/par/myapp_reimport.par
SCHEMAS=MYAPP
DUMPFILE=myapp_full_%U.dmp
DIRECTORY=datapump_dir
TABLE_EXISTS_ACTION=REPLACE
EXCLUDE=STATISTICS
LOGFILE=myapp_reimport.log
\`\`\`

\`\`\`bash
impdp myapp_dba/password@mydb PARFILE=/u01/datapump/par/myapp_reimport.par
\`\`\`

### Step 5b: Import with REMAP_SCHEMA and REMAP_TABLESPACE for environment cloning

\`\`\`bash
# /u01/datapump/par/myapp_clone_to_test.par
SCHEMAS=MYAPP
DUMPFILE=myapp_full_%U.dmp
DIRECTORY=datapump_dir
REMAP_SCHEMA=MYAPP:MYAPP_TEST
REMAP_TABLESPACE=MYAPP_DATA:USERS
REMAP_TABLESPACE=MYAPP_IDX:USERS
TABLE_EXISTS_ACTION=REPLACE
EXCLUDE=STATISTICS
TRANSFORM=SEGMENT_ATTRIBUTES:N
LOGFILE=myapp_clone_to_test.log
\`\`\`

\`\`\`bash
impdp system/password@testdb PARFILE=/u01/datapump/par/myapp_clone_to_test.par
\`\`\`

### Step 5c: METADATA_ONLY import — create objects without loading data

\`\`\`bash
# /u01/datapump/par/myapp_ddl_only.par
SCHEMAS=MYAPP
DUMPFILE=myapp_full_%U.dmp
DIRECTORY=datapump_dir
CONTENT=METADATA_ONLY
REMAP_SCHEMA=MYAPP:MYAPP_TEST
EXCLUDE=STATISTICS
EXCLUDE=GRANT
LOGFILE=myapp_ddl_only.log
\`\`\`

\`\`\`bash
impdp system/password@testdb PARFILE=/u01/datapump/par/myapp_ddl_only.par
\`\`\`

### Step 5d: DATA_ONLY import — load data into existing objects

\`\`\`bash
# /u01/datapump/par/myapp_data_only.par
SCHEMAS=MYAPP
DUMPFILE=myapp_full_%U.dmp
DIRECTORY=datapump_dir
CONTENT=DATA_ONLY
TABLE_EXISTS_ACTION=TRUNCATE
LOGFILE=myapp_data_only_import.log
\`\`\`

\`\`\`bash
impdp system/password@targetdb PARFILE=/u01/datapump/par/myapp_data_only.par
\`\`\`

### Step 5e: Import excluding statistics, then regather after load

\`\`\`bash
# /u01/datapump/par/myapp_import_no_stats.par
SCHEMAS=MYAPP
DUMPFILE=myapp_full_%U.dmp
DIRECTORY=datapump_dir
TABLE_EXISTS_ACTION=REPLACE
EXCLUDE=STATISTICS
LOGFILE=myapp_import_no_stats.log
\`\`\`

\`\`\`bash
impdp system/password@targetdb PARFILE=/u01/datapump/par/myapp_import_no_stats.par
\`\`\`

After the import completes, gather statistics on the target environment:

\`\`\`sql
-- Gather schema statistics after import
BEGIN
  DBMS_STATS.GATHER_SCHEMA_STATS(
    ownname          => 'MYAPP',
    estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,
    cascade          => TRUE,
    degree           => 4,
    options          => 'GATHER'
  );
END;
/
\`\`\`

---

## Phase 6: Full Database Import

### Step 6.1: Full import with remapping and fast mode

\`\`\`bash
# /u01/datapump/par/full_import.par
FULL=Y
DUMPFILE=full_export_%U.dmp
DIRECTORY=datapump_dir
REMAP_TABLESPACE=MYAPP_DATA:USERS
REMAP_TABLESPACE=MYAPP_IDX:USERS
REMAP_TABLESPACE=MYAPP_LOB:USERS
EXCLUDE=SCHEMA:"IN ('SYS','SYSTEM','DBSNMP','SYSMAN','OUTLN','WMSYS','XDB','APEX_050000')"
TABLE_EXISTS_ACTION=REPLACE
TRANSFORM=DISABLE_ARCHIVE_LOGGING:Y
TRANSFORM=SEGMENT_ATTRIBUTES:N
EXCLUDE=STATISTICS
PARALLEL=8
LOGFILE=full_import.log
\`\`\`

\`\`\`bash
impdp system/password@targetdb PARFILE=/u01/datapump/par/full_import.par
\`\`\`

The \`TRANSFORM=DISABLE_ARCHIVE_LOGGING:Y\` parameter suppresses redo generation for table loads. This can make large imports 2–5x faster. The data must be recoverable another way (e.g., re-run the import) since these inserts are not logged.

### Step 6.2: Review import log for errors

\`\`\`bash
grep -E "^ORA-|^IMP-|error" /u01/datapump/exports/full_import.log | head -50
\`\`\`

Common import errors that can be safely ignored:
- ORA-31684: Object type already exists (when TABLE_EXISTS_ACTION=SKIP is used)
- ORA-39111: Dependent object type skipped (schema objects that depend on excluded objects)

Errors that require investigation:
- ORA-01950: No privileges on tablespace (use REMAP_TABLESPACE)
- ORA-00959: Tablespace does not exist (use REMAP_TABLESPACE)
- ORA-31693 / ORA-02354: Worker error on specific objects (investigate those objects)

---

## Phase 7: Network Mode — Direct DB-to-DB Copy

### Step 7.1: Create and test the database link

The database link must exist in the **target** database and point to the **source**. All expdp/impdp commands connect to the target (receiving) database.

\`\`\`sql
-- Run in the TARGET database
CREATE DATABASE LINK prod_source_link
  CONNECT TO myapp_dba IDENTIFIED BY password
  USING 'PRODDB';

-- Test the link before using it in Data Pump
SELECT COUNT(*) FROM myapp.orders@prod_source_link;
-- If this returns a count, the link is working
\`\`\`

### Step 7.2: Import a schema directly from source to target

No dumpfile is created. The DIRECTORY is still required for the logfile.

\`\`\`bash
# /u01/datapump/par/network_schema_import.par
NETWORK_LINK=prod_source_link
SCHEMAS=MYAPP
REMAP_SCHEMA=MYAPP:MYAPP_TEST
REMAP_TABLESPACE=MYAPP_DATA:USERS
TABLE_EXISTS_ACTION=REPLACE
EXCLUDE=STATISTICS
DIRECTORY=datapump_dir
LOGFILE=network_schema_import.log
\`\`\`

\`\`\`bash
impdp system/password@testdb PARFILE=/u01/datapump/par/network_schema_import.par
\`\`\`

### Step 7.3: Network full export to a dumpfile

You can also use NETWORK_LINK with expdp to pull data from a remote source and write to a local dumpfile:

\`\`\`bash
expdp system/password@targetdb \
  NETWORK_LINK=prod_source_link \
  SCHEMAS=MYAPP \
  DIRECTORY=datapump_dir \
  DUMPFILE=myapp_from_network.dmp \
  LOGFILE=myapp_network_export.log
\`\`\`

Note: PARALLEL may not be supported with NETWORK_LINK on Oracle 11g and early 12c. On 12.2+, parallel network mode is generally available. Check the Oracle Data Pump documentation for your specific version.

---

## Phase 8: Monitoring Running Jobs

### Step 8.1: Query DBA_DATAPUMP_JOBS

\`\`\`sql
-- All active Data Pump jobs
SELECT owner_name,
       job_name,
       operation,
       job_mode,
       state,
       degree,
       attached_sessions
FROM dba_datapump_jobs
WHERE state != 'NOT RUNNING'
ORDER BY job_name;

-- All jobs including stopped/completed
SELECT owner_name, job_name, operation, job_mode, state, degree
FROM dba_datapump_jobs
ORDER BY job_name;
\`\`\`

State values:
- \`EXECUTING\` — job is actively running
- \`NOT RUNNING\` — job is stopped (can be restarted)
- \`DEFINING\` — job is being created
- \`IDLING\` — job is running but waiting for work

### Step 8.2: Monitor worker progress via V\$SESSION_LONGOPS

\`\`\`sql
SELECT sl.sid,
       sl.serial#,
       sl.opname,
       sl.target,
       sl.sofar,
       sl.totalwork,
       ROUND(sl.sofar / NULLIF(sl.totalwork, 0) * 100, 1) AS pct_complete,
       sl.time_remaining AS secs_remaining,
       TO_CHAR(sl.start_time, 'HH24:MI:SS') AS started,
       sl.message
FROM v\$session_longops sl
WHERE sl.opname LIKE 'Data Pump%'
  AND sl.totalwork > 0
  AND sl.sofar < sl.totalwork
ORDER BY sl.start_time;
\`\`\`

### Step 8.3: Find Data Pump worker sessions in V\$SESSION

\`\`\`sql
SELECT s.sid,
       s.serial#,
       s.username,
       s.program,
       s.status,
       s.event,
       s.wait_class,
       ROUND(s.last_call_et / 60, 1) AS mins_in_current_state
FROM v\$session s
WHERE s.program LIKE '%DW%'
   OR s.program LIKE '%DM%'
ORDER BY s.program, s.sid;
\`\`\`

### Step 8.4: Attach to a running job and check STATUS

\`\`\`bash
# Attach to the job (you need the job name — from DBA_DATAPUMP_JOBS)
expdp myapp_dba/password@mydb ATTACH=SYS_EXPORT_SCHEMA_01
\`\`\`

At the interactive prompt:
\`\`\`
Export> STATUS
\`\`\`

Example STATUS output:
\`\`\`
Job: SYS_EXPORT_SCHEMA_01
  Operation: EXPORT
  Mode: SCHEMA
  State: EXECUTING
  Bytes Processed: 2,341,003,264
  Current Parallelism: 4
  Job Error Count: 0
  Dump File: /u01/datapump/exports/myapp_full_01.dmp
    bytes written: 1,234,567,890

Worker 1 Status:
  Process Name: DW00
  State: WORK WAITING

Worker 2 Status:
  Process Name: DW01
  State: EXECUTING
  Object Schema: MYAPP
  Object Name: ORDERS
  Object Type: TABLE_EXPORT/TABLE/TABLE_DATA
  Completed Objects: 42
  Total Objects: 156
\`\`\`

Type \`CONTINUE_CLIENT\` to re-enter scrolling log mode, or \`EXIT_CLIENT\` to detach cleanly.

---

## Phase 9: Job Control and Recovery

### Step 9.1: Detaching without killing the job

Press **Ctrl-C** during a running expdp or impdp to drop to the interactive prompt. The job continues running in the database. This is safe — the job is not stopped.

\`\`\`
Export> EXIT_CLIENT
\`\`\`

This disconnects the client cleanly. The job continues in the background.

### Step 9.2: Reattaching to a stopped or running job

\`\`\`bash
# Find the job name first
sqlplus / as sysdba
\`\`\`

\`\`\`sql
SELECT owner_name, job_name, state FROM dba_datapump_jobs;
\`\`\`

\`\`\`bash
# Reattach to the export job
expdp myapp_dba/password@mydb ATTACH=SYS_EXPORT_SCHEMA_01

# Reattach to the import job
impdp system/password@targetdb ATTACH=SYS_IMPORT_FULL_01
\`\`\`

### Step 9.3: STOP_JOB and restart workflow

\`\`\`
# At the interactive prompt after attaching:
Export> STOP_JOB
\`\`\`

This gracefully stops the job after current worker operations complete. State becomes \`NOT RUNNING\`. To restart:

\`\`\`bash
expdp myapp_dba/password@mydb ATTACH=SYS_EXPORT_SCHEMA_01
\`\`\`

\`\`\`
Export> START_JOB
\`\`\`

Use \`STOP_JOB=IMMEDIATE\` to stop workers immediately without waiting for current operations to complete. The job can still be restarted afterward.

### Step 9.4: KILL_JOB for unrecoverable jobs

\`\`\`
Export> KILL_JOB
\`\`\`

KILL_JOB terminates all workers and drops the master table. The job cannot be restarted. Any partially written dumpfile is unusable. Use this only when you want to permanently abandon a job and free up resources.

### Step 9.5: Cleaning up orphaned master tables

An orphaned Data Pump job has a master table in DBA_TABLES but no active processes. This can happen when the database was bounced during an export or a network outage dropped the MCP.

\`\`\`sql
-- Find orphaned master tables
SELECT dt.owner,
       dt.table_name,
       dt.created,
       dpj.state,
       dpj.attached_sessions
FROM dba_tables dt
LEFT JOIN dba_datapump_jobs dpj
  ON dpj.owner_name = dt.owner
  AND dpj.job_name = dt.table_name
WHERE (dt.table_name LIKE 'SYS_EXPORT_%'
    OR dt.table_name LIKE 'SYS_IMPORT_%')
ORDER BY dt.created DESC;
\`\`\`

Attempt to attach and kill cleanly first:

\`\`\`bash
expdp / as sysdba ATTACH=SYS_EXPORT_SCHEMA_01
\`\`\`

\`\`\`
Export> KILL_JOB
\`\`\`

If the job cannot be attached (no master process):

\`\`\`sql
-- Drop the master table directly (substitute actual table name)
DROP TABLE sys.sys_export_schema_01;
DROP TABLE sys.sys_export_full_01;
-- or for import jobs:
DROP TABLE sys.sys_import_full_01;
\`\`\`

\`\`\`bash
# Kill any remaining OS worker processes on the DB server
ps -ef | grep ora_dw | grep -v grep
# Kill the DW processes for the orphaned job
# kill -9 <pid>
\`\`\`

After cleanup, confirm the job is gone:

\`\`\`sql
SELECT owner_name, job_name, state FROM dba_datapump_jobs;
\`\`\`

---

## Phase 10: Post-Import Validation

### Step 10.1: Object count comparison — source vs target

\`\`\`sql
-- Run in SOURCE database
SELECT object_type, COUNT(*) AS object_count
FROM dba_objects
WHERE owner = 'MYAPP'
  AND status = 'VALID'
GROUP BY object_type
ORDER BY object_type;
\`\`\`

\`\`\`sql
-- Run in TARGET database (adjust schema name if remapped)
SELECT object_type, COUNT(*) AS object_count
FROM dba_objects
WHERE owner = 'MYAPP_TEST'
  AND status = 'VALID'
GROUP BY object_type
ORDER BY object_type;
\`\`\`

Compare counts side by side. Differences may be expected (e.g., if you used EXCLUDE=GRANT or CONTENT=METADATA_ONLY).

### Step 10.2: Check for invalid objects and recompile

\`\`\`sql
-- Find invalid objects in the target schema
SELECT object_name, object_type, status, last_ddl_time
FROM dba_objects
WHERE owner = 'MYAPP_TEST'
  AND status != 'VALID'
ORDER BY object_type, object_name;
\`\`\`

Recompile all invalid objects:

\`\`\`sql
-- Recompile the entire schema (handles dependencies automatically)
BEGIN
  UTL_RECOMP.RECOMP_SERIAL('MYAPP_TEST');
END;
/

-- Or parallel recompile (faster for large schemas)
BEGIN
  UTL_RECOMP.RECOMP_PARALLEL(4, 'MYAPP_TEST');
END;
/

-- Verify no remaining invalid objects
SELECT object_name, object_type, status
FROM dba_objects
WHERE owner = 'MYAPP_TEST'
  AND status != 'VALID'
ORDER BY object_type, object_name;
\`\`\`

If invalid objects remain after UTL_RECOMP, inspect the errors:

\`\`\`sql
SELECT name, type, sequence, line, position, text
FROM dba_errors
WHERE owner = 'MYAPP_TEST'
ORDER BY name, type, sequence;
\`\`\`

### Step 10.3: Constraint validation

\`\`\`sql
-- Check for disabled or invalid constraints
SELECT constraint_name, constraint_type, table_name, status, validated
FROM dba_constraints
WHERE owner = 'MYAPP_TEST'
  AND status != 'ENABLED'
ORDER BY table_name, constraint_name;

-- Re-enable any disabled constraints (after DATA_ONLY imports)
-- ALTER TABLE myapp_test.orders ENABLE CONSTRAINT orders_pk;
-- ALTER TABLE myapp_test.order_lines ENABLE CONSTRAINT order_lines_fk;
\`\`\`

### Step 10.4: Regather statistics on the imported schema

If statistics were excluded from the import (recommended), gather them now:

\`\`\`sql
BEGIN
  DBMS_STATS.GATHER_SCHEMA_STATS(
    ownname          => 'MYAPP_TEST',
    estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,
    cascade          => TRUE,
    degree           => 4,
    options          => 'GATHER'
  );
END;
/

-- Verify statistics are current
SELECT table_name, num_rows, last_analyzed, stale_stats
FROM dba_tab_statistics
WHERE owner = 'MYAPP_TEST'
  AND (last_analyzed IS NULL OR stale_stats = 'YES')
ORDER BY num_rows DESC NULLS FIRST
FETCH FIRST 20 ROWS ONLY;
\`\`\`

### Step 10.5: Sequence current value verification

\`\`\`sql
-- Compare sequence values between source and target
-- Run in SOURCE:
SELECT sequence_name, last_number, increment_by, cache_size
FROM dba_sequences
WHERE sequence_owner = 'MYAPP'
ORDER BY sequence_name;

-- Run in TARGET:
SELECT sequence_name, last_number, increment_by, cache_size
FROM dba_sequences
WHERE sequence_owner = 'MYAPP_TEST'
ORDER BY sequence_name;
\`\`\`

If sequences in the target are behind (e.g., because DATA_ONLY was used to load additional rows), advance them:

\`\`\`sql
-- Find the max ID in the target table
SELECT MAX(order_id) FROM myapp_test.orders;
-- Example: 9985432

-- Check current sequence value
SELECT myapp_test.orders_seq.NEXTVAL FROM dual;
-- If this is lower than 9985432, advance the sequence

-- Advance by setting the increment temporarily
-- ALTER SEQUENCE myapp_test.orders_seq INCREMENT BY 9000000;
-- SELECT myapp_test.orders_seq.NEXTVAL FROM dual;
-- ALTER SEQUENCE myapp_test.orders_seq INCREMENT BY 1;
\`\`\`

---

## Quick Reference: Top 10 expdp/impdp One-Liners

\`\`\`bash
# 1. Full schema export with parallel and metadata compression
expdp myapp_dba/password@mydb SCHEMAS=MYAPP DIRECTORY=datapump_dir DUMPFILE=myapp_%U.dmp LOGFILE=myapp_exp.log PARALLEL=4 COMPRESSION=METADATA_ONLY EXCLUDE=STATISTICS

# 2. Estimate schema export size without writing files
expdp myapp_dba/password@mydb SCHEMAS=MYAPP ESTIMATE_ONLY=Y ESTIMATE=BLOCKS DIRECTORY=datapump_dir LOGFILE=myapp_estimate.log

# 3. Full database export (flashback consistent)
expdp system/password@mydb FULL=Y FLASHBACK_TIME='"SYSTIMESTAMP"' DIRECTORY=datapump_dir DUMPFILE=full_%U.dmp LOGFILE=full_exp.log PARALLEL=8 EXCLUDE=STATISTICS

# 4. Schema export of specific tables only
expdp myapp_dba/password@mydb TABLES=MYAPP.ORDERS,MYAPP.ORDER_LINES DIRECTORY=datapump_dir DUMPFILE=orders.dmp LOGFILE=orders_exp.log

# 5. Import with schema and tablespace remap
impdp system/password@targetdb SCHEMAS=MYAPP DUMPFILE=myapp_%U.dmp DIRECTORY=datapump_dir REMAP_SCHEMA=MYAPP:MYAPP_TEST REMAP_TABLESPACE=MYAPP_DATA:USERS EXCLUDE=STATISTICS TABLE_EXISTS_ACTION=REPLACE LOGFILE=myapp_imp.log

# 6. Metadata-only import (DDL without data)
impdp system/password@targetdb SCHEMAS=MYAPP DUMPFILE=myapp_%U.dmp DIRECTORY=datapump_dir CONTENT=METADATA_ONLY REMAP_SCHEMA=MYAPP:MYAPP_TEST LOGFILE=myapp_ddl.log

# 7. Data-only import into existing schema
impdp system/password@targetdb SCHEMAS=MYAPP DUMPFILE=myapp_%U.dmp DIRECTORY=datapump_dir CONTENT=DATA_ONLY TABLE_EXISTS_ACTION=TRUNCATE LOGFILE=myapp_data.log

# 8. Network import — copy schema directly between databases
impdp system/password@targetdb NETWORK_LINK=prod_source_link SCHEMAS=MYAPP REMAP_SCHEMA=MYAPP:MYAPP_TEST DIRECTORY=datapump_dir EXCLUDE=STATISTICS LOGFILE=network_imp.log

# 9. Generate DDL from a dumpfile (no objects created)
impdp system/password@targetdb DUMPFILE=myapp_%U.dmp DIRECTORY=datapump_dir SQLFILE=myapp_ddl.sql LOGFILE=sqlfile_gen.log

# 10. Attach to a running or stopped job
expdp myapp_dba/password@mydb ATTACH=SYS_EXPORT_SCHEMA_01
\`\`\``,
};

async function main() {
  console.log('Inserting Oracle Data Pump runbook post...');
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
