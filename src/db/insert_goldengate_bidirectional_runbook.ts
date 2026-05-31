import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Implementing Oracle GoldenGate Bidirectional (Active-Active) Replication',
  slug: 'goldengate-bidirectional-active-active-runbook',
  excerpt:
    'End-to-end operational runbook for deploying Oracle GoldenGate Active-Active bidirectional replication — covering loop prevention with SETTAG and EXCLUDETAG, Conflict Detection and Resolution (CDR), Extract and Replicat configuration on both sites, SCN-based instantiation, startup sequencing, conflict monitoring, and rollback.',
  category: 'golden-gate' as const,
  published: true,
  publishedAt: new Date('2026-05-31'),
  youtubeUrl: null,
  content: `## Purpose

Deploy a fully bidirectional Oracle GoldenGate Active-Active pipeline where both Site A and Site B accept live writes and replicate changes to each other in real time — with loop prevention and Conflict Detection and Resolution (CDR) to maintain data integrity.

---

## Scope and Assumptions

- Oracle GoldenGate 19c Classic Architecture (non-Microservices)
- Oracle Database 19c on both sites
- Integrated Capture on both sites (logmining server)
- Schemas and tables are identical on both sites before replication starts
- Every replicated table has a **primary key** and a **timestamp or sequence column** used for CDR
- Both sites are active for writes from the moment replication is live
- This runbook configures one bidirectional pair; extend the pattern for additional schema pairs

---

## Architecture Overview

Each site runs three process groups:

- **Extract** — captures local changes and writes them to a local trail
- **Data Pump** — forwards the local trail to the remote site over the network
- **Replicat** — applies changes received from the remote site

The critical addition over unidirectional replication is **loop prevention**. Without it, a change applied by Site B's Replicat would be captured by Site B's Extract and sent back to Site A, which would apply it again and re-send it — an infinite loop.

Loop prevention is implemented with two paired directives:

- **\`DBOPTIONS SETTAG\`** on each Replicat stamps every applied transaction with a unique tag in the redo stream.
- **\`TRANLOGOPTIONS EXCLUDETAG\`** on each Extract skips any redo record carrying that tag.

Site A's Replicat stamps with tag \`01\`. Site A's Extract excludes tag \`01\`. This means changes applied by Site A's Replicat are never re-captured by Site A's Extract and never sent back to Site B.

---

## Reference Variables

\`\`\`
SITE A
  HOST             = ogg-site-a.example.com
  ORACLE_SID       = DBLIVE_A
  TNS_ALIAS        = DBLIVE_A
  OGG_HOME         = /u01/app/oracle/product/ogg19
  TRAIL (local)    = ./dirdat/la
  TRAIL (received) = ./dirdat/ra
  REPLICAT TAG     = 01
  EXTRACT NAME     = ext_a
  DATA PUMP NAME   = dpump_a
  REPLICAT NAME    = rep_a

SITE B
  HOST             = ogg-site-b.example.com
  ORACLE_SID       = DBLIVE_B
  TNS_ALIAS        = DBLIVE_B
  OGG_HOME         = /u01/app/oracle/product/ogg19
  TRAIL (local)    = ./dirdat/lb
  TRAIL (received) = ./dirdat/rb
  REPLICAT TAG     = 02
  EXTRACT NAME     = ext_b
  DATA PUMP NAME   = dpump_b
  REPLICAT NAME    = rep_b

SHARED
  OGG_DB_USER      = ggadmin
  OGG_COLLECTOR_PORT = 7809
  SCHEMAS          = HR, OE
\`\`\`

---

## Pre-Flight Checks

Run the following on **both sites** before proceeding.

### 1. Confirm ARCHIVELOG mode and FORCE LOGGING

\`\`\`sql
SELECT LOG_MODE, FORCE_LOGGING FROM V$DATABASE;
\`\`\`

Enable if needed:

\`\`\`sql
SHUTDOWN IMMEDIATE;
STARTUP MOUNT;
ALTER DATABASE ARCHIVELOG;
ALTER DATABASE OPEN;
ALTER DATABASE FORCE LOGGING;
\`\`\`

### 2. Confirm ENABLE_GOLDENGATE_REPLICATION

\`\`\`sql
SHOW PARAMETER ENABLE_GOLDENGATE_REPLICATION;
\`\`\`

\`\`\`sql
ALTER SYSTEM SET ENABLE_GOLDENGATE_REPLICATION = TRUE SCOPE=BOTH;
\`\`\`

### 3. Confirm logmining server package is valid

\`\`\`sql
SELECT OBJECT_NAME, STATUS FROM DBA_OBJECTS
WHERE OBJECT_NAME = 'DBMS_LOGMNR' AND OBJECT_TYPE = 'PACKAGE';
\`\`\`

### 4. Confirm every replicated table has a primary key

\`\`\`sql
SELECT t.owner, t.table_name
FROM dba_tables t
WHERE t.owner IN ('HR','OE')
  AND NOT EXISTS (
    SELECT 1 FROM dba_constraints c
    WHERE c.owner = t.owner
      AND c.table_name = t.table_name
      AND c.constraint_type = 'P'
  );
\`\`\`

Tables returned by this query have no primary key. Add one or define a \`KEYCOLS\` clause in the MAP statement before proceeding. Bidirectional replication without primary keys produces unpredictable CDR behaviour.

### 5. Confirm CDR timestamp column exists on all replicated tables

CDR resolution requires a reliable timestamp or sequence value on every table. Verify that your chosen column (e.g. \`last_updated_date\`) is present and populated:

\`\`\`sql
SELECT table_name, column_name, data_type
FROM dba_tab_columns
WHERE owner IN ('HR','OE')
  AND column_name = 'LAST_UPDATED_DATE'
ORDER BY table_name;
\`\`\`

If the column is missing, add it before starting:

\`\`\`sql
ALTER TABLE hr.employees    ADD last_updated_date TIMESTAMP DEFAULT SYSTIMESTAMP;
ALTER TABLE hr.departments  ADD last_updated_date TIMESTAMP DEFAULT SYSTIMESTAMP;
ALTER TABLE oe.orders       ADD last_updated_date TIMESTAMP DEFAULT SYSTIMESTAMP;
ALTER TABLE oe.order_items  ADD last_updated_date TIMESTAMP DEFAULT SYSTIMESTAMP;
\`\`\`

### 6. Test cross-site connectivity

\`\`\`bash
# From Site A
tnsping DBLIVE_B
telnet ogg-site-b.example.com 7809

# From Site B
tnsping DBLIVE_A
telnet ogg-site-a.example.com 7809
\`\`\`

---

## Step 1 — Enable Supplemental Logging on Both Sites

\`\`\`sql
-- Run on BOTH sites as SYSDBA
ALTER DATABASE ADD SUPPLEMENTAL LOG DATA;

-- Verify
SELECT SUPPLEMENTAL_LOG_DATA_MIN FROM V$DATABASE;
\`\`\`

\`LOGALLSUPCOLS\` in the Extract parameter file will handle per-table ALL COLUMNS supplemental logging automatically.

---

## Step 2 — Create OGG Database Users on Both Sites

Run on **both sites**:

\`\`\`sql
CREATE USER ggadmin IDENTIFIED BY "GGAdmin#2026"
  DEFAULT TABLESPACE users
  TEMPORARY TABLESPACE temp;

GRANT DBA TO ggadmin;
\`\`\`

If DBA is not permitted by policy, use the least-privilege grant set from the Integrated Capture runbook and additionally grant:

\`\`\`sql
GRANT ALTER ANY TABLE TO ggadmin;
\`\`\`

---

## Step 3 — Configure Manager on Both Sites

Create \`$OGG_HOME/dirprm/mgr.prm\` on **both sites**:

\`\`\`
PORT 7809
DYNAMICPORTLIST 7810-7830
AUTORESTART EXTRACT *, RETRIES 5, WAITMINUTES 2
AUTORESTART REPLICAT *, RETRIES 5, WAITMINUTES 2
PURGEOLDEXTRACTS ./dirdat/l*, USECHECKPOINTS, MINKEEPDAYS 3
LAGREPORTHOURS 1
LAGINFOMINUTES 30
LAGCRITICALMINUTES 60
\`\`\`

Start on both sites:

\`\`\`
GGSCI> START MANAGER
GGSCI> INFO MANAGER
\`\`\`

---

## Step 4 — Configure Extracts on Both Sites

### Site A — Extract parameter file (\`dirprm/ext_a.prm\`)

\`\`\`
EXTRACT ext_a
USERID ggadmin@DBLIVE_A, PASSWORD "GGAdmin#2026"
EXTTRAIL ./dirdat/la

TRANLOGOPTIONS INTEGRATEDPARAMS (MAX_SGA_SIZE 512, PARALLELISM 2)

-- Exclude transactions stamped by Site A's own Replicat (loop prevention)
-- Tag 01 = applied by rep_a (changes that originated from Site B)
TRANLOGOPTIONS EXCLUDETAG 01

LOGALLSUPCOLS
UPDATERECORDFORMAT FULL

DISCARDFILE ./dirrpt/ext_a.dsc, APPEND, MEGABYTES 100

TABLE hr.employees;
TABLE hr.departments;
TABLE oe.orders;
TABLE oe.order_items;
\`\`\`

### Site A — Add and register the Extract

\`\`\`
-- Site A GGSCI
DBLOGIN USERID ggadmin@DBLIVE_A PASSWORD "GGAdmin#2026"
ADD EXTRACT ext_a, INTEGRATED TRANLOG, BEGIN NOW
ADD EXTTRAIL ./dirdat/la, EXTRACT ext_a, MEGABYTES 500
REGISTER EXTRACT ext_a DATABASE
\`\`\`

### Site B — Extract parameter file (\`dirprm/ext_b.prm\`)

\`\`\`
EXTRACT ext_b
USERID ggadmin@DBLIVE_B, PASSWORD "GGAdmin#2026"
EXTTRAIL ./dirdat/lb

TRANLOGOPTIONS INTEGRATEDPARAMS (MAX_SGA_SIZE 512, PARALLELISM 2)

-- Exclude transactions stamped by Site B's own Replicat (loop prevention)
-- Tag 02 = applied by rep_b (changes that originated from Site A)
TRANLOGOPTIONS EXCLUDETAG 02

LOGALLSUPCOLS
UPDATERECORDFORMAT FULL

DISCARDFILE ./dirrpt/ext_b.dsc, APPEND, MEGABYTES 100

TABLE hr.employees;
TABLE hr.departments;
TABLE oe.orders;
TABLE oe.order_items;
\`\`\`

### Site B — Add and register the Extract

\`\`\`
-- Site B GGSCI
DBLOGIN USERID ggadmin@DBLIVE_B PASSWORD "GGAdmin#2026"
ADD EXTRACT ext_b, INTEGRATED TRANLOG, BEGIN NOW
ADD EXTTRAIL ./dirdat/lb, EXTRACT ext_b, MEGABYTES 500
REGISTER EXTRACT ext_b DATABASE
\`\`\`

---

## Step 5 — Configure Data Pumps on Both Sites

### Site A — Data Pump parameter file (\`dirprm/dpump_a.prm\`)

\`\`\`
EXTRACT dpump_a
USERID ggadmin@DBLIVE_A, PASSWORD "GGAdmin#2026"
RMTHOST ogg-site-b.example.com, MGRPORT 7809, COMPRESS
RMTTRAIL ./dirdat/rb

PASSTHRU
TABLE hr.*;
TABLE oe.*;
\`\`\`

\`\`\`
-- Site A GGSCI
ADD EXTRACT dpump_a, EXTTRAILSOURCE ./dirdat/la
ADD RMTTRAIL ./dirdat/rb, EXTRACT dpump_a, MEGABYTES 500
\`\`\`

### Site B — Data Pump parameter file (\`dirprm/dpump_b.prm\`)

\`\`\`
EXTRACT dpump_b
USERID ggadmin@DBLIVE_B, PASSWORD "GGAdmin#2026"
RMTHOST ogg-site-a.example.com, MGRPORT 7809, COMPRESS
RMTTRAIL ./dirdat/ra

PASSTHRU
TABLE hr.*;
TABLE oe.*;
\`\`\`

\`\`\`
-- Site B GGSCI
ADD EXTRACT dpump_b, EXTTRAILSOURCE ./dirdat/lb
ADD RMTTRAIL ./dirdat/ra, EXTRACT dpump_b, MEGABYTES 500
\`\`\`

---

## Step 6 — Initial Load (Instantiation)

Both databases must start from an identical, consistent baseline before bidirectional replication goes live. The safest method is a single export from Site A imported into Site B.

### 6a. Record Site A SCN before export

\`\`\`sql
-- Site A as SYSDBA
SELECT CURRENT_SCN FROM V$DATABASE;
-- e.g. 9120443
\`\`\`

### 6b. Export from Site A

\`\`\`bash
# Site A host
expdp userid=system/password@DBLIVE_A \
  schemas=HR,OE \
  flashback_scn=9120443 \
  directory=DATA_PUMP_DIR \
  dumpfile=ogg_bidir_%U.dmp \
  logfile=ogg_bidir_exp.log \
  parallel=4
\`\`\`

### 6c. Transfer and import into Site B

\`\`\`bash
scp /u01/app/oracle/admin/DBLIVE_A/dpdump/ogg_bidir_*.dmp \
    oracle@ogg-site-b.example.com:/u01/app/oracle/admin/DBLIVE_B/dpdump/

impdp userid=system/password@DBLIVE_B \
  schemas=HR,OE \
  directory=DATA_PUMP_DIR \
  dumpfile=ogg_bidir_%U.dmp \
  logfile=ogg_bidir_imp.log \
  table_exists_action=REPLACE \
  parallel=4
\`\`\`

### 6d. Align Extract start SCNs on both sites

\`\`\`
-- Site A GGSCI
DBLOGIN USERID ggadmin@DBLIVE_A PASSWORD "GGAdmin#2026"
ALTER EXTRACT ext_a, SCN 9120443

-- Site B GGSCI
DBLOGIN USERID ggadmin@DBLIVE_B PASSWORD "GGAdmin#2026"
ALTER EXTRACT ext_b, SCN 9120443
\`\`\`

Both Extracts start from the same SCN — the export snapshot point — ensuring neither site replays changes that are already present in the other.

---

## Step 7 — Configure Replicats on Both Sites

### 7a. Create checkpoint tables

\`\`\`
-- Site A GGSCI
DBLOGIN USERID ggadmin@DBLIVE_A PASSWORD "GGAdmin#2026"
ADD CHECKPOINTTABLE ggadmin.chkptab

-- Site B GGSCI
DBLOGIN USERID ggadmin@DBLIVE_B PASSWORD "GGAdmin#2026"
ADD CHECKPOINTTABLE ggadmin.chkptab
\`\`\`

### 7b. Site A — Replicat parameter file (\`dirprm/rep_a.prm\`)

Site A's Replicat applies changes that arrived from Site B. It stamps those applied transactions with tag \`01\` so that Site A's Extract ignores them.

\`\`\`
REPLICAT rep_a
TARGETDB DBLIVE_A, USERID ggadmin, PASSWORD "GGAdmin#2026"
ASSUMETARGETDEFS

-- Stamp every transaction applied by this Replicat with tag 01
-- Site A's Extract is configured with EXCLUDETAG 01 to ignore these
DBOPTIONS SETTAG 01

HANDLECOLLISIONS

DISCARDFILE ./dirrpt/rep_a.dsc, APPEND, MEGABYTES 100

REPERROR (DEFAULT, ABEND)
REPERROR (1403, DISCARD)
REPERROR (1,    DISCARD)

-- CDR: resolve UPDATE conflicts by keeping the row with the later timestamp
MAP hr.employees, TARGET hr.employees,
  RESOLVECONFLICT (UPDATEROWEXISTS,
    (DEFAULT, USEMAX (last_updated_date)));

MAP hr.departments, TARGET hr.departments,
  RESOLVECONFLICT (UPDATEROWEXISTS,
    (DEFAULT, USEMAX (last_updated_date)));

MAP oe.orders, TARGET oe.orders,
  RESOLVECONFLICT (UPDATEROWEXISTS,
    (DEFAULT, USEMAX (last_updated_date)));

MAP oe.order_items, TARGET oe.order_items,
  RESOLVECONFLICT (UPDATEROWEXISTS,
    (DEFAULT, USEMAX (last_updated_date)));
\`\`\`

### 7c. Add the Site A Replicat group

\`\`\`
-- Site A GGSCI
DBLOGIN USERID ggadmin@DBLIVE_A PASSWORD "GGAdmin#2026"
ADD REPLICAT rep_a, EXTTRAIL ./dirdat/ra, CHECKPOINTTABLE ggadmin.chkptab
\`\`\`

### 7d. Site B — Replicat parameter file (\`dirprm/rep_b.prm\`)

Site B's Replicat applies changes that arrived from Site A. It stamps those applied transactions with tag \`02\` so that Site B's Extract ignores them.

\`\`\`
REPLICAT rep_b
TARGETDB DBLIVE_B, USERID ggadmin, PASSWORD "GGAdmin#2026"
ASSUMETARGETDEFS

-- Stamp every transaction applied by this Replicat with tag 02
-- Site B's Extract is configured with EXCLUDETAG 02 to ignore these
DBOPTIONS SETTAG 02

HANDLECOLLISIONS

DISCARDFILE ./dirrpt/rep_b.dsc, APPEND, MEGABYTES 100

REPERROR (DEFAULT, ABEND)
REPERROR (1403, DISCARD)
REPERROR (1,    DISCARD)

MAP hr.employees, TARGET hr.employees,
  RESOLVECONFLICT (UPDATEROWEXISTS,
    (DEFAULT, USEMAX (last_updated_date)));

MAP hr.departments, TARGET hr.departments,
  RESOLVECONFLICT (UPDATEROWEXISTS,
    (DEFAULT, USEMAX (last_updated_date)));

MAP oe.orders, TARGET oe.orders,
  RESOLVECONFLICT (UPDATEROWEXISTS,
    (DEFAULT, USEMAX (last_updated_date)));

MAP oe.order_items, TARGET oe.order_items,
  RESOLVECONFLICT (UPDATEROWEXISTS,
    (DEFAULT, USEMAX (last_updated_date)));
\`\`\`

### 7e. Add the Site B Replicat group

\`\`\`
-- Site B GGSCI
DBLOGIN USERID ggadmin@DBLIVE_B PASSWORD "GGAdmin#2026"
ADD REPLICAT rep_b, EXTTRAIL ./dirdat/rb, CHECKPOINTTABLE ggadmin.chkptab
\`\`\`

---

## Step 8 — Start All Processes in Order

The startup sequence matters. Extracts must be running before Replicats, so that when a Replicat applies and stamps a transaction, the Extract on the same site is already filtering those tags.

### 8a. Start both Extracts first

\`\`\`
-- Site A GGSCI
START EXTRACT ext_a
INFO EXTRACT ext_a

-- Site B GGSCI
START EXTRACT ext_b
INFO EXTRACT ext_b
\`\`\`

**Expected on both:** \`EXTRACT Running\`

Confirm logmining servers are active on both sites:

\`\`\`sql
-- Run on both sites as SYSDBA
SELECT CAPTURE_NAME, STATUS, CAPTURED_SCN FROM DBA_CAPTURE
WHERE CAPTURE_NAME LIKE 'OGG%';
\`\`\`

### 8b. Start both Data Pumps

\`\`\`
-- Site A GGSCI
START EXTRACT dpump_a
INFO EXTRACT dpump_a

-- Site B GGSCI
START EXTRACT dpump_b
INFO EXTRACT dpump_b
\`\`\`

Wait 30 seconds and verify remote trail files exist on each site:

\`\`\`bash
# Site A host — should see rb* files (arriving from Site B)
ls -lh $OGG_HOME/dirdat/ra*

# Site B host — should see ra* files (arriving from Site A)
ls -lh $OGG_HOME/dirdat/rb*
\`\`\`

### 8c. Start both Replicats

\`\`\`
-- Site A GGSCI
START REPLICAT rep_a
INFO REPLICAT rep_a

-- Site B GGSCI
START REPLICAT rep_b
INFO REPLICAT rep_b
\`\`\`

---

## Step 9 — Post-Start Verification

### 9a. Check all processes on both sites

\`\`\`
-- Both sites GGSCI
INFO ALL
\`\`\`

**Expected on each site:**

\`\`\`
Program     Status      Group       Lag at Chkpt  Time Since Chkpt
MANAGER     RUNNING
EXTRACT     RUNNING     EXT_x       00:00:xx      00:00:xx
EXTRACT     RUNNING     DPUMP_x     00:00:xx      00:00:xx
REPLICAT    RUNNING     REP_x       00:00:xx      00:00:xx
\`\`\`

### 9b. Verify loop prevention is working

Write a row on Site A and confirm it appears on Site B but is NOT re-captured and sent back:

\`\`\`sql
-- Site A
UPDATE hr.employees
SET salary = salary + 100, last_updated_date = SYSTIMESTAMP
WHERE employee_id = 100;
COMMIT;
\`\`\`

Wait 10 seconds then check:

\`\`\`sql
-- Site B — should show the updated salary
SELECT employee_id, salary, last_updated_date
FROM hr.employees WHERE employee_id = 100;
\`\`\`

Now confirm Site B's Extract statistics show **zero** operations on \`hr.employees\` from this update (the Replicat applied it with tag 02, so the Extract skipped it):

\`\`\`
-- Site B GGSCI
STATS EXTRACT ext_b, TABLE hr.employees, TOTAL
\`\`\`

The output counters should **not** have incremented by 1 for the update you just applied through the Replicat.

### 9c. Verify bidirectional flow — write on Site B

\`\`\`sql
-- Site B
UPDATE hr.employees
SET salary = salary + 200, last_updated_date = SYSTIMESTAMP
WHERE employee_id = 101;
COMMIT;
\`\`\`

\`\`\`sql
-- Site A — should show the updated salary within a few seconds
SELECT employee_id, salary, last_updated_date
FROM hr.employees WHERE employee_id = 101;
\`\`\`

### 9d. Simulate a conflict and verify CDR resolution

Write to the same row on both sites within the same second:

\`\`\`sql
-- Site A
UPDATE hr.employees
SET salary = 7000, last_updated_date = SYSTIMESTAMP
WHERE employee_id = 102;
COMMIT;

-- Site B (run immediately after Site A)
UPDATE hr.employees
SET salary = 9000, last_updated_date = SYSTIMESTAMP
WHERE employee_id = 102;
COMMIT;
\`\`\`

Wait 15 seconds then check both sites:

\`\`\`sql
-- Run on BOTH sites
SELECT employee_id, salary, last_updated_date
FROM hr.employees WHERE employee_id = 102;
\`\`\`

Both sites should converge to the same salary value — whichever update had the later \`last_updated_date\`. If the timestamps are identical, the result is deterministic based on which Replicat applied last — this is acceptable in practice because true simultaneous updates at the microsecond level are rare.

### 9e. Check CDR conflict statistics

\`\`\`sql
-- Run on both sites as SYSDBA
SELECT REPLICAT_NAME, CONFLICT_TYPE, RESOLUTION_FUNCTION,
       TOTAL_CONFLICTS, LAST_CONFLICT_TIME
FROM DBA_GG_CDR_STATISTICS
ORDER BY LAST_CONFLICT_TIME DESC;
\`\`\`

### 9f. Remove HANDLECOLLISIONS once lag reaches zero

\`\`\`
-- Site A GGSCI
SEND REPLICAT rep_a, NOHANDLECOLLISIONS

-- Site B GGSCI
SEND REPLICAT rep_b, NOHANDLECOLLISIONS
\`\`\`

Edit both \`rep_a.prm\` and \`rep_b.prm\` and remove or comment out \`HANDLECOLLISIONS\`.

---

## Step 10 — Ongoing Monitoring

### All process statuses and lag

\`\`\`
-- Both sites GGSCI
INFO ALL
LAG EXTRACT ext_a      (or ext_b)
LAG EXTRACT dpump_a    (or dpump_b)
LAG REPLICAT rep_a     (or rep_b)
\`\`\`

### Replicat statistics including conflict counts

\`\`\`
GGSCI> STATS REPLICAT rep_a, TOTAL
GGSCI> STATS REPLICAT rep_b, TOTAL
\`\`\`

### Logmining server health on both sites

\`\`\`sql
SELECT CAPTURE_NAME, STATUS, CAPTURED_SCN, APPLIED_SCN,
       TOTAL_MESSAGES_CAPTURED, TOTAL_MESSAGES_ENQUEUED,
       ERROR_MESSAGE
FROM DBA_CAPTURE
WHERE CAPTURE_NAME LIKE 'OGG%';
\`\`\`

### CDR conflict history

\`\`\`sql
SELECT REPLICAT_NAME, OBJECT_OWNER, OBJECT_NAME,
       CONFLICT_TYPE, RESOLUTION_FUNCTION,
       TOTAL_CONFLICTS, RESOLVED_CONFLICTS, UNRESOLVED_CONFLICTS
FROM DBA_GG_CDR_STATISTICS;
\`\`\`

A growing \`UNRESOLVED_CONFLICTS\` count indicates the CDR policy could not determine a winner (e.g. both timestamps are identical and no tiebreaker column exists). Review the discard file immediately:

\`\`\`bash
tail -200 $OGG_HOME/dirrpt/rep_a.dsc
tail -200 $OGG_HOME/dirrpt/rep_b.dsc
\`\`\`

---

## Troubleshooting

### Replication loop detected — Extract capturing its own Replicat's changes

Symptom: After Site B's Replicat applies a change, Site B's Extract re-captures it, sends it to Site A, Site A's Replicat applies it, Site A's Extract re-captures it, and so on. You will see the same row's operation count climbing on both Extract stat outputs indefinitely.

Diagnosis:

\`\`\`
GGSCI> STATS EXTRACT ext_b, TABLE hr.employees, TOTAL
\`\`\`

If counters increment after only the Replicat applied (no direct user writes), loop prevention is misconfigured. Check:

- \`DBOPTIONS SETTAG 02\` is present in \`rep_b.prm\`
- \`TRANLOGOPTIONS EXCLUDETAG 02\` is present in \`ext_b.prm\`
- Tag values are **not swapped** between the two sites
- Both parameter files were reloaded after any edits (restart the processes)

### Conflict not being resolved — Replicat abending with ORA-00001

\`\`\`
-- Check whether the affected table has a CDR MAP statement
-- Check that the CDR column (last_updated_date) exists on the target table
SELECT column_name FROM dba_tab_columns
WHERE owner = 'HR' AND table_name = 'EMPLOYEES'
  AND column_name = 'LAST_UPDATED_DATE';
\`\`\`

If the CDR column is missing on the target, the \`USEMAX\` directive has nothing to compare and the conflict goes unresolved. Add the column and re-run the initial load for that table.

### Extract not excluding Replicat-applied transactions — EXCLUDETAG not taking effect

\`\`\`
-- Confirm ENABLE_GOLDENGATE_REPLICATION is TRUE on the source
-- SETTAG requires this parameter to write the tag into the redo stream
SHOW PARAMETER ENABLE_GOLDENGATE_REPLICATION;
\`\`\`

If \`FALSE\`, the tag is never written and \`EXCLUDETAG\` has nothing to match. Set it to \`TRUE\` and restart all processes.

### Replicat abends with ORA-01403 (no data found)

The row being updated or deleted exists on the source but not the target. Causes:

- Initial load was incomplete for that table
- A prior Replicat abend caused missed inserts
- The CDR policy discarded an insert that should have been applied

Resolution:

\`\`\`
-- Re-enable HANDLECOLLISIONS temporarily
GGSCI> SEND REPLICAT rep_a, HANDLECOLLISIONS

-- Identify missing rows from discard file
-- Selectively re-synchronize the affected table with expdp/impdp
-- Remove HANDLECOLLISIONS once lag returns to zero
\`\`\`

### DBA_CAPTURE STATUS = ABORTED on one site after failover

When a planned failover or switchover occurs between sites, the logmining server on the previously active site may abort because its redo stream advanced past the registered Extract SCN. Recovery steps:

\`\`\`
-- Stop the aborted Extract
GGSCI> STOP EXTRACT ext_a

-- Unregister and re-register
GGSCI> DBLOGIN USERID ggadmin@DBLIVE_A PASSWORD "GGAdmin#2026"
GGSCI> UNREGISTER EXTRACT ext_a DATABASE
GGSCI> REGISTER EXTRACT ext_a DATABASE

-- Advance the Extract to the current SCN on the database
-- (do not re-run initial load unless data has diverged)
GGSCI> ALTER EXTRACT ext_a, SCN <current_scn_from_v_database>

GGSCI> START EXTRACT ext_a
\`\`\`

---

## Rollback

### Stop all processes on both sites

\`\`\`
-- Site A GGSCI
STOP EXTRACT ext_a
STOP EXTRACT dpump_a
STOP REPLICAT rep_a

-- Site B GGSCI
STOP EXTRACT ext_b
STOP EXTRACT dpump_b
STOP REPLICAT rep_b
\`\`\`

### Unregister and delete Extracts

\`\`\`
-- Site A GGSCI
DBLOGIN USERID ggadmin@DBLIVE_A PASSWORD "GGAdmin#2026"
UNREGISTER EXTRACT ext_a DATABASE
DELETE EXTRACT ext_a
DELETE EXTRACT dpump_a
DELETE EXTTRAIL ./dirdat/la*
DELETE RMTTRAIL ./dirdat/ra*

-- Site B GGSCI
DBLOGIN USERID ggadmin@DBLIVE_B PASSWORD "GGAdmin#2026"
UNREGISTER EXTRACT ext_b DATABASE
DELETE EXTRACT ext_b
DELETE EXTRACT dpump_b
DELETE EXTTRAIL ./dirdat/lb*
DELETE RMTTRAIL ./dirdat/rb*
\`\`\`

### Delete Replicats

\`\`\`
-- Site A GGSCI
DELETE REPLICAT rep_a

-- Site B GGSCI
DELETE REPLICAT rep_b
\`\`\`

### Verify logmining registrations are removed

\`\`\`sql
-- Both sites as SYSDBA
SELECT COUNT(*) FROM DBA_CAPTURE WHERE CAPTURE_NAME LIKE 'OGG%';
-- Expected: 0 on both sites
\`\`\`

### Remove supplemental logging

\`\`\`sql
-- Both sites as SYSDBA
ALTER TABLE hr.employees    DROP SUPPLEMENTAL LOG DATA (ALL) COLUMNS;
ALTER TABLE hr.departments  DROP SUPPLEMENTAL LOG DATA (ALL) COLUMNS;
ALTER TABLE oe.orders       DROP SUPPLEMENTAL LOG DATA (ALL) COLUMNS;
ALTER TABLE oe.order_items  DROP SUPPLEMENTAL LOG DATA (ALL) COLUMNS;
ALTER DATABASE DROP SUPPLEMENTAL LOG DATA;
\`\`\`

### Revert ENABLE_GOLDENGATE_REPLICATION

\`\`\`sql
-- Both sites as SYSDBA
ALTER SYSTEM SET ENABLE_GOLDENGATE_REPLICATION = FALSE SCOPE=BOTH;
\`\`\`

### Drop OGG database users

\`\`\`sql
-- Both sites as SYSDBA
DROP USER ggadmin CASCADE;
\`\`\``,
};

async function main() {
  console.log('Inserting GoldenGate bidirectional runbook post...');
  await db.insert(posts).values(post).onConflictDoNothing();
  console.log(`Inserted: "${post.title}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
