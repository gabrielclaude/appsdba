import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'rman-table-recovery-ora01666-runbook';

const content = `
This runbook covers the step-by-step recovery procedure when \`RECOVER TABLE\` fails with ORA-01666 in an Oracle Data Guard environment where RMAN backups are offloaded to the physical standby. Use this when the automatic auxiliary instance has aborted and you need to recover a specific table to a point in time using the manual auxiliary TSPITR path.

**Error addressed:** ORA-01666: control file is for a standby database

**Root cause:** RMAN's automatic auxiliary restores the most recent control file backup, which was taken on the standby node. A standby control file cannot be mounted as a clone database.

**Recovery approach:** Manual auxiliary instance → RESTORE FROM PIECE targeting the primary control file backup piece directly → tablespace PITR → Data Pump export/import of the recovered table.

---

## Prerequisites

| Requirement | Check |
|-------------|-------|
| RMAN access to the production primary (TARGET /) | ○ |
| SBT_TAPE channel configuration and media manager options file path | ○ |
| DBID of the source (primary) database | ○ |
| Backup piece handle for a primary control file backup (see Phase 1) | ○ |
| Auxiliary destination directory with sufficient space | ○ |
| OS-level write access to auxiliary destination on the recovery host | ○ |
| Oracle OS user can start a second instance (ORACLE_SID for auxiliary) | ○ |

\`\`\`bash
# Confirm environment before starting
echo "Primary SID:   \${ORACLE_SID}"
echo "Oracle Home:   \${ORACLE_HOME}"
echo "DB unique name: \$(sqlplus -s / as sysdba <<'EOF'
SET HEAD OFF FEED OFF
SELECT db_unique_name FROM v\\\$database;
EXIT;
EOF
)"
\`\`\`

---

## Phase 1: Locate the Primary Control File Backup Piece (5 minutes)

### 1.1 List all control file backups in the catalog

Connect RMAN to the primary and list control file backups:

\`\`\`
RMAN TARGET /

LIST BACKUP OF CONTROLFILE;
\`\`\`

The output shows each control file backup piece with its handle, creation date, and the node it was taken on (check the \`DBID\` and \`Tag\` columns).

### 1.2 Identify the primary piece

Look for backup pieces taken on the primary node. Indicators:
- A tag containing \`PRIMARY\` if you already use the tagging strategy
- A timestamp that precedes the last standby backup run (standby backups typically run on a regular schedule — the primary piece will be older but still within your recovery window)
- A backup taken on a different host if your primary and standby are on separate servers

\`\`\`
-- Run on the primary to show control file backup metadata
RMAN TARGET /

LIST BACKUP OF CONTROLFILE COMPLETED AFTER 'SYSDATE-30';
\`\`\`

Record the backup piece handle. Example format: \`c-1234567890-20260711-00\`

### 1.3 If no primary control file backup piece exists

Take one now from the primary:

\`\`\`
RUN {
  ALLOCATE CHANNEL c1 DEVICE TYPE sbt_tape
    PARMS='ENV=(SBT_LIBRARY=/path/to/media_agent.so,ENV=(MEDIAOPT=/etc/rman_sbt.opt))';
  BACKUP TAG 'PRIMARY_CTRL_RECOVERY' CURRENT CONTROLFILE;
  RELEASE CHANNEL c1;
}
\`\`\`

After it completes, re-run \`LIST BACKUP OF CONTROLFILE TAG 'PRIMARY_CTRL_RECOVERY';\` to get the handle.

---

## Phase 2: Prepare the Auxiliary Environment (10 minutes)

### 2.1 Set environment variables

\`\`\`bash
# Primary production SID
export PROD_SID=PRODCDB

# Auxiliary SID — must not conflict with any existing instance
export AUX_SID=AUXINST

# Auxiliary destination directory
export AUX_DEST=/u02/rman/\${PROD_SID}/aux_dest

# Oracle Home (same binary as the primary)
export ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export PATH=\${ORACLE_HOME}/bin:\${PATH}
\`\`\`

### 2.2 Create the auxiliary destination directory

\`\`\`bash
mkdir -p \${AUX_DEST}/data
mkdir -p \${AUX_DEST}/redo
mkdir -p \${AUX_DEST}/dump
chmod 750 \${AUX_DEST} \${AUX_DEST}/data \${AUX_DEST}/redo \${AUX_DEST}/dump
\`\`\`

### 2.3 Create the auxiliary init.ora

Replace the path prefixes and block size to match your production configuration:

\`\`\`bash
cat > /tmp/init\${AUX_SID}.ora << 'PFILE'
db_name=PRODCDB
db_unique_name=AUXINST
control_files=/u02/rman/PRODCDB/aux_dest/control01.ctl
db_file_name_convert=('/u01/oradata/PRODCDB','/u02/rman/PRODCDB/aux_dest/data')
log_file_name_convert=('/u01/oradata/PRODCDB','/u02/rman/PRODCDB/aux_dest/redo')
db_block_size=8192
pga_aggregate_target=512M
sga_target=2G
undo_tablespace=UNDOTBS1
enable_pluggable_database=true
PFILE
\`\`\`

Remove \`enable_pluggable_database=true\` if the production database is a non-CDB.

### 2.4 Create the auxiliary password file

\`\`\`bash
orapwd file=\${ORACLE_HOME}/dbs/orapw\${AUX_SID} password=TempPass123 format=12.2
\`\`\`

### 2.5 Create a Data Pump directory object location on the auxiliary destination

\`\`\`bash
# We'll create the directory object after opening — note the OS path now
echo "Data Pump dump dir: \${AUX_DEST}/dump"
\`\`\`

---

## Phase 3: Start the Auxiliary Instance and Restore the Primary Control File (10 minutes)

### 3.1 Start the auxiliary in NOMOUNT

\`\`\`bash
export ORACLE_SID=\${AUX_SID}

sqlplus / as sysdba << 'EOF'
STARTUP NOMOUNT PFILE='/tmp/initAUXINST.ora';
SELECT status FROM v\$instance;
EXIT;
EOF
\`\`\`

Expected output: \`STARTED\`

### 3.2 Restore the primary control file by piece handle

Connect RMAN to the auxiliary (no target — the target database is unavailable to this session):

\`\`\`
rman auxiliary /

RUN {
  ALLOCATE AUXILIARY CHANNEL ch1 DEVICE TYPE sbt_tape
    PARMS='ENV=(SBT_LIBRARY=/path/to/media_agent.so,ENV=(MEDIAOPT=/etc/rman_sbt.opt))';

  -- Replace with the actual primary control file backup piece handle from Phase 1
  RESTORE FROM PIECE 'c-1234567890-20260711-00' AUXILIARY CONTROLFILE;

  RELEASE CHANNEL ch1;
}
\`\`\`

\`RESTORE FROM PIECE\` bypasses the catalog entirely. RMAN retrieves exactly the named piece from the media manager, regardless of what the catalog considers the most recent backup.

### 3.3 Mount the clone database

\`\`\`bash
export ORACLE_SID=\${AUX_SID}

sqlplus / as sysdba << 'EOF'
ALTER DATABASE MOUNT CLONE DATABASE;
SELECT status FROM v\$instance;
EXIT;
EOF
\`\`\`

Expected output: \`MOUNTED\`

If you see ORA-01666 here, the piece restored was still a standby control file. Return to Phase 1 and identify an older primary piece.

---

## Phase 4: Restore and Recover the Target Tablespace (20–120 minutes depending on size)

### 4.1 Identify the tablespace containing the target table

\`\`\`bash
# Run on the PRIMARY — the auxiliary does not have valid data yet
export ORACLE_SID=\${PROD_SID}

sqlplus / as sysdba << 'EOF'
SELECT tablespace_name FROM dba_tables
WHERE owner = 'APPOWNER' AND table_name = 'TRANSACTION_LOG';
EXIT;
EOF
\`\`\`

Record the tablespace name. Example: \`APPDATA_TS\`

### 4.2 Set the recovery target time

\`\`\`bash
# Define the point-in-time target — adjust to your actual recovery requirement
export RECOVERY_TIME="2026-07-11 13:10:00"
\`\`\`

### 4.3 Restore and recover the tablespace on the auxiliary

Connect RMAN to the auxiliary:

\`\`\`
rman auxiliary /

RUN {
  ALLOCATE AUXILIARY CHANNEL ch1 DEVICE TYPE sbt_tape
    PARMS='ENV=(SBT_LIBRARY=/path/to/media_agent.so,ENV=(MEDIAOPT=/etc/rman_sbt.opt))';
  ALLOCATE AUXILIARY CHANNEL ch2 DEVICE TYPE sbt_tape
    PARMS='ENV=(SBT_LIBRARY=/path/to/media_agent.so,ENV=(MEDIAOPT=/etc/rman_sbt.opt))';

  SET UNTIL TIME "TO_DATE('2026-07-11 13:10:00','YYYY-MM-DD HH24:MI:SS')";

  RESTORE AUXILIARY TABLESPACE APPDATA_TS;
  RECOVER AUXILIARY TABLESPACE APPDATA_TS;
}
\`\`\`

Monitor the output for channel progress. For large tablespaces with many archive logs to apply, this phase takes the longest.

---

## Phase 5: Open the Auxiliary Database and Export the Table (15 minutes)

### 5.1 Open the auxiliary database

\`\`\`bash
export ORACLE_SID=\${AUX_SID}

sqlplus / as sysdba << 'EOF'
ALTER DATABASE OPEN RESETLOGS;
-- CDB only: open all PDBs
ALTER PLUGGABLE DATABASE ALL OPEN;
SELECT open_mode FROM v\$database;
EXIT;
EOF
\`\`\`

Expected output: \`READ WRITE\`

### 5.2 Create the Data Pump directory object

\`\`\`bash
export ORACLE_SID=\${AUX_SID}

sqlplus / as sysdba << EOF
CREATE OR REPLACE DIRECTORY RECOVERY_DUMP AS '\${AUX_DEST}/dump';
GRANT READ, WRITE ON DIRECTORY RECOVERY_DUMP TO system;
EXIT;
EOF
\`\`\`

### 5.3 Export the recovered table

\`\`\`bash
RECOVERY_DATE=\$(date +%Y%m%d_%H%M%S)
DUMPFILE="TRANSACTION_LOG_\${RECOVERY_DATE}.dmp"
LOGFILE="TRANSACTION_LOG_expdp_\${RECOVERY_DATE}.log"

expdp system/TempPass123@\${AUX_SID} \\
  tables=APPOWNER.TRANSACTION_LOG \\
  directory=RECOVERY_DUMP \\
  dumpfile=\${DUMPFILE} \\
  logfile=\${LOGFILE}

echo "Dump file: \${AUX_DEST}/dump/\${DUMPFILE}"
\`\`\`

Confirm the export completed without errors:

\`\`\`bash
grep -i "error\|ORA-" \${AUX_DEST}/dump/\${LOGFILE}
tail -5 \${AUX_DEST}/dump/\${LOGFILE}
\`\`\`

---

## Phase 6: Import the Recovered Table into Production (10 minutes)

### 6.1 Copy the dump file to the production Data Pump directory if necessary

\`\`\`bash
# Find the production Data Pump directory path
export ORACLE_SID=\${PROD_SID}
PROD_DUMP_DIR=\$(sqlplus -s / as sysdba << 'EOF'
SET HEAD OFF FEED OFF
SELECT directory_path FROM dba_directories WHERE directory_name='DATA_PUMP_DIR';
EXIT;
EOF
)

echo "Production dump directory: \${PROD_DUMP_DIR}"
cp \${AUX_DEST}/dump/\${DUMPFILE} \${PROD_DUMP_DIR}/
\`\`\`

### 6.2 Import with remap to a recovery-suffix table name

\`\`\`bash
IMPORT_LOG="TRANSACTION_LOG_impdp_\${RECOVERY_DATE}.log"

impdp system/manager@\${PROD_SID} \\
  tables=APPOWNER.TRANSACTION_LOG \\
  remap_table=APPOWNER.TRANSACTION_LOG:APPOWNER.TRANSACTION_LOG_REC \\
  directory=DATA_PUMP_DIR \\
  dumpfile=\${DUMPFILE} \\
  logfile=\${IMPORT_LOG}
\`\`\`

The remap creates \`TRANSACTION_LOG_REC\` in production, leaving the original table untouched. The application team can then select from \`TRANSACTION_LOG_REC\`, compare with the current \`TRANSACTION_LOG\`, and merge the required rows.

### 6.3 Verify the imported table

\`\`\`bash
export ORACLE_SID=\${PROD_SID}

sqlplus / as sysdba << 'EOF'
SELECT COUNT(*) FROM APPOWNER.TRANSACTION_LOG_REC;
SELECT MIN(created_date), MAX(created_date) FROM APPOWNER.TRANSACTION_LOG_REC;
EXIT;
EOF
\`\`\`

---

## Phase 7: Clean Up the Auxiliary Instance (5 minutes)

### 7.1 Shut down the auxiliary

\`\`\`bash
export ORACLE_SID=\${AUX_SID}

sqlplus / as sysdba << 'EOF'
SHUTDOWN ABORT;
EXIT;
EOF
\`\`\`

### 7.2 Remove auxiliary files

\`\`\`bash
rm -rf \${AUX_DEST}/data/*
rm -rf \${AUX_DEST}/redo/*
rm /tmp/init\${AUX_SID}.ora
rm \${ORACLE_HOME}/dbs/orapw\${AUX_SID}

# Keep the dump directory and log files for audit
echo "Retained: \${AUX_DEST}/dump/"
\`\`\`

### 7.3 Remove the auxiliary instance spfile/pfile from dbs if created

\`\`\`bash
rm -f \${ORACLE_HOME}/dbs/spfile\${AUX_SID}.ora
rm -f \${ORACLE_HOME}/dbs/init\${AUX_SID}.ora
\`\`\`

---

## Automated Recovery Script

Save this to \`/home/oracle/rman_table_recovery_ora01666.sh\`. It orchestrates Phases 2 through 6 with prompts at key decision points. Review all variable values at the top before running.

\`\`\`bash
#!/bin/bash
# rman_table_recovery_ora01666.sh
#
# Manual auxiliary TSPITR workaround for ORA-01666 in Data Guard environments.
# Use when RECOVER TABLE fails because RMAN selected a standby control file.
#
# Prerequisites:
#   - Primary control file backup piece handle (run LIST BACKUP OF CONTROLFILE first)
#   - Oracle environment variables set for the PRIMARY database
#   - SBT_TAPE media manager options file accessible on this host
#
# Usage: bash rman_table_recovery_ora01666.sh

set -euo pipefail

# ── Configuration — edit all values before running ──────────────────────────

PROD_SID="PRODCDB"                          # Primary database SID
AUX_SID="AUXINST"                           # Auxiliary instance SID (must not exist)
ORACLE_HOME="/u01/app/oracle/product/19.0.0/dbhome_1"
AUX_DEST="/u02/rman/\${PROD_SID}/aux_dest"   # Destination for auxiliary files

# Primary control file backup piece handle (from LIST BACKUP OF CONTROLFILE)
PRIMARY_CF_PIECE="c-1234567890-20260711-00"

# Recovery target: point in time for the table
RECOVERY_TIME="2026-07-11 13:10:00"

# Table to recover (owner and name)
TABLE_OWNER="APPOWNER"
TABLE_NAME="TRANSACTION_LOG"
TABLE_TS="APPDATA_TS"                       # Tablespace containing TABLE_NAME

# SBT_TAPE media manager options
SBT_LIBRARY="/usr/lib/oracle/rman/libobk.so"
SBT_OPT_FILE="/etc/rman_sbt.opt"

# Auxiliary instance credentials
AUX_SYS_PASS="TempPass123"

# ── End configuration ─────────────────────────────────────────────────────────

export ORACLE_HOME
export PATH="\${ORACLE_HOME}/bin:\${PATH}"
RECOVERY_DATE=$(date +%Y%m%d_%H%M%S)
LOG="\${AUX_DEST}/recovery_\${RECOVERY_DATE}.log"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "\${LOG}"; }
die() { log "ERROR: $*"; exit 1; }

log "=== RMAN Table Recovery — ORA-01666 Workaround ==="
log "Primary SID:     \${PROD_SID}"
log "Auxiliary SID:   \${AUX_SID}"
log "Recovery target: \${RECOVERY_TIME}"
log "Table:           \${TABLE_OWNER}.\${TABLE_NAME} (\${TABLE_TS})"
log "CF piece:        \${PRIMARY_CF_PIECE}"
echo ""

# Phase 2: Prepare auxiliary environment
log "Phase 2: Preparing auxiliary environment..."
mkdir -p "\${AUX_DEST}/data" "\${AUX_DEST}/redo" "\${AUX_DEST}/dump"
chmod 750 "\${AUX_DEST}/data" "\${AUX_DEST}/redo" "\${AUX_DEST}/dump"

# Write init.ora
cat > "/tmp/init\${AUX_SID}.ora" << PFILE
db_name=\${PROD_SID}
db_unique_name=\${AUX_SID}
control_files=\${AUX_DEST}/control01.ctl
db_file_name_convert=('/u01/oradata/\${PROD_SID}','\${AUX_DEST}/data')
log_file_name_convert=('/u01/oradata/\${PROD_SID}','\${AUX_DEST}/redo')
db_block_size=8192
pga_aggregate_target=512M
sga_target=2G
undo_tablespace=UNDOTBS1
PFILE

log "init.ora written to /tmp/init\${AUX_SID}.ora"

# Create password file
orapwd file="\${ORACLE_HOME}/dbs/orapw\${AUX_SID}" \
  password="\${AUX_SYS_PASS}" format=12.2 2>>"\${LOG}" \
  || die "orapwd failed"
log "Password file created"

# Phase 3: Start auxiliary in NOMOUNT
log "Phase 3: Starting auxiliary instance in NOMOUNT..."
export ORACLE_SID="\${AUX_SID}"

sqlplus -s / as sysdba >> "\${LOG}" 2>&1 << EOF
STARTUP NOMOUNT PFILE='/tmp/init\${AUX_SID}.ora';
EXIT;
EOF

STATUS=$(sqlplus -s / as sysdba << 'EOF'
SET HEAD OFF FEED OFF
SELECT status FROM v\$instance;
EXIT;
EOF
)
[[ "\${STATUS}" == *"STARTED"* ]] || die "Auxiliary did not reach NOMOUNT state. Status: \${STATUS}"
log "Auxiliary in NOMOUNT (status: \${STATUS// /})"

# Phase 3: Restore primary control file
log "Restoring primary control file piece \${PRIMARY_CF_PIECE}..."
rman auxiliary / >> "\${LOG}" 2>&1 << RMAN_CF
RUN {
  ALLOCATE AUXILIARY CHANNEL ch1 DEVICE TYPE sbt_tape
    PARMS='ENV=(SBT_LIBRARY=\${SBT_LIBRARY},ENV=(MEDIAOPT=\${SBT_OPT_FILE}))';
  RESTORE FROM PIECE '\${PRIMARY_CF_PIECE}' AUXILIARY CONTROLFILE;
  RELEASE CHANNEL ch1;
}
EXIT;
RMAN_CF

grep -i "ORA-\|RMAN-3[0-9][0-9][0-9][0-9]" "\${LOG}" | tail -5 | while read l; do log "WARN: \${l}"; done

# Mount the clone database
log "Mounting clone database..."
sqlplus -s / as sysdba >> "\${LOG}" 2>&1 << 'EOF'
ALTER DATABASE MOUNT CLONE DATABASE;
EXIT;
EOF

STATUS=$(sqlplus -s / as sysdba << 'EOF'
SET HEAD OFF FEED OFF
SELECT status FROM v\$instance;
EXIT;
EOF
)
[[ "\${STATUS}" == *"MOUNTED"* ]] || die "Mount failed — check log for ORA-01666. Status: \${STATUS}"
log "Clone database mounted (status: \${STATUS// /})"

# Phase 4: Restore and recover tablespace
log "Phase 4: Restoring and recovering tablespace \${TABLE_TS} to \${RECOVERY_TIME}..."
rman auxiliary / >> "\${LOG}" 2>&1 << RMAN_TSPITR
RUN {
  ALLOCATE AUXILIARY CHANNEL ch1 DEVICE TYPE sbt_tape
    PARMS='ENV=(SBT_LIBRARY=\${SBT_LIBRARY},ENV=(MEDIAOPT=\${SBT_OPT_FILE}))';
  ALLOCATE AUXILIARY CHANNEL ch2 DEVICE TYPE sbt_tape
    PARMS='ENV=(SBT_LIBRARY=\${SBT_LIBRARY},ENV=(MEDIAOPT=\${SBT_OPT_FILE}))';

  SET UNTIL TIME "TO_DATE('\${RECOVERY_TIME}','YYYY-MM-DD HH24:MI:SS')";

  RESTORE AUXILIARY TABLESPACE \${TABLE_TS};
  RECOVER AUXILIARY TABLESPACE \${TABLE_TS};
}
EXIT;
RMAN_TSPITR
log "Tablespace recovery complete"

# Phase 5: Open auxiliary database
log "Phase 5: Opening auxiliary database with RESETLOGS..."
sqlplus -s / as sysdba >> "\${LOG}" 2>&1 << 'EOF'
ALTER DATABASE OPEN RESETLOGS;
EXIT;
EOF

sqlplus -s / as sysdba >> "\${LOG}" 2>&1 << EOF
CREATE OR REPLACE DIRECTORY RECOVERY_DUMP AS '\${AUX_DEST}/dump';
GRANT READ, WRITE ON DIRECTORY RECOVERY_DUMP TO system;
EXIT;
EOF

# Export the recovered table
DUMPFILE="\${TABLE_NAME}_\${RECOVERY_DATE}.dmp"
EXPDP_LOG="\${TABLE_NAME}_expdp_\${RECOVERY_DATE}.log"
log "Exporting \${TABLE_OWNER}.\${TABLE_NAME} to \${DUMPFILE}..."

expdp "system/\${AUX_SYS_PASS}@\${AUX_SID}" \
  tables="\${TABLE_OWNER}.\${TABLE_NAME}" \
  directory=RECOVERY_DUMP \
  dumpfile="\${DUMPFILE}" \
  logfile="\${EXPDP_LOG}" >> "\${LOG}" 2>&1

[[ -f "\${AUX_DEST}/dump/\${DUMPFILE}" ]] || die "Dump file not created — check \${AUX_DEST}/dump/\${EXPDP_LOG}"
log "Export complete: \${AUX_DEST}/dump/\${DUMPFILE}"

# Phase 6: Provide import command (do not auto-run — requires human confirmation)
log "=== MANUAL STEP REQUIRED ==="
log "Review the export log, then run the following import command:"
echo ""
echo "impdp system/manager@\${PROD_SID} \\"
echo "  tables=\${TABLE_OWNER}.\${TABLE_NAME} \\"
echo "  remap_table=\${TABLE_OWNER}.\${TABLE_NAME}:\${TABLE_OWNER}.\${TABLE_NAME}_REC \\"
echo "  directory=DATA_PUMP_DIR \\"
echo "  dumpfile=\${DUMPFILE} \\"
echo "  logfile=\${TABLE_NAME}_impdp_\${RECOVERY_DATE}.log"
echo ""
log "Copy dump file to production Data Pump directory first if on a different host."

# Phase 7: Cleanup instructions (not auto-executed)
log "=== CLEANUP (run after import is verified) ==="
echo "export ORACLE_SID=\${AUX_SID}"
echo "sqlplus / as sysdba <<EOF"
echo "SHUTDOWN ABORT;"
echo "EXIT;"
echo "EOF"
echo "rm -rf \${AUX_DEST}/data/* \${AUX_DEST}/redo/*"
echo "rm /tmp/init\${AUX_SID}.ora \${ORACLE_HOME}/dbs/orapw\${AUX_SID}"
echo ""
log "Full log: \${LOG}"
log "Done."
\`\`\`

---

## Summary

| Phase | Task | Est. Time |
|-------|------|-----------|
| 1 | Locate primary control file backup piece via LIST BACKUP | 5 min |
| 2 | Create auxiliary directories, init.ora, password file | 10 min |
| 3 | Start auxiliary NOMOUNT, restore CF with RESTORE FROM PIECE, mount | 10 min |
| 4 | Restore + recover target tablespace to point in time | 20–120 min |
| 5 | Open RESETLOGS, create Data Pump directory, export table | 15 min |
| 6 | Copy dump to production, impdp with remap | 10 min |
| 7 | Shut down auxiliary, clean up files | 5 min |

**Key commands:**
- \`RESTORE FROM PIECE '<handle>' AUXILIARY CONTROLFILE\` — bypasses catalog, uses named primary piece
- \`ALTER DATABASE MOUNT CLONE DATABASE\` — if this returns ORA-01666, the CF piece is still a standby backup
- \`expdp ... directory=RECOVERY_DUMP dumpfile=...\` — extracts the recovered table
- \`impdp ... remap_table=OWNER.TABLE:OWNER.TABLE_REC\` — imports without overwriting production data

**Prevention:** Schedule \`BACKUP TAG 'PRIMARY_CTRL_WEEKLY' CURRENT CONTROLFILE\` on the primary node weekly. A tagged primary piece on the media eliminates the ambiguity that causes ORA-01666.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'Runbook: Recovering a Table After RECOVER TABLE Fails with ORA-01666 in a Data Guard Environment',
    slug,
    excerpt: 'Step-by-step manual auxiliary TSPITR procedure for when RMAN RECOVER TABLE aborts with ORA-01666 because it selected a standby control file backup. Covers locating the primary control file backup piece, preparing the auxiliary instance, using RESTORE FROM PIECE to bypass catalog selection, tablespace point-in-time recovery, Data Pump export/import to production, and a complete automation script.',
    content,
    category: 'disaster-recovery',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
