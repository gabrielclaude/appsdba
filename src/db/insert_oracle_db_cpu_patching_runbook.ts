import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle CPU Patching Runbook: OPatch Step-by-Step for Linux and Windows (12.1.0.2)',
  slug: 'oracle-cpu-patching-opatch-runbook-linux-windows',
  excerpt:
    'Complete step-by-step runbook for applying Oracle Critical Patch Updates to Oracle Database 12.1.0.2 on Linux and Windows. Covers OPatch upgrade (patch 6880880), pre-patch conflict detection, CPU application, datapatch execution, post-patch validation queries, and rollback procedures — with exact commands for both platforms.',
  category: 'oracle-security' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-15'),
  youtubeUrl: null,
  content: `## Phase 1: Pre-Patch Preparation (Both Platforms)

Complete this phase before the maintenance window. Do not start the maintenance window until all pre-patch checks pass.

### 1.1 Download Required Files from My Oracle Support

Navigate to **My Oracle Support > Patches & Updates**.

| File | Purpose | MOS Search |
|------|---------|-----------|
| p6880880_122010123_Linux-x86-64.zip | OPatch utility upgrade | Patch 6880880, Linux x86-64 |
| p6880880_122010123_MSWIN-x86-64.zip | OPatch utility upgrade | Patch 6880880, Windows x86-64 |
| p31720776_121020_Linux-x86-64.zip | October 2020 CPU, Linux | Patch 31720776 (verify in CPU advisory) |
| p31720776_121020_MSWIN-x86-64.zip | October 2020 CPU, Windows | Patch 31720776 (verify in CPU advisory) |

> **Note**: Always verify the exact patch number for your platform and 12.1.0.2 PSU level in MOS Note 2694866.1 (October 2020 CPU advisory). The patch numbers above are representative — confirm against the advisory for your specific RU/PSU level.

Read the **README.txt** inside the CPU patch zip before proceeding. It specifies the minimum OPatch version, any pre-requisite patches, and any known issues.

### 1.2 Record Pre-Patch Baseline

**Linux:**

\`\`\`bash
# Record current OPatch version
\$ORACLE_HOME/OPatch/opatch version > /tmp/pre_patch_opatch_version.txt 2>&1

# Record full patch inventory
\$ORACLE_HOME/OPatch/opatch lsinventory -detail > /tmp/pre_patch_inventory.txt 2>&1

# Record database version
sqlplus -S / as sysdba <<EOF > /tmp/pre_patch_db_version.txt
SELECT banner FROM v\\\$version;
EXIT
EOF

# Record invalid object count
sqlplus -S / as sysdba <<EOF >> /tmp/pre_patch_db_version.txt
SELECT COUNT(*) AS invalid_objects FROM dba_objects WHERE status = 'INVALID';
EXIT
EOF

echo "Pre-patch baseline saved to /tmp/pre_patch_*.txt"
\`\`\`

**Windows (Administrator cmd.exe):**

\`\`\`cmd
%ORACLE_HOME%\OPatch\opatch version > C:\stage\pre_patch_opatch_version.txt
%ORACLE_HOME%\OPatch\opatch lsinventory -detail > C:\stage\pre_patch_inventory.txt

sqlplus -S / as sysdba << "SELECT banner FROM v$version; SELECT COUNT(*) FROM dba_objects WHERE status='INVALID'; EXIT" > C:\stage\pre_patch_db_version.txt
\`\`\`

### 1.3 Run Conflict Check

Extract the CPU patch zip to a staging directory. Then run the conflict check — this does NOT apply the patch:

**Linux:**

\`\`\`bash
mkdir -p /stage/cpu_oct2020
cd /stage/cpu_oct2020
unzip /downloads/p31720776_121020_Linux-x86-64.zip

# Run conflict check against ORACLE_HOME
cd /stage/cpu_oct2020/31720776
\$ORACLE_HOME/OPatch/opatch prereq CheckConflictAgainstOHWithDetail -ph ./
\`\`\`

**Windows:**

\`\`\`cmd
cd C:\stage\cpu_oct2020\\31720776
%ORACLE_HOME%\OPatch\opatch prereq CheckConflictAgainstOHWithDetail -ph ./
\`\`\`

**Expected output:** \`OPatch succeeded.\`

If conflicts are detected:
- **Superseded patches**: OPatch will merge automatically — proceed.
- **Unresolvable conflicts**: Stop. Open an SR with Oracle Support referencing the conflict output before continuing.

### 1.4 Verify Available Disk Space

**Linux:**

\`\`\`bash
df -h \$ORACLE_HOME          # Need at least 2 GB free
df -h /tmp                  # OPatch uses /tmp for temp files — need 500 MB
df -h \$ORACLE_BASE/diag     # Alert log and trace directory
\`\`\`

**Windows:**

\`\`\`cmd
wmic logicaldisk where "DeviceID='C:'" get FreeSpace,Size
\`\`\`

Minimum: 2 GB free on the drive containing ORACLE_HOME.

---

## Phase 2: Upgrade OPatch

This must be done before applying the CPU. The CPU's README specifies the minimum OPatch version.

### 2.1 Linux: Replace OPatch Directory

\`\`\`bash
# Set environment
export ORACLE_HOME=/u01/app/oracle/product/12.1.0/dbhome_1
export PATH=\$ORACLE_HOME/bin:\$ORACLE_HOME/OPatch:\$PATH

# Back up current OPatch
mv \$ORACLE_HOME/OPatch \$ORACLE_HOME/OPatch_backup_\$(date +%Y%m%d_%H%M%S)
echo "Backup created: \$ORACLE_HOME/OPatch_backup_\$(date +%Y%m%d)*"

# Extract new OPatch into ORACLE_HOME
unzip /downloads/p6880880_122010123_Linux-x86-64.zip -d \$ORACLE_HOME

# Verify new version
\$ORACLE_HOME/OPatch/opatch version
\`\`\`

**Expected:** Version 12.2.0.1.23 or the version specified in the CPU README.

### 2.2 Windows: Replace OPatch Directory

Open cmd.exe **as Administrator**:

\`\`\`cmd
set ORACLE_HOME=C:\app\oracle\product\\12.1.0\dbhome_1

REM Back up current OPatch
rename %ORACLE_HOME%\OPatch OPatch_backup_%DATE:~10,4%%DATE:~4,2%%DATE:~7,2%

REM Extract new OPatch (using 7-Zip from command line)
7z x C:\downloads\p6880880_122010123_MSWIN-x86-64.zip -o%ORACLE_HOME%

REM Alternatively, use PowerShell expand-archive if 7-Zip is not available:
REM powershell -Command "Expand-Archive -Path C:\downloads\p6880880_122010123_MSWIN-x86-64.zip -DestinationPath %ORACLE_HOME%"

REM Verify new version
%ORACLE_HOME%\OPatch\opatch version
\`\`\`

---

## Phase 3: Apply the CPU Patch — Linux

### 3.1 Set Environment

\`\`\`bash
export ORACLE_HOME=/u01/app/oracle/product/12.1.0/dbhome_1
export ORACLE_SID=ORCL
export PATH=\$ORACLE_HOME/bin:\$ORACLE_HOME/OPatch:\$PATH
export LD_LIBRARY_PATH=\$ORACLE_HOME/lib:\$LD_LIBRARY_PATH

# Confirm running as oracle OS user
whoami    # should return: oracle
\`\`\`

### 3.2 Stop All Oracle Processes

\`\`\`bash
# Stop listener
lsnrctl stop
echo "Listener stopped: \$(date)"

# Stop database
sqlplus / as sysdba <<EOF
SHUTDOWN IMMEDIATE;
EXIT
EOF
echo "Database stopped: \$(date)"

# If running Grid Infrastructure (ASM / clusterware) — as grid user:
# \$GRID_HOME/bin/crsctl stop has -f

# Verify no oracle processes remain
ps -ef | grep ora_ | grep -v grep
ps -ef | grep tnslsnr | grep -v grep
\`\`\`

Both commands should return no output. If oracle processes remain, identify and stop them before proceeding.

### 3.3 Apply the CPU

\`\`\`bash
cd /stage/cpu_oct2020/31720776
\$ORACLE_HOME/OPatch/opatch apply
\`\`\`

OPatch will prompt for confirmation. Type **y** and press Enter.

OPatch output to monitor:
- \`Prerequisite check "CheckActiveFilesAndExecutables" ...PASSED\` — no locked files
- \`Patching component oracle.rdbms...\` — binary patching in progress
- \`OPatch succeeded.\` — required completion message

**If OPatch fails at the prerequisite check**: A process has a file in ORACLE_HOME locked. Run \`\$ORACLE_HOME/OPatch/opatch prereq CheckActiveFilesAndExecutables -ph ./\` to identify the locked file, then stop the process holding it.

Log the completion time:

\`\`\`bash
echo "OPatch apply completed: \$(date)" >> /tmp/patch_log.txt
\$ORACLE_HOME/OPatch/opatch lsinventory | grep -A2 "Patch description" >> /tmp/patch_log.txt
\`\`\`

### 3.4 Start the Database

\`\`\`bash
sqlplus / as sysdba <<EOF
STARTUP;
EXIT
EOF

lsnrctl start
echo "Database and listener started: \$(date)"
\`\`\`

### 3.5 Run datapatch

\`\`\`bash
cd \$ORACLE_HOME/OPatch
./datapatch -verbose
\`\`\`

datapatch log location: \`\$ORACLE_HOME/cfgtoollogs/sqlpatch/sqlpatch_<pid>_<date>/\`

**Expected completion message:** \`Patch installation complete. Total patches installed: N\`

If datapatch outputs \`No patches need to be applied\`, the database was already at this patch level. This is unexpected after a fresh OPatch apply — verify the patch was actually applied.

---

## Phase 4: Apply the CPU Patch — Windows

### 4.1 Stop All Oracle Services

Open **Services (services.msc)** and confirm the service names for your ORACLE_HOME, then stop them:

\`\`\`cmd
REM Open Administrator cmd.exe

net stop OracleServiceORCL
net stop OracleOraDB12Home1TNSListener

REM Stop any additional Oracle services from the same home:
net stop OracleJobSchedulerORCL
net stop OracleMTSRecoveryService
net stop OracleVssWriterORCL
\`\`\`

Verify all are stopped:

\`\`\`cmd
sc query OracleServiceORCL | findstr STATE
sc query OracleOraDB12Home1TNSListener | findstr STATE
\`\`\`

Both should show \`STATE : 1 STOPPED\`.

### 4.2 Set Environment

\`\`\`cmd
set ORACLE_HOME=C:\app\oracle\product\\12.1.0\dbhome_1
set ORACLE_SID=ORCL
set PATH=%ORACLE_HOME%\\bin;%ORACLE_HOME%\OPatch;%PATH%
\`\`\`

### 4.3 Apply the CPU

\`\`\`cmd
cd C:\stage\cpu_oct2020\\31720776
%ORACLE_HOME%\OPatch\opatch apply
\`\`\`

Type **y** at the confirmation prompt.

**If OPatch reports locked files:** Open Task Manager, identify oracle.exe, tnslsnr.exe, or agtctl.exe, and end the process. Then re-run opatch apply.

Record completion:

\`\`\`cmd
echo OPatch apply completed: %DATE% %TIME% >> C:\stage\patch_log.txt
%ORACLE_HOME%\OPatch\opatch lsinventory >> C:\stage\patch_log.txt
\`\`\`

### 4.4 Start Oracle Services

\`\`\`cmd
net start OracleServiceORCL
net start OracleOraDB12Home1TNSListener
\`\`\`

Wait 30 seconds for the database to fully open, then verify:

\`\`\`cmd
sqlplus / as sysdba
SQL> SELECT STATUS FROM V$INSTANCE;
SQL> EXIT
\`\`\`

Status should be \`OPEN\`.

### 4.5 Run datapatch on Windows

\`\`\`cmd
cd %ORACLE_HOME%\OPatch
datapatch -verbose
\`\`\`

---

## Phase 5: Post-Patch Validation

These queries run on both platforms after datapatch completes.

### 5.1 Confirm Patch in OPatch Inventory

**Linux:**

\`\`\`bash
\$ORACLE_HOME/OPatch/opatch lsinventory | grep -E "(Patch|CPU|PSU)"
\`\`\`

**Windows:**

\`\`\`cmd
%ORACLE_HOME%\OPatch\opatch lsinventory | findstr /i "Patch CPU PSU"
\`\`\`

The CPU patch number (e.g., 31720776) must appear.

### 5.2 Validate datapatch Applied Successfully

\`\`\`sql
-- Connect as SYSDBA
SELECT patch_id,
       patch_uid,
       version,
       action,
       status,
       TO_CHAR(action_time, 'YYYY-MM-DD HH24:MI:SS') AS action_time,
       description
FROM   dba_registry_sqlpatch
ORDER  BY action_time DESC
FETCH  FIRST 10 ROWS ONLY;
\`\`\`

**Expected:** The CPU patch appears with STATUS = 'SUCCESS'. If STATUS = 'WITH ERRORS':

\`\`\`bash
# Linux — review datapatch log
ls -lt \$ORACLE_HOME/cfgtoollogs/sqlpatch/
cat \$ORACLE_HOME/cfgtoollogs/sqlpatch/sqlpatch_<most_recent_dir>/patching_status.txt
\`\`\`

Re-run datapatch after correcting any issues found in the log.

### 5.3 Check Data Dictionary Registry

\`\`\`sql
SELECT comp_name, version, status
FROM   dba_registry
ORDER  BY comp_name;
\`\`\`

All components should show STATUS = 'VALID'. A component showing 'INVALID' or 'UPGRADING' indicates a problem — do not close the maintenance window until resolved.

### 5.4 Compile Invalid Objects

\`\`\`sql
@\$ORACLE_HOME/rdbms/admin/utlrp.sql
\`\`\`

**Windows:**

\`\`\`sql
@%ORACLE_HOME%\\rdbms\admin\\utlrp.sql
\`\`\`

After utlrp.sql completes, re-check for invalid objects:

\`\`\`sql
SELECT owner,
       object_type,
       object_name,
       status
FROM   dba_objects
WHERE  status = 'INVALID'
AND    owner NOT IN ('SYS', 'SYSTEM', 'DBSNMP', 'WMSYS', 'ORDSYS', 'MDSYS', 'OLAPSYS')
ORDER  BY owner, object_type, object_name;
\`\`\`

If non-Oracle schema objects are invalid, recompile them individually or coordinate with the application team.

### 5.5 Review Alert Log for ORA- Errors

**Linux:**

\`\`\`bash
DIAG_DEST=\$ORACLE_BASE/diag/rdbms/\$(echo \$ORACLE_SID | tr '[:upper:]' '[:lower:]')/\$ORACLE_SID/trace
grep -c "ORA-" \$DIAG_DEST/alert_\$ORACLE_SID.log

# Show last 200 lines
tail -200 \$DIAG_DEST/alert_\$ORACLE_SID.log
\`\`\`

**Windows:**

\`\`\`cmd
REM Alert log typically at:
type C:\app\oracle\diag\\rdbms\orcl\ORCL\\trace\alert_ORCL.log | findstr "ORA-"
\`\`\`

Expected: No ORA- errors after the startup sequence.

### 5.6 Smoke Test — Application Connectivity

\`\`\`bash
# Linux: test listener and basic connect
tnsping ORCL

# Test a representative application user login
sqlplus appuser/apppassword@//localhost:1521/ORCL <<EOF
SELECT SYSDATE FROM DUAL;
EXIT
EOF
\`\`\`

---

## Phase 6: Rollback Procedure

Execute rollback only if required — it is a destructive operation that removes the CPU patch from ORACLE_HOME.

### 6.1 Identify the Patch to Roll Back

\`\`\`bash
\$ORACLE_HOME/OPatch/opatch lsinventory | grep -A3 "Patch description"
\`\`\`

Note the patch ID (e.g., 31720776).

### 6.2 Linux Rollback

\`\`\`bash
# Stop database and listener
sqlplus / as sysdba <<EOF
SHUTDOWN IMMEDIATE;
EXIT
EOF
lsnrctl stop

# Roll back the patch
cd /stage/cpu_oct2020/31720776
\$ORACLE_HOME/OPatch/opatch rollback -id 31720776

# Start database
sqlplus / as sysdba <<EOF
STARTUP;
EXIT
EOF
lsnrctl start

# Run datapatch to remove data dictionary changes
cd \$ORACLE_HOME/OPatch
./datapatch -verbose

# Verify rollback in inventory
\$ORACLE_HOME/OPatch/opatch lsinventory
\`\`\`

### 6.3 Windows Rollback

\`\`\`cmd
net stop OracleServiceORCL
net stop OracleOraDB12Home1TNSListener

cd C:\stage\cpu_oct2020\\31720776
%ORACLE_HOME%\OPatch\opatch rollback -id 31720776

net start OracleServiceORCL
net start OracleOraDB12Home1TNSListener

cd %ORACLE_HOME%\OPatch
datapatch -verbose

%ORACLE_HOME%\OPatch\opatch lsinventory
\`\`\`

After rollback, validate \`dba_registry_sqlpatch\` shows the patch action as 'ROLLBACK' with STATUS = 'SUCCESS'.

---

## Phase 7: Maintenance Window Sign-Off

Complete this checklist before closing the maintenance window:

| Check | Linux Command / Query | Windows Command / Query | Pass? |
|-------|----------------------|------------------------|-------|
| OPatch inventory shows CPU patch | \`opatch lsinventory\` | \`opatch lsinventory\` | |
| dba_registry_sqlpatch STATUS = 'SUCCESS' | SELECT from dba_registry_sqlpatch | SELECT from dba_registry_sqlpatch | |
| dba_registry all VALID | SELECT from dba_registry | SELECT from dba_registry | |
| No invalid non-Oracle objects | SELECT from dba_objects | SELECT from dba_objects | |
| No ORA- errors in alert log | grep alert log | findstr alert log | |
| Listener responding | tnsping | tnsping | |
| Application connectivity confirmed | Connect as app user | Connect as app user | |
| Patch log saved | /tmp/patch_log.txt | C:\\stage\\patch_log.txt | |
| Pre-patch baseline saved | /tmp/pre_patch_*.txt | C:\\stage\\pre_patch_*.txt | |

| Field | Value |
|-------|-------|
| Patch applied | CPU October 2020 (31720776) |
| Database | Oracle 12.1.0.2 |
| Platform | Linux / Windows |
| Patched by | |
| Maintenance start | |
| Maintenance end | |
| Approval | |

---

## Appendix: Common OPatch Errors and Resolutions

| Error | Cause | Resolution |
|-------|-------|-----------|
| \`OPatch version check failed\` | OPatch is older than minimum required | Upgrade OPatch (patch 6880880) first |
| \`CheckActiveFilesAndExecutables FAILED\` | A process holds a file in ORACLE_HOME | Identify and stop the process; re-run opatch |
| \`Inventory check failed\` | Oracle Inventory corrupted or inaccessible | Run \`\$ORACLE_HOME/oui/bin/runInstaller -silent -attachHome\` to repair |
| \`NullPointerException in opatch\` | Java version incompatible | Ensure \$JAVA_HOME points to JDK 1.8+ |
| \`datapatch: unable to connect\` | Database not open when datapatch runs | Start database to OPEN state before running datapatch |
| \`ORA-04031 during datapatch\` | Insufficient shared pool | Increase \`shared_pool_size\` temporarily; restart; re-run datapatch |
| Windows: \`Access denied on file\` | Service still partially running | Use Process Explorer to find lock holder; terminate the process |
| Windows: \`System error 5\` | cmd.exe not running as Administrator | Re-open cmd.exe with "Run as Administrator" |`,
};

async function main() {
  console.log('Inserting Oracle CPU patching runbook...');
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
