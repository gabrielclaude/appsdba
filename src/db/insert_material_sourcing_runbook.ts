import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Material Sourcing Process Failed Runbook: Step-by-Step Diagnosis for Intermittent EBS Pick Release Failures',
  slug: 'oracle-ebs-material-sourcing-process-failed-runbook',
  excerpt:
    'Complete diagnostic runbook for intermittent "Material Sourcing Process Failed" errors in Oracle EBS pick release and move order allocation. Covers the four investigation phases in order: profile validation for INV quantity tree lock timeout and backorder caching, orphan record detection and safe clearance in MTL_MATERIAL_TRANSACTIONS_TEMP, FND debug log setup at user level with log mining queries to surface buried SSO and session framework errors, and database-level lock investigation using V$SESSION and V$LOCK. Includes custom wrapper audit checklist, a pre-rollback exception logging pattern that captures DBMS_UTILITY.FORMAT_ERROR_BACKTRACE before the true error is discarded, monitoring scripts that detect MMTT orphans in real time, and a post-fix validation sequence.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-29'),
  youtubeUrl: null,
  content: `## Introduction

This runbook is for diagnosing intermittent "The Material Sourcing process failed to create picking suggestions for line X of move order Y" errors where a retry immediately succeeds without any data change. This pattern almost never indicates a functional inventory setup problem. The investigation proceeds through four layers, each progressively deeper into the application technology stack.

Work through the phases in order. Most intermittent sourcing failures are resolved in Phase 1 or Phase 2. Phase 3 and 4 apply to failures that persist after profile corrections and MMTT cleanup, or that only reproduce in production environments where custom code or concurrent maintenance jobs run.

**Environment assumptions**: Oracle EBS 12.2, Oracle 19c database, RMAN or equivalent backup. Execute SQL queries as APPS or SYS unless otherwise noted.

---

## Pre-Investigation: Gather Failure Details

Before running any diagnostic queries, collect the following from the user or from the error log:

1. **Move Order Header ID** (\`MTL_TXN_REQUEST_HEADERS.HEADER_ID\`)
2. **Move Order Line ID** (\`MTL_TXN_REQUEST_LINES.LINE_ID\`)
3. **Organization ID** (from the error or from the user's org context)
4. **Inventory Item ID** (from the move order line)
5. **Exact timestamp** when the failure occurred (to the minute)
6. **User name and responsibility** of the user who hit the failure
7. **Was the error triggered from a form, concurrent program, or API call?**

\`\`\`sql
-- Retrieve move order context from the header and line IDs
SELECT mtrh.header_id,
       mtrh.request_number,
       mtrh.move_order_type,
       mtrh.organization_id,
       mtrh.date_required,
       mtrh.status_date,
       mtrl.line_id,
       mtrl.line_number,
       mtrl.inventory_item_id,
       msib.segment1 AS item_number,
       mtrl.quantity,
       mtrl.quantity_delivered,
       mtrl.quantity_detailed,
       mtrl.line_status,
       mtrl.subinventory_code,
       mtrl.locator_id,
       mtrl.lot_number
FROM mtl_txn_request_headers mtrh
JOIN mtl_txn_request_lines mtrl
  ON mtrh.header_id = mtrl.header_id
JOIN mtl_system_items_b msib
  ON mtrl.inventory_item_id = msib.inventory_item_id
 AND mtrh.organization_id   = msib.organization_id
WHERE mtrh.header_id = &move_order_header_id;
\`\`\`

---

## Phase 1: Profile Validation — Quantity Tree Locking and Backorder Caching

### Step 1.1 — Check INV: Quantity Tree Timeout for Lock

\`\`\`sql
-- Check all levels: Site (10001), Application (10002), Responsibility (10003), User (10004)
SELECT DECODE(fpov.level_id,
              10001, 'SITE',
              10002, 'APPLICATION',
              10003, 'RESPONSIBILITY',
              10004, 'USER') AS level_name,
       fpov.level_value,
       fpov.profile_option_value,
       fpov.creation_date,
       fpov.last_update_date
FROM fnd_profile_option_values fpov
JOIN fnd_profile_options fpo
  ON fpo.profile_option_id = fpov.profile_option_id
WHERE fpo.profile_option_name = 'INV_QUANTITY_TREE_TIMEOUT'
ORDER BY fpov.level_id;
\`\`\`

**Expected result for a healthy environment**: a SITE-level row with a numeric value between 5 and 30.

**Problem indicators**:
- No rows returned (NULL at all levels) → defaults to database lock timeout, which may be 300 seconds
- Value above 60 → sourcing processes hang rather than failing fast and retrying

**Fix**:
\`\`\`sql
-- Set via FND_PROFILE.SAVE (as APPS or via the Profiles form)
EXEC FND_PROFILE.SAVE('INV_QUANTITY_TREE_TIMEOUT', '10', 'SITE');
COMMIT;

-- Verify
SELECT profile_option_value
FROM fnd_profile_option_values fpov
JOIN fnd_profile_options fpo ON fpo.profile_option_id = fpov.profile_option_id
WHERE fpo.profile_option_name = 'INV_QUANTITY_TREE_TIMEOUT'
  AND fpov.level_id = 10001;
\`\`\`

### Step 1.2 — Check INV: Use Backorder Caching

\`\`\`sql
SELECT DECODE(fpov.level_id, 10001,'SITE', 10002,'APP', 10003,'RESP', 10004,'USER') AS lvl,
       fpov.profile_option_value
FROM fnd_profile_option_values fpov
JOIN fnd_profile_options fpo ON fpo.profile_option_id = fpov.profile_option_id
WHERE fpo.profile_option_name = 'INV_BACKORDER_CACHING'
ORDER BY fpov.level_id;
\`\`\`

Set to \`N\` at Site level if any level returns \`Y\` and the environment runs long-duration pick release sessions:

\`\`\`sql
EXEC FND_PROFILE.SAVE('INV_BACKORDER_CACHING', 'N', 'SITE');
COMMIT;
\`\`\`

### Step 1.3 — Scan All INV Cache-Related Profiles

\`\`\`sql
-- Discover all inventory cache-related profile options and their current values
SELECT fpo.profile_option_name,
       fpot.user_profile_option_name,
       fpov.profile_option_value,
       DECODE(fpov.level_id, 10001,'SITE', 10004,'USER','OTHER') AS level_name
FROM fnd_profile_options fpo
JOIN fnd_profile_options_tl fpot
  ON fpo.profile_option_id = fpot.profile_option_id
LEFT JOIN fnd_profile_option_values fpov
  ON fpo.profile_option_id = fpov.profile_option_id
 AND fpov.level_id IN (10001, 10004)
WHERE fpot.language = 'US'
  AND UPPER(fpo.profile_option_name) LIKE 'INV%CACHE%'
ORDER BY fpo.profile_option_name, fpov.level_id;
\`\`\`

### Step 1.4 — Check Concurrent Worker Degree for Pick Release

High worker counts increase quantity tree lock contention. Check the pick release program's worker setting:

\`\`\`sql
-- Find pick release concurrent program and its default options
SELECT cp.concurrent_program_name,
       cpot.user_concurrent_program_name,
       cp.execution_method_code,
       cppo.default_value AS default_workers
FROM fnd_concurrent_programs cp
JOIN fnd_concurrent_programs_tl cpot
  ON cp.concurrent_program_id = cpot.concurrent_program_id
LEFT JOIN fnd_concurrent_program_parameter_options cppo
  ON cp.concurrent_program_id = cppo.concurrent_program_id
WHERE cpot.language = 'US'
  AND cpot.user_concurrent_program_name LIKE '%Pick Release%';
\`\`\`

---

## Phase 2: MMTT Orphan Detection and Clearance

Run this phase immediately after a failure is reported, while the orphan record is most likely still present.

### Step 2.1 — Detect Orphan Records

\`\`\`sql
-- Primary check: look for MMTT records tied to the failing move order line
SELECT mmtt.transaction_temp_id,
       mmtt.move_order_line_id,
       mmtt.inventory_item_id,
       mmtt.organization_id,
       mmtt.subinventory_code,
       mmtt.transaction_quantity,
       mmtt.process_flag,
       mmtt.lock_flag,
       mmtt.created_by,
       mmtt.creation_date,
       mmtt.last_update_date,
       mmtt.posting_flag
FROM mtl_material_transactions_temp mmtt
WHERE mmtt.move_order_line_id = &failing_mo_line_id;

-- Secondary check: by item/org in the last hour (if move order line ID is unavailable)
SELECT mmtt.transaction_temp_id,
       mmtt.move_order_line_id,
       mmtt.lot_number,
       mmtt.transaction_quantity,
       mmtt.process_flag,
       mmtt.lock_flag,
       mmtt.creation_date
FROM mtl_material_transactions_temp mmtt
WHERE mmtt.inventory_item_id = &item_id
  AND mmtt.organization_id   = &org_id
  AND mmtt.creation_date     >= SYSDATE - 1/24
ORDER BY mmtt.creation_date DESC;
\`\`\`

### Step 2.2 — Confirm No Active Session Holds the MMTT Record

\`\`\`sql
-- Check for blocking database sessions on the MMTT table
SELECT l.sid,
       l.type,
       l.lmode,
       l.request,
       l.block,
       s.username,
       s.status,
       s.program,
       s.module,
       s.action,
       s.logon_time,
       s.last_call_et AS seconds_active
FROM v\$lock l
JOIN v\$session s ON l.sid = s.sid
JOIN dba_objects o ON l.id1 = o.object_id
WHERE o.object_name IN ('MTL_MATERIAL_TRANSACTIONS_TEMP', 'MTL_TXN_REQUEST_LINES')
  AND l.type IN ('TM', 'TX')
ORDER BY l.block DESC, l.sid;

-- If a specific TRANSACTION_TEMP_ID is known, find the locking SID via row lock
SELECT kaddr, sid, type, id1, id2, lmode, request, block
FROM v\$lock
WHERE type = 'TX'
  AND block = 1;
\`\`\`

**Interpretation**:
- Record in MMTT exists + no row in V$LOCK for the MMTT table + original session gone → confirmed orphan
- Record in MMTT exists + V$LOCK shows an active SID with LMODE > 0 → session is still processing; wait and recheck

### Step 2.3 — Evaluate and Clear Orphan Records

**Option A: Wait for the concurrent manager's cleanup process**

The Inventory Transaction Manager includes a cleanup cycle that identifies MMTT records with no active session and marks them for re-processing or deletion. Check its schedule:

\`\`\`sql
-- Find Transaction Manager cleanup program last/next run
SELECT cr.request_id,
       cr.phase_code,
       cr.status_code,
       cr.actual_start_date,
       cr.actual_completion_date,
       cr.argument_text
FROM fnd_concurrent_requests cr
JOIN fnd_concurrent_programs cp
  ON cr.concurrent_program_id = cp.concurrent_program_id
JOIN fnd_concurrent_programs_tl cpot
  ON cp.concurrent_program_id = cpot.concurrent_program_id
WHERE cpot.language = 'US'
  AND cpot.user_concurrent_program_name LIKE '%Transaction Manager%'
ORDER BY cr.request_id DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

**Option B: Use the standard Purge Transaction Interface concurrent program**

In EBS, navigate to: Inventory → Setup → Transactions → Purge Transaction Interface

Or submit via \`FND_REQUEST.SUBMIT_REQUEST\`:

\`\`\`sql
DECLARE
  l_request_id NUMBER;
BEGIN
  l_request_id := FND_REQUEST.SUBMIT_REQUEST(
    application => 'INV',
    program     => 'INVTTMTX',  -- Inventory Transaction Manager
    description => 'Cleanup orphan MMTT records',
    start_time  => SYSDATE,
    sub_request => FALSE
  );
  COMMIT;
  DBMS_OUTPUT.PUT_LINE('Request ID: ' || l_request_id);
END;
/
\`\`\`

**Option C: Manual clearance (emergency only, with DBA + Functional approval)**

\`\`\`sql
-- Verify the record is genuinely orphaned before deleting
-- Only delete if: no active session, process_flag = 1, and functional team confirms
SELECT transaction_temp_id, move_order_line_id, process_flag, lock_flag
FROM mtl_material_transactions_temp
WHERE transaction_temp_id = &orphan_transaction_temp_id;

-- After confirmation:
DELETE FROM mtl_material_transactions_temp
WHERE transaction_temp_id = &orphan_transaction_temp_id
  AND process_flag IN (1, 3)
  AND lock_flag = 2;  -- Only delete if unlocked
COMMIT;
\`\`\`

### Step 2.4 — Inspect MTL_TRANSACTION_LOTS_TEMP for Lot-Level Orphans

For lot-controlled items, orphan records may also exist in the lot interface table:

\`\`\`sql
SELECT mtlt.transaction_temp_id,
       mtlt.lot_number,
       mtlt.primary_quantity,
       mtlt.creation_date
FROM mtl_transaction_lots_temp mtlt
WHERE mtlt.transaction_temp_id IN (
  SELECT transaction_temp_id
  FROM mtl_material_transactions_temp
  WHERE move_order_line_id = &failing_mo_line_id
);
\`\`\`

Lot-level orphans must be deleted before or with the parent MMTT record.

---

## Phase 3: FND Debug Logging and Session Framework Investigation

### Step 3.1 — Enable User-Level FND Debug Logging

Never enable debug logging at the Site level in production. Target the specific user who experiences the failures:

\`\`\`sql
-- Get the user_id for the affected user
SELECT user_id, user_name FROM fnd_user WHERE user_name = UPPER('&ebs_username');

-- Enable Statement-level (most verbose) logging for INV, WSH, WMS modules
DECLARE
  l_user_id NUMBER := &target_user_id;
BEGIN
  FND_PROFILE.SAVE('FND_DEBUG_LOG_ENABLED',  'Y',          'USER', l_user_id);
  FND_PROFILE.SAVE('FND_DEBUG_LOG_LEVEL',    '6',          'USER', l_user_id);  -- 6=STATEMENT
  FND_PROFILE.SAVE('FND_DEBUG_LOG_MODULE',   '%INV%:%WSH%:%WMS%:%FND_SSO%', 'USER', l_user_id);
  COMMIT;
  DBMS_OUTPUT.PUT_LINE('Debug logging enabled for user_id: ' || l_user_id);
END;
/
\`\`\`

Ask the user to reproduce the error. Then immediately query the log (logs are written in real time):

### Step 3.2 — Mine FND_LOG_MESSAGES for the True Error

\`\`\`sql
-- Retrieve all log entries from the last 5 minutes for the target user
SELECT flm.log_sequence,
       TO_CHAR(flm.timestamp, 'HH24:MI:SS.FF3') AS log_time,
       flm.module,
       flm.message_level,
       SUBSTR(flm.message_text, 1, 300) AS message_text
FROM fnd_log_messages flm
WHERE flm.user_id    = &target_user_id
  AND flm.timestamp >= SYSTIMESTAMP - INTERVAL '5' MINUTE
ORDER BY flm.log_sequence DESC;

-- Filter to exception/error level only (level 5=EXCEPTION, 6=STATEMENT includes everything)
SELECT flm.log_sequence,
       TO_CHAR(flm.timestamp, 'HH24:MI:SS.FF3') AS log_time,
       flm.module,
       flm.message_text
FROM fnd_log_messages flm
WHERE flm.user_id      = &target_user_id
  AND flm.message_level >= 5
  AND flm.timestamp    >= SYSTIMESTAMP - INTERVAL '10' MINUTE
ORDER BY flm.log_sequence;

-- Search specifically for SSO errors
SELECT flm.log_sequence, flm.module, flm.message_text, flm.timestamp
FROM fnd_log_messages flm
WHERE flm.user_id = &target_user_id
  AND UPPER(flm.message_text) LIKE '%SSO%'
  AND flm.timestamp >= SYSTIMESTAMP - INTERVAL '30' MINUTE
ORDER BY flm.log_sequence;
\`\`\`

### Step 3.3 — Audit SSO Profile Configuration

\`\`\`sql
-- Check FND SSO profiles at all levels
SELECT fpo.profile_option_name,
       fpot.user_profile_option_name,
       fpov.profile_option_value,
       DECODE(fpov.level_id, 10001,'SITE', 10002,'APP',
                              10003,'RESP', 10004,'USER','?') AS level_name,
       fpov.level_value
FROM fnd_profile_options fpo
JOIN fnd_profile_options_tl fpot
  ON fpo.profile_option_id = fpot.profile_option_id
LEFT JOIN fnd_profile_option_values fpov
  ON fpo.profile_option_id = fpov.profile_option_id
WHERE fpot.language = 'US'
  AND fpo.profile_option_name IN (
    'FND_SSO_TYPE',
    'FND_SSO_SERVER_LIST',
    'FND_SSO_POLICY_ADMIN_URL',
    'FND_SSO_LDAP_CONNECTION_STRING'
  )
ORDER BY fpo.profile_option_name, fpov.level_id;
\`\`\`

A mismatch where \`FND_SSO_TYPE\` = \`SSO\` at User level while Site level = \`LOCAL\` or NULL causes internal validation failures. Normalize all SSO profiles to match the Site-level setting.

### Step 3.4 — Disable Debug Logging After Investigation

\`\`\`sql
-- Disable logging for the target user as soon as investigation is complete
DECLARE
  l_user_id NUMBER := &target_user_id;
BEGIN
  FND_PROFILE.SAVE('FND_DEBUG_LOG_ENABLED', 'N', 'USER', l_user_id);
  COMMIT;
  DBMS_OUTPUT.PUT_LINE('Debug logging disabled for user_id: ' || l_user_id);
END;
/
\`\`\`

---

## Phase 4: Database-Level Lock and Session Investigation

### Step 4.1 — Check for Blocking Sessions During the Error Window

\`\`\`sql
-- Run immediately when the error is reported (ideally from a second session)
-- Find sessions blocking others
SELECT DISTINCT
       l1.sid AS blocker_sid,
       s1.username AS blocker_user,
       s1.status AS blocker_status,
       s1.program AS blocker_program,
       s1.module AS blocker_module,
       s1.action AS blocker_action,
       l2.sid AS waiter_sid,
       s2.username AS waiter_user,
       s2.status AS waiter_status,
       s2.seconds_in_wait AS wait_seconds
FROM v\$lock l1
JOIN v\$lock l2
  ON  l1.id1 = l2.id1
 AND  l1.id2 = l2.id2
 AND  l1.lmode > 0
 AND  l2.request > 0
 AND  l1.sid <> l2.sid
JOIN v\$session s1 ON l1.sid = s1.sid
JOIN v\$session s2 ON l2.sid = s2.sid
ORDER BY wait_seconds DESC;
\`\`\`

### Step 4.2 — Identify What the Blocker Is Doing

\`\`\`sql
-- Get the SQL currently running in the blocking session
SELECT s.sid,
       s.username,
       s.program,
       s.module,
       s.action,
       sq.sql_text,
       sq.executions,
       s.seconds_in_wait,
       s.state
FROM v\$session s
JOIN v\$sql sq ON s.sql_id = sq.sql_id
WHERE s.sid = &blocker_sid;
\`\`\`

### Step 4.3 — Enable SQL Trace on the Affected User's Session

For the most granular view of what the sourcing engine is executing when it fails, enable a 10046 trace on the session at the moment the error occurs:

\`\`\`sql
-- Find the session for the target user
SELECT sid, serial#, username, status, program, module
FROM v\$session
WHERE username = UPPER('&ebs_username')
  AND status = 'ACTIVE';

-- Enable timed statistics trace (level 12: SQL + waits + binds)
EXEC DBMS_MONITOR.SESSION_TRACE_ENABLE(
  session_id  => &sid,
  serial_num  => &serial#,
  waits       => TRUE,
  binds       => TRUE
);

-- After the error occurs, disable trace
EXEC DBMS_MONITOR.SESSION_TRACE_DISABLE(session_id => &sid, serial_num => &serial#);
\`\`\`

Find the trace file:

\`\`\`sql
SELECT value FROM v\$parameter WHERE name = 'user_dump_dest';
\`\`\`

Format with tkprof:

\`\`\`bash
tkprof /path/to/trace_file.trc /tmp/sourcing_trace_output.txt waits=yes sort=exeela
\`\`\`

Look for wait events around \`enq: TX - row lock contention\`, \`enq: TM - contention\`, or unusually long wait times on custom package calls.

---

## Phase 5: Custom Wrapper and Interceptor Audit

### Step 5.1 — Identify Custom Code in the Picking API Call Stack

\`\`\`sql
-- Find custom packages referencing standard pick/move order APIs
SELECT owner,
       name AS package_name,
       type,
       line,
       SUBSTR(text, 1, 200) AS code_text
FROM dba_source
WHERE (UPPER(text) LIKE '%INV_REPLENISH_DETAIL_PUB%'
    OR UPPER(text) LIKE '%WMS_PICK_CONFIRM_PUB%'
    OR UPPER(text) LIKE '%WMS_PICKING_PKG%'
    OR UPPER(text) LIKE '%INV_PICK_CONFIRM_PUB%')
  AND owner NOT IN ('SYS','SYSTEM','APPS','INV','WMS','WSH')
ORDER BY owner, name, line;

-- Find database triggers on key inventory transaction tables
SELECT trigger_name,
       table_name,
       trigger_type,
       triggering_event,
       status
FROM dba_triggers
WHERE table_name IN (
  'MTL_MATERIAL_TRANSACTIONS_TEMP',
  'MTL_TXN_REQUEST_LINES',
  'WSH_DELIVERY_DETAILS',
  'MTL_RESERVATIONS'
)
  AND status = 'ENABLED'
ORDER BY table_name, trigger_name;
\`\`\`

### Step 5.2 — Audit Exception Handling in Custom Wrappers

For each custom package identified in Step 5.1, check its exception handling:

\`\`\`sql
-- Find EXCEPTION blocks in custom sourcing-related packages
-- Look for WHEN OTHERS handlers that do NOT log SQLERRM or FORMAT_ERROR_BACKTRACE
SELECT owner, name, line, text
FROM dba_source
WHERE name IN (
  -- substitute with custom package names found in Step 5.1
  'XX_PICK_WRAPPER_PKG',
  'XX_LICENSE_VALIDATION_PKG'
)
AND UPPER(text) LIKE '%WHEN OTHERS%'
ORDER BY name, line;

-- Find packages that reference FORMAT_ERROR_BACKTRACE (good pattern)
SELECT DISTINCT owner, name
FROM dba_source
WHERE UPPER(text) LIKE '%FORMAT_ERROR_BACKTRACE%'
  AND owner NOT IN ('SYS','SYSTEM','APPS')
ORDER BY owner, name;
\`\`\`

Custom packages that appear in Step 5.1 but not in the \`FORMAT_ERROR_BACKTRACE\` list are candidates for silent exception masking.

### Step 5.3 — Add Pre-Rollback Exception Logging to Custom Wrappers

This is the single most impactful change for permanently diagnosing intermittent errors in custom picking wrappers. Add a staging log table and populate it before every rollback:

\`\`\`sql
-- Create exception staging table (one-time setup)
CREATE TABLE xx_api_exception_log (
  log_id            NUMBER          GENERATED ALWAYS AS IDENTITY,
  log_timestamp     TIMESTAMP       DEFAULT SYSTIMESTAMP,
  calling_program   VARCHAR2(200),
  error_code        NUMBER,
  error_message     VARCHAR2(4000),
  error_backtrace   VARCHAR2(4000),
  move_order_line_id NUMBER,
  inventory_item_id NUMBER,
  organization_id   NUMBER,
  session_info      VARCHAR2(200)
) TABLESPACE APPS_TS_TX_DATA;

-- Grant insert to the schema running the custom wrappers
GRANT INSERT ON xx_api_exception_log TO xx_custom_schema;
\`\`\`

Update custom wrappers to log before rollback:

\`\`\`sql
-- Pattern to add to every WHEN OTHERS handler in picking/move order wrappers
EXCEPTION
  WHEN OTHERS THEN
    -- Capture the true error BEFORE rollback wipes the error state
    BEGIN
      INSERT INTO xx_api_exception_log (
        calling_program,
        error_code,
        error_message,
        error_backtrace,
        move_order_line_id,
        inventory_item_id,
        organization_id,
        session_info
      ) VALUES (
        'XX_PICK_WRAPPER_PKG.CONFIRM_PICKS',
        SQLCODE,
        SQLERRM,
        DBMS_UTILITY.FORMAT_ERROR_BACKTRACE,
        p_mo_line_id,        -- pass-in parameter
        p_inventory_item_id, -- pass-in parameter
        p_org_id,            -- pass-in parameter
        SYS_CONTEXT('USERENV','SESSION_USER') || '/' ||
        SYS_CONTEXT('USERENV','SID')
      );
      COMMIT;  -- commit the log BEFORE rolling back the transaction
    EXCEPTION
      WHEN OTHERS THEN NULL;  -- never let the log insert block the error path
    END;

    x_return_status := FND_API.G_RET_STS_UNEXP_ERROR;
    ROLLBACK TO SAVEPOINT xx_pick_wrapper_start;
\`\`\`

---

## Monitoring Scripts

### Script 1: Real-Time MMTT Orphan Detector

Runs every 5 minutes via crontab. Alerts when MMTT records exist with no active session holding a lock — a reliable early indicator of orphaned transactions.

\`\`\`bash
#!/bin/bash
# mmtt_orphan_monitor.sh
# Detect orphaned MTL_MATERIAL_TRANSACTIONS_TEMP records.
# Schedule: */5 * * * * /opt/oracle/scripts/mmtt_orphan_monitor.sh

ORACLE_SID=EBSPRD
ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
PATH=\${ORACLE_HOME}/bin:\${PATH}
RECIPIENT="dba-team@example.com,inv-team@example.com"
LOG=/var/log/mmtt_orphan_monitor.log
ALERT_THRESHOLD=5  # alert if more than N orphan candidates exist
ORPHAN_AGE_MINUTES=15  # records older than this with no active session

export ORACLE_SID ORACLE_HOME PATH

TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')

RESULT=\$(sqlplus -s / as sysdba << 'ENDSQL'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF VERIFY OFF
SELECT COUNT(*) || '|' ||
       NVL(MAX(TO_CHAR(creation_date,'YYYY-MM-DD HH24:MI:SS')),'N/A') || '|' ||
       NVL(TO_CHAR(MAX(transaction_temp_id)),'N/A')
FROM mtl_material_transactions_temp mmtt
WHERE mmtt.lock_flag    IN (1, 2)
  AND mmtt.process_flag = 1
  AND mmtt.creation_date < SYSDATE - &ORPHAN_AGE_MINUTES / 1440
  AND NOT EXISTS (
    SELECT 1 FROM v\$session s
    WHERE s.username IS NOT NULL
      AND s.status = 'ACTIVE'
      AND s.module LIKE '%INV%'
      AND s.logon_time <= mmtt.creation_date
  );
ENDSQL
)

COUNT=\$(echo "\${RESULT}" | cut -d'|' -f1 | tr -d ' ')
OLDEST=\$(echo "\${RESULT}" | cut -d'|' -f2)

echo "[\${TIMESTAMP}] MMTT orphan check: candidate_count=\${COUNT} oldest=\${OLDEST}" >> "\${LOG}"

if [ -n "\${COUNT}" ] && [ "\${COUNT}" -gt "\${ALERT_THRESHOLD}" ]; then
  HOST=\$(hostname -s)
  SUBJECT="[\${ORACLE_SID}] MMTT Orphan Alert: \${COUNT} potentially orphaned transaction records"
  BODY="MMTT Orphan Monitor Alert
Host: \${HOST}
Instance: \${ORACLE_SID}
Timestamp: \${TIMESTAMP}

\${COUNT} MTL_MATERIAL_TRANSACTIONS_TEMP records are older than \${ORPHAN_AGE_MINUTES} minutes
with PROCESS_FLAG=1 and no confirmed active session.

These may be causing intermittent 'Material Sourcing Process Failed' errors.
Oldest record creation_date: \${OLDEST}

Action: Review Phase 2 of the Material Sourcing runbook.
Query: SELECT transaction_temp_id, move_order_line_id, creation_date, process_flag
       FROM mtl_material_transactions_temp
       WHERE process_flag=1 AND creation_date < SYSDATE - \${ORPHAN_AGE_MINUTES}/1440;"

  printf "From: oracle-monitor@%s\nTo: %s\nSubject: %s\n\n%s\n" \
    "\$(hostname -f)" "\${RECIPIENT}" "\${SUBJECT}" "\${BODY}" \
    | /usr/sbin/sendmail -t -oi
  echo "[\${TIMESTAMP}] Alert sent for \${COUNT} orphan candidate(s)" >> "\${LOG}"
fi
\`\`\`

### Script 2: Sourcing Failure Rate Monitor

Queries the concurrent manager request log for pick release failures and reports the failure rate. A spike in sourcing failures above a baseline triggers an alert.

\`\`\`sql
-- sourcing_failure_rate.sql
-- Run hourly via cron or as a scheduled concurrent program
-- Reports pick release failure rate over the last 24 hours

SELECT hour_bucket,
       total_requests,
       failed_requests,
       ROUND(failed_requests / NULLIF(total_requests, 0) * 100, 2) AS failure_pct
FROM (
  SELECT TRUNC(cr.actual_start_date, 'HH') AS hour_bucket,
         COUNT(*) AS total_requests,
         SUM(CASE WHEN cr.status_code IN ('E','X') THEN 1 ELSE 0 END) AS failed_requests
  FROM fnd_concurrent_requests cr
  JOIN fnd_concurrent_programs cp
    ON cr.concurrent_program_id = cp.concurrent_program_id
  JOIN fnd_concurrent_programs_tl cpot
    ON cp.concurrent_program_id = cpot.concurrent_program_id
  WHERE cpot.language = 'US'
    AND cpot.user_concurrent_program_name LIKE '%Pick Release%'
    AND cr.actual_start_date >= SYSDATE - 1
  GROUP BY TRUNC(cr.actual_start_date, 'HH')
)
ORDER BY hour_bucket DESC;
\`\`\`

### Script 3: Custom Exception Log Report

Query the \`XX_API_EXCEPTION_LOG\` table (from Phase 5 setup) to surface the true errors behind intermittent sourcing failures:

\`\`\`sql
-- xx_exception_log_report.sql
-- Run after any sourcing failure is reported
-- Shows the true SQLCODE/SQLERRM captured before rollback

SELECT log_timestamp,
       calling_program,
       error_code,
       SUBSTR(error_message, 1, 200)   AS error_message,
       SUBSTR(error_backtrace, 1, 400) AS backtrace,
       move_order_line_id,
       inventory_item_id,
       organization_id,
       session_info
FROM xx_api_exception_log
WHERE log_timestamp >= SYSTIMESTAMP - INTERVAL '2' HOUR
ORDER BY log_timestamp DESC
FETCH FIRST 50 ROWS ONLY;

-- Group by true error code to see which custom package is the most frequent source
SELECT calling_program,
       error_code,
       SUBSTR(MIN(error_message), 1, 200) AS sample_message,
       COUNT(*) AS occurrence_count,
       MIN(log_timestamp) AS first_seen,
       MAX(log_timestamp) AS last_seen
FROM xx_api_exception_log
WHERE log_timestamp >= SYSTIMESTAMP - INTERVAL '24' HOUR
GROUP BY calling_program, error_code
ORDER BY occurrence_count DESC;
\`\`\`

---

## Quick Reference

### Diagnostic Query Chain (Run in Order)

\`\`\`sql
-- 1. Get move order context
SELECT mtrh.request_number, mtrl.line_number, mtrl.inventory_item_id,
       mtrl.quantity, mtrl.quantity_detailed, mtrl.line_status
FROM mtl_txn_request_headers mtrh
JOIN mtl_txn_request_lines mtrl ON mtrh.header_id = mtrl.header_id
WHERE mtrl.line_id = &mo_line_id;

-- 2. Check on-hand quantity
SELECT moq.subinventory_code, moq.locator_id, moq.lot_number,
       moq.primary_transaction_quantity, moq.secondary_transaction_quantity
FROM mtl_onhand_quantities_detail moq
WHERE moq.inventory_item_id = &item_id
  AND moq.organization_id   = &org_id;

-- 3. Check MMTT for orphans
SELECT transaction_temp_id, move_order_line_id, process_flag, lock_flag, creation_date
FROM mtl_material_transactions_temp
WHERE move_order_line_id = &mo_line_id;

-- 4. Check reservations
SELECT reservation_id, demand_source_type_id, demand_source_line_id,
       reservation_quantity, lot_number, subinventory_code
FROM mtl_reservations
WHERE inventory_item_id = &item_id
  AND organization_id   = &org_id
  AND demand_source_line_id = &mo_line_id;

-- 5. Check quantity tree timeout profile
SELECT profile_option_value FROM fnd_profile_option_values fpov
JOIN fnd_profile_options fpo ON fpo.profile_option_id = fpov.profile_option_id
WHERE fpo.profile_option_name = 'INV_QUANTITY_TREE_TIMEOUT' AND fpov.level_id = 10001;

-- 6. Check blocking sessions
SELECT l1.sid blocker, s1.username, l2.sid waiter, s2.username w_user, s2.seconds_in_wait
FROM v\$lock l1 JOIN v\$lock l2 ON l1.id1=l2.id1 AND l1.id2=l2.id2
  AND l1.lmode>0 AND l2.request>0 AND l1.sid<>l2.sid
JOIN v\$session s1 ON l1.sid=s1.sid
JOIN v\$session s2 ON l2.sid=s2.sid;
\`\`\`

### Profile Fix Commands

\`\`\`sql
-- Set quantity tree lock timeout to 10 seconds at Site level
EXEC FND_PROFILE.SAVE('INV_QUANTITY_TREE_TIMEOUT', '10', 'SITE'); COMMIT;

-- Disable backorder caching
EXEC FND_PROFILE.SAVE('INV_BACKORDER_CACHING', 'N', 'SITE'); COMMIT;

-- Enable user-level debug logging
EXEC FND_PROFILE.SAVE('FND_DEBUG_LOG_ENABLED', 'Y', 'USER', &user_id); COMMIT;
EXEC FND_PROFILE.SAVE('FND_DEBUG_LOG_LEVEL',   '6', 'USER', &user_id); COMMIT;

-- Disable user-level debug logging
EXEC FND_PROFILE.SAVE('FND_DEBUG_LOG_ENABLED', 'N', 'USER', &user_id); COMMIT;
\`\`\`

---

## Summary

Intermittent "Material Sourcing Process Failed" errors in Oracle EBS pick release and move order allocation follow a predictable diagnostic path when the retry-success pattern is present.

**Phase 1 (Profiles)** addresses the most common root cause in high-volume warehouses: the \`INV: Quantity Tree Timeout for Lock\` profile is NULL or excessively high, allowing pick release workers to deadlock on quantity tree nodes. Setting a 10-second timeout at the Site level causes workers to fail fast and retry rather than blocking each other indefinitely.

**Phase 2 (MMTT Orphans)** handles the second most common cause: a prior crashed session left in-flight transaction records in \`MTL_MATERIAL_TRANSACTIONS_TEMP\`. The sourcing engine sees these records as active allocations and refuses to re-allocate the material. The concurrent manager's cleanup process resolves them automatically; reducing the cleanup interval eliminates the gap between the crash and the next successful attempt.

**Phase 3 (FND Debug Logging)** surfaces session framework anomalies — primarily SSO profile mismatches — that cause internal exceptions never reported by the functional error layer. User-level logging (never Site-level in production) combined with targeted log mining in \`FND_LOG_MESSAGES\` identifies these in a single reproduction cycle.

**Phase 4 and 5 (Custom Code)** address failures that are only reproducible in production due to custom picking interceptors, license validation hooks, or inline maintenance job conflicts. Adding \`DBMS_UTILITY.FORMAT_ERROR_BACKTRACE\` logging to a pre-rollback INSERT in every custom WHEN OTHERS handler is the definitive fix: the true \`SQLCODE\` and \`SQLERRM\` are captured before the rollback discards the error state, permanently ending the cycle of misleading "Material Sourcing Process Failed" reports that hide the actual root cause.`,
};

async function main() {
  console.log('Inserting material sourcing runbook...');
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
