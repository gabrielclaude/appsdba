import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'oracle-19c-cdb-recovery-failed-clone-runbook';

const content = `
This runbook covers the step-by-step recovery of an Oracle 19c CDB that was left in NOMOUNT state after an interrupted nightly clone job. It includes environment assessment, RMAN backup-location-based duplicate execution, PDB rename, and Oracle Bug 31143870 remediation. An automated recovery script is provided at the end.

---

## Phase 1 — Assess the Database State

\`\`\`bash
# Set the QA Oracle environment
export ORACLE_SID=CDBQA
export ORACLE_HOME=/u01/qa/product/19.3.0.0

# Attempt to start the database — confirm it is stuck at NOMOUNT
sqlplus / as sysdba
\`\`\`

\`\`\`sql
-- Try to mount — expect failure if clone was aborted
ALTER DATABASE MOUNT;
-- Expected: ORA-00205 or similar controlfile error

-- Confirm current state
SELECT STATUS, DATABASE_STATUS FROM V$INSTANCE;

-- Check alert log for the error at startup
EXIT;
\`\`\`

\`\`\`bash
# Find and review the alert log
DIAG_DEST=$(sqlplus -s / as sysdba <<'SQLEOF'
SET PAGES 0 FEED OFF HEAD OFF
SELECT value FROM v$diag_info WHERE name='Diag Trace';
EXIT;
SQLEOF
)

tail -50 $DIAG_DEST/alert_\${ORACLE_SID}.log
\`\`\`

---

## Phase 2 — Locate Usable Backups

\`\`\`bash
BACKUP_DIR=/backups/dbprod01

# Check if QA backups exist (they likely do not after a failed clone)
ls -ltrh $BACKUP_DIR/CDBQA* 2>/dev/null || echo "No CDBQA backup files found"

# Check for production backups accessible from the QA host
ls -ltrh $BACKUP_DIR/ | tail -20

# Check for controlfile autobackups (pattern: c-<DBID>-<date>-<seq>)
ls -ltrh $BACKUP_DIR/c-* | tail -10

# Confirm backup files are readable by oracle OS user
ls -la $BACKUP_DIR/c-* | head -5
\`\`\`

---

## Phase 3 — Obtain Production DBID

You need the exact production DBID to use the DBID clause in the duplicate command. Connect to the production database:

\`\`\`bash
export ORACLE_SID=CDBPROD
export ORACLE_HOME=/u01/prod/product/19.3.0.0
sqlplus / as sysdba
\`\`\`

\`\`\`sql
SET LINES 140
COL dbid FOR 99999999999999999
COL name FOR a20
SELECT dbid, name FROM v$database;
\`\`\`

Record the DBID (e.g., \`1234567890\`). You can also extract it from the controlfile autobackup filename: \`c-1234567890-20260209-01\` → DBID is \`1234567890\`.

---

## Phase 4 — Prepare for RMAN Duplicate

\`\`\`bash
# Switch back to QA environment
export ORACLE_SID=CDBQA
export ORACLE_HOME=/u01/qa/product/19.3.0.0

# Start the auxiliary instance in NOMOUNT
sqlplus / as sysdba
\`\`\`

\`\`\`sql
SHUTDOWN ABORT;
STARTUP NOMOUNT;
EXIT;
\`\`\`

\`\`\`bash
# Write the duplicate script — replace 1234567890 with actual DBID
# Replace CDBPROD with the exact production CDB name (verify spelling carefully)
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

# Verify the script (double-check spelling of source database name)
cat $HOME/duplicate_cdbqa.rman

# Check available disk space on the QA data disk before starting
df -h /u01/qa /u02/qa /u03/qa 2>/dev/null || df -h /
\`\`\`

---

## Phase 5 — Execute the RMAN Duplicate

\`\`\`bash
# IMPORTANT: Use nohup so the job survives SSH session disconnects
nohup rman auxiliary / @$HOME/duplicate_cdbqa.rman \
  > $HOME/duplicate_cdbqa.log 2>&1 0</dev/null &

echo "RMAN duplicate started with PID: $!"
echo "Monitor with: tail -100f $HOME/duplicate_cdbqa.log"
\`\`\`

### Monitoring the duplicate

\`\`\`bash
# Monitor in real time
tail -100f $HOME/duplicate_cdbqa.log

# Check if RMAN is still running (use bracket pattern to exclude grep itself)
ps -ef | grep [r]man

# Check last 20 lines at any time
tail -20 $HOME/duplicate_cdbqa.log
\`\`\`

### If the session disconnects

\`\`\`bash
# Reconnect and check whether RMAN is still running
ps -ef | grep [r]man

# If the process is still running, do NOT restart — just re-attach to the log
tail -100f $HOME/duplicate_cdbqa.log

# If the process is gone, check the log for the exit status
tail -30 $HOME/duplicate_cdbqa.log
\`\`\`

### Confirm successful completion

A successful duplicate ends with:

\`\`\`
sql statement: alter pluggable database all open
Finished Duplicate Db at <date>

Recovery Manager complete.
\`\`\`

If it ended with RMAN errors, see troubleshooting section below.

---

## Phase 6 — Troubleshoot RMAN-05578 (Controlfile Not Found)

If the duplicate fails with:

\`\`\`
RMAN-05578: CONTROLFILE backup not found for database <name> in <path>
RMAN-05576: CONTROLFILE backup not found for database <name> with DBID <n> in <path>
\`\`\`

**Cause 1:** The database name in the DUPLICATE command has a typo. Check very carefully — transposed letters (CBDPROD instead of CDBPROD) are easy to miss.

**Cause 2:** The DBID was not specified and RMAN is searching by name. The backup files are named after the actual DBID, not the text name.

**Fix:**

\`\`\`bash
# Verify the exact name of the production database
# On the production host:
sqlplus / as sysdba <<'SQLEOF'
SELECT name, dbid FROM v$database;
EXIT;
SQLEOF

# Update the duplicate script with the correct name AND explicit DBID
vi $HOME/duplicate_cdbqa.rman

# Re-run RMAN after restarting auxiliary in NOMOUNT
sqlplus / as sysdba <<'SQLEOF'
SHUTDOWN ABORT;
STARTUP NOMOUNT;
EXIT;
SQLEOF

nohup rman auxiliary / @$HOME/duplicate_cdbqa.rman \
  > $HOME/duplicate_cdbqa_retry.log 2>&1 0</dev/null &
\`\`\`

---

## Phase 7 — Rename the PDB (if name does not match expected)

After duplicate, the PDB is named after the production PDB (e.g., PROD). If the QA environment expects a PDB named QA, rename it:

\`\`\`sql
-- Verify current PDB name
SELECT pdb_name, status FROM dba_pdbs;

-- If PDB is named PROD and needs to be QA:
ALTER PLUGGABLE DATABASE prod CLOSE IMMEDIATE;
ALTER PLUGGABLE DATABASE prod OPEN RESTRICTED;
ALTER SESSION SET CONTAINER = prod;
ALTER PLUGGABLE DATABASE RENAME GLOBAL_NAME TO qa;
ALTER PLUGGABLE DATABASE CLOSE IMMEDIATE;
ALTER PLUGGABLE DATABASE OPEN;

-- Verify rename
SELECT pdb_name, status FROM dba_pdbs;
\`\`\`

If opening the PDB after rename produces errors, proceed to Phase 8.

---

## Phase 8 — Remediate Oracle Bug 31143870 (Orphaned Services)

This bug causes ORA errors when opening a cloned/renamed PDB due to stale service entries in SYS.SERVICE$.

### Diagnosis

\`\`\`sql
-- List all services and look for entries referencing source environment hostnames
SELECT name, pdb FROM dba_services ORDER BY pdb, name;

-- Look for orphaned entries not matching expected service names
SELECT name FROM sys.service$
WHERE name NOT IN (SELECT service_name FROM dba_services WHERE service_name IS NOT NULL);
\`\`\`

### Remediation

\`\`\`sql
-- Step 1: Delete the orphaned service
-- Replace 'dbprod01.example.com' with the actual orphaned service name found above
EXEC DBMS_SERVICE.DELETE_SERVICE(service_name => 'dbprod01.example.com');

DELETE FROM sys.service$ WHERE name = 'dbprod01.example.com';
COMMIT;

-- Step 2: Unplug the PDB
ALTER PLUGGABLE DATABASE qa UNPLUG INTO '/tmp/qa.xml';

-- Step 3: Drop the PDB (KEEP DATAFILES — data files are NOT deleted)
DROP PLUGGABLE DATABASE qa KEEP DATAFILES;

-- Step 4: Bounce the CDB to clear in-memory state
SHUTDOWN IMMEDIATE;
STARTUP;

-- Step 5: Replug the PDB from the XML manifest
CREATE PLUGGABLE DATABASE qa USING '/tmp/qa.xml' NOCOPY;

-- Step 6: Open the PDB
ALTER PLUGGABLE DATABASE qa OPEN;

-- Step 7: Persist the open state across CDB restarts
ALTER PLUGGABLE DATABASE qa SAVE STATE;
\`\`\`

Verify the PDB is open:

\`\`\`sql
SELECT pdb_name, status FROM dba_pdbs;
-- Expected: QA | NORMAL
\`\`\`

---

## Phase 9 — Restore Listener Connectivity

\`\`\`bash
# Check which services are currently registered
lsnrctl status CDBQA

# Look for the Services Summary section
# Confirm the expected service name is listed
\`\`\`

If the expected service is missing:

\`\`\`sql
-- Create the required service inside the PDB context
ALTER SESSION SET CONTAINER = qa;

EXEC DBMS_SERVICE.CREATE_SERVICE(
  service_name   => 'qa_service',
  network_name   => 'qa_service'
);

EXEC DBMS_SERVICE.START_SERVICE(service_name => 'qa_service');
\`\`\`

\`\`\`bash
# Confirm service registered with listener
lsnrctl status CDBQA

# Test connectivity from the database host
sqlplus apps/<password>@localhost:1528/qa_service

# Test from a remote workstation
sqlplus apps/<password>@dbqa01.example.com:1528/qa_service
\`\`\`

---

## Phase 10 — Validate and Retest the Clone Job

After the QA database is confirmed functional, validate by re-running the nightly clone job:

\`\`\`bash
# Run the clone script manually to confirm end-to-end
/etc/cron.d/nightly_clone.sh

# Verify the QA database comes up cleanly after the clone
lsnrctl status CDBQA
sqlplus apps/<password>@dbqa01.example.com:1528/qa_service <<'SQLEOF'
SELECT sysdate, name, open_mode FROM v$database;
SELECT pdb_name, status FROM dba_pdbs;
EXIT;
SQLEOF
\`\`\`

---

## Automated Recovery Script

Save as \`oracle_clone_recovery.sh\`. Customise the variables at the top before use.

\`\`\`bash
#!/bin/bash
# oracle_clone_recovery.sh
# Recovers an Oracle 19c CDB stranded in NOMOUNT after a failed clone
# using RMAN backup-based duplicate from production backups.
#
# Usage: ./oracle_clone_recovery.sh
#
# Prerequisites:
#   - Production backups accessible on the QA host at BACKUP_DIR
#   - Auxiliary (QA) ORACLE_HOME and ORACLE_SID set or configured below
#   - PROD_DBID obtained from production: SELECT dbid FROM v$database;

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────
PROD_CDB="CDBPROD"
PROD_DBID="1234567890"       # Replace with actual DBID from: SELECT dbid FROM v$database
AUX_CDB="CDBQA"
BACKUP_DIR="/backups/dbprod01"
AUX_ORACLE_HOME="/u01/qa/product/19.3.0.0"
AUX_ORACLE_SID="CDBQA"
PDB_EXPECTED_NAME="qa"       # What the QA PDB should be named after rename
PDB_SOURCE_NAME="prod"       # What the PDB will be named right after duplicate
RMAN_SCRIPT="$HOME/duplicate_\${AUX_CDB}.rman"
RMAN_LOG="$HOME/duplicate_\${AUX_CDB}.log"
ORPHAN_SERVICE=""            # Set to orphaned service name if known, e.g. "dbprod01.example.com"
PDB_XML="/tmp/\${PDB_EXPECTED_NAME}.xml"

export ORACLE_HOME=$AUX_ORACLE_HOME
export ORACLE_SID=$AUX_ORACLE_SID
export PATH=$ORACLE_HOME/bin:$PATH

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"; }
run_sql() { sqlplus -s / as sysdba <<< "$1"; }

log "=== Oracle 19c CDB Clone Recovery ==="
log "Auxiliary: $AUX_CDB | Source: $PROD_CDB (DBID: $PROD_DBID)"
log "Backup location: $BACKUP_DIR"

# ── Phase 1: Verify backup location ───────────────────────────────────────
log "Phase 1: Checking backup location..."
if [ ! -d "$BACKUP_DIR" ]; then
  echo "ERROR: Backup directory not found: $BACKUP_DIR" >&2; exit 1
fi

CTLBKP=$(ls -1 $BACKUP_DIR/c-\${PROD_DBID}-* 2>/dev/null | head -1)
if [ -z "$CTLBKP" ]; then
  echo "ERROR: No controlfile autobackup found for DBID $PROD_DBID in $BACKUP_DIR" >&2
  echo "       Check DBID is correct: ls $BACKUP_DIR/c-*" >&2
  exit 1
fi
log "Found controlfile autobackup: $CTLBKP"

# ── Phase 2: Start auxiliary in NOMOUNT ───────────────────────────────────
log "Phase 2: Starting auxiliary $AUX_CDB in NOMOUNT..."
run_sql "SHUTDOWN ABORT; STARTUP NOMOUNT;"
log "$AUX_CDB is in NOMOUNT state"

# ── Phase 3: Write and execute RMAN duplicate ─────────────────────────────
log "Phase 3: Writing RMAN duplicate script..."
cat > "$RMAN_SCRIPT" << RMANEOF
run {
  allocate auxiliary channel ch1 device type disk;
  allocate auxiliary channel ch2 device type disk;
  allocate auxiliary channel ch3 device type disk;
  allocate auxiliary channel ch4 device type disk;

  duplicate database \${PROD_CDB} DBID \${PROD_DBID} to \${AUX_CDB}
  backup location '\${BACKUP_DIR}/';
}
RMANEOF

log "Starting RMAN duplicate (nohup). Log: $RMAN_LOG"
nohup rman auxiliary / @"$RMAN_SCRIPT" > "$RMAN_LOG" 2>&1 0</dev/null &
RMAN_PID=$!

log "RMAN PID: $RMAN_PID — monitoring..."

# Poll for completion
while kill -0 $RMAN_PID 2>/dev/null; do
  sleep 60
  LAST=$(tail -3 "$RMAN_LOG" 2>/dev/null)
  log "RMAN still running... last log: $LAST"
done

if grep -q "Recovery Manager complete\." "$RMAN_LOG" && \
   grep -q "Finished Duplicate Db" "$RMAN_LOG"; then
  log "RMAN duplicate completed successfully"
else
  echo "ERROR: RMAN duplicate may have failed. Review: $RMAN_LOG" >&2
  tail -30 "$RMAN_LOG" >&2
  exit 1
fi

# ── Phase 4: Rename PDB ───────────────────────────────────────────────────
log "Phase 4: Renaming PDB from $PDB_SOURCE_NAME to $PDB_EXPECTED_NAME..."
run_sql "
ALTER PLUGGABLE DATABASE \${PDB_SOURCE_NAME} CLOSE IMMEDIATE;
ALTER PLUGGABLE DATABASE \${PDB_SOURCE_NAME} OPEN RESTRICTED;
ALTER SESSION SET CONTAINER = \${PDB_SOURCE_NAME};
ALTER PLUGGABLE DATABASE RENAME GLOBAL_NAME TO \${PDB_EXPECTED_NAME};
ALTER PLUGGABLE DATABASE CLOSE IMMEDIATE;
ALTER PLUGGABLE DATABASE OPEN;
"
log "PDB renamed to $PDB_EXPECTED_NAME"

# ── Phase 5: Remediate Bug 31143870 (if needed) ───────────────────────────
if [ -n "$ORPHAN_SERVICE" ]; then
  log "Phase 5: Removing orphaned service: $ORPHAN_SERVICE"
  run_sql "
EXEC DBMS_SERVICE.DELETE_SERVICE(service_name => '\${ORPHAN_SERVICE}');
DELETE FROM sys.service\$ WHERE name = '\${ORPHAN_SERVICE}';
COMMIT;
ALTER PLUGGABLE DATABASE \${PDB_EXPECTED_NAME} UNPLUG INTO '\${PDB_XML}';
DROP PLUGGABLE DATABASE \${PDB_EXPECTED_NAME} KEEP DATAFILES;
SHUTDOWN IMMEDIATE;
STARTUP;
CREATE PLUGGABLE DATABASE \${PDB_EXPECTED_NAME} USING '\${PDB_XML}' NOCOPY;
ALTER PLUGGABLE DATABASE \${PDB_EXPECTED_NAME} OPEN;
ALTER PLUGGABLE DATABASE \${PDB_EXPECTED_NAME} SAVE STATE;
"
  log "Unplug/replug cycle complete"
else
  log "Phase 5: No orphan service specified, skipping Bug 31143870 remediation"
  run_sql "ALTER PLUGGABLE DATABASE \${PDB_EXPECTED_NAME} SAVE STATE;"
fi

# ── Phase 6: Verify ───────────────────────────────────────────────────────
log "Phase 6: Verifying recovery..."
run_sql "
SELECT pdb_name, status FROM dba_pdbs;
SELECT name, open_mode FROM v\$database;
"
lsnrctl status $AUX_CDB 2>/dev/null | grep -E "Service|Instance|status READY"

log "=== Recovery complete. Validate connectivity from application servers. ==="
\`\`\`

---

## Version-Specific Notes

### Oracle 19c Standalone (this scenario)

**Description:** The backup-based duplicate method applies directly. The CDB/PDB architecture requires the PDB rename and potential Bug 31143870 remediation after every duplicate. RMAN backup-location-based duplicate does not require a catalog.

**Action plan:**
1. Verify production backup accessibility on QA host.
2. Obtain PROD DBID from production SELECT dbid FROM v$database.
3. Start auxiliary in NOMOUNT. Run duplicate with DBID clause and nohup.
4. After duplicate: rename PDB from PROD to expected name.
5. Handle Bug 31143870 with unplug/replug if PDB open fails.
6. Verify listener service registration and test connectivity.

### Oracle 12c CDB (similar scenario)

**Description:** The backup-based duplicate procedure is identical for Oracle 12c CDB. Bug 31143870 was introduced in 12.1.0.2 and affects 12c as well. PDB rename syntax is the same.

**Action plan:**
1. Same duplicate procedure. Verify patch level — Bug 31143870 fix is included in later 12.2 RUs.
2. If running an early 12.2 release, the unplug/replug workaround is required.
3. Consider applying the patch for Bug 31143870 if clone-to-QA is a recurring operation.

### Non-CDB (pre-12c single instance)

**Description:** In a non-CDB Oracle environment there are no PDBs, so the PDB rename and Bug 31143870 steps do not apply. RMAN duplicate creates a standard Oracle database copy.

**Action plan:**
1. RMAN duplicate to auxiliary using backup location.
2. After duplicate, rename the database if the DB_NAME differs using the NID utility: nid target=/ dbname=<new_name>.
3. Update listener.ora and tnsnames.ora to reflect the new database name and SID.
4. Bounce the listener and verify connectivity.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'Oracle 19c CDB Recovery After Failed Clone: RMAN Duplicate, PDB Rename, and Bug 31143870 Runbook',
    slug,
    excerpt: 'Step-by-step runbook for recovering an Oracle 19c CDB stranded in NOMOUNT after an aborted nightly clone job. Covers backup location assessment, production DBID identification, RMAN backup-based duplicate with nohup, RMAN-05578 troubleshooting, PDB rename, Oracle Bug 31143870 remediation (orphaned services, unplug/replug cycle), and listener service restoration. Includes a parameterised shell script that automates all phases.',
    content,
    category: 'disaster-recovery',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
