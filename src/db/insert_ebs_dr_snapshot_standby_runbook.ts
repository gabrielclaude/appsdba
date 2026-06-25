import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS 12.2.11 DR Test Runbook: Snapshot Standby, AutoConfig, Cache Clear, and Site Identification',
  slug: 'oracle-ebs-12211-dr-snapshot-standby-runbook',
  excerpt:
    'Step-by-step runbook for Oracle EBS 12.2.11 DR testing via snapshot standby — pre-test checklist, converting physical standby to snapshot standby, rsync verification, adautoconfig on the DR app tier, clearing all cache layers (OAF, WebLogic, OHS), starting EBS services, configuring DR site identification (system name, FND banner profile, color scheme change), sysadmin validation, functional test checklist, converting back to physical standby, and crontab monitoring scripts for FRA space and redo transport during the test window.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-25'),
  youtubeUrl: null,
  content: `## Overview

This runbook covers the complete procedure for an Oracle EBS 12.2.11 DR test using Oracle snapshot standby. The snapshot standby mechanism allows a read-write DR test against the physical standby database while Oracle continues to receive redo from the primary — so the replication relationship is never broken and no standby rebuild is required after the test.

**Environment**:
- Primary DB: \`prod-db.internal.example.com\` SID \`VIS\`, db_unique_name \`VIS_PRIMARY\`
- Standby DB: \`dr-db.internal.example.com\` SID \`VIS\`, db_unique_name \`VIS_STANDBY\`
- Primary App: \`prod-app.internal.example.com\`
- DR App: \`dr-app.internal.example.com\`
- EBS base: \`/u01/oracle/VIS\`
- Oracle home: \`/u01/oracle/product/19.3.0/dbhome_1\`

---

## Phase 1: Pre-Test Prerequisites

### 1.1 Verify Flashback Database Is Enabled on Standby

\`\`\`bash
# On dr-db as oracle
sqlplus / as sysdba << 'EOF'
SELECT NAME, DB_UNIQUE_NAME, DATABASE_ROLE, FLASHBACK_ON FROM V\$DATABASE;
-- FLASHBACK_ON must be YES
-- DATABASE_ROLE must be PHYSICAL STANDBY
EOF
\`\`\`

If Flashback Database is not enabled:
\`\`\`bash
sqlplus / as sysdba << 'EOF'
-- Must be done on the standby while in mount mode with MRP stopped
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE CANCEL;
SHUTDOWN IMMEDIATE;
STARTUP MOUNT;
ALTER DATABASE FLASHBACK ON;
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE USING CURRENT LOGFILE DISCONNECT;
EOF
\`\`\`

### 1.2 Verify FRA Is Sized for the Test Duration

\`\`\`bash
sqlplus / as sysdba << 'EOF'
-- Check current FRA usage and available space
SELECT NAME, SPACE_LIMIT/1073741824 AS LIMIT_GB,
       SPACE_USED/1073741824 AS USED_GB,
       SPACE_RECLAIMABLE/1073741824 AS RECLAIMABLE_GB,
       NUMBER_OF_FILES
FROM V\$RECOVERY_FILE_DEST;

-- Check DB_FLASHBACK_RETENTION_TARGET (must exceed planned test duration in minutes)
SHOW PARAMETER DB_FLASHBACK_RETENTION_TARGET;

-- Set retention to 8 hours if not already set
ALTER SYSTEM SET DB_FLASHBACK_RETENTION_TARGET=480 SCOPE=BOTH;
EOF
\`\`\`

Required free FRA space = (primary redo rate GB/hour) × (planned test hours) × 1.5.
If FRA is insufficient, increase before proceeding.

### 1.3 Verify Data Guard Apply Lag Is Near Zero

\`\`\`bash
sqlplus / as sysdba << 'EOF'
SELECT NAME, VALUE, DATUM_TIME
FROM V\$DATAGUARD_STATS
WHERE NAME IN ('apply lag','transport lag','redo apply rate');

-- Apply lag should be 0+00:00:00 or within a few seconds
-- If lag is > 60 seconds, wait for catchup before proceeding
EOF
\`\`\`

### 1.4 Confirm Rsync Has Run After Most Recent adop Cleanup

On primary app host:
\`\`\`bash
# Check when rsync last completed
cat /home/applmgr/.last_midtier_sync

# Check when last adop cleanup ran
sqlplus apps/<apps_password> << 'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT TO_CHAR(MAX(END_DATE),'YYYY-MM-DD HH24:MI:SS')
FROM AD_ADOP_SESSIONS
WHERE STATUS = 'X' AND SESSION_TYPE = 'CLEANUP';
EOF
\`\`\`

The rsync timestamp must be later than the last adop cleanup timestamp. If it is not, run the rsync now:
\`\`\`bash
/home/applmgr/scripts/sync_midtier_to_dr.sh
\`\`\`

### 1.5 Record Pre-Test Baseline

\`\`\`bash
# On prod-db — record current SCN for post-test verification
sqlplus / as sysdba << 'EOF'
SELECT CURRENT_SCN, TO_CHAR(SYSDATE,'YYYY-MM-DD HH24:MI:SS') AS TIMESTAMP FROM V\$DATABASE;
EOF

# On dr-db — record standby SCN and last applied sequence
sqlplus / as sysdba << 'EOF'
SELECT CURRENT_SCN, TO_CHAR(SYSDATE,'YYYY-MM-DD HH24:MI:SS') AS TIMESTAMP FROM V\$DATABASE;
SELECT MAX(SEQUENCE#) AS LAST_APPLIED_SEQ FROM V\$ARCHIVED_LOG WHERE APPLIED='YES';
EOF
\`\`\`

---

## Phase 2: Convert Physical Standby to Snapshot Standby

### 2.1 Stop Managed Recovery and Convert

\`\`\`bash
# On dr-db as oracle
sqlplus / as sysdba << 'EOF'
-- Stop managed recovery (MRP)
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE CANCEL;

-- Wait until MRP has stopped
SELECT PROCESS, STATUS FROM V\$MANAGED_STANDBY WHERE PROCESS='MRP0';
-- STATUS should become blank (not running) — wait 30 seconds and re-query if needed

-- Convert to snapshot standby
-- Oracle automatically creates a guaranteed restore point named SNAPSHOT_STANDBY_REQUIRED_*
ALTER DATABASE CONVERT TO SNAPSHOT STANDBY;

-- Open the database read-write
ALTER DATABASE OPEN;

-- Verify
SELECT NAME, DB_UNIQUE_NAME, DATABASE_ROLE, OPEN_MODE FROM V\$DATABASE;
-- DATABASE_ROLE: SNAPSHOT STANDBY
-- OPEN_MODE: READ WRITE

-- Confirm guaranteed restore point was created
SELECT NAME, SCN, GUARANTEE_FLASHBACK_DATABASE, TIME
FROM V\$RESTORE_POINT
WHERE GUARANTEE_FLASHBACK_DATABASE='YES';
EOF
\`\`\`

### 2.2 Confirm Redo Transport Is Still Active

\`\`\`bash
# On dr-db — archived logs from primary should still be arriving
sqlplus / as sysdba << 'EOF'
-- Should show recent archived logs being received from primary
SELECT SEQUENCE#, FIRST_TIME, NEXT_TIME, APPLIED, STANDBY_DEST
FROM V\$ARCHIVED_LOG
WHERE DEST_ID=1 AND STANDBY_DEST='YES'
ORDER BY SEQUENCE# DESC
FETCH FIRST 5 ROWS ONLY;
EOF
\`\`\`

---

## Phase 3: DR Application Tier Preparation

### 3.1 Verify DR Context File

\`\`\`bash
# On dr-app as applmgr
source /u01/oracle/VIS/EBSapps.env run

# Identify the context file location
echo "Context file: \${CONTEXT_FILE}"

# Check that the context file references the DR database host, not the primary
grep -E 's_dbhost|s_db_name|s_apps_jdbc_connect_alias' \${CONTEXT_FILE}
# s_dbhost must be: dr-db.internal.example.com
# If it shows prod-db, update it before running AutoConfig
\`\`\`

If the context file references the primary:
\`\`\`bash
# Update the database host entry in the context file
# Context XML key for DB hostname:
DB_HOST_LINE=\$(grep -n 's_dbhost' \${CONTEXT_FILE} | head -1 | cut -d: -f1)
echo "DB host entry at line: \${DB_HOST_LINE}"

# Edit the context file — change the database host to dr-db
# The value tag looks like: <s_dbhost oa_var="s_dbhost">prod-db.internal.example.com</s_dbhost>
sed -i 's|<s_dbhost[^>]*>prod-db\.internal\.example\.com</s_dbhost>|<s_dbhost oa_var="s_dbhost">dr-db.internal.example.com</s_dbhost>|g' \${CONTEXT_FILE}

# Also update the JDBC connect alias if it embeds the hostname
sed -i 's|prod-db\.internal\.example\.com|dr-db.internal.example.com|g' \${CONTEXT_FILE}

# Verify
grep -E 's_dbhost|s_db_name' \${CONTEXT_FILE}
\`\`\`

### 3.2 Run adautoconfig

\`\`\`bash
# On dr-app as applmgr
source /u01/oracle/VIS/EBSapps.env run

echo "Running AutoConfig on DR application tier..."
echo "Context file: \${CONTEXT_FILE}"
echo "AD_TOP: \${AD_TOP}"

# Run AutoConfig — this rewrites 900+ configuration files
# apps password is required
perl \${AD_TOP}/bin/adconfig.pl \\
  contextfile=\${CONTEXT_FILE} \\
  apply=yes \\
  run=INSTE8 \\
  logfile=/home/applmgr/logs/adconfig_dr_\$(date +%Y%m%d_%H%M%S).log

RC=\$?
if [ \$RC -ne 0 ]; then
  echo "ERROR: AutoConfig failed with exit code \${RC}"
  echo "Check log: /home/applmgr/logs/adconfig_dr_*.log"
  exit 1
fi
echo "AutoConfig completed successfully."
\`\`\`

**Post-AutoConfig verification** — confirm key files now reference the DR database:
\`\`\`bash
# Verify the DBC file references DR DB host
grep -i dbhost \${FND_SECURE}/\${TWO_TASK}.dbc

# Verify WebLogic JDBC datasource references DR DB
grep -l "prod-db" \${DOMAIN_HOME}/config/jdbc/*.xml 2>/dev/null
# Above should return NOTHING — if any file still has prod-db, AutoConfig did not complete cleanly

grep "dr-db" \${DOMAIN_HOME}/config/jdbc/*.xml | head -3

# Verify OHS apps.conf references DR app host
grep "WebLogicHost" \${ORACLE_HOME}/ohs/conf/moduleconf/apps.conf | head -3
\`\`\`

---

## Phase 4: Clear Mid-Tier Cache

This phase must be completed before starting EBS services. Run all steps as applmgr on dr-app.

\`\`\`bash
source /u01/oracle/VIS/EBSapps.env run

# Identify both RUN and PATCH filesystem locations
echo "RUN filesystem: \${EBS_RUN}"
echo "PATCH filesystem: \${EBS_PATCH}"
echo "WebLogic domain: \${DOMAIN_HOME}"
\`\`\`

### 4.1 Clear WebLogic Server Cache and Tmp

\`\`\`bash
# Stop all EBS services first (they must be stopped before clearing WLS cache)
# If services are not running yet, skip the stop step

# Clear WebLogic cache and tmp directories for all managed servers
for SERVER_DIR in \${DOMAIN_HOME}/servers/*/; do
  SERVER_NAME=\$(basename "\${SERVER_DIR}")

  # Clear class cache
  if [ -d "\${SERVER_DIR}/cache" ]; then
    echo "Clearing cache for \${SERVER_NAME}..."
    rm -rf "\${SERVER_DIR}/cache/"*
  fi

  # Clear tmp (unpacked deployment artifacts)
  if [ -d "\${SERVER_DIR}/tmp" ]; then
    echo "Clearing tmp for \${SERVER_NAME}..."
    rm -rf "\${SERVER_DIR}/tmp/"*
  fi

  # Clear WLS stage (staged deployment files)
  if [ -d "\${SERVER_DIR}/stage" ]; then
    echo "Clearing stage for \${SERVER_NAME}..."
    rm -rf "\${SERVER_DIR}/stage/"*
  fi
done

echo "WebLogic cache cleared."
\`\`\`

### 4.2 Clear OAF Object Cache

\`\`\`bash
# Clear OA Framework compiled page cache (stored as .ser and .class files)
OAF_CACHE_DIR="\${JAVA_TOP}/oracle/apps/fnd/cache"
if [ -d "\${OAF_CACHE_DIR}" ]; then
  echo "Clearing OAF cache directory: \${OAF_CACHE_DIR}"
  find "\${OAF_CACHE_DIR}" -type f \( -name "*.ser" -o -name "*.class" \) -delete
fi

# Clear compiled OAF pages in OA_HTML
if [ -n "\${OA_HTML}" ]; then
  echo "Clearing compiled OA pages in OA_HTML..."
  find "\${OA_HTML}" -name "*.class" -path "*/cache/*" -delete 2>/dev/null
  find "\${OA_HTML}" -name "*.ser" -delete 2>/dev/null
fi

# EBS adcleancache.sh (if present in this release) handles OAF cache
if [ -f "\${ADMIN_SCRIPTS_HOME}/adcleancache.sh" ]; then
  echo "Running adcleancache.sh..."
  \${ADMIN_SCRIPTS_HOME}/adcleancache.sh \$(cat /home/applmgr/.apps_pass 2>/dev/null || echo "<apps_password>") OAFM
fi

echo "OAF cache cleared."
\`\`\`

### 4.3 Clear Oracle HTTP Server Cache

\`\`\`bash
# Clear OHS cached content (static files, SSL session cache)
OHS_CACHE_DIR="\${ORACLE_HOME}/ohs/cache"
if [ -d "\${OHS_CACHE_DIR}" ]; then
  echo "Clearing OHS cache: \${OHS_CACHE_DIR}"
  rm -rf "\${OHS_CACHE_DIR}/"*
fi

# Clear OHS work directory
OHS_WORK_DIR="\${ORACLE_HOME}/ohs/logs"
# Do NOT clear logs — they are needed for diagnostics. Only clear cache.

echo "OHS cache cleared."
\`\`\`

### 4.4 Clear Forms Cache

\`\`\`bash
# Clear compiled Forms artifacts
if [ -n "\${FORMS_PATH}" ]; then
  echo "Clearing Forms compiled cache..."
  find "\${AU_TOP}/forms" -name "*.fmx" -newer \${CONTEXT_FILE} -delete 2>/dev/null
fi

# Clear any lingering Forms session files
find /tmp -name "frmweb*" -user applmgr -delete 2>/dev/null
find /tmp -name "f60webm*" -user applmgr -delete 2>/dev/null

echo "Forms cache cleared."
\`\`\`

### 4.5 Verify Cache Is Clear

\`\`\`bash
# Confirm WebLogic cache dirs are empty
for SERVER_DIR in \${DOMAIN_HOME}/servers/*/; do
  SERVER_NAME=\$(basename "\${SERVER_DIR}")
  CACHE_COUNT=\$(find "\${SERVER_DIR}/cache" -type f 2>/dev/null | wc -l)
  TMP_COUNT=\$(find "\${SERVER_DIR}/tmp" -type f 2>/dev/null | wc -l)
  echo "\${SERVER_NAME}: cache=\${CACHE_COUNT} files, tmp=\${TMP_COUNT} files"
done
\`\`\`

---

## Phase 5: Start EBS Services on DR App Tier

\`\`\`bash
# On dr-app as applmgr
source /u01/oracle/VIS/EBSapps.env run

echo "Starting EBS services on DR app tier..."
\$ADMIN_SCRIPTS_HOME/adstrtal.sh apps/<apps_password>

# Monitor startup — WebLogic can take 5–10 minutes
echo "Waiting for services to start..."
sleep 60

# Check process status
ps -ef | grep -E "(weblogic|httpd|frmweb)" | grep -v grep | wc -l
\`\`\`

### 5.1 Verify WebLogic Server State

\`\`\`bash
# Check WebLogic server status via WLST
\${ORACLE_HOME}/oracle_common/common/bin/wlst.sh << 'EOF'
import sys
try:
  connect('weblogic','<wls_password>','t3://dr-app.internal.example.com:7001')
  domainRuntime()
  servers = cmo.getServerRuntimes()
  for s in servers:
    print(s.getName() + ': ' + s.getState())
except Exception, e:
  print('WLST error: ' + str(e))
  sys.exit(1)
disconnect()
exit()
EOF
\`\`\`

### 5.2 Verify EBS Login Page Is Accessible

\`\`\`bash
# Should return HTTP 200
curl -k -s -o /dev/null -w "%{http_code}" \\
  https://dr-app.internal.example.com:4443/OA_HTML/AppsLocalLogin.jsp
echo ""   # newline after status code

# Verify the login page shows no error content
curl -k -s https://dr-app.internal.example.com:4443/OA_HTML/AppsLocalLogin.jsp \\
  | grep -i "error\|exception\|ora-" | head -5
\`\`\`

---

## Phase 6: Configure DR Site Identification

All three layers must be configured before user validation begins.

### 6.1 Layer 1 — System Name (FND_PRODUCT_GROUPS)

This appears in the browser window title and EBS header instance label. Change this first because it takes effect immediately without any service restart.

\`\`\`bash
# On dr-db as oracle
sqlplus apps/<apps_password> << 'EOF'
-- Record original value for restore later
SELECT APPLICATIONS_SYSTEM_NAME FROM FND_PRODUCT_GROUPS;

-- Set DR identifier
UPDATE FND_PRODUCT_GROUPS SET APPLICATIONS_SYSTEM_NAME = 'DR SITE - VIS';
COMMIT;

-- Verify
SELECT APPLICATIONS_SYSTEM_NAME FROM FND_PRODUCT_GROUPS;
EOF
\`\`\`

### 6.2 Layer 2 — Banner Profile Option

This sets a visible DR banner in the EBS Help region visible from every page.

\`\`\`bash
sqlplus apps/<apps_password> << 'EOF'
-- Set Welcome Message to identify DR site (appears in Help header on all pages)
BEGIN
  FND_PROFILE.SAVE(
    X_NAME        => 'HELP_UTIL_SERVLET_WELCOME_MESSAGE',
    X_VALUE       => '*** DR SITE — NOT PRODUCTION — VIS ***',
    X_LEVEL_NAME  => 'SITE',
    X_LEVEL_VALUE => NULL
  );
  COMMIT;
END;
/

-- Also set the Application Instance Name shown in the header tooltip
-- This value is read from FND_PRODUCT_GROUPS but can also be set via GUID profile
BEGIN
  FND_PROFILE.SAVE(
    X_NAME        => 'FND_CUSTOM_OA_INIT_JS',
    X_VALUE       => 'document.title = "[DR SITE] " + document.title;',
    X_LEVEL_NAME  => 'SITE',
    X_LEVEL_VALUE => NULL
  );
  COMMIT;
END;
/

-- Verify profile values were saved
SELECT PROFILE_OPTION_NAME, PROFILE_OPTION_VALUE
FROM FND_PROFILE_OPTION_VALUES FPOV
JOIN FND_PROFILE_OPTIONS FPO
  ON FPO.PROFILE_OPTION_ID = FPOV.PROFILE_OPTION_ID
WHERE FPO.PROFILE_OPTION_NAME IN (
  'HELP_UTIL_SERVLET_WELCOME_MESSAGE',
  'FND_CUSTOM_OA_INIT_JS'
)
AND FPOV.LEVEL_ID = 10001;  -- SITE level
EOF
\`\`\`

### 6.3 Layer 3 — Color Scheme Change

EBS uses OA Framework skins (CSS themes) to control the visual appearance of all pages. Changing the site-level skin provides a full-page visual indicator that every user sees immediately on every page load.

**Option A — Change skin via FND profile option (SQL)**:
\`\`\`bash
sqlplus apps/<apps_password> << 'EOF'
-- Change the site-level OA Framework skin to a different visual theme
-- Available standard skins: BLAF (Oracle Blue), SKYROS (lighter blue), FUSIONFX
-- Changing from production default to a different skin makes all pages look visually distinct
BEGIN
  FND_PROFILE.SAVE(
    X_NAME        => 'FND_LOOK_AND_FEEL',
    X_VALUE       => 'BLAF',
    X_LEVEL_NAME  => 'SITE',
    X_LEVEL_VALUE => NULL
  );
  COMMIT;
END;
/

-- Also update branding to show DR header background via Functional Administrator branding table
-- This changes the header color in the EBS global banner
UPDATE FND_OAM_APP_SYS_STATUS SET STATUS_CODE = 'NORMAL' WHERE MODULE_ID = 1;
COMMIT;
EOF
\`\`\`

**Option B — Custom DR skin with red global header (more visible)**:
\`\`\`bash
# Create a minimal custom CSS override on the DR app server
# This overrides the global header background to red/amber for all users

DR_CSS_DIR="\${OA_HTML}/cabo/styles"
mkdir -p "\${DR_CSS_DIR}"

cat > "\${DR_CSS_DIR}/dr_override.xss" << 'CSSEOF'
<?xml version="1.0" encoding="UTF-8"?>
<styleSheetDocument xmlns="http://xmlns.oracle.com/blaf">
  <styleSheet>
    <!-- Override global header background to amber to identify DR site -->
    <style selector=".OraGlobalHeader">
      background-color: #B8860B;
    </style>
    <style selector=".OraGlobalHeaderText">
      color: #FFFFFF;
      font-weight: bold;
    </style>
    <style selector=".OraNavigationBar">
      background-color: #8B6914;
    </style>
  </styleSheet>
</styleSheetDocument>
CSSEOF

# Register the custom skin override with OAF
# This requires placing the reference in the OAF skin registry
# Or use the simpler approach: add a CSS injection via custom OAF init JS (already done in 6.2)
echo "Custom DR skin file created at \${DR_CSS_DIR}/dr_override.xss"
\`\`\`

**Option C — Oracle Functional Administrator UI (recommended for standard deployments)**:

1. Log into EBS on the DR app tier as \`SYSADMIN\`
2. Navigate to: **Oracle Functional Administrator** responsibility → **Core Services** → **Branding**
3. Change **Header Background Color** to \`#B8860B\` (amber) or \`#CC0000\` (red)
4. Set **Application Name** to \`DR SITE - VIS\`
5. Click **Apply** — takes effect on next page load for all users

### 6.4 Clear Profile Cache to Apply Changes Immediately

After changing FND profile values, the OAF profile cache must be refreshed:
\`\`\`bash
sqlplus apps/<apps_password> << 'EOF'
-- Force profile cache refresh
EXECUTE FND_CACHE_VERSIONS_PKG.UPDATE_ALL_VERSIONS;
COMMIT;

-- Alternatively, update the cache version for profiles specifically
UPDATE FND_CACHE_VERSIONS SET CACHE_VERSION = CACHE_VERSION + 1
WHERE CACHE_NAME = 'PROFILES';
COMMIT;
EOF
\`\`\`

---

## Phase 7: Sysadmin Login and Validation

### 7.1 Log Into EBS as SYSADMIN

\`\`\`
URL: https://dr-app.internal.example.com:4443/OA_HTML/AppsLocalLogin.jsp
Username: SYSADMIN
Password: <sysadmin_password>
\`\`\`

**Confirm after login**:
- [ ] Browser window title shows \`[DR SITE]\` prefix
- [ ] EBS header shows system name \`DR SITE - VIS\`
- [ ] Global header color is different from production (amber/red if custom skin applied)
- [ ] Help header shows \`*** DR SITE — NOT PRODUCTION — VIS ***\`

### 7.2 Navigate to Key Responsibilities

\`\`\`
System Administrator → Profile → System
  Search for: FND_LOOK_AND_FEEL
  Confirm Site-level value shows the DR skin value

System Administrator → Concurrent → Manager → Administer
  Confirm: Internal Manager is Running
  Confirm: Standard Manager is Running
  Confirm: Conflict Resolution Manager is Running
\`\`\`

### 7.3 Verify Database Connectivity from EBS UI

Navigate to: **System Administrator → Oracle Applications Manager → Database**

Confirm:
- [ ] Database shows connected to \`dr-db.internal.example.com\`
- [ ] Database role shows \`PRIMARY\` (snapshot standby is read-write, appears as primary to EBS)
- [ ] Database version and patch level are correct

### 7.4 Submit a Test Concurrent Program

\`\`\`
System Administrator → Requests → Run
  Program: Active Users
  Submit → Note Request ID

View → Requests → Find Request ID
  Confirm status transitions: Pending → Running → Completed Normal
\`\`\`

### 7.5 Test a Representative Transaction

Based on the modules in scope, complete at least one representative transaction per functional area:

\`\`\`
Payables: Navigate to Invoices → Enter a test invoice → Save
  Confirm: No ORA- errors, invoice status = Needs Approval or Approved

General Ledger: Navigate to Journals → New Journal
  Enter a balanced journal entry → Post
  Confirm: Journal status = Posted

Purchasing: Navigate to Purchase Orders → New PO
  Enter a line → Approve (or submit for approval)
  Confirm: PO status transitions correctly
\`\`\`

**All test transactions will be discarded when the snapshot standby is converted back to physical standby — this is expected and by design.**

---

## Phase 8: Convert Back to Physical Standby

### 8.1 Stop EBS Services on DR App Tier

\`\`\`bash
# On dr-app as applmgr
source /u01/oracle/VIS/EBSapps.env run
\$ADMIN_SCRIPTS_HOME/adstpall.sh apps/<apps_password>

# Verify all Java processes have stopped
sleep 30
ps -ef | grep -E "(weblogic|java.*wls)" | grep -v grep
# Should return nothing (or just the grep itself)
\`\`\`

### 8.2 Restore DR Site Profile Values to Pre-Test State

Before converting the DB back, restore the FND profile values so the next DR test starts clean:
\`\`\`bash
sqlplus apps/<apps_password> << 'EOF'
-- Restore system name to original value
UPDATE FND_PRODUCT_GROUPS SET APPLICATIONS_SYSTEM_NAME = 'VIS';
COMMIT;

-- Remove DR-specific profile values
BEGIN
  FND_PROFILE.SAVE(
    X_NAME        => 'HELP_UTIL_SERVLET_WELCOME_MESSAGE',
    X_VALUE       => NULL,
    X_LEVEL_NAME  => 'SITE',
    X_LEVEL_VALUE => NULL
  );
  FND_PROFILE.SAVE(
    X_NAME        => 'FND_CUSTOM_OA_INIT_JS',
    X_VALUE       => NULL,
    X_LEVEL_NAME  => 'SITE',
    X_LEVEL_VALUE => NULL
  );
  COMMIT;
END;
/

-- Force cache refresh
EXECUTE FND_CACHE_VERSIONS_PKG.UPDATE_ALL_VERSIONS;
COMMIT;
EOF
\`\`\`

### 8.3 Convert Snapshot Standby Back to Physical Standby

\`\`\`bash
# On dr-db as oracle
sqlplus / as sysdba << 'EOF'
-- Shut down the read-write instance
SHUTDOWN IMMEDIATE;

-- Mount the database
STARTUP MOUNT;

-- Convert back to physical standby
-- Oracle automatically flashes back to the guaranteed restore point
-- and drops the restore point after conversion
ALTER DATABASE CONVERT TO PHYSICAL STANDBY;

-- Verify role change
SELECT NAME, DB_UNIQUE_NAME, DATABASE_ROLE, OPEN_MODE FROM V\$DATABASE;
-- DATABASE_ROLE: PHYSICAL STANDBY
-- OPEN_MODE: MOUNTED

-- Restart managed recovery
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE USING CURRENT LOGFILE DISCONNECT;

-- Verify MRP is running
SELECT PROCESS, STATUS, SEQUENCE#, BLOCK#
FROM V\$MANAGED_STANDBY
WHERE PROCESS IN ('MRP0','RFS');
EOF
\`\`\`

### 8.4 Verify Redo Catchup

The standby will now apply all redo that accumulated during the test. Monitor catchup progress:

\`\`\`bash
sqlplus / as sysdba << 'EOF'
-- Check apply lag — should decrease from test-duration hours toward zero
SELECT NAME, VALUE, DATUM_TIME
FROM V\$DATAGUARD_STATS
WHERE NAME IN ('apply lag','transport lag','redo apply rate');

-- Check last applied sequence
SELECT MAX(SEQUENCE#) AS LAST_APPLIED FROM V\$ARCHIVED_LOG WHERE APPLIED='YES';

-- Check current primary sequence (from primary DB for comparison)
-- On primary: SELECT MAX(SEQUENCE#) FROM V\$ARCHIVED_LOG;
EOF
\`\`\`

Allow 10–30 minutes for full catchup depending on redo volume generated during the test. The apply lag will trend toward zero as MRP works through the buffered archive logs.

### 8.5 Verify No Restore Point Remains

\`\`\`bash
sqlplus / as sysdba << 'EOF'
-- The SNAPSHOT_STANDBY_REQUIRED restore point should be gone
SELECT NAME, SCN, GUARANTEE_FLASHBACK_DATABASE
FROM V\$RESTORE_POINT
WHERE GUARANTEE_FLASHBACK_DATABASE = 'YES';
-- Expected: 0 rows
EOF
\`\`\`

---

## Phase 9: Monitoring Scripts

### 9.1 FRA Space Monitor During Test Window

Create \`/home/oracle/scripts/check_fra_space.sh\` (run on dr-db during test):

\`\`\`bash
#!/bin/bash
# Monitor FRA space usage on the standby during snapshot standby test
# Alerts before FRA is exhausted, which would prevent flashback and conversion back

ORACLE_SID=VIS
ORACLE_HOME=/u01/oracle/product/19.3.0/dbhome_1
PATH=\${ORACLE_HOME}/bin:\${PATH}
export ORACLE_SID ORACLE_HOME PATH

WARN_PCT=70
CRIT_PCT=85
LOG_FILE="/home/oracle/logs/fra_monitor_\$(date +%Y%m%d).log"
mkdir -p /home/oracle/logs

RESULT=\$(sqlplus -s / as sysdba << 'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT ROUND((SPACE_USED / SPACE_LIMIT) * 100, 1) AS PCT_USED,
       ROUND(SPACE_LIMIT/1073741824, 1) AS LIMIT_GB,
       ROUND(SPACE_USED/1073741824, 1) AS USED_GB,
       ROUND((SPACE_LIMIT - SPACE_USED - SPACE_RECLAIMABLE)/1073741824, 1) AS FREE_GB
FROM V\$RECOVERY_FILE_DEST;
EXIT;
EOF
)

PCT_USED=\$(echo "\${RESULT}" | awk '{print \$1}')
LIMIT_GB=\$(echo "\${RESULT}" | awk '{print \$2}')
USED_GB=\$(echo "\${RESULT}" | awk '{print \$3}')
FREE_GB=\$(echo "\${RESULT}" | awk '{print \$4}')

LOG_LINE="\$(date): FRA usage \${PCT_USED}% (\${USED_GB}GB / \${LIMIT_GB}GB, free \${FREE_GB}GB)"

if [ "\$(echo "\${PCT_USED} >= \${CRIT_PCT}" | bc 2>/dev/null)" == "1" ]; then
  echo "CRITICAL: \${LOG_LINE}" | tee -a "\${LOG_FILE}"
  # echo "FRA CRITICAL on dr-db: \${LOG_LINE}" | mail -s "FRA CRITICAL - DR Test at Risk" dba-alerts@example.com
  exit 2
elif [ "\$(echo "\${PCT_USED} >= \${WARN_PCT}" | bc 2>/dev/null)" == "1" ]; then
  echo "WARNING: \${LOG_LINE}" | tee -a "\${LOG_FILE}"
  exit 1
fi

echo "\${LOG_LINE}" >> "\${LOG_FILE}"
\`\`\`

### 9.2 Redo Transport Health Monitor During Test Window

Create \`/home/oracle/scripts/check_redo_transport_test.sh\` (run on dr-db during test):

\`\`\`bash
#!/bin/bash
# During snapshot standby test: verify redo from primary is still arriving
# Alerts if no new archived logs have arrived in the last 10 minutes

ORACLE_SID=VIS
ORACLE_HOME=/u01/oracle/product/19.3.0/dbhome_1
PATH=\${ORACLE_HOME}/bin:\${PATH}
export ORACLE_SID ORACLE_HOME PATH

MAX_GAP_MINUTES=10
LOG_FILE="/home/oracle/logs/redo_transport_\$(date +%Y%m%d).log"
mkdir -p /home/oracle/logs

RESULT=\$(sqlplus -s / as sysdba << 'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT ROUND((SYSDATE - MAX(NEXT_TIME)) * 1440, 1) AS MINUTES_SINCE_LAST_LOG,
       MAX(SEQUENCE#) AS LAST_SEQUENCE
FROM V\$ARCHIVED_LOG
WHERE DEST_ID = 1
AND STANDBY_DEST = 'YES';
EXIT;
EOF
)

MINUTES_SINCE=\$(echo "\${RESULT}" | awk '{print \$1}')
LAST_SEQ=\$(echo "\${RESULT}" | awk '{print \$2}')

if [ -z "\${MINUTES_SINCE}" ] || [ "\${MINUTES_SINCE}" = "" ]; then
  echo "\$(date): ERROR — cannot determine last received log" | tee -a "\${LOG_FILE}"
  exit 2
fi

LOG_LINE="\$(date): Last archived log received \${MINUTES_SINCE} minutes ago (seq \${LAST_SEQ})"

if [ "\$(echo "\${MINUTES_SINCE} >= \${MAX_GAP_MINUTES}" | bc 2>/dev/null)" == "1" ]; then
  echo "WARNING: Redo transport gap — \${LOG_LINE}" | tee -a "\${LOG_FILE}"
  # echo "Redo transport gap on dr-db during DR test: \${LOG_LINE}" | mail -s "Redo Transport Gap" dba-alerts@example.com
  exit 1
fi

echo "\${LOG_LINE}" >> "\${LOG_FILE}"
\`\`\`

### 9.3 Post-Conversion Catchup Monitor

Create \`/home/oracle/scripts/monitor_dg_catchup.sh\`:

\`\`\`bash
#!/bin/bash
# After converting back to physical standby: monitor apply lag until catchup is complete
# Print progress every 60 seconds until lag is under 30 seconds

ORACLE_SID=VIS
ORACLE_HOME=/u01/oracle/product/19.3.0/dbhome_1
PATH=\${ORACLE_HOME}/bin:\${PATH}
export ORACLE_SID ORACLE_HOME PATH

TARGET_LAG_SECS=30
LOG_FILE="/home/oracle/logs/dg_catchup_\$(date +%Y%m%d_%H%M%S).log"
mkdir -p /home/oracle/logs

echo "Monitoring Data Guard catchup after snapshot standby test..." | tee "\${LOG_FILE}"
echo "Target: apply lag < \${TARGET_LAG_SECS} seconds" | tee -a "\${LOG_FILE}"

while true; do
  RESULT=\$(sqlplus -s / as sysdba << 'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT A.VALUE AS APPLY_LAG, B.VALUE AS TRANSPORT_LAG, C.VALUE AS APPLY_RATE
FROM (SELECT VALUE FROM V\$DATAGUARD_STATS WHERE NAME='apply lag') A,
     (SELECT VALUE FROM V\$DATAGUARD_STATS WHERE NAME='transport lag') B,
     (SELECT VALUE FROM V\$DATAGUARD_STATS WHERE NAME='redo apply rate') C;
EXIT;
EOF
  )

  APPLY_LAG=\$(echo "\${RESULT}" | awk '{print \$1}')
  TRANSPORT_LAG=\$(echo "\${RESULT}" | awk '{print \$2}')
  APPLY_RATE=\$(echo "\${RESULT}" | awk '{print \$3}')

  LOG_LINE="\$(date): apply_lag=\${APPLY_LAG} transport_lag=\${TRANSPORT_LAG} apply_rate=\${APPLY_RATE}"
  echo "\${LOG_LINE}" | tee -a "\${LOG_FILE}"

  # Parse lag seconds for comparison
  LAG_SECS=\$(echo "\${APPLY_LAG}" | awk -F'[: +]' '{print (\$2*86400)+(\$3*3600)+(\$4*60)+\$5}' 2>/dev/null || echo 999)

  if [ "\${LAG_SECS}" -lt "\${TARGET_LAG_SECS}" ] 2>/dev/null; then
    echo "Catchup complete: apply lag is \${LAG_SECS} seconds (< \${TARGET_LAG_SECS}s target)" | tee -a "\${LOG_FILE}"
    break
  fi

  sleep 60
done
\`\`\`

### 9.4 Crontab — Active Monitoring During Test Window

These entries are enabled at the start of the test and disabled afterward.

On dr-db (as oracle):
\`\`\`
# Enable for DR test window — check FRA every 5 minutes
*/5 * * * * /home/oracle/scripts/check_fra_space.sh >> /home/oracle/logs/fra_cron.log 2>&1

# Check redo transport health every 5 minutes during test
*/5 * * * * /home/oracle/scripts/check_redo_transport_test.sh >> /home/oracle/logs/redo_cron.log 2>&1
\`\`\`

Remove entries after the test completes and the standby has converted back.

---

## Phase 10: Post-Test Documentation

Record the following for each DR test:

\`\`\`
DR Test Record — Oracle EBS 12.2.11
====================================
Test date:
Test type: [ ] Snapshot Standby Test  [ ] Switchover  [ ] Failover
Participants:

Timing:
  Physical → Snapshot conversion started:
  Physical → Snapshot conversion completed:
  AutoConfig started:
  AutoConfig completed:
  Cache clear completed:
  EBS services started:
  DR site identification configured:
  Functional validation started:
  Functional validation completed:
  Snapshot → Physical conversion started:
  Snapshot → Physical conversion completed:
  Redo catchup completed:
  Total test duration:

Data Guard metrics:
  Apply lag at test start:
  Max apply lag during test:
  Apply lag at conversion back:
  Time to full catchup after conversion:
  Max FRA usage during test:

Validation results:
  [ ] Login page accessible on DR site
  [ ] System name shows DR SITE in header
  [ ] Banner profile visible on all pages
  [ ] Color scheme change applied
  [ ] Sysadmin login successful
  [ ] Concurrent Manager running
  [ ] Test concurrent program completed
  [ ] Representative transaction completed

Issues encountered:

Corrective actions taken:

Signed off by:
\`\`\`

---

## Quick Reference

| Task | Command |
|------|---------|
| Check physical standby role | \`SELECT DATABASE_ROLE, FLASHBACK_ON FROM V\$DATABASE;\` |
| Stop MRP | \`ALTER DATABASE RECOVER MANAGED STANDBY DATABASE CANCEL;\` |
| Convert to snapshot standby | \`ALTER DATABASE CONVERT TO SNAPSHOT STANDBY;\` |
| Open snapshot standby | \`ALTER DATABASE OPEN;\` |
| Convert back to physical standby | \`SHUTDOWN IMMEDIATE; STARTUP MOUNT; ALTER DATABASE CONVERT TO PHYSICAL STANDBY;\` |
| Resume managed recovery | \`ALTER DATABASE RECOVER MANAGED STANDBY DATABASE USING CURRENT LOGFILE DISCONNECT;\` |
| Check restore points | \`SELECT NAME, GUARANTEE_FLASHBACK_DATABASE FROM V\$RESTORE_POINT;\` |
| Check apply lag | \`SELECT NAME, VALUE FROM V\$DATAGUARD_STATS;\` |
| Check FRA space | \`SELECT ROUND((SPACE_USED/SPACE_LIMIT)*100,1) PCT FROM V\$RECOVERY_FILE_DEST;\` |
| Set DR system name | \`UPDATE FND_PRODUCT_GROUPS SET APPLICATIONS_SYSTEM_NAME='DR SITE - VIS';\` |
| Clear profile cache | \`EXEC FND_CACHE_VERSIONS_PKG.UPDATE_ALL_VERSIONS;\` |
| Run AutoConfig | \`perl \${AD_TOP}/bin/adconfig.pl contextfile=\${CONTEXT_FILE} apply=yes run=INSTE8\` |
| Start EBS | \`\$ADMIN_SCRIPTS_HOME/adstrtal.sh apps/<pass>\` |
| Stop EBS | \`\$ADMIN_SCRIPTS_HOME/adstpall.sh apps/<pass>\` |`,
};

async function main() {
  console.log('Inserting EBS DR snapshot standby runbook...');
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
