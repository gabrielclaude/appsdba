import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ora-01017-ora-16191-data-guard-rac-asm-password-file-runbook';

const content = `
## Purpose

Use this runbook when a Data Guard physical standby on RAC fails to apply redo with ORA-01017 (invalid username/password; logon denied) or ORA-16191 (Primary log shipping client not logged on standby) — both of which indicate that the standby cannot authenticate the redo transport connection from the primary. This pattern is nearly always caused by a stale or missing password file in the standby ASM, or by the clusterware not being updated to reference the current password file path.

Environment: Primary database DB_UNIQUE_NAME=PRODDB (nodes primary-rac1, primary-rac2), Standby database DB_UNIQUE_NAME=STBYDB (node standby-node1). Oracle Home: /u01/app/oracle/product/12.1.0.2. Password files are stored in ASM under +DATA.

Phase flow: confirm the failure pattern → inventory password file config → check thread gap → extract password file from primary ASM → transfer to standby → register in standby ASM → update clusterware → restart standby and enable MRP → monitor gap closure → automation script → troubleshooting.

---

## Phase 1 — Confirm Authentication Failure Pattern

Before touching any password file, confirm that ORA-01017 or ORA-16191 is the actual error and not a symptom of something else (network partition, standby in wrong state, parameter mismatch).

**Check the alert log on the standby for the error signature:**

\`\`\`bash
# On standby-node1 — scan alert log for the relevant ORA codes
export ORACLE_BASE=/u01/app/oracle
export ORACLE_SID=STBYDB1

ALERT_LOG=\$(find \$ORACLE_BASE/diag/rdbms/stbydb -name "alert_*.log" | head -1)
echo "Alert log: \$ALERT_LOG"

grep -E "ORA-01017|ORA-16191|Error 1017|Error 16191" \$ALERT_LOG | tail -20
\`\`\`

**Expected output when the password file is mismatched:**

\`\`\`
MRP0: Background Media Recovery terminated with error 16191
ORA-16191: Primary log shipping client not logged on standby
...
ORA-01017: invalid username/password; logon denied
\`\`\`

**Query V$DATAGUARD_STATUS for Data Guard events in the last 4 hours:**

\`\`\`sql
-- On the standby (sqlplus / as sysdba)
SELECT timestamp,
       severity,
       dest_id,
       message
FROM   v\$dataguard_status
WHERE  timestamp > SYSDATE - 4/24
ORDER  BY timestamp DESC;
\`\`\`

Look for SEVERITY='Error' entries with ORA-01017 or ORA-16191. If you only see INFO-level messages and no errors, the standby may be healthy — re-examine whether the primary is actually shipping.

**Verify the standby is mounted and in the correct role:**

\`\`\`sql
-- On the standby
SELECT name, open_mode, database_role, db_unique_name
FROM   v\$database;
\`\`\`

Expected:

\`\`\`
NAME   OPEN_MODE         DATABASE_ROLE    DB_UNIQUE_NAME
------ ----------------- ---------------- --------------
PRODDB MOUNTED           PHYSICAL STANDBY STBYDB
\`\`\`

If OPEN_MODE shows READ WRITE and DATABASE_ROLE is PRIMARY, the standby has been accidentally opened — stop here and investigate before proceeding.

**Confirm LOG_ARCHIVE_DEST_2 is in ERROR state on the primary:**

\`\`\`sql
-- On the primary (primary-rac1 or primary-rac2, any node)
SELECT dest_id,
       dest_name,
       status,
       error,
       target,
       archiver
FROM   v\$archive_dest_status
WHERE  dest_id = 2;
\`\`\`

A password file mismatch shows:

\`\`\`
DEST_ID  STATUS  ERROR
-------- ------- -------------------------------------------
2        ERROR   ORA-01017: invalid username/password; logon denied
\`\`\`

If STATUS is VALID with no error, shipping is working — the standby may just be catching up. Do not proceed with a password file replacement if shipping is healthy.

---

## Phase 2 — Inventory Password File Configuration

Before extracting anything, document the current configuration on both sides. This is your rollback baseline.

**On the primary — srvctl password file registration:**

\`\`\`bash
# On primary-rac1
srvctl config database -d PRODDB | grep -i "Password file"
\`\`\`

Expected on a 12c RAC with ASM-managed password file:

\`\`\`
Password file: +DATA/PRODDB/PASSWORD/orapwproddb
\`\`\`

**On the standby — srvctl password file registration:**

\`\`\`bash
# On standby-node1
srvctl config database -d STBYDB | grep -i "Password file"
\`\`\`

**Check for a filesystem-level password file (11g fallback path):**

\`\`\`bash
# On primary-rac1
ls -l /u01/app/oracle/product/12.1.0.2/dbs/orapw*

# On standby-node1
ls -l /u01/app/oracle/product/12.1.0.2/dbs/orapw*
\`\`\`

On 12c with ASM, this typically returns "No such file or directory" — which is expected. If a filesystem password file exists alongside an ASM one, the precedence order matters: ASM-registered path wins when srvctl is configured to point at it.

**Verify remote_login_passwordfile on both sides:**

\`\`\`sql
-- On primary (sqlplus / as sysdba)
SHOW PARAMETER remote_login_passwordfile;

-- On standby (sqlplus / as sysdba)
SHOW PARAMETER remote_login_passwordfile;
\`\`\`

Both must return EXCLUSIVE or SHARED. If either returns NONE, Data Guard password-based authentication cannot work — fix the parameter first (requires restart).

**Locate the current ASM-registered password file on the primary:**

\`\`\`bash
# On primary-rac1 as oracle or grid user with ASM access
export ORACLE_SID=+ASM1
export ORACLE_HOME=/u01/app/grid/product/12.1.0.2/grid
export PATH=\$ORACLE_HOME/bin:\$PATH

asmcmd pwget --dbuniquename PRODDB
\`\`\`

This returns the full ASM path, typically:

\`\`\`
+DATA/PRODDB/PASSWORD/orapwproddb
\`\`\`

Record this path — it is the source for the extraction in Phase 4.

---

## Phase 3 — Confirm Thread Gap Status

Quantify the gap before and after the fix so you can confirm recovery is progressing after MRP restart.

**Thread gap query — run on standby:**

\`\`\`sql
-- On the standby (sqlplus / as sysdba)
SELECT a.thread#,
       a.sequence# AS last_applied,
       b.sequence# AS last_received,
       b.sequence# - a.sequence# AS gap_count
FROM  (SELECT thread#, MAX(sequence#) AS sequence#
       FROM   v\$archived_log
       WHERE  applied = 'YES'
       GROUP  BY thread#) a,
      (SELECT thread#, MAX(sequence#) AS sequence#
       FROM   v\$archived_log
       GROUP  BY thread#) b
WHERE  a.thread# = b.thread#
ORDER  BY a.thread#;
\`\`\`

**V$ARCHIVE_GAP on the standby:**

\`\`\`sql
SELECT thread#, low_sequence#, high_sequence#
FROM   v\$archive_gap;
\`\`\`

If this query returns no rows, there is no detected gap — but the shipping failure (ORA-16191) may have been going on long enough that many sequences are missing. Cross-check against the primary:

\`\`\`sql
-- On primary (any node)
SELECT thread#, MAX(sequence#) AS current_sequence
FROM   v\$log_history
GROUP  BY thread#
ORDER  BY thread#;
\`\`\`

Compare the primary's current sequences to what the standby shows as last_received. The difference is the true gap. Note both thread numbers and sequence numbers — you will use this after MRP restart to confirm recovery is flowing.

---

## Phase 4 — Extract Password File from Primary ASM

The password file in ASM cannot be read directly — you must use asmcmd pwcopy to export it to the filesystem first.

\`\`\`bash
# On primary-rac1, as oracle user (must have ASM access via asmdba group)
export ORACLE_SID=+ASM1
export ORACLE_HOME=/u01/app/grid/product/12.1.0.2/grid
export PATH=\$ORACLE_HOME/bin:\$PATH

# Extract password file from primary ASM to /tmp
asmcmd pwcopy +DATA/PRODDB/PASSWORD/orapwproddb /tmp/orapw_primary

echo "Exit code: \$?"
\`\`\`

If you get "ASMCMD-08006: The file does not exist" — the path registered in srvctl may be wrong. Confirm the actual path:

\`\`\`bash
# List password directory in ASM
asmcmd ls +DATA/PRODDB/PASSWORD/
\`\`\`

If the PASSWORD directory does not exist, the password file is stored elsewhere (possibly under a different disk group). Search:

\`\`\`bash
asmcmd find +DATA . '*orapw*'
asmcmd find +RECO . '*orapw*'
\`\`\`

**Verify the extracted file exists and has reasonable size:**

\`\`\`bash
ls -lh /tmp/orapw_primary
\`\`\`

A standard Oracle 12c password file is typically 10–30 KB. If it shows 0 bytes, the extraction failed silently — do not proceed.

> **Note:** This step must be run as the oracle OS user or the grid OS user, depending on which user owns the ASM instance. The user must be in the asmdba OS group. If you receive "ORA-15001: diskgroup does not exist or is not mounted" during pwcopy, verify \$ORACLE_SID is set to +ASM1 (not to the database SID).

---

## Phase 5 — Transfer Password File to Standby Server

\`\`\`bash
# On primary-rac1 — SCP to standby
scp /tmp/orapw_primary oracle@standby-node1:/tmp/orapw_standby
\`\`\`

If SSH keys are not set up between primary and standby oracle users, you will be prompted for a password. In environments where direct oracle-to-oracle SCP is blocked, transfer via bastion or shared NFS:

\`\`\`bash
# Alternative: copy to shared NFS mount if available
cp /tmp/orapw_primary /nfs/shared/transfer/orapw_standby

# On standby-node1
cp /nfs/shared/transfer/orapw_standby /tmp/orapw_standby
\`\`\`

**Verify the file arrived on the standby:**

\`\`\`bash
# On standby-node1
ls -lh /tmp/orapw_standby
\`\`\`

Confirm:
1. File exists
2. Size matches what was on primary-rac1 (compare \`ls -lh\` output from Phase 4 and this step)
3. File is owned by oracle or readable by oracle

\`\`\`bash
# Fix ownership if needed (run as root on standby-node1)
chown oracle:oinstall /tmp/orapw_standby
chmod 640 /tmp/orapw_standby
\`\`\`

---

## Phase 6 — Register New Password File in Standby ASM

Do not delete the old ASM password file before confirming the new one is registered and working. Rename it instead — this preserves a one-step rollback.

\`\`\`bash
# On standby-node1 — connect to ASM
export ORACLE_SID=+ASM
export ORACLE_HOME=/u01/app/grid/product/12.1.0.2/grid
export PATH=\$ORACLE_HOME/bin:\$PATH

asmcmd
\`\`\`

**Inside asmcmd — rename the stale password file:**

\`\`\`
ASMCMD> mv +DATA/STBYDB/PASSWORD/orapwstbydb +DATA/STBYDB/PASSWORD/orapwstbydb.bak.20260716
\`\`\`

Replace 20260716 with today's date in YYYYMMDD format. This preserves the old file without it being picked up by Oracle.

**Copy the new password file from /tmp into ASM:**

\`\`\`
ASMCMD> pwcopy /tmp/orapw_standby +DATA/STBYDB/PASSWORD/orapwstbydb
\`\`\`

**Verify both files are now visible in ASM:**

\`\`\`
ASMCMD> ls +DATA/STBYDB/PASSWORD/
\`\`\`

Expected output:

\`\`\`
orapwstbydb
orapwstbydb.bak.20260716
\`\`\`

Exit asmcmd:

\`\`\`
ASMCMD> exit
\`\`\`

---

## Phase 7 — Update Clusterware Registration

The CRS resource for STBYDB must be updated to point at the new password file path. Even though the filename did not change, clusterware caches the path metadata and must be refreshed.

\`\`\`bash
# On standby-node1
srvctl modify database -d STBYDB -pwfile +DATA/STBYDB/PASSWORD/orapwstbydb
\`\`\`

**Verify the registration was applied:**

\`\`\`bash
srvctl config database -d STBYDB | grep -i "Password file"
\`\`\`

Expected:

\`\`\`
Password file: +DATA/STBYDB/PASSWORD/orapwstbydb
\`\`\`

If srvctl modify returns "PRCD-1084: Failed to modify database STBYDB" or similar, confirm CRS is running:

\`\`\`bash
crsctl stat res -t | grep -E "ONLINE|OFFLINE"
\`\`\`

All ora.* resources should show ONLINE. If CRS itself is down, start it before proceeding:

\`\`\`bash
# As root on standby-node1
crsctl start crs
\`\`\`

---

## Phase 8 — Restart Standby and Enable Managed Recovery

A database restart is required for Oracle to pick up the new password file from ASM. Simply re-registering with srvctl is not sufficient — the running instance still holds the old credentials in memory.

**Stop the standby:**

\`\`\`bash
# On standby-node1
srvctl stop database -d STBYDB -o immediate
\`\`\`

Confirm it is down:

\`\`\`bash
srvctl status database -d STBYDB
\`\`\`

Expected: "Database is not running."

**Start the standby in MOUNT mode:**

\`\`\`bash
srvctl start database -d STBYDB -o mount
\`\`\`

Verify mount:

\`\`\`sql
-- sqlplus / as sysdba
SELECT name, open_mode, database_role FROM v\$database;
\`\`\`

Expected: OPEN_MODE = MOUNTED, DATABASE_ROLE = PHYSICAL STANDBY.

**Enable Managed Recovery Process (MRP):**

\`\`\`sql
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE DISCONNECT FROM SESSION;
\`\`\`

The DISCONNECT FROM SESSION clause allows MRP to run in the background so your SQL*Plus session is returned immediately.

**Verify MRP started:**

\`\`\`sql
-- Check Data Guard status for shipping confirmation
SELECT timestamp, severity, message
FROM   v\$dataguard_status
WHERE  timestamp > SYSDATE - 1/24
ORDER  BY timestamp DESC;

-- Verify MRP process is running
SELECT process, status, thread#, sequence#, block#
FROM   v\$managed_standby
WHERE  process = 'MRP0';
\`\`\`

Expected MRP0 row: STATUS = 'APPLYING_LOG' or 'WAIT_FOR_LOG'. If MRP0 is absent or shows ERROR, check the alert log immediately — the password file replacement may not have taken effect or there is a secondary issue.

---

## Phase 9 — Monitor Gap Closure

After MRP restarts and the primary resumes shipping, the sequence gap should close within minutes on a healthy network.

**Run the thread gap query every 2 minutes:**

\`\`\`sql
-- On the standby — poll every 2 minutes
SELECT a.thread#,
       a.sequence# AS last_applied,
       b.sequence# AS last_received,
       b.sequence# - a.sequence# AS gap_count,
       SYSDATE AS checked_at
FROM  (SELECT thread#, MAX(sequence#) AS sequence#
       FROM   v\$archived_log
       WHERE  applied = 'YES'
       GROUP  BY thread#) a,
      (SELECT thread#, MAX(sequence#) AS sequence#
       FROM   v\$archived_log
       GROUP  BY thread#) b
WHERE  a.thread# = b.thread#
ORDER  BY a.thread#;
\`\`\`

**Watch V$DATAGUARD_STATUS for redo flow confirmation:**

\`\`\`sql
SELECT timestamp, message
FROM   v\$dataguard_status
WHERE  message LIKE '%Media Recovery Log%'
  OR   message LIKE '%RFS%'
  OR   message LIKE '%Fetched%'
ORDER  BY timestamp DESC;
\`\`\`

"Media Recovery Log" messages in V$DATAGUARD_STATUS confirm redo is flowing and being applied. "RFS" messages confirm the Remote File Server is receiving archivelogs from the primary.

**Quick gap count from V$ARCHIVE_GAP:**

\`\`\`sql
SELECT COUNT(*) AS gap_entries FROM v\$archive_gap;
\`\`\`

This view only shows gaps in sequences the standby knows about — it will return 0 once all received logs are applied, even if new ones are still arriving.

**Expected recovery timeline:**

- Within 30 seconds: RFS login messages appear in standby alert log (confirms ORA-01017 is resolved)
- Within 1–2 minutes: MRP0 shows APPLYING_LOG status
- Within 5–15 minutes: Gap count dropping (depends on gap size and network bandwidth)
- Gap fully closed: last_applied equals last_received for all threads

If the gap is not closing after 10 minutes, check whether the primary LOG_ARCHIVE_DEST_2 has returned to VALID status:

\`\`\`sql
-- On primary
SELECT dest_id, status, error FROM v\$archive_dest_status WHERE dest_id = 2;
\`\`\`

---

## Phase 10 — Automation Script (dg_pwfile_sync.sh)

The following script automates Phases 4–8. It is designed to run in two phases: PRIMARY (run on primary-rac1 to extract and transfer the password file) and STANDBY (run on standby-node1 to register the new file and restart MRP). Split execution allows for network isolation or jump-host environments where the primary and standby cannot directly invoke scripts on each other.

\`\`\`bash
#!/bin/bash
# dg_pwfile_sync.sh
# Usage:
#   Phase 1 (run on primary-rac1):   ./dg_pwfile_sync.sh PRIMARY
#   Phase 2 (run on standby-node1):  ./dg_pwfile_sync.sh STANDBY
#
# Prerequisites:
#   - oracle OS user on primary must be in asmdba group
#   - SSH key-based auth from primary oracle to standby oracle (for PRIMARY phase)
#   - CRS must be running on standby (for STANDBY phase)

# ============================================================
# CONFIGURATION — edit these before running
# ============================================================
PRIMARY_DB="PRODDB"
STANDBY_DB="STBYDB"
PRIMARY_ASM_PATH="+DATA/PRODDB/PASSWORD/orapwproddb"
STANDBY_ASM_PATH="+DATA/STBYDB/PASSWORD/orapwstbydb"
STANDBY_HOST="standby-node1"
TEMP_DIR="/tmp"
ORACLE_USER="oracle"
ORACLE_HOME="/u01/app/oracle/product/12.1.0.2"
GRID_HOME="/u01/app/grid/product/12.1.0.2/grid"
ASM_SID="+ASM"

# ============================================================
# LOGGING SETUP
# ============================================================
TIMESTAMP=\$(date +%Y%m%d_%H%M%S)
LOGFILE="\$TEMP_DIR/dg_pwfile_sync_\$TIMESTAMP.log"

log() {
  local msg="[\$(date '+%Y-%m-%d %H:%M:%S')] \$1"
  echo "\$msg"
  echo "\$msg" >> "\$LOGFILE"
}

log_ok()   { log "[OK]   \$1"; }
log_fail() { log "[FAIL] \$1"; }
log_info() { log "[INFO] \$1"; }

die() {
  log_fail "\$1"
  log "Script aborted. Log: \$LOGFILE"
  exit 1
}

# ============================================================
# SHARED: verify environment
# ============================================================
verify_oracle_env() {
  log_info "Verifying Oracle environment..."
  [ -d "\$ORACLE_HOME" ] || die "ORACLE_HOME does not exist: \$ORACLE_HOME"
  [ -d "\$GRID_HOME" ]   || die "GRID_HOME does not exist: \$GRID_HOME"
  export PATH="\$GRID_HOME/bin:\$ORACLE_HOME/bin:\$PATH"
  log_ok "Oracle environment OK"
}

# ============================================================
# PRIMARY PHASE: extract password file and SCP to standby
# ============================================================
run_primary_phase() {
  log_info "Starting PRIMARY phase — extracting password file from ASM"
  log_info "Log file: \$LOGFILE"

  verify_oracle_env

  local tmp_pwfile="\$TEMP_DIR/orapw_primary_\$TIMESTAMP"

  # Step 1: Extract from primary ASM
  log_info "Extracting password file from primary ASM: \$PRIMARY_ASM_PATH"
  export ORACLE_SID="\${ASM_SID}1"
  asmcmd pwcopy "\$PRIMARY_ASM_PATH" "\$tmp_pwfile" >> "\$LOGFILE" 2>&1
  [ \$? -eq 0 ] || die "asmcmd pwcopy failed — check ORACLE_SID=\${ASM_SID}1, asmdba membership, and ASM path"

  # Step 2: Verify extracted file
  [ -s "\$tmp_pwfile" ] || die "Extracted password file is empty or missing: \$tmp_pwfile"
  local fsize
  fsize=\$(ls -lh "\$tmp_pwfile" | awk '{print \$5}')
  log_ok "Password file extracted: \$tmp_pwfile (size: \$fsize)"

  # Step 3: SCP to standby
  log_info "Transferring password file to \$STANDBY_HOST..."
  local remote_path="\$TEMP_DIR/orapw_standby_\$TIMESTAMP"
  scp "\$tmp_pwfile" "\$ORACLE_USER@\$STANDBY_HOST:\$remote_path" >> "\$LOGFILE" 2>&1
  [ \$? -eq 0 ] || die "SCP to \$STANDBY_HOST failed — check SSH keys and oracle@\$STANDBY_HOST access"
  log_ok "Password file transferred to \$STANDBY_HOST:\$remote_path"

  # Step 4: Leave a marker file so STANDBY phase can find the filename
  echo "\$remote_path" > "\$TEMP_DIR/dg_pwfile_sync_latest.txt"
  log_ok "Remote path recorded in \$TEMP_DIR/dg_pwfile_sync_latest.txt"

  log ""
  log "PRIMARY phase complete."
  log "Next: run this script on \$STANDBY_HOST with argument STANDBY"
  log "      ./dg_pwfile_sync.sh STANDBY \$remote_path"
  log ""
  log "Log: \$LOGFILE"
}

# ============================================================
# STANDBY PHASE: register password file, update srvctl, restart MRP
# ============================================================
run_standby_phase() {
  local tmp_pwfile="\${1:-}"

  # Allow passing path as argument or reading from marker file
  if [ -z "\$tmp_pwfile" ]; then
    [ -f "\$TEMP_DIR/dg_pwfile_sync_latest.txt" ] \
      && tmp_pwfile=\$(cat "\$TEMP_DIR/dg_pwfile_sync_latest.txt") \
      || die "No password file path provided and no marker file found at \$TEMP_DIR/dg_pwfile_sync_latest.txt"
  fi

  log_info "Starting STANDBY phase"
  log_info "Using password file: \$tmp_pwfile"
  log_info "Log file: \$LOGFILE"

  verify_oracle_env

  # Step 1: Verify the transferred file exists
  [ -s "\$tmp_pwfile" ] || die "Password file not found or empty on standby: \$tmp_pwfile"
  log_ok "Password file found on standby: \$tmp_pwfile"

  # Step 2: Rename old ASM password file
  local bak_date
  bak_date=\$(date +%Y%m%d)
  local bak_path="\${STANDBY_ASM_PATH}.bak.\$bak_date"
  log_info "Renaming old ASM password file to \$bak_path"
  export ORACLE_SID="\$ASM_SID"
  asmcmd mv "\$STANDBY_ASM_PATH" "\$bak_path" >> "\$LOGFILE" 2>&1
  if [ \$? -ne 0 ]; then
    log_fail "asmcmd mv failed — old password file may already be missing. Continuing..."
  else
    log_ok "Old password file renamed to \$bak_path"
  fi

  # Step 3: Register new password file in standby ASM
  log_info "Copying new password file to standby ASM: \$STANDBY_ASM_PATH"
  asmcmd pwcopy "\$tmp_pwfile" "\$STANDBY_ASM_PATH" >> "\$LOGFILE" 2>&1
  [ \$? -eq 0 ] || die "asmcmd pwcopy to standby ASM failed"
  log_ok "New password file registered in ASM: \$STANDBY_ASM_PATH"

  # Step 4: Verify ASM entry
  log_info "Verifying ASM password directory..."
  asmcmd ls "\$(dirname "\$STANDBY_ASM_PATH")/" >> "\$LOGFILE" 2>&1
  log_ok "ASM listing complete — check \$LOGFILE for contents"

  # Step 5: Update srvctl clusterware registration
  log_info "Updating srvctl clusterware registration for \$STANDBY_DB"
  export ORACLE_HOME="\$ORACLE_HOME"
  srvctl modify database -d "\$STANDBY_DB" -pwfile "\$STANDBY_ASM_PATH" >> "\$LOGFILE" 2>&1
  [ \$? -eq 0 ] || die "srvctl modify database failed — verify CRS is running (crsctl stat res -t)"
  log_ok "srvctl clusterware updated for \$STANDBY_DB"

  # Step 6: Verify srvctl registration
  local pwfile_check
  pwfile_check=\$(srvctl config database -d "\$STANDBY_DB" | grep -i "Password file")
  log_ok "srvctl config: \$pwfile_check"

  # Step 7: Stop standby database
  log_info "Stopping standby database \$STANDBY_DB (immediate)..."
  srvctl stop database -d "\$STANDBY_DB" -o immediate >> "\$LOGFILE" 2>&1
  [ \$? -eq 0 ] || die "srvctl stop database failed"
  log_ok "Standby database stopped"

  # Step 8: Start standby in mount mode
  log_info "Starting standby database \$STANDBY_DB in mount mode..."
  srvctl start database -d "\$STANDBY_DB" -o mount >> "\$LOGFILE" 2>&1
  [ \$? -eq 0 ] || die "srvctl start database (mount) failed — check alert log for ORA errors"
  log_ok "Standby database started in MOUNT mode"

  # Step 9: Enable MRP
  log_info "Enabling Managed Recovery Process (MRP)..."
  export ORACLE_SID=\$(srvctl status database -d "\$STANDBY_DB" | grep -oE '[A-Z0-9]+[0-9]' | head -1)
  sqlplus -s / as sysdba >> "\$LOGFILE" 2>&1 << 'SQLEOF'
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE DISCONNECT FROM SESSION;
EXIT;
SQLEOF
  [ \$? -eq 0 ] || die "ALTER DATABASE RECOVER MANAGED STANDBY failed — check alert log"
  log_ok "MRP started (DISCONNECT FROM SESSION)"

  log ""
  log "STANDBY phase complete."
  log "Monitor gap closure with:"
  log "  SELECT thread#, MAX(sequence#) FROM v\$archived_log WHERE applied='YES' GROUP BY thread#;"
  log "  SELECT process, status, sequence# FROM v\$managed_standby WHERE process='MRP0';"
  log ""
  log "Log: \$LOGFILE"
}

# ============================================================
# MAIN
# ============================================================
PHASE="\${1:-}"

case "\$PHASE" in
  PRIMARY)
    run_primary_phase
    ;;
  STANDBY)
    run_standby_phase "\${2:-}"
    ;;
  *)
    echo "Usage: \$0 <PRIMARY|STANDBY> [standby_tmp_pwfile_path]"
    echo "  PRIMARY  — run on primary-rac1: extracts password file from ASM and SCPs to standby"
    echo "  STANDBY  — run on standby-node1: registers file in ASM, updates srvctl, restarts MRP"
    exit 1
    ;;
esac
\`\`\`

**Usage sequence:**

\`\`\`bash
# On primary-rac1 — set oracle environment first
export ORACLE_HOME=/u01/app/oracle/product/12.1.0.2
export PATH=\$ORACLE_HOME/bin:\$PATH

chmod +x dg_pwfile_sync.sh
./dg_pwfile_sync.sh PRIMARY

# Then on standby-node1
export ORACLE_HOME=/u01/app/oracle/product/12.1.0.2
export PATH=\$ORACLE_HOME/bin:\$PATH

./dg_pwfile_sync.sh STANDBY /tmp/orapw_standby_20260716_180500
\`\`\`

---

## Phase 11 — Troubleshooting

### ORA-16191 persists after password file replacement

If ORA-16191 still appears after completing all phases, the CRS resource may have cached the old credential. Try a full CRS stop/start on the standby:

\`\`\`bash
# On standby-node1 as root — WARNING: this affects all CRS resources
crsctl stop crs
crsctl start crs

# Wait for CRS to come up, then check database resource status
crsctl stat res -t | grep STBYDB

# Start standby again if it did not auto-start
srvctl start database -d STBYDB -o mount
\`\`\`

Also verify that the password file content is actually correct — if the primary password was changed after the standby was built, a pwcopy of the current primary file is what you need. If the SYS password on the primary was recently changed without propagating to the standby, re-copy the current file and repeat Phases 6–8.

### asmcmd pwcopy fails

\`\`\`
ASMCMD-08201: Oracle instance not available for diskgroup
\`\`\`

This means ORACLE_SID is not pointing at the ASM instance. Verify:

\`\`\`bash
ps -ef | grep asm_pmon | grep -v grep
# Look for something like: asm_pmon_+ASM1

export ORACLE_SID=+ASM1   # match the instance name from ps output
export ORACLE_HOME=/u01/app/grid/product/12.1.0.2/grid
asmcmd ls +DATA/PRODDB/PASSWORD/
\`\`\`

Also check grid user permissions — on some installations, only the grid OS user (not oracle) has direct ASM access. In that case, either switch to the grid user or add oracle to the asmdba group.

### ORA-01031 instead of ORA-01017

ORA-01031 (insufficient privileges) in the Data Guard context usually means the OSDBA group on the standby does not match the primary. Check:

\`\`\`bash
# On standby-node1
srvctl config database -d STBYDB | grep -i OSDBA

# Compare to primary
srvctl config database -d PRODDB | grep -i OSDBA
\`\`\`

If the group names differ, update the standby srvctl registration:

\`\`\`bash
srvctl modify database -d STBYDB -osdba dba
\`\`\`

Replace \`dba\` with the actual OSDBA group name from the primary.

### MRP will not start after password file fix

If MRP starts but immediately exits with ORA-16037 (Managed Standby Recovery not started — recovery was manually cancelled):

\`\`\`sql
-- Cancel any lingering recovery state
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE CANCEL;

-- Wait 30 seconds, then re-enable
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE DISCONNECT FROM SESSION;
\`\`\`

If MRP exits with ORA-00283 (recovery session cancelled due to errors), check V$DATAGUARD_STATUS and the alert log for the underlying ORA code — it may be an archived log gap that requires fetching archivelogs from the primary manually using RMAN.

### Standby will not mount after restart

If the standby fails to mount (ORA-00205, ORA-27037, or similar), this is a separate issue from the password file. Common causes:

1. **Controlfile corruption** — restore from an autobackup or from primary RMAN
2. **ASM disk group not mounted** — check \`asmcmd lsdg\` and remount if needed
3. **Datafile path mismatch** — check the alert log for specific ORA-01157 entries

Do not attempt a new password file copy until the standby mounts cleanly.

### srvctl modify fails

\`\`\`
PRCD-1084: Failed to modify database STBYDB
\`\`\`

Verify CRS is running and the database resource is registered:

\`\`\`bash
crsctl stat res -t | grep -E "ora.stbydb|ONLINE|OFFLINE"
\`\`\`

If the resource is missing from CRS, re-add it:

\`\`\`bash
# As oracle on standby-node1 — re-register the database with CRS
# Adjust -spfile, -osdba, and -role as appropriate for your environment
srvctl add database -d STBYDB \
  -o /u01/app/oracle/product/12.1.0.2 \
  -p +DATA/STBYDB/PARAMETERFILE/spfile.ora \
  -r physical_standby \
  -s mount \
  -t IMMEDIATE
\`\`\`

---

## Quick Reference Table

| Symptom | Likely Cause | First Command to Run |
|---------|-------------|----------------------|
| ORA-16191 in standby alert log | Standby password file does not match primary SYS password | \`asmcmd pwget --dbuniquename STBYDB\` on standby — confirm path exists |
| ORA-01017 in V$DATAGUARD_STATUS | Stale or missing ASM password file on standby | \`asmcmd ls +DATA/STBYDB/PASSWORD/\` on standby-node1 |
| LOG_ARCHIVE_DEST_2 STATUS=ERROR on primary | Redo transport authentication failing to standby | \`SELECT error FROM v\$archive_dest_status WHERE dest_id=2\` on primary |
| MRP0 not in V$MANAGED_STANDBY | MRP not started, or exited after ORA-16037 | \`ALTER DATABASE RECOVER MANAGED STANDBY DATABASE DISCONNECT FROM SESSION\` |
| asmcmd pwcopy ASMCMD-08201 | ORACLE_SID not set to ASM instance | \`export ORACLE_SID=+ASM1; asmcmd ls +DATA\` |
| ORA-01031 in DG transport | OSDBA group mismatch between primary and standby | \`srvctl config database -d STBYDB \\| grep OSDBA\` |
| srvctl modify fails PRCD-1084 | CRS not running or DB resource missing | \`crsctl stat res -t \\| grep stbydb\` |
| Gap not closing after MRP restart | Network issue or primary still in ERROR state | \`SELECT status, error FROM v\$archive_dest_status WHERE dest_id=2\` on primary |
| ORA-00205 on standby startup | Controlfile inaccessible or corrupted | \`asmcmd lsdg\` — verify +DATA disk group is MOUNTED |
| Standby mounts but applies stop quickly | Archived log gap requiring manual fetch | \`SELECT * FROM v\$archive_gap\` on standby, then RMAN fetch from primary |
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'Runbook: ORA-01017 and ORA-16191 Data Guard ASM Password File Sync on RAC',
    slug,
    excerpt: 'Step-by-step runbook for diagnosing and fixing ORA-01017 and ORA-16191 when building or recovering a Data Guard physical standby on RAC with ASM-managed password files. Covers asmcmd pwcopy extraction from primary ASM, secure transfer, standby ASM registration, srvctl clusterware update, managed recovery restart, and gap verification. Includes dg_pwfile_sync.sh automation script.',
    content,
    category: 'disaster-recovery',
    isPremium: false,
    published: true,
    publishedAt: new Date('2026-07-16T18:05:00.000Z'),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
