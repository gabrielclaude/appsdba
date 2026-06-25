import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'OEM 13c Patching and Upgrade Runbook: Bundle Patch, OMSPatcher, Agent Gold Image, and Validation Scripts',
  slug: 'oem13c-patching-upgrades-runbook',
  excerpt:
    'Step-by-step runbook for patching Oracle Enterprise Manager 13c — pre-patch health checks, OMS Bundle Patch apply via OMSPatcher, plugin Bundle Patch application, Agent Gold Image creation and mass agent patching, OEM 13c release upgrade procedure, post-patch validation, and crontab monitoring scripts for OMS health, agent connectivity, and patch compliance.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-24'),
  youtubeUrl: null,
  content: `## Overview

This runbook covers the end-to-end procedure for patching Oracle Enterprise Manager 13c in a production environment:

1. Pre-patch health checks and backups
2. OPatch and OMSPatcher utility updates
3. OMS Bundle Patch application
4. Plugin Bundle Patch application
5. Agent Gold Image creation and mass agent patching
6. OEM 13c release upgrade (minor release)
7. Post-patch validation
8. Crontab monitoring scripts

---

## Environment Assumptions

| Component | Value (replace with site values) |
|-----------|----------------------------------|
| OMS hostname | oms-host.internal.company.com |
| OMS home | /u01/app/oracle/middleware |
| OMS instance home | /u01/app/oracle/gc_inst |
| Repository DB host | repo-db.internal.company.com |
| Repository DB SID | EMREP |
| Repository DB home | /u01/app/oracle/product/19.0.0/dbhome_1 |
| Agent home (reference) | /u01/app/oracle/agent/agent_13.5.0.0.0 |
| Patch staging area | /u01/patches/oem |
| OEM release | 13.5 |
| OS | RHEL 9 |
| Oracle user | oracle |

---

## Phase 1: Pre-Patch Health Checks

Run all health checks before opening a maintenance window or downloading patches. A failing health check means the current environment has a pre-existing issue — patching into a degraded environment increases the risk of unrecoverable failure.

### 1.1 OMS Status Check

\`\`\`bash
# Run as oracle user on oms-host
export OMS_HOME=/u01/app/oracle/middleware
export PATH=\${OMS_HOME}/bin:\${PATH}

# Full OMS status
emctl status oms -details

# Expected output (all services up):
# Oracle Management Service is Up
# HTTPS Console URL: https://oms-host.internal.company.com:7803/em
# Upload URL: https://oms-host.internal.company.com:4889/empbs/upload
# WLS Domain Information
#   Domain Name            : GCDomain
#   Admin Server Host      : oms-host.internal.company.com
# Oracle Management Service is Up
\`\`\`

### 1.2 Repository Database Health Check

\`\`\`bash
# Run as oracle user on repo-db host
export ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_SID=EMREP
export PATH=\${ORACLE_HOME}/bin:\${PATH}

sqlplus -S / as sysdba << 'SQL'
-- Confirm DB is open and in correct mode
SELECT NAME, OPEN_MODE, DATABASE_ROLE FROM V\$DATABASE;

-- Check for tablespace space issues
SELECT TABLESPACE_NAME,
       ROUND(USED_SPACE * 8192 / 1073741824, 2) AS USED_GB,
       ROUND(TABLESPACE_SIZE * 8192 / 1073741824, 2) AS TOTAL_GB,
       ROUND(100 * USED_SPACE / NULLIF(TABLESPACE_SIZE, 0), 1) AS PCT_USED
FROM DBA_TABLESPACE_USAGE_METRICS
ORDER BY PCT_USED DESC;

-- Check for invalid objects in SYSMAN schema
SELECT COUNT(*) AS INVALID_OBJECTS
FROM DBA_OBJECTS
WHERE OWNER IN ('SYSMAN', 'SYSMAN_MDS', 'SYSMAN_BIPLATFORM', 'SYSMAN_STB', 'SYSMAN_OPSS', 'SYSMAN_APM')
  AND STATUS = 'INVALID';

-- Check active sessions - must be low before maintenance window
SELECT COUNT(*) AS ACTIVE_SESSIONS FROM V\$SESSION WHERE STATUS = 'ACTIVE' AND USERNAME IS NOT NULL;
SQL
\`\`\`

### 1.3 Agent Connectivity Check

\`\`\`bash
# Report agents that are NOT up — these should be investigated before patching
# Run on OMS host via emcli
export OMS_HOME=/u01/app/oracle/middleware
export PATH=\${OMS_HOME}/bin:\${PATH}

\$OMS_HOME/bin/emcli login -username=sysman -password_file=/tmp/sysman_pwd.txt

\$OMS_HOME/bin/emcli get_targets -targets="oracle_emd" -format=name:csv \\
  | grep -v ",UP" | grep -v "^TARGET" || echo "All agents UP"

# Also check agent version distribution
\$OMS_HOME/bin/emcli list -resource="Agents" -columns="HOST_NAME,VERSION,STATUS" \\
  -format=name:csv 2>/dev/null | sort -t',' -k2,2 | head -30
\`\`\`

### 1.4 Disk Space Check

\`\`\`bash
# OMS home and staging area must have adequate free space
df -h /u01/app/oracle/middleware    # Need >= 10 GB free
df -h /u01/patches                  # Need >= 20 GB for patch staging
df -h /tmp                          # Need >= 2 GB for OMSPatcher temp files

# Repository DB data files
df -h /u01/app/oracle/oradata       # Need >= 5 GB for schema upgrade headroom
\`\`\`

### 1.5 Check Current Patch Level

\`\`\`bash
# OMS current patch inventory
\$OMS_HOME/OPatch/opatch lsinventory -detail | grep -E "Patch|Bundle|^Oracle"

# OMSPatcher current version
ls -la \$OMS_HOME/OMSPatcher/omspatcher

# Repository schema version
export ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_SID=EMREP
\$ORACLE_HOME/bin/sqlplus -S sysman/your_sysman_password << 'SQL'
SELECT PROPERTY_NAME, PROPERTY_VALUE FROM SYSMAN.MGMT_VERSIONS
WHERE PROPERTY_NAME IN ('REPOS_VERSION','OMS_PATCHSET_VERSION')
ORDER BY PROPERTY_NAME;
SQL
\`\`\`

---

## Phase 2: Backup Before Patching

Never begin OEM patching without a verified backup. OEM recovery from a failed patch without a backup typically requires a full reinstall.

### 2.1 Repository Database Backup

\`\`\`bash
# RMAN backup of the Repository DB
# Run on repo-db host as oracle user

export ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_SID=EMREP
export PATH=\${ORACLE_HOME}/bin:\${PATH}

rman target / << 'RMAN'
RUN {
  ALLOCATE CHANNEL c1 DEVICE TYPE DISK FORMAT '/u01/backup/rman/emrep/%d_%T_%s_%p.bkp';
  BACKUP AS COMPRESSED BACKUPSET DATABASE PLUS ARCHIVELOG DELETE INPUT;
  BACKUP CURRENT CONTROLFILE FORMAT '/u01/backup/rman/emrep/ctl_%T_%s.bkp';
  RELEASE CHANNEL c1;
}
LIST BACKUP SUMMARY;
RMAN

echo "RMAN backup complete: \$(date)"
\`\`\`

### 2.2 OMS Software Home Backup

\`\`\`bash
# Tar the OMS home before patching — provides rollback if patch corrupts OMS binaries
# Run on oms-host as oracle user

BACKUP_DIR=/u01/backup/oem_home
mkdir -p \${BACKUP_DIR}

echo "Backing up OMS home: \$(date)"
tar -czf \${BACKUP_DIR}/middleware_\$(date +%Y%m%d).tar.gz \\
  /u01/app/oracle/middleware \\
  2>/dev/null

echo "Backing up OMS instance home: \$(date)"
tar -czf \${BACKUP_DIR}/gc_inst_\$(date +%Y%m%d).tar.gz \\
  /u01/app/oracle/gc_inst \\
  2>/dev/null

ls -lh \${BACKUP_DIR}/
echo "OMS home backup complete: \$(date)"
\`\`\`

### 2.3 Export OMS Configuration

\`\`\`bash
# Export key OEM configuration — useful for reference during troubleshooting
export OMS_HOME=/u01/app/oracle/middleware
export PATH=\${OMS_HOME}/bin:\${PATH}

mkdir -p /u01/backup/oem_config

# Export OMS properties
emctl getproperty oms -name "*" > /u01/backup/oem_config/oms_properties_\$(date +%Y%m%d).txt 2>&1

# Copy key config files
cp \${OMS_HOME}/sysman/config/emoms.properties /u01/backup/oem_config/
cp \${OMS_HOME}/sysman/config/oms_connection.properties /u01/backup/oem_config/ 2>/dev/null
\`\`\`

---

## Phase 3: Update OPatch and OMSPatcher

The Bundle Patch readme specifies minimum required versions of OPatch and OMSPatcher. Update these utilities before applying any patch. Applying a patch with an older OPatch or OMSPatcher will fail the prerequisite check.

### 3.1 Download Latest OPatch and OMSPatcher

From My Oracle Support (MOS):
- **OPatch**: Patch 6880880 — select version for \`Oracle WebLogic Server 12.x / Fusion Middleware\` on \`Linux x86-64\`
- **OMSPatcher**: Patch 19999993 — select the latest version for OEM 13c

Stage both to the patch staging area:
\`\`\`bash
ls /u01/patches/oem/
# p6880880_122010_Linux-x86-64.zip   — OPatch
# p19999993_135000_Linux-x86-64.zip  — OMSPatcher
\`\`\`

### 3.2 Update OPatch in OMS Home

\`\`\`bash
export OMS_HOME=/u01/app/oracle/middleware

# Back up existing OPatch
mv \${OMS_HOME}/OPatch \${OMS_HOME}/OPatch_\$(date +%Y%m%d)

# Unzip new OPatch into OMS home
cd \${OMS_HOME}
unzip -q /u01/patches/oem/p6880880_122010_Linux-x86-64.zip

# Verify new OPatch version
\${OMS_HOME}/OPatch/opatch version
\`\`\`

### 3.3 Update OMSPatcher

\`\`\`bash
# Back up existing OMSPatcher
mv \${OMS_HOME}/OMSPatcher \${OMS_HOME}/OMSPatcher_\$(date +%Y%m%d)

# Unzip new OMSPatcher into OMS home
cd \${OMS_HOME}
unzip -q /u01/patches/oem/p19999993_135000_Linux-x86-64.zip

# Verify OMSPatcher version
\${OMS_HOME}/OMSPatcher/omspatcher version
\`\`\`

---

## Phase 4: Apply the OMS Bundle Patch

### 4.1 Download and Stage the Bundle Patch

From MOS, navigate to the OEM 13c Bundle Patch for the current quarter. The patch number changes each quarter — search for "Enterprise Manager Base Platform Bundle Patch" in the Patches & Updates section.

\`\`\`bash
# Example — the actual patch number varies by release quarter
ls /u01/patches/oem/
# p36991726_135000_Linux-x86-64.zip  — OEM 13.5 Bundle Patch (example number)

mkdir -p /u01/patches/oem/BP_135_Q2_2026
cd /u01/patches/oem/BP_135_Q2_2026
unzip -q /u01/patches/oem/p36991726_135000_Linux-x86-64.zip

ls -la /u01/patches/oem/BP_135_Q2_2026/
\`\`\`

### 4.2 Run OMSPatcher Prerequisite Check

Always run the prerequisite check before stopping the OMS. It validates patch compatibility, OPatch version, disk space, and conflict detection without making any changes.

\`\`\`bash
export OMS_HOME=/u01/app/oracle/middleware
export PATH=\${OMS_HOME}/OMSPatcher:\${OMS_HOME}/OPatch:\${PATH}
export JAVA_HOME=\${OMS_HOME}/oracle_common/jdk

cd /u01/patches/oem/BP_135_Q2_2026/36991726

# Run prereq check only — no changes applied
omspatcher prereq CheckConflictAgainstOHWithDetail \\
  -oh \${OMS_HOME} \\
  -phBaseDir /u01/patches/oem/BP_135_Q2_2026

# Review the output:
# "Prereq 'checkConflictAgainstOH' passed" — safe to proceed
# Any "FAILED" output requires investigation before patching
\`\`\`

### 4.3 Stop OMS

\`\`\`bash
export OMS_HOME=/u01/app/oracle/middleware
export PATH=\${OMS_HOME}/bin:\${PATH}

# Stop all OMS processes including Admin Server
emctl stop oms -all

# Verify OMS is fully stopped
emctl status oms
# Expected: Oracle Management Service is Down

# Also stop the WebLogic Node Manager if running
# (OMSPatcher will handle this, but verify it's stopped)
ps -ef | grep NodeManager | grep -v grep
\`\`\`

### 4.4 Apply the Bundle Patch with OMSPatcher

\`\`\`bash
export OMS_HOME=/u01/app/oracle/middleware
export PATH=\${OMS_HOME}/OMSPatcher:\${OMS_HOME}/OPatch:\${PATH}
export JAVA_HOME=\${OMS_HOME}/oracle_common/jdk

# The -invPtrLoc flag points to the OUI inventory pointer
# The sysman password is required for repository schema updates
omspatcher apply /u01/patches/oem/BP_135_Q2_2026/36991726 \\
  -oh \${OMS_HOME} \\
  -invPtrLoc \${OMS_HOME}/oraInst.loc \\
  2>&1 | tee /u01/patches/oem/BP_135_Q2_2026/omspatcher_apply_\$(date +%Y%m%d_%H%M).log

# When prompted, enter the sysman password for repository schema update step
# OMSPatcher will:
#   1. Apply software patches to OMS_HOME (via embedded OPatch)
#   2. Run DDL scripts against the Management Repository schema
#   3. Report success or failure for each step
\`\`\`

### 4.5 Verify Patch Application

\`\`\`bash
# Check the patch was registered in OPatch inventory
\${OMS_HOME}/OPatch/opatch lsinventory | grep -i "36991726\|Bundle Patch"

# Check OMSPatcher log for any SQL errors
grep -i "ERROR\|FAILED\|ORA-" /u01/patches/oem/BP_135_Q2_2026/omspatcher_apply_*.log | \\
  grep -v "no rows"
\`\`\`

### 4.6 Start OMS and Validate

\`\`\`bash
export OMS_HOME=/u01/app/oracle/middleware
export PATH=\${OMS_HOME}/bin:\${PATH}

emctl start oms

# Wait for full startup (3-5 minutes)
sleep 300

emctl status oms -details

# Expected:
# Oracle Management Service is Up
# Connected to Repository: EMREP on repo-db.internal.company.com
\`\`\`

---

## Phase 5: Apply Plugin Bundle Patches

Plugin patches are separate from the OMS Bundle Patch. Each deployed plugin has its own BP patch number on MOS. After applying the OMS BP, apply matching plugin BPs in the same maintenance window.

### 5.1 Identify Deployed Plugins and Current Versions

\`\`\`bash
export OMS_HOME=/u01/app/oracle/middleware
export PATH=\${OMS_HOME}/bin:\${PATH}

# List all deployed plugins and their versions
emcli login -username=sysman -password_file=/tmp/sysman_pwd.txt
emcli list -resource="Plugins" -columns="PLUGIN_ID,PLUGIN_VERSION,REVISION_VERSION" \\
  -format=name:csv 2>/dev/null
\`\`\`

Check MOS for the corresponding Plugin BP for each installed plugin at the same quarterly release as the OMS BP applied in Phase 4.

### 5.2 Download Plugin BPs and Stage

Common plugin patches (example patch numbers — verify current numbers on MOS):

| Plugin | MOS Search Term |
|--------|----------------|
| Oracle Database Plugin | "Enterprise Manager for Oracle Database Plugin Bundle Patch" |
| Oracle Middleware Plugin | "Enterprise Manager for Oracle Fusion Middleware Plugin Bundle Patch" |
| Oracle Virtualization Plugin | "Enterprise Manager for Oracle Virtualization Plugin Bundle Patch" |

\`\`\`bash
mkdir -p /u01/patches/oem/plugins/db_plugin
mkdir -p /u01/patches/oem/plugins/mw_plugin

# Unzip each plugin patch into its directory
cd /u01/patches/oem/plugins/db_plugin
unzip -q /u01/patches/oem/p36998800_135000_Linux-x86-64.zip

cd /u01/patches/oem/plugins/mw_plugin
unzip -q /u01/patches/oem/p36998801_135000_Linux-x86-64.zip
\`\`\`

### 5.3 Apply Plugin Bundle Patches

\`\`\`bash
export OMS_HOME=/u01/app/oracle/middleware
export PATH=\${OMS_HOME}/OMSPatcher:\${OMS_HOME}/OPatch:\${PATH}
export JAVA_HOME=\${OMS_HOME}/oracle_common/jdk

# OMS must be stopped during plugin patch apply
emctl stop oms -all

# Apply Database Plugin BP
# The -pluginId flag targets the specific plugin home within OMS_HOME
omspatcher apply /u01/patches/oem/plugins/db_plugin/36998800 \\
  -oh \${OMS_HOME} \\
  -invPtrLoc \${OMS_HOME}/oraInst.loc \\
  2>&1 | tee /u01/patches/oem/plugins/db_plugin_apply_\$(date +%Y%m%d_%H%M).log

# Apply Middleware Plugin BP
omspatcher apply /u01/patches/oem/plugins/mw_plugin/36998801 \\
  -oh \${OMS_HOME} \\
  -invPtrLoc \${OMS_HOME}/oraInst.loc \\
  2>&1 | tee /u01/patches/oem/plugins/mw_plugin_apply_\$(date +%Y%m%d_%H%M).log

# Restart OMS after all plugin patches are applied
emctl start oms
sleep 300
emctl status oms
\`\`\`

### 5.4 Deploy Updated Plugins to Agents

After plugin BPs are applied on the OMS, agents receive updated plugin software on their next heartbeat check-in. To force immediate deployment:

\`\`\`bash
# Trigger plugin deploy to all connected agents via emcli
emcli login -username=sysman -password_file=/tmp/sysman_pwd.txt

# List agents with outdated plugin versions
emcli list -resource="AgentPlugins" \\
  -columns="AGENT_HOST,PLUGIN_ID,AGENT_PLUGIN_VERSION,OMS_PLUGIN_VERSION" \\
  -format=name:csv 2>/dev/null | \\
  awk -F',' '\$3 != \$4 {print "MISMATCH: "\$1" "\$2" agent="\$3" oms="\$4}'
\`\`\`

---

## Phase 6: Agent Gold Image Patching

### 6.1 Patch the Reference Agent

Choose one agent as the reference (master) agent. Apply the Agent Bundle Patch to this agent using OPatch.

\`\`\`bash
# Run on the reference agent host as oracle user
export AGENT_HOME=/u01/app/oracle/agent/agent_13.5.0.0.0
export PATH=\${AGENT_HOME}/OPatch:\${PATH}

# Update OPatch in agent home
mv \${AGENT_HOME}/OPatch \${AGENT_HOME}/OPatch_\$(date +%Y%m%d)
cd \${AGENT_HOME}
unzip -q /u01/patches/oem/p6880880_122010_Linux-x86-64.zip

# Stage and unzip agent bundle patch
mkdir -p /u01/patches/oem/agent_bp
cd /u01/patches/oem/agent_bp
unzip -q /u01/patches/oem/p37000000_135000_Linux-x86-64.zip

# Stop the agent
\${AGENT_HOME}/bin/emctl stop agent

# Apply the agent bundle patch
\${AGENT_HOME}/OPatch/opatch apply /u01/patches/oem/agent_bp/37000000 \\
  -oh \${AGENT_HOME} \\
  -invPtrLoc \${AGENT_HOME}/oraInst.loc \\
  2>&1 | tee /u01/patches/oem/agent_bp/agent_opatch_\$(date +%Y%m%d_%H%M).log

# Start the agent
\${AGENT_HOME}/bin/emctl start agent
\${AGENT_HOME}/bin/emctl status agent

# Verify patch applied in inventory
\${AGENT_HOME}/OPatch/opatch lsinventory | grep "37000000\|Bundle"
\`\`\`

### 6.2 Create Agent Gold Image from Patched Agent

\`\`\`bash
# Run on OMS host via emcli
export OMS_HOME=/u01/app/oracle/middleware
export PATH=\${OMS_HOME}/bin:\${PATH}

emcli login -username=sysman -password_file=/tmp/sysman_pwd.txt

# Create a Gold Image from the reference agent
emcli create_gold_agent_image \\
  -image_name="OEM_Agent_13.5_BP_Q2_2026" \\
  -source_agent="ref-agent-host.internal.company.com:3872" \\
  -version="13.5.0.0.0" \\
  -description="Agent 13.5 with Q2 2026 Bundle Patch applied"

# Monitor the Gold Image creation job
emcli get_jobs -type="GoldImageCreate" -format=name:csv | head -5
\`\`\`

### 6.3 Subscribe Agents to the Gold Image

\`\`\`bash
# Subscribe all agents to the new Gold Image
# This does not immediately update agents — it marks them as subscribers
emcli subscribe_agents_to_gold_image \\
  -image_name="OEM_Agent_13.5_BP_Q2_2026" \\
  -targets="ALL_AGENTS"

# Verify subscription
emcli list -resource="GoldImageSubscriptions" \\
  -columns="AGENT_HOST,IMAGE_NAME,SUBSCRIPTION_STATUS" \\
  -format=name:csv 2>/dev/null | head -20
\`\`\`

### 6.4 Mass Agent Update

\`\`\`bash
# Stage 1: Update agents in non-production environments first
emcli update_agents_with_gold_image \\
  -image_name="OEM_Agent_13.5_BP_Q2_2026" \\
  -agent_groups="NonProd_Agents" \\
  -credential_name="HOST_NORMAL_CRED" \\
  -pre_script_on_oms="" \\
  -post_script_on_oms="" \\
  -stage_location="/tmp" \\
  -op_name="Agent_Update_NonProd_\$(date +%Y%m%d)"

# Monitor the update job
emcli get_jobs -type="GoldImageUpdate" -format=name:csv | head -5

# Stage 2: After non-prod agents confirm healthy (24-hour soak period recommended):
# Update production agents
emcli update_agents_with_gold_image \\
  -image_name="OEM_Agent_13.5_BP_Q2_2026" \\
  -agent_groups="Prod_Agents" \\
  -credential_name="HOST_NORMAL_CRED" \\
  -stage_location="/tmp" \\
  -op_name="Agent_Update_Prod_\$(date +%Y%m%d)"
\`\`\`

### 6.5 Individual Agent Manual Patch (Alternative)

For agents not covered by Gold Image (standalone hosts, special configurations):

\`\`\`bash
# Run on the individual agent host as oracle user
export AGENT_HOME=/u01/app/oracle/agent/agent_13.5.0.0.0
export PATH=\${AGENT_HOME}/OPatch:\${PATH}

\${AGENT_HOME}/bin/emctl stop agent

\${AGENT_HOME}/OPatch/opatch apply /u01/patches/oem/agent_bp/37000000 \\
  -oh \${AGENT_HOME} -invPtrLoc \${AGENT_HOME}/oraInst.loc

\${AGENT_HOME}/bin/emctl start agent
\${AGENT_HOME}/bin/emctl status agent | grep -E "OMS is|Agent is|Last Successful Upload"
\`\`\`

---

## Phase 7: OEM 13c Release Upgrade (Minor Release)

This phase applies when upgrading between OEM 13c minor releases (e.g., 13.4 → 13.5), not for Bundle Patch application. A release upgrade requires the OEM installer.

### 7.1 Pre-Upgrade Checks

\`\`\`bash
# Verify upgrade path is supported (check MOS Note 2651 for supported paths)
# For example: OEM 13.4 can upgrade directly to 13.5
# OEM 13.3 may require an intermediate step to 13.4 first

# Check current OEM release
export OMS_HOME=/u01/app/oracle/middleware
export PATH=\${OMS_HOME}/bin:\${PATH}
emctl status oms -details | grep "OMS Version"

# Check system prerequisites for the target release
# Minimum Java, OS, and Repository DB version requirements vary by target release
# Consult the OEM Release 13.5 Installation Guide on MOS

# Check for plugin compatibility with target OEM release
# All deployed plugins must have a version compatible with the target OEM release
emcli login -username=sysman -password_file=/tmp/sysman_pwd.txt
emcli list -resource="Plugins" -columns="PLUGIN_ID,PLUGIN_VERSION" -format=name:csv
\`\`\`

### 7.2 Download the OEM Installer

From MOS, download the OEM 13.5 installer for Linux x86-64:
- \`em135000_linux64-4.bin\` (part 1)
- \`em135000_linux64-5.bin\` (part 2)

\`\`\`bash
# Make the installer executable
chmod +x /u01/patches/oem/upgrade/em135000_linux64-4.bin

# Verify checksum against MOS-published values
sha256sum /u01/patches/oem/upgrade/em135000_linux64-4.bin
\`\`\`

### 7.3 Run the Upgrade Installer

\`\`\`bash
# Stop OMS fully before running the installer
export OMS_HOME=/u01/app/oracle/middleware
export PATH=\${OMS_HOME}/bin:\${PATH}
emctl stop oms -all

# Launch the installer in upgrade mode
# The installer detects the existing OMS home and presents upgrade options
/u01/patches/oem/upgrade/em135000_linux64-4.bin -J-Djava.io.tmpdir=/u01/patches/tmp \\
  INSTALL_SWONLY_WITH_PLUGINS=false \\
  2>&1 | tee /u01/patches/oem/upgrade/install_\$(date +%Y%m%d_%H%M).log

# The installer GUI will guide through:
# 1. Installation types — select "Upgrade an Existing Enterprise Manager System"
# 2. Source home selection — point to existing OMS_HOME
# 3. Prerequisite check — review and fix any failures
# 4. Repository upgrade confirmation
# 5. Apply

# For silent (non-GUI) upgrade, create a response file:
cat > /u01/patches/oem/upgrade/em_upgrade.rsp << 'RSP'
UNIX_GROUP_NAME=oinstall
INVENTORY_LOCATION=/u01/app/oraInventory
SECURITY_UPDATES_VIA_MYORACLESUPPORT=false
DECLINE_SECURITY_UPDATES=true
INSTALL_UPDATES_SELECTION=skip
MYORACLESUPPORT_USERNAME=
MYORACLESUPPORT_PASSWORD=
ALLOW_ONLY_SECURITY_UPDATES=false
ORACLE_MIDDLEWARE_HOME_LOCATION=/u01/app/oracle/middleware
ORACLE_HOSTNAME=oms-host.internal.company.com
ADMIN_PASSWORD=your_weblogic_admin_password
SYSMAN_PASSWORD=your_sysman_password
AGENT_REGISTRATION_PASSWORD=your_agent_reg_password
DATABASE_HOSTNAME=repo-db.internal.company.com
DATABASE_PORT=1521
DATABASE_SID=EMREP
DATABASE_SCHEMA_PASSWORD=your_sysman_password
RSP

/u01/patches/oem/upgrade/em135000_linux64-4.bin -silent \\
  -responseFile /u01/patches/oem/upgrade/em_upgrade.rsp \\
  2>&1 | tee /u01/patches/oem/upgrade/silent_install_\$(date +%Y%m%d_%H%M).log
\`\`\`

### 7.4 Post-Upgrade Agent Upgrade

After an OEM release upgrade, agents from the prior release need to be upgraded. The OEM console will show a "Upgrade Available" notification for each agent.

\`\`\`bash
# Create a Gold Image from the upgraded OMS's agent software
# (The OEM installer places a new agent version in $OMS_HOME/agent/agent_<new_version>)

# Alternatively, use the "Mass Agent Upgrade" feature in OEM console:
# OEM Console → Setup → Manage Cloud Control → Upgrade Agents
\`\`\`

---

## Phase 8: Post-Patch Validation

### 8.1 OMS Validation Script

\`\`\`bash
#!/bin/bash
# /opt/scripts/validate_oem_patch.sh
# Run after any OEM patching operation

export OMS_HOME=/u01/app/oracle/middleware
export PATH=\${OMS_HOME}/bin:\${PATH}

echo "=== OEM Post-Patch Validation: \$(date) ==="
echo ""

echo "--- 1. OMS Status ---"
emctl status oms -details
echo ""

echo "--- 2. Repository Connection ---"
emctl status oms | grep -E "Connected|Repository"
echo ""

echo "--- 3. Applied Patches ---"
\${OMS_HOME}/OPatch/opatch lsinventory | grep -E "Patch:|Bundle Patch:" | head -20
echo ""

echo "--- 4. OMS Console TLS ---"
openssl s_client -connect oms-host.internal.company.com:7803 \\
  </dev/null 2>/dev/null | openssl x509 -noout -subject -enddate
echo ""

echo "--- 5. Plugin Versions ---"
\${OMS_HOME}/bin/emcli login -username=sysman -password_file=/tmp/sysman_pwd.txt 2>/dev/null
\${OMS_HOME}/bin/emcli list -resource="Plugins" \\
  -columns="PLUGIN_ID,PLUGIN_VERSION,REVISION_VERSION" \\
  -format=name:csv 2>/dev/null
echo ""

echo "=== Validation Complete ==="
\`\`\`

### 8.2 Agent Connectivity Validation Script

\`\`\`bash
#!/bin/bash
# /opt/scripts/validate_agents_post_patch.sh
# Checks agent status and patch levels after mass agent patching

export OMS_HOME=/u01/app/oracle/middleware
export PATH=\${OMS_HOME}/bin:\${PATH}

TARGET_VERSION="13.5.0.0.0"    # Expected agent version after patching
TARGET_PATCH="37000000"          # Expected bundle patch ID
ALERT_EMAIL="dba-team@company.com"
LOG_FILE="/var/log/oem_monitor/agent_validation_\$(date +%Y%m%d).log"

mkdir -p /var/log/oem_monitor

echo "=== Agent Post-Patch Validation: \$(date) ===" >> "\${LOG_FILE}"

emcli login -username=sysman -password_file=/tmp/sysman_pwd.txt 2>/dev/null

# Count agents by status
echo "--- Agent Status Summary ---" >> "\${LOG_FILE}"
emcli get_targets -targets="oracle_emd" -format=name:csv 2>/dev/null | \\
  awk -F',' '{print \$4}' | sort | uniq -c >> "\${LOG_FILE}"

# List any agents that are DOWN
echo "" >> "\${LOG_FILE}"
echo "--- Agents NOT UP ---" >> "\${LOG_FILE}"
DOWN_AGENTS=\$(emcli get_targets -targets="oracle_emd" -format=name:csv 2>/dev/null | \\
  grep -v ",UP")

if [ -n "\${DOWN_AGENTS}" ]; then
  echo "\${DOWN_AGENTS}" >> "\${LOG_FILE}"
  echo -e "Subject: OEM Agent Down Alert\n\n\${DOWN_AGENTS}\n\nLog: \${LOG_FILE}" \\
    | sendmail "\${ALERT_EMAIL}"
else
  echo "All agents UP" >> "\${LOG_FILE}"
fi

cat "\${LOG_FILE}"
\`\`\`

### 8.3 Repository Validity Check Post-Patch

\`\`\`bash
export ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_SID=EMREP
export PATH=\${ORACLE_HOME}/bin:\${PATH}

sqlplus -S / as sysdba << 'SQL'
-- Check for invalid objects introduced by schema upgrade
SELECT OWNER, OBJECT_TYPE, COUNT(*) AS INVALID_COUNT
FROM DBA_OBJECTS
WHERE OWNER IN ('SYSMAN', 'SYSMAN_MDS', 'SYSMAN_BIPLATFORM', 'SYSMAN_STB')
  AND STATUS = 'INVALID'
GROUP BY OWNER, OBJECT_TYPE
ORDER BY INVALID_COUNT DESC;

-- Recompile any invalid objects (run if count > 0)
-- EXEC UTL_RECOMP.RECOMP_PARALLEL(8);

-- Check OEM schema version matches applied patch
SELECT PROPERTY_NAME, PROPERTY_VALUE FROM SYSMAN.MGMT_VERSIONS
ORDER BY PROPERTY_NAME;
SQL
\`\`\`

---

## Phase 9: Monitoring Scripts

### Script 1: OMS Health Monitor

\`\`\`bash
#!/bin/bash
# /opt/scripts/check_oms_health.sh
# Continuous OMS health check — run via crontab every 10 minutes

export OMS_HOME=/u01/app/oracle/middleware
export PATH=\${OMS_HOME}/bin:\${PATH}

ALERT_EMAIL="dba-team@company.com"
LOG_FILE="/var/log/oem_monitor/oms_health_\$(date +%Y%m%d).log"
PAGERDUTY_KEY="your_pagerduty_integration_key"

mkdir -p /var/log/oem_monitor
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')

OMS_STATUS=\$(emctl status oms 2>&1)
IS_UP=\$(echo "\${OMS_STATUS}" | grep -c "Oracle Management Service is Up")

echo "\${TIMESTAMP}: OMS Up=\${IS_UP}" >> "\${LOG_FILE}"

if [ "\${IS_UP}" -ne 1 ]; then
  MSG="CRITICAL: OMS is DOWN on oms-host.internal.company.com at \${TIMESTAMP}"
  echo "\${MSG}" >> "\${LOG_FILE}"
  echo "\${OMS_STATUS}" >> "\${LOG_FILE}"
  echo -e "Subject: CRITICAL: OEM OMS is DOWN\n\n\${MSG}\n\n\${OMS_STATUS}" \\
    | sendmail "\${ALERT_EMAIL}"
fi
\`\`\`

### Script 2: Agent Patch Compliance Report

\`\`\`bash
#!/bin/bash
# /opt/scripts/check_agent_patch_compliance.sh
# Weekly report of agent patch compliance across all managed hosts

export OMS_HOME=/u01/app/oracle/middleware
export PATH=\${OMS_HOME}/bin:\${PATH}

EXPECTED_PATCH="37000000"
ALERT_EMAIL="dba-team@company.com"
REPORT_FILE="/var/log/oem_monitor/agent_compliance_\$(date +%Y%m%d).log"

mkdir -p /var/log/oem_monitor

echo "=== Agent Patch Compliance Report: \$(date) ===" > "\${REPORT_FILE}"
echo "Expected Bundle Patch: \${EXPECTED_PATCH}" >> "\${REPORT_FILE}"
echo "" >> "\${REPORT_FILE}"

emcli login -username=sysman -password_file=/tmp/sysman_pwd.txt 2>/dev/null

# Get agent patch inventory for all agents
NON_COMPLIANT=\$(emcli list -resource="AgentBundlePatchComplianceReport" \\
  -columns="AGENT_HOST,AGENT_VERSION,BUNDLE_PATCH_ID,COMPLIANCE_STATUS" \\
  -format=name:csv 2>/dev/null | grep -v ",COMPLIANT" | grep -v "^TARGET")

printf "%-45s %-18s %-15s %s\n" "AGENT HOST" "VERSION" "PATCH ID" "STATUS" >> "\${REPORT_FILE}"
echo "\$(printf '%0.s-' {1..100})" >> "\${REPORT_FILE}"

if [ -n "\${NON_COMPLIANT}" ]; then
  echo "\${NON_COMPLIANT}" | while IFS=',' read -r HOST VER PATCH STATUS; do
    printf "%-45s %-18s %-15s %s\n" "\${HOST}" "\${VER}" "\${PATCH}" "\${STATUS}"
  done >> "\${REPORT_FILE}"

  echo -e "Subject: OEM Agent Patch Compliance Report — Non-Compliant Agents Found\n\n\$(cat \${REPORT_FILE})" \\
    | sendmail "\${ALERT_EMAIL}"
else
  echo "All agents COMPLIANT with patch \${EXPECTED_PATCH}" >> "\${REPORT_FILE}"
fi

cat "\${REPORT_FILE}"
\`\`\`

### Script 3: Pending Patch Alert

\`\`\`bash
#!/bin/bash
# /opt/scripts/check_pending_oem_patches.sh
# Monthly check — alerts when OEM BP has been available on MOS for > 30 days
# without being applied (requires emcli with Patch Advisory feature)

export OMS_HOME=/u01/app/oracle/middleware
export PATH=\${OMS_HOME}/bin:\${PATH}

ALERT_EMAIL="dba-team@company.com"
LOG_FILE="/var/log/oem_monitor/patch_advisory_\$(date +%Y%m%d).log"
DAYS_THRESHOLD=30

mkdir -p /var/log/oem_monitor
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
echo "=== Pending Patch Advisory: \${TIMESTAMP} ===" > "\${LOG_FILE}"

emcli login -username=sysman -password_file=/tmp/sysman_pwd.txt 2>/dev/null

# Check for OEM patches not yet applied
PENDING=\$(emcli list -resource="PatchAdvisories" \\
  -columns="PATCH_ID,PATCH_TYPE,RELEASE_DATE,APPLIED" \\
  -format=name:csv 2>/dev/null | grep ",N$")

if [ -n "\${PENDING}" ]; then
  echo "Unapplied patches:" >> "\${LOG_FILE}"
  echo "\${PENDING}" >> "\${LOG_FILE}"
  echo -e "Subject: OEM Patch Advisory — Unapplied Patches\n\n\$(cat \${LOG_FILE})" \\
    | sendmail "\${ALERT_EMAIL}"
else
  echo "No pending unapplied patches found." >> "\${LOG_FILE}"
fi
\`\`\`

### Crontab Configuration

\`\`\`bash
# /etc/cron.d/oem_monitor
# OEM 13c patching and health monitoring

MAILTO=""
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# OMS health check — every 10 minutes
*/10 * * * *    oracle  /opt/scripts/check_oms_health.sh >> /var/log/oem_monitor/cron.log 2>&1

# Agent patch compliance — weekly on Monday at 7am
0 7 * * 1       oracle  /opt/scripts/check_agent_patch_compliance.sh >> /var/log/oem_monitor/cron.log 2>&1

# Pending patch advisory — first of each month at 9am
0 9 1 * *       oracle  /opt/scripts/check_pending_oem_patches.sh >> /var/log/oem_monitor/cron.log 2>&1

# Post-patch validation — run manually after each patching operation
# /opt/scripts/validate_oem_patch.sh
# /opt/scripts/validate_agents_post_patch.sh
\`\`\`

---

## Rollback Procedure

If OMSPatcher apply fails partway through and OMS cannot start:

\`\`\`bash
# Step 1: Check OMSPatcher log to determine how far patching got
grep -E "ERROR|FAILED|Step [0-9]" /u01/patches/oem/BP_135_Q2_2026/omspatcher_apply_*.log

# Step 2: If software-only steps completed but SQL failed:
# Roll back using OMSPatcher rollback
export OMS_HOME=/u01/app/oracle/middleware
export PATH=\${OMS_HOME}/OMSPatcher:\${OMS_HOME}/OPatch:\${PATH}
export JAVA_HOME=\${OMS_HOME}/oracle_common/jdk

omspatcher rollback -id 36991726 \\
  -oh \${OMS_HOME} \\
  -invPtrLoc \${OMS_HOME}/oraInst.loc

# Step 3: If rollback fails — restore from OMS home backup
emctl stop oms -all 2>/dev/null

# Restore OMS home from backup
cd /
tar -xzf /u01/backup/oem_home/middleware_\$(date +%Y%m%d).tar.gz

# Restore instance home
tar -xzf /u01/backup/oem_home/gc_inst_\$(date +%Y%m%d).tar.gz

# Restore repository DB from RMAN (only if SQL steps modified schema)
# rman target / << 'RMAN'
# RESTORE DATABASE;
# RECOVER DATABASE;
# ALTER DATABASE OPEN RESETLOGS;
# RMAN

emctl start oms
emctl status oms
\`\`\`

---

## Summary

OEM 13c Bundle Patch application follows a strict sequence: health check → backup → update OPatch/OMSPatcher → run prereq check → stop OMS → apply with OMSPatcher → start OMS → apply Plugin BPs → validate. OMSPatcher must be used instead of plain OPatch for any patch that includes repository schema changes — applying a Bundle Patch with OPatch alone leaves the repository schema unmodified and causes version mismatch failures on OMS startup. Plugin BPs are separate from the OMS BP, have separate MOS patch numbers, and must be applied in the same maintenance window or immediately after. Agent patching at scale uses Agent Gold Image: patch one reference agent, create a Gold Image, subscribe all agents, then trigger mass update in waves (non-prod first, prod after 24-hour soak). Repository Database patching is an independent activity that must be completed in a separate maintenance window at least one week before OEM software patching. The three monitoring scripts — OMS health check (every 10 minutes), weekly agent patch compliance report, and monthly pending patch advisory — provide operational visibility between quarterly patching windows.`,
};

async function main() {
  console.log('Inserting OEM 13c patching runbook...');
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
