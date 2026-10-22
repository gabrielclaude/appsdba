By Riku Nakamura

Why do so many Oracle installations fail before the first CREATE USER statement is even issued?

## Why VMware Workstation Pro for Oracle Development and Training

The answer is environment inconsistency. Oracle Database 19c and Oracle E-Business Suite 12.2.9 are not software you install on a laptop and call it done. They require specific kernel parameters, specific filesystem layouts, specific operating system versions, and — in the case of EBS — a network topology that a single-node bare-metal install on Windows 11 simply cannot replicate cleanly. VMware Workstation Pro solves this problem by giving you full, isolated Linux virtual machines that behave exactly like production servers, running on commodity Windows hardware.

The reasons to choose VMware Workstation Pro over other virtualization options are concrete. Workstation Pro supports nested virtualization, meaning you can run Oracle Grid Infrastructure inside a VM and later graduate to a two-node RAC lab without buying a second machine. It supports snapshot trees with named branches — a capability that is indispensable for EBS work where a botched adop patch cycle can leave the environment in an unrecoverable state, and you need to roll back to a pre-patch checkpoint in under sixty seconds. It ships with vmnet tools that provide stable host-only and NAT networking without requiring bridge mode, which causes MAC address conflicts on managed enterprise wireless networks. And it runs on Windows 11 Pro and Home, which is the operating system most DBAs and system administrators actually have on their workstations in 2026.

VirtualBox is free, but its performance on large Oracle datafiles is measurably worse due to the way it handles large-sector VMDK I/O, and its snapshot implementation does not match Workstation Pro for a multi-VM topology. Hyper-V on Windows 11 Home is not available, and on Pro it conflicts with VMware Workstation until you enable the WHPX backend, which reduces VM performance. For serious Oracle lab work, Workstation Pro is the correct tool.

## Host Hardware Requirements for Windows 11

Do not install Oracle 19c and EBS 12.2.9 on a host with less than 32 GB of RAM. This is not a recommendation — it is a floor. The EBS application tier alone requires 16 GB allocated to the VM to avoid constant swapping inside the guest, and the Oracle Database VM needs at minimum 8 GB with a realistic target of 12 GB for a development instance holding EBS Vision data. Add Windows 11 overhead of 4–6 GB and you arrive at 28 GB consumed at idle. A 32 GB host leaves almost no headroom; 64 GB is comfortable.

CPU requirements are less stringent than memory. A modern Intel Core i7 or i9 with 8 physical cores is sufficient. EBS installation via Rapid Install is single-threaded for large portions of the process, so clock speed matters more than core count during initial setup. AMD Ryzen 7000 and 9000 series work equally well. Enable AMD-V or Intel VT-x in the BIOS before launching VMware Workstation for the first time — if virtualization extensions are disabled, VMware will either refuse to power on the VM or run it in a degraded software emulation mode that makes Oracle installation prohibitively slow.

Storage is the third critical dimension. Oracle 19c with EBS Vision data will consume approximately 250 GB across datafiles, redo logs, archive logs, and the Oracle Home. The EBS application tier requires an additional 120 GB. Provision all VM disks on an NVMe SSD. A SATA SSD is acceptable but will extend database startup time and the adop patch cycle significantly. A spinning HDD is not acceptable — the combination of random I/O from Oracle datafile access and the I/O overhead of VMware's virtual disk layer makes HDD performance in an Oracle VM effectively unusable.

## VM Sizing: Oracle Database 19c

The Oracle Database VM runs RHEL 8 and hosts the 19c database software and the EBS database instance.

Allocate 4 vCPUs. Oracle's background processes are not heavily parallel on a development instance, but the installer and DBCA both briefly spike CPU during tablespace creation and dictionary building. 4 vCPUs prevents those spikes from stalling the installation.

Memory allocation depends on host RAM. On a 64 GB host, allocate 16 GB to the database VM. On a 32 GB host, allocate 10 GB and accept that performance will be slower. The SGA and PGA targets inside Oracle should be tuned to fit — a common starting point is SGA_TARGET = 6G and PGA_AGGREGATE_TARGET = 2G on a 10 GB VM.

