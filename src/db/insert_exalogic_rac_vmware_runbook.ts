import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle RAC on RHEL 9 / VMware ESXi: Step-by-Step Deployment Runbook',
  slug: 'oracle-rac-rhel9-vmware-esxi-deployment-runbook',
  excerpt:
    'Step-by-step runbook for deploying a two-node Oracle RAC cluster on RHEL 9 VMs inside VMware vCenter — covering PVSCSI multi-writer VMDK creation, VM anti-affinity rules, memory reservations, private interconnect MTU 9000 configuration, RHEL 9 kernel preparation, UDEV ASM disk naming, Grid Infrastructure silent install, database creation, and post-deployment validation with troubleshooting reference.',
  category: 'exalogic' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-13'),
  youtubeUrl: null,
  content: `## Environment Reference

| Parameter | Value |
|-----------|-------|
| vCenter version | vCenter 7.x or 8.x |
| ESXi version | 7.0 U3+ or 8.0 |
| Guest OS | RHEL 9.x or Oracle Linux 9.x |
| Oracle Grid version | 19c (19.18+ for cgroup v2) |
| Oracle DB version | 19c |
| Node 1 hostname | racnode1.corp.local |
| Node 2 hostname | racnode2.corp.local |
| Public network | 10.10.1.0/24 |
| Private interconnect 1 | 169.254.10.0/24 |
| Private interconnect 2 | 169.254.11.0/24 |
| SCAN name | rac-scan.corp.local (3 A records) |
| ASM: OCR/Voting | 3 × 10 GB VMDKs |
| ASM: DATA | 2 × 500 GB VMDKs |
| ASM: FRA | 1 × 300 GB VMDK |

---

## Phase 1 — VMware: Storage Preparation

### 1.1 Create a Dedicated VMFS Datastore

In vSphere Client:

\`\`\`
Storage → Datastores → New Datastore
Type:     VMFS 6
Name:     RAC-ASM-DS
LUN:      Dedicated SAN LUN or local SSD — NOT NFS
\`\`\`

NFS datastores do not support the multi-writer SCSI reservation semantics that ASM requires. Use VMFS only.

### 1.2 Create Shared VMDKs (Thick Eager Zeroed)

SSH to an ESXi host (enable SSH via vSphere Client → Host → Manage → Services):

\`\`\`bash
# OCR / Voting disks (3 × 10 GB)
vmkfstools -c 10G -d eagerzeroedthick /vmfs/volumes/RAC-ASM-DS/asm_ocr1.vmdk
vmkfstools -c 10G -d eagerzeroedthick /vmfs/volumes/RAC-ASM-DS/asm_ocr2.vmdk
vmkfstools -c 10G -d eagerzeroedthick /vmfs/volumes/RAC-ASM-DS/asm_ocr3.vmdk

# DATA disk group (2 × 500 GB)
vmkfstools -c 500G -d eagerzeroedthick /vmfs/volumes/RAC-ASM-DS/asm_data01.vmdk
vmkfstools -c 500G -d eagerzeroedthick /vmfs/volumes/RAC-ASM-DS/asm_data02.vmdk

# FRA disk group (1 × 300 GB)
vmkfstools -c 300G -d eagerzeroedthick /vmfs/volumes/RAC-ASM-DS/asm_fra01.vmdk
\`\`\`

Thick eager zeroed means all blocks are pre-allocated and zeroed at creation time. This eliminates first-write latency spikes and ensures ASM's block-zeroing expectations are met.

---

## Phase 2 — VMware: VM Creation

### 2.1 Create Both VMs

Create two identical VMs in vSphere Client with these settings:

\`\`\`
Guest OS:     Red Hat Enterprise Linux 9 (64-bit)
vCPUs:        8
Memory:       64 GB
OS Disk:      100 GB thin (on a separate private datastore)
NIC 1 (eth0): Production VLAN portgroup   — VMXNET3
NIC 2 (eth1): RAC-Private-VLAN-1          — VMXNET3
NIC 3 (eth2): RAC-Private-VLAN-2          — VMXNET3
SCSI 0:       VMware Paravirtual (PVSCSI)  — for OS disk
SCSI 1:       VMware Paravirtual (PVSCSI)  — for shared ASM disks
\`\`\`

Add a second PVSCSI controller (SCSI 1) for the shared disks — keeps ASM disk enumeration separate from the OS disk.

### 2.2 Set SCSI Bus Sharing

On the shared PVSCSI controller (SCSI 1) in VM Settings → SCSI Controller:

\`\`\`
SCSI Bus Sharing: Virtual
\`\`\`

### 2.3 Attach Shared VMDKs with Multi-Writer

Power off both VMs. In vSphere Client → racnode1 → Edit Settings → Add Hard Disk → Existing Hard Disk, add each ASM VMDK to SCSI 1. After adding each:

\`\`\`
Disk Mode:   Independent - Persistent
Sharing:     Multi-writer
\`\`\`

Repeat for racnode2 — attach the same VMDKs to the same SCSI 1 slots on both VMs.

Verify via SSH to ESXi:

\`\`\`bash
grep "sharing" /vmfs/volumes/*/racnode1/*.vmx
# Each shared disk should show: scsi1:N.sharing = "multi-writer"
\`\`\`

Also confirm:

\`\`\`bash
grep "disk.EnableUUID" /vmfs/volumes/*/racnode1/*.vmx
# Must show: disk.EnableUUID = "TRUE"
# Add it manually if missing — required for UDEV SCSI ID detection
\`\`\`

### 2.4 Set Memory Reservation

vSphere Client → racnode1 → Edit Settings → VM Options → Resources → Memory:

\`\`\`
Reservation: 65536 MB  (= 64 GB)
\`\`\`

Repeat for racnode2. This prevents the ESXi balloon driver from reclaiming any Oracle SGA pages.

### 2.5 Set Private NIC MTU

In vSphere Client, find the dvSwitch port group used for RAC-Private-VLAN-1 and RAC-Private-VLAN-2:

\`\`\`
dvSwitch → Configure → Settings → Properties → MTU: 9000
Port Group (RAC-Private-VLAN-1) → Edit → General → MTU: 9000
Port Group (RAC-Private-VLAN-2) → Edit → General → MTU: 9000
\`\`\`

### 2.6 Create Anti-Affinity DRS Rule

\`\`\`
vSphere Client → Cluster → Configure → Configuration → VM/Host Rules → Add
Name:    RAC-Nodes-Separate
Type:    Separate Virtual Machines
Members: racnode1, racnode2
\`\`\`

Power on both VMs and verify they land on different ESXi hosts.

---

## Phase 3 — RHEL 9 OS Configuration

Perform all steps in this phase on **both nodes** unless noted.

### 3.1 Set Hostnames and /etc/hosts

\`\`\`bash
# On racnode1:
hostnamectl set-hostname racnode1.corp.local

# On racnode2:
hostnamectl set-hostname racnode2.corp.local
\`\`\`

Add to \`/etc/hosts\` on both nodes:

\`\`\`
# Public
10.10.1.11   racnode1.corp.local   racnode1
10.10.1.12   racnode2.corp.local   racnode2
# VIPs
10.10.1.21   racnode1-vip.corp.local   racnode1-vip
10.10.1.22   racnode2-vip.corp.local   racnode2-vip
# SCAN
10.10.1.30   rac-scan.corp.local
10.10.1.31   rac-scan.corp.local
10.10.1.32   rac-scan.corp.local
# Private
169.254.10.11  racnode1-priv1
169.254.10.12  racnode2-priv1
169.254.11.11  racnode1-priv2
169.254.11.12  racnode2-priv2
\`\`\`

### 3.2 Configure Network Interfaces

\`\`\`bash
# Public (racnode1 — adjust IP for racnode2):
nmcli con mod eth0 ipv4.addresses 10.10.1.11/24 ipv4.gateway 10.10.1.1 ipv4.method manual
nmcli con mod eth0 connection.autoconnect yes

# Private interconnect 1 (racnode1):
nmcli con mod eth1 ipv4.addresses 169.254.10.11/24 ipv4.method manual
nmcli con mod eth1 802-3-ethernet.mtu 9000 connection.autoconnect yes

# Private interconnect 2 (racnode1):
nmcli con mod eth2 ipv4.addresses 169.254.11.11/24 ipv4.method manual
nmcli con mod eth2 802-3-ethernet.mtu 9000 connection.autoconnect yes

nmcli con up eth0 && nmcli con up eth1 && nmcli con up eth2
\`\`\`

Verify MTU and test Jumbo Frames:

\`\`\`bash
ip link show eth1 | grep mtu         # should show mtu 9000
ping -M do -s 8972 -c 5 169.254.10.12  # 0% packet loss = Jumbo Frames OK
\`\`\`

### 3.3 Disable Transparent Huge Pages

\`\`\`bash
grubby --update-kernel=ALL --args="transparent_hugepage=never"
reboot

# After reboot — verify:
cat /sys/kernel/mm/transparent_hugepage/enabled
# Expected: always madvise [never]
\`\`\`

### 3.4 Install Oracle Preinstall RPM

\`\`\`bash
# Oracle Linux 9:
dnf install -y oracle-database-preinstall-19c

# If not available, manually install required packages:
dnf install -y bc binutils compat-openssl11 elfutils-libelf glibc glibc-devel \
  ksh libaio libaio-devel libXrender libX11 libXau libXi libXtst libgcc \
  libstdc++ libstdc++-devel make net-tools nfs-utils sysstat unzip xorg-x11-utils
\`\`\`

Review the users and groups created:

\`\`\`bash
id oracle && id grid
grep -E "^(oinstall|dba|oper|asm|asmadmin|asmdba|backupdba|kmdba|racdba)" /etc/group
\`\`\`

### 3.5 Set Kernel Parameters

\`\`\`bash
cat > /etc/sysctl.d/98-oracle-rac.conf << 'EOF'
kernel.sem = 250 32000 100 128
kernel.shmmax = 137438953472
kernel.shmall = 33554432
kernel.shmmni = 4096
fs.aio-max-nr = 1048576
fs.file-max = 6815744
net.core.rmem_max = 4194304
net.core.wmem_max = 1048576
net.core.rmem_default = 262144
net.core.wmem_default = 262144
net.ipv4.conf.all.rp_filter = 2
net.ipv4.conf.default.rp_filter = 2
EOF

sysctl -p /etc/sysctl.d/98-oracle-rac.conf
\`\`\`

### 3.6 Configure Chrony

\`\`\`bash
cat > /etc/chrony.conf << 'EOF'
server 169.254.0.1 iburst prefer
makestep 1.0 3
driftfile /var/lib/chrony/drift
logdir /var/log/chrony
EOF

systemctl restart chronyd
chronyc tracking    # verify sync source
\`\`\`

### 3.7 Create Directory Layout

\`\`\`bash
mkdir -p /u01/app/grid /u01/app/19.0.0/grid
mkdir -p /u01/app/oracle/product/19.0.0/dbhome_1
mkdir -p /u01/app/oraInventory

chown -R grid:oinstall   /u01/app/grid /u01/app/19.0.0 /u01/app/oraInventory
chown -R oracle:oinstall /u01/app/oracle
chmod -R 775 /u01
\`\`\`

---

## Phase 4 — UDEV Rules for ASM Disks

### 4.1 Identify SCSI IDs (run on racnode1)

\`\`\`bash
for dev in sdb sdc sdd sde sdf sdg; do
  id=$(/usr/lib/udev/scsi_id -g -u -d /dev/\${dev} 2>/dev/null)
  echo "/dev/\${dev} → \${id}"
done
\`\`\`

Record the output. Map each ID to its disk purpose (ocr1, ocr2, ocr3, data01, data02, fra01).

### 4.2 Create UDEV Rules (both nodes — same file)

\`\`\`bash
cat > /etc/udev/rules.d/99-oracle-asm.rules << 'EOF'
KERNEL=="sd[a-z]", SUBSYSTEM=="block", PROGRAM=="/usr/lib/udev/scsi_id -g -u -d /dev/%k", RESULT=="<ocr1_id>",   SYMLINK+="oracleasm/asm-ocr1",   OWNER="grid", GROUP="asmadmin", MODE="0660"
KERNEL=="sd[a-z]", SUBSYSTEM=="block", PROGRAM=="/usr/lib/udev/scsi_id -g -u -d /dev/%k", RESULT=="<ocr2_id>",   SYMLINK+="oracleasm/asm-ocr2",   OWNER="grid", GROUP="asmadmin", MODE="0660"
KERNEL=="sd[a-z]", SUBSYSTEM=="block", PROGRAM=="/usr/lib/udev/scsi_id -g -u -d /dev/%k", RESULT=="<ocr3_id>",   SYMLINK+="oracleasm/asm-ocr3",   OWNER="grid", GROUP="asmadmin", MODE="0660"
KERNEL=="sd[a-z]", SUBSYSTEM=="block", PROGRAM=="/usr/lib/udev/scsi_id -g -u -d /dev/%k", RESULT=="<data01_id>", SYMLINK+="oracleasm/asm-data01", OWNER="grid", GROUP="asmadmin", MODE="0660"
KERNEL=="sd[a-z]", SUBSYSTEM=="block", PROGRAM=="/usr/lib/udev/scsi_id -g -u -d /dev/%k", RESULT=="<data02_id>", SYMLINK+="oracleasm/asm-data02", OWNER="grid", GROUP="asmadmin", MODE="0660"
KERNEL=="sd[a-z]", SUBSYSTEM=="block", PROGRAM=="/usr/lib/udev/scsi_id -g -u -d /dev/%k", RESULT=="<fra01_id>",  SYMLINK+="oracleasm/asm-fra01",  OWNER="grid", GROUP="asmadmin", MODE="0660"
EOF

udevadm control --reload-rules && udevadm trigger
ls -la /dev/oracleasm/    # verify 6 symlinks
\`\`\`

### 4.3 Create GI Boot Ordering Unit (both nodes)

\`\`\`bash
cat > /etc/systemd/system/udev-settle-asm.service << 'EOF'
[Unit]
Description=Settle udev before Oracle Grid Infrastructure
Before=ohas.service
After=local-fs.target

[Service]
Type=oneshot
ExecStart=/usr/bin/udevadm settle --timeout=30
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload && systemctl enable udev-settle-asm.service
\`\`\`

---

## Phase 5 — SSH User Equivalence (both users, both directions)

\`\`\`bash
# On racnode1 as grid:
su - grid
ssh-keygen -t rsa -N "" -f ~/.ssh/id_rsa -q
ssh-copy-id grid@racnode2
ssh racnode2 hostname    # should return racnode2

# On racnode2 as grid:
su - grid
ssh-keygen -t rsa -N "" -f ~/.ssh/id_rsa -q
ssh-copy-id grid@racnode1
ssh racnode1 hostname

# Repeat for oracle user on both nodes (same commands, su - oracle)
\`\`\`

---

## Phase 6 — Grid Infrastructure Installation

### 6.1 Stage Grid Home (racnode1 as grid)

\`\`\`bash
su - grid
cd /u01/app/19.0.0/grid
unzip /tmp/LINUX.X64_193000_grid_home.zip
\`\`\`

### 6.2 Create Response File

\`\`\`bash
cat > /tmp/grid.rsp << 'EOF'
oracle.install.responseFileVersion=/oracle/install/rspfmt_crsinstall_response_schema_v19.0.0
INVENTORY_LOCATION=/u01/app/oraInventory
oracle.install.option=CRS_CONFIG
ORACLE_BASE=/u01/app/grid
oracle.install.asm.OSDBA=asmdba
oracle.install.asm.OSOPER=asmoper
oracle.install.asm.OSASM=asmadmin
oracle.install.crs.config.scanType=LOCAL_SCAN
oracle.install.crs.config.gpnp.scanName=rac-scan.corp.local
oracle.install.crs.config.gpnp.scanPort=1521
oracle.install.crs.config.clusterName=rac-cluster-01
oracle.install.crs.config.clusterNodes=racnode1:racnode1-vip:HUB,racnode2:racnode2-vip:HUB
oracle.install.crs.config.networkInterfaceList=eth0:10.10.1.0:1,eth1:169.254.10.0:5:active,eth2:169.254.11.0:5:active
oracle.install.crs.config.storageOption=ASM
oracle.install.crs.config.useIPMI=false
oracle.install.asm.diskGroup.name=OCR
oracle.install.asm.diskGroup.redundancy=NORMAL
oracle.install.asm.diskGroup.AUSize=4
oracle.install.asm.diskGroup.disks=/dev/oracleasm/asm-ocr1,/dev/oracleasm/asm-ocr2,/dev/oracleasm/asm-ocr3
oracle.install.asm.diskGroup.diskDiscoveryString=/dev/oracleasm/*
oracle.install.asm.monitorPassword=WelcomeGrid1#
oracle.install.config.managementOption=NONE
oracle.install.crs.rootconfig.configMethod=ROOT
EOF
\`\`\`

### 6.3 Run Silent Install

\`\`\`bash
/u01/app/19.0.0/grid/gridSetup.sh -silent \
  -responseFile /tmp/grid.rsp \
  -ignorePrereqFailure
\`\`\`

Watch the log: \`tail -f /tmp/GridSetup*.log\`

When prompted, run as **root**:

\`\`\`bash
# racnode1 first:
/u01/app/oraInventory/orainstRoot.sh
/u01/app/19.0.0/grid/root.sh

# Then racnode2:
/u01/app/oraInventory/orainstRoot.sh
/u01/app/19.0.0/grid/root.sh
\`\`\`

Press Enter in the installer after both root.sh scripts complete.

### 6.4 Verify Cluster

\`\`\`bash
# As grid:
crsctl stat res -t        # All resources ONLINE on both nodes
crsctl check crs          # CRS is healthy
asmcmd lsdg               # OCR disk group MOUNTED
\`\`\`

---

## Phase 7 — Create DATA and FRA Disk Groups

\`\`\`sql
-- Connect as sysdba to ASM:
sqlplus / as sysasm

CREATE DISKGROUP DATA EXTERNAL REDUNDANCY
  DISK '/dev/oracleasm/asm-data01', '/dev/oracleasm/asm-data02'
  ATTRIBUTE 'AU_SIZE'='4M';

CREATE DISKGROUP FRA EXTERNAL REDUNDANCY
  DISK '/dev/oracleasm/asm-fra01'
  ATTRIBUTE 'AU_SIZE'='4M';

SELECT name, state, total_mb, free_mb FROM v\$asm_diskgroup;
\`\`\`

---

## Phase 8 — Oracle Database Software Installation

### 8.1 Stage DB Home (both nodes as oracle)

\`\`\`bash
su - oracle
mkdir -p /u01/app/oracle/product/19.0.0/dbhome_1
cd /u01/app/oracle/product/19.0.0/dbhome_1
unzip /tmp/LINUX.X64_193000_db_home.zip
\`\`\`

### 8.2 Silent Install

\`\`\`bash
cat > /tmp/db.rsp << 'EOF'
oracle.install.responseFileVersion=/oracle/install/rspfmt_dbinstall_response_schema_v19.0.0
oracle.install.option=INSTALL_DB_SWONLY
UNIX_GROUP_NAME=oinstall
INVENTORY_LOCATION=/u01/app/oraInventory
ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
ORACLE_BASE=/u01/app/oracle
oracle.install.db.InstallEdition=EE
oracle.install.db.OSDBA_GROUP=dba
oracle.install.db.OSOPER_GROUP=oper
oracle.install.db.OSBACKUPDBA_GROUP=backupdba
oracle.install.db.OSDGDBA_GROUP=dba
oracle.install.db.OSKMDBA_GROUP=kmdba
oracle.install.db.OSRACDBA_GROUP=racdba
oracle.install.db.rootconfig.configMethod=ROOT
oracle.install.db.CLUSTER_NODES=racnode1,racnode2
EOF

/u01/app/oracle/product/19.0.0/dbhome_1/runInstaller -silent \
  -responseFile /tmp/db.rsp -ignorePrereqFailure
\`\`\`

Run root.sh on both nodes when prompted:

\`\`\`bash
/u01/app/oracle/product/19.0.0/dbhome_1/root.sh
\`\`\`

---

## Phase 9 — Create RAC Database

\`\`\`bash
su - oracle
dbca -silent \
  -createDatabase \
  -templateName General_Purpose.dbc \
  -gdbName ORCL \
  -sid ORCL \
  -createAsContainerDatabase false \
  -sysPassword WelcomeDB1# \
  -systemPassword WelcomeDB1# \
  -storageType ASM \
  -diskGroupName DATA \
  -recoveryAreaDest FRA \
  -recoveryAreaSize 51200 \
  -characterSet AL32UTF8 \
  -totalMemory 8192 \
  -databaseType MULTIPURPOSE \
  -nodeinfo racnode1,racnode2 \
  -emConfiguration NONE
\`\`\`

---

## Phase 10 — Post-Deployment Validation

### 10.1 Cluster Resource Status

\`\`\`bash
crsctl stat res -t
# Expected: all resources ONLINE on both nodes
\`\`\`

### 10.2 Verify Interconnect Uses Private NICs

\`\`\`bash
oifcfg getif
# eth0 → public
# eth1 → cluster_interconnect
# eth2 → cluster_interconnect
\`\`\`

\`\`\`sql
SELECT * FROM v\$cluster_interconnects;
-- IP column must show 169.254.x.x, NOT 10.10.1.x
\`\`\`

If wrong:

\`\`\`bash
oifcfg setif -global eth0/10.10.1.0:public
oifcfg setif -global eth1/169.254.10.0:cluster_interconnect
oifcfg setif -global eth2/169.254.11.0:cluster_interconnect
\`\`\`

### 10.3 Verify Jumbo Frames

\`\`\`bash
ping -M do -s 8972 -c 10 169.254.10.12
# 0% packet loss required
\`\`\`

### 10.4 SCAN Connectivity

\`\`\`bash
nslookup rac-scan.corp.local    # 3 A records
tnsping //rac-scan.corp.local:1521/ORCL
\`\`\`

### 10.5 Instance Failover Test

\`\`\`bash
# Stop instance 1:
srvctl stop instance -d ORCL -i ORCL1

# Connect via SCAN — should land on ORCL2:
sqlplus system/WelcomeDB1#@//rac-scan.corp.local:1521/ORCL
# SQL> SELECT instance_name FROM v\$instance;   -- should return ORCL2

# Restart instance 1:
srvctl start instance -d ORCL -i ORCL1
\`\`\`

### 10.6 dvSwitch Security Policy Check

\`\`\`
vSphere Client → dvSwitch → Port Group (Public) → Edit → Security:
  Promiscuous Mode:  Accept
  MAC Address Changes: Accept
  Forged Transmits:  Accept
\`\`\`

This is required for VIP and SCAN VIP gratuitous ARP to work across nodes.

---

## Phase 11 — Daily Health Check Script

\`\`\`bash
#!/bin/bash
# /home/grid/bin/rac_daily_check.sh — run as grid user on racnode1

LOG="/home/grid/logs/rac_check_$(date +%Y%m%d_%H%M).log"
mkdir -p /home/grid/logs
exec > "\${LOG}" 2>&1

echo "=== RAC Daily Health Check: $(date) ==="

section() { echo ""; echo "--- \$1 ---"; }

section "Cluster Resource Status"
crsctl stat res -t

section "CRS Health"
crsctl check crs

section "ASM Disk Groups"
asmcmd lsdg

section "Database Instance Status"
srvctl status database -d ORCL -verbose

section "SCAN Status"
srvctl status scan
srvctl status scan_listener

section "Voting Disks"
crsctl query css votedisk

section "Interconnect Config"
oifcfg getif

section "Jumbo Frame Test"
ping -M do -s 8972 -c 3 169.254.10.12 && echo "OK" || echo "FAIL — check MTU"
ping -M do -s 8972 -c 3 169.254.11.12 && echo "OK" || echo "FAIL — check MTU"

section "Alert Log Errors (24h)"
for node in racnode1 racnode2; do
  echo "Node: \${node}"
  alog="/u01/app/grid/diag/crs/\${node}/crs/trace/alert.log"
  [ -f "\${alog}" ] && grep -E "ORA-|CRS-[0-9]{4}[1-9]|Error" "\${alog}" \
    | awk -v d="\$(date -d '24 hours ago' '+%Y-%m-%d')" '\$0 >= d' | tail -20
done

echo ""
echo "=== Check Complete: $(date) ==="
\`\`\`

\`\`\`bash
chmod +x /home/grid/bin/rac_daily_check.sh

# Crontab entry (grid user):
# 0 7 * * * /home/grid/bin/rac_daily_check.sh
\`\`\`

---

## Troubleshooting Quick Reference

| Symptom | Cause | Fix |
|---------|-------|-----|
| ASM disks missing after reboot | udev settles after ohas starts | Enable \`udev-settle-asm.service\` |
| Cache Fusion on public NIC | oifcfg wrong assignment | \`oifcfg setif -global eth1/169.254.10.0:cluster_interconnect\` |
| Jumbo frame ping fails | MTU mismatch at vSwitch or physical switch | Set portgroup MTU to 9000 in vSphere |
| Node eviction after vMotion | Stun exceeded misscount | Drain instance before vMotion |
| VIP ARP not forwarded | Forged Transmits: Reject on dvSwitch | Set portgroup Security to Accept |
| Memory balloon alerts | No memory reservation | Set 100% reservation in VM settings |
| SCAN DNS resolving < 3 IPs | DNS misconfiguration | Verify 3 A records for SCAN name |
| ORA-15032 on ASM CREATE | VMDK not multi-writer on all nodes | Check \`scsi1:N.sharing = "multi-writer"\` in both VMX files |`,
};

async function main() {
  console.log('Inserting Oracle RAC on VMware (Exalogic) runbook...');
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
