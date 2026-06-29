import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS 12.1.3 to 12.2.11 Upgrade Runbook',
  slug: 'oracle-ebs-12211-upgrade-runbook',
  excerpt:
    'Complete step-by-step runbook for upgrading Oracle EBS from 12.1.3 to 12.2.11: pre-upgrade patch requirements (AD Delta, TXK Delta), Oracle Database 11.2.0.4 to 19c upgrade via DBUA, EBS 12.2 application upgrade driver, technology stack replacement with Rapid Install, Edition-Based Redefinition setup, AD and TXK RUP application, 12.2.11 RUP via adop, post-upgrade validation, and monitoring scripts. Also covers the simpler 12.2.x to 12.2.11 RUP-only path.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-29'),
  youtubeUrl: null,
  content: `## Overview

This runbook covers two upgrade scenarios:

**Scenario A**: Full upgrade from EBS 12.1.3 to EBS 12.2.11 — covers all phases including database upgrade, application upgrade driver, technology stack replacement, online patching setup, and RUP application. Plan a 36–72 hour maintenance window for production.

**Scenario B**: RUP-only upgrade from EBS 12.2.x to 12.2.11 — the instance is already on EBS 12.2, the online patching architecture is in place, and the upgrade is accomplished by applying the 12.2.11 RUP via adop. Jump directly to Phase 8.

**Assumptions**:
- Source: EBS 12.1.3 on Oracle Database 11.2.0.4 on RHEL 7 or 8
- Target: EBS 12.2.11 on Oracle Database 19c (same servers, in-place upgrade)
- All EBS users are notified of the maintenance window
- A full RMAN backup of the source environment has been completed and verified
- A test upgrade has been completed on a clone before running on production

---

## Phase 0: Pre-Upgrade Assessment and Staging

### 0.1 Verify Source EBS Release Level

\`\`\`sql
-- Connect as APPS on the source 12.1.3 database
SELECT RELEASE_NAME, LAST_UPDATE_DATE
FROM FND_PRODUCT_GROUPS;

-- Verify 12.1.3 is the source (output should show 12.1.3)
-- Also check the AD and TXK patch levels
SELECT BUG_NUMBER, LAST_UPDATE_DATE
FROM AD_BUGS
WHERE BUG_NUMBER IN (
  '9239090',  -- AD Delta 9 (minimum required)
  '8919491'   -- TXK Delta H (minimum required)
)
ORDER BY LAST_UPDATE_DATE DESC;
\`\`\`

### 0.2 Check Customization Compatibility

\`\`\`sql
-- Identify custom objects in APPS schema that must be reviewed for EBR compatibility
-- Custom packages that wrap standard EBS APIs must be made editionable in 12.2
SELECT OBJECT_TYPE, OBJECT_NAME, STATUS
FROM DBA_OBJECTS
WHERE OWNER = 'APPS'
AND OBJECT_NAME NOT IN (
  SELECT OBJECT_NAME FROM DBA_OBJECTS
  WHERE OWNER = 'APPS' AND LAST_DDL_TIME < (
    SELECT MIN(CREATION_DATE) FROM AD_BUGS WHERE BUG_NUMBER LIKE '122%'
  )
)
AND OBJECT_TYPE IN ('PACKAGE','PACKAGE BODY','PROCEDURE','FUNCTION','TRIGGER','VIEW')
AND OBJECT_NAME LIKE 'XX%'  -- common custom prefix pattern
ORDER BY OBJECT_TYPE, OBJECT_NAME;
\`\`\`

### 0.3 Apply Minimum Pre-Upgrade Patches on Source

Apply these patches on the **source 12.1.3** environment before starting the upgrade:

\`\`\`bash
# Source the 12.1.3 environment
source \${APPL_TOP}/APPSORA.env

# Apply the latest AD Delta (cumulative — apply highest available)
# Download from MOS and apply via adpatch
adpatch options=nocompiledb,nocompilejsp driver=u9239090.drv

# Apply the latest TXK Delta
adpatch options=nocompiledb,nocompilejsp driver=u8919491.drv

# After patching, compile all APPS objects
adadmin << 'EOF'
2
4
EOF
# Menu: 2 = Compile/Reload Database Objects, 4 = Compile APPS schema
\`\`\`

### 0.4 Download and Stage Upgrade Media

Download the following from My Oracle Support and stage in \`/u05/upgrade_staging/\`:

- Oracle EBS 12.2 Rapid Install media (for the technology stack)
- Oracle EBS 12.2 Upgrade Driver (from MOS Doc ID 1494158.1)
- Oracle Database 19c installation media
- Oracle Database 19c latest RU/RUR recommended for EBS (MOS Doc ID 2580900.1)
- AD RUP for 12.2 (latest version)
- TXK RUP for 12.2 (latest version)
- EBS 12.2.11 RUP (download individual module zips or the complete bundle)

\`\`\`bash
# Verify staging space (need 100+ GB)
df -h /u05/upgrade_staging/
ls -lh /u05/upgrade_staging/
\`\`\`

### 0.5 Pre-Upgrade RMAN Backup

\`\`\`bash
# Full RMAN backup — verify before starting downtime
rman target / << 'RMAN_EOF'
BACKUP DATABASE PLUS ARCHIVELOG TAG 'PRE_UPGRADE_122_BACKUP';
LIST BACKUP TAG 'PRE_UPGRADE_122_BACKUP';
VALIDATE BACKUPSET ALL;
RMAN_EOF
\`\`\`

---

## Phase 1: Shut Down EBS (Maintenance Window Begins)

\`\`\`bash
# Notify users — maintenance window begins
# Shut down all EBS application tier services
source \${APPL_TOP}/APPSORA.env

\${ADMIN_SCRIPTS_HOME}/adstpall.sh apps/\${APPS_PASSWORD}
\${ADMIN_SCRIPTS_HOME}/adcmctl.sh stop apps/\${APPS_PASSWORD}

# Verify all services are stopped
\${ADMIN_SCRIPTS_HOME}/adstpall.sh status apps/\${APPS_PASSWORD}

# On the database server, stop the database listener (leave DB up for now)
lsnrctl stop
\`\`\`

---

## Phase 2: Oracle Database Upgrade — 11.2.0.4 to 19c

### 2.1 Install Oracle 19c RDBMS (New ORACLE_HOME)

\`\`\`bash
# Install Oracle 19c binaries into a NEW Oracle home — do not overwrite 11g
# Run as oracle user
NEW_OH=/u01/app/oracle/product/19.0.0/dbhome_1
mkdir -p \${NEW_OH}

# Silent install
cd /u05/upgrade_staging/db19c/
./runInstaller -silent -ignorePrereqFailure \\
  oracle.install.option=INSTALL_DB_SWONLY \\
  ORACLE_HOSTNAME=\$(hostname -f) \\
  UNIX_GROUP_NAME=oinstall \\
  INVENTORY_LOCATION=/u01/app/oracle/oraInventory \\
  ORACLE_HOME=\${NEW_OH} \\
  ORACLE_BASE=/u01/app/oracle \\
  oracle.install.db.InstallEdition=EE \\
  oracle.install.db.OSDBA_GROUP=dba \\
  oracle.install.db.OSOPER_GROUP=oper \\
  oracle.install.db.OSBACKUPDBA_GROUP=backupdba \\
  oracle.install.db.OSDGDBA_GROUP=dgdba \\
  oracle.install.db.OSKMDBA_GROUP=kmdba \\
  oracle.install.db.OSRACDBA_GROUP=racdba \\
  DECLINE_SECURITY_UPDATES=true

# Run root scripts when prompted
/u01/app/oracle/oraInventory/orainstRoot.sh
\${NEW_OH}/root.sh
\`\`\`

### 2.2 Apply Oracle 19c RU Recommended for EBS

\`\`\`bash
# Apply the 19c RU before running DBUA (patch in the 19c home)
export ORACLE_HOME=\${NEW_OH}
cd /u05/upgrade_staging/19c_ru/

\${NEW_OH}/OPatch/opatch apply -silent
\`\`\`

### 2.3 Run Pre-Upgrade Information Tool

\`\`\`bash
# Run from the NEW 19c Oracle home against the EXISTING 11g database
# This generates the preupgrade_fixups.sql and postupgrade_fixups.sql
export ORACLE_HOME=\${NEW_OH}
export ORACLE_SID=EBSPRD

# Start the 11g database with the OLD Oracle home first
OLD_OH=/u01/app/oracle/product/11.2.0.4/dbhome_1
export ORACLE_HOME=\${OLD_OH}
sqlplus / as sysdba << 'SQL'
STARTUP;
EXIT;
SQL

# Run the pre-upgrade tool using the NEW 19c home's Java
\${NEW_OH}/jdk/bin/java -jar \${NEW_OH}/rdbms/admin/preupgrade.jar \\
  FILE DIR /tmp/preupgrade_output TEXT

# Review the output files
ls /tmp/preupgrade_output/
cat /tmp/preupgrade_output/preupgrade.log
\`\`\`

### 2.4 Run Pre-Upgrade Fixup Scripts

\`\`\`bash
export ORACLE_HOME=\${OLD_OH}
export ORACLE_SID=EBSPRD

sqlplus / as sysdba << 'SQL'
-- Run the pre-upgrade fixup script generated by the tool
@/tmp/preupgrade_output/preupgrade_fixups.sql

-- Gather dictionary statistics before upgrade
EXEC DBMS_STATS.GATHER_DICTIONARY_STATS;

-- Purge the recyclebin
PURGE DBA_RECYCLEBIN;

EXIT;
SQL
\`\`\`

### 2.5 Run DBUA to Upgrade the Database

\`\`\`bash
# Switch to the 19c home
export ORACLE_HOME=\${NEW_OH}
export ORACLE_SID=EBSPRD

# Run DBUA in silent mode
\${NEW_OH}/bin/dbua -silent \\
  -sid EBSPRD \\
  -oracleHome \${NEW_OH} \\
  -sysDBAUserName sys \\
  -sysDBAPassword \${SYS_PASSWORD} \\
  -upgradeTimezone true \\
  -recompile_invalid_objects true \\
  -degree_of_parallelism 4 \\
  -initParam "parallel_max_servers=0" \\
  -ignorePreReqs

# Monitor DBUA progress in the log
tail -f /u01/app/oracle/cfgtoollogs/dbua/EBSPRD/*/upgradeActions*.log
\`\`\`

### 2.6 Post-Database-Upgrade Validation

\`\`\`sql
export ORACLE_HOME=\${NEW_OH}
export ORACLE_SID=EBSPRD

sqlplus / as sysdba << 'SQL'
-- Confirm database is on 19c
SELECT VERSION, OPEN_MODE, LOG_MODE FROM V\$DATABASE, V\$INSTANCE;

-- Run post-upgrade fixups
@/tmp/preupgrade_output/postupgrade_fixups.sql

-- Recompile any remaining invalid objects
@\${ORACLE_HOME}/rdbms/admin/utlrp.sql

-- Check for invalids (target: 0 in APPS-owned editionable objects)
SELECT COUNT(*), STATUS FROM DBA_OBJECTS WHERE OWNER = 'APPS' GROUP BY STATUS;

-- Apply EBS-specific 19c parameter recommendations
ALTER SYSTEM SET "_optimizer_adaptive_plans"=FALSE SCOPE=SPFILE;
ALTER SYSTEM SET "_optimizer_use_feedback"=FALSE SCOPE=SPFILE;
ALTER SYSTEM SET "_b_tree_bitmap_plans"=FALSE SCOPE=SPFILE;
ALTER SYSTEM SET CURSOR_SHARING=EXACT SCOPE=SPFILE;

EXIT;
SQL
\`\`\`

---

## Phase 3: EBS Application Upgrade — 12.1.3 to 12.2

### 3.1 Set Up the New EBS 12.2 Technology Stack (Rapid Install)

Run the EBS 12.2 Rapid Install in **upgrade mode** on the application server. This installs the FMW technology stack (WebLogic, OHS, Forms 12c) without creating a new EBS instance.

\`\`\`bash
# On the application tier server as root (or oracle with sudo)
cd /u05/upgrade_staging/ebs122_rapid_install/

# Run in upgrade mode — installs FMW stack alongside existing 12.1.3 stack
./rapidwiz -techstack_only \\
  -upgrade \\
  -contextFile /u01/oracle/EBS/inst/apps/\${CONTEXT_NAME}/appl/admin/\${CONTEXT_NAME}.xml

# Follow prompts — select EBS 12.2, provide target Oracle Home paths
# This step installs:
#   - Oracle WebLogic Server
#   - Oracle HTTP Server 12c
#   - Oracle Forms and Reports 12c
#   - FMW common utilities
\`\`\`

### 3.2 Apply the EBS 12.2 Upgrade Driver

The upgrade driver is the main upgrade patch that installs 12.2 application code on the 12.1.3 schema. This is the longest step.

\`\`\`bash
# Source the 12.1.3 APPL_TOP environment
source \${APPL_TOP}/APPSORA.env

# Stage the upgrade patch
cd /u05/upgrade_staging/ebs_12.2_upgrade_patch/

# Apply the upgrade driver — this runs against the 12.1.3 database
# Use adpatch (not adop — the online patching infrastructure doesn't exist yet)
adpatch options=nocompiledb,nocompilejsp driver=u\${UPGRADE_PATCH_NUMBER}.drv

# This step runs for many hours on large instances
# Monitor with:
tail -f \${APPL_TOP}/admin/\${CONTEXT_NAME}/log/adpatch.log
\`\`\`

\`\`\`sql
-- Monitor upgrade driver progress
SELECT PHASE_NUMBER, PHASE_STATUS, START_DATE, END_DATE
FROM AD_ADPATCH_PHASES
ORDER BY PHASE_NUMBER;
\`\`\`

### 3.3 Apply AD and TXK Technology Stack RUPs

After the upgrade driver, apply the latest AD and TXK RUPs to bring the technology stack to current:

\`\`\`bash
# Apply AD RUP for EBS 12.2
cd /u05/upgrade_staging/AD_RUP/
adpatch options=nocompiledb driver=u\${AD_RUP_PATCH_NUMBER}.drv

# Apply TXK RUP for EBS 12.2
cd /u05/upgrade_staging/TXK_RUP/
adpatch options=nocompiledb driver=u\${TXK_RUP_PATCH_NUMBER}.drv
\`\`\`

---

## Phase 4: Enable Online Patching (EBR Setup)

This phase configures Edition-Based Redefinition and the dual-filesystem architecture. It is run once — it permanently transforms the EBS 12.2 instance into an online-patching-capable environment.

### 4.1 Run Online Patching Setup Script

\`\`\`bash
# Source the 12.2 environment (now active after the upgrade driver)
source \${APPL_TOP}/APPSORA.env

# Run the online patching enablement script
# This creates the database editions and grants EBR privileges
cd \${AD_TOP}/patch/115/sql/

sqlplus / as sysdba << 'SQL'
-- Grant edition privileges to APPS and all EBS schema owners
@adgrants.sql APPS

-- Create the initial EBS runtime edition
-- (script varies by AD RUP version — check MOS Doc ID 1531121.1)
@adzdpatch.sql
EXIT;
SQL
\`\`\`

### 4.2 Initialize the Dual-Filesystem Structure

\`\`\`bash
# Run the online patching infrastructure setup
# This creates fs1, fs2, and fs_ne filesystem structures
perl \${AD_TOP}/bin/adSetupFS.pl contextfile=\${CONTEXT_FILE} \\
  run=\${RUN_EDITION} patch=\${PATCH_EDITION}

# Confirm the filesystem structure was created
ls -la /u01/oracle/EBS/
# Expected: fs1/  fs2/  fs_ne/
\`\`\`

### 4.3 Run AutoConfig on the New Structure

\`\`\`bash
source /u01/oracle/EBS/EBSapps.env run
\${ADMIN_SCRIPTS_HOME}/adautocfg.sh apps/\${APPS_PASSWORD}

# Confirm AutoConfig completed successfully
grep "AutoConfig completed" /u01/oracle/EBS/fs1/inst/apps/\${CONTEXT_NAME}/admin/log/cfgcheck.log
\`\`\`

---

## Phase 5: Start EBS 12.2 and Validate Baseline

### 5.1 Start All EBS Services

\`\`\`bash
source /u01/oracle/EBS/EBSapps.env run

# Start EBS services with the new 12.2 technology stack
\${ADMIN_SCRIPTS_HOME}/adstrtal.sh apps/\${APPS_PASSWORD}
\${ADMIN_SCRIPTS_HOME}/adcmctl.sh start apps/\${APPS_PASSWORD}

# Check service status
\${ADMIN_SCRIPTS_HOME}/adstpall.sh status apps/\${APPS_PASSWORD}
\`\`\`

### 5.2 Validate EBS 12.2 Baseline

\`\`\`sql
-- Confirm release is now 12.2
SELECT RELEASE_NAME FROM FND_PRODUCT_GROUPS;

-- Confirm editions were created
SELECT EDITION_NAME, PARENT_EDITION_NAME, USABLE
FROM DBA_EDITIONS
ORDER BY EDITION_NAME;

-- Confirm database default edition
SELECT PROPERTY_VALUE AS DEFAULT_EDITION
FROM DATABASE_PROPERTIES
WHERE PROPERTY_NAME = 'DEFAULT_EDITION';

-- Confirm APPS can connect to the new EBS 12.2 environment
-- Login as SYSADMIN via browser and verify System Administrator responsibility loads
\`\`\`

---

## Phase 6: Apply the EBS 12.2.11 RUP via adop

With the baseline 12.2 environment running and online patching enabled, apply the 12.2.11 RUP to reach the current code level.

### 6.1 Merge and Stage the 12.2.11 RUP Patches

\`\`\`bash
# The 12.2.11 RUP is distributed as individual module patches
# Merge them with admrgpch for a single adop cycle
MERGE_DIR=/u05/upgrade_staging/rup_1211_merged

mkdir -p \${MERGE_DIR}
admrgpch \${RUP_PATCH_DIR}/\${MODULE1_PATCH} \${RUP_PATCH_DIR}/\${MODULE2_PATCH} \\
  -d \${MERGE_DIR}
\`\`\`

### 6.2 Run the Full adop Cycle for the RUP

\`\`\`bash
source /u01/oracle/EBS/EBSapps.env run

# Prepare
adop phase=prepare workers=8

# Apply the RUP (this runs while EBS is live)
adop phase=apply merge_patch_directory=\${MERGE_DIR} workers=8

# Finalize
adop phase=finalize workers=8

# Cutover (brief outage — 15-30 minutes)
adop phase=cutover workers=8

# Cleanup (run after validation)
adop phase=cleanup workers=8
\`\`\`

### 6.3 Verify 12.2.11 Is Active

\`\`\`sql
-- Confirm release_name shows 12.2.11
SELECT RELEASE_NAME, LAST_UPDATE_DATE FROM FND_PRODUCT_GROUPS;

-- Confirm the RUP bugs are in the applied patch registry
-- (replace with actual RUP bug numbers from the patch readme)
SELECT BUG_NUMBER, LAST_UPDATE_DATE
FROM AD_BUGS
WHERE BUG_NUMBER IN ('&rup_bug_number_1', '&rup_bug_number_2')
ORDER BY LAST_UPDATE_DATE DESC;
\`\`\`

---

## Phase 7: Post-Upgrade Validation

### 7.1 Database Object Validation

\`\`\`sql
-- All APPS objects should be VALID (or INVALID only in non-editioned types)
SELECT COUNT(*), STATUS, OBJECT_TYPE
FROM DBA_OBJECTS
WHERE OWNER = 'APPS'
GROUP BY STATUS, OBJECT_TYPE
ORDER BY STATUS, OBJECT_TYPE;

-- Recompile any remaining invalids
BEGIN
  DBMS_UTILITY.COMPILE_SCHEMA(schema => 'APPS', compile_all => FALSE);
END;
/

-- Validate EBS grants are intact
SELECT GRANTEE, PRIVILEGE, GRANTED_ROLE
FROM DBA_SYS_PRIVS
WHERE GRANTEE IN ('APPS','APPLSYS')
AND PRIVILEGE IN ('CREATE EDITION','ALTER SESSION')
ORDER BY GRANTEE, PRIVILEGE;
\`\`\`

### 7.2 Functional Smoke Tests

Run these in sequence via the EBS front-end after all services are up:

\`\`\`
1. Login as SYSADMIN — verify System Administrator responsibility loads
2. Navigate to: Help > About Oracle Applications
   - Confirm version shows 12.2.11
   - Confirm patch list includes the RUP
3. Run the "Active Users" concurrent program — verify it completes with status Completed Normal
4. Open a key module (GL, AP, AR, PO) and run a simple transaction or inquiry
5. Verify forms open correctly (not a blank white screen — common JVM issue)
6. Run a simple OBIEE or XML Publisher report if licensed
\`\`\`

### 7.3 AutoConfig Validation

\`\`\`bash
# Run AutoConfig on both filesystems and confirm no errors
source /u01/oracle/EBS/EBSapps.env run
\${ADMIN_SCRIPTS_HOME}/adautocfg.sh apps/\${APPS_PASSWORD}

# Check the AutoConfig log for errors
grep -i "ERROR\|FAILED\|WARNING" \
  /u01/oracle/EBS/fs1/inst/apps/\${CONTEXT_NAME}/admin/log/cfgcheck.log | \
  grep -v "^#"
\`\`\`

### 7.4 Concurrent Manager Health Check

\`\`\`sql
-- Verify standard managers are running
SELECT CONCURRENT_QUEUE_NAME, RUNNING_PROCESSES, MAX_PROCESSES,
       WORKER_COUNT
FROM FND_CONCURRENT_QUEUES_VL
WHERE ENABLED_FLAG = 'Y'
AND RUNNING_PROCESSES > 0
ORDER BY CONCURRENT_QUEUE_NAME;

-- Check for stuck or long-running requests that may need attention post-upgrade
SELECT REQUEST_ID,
       CONCURRENT_PROGRAM_NAME,
       ROUND((SYSDATE - ACTUAL_START_DATE)*60,0) AS MINUTES_RUNNING,
       STATUS_CODE
FROM FND_CONCURRENT_REQUESTS FCR
JOIN FND_CONCURRENT_PROGRAMS_VL FCPV
  ON FCR.CONCURRENT_PROGRAM_ID = FCPV.CONCURRENT_PROGRAM_ID
WHERE STATUS_CODE = 'R'
ORDER BY MINUTES_RUNNING DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

---

## Scenario B: 12.2.x to 12.2.11 RUP-Only Upgrade

For instances already running any EBS 12.2.x release, the 12.2.11 RUP is a standard adop patch cycle. No database upgrade, no technology stack change, no online patching setup.

### B.1 Pre-RUP Checks

\`\`\`sql
-- Confirm current 12.2.x release
SELECT RELEASE_NAME FROM FND_PRODUCT_GROUPS;

-- Confirm no adop cycle is in progress
SELECT ADOP_SESSION_ID, STATUS FROM AD_ADOP_SESSIONS
WHERE STATUS NOT IN ('C','A')
ORDER BY ADOP_SESSION_ID DESC
FETCH FIRST 3 ROWS ONLY;
\`\`\`

### B.2 Apply 12.2.11 RUP via adop

\`\`\`bash
source /u01/oracle/EBS/EBSapps.env run

# Follow the standard adop cycle (see the adop patching runbook for full detail)
adop phase=prepare workers=8
adop phase=apply merge_patch_directory=/u05/rup1211_merged workers=8
adop phase=finalize workers=8
adop phase=cutover workers=8   # maintenance window: 15-30 minutes
# Validate, then:
adop phase=cleanup workers=8
\`\`\`

---

## Phase 8: Monitoring Scripts

### Script 1: Upgrade Progress Monitor

\`\`\`bash
#!/bin/bash
# File: /home/oracle/scripts/upgrade_progress.sh
# Run during the upgrade driver phase to monitor adpatch progress

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
ORACLE_SID=EBSPRD
export ORACLE_HOME ORACLE_SID

TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')

\${ORACLE_HOME}/bin/sqlplus -s / as sysdba << 'SQL'
SET PAGESIZE 50 LINESIZE 120 FEEDBACK OFF
COLUMN PHASE_STATUS FORMAT A15
COLUMN START_DATE FORMAT A20
COLUMN END_DATE FORMAT A20
PROMPT
PROMPT === EBS Upgrade Driver Phase Status:
SELECT TO_CHAR(SYSDATE, 'YYYY-MM-DD HH24:MI:SS') FROM DUAL;
PROMPT
SELECT PHASE_NUMBER,
       PHASE_STATUS,
       TO_CHAR(START_DATE,'YYYY-MM-DD HH24:MI') AS START_DATE,
       TO_CHAR(END_DATE,'YYYY-MM-DD HH24:MI') AS END_DATE,
       ROUND(NVL(END_DATE,SYSDATE)-START_DATE,4)*24 AS HOURS
FROM AD_ADPATCH_PHASES
ORDER BY PHASE_NUMBER;
EXIT;
SQL
\`\`\`

### Script 2: Post-Upgrade Edition Validation

\`\`\`bash
#!/bin/bash
# File: /home/oracle/scripts/upgrade_edition_check.sh
# Validates the EBR edition setup after online patching enablement

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
ORACLE_SID=EBSPRD
export ORACLE_HOME ORACLE_SID

echo "=== Edition-Based Redefinition Status: \$(date) ==="

\${ORACLE_HOME}/bin/sqlplus -s / as sysdba << 'SQL'
SET PAGESIZE 50 LINESIZE 120 FEEDBACK OFF

PROMPT
PROMPT --- Database Editions ---
SELECT EDITION_NAME, PARENT_EDITION_NAME, USABLE
FROM DBA_EDITIONS ORDER BY EDITION_NAME;

PROMPT
PROMPT --- Default Edition ---
SELECT PROPERTY_VALUE AS DEFAULT_EDITION
FROM DATABASE_PROPERTIES
WHERE PROPERTY_NAME = 'DEFAULT_EDITION';

PROMPT
PROMPT --- Invalid Objects in Current Edition ---
SELECT COUNT(*) AS INVALID_COUNT
FROM DBA_OBJECTS
WHERE OWNER = 'APPS'
AND STATUS = 'INVALID';

PROMPT
PROMPT --- EBR Privileges on APPS ---
SELECT PRIVILEGE FROM DBA_SYS_PRIVS
WHERE GRANTEE = 'APPS'
AND PRIVILEGE IN ('CREATE EDITION','ALTER SESSION')
ORDER BY PRIVILEGE;

EXIT;
SQL
\`\`\`

### Script 3: Release and Patch Level Audit

\`\`\`bash
#!/bin/bash
# File: /home/oracle/scripts/ebs_release_audit.sh
# Reports current EBS release, database version, and last 10 applied patches

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
APPS_PASSWD=\${APPS_PASSWORD}
DB_SERVICE=EBSPRD
export ORACLE_HOME

echo "=== EBS Release and Patch Audit: \$(date) ==="
echo ""

\${ORACLE_HOME}/bin/sqlplus -s apps/\${APPS_PASSWD}@\${DB_SERVICE} << 'SQL'
SET PAGESIZE 50 LINESIZE 120 FEEDBACK OFF

PROMPT --- EBS Release ---
SELECT RELEASE_NAME, TO_CHAR(LAST_UPDATE_DATE,'YYYY-MM-DD') AS LAST_UPDATED
FROM FND_PRODUCT_GROUPS;

PROMPT
PROMPT --- Oracle Database Version ---
SELECT VERSION_FULL, BANNER FROM V\$INSTANCE, V\$VERSION WHERE ROWNUM=1;

PROMPT
PROMPT --- Last 10 Applied Patches ---
SELECT BUG_NUMBER,
       TO_CHAR(LAST_UPDATE_DATE,'YYYY-MM-DD HH24:MI') AS APPLIED_DATE
FROM AD_BUGS
ORDER BY LAST_UPDATE_DATE DESC
FETCH FIRST 10 ROWS ONLY;

EXIT;
SQL
\`\`\`

\`\`\`bash
# Crontab — run release audit daily after upgrade stabilizes
0 6 * * * /home/oracle/scripts/ebs_release_audit.sh >> /home/oracle/scripts/logs/release_audit.log 2>&1
\`\`\`

---

## Rollback Procedures

### Rollback Before Phase 3 (Before EBS Upgrade Driver)

The RMAN backup taken in Phase 0 is the rollback point. Restore from RMAN backup and reinstall the 11g Oracle Home binaries:

\`\`\`bash
# Restore database from RMAN backup taken before downtime
rman target / << 'RMAN_EOF'
SHUTDOWN ABORT;
STARTUP MOUNT;
RESTORE DATABASE;
RECOVER DATABASE;
ALTER DATABASE OPEN RESETLOGS;
RMAN_EOF

# Restart 12.1.3 application tier against the restored database
source \${APPL_TOP}/APPSORA.env
\${ADMIN_SCRIPTS_HOME}/adstrtal.sh apps/\${APPS_PASSWORD}
\`\`\`

### Rollback for 12.2.x RUP Scenario (Scenario B)

Standard adop edition rollback — see the adop patching runbook. The database edition switch is reversible until cleanup runs.

### Common Failure Points and Resolutions

| Phase | Failure | Resolution |
|---|---|---|
| DBUA upgrade | ORA-01555 undo exhausted | Increase UNDO_TABLESPACE, restart DBUA |
| DBUA upgrade | Invalid objects after upgrade | Run utlrp.sql, check alert log for errors |
| adpatch upgrade driver | Worker fails on DDL | Check worker log, fix data issue, resume adpatch |
| adpatch upgrade driver | Tablespace full | Extend tablespace AUTOEXTEND or add datafile, resume |
| adcfgclone / AutoConfig | Wrong context file values | Correct context file variables, re-run AutoConfig |
| Online patching setup | Edition grant errors | Re-run adgrants.sql as SYS, verify APPS privileges |
| adop RUP apply | Compilation failures in patch edition | Check adwork logs, fix object, resume apply |`,
};

async function main() {
  console.log('Inserting EBS 12.2.11 upgrade runbook...');
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
