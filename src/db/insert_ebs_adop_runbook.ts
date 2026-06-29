import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS 12.2.11 adop Patching Runbook',
  slug: 'oracle-ebs-12211-adop-online-patching-runbook',
  excerpt:
    'Step-by-step runbook for applying patches to Oracle EBS 12.2.11 using adop: pre-patch health checks, merging patches with admrgpch, each adop phase command with verification queries, worker log monitoring, resume and abort procedures, post-cutover validation, cleanup, and crontab monitoring scripts for cycle status, worker failures, and patch edition object validity.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-29'),
  youtubeUrl: null,
  content: `## Overview

This runbook covers the complete procedure for applying one or more patches to Oracle EBS 12.2.11 using the AD Online Patching (adop) utility. Work through each phase in order. Phases 1–3 (prepare, apply, finalize) can run while users are active. Phase 4 (cutover) requires a maintenance window. Phase 5 (cleanup) runs after production validation.

**Prerequisites**:
- Oracle EBS 12.2.11 with the latest AD and TXK RUPs applied
- DBA and sysadmin access to all application tier servers and the database server
- Patch zip files downloaded from My Oracle Support and staged on the application server
- Sufficient disk space: PATCH filesystem requires at least as much free space as the RUN filesystem
- EBS environment variables sourced: \`source \${EBS_APPS_HOME}/EBSapps.env run\`

---

## Phase 0: Pre-Patch Health Checks

Run these checks before starting any adop cycle. A cycle started against an unhealthy system will fail mid-apply, which is harder to diagnose than a pre-flight failure.

### 0.1 Check EBS Services Are Up

\`\`\`bash
# Source the RUN environment
source \${EBS_APPS_HOME}/EBSapps.env run
echo "RUN filesystem: \$APPL_TOP"

# Check all EBS services
\${ADMIN_SCRIPTS_HOME}/adstpall.sh status apps/\${APPS_PASSWORD}

# Verify concurrent managers are running
\${ADMIN_SCRIPTS_HOME}/adcmctl.sh status apps/\${APPS_PASSWORD}
\`\`\`

### 0.2 Check Database Health

\`\`\`sql
-- Connect as APPS and run pre-patch validation
-- Check for invalid objects in the APPS schema that are not patch-related
SELECT COUNT(*), STATUS
FROM DBA_OBJECTS
WHERE OWNER = 'APPS'
GROUP BY STATUS;

-- Check for active adop cycle (must be none before starting)
SELECT ADOP_SESSION_ID, STATUS, PREPARE_STATUS, APPLY_STATUS,
       FINALIZE_STATUS, CUTOVER_STATUS, CLEANUP_STATUS
FROM AD_ADOP_SESSION_PATCHES
ORDER BY ADOP_SESSION_ID DESC
FETCH FIRST 5 ROWS ONLY;

-- Verify no prior cycle is in RUNNING or FAILED state
SELECT COUNT(*)
FROM AD_ADOP_SESSIONS
WHERE STATUS NOT IN ('C','A')  -- C=complete, A=aborted
AND ROWNUM = 1;
\`\`\`

### 0.3 Check Disk Space

\`\`\`bash
# Check PATCH filesystem free space (must have at least as much as RUN)
df -h \${EBS_PATCH_HOME}

# Check database FRA and undo space
sqlplus -s / as sysdba << 'SQL'
SELECT NAME, ROUND(SPACE_LIMIT/1024/1024/1024,1) AS LIMIT_GB,
       ROUND(SPACE_USED/1024/1024/1024,1) AS USED_GB,
       ROUND((1-SPACE_USED/SPACE_LIMIT)*100,1) AS FREE_PCT
FROM V\$RECOVERY_FILE_DEST;

SELECT TABLESPACE_NAME,
       ROUND(SUM(MAXBYTES)/1024/1024/1024,1) AS MAX_GB,
       ROUND(SUM(BYTES)/1024/1024/1024,1) AS USED_GB
FROM DBA_DATA_FILES
WHERE TABLESPACE_NAME = 'UNDOTBS1'
GROUP BY TABLESPACE_NAME;
EXIT;
SQL
\`\`\`

### 0.4 Verify Patch Prerequisites

\`\`\`bash
# Stage the patch zip in the patch directory
PATCH_DIR=/u01/patches
PATCH_NUM=12345678  # replace with actual patch number
cd \${PATCH_DIR}
unzip p\${PATCH_NUM}_122110_LINUX.zip

# Read the README for prerequisites
cat \${PATCH_DIR}/\${PATCH_NUM}/README.txt | grep -A 5 -i "prerequisite"

# Verify prerequisites are applied in the database
sqlplus -s apps/\${APPS_PASSWORD} << 'SQL'
-- Check if prerequisite bug is in the applied patch registry
SELECT BUG_NUMBER, LAST_UPDATE_DATE
FROM AD_BUGS
WHERE BUG_NUMBER IN ('22222222','33333333')  -- prerequisite patch numbers
ORDER BY LAST_UPDATE_DATE DESC;
EXIT;
SQL
\`\`\`

---

## Phase 1: Merge Patches (Optional but Recommended)

If applying multiple patches in the same cycle, merge them first with \`admrgpch\`. A merged patch applies in one adop cycle instead of one cycle per patch.

### 1.1 Run admrgpch

\`\`\`bash
# Source the RUN environment
source \${EBS_APPS_HOME}/EBSapps.env run

# Stage all patches to merge
MERGE_DIR=/u01/patches/merged_cycle_01
mkdir -p \${MERGE_DIR}

# Run admrgpch — list each patch directory as an argument
admrgpch \${PATCH_DIR}/12345678 \${PATCH_DIR}/22345678 \${PATCH_DIR}/32345678 \\
  -d \${MERGE_DIR}

# Inspect the unified driver that was created
ls -la \${MERGE_DIR}/
cat \${MERGE_DIR}/unified_driver 2>/dev/null | head -30
\`\`\`

### 1.2 Verify Merged Patch

\`\`\`bash
# Confirm all source patches are represented in the merged driver
grep -c "copy\|exec\|sql" \${MERGE_DIR}/unified_driver
\`\`\`

---

## Phase 2: adop prepare

The prepare phase synchronizes the PATCH filesystem and creates the patch database edition. Run from the primary application server as the applmgr OS user.

### 2.1 Run prepare

\`\`\`bash
source \${EBS_APPS_HOME}/EBSapps.env run

# Start the prepare phase
# -workers controls parallel prepare jobs (match to CPU count, typically 8-16)
adop phase=prepare workers=8 2>&1 | tee /u01/patches/logs/adop_prepare_\$(date +%Y%m%d_%H%M).log
\`\`\`

### 2.2 Monitor prepare Progress

\`\`\`sql
-- Monitor adop session status during prepare
SELECT ADOP_SESSION_ID,
       TO_CHAR(START_DATE,'YYYY-MM-DD HH24:MI:SS') AS STARTED,
       STATUS,
       PREPARE_STATUS
FROM AD_ADOP_SESSIONS
ORDER BY ADOP_SESSION_ID DESC
FETCH FIRST 3 ROWS ONLY;
\`\`\`

\`\`\`bash
# Watch the prepare log in real time
tail -f \${NE_BASE}/EBSapps/log/adop/*/adoplog.log
\`\`\`

### 2.3 Verify prepare Completed

\`\`\`bash
# Confirm PATCH filesystem is populated
ls \${EBS_PATCH_HOME}/EBSapps/appl/

# Confirm patch edition was created in the database
sqlplus -s / as sysdba << 'SQL'
SELECT EDITION_NAME, PARENT_EDITION_NAME, USABLE
FROM DBA_EDITIONS
ORDER BY EDITION_NAME;
EXIT;
SQL
\`\`\`

---

## Phase 3: adop apply

The apply phase installs the patch onto the PATCH filesystem and PATCH database edition.

### 3.1 Run apply

\`\`\`bash
source \${EBS_APPS_HOME}/EBSapps.env run

# Apply a single patch
adop phase=apply patches=12345678 workers=8 2>&1 | tee /u01/patches/logs/adop_apply_\$(date +%Y%m%d_%H%M).log

# OR: Apply from the merged patch directory
adop phase=apply patching_mode=online merge_patch_directory=\${MERGE_DIR} workers=8 2>&1 | tee /u01/patches/logs/adop_apply_merged_\$(date +%Y%m%d_%H%M).log

# For a patch that MUST use hotpatch mode (as stated in its README):
# adop phase=apply patches=12345678 apply_mode=hotpatch workers=8
\`\`\`

### 3.2 Monitor apply Progress

\`\`\`sql
-- Worker status during apply
SELECT W.WORKER_ID, W.STATUS, W.ACTION_TYPE,
       SUBSTR(W.ACTION, 1, 60) AS CURRENT_ACTION,
       ROUND((SYSDATE - W.START_DATE) * 1440, 1) AS MINUTES_RUNNING
FROM AD_ADOP_WORKER_STATUS W
WHERE W.ADOP_SESSION_ID = (SELECT MAX(ADOP_SESSION_ID) FROM AD_ADOP_SESSIONS)
ORDER BY W.WORKER_ID;

-- Count completed vs. pending jobs
SELECT COMPLETED_TASKS, FAILED_TASKS, PENDING_TASKS
FROM AD_ADOP_SESSION_PHASES
WHERE ADOP_SESSION_ID = (SELECT MAX(ADOP_SESSION_ID) FROM AD_ADOP_SESSIONS)
AND PHASE_CODE = 'A';
\`\`\`

\`\`\`bash
# Monitor a specific worker log
tail -f \${NE_BASE}/EBSapps/log/adop/\${SESSION_ID}/apply/adwork01.log

# Find all worker logs for the current session
SESSION_ID=\$(ls -t \${NE_BASE}/EBSapps/log/adop/ | head -1)
ls \${NE_BASE}/EBSapps/log/adop/\${SESSION_ID}/apply/adwork*.log
\`\`\`

### 3.3 Handle apply Failures

\`\`\`bash
# If apply pauses with worker failures, check the failed worker log:
grep -i "error\|ORA-\|failed" \${NE_BASE}/EBSapps/log/adop/\${SESSION_ID}/apply/adwork01.log | tail -30

# After fixing the underlying issue (recompile object, correct data, etc.), resume:
adop phase=apply status=resume workers=8

# To pause apply intentionally (e.g., need to investigate without aborting):
adop phase=apply status=pause
\`\`\`

### 3.4 Verify apply Completed

\`\`\`sql
-- Confirm the patch bug number is now in AD_BUGS
SELECT BUG_NUMBER, LAST_UPDATE_DATE
FROM AD_BUGS
WHERE BUG_NUMBER = '12345678';  -- replace with actual patch number

-- Check for invalid objects in the PATCH edition
-- Connect to the database and set the session to the patch edition
ALTER SESSION SET EDITION = (
  SELECT MAX(EDITION_NAME) FROM DBA_EDITIONS WHERE EDITION_NAME LIKE 'EBS_PATCH%'
);

SELECT COUNT(*), STATUS
FROM DBA_OBJECTS
WHERE OWNER = 'APPS'
AND STATUS = 'INVALID';
\`\`\`

---

## Phase 4: adop finalize

Finalize prepares the PATCH environment for cutover. It generates page caches and confirms all objects compile cleanly.

### 4.1 Run finalize

\`\`\`bash
source \${EBS_APPS_HOME}/EBSapps.env run

adop phase=finalize workers=8 2>&1 | tee /u01/patches/logs/adop_finalize_\$(date +%Y%m%d_%H%M).log
\`\`\`

### 4.2 Verify finalize Completed Clean

\`\`\`sql
-- Confirm finalize status and check for any invalid objects in the patch edition
SELECT ADOP_SESSION_ID, FINALIZE_STATUS
FROM AD_ADOP_SESSIONS
ORDER BY ADOP_SESSION_ID DESC
FETCH FIRST 1 ROW ONLY;

-- Set session to patch edition and count invalids
-- (run as APPS or SYS)
SELECT COUNT(*) AS INVALID_COUNT
FROM DBA_OBJECTS
WHERE OWNER = 'APPS'
AND STATUS = 'INVALID'
AND EDITION_NAME = (
  SELECT MAX(EDITION_NAME) FROM DBA_EDITIONS WHERE EDITION_NAME LIKE 'EBS_PATCH%'
);
\`\`\`

If INVALID_COUNT > 0, investigate before proceeding to cutover:

\`\`\`sql
-- List the invalid objects by type
SELECT OBJECT_TYPE, OBJECT_NAME, STATUS
FROM DBA_OBJECTS
WHERE OWNER = 'APPS'
AND STATUS = 'INVALID'
ORDER BY OBJECT_TYPE, OBJECT_NAME
FETCH FIRST 20 ROWS ONLY;

-- Attempt manual recompile
BEGIN
  DBMS_UTILITY.COMPILE_SCHEMA(
    schema  => 'APPS',
    compile_all => FALSE  -- only compile invalid objects
  );
END;
/
\`\`\`

---

## Phase 5: adop cutover (Maintenance Window)

Cutover is the brief outage phase. Schedule a maintenance window and communicate downtime to users before running.

### 5.1 Pre-Cutover Checklist

\`\`\`bash
# Notify users — drain active sessions (allow in-flight transactions to complete)
# Recommended: post notification 15 minutes before cutover begins

# Verify no long-running concurrent programs are active
sqlplus -s apps/\${APPS_PASSWORD} << 'SQL'
SELECT REQUEST_ID, PROGRAM_SHORT_NAME,
       ROUND((SYSDATE - ACTUAL_START_DATE) * 60, 0) AS RUNNING_MINUTES
FROM FND_CONCURRENT_REQUESTS
WHERE STATUS_CODE = 'R'
AND ACTUAL_START_DATE < SYSDATE - 1/24  -- running for > 1 hour
ORDER BY RUNNING_MINUTES DESC;
EXIT;
SQL

# Confirm finalize is complete
sqlplus -s apps/\${APPS_PASSWORD} << 'SQL'
SELECT ADOP_SESSION_ID, STATUS, FINALIZE_STATUS
FROM AD_ADOP_SESSIONS
ORDER BY ADOP_SESSION_ID DESC
FETCH FIRST 1 ROW ONLY;
EXIT;
SQL
\`\`\`

### 5.2 Run cutover

\`\`\`bash
source \${EBS_APPS_HOME}/EBSapps.env run

# Record the start time
echo "Cutover started: \$(date)" | tee /u01/patches/logs/cutover_\$(date +%Y%m%d).log

adop phase=cutover workers=8 2>&1 | tee -a /u01/patches/logs/cutover_\$(date +%Y%m%d).log
\`\`\`

### 5.3 Monitor cutover Progress

\`\`\`bash
# Watch the cutover log
tail -f \${NE_BASE}/EBSapps/log/adop/\${SESSION_ID}/cutover/adoplog.log

# Confirm edition switchover happened
sqlplus -s / as sysdba << 'SQL'
-- New default edition should now be the former PATCH edition
SELECT PROPERTY_VALUE AS CURRENT_DEFAULT_EDITION
FROM DATABASE_PROPERTIES
WHERE PROPERTY_NAME = 'DEFAULT_EDITION';

-- Verify EBS_RUNTIME points to the new edition
SELECT SYS_CONTEXT('USERENV','CURRENT_EDITION_NAME') FROM DUAL;
EXIT;
SQL
\`\`\`

### 5.4 Verify Services Are Up After cutover

\`\`\`bash
# Source the NEW RUN environment (filesystem roles have swapped)
source \${EBS_APPS_HOME}/EBSapps.env run
echo "New RUN filesystem: \$APPL_TOP"

# Check all services
\${ADMIN_SCRIPTS_HOME}/adstpall.sh status apps/\${APPS_PASSWORD}
\${ADMIN_SCRIPTS_HOME}/adcmctl.sh status apps/\${APPS_PASSWORD}

# Record cutover end time
echo "Cutover completed: \$(date)" | tee -a /u01/patches/logs/cutover_\$(date +%Y%m%d).log
\`\`\`

---

## Phase 6: Post-Cutover Validation

Validate before opening to users and before running cleanup.

### 6.1 Functional Smoke Test

\`\`\`bash
# Login to EBS as SYSADMIN and verify the System Administrator responsibility loads
# Verify the About page shows the correct patch level
# Navigate to: Help > About Oracle Applications
# Confirm the patch number appears in the applied patches list

# Check applied patch via database
sqlplus -s apps/\${APPS_PASSWORD} << 'SQL'
SELECT BUG_NUMBER, CREATION_DATE
FROM AD_BUGS
WHERE BUG_NUMBER = '12345678'
ORDER BY CREATION_DATE DESC;
EXIT;
SQL
\`\`\`

### 6.2 Validate Database Objects in the New RUN Edition

\`\`\`sql
-- Confirm no invalid objects in the new RUN edition
SELECT COUNT(*) AS INVALID_IN_RUN_EDITION
FROM DBA_OBJECTS
WHERE OWNER = 'APPS'
AND STATUS = 'INVALID';

-- Confirm the new edition is the default
SELECT PROPERTY_VALUE FROM DATABASE_PROPERTIES
WHERE PROPERTY_NAME = 'DEFAULT_EDITION';
\`\`\`

### 6.3 Validate Concurrent Manager

\`\`\`sql
-- Run a simple concurrent program as a smoke test
-- e.g., "Active Users" report or any low-risk report

-- Monitor that it completes with status = 'Completed Normal'
SELECT REQUEST_ID, STATUS_CODE, PHASE_CODE,
       TO_CHAR(ACTUAL_COMPLETION_DATE,'YYYY-MM-DD HH24:MI:SS') AS COMPLETED
FROM FND_CONCURRENT_REQUESTS
WHERE REQUEST_ID = &your_test_request_id;
\`\`\`

---

## Phase 7: adop cleanup

Run cleanup only after production validation is complete and the decision to retain the patched environment is confirmed. **Do not run cleanup until you are satisfied with the patched system.**

### 7.1 Run cleanup

\`\`\`bash
source \${EBS_APPS_HOME}/EBSapps.env run

adop phase=cleanup workers=8 2>&1 | tee /u01/patches/logs/adop_cleanup_\$(date +%Y%m%d_%H%M).log
\`\`\`

### 7.2 Verify cleanup Completed

\`\`\`sql
-- Confirm the old edition has been dropped
SELECT EDITION_NAME, USABLE
FROM DBA_EDITIONS
ORDER BY EDITION_NAME;

-- Confirm session status is complete
SELECT ADOP_SESSION_ID, STATUS, CLEANUP_STATUS,
       TO_CHAR(END_DATE,'YYYY-MM-DD HH24:MI:SS') AS ENDED
FROM AD_ADOP_SESSIONS
ORDER BY ADOP_SESSION_ID DESC
FETCH FIRST 3 ROWS ONLY;
\`\`\`

---

## Abort Procedures

### Abort During apply (before cutover)

\`\`\`bash
# Abort the current cycle cleanly — drops the patch edition, resets filesystem roles
source \${EBS_APPS_HOME}/EBSapps.env run
adop phase=abort

# Confirm abort completed
sqlplus -s apps/\${APPS_PASSWORD} << 'SQL'
SELECT ADOP_SESSION_ID, STATUS
FROM AD_ADOP_SESSIONS
ORDER BY ADOP_SESSION_ID DESC
FETCH FIRST 1 ROW ONLY;
EXIT;
SQL
\`\`\`

### Emergency Rollback After cutover (Before cleanup)

This procedure manually reverts to the pre-patch database edition and old filesystem. Use only when a critical defect is discovered that cannot be fixed with a quick corrective patch.

\`\`\`bash
# Step 1: Stop all EBS services
\${ADMIN_SCRIPTS_HOME}/adstpall.sh apps/\${APPS_PASSWORD}

# Step 2: Identify the old (pre-patch) edition name
sqlplus -s / as sysdba << 'SQL'
SELECT EDITION_NAME, PARENT_EDITION_NAME
FROM DBA_EDITIONS
ORDER BY EDITION_NAME;
EXIT;
SQL

# Step 3: Revert the database default edition (run as SYS)
sqlplus -s / as sysdba << 'SQL'
-- Replace OLD_EDITION_NAME with the former RUN edition name
ALTER DATABASE DEFAULT EDITION = OLD_EDITION_NAME;
SELECT PROPERTY_VALUE FROM DATABASE_PROPERTIES WHERE PROPERTY_NAME = 'DEFAULT_EDITION';
EXIT;
SQL

# Step 4: Source the old RUN environment (the former PATCH filesystem is now the old RUN)
# The filesystem assignments are in the context file — use the fs that was RUN before cutover
source \${EBS_APPS_HOME}/EBSapps.env run  -- may need to temporarily swap symlinks

# Step 5: Run AutoConfig on the restored filesystem
\${ADMIN_SCRIPTS_HOME}/adautocfg.sh apps/\${APPS_PASSWORD}

# Step 6: Start EBS services
\${ADMIN_SCRIPTS_HOME}/adstrtal.sh apps/\${APPS_PASSWORD}
\`\`\`

---

## Monitoring Scripts

Deploy these scripts for automated adop cycle monitoring.

### Script 1: adop Cycle Status Monitor

\`\`\`bash
#!/bin/bash
# File: /home/applmgr/scripts/adop_status.sh
# Reports current adop cycle status and alerts on FAILED state

APPS_PASSWORD=\${APPS_DB_PASSWORD}
DB_SERVICE=\${ORACLE_SID}
ALERT_EMAIL="dba-alerts@example.com"

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_HOME

read SESSION_ID STATUS PREPARE APPLY FINALIZE CUTOVER CLEANUP << SQL_EOF
\$(\${ORACLE_HOME}/bin/sqlplus -s apps/\${APPS_PASSWORD}@\${DB_SERVICE} << 'SQL'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT ADOP_SESSION_ID, STATUS,
       NVL(PREPARE_STATUS,'-'), NVL(APPLY_STATUS,'-'),
       NVL(FINALIZE_STATUS,'-'), NVL(CUTOVER_STATUS,'-'), NVL(CLEANUP_STATUS,'-')
FROM AD_ADOP_SESSIONS
WHERE ADOP_SESSION_ID = (SELECT MAX(ADOP_SESSION_ID) FROM AD_ADOP_SESSIONS);
EXIT;
SQL
)
SQL_EOF

TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
LOG=/home/applmgr/scripts/logs/adop_status.log

echo "\${TIMESTAMP} | Session: \${SESSION_ID} | Status: \${STATUS} | P:\${PREPARE} A:\${APPLY} F:\${FINALIZE} C:\${CUTOVER} CL:\${CLEANUP}" >> \${LOG}

# Alert if any phase is in FAILED (F) state
if echo "\${PREPARE} \${APPLY} \${FINALIZE} \${CUTOVER} \${CLEANUP}" | grep -q "^F\$\|[[:space:]]F\$\|^F[[:space:]]"; then
  MSG="Subject: [EBS ALERT] adop cycle FAILED on \$(hostname)\n\nSession: \${SESSION_ID}\nPrepare: \${PREPARE}\nApply: \${APPLY}\nFinalize: \${FINALIZE}\nCutover: \${CUTOVER}\nCleanup: \${CLEANUP}\n\nCheck adop logs at: \${NE_BASE}/EBSapps/log/adop/\${SESSION_ID}/"
  echo -e "\${MSG}" | /usr/sbin/sendmail \${ALERT_EMAIL}
fi
\`\`\`

### Script 2: adop Worker Failure Detector

\`\`\`bash
#!/bin/bash
# File: /home/applmgr/scripts/adop_worker_check.sh
# Scans active adop session's worker logs for ORA- errors and alerts

SESSION_DIR=\$(ls -t \${NE_BASE}/EBSapps/log/adop/ 2>/dev/null | head -1)
if [[ -z "\${SESSION_DIR}" ]]; then
  exit 0
fi

LOG_BASE="\${NE_BASE}/EBSapps/log/adop/\${SESSION_DIR}"
ALERT_EMAIL="dba-alerts@example.com"
ALERT_LOG=/home/applmgr/scripts/logs/adop_worker_errors.log

# Find ORA- errors in worker logs not previously alerted
for WORKER_LOG in \${LOG_BASE}/apply/adwork*.log; do
  [[ -f "\${WORKER_LOG}" ]] || continue

  ERRORS=\$(grep -h "ORA-\|APP-\|Error\|failed" "\${WORKER_LOG}" 2>/dev/null | \
    grep -v "^#\|Warning\|successfully" | tail -20)

  if [[ -n "\${ERRORS}" ]]; then
    WORKER=\$(basename \${WORKER_LOG})
    TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')

    # Avoid duplicate alerts — check if this error was already sent
    FINGERPRINT=\$(echo "\${ERRORS}" | md5sum | cut -d' ' -f1)
    SENT_FLAG=/tmp/adop_alert_\${FINGERPRINT}
    if [[ ! -f "\${SENT_FLAG}" ]]; then
      touch "\${SENT_FLAG}"
      echo "\${TIMESTAMP} | \${WORKER} errors:" >> \${ALERT_LOG}
      echo "\${ERRORS}" >> \${ALERT_LOG}

      MSG="Subject: [EBS ALERT] adop worker error in \${WORKER} on \$(hostname)\n\n\${ERRORS}\n\nFull log: \${WORKER_LOG}"
      echo -e "\${MSG}" | /usr/sbin/sendmail \${ALERT_EMAIL}
    fi
  fi
done
\`\`\`

### Script 3: Patch Edition Object Validity Check

\`\`\`bash
#!/bin/bash
# File: /home/applmgr/scripts/adop_edition_check.sh
# Reports invalid objects in the current PATCH edition

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_HOME
export ORACLE_SID=\${DB_SID}

TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
LOG=/home/applmgr/scripts/logs/edition_check.log

INVALID_REPORT=\$(\${ORACLE_HOME}/bin/sqlplus -s / as sysdba << 'SQL'
SET PAGESIZE 50 LINESIZE 120 FEEDBACK OFF
COLUMN OBJECT_TYPE FORMAT A20
COLUMN OBJECT_NAME FORMAT A40
SELECT OBJECT_TYPE, OBJECT_NAME, STATUS
FROM DBA_OBJECTS
WHERE OWNER = 'APPS'
AND STATUS = 'INVALID'
AND ROWNUM <= 20
ORDER BY OBJECT_TYPE, OBJECT_NAME;
EXIT;
SQL
)

INVALID_COUNT=\$(echo "\${INVALID_REPORT}" | grep -v "^$\|OBJECT_TYPE\|---" | wc -l)
echo "\${TIMESTAMP} | Invalid objects in current edition: \${INVALID_COUNT}" >> \${LOG}

if [ "\${INVALID_COUNT}" -gt 0 ]; then
  echo "\${INVALID_REPORT}" >> \${LOG}
fi
\`\`\`

### Crontab Setup

\`\`\`bash
# Add to applmgr user crontab: crontab -e

# adop cycle status check — every 5 minutes during a patch cycle (run continuously)
*/5 * * * * /home/applmgr/scripts/adop_status.sh >> /dev/null 2>&1

# Worker error detector — every 2 minutes during apply phase
*/2 * * * * /home/applmgr/scripts/adop_worker_check.sh >> /dev/null 2>&1

# Edition validity check — every 15 minutes
*/15 * * * * /home/applmgr/scripts/adop_edition_check.sh >> /dev/null 2>&1

# Clean up worker alert fingerprint flags after 24 hours
0 4 * * * find /tmp -name "adop_alert_*" -mtime +1 -delete

# Log rotation
0 3 * * 0 find /home/applmgr/scripts/logs -name "*.log" -mtime +30 -delete
\`\`\`

---

## Quick Reference: adop Phase Commands

\`\`\`bash
# Full cycle (separate commands per phase)
adop phase=prepare workers=8
adop phase=apply patches=12345678 workers=8
adop phase=finalize workers=8
adop phase=cutover workers=8      # requires maintenance window
adop phase=cleanup workers=8

# All phases in a single command (non-interactive — use only for test/non-prod)
adop phase=prepare,apply,finalize,cutover,cleanup patches=12345678 workers=8

# Resume a paused or failed apply
adop phase=apply status=resume workers=8

# Abort current cycle
adop phase=abort

# Check current adop status without running a phase
adop phase=apply status=check
\`\`\`

---

## Rollback: Known-Good Reference Queries

\`\`\`sql
-- Verify the current default database edition after cutover
SELECT PROPERTY_VALUE AS DEFAULT_EDITION
FROM DATABASE_PROPERTIES
WHERE PROPERTY_NAME = 'DEFAULT_EDITION';

-- List all editions (should have exactly 2 between cutover and cleanup)
SELECT EDITION_NAME, PARENT_EDITION_NAME, USABLE
FROM DBA_EDITIONS
ORDER BY EDITION_NAME;

-- Confirm patch is recorded in the applied patch registry
SELECT BUG_NUMBER, CREATION_DATE, LAST_UPDATE_DATE
FROM AD_BUGS
WHERE BUG_NUMBER IN ('12345678')
ORDER BY CREATION_DATE DESC;

-- List all adop sessions and their final states
SELECT ADOP_SESSION_ID,
       TO_CHAR(START_DATE,'YYYY-MM-DD HH24:MI') AS STARTED,
       TO_CHAR(END_DATE,'YYYY-MM-DD HH24:MI') AS ENDED,
       STATUS, PREPARE_STATUS, APPLY_STATUS,
       FINALIZE_STATUS, CUTOVER_STATUS, CLEANUP_STATUS
FROM AD_ADOP_SESSIONS
ORDER BY ADOP_SESSION_ID DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\``,
};

async function main() {
  console.log('Inserting EBS adop online patching runbook...');
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
