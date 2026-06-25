import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS 12.2.11 PDB Clone Runbook: RMAN Active Duplication, noncdb_to_pdb, adpreclone, and adcfgclone on RHEL 9',
  slug: 'oracle-ebs-12211-pdb-clone-runbook',
  excerpt:
    'Complete runbook for cloning Oracle EBS 12.2.11 to a Pluggable Database on RHEL 9 — creating the target CDB, running adpreclone on the source database and application tiers, RMAN active duplication from non-CDB to PDB with the AS PLUGGABLE DATABASE clause, noncdb_to_pdb.sql conversion, listener and tnsnames registration, adcfgclone for both database and application tiers, post-clone hardening (passwords, FNDCPASS, disabled jobs, integration lockdown, environment identification), and monitoring scripts for clone age and EBS service health.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-25'),
  youtubeUrl: null,
  content: `## Overview

This runbook covers end-to-end cloning of Oracle EBS 12.2.11 from a production non-CDB Oracle 19c database into a Pluggable Database (PDB) within a CDB on a RHEL 9 clone server. The result is a fully functional EBS test or development environment with its own application tier, separate passwords, and visible environment identification.

**Source environment**:
- Production DB host: \`prod-db.internal.example.com\`
- Production App host: \`prod-app.internal.example.com\`
- Oracle SID: \`VIS\` (non-CDB)
- EBS base: \`/u01/oracle/VIS\`
- Oracle home: \`/u01/oracle/product/19.3.0/dbhome_1\`

**Clone target environment**:
- Clone DB host: \`clone-db.internal.example.com\`
- Clone App host: \`clone-app.internal.example.com\`
- CDB name: \`CDBTEST\`
- PDB name: \`VIS_TEST\`
- EBS base: \`/u01/oracle/VIS_TEST\`
- Clone Oracle home: \`/u01/oracle/product/19.3.0/dbhome_1\`

---

## Phase 1: Clone Server Prerequisites

### 1.1 OS and Oracle Software on Clone Servers

Both clone-db and clone-app must have the same RHEL 9 and Oracle 19c patch levels as production. Repeat the OS prerequisite steps from the EBS 12.2.11 RHEL 9 installation runbook on both clone servers:
- Required RPM packages (gcc, libaio, libnsl2, libstdc++, etc.)
- Kernel parameters (\`/etc/sysctl.d/99-oracle-ebs.conf\`)
- User limits (\`/etc/security/limits.d/99-oracle-ebs.conf\`)
- oracle and applmgr users and groups
- Oracle 19c database software installed (same RU patch level as production)
- Python symlink: \`alternatives --set python /usr/bin/python3\`

### 1.2 Storage Layout on Clone DB Host

\`\`\`bash
# Create mount points for CDB and PDB datafiles
mkdir -p /u01/oracle/oradata/CDBTEST
mkdir -p /u01/oracle/oradata/VIS_TEST
mkdir -p /u01/oracle/fast_recovery_area/CDBTEST
chown -R oracle:oinstall /u01/oracle/oradata /u01/oracle/fast_recovery_area
chmod -R 775 /u01/oracle/oradata /u01/oracle/fast_recovery_area
\`\`\`

### 1.3 Network Connectivity

\`\`\`bash
# From clone-db, verify TCP connectivity to production DB on port 1521
nc -zv prod-db.internal.example.com 1521

# From clone-app, verify TCP connectivity to clone-db on port 1521
nc -zv clone-db.internal.example.com 1521

# Verify passwordless SSH from clone-app to prod-app (for app tier tar transfer)
ssh applmgr@prod-app.internal.example.com "hostname"
\`\`\`

---

## Phase 2: Create Target CDB on Clone DB Host

The target CDB is the container that will hold the cloned EBS PDB. Create it with DBCA or manually.

### 2.1 Create CDB with DBCA (Silent)

\`\`\`bash
su - oracle   # On clone-db

# Set environment
export ORACLE_HOME=/u01/oracle/product/19.3.0/dbhome_1
export ORACLE_SID=CDBTEST
export PATH=\${ORACLE_HOME}/bin:\${PATH}

# Create CDB (no seed PDB population — we only need the CDB frame)
dbca -silent -createDatabase \\
  -templateName General_Purpose.dbc \\
  -gdbName CDBTEST \\
  -sid CDBTEST \\
  -responseFile NO_VALUE \\
  -characterSet AL32UTF8 \\
  -sysPassword <cdb_sys_password> \\
  -systemPassword <cdb_system_password> \\
  -createAsContainerDatabase true \\
  -numberOfPDBs 0 \\
  -databaseType MULTIPURPOSE \\
  -automaticMemoryManagement false \\
  -totalMemory 32768 \\
  -datafileDestination /u01/oracle/oradata/CDBTEST \\
  -recoveryAreaDestination /u01/oracle/fast_recovery_area/CDBTEST \\
  -recoveryAreaSize 102400 \\
  -storageType FS \\
  -enableArchive true \\
  -initParams "db_name=CDBTEST,db_unique_name=CDBTEST,\\
    enable_pluggable_database=true,\\
    pdb_lockdown=,\\
    processes=600,open_cursors=500,\\
    log_archive_format=%t_%s_%r.arc,\\
    log_archive_dest_1='LOCATION=/u01/oracle/fast_recovery_area/CDBTEST/archive'" \\
  -redoLogFileSize 512

# Verify CDB created successfully
sqlplus / as sysdba << 'EOF'
SELECT NAME, DB_UNIQUE_NAME, CDB, CON_ID FROM V\$DATABASE;
-- CDB must be YES
EOF
\`\`\`

### 2.2 Configure Listener for CDB

\`\`\`bash
# /u01/oracle/product/19.3.0/dbhome_1/network/admin/listener.ora
cat > \${ORACLE_HOME}/network/admin/listener.ora << 'EOF'
LISTENER =
  (DESCRIPTION_LIST =
    (DESCRIPTION =
      (ADDRESS = (PROTOCOL = TCP)(HOST = clone-db.internal.example.com)(PORT = 1521))
    )
  )

SID_LIST_LISTENER =
  (SID_LIST =
    (SID_DESC =
      (GLOBAL_DBNAME = CDBTEST)
      (ORACLE_HOME = /u01/oracle/product/19.3.0/dbhome_1)
      (SID_NAME = CDBTEST)
    )
  )

ADR_BASE_LISTENER = /u01/oracle
EOF

lsnrctl stop
lsnrctl start
lsnrctl status
\`\`\`

### 2.3 Configure TNS on Both Clone DB and Prod DB Hosts

Add to \`tnsnames.ora\` on **clone-db** (\`\${ORACLE_HOME}/network/admin/tnsnames.ora\`):

\`\`\`
CDBTEST =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = clone-db.internal.example.com)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = CDBTEST)
    )
  )

VIS =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = prod-db.internal.example.com)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = VIS)
      (UR = A)
    )
  )
\`\`\`

Add to \`tnsnames.ora\` on **prod-db** (so RMAN on prod-db can reach the CDB auxiliary):

\`\`\`
CDBTEST =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = clone-db.internal.example.com)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = CDBTEST)
    )
  )
\`\`\`

\`\`\`bash
# Test connectivity
tnsping CDBTEST   # From prod-db — must reach clone-db
tnsping VIS       # From clone-db — must reach prod-db
\`\`\`

---

## Phase 3: Source DB Preparation — adpreclone.pl

Run on the **production DB host** as oracle. This step does not require any EBS downtime.

\`\`\`bash
su - oracle   # On prod-db
source /u01/oracle/VIS/EBSapps.env run   # or set manually:
# export ORACLE_HOME=/u01/oracle/product/19.3.0/dbhome_1
# export ORACLE_SID=VIS
# export TWO_TASK=VIS

echo "Running adpreclone.pl dbTier on production database..."
perl \${AD_TOP}/bin/adpreclone.pl dbTier

# Expected output: "adpreclone completed successfully"
# Log file: $ORACLE_HOME/appsutil/log/<CONTEXT_NAME>/adpreclone.log
\`\`\`

**What adpreclone.pl dbTier does**:
- Generates \`\${ORACLE_HOME}/appsutil/clone/bin/\` with all clone scripts and Perl libraries
- Writes the source environment's context template to \`\${ORACLE_HOME}/appsutil/template/\`
- Cleans up runtime PID files and temporary files that should not appear in the clone
- Records the source database topology in a format that adcfgclone reads on the target

\`\`\`bash
# Verify adpreclone output is present
ls -la \${ORACLE_HOME}/appsutil/clone/bin/adcfgclone.pl
ls -la \${ORACLE_HOME}/appsutil/template/
\`\`\`

---

## Phase 4: Source App Tier Preparation — adpreclone.pl

Run on the **production app host** as applmgr.

\`\`\`bash
su - applmgr   # On prod-app
source /u01/oracle/VIS/EBSapps.env run

echo "Running adpreclone.pl appsTier on production application tier..."
perl \${AD_TOP}/bin/adpreclone.pl appsTier

# Prompts: apps password, weblogic password
# Log file: $APPLCSF/log/adpreclone_<timestamp>.log
\`\`\`

**What adpreclone.pl appsTier does**:
- Generates \`\${COMMON_TOP}/clone/\` with adcfgclone.pl and all clone Perl libraries
- Generates a context template file under \`\${COMMON_TOP}/clone/context/\`
- Cleans WebLogic domain: removes node-specific lock files, PID files, and session data
- Removes compiled Forms cache and OAF class cache that is environment-specific
- Records application tier topology for adcfgclone on target

\`\`\`bash
# Verify adpreclone output
ls -la \${COMMON_TOP}/clone/bin/adcfgclone.pl
ls -la \${COMMON_TOP}/clone/context/
\`\`\`

---

## Phase 5: RMAN Active Duplication — Non-CDB to PDB

Run on the **production DB host** as oracle. This streams the production database over the network directly into the target CDB as a new PDB. The production database remains fully open during duplication.

### 5.1 Verify RMAN Connectivity

\`\`\`bash
# From prod-db: test connection to CDB auxiliary instance
rman target sys/<prod_sys_password>@VIS auxiliary sys/<cdb_sys_password>@CDBTEST << 'EOF'
-- Should connect without errors
EXIT;
EOF
\`\`\`

### 5.2 Run RMAN Active Duplication

\`\`\`bash
rman target sys/<prod_sys_password>@VIS auxiliary sys/<cdb_sys_password>@CDBTEST << 'EOF'
DUPLICATE DATABASE VIS
  TO CDBTEST
  AS PLUGGABLE DATABASE VIS_TEST
  FROM ACTIVE DATABASE
  USING COMPRESSED BACKUPSET
  SECTION SIZE 4G
  SPFILE
    SET DB_UNIQUE_NAME='CDBTEST'
    SET CONTROL_FILES=('/u01/oracle/oradata/CDBTEST/control01.ctl',
                       '/u01/oracle/fast_recovery_area/CDBTEST/control02.ctl')
    SET LOG_ARCHIVE_DEST_1='LOCATION=/u01/oracle/fast_recovery_area/CDBTEST/archive'
    SET AUDIT_FILE_DEST='/u01/oracle/admin/CDBTEST/adump'
    SET DIAGNOSTIC_DEST='/u01/oracle'
  DB_FILE_NAME_CONVERT
    '/u01/oracle/oradata/VIS/', '/u01/oracle/oradata/VIS_TEST/'
  LOGFILE
    GROUP 1 '/u01/oracle/oradata/CDBTEST/redo01.log' SIZE 512M,
    GROUP 2 '/u01/oracle/oradata/CDBTEST/redo02.log' SIZE 512M,
    GROUP 3 '/u01/oracle/oradata/CDBTEST/redo03.log' SIZE 512M
  NOFILENAMECHECK;
EOF
\`\`\`

This operation takes 1–6 hours depending on database size and network bandwidth. Monitor progress:
\`\`\`bash
# On clone-db in a separate session — watch RMAN channels
sqlplus / as sysdba << 'EOF'
SELECT SID, SERIAL#, OPNAME, SOFAR, TOTALWORK,
       ROUND(SOFAR/TOTALWORK*100,1) AS PCT_DONE,
       TIME_REMAINING
FROM V\$SESSION_LONGOPS
WHERE OPNAME LIKE 'RMAN%' AND TOTALWORK > 0
ORDER BY TIME_REMAINING;
EOF
\`\`\`

---

## Phase 6: noncdb_to_pdb.sql Conversion

After RMAN completes, the PDB is in restricted mode and cannot accept normal connections until the non-CDB dictionary metadata is converted. This is mandatory.

\`\`\`bash
# On clone-db as oracle
export ORACLE_SID=CDBTEST
export ORACLE_HOME=/u01/oracle/product/19.3.0/dbhome_1
export PATH=\${ORACLE_HOME}/bin:\${PATH}

sqlplus / as sysdba << 'EOF'
-- Verify the PDB was created and is in restricted mode
SELECT PDB_NAME, STATUS, RESTRICTED FROM CDB_PDBS;
-- VIS_TEST should show STATUS=NEW or MOUNTED

-- Open the PDB in restricted mode for the conversion script
ALTER PLUGGABLE DATABASE VIS_TEST OPEN RESTRICTED;

-- Switch into the PDB context
ALTER SESSION SET CONTAINER = VIS_TEST;

-- Verify we are inside the PDB
SELECT SYS_CONTEXT('USERENV','CON_NAME') AS CONTAINER FROM DUAL;
-- Should return: VIS_TEST

-- Run the conversion script (takes 30–90 minutes for a typical EBS database)
@?/rdbms/admin/noncdb_to_pdb.sql

-- Script completes with "Done" message
-- Close and reopen the PDB to apply conversion
ALTER PLUGGABLE DATABASE CLOSE IMMEDIATE;
ALTER PLUGGABLE DATABASE OPEN;

-- Verify the PDB is now open and no longer restricted
SELECT PDB_NAME, STATUS, RESTRICTED FROM CDB_PDBS WHERE PDB_NAME = 'VIS_TEST';
-- STATUS = NORMAL, RESTRICTED = NO
EOF
\`\`\`

### 6.1 Register PDB with Listener and Save Open State

\`\`\`bash
sqlplus / as sysdba << 'EOF'
-- Save the PDB open state so it reopens automatically after CDB restart
ALTER PLUGGABLE DATABASE VIS_TEST SAVE STATE;

-- Verify PDB services are registered with the listener
SELECT NAME, NETWORK_NAME, PDB FROM CDB_SERVICES WHERE CON_ID > 2;
-- VIS_TEST service should appear
EOF

# Verify listener sees the PDB service
lsnrctl status | grep VIS_TEST
\`\`\`

### 6.2 Add VIS_TEST to Clone DB tnsnames.ora

\`\`\`
VIS_TEST =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = clone-db.internal.example.com)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = VIS_TEST)
    )
  )
\`\`\`

\`\`\`bash
tnsping VIS_TEST   # Must succeed from clone-db
\`\`\`

---

## Phase 7: Clone DB Tier Configuration — adcfgclone.pl

### 7.1 Copy Oracle Home Appsutil from Source

The adcfgclone.pl script for the DB tier lives in the Oracle home's appsutil directory. Since we cloned the database (not the Oracle home binary), we need to copy the appsutil clone bundle from the source Oracle home.

\`\`\`bash
# On prod-db: tar the appsutil clone directory
su - oracle   # On prod-db
tar -czf /tmp/appsutil_clone.tar.gz \\
  \${ORACLE_HOME}/appsutil/clone \\
  \${ORACLE_HOME}/appsutil/template \\
  \${ORACLE_HOME}/appsutil/bin

# Transfer to clone-db
scp /tmp/appsutil_clone.tar.gz oracle@clone-db.internal.example.com:/tmp/

# On clone-db: extract into the Oracle home
su - oracle   # On clone-db
tar -xzf /tmp/appsutil_clone.tar.gz -C /
\`\`\`

### 7.2 Create the Clone Context File

The clone context file drives adcfgclone — it contains all target-specific values. Start from the template generated by adpreclone on the source, then update target-specific fields.

\`\`\`bash
# On clone-db: copy the template and create the clone context file
CLONE_CONTEXT_DIR="\${ORACLE_HOME}/appsutil/template"
CLONE_CONTEXT_FILE="\${CLONE_CONTEXT_DIR}/VIS_TEST_clone-db.xml"

cp \${CLONE_CONTEXT_DIR}/VIS_prod-db.xml \${CLONE_CONTEXT_FILE}

# Update target-specific values in the context file
# Key fields to change:
# s_dbhost         -> clone-db.internal.example.com
# s_db_name        -> VIS_TEST
# s_apps_db_name   -> VIS_TEST
# s_db_unique_name -> VIS_TEST
# s_platform       -> LINUX (verify)
# s_db_oracle_home -> /u01/oracle/product/19.3.0/dbhome_1
# s_dbSid          -> CDBTEST (the CDB SID — VIS_TEST is the PDB)

# Use sed for non-interactive bulk update:
sed -i "s|prod-db\.internal\.example\.com|clone-db.internal.example.com|g" \${CLONE_CONTEXT_FILE}
sed -i 's|<s_db_name[^>]*>VIS</s_db_name>|<s_db_name oa_var="s_db_name">VIS_TEST</s_db_name>|g' \${CLONE_CONTEXT_FILE}
sed -i 's|<s_db_unique_name[^>]*>VIS[^<]*</s_db_unique_name>|<s_db_unique_name oa_var="s_db_unique_name">VIS_TEST</s_db_unique_name>|g' \${CLONE_CONTEXT_FILE}

echo "Clone context file created: \${CLONE_CONTEXT_FILE}"
\`\`\`

### 7.3 Run adcfgclone.pl dbTier

\`\`\`bash
# On clone-db as oracle
cd \${ORACLE_HOME}/appsutil/clone/bin

perl adcfgclone.pl dbTier \\
  contextfile=\${ORACLE_HOME}/appsutil/template/VIS_TEST_clone-db.xml

# Prompts:
# APPS password: <apps_password_from_production>
# Note: use the PRODUCTION apps password — the clone DB still has production passwords at this point
# Those will be changed in Phase 10 (post-clone hardening)

# Log: $ORACLE_HOME/appsutil/log/VIS_TEST_clone-db/adcfgclone_<timestamp>.log
\`\`\`

adcfgclone.pl dbTier will:
- Update \`FND_APP_SERVERS\` with the clone DB hostname
- Update \`FND_OAM_CONTEXT_FILE\` with the new context file path
- Configure the Oracle listener for the PDB service
- Run AutoConfig on the DB Oracle home

---

## Phase 8: Application Tier Archive and Transfer

### 8.1 Create Application Tier Archive on Source

\`\`\`bash
# On prod-app as applmgr — adpreclone.pl must have completed in Phase 4
su - applmgr   # On prod-app

EBS_BASE="/u01/oracle/VIS"
ARCHIVE_FILE="/backup/VIS_apptier_\$(date +%Y%m%d_%H%M).tar.gz"

echo "Creating application tier archive..."
echo "This will take 30–90 minutes for a typical EBS installation."

# Exclude runtime logs, WLS temp/cache, and patch staging
tar -czf \${ARCHIVE_FILE} \\
  --exclude="\${EBS_BASE}/fs_ne/log" \\
  --exclude="\${EBS_BASE}/fs1/FMW/user_projects/domains/EBS_domain_*/servers/*/tmp" \\
  --exclude="\${EBS_BASE}/fs1/FMW/user_projects/domains/EBS_domain_*/servers/*/cache" \\
  --exclude="\${EBS_BASE}/fs2/FMW/user_projects/domains/EBS_domain_*/servers/*/tmp" \\
  --exclude="\${EBS_BASE}/fs2/FMW/user_projects/domains/EBS_domain_*/servers/*/cache" \\
  --exclude="*.pyc" \\
  \${EBS_BASE}

ARCHIVE_SIZE=\$(du -sh \${ARCHIVE_FILE} | cut -f1)
echo "Archive created: \${ARCHIVE_FILE} (\${ARCHIVE_SIZE})"
\`\`\`

### 8.2 Transfer Archive to Clone App Host

\`\`\`bash
# Transfer the archive — can use scp, rsync, or NFS copy
scp \${ARCHIVE_FILE} applmgr@clone-app.internal.example.com:/u01/oracle/

# Or use rsync for faster resume-capable transfer:
rsync -avz --progress \${ARCHIVE_FILE} applmgr@clone-app.internal.example.com:/u01/oracle/
\`\`\`

### 8.3 Extract Archive on Clone App Host

\`\`\`bash
# On clone-app as applmgr
su - applmgr   # On clone-app

mkdir -p /u01/oracle
cd /u01/oracle

ARCHIVE_FILE=\$(ls /u01/oracle/VIS_apptier_*.tar.gz | tail -1)
echo "Extracting: \${ARCHIVE_FILE}"

tar -xzf \${ARCHIVE_FILE} -C /u01/oracle/

# Verify extraction
ls /u01/oracle/VIS/fs1/EBSapps/
ls /u01/oracle/VIS/fs2/EBSapps/
ls /u01/oracle/VIS/fs_ne/inst/
\`\`\`

---

## Phase 9: Clone App Tier Configuration — adcfgclone.pl

### 9.1 Create the Clone App Tier Context File

\`\`\`bash
# On clone-app as applmgr
# The context template is in the extracted archive
CLONE_COMMON_TOP="/u01/oracle/VIS/fs1/EBSapps/comn"
CONTEXT_TEMPLATE="\${CLONE_COMMON_TOP}/clone/context/apps/VIS_prod-app.xml"
CLONE_CONTEXT="\${CLONE_COMMON_TOP}/clone/context/apps/VIS_TEST_clone-app.xml"

cp \${CONTEXT_TEMPLATE} \${CLONE_CONTEXT}

# Update target-specific values:
sed -i "s|prod-app\.internal\.example\.com|clone-app.internal.example.com|g" \${CLONE_CONTEXT}
sed -i "s|prod-db\.internal\.example\.com|clone-db.internal.example.com|g" \${CLONE_CONTEXT}

# Update EBS base path if changed:
# sed -i "s|/u01/oracle/VIS/|/u01/oracle/VIS_TEST/|g" \${CLONE_CONTEXT}

# Update database service name (s_apps_jdbc_connect_alias):
sed -i 's|<s_apps_jdbc_connect_alias[^>]*>VIS[^<]*</s_apps_jdbc_connect_alias>|<s_apps_jdbc_connect_alias oa_var="s_apps_jdbc_connect_alias">VIS_TEST</s_apps_jdbc_connect_alias>|g' \${CLONE_CONTEXT}

echo "Clone app tier context file: \${CLONE_CONTEXT}"
\`\`\`

### 9.2 Run adcfgclone.pl appsTier

\`\`\`bash
# On clone-app as applmgr
source /u01/oracle/VIS/EBSapps.env run 2>/dev/null || true

CLONE_BIN="\${CLONE_COMMON_TOP}/clone/bin"

perl \${CLONE_BIN}/adcfgclone.pl appsTier \\
  contextfile=\${CLONE_CONTEXT}

# Prompts:
# APPS password: <production_apps_password>
# WebLogic admin password: <new_weblogic_password_for_clone>
# WebLogic admin confirm: <same>

# adcfgclone appsTier:
# - Creates a new WebLogic domain for the clone environment
# - Runs AutoConfig with the clone context file
# - Rewrites all 900+ configuration files with clone hostnames/ports/service names
# - Registers the clone app tier in the clone database (FND_APP_SERVERS)
# - Creates clone-specific startup/shutdown scripts

# Log: /u01/oracle/VIS/fs_ne/log/clone/adcfgclone_<timestamp>.log
\`\`\`

### 9.3 Verify adcfgclone Results

\`\`\`bash
source /u01/oracle/VIS/EBSapps.env run

# Verify DBC file references clone DB
grep -i dbhost \${FND_SECURE}/VIS_TEST.dbc

# Verify WebLogic JDBC datasource references VIS_TEST service
grep "VIS_TEST" \${DOMAIN_HOME}/config/jdbc/*.xml | head -3

# Verify OHS apps.conf references clone app host
grep "clone-app" \${ORACLE_HOME}/ohs/conf/moduleconf/apps.conf | head -3

# Verify context file in DB is updated
sqlplus apps/<apps_password> << 'EOF'
SELECT NODE_NAME, NODE_HOST, STATUS
FROM FND_APP_SERVERS
WHERE NODE_HOST LIKE '%clone%';
EOF
\`\`\`

---

## Phase 10: Post-Clone Hardening

### 10.1 Change Database Passwords

\`\`\`bash
# On clone-db — change SYS, SYSTEM, and common schema passwords
sqlplus / as sysdba << 'EOF'
ALTER SESSION SET CONTAINER = VIS_TEST;
ALTER USER SYS IDENTIFIED BY <new_clone_sys_password>;
ALTER USER SYSTEM IDENTIFIED BY <new_clone_system_password>;
-- Do NOT change APPS here — use FNDCPASS (see below)
EOF
\`\`\`

### 10.2 Change APPS Password Using FNDCPASS

FNDCPASS is mandatory for changing the APPS and APPLSYS passwords in EBS because EBS stores the apps password hash in multiple locations (\`FND_USER\`, \`APPLSYS.FND_USER\`, and the DBC file). A plain \`ALTER USER\` change without FNDCPASS will break EBS connectivity.

\`\`\`bash
# On clone-app as applmgr
source /u01/oracle/VIS/EBSapps.env run

FNDCPASS apps/<current_apps_password> 0 Y system/<new_clone_system_password> \\
  SYSTEM APPLSYS <new_clone_apps_password>

# If running FNDCPASS for the first time on the clone, it needs the current
# production APPS password as the -apps argument (the clone still has it)
# After this command, all EBS connections use <new_clone_apps_password>

echo "APPS password changed. Update stored credentials."
\`\`\`

### 10.3 Disable Workflow Mailer (Prevents Email to Real Users)

\`\`\`bash
# On clone-app — stop and prevent Workflow Mailer from starting
sqlplus apps/<new_clone_apps_password> << 'EOF'
-- Disable the Notification Mailer service
BEGIN
  WF_MAILER_PARAMETER_PKG.SetValueForCorr(
    p_correlation => 'APPS_WF_NOTIFICATION_MAILER',
    p_name        => 'MAILINTERVAL',
    p_value       => '-1'
  );
  COMMIT;
END;
/

-- Update the service component container to prevent auto-start
UPDATE FND_SVC_COMPONENTS
SET STARTUP_MODE = 'MANUAL'
WHERE COMPONENT_ID = (
  SELECT COMPONENT_ID FROM FND_SVC_COMPONENTS
  WHERE COMPONENT_TYPE = 'WF_MAILER'
);
COMMIT;
EOF
\`\`\`

### 10.4 Disable Production-Pointing Interface Jobs

\`\`\`bash
sqlplus apps/<new_clone_apps_password> << 'EOF'
-- Disable scheduled concurrent programs that interface with external systems
-- Adjust the program short names to match your environment

-- Disable Auto Post in GL (if applicable)
UPDATE FND_CONCURRENT_REQUESTS
SET STATUS_CODE = 'D', PHASE_CODE = 'C'
WHERE STATUS_CODE = 'I'
AND PROGRAM_APPLICATION_ID IN (
  SELECT APPLICATION_ID FROM FND_APPLICATION WHERE APPLICATION_SHORT_NAME = 'SQLGL'
)
AND CONCURRENT_PROGRAM_ID IN (
  SELECT CONCURRENT_PROGRAM_ID FROM FND_CONCURRENT_PROGRAMS
  WHERE CONCURRENT_PROGRAM_NAME IN ('GLPPOS','GLPAUPOST')
);

-- Disable all repeating requests (set to inactive)
-- Review and selectively disable — this example targets interface programs
UPDATE FND_CONCURRENT_REQUESTS
SET STATUS_CODE = 'D', PHASE_CODE = 'C'
WHERE RESUBMIT_INTERVAL IS NOT NULL
AND STATUS_CODE = 'I'
AND REQUESTED_START_DATE IS NOT NULL;

COMMIT;

-- Show remaining active scheduled requests
SELECT REQUEST_ID, REQUESTED_BY, CONCURRENT_PROGRAM_ID,
       STATUS_CODE, PHASE_CODE, RESUBMIT_INTERVAL
FROM FND_CONCURRENT_REQUESTS
WHERE RESUBMIT_INTERVAL IS NOT NULL
AND STATUS_CODE = 'I'
FETCH FIRST 20 ROWS ONLY;
EOF
\`\`\`

### 10.5 Disable Oracle Payments Gateway Configuration

\`\`\`bash
sqlplus apps/<new_clone_apps_password> << 'EOF'
-- Clear production payment gateway credentials on clone
-- These are stored in IBY_TRXN_EXTENSIONS tables
-- At minimum, mark all payment service providers inactive:
UPDATE IBY_FNDCPT_SYS_OPTIONS SET PAYMENT_SYSTEM_STATUS = 'INACTIVE';
COMMIT;
EOF
\`\`\`

### 10.6 Configure Clone Environment Identification

Set three-layer identification so users never confuse clone with production:

\`\`\`bash
sqlplus apps/<new_clone_apps_password> << 'EOF'
-- Layer 1: System name in EBS header and browser title
UPDATE FND_PRODUCT_GROUPS SET APPLICATIONS_SYSTEM_NAME = 'TEST CLONE - VIS_TEST';
COMMIT;

-- Layer 2: Banner on every page via profile option
BEGIN
  FND_PROFILE.SAVE(
    X_NAME        => 'HELP_UTIL_SERVLET_WELCOME_MESSAGE',
    X_VALUE       => '*** TEST CLONE — NOT PRODUCTION ***',
    X_LEVEL_NAME  => 'SITE',
    X_LEVEL_VALUE => NULL
  );
  COMMIT;
END;
/

-- Add [TEST] prefix to every browser window title via custom JS
BEGIN
  FND_PROFILE.SAVE(
    X_NAME        => 'FND_CUSTOM_OA_INIT_JS',
    X_VALUE       => 'document.title = "[TEST] " + document.title;',
    X_LEVEL_NAME  => 'SITE',
    X_LEVEL_VALUE => NULL
  );
  COMMIT;
END;
/

-- Layer 3: Color scheme (BLAF+ skin - visually different from production default)
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

-- Force profile cache refresh
EXECUTE FND_CACHE_VERSIONS_PKG.UPDATE_ALL_VERSIONS;
COMMIT;
EOF
\`\`\`

---

## Phase 11: Start EBS on Clone and Validate

### 11.1 Start EBS Services

\`\`\`bash
# On clone-app as applmgr
source /u01/oracle/VIS/EBSapps.env run
\$ADMIN_SCRIPTS_HOME/adstrtal.sh apps/<new_clone_apps_password>

# Wait for WebLogic managed servers to start (5–10 minutes)
echo "Waiting for services..."
sleep 120

# Verify all processes running
ps -ef | grep -cE "(weblogic|java.*wls|httpd)"
\`\`\`

### 11.2 Validate Clone Access

\`\`\`bash
# Verify login page is accessible
HTTP_CODE=\$(curl -k -s -o /dev/null -w "%{http_code}" \\
  https://clone-app.internal.example.com:4443/OA_HTML/AppsLocalLogin.jsp)
echo "Login page HTTP: \${HTTP_CODE}"   # Expect 200

# Verify login page references clone environment (not prod)
curl -k -s https://clone-app.internal.example.com:4443/OA_HTML/AppsLocalLogin.jsp \\
  | grep -i "TEST CLONE\|VIS_TEST\|clone-db" | head -3
\`\`\`

### 11.3 Login and Validate

\`\`\`
URL: https://clone-app.internal.example.com:4443/OA_HTML/AppsLocalLogin.jsp
Username: SYSADMIN
Password: <sysadmin_password_inherited_from_production>

Verify:
[ ] Browser title shows [TEST] prefix
[ ] EBS header shows system name: TEST CLONE - VIS_TEST
[ ] Help banner shows: *** TEST CLONE — NOT PRODUCTION ***
[ ] Navigate to any module — no ORA- errors
[ ] Submit an Active Users report — completes Normal
[ ] Check System Administrator → Database → shows clone-db hostname
[ ] Check Workflow Mailer status: should be Stopped or Deactivated
\`\`\`

---

## Phase 12: Monitoring Scripts

### 12.1 Clone Age Tracker

Create \`/home/applmgr/scripts/record_clone_date.sh\` (run once after clone completes):

\`\`\`bash
#!/bin/bash
# Record when this clone was created for age tracking
CLONE_META="/home/applmgr/.clone_info"
cat > "\${CLONE_META}" << METAEOF
CLONE_DATE=\$(date '+%Y-%m-%d %H:%M:%S')
CLONE_EPOCH=\$(date +%s)
SOURCE_ENV=VIS (prod-db.internal.example.com)
CLONE_ENV=VIS_TEST (clone-db.internal.example.com)
CLONED_BY=\$(whoami)
METAEOF
echo "Clone metadata recorded: \${CLONE_META}"
\`\`\`

\`\`\`bash
#!/bin/bash
# check_clone_age.sh — alert if clone is stale
CLONE_META="/home/applmgr/.clone_info"
MAX_AGE_DAYS=30
LOG_FILE="/home/applmgr/logs/clone_age_\$(date +%Y%m%d).log"
mkdir -p /home/applmgr/logs

if [ ! -f "\${CLONE_META}" ]; then
  echo "\$(date): ERROR — clone metadata file not found" | tee -a "\${LOG_FILE}"
  exit 2
fi

source "\${CLONE_META}"
CURRENT_EPOCH=\$(date +%s)
AGE_DAYS=\$(( (CURRENT_EPOCH - CLONE_EPOCH) / 86400 ))

if [ "\${AGE_DAYS}" -ge "\${MAX_AGE_DAYS}" ]; then
  echo "\$(date): WARNING — clone is \${AGE_DAYS} days old (threshold: \${MAX_AGE_DAYS} days). Consider refreshing." | tee -a "\${LOG_FILE}"
  exit 1
fi

echo "\$(date): Clone age: \${AGE_DAYS} days (created \${CLONE_DATE})" >> "\${LOG_FILE}"
\`\`\`

### 12.2 PDB Status Monitor

Create \`/home/oracle/scripts/check_pdb_status.sh\` (on clone-db):

\`\`\`bash
#!/bin/bash
ORACLE_SID=CDBTEST
ORACLE_HOME=/u01/oracle/product/19.3.0/dbhome_1
PATH=\${ORACLE_HOME}/bin:\${PATH}
export ORACLE_SID ORACLE_HOME PATH

LOG_FILE="/home/oracle/logs/pdb_status_\$(date +%Y%m%d).log"
mkdir -p /home/oracle/logs

RESULT=\$(sqlplus -s / as sysdba << 'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT PDB_NAME || '|' || STATUS || '|' || RESTRICTED
FROM CDB_PDBS
WHERE PDB_NAME = 'VIS_TEST';
EXIT;
EOF
)

PDB_NAME=\$(echo "\${RESULT}" | cut -d'|' -f1)
PDB_STATUS=\$(echo "\${RESULT}" | cut -d'|' -f2)
PDB_RESTRICTED=\$(echo "\${RESULT}" | cut -d'|' -f3)

LOG_LINE="\$(date): PDB=\${PDB_NAME} STATUS=\${PDB_STATUS} RESTRICTED=\${PDB_RESTRICTED}"

if [ "\${PDB_STATUS}" != "NORMAL" ] || [ "\${PDB_RESTRICTED}" != "NO" ]; then
  echo "ALERT: \${LOG_LINE}" | tee -a "\${LOG_FILE}"
  # echo "PDB \${PDB_NAME} issue: \${LOG_LINE}" | mail -s "Clone PDB Alert" dba-alerts@example.com
  exit 1
fi

echo "\${LOG_LINE}" >> "\${LOG_FILE}"
\`\`\`

### 12.3 Clone EBS Service Health Check

Create \`/home/applmgr/scripts/check_clone_ebs_health.sh\` (on clone-app):

\`\`\`bash
#!/bin/bash
source /u01/oracle/VIS/EBSapps.env run 2>/dev/null

LOG_FILE="/home/applmgr/logs/clone_health_\$(date +%Y%m%d).log"
mkdir -p /home/applmgr/logs

ERRORS=0

check_process() {
  local NAME="\$1" PATTERN="\$2"
  if ps -ef | grep -E "\${PATTERN}" | grep -v grep > /dev/null 2>&1; then
    echo "\$(date): OK: \${NAME} running" >> "\${LOG_FILE}"
  else
    echo "\$(date): ERROR: \${NAME} NOT running" | tee -a "\${LOG_FILE}"
    ERRORS=\$(( ERRORS + 1 ))
  fi
}

check_process "OHS"              "httpd.*VIS"
check_process "WLS AdminServer"  "weblogic.Name=AdminServer"
check_process "WLS oacore"       "weblogic.Name=oacore"

HTTP_CODE=\$(curl -k -s -o /dev/null -w "%{http_code}" --max-time 15 \\
  "https://clone-app.internal.example.com:4443/OA_HTML/AppsLocalLogin.jsp")
if [ "\${HTTP_CODE}" = "200" ]; then
  echo "\$(date): OK: Login page HTTP \${HTTP_CODE}" >> "\${LOG_FILE}"
else
  echo "\$(date): ERROR: Login page HTTP \${HTTP_CODE}" | tee -a "\${LOG_FILE}"
  ERRORS=\$(( ERRORS + 1 ))
fi

DB_CHECK=\$(sqlplus -s apps/<new_clone_apps_password> << 'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT 'DB_OK' FROM DUAL;
EXIT;
EOF
)
if echo "\${DB_CHECK}" | grep -q "DB_OK"; then
  echo "\$(date): OK: Database connectivity" >> "\${LOG_FILE}"
else
  echo "\$(date): ERROR: Database connectivity failed" | tee -a "\${LOG_FILE}"
  ERRORS=\$(( ERRORS + 1 ))
fi

[ "\${ERRORS}" -eq 0 ] && echo "\$(date): Clone EBS health OK" >> "\${LOG_FILE}" || exit 1
\`\`\`

### 12.4 Crontab Setup on Clone Hosts

On clone-db (as oracle):
\`\`\`
# PDB status check every 30 minutes
*/30 * * * * /home/oracle/scripts/check_pdb_status.sh >> /home/oracle/logs/pdb_cron.log 2>&1
\`\`\`

On clone-app (as applmgr):
\`\`\`
# EBS service health every 15 minutes
*/15 * * * * /home/applmgr/scripts/check_clone_ebs_health.sh >> /home/applmgr/logs/health_cron.log 2>&1

# Clone age check daily at 08:00
0 8 * * * /home/applmgr/scripts/check_clone_age.sh >> /home/applmgr/logs/age_cron.log 2>&1
\`\`\`

---

## Quick Reference

| Task | Command |
|------|---------|
| List PDBs in CDB | \`SELECT PDB_NAME, STATUS, RESTRICTED FROM CDB_PDBS;\` |
| Open PDB | \`ALTER PLUGGABLE DATABASE VIS_TEST OPEN;\` |
| Close PDB | \`ALTER PLUGGABLE DATABASE VIS_TEST CLOSE IMMEDIATE;\` |
| Switch to PDB context | \`ALTER SESSION SET CONTAINER = VIS_TEST;\` |
| Save PDB open state | \`ALTER PLUGGABLE DATABASE VIS_TEST SAVE STATE;\` |
| Check PDB services | \`SELECT NAME, PDB FROM CDB_SERVICES WHERE CON_ID > 2;\` |
| Run adpreclone DB | \`perl \${AD_TOP}/bin/adpreclone.pl dbTier\` |
| Run adpreclone App | \`perl \${AD_TOP}/bin/adpreclone.pl appsTier\` |
| Run adcfgclone DB | \`perl \${ORACLE_HOME}/appsutil/clone/bin/adcfgclone.pl dbTier contextfile=<xml>\` |
| Run adcfgclone App | \`perl \${COMMON_TOP}/clone/bin/adcfgclone.pl appsTier contextfile=<xml>\` |
| Change APPS password | \`FNDCPASS apps/<old> 0 Y system/<sys_pwd> SYSTEM APPLSYS <new>\` |
| Start EBS | \`\$ADMIN_SCRIPTS_HOME/adstrtal.sh apps/<pass>\` |
| Stop EBS | \`\$ADMIN_SCRIPTS_HOME/adstpall.sh apps/<pass>\` |
| Drop and recreate PDB (refresh) | \`DROP PLUGGABLE DATABASE VIS_TEST INCLUDING DATAFILES;\` then re-run RMAN |`,
};

async function main() {
  console.log('Inserting EBS PDB clone runbook...');
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