For disk, use two separate virtual disks. The first disk is 80 GB for the operating system, Oracle Home, and Oracle Inventory. The second disk is 250 GB for Oracle datafiles, redo logs, archive logs, and the Fast Recovery Area. Separating these lets you snapshot the OS disk independently of the data disk, which matters when you want to preserve a clean Oracle software installation without snapshotting 250 GB of datafiles every time.

Use thick provisioned eager zeroed format for the datafile disk. Thin provisioning does not consume host space until the guest writes data, but it causes write amplification as VMware allocates new blocks during the initial database load. For a disk that will hold 150–200 GB of EBS data, eager zeroed thick provisioning writes zeros to the entire virtual disk at creation time — a one-time cost that eliminates allocation overhead during all subsequent writes. The OS disk can remain thin provisioned.

## VM Sizing: EBS 12.2.9 Application Tier

EBS 12.2.9 can be deployed in a single-node configuration (database and application tier on the same VM) or in a split configuration (separate VMs sharing a host-only network). For a development and training environment, the single-node configuration simplifies setup at the cost of requiring more RAM. The split configuration is more realistic and is recommended if your host has 64 GB or more.

For a split application tier VM: the EBS tier runs WebLogic Server, the Forms and Reports servers, the HTTP Server, and the Concurrent Processing tier. Collectively these Java processes consume 12–14 GB of RAM at steady state. Allocate 16 GB to give the OS and additional services headroom. Allocate 4 vCPUs. The application tier is not CPU-bound in normal operation, but EBS startup — launching multiple managed server JVMs — stresses the CPU briefly and benefits from parallel startup across cores.

A single 150 GB virtual disk is sufficient for the application tier. The EBS application file system is large but not growing rapidly during normal development use. Thin provisioning is acceptable here.

For a single-node combined installation, add the two specifications together: at least 24 GB of RAM, 8 vCPUs, and 400 GB of disk split across the two-disk layout described for the database VM.

## RHEL 8 VM Setup in VMware Workstation Pro

Download the RHEL 8 ISO from Red Hat's developer program, which provides a free individual developer subscription fully functional for development use. Target RHEL 8.6 or later. RHEL 8.4 has known incompatibilities with some Oracle 19c installer dependencies that require additional package workarounds.

When creating the VM in Workstation Pro, select "I will install the operating system later" rather than using Easy Install. Easy Install automates partition layout in a way that does not match Oracle's requirements. After creating the VM hardware configuration, boot from the RHEL ISO.

During RHEL 8 installation, choose "Server with GUI" for graphical Oracle installer access from the VM console, or "Minimal Install" if you plan to run the installer via X11 forwarding from your Windows host using VcXsrv or MobaXterm. For partitioning, use custom layout on the 80 GB OS disk:

```
/boot       1 GB   (xfs)
/boot/efi   512 MB (vfat, EFI systems only)
swap        16 GB  (equal to VM RAM)
/           remaining (xfs)
```

After OS installation, register with Red Hat:

```bash
subscription-manager register --username <rhn_user> --password <rhn_password>
subscription-manager attach --auto
```

The 250 GB data disk is formatted and mounted after OS installation as a separate step.

## VMware Networking: NAT vs Host-Only

VMware Workstation Pro provides three networking modes relevant to this setup.

NAT connects the VM to your Windows host's internet connection through VMware's built-in NAT service. Assign NAT to one network adapter on each VM. This adapter is used for internet access — downloading Oracle packages, Red Hat subscription updates, and external resources. Its IP is assigned by VMware's DHCP and will change between VM reboots unless you configure a static IP.

Host-only networking creates a private network segment between your Windows host and all VMs assigned to that segment. Assign a host-only adapter to both the database VM and the application tier VM. This adapter carries all EBS inter-VM communication — the application tier connects to the Oracle database listener on this adapter's IP. Set static IPs on both VMs for the host-only adapter before running the EBS installer. VMware creates the host-only network as vmnet1 by default with the 192.168.10.0/24 subnet.

Configure static IPs and hostnames before running the EBS installer. The Rapid Install wizard asks for the database hostname and embeds it into tnsnames.ora and the EBS configuration files. If you use DHCP and the IP changes after installation, EBS will fail to connect to the database.

Assign:

