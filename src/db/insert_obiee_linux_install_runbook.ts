import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle OBIEE 12c Installation on Linux with Windows Desktop Client Setup',
  slug: 'obiee-linux-install-windows-clients-runbook',
  excerpt:
    'Step-by-step runbook for installing Oracle OBIEE 12c (12.2.1.4) on Oracle Linux — OS prerequisites, kernel parameters, JDK 8 installation, Oracle Database 19c repository, RCU schema creation, OBIEE silent software install, domain configuration, Oracle HTTP Server setup, systemd service management, and Windows desktop client configuration for the BI Administration Tool, Smart View for Office, and BI Publisher Desktop.',
  category: 'fusion-middleware' as const,
  published: true,
  publishedAt: new Date('2026-06-05'),
  isPremium: true,
  youtubeUrl: null,
  content: `This runbook covers a production-grade Oracle OBIEE 12c (12.2.1.4) installation on Oracle Linux 8, including Windows desktop client setup for RPD development and end-user Excel connectivity. All scripts run sequentially from a staging directory. Passwords and hostnames are parameterised at the top of each script — set them once before running.

**Server hardware minimums for production:**
- 8 CPU cores (16 recommended)
- 64 GB RAM (OBIEE BI Server is memory-intensive; nqsserver alone needs 4–8 GB for a medium RPD)
- 500 GB disk: 100 GB for Oracle homes, 200 GB for data/catalog, 200 GB for OS/swap/logs
- Oracle Linux 8.x or RHEL 8.x

**Software to download from Oracle Software Delivery Cloud / My Oracle Support:**
- \`fmw_12.2.1.4.0_bi.jar\` — OBIEE 12c installer (bundles WebLogic 12c)
- \`fmw_12.2.1.4.0_ohs_linux64.bin\` — Oracle HTTP Server (separate download)
- \`jdk-8u351-linux-x64.rpm\` — Oracle JDK 8 (8u251 minimum; 8u351 recommended)
- Oracle Database 19c installer (for repository DB — skip if using existing instance)
- \`fmw_14.1.1.0.0_rcu.jar\` — RCU matching your FMW stack

---

## Phase 0: System Pre-Check

Run this as root or a sudo user before touching anything else. It validates the host meets OBIEE 12c requirements and outputs a report.

\`\`\`bash
#!/bin/bash
# obiee_precheck.sh — System requirements check for OBIEE 12c
# Run as root

REPORT="/tmp/obiee_precheck_$(date +%Y%m%d_%H%M%S).txt"
PASS=0; WARN=0; FAIL=0

log()  { echo "$1" | tee -a "$REPORT"; }
pass() { log "  [PASS] $1"; ((PASS++)); }
warn() { log "  [WARN] $1"; ((WARN++)); }
fail() { log "  [FAIL] $1"; ((FAIL++)); }
hr()   { log "$(printf '%.0s-' {1..72})"; }

hr
log "  Oracle OBIEE 12c (12.2.1.4) Pre-Install Check"
log "  Host: $(hostname -f)  |  Date: $(date)"
hr; log ""

# ── CPU ───────────────────────────────────────────────────────────────────────
CPUS=$(nproc)
log "[CPU] Physical cores: $CPUS"
[ "$CPUS" -ge 8 ] && pass "CPU cores >= 8 ($CPUS)" \
  || { [ "$CPUS" -ge 4 ] && warn "CPU cores < 8 ($CPUS) — minimum met, expect degraded performance" \
       || fail "CPU cores < 4 ($CPUS) — insufficient for OBIEE"; }

# ── Memory ────────────────────────────────────────────────────────────────────
MEM_GB=$(awk '/MemTotal/ {printf "%d", $2/1048576}' /proc/meminfo)
log "[MEM] Total RAM: \${MEM_GB} GB"
[ "$MEM_GB" -ge 64 ] && pass "RAM >= 64 GB (\${MEM_GB} GB)" \
  || { [ "$MEM_GB" -ge 32 ] && warn "RAM < 64 GB (\${MEM_GB} GB) — marginal for production RPD loads" \
       || fail "RAM < 32 GB (\${MEM_GB} GB) — insufficient for OBIEE 12c"; }

# ── Swap ──────────────────────────────────────────────────────────────────────
SWAP_GB=$(awk '/SwapTotal/ {printf "%d", $2/1048576}' /proc/meminfo)
log "[SWAP] Swap: \${SWAP_GB} GB"
[ "$SWAP_GB" -ge 16 ] && pass "Swap >= 16 GB (\${SWAP_GB} GB)" \
  || warn "Swap < 16 GB (\${SWAP_GB} GB) — increase to at least 16 GB for large BI Server cache"

# ── Disk ──────────────────────────────────────────────────────────────────────
log "[DISK]"
for mount in / /u01 /tmp; do
  FREE_GB=$(df -BG "$mount" 2>/dev/null | awk 'NR==2 {gsub("G",""); print $4}')
  [ -n "$FREE_GB" ] && log "  $mount: \${FREE_GB} GB free"
done
TMP_FREE=$(df -BG /tmp | awk 'NR==2 {gsub("G",""); print $4}')
U01_FREE=$(df -BG /u01 2>/dev/null | awk 'NR==2 {gsub("G",""); print $4}' \
           || df -BG / | awk 'NR==2 {gsub("G",""); print $4}')
[ "$TMP_FREE" -ge 10 ]  && pass "/tmp >= 10 GB free (\${TMP_FREE} GB)" \
  || fail "/tmp < 10 GB — OBIEE installer extracts ~8 GB to /tmp"
[ "$U01_FREE" -ge 200 ] && pass "/u01 >= 200 GB free (\${U01_FREE} GB)" \
  || warn "/u01 < 200 GB — may run short during catalog growth"

# ── OS ────────────────────────────────────────────────────────────────────────
OS_REL=$(cat /etc/oracle-release 2>/dev/null || cat /etc/redhat-release 2>/dev/null || echo "Unknown")
log "[OS] $OS_REL"
echo "$OS_REL" | grep -qiE "Oracle Linux.*[78]|Red Hat.*[78]|Rocky.*[78]|AlmaLinux.*[78]" \
  && pass "Supported OS" || warn "Unverified OS — OBIEE 12.2.1.4 certified on OL7/OL8, RHEL7/RHEL8"

# ── Required packages ─────────────────────────────────────────────────────────
log ""
log "[PACKAGES]"
PKGS="binutils compat-libcap1 compat-libstdc++-33 gcc gcc-c++ glibc glibc-devel
      ksh libaio libaio-devel libgcc libstdc++ libstdc++-devel libxcb libX11
      libXau libXi libXrender libXtst make net-tools sysstat unzip
      xorg-x11-xauth fontconfig freetype"
MISSING=""
for pkg in $PKGS; do
  if ! rpm -q "$pkg" &>/dev/null; then
    MISSING="$MISSING $pkg"
    fail "Missing package: $pkg"
  else
    pass "Package installed: $pkg"
  fi
done
[ -n "$MISSING" ] && log "  Install missing: dnf install -y$MISSING"

# ── Java ──────────────────────────────────────────────────────────────────────
log ""
log "[JAVA]"
if java -version 2>&1 | grep -q '"1\.8\.'; then
  pass "JDK 8 found: $(java -version 2>&1 | head -1)"
else
  fail "JDK 8 not found — OBIEE 12c requires JDK 8 (not 11, not 17)"
fi

# ── SELinux / Firewall ────────────────────────────────────────────────────────
SELINUX=$(getenforce 2>/dev/null)
log "[SELINUX] $SELINUX"
[ "$SELINUX" != "Enforcing" ] && pass "SELinux: $SELINUX" \
  || warn "SELinux Enforcing — set to Permissive before install"

# ── FQDN ──────────────────────────────────────────────────────────────────────
FQDN=$(hostname -f 2>/dev/null)
log "[HOSTNAME] $FQDN"
echo "$FQDN" | grep -q '\.' && pass "FQDN resolvable: $FQDN" \
  || fail "Hostname not a FQDN — OBIEE domain creation requires a resolvable FQDN"
getent hosts "$FQDN" &>/dev/null && pass "FQDN resolves in /etc/hosts or DNS" \
  || fail "FQDN does not resolve — add to /etc/hosts or DNS before proceeding"

# ── Summary ───────────────────────────────────────────────────────────────────
log ""; hr
log "  Summary: PASS=$PASS  WARN=$WARN  FAIL=$FAIL"
[ "$FAIL" -gt 0 ] && log "  Resolve all FAIL items before proceeding." \
                  || log "  System ready for Phase 1."
hr
log "  Report saved: $REPORT"
\`\`\`

---

## Phase 1: OS Configuration

Run as **root**. Creates the OS user, sets kernel parameters, security limits, and opens firewall ports.

\`\`\`bash
#!/bin/bash
# obiee_os_config.sh — OS prerequisites for OBIEE 12c
# Run as root

set -e

ORACLE_USER="oracle"
ORACLE_GROUP="oinstall"
DBA_GROUP="dba"
ORACLE_BASE="/u01/app/oracle"
INVENTORY_HOME="/u01/app/oraInventory"

echo "=== [1/6] Installing required OS packages ==="
dnf install -y \
  binutils gcc gcc-c++ glibc glibc-devel ksh \
  libaio libaio-devel libgcc libstdc++ libstdc++-devel \
  libxcb libX11 libXau libXi libXrender libXtst \
  make net-tools sysstat unzip \
  xorg-x11-xauth fontconfig freetype \
  compat-openssl10 openssl openssl-libs \
  nc telnet 2>/dev/null || true

echo "=== [2/6] Creating groups and user ==="
groupadd -g 54321 "$ORACLE_GROUP" 2>/dev/null || echo "Group $ORACLE_GROUP exists"
groupadd -g 54322 "$DBA_GROUP"    2>/dev/null || echo "Group $DBA_GROUP exists"

if ! id "$ORACLE_USER" &>/dev/null; then
  useradd -u 54321 -g "$ORACLE_GROUP" -G "$DBA_GROUP" \
          -m -s /bin/bash \
          -d "/home/$ORACLE_USER" \
          "$ORACLE_USER"
  echo "\${ORACLE_USER}:OracleInstall123#" | chpasswd
  passwd -e "$ORACLE_USER"
  echo "User $ORACLE_USER created."
else
  echo "User $ORACLE_USER already exists."
fi

echo "=== [3/6] Creating directory structure ==="
mkdir -p "$ORACLE_BASE"
mkdir -p "$INVENTORY_HOME"
mkdir -p /u01/app/oracle/product/obiee12
mkdir -p /u01/app/oracle/product/ohs12
mkdir -p /u01/app/oracle/domains
mkdir -p /u01/app/oracle/config/domains
mkdir -p /u01/app/oracle/catalog
mkdir -p /u01/app/oracle/RPD
mkdir -p /stage/obiee

chown -R "\${ORACLE_USER}:\${ORACLE_GROUP}" /u01/app/oracle
chown -R "\${ORACLE_USER}:\${ORACLE_GROUP}" /stage/obiee
chown    "\${ORACLE_USER}:\${ORACLE_GROUP}" "$INVENTORY_HOME"
chmod 775 /u01/app/oracle

echo "=== [4/6] Kernel parameters ==="
cat >> /etc/sysctl.conf << 'EOF'
# Oracle OBIEE 12c kernel parameters
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

echo "=== [5/6] Security limits ==="
cat > /etc/security/limits.d/99-oracle-obiee.conf << 'EOF'
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

echo "=== [6/6] SELinux and firewall ==="
setenforce 0 2>/dev/null || true
sed -i 's/^SELINUX=enforcing/SELINUX=permissive/' /etc/selinux/config

# OBIEE server-side ports
firewall-cmd --permanent --add-port=80/tcp     # OHS HTTP
firewall-cmd --permanent --add-port=443/tcp    # OHS HTTPS
firewall-cmd --permanent --add-port=7001/tcp   # WLS Admin Server (HTTP)
firewall-cmd --permanent --add-port=7002/tcp   # WLS Admin Server (HTTPS)
firewall-cmd --permanent --add-port=9704/tcp   # WLS Managed Server (analytics)
firewall-cmd --permanent --add-port=9703/tcp   # BI Server ODBC — Admin Tool (Windows)
firewall-cmd --permanent --add-port=9705/tcp   # BI Server cluster controller
firewall-cmd --permanent --add-port=9706/tcp   # Scheduler cluster controller
firewall-cmd --permanent --add-port=9710/tcp   # Presentation Services
firewall-cmd --permanent --add-port=9810/tcp   # JavaHost
firewall-cmd --permanent --add-port=5556/tcp   # Node Manager
firewall-cmd --permanent --add-port=1521/tcp   # Oracle DB listener
firewall-cmd --reload
echo "Firewall rules applied."

echo ""
echo "=== OS Configuration Complete ==="
echo "  Reboot before proceeding to Phase 2."
\`\`\`

### oracle user environment (\`/home/oracle/.bash_profile\`)

\`\`\`bash
# /home/oracle/.bash_profile — OBIEE 12c
export ORACLE_BASE=/u01/app/oracle
export ORACLE_HOME=/u01/app/oracle/product/19c/dbhome_1   # DB home (for sqlplus/tnsping)
export MW_HOME=/u01/app/oracle/product/obiee12
export BI_HOME=\${MW_HOME}/bi
export DOMAIN_HOME=/u01/app/oracle/domains/bifoundation_domain
export JAVA_HOME=/usr/lib/jvm/jdk-8
export PATH=\$JAVA_HOME/bin:\$ORACLE_HOME/bin:\$MW_HOME/oracle_common/common/bin:\$PATH
export LD_LIBRARY_PATH=\$ORACLE_HOME/lib:\$JAVA_HOME/lib:\$LD_LIBRARY_PATH
export ORACLE_SID=BIREP
export TNS_ADMIN=\$ORACLE_HOME/network/admin
export NLS_LANG=AMERICAN_AMERICA.AL32UTF8
export TEMP=/tmp
export TMPDIR=/tmp
umask 022
\`\`\`

---

## Phase 2: Install Oracle JDK 8

OBIEE 12c (12.2.1.4) requires JDK 8. Do not use JDK 11 or JDK 17 — the installer and BI Server will fail.

\`\`\`bash
#!/bin/bash
# install_jdk8.sh — Install Oracle JDK 8 for OBIEE 12c
# Run as root

JDK_RPM="/stage/obiee/jdk-8u351-linux-x64.rpm"
JAVA_LINK="/usr/lib/jvm/jdk-8"

[ -f "$JDK_RPM" ] || { echo "ERROR: JDK RPM not found at $JDK_RPM"; exit 1; }

echo "Installing JDK 8..."
rpm -ivh "$JDK_RPM"

JDK_PATH=$(find /usr/lib/jvm -maxdepth 1 -name "jdk1.8*" -type d | sort | tail -1)
[ -n "$JDK_PATH" ] || { echo "ERROR: JDK 8 install path not found"; exit 1; }

echo "JDK installed at: $JDK_PATH"
ln -sfn "$JDK_PATH" "$JAVA_LINK"

# Set as system default
alternatives --install /usr/bin/java  java  "\${JDK_PATH}/bin/java"  100
alternatives --set      java "\${JDK_PATH}/bin/java"
alternatives --install /usr/bin/javac javac "\${JDK_PATH}/bin/javac" 100
alternatives --set      javac "\${JDK_PATH}/bin/javac"

echo ""
java -version
echo "JAVA_HOME link: $JAVA_LINK -> $(readlink -f $JAVA_LINK)"
echo "JDK 8 installation complete."
\`\`\`

---

## Phase 3: Oracle Database 19c Repository

OBIEE requires an Oracle relational database to hold FMW schemas (MDS, BIPLATFORM, OPSS, IAU, WLS, STB). If an existing 19c instance is available, skip the DB install steps and proceed to creating the tnsnames entry and running RCU.

\`\`\`bash
#!/bin/bash
# create_birep_db.sh — Create Oracle 19c repository database for OBIEE
# Run as oracle. Assumes Oracle 19c software is already installed.

ORACLE_HOME=/u01/app/oracle/product/19c/dbhome_1
ORACLE_BASE=/u01/app/oracle
ORACLE_SID=BIREP
DB_PASS="BIRepo_Pass123#"     # change before use
DATA_DIR=/u01/app/oracle/oradata

export ORACLE_HOME ORACLE_BASE ORACLE_SID
export PATH=$ORACLE_HOME/bin:$PATH

mkdir -p "$DATA_DIR/$ORACLE_SID"

# Listener (skip if listener already configured for this host)
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

# Create database
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
  -totalMemory 8192 \
  -storageType FS \
  -datafileDestination "$DATA_DIR" \
  -redoLogFileSize 300 \
  -emConfiguration NONE \
  -ignorePreReqs

echo "Database $ORACLE_SID created."

# tnsnames entry
cat >> "$ORACLE_HOME/network/admin/tnsnames.ora" << EOF

BIREP =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = $(hostname -f))(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = BIREP)
    )
  )
EOF

# Verify
sqlplus -S sys/"$DB_PASS"@BIREP as sysdba << 'EOF'
SELECT name, open_mode FROM v\$database;
EXIT
EOF
\`\`\`

---

## Phase 4: RCU — Create FMW Repository Schemas

RCU creates the schemas OBIEE needs: STB (Service Table), WLS, OPSS, IAU, IAU_APPEND, IAU_VIEWER, MDS, and BIPLATFORM.

\`\`\`bash
#!/bin/bash
# run_rcu.sh — Create OBIEE 12c FMW repository schemas
# Run as oracle

JAVA_HOME=/usr/lib/jvm/jdk-8
RCU_JAR="/stage/obiee/fmw_14.1.1.0.0_rcu.jar"
RCU_HOME="/u01/app/oracle/product/rcu_obiee"
DB_HOST="$(hostname -f)"
DB_PORT=1521
DB_SERVICE=BIREP
DB_SYS_PASS="BIRepo_Pass123#"
SCHEMA_PREFIX="BI12C"
SCHEMA_PASS="BISchema_Pass123#"    # must meet Oracle 12c complexity rules

export JAVA_HOME
export PATH=$JAVA_HOME/bin:$PATH

[ -f "$RCU_JAR" ] || { echo "ERROR: RCU jar not found at $RCU_JAR"; exit 1; }

echo "=== Extracting RCU ==="
mkdir -p "$RCU_HOME"
cd "$RCU_HOME"
jar xf "$RCU_JAR"

# Password file (one line per schema; SYS password is first)
PWFILE="/tmp/rcu_pw_$$.txt"
# Order: SYS, then one per component in order below
printf '%s\n' \
  "$DB_SYS_PASS" \
  "$SCHEMA_PASS" \
  "$SCHEMA_PASS" \
  "$SCHEMA_PASS" \
  "$SCHEMA_PASS" \
  "$SCHEMA_PASS" \
  "$SCHEMA_PASS" \
  "$SCHEMA_PASS" \
  "$SCHEMA_PASS" > "$PWFILE"

echo "=== Running RCU (silent) ==="
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
  -component BIPLATFORM \
  -f < "$PWFILE"

RCU_RC=$?
rm -f "$PWFILE"

if [ $RCU_RC -eq 0 ]; then
  echo "RCU complete. Schemas created with prefix: $SCHEMA_PREFIX"
else
  echo "RCU failed (RC=$RCU_RC). Check: $RCU_HOME/rcu/log/"
  exit 1
fi

# Verify
sqlplus -S sys/"$DB_SYS_PASS"@BIREP as sysdba << EOF
SET PAGESIZE 20 LINESIZE 80 FEEDBACK OFF
SELECT username, account_status
FROM   dba_users
WHERE  username LIKE '\${SCHEMA_PREFIX}%'
ORDER  BY username;
EXIT
EOF
\`\`\`

---

## Phase 5: Install OBIEE 12c Software

The \`fmw_12.2.1.4.0_bi.jar\` installer includes WebLogic 12c, JRF, OPSS, and the OBIEE BI components. It is a single silent install.

\`\`\`bash
#!/bin/bash
# install_obiee12c.sh — Silent OBIEE 12.2.1.4 installation
# Run as oracle

JAVA_HOME=/usr/lib/jvm/jdk-8
OBIEE_JAR="/stage/obiee/fmw_12.2.1.4.0_bi.jar"
ORACLE_HOME=/u01/app/oracle/product/obiee12
ORACLE_BASE=/u01/app/oracle
INVENTORY_HOME=/u01/app/oraInventory

export JAVA_HOME
export PATH=$JAVA_HOME/bin:$PATH

[ -f "$OBIEE_JAR" ] || { echo "ERROR: OBIEE jar not found at $OBIEE_JAR"; exit 1; }

RESPONSE="/tmp/obiee_install_$$.rsp"
cat > "$RESPONSE" << EOF
[ENGINE]
Response File Version=1.0.0.0.0

[GENERIC]
ORACLE_HOME=$ORACLE_HOME
ORACLE_HOME_NAME=OBIEE12c
INSTALL_TYPE=BI Platform
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

echo "=== Starting OBIEE 12c silent install ==="
echo "  This takes 15-30 minutes. Output in: /tmp/obiee_install_\${$}.log"

"$JAVA_HOME/bin/java" -Xmx1024m \
  -jar "$OBIEE_JAR" \
  -silent \
  -responseFile "$RESPONSE" \
  -invPtrLoc "$INVENTORY_HOME/oraInst.loc" \
  -ignoreSysPrereqs \
  -jreLoc "$JAVA_HOME" \
  2>&1 | tee "/tmp/obiee_install_\${$}.log"

INSTALL_RC=$?
rm -f "$RESPONSE"

if [ $INSTALL_RC -eq 0 ]; then
  echo ""
  echo "OBIEE 12c software installed to: $ORACLE_HOME"
  echo "Run root scripts next (see below)."
else
  echo "Install failed (RC=$INSTALL_RC) — check /tmp/obiee_install_\${$}.log"
  exit 1
fi
\`\`\`

Switch to root and run the post-install scripts:

\`\`\`bash
# As root:
/u01/app/oraInventory/orainstRoot.sh   # skip if already run for this host
/u01/app/oracle/product/obiee12/root.sh
\`\`\`

---

## Phase 6: Configure the OBIEE Domain

The configuration wizard creates the WebLogic bifoundation domain, provisions all OBIEE system components (nqsserver, sawserver, JavaHost, Scheduler), and links the FMW schemas.

\`\`\`bash
#!/bin/bash
# configure_obiee.sh — Silent OBIEE 12c domain configuration
# Run as oracle

JAVA_HOME=/usr/lib/jvm/jdk-8
MW_HOME=/u01/app/oracle/product/obiee12
DOMAIN_HOME=/u01/app/oracle/domains/bifoundation_domain
CONFIG_DOMAIN_HOME=/u01/app/oracle/config/domains/bifoundation_domain
ORACLE_BASE=/u01/app/oracle
DB_HOST="$(hostname -f)"
DB_PORT=1521
DB_SERVICE=BIREP

# ── Passwords — set before running ────────────────────────────────────────────
ADMIN_USER=weblogic
ADMIN_PASS="WLSAdmin_Pass123#"
DB_SYS_PASS="BIRepo_Pass123#"
SCHEMA_PREFIX="BI12C"
SCHEMA_PASS="BISchema_Pass123#"
# ─────────────────────────────────────────────────────────────────────────────

export JAVA_HOME MW_HOME
export PATH=$JAVA_HOME/bin:$MW_HOME/oracle_common/common/bin:$PATH

RESPONSE="/tmp/obiee_config_$$.rsp"

cat > "$RESPONSE" << EOF
[GENERIC]
ORACLE_HOME=$MW_HOME
DOMAIN_HOME=$DOMAIN_HOME
APPLICATION_HOME=$CONFIG_DOMAIN_HOME

ADMIN_USER_NAME=$ADMIN_USER
ADMIN_USER_PASSWD=$ADMIN_PASS
ADMIN_PORT=7001

# Repository DB connection
RCU_DB_CONN_STRING=//\${DB_HOST}:\${DB_PORT}/\${DB_SERVICE}
RCU_SCHEMA_USER_PREFIX=\${SCHEMA_PREFIX}
RCU_SCHEMA_USER_PASSWD=\${SCHEMA_PASS}
RCU_DB_USER=SYS
RCU_DB_USER_PASSWD=\${DB_SYS_PASS}
RCU_DB_USER_ROLE=SYSDBA

SCALABLE_MODE=true
ENABLE_BI_SSL=false

# Managed server and component ports (defaults — change if ports conflict)
BI_MANAGED_SERVER_HTTP_PORT=9704
BI_MANAGED_SERVER_HTTPS_PORT=9805
NODE_MANAGER_PORT=5556
EOF

echo "=== Running OBIEE configuration wizard (silent) ==="
echo "  This takes 20-40 minutes."

"$MW_HOME/oracle_common/common/bin/config.sh" \
  -silent \
  -response "$RESPONSE" \
  -log /tmp/obiee_config_\${$}.log \
  2>&1 | tee /tmp/obiee_config_console_\${$}.log

CONFIG_RC=$?
rm -f "$RESPONSE"

if [ $CONFIG_RC -eq 0 ]; then
  echo ""
  echo "OBIEE domain configuration complete."
  echo "  Domain home:  $DOMAIN_HOME"
  echo "  WLS Admin:    http://$(hostname -f):7001/console"
  echo "  OBIEE:        http://$(hostname -f):9704/analytics"
else
  echo "Configuration failed (RC=$CONFIG_RC)"
  echo "Logs:"
  echo "  /tmp/obiee_config_\${$}.log"
  echo "  $MW_HOME/oracle_common/common/bin/config.log"
  exit 1
fi
\`\`\`

---

## Phase 7: Oracle HTTP Server (OHS) Installation and Configuration

OHS is installed separately and configured as a front-end reverse proxy for OBIEE. It handles SSL termination and routes \`/analytics\` and \`/xmlpserver\` to the WebLogic managed server.

\`\`\`bash
#!/bin/bash
# install_ohs.sh — Silent OHS 12c installation for OBIEE
# Run as oracle

JAVA_HOME=/usr/lib/jvm/jdk-8
OHS_BIN="/stage/obiee/fmw_12.2.1.4.0_ohs_linux64.bin"
OHS_HOME=/u01/app/oracle/product/ohs12
INVENTORY_HOME=/u01/app/oraInventory

export JAVA_HOME
export PATH=$JAVA_HOME/bin:$PATH

[ -f "$OHS_BIN" ] || { echo "ERROR: OHS installer not found at $OHS_BIN"; exit 1; }
chmod +x "$OHS_BIN"

RESPONSE="/tmp/ohs_install_$$.rsp"
cat > "$RESPONSE" << EOF
[ENGINE]
Response File Version=1.0.0.0.0
[GENERIC]
ORACLE_HOME=$OHS_HOME
ORACLE_HOME_NAME=OHS12c
INSTALL_TYPE=Standalone HTTP Server (Managed independently of WebLogic server)
DECLINE_SECURITY_UPDATES=true
EOF

echo "=== Installing Oracle HTTP Server 12c ==="
"$OHS_BIN" -silent -responseFile "$RESPONSE" \
  -invPtrLoc "$INVENTORY_HOME/oraInst.loc" \
  -jreLoc "$JAVA_HOME" \
  -ignoreSysPrereqs \
  2>&1 | tee /tmp/ohs_install_\${$}.log

INSTALL_RC=$?
rm -f "$RESPONSE"

[ $INSTALL_RC -eq 0 ] && echo "OHS installation complete." \
  || { echo "OHS install failed (RC=$INSTALL_RC)"; exit 1; }
\`\`\`

### Configure OHS mod_wl_ohs for OBIEE

After OHS is installed, create a WebLogic proxy configuration file. This routes all OBIEE traffic through OHS port 80/443 to the WLS managed server on port 9704.

\`\`\`bash
#!/bin/bash
# configure_ohs_obiee.sh — Configure OHS reverse proxy for OBIEE 12c
# Run as oracle

OHS_HOME=/u01/app/oracle/product/ohs12
MW_HOME=/u01/app/oracle/product/obiee12
OHS_DOMAIN=/u01/app/oracle/domains/ohs_domain
OHS_INSTANCE=ohs1
BI_HOST="$(hostname -f)"
BI_PORT=9704
ADMIN_USER=weblogic
ADMIN_PASS="WLSAdmin_Pass123#"
ADMIN_URL="t3://$(hostname -f):7001"

export JAVA_HOME=/usr/lib/jvm/jdk-8
export PATH=$JAVA_HOME/bin:$OHS_HOME/oracle_common/common/bin:$PATH

# Create OHS standalone domain
"$OHS_HOME/oracle_common/common/bin/config.sh" -silent \
  -response /dev/stdin << EOF
[GENERIC]
ORACLE_HOME=$OHS_HOME
DOMAIN_HOME=$OHS_DOMAIN
ADMIN_USER_NAME=$ADMIN_USER
ADMIN_USER_PASSWD=$ADMIN_PASS
COMPONENT_TYPE=OHS
OHS_INSTANCE_NAME=$OHS_INSTANCE
OHS_HTTP_PORT=80
OHS_HTTPS_PORT=443
NODE_MANAGER_PORT=5557
EOF

# Create mod_wl_ohs configuration for OBIEE
OHS_CONF_DIR="$OHS_DOMAIN/config/fmwconfig/components/OHS/$OHS_INSTANCE/moduleconf"
mkdir -p "$OHS_CONF_DIR"

cat > "$OHS_CONF_DIR/obiee.conf" << EOF
# OBIEE 12c mod_wl_ohs routing configuration

<IfModule weblogic_module>
  WLLogFile /tmp/wl_proxy.log

  # Route /analytics to WLS managed server
  <Location /analytics>
    SetHandler weblogic-handler
    WebLogicHost \${BI_HOST}
    WebLogicPort \${BI_PORT}
  </Location>

  # Route /analyticsRes (static resources)
  <Location /analyticsRes>
    SetHandler weblogic-handler
    WebLogicHost \${BI_HOST}
    WebLogicPort \${BI_PORT}
  </Location>

  # Route /xmlpserver (BI Publisher)
  <Location /xmlpserver>
    SetHandler weblogic-handler
    WebLogicHost \${BI_HOST}
    WebLogicPort \${BI_PORT}
  </Location>

  # Route /bimad (BI Mobile App Designer — if used)
  <Location /bimad>
    SetHandler weblogic-handler
    WebLogicHost \${BI_HOST}
    WebLogicPort \${BI_PORT}
  </Location>

  # Route /console (WLS admin — internal access only; restrict at network level)
  <Location /console>
    SetHandler weblogic-handler
    WebLogicHost \${BI_HOST}
    WebLogicPort 7001
    Require ip 10.0.0.0/8 192.168.0.0/16
  </Location>
</IfModule>
EOF

echo "OHS OBIEE proxy configuration written to: $OHS_CONF_DIR/obiee.conf"
echo "Restart OHS to apply: $OHS_DOMAIN/bin/restartComponent.sh $OHS_INSTANCE"
\`\`\`

---

## Phase 8: Start, Stop, and systemd Service Management

### Start order: DB → Node Manager → Admin Server → Managed Server → OHS

\`\`\`bash
#!/bin/bash
# start_obiee.sh — Start all OBIEE 12c components in dependency order
# Run as oracle

JAVA_HOME=/usr/lib/jvm/jdk-8
MW_HOME=/u01/app/oracle/product/obiee12
OHS_HOME=/u01/app/oracle/product/ohs12
DOMAIN_HOME=/u01/app/oracle/domains/bifoundation_domain
OHS_DOMAIN=/u01/app/oracle/domains/ohs_domain
OHS_INSTANCE=ohs1
ADMIN_URL="t3://$(hostname -f):7001"
ADMIN_USER=weblogic
ADMIN_PASS="WLSAdmin_Pass123#"

export JAVA_HOME MW_HOME
export PATH=$JAVA_HOME/bin:$MW_HOME/oracle_common/common/bin:$PATH

log() { echo "[$(date +%H:%M:%S)] $*"; }
wait_port() {
  local host=$1 port=$2 label=$3 attempts=\${4:-60}
  log "Waiting for $label on port $port..."
  for i in $(seq 1 "$attempts"); do
    nc -z "$host" "$port" 2>/dev/null && { log "$label is up."; return 0; }
    sleep 5
  done
  log "ERROR: $label did not start on port $port after \$((attempts * 5))s"
  return 1
}

# ── 1. Node Manager ───────────────────────────────────────────────────────────
log "Starting Node Manager..."
nohup "$DOMAIN_HOME/bin/startNodeManager.sh" \
  > "$DOMAIN_HOME/nodemanager/nodemanager.out" 2>&1 &
wait_port localhost 5556 "Node Manager" 30

# ── 2. WebLogic Admin Server ──────────────────────────────────────────────────
log "Starting WebLogic Admin Server..."
nohup "$DOMAIN_HOME/bin/startWebLogic.sh" \
  > "$DOMAIN_HOME/servers/AdminServer/logs/AdminServer.out" 2>&1 &
wait_port localhost 7001 "WLS Admin Server" 60

# ── 3. OBIEE Managed Server (bi_server1) ──────────────────────────────────────
log "Starting OBIEE managed server bi_server1..."
nohup "$DOMAIN_HOME/bin/startManagedWebLogic.sh" bi_server1 "$ADMIN_URL" \
  > "$DOMAIN_HOME/servers/bi_server1/logs/bi_server1.out" 2>&1 &
wait_port localhost 9704 "OBIEE Managed Server" 120

# ── 4. Verify BI system components started ────────────────────────────────────
log "Checking BI system component ports..."
for port_label in "9703:BI Server ODBC" "9710:Presentation Services" "9810:JavaHost"; do
  port=\${port_label%%:*}; label=\${port_label##*:}
  nc -z localhost "$port" 2>/dev/null \
    && log "  [UP] $label (port $port)" \
    || log "  [WARN] $label (port $port) not yet listening — may still be starting"
done

# ── 5. OHS ────────────────────────────────────────────────────────────────────
log "Starting Oracle HTTP Server..."
"$OHS_DOMAIN/bin/startComponent.sh" "$OHS_INSTANCE"
wait_port localhost 80 "OHS" 30

log ""
log "=== OBIEE Stack Started ==="
log "  Analytics:       http://$(hostname -f)/analytics"
log "  BI Publisher:    http://$(hostname -f)/xmlpserver"
log "  WLS Console:     http://$(hostname -f):7001/console"
log "  BI Server ODBC:  $(hostname -f):9703   (for Admin Tool)"
\`\`\`

### Stop order: OHS → Managed Server → Admin Server → Node Manager

\`\`\`bash
#!/bin/bash
# stop_obiee.sh — Graceful stop of all OBIEE 12c components
# Run as oracle

JAVA_HOME=/usr/lib/jvm/jdk-8
MW_HOME=/u01/app/oracle/product/obiee12
OHS_DOMAIN=/u01/app/oracle/domains/ohs_domain
OHS_INSTANCE=ohs1
DOMAIN_HOME=/u01/app/oracle/domains/bifoundation_domain
ADMIN_URL="t3://$(hostname -f):7001"
ADMIN_USER=weblogic
ADMIN_PASS="WLSAdmin_Pass123#"

export JAVA_HOME MW_HOME
export PATH=$JAVA_HOME/bin:$MW_HOME/oracle_common/common/bin:$PATH

log() { echo "[$(date +%H:%M:%S)] $*"; }

log "Stopping OHS..."
"$OHS_DOMAIN/bin/stopComponent.sh" "$OHS_INSTANCE" 2>&1 | tail -3

log "Stopping bi_server1 managed server (via WLST)..."
"$MW_HOME/oracle_common/common/bin/wlst.sh" << EOF
connect('$ADMIN_USER', '$ADMIN_PASS', '$ADMIN_URL')
shutdown('bi_server1', 'Server', ignoreSessions=True, timeOut=180, force=False, block=True)
disconnect()
EOF

log "Stopping WebLogic Admin Server..."
"$DOMAIN_HOME/bin/stopWebLogic.sh" "$ADMIN_USER" "$ADMIN_PASS" "$ADMIN_URL" 2>&1 | tail -3

log "Stopping Node Manager..."
pkill -f "weblogic.NodeManager" 2>/dev/null && log "Node Manager stopped." \
  || log "Node Manager was not running."

log "All OBIEE components stopped."
\`\`\`

### systemd unit (run as root)

\`\`\`bash
# Create /etc/systemd/system/obiee12.service
cat > /etc/systemd/system/obiee12.service << 'EOF'
[Unit]
Description=Oracle OBIEE 12c
After=network.target oracledb-BIREP.service
Requires=network.target

[Service]
Type=forking
User=oracle
Group=oinstall
Environment="JAVA_HOME=/usr/lib/jvm/jdk-8"
Environment="MW_HOME=/u01/app/oracle/product/obiee12"
ExecStart=/u01/app/oracle/scripts/start_obiee.sh
ExecStop=/u01/app/oracle/scripts/stop_obiee.sh
TimeoutStartSec=600
TimeoutStopSec=300
Restart=on-failure
RestartSec=60
StandardOutput=journal
StandardError=journal
SyslogIdentifier=obiee12

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable obiee12
\`\`\`

---

## Phase 9: Windows Desktop Client Setup

OBIEE has two primary Windows clients. The **BI Administration Tool** is a fat client that connects to the BI Server (port 9703) for RPD development. **Smart View for Office** is an Excel/Word/PowerPoint add-in that connects via HTTP to the analytics WAR.

### 9.1 Oracle BI Administration Tool (RPD Development)

The Admin Tool is Windows-only (no Linux client exists). Download it from the same Oracle Software Delivery Cloud page as the OBIEE installer — look for **Oracle BI Developer Client Tools for Windows**.

**Install on Windows:**

1. Run \`bi_developer_12.2.1.4_win64.exe\` as Administrator.
2. Accept defaults. Install path: \`C:\\Oracle\\Middleware\\Oracle_BI1\`
3. No Oracle Home or JDK is required on the Windows machine for the Admin Tool alone.

**Connect to BI Server (online mode):**

Open menu: **Start → Oracle Business Intelligence → BI Administration Tool**

\`\`\`
File → Open → Online
  Repository:  <leave blank — will list from server>
  Host:        obiee-server.yourdomain.com
  Port:        9703
  Username:    weblogic
  Password:    WLSAdmin_Pass123#
\`\`\`

Port 9703 must be reachable from the Windows workstation. Verify from PowerShell before opening Admin Tool:

\`\`\`powershell
# Test BI Server ODBC port from Windows
Test-NetConnection -ComputerName obiee-server.yourdomain.com -Port 9703

# If blocked, add a Windows Firewall outbound rule (or coordinate with network team):
New-NetFirewallRule \`
  -DisplayName "OBIEE BI Server ODBC" \`
  -Direction Outbound \`
  -Protocol TCP \`
  -RemotePort 9703 \`
  -Action Allow
\`\`\`

**Offline mode (copy RPD to Windows, edit locally):**

\`\`\`bash
# On the Linux OBIEE server — export current live RPD
# Run as oracle:
source /home/oracle/.bash_profile

"$MW_HOME/bi/bitools/bin/datamodel.sh" downloadrpd \
  -O /tmp/StarRepository_$(date +%Y%m%d).rpd \
  -W AdminPassword1# \
  -SI ssi \
  -U weblogic \
  -P WLSAdmin_Pass123# \
  -S localhost \
  -N 9502

# SCP the RPD to your Windows machine
scp oracle@obiee-server:/tmp/StarRepository_$(date +%Y%m%d).rpd .
\`\`\`

Open in Admin Tool: **File → Open → Offline**, select the RPD file.

**Upload modified RPD back to server:**

\`\`\`bash
# On Linux server, as oracle:
"$MW_HOME/bi/bitools/bin/datamodel.sh" uploadrpd \
  -I /tmp/StarRepository_updated.rpd \
  -W AdminPassword1# \
  -SI ssi \
  -U weblogic \
  -P WLSAdmin_Pass123# \
  -S localhost \
  -N 9502
\`\`\`

### 9.2 Oracle Smart View for Office (Excel / PowerPoint / Word)

Smart View connects to OBIEE Presentation Services via HTTP — through OHS on port 80/443. No special firewall rules are needed beyond normal web access.

**Install on Windows:**

1. Download \`SmartView.exe\` from My Oracle Support (search for "Smart View for Office download").
   - Smart View 21.x is compatible with OBIEE 12.2.1.4 and Office 365.
2. Run as Administrator. Install path: \`C:\\Oracle\\SmartView\`
3. Restart Excel after install.

**Connect to OBIEE from Excel:**

In Excel: **Smart View → Home → Connections → Add Connection**

\`\`\`
Connection type:  Oracle BI EE
URL:              http://obiee-server.yourdomain.com/analytics/jbips
\`\`\`

Or through OHS (recommended — uses port 80):

\`\`\`
URL: http://obiee-server.yourdomain.com/analytics/jbips
\`\`\`

Substitute \`https://\` if OHS is configured with SSL.

After connecting, users see a catalogue tree of Subject Areas. They can:
- Drag measures and dimensions into an Excel grid (ad hoc analysis)
- Refresh saved reports on a schedule
- Submit write-back data if the Subject Area supports it

**Smart View connection via Shared Connections XML (enterprise deployment):**

For mass deployment across a Windows fleet, create a Shared Connections file and distribute via Group Policy or a network share:

\`\`\`xml
<!-- smartview_connections.xml — deploy to a network share accessible by all users -->
<?xml version="1.0" encoding="UTF-8"?>
<SmartViewConnections xmlns="http://www.oracle.com/smartview">
  <Connection name="OBIEE Production" provider="OracleBIEE">
    <URL>http://obiee-server.yourdomain.com/analytics/jbips</URL>
    <IsShared>true</IsShared>
  </Connection>
  <Connection name="BI Publisher Production" provider="BIPublisher">
    <URL>http://obiee-server.yourdomain.com/xmlpserver</URL>
    <IsShared>true</IsShared>
  </Connection>
</SmartViewConnections>
\`\`\`

In Smart View: **Options → Advanced → Shared Connections URL** → set to \`\\\\fileserver\\obiee\\smartview_connections.xml\` or \`http://intranet/obiee/smartview_connections.xml\`.

### 9.3 Oracle BI Publisher Desktop (Word Layout Designer)

BI Publisher Desktop is an add-in for Microsoft Word that lets report developers design pixel-perfect layouts against live BI Publisher data models.

**Install on Windows:**

1. Download \`BIPublisherDesktop.exe\` from My Oracle Support.
2. Run as Administrator.
3. In Word, the **BI Publisher** tab appears after restart.

**Connect to BI Publisher server:**

In Word: **BI Publisher → Tools → Connect**

\`\`\`
URL:      http://obiee-server.yourdomain.com/xmlpserver
Username: weblogic
Password: WLSAdmin_Pass123#
\`\`\`

### 9.4 Windows Client Network Requirements Summary

| Client | Connects to | Port | Protocol | Firewall Rule Needed |
|---|---|---|---|---|
| BI Administration Tool (online mode) | BI Server (nqsserver) | 9703 | TCP | Outbound 9703 from workstation to OBIEE server |
| Smart View for Office | OHS → analytics WAR | 80 / 443 | HTTP/HTTPS | Standard web — usually open |
| BI Publisher Desktop | OHS → xmlpserver | 80 / 443 | HTTP/HTTPS | Standard web — usually open |
| Browser (dashboards) | OHS | 80 / 443 | HTTP/HTTPS | Standard web — usually open |
| WLS Admin Console | WLS Admin Server | 7001 | TCP | Restrict to admin workstations only |

Test all required ports from a Windows workstation before deploying clients:

\`\`\`powershell
# Run from Windows workstation — test all required OBIEE ports
$server = "obiee-server.yourdomain.com"
$ports  = @(80, 443, 7001, 9703, 9704)

foreach ($port in $ports) {
  $result = Test-NetConnection -ComputerName $server -Port $port -WarningAction SilentlyContinue
  $status = if ($result.TcpTestSucceeded) { "OPEN" } else { "BLOCKED" }
  Write-Host ("{0,-6} port {1,5}  [{2}]" -f $server, $port, $status)
}
\`\`\`

---

## Phase 10: Post-Install Validation

\`\`\`bash
#!/bin/bash
# validate_obiee_install.sh — Full OBIEE 12c post-install health check
# Run as oracle

JAVA_HOME=/usr/lib/jvm/jdk-8
MW_HOME=/u01/app/oracle/product/obiee12
DOMAIN_HOME=/u01/app/oracle/domains/bifoundation_domain
ORACLE_HOME=/u01/app/oracle/product/19c/dbhome_1
ORACLE_SID=BIREP
DB_PASS="BIRepo_Pass123#"
SCHEMA_PREFIX="BI12C"
ADMIN_USER=weblogic
ADMIN_PASS="WLSAdmin_Pass123#"
HOST=$(hostname -f)

export JAVA_HOME ORACLE_HOME ORACLE_SID
export PATH=$JAVA_HOME/bin:$ORACLE_HOME/bin:$MW_HOME/oracle_common/common/bin:$PATH

PASS=0; FAIL=0; WARN=0
log()  { echo "$1"; }
pass() { log "  [PASS] $1"; ((PASS++)); }
fail() { log "  [FAIL] $1"; ((FAIL++)); }
warn() { log "  [WARN] $1"; ((WARN++)); }
hr()   { log "$(printf '%.0s-' {1..72})"; }

hr
log "  OBIEE 12c Post-Install Validation"
log "  Host: $HOST  |  $(date)"
hr

# ── Port checks ────────────────────────────────────────────────────────────────
log ""
log "[1] Port Availability"
for spec in "1521:Oracle DB" "5556:Node Manager" "7001:WLS Admin" \
            "9704:WLS Managed" "9703:BI Server ODBC" "9710:Presentation Services" \
            "9810:JavaHost" "80:OHS HTTP"; do
  port=\${spec%%:*}; label=\${spec##*:}
  nc -z localhost "$port" 2>/dev/null \
    && pass "Port $port listening ($label)" \
    || fail "Port $port NOT listening ($label)"
done

# ── Repository DB ──────────────────────────────────────────────────────────────
log ""
log "[2] Repository Database (BIREP)"
DB_STATUS=$(sqlplus -S sys/"$DB_PASS"@BIREP as sysdba << 'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT database_role || '/' || open_mode FROM v\$database;
EXIT
EOF
)
DB_STATUS=$(echo "$DB_STATUS" | tr -d ' ')
[[ "$DB_STATUS" == "PRIMARY/READ WRITE" ]] \
  && pass "Database BIREP: $DB_STATUS" \
  || fail "Database BIREP status: $DB_STATUS (expected PRIMARY/READ WRITE)"

# ── FMW Schemas ───────────────────────────────────────────────────────────────
log ""
log "[3] FMW Repository Schemas (prefix: $SCHEMA_PREFIX)"
SCHEMA_COUNT=$(sqlplus -S sys/"$DB_PASS"@BIREP as sysdba << EOF
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT COUNT(*) FROM dba_users
WHERE username LIKE '\${SCHEMA_PREFIX}%' AND account_status = 'OPEN';
EXIT
EOF
)
SCHEMA_COUNT=$(echo "$SCHEMA_COUNT" | tr -d ' \n')
[ "$SCHEMA_COUNT" -ge 7 ] \
  && pass "Found $SCHEMA_COUNT open FMW schemas" \
  || fail "Only $SCHEMA_COUNT schemas found (expected >= 7: STB, WLS, OPSS, IAU×3, MDS, BIPLATFORM)"

# ── WLS Admin Console ─────────────────────────────────────────────────────────
log ""
log "[4] WebLogic Admin Console"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" -m 10 "http://\${HOST}:7001/console/")
[[ "$HTTP" == "200" || "$HTTP" == "302" ]] \
  && pass "WLS Admin Console (HTTP $HTTP)" \
  || fail "WLS Admin Console not responding (HTTP $HTTP)"

# ── OBIEE analytics WAR ───────────────────────────────────────────────────────
log ""
log "[5] OBIEE analytics application (port 9704)"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" -m 15 "http://\${HOST}:9704/analytics/saw.dll?bieehome")
[[ "$HTTP" == "200" || "$HTTP" == "302" ]] \
  && pass "analytics WAR responding (HTTP $HTTP)" \
  || fail "analytics WAR not responding (HTTP $HTTP)"

# ── OHS proxy ────────────────────────────────────────────────────────────────
log ""
log "[6] OHS proxy (port 80)"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" -m 10 "http://\${HOST}/analytics/saw.dll?bieehome")
[[ "$HTTP" == "200" || "$HTTP" == "302" ]] \
  && pass "OHS proxying /analytics correctly (HTTP $HTTP)" \
  || warn "OHS proxy not responding (HTTP $HTTP) — check OHS config if using port 80"

# ── BI Server ODBC port ───────────────────────────────────────────────────────
log ""
log "[7] BI Server ODBC port (Admin Tool connectivity)"
nc -z "$HOST" 9703 2>/dev/null \
  && pass "BI Server listening on port 9703 — Admin Tool can connect" \
  || fail "BI Server NOT listening on 9703 — Admin Tool will fail to connect"

# ── BI Publisher ──────────────────────────────────────────────────────────────
log ""
log "[8] BI Publisher (xmlpserver)"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" -m 10 "http://\${HOST}:9704/xmlpserver/")
[[ "$HTTP" == "200" || "$HTTP" == "302" ]] \
  && pass "BI Publisher (xmlpserver) responding (HTTP $HTTP)" \
  || warn "BI Publisher not responding (HTTP $HTTP)"

# ── Domain structure ──────────────────────────────────────────────────────────
log ""
log "[9] Domain file structure"
for d in "$DOMAIN_HOME" \
          "$DOMAIN_HOME/servers/AdminServer" \
          "$DOMAIN_HOME/servers/bi_server1" \
          "$DOMAIN_HOME/config/fmwconfig/biconfig"; do
  [ -d "$d" ] && pass "Directory exists: $d" || fail "Missing directory: $d"
done

# ── Log files for recent errors ───────────────────────────────────────────────
log ""
log "[10] Recent errors in BI Server log"
BI_LOG=$(find "$DOMAIN_HOME/servers/bi_server1/logs" -name "nqsserver.log" 2>/dev/null | head -1)
if [ -f "$BI_LOG" ]; then
  ERR_COUNT=$(grep -c "ERROR\|FATAL" "$BI_LOG" 2>/dev/null || echo 0)
  [ "$ERR_COUNT" -eq 0 ] \
    && pass "No ERROR/FATAL in $BI_LOG" \
    || warn "$ERR_COUNT ERROR/FATAL entries in nqsserver.log — review before use"
else
  warn "nqsserver.log not found — BI Server may not have started yet"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
log ""; hr
log "  Validation Summary: PASS=$PASS  WARN=$WARN  FAIL=$FAIL"
if [ "$FAIL" -eq 0 ]; then
  log ""
  log "  STATUS: ALL CHECKS PASSED"
  log ""
  log "  Access URLs:"
  log "    Analytics:       http://\${HOST}/analytics"
  log "    BI Publisher:    http://\${HOST}/xmlpserver"
  log "    WLS Console:     http://\${HOST}:7001/console"
  log ""
  log "  Windows client setup:"
  log "    Admin Tool:    connect to \${HOST}:9703  (online mode)"
  log "    Smart View:    http://\${HOST}/analytics/jbips"
  log "    BIP Desktop:   http://\${HOST}/xmlpserver"
else
  log ""
  log "  STATUS: $FAIL FAILURE(S) — resolve before connecting Windows clients"
fi
hr
\`\`\`

---

## Quick Reference: Run Order

\`\`\`bash
# ── As root ────────────────────────────────────────────────────────────────────
./obiee_precheck.sh          # review — fix all FAILs first
./obiee_os_config.sh         # OS users, kernel params, limits, firewall
./install_jdk8.sh            # Oracle JDK 8 (must be JDK 8, not 11/17)
reboot                       # apply kernel params and limits

# ── As oracle ──────────────────────────────────────────────────────────────────
./create_birep_db.sh         # create Oracle 19c BIREP database
./run_rcu.sh                 # create FMW schemas (STB, BIPLATFORM, MDS, OPSS, ...)

./install_obiee12c.sh        # install OBIEE 12.2.1.4 software (bundles WLS)
# (as root) run: /u01/app/oraInventory/orainstRoot.sh && /u01/app/oracle/product/obiee12/root.sh

./configure_obiee.sh         # create bifoundation_domain, link schemas

./install_ohs.sh             # install Oracle HTTP Server 12c
./configure_ohs_obiee.sh     # configure mod_wl_ohs proxy for /analytics /xmlpserver
# (as root) run: /u01/app/oracle/product/ohs12/root.sh

./start_obiee.sh             # start NM → AdminServer → bi_server1 → OHS
./validate_obiee_install.sh  # all checks should PASS before client setup

# ── Windows workstations ──────────────────────────────────────────────────────
# 1. Run PowerShell port test (Phase 9.4) from a workstation to confirm reachability
# 2. Install BI Administration Tool — connect to <host>:9703
# 3. Install Smart View for Office — URL: http://<host>/analytics/jbips
# 4. Install BI Publisher Desktop — URL: http://<host>/xmlpserver
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
