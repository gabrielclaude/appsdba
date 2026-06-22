import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle on Google Cloud Runbook',
  slug: 'oracle-google-cloud-runbook',
  excerpt:
    'Step-by-step operational guide: provisioning Oracle Database@Google Cloud, connecting to GCP services, configuring Data Guard, monitoring with Cloud Observability, and day-2 operations.',
  category: 'oracle-google-cloud' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-22'),
  youtubeUrl: null,
  content: `This runbook covers the end-to-end provisioning and operations of Oracle Database@Google Cloud (OD@GC). Assumptions: an active Oracle Database@Google Cloud subscription linked to your GCP project, GCP project with billing enabled, Oracle Support (MOS) access, and a DBA team familiar with Oracle Database 19c administration.

---

## Phase 0: Pre-Provisioning Checklist

### Step 0.1 — Verify GCP Project Billing and APIs

\`\`\`bash
# Confirm active billing account linked to project
gcloud billing projects describe $PROJECT_ID

# Enable required GCP APIs
gcloud services enable compute.googleapis.com
gcloud services enable cloudresourcemanager.googleapis.com
gcloud services enable logging.googleapis.com
gcloud services enable monitoring.googleapis.com
\`\`\`

### Step 0.2 — Plan VPC Network and IP Ranges

OD@GC requires a dedicated subnet in your VPC for the private interconnect. Reserve a /26 or larger CIDR block that does not overlap with existing subnets.

\`\`\`bash
# Create a dedicated subnet for OD@GC interconnect
gcloud compute networks subnets create oracle-odgc-subnet \
  --network=my-vpc \
  --region=us-east4 \
  --range=10.20.0.0/26 \
  --enable-private-ip-google-access
\`\`\`

### Step 0.3 — Configure IAM Roles

\`\`\`bash
# Grant Oracle service account permission to attach to your VPC
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:oracle-gcp@oracle-gcp-sa.iam.gserviceaccount.com" \
  --role="roles/compute.networkUser"

# Grant DBA team OCI access for OD@GC console
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="user:dba@company.com" \
  --role="roles/oracledatabase.admin"
\`\`\`

### Step 0.4 — Pre-Provisioning Checklist Sign-Off

| Item | Status |
|------|--------|
| OD@GC subscription active and linked to GCP project | ☐ |
| VPC subnet reserved (/26 minimum) | ☐ |
| IAM roles granted to Oracle service account | ☐ |
| Oracle Support contract covers OD@GC | ☐ |
| Change management ticket raised | ☐ |
| Network firewall rules planned (port 1521, SSH) | ☐ |

---

## Phase 1: Provision OD@GC Exadata Database Service

### Step 1.1 — Create Exadata Infrastructure

Navigate to: GCP Console → Oracle Database → Exadata Infrastructure → Create

Or use gcloud CLI:

\`\`\`bash
gcloud oracle-database cloud-exadata-infrastructures create my-exadata \
  --location=us-east4 \
  --display-name="Production Exadata" \
  --shape=Exadata.X9M \
  --compute-count=2 \
  --storage-count=3
\`\`\`

Provisioning time: 2–4 hours. Monitor status:

\`\`\`bash
gcloud oracle-database cloud-exadata-infrastructures describe my-exadata \
  --location=us-east4 \
  --format="value(lifecycleState)"
# Wait for: AVAILABLE
\`\`\`

### Step 1.2 — Create VM Cluster

\`\`\`bash
gcloud oracle-database cloud-vm-clusters create my-vmcluster \
  --location=us-east4 \
  --exadata-infrastructure=my-exadata \
  --cpu-core-count=8 \
  --memory-size-in-gbs=120 \
  --db-node-storage-size-in-gbs=200 \
  --data-storage-size-in-tbs=2 \
  --display-name="EBS Production VM Cluster" \
  --ssh-public-keys="$(cat ~/.ssh/id_rsa.pub)" \
  --network=my-vpc \
  --subnet=oracle-odgc-subnet \
  --hostname-prefix=ebsprod
\`\`\`

### Step 1.3 — Verify VM Cluster Network Connectivity

\`\`\`bash
# Get the SCAN IP addresses assigned to the VM cluster
gcloud oracle-database cloud-vm-clusters describe my-vmcluster \
  --location=us-east4 \
  --format="value(scanListenerPortTcp,scanIpIds)"

# From a GCE instance in the same VPC, test listener connectivity
nc -zv <scan_ip> 1521
# Expected: Connection to <scan_ip> 1521 port [tcp/ncube-lm] succeeded!
\`\`\`

---

## Phase 2: Create Oracle Database

### Step 2.1 — Create Container Database (CDB)

\`\`\`bash
gcloud oracle-database db-homes create my-dbhome \
  --location=us-east4 \
  --cloud-vm-cluster=my-vmcluster \
  --db-version=19.0.0.0

gcloud oracle-database databases create my-cdb \
  --location=us-east4 \
  --cloud-vm-cluster=my-vmcluster \
  --db-home=my-dbhome \
  --db-name=EBSPROD \
  --admin-password='<secure_password>' \
  --character-set=AL32UTF8 \
  --national-character-set=AL16UTF16 \
  --enable-database-delete=false
\`\`\`

### Step 2.2 — Post-Creation Database Configuration

SSH into the first Exadata compute node, then configure the database:

\`\`\`sql
-- Connect as SYSDBA
sqlplus / as sysdba

-- Verify CDB is open
SELECT name, open_mode, cdb FROM v$database;

-- Set key parameters for EBS workload
ALTER SYSTEM SET sga_target = 50G SCOPE=SPFILE;
ALTER SYSTEM SET pga_aggregate_target = 10G SCOPE=SPFILE;
ALTER SYSTEM SET db_cache_size = 30G SCOPE=SPFILE;
ALTER SYSTEM SET shared_pool_size = 8G SCOPE=SPFILE;
ALTER SYSTEM SET open_cursors = 3000 SCOPE=SPFILE;
ALTER SYSTEM SET session_cached_cursors = 500 SCOPE=SPFILE;
ALTER SYSTEM SET enable_ddl_logging = TRUE SCOPE=SPFILE;

-- Enable archivelog mode (required for Data Guard and RMAN)
SHUTDOWN IMMEDIATE;
STARTUP MOUNT;
ALTER DATABASE ARCHIVELOG;
ALTER DATABASE OPEN;

-- Verify
SELECT log_mode FROM v$database;
-- Expected: ARCHIVELOG
\`\`\`

### Step 2.3 — Create PDB for EBS

\`\`\`sql
CREATE PLUGGABLE DATABASE ebs_prod
  ADMIN USER pdb_admin IDENTIFIED BY '<password>'
  STORAGE (MAXSIZE 2T)
  DEFAULT TABLESPACE users
  DATAFILE '/u02/app/oracle/oradata/EBSPROD/ebs_prod/users01.dbf'
  SIZE 5G AUTOEXTEND ON;

ALTER PLUGGABLE DATABASE ebs_prod OPEN;
ALTER PLUGGABLE DATABASE ebs_prod SAVE STATE;
\`\`\`

---

## Phase 3: Configure RMAN Backup to Cloud Storage

### Step 3.1 — Create GCS Bucket for Backups

\`\`\`bash
gcloud storage buckets create gs://my-oracle-rman-backups \
  --location=us-east4 \
  --default-storage-class=NEARLINE \
  --uniform-bucket-level-access

# Set lifecycle: delete objects older than 30 days
gcloud storage buckets update gs://my-oracle-rman-backups \
  --lifecycle-file=lifecycle.json
\`\`\`

\`\`\`json
// lifecycle.json
{
  "rule": [
    {
      "action": {"type": "Delete"},
      "condition": {"age": 30}
    }
  ]
}
\`\`\`

### Step 3.2 — Configure RMAN Backup Script

\`\`\`bash
# /u01/oracle/scripts/rman_full_backup.sh
#!/bin/bash
export ORACLE_SID=EBSPROD
export ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export PATH=$ORACLE_HOME/bin:$PATH

rman target / <<EOF
CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 14 DAYS;
CONFIGURE BACKUP OPTIMIZATION ON;
CONFIGURE CONTROLFILE AUTOBACKUP ON;
CONFIGURE CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE DISK TO 'gs://my-oracle-rman-backups/cf_%F';
CONFIGURE DEFAULT DEVICE TYPE TO DISK;
CONFIGURE CHANNEL DEVICE TYPE DISK FORMAT 'gs://my-oracle-rman-backups/bkp_%d_%T_%U';

BACKUP AS COMPRESSED BACKUPSET DATABASE PLUS ARCHIVELOG DELETE INPUT;
DELETE NOPROMPT OBSOLETE;
EOF
\`\`\`

### Step 3.3 — Schedule Backup via Crontab

\`\`\`bash
# Add to oracle user's crontab
0 1 * * * /u01/oracle/scripts/rman_full_backup.sh >> /u01/oracle/logs/rman_\$(date +\%Y\%m\%d).log 2>&1
\`\`\`

---

## Phase 4: Configure Oracle Data Guard

### Step 4.1 — On Primary: Set Data Guard Parameters

\`\`\`sql
ALTER SYSTEM SET log_archive_dest_2 =
  'SERVICE=standby_tns ASYNC NOAFFIRM
   VALID_FOR=(ONLINE_LOGFILES,PRIMARY_ROLE)
   DB_UNIQUE_NAME=EBSPROD_STB'
SCOPE=BOTH;

ALTER SYSTEM SET log_archive_dest_state_2 = ENABLE SCOPE=BOTH;
ALTER SYSTEM SET log_archive_config = 'DG_CONFIG=(EBSPROD,EBSPROD_STB)' SCOPE=BOTH;
ALTER SYSTEM SET fal_server = 'standby_tns' SCOPE=BOTH;
ALTER SYSTEM SET fal_client = 'primary_tns' SCOPE=BOTH;
ALTER SYSTEM SET standby_file_management = AUTO SCOPE=BOTH;
\`\`\`

### Step 4.2 — Create Standby Using RMAN DUPLICATE

\`\`\`bash
# On standby host, run RMAN duplicate from active database
rman target sys/<password>@primary_tns auxiliary sys/<password>@standby_tns <<EOF
DUPLICATE TARGET DATABASE FOR STANDBY FROM ACTIVE DATABASE
  DORECOVER
  SPFILE
    SET db_unique_name = 'EBSPROD_STB'
    SET log_archive_dest_2 = 'SERVICE=primary_tns ASYNC NOAFFIRM VALID_FOR=(ONLINE_LOGFILES,PRIMARY_ROLE) DB_UNIQUE_NAME=EBSPROD'
    SET fal_server = 'primary_tns'
    SET fal_client = 'standby_tns'
  NOFILENAMECHECK;
EOF
\`\`\`

### Step 4.3 — Verify Data Guard Transport

\`\`\`sql
-- On primary
SELECT dest_id, dest_name, status, error, applied_scn
FROM v$archive_dest_status
WHERE dest_id = 2;

-- On standby
SELECT name, open_mode, database_role, protection_mode FROM v$database;
SELECT sequence#, applied FROM v$archived_log ORDER BY sequence# DESC FETCH FIRST 5 ROWS ONLY;
\`\`\`

---

## Phase 5: Configure Cloud Observability

### Step 5.1 — Enable Oracle Database Observability Plugin

\`\`\`bash
# Install Oracle Cloud Observability agent on each compute node
curl -O https://download.oracle.com/cloud-agent/oracle-cloud-agent.rpm
sudo rpm -i oracle-cloud-agent.rpm
sudo systemctl enable oracle-cloud-agent
sudo systemctl start oracle-cloud-agent

# Configure plugin to publish to GCP Cloud Monitoring
sudo oracle-cloud-agent configure --gcp-project=$PROJECT_ID
\`\`\`

### Step 5.2 — Create Cloud Monitoring Dashboard

\`\`\`bash
# Create alerting policy for CPU > 90%
gcloud monitoring alert-policies create \
  --display-name="OD@GC CPU Alert" \
  --condition-display-name="CPU > 90%" \
  --condition-filter='metric.type="custom.googleapis.com/oracle/db/cpu_utilization" resource.type="global"' \
  --condition-threshold-value=90 \
  --condition-threshold-comparison=COMPARISON_GT \
  --condition-aggregations-alignment-period=300s \
  --notification-channels=$NOTIFICATION_CHANNEL_ID
\`\`\`

---

## Phase 6: Connect EBS Application Tier

### Step 6.1 — Update EBS tnsnames.ora

\`\`\`
# $TNS_ADMIN/tnsnames.ora on EBS application servers
EBSPROD =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = ebsprod-scan.my-domain.internal)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = ebs_prod)
    )
  )
\`\`\`

### Step 6.2 — Test Connectivity and Run AutoConfig

\`\`\`bash
# Test from EBS application tier
tnsping EBSPROD
sqlplus apps/<password>@EBSPROD

# Run AutoConfig to update all EBS configuration files with new DB details
cd $AD_TOP/bin
perl adautocfg.pl appspass=<password>
\`\`\`

---

## Phase 7: Day-2 Operations Checklist

### Monthly Tasks

| Task | Command |
|------|---------|
| Verify RMAN backup success | \`rman target / <<< "LIST BACKUP COMPLETED AFTER 'SYSDATE-30'"\` |
| Check ASM disk group space | \`SELECT name, total_mb, free_mb FROM v\$asm_diskgroup\` |
| Review Cloud Monitoring alerts | GCP Console → Monitoring → Alerting |
| Verify Data Guard transport lag | \`SELECT value FROM v\$dataguard_stats WHERE name='transport lag'\` |
| Gather schema statistics | \`EXEC DBMS_STATS.GATHER_SCHEMA_STATS('APPS')\` |

### Quarterly Tasks

| Task | Notes |
|------|-------|
| Apply Oracle CPU patch | Download from MOS, apply via OPatch on compute nodes |
| Review IORM policy | Adjust priorities based on workload changes |
| Capacity review | Review ASM disk group growth rate, project 12-month capacity |
| DR test | Perform Data Guard switchover to standby, validate EBS connectivity, switchback |`,
};

async function main() {
  console.log('Inserting Oracle on Google Cloud runbook...');
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
