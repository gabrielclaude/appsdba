import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle 21c RAC Flex Cluster Installation Runbook: Step-by-Step from OS to Database',
  slug: 'oracle-21c-rac-flex-cluster-install-runbook',
  excerpt:
    'End-to-end installation runbook for Oracle 21c RAC Flex Cluster on Oracle Linux 8: IP allocation, OS prerequisites, Grid Infrastructure silent install, Leaf node addition, DBCA database creation, and post-install verification with diagnostic scripts.',
  category: 'rac-clusterware' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-01'),
  youtubeUrl: null,
  content: `This runbook covers the end-to-end installation of Oracle 21c RAC Flex Cluster: two Hub nodes (rac1, rac2) that run CRS, ASM, and database instances, and two Leaf nodes (rac3, rac4) that run only database instances and depend on Hub nodes for storage and cluster services. The target OS is Oracle Linux 8. Every command is exact. Every expected output is noted. Every verification step is included.

Estimated elapsed time for an experienced DBA on pre-configured hardware: 6–10 hours. Plan a maintenance window of at least 12 hours for a first-time installation.

---

## Phase 1: Environment Planning and IP Allocation

Complete this table before touching any server. Do not start Phase 2 until every cell is filled in and verified with the network team.

### 1.1 IP Allocation Table

| Role | Hostname | Public IP | VIP IP | Private (Interconnect) IP |
|------|----------|-----------|--------|--------------------------|
| Hub Node 1 | rac1 | 192.168.1.101 | 192.168.1.111 | 10.0.0.101 |
| Hub Node 2 | rac2 | 192.168.1.102 | 192.168.1.112 | 10.0.0.102 |
| Leaf Node 1 | rac3 | 192.168.1.103 | (none) | 10.0.0.103 |
| Leaf Node 2 | rac4 | 192.168.1.104 | (none) | 10.0.0.104 |
| SCAN VIP 1 | racflex-scan | 192.168.1.121 | — | — |
| SCAN VIP 2 | racflex-scan | 192.168.1.122 | — | — |
| SCAN VIP 3 | racflex-scan | 192.168.1.123 | — | — |

- **Cluster name**: racflex-cluster
- **SCAN name**: racflex-scan (must resolve to all 3 SCAN IPs via DNS round-robin)
- **SCAN port**: 1521
- **Domain**: example.com (replace with your internal domain)

ASM disk devices (fill in before Phase 5):

| Disk Group | Redundancy | Devices | Purpose |
|-----------|-----------|---------|---------|
| GRID | NORMAL | /dev/sdb, /dev/sdc, /dev/sdd | OCR, voting, GI metadata |
| DATA | NORMAL | /dev/sde, /dev/sdf | Database files |
| RECO | NORMAL | /dev/sdg, /dev/sdh | FRA, archive logs |

### 1.2 /etc/hosts Entries

All four nodes must have identical /etc/hosts entries. The format below is the baseline — adjust IPs to match your allocation table.

\`\`\`
# /etc/hosts — Oracle RAC Flex Cluster — replicate identically on all 4 nodes

# Loopback
127.0.0.1    localhost localhost.localdomain

# Public interfaces
192.168.1.101  rac1      rac1.example.com
192.168.1.102  rac2      rac2.example.com
192.168.1.103  rac3      rac3.example.com
192.168.1.104  rac4      rac4.example.com

# Virtual IPs (Hub nodes only)
192.168.1.111  rac1-vip  rac1-vip.example.com
192.168.1.112  rac2-vip  rac2-vip.example.com

# Private interconnect (all nodes)
10.0.0.101     rac1-priv rac1-priv.example.com
10.0.0.102     rac2-priv rac2-priv.example.com
10.0.0.103     rac3-priv rac3-priv.example.com
10.0.0.104     rac4-priv rac4-priv.example.com

# SCAN — 3 entries with the same name (DNS preferred; if using /etc/hosts, only one entry is possible)
# Prefer DNS for SCAN. If using /etc/hosts as a workaround, add only one SCAN IP here
# and update DNS as soon as possible.
192.168.1.121  racflex-scan racflex-scan.example.com
\`\`\`

### 1.3 DNS Configuration for SCAN

SCAN requires DNS round-robin — it cannot be served adequately from /etc/hosts in production because only one entry per name is honoured. Configure three A records in your internal DNS zone:

\`\`\`
; DNS zone file entries for SCAN
racflex-scan    IN  A  192.168.1.121
racflex-scan    IN  A  192.168.1.122
racflex-scan    IN  A  192.168.1.123
\`\`\`

Set TTL to 5 seconds on the SCAN records to allow failover to respond quickly. Verify from all four nodes that nslookup returns all three IPs before proceeding to GI installation.

**GNS alternative**: Oracle Grid Naming Service can replace static DNS for SCAN by dynamically registering addresses. GNS adds operational complexity and requires its own VIP. For most environments, static DNS SCAN records are simpler and preferred.

---

## Phase 2: OS Prerequisites — All Nodes

Run every command in this phase on rac1, rac2, rac3, and rac4 unless explicitly noted otherwise. Use a configuration management tool or parallel SSH (pssh, Ansible) to avoid drift between nodes.

### 2.1 Install Oracle Preinstall RPM and Required Packages

The oracle-database-preinstall-21c RPM automatically sets most kernel parameters and creates the oracle user. Install it first, then supplement with the packages below.

\`\`\`bash
# As root on ALL nodes
dnf install -y oracle-database-preinstall-21c

dnf install -y ksh bc binutils elfutils-libelf elfutils-libelf-devel \\
  fontconfig-devel glibc glibc-devel ksh libaio libaio-devel \\
  libgcc libnsl libnsl2 libstdc++ libstdc++-devel libxcb \\
  libX11 libXau libXi libXtst libXrender libXrender-devel \\
  make net-tools nfs-utils python3 python3-configshell \\
  python3-rtslib python3-six targetcli smartmontools sysstat \\
  unixODBC unixODBC-devel
\`\`\`

Expected output ends with: \`Complete!\`

Verify the preinstall RPM was applied:

\`\`\`bash
rpm -q oracle-database-preinstall-21c
# Expected: oracle-database-preinstall-21c-21.0-1.el8.x86_64 (version may vary)
\`\`\`

### 2.2 Create OS Users and Groups

Create matching UID/GID on all nodes. UID/GID consistency across nodes is mandatory for NFS-mounted orainventory and for CRS internal mechanisms.

The preinstall RPM creates the oracle user and oinstall/dba groups. Add the remaining groups and the grid user manually.

\`\`\`bash
# As root on ALL nodes — run in this exact order
groupadd -g 54321 oinstall  2>/dev/null || true
groupadd -g 54322 dba       2>/dev/null || true
groupadd -g 54323 oper      2>/dev/null || true
groupadd -g 54324 backupdba 2>/dev/null || true
groupadd -g 54325 dgdba     2>/dev/null || true
groupadd -g 54326 kmdba     2>/dev/null || true
groupadd -g 54327 asmdba    2>/dev/null || true
groupadd -g 54328 asmoper   2>/dev/null || true
groupadd -g 54329 asmadmin  2>/dev/null || true
groupadd -g 54330 racdba    2>/dev/null || true

# Re-create oracle user with correct supplemental groups
# (preinstall RPM may have created it; usermod to ensure all groups are present)
usermod -u 54321 -g oinstall -G dba,oper,backupdba,dgdba,kmdba,racdba,asmdba oracle

# Create grid user
useradd -u 54322 -g oinstall -G asmadmin,asmdba,asmoper,dba grid

passwd oracle   # set a strong password; record it in your credential vault
passwd grid
\`\`\`

Verify UID/GID on all nodes:

\`\`\`bash
id oracle
# Expected: uid=54321(oracle) gid=54321(oinstall) groups=54321(oinstall),54322(dba),54323(oper),...
id grid
# Expected: uid=54322(grid) gid=54321(oinstall) groups=54321(oinstall),54329(asmadmin),...
\`\`\`

Run the same id commands on rac2, rac3, rac4 and confirm output is identical.

### 2.3 Kernel Parameters

The preinstall RPM sets most parameters. Create an explicit override file to ensure values survive OS updates and to document your cluster's specific settings.

\`\`\`bash
# As root on ALL nodes
cat > /etc/sysctl.d/99-oracle-rac.conf << 'EOF'
fs.file-max = 6815744
kernel.sem = 250 32000 100 128
kernel.shmmni = 4096
kernel.shmall = 1073741824
kernel.shmmax = 4398046511104
kernel.panic_on_oops = 1
net.core.rmem_default = 262144
net.core.rmem_max = 4194304
net.core.wmem_default = 262144
net.core.wmem_max = 1048576
net.ipv4.conf.all.rp_filter = 2
net.ipv4.conf.default.rp_filter = 2
fs.aio-max-nr = 1048576
net.ipv4.ip_local_port_range = 9000 65500
EOF

sysctl --system
\`\`\`

Verify a representative parameter:

\`\`\`bash
sysctl fs.file-max
# Expected: fs.file-max = 6815744
\`\`\`

Note on \`net.ipv4.conf.all.rp_filter = 2\`: Setting rp_filter to 2 (loose mode) instead of 1 (strict) is required on the private interconnect interface to prevent the kernel from dropping interconnect packets on multi-homed nodes. Do not use rp_filter = 1 on RAC nodes.

### 2.4 OS User Limits

\`\`\`bash
# As root on ALL nodes
cat > /etc/security/limits.d/99-oracle-rac.conf << 'EOF'
oracle   soft   nofile    1024
oracle   hard   nofile    65536
oracle   soft   nproc     16384
oracle   hard   nproc     16384
oracle   soft   stack     10240
oracle   hard   stack     32768
oracle   hard   memlock   134217728
oracle   soft   memlock   134217728
grid     soft   nofile    1024
grid     hard   nofile    65536
grid     soft   nproc     16384
grid     hard   nproc     16384
grid     soft   stack     10240
grid     hard   stack     32768
grid     hard   memlock   134217728
grid     soft   memlock   134217728
EOF
\`\`\`

Verify after logging in as each user (limits apply to new sessions only):

\`\`\`bash
su - oracle -c "ulimit -n"   # Expected: 1024 (soft) — new session sees soft limit
su - grid   -c "ulimit -Hn"  # Expected: 65536 (hard)
\`\`\`

### 2.5 Disable Firewalld and Set SELinux to Permissive

\`\`\`bash
# As root on ALL nodes
systemctl disable --now firewalld
systemctl status firewalld
# Expected: Active: inactive (dead)

sed -i 's/^SELINUX=enforcing/SELINUX=permissive/' /etc/selinux/config
setenforce 0
getenforce
# Expected: Permissive
\`\`\`

Note: Setting SELinux to Permissive is Oracle's documented requirement for RAC. Do not set it to Disabled — Permissive logs denials without enforcing them, which provides audit data without blocking Oracle operations.

### 2.6 Verify NTP/Chrony Time Synchronisation

All cluster nodes must be within 1000 ms (1 second) of each other. CVU enforces this check. CRS itself enforces < 200 ms on the interconnect.

\`\`\`bash
# As root on ALL nodes
chronyc tracking
# Key fields to verify:
#   System time: offset should be < 0.5 seconds
#   Leap status : Normal

chronyc sources -v
# Every source line should show * (synced) or + (candidate)
# No source should show ? (unreachable) for the primary source

# Compare offset across nodes — log the "System time" value from each:
# rac1: System time = 0.000123456 seconds fast of NTP time
# rac2: System time = 0.000098765 seconds fast of NTP time
# rac3: System time = 0.000134567 seconds slow of NTP time
# rac4: System time = 0.000112233 seconds fast of NTP time
\`\`\`

If any node shows an offset > 500 ms, do not proceed. Fix chrony configuration first (check /etc/chrony.conf, ensure all nodes point to the same NTP servers).

### 2.7 Create Directory Structure (Hub Nodes Only — rac1 and rac2)

Leaf nodes do not run GI or ASM, so the GI home directories are created only on Hub nodes. The DB home directories must exist on all nodes where database instances will run (rac1 and rac2 for this configuration).

\`\`\`bash
# As root on rac1 and rac2 ONLY
mkdir -p /u01/app/21.0.0/grid
mkdir -p /u01/app/oracle/product/21.0.0/dbhome_1
mkdir -p /u01/app/oracle
mkdir -p /u01/app/oraInventory

chown -R grid:oinstall   /u01/app/21.0.0/grid
chown -R oracle:oinstall /u01/app/oracle/product/21.0.0/dbhome_1
chown -R oracle:oinstall /u01/app/oracle
chown -R grid:oinstall   /u01/app/oraInventory
chmod -R 775 /u01

ls -la /u01/app/
# Expected:
# drwxrwxr-x. grid   oinstall 21.0.0/
# drwxrwxr-x. oracle oinstall oracle/
# drwxrwxr-x. grid   oinstall oraInventory/
\`\`\`

---

## Phase 3: Network Verification — All Nodes

Run these checks from each node before starting GI installation. CVU will check all of them, but catching issues now is faster than diagnosing a failed CVU run.

### 3.1 Verify /etc/hosts Consistency

\`\`\`bash
# As root — run on ALL nodes
md5sum /etc/hosts
# The MD5 sum must be IDENTICAL on all four nodes
# Any difference means you have a copy/paste error in the hosts file
\`\`\`

### 3.2 Verify SCAN Resolution Returns 3 IPs

\`\`\`bash
# As root — run on ALL nodes
nslookup racflex-scan
# Expected output (order of IPs may vary, that is normal):
# Server:   192.168.1.10  (your DNS server)
# Address:  192.168.1.10#53
# Name:    racflex-scan.example.com
# Address: 192.168.1.121
# Name:    racflex-scan.example.com
# Address: 192.168.1.122
# Name:    racflex-scan.example.com
# Address: 192.168.1.123

# If nslookup returns only 1 IP, SCAN DNS is not configured correctly.
# Do NOT use /etc/hosts for SCAN in production — it returns only 1 entry.
\`\`\`

### 3.3 Verify Interconnect Interfaces

\`\`\`bash
# As root — check the private interface is up and assigned the correct IP
ip addr show eth1
# Expected: inet 10.0.0.101/24 (on rac1), 10.0.0.102/24 (on rac2), etc.

# Ping interconnect from rac1 to rac2
ping -c 5 rac2-priv
# Expected: 0% packet loss, RTT < 1ms on direct-attached or switch interconnect

# Verify MTU is 9000 (jumbo frames recommended for interconnect)
ip link show eth1 | grep mtu
# Expected: mtu 9000
# If MTU is 1500, discuss with the network team — jumbo frames reduce interconnect overhead significantly
\`\`\`

---

## Phase 4: SSH Equivalence Setup — All Nodes

Both the grid and oracle OS users require passwordless SSH between all node pairs. GI installer uses SSH to push files and run remote commands during installation.

### 4.1 Generate SSH Keys

Run as each user (grid and oracle) on EACH of the four nodes:

\`\`\`bash
# As grid user on rac1, rac2, rac3, rac4:
ssh-keygen -t rsa -b 2048 -f ~/.ssh/id_rsa -N ""
# Accept defaults. This creates ~/.ssh/id_rsa and ~/.ssh/id_rsa.pub
\`\`\`

### 4.2 Distribute Public Keys

Collect the public key content from all four nodes for each user. On each node, the ~/.ssh/authorized_keys file must contain all four nodes' public keys.

\`\`\`bash
# Manual method — run on each node as the grid user:
cat ~/.ssh/id_rsa.pub
# Copy the output line

# On each node, append all 4 nodes' public keys:
cat >> ~/.ssh/authorized_keys << 'EOF'
<paste rac1 grid id_rsa.pub content here>
<paste rac2 grid id_rsa.pub content here>
<paste rac3 grid id_rsa.pub content here>
<paste rac4 grid id_rsa.pub content here>
EOF

chmod 600 ~/.ssh/authorized_keys
chmod 700 ~/.ssh
\`\`\`

Repeat the same procedure for the oracle user on all four nodes.

### 4.3 Test SSH from Every Node to Every Node

\`\`\`bash
# As grid user — run from each node, test to all 4 nodes:
ssh -o StrictHostKeyChecking=no grid@rac1 date
ssh -o StrictHostKeyChecking=no grid@rac2 date
ssh -o StrictHostKeyChecking=no grid@rac3 date
ssh -o StrictHostKeyChecking=no grid@rac4 date
# Expected: date output printed with NO password prompt
# If prompted for password: authorized_keys is missing or has wrong permissions

# As oracle user — same test:
ssh -o StrictHostKeyChecking=no oracle@rac1 hostname
ssh -o StrictHostKeyChecking=no oracle@rac2 hostname
ssh -o StrictHostKeyChecking=no oracle@rac3 hostname
ssh -o StrictHostKeyChecking=no oracle@rac4 hostname
\`\`\`

For large clusters, use the Oracle-provided SSH setup helper after staging GI software:

\`\`\`bash
# As grid user on rac1 (run after GI media is staged):
/u01/app/21.0.0/grid/oui/prov/resources/scripts/sshUserSetup.sh \\
  -user grid \\
  -hosts "rac1 rac2 rac3 rac4" \\
  -advanced \\
  -noPromptPassphrase
\`\`\`

---

## Phase 5: Storage Preparation — Hub Nodes Only (rac1 and rac2)

Shared block storage (LUNs presented via FC or iSCSI) must be visible on both Hub nodes with identical device sizes. Leaf nodes do not require direct access to ASM storage — they access data through the Flex ASM instance running on Hub nodes.

### 5.1 Identify Shared Block Devices

\`\`\`bash
# As root on rac1:
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT
# Identify raw block devices with no FSTYPE — these are candidates for ASM

# Confirm the same devices are visible from rac2 with the same size:
blockdev --getsize64 /dev/sdb   # on rac1
# Run same command on rac2 — output must match byte for byte

# Verify no existing filesystem or partition table:
file -s /dev/sdb
# Expected: /dev/sdb: data    (means no recognisable filesystem)
# If it shows ext4, xfs, or partition table: STOP — wrong device
\`\`\`

### 5.2 Zero the Superblocks

This removes any residual ASM headers, partition tables, or filesystem signatures that could confuse ASM candidate detection.

\`\`\`bash
# As root on rac1 — run for each ASM device:
dd if=/dev/zero of=/dev/sdb bs=1M count=100 oflag=direct
dd if=/dev/zero of=/dev/sdc bs=1M count=100 oflag=direct
dd if=/dev/zero of=/dev/sdd bs=1M count=100 oflag=direct
dd if=/dev/zero of=/dev/sde bs=1M count=100 oflag=direct
dd if=/dev/zero of=/dev/sdf bs=1M count=100 oflag=direct
dd if=/dev/zero of=/dev/sdg bs=1M count=100 oflag=direct
dd if=/dev/zero of=/dev/sdh bs=1M count=100 oflag=direct
# Expected output per device: 100+0 records in / 100+0 records out
\`\`\`

### 5.3 Configure udev Rules for ASM Device Ownership

udev rules ensure that after every reboot the ASM devices have the correct owner (grid), group (asmdba), and permissions (0660).

\`\`\`bash
# As root on rac1 and rac2 (must be identical):
cat > /etc/udev/rules.d/99-oracle-asmdevices.rules << 'EOF'
KERNEL=="sdb", OWNER="grid", GROUP="asmdba", MODE="0660"
KERNEL=="sdc", OWNER="grid", GROUP="asmdba", MODE="0660"
KERNEL=="sdd", OWNER="grid", GROUP="asmdba", MODE="0660"
KERNEL=="sde", OWNER="grid", GROUP="asmdba", MODE="0660"
KERNEL=="sdf", OWNER="grid", GROUP="asmdba", MODE="0660"
KERNEL=="sdg", OWNER="grid", GROUP="asmdba", MODE="0660"
KERNEL=="sdh", OWNER="grid", GROUP="asmdba", MODE="0660"
EOF

udevadm control --reload-rules
udevadm trigger

# Verify ownership:
ls -la /dev/sdb /dev/sdc /dev/sdd /dev/sde /dev/sdf /dev/sdg /dev/sdh
# Expected: brw-rw----. 1 grid asmdba ... /dev/sdb
\`\`\`

For environments using multipathing (DM-Multipath), the udev rules must match the dm-* or mapper/* device names, not the raw sdb/sdc names. Consult the storage team for the correct device naming convention.

---

## Phase 6: CVU Pre-Check

The Cluster Verification Utility (CVU) is the gate between OS preparation and GI installation. Every FAILED check must be resolved. WARNING checks must be understood before you proceed.

### 6.1 Stage GI Software

\`\`\`bash
# As grid user on rac1 — unzip the GI distribution archive:
cd /tmp
unzip LINUX.X64_213000_grid_home.zip -d /u01/app/21.0.0/grid
chown -R grid:oinstall /u01/app/21.0.0/grid
\`\`\`

### 6.2 Run CVU Pre-Check

\`\`\`bash
# As grid user on rac1:
cd /u01/app/21.0.0/grid

./runcluvfy.sh stage -pre crsinst \\
  -n rac1,rac2 \\
  -flex \\
  -hub rac1,rac2 \\
  -leaf rac3,rac4 \\
  -vip "rac1:rac1-vip,rac2:rac2-vip" \\
  -scan racflex-scan:1521 \\
  -verbose 2>&1 | tee /tmp/cvu_precheck.log
\`\`\`

Review the output:

\`\`\`bash
grep -E "FAILED|PASSED|WARNING" /tmp/cvu_precheck.log | sort -u
\`\`\`

### 6.3 Common CVU Failures and Resolutions

| CVU Check | Likely Cause | Resolution |
|-----------|-------------|------------|
| USER_EQUIVALENCE | SSH not working for grid user | Re-run Phase 4.3; check authorized_keys permissions |
| SCAN_VIP | SCAN DNS returns < 3 IPs | Fix DNS zone; confirm TTL and zone reload |
| NETWORK_INTERFACE_MTU | Interconnect MTU < 9000 | Set MTU on eth1 on all nodes: \`ip link set eth1 mtu 9000\` |
| CLOCK_SYNCHRONIZATION | NTP offset > 1000 ms | Fix chrony; confirm all nodes use the same NTP server |
| KERNEL_PARAMETER | Parameter below minimum | Re-check /etc/sysctl.d/99-oracle-rac.conf; run \`sysctl --system\` |
| OS_PACKAGE | Missing RPM | Run \`dnf install -y <package>\` on affected nodes |
| ASM_DEVICE | Device not accessible as grid | Check udev rules; re-run udevadm trigger |

Do not use \`-ignorePrereqFailure\` to bypass FAILED checks in CVU — it hides problems that will cause CRS or ASM failures at a harder-to-diagnose stage. Fix each failure at the source.

---

## Phase 7: Grid Infrastructure Installation — Hub Nodes

### 7.1 Prepare Silent Response File

Create /home/grid/grid_install.rsp on rac1. This file is read by the installer running on rac1; it pushes software to rac2 via SSH automatically.

\`\`\`
# /home/grid/grid_install.rsp
oracle.install.responseFileVersion=/oracle/install/rspfmt_crsinstall_response_schema_v21.0.0
ORACLE_HOSTNAME=rac1
INVENTORY_LOCATION=/u01/app/oraInventory
oracle.install.option=CRS_CONFIG
ORACLE_BASE=/u01/app/grid

oracle.install.asm.OSDBA=asmdba
oracle.install.asm.OSOPER=asmoper
oracle.install.asm.OSASM=asmadmin

oracle.install.crs.config.clusterName=racflex-cluster
oracle.install.crs.config.clusterNodes=rac1:rac1-vip:HUB,rac2:rac2-vip:HUB,rac3::LEAF,rac4::LEAF
oracle.install.crs.config.networkInterfaceList=eth0:192.168.1.0:1,eth1:10.0.0.0:2

oracle.install.crs.config.gpnp.scanName=racflex-scan
oracle.install.crs.config.gpnp.scanPort=1521
oracle.install.crs.config.ClusterType=FLEX
oracle.install.crs.config.storageOption=FLEX_ASM_STORAGE
oracle.install.crs.config.sharedFileSystemStorage.diskDriveMapping=

oracle.install.asm.diskGroup.name=GRID
oracle.install.asm.diskGroup.redundancy=NORMAL
oracle.install.asm.diskGroup.AUSize=4
oracle.install.asm.diskGroup.disksWithFailureGroupNames=/dev/sdb:FG1,/dev/sdc:FG2,/dev/sdd:FG3

oracle.install.asm.monitorPassword=<GridAdminPassword>
oracle.install.crs.rootconfig.configMethod=ROOT
\`\`\`

Key parameters explained:
- **clusterNodes**: Hub nodes get a VIP address. Leaf nodes use empty VIP field (\`rac3::LEAF\`).
- **networkInterfaceList**: eth0 = public (role 1), eth1 = private interconnect (role 2).
- **ClusterType=FLEX**: Enables Flex Cluster topology.
- **storageOption=FLEX_ASM_STORAGE**: Enables Flex ASM — Leaf nodes use a Hub node's ASM instance.
- **diskGroup.disksWithFailureGroupNames**: NORMAL redundancy requires 3 disks in 3 separate failure groups for 2-failure-group minimum — 3 FGs gives you headroom and is the recommended baseline.

### 7.2 Run GI Installer as Grid User on rac1

\`\`\`bash
# As grid user on rac1:
/u01/app/21.0.0/grid/gridSetup.sh \\
  -silent \\
  -responseFile /home/grid/grid_install.rsp \\
  -ignorePrereqFailure 2>&1 | tee /tmp/gi_install.log
\`\`\`

Monitor progress:

\`\`\`bash
# In a separate session — watch the log:
tail -f /tmp/gi_install.log
\`\`\`

The installer will print a series of progress messages. When it reaches the configuration phase it will pause and print:

\`\`\`
The following configuration scripts need to be executed as the "root" user.
 /u01/app/oraInventory/orainstRoot.sh
 /u01/app/21.0.0/grid/root.sh
To execute the configuration scripts:
 1. Open a terminal window
 2. Log in as "root"
 3. Run the scripts
 4. Return to this window and click "OK" to continue
\`\`\`

In silent mode the installer waits for a specific file — see Step 7.4 below.

### 7.3 Run orainstRoot.sh (if Inventory Does Not Exist Yet)

\`\`\`bash
# As root on rac1:
/u01/app/oraInventory/orainstRoot.sh
# Expected output:
# Changing permissions of /u01/app/oraInventory.
# Adding read,write permissions for group.
# Removing read,write,execute permissions for world.
# Changing groupname of /u01/app/oraInventory to oinstall.
# The execution of the script is complete.
\`\`\`

### 7.4 Run root.sh on rac1 (Hub Node 1)

\`\`\`bash
# As root on rac1:
/u01/app/21.0.0/grid/root.sh 2>&1 | tee /tmp/gi_root_rac1.log
\`\`\`

This script performs the most critical work in the entire installation:
- Installs and starts Oracle High Availability Services (ohasd)
- Formats the GRID ASM diskgroup (OCR and voting disk initialisation)
- Registers cluster resources in the OCR
- Starts CRSD, CSSD, EVMD daemons

Expected significant output lines (in order):

\`\`\`
Performing root user operation.
The following environment variables are set as:
    ORACLE_OWNER= grid
    ORACLE_HOME=  /u01/app/21.0.0/grid
Entries will be added to the /etc/oratab file as needed by Database Configuration Assistant when a database is created
Finished running generic part of root script.
Now product-specific root actions will be performed.
Relinking oracle with rac options
Using configuration parameter file: /u01/app/21.0.0/grid/crs/install/crsconfig_params
The log of current session can be found at:
  /u01/app/grid/crsdata/rac1/crs/install/crsinstall_<timestamp>.log
2026-07-01 10:23:11: Parsing the input arguments
...
CRS-4133: Oracle High Availability Services has been stopped.
CRS-4123: Oracle High Availability Services has been started.
CRS-2672: Attempting to start 'ora.cssdmonitor' on 'rac1'
...
CRS-2676: Start of 'ora.crs' on 'rac1' succeeded
...
ASM created and started successfully.
Disk Group GRID created successfully.
...
clscfg: EXISTING configuration version 21 detected.
clscfg: version 21 = 21c
Successfully accumulated necessary OCR keys.
...
root.sh execution successful.
\`\`\`

The script takes 10–15 minutes. Do NOT interrupt it. If it fails, collect /u01/app/grid/crsdata/rac1/crs/install/crsinstall_*.log before attempting any remediation.

### 7.5 Run root.sh on rac2 (Hub Node 2)

Wait at least 2 minutes after rac1 root.sh completes and CRS is fully up before running on rac2.

\`\`\`bash
# Verify CRS is running on rac1 before proceeding:
crsctl check crs
# Expected: CRS-4638: Oracle High Availability Services is online
#           CRS-4537: Cluster Ready Services is online
#           CRS-4529: Cluster Synchronization Services is online
#           CRS-4533: Event Manager is online

# Then as root on rac2:
/u01/app/21.0.0/grid/root.sh 2>&1 | tee /tmp/gi_root_rac2.log
\`\`\`

After rac2 root.sh completes, verify both Hub nodes are in the cluster:

\`\`\`bash
# As grid user on rac1:
olsnodes -n -i -s -t
# Expected:
# rac1  1  rac1-vip  Active  Hub
# rac2  2  rac2-vip  Active  Hub
\`\`\`

### 7.6 Complete Silent Installer

In silent mode, signal the installer that root.sh has completed:

\`\`\`bash
# The silent installer monitors a response file. In most 21c silent installs
# the installer completes automatically after root.sh finishes on all Hub nodes.
# If it is still waiting, press Enter in the installer terminal window.

# Verify in the install log:
tail -20 /tmp/gi_install.log
# Expected last lines:
# Oracle Grid Infrastructure 21c was installed successfully.
\`\`\`

---

## Phase 8: Add Leaf Nodes (rac3 and rac4)

Leaf nodes are added after GI is stable on both Hub nodes. Add them one at a time. The addnode.sh script pushes GI software to the Leaf node and registers it in the cluster.

### 8.1 Add rac3

\`\`\`bash
# As grid user on rac1:
/u01/app/21.0.0/grid/addnode.sh \\
  -silent \\
  "CLUSTER_NEW_NODES={rac3}" \\
  "CLUSTER_NEW_NODE_ROLES={LEAF}" 2>&1 | tee /tmp/addnode_rac3.log
\`\`\`

When addnode.sh completes, run root.sh on rac3:

\`\`\`bash
# As root on rac3:
/u01/app/21.0.0/grid/root.sh 2>&1 | tee /tmp/gi_root_rac3.log
\`\`\`

Verify rac3 joined successfully:

\`\`\`bash
# As grid user on rac1:
olsnodes -n -i -s -t
# Expected: rac3 shown as Active, Leaf
\`\`\`

### 8.2 Add rac4

Repeat the same procedure for rac4:

\`\`\`bash
# As grid user on rac1:
/u01/app/21.0.0/grid/addnode.sh \\
  -silent \\
  "CLUSTER_NEW_NODES={rac4}" \\
  "CLUSTER_NEW_NODE_ROLES={LEAF}" 2>&1 | tee /tmp/addnode_rac4.log

# As root on rac4:
/u01/app/21.0.0/grid/root.sh 2>&1 | tee /tmp/gi_root_rac4.log
\`\`\`

Final verification after both Leaf nodes are added:

\`\`\`bash
olsnodes -n -i -s -t
# Expected (all 4 nodes):
# rac1  1  rac1-vip  Active  Hub
# rac2  2  rac2-vip  Active  Hub
# rac3  3            Active  Leaf
# rac4  4            Active  Leaf
\`\`\`

---

## Phase 9: Oracle Database 21c Software Installation — Hub Nodes

Database instances run only on Hub nodes in this configuration. Install the DB home on rac1 and rac2.

### 9.1 Stage DB Software

\`\`\`bash
# As oracle user on rac1:
cd /tmp
unzip LINUX.X64_213000_db_home.zip -d /u01/app/oracle/product/21.0.0/dbhome_1
chown -R oracle:oinstall /u01/app/oracle/product/21.0.0/dbhome_1
\`\`\`

### 9.2 Prepare DB Response File

Create /home/oracle/db_install.rsp on rac1:

\`\`\`
# /home/oracle/db_install.rsp
oracle.install.responseFileVersion=/oracle/install/rspfmt_dbinstall_response_schema_v21.0.0
oracle.install.option=INSTALL_DB_SWONLY
ORACLE_HOSTNAME=rac1
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
oracle.install.db.CLUSTER_NODES=rac1,rac2
oracle.install.db.config.starterdb.type=GENERAL_PURPOSE
\`\`\`

### 9.3 Install DB Software

\`\`\`bash
# As oracle user on rac1:
/u01/app/oracle/product/21.0.0/dbhome_1/runInstaller \\
  -silent \\
  -responseFile /home/oracle/db_install.rsp \\
  -ignorePrereqFailure 2>&1 | tee /tmp/db_install.log
\`\`\`

The installer pushes software to rac2 automatically via SSH. Monitor progress:

\`\`\`bash
tail -f /tmp/db_install.log
# Expected near the end:
# Successfully Setup Software with warning(s).
# Or: Successfully Setup Software.
\`\`\`

### 9.4 Run DB root.sh on rac1 and rac2

\`\`\`bash
# As root on rac1:
/u01/app/oracle/product/21.0.0/dbhome_1/root.sh
# Expected output ends with: /u01/app/oracle/product/21.0.0/dbhome_1/root.sh execution successful.

# Wait for rac1 to complete, then as root on rac2:
/u01/app/oracle/product/21.0.0/dbhome_1/root.sh
\`\`\`

### 9.5 Set Environment Variables (Hub Nodes — oracle user)

Add to /home/oracle/.bash_profile on rac1 and rac2:

\`\`\`bash
export ORACLE_BASE=/u01/app/oracle
export ORACLE_HOME=/u01/app/oracle/product/21.0.0/dbhome_1
export ORACLE_SID=RACDB1   # RACDB2 on rac2
export PATH=\${ORACLE_HOME}/bin:\${PATH}
export LD_LIBRARY_PATH=\${ORACLE_HOME}/lib:/lib:/usr/lib
\`\`\`

Add to /home/grid/.bash_profile on rac1 and rac2:

\`\`\`bash
export ORACLE_BASE=/u01/app/grid
export ORACLE_HOME=/u01/app/21.0.0/grid
export PATH=\${ORACLE_HOME}/bin:\${PATH}
\`\`\`

---

## Phase 10: Create ASM Diskgroups and RAC Database

### 10.1 Verify GRID Diskgroup Is Mounted

\`\`\`bash
# As grid user on rac1:
asmcmd lsdg
# Expected: GRID diskgroup in MOUNTED state
# GRID  3  2  NORMAL  ...  MOUNTED
\`\`\`

### 10.2 Create DATA Diskgroup

\`\`\`bash
# As grid user on rac1:
asmca -silent -createDiskGroup \\
  -diskGroupName DATA \\
  -diskList '/dev/sde,/dev/sdf' \\
  -redundancy NORMAL \\
  -au_size 4 \\
  -compatible.asm '21.0' \\
  -compatible.rdbms '21.0'
# Expected: Disk group DATA created successfully.
\`\`\`

### 10.3 Create RECO Diskgroup

\`\`\`bash
asmca -silent -createDiskGroup \\
  -diskGroupName RECO \\
  -diskList '/dev/sdg,/dev/sdh' \\
  -redundancy NORMAL \\
  -au_size 4 \\
  -compatible.asm '21.0' \\
  -compatible.rdbms '21.0'
# Expected: Disk group RECO created successfully.
\`\`\`

Verify all three diskgroups are mounted:

\`\`\`bash
asmcmd lsdg
# Expected — all three rows show MOUNTED:
# State    Type    Rebal  Sector  Logical_Sector  Block  AU    Total_MB  Free_MB  Req_mir_free_MB  Usable_file_MB  Offline_disks  Voting_files  Name
# MOUNTED  NORMAL  N      512     512             4096   4194304  ...  Y  GRID/
# MOUNTED  NORMAL  N      512     512             4096   4194304  ...  N  DATA/
# MOUNTED  NORMAL  N      512     512             4096   4194304  ...  N  RECO/
\`\`\`

### 10.4 Create RAC Database with DBCA

\`\`\`bash
# As oracle user on rac1:
dbca -silent \\
  -createDatabase \\
  -templateName General_Purpose.dbc \\
  -gdbName RACDB \\
  -createAsContainerDatabase true \\
  -numberOfPDBs 1 \\
  -pdbName PDB1 \\
  -SysPassword <SysPassword> \\
  -SystemPassword <SystemPassword> \\
  -pdbAdminPassword <PdbAdminPassword> \\
  -emConfiguration NONE \\
  -storageType ASM \\
  -diskGroupName DATA \\
  -recoveryGroupName RECO \\
  -enableArchive true \\
  -nodeinfo rac1,rac2 \\
  -listeners LISTENER \\
  -databaseType MULTIPURPOSE \\
  -totalMemory 4096 \\
  -automaticMemoryManagement false 2>&1 | tee /tmp/dbca.log
\`\`\`

DBCA creates both instances (RACDB1 on rac1, RACDB2 on rac2), creates the spfile in +DATA, creates undo tablespaces per instance, and registers the database with srvctl.

Expected final line:

\`\`\`
100% complete
Look at the log file "/u01/app/oracle/cfgtoollogs/dbca/RACDB/RACDB.log" for further details.
\`\`\`

Verify database is open on both nodes:

\`\`\`bash
srvctl status database -d RACDB
# Expected:
# Instance RACDB1 is running on node rac1
# Instance RACDB2 is running on node rac2
\`\`\`

---

## Phase 11: Post-Installation Verification Checklist

### 11.1 Resource and Cluster State

| Check | Command | Expected Result |
|-------|---------|-----------------|
| All CRS resources | \`crsctl stat res -t\` | All resources ONLINE |
| Node roles | \`olsnodes -n -i -s -t\` | rac1/rac2=Hub, rac3/rac4=Leaf |
| Voting disks | \`crsctl query css votedisk\` | 3 voting disks ONLINE |
| OCR integrity | \`ocrcheck\` | OCR check succeeded |
| SCAN VIPs | \`srvctl status scan\` | SCAN VIPs running on Hub nodes |
| SCAN listener | \`srvctl status scan_listener\` | SCAN listeners running |
| Database instances | \`srvctl status database -d RACDB\` | Instances on rac1 and rac2 OPEN |
| ASM diskgroups | \`asmcmd lsdg\` | GRID, DATA, RECO MOUNTED |

### 11.2 Full CRS Resource Table

\`\`\`bash
# As grid user on rac1 — expected output shows all resources:
crsctl stat res -t
# Example ONLINE resources (abbreviated):
#   ora.GRID.dg             ONLINE  ONLINE  rac1  ...
#   ora.DATA.dg             ONLINE  ONLINE  rac1  ...
#   ora.RECO.dg             ONLINE  ONLINE  rac1  ...
#   ora.asm                 ONLINE  ONLINE  rac1  ...
#   ora.asm                 ONLINE  ONLINE  rac2  ...
#   ora.racflex-scan.vip    ONLINE  ONLINE  rac1  ...
#   ora.racflex-scan.vip    ONLINE  ONLINE  rac2  ...
#   ora.rac1.vip            ONLINE  ONLINE  rac1  ...
#   ora.rac2.vip            ONLINE  ONLINE  rac2  ...
#   ora.LISTENER_SCAN1.lsnr ONLINE  ONLINE  rac1  ...
#   ora.RACDB.db            ONLINE  ONLINE  rac1  ...
#   ora.RACDB.db            ONLINE  ONLINE  rac2  ...
\`\`\`

### 11.3 Voting Disk Verification

\`\`\`bash
# As root or grid user on rac1:
crsctl query css votedisk
# Expected — 3 voting disks, all ONLINE:
# ##  STATE    File Universal Id                    File Name Disk group
# --  -----    -----------------                    --------- ---------
#  1. ONLINE   xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx (/dev/sdb)  [GRID]
#  2. ONLINE   xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx (/dev/sdc)  [GRID]
#  3. ONLINE   xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx (/dev/sdd)  [GRID]
# Located 3 voting disk(s).
\`\`\`

### 11.4 SQL Verification Queries

Connect to the database:

\`\`\`bash
# As oracle user on rac1:
sqlplus / as sysdba
\`\`\`

\`\`\`sql
-- Verify both instances are open
SELECT inst_id, instance_name, host_name, status, database_status
FROM   gv\$instance
ORDER  BY inst_id;
-- Expected: 2 rows, both STATUS=OPEN, DATABASE_STATUS=ACTIVE

-- Verify RAC mode is enabled
SELECT name, value
FROM   v\$parameter
WHERE  name IN ('cluster_database', 'cluster_database_instances');
-- Expected:
-- cluster_database           TRUE
-- cluster_database_instances 2

-- Check interconnect details per instance
SELECT inst_id, name, ip_address
FROM   gv\$cluster_interconnects
ORDER  BY inst_id;
-- Expected: rows for rac1 showing 10.0.0.101, rows for rac2 showing 10.0.0.102

-- Verify undo tablespaces (one per instance is standard)
SELECT tablespace_name, contents, status
FROM   dba_tablespaces
WHERE  contents = 'UNDO'
ORDER  BY tablespace_name;
-- Expected: UNDOTBS1, UNDOTBS2 (one per instance)

-- Verify PDB is open
SELECT con_id, name, open_mode FROM v\$pdbs;
-- Expected: PDB1  READ WRITE
\`\`\`

### 11.5 Post-Install CVU Check

Run a final CVU check to confirm the entire cluster is healthy:

\`\`\`bash
# As grid user on rac1 — one-liner post-install check:
/u01/app/21.0.0/grid/runcluvfy.sh stage -post crsinst -n rac1,rac2,rac3,rac4 -verbose 2>&1 | tee /tmp/cvu_postcheck.log
grep -c "PASSED" /tmp/cvu_postcheck.log
grep -c "FAILED" /tmp/cvu_postcheck.log
# Goal: 0 FAILED items
\`\`\`

---

## Monitoring and Diagnostic Scripts

### Script 1: rac_flex_health_check.sh

\`\`\`bash
#!/usr/bin/env bash
# rac_flex_health_check.sh
# RAC Flex Cluster health check — runs as grid user on rac1
# Usage: ./rac_flex_health_check.sh
set -euo pipefail

ORACLE_HOME=\${ORACLE_HOME:-/u01/app/21.0.0/grid}
DB_NAME=\${DB_NAME:-RACDB}
PASS=0
FAIL=0
WARN=0

export PATH=\${ORACLE_HOME}/bin:\${PATH}

log_pass() { echo "  [PASS] \$1"; PASS=\$((PASS+1)); }
log_fail() { echo "  [FAIL] \$1"; FAIL=\$((FAIL+1)); }
log_warn() { echo "  [WARN] \$1"; WARN=\$((WARN+1)); }
section()  { echo ""; echo "=== \$1 ==="; }

# --- Node Count and Roles ---
section "Cluster Node Roles"
NODE_LIST=\$(olsnodes -t 2>/dev/null)
HUB_COUNT=\$(echo "\${NODE_LIST}" | grep -c "Hub"  || true)
LEAF_COUNT=\$(echo "\${NODE_LIST}" | grep -c "Leaf" || true)
TOTAL_NODES=\$(echo "\${NODE_LIST}" | wc -l)

echo "  Total nodes : \${TOTAL_NODES}"
echo "  Hub nodes   : \${HUB_COUNT}"
echo "  Leaf nodes  : \${LEAF_COUNT}"

if [[ "\${HUB_COUNT}" -ge 2 ]]; then
  log_pass "At least 2 Hub nodes present"
else
  log_fail "Fewer than 2 Hub nodes detected (found \${HUB_COUNT})"
fi

# --- CRS Resource State ---
section "CRS Resource States"
OFFLINE_COUNT=\$(crsctl stat res -t 2>/dev/null | grep -c "OFFLINE" || true)
ONLINE_COUNT=\$(crsctl stat res -t 2>/dev/null  | grep -c "ONLINE"  || true)

echo "  ONLINE  resources : \${ONLINE_COUNT}"
echo "  OFFLINE resources : \${OFFLINE_COUNT}"

if [[ "\${OFFLINE_COUNT}" -eq 0 ]]; then
  log_pass "All CRS resources are ONLINE"
else
  log_fail "\${OFFLINE_COUNT} CRS resource(s) are OFFLINE"
  crsctl stat res -t | grep "OFFLINE" | awk '{print "    -> " \$1}'
fi

# --- Voting Disk Count ---
section "Voting Disks"
VOTE_ONLINE=\$(crsctl query css votedisk 2>/dev/null | grep -c "ONLINE" || true)
echo "  Voting disks ONLINE: \${VOTE_ONLINE}"
if [[ "\${VOTE_ONLINE}" -ge 3 ]]; then
  log_pass "3 or more voting disks ONLINE"
elif [[ "\${VOTE_ONLINE}" -ge 1 ]]; then
  log_warn "\${VOTE_ONLINE} voting disk(s) ONLINE — quorum may be at risk if another fails"
else
  log_fail "No voting disks ONLINE — cluster is in crisis"
fi

# --- SCAN Listener Status ---
section "SCAN Listener"
SCAN_STATUS=\$(srvctl status scan_listener 2>/dev/null)
echo "  \${SCAN_STATUS}"
if echo "\${SCAN_STATUS}" | grep -q "is running"; then
  log_pass "SCAN listener(s) running"
else
  log_fail "SCAN listener not running"
fi

# --- Interconnect Latency (Hub nodes only) ---
section "Interconnect Latency (rac1 -> rac2-priv)"
if ping -c 5 -q rac2-priv &>/dev/null; then
  RTT_AVG=\$(ping -c 10 -q rac2-priv 2>/dev/null | awk -F'/' '/avg/ {print \$5}')
  echo "  Average RTT: \${RTT_AVG} ms"
  RTT_INT=\$(printf "%.0f" "\${RTT_AVG}" 2>/dev/null || echo "999")
  if [[ "\${RTT_INT}" -lt 2 ]]; then
    log_pass "Interconnect RTT < 2ms (\${RTT_AVG}ms)"
  elif [[ "\${RTT_INT}" -lt 5 ]]; then
    log_warn "Interconnect RTT is \${RTT_AVG}ms — acceptable but investigate if sustained"
  else
    log_fail "Interconnect RTT is \${RTT_AVG}ms — likely causing cache fusion performance issues"
  fi
else
  log_fail "Cannot ping rac2-priv — interconnect may be down"
fi

# --- Summary ---
echo ""
echo "========================================"
echo "  SUMMARY"
echo "    PASS : \${PASS}"
echo "    WARN : \${WARN}"
echo "    FAIL : \${FAIL}"
echo "========================================"
if [[ "\${FAIL}" -gt 0 ]]; then
  echo "  ACTION REQUIRED: \${FAIL} check(s) failed. Investigate immediately."
  exit 1
else
  echo "  Cluster health check complete. No failures detected."
  exit 0
fi
\`\`\`

### Script 2: rac_flex_instance_report.sql

\`\`\`sql
-- rac_flex_instance_report.sql
-- Run as sysdba on any node: sqlplus / as sysdba @rac_flex_instance_report.sql
-- Reports cluster-wide instance metrics from GV$ views

SET LINESIZE 180
SET PAGESIZE 100
SET TRIMSPOOL ON
SET FEEDBACK OFF
COLUMN instance_name    FORMAT A12
COLUMN host_name        FORMAT A10
COLUMN active_state     FORMAT A14
COLUMN ip_address       FORMAT A18
COLUMN stat_name        FORMAT A30
COLUMN value            FORMAT 999,999,999,999

PROMPT ============================================================
PROMPT  RAC Flex Cluster Instance Report
PROMPT  Generated: &&_DATE
PROMPT ============================================================

PROMPT
PROMPT --- 1. Instance State (GV\$INSTANCE) ---
SELECT
    inst_id,
    instance_name,
    host_name,
    status,
    active_state,
    database_status,
    TO_CHAR(startup_time, 'YYYY-MM-DD HH24:MI') AS startup_time
FROM gv\$instance
ORDER BY inst_id;

PROMPT
PROMPT --- 2. Interconnect Configuration (GV\$CLUSTER_INTERCONNECTS) ---
SELECT
    inst_id,
    name,
    ip_address,
    is_public,
    source
FROM gv\$cluster_interconnects
ORDER BY inst_id, name;

PROMPT
PROMPT --- 3. Key Performance Statistics per Instance (GV\$SYSSTAT) ---
SELECT
    s.inst_id,
    s.name                           AS stat_name,
    s.value
FROM gv\$sysstat s
WHERE s.name IN (
    'consistent gets',
    'db block gets',
    'physical reads',
    'redo size',
    'gc cr blocks received',
    'gc current blocks received',
    'gc cr block receive time',
    'gc current block receive time'
)
ORDER BY s.inst_id, s.name;

PROMPT
PROMPT --- 4. Cache Fusion Efficiency ---
SELECT
    inst_id,
    ROUND(
        (SUM(CASE WHEN name = 'gc cr blocks received'      THEN value ELSE 0 END) +
         SUM(CASE WHEN name = 'gc current blocks received' THEN value ELSE 0 END))
        /
        NULLIF(
          SUM(CASE WHEN name = 'consistent gets' THEN value ELSE 0 END) +
          SUM(CASE WHEN name = 'db block gets'   THEN value ELSE 0 END),
        0) * 100, 2
    )                                AS cache_fusion_pct
FROM gv\$sysstat
WHERE name IN ('gc cr blocks received', 'gc current blocks received',
               'consistent gets', 'db block gets')
GROUP BY inst_id
ORDER BY inst_id;

PROMPT
PROMPT --- 5. Wait Events Related to Interconnect (Top 10 by Total Wait Time) ---
SELECT * FROM (
    SELECT
        inst_id,
        event,
        total_waits,
        time_waited_micro / 1000000 AS time_waited_sec
    FROM gv\$system_event
    WHERE event LIKE 'gc%'
       OR event LIKE 'cache%'
    ORDER BY time_waited_micro DESC
) WHERE ROWNUM <= 10
ORDER BY inst_id, time_waited_sec DESC;
\`\`\`

### Script 3: gi_patch_level_check.sh

\`\`\`bash
#!/usr/bin/env bash
# gi_patch_level_check.sh
# Checks OPatch inventory on GI home and DB home across all Hub nodes
# Run as oracle user (must have SSH equivalence to rac1 and rac2)
# Usage: ./gi_patch_level_check.sh
set -euo pipefail

GI_HOME=\${GI_HOME:-/u01/app/21.0.0/grid}
DB_HOME=\${DB_HOME:-/u01/app/oracle/product/21.0.0/dbhome_1}
HUB_NODES=\${HUB_NODES:-"rac1 rac2"}
REPORT_FILE="/tmp/patch_level_report_\$(date '+%Y%m%d_%H%M%S').txt"

{
echo "======================================================"
echo "  Oracle 21c Patch Level Report"
echo "  Generated: \$(date)"
echo "======================================================"

for NODE in \${HUB_NODES}; do
  echo ""
  echo "------------------------------------------------------"
  echo "  Node: \${NODE}"
  echo "------------------------------------------------------"

  echo ""
  echo "  [Grid Infrastructure Home: \${GI_HOME}]"
  ssh -o BatchMode=yes "\${NODE}" "\${GI_HOME}/OPatch/opatch lsinventory -oh \${GI_HOME}" 2>&1 | \\
    grep -E "Oracle Home|Patch description|Unique Patch|Applied on|OPatch version|OUI version" | \\
    sed 's/^/    /'

  echo ""
  echo "  [Database Home: \${DB_HOME}]"
  ssh -o BatchMode=yes "\${NODE}" "\${DB_HOME}/OPatch/opatch lsinventory -oh \${DB_HOME}" 2>&1 | \\
    grep -E "Oracle Home|Patch description|Unique Patch|Applied on|OPatch version|OUI version" | \\
    sed 's/^/    /'
done

echo ""
echo "======================================================"
echo "  Patch Consistency Check"
echo "======================================================"

# Extract applied patch IDs from each node/home and compare
echo ""
echo "  GI Home patch IDs per node:"
for NODE in \${HUB_NODES}; do
  PATCHES=\$(ssh -o BatchMode=yes "\${NODE}" "\${GI_HOME}/OPatch/opatch lsinventory -oh \${GI_HOME}" 2>/dev/null | \\
    grep "Unique Patch ID" | awk '{print \$NF}' | sort | tr '\n' ' ')
  echo "    \${NODE}: \${PATCHES:-NONE}"
done

echo ""
echo "  DB Home patch IDs per node:"
for NODE in \${HUB_NODES}; do
  PATCHES=\$(ssh -o BatchMode=yes "\${NODE}" "\${DB_HOME}/OPatch/opatch lsinventory -oh \${DB_HOME}" 2>/dev/null | \\
    grep "Unique Patch ID" | awk '{print \$NF}' | sort | tr '\n' ' ')
  echo "    \${NODE}: \${PATCHES:-NONE}"
done

echo ""
echo "Report saved to: \${REPORT_FILE}"
} 2>&1 | tee "\${REPORT_FILE}"
\`\`\`

---

## Quick Reference

### Hub vs Leaf Node Capability Comparison

| Capability | Hub Node | Leaf Node |
|-----------|---------|----------|
| Runs Grid Infrastructure (CRS) | Yes | No |
| Runs ASM instance | Yes (local ASM) | No (connects to Hub ASM) |
| Runs database instances | Yes | Yes |
| Has a VIP address | Yes | No |
| Participates in voting | Yes | No |
| Stores OCR/voting data | Yes (Hub ASM) | No |
| Can become GI master | Yes | No |
| Leaf failover target | Yes (Leaf migrates to Hub) | Yes (to another Leaf or Hub) |

### Key Installation Binaries

| Binary | Location | Purpose |
|--------|---------|---------|
| \`gridSetup.sh\` | \`\${GI_HOME}/gridSetup.sh\` | GI installation and cluster configuration |
| \`runcluvfy.sh\` | \`\${GI_HOME}/runcluvfy.sh\` | Cluster Verification Utility |
| \`addnode.sh\` | \`\${GI_HOME}/addnode.sh\` | Add Leaf or Hub nodes post-install |
| \`asmca\` | \`\${GI_HOME}/bin/asmca\` | ASM Configuration Assistant |
| \`dbca\` | \`\${ORACLE_HOME}/bin/dbca\` | Database Configuration Assistant |
| \`runInstaller\` | \`\${ORACLE_HOME}/runInstaller\` | DB software installation |

### Directory Structure Reference

| Variable | Path | Owner |
|---------|------|-------|
| GI_HOME (GRID_HOME) | /u01/app/21.0.0/grid | grid:oinstall |
| ORACLE_BASE (grid) | /u01/app/grid | grid:oinstall |
| ORACLE_HOME (DB) | /u01/app/oracle/product/21.0.0/dbhome_1 | oracle:oinstall |
| ORACLE_BASE (oracle) | /u01/app/oracle | oracle:oinstall |
| oraInventory | /u01/app/oraInventory | grid:oinstall |
| CRS diagnostic logs | /u01/app/grid/crsdata/\${HOSTNAME}/crs | grid:oinstall |

### Root Script Execution Order

The sequence is mandatory. Never run root.sh on the next node until the previous node's root.sh has completed successfully.

\`\`\`
1. rac1 — /u01/app/oraInventory/orainstRoot.sh       (first install only)
2. rac1 — /u01/app/21.0.0/grid/root.sh               (GI Hub node 1)
3. rac2 — /u01/app/21.0.0/grid/root.sh               (GI Hub node 2 — wait 2 min after rac1)
4. rac3 — /u01/app/21.0.0/grid/root.sh               (GI Leaf node 1 — after addnode.sh)
5. rac4 — /u01/app/21.0.0/grid/root.sh               (GI Leaf node 2 — after addnode.sh)
6. rac1 — /u01/app/oracle/product/21.0.0/dbhome_1/root.sh  (DB home Hub node 1)
7. rac2 — /u01/app/oracle/product/21.0.0/dbhome_1/root.sh  (DB home Hub node 2)
\`\`\`

### Key srvctl Commands for RAC Flex

\`\`\`bash
# Database management
srvctl start   database -d RACDB
srvctl stop    database -d RACDB -o immediate
srvctl status  database -d RACDB
srvctl config  database -d RACDB

# Individual instance management
srvctl start  instance -d RACDB -i RACDB1
srvctl stop   instance -d RACDB -i RACDB2 -o abort
srvctl status instance -d RACDB -i RACDB1

# SCAN and listener management
srvctl status  scan
srvctl start   scan
srvctl stop    scan
srvctl status  scan_listener
srvctl start   scan_listener
srvctl stop    scan_listener

# Node application management (VIP, GSD, ONS per node)
srvctl status  nodeapps -n rac1
srvctl start   nodeapps -n rac1
srvctl stop    nodeapps -n rac1

# ASM management
srvctl status  asm
srvctl start   asm -n rac1
srvctl stop    asm -n rac2

# Full post-install CVU check (one-liner)
/u01/app/21.0.0/grid/runcluvfy.sh stage -post crsinst -n rac1,rac2,rac3,rac4 -verbose 2>&1 | grep -E "PASSED|FAILED|WARNING" | sort -u
\`\`\``,
};

async function main() {
  console.log('Inserting Oracle 21c RAC Flex Cluster runbook...');
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
