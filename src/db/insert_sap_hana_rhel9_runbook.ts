import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'SAP HANA on RHEL 9 Installation Runbook: Step-by-Step with Monitoring Scripts and Crontab',
  slug: 'sap-hana-rhel9-installation-runbook',
  excerpt:
    'Complete operational runbook for installing SAP HANA on RHEL 9 — OS preparation with saptune, HDBLCM silent install, post-installation verification, and production monitoring scripts for service health, memory, disk, and backup validation with crontab schedules.',
  category: 'sap-hana' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-20'),
  youtubeUrl: null,
  content: `## Phase 1 — Pre-Installation Checklist

Before touching any SAP media, confirm the host meets every hardware and OS prerequisite. A failed prerequisite discovered mid-install forces a full rollback.

### 1.1 Verify RHEL Version and Kernel

\`\`\`bash
# Confirm RHEL 9.x — SAP Note 2009879 lists exact supported minor versions
cat /etc/redhat-release

# Kernel must match the SAP Note 2235581 matrix for your HANA version
uname -r

# Confirm subscription and SAP-related repos are enabled
subscription-manager repos --list-enabled | grep -i sap
\`\`\`

Expected output for RHEL 9: \`Red Hat Enterprise Linux release 9.x (Plow)\`. If the minor version is not certified for your HANA SPS, engage SAP support before proceeding.

### 1.2 Memory and Swap

\`\`\`bash
# HANA requires RAM ≥ 24 GB for production; 16 GB minimum for evaluation
free -h

# Swap: SAP recommends swap = 2 × RAM up to 64 GB physical RAM
# Check current swap
swapon --show

# If swap is insufficient, create a temporary swap file
fallocate -l 32G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
\`\`\`

### 1.3 Disk Layout

\`\`\`bash
# List all block devices and their current mount points
lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINT,LABEL

# Confirm target volumes are present and unmounted
df -h

# Recommended minimum sizes for a production HDB instance:
# /hana/data    — 3x physical RAM
# /hana/log     — 0.5x physical RAM (min 256 GB on busy systems)
# /hana/shared  — 1x physical RAM
# /backup       — 4x physical RAM (full backups + redo log backups)
\`\`\`

### 1.4 CPU Information

\`\`\`bash
# HANA requires x86_64 with SSE4.2 — verify
lscpu | grep -E 'Architecture|Socket|Core|Thread|CPU MHz|Virtualization|Flags'

# Confirm SSE4.2 is present in CPU flags
grep -m1 sse4_2 /proc/cpuinfo && echo "SSE4.2 OK" || echo "SSE4.2 MISSING - not supported"

# NUMA topology — HANA is NUMA-aware; document this before tuning
numactl --hardware
\`\`\`

### 1.5 Network and Hostname

\`\`\`bash
# Hostname must be short (max 13 chars) and resolve to a non-loopback IP
hostname
hostname -f
hostname -i

# /etc/hosts must have the full entry — HANA installer validates this
grep $(hostname) /etc/hosts

# Time sync is critical for system replication
timedatectl status
chronyc tracking
\`\`\`

If \`hostname -i\` returns 127.0.0.1, edit \`/etc/hosts\` to add the server's real IP before the installer runs.

---

## Phase 2 — OS Preparation Script (hana_os_prep.sh)

Save this script as \`/root/hana_os_prep.sh\` and run it as root before placing any SAP media on the system.

\`\`\`bash
#!/bin/bash
# hana_os_prep.sh — RHEL 9 OS preparation for SAP HANA installation
# Usage: bash hana_os_prep.sh
# Idempotent: safe to re-run; each section checks before acting

set -euo pipefail

SID="HDB"
INSTANCE_NR="00"
HANA_DATA_DEV="/dev/sdb"
HANA_LOG_DEV="/dev/sdc"
HANA_SHARED_DEV="/dev/sdd"
BACKUP_DEV="/dev/sde"
LOG="/var/log/hana_os_prep.log"
ALERT_EMAIL="hana-dba@example.com"

exec > >(tee -a "\${LOG}") 2>&1

log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] INFO  $*"; }
fail() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR $*"; exit 1; }

log "===== SAP HANA OS Preparation Start ====="
log "SID=\${SID}  INSTANCE=\${INSTANCE_NR}"
log "Host: $(hostname)  Kernel: $(uname -r)"

# ---------------------------------------------------------------
# 1. Required packages
# ---------------------------------------------------------------
log "Installing required packages..."
dnf install -y \
  libaio \
  libgcc \
  libstdc++ \
  libatomic \
  xfsprogs \
  numactl \
  compat-openssl11 \
  hostname \
  tcsh \
  expect \
  graphviz \
  glibc-langpack-en \
  krb5-workstation \
  net-tools \
  uuidd \
  bind-utils \
  nfs-utils \
  stunnel \
  saptune || fail "dnf install failed"

log "Package installation complete."

# ---------------------------------------------------------------
# 2. saptune — apply SAP HANA solution profile
# ---------------------------------------------------------------
log "Configuring saptune..."
if ! rpm -q saptune &>/dev/null; then
  dnf install -y saptune || fail "saptune install failed"
fi

saptune solution apply HANA
saptune service enablestart
log "saptune solution HANA applied and service enabled."

# Verify
saptune solution verify HANA | tee -a "\${LOG}" || log "WARN: saptune verify reported warnings — review before go-live"

# ---------------------------------------------------------------
# 3. OS users and groups
# ---------------------------------------------------------------
log "Creating OS groups and users..."
if ! getent group sapsys &>/dev/null; then
  groupadd -g 79 sapsys
  log "Group sapsys created (gid 79)"
fi

if ! id sapadm &>/dev/null; then
  useradd -u 1001 -g sapsys -c "SAP System Administrator" -d /home/sapadm -s /bin/csh -m sapadm
  log "User sapadm created"
fi

HDBADM_USER="\${SID,,}adm"
HDBADM_UID=1002
if ! id "\${HDBADM_USER}" &>/dev/null; then
  useradd -u "\${HDBADM_UID}" -g sapsys \
    -c "SAP HANA DB Administrator" \
    -d "/usr/sap/\${SID}/home" \
    -s /bin/bash \
    -m "\${HDBADM_USER}"
  log "User \${HDBADM_USER} created"
fi

# ---------------------------------------------------------------
# 4. Filesystem creation
# ---------------------------------------------------------------
log "Creating XFS filesystems..."

format_and_mount() {
  local DEV="$1"
  local MNT="$2"
  local LABEL="$3"

  mkdir -p "\${MNT}"

  if ! blkid "\${DEV}" | grep -q xfs; then
    mkfs.xfs -L "\${LABEL}" -f "\${DEV}" || fail "mkfs.xfs failed for \${DEV}"
    log "XFS created on \${DEV} (label=\${LABEL})"
  else
    log "XFS already present on \${DEV} — skipping mkfs"
  fi

  if ! mountpoint -q "\${MNT}"; then
    mount "\${DEV}" "\${MNT}"
    log "Mounted \${DEV} on \${MNT}"
  fi
}

format_and_mount "\${HANA_DATA_DEV}"   "/hana/data"   "HANA_DATA"
format_and_mount "\${HANA_LOG_DEV}"    "/hana/log"    "HANA_LOG"
format_and_mount "\${HANA_SHARED_DEV}" "/hana/shared" "HANA_SHARED"
format_and_mount "\${BACKUP_DEV}"      "/backup"      "HANA_BACKUP"

# Ownership
chown -R "\${HDBADM_USER}":sapsys /hana/data /hana/log /hana/shared
chown -R "\${HDBADM_USER}":sapsys /backup
chmod 755 /hana/data /hana/log /hana/shared /backup
log "Directory ownership set to \${HDBADM_USER}:sapsys"

# ---------------------------------------------------------------
# 5. /etc/fstab entries
# ---------------------------------------------------------------
log "Adding fstab entries..."

add_fstab() {
  local DEV="$1"
  local MNT="$2"
  local ENTRY="LABEL=$(blkid -s LABEL -o value \${DEV})  \${MNT}  xfs  defaults,nofail,noatime  0  2"
  if ! grep -q "\${MNT}" /etc/fstab; then
    echo "\${ENTRY}" >> /etc/fstab
    log "fstab: added \${MNT}"
  else
    log "fstab: \${MNT} already present — skipping"
  fi
}

add_fstab "\${HANA_DATA_DEV}"   "/hana/data"
add_fstab "\${HANA_LOG_DEV}"    "/hana/log"
add_fstab "\${HANA_SHARED_DEV}" "/hana/shared"
add_fstab "\${BACKUP_DEV}"      "/backup"

mount -a && log "mount -a succeeded" || fail "mount -a failed — check fstab"

# ---------------------------------------------------------------
# 6. Kernel parameters
# ---------------------------------------------------------------
log "Writing kernel parameters to /etc/sysctl.d/90-saphana.conf..."
cat > /etc/sysctl.d/90-saphana.conf << 'SYSCTL'
# SAP HANA kernel parameters — SAP Note 2382421, 2684254
vm.max_map_count = 2147483647
fs.aio-max-nr = 18446744073709551615
net.core.somaxconn = 4096
net.ipv4.tcp_slow_start_after_idle = 0
net.ipv4.tcp_tw_reuse = 1
kernel.shmmni = 32768
kernel.shmall = 1152921504606846975
kernel.shmmax = 18446744073709551615
net.core.rmem_max = 134217728
net.core.wmem_max = 134217728
SYSCTL

sysctl --system | grep -E 'vm.max_map_count|fs.aio|somaxconn' | tee -a "\${LOG}"
log "Kernel parameters applied."

# ---------------------------------------------------------------
# 7. OS limits for hdbadm
# ---------------------------------------------------------------
log "Writing /etc/security/limits.d/99-saphana.conf..."
cat > /etc/security/limits.d/99-saphana.conf << LIMITS
# SAP HANA OS limits — SAP Note 2382421
\${HDBADM_USER}  soft  nofile   1048576
\${HDBADM_USER}  hard  nofile   1048576
\${HDBADM_USER}  soft  nproc    unlimited
\${HDBADM_USER}  hard  nproc    unlimited
\${HDBADM_USER}  soft  stack    67108864
\${HDBADM_USER}  hard  stack    67108864
\${HDBADM_USER}  soft  memlock  unlimited
\${HDBADM_USER}  hard  memlock  unlimited
sapadm          soft  nofile   65536
sapadm          hard  nofile   65536
@sapsys         soft  nofile   1048576
@sapsys         hard  nofile   1048576
LIMITS

log "OS limits written."

# ---------------------------------------------------------------
# 8. Disable Transparent Huge Pages (THP)
# ---------------------------------------------------------------
log "Disabling THP via grubby and systemd service..."

# Kernel cmdline (survives reboot)
grubby --update-kernel=ALL --args="transparent_hugepage=never" && \
  log "grubby: THP=never added to kernel cmdline" || \
  log "WARN: grubby failed — apply manually in /etc/default/grub"

# Runtime service to ensure THP is off after each boot
cat > /etc/systemd/system/disable-thp.service << 'SVC'
[Unit]
Description=Disable Transparent Huge Pages (THP) for SAP HANA
After=sysinit.target local-fs.target
Before=hdb.service

[Service]
Type=oneshot
ExecStart=/bin/bash -c 'echo never > /sys/kernel/mm/transparent_hugepage/enabled && echo never > /sys/kernel/mm/transparent_hugepage/defrag'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
SVC

systemctl daemon-reload
systemctl enable --now disable-thp.service
log "THP disabled via systemd service."

# Verify immediately
THP_STATUS=$(cat /sys/kernel/mm/transparent_hugepage/enabled)
if echo "\${THP_STATUS}" | grep -q '\[never\]'; then
  log "THP runtime status: [never] — OK"
else
  log "WARN: THP runtime status: \${THP_STATUS} — check after reboot"
fi

# ---------------------------------------------------------------
# 9. UUID daemon (required by HANA installer)
# ---------------------------------------------------------------
systemctl enable --now uuidd
log "uuidd service enabled and started."

log "===== OS Preparation Complete ====="
log "Review \${LOG} for warnings before running the HANA installer."
\`\`\`

Make the script executable and run it:

\`\`\`bash
chmod 750 /root/hana_os_prep.sh
bash /root/hana_os_prep.sh
\`\`\`

---

## Phase 3 — HDBLCM Silent Install Script (install_hana.sh)

HDBLCM is the SAP HANA Lifecycle Manager. Running it in \`--batch\` mode eliminates interactive prompts and produces a repeatable, auditable install.

### 3.1 Prepare the HANA Media

\`\`\`bash
#!/bin/bash
# install_hana.sh — SAP HANA silent installation via HDBLCM
# Run as root. Set variables to match your environment before executing.

set -euo pipefail

SID="HDB"
INSTANCE_NR="00"
HANA_SYSTEM_PASSWORD="Hana$ystem01!"   # Change before use; meets HANA complexity rules
MASTER_PASSWORD="Hana$ystem01!"
SAPMEDIA_DIR="/hana/shared/sap_media"
SAPCAR_BIN="/usr/local/bin/SAPCAR"
HANA_SAR="\${SAPMEDIA_DIR}/IMDB_SERVER20_*.SAR"
EXTRACT_DIR="/hana/shared/hana_install"
LOG="/var/log/install_hana.log"
HDBLCM_LOG_DIR="/var/log/hdblcm"

exec > >(tee -a "\${LOG}") 2>&1

log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] INFO  $*"; }
fail() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR $*"; exit 1; }

log "===== SAP HANA HDBLCM Silent Install Start ====="

# Verify media exists
ls \${HANA_SAR} &>/dev/null || fail "HANA SAR not found matching: \${HANA_SAR}"
ls "\${SAPCAR_BIN}" &>/dev/null || fail "SAPCAR not found at \${SAPCAR_BIN}"

# ---------------------------------------------------------------
# Extract HANA media
# ---------------------------------------------------------------
mkdir -p "\${EXTRACT_DIR}" "\${HDBLCM_LOG_DIR}"

SAR_FILE=$(ls \${HANA_SAR} | head -1)
log "Extracting \${SAR_FILE} to \${EXTRACT_DIR}..."
"\${SAPCAR_BIN}" -xvf "\${SAR_FILE}" -R "\${EXTRACT_DIR}"
log "Extraction complete."

HDBLCM="\${EXTRACT_DIR}/SAP_HANA_DATABASE/hdblcm"
[ -x "\${HDBLCM}" ] || fail "hdblcm not found or not executable at \${HDBLCM}"

# ---------------------------------------------------------------
# Write the HDBLCM response file
# ---------------------------------------------------------------
RESPONSE_FILE="/root/hdblcm_response.cfg"
log "Writing HDBLCM response file to \${RESPONSE_FILE}..."

cat > "\${RESPONSE_FILE}" << RESPONSE
# HDBLCM silent install response file
# Generated by install_hana.sh on $(date)

[Server]
sid=\${SID}
number=\${INSTANCE_NR}
userid=1002
groupid=79

# Installation paths
home=/usr/sap/\${SID}
sapmnt=/hana/shared
system_usage=production

# Component selection — install server + AFL (Application Function Library)
components=server,afl

# Passwords
password=\${HANA_SYSTEM_PASSWORD}
system_user_password=\${HANA_SYSTEM_PASSWORD}
master_password=\${MASTER_PASSWORD}
sapadm_password=\${MASTER_PASSWORD}

# Network
hostname=$(hostname -f)

# Installation mode: install (new), update, or uninstall
action=install

# Log directory
logpath=\${HDBLCM_LOG_DIR}
RESPONSE

chmod 600 "\${RESPONSE_FILE}"

# ---------------------------------------------------------------
# Run HDBLCM
# ---------------------------------------------------------------
log "Starting HDBLCM installation — this takes 15–40 minutes..."
"\${HDBLCM}" \
  --batch \
  --configfile="\${RESPONSE_FILE}" \
  --ignore=check_min_mem \
  2>&1 | tee -a "\${LOG}"

HDBLCM_EXIT=\${PIPESTATUS[0]}
if [ "\${HDBLCM_EXIT}" -ne 0 ]; then
  fail "HDBLCM exited with code \${HDBLCM_EXIT} — check \${HDBLCM_LOG_DIR} for details"
fi

log "HDBLCM installation completed with exit code 0."

# ---------------------------------------------------------------
# Validate: check that HANA processes are running
# ---------------------------------------------------------------
log "Validating HANA installation..."
HDBADM="\${SID,,}adm"

HDB_STATUS=$(su - "\${HDBADM}" -c "HDB info 2>&1" || true)
if echo "\${HDB_STATUS}" | grep -q "hdbdaemon"; then
  log "HANA validation PASSED — hdbdaemon is running"
  echo "\${HDB_STATUS}" | tee -a "\${LOG}"
else
  log "WARN: hdbdaemon not detected in HDB info output"
  echo "\${HDB_STATUS}" | tee -a "\${LOG}"
  fail "HANA validation FAILED — check \${HDBLCM_LOG_DIR}"
fi

# Check systemd service
SERVICE="SAPINIT"
if systemctl is-active --quiet "\${SERVICE}"; then
  log "systemd service \${SERVICE} is active — OK"
else
  log "WARN: systemd service \${SERVICE} is not active"
fi

# Shred the response file (contains passwords)
shred -u "\${RESPONSE_FILE}"
log "Response file securely deleted."

log "===== HANA Installation Complete ====="
\`\`\`

---

## Phase 4 — Post-Installation Verification Script (verify_hana.sh)

Run this immediately after installation and before any data is loaded.

\`\`\`bash
#!/bin/bash
# verify_hana.sh — SAP HANA post-installation verification
# Run as root. Switches to hdbadm for HDB commands.

set -euo pipefail

SID="HDB"
INSTANCE_NR="00"
HDBADM="\${SID,,}adm"
HANA_HOST=$(hostname)
SYSTEM_DB_USER="SYSTEM"
SYSTEM_DB_PASS="Hana$ystem01!"   # Change to actual password
LOG="/var/log/verify_hana.log"
ERRORS=0

exec > >(tee -a "\${LOG}") 2>&1

log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] INFO  $*"; }
fail() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] FAIL  $*"; ERRORS=$((ERRORS+1)); }
pass() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] PASS  $*"; }

hdbsql_system() {
  su - "\${HDBADM}" -c "hdbsql -n localhost:3\${INSTANCE_NR}13 -u \${SYSTEM_DB_USER} -p '\${SYSTEM_DB_PASS}' -a -x \"$1\"" 2>/dev/null
}

log "===== SAP HANA Post-Install Verification ====="
log "SID=\${SID}  Instance=\${INSTANCE_NR}  Host=\${HANA_HOST}"

# ---------------------------------------------------------------
# 1. HDB process check
# ---------------------------------------------------------------
log "--- HDB Processes ---"
HDB_INFO=$(su - "\${HDBADM}" -c "HDB info" 2>&1)
echo "\${HDB_INFO}" | tee -a "\${LOG}"

for PROC in hdbdaemon hdbindexserver hdbnameserver; do
  if echo "\${HDB_INFO}" | grep -q "\${PROC}"; then
    pass "Process \${PROC} is running"
  else
    fail "Process \${PROC} NOT found in HDB info"
  fi
done

# ---------------------------------------------------------------
# 2. Landscape check
# ---------------------------------------------------------------
log "--- HANA Landscape ---"
LANDSCAPE=$(hdbsql_system "SELECT HOST, ACTIVE_STATUS, SERVICE_NAME, PORT FROM SYS.M_SERVICES ORDER BY PORT;")
echo "\${LANDSCAPE}" | tee -a "\${LOG}"

if echo "\${LANDSCAPE}" | grep -q "YES"; then
  pass "At least one service shows ACTIVE_STATUS=YES"
else
  fail "No services showing ACTIVE_STATUS=YES in M_SERVICES"
fi

# ---------------------------------------------------------------
# 3. Memory usage
# ---------------------------------------------------------------
log "--- Memory Utilization ---"
hdbsql_system "SELECT HOST,
  ROUND(TOTAL_PHYSICAL_MEMORY/1024/1024/1024,2) AS TOTAL_GB,
  ROUND(USED_PHYSICAL_MEMORY/1024/1024/1024,2)  AS USED_GB,
  ROUND(FREE_PHYSICAL_MEMORY/1024/1024/1024,2)  AS FREE_GB,
  ROUND(USED_PHYSICAL_MEMORY*100/TOTAL_PHYSICAL_MEMORY,1) AS USED_PCT
FROM SYS.M_HOST_RESOURCE_UTILIZATION;" | tee -a "\${LOG}"

# ---------------------------------------------------------------
# 4. Create a test tenant database
# ---------------------------------------------------------------
log "--- Creating Test Tenant: TENANTTEST ---"
TENANT_EXISTS=$(hdbsql_system "SELECT COUNT(*) FROM SYS.M_DATABASES WHERE DATABASE_NAME='TENANTTEST';" | tr -d ' ')
if [ "\${TENANT_EXISTS}" = "0" ]; then
  hdbsql_system "CREATE DATABASE TENANTTEST SYSTEM USER PASSWORD \"Test$ystem01!\";" && \
    pass "Test tenant TENANTTEST created" || fail "Failed to create test tenant"
else
  pass "Test tenant TENANTTEST already exists"
fi

# ---------------------------------------------------------------
# 5. Health check SQL via hdbsql
# ---------------------------------------------------------------
log "--- HANA Health SQL ---"

# Row store and column store sizes
hdbsql_system "SELECT HOST,
  ROUND(SUM(ESTIMATED_MAX_MEMORY_SIZE_IN_TOTAL)/1024/1024/1024,2) AS COL_STORE_GB,
  COUNT(*) AS TABLE_COUNT
FROM SYS.M_CS_TABLES
GROUP BY HOST;" | tee -a "\${LOG}"

# Alert count (should be 0 on fresh install)
ALERT_COUNT=$(hdbsql_system "SELECT COUNT(*) FROM SYS.STATISTICS_ALERTS_CURRENT WHERE ALERT_RATING >= 3;" | tr -d ' ')
if [ "\${ALERT_COUNT}" = "0" ]; then
  pass "No high-severity alerts in STATISTICS_ALERTS_CURRENT"
else
  fail "Found \${ALERT_COUNT} high-severity alert(s) in STATISTICS_ALERTS_CURRENT"
fi

# Version
hdbsql_system "SELECT VERSION FROM SYS.M_DATABASE;" | tee -a "\${LOG}"

# ---------------------------------------------------------------
# 6. Systemd service
# ---------------------------------------------------------------
log "--- systemd Service ---"
for SVC in "SAPINIT" "disable-thp"; do
  if systemctl is-active --quiet "\${SVC}"; then
    pass "systemd service \${SVC}: active"
  else
    fail "systemd service \${SVC}: NOT active"
  fi
done

# ---------------------------------------------------------------
# Summary
# ---------------------------------------------------------------
log "===== Verification Complete: ERRORS=\${ERRORS} ====="
if [ "\${ERRORS}" -gt 0 ]; then
  echo "VERIFICATION FAILED with \${ERRORS} error(s). Review \${LOG}."
  exit 1
else
  echo "VERIFICATION PASSED. HANA is ready for data migration."
fi
\`\`\`

---

## Phase 5 — Monitoring Scripts

### 5.1 hana_monitor.sh — Primary Health Monitor

\`\`\`bash
#!/bin/bash
# hana_monitor.sh — SAP HANA comprehensive health monitor
# Checks: service status, memory, disk, backup age, alert log errors
# Run every 15 minutes via cron (see Phase 6)

set -euo pipefail

SID="HDB"
INSTANCE_NR="00"
HDBADM="\${SID,,}adm"
SYSTEM_DB_USER="SYSTEM"
SYSTEM_DB_PASS="\${HANA_MONITOR_PASS:-Hana$ystem01!}"
ALERT_EMAIL="hana-dba@example.com"
LOG="/var/log/hana_monitor.log"
ALERT_LOG="/usr/sap/\${SID}/HDB\${INSTANCE_NR}/$(hostname)/trace/hdbdaemon.trc"
MEM_ALERT_PCT=85
DATA_DISK_ALERT_PCT=80
LOG_DISK_ALERT_PCT=75
BACKUP_MAX_AGE_HOURS=24

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
ERRORS=0
WARNINGS=0
REPORT=""

exec >> "\${LOG}" 2>&1

log()  { echo "[\${TIMESTAMP}] INFO  $*"; }
fail() { ERRORS=$((ERRORS+1));     REPORT="\${REPORT}\nFAIL:  $*"; echo "[\${TIMESTAMP}] FAIL  $*"; }
warn() { WARNINGS=$((WARNINGS+1)); REPORT="\${REPORT}\nWARN:  $*"; echo "[\${TIMESTAMP}] WARN  $*"; }
pass() { echo "[\${TIMESTAMP}] PASS  $*"; }

hdbsql_q() {
  su - "\${HDBADM}" -c "hdbsql -n localhost:3\${INSTANCE_NR}13 -u \${SYSTEM_DB_USER} -p '\${SYSTEM_DB_PASS}' -a -x \"$1\"" 2>/dev/null | tr -d ' '
}

log "===== HANA Monitor Run ====="

# ---------------------------------------------------------------
# 1. Service status via HDB info
# ---------------------------------------------------------------
HDB_RUNNING=$(su - "\${HDBADM}" -c "HDB info 2>&1" | grep -c hdbdaemon || true)
if [ "\${HDB_RUNNING}" -gt 0 ]; then
  pass "hdbdaemon is running"
else
  fail "hdbdaemon is NOT running — HANA may be down"
fi

# Check individual services via M_SERVICES
INACTIVE=$(hdbsql_q "SELECT COUNT(*) FROM SYS.M_SERVICES WHERE ACTIVE_STATUS<>'YES';" 2>/dev/null || echo "ERROR")
if [ "\${INACTIVE}" = "ERROR" ]; then
  fail "Cannot connect to HANA system DB — check connectivity and credentials"
elif [ "\${INACTIVE}" -gt 0 ]; then
  fail "\${INACTIVE} HANA service(s) showing ACTIVE_STATUS != YES"
else
  pass "All HANA services are active"
fi

# ---------------------------------------------------------------
# 2. Memory utilization
# ---------------------------------------------------------------
MEM_PCT=$(hdbsql_q "SELECT ROUND(USED_PHYSICAL_MEMORY*100/TOTAL_PHYSICAL_MEMORY,0) FROM SYS.M_HOST_RESOURCE_UTILIZATION WHERE HOST='$(hostname)';" 2>/dev/null || echo "ERROR")
if [ "\${MEM_PCT}" = "ERROR" ]; then
  warn "Could not query M_HOST_RESOURCE_UTILIZATION for memory"
elif [ "\${MEM_PCT}" -ge "\${MEM_ALERT_PCT}" ]; then
  fail "Memory usage is \${MEM_PCT}% — threshold is \${MEM_ALERT_PCT}%"
else
  pass "Memory usage is \${MEM_PCT}% (threshold \${MEM_ALERT_PCT}%)"
fi

# ---------------------------------------------------------------
# 3. Disk usage — /hana/data and /hana/log
# ---------------------------------------------------------------
check_disk() {
  local MNT="$1"
  local THRESHOLD="$2"
  local PCT
  PCT=$(df -h "\${MNT}" 2>/dev/null | awk 'NR==2{gsub(/%/,"",$5); print $5}')
  if [ -z "\${PCT}" ]; then
    warn "Could not determine disk usage for \${MNT}"
  elif [ "\${PCT}" -ge "\${THRESHOLD}" ]; then
    fail "Disk \${MNT} is \${PCT}% full — threshold is \${THRESHOLD}%"
  else
    pass "Disk \${MNT} usage: \${PCT}% (threshold \${THRESHOLD}%)"
  fi
}

check_disk "/hana/data" "\${DATA_DISK_ALERT_PCT}"
check_disk "/hana/log"  "\${LOG_DISK_ALERT_PCT}"
check_disk "/backup"    "90"

# ---------------------------------------------------------------
# 4. Backup age check
# ---------------------------------------------------------------
LAST_BACKUP_AGE=$(hdbsql_q "SELECT ROUND((CURRENT_TIMESTAMP - MAX(SYS_START_TIME)) * 24, 1) FROM SYS.M_BACKUP_CATALOG WHERE ENTRY_TYPE_NAME IN ('complete data backup','differential data backup') AND STATE_NAME='successful';" 2>/dev/null || echo "ERROR")
if [ "\${LAST_BACKUP_AGE}" = "ERROR" ]; then
  warn "Could not query backup catalog"
elif [ -z "\${LAST_BACKUP_AGE}" ]; then
  fail "No successful backup found in M_BACKUP_CATALOG"
else
  # Compare using awk for decimal comparison
  BACKUP_OLD=$(awk -v age="\${LAST_BACKUP_AGE}" -v max="\${BACKUP_MAX_AGE_HOURS}" 'BEGIN{print (age+0 > max+0) ? "1" : "0"}')
  if [ "\${BACKUP_OLD}" = "1" ]; then
    fail "Last successful backup was \${LAST_BACKUP_AGE} hours ago — exceeds \${BACKUP_MAX_AGE_HOURS}h threshold"
  else
    pass "Last successful backup: \${LAST_BACKUP_AGE} hours ago"
  fi
fi

# ---------------------------------------------------------------
# 5. Alert log scan (last 200 lines)
# ---------------------------------------------------------------
if [ -f "\${ALERT_LOG}" ]; then
  ERROR_COUNT=$(tail -200 "\${ALERT_LOG}" | grep -ciE 'error|exception|crash|oom' || true)
  if [ "\${ERROR_COUNT}" -gt 0 ]; then
    warn "Found \${ERROR_COUNT} error/exception line(s) in trace log (last 200 lines)"
    REPORT="\${REPORT}\n--- Trace log errors ---\n$(tail -200 "\${ALERT_LOG}" | grep -iE 'error|exception|crash|oom' | tail -10)"
  else
    pass "No error patterns in trace log (last 200 lines)"
  fi
else
  warn "Trace log not found at \${ALERT_LOG}"
fi

# ---------------------------------------------------------------
# 6. Email alert if any issues
# ---------------------------------------------------------------
if [ "\${ERRORS}" -gt 0 ] || [ "\${WARNINGS}" -gt 0 ]; then
  printf "SAP HANA Monitor Alert\nHost: $(hostname)\nSID: \${SID}\nTime: \${TIMESTAMP}\n\nErrors: \${ERRORS}  Warnings: \${WARNINGS}\n$(echo -e \${REPORT})\n\nFull log: \${LOG}\n" \
    | mail -s "[HANA ALERT] $(hostname) - \${SID} - Errors=\${ERRORS} Warnings=\${WARNINGS}" "\${ALERT_EMAIL}"
  log "Alert email sent to \${ALERT_EMAIL}"
fi

log "===== Monitor Run Complete: ERRORS=\${ERRORS} WARNINGS=\${WARNINGS} ====="
\`\`\`

### 5.2 hana_backup_check.sh — Backup Catalog Validator

\`\`\`bash
#!/bin/bash
# hana_backup_check.sh — verifies last successful HANA backup is within 24h
# Run daily at 06:00 via cron (see Phase 6)

set -euo pipefail

SID="HDB"
INSTANCE_NR="00"
HDBADM="\${SID,,}adm"
SYSTEM_DB_USER="SYSTEM"
SYSTEM_DB_PASS="\${HANA_MONITOR_PASS:-Hana$ystem01!}"
ALERT_EMAIL="hana-dba@example.com"
LOG="/var/log/hana_backup_check.log"
MAX_AGE_HOURS=24

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

exec >> "\${LOG}" 2>&1
log() { echo "[\${TIMESTAMP}] $*"; }

log "===== HANA Backup Check Start ====="

hdbsql_q() {
  su - "\${HDBADM}" -c "hdbsql -n localhost:3\${INSTANCE_NR}13 -u \${SYSTEM_DB_USER} -p '\${SYSTEM_DB_PASS}' -a -x \"$1\"" 2>/dev/null | tr -d ' '
}

# Query last successful backup per database
BACKUP_REPORT=$(su - "\${HDBADM}" -c "hdbsql -n localhost:3\${INSTANCE_NR}13 \
  -u \${SYSTEM_DB_USER} -p '\${SYSTEM_DB_PASS}' -a \
  \"SELECT DATABASE_NAME, ENTRY_TYPE_NAME,
    TO_VARCHAR(MAX(SYS_START_TIME),'YYYY-MM-DD HH24:MI:SS') AS LAST_BACKUP,
    ROUND((CURRENT_TIMESTAMP - MAX(SYS_START_TIME))*24,2) AS AGE_HOURS,
    STATE_NAME
   FROM SYS.M_BACKUP_CATALOG
   WHERE ENTRY_TYPE_NAME IN ('complete data backup','differential data backup')
     AND STATE_NAME='successful'
   GROUP BY DATABASE_NAME, ENTRY_TYPE_NAME, STATE_NAME
   ORDER BY DATABASE_NAME, ENTRY_TYPE_NAME;\"" 2>/dev/null)

echo "\${BACKUP_REPORT}" | tee -a "\${LOG}"

# Check age of the most recent successful backup across all databases
OLDEST_AGE=$(su - "\${HDBADM}" -c "hdbsql -n localhost:3\${INSTANCE_NR}13 \
  -u \${SYSTEM_DB_USER} -p '\${SYSTEM_DB_PASS}' -a -x \
  \"SELECT ROUND(MAX((CURRENT_TIMESTAMP - LAST_BACKUP_TIME)*24),1)
   FROM (
     SELECT DATABASE_NAME, MAX(SYS_START_TIME) AS LAST_BACKUP_TIME
     FROM SYS.M_BACKUP_CATALOG
     WHERE ENTRY_TYPE_NAME IN ('complete data backup','differential data backup')
       AND STATE_NAME='successful'
     GROUP BY DATABASE_NAME
   );\"" 2>/dev/null | tr -d ' ')

if [ -z "\${OLDEST_AGE}" ]; then
  MSG="CRITICAL: No successful backups found in M_BACKUP_CATALOG for SID \${SID} on $(hostname)"
  log "\${MSG}"
  echo "\${MSG}\n\nBackup report:\n\${BACKUP_REPORT}\n\nLog: \${LOG}" \
    | mail -s "[HANA BACKUP CRITICAL] \${SID} $(hostname) - No backups found" "\${ALERT_EMAIL}"
  exit 1
fi

BACKUP_OLD=$(awk -v age="\${OLDEST_AGE}" -v max="\${MAX_AGE_HOURS}" 'BEGIN{print (age+0 > max+0) ? "1" : "0"}')
if [ "\${BACKUP_OLD}" = "1" ]; then
  MSG="WARNING: Oldest database backup for SID \${SID} is \${OLDEST_AGE} hours old — exceeds \${MAX_AGE_HOURS}h threshold"
  log "\${MSG}"
  printf "\${MSG}\n\nBackup catalog summary:\n\${BACKUP_REPORT}\n\nLog: \${LOG}\n" \
    | mail -s "[HANA BACKUP WARNING] \${SID} $(hostname) - Backup age \${OLDEST_AGE}h" "\${ALERT_EMAIL}"
else
  log "Backup age OK: oldest database backup is \${OLDEST_AGE} hours old (threshold \${MAX_AGE_HOURS}h)"
fi

log "===== HANA Backup Check Complete ====="
\`\`\`

### 5.3 hana_disk_monitor.sh — Disk Utilization Alert

\`\`\`bash
#!/bin/bash
# hana_disk_monitor.sh — monitors /hana/data and /hana/log with configurable thresholds
# Run every 30 minutes via cron (see Phase 6)

set -euo pipefail

SID="HDB"
HDBADM="\${SID,,}adm"
ALERT_EMAIL="hana-dba@example.com"
LOG="/var/log/hana_disk_monitor.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# Alert thresholds (percent)
DATA_WARN=75
DATA_CRIT=85
LOG_WARN=70
LOG_CRIT=80
SHARED_WARN=70
SHARED_CRIT=85
BACKUP_WARN=80
BACKUP_CRIT=90

exec >> "\${LOG}" 2>&1
log() { echo "[\${TIMESTAMP}] $*"; }

ALERT_BODY=""
ALERT_LEVEL=0   # 0=OK, 1=WARN, 2=CRIT

check_mount() {
  local MNT="$1"
  local WARN_PCT="$2"
  local CRIT_PCT="$3"
  local LABEL="$4"

  if ! mountpoint -q "\${MNT}"; then
    log "CRIT: \${MNT} is NOT mounted"
    ALERT_BODY="\${ALERT_BODY}\nCRITICAL: \${MNT} is not mounted"
    ALERT_LEVEL=2
    return
  fi

  local USED FREE TOTAL PCT
  read -r USED FREE TOTAL PCT <<< "$(df -BG "\${MNT}" | awk 'NR==2{gsub(/G/,"",$2); gsub(/G/,"",$3); gsub(/G/,"",$4); gsub(/%/,"",$5); print $3, $4, $2, $5}')"

  log "Disk \${LABEL} (\${MNT}): used=\${USED}G  free=\${FREE}G  total=\${TOTAL}G  \${PCT}%"

  if [ "\${PCT}" -ge "\${CRIT_PCT}" ]; then
    log "CRIT: \${MNT} at \${PCT}% — threshold \${CRIT_PCT}%"
    ALERT_BODY="\${ALERT_BODY}\nCRITICAL: \${LABEL} (\${MNT}) is \${PCT}% full (used \${USED}G of \${TOTAL}G, free \${FREE}G)"
    [ "\${ALERT_LEVEL}" -lt 2 ] && ALERT_LEVEL=2
  elif [ "\${PCT}" -ge "\${WARN_PCT}" ]; then
    log "WARN: \${MNT} at \${PCT}% — threshold \${WARN_PCT}%"
    ALERT_BODY="\${ALERT_BODY}\nWARNING:  \${LABEL} (\${MNT}) is \${PCT}% full (used \${USED}G of \${TOTAL}G, free \${FREE}G)"
    [ "\${ALERT_LEVEL}" -lt 1 ] && ALERT_LEVEL=1
  fi
}

log "===== HANA Disk Monitor Run ====="

check_mount "/hana/data"   "\${DATA_WARN}"   "\${DATA_CRIT}"   "HANA_DATA"
check_mount "/hana/log"    "\${LOG_WARN}"    "\${LOG_CRIT}"    "HANA_LOG"
check_mount "/hana/shared" "\${SHARED_WARN}" "\${SHARED_CRIT}" "HANA_SHARED"
check_mount "/backup"      "\${BACKUP_WARN}" "\${BACKUP_CRIT}" "HANA_BACKUP"

if [ "\${ALERT_LEVEL}" -gt 0 ]; then
  SUBJECT_PREFIX="WARN"
  [ "\${ALERT_LEVEL}" -eq 2 ] && SUBJECT_PREFIX="CRIT"
  printf "SAP HANA Disk Monitor\nHost: $(hostname)\nSID: \${SID}\nTime: \${TIMESTAMP}\n$(echo -e \${ALERT_BODY})\n\nFull log: \${LOG}\n" \
    | mail -s "[HANA DISK \${SUBJECT_PREFIX}] $(hostname) - \${SID}" "\${ALERT_EMAIL}"
  log "Alert email sent (level=\${SUBJECT_PREFIX})"
fi

log "===== Disk Monitor Complete ====="
\`\`\`

---

## Phase 6 — Crontab Schedule

Install scripts to \`/opt/scripts/\`, set ownership to \`hdbadm:sapsys\`, and make them executable.

\`\`\`bash
chmod 750 /opt/scripts/hana_monitor.sh
chmod 750 /opt/scripts/hana_backup_check.sh
chmod 750 /opt/scripts/hana_disk_monitor.sh
chown hdbadm:sapsys /opt/scripts/hana_monitor.sh
chown hdbadm:sapsys /opt/scripts/hana_backup_check.sh
chown hdbadm:sapsys /opt/scripts/hana_disk_monitor.sh
\`\`\`

Add the following to root's crontab (\`crontab -e\`):

\`\`\`
# SAP HANA Monitoring Crontab
# Maintained by: hana-dba@example.com
# SID: HDB  Instance: 00  Host: hana-srv01

# ---------------------------------------------------------------
# Every 15 min: comprehensive HANA health monitor
# ---------------------------------------------------------------
*/15 * * * * HANA_MONITOR_PASS="Hana$ystem01!" /opt/scripts/hana_monitor.sh >> /var/log/hana_monitor_cron.log 2>&1

# ---------------------------------------------------------------
# Daily at 06:00: backup catalog validation
# ---------------------------------------------------------------
0 6 * * * HANA_MONITOR_PASS="Hana$ystem01!" /opt/scripts/hana_backup_check.sh >> /var/log/hana_backup_check_cron.log 2>&1

# ---------------------------------------------------------------
# Every 30 min: disk usage check for /hana/data and /hana/log
# ---------------------------------------------------------------
*/30 * * * * /opt/scripts/hana_disk_monitor.sh >> /var/log/hana_disk_monitor_cron.log 2>&1

# ---------------------------------------------------------------
# Weekly Sunday at 02:00: compress and rotate monitor logs older than 30 days
# ---------------------------------------------------------------
0 2 * * 0 find /var/log -name 'hana_*.log' -mtime +30 -exec gzip -9 {} \; && find /var/log -name 'hana_*.log.gz' -mtime +90 -delete >> /var/log/hana_log_cleanup.log 2>&1

# ---------------------------------------------------------------
# Weekly Sunday at 02:30: rotate HANA trace logs (keeps last 14 days)
# ---------------------------------------------------------------
30 2 * * 0 find /usr/sap/HDB/HDB00/$(hostname)/trace -name '*.trc' -mtime +14 -delete >> /var/log/hana_trace_cleanup.log 2>&1
\`\`\`

### Crontab Schedule Summary

| Schedule | Script | Purpose |
|----------|--------|---------|
| Every 15 min | hana_monitor.sh | Service status, memory, disk, backup age, trace errors |
| Daily 06:00 | hana_backup_check.sh | Verify last backup within 24h per database |
| Every 30 min | hana_disk_monitor.sh | /hana/data and /hana/log disk thresholds |
| Sunday 02:00 | log cleanup | Compress logs older than 30 days; delete after 90 days |
| Sunday 02:30 | trace cleanup | Remove trace files older than 14 days |

---

## Phase 7 — Rollback / Uninstall

If the installation must be reversed — for example, after a failed validation or a host repurpose — follow this sequence. Do not skip steps; partial cleanup causes problems for re-installs.

### 7.1 Stop HANA Gracefully

\`\`\`bash
SID="HDB"
HDBADM="\${SID,,}adm"

# Stop HANA as hdbadm
su - "\${HDBADM}" -c "HDB stop"

# Wait up to 5 minutes for clean shutdown
for i in $(seq 1 30); do
  PROCS=$(pgrep -u "\${HDBADM}" -c hdb 2>/dev/null || true)
  [ "\${PROCS}" -eq 0 ] && { echo "HANA stopped cleanly."; break; }
  echo "Waiting for HANA to stop... (\${i}/30)"
  sleep 10
done
\`\`\`

### 7.2 Run HDBLCM Uninstall

\`\`\`bash
EXTRACT_DIR="/hana/shared/hana_install"
HDBLCM="\${EXTRACT_DIR}/SAP_HANA_DATABASE/hdblcm"

# HDBLCM uninstall in batch mode
"\${HDBLCM}" \
  --batch \
  --action=uninstall \
  --sid=HDB \
  --number=00 \
  2>&1 | tee /var/log/hdblcm_uninstall.log

echo "HDBLCM uninstall exit code: $?"
\`\`\`

### 7.3 Remove OS Users and Groups

\`\`\`bash
SID="HDB"
HDBADM="\${SID,,}adm"

# Remove hdbadm home and user
userdel -r "\${HDBADM}" 2>/dev/null && echo "Removed user \${HDBADM}" || echo "User \${HDBADM} not found"

# Remove sapadm if no other SAP instances remain on this host
# Check first: ls /usr/sap/ — if only one SID directory exists, safe to remove
OTHER_SIDS=$(ls /usr/sap/ 2>/dev/null | grep -v "^trans$" | wc -l)
if [ "\${OTHER_SIDS}" -eq 0 ]; then
  userdel -r sapadm 2>/dev/null && echo "Removed user sapadm" || echo "User sapadm not found"
  groupdel sapsys 2>/dev/null && echo "Removed group sapsys" || echo "Group sapsys not found"
else
  echo "Other SAP instances present — leaving sapadm and sapsys intact"
fi
\`\`\`

### 7.4 Remove Directories and Filesystems

\`\`\`bash
# Unmount in reverse dependency order
umount /hana/data   2>/dev/null || true
umount /hana/log    2>/dev/null || true
umount /hana/shared 2>/dev/null || true
umount /backup      2>/dev/null || true

# Remove fstab entries
sed -i '/HANA_DATA\|HANA_LOG\|HANA_SHARED\|HANA_BACKUP/d' /etc/fstab

# Remove directories
rm -rf /hana/data /hana/log /hana/shared /hana /backup
rm -rf /usr/sap/HDB
rm -rf /sapmnt/HDB

echo "HANA filesystem directories removed."

# Optionally wipe the XFS superblocks to allow reuse of the block devices
for DEV in /dev/sdb /dev/sdc /dev/sdd /dev/sde; do
  [ -b "\${DEV}" ] && wipefs -a "\${DEV}" && echo "Wiped \${DEV}" || true
done
\`\`\`

### 7.5 Restore OS Defaults

\`\`\`bash
# Remove saptune solution (reverting kernel parameters to OS defaults)
saptune solution revert HANA
saptune service disable
systemctl stop saptune

# Remove HANA-specific kernel parameter file
rm -f /etc/sysctl.d/90-saphana.conf
sysctl --system

# Remove HANA OS limits
rm -f /etc/security/limits.d/99-saphana.conf

# Remove THP override service (THP may re-enable after reboot)
systemctl disable --now disable-thp.service
rm -f /etc/systemd/system/disable-thp.service
systemctl daemon-reload

echo "OS configuration restored to pre-HANA state."
\`\`\`

---

## Troubleshooting Quick Reference

| Symptom | Likely Cause | Resolution |
|---------|-------------|------------|
| HDBLCM exits with error 1 | Missing required package or OS check failure | Review \`/var/log/hdblcm/\` for the specific check; re-run \`hana_os_prep.sh\` |
| hdbdaemon not starting | THP not disabled or vm.max_map_count too low | Verify \`/sys/kernel/mm/transparent_hugepage/enabled\` is \`[never]\`; check sysctl |
| High memory alert | Column store growing unchecked or unload threshold too high | Review \`M_CS_TABLES\` for large tables; adjust \`global.ini\` memory limits |
| /hana/log full | Log mode = normal with no log backup | Switch log mode to \`overwrite\` temporarily and schedule log backups |
| Backup catalog empty | No BACKINT or file backup configured | Configure backup destination in SAP HANA Studio or hdbsql and run initial full backup |
| hdbsql connection refused | HANA indexserver not running or wrong port | Check port 3\${INSTANCE_NR}13 (3013 for instance 00); check \`HDB info\` output |
| saptune verify warnings | Non-SAP kernel applied or conflicting tuned profile | Run \`saptune status\` and disable conflicting tuned profiles |
| OS user hdbadm home missing | \`/usr/sap/\${SID}/home\` not created by installer | Create the directory: \`mkdir -p /usr/sap/HDB/home && chown hdbadm:sapsys /usr/sap/HDB/home\` |`,
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
