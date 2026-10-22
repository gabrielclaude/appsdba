import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle 19c and EBS 12.2.9 on RHEL 8 via VMware Workstation Pro on Windows 11',
  slug: 'oracle-19c-ebs-12-2-9-rhel8-vmware-workstation-pro-windows11-runbook',
  excerpt:
    'Step-by-step operational runbook for building a local Oracle Database 19c and E-Business Suite 12.2.9 development stack on Windows 11 using VMware Workstation Pro 17.x with two RHEL 8 VMs — covering VM creation, OS hardening, Oracle 19c silent install, DBCA database creation, EBS Rapid Install, inter-VM networking, and VMware snapshot strategy.',
  category: 'vmware' as const,
  isPremium: true,
  published: true,
  publishedAt: new Date('2026-10-19T09:00:00.000Z'),
  youtubeUrl: null,
  content: `By Riku Nakamura

## Problem Statement

This runbook addresses a common AppsDBA need: building a fully functional Oracle E-Business Suite development or training environment on a Windows 11 laptop or workstation without cloud infrastructure. The goal is a self-contained, offline-capable stack that replicates a minimal production topology — a dedicated Oracle Database 19c tier and a dedicated EBS 12.2.9 application tier — each on its own RHEL 8 VM, connected by a VMware host-only network that is isolated from corporate traffic.

Tech stack:

\`\`\`ini
OS Host:      Windows 11 Pro (22H2 or later, 64-bit)
Hypervisor:   VMware Workstation Pro 17.x
Guest OS:     Red Hat Enterprise Linux 8.8 or 8.9 (x86_64) — two VMs
Database:     Oracle Database 19c (19.3.0 base + latest Release Update)
Application:  Oracle E-Business Suite 12.2.9
\`\`\`

---

## Phase 0: Host Prerequisites

### Step 1: Verify Windows 11 Hardware Minimums

The combined RAM requirement for both VMs is 48 GB. The host must have at least 64 GB physical RAM to leave headroom for Windows, VMware, and a browser.

| Resource | Minimum | Recommended |
|---|---|---|
| RAM | 64 GB | 128 GB |
| CPU | 8-core / 16-thread (Intel 12th gen+ or AMD Zen 3+) | 12-core / 24-thread |
| Disk | 1 TB NVMe (single drive) | 2 TB NVMe or two drives |
| Windows edition | Windows 11 Pro | Windows 11 Pro or Enterprise |
| OS version | 22H2 | 23H2 or later |

Check free disk space before creating VMDKs. This installation requires approximately 650 GB of raw VMDK space for both VMs.

\`\`\`bash
# Run in Windows PowerShell (as Administrator)
Get-PSDrive -PSProvider FileSystem | Select-Object Name, Used, Free
\`\`\`

### Step 2: Disable Hyper-V and Windows Hypervisor Platform

VMware Workstation Pro 17.x can coexist with Hyper-V on Windows 11 via the Windows Hypervisor Platform (WHP), but this coexistence mode reduces nested virtualisation performance significantly. For an Oracle/EBS workload disable Hyper-V entirely for best results.

\`\`\`bash
# Run in an elevated PowerShell terminal
bcdedit /set hypervisorlaunchtype off
Disable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -NoRestart
Disable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -NoRestart
Disable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -NoRestart
\`\`\`

Reboot after running all three commands. Confirm Hyper-V is off:

\`\`\`bash
systeminfo | findstr /i "hyper-v"
# Expected: Hyper-V Requirements: A hypervisor has been detected...
# If Hyper-V is disabled, you will see: VM Monitor Mode Extensions: Yes
#                                        Virtualization Enabled In Firmware: Yes
#                                        Second Level Address Translation: Yes
#                                        Data Execution Prevention Available: Yes
# The key line to verify is that no Hyper-V services appear in:
Get-Service | Where-Object {$_.Name -like "hv*"} | Select-Object Status, Name
\`\`\`

### Step 3: Enable Virtualisation in UEFI/BIOS

Reboot into UEFI firmware and confirm:

- Intel VT-x (or AMD-V) is Enabled
- Intel VT-d (or AMD IOMMU) is Enabled (required for nested virtualisation pass-through)
- Hyper-Threading is Enabled

On Intel platforms the settings are typically under Advanced > CPU Configuration > Intel Virtualization Technology.

### Step 4: Install VMware Workstation Pro 17.x

Download VMware Workstation Pro 17.x from the Broadcom support portal. As of 2024, VMware Workstation Pro is free for personal use after Broadcom account registration.

\`\`\`bash
# After download, run installer as Administrator in PowerShell
Start-Process -FilePath "VMware-workstation-full-17.x.x-XXXXXXXX.exe" -ArgumentList "/s /v/qn" -Verb RunAs -Wait
\`\`\`

After install, open VMware Workstation Pro, go to Edit > Preferences > Memory and set the Reserved host RAM to at least 4096 MB to ensure VMware does not swap its own management overhead.

### Step 5: Create a Dedicated VMware Host-Only Network

Open Edit > Virtual Network Editor (run as Administrator). Create a new host-only network with a fixed subnet that will be used for DB-to-App communication.

\`\`\`ini
Network name:     VMnet10
Type:             Host-only
Subnet IP:        192.168.56.0
Subnet mask:      255.255.255.0
DHCP:             Disabled (static IPs will be set on each VM)
Connect host VM:  Enabled (allows Windows host to ping both VMs)
\`\`\`

---

## Phase 1: DB VM Creation

### Step 1: Create the DB VM in VMware Workstation Pro

In VMware Workstation Pro, select File > New Virtual Machine > Custom (Advanced).

\`\`\`ini
Hardware compatibility:    Workstation 17.x
Guest OS install:          Installer disc image file (ISO) — select RHEL 8.8 or 8.9 ISO
Guest OS type:             Linux
Linux version:             Red Hat Enterprise Linux 8 64-bit
VM name:                   oradb19c
vCPU:                      8
Cores per socket:          8 (single socket — keeps NUMA topology simple)
RAM:                       32768 MB (32 GB)
Network adapter:           Do not add network at this step (will add VMnet10 after)
I/O controller:            LSI Logic (default)
Virtual disk type:         SCSI
\`\`\`

### Step 2: Add Three VMDKs

Do NOT use the wizard's default single disk. After the wizard finishes, open VM Settings and add three virtual disks:

\`\`\`ini
Disk 1 (OS):         100 GB, SCSI, thin provisioned, single file
                     Store at: C:\VMware\oradb19c\os.vmdk
Disk 2 (OracleHome): 100 GB, SCSI, thin provisioned, single file
                     Store at: C:\VMware\oradb19c\orahome.vmdk
Disk 3 (Datafiles):  300 GB, SCSI, thin provisioned, single file
                     Store at: C:\VMware\oradb19c\datafiles.vmdk
\`\`\`

Thin provisioned is acceptable for a laptop development environment. For production-like I/O testing use thick (eager-zeroed) disks.

### Step 3: Add VMnet10 Network Adapter

In VM Settings > Add > Network Adapter. Set it to Custom: VMnet10 (Host-only). Remove any default NAT adapter if you want the VM to be completely isolated.

For internet access during initial OS setup (for subscription-manager registration), temporarily add a second NAT adapter and remove it after packages are installed.

### Step 4: Configure Advanced VM Settings

In VM Settings, also set:

\`\`\`ini
Processors > Virtualize Intel VT-x/EPT:  Enabled
Processors > Virtualize CPU performance counters: Enabled
Memory > Reserve all guest memory:        Enabled (prevents host OS swapping SGA pages)
Display > Accelerate 3D graphics:         Disabled (not needed, reduces overhead)
\`\`\`

---

## Phase 2: App VM Creation

### Step 1: Create the App VM

\`\`\`ini
Hardware compatibility:    Workstation 17.x
Guest OS install:          Same RHEL 8 ISO
Guest OS type:             Linux
Linux version:             Red Hat Enterprise Linux 8 64-bit
VM name:                   ebsapp1229
vCPU:                      4
Cores per socket:          4
RAM:                       16384 MB (16 GB)
Network adapter:           Custom: VMnet10
\`\`\`

### Step 2: Add Two VMDKs

\`\`\`ini
Disk 1 (OS):   100 GB, SCSI, thin provisioned, single file
               Store at: C:\VMware\ebsapp1229\os.vmdk
Disk 2 (EBS):  500 GB, SCSI, thin provisioned, single file
               Store at: C:\VMware\ebsapp1229\ebshome.vmdk
\`\`\`

### Step 3: Reserve App VM Memory

In VM Settings > Memory, enable Reserve all guest memory. EBS application tier JVM heap plus Oracle HTTP Server processes will consume the majority of 16 GB and must not be paged out.

---

## Phase 3: RHEL 8 OS Configuration on DB VM

Install RHEL 8 on oradb19c from the ISO. During the Anaconda installer, use the following LVM layout:

\`\`\`ini
/boot          1 GB   (standard partition, xfs)
/boot/efi      600 MB (EFI System Partition)
swap           32 GB  (equal to RAM — on Disk 1)
/              60 GB  (xfs, on Disk 1 — remaining space after swap)
\`\`\`

Disk 2 (/dev/sdb) and Disk 3 (/dev/sdc) are left unpartitioned at this stage — they will be formatted in Phase 4.

Select Server with GUI as the base environment during install. Register with Red Hat subscription-manager or configure a local repository mirror. Enable the BaseOS and AppStream repositories.

After first boot, perform all steps below as root unless noted.

### Step 1: Set Hostname and /etc/hosts

\`\`\`bash
hostnamectl set-hostname oradb19c.lab.local
\`\`\`

\`\`\`bash
cat >> /etc/hosts << 'EOF'
192.168.56.10  oradb19c.lab.local  oradb19c
192.168.56.20  ebsapp1229.lab.local  ebsapp1229
EOF
\`\`\`

Verify:

\`\`\`bash
hostname -f
# Must return: oradb19c.lab.local
\`\`\`

### Step 2: Configure Kernel Parameters

\`\`\`bash
cat > /etc/sysctl.d/97-oracle-19c.conf << 'EOF'
# Oracle 19c kernel parameters — RHEL 8
kernel.shmmax = 137438953472
kernel.shmall = 33554432
kernel.shmmni = 4096
kernel.sem = 250 32000 100 128
fs.file-max = 6815744
fs.aio-max-nr = 1048576
net.ipv4.ip_local_port_range = 9000 65500
net.core.rmem_default = 262144
net.core.rmem_max = 4194304
net.core.wmem_default = 262144
net.core.wmem_max = 1048576
vm.swappiness = 1
vm.dirty_ratio = 15
vm.dirty_background_ratio = 3
vm.nr_hugepages = 16384
EOF

sysctl --system
\`\`\`

### Step 3: Configure Security Limits

\`\`\`bash
cat > /etc/security/limits.d/97-oracle.conf << 'EOF'
oracle   soft   nofile     1024
oracle   hard   nofile     65536
oracle   soft   nproc      16384
oracle   hard   nproc      16384
oracle   soft   stack      10240
oracle   hard   stack      32768
oracle   soft   memlock    134217728
oracle   hard   memlock    134217728
oracle   soft   core       unlimited
oracle   hard   core       unlimited
EOF
\`\`\`

Ensure pam_limits is loaded for all sessions:

\`\`\`bash
grep -q "pam_limits" /etc/pam.d/login || echo "session required pam_limits.so" >> /etc/pam.d/login
\`\`\`

### Step 4: Install Required Packages

\`\`\`bash
dnf install -y \
  bc binutils compat-openssl10 elfutils-libelf glibc glibc-devel glibc.i686 \
  ksh libaio libaio-devel libaio.i686 libgcc libgcc.i686 \
  libstdc++ libstdc++-devel libstdc++.i686 \
  libX11 libXau libXi libXtst libXrender libXrender-devel \
  make gcc gcc-c++ sysstat unzip zip \
  net-tools smartmontools numactl numactl-devel numactl-libs \
  xorg-x11-xauth xorg-x11-utils xterm \
  libxcrypt-compat pam pam-devel \
  open-vm-tools
\`\`\`

Enable VMware tools service:

\`\`\`bash
systemctl enable --now vmtoolsd
\`\`\`

### Step 5: Disable Transparent Huge Pages

\`\`\`bash
cat > /etc/systemd/system/disable-thp.service << 'EOF'
[Unit]
Description=Disable Transparent Huge Pages for Oracle
After=sysinit.target local-fs.target
Before=oracle.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/enabled'
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/defrag'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now disable-thp
\`\`\`

### Step 6: Configure Swap

If the Anaconda installer created swap on Disk 1, verify it is active:

\`\`\`bash
swapon --show
free -h
# swap should show 32G
\`\`\`

If no swap was created:

\`\`\`bash
dd if=/dev/zero of=/swapfile bs=1G count=32
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile  none  swap  sw  0  0' >> /etc/fstab
\`\`\`

### Step 7: Disable SELinux and firewalld

\`\`\`bash
# Disable SELinux permanently
sed -i 's/^SELINUX=.*/SELINUX=disabled/' /etc/selinux/config

# Set to permissive for current session (avoids reboot requirement before Oracle install)
setenforce 0
getenforce
# Expected: Permissive

# Disable firewalld
systemctl disable --now firewalld
\`\`\`

### Step 8: Create Oracle Groups and User

\`\`\`bash
groupadd -g 54321 oinstall
groupadd -g 54322 dba
groupadd -g 54323 oper
groupadd -g 54324 backupdba
groupadd -g 54325 dgdba
groupadd -g 54326 kmdba
groupadd -g 54327 racdba

useradd -u 54321 \
        -g oinstall \
        -G dba,oper,backupdba,dgdba,kmdba,racdba \
        -d /home/oracle \
        -s /bin/bash \
        -c "Oracle Software Owner" \
        oracle

passwd oracle
# Set a password you will remember
\`\`\`

### Step 9: Create Directory Structure

\`\`\`bash
# Oracle Home on Disk 2 (/dev/sdb) — format and mount first
parted -s /dev/sdb mklabel gpt
parted -s /dev/sdb mkpart primary xfs 1MiB 100%
sleep 2
mkfs.xfs -f -L ORAHOME /dev/sdb1
mkdir -p /u01
echo "LABEL=ORAHOME  /u01  xfs  defaults,noatime  0  2" >> /etc/fstab
mount /u01

# Datafiles on Disk 3 (/dev/sdc)
parted -s /dev/sdc mklabel gpt
parted -s /dev/sdc mkpart primary xfs 1MiB 100%
sleep 2
mkfs.xfs -f -L ORADATA /dev/sdc1
mkdir -p /u02
echo "LABEL=ORADATA  /u02  xfs  defaults,noatime  0  2" >> /etc/fstab
mount /u02

# Create subdirectories
mkdir -p /u01/app/oracle/product/19.3.0/dbhome_1
mkdir -p /u01/app/oraInventory
mkdir -p /u02/oradata/EBSDB
mkdir -p /u02/fra/EBSDB
mkdir -p /u02/oradata/EBSDB/arch

chown -R oracle:oinstall /u01 /u02
chmod -R 755 /u01 /u02

df -h /u01 /u02
\`\`\`

### Step 10: Write Oracle Bash Profile

\`\`\`bash
cat > /home/oracle/.bash_profile << 'EOF'
# Oracle 19c environment — DB VM
export ORACLE_BASE=/u01/app/oracle
export ORACLE_HOME=/u01/app/oracle/product/19.3.0/dbhome_1
export ORACLE_SID=EBSDB
export ORACLE_UNQNAME=EBSDB
export NLS_DATE_FORMAT='YYYY-MM-DD HH24:MI:SS'
export NLS_LANG=AMERICAN_AMERICA.AL32UTF8
export PATH=$ORACLE_HOME/bin:$ORACLE_HOME/OPatch:$PATH
export LD_LIBRARY_PATH=$ORACLE_HOME/lib:/lib:/usr/lib
export CLASSPATH=$ORACLE_HOME/jlib:$ORACLE_HOME/rdbms/jlib
umask 022
EOF

chown oracle:oinstall /home/oracle/.bash_profile
\`\`\`

Reboot the DB VM to apply kernel parameter and SELinux changes:

\`\`\`bash
reboot
\`\`\`

---

## Phase 4: Oracle 19c Installation on DB VM

All steps in this phase run as the oracle user unless root is explicitly specified.

### Step 1: Stage Oracle 19c Media

Download LINUX.X64_193000_db_home.zip from Oracle Software Delivery Cloud (edelivery.oracle.com) to the Windows host, then copy to the DB VM using SCP or VMware shared folders.

\`\`\`bash
# As oracle — unzip directly into ORACLE_HOME
source ~/.bash_profile
unzip -q /tmp/LINUX.X64_193000_db_home.zip -d $ORACLE_HOME
ls $ORACLE_HOME/runInstaller
# Must return the runInstaller binary
\`\`\`

### Step 2: Install oracle-database-preinstall-19c RPM (optional but recommended)

If your RHEL subscription is active or you have access to an Oracle Linux mirror, install the pre-install RPM which sets most kernel and user parameters automatically. On a fully offline system, the manual steps in Phase 3 are sufficient.

\`\`\`bash
# As root
dnf install -y oracle-database-preinstall-19c
\`\`\`

### Step 3: Create the Silent Install Response File

\`\`\`bash
# As oracle
cat > /tmp/db_install.rsp << 'EOF'
oracle.install.responseFileVersion=/oracle/install/rspfmt_dbinstall_response_schema_v19.0.0
oracle.install.option=INSTALL_DB_SWONLY
UNIX_GROUP_NAME=oinstall
INVENTORY_LOCATION=/u01/app/oraInventory
ORACLE_HOME=/u01/app/oracle/product/19.3.0/dbhome_1
ORACLE_BASE=/u01/app/oracle
oracle.install.db.InstallEdition=EE
oracle.install.db.OSDBA_GROUP=dba
oracle.install.db.OSOPER_GROUP=oper
oracle.install.db.OSBACKUPDBA_GROUP=backupdba
oracle.install.db.OSDGDBA_GROUP=dgdba
oracle.install.db.OSKMDBA_GROUP=kmdba
oracle.install.db.OSRACDBA_GROUP=racdba
oracle.install.db.rootconfig.executeRootScript=false
EOF
\`\`\`

### Step 4: Run Oracle 19c Silent Installer

\`\`\`bash
# As oracle
source ~/.bash_profile
$ORACLE_HOME/runInstaller -silent -ignorePrereqFailure \
  -responseFile /tmp/db_install.rsp \
  -waitForCompletion
\`\`\`

The installer writes logs to /u01/app/oraInventory/logs/. When it completes, run the root scripts:

\`\`\`bash
# As root
/u01/app/oraInventory/orainstRoot.sh
/u01/app/oracle/product/19.3.0/dbhome_1/root.sh
\`\`\`

Verify installation:

\`\`\`bash
# As oracle
source ~/.bash_profile
sqlplus -version
# Must return: SQL*Plus: Release 19.0.0.0.0
\`\`\`

### Step 5: Apply Latest Release Update with OPatch

Download the latest Oracle 19c Release Update (for example, p37056648_190000_Linux-x86-64.zip) and OPatch 12.2.0.x (p6880880_190000_Linux-x86-64.zip) from My Oracle Support.

\`\`\`bash
# As oracle
source ~/.bash_profile

# Update OPatch
cd $ORACLE_HOME
unzip -o /tmp/p6880880_190000_Linux-x86-64.zip

# Verify OPatch version (must be 12.2.0.1.37 or later for 19c RU)
$ORACLE_HOME/OPatch/opatch version

# Stage the RU patch
mkdir -p /tmp/patches
unzip /tmp/p37056648_190000_Linux-x86-64.zip -d /tmp/patches/

# Apply patch (database must be down)
# Database is not yet created at this point — apply to software home directly
cd /tmp/patches/37056648
$ORACLE_HOME/OPatch/opatch apply -silent
\`\`\`

### Step 6: Configure the Oracle Listener

\`\`\`bash
# As oracle
source ~/.bash_profile

# Create listener.ora manually (netca in silent mode also works)
cat > $ORACLE_HOME/network/admin/listener.ora << 'EOF'
LISTENER =
  (DESCRIPTION_LIST =
    (DESCRIPTION =
      (ADDRESS = (PROTOCOL = TCP)(HOST = oradb19c.lab.local)(PORT = 1521))
    )
  )

SID_LIST_LISTENER =
  (SID_LIST =
    (SID_DESC =
      (GLOBAL_DBNAME = EBSDB)
      (ORACLE_HOME = /u01/app/oracle/product/19.3.0/dbhome_1)
      (SID_NAME = EBSDB)
    )
  )
EOF

lsnrctl start
lsnrctl status
\`\`\`

### Step 7: Create the Database with DBCA Silent Mode

\`\`\`bash
# As oracle
source ~/.bash_profile

dbca -silent \
  -createDatabase \
  -templateName General_Purpose.dbc \
  -gdbname EBSDB \
  -sid EBSDB \
  -sysPassword EBSDbChange_Me_1 \
  -systemPassword EBSDbChange_Me_1 \
  -createAsContainerDatabase false \
  -databaseType MULTIPURPOSE \
  -characterSet AL32UTF8 \
  -nationalCharacterSet AL16UTF16 \
  -datafileDestination /u02/oradata/EBSDB \
  -recoveryAreaDestination /u02/fra/EBSDB \
  -recoveryAreaSize 51200 \
  -redoLogFileSize 500 \
  -initParams "db_name=EBSDB,\
db_unique_name=EBSDB,\
db_block_size=8192,\
sga_target=16384M,\
pga_aggregate_target=4096M,\
processes=600,\
open_cursors=500,\
undo_management=AUTO,\
undo_tablespace=UNDOTBS1,\
enable_pluggable_database=false,\
use_large_pages=TRUE,\
lock_sga=TRUE,\
log_archive_dest_1='LOCATION=/u02/oradata/EBSDB/arch',\
db_recovery_file_dest=/u02/fra/EBSDB,\
db_recovery_file_dest_size=51200M" \
  -automaticMemoryManagement false \
  -totalMemory 0 \
  -databaseConfigType SINGLE \
  -listeners LISTENER \
  -enableArchive true
\`\`\`

### Step 8: Post-Install Database Checks

\`\`\`sql
-- As oracle, connect as sysdba
sqlplus / as sysdba

SELECT instance_name, host_name, version_full, status, database_status
FROM   v$instance;
-- Expected: status=OPEN, database_status=ACTIVE

SELECT name, log_mode, open_mode FROM v$database;
-- Expected: log_mode=ARCHIVELOG, open_mode=READ WRITE

SELECT name, value FROM v$parameter
WHERE  name IN ('db_block_size','character_set','nls_characterset',
                'sga_target','pga_aggregate_target','processes',
                'open_cursors','use_large_pages','lock_sga');

SELECT * FROM dba_tablespaces ORDER BY tablespace_name;

SHOW PARAMETER spfile;
-- Must point to $ORACLE_HOME/dbs/spfileEBSDB.ora or /u02/oradata/EBSDB/spfileEBSDB.ora
\`\`\`

### Step 9: Configure oratab and dbstart/dbshut Service

\`\`\`bash
# As root
echo "EBSDB:/u01/app/oracle/product/19.3.0/dbhome_1:Y" >> /etc/oratab

# Create a systemd unit for auto-start
cat > /etc/systemd/system/oracle-db.service << 'EOF'
[Unit]
Description=Oracle Database 19c EBSDB
After=network.target

[Service]
Type=forking
User=oracle
Group=oinstall
Environment=ORACLE_HOME=/u01/app/oracle/product/19.3.0/dbhome_1
Environment=ORACLE_SID=EBSDB
Environment=PATH=/u01/app/oracle/product/19.3.0/dbhome_1/bin:/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
ExecStart=/u01/app/oracle/product/19.3.0/dbhome_1/bin/dbstart /u01/app/oracle/product/19.3.0/dbhome_1
ExecStop=/u01/app/oracle/product/19.3.0/dbhome_1/bin/dbshut /u01/app/oracle/product/19.3.0/dbhome_1
TimeoutStartSec=900
TimeoutStopSec=900

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable oracle-db
\`\`\`

---

## Phase 5: RHEL 8 OS Configuration on App VM

Boot ebsapp1229 from the RHEL 8 ISO. Use the same Anaconda LVM layout as the DB VM but allocate both Disk 1 (OS) and configure Disk 2 (/dev/sdb) for the EBS mount point.

After first boot, perform the following as root.

### Step 1: Set Hostname and /etc/hosts

\`\`\`bash
hostnamectl set-hostname ebsapp1229.lab.local

cat >> /etc/hosts << 'EOF'
192.168.56.10  oradb19c.lab.local  oradb19c
192.168.56.20  ebsapp1229.lab.local  ebsapp1229
EOF
\`\`\`

### Step 2: Kernel Parameters for EBS App Tier

\`\`\`bash
cat > /etc/sysctl.d/97-ebs-app.conf << 'EOF'
kernel.shmmax = 68719476736
kernel.shmall = 16777216
kernel.shmmni = 4096
kernel.sem = 250 32000 100 128
fs.file-max = 6815744
fs.aio-max-nr = 1048576
net.ipv4.ip_local_port_range = 9000 65500
net.core.rmem_default = 262144
net.core.rmem_max = 4194304
net.core.wmem_default = 262144
net.core.wmem_max = 1048576
vm.swappiness = 1
EOF

sysctl --system
\`\`\`

### Step 3: Security Limits for EBS App Tier

\`\`\`bash
cat > /etc/security/limits.d/97-ebs-app.conf << 'EOF'
applmgr   soft   nofile     1024
applmgr   hard   nofile     65536
applmgr   soft   nproc      16384
applmgr   hard   nproc      16384
applmgr   soft   stack      10240
applmgr   hard   stack      32768
applmgr   soft   core       unlimited
applmgr   hard   core       unlimited
EOF
\`\`\`

### Step 4: Install EBS-Required Packages

EBS 12.2.9 requires several packages beyond the standard Oracle DB set, including 32-bit X11 libraries, glibc-2.28 compatibility, and the elfutils development packages used by EBS patching.

\`\`\`bash
dnf install -y \
  bc binutils compat-openssl10 elfutils elfutils-devel elfutils-libelf \
  elfutils-libelf-devel gcc gcc-c++ glibc glibc-devel glibc.i686 \
  glibc-devel.i686 ksh libaio libaio-devel libaio.i686 \
  libgcc libgcc.i686 libstdc++ libstdc++-devel libstdc++.i686 \
  libX11 libX11.i686 libXau libXi libXi.i686 libXtst libXtst.i686 \
  libXrender libXrender-devel libXrender.i686 \
  make net-tools nfs-utils numactl numactl-libs \
  openmotif openmotif-devel openmotif22 \
  pam pam-devel smartmontools sysstat \
  unixODBC unixODBC-devel unzip zip \
  xorg-x11-xauth xorg-x11-utils xterm \
  libxcrypt-compat \
  open-vm-tools \
  perl perl-Env perl-CPAN \
  redhat-lsb-core \
  dos2unix \
  hostname

systemctl enable --now vmtoolsd
\`\`\`

### Step 5: Disable SELinux and firewalld

\`\`\`bash
sed -i 's/^SELINUX=.*/SELINUX=disabled/' /etc/selinux/config
setenforce 0
systemctl disable --now firewalld
\`\`\`

### Step 6: Create EBS OS User and Groups

\`\`\`bash
groupadd -g 54330 oinstall
groupadd -g 54331 dba

useradd -u 54330 \
        -g oinstall \
        -G dba \
        -d /home/applmgr \
        -s /bin/bash \
        -c "EBS Application Manager" \
        applmgr

passwd applmgr
\`\`\`

### Step 7: Create EBS Directory Structure

\`\`\`bash
# Format and mount Disk 2 (/dev/sdb) for EBS
parted -s /dev/sdb mklabel gpt
parted -s /dev/sdb mkpart primary xfs 1MiB 100%
sleep 2
mkfs.xfs -f -L EBSHOME /dev/sdb1
mkdir -p /u01
echo "LABEL=EBSHOME  /u01  xfs  defaults,noatime  0  2" >> /etc/fstab
mount /u01

mkdir -p /u01/install/media/stage
mkdir -p /u01/app/ebsdb
mkdir -p /u01/app/applmgr

chown -R applmgr:oinstall /u01/install /u01/app
chmod -R 755 /u01

df -h /u01
\`\`\`

### Step 8: Write applmgr Bash Profile

\`\`\`bash
cat > /home/applmgr/.bash_profile << 'EOF'
# EBS 12.2.9 application tier
export EBS_BASE=/u01/app
export NLS_DATE_FORMAT='YYYY-MM-DD HH24:MI:SS'
export NLS_LANG=AMERICAN_AMERICA.AL32UTF8
export DISPLAY=:0.0
umask 022
EOF

chown applmgr:oinstall /home/applmgr/.bash_profile
\`\`\`

Reboot the App VM:

\`\`\`bash
reboot
\`\`\`

---

## Phase 6: EBS 12.2.9 Rapid Install

### Step 1: Stage EBS 12.2.9 Media

EBS 12.2.9 ships as a set of zip archives (approximately 70+ GB total). Download from Oracle Software Delivery Cloud and copy to the App VM. The media must be extracted into a stage directory before running Rapid Install.

\`\`\`bash
# As applmgr on ebsapp1229
mkdir -p /u01/install/media/stage
cd /u01/install/media

# Extract each zip file in order (the file names vary by download set)
# Example for a 3-zip download set:
unzip -q V1234567_1of3.zip -d /u01/install/media/stage/
unzip -q V1234567_2of3.zip -d /u01/install/media/stage/
unzip -q V1234567_3of3.zip -d /u01/install/media/stage/

# Verify the Disk1 startCD directory is present
ls /u01/install/media/stage/startCD/
# Expected: Disk1  adsetup.pl  rapidwiz  ...
\`\`\`

### Step 2: Verify Prerequisites Before Rapid Install

\`\`\`bash
# As applmgr
# Confirm hostname resolution
nslookup ebsapp1229.lab.local || grep ebsapp1229 /etc/hosts

# Confirm DB VM is reachable
ping -c 4 oradb19c.lab.local

# Confirm tnsping reaches the DB
# First, create a minimal tnsnames.ora on the App VM
mkdir -p /u01/app/ebsdb/network/admin
cat > /u01/app/ebsdb/network/admin/tnsnames.ora << 'EOF'
EBSDB =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = oradb19c.lab.local)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = EBSDB)
    )
  )
EOF

export TNS_ADMIN=/u01/app/ebsdb/network/admin
# tnsping requires the Oracle client — check if it is on the path
# (the EBS Rapid Install will lay down its own Oracle Home; tnsping is not required at this stage)
\`\`\`

Confirm the DB listener is up and accepting connections:

\`\`\`bash
# As oracle on oradb19c
lsnrctl status
# Must show SERVICE "EBSDB" ready
\`\`\`

### Step 3: Prepare the EBS Rapid Install Configuration File

The Rapid Install wizard (rapidwiz) can run in interactive mode (GUI) or silent mode using a configuration file. For repeatability, use the configuration file approach.

\`\`\`bash
# As applmgr on ebsapp1229
cat > /u01/install/media/ebs_install.conf << 'EOF'
# EBS 12.2.9 Rapid Install Configuration
# Two-node install: DB on oradb19c, Apps on ebsapp1229

[MANDATORY]
s_install_type=Install
s_db_type=FRESH
s_apps_base=/u01/app
s_appl_top=/u01/app/ebshome/apps/apps_st/appl
s_common_top=/u01/app/ebshome/apps/apps_st/comn
s_inst_top=/u01/app/ebshome/inst/apps/EBSDB_ebsapp1229
s_db_name=EBSDB
s_db_port=1521
s_db_host=oradb19c.lab.local
s_apps_version=12.2.9
s_apps_char_set=AL32UTF8
s_base_lang=US
s_primary_lang=American English
s_apps_passwd=apps
s_webport=8000
s_jserv_port=8100
s_jserv_ajp13_port=8009
s_forms_port=9000
s_ohs_ssl_port=4443
s_jvm_start_heap_size=256
s_jvm_max_heap_size=1024
EOF
\`\`\`

### Step 4: Run Rapid Install

For an interactive install with full control, run rapidwiz with the GUI. Since the App VM uses Server with GUI, you can run it directly from the VM console or via X forwarding to a Windows X server (VcXsrv or Xming).

\`\`\`bash
# As applmgr on ebsapp1229
cd /u01/install/media/stage/startCD/Disk1/rapidwiz
export DISPLAY=:0.0
# If running via X forwarding from Windows:
# export DISPLAY=<windows-host-ip>:0.0

chmod +x rapidwiz
./rapidwiz
\`\`\`

In the Rapid Install wizard, choose the following options:

\`\`\`ini
Install Type:         Install EBS
Database Install:     Create Vision Demo or Fresh DB (choose Fresh if not using Vision)
Server Pairing:       Two-Node (DB server: oradb19c.lab.local, Apps server: ebsapp1229.lab.local)
EBS SID:              EBSDB
Apps password:        (set per security policy)
Base directory:       /u01/app
\`\`\`

Rapid Install takes 3 to 6 hours depending on disk speed. Monitor progress in:

\`\`\`bash
tail -f /u01/app/ebshome/inst/apps/EBSDB_ebsapp1229/logs/appl/install/make*.log
\`\`\`

### Step 5: Post-Install Rapid Install Validation

After the wizard completes, source the EBS environment and run the standard validation:

\`\`\`bash
# As applmgr on ebsapp1229
source /u01/app/ebshome/apps/apps_st/appl/APPSEBSDB_ebsapp1229.env

# Check autoconfig context file
ls $CONTEXT_FILE
# Expected: /u01/app/ebshome/inst/apps/EBSDB_ebsapp1229/appl/admin/EBSDB_ebsapp1229.xml

# Start all EBS services
$ADMIN_SCRIPTS_HOME/adstrtal.sh apps/apps_password
\`\`\`

Run the post-install AD Administration sanity check:

\`\`\`bash
# As applmgr
$ADMIN_SCRIPTS_HOME/adadmin.sh
# Choose menu option: Maintain Applications Files > Check APPL_TOP Integrity
\`\`\`

Verify the EBS login page is accessible:

\`\`\`bash
# From the Windows host browser
# http://192.168.56.20:8000/OA_HTML/AppsLogin
# Default credentials: sysadmin / sysadmin
\`\`\`

Check the concurrent manager status:

\`\`\`sql
-- As apps user
SELECT concurrent_queue_name, running_processes, max_processes, worker_count
FROM   apps.fnd_concurrent_queues_vl
WHERE  enabled_flag = 'Y'
ORDER BY concurrent_queue_name;
\`\`\`

### Step 6: Run AutoConfig on Both Tiers

After the Rapid Install completes, always run AutoConfig to regenerate configuration files with the final runtime context values:

\`\`\`bash
# On DB tier (oradb19c) as oracle
source /u01/app/oracle/product/19.3.0/dbhome_1/appsutil/bin/addbctl.sh
$ORACLE_HOME/appsutil/scripts/EBSDB/adautocfg.sh apps/apps_password

# On App tier (ebsapp1229) as applmgr
source /u01/app/ebshome/apps/apps_st/appl/APPSEBSDB_ebsapp1229.env
$ADMIN_SCRIPTS_HOME/adautocfg.sh apps/apps_password
\`\`\`

---

## Phase 7: Inter-VM Connectivity and Snapshot Strategy

### Step 1: Set Static IPs on Both VMs

On oradb19c (DB VM):

\`\`\`bash
# As root on oradb19c
# Identify the VMnet10 interface name
nmcli device status
# Typically ens33 or ens192 for VMware

nmcli con mod ens33 ipv4.method manual \
  ipv4.addresses 192.168.56.10/24 \
  ipv4.dns 192.168.56.1 \
  connection.autoconnect yes

nmcli con up ens33
ip addr show ens33
# Must show 192.168.56.10/24
\`\`\`

On ebsapp1229 (App VM):

\`\`\`bash
# As root on ebsapp1229
nmcli con mod ens33 ipv4.method manual \
  ipv4.addresses 192.168.56.20/24 \
  ipv4.dns 192.168.56.1 \
  connection.autoconnect yes

nmcli con up ens33
ip addr show ens33
# Must show 192.168.56.20/24
\`\`\`

### Step 2: Verify /etc/hosts on Both VMs

Confirm both VMs have identical /etc/hosts entries:

\`\`\`bash
grep -E "56\.10|56\.20" /etc/hosts
# Expected on both VMs:
# 192.168.56.10  oradb19c.lab.local  oradb19c
# 192.168.56.20  ebsapp1229.lab.local  ebsapp1229
\`\`\`

### Step 3: Verify Database Connectivity from App VM

\`\`\`bash
# As applmgr on ebsapp1229
# Use the EBS-installed sqlplus if available, or a standalone Oracle client
source /u01/app/ebshome/apps/apps_st/appl/APPSEBSDB_ebsapp1229.env

tnsping EBSDB
# Expected: OK (N msec)

sqlplus system/EBSDbChange_Me_1@EBSDB << 'EOF'
SELECT instance_name, host_name, status FROM v$instance;
EXIT;
EOF
\`\`\`

### Step 4: Verify EBS Concurrent Manager Connectivity

\`\`\`bash
# As applmgr on ebsapp1229
source /u01/app/ebshome/apps/apps_st/appl/APPSEBSDB_ebsapp1229.env

# Check concurrent manager process status
ps -ef | grep FNDLIBR | grep -v grep
# Should show at least one ICM (Internal Concurrent Manager) process

# Check listener connectivity from apps layer
$ORACLE_HOME/bin/tnsping EBSDB
\`\`\`

### Step 5: VMware Snapshot Strategy

Take VMware snapshots at each major milestone. Snapshots allow instant rollback without reinstalling.

Snapshot naming convention:

\`\`\`ini
Format:   <VM>-<phase>-<description>-<YYYYMMDD>
Examples:
  oradb19c-P4-oracle19c-sw-only-installed-20261019
  oradb19c-P4-EBSDB-created-archivelog-20261019
  ebsapp1229-P5-rhel8-os-hardened-20261019
  ebsapp1229-P6-ebs1229-rapidinstall-complete-20261019
  oradb19c-P7-postinstall-validated-20261019
  ebsapp1229-P7-postinstall-validated-20261019
\`\`\`

To take a snapshot from Windows PowerShell using VMware's vmrun utility:

\`\`\`bash
# Windows PowerShell — adjust vmx path to match your VM location
$vmrun = "C:\Program Files (x86)\VMware\VMware Workstation\vmrun.exe"

& $vmrun snapshot "C:\VMware\oradb19c\oradb19c.vmx" "oradb19c-P4-EBSDB-created-archivelog-20261019"
& $vmrun snapshot "C:\VMware\ebsapp1229\ebsapp1229.vmx" "ebsapp1229-P6-ebs1229-rapidinstall-complete-20261019"
\`\`\`

Rules for safe snapshots:

\`\`\`ini
Rule 1: Shut down Oracle databases and EBS services before taking a snapshot.
        Snapshots of a running Oracle instance are crash-consistent, not clean-consistent.
Rule 2: Never run on a snapshot for more than 48 hours — snapshot chains grow the delta VMDK
        and degrade I/O performance significantly.
Rule 3: After restoring a snapshot, run AutoConfig on both tiers before starting EBS services.
Rule 4: Use "Delete All Snapshots" periodically to collapse the chain and reclaim disk space.
\`\`\`

Shutdown sequence before snapshot:

\`\`\`bash
# On ebsapp1229 as applmgr
$ADMIN_SCRIPTS_HOME/adstpall.sh apps/apps_password

# On oradb19c as oracle
sqlplus / as sysdba << 'EOF'
SHUTDOWN IMMEDIATE;
EOF
lsnrctl stop
\`\`\`

Startup sequence after restore from snapshot:

\`\`\`bash
# On oradb19c as oracle
lsnrctl start
sqlplus / as sysdba << 'EOF'
STARTUP;
EOF

# On ebsapp1229 as applmgr
$ADMIN_SCRIPTS_HOME/adstrtal.sh apps/apps_password
\`\`\`

---

## Summary

This runbook installs a two-VM Oracle 19c and EBS 12.2.9 development stack on Windows 11 via VMware Workstation Pro 17.x using the following topology:

| Component | VM | IP | Key Paths |
|---|---|---|---|
| Oracle 19c 19.3+ RU | oradb19c | 192.168.56.10 | ORACLE_HOME=/u01/app/oracle/product/19.3.0/dbhome_1 |
| Oracle Database EBSDB | oradb19c | 192.168.56.10 | Data: /u02/oradata/EBSDB |
| EBS 12.2.9 App Tier | ebsapp1229 | 192.168.56.20 | /u01/app/ebshome |
| VMware Network | VMnet10 host-only | 192.168.56.0/24 | Edit > Virtual Network Editor |

Key operational notes:

- Always shut down Oracle and EBS before taking VMware snapshots
- Reboot both VMs after OS configuration changes to apply kernel parameters and SELinux changes
- Run AutoConfig after restoring a VMware snapshot
- Thin-provisioned VMDKs are acceptable for development; use thick eager-zeroed for I/O benchmarking
- Reserve 100% of VM memory in VMware settings to prevent balloon driver interaction with Oracle SGA

---

## References

- [Oracle Database 19c Installation Guide for Linux (docs.oracle.com)](https://docs.oracle.com/en/database/oracle/oracle-database/19/ladbi/index.html)
- [Oracle E-Business Suite Installation Guide Release 12.2 (docs.oracle.com)](https://docs.oracle.com/cd/E26401_01/doc.122/e22950/toc.htm)
- [Oracle E-Business Suite Release Notes 12.2.9 (My Oracle Support Doc ID 2494027.1)](https://support.oracle.com/epmos/faces/DocContentDisplay?id=2494027.1)
- [Oracle Support for VMware (MOS Note 249212.1)](https://support.oracle.com/epmos/faces/DocContentDisplay?id=249212.1)
- [Oracle 19c Pre-Installation Requirements RHEL 8 (docs.oracle.com)](https://docs.oracle.com/en/database/oracle/oracle-database/19/ladbi/automatically-configuring-oracle-linux-with-oracle-preinstallation-rpm.html)
- [VMware Workstation Pro Download (Broadcom Support Portal)](https://support.broadcom.com/group/ecx/productdownloads?subfamily=VMware+Workstation+Pro)
- [Red Hat Enterprise Linux 8 Installation Guide (access.redhat.com)](https://access.redhat.com/documentation/en-us/red_hat_enterprise_linux/8/html/performing_a_standard_rhel_8_installation/index)
- [Oracle OPatch User Guide 19c (docs.oracle.com)](https://docs.oracle.com/en/database/oracle/oracle-database/19/optch/index.html)`,
};

async function main() {
  console.log('Inserting Oracle 19c + EBS 12.2.9 VMware Workstation runbook...');
  await db
    .insert(posts)
    .values(post)
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
  console.log('Inserted:', post.slug);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
