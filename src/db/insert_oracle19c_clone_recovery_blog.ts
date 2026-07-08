import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'oracle-19c-cdb-recovery-failed-clone-rman-duplicate-pdb-rename';

const content = `
A nightly job that clones a production Oracle database to a QA environment is one of the most reliable ways to keep non-production environments current. When that job aborts halfway through, it leaves behind a partially overwritten database that cannot be mounted — and suddenly the path back to a working QA environment is anything but obvious.

This post walks through exactly that scenario on Oracle Database 19.10 running on Red Hat Enterprise Linux, standalone filesystem. The QA database could not be started past NOMOUNT. No QA-specific backups existed in the backup location. The production backups were accessible from the QA host. What follows is how recovery was achieved using RMAN backup-based duplicate, the mistakes that prolonged it, and the Oracle bug that surfaced during PDB cleanup.

---

## The Starting State

The environment:

- **Production:** CDB named CDBPROD containing a single PDB named PROD
- **QA:** CDB named CDBQA, expected to contain a PDB named QA
- **Oracle version:** 19.10.0.0.0
- **OS:** Red Hat Enterprise Linux 7.7
- **Storage:** Local filesystem (no ASM)
- **RMAN catalog:** None (target database control file only)

The nightly clone job was aborted partway through. Attempting to start the QA database beyond NOMOUNT failed. RMAN connected to the target but could not run LIST commands because the database was not mounted:

\`\`\`
RMAN> list backup of database summary completed after "sysdate-30";
RMAN-03002: failure of list command at 02/09/2026 14:45:52
ORA-01507: database not mounted
\`\`\`

No QA database backup records were accessible — the only backups found in the designated location were controlfile autobackups from the production database, plus the full production backup set. There were no QA data file backups.

---

## Why a Failed Clone Leaves the Auxiliary in NOMOUNT

When an Oracle RMAN duplicate (or a script-driven clone) is aborted mid-execution, the auxiliary instance is left in the state it was at the moment of interruption. If the abort happened after the auxiliary started but before the duplicate completed:

- The auxiliary database has no valid controlfile (or a partially restored one)
- The data files are partially copied or not yet replaced
- The instance can start to NOMOUNT (the parameter file is sufficient) but cannot MOUNT (requires a valid controlfile) or OPEN (requires consistent data files and redo logs)

Recovery from this state requires either:
1. Restoring from a QA-specific backup (if one exists), or
2. Re-running the duplicate from a valid source — in this case, production

---

## Confirming the Backup Inventory

Before attempting recovery, confirm what backups are actually accessible on the QA host:

\`\`\`bash
# List backup files and their dates
ls -ltrh /backups/dbprod01/ | tail -20

# List controlfile autobackups specifically
ls -ltrh /backups/dbprod01/c-* | tail -10
\`\`\`

In this case the listing showed the production backup set with files named according to the production DBID (a numeric identifier embedded in the controlfile autobackup filename, in the pattern \`c-<DBID>-<date>-<seq>\`):

\`\`\`
-rw-r----- 1 oracle dba  36M Feb 4  c-1234567890-20260204-00
-rw-r----- 1 oracle dba  36M Feb 8  c-1234567890-20260208-01
-rw-r----- 1 oracle dba  36M Feb 9  c-1234567890-20260209-01
-rw-r----- 1 oracle dba 140M Feb 9  CDBPROD_20260209_datafile_1
\`\`\`

The DBID in the controlfile autobackup name is the production database's DBID, not the QA database's DBID. This becomes important when specifying the duplicate command.

---

## Setting Up the RMAN Duplicate

The strategy: use \`DUPLICATE DATABASE ... BACKUP LOCATION\` to rebuild CDBQA from the production backups accessible on the QA host. The auxiliary instance (CDBQA) must be running in NOMOUNT before RMAN connects.

### Step 1: Start the auxiliary in NOMOUNT

\`\`\`bash
export ORACLE_SID=CDBQA
sqlplus / as sysdba
\`\`\`

\`\`\`sql
STARTUP NOMOUNT;
\`\`\`

### Step 2: Obtain the source database DBID

Connect to the production database and query the DBID. You need the exact DBID to locate the correct controlfile autobackup in the backup location:

\`\`\`sql
col dbid for 99999999999999999
col name for a15
SELECT dbid, name FROM v$database;
\`\`\`

Record the numeric DBID. In this example: \`1234567890\`.

### Step 3: Create the RMAN duplicate script

Write the script to a file so it can be run with nohup (critical for long-running duplicates — see below):

\`\`\`bash
cat > $HOME/duplicate_cdbqa.rman << 'EOF'
run {
  allocate auxiliary channel ch1 device type disk;
  allocate auxiliary channel ch2 device type disk;
  allocate auxiliary channel ch3 device type disk;
  allocate auxiliary channel ch4 device type disk;

  duplicate database CDBPROD DBID 1234567890 to CDBQA
  backup location '/backups/dbprod01/';
}
EOF
\`\`\`

The \`DBID\` clause tells RMAN which controlfile autobackup to use when it searches the backup location. Without it, RMAN searches by the database name string — and if the name used in the script does not exactly match the backup file naming convention, the controlfile search fails.

### Step 4: Run with nohup

Duplicate operations on production-sized databases take hours. Running RMAN interactively means the job dies if the SSH session drops. Use nohup:

\`\`\`bash
nohup rman auxiliary / @$HOME/duplicate_cdbqa.rman \
  > $HOME/duplicate_cdbqa.log 2>&1 0</dev/null &

echo "RMAN PID: $!"

# Monitor progress
tail -100f $HOME/duplicate_cdbqa.log
\`\`\`

If the session is lost, reconnect and check whether RMAN is still running:

\`\`\`bash
ps -ef | grep [r]man

tail -20 $HOME/duplicate_cdbqa.log
\`\`\`

Because the job was started with \`nohup &\`, it continues after the session ends. Do not restart it unless the log confirms it has actually exited.

---

## Common Failure: RMAN-05578 and the Database Name Typo

The first duplicate attempt in this case failed with:

\`\`\`
RMAN-05578: CONTROLFILE backup not found for database CDBPROD in /backups/dbprod01/
\`\`\`

The actual RMAN script had a transposition error: \`CBDPROD\` instead of \`CDBPROD\`. RMAN searched the backup location for a controlfile autobackup named after the typo'd database name and found nothing. The controlfile autobackup files were named with the correct production DBID — but without the explicit \`DBID\` clause, the name-based search failed silently.

The fix: specify the \`DBID\` clause explicitly, which tells RMAN to search by the numeric identifier rather than the database name string:

\`\`\`
duplicate database CDBPROD DBID 1234567890 to CDBQA
backup location '/backups/dbprod01/';
\`\`\`

With the correct DBID, RMAN locates the controlfile autobackup immediately and proceeds.

A successful duplicate ends with:

\`\`\`
sql statement: alter pluggable database all open
Finished Duplicate Db at 11-FEB-26

Recovery Manager complete.
\`\`\`

---

## Post-Duplicate: PDB Name Mismatch

After the duplicate completes, the QA CDB is a copy of the production CDB. The PDB inside it is named PROD (because it was cloned from the production PDB named PROD). The client's TNS entries and application connections expected a PDB named QA.

Verify the current PDB name:

\`\`\`sql
SELECT pdb_name, status FROM dba_pdbs;
\`\`\`

To rename the PDB from PROD to QA:

\`\`\`sql
-- Close the PDB
ALTER PLUGGABLE DATABASE prod CLOSE IMMEDIATE;

-- Open in restricted mode to allow rename
ALTER PLUGGABLE DATABASE prod OPEN RESTRICTED;

-- Switch context into the PDB
ALTER SESSION SET CONTAINER = prod;

-- Rename the PDB
ALTER PLUGGABLE DATABASE RENAME GLOBAL_NAME TO qa;

-- Close and reopen
ALTER PLUGGABLE DATABASE CLOSE IMMEDIATE;
ALTER PLUGGABLE DATABASE OPEN;
\`\`\`

---

## Oracle Bug 31143870: Orphaned Service Registrations After PDB Rename

After renaming the PDB and attempting to open it, the database may refuse to open or show unexpected errors. This is Oracle Bug 31143870, documented as: **ORA errors after cloning a remote PDB**.

The root cause: when a CDB is duplicated, the internal service registry (\`SYS.SERVICE$\`) carries over every service that existed in the source database, including internal system services and any custom services registered under the source environment's hostnames. After the PDB is renamed, Oracle attempts to reconcile the service registry and encounters stale entries — services that reference the source environment's hostname or other identifiers that do not exist in the QA environment.

Diagnosis: look for services named after the source database host or other source-specific identifiers:

\`\`\`sql
SELECT name, pdb FROM dba_services ORDER BY pdb, name;

SELECT name FROM sys.service$ WHERE name NOT IN (
  SELECT service_name FROM dba_services
);
\`\`\`

Resolution — two steps:

**Step 1: Delete the orphaned service**

\`\`\`sql
-- Connect as SYS to the CDB root
EXEC DBMS_SERVICE.DELETE_SERVICE(service_name => 'dbprod01.example.com');

DELETE FROM sys.service$ WHERE name = 'dbprod01.example.com';
COMMIT;
\`\`\`

**Step 2: Unplug and replug the PDB**

Deleting the service entry alone is not always sufficient to clear the internal state. The reliable fix is to unplug the PDB to an XML manifest, drop it (keeping data files), and replug it:

\`\`\`sql
-- Unplug the PDB to an XML manifest
ALTER PLUGGABLE DATABASE qa UNPLUG INTO '/tmp/qa.xml';

-- Drop the PDB (keep data files intact)
DROP PLUGGABLE DATABASE qa KEEP DATAFILES;

-- Restart the CDB to clear in-memory state
SHUTDOWN IMMEDIATE;
STARTUP;

-- Replug the PDB from the manifest
CREATE PLUGGABLE DATABASE qa USING '/tmp/qa.xml' NOCOPY;

-- Open the PDB
ALTER PLUGGABLE DATABASE qa OPEN;

-- Persist the open state across CDB restarts
ALTER PLUGGABLE DATABASE qa SAVE STATE;
\`\`\`

After the replug, the PDB opens cleanly. The SAVE STATE ensures it opens automatically on the next CDB startup.

---

## Restoring Listener Connectivity

After the duplicate and PDB rename, clients connecting to the QA database by service name may see:

\`\`\`
ORA-12514: TNS:listener does not currently know of service requested in connect descriptor
\`\`\`

This happens because the TNS entries in client and application configurations may point to a service name that no longer exists — either a custom service from the source environment, or the PDB's old service name.

Diagnose which services are currently registered with the listener:

\`\`\`bash
lsnrctl status CDBQA
\`\`\`

Check the Services Summary section of the output. The available service names are listed there. Compare against the service name in the client's TNS entry.

If a required service is missing, create it manually from within the PDB:

\`\`\`sql
-- Switch context to the PDB
ALTER SESSION SET CONTAINER = qa;

-- Create and start the expected service
EXEC DBMS_SERVICE.CREATE_SERVICE(
  service_name   => 'qa_service',
  network_name   => 'qa_service'
);

EXEC DBMS_SERVICE.START_SERVICE(service_name => 'qa_service');
\`\`\`

To point the service directly into a specific PDB from the root, set the container first:

\`\`\`sql
ALTER SESSION SET CONTAINER = qa;
EXEC DBMS_SERVICE.CREATE_SERVICE(service_name => 'qa_service', network_name => 'qa_service');
EXEC DBMS_SERVICE.START_SERVICE(service_name => 'qa_service');
\`\`\`

Verify the service registers with the listener:

\`\`\`bash
lsnrctl status CDBQA
# Confirm: Service "qa_service" has 1 instance(s)
\`\`\`

Then test connectivity from a client:

\`\`\`bash
sqlplus <user>/<password>@<host>:<port>/<service_name>
\`\`\`

---

## Summary

A failed nightly clone that leaves the auxiliary database in NOMOUNT can be recovered through RMAN backup-based duplicate using production backups accessible from the QA host — even when no QA-specific backups exist. The critical steps are:

1. Confirm the database is in NOMOUNT and cannot be recovered from local backups
2. Locate production backups accessible from the QA server
3. Obtain the exact production DBID before running the duplicate (avoids RMAN-05578)
4. Run RMAN duplicate with \`nohup\` to survive session disconnects
5. After duplicate completes, rename the PDB to match the expected QA name
6. Handle Oracle Bug 31143870 by deleting orphaned service entries and doing an unplug/replug cycle
7. Verify listener service registration and fix any missing services with DBMS_SERVICE

The DBID typo (transposing two letters in the database name) is a deceptively common mistake that causes RMAN to fail with RMAN-05578. Always specify the \`DBID\` clause explicitly when running a backup-location-based duplicate — it bypasses the name-matching logic entirely and goes straight to the controlfile autobackup by its numeric identifier.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'Recovering an Oracle 19c CDB After a Failed Nightly Clone: RMAN Backup-Based Duplicate and PDB Rename',
    slug,
    excerpt: 'A nightly production-to-QA clone job aborted midway, leaving the QA Oracle 19c CDB stranded in NOMOUNT with no local backups. This post covers the full recovery path: RMAN backup-based duplicate using production backups, avoiding RMAN-05578 with the DBID clause, running nohup for long duplicates, renaming the cloned PDB, and resolving Oracle Bug 31143870 (orphaned service registrations after PDB rename) via unplug/replug cycle.',
    content,
    category: 'disaster-recovery',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
