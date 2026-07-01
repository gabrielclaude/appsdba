import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Installing Oracle 21c RAC Flex Cluster: Architecture, Prerequisites, and End-to-End Deployment',
  slug: 'oracle-21c-rac-flex-cluster-install',
  excerpt: 'A comprehensive guide to Oracle 21c RAC Flex Cluster covering Hub and Leaf node architecture, full prerequisite configuration, Grid Infrastructure installation, Leaf node enrollment via addnode.sh, and RAC database creation with DBCA.',
  category: 'rac-clusterware' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-01'),
  youtubeUrl: null,
  content: `## Introduction

Oracle 21c (21.3 and above) delivers RAC Flex Cluster as part of Oracle Grid Infrastructure, extending the flex cluster architecture first introduced in 12.2. Flex Cluster introduces two distinct node roles — Hub nodes and Leaf nodes — allowing a single cluster to scale to hundreds of nodes while keeping the interconnect topology manageable. This post covers what Flex Cluster is, how it differs from standard RAC, the full prerequisite checklist, and the end-to-end installation sequence for a two-Hub, two-Leaf cluster on Oracle Linux 8.

---

## What Is RAC Flex Cluster?

Standard RAC (prior to 12.2) requires every node to be a full peer: each node has direct access to shared storage via ASM, each node participates in the cluster interconnect as an equal, and each node runs a full Oracle Clusterware stack. This works well for clusters of 2–8 nodes but becomes difficult to scale beyond that due to interconnect complexity and the cost of shared storage access for every node.

Flex Cluster changes the topology with two node roles.

**Hub Nodes**: Full cluster members. They have direct access to shared storage, run Oracle ASM, participate in the cluster interconnect with all other Hub nodes, and can host Oracle RAC database instances. A Flex Cluster requires at minimum two Hub nodes and supports up to 64 Hub nodes.

**Leaf Nodes**: Lightweight cluster members. They do NOT have direct access to shared storage. Instead, they communicate with Hub nodes over the cluster interconnect for all storage and coordination operations. Leaf nodes can run application-tier workloads, Oracle Database clients, or Oracle Database instances that use a Hub node as their data server. A Flex Cluster can have up to hundreds of Leaf nodes.

### Hub vs. Leaf Node Feature Comparison

| Feature | Hub Node | Leaf Node |
|---|---|---|
| Direct ASM access | Yes | No (via Hub) |
| Runs clusterware stack | Full | Lightweight |
| Can host DB instance | Yes | Limited (IOServer) |
| Interconnect participation | Full peer | Spoke to Hub |
| Required count | Min 2 | 0 or more |
| Voting disk access | Direct | Via Hub |

### New in 21c Flex Cluster

Oracle 21c extends the Flex Cluster feature set with the following additions:

- **Oracle Cluster Domain (OCD)** — multiple clusters managed by a single Domain Services Cluster (DSC) for shared services, including GIMR, OCR, and voting disk storage. Member Clusters delegate management-plane functions to the DSC.
- **Fleet Patching and Provisioning (FPP) integration** — centralized patching of Grid Infrastructure and Oracle Database homes across all nodes in the cluster domain from a single FPP server.
- **Oracle Member Cluster for databases** — a cluster that relies on a Domain Services Cluster for storage management and the Grid Infrastructure Management Repository (GIMR). Useful for edge-site clusters where dedicated management storage is not practical.
- **RHCK and UEK6 support** — Oracle 21c certifies both the Red Hat Compatible Kernel (RHCK 4.18.x) and Oracle's Unbreakable Enterprise Kernel Release 6 (UEK6, 5.4.17-2136.x and later) on Oracle Linux 8.
- **ASM Filter Driver (ASMFD)** — replaces ASMLib as the recommended block device management layer. ASMFD integrates at the kernel I/O path, provides I/O fencing, and eliminates the need for \`oracleasm\` service management.

---

## Prerequisites

### Hardware Requirements

The following specifications cover a 2-Hub + 2-Leaf demonstration cluster.

**Hub nodes (rac1, rac2)**:
- 4 vCPUs, 16 GB RAM minimum
- 3 network interfaces: public (eth0), private interconnect (eth1), ASM network (eth2, optional but recommended)
- Shared storage: ASM disks accessible from both Hub nodes

**Leaf nodes (rac3, rac4)**:
- 2 vCPUs, 8 GB RAM minimum
- 2 network interfaces: public (eth0), private interconnect (eth1) — connected to Hub nodes' interconnect switch, not directly between Leaf nodes

**Storage**:
- At minimum 3 ASM disks for the GRID diskgroup (OCR and voting disks, normal redundancy requires 3 failure groups)
- At minimum 2 ASM disks per failure group for DATA
- At minimum 2 ASM disks per failure group for RECO

**Interconnect**:
- Dedicated private network, 10GbE recommended
- Leaf nodes connect to the same interconnect switch as Hub nodes
- Leaf nodes do not need a direct path to each other — all coordination flows through their designated Hub node

### Operating System Prerequisites (Oracle Linux 8)

**Kernel**:

UEK Release 6 (5.4.17-2136.x or later) is the recommended kernel. RHCK 4.18.x is also supported.

Install the preinstall RPM which handles most kernel parameter and package requirements automatically:

\`\`\`bash
dnf install -y oracle-database-preinstall-21c
\`\`\`

Additional packages that must be installed manually:

\`\`\`bash
dnf install -y ksh cvuqdisk oracleasm-support
\`\`\`

**Kernel parameters** — create \`/etc/sysctl.d/99-oracle-rac.conf\` with the following content on all nodes:

\`\`\`
kernel.shmall = 1073741824
kernel.shmmax = 4398046511104
kernel.shmmni = 4096
kernel.sem = 250 32000 100 128
fs.file-max = 6815744
net.ipv4.ip_local_port_range = 9000 65500
net.core.rmem_default = 262144
net.core.rmem_max = 4194304
net.core.wmem_default = 262144
net.core.wmem_max = 1048576
net.ipv4.conf.all.rp_filter = 2
net.ipv4.conf.default.rp_filter = 2
\`\`\`

Apply without rebooting:

\`\`\`bash
sysctl --system
\`\`\`

**OS users and groups**:

Create the following groups and users on all Hub nodes. Leaf nodes require the same UIDs and GIDs but a reduced set of supplementary groups.

\`\`\`bash
# Groups
groupadd -g 54321 oinstall
groupadd -g 54322 dba
groupadd -g 54323 oper
groupadd -g 54324 osasm
groupadd -g 54325 osdba
groupadd -g 54326 backupdba
groupadd -g 54327 dgdba
groupadd -g 54328 kmdba
groupadd -g 54329 racdba

# Oracle software owner
useradd -u 54321 -g oinstall -G dba,oper,osdba,backupdba,dgdba,kmdba,racdba oracle

# Grid Infrastructure owner
useradd -u 54322 -g oinstall -G osasm,dba,oper oracle || true
useradd -u 54322 -g oinstall -G osasm,dba,oper grid
\`\`\`

**Resource limits** — create \`/etc/security/limits.d/oracle-rac.conf\` on all nodes:

\`\`\`
oracle soft nofile 1024
oracle hard nofile 65536
oracle soft nproc 2047
oracle hard nproc 16384
oracle soft stack 10240
oracle hard stack 32768
oracle soft memlock unlimited
oracle hard memlock unlimited

grid   soft nofile 1024
grid   hard nofile 65536
grid   soft nproc 2047
grid   hard nproc 16384
grid   soft stack 10240
grid   hard stack 32768
grid   soft memlock unlimited
grid   hard memlock unlimited
\`\`\`

### /etc/hosts Configuration

All nodes must have consistent \`/etc/hosts\` entries for public addresses, VIPs, private interconnects, and SCAN addresses. On every node:

\`\`\`
# Public addresses
192.168.10.11   rac1.example.com     rac1
192.168.10.12   rac2.example.com     rac2
192.168.10.13   rac3.example.com     rac3
192.168.10.14   rac4.example.com     rac4

# VIPs (Hub nodes only; Leaf nodes do not have VIPs)
192.168.10.21   rac1-vip.example.com rac1-vip
192.168.10.22   rac2-vip.example.com rac2-vip

# Private interconnect
10.10.10.11     rac1-priv.example.com rac1-priv
10.10.10.12     rac2-priv.example.com rac2-priv
10.10.10.13     rac3-priv.example.com rac3-priv
10.10.10.14     rac4-priv.example.com rac4-priv

# SCAN (3 IPs, DNS round-robin — do NOT put these in /etc/hosts in production; use DNS)
192.168.10.30   racflex-scan.example.com
192.168.10.31   racflex-scan.example.com
192.168.10.32   racflex-scan.example.com
\`\`\`

In production environments, SCAN addresses must be resolved by DNS and must not appear in \`/etc/hosts\`. The Cluster Verification Utility (CVU) will warn or fail if SCAN is resolved from the hosts file.

### SSH Equivalence

Passwordless SSH is required between all nodes for both the \`oracle\` and \`grid\` users. Set this up before running the GI installer.

\`\`\`bash
# Run as grid user on each node
ssh-keygen -t rsa -b 4096 -N "" -f ~/.ssh/id_rsa

# Collect all public keys into authorized_keys on each node
# Example: from rac1, distribute to rac2, rac3, rac4
ssh-copy-id grid@rac2
ssh-copy-id grid@rac3
ssh-copy-id grid@rac4

# Verify
ssh grid@rac2 date
ssh grid@rac3 date
ssh grid@rac4 date
\`\`\`

Repeat the same steps as the \`oracle\` user.

### Time Synchronization

All nodes must have synchronized clocks. Oracle Clusterware uses NTP or Chrony. On Oracle Linux 8, Chrony is the default:

\`\`\`bash
systemctl enable --now chronyd
chronyc tracking
\`\`\`

Verify that the offset reported by \`chronyc tracking\` is less than 1 second across all nodes. CVU will fail if it detects clock skew greater than the threshold.

### Firewall and SELinux

Disable \`firewalld\` on all nodes during installation. Configure post-installation rules after the cluster is running.

\`\`\`bash
systemctl stop firewalld
systemctl disable firewalld
\`\`\`

Set SELinux to permissive during installation:

\`\`\`bash
setenforce 0
sed -i 's/^SELINUX=enforcing/SELINUX=permissive/' /etc/selinux/config
\`\`\`

### Network Interface Configuration

| Interface | Role | Example Name |
|---|---|---|
| eth0 | Public — client connections and VIPs | ens3 |
| eth1 | Private interconnect — heartbeat and Cache Fusion | ens4 |
| eth2 | ASM network (optional, recommended for large clusters) | ens5 |

Leaf nodes require eth0 (public) and eth1 (private interconnect only). The private interconnect for Leaf nodes connects to the same switch segment as Hub nodes.

### ASM Storage Preparation

Identify the raw block devices that will back the ASM diskgroups. The following example uses \`/dev/sdb\` through \`/dev/sdh\`.

Zero the first 100 MB of each device to remove any stale partition or ASM header data:

\`\`\`bash
for DEV in /dev/sdb /dev/sdc /dev/sdd /dev/sde /dev/sdf /dev/sdg /dev/sdh; do
  dd if=/dev/zero of=\${DEV} bs=1M count=100 oflag=direct
done
\`\`\`

**udev rules for device ownership** — create \`/etc/udev/rules.d/99-oracle-asmdevices.rules\` on all Hub nodes:

\`\`\`
KERNEL=="sdb", OWNER="grid", GROUP="asmdba", MODE="0660"
KERNEL=="sdc", OWNER="grid", GROUP="asmdba", MODE="0660"
KERNEL=="sdd", OWNER="grid", GROUP="asmdba", MODE="0660"
KERNEL=="sde", OWNER="grid", GROUP="asmdba", MODE="0660"
KERNEL=="sdf", OWNER="grid", GROUP="asmdba", MODE="0660"
KERNEL=="sdg", OWNER="grid", GROUP="asmdba", MODE="0660"
KERNEL=="sdh", OWNER="grid", GROUP="asmdba", MODE="0660"
\`\`\`

Reload udev rules:

\`\`\`bash
udevadm control --reload-rules
udevadm trigger
\`\`\`

**Configure ASMFD labels** — Oracle 21c prefers ASMFD over ASMLib. Label each device with a logical name that the ASM diskgroup creation SQL will reference. Run these commands as the \`grid\` user after the GI software is unzipped but before running the installer:

\`\`\`bash
# Set ORACLE_HOME for standalone ASMFD configuration
export ORACLE_HOME=/u01/app/21.0.0/grid
export ORACLE_BASE=/u01/app/grid

# Label GRID diskgroup disks (for OCR and voting)
\${ORACLE_HOME}/bin/asmcmd afd_label GRID1 /dev/sdb --init
\${ORACLE_HOME}/bin/asmcmd afd_label GRID2 /dev/sdc --init
\${ORACLE_HOME}/bin/asmcmd afd_label GRID3 /dev/sdd --init

# Label DATA diskgroup disks
\${ORACLE_HOME}/bin/asmcmd afd_label DATA1 /dev/sde --init
\${ORACLE_HOME}/bin/asmcmd afd_label DATA2 /dev/sdf --init

# Label RECO diskgroup disks
\${ORACLE_HOME}/bin/asmcmd afd_label RECO1 /dev/sdg --init
\${ORACLE_HOME}/bin/asmcmd afd_label RECO2 /dev/sdh --init

# Verify labels
\${ORACLE_HOME}/bin/asmcmd afd_lslbl
\`\`\`

After labeling, devices appear under \`/dev/oracleafd/disks/\` and persist across reboots without udev-based workarounds. ASMFD also provides I/O fencing that prevents a non-ASM process from writing to an ASM-managed disk.

---

## Grid Infrastructure Installation — Hub Nodes

Grid Infrastructure software must be installed on Hub nodes first. Leaf nodes join the running cluster afterward.

### Step 1: Prepare Directory Structure

Run on both Hub nodes as root:

\`\`\`bash
mkdir -p /u01/app/21.0.0/grid
mkdir -p /u01/app/grid
mkdir -p /u01/app/oracle
chown -R grid:oinstall /u01/app/21.0.0/grid /u01/app/grid
chown -R oracle:oinstall /u01/app/oracle
chmod -R 775 /u01/app
\`\`\`

### Step 2: Unzip the GI Software

As the \`grid\` user on Hub node 1 (rac1):

\`\`\`bash
cd /u01/app/21.0.0/grid
unzip -q /stage/LINUX.X64_213000_grid_home.zip
\`\`\`

### Step 3: Run CVU Pre-Installation Check

The Cluster Verification Utility must pass all FAILED checks before you start the GI installer. The \`-flex\` flag tells CVU to validate a Flex Cluster topology.

\`\`\`bash
/u01/app/21.0.0/grid/runcluvfy.sh stage -pre crsinst \
  -n rac1,rac2,rac3,rac4 \
  -flex \
  -hub rac1,rac2 \
  -leaf rac3,rac4 \
  -verbose 2>&1 | tee /tmp/cvu_precheck.log
\`\`\`

Review \`/tmp/cvu_precheck.log\`. Every line marked \`FAILED\` must be resolved before proceeding. Lines marked \`WARNING\` should be investigated; some warnings are benign in lab environments but may indicate real issues in production. Common failures and their resolutions are covered in the Pitfalls section below.

### Step 4: Prepare the Response File

Create \`/home/grid/grid_install.rsp\` on rac1. Key parameters for a silent installation:

\`\`\`
oracle.install.responseFileVersion=/oracle/install/rspfmt_crsinstall_response_schema_v21.0.0
ORACLE_HOSTNAME=rac1
UNIX_GROUP_NAME=oinstall
INVENTORY_LOCATION=/u01/app/oraInventory
ORACLE_HOME=/u01/app/21.0.0/grid
ORACLE_BASE=/u01/app/grid
oracle.install.option=CRS_CONFIG
oracle.install.crs.clusterName=racflex-cluster
oracle.install.crs.clusterType=FLEX
oracle.install.crs.scanType=LOCAL_SCAN
oracle.install.crs.scanName=racflex-scan
oracle.install.crs.scanPort=1521
oracle.install.crs.clusterNodes=rac1:rac1-vip:HUB,rac2:rac2-vip:HUB,rac3::LEAF,rac4::LEAF
oracle.install.crs.hubNodes=rac1,rac2
oracle.install.crs.leafNodes=rac3,rac4
oracle.install.crs.networkInterfaceList=eth0:192.168.10.0:1,eth1:10.10.10.0:2
oracle.install.crs.storageOption=FLEX_ASM_STORAGE
oracle.install.asm.diskGroup.name=GRID
oracle.install.asm.diskGroup.redundancy=NORMAL
oracle.install.asm.diskGroup.AUSize=4
oracle.install.asm.diskGroup.disks=/dev/oracleafd/disks/GRID1,/dev/oracleafd/disks/GRID2,/dev/oracleafd/disks/GRID3
oracle.install.asm.diskGroup.diskDiscoveryString=/dev/oracleafd/disks/*
oracle.install.asm.monitorPassword=<asm_monitor_password>
oracle.install.crs.rootconfig.executeRootScript=false
\`\`\`

Note: \`LEAF\` nodes are listed in \`clusterNodes\` with an empty VIP field (the double colon \`::\` between the node name and role). Leaf nodes do not receive VIPs.

### Step 5: Launch the GI Installer

As the \`grid\` user on rac1:

\`\`\`bash
/u01/app/21.0.0/grid/gridSetup.sh \
  -silent \
  -responseFile /home/grid/grid_install.rsp \
  -ignorePrereqFailure \
  2>&1 | tee /tmp/grid_install.log
\`\`\`

The installer will copy software to rac2 via SSH, configure the cluster network and storage, and then prompt you to run root scripts.

### Step 6: Run root.sh on Hub Nodes

Run \`root.sh\` on rac1 first, wait for it to complete fully, then run on rac2. These must be run sequentially — running them in parallel will cause Clusterware initialization failures.

\`\`\`bash
# On rac1 (as root)
/u01/app/21.0.0/grid/root.sh

# Wait for rac1 root.sh to complete before continuing
# Then on rac2 (as root)
/u01/app/21.0.0/grid/root.sh
\`\`\`

\`root.sh\` on each Hub node starts Oracle Clusterware (CRS), configures OCR, initializes the voting disks in the GRID diskgroup, and starts the ASM instance. The process takes 5–15 minutes per node depending on storage speed.

### Step 7: Complete the Installation

Return to the GI installer window (or the silent install session) and confirm the installation is complete. Verify there are no errors in \`/tmp/grid_install.log\`.

---

## Leaf Node Configuration

Leaf nodes do not run the full GI installer. They join a running Flex Cluster using the \`addnode.sh\` script, which is run from a Hub node.

### Step 1: Prepare the Leaf Nodes

On each Leaf node (rac3, rac4), perform the same OS user, kernel parameter, limits, hosts file, SSH equivalence, and Chrony configuration described in the Prerequisites section. Leaf nodes do not need shared storage access or ASMFD configuration.

Unzip the GI software on each Leaf node to the same path as the Hub nodes:

\`\`\`bash
mkdir -p /u01/app/21.0.0/grid
chown -R grid:oinstall /u01/app/21.0.0/grid
# As grid user on the Leaf node:
cd /u01/app/21.0.0/grid
unzip -q /stage/LINUX.X64_213000_grid_home.zip
\`\`\`

### Step 2: Add Each Leaf Node to the Cluster

Run \`addnode.sh\` from Hub node rac1 as the \`grid\` user, once per Leaf node:

\`\`\`bash
# Add rac3 as a Leaf node
/u01/app/21.0.0/grid/addnode.sh -silent \
  "CLUSTER_NEW_NODES={rac3}" \
  "CLUSTER_NEW_NODE_ROLES={LEAF}"

# Add rac4 as a Leaf node
/u01/app/21.0.0/grid/addnode.sh -silent \
  "CLUSTER_NEW_NODES={rac4}" \
  "CLUSTER_NEW_NODE_ROLES={LEAF}"
\`\`\`

### Step 3: Run root.sh on Leaf Nodes

After each \`addnode.sh\` completes, run \`root.sh\` on the respective Leaf node as root:

\`\`\`bash
# On rac3 (as root)
/u01/app/21.0.0/grid/root.sh

# On rac4 (as root)
/u01/app/21.0.0/grid/root.sh
\`\`\`

---

## Post-Grid Verification

After Grid Infrastructure is running on all four nodes, verify the cluster state before installing Oracle Database software.

\`\`\`bash
# Cluster resource status (run as grid user)
crsctl stat res -t

# Node roles and VIP assignments
olsnodes -n -i -s -t
# Expected columns: node name, node number, VIP, status (Active/Inactive), role (Hub/Leaf)

# SCAN listener status
srvctl status scan
srvctl status scan_listener

# Verify voting disk count and location
crsctl query css votedisk

# Verify OCR integrity
ocrcheck

# Verify ASM diskgroups
asmcmd lsdg
\`\`\`

Expected output from \`olsnodes -n -i -s -t\` should show rac1 and rac2 as \`Hub\` nodes and rac3 and rac4 as \`Leaf\` nodes, all in \`Active\` status. The SCAN listener should show three SCAN VIPs, all online.

---

## Oracle Database 21c Software Installation (Hub Nodes Only)

In a standard Flex Cluster configuration, Oracle Database instances run on Hub nodes only. Leaf nodes do not host database instances unless an IOServer configuration is used.

### Step 1: Prepare the Oracle Home Directory

On both Hub nodes (rac1 and rac2) as root:

\`\`\`bash
mkdir -p /u01/app/oracle/product/21.0.0/dbhome_1
chown -R oracle:oinstall /u01/app/oracle/product/21.0.0
\`\`\`

### Step 2: Unzip the Database Software

As the \`oracle\` user on rac1:

\`\`\`bash
cd /u01/app/oracle/product/21.0.0/dbhome_1
unzip -q /stage/LINUX.X64_213000_db_home.zip
\`\`\`

### Step 3: Install in Software-Only Mode

As the \`oracle\` user on rac1:

\`\`\`bash
/u01/app/oracle/product/21.0.0/dbhome_1/runInstaller -silent \
  -responseFile /home/oracle/db_install.rsp \
  -ignorePrereqFailure \
  2>&1 | tee /tmp/db_install.log
\`\`\`

Key response file parameters for the DB software-only install:

\`\`\`
oracle.install.responseFileVersion=/oracle/install/rspfmt_dbinstall_response_schema_v21.0.0
oracle.install.option=INSTALL_DB_SWONLY
UNIX_GROUP_NAME=oinstall
INVENTORY_LOCATION=/u01/app/oraInventory
ORACLE_HOME=/u01/app/oracle/product/21.0.0/dbhome_1
ORACLE_BASE=/u01/app/oracle
oracle.install.db.InstallEdition=EE
oracle.install.db.OSDBA_GROUP=dba
oracle.install.db.OSOPER_GROUP=oper
oracle.install.db.OSBACKUPDBA_GROUP=backupdba
oracle.install.db.OSDGDBA_GROUP=dgdba
oracle.install.db.OSKMDBA_GROUP=kmdba
oracle.install.db.OSRACDBA_GROUP=racdba
oracle.install.db.isRACOneInstall=false
oracle.install.db.racOneServiceName=
oracle.install.db.rac.servicesForNodes=
SECURITY_UPDATES_VIA_MYORACLESUPPORT=false
DECLINE_SECURITY_UPDATES=true
\`\`\`

### Step 4: Run root.sh for DB Home

As root on each Hub node after the installer completes:

\`\`\`bash
# On rac1
/u01/app/oracle/product/21.0.0/dbhome_1/root.sh

# On rac2
/u01/app/oracle/product/21.0.0/dbhome_1/root.sh
\`\`\`

---

## ASM Diskgroup Creation for Database

Connect to the ASM instance on a Hub node and create the DATA and RECO diskgroups.

\`\`\`bash
export ORACLE_HOME=/u01/app/21.0.0/grid
export ORACLE_SID=+ASM1
sqlplus / as sysasm
\`\`\`

\`\`\`sql
CREATE DISKGROUP DATA NORMAL REDUNDANCY
  FAILGROUP FG1 DISK '/dev/oracleafd/disks/DATA1'
  FAILGROUP FG2 DISK '/dev/oracleafd/disks/DATA2'
  ATTRIBUTE 'compatible.asm'   = '21.0',
            'compatible.rdbms' = '21.0',
            'au_size'          = '4M';

CREATE DISKGROUP RECO NORMAL REDUNDANCY
  FAILGROUP FG1 DISK '/dev/oracleafd/disks/RECO1'
  FAILGROUP FG2 DISK '/dev/oracleafd/disks/RECO2'
  ATTRIBUTE 'compatible.asm'   = '21.0',
            'compatible.rdbms' = '21.0',
            'au_size'          = '4M';
\`\`\`

Verify the diskgroups are mounted on all Hub nodes:

\`\`\`bash
asmcmd lsdg
\`\`\`

Both DATA and RECO should show \`MOUNTED\` state with the correct redundancy mode and allocation unit size.

---

## RAC Database Creation with DBCA

Use DBCA in silent mode to create a container database with one PDB, distributed across both Hub nodes.

\`\`\`bash
export ORACLE_HOME=/u01/app/oracle/product/21.0.0/dbhome_1
export PATH=\${ORACLE_HOME}/bin:\${PATH}

dbca -silent -createDatabase \
  -templateName General_Purpose.dbc \
  -gdbName RACDB \
  -sid RACDB \
  -createAsContainerDatabase true \
  -numberOfPDBs 1 \
  -pdbName PDB1 \
  -pdbAdminPassword <pdb_admin_password> \
  -SysPassword <sys_password> \
  -SystemPassword <system_password> \
  -emConfiguration NONE \
  -storageType ASM \
  -diskGroupName DATA \
  -recoveryGroupName RECO \
  -enableArchive true \
  -recoveryAreaDestination "+RECO" \
  -recoveryAreaSize 10240 \
  -listeners LISTENER \
  -nodeinfo rac1,rac2 \
  -databaseType MULTIPURPOSE \
  -automaticMemoryManagement false \
  -totalMemory 4096 \
  2>&1 | tee /tmp/dbca_create.log
\`\`\`

DBCA will create the CDB \`RACDB\`, register it with Oracle Clusterware, configure the UNDO tablespaces per instance (\`UNDOTBS1\` on rac1, \`UNDOTBS2\` on rac2), create the REDO log groups, and open PDB1.

---

## Post-Installation Verification

### Clusterware and Database Resource Status

\`\`\`bash
# All cluster resources
crsctl stat res -t

# Init resources (CSS, CRS, ASM)
crsctl stat res -t -init

# Database instances
srvctl status database -d RACDB

# Services
srvctl status service -d RACDB

# SCAN
srvctl status scan
srvctl status scan_listener

# ASM diskgroups
asmcmd lsdg

# Voting disk location and count
crsctl query css votedisk

# OCR integrity
ocrcheck

# SCAN DNS resolution
nslookup racflex-scan
\`\`\`

### SQL Verification

Connect to the database from either Hub node and verify both instances are online:

\`\`\`bash
export ORACLE_HOME=/u01/app/oracle/product/21.0.0/dbhome_1
export ORACLE_SID=RACDB1
sqlplus / as sysdba
\`\`\`

\`\`\`sql
-- Verify both RAC instances are running
SELECT inst_id, instance_name, host_name, status, active_state
FROM   gv\$instance
ORDER  BY inst_id;

-- Verify each instance has its own UNDO tablespace
SELECT inst_id, name, value
FROM   gv\$parameter
WHERE  name = 'undo_tablespace'
ORDER  BY inst_id;

-- Verify PDB status across all instances
SELECT inst_id, con_id, name, open_mode
FROM   gv\$pdbs
WHERE  name = 'PDB1'
ORDER  BY inst_id;
\`\`\`

Expected results: \`gv\$instance\` should show two rows — RACDB1 on rac1 and RACDB2 on rac2, both \`OPEN\` and \`NORMAL\` state. Each instance should reference a distinct UNDO tablespace.

---

## Two Practical Deployment Scenarios

### Scenario 1: Mixed ERP Workload Cluster

A two-Hub, two-Leaf cluster for a mixed ERP workload positions Hub nodes as the exclusive database tier and Leaf nodes as the application tier. Hub nodes (rac1, rac2) host the Oracle Database RAC instances with direct access to the ASM DATA and RECO diskgroups. Leaf nodes (rac3, rac4) host middleware and web server processes that connect to the database exclusively through the SCAN listener.

This topology eliminates the need for a separate application server cluster with its own clusterware stack, while keeping database nodes dedicated and storage access controlled. Clusterware on Leaf nodes provides application-tier high availability — services registered with \`srvctl\` can failover between rac3 and rac4 without any additional cluster manager.

### Scenario 2: Oracle Member Cluster (21c)

In 21c, an Oracle Member Cluster for databases delegates GIMR and voting disk storage to a centrally managed Domain Services Cluster (DSC). A two-Hub Member Cluster at an edge site does not need dedicated shared storage for Grid Infrastructure management — it uses the DSC over the network for OCR, voting disks, and the GIMR health repository. The edge cluster's local shared storage is used exclusively for database data diskgroups.

This is particularly useful in environments where procuring dedicated management-plane storage (minimum 3 disks for GRID diskgroup normal redundancy) at every edge site is cost-prohibitive. The trade-off is a network dependency on the DSC for cluster management operations: if the DSC is unreachable, the Member Cluster continues to run but cannot perform certain management operations such as rolling patches.

---

## Common Installation Pitfalls

**CVU failing on USER_EQUIVALENCE**

Symptom: \`runcluvfy.sh\` reports \`FAILED\` on the \`USER_EQUIVALENCE\` check for the \`grid\` or \`oracle\` user.

Cause: Passwordless SSH is not correctly configured between all nodes for the relevant user.

Resolution: Verify from rac1 that you can SSH to all other nodes without a password prompt:

\`\`\`bash
ssh grid@rac2 date
ssh grid@rac3 date
ssh grid@rac4 date
\`\`\`

Also verify the reverse direction — from rac2, rac3, and rac4 back to rac1. Check \`~/.ssh/authorized_keys\` on each node and confirm file permissions are \`600\` for \`authorized_keys\` and \`700\` for \`~/.ssh\`.

**CVU failing on SCAN_VIP**

Symptom: \`runcluvfy.sh\` reports \`FAILED\` on \`SCAN_VIP\` or SCAN resolution.

Cause: The SCAN name (\`racflex-scan\`) is not resolvable from all nodes, or it resolves to fewer than three IP addresses, or it resolves from \`/etc/hosts\` instead of DNS.

Resolution: Run \`nslookup racflex-scan\` on all four nodes. Configure the DNS round-robin entry to return exactly three IPs. Remove any SCAN entries from \`/etc/hosts\`.

**root.sh Failing on Second Hub Node with "CSS Is Already Running"**

Symptom: \`root.sh\` on rac2 exits with an error indicating that the Cluster Synchronization Services (CSS) daemon is already running and cannot be restarted.

Cause: rac1's \`root.sh\` completed but CSS on rac1 had not fully stabilized before rac2's \`root.sh\` attempted to join the cluster.

Resolution: After rac1's \`root.sh\` completes, wait a minimum of 2 minutes before starting rac2's \`root.sh\`. On very slow storage, wait until \`crsctl stat res -t -init\` on rac1 shows all init resources online before proceeding to rac2.

**ASMFD Labels Not Visible After Node Reboot**

Symptom: After rebooting a Hub node, \`afd_lslbl\` returns no labels and the GRID diskgroup fails to mount.

Cause: The ASMFD kernel module is not loading at boot, or the \`oracleafd\` device path is not populated.

Resolution: Verify with \`/u01/app/21.0.0/grid/bin/asmcmd afd_lslbl\`. Ensure the \`oracleafd\` service is enabled:

\`\`\`bash
systemctl enable oracleafd
systemctl start oracleafd
\`\`\`

Also verify the ASMFD kernel module is loaded: \`lsmod | grep oracleafd\`.

**Leaf Node addnode.sh Failing with Version Mismatch**

Symptom: \`addnode.sh\` on a Leaf node fails with an error indicating that the Grid Infrastructure version on the Leaf node does not match the cluster.

Cause: The GI software on the Leaf node is at a different patch level than the Hub nodes. For example, Hub nodes have RU 21.3.0.0.220118 applied but the Leaf node ZIP was unpatched 21.3.0.0.

Resolution: The Leaf node GI home must be at the exact same patch level as the Hub nodes before running \`addnode.sh\`. Apply the same Release Update to the Leaf node GI home using OPatch before attempting to add the node to the cluster.

---

## Summary

Oracle 21c RAC Flex Cluster extends the proven RAC architecture with Hub and Leaf node roles that allow large-scale clustering without requiring every node to have full shared storage access. Leaf nodes reduce cost and complexity at the application tier while still benefiting from Oracle Clusterware's high availability capabilities. The 21c additions — Oracle Cluster Domain, Member Cluster support, Fleet Patching and Provisioning integration, and ASMFD as the preferred storage layer — make Flex Cluster a mature platform for both on-premises data center deployments and hybrid configurations.

The installation sequence is:

1. OS prerequisites (kernel parameters, packages, users, limits, hosts, SSH, Chrony, SELinux, firewall) on all nodes
2. Network and storage preparation (udev rules, ASMFD labels)
3. Grid Infrastructure software on Hub nodes, CVU pre-check with \`-flex\` flag
4. Run GI installer (silent or OUI), then \`root.sh\` on each Hub node sequentially
5. Leaf nodes join via \`addnode.sh\`, followed by \`root.sh\` on each Leaf node
6. Oracle Database software installation on Hub nodes (software-only mode)
7. ASM diskgroup creation for DATA and RECO
8. DBCA database creation targeting Hub nodes only

The CVU pre-check (\`runcluvfy.sh -flex\`) is the single most important step to execute before starting the GI installer. Every failure it reports will cause the installer to fail later. Resolving CVU failures before starting the installation sequence typically saves several hours of troubleshooting mid-install, where error messages are less direct and the remediation path requires cleaning up a partially configured cluster before retrying.
`,
};

async function main() {
  console.log('Inserting Oracle 21c RAC Flex Cluster blog post...');
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
