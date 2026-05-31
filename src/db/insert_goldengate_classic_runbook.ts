import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Implementing Oracle GoldenGate with Classic Capture',
  slug: 'goldengate-classic-capture-implementation-runbook',
  excerpt:
    'End-to-end operational runbook for deploying Oracle GoldenGate unidirectional replication using Classic Capture — from source database preparation and supplemental logging through Extract, Data Pump, and Replicat configuration, initial load instantiation, process startup, and post-build verification.',
  category: 'golden-gate' as const,
  published: true,
  publishedAt: new Date('2026-05-31'),
  youtubeUrl: null,
  content: `## Purpose

Deploy a production Oracle GoldenGate Classic Capture pipeline replicating a defined set of schemas from a source Oracle database to a target Oracle database with minimal source impact and no downtime.

---

## Scope and Assumptions

- Oracle GoldenGate 19c (Classic Architecture — not Microservices)
- Oracle Database 19c on both source and target (procedure applies to 11.2+)
- Unidirectional replication: source to target only
- OGG software already extracted to the OGG home on both hosts
- Source and target hosts are network-accessible on the OGG collector port (default 7809)
- Schemas to replicate are fully defined before you begin — schema changes during setup require restarting from Step 6

---

## Reference Variables

\`\`\`
OGG_HOME (source)       = /u01/app/oracle/product/ogg19
OGG_HOME (target)       = /u01/app/oracle/product/ogg19
ORACLE_HOME (source)    = /u01/app/oracle/product/19.0.0/dbhome_1
ORACLE_HOME (target)    = /u01/app/oracle/product/19.0.0/dbhome_1
SOURCE_ORACLE_SID       = SRCDB
TARGET_ORACLE_SID       = TGTDB
SOURCE_TNS_ALIAS        = SRCDB
TARGET_TNS_ALIAS        = TGTDB
SOURCE_HOST             = ogg-source.example.com
TARGET_HOST             = ogg-target.example.com
OGG_COLLECTOR_PORT      = 7809
TRAIL_PREFIX (source)   = ./dirdat/lt
TRAIL_PREFIX (target)   = ./dirdat/rt
SCHEMAS_TO_REPLICATE    = HR, OE
OGG_DB_USER (source)    = ggadmin
OGG_DB_USER (target)    = ggadmin
\`\`\`

---

## Pre-Flight Checks

### 1. Confirm source database is in ARCHIVELOG mode

\`\`\`sql
-- On source as SYSDBA
SELECT LOG_MODE FROM V$DATABASE;
\`\`\`

If \`LOG_MODE = NOARCHIVELOG\`, enable it:

\`\`\`sql
SHUTDOWN IMMEDIATE;
STARTUP MOUNT;
ALTER DATABASE ARCHIVELOG;
ALTER DATABASE OPEN;
\`\`\`

### 2. Confirm FORCE LOGGING is enabled on source

\`\`\`sql
SELECT FORCE_LOGGING FROM V$DATABASE;
\`\`\`

Enable if needed:

\`\`\`sql
ALTER DATABASE FORCE LOGGING;
\`\`\`

### 3. Verify OGG home layout on both hosts

\`\`\`bash
# Both hosts — confirm required subdirectories exist
ls $OGG_HOME/dirdat $OGG_HOME/dirprm $OGG_HOME/dirrpt $OGG_HOME/dirchk $OGG_HOME/dirtmp
\`\`\`

If missing, run the GGSCI \`CREATE SUBDIRS\` command:

\`\`\`
GGSCI> CREATE SUBDIRS
\`\`\`

### 4. Confirm TNS connectivity between hosts

\`\`\`bash
# From source host
tnsping TGTDB

# From target host
tnsping SRCDB
\`\`\`

### 5. Verify OGG version on both hosts

\`\`\`bash
$OGG_HOME/ggsci <<'EOF'
VERSION
EXIT
EOF
\`\`\`

---

## Step 1 — Enable Supplemental Logging on Source

Classic Capture requires supplemental logging so the redo stream includes before-image column values needed to construct UPDATE and DELETE operations.

### 1a. Enable minimal supplemental logging at database level

\`\`\`sql
-- On source as SYSDBA
ALTER DATABASE ADD SUPPLEMENTAL LOG DATA;

-- Verify
SELECT SUPPLEMENTAL_LOG_DATA_MIN FROM V$DATABASE;
-- Expected: YES
\`\`\`

### 1b. Enable ALL COLUMNS supplemental logging on each replicated table

\`\`\`sql
-- Repeat for every table in scope
ALTER TABLE hr.employees    ADD SUPPLEMENTAL LOG DATA (ALL) COLUMNS;
ALTER TABLE hr.departments  ADD SUPPLEMENTAL LOG DATA (ALL) COLUMNS;
ALTER TABLE oe.orders       ADD SUPPLEMENTAL LOG DATA (ALL) COLUMNS;
ALTER TABLE oe.order_items  ADD SUPPLEMENTAL LOG DATA (ALL) COLUMNS;
\`\`\`

Alternatively, use PRIMARY KEY supplemental logging if all tables have primary keys and you only need key-based lookups:

\`\`\`sql
ALTER TABLE hr.employees ADD SUPPLEMENTAL LOG DATA (PRIMARY KEY, UNIQUE) COLUMNS;
\`\`\`

### 1c. Verify supplemental logging is active

\`\`\`sql
SELECT OWNER, LOG_GROUP_TYPE, TABLE_NAME, LOG_GROUP_NAME
FROM DBA_LOG_GROUPS
WHERE OWNER IN ('HR','OE')
ORDER BY OWNER, TABLE_NAME;
\`\`\`

---

## Step 2 — Create OGG Database User on Source

\`\`\`sql
-- On source as SYSDBA
CREATE USER ggadmin IDENTIFIED BY "GGAdmin#2026"
  DEFAULT TABLESPACE users
  TEMPORARY TABLESPACE temp;

-- Core GoldenGate privileges
GRANT CREATE SESSION         TO ggadmin;
GRANT ALTER SESSION          TO ggadmin;
GRANT SELECT ANY DICTIONARY  TO ggadmin;
GRANT SELECT ANY TABLE       TO ggadmin;
GRANT FLASHBACK ANY TABLE    TO ggadmin;
GRANT SELECT ON V_$DATABASE  TO ggadmin;
GRANT SELECT ON V_$LOG       TO ggadmin;
GRANT SELECT ON V_$LOGFILE   TO ggadmin;
GRANT SELECT ON V_$ARCHIVED_LOG TO ggadmin;
GRANT SELECT ON V_$INSTANCE  TO ggadmin;
GRANT EXECUTE ON DBMS_FLASHBACK TO ggadmin;

-- Required for Classic Capture log access
GRANT SELECT ON V_$TRANSPORTABLE_PLATFORM TO ggadmin;
\`\`\`

---

## Step 3 — Create OGG Database User on Target

\`\`\`sql
-- On target as SYSDBA
CREATE USER ggadmin IDENTIFIED BY "GGAdmin#2026"
  DEFAULT TABLESPACE users
  TEMPORARY TABLESPACE temp;

GRANT CREATE SESSION   TO ggadmin;
GRANT ALTER SESSION    TO ggadmin;
GRANT RESOURCE         TO ggadmin;
GRANT SELECT ANY DICTIONARY TO ggadmin;

-- Replicat needs DML access on target schemas
GRANT INSERT, UPDATE, DELETE ON hr.employees    TO ggadmin;
GRANT INSERT, UPDATE, DELETE ON hr.departments  TO ggadmin;
GRANT INSERT, UPDATE, DELETE ON oe.orders       TO ggadmin;
GRANT INSERT, UPDATE, DELETE ON oe.order_items  TO ggadmin;

-- Or grant schema-level if many tables:
-- GRANT INSERT ANY TABLE, UPDATE ANY TABLE, DELETE ANY TABLE TO ggadmin;
\`\`\`

---

## Step 4 — Configure the Manager Process

Manager is OGG's controller daemon. It must run on both hosts before any other process can start.

### 4a. Source host Manager

Create \`$OGG_HOME/dirprm/mgr.prm\`:

\`\`\`
PORT 7809
DYNAMICPORTLIST 7810-7820
AUTORESTART EXTRACT *, RETRIES 5, WAITMINUTES 2
PURGEOLDEXTRACTS ./dirdat/lt*, USECHECKPOINTS, MINKEEPDAYS 3
LAGREPORTHOURS 1
LAGINFOMINUTES 30
LAGCRITICALMINUTES 60
\`\`\`

### 4b. Target host Manager

Create \`$OGG_HOME/dirprm/mgr.prm\` on target:

\`\`\`
PORT 7809
DYNAMICPORTLIST 7810-7820
AUTORESTART REPLICAT *, RETRIES 5, WAITMINUTES 2
PURGEOLDEXTRACTS ./dirdat/rt*, USECHECKPOINTS, MINKEEPDAYS 3
LAGREPORTHOURS 1
LAGINFOMINUTES 30
LAGCRITICALMINUTES 60
\`\`\`

### 4c. Start Manager on both hosts

\`\`\`
GGSCI> START MANAGER
GGSCI> INFO MANAGER
\`\`\`

**Expected:**

\`\`\`
Manager is running (IP port ogg-source.example.com:7809).
\`\`\`

---

## Step 5 — Configure the Classic Extract

The Extract reads redo and archive logs directly from the operating system.

### 5a. Add the Extract group

\`\`\`
-- On source GGSCI
DBLOGIN USERID ggadmin@SRCDB PASSWORD "GGAdmin#2026"
ADD EXTRACT ext1, TRANLOG, BEGIN NOW
ADD EXTTRAIL ./dirdat/lt, EXTRACT ext1, MEGABYTES 500
\`\`\`

### 5b. Create the Extract parameter file

Create \`$OGG_HOME/dirprm/ext1.prm\`:

\`\`\`
EXTRACT ext1
USERID ggadmin@SRCDB, PASSWORD "GGAdmin#2026"
EXTTRAIL ./dirdat/lt

-- Tell OGG to read redo via the DB log reader API (Classic mode)
TRANLOGOPTIONS DBLOGREADER

-- Required for SCN-based instantiation during initial load
TRANLOGOPTIONS COMPLETEPARTIALTRANSACTIONS

-- Log any discarded operations to the discard file
DISCARDFILE ./dirrpt/ext1.dsc, APPEND, MEGABYTES 100

-- Tables to capture — all columns
TABLE hr.employees;
TABLE hr.departments;
TABLE oe.orders;
TABLE oe.order_items;
\`\`\`

### 5c. Verify the Extract registered correctly

\`\`\`
GGSCI> INFO EXTRACT ext1, DETAIL
\`\`\`

**Expected:**

\`\`\`
EXTRACT    EXT1      Initialized   <timestamp>
  Log Read Checkpoint  Oracle Redo Logs
  <timestamp>  Seqno 0, RBA 0
\`\`\`

---

## Step 6 — Configure the Data Pump Extract

The Data Pump is a secondary Extract on the source that reads the local trail written by ext1 and forwards it across the network to the target.

### 6a. Add the Data Pump group

\`\`\`
-- On source GGSCI
ADD EXTRACT dpump1, EXTTRAILSOURCE ./dirdat/lt
ADD RMTTRAIL ./dirdat/rt, EXTRACT dpump1, MEGABYTES 500
\`\`\`

### 6b. Create the Data Pump parameter file

Create \`$OGG_HOME/dirprm/dpump1.prm\`:

\`\`\`
EXTRACT dpump1
USERID ggadmin@SRCDB, PASSWORD "GGAdmin#2026"
RMTHOST ogg-target.example.com, MGRPORT 7809, COMPRESS
RMTTRAIL ./dirdat/rt

PASSTHRU
TABLE hr.*;
TABLE oe.*;
\`\`\`

\`PASSTHRU\` instructs the Data Pump to forward trail records without re-opening the database — it is a routing process only and does not need to connect to the source DB to perform its function.

\`COMPRESS\` reduces network bandwidth consumption; remove it if the target host CPU is constrained.

---

## Step 7 — Perform the Initial Load (Instantiation)

Before starting continuous replication you must populate the target tables with a consistent snapshot of the source data and set the Extract to begin from the SCN at which that snapshot was taken.

### 7a. Record the source SCN before export

\`\`\`sql
-- On source as SYSDBA
SELECT CURRENT_SCN FROM V$DATABASE;
-- Note this value: e.g. 4823917
\`\`\`

### 7b. Export source schemas with Data Pump (expdp)

\`\`\`bash
# On source host
expdp userid=system/password@SRCDB \
  schemas=HR,OE \
  flashback_scn=4823917 \
  directory=DATA_PUMP_DIR \
  dumpfile=ogg_initial_%U.dmp \
  logfile=ogg_initial_exp.log \
  parallel=4
\`\`\`

### 7c. Transfer dump files to target host

\`\`\`bash
scp /u01/app/oracle/admin/SRCDB/dpdump/ogg_initial_*.dmp \
    oracle@ogg-target.example.com:/u01/app/oracle/admin/TGTDB/dpdump/
\`\`\`

### 7d. Import into target with Data Pump (impdp)

\`\`\`bash
# On target host
impdp userid=system/password@TGTDB \
  schemas=HR,OE \
  directory=DATA_PUMP_DIR \
  dumpfile=ogg_initial_%U.dmp \
  logfile=ogg_initial_imp.log \
  table_exists_action=REPLACE \
  parallel=4
\`\`\`

### 7e. Set the Extract checkpoint to the instantiation SCN

\`\`\`
-- On source GGSCI
DBLOGIN USERID ggadmin@SRCDB PASSWORD "GGAdmin#2026"
ADD TRANDATA hr.employees, COLS (employee_id)
ADD TRANDATA hr.departments
ADD TRANDATA oe.orders
ADD TRANDATA oe.order_items

-- Advance the Extract start position to the export SCN
ALTER EXTRACT ext1, SCN 4823917
\`\`\`

\`HANDLECOLLISIONS\` will be enabled on the Replicat in Step 8 to absorb any rows that were written to the source between the export SCN and the moment the Replicat starts applying — this is the normal overlap window.

---

## Step 8 — Configure the Replicat

### 8a. Verify target trail directory is ready

\`\`\`bash
# On target host
ls -lh $OGG_HOME/dirdat/
\`\`\`

The target trail files (prefixed \`rt\`) should appear after the Data Pump is started in Step 9.

### 8b. Add the Replicat group

\`\`\`
-- On target GGSCI
DBLOGIN USERID ggadmin@TGTDB PASSWORD "GGAdmin#2026"
ADD REPLICAT rep1, EXTTRAIL ./dirdat/rt, CHECKPOINTTABLE ggadmin.chkptab
\`\`\`

The checkpoint table stores the Replicat's read position so it can resume after a restart without replaying already-applied records.

Create the checkpoint table if it does not exist:

\`\`\`
GGSCI> ADD CHECKPOINTTABLE ggadmin.chkptab
\`\`\`

### 8c. Create the Replicat parameter file

Create \`$OGG_HOME/dirprm/rep1.prm\`:

\`\`\`
REPLICAT rep1
TARGETDB TGTDB, USERID ggadmin, PASSWORD "GGAdmin#2026"
ASSUMETARGETDEFS

-- Absorb duplicate-key and row-not-found errors during the overlap window
HANDLECOLLISIONS

-- Discard unresolvable errors rather than aborting
DISCARDFILE ./dirrpt/rep1.dsc, APPEND, MEGABYTES 100

-- Replicat error handling: skip unresolvable rows after logging
REPERROR (DEFAULT, ABEND)
REPERROR (1403, DISCARD)
REPERROR (1, DISCARD)

MAP hr.employees,   TARGET hr.employees;
MAP hr.departments, TARGET hr.departments;
MAP oe.orders,      TARGET oe.orders;
MAP oe.order_items, TARGET oe.order_items;
\`\`\`

\`ASSUMETARGETDEFS\` tells the Replicat that source and target table definitions are identical. If they differ (column renames, type conversions), replace this with a \`SOURCEDEFS\` file generated by the \`DEFGEN\` utility on the source.

---

## Step 9 — Start All Processes in Order

Start processes in the sequence below. Starting Replicat before the trail exists causes an immediate abend.

### 9a. Start the Extract on source

\`\`\`
-- Source GGSCI
START EXTRACT ext1
INFO EXTRACT ext1
\`\`\`

**Expected:** \`EXTRACT EXT1 Running\`

### 9b. Start the Data Pump on source

\`\`\`
-- Source GGSCI
START EXTRACT dpump1
INFO EXTRACT dpump1
\`\`\`

**Expected:** \`EXTRACT DPUMP1 Running\`

Wait 30 seconds, then confirm trail files are appearing on the target:

\`\`\`bash
# Target host
ls -lh $OGG_HOME/dirdat/rt*
\`\`\`

### 9c. Start the Replicat on target

\`\`\`
-- Target GGSCI
START REPLICAT rep1
INFO REPLICAT rep1
\`\`\`

**Expected:** \`REPLICAT REP1 Running\`

---

## Step 10 — Post-Start Verification

### 10a. Check all process statuses

\`\`\`
-- Source GGSCI
INFO ALL

-- Target GGSCI
INFO ALL
\`\`\`

**Expected on source:**

\`\`\`
Program     Status      Group       Lag at Chkpt  Time Since Chkpt
MANAGER     RUNNING
EXTRACT     RUNNING     EXT1        00:00:03      00:00:05
EXTRACT     RUNNING     DPUMP1      00:00:01      00:00:04
\`\`\`

**Expected on target:**

\`\`\`
Program     Status      Group       Lag at Chkpt  Time Since Chkpt
MANAGER     RUNNING
REPLICAT    RUNNING     REP1        00:00:02      00:00:04
\`\`\`

### 10b. Verify Extract is reading redo logs

\`\`\`
-- Source GGSCI
INFO EXTRACT ext1, DETAIL
\`\`\`

Confirm \`Log Read Checkpoint\` shows a current sequence number advancing, not sequence 0.

### 10c. Check current lag

\`\`\`
-- Source GGSCI
LAG EXTRACT ext1
LAG EXTRACT dpump1

-- Target GGSCI
LAG REPLICAT rep1
\`\`\`

Lag should drop toward zero within a few minutes of startup as the initial change backlog from the overlap window is consumed.

### 10d. Run a functional smoke test

\`\`\`sql
-- On source
UPDATE hr.employees SET salary = salary + 1 WHERE employee_id = 100;
COMMIT;

-- Wait 5–10 seconds, then on target
SELECT salary FROM hr.employees WHERE employee_id = 100;
\`\`\`

The salary on the target should match the updated value on the source.

### 10e. Remove HANDLECOLLISIONS once lag reaches zero

Once lag is consistently at or near zero and no more overlap-window collisions are expected, disable HANDLECOLLISIONS to prevent it from silently hiding genuine Replicat errors:

\`\`\`
-- Target GGSCI
SEND REPLICAT rep1, NOHANDLECOLLISIONS
\`\`\`

Then edit \`dirprm/rep1.prm\` and remove or comment out the \`HANDLECOLLISIONS\` line so it does not re-enable on next restart.

---

## Step 11 — Ongoing Monitoring Commands

### Extract statistics

\`\`\`
GGSCI> STATS EXTRACT ext1, TOTAL
GGSCI> STATS EXTRACT ext1, TABLE hr.employees, TOTAL
\`\`\`

### Replicat statistics

\`\`\`
GGSCI> STATS REPLICAT rep1, TOTAL
GGSCI> STATS REPLICAT rep1, TABLE hr.employees, TOTAL
\`\`\`

### Trail file usage

\`\`\`
GGSCI> INFO EXTTRAIL ./dirdat/lt*
GGSCI> INFO RMTTRAIL ./dirdat/rt*
\`\`\`

### View last 100 lines of process report

\`\`\`
GGSCI> VIEW REPORT ext1
GGSCI> VIEW REPORT rep1
\`\`\`

### Check discard file for silently skipped rows

\`\`\`bash
tail -100 $OGG_HOME/dirrpt/rep1.dsc
\`\`\`

---

## Troubleshooting

### Extract abends immediately after START

\`\`\`
-- Check report file for the specific ORA- or GGS- error
GGSCI> VIEW REPORT ext1

-- Common cause: insufficient privileges
-- Verify ggadmin can select V$LOG and V$ARCHIVED_LOG
sqlplus ggadmin/password@SRCDB
SELECT COUNT(*) FROM V$LOG;
SELECT COUNT(*) FROM V$ARCHIVED_LOG;
\`\`\`

### Extract falls behind — lag growing

\`\`\`
-- Identify if Extract is waiting on archived logs
GGSCI> INFO EXTRACT ext1, DETAIL
-- If sequence number is not advancing, the archive log may be missing or inaccessible

-- On source — confirm archive log exists
SELECT NAME, SEQUENCE#, DELETED FROM V$ARCHIVED_LOG
WHERE SEQUENCE# = <stalled_sequence>
ORDER BY SEQUENCE#;
\`\`\`

### Data Pump abends — cannot connect to target Manager

\`\`\`bash
# Confirm target Manager is running and port is reachable from source
telnet ogg-target.example.com 7809

# If telnet fails, check firewall rules:
# Source must reach target on port 7809 and the DYNAMICPORTLIST range
\`\`\`

### Replicat abends with ORA-00001 (duplicate key)

\`\`\`
-- Enable HANDLECOLLISIONS temporarily
GGSCI> SEND REPLICAT rep1, HANDLECOLLISIONS

-- Review discard file to identify the table causing duplicates
tail -200 $OGG_HOME/dirrpt/rep1.dsc

-- If the target table genuinely has stale data, truncate and re-run
-- the initial load for that table only, then restart Replicat
\`\`\`

### Replicat abends with ORA-01403 (no data found on UPDATE/DELETE)

This means the target row is missing. Usually caused by:
- Initial load incomplete for that table
- A prior Replicat abend that skipped inserts

\`\`\`
-- Identify missing rows from discard file
-- Re-run targeted expdp/impdp for the affected table
-- Use HANDLECOLLISIONS and restart
\`\`\`

### Archive log purged before Extract consumed it

\`\`\`
-- On source as SYSDBA — check Extract's lag sequence vs archived log retention
SELECT MIN(SEQUENCE#) AS OLDEST_ARCH FROM V$ARCHIVED_LOG WHERE DELETED = 'NO';

-- Compare with Extract's last read sequence:
GGSCI> INFO EXTRACT ext1, DETAIL

-- If Extract is behind the oldest archive, you must re-instantiate
-- Increase RMAN archive log retention to cover expected Extract lag:
CONFIGURE ARCHIVELOG DELETION POLICY TO APPLIED ON ALL STANDBY;
-- Or set a minimum retention period:
CONFIGURE ARCHIVELOG RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS;
\`\`\`

---

## Rollback

### Stop and delete all OGG processes

\`\`\`
-- Source GGSCI
STOP EXTRACT ext1
STOP EXTRACT dpump1
DELETE EXTRACT ext1
DELETE EXTRACT dpump1
DELETE EXTTRAIL ./dirdat/lt*

-- Target GGSCI
STOP REPLICAT rep1
DELETE REPLICAT rep1
DELETE RMTTRAIL ./dirdat/rt*
\`\`\`

### Remove supplemental logging from source tables

\`\`\`sql
-- On source as SYSDBA
ALTER TABLE hr.employees    DROP SUPPLEMENTAL LOG DATA (ALL) COLUMNS;
ALTER TABLE hr.departments  DROP SUPPLEMENTAL LOG DATA (ALL) COLUMNS;
ALTER TABLE oe.orders       DROP SUPPLEMENTAL LOG DATA (ALL) COLUMNS;
ALTER TABLE oe.order_items  DROP SUPPLEMENTAL LOG DATA (ALL) COLUMNS;

-- If no other OGG processes need minimal supplemental logging:
ALTER DATABASE DROP SUPPLEMENTAL LOG DATA;
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
  console.log('Inserting GoldenGate Classic Capture runbook post...');
  await db.insert(posts).values(post).onConflictDoNothing();
  console.log(`Inserted: "${post.title}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
