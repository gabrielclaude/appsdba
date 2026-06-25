import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle RMAN Backup and Recovery Runbook: Configuration, Procedures, Recovery Scenarios, and Monitoring Scripts',
  slug: 'oracle-rman-backup-recovery-runbook',
  excerpt:
    'Complete RMAN runbook covering persistent configuration, full and incremental backup schedules, archive log management, backup validation, all major recovery scenarios (complete, point-in-time, single datafile, block media, control file, SPFILE), database duplication, and crontab monitoring scripts for missed backups, FRA usage, and backup expiry alerting.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-24'),
  youtubeUrl: null,
  content: `## Overview

This runbook provides ready-to-use RMAN procedures for every common backup and recovery operation. Each section includes the RMAN script, the validation steps to confirm the operation succeeded, and notes on the specific failure modes relevant to that operation.

---

## Environment Assumptions

| Parameter | Value (replace with site values) |
|-----------|----------------------------------|
| Oracle Home | /u01/app/oracle/product/19.0.0/dbhome_1 |
| Oracle SID | ORCL |
| DB Unique Name | ORCL |
| FRA path | /u01/fast_recovery_area |
| Backup disk path | /u01/rman_backup |
| Recovery catalog DB | RMANCAT |
| Recovery catalog user | rman_user |
| Oracle OS user | oracle |
| Target DB host | db-host.internal.company.com |

---

## Phase 1: RMAN Persistent Configuration

Run once during initial setup. These settings persist in the control file and apply to all subsequent RMAN sessions unless overridden.

### 1.1 Connect to RMAN

\`\`\`bash
export ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_SID=ORCL
export PATH=\${ORACLE_HOME}/bin:\${PATH}

# Without catalog (standalone)
rman TARGET /

# With recovery catalog
rman TARGET / CATALOG rman_user/password@RMANCAT
\`\`\`

### 1.2 Apply Persistent Configuration

\`\`\`sql
-- Set default backup location with substitution variables:
-- %d = DB name, %T = date YYYYMMDD, %s = backup set sequence, %p = piece number
CONFIGURE CHANNEL DEVICE TYPE DISK FORMAT '/u01/rman_backup/%d_%T_%s_%p.bkp';

-- Retention: keep backups needed to recover within 7 days
CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS;

-- Control file autobackup — critical for bare-metal recovery
CONFIGURE CONTROLFILE AUTOBACKUP ON;
CONFIGURE CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE DISK
  TO '/u01/rman_backup/cf_%F.bkp';

-- Parallel channels — match to CPU count / I/O throughput of backup target
CONFIGURE DEFAULT DEVICE TYPE TO DISK;
CONFIGURE DEVICE TYPE DISK PARALLELISM 4 BACKUP TYPE TO BACKUPSET;

-- Skip backing up files that haven't changed (useful for read-only tablespaces)
CONFIGURE BACKUP OPTIMIZATION ON;

-- Compression (BASIC is licence-free; MEDIUM/HIGH require Advanced Compression)
CONFIGURE COMPRESSION ALGORITHM 'MEDIUM' AS OF RELEASE 'DEFAULT';

-- Archive log deletion: delete only after applied to standby (if Data Guard exists)
-- For standalone: NONE or APPLIED ON ALL STANDBY
-- CONFIGURE ARCHIVELOG DELETION POLICY TO APPLIED ON ALL STANDBY;

-- Show all current settings
SHOW ALL;
\`\`\`

### 1.3 Enable Block Change Tracking

\`\`\`sql
-- Run in SQL*Plus — enables BCT for faster Level 1 incremental backups
ALTER DATABASE ENABLE BLOCK CHANGE TRACKING
  USING FILE '/u01/fast_recovery_area/ORCL/bct.dbf';

-- Verify
SELECT STATUS, FILENAME FROM V\$BLOCK_CHANGE_TRACKING;
-- Expected: STATUS=ENABLED
\`\`\`

### 1.4 Configure the Fast Recovery Area

\`\`\`sql
-- Run in SQL*Plus as SYSDBA
-- Size = most_recent_backup + (archive_log_rate × retention_days) + flashback_logs (if enabled)
ALTER SYSTEM SET DB_RECOVERY_FILE_DEST = '/u01/fast_recovery_area' SCOPE=BOTH;
ALTER SYSTEM SET DB_RECOVERY_FILE_DEST_SIZE = 200G SCOPE=BOTH;

-- Verify FRA space usage
SELECT NAME, SPACE_LIMIT/1073741824 AS LIMIT_GB,
       SPACE_USED/1073741824 AS USED_GB,
       SPACE_RECLAIMABLE/1073741824 AS RECLAIMABLE_GB,
       ROUND(SPACE_USED/SPACE_LIMIT*100, 1) AS PCT_USED
FROM V\$RECOVERY_FILE_DEST;
\`\`\`

### 1.5 Recovery Catalog Setup (If Using a Catalog)

\`\`\`sql
-- Run in the catalog database as DBA
CREATE TABLESPACE rmancat_ts DATAFILE '/u01/oradata/RMANCAT/rmancat01.dbf' SIZE 2G AUTOEXTEND ON;

CREATE USER rman_user IDENTIFIED BY "Catalog_Password_2026"
  DEFAULT TABLESPACE rmancat_ts
  QUOTA UNLIMITED ON rmancat_ts;

GRANT RECOVERY_CATALOG_OWNER TO rman_user;
GRANT CONNECT, RESOURCE TO rman_user;
\`\`\`

\`\`\`bash
# Create the catalog schema
rman CATALOG rman_user/Catalog_Password_2026@RMANCAT
RMAN> CREATE CATALOG TABLESPACE rmancat_ts;

# Register the target database with the catalog
rman TARGET / CATALOG rman_user/password@RMANCAT
RMAN> REGISTER DATABASE;
RMAN> RESYNC CATALOG;
\`\`\`

---

## Phase 2: Full Database Backup (Level 0)

The Level 0 is the incremental base. Run weekly (typically Sunday) or before any major maintenance.

### 2.1 Full Database Backup Script

\`\`\`bash
cat > /u01/rman_backup/scripts/full_backup.rman << 'RMAN'
RUN {
  -- Allocate 4 parallel disk channels
  ALLOCATE CHANNEL c1 DEVICE TYPE DISK FORMAT '/u01/rman_backup/%d_%T_%s_%p.bkp';
  ALLOCATE CHANNEL c2 DEVICE TYPE DISK FORMAT '/u01/rman_backup/%d_%T_%s_%p.bkp';
  ALLOCATE CHANNEL c3 DEVICE TYPE DISK FORMAT '/u01/rman_backup/%d_%T_%s_%p.bkp';
  ALLOCATE CHANNEL c4 DEVICE TYPE DISK FORMAT '/u01/rman_backup/%d_%T_%s_%p.bkp';

  -- Level 0 incremental base backup with compression
  BACKUP AS COMPRESSED BACKUPSET
    INCREMENTAL LEVEL 0
    DATABASE
    TAG 'WEEKLY_LEVEL0'
    PLUS ARCHIVELOG DELETE INPUT;

  -- Control file and SPFILE backup
  BACKUP CURRENT CONTROLFILE TAG 'WEEKLY_CF';
  BACKUP SPFILE TAG 'WEEKLY_SPFILE';

  -- Release channels
  RELEASE CHANNEL c1;
  RELEASE CHANNEL c2;
  RELEASE CHANNEL c3;
  RELEASE CHANNEL c4;
}

-- Clean up obsolete backups after successful new backup
DELETE NOPROMPT OBSOLETE;
CROSSCHECK BACKUP;
DELETE NOPROMPT EXPIRED BACKUP;
RMAN
\`\`\`

\`\`\`bash
#!/bin/bash
# /u01/rman_backup/scripts/run_full_backup.sh

export ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_SID=ORCL
export PATH=\${ORACLE_HOME}/bin:\${PATH}

LOGFILE=/u01/rman_backup/logs/full_backup_\$(date +%Y%m%d_%H%M).log
ALERT_EMAIL="dba-team@company.com"

echo "RMAN Full Backup Start: \$(date)" | tee "\${LOGFILE}"

rman TARGET / NOCATALOG MSGLOG "\${LOGFILE}" APPEND \\
  CMDFILE /u01/rman_backup/scripts/full_backup.rman

RC=\$?
echo "RMAN Full Backup End: \$(date) RC=\${RC}" | tee -a "\${LOGFILE}"

if [ \${RC} -ne 0 ]; then
  echo -e "Subject: ALERT: RMAN Full Backup Failed on \${ORACLE_SID}\n\n\$(tail -50 \${LOGFILE})" \\
    | sendmail "\${ALERT_EMAIL}"
fi
exit \${RC}
\`\`\`

---

## Phase 3: Incremental Backup (Level 1)

Run daily between Level 0 backups to capture changed blocks only.

### 3.1 Differential Incremental (Monday–Saturday)

\`\`\`bash
cat > /u01/rman_backup/scripts/incremental_backup.rman << 'RMAN'
RUN {
  ALLOCATE CHANNEL c1 DEVICE TYPE DISK FORMAT '/u01/rman_backup/%d_%T_%s_%p.bkp';
  ALLOCATE CHANNEL c2 DEVICE TYPE DISK FORMAT '/u01/rman_backup/%d_%T_%s_%p.bkp';

  BACKUP AS COMPRESSED BACKUPSET
    INCREMENTAL LEVEL 1
    DATABASE
    TAG 'DAILY_LEVEL1'
    PLUS ARCHIVELOG DELETE INPUT;

  BACKUP CURRENT CONTROLFILE TAG 'DAILY_CF';

  RELEASE CHANNEL c1;
  RELEASE CHANNEL c2;
}

DELETE NOPROMPT OBSOLETE;
CROSSCHECK BACKUP;
DELETE NOPROMPT EXPIRED BACKUP;
RMAN
\`\`\`

### 3.2 Cumulative Incremental (Alternative)

Replace \`LEVEL 1\` with \`LEVEL 1 CUMULATIVE\` for a simpler recovery chain (only one Level 1 to apply on top of the Level 0, at the cost of larger daily backup):

\`\`\`bash
cat > /u01/rman_backup/scripts/incremental_cumulative.rman << 'RMAN'
RUN {
  ALLOCATE CHANNEL c1 DEVICE TYPE DISK FORMAT '/u01/rman_backup/%d_%T_%s_%p.bkp';
  ALLOCATE CHANNEL c2 DEVICE TYPE DISK FORMAT '/u01/rman_backup/%d_%T_%s_%p.bkp';

  BACKUP AS COMPRESSED BACKUPSET
    INCREMENTAL LEVEL 1 CUMULATIVE
    DATABASE
    TAG 'DAILY_CUMULATIVE'
    PLUS ARCHIVELOG DELETE INPUT;

  BACKUP CURRENT CONTROLFILE TAG 'DAILY_CF';

  RELEASE CHANNEL c1;
  RELEASE CHANNEL c2;
}
DELETE NOPROMPT OBSOLETE;
RMAN
\`\`\`

---

## Phase 4: Archive Log Backup and Management

Archive logs are the bridge between the last backup and the current point in time. They must be backed up frequently — at least every few hours for production databases — to prevent them from filling the archive log destination and halting the database.

\`\`\`bash
cat > /u01/rman_backup/scripts/archivelog_backup.rman << 'RMAN'
RUN {
  ALLOCATE CHANNEL c1 DEVICE TYPE DISK FORMAT '/u01/rman_backup/arch_%d_%T_%s_%p.bkp';
  ALLOCATE CHANNEL c2 DEVICE TYPE DISK FORMAT '/u01/rman_backup/arch_%d_%T_%s_%p.bkp';

  -- Back up all archive logs not yet backed up twice
  BACKUP AS COMPRESSED BACKUPSET
    ARCHIVELOG ALL NOT BACKED UP 2 TIMES
    DELETE INPUT;

  RELEASE CHANNEL c1;
  RELEASE CHANNEL c2;
}
-- Delete archive logs backed up at least once and older than 1 day
DELETE NOPROMPT ARCHIVELOG UNTIL TIME 'SYSDATE - 1' BACKED UP 1 TIMES TO DISK;
RMAN
\`\`\`

---

## Phase 5: Backup Validation

Validation confirms backup integrity without performing a full restore. Run validation weekly (or after any backup).

### 5.1 Validate Backup Integrity

\`\`\`bash
rman TARGET / NOCATALOG << 'RMAN'
-- Validate all backup sets within the retention window (no restore)
VALIDATE BACKUPSET ALL;

-- Check database for corruption (logical and physical)
BACKUP VALIDATE CHECK LOGICAL DATABASE;

-- Check specific tablespace
BACKUP VALIDATE CHECK LOGICAL TABLESPACE USERS;

-- List any corrupt blocks found
SELECT * FROM V\$DATABASE_BLOCK_CORRUPTION;
RMAN
\`\`\`

### 5.2 Report Status

\`\`\`bash
rman TARGET / NOCATALOG << 'RMAN'
-- Summary of all backups
LIST BACKUP SUMMARY;

-- Backups of the last 7 days
LIST BACKUP COMPLETED AFTER 'SYSDATE-7';

-- Files that need backup (not backed up within retention)
REPORT NEED BACKUP;

-- Obsolete backups
REPORT OBSOLETE;

-- Unrecoverable datafiles (generated by NOLOGGING operations)
REPORT UNRECOVERABLE;
RMAN
\`\`\`

---

## Phase 6: Recovery Scenarios

### 6.1 Complete Database Recovery (All Datafiles Lost)

Use when the entire database storage is lost — disk failure, accidental deletion.

\`\`\`bash
# Database must be in MOUNT state (not OPEN)
sqlplus / as sysdba << 'SQL'
STARTUP MOUNT;
SQL

rman TARGET / NOCATALOG << 'RMAN'
-- Restore all datafiles from the most recent Level 0 + apply Level 1s + archive logs
RESTORE DATABASE;
RECOVER DATABASE;
ALTER DATABASE OPEN;
RMAN
\`\`\`

If restoring to a different host or the control file is also lost, see Phase 6.5 (Control File Recovery) first.

### 6.2 Point-in-Time Recovery (Incomplete Recovery)

Use after a logical error — accidental table drop, runaway DELETE, application bug — where the database must be rolled back to a time before the error.

\`\`\`bash
# Determine the target time (before the error occurred)
# TIME format: 'YYYY-MM-DD HH24:MI:SS'

sqlplus / as sysdba << 'SQL'
STARTUP MOUNT;
SQL

rman TARGET / NOCATALOG << 'RMAN'
RUN {
  -- Point-in-time recovery to just before the accidental DROP TABLE
  SET UNTIL TIME "TO_DATE('2026-06-24 09:30:00','YYYY-MM-DD HH24:MI:SS')";
  RESTORE DATABASE;
  RECOVER DATABASE;
}
RMAN

-- Open with RESETLOGS — required after incomplete recovery
-- WARNING: all standby databases must be rebuilt after RESETLOGS
sqlplus / as sysdba << 'SQL'
ALTER DATABASE OPEN RESETLOGS;
SQL
\`\`\`

**Point-in-time by SCN** (more precise than time):
\`\`\`bash
rman TARGET / NOCATALOG << 'RMAN'
RUN {
  SET UNTIL SCN 8675309;
  RESTORE DATABASE;
  RECOVER DATABASE;
}
RMAN
\`\`\`

### 6.3 Single Datafile Recovery (Database Remains Open)

Use when one datafile is lost or corrupted but the rest of the database is accessible.

\`\`\`bash
# Step 1: Take the affected datafile offline (database stays open)
sqlplus / as sysdba << 'SQL'
-- Find the file ID and name
SELECT FILE#, NAME, STATUS FROM V\$DATAFILE WHERE NAME LIKE '%app_data%';

-- Take it offline
ALTER DATABASE DATAFILE '/u01/oradata/ORCL/app_data01.dbf' OFFLINE;
SQL

# Step 2: Restore and recover the datafile
rman TARGET / NOCATALOG << 'RMAN'
RESTORE DATAFILE '/u01/oradata/ORCL/app_data01.dbf';
RECOVER DATAFILE '/u01/oradata/ORCL/app_data01.dbf';
RMAN

# By file number:
# RESTORE DATAFILE 5;
# RECOVER DATAFILE 5;

# Step 3: Bring the datafile back online
sqlplus / as sysdba << 'SQL'
ALTER DATABASE DATAFILE '/u01/oradata/ORCL/app_data01.dbf' ONLINE;
SQL
\`\`\`

### 6.4 Tablespace Recovery

\`\`\`bash
sqlplus / as sysdba << 'SQL'
ALTER TABLESPACE APP_DATA OFFLINE IMMEDIATE;
SQL

rman TARGET / NOCATALOG << 'RMAN'
RESTORE TABLESPACE APP_DATA;
RECOVER TABLESPACE APP_DATA;
RMAN

sqlplus / as sysdba << 'SQL'
ALTER TABLESPACE APP_DATA ONLINE;
SQL
\`\`\`

### 6.5 Control File Recovery

Used when all control files are lost (no multiplexed copy available).

\`\`\`bash
# Start without mounting (NOMOUNT)
sqlplus / as sysdba << 'SQL'
STARTUP NOMOUNT;
SQL

# RMAN can find the autobackup by DBID if the format uses %F
# Set the DBID first if connecting without a catalog
rman TARGET / NOCATALOG << 'RMAN'
-- If DBID is known (found in alert log or prior RMAN output):
SET DBID 1234567890;

-- Restore control file from autobackup
RESTORE CONTROLFILE FROM AUTOBACKUP;

-- Or restore from a specific backup piece:
-- RESTORE CONTROLFILE FROM '/u01/rman_backup/cf_c-1234567890-20260624-00.bkp';

-- Mount the database with the restored control file
ALTER DATABASE MOUNT;

-- Restore and recover the database
RESTORE DATABASE;
RECOVER DATABASE;

-- Open with RESETLOGS (required after control file restore)
ALTER DATABASE OPEN RESETLOGS;
RMAN
\`\`\`

### 6.6 SPFILE Recovery

\`\`\`bash
# If SPFILE is lost, start with a PFILE, then restore SPFILE from RMAN backup
sqlplus / as sysdba << 'SQL'
-- Start with pfile (Oracle's built-in default pfile or a manually created one)
STARTUP NOMOUNT PFILE='\${ORACLE_HOME}/dbs/init\${ORACLE_SID}.ora';
SQL

rman TARGET / NOCATALOG << 'RMAN'
-- Restore SPFILE from the most recent control file autobackup
RESTORE SPFILE FROM AUTOBACKUP;

-- Or from a specific backup piece:
-- RESTORE SPFILE FROM '/u01/rman_backup/cf_c-1234567890-20260624-00.bkp';

-- Restart using the restored SPFILE
STARTUP FORCE;
RMAN
\`\`\`

### 6.7 Block Media Recovery (BMR)

Recover specific corrupt blocks without taking the datafile offline — the fastest recovery for isolated corruption.

\`\`\`bash
# Step 1: Identify corrupt blocks
rman TARGET / NOCATALOG << 'RMAN'
BACKUP VALIDATE CHECK LOGICAL DATABASE;
RMAN

sqlplus / as sysdba << 'SQL'
SELECT FILE#, BLOCK#, BLOCKS, CORRUPTION_TYPE, MARKED_CORRUPT
FROM V\$DATABASE_BLOCK_CORRUPTION;
SQL

# Step 2: Recover only the corrupt blocks (datafile stays online)
rman TARGET / NOCATALOG << 'RMAN'
-- Recover all blocks listed in V$DATABASE_BLOCK_CORRUPTION
RECOVER CORRUPTION LIST;

-- Or recover a specific block
-- RECOVER DATAFILE 5 BLOCK 1234;
RMAN

# Step 3: Verify corruption is cleared
sqlplus / as sysdba << 'SQL'
SELECT COUNT(*) FROM V\$DATABASE_BLOCK_CORRUPTION;
-- Expected: 0
SQL
\`\`\`

### 6.8 PDB Point-in-Time Recovery (Multitenant)

Recover a single PDB to a point in time without affecting other PDBs:

\`\`\`bash
rman TARGET / NOCATALOG << 'RMAN'
RUN {
  -- Close the PDB before recovery
  ALTER PLUGGABLE DATABASE PROD_PDB CLOSE ABORT;

  SET UNTIL TIME "TO_DATE('2026-06-24 08:00:00','YYYY-MM-DD HH24:MI:SS')";
  RESTORE PLUGGABLE DATABASE PROD_PDB;
  RECOVER PLUGGABLE DATABASE PROD_PDB AUXILIARY DESTINATION '/u01/pdb_pitr_temp';

  ALTER PLUGGABLE DATABASE PROD_PDB OPEN RESETLOGS;
}
RMAN
\`\`\`

---

## Phase 7: Database Duplication

RMAN duplication creates a copy of the target database — used for cloning to test/UAT environments and creating standby databases.

### 7.1 Duplicate from Active Database (Network Mode)

Duplicates directly from the running primary without pre-staged backups:

\`\`\`bash
# Prerequisites:
# 1. Auxiliary (target clone) DB is started NOMOUNT with a minimal init.ora
# 2. Target and auxiliary are both reachable from the RMAN client
# 3. RMAN connects to both simultaneously

# Minimal init.ora on the auxiliary host (/u01/app/oracle/product/19.0.0/dbhome_1/dbs/initORCL_CLONE.ora)
cat > \${ORACLE_HOME}/dbs/initORCL_CLONE.ora << 'INITORA'
DB_NAME=ORCL_CLONE
DB_UNIQUE_NAME=ORCL_CLONE
INITORA

# Start auxiliary NOMOUNT on clone host
export ORACLE_SID=ORCL_CLONE
sqlplus / as sysdba << 'SQL'
STARTUP NOMOUNT PFILE='\${ORACLE_HOME}/dbs/initORCL_CLONE.ora';
SQL

# Run RMAN duplication from the source host or any host with tnsnames entries for both
rman TARGET sys/password@ORCL AUXILIARY sys/password@ORCL_CLONE << 'RMAN'
DUPLICATE TARGET DATABASE TO ORCL_CLONE
  FROM ACTIVE DATABASE
  SPFILE
    PARAMETER_VALUE_CONVERT 'ORCL','ORCL_CLONE',
                             '/u01/oradata/ORCL','/u01/oradata/ORCL_CLONE'
    SET DB_UNIQUE_NAME='ORCL_CLONE'
    SET DB_RECOVERY_FILE_DEST='/u01/fast_recovery_area'
    SET DB_RECOVERY_FILE_DEST_SIZE='50G'
    SET CONTROL_FILES='/u01/oradata/ORCL_CLONE/control01.ctl'
  NOFILENAMECHECK;
RMAN
\`\`\`

### 7.2 Duplicate from Backup

\`\`\`bash
rman TARGET sys/password@ORCL AUXILIARY sys/password@ORCL_CLONE << 'RMAN'
DUPLICATE TARGET DATABASE TO ORCL_CLONE
  BACKUP LOCATION '/u01/rman_backup'
  SPFILE
    PARAMETER_VALUE_CONVERT 'ORCL','ORCL_CLONE','/u01/oradata/ORCL','/u01/oradata/ORCL_CLONE'
    SET DB_UNIQUE_NAME='ORCL_CLONE'
    SET DB_RECOVERY_FILE_DEST='/u01/fast_recovery_area'
  NOFILENAMECHECK;
RMAN
\`\`\`

---

## Phase 8: Catalog Maintenance

\`\`\`bash
rman TARGET / NOCATALOG << 'RMAN'
-- Cross-check: verify that backup pieces listed in catalog/control file still exist on disk
CROSSCHECK BACKUP;
CROSSCHECK ARCHIVELOG ALL;

-- Remove records for backup pieces that no longer exist on disk
DELETE NOPROMPT EXPIRED BACKUP;
DELETE NOPROMPT EXPIRED ARCHIVELOG ALL;

-- Remove backups that are outside the retention window
DELETE NOPROMPT OBSOLETE;

-- List what remains
LIST BACKUP SUMMARY;
RMAN
\`\`\`

---

## Phase 9: Monitoring Scripts

### Script 1: RMAN Backup Status and Age Report

\`\`\`bash
#!/bin/bash
# /opt/scripts/check_rman_backups.sh
# Alerts if no successful RMAN backup within expected window

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
ORACLE_SID=ORCL
export ORACLE_HOME ORACLE_SID PATH=\${ORACLE_HOME}/bin:\${PATH}

ALERT_EMAIL="dba-team@company.com"
MAX_BACKUP_AGE_HOURS=26   # Alert if no successful backup in last 26 hours
LOG_FILE="/var/log/rman_monitor/backup_check_\$(date +%Y%m%d).log"

mkdir -p /var/log/rman_monitor
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
echo "=== RMAN Backup Check: \${TIMESTAMP} ===" | tee "\${LOG_FILE}"

RESULT=\$(sqlplus -S / as sysdba << 'SQL'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON
-- Hours since last successful RMAN database backup
SELECT ROUND((SYSDATE - MAX(COMPLETION_TIME)) * 24, 1) AS HOURS_SINCE_BACKUP
FROM V\$BACKUP_SET_DETAILS
WHERE BACKUP_TYPE IN ('D', 'I')  -- D=Full/Level0, I=Incremental
  AND STATUS = 'AVAILABLE'
  AND COMPLETION_TIME > SYSDATE - 30;
SQL
)

HOURS_AGO=\$(echo "\${RESULT}" | tr -d ' \n\r')

if [ -z "\${HOURS_AGO}" ] || [ "\$(echo "\${HOURS_AGO} > \${MAX_BACKUP_AGE_HOURS}" | bc -l)" -eq 1 ]; then
  MSG="ALERT: Last RMAN backup on \${ORACLE_SID} was \${HOURS_AGO:-UNKNOWN} hours ago (threshold: \${MAX_BACKUP_AGE_HOURS}h). Check: \${LOG_FILE}"
  echo "\${MSG}" | tee -a "\${LOG_FILE}"
  echo -e "Subject: ALERT: RMAN Backup Age Exceeded on \${ORACLE_SID}\n\n\${MSG}" \\
    | sendmail "\${ALERT_EMAIL}"
else
  echo "OK: Last backup \${HOURS_AGO}h ago." | tee -a "\${LOG_FILE}"
fi
\`\`\`

### Script 2: FRA Usage Monitor

\`\`\`bash
#!/bin/bash
# /opt/scripts/check_fra_usage.sh
# Alerts when FRA usage exceeds warning threshold

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
ORACLE_SID=ORCL
export ORACLE_HOME ORACLE_SID PATH=\${ORACLE_HOME}/bin:\${PATH}

ALERT_EMAIL="dba-team@company.com"
WARN_PCT=75
CRIT_PCT=90
LOG_FILE="/var/log/rman_monitor/fra_check_\$(date +%Y%m%d).log"

mkdir -p /var/log/rman_monitor

RESULT=\$(sqlplus -S / as sysdba << 'SQL'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON
SELECT NAME || '|' ||
       ROUND(SPACE_LIMIT/1073741824,1) || '|' ||
       ROUND(SPACE_USED/1073741824,1) || '|' ||
       ROUND(SPACE_RECLAIMABLE/1073741824,1) || '|' ||
       ROUND(SPACE_USED/SPACE_LIMIT*100,1)
FROM V\$RECOVERY_FILE_DEST;
SQL
)

TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
echo "=== FRA Check: \${TIMESTAMP} ===" | tee "\${LOG_FILE}"
echo "FRA: \${RESULT}" | tee -a "\${LOG_FILE}"

PCT_USED=\$(echo "\${RESULT}" | awk -F'|' '{print \$5}' | tr -d ' ')

if [ -z "\${PCT_USED}" ]; then
  echo "ERROR: Could not determine FRA usage" | tee -a "\${LOG_FILE}"
  exit 1
fi

if [ "\$(echo "\${PCT_USED} >= \${CRIT_PCT}" | bc -l)" -eq 1 ]; then
  SEVERITY="CRITICAL"
elif [ "\$(echo "\${PCT_USED} >= \${WARN_PCT}" | bc -l)" -eq 1 ]; then
  SEVERITY="WARNING"
else
  SEVERITY="OK"
fi

echo "FRA usage: \${PCT_USED}% — \${SEVERITY}" | tee -a "\${LOG_FILE}"

if [ "\${SEVERITY}" != "OK" ]; then
  MSG="\${SEVERITY}: FRA on \${ORACLE_SID} is \${PCT_USED}% full. Details: \${RESULT}"
  echo -e "Subject: \${SEVERITY}: FRA Usage \${PCT_USED}% on \${ORACLE_SID}\n\n\${MSG}" \\
    | sendmail "\${ALERT_EMAIL}"
fi
\`\`\`

### Script 3: Database Block Corruption Monitor

\`\`\`bash
#!/bin/bash
# /opt/scripts/check_db_corruption.sh
# Checks V$DATABASE_BLOCK_CORRUPTION for any detected corruption

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
ORACLE_SID=ORCL
export ORACLE_HOME ORACLE_SID PATH=\${ORACLE_HOME}/bin:\${PATH}

ALERT_EMAIL="dba-team@company.com"
LOG_FILE="/var/log/rman_monitor/corruption_check_\$(date +%Y%m%d).log"

mkdir -p /var/log/rman_monitor

CORRUPT_COUNT=\$(sqlplus -S / as sysdba << 'SQL'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT COUNT(*) FROM V\$DATABASE_BLOCK_CORRUPTION;
SQL
)

CORRUPT_COUNT=\$(echo "\${CORRUPT_COUNT}" | tr -d ' \n\r')
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
echo "=== Block Corruption Check: \${TIMESTAMP} — Count: \${CORRUPT_COUNT} ===" | tee "\${LOG_FILE}"

if [ "\${CORRUPT_COUNT}" -gt 0 ]; then
  DETAILS=\$(sqlplus -S / as sysdba << 'SQL'
SET LINESIZE 120 PAGESIZE 50
SELECT FILE#, BLOCK#, BLOCKS, CORRUPTION_TYPE, MARKED_CORRUPT
FROM V\$DATABASE_BLOCK_CORRUPTION;
SQL
  )
  echo "\${DETAILS}" | tee -a "\${LOG_FILE}"
  MSG="CRITICAL: \${CORRUPT_COUNT} corrupt block(s) detected on \${ORACLE_SID}.\n\n\${DETAILS}\n\nRun: RECOVER CORRUPTION LIST; in RMAN"
  echo -e "Subject: CRITICAL: Oracle Block Corruption Detected on \${ORACLE_SID}\n\n\${MSG}" \\
    | sendmail "\${ALERT_EMAIL}"
fi
\`\`\`

### Script 4: RMAN Backup Summary Report

\`\`\`bash
#!/bin/bash
# /opt/scripts/rman_backup_report.sh
# Weekly summary of RMAN backup status — runs every Monday morning

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
ORACLE_SID=ORCL
export ORACLE_HOME ORACLE_SID PATH=\${ORACLE_HOME}/bin:\${PATH}

REPORT_EMAIL="dba-team@company.com"
LOG_FILE="/var/log/rman_monitor/weekly_report_\$(date +%Y%m%d).log"

mkdir -p /var/log/rman_monitor

sqlplus -S / as sysdba << 'SQL' | tee "\${LOG_FILE}"
SET LINESIZE 140 PAGESIZE 80
COLUMN STATUS FORMAT A12
COLUMN INPUT_TYPE FORMAT A20
COLUMN OUTPUT_BYTES_DISPLAY FORMAT A12
COLUMN ELAPSED_SECONDS FORMAT 999999

PROMPT ===== RMAN BACKUP REPORT: Last 7 Days =====
PROMPT

SELECT STATUS,
       INPUT_TYPE,
       TO_CHAR(START_TIME,'YYYY-MM-DD HH24:MI') AS STARTED,
       TO_CHAR(END_TIME,'YYYY-MM-DD HH24:MI') AS ENDED,
       ELAPSED_SECONDS,
       OUTPUT_BYTES_DISPLAY
FROM V\$RMAN_BACKUP_JOB_DETAILS
WHERE START_TIME > SYSDATE - 7
ORDER BY START_TIME DESC;

PROMPT
PROMPT ===== FRA SPACE STATUS =====
PROMPT

SELECT NAME,
       ROUND(SPACE_LIMIT/1073741824,1) AS LIMIT_GB,
       ROUND(SPACE_USED/1073741824,1) AS USED_GB,
       ROUND(SPACE_RECLAIMABLE/1073741824,1) AS RECLAIMABLE_GB,
       ROUND(SPACE_USED/SPACE_LIMIT*100,1) AS PCT_USED
FROM V\$RECOVERY_FILE_DEST;

PROMPT
PROMPT ===== BLOCK CHANGE TRACKING STATUS =====
PROMPT

SELECT STATUS, BYTES_READ, BYTES_MODIFIED, FILENAME FROM V\$BLOCK_CHANGE_TRACKING;

PROMPT
PROMPT ===== FILES NEEDING BACKUP =====
PROMPT

SELECT FILE#, NAME, LAST_BACKUP FROM (
  SELECT DF.FILE#, DF.NAME,
         MAX(BS.COMPLETION_TIME) AS LAST_BACKUP
  FROM V\$DATAFILE DF
  LEFT JOIN V\$BACKUP_DATAFILE BD ON DF.FILE# = BD.FILE#
  LEFT JOIN V\$BACKUP_SET BS ON BD.SET_STAMP = BS.SET_STAMP
  GROUP BY DF.FILE#, DF.NAME
)
WHERE LAST_BACKUP IS NULL OR LAST_BACKUP < SYSDATE - 7
ORDER BY LAST_BACKUP NULLS FIRST;
SQL

cat "\${LOG_FILE}" | sendmail -s "RMAN Weekly Backup Report: \${ORACLE_SID}" "\${REPORT_EMAIL}"
\`\`\`

### Crontab Configuration

\`\`\`bash
# /etc/cron.d/rman_backup
# RMAN backup schedule and monitoring for ORACLE_SID=ORCL

MAILTO=""
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Full backup (Level 0) — Sunday at 1am
0 1 * * 0    oracle  ORACLE_SID=ORCL ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1 /u01/rman_backup/scripts/run_full_backup.sh >> /var/log/rman_monitor/cron.log 2>&1

# Incremental backup (Level 1) — Mon-Sat at 1am
0 1 * * 1-6  oracle  ORACLE_SID=ORCL ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1 /u01/rman_backup/scripts/run_incremental_backup.sh >> /var/log/rman_monitor/cron.log 2>&1

# Archive log backup — every 4 hours
0 */4 * * *  oracle  ORACLE_SID=ORCL ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1 rman TARGET / NOCATALOG CMDFILE=/u01/rman_backup/scripts/archivelog_backup.rman MSGLOG=/var/log/rman_monitor/arch_backup_\$(date +\%Y\%m\%d_\%H\%M).log >> /var/log/rman_monitor/cron.log 2>&1

# Backup age check — every hour
0 * * * *    oracle  /opt/scripts/check_rman_backups.sh >> /var/log/rman_monitor/cron.log 2>&1

# FRA usage check — every 30 minutes
*/30 * * * * oracle  /opt/scripts/check_fra_usage.sh >> /var/log/rman_monitor/cron.log 2>&1

# Block corruption check — daily at 6am
0 6 * * *    oracle  /opt/scripts/check_db_corruption.sh >> /var/log/rman_monitor/cron.log 2>&1

# Weekly backup report — Monday at 7am
0 7 * * 1    oracle  /opt/scripts/rman_backup_report.sh >> /var/log/rman_monitor/cron.log 2>&1
\`\`\`

---

## Quick Reference: Common RMAN Commands

\`\`\`bash
# Connect
rman TARGET /                                        # No catalog, local
rman TARGET sys/pwd@ORCL CATALOG rman_user/pwd@CAT  # With catalog, remote

# Backup
BACKUP DATABASE PLUS ARCHIVELOG DELETE INPUT;        # Full + archive logs
BACKUP INCREMENTAL LEVEL 0 DATABASE;                 # Incremental base
BACKUP INCREMENTAL LEVEL 1 DATABASE;                 # Differential incremental
BACKUP INCREMENTAL LEVEL 1 CUMULATIVE DATABASE;      # Cumulative incremental
BACKUP ARCHIVELOG ALL NOT BACKED UP 2 TIMES DELETE INPUT;
BACKUP CURRENT CONTROLFILE;
BACKUP SPFILE;
BACKUP AS COMPRESSED BACKUPSET DATABASE;

# Validate
BACKUP VALIDATE CHECK LOGICAL DATABASE;
VALIDATE BACKUPSET ALL;

# Report
LIST BACKUP SUMMARY;
REPORT NEED BACKUP;
REPORT OBSOLETE;
REPORT UNRECOVERABLE;

# Maintenance
CROSSCHECK BACKUP;
DELETE NOPROMPT OBSOLETE;
DELETE NOPROMPT EXPIRED BACKUP;

# Restore
RESTORE DATABASE;                                    # Full restore
RESTORE DATAFILE 5;                                  # Single file
RESTORE TABLESPACE USERS;
RESTORE CONTROLFILE FROM AUTOBACKUP;
RESTORE SPFILE FROM AUTOBACKUP;

# Recover
RECOVER DATABASE;
RECOVER DATABASE UNTIL TIME "TO_DATE('...')";
RECOVER DATAFILE 5;
RECOVER TABLESPACE USERS;
RECOVER CORRUPTION LIST;                             # Block media recovery
\`\`\`

---

## Summary

RMAN persistent configuration (channels, retention policy, control file autobackup, compression, block change tracking) is set once and applies to all subsequent jobs. The weekly Level 0 + daily Level 1 schedule provides the best balance of backup size and recovery time for most production databases — block change tracking is essential to make Level 1 incrementals fast on databases over 100 GB. Archive log backups every 4 hours prevent the archive log destination from filling between full backups. All recovery scenarios follow the same pattern: mount the database, run RESTORE to place backup data, run RECOVER to apply redo to a consistent SCN, then OPEN (or OPEN RESETLOGS for incomplete recovery). Block media recovery is the fastest resolution for isolated corruption — the datafile stays online and only the specific corrupt blocks are replaced. RMAN duplication from an active database via network link is the cleanest method for environment cloning, eliminating the need to stage and transfer dump files. The four monitoring scripts — backup age alert, FRA usage alert, block corruption alert, and weekly summary report — cover the most common operational failures before they become unplanned outages.`,
};

async function main() {
  console.log('Inserting RMAN backup and recovery runbook...');
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
