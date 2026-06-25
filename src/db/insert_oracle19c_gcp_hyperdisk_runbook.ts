import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle 19c on RHEL 9 GCP Runbook: Hyperdisk Extreme for Redo, PD-SSD for Data, Installation and Monitoring',
  slug: 'oracle-19c-rhel9-gcp-hyperdisk-extreme-redo-runbook',
  excerpt:
    'Complete runbook for Oracle 19c on RHEL 9 on Google Cloud with tiered block storage — gcloud commands to create and attach Hyperdisk Extreme for redo logs and PD-SSD for data and index tablespaces, RHEL 9 disk preparation with direct I/O mount options, Oracle 19c silent installation, DBCA database creation with storage layout across tiers, redo log and standby redo log placement on Hyperdisk Extreme, Oracle initialization parameters for GCP direct and async I/O, tablespace creation SQL, and crontab monitoring scripts for redo write latency, log switch frequency, and disk IOPS utilization.',
  category: 'oracle-google-cloud' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-25'),
  youtubeUrl: null,
  content: `## Overview

This runbook provisions Oracle 19c on a RHEL 9 Google Cloud VM with a tiered block storage configuration: Hyperdisk Extreme for all redo log files (synchronous write path, commit-critical) and PD-SSD for all data and index tablespace files (asynchronous DBWR writes, throughput-driven). Archive logs and the Fast Recovery Area use PD-Balanced for cost-effective sequential I/O.

**Target environment**:
- GCP Project: \`<PROJECT_ID>\`
- Zone: \`us-central1-a\`
- VM name: \`oracle-db-01\`
- Machine type: \`n2-highmem-32\` (32 vCPU, 256 GB RAM)
- Oracle SID: \`ORCL\`
- Oracle base: \`/u01/oracle\`
- Oracle home: \`/u01/oracle/product/19.3.0/dbhome_1\`

**Storage layout**:
| Disk | Type | Size | IOPS | Mount | Contents |
|------|------|------|------|-------|----------|
| oracle-redo | Hyperdisk Extreme | 200 GB | 100,000 | \`/u02/oracle/redo\` | Online + standby redo logs |
| oracle-data | PD-SSD | 2 TB | ~34,000 | \`/u01/oracle/oradata\` | Data files, indexes, TEMP, UNDO |
| oracle-fra | PD-Balanced | 4 TB | ~32,000 | \`/u03/oracle/fra\` | Fast Recovery Area, archive logs |
| oracle-sw | PD-Balanced | 200 GB | — | \`/u01/oracle\` | Oracle binaries, inventory |

---

## Phase 1: GCP VM and Disk Provisioning

Run all \`gcloud\` commands from Cloud Shell or a workstation with gcloud CLI authenticated.

### 1.1 Enable Required APIs

\`\`\`bash
gcloud services enable compute.googleapis.com --project=<PROJECT_ID>
\`\`\`

### 1.2 Create the VM

\`\`\`bash
gcloud compute instances create oracle-db-01 \\
  --project=<PROJECT_ID> \\
  --zone=us-central1-a \\
  --machine-type=n2-highmem-32 \\
  --image-family=rhel-9 \\
  --image-project=rhel-cloud \\
  --boot-disk-size=100GB \\
  --boot-disk-type=pd-balanced \\
  --boot-disk-device-name=oracle-boot \\
  --no-address \\
  --network=<VPC_NETWORK> \\
  --subnet=<SUBNET> \\
  --tags=oracle-db \\
  --metadata=serial-port-enable=FALSE \\
  --shielded-secure-boot \\
  --shielded-vtpm \\
  --shielded-integrity-monitoring

# Verify VM is RUNNING
gcloud compute instances describe oracle-db-01 \\
  --zone=us-central1-a \\
  --project=<PROJECT_ID> \\
  --format="value(status)"
\`\`\`

### 1.3 Create Hyperdisk Extreme — Redo Logs

\`\`\`bash
# Hyperdisk Extreme: IOPS and throughput are provisioned independently of size
# 200 GB is more than enough for redo + standby redo logs
# 100,000 IOPS covers up to ~5,000 LGWR writes/second at 8KB-20KB average write size
# Throughput 2400 MB/s is the maximum for Hyperdisk Extreme at this IOPS level

gcloud compute disks create oracle-redo \\
  --project=<PROJECT_ID> \\
  --zone=us-central1-a \\
  --type=hyperdisk-extreme \\
  --size=200GB \\
  --provisioned-iops=100000 \\
  --provisioned-throughput=2400 \\
  --labels=purpose=oracle-redo,env=prod,db=orcl

# Verify disk created with correct specs
gcloud compute disks describe oracle-redo \\
  --zone=us-central1-a \\
  --project=<PROJECT_ID> \\
  --format="table(name,type,sizeGb,provisionedIops,provisionedThroughput,status)"
\`\`\`

### 1.4 Create PD-SSD — Data Files and Indexes

\`\`\`bash
# PD-SSD: IOPS scale with size at 30 IOPS/GB
# 2000 GB = ~60,000 IOPS, 900 MB/s throughput
# Sufficient for Oracle DBWR data file writes and random reads

gcloud compute disks create oracle-data \\
  --project=<PROJECT_ID> \\
  --zone=us-central1-a \\
  --type=pd-ssd \\
  --size=2000GB \\
  --labels=purpose=oracle-data,env=prod,db=orcl

# For larger databases, scale up size (and IOPS scale proportionally)
# 4000 GB pd-ssd = ~120,000 IOPS, 1,200 MB/s throughput
\`\`\`

### 1.5 Create PD-Balanced — Fast Recovery Area and Archive Logs

\`\`\`bash
# PD-Balanced: archive logs are sequential writes, cost-effective at this tier
# 4 TB supports approximately 2-3 weeks of archive log retention
# depending on redo generation rate

gcloud compute disks create oracle-fra \\
  --project=<PROJECT_ID> \\
  --zone=us-central1-a \\
  --type=pd-balanced \\
  --size=4000GB \\
  --labels=purpose=oracle-fra,env=prod,db=orcl
\`\`\`

### 1.6 Create PD-Balanced — Oracle Software

\`\`\`bash
gcloud compute disks create oracle-sw \\
  --project=<PROJECT_ID> \\
  --zone=us-central1-a \\
  --type=pd-balanced \\
  --size=200GB \\
  --labels=purpose=oracle-sw,env=prod,db=orcl
\`\`\`

### 1.7 Attach All Disks to the VM

\`\`\`bash
gcloud compute instances attach-disk oracle-db-01 \\
  --disk=oracle-redo \\
  --zone=us-central1-a \\
  --project=<PROJECT_ID> \\
  --device-name=oracle-redo

gcloud compute instances attach-disk oracle-db-01 \\
  --disk=oracle-data \\
  --zone=us-central1-a \\
  --project=<PROJECT_ID> \\
  --device-name=oracle-data

gcloud compute instances attach-disk oracle-db-01 \\
  --disk=oracle-fra \\
  --zone=us-central1-a \\
  --project=<PROJECT_ID> \\
  --device-name=oracle-fra

gcloud compute instances attach-disk oracle-db-01 \\
  --disk=oracle-sw \\
  --zone=us-central1-a \\
  --project=<PROJECT_ID> \\
  --device-name=oracle-sw

# Verify all disks are attached
gcloud compute instances describe oracle-db-01 \\
  --zone=us-central1-a \\
  --project=<PROJECT_ID> \\
  --format="table(disks[].source.basename(),disks[].deviceName)"
\`\`\`

---

## Phase 2: RHEL 9 OS Configuration

SSH to the VM:
\`\`\`bash
gcloud compute ssh oracle-db-01 \\
  --zone=us-central1-a \\
  --project=<PROJECT_ID>
\`\`\`

### 2.1 Install Oracle Prerequisites

\`\`\`bash
sudo dnf install -y gcc gcc-c++ make binutils glibc-devel libaio libaio-devel \\
  libstdc++ libstdc++-devel sysstat ksh pdksh compat-openssl11 \\
  libX11 libXau libXi libXtst elfutils-libelf elfutils-libelf-devel \\
  fontconfig-devel xorg-x11-xauth readline readline-devel \\
  unzip zip bc psmisc net-tools libnsl2 libnsl2-devel
\`\`\`

### 2.2 Kernel Parameters

\`\`\`bash
sudo tee /etc/sysctl.d/99-oracle.conf << 'EOF'
fs.file-max = 6815744
fs.aio-max-nr = 1048576
kernel.shmall = 2097152
kernel.shmmax = 137438953472
kernel.shmmni = 4096
kernel.sem = 250 32000 100 128
net.ipv4.ip_local_port_range = 9000 65500
net.core.rmem_default = 262144
net.core.rmem_max = 4194304
net.core.wmem_default = 262144
net.core.wmem_max = 1048576
EOF

sudo sysctl --system
\`\`\`

### 2.3 User Limits

\`\`\`bash
sudo tee /etc/security/limits.d/99-oracle.conf << 'EOF'
oracle  soft  nofile   131072
oracle  hard  nofile   131072
oracle  soft  nproc    131072
oracle  hard  nproc    131072
oracle  soft  stack    10240
oracle  hard  stack    32768
oracle  soft  memlock  137438953472
oracle  hard  memlock  137438953472
EOF
\`\`\`

### 2.4 Create Oracle User and Groups

\`\`\`bash
sudo groupadd -g 54321 oinstall
sudo groupadd -g 54322 dba
sudo groupadd -g 54323 oper
sudo groupadd -g 54324 backupdba
sudo groupadd -g 54325 dgdba
sudo groupadd -g 54326 kmdba

sudo useradd -u 54321 -g oinstall -G dba,oper,backupdba,dgdba,kmdba \\
  -d /home/oracle -s /bin/bash oracle

sudo passwd oracle

# Disable SELinux (or set permissive for Oracle compatibility)
sudo sed -i 's/^SELINUX=.*/SELINUX=permissive/' /etc/selinux/config
sudo setenforce 0

# Disable THP
echo never | sudo tee /sys/kernel/mm/transparent_hugepage/enabled
echo never | sudo tee /sys/kernel/mm/transparent_hugepage/defrag
\`\`\`

---

## Phase 3: Disk Preparation — Format and Mount

### 3.1 Identify Disk Devices

GCP attaches disks using the device name specified at attach time. On RHEL 9, these appear under \`/dev/disk/by-id/\`:

\`\`\`bash
ls -la /dev/disk/by-id/google-*
# Expect to see:
# google-oracle-redo   -> ../../sdb  (or sdc, sdd, sde)
# google-oracle-data   -> ../../sdc
# google-oracle-fra    -> ../../sdd
# google-oracle-sw     -> ../../sde

# Use the by-id symlinks for reliability — device letters can shift on reboot
REDO_DEV=/dev/disk/by-id/google-oracle-redo
DATA_DEV=/dev/disk/by-id/google-oracle-data
FRA_DEV=/dev/disk/by-id/google-oracle-fra
SW_DEV=/dev/disk/by-id/google-oracle-sw
\`\`\`

### 3.2 Partition and Format Each Disk

\`\`\`bash
for DEV in \${REDO_DEV} \${DATA_DEV} \${FRA_DEV} \${SW_DEV}; do
  echo "Partitioning \${DEV}..."
  sudo parted -s "\${DEV}" mklabel gpt mkpart primary ext4 0% 100%
  sleep 2
done

# Format with ext4 — use stripe parameters aligned to GCP 4K block size
# For Hyperdisk Extreme, use -E stride=128,stripe-width=128 for 512KB alignment
sudo mkfs.ext4 -m 1 -b 4096 -E stride=128,stripe-width=128 \${REDO_DEV}-part1
sudo mkfs.ext4 -m 1 -b 4096 -E stride=128,stripe-width=128 \${DATA_DEV}-part1
sudo mkfs.ext4 -m 1 -b 4096 -E stride=128,stripe-width=128 \${FRA_DEV}-part1
sudo mkfs.ext4 -m 1 -b 4096 -E stride=128,stripe-width=128 \${SW_DEV}-part1
\`\`\`

### 3.3 Create Mount Points

\`\`\`bash
sudo mkdir -p /u01/oracle          # Oracle software
sudo mkdir -p /u02/oracle/redo     # Hyperdisk Extreme — redo logs
sudo mkdir -p /u01/oracle/oradata  # PD-SSD — data files
sudo mkdir -p /u03/oracle/fra      # PD-Balanced — FRA and archive logs
\`\`\`

### 3.4 Mount with Direct I/O Options

For Oracle data files and redo logs, mount with \`noatime,nodiratime\` to avoid unnecessary metadata writes. The \`data=writeback\` ext4 option reduces journal overhead for database workloads.

\`\`\`bash
# Get UUIDs for stable /etc/fstab entries
REDO_UUID=\$(sudo blkid -s UUID -o value \${REDO_DEV}-part1)
DATA_UUID=\$(sudo blkid -s UUID -o value \${DATA_DEV}-part1)
FRA_UUID=\$(sudo blkid -s UUID -o value \${FRA_DEV}-part1)
SW_UUID=\$(sudo blkid -s UUID -o value \${SW_DEV}-part1)

echo "Redo UUID:  \${REDO_UUID}"
echo "Data UUID:  \${DATA_UUID}"
echo "FRA UUID:   \${FRA_UUID}"
echo "SW UUID:    \${SW_UUID}"

# Add to /etc/fstab
sudo tee -a /etc/fstab << FSTABEOF
# Oracle software
UUID=\${SW_UUID}    /u01/oracle               ext4  defaults,noatime,nodiratime,nofail       0 2
# Hyperdisk Extreme — redo logs (data=writeback reduces journal overhead for redo I/O)
UUID=\${REDO_UUID}  /u02/oracle/redo          ext4  defaults,noatime,nodiratime,data=writeback,nofail  0 2
# PD-SSD — Oracle data files
UUID=\${DATA_UUID}  /u01/oracle/oradata       ext4  defaults,noatime,nodiratime,data=writeback,nofail  0 2
# PD-Balanced — Fast Recovery Area
UUID=\${FRA_UUID}   /u03/oracle/fra           ext4  defaults,noatime,nodiratime,nofail       0 2
FSTABEOF

# Mount all
sudo mount -a

# Verify
df -hT | grep -E "(u01|u02|u03)"
\`\`\`

### 3.5 Set Ownership

\`\`\`bash
sudo chown -R oracle:oinstall /u01/oracle /u02/oracle /u03/oracle
sudo chmod -R 775 /u01/oracle /u02/oracle /u03/oracle
\`\`\`

---

## Phase 4: Oracle 19c Software Installation

### 4.1 Oracle User Environment

\`\`\`bash
su - oracle
cat >> ~/.bash_profile << 'EOF'
export ORACLE_BASE=/u01/oracle
export ORACLE_HOME=\${ORACLE_BASE}/product/19.3.0/dbhome_1
export ORACLE_SID=ORCL
export PATH=\${ORACLE_HOME}/bin:\${PATH}
export LD_LIBRARY_PATH=\${ORACLE_HOME}/lib:\${LD_LIBRARY_PATH}
export NLS_LANG=AMERICAN_AMERICA.AL32UTF8
export TMPDIR=/tmp
EOF
source ~/.bash_profile
\`\`\`

### 4.2 Install Oracle 19c Database Software (Silent)

\`\`\`bash
mkdir -p \${ORACLE_HOME}
cd \${ORACLE_HOME}

# Unzip Oracle 19c software (LINUX.X64_193000_db_home.zip)
unzip /tmp/LINUX.X64_193000_db_home.zip

./runInstaller -silent -ignorePrereqFailure \\
  oracle.install.option=INSTALL_DB_SWONLY \\
  ORACLE_BASE=\${ORACLE_BASE} \\
  ORACLE_HOME=\${ORACLE_HOME} \\
  oracle.install.db.InstallEdition=EE \\
  oracle.install.db.OSDBA_GROUP=dba \\
  oracle.install.db.OSOPER_GROUP=oper \\
  oracle.install.db.OSBACKUPDBA_GROUP=backupdba \\
  oracle.install.db.OSDGDBA_GROUP=dgdba \\
  oracle.install.db.OSKMDBA_GROUP=kmdba \\
  DECLINE_SECURITY_UPDATES=true

# Run root scripts as root
sudo /u01/oracle/oraInventory/orainstRoot.sh
sudo \${ORACLE_HOME}/root.sh
\`\`\`

### 4.3 Apply Latest Oracle 19c Release Update

\`\`\`bash
# Apply the EBS-certified or current Oracle 19c RU before creating the database
\${ORACLE_HOME}/OPatch/opatch prereq CheckConflictAgainstOHWithDetail -ph /tmp/<patch_number>
\${ORACLE_HOME}/OPatch/opatch apply -silent -oh \${ORACLE_HOME} /tmp/<patch_number>

# Verify patch applied
\${ORACLE_HOME}/OPatch/opatch lspatches | head -5
\`\`\`

---

## Phase 5: Oracle Directory Structure Across Storage Tiers

Create the directory hierarchy before DBCA, ensuring each component lands on the correct disk:

\`\`\`bash
su - oracle

# PD-SSD mount (/u01/oracle/oradata) — data files, indexes, UNDO, TEMP
mkdir -p /u01/oracle/oradata/ORCL

# Hyperdisk Extreme mount (/u02/oracle/redo) — redo logs only
mkdir -p /u02/oracle/redo/ORCL

# PD-Balanced mount (/u03/oracle/fra) — FRA, archive logs
mkdir -p /u03/oracle/fra

# Verify each directory is on the correct filesystem
df /u01/oracle/oradata
df /u02/oracle/redo
df /u03/oracle/fra
\`\`\`

---

## Phase 6: Create Oracle Database with DBCA

### 6.1 Create DBCA Response File

\`\`\`bash
cat > /tmp/dbca_orcl.rsp << 'EOF'
[GENERAL]
RESPONSEFILE_VERSION = "19.0.0"
OPERATION_TYPE = "createDatabase"

[CREATEDATABASE]
GDBNAME = "ORCL"
SID = "ORCL"
TEMPLATENAME = "General_Purpose.dbc"
SYSPASSWORD = "<sys_password>"
SYSTEMPASSWORD = "<system_password>"
EMCONFIGURATION = "NONE"
STORAGETYPE = "FS"
DATAFILEDESTINATION = /u01/oracle/oradata
RECOVERYAREADESTINATION = /u03/oracle/fra
RECOVERYAREASIZE = 3072000
CHARACTERSET = "AL32UTF8"
NATIONALCHARACTERSET = "AL16UTF16"
LISTENERS = "LISTENER"
DATABASETYPE = "OLTP"
AUTOMATICMEMORYMANAGEMENT = "FALSE"
TOTALMEMORY = "196608"
REDOLOGFILESIZE = "1024"
INITPARAMS = "db_name=ORCL,db_unique_name=ORCL,db_block_size=8192,\
db_files=1000,processes=500,open_cursors=500,\
undo_management=AUTO,undo_tablespace=UNDOTBS1,\
filesystemio_options=SETALL,disk_asynch_io=TRUE,\
log_buffer=268435456,db_writer_processes=4,\
log_archive_format=%t_%s_%r.arc,\
log_archive_dest_1=LOCATION=/u03/oracle/fra/arch,\
db_recovery_file_dest=/u03/oracle/fra,\
db_recovery_file_dest_size=3072G,\
enable_pluggable_database=FALSE"
CREATEGENERALTEMPLATE = false
EOF
\`\`\`

### 6.2 Run DBCA

\`\`\`bash
dbca -silent -createDatabase -responseFile /tmp/dbca_orcl.rsp

# Monitor progress
tail -f \${ORACLE_BASE}/cfgtoollogs/dbca/ORCL/ORCL.log
\`\`\`

---

## Phase 7: Reconfigure Redo Logs to Hyperdisk Extreme

DBCA places initial redo log files under \`DATAFILEDESTINATION\` (the PD-SSD mount). After database creation, move all redo log groups to the Hyperdisk Extreme mount.

### 7.1 Verify Current Redo Log Location

\`\`\`bash
sqlplus / as sysdba << 'EOF'
SELECT GROUP#, MEMBER FROM V\$LOGFILE ORDER BY GROUP#, MEMBER;
-- All members currently under /u01/oracle/oradata/ORCL/ (PD-SSD)
SELECT GROUP#, BYTES/1048576 AS SIZE_MB, STATUS FROM V\$LOG ORDER BY GROUP#;
EOF
\`\`\`

### 7.2 Add New Redo Log Groups on Hyperdisk Extreme

The strategy is to add new groups on Hyperdisk Extreme (1 GB per member), then drop the old groups once Oracle switches away from them.

\`\`\`bash
sqlplus / as sysdba << 'EOF'
-- Check how many current groups exist (typically 3 from DBCA)
-- Add 4 new groups on Hyperdisk Extreme (1 GB each, 2 members per group)
ALTER DATABASE ADD LOGFILE GROUP 11
  ('/u02/oracle/redo/ORCL/redo11a.log',
   '/u02/oracle/redo/ORCL/redo11b.log') SIZE 1024M;

ALTER DATABASE ADD LOGFILE GROUP 12
  ('/u02/oracle/redo/ORCL/redo12a.log',
   '/u02/oracle/redo/ORCL/redo12b.log') SIZE 1024M;

ALTER DATABASE ADD LOGFILE GROUP 13
  ('/u02/oracle/redo/ORCL/redo13a.log',
   '/u02/oracle/redo/ORCL/redo13b.log') SIZE 1024M;

ALTER DATABASE ADD LOGFILE GROUP 14
  ('/u02/oracle/redo/ORCL/redo14a.log',
   '/u02/oracle/redo/ORCL/redo14b.log') SIZE 1024M;

-- Verify new groups on Hyperdisk Extreme
SELECT GROUP#, MEMBER FROM V\$LOGFILE WHERE GROUP# >= 11 ORDER BY GROUP#, MEMBER;
EOF
\`\`\`

### 7.3 Force Log Switches to Cycle Through New Groups

\`\`\`bash
sqlplus / as sysdba << 'EOF'
-- Issue log switches to move the current log position off the old groups
-- and into the new Hyperdisk groups
ALTER SYSTEM SWITCH LOGFILE;
ALTER SYSTEM SWITCH LOGFILE;
ALTER SYSTEM SWITCH LOGFILE;
ALTER SYSTEM SWITCH LOGFILE;
-- Check that old groups are now INACTIVE or UNUSED (not CURRENT or ACTIVE)
SELECT GROUP#, STATUS FROM V\$LOG ORDER BY GROUP#;
-- Groups 1, 2, 3 should now be INACTIVE or UNUSED
EOF
\`\`\`

### 7.4 Drop Old Redo Groups from PD-SSD

\`\`\`bash
sqlplus / as sysdba << 'EOF'
-- Wait until old groups are INACTIVE, then drop
-- Do not drop a CURRENT or ACTIVE group
ALTER DATABASE DROP LOGFILE GROUP 1;
ALTER DATABASE DROP LOGFILE GROUP 2;
ALTER DATABASE DROP LOGFILE GROUP 3;

-- Remove old redo log files from filesystem (Oracle leaves the files on disk after DROP)
-- Run as oracle user from OS:
-- rm /u01/oracle/oradata/ORCL/redo0*.log

-- Verify only Hyperdisk groups remain
SELECT GROUP#, MEMBER FROM V\$LOGFILE ORDER BY GROUP#, MEMBER;
SELECT GROUP#, BYTES/1048576 AS MB, STATUS FROM V\$LOG ORDER BY GROUP#;
EOF

# Remove old files from PD-SSD
rm -f /u01/oracle/oradata/ORCL/redo0*.log
ls /u02/oracle/redo/ORCL/
\`\`\`

### 7.5 Add Standby Redo Log Groups (for Data Guard)

If this database will use Data Guard, create standby redo logs now (also on Hyperdisk Extreme, one extra group beyond online redo count):

\`\`\`bash
sqlplus / as sysdba << 'EOF'
ALTER DATABASE ADD STANDBY LOGFILE GROUP 21
  ('/u02/oracle/redo/ORCL/standby21a.log',
   '/u02/oracle/redo/ORCL/standby21b.log') SIZE 1024M;

ALTER DATABASE ADD STANDBY LOGFILE GROUP 22
  ('/u02/oracle/redo/ORCL/standby22a.log',
   '/u02/oracle/redo/ORCL/standby22b.log') SIZE 1024M;

ALTER DATABASE ADD STANDBY LOGFILE GROUP 23
  ('/u02/oracle/redo/ORCL/standby23a.log',
   '/u02/oracle/redo/ORCL/standby23b.log') SIZE 1024M;

ALTER DATABASE ADD STANDBY LOGFILE GROUP 24
  ('/u02/oracle/redo/ORCL/standby24a.log',
   '/u02/oracle/redo/ORCL/standby24b.log') SIZE 1024M;

ALTER DATABASE ADD STANDBY LOGFILE GROUP 25
  ('/u02/oracle/redo/ORCL/standby25a.log',
   '/u02/oracle/redo/ORCL/standby25b.log') SIZE 1024M;

SELECT GROUP#, MEMBER FROM V\$STANDBY_LOG ORDER BY GROUP#, MEMBER;
EOF
\`\`\`

---

## Phase 8: Oracle Initialization Parameters for GCP

### 8.1 Set Critical I/O Parameters

\`\`\`bash
sqlplus / as sysdba << 'EOF'
-- Direct I/O + Asynchronous I/O: eliminates page cache overhead,
-- exposes Hyperdisk Extreme latency advantage to LGWR
ALTER SYSTEM SET FILESYSTEMIO_OPTIONS=SETALL SCOPE=SPFILE SID='*';

-- Async I/O at the Oracle level
ALTER SYSTEM SET DISK_ASYNCH_IO=TRUE SCOPE=SPFILE SID='*';

-- Large log buffer reduces LGWR write frequency for small commits
-- 256 MB is appropriate for n2-highmem-32 with 256 GB RAM
ALTER SYSTEM SET LOG_BUFFER=268435456 SCOPE=SPFILE SID='*';

-- Multiple DBWR processes for parallel data file writes to PD-SSD
-- 4 DBWR processes on 32 vCPU is appropriate
ALTER SYSTEM SET DB_WRITER_PROCESSES=4 SCOPE=SPFILE SID='*';

-- Enable log write parallelism (LGWR slaves) for high-commit workloads
ALTER SYSTEM SET LOG_PARALLELISM=4 SCOPE=SPFILE SID='*';

-- Checkpoint frequency: adjust interval to avoid excessive checkpoint I/O
-- 30-minute checkpoint interval is appropriate for most production workloads
ALTER SYSTEM SET LOG_CHECKPOINT_INTERVAL=0 SCOPE=SPFILE SID='*';
ALTER SYSTEM SET LOG_CHECKPOINT_TIMEOUT=1800 SCOPE=SPFILE SID='*';

-- Large buffer cache for n2-highmem-32 (256 GB RAM, leave ~40 GB for OS and PGA)
ALTER SYSTEM SET DB_CACHE_SIZE=160G SCOPE=SPFILE SID='*';
ALTER SYSTEM SET SHARED_POOL_SIZE=8G SCOPE=SPFILE SID='*';
ALTER SYSTEM SET LARGE_POOL_SIZE=2G SCOPE=SPFILE SID='*';
ALTER SYSTEM SET JAVA_POOL_SIZE=1G SCOPE=SPFILE SID='*';

-- Verify FILESYSTEMIO_OPTIONS after bounce
SHUTDOWN IMMEDIATE;
STARTUP;
SHOW PARAMETER FILESYSTEMIO_OPTIONS;
SHOW PARAMETER DISK_ASYNCH_IO;
EOF
\`\`\`

---

## Phase 9: Create Tablespaces on Correct Storage Tiers

### 9.1 Verify SYSTEM and Core Tablespaces Are on PD-SSD

\`\`\`bash
sqlplus / as sysdba << 'EOF'
-- Verify SYSTEM, SYSAUX, UNDO, TEMP are under /u01/oracle/oradata (PD-SSD)
SELECT TABLESPACE_NAME, FILE_NAME, BYTES/1048576 AS MB
FROM DBA_DATA_FILES
ORDER BY TABLESPACE_NAME, FILE_NAME;

-- TEMP files:
SELECT TABLESPACE_NAME, FILE_NAME, BYTES/1048576 AS MB
FROM DBA_TEMP_FILES;
EOF
\`\`\`

### 9.2 Create Application Data Tablespace on PD-SSD

\`\`\`bash
sqlplus / as sysdba << 'EOF'
-- DATA tablespace on PD-SSD
CREATE TABLESPACE DATA
  DATAFILE '/u01/oracle/oradata/ORCL/data01.dbf' SIZE 10G AUTOEXTEND ON NEXT 1G MAXSIZE UNLIMITED,
           '/u01/oracle/oradata/ORCL/data02.dbf' SIZE 10G AUTOEXTEND ON NEXT 1G MAXSIZE UNLIMITED
  EXTENT MANAGEMENT LOCAL AUTOALLOCATE
  SEGMENT SPACE MANAGEMENT AUTO
  LOGGING;

-- INDEX tablespace on PD-SSD (same disk, different file for separation)
CREATE TABLESPACE INDX
  DATAFILE '/u01/oracle/oradata/ORCL/indx01.dbf' SIZE 5G AUTOEXTEND ON NEXT 512M MAXSIZE UNLIMITED,
           '/u01/oracle/oradata/ORCL/indx02.dbf' SIZE 5G AUTOEXTEND ON NEXT 512M MAXSIZE UNLIMITED
  EXTENT MANAGEMENT LOCAL AUTOALLOCATE
  SEGMENT SPACE MANAGEMENT AUTO
  LOGGING;

-- Verify tablespace locations
SELECT TABLESPACE_NAME, FILE_NAME, BYTES/1073741824 AS SIZE_GB
FROM DBA_DATA_FILES
WHERE TABLESPACE_NAME IN ('DATA','INDX')
ORDER BY TABLESPACE_NAME;
EOF
\`\`\`

---

## Phase 10: Listener and Oracle Service Configuration

\`\`\`bash
# Create listener.ora
cat > \${ORACLE_HOME}/network/admin/listener.ora << 'EOF'
LISTENER =
  (DESCRIPTION_LIST =
    (DESCRIPTION =
      (ADDRESS = (PROTOCOL = TCP)(HOST = oracle-db-01.internal.example.com)(PORT = 1521))
    )
  )

SID_LIST_LISTENER =
  (SID_LIST =
    (SID_DESC =
      (GLOBAL_DBNAME = ORCL)
      (ORACLE_HOME = /u01/oracle/product/19.3.0/dbhome_1)
      (SID_NAME = ORCL)
    )
  )

ADR_BASE_LISTENER = /u01/oracle
EOF

lsnrctl start
lsnrctl status

# Register DB with listener
sqlplus / as sysdba << 'EOF'
ALTER SYSTEM REGISTER;
EOF
\`\`\`

---

## Phase 11: Systemd Service for Oracle on RHEL 9

\`\`\`bash
sudo tee /etc/systemd/system/oracle-db.service << 'EOF'
[Unit]
Description=Oracle Database ORCL
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
User=oracle
Group=oinstall
Environment="ORACLE_HOME=/u01/oracle/product/19.3.0/dbhome_1"
Environment="ORACLE_SID=ORCL"
Environment="PATH=/u01/oracle/product/19.3.0/dbhome_1/bin:/usr/local/bin:/bin:/usr/bin"
ExecStart=/u01/oracle/product/19.3.0/dbhome_1/bin/dbstart /u01/oracle/product/19.3.0/dbhome_1
ExecStop=/u01/oracle/product/19.3.0/dbhome_1/bin/dbshut /u01/oracle/product/19.3.0/dbhome_1
RemainAfterExit=yes
TimeoutStartSec=600
TimeoutStopSec=300

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable oracle-db
\`\`\`

---

## Phase 12: Monitoring Scripts

### 12.1 Redo Write Latency Monitor

Create \`/home/oracle/scripts/check_redo_latency.sh\`:

\`\`\`bash
#!/bin/bash
# Monitor redo write latency via Oracle wait events
# Alerts if log file sync or log file parallel write exceeds thresholds

ORACLE_SID=ORCL
ORACLE_HOME=/u01/oracle/product/19.3.0/dbhome_1
PATH=\${ORACLE_HOME}/bin:\${PATH}
export ORACLE_SID ORACLE_HOME PATH

SYNC_WARN_MS=2
SYNC_CRIT_MS=5
WRITE_WARN_MS=1
WRITE_CRIT_MS=3
LOG_FILE="/home/oracle/logs/redo_latency_\$(date +%Y%m%d).log"
mkdir -p /home/oracle/logs

RESULT=\$(sqlplus -s / as sysdba << 'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT EVENT || '|' ||
       ROUND(TIME_WAITED_MICRO / DECODE(TOTAL_WAITS,0,1,TOTAL_WAITS) / 1000, 3) AS AVG_MS
FROM V\$SYSTEM_EVENT
WHERE EVENT IN ('log file sync', 'log file parallel write')
ORDER BY EVENT;
EXIT;
EOF
)

LOG_SYNC_MS=0
LOG_WRITE_MS=0

while IFS='|' read -r EVENT AVG_MS; do
  EVENT_TRIM=\$(echo "\${EVENT}" | xargs)
  if [[ "\${EVENT_TRIM}" == "log file sync" ]]; then
    LOG_SYNC_MS=\${AVG_MS}
  elif [[ "\${EVENT_TRIM}" == "log file parallel write" ]]; then
    LOG_WRITE_MS=\${AVG_MS}
  fi
done <<< "\${RESULT}"

STATUS="OK"
MSG="log_file_sync=\${LOG_SYNC_MS}ms log_file_parallel_write=\${LOG_WRITE_MS}ms"

# Compare using awk for floating point
SYNC_CRIT=\$(awk "BEGIN {print (\${LOG_SYNC_MS} >= \${SYNC_CRIT_MS}) ? 1 : 0}")
SYNC_WARN=\$(awk "BEGIN {print (\${LOG_SYNC_MS} >= \${SYNC_WARN_MS}) ? 1 : 0}")
WRITE_CRIT=\$(awk "BEGIN {print (\${LOG_WRITE_MS} >= \${WRITE_CRIT_MS}) ? 1 : 0}")
WRITE_WARN=\$(awk "BEGIN {print (\${LOG_WRITE_MS} >= \${WRITE_WARN_MS}) ? 1 : 0}")

if [ "\${SYNC_CRIT}" = "1" ] || [ "\${WRITE_CRIT}" = "1" ]; then
  STATUS="CRITICAL"
elif [ "\${SYNC_WARN}" = "1" ] || [ "\${WRITE_WARN}" = "1" ]; then
  STATUS="WARNING"
fi

LOG_LINE="\$(date): \${STATUS} \${MSG}"
echo "\${LOG_LINE}" >> "\${LOG_FILE}"

if [ "\${STATUS}" != "OK" ]; then
  echo "\${LOG_LINE}"
  # echo "\${LOG_LINE}" | mail -s "Redo Latency \${STATUS}: ORCL" dba-alerts@example.com
  exit 1
fi
\`\`\`

### 12.2 Log Switch Rate Monitor

Create \`/home/oracle/scripts/check_log_switch_rate.sh\`:

\`\`\`bash
#!/bin/bash
# Monitor log switch frequency over the last hour
# High switch rate = redo logs too small; low switch rate is fine

ORACLE_SID=ORCL
ORACLE_HOME=/u01/oracle/product/19.3.0/dbhome_1
PATH=\${ORACLE_HOME}/bin:\${PATH}
export ORACLE_SID ORACLE_HOME PATH

CRIT_SWITCHES_PER_HOUR=12   # More than 12/hour = log too small
LOG_FILE="/home/oracle/logs/log_switch_\$(date +%Y%m%d).log"
mkdir -p /home/oracle/logs

SWITCHES=\$(sqlplus -s / as sysdba << 'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT COUNT(*)
FROM V\$LOG_HISTORY
WHERE FIRST_TIME >= SYSDATE - 1/24;
EXIT;
EOF
)

SWITCHES=\$(echo "\${SWITCHES}" | tr -d ' ')

LOG_LINE="\$(date): Log switches in last hour: \${SWITCHES}"

if [ "\${SWITCHES}" -ge "\${CRIT_SWITCHES_PER_HOUR}" ] 2>/dev/null; then
  echo "WARNING: \${LOG_LINE} (threshold: \${CRIT_SWITCHES_PER_HOUR}/hour — redo logs may be undersized)" | tee -a "\${LOG_FILE}"
  exit 1
fi

echo "\${LOG_LINE}" >> "\${LOG_FILE}"
\`\`\`

### 12.3 Disk IOPS and Latency Monitor (OS Level)

Create \`/home/oracle/scripts/check_disk_io.sh\`:

\`\`\`bash
#!/bin/bash
# Monitor disk IOPS and latency using iostat
# Identifies which disk tier is experiencing pressure

LOG_FILE="/home/oracle/logs/disk_io_\$(date +%Y%m%d).log"
mkdir -p /home/oracle/logs

# Identify device names for each Oracle disk
# GCP google-* device names map to actual block devices
REDO_DEV=\$(readlink -f /dev/disk/by-id/google-oracle-redo | sed 's|/dev/||')
DATA_DEV=\$(readlink -f /dev/disk/by-id/google-oracle-data | sed 's|/dev/||')
FRA_DEV=\$(readlink -f /dev/disk/by-id/google-oracle-fra | sed 's|/dev/||')

echo "=== Disk I/O Snapshot: \$(date) ===" | tee -a "\${LOG_FILE}"
echo "Redo device: \${REDO_DEV} | Data device: \${DATA_DEV} | FRA device: \${FRA_DEV}" | tee -a "\${LOG_FILE}"

# iostat: 5-second sample, show extended stats
iostat -x 5 2 | awk -v redo="\${REDO_DEV}" -v data="\${DATA_DEV}" -v fra="\${FRA_DEV}" '
  /^Device/ { header=1; next }
  header && (\$1 == redo || \$1 == data || \$1 == fra) {
    printf "Device: %-12s r/s: %8.1f w/s: %8.1f rMB/s: %6.1f wMB/s: %6.1f await: %6.1fms util: %5.1f%%\n",
      \$1, \$4, \$5, \$6, \$7, \$10, \$NF
  }
' | tee -a "\${LOG_FILE}"

echo "" | tee -a "\${LOG_FILE}"
\`\`\`

### 12.4 GCP Disk IOPS Check via gcloud

Create \`/home/oracle/scripts/check_gcp_disk_utilization.sh\`:

\`\`\`bash
#!/bin/bash
# Report current provisioned vs actual IOPS on Hyperdisk Extreme
# Useful for right-sizing IOPS provisioning

PROJECT_ID="<PROJECT_ID>"
ZONE="us-central1-a"
DISK_NAME="oracle-redo"
LOG_FILE="/home/oracle/logs/gcp_disk_\$(date +%Y%m%d).log"
mkdir -p /home/oracle/logs

echo "=== GCP Hyperdisk Extreme Status: \$(date) ===" | tee -a "\${LOG_FILE}"

gcloud compute disks describe "\${DISK_NAME}" \\
  --zone="\${ZONE}" \\
  --project="\${PROJECT_ID}" \\
  --format="table(name,type.basename(),sizeGb,provisionedIops,provisionedThroughput,status)" \\
  2>/dev/null | tee -a "\${LOG_FILE}"

echo "" | tee -a "\${LOG_FILE}"
\`\`\`

### 12.5 Crontab Setup

\`\`\`
# crontab -e (as oracle user on oracle-db-01)

# Redo write latency — check every 10 minutes
*/10 * * * * /home/oracle/scripts/check_redo_latency.sh >> /home/oracle/logs/redo_latency_cron.log 2>&1

# Log switch rate — check every 30 minutes
*/30 * * * * /home/oracle/scripts/check_log_switch_rate.sh >> /home/oracle/logs/log_switch_cron.log 2>&1

# OS-level disk I/O snapshot — every 15 minutes
*/15 * * * * /home/oracle/scripts/check_disk_io.sh >> /home/oracle/logs/disk_io_cron.log 2>&1

# GCP disk spec check — daily at 06:00
0 6 * * * /home/oracle/scripts/check_gcp_disk_utilization.sh >> /home/oracle/logs/gcp_disk_cron.log 2>&1
\`\`\`

---

## Quick Reference

| Task | Command |
|------|---------|
| Create Hyperdisk Extreme | \`gcloud compute disks create <name> --type=hyperdisk-extreme --size=200GB --provisioned-iops=100000 --provisioned-throughput=2400 --zone=us-central1-a\` |
| Resize Hyperdisk IOPS | \`gcloud compute disks update <name> --provisioned-iops=150000 --zone=us-central1-a\` |
| Attach disk to VM | \`gcloud compute instances attach-disk <vm> --disk=<disk> --device-name=<name> --zone=us-central1-a\` |
| Check redo log members | \`SELECT GROUP#, MEMBER FROM V\$LOGFILE ORDER BY GROUP#;\` |
| Check log switch rate | \`SELECT COUNT(*) FROM V\$LOG_HISTORY WHERE FIRST_TIME >= SYSDATE-1/24;\` |
| Check redo latency | \`SELECT EVENT, ROUND(TIME_WAITED_MICRO/DECODE(TOTAL_WAITS,0,1,TOTAL_WAITS)/1000,3) MS FROM V\$SYSTEM_EVENT WHERE EVENT LIKE 'log file%';\` |
| Add redo log group | \`ALTER DATABASE ADD LOGFILE GROUP N ('/u02/oracle/redo/ORCL/redoNa.log','/u02/oracle/redo/ORCL/redoNb.log') SIZE 1024M;\` |
| Drop redo log group | \`ALTER DATABASE DROP LOGFILE GROUP N;\` (only INACTIVE groups) |
| Force log switch | \`ALTER SYSTEM SWITCH LOGFILE;\` |
| Check FILESYSTEMIO_OPTIONS | \`SHOW PARAMETER FILESYSTEMIO_OPTIONS;\` |
| iostat for Oracle disks | \`iostat -x 5 3 /dev/disk/by-id/google-oracle-redo\` |`,
};

async function main() {
  console.log('Inserting Oracle 19c GCP Hyperdisk runbook...');
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
