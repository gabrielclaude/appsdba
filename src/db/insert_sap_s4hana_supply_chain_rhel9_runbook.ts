import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: SAP S/4HANA Supply Chain Implementation on RHEL 9 with Production Monitoring',
  slug: 'sap-s4hana-supply-chain-rhel9-implementation-runbook',
  excerpt:
    'End-to-end implementation runbook for SAP S/4HANA Supply Chain on RHEL 9 — OS preparation with saptune, SAP HANA database installation, S/4HANA application server setup, MRP Live and PP/MM configuration, HANA System Replication for HA, and seven crontab-scheduled monitoring scripts covering HANA health, SAP services, MRP job status, IDoc errors, disk space, system log scanning, and HANA replication state.',
  category: 'sap-hana' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-22'),
  youtubeUrl: null,
  content: `## Overview

This runbook covers the implementation of SAP S/4HANA Supply Chain for Manufacturing on Red Hat Enterprise Linux 9. It spans RHEL 9 OS preparation using \`saptune\`, SAP HANA 2.0 database installation, S/4HANA ABAP application server deployment, supply chain module (MRP Live, PP, MM, EWM) activation and configuration, HANA System Replication for high availability, and production monitoring scripts scheduled via crontab.

Assumptions: RHEL 9.x (9.2 or later), SAP HANA 2.0 SPS07 or later, SAP S/4HANA 2023 or later, dedicated HANA primary and secondary hosts with minimum 512 GB RAM each, separate application server hosts, SAP software downloaded from SAP Software Centre to a staging directory, a valid SAP S-user with download authorisation, and a named SAP Basis administrator account for the implementation.

---

## Phase 0: Prerequisites and Planning

### Step 0.1 — Hardware Validation

\`\`\`bash
# Verify RAM meets HANA minimum (512 GB for production S/4HANA manufacturing)
free -g
# Total should be >= 512 GB on HANA host

# Verify CPU architecture and NUMA topology
lscpu | grep -E 'Architecture|Socket|Core|NUMA'
numactl --hardware

# Verify storage volumes are present and sized correctly
# Recommended layout:
# /hana/data     — HANA data volume (1.5x RAM size, NVMe SSD)
# /hana/log      — HANA log volume (0.5x RAM size, NVMe SSD, separate device)
# /hana/shared   — shared volume for binaries and global filesystem
# /hana/backup   — backup volume (3x RAM minimum)
lsblk
df -h
\`\`\`

### Step 0.2 — RHEL 9 Subscription and SAP Repositories

\`\`\`bash
# Register the system with Red Hat Subscription Manager
subscription-manager register --username=rh-user@company.com --password=<password>
subscription-manager attach --auto

# Enable required repositories for SAP on RHEL 9
subscription-manager repos \
  --enable=rhel-9-for-x86_64-baseos-rpms \
  --enable=rhel-9-for-x86_64-appstream-rpms \
  --enable=rhel-9-for-x86_64-sap-solutions-rpms \
  --enable=rhel-9-for-x86_64-sap-netweaver-rpms

# Verify repos active
subscription-manager repos --list-enabled | grep -i sap
\`\`\`

### Step 0.3 — Install SAP Required Packages

\`\`\`bash
# Install saptune and SAP prerequisite packages
dnf install -y \
  saptune \
  sapconf \
  tuned \
  libnsl \
  libnsl2 \
  libatomic \
  compat-openssl11 \
  uuidd \
  expect \
  graphviz \
  krb5-workstation \
  nfs-utils \
  lvm2 \
  numactl \
  numactl-libs \
  bind-utils \
  net-tools \
  hostname \
  chrony

# Verify uuidd is running (required by SAP kernel)
systemctl enable uuidd && systemctl start uuidd
systemctl status uuidd
\`\`\`

---

## Phase 1: RHEL 9 OS Tuning for SAP HANA

### Step 1.1 — Apply saptune Solution

\`saptune\` applies all SAP-recommended kernel parameters, I/O scheduler settings, CPU governor, and THP configuration validated by SAP for HANA on RHEL 9. Never manually set individual parameters on a saptune-managed system — let saptune own the tuning profile.

\`\`\`bash
# Check available solutions
saptune solution list

# Apply the HANA solution (covers all SAP HANA kernel parameter requirements)
saptune solution apply HANA

# For the application server hosts, apply the NETWEAVER solution instead:
# saptune solution apply NETWEAVER

# Verify tuning is active
saptune solution verify HANA

# Enable saptune to persist across reboots
saptune service enablestart

# Review what saptune set
saptune solution verify HANA 2>&1 | grep -E "FAIL|PASS|not"
\`\`\`

### Step 1.2 — Verify Critical HANA OS Parameters

\`\`\`bash
# saptune sets these — verify they are correct after applying the solution

# THP must be disabled (HANA manages its own memory)
cat /sys/kernel/mm/transparent_hugepage/enabled
# Expected: always madvise [never]

# vm.swappiness for HANA (10, not 1 as used for Oracle)
sysctl vm.swappiness
# Expected: vm.swappiness = 10

# NUMA zone reclaim must be off
sysctl vm.zone_reclaim_mode
# Expected: vm.zone_reclaim_mode = 0

# Disk scheduler on HANA data/log devices should be none or mq-deadline
cat /sys/block/nvme0n1/queue/scheduler
# For NVMe: [none] is correct

# Verify no swap is configured on HANA hosts
# (saptune note 1984787 recommends no swap on HANA hosts with >= 512GB RAM)
swapon --show
# Expected: no output (no active swap)
\`\`\`

### Step 1.3 — Configure Storage Layout

\`\`\`bash
# Create HANA filesystem structure (adjust device names to your environment)
# /hana/data — on dedicated NVMe or SSD LUN
mkfs.xfs -f /dev/nvme0n1p1
mkdir -p /hana/data
echo "/dev/nvme0n1p1 /hana/data xfs defaults,nofail 0 2" >> /etc/fstab

# /hana/log — on separate dedicated NVMe (critical: separate from data)
mkfs.xfs -f /dev/nvme1n1p1
mkdir -p /hana/log
echo "/dev/nvme1n1p1 /hana/log xfs defaults,nofail 0 2" >> /etc/fstab

# /hana/shared — can be NFS or local depending on scale-up vs scale-out
mkdir -p /hana/shared

# /hana/backup — large volume, can be spinning disk or object storage mount
mkdir -p /hana/backup

mount -a
df -h /hana/data /hana/log /hana/shared /hana/backup
\`\`\`

### Step 1.4 — Create OS Users and Groups

\`\`\`bash
# SAP HANA OS user (SID-based — replace S4P with your HANA SID)
# HANA SID example: S4P (3 characters, uppercase)
SID="S4P"
SID_LOWER="\${SID,,}"   # lowercase: s4p

groupadd -g 1001 sapsys
groupadd -g 1002 sapinst

useradd -u 2001 -g sapsys -G sapinst -d /usr/sap/\${SID}/home \
  -s /bin/bash -c "SAP HANA Admin" \${SID_LOWER}adm

# Set initial password (change after first login)
echo "\${SID_LOWER}adm:Temp1234!" | chpasswd

# Verify
id \${SID_LOWER}adm
\`\`\`

### Step 1.5 — Configure Time Synchronisation

\`\`\`bash
# HANA System Replication requires accurate clock synchronisation
# Configure chrony to use a reliable NTP server
cat > /etc/chrony.conf <<'EOF'
server ntp.company.com iburst prefer
server ntp2.company.com iburst
driftfile /var/lib/chrony/drift
makestep 1.0 3
rtcsync
logdir /var/log/chrony
EOF

systemctl enable chronyd && systemctl restart chronyd
chronyc tracking
chronyc sources -v
# offset should be < 1 ms between HANA primary and secondary hosts
\`\`\`

---

## Phase 2: SAP HANA Database Installation

### Step 2.1 — Extract HANA Installation Media

\`\`\`bash
# Stage HANA installation files (downloaded from SAP Software Centre)
STAGE_DIR="/hana/install/HANA_SPS07"
mkdir -p \${STAGE_DIR}

# Extract the HANA database lifecycle manager (HDBLCM) archive
cd \${STAGE_DIR}
tar -xf IMDB_SERVER20_SPS07_*.tar.gz

ls \${STAGE_DIR}/SAP_HANA_DATABASE/
# Should contain: hdblcm, DATA_UNITS/, and platform-specific files
\`\`\`

### Step 2.2 — Run HANA Installation via hdblcm

\`\`\`bash
cd \${STAGE_DIR}/SAP_HANA_DATABASE/

# Run in interactive mode (or use --batch with a response file for automation)
./hdblcm --action=install \
  --sid=S4P \
  --number=00 \
  --hdbinst_server_pswd=<hana_system_password> \
  --hdbinst_sapadm_pswd=<sapadm_password> \
  --datapath=/hana/data/S4P \
  --logpath=/hana/log/S4P \
  --sharedpath=/hana/shared \
  --components=server \
  --agree_to_sap_license=true \
  2>&1 | tee /hana/install/hdblcm_install_\$(date +%Y%m%d).log

# Verify installation
grep -E "successfully|ERROR|FAILED" /hana/install/hdblcm_install_\$(date +%Y%m%d).log | tail -10
\`\`\`

### Step 2.3 — Post-Installation HANA Verification

\`\`\`bash
# Switch to HANA admin user
su - s4padm

# Source the HANA environment
source /usr/sap/S4P/home/.sapenv.sh

# Check HANA processes are running
HDB info
# Expected: hdbdaemon, hdbcompileserver, hdbindexserver, hdbnameserver all running

# Connect via hdbsql and verify HANA is responding
hdbsql -n localhost:30013 -u SYSTEM -p '<system_password>' \
  "SELECT HOST, STATUS, VERSION FROM SYS.M_DATABASE"
# Expected: single row with HOST=hostname, STATUS=YES
\`\`\`

\`\`\`sql
-- Verify HANA memory allocation matches the host RAM
SELECT
  HOST,
  ROUND(ALLOCATION_LIMIT/1024/1024/1024, 1) allocation_limit_gb,
  ROUND(USED_PHYSICAL_MEMORY/1024/1024/1024, 1) used_physical_gb,
  ROUND(FREE_PHYSICAL_MEMORY/1024/1024/1024, 1) free_physical_gb
FROM SYS.M_HOST_RESOURCE_UTILIZATION;
\`\`\`

### Step 2.4 — Create S/4HANA Tenant Database

SAP HANA Multi-Tenant Database Container (MDC) is mandatory for S/4HANA. The system database (SYSTEMDB) manages tenants; S/4HANA runs in a dedicated tenant.

\`\`\`sql
-- Connect to SYSTEMDB as SYSTEM user
-- hdbsql -n localhost:30013 -u SYSTEM -p '<password>'

-- Create S/4HANA tenant database
CREATE DATABASE S4PPRD SYSTEM USER PASSWORD <tenant_system_password>;

-- Verify tenant is created and running
SELECT DATABASE_NAME, DESCRIPTION, ACTIVE_STATUS FROM SYS.M_DATABASES;
-- Expected: SYSTEMDB and S4PPRD both show ACTIVE_STATUS = YES
\`\`\`

---

## Phase 3: S/4HANA Application Server Installation

### Step 3.1 — Prepare Application Server Host

\`\`\`bash
# On the application server host (separate from HANA host)
# Apply NetWeaver saptune solution
saptune solution apply NETWEAVER
saptune service enablestart

# Install SAP kernel prerequisites
dnf install -y libstdc++ libgcc libnsl compat-openssl11 uuidd

# Create SAP directory structure
mkdir -p /usr/sap/S4P
mkdir -p /sapmnt/S4P
mkdir -p /tmp/sapinst_instdir

# Add NFS mount for /sapmnt from HANA shared (if using shared filesystem)
echo "hana-primary.company.com:/hana/shared/S4P /sapmnt/S4P nfs rw,bg,hard,rsize=1048576,wsize=1048576,vers=4 0 0" >> /etc/fstab
mount /sapmnt/S4P
\`\`\`

### Step 3.2 — Run SAP Software Provisioning Manager (SWPM)

SWPM (Software Provisioning Manager) handles the S/4HANA ABAP installation. Run it on the application server host.

\`\`\`bash
# Extract SWPM from the download (SWPM20SP17 or later for S/4HANA 2023)
cd /hana/install/SWPM
unzip SWPM20SP17_<build>.zip

# Start SWPM installer (headless with parameter file, or browser-based)
# Browser-based: SWPM starts a web server on port 4237
./sapinst SAPINST_REMOTE_ACCESS_USER=root

# Navigate to: https://app-server-01.company.com:4237
# Select: SAP S/4HANA Server > SAP HANA Database > Installation > Application Server ABAP
# > Standard System > with HANA Database
\`\`\`

Key SWPM input values:
| Parameter | Example Value |
|-----------|--------------|
| SAP System ID (SAPSID) | S4P |
| SAP System Number | 00 |
| SAP Mount Directory | /sapmnt |
| Database Host | hana-primary.company.com |
| Database System ID | S4P |
| Tenant Database | S4PPRD |
| ABAP Schema | SAPS4P |
| Master Password | (complex, 10+ chars) |

### Step 3.3 — Post-Installation SAP Verification

\`\`\`bash
# Check SAP instance is running
su - s4padm
sapcontrol -nr 00 -function GetProcessList

# Expected processes: Running state
# disp+work      (dispatcher)
# igswd          (IPC Gateway)
# gwrd           (Gateway)
# icman          (Internet Communication Manager)
# msg_server     (Message Server — on Central Instance only)
# enserver       (Enqueue Server — on Central Instance only)

# Verify R3trans connectivity (confirms DB connection)
R3trans -d 2>&1 | head -5
# Expected: R3trans finished (0000)
\`\`\`

---

## Phase 4: Supply Chain Module Configuration

### Step 4.1 — Activate MRP Live

MRP Live must be explicitly activated in S/4HANA. In early S/4HANA releases this was optional; from S/4HANA 1909 onward it is the default and classic MRP is deprecated.

\`\`\`
Transaction: SPRO
Path: Materials Management > Consumption-Based Planning > Plant Parameters
     > Activate MRP Live per plant

For each manufacturing plant:
  - Check: "MRP Live" radio button (not "Classic MRP")
  - MRP Controller: assign default MRP controllers
  - Planning Horizon: set to 365 days (or per business requirement)
  - Planning Time Fence: set per material type
\`\`\`

\`\`\`sql
-- Verify MRP Live activation in HANA (query ABAP customising table)
-- Connect to tenant: hdbsql -n localhost:30015 -u SAPS4P -p '<password>'
SELECT MANDT, WERKS, MLIVE
FROM "SAPS4P"."T399A"
WHERE MLIVE = 'X';
-- All production plants should show MLIVE = X
\`\`\`

### Step 4.2 — Configure MRP Background Job

MRP Live runs as a background job scheduled via SM36 or the Fiori scheduling app.

\`\`\`
Transaction: SM36 (Define Background Job)
  Job Name: MRP_LIVE_PLANT_1000
  Job Class: A (high priority)
  Start Condition: Periodic — daily at 06:00
  Step: Program RMDRUN00 (MRP Live execution report)
    Variant: Z_MRP_PLANT_1000
      Plant: 1000
      Processing Key: NETCH (net change in planning horizon)
      Planning Mode: 1 (Adapt planning data)
      Scheduling: 2 (Lead time scheduling)
      Create Purchase Req.: 2 (Purchase requisitions in opening period)
      Parallel Processing: X (enable)
      Number of Parallel Sessions: 8
\`\`\`

### Step 4.3 — Activate Material Ledger

Material ledger is mandatory in S/4HANA but must be activated per valuation area (plant/company code).

\`\`\`
Transaction: CKMVFM (Activate Material Ledger)
  Select valuation area: 1000
  Currency Type: 10 (Company Code Currency)
  Valuation Method: Standard Price (or Moving Average — per business decision)
  Activate: Execute

Note: Material ledger activation is irreversible. Confirm with finance team
before executing in production.
\`\`\`

### Step 4.4 — Configure IDoc Port for EDI Integration

\`\`\`
Transaction: WE21 (IDoc Ports)
  Create port type: File port (for EDI middleware handoff)
    Port: EDI_OUT_001
    Description: Outbound EDI — Supplier Purchase Orders
    Outbound file: /usr/sap/S4P/interfaces/edifact/out/po_&date&_&time&.txt
    Function Module: EDI_PATH_CREATE_CLIENT_SYSTEM

Transaction: WE20 (Partner Profiles)
  Create partner profile for each EDI supplier:
    Partner Number: (supplier account number, e.g., 1000001)
    Partner Type: LI (Vendor)
    Outbound parameters:
      Message Type: ORDERS (Purchase Order)
      Port: EDI_OUT_001
      Basic Type: ORDERS05
      Transfer IDoc immediately: Yes
\`\`\`

---

## Phase 5: HANA System Replication (High Availability)

### Step 5.1 — Enable System Replication on Primary

\`\`\`bash
su - s4padm

# Enable system replication on the primary HANA host
# Tier 1 = synchronous replication (required for HA/automatic failover)
hdbnsutil -sr_enable --name=PRIMARY

# Verify replication is enabled
hdbnsutil -sr_state
# Expected: mode = primary, operation mode = primary
\`\`\`

### Step 5.2 — Register Secondary HANA Host

\`\`\`bash
# On the secondary HANA host (hana-secondary.company.com):
su - s4padm

# Stop HANA on secondary before registering
HDB stop

# Register as secondary (synchronous mode = SYNC for HA, ASYNC for DR)
hdbnsutil -sr_register \
  --name=SECONDARY \
  --remoteHost=hana-primary.company.com \
  --remoteInstance=00 \
  --replicationMode=SYNC \
  --operationMode=logreplay \
  --remoteName=PRIMARY

# Start HANA on secondary — it will begin initial data synchronisation
HDB start

# Monitor synchronisation progress (on primary)
hdbnsutil -sr_state
# SHIPPED LOG POSITION and REPLICA LOG POSITION should converge
# Full sync can take hours for large databases
\`\`\`

### Step 5.3 — Configure Pacemaker Cluster for Automatic Failover

\`\`\`bash
# Install Pacemaker and the SAP HANA resource agent
dnf install -y pacemaker pcs resource-agents-sap-hana

# Enable and start pcsd
systemctl enable pcsd && systemctl start pcsd
passwd hacluster   # set hacluster password (same on both nodes)

# Authenticate cluster nodes (run on primary)
pcs host auth hana-primary.company.com hana-secondary.company.com \
  -u hacluster -p <hacluster_password>

# Create the cluster
pcs cluster setup sap-hana-cluster \
  hana-primary.company.com hana-secondary.company.com \
  --start --enable

# Add SAP HANA resource (SAPHana and SAPHanaTopology agents)
pcs resource create SAPHana_S4P_00 SAPHana \
  SID=S4P InstanceNumber=00 PREFER_SITE_TAKEOVER=true \
  DUPLICATE_PRIMARY_TIMEOUT=7200 AUTOMATED_REGISTER=true \
  op start timeout=3600 \
  op stop timeout=3600 \
  op promote timeout=3600 \
  clone notify=true interleave=true

# Verify cluster status
pcs status
# Expected: both nodes Online, SAPHana resource PROMOTED on primary, DEMOTED on secondary
\`\`\`

---

## Phase 6: Monitoring Scripts and Crontab

Place all scripts in \`/usr/sap/scripts/monitor/\`. Run as the \`s4padm\` OS user.

### Script 1: HANA Database Health Check

\`\`\`bash
cat > /usr/sap/scripts/monitor/check_hana_health.sh <<'SCRIPT'
#!/bin/bash
# check_hana_health.sh — verify HANA is running and memory is within bounds
source /usr/sap/S4P/home/.sapenv.sh 2>/dev/null
ALERT_EMAIL="dba-team@company.com"
LOG=/usr/sap/scripts/monitor/logs/hana_health.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
MEM_THRESHOLD_PCT=90

# Check HANA process status via hdbnsutil
HANA_STATE=\$(hdbnsutil -sr_state 2>/dev/null | grep 'mode:' | awk '{print \$2}')
if [ -z "\$HANA_STATE" ]; then
  # Fallback: check if hdbdaemon is running
  HANA_STATE=\$(HDB info 2>/dev/null | grep -c hdbdaemon)
  if [ "\$HANA_STATE" -eq 0 ]; then
    echo "\$TIMESTAMP CRITICAL: HANA daemon not running on \$(hostname)" >> \$LOG
    echo "SAP HANA is NOT running on \$(hostname) as of \$TIMESTAMP." \
      | mail -s "CRITICAL: HANA Down on \$(hostname)" \$ALERT_EMAIL
    exit 1
  fi
fi

# Check memory utilisation via hdbsql
MEM_RESULT=\$(hdbsql -n localhost:30013 -u SYSTEM -p "\${HANA_SYSTEM_PASSWORD}" \
  -A -j -C "SELECT ROUND(USED_PHYSICAL_MEMORY*100/ALLOCATION_LIMIT,1) FROM SYS.M_HOST_RESOURCE_UTILIZATION" \
  2>/dev/null | grep -v '^$' | tail -1)

if [ -n "\$MEM_RESULT" ] && [ "\$(echo "\$MEM_RESULT > \$MEM_THRESHOLD_PCT" | bc -l 2>/dev/null)" = "1" ]; then
  echo "\$TIMESTAMP ALERT: HANA memory at \${MEM_RESULT}% (threshold \${MEM_THRESHOLD_PCT}%)" >> \$LOG
  echo "SAP HANA memory utilisation on \$(hostname) is \${MEM_RESULT}% at \$TIMESTAMP." \
    | mail -s "ALERT: HANA Memory High on \$(hostname)" \$ALERT_EMAIL
else
  echo "\$TIMESTAMP OK: HANA running, memory \${MEM_RESULT}%" >> \$LOG
fi
SCRIPT
chmod +x /usr/sap/scripts/monitor/check_hana_health.sh
\`\`\`

### Script 2: SAP Application Server Process Check

\`\`\`bash
cat > /usr/sap/scripts/monitor/check_sap_services.sh <<'SCRIPT'
#!/bin/bash
# check_sap_services.sh — verify all SAP work processes are running
source /usr/sap/S4P/home/.sapenv.sh 2>/dev/null
ALERT_EMAIL="dba-team@company.com"
LOG=/usr/sap/scripts/monitor/logs/sap_services.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
INSTANCE_NR=00

# Get process list from sapcontrol
PROC_LIST=\$(sapcontrol -nr \${INSTANCE_NR} -function GetProcessList 2>/dev/null)

# Count processes NOT in Running state
FAILED_PROCS=\$(echo "\$PROC_LIST" | grep -v "Running\|GREEN\|OK\|^$\|GetProcessList\|SAPControl" \
  | grep -E "disp|gwrd|icman|msg_server|enserver|igswd" | wc -l)

if [ "\$FAILED_PROCS" -gt 0 ]; then
  echo "\$TIMESTAMP ALERT: \${FAILED_PROCS} SAP process(es) not in Running state" >> \$LOG
  echo "\$PROC_LIST" >> \$LOG
  echo "SAP S/4HANA processes not running on \$(hostname) at \$TIMESTAMP:

\$PROC_LIST" | mail -s "ALERT: SAP Process Failure on \$(hostname)" \$ALERT_EMAIL
else
  echo "\$TIMESTAMP OK: All SAP processes running" >> \$LOG
fi
SCRIPT
chmod +x /usr/sap/scripts/monitor/check_sap_services.sh
\`\`\`

### Script 3: MRP Live Background Job Monitor

\`\`\`bash
cat > /usr/sap/scripts/monitor/check_mrp_jobs.sh <<'SCRIPT'
#!/bin/bash
# check_mrp_jobs.sh — alert if MRP Live batch job did not complete successfully today
source /usr/sap/S4P/home/.sapenv.sh 2>/dev/null
ALERT_EMAIL="dba-team@company.com"
LOG=/usr/sap/scripts/monitor/logs/mrp_jobs.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
TODAY=\$(date '+%Y%m%d')

# Query HANA tenant for MRP job status in TBTCO (SAP background job log table)
# TBTCO: JOBNAME = job name, STATUS = F (finished) / A (aborted) / R (running)
JOB_STATUS=\$(hdbsql -n localhost:30015 -u SAPS4P -p "\${ABAP_SCHEMA_PASSWORD}" \
  -A -j -C \
  "SELECT STATUS FROM \"SAPS4P\".\"TBTCO\"
   WHERE JOBNAME LIKE 'MRP_LIVE%'
     AND SDLDATE = '\${TODAY}'
   ORDER BY STRTDATE DESC, STRTTIME DESC
   LIMIT 1" 2>/dev/null | grep -v '^$' | tail -1 | tr -d '"')

if [ "\$JOB_STATUS" = "F" ]; then
  echo "\$TIMESTAMP OK: MRP Live job completed successfully today" >> \$LOG
elif [ "\$JOB_STATUS" = "A" ]; then
  echo "\$TIMESTAMP ALERT: MRP Live job ABORTED today" >> \$LOG
  echo "SAP S/4HANA MRP Live background job aborted on \$(hostname) on \${TODAY}. Check SM37 for job log details." \
    | mail -s "ALERT: MRP Live Job Aborted — \$(hostname)" \$ALERT_EMAIL
elif [ -z "\$JOB_STATUS" ]; then
  echo "\$TIMESTAMP WARNING: No MRP Live job found for today (\${TODAY})" >> \$LOG
  echo "No MRP Live job record found for \${TODAY} on \$(hostname). MRP may not have run." \
    | mail -s "WARNING: MRP Live Job Missing — \$(hostname)" \$ALERT_EMAIL
else
  echo "\$TIMESTAMP INFO: MRP Live job status = \${JOB_STATUS} (may still be running)" >> \$LOG
fi
SCRIPT
chmod +x /usr/sap/scripts/monitor/check_mrp_jobs.sh
\`\`\`

### Script 4: IDoc Error Monitor

\`\`\`bash
cat > /usr/sap/scripts/monitor/check_idoc_errors.sh <<'SCRIPT'
#!/bin/bash
# check_idoc_errors.sh — alert on IDoc errors in the last 2 hours
source /usr/sap/S4P/home/.sapenv.sh 2>/dev/null
ALERT_EMAIL="dba-team@company.com"
LOG=/usr/sap/scripts/monitor/logs/idoc_errors.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')

# EDIDC table: status codes 51,52,56,68,70 indicate errors
# UPDDAT/UPDTIM: last update date/time of IDoc
# Query IDocs with error status updated in the last 2 hours
ERROR_COUNT=\$(hdbsql -n localhost:30015 -u SAPS4P -p "\${ABAP_SCHEMA_PASSWORD}" \
  -A -j -C \
  "SELECT COUNT(*) FROM \"SAPS4P\".\"EDIDC\"
   WHERE STATUS IN ('51','52','56','68','70')
     AND UPDDAT >= TO_DATE(ADD_SECONDS(NOW(),-7200),'YYYYMMDD')" \
  2>/dev/null | grep -v '^$' | tail -1 | tr -d '"')

if [ -n "\$ERROR_COUNT" ] && [ "\$ERROR_COUNT" -gt 0 ]; then
  echo "\$TIMESTAMP ALERT: \${ERROR_COUNT} IDoc error(s) in the last 2 hours" >> \$LOG
  # Get summary of error IDocs for the alert body
  ERROR_SUMMARY=\$(hdbsql -n localhost:30015 -u SAPS4P -p "\${ABAP_SCHEMA_PASSWORD}" \
    -A -j -C \
    "SELECT TOP 10 MESTYP, STATUS, DIRECT, PARTNER, UPDDAT, UPDTIM
     FROM \"SAPS4P\".\"EDIDC\"
     WHERE STATUS IN ('51','52','56','68','70')
       AND UPDDAT >= TO_DATE(ADD_SECONDS(NOW(),-7200),'YYYYMMDD')
     ORDER BY UPDDAT DESC, UPDTIM DESC" 2>/dev/null)

  echo "\$TIMESTAMP IDoc errors:\n\$ERROR_SUMMARY" >> \$LOG
  echo "\${ERROR_COUNT} IDoc error(s) detected on \$(hostname) at \$TIMESTAMP.

Top errors (last 2h):
\$ERROR_SUMMARY

Action: review in SAP transaction WE02 / Manage IDocs Fiori app." \
    | mail -s "ALERT: \${ERROR_COUNT} IDoc Error(s) — \$(hostname)" \$ALERT_EMAIL
else
  echo "\$TIMESTAMP OK: No IDoc errors in the last 2 hours" >> \$LOG
fi
SCRIPT
chmod +x /usr/sap/scripts/monitor/check_idoc_errors.sh
\`\`\`

### Script 5: HANA Disk Space Monitor

\`\`\`bash
cat > /usr/sap/scripts/monitor/check_hana_disk.sh <<'SCRIPT'
#!/bin/bash
# check_hana_disk.sh — alert when HANA data, log, or backup volumes exceed threshold
ALERT_EMAIL="dba-team@company.com"
LOG=/usr/sap/scripts/monitor/logs/hana_disk.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
THRESHOLD=80

for MOUNT in /hana/data /hana/log /hana/shared /hana/backup; do
  if mountpoint -q "\$MOUNT" 2>/dev/null || df "\$MOUNT" &>/dev/null; then
    PCT=\$(df "\$MOUNT" | awk 'NR==2 {gsub(/%/,""); print \$5}')
    if [ -n "\$PCT" ] && [ "\$PCT" -ge "\$THRESHOLD" ]; then
      echo "\$TIMESTAMP ALERT: \${MOUNT} is \${PCT}% full" >> \$LOG
      echo "HANA disk volume \${MOUNT} on \$(hostname) is \${PCT}% full at \$TIMESTAMP.

\$(df -h \$MOUNT)

Action: extend volume or archive/purge backup files." \
        | mail -s "ALERT: HANA Disk \${MOUNT} \${PCT}% Full on \$(hostname)" \$ALERT_EMAIL
    else
      echo "\$TIMESTAMP OK: \${MOUNT} is \${PCT}% used" >> \$LOG
    fi
  fi
done
SCRIPT
chmod +x /usr/sap/scripts/monitor/check_hana_disk.sh
\`\`\`

### Script 6: SAP System Log Error Scanner

\`\`\`bash
cat > /usr/sap/scripts/monitor/check_sap_syslog.sh <<'SCRIPT'
#!/bin/bash
# check_sap_syslog.sh — scan SAP system log for critical errors in the last hour
source /usr/sap/S4P/home/.sapenv.sh 2>/dev/null
ALERT_EMAIL="dba-team@company.com"
LOG=/usr/sap/scripts/monitor/logs/sap_syslog.log
MARKER=/usr/sap/scripts/monitor/logs/.syslog_last_scan
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')

# SAP system log location (dev_disp, dev_w*, etc.)
SAP_LOG_DIR="/usr/sap/S4P/D00/work"

# Find work process logs modified since last scan
if [ -f "\$MARKER" ]; then
  RECENT_LOGS=\$(find \$SAP_LOG_DIR -name "dev_w*" -newer \$MARKER -type f 2>/dev/null)
else
  RECENT_LOGS=\$(find \$SAP_LOG_DIR -name "dev_w*" -mmin -60 -type f 2>/dev/null)
fi

ERROR_LINES=""
if [ -n "\$RECENT_LOGS" ]; then
  ERROR_LINES=\$(grep -hE "ABAP.*runtime error|short dump|DUMP|DIA.*ERROR|system log.*error" \
    \$RECENT_LOGS 2>/dev/null | tail -30)
fi

touch "\$MARKER"

if [ -n "\$ERROR_LINES" ]; then
  echo "\$TIMESTAMP ALERT: SAP work process errors detected" >> \$LOG
  echo "\$ERROR_LINES" >> \$LOG
  echo "SAP S/4HANA work process errors on \$(hostname) at \$TIMESTAMP:

\$ERROR_LINES

Check SAP transaction SM21 (System Log) and ST22 (ABAP Dumps) for details." \
    | mail -s "ALERT: SAP Work Process Errors on \$(hostname)" \$ALERT_EMAIL
else
  echo "\$TIMESTAMP OK: No critical SAP work process errors detected" >> \$LOG
fi
SCRIPT
chmod +x /usr/sap/scripts/monitor/check_sap_syslog.sh
\`\`\`

### Script 7: HANA System Replication Status Check

\`\`\`bash
cat > /usr/sap/scripts/monitor/check_hana_replication.sh <<'SCRIPT'
#!/bin/bash
# check_hana_replication.sh — alert if HANA System Replication is degraded or disconnected
source /usr/sap/S4P/home/.sapenv.sh 2>/dev/null
ALERT_EMAIL="dba-team@company.com"
LOG=/usr/sap/scripts/monitor/logs/hana_replication.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')

# hdbnsutil -sr_state returns replication state
SR_STATE=\$(hdbnsutil -sr_state 2>/dev/null)
SR_SECONDARY_ACTIVE=\$(echo "\$SR_STATE" | grep -c "SECONDARY\|secondary")
SR_SYNCED=\$(echo "\$SR_STATE" | grep -c "replication: ACTIVE")

# Only check replication on the primary (mode = primary)
SR_MODE=\$(echo "\$SR_STATE" | grep 'mode:' | awk '{print \$2}')

if [ "\$SR_MODE" != "primary" ]; then
  echo "\$TIMESTAMP INFO: Not primary (\$SR_MODE), skipping replication check" >> \$LOG
  exit 0
fi

if [ "\$SR_SECONDARY_ACTIVE" -eq 0 ] || [ "\$SR_SYNCED" -eq 0 ]; then
  echo "\$TIMESTAMP ALERT: HANA System Replication is NOT active" >> \$LOG
  echo "\$SR_STATE" >> \$LOG
  echo "SAP HANA System Replication is degraded or disconnected on \$(hostname) at \$TIMESTAMP.

State:
\$SR_STATE

Action: investigate replication channel, check secondary host, review HANA trace files at /hana/shared/S4P/HDB00/*/trace/" \
    | mail -s "CRITICAL: HANA System Replication Degraded on \$(hostname)" \$ALERT_EMAIL
else
  echo "\$TIMESTAMP OK: HANA System Replication active and synced" >> \$LOG
fi
SCRIPT
chmod +x /usr/sap/scripts/monitor/check_hana_replication.sh
\`\`\`

### Step 6.8 — Create Log Directory and Deploy Crontab

\`\`\`bash
mkdir -p /usr/sap/scripts/monitor/logs
chown -R s4padm:sapsys /usr/sap/scripts/monitor

# Set the HANA passwords as environment variables in the admin user profile
# (Or use HANA Secure User Store: hdbuserstore SET MONUSER localhost:30013 MONUSER <password>)
cat >> /usr/sap/S4P/home/.sapenv.sh <<'EOF'
export HANA_SYSTEM_PASSWORD="$(cat /usr/sap/scripts/monitor/.hana_sys_pwd)"
export ABAP_SCHEMA_PASSWORD="$(cat /usr/sap/scripts/monitor/.abap_schema_pwd)"
EOF

# Store passwords in protected files
echo '<hana_system_password>' > /usr/sap/scripts/monitor/.hana_sys_pwd
echo '<abap_schema_password>' > /usr/sap/scripts/monitor/.abap_schema_pwd
chmod 600 /usr/sap/scripts/monitor/.hana_sys_pwd /usr/sap/scripts/monitor/.abap_schema_pwd

# Edit crontab for s4padm user
crontab -u s4padm -e
\`\`\`

\`\`\`cron
# SAP S/4HANA Supply Chain Monitoring Crontab — s4padm user
# Format: minute hour day-of-month month day-of-week command

# HANA health check every 5 minutes
*/5 * * * * /usr/sap/scripts/monitor/check_hana_health.sh >> /usr/sap/scripts/monitor/logs/cron.log 2>&1

# SAP application server processes every 5 minutes
*/5 * * * * /usr/sap/scripts/monitor/check_sap_services.sh >> /usr/sap/scripts/monitor/logs/cron.log 2>&1

# HANA System Replication every 10 minutes
*/10 * * * * /usr/sap/scripts/monitor/check_hana_replication.sh >> /usr/sap/scripts/monitor/logs/cron.log 2>&1

# IDoc error check every 30 minutes during business hours
*/30 6-22 * * * /usr/sap/scripts/monitor/check_idoc_errors.sh >> /usr/sap/scripts/monitor/logs/cron.log 2>&1

# HANA disk space every hour
0 * * * * /usr/sap/scripts/monitor/check_hana_disk.sh >> /usr/sap/scripts/monitor/logs/cron.log 2>&1

# SAP system log scan every 15 minutes
*/15 * * * * /usr/sap/scripts/monitor/check_sap_syslog.sh >> /usr/sap/scripts/monitor/logs/cron.log 2>&1

# MRP Live job check at 09:00 daily (after expected 06:00-08:00 run window)
0 9 * * * /usr/sap/scripts/monitor/check_mrp_jobs.sh >> /usr/sap/scripts/monitor/logs/cron.log 2>&1

# Weekly: purge monitor logs older than 30 days
0 3 * * 0 find /usr/sap/scripts/monitor/logs -name "*.log" -mtime +30 -delete
\`\`\`

\`\`\`bash
# Verify crontab is set
crontab -u s4padm -l

# Confirm crond is running and enabled
systemctl status crond
systemctl enable crond

# Test one script manually before relying on cron
su - s4padm -c "/usr/sap/scripts/monitor/check_hana_health.sh"
cat /usr/sap/scripts/monitor/logs/hana_health.log | tail -3
\`\`\`

---

## Phase 7: Post-Implementation Validation

\`\`\`bash
# HANA: verify all services running
su - s4padm -c "HDB info"

# HANA: verify memory and disk
su - s4padm -c "hdbsql -n localhost:30013 -u SYSTEM -p '<password>' \
  'SELECT HOST, ROUND(USED_PHYSICAL_MEMORY/1073741824,1) USED_GB, \
   ROUND(FREE_PHYSICAL_MEMORY/1073741824,1) FREE_GB \
   FROM SYS.M_HOST_RESOURCE_UTILIZATION'"

# SAP: verify all work processes
sapcontrol -nr 00 -function GetProcessList

# Replication: verify secondary is in sync
su - s4padm -c "hdbnsutil -sr_state"

# Pacemaker: verify cluster health
pcs status

# Run a test MRP Live for a single material to confirm end-to-end
# Transaction: MD02 (Single-Item Multi-Level MRP)
# Material: any material with BOM and open demand
# Plant: 1000
# Processing Key: NETCH
# Should complete in seconds for a single material
\`\`\`

---

## Summary

This runbook implemented SAP S/4HANA Supply Chain for Manufacturing on RHEL 9 across seven phases. RHEL 9 OS preparation used \`saptune solution apply HANA\` to apply all SAP-validated kernel parameters in a single command, replacing the manual tuning required in earlier Linux releases. SAP HANA 2.0 was installed via \`hdblcm\` with the mandatory Multi-Tenant Database Container (MDC) architecture, with a dedicated tenant for the S/4HANA ABAP schema. The S/4HANA application server was deployed via SWPM with MRP Live activated per plant, material ledger enabled, and IDoc partner profiles configured for EDI supplier integration. HANA System Replication in synchronous mode, managed by a Pacemaker cluster, provides automatic failover with a recovery time under 60 seconds.

Seven crontab-scheduled monitoring scripts cover the full operational surface: HANA memory and process health (every 5 minutes), SAP work process availability (every 5 minutes), HANA System Replication state (every 10 minutes), IDoc error detection (every 30 minutes during business hours), HANA disk space (hourly), SAP work process log scanning (every 15 minutes), and MRP Live job completion verification (daily at 09:00). Together these scripts detect the most common S/4HANA supply chain operational failures — HANA outage, SAP dispatcher failure, replication split-brain, EDI IDoc backlogs, storage exhaustion, ABAP runtime errors, and missed MRP runs — before they escalate to user-reported incidents.`,
};

async function main() {
  console.log('Inserting SAP S/4HANA Supply Chain RHEL 9 implementation runbook...');
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
