import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ora-01017-ora-16191-data-guard-rac-asm-password-file';

const content = `
Building a Data Guard physical standby during a live server migration is one of those tasks that looks clean on paper and turns immediately messy when the first MRP process starts applying redo and then stops. This post documents a real-world case on Oracle 12c and 19c RAC where ORA-01017 and ORA-16191 blocked redo transport for hours, explains why the usual fix — recreating the password file with \`orapwd\` — does not work when ASM manages the password file in a RAC cluster, and walks through the complete resolution using \`asmcmd pwcopy\` and \`srvctl modify\`.

---

## Introduction

The migration context was a three-node primary RAC cluster (primary-rac1, primary-rac2, primary-rac3) running a database named PRODDB, migrating to new physical hardware. A single-node standby named STBYDB (standby-node1) was built with RMAN active duplicate to a RAC One Node configuration, and Data Guard was configured manually. MRP started cleanly and applied several hundred archived logs before stopping.

The first sign of trouble was a thread gap query showing Thread 1 received sequence 5231 but only applied through 5198 — a gap of 33 redo log files sitting on the standby but not applied. Thread 2 had caught up at sequence 3847 applied, 3847 received — no gap on that thread at all. The asymmetry itself was diagnostic: Thread 1 was the thread active on the node running the transport processes, meaning the issue was in transport authentication, not in the apply layer.

\`\`\`sql
SELECT THREAD#, LOW_SEQUENCE#, HIGH_SEQUENCE#
FROM   V\$ARCHIVE_GAP;
\`\`\`

\`\`\`text
   THREAD# LOW_SEQUENCE# HIGH_SEQUENCE#
---------- ------------- --------------
         1          5199           5231
\`\`\`

The alert log on the standby confirmed what V\$ARCHIVE_GAP was showing: redo was arriving and being staged, but MRP was not applying it. Cross-checking V\$DATAGUARD_STATUS revealed the authentication errors that became the focus of the investigation.

---

## How Data Guard Uses Password Files for Transport Authentication

Data Guard redo transport is not a user-level connection. It is a SYS-authenticated connection made by the ARCn (Archiver) and FAL (Fetch Archive Log) background processes on the primary to deposit redo on the standby. These processes authenticate using the SYS password stored in the password file — not the database-level password verifier in the data dictionary. This matters because dictionary authentication is unavailable when a database is in mount-only mode, which is exactly the state a physical standby is in when MRP is running.

The transport mechanism works as follows:

1. An ARCn process on the primary opens a Net connection to the standby using the service name configured in \`LOG_ARCHIVE_DEST_n\`.
2. The connection authenticates as SYSDBA using the SYS password hash stored in the primary's password file.
3. The standby's listener accepts the connection and verifies the presented hash against the standby's own password file.
4. If the hashes match, the connection succeeds and the RFS process on the standby receives and stages the redo.
5. MRP picks up the staged redo and applies it.

Steps 3 and 4 are where ORA-01017 (invalid username/password) and ORA-16191 (primary log shipping client not connected with SYSDBA privilege) surface. They indicate that the SYS password hash in the primary's password file does not match the SYS password hash in the standby's password file. The databases cannot authenticate each other.

The \`REMOTE_LOGIN_PASSWORDFILE\` parameter must be set to \`EXCLUSIVE\` on both the primary and all standbys. A setting of \`NONE\` disables password file authentication entirely, which breaks redo transport. A setting of \`SHARED\` is not supported for Data Guard configurations in most Oracle releases.

---

## How ASM Changes the Password File Model

### 11g: Filesystem Password File

In Oracle Database 11g with a non-ASM configuration, the password file lives at:

\`\`\`text
\$ORACLE_HOME/dbs/orapw\$ORACLE_SID
\`\`\`

It is a flat binary file. Copying it from the primary to the standby — preserving binary fidelity — is sufficient to synchronize the SYS password hash. The standard fix was always:

\`\`\`bash
scp oracle@primary-rac1:\$ORACLE_HOME/dbs/orapwPRODDB \
    oracle@standby-node1:\$ORACLE_HOME/dbs/orapwSTBYDB
\`\`\`

### 12c and Later: ASM-Managed Password File

Starting with Oracle 12c in a RAC environment, the password file is stored inside an ASM disk group, not on the filesystem. Its canonical ASM path looks like:

\`\`\`text
+DATA/PRODDB/PASSWORD/orapwproddb
\`\`\`

The Clusterware (Grid Infrastructure) is responsible for managing this file. It is registered with CRS via \`srvctl\` so that Grid knows which ASM file is the active password file for the database. You can confirm the registered path:

\`\`\`bash
srvctl config database -d PRODDB | grep -i password
\`\`\`

\`\`\`text
Password file: +DATA/PRODDB/PASSWORD/orapwproddb
\`\`\`

To locate the current active file from ASM directly:

\`\`\`bash
# Run as grid user or oracle user with SYSASM privilege
asmcmd pwget --dbuniquename PRODDB
\`\`\`

\`\`\`text
+DATA/PRODDB/PASSWORD/orapwproddb
\`\`\`

**The trap that catches most DBAs:** When you run \`orapwd file=+DATA/PRODDB/PASSWORD/orapwproddb password=<newpwd> entries=10\` to recreate the password file with a known password, the command creates a new ASM file at that path. But Clusterware does not automatically detect the change. If the \`srvctl\` registration still points to the old ASM file alias or to a different version of the file (ASM uses versioned aliases internally), the database continues to read the old, stale password file. The filesystem copy at \`\$ORACLE_HOME/dbs/orapwPRODDB\` — which is actually just a symlink or a small stub in 12c+ RAC — does not contain the real password hash either.

The only reliable way to update the password file in a RAC ASM environment is to extract it with \`asmcmd pwcopy\`, transfer it, and copy it back into the target ASM instance with \`asmcmd pwcopy\`, then update the \`srvctl\` registration to point to the new ASM file.

---

## Diagnostic Progression

The errors did not appear in their final form immediately. There was a two-stage diagnostic progression that reflected two separate configuration gaps.

### Stage 1: TNS Errors on Primary Nodes

The first errors in the primary alert log were ORA-12514 and ORA-12154 — TNS: listener does not currently know of service and TNS: could not resolve the connect identifier. These appeared on primary-rac1 and primary-rac2 as the ARCn processes tried to open connections to the standby.

Root cause: the \`tnsnames.ora\` on the primary nodes did not have an entry for the standby service. The \`LOG_ARCHIVE_DEST_2\` parameter referenced a service alias \`STBYDB\` that was not resolvable from any primary node. This was fixed by adding the standby TNS entry to \`\$ORACLE_HOME/network/admin/tnsnames.ora\` on all three primary nodes and testing connectivity:

\`\`\`bash
tnsping STBYDB
sqlplus sys/password@STBYDB as sysdba
\`\`\`

### Stage 2: ORA-01017 and ORA-16191

Once TNS was resolved, the ARCn processes could reach the standby listener and begin the connection handshake. This is when ORA-01017 and ORA-16191 appeared — the connection was reaching the standby but authentication was failing. The SYS password hash in the primary's ASM password file did not match the hash in the standby's ASM password file.

This was the real root cause, and it is the less intuitive of the two failures. TNS problems are immediately obvious because you get a named service resolution failure. Password file mismatches are subtle because the error message mentions "invalid username/password" which sounds like the wrong password was typed, but no human is typing anything — the background process is presenting the hash from the password file automatically.

---

## Interpreting the Alert Log

The standby alert log contained the following entries during the authentication failure window:

\`\`\`text
Thu Jul 16 14:22:11 2026
RFS[3]: Assigned to RFS process 28817
RFS[3]: Selected log 6 for thread 1 sequence 5199 dbid 1234567890 branch 1100000001
Thu Jul 16 14:22:11 2026
Errors in file /u01/app/oracle/diag/rdbms/stbydb/STBYDB/trace/STBYDB_rfs_28817.trc:
ORA-01017: invalid username/password; logon denied
Thu Jul 16 14:22:11 2026
RFS[3]: No standby redo logfile available for thread 1 sequence 5199
ORA-16191: Primary log shipping client not connected with SYSDBA privilege
Check that the primary and standby are using a password file and
remote_login_passwordfile is set to SHARED or EXCLUSIVE, and that
the SYS password is same in the password files.
\`\`\`

The embedded hint at the bottom — "Check that the primary and standby are using a password file and remote_login_passwordfile is set to SHARED or EXCLUSIVE, and that the SYS password is same in the password files" — is Oracle's own diagnostic message for this condition. It tells you exactly what to check. The mistake most DBAs make is to verify \`remote_login_passwordfile\` (which is set correctly), verify that a password file exists (it does), and then assume the file must be correct. In an ASM environment, existence of the file does not guarantee it contains the right SYS hash.

---

## V\$DATAGUARD_STATUS and V\$ARCHIVE_GAP

Two dynamic performance views are essential for diagnosing this class of problem.

### V\$DATAGUARD_STATUS

Query on the standby to see the most recent status messages from Data Guard processes:

\`\`\`sql
SELECT TIMESTAMP, SEVERITY, MESSAGE
FROM   V\$DATAGUARD_STATUS
WHERE  TIMESTAMP > SYSDATE - 4/24
ORDER  BY TIMESTAMP;
\`\`\`

During the password file mismatch, this view showed repeating entries with SEVERITY = 'Error' and MESSAGE containing ORA-01017 and ORA-16191. The MESSAGE column also includes the embedded hint shown in the alert log above.

### V\$ARCHIVE_GAP

Query on the standby to identify gaps between received and applied redo:

\`\`\`sql
-- Thread gap summary
SELECT THREAD#, LOW_SEQUENCE#, HIGH_SEQUENCE#
FROM   V\$ARCHIVE_GAP;

-- Cross-reference applied vs received
SELECT THREAD#, MAX(SEQUENCE#) AS APPLIED_SEQ
FROM   V\$ARCHIVED_LOG
WHERE  APPLIED = 'YES'
GROUP  BY THREAD#;

SELECT THREAD#, MAX(SEQUENCE#) AS RECEIVED_SEQ
FROM   V\$ARCHIVED_LOG
WHERE  STANDBY_DEST = 'YES'
GROUP  BY THREAD#;
\`\`\`

In this case the gap for Thread 1 showed LOW_SEQUENCE# = 5199, HIGH_SEQUENCE# = 5231. Thread 2 showed no gap. This confirmed that the issue was not in the apply layer (which would affect both threads) and not in archive log delivery to the standby filesystem (the files were present), but specifically in the RFS authentication step for thread 1's transport path.

---

## Root Cause: Three Ways the Password Files Diverge

There are three common scenarios that produce a password file mismatch between a RAC primary and its standby in an ASM environment.

### Scenario 1: Password File Recreated on Primary Without Copying to Standby

The most common case. A DBA ran \`orapwd\` on the primary to reset the SYS password — either as a routine security change or as part of building the standby environment. The new password file in ASM on the primary now has a different SYS hash than the old password file that was copied to the standby during the initial standby build.

### Scenario 2: srvctl on Standby Points to Wrong ASM Path

The standby \`srvctl\` configuration references an ASM file that is different from the one actually being used by the database instance. This can happen after a standby rebuild, after a clusterware resource re-registration, or if the password file was copied into ASM manually at a path that does not match the srvctl registration. The instance reads the file at the registered path; the RFS authentication check uses the hash from the actual running database, which came from a different file.

### Scenario 3: Password File in ASM Has Different SYS Hash Than Current Database

The standby's ASM password file exists at the correct path and is correctly registered with srvctl, but the hash it contains is stale. This happens when the SYS password was changed on the primary after the standby was built, and the updated primary password file was never propagated to the standby. This is the scenario that occurred in this case.

---

## Step-by-Step Resolution

### Step 1: Verify remote_login_passwordfile on Both Sides

On the primary (any node):

\`\`\`sql
SQL> SHOW PARAMETER remote_login_passwordfile

NAME                                 TYPE        VALUE
------------------------------------ ----------- -----
remote_login_passwordfile            string      EXCLUSIVE
\`\`\`

On the standby:

\`\`\`sql
SQL> SHOW PARAMETER remote_login_passwordfile

NAME                                 TYPE        VALUE
------------------------------------ ----------- -----
remote_login_passwordfile            string      EXCLUSIVE
\`\`\`

Both must show \`EXCLUSIVE\`. If either shows \`NONE\` or \`SHARED\`, correct the \`spfile\` and restart the instance before proceeding.

### Step 2: Locate the Active Password File

On the primary (as grid or oracle user with SYSASM):

\`\`\`bash
asmcmd pwget --dbuniquename PRODDB
\`\`\`

\`\`\`text
+DATA/PRODDB/PASSWORD/orapwproddb
\`\`\`

Confirm via srvctl:

\`\`\`bash
srvctl config database -d PRODDB | grep -i password
\`\`\`

\`\`\`text
Password file: +DATA/PRODDB/PASSWORD/orapwproddb
\`\`\`

On the standby:

\`\`\`bash
srvctl config database -d STBYDB | grep -i password
\`\`\`

\`\`\`text
Password file: +DATA/STBYDB/PASSWORD/orapwstbydb
\`\`\`

Both paths should reflect the active, registered password file for each database.

### Step 3: Extract the Primary Password File from ASM

On primary-rac1, as the oracle user:

\`\`\`bash
asmcmd pwcopy +DATA/PRODDB/PASSWORD/orapwproddb /tmp/orapwPRODDB_export
\`\`\`

\`\`\`text
copying +DATA/PRODDB/PASSWORD/orapwproddb -> /tmp/orapwPRODDB_export
\`\`\`

Verify the file was created and has a non-zero size:

\`\`\`bash
ls -lh /tmp/orapwPRODDB_export
\`\`\`

\`\`\`text
-rw-r----- 1 oracle oinstall 2.0K Jul 16 14:35 /tmp/orapwPRODDB_export
\`\`\`

### Step 4: SCP the Extracted File to the Standby Host

\`\`\`bash
scp /tmp/orapwPRODDB_export oracle@standby-node1:/tmp/orapwPRODDB_transfer
\`\`\`

Confirm the file arrived intact and file sizes match:

\`\`\`bash
# On primary-rac1
ls -l /tmp/orapwPRODDB_export

# On standby-node1
ls -l /tmp/orapwPRODDB_transfer
\`\`\`

Both should show the same byte count.

### Step 5: Copy the File into Standby ASM and Update srvctl

On standby-node1, first rename the old password file in ASM so it is preserved as a backup rather than overwritten in place:

\`\`\`bash
asmcmd rename +DATA/STBYDB/PASSWORD/orapwstbydb \
              +DATA/STBYDB/PASSWORD/orapwstbydb_backup_20260716
\`\`\`

Now copy the primary's exported password file into the standby's ASM disk group at the canonical path:

\`\`\`bash
asmcmd pwcopy /tmp/orapwPRODDB_transfer \
              +DATA/STBYDB/PASSWORD/orapwstbydb \
              --dbuniquename STBYDB
\`\`\`

\`\`\`text
copying /tmp/orapwPRODDB_transfer -> +DATA/STBYDB/PASSWORD/orapwstbydb
\`\`\`

Update the srvctl database registration to point to the new file:

\`\`\`bash
srvctl modify database -d STBYDB \
    -pwfile +DATA/STBYDB/PASSWORD/orapwstbydb
\`\`\`

Confirm the registration:

\`\`\`bash
srvctl config database -d STBYDB | grep -i password
\`\`\`

\`\`\`text
Password file: +DATA/STBYDB/PASSWORD/orapwstbydb
\`\`\`

### Step 6: Stop and Restart the Standby, Re-enable MRP

The standby instance must be restarted to pick up the new password file. With a RAC One Node standby, the sequence is:

\`\`\`bash
# Stop managed recovery
sqlplus / as sysdba
\`\`\`

\`\`\`sql
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE CANCEL;
SHUTDOWN IMMEDIATE;
\`\`\`

Restart using srvctl to ensure Clusterware picks up the updated resource configuration:

\`\`\`bash
srvctl start database -d STBYDB -o mount
\`\`\`

Re-enable MRP with the disconnect option so it runs as a background process:

\`\`\`sql
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE
    USING CURRENT LOGFILE DISCONNECT FROM SESSION;
\`\`\`

Allow 60–90 seconds for the ARCn processes on the primary to re-establish transport connections and for MRP to begin applying the backlogged redo. Monitor the standby alert log:

\`\`\`bash
tail -f /u01/app/oracle/diag/rdbms/stbydb/STBYDB/trace/alert_STBYDB.log
\`\`\`

The successful outcome looks like:

\`\`\`text
Thu Jul 16 14:52:04 2026
RFS[3]: Assigned to RFS process 29104
RFS[3]: Selected log 6 for thread 1 sequence 5199 dbid 1234567890 branch 1100000001
Media Recovery Log +DATA/STBYDB/ARCHIVELOG/2026_07_16/thread_1_seq_5199.arc
Media Recovery Log +DATA/STBYDB/ARCHIVELOG/2026_07_16/thread_1_seq_5200.arc
\`\`\`

---

## Verification Queries

After MRP restarts and begins consuming the gap, run the following queries on the standby to confirm recovery.

### V\$DATAGUARD_STATUS — Last 4 Hours

\`\`\`sql
SELECT TO_CHAR(TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS TS,
       SEVERITY,
       SUBSTR(MESSAGE, 1, 120) AS MESSAGE
FROM   V\$DATAGUARD_STATUS
WHERE  TIMESTAMP > SYSDATE - 4/24
  AND  SEVERITY NOT IN ('Informational')
ORDER  BY TIMESTAMP DESC;
\`\`\`

After the fix, this query should return no rows with severity Error or Warning related to ORA-01017 or ORA-16191.

### Thread Gap Check

\`\`\`sql
-- Should return no rows when caught up
SELECT THREAD#, LOW_SEQUENCE#, HIGH_SEQUENCE#
FROM   V\$ARCHIVE_GAP;

-- Applied sequence by thread
SELECT THREAD#, MAX(SEQUENCE#) AS LAST_APPLIED
FROM   V\$ARCHIVED_LOG
WHERE  APPLIED = 'YES'
GROUP  BY THREAD#
ORDER  BY THREAD#;
\`\`\`

### Database Role and Apply Lag

\`\`\`sql
SELECT NAME,
       DB_UNIQUE_NAME,
       DATABASE_ROLE,
       OPEN_MODE,
       PROTECTION_MODE,
       PROTECTION_LEVEL
FROM   V\$DATABASE;
\`\`\`

\`\`\`text
NAME    DB_UNIQUE_NAME  DATABASE_ROLE    OPEN_MODE   PROTECTION_MODE   PROTECTION_LEVEL
------- --------------- ---------------- ----------- ----------------- ----------------
PRODDB  STBYDB          PHYSICAL STANDBY MOUNTED     MAXIMUM PERFORMANCE MAXIMUM PERFORMANCE
\`\`\`

For a more precise apply lag:

\`\`\`sql
SELECT NAME, VALUE, UNIT, TIME_COMPUTED
FROM   V\$DATAGUARD_STATS
WHERE  NAME IN ('transport lag', 'apply lag', 'apply finish time');
\`\`\`

---

## Version Differences

### Oracle 11g

In 11g without ASM, the password file is a plain binary file at \`\$ORACLE_HOME/dbs/orapw\$ORACLE_SID\`. The fix is a direct \`scp\`:

\`\`\`bash
scp oracle@primary-rac1:\$ORACLE_HOME/dbs/orapwPRODDB \
    oracle@standby-node1:\$ORACLE_HOME/dbs/orapwSTBYDB
\`\`\`

In 11g with ASM and RAC, the password file can be in ASM but \`asmcmd pwget\` does not exist in that release. Use \`asmcmd cp\` instead:

\`\`\`bash
asmcmd cp +DATA/PRODDB/orapwPRODDB /tmp/orapwPRODDB_export
\`\`\`

There is no \`--dbuniquename\` option in 11g \`asmcmd\`. Srvctl in 11g also has fewer password file management options. In practice, 11g RAC with ASM password file management is more manual.

### Oracle 12c

The \`asmcmd pwcopy\` command is available and is the supported method. The \`--dbuniquename\` flag registers the copied file with CRS automatically. This is the version where the mismatch problem becomes most common because the tooling changed from 11g but many DBAs carried forward 11g habits (filesystem \`scp\`).

### Oracle 19c

\`asmcmd pwget --dbuniquename\` works reliably in 19c and is the correct starting point for locating the active password file. The \`asmcmd pwcopy\` workflow is unchanged from 12c. One 19c improvement: if you use \`orapwd file=+DATA/PRODDB/PASSWORD/orapwproddb\`, Oracle 19c updates the CRS registration automatically in some configurations (with the \`-ORCL:ASMGRP\` GI resource configured). In 12c this was unreliable. Even in 19c, explicitly running \`srvctl modify database -d STBYDB -pwfile\` after any password file operation is the safest practice.

---

## RAC One Node Specifics

The standby in this case was configured as RAC One Node — a single active instance that can migrate between nodes, configured within CRS as a cluster resource. This affected the diagnostic process in a subtle way: \`srvctl config database\` output looks slightly different from a standard single-instance or full-RAC configuration.

\`\`\`bash
srvctl config database -d STBYDB
\`\`\`

\`\`\`text
Database unique name: STBYDB
Database name: PRODDB
Oracle home: /u01/app/oracle/product/19.0.0/dbhome_1
Oracle user: oracle
Spfile: +DATA/STBYDB/PARAMETERFILE/spfilestbydb.ora
Password file: +DATA/STBYDB/PASSWORD/orapwstbydb
Domain:
Start options: mount
Stop options: immediate
Database role: PHYSICAL_STANDBY
Management policy: AUTOMATIC
Server pools:
Disk Groups: DATA,RECO
Mount point paths:
Services:
Type: RACOneNode
Online relocation timeout: 30
Instance name prefix: STBYDB
Candidate servers: standby-node1
OSDBA group: dba
OSOPER group: oper
Database instances: STBYDB1
\`\`\`

The \`Type: RACOneNode\` line confirms the configuration. The \`Candidate servers: standby-node1\` shows the single eligible node. The \`OSDBA group: dba\` matters for the \`asmcmd\` operations — you need to run those commands as a user in the \`dba\` group, or as the grid user with \`SYSASM\` access to the ASM instance.

A common mistake with RAC One Node standbys is attempting to start the database with \`startup mount\` in SQL*Plus while bypassing Clusterware. This works for the immediate session but leaves CRS in an inconsistent state where it may attempt to relocate or restart the instance during the password file update steps. Always use \`srvctl stop database\` and \`srvctl start database\` to manage RAC One Node instances. SQL*Plus \`shutdown\` and \`startup\` are acceptable once the instance is already registered and running under CRS control, but state-changing operations should go through srvctl.

---

## Prevention Checklist

The following operational practices prevent password file mismatches from blocking Data Guard transport.

1. **Propagate password file changes immediately.** Whenever the SYS password is changed on the primary — for any reason — run the \`asmcmd pwcopy\` workflow to export the updated primary password file and import it into the standby ASM. Never rely on "I'll do it later."

2. **Add a password file sync step to your SYS password rotation runbook.** The runbook for rotating the SYS password on any production RAC database should include explicit steps to export from primary ASM and import to each standby ASM. This is a common omission.

3. **Verify password file consistency after every standby rebuild.** After building or rebuilding a standby, immediately test Data Guard redo transport with a \`ALTER SYSTEM ARCHIVE LOG CURRENT\` on the primary and confirm MRP applies the resulting archive on the standby before treating the build as complete.

4. **Monitor V\$DATAGUARD_STATUS daily.** A simple cron-driven SQL script that alerts on any row with SEVERITY != 'Informational' in the last 24 hours catches transport authentication failures within hours rather than days.

5. **Do not use filesystem \`scp\` to copy password files in 12c and later RAC environments.** The file at \`\$ORACLE_HOME/dbs/orapwSTBYDB\` in a 12c RAC ASM configuration may be empty, a stub, or a symlink. It is not the authoritative password file. Always use \`asmcmd pwcopy\` in these environments.

6. **After any \`asmcmd pwcopy\` into standby ASM, always run \`srvctl modify database -d STBYDB -pwfile\` explicitly.** Even in 19c where CRS may auto-register the file, the explicit \`srvctl modify\` ensures the registration is correct and is visible in \`srvctl config database\` output for audit purposes.

---

## Summary

ORA-01017 and ORA-16191 during Oracle Data Guard redo transport indicate a SYS password file mismatch between the primary and standby. In 12c and 19c RAC environments where ASM manages the password file, the mismatch almost always results from a password file update on the primary that was never propagated to the standby ASM instance — either because the update used \`orapwd\` directly without \`asmcmd pwcopy\`, or because a filesystem \`scp\` was used instead of the ASM tooling. The resolution requires extracting the primary password file with \`asmcmd pwcopy\`, transferring it to the standby host, importing it into the standby ASM disk group with \`asmcmd pwcopy --dbuniquename\`, updating the \`srvctl\` registration, and restarting the standby in mount with MRP re-enabled. Adding a password file sync step to every SYS password rotation runbook is the single most effective prevention measure.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'ORA-01017 and ORA-16191 During Oracle Data Guard Standby Build: ASM Password File Mismatch on RAC',
    slug,
    excerpt: 'Building a Data Guard physical standby for a live server migration and MRP refuses to apply redo — ORA-01017 and ORA-16191 blocking log shipping. The root cause on Oracle 12c and 19c RAC with ASM-managed password files is almost always a mismatch between what the standby Grid Infrastructure registered and what is actually in ASM. Fix requires asmcmd pwcopy and srvctl modify, not a filesystem copy.',
    content,
    category: 'disaster-recovery',
    isPremium: false,
    published: true,
    publishedAt: new Date('2026-07-16T18:00:00.000Z'),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
