import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS 12.2.11 Data Guard Configuration and Operations Runbook',
  slug: 'oracle-ebs-12211-data-guard-runbook',
  excerpt:
    'Step-by-step runbook for configuring and operating Oracle Data Guard for EBS 12.2.11: primary database preparation (LOG_ARCHIVE_CONFIG, FAL_SERVER, standby redo logs, Flashback Database), RMAN active duplicate to build the physical standby, Data Guard Broker configuration with DGMGRL, EBS application tier TNS and AutoConfig for post-failover reconnection, planned switchover procedure, emergency failover procedure, application tier recovery after failover, and monitoring scripts for redo lag, transport status, and apply lag with alerting thresholds.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-29'),
  youtubeUrl: null,
  content: `## Overview

This runbook covers the complete procedure for configuring Oracle Data Guard physical standby for an EBS 12.2.11 database tier, operating the configuration through planned switchovers and emergency failovers, and recovering the EBS application tier after a role change.

**Assumptions**:
- Primary: Oracle Database 19c, SID EBSPRD, host ebsprd01.example.com, ORACLE_HOME /u01/app/oracle/product/19.0.0/dbhome_1
- Standby: Oracle Database 19c installed (same ORACLE_HOME path), no database created, host ebsstb01.example.com
- Both servers can reach each other on port 1521
- ARCHIVELOG mode is enabled on the primary
- A dedicated redo transport network is available (recommended) or the same network as the application

---

## Phase 1: Prepare the Primary Database

### 1.1 Verify ARCHIVELOG Mode and Flashback Database

\`\`\`sql
-- Connect as SYS on the primary
export ORACLE_SID=EBSPRD
sqlplus / as sysdba

SELECT LOG_MODE, FLASHBACK_ON FROM V\$DATABASE;
-- Required: LOG_MODE = ARCHIVELOG, FLASHBACK_ON = YES (for snapshot standby DR tests)

-- Enable ARCHIVELOG mode if not already on (requires restart)
SHUTDOWN IMMEDIATE;
STARTUP MOUNT;
ALTER DATABASE ARCHIVELOG;
ALTER DATABASE OPEN;

-- Enable Flashback Database (set FRA size first)
ALTER SYSTEM SET DB_RECOVERY_FILE_DEST_SIZE=200G SCOPE=BOTH;
ALTER SYSTEM SET DB_RECOVERY_FILE_DEST='/u04/fra/EBSPRD' SCOPE=BOTH;
ALTER DATABASE FLASHBACK ON;
\`\`\`

### 1.2 Set Primary Data Guard Parameters

\`\`\`sql
-- DB_UNIQUE_NAME (must be set even if same as DB_NAME for Broker)
ALTER SYSTEM SET DB_UNIQUE_NAME='EBSPRD' SCOPE=SPFILE;

-- Enable Data Guard redo log archiving
ALTER SYSTEM SET LOG_ARCHIVE_CONFIG='DG_CONFIG=(EBSPRD,EBSPRD_STB)' SCOPE=BOTH;

-- Local archive destination
ALTER SYSTEM SET LOG_ARCHIVE_DEST_1=
  'LOCATION=USE_DB_RECOVERY_FILE_DEST
   VALID_FOR=(ALL_LOGFILES,ALL_ROLES)
   DB_UNIQUE_NAME=EBSPRD' SCOPE=BOTH;

-- Remote destination: standby (async initially — switch to sync after standby is created)
ALTER SYSTEM SET LOG_ARCHIVE_DEST_2=
  'SERVICE=EBSPRD_STB ASYNC
   VALID_FOR=(ONLINE_LOGFILES,PRIMARY_ROLE)
   DB_UNIQUE_NAME=EBSPRD_STB
   COMPRESSION=ENABLE' SCOPE=BOTH;

ALTER SYSTEM SET LOG_ARCHIVE_DEST_STATE_2=ENABLE SCOPE=BOTH;

-- FAL (Fetch Archive Log) settings for gap resolution
ALTER SYSTEM SET FAL_SERVER='EBSPRD_STB' SCOPE=BOTH;
ALTER SYSTEM SET FAL_CLIENT='EBSPRD' SCOPE=BOTH;

-- Standby file management: AUTO creates datafiles on standby when added to primary
ALTER SYSTEM SET STANDBY_FILE_MANAGEMENT=AUTO SCOPE=BOTH;

-- Enable forced logging to ensure all changes are captured in redo
ALTER DATABASE FORCE LOGGING;

-- Verify
SELECT FORCE_LOGGING FROM V\$DATABASE;
\`\`\`

### 1.3 Create Online and Standby Redo Logs on the Primary

\`\`\`sql
-- Check current redo log configuration
SELECT GROUP#, MEMBERS, BYTES/1024/1024 AS MB, STATUS FROM V\$LOG ORDER BY GROUP#;

-- Add standby redo logs on the primary (needed when primary becomes standby after switchover)
-- Rule: same size as largest online redo log, one more group than online redo log groups
-- Example: 4 online redo log groups of 512 MB → add 5 SRL groups of 512 MB

ALTER DATABASE ADD STANDBY LOGFILE GROUP 11
  ('/u03/redo/EBSPRD/srl_t1_g11.log') SIZE 512M;
ALTER DATABASE ADD STANDBY LOGFILE GROUP 12
  ('/u03/redo/EBSPRD/srl_t1_g12.log') SIZE 512M;
ALTER DATABASE ADD STANDBY LOGFILE GROUP 13
  ('/u03/redo/EBSPRD/srl_t1_g13.log') SIZE 512M;
ALTER DATABASE ADD STANDBY LOGFILE GROUP 14
  ('/u03/redo/EBSPRD/srl_t1_g14.log') SIZE 512M;
ALTER DATABASE ADD STANDBY LOGFILE GROUP 15
  ('/u03/redo/EBSPRD/srl_t1_g15.log') SIZE 512M;

-- Verify standby redo logs
SELECT GROUP#, BYTES/1024/1024 AS MB, STATUS FROM V\$STANDBY_LOG ORDER BY GROUP#;
\`\`\`

### 1.4 Create the Standby Password File

\`\`\`bash
# Copy the primary password file to the standby (must be identical)
# The SYS password must match on primary and standby for redo transport authentication
scp /u01/app/oracle/product/19.0.0/dbhome_1/dbs/orapwEBSPRD \\
    oracle@ebsstb01:/u01/app/oracle/product/19.0.0/dbhome_1/dbs/orapwEBSPRD
\`\`\`

---

## Phase 2: Prepare the Standby Server

### 2.1 Create the Standby SPFILE Skeleton

\`\`\`bash
# On the STANDBY server as oracle
export ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_SID=EBSPRD

# Create directory structure matching the primary
mkdir -p /u01/app/oracle/admin/EBSPRD/adump
mkdir -p /u02/oradata/EBSPRD
mkdir -p /u03/redo/EBSPRD
mkdir -p /u04/fra/EBSPRD

# Create a minimal init.ora for the auxiliary nomount stage
cat > \${ORACLE_HOME}/dbs/initEBSPRD.ora << 'EOF'
db_name=EBSPRD
db_unique_name=EBSPRD_STB
sga_target=4G
pga_aggregate_target=1G
audit_file_dest=/u01/app/oracle/admin/EBSPRD/adump
audit_trail=NONE
compatible=19.0.0
EOF
\`\`\`

### 2.2 Configure Listeners and TNS on Both Servers

On the **standby server**:

\`\`\`bash
cat > \${ORACLE_HOME}/network/admin/listener.ora << 'EOF'
LISTENER =
  (DESCRIPTION_LIST =
    (DESCRIPTION =
      (ADDRESS = (PROTOCOL = TCP)(HOST = ebsstb01.example.com)(PORT = 1521))
    )
  )

SID_LIST_LISTENER =
  (SID_LIST =
    (SID_DESC =
      (GLOBAL_DBNAME = EBSPRD_STB)
      (ORACLE_HOME = /u01/app/oracle/product/19.0.0/dbhome_1)
      (SID_NAME = EBSPRD)
    )
    (SID_DESC =
      (GLOBAL_DBNAME = EBSPRD_STB_DGMGRL)
      (ORACLE_HOME = /u01/app/oracle/product/19.0.0/dbhome_1)
      (SID_NAME = EBSPRD)
    )
  )
EOF

lsnrctl start
\`\`\`

On **both servers**, add entries to tnsnames.ora:

\`\`\`bash
cat >> \${ORACLE_HOME}/network/admin/tnsnames.ora << 'EOF'

EBSPRD =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = ebsprd01.example.com)(PORT = 1521))
    (CONNECT_DATA = (SERVER = DEDICATED)(SERVICE_NAME = EBSPRD))
  )

EBSPRD_STB =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = ebsstb01.example.com)(PORT = 1521))
    (CONNECT_DATA = (SERVER = DEDICATED)(SERVICE_NAME = EBSPRD_STB))
  )
EOF

# Test connectivity from standby to primary and vice versa
tnsping EBSPRD
tnsping EBSPRD_STB
\`\`\`

---

## Phase 3: Build the Physical Standby — RMAN Active Duplicate

### 3.1 Start the Auxiliary Instance on the Standby

\`\`\`bash
# On the STANDBY server
export ORACLE_SID=EBSPRD

sqlplus / as sysdba << 'SQL'
STARTUP NOMOUNT PFILE='/u01/app/oracle/product/19.0.0/dbhome_1/dbs/initEBSPRD.ora';
EXIT;
SQL
\`\`\`

### 3.2 Run RMAN Active Duplicate for Standby

Run from the **standby server**. This streams the full database from primary to standby while the primary remains live.

\`\`\`bash
export ORACLE_SID=EBSPRD

rman << 'RMAN_EOF'
CONNECT TARGET sys/\${SYS_PASSWORD}@EBSPRD;
CONNECT AUXILIARY sys/\${SYS_PASSWORD}@EBSPRD_STB;

DUPLICATE TARGET DATABASE
  FOR STANDBY
  FROM ACTIVE DATABASE
  USING BACKUPSET
  DORECOVER
  SPFILE
    SET DB_UNIQUE_NAME='EBSPRD_STB'
    SET LOG_ARCHIVE_CONFIG='DG_CONFIG=(EBSPRD,EBSPRD_STB)'
    SET LOG_ARCHIVE_DEST_1='LOCATION=USE_DB_RECOVERY_FILE_DEST VALID_FOR=(ALL_LOGFILES,ALL_ROLES) DB_UNIQUE_NAME=EBSPRD_STB'
    SET LOG_ARCHIVE_DEST_2='SERVICE=EBSPRD ASYNC VALID_FOR=(ONLINE_LOGFILES,PRIMARY_ROLE) DB_UNIQUE_NAME=EBSPRD COMPRESSION=ENABLE'
    SET LOG_ARCHIVE_DEST_STATE_2='ENABLE'
    SET FAL_SERVER='EBSPRD'
    SET FAL_CLIENT='EBSPRD_STB'
    SET STANDBY_FILE_MANAGEMENT='AUTO'
    SET DB_FILE_NAME_CONVERT='/u02/oradata/EBSPRD/','/u02/oradata/EBSPRD/'
    SET LOG_FILE_NAME_CONVERT='/u03/redo/EBSPRD/','/u03/redo/EBSPRD/'
    SET AUDIT_FILE_DEST='/u01/app/oracle/admin/EBSPRD/adump'
    SET DB_RECOVERY_FILE_DEST='/u04/fra/EBSPRD'
    SET DB_RECOVERY_FILE_DEST_SIZE='200G'
    SET DIAGNOSTIC_DEST='/u01/app/oracle'
  NOFILENAMECHECK;
EXIT;
RMAN_EOF
\`\`\`

### 3.3 Add Standby Redo Logs on the Standby

\`\`\`sql
-- After duplicate completes, connect to the standby (still in MOUNT state)
export ORACLE_SID=EBSPRD
sqlplus / as sysdba

-- Add SRLs on the standby (same count and size as those added on the primary)
ALTER DATABASE ADD STANDBY LOGFILE GROUP 11
  ('/u03/redo/EBSPRD/srl_t1_g11.log') SIZE 512M;
ALTER DATABASE ADD STANDBY LOGFILE GROUP 12
  ('/u03/redo/EBSPRD/srl_t1_g12.log') SIZE 512M;
ALTER DATABASE ADD STANDBY LOGFILE GROUP 13
  ('/u03/redo/EBSPRD/srl_t1_g13.log') SIZE 512M;
ALTER DATABASE ADD STANDBY LOGFILE GROUP 14
  ('/u03/redo/EBSPRD/srl_t1_g14.log') SIZE 512M;
ALTER DATABASE ADD STANDBY LOGFILE GROUP 15
  ('/u03/redo/EBSPRD/srl_t1_g15.log') SIZE 512M;

-- Verify standby redo logs
SELECT GROUP#, BYTES/1024/1024 AS MB, STATUS FROM V\$STANDBY_LOG ORDER BY GROUP#;
\`\`\`

### 3.4 Start Managed Recovery

\`\`\`sql
-- On the STANDBY — start real-time apply
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE
  USING CURRENT LOGFILE DISCONNECT FROM SESSION;

-- Verify MRP0 is running
SELECT PROCESS, STATUS, THREAD#, SEQUENCE#, BLOCK#, BLOCKS
FROM V\$MANAGED_STANDBY
WHERE PROCESS IN ('MRP0','RFS')
ORDER BY PROCESS;
\`\`\`

---

## Phase 4: Configure Data Guard Broker

### 4.1 Enable the Broker on Both Databases

\`\`\`sql
-- On PRIMARY
ALTER SYSTEM SET DG_BROKER_START=TRUE SCOPE=BOTH;
ALTER SYSTEM SET DG_BROKER_CONFIG_FILE1='/u04/fra/EBSPRD/dr1EBSPRD.dat' SCOPE=BOTH;
ALTER SYSTEM SET DG_BROKER_CONFIG_FILE2='/u04/fra/EBSPRD/dr2EBSPRD.dat' SCOPE=BOTH;

-- On STANDBY
ALTER SYSTEM SET DG_BROKER_START=TRUE SCOPE=BOTH;
ALTER SYSTEM SET DG_BROKER_CONFIG_FILE1='/u04/fra/EBSPRD/dr1EBSPRD.dat' SCOPE=BOTH;
ALTER SYSTEM SET DG_BROKER_CONFIG_FILE2='/u04/fra/EBSPRD/dr2EBSPRD.dat' SCOPE=BOTH;
\`\`\`

### 4.2 Create the Broker Configuration

\`\`\`bash
# Run DGMGRL from the PRIMARY server
dgmgrl sys/\${SYS_PASSWORD}@EBSPRD << 'DGMGRL_EOF'

-- Create the configuration
CREATE CONFIGURATION ebs_dg_config
  AS PRIMARY DATABASE IS EBSPRD
  CONNECT IDENTIFIER IS EBSPRD;

-- Add the standby database
ADD DATABASE EBSPRD_STB
  AS CONNECT IDENTIFIER IS EBSPRD_STB
  MAINTAINED AS PHYSICAL;

-- Enable the configuration
ENABLE CONFIGURATION;

-- Verify
SHOW CONFIGURATION;
SHOW DATABASE VERBOSE EBSPRD;
SHOW DATABASE VERBOSE EBSPRD_STB;

EXIT;
DGMGRL_EOF
\`\`\`

### 4.3 Set Maximum Availability Protection Mode

\`\`\`bash
dgmgrl sys/\${SYS_PASSWORD}@EBSPRD << 'DGMGRL_EOF'

-- Set synchronous transport on the standby
EDIT DATABASE EBSPRD_STB SET PROPERTY LogXptMode=SYNC;
EDIT DATABASE EBSPRD_STB SET PROPERTY RedoRoutes='(EBSPRD:SYNC)';

-- Set protection mode
EDIT CONFIGURATION SET PROTECTION MODE AS MaxAvailability;

-- Verify protection mode and transport
SHOW CONFIGURATION;
SHOW DATABASE EBSPRD_STB;

EXIT;
DGMGRL_EOF
\`\`\`

### 4.4 Verify Synchronization

\`\`\`sql
-- On the PRIMARY — check redo transport status
SELECT DEST_ID, STATUS, TARGET, ARCHIVER, SCHEDULE,
       DESTINATION, ERROR
FROM V\$ARCHIVE_DEST
WHERE STATUS = 'VALID'
ORDER BY DEST_ID;

-- Check for any transport errors
SELECT DEST_ID, STATUS, ERROR FROM V\$ARCHIVE_DEST
WHERE TARGET = 'STANDBY' AND STATUS != 'VALID';

-- Check apply lag on standby
SELECT NAME, VALUE, DATUM_TIME
FROM V\$DATAGUARD_STATS
WHERE NAME IN ('apply lag','transport lag','estimated startup time')
ORDER BY NAME;
\`\`\`

---

## Phase 5: Configure EBS Application Tier TNS for Data Guard

### 5.1 Update EBS Context File with Standby Service

\`\`\`bash
# On the EBS application tier
source /u01/oracle/EBS/EBSapps.env run

# The primary context file should reference the primary database service
# Additionally, add a DG_SERVICE entry for awareness of the standby
# Edit the context file: \${INST_TOP}/appl/admin/\${CONTEXT_NAME}.xml
# Locate and verify: s_dbSid = EBSPRD, s_dbhost = ebsprd01.example.com

# Add a manual TNS entry for the standby for DBA use (not used by EBS automatically)
cat >> \${ORACLE_HOME}/network/admin/tnsnames.ora << 'EOF'

# EBS Data Guard standby — for DBA testing and manual DR operations
EBSPRD_STB_DBA =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = ebsstb01.example.com)(PORT = 1521))
    (CONNECT_DATA = (SERVER = DEDICATED)(SERVICE_NAME = EBSPRD_STB))
  )
EOF
\`\`\`

### 5.2 Document the Post-Failover AutoConfig Procedure

Create and store this procedure for use during a failover:

\`\`\`bash
# POST-FAILOVER: Run this on the EBS application tier after a Data Guard failover
# Updates the EBS context to point to the new primary (the former standby server)

# Step 1: Update context file — change primary DB hostname
CONTEXT_FILE=\${INST_TOP}/appl/admin/\${CONTEXT_NAME}.xml
NEW_DB_HOST=ebsstb01.example.com   # the former standby server is now primary
NEW_DB_SID=EBSPRD                  # SID remains the same

# Edit the context file (use sed or manually edit with vi)
# Change s_dbhost from ebsprd01.example.com to ebsstb01.example.com
vi \${CONTEXT_FILE}
# Search for: s_dbhost
# Replace value: ebsstb01.example.com

# Step 2: Run AutoConfig to regenerate tnsnames.ora and all configuration files
\${ADMIN_SCRIPTS_HOME}/adautocfg.sh apps/\${APPS_PASSWORD}

# Step 3: Bounce the WebLogic managed servers to pick up new connection pool config
\${ADMIN_SCRIPTS_HOME}/admanagedsrvctl.sh stop oacore_server1
\${ADMIN_SCRIPTS_HOME}/admanagedsrvctl.sh start oacore_server1

# Step 4: Start concurrent managers
\${ADMIN_SCRIPTS_HOME}/adcmctl.sh start apps/\${APPS_PASSWORD}
\`\`\`

---

## Phase 6: Planned Switchover Procedure

A planned switchover is a zero-data-loss role reversal when both databases are available and synchronized. Used for maintenance on the primary server.

### 6.1 Pre-Switchover Checks

\`\`\`bash
# Verify configuration health before switchover
dgmgrl sys/\${SYS_PASSWORD}@EBSPRD << 'DGMGRL_EOF'
SHOW CONFIGURATION;
SHOW DATABASE VERBOSE EBSPRD;
SHOW DATABASE VERBOSE EBSPRD_STB;
VALIDATE DATABASE EBSPRD_STB;
EXIT;
DGMGRL_EOF
\`\`\`

\`\`\`sql
-- Check apply lag on standby (should be 0 or near-0 before switchover)
SELECT NAME, VALUE FROM V\$DATAGUARD_STATS
WHERE NAME IN ('apply lag','transport lag');

-- Check for active EBS sessions to drain (optional — notify users first)
SELECT COUNT(*) AS ACTIVE_SESSIONS
FROM V\$SESSION
WHERE STATUS = 'ACTIVE'
AND USERNAME NOT IN ('SYS','SYSTEM','DBSNMP');
\`\`\`

### 6.2 Quiesce EBS Application Tier

\`\`\`bash
# Stop all EBS services before switchover (prevents mid-transaction failures)
source /u01/oracle/EBS/EBSapps.env run

\${ADMIN_SCRIPTS_HOME}/adcmctl.sh stop apps/\${APPS_PASSWORD}
\${ADMIN_SCRIPTS_HOME}/adstpall.sh apps/\${APPS_PASSWORD}
\`\`\`

### 6.3 Execute Switchover

\`\`\`bash
dgmgrl sys/\${SYS_PASSWORD}@EBSPRD << 'DGMGRL_EOF'
SWITCHOVER TO EBSPRD_STB;
EXIT;
DGMGRL_EOF

# DGMGRL will:
# 1. Verify switchover readiness
# 2. Convert primary to standby (waits for all redo to be applied on the standby)
# 3. Convert standby to primary (opens read-write)
# 4. Update Broker configuration to reflect new roles
\`\`\`

### 6.4 Verify New Roles

\`\`\`sql
-- On the NEW PRIMARY (former standby — ebsstb01)
export ORACLE_SID=EBSPRD
sqlplus / as sysdba

SELECT NAME, DB_UNIQUE_NAME, OPEN_MODE, DATABASE_ROLE FROM V\$DATABASE;
-- Expected: DATABASE_ROLE = PRIMARY, OPEN_MODE = READ WRITE

-- Verify MRP is running on the new standby (former primary — ebsprd01)
-- Connect to ebsprd01
SELECT PROCESS, STATUS FROM V\$MANAGED_STANDBY WHERE PROCESS LIKE 'MRP%';
\`\`\`

### 6.5 Reconnect EBS Application Tier to New Primary

\`\`\`bash
# On EBS application tier — update context and run AutoConfig
# (see Phase 5.2 post-failover procedure — replace hostname with ebsstb01.example.com)
\${ADMIN_SCRIPTS_HOME}/adautocfg.sh apps/\${APPS_PASSWORD}

# Start EBS services against the new primary
\${ADMIN_SCRIPTS_HOME}/adstrtal.sh apps/\${APPS_PASSWORD}
\${ADMIN_SCRIPTS_HOME}/adcmctl.sh start apps/\${APPS_PASSWORD}
\`\`\`

---

## Phase 7: Emergency Failover Procedure

A failover is performed when the primary is unavailable and cannot be recovered in an acceptable time. It is a one-way operation — the standby becomes the new primary without the old primary's participation.

### 7.1 Confirm Primary Is Unavailable

\`\`\`bash
# Try to connect to the primary — if this times out or errors, the primary is down
sqlplus sys/\${SYS_PASSWORD}@EBSPRD as sysdba << 'SQL'
SELECT 'PRIMARY REACHABLE' FROM DUAL;
EXIT;
SQL

# Check Data Guard status from the standby
dgmgrl sys/\${SYS_PASSWORD}@EBSPRD_STB << 'DGMGRL_EOF'
SHOW CONFIGURATION;
SHOW DATABASE VERBOSE EBSPRD_STB;
EXIT;
DGMGRL_EOF
\`\`\`

### 7.2 Execute Failover

\`\`\`bash
# Connect to the STANDBY server and run failover
dgmgrl sys/\${SYS_PASSWORD}@EBSPRD_STB << 'DGMGRL_EOF'

-- Check if immediate failover is needed (primary completely gone)
-- or if we can attempt a graceful failover with redo gap resolution
SHOW DATABASE VERBOSE EBSPRD_STB;

-- Initiate failover (IMMEDIATE skips gap resolution if primary is unreachable)
FAILOVER TO EBSPRD_STB;

EXIT;
DGMGRL_EOF
\`\`\`

### 7.3 Verify New Primary Is Open

\`\`\`sql
-- On the NEW PRIMARY (former standby — ebsstb01)
export ORACLE_SID=EBSPRD
sqlplus / as sysdba

SELECT NAME, DB_UNIQUE_NAME, OPEN_MODE, DATABASE_ROLE FROM V\$DATABASE;
-- Expected: DATABASE_ROLE = PRIMARY, OPEN_MODE = READ WRITE

-- Check for any UNDO or data consistency issues
SELECT COUNT(*) FROM DBA_OBJECTS WHERE STATUS = 'INVALID';

-- Verify EBS editions are intact
SELECT EDITION_NAME, USABLE FROM DBA_EDITIONS ORDER BY EDITION_NAME;
\`\`\`

### 7.4 Reconnect EBS Application Tier (Post-Failover)

\`\`\`bash
# On EBS application tier
# Update context file — new primary is ebsstb01.example.com
vi \${INST_TOP}/appl/admin/\${CONTEXT_NAME}.xml
# Change s_dbhost to: ebsstb01.example.com

# Regenerate all configuration files
\${ADMIN_SCRIPTS_HOME}/adautocfg.sh apps/\${APPS_PASSWORD}

# Bounce connection pools
\${ADMIN_SCRIPTS_HOME}/admanagedsrvctl.sh stop oacore_server1
\${ADMIN_SCRIPTS_HOME}/admanagedsrvctl.sh start oacore_server1

# Start concurrent managers
\${ADMIN_SCRIPTS_HOME}/adcmctl.sh start apps/\${APPS_PASSWORD}

# Validate EBS login
curl -s -o /dev/null -w "%{http_code}" \\
  http://ebsapp01.example.com:8000/OA_HTML/AppsLogin
# Expected: 200 or 302
\`\`\`

### 7.5 Re-establish Data Guard After Failover

After the old primary server is recovered, re-add it as a standby using RMAN active duplicate from the new primary:

\`\`\`bash
# On the RECOVERED OLD PRIMARY server (now becoming new standby)
# Re-run RMAN active duplicate from the new primary (ebsstb01)
# Follow Phase 3 steps with primary/standby roles reversed
# New primary: ebsstb01 (EBSPRD in PRIMARY role)
# New standby: ebsprd01 (EBSPRD in STANDBY role)
\`\`\`

---

## Phase 8: Monitoring Scripts

### Script 1: Data Guard Lag Monitor

\`\`\`bash
#!/bin/bash
# File: /home/oracle/scripts/dg_lag_monitor.sh
# Monitors apply lag and transport lag — alerts when lag exceeds threshold

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
ORACLE_SID=EBSPRD
ALERT_EMAIL="dba-alerts@example.com"
LAG_WARN_SECS=60
LAG_CRIT_SECS=300
export ORACLE_HOME ORACLE_SID

LOG=/home/oracle/scripts/logs/dg_lag.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')

read TRANSPORT_LAG APPLY_LAG DB_ROLE << SQL_EOF
\$(\${ORACLE_HOME}/bin/sqlplus -s / as sysdba << 'SQL'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT
  NVL(MAX(CASE WHEN NAME = 'transport lag' THEN
    EXTRACT(SECOND FROM TO_DSINTERVAL(VALUE)) +
    EXTRACT(MINUTE FROM TO_DSINTERVAL(VALUE)) * 60 +
    EXTRACT(HOUR FROM TO_DSINTERVAL(VALUE)) * 3600
  END), -1),
  NVL(MAX(CASE WHEN NAME = 'apply lag' THEN
    EXTRACT(SECOND FROM TO_DSINTERVAL(VALUE)) +
    EXTRACT(MINUTE FROM TO_DSINTERVAL(VALUE)) * 60 +
    EXTRACT(HOUR FROM TO_DSINTERVAL(VALUE)) * 3600
  END), -1),
  (SELECT DATABASE_ROLE FROM V\$DATABASE)
FROM V\$DATAGUARD_STATS
WHERE NAME IN ('transport lag','apply lag');
EXIT;
SQL
)
SQL_EOF

echo "\${TIMESTAMP} | Role: \${DB_ROLE} | Transport lag: \${TRANSPORT_LAG}s | Apply lag: \${APPLY_LAG}s" >> \${LOG}

# Only alert if this is the primary (standby will show its own lag stats)
if [[ "\${DB_ROLE}" == *"PRIMARY"* ]]; then
  if [ "\${APPLY_LAG}" -ge "\${LAG_CRIT_SECS}" ] 2>/dev/null; then
    MSG="Subject: [DG CRITICAL] Apply lag \${APPLY_LAG}s on \$(hostname)\n\nTransport lag: \${TRANSPORT_LAG}s\nApply lag: \${APPLY_LAG}s\n\nCheck MRP0 on standby and network connectivity."
    echo -e "\${MSG}" | /usr/sbin/sendmail \${ALERT_EMAIL}
  elif [ "\${APPLY_LAG}" -ge "\${LAG_WARN_SECS}" ] 2>/dev/null; then
    MSG="Subject: [DG WARN] Apply lag \${APPLY_LAG}s on \$(hostname)\n\nTransport lag: \${TRANSPORT_LAG}s\nApply lag: \${APPLY_LAG}s"
    echo -e "\${MSG}" | /usr/sbin/sendmail \${ALERT_EMAIL}
  fi
fi
\`\`\`

### Script 2: Data Guard Configuration Health Check

\`\`\`bash
#!/bin/bash
# File: /home/oracle/scripts/dg_health_check.sh
# Full DG configuration status report and alert on WARNING/ERROR state

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
SYS_PASSWORD=\${DG_SYS_PASSWORD}
DG_PRIMARY=EBSPRD
ALERT_EMAIL="dba-alerts@example.com"
LOG=/home/oracle/scripts/logs/dg_health.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')

DG_STATUS=\$(\${ORACLE_HOME}/bin/dgmgrl sys/\${SYS_PASSWORD}@\${DG_PRIMARY} << 'DGMGRL'
SET ECHO OFF
SHOW CONFIGURATION;
SHOW DATABASE VERBOSE \${DG_PRIMARY};
EXIT;
DGMGRL
2>/dev/null)

echo "\${TIMESTAMP}" >> \${LOG}
echo "\${DG_STATUS}" >> \${LOG}
echo "---" >> \${LOG}

# Alert if any WARNING or ERROR appears in the output
if echo "\${DG_STATUS}" | grep -q "WARNING\|ERROR\|ORA-"; then
  MSG="Subject: [DG ALERT] Data Guard health issue on \$(hostname)\n\n\${DG_STATUS}"
  echo -e "\${MSG}" | /usr/sbin/sendmail \${ALERT_EMAIL}
fi
\`\`\`

### Script 3: Redo Transport and Archive Gap Monitor

\`\`\`bash
#!/bin/bash
# File: /home/oracle/scripts/dg_gap_monitor.sh
# Detects archive log gaps between primary and standby

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
ORACLE_SID=EBSPRD
ALERT_EMAIL="dba-alerts@example.com"
LOG=/home/oracle/scripts/logs/dg_gap.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
export ORACLE_HOME ORACLE_SID

GAP_REPORT=\$(\${ORACLE_HOME}/bin/sqlplus -s / as sysdba << 'SQL'
SET PAGESIZE 50 LINESIZE 120 FEEDBACK OFF HEADING ON
COLUMN LOW_SEQUENCE# FORMAT 999999
COLUMN HIGH_SEQUENCE# FORMAT 999999
COLUMN SOURCE_DBID FORMAT 9999999999
SELECT * FROM V\$ARCHIVE_GAP;
SELECT DEST_ID, STATUS, ERROR, FAIL_SEQUENCE
FROM V\$ARCHIVE_DEST
WHERE STATUS != 'VALID' AND TARGET = 'STANDBY';
EXIT;
SQL
)

echo "\${TIMESTAMP}" >> \${LOG}
echo "\${GAP_REPORT}" >> \${LOG}

# Alert if any gaps or errors found
if echo "\${GAP_REPORT}" | grep -v "^$\|no rows\|DEST_ID\|---" | grep -q "[0-9]"; then
  MSG="Subject: [DG ALERT] Archive gap or transport error on \$(hostname)\n\n\${GAP_REPORT}"
  echo -e "\${MSG}" | /usr/sbin/sendmail \${ALERT_EMAIL}
fi
\`\`\`

### Crontab Setup

\`\`\`bash
# Add to oracle user crontab on the PRIMARY server: crontab -e

# Lag monitor: every 5 minutes
*/5 * * * * /home/oracle/scripts/dg_lag_monitor.sh >> /dev/null 2>&1

# Full health check: every 15 minutes
*/15 * * * * /home/oracle/scripts/dg_health_check.sh >> /dev/null 2>&1

# Archive gap monitor: every 10 minutes
*/10 * * * * /home/oracle/scripts/dg_gap_monitor.sh >> /dev/null 2>&1

# Log rotation
0 3 * * 0 find /home/oracle/scripts/logs -name "dg_*.log" -mtime +30 -delete
\`\`\`

---

## Quick Reference: DGMGRL Commands

\`\`\`bash
# Connect to Broker
dgmgrl sys/\${SYS_PASSWORD}@EBSPRD

# Show full configuration status
SHOW CONFIGURATION;

# Show database details (lag, transport mode, protection mode)
SHOW DATABASE VERBOSE EBSPRD;
SHOW DATABASE VERBOSE EBSPRD_STB;

# Validate switchover readiness
VALIDATE DATABASE EBSPRD_STB;

# Planned switchover
SWITCHOVER TO EBSPRD_STB;

# Emergency failover
FAILOVER TO EBSPRD_STB;

# Convert to snapshot standby (DR test)
CONVERT DATABASE EBSPRD_STB TO SNAPSHOT STANDBY;

# Convert back to physical standby (end DR test)
CONVERT DATABASE EBSPRD_STB TO PHYSICAL STANDBY;

# Change protection mode
EDIT CONFIGURATION SET PROTECTION MODE AS MaxAvailability;
EDIT CONFIGURATION SET PROTECTION MODE AS MaxPerformance;

# Change transport mode
EDIT DATABASE EBSPRD_STB SET PROPERTY LogXptMode=SYNC;
EDIT DATABASE EBSPRD_STB SET PROPERTY LogXptMode=ASYNC;

# Disable/enable a standby destination temporarily
DISABLE DATABASE EBSPRD_STB;
ENABLE DATABASE EBSPRD_STB;
\`\`\`

---

## Post-Failover EBS Validation Checklist

\`\`\`sql
-- On the new primary — verify EBS health
-- 1. Database role and open mode
SELECT NAME, DB_UNIQUE_NAME, OPEN_MODE, DATABASE_ROLE FROM V\$DATABASE;

-- 2. No invalid APPS objects
SELECT COUNT(*), STATUS FROM DBA_OBJECTS WHERE OWNER = 'APPS' GROUP BY STATUS;

-- 3. EBS editions intact
SELECT EDITION_NAME, USABLE FROM DBA_EDITIONS ORDER BY EDITION_NAME;

-- 4. FND_NODES shows correct application tier
SELECT NODE_NAME, HOST_NAME, SUPPORT_CP, SUPPORT_WEB FROM FND_NODES;

-- 5. Concurrent managers can submit a test request
-- (run via EBS front end: System Administrator > Concurrent > Run)

-- 6. Log into EBS as SYSADMIN and verify System Administrator responsibility
-- 7. Run a concurrent program to validate CM is healthy
\`\`\``,
};

async function main() {
  console.log('Inserting EBS Data Guard runbook...');
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
