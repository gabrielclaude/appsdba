import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'rman-backup-strategy-oracle-rac-database-runbook';

const content = `
This runbook provides step-by-step procedures for configuring, executing, validating, and monitoring RMAN backups on an Oracle RAC database. It covers initial configuration, the weekly Level 0 and daily Level 1 backup schedules, archive log backup, thread coverage verification, backup validation, and the automation script that wraps all phases into a single callable shell script.

---

## Phase 1: Verify Environment Before Configuring Backup

Before changing any RMAN configuration or creating backup scripts, confirm the cluster state and storage layout.

### 1.1 Confirm all RAC instances are running

\`\`\`bash
# From any node, as oracle OS user
olsnodes -s -t
\`\`\`

Expected output shows all nodes as ACTIVE with Hub role:

\`\`\`
racnode01    Active    Hub
racnode02    Active    Hub
racnode03    Active    Hub
racnode04    Active    Hub
\`\`\`

If any node shows INACTIVE, investigate before proceeding — the archive log thread for that instance may have gaps.

### 1.2 Confirm database is in ARCHIVELOG mode

\`\`\`bash
sqlplus / as sysdba
\`\`\`

\`\`\`sql
SELECT name, log_mode, db_unique_name FROM v\$database;
\`\`\`

Expected: \`LOG_MODE = ARCHIVELOG\`. If \`NOARCHIVELOG\`, RMAN online backups are not possible — the database must be placed in ARCHIVELOG mode and restarted.

### 1.3 Confirm archive log destination

\`\`\`sql
SELECT dest_id,
       status,
       target,
       archiver,
       destination,
       error
FROM   v\$archive_dest
WHERE  status = 'VALID'
AND    target = 'PRIMARY';
\`\`\`

If \`DESTINATION\` begins with \`+\` (ASM disk group) — archive logs are in shared storage and any node can back them up. Proceed with single-node channel allocation.

If \`DESTINATION\` begins with \`/\` (local filesystem) — archive logs are on per-node paths. Explicit per-node channel allocation with instance-specific \`CONNECT\` strings is required. See Phase 3.2.

### 1.4 Check ASM disk group availability and free space

\`\`\`bash
export ORACLE_SID=+ASM
export ORACLE_HOME=/u01/app/grid/product/19c/grid
sqlplus / as sysasm
\`\`\`

\`\`\`sql
SELECT name,
       state,
       type,
       ROUND(total_mb / 1024, 1) AS total_gb,
       ROUND(free_mb  / 1024, 1) AS free_gb,
       ROUND((total_mb - free_mb) / total_mb * 100, 1) AS used_pct
FROM   v\$asm_diskgroup
ORDER  BY name;
\`\`\`

If the FRA disk group (\`+RECO\` or equivalent) is above 80% used, purge obsolete RMAN backups or extend the disk group before running the next backup.

### 1.5 Identify all active RAC threads

\`\`\`sql
-- Connect as sysdba on any instance
SELECT thread#,
       status,
       enabled,
       groups
FROM   v\$thread
ORDER  BY thread#;
\`\`\`

Note the thread count — every thread number shown here must appear in every archive log backup. Record this for use in Phase 6 (verification).

### 1.6 Verify backup destination has sufficient space

\`\`\`bash
# If backing up to disk (not FRA)
df -h /backup/RACDB
\`\`\`

A Level 0 backup requires at minimum the total used space in the database (after compression, typically 30–50% of the database size). If backing up to ASM FRA, the FRA size policy manages space automatically within the configured limit.

---

## Phase 2: Configure RMAN Persistent Settings

Connect to any one RAC instance — persistent configuration applies cluster-wide through the shared control file.

\`\`\`bash
rman target /
\`\`\`

### 2.1 Set retention policy

\`\`\`text
CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 14 DAYS;
\`\`\`

Adjust the window to match your RTO/RPO requirements and available backup storage. 14 days is a common default for production RAC databases.

### 2.2 Enable backup optimization

\`\`\`text
CONFIGURE BACKUP OPTIMIZATION ON;
\`\`\`

Prevents RMAN from re-backing-up archive logs already present in a valid backup set on the same device.

### 2.3 Set default device and channel count

\`\`\`text
CONFIGURE DEFAULT DEVICE TYPE TO DISK;
CONFIGURE DEVICE TYPE DISK PARALLELISM 4 BACKUP TYPE TO BACKUPSET;
\`\`\`

Set PARALLELISM to match the number of channels in your backup scripts. 4 channels is typical for a 4-node RAC; adjust for your hardware.

### 2.4 Enable control file autobackup

\`\`\`text
CONFIGURE CONTROLFILE AUTOBACKUP ON;
CONFIGURE CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE DISK
  TO '/backup/RACDB/cf_%F';
\`\`\`

Replace \`/backup/RACDB/\` with the actual backup destination path or use \`+RECO/%F\` for ASM FRA.

### 2.5 Set compression algorithm

\`\`\`text
-- BASIC is license-free; use MEDIUM or HIGH only with Advanced Compression licence
CONFIGURE COMPRESSION ALGORITHM 'BASIC';
\`\`\`

### 2.6 Set archive log deletion policy

\`\`\`text
CONFIGURE ARCHIVELOG DELETION POLICY TO BACKED UP 2 TIMES TO DISK;
\`\`\`

Archive logs are not eligible for deletion until backed up twice — protects against a single failed backup job leaving an unprotected archive.

### 2.7 Verify current configuration

\`\`\`text
SHOW ALL;
\`\`\`

Review the output and confirm all parameters match the settings above. Exit RMAN.

---

## Phase 3: Create RMAN Backup Scripts

Create the directory for RMAN scripts:

\`\`\`bash
mkdir -p /u01/scripts/rman
chmod 750 /u01/scripts/rman
\`\`\`

### 3.1 Weekly Level 0 script — single-node channel allocation (standard)

Use this when archive logs are in ASM (confirmed in Phase 1.3).

\`\`\`bash
cat > /u01/scripts/rman/rman_level0.rman << 'RMANEOF'
RUN {
  ALLOCATE CHANNEL c1 DEVICE TYPE DISK MAXPIECESIZE 64G;
  ALLOCATE CHANNEL c2 DEVICE TYPE DISK MAXPIECESIZE 64G;
  ALLOCATE CHANNEL c3 DEVICE TYPE DISK MAXPIECESIZE 64G;
  ALLOCATE CHANNEL c4 DEVICE TYPE DISK MAXPIECESIZE 64G;

  BACKUP AS COMPRESSED BACKUPSET
    INCREMENTAL LEVEL 0
    DATABASE
    FORMAT '/backup/RACDB/%d_L0_%T_%U.bkp'
    TAG 'WEEKLY_LEVEL0';

  BACKUP AS COMPRESSED BACKUPSET
    ARCHIVELOG ALL
    NOT BACKED UP 1 TIMES
    FORMAT '/backup/RACDB/%d_arch_%T_%s_%p.bkp'
    TAG 'ARCH_WITH_L0'
    DELETE INPUT;

  BACKUP CURRENT CONTROLFILE
    FORMAT '/backup/RACDB/%d_ctl_%T_%U.bkp'
    TAG 'CTL_WITH_L0';

  BACKUP SPFILE
    FORMAT '/backup/RACDB/%d_spf_%T_%U.bkp'
    TAG 'SPF_WITH_L0';

  DELETE NOPROMPT OBSOLETE;

  RESYNC CATALOG;
}
RMANEOF
\`\`\`

Remove the \`RESYNC CATALOG;\` line if no recovery catalog is configured.

### 3.2 Weekly Level 0 script — multi-node channel allocation (local archive logs)

Use this only when archive logs are on per-node local filesystems (confirmed in Phase 1.3). Replace the \`CONNECT\` passwords with the actual sysdba credential or use a wallet.

\`\`\`bash
cat > /u01/scripts/rman/rman_level0_multinode.rman << 'RMANEOF'
RUN {
  ALLOCATE CHANNEL c1 DEVICE TYPE DISK MAXPIECESIZE 64G
    CONNECT 'sys/password@RACDB1';
  ALLOCATE CHANNEL c2 DEVICE TYPE DISK MAXPIECESIZE 64G
    CONNECT 'sys/password@RACDB2';
  ALLOCATE CHANNEL c3 DEVICE TYPE DISK MAXPIECESIZE 64G
    CONNECT 'sys/password@RACDB3';
  ALLOCATE CHANNEL c4 DEVICE TYPE DISK MAXPIECESIZE 64G
    CONNECT 'sys/password@RACDB4';

  BACKUP AS COMPRESSED BACKUPSET
    INCREMENTAL LEVEL 0
    DATABASE
    FORMAT '/backup/RACDB/%d_L0_%T_%U.bkp'
    TAG 'WEEKLY_LEVEL0';

  BACKUP AS COMPRESSED BACKUPSET
    ARCHIVELOG ALL
    NOT BACKED UP 1 TIMES
    FORMAT '/backup/RACDB/%d_arch_%T_%s_%p.bkp'
    TAG 'ARCH_WITH_L0'
    DELETE INPUT;

  BACKUP CURRENT CONTROLFILE
    FORMAT '/backup/RACDB/%d_ctl_%T_%U.bkp'
    TAG 'CTL_WITH_L0';

  BACKUP SPFILE
    FORMAT '/backup/RACDB/%d_spf_%T_%U.bkp'
    TAG 'SPF_WITH_L0';

  DELETE NOPROMPT OBSOLETE;
}
RMANEOF
\`\`\`

### 3.3 Daily Level 1 incremental script

\`\`\`bash
cat > /u01/scripts/rman/rman_level1.rman << 'RMANEOF'
RUN {
  ALLOCATE CHANNEL c1 DEVICE TYPE DISK MAXPIECESIZE 32G;
  ALLOCATE CHANNEL c2 DEVICE TYPE DISK MAXPIECESIZE 32G;
  ALLOCATE CHANNEL c3 DEVICE TYPE DISK MAXPIECESIZE 32G;
  ALLOCATE CHANNEL c4 DEVICE TYPE DISK MAXPIECESIZE 32G;

  BACKUP AS COMPRESSED BACKUPSET
    INCREMENTAL LEVEL 1
    DATABASE
    FORMAT '/backup/RACDB/%d_L1_%T_%U.bkp'
    TAG 'DAILY_LEVEL1';

  BACKUP AS COMPRESSED BACKUPSET
    ARCHIVELOG ALL
    NOT BACKED UP 1 TIMES
    FORMAT '/backup/RACDB/%d_arch_%T_%s_%p.bkp'
    TAG 'ARCH_WITH_L1'
    DELETE INPUT;

  BACKUP CURRENT CONTROLFILE
    FORMAT '/backup/RACDB/%d_ctl_%T_%U.bkp'
    TAG 'CTL_WITH_L1';

  DELETE NOPROMPT OBSOLETE;
}
RMANEOF
\`\`\`

### 3.4 Frequent archive log backup script (every 2 hours)

\`\`\`bash
cat > /u01/scripts/rman/rman_archivelog.rman << 'RMANEOF'
RUN {
  ALLOCATE CHANNEL c1 DEVICE TYPE DISK MAXPIECESIZE 16G;
  ALLOCATE CHANNEL c2 DEVICE TYPE DISK MAXPIECESIZE 16G;

  BACKUP AS COMPRESSED BACKUPSET
    ARCHIVELOG ALL
    NOT BACKED UP 1 TIMES
    FORMAT '/backup/RACDB/%d_arch_%T_%s_%t_%p.bkp'
    TAG 'ARCH_FREQ'
    DELETE INPUT;
}
RMANEOF
\`\`\`

---

## Phase 4: Create the Automation Shell Script

This wrapper script handles logging, exit code checking, and can be called from cron or OEM.

\`\`\`bash
cat > /u01/scripts/rman/rman_rac_backup.sh << 'SCRIPTEOF'
#!/bin/bash
# rman_rac_backup.sh — RMAN backup wrapper for Oracle RAC
# Usage: rman_rac_backup.sh <level0|level1|archivelog> [<db_name>]

set -euo pipefail

BACKUP_TYPE="\${1:-level1}"
DB_NAME="\${2:-RACDB}"
RMAN_SCRIPT_DIR="/u01/scripts/rman"
LOG_DIR="/u01/scripts/rman/logs"
DATE_TAG=\$(date +%Y%m%d_%H%M%S)
LOG_FILE="\${LOG_DIR}/rman_\${BACKUP_TYPE}_\${DATE_TAG}.log"
ORACLE_SID="\${DB_NAME}1"

mkdir -p "\${LOG_DIR}"

export ORACLE_SID
export ORACLE_HOME="/u01/app/oracle/product/19c/dbhome_1"
export PATH="\${ORACLE_HOME}/bin:\${PATH}"
export NLS_DATE_FORMAT="YYYY-MM-DD HH24:MI:SS"

echo "[$(date)] Starting RMAN \${BACKUP_TYPE} backup for \${DB_NAME}" | tee -a "\${LOG_FILE}"

case "\${BACKUP_TYPE}" in
  level0)
    RMAN_FILE="\${RMAN_SCRIPT_DIR}/rman_level0.rman"
    ;;
  level1)
    RMAN_FILE="\${RMAN_SCRIPT_DIR}/rman_level1.rman"
    ;;
  archivelog)
    RMAN_FILE="\${RMAN_SCRIPT_DIR}/rman_archivelog.rman"
    ;;
  *)
    echo "ERROR: Unknown backup type '\${BACKUP_TYPE}'. Use level0, level1, or archivelog." | tee -a "\${LOG_FILE}"
    exit 1
    ;;
esac

if [ ! -f "\${RMAN_FILE}" ]; then
  echo "ERROR: RMAN script not found: \${RMAN_FILE}" | tee -a "\${LOG_FILE}"
  exit 1
fi

rman target / cmdfile="\${RMAN_FILE}" log="\${LOG_FILE}" append

RC=\$?
echo "[$(date)] RMAN exited with code \${RC}" | tee -a "\${LOG_FILE}"

if [ \${RC} -ne 0 ]; then
  echo "ERROR: RMAN backup failed. Review \${LOG_FILE}" | tee -a "\${LOG_FILE}"
  exit \${RC}
fi

# Post-backup: verify all threads were covered in archive log backups
echo "[$(date)] Verifying archive log thread coverage..." | tee -a "\${LOG_FILE}"

sqlplus -s / as sysdba >> "\${LOG_FILE}" << SQLEOF
SET LINESIZE 120
SET PAGESIZE 50
COLUMN most_recent FORMAT A22
COLUMN status      FORMAT A10

SELECT b.thread#,
       MIN(b.sequence#)  AS first_seq,
       MAX(b.sequence#)  AS last_seq,
       COUNT(*)          AS logs_backed_up,
       TO_CHAR(MAX(b.completion_time), 'YYYY-MM-DD HH24:MI:SS') AS most_recent,
       CASE WHEN COUNT(*) > 0 THEN 'OK' ELSE 'NO LOGS' END AS status
FROM   v\\\$backup_archivelog_details b
WHERE  b.completion_time >= SYSDATE - 4/24
GROUP  BY b.thread#
ORDER  BY b.thread#;

-- Report any archive logs NOT yet backed up
SELECT 'UNBACKED LOGS:' AS label, thread#, sequence#, name
FROM   v\\\$archived_log
WHERE  standby_dest = 'NO'
AND    status       = 'A'
AND    backed_up    = 0
ORDER  BY thread#, sequence#;
EXIT;
SQLEOF

# Purge old log files (keep 30 days)
find "\${LOG_DIR}" -name "rman_*.log" -mtime +30 -delete

echo "[$(date)] Backup complete." | tee -a "\${LOG_FILE}"
exit 0
SCRIPTEOF

chmod 750 /u01/scripts/rman/rman_rac_backup.sh
\`\`\`

Test the script directly before scheduling it:

\`\`\`bash
/u01/scripts/rman/rman_rac_backup.sh level0 RACDB
\`\`\`

---

## Phase 5: Schedule Backups via Cron

Add the following entries to the \`oracle\` OS user crontab on the designated backup node. Run \`crontab -e\` as oracle:

\`\`\`text
# RMAN backup schedule — RAC database
# Environment variables must be set for non-interactive cron execution
ORACLE_HOME=/u01/app/oracle/product/19c/dbhome_1
PATH=/u01/app/oracle/product/19c/dbhome_1/bin:/usr/local/bin:/usr/bin:/bin

# Weekly Level 0 — every Sunday at 01:00
0 1 * * 0  /u01/scripts/rman/rman_rac_backup.sh level0 RACDB >> /u01/scripts/rman/logs/cron_level0.log 2>&1

# Daily Level 1 — Monday through Saturday at 01:00
0 1 * * 1-6  /u01/scripts/rman/rman_rac_backup.sh level1 RACDB >> /u01/scripts/rman/logs/cron_level1.log 2>&1

# Archive log backup — every 2 hours, all days
0 */2 * * *  /u01/scripts/rman/rman_rac_backup.sh archivelog RACDB >> /u01/scripts/rman/logs/cron_arch.log 2>&1
\`\`\`

Verify cron can reach the RMAN binary and connect to the database by running the script manually as oracle from a non-login shell first:

\`\`\`bash
env -i HOME=/home/oracle USER=oracle \
  ORACLE_HOME=/u01/app/oracle/product/19c/dbhome_1 \
  PATH=/u01/app/oracle/product/19c/dbhome_1/bin:/usr/bin:/bin \
  ORACLE_SID=RACDB1 \
  /u01/scripts/rman/rman_rac_backup.sh archivelog RACDB
\`\`\`

---

## Phase 6: Validate Archive Log Thread Coverage

After each backup job, confirm that all RAC threads were captured. Run these queries from any RAC instance.

### 6.1 Threads covered in the most recent backup

\`\`\`sql
SELECT b.thread#,
       MIN(b.sequence#)  AS first_seq,
       MAX(b.sequence#)  AS last_seq,
       COUNT(*)          AS logs_backed_up,
       TO_CHAR(MAX(b.completion_time), 'YYYY-MM-DD HH24:MI:SS') AS most_recent
FROM   v\$backup_archivelog_details b
WHERE  b.completion_time >= SYSDATE - 4/24
GROUP  BY b.thread#
ORDER  BY b.thread#;
\`\`\`

Every thread visible in Phase 1.5 must appear here. A missing thread means no archive logs for that instance were included in the backup.

### 6.2 Archive logs present but not yet backed up

\`\`\`sql
SELECT thread#,
       sequence#,
       name,
       TO_CHAR(completion_time, 'YYYY-MM-DD HH24:MI:SS') AS completed,
       backed_up
FROM   v\$archived_log
WHERE  standby_dest = 'NO'
AND    status       = 'A'
AND    backed_up    = 0
ORDER  BY thread#, sequence#;
\`\`\`

Rows here are archive logs on disk that have not been backed up. If this query returns rows older than 4 hours (outside the backup window), investigate whether the archive log backup job ran and completed successfully.

### 6.3 Identify sequence gaps per thread

\`\`\`sql
SELECT thread#,
       MIN(sequence#) AS first_seq,
       MAX(sequence#) AS last_seq,
       COUNT(*)       AS log_count,
       MAX(sequence#) - MIN(sequence#) + 1 AS expected_count,
       CASE WHEN COUNT(*) = MAX(sequence#) - MIN(sequence#) + 1
            THEN 'COMPLETE' ELSE 'GAP DETECTED' END AS coverage
FROM   v\$archived_log
WHERE  standby_dest = 'NO'
AND    status       = 'A'
GROUP  BY thread#
ORDER  BY thread#;
\`\`\`

If \`coverage = 'GAP DETECTED'\`, a log in the sequence is missing — either deleted before it was backed up, or the archive destination had an error. Investigate the alert log for the affected thread's instance.

---

## Phase 7: Validate Backup Integrity

Run backup validation periodically to confirm backup pieces are readable and blocks are uncorrupted. This does not restore any files.

### 7.1 Validate the most recent database backup

\`\`\`bash
rman target /
\`\`\`

\`\`\`text
RESTORE DATABASE VALIDATE;
\`\`\`

This reads every block in the most recent backup set and verifies checksums. On a large database this can take as long as the original backup. Schedule it monthly during a maintenance window.

### 7.2 Validate a specific backup set

\`\`\`sql
-- Find recent backup sets
SELECT bs.recid,
       bs.handle,
       bs.tag,
       bp.set_count,
       TO_CHAR(bs.completion_time, 'YYYY-MM-DD HH24:MI:SS') AS completed,
       bs.status
FROM   v\$backup_piece bs
JOIN   v\$backup_set   bp ON bs.set_stamp = bp.set_stamp
WHERE  bs.completion_time >= SYSDATE - 7
ORDER  BY bs.completion_time DESC;
\`\`\`

\`\`\`text
-- Validate by backup set ID
VALIDATE BACKUPSET <recid>;
\`\`\`

### 7.3 Validate archive log backups for a time window

\`\`\`text
RESTORE ARCHIVELOG FROM TIME 'SYSDATE-2' UNTIL TIME 'SYSDATE' VALIDATE;
\`\`\`

Review the RMAN output for any lines containing \`corrupt\` or \`error\`. Clean output with \`Starting restore at\` and \`Finished restore at\` and no errors confirms the archive log backup set is intact.

---

## Phase 8: Monitor Backup Jobs

### 8.1 Running RMAN sessions

\`\`\`sql
SELECT s.sid,
       s.serial#,
       p.spid        AS os_pid,
       s.program,
       s.status,
       s.sql_id,
       ROUND((SYSDATE - s.logon_time) * 24 * 60, 0) AS runtime_min
FROM   v\$session s
JOIN   v\$process p ON s.paddr = p.addr
WHERE  s.program LIKE '%rman%'
OR     s.module  LIKE '%rman%'
ORDER  BY s.logon_time;
\`\`\`

### 8.2 Last 7 days of backup job summary

\`\`\`sql
SELECT TO_CHAR(start_time, 'YYYY-MM-DD') AS backup_date,
       input_type,
       status,
       ROUND(input_bytes  / 1073741824, 1) AS input_gb,
       ROUND(output_bytes / 1073741824, 1) AS output_gb,
       ROUND(output_bytes / NULLIF(input_bytes, 0) * 100, 1) AS pct_compressed,
       ROUND((end_time - start_time) * 24 * 60, 0) AS duration_min
FROM   v\$rman_backup_job_details
WHERE  start_time >= SYSDATE - 7
ORDER  BY start_time DESC;
\`\`\`

### 8.3 FRA space usage

\`\`\`sql
SELECT name,
       ROUND(space_limit       / 1073741824, 1) AS limit_gb,
       ROUND(space_used        / 1073741824, 1) AS used_gb,
       ROUND(space_reclaimable / 1073741824, 1) AS reclaimable_gb,
       number_of_files
FROM   v\$recovery_file_dest;

SELECT file_type,
       percent_space_used,
       percent_space_reclaimable,
       number_of_files
FROM   v\$recovery_area_usage
ORDER  BY percent_space_used DESC;
\`\`\`

If \`percent_space_used\` exceeds 85%, run \`DELETE NOPROMPT OBSOLETE;\` from RMAN or extend the FRA disk group before the next backup.

### 8.4 Identify failed backup jobs

\`\`\`sql
SELECT TO_CHAR(start_time, 'YYYY-MM-DD HH24:MI:SS') AS started,
       input_type,
       status,
       output_device_type,
       ROUND((end_time - start_time) * 24 * 60, 0) AS duration_min
FROM   v\$rman_backup_job_details
WHERE  status != 'COMPLETED'
AND    start_time >= SYSDATE - 30
ORDER  BY start_time DESC;
\`\`\`

Any row with status \`FAILED\` or \`COMPLETED WITH WARNINGS\` requires investigation. Check the corresponding log file in \`/u01/scripts/rman/logs/\` for the error detail.

---

## Phase 9: Purge Obsolete Backups

Obsolete backups are those no longer needed to satisfy the retention policy. RMAN will not delete them automatically unless \`DELETE OBSOLETE\` is included in the backup script or run manually.

\`\`\`bash
rman target /
\`\`\`

\`\`\`text
-- List what will be considered obsolete (preview only)
REPORT OBSOLETE;

-- Delete obsolete backups (no prompt)
DELETE NOPROMPT OBSOLETE;
\`\`\`

After deletion, confirm space was reclaimed:

\`\`\`sql
SELECT ROUND(space_used / 1073741824, 1) AS used_gb,
       ROUND(space_reclaimable / 1073741824, 1) AS reclaimable_gb
FROM   v\$recovery_file_dest;
\`\`\`

If reclaimable space remains high after \`DELETE OBSOLETE\`, run \`CROSSCHECK BACKUP;\` followed by \`DELETE EXPIRED BACKUP;\` to remove catalog entries for backup pieces that are no longer physically present on disk.

---

## Phase 10: Recovery Procedures

### 10.1 Database crash recovery (all nodes down, no media failure)

When all RAC nodes come back up after a crash, start any one instance. Oracle applies redo automatically:

\`\`\`bash
sqlplus / as sysdba
\`\`\`

\`\`\`sql
STARTUP;
\`\`\`

If the instance reaches OPEN state without errors, crash recovery is complete. Start remaining instances normally.

### 10.2 Full database restore and recovery (media failure)

\`\`\`bash
# Ensure only one instance is started — shut down all others
# On the recovery node:
sqlplus / as sysdba
\`\`\`

\`\`\`sql
STARTUP MOUNT;
\`\`\`

\`\`\`bash
rman target /
\`\`\`

\`\`\`text
RUN {
  ALLOCATE CHANNEL c1 DEVICE TYPE DISK;
  ALLOCATE CHANNEL c2 DEVICE TYPE DISK;
  ALLOCATE CHANNEL c3 DEVICE TYPE DISK;
  ALLOCATE CHANNEL c4 DEVICE TYPE DISK;

  RESTORE DATABASE;
  RECOVER DATABASE;
}

ALTER DATABASE OPEN RESETLOGS;
\`\`\`

After RESETLOGS, register the new incarnation with the recovery catalog if one is configured:

\`\`\`text
RESET DATABASE TO INCARNATION <new_incarnation_number>;
RESYNC CATALOG;
\`\`\`

Start remaining RAC instances from their respective nodes after confirming the database is open.

### 10.3 Point-in-time recovery (PITR)

Use when recovering from logical corruption: a dropped table, a bad batch load, or truncated data.

\`\`\`text
-- Mount only one instance
RUN {
  ALLOCATE CHANNEL c1 DEVICE TYPE DISK;
  ALLOCATE CHANNEL c2 DEVICE TYPE DISK;

  SET UNTIL TIME "TO_DATE('2026-07-14 22:00:00','YYYY-MM-DD HH24:MI:SS')";

  RESTORE DATABASE;
  RECOVER DATABASE;
}

ALTER DATABASE OPEN RESETLOGS;
\`\`\`

RMAN determines which archive log sequences from all threads are required to reach the specified time and applies them in the correct order automatically.

### 10.4 Tablespace point-in-time recovery (TSPITR)

\`\`\`sql
-- Take the tablespace offline on ALL instances before starting
ALTER TABLESPACE sales_data OFFLINE IMMEDIATE;
\`\`\`

\`\`\`text
RUN {
  ALLOCATE CHANNEL c1 DEVICE TYPE DISK;
  ALLOCATE CHANNEL c2 DEVICE TYPE DISK;

  SET UNTIL TIME "TO_DATE('2026-07-14 22:00:00','YYYY-MM-DD HH24:MI:SS')";

  RESTORE TABLESPACE sales_data;
  RECOVER TABLESPACE sales_data;
}
\`\`\`

\`\`\`sql
ALTER TABLESPACE sales_data ONLINE;
\`\`\`

Confirm data is as expected before starting the other RAC instances for this tablespace.

### 10.5 Single datafile recovery

\`\`\`sql
-- Confirm the datafile number
SELECT file#, name, status FROM v\$datafile WHERE name LIKE '%sales%';
\`\`\`

\`\`\`text
RUN {
  ALLOCATE CHANNEL c1 DEVICE TYPE DISK;
  RESTORE DATAFILE 23;
  RECOVER DATAFILE 23;
}
\`\`\`

\`\`\`sql
ALTER DATABASE DATAFILE 23 ONLINE;
\`\`\`

---

## Phase 11: Recovery Catalog Maintenance

### 11.1 Register the RAC database with the catalog

\`\`\`bash
rman target sys@RACDB catalog rman_owner@CATALOG
\`\`\`

\`\`\`text
REGISTER DATABASE;
RESYNC CATALOG;
\`\`\`

### 11.2 Store backup scripts in the catalog

\`\`\`text
CREATE SCRIPT level0_rac
COMMENT 'Weekly Level 0 backup for RAC'
{
  -- paste the contents of rman_level0.rman here
}

EXECUTE SCRIPT level0_rac;
\`\`\`

### 11.3 Routine catalog resync (add to end of all backup scripts)

\`\`\`text
RESYNC CATALOG;
\`\`\`

### 11.4 Crosscheck after restoring control file

If the target database control file was recreated, the catalog's copy may be ahead of the control file's knowledge of backups:

\`\`\`text
-- From RMAN connected to catalog
CROSSCHECK BACKUP;
CROSSCHECK ARCHIVELOG ALL;
DELETE EXPIRED BACKUP;
DELETE EXPIRED ARCHIVELOG ALL;
\`\`\`

---

## Quick Reference

| Task | Command |
|------|---------|
| Run Level 0 backup | \`/u01/scripts/rman/rman_rac_backup.sh level0 RACDB\` |
| Run Level 1 backup | \`/u01/scripts/rman/rman_rac_backup.sh level1 RACDB\` |
| Run archive log backup | \`/u01/scripts/rman/rman_rac_backup.sh archivelog RACDB\` |
| Validate backup | \`RESTORE DATABASE VALIDATE;\` |
| List obsolete backups | \`REPORT OBSOLETE;\` |
| Delete obsolete backups | \`DELETE NOPROMPT OBSOLETE;\` |
| Crosscheck all backups | \`CROSSCHECK BACKUP;\` |
| Delete expired entries | \`DELETE EXPIRED BACKUP;\` |
| Check FRA space | \`SELECT * FROM v\$recovery_area_usage;\` |
| Check thread coverage | Query \`v\$backup_archivelog_details\` grouped by \`thread#\` |
| Show RMAN configuration | \`SHOW ALL;\` |
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'RMAN Backup Strategy for Oracle RAC Databases — Runbook',
    slug,
    excerpt: 'Step-by-step runbook for configuring and operating RMAN backups on an Oracle RAC database. Covers environment pre-checks, persistent RMAN configuration, Level 0 and Level 1 script creation for both ASM and local archive log layouts, the rman_rac_backup.sh automation wrapper, cron scheduling, archive log thread coverage verification, backup integrity validation, FRA space monitoring, obsolete backup purge, and recovery procedures for full restore, PITR, TSPITR, and single datafile recovery.',
    content,
    category: 'rac-clusterware',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
