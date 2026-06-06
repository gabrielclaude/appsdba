import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Auditing, Disabling, and Patching Oracle OJVM',
  slug: 'oracle-ojvm-disable-patch-runbook',
  excerpt:
    'A phased operational runbook for Oracle DBAs covering the complete OJVM lifecycle: auditing for Java usage before disablement, checking current patch level and CVE exposure, disabling OJVM safely on both non-CDB and CDB/PDB architectures, the re-enable sequence required before patching, the full OJVM CPU patch application workflow, post-disable validation, and an automated PL/SQL monitor that detects patch currency gaps, new Java object creation, and PDB status drift.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-06'),
  youtubeUrl: null,
  content: `This runbook covers Oracle OJVM (Oracle JVM) auditing, disablement, and patching operations end to end. All commands are SQL/PL/SQL or shell. Run each phase in order, verify results at each checkpoint before proceeding.

**Assumptions:**
- Oracle Database 12.2 or later (19c or 21c recommended)
- Access as SYSDBA for disablement and patching operations
- DBA role for audit queries
- OS access as oracle user for opatch commands
- CDB/PDB notes are in Phase 4; non-CDB steps are in Phase 3

---

## Phase 0: OJVM Audit — Is OJVM in Use?

Run all queries in this phase before making any disablement decision. If any query returns rows (outside of SYS/SYSTEM/Oracle-owned schemas), OJVM is in active use. Do not disable.

### Step 0.1: Check OJVM component status

\`\`\`sql
-- Verify OJVM is registered and VALID
SELECT comp_id,
       comp_name,
       version,
       version_full,
       status,
       modified,
       schema
FROM dba_registry
WHERE comp_id = 'JAVAVM';
-- STATUS = VALID means OJVM is installed and functional
-- STATUS = INVALID means OJVM component has an integrity problem — investigate before any action
\`\`\`

### Step 0.2: Find all Java objects in the database

\`\`\`sql
-- Count Java objects by type and owner (exclude Oracle-owned schemas)
SELECT object_type,
       owner,
       COUNT(*) AS object_count
FROM dba_objects
WHERE object_type LIKE 'JAVA%'
  AND owner NOT IN (
    'SYS', 'SYSTEM', 'OJVMSYS', 'DBSNMP', 'OUTLN', 'XDB',
    'WMSYS', 'CTXSYS', 'MDSYS', 'ORDSYS', 'ORDDATA', 'EXFSYS',
    'LBACSYS', 'DVSYS', 'GSMADMIN_INTERNAL', 'GSMCATUSER',
    'APEX_PUBLIC_USER', 'FLOWS_FILES', 'REMOTE_SCHEDULER_AGENT'
  )
GROUP BY object_type, owner
ORDER BY owner, object_type;

-- Decision: if this returns ANY rows, application schemas own Java objects.
-- OJVM is in active use. Do not disable.
\`\`\`

### Step 0.3: Find all Java stored procedures and functions

\`\`\`sql
-- Find PL/SQL units with LANGUAGE JAVA declarations (Java call specs)
SELECT owner,
       name AS object_name,
       type AS object_type,
       line,
       TRIM(text) AS source_line
FROM dba_source
WHERE UPPER(text) LIKE '%LANGUAGE JAVA%'
  AND owner NOT IN (
    'SYS', 'SYSTEM', 'OJVMSYS', 'XDB', 'MDSYS', 'CTXSYS',
    'ORDSYS', 'ORDDATA', 'WMSYS', 'EXFSYS', 'DVSYS', 'LBACSYS'
  )
ORDER BY owner, name, line;

-- Also scan for direct DBMS_JAVA calls in PL/SQL code
SELECT owner,
       name AS object_name,
       type AS object_type,
       line,
       TRIM(text) AS source_line
FROM dba_source
WHERE UPPER(text) LIKE '%DBMS_JAVA%'
  AND owner NOT IN (
    'SYS', 'SYSTEM', 'OJVMSYS', 'XDB', 'MDSYS', 'CTXSYS',
    'ORDSYS', 'ORDDATA', 'WMSYS', 'EXFSYS', 'DVSYS', 'LBACSYS'
  )
ORDER BY owner, name, line;
\`\`\`

### Step 0.4: Find Java triggers

\`\`\`sql
-- Java-based triggers (action_type = 'CALL' with a Java call spec body)
SELECT t.owner,
       t.trigger_name,
       t.table_name,
       t.trigger_type,
       t.triggering_event,
       t.status,
       SUBSTR(t.trigger_body, 1, 200) AS trigger_body_preview
FROM dba_triggers t
WHERE UPPER(t.trigger_body) LIKE '%LANGUAGE JAVA%'
   OR UPPER(t.trigger_body) LIKE '%DBMS_JAVA%'
  AND t.owner NOT IN ('SYS', 'SYSTEM', 'OJVMSYS', 'XDB', 'MDSYS')
ORDER BY t.owner, t.trigger_name;
\`\`\`

### Step 0.5: Detect active Oracle feature usage that depends on OJVM

\`\`\`sql
-- Oracle Spatial: check for non-Oracle schemas with SDO column types
SELECT tc.owner,
       tc.table_name,
       tc.column_name,
       tc.data_type
FROM dba_tab_columns tc
WHERE tc.data_type LIKE 'SDO_%'
  AND tc.owner NOT IN ('SYS', 'SYSTEM', 'MDSYS', 'MDDATA', 'XDB')
ORDER BY tc.owner, tc.table_name;

-- Oracle Text: check for active full-text indexes
SELECT idx_name,
       idx_table_owner,
       idx_table,
       idx_language,
       idx_status
FROM ctxsys.ctx_indexes
ORDER BY idx_table_owner, idx_table;

-- SODA collections: check for document collections
SELECT owner,
       collection_name,
       table_name,
       storage_hint
FROM all_soda_collections
WHERE owner NOT IN ('SYS', 'SYSTEM', 'APEX_PUBLIC_USER', 'ANONYMOUS')
ORDER BY owner, collection_name;

-- Check if Oracle E-Business Suite is present
-- (EBS mandates OJVM as part of certified baseline)
SELECT COUNT(*) AS ebs_indicator
FROM dba_tables
WHERE owner = 'APPLSYS'
  AND table_name = 'FND_PRODUCT_INSTALLATIONS';
-- If count > 0, this is an EBS database. Do not disable OJVM.

-- If EBS tables are accessible, check installed products
SELECT application_short_name,
       status,
       product_version,
       patch_level
FROM applsys.fnd_product_installations
WHERE status IN ('I', 'S')  -- Installed or Shared
ORDER BY application_short_name
FETCH FIRST 30 ROWS ONLY;
\`\`\`

### Step 0.6: Decision matrix

Review all Phase 0 query results:

- Step 0.2 returns application-owned Java objects → **OJVM is in use. Do not disable.**
- Step 0.3 returns Java call specs or DBMS_JAVA calls → **OJVM is in use. Do not disable.**
- Step 0.4 returns Java triggers → **OJVM is in use. Do not disable.**
- Step 0.5 SDO columns exist in application schemas → **Verify with Spatial team before disabling.**
- Step 0.5 Oracle Text indexes exist → **Verify with Text team before disabling.**
- Step 0.5 SODA collections exist → **Verify SODA dependency before disabling.**
- Step 0.5 EBS indicator > 0 → **This is an EBS database. Do not disable OJVM.**
- All queries return zero rows (outside Oracle schemas) → **Proceed to Phase 1.**

---

## Phase 1: Check Current OJVM Patch Level

### Step 1.1: List all applied Java patches via opatch

\`\`\`bash
# Run on the DB server as oracle OS user
# List all patches — filter for Java/OJVM patches
\$ORACLE_HOME/OPatch/opatch lspatches | grep -i -E "java|ojvm|jvm"

# Full patch list with dates
\$ORACLE_HOME/OPatch/opatch lsinventory -detail | grep -A 3 -i "ojvm\|java vm"

# Example output format:
# 35742441   OJVM RELEASE UPDATE 19.22.0.0.0 (35742441)
# 35742441   Applied on: Mon Jan 15 08:23:44 UTC 2026
\`\`\`

### Step 1.2: Check SQL-level patches from DBA_REGISTRY_SQLPATCH

\`\`\`sql
-- All SQL patches with OJVM or JAVA in description, most recent first
SELECT patch_id,
       patch_uid,
       patch_type,
       status,
       action,
       TO_CHAR(action_time, 'YYYY-MM-DD HH24:MI:SS') AS applied_on,
       description
FROM dba_registry_sqlpatch
WHERE UPPER(description) LIKE '%OJVM%'
   OR UPPER(description) LIKE '%JAVA VM%'
   OR UPPER(description) LIKE '%JAVAVM%'
ORDER BY action_time DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

### Step 1.3: Confirm current OJVM version vs expected RU

\`\`\`sql
-- Current database version and OJVM component version
SELECT b.banner AS db_banner,
       r.comp_id,
       r.version AS ojvm_version,
       r.version_full AS ojvm_version_full,
       r.status AS ojvm_status
FROM v\$version b
CROSS JOIN dba_registry r
WHERE r.comp_id = 'JAVAVM'
  AND b.banner LIKE 'Oracle Database%';

-- The OJVM version_full should match the Database version_full
-- Example: both should show 19.22.0.0.0 if on the January 2026 RU
-- Mismatch indicates OJVM patch was not fully applied or datapatch did not complete
\`\`\`

---

## Phase 2: Check for Outstanding CVEs

### Step 2.1: Identify database version for patch gap analysis

\`\`\`sql
-- Capture full version string for MOS patch lookup
SELECT version,
       version_full,
       banner_full
FROM v\$version
WHERE banner LIKE 'Oracle Database%';

-- Capture last applied CPU patch date
SELECT MAX(action_time) AS last_cpu_action_time,
       TRUNC(SYSDATE) - TRUNC(MAX(action_time)) AS days_since_last_cpu_patch,
       MAX(patch_id) AS last_cpu_patch_id,
       MAX(description) KEEP (DENSE_RANK LAST ORDER BY action_time) AS last_patch_description
FROM dba_registry_sqlpatch
WHERE UPPER(description) LIKE '%OJVM%'
   OR UPPER(description) LIKE '%RELEASE UPDATE%';
\`\`\`

### Step 2.2: Calculate patch currency and risk level

\`\`\`sql
-- Patch currency assessment
-- CPUs release quarterly: Jan, Apr, Jul, Oct
-- > 90 days = one CPU cycle missed (WARNING)
-- > 180 days = two CPU cycles missed (HIGH risk)
-- > 270 days = three CPU cycles missed (CRITICAL)
SELECT patch_id,
       patch_uid,
       TO_CHAR(action_time, 'YYYY-MM-DD') AS applied_date,
       description,
       TRUNC(SYSDATE) - TRUNC(action_time) AS days_since_applied,
       CASE
         WHEN TRUNC(SYSDATE) - TRUNC(action_time) <= 90
           THEN 'CURRENT — within one CPU cycle'
         WHEN TRUNC(SYSDATE) - TRUNC(action_time) BETWEEN 91 AND 180
           THEN 'WARNING — one CPU cycle missed'
         WHEN TRUNC(SYSDATE) - TRUNC(action_time) BETWEEN 181 AND 270
           THEN 'HIGH RISK — two CPU cycles missed'
         ELSE 'CRITICAL — three or more CPU cycles missed'
       END AS patch_currency_status
FROM dba_registry_sqlpatch
WHERE UPPER(description) LIKE '%OJVM%'
   OR UPPER(description) LIKE '%RELEASE UPDATE%'
ORDER BY action_time DESC
FETCH FIRST 1 ROWS ONLY;
\`\`\`

### Step 2.3: Construct MOS patch search reference

\`\`\`sql
-- Generate the MOS (My Oracle Support) patch reference URL pattern
-- This is a reference — paste the URL into a browser logged into support.oracle.com
SELECT
  'https://support.oracle.com/rs?type=patch&id=OJVM+RU+' ||
  REPLACE(version, '.', '') AS mos_search_reference,
  'Search MOS for: OJVM RELEASE UPDATE ' || version AS search_term,
  version AS db_version
FROM v\$version
WHERE banner LIKE 'Oracle Database%'
  AND ROWNUM = 1;

-- For 19c: search MOS for "OJVM RELEASE UPDATE 19.x.0.0.0"
-- For 21c: search MOS for "OJVM RELEASE UPDATE 21.x.0.0.0"
-- For 23ai: search MOS for "OJVM RELEASE UPDATE 23.x.0.0.0"
-- The patch number format is a 8-digit number listed under the DB version's patch family
\`\`\`

---

## Phase 3: Disable OJVM — Non-CDB Database

### Step 3.1: Pre-disable verification

\`\`\`sql
-- 1. Confirm OJVM STATUS is VALID (not already disabled or invalid)
SELECT comp_id, status, version FROM dba_registry WHERE comp_id = 'JAVAVM';
-- STATUS must be VALID to proceed

-- 2. Confirm no active sessions with Java-related activity
SELECT sid,
       serial#,
       username,
       program,
       module,
       action,
       status,
       event
FROM v\$session
WHERE (UPPER(module) LIKE '%JAVA%'
    OR UPPER(program) LIKE '%JAVA%'
    OR UPPER(action) LIKE '%JAVA%')
  AND type = 'USER'
ORDER BY sid;
-- Must return zero rows before disabling

-- 3. Confirm zero Java objects in application schemas (repeat Phase 0 summary check)
SELECT COUNT(*) AS app_java_object_count
FROM dba_objects
WHERE object_type LIKE 'JAVA%'
  AND owner NOT IN (
    'SYS', 'SYSTEM', 'OJVMSYS', 'DBSNMP', 'OUTLN', 'XDB',
    'WMSYS', 'CTXSYS', 'MDSYS', 'ORDSYS', 'ORDDATA', 'EXFSYS',
    'LBACSYS', 'DVSYS', 'GSMADMIN_INTERNAL'
  );
-- Must be 0 before proceeding
\`\`\`

### Step 3.2: Disable OJVM

\`\`\`sql
-- Connect as SYSDBA
-- Run the disable procedure
EXEC DBMS_JAVA_DEV.DISABLE;

-- Expected output:
-- PL/SQL procedure successfully completed.
\`\`\`

### Step 3.3: Verify disabled state

\`\`\`sql
-- Confirm V$OPTION shows Java as FALSE
SELECT parameter, value
FROM v\$option
WHERE parameter = 'Java';
-- VALUE should be FALSE

-- Confirm DBA_REGISTRY shows JAVAVM status
SELECT comp_id, comp_name, status, version
FROM dba_registry
WHERE comp_id = 'JAVAVM';
-- STATUS = VALID (the component is still present, just execution-locked)
-- Note: STATUS does not change to DISABLED in DBA_REGISTRY — use V$OPTION to confirm

-- Attempt to execute a trivial Java operation — should fail
BEGIN
  DBMS_JAVA.LOADJAVA('-resolve -schema SYS test_disable_check');
EXCEPTION
  WHEN OTHERS THEN
    DBMS_OUTPUT.PUT_LINE('OJVM disabled confirmed. Error: ' || SQLERRM);
END;
/
-- Expected: ORA-29576 or similar Java-disabled error
\`\`\`

---

## Phase 4: Disable OJVM — CDB/PDB Architecture

### Step 4.1: Disable in CDB\$ROOT

\`\`\`sql
-- Connect as SYSDBA to the CDB
-- Confirm current container
SELECT SYS_CONTEXT('USERENV', 'CON_NAME') AS current_container FROM dual;
-- Should show CDB$ROOT

-- Disable in CDB$ROOT
ALTER SESSION SET CONTAINER = CDB\$ROOT;
EXEC DBMS_JAVA_DEV.DISABLE;

COMMIT;
\`\`\`

### Step 4.2: Disable in all open PDBs

\`\`\`sql
-- Iterate through all NORMAL (open) PDBs and disable OJVM in each
SET SERVEROUTPUT ON SIZE UNLIMITED;

DECLARE
  v_pdb_name  VARCHAR2(128);
  v_status    VARCHAR2(20);
  v_count     NUMBER := 0;
BEGIN
  FOR p IN (
    SELECT pdb_name, status
    FROM dba_pdbs
    WHERE status = 'NORMAL'
    ORDER BY pdb_name
  ) LOOP
    v_pdb_name := p.pdb_name;
    BEGIN
      -- Switch to the PDB
      EXECUTE IMMEDIATE 'ALTER SESSION SET CONTAINER = ' || v_pdb_name;

      -- Verify JAVAVM is VALID in this PDB before disabling
      SELECT status INTO v_status
      FROM dba_registry
      WHERE comp_id = 'JAVAVM';

      IF v_status = 'VALID' THEN
        -- Disable OJVM
        DBMS_JAVA_DEV.DISABLE;
        v_count := v_count + 1;
        DBMS_OUTPUT.PUT_LINE('DISABLED: ' || v_pdb_name || ' (was VALID)');
      ELSE
        DBMS_OUTPUT.PUT_LINE('SKIPPED: ' || v_pdb_name || ' (STATUS=' || v_status || ')');
      END IF;

    EXCEPTION
      WHEN OTHERS THEN
        DBMS_OUTPUT.PUT_LINE('ERROR in ' || v_pdb_name || ': ' || SQLERRM);
    END;
  END LOOP;

  -- Return to CDB$ROOT
  EXECUTE IMMEDIATE 'ALTER SESSION SET CONTAINER = CDB\$ROOT';

  DBMS_OUTPUT.PUT_LINE('Total PDBs disabled: ' || v_count);
END;
/
\`\`\`

### Step 4.3: Verify no PDB drift — check all containers at once

\`\`\`sql
-- Check JAVAVM status across all containers
-- CDB_REGISTRY spans all PDBs from CDB$ROOT
SELECT con_id,
       comp_id,
       comp_name,
       version,
       status,
       modified
FROM cdb_registry
WHERE comp_id = 'JAVAVM'
ORDER BY con_id;

-- All containers should show STATUS = VALID
-- Verify V$OPTION across containers (requires CDB$ROOT view)
SELECT c.name AS container_name,
       o.parameter,
       o.value AS java_enabled
FROM v\$containers c
JOIN cdb_options o ON o.con_id = c.con_id
WHERE o.parameter = 'Java'
ORDER BY c.name;
-- VALUE should be FALSE for all containers
\`\`\`

---

## Phase 5: Pre-Patch Window — Re-enable OJVM

**CRITICAL:** OJVM must be re-enabled BEFORE running opatch apply, datapatch, or catctl.pl. Failure to re-enable before patching can leave the database in an inconsistent component state.

### Step 5.1: Verify datapatch is not currently running

\`\`\`bash
# Run on DB server as oracle OS user
ps -ef | grep datapatch | grep -v grep
# If datapatch is running, wait for it to complete before re-enabling OJVM
\`\`\`

### Step 5.2: Re-enable OJVM in CDB\$ROOT and all PDBs

\`\`\`sql
-- Connect as SYSDBA to CDB$ROOT (or non-CDB)
-- Step 1: Re-enable in CDB$ROOT
ALTER SESSION SET CONTAINER = CDB\$ROOT;
EXEC DBMS_JAVA_DEV.ENABLE;

-- Step 2: Re-enable in all open PDBs
SET SERVEROUTPUT ON SIZE UNLIMITED;

DECLARE
  v_pdb_name  VARCHAR2(128);
  v_count     NUMBER := 0;
BEGIN
  FOR p IN (
    SELECT pdb_name
    FROM dba_pdbs
    WHERE status = 'NORMAL'
    ORDER BY pdb_name
  ) LOOP
    v_pdb_name := p.pdb_name;
    BEGIN
      EXECUTE IMMEDIATE 'ALTER SESSION SET CONTAINER = ' || v_pdb_name;
      DBMS_JAVA_DEV.ENABLE;
      v_count := v_count + 1;
      DBMS_OUTPUT.PUT_LINE('ENABLED: ' || v_pdb_name);
    EXCEPTION
      WHEN OTHERS THEN
        DBMS_OUTPUT.PUT_LINE('ERROR in ' || v_pdb_name || ': ' || SQLERRM);
    END;
  END LOOP;

  EXECUTE IMMEDIATE 'ALTER SESSION SET CONTAINER = CDB\$ROOT';
  DBMS_OUTPUT.PUT_LINE('Total PDBs re-enabled: ' || v_count);
END;
/
\`\`\`

### Step 5.3: Verify re-enabled state before patching

\`\`\`sql
-- Confirm Java is TRUE in V$OPTION for all containers
SELECT c.name AS container_name,
       o.parameter,
       o.value AS java_enabled
FROM v\$containers c
JOIN cdb_options o ON o.con_id = c.con_id
WHERE o.parameter = 'Java'
ORDER BY c.name;
-- VALUE must be TRUE for all containers before running opatch or datapatch
\`\`\`

### Step 5.4: The correct patching sequence

\`\`\`
Correct OJVM CPU patch sequence:
1. Phase 5: Re-enable OJVM (Steps 5.1 - 5.3)
2. Phase 6: Shut down DB and apply OS patch with opatch (Step 6.2 - 6.3)
3. Phase 6: Start DB and run datapatch (Step 6.5)
4. Phase 6: Verify patch applied (Step 6.6)
5. Phase 4: Re-disable OJVM if environment was disabled before patching (Steps 4.1 - 4.3)
\`\`\`

---

## Phase 6: Apply OJVM CPU Patch

### Step 6.1: Download the OJVM patch from MOS

The OJVM RU (Release Update) patch is published on My Oracle Support with each quarterly CPU.

Patch naming convention:
- The OJVM RU patch is a separate download from the main Database RU patch
- Search MOS for: **OJVM RELEASE UPDATE \<version\>.\<RU_number\>.0.0.0**
- Example: "OJVM RELEASE UPDATE 19.22.0.0.0" for 19c January 2026 CPU
- The patch has a format: two ZIP files — one for the OS-level binaries (applied with opatch) and one for the SQL scripts (applied with datapatch)
- Note: Since Oracle 12.2, the OJVM RU is typically combined into the main Database RU — verify in the patch README whether a separate OJVM patch is needed or if it is included in the Database RU

### Step 6.2: Stop database services

\`\`\`bash
# Stop all database services — run as oracle OS user
# For single instance:
sqlplus / as sysdba << 'EOF'
SHUTDOWN IMMEDIATE;
EXIT;
EOF

# For RAC — stop all instances (run on each node or use srvctl):
srvctl stop database -db \$ORACLE_SID

# Stop the listener (if not shared across multiple DBs)
lsnrctl stop
\`\`\`

### Step 6.3: Apply the OJVM patch using opatch

\`\`\`bash
# Navigate to the unzipped patch directory
# Replace PATCH_NUMBER with the actual patch ID from MOS
cd /tmp/patches/PATCH_NUMBER

# Check for conflicts before applying
\$ORACLE_HOME/OPatch/opatch prereq CheckConflictAgainstOHWithDetail -ph ./

# Apply the patch
\$ORACLE_HOME/OPatch/opatch apply

# Verify patch appears in opatch inventory
\$ORACLE_HOME/OPatch/opatch lspatches | head -20

# Expected output should include the OJVM patch:
# PATCH_NUMBER   OJVM RELEASE UPDATE 19.22.0.0.0 (PATCH_NUMBER)
\`\`\`

### Step 6.4: Re-enable OJVM before running datapatch

\`\`\`bash
# Start the database (must be open before datapatch)
sqlplus / as sysdba << 'EOF'
STARTUP;
EXIT;
EOF
\`\`\`

Run Phase 5 (Steps 5.2 - 5.3) to re-enable OJVM in CDB\$ROOT and all PDBs.

### Step 6.5: Run datapatch

\`\`\`bash
# Run datapatch to apply SQL-level changes for the patch
# Must run with OJVM enabled (Step 6.4 above)
cd \$ORACLE_HOME/OPatch
./datapatch -verbose

# datapatch output will show:
# SQL Patching tool version X.X.X.X.X on <date>
# Connected to database <SID> as user SYS
# Bootstrapping registry and target validation ...
# Determining current state...
# ...
# Patch <PATCH_NUMBER>: apply SQL (OJVM component)
# ...
# Patch <PATCH_NUMBER> apply: SUCCESS
\`\`\`

### Step 6.6: Verify patch applied successfully

\`\`\`sql
-- Verify the patch appears in DBA_REGISTRY_SQLPATCH
SELECT patch_id,
       patch_uid,
       status,
       action,
       TO_CHAR(action_time, 'YYYY-MM-DD HH24:MI:SS') AS applied_on,
       description
FROM dba_registry_sqlpatch
WHERE UPPER(description) LIKE '%OJVM%'
ORDER BY action_time DESC
FETCH FIRST 3 ROWS ONLY;
-- STATUS should be SUCCESS for the new patch

-- Verify OJVM version now reflects the new RU
SELECT comp_id, version, version_full, status
FROM dba_registry
WHERE comp_id = 'JAVAVM';
-- version_full should match the patched RU version
\`\`\`

\`\`\`bash
# Confirm at OS level
\$ORACLE_HOME/OPatch/opatch lspatches | grep -i ojvm
\`\`\`

### Step 6.7: Re-disable OJVM (if environment was disabled before patching)

If OJVM was disabled before this patching cycle, re-run Phase 4 (CDB) or Phase 3 (non-CDB) to re-disable after confirming the patch was applied successfully.

### Step 6.8: Restart services and verify database health

\`\`\`bash
# Restart the listener if it was stopped
lsnrctl start

# For RAC, start all instances
srvctl start database -db \$ORACLE_SID
\`\`\`

\`\`\`sql
-- Final health check
SELECT name, open_mode, log_mode, status FROM v\$database;
SELECT comp_id, status, version_full FROM dba_registry ORDER BY comp_id;

-- Confirm no invalid objects introduced by the patch
SELECT COUNT(*) AS invalid_sys_objects
FROM dba_objects
WHERE status != 'VALID'
  AND owner IN ('SYS', 'SYSTEM', 'OJVMSYS');
-- Should return 0
\`\`\`

---

## Phase 7: Post-Disable Validation

### Step 7.1: Confirm OJVM is disabled and execution is blocked

\`\`\`sql
-- Check V$OPTION for Java = FALSE
SELECT parameter, value FROM v\$option WHERE parameter = 'Java';

-- Check DBA_REGISTRY shows VALID (present but execution-locked)
SELECT comp_id, status, version_full FROM dba_registry WHERE comp_id = 'JAVAVM';

-- Attempt to load a Java class — must fail
BEGIN
  DBMS_OUTPUT.PUT_LINE('Attempting DBMS_JAVA call...');
  DBMS_JAVA.LOADJAVA('-resolve -schema SYS _disable_verification_test_');
EXCEPTION
  WHEN OTHERS THEN
    DBMS_OUTPUT.PUT_LINE('Confirmed OJVM disabled. Error received: ' || SQLERRM);
END;
/
-- Expected output: Confirmed OJVM disabled. Error received: ORA-29576...
\`\`\`

### Step 7.2: Confirm no new Java objects since disablement

\`\`\`sql
-- Check for JAVA% objects created after a reference timestamp
-- Substitute the actual disablement date/time
SELECT object_type,
       owner,
       object_name,
       created,
       last_ddl_time
FROM dba_objects
WHERE object_type LIKE 'JAVA%'
  AND owner NOT IN (
    'SYS', 'SYSTEM', 'OJVMSYS', 'DBSNMP', 'OUTLN', 'XDB',
    'WMSYS', 'CTXSYS', 'MDSYS', 'ORDSYS', 'ORDDATA', 'EXFSYS',
    'LBACSYS', 'DVSYS'
  )
  AND created > TO_DATE('2026-06-06 00:00:00', 'YYYY-MM-DD HH24:MI:SS')
ORDER BY created DESC;
-- Should return zero rows
\`\`\`

### Step 7.3: Monitor V\$SESSION for Java-related activity

\`\`\`sql
-- Monitor for any sessions that have Java activity (should be none after disablement)
SELECT sid,
       serial#,
       username,
       program,
       module,
       action,
       event,
       state,
       last_call_et AS secs_in_current_state
FROM v\$session
WHERE (UPPER(module) LIKE '%JAVA%'
    OR UPPER(program) LIKE '%JAVA%'
    OR UPPER(action) LIKE '%JAVA%')
  AND type = 'USER'
ORDER BY last_call_et DESC;
-- Should return zero rows in a properly disabled environment

-- Also check for Java-related wait events (diagnostic only)
SELECT event,
       total_waits,
       total_timeouts,
       time_waited_micro / 1e6 AS total_wait_sec
FROM v\$system_event
WHERE LOWER(event) LIKE '%java%'
ORDER BY total_waits DESC;
\`\`\`

---

## Phase 8: Automated CVE and Patch Currency Monitor

### Step 8.1: Create the monitoring infrastructure

\`\`\`sql
-- Create the log table for OJVM monitor results
CREATE TABLE ojvm_monitor_log (
  log_id          NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  check_timestamp TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  check_type      VARCHAR2(50) NOT NULL,
  severity        VARCHAR2(20) NOT NULL,  -- INFO, WARNING, HIGH, CRITICAL
  message         VARCHAR2(4000) NOT NULL,
  detail          VARCHAR2(4000),
  container_name  VARCHAR2(128)
);

-- Index for efficient querying by time and severity
CREATE INDEX ojvm_monitor_log_ts_idx
  ON ojvm_monitor_log (check_timestamp DESC, severity);

-- Config table: stores the OJVM disable timestamp for drift detection
CREATE TABLE ojvm_monitor_config (
  config_key    VARCHAR2(100) PRIMARY KEY,
  config_value  VARCHAR2(500),
  last_updated  TIMESTAMP DEFAULT SYSTIMESTAMP
);

-- Record the disablement timestamp (update when OJVM is disabled)
INSERT INTO ojvm_monitor_config (config_key, config_value)
VALUES ('OJVM_DISABLED_TIMESTAMP', TO_CHAR(SYSTIMESTAMP, 'YYYY-MM-DD HH24:MI:SS.FF'))
ON CONFLICT (config_key) DO UPDATE
  SET config_value = TO_CHAR(SYSTIMESTAMP, 'YYYY-MM-DD HH24:MI:SS.FF'),
      last_updated = SYSTIMESTAMP;
-- Note: Oracle does not have ON CONFLICT syntax — use MERGE instead:

MERGE INTO ojvm_monitor_config c
  USING (SELECT 'OJVM_DISABLED_TIMESTAMP' AS k,
                TO_CHAR(SYSTIMESTAMP, 'YYYY-MM-DD HH24:MI:SS.FF') AS v
         FROM dual) s
  ON (c.config_key = s.k)
  WHEN MATCHED THEN
    UPDATE SET config_value = s.v, last_updated = SYSTIMESTAMP
  WHEN NOT MATCHED THEN
    INSERT (config_key, config_value) VALUES (s.k, s.v);

COMMIT;
\`\`\`

### Step 8.2: Create the OJVM_PATCH_MONITOR procedure

\`\`\`sql
CREATE OR REPLACE PROCEDURE ojvm_patch_monitor
AUTHID CURRENT_USER
AS
  -- Variables
  v_last_patch_date   DATE;
  v_days_since_patch  NUMBER;
  v_patch_desc        VARCHAR2(500);
  v_patch_id          NUMBER;
  v_disable_ts        TIMESTAMP;
  v_disable_ts_char   VARCHAR2(100);
  v_new_java_count    NUMBER;
  v_drift_count       NUMBER;
  v_severity          VARCHAR2(20);
  v_message           VARCHAR2(4000);
  v_cdb_status        VARCHAR2(20);
  v_pdb_status        VARCHAR2(20);

  -- Email configuration — update these for your environment
  c_smtp_host         CONSTANT VARCHAR2(100) := 'mail.example.com';
  c_from_addr         CONSTANT VARCHAR2(100) := 'oracle-monitor@example.com';
  c_to_addr           CONSTANT VARCHAR2(100) := 'dba-team@example.com';

  PROCEDURE log_result(
    p_check_type     IN VARCHAR2,
    p_severity       IN VARCHAR2,
    p_message        IN VARCHAR2,
    p_detail         IN VARCHAR2 DEFAULT NULL,
    p_container_name IN VARCHAR2 DEFAULT NULL
  ) AS
  BEGIN
    INSERT INTO ojvm_monitor_log
      (check_type, severity, message, detail, container_name)
    VALUES
      (p_check_type, p_severity, p_message, p_detail, p_container_name);
  END log_result;

  PROCEDURE send_alert(
    p_subject IN VARCHAR2,
    p_body    IN VARCHAR2
  ) AS
  BEGIN
    UTL_MAIL.SEND(
      sender     => c_from_addr,
      recipients => c_to_addr,
      subject    => '[OJVM Monitor] ' || p_subject,
      message    => p_body
    );
  EXCEPTION
    WHEN OTHERS THEN
      -- Log email failure but do not raise — monitoring must continue
      log_result(
        'EMAIL_FAILURE', 'WARNING',
        'Failed to send alert email: ' || SQLERRM,
        p_subject
      );
  END send_alert;

BEGIN
  -- ============================================================
  -- CHECK 1: Patch Currency
  -- ============================================================
  BEGIN
    SELECT TRUNC(action_time),
           patch_id,
           description
    INTO v_last_patch_date, v_patch_id, v_patch_desc
    FROM dba_registry_sqlpatch
    WHERE (UPPER(description) LIKE '%OJVM%'
        OR UPPER(description) LIKE '%RELEASE UPDATE%')
      AND status = 'SUCCESS'
      AND action = 'APPLY'
    ORDER BY action_time DESC
    FETCH FIRST 1 ROWS ONLY;

    v_days_since_patch := TRUNC(SYSDATE) - v_last_patch_date;

    IF v_days_since_patch <= 90 THEN
      v_severity := 'INFO';
      v_message  := 'OJVM patch is current. Last patch: ' || TO_CHAR(v_last_patch_date, 'YYYY-MM-DD')
                    || ' (' || v_days_since_patch || ' days ago). Patch ID: ' || v_patch_id;
    ELSIF v_days_since_patch BETWEEN 91 AND 180 THEN
      v_severity := 'WARNING';
      v_message  := 'WARNING: One CPU cycle missed. Last OJVM patch was '
                    || v_days_since_patch || ' days ago ('
                    || TO_CHAR(v_last_patch_date, 'YYYY-MM-DD') || ').';
      send_alert(
        'WARNING — OJVM patch gap detected',
        v_message || CHR(10) || 'Last patch: ' || v_patch_desc
      );
    ELSIF v_days_since_patch BETWEEN 181 AND 270 THEN
      v_severity := 'HIGH';
      v_message  := 'HIGH RISK: Two CPU cycles missed. Last OJVM patch was '
                    || v_days_since_patch || ' days ago. Immediate patching required.';
      send_alert(
        'HIGH RISK — OJVM two CPU cycles behind',
        v_message || CHR(10) || 'Last patch: ' || v_patch_desc
      );
    ELSE
      v_severity := 'CRITICAL';
      v_message  := 'CRITICAL: Three or more CPU cycles missed. Last OJVM patch was '
                    || v_days_since_patch || ' days ago. Database at HIGH CVE exposure risk.';
      send_alert(
        'CRITICAL — OJVM three+ CPU cycles behind',
        v_message || CHR(10) || 'Last patch: ' || v_patch_desc
      );
    END IF;

    log_result('PATCH_CURRENCY', v_severity, v_message, v_patch_desc);

  EXCEPTION
    WHEN NO_DATA_FOUND THEN
      log_result('PATCH_CURRENCY', 'CRITICAL',
        'No OJVM CPU patch record found in DBA_REGISTRY_SQLPATCH. '
        || 'OJVM may never have been patched on this database.');
      send_alert(
        'CRITICAL — No OJVM patch history',
        'No OJVM CPU patches found in DBA_REGISTRY_SQLPATCH. Immediate investigation required.'
      );
  END;

  -- ============================================================
  -- CHECK 2: New Java Objects Since Disablement
  -- ============================================================
  BEGIN
    SELECT config_value
    INTO v_disable_ts_char
    FROM ojvm_monitor_config
    WHERE config_key = 'OJVM_DISABLED_TIMESTAMP';

    v_disable_ts := TO_TIMESTAMP(v_disable_ts_char, 'YYYY-MM-DD HH24:MI:SS.FF');

    SELECT COUNT(*)
    INTO v_new_java_count
    FROM dba_objects
    WHERE object_type LIKE 'JAVA%'
      AND owner NOT IN (
        'SYS', 'SYSTEM', 'OJVMSYS', 'DBSNMP', 'OUTLN', 'XDB',
        'WMSYS', 'CTXSYS', 'MDSYS', 'ORDSYS', 'ORDDATA', 'EXFSYS',
        'LBACSYS', 'DVSYS', 'GSMADMIN_INTERNAL'
      )
      AND created > v_disable_ts;

    IF v_new_java_count = 0 THEN
      log_result('NEW_JAVA_OBJECTS', 'INFO',
        'No new Java objects created in application schemas since OJVM disablement ('
        || v_disable_ts_char || ').');
    ELSE
      v_message := 'ALERT: ' || v_new_java_count
                   || ' new Java object(s) detected in application schemas '
                   || 'since OJVM was disabled (' || v_disable_ts_char || '). '
                   || 'Investigate immediately — this should not be possible if OJVM is properly disabled.';
      log_result('NEW_JAVA_OBJECTS', 'CRITICAL', v_message);
      send_alert(
        'CRITICAL — New Java objects detected after OJVM disable',
        v_message
      );
    END IF;

  EXCEPTION
    WHEN NO_DATA_FOUND THEN
      log_result('NEW_JAVA_OBJECTS', 'WARNING',
        'OJVM disable timestamp not found in config table. '
        || 'Cannot check for new Java objects. Update OJVM_MONITOR_CONFIG.');
  END;

  -- ============================================================
  -- CHECK 3: PDB Status Drift
  -- ============================================================
  BEGIN
    -- Get CDB$ROOT Java status
    SELECT value INTO v_cdb_status
    FROM v\$option
    WHERE parameter = 'Java';

    -- Count PDBs where Java status differs from CDB$ROOT
    -- This requires CDB_OPTIONS view (available in CDB$ROOT)
    SELECT COUNT(*)
    INTO v_drift_count
    FROM (
      SELECT c.name AS con_name,
             o.value AS pdb_java_value
      FROM v\$containers c
      JOIN cdb_options o ON o.con_id = c.con_id
      WHERE o.parameter = 'Java'
        AND c.name != 'CDB\$ROOT'
        AND c.open_mode = 'READ WRITE'
    ) pdb_status
    WHERE pdb_java_value != v_cdb_status;

    IF v_drift_count = 0 THEN
      log_result('PDB_DRIFT', 'INFO',
        'No PDB drift detected. All open PDBs have Java status = '
        || v_cdb_status || ' (matching CDB\$ROOT).');
    ELSE
      v_message := 'PDB DRIFT DETECTED: ' || v_drift_count
                   || ' PDB(s) have Java status different from CDB\$ROOT ('
                   || v_cdb_status || '). '
                   || 'An unpatched or improperly disabled PDB is a security pivot point.';
      log_result('PDB_DRIFT', 'CRITICAL', v_message);
      send_alert(
        'CRITICAL — OJVM PDB drift detected',
        v_message
      );
    END IF;

  EXCEPTION
    WHEN OTHERS THEN
      -- If this is a non-CDB, the CDB views may not exist
      log_result('PDB_DRIFT', 'INFO',
        'PDB drift check skipped (non-CDB or insufficient privileges): ' || SQLERRM);
  END;

  COMMIT;

EXCEPTION
  WHEN OTHERS THEN
    ROLLBACK;
    INSERT INTO ojvm_monitor_log (check_type, severity, message, detail)
    VALUES ('MONITOR_ERROR', 'CRITICAL',
            'OJVM_PATCH_MONITOR procedure failed with unhandled exception: ' || SQLERRM,
            DBMS_UTILITY.FORMAT_ERROR_BACKTRACE);
    COMMIT;
    RAISE;
END ojvm_patch_monitor;
/
\`\`\`

### Step 8.3: Schedule the monitor via DBMS_SCHEDULER

\`\`\`sql
-- Create a weekly scheduler job to run the OJVM monitor
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'OJVM_WEEKLY_MONITOR',
    job_type        => 'STORED_PROCEDURE',
    job_action      => 'OJVM_PATCH_MONITOR',
    start_date      => SYSTIMESTAMP,
    repeat_interval => 'FREQ=WEEKLY; BYDAY=MON; BYHOUR=6; BYMINUTE=0',
    end_date        => NULL,
    enabled         => TRUE,
    auto_drop       => FALSE,
    comments        => 'Weekly OJVM patch currency and security drift monitor'
  );
END;
/

-- Verify the job was created
SELECT job_name, job_type, state, last_start_date, next_run_date, enabled
FROM dba_scheduler_jobs
WHERE job_name = 'OJVM_WEEKLY_MONITOR';

-- Run the monitor immediately to test
BEGIN
  DBMS_SCHEDULER.RUN_JOB('OJVM_WEEKLY_MONITOR');
END;
/

-- Review the results
SELECT log_id,
       TO_CHAR(check_timestamp, 'YYYY-MM-DD HH24:MI:SS') AS check_time,
       check_type,
       severity,
       message
FROM ojvm_monitor_log
ORDER BY check_timestamp DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

---

## Phase 9: Shell-Based OJVM Audit Script (crontab Scheduled)

This phase provides a standalone shell script that performs the full OJVM audit without requiring a DBA to be logged in. It connects to the database via SQLPlus, runs every diagnostic query from Phase 0, writes a timestamped report to a log directory, and sends an email alert when issues are found. Schedule it in crontab to run nightly.

### 9.1 Create the Directory Structure

\`\`\`bash
# Run as the oracle OS user
mkdir -p /u01/app/oracle/scripts/ojvm_audit
mkdir -p /u01/app/oracle/scripts/ojvm_audit/logs
chmod 750 /u01/app/oracle/scripts/ojvm_audit
chmod 750 /u01/app/oracle/scripts/ojvm_audit/logs
\`\`\`

### 9.2 Credentials File (SQLPlus Wallet or .pgpass equivalent)

Store credentials outside the script. The script reads from a secured credentials file owned by oracle with mode 600.

\`\`\`bash
# /u01/app/oracle/scripts/ojvm_audit/.db_creds
# Format: SID:USER:PASSWORD
# Mode: chmod 600
BIREP:sys_audit_user:AuditPass123#
\`\`\`

Alternatively, use an Oracle Wallet so no plaintext password appears anywhere:

\`\`\`bash
# Create wallet entry for the audit user (run as oracle)
mkstore -wrl /u01/app/oracle/wallet -create
mkstore -wrl /u01/app/oracle/wallet -createCredential BIREP audit_user AuditPass123#

# sqlnet.ora must reference the wallet:
# WALLET_LOCATION=(SOURCE=(METHOD=FILE)(METHOD_DATA=(DIRECTORY=/u01/app/oracle/wallet)))
# SQLNET.WALLET_OVERRIDE=TRUE
\`\`\`

### 9.3 The Audit Shell Script

Save as \`/u01/app/oracle/scripts/ojvm_audit/ojvm_audit.sh\`, chmod 750:

\`\`\`bash
#!/bin/bash
# ojvm_audit.sh — OJVM security and patch currency audit
# Scheduled via crontab; emails DBA team when issues detected
# Run as: oracle OS user
# Dependencies: sqlplus in PATH, ORACLE_HOME set, ORACLE_SID set or passed as arg

# ── Configuration ─────────────────────────────────────────────────────────────
ORACLE_SID="\${1:-PRODDB}"
ORACLE_HOME="\${ORACLE_HOME:-/u01/app/oracle/product/19c/dbhome_1}"
AUDIT_USER="audit_user"
AUDIT_PASS="AuditPass123#"        # Replace with wallet /@\${ORACLE_SID} if using wallet
LOG_DIR="/u01/app/oracle/scripts/ojvm_audit/logs"
LOG_FILE="\${LOG_DIR}/ojvm_audit_\${ORACLE_SID}_\$(date +%Y%m%d_%H%M%S).log"
ALERT_EMAIL="dba-team@yourcompany.com"
PATCH_WARNING_DAYS=90             # Warn if last OJVM patch > 90 days ago
PATCH_CRITICAL_DAYS=180           # Critical if > 180 days ago
JAVA_OBJECT_THRESHOLD=0           # Alert if app schemas have > 0 Java objects post-disable
# ─────────────────────────────────────────────────────────────────────────────

export ORACLE_HOME ORACLE_SID
export PATH=\${ORACLE_HOME}/bin:\${PATH}
export LD_LIBRARY_PATH=\${ORACLE_HOME}/lib:\${LD_LIBRARY_PATH}

ISSUES=0
ISSUE_SUMMARY=""

log()   { echo "[\$(date '+%Y-%m-%d %H:%M:%S')] \$*" | tee -a "\${LOG_FILE}"; }
issue() { ISSUES=\$((ISSUES + 1)); ISSUE_SUMMARY="\${ISSUE_SUMMARY}\n  [\$1] \$2"; log "[ISSUE-\$1] \$2"; }
hr()    { echo "$(printf '%.0s-' {1..72})" | tee -a "\${LOG_FILE}"; }

mkdir -p "\${LOG_DIR}"
hr
log "OJVM Audit — SID: \${ORACLE_SID}"
hr

# ── SQLPlus connectivity check ────────────────────────────────────────────────
log "Testing SQLPlus connectivity..."
CONNECT_TEST=\$(sqlplus -s "\${AUDIT_USER}/\${AUDIT_PASS}@\${ORACLE_SID}" <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT 'CONNECTED' FROM dual;
EXIT
SQLEOF
)
if echo "\${CONNECT_TEST}" | grep -q "CONNECTED"; then
  log "SQLPlus connection: OK"
else
  issue "CRITICAL" "Cannot connect to \${ORACLE_SID} as \${AUDIT_USER} — check credentials and listener"
  echo -e "Subject: [OJVM AUDIT CRITICAL] Cannot connect to \${ORACLE_SID}\n\nSQLPlus connectivity failed.\n\nLog: \${LOG_FILE}" \
    | sendmail "\${ALERT_EMAIL}" 2>/dev/null || true
  exit 1
fi

# ── 1. OJVM component status ──────────────────────────────────────────────────
log ""
log "[1] OJVM Component Status"
JAVAVM_STATUS=\$(sqlplus -s "\${AUDIT_USER}/\${AUDIT_PASS}@\${ORACLE_SID}" <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMOUT ON
SELECT status FROM dba_registry WHERE comp_id = 'JAVAVM';
EXIT
SQLEOF
)
JAVAVM_STATUS=\$(echo "\${JAVAVM_STATUS}" | tr -d ' ')
log "  JAVAVM status: \${JAVAVM_STATUS}"
if [ "\${JAVAVM_STATUS}" != "VALID" ] && [ "\${JAVAVM_STATUS}" != "OPTION OFF" ]; then
  issue "HIGH" "JAVAVM component is \${JAVAVM_STATUS} — expected VALID or OPTION OFF"
fi

# ── 2. Java execution state ───────────────────────────────────────────────────
log ""
log "[2] Java Execution State"
JAVA_OPTION=\$(sqlplus -s "\${AUDIT_USER}/\${AUDIT_PASS}@\${ORACLE_SID}" <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMOUT ON
SELECT value FROM v\$option WHERE parameter = 'Java';
EXIT
SQLEOF
)
JAVA_OPTION=\$(echo "\${JAVA_OPTION}" | tr -d ' ')
log "  Java option: \${JAVA_OPTION}"
if [ "\${JAVA_OPTION}" = "TRUE" ]; then
  log "  [NOTE] Java execution is ENABLED — verify this is intentional"
elif [ "\${JAVA_OPTION}" = "FALSE" ]; then
  log "  [OK] Java execution is DISABLED via dbms_java_dev"
fi

# ── 3. OJVM patch currency ────────────────────────────────────────────────────
log ""
log "[3] OJVM Patch Currency"
PATCH_INFO=\$(sqlplus -s "\${AUDIT_USER}/\${AUDIT_PASS}@\${ORACLE_SID}" <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMOUT ON LINESIZE 200
SELECT TO_CHAR(MAX(action_time), 'YYYY-MM-DD') || '|' ||
       ROUND(SYSDATE - MAX(action_time)) || '|' ||
       MAX(description)
FROM   dba_registry_sqlpatch
WHERE  UPPER(description) LIKE '%OJVM%'
   AND status = 'SUCCESS';
EXIT
SQLEOF
)
LAST_PATCH_DATE=\$(echo "\${PATCH_INFO}" | cut -d'|' -f1 | tr -d ' ')
DAYS_SINCE=\$(echo "\${PATCH_INFO}" | cut -d'|' -f2 | tr -d ' ')
PATCH_DESC=\$(echo "\${PATCH_INFO}" | cut -d'|' -f3)

log "  Last OJVM patch: \${LAST_PATCH_DATE} (\${DAYS_SINCE} days ago)"
log "  Description: \${PATCH_DESC}"

if [ -n "\${DAYS_SINCE}" ] && [ "\${DAYS_SINCE}" -ge "\${PATCH_CRITICAL_DAYS}" ]; then
  issue "CRITICAL" "OJVM last patched \${DAYS_SINCE} days ago — 2+ CPU cycles missed"
elif [ -n "\${DAYS_SINCE}" ] && [ "\${DAYS_SINCE}" -ge "\${PATCH_WARNING_DAYS}" ]; then
  issue "WARNING" "OJVM last patched \${DAYS_SINCE} days ago — 1 CPU cycle missed"
elif [ -z "\${LAST_PATCH_DATE}" ]; then
  issue "HIGH" "No OJVM CPU patch found in dba_registry_sqlpatch — database may never have been OJVM-patched"
else
  log "  [OK] Patch currency within threshold (\${DAYS_SINCE} days)"
fi

# ── 4. Java objects in application schemas ────────────────────────────────────
log ""
log "[4] Java Objects in Application Schemas"
JAVA_OBJ_COUNT=\$(sqlplus -s "\${AUDIT_USER}/\${AUDIT_PASS}@\${ORACLE_SID}" <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMOUT ON
SELECT COUNT(*)
FROM   dba_objects
WHERE  object_type LIKE 'JAVA%'
  AND  owner NOT IN (
         'SYS','SYSTEM','OJVMSYS','XDB','MDSYS','CTXSYS','ORDSYS',
         'ORDDATA','WMSYS','EXFSYS','LBACSYS','DVSYS','APPQOSSYS',
         'DBSNMP','GSMADMIN_INTERNAL','OUTLN','REMOTE_SCHEDULER_AGENT'
       );
EXIT
SQLEOF
)
JAVA_OBJ_COUNT=\$(echo "\${JAVA_OBJ_COUNT}" | tr -d ' \n')
log "  Java objects in application schemas: \${JAVA_OBJ_COUNT}"
if [ "\${JAVA_OBJ_COUNT}" -gt "\${JAVA_OBJECT_THRESHOLD}" ]; then
  issue "WARNING" "\${JAVA_OBJ_COUNT} Java objects found in application schemas — review before disabling OJVM"
  # Dump the detail
  sqlplus -s "\${AUDIT_USER}/\${AUDIT_PASS}@\${ORACLE_SID}" >> "\${LOG_FILE}" <<'SQLEOF'
SET PAGESIZE 50 LINESIZE 120 FEEDBACK OFF
COLUMN owner FORMAT A20
COLUMN object_type FORMAT A20
COLUMN object_name FORMAT A40
SELECT owner, object_type, object_name, status
FROM   dba_objects
WHERE  object_type LIKE 'JAVA%'
  AND  owner NOT IN (
         'SYS','SYSTEM','OJVMSYS','XDB','MDSYS','CTXSYS','ORDSYS',
         'ORDDATA','WMSYS','EXFSYS','LBACSYS','DVSYS','APPQOSSYS',
         'DBSNMP','GSMADMIN_INTERNAL','OUTLN','REMOTE_SCHEDULER_AGENT'
       )
ORDER BY owner, object_type, object_name
FETCH FIRST 50 ROWS ONLY;
EXIT
SQLEOF
else
  log "  [OK] No Java objects in application schemas"
fi

# ── 5. Java stored procedures ─────────────────────────────────────────────────
log ""
log "[5] Java Stored Procedures"
JAVA_PROC_COUNT=\$(sqlplus -s "\${AUDIT_USER}/\${AUDIT_PASS}@\${ORACLE_SID}" <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMOUT ON
SELECT COUNT(*)
FROM   dba_procedures
WHERE  UPPER(object_type) IN ('FUNCTION','PROCEDURE','PACKAGE')
  AND  owner NOT IN ('SYS','SYSTEM','OJVMSYS','XDB','MDSYS','CTXSYS');
EXIT
SQLEOF
)
JAVA_PROC_COUNT=\$(echo "\${JAVA_PROC_COUNT}" | tr -d ' \n')
log "  Java-backed procedures/functions: \${JAVA_PROC_COUNT}"
[ "\${JAVA_PROC_COUNT}" -gt 0 ] && \
  issue "WARNING" "\${JAVA_PROC_COUNT} Java-backed PL/SQL objects found — OJVM required"

# ── 6. PDB drift check (CDB only) ─────────────────────────────────────────────
log ""
log "[6] PDB Drift Check"
IS_CDB=\$(sqlplus -s "\${AUDIT_USER}/\${AUDIT_PASS}@\${ORACLE_SID}" <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMOUT ON
SELECT cdb FROM v\$database;
EXIT
SQLEOF
)
IS_CDB=\$(echo "\${IS_CDB}" | tr -d ' ')
if [ "\${IS_CDB}" = "YES" ]; then
  log "  CDB detected — checking PDB OJVM status drift..."
  sqlplus -s "\${AUDIT_USER}/\${AUDIT_PASS}@\${ORACLE_SID}" >> "\${LOG_FILE}" <<'SQLEOF'
SET PAGESIZE 50 LINESIZE 120 FEEDBACK OFF
COLUMN con_name FORMAT A20
COLUMN status   FORMAT A15
COLUMN version  FORMAT A20
SELECT r.con_id,
       c.name   AS con_name,
       r.status,
       r.version_full AS version
FROM   cdb_registry r
JOIN   v\$containers c ON c.con_id = r.con_id
WHERE  r.comp_id = 'JAVAVM'
ORDER  BY r.con_id;
EXIT
SQLEOF

  DRIFT_COUNT=\$(sqlplus -s "\${AUDIT_USER}/\${AUDIT_PASS}@\${ORACLE_SID}" <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMOUT ON
SELECT COUNT(DISTINCT status)
FROM   cdb_registry
WHERE  comp_id = 'JAVAVM';
EXIT
SQLEOF
)
  DRIFT_COUNT=\$(echo "\${DRIFT_COUNT}" | tr -d ' \n')
  if [ "\${DRIFT_COUNT}" -gt 1 ]; then
    issue "HIGH" "PDB drift detected — JAVAVM status is not consistent across all containers"
  else
    log "  [OK] All containers have consistent JAVAVM status"
  fi
else
  log "  Non-CDB database — PDB drift check skipped"
fi

# ── 7. opatch: current OJVM patch from inventory ─────────────────────────────
log ""
log "[7] opatch Patch Inventory (OJVM)"
if [ -x "\${ORACLE_HOME}/OPatch/opatch" ]; then
  OPATCH_OUT=\$(\${ORACLE_HOME}/OPatch/opatch lspatches 2>/dev/null | grep -i "ojvm\|java vm" | head -5)
  if [ -n "\${OPATCH_OUT}" ]; then
    log "  Applied OJVM patches:"
    echo "\${OPATCH_OUT}" | while read -r line; do log "    \${line}"; done
  else
    log "  [NOTE] No OJVM-labelled patches found in opatch inventory"
  fi
else
  log "  [SKIP] opatch not found at \${ORACLE_HOME}/OPatch/opatch"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
hr
log ""
log "AUDIT COMPLETE — Issues Found: \${ISSUES}"
if [ "\${ISSUES}" -gt 0 ]; then
  log "Issue Summary:"
  echo -e "\${ISSUE_SUMMARY}" | tee -a "\${LOG_FILE}"
fi
hr
log "Full log: \${LOG_FILE}"

# ── Email alert ───────────────────────────────────────────────────────────────
if [ "\${ISSUES}" -gt 0 ]; then
  SUBJECT="[OJVM AUDIT] \${ORACLE_SID} — \${ISSUES} issue(s) found \$(date '+%Y-%m-%d')"
  BODY="OJVM Audit Report for \${ORACLE_SID}\nDate: \$(date)\nIssues: \${ISSUES}\n"
  BODY="\${BODY}\nSummary:\n\$(echo -e "\${ISSUE_SUMMARY}")"
  BODY="\${BODY}\n\nFull log: \${LOG_FILE}"
  BODY="\${BODY}\n\n--- Log Tail ---\n\$(tail -40 "\${LOG_FILE}")"
  echo -e "Subject: \${SUBJECT}\n\n\${BODY}" | sendmail "\${ALERT_EMAIL}" 2>/dev/null || \
    mailx -s "\${SUBJECT}" "\${ALERT_EMAIL}" < "\${LOG_FILE}" 2>/dev/null || \
    echo "WARNING: Could not send alert email — check sendmail/mailx configuration"
fi

# Purge logs older than 30 days
find "\${LOG_DIR}" -name "ojvm_audit_*.log" -mtime +30 -delete 2>/dev/null

exit \${ISSUES}
\`\`\`

### 9.4 Make Executable and Test

\`\`\`bash
chmod 750 /u01/app/oracle/scripts/ojvm_audit/ojvm_audit.sh

# Test run — pass the SID as the first argument
/u01/app/oracle/scripts/ojvm_audit/ojvm_audit.sh PRODDB

# Check exit code: 0 = no issues, >0 = number of issues found
echo "Exit code: $?"

# Review the log
ls -lt /u01/app/oracle/scripts/ojvm_audit/logs/ | head -5
cat /u01/app/oracle/scripts/ojvm_audit/logs/ojvm_audit_PRODDB_*.log | tail -30
\`\`\`

### 9.5 Schedule via crontab

Add to the oracle OS user's crontab (\`crontab -e\` as oracle):

\`\`\`bash
# crontab -e (oracle user)
#
# OJVM Audit — runs nightly at 01:30, logs to /u01/app/oracle/scripts/ojvm_audit/logs
# The script emails the DBA team if issues are found; exit code = number of issues.
#
# ┌─────────── minute  (0-59)
# │  ┌────────── hour    (0-23)
# │  │  ┌───────── day-of-month (1-31)
# │  │  │  ┌──────── month (1-12)
# │  │  │  │  ┌─────── day-of-week (0-7, 0=Sun)
# │  │  │  │  │
# m  h  dom mon dow   command
  30  1  *   *   *    /u01/app/oracle/scripts/ojvm_audit/ojvm_audit.sh PRODDB >> /u01/app/oracle/scripts/ojvm_audit/logs/cron_ojvm.log 2>&1

# If running multiple databases on the same host, add one line per SID:
  35  1  *   *   *    /u01/app/oracle/scripts/ojvm_audit/ojvm_audit.sh STANDBY >> /u01/app/oracle/scripts/ojvm_audit/logs/cron_ojvm.log 2>&1
  40  1  *   *   *    /u01/app/oracle/scripts/ojvm_audit/ojvm_audit.sh DEVDB   >> /u01/app/oracle/scripts/ojvm_audit/logs/cron_ojvm.log 2>&1
\`\`\`

Verify crontab is active:

\`\`\`bash
crontab -l | grep ojvm_audit

# Confirm the cron daemon is running
systemctl status crond   # RHEL/OL
# or
systemctl status cron    # Debian/Ubuntu

# After the scheduled window, verify a log was created
ls -lt /u01/app/oracle/scripts/ojvm_audit/logs/ | head -3
\`\`\`

### 9.6 Exit Code Integration

The script returns the number of issues found as its exit code. This integrates cleanly with external monitoring tools:

\`\`\`bash
# Nagios / Icinga plugin wrapper
/u01/app/oracle/scripts/ojvm_audit/ojvm_audit.sh PRODDB
RC=$?
if   [ "\${RC}" -eq 0 ];   then echo "OK — OJVM audit clean";       exit 0
elif [ "\${RC}" -le 2 ];   then echo "WARNING — \${RC} issue(s)";   exit 1
else                              echo "CRITICAL — \${RC} issue(s)"; exit 2
fi
\`\`\`

---

### Key SQL: OJVM Status Checks

\`\`\`sql
-- 1. Is OJVM present and valid?
SELECT comp_id, status, version_full FROM dba_registry WHERE comp_id = 'JAVAVM';

-- 2. Is Java execution enabled or disabled?
SELECT parameter, value FROM v\$option WHERE parameter = 'Java';

-- 3. When was the last OJVM CPU patch applied?
SELECT patch_id, status, action_time, description
FROM dba_registry_sqlpatch
WHERE UPPER(description) LIKE '%OJVM%'
ORDER BY action_time DESC FETCH FIRST 3 ROWS ONLY;

-- 4. Are there Java objects in application schemas?
SELECT object_type, owner, COUNT(*) FROM dba_objects
WHERE object_type LIKE 'JAVA%'
  AND owner NOT IN ('SYS','SYSTEM','OJVMSYS','XDB','MDSYS','CTXSYS','ORDSYS','ORDDATA','WMSYS','EXFSYS','LBACSYS','DVSYS')
GROUP BY object_type, owner ORDER BY owner, object_type;

-- 5. CDB: Check all containers for Java status
SELECT c.name, o.parameter, o.value FROM v\$containers c
JOIN cdb_options o ON o.con_id = c.con_id
WHERE o.parameter = 'Java' ORDER BY c.name;
\`\`\`

### Disable/Enable Sequence

\`\`\`sql
-- Non-CDB DISABLE:
EXEC DBMS_JAVA_DEV.DISABLE;

-- Non-CDB ENABLE (required before patching):
EXEC DBMS_JAVA_DEV.ENABLE;

-- CDB DISABLE: Run Phase 4 (Steps 4.1 - 4.3)
-- CDB ENABLE:  Run Phase 5 (Steps 5.2 - 5.3)
\`\`\`

### opatch Reference

\`\`\`bash
# List all patches (filter for Java)
\$ORACLE_HOME/OPatch/opatch lspatches | grep -i java

# Full patch inventory
\$ORACLE_HOME/OPatch/opatch lsinventory

# Check prerequisites before applying a patch
\$ORACLE_HOME/OPatch/opatch prereq CheckConflictAgainstOHWithDetail -ph /tmp/patches/PATCH_ID

# Apply a patch (DB must be shut down)
\$ORACLE_HOME/OPatch/opatch apply /tmp/patches/PATCH_ID

# Run datapatch after opatch (DB must be open, OJVM must be enabled)
\$ORACLE_HOME/OPatch/datapatch -verbose
\`\`\``,
};

async function main() {
  console.log('Inserting Oracle OJVM disable and patching runbook post...');
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
  console.log(`Inserted: "${post.title}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
