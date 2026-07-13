import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'rman-table-recovery-ora01666-standby-control-file';

const content = `
One of the more attractive features of an Oracle Data Guard environment is the ability to offload resource-intensive RMAN backups to the physical standby. Letting the standby handle nightly full backups and archive log sweeps keeps I/O and CPU overhead off the primary, and the backup media — whether disk or tape — becomes reachable from either node. That architecture works transparently for most recovery scenarios.

It breaks, quietly and confusingly, the moment you run \`RECOVER TABLE\` from the primary node.

The automatic auxiliary instance that \`RECOVER TABLE\` spins up reaches the backup media and pulls the most recent control file backup it can find. In a standby-backed environment, that control file was created on the standby. When the auxiliary tries to mount it as a clone database, Oracle detects the standby attribute in the control file header and aborts with ORA-01666. The error message does not tell you which backup piece was wrong or why it was selected. It just stops.

This post explains the root cause, walks through two methods for forcing RMAN to use the correct primary control file backup, and covers the preventative tagging strategy that stops this from happening again.

---

## Architecture: Why Standby Backups Break Table Recovery

In a Data Guard environment with backup offloading, the standby runs the RMAN backup jobs. The resulting backup pieces — data files, archive logs, and control file autobackups — land on tape or a shared disk location accessible from both nodes. The RMAN recovery catalog records all of these pieces under the primary database's DBID, because the standby database shares the same DBID.

From the catalog's perspective, a control file backup taken on the standby is indistinguishable from one taken on the primary — same DBID, same database name. The only difference is inside the control file binary itself: it carries a flag identifying it as a standby control file.

When \`RECOVER TABLE\` launches its automatic auxiliary instance, RMAN queries the catalog for the most recent control file backup within the recovery window and restores it. The most recent backup was taken on the standby. RMAN restores it. The auxiliary mounts it. Oracle reads the standby flag and throws ORA-01666.

---

## The Error

The symptoms appear during the control file mount phase of the automatic auxiliary setup. The restore itself succeeds — RMAN pulls the piece from tape and writes it to the auxiliary destination without error. The failure occurs the moment the auxiliary instance attempts to mount the restored file as a clone database:

\`\`\`
RMAN> RECOVER TABLE APPOWNER.TRANSACTION_LOG
UNTIL TIME "TO_DATE('2026-07-11 13:10:00','YYYY-MM-DD HH24:MI:SS')"
AUXILIARY DESTINATION '/u02/rman/PRODCDB/aux_dest'
REMAP TABLE APPOWNER.TRANSACTION_LOG:TRANSACTION_LOG_REC;

...
channel ORA_AUX_SBT_TAPE_1: restoring control file
channel ORA_AUX_SBT_TAPE_1: restored backup piece 1
Finished restore at 11-JUL-26

sql statement: alter database mount clone database

RMAN-03009: failure of sql command on clone_default channel
RMAN-11003: failure during parse/execution of SQL statement:
            alter database mount clone database
ORA-01666: control file is for a standby database
\`\`\`

At this point RMAN tears down the automatic auxiliary instance and returns control. No table is recovered. The auxiliary destination directory contains the partially restored control file and nothing else.

---

## Root Cause Summary

| Factor | Detail |
|--------|--------|
| Backup source | Standby database node |
| Control file type in most recent backup | Standby control file |
| RMAN catalog awareness | Same DBID — no distinction by node |
| Auxiliary behavior | Restores most recent control file; tries to mount as clone |
| Failure point | \`ALTER DATABASE MOUNT CLONE DATABASE\` on a standby control file |

The fix in both methods below is the same: get a primary control file backup piece onto the media, then ensure RMAN's auxiliary instance uses that piece instead of the standby one.

---

## Method 1: Tag-Based Primary Control File Targeting

The cleanest long-term fix involves creating a dedicated backup of the primary control file using a unique tag, and specifying that tag in the \`RECOVER TABLE\` command's auxiliary channel configuration.

### Step 1: Take a primary control file backup with a unique tag

Run this on the primary database. This creates a control file backup that RMAN can identify as belonging to the primary:

\`\`\`
RMAN> BACKUP TAG 'PRIMARY_CTRL' CURRENT CONTROLFILE;
\`\`\`

For SBT_TAPE environments, allocate the tape channel explicitly:

\`\`\`
RUN {
  ALLOCATE CHANNEL c1 DEVICE TYPE sbt_tape
    PARMS='ENV=(TDPO_OPTFILE=/usr/tivoli/tsm/client/oracle/bin64/tdpo.opt)';
  BACKUP TAG 'PRIMARY_CTRL' CURRENT CONTROLFILE;
  RELEASE CHANNEL c1;
}
\`\`\`

### Step 2: Confirm the piece is registered in the catalog

\`\`\`
RMAN> LIST BACKUP OF CONTROLFILE TAG 'PRIMARY_CTRL';
\`\`\`

Record the backup piece handle from the output. It will be in the format \`c-<DBID>-<date>-<seq>\`. This is the piece RMAN must use for auxiliary restore.

### Step 3: Run RECOVER TABLE with the tag

When running \`RECOVER TABLE\`, include an auxiliary channel configuration that specifies the tag. If your media manager supports it, pass the tag as a hint:

\`\`\`
RUN {
  ALLOCATE AUXILIARY CHANNEL aux1 DEVICE TYPE sbt_tape
    PARMS='ENV=(TDPO_OPTFILE=/usr/tivoli/tsm/client/oracle/bin64/tdpo.opt)';

  RECOVER TABLE APPOWNER.TRANSACTION_LOG
  UNTIL TIME "TO_DATE('2026-07-11 13:10:00','YYYY-MM-DD HH24:MI:SS')"
  AUXILIARY DESTINATION '/u02/rman/PRODCDB/aux_dest'
  REMAP TABLE APPOWNER.TRANSACTION_LOG:TRANSACTION_LOG_REC;
}
\`\`\`

If RMAN still selects the standby control file despite the tag on the primary piece, proceed to Method 2.

---

## Method 2: Manual Auxiliary TSPITR with Primary Control File

This method bypasses the automatic \`RECOVER TABLE\` wrapper entirely. You manually build the auxiliary instance, restore the correct primary control file by specifying its backup piece handle directly, recover the tablespace containing the target table to the required point in time, and then export the table with Data Pump.

This approach requires more steps but gives complete control over which backup piece RMAN uses at every stage.

### Overview

1. Create a minimal \`init.ora\` for the auxiliary instance
2. Start the auxiliary in \`NOMOUNT\`
3. Restore the primary control file backup piece by handle
4. Mount the clone database
5. Restore and recover the tablespace containing the target table to the target time
6. Open the auxiliary database read-only or with RESETLOGS
7. Export the recovered table with \`expdp\`
8. Import it into production with \`impdp\`
9. Clean up the auxiliary instance

### Step 1: Create the auxiliary init.ora

Create a minimal parameter file for the auxiliary instance. Adjust paths for your environment:

\`\`\`
# /tmp/initAUX.ora
db_name=PRODCDB
db_unique_name=AUXINST
control_files=/u02/rman/PRODCDB/aux_dest/control01.ctl
db_file_name_convert=('/u01/oradata/PRODCDB','/u02/rman/PRODCDB/aux_dest/data')
log_file_name_convert=('/u01/oradata/PRODCDB','/u02/rman/PRODCDB/aux_dest/redo')
db_block_size=8192
pga_aggregate_target=512M
sga_target=2G
enable_pluggable_database=true  -- only if source is a CDB
\`\`\`

### Step 2: Start the auxiliary in NOMOUNT

\`\`\`bash
export ORACLE_SID=AUXINST
sqlplus / as sysdba <<EOF
STARTUP NOMOUNT PFILE='/tmp/initAUX.ora';
EXIT;
EOF
\`\`\`

### Step 3: Identify and restore the primary control file backup piece

On the primary node, list control file backups to locate the primary piece:

\`\`\`
RMAN TARGET /
LIST BACKUP OF CONTROLFILE;
\`\`\`

Look for a piece where the backup was taken from the primary database (not the standby node). If you have the \`PRIMARY_CTRL\` tag from Method 1, use it directly. Otherwise, identify the most recent backup taken before the last standby backup, or use a piece created on the primary.

Record the handle — for example: \`c-1234567890-20260711-00\`

### Step 4: Restore the primary control file to the auxiliary

\`\`\`
RUN {
  ALLOCATE AUXILIARY CHANNEL ch1 DEVICE TYPE sbt_tape
    PARMS='ENV=(TDPO_OPTFILE=/usr/tivoli/tsm/client/oracle/bin64/tdpo.opt)';

  RESTORE FROM PIECE 'c-1234567890-20260711-00' AUXILIARY CONTROLFILE;
}
\`\`\`

\`RESTORE FROM PIECE\` bypasses catalog lookup entirely — RMAN retrieves exactly the piece you name, regardless of what the catalog considers "most recent."

### Step 5: Mount the clone database

\`\`\`bash
sqlplus / as sysdba <<EOF
ALTER DATABASE MOUNT CLONE DATABASE;
EXIT;
EOF
\`\`\`

If this succeeds without ORA-01666, you are now working with a primary control file. The clone database is mounted.

### Step 6: Recover the tablespace to the target time

Identify which tablespace contains the target table:

\`\`\`sql
SELECT tablespace_name FROM dba_tables
WHERE owner = 'APPOWNER' AND table_name = 'TRANSACTION_LOG';
\`\`\`

Run the tablespace point-in-time recovery on the auxiliary. This restores data files for only the target tablespace rather than the entire database:

\`\`\`
RUN {
  ALLOCATE AUXILIARY CHANNEL ch1 DEVICE TYPE sbt_tape
    PARMS='ENV=(TDPO_OPTFILE=/usr/tivoli/tsm/client/oracle/bin64/tdpo.opt)';

  SET UNTIL TIME "TO_DATE('2026-07-11 13:10:00','YYYY-MM-DD HH24:MI:SS')";

  RESTORE AUXILIARY TABLESPACE APPDATA_TS;
  RECOVER AUXILIARY TABLESPACE APPDATA_TS;
}
\`\`\`

Replace \`APPDATA_TS\` with the actual tablespace name containing the target table.

### Step 7: Open the auxiliary database for export

\`\`\`sql
ALTER DATABASE OPEN RESETLOGS;
ALTER PLUGGABLE DATABASE ALL OPEN;  -- CDB only
\`\`\`

### Step 8: Export the recovered table

\`\`\`bash
expdp system/manager@AUXINST \\
  tables=APPOWNER.TRANSACTION_LOG \\
  directory=DATA_PUMP_DIR \\
  dumpfile=TRANSACTION_LOG_recovered.dmp \\
  logfile=TRANSACTION_LOG_expdp.log \\
  flashback_time=\\"TO_TIMESTAMP\('2026-07-11 13:10:00','YYYY-MM-DD HH24:MI:SS'\)\\"
\`\`\`

### Step 9: Import the table into production

\`\`\`bash
impdp system/manager@PRODCDB \\
  tables=APPOWNER.TRANSACTION_LOG \\
  remap_table=APPOWNER.TRANSACTION_LOG:APPOWNER.TRANSACTION_LOG_REC \\
  directory=DATA_PUMP_DIR \\
  dumpfile=TRANSACTION_LOG_recovered.dmp \\
  logfile=TRANSACTION_LOG_impdp.log
\`\`\`

---

## Prevention: Backup Tagging Strategy

The root cause is that RMAN cannot distinguish primary from standby control file backups by DBID alone. Solve this at the backup level rather than at recovery time.

### Tag all control file backups by node role

In your standby backup script, add a tag that identifies the backup as coming from the standby:

\`\`\`
BACKUP TAG 'STANDBY_CTRL_<YYYYMMDD>' CURRENT CONTROLFILE;
\`\`\`

In your primary backup script (even if the primary does not take full backups, it should take a periodic control file backup):

\`\`\`
BACKUP TAG 'PRIMARY_CTRL_<YYYYMMDD>' CURRENT CONTROLFILE;
\`\`\`

### Schedule a weekly primary control file backup

Add this to a weekly primary-side RMAN job. It takes only seconds and gives you a named primary control file piece available on the media for any future auxiliary recovery:

\`\`\`
RUN {
  ALLOCATE CHANNEL c1 DEVICE TYPE sbt_tape
    PARMS='ENV=(TDPO_OPTFILE=/usr/tivoli/tsm/client/oracle/bin64/tdpo.opt)';
  BACKUP TAG 'PRIMARY_CTRL_WEEKLY' CURRENT CONTROLFILE;
  RELEASE CHANNEL c1;
}
\`\`\`

### Ensure the RMAN catalog is registered for both nodes

If you use a recovery catalog (recommended in any Data Guard environment), both the primary and standby should be registered:

\`\`\`
RMAN CATALOG rcatowner/password@rcatdb
REGISTER DATABASE;
\`\`\`

Run this on each node to ensure the catalog tracks backup metadata from both.

---

## Summary

ORA-01666 during \`RECOVER TABLE\` in a standby-backed environment is a catalog ambiguity problem, not a software defect. RMAN correctly restores the most recent control file backup it can find; the issue is that "most recent" is a standby control file, which cannot be mounted as a clone database on the primary.

Two fixes are available. Method 1 — taking an explicitly tagged primary control file backup and referencing it during recovery — is the right long-term approach and prevents recurrence with minimal overhead. Method 2 — manual auxiliary TSPITR using \`RESTORE FROM PIECE\` to name the exact backup piece — gives you full control when Method 1 is not available and the recovery is urgent.

The preventative measure is simple: add a weekly \`BACKUP TAG 'PRIMARY_CTRL'\` to your primary-side RMAN schedule, even if the primary does not otherwise participate in the backup cycle. When you need \`RECOVER TABLE\`, a tagged primary control file piece means one less failure mode to diagnose under pressure.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'RMAN Table Recovery Failing with ORA-01666: Standby Control File Selected in Data Guard Environments',
    slug,
    excerpt: 'RECOVER TABLE fails with ORA-01666 (control file is for a standby database) when RMAN automatically selects the most recent control file backup — which was taken on the standby node. This post explains why RMAN cannot distinguish primary from standby backups by DBID alone, and covers two fixes: tagged primary control file backups for clean RECOVER TABLE runs, and a manual auxiliary TSPITR procedure using RESTORE FROM PIECE to bypass catalog selection entirely.',
    content,
    category: 'disaster-recovery',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