```
192.168.10.10   ebsdb.lab.local   ebsdb    (DB VM)
192.168.10.11   ebsapp.lab.local  ebsapp   (App VM)
```

Add both entries to /etc/hosts on each VM and set hostnames with hostnamectl before any Oracle installation begins.

## RHEL 8 Prerequisites for Oracle 19c

Oracle 19c has a documented set of RHEL 8 prerequisites. The key areas are package installation, kernel parameters, user limits, and the oracle OS user and group structure.

Install required packages:

```bash
dnf install -y \
  binutils compat-openssl10 elfutils-libelf elfutils-libelf-devel \
  fontconfig-devel glibc glibc-devel ksh libaio libaio-devel \
  libXrender libXrender-devel libX11 libXau libXi libXtst \
  libgcc libstdc++ libstdc++-devel libxcb make net-tools nfs-utils \
  python3 smartmontools sysstat unzip libnsl libnsl2
```

Kernel parameters in /etc/sysctl.conf:

```bash
fs.aio-max-nr = 1048576
fs.file-max = 6815744
kernel.shmall = 2097152
kernel.shmmax = 4294967296
kernel.shmmni = 4096
kernel.sem = 250 32000 100 128
net.ipv4.ip_local_port_range = 9000 65500
net.core.rmem_default = 262144
net.core.rmem_max = 4194304
net.core.wmem_default = 262144
net.core.wmem_max = 1048576
```

User limits in /etc/security/limits.conf:

```bash
oracle   soft   nofile    1024
oracle   hard   nofile    65536
oracle   soft   nproc     2047
oracle   hard   nproc     16384
oracle   soft   stack     10240
oracle   hard   stack     32768
oracle   soft   memlock   unlimited
oracle   hard   memlock   unlimited
```

Create the oracle OS user and groups, then create the directory structure:

```bash
groupadd -g 1001 oinstall
groupadd -g 1002 dba
useradd -u 1001 -g oinstall -G dba -m oracle

mkdir -p /u01/app/oracle/product/19.3.0/dbhome_1
mkdir -p /u01/app/oraInventory
mkdir -p /u02/oradata
chown -R oracle:oinstall /u01 /u02
chmod 755 /u02
```

Mount the 250 GB data disk to /u02/oradata using /etc/fstab after formatting it with XFS. Disable SELinux (set SELINUX=disabled in /etc/selinux/config and reboot) and stop firewalld or add port 1521 before running the installer.

## Oracle 19c Installation Overview

Oracle 19c for Linux is distributed as a single ZIP file (LINUX.X64_193000_db_home.zip) from Oracle's software delivery cloud. The zip unpacks directly into the Oracle Home directory — unlike older versions, there is no separate installer location.

Set the oracle environment in .bash_profile:

```bash
export ORACLE_BASE=/u01/app/oracle
export ORACLE_HOME=/u01/app/oracle/product/19.3.0/dbhome_1
export ORACLE_SID=EBSDB
export PATH=$ORACLE_HOME/bin:$PATH
export LD_LIBRARY_PATH=$ORACLE_HOME/lib:/lib:/usr/lib
```

Unzip directly into the Oracle Home, then run the installer. For a software-only install (recommended before DBCA):

```bash
./runInstaller -silent \
  oracle.install.option=INSTALL_DB_SWONLY \
  ORACLE_HOSTNAME=ebsdb.lab.local \
  INVENTORY_LOCATION=/u01/app/oraInventory \
  ORACLE_HOME=/u01/app/oracle/product/19.3.0/dbhome_1 \
  ORACLE_BASE=/u01/app/oracle \
  oracle.install.db.InstallEdition=EE \
  oracle.install.db.OSDBA_GROUP=dba \
  SECURITY_UPDATES_VIA_MYORACLESUPPORT=false \
  DECLINE_SECURITY_UPDATES=true
```

After the install completes, run /u01/app/oraInventory/orainstRoot.sh and /u01/app/oracle/product/19.3.0/dbhome_1/root.sh as root. Then create the database with DBCA. For EBS 12.2.9, the database must be a non-CDB — EBS 12.2.x does not support the pluggable database architecture. Specify character set AL32UTF8 and national character set AL16UTF16.

