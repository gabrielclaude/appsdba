import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle RAC on VMware RHEL 9: Complete Deployment Runbook',
  slug: 'oracle-rac-vmware-rhel9-runbook',
  excerpt:
    'Step-by-step runbook for deploying Oracle Grid Infrastructure 19c and Oracle Database 19c in a two-node RAC cluster on VMware ESXi with RHEL 9 — covering VM creation, PVSCSI shared VMDK configuration, multi-writer attributes, RHEL 9 OS preparation, UDEV ASM disk naming, Grid Infrastructure silent install, and post-deployment validation.',
  category: 'rac-clusterware' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-13'),
  youtubeUrl: null,
  content: `## Environment Assumptions

| Parameter | Value |
|-----------|-------|
| ESXi version | 7.0 U3 or 8.0 |
| Guest OS | RHEL 9.x / Oracle Linux 9.x |
| Oracle GI version | 19c (19.18+) |
| Oracle DB version | 19c |
| RAC nodes | racnode1, racnode2 |
| Public network | 10.10.1.0/24 |
| Private interconnect | 169.254.10.0/24, 169.254.11.0/24 |
| SCAN name | rac-scan.corp.local (resolves to 3 IPs) |
| ASM disk groups | OCR (voting, 3 × 10 GB), DATA (2 × 500 GB), FRA (1 × 300 GB) |

---

## Phase 1 — VMware Storage Preparation

Shared VMDKs must be created on a VMFS datastore (not NFS — NFS datastores do not support multi-writer locking semantics for ASM).

### 1.1 Create a Dedicated VMFS Datastore for ASM Disks

In vSphere Client:

\`\`\`
Storage → Datastores → New Datastore → VMFS
Name: RAC-ASM-Datastore
Select LUN: <dedicated SAN LUN or local SSD>
VMFS version: 6
\`\`\`

### 1.2 Create Shared VMDKs

Create each VMDK from the vSphere Client datastore browser, or via SSH to an ESXi host:

\`\`\`bash
# SSH to ESXi host (enable SSH in vSphere Client → Host → Manage → Services)
ssh root@esxi01

# Create OCR/Voting disks (thin provisioning is NOT recommended for ASM — use thick eager zeroed)
vmkfstools -c 10G -d eagerzeroedthick /vmfs/volumes/RAC-ASM-Datastore/asm_ocr1.vmdk
vmkfstools -c 10G -d eagerzeroedthick /vmfs/volumes/RAC-ASM-Datastore/asm_ocr2.vmdk
vmkfstools -c 10G -d eagerzeroedthick /vmfs/volumes/RAC-ASM-Datastore/asm_ocr3.vmdk

# Create DATA disk group disks
vmkfstools -c 500G -d eagerzeroedthick /vmfs/volumes/RAC-ASM-Datastore/asm_data01.vmdk
vmkfstools -c 500G -d eagerzeroedthick /vmfs/volumes/RAC-ASM-Datastore/asm_data02.vmdk

# Create FRA disk group disk
vmkfstools -c 300G -d eagerzeroedthick /vmfs/volumes/RAC-ASM-Datastore/asm_fra01.vmdk
\`\`\`

Thick eager zeroed VMDKs are required because:
- ASM reads uninitialized blocks and expects zeros — thin-provisioned disks may return garbage
- Eager zeroing prevents the first write to each block from being slower than subsequent writes

---

## Phase 2 — VM Creation

### 2.1 Create Both VMs

Create two VMs with these specifications in vSphere Client:

\`\`\`
Name:           racnode1 / racnode2
Guest OS:       Red Hat Enterprise Linux 9 (64-bit)
vCPUs:          8 (or as licensed)
Memory:         64 GB (adjust to workload; set reservation = total)
OS disk:        100 GB thin (private to each VM, separate datastore)
Network:
  NIC 1 (eth0): VM Network / Production VLAN    — VMXNET3
  NIC 2 (eth1): RAC-Interconnect-VLAN-1         — VMXNET3, MTU 9000
  NIC 3 (eth2): RAC-Interconnect-VLAN-2         — VMXNET3, MTU 9000
SCSI Controller: VMware Paravirtual (PVSCSI)
\`\`\`

### 2.2 Attach Shared VMDKs with Multi-Writer

Power off both VMs before this step.

In vSphere Client → racnode1 → Edit Settings → Add Hard Disk → Existing Hard Disk:

Add each ASM VMDK. After adding each disk, expand its entry and set:

\`\`\`
Disk Mode: Independent - Persistent
Sharing:   Multi-writer
\`\`\`

Repeat for racnode2, attaching the same VMDKs with the same multi-writer setting.

To verify the VMX file directly (SSH to ESXi host):

\`\`\`bash
grep -i "sharing\|multiwriter\|sharedBus" /vmfs/volumes/*/racnode1/*.vmx
# Expected output for each shared disk:
# scsi1:1.sharing = "multi-writer"
\`\`\`

### 2.3 Set Memory Reservation

vSphere Client → racnode1 → Edit Settings → Resources → Memory:

\`\`\`
Reservation: 65536 MB  (= 64 GB — must match VM memory exactly)
\`\`\`

Repeat for racnode2.

### 2.4 Create Anti-Affinity DRS Rule

\`\`\`
vSphere Client → Cluster → Configure → VM/Host Rules → Add
Name:       RAC-Nodes-Separate
Type:       Separate Virtual Machines
Members:    racnode1, racnode2
\`\`\`

Verify: power on both VMs and confirm they are running on different ESXi hosts in the cluster summary view.

---

## Phase 3 — RHEL 9 OS Installation and Configuration

Perform these steps on **both** nodes unless noted.

### 3.1 Install RHEL 9

Minimal install. Partition layout recommendation:

\`\`\`
/boot      1 GB   xfs
/boot/efi  600 MB vfat   (UEFI systems)
swap       16 GB          (not for SGA — for OS only)
/          remaining xfs
\`\`\`

Set hostnames:
\`\`\`bash
# racnode1:
hostnamectl set-hostname racnode1.corp.local

# racnode2:
hostnamectl set-hostname racnode2.corp.local
\`\`\`

### 3.2 /etc/hosts

Add to \`/etc/hosts\` on both nodes (DNS is preferred, but /etc/hosts ensures resolution before DNS is available during boot):

\`\`\`
# Public IPs
10.10.1.11   racnode1.corp.local   racnode1
10.10.1.12   racnode2.corp.local   racnode2

# VIPs
10.10.1.21   racnode1-vip.corp.local   racnode1-vip
10.10.1.22   racnode2-vip.corp.local   racnode2-vip

# SCAN (3 IPs)
10.10.1.30   rac-scan.corp.local   rac-scan
10.10.1.31   rac-scan.corp.local   rac-scan
10.10.1.32   rac-scan.corp.local   rac-scan

# Private interconnects (node 1)
169.254.10.11   racnode1-priv1.corp.local
169.254.11.11   racnode1-priv2.corp.local

# Private interconnects (node 2)
169.254.10.12   racnode2-priv1.corp.local
169.254.11.12   racnode2-priv2.corp.local
\`\`\`

### 3.3 Configure Network Interfaces

\`\`\`bash
# Public interface (racnode1):
nmcli con mod eth0 ipv4.addresses 10.10.1.11/24 ipv4.gateway 10.10.1.1
nmcli con mod eth0 ipv4.method manual connection.autoconnect yes

# Private interconnect 1:
nmcli con mod eth1 ipv4.addresses 169.254.10.11/24 ipv4.method manual
nmcli con mod eth1 802-3-ethernet.mtu 9000 connection.autoconnect yes

# Private interconnect 2:
nmcli con mod eth2 ipv4.addresses 169.254.11.11/24 ipv4.method manual
nmcli con mod eth2 802-3-ethernet.mtu 9000 connection.autoconnect yes

nmcli con up eth0 && nmcli con up eth1 && nmcli con up eth2
\`\`\`

Verify MTU:
\`\`\`bash
ip link show eth1 | grep mtu
# Expected: mtu 9000

# Test Jumbo Frame connectivity to node 2:
ping -M do -s 8972 169.254.10.12
# -M do = don't fragment, -s 8972 = 8972 byte payload + 28 byte IP/ICMP header = 9000 bytes
\`\`\`

### 3.4 Install Oracle Preinstall RPM

\`\`\`bash
# For Oracle Linux 9:
dnf install -y oraclelinux-release-el9
dnf install -y oracle-database-preinstall-19c

# For RHEL 9 (without Oracle repo):
dnf install -y \
  bc binutils compat-openssl11 elfutils-libelf elfutils-libelf-devel \
  fontconfig-devel glibc glibc-devel ksh libaio libaio-devel \
  libXrender libXrender-devel libX11 libXau libXi libXtst \
  libgcc librdmacm-devel libstdc++ libstdc++-devel libxcb \
  make net-tools nfs-utils python3 python3-configshell \
  python3-rtslib python3-six smartmontools sysstat \
  targetcli unzip xorg-x11-xauth xorg-x11-utils
\`\`\`

If using the preinstall RPM, review and confirm the groups and users it created:

\`\`\`bash
id oracle
id grid
grep -E "^(oinstall|dba|oper|asm|asmadmin|asmdba|backupdba|kmdba|racdba)" /etc/group
\`\`\`

### 3.5 Disable THP

\`\`\`bash
grubby --update-kernel=ALL --args="transparent_hugepage=never"
reboot
\`\`\`

Verify after reboot:
\`\`\`bash
cat /sys/kernel/mm/transparent_hugepage/enabled
# Expected: always madvise [never]
\`\`\`

### 3.6 Set Kernel Parameters

\`\`\`bash
cat > /etc/sysctl.d/98-oracle-rac.conf << 'EOF'
kernel.sem = 250 32000 100 128
kernel.shmmax = 137438953472
kernel.shmall = 33554432
kernel.shmmni = 4096
net.core.rmem_max = 4194304
net.core.wmem_max = 1048576
net.core.rmem_default = 262144
net.core.wmem_default = 262144
net.ipv4.conf.all.rp_filter = 2
net.ipv4.conf.default.rp_filter = 2
fs.aio-max-nr = 1048576
fs.file-max = 6815744
EOF

sysctl -p /etc/sysctl.d/98-oracle-rac.conf
\`\`\`

### 3.7 Security Limits

\`\`\`bash
cat > /etc/security/limits.d/99-oracle-grid.conf << 'EOF'
oracle   soft   nofile   1024
oracle   hard   nofile   65536
oracle   soft   nproc    16384
oracle   hard   nproc    16384
oracle   soft   stack    10240
oracle   hard   stack    32768
oracle   hard   memlock  134217728
oracle   soft   memlock  134217728
grid     soft   nofile   1024
grid     hard   nofile   65536
grid     soft   nproc    16384
grid     hard   nproc    16384
grid     soft   stack    10240
grid     hard   stack    32768
EOF
\`\`\`

### 3.8 Create Directory Structure

\`\`\`bash
mkdir -p /u01/app/grid
mkdir -p /u01/app/19.0.0/grid
mkdir -p /u01/app/oracle
mkdir -p /u01/app/oracle/product/19.0.0/dbhome_1

chown -R grid:oinstall /u01/app/grid /u01/app/19.0.0
chown -R oracle:oinstall /u01/app/oracle
chmod -R 775 /u01

# Grid inventory:
mkdir -p /u01/app/oraInventory
chown -R grid:oinstall /u01/app/oraInventory
\`\`\`

---

## Phase 4 — UDEV Rules for ASM Disks

Perform on **both** nodes. The disk SCSI IDs must be the same on both nodes (they will be, since the IDs come from the VMDK UUID which is shared).

### 4.1 Identify SCSI IDs

Power on the VMs. The shared VMDKs should appear as \`/dev/sdb\` through \`/dev/sdg\` (or similar). List all disks and get their IDs:

\`\`\`bash
lsblk -o NAME,SIZE,TYPE,SERIAL
for dev in sdb sdc sdd sde sdf sdg; do
  echo -n "/dev/\${dev}: "
  /usr/lib/udev/scsi_id --whitelisted --replace-whitespace --device=/dev/\${dev}
done
\`\`\`

Record the SCSI ID for each disk and map it to its intended ASM name.

### 4.2 Create UDEV Rules File

\`\`\`bash
cat > /etc/udev/rules.d/99-oracle-asm.rules << 'EOF'
# OCR / Voting disks
KERNEL=="sd?", ENV{ID_SERIAL}=="<ocr1_scsi_id>", SYMLINK+="oracleasm/asm-ocr1", OWNER="grid", GROUP="asmadmin", MODE="0660"
KERNEL=="sd?", ENV{ID_SERIAL}=="<ocr2_scsi_id>", SYMLINK+="oracleasm/asm-ocr2", OWNER="grid", GROUP="asmadmin", MODE="0660"
KERNEL=="sd?", ENV{ID_SERIAL}=="<ocr3_scsi_id>", SYMLINK+="oracleasm/asm-ocr3", OWNER="grid", GROUP="asmadmin", MODE="0660"

# DATA disk group
KERNEL=="sd?", ENV{ID_SERIAL}=="<data01_scsi_id>", SYMLINK+="oracleasm/asm-data01", OWNER="grid", GROUP="asmadmin", MODE="0660"
KERNEL=="sd?", ENV{ID_SERIAL}=="<data02_scsi_id>", SYMLINK+="oracleasm/asm-data02", OWNER="grid", GROUP="asmadmin", MODE="0660"

# FRA disk group
KERNEL=="sd?", ENV{ID_SERIAL}=="<fra01_scsi_id>", SYMLINK+="oracleasm/asm-fra01", OWNER="grid", GROUP="asmadmin", MODE="0660"
EOF

udevadm control --reload-rules
udevadm trigger
\`\`\`

### 4.3 Verify

\`\`\`bash
ls -la /dev/oracleasm/
# Expected output:
# lrwxrwxrwx 1 root root ... asm-ocr1 -> ../sdb
# lrwxrwxrwx 1 root root ... asm-ocr2 -> ../sdc
# ...

# Verify ownership and mode:
ls -la /dev/oracleasm/asm-ocr1
# Expected: lrwxrwxrwx  (symlink)
# Target:   brw-rw---- grid asmadmin  /dev/sdb
\`\`\`

### 4.4 Add udevadm settle Systemd Unit (Prevent GI Race)

\`\`\`bash
cat > /etc/systemd/system/udev-settle-asm.service << 'EOF'
[Unit]
Description=Wait for udev ASM disk rules to settle before Oracle GI
DefaultDependencies=no
Before=ohas.service
After=local-fs.target systemd-udev-settle.service

[Service]
Type=oneshot
ExecStart=/usr/bin/udevadm settle --timeout=30
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable udev-settle-asm.service
\`\`\`

---

## Phase 5 — SSH User Equivalence

Grid Infrastructure installer requires password-less SSH between nodes for both the **grid** and **oracle** users.

\`\`\`bash
# On racnode1, as grid user:
su - grid
ssh-keygen -t rsa -N "" -f ~/.ssh/id_rsa
ssh-copy-id grid@racnode2
ssh racnode2 "echo SSH OK from racnode1 to racnode2"

# On racnode2, as grid user:
ssh-keygen -t rsa -N "" -f ~/.ssh/id_rsa
ssh-copy-id grid@racnode1
ssh racnode1 "echo SSH OK from racnode2 to racnode1"

# Repeat for oracle user on both nodes
su - oracle
ssh-keygen -t rsa -N "" -f ~/.ssh/id_rsa
# ... same ssh-copy-id steps
\`\`\`

---

## Phase 6 — Grid Infrastructure Installation

### 6.1 Stage Software

On racnode1 as root, copy the Grid Infrastructure zip to \`/tmp\` and unzip to the Grid home:

\`\`\`bash
su - grid
mkdir -p /u01/app/19.0.0/grid
cd /u01/app/19.0.0/grid
unzip /tmp/LINUX.X64_193000_grid_home.zip
\`\`\`

### 6.2 Run OUI Prerequisite Check

\`\`\`bash
cd /u01/app/19.0.0/grid
./gridSetup.sh -silent -executePrereqs \
  ORACLE_BASE=/u01/app/grid \
  -applyRU /tmp/p<patch_number>_190000_Linux-x86-64.zip   # optional: apply latest RU
\`\`\`

Review \`/tmp/GridSetup*.log\` — fix any FAILED checks before proceeding.

### 6.3 Create Response File

\`\`\`bash
cat > /tmp/grid_install.rsp << 'EOF'
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
oracle.install.asm.monitorPassword=<ASM_password>
oracle.install.asm.gimrDG.AUSize=1
oracle.install.crs.config.ignoreDownNodes=false
oracle.install.config.managementOption=NONE
oracle.install.config.omsPort=0
oracle.install.crs.rootconfig.configMethod=ROOT
EOF
\`\`\`

### 6.4 Run Silent Installation

\`\`\`bash
/u01/app/19.0.0/grid/gridSetup.sh -silent \
  -responseFile /tmp/grid_install.rsp \
  -ignorePrereqFailure
\`\`\`

When prompted (or at the end of the log), run as **root** on both nodes:

\`\`\`bash
# On racnode1 as root:
/u01/app/oraInventory/orainstRoot.sh
/u01/app/19.0.0/grid/root.sh

# On racnode2 as root (wait until prompted, or after racnode1 root.sh completes):
/u01/app/oraInventory/orainstRoot.sh
/u01/app/19.0.0/grid/root.sh
\`\`\`

After both root.sh scripts complete, press Enter in the installer to finalize.

### 6.5 Verify Cluster

\`\`\`bash
# As grid user:
crsctl stat res -t
# All GI resources should be Online on both nodes

crsctl check crs
# Should report: CRS is healthy

# Check ASM disk groups:
asmcmd lsdg
# OCR disk group should be mounted
\`\`\`

---

## Phase 7 — Create DATA and FRA ASM Disk Groups

\`\`\`bash
# As grid user, start asmcmd:
asmcmd

# Create DATA disk group:
ASMCMD> mkdg --redundancy EXTERNAL --au_size 4 DATA \
  '/dev/oracleasm/asm-data01' '/dev/oracleasm/asm-data02'

# Create FRA disk group:
ASMCMD> mkdg --redundancy EXTERNAL --au_size 4 FRA \
  '/dev/oracleasm/asm-fra01'

# Verify:
ASMCMD> lsdg
# State    Type    Rebal  Sector  Logical_Sector  Block  AU      Total_MB  Free_MB
# MOUNTED  EXTERN  N      512     512             4096   4194304 ...
\`\`\`

Or using SQL*Plus as sysdba:

\`\`\`sql
CREATE DISKGROUP DATA
  EXTERNAL REDUNDANCY
  DISK '/dev/oracleasm/asm-data01', '/dev/oracleasm/asm-data02'
  ATTRIBUTE 'AU_SIZE'='4M';

CREATE DISKGROUP FRA
  EXTERNAL REDUNDANCY
  DISK '/dev/oracleasm/asm-fra01'
  ATTRIBUTE 'AU_SIZE'='4M';
\`\`\`

---

## Phase 8 — Oracle Database Software Installation

### 8.1 Unzip DB Home on Both Nodes

\`\`\`bash
su - oracle
mkdir -p /u01/app/oracle/product/19.0.0/dbhome_1
cd /u01/app/oracle/product/19.0.0/dbhome_1
unzip /tmp/LINUX.X64_193000_db_home.zip
\`\`\`

### 8.2 Response File

\`\`\`bash
cat > /tmp/db_install.rsp << 'EOF'
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
\`\`\`

### 8.3 Install

\`\`\`bash
/u01/app/oracle/product/19.0.0/dbhome_1/runInstaller -silent \
  -responseFile /tmp/db_install.rsp \
  -ignorePrereqFailure
\`\`\`

Run root.sh on both nodes when prompted:

\`\`\`bash
# racnode1 and racnode2 as root:
/u01/app/oracle/product/19.0.0/dbhome_1/root.sh
\`\`\`

---

## Phase 9 — Create the RAC Database

\`\`\`bash
# As oracle user on racnode1:
dbca -silent \
  -createDatabase \
  -templateName General_Purpose.dbc \
  -gdbName ORCL \
  -sid ORCL \
  -createAsContainerDatabase false \
  -numberOfPDBs 0 \
  -sysPassword <sys_password> \
  -systemPassword <system_password> \
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

## Phase 10 — Post-Installation Validation

### 10.1 Cluster Resource Status

\`\`\`bash
crsctl stat res -t
# Expected: all resources ONLINE on both nodes, including:
# ora.asm        ONLINE  ONLINE   (both nodes)
# ora.ORCL.db    ONLINE  ONLINE   (both nodes)
# ora.scan1.vip  ONLINE  ONLINE   (one node)
# ora.racnode1.vip ONLINE ONLINE  (racnode1)
# ora.racnode2.vip ONLINE ONLINE  (racnode2)
\`\`\`

### 10.2 Verify Interconnect Assignment

\`\`\`bash
# As grid user:
oifcfg getif
# Expected:
# eth0  10.10.1.0  global  public
# eth1  169.254.10.0  global  cluster_interconnect
# eth2  169.254.11.0  global  cluster_interconnect
\`\`\`

### 10.3 Verify Cache Fusion Traffic on Private NICs

\`\`\`sql
-- Connect as sysdba to both instances
-- Check that GC (global cache) traffic is non-zero:
SELECT inst_id, name, value
FROM   gv\$sysstat
WHERE  name LIKE 'gc%received%'
   OR  name LIKE 'gc%sent%'
ORDER BY inst_id, name;

-- Check interconnect network usage (run at peak load):
SELECT * FROM v\$cluster_interconnects;
-- IP column should show 169.254.x.x addresses, NOT 10.10.1.x
\`\`\`

If the interconnect shows the public IP, Grid Infrastructure is using the public NIC for Cache Fusion — this will cause severe performance degradation. Fix with:

\`\`\`bash
oifcfg setif -global eth0/10.10.1.0:public
oifcfg setif -global eth1/169.254.10.0:cluster_interconnect
oifcfg setif -global eth2/169.254.11.0:cluster_interconnect
\`\`\`

### 10.4 Verify Jumbo Frames End-to-End

\`\`\`bash
# From racnode1, send maximum-size packet to racnode2 private IP:
ping -M do -s 8972 -c 10 169.254.10.12
# All packets should succeed with 0% packet loss

# If ping fails with "Message too long" — MTU mismatch somewhere:
# Check: VM NIC MTU, dvPortGroup MTU, physical switch uplink MTU
\`\`\`

### 10.5 SCAN Connectivity Test

\`\`\`bash
# From a client host (not the RAC nodes):
tnsping rac-scan.corp.local:1521
nslookup rac-scan.corp.local   # should return 3 A records

# Connect via SCAN:
sqlplus system/<password>@//rac-scan.corp.local:1521/ORCL
\`\`\`

### 10.6 Failover Test

\`\`\`bash
# Kill instance 1 and verify instance 2 continues serving connections:
srvctl stop instance -d ORCL -i ORCL1 -force

# From client: connection should fail over to ORCL2 automatically via SCAN
sqlplus system/<password>@//rac-scan.corp.local:1521/ORCL
# SELECT instance_name FROM v\$instance;  — should return ORCL2

# Restart instance 1:
srvctl start instance -d ORCL -i ORCL1
\`\`\`

---

## Phase 11 — Ongoing Monitoring

### Daily Health Check Script

\`\`\`bash
#!/bin/bash
# /home/grid/bin/rac_health_check.sh
# Run as grid user on racnode1

LOGFILE="/home/grid/logs/rac_health_$(date +%Y%m%d).log"
mkdir -p /home/grid/logs

exec > "\${LOGFILE}" 2>&1
echo "=== RAC Health Check $(date) ==="

echo ""
echo "--- Cluster Resource Status ---"
crsctl stat res -t

echo ""
echo "--- ASM Disk Groups ---"
asmcmd lsdg

echo ""
echo "--- Database Status ---"
srvctl status database -d ORCL -verbose

echo ""
echo "--- SCAN Status ---"
srvctl status scan
srvctl status scan_listener

echo ""
echo "--- Voting Disk Status ---"
crsctl query css votedisk

echo ""
echo "--- Interconnect Configuration ---"
oifcfg getif

echo ""
echo "--- Alert Log Errors (last 24h) ---"
for node in racnode1 racnode2; do
  echo "Node: \${node}"
  ALERTLOG="/u01/app/grid/diag/crs/\${node}/crs/trace/alert.log"
  if [ -f "\${ALERTLOG}" ]; then
    awk -v since="\$(date -d '24 hours ago' '+%Y-%m-%d')" \
      '\$0 >= since && /ORA-|CRS-|error|Error/' "\${ALERTLOG}" | tail -20
  fi
done

echo ""
echo "=== Health Check Complete $(date) ==="
\`\`\`

\`\`\`bash
chmod +x /home/grid/bin/rac_health_check.sh

# Crontab (grid user):
# 0 6 * * * /home/grid/bin/rac_health_check.sh
\`\`\`

---

## Troubleshooting Reference

| Symptom | First Check | Command |
|---------|------------|---------|
| Node eviction after vMotion | misscount value, stun duration | \`crsctl get css misscount\` |
| ASM disks not found on boot | UDEV rules, settle timing | \`udevadm trigger && ls /dev/oracleasm/\` |
| Cache Fusion on public NIC | oifcfg assignment | \`oifcfg getif\` |
| Jumbo Frames not working | vSwitch MTU, physical switch | \`ping -M do -s 8972 <priv_ip>\` |
| VIP not failing over | DRS anti-affinity rule, network | \`crsctl stat res ora.racnode1.vip -t\` |
| Memory balloon eviction | VM reservation not set | vSphere Client → VM → Memory Reservation |
| Node rejoins slowly after eviction | OCR/Voting disk latency | \`crsctl query css votedisk\` |
| SCAN DNS returning wrong IPs | DNS record count | \`nslookup rac-scan.corp.local\` (expect 3 A records) |`,
};

async function main() {
  console.log('Inserting Oracle RAC on VMware runbook...');
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
