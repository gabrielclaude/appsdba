import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS 12.2.11 on RHEL 9: Installation, Data Guard, Mid-Tier Replication, and DR Runbook',
  slug: 'oracle-ebs-12211-rhel9-dr-runbook',
  excerpt:
    'Step-by-step runbook for Oracle E-Business Suite 12.2.11 on RHEL 9 — OS prerequisites, Oracle 19c database install, EBS RapidInstall, Data Guard physical standby configuration, mid-tier rsync replication scripts, DR switchover and failover procedures, post-failover AutoConfig automation, and crontab monitoring scripts for Data Guard lag, rsync freshness, and EBS service health.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-25'),
  youtubeUrl: null,
  content: `## Overview

This runbook covers the end-to-end procedure for Oracle E-Business Suite 12.2.11 on RHEL 9: operating system preparation, Oracle 19c database installation, EBS RapidInstall, post-install configuration, Oracle Data Guard physical standby for the database tier, rsync-based mid-tier replication, DR test procedures (switchover and failover), post-failover recovery automation, and operational monitoring scripts.

**Environment assumptions**:
- Primary DB host: \`prod-db.internal.example.com\`
- Primary App host: \`prod-app.internal.example.com\`
- Standby DB host: \`dr-db.internal.example.com\`
- DR App host: \`dr-app.internal.example.com\`
- EBS application name (SID): \`VIS\`
- Oracle base: \`/u01/oracle\`
- EBS RapidInstall staging: \`/stage/ebs_12211\`

---

## Phase 1: RHEL 9 OS Prerequisites

Perform on both primary and DR hosts (DB and app tiers).

### 1.1 Install Required Packages

\`\`\`bash
# Oracle 19c database prerequisites
dnf install -y gcc gcc-c++ make binutils glibc-devel libaio libaio-devel \\
  libstdc++ libstdc++-devel sysstat ksh pdksh compat-openssl11 \\
  libX11 libXau libXi libXtst libgcc libxcb elfutils-libelf \\
  elfutils-libelf-devel fontconfig-devel libxkbcommon xorg-x11-xauth \\
  readline readline-devel unzip zip

# EBS 12.2.11 additional prerequisites
dnf install -y libnsl2 libnsl2-devel libXrender libXrandr \\
  compat-libcap1 compat-libstdc++-33 motif motif-devel \\
  redhat-lsb-core bc psmisc net-tools

# Python 3 compatibility — EBS tooling expects /usr/bin/python
alternatives --set python /usr/bin/python3
python --version   # must show Python 3.x

# Verify libnsl2 is present
ldconfig -p | grep libnsl
\`\`\`

### 1.2 Kernel Parameters

\`\`\`bash
cat >> /etc/sysctl.d/99-oracle-ebs.conf << 'EOF'
fs.file-max = 6815744
fs.aio-max-nr = 1048576
kernel.shmall = 2097152
kernel.shmmax = 4294967295
kernel.shmmni = 4096
kernel.sem = 250 32000 100 128
net.ipv4.ip_local_port_range = 9000 65500
net.core.rmem_default = 262144
net.core.rmem_max = 4194304
net.core.wmem_default = 262144
net.core.wmem_max = 1048576
EOF

sysctl --system
\`\`\`

### 1.3 User Limits

\`\`\`bash
cat >> /etc/security/limits.d/99-oracle-ebs.conf << 'EOF'
oracle  soft  nofile   131072
oracle  hard  nofile   131072
oracle  soft  nproc    131072
oracle  hard  nproc    131072
oracle  soft  stack    10240
oracle  hard  stack    32768
oracle  soft  memlock  134217728
oracle  hard  memlock  134217728
EOF
\`\`\`

### 1.4 Create Oracle and applmgr Users

\`\`\`bash
groupadd -g 54321 oinstall
groupadd -g 54322 dba
groupadd -g 54323 oper
groupadd -g 54324 backupdba
groupadd -g 54325 dgdba
groupadd -g 54326 kmdba
groupadd -g 54327 asmdba

useradd -u 54321 -g oinstall -G dba,oper,backupdba,dgdba,kmdba -d /home/oracle -s /bin/bash oracle
useradd -u 54322 -g oinstall -G dba -d /home/applmgr -s /bin/bash applmgr

passwd oracle
passwd applmgr

mkdir -p /u01/oracle
chown -R oracle:oinstall /u01
chmod -R 775 /u01
\`\`\`

### 1.5 Disable SELinux and Transparent Huge Pages

\`\`\`bash
# Disable SELinux (required for EBS)
sed -i 's/^SELINUX=.*/SELINUX=disabled/' /etc/selinux/config
setenforce 0

# Disable Transparent Huge Pages
cat >> /etc/rc.d/rc.local << 'EOF'
if test -f /sys/kernel/mm/transparent_hugepage/enabled; then
  echo never > /sys/kernel/mm/transparent_hugepage/enabled
fi
if test -f /sys/kernel/mm/transparent_hugepage/defrag; then
  echo never > /sys/kernel/mm/transparent_hugepage/defrag
fi
EOF
chmod +x /etc/rc.d/rc.local
systemctl enable rc-local

echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag
\`\`\`

### 1.6 Configure Firewall Ports

\`\`\`bash
# EBS application tier ports
firewall-cmd --permanent --add-port=443/tcp    # HTTPS
firewall-cmd --permanent --add-port=4443/tcp   # EBS alternate HTTPS
firewall-cmd --permanent --add-port=8000/tcp   # oacore (OA Framework)
firewall-cmd --permanent --add-port=8200/tcp   # oapls (PL/SQL gateway)
firewall-cmd --permanent --add-port=8400/tcp   # oafm (OA Framework utilities)
firewall-cmd --permanent --add-port=9000/tcp   # Forms Server
firewall-cmd --permanent --add-port=7001/tcp   # WebLogic AdminServer (internal)

# Oracle listener
firewall-cmd --permanent --add-port=1521/tcp

# Data Guard redo transport
firewall-cmd --permanent --add-port=1521/tcp

firewall-cmd --reload
firewall-cmd --list-ports
\`\`\`

---

## Phase 2: Oracle 19c Database Installation (Primary DB Host)

### 2.1 Environment Setup for Oracle User

\`\`\`bash
su - oracle
cat >> ~/.bash_profile << 'EOF'
export ORACLE_BASE=/u01/oracle
export ORACLE_HOME=\${ORACLE_BASE}/product/19.3.0/dbhome_1
export ORACLE_SID=VIS
export PATH=\${ORACLE_HOME}/bin:\${PATH}
export LD_LIBRARY_PATH=\${ORACLE_HOME}/lib:\${LD_LIBRARY_PATH}
export NLS_LANG=AMERICAN_AMERICA.AL32UTF8
EOF
source ~/.bash_profile
\`\`\`

### 2.2 Install Oracle 19c Database Software (Silent)

\`\`\`bash
mkdir -p \${ORACLE_HOME}
cd \${ORACLE_HOME}
unzip /stage/LINUX.X64_193000_db_home.zip

./runInstaller -silent -ignorePrereqFailure \\
  oracle.install.option=INSTALL_DB_SWONLY \\
  ORACLE_BASE=\${ORACLE_BASE} \\
  ORACLE_HOME=\${ORACLE_HOME} \\
  oracle.install.db.InstallEdition=EE \\
  oracle.install.db.OSDBA_GROUP=dba \\
  oracle.install.db.OSOPER_GROUP=oper \\
  oracle.install.db.OSBACKUPDBA_GROUP=backupdba \\
  oracle.install.db.OSDGDBA_GROUP=dgdba \\
  oracle.install.db.OSKMDBA_GROUP=kmdba \\
  DECLINE_SECURITY_UPDATES=true

# Run root scripts as root
/u01/oracle/oraInventory/orainstRoot.sh
\${ORACLE_HOME}/root.sh
\`\`\`

### 2.3 Apply Latest Oracle 19c RU (Release Update)

\`\`\`bash
# Apply Oracle 19c RU patch (e.g., 19.22) before creating the EBS database
# EBS requires the EBS-certified RU — check MOS Note 1967243.1 for certified combinations

cd /stage/patches
\${ORACLE_HOME}/OPatch/opatch prereq CheckConflictAgainstOHWithDetail -ph ./37016174
\${ORACLE_HOME}/OPatch/opatch apply -silent -oh \${ORACLE_HOME} ./37016174

# Verify patch applied
\${ORACLE_HOME}/OPatch/opatch lspatches
\`\`\`

### 2.4 Create the EBS Database Using DBCA

EBS requires a specific database configuration. Use the EBS-provided Database Template or create manually:

\`\`\`bash
dbca -silent -createDatabase \\
  -templateName General_Purpose.dbc \\
  -gdbName VIS \\
  -sid VIS \\
  -responseFile NO_VALUE \\
  -characterSet AL32UTF8 \\
  -sysPassword <sys_password> \\
  -systemPassword <system_password> \\
  -createAsContainerDatabase false \\
  -databaseType MULTIPURPOSE \\
  -automaticMemoryManagement false \\
  -totalMemory 16384 \\
  -datafileDestination /u01/oracle/oradata \\
  -recoveryAreaDestination /u01/oracle/fast_recovery_area \\
  -recoveryAreaSize 51200 \\
  -storageType FS \\
  -initParams "db_name=VIS,db_unique_name=VIS_PRIMARY,log_archive_format=%t_%s_%r.arc,\\
    enable_goldengate_replication=false,db_block_size=8192,\\
    db_files=1000,processes=500,open_cursors=500,\\
    undo_management=AUTO,undo_tablespace=UNDOTBS1,\\
    log_archive_dest_1='LOCATION=/u01/oracle/archive'" \\
  -redoLogFileSize 512 \\
  -enableArchive true
\`\`\`

---

## Phase 3: EBS 12.2.11 RapidInstall

### 3.1 Stage EBS 12.2.11 Media

\`\`\`bash
# Unzip EBS 12.2.11 Rapid Install media to staging area
mkdir -p /stage/ebs_12211
cd /stage/ebs_12211
# Unzip all zip files from Oracle eDelivery:
# V1009609-01.zip (Disk 1), V1009610-01.zip (Disk 2), etc.
unzip -o V1009609-01.zip
unzip -o V1009610-01.zip
# Continue for all disk archives...

# Verify startCD exists
ls /stage/ebs_12211/startCD/Disk1/rapidwiz/
\`\`\`

### 3.2 Run RapidInstall (Wizard Mode)

\`\`\`bash
su - oracle
export DISPLAY=<workstation>:0.0
xhost + <prod-app-host>

cd /stage/ebs_12211/startCD/Disk1/rapidwiz/
./rapidwiz
\`\`\`

RapidInstall prompts:
1. **Install Type**: Fresh Install
2. **Database Type**: Oracle 19c — point to existing database (VIS)
3. **Application Tier Nodes**: single-node (scale-out later)
4. **Port Pool**: accept defaults (pool 0) or assign pool number if port conflicts
5. **Install directory**: \`/u01/oracle/VIS\`
6. **DB hostname/port/SID**: \`prod-db.internal.example.com / 1521 / VIS\`

RapidInstall takes 3–6 hours for a fresh install. Monitor progress:
\`\`\`bash
tail -f /u01/oracle/VIS/fs1/EBSapps/log/install/rapid_install.log
\`\`\`

### 3.3 Post-Install Validation

\`\`\`bash
su - applmgr
source /u01/oracle/VIS/EBSapps.env run

# Check all services started
$ADMIN_SCRIPTS_HOME/adstrtal.sh apps/<apps_password>

# Verify WebLogic services
ps -ef | grep -E "weblogic|java" | grep -v grep

# Verify Oracle HTTP Server
ps -ef | grep httpd | grep -v grep

# Test EBS login URL
curl -k -s -o /dev/null -w "%{http_code}" https://prod-app.internal.example.com:4443/OA_HTML/AppsLocalLogin.jsp
# Expect: 200
\`\`\`

### 3.4 Apply EBS Technology Codelevel Patches

After RapidInstall, apply the latest EBS 12.2.11 technology stack patches per MOS Note 1594274.1:

\`\`\`bash
# Source the run filesystem
source /u01/oracle/VIS/EBSapps.env run

# Run adop prepare (required before applying patches via adop)
adop phase=prepare

# Apply patches using adop
adop phase=apply patching_mode=online patches=<patch_number>

# Complete the patch cycle
adop phase=finalize
adop phase=cutover
adop phase=cleanup
\`\`\`

---

## Phase 4: Oracle Data Guard Physical Standby Configuration

### 4.1 Enable Supplemental Logging and Archive on Primary

\`\`\`bash
su - oracle   # On prod-db

sqlplus / as sysdba << 'EOF'
-- Verify archivelog mode
SELECT LOG_MODE FROM V\$DATABASE;

-- If not in archivelog mode:
-- SHUTDOWN IMMEDIATE;
-- STARTUP MOUNT;
-- ALTER DATABASE ARCHIVELOG;
-- ALTER DATABASE OPEN;

-- Enable forced logging (required for Data Guard)
ALTER DATABASE FORCE LOGGING;
SELECT FORCE_LOGGING FROM V\$DATABASE;

-- Configure archive log destination for local and standby
ALTER SYSTEM SET LOG_ARCHIVE_DEST_1=
  'LOCATION=/u01/oracle/archive VALID_FOR=(ALL_LOGFILES,ALL_ROLES) DB_UNIQUE_NAME=VIS_PRIMARY'
  SCOPE=BOTH SID='*';

ALTER SYSTEM SET LOG_ARCHIVE_DEST_2=
  'SERVICE=VIS_STANDBY ASYNC NOAFFIRM VALID_FOR=(ONLINE_LOGFILES,PRIMARY_ROLE) DB_UNIQUE_NAME=VIS_STANDBY'
  SCOPE=BOTH SID='*';

ALTER SYSTEM SET LOG_ARCHIVE_DEST_STATE_2=ENABLE SCOPE=BOTH SID='*';

-- Data Guard broker and redo transport parameters
ALTER SYSTEM SET LOG_ARCHIVE_CONFIG='DG_CONFIG=(VIS_PRIMARY,VIS_STANDBY)' SCOPE=BOTH SID='*';
ALTER SYSTEM SET FAL_SERVER=VIS_STANDBY SCOPE=BOTH SID='*';
ALTER SYSTEM SET FAL_CLIENT=VIS_PRIMARY SCOPE=BOTH SID='*';
ALTER SYSTEM SET STANDBY_FILE_MANAGEMENT=AUTO SCOPE=BOTH SID='*';
ALTER SYSTEM SET DB_FILE_NAME_CONVERT='/u01/oracle/oradata/VIS','/u01/oracle/oradata/VIS' SCOPE=SPFILE SID='*';
ALTER SYSTEM SET LOG_FILE_NAME_CONVERT='/u01/oracle/oradata/VIS','/u01/oracle/oradata/VIS' SCOPE=SPFILE SID='*';

-- Add standby redo logs (size must match online redo logs)
-- First check current redo log size:
SELECT GROUP#, BYTES/1048576 MB FROM V\$LOG;
-- Then add standby redo logs (one more group than online redo log groups):
ALTER DATABASE ADD STANDBY LOGFILE GROUP 4 '/u01/oracle/oradata/VIS/standby_redo04.log' SIZE 512M;
ALTER DATABASE ADD STANDBY LOGFILE GROUP 5 '/u01/oracle/oradata/VIS/standby_redo05.log' SIZE 512M;
ALTER DATABASE ADD STANDBY LOGFILE GROUP 6 '/u01/oracle/oradata/VIS/standby_redo06.log' SIZE 512M;
ALTER DATABASE ADD STANDBY LOGFILE GROUP 7 '/u01/oracle/oradata/VIS/standby_redo07.log' SIZE 512M;
EXIT;
EOF
\`\`\`

### 4.2 Configure TNS for Primary and Standby

On both primary and standby DB hosts (\`\${ORACLE_HOME}/network/admin/tnsnames.ora\`):

\`\`\`
VIS_PRIMARY =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = prod-db.internal.example.com)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = VIS)
      (UR = A)
    )
  )

VIS_STANDBY =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = dr-db.internal.example.com)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = VIS)
      (UR = A)
    )
  )
\`\`\`

### 4.3 Install Oracle 19c Software on Standby DB Host

Repeat Phase 2.1 and 2.2 on \`dr-db\` — install Oracle 19c database software only (do not create a database). Apply the same RU patch as the primary.

### 4.4 Create Standby Database via RMAN Active Duplication

\`\`\`bash
# On dr-db as oracle user
# First ensure listener is running on dr-db:
lsnrctl start

# On prod-db, run RMAN active duplication to create standby
su - oracle   # On prod-db

rman TARGET sys/<sys_password>@VIS_PRIMARY AUXILIARY sys/<sys_password>@VIS_STANDBY << 'EOF'
DUPLICATE TARGET DATABASE
  FOR STANDBY
  FROM ACTIVE DATABASE
  DORECOVER
  SPFILE
    SET DB_UNIQUE_NAME='VIS_STANDBY'
    SET LOG_ARCHIVE_DEST_1='LOCATION=/u01/oracle/archive VALID_FOR=(ALL_LOGFILES,ALL_ROLES) DB_UNIQUE_NAME=VIS_STANDBY'
    SET LOG_ARCHIVE_DEST_2='SERVICE=VIS_PRIMARY ASYNC NOAFFIRM VALID_FOR=(ONLINE_LOGFILES,PRIMARY_ROLE) DB_UNIQUE_NAME=VIS_PRIMARY'
    SET FAL_SERVER='VIS_PRIMARY'
    SET FAL_CLIENT='VIS_STANDBY'
    SET LOG_ARCHIVE_CONFIG='DG_CONFIG=(VIS_PRIMARY,VIS_STANDBY)'
    NOFILENAMECHECK;
EOF
\`\`\`

### 4.5 Start Managed Recovery on Standby

\`\`\`bash
# On dr-db
sqlplus / as sysdba << 'EOF'
-- Start redo apply
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE USING CURRENT LOGFILE DISCONNECT FROM SESSION;

-- Verify apply is running
SELECT PROCESS, STATUS, THREAD#, SEQUENCE#, BLOCK#, BLOCKS
FROM V\$MANAGED_STANDBY
WHERE PROCESS IN ('MRP0','RFS');

-- Check apply lag
SELECT NAME, VALUE, DATUM_TIME
FROM V\$DATAGUARD_STATS
WHERE NAME IN ('apply lag','transport lag','redo apply rate');
EXIT;
EOF
\`\`\`

### 4.6 Configure Data Guard Broker (Optional but Recommended)

\`\`\`bash
# On primary DB
sqlplus / as sysdba << 'EOF'
ALTER SYSTEM SET DG_BROKER_START=TRUE SCOPE=BOTH;
EXIT;
EOF

# On standby DB
sqlplus / as sysdba << 'EOF'
ALTER SYSTEM SET DG_BROKER_START=TRUE SCOPE=BOTH;
EXIT;
EOF

# Connect to broker on primary
dgmgrl sys/<sys_password>@VIS_PRIMARY << 'EOF'
CREATE CONFIGURATION vis_dg AS
  PRIMARY DATABASE IS VIS_PRIMARY
  CONNECT IDENTIFIER IS VIS_PRIMARY;

ADD DATABASE VIS_STANDBY AS
  CONNECT IDENTIFIER IS VIS_STANDBY
  MAINTAINED AS PHYSICAL;

ENABLE CONFIGURATION;

-- Verify
SHOW CONFIGURATION;
SHOW DATABASE VERBOSE VIS_PRIMARY;
SHOW DATABASE VERBOSE VIS_STANDBY;
EOF
\`\`\`

---

## Phase 5: Mid-Tier rsync Replication

### 5.1 SSH Key Setup Between App Hosts

\`\`\`bash
# On prod-app as applmgr
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""
ssh-copy-id -i ~/.ssh/id_ed25519.pub applmgr@dr-app.internal.example.com

# Test passwordless SSH
ssh applmgr@dr-app.internal.example.com "hostname"
\`\`\`

### 5.2 Mid-Tier rsync Script

Create \`/home/applmgr/scripts/sync_midtier_to_dr.sh\`:

\`\`\`bash
#!/bin/bash
# Mid-tier rsync from primary to DR application server
# Run ONLY after adop cleanup completes — never during adop apply or finalize

EBS_BASE="/u01/oracle/VIS"
DR_HOST="applmgr@dr-app.internal.example.com"
LOG_DIR="/home/applmgr/logs"
LOG_FILE="\${LOG_DIR}/midtier_sync_\$(date +%Y%m%d_%H%M%S).log"
LOCK_FILE="/tmp/midtier_sync.lock"

mkdir -p "\${LOG_DIR}"

# Prevent concurrent runs
if [ -f "\${LOCK_FILE}" ]; then
  echo "\$(date): sync already in progress (lock file \${LOCK_FILE} exists)" >> "\${LOG_FILE}"
  exit 1
fi
touch "\${LOCK_FILE}"
trap "rm -f \${LOCK_FILE}" EXIT

exec >> "\${LOG_FILE}" 2>&1
echo "=== Mid-Tier rsync started: \$(date) ==="

# Check no adop is running before proceeding
if ps -ef | grep -E 'adop|adopworker' | grep -v grep > /dev/null 2>&1; then
  echo "ERROR: adop process detected — aborting rsync to avoid partial filesystem copy"
  exit 2
fi

RSYNC_OPTS="-avz --delete --checksum --exclude='*/tmp/' --exclude='*/cache/' --exclude='*/servers/*/logs/' --stats"

sync_dir() {
  local SRC="\$1"
  local DST="\$2"
  echo "--- Syncing \${SRC} ---"
  rsync \${RSYNC_OPTS} "\${EBS_BASE}/\${SRC}/" "\${DR_HOST}:\${EBS_BASE}/\${DST}/"
  local RC=\$?
  if [ \$RC -ne 0 ]; then
    echo "ERROR: rsync failed for \${SRC} (exit code \${RC})"
  else
    echo "OK: \${SRC} sync complete"
  fi
}

# Sync both filesystems (fs1 and fs2 — RUN and PATCH)
sync_dir "fs1/EBSapps"  "fs1/EBSapps"
sync_dir "fs2/EBSapps"  "fs2/EBSapps"
sync_dir "fs1/FMW"      "fs1/FMW"
sync_dir "fs2/FMW"      "fs2/FMW"
sync_dir "fs_ne/inst"   "fs_ne/inst"

# Sync CUSTOM_TOP if it exists outside fs1/fs2
if [ -d "\${EBS_BASE}/custom" ]; then
  sync_dir "custom" "custom"
fi

# Record sync timestamp for freshness monitoring
date +%s > /home/applmgr/.last_midtier_sync
echo "\$(date): sync completed successfully" >> /home/applmgr/.last_midtier_sync

echo "=== Mid-Tier rsync completed: \$(date) ==="
\`\`\`

\`\`\`bash
chmod 750 /home/applmgr/scripts/sync_midtier_to_dr.sh
\`\`\`

### 5.3 Post-Rsync AutoConfig on DR App Tier

After every rsync, AutoConfig must be run on the DR application tier with the DR context file. Create \`/home/applmgr/scripts/dr_autoconfig.sh\` on \`dr-app\`:

\`\`\`bash
#!/bin/bash
# Run AutoConfig on DR application tier after receiving rsync
# This overwrites primary-specific config with DR-specific config

EBS_BASE="/u01/oracle/VIS"
LOG_DIR="/home/applmgr/logs"
LOG_FILE="\${LOG_DIR}/dr_autoconfig_\$(date +%Y%m%d_%H%M%S).log"

mkdir -p "\${LOG_DIR}"
exec >> "\${LOG_FILE}" 2>&1
echo "=== DR AutoConfig started: \$(date) ==="

# Determine which filesystem is RUN on the DR server
# (After rsync, fs_ne/inst contains the primary's context file — we need the DR context file)
source \${EBS_BASE}/EBSapps.env run

# The DR context file should be pre-configured for the DR environment
# It must point to dr-db.internal.example.com as the database host
DR_CONTEXT="\${EBS_BASE}/fs_ne/inst/\${TWO_TASK}/appl/admin/\${TWO_TASK}.xml"

# Verify the context file references the DR database host
if grep -q "prod-db.internal.example.com" "\${DR_CONTEXT}"; then
  echo "WARNING: DR context file still references prod-db — context update required"
  # Update context file: replace primary DB host with DR DB host
  sed -i 's/prod-db\.internal\.example\.com/dr-db.internal.example.com/g' "\${DR_CONTEXT}"
  echo "Context file updated to reference dr-db"
fi

# Run AutoConfig
echo "Running AutoConfig with context file: \${DR_CONTEXT}"
perl \${AD_TOP}/bin/adconfig.pl \\
  contextfile=\${DR_CONTEXT} \\
  apply=yes \\
  run=INSTE8 \\
  logfile=\${LOG_DIR}/adconfig_\$(date +%Y%m%d_%H%M%S).log

if [ \$? -eq 0 ]; then
  echo "AutoConfig completed successfully"
  date +%s > /home/applmgr/.last_dr_autoconfig
else
  echo "ERROR: AutoConfig failed — check log for details"
  exit 1
fi

echo "=== DR AutoConfig completed: \$(date) ==="
\`\`\`

---

## Phase 6: DR Test Procedures

### 6.1 Pre-Test Checklist

Before any DR test:
- [ ] Notify all EBS users (scheduled maintenance window)
- [ ] Confirm rsync has run after the most recent adop cleanup
- [ ] Verify Data Guard standby is in SYNC with primary (apply lag = 0)
- [ ] Confirm RMAN backup of primary DB is current
- [ ] Confirm DR app tier AutoConfig has run post-last-rsync
- [ ] Document primary DB SCN: \`SELECT CURRENT_SCN FROM V\$DATABASE;\`

### 6.2 Planned Switchover Test (Quarterly)

A switchover is a planned, graceful role reversal. No data loss.

**Step 1 — Stop EBS on primary app tier**:
\`\`\`bash
# On prod-app as applmgr
source /u01/oracle/VIS/EBSapps.env run
\$ADMIN_SCRIPTS_HOME/adstpall.sh apps/<apps_password>
\`\`\`

**Step 2 — Switchover primary DB to standby**:
\`\`\`bash
# Via Data Guard Broker on primary DB:
dgmgrl sys/<sys_password>@VIS_PRIMARY << 'EOF'
SWITCHOVER TO VIS_STANDBY;
-- Wait for "Switchover succeeded"
SHOW CONFIGURATION;
-- Primary now shows: VIS_STANDBY - Primary database
-- Standby now shows: VIS_PRIMARY - Physical standby database
EOF
\`\`\`

Alternatively, via SQL*Plus:
\`\`\`bash
# On prod-db (will become standby)
sqlplus / as sysdba << 'EOF'
ALTER DATABASE COMMIT TO SWITCHOVER TO PHYSICAL STANDBY WITH SESSION SHUTDOWN;
ALTER DATABASE MOUNT STANDBY DATABASE;
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE USING CURRENT LOGFILE DISCONNECT;
EXIT;
EOF

# On dr-db (will become primary)
sqlplus / as sysdba << 'EOF'
ALTER DATABASE COMMIT TO SWITCHOVER TO PRIMARY WITH SESSION SHUTDOWN;
ALTER DATABASE OPEN;
EXIT;
EOF
\`\`\`

**Step 3 — Update EBS context file on DR app tier**:
\`\`\`bash
# On dr-app as applmgr
# The context file must point to dr-db as the primary DB
source /u01/oracle/VIS/EBSapps.env run

# Verify context points to dr-db
grep -i "db_host" \${CONTEXT_FILE}

# If still pointing to prod-db:
# Update via adadmin or direct XML edit:
sed -i 's/prod-db\.internal\.example\.com/dr-db.internal.example.com/g' \${CONTEXT_FILE}
\`\`\`

**Step 4 — Run AutoConfig on DR app tier**:
\`\`\`bash
# On dr-app as applmgr
perl \${AD_TOP}/bin/adconfig.pl contextfile=\${CONTEXT_FILE} apply=yes run=INSTE8
\`\`\`

**Step 5 — Start EBS on DR app tier**:
\`\`\`bash
# On dr-app as applmgr
source /u01/oracle/VIS/EBSapps.env run
\$ADMIN_SCRIPTS_HOME/adstrtal.sh apps/<apps_password>
\`\`\`

**Step 6 — Validate EBS on DR site** (see validation checklist in Phase 6.4).

**Step 7 — Switchback** (after test validation):
\`\`\`bash
# Reverse the switchover: DR becomes standby again, primary becomes primary
# Stop EBS on dr-app first, then:
dgmgrl sys/<sys_password>@VIS_STANDBY << 'EOF'
SWITCHOVER TO VIS_PRIMARY;
SHOW CONFIGURATION;
EOF
# Restart EBS on prod-app after switchback completes
\`\`\`

### 6.3 Unplanned Failover Test (Annual)

A failover activates the standby without graceful primary shutdown — simulating an unplanned failure.

**Step 1 — Simulate primary failure** (for testing, simply stop prod-db listener and database):
\`\`\`bash
# On prod-db — simulate failure by stopping database
sqlplus / as sysdba << 'EOF'
SHUTDOWN ABORT;
EXIT;
EOF
\`\`\`

**Step 2 — Activate standby**:
\`\`\`bash
# Via Data Guard Broker on dr-db:
dgmgrl sys/<sys_password>@VIS_STANDBY << 'EOF'
-- With broker:
FAILOVER TO VIS_STANDBY;
-- Or in data loss prevention mode:
-- FAILOVER TO VIS_STANDBY IMMEDIATE;
SHOW CONFIGURATION;
EOF
\`\`\`

Without broker:
\`\`\`bash
# On dr-db
sqlplus / as sysdba << 'EOF'
-- Cancel managed recovery
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE CANCEL;
-- Apply any available archived logs
ALTER DATABASE RECOVER STANDBY DATABASE;
-- Activate standby
ALTER DATABASE ACTIVATE PHYSICAL STANDBY DATABASE;
-- Open database
ALTER DATABASE OPEN RESETLOGS;
EXIT;
EOF
\`\`\`

**Step 3 through 6**: Same as switchover test (Steps 3–6 above).

**Step 7 — Post-failover: re-establish Data Guard** (after DR test completes):
After a failover test, the former primary (prod-db) is not automatically re-integrated. To re-establish the standby relationship after the test:
\`\`\`bash
# Flashback prod-db to before failover (if Flashback Database is enabled):
sqlplus / as sysdba << 'EOF'   -- On prod-db
STARTUP MOUNT;
FLASHBACK DATABASE TO SCN <pre-failover-scn>;
EXIT;
EOF

# Convert prod-db back to standby:
# On prod-db:
sqlplus / as sysdba << 'EOF'
ALTER DATABASE CONVERT TO PHYSICAL STANDBY;
ALTER DATABASE MOUNT STANDBY DATABASE;
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE USING CURRENT LOGFILE DISCONNECT;
EXIT;
EOF
\`\`\`

If Flashback Database is not enabled, re-create the standby from scratch using RMAN active duplication (Phase 4.4).

### 6.4 DR Validation Checklist

A DR test is not complete until all of the following pass:

\`\`\`
[ ] EBS login page accessible at DR URL
[ ] User can log in with production credentials
[ ] Navigate to key module (e.g. Payables → Invoices or GL → Journals)
[ ] Submit a Concurrent Program and confirm it runs to Completed/Normal
[ ] Create a representative transaction (invoice, PO, or journal entry)
[ ] Confirm the transaction posts/completes without errors
[ ] Check Concurrent Manager status: all managers show "Running"
[ ] Check Workflow Mailer status (if in use): running or intentionally stopped
[ ] Verify Workflow Background Process is running
[ ] Integration endpoints: document which are connected vs. need re-pointing
[ ] Record actual failover duration for each step (for RTO documentation)
\`\`\`

---

## Phase 7: Systemd Service Units

### 7.1 EBS Services Systemd Unit

Create \`/etc/systemd/system/ebs-appstier.service\`:

\`\`\`ini
[Unit]
Description=Oracle E-Business Suite Application Tier
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
User=applmgr
Group=oinstall
Environment="ORACLE_BASE=/u01/oracle"
Environment="EBS_BASE=/u01/oracle/VIS"
ExecStart=/home/applmgr/scripts/ebs_start.sh
ExecStop=/home/applmgr/scripts/ebs_stop.sh
TimeoutStartSec=600
TimeoutStopSec=300
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
\`\`\`

Create \`/home/applmgr/scripts/ebs_start.sh\`:

\`\`\`bash
#!/bin/bash
source /u01/oracle/VIS/EBSapps.env run
\$ADMIN_SCRIPTS_HOME/adstrtal.sh apps/<apps_password> <<< ""
\`\`\`

Create \`/home/applmgr/scripts/ebs_stop.sh\`:

\`\`\`bash
#!/bin/bash
source /u01/oracle/VIS/EBSapps.env run
\$ADMIN_SCRIPTS_HOME/adstpall.sh apps/<apps_password> <<< ""
\`\`\`

\`\`\`bash
chmod 750 /home/applmgr/scripts/ebs_start.sh /home/applmgr/scripts/ebs_stop.sh
systemctl daemon-reload
systemctl enable ebs-appstier
\`\`\`

---

## Phase 8: Monitoring Scripts

### 8.1 Data Guard Lag Monitor

Create \`/home/oracle/scripts/check_dg_lag.sh\` (run on primary DB host):

\`\`\`bash
#!/bin/bash
# Monitor Data Guard apply lag and transport lag
# Alerts if lag exceeds thresholds

ORACLE_SID=VIS
ORACLE_HOME=/u01/oracle/product/19.3.0/dbhome_1
PATH=\${ORACLE_HOME}/bin:\${PATH}
export ORACLE_SID ORACLE_HOME PATH

TRANSPORT_WARN_SECS=30
TRANSPORT_CRIT_SECS=120
APPLY_WARN_SECS=60
APPLY_CRIT_SECS=300
LOG_FILE="/home/oracle/logs/dg_lag_\$(date +%Y%m%d).log"

mkdir -p /home/oracle/logs

RESULT=\$(sqlplus -s / as sysdba << 'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT NAME || '|' || VALUE
FROM V\$DATAGUARD_STATS
WHERE NAME IN ('transport lag','apply lag');
EXIT;
EOF
)

if [ -z "\${RESULT}" ]; then
  echo "\$(date): ERROR — could not query V\$DATAGUARD_STATS (not primary or DB down)" | tee -a "\${LOG_FILE}"
  exit 2
fi

TRANSPORT_LAG=0
APPLY_LAG=0

while IFS='|' read -r NAME VALUE; do
  # VALUE format: +DD HH:MI:SS
  if [[ "\${NAME}" == "transport lag" ]]; then
    TRANSPORT_LAG=\$(echo "\${VALUE}" | awk -F'[: +]' '{print (\$2*86400)+(\$3*3600)+(\$4*60)+\$5}' 2>/dev/null || echo 0)
  fi
  if [[ "\${NAME}" == "apply lag" ]]; then
    APPLY_LAG=\$(echo "\${VALUE}" | awk -F'[: +]' '{print (\$2*86400)+(\$3*3600)+(\$4*60)+\$5}' 2>/dev/null || echo 0)
  fi
done <<< "\${RESULT}"

STATUS="OK"
MSG=""

if [ "\${TRANSPORT_LAG}" -ge "\${TRANSPORT_CRIT_SECS}" ]; then
  STATUS="CRITICAL"
  MSG+="Transport lag=\${TRANSPORT_LAG}s exceeds critical threshold (\${TRANSPORT_CRIT_SECS}s). "
elif [ "\${TRANSPORT_LAG}" -ge "\${TRANSPORT_WARN_SECS}" ]; then
  [ "\${STATUS}" != "CRITICAL" ] && STATUS="WARNING"
  MSG+="Transport lag=\${TRANSPORT_LAG}s exceeds warning threshold (\${TRANSPORT_WARN_SECS}s). "
fi

if [ "\${APPLY_LAG}" -ge "\${APPLY_CRIT_SECS}" ]; then
  STATUS="CRITICAL"
  MSG+="Apply lag=\${APPLY_LAG}s exceeds critical threshold (\${APPLY_CRIT_SECS}s). "
elif [ "\${APPLY_LAG}" -ge "\${APPLY_WARN_SECS}" ]; then
  [ "\${STATUS}" != "CRITICAL" ] && STATUS="WARNING"
  MSG+="Apply lag=\${APPLY_LAG}s exceeds warning threshold (\${APPLY_WARN_SECS}s). "
fi

LOG_LINE="\$(date): STATUS=\${STATUS} transport_lag=\${TRANSPORT_LAG}s apply_lag=\${APPLY_LAG}s \${MSG}"
echo "\${LOG_LINE}" >> "\${LOG_FILE}"

if [ "\${STATUS}" != "OK" ]; then
  echo "\${LOG_LINE}"
  # Uncomment to email alert:
  # echo "\${LOG_LINE}" | mail -s "DG Lag \${STATUS}: VIS" dba-alerts@example.com
  exit 1
fi

echo "\$(date): Data Guard OK — transport_lag=\${TRANSPORT_LAG}s apply_lag=\${APPLY_LAG}s" >> "\${LOG_FILE}"
\`\`\`

### 8.2 Rsync Freshness Monitor

Create \`/home/applmgr/scripts/check_sync_freshness.sh\` (run on DR app host):

\`\`\`bash
#!/bin/bash
# Monitor how long ago the mid-tier rsync last completed
# Alerts if rsync is overdue based on configured maximum age

SYNC_TIMESTAMP_FILE="/home/applmgr/.last_midtier_sync"
MAX_SYNC_AGE_HOURS=24   # Alert if rsync is older than this
LOG_FILE="/home/applmgr/logs/sync_freshness_\$(date +%Y%m%d).log"
mkdir -p /home/applmgr/logs

if [ ! -f "\${SYNC_TIMESTAMP_FILE}" ]; then
  MSG="ERROR: sync timestamp file not found — rsync has never completed or file is missing"
  echo "\$(date): \${MSG}" | tee -a "\${LOG_FILE}"
  exit 2
fi

LAST_SYNC_EPOCH=\$(head -1 "\${SYNC_TIMESTAMP_FILE}")
CURRENT_EPOCH=\$(date +%s)
AGE_SECS=\$(( CURRENT_EPOCH - LAST_SYNC_EPOCH ))
AGE_HOURS=\$(( AGE_SECS / 3600 ))

LAST_SYNC_DATE=\$(date -d "@\${LAST_SYNC_EPOCH}" '+%Y-%m-%d %H:%M:%S')

if [ "\${AGE_HOURS}" -ge "\${MAX_SYNC_AGE_HOURS}" ]; then
  MSG="CRITICAL: last rsync was \${AGE_HOURS}h ago (\${LAST_SYNC_DATE}) — exceeds \${MAX_SYNC_AGE_HOURS}h threshold"
  echo "\$(date): \${MSG}" | tee -a "\${LOG_FILE}"
  # echo "\${MSG}" | mail -s "EBS DR Rsync Overdue" dba-alerts@example.com
  exit 2
fi

echo "\$(date): rsync freshness OK — last sync \${AGE_HOURS}h ago (\${LAST_SYNC_DATE})" >> "\${LOG_FILE}"
\`\`\`

### 8.3 EBS Service Health Monitor

Create \`/home/applmgr/scripts/check_ebs_services.sh\`:

\`\`\`bash
#!/bin/bash
# Check health of all EBS application tier services
# Returns non-zero if any critical service is down

source /u01/oracle/VIS/EBSapps.env run 2>/dev/null

LOG_FILE="/home/applmgr/logs/ebs_health_\$(date +%Y%m%d).log"
mkdir -p /home/applmgr/logs

ERRORS=0

check_process() {
  local SERVICE_NAME="\$1"
  local PATTERN="\$2"
  if ps -ef | grep -E "\${PATTERN}" | grep -v grep > /dev/null 2>&1; then
    echo "\$(date): OK: \${SERVICE_NAME} is running" >> "\${LOG_FILE}"
  else
    echo "\$(date): ERROR: \${SERVICE_NAME} is NOT running" | tee -a "\${LOG_FILE}"
    ERRORS=\$(( ERRORS + 1 ))
  fi
}

check_http_endpoint() {
  local URL="\$1"
  local EXPECTED_CODE="\$2"
  local DESC="\$3"
  HTTP_CODE=\$(curl -k -s -o /dev/null -w "%{http_code}" --max-time 10 "\${URL}")
  if [ "\${HTTP_CODE}" == "\${EXPECTED_CODE}" ]; then
    echo "\$(date): OK: \${DESC} returned HTTP \${HTTP_CODE}" >> "\${LOG_FILE}"
  else
    echo "\$(date): ERROR: \${DESC} returned HTTP \${HTTP_CODE} (expected \${EXPECTED_CODE})" | tee -a "\${LOG_FILE}"
    ERRORS=\$(( ERRORS + 1 ))
  fi
}

# Check key processes
check_process "Oracle HTTP Server" "httpd.*VIS"
check_process "WebLogic AdminServer" "weblogic.Name=AdminServer"
check_process "WebLogic oacore" "weblogic.Name=oacore"
check_process "WebLogic oafm" "weblogic.Name=oafm"

# Check HTTP endpoints
EBS_HOST=\$(hostname -f)
check_http_endpoint "https://\${EBS_HOST}:4443/OA_HTML/AppsLocalLogin.jsp" "200" "EBS Login Page"

# Check DB connectivity
DB_CHECK=\$(sqlplus -s apps/<apps_password> << 'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT 'DB_OK' FROM DUAL;
EXIT;
EOF
)
if echo "\${DB_CHECK}" | grep -q "DB_OK"; then
  echo "\$(date): OK: Database connectivity to VIS OK" >> "\${LOG_FILE}"
else
  echo "\$(date): ERROR: Cannot connect to VIS database as apps" | tee -a "\${LOG_FILE}"
  ERRORS=\$(( ERRORS + 1 ))
fi

# Check Concurrent Manager status
CM_STATUS=\$(sqlplus -s apps/<apps_password> << 'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT COUNT(*) FROM FND_CONCURRENT_QUEUES
WHERE RUNNING_PROCESSES > 0
AND CONCURRENT_QUEUE_NAME = 'STANDARD';
EXIT;
EOF
)
if [ "\${CM_STATUS}" -gt "0" ] 2>/dev/null; then
  echo "\$(date): OK: Standard Concurrent Manager is running" >> "\${LOG_FILE}"
else
  echo "\$(date): WARNING: Standard Concurrent Manager may not be running (count=\${CM_STATUS})" | tee -a "\${LOG_FILE}"
fi

if [ "\${ERRORS}" -gt "0" ]; then
  echo "\$(date): EBS SERVICE CHECK FAILED — \${ERRORS} error(s) detected" | tee -a "\${LOG_FILE}"
  # echo "EBS service failure on \$(hostname): \${ERRORS} errors" | mail -s "EBS Service Alert" dba-alerts@example.com
  exit 1
fi

echo "\$(date): All EBS services healthy" >> "\${LOG_FILE}"
\`\`\`

### 8.4 RPO Calculator Script

Create \`/home/oracle/scripts/calculate_rpo.sh\` (run on primary DB host):

\`\`\`bash
#!/bin/bash
# Calculate current effective RPO for both DB tier and app tier
# Combines DG lag with rsync freshness for a composite RPO view

ORACLE_SID=VIS
ORACLE_HOME=/u01/oracle/product/19.3.0/dbhome_1
PATH=\${ORACLE_HOME}/bin:\${PATH}
export ORACLE_SID ORACLE_HOME PATH

DR_HOST="applmgr@dr-app.internal.example.com"
LOG_FILE="/home/oracle/logs/rpo_calc_\$(date +%Y%m%d).log"
mkdir -p /home/oracle/logs

echo "=== EBS RPO Calculation: \$(date) ===" | tee -a "\${LOG_FILE}"

# Database tier RPO (from Data Guard apply lag)
DG_LAG=\$(sqlplus -s / as sysdba << 'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT VALUE FROM V\$DATAGUARD_STATS WHERE NAME = 'apply lag';
EXIT;
EOF
)
echo "DB Tier RPO (Data Guard apply lag): \${DG_LAG}" | tee -a "\${LOG_FILE}"

# Application tier RPO (from rsync freshness on DR app server)
SYNC_INFO=\$(ssh \${DR_HOST} "cat /home/applmgr/.last_midtier_sync 2>/dev/null")
if [ -n "\${SYNC_INFO}" ]; then
  LAST_SYNC_EPOCH=\$(echo "\${SYNC_INFO}" | head -1)
  CURRENT_EPOCH=\$(date +%s)
  SYNC_AGE_HOURS=\$(( (CURRENT_EPOCH - LAST_SYNC_EPOCH) / 3600 ))
  SYNC_AGE_MINS=\$(( (CURRENT_EPOCH - LAST_SYNC_EPOCH) / 60 ))
  LAST_SYNC_DATE=\$(date -d "@\${LAST_SYNC_EPOCH}" '+%Y-%m-%d %H:%M:%S')
  echo "App Tier RPO (rsync age): \${SYNC_AGE_HOURS}h \${SYNC_AGE_MINS}m (last sync: \${LAST_SYNC_DATE})" | tee -a "\${LOG_FILE}"
else
  echo "App Tier RPO: UNKNOWN — cannot read sync timestamp from \${DR_HOST}" | tee -a "\${LOG_FILE}"
fi

# Check if app tier and DB tier are in sync (have they diverged?)
LAST_ADOP_CLEANUP=\$(sqlplus -s apps/<apps_password> << 'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT TO_CHAR(MAX(END_DATE),'YYYY-MM-DD HH24:MI:SS')
FROM AD_ADOP_SESSIONS
WHERE STATUS = 'X' AND SESSION_TYPE = 'CLEANUP';
EXIT;
EOF
)
echo "Last adop cleanup: \${LAST_ADOP_CLEANUP}" | tee -a "\${LOG_FILE}"

if [ -n "\${LAST_SYNC_EPOCH}" ] && [ -n "\${LAST_ADOP_CLEANUP}" ]; then
  CLEANUP_EPOCH=\$(date -d "\${LAST_ADOP_CLEANUP}" +%s 2>/dev/null)
  if [ -n "\${CLEANUP_EPOCH}" ] && [ "\${LAST_SYNC_EPOCH}" -lt "\${CLEANUP_EPOCH}" ]; then
    echo "ALERT: adop cleanup occurred after last rsync — DR app tier may be behind DB tier!" | tee -a "\${LOG_FILE}"
  else
    echo "App/DB sync status: OK — rsync is current with adop state" | tee -a "\${LOG_FILE}"
  fi
fi

echo "=== RPO Calculation complete ===" | tee -a "\${LOG_FILE}"
\`\`\`

### 8.5 Crontab Setup

On primary DB host (as oracle):
\`\`\`
# crontab -e
# Data Guard lag check every 5 minutes
*/5 * * * * /home/oracle/scripts/check_dg_lag.sh >> /home/oracle/logs/dg_lag_cron.log 2>&1

# Daily RPO calculation at 07:00
0 7 * * * /home/oracle/scripts/calculate_rpo.sh >> /home/oracle/logs/rpo_calc_cron.log 2>&1
\`\`\`

On primary app host (as applmgr):
\`\`\`
# crontab -e
# Mid-tier rsync at 02:00 daily (post-maintenance window)
# Only runs if no adop is in progress (script self-checks)
0 2 * * * /home/applmgr/scripts/sync_midtier_to_dr.sh

# EBS service health check every 10 minutes
*/10 * * * * /home/applmgr/scripts/check_ebs_services.sh >> /home/applmgr/logs/health_cron.log 2>&1
\`\`\`

On DR app host (as applmgr):
\`\`\`
# crontab -e
# Rsync freshness check every hour
0 * * * * /home/applmgr/scripts/check_sync_freshness.sh >> /home/applmgr/logs/freshness_cron.log 2>&1
\`\`\`

---

## Quick Reference

| Task | Command |
|------|---------|
| Check DG status | \`dgmgrl / SHOW CONFIGURATION\` |
| Check apply lag | \`SELECT NAME,VALUE FROM V\$DATAGUARD_STATS;\` |
| Check MRP0 process | \`SELECT PROCESS,STATUS FROM V\$MANAGED_STANDBY;\` |
| Start redo apply | \`ALTER DATABASE RECOVER MANAGED STANDBY DATABASE USING CURRENT LOGFILE DISCONNECT;\` |
| Stop redo apply | \`ALTER DATABASE RECOVER MANAGED STANDBY DATABASE CANCEL;\` |
| Start EBS | \`\$ADMIN_SCRIPTS_HOME/adstrtal.sh apps/<pass>\` |
| Stop EBS | \`\$ADMIN_SCRIPTS_HOME/adstpall.sh apps/<pass>\` |
| Run AutoConfig | \`perl \${AD_TOP}/bin/adconfig.pl contextfile=\${CONTEXT_FILE} apply=yes run=INSTE8\` |
| Check adop status | \`adop phase=status\` |
| Switch RUN filesystem | Occurs automatically during \`adop phase=cutover\` |
| Run mid-tier rsync | \`/home/applmgr/scripts/sync_midtier_to_dr.sh\` |
| EBS log location | \`/u01/oracle/VIS/fs_ne/log/\` |
| DG broker log | \`\${ORACLE_HOME}/log/<host>/drcVIS.log\` |`,
};

async function main() {
  console.log('Inserting EBS 12.2.11 RHEL 9 runbook...');
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
