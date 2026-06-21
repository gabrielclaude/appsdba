import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'SAP HANA on RHEL 9: Architecture, System Requirements, and Installation Overview',
  slug: 'sap-hana-rhel9-installation-architecture',
  excerpt:
    'A comprehensive technical guide to deploying SAP HANA on Red Hat Enterprise Linux 9. Covers in-memory columnar architecture, NSE warm data tiering, RHEL 9 OS preparation with saptune 3.x, hardware sizing rules, HDBLCM installation modes, post-install verification, and a common failure reference table.',
  category: 'sap-hana' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-20'),
  youtubeUrl: null,
  content: `SAP HANA is the in-memory database platform that underpins SAP S/4HANA, BW/4HANA, and a growing roster of SAP SaaS applications. Unlike traditional RDBMS engines that were designed for spinning-disk latencies and bolted on in-memory features later, HANA was built ground-up around the assumption that the entire active dataset lives in DRAM. The consequences of that design choice ripple through every layer of the stack — from how you size the server, to how you prepare the OS, to what a failed installation actually looks like. This post covers the architecture, RHEL 9 platform requirements, OS preparation, and the HDBLCM installation workflow in enough depth to get an experienced Linux or Oracle DBA operational without hunting across five SAP Notes.

---

## What SAP HANA Is

### In-Memory Columnar Engine

HANA stores data in columns rather than rows. When a query aggregates a single column across millions of rows — a classic analytical query — the engine reads only the bytes for that column off contiguous memory pages, enabling CPU-cache-friendly SIMD operations and run-length compression ratios that frequently reach 10:1 or better. For OLTP-style point lookups, HANA maintains a row store for tables where single-record access dominates (configuration tables, session state). The DBA or application developer declares whether a table uses column or row store; column store is the default and the right choice for almost all application tables.

### OLTP and OLAP in One Engine

Traditional architectures required separate OLTP and OLAP databases with ETL pipelines between them. HANA collapses this into a single engine:

- Transactional writes land in an in-memory delta store (row-oriented, optimized for inserts/updates)
- A background delta merge process compacts the delta store into the main column store
- Analytical queries spanning both the main store and the delta store return a consistent view without blocking write operations

The result is that an S/4HANA ERP transaction and a BW analytical query can run against the same HANA instance simultaneously without the write operations degrading read performance — what SAP calls the "OLTP+OLAP convergence."

### Row Store vs. Column Store

| Characteristic | Row Store | Column Store |
|---|---|---|
| Physical layout | All columns for a row stored contiguously | All values for one column stored contiguously |
| Best for | Point lookups, frequent updates | Aggregations, full-column scans |
| Compression | Low (mixed data types per page) | High (same data type per page) |
| Default in HANA | No | Yes |
| Typical tables | Configuration (T000, TCODE), session | Application data (BKPF, VBAP, ACDOCA) |

### NSE — Native Storage Extension

NSE (Native Storage Extension) is HANA's warm data tier. Not all data fits in DRAM economically, and NSE addresses this by allowing page-level demotion of infrequently accessed column store pages to NVMe-backed storage (locally attached or SAN). Pages are loaded back into memory on demand with microsecond latency compared to the milliseconds of a traditional disk read.

NSE operates transparently to the application. The DBA configures an NSE page cache budget (a portion of DRAM reserved for warm pages), sets column table attributes to NSE-eligible, and HANA's internal heat map tracks access frequency. Pages below the access threshold migrate to the NVMe buffer cache automatically.

This matters for sizing: an NSE deployment can have a DRAM footprint 30–50% smaller than a pure in-memory deployment for the same dataset, at the cost of latency for cold page access.

---

## RHEL 9 Compatibility

### SAP-Certified RHEL 9 Versions

SAP certifies specific RHEL minor versions for HANA. As of mid-2026 the supported versions for HANA 2.0 SP07 and later are:

- RHEL 9.2 (kernel 5.14.0-284)
- RHEL 9.4 (kernel 5.14.0-427)
- RHEL 9.6 (kernel 5.14.0-570, supported from HANA 2.0 SP08)

Always verify the current certification matrix in SAP Note 2235581 ("SAP HANA: Supported Operating Systems") before beginning an installation. Minor version requirements are enforced by HDBLCM — it will abort if the OS version is not in the certified list.

RHEL 9 uses cgroup v2 exclusively. HANA 2.0 SP06 and later are cgroup v2 aware; older SPS revisions are not certified on RHEL 9.

### saptune 3.x — OS Tuning Tool

saptune replaces the older tuned-adm SAP profiles. It applies a collection of SAP Notes as a named "solution," ensuring kernel parameters, I/O schedulers, CPU governors, and memory settings all conform to SAP's requirements as a single atomic operation.

On RHEL 9, saptune 3.x is available from the RHEL for SAP Solutions repository:

\`\`\`bash
subscription-manager repos --enable=rhel-9-for-x86_64-sap-solutions-rpms
dnf install -y saptune
systemctl enable --now saptune
\`\`\`

Apply the S/4HANA solution (which includes all HANA-relevant Notes):

\`\`\`bash
saptune solution apply S4HANA
saptune solution verify S4HANA
\`\`\`

The verify subcommand prints a table of each SAP Note and parameter, flagging any value that does not match the expected setting. Run it after every OS change to catch drift.

---

## Hardware and Sizing Requirements

### Memory

RAM is the primary sizing axis for HANA. The in-memory model means that the entire active dataset — HANA column store main + delta + row store + working memory for active sessions — must fit in physical DRAM with headroom.

| Deployment Type | Minimum RAM | Practical Production |
|---|---|---|
| Developer / sandbox | 32 GB | 64 GB |
| Small production (< 500 GB dataset) | 256 GB | 384–512 GB |
| Mid-size production | 512 GB | 768 GB–1 TB |
| Large production | 1 TB+ | 2–4 TB |

The SAP HANA sizing rule of thumb: HANA memory footprint ≈ source data volume after compression ÷ compression factor. For S/4HANA migrations from ECC, SAP's Quick Sizer tool provides workload-specific estimates, but a 3:1–5:1 compression ratio is typical for ACDOCA-heavy datasets.

### Swap

SAP requires that swap space equal total physical RAM, up to a maximum of 1 TB. This is an absolute requirement enforced by HDBLCM — the installer fails if swap is undersized.

\`\`\`bash
# Check current swap
free -h

# If adding swap via LVM:
lvcreate -n swap_lv -L 256G rhel_vg
mkswap /dev/rhel_vg/swap_lv
swapon /dev/rhel_vg/swap_lv
echo '/dev/rhel_vg/swap_lv swap swap defaults 0 0' >> /etc/fstab
\`\`\`

### CPU and NUMA

HANA's parallel query execution is NUMA-aware. On a multi-socket server, HANA assigns worker threads to NUMA nodes and keeps data pages local to the socket that owns them. Mismatches between NUMA topology and HANA's thread layout produce significant performance degradation.

Requirements:
- Minimum 4 physical CPU cores for development, 16+ for production
- All sockets should have equal RAM (asymmetric NUMA configurations are supported but suboptimal)
- Disable transparent huge pages (handled by saptune) and NUMA balancing (automatic page migration conflicts with HANA's explicit NUMA placement)
- Hyper-threading: SAP recommends enabling HT on production systems; use an even number of threads per NUMA node

### Storage Layout

HANA uses four distinct mount points with different I/O profiles:

| Mount Point | Contents | I/O Profile | Minimum Throughput |
|---|---|---|---|
| /hana/data | Data volumes (column store persistence) | Random read/write, latency-sensitive | 400 MB/s, < 1ms latency |
| /hana/log | Redo log volumes | Sequential write, extremely latency-sensitive | 250 MB/s, < 0.5ms latency |
| /hana/shared | HANA installation, shared binaries, backint | Mixed sequential | 100 MB/s |
| /backup | HANA data and log backups | Sequential write, large blocks | 500 MB/s+ |

For /hana/data and /hana/log, NVMe local or NVMe-oF (NVMe over Fabrics) is the recommended storage. Traditional SAN FC is acceptable for /hana/shared and /backup but should not be used for /hana/data or /hana/log on systems where the latency SLA is under 1ms.

In scale-out (multi-host) deployments, /hana/shared must be an NFS export accessible from all nodes simultaneously. /hana/data and /hana/log are local or directly attached per node.

---

## RHEL 9 OS Preparation

### Required Packages

\`\`\`bash
# Enable SAP repositories
subscription-manager repos \
  --enable=rhel-9-for-x86_64-baseos-rpms \
  --enable=rhel-9-for-x86_64-appstream-rpms \
  --enable=rhel-9-for-x86_64-sap-solutions-rpms \
  --enable=rhel-9-for-x86_64-sap-netweaver-rpms

# Install HANA prerequisites
dnf install -y \
  libtool-ltdl \
  libgcc \
  libstdc++ \
  compat-sap-c++-12 \
  uuidd \
  java-11-openjdk \
  java-11-openjdk-devel \
  glibc \
  glibc-devel \
  libpng \
  nfs-utils \
  numactl \
  numactl-libs \
  xfsprogs \
  lvm2 \
  bind-utils \
  net-tools \
  tcpdump \
  saptune \
  sapconf

# Verify compat-sap-c++ version (must match HANA SPS requirement)
rpm -qa | grep compat-sap-c
\`\`\`

The \`compat-sap-c++-12\` package provides the SAP-specific C++ runtime libraries. HANA is compiled against a specific GCC version that differs from the system GCC; this compatibility package ensures HANA's internal libraries resolve correctly. Missing this package is one of the most common causes of pre-check failures.

\`uuidd\` (the UUID daemon) must be running before installation:

\`\`\`bash
systemctl enable --now uuidd
systemctl status uuidd
\`\`\`

### saptune Solution Application

\`\`\`bash
# Apply S4HANA solution (covers SAP Notes for HANA on Linux)
saptune solution apply S4HANA

# Verify all parameters are set correctly
saptune solution verify S4HANA

# Check saptune daemon status
saptune daemon status
\`\`\`

saptune sets dozens of parameters. Key ones it configures:

- /sys/kernel/mm/transparent_hugepage/enabled → never
- /proc/sys/kernel/numa_balancing → 0
- I/O scheduler for HANA disks → noop / none (NVMe) or deadline (block devices)
- CPU frequency governor → performance

### Kernel Parameters

Even with saptune applied, verify these are set in /etc/sysctl.d/99-sap-hana.conf:

\`\`\`bash
cat > /etc/sysctl.d/99-sap-hana.conf << 'EOF'
# SAP HANA kernel parameters — RHEL 9
vm.max_map_count = 2147483647
fs.aio-max-nr = 18446744073709551615
kernel.sem = 1250 256000 100 8192
net.core.somaxconn = 4096
net.ipv4.tcp_max_syn_backlog = 8192
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
EOF

sysctl -p /etc/sysctl.d/99-sap-hana.conf
\`\`\`

\`vm.max_map_count\` is the most frequently violated requirement. HANA maps a large number of memory regions via mmap; the default kernel value of 65530 is orders of magnitude too low. The installation pre-check will fail with a clear error if this value is insufficient, but it is better to set it before running HDBLCM.

Transparent huge pages must be disabled persistently (saptune handles this, but confirm in the GRUB cmdline for systems where saptune is applied after the initial boot):

\`\`\`bash
# Add to GRUB_CMDLINE_LINUX in /etc/default/grub:
# transparent_hugepage=never numa_balancing=disable

grubby --update-kernel=ALL \
  --args="transparent_hugepage=never numa_balancing=disable"

grub2-mkconfig -o /boot/grub2/grub.cfg

# Verify immediately without reboot
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag
echo 0 > /proc/sys/kernel/numa_balancing
\`\`\`

### OS Users and Groups

HANA requires specific OS users and groups. Replace \`HXE\` (the System Identifier) with your actual SID. The SID must be three alphanumeric characters, starting with a letter, and not one of SAP's reserved identifiers (SYS, ALL, NEW, etc.).

\`\`\`bash
# Create sapsys group (GID 79 is the SAP standard; adjust if taken)
groupadd -g 79 sapsys

# sapadm — SAP Host Agent user
useradd -u 1000 -g sapsys -d /home/sapadm -s /bin/bash -c "SAP Host Agent" sapadm

# hxeadm — HANA instance admin user (SID=HXE → lowercase sid + adm)
# Instance number 00 is assumed here; adjust -u UID as needed
useradd -u 1001 -g sapsys -d /usr/sap/HXE/home -s /bin/bash \
  -c "SAP HANA DB Admin" hxeadm

# Set passwords
passwd sapadm
passwd hxeadm
\`\`\`

The HDBLCM installer can also create these users automatically during installation. If you pre-create them, HDBLCM will validate that the UIDs and group memberships match what it expects.

### File System Creation and Mount Points

\`\`\`bash
# Assumes /dev/sdb is the data LUN, /dev/sdc is the log LUN
# /dev/sdd is shared, /dev/sde is backup
# Adjust device names for your environment (nvme0n1, sdb, etc.)

# Create LVM VGs and LVs (or use raw partitions on NVMe)
pvcreate /dev/sdb
vgcreate vg_hana_data /dev/sdb
lvcreate -l 100%FREE -n lv_hana_data vg_hana_data

pvcreate /dev/sdc
vgcreate vg_hana_log /dev/sdc
lvcreate -l 100%FREE -n lv_hana_log vg_hana_log

pvcreate /dev/sdd
vgcreate vg_hana_shared /dev/sdd
lvcreate -l 100%FREE -n lv_hana_shared vg_hana_shared

pvcreate /dev/sde
vgcreate vg_backup /dev/sde
lvcreate -l 100%FREE -n lv_backup vg_backup

# Format with XFS (recommended for HANA)
mkfs.xfs /dev/vg_hana_data/lv_hana_data
mkfs.xfs /dev/vg_hana_log/lv_hana_log
mkfs.xfs /dev/vg_hana_shared/lv_hana_shared
mkfs.xfs /dev/vg_backup/lv_backup

# Create mount points and set ownership
mkdir -p /hana/data /hana/log /hana/shared /backup
chown hxeadm:sapsys /hana/data /hana/log
chown hxeadm:sapsys /hana/shared
chown hxeadm:sapsys /backup

# Mount with recommended XFS options
cat >> /etc/fstab << 'EOF'
/dev/vg_hana_data/lv_hana_data    /hana/data    xfs  defaults,noatime,nodiratime,logbsize=256k,nobarrier  0 0
/dev/vg_hana_log/lv_hana_log      /hana/log     xfs  defaults,noatime,nodiratime,logbsize=256k            0 0
/dev/vg_hana_shared/lv_hana_shared /hana/shared  xfs  defaults,noatime                                    0 0
/dev/vg_backup/lv_backup           /backup       xfs  defaults,noatime                                    0 0
EOF

mount -a
df -h /hana/data /hana/log /hana/shared /backup
\`\`\`

The \`nobarrier\` mount option is safe for /hana/data when the underlying storage has a battery-backed write cache or when using NVMe devices with power-loss protection. Do not use \`nobarrier\` on /hana/log — HANA's redo log write integrity depends on write ordering guarantees that barriers provide.

\`logbsize=256k\` increases the XFS log buffer size, reducing metadata write latency for the high-frequency small-write pattern that /hana/data exhibits during delta merge operations.

### Security Limits for hxeadm

Add to /etc/security/limits.d/99-sap-hana.conf:

\`\`\`bash
cat > /etc/security/limits.d/99-sap-hana.conf << 'EOF'
# SAP HANA OS limits for hxeadm (replace hxeadm with your <sid>adm)
hxeadm  soft  nofile    1048576
hxeadm  hard  nofile    1048576
hxeadm  soft  nproc     unlimited
hxeadm  hard  nproc     unlimited
hxeadm  soft  stack     67108864
hxeadm  hard  stack     67108864
hxeadm  soft  memlock   unlimited
hxeadm  hard  memlock   unlimited
@sapsys soft  nofile    1048576
@sapsys hard  nofile    1048576
EOF
\`\`\`

The \`memlock\` unlimited setting is required because HANA uses mlock to pin critical memory pages (particularly the column store delta and the log buffer). Without this, HANA may fail to start with "Cannot lock memory" errors in the trace files.

---

## HDBLCM — HANA Database Lifecycle Manager

### What HDBLCM Is

HDBLCM (HANA Database Lifecycle Manager) is the unified tool for all HANA instance lifecycle operations: initial installation, upgrade, patch application, system copy, and uninstall. It is shipped inside the HANA installation media (SAR file, extracted with SAPCAR).

HDBLCM runs in three modes:
- **Interactive GUI** (requires a browser, launched with \`--gui\`): walks through a wizard with a form for each parameter. Useful for first-time installs.
- **Interactive CLI**: prompted text interface, suitable for SSH sessions.
- **Silent / unattended**: all parameters passed via command-line flags or a configuration file. Required for automated deployments.

### Extracting Installation Media

HANA is distributed as a SAR archive. Extract with SAPCAR:

\`\`\`bash
# Download SAPCAR and the HANA SAR from SAP Launchpad (requires S-User)
chmod +x SAPCAR_1115-70006178.EXE
./SAPCAR_1115-70006178.EXE -xvf IMDB_SERVER20_074_0-80002031.SAR
cd SAP_HANA_DATABASE
ls hdblcm
\`\`\`

### Interactive Installation

\`\`\`bash
cd /path/to/SAP_HANA_DATABASE
./hdblcm --action=install
\`\`\`

HDBLCM will prompt for:
- Installation path (default /hana/shared)
- SID (System Identifier, e.g., HXE)
- Instance number (00–97, e.g., 00)
- System user (SYSTEM) password
- Master password (used for all internal service passwords if individual ones are not specified)
- Data volume path (/hana/data/\${SID})
- Log volume path (/hana/log/\${SID})

### Silent Installation

For repeatable, automated deployments:

\`\`\`bash
./hdblcm \
  --action=install \
  --components=server \
  --sid=HXE \
  --number=00 \
  --system_user_password='Hana@Secure1!' \
  --password='Hana@Secure1!' \
  --datapath=/hana/data/HXE \
  --logpath=/hana/log/HXE \
  --sapmnt=/hana/shared \
  --batch \
  --ignore=check_signature_file \
  2>&1 | tee /tmp/hdblcm_install.log
\`\`\`

Key parameters:

| Parameter | Description |
|---|---|
| \`--sid\` | SAP System Identifier (3 chars, uppercase). Determines directory structure and OS username. |
| \`--number\` | Instance number (2 digits, 00–97). Determines port numbers: SQL port = 3\${number}15 |
| \`--system_user_password\` | Password for the SYSTEM database user (the HANA SQL DBA account) |
| \`--password\` | Master password — used for all component service users if individual passwords are not specified |
| \`--datapath\` | Absolute path for data volumes (must exist and be owned by \${sid}adm) |
| \`--logpath\` | Absolute path for log volumes (must exist and be owned by \${sid}adm) |
| \`--sapmnt\` | Root of the shared HANA installation (/hana/shared) |
| \`--batch\` | Non-interactive mode — no prompts, fail on any error |
| \`--components\` | What to install: server (DB engine), client, studio, smartdataaccess — most installs use "server" |

Passwords must meet HANA's default complexity policy: minimum 8 characters, at least one uppercase, one lowercase, one digit, one special character.

### Pre-Installation Check (Recommended)

Run HDBLCM in check mode before committing to the installation. This validates OS parameters, disk space, swap, user accounts, and network configuration without writing anything:

\`\`\`bash
./hdblcm --action=check_installation_prerequisites \
  --sid=HXE \
  --number=00 \
  --system_user_password='Hana@Secure1!' \
  --password='Hana@Secure1!'
\`\`\`

Every failed check prints a specific SAP Note number that documents the fix. Resolve all errors before running the actual install.

---

## Post-Install Verification

### Starting and Stopping HANA

After installation, the HANA instance is managed via the HDB command as the \${sid}adm OS user:

\`\`\`bash
# Switch to HANA admin user
su - hxeadm

# Start HANA
HDB start

# Stop HANA
HDB stop

# Check all HANA processes
HDB info
\`\`\`

HDB info shows all HANA services: nameserver, indexserver, statisticsserver, scriptserver, and webdispatcher. All should show state "GREEN" within 2–3 minutes of start.

### SQL Verification with hdbsql

\`\`\`bash
# Connect as SYSTEM to the SYSTEMDB
hdbsql -i 00 -u SYSTEM -p 'Hana@Secure1!' \
  "SELECT * FROM M_DATABASE"

# Check HANA version
hdbsql -i 00 -u SYSTEM -p 'Hana@Secure1!' \
  "SELECT VERSION FROM M_DATABASE"

# Landscape view — all services and their statuses
hdbsql -i 00 -u SYSTEM -p 'Hana@Secure1!' \
  "SELECT HOST, PORT, SERVICE_NAME, ACTIVE_STATUS FROM M_SERVICES"
\`\`\`

Expected output from M_SERVICES on a single-host system:

\`\`\`
HOST          | PORT  | SERVICE_NAME       | ACTIVE_STATUS
--------------+-------+--------------------+--------------
hanaserver01  | 30001 | nameserver         | YES
hanaserver01  | 30003 | indexserver        | YES
hanaserver01  | 30007 | xsengine           | YES
hanaserver01  | 30010 | statisticsserver   | YES
hanaserver01  | 30017 | scriptserver       | YES
\`\`\`

Port pattern: 3\${instance_number}XX — instance 00 uses ports 30001, 30003, 30010, etc.

### Tenant Database Check

In a standard HANA 2.0 installation, you have a SYSTEMDB (the administrative database) and at least one tenant database. Verify both:

\`\`\`bash
# List all databases (SYSTEMDB connection)
hdbsql -i 00 -u SYSTEM -p 'Hana@Secure1!' -d SYSTEMDB \
  "SELECT DATABASE_NAME, ACTIVE_STATUS, DESCRIPTION FROM M_DATABASES"

# Connect directly to the tenant
hdbsql -i 00 -u SYSTEM -p 'Hana@Secure1!' -d HXE \
  "SELECT * FROM M_DATABASE"

# Check disk usage for data and log volumes
hdbsql -i 00 -u SYSTEM -p 'Hana@Secure1!' -d HXE \
  "SELECT HOST, PATH, DISK_SIZE/1024/1024/1024 AS DISK_GB,
          USED_SIZE/1024/1024/1024 AS USED_GB
   FROM M_DISK_USAGE
   ORDER BY PATH"
\`\`\`

If the tenant database shows ACTIVE_STATUS = 'NO', start it from SYSTEMDB:

\`\`\`bash
hdbsql -i 00 -u SYSTEM -p 'Hana@Secure1!' -d SYSTEMDB \
  "ALTER SYSTEM START DATABASE HXE"
\`\`\`

### Memory Utilization Check

\`\`\`bash
hdbsql -i 00 -u SYSTEM -p 'Hana@Secure1!' -d HXE \
  "SELECT HOST,
          ROUND(TOTAL_MEMORY_USED_SIZE/1024/1024/1024, 2) AS MEM_USED_GB,
          ROUND(PHYSICAL_MEMORY_SIZE/1024/1024/1024, 2) AS PHYS_MEM_GB
   FROM M_HOST_RESOURCE_UTILIZATION"
\`\`\`

---

## systemd Service for Automatic Startup

HDBLCM registers a systemd service during installation. The service name follows the pattern \`saphana@\${SID}_\${INSTANCE_NUMBER}\`:

\`\`\`bash
# Check service status
systemctl status saphana@HXE_00

# Enable for automatic start on boot
systemctl enable saphana@HXE_00

# Start/stop via systemd
systemctl start saphana@HXE_00
systemctl stop saphana@HXE_00
\`\`\`

If the service was not registered (can happen with manual installations or custom HDBLCM flags), register it manually:

\`\`\`bash
# As root
/hana/shared/HXE/global/hdb/install/Installation/config/saphostagent/init.d/rc.saphostagent restart
# Or re-register via HDBLCM
/hana/shared/HXE/hdblcm/hdblcm --action=register_instance --sid=HXE --number=00
\`\`\`

The SAP Host Agent (sapstartsrv) also manages HANA startup and is what systemd calls under the hood. Verify it is running:

\`\`\`bash
/usr/sap/hostctrl/exe/saphostexec -status
\`\`\`

---

## Common Installation Failures

| Failure | Root Cause | Resolution |
|---|---|---|
| \`Check of operating system version failed\` | RHEL minor version not in HANA's certified list | Upgrade to a certified minor version (e.g., RHEL 9.2 or 9.4). See SAP Note 2235581. |
| \`vm.max_map_count is too low\` | Kernel parameter not set or not applied | Set \`vm.max_map_count=2147483647\` in sysctl.d and run \`sysctl -p\` |
| \`Swap space is insufficient\` | Swap < physical RAM | Add swap via LVM or swap file. Swap must equal RAM (up to 1 TB). |
| \`uuidd is not running\` | UUID daemon not started | \`systemctl enable --now uuidd\` |
| \`compat-sap-c++-12 not installed\` | Missing SAP C++ compat library | Enable SAP repos and \`dnf install -y compat-sap-c++-12\` |
| \`transparent_hugepage is not set to never\` | THP still enabled at install time | Apply saptune or manually echo to /sys/kernel/mm/transparent_hugepage/enabled |
| \`Cannot lock memory (ENOMEM)\` during first start | memlock limit not set for hxeadm | Add unlimited memlock to /etc/security/limits.d/99-sap-hana.conf and re-login |
| \`Data path does not exist or is not writable\` | /hana/data/\${SID} not created or wrong ownership | \`mkdir -p /hana/data/HXE && chown hxeadm:sapsys /hana/data/HXE\` |
| HDBLCM exits with \`FATAL: unable to find... libstdc++.so.6\` | libstdc++ version mismatch | \`dnf install -y libstdc++ libgcc\` and verify \`ldconfig -p | grep libstdc\` |
| Indexserver crashes on first start with \`signal 11\` | NUMA balancing enabled; HANA's page placement conflicts with kernel migration | Disable NUMA balancing: \`echo 0 > /proc/sys/kernel/numa_balancing\` and add to GRUB cmdline |
| \`Tenant DB HXE not starting\` after system restart | Tenant not set to auto-start | \`hdbsql -d SYSTEMDB "ALTER DATABASE HXE ADD 'autostart' = 'yes'"\` |
| License error on startup | Installation requires an initial license | Install a 90-day evaluation license from HDBLCM: \`./hdblcm --action=add_license --license_key_file=HDB_license.txt\` |

---

## Summary

SAP HANA on RHEL 9 rewards careful OS preparation. The combination of saptune 3.x for automated parameter compliance, explicit verification of vm.max_map_count and transparent_hugepage state, correctly sized swap, and properly owned XFS mount points eliminates the majority of installation failures. HDBLCM's pre-check mode (\`--action=check_installation_prerequisites\`) is the most efficient way to validate all of this before committing to the install. Post-installation, the M_SERVICES and M_DATABASES views in hdbsql give you an immediate health picture, and the saphana@\${SID}_\${INSTANCE} systemd service provides reliable automatic restart. The failure table above covers the scenarios most frequently encountered in the field — most root causes boil down to one of three categories: OS package gaps, kernel parameter drift, or file system ownership errors.`,
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
