import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Installing Oracle E-Business Suite 12.2.9 Vision Demo: A Complete Walkthrough',
  slug: 'oracle-ebs-12-2-9-vision-demo-install',
  excerpt:
    'A complete technical walkthrough of installing Oracle E-Business Suite 12.2.9 Vision — covering hardware and OS prerequisites, Oracle Database 19c preparation, Rapid Install configuration, the dual filesystem architecture, post-install steps, and the most common installation failures with their fixes.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-14'),
  youtubeUrl: null,
  content: `Oracle E-Business Suite 12.2.9 Vision is the standard demonstration and development installation of EBS — a fully seeded, multi-module environment with sample data across Financials, Supply Chain, HR, Projects, and every other functional pillar. It is the canonical starting point for technical training, customisation development, patch testing, and upgrade rehearsals. Understanding how to build one from scratch is a prerequisite for any Oracle Apps DBA.

This post walks through a complete fresh install: hardware sizing, OS preparation, Oracle Database 19c setup, Rapid Install execution, and the post-install steps that the documentation underemphasises.

---

## What Vision Is

The Vision Demo database (\`VIS\`) ships with Oracle's EBS media and contains:

- All EBS product modules licenced and enabled
- Pre-seeded organisations, legal entities, operating units, and chart of accounts (Vision Corporation)
- Sample transactions across all modules — open AP invoices, AR transactions, GL journals, PO orders, SO orders, HR employees
- Standard responsibility and user definitions (Vision Services, Vision Operations, SYSADMIN)
- Patch edition and run edition filesystems pre-configured

Vision is **not** a minimal install. The seeded data makes it memory-heavy and the initial database size is typically 150–200 GB after Rapid Install completes. Plan storage accordingly.

---

## Architecture: The Dual Filesystem

EBS 12.2 introduced Online Patching, which requires two parallel filesystems — the **run edition** (serving live traffic) and the **patch edition** (receiving patches while the system is up). Rapid Install creates both:

\`\`\`
/u01/oracle/VIS/
├── fs1/                  ← Run edition (or patch edition — alternates on each patch cycle)
│   ├── EBSapps/
│   │   ├── appl/         ← APPL_TOP: application product files
│   │   ├── ora/          ← Oracle Home: WebLogic, Forms, Reports, OHS
│   │   └── log/
│   └── FMW/              ← Fusion Middleware (WebLogic domain)
├── fs2/                  ← Patch edition
│   ├── EBSapps/
│   └── FMW/
├── fs_ne/                ← Non-edition filesystem (shared, not editioned)
│   ├── inst/             ← Instance-specific config and logs
│   └── EBSapps/
│       └── comn/         ← Common files shared across editions
└── db/                   ← Oracle Database Home (separate from apps tier)
    ├── tech_st/
    │   └── 19.0.0/       ← 19c ORACLE_HOME
    └── apps/
        └── apps_st/
            └── data/     ← Database datafiles (or separate mount)
\`\`\`

The critical concept: \`fs1\` and \`fs2\` are **symmetric** — identical structure, alternating role. After each patching cycle (\`adop finalize\`), the roles flip. The run filesystem serves users; the patch filesystem is inactive. Rapid Install sets up this structure from scratch.

---

## Prerequisites

### Hardware

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| CPU | 4 cores | 8+ cores |
| RAM | 16 GB | 32 GB |
| OS disk (\`/\`, \`/u01\`) | 50 GB | 100 GB |
| Database datafiles | 200 GB | 300 GB |
| Swap | 16 GB | 32 GB |
| Total disk | 400 GB | 600 GB |

Vision is memory-intensive because of the large number of WebLogic Managed Servers started. With 16 GB RAM the system will swap during startup. 32 GB is the practical minimum for comfortable operation.

### Supported OS

| Platform | Versions |
|----------|---------|
| Oracle Linux | 7.x, 8.x |
| Red Hat Enterprise Linux | 7.x, 8.x |
| SUSE Linux | 12 SP4+, 15 |

EBS 12.2.9 does **not** officially support RHEL 9 / OL9 without additional patches. Use OL8 or RHEL 8 for a supported installation.

### Supported Database

| Database Version | Notes |
|-----------------|-------|
| Oracle 19c (19.3+) | Recommended; requires OJVM and JavaVM components |
| Oracle 12.1.0.2 | Supported but end-of-life — do not use for new installs |

Apply the latest 19c RU (Release Update) patch before running Rapid Install. The EBS 12.2.9 certification matrix specifies the minimum RU level.

---

## OS Preparation

### Required Packages (OL8 / RHEL 8)

\`\`\`bash
dnf install -y \
  bc binutils compat-openssl10 elfutils-libelf glibc glibc-devel \
  ksh libaio libaio-devel libX11 libXau libXi libXtst libXrender \
  libXrender-devel libgcc libstdc++ libstdc++-devel make sysstat \
  gcc gcc-c++ unzip zip xorg-x11-xauth xterm \
  libxcrypt-compat numactl-libs

# EBS also requires these 32-bit compat libraries:
dnf install -y glibc.i686 libgcc.i686 libstdc++.i686 libaio.i686
\`\`\`

### Kernel Parameters

Add to \`/etc/sysctl.d/98-oracle-ebs.conf\`:

\`\`\`bash
kernel.shmmax = 4294967296
kernel.shmall = 2097152
kernel.shmmni = 4096
kernel.sem = 250 32000 100 128
fs.file-max = 6815744
fs.aio-max-nr = 1048576
net.ipv4.ip_local_port_range = 9000 65500
net.core.rmem_default = 262144
net.core.rmem_max = 4194304
net.core.wmem_default = 262144
net.core.wmem_max = 1048576
vm.hugetlb_shm_group = 54321    # GID of dba group
\`\`\`

\`\`\`bash
sysctl -p /etc/sysctl.d/98-oracle-ebs.conf
\`\`\`

### OS Users and Groups

\`\`\`bash
groupadd -g 54321 oinstall
groupadd -g 54322 dba
groupadd -g 54323 oper
groupadd -g 54324 backupdba
groupadd -g 54325 dgdba
groupadd -g 54326 kmdba
groupadd -g 54327 racdba
groupadd -g 54328 applmgr

useradd -u 54321 -g oinstall -G dba,oper,backupdba,dgdba,kmdba oracle
useradd -u 54322 -g applmgr  -G oinstall applmgr

passwd oracle
passwd applmgr
\`\`\`

EBS 12.2 uses two OS users:
- \`oracle\` — owns the database Oracle Home
- \`applmgr\` — owns the application tier (APPL_TOP, WebLogic domain, OHS)

Some installations use a single user for both; Oracle's own documentation uses \`applmgr\` for the apps tier throughout this guide.

### Security Limits

\`\`\`bash
cat >> /etc/security/limits.conf << 'EOF'
oracle   soft   nofile   65536
oracle   hard   nofile   65536
oracle   soft   nproc    16384
oracle   hard   nproc    16384
oracle   soft   stack    10240
oracle   hard   stack    32768
oracle   soft   memlock  unlimited
oracle   hard   memlock  unlimited
applmgr  soft   nofile   65536
applmgr  hard   nofile   65536
applmgr  soft   nproc    16384
applmgr  hard   nproc    16384
EOF
\`\`\`

### Directory Layout

\`\`\`bash
mkdir -p /u01/oracle/VIS
mkdir -p /u01/install/media

chown -R oracle:oinstall  /u01/oracle
chown -R applmgr:applmgr  /u01/install
chmod -R 755 /u01
\`\`\`

### Hostname

Rapid Install records the hostname at install time. Changes later require a full context file regeneration. Use a fully qualified, stable hostname:

\`\`\`bash
hostnamectl set-hostname ebsvis.corp.local
# Add to /etc/hosts:
echo "192.168.1.50  ebsvis.corp.local  ebsvis" >> /etc/hosts
\`\`\`

Disable \`/etc/hosts\` lookups that could return \`localhost\` — the installer uses \`hostname -f\` and the result must resolve to a routable IP, not 127.0.0.1.

---

## Oracle Database 19c Installation

### Stage the Software

Download from Oracle Software Delivery Cloud:

- Oracle Database 19c for Linux x86-64 (\`LINUX.X64_193000_db_home.zip\`)
- Latest 19c Release Update patch (e.g., 19.22 RU)
- OPatch 12.2.0.1.41+ (\`p6880880_190000_Linux-x86-64.zip\`)

\`\`\`bash
mkdir -p /u01/oracle/VIS/db/tech_st/19.0.0
cd /u01/oracle/VIS/db/tech_st/19.0.0
unzip /u01/install/media/LINUX.X64_193000_db_home.zip
\`\`\`

### Install Database Software Only

\`\`\`bash
su - oracle
export ORACLE_HOME=/u01/oracle/VIS/db/tech_st/19.0.0

# Silent software-only install:
\$ORACLE_HOME/runInstaller -silent -ignorePrereq \
  oracle.install.option=INSTALL_DB_SWONLY \
  UNIX_GROUP_NAME=oinstall \
  INVENTORY_LOCATION=/u01/oraInventory \
  ORACLE_HOME=\$ORACLE_HOME \
  ORACLE_BASE=/u01/oracle/VIS/db \
  oracle.install.db.InstallEdition=EE \
  oracle.install.db.OSDBA_GROUP=dba \
  oracle.install.db.OSOPER_GROUP=oper \
  oracle.install.db.OSBACKUPDBA_GROUP=backupdba \
  oracle.install.db.OSDGDBA_GROUP=dgdba \
  oracle.install.db.OSKMDBA_GROUP=kmdba \
  oracle.install.db.OSRACDBA_GROUP=racdba \
  DECLINE_SECURITY_UPDATES=true
\`\`\`

Run root scripts when prompted:

\`\`\`bash
/u01/oraInventory/orainstRoot.sh
/u01/oracle/VIS/db/tech_st/19.0.0/root.sh
\`\`\`

### Apply the 19c Release Update

\`\`\`bash
# Replace OPatch:
cd \$ORACLE_HOME
mv OPatch OPatch_orig
unzip /u01/install/media/p6880880_190000_Linux-x86-64.zip

# Apply the RU (e.g., 19.22 = p36233263):
\$ORACLE_HOME/OPatch/opatch apply /u01/install/patches/36233263 \
  -silent -oh \$ORACLE_HOME
\`\`\`

### Verify Database Home

\`\`\`bash
\$ORACLE_HOME/OPatch/opatch lspatches | head -5
# Should show the RU patch as the most recent entry
\`\`\`

---

## Staging the EBS Media

EBS 12.2.9 ships as a set of stage directories. Mount the installation media or copy the stage directory structure:

\`\`\`bash
# Expected stage directory layout after extraction:
/u01/install/media/stage/
├── startCD/
│   └── Disk1/
│       └── rapidwiz       ← The installer executable
├── oraAppDB/
│   └── Disk1/             ← Database tier software
│       └── stage/
├── oraApps/
│   └── Disk1/             ← Application tier software
│       └── stage/
├── oraDB/                 ← Oracle DB Home software (if not pre-installed)
└── oraAS/                 ← Oracle Application Server / WebLogic components
\`\`\`

Set the \`STAGE\` environment variable:

\`\`\`bash
export STAGE=/u01/install/media/stage
\`\`\`

---

## Running Rapid Install

Rapid Install (\`rapidwiz\`) is the EBS installation and configuration wizard. It performs the following in sequence:

1. Validates the OS and hardware prerequisites
2. Creates the application tier file structure (fs1, fs2, fs_ne)
3. Installs and configures Oracle WebLogic Server
4. Installs Oracle Forms, Reports, Discoverer, and OHS components
5. Loads the Vision Demo database (from the media stage) into the 19c database
6. Runs AutoConfig to generate all configuration files
7. Starts all services and validates the environment

### Pre-Install Environment Check

\`\`\`bash
su - oracle
export ORACLE_HOME=/u01/oracle/VIS/db/tech_st/19.0.0
export PATH=\$ORACLE_HOME/bin:\$PATH

# Verify 19c binary:
sqlplus -V
# Oracle Database 19c Enterprise Edition Release 19.0.0.0.0

# Verify tnsping works (listener not required pre-install but PATH must be set):
tnsping localhost
\`\`\`

### Launch rapidwiz

\`\`\`bash
# Run as root (rapidwiz switches to oracle/applmgr as needed):
su - root
export DISPLAY=:0.0     # or use SSH -X tunnelling
xhost +local:

cd /u01/install/media/stage/startCD/Disk1
./rapidwiz
\`\`\`

If running headless (no X11 display), use the response file / silent mode — see the section below.

### Rapid Install Wizard Steps

**Screen 1 — Welcome**
Accept the welcome screen and review the license agreement.

**Screen 2 — Select Installation Type**

| Option | Description |
|--------|-------------|
| Install Oracle E-Business Suite Release 12.2 | Fresh install — this is what you want |
| Express Configuration | Simplified, single-node, accepts defaults |
| Advanced Configuration | Full control over ports, directories, component placement |
| Upgrade | Upgrade from 12.1.x |

Select **Express Configuration** for a Vision Demo install on a single node. If you need to customise directory paths or port numbers, select Advanced.

**Screen 3 — Database Options**

| Option | Select |
|--------|--------|
| Database Type | Single Node |
| Create Vision Demo Database | Yes |
| Use Existing DB | No |
| Database Name (SID) | VIS |
| Database Edition | Enterprise Edition |
| Oracle Home | /u01/oracle/VIS/db/tech_st/19.0.0 |
| Oracle Base | /u01/oracle/VIS/db |
| Character Set | AL32UTF8 |

**Screen 4 — Application Tier Configuration**

| Field | Value |
|-------|-------|
| Base Install Directory | /u01/oracle/VIS |
| Mount Point | /u01/oracle/VIS (single node) |
| OS User — DB Tier | oracle |
| OS User — Apps Tier | applmgr |
| APPL_TOP | /u01/oracle/VIS/fs1/EBSapps/appl |
| Weblogic Domain | /u01/oracle/VIS/fs1/FMW |

**Screen 5 — Port Pool**

The default port pool (0) assigns well-known EBS ports. For a standard Vision install, accept the defaults unless there are conflicts:

| Service | Default Port |
|---------|------------|
| Oracle HTTP Server (OHS) | 8000 |
| Oracle HTTP Server SSL | 4443 |
| WLS Admin Server | 7001 |
| WLS Admin Server SSL | 7002 |
| Forms (OACORE) | 7203 |
| OAFM (Metadata Services) | 7403 |
| Discoverer | 7603 |
| Concurrent Processing | 0610 (listener) |
| Database Listener | 1521 |

**Screen 6 — Password Configuration**

Set passwords for:
- SYSTEM schema
- APPS schema (the EBS application schema — used by all Forms and JDBC connections)
- SYSADMIN (EBS application user — the super-administrator)

Record these. The APPS schema password is baked into hundreds of context file parameters and changing it after install requires running \`FNDCPASS\`.

**Screen 7 — Review and Install**

Review the configuration summary. Rapid Install shows the planned:
- Directory structure
- Port assignments
- Database name and character set
- Stage directory to be used

Click **Install** to begin. The installation takes **3–6 hours** on typical hardware, dominated by the database load phase (loading Vision Demo data into the 19c database from the stage media).

---

## What Rapid Install Does During the Install

The progress screen shows phases. Key ones to watch:

\`\`\`
Phase 1:  Creating directory structure
Phase 2:  Installing Oracle WebLogic Server
Phase 3:  Configuring WebLogic Domain
Phase 4:  Installing Oracle Fusion Middleware components
          (Forms 12, Reports, Discoverer, OHS, SOA, OACORE)
Phase 5:  Creating database (CREATE DATABASE)
Phase 6:  Loading Vision Demo data            ← longest phase (1–3 hours)
Phase 7:  Running post-load SQL scripts
Phase 8:  Running AutoConfig
Phase 9:  Compiling invalid objects
Phase 10: Starting services and validating
\`\`\`

Logs are written to:
\`\`\`
/u01/oracle/VIS/fs_ne/inst/VIS_ebsvis/logs/
    appl/                ← AutoConfig and application tier logs
    ora/                 ← Oracle Home installation logs
    db/                  ← Database creation logs
install<timestamp>.log   ← Top-level rapidwiz log (most important)
\`\`\`

If Rapid Install fails, the top-level \`install*.log\` in the stage directory shows the last phase and points to the specific sub-log with the error.

---

## Completing the Install: root.sh and Post-Install

When Rapid Install finishes the main install, it prompts you to run root scripts. Run as root:

\`\`\`bash
/u01/oracle/VIS/db/tech_st/19.0.0/root.sh      # if not already run
/u01/oracle/VIS/fs1/FMW/webtier/install/root.sh  # OHS root script
\`\`\`

Then click **OK** in the wizard to complete.

---

## Verifying the Installation

### Check Service Status

\`\`\`bash
su - applmgr
source /u01/oracle/VIS/fs1/EBSapps/appl/APPSVIS_ebsvis.env

# EBS service control script (adstrtal.sh):
\$ADMIN_SCRIPTS_HOME/adstrtal.sh apps/<apps_password>

# Or use adadmin equivalents for 12.2:
\$ADMIN_SCRIPTS_HOME/adstatus.sh
\`\`\`

Check the WebLogic Admin Console:
- URL: \`http://ebsvis.corp.local:7001/console\`
- User: \`weblogic\`
- Password: as set during install

Check the EBS home page:
- URL: \`http://ebsvis.corp.local:8000/OA_HTML/AppsLogin\`
- User: \`SYSADMIN\`
- Password: as set during install

### Verify Database Connectivity

\`\`\`bash
su - oracle
source /u01/oracle/VIS/db/tech_st/19.0.0/db.env

sqlplus apps/<apps_password>@VIS
SQL> SELECT release_name FROM fnd_product_groups;
-- Expected: 12.2.9
\`\`\`

### Check for Invalid Objects

\`\`\`sql
SELECT COUNT(*) FROM dba_objects WHERE status = 'INVALID';
-- A fresh Vision install typically has 0–50 invalid objects
-- Run: EXEC UTL_RECOMP.recomp_parallel(4);
-- Then recheck
\`\`\`

---

## Silent / Response File Install

For automated or headless installs, create a response file and run Rapid Install without the GUI:

\`\`\`bash
# Generate a response file from an existing install (on the completed system):
\$STAGE/startCD/Disk1/rapidwiz -record /tmp/vis_install.rsp

# Run a silent install using the response file:
\$STAGE/startCD/Disk1/rapidwiz -responseFile /tmp/vis_install.rsp -silent
\`\`\`

The response file captures all wizard answers. Edit the file to change hostname, directory, or password values before re-running.

---

## Common Installation Failures and Fixes

### 1. Prerequisite Check Fails: Missing 32-bit Libraries

**Error:** \`libgcc_s.so.1: cannot open shared object file\`

**Fix:**
\`\`\`bash
dnf install -y libgcc.i686 glibc.i686 libstdc++.i686
\`\`\`

### 2. Database Creation Fails: Character Set Error

**Error:** \`ORA-12704: character set mismatch\` during Vision data load

**Cause:** The 19c database was created with a character set other than AL32UTF8. The Vision data is UTF8.

**Fix:** Drop the partially-created database and re-run Rapid Install, ensuring AL32UTF8 is selected. There is no in-place fix for character set mismatch.

### 3. Rapid Install Hangs During WebLogic Domain Creation

**Symptom:** Progress bar stops at "Configuring WebLogic Domain" for more than 30 minutes.

**Fix:**
\`\`\`bash
# Check the WLS config log:
tail -100 /u01/oracle/VIS/fs1/FMW/webtier/install/*/installActions*.log

# Common cause: insufficient /tmp space
df -h /tmp
# If < 2 GB free:
mount -o remount,size=4G /tmp
\`\`\`

### 4. OHS Fails to Start Post-Install

**Error:** \`httpd: Syntax error on line N of httpd.conf: Could not open configuration file\`

**Cause:** AutoConfig generated paths based on the installer hostname. If \`hostname -f\` returned a different value during install, the context file is mismatched.

**Fix:**
\`\`\`bash
# Check the context file hostname:
grep s_hostname /u01/oracle/VIS/fs1/EBSapps/appl/admin/VIS_ebsvis.xml

# If wrong, update and re-run AutoConfig:
cd \$ADMIN_SCRIPTS_HOME
./adautocfg.sh apps/<password>
\`\`\`

### 5. Forms Sessions Fail: JRE Version

**Symptom:** Browser launches Forms but immediately errors: \`Java application blocked by security settings\`

**Cause:** The client JRE version is newer than what the Forms JNLP is configured for.

**Fix:** Install JRE 8u361 (the certified version for EBS 12.2) and add the EBS URL to the Java Control Panel Exception Site List. See the EBS Forms Browser Configuration post for full steps.

### 6. Concurrent Manager Fails to Start

**Error in FNDLIBR log:** \`ORA-01017: invalid username/password\` on ICM startup

**Cause:** APPS schema password set in the context file does not match the actual database password.

**Fix:**
\`\`\`bash
# Update the APPS password in the context file and re-run AutoConfig:
# Edit s_appspwd in VIS_ebsvis.xml and re-run adautocfg.sh
# Then restart the Concurrent Manager tier:
\$ADMIN_SCRIPTS_HOME/adcmctl.sh start apps/<password>
\`\`\`

---

## Key Files and Directories After Install

| Path | Purpose |
|------|---------|
| \`\$APPL_TOP/admin/VIS_<host>.xml\` | Context file — master configuration, used by AutoConfig |
| \`\$APPL_TOP/admin/adconfig.txt\` | Record of last AutoConfig run |
| \`\$FND_TOP/patch/115/sql/\` | FND patch scripts |
| \`\$ADMIN_SCRIPTS_HOME/adstrtal.sh\` | Start all EBS services |
| \`\$ADMIN_SCRIPTS_HOME/adstpall.sh\` | Stop all EBS services |
| \`\$ADMIN_SCRIPTS_HOME/adautocfg.sh\` | Re-run AutoConfig |
| \`/u01/oracle/VIS/fs_ne/inst/VIS_<host>/logs/\` | Application tier logs |
| \`\$ORACLE_HOME/network/admin/tnsnames.ora\` | TNS connection descriptors |
| \`\$TWO_TASK\` env var | Database alias used by JDBC / SQLNet |

---

## After the Install: Applying the Latest AD and TXK Patches

Every EBS 12.2 install should be followed immediately by the latest AD (AD Online Patching) and TXK (Technology Stack) patches. These are bundled as the AD-TXK Delta patch:

\`\`\`bash
# Check current AD and TXK versions:
sqlplus apps/<password>@VIS
SQL> SELECT PATCH_LEVEL FROM AD_TRACKABLE_ENTITIES WHERE ABBREVIATION = 'ad';
SQL> SELECT PATCH_LEVEL FROM AD_TRACKABLE_ENTITIES WHERE ABBREVIATION = 'txk';

# Apply the latest AD-TXK delta via adop:
source /u01/oracle/VIS/fs1/EBSapps/appl/APPSVIS_ebsvis.env
adop phase=apply patches=<AD_TXK_patch_number> apply_mode=hotpatch
\`\`\`

The Vision Demo is fully functional without this step, but the AD-TXK patches fix known issues in the patching infrastructure itself — applying them before any other patches avoids triggering bugs that are already resolved in the delta.

---

## Summary

A successful EBS 12.2.9 Vision install requires attention at three junctures: OS preparation (packages, kernel parameters, user setup, hostname stability), database installation (19c with the latest RU, AL32UTF8 character set, OJVM component), and Rapid Install execution (Vision Demo type, correct port pool, APPS and SYSADMIN passwords). The most common failures are hostname mismatches baked into the context file, insufficient \`/tmp\` space stalling WebLogic domain creation, and character set mismatches in the database creation phase — all avoidable by following the prerequisite checklist before launching rapidwiz.

Once installed, the Vision Demo provides a complete, self-contained EBS environment ready for development, testing, and functional demonstration work.`,
};

async function main() {
  console.log('Inserting EBS 12.2.9 Vision Install blog post...');
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
