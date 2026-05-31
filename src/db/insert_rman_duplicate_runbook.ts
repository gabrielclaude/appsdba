import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: RMAN DUPLICATE FROM ACTIVE DATABASE for Physical Standby',
  slug: 'rman-duplicate-standby-runbook',
  excerpt:
    'Step-by-step operational runbook for building an Oracle physical standby database using RMAN DUPLICATE FROM ACTIVE DATABASE — covering pre-flight checks, primary preparation, standby init parameter setup, network configuration, the duplicate command, MRP startup, and post-build verification.',
  category: 'disaster-recovery' as const,
  published: true,
  publishedAt: new Date('2026-05-31'),
  youtubeUrl: null,
  content: `## Purpose

Produce a synchronized physical standby database from a live primary using **RMAN DUPLICATE FROM ACTIVE DATABASE** with no scheduled downtime on the primary.

---

## Scope and Assumptions

- Oracle Database 19c (procedure applies to 12.2+)
- Primary and standby on separate Linux hosts, same OS and patch level
- Oracle software installed on the standby host; database not yet created
- Passwordfile replication enabled (same SYS password on both nodes)
- Both hosts resolvable by hostname or TNS alias
- ARCHIVELOG mode and FORCE LOGGING enabled on primary

---

## Reference Variables

Throughout this runbook substitute your environment values for these placeholders:

\`\`\`
PRIMARY_DB_UNIQUE_NAME   = PRODDB
STANDBY_DB_UNIQUE_NAME   = PRODDB_STB
PRIMARY_HOST             = db-primary.example.com
STANDBY_HOST             = db-standby.example.com
PRIMARY_TNS_ALIAS        = PRODDB
STANDBY_TNS_ALIAS        = PRODDB_STB
ORACLE_SID (primary)     = PRODDB
ORACLE_SID (standby)     = PRODDB_STB
ORACLE_BASE              = /u01/app/oracle
ORACLE_HOME              = /u01/app/oracle/product/19.0.0/dbhome_1
DATA_DEST                = /u02/oradata/PRODDB_STB
FRA_DEST                 = /u03/fast_recovery_area/PRODDB_STB
\`\`\`

---

## Pre-Flight Checks

### 1. Verify ARCHIVELOG mode and FORCE LOGGING on primary

\`\`\`sql
-- Run as SYSDBA on primary
SELECT LOG_MODE FROM V$DATABASE;
SELECT FORCE_LOGGING FROM V$DATABASE;
\`\`\`

**Expected output:**

\`\`\`
LOG_MODE     FORCE_LOGGING
------------ -------------
ARCHIVELOG   YES
\`\`\`

If FORCE LOGGING is NO, enable it before proceeding:

\`\`\`sql
ALTER DATABASE FORCE LOGGING;
\`\`\`

### 2. Check supplemental logging (required for Active Data Guard reporting)

\`\`\`sql
SELECT SUPPLEMENTAL_LOG_DATA_MIN FROM V$DATABASE;
\`\`\`

### 3. Verify primary DB_UNIQUE_NAME and DB_NAME

\`\`\`sql
SELECT NAME, DB_UNIQUE_NAME, OPEN_MODE FROM V$DATABASE;
\`\`\`

### 4. Confirm passwordfile exists on primary

\`\`\`bash
# On primary host
ls -lh $ORACLE_HOME/dbs/orapwPRODDB
\`\`\`

### 5. Confirm Oracle software is installed and listener is up on standby host

\`\`\`bash
# On standby host
$ORACLE_HOME/bin/lsnrctl status
\`\`\`

### 6. Test cross-host connectivity (both directions)

\`\`\`bash
# From primary — ping standby TNS alias
tnsping PRODDB_STB

# From standby — ping primary TNS alias
tnsping PRODDB
\`\`\`

---

## Step 1 — Enable Standby Redo Logs on Primary

Standby Redo Logs (SRLs) are required for real-time apply. Size must match online redo log size. Count = (online redo log groups per thread + 1) per thread.

\`\`\`sql
-- Check current online redo log size
SELECT GROUP#, MEMBERS, BYTES/1024/1024 AS MB FROM V$LOG;

-- Add SRLs (adjust size and count to match your environment)
ALTER DATABASE ADD STANDBY LOGFILE THREAD 1
  GROUP 10 ('/u02/oradata/PRODDB/srl_t1g10.log') SIZE 200M;
ALTER DATABASE ADD STANDBY LOGFILE THREAD 1
  GROUP 11 ('/u02/oradata/PRODDB/srl_t1g11.log') SIZE 200M;
ALTER DATABASE ADD STANDBY LOGFILE THREAD 1
  GROUP 12 ('/u02/oradata/PRODDB/srl_t1g12.log') SIZE 200M;
ALTER DATABASE ADD STANDBY LOGFILE THREAD 1
  GROUP 13 ('/u02/oradata/PRODDB/srl_t1g13.log') SIZE 200M;

-- Verify
SELECT GROUP#, THREAD#, SEQUENCE#, STATUS, MEMBERS
FROM V$STANDBY_LOG;
\`\`\`

---

## Step 2 — Set Primary Archive Log Destination for Standby

\`\`\`sql
ALTER SYSTEM SET LOG_ARCHIVE_CONFIG='DG_CONFIG=(PRODDB,PRODDB_STB)' SCOPE=BOTH;

ALTER SYSTEM SET LOG_ARCHIVE_DEST_2=
  'SERVICE=PRODDB_STB ASYNC VALID_FOR=(ONLINE_LOGFILES,PRIMARY_ROLE)
   DB_UNIQUE_NAME=PRODDB_STB REOPEN=15 MAX_FAILURE=3'
  SCOPE=BOTH;

ALTER SYSTEM SET LOG_ARCHIVE_DEST_STATE_2=ENABLE SCOPE=BOTH;

ALTER SYSTEM SET FAL_SERVER=PRODDB_STB SCOPE=BOTH;
ALTER SYSTEM SET FAL_CLIENT=PRODDB    SCOPE=BOTH;

ALTER SYSTEM SET STANDBY_FILE_MANAGEMENT=AUTO SCOPE=BOTH;
\`\`\`

---

## Step 3 — Create the Standby Init Parameter File

### 3a. On primary — create a pfile from spfile

\`\`\`bash
# On primary
sqlplus / as sysdba <<'EOF'
CREATE PFILE='/tmp/initPRODDB_STB.ora' FROM SPFILE;
EXIT;
EOF
\`\`\`

### 3b. Edit the pfile — key parameters to change or add

\`\`\`bash
vi /tmp/initPRODDB_STB.ora
\`\`\`

Replace or set these values (remove any existing conflicting entries):

\`\`\`
*.db_unique_name='PRODDB_STB'
*.db_file_name_convert='/u02/oradata/PRODDB','/u02/oradata/PRODDB_STB'
*.log_file_name_convert='/u02/oradata/PRODDB','/u02/oradata/PRODDB_STB'
*.fal_server='PRODDB'
*.fal_client='PRODDB_STB'
*.log_archive_config='DG_CONFIG=(PRODDB,PRODDB_STB)'
*.log_archive_dest_1='LOCATION=USE_DB_RECOVERY_FILE_DEST VALID_FOR=(ALL_LOGFILES,ALL_ROLES)'
*.log_archive_dest_2='SERVICE=PRODDB ASYNC VALID_FOR=(ONLINE_LOGFILES,PRIMARY_ROLE) DB_UNIQUE_NAME=PRODDB'
*.log_archive_dest_state_1=ENABLE
*.log_archive_dest_state_2=ENABLE
*.standby_file_management=AUTO
*.db_recovery_file_dest='/u03/fast_recovery_area/PRODDB_STB'
*.db_recovery_file_dest_size=50G
\`\`\`

### 3c. Copy pfile to standby host

\`\`\`bash
scp /tmp/initPRODDB_STB.ora oracle@db-standby.example.com:$ORACLE_HOME/dbs/initPRODDB_STB.ora
\`\`\`

### 3d. Copy passwordfile to standby host

\`\`\`bash
scp $ORACLE_HOME/dbs/orapwPRODDB oracle@db-standby.example.com:$ORACLE_HOME/dbs/orapwPRODDB_STB
\`\`\`

---

## Step 4 — Create Directories on Standby Host

\`\`\`bash
# On standby host as oracle OS user
mkdir -p /u02/oradata/PRODDB_STB
mkdir -p /u03/fast_recovery_area/PRODDB_STB
mkdir -p $ORACLE_BASE/admin/PRODDB_STB/adump
mkdir -p $ORACLE_BASE/admin/PRODDB_STB/bdump
mkdir -p $ORACLE_BASE/admin/PRODDB_STB/udump
\`\`\`

---

## Step 5 — Configure Oracle Net (tnsnames.ora and listener.ora)

### 5a. Add both databases to tnsnames.ora on BOTH hosts

\`\`\`
# $ORACLE_HOME/network/admin/tnsnames.ora

PRODDB =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = db-primary.example.com)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = PRODDB)
    )
  )

PRODDB_STB =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = db-standby.example.com)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = PRODDB_STB)
      (UR = A)
    )
  )
\`\`\`

> **Note:** \`(UR = A)\` allows connections when the standby instance is in MOUNTED state (required for DUPLICATE).

### 5b. Add static listener entry on standby host

\`\`\`
# $ORACLE_HOME/network/admin/listener.ora on standby host

LISTENER =
  (DESCRIPTION_LIST =
    (DESCRIPTION =
      (ADDRESS = (PROTOCOL = TCP)(HOST = db-standby.example.com)(PORT = 1521))
    )
  )

SID_LIST_LISTENER =
  (SID_LIST =
    (SID_DESC =
      (GLOBAL_DBNAME = PRODDB_STB)
      (ORACLE_HOME   = /u01/app/oracle/product/19.0.0/dbhome_1)
      (SID_NAME      = PRODDB_STB)
    )
  )
\`\`\`

### 5c. Reload listener on standby

\`\`\`bash
lsnrctl reload
lsnrctl status
\`\`\`

---

## Step 6 — Start Standby Instance in NOMOUNT

\`\`\`bash
# On standby host
export ORACLE_SID=PRODDB_STB

sqlplus / as sysdba <<'EOF'
STARTUP NOMOUNT PFILE='$ORACLE_HOME/dbs/initPRODDB_STB.ora';
EXIT;
EOF
\`\`\`

**Expected alert log message:**

\`\`\`
NOMOUNT mode: Instance started but not yet mounted
\`\`\`

### Verify standby is reachable from primary

\`\`\`bash
# On primary host
sqlplus sys/SYS_PASSWORD@PRODDB_STB as sysdba <<'EOF'
SELECT STATUS FROM V$INSTANCE;
EXIT;
EOF
\`\`\`

**Expected:** \`STATUS = STARTED\`

---

## Step 7 — Run RMAN DUPLICATE FROM ACTIVE DATABASE

Run from the **primary host** as the oracle OS user.

\`\`\`bash
# On primary host
rman <<'EOF'
CONNECT TARGET sys/SYS_PASSWORD@PRODDB;
CONNECT AUXILIARY sys/SYS_PASSWORD@PRODDB_STB;

DUPLICATE TARGET DATABASE
  FOR STANDBY
  FROM ACTIVE DATABASE
  DORECOVER
  SPFILE
    SET db_unique_name='PRODDB_STB'
    SET db_file_name_convert='/u02/oradata/PRODDB','/u02/oradata/PRODDB_STB'
    SET log_file_name_convert='/u02/oradata/PRODDB','/u02/oradata/PRODDB_STB'
    SET fal_server='PRODDB'
    SET fal_client='PRODDB_STB'
    SET log_archive_config='DG_CONFIG=(PRODDB,PRODDB_STB)'
    SET log_archive_dest_1='LOCATION=USE_DB_RECOVERY_FILE_DEST VALID_FOR=(ALL_LOGFILES,ALL_ROLES)'
    SET log_archive_dest_2='SERVICE=PRODDB ASYNC VALID_FOR=(ONLINE_LOGFILES,PRIMARY_ROLE) DB_UNIQUE_NAME=PRODDB'
    SET standby_file_management='AUTO'
    SET db_recovery_file_dest='/u03/fast_recovery_area/PRODDB_STB'
    SET db_recovery_file_dest_size='50G'
  NOFILENAMECHECK;

EXIT;
EOF
\`\`\`

**Expected final RMAN output:**

\`\`\`
Finished Duplicate Db at DD-MON-YY HH:MI:SS
\`\`\`

**Duration:** Depends on DB size and network bandwidth. Plan for ~1 GB/min over 1 Gbps.

---

## Step 8 — Start Managed Recovery Process (MRP)

\`\`\`sql
-- On standby host as SYSDBA
-- Real-time apply (recommended — requires Standby Redo Logs)
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE
  USING CURRENT LOGFILE DISCONNECT FROM SESSION;

-- Verify MRP is running
SELECT PROCESS, STATUS, THREAD#, SEQUENCE#, BLOCK#
FROM V$MANAGED_STANDBY
WHERE PROCESS IN ('MRP0','RFS')
ORDER BY PROCESS;
\`\`\`

**Expected:**

\`\`\`
PROCESS  STATUS      THREAD#  SEQUENCE#
-------- ----------- -------- ---------
MRP0     APPLYING_LOG    1      <current>
RFS      RECEIVING        1      <current>
RFS      IDLE             0      0
\`\`\`

---

## Step 9 — Post-Build Verification

### 9a. Confirm database role

\`\`\`sql
-- On standby
SELECT DB_UNIQUE_NAME, DATABASE_ROLE, OPEN_MODE, PROTECTION_MODE
FROM V$DATABASE;
\`\`\`

**Expected:**

\`\`\`
DB_UNIQUE_NAME  DATABASE_ROLE   OPEN_MODE    PROTECTION_MODE
--------------  --------------  -----------  -------------------
PRODDB_STB      PHYSICAL STANDBY MOUNTED     MAXIMUM PERFORMANCE
\`\`\`

### 9b. Check apply lag

\`\`\`sql
SELECT NAME, VALUE, TIME_COMPUTED
FROM V$DATAGUARD_STATS
WHERE NAME IN ('transport lag','apply lag');
\`\`\`

**Expected:** Both lags at or near \`+00 00:00:00\` within a few minutes of MRP startup.

### 9c. Verify archive shipping from primary

\`\`\`sql
-- On primary — confirm DEST_2 is transmitting
SELECT DEST_ID, STATUS, TARGET, ARCHIVER, SCHEDULE, DESTINATION, ERROR
FROM V$ARCHIVE_DEST
WHERE DEST_ID = 2;
\`\`\`

**Expected:** \`STATUS = VALID\`, \`ERROR\` is blank.

### 9d. Check for archive gaps

\`\`\`sql
-- On standby
SELECT THREAD#, LOW_SEQUENCE#, HIGH_SEQUENCE#
FROM V$ARCHIVE_GAP;
\`\`\`

**Expected:** No rows returned. If gaps exist, see Troubleshooting below.

### 9e. Confirm spfile is active on standby

\`\`\`sql
-- On standby
SELECT NAME, VALUE FROM V$PARAMETER
WHERE NAME IN (
  'db_unique_name',
  'fal_server',
  'standby_file_management',
  'log_archive_config'
);
\`\`\`

---

## Step 10 — Convert Standby to Use SPFILE Permanently

\`\`\`bash
# On standby host
export ORACLE_SID=PRODDB_STB

sqlplus / as sysdba <<'EOF'
CREATE SPFILE FROM MEMORY;
SHUTDOWN IMMEDIATE;
STARTUP MOUNT;
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE
  USING CURRENT LOGFILE DISCONNECT FROM SESSION;
EXIT;
EOF
\`\`\`

After this step the standby uses its own spfile on disk; the pfile used for the duplicate is no longer needed.

---

## Step 11 — Register Standby with Data Guard Broker (Optional but Recommended)

\`\`\`sql
-- On primary as SYSDBA
ALTER SYSTEM SET DG_BROKER_START=TRUE SCOPE=BOTH;

-- On standby as SYSDBA
ALTER SYSTEM SET DG_BROKER_START=TRUE SCOPE=BOTH;
\`\`\`

\`\`\`bash
# On primary host
dgmgrl sys/SYS_PASSWORD@PRODDB <<'EOF'
CREATE CONFIGURATION my_dg_config AS
  PRIMARY DATABASE IS PRODDB
  CONNECT IDENTIFIER IS PRODDB;

ADD DATABASE PRODDB_STB AS
  CONNECT IDENTIFIER IS PRODDB_STB
  MAINTAINED AS PHYSICAL;

ENABLE CONFIGURATION;

SHOW CONFIGURATION;
SHOW DATABASE VERBOSE PRODDB;
SHOW DATABASE VERBOSE PRODDB_STB;
EXIT;
EOF
\`\`\`

**Expected SHOW CONFIGURATION output:**

\`\`\`
Configuration - my_dg_config
  Protection Mode: MaxPerformance
  Members:
  PRODDB     - Primary database
  PRODDB_STB - Physical standby database
Fast-Start Failover:  Disabled
Configuration Status:
SUCCESS
\`\`\`

---

## Troubleshooting

### Archive gap after DUPLICATE

\`\`\`sql
-- On standby — identify missing sequences
SELECT THREAD#, LOW_SEQUENCE#, HIGH_SEQUENCE# FROM V$ARCHIVE_GAP;

-- On primary — manually push missing archives
ALTER SYSTEM ARCHIVE LOG CURRENT;

-- If FAL auto-fetch does not resolve the gap within 5 minutes,
-- manually register archives on standby
ALTER DATABASE REGISTER PHYSICAL LOGFILE '/path/to/archive/arch_1_NNN.arc';
\`\`\`

### MRP not starting — ORA-01152 or ORA-01110

\`\`\`sql
-- Check alert log for specific file errors
-- Ensure STANDBY_FILE_MANAGEMENT=AUTO and directories exist
SHOW PARAMETER standby_file_management;

-- Check for missing datafiles
SELECT FILE#, STATUS, NAME FROM V$DATAFILE WHERE STATUS != 'ONLINE';
\`\`\`

### RFS not receiving — transport not connecting

\`\`\`bash
# On primary — test connection to standby listener
tnsping PRODDB_STB

# Confirm standby static listener entry is present
lsnrctl status | grep PRODDB_STB

# Check primary DEST_2 error column
sqlplus / as sysdba -s <<'EOF'
SELECT ERROR FROM V$ARCHIVE_DEST WHERE DEST_ID=2;
EOF
\`\`\`

### RMAN-05501 / RMAN-05537 — auxiliary instance not reachable

- Confirm standby is in NOMOUNT and listener has static SID entry
- Confirm \`(UR = A)\` is in standby TNS entry
- Confirm passwordfiles match (same SYS password, same format)

### Disk space exhausted on standby during DUPLICATE

RMAN copies all datafiles; ensure standby DATA mount has at least 1.2x the primary datafile footprint free:

\`\`\`bash
# On primary — check datafile total size
sqlplus -s / as sysdba <<'EOF'
SELECT ROUND(SUM(BYTES)/1024/1024/1024,1) AS TOTAL_GB FROM DBA_DATA_FILES;
EOF

# On standby — check available space
df -h /u02/oradata
\`\`\`

---

## Rollback

If the duplicate fails mid-run or the standby must be decommissioned:

\`\`\`bash
# On standby host — shut down and remove all files
sqlplus / as sysdba <<'EOF'
SHUTDOWN ABORT;
EXIT;
EOF

rm -rf /u02/oradata/PRODDB_STB/*
rm -rf /u03/fast_recovery_area/PRODDB_STB/*
rm -f  $ORACLE_HOME/dbs/spfilePRODDB_STB.ora
rm -f  $ORACLE_HOME/dbs/initPRODDB_STB.ora
rm -f  $ORACLE_HOME/dbs/orapwPRODDB_STB
\`\`\`

On primary — disable and clear DEST_2:

\`\`\`sql
ALTER SYSTEM SET LOG_ARCHIVE_DEST_STATE_2=DEFER SCOPE=BOTH;
ALTER SYSTEM SET LOG_ARCHIVE_DEST_2='' SCOPE=BOTH;
\`\`\`

---

## Quick Reference — Ongoing Operations

\`\`\`sql
-- Stop MRP
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE CANCEL;

-- Restart MRP with real-time apply
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE
  USING CURRENT LOGFILE DISCONNECT FROM SESSION;

-- Open standby read-only (Active Data Guard license required)
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE CANCEL;
ALTER DATABASE OPEN READ ONLY;
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE
  USING CURRENT LOGFILE DISCONNECT FROM SESSION;

-- Planned switchover (DGMGRL)
SWITCHOVER TO PRODDB_STB;

-- Emergency failover (DGMGRL)
FAILOVER TO PRODDB_STB;
\`\`\``,
};

async function main() {
  console.log('Inserting RMAN duplicate standby runbook post...');
  await db.insert(posts).values(post).onConflictDoNothing();
  console.log(`Inserted: "${post.title}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
