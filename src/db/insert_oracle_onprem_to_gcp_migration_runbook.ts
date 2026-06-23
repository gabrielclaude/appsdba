import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Migrating Oracle On-Premises to Oracle 19c on RHEL 9 on Google Cloud with Production Monitoring',
  slug: 'oracle-onprem-to-19c-rhel9-gcp-migration-runbook',
  excerpt:
    'Step-by-step runbook for migrating a self-managed Oracle database from on-premises to Oracle 19c on RHEL 9 on GCE — GCP infrastructure setup, RHEL 9 Oracle prerequisites, RMAN active duplicate migration, Data Guard cutover, GCS backup integration, post-migration validation, and seven crontab-scheduled monitoring scripts covering instance health, RMAN backup verification, Data Guard lag, tablespace space, alert log scanning, GCP disk throttle detection, and GCS backup confirmation.',
  category: 'oracle-google-cloud' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-22'),
  youtubeUrl: null,
  content: `## Overview

This runbook covers the end-to-end procedure for migrating a self-managed Oracle database from on-premises infrastructure to Oracle 19c on RHEL 9 running on a Google Compute Engine (GCE) virtual machine. It uses RMAN active duplicate as the primary migration method with a Data Guard standby as the cutover mechanism, which provides a verified, tested failover path and minimises the final downtime window to under 30 minutes regardless of database size.

Assumptions: Oracle Database 19c RU 19.21 or later, RHEL 9.2 or later on GCE, source database Oracle 12c or 19c (RMAN active duplicate requires the same or higher target version), Cloud VPN or Cloud Interconnect established between on-premises and GCP VPC, GCS bucket created for backup storage, Google Cloud CLI (\`gcloud\`) installed and authenticated, and the DBA has SYSDBA access on both source and target.

Generic examples use the following placeholders throughout:
- Source host: \`db-onprem-01.company.com\`
- Target GCE host: \`db-gcp-01.company.internal\` (internal VPC hostname)
- Oracle SID: \`ORCLPRD\`
- Oracle home: \`/u01/app/oracle/product/19c/dbhome_1\`
- GCS bucket: \`gs://company-oracle-backups\`
- GCP project: \`db-project-prod\`
- GCP region: \`us-central1\`, zone: \`us-central1-a\`

---

## Phase 0: Pre-Migration Assessment

### Step 0.1 — Capture Source Database Profile

\`\`\`sql
-- Run on source (on-premises) database as SYSDBA

-- Database version and platform
SELECT banner_full FROM v\$version;
SELECT platform_name, platform_id FROM v\$database;

-- Database size
SELECT
  ROUND(SUM(bytes)/1024/1024/1024, 1) total_size_gb
FROM dba_data_files;

-- Redo log size (affects transfer rate during duplicate)
SELECT l.group#, l.members, ROUND(l.bytes/1024/1024, 0) size_mb, l.status
FROM v\$log l ORDER BY l.group#;

-- Archive log generation rate (determines catch-up window duration)
SELECT
  TRUNC(first_time, 'HH') hour_block,
  COUNT(*) archivelogs,
  ROUND(SUM(blocks * block_size)/1024/1024/1024, 2) archive_gb
FROM v\$archived_log
WHERE first_time >= SYSDATE - 7
  AND standby_dest = 'NO'
GROUP BY TRUNC(first_time, 'HH')
ORDER BY hour_block DESC
FETCH FIRST 48 ROWS ONLY;

-- Character set (must match on target)
SELECT parameter, value FROM nls_database_parameters
WHERE parameter IN ('NLS_CHARACTERSET', 'NLS_NCHAR_CHARACTERSET');

-- Supplemental logging status (needed for Data Guard and GoldenGate)
SELECT log_mode, supplemental_log_data_min FROM v\$database;
\`\`\`

### Step 0.2 — Validate Network Throughput Between On-Premises and GCP

\`\`\`bash
# From the on-premises host, test throughput to GCP VPC
# (Replace 10.128.0.10 with the GCE target host's internal IP)
iperf3 -c 10.128.0.10 -t 30 -P 4
# Minimum acceptable for RMAN active duplicate: 500 Mbps
# Below 100 Mbps: consider using Data Pump with gsutil transfer instead

# Estimate RMAN duplicate time
# Formula: database_size_gb / (network_throughput_gbps * 0.7) = hours
# Example: 2000 GB / (0.5 Gbps * 0.7) = ~79 minutes
# 0.7 factor accounts for RMAN compression and protocol overhead
\`\`\`

### Step 0.3 — Pre-Migration Checklist

| Item | Verified |
|------|---------|
| Network throughput tested and meets minimum | ☐ |
| Target GCE instance sized (vCPU, RAM) | ☐ |
| GCP storage volumes provisioned (redo on Hyperdisk, data on pd-ssd) | ☐ |
| Cloud VPN or Interconnect active between sites | ☐ |
| GCS bucket created with appropriate IAM permissions | ☐ |
| Oracle 19c software staged on GCE target | ☐ |
| RMAN backup of source completed and verified | ☐ |
| Change freeze confirmed with application owners | ☐ |

---

## Phase 1: GCP Infrastructure Setup

### Step 1.1 — Create GCE Instance

\`\`\`bash
# Create the Oracle DB GCE instance
# n2-highmem-32: 32 vCPU, 256 GB RAM — adjust to your workload
gcloud compute instances create db-gcp-01 \
  --project=db-project-prod \
  --zone=us-central1-a \
  --machine-type=n2-highmem-32 \
  --image-family=rhel-9 \
  --image-project=rhel-cloud \
  --boot-disk-size=100GB \
  --boot-disk-type=pd-ssd \
  --network=oracle-vpc \
  --subnet=oracle-db-subnet \
  --no-address \
  --service-account=oracle-db-sa@db-project-prod.iam.gserviceaccount.com \
  --scopes=cloud-platform \
  --tags=oracle-db-server \
  --metadata=enable-oslogin=TRUE

# Verify instance is running
gcloud compute instances describe db-gcp-01 \
  --zone=us-central1-a --project=db-project-prod \
  --format="yaml(status,networkInterfaces)"
\`\`\`

### Step 1.2 — Provision Storage Volumes

\`\`\`bash
# Redo log volume: Hyperdisk Extreme for lowest write latency
gcloud compute disks create oracle-redo-01 \
  --project=db-project-prod \
  --zone=us-central1-a \
  --type=hyperdisk-extreme \
  --size=500GB \
  --provisioned-iops=100000

# Datafiles volume: pd-ssd (IOPS scale with size: 30 IOPS/GB)
gcloud compute disks create oracle-data-01 \
  --project=db-project-prod \
  --zone=us-central1-a \
  --type=pd-ssd \
  --size=3000GB   # 3 TB = 90,000 IOPS provisioned

# FRA / local staging volume: pd-ssd
gcloud compute disks create oracle-fra-01 \
  --project=db-project-prod \
  --zone=us-central1-a \
  --type=pd-ssd \
  --size=2000GB

# Attach all disks to the instance
gcloud compute instances attach-disk db-gcp-01 \
  --disk=oracle-redo-01 --device-name=oracle-redo-01 \
  --zone=us-central1-a --project=db-project-prod

gcloud compute instances attach-disk db-gcp-01 \
  --disk=oracle-data-01 --device-name=oracle-data-01 \
  --zone=us-central1-a --project=db-project-prod

gcloud compute instances attach-disk db-gcp-01 \
  --disk=oracle-fra-01 --device-name=oracle-fra-01 \
  --zone=us-central1-a --project=db-project-prod
\`\`\`

### Step 1.3 — Configure VPC Firewall Rules

\`\`\`bash
# Allow Oracle Net from application server subnet
gcloud compute firewall-rules create allow-oracle-net \
  --project=db-project-prod \
  --network=oracle-vpc \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=tcp:1521 \
  --source-ranges=10.128.1.0/24 \
  --target-tags=oracle-db-server \
  --description="Oracle Net listener from app servers"

# Allow Oracle Net from on-premises (via VPN tunnel)
gcloud compute firewall-rules create allow-oracle-net-onprem \
  --project=db-project-prod \
  --network=oracle-vpc \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=tcp:1521 \
  --source-ranges=192.168.0.0/16 \
  --target-tags=oracle-db-server \
  --description="Oracle Net from on-premises via VPN for Data Guard redo transport"
\`\`\`

### Step 1.4 — Prepare Storage on GCE Host

\`\`\`bash
# SSH to GCE target host
gcloud compute ssh db-gcp-01 --zone=us-central1-a --project=db-project-prod

# Identify attached disks
lsblk
# Typically: /dev/sdb = oracle-redo-01, /dev/sdc = oracle-data-01, /dev/sdd = oracle-fra-01

# Format and mount
mkfs.xfs /dev/sdb && mkdir -p /u02/oradata/redo
mkfs.xfs /dev/sdc && mkdir -p /u01/oradata/ORCLPRD
mkfs.xfs /dev/sdd && mkdir -p /u01/fast_recovery_area

cat >> /etc/fstab <<'EOF'
/dev/sdb  /u02/oradata/redo           xfs  defaults,nofail  0 2
/dev/sdc  /u01/oradata/ORCLPRD        xfs  defaults,nofail  0 2
/dev/sdd  /u01/fast_recovery_area     xfs  defaults,nofail  0 2
EOF

mount -a && df -h /u01/oradata/ORCLPRD /u02/oradata/redo /u01/fast_recovery_area
\`\`\`

---

## Phase 2: RHEL 9 Oracle Prerequisites on GCE

### Step 2.1 — Install Oracle Prerequisites

\`\`\`bash
# The oracle-database-preinstall-19c package sets all required kernel parameters,
# creates oracle user/groups, and installs dependency packages
dnf install -y oracle-database-preinstall-19c

# Verify oracle user was created
id oracle
# Expected: uid=54321(oracle) gid=54321(oinstall) groups=54321(oinstall),54322(dba)

# Set oracle user password
passwd oracle
\`\`\`

### Step 2.2 — Configure Kernel Parameters and Limits

\`\`\`bash
# oracle-database-preinstall-19c sets most parameters automatically.
# Verify the critical ones:
sysctl kernel.shmmax kernel.shmall kernel.shmmni
sysctl net.ipv4.ip_local_port_range
sysctl vm.swappiness
# vm.swappiness should be 1 (set by preinstall package for Oracle)

# On GCE, disable swap (pd-ssd swap is expensive and Oracle does not benefit)
swapoff -a
sed -i '/swap/d' /etc/fstab
free -m  # Swap line should show 0 0 0

# Disable THP (set by preinstall, verify)
cat /sys/kernel/mm/transparent_hugepage/enabled
# Expected: always madvise [never]
\`\`\`

### Step 2.3 — Configure Oracle Directory Structure

\`\`\`bash
mkdir -p /u01/app/oracle/product/19c/dbhome_1
mkdir -p /u01/app/oraInventory
mkdir -p /u01/app/oracle/admin/ORCLPRD/{adump,dpdump,pfile}
chown -R oracle:oinstall /u01/app /u02/oradata
chmod -R 775 /u01/app
\`\`\`

### Step 2.4 — Set Oracle Environment Profile

\`\`\`bash
cat >> /home/oracle/.bash_profile <<'EOF'
# Oracle Environment
export ORACLE_BASE=/u01/app/oracle
export ORACLE_HOME=/u01/app/oracle/product/19c/dbhome_1
export ORACLE_SID=ORCLPRD
export PATH=\$ORACLE_HOME/bin:\$PATH
export LD_LIBRARY_PATH=\$ORACLE_HOME/lib:/lib:/usr/lib
export TNS_ADMIN=\$ORACLE_HOME/network/admin
export NLS_DATE_FORMAT="YYYY-MM-DD HH24:MI:SS"
EOF

source /home/oracle/.bash_profile
echo \$ORACLE_HOME  # Verify
\`\`\`

### Step 2.5 — Configure Python Compatibility

\`\`\`bash
# Oracle installer scripts require /usr/bin/python to exist
ls /usr/bin/python 2>/dev/null || ln -s /usr/bin/python3 /usr/bin/python
python --version  # Should return Python 3.x
\`\`\`

### Step 2.6 — Take GCE Snapshot Before Oracle Install

\`\`\`bash
# Create a snapshot of the boot disk — instant rollback point if install fails
gcloud compute disks snapshot db-gcp-01 \
  --snapshot-names=db-gcp-01-pre-oracle-install \
  --zone=us-central1-a \
  --project=db-project-prod

gcloud compute snapshots describe db-gcp-01-pre-oracle-install \
  --project=db-project-prod --format="yaml(status,diskSizeGb)"
# Expected: status: READY
\`\`\`

---

## Phase 3: Oracle 19c Installation on GCE

### Step 3.1 — Install Oracle Database Software (Software Only)

\`\`\`bash
su - oracle
cd /hana/stage/oracle19c  # Adjust to your staging directory

# Unzip Oracle 19c installer
unzip LINUX.X64_193000_db_home.zip -d \$ORACLE_HOME

# Run installer in silent mode (software-only — database created later via RMAN duplicate)
\$ORACLE_HOME/runInstaller -silent \
  -responseFile /tmp/db_install.rsp \
  oracle.install.option=INSTALL_DB_SWONLY \
  ORACLE_HOSTNAME=db-gcp-01.company.internal \
  UNIX_GROUP_NAME=oinstall \
  INVENTORY_LOCATION=/u01/app/oraInventory \
  ORACLE_HOME=\$ORACLE_HOME \
  ORACLE_BASE=\$ORACLE_BASE \
  oracle.install.db.InstallEdition=EE \
  oracle.install.db.OSDBA_GROUP=dba \
  oracle.install.db.OSOPER_GROUP=oper \
  oracle.install.db.OSBACKUPDBA_GROUP=backupdba \
  oracle.install.db.OSDGDBA_GROUP=dgdba \
  oracle.install.db.OSKMDBA_GROUP=kmdba \
  oracle.install.db.OSRACDBA_GROUP=racdba \
  DECLINE_SECURITY_UPDATES=true \
  2>&1 | tee /tmp/oracle_install_\$(date +%Y%m%d).log

# Run root scripts when prompted
/u01/app/oraInventory/orainstRoot.sh
\$ORACLE_HOME/root.sh
\`\`\`

### Step 3.2 — Apply Latest 19c Release Update

\`\`\`bash
# Apply Oracle 19c RU (19.21 or latest) using OPatch
# Download the RU patch from Oracle MOS and copy to GCE

su - oracle
cd /tmp/patches/34419443  # RU patch directory

# Verify no conflicts
\$ORACLE_HOME/OPatch/opatch prereq CheckConflictAgainstOHWithDetail -ph .
# Expected: No conflict detected

# Apply the patch
\$ORACLE_HOME/OPatch/opatch apply -silent -local
# Duration: 20–40 minutes

# Verify patch applied
\$ORACLE_HOME/OPatch/opatch lspatches | head -5
\`\`\`

### Step 3.3 — Configure Oracle Net on Target

\`\`\`bash
# Create listener.ora on target
cat > \$ORACLE_HOME/network/admin/listener.ora <<'EOF'
LISTENER =
  (DESCRIPTION_LIST =
    (DESCRIPTION =
      (ADDRESS = (PROTOCOL = TCP)(HOST = db-gcp-01.company.internal)(PORT = 1521))
      (ADDRESS = (PROTOCOL = IPC)(KEY = EXTPROC1521))
    )
  )

SID_LIST_LISTENER =
  (SID_LIST =
    (SID_DESC =
      (GLOBAL_DBNAME = ORCLPRD)
      (ORACLE_HOME = /u01/app/oracle/product/19c/dbhome_1)
      (SID_NAME = ORCLPRD)
    )
  )
EOF

# Start listener
lsnrctl start LISTENER
lsnrctl status LISTENER

# Create tnsnames.ora with entries for both source and target
cat > \$ORACLE_HOME/network/admin/tnsnames.ora <<'EOF'
ORCLPRD_GCP =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = db-gcp-01.company.internal)(PORT = 1521))
    (CONNECT_DATA = (SERVER = DEDICATED)(SERVICE_NAME = ORCLPRD))
  )

ORCLPRD_ONPREM =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = db-onprem-01.company.com)(PORT = 1521))
    (CONNECT_DATA = (SERVER = DEDICATED)(SERVICE_NAME = ORCLPRD))
  )
EOF
\`\`\`

---

## Phase 4: RMAN Active Duplicate Migration

### Step 4.1 — Enable Supplemental Logging and ARCHIVELOG on Source

\`\`\`sql
-- Run on source database (db-onprem-01.company.com) as SYSDBA

-- Verify database is in ARCHIVELOG mode (required for RMAN duplicate)
SELECT log_mode FROM v\$database;
-- If NOARCHIVELOG: ALTER DATABASE ARCHIVELOG; (requires brief shutdown)

-- Enable minimal supplemental logging (required for Data Guard)
ALTER DATABASE ADD SUPPLEMENTAL LOG DATA;
SELECT supplemental_log_data_min FROM v\$database;
-- Expected: YES
\`\`\`

### Step 4.2 — Create Auxiliary Instance Parameter File on Target

\`\`\`bash
# On target GCE host, create a minimal init.ora for RMAN to start auxiliary instance
cat > /u01/app/oracle/admin/ORCLPRD/pfile/init_aux.ora <<'EOF'
db_name=ORCLPRD
db_unique_name=ORCLPRD_GCP
enable_pluggable_database=false
db_create_file_dest=/u01/oradata/ORCLPRD
db_create_online_log_dest_1=/u02/oradata/redo
db_create_online_log_dest_2=/u01/oradata/ORCLPRD/redo2
db_recovery_file_dest=/u01/fast_recovery_area
db_recovery_file_dest_size=1800G
memory_target=0
sga_target=160G
pga_aggregate_target=32G
pga_aggregate_limit=64G
processes=1000
open_cursors=500
undo_tablespace=UNDOTBS1
control_files=/u01/oradata/ORCLPRD/control01.ctl,/u02/oradata/redo/control02.ctl
log_archive_dest_1=LOCATION=/u01/fast_recovery_area/ORCLPRD/archivelog
EOF

# Start auxiliary instance in NOMOUNT state
export ORACLE_SID=ORCLPRD
sqlplus / as sysdba <<'EOF'
STARTUP NOMOUNT PFILE='/u01/app/oracle/admin/ORCLPRD/pfile/init_aux.ora';
EXIT
EOF
\`\`\`

### Step 4.3 — Execute RMAN Active Duplicate

\`\`\`bash
# Run on the target GCE host
# The duplicate connects to the source (auxiliary = target, target = source)
# This copies all datafiles over the network in parallel

su - oracle
nohup rman \
  target sys@ORCLPRD_ONPREM \
  auxiliary / \
  > /tmp/rman_duplicate_\$(date +%Y%m%d_%H%M).log 2>&1 <<'EOF' &

DUPLICATE TARGET DATABASE TO ORCLPRD
  FROM ACTIVE DATABASE
  SPFILE
    PARAMETER_VALUE_CONVERT
      '/u01/oradata/ORCLPRD','/u01/oradata/ORCLPRD',
      '/u02/oradata','/u02/oradata'
    SET db_unique_name='ORCLPRD_GCP'
    SET log_archive_dest_1='LOCATION=/u01/fast_recovery_area/ORCLPRD/archivelog'
    SET db_recovery_file_dest='/u01/fast_recovery_area'
    SET db_recovery_file_dest_size='1800G'
    SET sga_target='160G'
    SET pga_aggregate_target='32G'
    SET control_files='/u01/oradata/ORCLPRD/control01.ctl,/u02/oradata/redo/control02.ctl'
  SECTION SIZE 10G
  USING COMPRESSED BACKUPSET
  PARALLELISM 8;

EOF

echo "RMAN duplicate PID: $!"

# Monitor progress
tail -f /tmp/rman_duplicate_\$(date +%Y%m%d)_*.log
\`\`\`

### Step 4.4 — Verify Duplicate Completion

\`\`\`sql
-- On target (db-gcp-01.company.internal) after RMAN duplicate finishes

-- Verify database opened successfully
SELECT name, open_mode, log_mode, db_unique_name FROM v\$database;
-- Expected: OPEN_MODE = READ WRITE, LOG_MODE = ARCHIVELOG

-- Check all datafiles are online and not needing recovery
SELECT file#, status, name FROM v\$datafile WHERE status != 'ONLINE';
-- Expected: 0 rows

-- Check for INVALID objects (duplicated database should have none)
SELECT owner, object_type, COUNT(*) FROM dba_objects
WHERE status = 'INVALID'
  AND owner NOT IN ('SYS','SYSTEM','OUTLN','DBSNMP')
GROUP BY owner, object_type
ORDER BY owner;
\`\`\`

---

## Phase 5: Configure Data Guard for Controlled Cutover

Using the duplicated GCP database as a Data Guard standby allows the source and target to stay in sync until the final cutover, and provides a tested, rehearsed failover path.

### Step 5.1 — Configure Redo Transport from Source to Target

\`\`\`sql
-- On SOURCE (on-premises) database as SYSDBA

-- Add Data Guard redo log destination to GCP standby
ALTER SYSTEM SET log_archive_dest_2=
  'SERVICE=ORCLPRD_GCP ASYNC VALID_FOR=(ONLINE_LOGFILES,PRIMARY_ROLE)
   DB_UNIQUE_NAME=ORCLPRD_GCP'
  SCOPE=BOTH;

ALTER SYSTEM SET log_archive_dest_state_2=ENABLE SCOPE=BOTH;

-- Verify redo is being sent
SELECT dest_id, dest_name, status, error
FROM v\$archive_dest_status
WHERE dest_id = 2;
-- Expected: STATUS = VALID or ACTIVE
\`\`\`

### Step 5.2 — Convert Duplicate to Active Physical Standby

\`\`\`sql
-- On TARGET (GCE) — convert to managed recovery mode
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE
  USING CURRENT LOGFILE DISCONNECT FROM SESSION;

-- Verify apply is running
SELECT process, status, sequence#, delay_mins
FROM v\$managed_standby
WHERE process IN ('MRP0','RFS');
-- MRP0 = APPLYING_LOG, RFS = RECEIVING redo from source
\`\`\`

### Step 5.3 — Verify Transport and Apply Lag

\`\`\`sql
-- On TARGET — check transport lag
SELECT
  name,
  value,
  datum_time,
  time_computed
FROM v\$dataguard_stats
WHERE name IN ('transport lag', 'apply lag', 'apply finish time');
-- transport lag and apply lag should both be < 30 seconds for synchronised systems
\`\`\`

---

## Phase 6: Cutover Procedure

### Step 6.1 — Pre-Cutover Checklist

\`\`\`bash
# Final sync check — ensure apply lag is < 10 seconds before scheduling cutover
sqlplus / as sysdba <<'EOF'
SELECT name, value FROM v\$dataguard_stats
WHERE name IN ('transport lag', 'apply lag');
EXIT
EOF

# GCE snapshot before cutover (insurance)
gcloud compute disks snapshot oracle-data-01 \
  --snapshot-names=oracle-data-pre-cutover-\$(date +%Y%m%d) \
  --zone=us-central1-a --project=db-project-prod
\`\`\`

### Step 6.2 — Switchover to GCP Primary

\`\`\`sql
-- On SOURCE (on-premises) as SYSDBA — initiate switchover
ALTER DATABASE COMMIT TO SWITCHOVER TO PHYSICAL STANDBY WITH SESSION SHUTDOWN;
-- Wait for all sessions to drain (or kill remaining sessions if in maintenance window)

-- On TARGET (GCE) as SYSDBA — activate standby as new primary
ALTER DATABASE COMMIT TO SWITCHOVER TO PRIMARY WITH SESSION SHUTDOWN;
ALTER DATABASE OPEN;

-- Verify new primary
SELECT name, open_mode, database_role, db_unique_name FROM v\$database;
-- Expected: DATABASE_ROLE = PRIMARY, OPEN_MODE = READ WRITE
\`\`\`

### Step 6.3 — Redirect Application Connections

\`\`\`bash
# Update application server tnsnames.ora entries to point to GCP listener
# Replace db-onprem-01.company.com with db-gcp-01.company.internal in:
# - $ORACLE_HOME/network/admin/tnsnames.ora on all app servers
# - Any connection pool configuration (JDBC URL, ODBC DSN)
# - Any shell scripts using TNS aliases

# Test connectivity from app servers
tnsping ORCLPRD    # Should resolve to GCE host
sqlplus apps/<password>@ORCLPRD -S <<'EOF'
SELECT 'Connected to GCP' FROM dual;
EXIT
EOF
\`\`\`

---

## Phase 7: GCS Backup Configuration

### Step 7.1 — Configure RMAN to Back Up to GCS

\`\`\`bash
# Option A: RMAN backup to local FRA, then gsutil sync to GCS
# (Simpler, no Oracle Cloud Backup Module needed)

# Create RMAN backup script
cat > /u01/app/oracle/scripts/rman_backup_full.sh <<'SCRIPT'
#!/bin/bash
source /home/oracle/.bash_profile
LOG_DIR=/u01/app/oracle/logs/rman
mkdir -p \$LOG_DIR
LOG=\$LOG_DIR/rman_full_\$(date +%Y%m%d_%H%M).log

rman target / >> \$LOG 2>&1 <<'EOF'
RUN {
  CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS;
  CONFIGURE BACKUP OPTIMIZATION ON;
  CONFIGURE DEFAULT DEVICE TYPE TO DISK;
  CONFIGURE CONTROLFILE AUTOBACKUP ON;
  CONFIGURE CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE DISK TO '/u01/fast_recovery_area/ORCLPRD/autobackup/%F';

  BACKUP AS COMPRESSED BACKUPSET
    INCREMENTAL LEVEL 0
    DATABASE
    FORMAT '/u01/fast_recovery_area/ORCLPRD/backupset/%d_%T_%U.bkp'
    TAG 'FULL_WEEKLY';

  BACKUP ARCHIVELOG ALL
    FORMAT '/u01/fast_recovery_area/ORCLPRD/archivelog/%d_%T_%U.arc'
    DELETE INPUT;
}
EXIT
EOF

# Upload to GCS after successful backup
if grep -q "Recovery Manager complete" \$LOG; then
  gsutil -m rsync -r /u01/fast_recovery_area/ORCLPRD/ \
    gs://company-oracle-backups/orclprd/fra/
  echo "\$(date) GCS sync complete" >> \$LOG
else
  echo "\$(date) RMAN backup FAILED — skipping GCS sync" >> \$LOG
  echo "RMAN full backup failed on \$(hostname). Check \$LOG." \
    | mail -s "CRITICAL: RMAN Backup Failed" dba-team@company.com
fi
SCRIPT
chmod +x /u01/app/oracle/scripts/rman_backup_full.sh
\`\`\`

### Step 7.2 — Configure GCS Lifecycle Policy

\`\`\`bash
# Create lifecycle policy file
cat > /tmp/gcs_lifecycle.json <<'EOF'
{
  "lifecycle": {
    "rule": [
      {
        "action": {"type": "SetStorageClass", "storageClass": "NEARLINE"},
        "condition": {"age": 7, "matchesPrefix": ["orclprd/"]}
      },
      {
        "action": {"type": "SetStorageClass", "storageClass": "COLDLINE"},
        "condition": {"age": 30, "matchesPrefix": ["orclprd/"]}
      },
      {
        "action": {"type": "Delete"},
        "condition": {"age": 365, "matchesPrefix": ["orclprd/"]}
      }
    ]
  }
}
EOF

gsutil lifecycle set /tmp/gcs_lifecycle.json gs://company-oracle-backups
gsutil lifecycle get gs://company-oracle-backups
\`\`\`

---

## Phase 8: Monitoring Scripts and Crontab

Place all scripts in \`/u01/app/oracle/scripts/monitor/\`. Run as the \`oracle\` OS user.

### Script 1: Oracle Instance Health Check

\`\`\`bash
cat > /u01/app/oracle/scripts/monitor/check_instance.sh <<'SCRIPT'
#!/bin/bash
source /home/oracle/.bash_profile
ALERT_EMAIL="dba-team@company.com"
LOG=/u01/app/oracle/scripts/monitor/logs/instance_check.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')

RESULT=\$(sqlplus -s / as sysdba 2>/dev/null <<'EOF'
SET PAGESIZE 0 FEEDBACK OFF VERIFY OFF HEADING OFF
SELECT STATUS FROM V\$INSTANCE;
EXIT
EOF
)

STATUS=\$(echo "\$RESULT" | grep -E '^OPEN$|^MOUNTED$|^STARTED$' | head -1 | xargs)

if [ "\$STATUS" != "OPEN" ]; then
  echo "\$TIMESTAMP CRITICAL: Oracle instance status = '\${STATUS}' (expected OPEN)" >> \$LOG
  echo "Oracle instance ORCLPRD on \$(hostname) is not OPEN. Status: '\${STATUS}'" \
    | mail -s "CRITICAL: Oracle Instance Down on \$(hostname)" \$ALERT_EMAIL
else
  echo "\$TIMESTAMP OK: Instance status = OPEN" >> \$LOG
fi
SCRIPT
chmod +x /u01/app/oracle/scripts/monitor/check_instance.sh
\`\`\`

### Script 2: RMAN Backup Verification

\`\`\`bash
cat > /u01/app/oracle/scripts/monitor/check_rman_backup.sh <<'SCRIPT'
#!/bin/bash
source /home/oracle/.bash_profile
ALERT_EMAIL="dba-team@company.com"
LOG=/u01/app/oracle/scripts/monitor/logs/rman_check.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')

# Check last successful RMAN backup was within the last 25 hours
RESULT=\$(sqlplus -s / as sysdba 2>/dev/null <<'EOF'
SET PAGESIZE 0 FEEDBACK OFF VERIFY OFF HEADING OFF
SELECT COUNT(*) FROM V\$BACKUP_SET
WHERE STATUS = 'A'
  AND COMPLETION_TIME >= SYSDATE - 25/24
  AND BACKUP_TYPE IN ('D','I');
EXIT
EOF
)

COUNT=\$(echo "\$RESULT" | grep -E '^[0-9]+$' | head -1 | xargs)

if [ -z "\$COUNT" ] || [ "\$COUNT" -eq 0 ]; then
  echo "\$TIMESTAMP ALERT: No successful RMAN backup in the last 25 hours" >> \$LOG
  echo "No RMAN backup completed on \$(hostname)/ORCLPRD in the last 25 hours as of \$TIMESTAMP." \
    | mail -s "ALERT: RMAN Backup Missing — \$(hostname)" \$ALERT_EMAIL
else
  echo "\$TIMESTAMP OK: \${COUNT} successful RMAN backup set(s) in the last 25 hours" >> \$LOG
fi
SCRIPT
chmod +x /u01/app/oracle/scripts/monitor/check_rman_backup.sh
\`\`\`

### Script 3: Data Guard Transport and Apply Lag

\`\`\`bash
cat > /u01/app/oracle/scripts/monitor/check_dataguard.sh <<'SCRIPT'
#!/bin/bash
source /home/oracle/.bash_profile
ALERT_EMAIL="dba-team@company.com"
LOG=/u01/app/oracle/scripts/monitor/logs/dataguard_check.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
LAG_THRESHOLD_SECS=300  # Alert if apply lag exceeds 5 minutes

# Check database role first — only check lag on primary
ROLE=\$(sqlplus -s / as sysdba 2>/dev/null <<'EOF'
SET PAGESIZE 0 FEEDBACK OFF VERIFY OFF HEADING OFF
SELECT DATABASE_ROLE FROM V\$DATABASE;
EXIT
EOF
)
ROLE=\$(echo "\$ROLE" | grep -E 'PRIMARY|PHYSICAL STANDBY' | xargs)

if [ "\$ROLE" != "PRIMARY" ]; then
  echo "\$TIMESTAMP INFO: Not primary (\$ROLE), skipping DG check" >> \$LOG
  exit 0
fi

# Get apply lag in seconds for all standby destinations
LAG_RESULT=\$(sqlplus -s / as sysdba 2>/dev/null <<'EOF'
SET PAGESIZE 0 FEEDBACK OFF VERIFY OFF HEADING OFF
SELECT dest_name || '|' ||
       NVL(TO_CHAR(EXTRACT(HOUR FROM TO_DSINTERVAL(value)) * 3600 +
           EXTRACT(MINUTE FROM TO_DSINTERVAL(value)) * 60 +
           EXTRACT(SECOND FROM TO_DSINTERVAL(value))), '0')
FROM V\$DATAGUARD_STATS
WHERE name = 'apply lag'
  AND value IS NOT NULL;
EXIT
EOF
)

ALERT_MSG=""
while IFS='|' read -r DEST LAG_SECS; do
  DEST=\$(echo "\$DEST" | xargs)
  LAG_SECS=\$(echo "\$LAG_SECS" | xargs | cut -d. -f1)
  if [ -n "\$LAG_SECS" ] && [ "\$LAG_SECS" -gt "\$LAG_THRESHOLD_SECS" ]; then
    ALERT_MSG="\$ALERT_MSG\n  \$DEST: apply lag = \${LAG_SECS}s (threshold: \${LAG_THRESHOLD_SECS}s)"
  fi
done <<< "\$LAG_RESULT"

if [ -n "\$ALERT_MSG" ]; then
  echo "\$TIMESTAMP ALERT: Data Guard apply lag exceeded threshold" >> \$LOG
  echo -e "Data Guard apply lag on \$(hostname)/ORCLPRD at \$TIMESTAMP:\$ALERT_MSG" \
    | mail -s "ALERT: Data Guard Apply Lag — \$(hostname)" \$ALERT_EMAIL
else
  echo "\$TIMESTAMP OK: Data Guard lag within threshold" >> \$LOG
fi
SCRIPT
chmod +x /u01/app/oracle/scripts/monitor/check_dataguard.sh
\`\`\`

### Script 4: Tablespace Space Monitor

\`\`\`bash
cat > /u01/app/oracle/scripts/monitor/check_tablespace.sh <<'SCRIPT'
#!/bin/bash
source /home/oracle/.bash_profile
ALERT_EMAIL="dba-team@company.com"
LOG=/u01/app/oracle/scripts/monitor/logs/tablespace_check.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
THRESHOLD=85

sqlplus -s / as sysdba 2>/dev/null <<'EOF' | while IFS='|' read -r TS PCT; do
SET PAGESIZE 0 FEEDBACK OFF VERIFY OFF HEADING OFF
SELECT tablespace_name || '|' ||
       ROUND((1 - (free_mb / total_mb)) * 100, 1)
FROM (
  SELECT df.tablespace_name,
         SUM(df.bytes)/1048576 total_mb,
         NVL(SUM(fs.bytes)/1048576, 0) free_mb
  FROM dba_data_files df
  LEFT JOIN dba_free_space fs ON df.tablespace_name = fs.tablespace_name
  GROUP BY df.tablespace_name
)
ORDER BY 2 DESC;
EXIT
EOF
  TS=\$(echo "\$TS" | xargs)
  PCT=\$(echo "\$PCT" | xargs)
  if [ -n "\$PCT" ] && [ "\$(echo "\$PCT >= \$THRESHOLD" | bc -l 2>/dev/null)" = "1" ]; then
    echo "\$TIMESTAMP ALERT: \$TS is \${PCT}% full" >> \$LOG
    echo "Tablespace \$TS on \$(hostname)/ORCLPRD is \${PCT}% full at \$TIMESTAMP." \
      | mail -s "ALERT: Tablespace \$TS \${PCT}% Full — \$(hostname)" \$ALERT_EMAIL
  fi
done
echo "\$TIMESTAMP Tablespace check complete" >> \$LOG
SCRIPT
chmod +x /u01/app/oracle/scripts/monitor/check_tablespace.sh
\`\`\`

### Script 5: Oracle Alert Log Error Scanner

\`\`\`bash
cat > /u01/app/oracle/scripts/monitor/check_alert_log.sh <<'SCRIPT'
#!/bin/bash
source /home/oracle/.bash_profile
ALERT_EMAIL="dba-team@company.com"
LOG=/u01/app/oracle/scripts/monitor/logs/alert_log_check.log
MARKER=/u01/app/oracle/scripts/monitor/logs/.alert_log_marker
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')

# Find alert log via ADR
ALERT_LOG=\$(find \$ORACLE_BASE/diag/rdbms -name "alert_\${ORACLE_SID}.log" 2>/dev/null | head -1)

if [ -z "\$ALERT_LOG" ]; then
  echo "\$TIMESTAMP WARNING: Alert log not found at expected location" >> \$LOG
  exit 0
fi

# Read only new lines since last check
if [ -f "\$MARKER" ]; then
  NEW_LINES=\$(awk "NR > \$(cat \$MARKER)" "\$ALERT_LOG" 2>/dev/null)
else
  NEW_LINES=\$(tail -200 "\$ALERT_LOG" 2>/dev/null)
fi

# Update marker with current line count
wc -l < "\$ALERT_LOG" > "\$MARKER"

# Scan for critical errors (exclude known benign ORA- messages)
ERRORS=\$(echo "\$NEW_LINES" | grep -E "ORA-00600|ORA-07445|ORA-04031|ORA-04030|ORA-01555|ORA-00060|LGWR|DBWR.*error|Errors in file" \
  | grep -v "ORA-01555.*no rows\|ORA-00060.*deadlock.*resolved" | tail -20)

if [ -n "\$ERRORS" ]; then
  echo "\$TIMESTAMP ALERT: Critical errors in Oracle alert log" >> \$LOG
  echo "\$ERRORS" >> \$LOG
  echo "Critical Oracle alert log entries on \$(hostname)/\${ORACLE_SID} at \$TIMESTAMP:

\$ERRORS

Full alert log: \$ALERT_LOG" | mail -s "ALERT: Oracle Alert Log Errors — \$(hostname)" \$ALERT_EMAIL
else
  echo "\$TIMESTAMP OK: No critical alert log errors detected" >> \$LOG
fi
SCRIPT
chmod +x /u01/app/oracle/scripts/monitor/check_alert_log.sh
\`\`\`

### Script 6: GCP Disk Throttle and Latency Check

\`\`\`bash
cat > /u01/app/oracle/scripts/monitor/check_gcp_disk.sh <<'SCRIPT'
#!/bin/bash
ALERT_EMAIL="dba-team@company.com"
LOG=/u01/app/oracle/scripts/monitor/logs/gcp_disk_check.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
LATENCY_THRESHOLD_MS=8
SAMPLES=5

# Sample iostat — track w_await on Oracle disk devices
IOSTAT_OUT=\$(iostat -xm 2 \$SAMPLES 2>/dev/null)

HIGH_LATENCY=\$(echo "\$IOSTAT_OUT" | awk -v thresh="\$LATENCY_THRESHOLD_MS" '
  /^sd|^nvme|^xvd/ {
    dev=\$1; await=\$11+0
    if (await > thresh) { count[dev]++; total[dev]+=await }
  }
  END {
    for (d in count) {
      if (count[d] >= 3)
        printf "%s: avg_w_await=%.1fms (%d/%d samples)\n", d, total[d]/count[d], count[d], '"$SAMPLES"'
    }
  }
')

if [ -n "\$HIGH_LATENCY" ]; then
  echo "\$TIMESTAMP ALERT: Sustained high disk write latency" >> \$LOG
  echo "\$HIGH_LATENCY" >> \$LOG
  echo "High GCE disk write latency on \$(hostname) at \$TIMESTAMP.

Devices:
\$HIGH_LATENCY

Check GCP Console: Compute Engine > \$(hostname) > Monitoring > throttled_write_bytes_count.
Check Oracle: SELECT event, average_wait*10 FROM v\\\$system_event WHERE event LIKE '%parallel write%'." \
    | mail -s "ALERT: High Disk Latency on \$(hostname) — Possible GCP Throttle" \$ALERT_EMAIL
else
  echo "\$TIMESTAMP OK: Disk write latency within threshold (\${LATENCY_THRESHOLD_MS}ms)" >> \$LOG
fi
SCRIPT
chmod +x /u01/app/oracle/scripts/monitor/check_gcp_disk.sh
\`\`\`

### Script 7: GCS Backup Verification

\`\`\`bash
cat > /u01/app/oracle/scripts/monitor/check_gcs_backup.sh <<'SCRIPT'
#!/bin/bash
ALERT_EMAIL="dba-team@company.com"
LOG=/u01/app/oracle/scripts/monitor/logs/gcs_backup_check.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
GCS_BUCKET="gs://company-oracle-backups/orclprd/fra"
MAX_AGE_HOURS=26

# Find most recent backup file in GCS
LATEST_FILE=\$(gsutil ls -l "\${GCS_BUCKET}/backupset/" 2>/dev/null \
  | grep -v "TOTAL:" | sort -k2 -r | head -1)

if [ -z "\$LATEST_FILE" ]; then
  echo "\$TIMESTAMP ALERT: No backup files found in GCS bucket" >> \$LOG
  echo "No RMAN backup files found in \${GCS_BUCKET} on \$(hostname) at \$TIMESTAMP." \
    | mail -s "ALERT: GCS Backup Missing — \$(hostname)" \$ALERT_EMAIL
  exit 1
fi

# Parse last modified timestamp from gsutil ls output
FILE_DATE=\$(echo "\$LATEST_FILE" | awk '{print \$2}')
FILE_EPOCH=\$(date -d "\$FILE_DATE" +%s 2>/dev/null)
NOW_EPOCH=\$(date +%s)
AGE_HOURS=\$(( (NOW_EPOCH - FILE_EPOCH) / 3600 ))

if [ "\$AGE_HOURS" -gt "\$MAX_AGE_HOURS" ]; then
  echo "\$TIMESTAMP ALERT: Most recent GCS backup is \${AGE_HOURS} hours old (threshold: \${MAX_AGE_HOURS}h)" >> \$LOG
  echo "Most recent backup in \${GCS_BUCKET} is \${AGE_HOURS} hours old on \$(hostname) at \$TIMESTAMP.
File: \$(echo \$LATEST_FILE | awk '{print \$3}')" \
    | mail -s "ALERT: GCS Backup Stale (\${AGE_HOURS}h) — \$(hostname)" \$ALERT_EMAIL
else
  echo "\$TIMESTAMP OK: GCS backup is \${AGE_HOURS} hours old (threshold: \${MAX_AGE_HOURS}h)" >> \$LOG
fi
SCRIPT
chmod +x /u01/app/oracle/scripts/monitor/check_gcs_backup.sh
\`\`\`

### Step 8.8 — Deploy Crontab

\`\`\`bash
mkdir -p /u01/app/oracle/scripts/monitor/logs
chown -R oracle:oinstall /u01/app/oracle/scripts/monitor

crontab -u oracle -e
\`\`\`

\`\`\`cron
# Oracle 19c on GCP Monitoring Crontab — oracle OS user
# Format: minute hour day-of-month month day-of-week command

# Oracle instance health — every 5 minutes
*/5 * * * * /u01/app/oracle/scripts/monitor/check_instance.sh >> /u01/app/oracle/scripts/monitor/logs/cron.log 2>&1

# Data Guard lag — every 10 minutes
*/10 * * * * /u01/app/oracle/scripts/monitor/check_dataguard.sh >> /u01/app/oracle/scripts/monitor/logs/cron.log 2>&1

# Tablespace space — every 30 minutes
*/30 * * * * /u01/app/oracle/scripts/monitor/check_tablespace.sh >> /u01/app/oracle/scripts/monitor/logs/cron.log 2>&1

# Alert log scan — every 15 minutes
*/15 * * * * /u01/app/oracle/scripts/monitor/check_alert_log.sh >> /u01/app/oracle/scripts/monitor/logs/cron.log 2>&1

# GCP disk latency — every 10 minutes during business hours
*/10 6-22 * * * /u01/app/oracle/scripts/monitor/check_gcp_disk.sh >> /u01/app/oracle/scripts/monitor/logs/cron.log 2>&1

# RMAN backup verification — daily at 09:00 (checks last 25h)
0 9 * * * /u01/app/oracle/scripts/monitor/check_rman_backup.sh >> /u01/app/oracle/scripts/monitor/logs/cron.log 2>&1

# GCS backup verification — daily at 10:00 (checks GCS bucket for recent files)
0 10 * * * /u01/app/oracle/scripts/monitor/check_gcs_backup.sh >> /u01/app/oracle/scripts/monitor/logs/cron.log 2>&1

# Nightly RMAN full backup — 01:00 Sunday, incremental other nights
0 1 * * 0 /u01/app/oracle/scripts/rman_backup_full.sh >> /u01/app/oracle/scripts/monitor/logs/rman_full.log 2>&1
0 1 * * 1-6 /u01/app/oracle/scripts/rman_backup_incremental.sh >> /u01/app/oracle/scripts/monitor/logs/rman_incr.log 2>&1

# Weekly: purge monitor logs older than 30 days
0 3 * * 0 find /u01/app/oracle/scripts/monitor/logs -name "*.log" -mtime +30 -delete
\`\`\`

---

## Summary

This runbook migrated a self-managed Oracle database from on-premises to Oracle 19c on RHEL 9 on GCE across eight phases. GCP infrastructure was provisioned via \`gcloud\` with separate Hyperdisk Extreme for redo logs and \`pd-ssd\` for datafiles, enforcing the storage isolation that prevents redo write latency from competing with datafile I/O. RHEL 9 prerequisites used the \`oracle-database-preinstall-19c\` package to apply all kernel parameters, create Oracle OS users, and configure limits in a single command. Oracle 19c software was installed software-only via silent installer; the database itself was built by RMAN active duplicate copying live data over the VPN from the source, eliminating a separate export/restore cycle. A Data Guard physical standby was layered on top of the duplicate to maintain ongoing synchronisation, providing a tested switchover path with under 30 minutes of final cutover downtime regardless of database size. RMAN backups write to the local FRA and are synced to GCS with a lifecycle policy that tiers backups from Standard to Nearline to Coldline automatically, replacing tape infrastructure with infinite-capacity managed storage.

Seven crontab-scheduled monitoring scripts cover the full post-migration operational surface: Oracle instance status (every 5 minutes), Data Guard transport and apply lag (every 10 minutes), tablespace utilisation (every 30 minutes), Oracle alert log critical error scanning (every 15 minutes), GCP disk write latency and throttle detection (every 10 minutes during business hours), RMAN backup completion verification (daily), and GCS bucket freshness confirmation (daily). Together these scripts detect the most common post-migration failure modes — instance down, redo transport disconnect, storage exhaustion, GCP disk throttling, missed backup, and GCS sync failure — before they escalate to unplanned downtime.`,
};

async function main() {
  console.log('Inserting Oracle on-prem to GCP migration runbook...');
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
