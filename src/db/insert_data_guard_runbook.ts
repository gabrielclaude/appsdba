import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Building and Operating an Oracle Data Guard Physical Standby',
  slug: 'oracle-data-guard-physical-standby-runbook',
  excerpt:
    'Complete runbook for deploying an Oracle Data Guard physical standby — primary database preparation, RMAN duplicate to standby, Standby Redo Log configuration, Data Guard Broker setup, redo transport validation, switchover procedure, failover and reinstatement, gap resolution, and a production monitoring script.',
  category: 'disaster-recovery' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-11'),
  youtubeUrl: null,
  content: `## Environment Assumptions

| Parameter | Primary | Standby |
|-----------|---------|---------|
| DB_UNIQUE_NAME | PRODDB | DRDB |
| DB_NAME | PRODDB | PRODDB |
| Oracle Home | /u01/oracle/product/19.3.0/dbhome_1 | same path |
| Data files | /u01/oradata/PRODDB/ | /u01/oradata/DRDB/ |
| FRA | /u01/fast_recovery_area | same path |
| TNS alias | PRODDB | DRDB |
| Host | primary.corp.local | standby.corp.local |
| OS user | oracle | oracle |
| DB version | Oracle 19c (19.3+) | Same patch level |

> The standby host must have Oracle Database software installed at the same patch level as the primary, but no database created.

---

## Phase 1: Prepare the Primary Database

### 1.1 Verify Archive Log Mode and Flashback

\`\`\`sql
sqlplus / as sysdba

-- Must be in archivelog mode
SELECT log_mode FROM v\$database;
-- Expected: ARCHIVELOG

-- Enable if not already
-- SHUTDOWN IMMEDIATE;
-- STARTUP MOUNT;
-- ALTER DATABASE ARCHIVELOG;
-- ALTER DATABASE OPEN;

-- Flashback Database (strongly recommended — enables reinstatement after failover)
SELECT flashback_on FROM v\$database;
-- If NO:
ALTER SYSTEM SET DB_RECOVERY_FILE_DEST_SIZE = 50G SCOPE=BOTH;
ALTER SYSTEM SET DB_RECOVERY_FILE_DEST = '/u01/fast_recovery_area' SCOPE=BOTH;
ALTER DATABASE FLASHBACK ON;
\`\`\`

### 1.2 Enable Force Logging

\`\`\`sql
-- Force logging ensures all changes are captured in redo regardless of NOLOGGING hints
ALTER DATABASE FORCE LOGGING;

SELECT force_logging FROM v\$database;
-- Expected: YES
\`\`\`

### 1.3 Add Standby Redo Logs on the Primary

Size must match the primary's online redo log size. Check current redo log size first:

\`\`\`sql
SELECT group#, members, bytes/1024/1024 AS size_mb, status
FROM v\$log
ORDER BY group#;
\`\`\`

Add SRLs (one more group than existing redo log groups, per thread):

\`\`\`sql
-- If primary has 3 redo log groups, add 4 SRL groups
-- Adjust SIZE to match your online redo log size
ALTER DATABASE ADD STANDBY LOGFILE GROUP 4
  '/u01/oradata/PRODDB/standby_redo04.log' SIZE 200M;
ALTER DATABASE ADD STANDBY LOGFILE GROUP 5
  '/u01/oradata/PRODDB/standby_redo05.log' SIZE 200M;
ALTER DATABASE ADD STANDBY LOGFILE GROUP 6
  '/u01/oradata/PRODDB/standby_redo06.log' SIZE 200M;
ALTER DATABASE ADD STANDBY LOGFILE GROUP 7
  '/u01/oradata/PRODDB/standby_redo07.log' SIZE 200M;

-- Verify
SELECT group#, bytes/1024/1024 AS size_mb, status
FROM   v\$standby_log
ORDER BY group#;
\`\`\`

### 1.4 Set Primary init.ora Parameters

\`\`\`sql
-- Enable Data Guard Broker
ALTER SYSTEM SET DG_BROKER_START=TRUE SCOPE=BOTH;

-- Unique name for this database
ALTER SYSTEM SET DB_UNIQUE_NAME='PRODDB' SCOPE=SPFILE;

-- Redo transport to standby (async — change to SYNC AFFIRM for Maximum Availability)
ALTER SYSTEM SET LOG_ARCHIVE_DEST_2=
  'SERVICE=DRDB LGWR ASYNC VALID_FOR=(ONLINE_LOGFILES,PRIMARY_ROLE) DB_UNIQUE_NAME=DRDB'
  SCOPE=BOTH;
ALTER SYSTEM SET LOG_ARCHIVE_DEST_STATE_2=ENABLE SCOPE=BOTH;

-- Local archive destination
ALTER SYSTEM SET LOG_ARCHIVE_DEST_1=
  'LOCATION=USE_DB_RECOVERY_FILE_DEST VALID_FOR=(ALL_LOGFILES,ALL_ROLES) DB_UNIQUE_NAME=PRODDB'
  SCOPE=BOTH;

-- Auto-manage standby file naming (for when primary becomes standby)
ALTER SYSTEM SET STANDBY_FILE_MANAGEMENT=AUTO SCOPE=BOTH;

-- File name conversion (primary path → standby path, used after role switch)
ALTER SYSTEM SET DB_FILE_NAME_CONVERT=
  '/u01/oradata/DRDB/','/u01/oradata/PRODDB/'
  SCOPE=SPFILE;
ALTER SYSTEM SET LOG_FILE_NAME_CONVERT=
  '/u01/oradata/DRDB/','/u01/oradata/PRODDB/'
  SCOPE=SPFILE;

-- FAL (Fetch Archive Log) — standby uses this to request missing archivelogs
ALTER SYSTEM SET FAL_SERVER=DRDB SCOPE=BOTH;
ALTER SYSTEM SET FAL_CLIENT=PRODDB SCOPE=BOTH;
\`\`\`

### 1.5 Configure TNS on Primary

Add both the primary and standby entries to \`\$ORACLE_HOME/network/admin/tnsnames.ora\` on the **primary**:

\`\`\`
PRODDB =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = primary.corp.local)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = PRODDB)
    )
  )

DRDB =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = standby.corp.local)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = DRDB)
      (UR = A)
    )
  )
\`\`\`

> The \`(UR = A)\` (unrestricted = allow) entry is needed so RMAN can connect to the standby listener while the instance is in mount mode.

---

## Phase 2: Prepare the Standby Host

### 2.1 Create Directories

\`\`\`bash
# On the standby host — as oracle user
mkdir -p /u01/oradata/DRDB
mkdir -p /u01/fast_recovery_area
mkdir -p /u01/oracle/admin/DRDB/adump
mkdir -p /u01/oracle/admin/DRDB/dpdump
\`\`\`

### 2.2 Create the Standby init.ora (pfile)

\`\`\`bash
# On the standby host
cat > /tmp/initDRDB.ora << 'EOF'
DB_NAME=PRODDB
DB_UNIQUE_NAME=DRDB
DB_BLOCK_SIZE=8192
SGA_TARGET=4G
PGA_AGGREGATE_TARGET=1G
CONTROL_FILES='/u01/oradata/DRDB/control01.ctl','/u01/fast_recovery_area/DRDB/control02.ctl'
DB_FILE_NAME_CONVERT='/u01/oradata/PRODDB/','/u01/oradata/DRDB/'
LOG_FILE_NAME_CONVERT='/u01/oradata/PRODDB/','/u01/oradata/DRDB/'
STANDBY_FILE_MANAGEMENT=AUTO
LOG_ARCHIVE_DEST_1='LOCATION=USE_DB_RECOVERY_FILE_DEST VALID_FOR=(ALL_LOGFILES,ALL_ROLES) DB_UNIQUE_NAME=DRDB'
LOG_ARCHIVE_DEST_2='SERVICE=PRODDB LGWR ASYNC VALID_FOR=(ONLINE_LOGFILES,PRIMARY_ROLE) DB_UNIQUE_NAME=PRODDB'
LOG_ARCHIVE_DEST_STATE_2=ENABLE
FAL_SERVER=PRODDB
FAL_CLIENT=DRDB
DG_BROKER_START=TRUE
DB_RECOVERY_FILE_DEST='/u01/fast_recovery_area'
DB_RECOVERY_FILE_DEST_SIZE=50G
AUDIT_FILE_DEST='/u01/oracle/admin/DRDB/adump'
EOF
\`\`\`

### 2.3 Copy Password File from Primary

Data Guard requires the standby to use the same password file as the primary (the SYS password must match).

\`\`\`bash
# On the primary
scp \$ORACLE_HOME/dbs/orapwPRODDB oracle@standby.corp.local:\$ORACLE_HOME/dbs/orapwDRDB
\`\`\`

### 2.4 Start the Standby Instance in NOMOUNT

\`\`\`bash
# On the standby host
export ORACLE_SID=DRDB
export ORACLE_HOME=/u01/oracle/product/19.3.0/dbhome_1
export PATH=\$ORACLE_HOME/bin:\$PATH

sqlplus / as sysdba
SQL> STARTUP NOMOUNT PFILE='/tmp/initDRDB.ora';
\`\`\`

### 2.5 Configure TNS on Standby

Mirror the primary's \`tnsnames.ora\` on the standby host (both PRODDB and DRDB entries).

Start the listener on the standby:

\`\`\`bash
lsnrctl start
lsnrctl status
\`\`\`

### 2.6 Verify Connectivity Between Primary and Standby

\`\`\`bash
# From the primary host — test that the standby listener is reachable
tnsping DRDB
# Expected: OK (n msec)

# From the primary, test RMAN can connect to standby auxiliary
rman target / auxiliary sys/\${SYS_PASSWORD}@DRDB
# Expected: connected to auxiliary database: PRODDB (not mounted)
\`\`\`

---

## Phase 3: Duplicate the Primary to the Standby via RMAN

### 3.1 RMAN Duplicate Command

Run on the **primary** host:

\`\`\`bash
export ORACLE_SID=PRODDB
export ORACLE_HOME=/u01/oracle/product/19.3.0/dbhome_1
export PATH=\$ORACLE_HOME/bin:\$PATH

rman target sys/\${SYS_PASSWORD}@PRODDB auxiliary sys/\${SYS_PASSWORD}@DRDB
\`\`\`

\`\`\`rman
DUPLICATE TARGET DATABASE
  FOR STANDBY
  FROM ACTIVE DATABASE
  DORECOVER
  SPFILE
    SET DB_UNIQUE_NAME='DRDB'
    SET DB_FILE_NAME_CONVERT='/u01/oradata/PRODDB/','/u01/oradata/DRDB/'
    SET LOG_FILE_NAME_CONVERT='/u01/oradata/PRODDB/','/u01/oradata/DRDB/'
    SET CONTROL_FILES='/u01/oradata/DRDB/control01.ctl','/u01/fast_recovery_area/DRDB/control02.ctl'
    SET DB_RECOVERY_FILE_DEST='/u01/fast_recovery_area'
    SET DB_RECOVERY_FILE_DEST_SIZE='50G'
    SET FAL_SERVER='PRODDB'
    SET FAL_CLIENT='DRDB'
    SET STANDBY_FILE_MANAGEMENT='AUTO'
    SET DG_BROKER_START='TRUE'
    SET LOG_ARCHIVE_DEST_2='SERVICE=PRODDB LGWR ASYNC VALID_FOR=(ONLINE_LOGFILES,PRIMARY_ROLE) DB_UNIQUE_NAME=PRODDB'
  NOFILENAMECHECK;
\`\`\`

> \`FROM ACTIVE DATABASE\` streams directly over the network — no backup media required. For large databases (>500 GB), consider pre-staging an RMAN backup to the standby and using that as the source instead.

This command copies all datafiles, creates the standby control file, and leaves the standby in MOUNT state.

### 3.2 Verify the Standby Is in Mount State

\`\`\`sql
-- On the standby
sqlplus / as sysdba

SELECT status, database_role FROM v\$database;
-- Expected: MOUNTED, PHYSICAL STANDBY
\`\`\`

---

## Phase 4: Add Standby Redo Logs on the Standby

\`\`\`sql
-- On the standby — same count and size as the primary's SRLs
ALTER DATABASE ADD STANDBY LOGFILE GROUP 4
  '/u01/oradata/DRDB/standby_redo04.log' SIZE 200M;
ALTER DATABASE ADD STANDBY LOGFILE GROUP 5
  '/u01/oradata/DRDB/standby_redo05.log' SIZE 200M;
ALTER DATABASE ADD STANDBY LOGFILE GROUP 6
  '/u01/oradata/DRDB/standby_redo06.log' SIZE 200M;
ALTER DATABASE ADD STANDBY LOGFILE GROUP 7
  '/u01/oradata/DRDB/standby_redo07.log' SIZE 200M;

SELECT group#, bytes/1024/1024 AS size_mb, status
FROM   v\$standby_log;
\`\`\`

---

## Phase 5: Start Managed Recovery

\`\`\`sql
-- On the standby — start MRP (Managed Recovery Process)
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE
  USING CURRENT LOGFILE DISCONNECT FROM SESSION;

-- Verify MRP is running
SELECT process, status, thread#, sequence#, block#
FROM   v\$managed_standby
WHERE  process = 'MRP0';
-- Expected: MRP0, APPLYING_LOG
\`\`\`

---

## Phase 6: Validate Redo Transport

### 6.1 Force a Log Switch on the Primary and Verify Receipt

\`\`\`sql
-- On the primary
ALTER SYSTEM SWITCH LOGFILE;
ALTER SYSTEM ARCHIVE LOG CURRENT;

-- Check current sequence on primary
SELECT thread#, sequence# FROM v\$log WHERE status = 'CURRENT';
\`\`\`

\`\`\`sql
-- On the standby — verify the same sequence was received and applied
SELECT thread#, sequence#, applied
FROM   v\$archived_log
ORDER BY thread#, sequence# DESC
FETCH FIRST 10 ROWS ONLY;
-- 'YES' in APPLIED column confirms MRP processed the log
\`\`\`

### 6.2 Check Transport and Apply Lag

\`\`\`sql
-- On the standby
SELECT name, value, unit, time_computed
FROM   v\$dataguard_stats
WHERE  name IN ('transport lag', 'apply lag', 'apply finish time');
-- Healthy: transport lag = +00 00:00:00, apply lag = seconds
\`\`\`

### 6.3 Check v\$archive_dest_status on the Primary

\`\`\`sql
-- On the primary
SELECT dest_id, dest_name, status, target, archiver, schedule,
       error, db_unique_name
FROM   v\$archive_dest_status
WHERE  dest_id = 2;
-- STATUS should be VALID, ERROR column should be blank
\`\`\`

---

## Phase 7: Configure the Data Guard Broker

### 7.1 Enable the Broker on Both Nodes

\`\`\`sql
-- On primary and standby — if not already set
ALTER SYSTEM SET DG_BROKER_START=TRUE SCOPE=BOTH;
\`\`\`

### 7.2 Create the Broker Configuration

\`\`\`bash
# On the primary host
dgmgrl /

DGMGRL> CREATE CONFIGURATION 'ProdDG'
  AS PRIMARY DATABASE IS 'PRODDB'
  CONNECT IDENTIFIER IS PRODDB;
-- Configuration "ProdDG" created with primary database "PRODDB"

DGMGRL> ADD DATABASE 'DRDB'
  AS CONNECT IDENTIFIER IS DRDB
  MAINTAINED AS PHYSICAL;
-- Database "DRDB" added

DGMGRL> ENABLE CONFIGURATION;
-- Enabled
\`\`\`

### 7.3 Validate the Configuration

\`\`\`bash
DGMGRL> SHOW CONFIGURATION;
# Configuration - ProdDG
#   Protection Mode: MaxPerformance
#   Members:
#   PRODDB - Primary database
#   DRDB   - Physical standby database
# Fast-Start Failover:  Disabled
# Configuration Status: SUCCESS

DGMGRL> SHOW DATABASE VERBOSE PRODDB;
DGMGRL> SHOW DATABASE VERBOSE DRDB;
# Look for: Database Status: SUCCESS
# Warning entries require investigation before going live

DGMGRL> VALIDATE DATABASE DRDB;
# Runs a comprehensive pre-switchover checklist
\`\`\`

### 7.4 Set Protection Mode via Broker (Optional — Maximum Availability)

\`\`\`bash
DGMGRL> EDIT DATABASE DRDB SET PROPERTY LogXptMode=SYNC;
DGMGRL> EDIT DATABASE PRODDB SET PROPERTY LogXptMode=SYNC;
DGMGRL> EDIT CONFIGURATION SET PROTECTION MODE AS MaxAvailability;
DGMGRL> SHOW CONFIGURATION;
# Protection Mode: MaxAvailability
\`\`\`

---

## Phase 8: Switchover Procedure (Planned Role Transition)

Perform before a primary host maintenance window.

### 8.1 Pre-Switchover Checklist

\`\`\`bash
dgmgrl /

# 1. Validate both databases
DGMGRL> VALIDATE DATABASE PRODDB;
DGMGRL> VALIDATE DATABASE DRDB;
# Both must show: Ready for Switchover: Yes

# 2. Confirm apply lag is near zero
DGMGRL> SHOW DATABASE DRDB;
# Apply Lag: 0 seconds (or near zero)

# 3. Confirm no active user transactions need to drain
# (for critical OLTP systems, consider waiting for quiet period)
\`\`\`

\`\`\`sql
-- On primary — check active sessions
SELECT COUNT(*) FROM v\$session WHERE type = 'USER' AND status = 'ACTIVE';
\`\`\`

### 8.2 Execute the Switchover

\`\`\`bash
dgmgrl /
DGMGRL> SWITCHOVER TO DRDB;
\`\`\`

Expected sequence of events (visible in dgmgrl output):
1. Primary completes in-flight redo
2. Primary transitions to standby role (MOUNT state)
3. DRDB receives and applies all outstanding redo
4. DRDB opens as the new primary
5. Old primary (PRODDB) starts MRP as the new standby

### 8.3 Verify the Switchover

\`\`\`bash
DGMGRL> SHOW CONFIGURATION;
# Members:
# DRDB   - Primary database
# PRODDB - Physical standby database
# Configuration Status: SUCCESS
\`\`\`

\`\`\`sql
-- On the new primary (DRDB)
SELECT database_role, open_mode FROM v\$database;
-- Expected: PRIMARY, READ WRITE

-- On the new standby (PRODDB)
SELECT database_role, open_mode FROM v\$database;
-- Expected: PHYSICAL STANDBY, MOUNTED (or READ ONLY if ADG)
\`\`\`

### 8.4 Switchback (After Maintenance)

\`\`\`bash
dgmgrl /
DGMGRL> SWITCHOVER TO PRODDB;
# Reverses the roles — PRODDB becomes primary again
\`\`\`

---

## Phase 9: Failover Procedure (Emergency — Primary Unavailable)

### 9.1 Confirm Primary Is Truly Down

\`\`\`bash
# Attempt to ping and connect to the primary
ping -c 3 primary.corp.local
tnsping PRODDB
\`\`\`

\`\`\`sql
-- On the standby — check Data Guard status
SELECT database_role, protection_mode, protection_level FROM v\$database;
SELECT process, status FROM v\$managed_standby;
\`\`\`

### 9.2 Execute Failover via Broker

\`\`\`bash
# On the standby host
dgmgrl /

# Check if broker can see the primary
DGMGRL> SHOW CONFIGURATION;

# Initiate failover (applies all received redo before promoting)
DGMGRL> FAILOVER TO DRDB;

# If the standby is significantly behind and time is critical:
DGMGRL> FAILOVER TO DRDB IMMEDIATE;
# WARNING: IMMEDIATE skips remaining redo apply — data loss is possible
\`\`\`

### 9.3 Open the New Primary

\`\`\`sql
-- If the database did not open automatically after failover
ALTER DATABASE OPEN;

-- Verify
SELECT database_role, open_mode FROM v\$database;
-- Expected: PRIMARY, READ WRITE
\`\`\`

### 9.4 Update Application Connection Strings

Point application servers, connection pools, and load balancers to the new primary host (\`standby.corp.local\`).

---

## Phase 10: Reinstate the Old Primary After Failover

If Flashback Database was enabled on the old primary before the failure, reinstatement is fast.

### 10.1 Start the Old Primary in MOUNT Mode

\`\`\`sql
-- On the old primary host (now recovered)
STARTUP MOUNT;
\`\`\`

### 10.2 Reinstate via Broker

\`\`\`bash
# On the new primary host
dgmgrl /

DGMGRL> REINSTATE DATABASE PRODDB;
# Broker uses Flashback Database to rewind PRODDB to the failover SCN,
# then re-enables redo transport from the current primary (DRDB)
\`\`\`

If Flashback Database was NOT enabled, the old primary must be re-created from scratch using RMAN duplicate (repeat Phase 3).

### 10.3 Verify Reinstatement

\`\`\`bash
DGMGRL> SHOW CONFIGURATION;
# DRDB   - Primary database
# PRODDB - Physical standby database
# Configuration Status: SUCCESS
\`\`\`

---

## Phase 11: Gap Detection and Resolution

If the standby falls behind (network outage, standby restart), archived logs accumulate on the primary. FAL resolves this automatically, but you can monitor and manually trigger it.

### 11.1 Detect Gaps

\`\`\`sql
-- On the standby
SELECT thread#, low_sequence#, high_sequence#
FROM   v\$archive_gap;
-- Empty = no gaps
\`\`\`

\`\`\`sql
-- On the primary — check which sequences have not been applied on standby
SELECT local.thread#,
       local.sequence#,
       'NOT ON STANDBY' AS gap_type
FROM (
    SELECT thread#, sequence#
    FROM   v\$archived_log
    WHERE  dest_id = 1
      AND  standby_dest = 'NO'
      AND  sequence# > (
               SELECT NVL(MAX(sequence#), 0)
               FROM   v\$archived_log
               WHERE  dest_id = 2
                 AND  thread# = v\$archived_log.thread#
           )
) local
ORDER BY thread#, sequence#;
\`\`\`

### 11.2 Force FAL Resolution

\`\`\`sql
-- On the standby — request the primary to resend missing archivelogs
ALTER DATABASE REGISTER LOGFILE '/path/to/missing/archivelog.arc';

-- Or let FAL resolve automatically by triggering a log switch on primary
-- (FAL_SERVER on standby will detect and request the gap)
\`\`\`

---

## Phase 12: Production Monitoring Script

\`\`\`bash
#!/bin/bash
# /home/oracle/scripts/dg_health_check.sh
# Usage: ./dg_health_check.sh [PRIMARY_SID]
# Deploy on the standby host; cron every 5 minutes

source /home/oracle/scripts/lib/oracle_common.sh

PRIMARY_SID="\${1:-PRODDB}"
STANDBY_SID="\${ORACLE_SID:-DRDB}"
EMAIL="dba-alerts@corp.local"
EXIT_CODE=0

log() { echo "\$(date '+%Y-%m-%d %H:%M:%S') [\${1}] \${2}"; }

# --- 1. Database role and status ---
ROLE=\$(sqlplus -s / as sysdba <<'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON
SELECT database_role FROM v\$database;
EXIT 0;
EOF
)
ROLE="\$(echo "\$ROLE" | tr -d '[:space:]')"
log INFO "Database role: \$ROLE"

# --- 2. MRP status ---
MRP_STATUS=\$(sqlplus -s / as sysdba <<'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON
SELECT status FROM v\$managed_standby WHERE process = 'MRP0';
EXIT 0;
EOF
)
MRP_STATUS="\$(echo "\$MRP_STATUS" | tr -d '[:space:]')"

if [[ "\$MRP_STATUS" != "APPLYING_LOG" && "\$MRP_STATUS" != "WAIT_FOR_LOG" ]]; then
    MSG="CRITICAL: MRP0 is not applying on \$STANDBY_SID — status: \$MRP_STATUS"
    log CRITICAL "\$MSG"
    echo "\$MSG" | mail -s "Data Guard MRP ALERT: \$STANDBY_SID" "\$EMAIL"
    EXIT_CODE=2
else
    log INFO "MRP0 status: \$MRP_STATUS"
fi

# --- 3. Apply lag ---
APPLY_LAG=\$(sqlplus -s / as sysdba <<'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON
SELECT value FROM v\$dataguard_stats WHERE name = 'apply lag';
EXIT 0;
EOF
)
APPLY_LAG="\$(echo "\$APPLY_LAG" | tr -d '[:space:]')"
log INFO "Apply lag: \$APPLY_LAG"

# Convert HH:MM:SS to seconds for threshold comparison
if [[ "\$APPLY_LAG" =~ ([0-9]+):([0-9]+):([0-9]+) ]]; then
    H="\${BASH_REMATCH[1]#0}"; H="\${H:-0}"
    M="\${BASH_REMATCH[2]#0}"; M="\${M:-0}"
    S="\${BASH_REMATCH[3]#0}"; S="\${S:-0}"
    LAG_SECS=\$((H*3600 + M*60 + S))

    if   [[ \$LAG_SECS -ge 3600 ]]; then
        MSG="CRITICAL: Apply lag is \$APPLY_LAG on \$STANDBY_SID"
        log CRITICAL "\$MSG"
        echo "\$MSG" | mail -s "Data Guard Apply Lag CRITICAL: \$STANDBY_SID" "\$EMAIL"
        [[ \$EXIT_CODE -lt 2 ]] && EXIT_CODE=2
    elif [[ \$LAG_SECS -ge 600 ]]; then
        log WARN "Apply lag is \$APPLY_LAG — threshold: 10 minutes"
        [[ \$EXIT_CODE -lt 1 ]] && EXIT_CODE=1
    fi
fi

# --- 4. Archive gaps ---
GAPS=\$(sqlplus -s / as sysdba <<'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON
SELECT COUNT(*) FROM v\$archive_gap;
EXIT 0;
EOF
)
GAPS="\$(echo "\$GAPS" | tr -d '[:space:]')"

if [[ "\$GAPS" -gt 0 ]]; then
    MSG="WARNING: \$GAPS archive gap(s) detected on \$STANDBY_SID"
    log WARN "\$MSG"
    echo "\$MSG" | mail -s "Data Guard Archive Gap: \$STANDBY_SID" "\$EMAIL"
    [[ \$EXIT_CODE -lt 1 ]] && EXIT_CODE=1
else
    log INFO "No archive gaps detected"
fi

# --- 5. Last received sequence ---
LAST_SEQ=\$(sqlplus -s / as sysdba <<'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON
SELECT MAX(sequence#) FROM v\$archived_log WHERE dest_id = 1;
EXIT 0;
EOF
)
LAST_SEQ="\$(echo "\$LAST_SEQ" | tr -d '[:space:]')"
log INFO "Last applied sequence: \$LAST_SEQ"

# --- 6. Transport error on primary (via dblink or dgmgrl) ---
DG_STATUS=\$(dgmgrl / "show configuration" 2>/dev/null \
    | grep -i "warning\|error\|failed" | head -3)

if [[ -n "\$DG_STATUS" ]]; then
    log WARN "Data Guard Broker reports issues: \$DG_STATUS"
    [[ \$EXIT_CODE -lt 1 ]] && EXIT_CODE=1
else
    log INFO "Data Guard Broker: no warnings"
fi

log INFO "DG health check complete — exit code: \$EXIT_CODE"
exit \$EXIT_CODE
\`\`\`

\`\`\`bash
# Crontab on standby host
# */5 * * * * /home/oracle/scripts/dg_health_check.sh PRODDB >> /home/oracle/scripts/logs/dg_monitor.log 2>&1
\`\`\`

---

## Troubleshooting

| Symptom | Query | Likely Cause |
|---------|-------|--------------|
| MRP not running | \`SELECT process, status FROM v\$managed_standby\` | MRP stopped; restart with \`ALTER DATABASE RECOVER MANAGED STANDBY DATABASE USING CURRENT LOGFILE DISCONNECT\` |
| Apply lag growing | \`SELECT * FROM v\$dataguard_stats\` | Standby I/O bottleneck, or redo transport to standby is blocked |
| Transport error on primary | \`SELECT error FROM v\$archive_dest_status WHERE dest_id=2\` | Network issue, TNS misconfiguration, listener down on standby |
| Archive gap | \`SELECT * FROM v\$archive_gap\` | Archivelogs purged on primary before standby received them; restore from backup and register |
| Standby has ORA-01196 at startup | Alert log | Control file SCN mismatch; re-create standby control file from primary: \`ALTER DATABASE CREATE STANDBY CONTROLFILE AS '/tmp/stby.ctl'\` |
| Broker shows WARNING | \`DGMGRL> SHOW DATABASE VERBOSE DRDB\` | Check the specific property flagged; usually a parameter mismatch or SRL not configured |`,
};

async function main() {
  console.log('Inserting Oracle Data Guard runbook...');
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
