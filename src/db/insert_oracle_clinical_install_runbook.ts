import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Clinical 5.x DBA Administration — Installation, Sizing, and Maintenance',
  slug: 'oracle-clinical-dba-administration-runbook',
  excerpt:
    'Complete Oracle Clinical 5.x DBA runbook: OS and kernel prerequisite setup, Oracle Database 19c configuration for GxP environments, tablespace and schema installation, sizing worksheets for study portfolios, RMAN backup configuration, RESPONSES table partitioning, statistics maintenance, audit trail protection, patch validation procedures, and the IQ/OQ verification checklist for FDA 21 CFR Part 11 compliance.',
  category: 'oracle-clinical' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-15'),
  youtubeUrl: null,
  content: `## Prerequisites

Before starting this runbook:

- [ ] Oracle Database 19c installation media available (download from Oracle eDelivery)
- [ ] Oracle Clinical 5.x installation media and patch set downloaded from My Oracle Support
- [ ] Oracle WebLogic 12c installation media available
- [ ] Server hardware provisioned and baselined per sizing worksheet (Phase 1)
- [ ] Oracle Linux 8.x or RHEL 8.x installed and registered (OS-level support)
- [ ] Network IP, hostname, and DNS entries confirmed
- [ ] Storage volumes provisioned and mounted at required paths
- [ ] NTP server configured and synchronized
- [ ] Change control ticket opened (all actions in this runbook require a change record)
- [ ] Validation Master Plan (VMP) referenced — this runbook fulfills IQ protocol steps

**Assumed paths (substitute for your environment):**
- Oracle base: \`/u01/app/oracle\`
- Oracle home: \`/u01/app/oracle/product/19c/dbhome_1\`
- Database files: \`/oradata/oc\`
- Archive logs: \`/archivelog/oc\`
- OC application home: \`/u01/app/oc\`

---

## Phase 1: Sizing Worksheet

Complete this worksheet before provisioning hardware. Obtain study portfolio data from the Clinical Data Management team.

### 1.1 Portfolio Input Data

| Parameter | Value |
|-----------|-------|
| Number of active studies | |
| Average subjects per study | |
| Average visits per subject | |
| Average CRF pages per visit | |
| Average questions per CRF page | |
| Expected audit events per response (3–5 typical) | |
| Archive retention period (years) | |
| Number of concurrent data entry users (peak) | |
| Number of TMS coding sessions (peak) | |

### 1.2 Storage Calculation

Fill in the calculated values:

| Storage Component | Formula | Estimated Size |
|------------------|---------|---------------|
| Total responses | Studies × Subjects × Visits × Pages × Questions | |
| RESPONSES table data | Total responses × 500 bytes | |
| RESPONSES indexes | RESPONSES data × 2.5 | |
| AUDITS table | Total responses × Audit events × 700 bytes | |
| AUDITS indexes | AUDITS data × 2.0 | |
| TMS coding data | Total responses × 0.15 × 600 bytes | |
| DCM_LAYOUTS and metadata | 5 GB baseline + 500 MB per 10 studies | |
| TEMP tablespace | Peak concurrent sessions × 2 GB | |
| UNDO tablespace | Peak DML transactions × 30 min retention | |
| Archive logs (30-day) | Daily archive rate × 30 × 1.2 safety | |
| RMAN backup (90-day) | Total database × 1.5 compression | |
| **Total storage required** | Sum above × 1.25 growth buffer | |

### 1.3 CPU and Memory Targets

| Tier | Cores | RAM | Notes |
|------|-------|-----|-------|
| Database server | | | Min: 16 cores, 128 GB for medium portfolio |
| Application server (WebLogic) | | | Min: 8 cores, 32 GB |
| SGA target | | | 40–60% of database server RAM |
| PGA aggregate target | | | 20% of database server RAM |
| WebLogic JVM heap | | | 50% of application server RAM |

Sign off: _________________ (DBA Lead)  Date: _________________

---

## Phase 2: OS Preparation

### 2.1 Kernel Parameters

Edit \`/etc/sysctl.conf\`. Add or update the following values (substitute TOTAL_RAM_BYTES with your server's total RAM in bytes):

\`\`\`bash
# Shared memory — set shmmax to 50% of physical RAM
kernel.shmmax = 137438953472
kernel.shmall = 33554432
kernel.shmmni = 4096

# Semaphores
kernel.sem = 250 32000 100 128

# File handles
fs.file-max = 6815744
fs.aio-max-nr = 1048576

# Network buffers
net.ipv4.ip_local_port_range = 9000 65500
net.core.rmem_max = 4194304
net.core.wmem_max = 1048576

# Oracle-specific
vm.swappiness = 10
vm.dirty_ratio = 15
vm.dirty_background_ratio = 3
\`\`\`

Apply without reboot:
\`\`\`bash
sysctl -p /etc/sysctl.conf
\`\`\`

**Verification**:
\`\`\`bash
sysctl kernel.shmmax kernel.sem fs.file-max
\`\`\`
Confirm output matches the values set above. Document actual values in the IQ checklist.

### 2.2 OS User and Group Creation

\`\`\`bash
groupadd -g 54321 oinstall
groupadd -g 54322 dba
groupadd -g 54323 oper
groupadd -g 54324 backupdba
useradd -u 54321 -g oinstall -G dba,oper,backupdba -m -s /bin/bash oracle
passwd oracle
\`\`\`

### 2.3 Required OS Packages

\`\`\`bash
dnf install -y bc binutils compat-openssl10 elfutils-libelf \
  elfutils-libelf-devel fontconfig-devel glibc glibc-devel \
  glibc-headers ksh libaio libaio-devel libgcc librdmacm-devel \
  libstdc++ libstdc++-devel libxcb make net-tools nfs-utils \
  python3 python3-configshell smartmontools sysstat \
  xorg-x11-xauth xorg-x11-utils
\`\`\`

**Verification**:
\`\`\`bash
rpm -q binutils glibc libaio libgcc libstdc++ ksh make sysstat
\`\`\`
All packages must show installed version. Document installed versions in the IQ checklist.

### 2.4 Directory Structure and Permissions

\`\`\`bash
mkdir -p /u01/app/oracle/product/19c/dbhome_1
mkdir -p /oradata/oc
mkdir -p /archivelog/oc
mkdir -p /rman/oc
mkdir -p /u01/app/oc/export/sas    # SAS export directory
chown -R oracle:oinstall /u01/app/oracle /oradata/oc /archivelog/oc /rman/oc /u01/app/oc
chmod -R 775 /u01/app/oracle
chmod -R 750 /oradata/oc
chmod -R 750 /archivelog/oc
\`\`\`

**Verification**: \`ls -la /u01/app/ /oradata/ /archivelog/\` — confirm oracle:oinstall ownership.

### 2.5 Oracle User Environment

Add to \`/home/oracle/.bash_profile\`:

\`\`\`bash
export ORACLE_BASE=/u01/app/oracle
export ORACLE_HOME=/u01/app/oracle/product/19c/dbhome_1
export ORACLE_SID=OCPROD
export PATH=$ORACLE_HOME/bin:$PATH
export LD_LIBRARY_PATH=$ORACLE_HOME/lib:/lib:/usr/lib
export NLS_LANG=AMERICAN_AMERICA.AL32UTF8
export ORA_NLS10=$ORACLE_HOME/nls/data
# OC-specific
export OPA_HOME=/u01/app/oc
\`\`\`

---

## Phase 3: Oracle Database 19c Installation

### 3.1 Database Software Installation

\`\`\`bash
# As oracle user
cd /stage/db19c
unzip LINUX.X64_193000_db_home.zip -d $ORACLE_HOME
cd $ORACLE_HOME
./runInstaller -silent -ignorePrereqFailure \
  oracle.install.option=INSTALL_DB_SWONLY \
  ORACLE_HOSTNAME=$(hostname) \
  UNIX_GROUP_NAME=oinstall \
  INVENTORY_LOCATION=/u01/app/oraInventory \
  ORACLE_HOME=$ORACLE_HOME \
  ORACLE_BASE=$ORACLE_BASE \
  oracle.install.db.InstallEdition=EE \
  oracle.install.db.OSDBA_GROUP=dba \
  oracle.install.db.OSOPER_GROUP=oper \
  oracle.install.db.OSBACKUPDBA_GROUP=backupdba \
  DECLINE_SECURITY_UPDATES=true
\`\`\`

Run the root scripts when prompted (as root):
\`\`\`bash
/u01/app/oraInventory/orainstRoot.sh
/u01/app/oracle/product/19c/dbhome_1/root.sh
\`\`\`

**Apply the latest Oracle 19c Release Update (RU)** from My Oracle Support before creating the database. This is the GxP-required practice — do not create the OC database on an unpatched Oracle home.

\`\`\`bash
# Apply RU using OPatch
cd $ORACLE_HOME/OPatch
./opatch apply /stage/patches/RU_19.XX.X.X
\`\`\`

**Verification**: \`opatch lspatches | head -20\` — confirm the RU patch number is listed.

### 3.2 Database Creation

Create the database using DBCA silent mode to ensure reproducibility and documentation:

\`\`\`bash
dbca -silent -createDatabase \
  -templateName General_Purpose.dbc \
  -gdbname OCPROD \
  -sid OCPROD \
  -responseFile NO_VALUE \
  -characterSet AL32UTF8 \
  -nationalCharacterSet AL16UTF16 \
  -sysPassword [REDACTED] \
  -systemPassword [REDACTED] \
  -createAsContainerDatabase false \
  -databaseType MULTIPURPOSE \
  -memoryMgmtType AUTO_SGA \
  -totalMemory 32768 \
  -storageType FS \
  -datafileDestination /oradata/oc \
  -redoLogFileSize 500 \
  -emConfiguration NONE \
  -sampleSchema false
\`\`\`

> **Character set**: \`AL32UTF8\` is mandatory for Oracle Clinical. This must be specified at database creation time. Changing the character set post-creation in a regulated environment requires a full revalidation.

### 3.3 Database Configuration for Oracle Clinical

Connect as SYSDBA and apply the required initialization parameters:

\`\`\`sql
-- Archive log mode (mandatory for GxP)
SHUTDOWN IMMEDIATE;
STARTUP MOUNT;
ALTER DATABASE ARCHIVELOG;
ALTER DATABASE OPEN;

-- Verify archive mode
SELECT LOG_MODE FROM V$DATABASE;
-- Must return: ARCHIVELOG

-- Set archive log destination
ALTER SYSTEM SET LOG_ARCHIVE_DEST_1='LOCATION=/archivelog/oc' SCOPE=BOTH;
ALTER SYSTEM SET LOG_ARCHIVE_FORMAT='arch_%t_%s_%r.arc' SCOPE=SPFILE;

-- Oracle Clinical required parameters
ALTER SYSTEM SET "_b_tree_bitmap_plans"=FALSE SCOPE=SPFILE;
ALTER SYSTEM SET ENABLE_DDL_LOGGING=TRUE SCOPE=BOTH;
ALTER SYSTEM SET DB_SECUREFILE='PERMITTED' SCOPE=BOTH;
ALTER SYSTEM SET UNDO_RETENTION=900 SCOPE=BOTH;

-- SGA/PGA (adjust based on Phase 1 sizing worksheet)
ALTER SYSTEM SET SGA_TARGET=32G SCOPE=SPFILE;
ALTER SYSTEM SET PGA_AGGREGATE_TARGET=8G SCOPE=BOTH;
ALTER SYSTEM SET SHARED_POOL_SIZE=2G SCOPE=SPFILE;

-- Redo log sizing (500 MB per group recommended for OC workload)
-- Add additional redo log groups if needed
\`\`\`

**Verification**:
\`\`\`sql
-- Confirm all required parameters
SELECT name, value FROM v$parameter
WHERE  name IN ('log_mode','_b_tree_bitmap_plans','enable_ddl_logging',
                'db_securefile','undo_retention','sga_target','pga_aggregate_target')
ORDER  BY name;
\`\`\`

Document actual parameter values in the IQ checklist. Any deviation from the values above requires documented justification.

### 3.4 Tablespace Creation

\`\`\`sql
-- OPA data tablespace
CREATE BIGFILE TABLESPACE OPA_DATA
  DATAFILE '/oradata/oc/opa_data01.dbf' SIZE 50G
  AUTOEXTEND ON NEXT 5G MAXSIZE UNLIMITED
  EXTENT MANAGEMENT LOCAL AUTOALLOCATE
  SEGMENT SPACE MANAGEMENT AUTO;

-- OPA index tablespace
CREATE BIGFILE TABLESPACE OPA_INDEX
  DATAFILE '/oradata/oc/opa_index01.dbf' SIZE 20G
  AUTOEXTEND ON NEXT 2G MAXSIZE UNLIMITED
  EXTENT MANAGEMENT LOCAL AUTOALLOCATE
  SEGMENT SPACE MANAGEMENT AUTO;

-- TMS data tablespace
CREATE BIGFILE TABLESPACE TMS_DATA
  DATAFILE '/oradata/oc/tms_data01.dbf' SIZE 10G
  AUTOEXTEND ON NEXT 2G MAXSIZE UNLIMITED
  EXTENT MANAGEMENT LOCAL AUTOALLOCATE
  SEGMENT SPACE MANAGEMENT AUTO;

-- RXC (OC system metadata) tablespace
CREATE TABLESPACE RXC_DATA
  DATAFILE '/oradata/oc/rxc_data01.dbf' SIZE 5G
  AUTOEXTEND ON NEXT 1G MAXSIZE 20G
  EXTENT MANAGEMENT LOCAL AUTOALLOCATE
  SEGMENT SPACE MANAGEMENT AUTO;

-- Verify tablespaces
SELECT tablespace_name, status, bigfile
FROM   dba_tablespaces
WHERE  tablespace_name IN ('OPA_DATA','OPA_INDEX','TMS_DATA','RXC_DATA')
ORDER  BY tablespace_name;
\`\`\`

---

## Phase 4: Oracle Clinical Schema Installation

### 4.1 Run the OC Installer

\`\`\`bash
# As oracle user
cd /stage/oc5x
./runInstaller
\`\`\`

During the installer:
- [ ] Select **Install Oracle Clinical** (not upgrade)
- [ ] Enter Oracle home path
- [ ] Enter database connection string (TNS alias or EZConnect)
- [ ] Enter OPA schema password
- [ ] Enter TMS schema password
- [ ] Enter RXC schema password
- [ ] Assign tablespaces: OPA_DATA for data, OPA_INDEX for indexes, TMS_DATA for TMS

**Post-installer steps:**
\`\`\`bash
# Run post-install SQL as SYSDBA
sqlplus / as sysdba @$OPA_HOME/install/oc_post_install.sql
\`\`\`

### 4.2 Verify Schema Installation

\`\`\`sql
-- Connect as OPA
-- Verify core tables
SELECT table_name, num_rows
FROM   all_tables
WHERE  owner = 'OPA'
AND    table_name IN (
  'RESPONSES', 'DCM_LAYOUTS', 'SUBJECTS', 'PATIENTS',
  'EVENTS', 'DCM_QUESTIONS', 'AUDITS', 'STUDY_DCM'
)
ORDER  BY table_name;

-- Verify indexes on RESPONSES (critical for query performance)
SELECT index_name, column_name, column_position
FROM   all_ind_columns
WHERE  table_owner = 'OPA'
AND    table_name  = 'RESPONSES'
ORDER  BY index_name, column_position;
\`\`\`

Expected indexes on RESPONSES: at minimum, indexes on (STUDY_ID), (PATIENT_POSITION, DCM_SUBSET_POSITION), and the primary key. Document all indexes in the IQ checklist.

### 4.3 Apply the Latest OC Patch Set

\`\`\`bash
# Verify current OC version before patching
sqlplus opa/[password] @$OPA_HOME/install/check_version.sql

# Apply patch set per Oracle Clinical patch installation instructions
# (patch-specific instructions vary — follow the README in the patch directory)
cd /stage/oc_patch_XXXXX
./apply_patch.sh
\`\`\`

**Verification after patch:**
\`\`\`sql
SELECT version_text FROM rxc.system_version ORDER BY install_date DESC;
\`\`\`
The current patch set version must appear as the most recent entry. Document in IQ checklist.

---

## Phase 5: Audit Trail Protection

### 5.1 Protect the AUDITS Table

\`\`\`sql
-- Revoke DML privileges on AUDITS from the OPA schema owner
-- (OPA triggers will continue to INSERT via the trigger owner's implicit privileges)
REVOKE DELETE ON opa.audits FROM opa;
REVOKE UPDATE ON opa.audits FROM opa;
REVOKE TRUNCATE ON opa.audits FROM opa;

-- Grant only SELECT to read-only reporting users
-- (do not grant any DML on AUDITS to any non-DBA account)

-- Enable FGA to log and alert on any DELETE attempt
BEGIN
  DBMS_FGA.ADD_POLICY(
    object_schema   => 'OPA',
    object_name     => 'AUDITS',
    policy_name     => 'FGA_AUDIT_DELETE',
    audit_condition => '1=1',
    audit_column    => 'RESPONSE_ID,AUDIT_DATE',
    handler_schema  => NULL,
    handler_module  => NULL,
    enable          => TRUE,
    statement_types => 'DELETE,UPDATE,TRUNCATE'
  );
END;
/

-- Verify FGA policy is active
SELECT object_schema, object_name, policy_name, enabled
FROM   dba_audit_policies
WHERE  object_schema = 'OPA'
AND    object_name   = 'AUDITS';
\`\`\`

**Verification test**: Attempt a DELETE from AUDITS as the OPA user — it must be rejected. Document the test and rejection in the IQ checklist.

### 5.2 Enable Database Auditing for DBA Actions

\`\`\`sql
-- Audit DBA account logins and DDL on clinical schemas
AUDIT SESSION WHENEVER NOT SUCCESSFUL;
AUDIT SELECT TABLE, INSERT TABLE, UPDATE TABLE, DELETE TABLE BY opa BY SESSION;
AUDIT CREATE TABLE, ALTER TABLE, DROP TABLE, TRUNCATE TABLE BY opa;
AUDIT CREATE TABLE, ALTER TABLE, DROP TABLE BY tms;

-- Verify audit settings
SELECT user_name, audit_option, success, failure
FROM   dba_stmt_audit_opts
WHERE  user_name IN ('OPA','TMS')
ORDER  BY user_name, audit_option;
\`\`\`

---

## Phase 6: RMAN Backup Configuration

### 6.1 RMAN Catalog Setup (Recommended for GxP Environments)

A recovery catalog provides complete backup history beyond the control file retention window — required for long-running studies where point-in-time recovery may need to reach back years.

\`\`\`sql
-- On a separate catalog database (not the OC production database)
CREATE USER rcat IDENTIFIED BY [password]
  DEFAULT TABLESPACE rcat_data
  QUOTA UNLIMITED ON rcat_data;

GRANT recovery_catalog_owner TO rcat;
\`\`\`

\`\`\`bash
# Register the OC database in the catalog
rman TARGET / CATALOG rcat/[password]@catdb
REGISTER DATABASE;
\`\`\`

### 6.2 RMAN Configuration

\`\`\`bash
rman TARGET / CATALOG rcat/[password]@catdb

-- Configure retention (90 days recommended for GxP; confirm with Records Management)
CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 90 DAYS;
CONFIGURE BACKUP OPTIMIZATION ON;

-- Configure compression for backup storage efficiency
CONFIGURE COMPRESSION ALGORITHM 'MEDIUM';
CONFIGURE DEVICE TYPE DISK PARALLELISM 4 BACKUP TYPE TO COMPRESSED BACKUPSET;

-- Archive log deletion policy — keep until backed up twice
CONFIGURE ARCHIVELOG DELETION POLICY TO BACKED UP 2 TIMES TO DISK;

-- Channel configuration for disk backups
CONFIGURE CHANNEL DEVICE TYPE DISK FORMAT '/rman/oc/%d_%T_%s_%p.bkp';
\`\`\`

### 6.3 Backup Script

Create \`/u01/app/oc/scripts/rman_backup.sh\`:

\`\`\`bash
#!/bin/bash
export ORACLE_SID=OCPROD
export ORACLE_HOME=/u01/app/oracle/product/19c/dbhome_1
export PATH=$ORACLE_HOME/bin:$PATH
LOG=/u01/app/oc/logs/rman_$(date +%Y%m%d_%H%M).log

rman TARGET / CATALOG rcat/[password]@catdb LOG $LOG <<EOF
RUN {
  ALLOCATE CHANNEL c1 DEVICE TYPE DISK;
  ALLOCATE CHANNEL c2 DEVICE TYPE DISK;
  ALLOCATE CHANNEL c3 DEVICE TYPE DISK;
  ALLOCATE CHANNEL c4 DEVICE TYPE DISK;
  -- Full database backup (weekly)
  BACKUP AS COMPRESSED BACKUPSET INCREMENTAL LEVEL 0
    DATABASE
    PLUS ARCHIVELOG DELETE INPUT
    TAG 'WEEKLY_FULL';
  -- Delete obsolete backups per retention policy
  DELETE NOPROMPT OBSOLETE;
  RELEASE CHANNEL c1;
  RELEASE CHANNEL c2;
  RELEASE CHANNEL c3;
  RELEASE CHANNEL c4;
}
EOF

# Check for errors in the log
if grep -i "error\|ORA-\|RMAN-" $LOG; then
  echo "RMAN backup completed with errors — review $LOG" | \
    mail -s "OC RMAN Backup Error $(date)" dba-alerts@yourcompany.com
fi
\`\`\`

Make executable and schedule via cron (weekly full, nightly incremental):

\`\`\`bash
chmod 750 /u01/app/oc/scripts/rman_backup.sh
# Crontab entry (as oracle user)
# Weekly full: Sunday 2am
0 2 * * 0 /u01/app/oc/scripts/rman_backup.sh
# Nightly incremental: Mon-Sat 2am
0 2 * * 1-6 /u01/app/oc/scripts/rman_incr_backup.sh
\`\`\`

**Verification**: Run the backup script manually and confirm completion without errors. Document backup location and completion time in the IQ checklist.

---

## Phase 7: Statistics Maintenance

### 7.1 Weekly Statistics Job

Create a scheduled statistics job for the OPA schema. Run during the Sunday maintenance window after the RMAN full backup completes.

\`\`\`sql
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'OC_GATHER_STATS_WEEKLY',
    job_type        => 'PLSQL_BLOCK',
    job_action      => '
      BEGIN
        DBMS_STATS.GATHER_SCHEMA_STATS(
          ownname          => ''OPA'',
          estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,
          method_opt       => ''FOR ALL COLUMNS SIZE AUTO'',
          degree           => 8,
          cascade          => TRUE,
          no_invalidate    => FALSE
        );
        DBMS_STATS.GATHER_SCHEMA_STATS(
          ownname          => ''TMS'',
          estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,
          method_opt       => ''FOR ALL COLUMNS SIZE AUTO'',
          degree           => 4,
          cascade          => TRUE,
          no_invalidate    => FALSE
        );
      END;
    ',
    start_date      => TRUNC(NEXT_DAY(SYSDATE, 'SUNDAY')) + 4/24,
    repeat_interval => 'FREQ=WEEKLY; BYDAY=SUN; BYHOUR=4',
    enabled         => TRUE,
    comments        => 'Weekly statistics gather for Oracle Clinical schemas'
  );
END;
/
\`\`\`

### 7.2 Stale Statistics Detection

Run this query before any period of heavy TMS coding or reporting activity to confirm statistics are current:

\`\`\`sql
SELECT table_name,
       last_analyzed,
       num_rows,
       ROUND((SYSDATE - last_analyzed), 1) AS days_since_analyze
FROM   dba_tables
WHERE  owner = 'OPA'
AND    table_name IN ('RESPONSES','AUDITS','DCM_LAYOUTS','SUBJECTS','EVENTS')
ORDER  BY last_analyzed NULLS FIRST;
\`\`\`

Any table with \`last_analyzed\` more than 7 days old during active data entry, or NULLS for \`last_analyzed\`, should have statistics gathered immediately.

---

## Phase 8: Ongoing Monitoring Queries

### 8.1 RESPONSES Table Growth Rate

Run monthly to project tablespace capacity:

\`\`\`sql
SELECT TO_CHAR(creation_date, 'YYYY-MM') AS month,
       COUNT(*)                           AS responses_created
FROM   opa.responses
WHERE  creation_date >= ADD_MONTHS(SYSDATE, -6)
GROUP  BY TO_CHAR(creation_date, 'YYYY-MM')
ORDER  BY month;
\`\`\`

### 8.2 Archive Log Generation Rate

\`\`\`sql
SELECT TO_CHAR(first_time, 'YYYY-MM-DD HH24') AS log_hour,
       COUNT(*)                                AS log_count,
       ROUND(SUM(blocks * block_size)/1024/1024) AS mb_generated
FROM   v$archived_log
WHERE  first_time > SYSDATE - 7
AND    standby_dest = 'NO'
GROUP  BY TO_CHAR(first_time, 'YYYY-MM-DD HH24')
ORDER  BY log_hour;
\`\`\`

### 8.3 Tablespace Usage

\`\`\`sql
SELECT df.tablespace_name,
       ROUND(df.total_mb, 0)      AS total_mb,
       ROUND(df.total_mb - fs.free_mb, 0) AS used_mb,
       ROUND(fs.free_mb, 0)       AS free_mb,
       ROUND((1 - fs.free_mb/df.total_mb) * 100, 1) AS pct_used
FROM  (SELECT tablespace_name, SUM(bytes)/1048576 AS total_mb
       FROM   dba_data_files GROUP BY tablespace_name) df
JOIN  (SELECT tablespace_name, SUM(bytes)/1048576 AS free_mb
       FROM   dba_free_space GROUP BY tablespace_name) fs
       ON fs.tablespace_name = df.tablespace_name
WHERE  df.tablespace_name IN ('OPA_DATA','OPA_INDEX','TMS_DATA','RXC_DATA')
ORDER  BY pct_used DESC;
\`\`\`

Alert threshold: 75% used → investigate growth rate. 85% used → add datafile immediately.

### 8.4 Audit Trail Completeness Check

Verify audit trail rows are being created for recent clinical data entry:

\`\`\`sql
-- Confirm audit rows exist for responses created in the last 24 hours
SELECT COUNT(r.response_id)          AS responses_today,
       COUNT(a.audit_id)             AS audits_today,
       CASE
         WHEN COUNT(r.response_id) > 0
          AND COUNT(a.audit_id) >= COUNT(r.response_id)
         THEN 'AUDIT TRAIL OK'
         ELSE 'AUDIT TRAIL GAP — INVESTIGATE'
       END AS status
FROM   opa.responses r
LEFT JOIN opa.audits a ON a.response_id = r.response_id
                       AND a.audit_date >= SYSDATE - 1
WHERE  r.creation_date >= SYSDATE - 1;
\`\`\`

Any result of \`AUDIT TRAIL GAP\` is a potential 21 CFR Part 11 deviation and must be investigated and documented immediately.

### 8.5 Long-Running Sessions (Coding and Reporting)

\`\`\`sql
SELECT s.sid,
       s.serial#,
       s.username,
       s.status,
       s.program,
       ROUND(q.elapsed_time / 1000000, 0) AS elapsed_sec,
       ROUND(q.cpu_time / 1000000, 0)      AS cpu_sec,
       SUBSTR(q.sql_text, 1, 80)           AS sql_text
FROM   v$session s
JOIN   v$sql q ON q.sql_id = s.sql_id
WHERE  s.username IN ('OPA', 'TMS', 'RXC')
AND    s.status = 'ACTIVE'
AND    q.elapsed_time / 1000000 > 60   -- sessions running more than 60 seconds
ORDER  BY elapsed_sec DESC;
\`\`\`

TMS automated coding sessions running more than 15 minutes typically indicate a missing index or stale statistics. Investigate before killing — TMS coding restarts cleanly from where it left off.

---

## Phase 9: IQ/OQ Verification Checklist

This checklist constitutes the Installation Qualification (IQ) record for the Oracle Clinical database installation. Each item must be checked, signed, and dated by the DBA performing the installation.

### IQ — Installation Qualification

| Item | Expected Value | Actual Value | Pass/Fail | DBA Initials |
|------|---------------|-------------|----------|-------------|
| OS version | Oracle Linux 8.x or RHEL 8.x | | | |
| Kernel parameter: kernel.shmmax | 137438953472 (or site value) | | | |
| Kernel parameter: kernel.sem | 250 32000 100 128 | | | |
| Oracle Database version | 19.x.x.x (confirm RU applied) | | | |
| Database character set | AL32UTF8 | | | |
| Database archive mode | ARCHIVELOG | | | |
| Parameter: _b_tree_bitmap_plans | FALSE | | | |
| Parameter: enable_ddl_logging | TRUE | | | |
| Tablespace OPA_DATA | Created, ONLINE | | | |
| Tablespace OPA_INDEX | Created, ONLINE | | | |
| Tablespace TMS_DATA | Created, ONLINE | | | |
| OC schema version | [current patch set] | | | |
| AUDITS table DELETE revoked from OPA | Confirmed via privilege query | | | |
| FGA policy on AUDITS | Active | | | |
| RMAN backup configured | First backup completed successfully | | | |
| Statistics job scheduled | Confirmed via DBA_SCHEDULER_JOBS | | | |
| NTP synchronization | Confirmed (chronyc tracking) | | | |
| Archive log destination accessible | Confirmed (test archive switch) | | | |

### OQ — Operational Qualification

| Test | Procedure | Expected Result | Actual Result | Pass/Fail |
|------|-----------|----------------|--------------|----------|
| User login to RDC Onsite | Log in as test user via browser | Login succeeds | | |
| CRF data entry | Enter test values on a test CRF | Data saved successfully | | |
| Audit trail creation | Enter data; query AUDITS for response_id | Audit row created with correct user and timestamp | | |
| Audit trail protection | Attempt DELETE from AUDITS as OPA user | ORA-01031: insufficient privileges | | |
| Archive switch | ALTER SYSTEM ARCHIVE LOG CURRENT | New archive log created at configured destination | | |
| RMAN backup verification | Run RMAN VALIDATE BACKUPSET | No corruption detected | | |
| Statistics gather | Execute GATHER_SCHEMA_STATS manually | Completes without error | | |
| Tablespace autoextend | Insert test data to confirm autoextend fires | Datafile size increases, no ORA-1536 | | |

---

## Common Issues and Resolutions

| Symptom | Root Cause | Resolution |
|---------|-----------|-----------|
| ORA-01017 on OC schema login | Schema password expired or incorrect | Reset password: ALTER USER opa IDENTIFIED BY [new]; update OC config |
| Audit trail rows missing for some responses | OC audit trigger disabled or invalid | Check ALL_TRIGGERS WHERE OWNER='OPA' AND TRIGGER_NAME LIKE '%AUDIT%' — recompile if INVALID |
| RESPONSES query full table scan despite index | Stale statistics or _b_tree_bitmap_plans=TRUE | Gather stats; confirm _b_tree_bitmap_plans=FALSE in v$parameter |
| TMS coding hanging | Long-running cursor not releasing | Check v$session for OPA/TMS sessions > 30 min; check for lock waits |
| Archive log destination full | Archive volume undersized | Add space immediately; delete already-backed-up archivelogs via RMAN DELETE ARCHIVELOG ALL BACKED UP 2 TIMES |
| WebLogic out of memory during peak coding | JVM heap undersized | Increase -Xmx in WebLogic start script; restart managed server during off-peak |
| ORA-04031 shared pool | Shared pool too small for OC metadata | Increase SHARED_POOL_SIZE; flush before resizing: ALTER SYSTEM FLUSH SHARED_POOL |
| OC installer fails at schema creation | TNS connectivity issue or tablespace missing | Verify tnsping OCPROD; confirm all tablespaces exist before re-running installer |`,
};

async function main() {
  console.log('Inserting Oracle Clinical installation runbook...');
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
