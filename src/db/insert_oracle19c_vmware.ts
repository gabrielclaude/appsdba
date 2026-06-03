import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const blogPost = {
  title: 'Oracle Database 19c on VMware ESXi and vSphere: What Every DBA Needs to Know',
  slug: 'oracle-19c-vmware-esxi-vsphere',
  excerpt:
    'A practical guide to running Oracle Database 19c on VMware ESXi and vSphere — covering Oracle support policy, memory and CPU virtualisation considerations, NUMA topology, storage selection, licensing implications, and how to architect a supported, performant production deployment.',
  category: 'oracle-database' as const,
  published: true,
  publishedAt: new Date('2026-06-02'),
  isPremium: false,
  youtubeUrl: null,
  content: `Running Oracle Database 19c on VMware is common and supported — but only under specific conditions, and with a set of virtualisation behaviours that have direct and sometimes surprising effects on database performance and Oracle's support obligations. This post covers the support policy, the technical trade-offs, and the configuration choices that matter most in production.

---

## Oracle's Support Position on VMware

Oracle's stance is documented in MOS Note **249212.1** ("Oracle Support for VMware"): Oracle will support its products running inside VMware-virtualised environments, but Oracle Support may request that you reproduce a problem on bare metal or a supported Oracle engineered system before investigating a VMware-specific issue.

In practice this means:
- Oracle does **not** certify against specific VMware versions.
- Oracle does certify the guest OS (RHEL 8, Oracle Linux 8, etc.) independently of the hypervisor.
- If you open an SR and Oracle suspects the hypervisor is involved, support can ask you to reproduce on native hardware. This is a real risk — have a bare-metal or OCI fallback for critical investigations.

For environments where full Oracle support coverage matters, Oracle Database Appliance (ODA), Exadata Cloud@Customer, or OCI Dedicated Infrastructure are the engineered alternatives. For most production deployments on corporate VMware infrastructure, the policy is manageable if you maintain physical parity for reproducing issues.

---

## Memory Virtualisation — The Biggest Risk

VMware uses several memory management techniques that interact badly with Oracle SGA:

### Balloon Driver (vmmemctl)
VMware installs a balloon driver inside the guest OS. When the ESXi host is under memory pressure, the balloon driver inflates — allocating guest physical memory pages — which forces the guest OS to swap. For Oracle, this means **SGA pages can be swapped to disk** even though the DBA configured \`LOCK_SGA=TRUE\`.

**Fix:** Set \`LOCK_SGA=TRUE\` in the Oracle parameter file AND reserve memory at the VMware level:
- In the vSphere Client: VM Settings → Memory → set **Reservation** equal to the full VM memory allocation.
- This prevents the balloon driver from reclaiming memory from that VM.

### Transparent Page Sharing (TPS)
TPS allows ESXi to deduplicate identical memory pages across VMs. Oracle SGA pages are not identical across databases, so TPS provides minimal savings for database VMs, but scanning for shared pages adds CPU overhead. Disable TPS for database VMs where possible via the VM advanced parameter \`sched.mem.pshare.enable = FALSE\`.

### Memory Overcommit
Never overcommit memory on hosts running Oracle databases. Set ESXi host memory reservation to 100% for all database VMs. A host-level memory overcommit scenario where Oracle SGA starts swapping is catastrophic for performance and almost impossible to diagnose without knowing the VMware layer is involved.

---

## CPU Virtualisation and NUMA Topology

### NUMA Alignment
Modern ESXi hosts are NUMA systems. Oracle has NUMA-aware memory allocation built in — when the Oracle process footprint spans multiple NUMA nodes, Oracle automatically balances buffer cache and PGA allocations across nodes. VMware exposes NUMA topology to the guest, but only correctly when:

1. The VM's vCPU count does not exceed the physical core count of a single NUMA node.
2. The VM's memory allocation does not exceed the memory on a single NUMA node.
3. vCPU hot-add is disabled (it breaks NUMA topology presentation).

A VM with 32 vCPUs on a host with two 16-core NUMA sockets will span two NUMA nodes. Oracle sees a two-node NUMA system and tries to manage it — but vMotion can silently move the VM to a host with different NUMA geometry, breaking the mapping. Use **vCPU/memory pinning** or **NUMA node affinity** for database VMs to prevent this.

### vCPU Sizing
- Do not assign more vCPUs than the database will actually use under peak load. Over-provisioned vCPUs create CPU scheduling overhead on the hypervisor.
- Use the Oracle AWR metric \`%busy\` from \`v\$osstat\` to size correctly.
- For OLTP workloads: start with physical core count of one NUMA node, tune from AWR.
- For DSS/batch: a larger vCPU count is appropriate if the host has spare capacity.

### Hyperthreading
ESXi presents logical CPUs (threads) as vCPU candidates. Oracle licenses by physical core count, but vCPU scheduling by VMware can place Oracle threads on hyperthreaded sibling cores, which share execution units. For latency-sensitive workloads, pin vCPUs to physical cores only by setting \`cpu.coresPerSocket\` to match the physical core count per socket.

---

## Oracle Licensing on VMware — Soft Partitioning

This is the most important operational consideration and the most common source of compliance exposure.

Oracle's licensing policy classifies VMware as **soft partitioning**. Soft partitioning tools — including vSphere resource pools, CPU affinity, and DRS rules — **do not limit Oracle license requirements**. Oracle licenses are required for all physical cores on all ESXi hosts in a vSphere cluster that the Oracle VM could potentially run on, even if the VM is currently pinned to specific hosts.

**Practical implications:**
- A 2-socket Oracle VM in a 10-host vSphere cluster requires licenses for all cores across all 10 hosts if those hosts form a DRS/HA cluster.
- Separating Oracle VMs onto a dedicated cluster of licensed hosts is the only way to ring-fence the license scope.
- VMware's Hard Partitioning via vSphere Distributed Resource Scheduler (DRS) affinity rules is **not recognised** by Oracle as hard partitioning.

Oracle's licensing FAQ (LID: 2006) is the authoritative document. Consult your Oracle LMS account team before deploying in a shared cluster.

---

## Storage Selection

### VMDK vs Raw Device Mapping (RDM)
Both are supported. The key trade-offs:

| | VMDK | RDM (Physical Compatibility) |
|---|---|---|
| Storage management | vCenter manages | LUN managed directly |
| Oracle ASM support | Yes (via ASMLib or UDEV) | Yes (preferred for ASM) |
| vSphere snapshots | Yes | No |
| vMotion | Yes | Yes (with vSphere Storage vMotion limitations) |
| Performance | Near-native for thick provisioned | Native |
| Recommended for | General Oracle DB | Oracle RAC, high-I/O OLTP |

For Oracle RAC on vSphere, use RDM in physical compatibility mode for shared cluster volumes. ASM on VMDK works but adds a layer of abstraction; test carefully with fio before production cutover.

### Provisioning Type
Always use **thick eager-zeroed** VMDKs for Oracle database volumes. Thin provisioning causes write amplification when blocks are first touched (zeroing happens at first write time), which produces inconsistent I/O latency — exactly the kind of problem that is hard to diagnose and manifests as intermittent "slow commits" in Oracle AWR.

### Storage Networking
- For NFS datastores: use VMXNET3 NIC, jumbo frames (MTU 9000) end-to-end, dedicated storage VLAN, and enable NFS caching only for non-database volumes.
- For iSCSI: use software iSCSI initiator with multipath I/O, round-robin PSP, and dedicated storage NICs.
- For Fibre Channel: FC HBAs pass through best on VMware; use physical FC where I/O SLAs are tight.

---

## High Availability Architecture

VMware vSphere HA restarts VMs on surviving hosts after a host failure, with a typical RTO of 3–8 minutes (guest OS boot + Oracle startup). For databases this is acceptable for many workloads but not for zero-RPO requirements.

Oracle Data Guard with VMware HA gives you complementary protection layers:

| Failure Type | vSphere HA | Oracle Data Guard |
|---|---|---|
| ESXi host failure | Restarts VM on another host | Can switchover to standby |
| Datastore failure | Not protected | Protected (standby has own storage) |
| Site failure | Not protected without SRM | Switchover/failover to DR site |
| Data corruption | Not protected | Flashback + standby replay |
| Planned maintenance | vMotion (live migration) | Rolling upgrades on standby |

For production Oracle on VMware: use Data Guard for RPO/RTO SLAs, and rely on vSphere HA as a secondary fast-restart mechanism for unplanned host failures.

Oracle RAC on vSphere provides instance-level HA within a site and scales read/write workloads, but requires careful shared storage configuration and a VMware cluster sized to maintain N-1 capacity at all times.

---

## Performance Validation Checklist

Before go-live, validate the following from inside the Oracle guest:

\`\`\`sql
-- Check NUMA statistics in Oracle
SELECT stat_name, value
FROM   v\$osstat
WHERE  stat_name IN ('NUM_CPUS','NUM_CPU_CORES','NUM_CPU_SOCKETS',
                     'PHYSICAL_MEMORY_BYTES','NUM_LCPUS')
ORDER BY stat_name;

-- Confirm Oracle sees NUMA nodes (should be > 1 for a multi-socket host)
SELECT * FROM v\$cell_config WHERE cell_path IS NULL;

-- I/O latency baseline — should be < 1ms for data files on SAN/vSAN
SELECT name,
       phyrds,
       phywrts,
       ROUND(readtim / GREATEST(phyrds,1), 3) avg_read_ms,
       ROUND(writetim / GREATEST(phywrts,1), 3) avg_write_ms
FROM   v\$filestat f
JOIN   v\$datafile d USING (file#)
ORDER BY avg_read_ms DESC
FETCH FIRST 10 ROWS ONLY;

-- Check for balloon driver activity (non-zero means VMware is reclaiming memory)
-- Run on ESXi host: esxtop then press 'm' for memory view, look for MCTLSZ column
\`\`\`

\`\`\`bash
# From the Oracle guest OS — confirm SGA is locked (pages not swappable)
grep -i "hugepage\|sga\|lock" /proc/\$(pgrep -f ora_pmon)/smaps | grep -i "locked" | head -10

# Confirm memory reservation is active (should show 0 balloon usage)
# Run on ESXi CLI:
# esxcli vm process list | grep <vm-name>
# esxcli vm process stats -w <world-id>
\`\`\`

---

## Summary: Production Configuration Checklist

| Area | Recommendation |
|---|---|
| Memory reservation | Reserve 100% of VM memory in vSphere — no balloon driver |
| \`LOCK_SGA\` | Set to \`TRUE\` in Oracle spfile |
| TPS | Disable with \`sched.mem.pshare.enable = FALSE\` |
| NUMA | Size vCPUs/memory to fit within one NUMA node; disable vCPU hot-add |
| VMDK type | Thick eager-zeroed for all Oracle data volumes |
| Storage | Dedicated datastore for Oracle, separate from OS and other VMs |
| Licensing | Dedicated ESXi cluster for Oracle VMs; document all hosts in scope |
| vSphere HA | Enable; set restart priority to High for Oracle VMs |
| Snapshots | Never snapshot a running Oracle VM — quiescing Oracle for snapshot is error-prone; use RMAN |
| vMotion | Allowed for planned maintenance; test I/O behaviour after live migration |
`,
};

