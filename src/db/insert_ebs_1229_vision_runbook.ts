import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS 12.2.9 Vision Demo Install: Step-by-Step Runbook',
  slug: 'oracle-ebs-12-2-9-vision-demo-install-runbook',
  excerpt:
    'A complete step-by-step runbook for installing Oracle E-Business Suite 12.2.9 Vision on Oracle Linux 8 with Oracle Database 19c — covering OS hardening, 19c software install and RU patching, media staging, Rapid Install execution, post-install validation, initial service startup, and common error resolution with exact commands.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-14'),
  youtubeUrl: null,
  content: `## Environment Assumptions

| Parameter | Value |
|-----------|-------|
| OS | Oracle Linux 8.x |
| Hostname | ebsvis.corp.local |
| IP Address | 192.168.1.50 |
| Base directory | /u01 |
| EBS SID | VIS |
| Database version | Oracle 19c (19.22+ RU) |
| Character set | AL32UTF8 |
| Apps tier OS user | applmgr |
| DB tier OS user | oracle |
| Stage directory | /u01/install/media/stage |
| Estimated install time | 4–6 hours |

---

## Phase 1 — OS Preparation

### 1.1 Set Hostname

\`\`\`bash
hostnamectl set-hostname ebsvis.corp.local

# Add to /etc/hosts (replace with actual IP):
echo "192.168.1.50  ebsvis.corp.local  ebsvis" >> /etc/hosts

# Verify:
hostname -f
# Must return: ebsvis.corp.local
# Must NOT return: localhost or 127.0.0.1
\`\`\`

### 1.2 Install Required Packages

\`\`\`bash
dnf install -y \
  bc binutils compat-openssl10 elfutils-libelf glibc glibc-devel \
  ksh libaio libaio-devel libX11 libXau libXi libXtst \
  libXrender libXrender-devel libgcc libstdc++ libstdc++-devel \
  make gcc gcc-c++ sysstat unzip zip numactl-libs \
  xorg-x11-xauth xorg-x11-utils xterm libxcrypt-compat \
  glibc.i686 libgcc.i686 libstdc++.i686 libaio.i686

# Verify key 32-bit libs:
rpm -qa | grep -E "glibc.i686|libgcc.i686"
\`\`\`

### 1.3 Configure Kernel Parameters

\`\`\`bash
cat > /etc/sysctl.d/98-oracle-ebs.conf << 'EOF'
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
EOF

sysctl -p /etc/sysctl.d/98-oracle-ebs.conf
\`\`\`

### 1.4 Create OS Groups and Users

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
useradd -u 54322 -g applmgr -G oinstall applmgr

# Set passwords:
passwd oracle
passwd applmgr
\`\`\`

### 1.5 Security Limits

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

### 1.6 Create Directory Structure

\`\`\`bash
mkdir -p /u01/oracle/VIS
mkdir -p /u01/install/media/patches
mkdir -p /u01/oraInventory

chown -R oracle:oinstall  /u01/oracle /u01/oraInventory
chown -R applmgr:applmgr  /u01/install
chmod -R 755 /u01
\`\`\`

### 1.7 Disable SELinux and Firewall (for install)

\`\`\`bash
# Set SELinux to permissive:
setenforce 0
sed -i 's/^SELINUX=.*/SELINUX=permissive/' /etc/selinux/config

# Stop firewall (re-enable with EBS port rules after install):
systemctl stop firewalld
systemctl disable firewalld
\`\`\`

### 1.8 Disable Transparent Huge Pages

\`\`\`bash
grubby --update-kernel=ALL --args="transparent_hugepage=never"
# Takes effect after reboot — reboot now if not already done with current kernel
reboot
\`\`\`

Verify after reboot:

\`\`\`bash
cat /sys/kernel/mm/transparent_hugepage/enabled
# Expected: always madvise [never]
\`\`\`

---

## Phase 2 — Oracle Database 19c Installation

### 2.1 Stage the Database Software

\`\`\`bash
su - oracle
mkdir -p /u01/oracle/VIS/db/tech_st/19.0.0
cd /u01/oracle/VIS/db/tech_st/19.0.0
unzip /u01/install/media/LINUX.X64_193000_db_home.zip
\`\`\`

### 2.2 Set oracle User Environment

Add to \`/home/oracle/.bash_profile\`:

\`\`\`bash
cat >> /home/oracle/.bash_profile << 'EOF'
# Oracle 19c Database Home
export ORACLE_BASE=/u01/oracle/VIS/db
export ORACLE_HOME=/u01/oracle/VIS/db/tech_st/19.0.0
export ORACLE_SID=VIS
export PATH=\$ORACLE_HOME/bin:\$ORACLE_HOME/OPatch:\$PATH
export LD_LIBRARY_PATH=\$ORACLE_HOME/lib:\$LD_LIBRARY_PATH
export NLS_LANG=AMERICAN_AMERICA.AL32UTF8
EOF

source /home/oracle/.bash_profile
\`\`\`

### 2.3 Install Database Software (Silent)

\`\`\`bash
su - oracle
\$ORACLE_HOME/runInstaller -silent -ignorePrereq \
  oracle.install.option=INSTALL_DB_SWONLY \
  UNIX_GROUP_NAME=oinstall \
  INVENTORY_LOCATION=/u01/oraInventory \
  ORACLE_HOME=\$ORACLE_HOME \
  ORACLE_BASE=\$ORACLE_BASE \
  oracle.install.db.InstallEdition=EE \
  oracle.install.db.OSDBA_GROUP=dba \
  oracle.install.db.OSOPER_GROUP=oper \
  oracle.install.db.OSBACKUPDBA_GROUP=backupdba \
  oracle.install.db.OSDGDBA_GROUP=dgdba \
  oracle.install.db.OSKMDBA_GROUP=kmdba \
  oracle.install.db.OSRACDBA_GROUP=racdba \
  DECLINE_SECURITY_UPDATES=true
\`\`\`

Watch the log in \`/tmp/InstallActions*.log\`. When prompted, run as root:

\`\`\`bash
su - root
/u01/oraInventory/orainstRoot.sh
/u01/oracle/VIS/db/tech_st/19.0.0/root.sh
\`\`\`

Then return to the installer terminal and press Enter to complete.

### 2.4 Replace OPatch

\`\`\`bash
su - oracle
cd \$ORACLE_HOME
mv OPatch OPatch_orig
unzip /u01/install/media/patches/p6880880_190000_Linux-x86-64.zip

# Verify version (must be 12.2.0.1.41 or later for 19c):
\$ORACLE_HOME/OPatch/opatch version
\`\`\`

### 2.5 Apply the 19c Release Update

\`\`\`bash
# Unzip the RU (example: 19.22 = patch 36233263):
cd /u01/install/media/patches
unzip p36233263_190000_Linux-x86-64.zip -d /u01/install/media/patches/36233263

# Apply:
\$ORACLE_HOME/OPatch/opatch apply \
  /u01/install/media/patches/36233263 \
  -silent -oh \$ORACLE_HOME

# Verify it applied:
\$ORACLE_HOME/OPatch/opatch lspatches | head -3
\`\`\`

### 2.6 Install OJVM Component (Required for EBS)

EBS requires the OJVM (Oracle JVM) database component. If it was not installed with the DB Home, install it now:

\`\`\`bash
# Check if OJVM is present:
sqlplus / as sysdba << 'EOF'
SELECT comp_name, status, version FROM dba_registry WHERE comp_name = 'Oracle Database Java Packages';
EOF
\`\`\`

If not present, install it via \`dbca\` or the OJVM patch (check the EBS 12.2.9 certification note on MOS for the specific OJVM patch number certified with your RU level).

---

## Phase 3 — Stage the EBS 12.2.9 Media

### 3.1 Download from Oracle Software Delivery Cloud

Required downloads from edelivery.oracle.com for "Oracle E-Business Suite":

- Oracle E-Business Suite 12.2.9 (multi-disc set — typically 30–50 GB)

Extract all discs into the stage directory, preserving the directory structure:

\`\`\`bash
su - applmgr
mkdir -p /u01/install/media/stage

cd /u01/install/media
# Extract each disc zip in sequence (disc1 first, then disc2...):
unzip -o 'V*.zip' -d /u01/install/media/stage

# Verify stage structure:
ls /u01/install/media/stage/
# Expected: startCD/  oraAppDB/  oraApps/  oraDB/  oraAS/  (and others)
\`\`\`

### 3.2 Verify Stage Integrity

\`\`\`bash
ls -la /u01/install/media/stage/startCD/Disk1/rapidwiz
# Must exist and be executable

ls /u01/install/media/stage/oraAppDB/Disk1/stage/
# Should contain EBS application database components
\`\`\`

---

## Phase 4 — Run Rapid Install

### 4.1 Pre-Flight Checks

\`\`\`bash
# Verify hostname is stable and resolvable:
hostname -f && nslookup $(hostname -f)

# Verify /tmp has at least 4 GB free:
df -h /tmp

# Verify oracle user can run sqlplus:
su - oracle
sqlplus -V   # Oracle Database 19c Enterprise Edition Release 19.0.0.0.0

# Verify DISPLAY is set (for GUI mode):
echo \$DISPLAY   # must be set, e.g., :0.0 or localhost:10.0

# Verify /u01 disk space:
df -h /u01   # must have > 400 GB free
\`\`\`

### 4.2 Launch rapidwiz

\`\`\`bash
# Run as root:
su - root
export DISPLAY=:0.0   # adjust if using SSH X11 forwarding

cd /u01/install/media/stage/startCD/Disk1
./rapidwiz
\`\`\`

### 4.3 Rapid Install Configuration Selections

Work through the wizard with these values:

**Install Type:** Install Oracle E-Business Suite Release 12.2 → **Express Configuration**

**Database Configuration:**
\`\`\`
Create Vision Demo Database:    Yes
Database SID:                   VIS
Database Edition:               Enterprise Edition
Oracle Database Home:           /u01/oracle/VIS/db/tech_st/19.0.0
Oracle Database Base:           /u01/oracle/VIS/db
Character Set:                  AL32UTF8
\`\`\`

**Application Tier:**
\`\`\`
Base Install Directory:         /u01/oracle/VIS
OS User — Database Tier:        oracle
OS User — Application Tier:     applmgr
\`\`\`

**Port Pool:** Accept defaults (Pool 0)

**Passwords (set and record these):**
\`\`\`
SYSTEM password:        <record>
APPS password:          <record>
SYSADMIN password:      <record>
WebLogic password:      <record>
\`\`\`

**Stage Area:** \`/u01/install/media/stage\`

Click **Install** to begin.

### 4.4 Monitor Install Progress

Open a second terminal and monitor the top-level log:

\`\`\`bash
tail -f /u01/install/media/stage/startCD/Disk1/install/logs/installVIS*.log
\`\`\`

Key milestones to watch for:
\`\`\`
Creating OS Directory Structure...           (2-5 min)
Installing WebLogic Server...                (10-20 min)
Installing Technology Stack components...   (20-40 min)
Creating the RDBMS...                        (30-60 min)
Loading Vision Demo data...                  (60-180 min)  ← longest
Running AutoConfig...                        (15-30 min)
Compiling invalid objects...                 (10-20 min)
Starting EBS Services...                     (5-10 min)
\`\`\`

### 4.5 Run Root Scripts When Prompted

When the wizard stops and prompts for root scripts, run in order:

\`\`\`bash
su - root
/u01/oracle/VIS/db/tech_st/19.0.0/root.sh
/u01/oracle/VIS/fs1/FMW/webtier/install/orainstRoot.sh 2>/dev/null || true
/u01/oracle/VIS/fs1/FMW/webtier/install/root.sh
\`\`\`

Return to the wizard and click **OK** to continue and finalize.

---

## Phase 5 — Post-Install Validation

### 5.1 Source the Environment

\`\`\`bash
su - applmgr
source /u01/oracle/VIS/fs1/EBSapps/appl/APPSVIS_ebsvis.env

# Verify key variables:
echo \$APPL_TOP          # /u01/oracle/VIS/fs1/EBSapps/appl
echo \$TWO_TASK           # VIS
echo \$ADMIN_SCRIPTS_HOME
\`\`\`

\`\`\`bash
su - oracle
source /u01/oracle/VIS/db/tech_st/19.0.0/db.env
echo \$ORACLE_HOME   # /u01/oracle/VIS/db/tech_st/19.0.0
echo \$ORACLE_SID    # VIS
\`\`\`

### 5.2 Verify Database

\`\`\`bash
su - oracle
sqlplus / as sysdba << 'EOF'
SELECT instance_name, status, version FROM v\$instance;
SELECT name, open_mode, log_mode FROM v\$database;
SELECT value FROM nls_database_parameters WHERE parameter = 'NLS_CHARACTERSET';
-- Expected: AL32UTF8
SELECT release_name FROM fnd_product_groups;
-- Expected: 12.2.9
SELECT COUNT(*) FROM dba_objects WHERE status = 'INVALID';
-- Run: EXEC UTL_RECOMP.recomp_parallel(4); if > 50
EOF
\`\`\`

### 5.3 Check Service Status

\`\`\`bash
su - applmgr
source /u01/oracle/VIS/fs1/EBSapps/appl/APPSVIS_ebsvis.env
\$ADMIN_SCRIPTS_HOME/adstatus.sh apps/<apps_password>
\`\`\`

All services should show **Running**:
\`\`\`
Service                          Status
-------------------------------  -------
Oracle HTTP Server               Running
WebLogic Admin Server            Running
Managed Server: oacore_server1   Running
Managed Server: oafm_server1     Running
Managed Server: forms_server1    Running
Concurrent Manager (ICM)         Running
\`\`\`

### 5.4 Validate Web UI

\`\`\`bash
# Test OHS port from the server:
curl -s -o /dev/null -w "%{http_code}" http://ebsvis.corp.local:8000/OA_HTML/AppsLogin
# Expected: 200

# Test WebLogic Admin Console:
curl -s -o /dev/null -w "%{http_code}" http://ebsvis.corp.local:7001/console
# Expected: 302 (redirect to login)
\`\`\`

From a browser:
- EBS Login: \`http://ebsvis.corp.local:8000/OA_HTML/AppsLogin\`
  - User: \`SYSADMIN\` / password set during install
- WebLogic Console: \`http://ebsvis.corp.local:7001/console\`
  - User: \`weblogic\` / password set during install

### 5.5 Log File Locations

| Service | Log Location |
|---------|-------------|
| rapidwiz install log | \`/u01/install/media/stage/startCD/Disk1/install/logs/\` |
| AutoConfig | \`\$INST_TOP/admin/log/\` |
| OHS | \`\$LOG_HOME/ora/10.1.3/apache/\` |
| WebLogic Admin Server | \`\$FMW_HOME/user_projects/domains/EBS_domain_VIS/servers/AdminServer/logs/\` |
| oacore Managed Server | \`\$FMW_HOME/.../servers/oacore_server1/logs/\` |
| Concurrent Manager | \`\$APPLCSF/\$APPLLOG/\` |
| Database alert log | \`\$ORACLE_BASE/diag/rdbms/vis/VIS/trace/alert_VIS.log\` |

---

## Phase 6 — Apply AD-TXK Delta Patches

These patches update the EBS patching infrastructure itself. Apply immediately after install.

### 6.1 Check Current AD and TXK Versions

\`\`\`sql
SELECT abbreviation, patch_level
FROM ad_trackable_entities
WHERE abbreviation IN ('ad', 'txk')
ORDER BY abbreviation;
\`\`\`

### 6.2 Download and Apply

Download the current AD-TXK delta from My Oracle Support (search for the EBS 12.2 AD-TXK cumulative patch note — Doc ID 1617461.1 for the patch list).

\`\`\`bash
su - applmgr
source /u01/oracle/VIS/fs1/EBSapps/appl/APPSVIS_ebsvis.env

# Copy patches to a staging area:
mkdir -p /u01/install/patches/ad_txk
cp /u01/install/media/patches/p<AD_patch>.zip /u01/install/patches/ad_txk/
cp /u01/install/media/patches/p<TXK_patch>.zip /u01/install/patches/ad_txk/

# Apply using adop hotpatch mode (no downtime required):
adop phase=apply \
  patches=<AD_patch>,<TXK_patch> \
  apply_mode=hotpatch \
  patchtop=/u01/install/patches/ad_txk

# After apply, verify versions updated:
sqlplus apps/<password>@VIS -S << 'EOF'
SELECT abbreviation, patch_level FROM ad_trackable_entities
WHERE abbreviation IN ('ad','txk');
EOF
\`\`\`

---

## Phase 7 — Startup and Shutdown Reference

### Start All Services

\`\`\`bash
# 1. Start database listener:
su - oracle
lsnrctl start

# 2. Start database:
sqlplus / as sysdba << 'EOF'
STARTUP;
EOF

# 3. Start application tier:
su - applmgr
source /u01/oracle/VIS/fs1/EBSapps/appl/APPSVIS_ebsvis.env
\$ADMIN_SCRIPTS_HOME/adstrtal.sh apps/<apps_password>
\`\`\`

### Stop All Services

\`\`\`bash
# 1. Stop application tier first:
su - applmgr
source /u01/oracle/VIS/fs1/EBSapps/appl/APPSVIS_ebsvis.env
\$ADMIN_SCRIPTS_HOME/adstpall.sh apps/<apps_password>

# 2. Stop database:
su - oracle
sqlplus / as sysdba << 'EOF'
SHUTDOWN IMMEDIATE;
EOF

# 3. Stop listener:
lsnrctl stop
\`\`\`

### Systemd Service Unit (Optional)

\`\`\`ini
# /etc/systemd/system/ebs-vis.service
[Unit]
Description=Oracle E-Business Suite VIS
After=network.target

[Service]
Type=forking
User=applmgr
Environment=ORACLE_SID=VIS
ExecStart=/u01/oracle/VIS/fs1/EBSapps/appl/admin/scripts/adstrtal.sh apps/CHANGEME
ExecStop=/u01/oracle/VIS/fs1/EBSapps/appl/admin/scripts/adstpall.sh apps/CHANGEME
TimeoutStartSec=600
TimeoutStopSec=300
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
\`\`\`

---

## Troubleshooting Reference

| Symptom | Where to Look | Fix |
|---------|--------------|-----|
| rapidwiz stops at WebLogic install | \`/tmp/InstallActions*.log\` | Free \`/tmp\` to > 4 GB; check write permissions |
| Database creation fails ORA-01501 | DB creation log in \`\$STAGE/.../logs/\` | Check \`/u01\` disk space; check kernel.shmmax |
| Vision data load fails ORA-12704 | DB load log | Database not created with AL32UTF8 — reinstall |
| AutoConfig fails | \`\$INST_TOP/admin/log/\` | Check context file hostname matches \`hostname -f\` |
| OHS does not start | \`\$LOG_HOME/ora/.../error_log\` | Run \`adautocfg.sh\` to regenerate httpd.conf |
| WLS Admin Server crash on start | \`AdminServer/logs/AdminServer.log\` | Check JVM heap: edit \`setDomainEnv.sh\`, add \`-Xmx2g\` |
| Concurrent Manager ORA-01017 | ICM log in \`\$APPLCSF/\$APPLLOG\` | APPS password mismatch — update context file, run AutoConfig |
| Forms session fails to launch | Browser Java console | Install JRE 8u361; add EBS URL to Java Exception Site List |
| \`adop\` fails: edition not found | adop log | Run: \`\$AD_TOP/patch/115/sql/adzderedition.sql\` |
| Invalid objects > 500 | \`dba_objects\` query | Run: \`EXEC UTL_RECOMP.recomp_parallel(8);\` |`,
};

async function main() {
  console.log('Inserting EBS 12.2.9 Vision Install runbook...');
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
