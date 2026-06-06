import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Enterprise Manager 13c Installation and Agent Deployment',
  slug: 'oracle-oem-13c-installation-agent-deployment-runbook',
  excerpt:
    'A phased, production-grade runbook for installing Oracle Enterprise Manager Cloud Control 13c (OEM 13.5) on Oracle Linux 8, configuring the Management Repository on Oracle Database 19c, and deploying Management Agents to monitored hosts. Covers OS prerequisites, repository database preparation, silent OMS installation, post-install verification, and agent deployment with response files.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-05'),
  youtubeUrl: null,
  content: `## Introduction

This runbook covers a complete Oracle Enterprise Manager Cloud Control 13c installation from OS prerequisites through agent deployment and health monitoring. Assumptions: OEM 13.5, Oracle Linux 8 (RHEL 8 compatible), Oracle Database 19c as the Management Repository (OMR), installer binaries downloaded from My Oracle Support, \`oracle\` OS user, and root access available for kernel parameters and \`root.sh\` execution. All commands are run as the \`oracle\` OS user unless explicitly noted otherwise.

---

## Phase 0: Pre-Installation Checks

### Step 0.1: Verify OS Prerequisites on OMS Host

\`\`\`bash
# OS version
cat /etc/oracle-release || cat /etc/redhat-release

# CPU and memory
nproc
free -g

# Disk space checks
df -h /u01 /tmp /var

# Open files limit
ulimit -n
# Must be >= 65536

# /tmp must be >= 1GB
df -h /tmp
\`\`\`

If \`ulimit -n\` returns less than 65536, set it in \`/etc/security/limits.d/99-oracle-oem.conf\` (Step 0.3) and re-login as the oracle user before proceeding. The OEM installer extracts several gigabytes into \`/tmp\` — verify it is at minimum 4 GB free before running the installer binary.

### Step 0.2: Set Required Kernel Parameters

Add to \`/etc/sysctl.d/99-oem.conf\` as root:

\`\`\`bash
cat >> /etc/sysctl.d/99-oem.conf << 'EOF'
fs.file-max = 6815744
kernel.sem = 250 32000 100 128
kernel.shmmni = 4096
kernel.shmall = 1073741824
kernel.shmmax = 4398046511104
net.core.rmem_default = 262144
net.core.rmem_max = 4194304
net.core.wmem_default = 262144
net.core.wmem_max = 1048576
net.ipv4.conf.all.rp_filter = 2
net.ipv4.conf.default.rp_filter = 2
fs.aio-max-nr = 1048576
EOF
sysctl -p /etc/sysctl.d/99-oem.conf
\`\`\`

### Step 0.3: Set OS User Limits for oracle

\`\`\`bash
cat > /etc/security/limits.d/99-oracle-oem.conf << 'EOF'
oracle soft  nofile  65536
oracle hard  nofile  65536
oracle soft  nproc   16384
oracle hard  nproc   16384
oracle soft  stack   10240
oracle hard  stack   32768
oracle soft  memlock unlimited
oracle hard  memlock unlimited
EOF
\`\`\`

Log out and back in as the oracle user after creating this file, then verify with \`ulimit -n\` and \`ulimit -u\`.

### Step 0.4: Install Required OS Packages

\`\`\`bash
dnf install -y \\
  bc \\
  binutils \\
  compat-libcap1 \\
  compat-libstdc++-33 \\
  elfutils-libelf \\
  elfutils-libelf-devel \\
  fontconfig \\
  glibc \\
  glibc-devel \\
  ksh \\
  libaio \\
  libaio-devel \\
  libgcc \\
  libstdc++ \\
  libstdc++-devel \\
  libX11 \\
  libXau \\
  libxcb \\
  libXi \\
  libXtst \\
  libXrender \\
  libXrender-devel \\
  make \\
  net-tools \\
  nfs-utils \\
  smartmontools \\
  sysstat \\
  unzip \\
  xorg-x11-xauth \\
  xorg-x11-utils
\`\`\`

### Step 0.5: Create oracle User and Groups (if Not Already Present)

\`\`\`bash
groupadd -g 54321 oinstall
groupadd -g 54322 dba
groupadd -g 54323 oper
useradd -u 54321 -g oinstall -G dba,oper -d /home/oracle -m oracle
passwd oracle

# Create OEM directory structure
mkdir -p /u01/app/oracle/product/13.5/oms
mkdir -p /u01/app/oracle/product/13.5/agent
mkdir -p /u01/app/oracle/gc_inst
mkdir -p /u01/app/oracle/swlib
chown -R oracle:oinstall /u01/app/oracle
chmod -R 775 /u01/app/oracle
\`\`\`

The \`/u01/app/oracle/swlib\` directory is the Software Library. For HA deployments with two OMS instances, this path must resolve to a shared NFS mount. For single-OMS deployments, local filesystem is acceptable.

---

## Phase 1: Repository Database Preparation

### Step 1.1: Verify Repository Database Prerequisites

Connect to the OMR database as SYSDBA and run these checks before proceeding:

\`\`\`sql
-- Must be Enterprise Edition:
SELECT * FROM v\$version WHERE banner LIKE '%Enterprise%';

-- Block size must be 8192:
SELECT value FROM v\$parameter WHERE name = 'db_block_size';

-- JVM must be installed and valid:
SELECT status FROM dba_registry WHERE comp_id = 'JAVAVM';

-- Check UNDO and TEMP tablespace sizes:
SELECT tablespace_name, round(sum(bytes)/1073741824,2) as gb
FROM dba_data_files
WHERE tablespace_name IN ('UNDOTBS1','TEMP')
GROUP BY tablespace_name;
\`\`\`

All four checks must pass before running the OEM installer. If the JVM status is not VALID, run \`@\${ORACLE_HOME}/javavm/install/initjvm.sql\` as SYSDBA to reinstall. If \`db_block_size\` is not 8192, the OMR database must be recreated — this cannot be changed in an existing database.

### Step 1.2: Set Recommended OMR Database Parameters

\`\`\`sql
-- These are recommended before running the OEM installer:
ALTER SYSTEM SET undo_retention = 10800 SCOPE = BOTH;
ALTER SYSTEM SET session_cached_cursors = 200 SCOPE = SPFILE;
ALTER SYSTEM SET open_cursors = 300 SCOPE = BOTH;
ALTER SYSTEM SET processes = 500 SCOPE = SPFILE;
ALTER SYSTEM SET pga_aggregate_target = 2G SCOPE = BOTH;
ALTER SYSTEM SET sga_target = 8G SCOPE = BOTH;
-- Restart required for SPFILE-only parameters:
-- SHUTDOWN IMMEDIATE; STARTUP;
\`\`\`

The \`processes = 500\` and \`session_cached_cursors = 200\` parameters require a database restart. Schedule this before running the OEM installer. The \`undo_retention = 10800\` (3 hours) is critical — OEM's internal batch jobs can run for extended periods and will generate ORA-01555 snapshot too old errors if UNDO_RETENTION is left at the default 900 seconds.

### Step 1.3: Create Required Tablespaces for OEM Repository

The OEM installer creates these tablespaces automatically, but pre-creating them with appropriate sizes avoids autoextend thrashing during the configuration phase:

\`\`\`sql
CREATE TABLESPACE mgmt_tablespace
  DATAFILE '/u01/oradata/OEMREP/mgmt01.dbf'
  SIZE 1G AUTOEXTEND ON NEXT 512M MAXSIZE 20G;

CREATE TABLESPACE mgmt_ecm_depot_ts
  DATAFILE '/u01/oradata/OEMREP/mgmt_ecm01.dbf'
  SIZE 512M AUTOEXTEND ON NEXT 256M MAXSIZE 10G;

CREATE TEMPORARY TABLESPACE mgmt_temp
  TEMPFILE '/u01/oradata/OEMREP/mgmt_temp01.dbf'
  SIZE 1G AUTOEXTEND ON NEXT 512M MAXSIZE 10G;
\`\`\`

If you pre-create these tablespaces, the OEM installer will use them rather than creating new ones. Adjust the datafile paths to match your ASM diskgroup or filesystem layout.

### Step 1.4: Verify Listener and TNS Connectivity

\`\`\`bash
# On the OMR database host:
lsnrctl status

# Test from OMS host (the OEM installer runs on the OMS host and must reach the OMR):
tnsping OEMREP
\`\`\`

The TNS alias \`OEMREP\` must be defined in \`\${ORACLE_HOME}/network/admin/tnsnames.ora\` on the OMS host (using the Oracle Database Client installed on the OMS host). If \`tnsping OEMREP\` fails from the OMS host, the OEM configuration assistant will fail at the repository connection step.

---

## Phase 2: OMS Installation

### Step 2.1: Extract the OEM Installer

\`\`\`bash
# Run as oracle user on the OMS host:
cd /u01/stage

# Extract (OEM 13.5 ships as multiple zip files):
unzip em13500_linux64.bin -d /u01/stage/oem135
# Or for the newer format:
chmod +x em13500_linux64-2.bin
./em13500_linux64-2.bin ORACLE_HOME=/u01/app/oracle/product/13.5/oms \\
  -silent -responseFile /u01/stage/oem135/install.rsp
\`\`\`

OEM 13.5 ships as a single large binary or as multiple zip files depending on the MOS download. Verify the download checksums from MOS before extraction. The installer requires \`/tmp\` to have at least 4 GB available for extraction; set \`-J-Djava.io.tmpdir=/u01/tmp\` if \`/tmp\` is undersized (see Step 2.3).

### Step 2.2: Create the Silent Response File (install.rsp)

\`\`\`bash
cat > /u01/stage/install.rsp << 'EOF'
RESPONSEFILE_VERSION=2.2.1.0.0
UNIX_GROUP_NAME=oinstall
INVENTORY_LOCATION=/u01/app/oraInventory
ORACLE_HOME=/u01/app/oracle/product/13.5/oms
ORACLE_HOME_NAME=OMS13cHome1
INSTALL_TYPE=ENTERPRISE
CONFIGURATION_TYPE=INSTALL_SOFTWARE_ONLY
b_upgrade=false
EM_INSTALL_TYPE=NOSEED
PLUGIN_SELECTION={"oracle.sysman.db","oracle.sysman.exa"}
EOF
\`\`\`

\`INSTALL_SOFTWARE_ONLY\` installs the OMS binaries without running the configuration assistant. The configuration (repository connection, SYSMAN password, port assignments) is handled separately in Step 2.5. This two-phase approach allows re-running configuration without reinstalling the software, which is useful when repository database parameters need adjustment after the first configuration attempt.

### Step 2.3: Run the OMS Installer (Silent Mode)

\`\`\`bash
# As oracle user:
export ORACLE_HOME=/u01/app/oracle/product/13.5/oms
export PATH=\${ORACLE_HOME}/bin:\${PATH}

/u01/stage/em13500_linux64-2.bin \\
  -silent \\
  -responseFile /u01/stage/install.rsp \\
  -J-Djava.io.tmpdir=/u01/tmp \\
  | tee /u01/stage/oem_install.log

# Monitor for errors:
tail -f /u01/stage/oem_install.log
\`\`\`

The installation typically takes 30–60 minutes depending on disk speed. Watch for \`[FATAL]\` or \`[ERROR]\` entries in the log. Common failures at this stage: missing OS packages (check the prereq check output near the top of the log), insufficient disk space in \`ORACLE_HOME\`, or permissions issues on the OMS directory. The installer will prompt for \`root.sh\` execution at the end; do not exit until Step 2.4 is complete.

### Step 2.4: Run root.sh After Installer Completes (as root)

\`\`\`bash
/u01/app/oraInventory/orainstRoot.sh
/u01/app/oracle/product/13.5/oms/root.sh
\`\`\`

These scripts must be run as root, not oracle. \`orainstRoot.sh\` sets the Oracle inventory directory permissions. \`root.sh\` configures the OMS for privileged operations. Do not skip either script — the OMS will not start correctly without them.

### Step 2.5: Run the OEM Configuration Assistant

\`\`\`bash
# As oracle user — configure OMS and create repository:
/u01/app/oracle/product/13.5/oms/sysman/install/ConfigureGC.pl \\
  -responseFile /u01/stage/configure.rsp \\
  | tee /u01/stage/oem_config.log
\`\`\`

### Step 2.6: Create the Configuration Response File

\`\`\`bash
cat > /u01/stage/configure.rsp << 'EOF'
RESPONSEFILE_VERSION=2.2.1.0.0
ORACLE_HOSTNAME=oms-host.yourdomain.com
EM_UPLOAD_PORT=4900
AGENT_PORT=3872
EM_CONSOLE_PORT=7802
EM_SECURE_CONSOLE_PORT=7803
OMR_HOST=oemrep-host.yourdomain.com
OMR_PORT=1521
OMR_SID=OEMREP
OMR_USER=sysman
SYSMAN_PASSWORD=<secure_password>
SYSMAN_CONFIRM_PASSWORD=<secure_password>
ADP_FLAG=N
JVMD_FLAG=N
SOFTWARE_LIBRARY=/u01/app/oracle/swlib
CONFIG_LOCATION=/u01/app/oracle/gc_inst
EOF
\`\`\`

Replace \`<secure_password>\` with the SYSMAN password — this will be the primary OEM console administrator password. Use a strong password (16+ characters, mixed case, numbers, special characters) and store it in your secrets vault. \`CONFIG_LOCATION\` is where OEM writes its instance configuration, WebLogic domain, and log files — this must have at least 30 GB available.

The configuration phase takes 45–90 minutes. It creates the SYSMAN and related database schemas, loads reference data, starts WebLogic, deploys the EM application, and configures agent registration. Monitor \`oem_config.log\` for progress. If configuration fails partway through, check the detailed log at \`\${CONFIG_LOCATION}/em/EMGC_OMS1/sysman/log/\` before attempting to re-run.

---

## Phase 3: Post-Installation Verification

### Step 3.1: Check OMS Status

\`\`\`bash
export OMS_HOME=/u01/app/oracle/product/13.5/oms
\${OMS_HOME}/bin/emctl status oms

# Expected output includes:
# Oracle Management Server is Up
# WebTier is Up
# JVMD Engine is Up (if enabled)
\`\`\`

If the OMS status shows any component as Down, check the relevant log in \`\${CONFIG_LOCATION}/em/EMGC_OMS1/sysman/log/\`. The most common post-install issue is the WebLogic Admin Server failing to start due to insufficient heap — increase \`USER_MEM_ARGS\` in \`\${CONFIG_LOCATION}/em/EMGC_ADMINSERVER/sysman/config/oms.properties\`.

### Step 3.2: Check OMS Console URL

\`\`\`bash
\${OMS_HOME}/bin/emctl status oms -details
# Shows: Console URL, Upload URL, Admin Server URL
# Console typically: https://oms-host:7803/em
\`\`\`

Open the console URL in a browser and log in with the SYSMAN account using the password set in the configuration response file. The first login may take 2–3 minutes while WebLogic session state initialises.

### Step 3.3: Start and Stop OMS

\`\`\`bash
# Stop:
\${OMS_HOME}/bin/emctl stop oms -all

# Start:
\${OMS_HOME}/bin/emctl start oms

# Stop/start WebLogic Admin Server separately if needed:
\${OMS_HOME}/bin/emctl stop oms
\${OMS_HOME}/bin/emctl start oms
\`\`\`

\`emctl stop oms -all\` stops both the OMS application server and the WebLogic Admin Server. \`emctl stop oms\` (without \`-all\`) stops only the managed server, leaving the Admin Server running. For a full OMS restart after configuration changes, always use \`-all\` on stop and then \`start oms\` (which starts both).

### Step 3.4: Check Repository Connectivity

\`\`\`bash
\${OMS_HOME}/bin/emctl status oms -details | grep -i repository
\`\`\`

### Step 3.5: Verify OMS Log Files for Errors

\`\`\`bash
# OMS application log:
tail -100 /u01/app/oracle/gc_inst/em/EMGC_OMS1/sysman/log/emoms.log

# WebLogic admin server log:
tail -100 /u01/app/oracle/gc_inst/em/EMGC_ADMINSERVER/sysman/log/emoms.log
\`\`\`

Look for \`ERROR\` or \`FATAL\` entries. A healthy OMS log will show periodic metric evaluation entries and agent heartbeat processing but no error-level entries.

---

## Phase 4: Management Agent Deployment

### Step 4.1: Deploy Agent via Pull Installation (agentDeploy.sh)

The pull method is recommended when the OMS cannot SSH to the target host. Run on the target host as the oracle user:

\`\`\`bash
# Pull installation (run on target host as oracle):
# Get the agent image from OMS:
# https://oms-host:7803/em -> Setup -> Add Target -> Add Targets Manually

cd /tmp
wget https://oms-host:4900/em/install/getAgentImage \\
     --no-check-certificate \\
     -O agent.zip
unzip agent.zip
./agentDeploy.sh \\
  AGENT_BASE_DIR=/u01/app/oracle/product/13.5/agent \\
  OMS_HOST=oms-host.yourdomain.com \\
  EM_UPLOAD_PORT=4900 \\
  AGENT_REGISTRATION_PASSWORD=<reg_password>
\`\`\`

The agent registration password is set in the OEM console under Setup → Security → Registration Passwords. Create a registration password before deploying agents — it is used to authenticate agents to the OMS during initial registration.

### Step 4.2: Silent Agent Installation via Response File

\`\`\`bash
cat > /u01/stage/agent.rsp << 'EOF'
RESPONSEFILE_VERSION=2.2.1.0.0
AGENT_BASE_DIR=/u01/app/oracle/product/13.5/agent
OMS_HOST=oms-host.yourdomain.com
EM_UPLOAD_PORT=4900
AGENT_REGISTRATION_PASSWORD=<reg_password>
ORACLE_HOSTNAME=db-host.yourdomain.com
EOF

./agentDeploy.sh -responseFile /u01/stage/agent.rsp | tee /u01/stage/agent_install.log
\`\`\`

Set \`ORACLE_HOSTNAME\` to the fully qualified domain name of the target host as it should appear in the OEM console. This becomes the host target name and must be DNS-resolvable from the OMS host.

### Step 4.3: Run root.sh on Target Host After Agent Install

\`\`\`bash
/u01/app/oracle/product/13.5/agent/agent_13.5.0.0.0/root.sh
\`\`\`

Run as root on the target host. This script configures the agent for privileged monitoring operations (OS metrics that require root-level access on some platforms). The exact path includes the agent version number — check the actual installation path if the version differs.

### Step 4.4: Verify Agent Status

\`\`\`bash
export AGENT_HOME=/u01/app/oracle/product/13.5/agent/agent_13.5.0.0.0
\${AGENT_HOME}/bin/emctl status agent

# Expected: Agent is Running and Ready
# Shows: Agent Home, OMS URL, Agent URL, Last Upload Time
\`\`\`

If the agent shows "Agent is Running" but "Not Ready", check the OMS URL in the agent status output. A common issue is the agent was configured with an HTTP URL when the OMS requires HTTPS — re-secure the agent with \`emctl secure agent\`.

### Step 4.5: Manually Upload Agent Data to OMS

\`\`\`bash
\${AGENT_HOME}/bin/emctl upload agent
\`\`\`

Trigger this after a new agent deployment to immediately push the initial metric collection to the OMS rather than waiting for the scheduled upload interval. This confirms bidirectional connectivity.

### Step 4.6: Discover Database Targets on the Agent Host

\`\`\`bash
# From OMS console: Setup -> Add Target -> Add Targets Manually -> Add Targets on Hosts
# Or list discovered targets from agent:
\${AGENT_HOME}/bin/emctl config agent listtargets
\`\`\`

After agent deployment, OEM automatically scans the host for Oracle Database instances by examining running processes and TNS listener configurations. Discovered targets appear in the console under the host target. If a database is running but not discovered, verify the listener is running and that the \`oracle\` user on the agent host can read the oratab file (\`/etc/oratab\`).

---

## Phase 5: OEM Health Check Script and Startup Automation

### oem_health_check.sh

\`\`\`bash
#!/bin/bash
# =============================================================================
# OEM Health Check Script
# Checks OMS, agent, OMR connectivity, and log errors.
# Returns exit code = number of issues found (Nagios-compatible).
# Usage: ./oem_health_check.sh
# =============================================================================

OMS_HOME="/u01/app/oracle/product/13.5/oms"
AGENT_HOME="/u01/app/oracle/product/13.5/agent/agent_13.5.0.0.0"
OMS_LOG="\${OMS_HOME}/../gc_inst/em/EMGC_OMS1/sysman/log/emoms.log"
ADMIN_LOG="\${OMS_HOME}/../gc_inst/em/EMGC_ADMINSERVER/sysman/log/emoms.log"
SWLIB="/u01/app/oracle/swlib"
OMR_USER="sysman"
OMR_PASSWORD_FILE="/u01/app/oracle/scripts/oem_health/.omr_pass"
SCRIPT_DIR="/u01/app/oracle/scripts/oem_health"
LOG_DIR="\${SCRIPT_DIR}/logs"
TIMESTAMP=\$(date +%Y%m%d_%H%M%S)
LOG_FILE="\${LOG_DIR}/oem_health_\${TIMESTAMP}.log"
ALERT_EMAIL="dba-team@yourdomain.com"
ISSUES=0

# Ensure log directory exists
mkdir -p "\${LOG_DIR}"

log() {
  echo "[\$(date '+%Y-%m-%d %H:%M:%S')] \$1" | tee -a "\${LOG_FILE}"
}

issue() {
  log "ISSUE: \$1"
  ISSUES=\$((ISSUES + 1))
}

ok() {
  log "OK: \$1"
}

# =============================================================================
# Check 1: OMS Status
# =============================================================================
log "=== Check 1: OMS Status ==="
OMS_STATUS=\$("\${OMS_HOME}/bin/emctl" status oms 2>&1)
if echo "\${OMS_STATUS}" | grep -q "Oracle Management Server is Up"; then
  ok "OMS is running"
else
  issue "OMS is NOT running. emctl output: \$(echo \${OMS_STATUS} | head -5)"
fi

if echo "\${OMS_STATUS}" | grep -q "WebTier is Up"; then
  ok "OMS WebTier is Up"
else
  issue "OMS WebTier is NOT up"
fi

# =============================================================================
# Check 2: Agent Status on Local Host
# =============================================================================
log "=== Check 2: Agent Status ==="
if [ -x "\${AGENT_HOME}/bin/emctl" ]; then
  AGENT_STATUS=\$("\${AGENT_HOME}/bin/emctl" status agent 2>&1)
  if echo "\${AGENT_STATUS}" | grep -q "Agent is Running and Ready"; then
    ok "Management Agent is Running and Ready"
  elif echo "\${AGENT_STATUS}" | grep -q "Agent is Running"; then
    issue "Agent is Running but NOT Ready — check OMS connectivity"
  else
    issue "Management Agent is NOT running"
  fi
else
  log "SKIP: Agent home not found at \${AGENT_HOME} — skipping agent check"
fi

# =============================================================================
# Check 3: OMR Database Availability
# =============================================================================
log "=== Check 3: OMR Database Connectivity ==="
if [ -f "\${OMR_PASSWORD_FILE}" ]; then
  OMR_PASS=\$(cat "\${OMR_PASSWORD_FILE}")
  DB_CHECK=\$(\${OMS_HOME}/oracle_common/bin/sqlplus -s /nolog << 'SQLEOF'
CONNECT sysman/\${OMR_PASS}@OEMREP
SELECT 'OMR_ALIVE' FROM dual;
EXIT
SQLEOF
)
  if echo "\${DB_CHECK}" | grep -q "OMR_ALIVE"; then
    ok "OMR database is reachable and SYSMAN login successful"
  else
    issue "OMR database connectivity FAILED — check TNS and SYSMAN password"
  fi
else
  log "SKIP: OMR password file not found at \${OMR_PASSWORD_FILE} — skipping OMR DB check"
  log "       Create the file with the SYSMAN password (chmod 600)"
fi

# =============================================================================
# Check 4: OMS Log — ERROR and WARNING in last hour
# =============================================================================
log "=== Check 4: OMS Log Errors (last 60 minutes) ==="
if [ -f "\${OMS_LOG}" ]; then
  CUTOFF=\$(date -d '60 minutes ago' '+%Y-%m-%d %H:%M' 2>/dev/null || date -v-60M '+%Y-%m-%d %H:%M')
  ERROR_COUNT=\$(awk -v cutoff="\${CUTOFF}" '\$0 >= cutoff && /ERROR|WARNING/' "\${OMS_LOG}" | wc -l)
  if [ "\${ERROR_COUNT}" -gt 0 ]; then
    issue "OMS log has \${ERROR_COUNT} ERROR/WARNING entries in last 60 min"
    awk -v cutoff="\${CUTOFF}" '\$0 >= cutoff && /ERROR|WARNING/' "\${OMS_LOG}" | tail -10 >> "\${LOG_FILE}"
  else
    ok "OMS log: no ERROR/WARNING in last 60 minutes"
  fi
else
  log "SKIP: OMS log not found at \${OMS_LOG}"
fi

# =============================================================================
# Check 5: WebLogic Admin Server Log — CRITICAL and ERROR in last hour
# =============================================================================
log "=== Check 5: WebLogic Admin Server Log ==="
if [ -f "\${ADMIN_LOG}" ]; then
  ADMIN_ERROR_COUNT=\$(awk -v cutoff="\${CUTOFF}" '\$0 >= cutoff && /CRITICAL|ERROR/' "\${ADMIN_LOG}" | wc -l)
  if [ "\${ADMIN_ERROR_COUNT}" -gt 0 ]; then
    issue "WebLogic Admin Server log has \${ADMIN_ERROR_COUNT} CRITICAL/ERROR entries in last 60 min"
    awk -v cutoff="\${CUTOFF}" '\$0 >= cutoff && /CRITICAL|ERROR/' "\${ADMIN_LOG}" | tail -10 >> "\${LOG_FILE}"
  else
    ok "WebLogic Admin Server log: no CRITICAL/ERROR in last 60 minutes"
  fi
else
  log "SKIP: Admin Server log not found at \${ADMIN_LOG}"
fi

# =============================================================================
# Check 6: Software Library Filesystem
# =============================================================================
log "=== Check 6: Software Library Filesystem ==="
if mountpoint -q "\${SWLIB}" 2>/dev/null || [ -d "\${SWLIB}" ]; then
  SWLIB_FREE=\$(df -BG "\${SWLIB}" | awk 'NR==2 {gsub(/G/,"",$4); print \$4}')
  if [ "\${SWLIB_FREE}" -lt 5 ]; then
    issue "Software Library filesystem has only \${SWLIB_FREE}GB free — below 5GB threshold"
  else
    ok "Software Library filesystem has \${SWLIB_FREE}GB free"
  fi
  # Check writable
  TEST_FILE="\${SWLIB}/.write_test_\${TIMESTAMP}"
  if touch "\${TEST_FILE}" 2>/dev/null; then
    rm -f "\${TEST_FILE}"
    ok "Software Library filesystem is writable"
  else
    issue "Software Library filesystem is NOT writable — check NFS mount and permissions"
  fi
else
  issue "Software Library path \${SWLIB} does not exist or is not mounted"
fi

# =============================================================================
# Summary and Notification
# =============================================================================
log "==================================================================="
log "OEM Health Check complete: \${ISSUES} issue(s) found"
log "Log file: \${LOG_FILE}"
log "==================================================================="

if [ "\${ISSUES}" -gt 0 ]; then
  SUBJECT="OEM HEALTH ALERT: \${ISSUES} issue(s) on \$(hostname)"
  if command -v mailx &>/dev/null; then
    mailx -s "\${SUBJECT}" "\${ALERT_EMAIL}" < "\${LOG_FILE}"
  elif command -v sendmail &>/dev/null; then
    (echo "Subject: \${SUBJECT}"; cat "\${LOG_FILE}") | sendmail "\${ALERT_EMAIL}"
  else
    log "WARNING: No mail client found — alert email not sent"
  fi
fi

exit \${ISSUES}
\`\`\`

### Deploy and Enable the Health Check Script

\`\`\`bash
# Create script directory
mkdir -p /u01/app/oracle/scripts/oem_health/logs
chmod 750 /u01/app/oracle/scripts/oem_health

# Save the script
vi /u01/app/oracle/scripts/oem_health/oem_health_check.sh
chmod 750 /u01/app/oracle/scripts/oem_health/oem_health_check.sh

# Create OMR password file (optional — enables OMR DB check)
echo "your_sysman_password" > /u01/app/oracle/scripts/oem_health/.omr_pass
chmod 600 /u01/app/oracle/scripts/oem_health/.omr_pass

# Test the script manually first:
/u01/app/oracle/scripts/oem_health/oem_health_check.sh
echo "Exit code: \$?"
\`\`\`

### Add Crontab Entry (every 10 minutes)

\`\`\`bash
# As oracle user:
crontab -e
\`\`\`

Add the following line:

\`\`\`
*/10  *  *  *  *  /u01/app/oracle/scripts/oem_health/oem_health_check.sh >> /u01/app/oracle/scripts/oem_health/logs/cron_oem.log 2>&1
\`\`\`

### systemd Service for Auto-Start OMS on Boot

\`\`\`bash
# As root — create the service file:
cat > /etc/systemd/system/oracle-oms.service << 'EOF'
[Unit]
Description=Oracle Enterprise Manager OMS
After=network.target oracle-db.service

[Service]
Type=forking
User=oracle
Group=oinstall
Environment=ORACLE_HOME=/u01/app/oracle/product/13.5/oms
ExecStart=/u01/app/oracle/product/13.5/oms/bin/emctl start oms
ExecStop=/u01/app/oracle/product/13.5/oms/bin/emctl stop oms -all
TimeoutStartSec=300
TimeoutStopSec=180
Restart=no

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable oracle-oms.service
systemctl status oracle-oms.service
\`\`\`

Note: The systemd service will start the OMS but not the WebLogic Admin Server separately — \`emctl start oms\` handles both. The \`oracle-db.service\` dependency assumes a separate systemd unit manages the OMR database; adjust the \`After=\` directive if your OMR database starts via a different mechanism.

---

## Quick Reference

### Key emctl Commands

\`\`\`bash
emctl status oms               # OMS status
emctl status oms -details      # Console URL, upload URL, WebLogic URL
emctl start oms                # Start OMS (and WebLogic managed server)
emctl stop oms -all            # Stop OMS and WebLogic Admin Server
emctl status agent             # Agent status
emctl start agent              # Start agent
emctl stop agent               # Stop agent
emctl upload agent             # Force metric upload to OMS
emctl config agent listtargets # List targets discovered by agent
emctl secure oms               # Reconfigure OMS SSL certificate
emctl secure agent             # Re-register agent with OMS (use after OMS SSL change)
\`\`\`

### Key Ports

\`\`\`
7802  — OMS HTTP console
7803  — OMS HTTPS console (use this for all browser access)
4900  — Agent upload port (agents send metrics to OMS here)
3872  — Management Agent port (OMS connects to agent for jobs)
7301  — WebLogic Admin Server (OMS administration)
1521  — OMR database listener (default; adjust if non-standard)
\`\`\`

### Key Log Locations

\`\`\`
/u01/app/oracle/gc_inst/em/EMGC_OMS1/sysman/log/emoms.log
/u01/app/oracle/gc_inst/em/EMGC_OMS1/sysman/log/gcdriver.log
/u01/app/oracle/gc_inst/em/EMGC_ADMINSERVER/sysman/log/emoms.log
<AGENT_HOME>/sysman/log/gcagent.log
<AGENT_HOME>/sysman/log/emagent.nohup
\`\`\`

### Troubleshooting Quick Reference

| Symptom | First Check |
|---|---|
| OMS console unreachable | \`emctl status oms\` — is WebTier up? |
| Agent not uploading | \`emctl status agent\` — check Last Upload Time |
| Agent shows "not ready" | \`emctl secure agent\` — re-register with OMS |
| OMR tablespace full | Check \`mgmt_tablespace\` and \`mgmt_ecm_depot_ts\` sizes |
| OEM console slow | OMR AWR — check for latch/buffer waits during upload period |
| Patch download fails | Verify MOS credentials in OEM Setup and Software Library space |
| Metric alerts delayed | OMS job system — check for stuck MGMT_PURGE jobs in OMR |`,
};

async function main() {
  console.log('Inserting OEM installation runbook post...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: { ...post },
  });
  console.log('Inserted: "' + post.title + '"');
}

main().catch(console.error);
