import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Data Pump Runbook: expdp and impdp Procedures, Parameter Files, and Monitoring Scripts',
  slug: 'oracle-data-pump-expdp-impdp-runbook',
  excerpt:
    'Step-by-step runbook for Oracle Data Pump — directory object setup, full and schema-level exports, table and query-filtered exports, full and schema imports with remapping, network mode migration, cross-version export, transportable tablespace, job monitoring and management via interactive mode and V$ views, error resolution, and crontab scripts for scheduled exports and expiry alerting.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-24'),
  youtubeUrl: null,
  content: `## Overview

This runbook provides ready-to-use procedures for every common Oracle Data Pump operation. Each section includes a parameter file template (best practice for any non-trivial job), the equivalent command-line form, and the validation steps to confirm the operation completed correctly.

---

## Environment Assumptions

| Parameter | Value (replace with site values) |
|-----------|----------------------------------|
| Oracle Home | /u01/app/oracle/product/19.0.0/dbhome_1 |
| Oracle SID | ORCL |
| Data Pump directory path | /u01/datapump |
| Directory object name | DP_DIR |
| Source schema | APP_OWNER |
| Target schema (clone) | APP_OWNER_UAT |
| DBA user | system |
| Oracle OS user | oracle |

---

## Phase 1: Setup — Directory Objects and Permissions

### 1.1 Create the OS Directory

\`\`\`bash
# Run as root or with sudo
mkdir -p /u01/datapump
chown oracle:oinstall /u01/datapump
chmod 750 /u01/datapump

# Verify Oracle process user can write to it
ls -ld /u01/datapump
\`\`\`

### 1.2 Create the Directory Object and Grant Permissions

\`\`\`sql
-- Connect as DBA
sqlplus / as sysdba

-- Create the directory object
CREATE OR REPLACE DIRECTORY dp_dir AS '/u01/datapump';

-- Grant to the export/import user
GRANT READ, WRITE ON DIRECTORY dp_dir TO system;
GRANT READ, WRITE ON DIRECTORY dp_dir TO app_owner;

-- Verify
SELECT DIRECTORY_NAME, DIRECTORY_PATH FROM DBA_DIRECTORIES WHERE DIRECTORY_NAME = 'DP_DIR';
\`\`\`

### 1.3 Estimate Export Size Before Running

Always estimate before a large export to confirm disk space is adequate:

\`\`\`bash
export ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_SID=ORCL
export PATH=\${ORACLE_HOME}/bin:\${PATH}

# Full DB estimate
expdp system/password FULL=Y ESTIMATE_ONLY=Y LOGFILE=dp_dir:estimate_full.log

# Schema estimate
expdp system/password SCHEMAS=APP_OWNER ESTIMATE_ONLY=Y LOGFILE=dp_dir:estimate_schema.log

# Review the log for "Total estimation using BLOCKS method:"
grep -i "estimation\|Total" /u01/datapump/estimate_schema.log
\`\`\`

---

## Phase 2: Full Database Export

### 2.1 Parameter File (Recommended for All Production Jobs)

\`\`\`bash
cat > /u01/datapump/full_export.par << 'PAR'
FULL=Y
DIRECTORY=DP_DIR
DUMPFILE=full_exp_%U.dmp
LOGFILE=full_exp.log
PARALLEL=4
COMPRESSION=DATA_ONLY
EXCLUDE=STATISTICS
FLASHBACK_TIME="TO_TIMESTAMP(TO_CHAR(SYSDATE,'YYYY-MM-DD HH24:MI:SS'),'YYYY-MM-DD HH24:MI:SS')"
CLUSTER=N
PAR
\`\`\`

**Parameter notes**:
- \`EXCLUDE=STATISTICS\` — omit optimizer statistics; regenerate on the target with DBMS_STATS after import
- \`FLASHBACK_TIME\` — sets a consistent SCN for the export snapshot, ensuring read consistency across all tables
- \`CLUSTER=N\` — restricts the job to the local RAC node (irrelevant on single-instance)
- \`COMPRESSION=DATA_ONLY\` — requires Advanced Compression; remove this line if not licenced

\`\`\`bash
# Run the full export
expdp system/password PARFILE=/u01/datapump/full_export.par

# Monitor progress in another terminal
tail -f /u01/datapump/full_exp.log
\`\`\`

### 2.2 Verify the Export

\`\`\`bash
# Check dump files were created and are not zero-size
ls -lh /u01/datapump/full_exp_*.dmp

# Check the log for completion
tail -20 /u01/datapump/full_exp.log
# Look for: "Job 'SYSTEM'.'SYS_EXPORT_FULL_01' successfully completed"

# Verify with impdp SQLFILE (generates DDL from the dump — does not import anything)
impdp system/password \\
  DIRECTORY=DP_DIR \\
  DUMPFILE=full_exp_%U.dmp \\
  SQLFILE=DP_DIR:full_ddl_verify.sql \\
  FULL=Y \\
  LOGFILE=dp_dir:full_verify.log
\`\`\`

---

## Phase 3: Schema Export

### 3.1 Single Schema Export

\`\`\`bash
cat > /u01/datapump/schema_export.par << 'PAR'
SCHEMAS=APP_OWNER
DIRECTORY=DP_DIR
DUMPFILE=app_owner_exp_%U.dmp
LOGFILE=app_owner_exp.log
PARALLEL=4
COMPRESSION=DATA_ONLY
EXCLUDE=STATISTICS
FLASHBACK_TIME="TO_TIMESTAMP(TO_CHAR(SYSDATE,'YYYY-MM-DD HH24:MI:SS'),'YYYY-MM-DD HH24:MI:SS')"
PAR

expdp system/password PARFILE=/u01/datapump/schema_export.par
\`\`\`

### 3.2 Multiple Schema Export

\`\`\`bash
cat > /u01/datapump/multi_schema_export.par << 'PAR'
SCHEMAS=APP_OWNER,APP_REPORTING,APP_INTEGRATION
DIRECTORY=DP_DIR
DUMPFILE=multi_schema_%U.dmp
LOGFILE=multi_schema_exp.log
PARALLEL=4
EXCLUDE=STATISTICS
PAR

expdp system/password PARFILE=/u01/datapump/multi_schema_export.par
\`\`\`

### 3.3 Schema Export — Metadata Only

Useful for generating a schema DDL reference or pre-creating structure before a data-only import:

\`\`\`bash
expdp system/password \\
  SCHEMAS=APP_OWNER \\
  DIRECTORY=DP_DIR \\
  DUMPFILE=app_owner_meta.dmp \\
  LOGFILE=dp_dir:app_owner_meta.log \\
  CONTENT=METADATA_ONLY
\`\`\`

---

## Phase 4: Table and Filtered Exports

### 4.1 Specific Tables Export

\`\`\`bash
cat > /u01/datapump/table_export.par << 'PAR'
TABLES=APP_OWNER.ORDERS,APP_OWNER.ORDER_LINES,APP_OWNER.CUSTOMERS
DIRECTORY=DP_DIR
DUMPFILE=tables_exp.dmp
LOGFILE=tables_exp.log
EXCLUDE=STATISTICS
PAR

expdp system/password PARFILE=/u01/datapump/table_export.par
\`\`\`

### 4.2 Date-Range Subset Export (QUERY)

Export a rolling 90-day window from the ORDERS table:

\`\`\`bash
cat > /u01/datapump/subset_export.par << 'PAR'
TABLES=APP_OWNER.ORDERS
DIRECTORY=DP_DIR
DUMPFILE=orders_90day.dmp
LOGFILE=orders_90day_exp.log
QUERY=APP_OWNER.ORDERS:"WHERE ORDER_DATE >= SYSDATE - 90"
PAR

expdp system/password PARFILE=/u01/datapump/subset_export.par
\`\`\`

### 4.3 Multi-Table Subset with Different Filters

\`\`\`bash
cat > /u01/datapump/multi_filter_export.par << 'PAR'
TABLES=APP_OWNER.ORDERS,APP_OWNER.ORDER_LINES
DIRECTORY=DP_DIR
DUMPFILE=orders_subset.dmp
LOGFILE=orders_subset.log
QUERY=APP_OWNER.ORDERS:"WHERE ORDER_DATE >= DATE '2025-01-01' AND STATUS = 'CLOSED'"
QUERY=APP_OWNER.ORDER_LINES:"WHERE ORDER_ID IN (SELECT ORDER_ID FROM APP_OWNER.ORDERS WHERE ORDER_DATE >= DATE '2025-01-01' AND STATUS = 'CLOSED')"
PAR

expdp system/password PARFILE=/u01/datapump/multi_filter_export.par
\`\`\`

---

## Phase 5: Full Database Import

### 5.1 Full Import into a New Database

\`\`\`bash
cat > /u01/datapump/full_import.par << 'PAR'
FULL=Y
DIRECTORY=DP_DIR
DUMPFILE=full_exp_%U.dmp
LOGFILE=full_imp.log
PARALLEL=4
TABLE_EXISTS_ACTION=REPLACE
EXCLUDE=STATISTICS
PAR

impdp system/password PARFILE=/u01/datapump/full_import.par
\`\`\`

### 5.2 Full Import with Tablespace Remapping

When the target has different tablespace names from the source:

\`\`\`bash
cat > /u01/datapump/full_import_remap.par << 'PAR'
FULL=Y
DIRECTORY=DP_DIR
DUMPFILE=full_exp_%U.dmp
LOGFILE=full_imp_remap.log
PARALLEL=4
REMAP_TABLESPACE=APP_DATA:APP_DATA_NEW
REMAP_TABLESPACE=APP_IDX:APP_IDX_NEW
REMAP_TABLESPACE=USERS:USERS
TRANSFORM=SEGMENT_ATTRIBUTES:N
EXCLUDE=STATISTICS
PAR

impdp system/password PARFILE=/u01/datapump/full_import_remap.par
\`\`\`

\`TRANSFORM=SEGMENT_ATTRIBUTES:N\` removes all storage and tablespace clauses from DDL, allowing Oracle to apply target defaults. Use this when the target storage layout is unknown or incompatible with the source specification.

---

## Phase 6: Schema Import and Clone

### 6.1 Schema Import — Same Schema Name

\`\`\`bash
cat > /u01/datapump/schema_import.par << 'PAR'
SCHEMAS=APP_OWNER
DIRECTORY=DP_DIR
DUMPFILE=app_owner_exp_%U.dmp
LOGFILE=app_owner_imp.log
PARALLEL=4
TABLE_EXISTS_ACTION=REPLACE
EXCLUDE=STATISTICS
PAR

impdp system/password PARFILE=/u01/datapump/schema_import.par
\`\`\`

### 6.2 Schema Clone — Different Schema Name

Clone APP_OWNER from the dump into APP_OWNER_UAT in the same or different database. The target schema APP_OWNER_UAT must exist (or will be created if it does not):

\`\`\`bash
cat > /u01/datapump/schema_clone.par << 'PAR'
SCHEMAS=APP_OWNER
DIRECTORY=DP_DIR
DUMPFILE=app_owner_exp_%U.dmp
LOGFILE=app_owner_clone.log
PARALLEL=4
REMAP_SCHEMA=APP_OWNER:APP_OWNER_UAT
REMAP_TABLESPACE=APP_DATA:APP_DATA_UAT
REMAP_TABLESPACE=APP_IDX:APP_IDX_UAT
TABLE_EXISTS_ACTION=REPLACE
EXCLUDE=STATISTICS
PAR

# Create the target schema first if it does not exist
sqlplus / as sysdba << 'SQL'
CREATE USER app_owner_uat IDENTIFIED BY "UAT_Password_2026"
  DEFAULT TABLESPACE app_data_uat
  QUOTA UNLIMITED ON app_data_uat
  QUOTA UNLIMITED ON app_idx_uat;
GRANT CONNECT, RESOURCE TO app_owner_uat;
SQL

impdp system/password PARFILE=/u01/datapump/schema_clone.par
\`\`\`

### 6.3 Table Import with APPEND

Load new rows into an existing table without truncating:

\`\`\`bash
impdp system/password \\
  TABLES=APP_OWNER.ORDERS \\
  DIRECTORY=DP_DIR \\
  DUMPFILE=orders_subset.dmp \\
  LOGFILE=dp_dir:orders_append.log \\
  TABLE_EXISTS_ACTION=APPEND \\
  DATA_OPTIONS=SKIP_CONSTRAINT_ERRORS
\`\`\`

---

## Phase 7: Network Mode (No Dump File)

Network mode imports directly from a source database via a database link. No dump files are written.

### 7.1 Create the Database Link in the Target Database

\`\`\`sql
-- Run in TARGET database as DBA
CREATE DATABASE LINK source_db_link
  CONNECT TO system IDENTIFIED BY "source_password"
  USING '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=source-db.internal.company.com)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=ORCL_SRC)))';

-- Test the link
SELECT * FROM DUAL@source_db_link;
\`\`\`

### 7.2 Network Mode Schema Clone

\`\`\`bash
cat > /u01/datapump/network_import.par << 'PAR'
NETWORK_LINK=SOURCE_DB_LINK
SCHEMAS=APP_OWNER
REMAP_SCHEMA=APP_OWNER:APP_OWNER_UAT
REMAP_TABLESPACE=APP_DATA:APP_DATA_UAT
DIRECTORY=DP_DIR
LOGFILE=network_import.log
PARALLEL=4
EXCLUDE=STATISTICS
PAR

impdp system/password PARFILE=/u01/datapump/network_import.par
\`\`\`

### 7.3 Network Mode Full Export (from Target Perspective)

Network mode can also be used to export from a remote source into a local dump file on the target server:

\`\`\`bash
expdp system/password \\
  NETWORK_LINK=SOURCE_DB_LINK \\
  SCHEMAS=APP_OWNER \\
  DIRECTORY=DP_DIR \\
  DUMPFILE=app_owner_from_source_%U.dmp \\
  LOGFILE=dp_dir:network_export.log \\
  PARALLEL=4
\`\`\`

---

## Phase 8: Cross-Version Export

When exporting from Oracle 19c to import into Oracle 12c:

\`\`\`bash
cat > /u01/datapump/crossver_export.par << 'PAR'
SCHEMAS=APP_OWNER
DIRECTORY=DP_DIR
DUMPFILE=app_owner_12c_compat_%U.dmp
LOGFILE=app_owner_12c_compat.log
VERSION=12.2
PARALLEL=4
EXCLUDE=STATISTICS
PAR

expdp system/password PARFILE=/u01/datapump/crossver_export.par
\`\`\`

VERSION=12.2 generates DDL using Oracle 12.2 syntax — any 19c-specific constructs are omitted or downgraded. Import this dump on the 12c target database normally (no special VERSION parameter needed on import).

---

## Phase 9: Transportable Tablespace Export/Import

Transportable tablespace (TTS) is the fastest method for large tablespace migrations between databases of the same endian format.

### 9.1 TTS Export

\`\`\`bash
# Step 1: Make the tablespace(s) READ ONLY
sqlplus / as sysdba << 'SQL'
ALTER TABLESPACE APP_DATA READ ONLY;
ALTER TABLESPACE APP_IDX READ ONLY;
SQL

# Step 2: Export the metadata only (data is in the datafiles)
cat > /u01/datapump/tts_export.par << 'PAR'
TRANSPORT_TABLESPACES=APP_DATA,APP_IDX
TRANSPORT_FULL_CHECK=Y
DIRECTORY=DP_DIR
DUMPFILE=tts_export.dmp
LOGFILE=tts_export.log
PAR

expdp system/password PARFILE=/u01/datapump/tts_export.par

# Step 3: Copy datafiles to target (while tablespace remains READ ONLY)
# Get datafile list from the log or query:
sqlplus / as sysdba << 'SQL'
SELECT FILE_NAME FROM DBA_DATA_FILES
WHERE TABLESPACE_NAME IN ('APP_DATA','APP_IDX')
ORDER BY FILE_NAME;
SQL

# Copy datafiles to target server
scp /u01/oradata/ORCL/app_data01.dbf oracle@target-db:/u01/oradata/ORCL_TGT/
scp /u01/oradata/ORCL/app_idx01.dbf  oracle@target-db:/u01/oradata/ORCL_TGT/

# Step 4: Return tablespace to READ WRITE on source
sqlplus / as sysdba << 'SQL'
ALTER TABLESPACE APP_DATA READ WRITE;
ALTER TABLESPACE APP_IDX READ WRITE;
SQL
\`\`\`

### 9.2 TTS Import on Target

\`\`\`bash
# Copy the metadata dump file to target
scp /u01/datapump/tts_export.dmp oracle@target-db:/u01/datapump/

# Run on TARGET database
impdp system/password \\
  TRANSPORT_DATAFILES='/u01/oradata/ORCL_TGT/app_data01.dbf','/u01/oradata/ORCL_TGT/app_idx01.dbf' \\
  DIRECTORY=DP_DIR \\
  DUMPFILE=tts_export.dmp \\
  LOGFILE=dp_dir:tts_import.log \\
  REMAP_SCHEMA=APP_OWNER:APP_OWNER

# Verify tablespaces are now READ WRITE on target
sqlplus / as sysdba << 'SQL'
SELECT TABLESPACE_NAME, STATUS FROM DBA_TABLESPACES
WHERE TABLESPACE_NAME IN ('APP_DATA','APP_IDX');
SQL
\`\`\`

---

## Phase 10: Job Monitoring and Management

### 10.1 Monitor Active Jobs

\`\`\`sql
-- List all active Data Pump jobs
SELECT JOB_NAME, OPERATION, JOB_MODE, STATE, DEGREE, ATTACHED_SESSIONS
FROM DBA_DATAPUMP_JOBS
WHERE STATE != 'NOT RUNNING'
ORDER BY JOB_NAME;

-- Session-level progress
SELECT SID, SERIAL#, OPNAME,
       SOFAR, TOTALWORK,
       ROUND(SOFAR/NULLIF(TOTALWORK,0)*100,1) AS PCT_DONE,
       ELAPSED_SECONDS,
       TIME_REMAINING
FROM V\$SESSION_LONGOPS
WHERE OPNAME LIKE '%Data Pump%'
  AND TOTALWORK > 0
  AND SOFAR < TOTALWORK
ORDER BY TIME_REMAINING DESC;

-- Worker process count for a running job
SELECT S.SID, S.SERIAL#, S.STATUS, S.PROGRAM, J.JOB_NAME
FROM V\$SESSION S, DBA_DATAPUMP_SESSIONS J
WHERE S.SADDR = J.SADDR
ORDER BY J.JOB_NAME, S.SID;
\`\`\`

### 10.2 Attach to a Running or Stopped Job

\`\`\`bash
# List available jobs to attach to
sqlplus / as sysdba << 'SQL'
SELECT OWNER_NAME, JOB_NAME, STATE FROM DBA_DATAPUMP_JOBS;
SQL

# Attach client to the job
expdp system/password ATTACH=SYS_EXPORT_SCHEMA_01

# Inside interactive mode:
# Export> STATUS
# Export> PARALLEL=8       -- increase workers
# Export> ADD_FILE=DP_DIR:app_owner_exp_05.dmp  -- add file if all files are full
# Export> CONTINUE_CLIENT  -- re-display streaming output
# Export> STOP_JOB=IMMEDIATE  -- pause job (state saved, restartable)
# Export> START_JOB         -- resume a stopped job
\`\`\`

### 10.3 Restart a Stopped Job

If a job was stopped (STOP_JOB) or interrupted by a system restart:

\`\`\`bash
# The job state is preserved in the master table in the user's schema
# Restart by attaching and issuing START_JOB
expdp system/password ATTACH=SYS_EXPORT_SCHEMA_01

# Export> STATUS           -- confirm job is in NOT RUNNING or IDLING state
# Export> START_JOB        -- resume from where it stopped
\`\`\`

### 10.4 Clean Up a Stuck or Orphaned Job

\`\`\`sql
-- If a job appears in DBA_DATAPUMP_JOBS but cannot be attached to,
-- and all associated sessions are gone, clean up the master table manually:

-- Find the master table (same name as the job, owned by the job owner)
SELECT OWNER_NAME, JOB_NAME FROM DBA_DATAPUMP_JOBS;
-- Example: owner=SYSTEM, job=SYS_EXPORT_SCHEMA_01

-- Drop the master table to clean up the job record
DROP TABLE SYSTEM.SYS_EXPORT_SCHEMA_01;

-- The job entry in DBA_DATAPUMP_JOBS will disappear after the table is dropped
\`\`\`

---

## Phase 11: Error Resolution

### 11.1 ORA-39001 / ORA-39070: Directory Issues

\`\`\`bash
# Verify directory object exists and path is valid
sqlplus / as sysdba << 'SQL'
SELECT DIRECTORY_NAME, DIRECTORY_PATH FROM DBA_DIRECTORIES WHERE DIRECTORY_NAME = 'DP_DIR';
SQL

# Verify OS path exists and oracle user can write to it
ls -ld /u01/datapump
su - oracle -c "touch /u01/datapump/test_write && rm /u01/datapump/test_write && echo OK"

# Check filesystem space
df -h /u01/datapump
\`\`\`

### 11.2 ORA-01555: Snapshot Too Old During Export

Increase UNDO_RETENTION and retry, or set FLASHBACK_SCN to capture the SCN before the job starts:

\`\`\`sql
-- Get current SCN before starting export
SELECT CURRENT_SCN FROM V\$DATABASE;
-- Note: 12345678

-- Use this SCN in the export
-- FLASHBACK_SCN=12345678
-- This pins the export snapshot to the noted SCN, avoiding snapshot too old
-- as long as undo for that SCN remains available
\`\`\`

\`\`\`bash
expdp system/password \\
  SCHEMAS=APP_OWNER \\
  DIRECTORY=DP_DIR \\
  DUMPFILE=app_owner_scn.dmp \\
  LOGFILE=dp_dir:app_owner_scn.log \\
  FLASHBACK_SCN=12345678
\`\`\`

### 11.3 ORA-31693 / ORA-02354: Constraint Errors on Import

\`\`\`bash
# First pass: skip constraint errors, import what can be imported
impdp system/password \\
  SCHEMAS=APP_OWNER \\
  DIRECTORY=DP_DIR \\
  DUMPFILE=app_owner_exp_%U.dmp \\
  LOGFILE=dp_dir:app_owner_imp_skip.log \\
  TABLE_EXISTS_ACTION=REPLACE \\
  DATA_OPTIONS=SKIP_CONSTRAINT_ERRORS

# Review the log for constraint violations
grep "ORA-\|error\|violation" /u01/datapump/app_owner_imp_skip.log | sort | uniq -c | sort -rn

# Fix data in target tables, then reimport problem tables
# with TABLE_EXISTS_ACTION=REPLACE to overwrite
\`\`\`

### 11.4 ORA-39171: Resumable Wait (Tablespace Full)

\`\`\`sql
-- Check what the job is waiting for
SELECT NAME, SQL_TEXT, ERROR_NUMBER, ERROR_MSG, TIMEOUT
FROM DBA_RESUMABLE
WHERE STATUS = 'SUSPENDED';

-- Extend the tablespace while the job waits
ALTER TABLESPACE APP_DATA ADD DATAFILE '/u01/oradata/ORCL/app_data02.dbf' SIZE 10G AUTOEXTEND ON;

-- The job will resume automatically once space is available
-- No manual intervention needed after adding space
\`\`\`

### 11.5 PARALLEL Effectively Running at 1

\`\`\`sql
-- Confirm actual worker count
SELECT COUNT(*) AS WORKER_COUNT
FROM V\$SESSION
WHERE PROGRAM LIKE '%DW%' OR PROGRAM LIKE '%DM%';

-- Check for file specification issue (missing %U)
-- Each worker needs its own file — without %U, only one file exists and one worker runs
\`\`\`

---

## Phase 12: Monitoring Scripts

### Script 1: Active Data Pump Job Monitor

\`\`\`bash
#!/bin/bash
# /opt/scripts/monitor_datapump_jobs.sh
# Monitors active Data Pump jobs and reports progress

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
ORACLE_SID=ORCL
export ORACLE_HOME ORACLE_SID PATH=\${ORACLE_HOME}/bin:\${PATH}

ALERT_EMAIL="dba-team@company.com"
LOG_FILE="/var/log/oracle_monitor/datapump_\$(date +%Y%m%d_%H%M).log"

mkdir -p /var/log/oracle_monitor
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
echo "=== Data Pump Job Monitor: \${TIMESTAMP} ===" | tee "\${LOG_FILE}"

sqlplus -S / as sysdba << 'SQL' | tee -a "\${LOG_FILE}"
SET LINESIZE 180
SET PAGESIZE 50
COLUMN JOB_NAME FORMAT A35
COLUMN STATE FORMAT A15
COLUMN OPERATION FORMAT A10
COLUMN JOB_MODE FORMAT A10

-- Active jobs
SELECT JOB_NAME, OPERATION, JOB_MODE, STATE, DEGREE, ATTACHED_SESSIONS
FROM DBA_DATAPUMP_JOBS
WHERE STATE != 'NOT RUNNING';

-- Progress for active jobs
SELECT SUBSTR(OPNAME,1,40) AS OPNAME,
       SOFAR, TOTALWORK,
       ROUND(SOFAR/NULLIF(TOTALWORK,0)*100,1) AS PCT_DONE,
       ELAPSED_SECONDS,
       TIME_REMAINING
FROM V\$SESSION_LONGOPS
WHERE OPNAME LIKE '%Data Pump%'
  AND TOTALWORK > 0
  AND SOFAR < TOTALWORK
ORDER BY TIME_REMAINING DESC;
SQL
\`\`\`

### Script 2: Scheduled Nightly Schema Export

\`\`\`bash
#!/bin/bash
# /opt/scripts/nightly_schema_export.sh
# Scheduled nightly export of APP_OWNER schema with retention

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
ORACLE_SID=ORCL
export ORACLE_HOME ORACLE_SID PATH=\${ORACLE_HOME}/bin:\${PATH}

DP_DIR_PATH=/u01/datapump
SCHEMA=APP_OWNER
RETENTION_DAYS=7
ALERT_EMAIL="dba-team@company.com"
DATESTAMP=\$(date +%Y%m%d)
LOG_FILE="\${DP_DIR_PATH}/nightly_export_\${DATESTAMP}.log"

echo "=== Nightly Schema Export: \$(date) ===" | tee "\${LOG_FILE}"

# Write parameter file for tonight's export
cat > "\${DP_DIR_PATH}/nightly_\${DATESTAMP}.par" << PAR
SCHEMAS=\${SCHEMA}
DIRECTORY=DP_DIR
DUMPFILE=nightly_\${SCHEMA}_\${DATESTAMP}_%U.dmp
LOGFILE=nightly_export_\${DATESTAMP}.log
PARALLEL=4
COMPRESSION=DATA_ONLY
EXCLUDE=STATISTICS
CLUSTER=N
PAR

# Run the export
\${ORACLE_HOME}/bin/expdp system/\${SYSTEM_PASSWORD} PARFILE=\${DP_DIR_PATH}/nightly_\${DATESTAMP}.par
EXPORT_RC=\$?

if [ \${EXPORT_RC} -ne 0 ]; then
  MSG="ALERT: Nightly Data Pump export failed for schema \${SCHEMA} on \$(date). RC=\${EXPORT_RC}. Log: \${LOG_FILE}"
  echo "\${MSG}" | tee -a "\${LOG_FILE}"
  echo -e "Subject: ALERT: Nightly Data Pump Export Failed\n\n\${MSG}" | sendmail "\${ALERT_EMAIL}"
  exit \${EXPORT_RC}
fi

# Confirm dump files are non-empty
EMPTY_FILES=\$(find "\${DP_DIR_PATH}" -name "nightly_\${SCHEMA}_\${DATESTAMP}_*.dmp" -empty)
if [ -n "\${EMPTY_FILES}" ]; then
  MSG="ALERT: Empty dump files found for nightly export \${DATESTAMP}: \${EMPTY_FILES}"
  echo "\${MSG}" | tee -a "\${LOG_FILE}"
  echo -e "Subject: ALERT: Empty Data Pump Dump Files\n\n\${MSG}" | sendmail "\${ALERT_EMAIL}"
fi

# Remove exports older than RETENTION_DAYS
find "\${DP_DIR_PATH}" -name "nightly_\${SCHEMA}_*.dmp" -mtime +\${RETENTION_DAYS} -delete
find "\${DP_DIR_PATH}" -name "nightly_export_*.log" -mtime +\${RETENTION_DAYS} -delete
find "\${DP_DIR_PATH}" -name "nightly_*.par" -mtime +\${RETENTION_DAYS} -delete

echo "Nightly export complete: \$(date)" | tee -a "\${LOG_FILE}"
echo "Dump files retained: \$(ls -lh \${DP_DIR_PATH}/nightly_\${SCHEMA}_*.dmp 2>/dev/null | wc -l) files"
\`\`\`

### Script 3: Data Pump Dump File Age and Size Alert

\`\`\`bash
#!/bin/bash
# /opt/scripts/check_datapump_dumps.sh
# Alerts if nightly dumps are missing or unexpectedly old

DP_DIR_PATH=/u01/datapump
SCHEMA=APP_OWNER
MAX_AGE_HOURS=26
MIN_SIZE_MB=10
ALERT_EMAIL="dba-team@company.com"
LOG_FILE="/var/log/oracle_monitor/dump_check_\$(date +%Y%m%d).log"

mkdir -p /var/log/oracle_monitor
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
echo "=== Dump File Check: \${TIMESTAMP} ===" >> "\${LOG_FILE}"

# Find most recent dump for the schema
LATEST_DUMP=\$(ls -t "\${DP_DIR_PATH}"/nightly_\${SCHEMA}_*.dmp 2>/dev/null | head -1)

if [ -z "\${LATEST_DUMP}" ]; then
  MSG="ALERT: No dump files found for schema \${SCHEMA} in \${DP_DIR_PATH}"
  echo "\${MSG}" >> "\${LOG_FILE}"
  echo -e "Subject: ALERT: Data Pump Dump Missing\n\n\${MSG}" | sendmail "\${ALERT_EMAIL}"
  exit 1
fi

# Check age
FILE_AGE_HOURS=\$(( ($(date +%s) - $(stat -c%Y "\${LATEST_DUMP}")) / 3600 ))
FILE_SIZE_MB=\$(du -sm "\${LATEST_DUMP}" 2>/dev/null | cut -f1)

echo "Latest dump: \${LATEST_DUMP}" >> "\${LOG_FILE}"
echo "Age: \${FILE_AGE_HOURS}h  Size: \${FILE_SIZE_MB}MB" >> "\${LOG_FILE}"

ALERT_MSG=""
if [ "\${FILE_AGE_HOURS}" -gt "\${MAX_AGE_HOURS}" ]; then
  ALERT_MSG+="\nDump is \${FILE_AGE_HOURS}h old — nightly export may have failed"
fi
if [ "\${FILE_SIZE_MB}" -lt "\${MIN_SIZE_MB}" ]; then
  ALERT_MSG+="\nDump is only \${FILE_SIZE_MB}MB — suspiciously small, export may be incomplete"
fi

if [ -n "\${ALERT_MSG}" ]; then
  echo "\${ALERT_MSG}" >> "\${LOG_FILE}"
  echo -e "Subject: ALERT: Data Pump Dump File Issue\n\n\${ALERT_MSG}\n\nLatest: \${LATEST_DUMP}" \\
    | sendmail "\${ALERT_EMAIL}"
fi
\`\`\`

### Crontab Configuration

\`\`\`bash
# /etc/cron.d/oracle_datapump
# Data Pump scheduled exports and monitoring

MAILTO=""
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Nightly schema export — 1am daily
0 1 * * *    oracle  SYSTEM_PASSWORD=your_system_password /opt/scripts/nightly_schema_export.sh >> /var/log/oracle_monitor/cron.log 2>&1

# Dump file age/size check — 7am daily (after nightly window)
0 7 * * *    oracle  /opt/scripts/check_datapump_dumps.sh >> /var/log/oracle_monitor/cron.log 2>&1

# Active job monitor — every 15 minutes during business hours (optional)
*/15 7-19 * * *  oracle  /opt/scripts/monitor_datapump_jobs.sh >> /var/log/oracle_monitor/cron.log 2>&1
\`\`\`

---

## Quick Reference: Common Parameter Combinations

\`\`\`bash
# Production schema export — full, compressed, consistent
expdp system/password SCHEMAS=APP_OWNER DIRECTORY=DP_DIR \\
  DUMPFILE=schema_%U.dmp LOGFILE=dp_dir:schema.log \\
  PARALLEL=4 COMPRESSION=DATA_ONLY EXCLUDE=STATISTICS \\
  FLASHBACK_TIME="TO_TIMESTAMP(TO_CHAR(SYSDATE,'YYYY-MM-DD HH24:MI:SS'),'YYYY-MM-DD HH24:MI:SS')"

# Schema clone — remap to new schema and tablespace
impdp system/password SCHEMAS=APP_OWNER DIRECTORY=DP_DIR \\
  DUMPFILE=schema_%U.dmp LOGFILE=dp_dir:clone.log \\
  REMAP_SCHEMA=APP_OWNER:APP_OWNER_UAT \\
  REMAP_TABLESPACE=APP_DATA:APP_DATA_UAT \\
  TABLE_EXISTS_ACTION=REPLACE EXCLUDE=STATISTICS

# Network mode clone — no dump file
impdp system/password NETWORK_LINK=SOURCE_DB_LINK \\
  SCHEMAS=APP_OWNER DIRECTORY=DP_DIR LOGFILE=dp_dir:netclone.log \\
  REMAP_SCHEMA=APP_OWNER:APP_OWNER_UAT PARALLEL=4 EXCLUDE=STATISTICS

# Metadata-only export — generate DDL reference
expdp system/password SCHEMAS=APP_OWNER DIRECTORY=DP_DIR \\
  DUMPFILE=schema_meta.dmp LOGFILE=dp_dir:schema_meta.log CONTENT=METADATA_ONLY

# Generate DDL from dump without importing
impdp system/password DIRECTORY=DP_DIR DUMPFILE=schema_%U.dmp \\
  SQLFILE=DP_DIR:schema_ddl.sql SCHEMAS=APP_OWNER

# Date-range table subset
expdp system/password TABLES=APP_OWNER.ORDERS DIRECTORY=DP_DIR \\
  DUMPFILE=orders_recent.dmp LOGFILE=dp_dir:orders.log \\
  QUERY=APP_OWNER.ORDERS:"WHERE ORDER_DATE >= SYSDATE - 90"

# Size estimate only
expdp system/password SCHEMAS=APP_OWNER DIRECTORY=DP_DIR \\
  ESTIMATE_ONLY=Y LOGFILE=dp_dir:estimate.log
\`\`\`

---

## Summary

Oracle Data Pump operations are most reliably run from parameter files rather than command-line parameters — parameter files are auditable, rerunnable, and avoid shell quoting issues with QUERY and FLASHBACK_TIME values. Directory objects must be created and granted before any job, and the underlying OS path must be writable by the Oracle process user. PARALLEL with \`%U\` file substitution is the combination that enables multi-worker exports — omitting \`%U\` silently reduces to single-worker regardless of the PARALLEL value specified. Import remapping (REMAP_SCHEMA, REMAP_TABLESPACE, TRANSFORM=SEGMENT_ATTRIBUTES:N) handles the most common cross-environment migration scenarios without modifying the dump file. Network mode eliminates dump file I/O entirely and is the fastest approach for database-to-database clones when both databases are on the same network. Job state is preserved on the server — clients can be safely disconnected and reattached with \`ATTACH=job_name\`, and stopped jobs can be restarted from their last checkpoint. The three monitoring scripts provide nightly export scheduling with retention management, age and size validation of existing dumps, and active job progress reporting during large migration windows.`,
};

async function main() {
  console.log('Inserting Oracle Data Pump runbook...');
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
