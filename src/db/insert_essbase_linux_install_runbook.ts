import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Essbase 21c Standalone Installation on Linux',
  slug: 'essbase-linux-install-runbook',
  excerpt:
    'Step-by-step runbook with shell scripts for installing Oracle Essbase 21c standalone on Oracle Linux — OS prerequisites, kernel parameters, JDK installation, Oracle Database 19c repository setup, RCU schema creation, Essbase silent install, configuration utility, service management, firewall rules, and post-install validation.',
  category: 'essbase' as const,
  published: true,
  publishedAt: new Date('2026-06-02'),
  isPremium: true,
  youtubeUrl: null,
  content: `This runbook covers a production-grade Oracle Essbase 21c standalone installation on Oracle Linux 8. All scripts are designed to be run sequentially from top to bottom with minimal manual steps.

**Hardware minimum for production:**
- 4 CPU cores (8 recommended)
- 32 GB RAM (64 GB recommended for large cubes)
- 500 GB disk for Essbase home, data, and repository DB
- Oracle Linux 8.x or RHEL 8.x (OL8 is recommended — free and fully compatible)

**Software required (download from Oracle eDelivery / My Oracle Support):**
- Oracle Essbase 21c installer (\`Oracle_Essbase_21.x.x_Linux64.zip\`)
- Oracle JDK 11 (\`jdk-11.x.x_linux-x64_bin.rpm\`)
- Oracle Database 19c installer (for the Essbase schema repository)
- Oracle Repository Creation Utility 19.x (\`fmw_19.x.x.x_rcu.jar\`)

---

## Phase 0: System Inventory Check

Run this first to confirm the host meets minimum requirements before touching anything.

\`\`\`bash
#!/bin/bash
# essbase_precheck.sh — system inventory and requirements check
# Run as root or a user with sudo

REPORT="/tmp/essbase_precheck_$(date +%Y%m%d_%H%M%S).txt"
PASS=0; WARN=0; FAIL=0

log()  { echo "$1" | tee -a "$REPORT"; }
pass() { log "  [PASS] $1"; ((PASS++)); }
warn() { log "  [WARN] $1"; ((WARN++)); }
fail() { log "  [FAIL] $1"; ((FAIL++)); }
hr()   { log "$(printf '%.0s-' {1..70})"; }

hr; log "  Oracle Essbase 21c Pre-Install Check"; log "  $(date)"; hr; log ""

# ── CPU ────────────────────────────────────────────────────────────────────
CPUS=$(nproc)
log "[CPU] Physical cores: $CPUS"
[ "$CPUS" -ge 4 ] && pass "CPU cores >= 4 ($CPUS)" || warn "CPU cores < 4 ($CPUS) — minimum met but performance may suffer"

# ── Memory ────────────────────────────────────────────────────────────────
MEM_GB=$(awk '/MemTotal/ {printf "%d", $2/1048576}' /proc/meminfo)
log "[MEM] Total RAM: \${MEM_GB} GB"
[ "$MEM_GB" -ge 32 ] && pass "RAM >= 32 GB (\${MEM_GB} GB)" || \
  { [ "$MEM_GB" -ge 16 ] && warn "RAM < 32 GB (\${MEM_GB} GB) — marginal for production" || \
    fail "RAM < 16 GB (\${MEM_GB} GB) — insufficient"; }

# ── Swap ──────────────────────────────────────────────────────────────────
SWAP_GB=$(awk '/SwapTotal/ {printf "%d", $2/1048576}' /proc/meminfo)
log "[SWAP] Swap: \${SWAP_GB} GB"
[ "$SWAP_GB" -ge 8 ] && pass "Swap >= 8 GB (\${SWAP_GB} GB)" || warn "Swap < 8 GB (\${SWAP_GB} GB)"

# ── Disk space ────────────────────────────────────────────────────────────
log "[DISK]"
for mount in / /u01 /tmp; do
  if mountpoint -q "$mount" 2>/dev/null || [ "$mount" = "/" ]; then
    FREE_GB=$(df -BG "$mount" 2>/dev/null | awk 'NR==2 {gsub("G",""); print $4}')
    log "  $mount: \${FREE_GB} GB free"
  fi
done
TMP_FREE=$(df -BG /tmp | awk 'NR==2 {gsub("G",""); print $4}')
U01_FREE=$(df -BG /u01 2>/dev/null | awk 'NR==2 {gsub("G",""); print $4}' || df -BG / | awk 'NR==2 {gsub("G",""); print $4}')
[ "$TMP_FREE" -ge 5 ]   && pass "/tmp has >= 5 GB free (\${TMP_FREE} GB)" || fail "/tmp < 5 GB free"
[ "$U01_FREE" -ge 100 ] && pass "/u01 (or /) has >= 100 GB free (\${U01_FREE} GB)" || warn "Install target may need more space"

# ── OS version ────────────────────────────────────────────────────────────
OS_REL=$(cat /etc/oracle-release 2>/dev/null || cat /etc/redhat-release 2>/dev/null || echo "Unknown")
log "[OS] $OS_REL"
echo "$OS_REL" | grep -qiE "Oracle Linux|Red Hat.*8|Rocky.*8|AlmaLinux.*8" \
  && pass "Supported OS detected" \
  || warn "Unverified OS — Oracle Essbase 21c certified on OL7/OL8/RHEL7/RHEL8"

# ── Kernel version ────────────────────────────────────────────────────────
KERNEL=$(uname -r)
log "[KERNEL] $KERNEL"
pass "Kernel: $KERNEL"

# ── Required packages ─────────────────────────────────────────────────────
log ""
log "[PACKAGES] Checking required packages..."
REQUIRED_PKGS="binutils gcc gcc-c++ glibc glibc-devel ksh libaio libaio-devel
  libgcc libstdc++ libstdc++-devel libxcb libX11 libXau libXi libXtst
  make net-tools nfs-utils smartmontools sysstat unzip xorg-x11-xauth"
for pkg in $REQUIRED_PKGS; do
  rpm -q "$pkg" &>/dev/null \
    && pass "$pkg installed" \
    || fail "$pkg NOT installed — run: dnf install -y $pkg"
done

# ── Java check ────────────────────────────────────────────────────────────
log ""
log "[JAVA] Checking for JDK 11..."
if java -version 2>&1 | grep -q "11\."; then
  pass "JDK 11 found: $(java -version 2>&1 | head -1)"
else
  warn "JDK 11 not found or not in PATH — install before running Essbase installer"
fi

# ── SELinux ────────────────────────────────────────────────────────────────
SELINUX=$(getenforce 2>/dev/null)
log "[SELINUX] Status: $SELINUX"
[ "$SELINUX" = "Disabled" ] || [ "$SELINUX" = "Permissive" ] \
  && pass "SELinux is $SELINUX" \
  || warn "SELinux is Enforcing — set to Permissive before install (see Phase 1)"

# ── Hostname ──────────────────────────────────────────────────────────────
HNAME=$(hostname -f 2>/dev/null)
log "[HOSTNAME] FQDN: $HNAME"
echo "$HNAME" | grep -q '\.' \
  && pass "FQDN is set: $HNAME" \
  || fail "Hostname does not appear to be a FQDN — Essbase requires a resolvable FQDN"

# ── Summary ───────────────────────────────────────────────────────────────
log ""; hr
log "  Pre-Check Summary: PASS=$PASS  WARN=$WARN  FAIL=$FAIL"
[ "$FAIL" -gt 0 ] && log "  Resolve FAIL items before proceeding." \
                  || log "  Safe to proceed with Phase 1."
hr
log "  Report: $REPORT"
\`\`\`

---

## Phase 1: OS Configuration

Run as **root**. This configures kernel parameters, security limits, and creates the OS user and directory structure.

\`\`\`bash
#!/bin/bash
# essbase_os_config.sh — OS prerequisites
# Run as root

set -e

ESSBASE_USER="oracle"
ESSBASE_GROUP="oinstall"
DBA_GROUP="dba"
ORACLE_BASE="/u01/app/oracle"
ESSBASE_HOME="/u01/app/oracle/product/essbase21"
INVENTORY_HOME="/u01/app/oraInventory"

echo "=== [1/6] Installing required packages ==="
dnf install -y \
  binutils gcc gcc-c++ glibc glibc-devel ksh \
  libaio libaio-devel libgcc libstdc++ libstdc++-devel \
  libxcb libX11 libXau libXi libXtst \
  make net-tools nfs-utils sysstat unzip \
  xorg-x11-xauth fontconfig freetype \
  compat-openssl10 openssl openssl-libs

echo "=== [2/6] Creating OS groups and user ==="
groupadd -g 54321 "$ESSBASE_GROUP" 2>/dev/null || echo "Group $ESSBASE_GROUP exists"
groupadd -g 54322 "$DBA_GROUP"     2>/dev/null || echo "Group $DBA_GROUP exists"

if ! id "$ESSBASE_USER" &>/dev/null; then
  useradd -u 54321 -g "$ESSBASE_GROUP" -G "$DBA_GROUP" \
          -m -s /bin/bash \
          -d "/home/$ESSBASE_USER" \
          "$ESSBASE_USER"
  echo "User $ESSBASE_USER created."
  # Set initial password — change immediately after install
  echo "\${ESSBASE_USER}:EssbaseInstall123#" | chpasswd
  passwd -e "$ESSBASE_USER"
else
  echo "User $ESSBASE_USER already exists."
fi

echo "=== [3/6] Creating directory structure ==="
mkdir -p "$ORACLE_BASE"
mkdir -p "$ESSBASE_HOME"
mkdir -p "$INVENTORY_HOME"
mkdir -p /u01/app/oracle/essbase/data
mkdir -p /u01/app/oracle/essbase/logs
mkdir -p /stage/essbase

chown -R "\${ESSBASE_USER}:\${ESSBASE_GROUP}" /u01/app/oracle
chown -R "\${ESSBASE_USER}:\${ESSBASE_GROUP}" /stage/essbase
chmod 775 /u01/app/oracle
chmod 775 "$INVENTORY_HOME"

echo "=== [4/6] Setting kernel parameters ==="
cat >> /etc/sysctl.conf << 'EOF'
# Oracle Essbase 21c kernel parameters
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
sysctl -p

echo "=== [5/6] Setting security limits ==="
cat > /etc/security/limits.d/99-oracle-essbase.conf << 'EOF'
# Oracle Essbase 21c limits
oracle   soft   nofile    131072
oracle   hard   nofile    131072
oracle   soft   nproc     131072
oracle   hard   nproc     131072
oracle   soft   core      unlimited
oracle   hard   core      unlimited
oracle   soft   memlock   unlimited
oracle   hard   memlock   unlimited
oracle   soft   stack     10240
oracle   hard   stack     32768
EOF

echo "=== [6/6] Configuring SELinux and firewall ==="
# Set SELinux to permissive (required for install; can re-evaluate post-install)
setenforce 0 2>/dev/null || true
sed -i 's/^SELINUX=enforcing/SELINUX=permissive/' /etc/selinux/config

# Open Essbase ports
firewall-cmd --permanent --add-port=1423/tcp   # Essbase Server
firewall-cmd --permanent --add-port=9000/tcp   # Essbase Web Console (21c)
firewall-cmd --permanent --add-port=443/tcp    # HTTPS
firewall-cmd --permanent --add-port=80/tcp     # HTTP
firewall-cmd --permanent --add-port=5556/tcp   # Node Manager
firewall-cmd --permanent --add-port=7001/tcp   # WebLogic Admin Server
firewall-cmd --permanent --add-port=7002/tcp   # WebLogic SSL
firewall-cmd --permanent --add-port=1521/tcp   # Oracle Database listener
firewall-cmd --reload

echo "=== OS Configuration Complete ==="
echo "  Reboot recommended before proceeding to Phase 2."
\`\`\`

### Set oracle user environment

Add to \`/home/oracle/.bash_profile\`:

\`\`\`bash
# /home/oracle/.bash_profile — Oracle Essbase 21c environment
export ORACLE_BASE=/u01/app/oracle
export ORACLE_HOME=/u01/app/oracle/product/19c/dbhome_1
export ESSBASE_HOME=/u01/app/oracle/product/essbase21
export MW_HOME=/u01/app/oracle/product/essbase21
export JAVA_HOME=/usr/lib/jvm/jdk-11
export PATH=\$JAVA_HOME/bin:\$ORACLE_HOME/bin:\$ESSBASE_HOME/bin:\$PATH
export LD_LIBRARY_PATH=\$ORACLE_HOME/lib:\$JAVA_HOME/lib:\$LD_LIBRARY_PATH
export ORACLE_SID=ESSREP
export TNS_ADMIN=\$ORACLE_HOME/network/admin
export NLS_LANG=AMERICAN_AMERICA.AL32UTF8
export TEMP=/tmp
export TMPDIR=/tmp

umask 022
\`\`\`

---

## Phase 2: Install Oracle JDK 11

\`\`\`bash
#!/bin/bash
# install_jdk11.sh — Install Oracle JDK 11
# Run as root. Adjust JDK filename to match your downloaded version.

JDK_RPM="/stage/essbase/jdk-11.0.22_linux-x64_bin.rpm"
JAVA_HOME_LINK="/usr/lib/jvm/jdk-11"

if [ ! -f "$JDK_RPM" ]; then
  echo "ERROR: JDK RPM not found at $JDK_RPM"
  echo "Download from: https://www.oracle.com/java/technologies/downloads/#java11"
  exit 1
fi

echo "Installing JDK 11..."
rpm -ivh "$JDK_RPM"

# Find the installed JDK path
JDK_PATH=$(find /usr/lib/jvm -maxdepth 1 -name "jdk-11*" -type d | head -1)
if [ -z "$JDK_PATH" ]; then
  echo "ERROR: JDK installation path not found under /usr/lib/jvm"
  exit 1
fi

echo "JDK installed at: $JDK_PATH"

# Create a stable symlink
ln -sfn "$JDK_PATH" "$JAVA_HOME_LINK"

# Set as system default
alternatives --install /usr/bin/java java "$JDK_PATH/bin/java" 1
alternatives --set java "$JDK_PATH/bin/java"
alternatives --install /usr/bin/javac javac "$JDK_PATH/bin/javac" 1
alternatives --set javac "$JDK_PATH/bin/javac"

# Verify
echo ""
echo "Java version:"
java -version

echo ""
echo "JAVA_HOME symlink: $JAVA_HOME_LINK -> $(readlink -f $JAVA_HOME_LINK)"
echo "JDK 11 installation complete."
\`\`\`

---

## Phase 3: Install Oracle Database 19c (Essbase Repository)

The Essbase repository requires an Oracle Database. If you have an existing Oracle 19c instance, skip to Phase 4.

\`\`\`bash
#!/bin/bash
# install_db19c.sh — Silent Oracle Database 19c install for Essbase repository
# Run as oracle user. Adjust paths to match your staging location.

ORACLE_HOME=/u01/app/oracle/product/19c/dbhome_1
ORACLE_BASE=/u01/app/oracle
DB_ZIP="/stage/essbase/LINUX.X64_193000_db_home.zip"

if [ ! -f "$DB_ZIP" ]; then
  echo "ERROR: Oracle Database 19c zip not found at $DB_ZIP"
  exit 1
fi

echo "=== Unzipping Oracle Database 19c home ==="
mkdir -p "$ORACLE_HOME"
cd "$ORACLE_HOME"
unzip -q "$DB_ZIP"

echo "=== Running silent DB software-only install ==="
"$ORACLE_HOME/runInstaller" -silent -ignorePrereqFailure \
  oracle.install.option=INSTALL_DB_SWONLY \
  ORACLE_HOSTNAME="$(hostname -f)" \
  UNIX_GROUP_NAME=oinstall \
  INVENTORY_LOCATION=/u01/app/oraInventory \
  ORACLE_HOME="$ORACLE_HOME" \
  ORACLE_BASE="$ORACLE_BASE" \
  oracle.install.db.InstallEdition=EE \
  oracle.install.db.OSDBA_GROUP=dba \
  oracle.install.db.OSOPER_GROUP=oinstall \
  oracle.install.db.OSBACKUPDBA_GROUP=dba \
  oracle.install.db.OSDGDBA_GROUP=dba \
  oracle.install.db.OSKMDBA_GROUP=dba \
  oracle.install.db.OSRACDBA_GROUP=dba \
  SECURITY_UPDATES_VIA_MYORACLESUPPORT=false \
  DECLINE_SECURITY_UPDATES=true

echo "=== Running root scripts (switch to root) ==="
echo "Run as root: /u01/app/oraInventory/orainstRoot.sh && $ORACLE_HOME/root.sh"
\`\`\`

After running root scripts, create the Essbase repository database:

\`\`\`bash
#!/bin/bash
# create_essrep_db.sh — Create Oracle DB for Essbase repository (ESSREP)
# Run as oracle

ORACLE_HOME=/u01/app/oracle/product/19c/dbhome_1
ORACLE_BASE=/u01/app/oracle
ORACLE_SID=ESSREP
DB_PASS="EssRepo_Pass123#"    # change this
DATA_DIR=/u01/app/oracle/oradata

mkdir -p "$DATA_DIR/$ORACLE_SID"

export ORACLE_HOME ORACLE_BASE ORACLE_SID
export PATH=$ORACLE_HOME/bin:$PATH

# Configure listener
cat > "$ORACLE_HOME/network/admin/listener.ora" << EOF
LISTENER =
  (DESCRIPTION_LIST =
    (DESCRIPTION =
      (ADDRESS = (PROTOCOL = TCP)(HOST = $(hostname -f))(PORT = 1521))
    )
  )

SID_LIST_LISTENER =
  (SID_LIST =
    (SID_DESC =
      (GLOBAL_DBNAME = $ORACLE_SID)
      (ORACLE_HOME   = $ORACLE_HOME)
      (SID_NAME      = $ORACLE_SID)
    )
  )
ADR_BASE_LISTENER = $ORACLE_BASE
EOF

lsnrctl start

# DBCA silent database creation
dbca -silent -createDatabase \
  -templateName General_Purpose.dbc \
  -gdbname "$ORACLE_SID" \
  -sid "$ORACLE_SID" \
  -responseFile NO_VALUE \
  -characterSet AL32UTF8 \
  -sysPassword "$DB_PASS" \
  -systemPassword "$DB_PASS" \
  -createAsContainerDatabase false \
  -databaseType MULTIPURPOSE \
  -automaticMemoryManagement false \
  -totalMemory 4096 \
  -storageType FS \
  -datafileDestination "$DATA_DIR" \
  -redoLogFileSize 200 \
  -emConfiguration NONE \
  -ignorePreReqs

echo "Database $ORACLE_SID created."
echo "Listener status:"
lsnrctl status

# Verify connectivity
sqlplus -S sys/"$DB_PASS"@"$ORACLE_SID" as sysdba << 'EOF'
SELECT name, open_mode, db_unique_name FROM v\$database;
EXIT
EOF
\`\`\`

Configure tnsnames:

\`\`\`bash
cat >> "$ORACLE_HOME/network/admin/tnsnames.ora" << EOF
ESSREP =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = $(hostname -f))(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = ESSREP)
    )
  )
EOF
\`\`\`

---

## Phase 4: Run RCU — Create Essbase Repository Schemas

RCU creates the database schemas required by Essbase (STB, WLS, OPSS, MDS, IAU, and ESSBASE schemas).

\`\`\`bash
#!/bin/bash
# run_rcu.sh — Create Essbase 21c repository schemas using RCU
# Run as oracle. Adjust paths and passwords.

JAVA_HOME=/usr/lib/jvm/jdk-11
RCU_JAR="/stage/essbase/fmw_19.x.x.x_rcu.jar"
RCU_HOME="/u01/app/oracle/product/rcu"
DB_HOST="$(hostname -f)"
DB_PORT=1521
DB_SERVICE=ESSREP
DB_SYS_PASS="EssRepo_Pass123#"
SCHEMA_PREFIX="ESS21"
SCHEMA_PASS="EssSchema_Pass123#"   # must meet Oracle 12c password policy

export JAVA_HOME
export PATH=\$JAVA_HOME/bin:\$PATH

# Extract RCU
mkdir -p "$RCU_HOME"
cd "$RCU_HOME"
jar xf "$RCU_JAR"

# Create schema password file (used for silent mode)
PASSWORD_FILE="/tmp/rcu_passwords_$$.txt"
cat > "$PASSWORD_FILE" << EOF
$DB_SYS_PASS
$SCHEMA_PASS
$SCHEMA_PASS
$SCHEMA_PASS
$SCHEMA_PASS
$SCHEMA_PASS
$SCHEMA_PASS
$SCHEMA_PASS
EOF

echo "=== Running RCU in silent mode ==="
"$RCU_HOME/bin/rcu" -silent -createRepository \
  -connectString "\${DB_HOST}:\${DB_PORT}:\${DB_SERVICE}" \
  -dbUser SYS \
  -dbRole SYSDBA \
  -schemaPrefix "$SCHEMA_PREFIX" \
  -component STB \
  -component WLS \
  -component OPSS \
  -component IAU \
  -component IAU_APPEND \
  -component IAU_VIEWER \
  -component MDS \
  -component ESSBASE \
  -f < "$PASSWORD_FILE"

RCU_RC=$?
rm -f "$PASSWORD_FILE"

if [ $RCU_RC -eq 0 ]; then
  echo ""
  echo "RCU completed successfully."
  echo "Schemas created with prefix: $SCHEMA_PREFIX"
else
  echo "RCU failed with exit code $RCU_RC"
  echo "Check RCU logs under: $RCU_HOME/rcu/log/"
  exit 1
fi

# Verify schemas were created
sqlplus -S sys/"$DB_SYS_PASS"@"$DB_SERVICE" as sysdba << EOF
SET PAGESIZE 20 LINESIZE 80 FEEDBACK OFF
SELECT username, account_status, created
FROM   dba_users
WHERE  username LIKE '\${SCHEMA_PREFIX}%'
ORDER  BY username;
EXIT
EOF
\`\`\`

---

## Phase 5: Install Oracle Essbase 21c

\`\`\`bash
#!/bin/bash
# install_essbase21.sh — Silent Essbase 21c installation
# Run as oracle

JAVA_HOME=/usr/lib/jvm/jdk-11
ESSBASE_ZIP="/stage/essbase/Oracle_Essbase_21.x.x_Linux64.zip"
ORACLE_HOME=/u01/app/oracle/product/essbase21
ORACLE_BASE=/u01/app/oracle
INVENTORY_HOME=/u01/app/oraInventory

export JAVA_HOME
export PATH=\$JAVA_HOME/bin:\$PATH

if [ ! -f "$ESSBASE_ZIP" ]; then
  echo "ERROR: Essbase 21c installer not found at $ESSBASE_ZIP"
  exit 1
fi

echo "=== Extracting Essbase 21c installer ==="
STAGE_DIR="/stage/essbase/essbase21_extracted"
mkdir -p "$STAGE_DIR"
unzip -q "$ESSBASE_ZIP" -d "$STAGE_DIR"

echo "=== Creating Essbase 21c response file ==="
RESPONSE_FILE="/tmp/essbase21_install_$$.rsp"
cat > "$RESPONSE_FILE" << EOF
[ENGINE]
Response File Version=1.0.0.0.0

[GENERIC]
ORACLE_HOME=$ORACLE_HOME
ORACLE_BASE=$ORACLE_BASE
INSTALL_TYPE=Essbase
MYORACLESUPPORT_USERNAME=
MYORACLESUPPORT_PASSWORD=<SECURE VALUE>
DECLINE_AUTO_UPDATES=true
MOS_AUTO_UPDATES_CHOICE=MOS_MANUAL_UPDATES
HEALTH_UPDATES_CHOICE=HEALTH_MANUAL_UPDATES
OCMS_HOST=
OCMS_PORT=
SECURITY_UPDATES_VIA_MYORACLESUPPORT=false
DECLINE_SECURITY_UPDATES=true
EOF

echo "=== Running Essbase 21c silent install ==="
INSTALLER=$(find "$STAGE_DIR" -name "runInstaller" | head -1)
if [ -z "$INSTALLER" ]; then
  echo "ERROR: runInstaller not found in extracted zip"
  exit 1
fi

"$INSTALLER" -silent \
  -responseFile "$RESPONSE_FILE" \
  -invPtrLoc "$INVENTORY_HOME/oraInst.loc" \
  -ignoreSysPrereqs \
  -ignorePrereqFailure \
  -waitforcompletion 2>&1 | tee /tmp/essbase_install_$$.log

INSTALL_RC=$?
rm -f "$RESPONSE_FILE"

if [ $INSTALL_RC -eq 0 ]; then
  echo "Essbase 21c software installation complete."
else
  echo "Install returned RC=$INSTALL_RC — check /tmp/essbase_install_$$.log"
  exit 1
fi

echo ""
echo "=== Run root scripts (switch to root) ==="
echo "  $INVENTORY_HOME/orainstRoot.sh   (if not already run)"
echo "  $ORACLE_HOME/root.sh"
\`\`\`

Switch to root and run:

\`\`\`bash
/u01/app/oraInventory/orainstRoot.sh
/u01/app/oracle/product/essbase21/root.sh
\`\`\`

---

## Phase 6: Configure Essbase

The Essbase configuration utility creates the WebLogic domain, configures OPSS and MDS from the RCU schemas, and deploys the Essbase application.

\`\`\`bash
#!/bin/bash
# configure_essbase.sh — Run Essbase 21c configuration utility in silent mode
# Run as oracle

JAVA_HOME=/usr/lib/jvm/jdk-11
ESSBASE_HOME=/u01/app/oracle/product/essbase21
DOMAIN_HOME=/u01/app/oracle/domains/essbase_domain
ORACLE_BASE=/u01/app/oracle
DB_HOST="$(hostname -f)"
DB_PORT=1521
DB_SERVICE=ESSREP

# --- Passwords: set these before running ---
ADMIN_PASS="EssAdmin_Pass123#"       # Essbase/WebLogic admin password
DB_SYS_PASS="EssRepo_Pass123#"
SCHEMA_PREFIX="ESS21"
SCHEMA_PASS="EssSchema_Pass123#"
# -------------------------------------------

export JAVA_HOME
export PATH=\$JAVA_HOME/bin:\$ESSBASE_HOME/bin:\$PATH

CONFIG_RESPONSE="/tmp/essbase_config_$$.rsp"

cat > "$CONFIG_RESPONSE" << EOF
[ENGINE]
Response File Version=1.0.0.0.0

[GENERIC]
ESSBASE_ORACLE_HOME=$ESSBASE_HOME
DOMAIN_HOME=$DOMAIN_HOME
APPLICATION_NAME=essbase_domain
ADMIN_USER_NAME=admin
ADMIN_PASSWORD=$ADMIN_PASS
ADMIN_PASSWORD_CONFIRM=$ADMIN_PASS
ADMIN_SERVER_PORT=7001
ADMIN_SERVER_SSL_PORT=7002
MANAGED_SERVER_PORT=9000
MANAGED_SERVER_SSL_PORT=9001
ESSBASE_SERVER_PORT=1423
NODE_MANAGER_PORT=5556
NODE_MANAGER_HOME=$DOMAIN_HOME/nodemanager

DATABASE_TYPE=oracle
DATABASE_HOST=$DB_HOST
DATABASE_PORT=$DB_PORT
DATABASE_SERVICE=$DB_SERVICE
DATABASE_SYS_USERNAME=SYS
DATABASE_SYS_PASSWORD=$DB_SYS_PASS
SCHEMA_PREFIX=$SCHEMA_PREFIX
SCHEMA_PASSWORD=$SCHEMA_PASS

ENABLE_SSL=false
ENABLE_DEMO_SAMPLES=false
DATA_DIRECTORY=$ORACLE_BASE/essbase/data
EOF

echo "=== Running Essbase configuration utility ==="
"$ESSBASE_HOME/config/config.sh" -silent \
  -responseFile "$CONFIG_RESPONSE" 2>&1 | tee /tmp/essbase_config_$$.log

CONFIG_RC=$?
rm -f "$CONFIG_RESPONSE"

if [ $CONFIG_RC -eq 0 ]; then
  echo ""
  echo "Essbase configuration complete."
  echo "Domain home: $DOMAIN_HOME"
else
  echo "Configuration failed with RC=$CONFIG_RC"
  echo "Check: /tmp/essbase_config_$$.log"
  echo "Also check: $ESSBASE_HOME/config/logs/"
  exit 1
fi
\`\`\`

---

## Phase 7: Service Management

### Start Essbase (Node Manager → Admin Server → Managed Server)

\`\`\`bash
#!/bin/bash
# start_essbase.sh — Start all Essbase 21c components in order
# Run as oracle

DOMAIN_HOME=/u01/app/oracle/domains/essbase_domain
ESSBASE_HOME=/u01/app/oracle/product/essbase21
JAVA_HOME=/usr/lib/jvm/jdk-11
ADMIN_PASS="EssAdmin_Pass123#"

export JAVA_HOME
export PATH=\$JAVA_HOME/bin:\$ESSBASE_HOME/bin:\$PATH

log() { echo "[$(date +%H:%M:%S)] $1"; }

# ── 1. Node Manager ────────────────────────────────────────────────────────
log "Starting Node Manager..."
nohup "$DOMAIN_HOME/bin/startNodeManager.sh" \
  > "$DOMAIN_HOME/nodemanager/nodemanager.out" 2>&1 &
NM_PID=$!
log "Node Manager PID: $NM_PID"

log "Waiting for Node Manager to listen on port 5556..."
for i in $(seq 1 30); do
  nc -z localhost 5556 2>/dev/null && break
  sleep 2
done
nc -z localhost 5556 || { log "ERROR: Node Manager did not start"; exit 1; }
log "Node Manager is up."

# ── 2. Admin Server ────────────────────────────────────────────────────────
log "Starting WebLogic Admin Server..."
nohup "$DOMAIN_HOME/bin/startWebLogic.sh" \
  > "$DOMAIN_HOME/servers/AdminServer/logs/AdminServer.out" 2>&1 &
WLS_PID=$!
log "Admin Server PID: $WLS_PID"

log "Waiting for Admin Server on port 7001 (up to 3 minutes)..."
for i in $(seq 1 36); do
  nc -z localhost 7001 2>/dev/null && break
  sleep 5
done
nc -z localhost 7001 || { log "ERROR: Admin Server did not start"; exit 1; }
log "Admin Server is up."

# ── 3. Managed Server (Essbase) ───────────────────────────────────────────
log "Starting Essbase managed server..."
"$DOMAIN_HOME/bin/startManagedWebLogic.sh" essbase_server1 \
  "t3://$(hostname -f):7001" \
  > "$DOMAIN_HOME/servers/essbase_server1/logs/essbase_server1.out" 2>&1 &
ESS_PID=$!
log "Essbase managed server PID: $ESS_PID"

log "Waiting for Essbase on port 9000 (up to 5 minutes)..."
for i in $(seq 1 60); do
  nc -z localhost 9000 2>/dev/null && break
  sleep 5
done
nc -z localhost 9000 || { log "ERROR: Essbase managed server did not start"; exit 1; }
log "Essbase managed server is up."

log ""
log "All components started."
log "  Essbase Web Console: http://$(hostname -f):9000/essbase/jet"
log "  WebLogic Admin Console: http://$(hostname -f):7001/console"
log "  Essbase Server port: 1423"
\`\`\`

### Stop Essbase (reverse order)

\`\`\`bash
#!/bin/bash
# stop_essbase.sh — Graceful stop of all Essbase 21c components
# Run as oracle

DOMAIN_HOME=/u01/app/oracle/domains/essbase_domain
JAVA_HOME=/usr/lib/jvm/jdk-11
ESSBASE_HOME=/u01/app/oracle/product/essbase21
ADMIN_URL="t3://$(hostname -f):7001"
ADMIN_USER=admin
ADMIN_PASS="EssAdmin_Pass123#"

export JAVA_HOME
export PATH=\$JAVA_HOME/bin:\$ESSBASE_HOME/bin:\$PATH

log() { echo "[$(date +%H:%M:%S)] $1"; }

# ── 1. Stop managed server via WLST ───────────────────────────────────────
log "Stopping Essbase managed server via WLST..."
"$ESSBASE_HOME/oracle_common/common/bin/wlst.sh" << EOF
connect('$ADMIN_USER', '$ADMIN_PASS', '$ADMIN_URL')
shutdown('essbase_server1', 'Server', ignoreSessions=True, timeOut=120, force=False, block=True)
disconnect()
EOF

# ── 2. Stop Admin Server ──────────────────────────────────────────────────
log "Stopping WebLogic Admin Server..."
"$DOMAIN_HOME/bin/stopWebLogic.sh" \
  "$ADMIN_USER" "$ADMIN_PASS" "$ADMIN_URL" 2>&1 | tail -5

# ── 3. Stop Node Manager ──────────────────────────────────────────────────
log "Stopping Node Manager..."
pkill -f "weblogic.NodeManager" 2>/dev/null && log "Node Manager stopped." \
  || log "Node Manager was not running."

log "All components stopped."
\`\`\`

### systemd service unit (recommended for production)

Create \`/etc/systemd/system/essbase21.service\` as root:

\`\`\`ini
[Unit]
Description=Oracle Essbase 21c
After=network.target oracledb-ESSREP.service
Requires=network.target

[Service]
Type=forking
User=oracle
Group=oinstall
Environment="JAVA_HOME=/usr/lib/jvm/jdk-11"
Environment="ORACLE_HOME=/u01/app/oracle/product/19c/dbhome_1"
Environment="ESSBASE_HOME=/u01/app/oracle/product/essbase21"
Environment="DOMAIN_HOME=/u01/app/oracle/domains/essbase_domain"
ExecStart=/u01/app/oracle/scripts/start_essbase.sh
ExecStop=/u01/app/oracle/scripts/stop_essbase.sh
TimeoutStartSec=300
TimeoutStopSec=180
Restart=on-failure
RestartSec=30
StandardOutput=journal
StandardError=journal
SyslogIdentifier=essbase21

[Install]
WantedBy=multi-user.target
\`\`\`

\`\`\`bash
systemctl daemon-reload
systemctl enable essbase21
systemctl start essbase21
systemctl status essbase21
\`\`\`

---

## Phase 8: Post-Install Validation

\`\`\`bash
#!/bin/bash
# validate_essbase_install.sh — Post-install health check
# Run as oracle

JAVA_HOME=/usr/lib/jvm/jdk-11
ESSBASE_HOME=/u01/app/oracle/product/essbase21
DOMAIN_HOME=/u01/app/oracle/domains/essbase_domain
DB_SID=ESSREP
ORACLE_HOME=/u01/app/oracle/product/19c/dbhome_1
ADMIN_URL="t3://$(hostname -f):7001"
ADMIN_USER=admin
ADMIN_PASS="EssAdmin_Pass123#"
DB_PASS="EssRepo_Pass123#"
SCHEMA_PREFIX="ESS21"

export JAVA_HOME ORACLE_HOME ORACLE_SID=$DB_SID
export PATH=\$JAVA_HOME/bin:\$ORACLE_HOME/bin:\$ESSBASE_HOME/bin:\$PATH

PASS=0; FAIL=0
log()  { echo "$1"; }
pass() { log "  [PASS] $1"; ((PASS++)); }
fail() { log "  [FAIL] $1"; ((FAIL++)); }
hr()   { log "$(printf '%.0s-' {1..70})"; }

hr; log "  Essbase 21c Post-Install Validation"; log "  $(date)"; hr

# ── Port checks ────────────────────────────────────────────────────────────
log ""
log "[1] Port Availability"
for port in 1521 5556 7001 9000 1423; do
  nc -z localhost "$port" 2>/dev/null \
    && pass "Port $port is listening" \
    || fail "Port $port is NOT listening"
done

# ── Repository DB ──────────────────────────────────────────────────────────
log ""
log "[2] Repository Database ($DB_SID)"
DB_ROLE=$(sqlplus -S sys/"$DB_PASS"@"$DB_SID" as sysdba << 'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT database_role FROM v\$database;
EXIT
EOF
)
DB_ROLE=$(echo "$DB_ROLE" | tr -d ' \n')
[ "$DB_ROLE" = "PRIMARY" ] \
  && pass "Database $DB_SID is open READ WRITE" \
  || fail "Database role: $DB_ROLE"

# ── Essbase schemas ────────────────────────────────────────────────────────
log ""
log "[3] Essbase Repository Schemas (prefix: $SCHEMA_PREFIX)"
SCHEMA_COUNT=$(sqlplus -S sys/"$DB_PASS"@"$DB_SID" as sysdba << EOF
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT COUNT(*) FROM dba_users WHERE username LIKE '\${SCHEMA_PREFIX}%' AND account_status='OPEN';
EXIT
EOF
)
SCHEMA_COUNT=$(echo "$SCHEMA_COUNT" | tr -d ' \n')
[ "$SCHEMA_COUNT" -ge 6 ] \
  && pass "Found $SCHEMA_COUNT open Essbase schemas" \
  || fail "Only $SCHEMA_COUNT schemas found (expected >= 6)"

# ── WebLogic Admin Server ──────────────────────────────────────────────────
log ""
log "[4] WebLogic Admin Server"
WLS_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  "http://$(hostname -f):7001/console/" 2>/dev/null)
[ "$WLS_STATUS" = "200" ] || [ "$WLS_STATUS" = "302" ] \
  && pass "WebLogic Admin Console responding (HTTP $WLS_STATUS)" \
  || fail "WebLogic Admin Console not responding (HTTP $WLS_STATUS)"

# ── Essbase Web Console ────────────────────────────────────────────────────
log ""
log "[5] Essbase Web Console"
ESS_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  "http://$(hostname -f):9000/essbase/jet/" 2>/dev/null)
[ "$ESS_STATUS" = "200" ] || [ "$ESS_STATUS" = "302" ] \
  && pass "Essbase Web Console responding (HTTP $ESS_STATUS)" \
  || fail "Essbase Web Console not responding (HTTP $ESS_STATUS)"

# ── Essbase Server port ────────────────────────────────────────────────────
log ""
log "[6] Essbase Server port 1423"
nc -z localhost 1423 2>/dev/null \
  && pass "Essbase Server is listening on port 1423" \
  || fail "Essbase Server is NOT listening on port 1423"

# ── MaxL connectivity ──────────────────────────────────────────────────────
log ""
log "[7] MaxL connectivity and SampleBasic cube"
MAXL_OUT=$(essmsh << EOF 2>&1
login admin "$ADMIN_PASS" on localhost;
display application all;
logout;
EOF
)
echo "$MAXL_OUT" | grep -q "SampleBasic\|essbase_domain\|0 error" \
  && pass "MaxL login and application list successful" \
  || fail "MaxL login failed or no applications found"

# ── Domain files ───────────────────────────────────────────────────────────
log ""
log "[8] Domain structure"
for dir in "$DOMAIN_HOME" "$DOMAIN_HOME/servers" "$DOMAIN_HOME/bin"; do
  [ -d "$dir" ] && pass "Directory exists: $dir" || fail "Missing: $dir"
done

# ── Summary ────────────────────────────────────────────────────────────────
log ""; hr
log "  Validation Summary: PASS=$PASS  FAIL=$FAIL"
if [ "$FAIL" -eq 0 ]; then
  log "  STATUS: ALL CHECKS PASSED — Essbase 21c installation is healthy."
  log ""
  log "  Next steps:"
  log "    1. Log in to Essbase Web Console: http://$(hostname -f):9000/essbase/jet"
  log "    2. Connect Smart View (Excel) to: http://$(hostname -f):9000/essbase/SmartViewProviders"
  log "    3. Load SampleBasic data and run a test query"
  log "    4. Configure backups (see essbase backup runbook)"
else
  log "  STATUS: $FAIL FAILURE(S) — review output above before use."
fi
hr
\`\`\`

---

## Quick Reference: Run Order

\`\`\`bash
# ── As root ────────────────────────────────────────────────────────────────
chmod +x essbase_precheck.sh essbase_os_config.sh install_jdk11.sh

./essbase_precheck.sh          # review — fix any FAILs first
./essbase_os_config.sh         # configures OS, creates oracle user
./install_jdk11.sh             # installs JDK 11

# Reboot after OS config
reboot

# ── As oracle ──────────────────────────────────────────────────────────────
chmod +x install_db19c.sh create_essrep_db.sh run_rcu.sh
chmod +x install_essbase21.sh configure_essbase.sh
chmod +x start_essbase.sh stop_essbase.sh validate_essbase_install.sh

./install_db19c.sh             # install Oracle DB 19c software
# (as root) run orainstRoot.sh and root.sh
./create_essrep_db.sh          # create ESSREP database

./run_rcu.sh                   # create Essbase repository schemas

./install_essbase21.sh         # install Essbase 21c software
# (as root) run root.sh for Essbase home

./configure_essbase.sh         # create domain and configure Essbase

./start_essbase.sh             # start NM -> AdminServer -> ManagedServer
./validate_essbase_install.sh  # confirm all checks pass
\`\`\`
`,
};

async function main() {
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: {
      title: post.title,
      excerpt: post.excerpt,
      content: post.content,
      published: post.published,
      publishedAt: post.publishedAt,
      isPremium: post.isPremium,
    },
  });
  console.log('inserted:', post.slug);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
