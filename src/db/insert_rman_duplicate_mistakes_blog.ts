import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'rman-duplicate-common-mistakes';

const content = `
RMAN duplicate is one of the most powerful tools in an Oracle DBA's kit. It creates a complete, consistent copy of a database — or a subset of one — without requiring the source to be offline. It handles channel allocation, data file copy, controlfile creation, archive log recovery, and RESETLOGS in a single coordinated operation. It also has enough sharp edges to cut a professional who is not paying close attention.

This post covers the mistakes that appear most frequently in real production recoveries, with the error they produce and the fix for each.

---

## 1. Typo in the Source Database Name

RMAN backup-location-based duplicate searches for the source database's controlfile autobackup using the name you supply. A transposition — \`CBDPROD\` instead of \`CDBPROD\`, for example — causes RMAN to search for a controlfile backup that does not exist under that name:

\`\`\`
RMAN-05578: CONTROLFILE backup not found for database CBDPROD in /backups/
\`\`\`

RMAN does not treat this as a typo warning. It treats it as a missing backup and aborts the duplicate.

**Fix:** Always double-check the source database name before running duplicate. Verify it against the production database:

\`\`\`sql
SELECT name FROM v\$database;
\`\`\`

Then add the \`DBID\` clause to bypass name-based controlfile search entirely (see mistake #2).

---

## 2. Omitting the DBID Clause When Using BACKUP LOCATION

When you run a backup-location-based duplicate without an RMAN catalog, RMAN must locate the controlfile autobackup on disk. Controlfile autobackups are named after the database's DBID — a numeric identifier — in the format \`c-<DBID>-<date>-<seq>\`. RMAN searches for a backup named after the database name you specified, then maps that to the DBID.

If the name lookup fails for any reason (typo, case mismatch, or the name in the autobackup does not match what RMAN expects), the duplicate fails. Adding the \`DBID\` clause bypasses the name-based lookup entirely and tells RMAN to search directly by the numeric identifier:

\`\`\`
run {
  allocate auxiliary channel ch1 device type disk;

  duplicate database CDBPROD DBID 1234567890 to CDBDEST
  backup location '/backups/cdbprod/';
}
\`\`\`

**Fix:** Before running any backup-location duplicate, obtain the source DBID and include it explicitly:

\`\`\`sql
-- On the source database
SELECT dbid, name FROM v\$database;
\`\`\`

---

## 3. Running RMAN Interactively Without nohup

A backup-based duplicate of a production database takes hours. Running it interactively from a terminal means the job is tied to the SSH session. When the session disconnects — network hiccup, VPN timeout, screen lock — RMAN receives SIGHUP and exits mid-duplicate. The auxiliary database is left in a partially recovered state.

\`\`\`bash
# This will die when the session drops
rman auxiliary / @duplicate.rman
\`\`\`

**Fix:** Always run long RMAN operations with nohup and redirect output to a log file:

\`\`\`bash
nohup rman auxiliary / @duplicate.rman \
  > $HOME/duplicate.log 2>&1 0</dev/null &

echo "RMAN PID: $!"

# Monitor from any terminal
tail -100f $HOME/duplicate.log
\`\`\`

If you do lose the session, reconnect and check whether RMAN is still running before assuming it died:

\`\`\`bash
ps -ef | grep [r]man
tail -20 $HOME/duplicate.log
\`\`\`

---

## 4. Auxiliary Instance Not in NOMOUNT

For a backup-based duplicate, RMAN must connect to the auxiliary instance before the duplicate begins. The auxiliary must be in NOMOUNT state — it cannot be in MOUNT or OPEN, and it cannot be shut down. If the auxiliary is shut down, RMAN connection fails. If it is in OPEN state from a previous partial recovery, the duplicate may behave unexpectedly.

\`\`\`
RMAN-04006: error from auxiliary database: ORA-01034: ORACLE not available
\`\`\`

**Fix:** Start the auxiliary in NOMOUNT before connecting RMAN:

\`\`\`sql
-- On the auxiliary host
export ORACLE_SID=CDBDEST
sqlplus / as sysdba

SHUTDOWN ABORT;
STARTUP NOMOUNT;
\`\`\`

Confirm the state:

\`\`\`sql
SELECT status FROM v\$instance;
-- Expected: STARTED
\`\`\`

---

## 5. No init.ora or SPFILE on the Auxiliary

The auxiliary instance must have a parameter file to start NOMOUNT. RMAN will create the auxiliary's final SPFILE during the duplicate, but the instance needs at least a minimal init.ora to get to NOMOUNT in the first place. A common mistake is to run the duplicate on a freshly provisioned server with no parameter file at all.

The minimum required init.ora for NOMOUNT:

\`\`\`
db_name=CDBDEST
\`\`\`

**Fix:** Create a minimal init.ora in \`$ORACLE_HOME/dbs/init<SID>.ora\` before starting the auxiliary. RMAN will replace it with a properly populated SPFILE during the duplicate.

For CDB duplicates, also confirm the \`enable_pluggable_database\` parameter matches the source:

\`\`\`
db_name=CDBDEST
enable_pluggable_database=true
\`\`\`

---

## 6. Wrong Channel Type: TARGET Instead of AUXILIARY

The most common RMAN channel mistake in duplicate operations is allocating TARGET channels when AUXILIARY channels are required (or vice versa). Backup-based duplicates that read from a disk backup location require AUXILIARY channels, not TARGET channels. Channels allocated to the wrong role simply go unused, reducing parallelism without producing an error — the duplicate runs on fewer channels than expected.

\`\`\`
run {
  -- Wrong for backup-based duplicate:
  allocate channel ch1 device type disk;   -- this is a TARGET channel

  -- Correct:
  allocate auxiliary channel ch1 device type disk;
}
\`\`\`

For active database duplicate (where RMAN streams directly from the source), both TARGET and AUXILIARY channels are required:

\`\`\`
run {
  -- Active duplicate: allocate both
  allocate channel     src1 device type disk;
  allocate auxiliary channel dst1 device type disk;

  duplicate target database to CDBDEST from active database;
}
\`\`\`

**Fix:** For backup-location duplicate, use \`ALLOCATE AUXILIARY CHANNEL\`. For active duplicate, allocate both types.

---

## 7. Insufficient Disk Space on the Auxiliary

RMAN duplicate copies every data file in scope, plus archive logs needed for recovery. The auxiliary host must have enough free space for all data files plus the archive logs required to bring the duplicate to consistency. A common mistake is checking the source data file sizes but forgetting to account for:

- Archive log files that RMAN stages to the auxiliary during recovery
- The auxiliary's flash recovery area (FRA) if configured
- Temp files (recreated, not copied, but space must exist)
- Undo tablespace (copied in full)

\`\`\`bash
# Check data file total size on source
sqlplus / as sysdba <<'SQLEOF'
SELECT ROUND(SUM(bytes)/1024/1024/1024, 2) AS total_gb
FROM dba_data_files;
SQLEOF

# Check available space on auxiliary data mount
df -h /u01/dest /u02/dest /u03/dest 2>/dev/null
\`\`\`

**Fix:** Check both source data file sizes and available auxiliary disk space before starting. Add at least 20% headroom for archive logs and FRA overhead.

---

## 8. Missing DB_FILE_NAME_CONVERT When Paths Differ

When the source database data files live on different paths than the auxiliary target paths, RMAN needs to know how to remap them. Without \`DB_FILE_NAME_CONVERT\`, RMAN attempts to place the auxiliary data files at the exact same paths as the source — which fails if those paths do not exist or are not writable on the auxiliary host.

\`\`\`
RMAN-05001: auxiliary filename /u01/prod/data/system01.dbf conflicts with a file used by the target database
\`\`\`

**Fix:** Use \`DB_FILE_NAME_CONVERT\` in the duplicate command to remap source paths to auxiliary paths:

\`\`\`
duplicate database CDBPROD to CDBDEST
backup location '/backups/cdbprod/'
db_file_name_convert('/u01/prod', '/u01/dest',
                     '/u02/prod', '/u02/dest')
logfile
  group 1 ('/u01/dest/redo/redo01.log') size 200M,
  group 2 ('/u01/dest/redo/redo02.log') size 200M,
  group 3 ('/u01/dest/redo/redo03.log') size 200M;
\`\`\`

Alternatively, set it as an auxiliary initialization parameter before starting the duplicate:

\`\`\`sql
ALTER SYSTEM SET db_file_name_convert='/u01/prod','/u01/dest' SCOPE=SPFILE;
\`\`\`

For CDB duplicates with PDB data files in separate paths, list all source-to-destination path pairs.

---

## 9. Not Specifying LOG_FILE_NAME_CONVERT for Redo Logs

Redo log path conversion is separate from data file conversion. If \`DB_FILE_NAME_CONVERT\` remaps data files but \`LOG_FILE_NAME_CONVERT\` (or inline \`LOGFILE\` clause) is not specified, RMAN attempts to create redo logs at the source redo log paths. If those paths exist on the auxiliary — for example, if the duplicate is on the same host as the source — this produces a conflict.

**Fix:** Always specify the \`LOGFILE\` clause or \`LOG_FILE_NAME_CONVERT\` to explicitly place auxiliary redo logs:

\`\`\`
duplicate database CDBPROD to CDBDEST
backup location '/backups/cdbprod/'
db_file_name_convert('/u01/prod', '/u01/dest')
logfile
  group 1 ('/u01/dest/redo/redo01a.log',
            '/u02/dest/redo/redo01b.log') size 200M,
  group 2 ('/u01/dest/redo/redo02a.log',
            '/u02/dest/redo/redo02b.log') size 200M;
\`\`\`

---

## 10. PDB Name Mismatch After CDB Duplicate

When duplicating a CDB, the PDB inside the duplicate inherits the source PDB's name. If the target environment expects a different PDB name — a QA environment expects a PDB named \`QA\` but the source PDB is named \`PROD\` — clients connecting by PDB service name will fail with ORA-12514.

This is not an RMAN error. The duplicate completes successfully. The name mismatch only surfaces when applications try to connect.

**Fix:** After the duplicate completes, rename the PDB:

\`\`\`sql
ALTER PLUGGABLE DATABASE prod CLOSE IMMEDIATE;
ALTER PLUGGABLE DATABASE prod OPEN RESTRICTED;
ALTER SESSION SET CONTAINER = prod;
ALTER PLUGGABLE DATABASE RENAME GLOBAL_NAME TO qa;
ALTER PLUGGABLE DATABASE CLOSE IMMEDIATE;
ALTER PLUGGABLE DATABASE OPEN;
\`\`\`

---

## 11. Oracle Bug 31143870: Orphaned Service Registrations After PDB Rename

After renaming a PDB in a duplicated CDB, the PDB may fail to open due to stale service entries in \`SYS.SERVICE$\` that reference the source environment — services named after the source host, source SID, or other source-specific identifiers.

This is Oracle Bug 31143870. The symptom is the PDB entering an unexpected error state during OPEN after a rename.

**Diagnosis:**

\`\`\`sql
SELECT name FROM sys.service$
WHERE name NOT IN (SELECT service_name FROM dba_services WHERE service_name IS NOT NULL);
\`\`\`

**Fix:** Delete the orphaned service entry, then unplug and replug the PDB:

\`\`\`sql
EXEC DBMS_SERVICE.DELETE_SERVICE(service_name => '<orphaned_service_name>');
DELETE FROM sys.service$ WHERE name = '<orphaned_service_name>';
COMMIT;

ALTER PLUGGABLE DATABASE qa UNPLUG INTO '/tmp/qa.xml';
DROP PLUGGABLE DATABASE qa KEEP DATAFILES;
SHUTDOWN IMMEDIATE;
STARTUP;
CREATE PLUGGABLE DATABASE qa USING '/tmp/qa.xml' NOCOPY;
ALTER PLUGGABLE DATABASE qa OPEN;
ALTER PLUGGABLE DATABASE qa SAVE STATE;
\`\`\`

---

## 12. Forgetting That Duplicate Always Opens With RESETLOGS

Every RMAN duplicate — backup-based or active — opens the auxiliary database with RESETLOGS. This creates a new database incarnation. If the duplicate target was previously an active database with its own backups and RMAN catalog entries, those backup records are now tied to a superseded incarnation and cannot be used for point-in-time recovery without resetting the incarnation context first.

**Implications:**
- Any existing RMAN backups of the auxiliary database are no longer usable without \`RESET DATABASE TO INCARNATION\`
- The SCN sequence restarts at the RESETLOGS SCN
- Archive logs from before RESETLOGS cannot be applied to the new incarnation

**Fix:** Treat every duplicate target as a new database from the RESETLOGS point forward. Take a new level-0 backup of the auxiliary immediately after the duplicate completes if the auxiliary needs to be independently recoverable.

---

## 13. Not Accounting for Archive Log Retention During Long Duplicates

Backup-based duplicate must recover the auxiliary forward using archive logs from the source. If the source database purges archive logs (via \`DELETE ARCHIVELOG\` or FRA space pressure) during the many hours the duplicate is running, the duplicate may fail when it needs an archive log that was deleted from the source:

\`\`\`
RMAN-06054: media recovery requesting unknown archived log for thread 1 with sequence 4821 and starting SCN of ...
\`\`\`

**Fix:** Before starting a long duplicate:

1. Ensure the source's archive log retention policy retains at least 2× the expected duplicate runtime
2. Disable scheduled RMAN archive log deletion jobs on the source for the duration of the duplicate
3. Consider using \`UNTIL TIME\` or \`UNTIL SCN\` in the duplicate command to limit how far forward the auxiliary needs to recover

\`\`\`
duplicate database CDBPROD DBID 1234567890 to CDBDEST
backup location '/backups/cdbprod/'
until time "to_date('2026-01-15 20:00:00','YYYY-MM-DD HH24:MI:SS')";
\`\`\`

---

## 14. Using Active Duplicate Without Sufficient Network Bandwidth

Active database duplicate (\`FROM ACTIVE DATABASE\`) streams data files directly from the source over the Oracle Net connection, without using on-disk backups. On a low-bandwidth link — a WAN connection or a congested internal network — this can take far longer than expected and put sustained load on the source database.

At 100 Mb/s and 70% utilization, a 2 TB database takes approximately 5 hours. On a busy production network sharing bandwidth with application traffic, this can disrupt application performance.

**Fix:** Use backup-based duplicate across a WAN. Reserve active duplicate for environments where source and auxiliary are on the same high-bandwidth network segment. If active duplicate is necessary, use the \`SECTION SIZE\` clause to parallelize the transfer:

\`\`\`
run {
  allocate channel     src1 device type disk;
  allocate channel     src2 device type disk;
  allocate auxiliary channel dst1 device type disk;
  allocate auxiliary channel dst2 device type disk;

  duplicate target database to CDBDEST
  from active database
  section size 500M;
}
\`\`\`

---

## 15. No Password File on the Auxiliary for Remote Connections

When RMAN connects to the auxiliary remotely (not via OS authentication with \`/\`), the auxiliary must have a password file. Without it, RMAN receives:

\`\`\`
RMAN-04006: error from auxiliary database: ORA-01031: insufficient privileges
\`\`\`

**Fix:** Create a password file on the auxiliary host before connecting remotely:

\`\`\`bash
# Oracle 12c and earlier
orapwd file=$ORACLE_HOME/dbs/orapwCDBDEST password=<sys_password> entries=10

# Oracle 19c (use format=12.2 for compatibility)
orapwd file=$ORACLE_HOME/dbs/orapwCDBDEST password=<sys_password> format=12.2
\`\`\`

The SYS password in the auxiliary password file must match the SYS password specified in the RMAN connection string.

---

## Summary

Most RMAN duplicate failures fall into one of three categories: pre-flight omissions (no password file, wrong init.ora, disk space not checked), command construction errors (wrong channel type, missing DBID clause, name typo, missing path conversion), and post-duplicate surprises (PDB name mismatch, Bug 31143870, RESETLOGS implications, archive log gaps).

The single most effective safeguard is the \`DBID\` clause — specifying the source database's numeric identifier bypasses the name-based controlfile search entirely. The second most effective is \`nohup\` — a duplicate that survives session disconnects runs to completion regardless of network conditions. Everything else in this list is a matter of checking the environment before running the command rather than diagnosing the failure after it.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'Common Mistakes When Running RMAN DUPLICATE — and How to Avoid Them',
    slug,
    excerpt: 'RMAN DUPLICATE is powerful but has sharp edges. This post covers 15 common mistakes: database name typos causing RMAN-05578, omitting the DBID clause, running without nohup and losing the session mid-duplicate, auxiliary not in NOMOUNT, wrong channel type (TARGET vs AUXILIARY), missing path conversion, PDB name mismatch after CDB duplicate, Oracle Bug 31143870 orphaned service registrations, archive log gaps during long duplicates, and RESETLOGS incarnation implications.',
    content,
    category: 'disaster-recovery',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
