import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Installing Oracle Demantra on Oracle Database 19c and RHEL 9 with Crontab Monitoring',
  slug: 'oracle-demantra-19c-rhel9-installation-runbook',
  excerpt:
    'End-to-end installation runbook for Oracle Demantra 12.2.x on Oracle Database 19c and Red Hat Enterprise Linux 9 — covering database prerequisites, schema creation, application server installation, EBS integration, engine configuration, and production monitoring scripts scheduled via crontab.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-22'),
  youtubeUrl: null,
  content: `This runbook covers the complete Oracle Demantra installation on Oracle Database 19c (19.21+ RU) and RHEL 9. Assumptions: Oracle EBS R12.2.x already installed and running, Oracle Database 19c already installed and patched to a current RU, Demantra 12.2.x software available (downloaded from Oracle MOS), a dedicated Demantra application server (separate from EBS), network connectivity between Demantra app server and the Oracle DB listener.

---

## Phase 0: Prerequisites Verification

### Step 0.1 — Oracle Database 19c Verification

\`\`\`sql
-- Verify version and patch level
SELECT banner_full FROM v$version;
-- Must be: Oracle Database 19c Enterprise Edition 19.21.0.0.0 or later

-- Verify character set (AL32UTF8 required)
SELECT parameter, value FROM nls_database_parameters
WHERE parameter IN ('NLS_CHARACTERSET', 'NLS_NCHAR_CHARACTERSET');
-- NLS_CHARACTERSET must be AL32UTF8

-- Verify components required for Demantra
SELECT comp_name, version, status
FROM dba_registry
WHERE comp_name IN ('Oracle XML Database', 'Oracle Text', 'Oracle Workspace Manager');
-- All three must be VALID
\`\`\`

### Step 0.2 — RHEL 9 OS Prerequisites

\`\`\`bash
# Verify RHEL 9 version
cat /etc/redhat-release
# Must be: Red Hat Enterprise Linux release 9.x

# Install required OS packages
dnf install -y \
  gcc gcc-c++ make \
  glibc glibc-devel \
  libstdc++ libstdc++-devel \
  libaio libaio-devel \
  libxcb libX11 libXext libXi libXrender libXtst \
  openmotif openmotif-devel \
  compat-openssl11 \
  java-11-openjdk java-11-openjdk-devel \
  perl perl-Env perl-DBI \
  unzip zip \
  net-tools bind-utils

# Verify Java 11 (Demantra requires JDK 11)
java -version
# Must show: openjdk version "11.x.x"

# Set JAVA_HOME
echo 'export JAVA_HOME=/usr/lib/jvm/java-11-openjdk' >> /etc/profile.d/demantra.sh
echo 'export PATH=$JAVA_HOME/bin:$PATH' >> /etc/profile.d/demantra.sh
source /etc/profile.d/demantra.sh
\`\`\`

### Step 0.3 — Kernel Parameters for Demantra App Server

\`\`\`bash
# Add to /etc/sysctl.d/99-demantra.conf
cat > /etc/sysctl.d/99-demantra.conf <<'EOF'
kernel.shmmax = 4294967296
kernel.shmall = 1048576
kernel.shmmni = 4096
net.ipv4.ip_local_port_range = 9000 65500
net.core.rmem_max = 4194304
net.core.wmem_max = 1048576
fs.file-max = 6815744
EOF

sysctl --system
sysctl -p /etc/sysctl.d/99-demantra.conf

# Limits for demantra OS user (create user first — Step 0.4)
cat >> /etc/security/limits.d/99-demantra.conf <<'EOF'
demantra soft nofile 65536
demantra hard nofile 65536
demantra soft nproc  16384
demantra hard nproc  16384
EOF
\`\`\`

### Step 0.4 — Create OS and DB Users

\`\`\`bash
# OS user for Demantra application
groupadd demantra
useradd -g demantra -m -d /home/demantra -s /bin/bash demantra

# Create Demantra install directory
mkdir -p /u01/demantra/{app,stage,logs,backup}
chown -R demantra:demantra /u01/demantra
\`\`\`

\`\`\`sql
-- Database user for Demantra schema (run as SYSDBA)
CREATE USER demantra IDENTIFIED BY "<strong_password>"
  DEFAULT TABLESPACE demantra_data
  TEMPORARY TABLESPACE temp
  PROFILE DEFAULT;

-- Demantra requires DBA role for schema creation (can be reduced post-install)
GRANT DBA TO demantra;

-- Additional required grants
GRANT SELECT ON sys.v_$session TO demantra;
GRANT SELECT ON sys.v_$parameter TO demantra;
GRANT SELECT ON sys.dba_segments TO demantra;
GRANT EXECUTE ON sys.dbms_lock TO demantra;
GRANT EXECUTE ON sys.dbms_job TO demantra;
GRANT EXECUTE ON sys.dbms_scheduler TO demantra;
\`\`\`

---

## Phase 1: Database Preparation

### Step 1.1 — Create Tablespaces

\`\`\`sql
-- Data tablespace (size based on item-location count; 50k items = ~100GB initial)
CREATE TABLESPACE demantra_data
  DATAFILE '/u01/oradata/<SID>/demantra_data01.dbf' SIZE 20G AUTOEXTEND ON NEXT 5G MAXSIZE 200G,
           '/u01/oradata/<SID>/demantra_data02.dbf' SIZE 20G AUTOEXTEND ON NEXT 5G MAXSIZE 200G
  EXTENT MANAGEMENT LOCAL UNIFORM SIZE 1M
  SEGMENT SPACE MANAGEMENT AUTO;

-- Index tablespace
CREATE TABLESPACE demantra_idx
  DATAFILE '/u01/oradata/<SID>/demantra_idx01.dbf' SIZE 10G AUTOEXTEND ON NEXT 2G MAXSIZE 100G
  EXTENT MANAGEMENT LOCAL UNIFORM SIZE 512K
  SEGMENT SPACE MANAGEMENT AUTO;

-- Temp tablespace (Demantra analytical engine uses heavy sort operations)
CREATE TEMPORARY TABLESPACE demantra_temp
  TEMPFILE '/u01/oradata/<SID>/demantra_temp01.dbf' SIZE 10G AUTOEXTEND ON NEXT 2G MAXSIZE 50G;

-- Verify
SELECT tablespace_name, status, contents FROM dba_tablespaces
WHERE tablespace_name LIKE 'DEMANTRA%';
\`\`\`

### Step 1.2 — Database Initialization Parameters

\`\`\`sql
-- Parameters required or recommended for Demantra on 19c
-- Check current values
SELECT name, value FROM v$parameter
WHERE name IN (
  'sga_target', 'pga_aggregate_target',
  'open_cursors', 'session_cached_cursors',
  'undo_retention', 'db_files',
  'processes', 'sessions',
  'optimizer_features_enable',
  'parallel_max_servers', 'parallel_min_servers',
  'job_queue_processes', '_cursor_sharing_exact'
);

-- Apply recommended changes (adjust to your memory config)
ALTER SYSTEM SET open_cursors = 1000 SCOPE=BOTH;
ALTER SYSTEM SET session_cached_cursors = 300 SCOPE=BOTH;
ALTER SYSTEM SET undo_retention = 900 SCOPE=BOTH;
ALTER SYSTEM SET job_queue_processes = 20 SCOPE=BOTH;
ALTER SYSTEM SET parallel_max_servers = 32 SCOPE=BOTH;

-- Demantra requires optimizer_features_enable NOT forced to a legacy version
-- Verify it is at the current database version
SELECT value FROM v$parameter WHERE name = 'optimizer_features_enable';
-- Should match the DB version: 19.1.0
\`\`\`

### Step 1.3 — Enable Oracle Workspace Manager (required for Demantra versioning)

\`\`\`sql
-- Verify OWM is installed and VALID
SELECT comp_name, version, status FROM dba_registry WHERE comp_id = 'OWM';
-- If INVALID, run: @$ORACLE_HOME/rdbms/admin/owminst.plb

-- Grant OWM privileges to Demantra user
EXECUTE DBMS_WM.GRANT_SYSTEM_PRIV('CREATE_ANY_WORKSPACE', 'DEMANTRA', FALSE);
EXECUTE DBMS_WM.GRANT_SYSTEM_PRIV('ACCESS_ANY_WORKSPACE', 'DEMANTRA', FALSE);
\`\`\`

### Step 1.4 — Pre-Install Database Snapshot

\`\`\`bash
rman target / <<'EOF'
BACKUP DATABASE PLUS ARCHIVELOG TAG 'PRE_DEMANTRA_INSTALL' DELETE INPUT;
LIST BACKUP TAG 'PRE_DEMANTRA_INSTALL';
EOF
\`\`\`

---

## Phase 2: RHEL 9 Application Server Installation

### Step 2.1 — Stage the Demantra Software

\`\`\`bash
su - demantra

# Copy Demantra 12.2.x zip from MOS to staging area
# (Downloaded from MOS: Demantra 12.2.x for Linux x86-64)
cd /u01/demantra/stage
unzip Demantra_V12.2.x_linux64.zip

# Verify installer is present
ls -la Disk1/install/linux64/
# Should contain: runInstaller and related files
\`\`\`

### Step 2.2 — Set Demantra Environment Variables

\`\`\`bash
# Add to /home/demantra/.bash_profile
cat >> /home/demantra/.bash_profile <<'EOF'
# Demantra environment
export DEM_HOME=/u01/demantra/app
export JAVA_HOME=/usr/lib/jvm/java-11-openjdk
export ORACLE_HOME=/u01/oracle/product/19c/db_1
export PATH=$JAVA_HOME/bin:$ORACLE_HOME/bin:$PATH
export LD_LIBRARY_PATH=$ORACLE_HOME/lib:$JAVA_HOME/lib/server:$LD_LIBRARY_PATH
export TNS_ADMIN=$ORACLE_HOME/network/admin
export NLS_LANG=AMERICAN_AMERICA.AL32UTF8
export DEMANTRA_LOG_DIR=/u01/demantra/logs
EOF

source /home/demantra/.bash_profile
\`\`\`

### Step 2.3 — Configure tnsnames.ora for Demantra Connection

\`\`\`bash
# Add Demantra DB entry to tnsnames.ora
cat >> $TNS_ADMIN/tnsnames.ora <<'EOF'
DEMANTRA =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = db-server.company.com)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = DEMANTRA)
    )
  )
EOF

# Verify connectivity
tnsping DEMANTRA
sqlplus demantra/<password>@DEMANTRA -S <<'EOF'
SELECT 'Connection OK - ' || SYS_CONTEXT('USERENV','DB_NAME') FROM dual;
EXIT
EOF
\`\`\`

### Step 2.4 — Run the Demantra Installer

\`\`\`bash
su - demantra
cd /u01/demantra/stage/Disk1

# Silent install using response file (recommended for reproducibility)
# First, generate a response file template:
./install/linux64/runInstaller -silent -createResponseFile /tmp/demantra_install.rsp

# Edit the response file with your site-specific values:
# ORACLE_HOME=/u01/demantra/app
# DEMANTRA_DB_HOST=db-server.company.com
# DEMANTRA_DB_PORT=1521
# DEMANTRA_DB_SERVICE=DEMANTRA
# DEMANTRA_DB_USER=demantra
# DEMANTRA_DB_PASSWORD=<password>
# DEMANTRA_APP_PORT=7777
# DEMANTRA_ADMIN_PORT=7778
# INSTALL_TYPE=COMPLETE

# Run the installer
./install/linux64/runInstaller -silent -responseFile /tmp/demantra_install.rsp \
  -waitforcompletion 2>&1 | tee /u01/demantra/logs/install_$(date +%Y%m%d).log

# Verify successful install in log
grep -E "successful|ERROR|FAIL" /u01/demantra/logs/install_$(date +%Y%m%d).log | tail -20
\`\`\`

---

## Phase 3: Demantra Schema Creation

### Step 3.1 — Run the Schema Creation Scripts

\`\`\`bash
su - demantra
cd $DEM_HOME/demantra/setup

# Run schema creation (this creates all Demantra tables, sequences, and packages)
sqlplus demantra/<password>@DEMANTRA @create_schema.sql 2>&1 \
  | tee /u01/demantra/logs/schema_create_$(date +%Y%m%d).log

# Verify no errors
grep -i "ORA-\|ERROR\|error" /u01/demantra/logs/schema_create_$(date +%Y%m%d).log \
  | grep -v "no errors" | head -30
\`\`\`

### Step 3.2 — Validate Schema Object Count

\`\`\`sql
-- Verify all Demantra objects were created successfully
SELECT object_type, COUNT(*), SUM(CASE WHEN status = 'INVALID' THEN 1 ELSE 0 END) invalid_count
FROM dba_objects
WHERE owner = 'DEMANTRA'
GROUP BY object_type
ORDER BY object_type;

-- All PL/SQL objects must be VALID
-- Expected: approximately 200+ packages, 150+ tables, 100+ views, 300+ indexes

-- Compile any INVALID objects
EXECUTE UTL_RECOMP.RECOMP_SERIAL('DEMANTRA');

-- Re-check INVALID count
SELECT COUNT(*) FROM dba_objects
WHERE owner = 'DEMANTRA' AND status = 'INVALID';
-- Expected: 0
\`\`\`

### Step 3.3 — Gather Schema Statistics

\`\`\`sql
-- Required before first engine run
BEGIN
  DBMS_STATS.GATHER_SCHEMA_STATS(
    ownname          => 'DEMANTRA',
    estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,
    cascade          => TRUE,
    degree           => 4,
    no_invalidate    => FALSE
  );
END;
/
\`\`\`

---

## Phase 4: Demantra Engine Configuration

### Step 4.1 — Configure dem.ini

\`\`\`bash
# Main Demantra configuration file
vi $DEM_HOME/demantra/config/dem.ini

# Key settings to verify/set:
# DB_HOST=db-server.company.com
# DB_PORT=1521
# DB_SERVICE=DEMANTRA
# DB_USER=demantra
# ENGINE_THREADS=8          # Set to (CPU cores / 2) on app server
# BATCH_SIZE=500            # Items processed per engine thread batch
# ENGINE_HEAP_SIZE=4096     # JVM heap in MB (set to 50% of available RAM)
# ENGINE_LOG_DIR=/u01/demantra/logs
# ENGINE_LOG_LEVEL=INFO     # Use DEBUG only for troubleshooting
# PORT=7777
# ADMIN_PORT=7778
\`\`\`

### Step 4.2 — Start Demantra Services

\`\`\`bash
su - demantra

# Start the Demantra application server
$DEM_HOME/demantra/bin/startDemantra.sh

# Verify startup in log
tail -50 /u01/demantra/logs/demantra_startup.log

# Check Demantra port is listening
ss -tlnp | grep 7777
# Expected: LISTEN 0 ... *:7777

# Test web interface is up
curl -s -o /dev/null -w "%{http_code}" http://localhost:7777/demantra/
# Expected: 200 or 302
\`\`\`

### Step 4.3 — Configure Demantra-EBS Integration

\`\`\`sql
-- On the EBS database: create the Demantra interface synonyms
-- These allow Demantra to read from MSC schema tables

CREATE OR REPLACE SYNONYM demantra.msc_system_items     FOR msc.msc_system_items@EBS_DBLINK;
CREATE OR REPLACE SYNONYM demantra.msc_demands           FOR msc.msc_demands@EBS_DBLINK;
CREATE OR REPLACE SYNONYM demantra.msc_supplies          FOR msc.msc_supplies@EBS_DBLINK;
CREATE OR REPLACE SYNONYM demantra.msc_trading_partners  FOR msc.msc_trading_partners@EBS_DBLINK;

-- Verify DB link to EBS is working
SELECT COUNT(*) FROM msc.msc_system_items@EBS_DBLINK;
-- Should return a row count (number of items in your MSC schema)
\`\`\`

\`\`\`bash
# In Demantra UI: System Admin > Integration > EBS Integration
# Configure:
#   EBS DB Connection String: <EBS_TNS_ALIAS>
#   EBS Apps User: apps
#   EBS Apps Password: <apps_password>
#   EBS Instance: <instance_name>
#   Collection Scope: Full (first run) → Incremental (ongoing)
\`\`\`

### Step 4.4 — Run Initial Data Collection

\`\`\`bash
# Trigger initial full collection from command line
$DEM_HOME/demantra/bin/demEngine.sh -action COLLECT -mode FULL \
  2>&1 | tee /u01/demantra/logs/initial_collection_$(date +%Y%m%d).log

# Monitor collection progress
tail -f /u01/demantra/logs/initial_collection_$(date +%Y%m%d).log

# Verify collection completed
grep -E "COMPLETED|ERROR|FAIL" /u01/demantra/logs/initial_collection_$(date +%Y%m%d).log | tail -10
\`\`\`

---

## Phase 5: Post-Install Validation

### Step 5.1 — Validate Item-Location Count

\`\`\`sql
-- Verify items were loaded from EBS
SELECT COUNT(*) total_combinations,
       COUNT(DISTINCT item_name) distinct_items,
       COUNT(DISTINCT location_name) distinct_locations
FROM demantra.item_locations;
-- Compare against MSC item-org count from EBS

-- Verify demand history loaded
SELECT MIN(history_date) earliest, MAX(history_date) latest, COUNT(*) total_records
FROM demantra.demand_history;
-- Expect: 24–36 months of history for good Bayesian prior estimation
\`\`\`

### Step 5.2 — Run Initial Forecast Cycle

\`\`\`bash
# Run the first forecast engine cycle (expect 1–4 hours for initial run)
nohup $DEM_HOME/demantra/bin/demEngine.sh -action FORECAST \
  > /u01/demantra/logs/forecast_initial_$(date +%Y%m%d).log 2>&1 &

echo $! > /u01/demantra/logs/engine.pid
echo "Engine PID: $(cat /u01/demantra/logs/engine.pid)"

# Monitor
tail -f /u01/demantra/logs/forecast_initial_$(date +%Y%m%d).log
\`\`\`

### Step 5.3 — Validate Forecast Output

\`\`\`sql
-- Verify forecasts were generated
SELECT COUNT(*) total_forecasts,
       MIN(forecast_date) first_period,
       MAX(forecast_date) last_period,
       ROUND(AVG(forecast_quantity), 2) avg_qty
FROM demantra.forecasts
WHERE forecast_date >= TRUNC(SYSDATE, 'MM');
-- Expect: thousands to hundreds of thousands of rows

-- Sample the top 10 items by forecast quantity
SELECT item_name, location_name,
       SUM(forecast_quantity) total_90_day_forecast
FROM demantra.forecasts
WHERE forecast_date BETWEEN SYSDATE AND SYSDATE + 90
GROUP BY item_name, location_name
ORDER BY total_90_day_forecast DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

---

## Phase 6: Monitoring Scripts and Crontab

The following scripts are placed in \`/u01/demantra/scripts/\` and run by the \`demantra\` OS user.

### Script 1: Engine Status Check

\`\`\`bash
cat > /u01/demantra/scripts/check_engine_status.sh <<'SCRIPT'
#!/bin/bash
# check_engine_status.sh — verify Demantra application server is responding
LOG=/u01/demantra/logs/monitor_engine.log
ALERT_EMAIL="dba-team@company.com"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  --connect-timeout 10 http://localhost:7777/demantra/ 2>/dev/null)

if [ "$HTTP_STATUS" != "200" ] && [ "$HTTP_STATUS" != "302" ]; then
  echo "$TIMESTAMP ERROR: Demantra app server not responding (HTTP $HTTP_STATUS)" >> $LOG
  echo "Demantra app server is down on $(hostname). HTTP status: $HTTP_STATUS" \
    | mail -s "ALERT: Demantra App Server Down" $ALERT_EMAIL
else
  echo "$TIMESTAMP OK: Demantra app server responding (HTTP $HTTP_STATUS)" >> $LOG
fi
SCRIPT
chmod +x /u01/demantra/scripts/check_engine_status.sh
\`\`\`

### Script 2: Database Connectivity Check

\`\`\`bash
cat > /u01/demantra/scripts/check_db_connection.sh <<'SCRIPT'
#!/bin/bash
# check_db_connection.sh — verify Oracle DB is reachable from Demantra app server
source /home/demantra/.bash_profile
LOG=/u01/demantra/logs/monitor_db.log
ALERT_EMAIL="dba-team@company.com"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

DB_RESULT=$(sqlplus -s demantra/\${DEM_DB_PASS}@DEMANTRA <<'EOF'
SET PAGESIZE 0 FEEDBACK OFF VERIFY OFF HEADING OFF
SELECT 'OK' FROM dual;
EXIT
EOF
)

if [ "$DB_RESULT" != "OK" ]; then
  echo "$TIMESTAMP ERROR: Cannot connect to Demantra database" >> $LOG
  echo "Demantra DB connection failed on $(hostname). Check Oracle listener and service." \
    | mail -s "ALERT: Demantra DB Connection Failed" $ALERT_EMAIL
else
  echo "$TIMESTAMP OK: Database connection verified" >> $LOG
fi
SCRIPT
chmod +x /u01/demantra/scripts/check_db_connection.sh
\`\`\`

### Script 3: Engine Batch Job Completion Monitor

\`\`\`bash
cat > /u01/demantra/scripts/check_forecast_batch.sh <<'SCRIPT'
#!/bin/bash
# check_forecast_batch.sh — alert if nightly forecast batch did not complete
source /home/demantra/.bash_profile
LOG=/u01/demantra/logs/monitor_batch.log
ALERT_EMAIL="dba-team@company.com"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# Query: did a forecast batch complete since midnight today?
BATCH_STATUS=$(sqlplus -s demantra/\${DEM_DB_PASS}@DEMANTRA <<'EOF'
SET PAGESIZE 0 FEEDBACK OFF VERIFY OFF HEADING OFF
SELECT NVL(MAX(status), 'NONE')
FROM demantra.engine_run_log
WHERE run_type = 'FORECAST'
  AND start_time >= TRUNC(SYSDATE)
  AND status = 'COMPLETED';
EXIT
EOF
)

if [ "$BATCH_STATUS" != "COMPLETED" ]; then
  echo "$TIMESTAMP WARNING: No completed forecast batch found for today" >> $LOG
  echo "Demantra nightly forecast batch has NOT completed as of $TIMESTAMP. Check engine logs." \
    | mail -s "WARNING: Demantra Forecast Batch Incomplete" $ALERT_EMAIL
else
  echo "$TIMESTAMP OK: Nightly forecast batch completed" >> $LOG
fi
SCRIPT
chmod +x /u01/demantra/scripts/check_forecast_batch.sh
\`\`\`

### Script 4: Tablespace Space Monitoring

\`\`\`bash
cat > /u01/demantra/scripts/check_tablespace_space.sh <<'SCRIPT'
#!/bin/bash
# check_tablespace_space.sh — alert if Demantra tablespaces exceed 85% full
source /home/demantra/.bash_profile
LOG=/u01/demantra/logs/monitor_space.log
ALERT_EMAIL="dba-team@company.com"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
THRESHOLD=85

sqlplus -s demantra/\${DEM_DB_PASS}@DEMANTRA <<EOF | while read LINE; do
SET PAGESIZE 0 FEEDBACK OFF VERIFY OFF HEADING OFF
SELECT tablespace_name || '|' ||
       ROUND((1 - free_mb / total_mb) * 100, 1)
FROM (
  SELECT df.tablespace_name,
         SUM(df.bytes)/1048576 total_mb,
         NVL(SUM(fs.bytes)/1048576, 0) free_mb
  FROM dba_data_files df
  LEFT JOIN dba_free_space fs ON df.tablespace_name = fs.tablespace_name
  WHERE df.tablespace_name LIKE 'DEMANTRA%'
  GROUP BY df.tablespace_name
)
WHERE ROUND((1 - free_mb / total_mb) * 100, 1) > \${THRESHOLD};
EXIT
EOF
  if [ -n "$LINE" ]; then
    TS=$(echo "$LINE" | cut -d'|' -f1)
    PCT=$(echo "$LINE" | cut -d'|' -f2)
    echo "$TIMESTAMP ALERT: Tablespace $TS is \${PCT}% full" >> $LOG
    echo "Demantra tablespace $TS is \${PCT}% full on $(hostname). Add datafile or extend autoextend." \
      | mail -s "ALERT: Demantra Tablespace $TS \${PCT}% Full" $ALERT_EMAIL
  fi
done
echo "$TIMESTAMP Space check complete" >> $LOG
SCRIPT
chmod +x /u01/demantra/scripts/check_tablespace_space.sh
\`\`\`

### Script 5: Engine Log Error Scanner

\`\`\`bash
cat > /u01/demantra/scripts/scan_engine_logs.sh <<'SCRIPT'
#!/bin/bash
# scan_engine_logs.sh — scan Demantra engine logs for errors in the last hour
LOG_DIR=/u01/demantra/logs
ALERT_EMAIL="dba-team@company.com"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
SCAN_MARKER=/u01/demantra/logs/.last_scan_position

# Find log files modified in the last 65 minutes
RECENT_LOGS=$(find $LOG_DIR -name "*.log" -newer $SCAN_MARKER -type f 2>/dev/null)

if [ -n "$RECENT_LOGS" ]; then
  ERROR_LINES=$(grep -hE "ERROR|FATAL|ORA-|Exception|OutOfMemory" $RECENT_LOGS 2>/dev/null | tail -50)
  if [ -n "$ERROR_LINES" ]; then
    echo "$TIMESTAMP ERRORS found in Demantra logs:" >> $LOG_DIR/monitor_errors.log
    echo "$ERROR_LINES" >> $LOG_DIR/monitor_errors.log
    echo "Demantra engine log errors detected at $TIMESTAMP on $(hostname):

$ERROR_LINES

Check full logs in $LOG_DIR" | mail -s "WARNING: Demantra Engine Log Errors" $ALERT_EMAIL
  fi
fi
touch $SCAN_MARKER
SCRIPT
chmod +x /u01/demantra/scripts/scan_engine_logs.sh
\`\`\`

### Script 6: Weekly Statistics Refresh and Log Purge

\`\`\`bash
cat > /u01/demantra/scripts/weekly_maintenance.sh <<'SCRIPT'
#!/bin/bash
# weekly_maintenance.sh — refresh DB stats, purge old logs, purge stale forecast data
source /home/demantra/.bash_profile
LOG=/u01/demantra/logs/maintenance_$(date +%Y%m%d).log
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

echo "$TIMESTAMP Starting weekly Demantra maintenance" >> $LOG

# 1. Gather schema statistics
sqlplus -s demantra/\${DEM_DB_PASS}@DEMANTRA >> $LOG 2>&1 <<'EOF'
BEGIN
  DBMS_STATS.GATHER_SCHEMA_STATS(
    ownname          => 'DEMANTRA',
    estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,
    cascade          => TRUE,
    degree           => 4,
    no_invalidate    => FALSE
  );
END;
/
EXIT
EOF

# 2. Purge engine run logs older than 90 days
sqlplus -s demantra/\${DEM_DB_PASS}@DEMANTRA >> $LOG 2>&1 <<'EOF'
DELETE FROM demantra.engine_run_log WHERE start_time < SYSDATE - 90;
COMMIT;
SELECT 'Purged engine run log rows older than 90 days' FROM dual;
EXIT
EOF

# 3. Purge OS log files older than 30 days
find /u01/demantra/logs -name "*.log" -mtime +30 -delete
echo "$TIMESTAMP Purged OS log files older than 30 days" >> $LOG

# 4. Check disk space after purge
df -h /u01/demantra >> $LOG

echo "$TIMESTAMP Weekly maintenance complete" >> $LOG
SCRIPT
chmod +x /u01/demantra/scripts/weekly_maintenance.sh
\`\`\`

### Step 6.7 — Configure the Crontab

\`\`\`bash
# Edit the demantra user crontab
crontab -u demantra -e

# Add the following entries:
\`\`\`

\`\`\`cron
# Demantra Monitoring and Operations Crontab
# Format: minute hour day-of-month month day-of-week command

# --- Availability Monitoring ---
# Check app server every 5 minutes
*/5 * * * * /u01/demantra/scripts/check_engine_status.sh >> /u01/demantra/logs/cron.log 2>&1

# Check DB connectivity every 10 minutes
*/10 * * * * /u01/demantra/scripts/check_db_connection.sh >> /u01/demantra/logs/cron.log 2>&1

# --- Batch Job Monitoring ---
# Check that nightly forecast completed — run at 07:00 (after expected 06:00 completion)
0 7 * * * /u01/demantra/scripts/check_forecast_batch.sh >> /u01/demantra/logs/cron.log 2>&1

# --- Space Monitoring ---
# Check tablespace space every 4 hours
0 */4 * * * /u01/demantra/scripts/check_tablespace_space.sh >> /u01/demantra/logs/cron.log 2>&1

# --- Log Scanning ---
# Scan engine logs for errors every hour
5 * * * * /u01/demantra/scripts/scan_engine_logs.sh >> /u01/demantra/logs/cron.log 2>&1

# --- Nightly Engine Run ---
# Run Demantra forecast engine at 01:00 nightly (after ASCP collection completes at ~00:30)
0 1 * * * /u01/demantra/app/demantra/bin/demEngine.sh -action FORECAST \
  >> /u01/demantra/logs/forecast_$(date +\%Y\%m\%d).log 2>&1

# --- Weekly Maintenance ---
# Run weekly maintenance every Sunday at 03:00
0 3 * * 0 /u01/demantra/scripts/weekly_maintenance.sh >> /u01/demantra/logs/cron.log 2>&1
\`\`\`

### Step 6.8 — Verify Crontab is Active

\`\`\`bash
# Verify entries are registered
crontab -u demantra -l

# Verify cron daemon is running
systemctl status crond
# Expected: Active (running)

# Enable cron to start at boot (RHEL 9)
systemctl enable crond

# Manually trigger the space check to confirm scripts work end-to-end
su - demantra -c "/u01/demantra/scripts/check_tablespace_space.sh"
cat /u01/demantra/logs/monitor_space.log | tail -5
\`\`\`

---

## Phase 7: Hardening Post-Install

### Step 7.1 — Reduce DBA Role (Least Privilege)

\`\`\`sql
-- After installation, revoke DBA and grant only the minimum needed for operations
REVOKE DBA FROM demantra;

-- Grant only required system privileges
GRANT CREATE SESSION TO demantra;
GRANT CREATE TABLE TO demantra;
GRANT CREATE VIEW TO demantra;
GRANT CREATE SEQUENCE TO demantra;
GRANT CREATE PROCEDURE TO demantra;
GRANT CREATE TRIGGER TO demantra;
GRANT CREATE TYPE TO demantra;
GRANT CREATE DATABASE LINK TO demantra;
GRANT CREATE JOB TO demantra;
GRANT SELECT ANY DICTIONARY TO demantra;

-- Verify Demantra still functions after role reduction
-- Run: check_db_connection.sh and a small test engine run
\`\`\`

### Step 7.2 — Store DB Password Securely

\`\`\`bash
# Use Oracle Wallet to avoid plaintext passwords in scripts
# (Rather than $DEM_DB_PASS environment variable)

mkstore -wrl /u01/demantra/wallet -create
mkstore -wrl /u01/demantra/wallet -createCredential DEMANTRA demantra <password>

# Add wallet location to sqlnet.ora
cat >> $TNS_ADMIN/sqlnet.ora <<'EOF'
WALLET_LOCATION =
  (SOURCE =
    (METHOD = FILE)
    (METHOD_DATA =
      (DIRECTORY = /u01/demantra/wallet)
    )
  )
SQLNET.WALLET_OVERRIDE = TRUE
EOF

# Test wallet-based connection (no password required)
sqlplus /@DEMANTRA <<'EOF'
SELECT 'Wallet connection OK' FROM dual;
EXIT
EOF
\`\`\`

### Step 7.3 — Final Validation Checklist

| Check | Command | Expected |
|-------|---------|---------|
| App server responding | \`curl -I http://localhost:7777/demantra/\` | HTTP 200/302 |
| DB connection | \`sqlplus /@DEMANTRA\` | Connection OK |
| Schema objects valid | Query dba_objects | 0 INVALID objects |
| Forecast data present | Query demantra.forecasts | Rows for current month+ |
| Crontab active | \`crontab -u demantra -l\` | All 7 entries present |
| Cron daemon running | \`systemctl status crond\` | Active (running) |
| Monitoring logs writing | \`ls -la /u01/demantra/logs/\` | Recent timestamps |
| EBS integration working | Query msc_demantra_measures | Rows present |`,
};

async function main() {
  console.log('Inserting Oracle Demantra installation runbook...');
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
