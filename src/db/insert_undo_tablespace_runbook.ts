import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Undo Tablespace Sizing, Monitoring, and ORA-01555 Diagnosis',
  slug: 'oracle-undo-tablespace-sizing-ora-01555-runbook',
  excerpt:
    'A phased operational runbook for Oracle DBAs covering undo tablespace configuration audits, V$UNDOSTAT-based sizing calculations, step-by-step ORA-01555 diagnosis, tablespace configuration changes (resize, switch, retention guarantee), local undo mode conversion for CDB/PDB environments, and an automated shell monitoring script with crontab integration.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-05'),
  youtubeUrl: null,
  content: `This runbook covers the full operational lifecycle of Oracle undo tablespace management: initial configuration audit, sizing analysis using \`V$UNDOSTAT\`, ORA-01555 diagnosis, configuration changes, local undo mode conversion for CDB/PDB environments, and continuous monitoring via a shell script. Assumptions: Oracle 12.2 or later, Automatic Undo Management (AUM) enabled (\`UNDO_MANAGEMENT = AUTO\`), the executing user holds the DBA role (SYSDBA is noted explicitly where required), and the database is running on a supported Linux/Unix platform.

---

## Phase 0: Undo Configuration Audit

### Step 0.1 — Check AUM Parameters

Confirm that AUM is enabled and identify the active undo tablespace and current retention setting.

\`\`\`sql
SELECT name, value, description
FROM v\$parameter
WHERE name IN ('undo_management', 'undo_tablespace', 'undo_retention')
ORDER BY name;
\`\`\`

Expected output: \`undo_management = AUTO\`, \`undo_tablespace = UNDOTBS1\` (or equivalent), \`undo_retention = 900\` (default) or a site-specific value. If \`undo_management = MANUAL\`, AUM is not enabled — this runbook does not apply and the rollback segment configuration must be reviewed separately.

### Step 0.2 — Check Undo Tablespace Size and Space Usage

\`\`\`sql
SELECT t.tablespace_name,
       t.status,
       t.retention,
       ROUND(SUM(d.bytes) / 1073741824, 2)                                                    AS total_gb,
       ROUND(SUM(CASE WHEN d.autoextensible = 'YES' THEN d.maxbytes ELSE d.bytes END)
             / 1073741824, 2)                                                                  AS max_gb
FROM   dba_tablespaces t
JOIN   dba_data_files  d ON d.tablespace_name = t.tablespace_name
WHERE  t.contents = 'UNDO'
GROUP BY t.tablespace_name, t.status, t.retention;
\`\`\`

The \`retention\` column shows \`NOGUARANTEE\` or \`GUARANTEE\`. \`max_gb\` reflects the maximum the tablespace can grow to if AUTOEXTEND is enabled — this is the value to use when assessing whether the tablespace can accommodate the required retention.

### Step 0.3 — Check Undo Datafiles and Autoextend Status

\`\`\`sql
SELECT file_name,
       ROUND(bytes / 1073741824, 2)                      AS size_gb,
       autoextensible,
       ROUND(maxbytes / 1073741824, 2)                   AS max_gb,
       increment_by * 8192 / 1048576                     AS increment_mb
FROM   dba_data_files
WHERE  tablespace_name = (
         SELECT value FROM v\$parameter WHERE name = 'undo_tablespace'
       );
\`\`\`

Note any files with \`autoextensible = NO\` — these represent hard limits. An undo tablespace that is both non-autoextensible and fully allocated cannot absorb peak undo generation and will force Oracle to overwrite unexpired undo, causing ORA-01555.

### Step 0.4 — Check Undo Extent States (ACTIVE / UNEXPIRED / EXPIRED)

\`\`\`sql
SELECT status,
       COUNT(*)                                    AS extents,
       ROUND(SUM(bytes) / 1073741824, 3)           AS gb
FROM   dba_undo_extents
GROUP BY status
ORDER BY DECODE(status, 'ACTIVE', 1, 'UNEXPIRED', 2, 'EXPIRED', 3);
\`\`\`

Interpretation:
- **ACTIVE** — undo belonging to uncommitted transactions. Must not be overwritten.
- **UNEXPIRED** — committed within the retention window. Oracle prefers not to overwrite; will do so under space pressure (unless RETENTION GUARANTEE is set).
- **EXPIRED** — committed and past the retention window. Freely reusable.

A healthy tablespace has a comfortable pool of EXPIRED extents. If EXPIRED extents are zero or near-zero and UNEXPIRED is large, the tablespace is under pressure and ORA-01555 risk is elevated.

### Step 0.5 — Check Local Undo Mode (CDB Only)

\`\`\`sql
SELECT property_name, property_value
FROM   database_properties
WHERE  property_name = 'LOCAL_UNDO_ENABLED';
-- TRUE  = 18c+ local undo mode (each PDB owns its undo tablespace)
-- FALSE = 12c shared undo mode (all PDBs share the CDB undo tablespace)
\`\`\`

If the result is FALSE on an 18c+ CDB, consider converting to local undo mode (Phase 4).

---

## Phase 1: Undo Statistics and Sizing Analysis

### Step 1.1 — V$UNDOSTAT: Undo Generation Rate and ORA-01555 History

\`\`\`sql
SELECT begin_time,
       end_time,
       undoblks,
       txncount,
       maxquerylen,
       maxconcurrency,
       tuned_undoretention,
       ssolderrcnt,
       nospaceerrcnt
FROM   v\$undostat
ORDER BY begin_time DESC
FETCH FIRST 48 ROWS ONLY;
-- 48 rows = last 8 hours of 10-minute samples
-- ssolderrcnt  > 0  =>  ORA-01555 errors have occurred in this interval
-- nospaceerrcnt > 0 =>  undo tablespace ran out of space (RETENTION GUARANTEE in effect)
\`\`\`

Key columns to review:
- \`maxquerylen\` vs \`tuned_undoretention\`: if maxquerylen is close to or exceeds tuned_undoretention, ORA-01555 is imminent or already occurring.
- \`ssolderrcnt > 0\` in any recent row requires immediate action.
- \`undoblks\` spike in specific intervals indicates high DML activity — correlate with batch job schedules.

### Step 1.2 — Calculate Required Undo Tablespace Size

The sizing formula: **required\_bytes = peak\_undo\_blocks\_per\_sec × db\_block\_size × target\_retention\_seconds**

\`\`\`sql
-- Uses the last 7 days of V$UNDOSTAT to calculate peak undo generation rate
-- and project required tablespace size at the current UNDO_RETENTION setting.
SELECT ROUND(MAX(undoblks / (
                 (CAST(end_time AS DATE) - CAST(begin_time AS DATE)) * 86400
               )), 2)                                                          AS peak_undo_blocks_per_sec,
       (SELECT TO_NUMBER(value) FROM v\$parameter WHERE name = 'db_block_size')  AS block_size,
       (SELECT TO_NUMBER(value) FROM v\$parameter WHERE name = 'undo_retention') AS undo_retention_sec,
       ROUND(
         MAX(undoblks / ((CAST(end_time AS DATE) - CAST(begin_time AS DATE)) * 86400))
         * (SELECT TO_NUMBER(value) FROM v\$parameter WHERE name = 'db_block_size')
         * (SELECT TO_NUMBER(value) FROM v\$parameter WHERE name = 'undo_retention')
         / 1073741824,
         2
       )                                                                        AS required_undo_gb
FROM   v\$undostat
WHERE  begin_time > SYSDATE - 7;
-- Run during or immediately after the peak workload window for accurate sizing.
-- Add 20-25% headroom to required_undo_gb before provisioning.
\`\`\`

If the target retention should be longer than the current \`UNDO_RETENTION\` parameter (for example, to cover a 3-hour batch job), substitute the target seconds manually: replace the inner \`undo_retention\` subquery with the target value in seconds (e.g., 10800 for 3 hours).

### Step 1.3 — Find Longest-Running Active Queries

Use this during an incident or before a batch window to identify sessions whose undo requirements must be accommodated.

\`\`\`sql
SELECT sid,
       username,
       sql_id,
       ROUND(elapsed_time / 1e6, 0)     AS elapsed_sec,
       ROUND(elapsed_time / 1e6 / 60, 1) AS elapsed_min,
       module,
       action
FROM   v\$session
WHERE  status = 'ACTIVE'
  AND  type   = 'USER'
ORDER BY elapsed_time DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

The longest elapsed time here defines the minimum effective \`UNDO_RETENTION\` value. Any \`UNDO_RETENTION\` below \`elapsed_sec\` of the longest active query is insufficient.

### Step 1.4 — Historical Max Query Length from AWR

\`\`\`sql
SELECT snap_id,
       begin_interval_time,
       maxquerylen,
       undoblks,
       ssolderrcnt
FROM   dba_hist_undostat
WHERE  begin_interval_time > SYSDATE - 30
ORDER BY maxquerylen DESC
FETCH FIRST 20 ROWS ONLY;
-- Identifies the historical worst-case query duration over the last 30 days.
-- Use maxquerylen from this query to set UNDO_RETENTION with appropriate headroom.
\`\`\`

The maximum \`maxquerylen\` observed over the AWR retention period is the baseline for \`UNDO_RETENTION\`. Set \`UNDO_RETENTION\` to at least 150% of this value.

---

## Phase 2: ORA-01555 Diagnosis

### Step 2.1 — Check ORA-01555 Error Frequency

\`\`\`sql
SELECT begin_time,
       end_time,
       ssolderrcnt,
       maxquerylen,
       tuned_undoretention,
       undoblks
FROM   v\$undostat
WHERE  ssolderrcnt > 0
ORDER BY begin_time DESC;
\`\`\`

Each row represents a 10-minute window in which ORA-01555 occurred. Compare \`maxquerylen\` against \`tuned_undoretention\` in the same interval. If \`maxquerylen > tuned_undoretention\`, the retention window expired before the query completed — increase \`UNDO_RETENTION\` and/or the tablespace size. If \`maxquerylen < tuned_undoretention\` but errors are still occurring, delayed block cleanout is the likely cause (Step 2.4).

### Step 2.2 — Identify Sessions at Risk (Long-Running Transactions)

\`\`\`sql
SELECT s.sid,
       s.serial#,
       s.username,
       s.sql_id,
       ROUND(s.last_call_et / 60, 1)    AS running_min,
       u.name                           AS undo_segment,
       t.used_ublk                      AS undo_blocks_used,
       t.start_time
FROM   v\$session     s
JOIN   v\$transaction t ON t.addr  = s.taddr
JOIN   v\$rollname    u ON u.usn   = t.xidusn
WHERE  s.status = 'ACTIVE'
ORDER BY s.last_call_et DESC;
\`\`\`

Sessions with large \`running_min\` values require that undo generated by all concurrent write transactions since \`start_time\` remains available in the undo tablespace. The \`undo_blocks_used\` column shows how much undo this specific transaction has accumulated — large values indicate a transaction that will itself require retention of its undo for the duration of any concurrent reads.

### Step 2.3 — Check Retention Adequacy for the Most Recent Interval

\`\`\`sql
SELECT tuned_undoretention                                         AS oracle_tuned_retention_sec,
       maxquerylen                                                 AS longest_query_sec,
       (SELECT TO_NUMBER(value)
        FROM   v\$parameter
        WHERE  name = 'undo_retention')                            AS undo_retention_param,
       CASE
         WHEN maxquerylen > tuned_undoretention
           THEN 'RISK: query longer than retention'
         WHEN maxquerylen > tuned_undoretention * 0.8
           THEN 'WARNING: query approaching retention limit'
         ELSE 'OK'
       END                                                         AS assessment
FROM   v\$undostat
WHERE  begin_time = (SELECT MAX(begin_time) FROM v\$undostat);
\`\`\`

Run this query periodically during batch windows or whenever ORA-01555 errors are reported. The RISK assessment means ORA-01555 is occurring or is imminent. The WARNING assessment means the system is within 20% of its retention limit — corrective action should be planned.

### Step 2.4 — Check for Delayed Block Cleanout Contributing to ORA-01555

\`\`\`sql
-- Delayed block cleanout occurs when a transaction commits without visiting
-- all modified blocks to record the commit SCN. Later readers that encounter
-- uncleaned blocks must consult the undo segment header to determine commit SCN.
-- If the undo segment has wrapped since the transaction committed,
-- Oracle raises ORA-01555 even though the transaction predates the query.
SELECT name, value
FROM   v\$sysstat
WHERE  name IN (
  'cleanouts only - consistent read gets',
  'cleanouts and rollbacks - consistent read gets',
  'rollbacks only - consistent read gets'
);
-- High 'cleanouts and rollbacks - consistent read gets' relative to total consistent gets
-- indicates delayed block cleanout is a material contributor to ORA-01555.
-- Remedy: run a full table scan on the affected objects to force immediate cleanout.
\`\`\`

If delayed block cleanout is confirmed as the cause, run a full table scan against the affected table(s) in a dedicated session during a low-activity window: \`SELECT COUNT(*) FROM <table> /* force cleanout */;\` This visits every block and records the commit SCN, eliminating the deferred cleanout. The ORA-01555 errors from this cause will not recur after cleanout is complete.

---

## Phase 3: Undo Tablespace Configuration Changes

### Step 3.1 — Add a Datafile to the Undo Tablespace

This is the safest and fastest way to increase undo tablespace capacity without disruption.

\`\`\`sql
ALTER TABLESPACE undotbs1
  ADD DATAFILE '/u01/oradata/PRODDB/undotbs1_02.dbf'
  SIZE 10G AUTOEXTEND ON NEXT 1G MAXSIZE 50G;
\`\`\`

Verify the addition:

\`\`\`sql
SELECT file_name,
       ROUND(bytes / 1073741824, 2)     AS size_gb,
       autoextensible,
       ROUND(maxbytes / 1073741824, 2)  AS max_gb
FROM   dba_data_files
WHERE  tablespace_name = 'UNDOTBS1'
ORDER BY file_id;
\`\`\`

### Step 3.2 — Increase UNDO_RETENTION

\`UNDO_RETENTION\` is a dynamic parameter — the change takes effect immediately without a restart.

\`\`\`sql
-- Set UNDO_RETENTION to 3 hours (10800 seconds).
-- Adjust the value to >= the longest expected query or batch job duration.
ALTER SYSTEM SET undo_retention = 10800 SCOPE = BOTH;

-- Verify:
SELECT name, value FROM v\$parameter WHERE name = 'undo_retention';
\`\`\`

\`SCOPE = BOTH\` writes the change to the in-memory parameter and to the SPFILE so it survives a restart. If the database uses a PFILE, use \`SCOPE = MEMORY\` and update the PFILE manually.

### Step 3.3 — Enable RETENTION GUARANTEE

\`RETENTION GUARANTEE\` prevents Oracle from ever overwriting unexpired undo. Use it when Flashback Query SLAs must be enforced, at the cost of allowing DML transactions to fail with ORA-30036 if the undo tablespace becomes full.

\`\`\`sql
-- Enable RETENTION GUARANTEE:
ALTER TABLESPACE undotbs1 RETENTION GUARANTEE;

-- Verify:
SELECT tablespace_name, retention FROM dba_tablespaces WHERE contents = 'UNDO';

-- Revert to NOGUARANTEE if ORA-30036 (unable to extend undo segment) begins occurring:
ALTER TABLESPACE undotbs1 RETENTION NOGUARANTEE;
\`\`\`

Before enabling \`RETENTION GUARANTEE\`, verify via Step 1.2 that the tablespace is large enough to hold the required retention period at peak undo generation rate. Enabling guarantee on an undersized tablespace will cause ORA-30036 during peak load.

### Step 3.4 — Switch to a New Undo Tablespace

Use this approach when the existing undo tablespace cannot be grown in-place (for example, due to storage layout constraints or to relocate it to faster storage).

\`\`\`sql
-- Step 1: Create a new, larger undo tablespace.
CREATE UNDO TABLESPACE undotbs2
  DATAFILE '/u01/oradata/PRODDB/undotbs2_01.dbf'
  SIZE 20G AUTOEXTEND ON NEXT 2G MAXSIZE 100G
  RETENTION NOGUARANTEE;

-- Step 2: Switch the instance to use the new tablespace.
-- New transactions will now use undotbs2. Old transactions continue in undotbs1.
ALTER SYSTEM SET undo_tablespace = undotbs2 SCOPE = BOTH;

-- Step 3: Wait for the old tablespace to drain.
-- All extents must transition from ACTIVE/UNEXPIRED to EXPIRED before it can be dropped.
-- Run this periodically until ACTIVE count = 0:
SELECT status, COUNT(*), ROUND(SUM(bytes) / 1073741824, 3) AS gb
FROM   dba_undo_extents
WHERE  tablespace_name = 'UNDOTBS1'
GROUP BY status;

-- Step 4: Drop the old tablespace only after all extents are EXPIRED
-- and no active transactions remain in it.
DROP TABLESPACE undotbs1 INCLUDING CONTENTS AND DATAFILES;
\`\`\`

Allow at least \`UNDO_RETENTION\` seconds plus the duration of any active transactions before dropping the old tablespace. Dropping it prematurely while UNEXPIRED extents exist will force any queries that depend on those extents to raise ORA-01555 immediately.

### Step 3.5 — Resize (Shrink) an Overallocated Undo Datafile

Use this after migrating to a new undo tablespace, or after resolving a temporary spike that caused the tablespace to autoextend to an undesirably large size.

\`\`\`sql
-- Step 1: Find the minimum safe resize value.
-- This is the highest-numbered block actually in use, plus 10% buffer.
SELECT CEIL(MAX(block_id + blocks) * 8192 / 1073741824 * 1.1) AS min_safe_gb
FROM   dba_extents
WHERE  tablespace_name = 'UNDOTBS1';

-- Step 2: Resize the datafile to the safe minimum plus a headroom buffer.
-- Replace the file path and size with the actual values from your environment.
ALTER DATABASE DATAFILE '/u01/oradata/PRODDB/undotbs1_01.dbf'
  RESIZE 15G;
\`\`\`

If the resize command fails with ORA-03297 (file contains used data beyond the requested resize value), the \`min_safe_gb\` calculation is the floor below which you cannot shrink. In that case, the only option to reclaim more space is to rebuild the undo tablespace using the switch procedure in Step 3.4.

---

## Phase 4: Local Undo Mode (CDB/PDB — 18c+)

Local undo mode gives each PDB its own undo tablespace, providing isolation between PDBs and enabling PDB-level point-in-time recovery. These steps require SYSDBA on the CDB and a planned maintenance window for the CDB restart.

### Step 4.1 — Check Current Undo Mode

\`\`\`sql
-- Run from CDB$ROOT as SYSDBA:
SELECT property_value
FROM   database_properties
WHERE  property_name = 'LOCAL_UNDO_ENABLED';
-- TRUE  = local undo mode is active
-- FALSE = shared undo mode (12c default)
\`\`\`

### Step 4.2 — Convert to Local Undo Mode

This procedure requires a CDB restart in migration mode. Schedule a maintenance window.

\`\`\`sql
-- Step 1: Confirm all PDBs are open and no active transactions will be disrupted.
SELECT con_id, name, open_mode FROM v\$pdbs ORDER BY con_id;

-- Step 2: Shut down the CDB cleanly.
SHUTDOWN IMMEDIATE;
\`\`\`

From the OS command line (as oracle user with SYSDBA):

\`\`\`bash
sqlplus / as sysdba <<'SQLEOF'
-- Step 3: Start in migration mode.
STARTUP MIGRATE;

-- Step 4: Enable local undo (run as SYSDBA from CDB$ROOT).
ALTER DATABASE LOCAL UNDO ON;

-- Step 5: Normal restart to complete the conversion.
SHUTDOWN IMMEDIATE;
STARTUP;

-- Step 6: Verify local undo is now active.
SELECT property_value
FROM   database_properties
WHERE  property_name = 'LOCAL_UNDO_ENABLED';
SQLEOF
\`\`\`

After enabling local undo, Oracle automatically creates a default undo tablespace in each PDB. Review the sizing of these tablespaces (Step 4.3) and resize them according to each PDB's workload characteristics.

### Step 4.3 — Create Undo Tablespace in Each PDB (After Enabling Local Undo)

\`\`\`sql
-- Connect to the target PDB:
ALTER SESSION SET CONTAINER = pdb1;

-- Create a properly sized undo tablespace for this PDB:
CREATE UNDO TABLESPACE undotbs_pdb1
  DATAFILE '/u01/oradata/pdb1/undotbs_01.dbf'
  SIZE 5G AUTOEXTEND ON NEXT 512M MAXSIZE 30G;

-- Point the PDB instance at the new tablespace:
ALTER SYSTEM SET undo_tablespace = undotbs_pdb1;

-- Verify:
SELECT name, value FROM v\$parameter WHERE name = 'undo_tablespace';
\`\`\`

Repeat for each PDB, adjusting the datafile path, tablespace name, and sizing parameters to reflect each PDB's workload. Use the sizing formula from Step 1.2 with data from each PDB's \`V$UNDOSTAT\` (queried while connected to that PDB's container).

---

## Phase 5: Undo Monitoring Shell Script (with Crontab)

Save as \`/u01/app/oracle/scripts/undo_monitor/undo_monitor.sh\` and make executable (\`chmod 750\`).

\`\`\`bash
#!/bin/bash
# undo_monitor.sh — Oracle undo tablespace health monitor
# Usage: undo_monitor.sh <ORACLE_SID>
# Returns exit code = number of issues found (Nagios-compatible)
# Sends email alert if issues > 0

ORACLE_SID=\${1:?Usage: undo_monitor.sh ORACLE_SID}
export ORACLE_SID
ORACLE_HOME=\${ORACLE_HOME:-/u01/app/oracle/product/19.0.0/dbhome_1}
export ORACLE_HOME
PATH=\${ORACLE_HOME}/bin:\${PATH}
export PATH
LD_LIBRARY_PATH=\${ORACLE_HOME}/lib:\${LD_LIBRARY_PATH}
export LD_LIBRARY_PATH

SCRIPT_DIR=/u01/app/oracle/scripts/undo_monitor
LOG_DIR=\${SCRIPT_DIR}/logs
TIMESTAMP=\$(date +%Y%m%d_%H%M%S)
LOG_FILE=\${LOG_DIR}/undo_\${ORACLE_SID}_\${TIMESTAMP}.log
ALERT_EMAIL=dba-alerts@example.com
ISSUES=0

mkdir -p "\${LOG_DIR}"

log() {
  echo "[\$(date '+%Y-%m-%d %H:%M:%S')] \${*}" | tee -a "\${LOG_FILE}"
}

log "=== Undo Monitor: \${ORACLE_SID} ==="
log "Oracle Home: \${ORACLE_HOME}"

# --- Check 1: ORA-01555 errors and retention adequacy (most recent V$UNDOSTAT row) ---
UNDOSTAT_RESULT=\$(sqlplus -s / as sysdba <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF VERIFY OFF HEADING OFF TRIMSPOOL ON
SELECT ssolderrcnt || '|' || nospaceerrcnt || '|' || maxquerylen || '|' || tuned_undoretention
FROM   v\$undostat
WHERE  begin_time = (SELECT MAX(begin_time) FROM v\$undostat);
EXIT;
SQLEOF
)

if [ -z "\${UNDOSTAT_RESULT}" ]; then
  log "ERROR: Could not query V\$UNDOSTAT — check DB connectivity and SYSDBA access"
  ISSUES=\$((ISSUES + 1))
else
  SSOLDERRCNT=\$(echo "\${UNDOSTAT_RESULT}" | awk -F'|' '{print \$1}' | tr -d ' ')
  NOSPACEERRCNT=\$(echo "\${UNDOSTAT_RESULT}" | awk -F'|' '{print \$2}' | tr -d ' ')
  MAXQUERYLEN=\$(echo "\${UNDOSTAT_RESULT}" | awk -F'|' '{print \$3}' | tr -d ' ')
  TUNED_RETENTION=\$(echo "\${UNDOSTAT_RESULT}" | awk -F'|' '{print \$4}' | tr -d ' ')

  log "V\$UNDOSTAT (latest interval): ssolderrcnt=\${SSOLDERRCNT} nospaceerrcnt=\${NOSPACEERRCNT} maxquerylen=\${MAXQUERYLEN}s tuned_retention=\${TUNED_RETENTION}s"

  if [ "\${SSOLDERRCNT}" -gt 0 ] 2>/dev/null; then
    log "CRITICAL: ORA-01555 errors detected in last 10-minute interval (count=\${SSOLDERRCNT})"
    ISSUES=\$((ISSUES + 1))
  fi

  if [ "\${NOSPACEERRCNT}" -gt 0 ] 2>/dev/null; then
    log "CRITICAL: Undo tablespace out of space errors detected (nospaceerrcnt=\${NOSPACEERRCNT}) — possible ORA-30036 if RETENTION GUARANTEE is set"
    ISSUES=\$((ISSUES + 1))
  fi

  # Warn if longest query > 80% of tuned retention
  if [ -n "\${MAXQUERYLEN}" ] && [ -n "\${TUNED_RETENTION}" ] && [ "\${TUNED_RETENTION}" -gt 0 ] 2>/dev/null; then
    THRESHOLD=\$(awk "BEGIN { printf \"%d\", \${TUNED_RETENTION} * 0.8 }")
    if [ "\${MAXQUERYLEN}" -gt "\${THRESHOLD}" ] 2>/dev/null; then
      log "WARNING: Longest query (\${MAXQUERYLEN}s) exceeds 80% of tuned retention (\${TUNED_RETENTION}s) — ORA-01555 risk elevated"
      ISSUES=\$((ISSUES + 1))
    else
      log "OK: Query length within safe retention margin (\${MAXQUERYLEN}s vs \${TUNED_RETENTION}s tuned retention)"
    fi
  fi
fi

# --- Check 2: Undo extent states — warn if EXPIRED < 10% of total ---
EXTENT_RESULT=\$(sqlplus -s / as sysdba <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF VERIFY OFF HEADING OFF TRIMSPOOL ON
SELECT NVL(SUM(CASE WHEN status = 'EXPIRED'   THEN bytes ELSE 0 END), 0) || '|' ||
       NVL(SUM(bytes), 1)
FROM   dba_undo_extents;
EXIT;
SQLEOF
)

if [ -n "\${EXTENT_RESULT}" ]; then
  EXPIRED_BYTES=\$(echo "\${EXTENT_RESULT}" | awk -F'|' '{print \$1}' | tr -d ' ')
  TOTAL_BYTES=\$(echo "\${EXTENT_RESULT}" | awk -F'|' '{print \$2}' | tr -d ' ')

  if [ "\${TOTAL_BYTES}" -gt 0 ] 2>/dev/null; then
    EXPIRED_PCT=\$(awk "BEGIN { printf \"%d\", (\${EXPIRED_BYTES} / \${TOTAL_BYTES}) * 100 }")
    log "Undo extents: expired_pct=\${EXPIRED_PCT}% (expired=\${EXPIRED_BYTES} bytes, total=\${TOTAL_BYTES} bytes)"
    if [ "\${EXPIRED_PCT}" -lt 10 ] 2>/dev/null; then
      log "WARNING: EXPIRED undo extents < 10% of total — undo tablespace is near full, unexpired undo at risk of being overwritten"
      ISSUES=\$((ISSUES + 1))
    else
      log "OK: EXPIRED undo extent pool is adequate (\${EXPIRED_PCT}%)"
    fi
  fi
fi

# --- Check 3: Undo tablespace used space > 85% of maximum (considering MAXSIZE for autoextend files) ---
SPACE_RESULT=\$(sqlplus -s / as sysdba <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF VERIFY OFF HEADING OFF TRIMSPOOL ON
SELECT ROUND(SUM(d.bytes) / 1073741824, 2) || '|' ||
       ROUND(SUM(CASE WHEN d.autoextensible = 'YES' THEN d.maxbytes ELSE d.bytes END) / 1073741824, 2)
FROM   dba_tablespaces t
JOIN   dba_data_files  d ON d.tablespace_name = t.tablespace_name
WHERE  t.contents = 'UNDO'
  AND  t.tablespace_name = (SELECT value FROM v\$parameter WHERE name = 'undo_tablespace');
EXIT;
SQLEOF
)

if [ -n "\${SPACE_RESULT}" ]; then
  USED_GB=\$(echo "\${SPACE_RESULT}" | awk -F'|' '{print \$1}' | tr -d ' ')
  MAX_GB=\$(echo "\${SPACE_RESULT}" | awk -F'|' '{print \$2}' | tr -d ' ')

  if awk "BEGIN { exit !(\${MAX_GB} > 0) }" 2>/dev/null; then
    USED_PCT=\$(awk "BEGIN { printf \"%d\", (\${USED_GB} / \${MAX_GB}) * 100 }")
    log "Undo tablespace space: used=\${USED_GB}GB max=\${MAX_GB}GB (\${USED_PCT}% of max)"
    if [ "\${USED_PCT}" -gt 85 ] 2>/dev/null; then
      log "WARNING: Undo tablespace used space exceeds 85% of maximum (\${USED_PCT}%) — consider adding a datafile or increasing MAXSIZE"
      ISSUES=\$((ISSUES + 1))
    else
      log "OK: Undo tablespace space usage is within acceptable range (\${USED_PCT}%)"
    fi
  fi
fi

# --- Summary and alerting ---
log "=== Summary: \${ISSUES} issue(s) detected ==="

if [ "\${ISSUES}" -gt 0 ]; then
  log "Sending alert email to \${ALERT_EMAIL}"
  SUBJECT="[UNDO ALERT] \${ORACLE_SID}: \${ISSUES} issue(s) detected on \$(hostname)"
  if command -v mailx >/dev/null 2>&1; then
    mailx -s "\${SUBJECT}" "\${ALERT_EMAIL}" < "\${LOG_FILE}"
  elif command -v sendmail >/dev/null 2>&1; then
    { echo "Subject: \${SUBJECT}"; echo "To: \${ALERT_EMAIL}"; echo ""; cat "\${LOG_FILE}"; } | sendmail "\${ALERT_EMAIL}"
  else
    log "WARNING: Neither mailx nor sendmail found — email alert not sent"
  fi
fi

exit "\${ISSUES}"
\`\`\`

Install the crontab entry (run as the oracle OS user):

\`\`\`bash
# Add to oracle user crontab: crontab -e
*/15  *  *  *  *  /u01/app/oracle/scripts/undo_monitor/undo_monitor.sh PRODDB >> /u01/app/oracle/scripts/undo_monitor/logs/cron_undo.log 2>&1
\`\`\`

The script runs every 15 minutes and produces a timestamped log file for each execution. The crontab \`>>\` redirect captures any pre-connection errors (e.g., ORACLE_HOME misconfiguration) that would not appear in the main log. The exit code equals the number of issues detected, making the script directly usable with Nagios/Icinga by calling it from a \`check_nrpe\` command definition.

To test the script manually:

\`\`\`bash
/u01/app/oracle/scripts/undo_monitor/undo_monitor.sh PRODDB
echo "Exit code: \$?"
\`\`\`

---

## Quick Reference

### Key Parameters

| Parameter | Default | Purpose |
|---|---|---|
| \`UNDO_MANAGEMENT\` | \`AUTO\` (10g+) | Enables Automatic Undo Management |
| \`UNDO_TABLESPACE\` | \`UNDOTBS1\` | Active undo tablespace for this instance |
| \`UNDO_RETENTION\` | \`900\` (15 min) | Minimum retention seconds for committed undo |
| \`RETENTION GUARANTEE\` | \`NOGUARANTEE\` | If set, never overwrite unexpired undo (may cause ORA-30036) |

### Key Views

| View | Purpose |
|---|---|
| \`V\$UNDOSTAT\` | 10-minute undo metrics: blocks used, ORA-01555 count, max query length, tuned retention |
| \`DBA_UNDO_EXTENTS\` | Extent states: ACTIVE / UNEXPIRED / EXPIRED and their sizes |
| \`V\$TRANSACTION\` | Active (uncommitted) transactions, their undo segment and blocks used |
| \`V\$ROLLSTAT\` | Rollback segment I/O statistics and wrap counts |
| \`DBA_HIST_UNDOSTAT\` | AWR history of undo statistics (up to AWR retention period) |
| \`DATABASE_PROPERTIES\` | \`LOCAL_UNDO_ENABLED\` flag for CDB undo mode |

### Sizing Formula

\`\`\`
required_GB = peak_undo_blocks_per_sec × db_block_size × target_retention_sec / 1073741824
\`\`\`

Where \`peak_undo_blocks_per_sec\` comes from \`MAX(UNDOBLKS / interval_seconds)\` in \`V$UNDOSTAT\` during the peak workload period. Add 20–25% headroom to the result before provisioning.

### ORA-01555 Fix Priority

1. **Increase undo tablespace size** — add a datafile (Step 3.1) or switch to a larger tablespace (Step 3.4). Fixes cause: tablespace too small.
2. **Increase \`UNDO_RETENTION\`** to cover longest query duration (Step 3.2). Fixes cause: retention window too short.
3. **Enable \`RETENTION GUARANTEE\`** if Flashback SLAs must be enforced (Step 3.3). Definitive fix when undo must not be overwritten.
4. **Force block cleanout** with a full table scan on affected objects. Fixes cause: delayed block cleanout.
5. **Reduce long-running query duration** — application-level fix; refactor batch jobs to process in smaller chunks or run during low-DML windows.`,
};

async function main() {
  console.log('Inserting Oracle Undo Tablespace runbook post...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: { ...post },
  });
  console.log('Inserted: "' + post.title + '"');
}

main().catch(console.error);