## EBS 12.2.9 Installation Overview: Rapid Install

Oracle E-Business Suite 12.2.9 is installed using the Rapid Install wizard, distributed as staged files (70–90 GB compressed) from Oracle Software Delivery Cloud. Rapid Install performs both database tier configuration and application tier software installation — either in a single run for single-node mode, or two separate runs for split mode.

Before launching Rapid Install, confirm the Oracle Database listener is running and the EBSDB database is open and accessible from both VMs. Rapid Install connects to the database during installation.

Key parameters to prepare: apps schema password, system database password, base install directory (recommend /u01/oracle/VIS for Vision demo data), EBS hostname matching the host-only network hostname, and database host/port/SID.

Launch the wizard from the extracted stage directory:

```bash
cd /u01/install/APPS122
perl rapidwiz
```

The wizard requires a graphical display (local or X11 forwarding). It validates prerequisites, prompts for configuration values, and runs for several hours. A typical EBS 12.2.9 installation with Vision demo data takes 4–6 hours on NVMe storage. After installation, apply the latest AD-TXK technology codelevel patches and run autoconfig on both tiers.

## Snapshot Strategy for Checkpointing

VMware Workstation Pro's snapshot manager is the most valuable operational tool in this entire setup. Use it systematically at every major milestone.

**Snapshot 1 — Clean OS**: immediately after RHEL 8 installation, subscription registration, and network connectivity confirmed. Recovery point if kernel parameter configuration makes the OS unbootable.

**Snapshot 2 — Oracle 19c software installed, no database**: after the Oracle installer and root scripts, before DBCA. If DBCA fails partway through database creation, revert here and rerun cleanly.

**Snapshot 3 — Empty database created**: after DBCA completes and the database opens cleanly. Last clean state before EBS Rapid Install writes anything to the database.

**Snapshot 4 — EBS installed, pre-startup**: after Rapid Install completes but before the first EBS startup. If the initial startup fails with a configuration error, fix and retry without rerunning the 4–6 hour installer.

**Snapshot 5 — EBS clean running state**: after the first successful EBS login from the Windows host browser. This is your golden baseline. Branch from this snapshot rather than overwriting it.

Take snapshots of both VMs in coordinated pairs whenever you have cross-VM state dependencies — a snapshot of the application VM that references a database state it cannot reconnect to is useless. For ongoing work, create named branch snapshots before applying any patch or making significant configuration changes.

## Summary

VMware Workstation Pro on a 64 GB Windows 11 host with NVMe storage provides a sound platform for Oracle 19c and EBS 12.2.9 development and training environments. The critical success factors are: correct VM memory allocation (16 GB for the database VM, 16 GB for the application tier), thick provisioned eager zeroed virtual disks for Oracle datafiles, static IPs on the host-only network segment for inter-VM EBS communication, the full RHEL 8 kernel parameter and ulimit configuration before any Oracle installer, and a disciplined snapshot strategy at every installation milestone. Without checkpoints at each major milestone, a single failure late in a 6-hour installation requires starting from scratch.

## References

- [Oracle Database 19c Installation Guide for Linux](https://docs.oracle.com/en/database/oracle/oracle-database/19/ladbi/index.html)
- [Oracle E-Business Suite 12.2 Installation Guide](https://docs.oracle.com/cd/E26401_01/doc.1220/e22950/toc.htm)
- [Oracle E-Business Suite Release Notes 12.2.9](https://support.oracle.com/epmos/faces/DocumentDisplay?id=2456758.1)
- [Red Hat Enterprise Linux 8 Installation Guide](https://access.redhat.com/documentation/en-us/red_hat_enterprise_linux/8/html/performing_a_standard_rhel_8_installation/index)
- [VMware Workstation Pro Documentation](https://docs.vmware.com/en/VMware-Workstation-Pro/index.html)
- [Oracle Preinstallation RPM for Oracle Linux](https://docs.oracle.com/en/database/oracle/oracle-database/19/ladbi/automatically-configuring-oracle-linux-with-oracle-preinstallation-rpm.html)
- [EBS 12.2 Interoperability with Oracle Database 19c (MOS Note 2552181.1)](https://support.oracle.com/epmos/faces/DocumentDisplay?id=2552181.1)
