import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS 12.2.11 RAC Configuration Runbook',
  slug: 'oracle-ebs-12211-rac-runbook',
  excerpt:
    'Step-by-step runbook for configuring Oracle RAC for EBS 12.2.11: Grid Infrastructure 19c silent installation with cluvfy pre-checks, ASM disk group creation for data, redo, and FRA, DBCA silent RAC database creation with EBS-specific parameters, srvctl service creation with TAF for interactive and batch EBS tiers, WebLogic Active GridLink and FAN/ONS configuration, EBS application tier AutoConfig updates for SCAN-based connectivity, and monitoring scripts for RAC service status, interconnect health, and per-instance session and workload distribution.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-29'),
  youtubeUrl: null,
  content: `## Overview

This runbook covers configuring Oracle Grid Infrastructure 19c and Oracle RAC 19c for an EBS 12.2.11 database tier on a two-node cluster. All phases are performed as root or oracle unless noted.

**Environment**:
- Node 1: ebsrac01.example.com — public IP 10.1.1.11, VIP 10.1.1.111, private interconnect 192.168.1.11
- Node 2: ebsrac02.example.com — public IP 10.1.1.12, VIP 10.1.1.112, private interconnect 192.168.1.12
- SCAN name: ebsscan.example.com — resolves to 10.1.1.121, 10.1.1.122, 10.1.1.123 (three IPs in DNS)
- Database unique name: EBSPRD, instances: EBSPRD1 (node 1), EBSPRD2 (node 2)
- Grid Infrastructure home: /u01/app/19.0.0/grid
- Oracle home: /u01/app/oracle/product/19.0.0/dbhome_1
- ASM disk groups: +DATA, +REDO, +FRA on shared SAN storage

---

## Phase 0: Pre-Installation Checks

### 0.1 Network and DNS Verification

\`\`\`bash
# On both nodes — verify all hostnames resolve correctly
nslookup ebsrac01.example.com    # public hostname
nslookup ebsrac01-vip.example.com # VIP hostname
nslookup ebsrac02.example.com
nslookup ebsrac02-vip.example.com
nslookup ebsscan.example.com      # must return 3 IPs

# Verify SCAN resolves to all 3 IPs
dig ebsscan.example.com | grep "ANSWER SECTION" -A 5

# Verify interconnect interfaces are up and reachable between nodes
ping -c 4 192.168.1.12  # from node 1 to node 2 interconnect
ping -c 4 192.168.1.11  # from node 2 to node 1 interconnect

# Verify SSH equivalency is configured between oracle and grid users
su - oracle -c "ssh ebsrac02 hostname"
su - grid -c "ssh ebsrac02 hostname"
\`\`\`

### 0.2 OS Prerequisites (Both Nodes)

\`\`\`bash
# Run as root on both nodes

# Install required packages for Oracle 19c RAC on RHEL 8
dnf install -y oracle-database-preinstall-19c

# Or manually install key packages if not using preinstall RPM:
dnf install -y compat-libcap1 compat-libstdc++-33 ksh libaio-devel \\
  libXtst libXrender libXi sysstat nfs-utils smartmontools

# Set kernel parameters (preinstall RPM handles this automatically)
# Verify shared memory and semaphore settings
sysctl -a | grep -E "shmmax|shmall|shmmni|sem"

# Disable transparent huge pages for Oracle
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# Persist THP disable
cat >> /etc/rc.d/rc.local << 'EOF'
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag
EOF
chmod +x /etc/rc.d/rc.local

# Create OS users and groups
groupadd -g 54321 oinstall
groupadd -g 54322 dba
groupadd -g 54323 oper
groupadd -g 54324 backupdba
groupadd -g 54325 dgdba
groupadd -g 54326 kmdba
groupadd -g 54327 asmdba
groupadd -g 54328 asmoper
groupadd -g 54329 asmadmin
useradd -u 54321 -g oinstall -G dba,oper,backupdba,dgdba,kmdba grid
useradd -u 54322 -g oinstall -G dba,oper,asmdba,backupdba,dgdba,kmdba oracle
\`\`\`

### 0.3 Shared Disk Preparation (Both Nodes)

\`\`\`bash
# Identify shared disks on both nodes (presented via SAN multipath)
ls -la /dev/mapper/mpath*
# or
ls -la /dev/sd* | grep -v "^total"

# Label disks for ASM (as root)
# DATA disk group — 4 x 2TB disks
oracleasm createdisk DATA1 /dev/mapper/mpatha
oracleasm createdisk DATA2 /dev/mapper/mpathb
oracleasm createdisk DATA3 /dev/mapper/mpathc
oracleasm createdisk DATA4 /dev/mapper/mpathd

# REDO disk group — 2 x 200GB disks
oracleasm createdisk REDO1 /dev/mapper/mpathe
oracleasm createdisk REDO2 /dev/mapper/mpathf

# FRA disk group — 2 x 4TB disks
oracleasm createdisk FRA1 /dev/mapper/mpathg
oracleasm createdisk FRA2 /dev/mapper/mpathh

# Verify disks are visible from both nodes
oracleasm scandisks
oracleasm listdisks
\`\`\`

### 0.4 Run cluvfy Pre-Installation Check

\`\`\`bash
# Run from the Grid Infrastructure staging directory (as oracle or grid user)
cd /u05/staging/grid19c/

./runcluvfy.sh stage -pre crsinst \\
  -n ebsrac01,ebsrac02 \\
  -networks "eth0:10.1.1.0/255.255.255.0:public,eth1:192.168.1.0/255.255.255.0:private" \\
  -scanname ebsscan.example.com \\
  -scanport 1521 \\
  -osdba dba \\
  -osoper oper \\
  -osasm asmadmin \\
  -verbose 2>&1 | tee /tmp/cluvfy_precheck.log

# Review failures — all FAILED items must be resolved before proceeding
grep -c "FAILED" /tmp/cluvfy_precheck.log
grep "FAILED" /tmp/cluvfy_precheck.log
\`\`\`

---

## Phase 1: Install Oracle Grid Infrastructure 19c

### 1.1 Silent Installation

\`\`\`bash
# Run as root on NODE 1 only — Grid Infrastructure installs on all nodes automatically

GRID_HOME=/u01/app/19.0.0/grid
mkdir -p \${GRID_HOME}
chown -R grid:oinstall /u01/app/19.0.0

# Unzip Grid software
su - grid -c "cd /u05/staging/grid19c && unzip -q LINUX.X64_193000_grid_home.zip -d \${GRID_HOME}"

# Run silent install
su - grid -c "
\${GRID_HOME}/gridSetup.sh -silent \\
  INVENTORY_LOCATION=/u01/app/oraInventory \\
  oracle.install.option=CRS_CONFIG \\
  ORACLE_BASE=/u01/app/grid \\
  oracle.install.asm.OSDBA=asmdba \\
  oracle.install.asm.OSOPER=asmoper \\
  oracle.install.asm.OSASM=asmadmin \\
  oracle.install.crs.config.gpnp.scanName=ebsscan.example.com \\
  oracle.install.crs.config.gpnp.scanPort=1521 \\
  oracle.install.crs.config.ClusterConfiguration=STANDALONE \\
  oracle.install.crs.config.configureAsExtendedCluster=false \\
  oracle.install.crs.config.clusterName=ebsrac-cluster \\
  oracle.install.crs.config.clusterNodes='ebsrac01:ebsrac01-vip,ebsrac02:ebsrac02-vip' \\
  oracle.install.crs.config.networkInterfaceList='eth0:10.1.1.0:1,eth1:192.168.1.0:5' \\
  oracle.install.crs.config.storageOption=FLEX_ASM_STORAGE \\
  oracle.install.asm.diskGroup.name=OCR_VOTE \\
  oracle.install.asm.diskGroup.redundancy=NORMAL \\
  oracle.install.asm.diskGroup.AUSize=4 \\
  oracle.install.asm.diskGroup.diskList='/dev/oracleasm/disks/VOTE1,/dev/oracleasm/disks/VOTE2,/dev/oracleasm/disks/VOTE3' \\
  oracle.install.asm.gimrDG.AUSize=4 \\
  oracle.install.asm.configureGIMRDataDG=false \\
  SELECTED_LANGUAGES=en \\
  oracle.install.asm.SYSASMPassword=\${ASM_SYSASM_PASSWORD} \\
  oracle.install.asm.diskGroup.diskPassword='' \\
  oracle.install.crs.config.ignoreDownNodes=false \\
  oracle.install.config.managementOption=NONE 2>&1
" | tee /tmp/grid_install.log
\`\`\`

### 1.2 Run Root Scripts

\`\`\`bash
# Run on NODE 1 first
/u01/app/oraInventory/orainstRoot.sh
/u01/app/19.0.0/grid/root.sh

# THEN run on NODE 2 (after node 1 root.sh completes)
# SSH to node 2 and run:
/u01/app/oraInventory/orainstRoot.sh
/u01/app/19.0.0/grid/root.sh

# Back on node 1 — confirm Clusterware is running on both nodes
\${GRID_HOME}/bin/crsctl check cluster -all
\${GRID_HOME}/bin/crsctl stat res -t
\`\`\`

---

## Phase 2: Create ASM Disk Groups

\`\`\`bash
# Connect to ASM as SYSASM
export ORACLE_SID=+ASM1
export ORACLE_HOME=/u01/app/19.0.0/grid

sqlplus / as sysasm << 'SQL'

-- DATA disk group (EXTERNAL redundancy — SAN provides hardware RAID)
CREATE DISKGROUP DATA EXTERNAL REDUNDANCY
  DISK '/dev/oracleasm/disks/DATA1' NAME DATA1,
       '/dev/oracleasm/disks/DATA2' NAME DATA2,
       '/dev/oracleasm/disks/DATA3' NAME DATA3,
       '/dev/oracleasm/disks/DATA4' NAME DATA4
ATTRIBUTE
  'compatible.rdbms' = '19.0',
  'compatible.asm'   = '19.0',
  'au_size'          = '4M',
  'sector_size'      = '512';

-- REDO disk group — separate group for redo log I/O isolation
CREATE DISKGROUP REDO EXTERNAL REDUNDANCY
  DISK '/dev/oracleasm/disks/REDO1' NAME REDO1,
       '/dev/oracleasm/disks/REDO2' NAME REDO2
ATTRIBUTE
  'compatible.rdbms' = '19.0',
  'compatible.asm'   = '19.0',
  'au_size'          = '4M';

-- FRA disk group
CREATE DISKGROUP FRA EXTERNAL REDUNDANCY
  DISK '/dev/oracleasm/disks/FRA1' NAME FRA1,
       '/dev/oracleasm/disks/FRA2' NAME FRA2
ATTRIBUTE
  'compatible.rdbms' = '19.0',
  'compatible.asm'   = '19.0',
  'au_size'          = '4M';

-- Verify
SELECT NAME, STATE, TOTAL_MB/1024 AS TOTAL_GB, FREE_MB/1024 AS FREE_GB
FROM V\$ASM_DISKGROUP
ORDER BY NAME;

EXIT;
SQL
\`\`\`

---

## Phase 3: Install Oracle Database 19c RAC Software

\`\`\`bash
# Run as oracle on NODE 1 — installs software on both nodes via SSH
DB_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
mkdir -p \${DB_HOME}
chown -R oracle:oinstall /u01/app/oracle

# Unzip database software
su - oracle -c "cd /u05/staging/db19c && unzip -q LINUX.X64_193000_db_home.zip -d \${DB_HOME}"

# Apply the latest EBS-recommended 19c RU before creating any database
su - oracle -c "
\${DB_HOME}/OPatch/opatch apply /u05/staging/19c_ru/ -silent
"

# Install database software (software-only — no database creation yet)
su - oracle -c "
\${DB_HOME}/runInstaller -silent -ignorePrereqFailure \\
  oracle.install.option=INSTALL_DB_SWONLY \\
  INVENTORY_LOCATION=/u01/app/oraInventory \\
  ORACLE_HOME=\${DB_HOME} \\
  ORACLE_BASE=/u01/app/oracle \\
  oracle.install.db.InstallEdition=EE \\
  oracle.install.db.OSDBA_GROUP=dba \\
  oracle.install.db.OSOPER_GROUP=oper \\
  oracle.install.db.OSBACKUPDBA_GROUP=backupdba \\
  oracle.install.db.OSDGDBA_GROUP=dgdba \\
  oracle.install.db.OSKMDBA_GROUP=kmdba \\
  oracle.install.db.OSRACDBA_GROUP=dba \\
  oracle.install.db.isRACOneInstall=false \\
  oracle.install.db.racOneServiceName='' \\
  CLUSTER_NODES='ebsrac01,ebsrac02' \\
  DECLINE_SECURITY_UPDATES=true
" | tee /tmp/db_install.log

# Run root.sh on both nodes
/u01/app/oracle/product/19.0.0/dbhome_1/root.sh    # node 1
# ssh ebsrac02 "/u01/app/oracle/product/19.0.0/dbhome_1/root.sh"  # node 2
\`\`\`

---

## Phase 4: Create the EBS RAC Database with DBCA

\`\`\`bash
export ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_SID=EBSPRD1

# Create the RAC database silently
\${ORACLE_HOME}/bin/dbca -silent \\
  -createDatabase \\
  -templateName General_Purpose.dbc \\
  -gdbName EBSPRD \\
  -sid EBSPRD \\
  -createAsContainerDatabase false \\
  -numberOfPDBs 0 \\
  -nodelist ebsrac01,ebsrac02 \\
  -storageType ASM \\
  -datafileDestination '+DATA' \\
  -recoveryAreaDestination '+FRA' \\
  -recoveryAreaSize 200000 \\
  -redoLogFileSize 512 \\
  -databaseType OLTP \\
  -totalMemory 163840 \\
  -characterSet AL32UTF8 \\
  -nationalCharacterSet UTF8 \\
  -sysPassword \${SYS_PASSWORD} \\
  -systemPassword \${SYSTEM_PASSWORD} \\
  -initParams "db_name=EBSPRD,db_unique_name=EBSPRD,cluster_database=TRUE,
    sga_target=160G,sga_max_size=160G,pga_aggregate_target=32G,
    shared_pool_size=6G,db_cache_size=120G,
    log_buffer=256M,
    open_cursors=500,
    cursor_sharing=EXACT,
    undo_management=AUTO,
    db_recovery_file_dest='+FRA',
    db_recovery_file_dest_size=200G,
    enable_goldengate_replication=FALSE,
    _optimizer_adaptive_plans=FALSE,
    _optimizer_adaptive_statistics=FALSE,
    _optimizer_use_feedback=FALSE,
    _b_tree_bitmap_plans=FALSE" \\
  -listeners LISTENER \\
  -obfuscatedPasswords false 2>&1 | tee /tmp/dbca_rac.log
\`\`\`

### 4.1 Move Redo Logs to +REDO Disk Group

\`\`\`sql
-- After DBCA creates the database, move redo logs to the dedicated +REDO group
export ORACLE_SID=EBSPRD1
sqlplus / as sysdba

-- Add new groups in +REDO for thread 1 (node 1)
ALTER DATABASE ADD LOGFILE THREAD 1
  GROUP 11 ('+REDO') SIZE 512M;
ALTER DATABASE ADD LOGFILE THREAD 1
  GROUP 12 ('+REDO') SIZE 512M;
ALTER DATABASE ADD LOGFILE THREAD 1
  GROUP 13 ('+REDO') SIZE 512M;
ALTER DATABASE ADD LOGFILE THREAD 1
  GROUP 14 ('+REDO') SIZE 512M;

-- Add new groups in +REDO for thread 2 (node 2)
ALTER DATABASE ADD LOGFILE THREAD 2
  GROUP 21 ('+REDO') SIZE 512M;
ALTER DATABASE ADD LOGFILE THREAD 2
  GROUP 22 ('+REDO') SIZE 512M;
ALTER DATABASE ADD LOGFILE THREAD 2
  GROUP 23 ('+REDO') SIZE 512M;
ALTER DATABASE ADD LOGFILE THREAD 2
  GROUP 24 ('+REDO') SIZE 512M;

-- Force log switches to make old groups inactive
ALTER SYSTEM SWITCH ALL LOGFILE;
ALTER SYSTEM SWITCH ALL LOGFILE;
ALTER SYSTEM CHECKPOINT GLOBAL;

-- Drop the original +DATA redo log groups (after they become INACTIVE)
SELECT GROUP#, THREAD#, STATUS, MEMBERS FROM V\$LOG ORDER BY THREAD#, GROUP#;
-- Drop groups 1, 2, 3 (thread 1 old groups) and 4, 5, 6 (thread 2 old groups)
-- when STATUS = INACTIVE
-- ALTER DATABASE DROP LOGFILE GROUP &n;

-- Add standby redo logs for Data Guard readiness (5 per thread, same size as online logs)
ALTER DATABASE ADD STANDBY LOGFILE THREAD 1 GROUP 31 ('+REDO') SIZE 512M;
ALTER DATABASE ADD STANDBY LOGFILE THREAD 1 GROUP 32 ('+REDO') SIZE 512M;
ALTER DATABASE ADD STANDBY LOGFILE THREAD 1 GROUP 33 ('+REDO') SIZE 512M;
ALTER DATABASE ADD STANDBY LOGFILE THREAD 1 GROUP 34 ('+REDO') SIZE 512M;
ALTER DATABASE ADD STANDBY LOGFILE THREAD 1 GROUP 35 ('+REDO') SIZE 512M;

ALTER DATABASE ADD STANDBY LOGFILE THREAD 2 GROUP 41 ('+REDO') SIZE 512M;
ALTER DATABASE ADD STANDBY LOGFILE THREAD 2 GROUP 42 ('+REDO') SIZE 512M;
ALTER DATABASE ADD STANDBY LOGFILE THREAD 2 GROUP 43 ('+REDO') SIZE 512M;
ALTER DATABASE ADD STANDBY LOGFILE THREAD 2 GROUP 44 ('+REDO') SIZE 512M;
ALTER DATABASE ADD STANDBY LOGFILE THREAD 2 GROUP 45 ('+REDO') SIZE 512M;

EXIT;
SQL
\`\`\`

### 4.2 Set Per-Instance SPFILE Parameters

\`\`\`sql
export ORACLE_SID=EBSPRD1
sqlplus / as sysdba

-- Instance-specific parameters
ALTER SYSTEM SET INSTANCE_NUMBER=1 SCOPE=SPFILE SID='EBSPRD1';
ALTER SYSTEM SET THREAD=1 SCOPE=SPFILE SID='EBSPRD1';
ALTER SYSTEM SET UNDO_TABLESPACE='UNDOTBS1' SCOPE=SPFILE SID='EBSPRD1';

ALTER SYSTEM SET INSTANCE_NUMBER=2 SCOPE=SPFILE SID='EBSPRD2';
ALTER SYSTEM SET THREAD=2 SCOPE=SPFILE SID='EBSPRD2';
ALTER SYSTEM SET UNDO_TABLESPACE='UNDOTBS2' SCOPE=SPFILE SID='EBSPRD2';

-- Create UNDOTBS2 for node 2
CREATE UNDO TABLESPACE UNDOTBS2
  DATAFILE '+DATA' SIZE 10G AUTOEXTEND ON NEXT 1G MAXSIZE 100G;

-- Bounce node 2 to pick up per-instance SPFILE changes
EXIT;
SQL

# On node 2:
# srvctl stop instance -db EBSPRD -instance EBSPRD2
# srvctl start instance -db EBSPRD -instance EBSPRD2
\`\`\`

---

## Phase 5: Create EBS Database Services

Database services define how the EBS application tier connects to the RAC cluster. Do not use the default EBSPRD service.

### 5.1 Create and Start Services with srvctl

\`\`\`bash
export ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export PATH=\${ORACLE_HOME}/bin:\${PATH}

# Service for EBS interactive (Forms, OAF, WebLogic) — prefers node 1
srvctl add service -db EBSPRD \\
  -service EBSPRD_APP \\
  -preferred EBSPRD1 \\
  -available EBSPRD2 \\
  -failovertype SELECT \\
  -failoverretry 30 \\
  -failoverdelay 5 \\
  -failovermethod BASIC \\
  -clbgoal LONG \\
  -rlbgoal NONE \\
  -commit_outcome TRUE \\
  -policy AUTOMATIC

# Service for EBS Concurrent Managers (batch) — prefers node 2
srvctl add service -db EBSPRD \\
  -service EBSPRD_BATCH \\
  -preferred EBSPRD2 \\
  -available EBSPRD1 \\
  -failovertype SELECT \\
  -failoverretry 30 \\
  -failoverdelay 5 \\
  -failovermethod BASIC \\
  -clbgoal LONG \\
  -rlbgoal NONE \\
  -policy AUTOMATIC

# Start both services
srvctl start service -db EBSPRD -service EBSPRD_APP
srvctl start service -db EBSPRD -service EBSPRD_BATCH

# Verify services are running
srvctl status service -db EBSPRD
srvctl config service -db EBSPRD -service EBSPRD_APP
\`\`\`

### 5.2 Verify Services Are Registered with SCAN Listener

\`\`\`bash
# Check SCAN listener registrations from any node
lsnrctl status LISTENER_SCAN1
# Service EBSPRD_APP should appear in the registered services list
# Service EBSPRD_BATCH should appear too
\`\`\`

---

## Phase 6: Configure EBS Application Tier for RAC

### 6.1 Update the EBS Context File for SCAN Connectivity

\`\`\`bash
# On the EBS application tier server
source /u01/oracle/EBS/EBSapps.env run

# Edit the context file to use the SCAN name and EBS-specific service
# \${INST_TOP}/appl/admin/\${CONTEXT_NAME}.xml
vi \${INST_TOP}/appl/admin/\${CONTEXT_NAME}.xml

# Update these key variables:
# s_dbhost        → ebsscan.example.com   (SCAN name, not individual node hostname)
# s_dbSid         → EBSPRD_APP            (EBS service name, not instance SID)
# s_db_port       → 1521
# s_apps_jdbc_url → (will be regenerated by AutoConfig using above values)
\`\`\`

### 6.2 Run AutoConfig to Regenerate tnsnames.ora

\`\`\`bash
\${ADMIN_SCRIPTS_HOME}/adautocfg.sh apps/\${APPS_PASSWORD}

# Verify the generated tnsnames.ora uses the SCAN
grep -A8 "EBSPRD" \${TNS_ADMIN}/tnsnames.ora
# Should show HOST=ebsscan.example.com
\`\`\`

### 6.3 Add Batch Service TNS Entry for Concurrent Managers

\`\`\`bash
# The concurrent manager should connect via the EBSPRD_BATCH service
# Add a separate TNS alias for the batch service to tnsnames.ora
cat >> \${TNS_ADMIN}/tnsnames.ora << 'EOF'

EBSPRD_BATCH =
  (DESCRIPTION =
    (LOAD_BALANCE = ON)
    (FAILOVER = ON)
    (ADDRESS = (PROTOCOL = TCP)(HOST = ebsscan.example.com)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = EBSPRD_BATCH)
      (FAILOVER_MODE =
        (TYPE = SELECT)
        (METHOD = BASIC)
        (RETRIES = 30)
        (DELAY = 5)
      )
    )
  )
EOF
\`\`\`

### 6.4 Configure WebLogic Active GridLink Data Source for FAN/ONS

\`\`\`bash
# Connect to WebLogic Admin Server via WLST to configure Active GridLink
\${FMW_HOME}/oracle_common/common/bin/wlst.sh << 'WLST'
connect('weblogic', '\${WL_ADMIN_PASSWORD}', 't3://ebsapp01.example.com:7001')
edit()
startEdit()

# Navigate to the EBS JDBC data source and convert to Active GridLink
cd('/JDBCSystemResources/EBSDataSource/JDBCResource/EBSDataSource')
cmo.setDatasourceType('AGL')

# Set the SCAN-based URL for Active GridLink
cd('/JDBCSystemResources/EBSDataSource/JDBCResource/EBSDataSource/JDBCDriverParams/EBSDataSource')
cmo.setUrl('jdbc:oracle:thin:@(DESCRIPTION=(LOAD_BALANCE=ON)(FAILOVER=ON)(ADDRESS=(PROTOCOL=TCP)(HOST=ebsscan.example.com)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=EBSPRD_APP)(SERVER=DEDICATED)))')

# Enable FAN (ONS) for Active GridLink
cd('/JDBCSystemResources/EBSDataSource/JDBCResource/EBSDataSource/JDBCOracleParams/EBSDataSource')
cmo.setFanEnabled(true)
cmo.setOnsNodeList('ebsrac01.example.com:6200,ebsrac02.example.com:6200')

# Connection pool settings
cd('/JDBCSystemResources/EBSDataSource/JDBCResource/EBSDataSource/JDBCConnectionPoolParams/EBSDataSource')
set('MaxCapacity', 200)
set('MinCapacity', 20)
set('TestConnectionsOnReserve', 'true')
set('TestTableName', 'SQL SELECT 1 FROM DUAL')

save()
activate()
disconnect()
exit()
WLST
\`\`\`

### 6.5 Verify ONS Is Running on Both RAC Nodes

\`\`\`bash
# ONS runs as part of Grid Infrastructure
export GRID_HOME=/u01/app/19.0.0/grid

# Check ONS status on each node
\${GRID_HOME}/bin/srvctl status ons
\${GRID_HOME}/bin/srvctl config ons

# Verify WebLogic can reach ONS on each node
# From the WebLogic server:
nc -zv ebsrac01.example.com 6200
nc -zv ebsrac02.example.com 6200
\`\`\`

---

## Phase 7: EBS Startup and Validation

### 7.1 Start All EBS Services

\`\`\`bash
source /u01/oracle/EBS/EBSapps.env run
\${ADMIN_SCRIPTS_HOME}/adstrtal.sh apps/\${APPS_PASSWORD}
\${ADMIN_SCRIPTS_HOME}/adcmctl.sh start apps/\${APPS_PASSWORD}

# Verify all EBS services up
\${ADMIN_SCRIPTS_HOME}/adstpall.sh status apps/\${APPS_PASSWORD}
\`\`\`

### 7.2 Validate RAC and EBS Connectivity

\`\`\`sql
-- Connect to the EBSPRD_APP service and verify instance routing
sqlplus apps/\${APPS_PASSWORD}@EBSPRD_APP

-- Which instance am I connected to?
SELECT INSTANCE_NAME, HOST_NAME FROM V\$INSTANCE;

-- Verify service is active
SELECT NAME, NETWORK_NAME, ENABLED FROM V\$SERVICES
WHERE NAME IN ('EBSPRD_APP','EBSPRD_BATCH')
ORDER BY NAME;

-- Verify both instances are up
SELECT INST_ID, INSTANCE_NAME, HOST_NAME, STATUS
FROM GV\$INSTANCE
ORDER BY INST_ID;

-- Check Cache Fusion interconnect is healthy (no errors)
SELECT INST_ID, NAME, VALUE
FROM GV\$SYSSTAT
WHERE NAME IN ('gc cr blocks received','gc current blocks received',
               'gc cr block lost','gc current block lost')
ORDER BY INST_ID, NAME;
-- gc cr block lost and gc current block lost should be 0 or near-0
\`\`\`

### 7.3 Test Node Failure Failover

\`\`\`bash
# Simulate node 2 failure and verify EBS continues on node 1
# (perform in a TEST environment first)

# Stop instance 2 via srvctl (graceful)
srvctl stop instance -db EBSPRD -instance EBSPRD2 -stopoption IMMEDIATE

# Verify EBSPRD_BATCH service relocated to node 1
srvctl status service -db EBSPRD

# Login to EBS and verify functionality continues on node 1
# Run a concurrent program as a functional test

# Restart node 2 instance
srvctl start instance -db EBSPRD -instance EBSPRD2

# Verify services rebalanced (EBSPRD_BATCH should return to node 2)
srvctl status service -db EBSPRD
\`\`\`

---

## Phase 8: Monitoring Scripts

### Script 1: RAC Service Status Monitor

\`\`\`bash
#!/bin/bash
# File: /home/oracle/scripts/rac_service_monitor.sh
# Alerts when an EBS database service is not running on its preferred instance

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
ORACLE_SID=EBSPRD1
ALERT_EMAIL="dba-alerts@example.com"
LOG=/home/oracle/scripts/logs/rac_service.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
export ORACLE_HOME ORACLE_SID

SERVICE_STATUS=\$(\${ORACLE_HOME}/bin/srvctl status service -db EBSPRD 2>&1)
echo "\${TIMESTAMP}" >> \${LOG}
echo "\${SERVICE_STATUS}" >> \${LOG}
echo "---" >> \${LOG}

# Alert if any service is not running or has relocated from preferred instance
if echo "\${SERVICE_STATUS}" | grep -q "is not running\|stopped"; then
  MSG="Subject: [RAC ALERT] EBS database service not running on \$(hostname)\n\n\${SERVICE_STATUS}"
  echo -e "\${MSG}" | /usr/sbin/sendmail \${ALERT_EMAIL}
fi

# Alert if any instance is down
INST_STATUS=\$(\${ORACLE_HOME}/bin/srvctl status database -db EBSPRD 2>&1)
if echo "\${INST_STATUS}" | grep -q "is not running"; then
  MSG="Subject: [RAC ALERT] RAC instance down — \$(hostname)\n\n\${INST_STATUS}"
  echo -e "\${MSG}" | /usr/sbin/sendmail \${ALERT_EMAIL}
fi
\`\`\`

### Script 2: Interconnect Health Monitor

\`\`\`bash
#!/bin/bash
# File: /home/oracle/scripts/rac_interconnect_monitor.sh
# Monitors Cache Fusion block loss statistics — any block loss indicates interconnect issues

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
ORACLE_SID=EBSPRD1
ALERT_EMAIL="dba-alerts@example.com"
LOG=/home/oracle/scripts/logs/rac_interconnect.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
export ORACLE_HOME ORACLE_SID

IC_STATS=\$(\${ORACLE_HOME}/bin/sqlplus -s / as sysdba << 'SQL'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT INST_ID || '|' || NAME || '|' || VALUE
FROM GV\$SYSSTAT
WHERE NAME IN ('gc cr block lost','gc current block lost',
               'gc cr blocks received','gc current blocks received')
ORDER BY INST_ID, NAME;
EXIT;
SQL
)

echo "\${TIMESTAMP}" >> \${LOG}
echo "\${IC_STATS}" >> \${LOG}

# Alert if any block loss is detected
CR_LOST=\$(echo "\${IC_STATS}" | grep "gc cr block lost" | awk -F'|' '{sum += \$3} END {print sum+0}')
CUR_LOST=\$(echo "\${IC_STATS}" | grep "gc current block lost" | awk -F'|' '{sum += \$3} END {print sum+0}')

if [ "\${CR_LOST}" -gt 0 ] || [ "\${CUR_LOST}" -gt 0 ]; then
  MSG="Subject: [RAC ALERT] Cache Fusion block loss detected on \$(hostname)\n\nCR blocks lost: \${CR_LOST}\nCurrent blocks lost: \${CUR_LOST}\n\nInvestigate interconnect network and ocr/vote disk health."
  echo -e "\${MSG}" | /usr/sbin/sendmail \${ALERT_EMAIL}
fi
\`\`\`

### Script 3: Per-Instance Workload Distribution Report

\`\`\`bash
#!/bin/bash
# File: /home/oracle/scripts/rac_workload_report.sh
# Reports active sessions and CPU usage per RAC instance for EBS workload balancing

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
ORACLE_SID=EBSPRD1
LOG=/home/oracle/scripts/logs/rac_workload.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
export ORACLE_HOME ORACLE_SID

echo "\${TIMESTAMP}" >> \${LOG}

\${ORACLE_HOME}/bin/sqlplus -s / as sysdba << 'SQL' >> \${LOG}
SET PAGESIZE 50 LINESIZE 120 FEEDBACK OFF
COLUMN INSTANCE_NAME FORMAT A15
COLUMN HOST_NAME FORMAT A20
COLUMN SERVICE_NAME FORMAT A20

PROMPT --- Sessions per Instance and Service ---
SELECT i.INST_ID, i.INSTANCE_NAME, i.HOST_NAME,
       s.SERVICE_NAME,
       COUNT(*) AS ACTIVE_SESSIONS,
       ROUND(SUM(ss.VALUE),0) AS CPU_USAGE_CENTI_SECS
FROM GV\$INSTANCE i
JOIN GV\$SESSION s ON i.INST_ID = s.INST_ID
JOIN GV\$SESSTAT ss ON s.INST_ID = ss.INST_ID
  AND s.SID = ss.SID AND ss.STATISTIC# = 12  -- CPU used by this session
WHERE s.STATUS = 'ACTIVE'
AND s.USERNAME IS NOT NULL
GROUP BY i.INST_ID, i.INSTANCE_NAME, i.HOST_NAME, s.SERVICE_NAME
ORDER BY i.INST_ID, ACTIVE_SESSIONS DESC;

PROMPT
PROMPT --- Wait Events per Instance (Top 5) ---
SELECT INST_ID, EVENT,
       ROUND(TIME_WAITED_MICRO/1e6, 1) AS SECONDS_WAITED,
       TOTAL_WAITS
FROM GV\$SYSTEM_EVENT
WHERE WAIT_CLASS != 'Idle'
AND (INST_ID, TIME_WAITED_MICRO) IN (
  SELECT INST_ID, MAX(TIME_WAITED_MICRO)
  FROM GV\$SYSTEM_EVENT
  WHERE WAIT_CLASS != 'Idle'
  GROUP BY INST_ID
)
ORDER BY INST_ID, SECONDS_WAITED DESC;
EXIT;
SQL
\`\`\`

### Crontab Setup

\`\`\`bash
# Add to oracle user crontab on NODE 1: crontab -e

# RAC service status: every 3 minutes
*/3 * * * * /home/oracle/scripts/rac_service_monitor.sh >> /dev/null 2>&1

# Interconnect health: every 5 minutes
*/5 * * * * /home/oracle/scripts/rac_interconnect_monitor.sh >> /dev/null 2>&1

# Workload distribution report: every 30 minutes during business hours
*/30 7-20 * * * /home/oracle/scripts/rac_workload_report.sh >> /dev/null 2>&1

# Log rotation
0 3 * * 0 find /home/oracle/scripts/logs -name "rac_*.log" -mtime +30 -delete
\`\`\`

---

## Quick Reference: srvctl and Clusterware Commands

\`\`\`bash
ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
GRID_HOME=/u01/app/19.0.0/grid

# Check cluster status
\${GRID_HOME}/bin/crsctl check cluster -all
\${GRID_HOME}/bin/crsctl stat res -t

# RAC database operations
srvctl status database -db EBSPRD           # all instances
srvctl start database -db EBSPRD            # start all instances
srvctl stop database -db EBSPRD -stopoption IMMEDIATE
srvctl start instance -db EBSPRD -instance EBSPRD2
srvctl stop instance -db EBSPRD -instance EBSPRD2 -stopoption IMMEDIATE

# Service operations
srvctl status service -db EBSPRD
srvctl start service -db EBSPRD -service EBSPRD_APP
srvctl stop service -db EBSPRD -service EBSPRD_APP
srvctl relocate service -db EBSPRD -service EBSPRD_APP -oldinst EBSPRD1 -newinst EBSPRD2

# SCAN and listener operations
srvctl status scan
srvctl status scan_listener
srvctl status listener

# ASM operations (as grid user)
srvctl status asm
srvctl start asm
\${GRID_HOME}/bin/asmcmd lsdg     # list disk groups
\${GRID_HOME}/bin/asmcmd lsdsk    # list all ASM disks

# ONS status
srvctl status ons
srvctl config ons
\`\`\``,
};

async function main() {
  console.log('Inserting EBS RAC runbook...');
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
