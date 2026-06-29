import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS 12.2.11 Cloning Runbook',
  slug: 'oracle-ebs-12211-cloning-runbook',
  excerpt:
    'Complete step-by-step runbook for cloning Oracle EBS 12.2.11: source preparation with adpreclone on both database and application tiers, target context file construction, RMAN active duplicate for the database tier, tar-based application tier transport, adcfgclone configuration on the target, EBS startup, and the full post-clone hardening sequence — FNDCPASS, workflow mailer disable, external integration lockdown, system name change, Oracle Payments, and validation queries.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-29'),
  youtubeUrl: null,
  content: `## Overview

This runbook covers the complete procedure for cloning Oracle EBS 12.2.11 from a source (production) instance to a target (development or test) instance. The sequence assumes a single-node source database, a single application tier on the source, and a single-node target for both database and application tiers. Adapt the application tier steps for each additional source app tier in a multi-node environment.

**Assumptions**:
- Source: EBS 12.2.11, Oracle Database 19c (non-CDB), RHEL 8 or 9
- Target: fresh RHEL installation, Oracle 19c RDBMS installed (no database created yet), same OS user (oracle, applmgr) and directory structure as the source
- Oracle 19c ORACLE_HOME on the target is installed but no DBCA has been run
- Target can reach the source database via SQL*Net during RMAN active duplicate
- All commands run as oracle (database tier) or applmgr (application tier) unless noted

---

## Phase 1: Source Pre-Clone Preparation

### 1.1 Verify Source Health

\`\`\`sql
-- Connect as APPS and confirm database is healthy
SELECT COUNT(*), STATUS
FROM DBA_OBJECTS
WHERE OWNER = 'APPS'
GROUP BY STATUS;

-- Confirm no adop cycle is in a partial state on the source
SELECT ADOP_SESSION_ID, STATUS, PREPARE_STATUS, APPLY_STATUS,
       CLEANUP_STATUS
FROM AD_ADOP_SESSIONS
ORDER BY ADOP_SESSION_ID DESC
FETCH FIRST 3 ROWS ONLY;

-- Record the source database DBID and DB_NAME for RMAN reference
SELECT DBID, NAME, DB_UNIQUE_NAME, LOG_MODE FROM V\$DATABASE;
\`\`\`

\`\`\`bash
# Verify all source EBS services are up
source \${EBS_APPS_HOME}/EBSapps.env run
\${ADMIN_SCRIPTS_HOME}/adstpall.sh status apps/\${APPS_PASSWORD}
\${ADMIN_SCRIPTS_HOME}/adcmctl.sh status apps/\${APPS_PASSWORD}
\`\`\`

### 1.2 Record Source Environment Variables

\`\`\`bash
# On the source application server — record these for context file construction
source \${EBS_APPS_HOME}/EBSapps.env run
echo "CONTEXT_NAME: \${CONTEXT_NAME}"
echo "TWO_TASK: \${TWO_TASK}"
echo "ORACLE_SID: \${ORACLE_SID}"
echo "APPL_TOP: \${APPL_TOP}"
echo "ORACLE_HOME (DB): \${ORACLE_HOME}"
echo "INST_TOP: \${INST_TOP}"
echo "COMMON_TOP: \${COMMON_TOP}"
echo "NE_BASE: \${NE_BASE}"
echo "EBS_DOMAIN_HOME: \${EBS_DOMAIN_HOME}"

# Record the source context file location
ls -la \${INST_TOP}/appl/admin/\${CONTEXT_NAME}.xml
\`\`\`

### 1.3 Run adpreclone on the Source Database Tier

\`\`\`bash
# Run as oracle on the SOURCE database server
source \${ORACLE_HOME}/\${CONTEXT_NAME}.env 2>/dev/null || \
  export ORACLE_SID=EBSPRD ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1

SCRIPTS_DIR=\${ORACLE_HOME}/appsutil/scripts/\${CONTEXT_NAME}
perl \${SCRIPTS_DIR}/adpreclone.pl dbTier 2>&1 | tee /tmp/adpreclone_db_\$(date +%Y%m%d).log

# Verify completion — look for "adpreclone completed successfully"
tail -20 /tmp/adpreclone_db_\$(date +%Y%m%d).log
\`\`\`

### 1.4 Run adpreclone on the Source Application Tier

\`\`\`bash
# Run as applmgr on the SOURCE application server
source \${EBS_APPS_HOME}/EBSapps.env run

perl \${COMMON_TOP}/clone/bin/adpreclone.pl appsTier 2>&1 | tee /tmp/adpreclone_app_\$(date +%Y%m%d).log

# Verify completion
tail -20 /tmp/adpreclone_app_\$(date +%Y%m%d).log
\`\`\`

---

## Phase 2: Prepare the Target Context File

The context file defines the complete identity of the target EBS environment. Create it before copying any files to the target.

### 2.1 Copy the Source Context File

\`\`\`bash
# Copy source DB context file to a working location
scp oracle@ebsprod01:\${ORACLE_HOME}/appsutil/\${CONTEXT_NAME}.xml \
  /tmp/target_context_db.xml

# Copy source application context file
scp applmgr@ebsprod01:\${INST_TOP}/appl/admin/\${CONTEXT_NAME}.xml \
  /tmp/target_context_app.xml
\`\`\`

### 2.2 Edit the Target Database Context File

Open \`/tmp/target_context_db.xml\` and substitute all source-specific values. The critical parameters (search for each s_ variable name):

\`\`\`bash
# Use sed to make bulk substitutions — review each carefully before applying
# Replace source SID and hostname throughout the context file

SOURCE_SID=EBSPRD
TARGET_SID=EBSDEV
SOURCE_DB_HOST=ebsprod01.example.com
TARGET_DB_HOST=ebsdev01.example.com
SOURCE_APP_HOST=ebsprodapp01.example.com
TARGET_APP_HOST=ebsdevapp01.example.com

sed -i "s/\${SOURCE_SID}/\${TARGET_SID}/g" /tmp/target_context_db.xml
sed -i "s/\${SOURCE_DB_HOST}/\${TARGET_DB_HOST}/g" /tmp/target_context_db.xml
sed -i "s/\${SOURCE_APP_HOST}/\${TARGET_APP_HOST}/g" /tmp/target_context_db.xml
\`\`\`

Verify the following s_ variables in the context file match the target:

| Variable | Description | Example |
|---|---|---|
| s_dbSid | Target database SID | EBSDEV |
| s_dbhost | Target DB hostname | ebsdev01.example.com |
| s_db_port | Target listener port | 1521 |
| s_hostname | Target app server hostname | ebsdevapp01.example.com |
| s_base | Target EBS base directory | /u01/oracle/EBS |
| s_appl_top | Target APPL_TOP | /u01/oracle/EBS/fs1/EBSapps/appl |
| s_inst_top | Target INST_TOP | /u01/oracle/EBS/fs1/inst |
| s_webentryhost | Target app URL hostname | ebsdevapp01.example.com |
| s_webentryport | Target HTTP port | 8000 |
| s_apps_passwd | Target APPS password | (set to new value) |
| s_wls_admin_passwd | Target WebLogic admin password | (set to new value) |

\`\`\`bash
# Copy the edited context file to the target database server
scp /tmp/target_context_db.xml oracle@ebsdev01:\${ORACLE_HOME}/appsutil/\${TARGET_SID}_ebsdev01.xml

# Copy the edited context file to the target application server
scp /tmp/target_context_app.xml applmgr@ebsdevapp01:/tmp/\${TARGET_SID}_ebsdevapp01.xml
\`\`\`

---

## Phase 3: Copy the Database Tier — RMAN Active Duplicate

### 3.1 Configure the Target Listener and Auxiliary Instance

Run on the **target database server** as oracle:

\`\`\`bash
# Create a minimal listener.ora on the target to accept the RMAN connection
cat > \${ORACLE_HOME}/network/admin/listener.ora << 'EOF'
LISTENER =
  (DESCRIPTION_LIST =
    (DESCRIPTION =
      (ADDRESS = (PROTOCOL = TCP)(HOST = ebsdev01.example.com)(PORT = 1521))
    )
  )

SID_LIST_LISTENER =
  (SID_LIST =
    (SID_DESC =
      (GLOBAL_DBNAME = EBSDEV)
      (ORACLE_HOME = /u01/app/oracle/product/19.0.0/dbhome_1)
      (SID_NAME = EBSDEV)
    )
  )
EOF

lsnrctl start
lsnrctl status
\`\`\`

\`\`\`bash
# Create a minimal init.ora for the auxiliary instance (nomount stage)
mkdir -p \${ORACLE_BASE}/admin/EBSDEV/adump
mkdir -p /u02/oradata/EBSDEV

cat > \${ORACLE_HOME}/dbs/initEBSDEV.ora << 'EOF'
db_name=EBSDEV
db_unique_name=EBSDEV
sga_target=2G
pga_aggregate_target=512M
audit_trail=NONE
db_block_size=8192
compatible=19.0.0
EOF

# Start the auxiliary instance in nomount
export ORACLE_SID=EBSDEV
sqlplus / as sysdba << 'SQL'
STARTUP NOMOUNT PFILE='\${ORACLE_HOME}/dbs/initEBSDEV.ora';
EXIT;
SQL
\`\`\`

### 3.2 Configure tnsnames.ora on the Target for Source Connectivity

\`\`\`bash
# Add source TNS alias to target tnsnames.ora
cat >> \${ORACLE_HOME}/network/admin/tnsnames.ora << 'EOF'

EBSPRD =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = ebsprod01.example.com)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = EBSPRD)
    )
  )

EBSDEV =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = ebsdev01.example.com)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = EBSDEV)
    )
  )
EOF

# Test connectivity to source
tnsping EBSPRD
\`\`\`

### 3.3 Run RMAN Active Duplicate

Run on the **target** as oracle. This streams the database from source to target — no source outage required. Duration depends on database size and network bandwidth.

\`\`\`bash
export ORACLE_SID=EBSDEV

rman << 'RMAN_EOF'
CONNECT TARGET sys/<sys_password>@EBSPRD;
CONNECT AUXILIARY sys/<sys_password>@EBSDEV;

DUPLICATE TARGET DATABASE TO EBSDEV
  FROM ACTIVE DATABASE
  USING BACKUPSET
  PASSWORD FILE
  SPFILE
    SET DB_UNIQUE_NAME='EBSDEV'
    SET DB_NAME='EBSDEV'
    SET INSTANCE_NAME='EBSDEV'
    SET AUDIT_FILE_DEST='/u01/app/oracle/admin/EBSDEV/adump'
    SET AUDIT_TRAIL='NONE'
    SET CONTROL_FILES='/u02/oradata/EBSDEV/control01.ctl','/u03/oradata/EBSDEV/control02.ctl'
    SET DB_FILE_NAME_CONVERT='/u02/oradata/EBSPRD/','/u02/oradata/EBSDEV/'
    SET LOG_FILE_NAME_CONVERT='/u03/redo/EBSPRD/','/u03/redo/EBSDEV/'
    SET DIAGNOSTIC_DEST='/u01/app/oracle'
    SET LOG_ARCHIVE_DEST_1='LOCATION=/u04/arch/EBSDEV'
    SET FAL_SERVER=''
    SET FAL_CLIENT=''
    SET LOG_ARCHIVE_CONFIG=''
    SET STANDBY_FILE_MANAGEMENT='MANUAL'
  NOFILENAMECHECK;
EXIT;
RMAN_EOF
\`\`\`

### 3.4 Post-Duplicate Database Checks

\`\`\`sql
-- Connect to the duplicated database
export ORACLE_SID=EBSDEV
sqlplus / as sysdba

-- Confirm DB_NAME and open status
SELECT NAME, DB_UNIQUE_NAME, OPEN_MODE FROM V\$DATABASE;

-- Confirm all datafiles are online
SELECT FILE#, STATUS, NAME FROM V\$DATAFILE WHERE STATUS != 'ONLINE';

-- Confirm redo logs are current
SELECT GROUP#, STATUS, BYTES/1024/1024 AS MB FROM V\$LOG ORDER BY GROUP#;

-- Remove the Data Guard configuration references left by RMAN
ALTER SYSTEM SET LOG_ARCHIVE_CONFIG='' SCOPE=BOTH;
ALTER SYSTEM SET FAL_SERVER='' SCOPE=BOTH;
ALTER SYSTEM SET FAL_CLIENT='' SCOPE=BOTH;
ALTER SYSTEM SET LOG_ARCHIVE_DEST_STATE_2='DEFER' SCOPE=BOTH;

-- Shut down cleanly before adcfgclone
SHUTDOWN IMMEDIATE;
EXIT;
\`\`\`

---

## Phase 4: Copy the Application Tier

### 4.1 Create Target Directory Structure

\`\`\`bash
# On the target application server as applmgr
EBS_BASE=/u01/oracle/EBS
mkdir -p \${EBS_BASE}/fs1
mkdir -p \${EBS_BASE}/fs2
mkdir -p \${EBS_BASE}/fs_ne

# Verify mount points have sufficient space
df -h \${EBS_BASE}
\`\`\`

### 4.2 Copy fs1 (RUN Filesystem) from Source

\`\`\`bash
# Method A: pipe tar directly over SSH (faster for local network)
# Run on the SOURCE application server as applmgr
ssh applmgr@ebsdevapp01 "mkdir -p /u01/oracle/EBS/fs1"

tar -czf - -C /u01/oracle/EBS fs1 | \
  ssh applmgr@ebsdevapp01 "tar -xzf - -C /u01/oracle/EBS/"

# Method B: write tar to shared NFS or staging disk, then copy
tar -czf /u05/clone_staging/ebs_fs1_\$(date +%Y%m%d).tar.gz -C /u01/oracle/EBS fs1
# Transfer the tar file, then extract on target

# Verify the copy size matches the source
du -sh /u01/oracle/EBS/fs1  # compare on source and target
\`\`\`

### 4.3 Copy fs_ne (Non-Editioned Filesystem)

\`\`\`bash
# Copy fs_ne from source to target
tar -czf - -C /u01/oracle/EBS fs_ne | \
  ssh applmgr@ebsdevapp01 "tar -xzf - -C /u01/oracle/EBS/"
\`\`\`

### 4.4 Copy ORACLE_HOME (Application Tier — if applicable)

If the EBS ORACLE_HOME for forms/HTTP server is separate from the DB ORACLE_HOME, copy it as well:

\`\`\`bash
# Copy the FMW/WebLogic home
tar -czf - -C /u01/app/oracle fmw | \
  ssh applmgr@ebsdevapp01 "tar -xzf - -C /u01/app/oracle/"
\`\`\`

---

## Phase 5: adcfgclone on the Target Database Tier

### 5.1 Verify Context File Is in Place

\`\`\`bash
# On the target database server
ls -la \${ORACLE_HOME}/appsutil/\${TARGET_SID}_ebsdev01.xml
\`\`\`

### 5.2 Run adcfgclone dbTier

\`\`\`bash
# Run as oracle on the TARGET database server
export ORACLE_SID=EBSDEV
export ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1

perl \${ORACLE_HOME}/appsutil/clone/bin/adcfgclone.pl \
  dbTier \${ORACLE_HOME}/appsutil/\${TARGET_SID}_ebsdev01.xml \
  2>&1 | tee /tmp/adcfgclone_db_\$(date +%Y%m%d).log

# Verify completion
tail -30 /tmp/adcfgclone_db_\$(date +%Y%m%d).log
# Look for: "adcfgclone completed successfully"
\`\`\`

### 5.3 Verify Database Configuration After adcfgclone

\`\`\`sql
-- Connect to target DB (should now be open after adcfgclone)
export ORACLE_SID=EBSDEV
sqlplus / as sysdba

-- Confirm DB_NAME is updated
SELECT NAME, DB_UNIQUE_NAME, OPEN_MODE, LOG_MODE FROM V\$DATABASE;

-- Confirm FND_NODES is updated with target hostname
SELECT NODE_ID, NODE_NAME, SUPPORT_CP, SUPPORT_FORMS, SUPPORT_WEB
FROM FND_NODES;

-- Confirm the target listener is registered
SELECT INST_ID, INSTANCE_NAME, HOST_NAME FROM GV\$INSTANCE;
EXIT;
\`\`\`

---

## Phase 6: adcfgclone on the Target Application Tier

### 6.1 Place the Target Application Context File

\`\`\`bash
# On the target application server as applmgr
# The context file must be in fs_ne so adcfgclone can find it
TARGET_CONTEXT_NAME=\${TARGET_SID}_ebsdevapp01
mkdir -p /u01/oracle/EBS/fs_ne/inst/apps/\${TARGET_CONTEXT_NAME}/appl/admin/

cp /tmp/\${TARGET_CONTEXT_NAME}.xml \
  /u01/oracle/EBS/fs_ne/inst/apps/\${TARGET_CONTEXT_NAME}/appl/admin/\${TARGET_CONTEXT_NAME}.xml
\`\`\`

### 6.2 Run adcfgclone appsTier

\`\`\`bash
# Run as applmgr on the TARGET application server
COMMON_TOP=/u01/oracle/EBS/fs1/EBSapps/comn
TARGET_CONTEXT_FILE=/u01/oracle/EBS/fs_ne/inst/apps/\${TARGET_CONTEXT_NAME}/appl/admin/\${TARGET_CONTEXT_NAME}.xml

perl \${COMMON_TOP}/clone/bin/adcfgclone.pl \
  appsTier \${TARGET_CONTEXT_FILE} \
  2>&1 | tee /tmp/adcfgclone_app_\$(date +%Y%m%d).log

# Verify completion
tail -30 /tmp/adcfgclone_app_\$(date +%Y%m%d).log
# Look for: "adcfgclone completed successfully"
\`\`\`

### 6.3 Run AutoConfig on the Target Application Tier

adcfgclone runs AutoConfig internally, but run it manually afterward to confirm clean execution:

\`\`\`bash
source /u01/oracle/EBS/EBSapps.env run
\${ADMIN_SCRIPTS_HOME}/adautocfg.sh apps/\${APPS_PASSWORD}
\`\`\`

---

## Phase 7: Post-Clone Hardening

These steps must be completed before the clone is accessible to any user. Do not skip any step.

### 7.1 Change APPS and SYSADMIN Passwords

\`\`\`bash
# Source the target environment
source /u01/oracle/EBS/EBSapps.env run

# Change the APPS schema password
# FNDCPASS syntax: FNDCPASS <logon> <usernumber> <query_apps> SYSTEM <system_passwd> <type> <username> <newpassword>
FNDCPASS apps/\${SOURCE_APPS_PASSWD} 0 Y system/\${SYSTEM_PASSWD} SYSTEM APPSUSER APPS \${NEW_APPS_PASSWD}

# Change the SYSADMIN EBS user password
FNDCPASS apps/\${NEW_APPS_PASSWD} 0 Y system/\${SYSTEM_PASSWD} USER SYSADMIN \${NEW_SYSADMIN_PASSWD}

# Change the WebLogic admin password (via wlst if needed after adcfgclone)
# adcfgclone should have set this from the context file s_wls_admin_passwd value
\`\`\`

### 7.2 Disable the Workflow Notification Mailer

\`\`\`sql
-- Connect as APPS to the target database
-- Disable outbound email from Workflow
UPDATE WF_MAILER_PARAMETERS
SET PARAMETER_VALUE = 'N'
WHERE PARAMETER_NAME = 'SEND_EMAIL';

-- Set a dummy outbound mail server so any misconfigured program errors silently
UPDATE WF_MAILER_PARAMETERS
SET PARAMETER_VALUE = 'localhost'
WHERE PARAMETER_NAME = 'OUTBOUND_SERVER';

COMMIT;

-- Verify
SELECT PARAMETER_NAME, PARAMETER_VALUE
FROM WF_MAILER_PARAMETERS
WHERE PARAMETER_NAME IN ('SEND_EMAIL','OUTBOUND_SERVER');
\`\`\`

### 7.3 Disable External Integration Concurrent Programs

\`\`\`sql
-- Disable concurrent programs that connect to external systems
-- Identify programs by name pattern — adapt to your EBS modules
UPDATE FND_CONCURRENT_PROGRAMS
SET ENABLED_FLAG = 'N'
WHERE CONCURRENT_PROGRAM_NAME IN (
  'ARAUTOREC',     -- AR AutoReceipt (payment processing)
  'ALECDC',        -- iPayment credit card authorization
  'APXPBEXP',      -- AP Payment Batch Export
  'INVIDITM'       -- Inventory Item Interface
)
AND APPLICATION_ID IN (
  SELECT APPLICATION_ID FROM FND_APPLICATION
  WHERE APPLICATION_SHORT_NAME IN ('AR','IBY','AP','INV')
);
COMMIT;

-- More targeted: disable all payment-related programs
UPDATE FND_CONCURRENT_PROGRAMS
SET ENABLED_FLAG = 'N'
WHERE CONCURRENT_PROGRAM_NAME LIKE '%PAYMENT%'
OR CONCURRENT_PROGRAM_NAME LIKE '%CREDIT%'
OR CONCURRENT_PROGRAM_NAME LIKE '%SETTLE%';
COMMIT;
\`\`\`

### 7.4 Change the EBS System Name

\`\`\`sql
-- Change the system name so users and DBAs can identify this as a clone
UPDATE FND_PRODUCT_GROUPS
SET APPLICATIONS_SYSTEM_NAME = 'DEV-CLONE'
WHERE ROWNUM = 1;
COMMIT;

-- Verify
SELECT APPLICATIONS_SYSTEM_NAME FROM FND_PRODUCT_GROUPS;
\`\`\`

### 7.5 Set a Visual Banner to Identify the Clone

\`\`\`sql
-- Set a site-level banner profile so users see "DEV CLONE" in the application header
BEGIN
  FND_PROFILE.SAVE(
    x_name        => 'APPLICATIONS_TITLE',
    x_value       => 'DEV CLONE — NOT PRODUCTION',
    x_level_name  => 'SITE',
    x_level_value => NULL
  );
  COMMIT;
END;
/
\`\`\`

### 7.6 Clear Oracle Payments Configuration

\`\`\`sql
-- Clear payment gateway credentials from the clone
-- These are stored in IBY_PAYMENT_SYSTEMS — null out the endpoint URL and credentials
UPDATE IBY_PAYMENT_SYSTEMS
SET BEPPREFIX = NULL,
    BEPCREDENTIAL1 = NULL,
    BEPCREDENTIAL2 = NULL,
    BASE_URL = 'https://test-gateway.example.com'
WHERE BEPCODE NOT IN ('OFFLINE');  -- preserve offline/check payment methods
COMMIT;

-- Verify no live gateway URLs remain
SELECT BEPCODE, BASE_URL, BEPCREDENTIAL1
FROM IBY_PAYMENT_SYSTEMS
WHERE BASE_URL IS NOT NULL;
\`\`\`

### 7.7 Disable Concurrent Manager Service for External Queues

\`\`\`sql
-- Disable the GSM/Advanced Queue-based outbound message services
-- that could push messages to external MQ or middleware
UPDATE FND_CONCURRENT_QUEUES
SET ENABLED_FLAG = 'N'
WHERE CONCURRENT_QUEUE_NAME LIKE '%MSG%'
OR CONCURRENT_QUEUE_NAME LIKE '%QUEUE%'
OR CONCURRENT_QUEUE_NAME LIKE '%OUTBOUND%';
COMMIT;
\`\`\`

### 7.8 Purge Pending Workflow Notifications

\`\`\`sql
-- Purge workflow items that were queued in production but not yet sent
-- This prevents a flood of emails if mailer is accidentally re-enabled
BEGIN
  WF_PURGE.TOTAL(
    itemtype => NULL,
    itemkey  => NULL,
    enddate  => SYSDATE,
    docommit => TRUE,
    raiseerror => FALSE
  );
END;
/
\`\`\`

---

## Phase 8: Start EBS on the Target and Validate

### 8.1 Start the Target Database

\`\`\`bash
export ORACLE_SID=EBSDEV
sqlplus / as sysdba << 'SQL'
STARTUP;
EXIT;
SQL

# Start the listener
lsnrctl start
lsnrctl status
\`\`\`

### 8.2 Start All EBS Services

\`\`\`bash
source /u01/oracle/EBS/EBSapps.env run

# Start all EBS services
\${ADMIN_SCRIPTS_HOME}/adstrtal.sh apps/\${NEW_APPS_PASSWD}

# Verify service status
\${ADMIN_SCRIPTS_HOME}/adstpall.sh status apps/\${NEW_APPS_PASSWD}

# Start concurrent managers
\${ADMIN_SCRIPTS_HOME}/adcmctl.sh start apps/\${NEW_APPS_PASSWD}
\${ADMIN_SCRIPTS_HOME}/adcmctl.sh status apps/\${NEW_APPS_PASSWD}
\`\`\`

### 8.3 EBS Application Login Validation

\`\`\`bash
# Test the EBS login URL in a browser:
# http://ebsdevapp01.example.com:8000/OA_HTML/AppsLogin

# Or test via command line (validate HTTP response)
curl -s -o /dev/null -w "%{http_code}" \
  http://ebsdevapp01.example.com:8000/OA_HTML/AppsLogin
# Expected: 200 or 302
\`\`\`

### 8.4 Post-Clone Validation Queries

\`\`\`sql
-- Confirm system name is updated
SELECT APPLICATIONS_SYSTEM_NAME FROM FND_PRODUCT_GROUPS;

-- Confirm FND_NODES shows only target nodes (no production hostnames)
SELECT NODE_NAME, HOST_NAME, SUPPORT_CP, SUPPORT_FORMS, SUPPORT_WEB
FROM FND_NODES
ORDER BY NODE_NAME;

-- Confirm workflow mailer is disabled
SELECT PARAMETER_NAME, PARAMETER_VALUE
FROM WF_MAILER_PARAMETERS
WHERE PARAMETER_NAME IN ('SEND_EMAIL','OUTBOUND_SERVER');

-- Confirm the APPS user password works
SELECT USERNAME, USER_ID FROM FND_USER WHERE USER_NAME = 'SYSADMIN';

-- Run a test concurrent program (Active Users Report)
-- In EBS: System Administrator > Concurrent > Run > Active Users Report
-- Confirm it completes with status = Completed Normal

-- Verify no production hostnames remain in any configuration table
SELECT NAME, VALUE FROM V\$PARAMETER
WHERE LOWER(VALUE) LIKE '%ebsprod%';

SELECT HOST_NAME FROM FND_NODES WHERE HOST_NAME LIKE '%prod%';
\`\`\`

---

## Phase 9: Monitoring Scripts

### Script 1: Post-Clone Hardening Audit

\`\`\`bash
#!/bin/bash
# File: /home/oracle/scripts/clone_hardening_audit.sh
# Run after clone to verify all hardening steps completed

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
ORACLE_SID=EBSDEV
APPS_PASSWD=\${NEW_APPS_PASSWD}
PROD_HOSTNAME=ebsprod01
export ORACLE_HOME ORACLE_SID

PASS=0
FAIL=0

check() {
  local DESC="\$1"
  local RESULT="\$2"
  local EXPECTED="\$3"
  if echo "\${RESULT}" | grep -q "\${EXPECTED}"; then
    echo "  PASS: \${DESC}"
    PASS=\$((PASS+1))
  else
    echo "  FAIL: \${DESC} (got: \${RESULT})"
    FAIL=\$((FAIL+1))
  fi
}

echo "=== EBS Clone Hardening Audit: \$(date) ==="
echo ""

# Check 1: System name is not production
SYSNAME=\$(\${ORACLE_HOME}/bin/sqlplus -s apps/\${APPS_PASSWD} << 'SQL'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT APPLICATIONS_SYSTEM_NAME FROM FND_PRODUCT_GROUPS;
EXIT;
SQL
)
check "System name changed from production" "\${SYSNAME}" "CLONE\|DEV\|TEST"

# Check 2: Workflow mailer is disabled
MAILER=\$(\${ORACLE_HOME}/bin/sqlplus -s apps/\${APPS_PASSWD} << 'SQL'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT PARAMETER_VALUE FROM WF_MAILER_PARAMETERS WHERE PARAMETER_NAME = 'SEND_EMAIL';
EXIT;
SQL
)
check "Workflow mailer disabled" "\${MAILER}" "^N$"

# Check 3: No production hostnames in FND_NODES
PROD_NODES=\$(\${ORACLE_HOME}/bin/sqlplus -s apps/\${APPS_PASSWD} << SQL
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT COUNT(*) FROM FND_NODES WHERE HOST_NAME LIKE '%\${PROD_HOSTNAME}%';
EXIT;
SQL
)
check "No production hostnames in FND_NODES" "\${PROD_NODES}" "^0$"

# Check 4: Data Guard config cleared
DG_CONFIG=\$(\${ORACLE_HOME}/bin/sqlplus -s / as sysdba << 'SQL'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT VALUE FROM V\$PARAMETER WHERE NAME = 'log_archive_config';
EXIT;
SQL
)
check "Data Guard LOG_ARCHIVE_CONFIG cleared" "\${DG_CONFIG}" "^$"

echo ""
echo "=== Results: \${PASS} passed, \${FAIL} failed ==="
[ "\${FAIL}" -gt 0 ] && exit 1 || exit 0
\`\`\`

### Script 2: Clone Instance Health Monitor

\`\`\`bash
#!/bin/bash
# File: /home/oracle/scripts/clone_health.sh
# Ongoing health check for the cloned instance

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
ORACLE_SID=EBSDEV
APPS_PASSWD=\${NEW_APPS_PASSWD}
ALERT_EMAIL="dba-dev@example.com"
export ORACLE_HOME ORACLE_SID

LOG=/home/oracle/scripts/logs/clone_health.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')

# Check DB is open
DB_STATUS=\$(\${ORACLE_HOME}/bin/sqlplus -s / as sysdba << 'SQL'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT OPEN_MODE FROM V\$DATABASE;
EXIT;
SQL
)

# Check concurrent manager
CM_COUNT=\$(\${ORACLE_HOME}/bin/sqlplus -s apps/\${APPS_PASSWD} << 'SQL'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT COUNT(*) FROM FND_CONCURRENT_WORKER_REQUESTS
WHERE PROCESS_STATUS_CODE = 'A';
EXIT;
SQL
)

echo "\${TIMESTAMP} | DB: \${DB_STATUS} | Active CM workers: \${CM_COUNT}" >> \${LOG}

# Alert if DB is not in READ WRITE mode
if [[ "\${DB_STATUS}" != *"READ WRITE"* ]]; then
  MSG="Subject: [EBS DEV] Database not open on \$(hostname)\n\nDB status: \${DB_STATUS}"
  echo -e "\${MSG}" | /usr/sbin/sendmail \${ALERT_EMAIL}
fi
\`\`\`

\`\`\`bash
# Crontab for clone monitoring (applmgr or oracle user)
# Run hardening audit once after clone (manually) — not automated
# Run health check every 30 minutes during business hours
*/30 7-20 * * * /home/oracle/scripts/clone_health.sh >> /dev/null 2>&1
\`\`\`

---

## Rollback / Re-Clone

If adcfgclone fails on the target, the fastest recovery is to repeat the clone from Phase 3. The source adpreclone output remains valid for 24 hours (the source filesystem and database have not been modified). On the target:

\`\`\`bash
# Reset the target database to nomount and rerun RMAN duplicate
export ORACLE_SID=EBSDEV
sqlplus / as sysdba << 'SQL'
STARTUP FORCE NOMOUNT PFILE='\${ORACLE_HOME}/dbs/initEBSDEV.ora';
EXIT;
SQL

# Re-run the RMAN duplicate from Phase 3.3
# Re-run adcfgclone dbTier with a corrected context file
# Re-run adcfgclone appsTier with a corrected context file
\`\`\`

The most common adcfgclone failure causes:
- Incorrect hostname or SID in the context file (check s_dbSid, s_hostname, s_dbhost)
- Target directory does not exist (adcfgclone does not create parent directories)
- APPS password in context file does not match the actual APPS password on the duplicated database
- Port conflicts with other services on the target host (check s_webentryport, s_ohs_port, s_wls_admin_port)`,
};

async function main() {
  console.log('Inserting EBS 12.2.11 cloning runbook...');
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
