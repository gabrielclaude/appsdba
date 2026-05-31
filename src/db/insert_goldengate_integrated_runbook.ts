import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Implementing Oracle GoldenGate with Integrated Capture',
  slug: 'goldengate-integrated-capture-implementation-runbook',
  excerpt:
    'End-to-end operational runbook for deploying Oracle GoldenGate unidirectional replication using Integrated Capture — covering logmining server prerequisites, OGG user privilege setup, REGISTER EXTRACT, LOGALLSUPCOLS, Data Pump, Replicat, SCN-based instantiation, process startup, and post-build verification. Includes CDB/PDB considerations.',
  category: 'golden-gate' as const,
  published: true,
  publishedAt: new Date('2026-05-31'),
  youtubeUrl: null,
  content: `## Purpose

Deploy an Oracle GoldenGate Integrated Capture pipeline that leverages the Oracle Database **logmining server** to deliver Logical Change Records (LCRs) to the Extract process, providing superior performance, broader data type support, and automatic supplemental logging management compared to Classic Capture.

---

## Scope and Assumptions

- Oracle GoldenGate 19c Classic Architecture (non-Microservices)
- Oracle Database 19c on source; Oracle Database 12.2+ on target
- Unidirectional replication: source to target only
- Source is a non-CDB (single-tenant) database — CDB/PDB notes are called out where the steps differ
- OGG software extracted and \`CREATE SUBDIRS\` already run in GGSCI on both hosts
- Supplemental logging will be managed entirely by GoldenGate via \`LOGALLSUPCOLS\` — no manual \`ALTER TABLE ADD SUPPLEMENTAL LOG\` statements required

---

## Key Differences from Classic Capture

Integrated Capture introduces three steps that Classic Capture does not have:

- **\`REGISTER EXTRACT\`** — registers the Extract as a logmining client with the database. Oracle uses this registration to retain redo logs until the Extract has consumed them.
- **\`LOGALLSUPCOLS\`** in the Extract parameter file — instructs OGG to automatically enable ALL COLUMNS supplemental logging on every table in scope via the logmining server, eliminating per-table DDL.
- **Logmining server privileges** — the OGG database user needs the \`DBA\` role or a carefully crafted set of logmining-specific grants (detailed in Step 2).

---

## Reference Variables

\`\`\`
OGG_HOME (source)       = /u01/app/oracle/product/ogg19
OGG_HOME (target)       = /u01/app/oracle/product/ogg19
ORACLE_HOME (source)    = /u01/app/oracle/product/19.0.0/dbhome_1
SOURCE_ORACLE_SID       = SRCDB
TARGET_ORACLE_SID       = TGTDB
SOURCE_TNS_ALIAS        = SRCDB
TARGET_TNS_ALIAS        = TGTDB
SOURCE_HOST             = ogg-source.example.com
TARGET_HOST             = ogg-target.example.com
OGG_COLLECTOR_PORT      = 7809
TRAIL_PREFIX (source)   = ./dirdat/li
TRAIL_PREFIX (target)   = ./dirdat/ri
SCHEMAS_TO_REPLICATE    = HR, OE
OGG_DB_USER (source)    = ggadmin
OGG_DB_USER (target)    = ggadmin
\`\`\`

Trail prefixes use \`li\` / \`ri\` (i for integrated) to distinguish from Classic Capture trails should both modes ever coexist on the same OGG home.

---

## Pre-Flight Checks

### 1. Confirm Oracle version supports Integrated Capture

\`\`\`sql
-- On source as SYSDBA
SELECT VERSION FROM V$INSTANCE;
\`\`\`

Integrated Capture requires Oracle Database 11.2.0.4 minimum. For full feature support including SecureFile LOBs and XMLType binary XML, 12.1.0.2 or later is strongly recommended.

### 2. Confirm ARCHIVELOG mode and FORCE LOGGING

\`\`\`sql
SELECT LOG_MODE, FORCE_LOGGING FROM V$DATABASE;
\`\`\`

If not set:

\`\`\`sql
-- Enable ARCHIVELOG
SHUTDOWN IMMEDIATE;
STARTUP MOUNT;
ALTER DATABASE ARCHIVELOG;
ALTER DATABASE OPEN;

-- Enable FORCE LOGGING
ALTER DATABASE FORCE LOGGING;
\`\`\`

### 3. Confirm the logmining server package is available

\`\`\`sql
SELECT OBJECT_NAME, STATUS FROM DBA_OBJECTS
WHERE OBJECT_NAME = 'DBMS_LOGMNR'
  AND OBJECT_TYPE = 'PACKAGE';
\`\`\`

**Expected:** One row with \`STATUS = VALID\`.

### 4. Confirm ENABLE_GOLDENGATE_REPLICATION is set

\`\`\`sql
SHOW PARAMETER ENABLE_GOLDENGATE_REPLICATION;
\`\`\`

If \`VALUE = FALSE\`, enable it:

\`\`\`sql
ALTER SYSTEM SET ENABLE_GOLDENGATE_REPLICATION = TRUE SCOPE=BOTH;
\`\`\`

This parameter activates the logmining server hooks that Integrated Capture depends on.

### 5. Verify OGG subdirectories exist on both hosts

\`\`\`
GGSCI> INFO ALL
\`\`\`

Manager should already be running per the pre-deployment checklist. If not, confirm \`dirdat\`, \`dirprm\`, \`dirrpt\`, \`dirchk\`, and \`dirtmp\` exist under \`$OGG_HOME\`.

### 6. Test TNS connectivity

\`\`\`bash
# From source host
tnsping TGTDB

# From target host
tnsping SRCDB
\`\`\`

---

## Step 1 — Enable Minimal Supplemental Logging at Database Level

Integrated Capture requires minimal supplemental logging at the database level. \`LOGALLSUPCOLS\` in the Extract parameter file then manages per-table ALL COLUMNS supplemental logging automatically — no per-table DDL is needed.

\`\`\`sql
-- On source as SYSDBA
ALTER DATABASE ADD SUPPLEMENTAL LOG DATA;

-- Verify
SELECT SUPPLEMENTAL_LOG_DATA_MIN FROM V$DATABASE;
-- Expected: YES
\`\`\`

---

## Step 2 — Create the OGG Database User on Source

Integrated Capture requires logmining server privileges in addition to the standard OGG grants.

### Option A — Grant the DBA role (simplest, suitable for most environments)

\`\`\`sql
-- On source as SYSDBA
CREATE USER ggadmin IDENTIFIED BY "GGAdmin#2026"
  DEFAULT TABLESPACE users
  TEMPORARY TABLESPACE temp;

GRANT DBA TO ggadmin;
\`\`\`

### Option B — Least-privilege grant set (recommended for hardened environments)

\`\`\`sql
CREATE USER ggadmin IDENTIFIED BY "GGAdmin#2026"
  DEFAULT TABLESPACE users
  TEMPORARY TABLESPACE temp;

-- Standard OGG session grants
GRANT CREATE SESSION          TO ggadmin;
GRANT ALTER SESSION           TO ggadmin;
GRANT SELECT ANY DICTIONARY   TO ggadmin;
GRANT SELECT ANY TABLE        TO ggadmin;
GRANT FLASHBACK ANY TABLE     TO ggadmin;
GRANT SELECT ON V_$DATABASE   TO ggadmin;
GRANT SELECT ON V_$LOG        TO ggadmin;
GRANT SELECT ON V_$LOGFILE    TO ggadmin;
GRANT SELECT ON V_$ARCHIVED_LOG TO ggadmin;
GRANT SELECT ON V_$INSTANCE   TO ggadmin;
GRANT EXECUTE ON DBMS_FLASHBACK TO ggadmin;

-- Integrated Capture logmining server grants
GRANT EXECUTE ON DBMS_LOGMNR           TO ggadmin;
GRANT EXECUTE ON DBMS_LOGMNR_D         TO ggadmin;
GRANT SELECT ON V_$LOGMNR_LOGS         TO ggadmin;
GRANT SELECT ON V_$LOGMNR_CONTENTS     TO ggadmin;
GRANT SELECT ON V_$LOGMNR_PARAMETERS   TO ggadmin;
GRANT SELECT ON DBA_OBJECTS            TO ggadmin;
GRANT SELECT ON DBA_TABLES             TO ggadmin;
GRANT SELECT ON DBA_COLUMNS            TO ggadmin;
GRANT SELECT ON DBA_LOG_GROUPS         TO ggadmin;
GRANT SELECT ON DBA_LOG_GROUP_COLUMNS  TO ggadmin;

-- Required for logmining server to manage supplemental logging (LOGALLSUPCOLS)
GRANT ALTER ANY TABLE TO ggadmin;
\`\`\`

### CDB/PDB note

If the source is a CDB and you are capturing from a specific PDB:

\`\`\`sql
-- Connect to root (CDB$ROOT) and create a common user
CREATE USER c##ggadmin IDENTIFIED BY "GGAdmin#2026" CONTAINER=ALL;
GRANT DBA TO c##ggadmin CONTAINER=ALL;
GRANT SET CONTAINER TO c##ggadmin CONTAINER=ALL;
GRANT SELECT ANY DICTIONARY TO c##ggadmin CONTAINER=ALL;
ALTER USER c##ggadmin SET CONTAINER_DATA=ALL CONTAINER=CURRENT;
\`\`\`

The Extract \`USERID\` parameter must then reference the CDB root: \`USERID c##ggadmin@CDB_TNS_ALIAS\`.

---

## Step 3 — Create the OGG Database User on Target

\`\`\`sql
-- On target as SYSDBA
CREATE USER ggadmin IDENTIFIED BY "GGAdmin#2026"
  DEFAULT TABLESPACE users
  TEMPORARY TABLESPACE temp;

GRANT CREATE SESSION              TO ggadmin;
GRANT ALTER SESSION               TO ggadmin;
GRANT RESOURCE                    TO ggadmin;
GRANT SELECT ANY DICTIONARY       TO ggadmin;
GRANT INSERT, UPDATE, DELETE ON hr.employees   TO ggadmin;
GRANT INSERT, UPDATE, DELETE ON hr.departments TO ggadmin;
GRANT INSERT, UPDATE, DELETE ON oe.orders      TO ggadmin;
GRANT INSERT, UPDATE, DELETE ON oe.order_items TO ggadmin;
\`\`\`

---

## Step 4 — Configure the Manager Process

### Source Manager — \`$OGG_HOME/dirprm/mgr.prm\`

\`\`\`
PORT 7809
DYNAMICPORTLIST 7810-7820
AUTORESTART EXTRACT *, RETRIES 5, WAITMINUTES 2
PURGEOLDEXTRACTS ./dirdat/li*, USECHECKPOINTS, MINKEEPDAYS 3
LAGREPORTHOURS 1
LAGINFOMINUTES 30
LAGCRITICALMINUTES 60
\`\`\`

### Target Manager — \`$OGG_HOME/dirprm/mgr.prm\`

\`\`\`
PORT 7809
DYNAMICPORTLIST 7810-7820
AUTORESTART REPLICAT *, RETRIES 5, WAITMINUTES 2
PURGEOLDEXTRACTS ./dirdat/ri*, USECHECKPOINTS, MINKEEPDAYS 3
LAGREPORTHOURS 1
LAGINFOMINUTES 30
LAGCRITICALMINUTES 60
\`\`\`

### Start Manager on both hosts

\`\`\`
GGSCI> START MANAGER
GGSCI> INFO MANAGER
\`\`\`

---

## Step 5 — Configure the Integrated Extract

### 5a. Add the Integrated Extract group

\`\`\`
-- On source GGSCI
DBLOGIN USERID ggadmin@SRCDB PASSWORD "GGAdmin#2026"

ADD EXTRACT ext_int, INTEGRATED TRANLOG, BEGIN NOW
ADD EXTTRAIL ./dirdat/li, EXTRACT ext_int, MEGABYTES 500
\`\`\`

Note the keyword \`INTEGRATED\` before \`TRANLOG\`. This is what distinguishes an Integrated Extract from a Classic Extract at the process level.

### 5b. Register the Extract with the database

\`\`\`
GGSCI> REGISTER EXTRACT ext_int DATABASE
\`\`\`

**This step is mandatory.** \`REGISTER EXTRACT\` creates an entry in the Oracle logmining server so that:

- Oracle retains redo logs until the Extract has consumed them (prevents ORA-01291 missing archive log errors)
- The logmining server tracks the Extract's read SCN and delivers LCRs from that point forward

Verify the registration:

\`\`\`sql
-- On source as SYSDBA
SELECT CAPTURE_NAME, STATUS, CAPTURED_SCN, APPLIED_SCN, ERROR_MESSAGE
FROM DBA_CAPTURE
WHERE CAPTURE_NAME LIKE 'OGG%';
\`\`\`

**Expected:** One row per registered Extract with \`STATUS = ENABLED\` or \`INACTIVE\` (INACTIVE is normal before the Extract starts).

### 5c. Create the Extract parameter file

Create \`$OGG_HOME/dirprm/ext_int.prm\`:

\`\`\`
EXTRACT ext_int
USERID ggadmin@SRCDB, PASSWORD "GGAdmin#2026"
EXTTRAIL ./dirdat/li

-- Integrated Capture mode: receive LCRs from logmining server
-- TRANLOGOPTIONS INTEGRATEDPARAMS passes tuning values directly to the
-- logmining server; values below are conservative production defaults
TRANLOGOPTIONS INTEGRATEDPARAMS (MAX_SGA_SIZE 512, PARALLELISM 2)

-- Automatically enable ALL COLUMNS supplemental logging on all
-- tables in scope. No manual ALTER TABLE ADD SUPPLEMENTAL LOG needed.
LOGALLSUPCOLS

-- Include before-image values for UPDATE operations
-- (required for bidirectional CDR; safe to include for unidirectional)
UPDATERECORDFORMAT FULL

DISCARDFILE ./dirrpt/ext_int.dsc, APPEND, MEGABYTES 100

TABLE hr.employees;
TABLE hr.departments;
TABLE oe.orders;
TABLE oe.order_items;
\`\`\`

**TRANLOGOPTIONS INTEGRATEDPARAMS tuning reference:**

- \`MAX_SGA_SIZE\` — MB of SGA the logmining server may use for LCR buffering. Increase for high-volume sources; default is 1024 MB.
- \`PARALLELISM\` — number of parallel logmining reader threads. Increase to 4–8 on high-core systems with large redo volume.

---

## Step 6 — Configure the Data Pump Extract

The Data Pump reads the local trail and forwards records to the target over the network. Its configuration is identical to Classic Capture.

### 6a. Add the Data Pump group

\`\`\`
-- On source GGSCI
ADD EXTRACT dpump_int, EXTTRAILSOURCE ./dirdat/li
ADD RMTTRAIL ./dirdat/ri, EXTRACT dpump_int, MEGABYTES 500
\`\`\`

### 6b. Create the Data Pump parameter file

Create \`$OGG_HOME/dirprm/dpump_int.prm\`:

\`\`\`
EXTRACT dpump_int
USERID ggadmin@SRCDB, PASSWORD "GGAdmin#2026"
RMTHOST ogg-target.example.com, MGRPORT 7809, COMPRESS
RMTTRAIL ./dirdat/ri

PASSTHRU
TABLE hr.*;
TABLE oe.*;
\`\`\`

---

## Step 7 — Perform the Initial Load (Instantiation)

### 7a. Record the source SCN before export

\`\`\`sql
-- On source as SYSDBA
SELECT CURRENT_SCN FROM V$DATABASE;
-- Note this value: e.g. 7341204
\`\`\`

### 7b. Export source schemas with Data Pump

\`\`\`bash
expdp userid=system/password@SRCDB \
  schemas=HR,OE \
  flashback_scn=7341204 \
  directory=DATA_PUMP_DIR \
  dumpfile=ogg_int_initial_%U.dmp \
  logfile=ogg_int_initial_exp.log \
  parallel=4
\`\`\`

### 7c. Transfer dump files to target

\`\`\`bash
scp /u01/app/oracle/admin/SRCDB/dpdump/ogg_int_initial_*.dmp \
    oracle@ogg-target.example.com:/u01/app/oracle/admin/TGTDB/dpdump/
\`\`\`

### 7d. Import into target

\`\`\`bash
impdp userid=system/password@TGTDB \
  schemas=HR,OE \
  directory=DATA_PUMP_DIR \
  dumpfile=ogg_int_initial_%U.dmp \
  logfile=ogg_int_initial_imp.log \
  table_exists_action=REPLACE \
  parallel=4
\`\`\`

### 7e. Advance the Extract start position to the instantiation SCN

\`\`\`
-- On source GGSCI
DBLOGIN USERID ggadmin@SRCDB PASSWORD "GGAdmin#2026"
ALTER EXTRACT ext_int, SCN 7341204
\`\`\`

This sets the logmining server's starting SCN so that the Extract begins delivering changes from exactly the point-in-time of the export snapshot.

### 7f. Verify LOGALLSUPCOLS has been applied

After the Extract is registered and the SCN is set, confirm supplemental logging was applied automatically:

\`\`\`sql
SELECT OWNER, TABLE_NAME, LOG_GROUP_TYPE
FROM DBA_LOG_GROUPS
WHERE OWNER IN ('HR','OE')
ORDER BY OWNER, TABLE_NAME;
\`\`\`

Each table in scope should have an \`ALL COLUMNS\` log group entry. If any are missing, they will be added when the Extract starts.

---

## Step 8 — Configure the Replicat

### 8a. Create the checkpoint table on target

\`\`\`
-- Target GGSCI
DBLOGIN USERID ggadmin@TGTDB PASSWORD "GGAdmin#2026"
ADD CHECKPOINTTABLE ggadmin.chkptab
\`\`\`

### 8b. Add the Replicat group

\`\`\`
ADD REPLICAT rep_int, EXTTRAIL ./dirdat/ri, CHECKPOINTTABLE ggadmin.chkptab
\`\`\`

### 8c. Create the Replicat parameter file

Create \`$OGG_HOME/dirprm/rep_int.prm\`:

\`\`\`
REPLICAT rep_int
TARGETDB TGTDB, USERID ggadmin, PASSWORD "GGAdmin#2026"
ASSUMETARGETDEFS

HANDLECOLLISIONS

DISCARDFILE ./dirrpt/rep_int.dsc, APPEND, MEGABYTES 100

REPERROR (DEFAULT, ABEND)
REPERROR (1403, DISCARD)
REPERROR (1,    DISCARD)

MAP hr.employees,   TARGET hr.employees;
MAP hr.departments, TARGET hr.departments;
MAP oe.orders,      TARGET oe.orders;
MAP oe.order_items, TARGET oe.order_items;
\`\`\`

---

## Step 9 — Start All Processes in Order

### 9a. Start the Integrated Extract

\`\`\`
-- Source GGSCI
START EXTRACT ext_int
INFO EXTRACT ext_int
\`\`\`

**Expected:** \`EXTRACT EXT_INT Running\`

Confirm the logmining server is now active:

\`\`\`sql
-- On source as SYSDBA
SELECT CAPTURE_NAME, STATUS, CAPTURED_SCN, APPLIED_SCN
FROM DBA_CAPTURE
WHERE CAPTURE_NAME LIKE 'OGG%';
\`\`\`

**Expected:** \`STATUS = ENABLED\` and \`CAPTURED_SCN\` advancing.

### 9b. Start the Data Pump

\`\`\`
-- Source GGSCI
START EXTRACT dpump_int
INFO EXTRACT dpump_int
\`\`\`

Wait 30 seconds and confirm target trail files exist:

\`\`\`bash
ls -lh $OGG_HOME/dirdat/ri*
\`\`\`

### 9c. Start the Replicat

\`\`\`
-- Target GGSCI
START REPLICAT rep_int
INFO REPLICAT rep_int
\`\`\`

**Expected:** \`REPLICAT REP_INT Running\`

---

## Step 10 — Post-Start Verification

### 10a. Check all process statuses

\`\`\`
-- Source GGSCI
INFO ALL

-- Target GGSCI
INFO ALL
\`\`\`

### 10b. Verify the logmining server is delivering LCRs

\`\`\`
GGSCI> INFO EXTRACT ext_int, DETAIL
\`\`\`

Confirm \`Log Read Checkpoint\` shows a current SCN advancing from the instantiation SCN. Also look for the \`Integrated Mode\` label in the detail output confirming the Extract is operating in integrated mode.

### 10c. Check lag on all processes

\`\`\`
-- Source GGSCI
LAG EXTRACT ext_int
LAG EXTRACT dpump_int

-- Target GGSCI
LAG REPLICAT rep_int
\`\`\`

Lag should approach zero within a few minutes as the overlap window backlog is consumed.

### 10d. Functional smoke test

\`\`\`sql
-- On source
INSERT INTO hr.employees (employee_id, first_name, last_name, email,
  hire_date, job_id, salary)
VALUES (999, 'Test', 'User', 'TUSER',
  SYSDATE, 'IT_PROG', 50000);
COMMIT;

-- Wait 5–10 seconds, then on target
SELECT employee_id, first_name, last_name, salary
FROM hr.employees
WHERE employee_id = 999;
\`\`\`

Then clean up:

\`\`\`sql
-- Source
DELETE FROM hr.employees WHERE employee_id = 999;
COMMIT;
\`\`\`

### 10e. Remove HANDLECOLLISIONS once lag is zero

\`\`\`
-- Target GGSCI
SEND REPLICAT rep_int, NOHANDLECOLLISIONS
\`\`\`

Remove or comment out \`HANDLECOLLISIONS\` in \`dirprm/rep_int.prm\` to prevent silent error suppression after the overlap window closes.

---

## Step 11 — Ongoing Monitoring

### Process and lag status

\`\`\`
GGSCI> INFO ALL
GGSCI> LAG EXTRACT ext_int
GGSCI> LAG REPLICAT rep_int
\`\`\`

### Extract and Replicat statistics

\`\`\`
GGSCI> STATS EXTRACT ext_int, TOTAL
GGSCI> STATS REPLICAT rep_int, TOTAL
GGSCI> STATS REPLICAT rep_int, TABLE hr.employees, TOTAL
\`\`\`

### Logmining server health from the database

\`\`\`sql
SELECT CAPTURE_NAME, STATUS, CAPTURED_SCN, APPLIED_SCN,
       TOTAL_MESSAGES_CAPTURED, TOTAL_MESSAGES_ENQUEUED,
       ERROR_MESSAGE
FROM DBA_CAPTURE
WHERE CAPTURE_NAME LIKE 'OGG%';
\`\`\`

### SGA usage by the logmining server

\`\`\`sql
SELECT COMPONENT, CURRENT_SIZE/1024/1024 AS CURRENT_MB,
       MAX_SIZE/1024/1024 AS MAX_MB
FROM V$SGA_DYNAMIC_COMPONENTS
WHERE COMPONENT = 'shared pool';
\`\`\`

Monitor shared pool usage after Integrated Capture starts. If the logmining server is competing for shared pool memory, increase \`MAX_SGA_SIZE\` in \`TRANLOGOPTIONS INTEGRATEDPARAMS\` or increase the \`SGA_TARGET\` / \`SHARED_POOL_SIZE\` parameter on the source.

### Discard file for silently skipped Replicat rows

\`\`\`bash
tail -100 $OGG_HOME/dirrpt/rep_int.dsc
\`\`\`

---

## Troubleshooting

### ORA-04031 — logmining server out of shared pool memory

\`\`\`sql
-- Check shared pool free memory
SELECT POOL, BYTES/1024/1024 AS MB FROM V$SGASTAT
WHERE POOL = 'shared pool' AND NAME = 'free memory';
\`\`\`

Increase the logmining server allocation in the Extract parameter file, then restart:

\`\`\`
TRANLOGOPTIONS INTEGRATEDPARAMS (MAX_SGA_SIZE 1024, PARALLELISM 2)
\`\`\`

If shared pool is genuinely exhausted, increase \`SGA_TARGET\` on the source:

\`\`\`sql
ALTER SYSTEM SET SGA_TARGET=8G SCOPE=BOTH;
\`\`\`

### DBA_CAPTURE shows STATUS = ABORTED

\`\`\`sql
SELECT CAPTURE_NAME, STATUS, ERROR_NUMBER, ERROR_MESSAGE
FROM DBA_CAPTURE
WHERE CAPTURE_NAME LIKE 'OGG%';
\`\`\`

Common causes and fixes:

- **ORA-01291 (missing archive log)** — redo log needed by logmining server was purged before the Extract consumed it. Restore the missing archive from RMAN backup and restart the Extract. Increase RMAN archive retention policy to cover at least 2x the expected Extract lag.
- **ORA-26714 (user error during apply)** — a table structure mismatch between source and logmining metadata. Run \`DBMS_CAPTURE_ADM.PREPARE_TABLE_INSTANTIATION\` for affected tables.
- **ORA-01403 (no rows found)** — logmining server cannot find dictionary metadata for a table. Ensure \`SELECT ANY DICTIONARY\` is granted and consider issuing \`DBMS_LOGMNR_D.BUILD\` to refresh the online catalog.

### Extract runs but CAPTURED_SCN is not advancing

\`\`\`
GGSCI> INFO EXTRACT ext_int, DETAIL
\`\`\`

If the log read checkpoint SCN is frozen:

\`\`\`sql
-- Check whether the logmining server process is alive
SELECT SID, SERIAL#, STATUS, PROGRAM FROM V$SESSION
WHERE PROGRAM LIKE '%logminer%' OR PROGRAM LIKE '%CAPTURE%';
\`\`\`

If no logminer sessions exist, the logmining server silently died. Check the database alert log:

\`\`\`bash
tail -200 $ORACLE_BASE/diag/rdbms/srcdb/SRCDB/trace/alert_SRCDB.log \
  | grep -i 'OGG\|capture\|logminer\|ORA-'
\`\`\`

Restart the Extract — Manager's AUTORESTART will normally recover it.

### REGISTER EXTRACT fails with ORA-26744

\`\`\`
ORA-26744: name "OGG$EXT_INT" is already used by an existing apply/capture/propagation
\`\`\`

A prior Extract with the same name left a stale logmining registration. Clean it up:

\`\`\`
GGSCI> DBLOGIN USERID ggadmin@SRCDB PASSWORD "GGAdmin#2026"
GGSCI> UNREGISTER EXTRACT ext_int DATABASE
GGSCI> REGISTER EXTRACT ext_int DATABASE
\`\`\`

### Replicat abends with ORA-00001 or ORA-01403

Same resolution as Classic Capture: enable \`HANDLECOLLISIONS\`, identify the affected table from the discard file, re-run the initial load for that table only, then remove \`HANDLECOLLISIONS\` when lag reaches zero.

### LOGALLSUPCOLS did not add supplemental logging on a new table

If a new table is added to the Extract scope after the initial \`REGISTER EXTRACT\`, supplemental logging is not automatically retroactively applied. Issue:

\`\`\`
GGSCI> ADD TRANDATA hr.new_table, ALLCOLS
\`\`\`

Or at the SQL level:

\`\`\`sql
ALTER TABLE hr.new_table ADD SUPPLEMENTAL LOG DATA (ALL) COLUMNS;
\`\`\`

---

## Rollback

### Stop and deregister all OGG processes

\`\`\`
-- Source GGSCI
DBLOGIN USERID ggadmin@SRCDB PASSWORD "GGAdmin#2026"

STOP EXTRACT ext_int
STOP EXTRACT dpump_int

-- Deregister the Extract from the logmining server BEFORE deleting it
UNREGISTER EXTRACT ext_int DATABASE

DELETE EXTRACT ext_int
DELETE EXTRACT dpump_int
DELETE EXTTRAIL ./dirdat/li*
\`\`\`

**\`UNREGISTER EXTRACT\` must be run before \`DELETE EXTRACT\`** when using Integrated Capture. Skipping this step leaves a stale logmining server registration in \`DBA_CAPTURE\` that will prevent a new Extract of the same name from registering later.

\`\`\`
-- Target GGSCI
STOP REPLICAT rep_int
DELETE REPLICAT rep_int
DELETE RMTTRAIL ./dirdat/ri*
\`\`\`

### Verify logmining registration is removed

\`\`\`sql
SELECT COUNT(*) FROM DBA_CAPTURE WHERE CAPTURE_NAME LIKE 'OGG%';
-- Expected: 0
\`\`\`

### Remove supplemental logging from source tables

\`\`\`sql
-- On source as SYSDBA
-- Remove ALL COLUMNS log groups added by LOGALLSUPCOLS
ALTER TABLE hr.employees    DROP SUPPLEMENTAL LOG DATA (ALL) COLUMNS;
ALTER TABLE hr.departments  DROP SUPPLEMENTAL LOG DATA (ALL) COLUMNS;
ALTER TABLE oe.orders       DROP SUPPLEMENTAL LOG DATA (ALL) COLUMNS;
ALTER TABLE oe.order_items  DROP SUPPLEMENTAL LOG DATA (ALL) COLUMNS;

-- Remove database-level minimal supplemental logging if no longer needed
ALTER DATABASE DROP SUPPLEMENTAL LOG DATA;
\`\`\`

### Revert ENABLE_GOLDENGATE_REPLICATION if no other OGG processes remain

\`\`\`sql
ALTER SYSTEM SET ENABLE_GOLDENGATE_REPLICATION = FALSE SCOPE=BOTH;
\`\`\`

### Drop OGG database users

\`\`\`sql
-- Source
DROP USER ggadmin CASCADE;

-- Target
DROP USER ggadmin CASCADE;
\`\`\``,
};

async function main() {
  console.log('Inserting GoldenGate Integrated Capture runbook post...');
  await db.insert(posts).values(post).onConflictDoNothing();
  console.log(`Inserted: "${post.title}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
