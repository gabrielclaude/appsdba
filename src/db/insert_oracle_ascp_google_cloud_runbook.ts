import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle ASCP on RHEL9 on Google Cloud Runbook',
  slug: 'oracle-ascp-rhel9-google-cloud-runbook',
  excerpt:
    'Step-by-step operational guide: RHEL 9 OS prerequisites, EBS 12.2.x and ASCP installation on GCP, collection configuration, plan management, database management problems and solutions, and monthly checklist.',
  category: 'oracle-google-cloud' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-22'),
  youtubeUrl: null,
  content: `This runbook covers the complete deployment and operations of Oracle ASCP on RHEL 9 in Google Cloud. Assumptions: GCP project with Compute Engine API enabled, RHEL 9 base image (RHEL 9.2 or later), Oracle Database 19c (RU 19.17+) on OD@GC or a GCE VM with pd-ssd, EBS 12.2.x with MSC/ASCP product licence.

---

## Phase 0: RHEL 9 OS Prerequisites

### Step 0.1 — Create GCE Instance for ASCP Application Tier

\`\`\`bash
gcloud compute instances create ascp-app-01 \
  --zone=us-east4-b \
  --machine-type=c3-highcpu-44 \
  --image-family=rhel-9 \
  --image-project=rhel-cloud \
  --boot-disk-size=200GB \
  --boot-disk-type=pd-ssd \
  --network=my-vpc \
  --subnet=app-subnet \
  --private-network-ip=10.10.1.20 \
  --metadata="enable-oslogin=true"
\`\`\`

### Step 0.2 — Install oracle-database-preinstall-19c

\`\`\`bash
# Enable Oracle Linux repositories on RHEL 9
sudo dnf install -y oracle-epel-release-el9
sudo dnf config-manager --enable ol9_baseos_latest ol9_appstream

# Install preinstall package (sets kernel params, creates oracle user/groups)
sudo dnf install -y oracle-database-preinstall-19c

# Verify key parameters
sysctl kernel.shmmax kernel.shmmni kernel.shmall
cat /etc/security/limits.d/oracle-database-preinstall-19c.conf
\`\`\`

### Step 0.3 — Configure Transparent Hugepages

\`\`\`bash
# Install and apply Oracle tuned profile
sudo dnf install -y tuned
sudo systemctl enable --now tuned
sudo tuned-adm profile oracle

# Verify THP disabled
cat /sys/kernel/mm/transparent_hugepage/enabled
# Expected: always madvise [never]

# Make persistent across reboots
echo 'vm.nr_hugepages = 16384' | sudo tee -a /etc/sysctl.d/99-oracle.conf
sudo sysctl -p /etc/sysctl.d/99-oracle.conf
\`\`\`

### Step 0.4 — GCP-Specific: TCP Keepalive for VPC Firewall

\`\`\`bash
# GCP VPC drops idle TCP connections after 1800 seconds
# Configure OS-level TCP keepalive to prevent this
sudo tee -a /etc/sysctl.d/99-oracle.conf <<'EOF'
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_intvl = 60
net.ipv4.tcp_keepalive_probes = 9
EOF
sudo sysctl -p /etc/sysctl.d/99-oracle.conf
\`\`\`

### Step 0.5 — SELinux Context for Oracle

\`\`\`bash
# Check SELinux mode
sestatus | grep "Current mode"

# Set Oracle directory context
sudo semanage fcontext -a -t oracle_db_t "/u01/app/oracle(/.*)?"
sudo semanage fcontext -a -t oracle_db_t "/u01/app/applmgr(/.*)?"
sudo restorecon -Rv /u01/app/

# Allow Oracle to bind to listener port
sudo semanage port -a -t oracle_port_t -p tcp 1521
\`\`\`

### Step 0.6 — Phase 0 Completion Verification

\`\`\`bash
# Run Oracle preinstall verification
/usr/bin/oracle-database-preinstall-19c-verify

# Verify all checks pass before proceeding to Phase 1
# Expected output: All checks passed
\`\`\`

---

## Phase 1: Oracle Database Configuration for ASCP

### Step 1.1 — Verify Oracle 19c Patch Level (RHEL 9 Requirement)

\`\`\`bash
# On Oracle DB host
$ORACLE_HOME/OPatch/opatch lsinventory | grep "Patch 3"
# Must show 19.17.0.0 or later for RHEL 9 support
# If on 19.16 or earlier: apply the latest 19c RU before proceeding
\`\`\`

### Step 1.2 — Create Tablespaces for ASCP MSC Schema

\`\`\`sql
-- Connect as SYSDBA to the ASCP database
sqlplus / as sysdba

-- MSC data tablespace (large — ASCP planning data)
CREATE TABLESPACE msc_data
  DATAFILE '/u02/oradata/EBSPROD/msc_data01.dbf' SIZE 50G AUTOEXTEND ON NEXT 10G MAXSIZE 500G
  EXTENT MANAGEMENT LOCAL UNIFORM SIZE 1M
  SEGMENT SPACE MANAGEMENT AUTO;

-- MSC index tablespace
CREATE TABLESPACE msc_index
  DATAFILE '/u02/oradata/EBSPROD/msc_index01.dbf' SIZE 20G AUTOEXTEND ON NEXT 5G MAXSIZE 200G
  EXTENT MANAGEMENT LOCAL UNIFORM SIZE 256K
  SEGMENT SPACE MANAGEMENT AUTO;

-- MSC temp tablespace
CREATE TEMPORARY TABLESPACE msc_temp
  TEMPFILE '/u02/oradata/EBSPROD/msc_temp01.dbf' SIZE 20G AUTOEXTEND ON NEXT 5G MAXSIZE 100G
  EXTENT MANAGEMENT LOCAL UNIFORM SIZE 1M;
\`\`\`

### Step 1.3 — Configure sqlnet.ora for GCP (Critical)

\`\`\`bash
# On Oracle DB server: $TNS_ADMIN/sqlnet.ora
cat >> $ORACLE_HOME/network/admin/sqlnet.ora <<'EOF'
# GCP VPC firewall idle timeout mitigation
SQLNET.EXPIRE_TIME = 10

# Secure external password store
WALLET_LOCATION = (SOURCE = (METHOD = FILE)(METHOD_DATA = (DIRECTORY = /u01/app/oracle/wallet)))
SQLNET.WALLET_OVERRIDE = TRUE
EOF

# Also set on ASCP application tier
cat >> $TNS_ADMIN/sqlnet.ora <<'EOF'
SQLNET.EXPIRE_TIME = 10
EOF
\`\`\`

### Step 1.4 — ASCP-Specific Database Parameters

\`\`\`sql
-- Parameters required for ASCP collection and planning performance
ALTER SYSTEM SET shared_pool_size = 4G SCOPE=SPFILE;
ALTER SYSTEM SET shared_pool_reserved_size = 400M SCOPE=SPFILE;
ALTER SYSTEM SET sort_area_size = 67108864 SCOPE=SPFILE;         -- 64 MB for collection sorts
ALTER SYSTEM SET hash_area_size = 134217728 SCOPE=SPFILE;        -- 128 MB for hash joins
ALTER SYSTEM SET parallel_max_servers = 32 SCOPE=SPFILE;
ALTER SYSTEM SET parallel_min_servers = 4 SCOPE=SPFILE;
ALTER SYSTEM SET job_queue_processes = 20 SCOPE=SPFILE;          -- ASCP uses DB scheduler jobs

-- Restart to apply SPFILE changes
SHUTDOWN IMMEDIATE;
STARTUP;
\`\`\`

---

## Phase 2: EBS ASCP Product Installation

### Step 2.1 — Verify ASCP Product Licence in EBS

\`\`\`sql
-- Check ASCP (MSC) product status in EBS
SELECT application_short_name, product_version, status
FROM fnd_product_installations
WHERE application_short_name = 'MSC';
-- Expected status: I (installed)
-- If not installed: run Oracle Apps ASCP installation from EBS media
\`\`\`

### Step 2.2 — Run adsetmsc.pl

\`\`\`bash
# Source EBS environment
. /u01/oracle/EBSapps.env run

# Run ASCP setup script (sets MSC schema, tablespace assignments)
cd $AD_TOP/bin
perl adsetmsc.pl contextfile=$CONTEXT_FILE appspass=<apps_password> \
  msc_data_ts=msc_data msc_index_ts=msc_index msc_temp_ts=msc_temp

# Monitor log for completion
tail -f $APPLRGF/adsetmsc*.log
\`\`\`

### Step 2.3 — Register ASCP Instance in EBS

Navigate in EBS: Supply Chain Planning → MSC → Setup → Define Instances

- Instance Type: Local (if ASCP DB = EBS DB) or Remote (if separate planning DB)
- Instance Code: matches Oracle SID
- Apps User/Password: APPS schema credentials
- Test connection before saving

---

## Phase 3: Collection Configuration

### Step 3.1 — Set Collection Parameters

Navigate: Supply Chain Planning → MSC → Setup → Collection Parameters

Key parameters:

| Parameter | Recommended Value | Notes |
|-----------|------------------|-------|
| History Days (Sales Orders) | 365 | Captures full year of demand history |
| History Days (Shipments) | 180 | Shipping history for demand forecasting |
| Batch Size | 10000 | Rows per commit during ODS load |
| Parallel Degree | 4 | Collection workers (match to DB CPU) |

### Step 3.2 — Run Initial Full Collection

\`\`\`sql
-- Submit collection from SQL (or via SCP: Supply Chain Planning > Collect Planning Data)
-- Verify collection concurrent request submitted
SELECT request_id, phase_code, status_code, actual_start_date
FROM fnd_concurrent_requests
WHERE concurrent_program_id = (
  SELECT concurrent_program_id FROM fnd_concurrent_programs
  WHERE concurrent_program_name = 'MSCSCH' AND application_id = 724)
ORDER BY request_id DESC
FETCH FIRST 1 ROW ONLY;
\`\`\`

### Step 3.3 — Verify ODS Tables Populated

\`\`\`sql
-- After collection completes, verify ODS tables have data
SELECT 'MSC_ST_SYSTEM_ITEMS' tbl, COUNT(*) cnt FROM msc.msc_st_system_items
UNION ALL SELECT 'MSC_ST_SUPPLIES', COUNT(*) FROM msc.msc_st_supplies
UNION ALL SELECT 'MSC_ST_DEMANDS', COUNT(*) FROM msc.msc_st_demands
ORDER BY 1;
-- Counts should match EBS source table counts (within collection filter scope)
\`\`\`

---

## Phase 4: Plan Management

### Step 4.1 — Create ASCP Plan

Navigate: Supply Chain Planning → MSC → Plans → Define Plan

Key plan options:
- Plan Type: Production Plan or Simulation Plan
- Organization: select planning organization(s)
- Horizon: 52 weeks minimum
- Demand: Sales Orders + Forecast

### Step 4.2 — Launch Plan Run

Submit from EBS: Supply Chain Planning → MSC → Plans → Launch Plan

Or via concurrent request:

\`\`\`sql
-- Find plan_id for your plan name
SELECT plan_id, compile_designator, description FROM msc_plans;

-- Monitor plan run
SELECT plan_name, plan_completion_date, last_run_duration_mins,
       decode(plan_run_status, 1, 'RUNNING', 2, 'COMPLETE', 3, 'ERROR', plan_run_status) status
FROM msc_plans
WHERE plan_id = &plan_id;
\`\`\`

### Step 4.3 — Interpret Plan Results

\`\`\`sql
-- Check plan exceptions (items with planning issues)
SELECT exception_type, COUNT(*) exception_count
FROM msc_exception_details
WHERE plan_id = &plan_id
GROUP BY exception_type
ORDER BY exception_count DESC;

-- Top 10 items with most exceptions
SELECT si.item_name, COUNT(*) exceptions
FROM msc_exception_details ed
JOIN msc_system_items si ON ed.inventory_item_id = si.inventory_item_id
  AND ed.organization_id = si.organization_id
  AND ed.plan_id = si.plan_id
WHERE ed.plan_id = &plan_id
GROUP BY si.item_name
ORDER BY exceptions DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

---

## Phase 5: GCP-Specific Troubleshooting

### Step 5.1 — Diagnose and Fix MSCNSP Signal 11

\`\`\`bash
# Symptom: Plan run fails immediately with signal 11 in ASCP log
# Check ASCP log for signal 11:
grep -i "signal 11\|SIGSEGV\|segmentation" $MSC_TOP/log/mscnsp*.log

# Step A: Verify correct environment loaded
echo $MSC_TOP   # Must point to THIS system's MSC_TOP
cat $CONTEXT_FILE | grep -E "MSC_TOP|msc_top"   # Must match $MSC_TOP

# Step B: Update library paths after clone
cd $AD_TOP/bin
perl adupdlibpath.pl contextfile=$CONTEXT_FILE
# Review output: each lib path should point to current system

# Step C: Relink ASCP solver binary
cd $MSC_TOP/bin
adrelink.sh force=y "msc mscnsp"
# Expected: "Linking mscnsp ... done"

# Step D: Re-run AutoConfig
cd $AD_TOP/bin
perl adautocfg.pl appspass=<apps_password>

# Step E: Bounce services and retry plan
adapcctl.sh stop && adcmctl.sh stop
adapcctl.sh start && adcmctl.sh start
\`\`\`

### Step 5.2 — Fix ORA-04031 During Collection

\`\`\`sql
-- Diagnose: check shared pool fragmentation
SELECT '4031 risk' indicator,
       MAX(ksmchsiz) max_free_chunk_kb,
       COUNT(*) free_chunks
FROM x$ksmsp
WHERE ksmchcls = 'free';
-- If max_free_chunk_kb < 10000 (10 MB), shared pool is fragmented

-- Fix: flush shared pool (non-production only) and increase size
ALTER SYSTEM FLUSH SHARED_POOL;

-- Permanently increase shared pool
ALTER SYSTEM SET shared_pool_size = 6G SCOPE=SPFILE;
ALTER SYSTEM SET shared_pool_reserved_size = 600M SCOPE=SPFILE;
SHUTDOWN IMMEDIATE; STARTUP;

-- Post-fix: verify free memory
SELECT name, bytes/1024/1024 mb FROM v$sgastat
WHERE pool = 'shared pool' AND name = 'free memory';
-- Target: > 1 GB free after initial population
\`\`\`

### Step 5.3 — Fix TCP Connection Drops (ORA-03113/03114)

\`\`\`bash
# Verify sqlnet.expire_time is set on BOTH DB server and app tier
grep -i expire $ORACLE_HOME/network/admin/sqlnet.ora
# Must show: SQLNET.EXPIRE_TIME = 10

# If not set, add it:
echo "SQLNET.EXPIRE_TIME = 10" >> $ORACLE_HOME/network/admin/sqlnet.ora

# Restart the Oracle listener to pick up changes
lsnrctl stop
lsnrctl start

# Verify by checking listener log during next long-running plan:
tail -f $ORACLE_BASE/diag/tnslsnr/$(hostname)/listener/trace/listener.log
# Should NOT show "connection dropped by remote peer" entries
\`\`\`

### Step 5.4 — Fix Persistent Disk I/O Bottleneck

\`\`\`bash
# Measure current disk type and performance
lsblk -d -o NAME,TYPE,SIZE,ROTA
# ROTA=0 means SSD, ROTA=1 means HDD (pd-standard)

# During plan run, measure actual I/O
iostat -xm 2 20 | grep -E "Device|sdb"
# If %util > 70% and await > 5ms → storage bottleneck confirmed

# Upgrade disk to pd-ssd (GCE allows live type change with downtime)
# Step 1: Stop instance
gcloud compute instances stop ascp-db-01 --zone=us-east4-b

# Step 2: Change disk type
gcloud compute disks update oracle-data-disk \
  --zone=us-east4-b \
  --type=pd-ssd

# Step 3: Restart instance
gcloud compute instances start ascp-db-01 --zone=us-east4-b

# Step 4: Verify new disk throughput
dd if=/dev/sdb of=/dev/null bs=1M count=10240
# Expected for pd-ssd (100 GB): ~800 MB/s read
\`\`\`

---

## Phase 6: Monthly Operations Checklist

| Task | Command / Location | Target |
|------|-------------------|--------|
| Verify collection succeeded | FCR query for MSCSCH request | Status = C/Normal |
| Check MSC table growth | DBA_SEGMENTS for MSC tablespace | < 80% of allocated |
| Review plan exception count trend | MSC_EXCEPTION_DETAILS | Stable or decreasing |
| Verify sqlnet.expire_time set | grep expire $TNS_ADMIN/sqlnet.ora | = 10 |
| Check GCE disk I/O headroom | Cloud Monitoring → Disk I/O | < 60% utilization |
| Review ASCP concurrent program wait times | FCR query for MSCSCH duration | Within SLA |
| Verify RMAN backup on DB host | rman LIST BACKUP COMPLETED AFTER... | Last 24h = SUCCESS |`,
};

async function main() {
  console.log('Inserting Oracle ASCP on RHEL9 on Google Cloud runbook...');
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