const runbookPost = {
  title: 'Runbook: Oracle Database 19c Installation on VMware vSphere',
  slug: 'oracle-19c-vmware-esxi-vsphere-runbook',
  excerpt:
    'Step-by-step scripts for deploying Oracle Database 19c on a VMware ESXi guest — VM hardware configuration, Oracle Linux 8 OS preparation, kernel parameters, storage layout, Grid Infrastructure and Database 19c silent install, and post-install validation.',
  category: 'oracle-database' as const,
  published: true,
  publishedAt: new Date('2026-06-02'),
  isPremium: true,
  youtubeUrl: null,
  content: `This runbook covers the full installation of Oracle Database 19c on an Oracle Linux 8 VM running on VMware ESXi 7.x / 8.x. It assumes the VM has already been created and the OS installed. See the companion blog post for architecture decisions and licensing guidance.

**Environment assumptions:**
- VMware ESXi 7.x or 8.x, vCenter-managed cluster
- Guest OS: Oracle Linux 8.8+ (x86_64)
- Oracle Database 19c (19.3.0 base + RU 19.22 or later)
- Standalone (non-RAC) single-instance deployment
- Storage: thick eager-zeroed VMDKs on a dedicated datastore

Set these variables once and export before running any script:

\`\`\`bash
export ORA_BASE=/u01/app/oracle
export ORA_HOME=/u01/app/oracle/product/19.3.0/dbhome_1
export ORA_DATA=/u02/oradata
export ORA_FRA=/u03/fra
export ORA_INVENTORY=/u01/app/oraInventory
export ORACLE_SID=ORCL19C
export DB_UNIQUE_NAME=ORCL19C
export ORACLE_HOSTNAME=$(hostname -f)
export ORA_VERSION=19.3.0
\`\`\`

---

## Script 1: VMware Guest OS Preflight Check

Run on the Oracle Linux guest to verify VMware-specific settings before installing Oracle.

\`\`\`bash
#!/bin/bash
# vmware_oracle_preflight.sh — validate VMware guest configuration for Oracle 19c
# Run as root

PASS=0; WARN=0; FAIL=0
pass() { echo "  [PASS] \$1"; ((PASS++)); }
warn() { echo "  [WARN] \$1"; ((WARN++)); }
fail() { echo "  [FAIL] \$1"; ((FAIL++)); }

echo "=========================================="
echo "  VMware Oracle 19c Preflight Check"
echo "  \$(date)"
echo "=========================================="

# ── Confirm running inside VMware ─────────────────────────────────────────
if dmidecode -s system-product-name 2>/dev/null | grep -qi "vmware"; then
  pass "Running on VMware hypervisor"
else
  warn "Not confirmed running on VMware — check dmidecode output manually"
fi

# ── VMware Tools / open-vm-tools ───────────────────────────────────────────
if systemctl is-active --quiet vmtoolsd 2>/dev/null; then
  pass "open-vm-tools (vmtoolsd) is running"
else
  fail "open-vm-tools not running — install: dnf install open-vm-tools && systemctl enable --now vmtoolsd"
fi

# ── Memory — check for balloon driver activity ─────────────────────────────
BALLOON_KB=$(grep -i "vmmemctl\|balloon" /proc/meminfo 2>/dev/null | grep -oP '[0-9]+' | head -1)
if [ -z "\$BALLOON_KB" ] || [ "\$BALLOON_KB" -eq 0 ] 2>/dev/null; then
  pass "No balloon driver memory reclaim detected"
else
  fail "Balloon driver active — \${BALLOON_KB} KB reclaimed. Set memory reservation to 100% in vSphere."
fi

# ── Check for huge pages (required for large SGA locking) ─────────────────
HP_TOTAL=$(grep HugePages_Total /proc/meminfo | awk '{print \$2}')
HP_FREE=$(grep HugePages_Free /proc/meminfo | awk '{print \$2}')
if [ "\$HP_TOTAL" -gt 0 ] 2>/dev/null; then
  pass "Huge pages configured: total=\${HP_TOTAL}, free=\${HP_FREE}"
else
  warn "Huge pages not configured — recommended for Oracle SGA on VMware (prevents balloon reclaim of SGA)"
  warn "  Set vm.nr_hugepages in /etc/sysctl.conf: nr_hugepages = (SGA_bytes / 2097152) + 64"
fi

# ── NUMA topology ──────────────────────────────────────────────────────────
NUMA_NODES=$(numactl --hardware 2>/dev/null | grep "available:" | grep -oP '[0-9]+' | head -1)
VCPU_COUNT=$(nproc)
if [ "\$NUMA_NODES" -gt 1 ] 2>/dev/null; then
  warn "VM spans \${NUMA_NODES} NUMA nodes with \${VCPU_COUNT} vCPUs — ensure vCPU count fits within one physical NUMA node"
  warn "  Check: numactl --hardware | grep 'cpus:'"
else
  pass "Single NUMA node (\${VCPU_COUNT} vCPUs) — optimal for Oracle"
fi

# ── NIC driver ────────────────────────────────────────────────────────────
NIC_DRIVER=$(ethtool -i eth0 2>/dev/null | grep "driver:" | awk '{print \$2}')
if [ "\$NIC_DRIVER" = "vmxnet3" ]; then
  pass "VMXNET3 NIC driver in use — optimal for VMware guests"
else
  warn "NIC driver is '\${NIC_DRIVER}' — VMXNET3 is recommended for Oracle on VMware"
fi

# ── Disk controller ───────────────────────────────────────────────────────
SCSI_DRIVER=$(lspci 2>/dev/null | grep -i "scsi\|paravirtual" | head -1)
if echo "\$SCSI_DRIVER" | grep -qi "paravirtual\|pvscsi"; then
  pass "VMware Paravirtual SCSI (PVSCSI) controller detected — recommended for Oracle storage"
else
  warn "PVSCSI not detected — use VMware Paravirtual SCSI controller for Oracle data disks (lower CPU, higher throughput)"
fi

# ── Clock source ─────────────────────────────────────────────────────────
CLOCK=$(cat /sys/devices/system/clocksource/clocksource0/current_clocksource 2>/dev/null)
if [ "\$CLOCK" = "tsc" ] || [ "\$CLOCK" = "kvm-clock" ]; then
  pass "Clock source: \$CLOCK"
else
  warn "Unexpected clock source: \$CLOCK — 'tsc' or 'kvm-clock' preferred"
fi

# ── Swap ─────────────────────────────────────────────────────────────────
SWAP_TOTAL=$(free -m | grep Swap | awk '{print \$2}')
if [ "\$SWAP_TOTAL" -ge 8192 ] 2>/dev/null; then
  pass "Swap: \${SWAP_TOTAL} MB"
else
  warn "Swap is only \${SWAP_TOTAL} MB — Oracle recommends at least equal to RAM for AMM, or at least 8 GB"
fi

echo ""
echo "=========================================="
echo "  Result: PASS=\$PASS  WARN=\$WARN  FAIL=\$FAIL"
[ "\$FAIL" -gt 0 ] && echo "  Fix failures before proceeding." || echo "  Ready to continue."
echo "=========================================="
\`\`\`

---

## Script 2: OS Kernel Parameters and Limits

Apply Oracle-required and VMware-optimised kernel settings. Run as root.

\`\`\`bash
#!/bin/bash
# oracle19c_os_config.sh — kernel params, limits, user/group, and directory setup
# Run as root on Oracle Linux 8

set -euo pipefail

echo "[$(date +%H:%M:%S)] Configuring OS for Oracle 19c on VMware..."

# ── Oracle required packages ───────────────────────────────────────────────
dnf install -y oracle-database-preinstall-19c || {
  echo "Falling back to manual package install..."
  dnf install -y bc binutils compat-openssl10 elfutils-libelf glibc glibc-devel \
    ksh libaio libaio-devel libgcc libnsl libstdc++ libstdc++-devel libXi \
    libXtst make net-tools smartmontools sysstat unixODBC unixODBC-devel
}

# ── Create Oracle user/groups if oracle-preinstall not used ───────────────
if ! id oracle &>/dev/null; then
  groupadd -g 54321 oinstall
  groupadd -g 54322 dba
  groupadd -g 54323 oper
  groupadd -g 54324 backupdba
  groupadd -g 54325 dgdba
  groupadd -g 54326 kmdba
  useradd -u 54321 -g oinstall -G dba,oper,backupdba,dgdba,kmdba \
    -d /home/oracle -s /bin/bash oracle
  echo "oracle ALL=(ALL) NOPASSWD: /sbin/service, /bin/systemctl" >> /etc/sudoers.d/oracle
  echo "[$(date +%H:%M:%S)] Oracle user created"
fi

# ── Kernel parameters ─────────────────────────────────────────────────────
cat >> /etc/sysctl.d/97-oracle-19c-vmware.conf << 'SYSCTL'
# Oracle 19c on VMware ESXi — kernel parameters
# Memory
kernel.shmmax = 137438953472
kernel.shmall = 33554432
kernel.shmmni = 4096
kernel.sem = 250 32000 100 128

# File handles
fs.file-max = 6815744
fs.aio-max-nr = 1048576

# Network
net.ipv4.ip_local_port_range = 9000 65500
net.core.rmem_default = 262144
net.core.rmem_max = 4194304
net.core.wmem_default = 262144
net.core.wmem_max = 1048576

# VMware-specific: reduce swappiness, avoid swapping Oracle SGA
vm.swappiness = 1
vm.dirty_ratio = 20
vm.dirty_background_ratio = 3

# Huge pages — calculate: (SGA_target_in_bytes / 2097152) + 64
# Example: 16 GB SGA = (17179869184 / 2097152) + 64 = 8256
# Set this to your calculated value:
vm.nr_hugepages = 8256
SYSCTL

sysctl --system
echo "[$(date +%H:%M:%S)] Kernel parameters applied"

# ── Security limits ────────────────────────────────────────────────────────
cat >> /etc/security/limits.d/97-oracle-19c.conf << 'LIMITS'
oracle   soft   nofile    1024
oracle   hard   nofile    65536
oracle   soft   nproc     16384
oracle   hard   nproc     16384
oracle   soft   stack     10240
oracle   hard   stack     32768
oracle   soft   memlock   134217728
oracle   hard   memlock   134217728
LIMITS
echo "[$(date +%H:%M:%S)] Security limits applied"

# ── PAM ───────────────────────────────────────────────────────────────────
grep -q "pam_limits" /etc/pam.d/login || echo "session required pam_limits.so" >> /etc/pam.d/login

# ── Disable THP (Transparent Huge Pages) ─────────────────────────────────
# Oracle requires THP disabled; Huge Pages (static) should be used instead
cat > /etc/systemd/system/disable-thp.service << 'THP'
[Unit]
Description=Disable Transparent Huge Pages
After=sysinit.target local-fs.target
Before=oracle.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/enabled'
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/defrag'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
THP

systemctl daemon-reload
systemctl enable --now disable-thp
echo "[$(date +%H:%M:%S)] THP disabled"

# ── Directory structure ────────────────────────────────────────────────────
mkdir -p \${ORA_BASE} \${ORA_HOME} \${ORA_DATA}/\${ORACLE_SID} \${ORA_FRA}/\${ORACLE_SID} \${ORA_INVENTORY}
chown -R oracle:oinstall \${ORA_BASE} \${ORA_DATA} \${ORA_FRA} \${ORA_INVENTORY}
chmod -R 755 \${ORA_BASE} \${ORA_DATA} \${ORA_FRA}
echo "[$(date +%H:%M:%S)] Directory structure created"

# ── Oracle bash profile ────────────────────────────────────────────────────
cat > /home/oracle/.bash_profile << PROFILE
# Oracle 19c environment
export ORACLE_BASE=\${ORA_BASE}
export ORACLE_HOME=\${ORA_HOME}
export ORACLE_SID=\${ORACLE_SID}
export PATH=\\\$ORACLE_HOME/bin:\\\$PATH
export LD_LIBRARY_PATH=\\\$ORACLE_HOME/lib:\\\$LD_LIBRARY_PATH
export CLASSPATH=\\\$ORACLE_HOME/jlib:\\\$ORACLE_HOME/rdbms/jlib
export NLS_DATE_FORMAT='YYYY-MM-DD HH24:MI:SS'
export NLS_LANG=AMERICAN_AMERICA.AL32UTF8
umask 022
PROFILE

chown oracle:oinstall /home/oracle/.bash_profile
echo "[$(date +%H:%M:%S)] Oracle bash profile written"
echo "[$(date +%H:%M:%S)] OS configuration complete — reboot recommended before Oracle install"
\`\`\`

---

## Script 3: Storage Preparation

Configure raw block devices (VMDKs added to VM) as Oracle data volumes. Run as root after adding disks in vSphere.

\`\`\`bash
#!/bin/bash
# oracle19c_storage_prep.sh — partition and format Oracle data disks
# Run as root. Adjust DATA_DISK and FRA_DISK to match your VM's disk layout.
# Verify disk names first: lsblk

DATA_DISK=/dev/sdb   # thick eager-zeroed VMDK for Oracle data files
FRA_DISK=/dev/sdc    # thick eager-zeroed VMDK for FRA (recovery area)
REDO_DISK=/dev/sdd   # thick eager-zeroed VMDK for redo logs (optional separate disk)

DATA_MOUNT=\${ORA_DATA}
FRA_MOUNT=\${ORA_FRA}

set -euo pipefail

echo "[$(date +%H:%M:%S)] Preparing Oracle storage disks..."
echo "  Data disk : \$DATA_DISK -> \$DATA_MOUNT"
echo "  FRA disk  : \$FRA_DISK  -> \$FRA_MOUNT"

confirm() {
  read -rp "  Confirm formatting \$1? All data will be lost. [yes/NO]: " ans
  [ "\$ans" = "yes" ] || { echo "Aborted."; exit 1; }
}

confirm "\$DATA_DISK"
confirm "\$FRA_DISK"

format_disk() {
  local DISK=\$1 MOUNT=\$2 LABEL=\$3
  echo "[$(date +%H:%M:%S)] Formatting \$DISK..."
  parted -s "\$DISK" mklabel gpt
  parted -s "\$DISK" mkpart primary xfs 1MiB 100%
  sleep 2
  mkfs.xfs -f -L "\$LABEL" "\${DISK}1"
  mkdir -p "\$MOUNT"
  DISK_UUID=\$(blkid -s UUID -o value "\${DISK}1")
  echo "UUID=\${DISK_UUID}  \${MOUNT}  xfs  defaults,noatime,nodiratime  0  2" >> /etc/fstab
  mount "\$MOUNT"
  chown oracle:oinstall "\$MOUNT"
  chmod 755 "\$MOUNT"
  echo "[$(date +%H:%M:%S)] \$DISK mounted at \$MOUNT"
}

format_disk "\$DATA_DISK" "\$DATA_MOUNT" "ORA_DATA"
format_disk "\$FRA_DISK"  "\$FRA_MOUNT"  "ORA_FRA"

# Optional: separate redo log disk
if [ -b "\$REDO_DISK" ]; then
  confirm "\$REDO_DISK"
  format_disk "\$REDO_DISK" "\${ORA_DATA}/redo" "ORA_REDO"
fi

# Verify I/O performance baseline with dd (write speed test)
echo ""
echo "[$(date +%H:%M:%S)] I/O baseline test (write throughput — thick VMDK should be consistent)..."
dd if=/dev/zero of=\${ORA_DATA}/iotest bs=1M count=1024 oflag=direct 2>&1 | tail -1
rm -f \${ORA_DATA}/iotest

echo "[$(date +%H:%M:%S)] Storage preparation complete"
df -h \${ORA_DATA} \${ORA_FRA}
\`\`\`

---

## Script 4: Oracle 19c Silent Installation

Silent install using a response file. Run as the oracle user. Download the Oracle 19c media (LINUX.X64_193000_db_home.zip) to /tmp first.

\`\`\`bash
#!/bin/bash
# oracle19c_install.sh — silent Oracle Database 19c installation
# Run as oracle user. Media must be at /tmp/LINUX.X64_193000_db_home.zip

set -euo pipefail
source ~/.bash_profile

ZIP=/tmp/LINUX.X64_193000_db_home.zip

[ -f "\$ZIP" ] || { echo "ERROR: Oracle 19c media not found at \$ZIP"; exit 1; }

echo "[$(date +%H:%M:%S)] Unzipping Oracle 19c media to \$ORACLE_HOME..."
mkdir -p "\$ORACLE_HOME"
unzip -q "\$ZIP" -d "\$ORACLE_HOME"
echo "[$(date +%H:%M:%S)] Unzip complete"

# ── Generate install response file ────────────────────────────────────────
cat > /tmp/oracle19c_install.rsp << RSP
oracle.install.responseFileVersion=/oracle/install/rspfmt_dbinstall_response_schema_v19.0.0
oracle.install.option=INSTALL_DB_SWONLY
UNIX_GROUP_NAME=oinstall
INVENTORY_LOCATION=\${ORA_INVENTORY}
ORACLE_HOME=\${ORA_HOME}
ORACLE_BASE=\${ORA_BASE}
oracle.install.db.InstallEdition=EE
oracle.install.db.OSDBA_GROUP=dba
oracle.install.db.OSOPER_GROUP=oper
oracle.install.db.OSBACKUPDBA_GROUP=backupdba
oracle.install.db.OSDGDBA_GROUP=dgdba
oracle.install.db.OSKMDBA_GROUP=kmdba
oracle.install.db.OSRACDBA_GROUP=dba
oracle.install.db.rootconfig.executeRootScript=false
oracle.install.db.config.starterdb.type=GENERAL_PURPOSE
RSP

echo "[$(date +%H:%M:%S)] Starting Oracle 19c software-only install..."
"\$ORACLE_HOME"/runInstaller -silent -ignorePrereqFailure \
  -responseFile /tmp/oracle19c_install.rsp

echo ""
echo "[$(date +%H:%M:%S)] Software installation complete."
echo "  Now run root scripts as root:"
echo "    \${ORA_INVENTORY}/orainstRoot.sh"
echo "    \${ORA_HOME}/root.sh"
\`\`\`

After the installer finishes, run as **root**:

\`\`\`bash
\${ORA_INVENTORY}/orainstRoot.sh
\${ORA_HOME}/root.sh
\`\`\`

---

## Script 5: Database Creation

Create the Oracle 19c database using DBCA in silent mode. Run as oracle after running root scripts.

\`\`\`bash
#!/bin/bash
# oracle19c_create_db.sh — create database with DBCA silent mode
# Run as oracle user after completing the software install and root scripts

set -euo pipefail
source ~/.bash_profile

SGA_SIZE=16384       # SGA target in MB — adjust based on available RAM
PGA_SIZE=4096        # PGA aggregate target in MB
REDO_SIZE=500        # Redo log group size in MB
CHARSET=AL32UTF8
NCHARSET=AL16UTF16
DB_PASSWORD=OracleChange_Me_19c   # change before running

echo "[$(date +%H:%M:%S)] Creating Oracle 19c database \$ORACLE_SID..."

dbca -silent -createDatabase \
  -templateName General_Purpose.dbc \
  -gdbname "\${ORACLE_SID}" \
  -sid "\${ORACLE_SID}" \
  -databaseType MULTIPURPOSE \
  -createAsContainerDatabase false \
  -sysPassword "\${DB_PASSWORD}" \
  -systemPassword "\${DB_PASSWORD}" \
  -oracleHomeUserPassword "\${DB_PASSWORD}" \
  -datafileDestination "\${ORA_DATA}/\${ORACLE_SID}" \
  -recoveryAreaDestination "\${ORA_FRA}/\${ORACLE_SID}" \
  -recoveryAreaSize 51200 \
  -redoLogFileSize "\${REDO_SIZE}" \
  -initParams "db_name=\${ORACLE_SID},db_unique_name=\${DB_UNIQUE_NAME},db_block_size=8192,\
sga_target=\${SGA_SIZE}M,pga_aggregate_target=\${PGA_SIZE}M,\
processes=500,open_cursors=300,\
nls_characterset=\${CHARSET},nls_nchar_characterset=\${NCHARSET},\
enable_pluggable_database=false,\
use_large_pages=TRUE,\
log_archive_dest_1='LOCATION=\${ORA_FRA}/\${ORACLE_SID}/arch',\
db_recovery_file_dest=\${ORA_FRA}/\${ORACLE_SID},\
db_recovery_file_dest_size=51200M" \
  -characterSet "\${CHARSET}" \
  -nationalCharacterSet "\${NCHARSET}" \
  -automaticMemoryManagement false \
  -totalMemory 0 \
  -databaseConfigType SINGLE \
  -listeners LISTENER

echo "[$(date +%H:%M:%S)] Database \$ORACLE_SID created successfully"
\`\`\`

---

## Script 6: VMware-Specific Post-Install Tuning

Apply Oracle parameters optimised for VMware guest operation. Run as oracle after database creation.

\`\`\`bash
#!/bin/bash
# oracle19c_vmware_tuning.sql — post-install parameter tuning for VMware guest
# Run as oracle user

source ~/.bash_profile

sqlplus -s / as sysdba << 'SQLEOF'
-- Confirm huge pages are in use (should show YES if vm.nr_hugepages set correctly)
SELECT name, value FROM v\$parameter WHERE name = 'use_large_pages';

-- Lock SGA in memory — prevents VMware balloon driver from reclaiming SGA pages
-- Requires huge pages to be configured at OS level
ALTER SYSTEM SET lock_sga = TRUE SCOPE=SPFILE;

-- Disable AMM (Automatic Memory Management) — incompatible with huge pages
-- Use ASMM (SGA_TARGET + PGA_AGGREGATE_TARGET) instead
ALTER SYSTEM SET memory_target = 0 SCOPE=SPFILE;
ALTER SYSTEM SET memory_max_target = 0 SCOPE=SPFILE;

-- Optimise for VMware PVSCSI storage (sequential read-ahead = 0 for OLTP)
ALTER SYSTEM SET db_file_multiblock_read_count = 128 SCOPE=SPFILE;

-- Reduce idle process overhead (useful when VM is co-tenanted)
ALTER SYSTEM SET idle_time = 30 SCOPE=BOTH;

-- Enable resource manager to prevent runaway queries in shared host scenarios
ALTER SYSTEM SET resource_manager_plan = 'DEFAULT_PLAN' SCOPE=BOTH;

-- Confirm listener is registered
SELECT inst_id, instance_name, host_name, status, database_status
FROM   gv\$instance;

-- Record spfile location
SHOW PARAMETER spfile;

SHUTDOWN IMMEDIATE;
STARTUP;

SELECT name, value, description
FROM   v\$parameter
WHERE  name IN ('lock_sga','use_large_pages','sga_target','pga_aggregate_target',
                'memory_target','db_file_multiblock_read_count','processes')
ORDER BY name;
SQLEOF

echo "[$(date +%H:%M:%S)] VMware-specific tuning applied and database restarted"
\`\`\`

---

## Script 7: Full Post-Install Validation

\`\`\`bash
#!/bin/bash
# oracle19c_validate.sh — post-install validation for Oracle 19c on VMware
# Run as oracle user

source ~/.bash_profile

PASS=0; WARN=0; FAIL=0
pass() { echo "  [PASS] \$1"; ((PASS++)); }
warn() { echo "  [WARN] \$1"; ((WARN++)); }
fail() { echo "  [FAIL] \$1"; ((FAIL++)); }

echo "=========================================="
echo "  Oracle 19c on VMware — Post-Install Validation"
echo "  \$(date)"
echo "=========================================="

# ── Database up ────────────────────────────────────────────────────────────
DB_STATUS=\$(sqlplus -s / as sysdba <<< "SELECT status FROM v\\\$instance;" 2>/dev/null | grep -E "OPEN|MOUNTED|STARTED" | head -1 | tr -d ' ')
if [ "\$DB_STATUS" = "OPEN" ]; then
  pass "Database is OPEN"
else
  fail "Database status: '\${DB_STATUS}' (expected OPEN)"
fi

# ── Listener ──────────────────────────────────────────────────────────────
if lsnrctl status 2>/dev/null | grep -q "status READY"; then
  pass "Oracle Listener is READY"
else
  fail "Oracle Listener not ready — check lsnrctl status"
fi

# ── LOCK_SGA ──────────────────────────────────────────────────────────────
LOCK_SGA=\$(sqlplus -s / as sysdba <<< "SELECT value FROM v\\\$parameter WHERE name='lock_sga';" 2>/dev/null | grep -E "TRUE|FALSE" | tr -d ' ')
if [ "\$LOCK_SGA" = "TRUE" ]; then
  pass "LOCK_SGA=TRUE — SGA protected from VMware balloon driver"
else
  fail "LOCK_SGA=\${LOCK_SGA} — set to TRUE to protect SGA from balloon driver"
fi

# ── Huge pages in use ─────────────────────────────────────────────────────
LARGE_PAGES=\$(sqlplus -s / as sysdba <<< "SELECT value FROM v\\\$parameter WHERE name='use_large_pages';" 2>/dev/null | grep -E "TRUE|FALSE|ONLY" | tr -d ' ')
HP_FREE=\$(grep HugePages_Free /proc/meminfo | awk '{print \$2}')
if [ "\$LARGE_PAGES" = "TRUE" ] || [ "\$LARGE_PAGES" = "ONLY" ]; then
  if [ "\$HP_FREE" -gt 0 ] 2>/dev/null; then
    pass "Huge pages in use — \${HP_FREE} pages remaining"
  else
    warn "use_large_pages=\${LARGE_PAGES} but HugePages_Free=0 — all pages consumed or misconfigured"
  fi
else
  warn "Huge pages not active (use_large_pages=\${LARGE_PAGES}) — SGA may be pageable"
fi

# ── Data file I/O latency ─────────────────────────────────────────────────
IO_RESULT=\$(sqlplus -s / as sysdba << 'SQLEOF' 2>/dev/null
SET PAGES 0 FEEDBACK OFF
SELECT ROUND(SUM(readtim) / GREATEST(SUM(phyrds),1), 3)
FROM   v\$filestat;
SQLEOF
)
IO_MS=\$(echo "\$IO_RESULT" | grep -oP '[0-9]+\.[0-9]+' | head -1)
if [ -n "\$IO_MS" ]; then
  IO_INT=\$(echo "\$IO_MS" | cut -d. -f1)
  if [ "\$IO_INT" -lt 2 ] 2>/dev/null; then
    pass "Average data file read latency: \${IO_MS} ms (< 2 ms — good)"
  elif [ "\$IO_INT" -lt 5 ] 2>/dev/null; then
    warn "Average data file read latency: \${IO_MS} ms (< 5 ms — acceptable, check VMDK provisioning)"
  else
    fail "Average data file read latency: \${IO_MS} ms (> 5 ms — investigate storage)"
  fi
fi

# ── Oracle version ────────────────────────────────────────────────────────
ORA_VER=\$(sqlplus -s / as sysdba <<< "SELECT version_full FROM v\\\$instance;" 2>/dev/null | grep -oP '19\.[0-9]+\.[0-9]+\.[0-9]+' | head -1)
if echo "\$ORA_VER" | grep -q "^19\."; then
  pass "Oracle version: \$ORA_VER"
else
  warn "Could not confirm Oracle 19c version (got: '\$ORA_VER')"
fi

# ── Archive log mode ─────────────────────────────────────────────────────
ARCHMODE=\$(sqlplus -s / as sysdba <<< "SELECT log_mode FROM v\\\$database;" 2>/dev/null | grep -E "ARCHIVELOG|NOARCHIVELOG" | tr -d ' ')
if [ "\$ARCHMODE" = "ARCHIVELOG" ]; then
  pass "Database is in ARCHIVELOG mode"
else
  warn "Database is in NOARCHIVELOG mode — enable before production cutover: ALTER DATABASE ARCHIVELOG;"
fi

echo ""
echo "=========================================="
echo "  Result: PASS=\$PASS  WARN=\$WARN  FAIL=\$FAIL"
[ "\$FAIL" -gt 0 ] && echo "  Address failures before production use." || echo "  All critical checks passed."
echo "=========================================="
\`\`\`
`,
};

async function main() {
  for (const post of [blogPost, runbookPost]) {
    await db
      .insert(posts)
      .values({
        title: post.title,
        slug: post.slug,
        excerpt: post.excerpt,
        content: post.content,
        category: post.category,
        youtubeUrl: post.youtubeUrl,
        isPremium: post.isPremium,
        published: post.published,
        publishedAt: post.publishedAt,
      })
      .onConflictDoUpdate({
        target: posts.slug,
        set: {
          title: post.title,
          excerpt: post.excerpt,
          content: post.content,
          isPremium: post.isPremium,
          published: post.published,
          publishedAt: post.publishedAt,
        },
      });
    console.log('inserted:', post.slug);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
