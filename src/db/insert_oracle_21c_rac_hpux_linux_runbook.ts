import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle 21c RAC on RHEL 9 Migration Runbook — HP-UX Cross-Platform Migration, Grid Infrastructure, and Operations',
  slug: 'oracle-21c-rac-hpux-to-rhel9-migration-runbook',
  excerpt:
    'Step-by-step runbook for migrating Oracle RAC from HP-UX (big-endian) to Oracle 21c Grid Infrastructure on RHEL 9. Covers OS hardening, Grid Infrastructure install, ASM configuration, XTTS cross-platform migration with RMAN, PDB plug-in, complete RAC health script, crontab scheduling, and a full maintenance calendar.',
  category: 'rac-clusterware' as const,
  isPremium: true,
  published: true,
  publishedAt: new Date('2026-06-19'),
  content: `## Phase 0: Pre-Migration Assessment

### 0.1 Source Database Inventory (HP-UX)

Capture the full source baseline before touching anything:

\`\`\`sql
-- Run on HP-UX source as SYSDBA
-- Database version and endian
SELECT banner FROM v\$version;
SELECT platform_name, endian_format FROM v\$transportable_platform WHERE endian_format='Big';

-- Database size
SELECT sum(bytes)/1024/1024/1024 total_gb FROM dba_segments;

-- Tablespace list (identify SYSTEM, SYSAUX, UNDO, TEMP separately)
SELECT tablespace_name, status, contents, bigfile FROM dba_tablespaces ORDER BY 1;

-- Non-default parameters
SELECT name, value FROM v\$parameter WHERE isdefault='FALSE' ORDER BY name;

-- Invalid objects count
SELECT count(*) FROM dba_objects WHERE status != 'VALID';

-- Characterset
SELECT value FROM nls_database_parameters WHERE parameter = 'NLS_CHARACTERSET';
\`\`\`

\`\`\`bash
# OS and hardware capture on HP-UX
uname -a
ioscan -fnC disk | head -40
bdf
swlist | grep -i oracle
\`\`\`

Record: DB version, character set, total size, tablespace count, invalid object count. These drive the migration timeline.

### 0.2 Target Architecture Decision

| Decision | Recommendation |
|----------|---------------|
| Oracle version | 21c (21.3+) |
| CDB name | PRODCDB (all apps become PDBs) |
| RAC nodes | Minimum 2, ideally 3 for rolling patch with no downtime |
| ASM redundancy | NORMAL (2-way) for DATA/FRA, HIGH (3-way) for GRID |
| Private interconnect | Dedicated bonded 2x10GbE (LACP mode 4) per node |
| Storage | FC SAN or iSCSI with multipath — no NFS for redo/undo |
| SCAN | 3 IPs in DNS round-robin for cluster FQDN |

### 0.3 Downtime Window Estimation

\`\`\`
XTTS bulk phase:     online, no downtime
Final delta apply:   2–4 hours (depends on redo rate)
Data Pump metadata:  1–2 hours
PDB plug-in/open:    30 minutes
Validation:          2 hours
Total window:        6–8 hours minimum
\`\`\`

For < 2 hours downtime, add GoldenGate replication to bridge the final gap.

---

## Phase 1: RHEL 9 OS Configuration (All Nodes)

Run all Phase 1 steps on every RAC node unless noted.

### 1.1 Kernel Parameters

Add to \`/etc/sysctl.d/97-oracle-rac.conf\`:

\`\`\`
kernel.shmmax              = 137438953472
kernel.shmall              = 33554432
kernel.shmmni              = 4096
kernel.sem                 = 250 32000 100 128
net.ipv4.ip_local_port_range = 9000 65500
net.core.rmem_max          = 4194304
net.core.wmem_max          = 1048576
net.ipv4.tcp_rmem          = 4096 87380 4194304
net.ipv4.tcp_wmem          = 4096 65536 1048576
fs.aio-max-nr              = 1048576
fs.file-max                = 6815744
vm.swappiness              = 10
vm.dirty_background_ratio  = 3
vm.dirty_ratio             = 15
\`\`\`

\`\`\`bash
sysctl --system
\`\`\`

### 1.2 Security Limits

\`/etc/security/limits.d/97-oracle.conf\`:

\`\`\`
oracle soft nofile  65536
oracle hard nofile  65536
oracle soft nproc   16384
oracle hard nproc   16384
oracle soft stack   10240
oracle hard stack   32768
oracle soft memlock unlimited
oracle hard memlock unlimited
grid   soft nofile  65536
grid   hard nofile  65536
grid   soft nproc   16384
grid   hard nproc   16384
grid   soft memlock unlimited
grid   hard memlock unlimited
\`\`\`

### 1.3 Required Packages

\`\`\`bash
dnf install -y bc binutils compat-openssl11 elfutils-libelf \
  gcc gcc-c++ glibc glibc-devel ksh libaio libaio-devel \
  libgcc libstdc++ libstdc++-devel libxcb libXi libXtst \
  make net-tools nfs-utils smartmontools sysstat \
  targetcli lvm2 device-mapper-multipath \
  policycoreutils selinux-policy-devel unzip
\`\`\`

Set SELinux to permissive during install (re-evaluate post-cutover):

\`\`\`bash
setenforce 0
sed -i 's/^SELINUX=.*/SELINUX=permissive/' /etc/selinux/config
\`\`\`

### 1.4 Create OS Users and Groups

\`\`\`bash
groupadd -g 54321 oinstall
groupadd -g 54322 dba
groupadd -g 54323 oper
groupadd -g 54324 backupdba
groupadd -g 54325 dgdba
groupadd -g 54326 kmdba
groupadd -g 54327 asmdba
groupadd -g 54328 asmoper
groupadd -g 54329 asmadmin
groupadd -g 54330 racdba

useradd -u 54321 -g oinstall -G dba,asmdba,backupdba,dgdba,kmdba,racdba,oper oracle
useradd -u 54322 -g oinstall -G asmadmin,asmdba,asmoper,dba grid

echo "oracle ALL=(ALL) NOPASSWD: /sbin/oracleasm,/usr/sbin/oracleasm" >> /etc/sudoers.d/oracle
\`\`\`

### 1.5 SSH Equivalence Between Nodes

On each node as both \`oracle\` and \`grid\`:

\`\`\`bash
ssh-keygen -t rsa -N "" -f ~/.ssh/id_rsa
# Append each node's public key to every node's authorized_keys
# Oracle provides cluvfy and runInstaller which do this automatically
# Verify: ssh racnode2 date  (no password prompt)
\`\`\`

### 1.6 Network Configuration

Configure three network interfaces per node:

\`\`\`
eth0 / bond0  — public:          192.168.10.x1/24  (node1), .x2 (node2)
eth1 / bond1  — private (IC):    172.16.0.1/24     (node1), .2 (node2)
               VIP (managed by CRS): 192.168.10.y1/24
\`\`\`

DNS entries required (all nodes + SCAN):

\`\`\`
racnode1         192.168.10.11
racnode2         192.168.10.12
racnode1-vip     192.168.10.21
racnode2-vip     192.168.10.22
rac-scan         192.168.10.31   # SCAN — 3 IPs round-robin
rac-scan         192.168.10.32
rac-scan         192.168.10.33
\`\`\`

Verify DNS resolution from each node before Grid install:

\`\`\`bash
nslookup rac-scan
# Must return all 3 SCAN IPs
\`\`\`

### 1.7 Shared Storage — ASM Disk Preparation

Identify shared disks (same device letter/WWN on each node):

\`\`\`bash
# List multipath devices
multipath -ll | grep -E "mpath|dm-"

# Label disks for ASM using asmlib or udev rules
# RHEL 9 preferred: udev rules (asmlib deprecated)
cat > /etc/udev/rules.d/99-oracle-asmdevices.rules <<'UDEVEOF'
KERNEL=="dm-2", SUBSYSTEM=="block", OWNER="grid", GROUP="asmadmin", MODE="0660", SYMLINK+="oracleasm/DATA1"
KERNEL=="dm-3", SUBSYSTEM=="block", OWNER="grid", GROUP="asmadmin", MODE="0660", SYMLINK+="oracleasm/DATA2"
KERNEL=="dm-4", SUBSYSTEM=="block", OWNER="grid", GROUP="asmadmin", MODE="0660", SYMLINK+="oracleasm/FRA1"
KERNEL=="dm-5", SUBSYSTEM=="block", OWNER="grid", GROUP="asmadmin", MODE="0660", SYMLINK+="oracleasm/GRID1"
KERNEL=="dm-6", SUBSYSTEM=="block", OWNER="grid", GROUP="asmadmin", MODE="0660", SYMLINK+="oracleasm/GRID2"
KERNEL=="dm-7", SUBSYSTEM=="block", OWNER="grid", GROUP="asmadmin", MODE="0660", SYMLINK+="oracleasm/GRID3"
UDEVEOF
udevadm control --reload-rules && udevadm trigger
\`\`\`

Verify all disks visible on both nodes:

\`\`\`bash
ls -la /dev/oracleasm/
\`\`\`

---

## Phase 2: Oracle Grid Infrastructure 21c Installation

### 2.1 Filesystem Layout

\`\`\`bash
mkdir -p /u01/app/grid
mkdir -p /u01/app/21c/grid          # GRID_HOME
mkdir -p /u01/app/oracle
mkdir -p /u01/app/oracle/product/21c/dbhome_1
mkdir -p /u01/app/oraInventory

chown -R grid:oinstall /u01/app/grid /u01/app/21c
chown -R oracle:oinstall /u01/app/oracle
chown -R grid:oinstall /u01/app/oraInventory
chmod -R 775 /u01/app
\`\`\`

### 2.2 Grid Infrastructure Install

As \`grid\` user, run the Grid Infrastructure installer:

\`\`\`bash
cd /u01/media/grid21c
./gridSetup.sh -silent \
  -responseFile /tmp/grid_install.rsp \
  -ignorePrereqFailure

# Or use the interactive installer for first-time setups:
./gridSetup.sh
\`\`\`

Key response file parameters:

\`\`\`ini
oracle.install.option=CRS_CONFIG
ORACLE_BASE=/u01/app/grid
oracle.install.asm.OSDBA=asmdba
oracle.install.asm.OSOPER=asmoper
oracle.install.asm.OSASM=asmadmin
oracle.install.crs.config.scanName=rac-scan
oracle.install.crs.config.scanPort=1521
oracle.install.crs.config.clusterNodes=racnode1:racnode1-vip,racnode2:racnode2-vip
oracle.install.crs.config.privateInterconnects=eth1:172.16.0.0/24
oracle.install.crs.config.storageOption=FLEX_ASM_STORAGE
oracle.install.asm.diskGroup.name=GRID
oracle.install.asm.diskGroup.redundancy=HIGH
oracle.install.asm.diskGroup.disks=/dev/oracleasm/GRID1,/dev/oracleasm/GRID2,/dev/oracleasm/GRID3
oracle.install.asm.diskGroup.diskDiscoveryString=/dev/oracleasm/*
oracle.install.asm.SYSASMPassword=<your_sysasm_password>
oracle.install.asm.monitorPassword=<your_monitor_password>
\`\`\`

Run root scripts when prompted:

\`\`\`bash
# On node1 first
/u01/app/oraInventory/orainstRoot.sh
/u01/app/21c/grid/root.sh

# Then on node2
/u01/app/oraInventory/orainstRoot.sh
/u01/app/21c/grid/root.sh
\`\`\`

### 2.3 Create DATA and FRA Diskgroups

\`\`\`bash
asmca -silent \
  -createDiskGroup \
  -diskGroupName DATA \
  -diskList /dev/oracleasm/DATA1,/dev/oracleasm/DATA2 \
  -redundancy NORMAL \
  -au_size 4

asmca -silent \
  -createDiskGroup \
  -diskGroupName FRA \
  -diskList /dev/oracleasm/FRA1 \
  -redundancy NORMAL \
  -au_size 4
\`\`\`

Verify:

\`\`\`bash
asmcmd lsdg
# DATA and FRA should show MOUNTED
\`\`\`

### 2.4 Verify Cluster

\`\`\`bash
crsctl stat res -t
crsctl query css votedisk
oifcfg getif
cluvfy comp healthcheck -collect cluster -html /tmp/cluvfy_report.html
\`\`\`

---

## Phase 3: Oracle 21c Database Software Installation

As \`oracle\` user:

\`\`\`bash
cd /u01/media/db21c
./runInstaller -silent \
  -responseFile /tmp/db_install.rsp \
  -ignorePrereqFailure
\`\`\`

Key response file parameters:

\`\`\`ini
oracle.install.option=INSTALL_DB_SWONLY
ORACLE_HOME=/u01/app/oracle/product/21c/dbhome_1
oracle.install.db.InstallEdition=EE
oracle.install.db.OSDBA_GROUP=dba
oracle.install.db.OSOPER_GROUP=oper
oracle.install.db.OSBACKUPDBA_GROUP=backupdba
oracle.install.db.OSDGDBA_GROUP=dgdba
oracle.install.db.OSKMDBA_GROUP=kmdba
oracle.install.db.OSRACDBA_GROUP=racdba
oracle.install.db.isRACOneInstall=false
oracle.install.db.rac.serverpoolName=
oracle.install.db.rac.nodes=racnode1,racnode2
\`\`\`

Run root script on each node:

\`\`\`bash
/u01/app/oracle/product/21c/dbhome_1/root.sh
\`\`\`

Apply latest Release Update (RU) before creating the database:

\`\`\`bash
cd /u01/media/patches/21c_RU
opatch apply -silent
opatch lspatches | head -5
\`\`\`

---

## Phase 4: Create the Target 21c RAC CDB

\`\`\`bash
dbca -silent \
  -createDatabase \
  -templateName General_Purpose.dbc \
  -gdbName PRODCDB \
  -sid PRODCDB \
  -createAsContainerDatabase true \
  -numberOfPDBs 0 \
  -pdbName "" \
  -SysPassword <your_sys_password> \
  -SystemPassword <your_system_password> \
  -storageType ASM \
  -diskGroupName DATA \
  -recoveryGroupName FRA \
  -characterSet AL32UTF8 \
  -nationalCharacterSet AL16UTF16 \
  -totalMemory 16384 \
  -databaseType OLTP \
  -useOMF true \
  -enableArchive true \
  -nodeinfo racnode1,racnode2 \
  -listeners LISTENER \
  -emConfiguration NONE \
  -oui_internal
\`\`\`

Verify CDB:

\`\`\`sql
sqlplus / as sysdba
SQL> SELECT name, db_unique_name, cdb, open_mode FROM v\$database;
SQL> SELECT instance_name, host_name, status FROM gv\$instance;
\`\`\`

---

## Phase 5: Cross-Platform Migration — XTTS (HP-UX to RHEL 9)

### 5.1 On HP-UX Source — Prepare Tablespaces

\`\`\`sql
-- Identify user tablespaces to migrate (exclude SYSTEM, SYSAUX, UNDO, TEMP)
SELECT tablespace_name FROM dba_tablespaces
WHERE contents NOT IN ('UNDO','TEMPORARY')
AND tablespace_name NOT IN ('SYSTEM','SYSAUX');

-- Set tablespaces READ ONLY for initial RMAN conversion
ALTER TABLESPACE USERS    READ ONLY;
ALTER TABLESPACE APP_DATA READ ONLY;
ALTER TABLESPACE APP_IDX  READ ONLY;
\`\`\`

### 5.2 On HP-UX Source — RMAN Convert

\`\`\`
RMAN> CONVERT TABLESPACE USERS, APP_DATA, APP_IDX
      TO PLATFORM 'Linux x86 64-bit'
      FORMAT '/migration/xtts/%U'
      DB_FILE_NAME_CONVERT NONE;
\`\`\`

This produces platform-converted datafiles. Transfer them to the Linux target:

\`\`\`bash
rsync -avz --progress oracle@hpux-db01:/migration/xtts/ /migration/xtts/
\`\`\`

### 5.3 Apply Incremental Backups (Repeat Until Cutover)

While source is open READ WRITE, capture incremental changes:

\`\`\`
-- On HP-UX RMAN:
RMAN> BACKUP INCREMENTAL FROM SCN <last_scn>
      TABLESPACE USERS, APP_DATA, APP_IDX
      FORMAT '/migration/incr/%U';
\`\`\`

Transfer incremental backups to Linux and apply with RMAN CONVERT.

### 5.4 Cutover Window — Final Steps

\`\`\`sql
-- On HP-UX: note final SCN
SELECT current_scn FROM v\$database;

-- Set tablespaces READ ONLY for final conversion
ALTER TABLESPACE USERS    READ ONLY;
ALTER TABLESPACE APP_DATA READ ONLY;
ALTER TABLESPACE APP_IDX  READ ONLY;
\`\`\`

\`\`\`bash
# Final RMAN incremental on HP-UX
# Transfer to Linux
# Apply on Linux target
\`\`\`

### 5.5 Create PDB on Linux Target

\`\`\`sql
-- On 21c CDB as SYSDBA
CREATE PLUGGABLE DATABASE PRODPDB
  ADMIN USER pdbadmin IDENTIFIED BY <your_pdb_password>
  STORAGE (MAXSIZE 500G)
  DEFAULT TABLESPACE USERS
    DATAFILE '+DATA' SIZE 1G AUTOEXTEND ON;

ALTER PLUGGABLE DATABASE PRODPDB OPEN;
ALTER SESSION SET CONTAINER = PRODPDB;
\`\`\`

### 5.6 Import Tablespaces into PDB

\`\`\`sql
-- On 21c Linux, connected to PRODPDB
ALTER SESSION SET CONTAINER = PRODPDB;

-- Copy converted datafiles to ASM
ALTER TABLESPACE USERS ADD DATAFILE '+DATA/PRODCDB/PRODPDB/DATAFILE/users01.dbf';

-- Plug tablespace (attach converted datafile)
-- Use Data Pump transport tablespace for metadata
\`\`\`

\`\`\`bash
# Export metadata only from HP-UX with Data Pump
expdp system/<pass>@hpuxdb \
  TRANSPORT_TABLESPACES=USERS,APP_DATA,APP_IDX \
  TRANSPORT_FULL_CHECK=Y \
  DUMPFILE=ts_meta.dmp \
  LOGFILE=ts_meta_exp.log

# Import metadata into 21c PDB
impdp system/<pass>@racnode1:1521/PRODPDB \
  TRANSPORT_DATAFILES='+DATA/PRODCDB/PRODPDB/DATAFILE/users01.dbf',\
'+DATA/PRODCDB/PRODPDB/DATAFILE/app_data01.dbf',\
'+DATA/PRODCDB/PRODPDB/DATAFILE/app_idx01.dbf' \
  DUMPFILE=ts_meta.dmp \
  LOGFILE=ts_meta_imp.log
\`\`\`

### 5.7 Post-Import Validation

\`\`\`sql
-- Set tablespaces READ WRITE
ALTER TABLESPACE USERS    READ WRITE;
ALTER TABLESPACE APP_DATA READ WRITE;
ALTER TABLESPACE APP_IDX  READ WRITE;

-- Recompile invalids
EXEC DBMS_UTILITY.COMPILE_SCHEMA(schema => 'APPUSER', compile_all => FALSE);

-- Check for remaining invalids
SELECT object_type, count(*) FROM dba_objects
WHERE status = 'INVALID'
GROUP BY object_type;

-- Run UTL_FILE and DBMS_METADATA spot checks
SELECT count(*) FROM appuser.critical_table;
\`\`\`

---

## Phase 6: RAC Services Configuration

Create application services for connection load balancing:

\`\`\`bash
srvctl add service -d PRODCDB -s app_service \
  -preferred PRODCDB1,PRODCDB2 \
  -available PRODCDB1,PRODCDB2 \
  -pdb PRODPDB \
  -clbgoal LONG \
  -rlbgoal SERVICE_TIME \
  -notification TRUE \
  -failovertype SELECT \
  -failovermethod BASIC \
  -failoverretry 30 \
  -failoverdelay 5

srvctl start service -d PRODCDB -s app_service
srvctl status service -d PRODCDB
\`\`\`

Verify SCAN listener sees the service:

\`\`\`bash
lsnrctl status LISTENER_SCAN1
\`\`\`

---

## Phase 7: Full RAC Health Monitoring Script

Save as \`/opt/scripts/rac21c_health.sh\`:

\`\`\`bash
#!/bin/bash
# =====================================================================
# Oracle 21c RAC Comprehensive Health Check
# Schedule: */10 * * * * /opt/scripts/rac21c_health.sh
# =====================================================================

GRID_HOME=/u01/app/21c/grid
ORACLE_HOME=/u01/app/oracle/product/21c/dbhome_1
ORACLE_SID=PRODCDB1
DB_UNIQUE=PRODCDB
PDB_NAME=PRODPDB
ALERT_EMAIL=dba-oncall@example.com
DIAG_BASE=/u01/app/oracle/diag/rdbms/\$(echo \${DB_UNIQUE} | tr '[:upper:]' '[:lower:]')/\${ORACLE_SID}
ALERT_LOG=\${DIAG_BASE}/trace/alert_\${ORACLE_SID}.log
LOG=/var/log/rac21c_health.log
STATE=/var/lib/rac_health
mkdir -p "\${STATE}"

export ORACLE_HOME ORACLE_SID
export GRID_HOME
export PATH=\${GRID_HOME}/bin:\${ORACLE_HOME}/bin:\${PATH}
export LD_LIBRARY_PATH=\${ORACLE_HOME}/lib:\${GRID_HOME}/lib

TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
ALERTS=()

log()   { echo "[\${TIMESTAMP}] \$*" | tee -a "\${LOG}"; }
alert() { ALERTS+=("\$*"); log "ALERT: \$*"; }

# ---- 1. Cluster resource status ----
check_crs_resources() {
  log "--- CRS resource check ---"
  FAILED=\$(crsctl stat res -t 2>/dev/null \
    | awk '/OFFLINE|FAILED/{f++} END{print f+0}')
  [ "\${FAILED}" -gt 0 ] \
    && alert "\${FAILED} CRS resource(s) are OFFLINE or FAILED" \
    || log "CRS: all resources nominal"

  # Check nodeapps specifically
  for NODE in racnode1 racnode2; do
    NODE_STAT=\$(crsctl stat res "ora.\${NODE}.vip" 2>/dev/null | grep STATE | awk '{print \$NF}')
    [ "\${NODE_STAT}" != "ONLINE" ] \
      && alert "VIP for \${NODE} is \${NODE_STAT:-UNKNOWN}" \
      || log "VIP \${NODE}: ONLINE"
  done
}

# ---- 2. Voting disk quorum ----
check_voting_disks() {
  log "--- Voting disk quorum ---"
  ONLINE=\$(crsctl query css votedisk 2>/dev/null | grep -c "ONLINE")
  TOTAL=\$(crsctl query css votedisk  2>/dev/null | grep -c "votedisk")
  log "Voting disks: \${ONLINE}/\${TOTAL} online"
  [ "\${ONLINE}" -lt 2 ] \
    && alert "CRITICAL: Only \${ONLINE}/\${TOTAL} voting disks online — cluster at eviction risk"
}

# ---- 3. ASM diskgroups ----
check_asm_diskgroups() {
  log "--- ASM diskgroup health ---"
  \${GRID_HOME}/bin/asmcmd lsdg 2>/dev/null | awk 'NR>1' | while read STATE TYPE REDUN USABLE_FB USABLE_FILE TOTAL_MB FREE_MB REQ_MIR USABLE_MB OFFLINE_DIS NAME; do
    DG_NAME=\$(echo "\${NAME}" | tr -d '/')
    if [ "\${STATE}" != "MOUNTED" ]; then
      alert "Diskgroup \${DG_NAME} is \${STATE} (expected MOUNTED)"
    else
      # Check free space — alert if < 20% free
      if [ "\${TOTAL_MB}" -gt 0 ] 2>/dev/null; then
        PCT_USED=\$(( (TOTAL_MB - FREE_MB) * 100 / TOTAL_MB ))
        log "ASM +\${DG_NAME}: \${PCT_USED}% used (\${FREE_MB}MB free of \${TOTAL_MB}MB)"
        [ "\${PCT_USED}" -ge 80 ] \
          && alert "ASM +\${DG_NAME} at \${PCT_USED}% capacity"
      fi
    fi
  done
}

# ---- 4. All RAC instances open ----
check_instances() {
  log "--- RAC instance status ---"
  INST_STATUS=\$(\${ORACLE_HOME}/bin/sqlplus -s / as sysdba 2>/dev/null <<'SQLE'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT inst_id||' '||instance_name||' '||host_name||' '||status FROM gv\$instance ORDER BY inst_id;
EXIT
SQLE
)
  echo "\${INST_STATUS}" | while read INST_ID INST_NAME HOST STATUS_VAL; do
    if [ "\${STATUS_VAL}" = "OPEN" ]; then
      log "Instance \${INST_ID} (\${INST_NAME} on \${HOST}): OPEN"
    else
      alert "Instance \${INST_ID} (\${INST_NAME} on \${HOST}) status: \${STATUS_VAL:-UNREACHABLE}"
    fi
  done
}

# ---- 5. PDB open status ----
check_pdb() {
  log "--- PDB status ---"
  PDB_STATUS=\$(\${ORACLE_HOME}/bin/sqlplus -s / as sysdba 2>/dev/null <<SQLE
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT inst_id||' '||name||' '||open_mode FROM gv\\\$pdbs WHERE name='\${PDB_NAME}' ORDER BY inst_id;
EXIT
SQLE
)
  echo "\${PDB_STATUS}" | while read INST_ID PDB_NAME_VAL MODE; do
    [ "\${MODE}" = "READ WRITE" ] \
      && log "PDB \${PDB_NAME_VAL} on instance \${INST_ID}: READ WRITE" \
      || alert "PDB \${PDB_NAME_VAL} on instance \${INST_ID} is \${MODE:-UNKNOWN}"
  done
}

# ---- 6. SCAN listener health ----
check_scan() {
  log "--- SCAN listener ---"
  for I in 1 2 3; do
    STAT=\$(crsctl stat res "ora.LISTENER_SCAN\${I}.lsnr" 2>/dev/null | grep STATE | awk '{print \$NF}')
    [ "\${STAT}" = "ONLINE" ] \
      && log "SCAN listener \${I}: ONLINE" \
      || alert "SCAN listener \${I} is \${STAT:-OFFLINE}"
  done
}

# ---- 7. Private interconnect errors ----
check_interconnect() {
  log "--- Interconnect interface errors ---"
  IC_IFACE=\$(oifcfg getif 2>/dev/null | awk '/cluster_interconnect/{print \$1; exit}')
  if [ -n "\${IC_IFACE}" ]; then
    RX_ERR=\$(cat /sys/class/net/\${IC_IFACE}/statistics/rx_errors 2>/dev/null || echo 0)
    TX_ERR=\$(cat /sys/class/net/\${IC_IFACE}/statistics/tx_errors 2>/dev/null || echo 0)
    RX_DROP=\$(cat /sys/class/net/\${IC_IFACE}/statistics/rx_dropped 2>/dev/null || echo 0)
    log "IC \${IC_IFACE}: rx_err=\${RX_ERR} tx_err=\${TX_ERR} rx_drop=\${RX_DROP}"
    ( [ "\${RX_ERR}" -gt 500 ] || [ "\${TX_ERR}" -gt 500 ] || [ "\${RX_DROP}" -gt 1000 ] ) \
      && alert "Elevated interconnect error counts on \${IC_IFACE}: rx_err=\${RX_ERR} tx_err=\${TX_ERR} rx_drop=\${RX_DROP}"
  fi
}

# ---- 8. Alert log scan (new entries since last run) ----
check_alert_log() {
  log "--- Alert log scan ---"
  MARKER="\${STATE}/alert_log_marker"
  if [ -f "\${ALERT_LOG}" ]; then
    if [ -f "\${MARKER}" ]; then
      NEW_ERRORS=\$(awk "NR > \$(cat \${MARKER})" "\${ALERT_LOG}" \
        | grep -cE "ORA-|FATAL|evict|CSS-|CRS-[0-9]{4}[1-9]" 2>/dev/null || echo 0)
      [ "\${NEW_ERRORS}" -gt 0 ] \
        && alert "Alert log: \${NEW_ERRORS} new critical line(s) since last check"
    fi
    wc -l < "\${ALERT_LOG}" > "\${MARKER}"
    log "Alert log marker updated"
  else
    log "Alert log not found: \${ALERT_LOG}"
  fi
}

# ---- 9. OS disk space ----
check_diskspace() {
  log "--- OS filesystem usage ---"
  for MOUNT in /u01 /tmp /var; do
    USAGE=\$(df --output=pcent "\${MOUNT}" 2>/dev/null | tail -1 | tr -d ' %')
    [ -n "\${USAGE}" ] && {
      log "Filesystem \${MOUNT}: \${USAGE}%"
      [ "\${USAGE}" -ge 85 ] && alert "Filesystem \${MOUNT} at \${USAGE}%"
    }
  done
}

# ---- 10. Send alert email ----
send_alert() {
  if [ "\${#ALERTS[@]}" -gt 0 ]; then
    {
      echo "Oracle 21c RAC Health Alert"
      echo "Node: \$(hostname)"
      echo "Time: \${TIMESTAMP}"
      echo ""
      printf '%s\n' "\${ALERTS[@]}" | while read msg; do echo "  * \${msg}"; done
      echo ""
      echo "Full log: \${LOG}"
    } | mail -s "RAC 21c Alert - \$(hostname)" "\${ALERT_EMAIL}"
    log "Alert sent (\${#ALERTS[@]} issue(s))"
  else
    log "All checks passed — cluster healthy"
  fi
}

# ---- Main ----
log "====== RAC 21c Health Check Start ======"
check_crs_resources
check_voting_disks
check_asm_diskgroups
check_instances
check_pdb
check_scan
check_interconnect
check_alert_log
check_diskspace
send_alert
log "====== RAC 21c Health Check End ======"
\`\`\`

---

## Phase 8: Crontab Configuration

Add to the \`oracle\` user crontab (\`crontab -e\` as oracle):

\`\`\`
# RAC health check every 10 minutes
*/10 * * * * /opt/scripts/rac21c_health.sh >> /var/log/rac21c_health_cron.log 2>&1

# Daily RMAN backup validation at 06:30
30 6 * * * /opt/scripts/rac21c_rman_validate.sh >> /var/log/rac21c_rman.log 2>&1

# Weekly index fragmentation report Sunday 03:00
0 3 * * 0 /opt/scripts/rac21c_index_report.sh >> /var/log/rac21c_index.log 2>&1

# Monthly AWR snapshot purge (retain 35 days) first of month 02:00
0 2 1 * * /opt/scripts/rac21c_awr_purge.sh >> /var/log/rac21c_awr.log 2>&1

# Alert log archival — compress previous day's entries nightly
0 1 * * * find /u01/app/oracle/diag -name "alert_*.log" -mtime +7 -exec gzip {} \\;
\`\`\`

### RMAN Validation Script (daily)

\`\`\`bash
#!/bin/bash
# rac21c_rman_validate.sh
export ORACLE_HOME=/u01/app/oracle/product/21c/dbhome_1
export ORACLE_SID=PRODCDB1
export PATH=\${ORACLE_HOME}/bin:\${PATH}

rman target / <<'RMANEOF'
LIST BACKUP OF DATABASE COMPLETED AFTER 'SYSDATE-1';
VALIDATE DATABASE SKIP INACCESSIBLE;
EXIT
RMANEOF
\`\`\`

---

## Phase 9: Routine Maintenance Calendar

### Daily
- Review health script log for ALERT lines: \`grep ALERT /var/log/rac21c_health.log | tail -50\`
- Confirm RMAN backup completed: \`rman target / <<< "LIST BACKUP COMPLETED AFTER 'SYSDATE-1';"\`
- Check ASM free space trend: \`asmcmd lsdg\`
- Review GV\$SESSION for blocking sessions over 30 minutes:
\`\`\`sql
SELECT blocking_instance, blocking_session, inst_id, sid, seconds_in_wait, sql_id
FROM gv\$session WHERE blocking_session IS NOT NULL AND seconds_in_wait > 1800;
\`\`\`

### Weekly
- Roll alert log (keep under 500 MB): \`adrci exec="set homepath diag/rdbms/prodcdb/PRODCDB1; purge -age 10080"\`
- Check CRS diagnostics: \`crsctl stat res -t -w "TYPE = ora.database.type"\`
- Verify all nodes are at same patch level: \`opatch lspatches\` on each node
- Review Cluster Health Monitor data: \`oclumon manage -get all\`

### Monthly
- Apply Oracle Release Update (RU): schedule rolling patch across nodes
- Gather stale statistics on high-churn PDB tables
- Review and resize ASM diskgroups if needed
- Test node eviction / fencing procedure in non-production window

### Quarterly
- Full DR test: stop all instances on node1, verify node2 services all connections
- Review interconnect performance baseline: compare to previous quarter
- Audit Oracle user accounts: lock unused accounts in the CDB and PDB
- Review AWR reports for top SQL regression since last quarter

---

## Troubleshooting Quick Reference

### ORA-29702 / Cluster Not Running
\`\`\`bash
crsctl stat res -t        # Check all resource states
crsctl check cluster      # Verify cluster health
crsctl check crs          # Check CRS daemon
# If CRS is down on a node, restart:
crsctl start crs          # (as root)
\`\`\`

### Node Eviction (Reboot Storm)
Root cause is almost always voting disk loss or interconnect failure.
\`\`\`bash
# On surviving node:
crsctl query css votedisk
# Check /var/log/oracle/ohasd.log and cssd.log for "eviction" entries
# Check interconnect: ping -I eth1 <other_node_private_ip> -f   (flood ping)
\`\`\`

### ASM Diskgroup Offline
\`\`\`bash
asmcmd lsdg              # Identify which diskgroup is DISMOUNTED
# Check disk paths:
asmcmd lsdsk --discovery /dev/oracleasm/*
# Re-mount if paths are available:
alter diskgroup DATA mount;   # (in SQL*Plus as SYSASM)
\`\`\`

### PDB Won't Open
\`\`\`sql
ALTER PLUGGABLE DATABASE PRODPDB OPEN;
-- If fails, check:
SELECT cause, type, message, status FROM pdb_plug_in_violations WHERE name='PRODPDB';
-- Common: timezone version mismatch, patch level mismatch
EXEC DBMS_DST.BEGIN_UPGRADE(22);
EXEC DBMS_DST.UPGRADE_DATABASE(parallel=>TRUE);
EXEC DBMS_DST.END_UPGRADE;
\`\`\`

### High Cache Fusion Traffic
\`\`\`sql
SELECT inst_id, name, value FROM gv\$sysstat
WHERE name IN ('gc cr blocks received','gc current blocks received','gc cr block receive time')
ORDER BY inst_id, name;
-- High gc receive time with high block counts = interconnect bottleneck
-- Check oifcfg getif and verify no public traffic on private interface
\`\`\``,
};

async function main() {
  await db
    .insert(posts)
    .values(post)
    .onConflictDoUpdate({
      target: posts.slug,
      set: { title: post.title, content: post.content, excerpt: post.excerpt, updatedAt: new Date() },
    });
  console.log('Inserted:', post.slug);
}

main().catch(console.error);
