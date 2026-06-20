import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle 19c AWR Tablespace Relocation Runbook: Scripts, Monitoring, and Crontab Schedule',
  slug: 'oracle-19c-awr-tablespace-relocation-runbook',
  excerpt:
    'Step-by-step operational runbook for relocating Oracle 19c AWR data from SYSAUX to a dedicated tablespace: pre-migration assessment, automated move scripts, index rebuild, SYSAUX reclamation, shell monitoring scripts, crontab schedule, and rollback procedure.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-20'),
  youtubeUrl: null,
  content: `This runbook provides the operational steps to relocate Oracle 19c Automatic Workload Repository (AWR) data from the SYSAUX tablespace to a dedicated tablespace. It is intended for use during a planned maintenance window. The companion blog post covers the architecture and decision points; this document is the execution checklist.

Estimated duration: 2–4 hours, depending on AWR data volume. Schedule a window of at least double the estimated move time for the first execution.

---

## Prerequisites

- Oracle 19c (19.3 or later patch level recommended)
- DBA or SYSDBA privilege on the target database
- Storage available for the new AWR tablespace datafile
- Access to the Oracle server host for shell script deployment
- SQL*Plus or equivalent client that can connect as SYS

Verify Oracle version before proceeding:

\`\`\`sql
SELECT banner_full FROM v$version;
\`\`\`

Confirm the database is in ARCHIVELOG mode (required to recover a failed move without data loss):

\`\`\`sql
SELECT log_mode FROM v$database;
\`\`\`

If \`LOG_MODE = NOARCHIVELOG\`, take a cold backup before starting.

---

## Phase 1 — Pre-Migration Assessment

### 1.1 Capture AWR Footprint

Run these queries and save the output. They establish the baseline for post-move verification and size the new tablespace.

\`\`\`sql
-- Total AWR space in SYSAUX
SELECT occupant_name,
       ROUND(space_usage_kbytes / 1024, 1) AS used_mb
FROM   v$sysaux_occupants
WHERE  occupant_name LIKE 'SM%'
ORDER  BY space_usage_kbytes DESC;

-- AWR segment inventory with sizes
SELECT segment_name,
       segment_type,
       ROUND(bytes / 1024 / 1024, 1) AS size_mb
FROM   dba_segments
WHERE  owner            = 'SYS'
  AND  tablespace_name  = 'SYSAUX'
  AND  (segment_name LIKE 'WRM$%' OR segment_name LIKE 'WRH$%')
ORDER  BY bytes DESC;

-- Total AWR segment size (use this to size the new tablespace)
SELECT ROUND(SUM(bytes) / 1024 / 1024, 1) AS total_awr_mb
FROM   dba_segments
WHERE  owner            = 'SYS'
  AND  tablespace_name  = 'SYSAUX'
  AND  (segment_name LIKE 'WRM$%' OR segment_name LIKE 'WRH$%');
\`\`\`

### 1.2 Check AWR Snapshot Health

\`\`\`sql
-- Snapshot count and retention
SELECT COUNT(*)                         AS total_snapshots,
       MIN(begin_interval_time)         AS oldest_snapshot,
       MAX(end_interval_time)           AS newest_snapshot,
       ROUND(MAX(end_interval_time)
             - MIN(begin_interval_time), 0) AS days_retained
FROM   dba_hist_snapshot;

-- AWR configuration
SELECT retention,
       snap_interval,
       topnsql
FROM   dba_hist_wr_control;

-- Last automatic snapshot (confirm AWR is healthy before starting)
SELECT snap_id, begin_interval_time, end_interval_time, flush_elapsed
FROM   dba_hist_snapshot
ORDER  BY snap_id DESC
FETCH FIRST 5 ROWS ONLY;
\`\`\`

If the last automatic snapshot is more than two snapshot intervals old, investigate the MMON process before proceeding. A failing AWR before the move makes it harder to distinguish pre-existing failures from move-related ones.

### 1.3 Check SYSAUX Current State

\`\`\`sql
-- SYSAUX allocation and free space
SELECT d.file_name,
       ROUND(d.bytes / 1024 / 1024, 1)        AS allocated_mb,
       ROUND(d.maxbytes / 1024 / 1024, 1)     AS maxsize_mb,
       ROUND(f.bytes / 1024 / 1024, 1)        AS free_mb
FROM   dba_data_files d
LEFT JOIN dba_free_space f ON f.file_id = d.file_id AND f.tablespace_name = d.tablespace_name
WHERE  d.tablespace_name = 'SYSAUX'
ORDER  BY d.file_id;
\`\`\`

---

## Phase 2 — Create Dedicated AWR Tablespace

\`\`\`sql
-- Replace the datafile path with the appropriate path for your storage layout
-- Initial size = total_awr_mb from Phase 1.1 + 50% headroom (minimum 2G)
CREATE TABLESPACE awr_data
  DATAFILE '/oradata/dbname/awr_data01.dbf'
    SIZE 4G
    AUTOEXTEND ON
    NEXT 512M
    MAXSIZE UNLIMITED
  EXTENT MANAGEMENT LOCAL AUTOALLOCATE
  SEGMENT SPACE MANAGEMENT AUTO;
\`\`\`

Verify:

\`\`\`sql
SELECT tablespace_name, status, extent_management, segment_space_management
FROM   dba_tablespaces
WHERE  tablespace_name = 'AWR_DATA';
\`\`\`

Expected: STATUS = ONLINE, EXTENT_MANAGEMENT = LOCAL, SEGMENT_SPACE_MANAGEMENT = AUTO.

---

## Phase 3 — AWR Segment Move Script

The move script generates and executes ALTER TABLE MOVE statements for all AWR tables in SYSAUX, handles both non-partitioned and partitioned tables, and logs progress.

### move_awr_tablespace.sh

\`\`\`bash
#!/usr/bin/env bash
# move_awr_tablespace.sh
# Moves all SYS.WRM$ and SYS.WRH$ segments from SYSAUX to AWR_DATA
# Run as the oracle OS user during a maintenance window
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="\${SCRIPT_DIR}/logs"
mkdir -p "\${LOG_DIR}"

TIMESTAMP=$(date '+%Y%m%d_%H%M%S')
LOG_FILE="\${LOG_DIR}/awr_move_\${TIMESTAMP}.log"
SQL_FILE="\${LOG_DIR}/awr_move_\${TIMESTAMP}.sql"

# Connection — set ORACLE_SID before running, or pass SID as first argument
ORACLE_SID="\${1:-\${ORACLE_SID}}"
export ORACLE_SID

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" | tee -a "\${LOG_FILE}"; }

log "Starting AWR tablespace relocation"
log "ORACLE_SID=\${ORACLE_SID}"
log "SQL file: \${SQL_FILE}"

# Step 1: Generate move DDL for non-partitioned AWR tables
log "Generating move statements..."
sqlplus -s "/ as sysdba" <<'ENDSQL' > "\${SQL_FILE}"
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF LINESIZE 200 TRIMSPOOL ON

-- Non-partitioned AWR tables
SELECT 'ALTER TABLE SYS.' || segment_name ||
       ' MOVE TABLESPACE awr_data ONLINE;'
FROM   dba_segments
WHERE  owner            = 'SYS'
  AND  tablespace_name  = 'SYSAUX'
  AND  segment_type     = 'TABLE'
  AND  (segment_name LIKE 'WRM$%' OR segment_name LIKE 'WRH$%')
ORDER  BY bytes DESC;
ENDSQL

# Step 2: Append partition-level moves for partitioned AWR tables
sqlplus -s "/ as sysdba" <<'ENDSQL' >> "\${SQL_FILE}"
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF LINESIZE 200 TRIMSPOOL ON

-- Partitioned AWR table partitions still in SYSAUX
SELECT 'ALTER TABLE SYS.' || table_name ||
       ' MOVE PARTITION ' || partition_name ||
       ' TABLESPACE awr_data UPDATE INDEXES ONLINE;'
FROM   dba_tab_partitions
WHERE  table_owner       = 'SYS'
  AND  tablespace_name   = 'SYSAUX'
  AND  (table_name LIKE 'WRM$%' OR table_name LIKE 'WRH$%')
ORDER  BY table_name, partition_name;
ENDSQL

STMT_COUNT=$(grep -c 'MOVE' "\${SQL_FILE}" || true)
log "Generated \${STMT_COUNT} move statements"

if [[ \${STMT_COUNT} -eq 0 ]]; then
  log "No AWR segments found in SYSAUX. Nothing to move."
  exit 0
fi

# Step 3: Execute the move statements
log "Executing moves..."
sqlplus -s "/ as sysdba" <<ENDSQL >> "\${LOG_FILE}" 2>&1
SET ECHO ON TIMING ON FEEDBACK ON
SPOOL \${LOG_FILE} APPEND
@\${SQL_FILE}
SPOOL OFF
EXIT
ENDSQL

log "Move execution complete. Checking for errors..."

if grep -i "ORA-" "\${LOG_FILE}"; then
  log "WARNING: ORA- errors detected in log. Review \${LOG_FILE} before proceeding to index rebuild."
else
  log "No ORA- errors detected."
fi

log "Phase 3 complete. Proceed to Phase 4: index rebuild."
\`\`\`

Make the script executable and run it:

\`\`\`bash
chmod +x move_awr_tablespace.sh
./move_awr_tablespace.sh PROD   # replace PROD with your ORACLE_SID
\`\`\`

---

## Phase 4 — Index Rebuild Script

When \`MOVE PARTITION ... UPDATE INDEXES ONLINE\` is used, partitioned indexes are maintained automatically. For non-partitioned moves without UPDATE INDEXES, or if any UNUSABLE indexes remain, this script rebuilds them.

### rebuild_awr_indexes.sh

\`\`\`bash
#!/usr/bin/env bash
# rebuild_awr_indexes.sh
# Rebuilds UNUSABLE AWR indexes in the AWR_DATA tablespace
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="\${SCRIPT_DIR}/logs"
mkdir -p "\${LOG_DIR}"

TIMESTAMP=$(date '+%Y%m%d_%H%M%S')
LOG_FILE="\${LOG_DIR}/awr_index_rebuild_\${TIMESTAMP}.log"
SQL_FILE="\${LOG_DIR}/awr_rebuild_\${TIMESTAMP}.sql"

ORACLE_SID="\${1:-\${ORACLE_SID}}"
export ORACLE_SID

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" | tee -a "\${LOG_FILE}"; }

log "Generating AWR index rebuild statements..."

sqlplus -s "/ as sysdba" <<'ENDSQL' > "\${SQL_FILE}"
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF LINESIZE 200 TRIMSPOOL ON

-- Non-partitioned UNUSABLE AWR indexes
SELECT 'ALTER INDEX SYS.' || index_name ||
       ' REBUILD TABLESPACE awr_data ONLINE;'
FROM   dba_indexes
WHERE  owner  = 'SYS'
  AND  status = 'UNUSABLE'
  AND  (table_name LIKE 'WRM$%' OR table_name LIKE 'WRH$%');

-- Partitioned UNUSABLE AWR index partitions
SELECT 'ALTER INDEX SYS.' || ip.index_name ||
       ' REBUILD PARTITION ' || ip.partition_name ||
       ' TABLESPACE awr_data ONLINE;'
FROM   dba_ind_partitions ip
JOIN   dba_indexes i ON i.index_name = ip.index_name AND i.owner = 'SYS'
WHERE  ip.status = 'UNUSABLE'
  AND  (i.table_name LIKE 'WRM$%' OR i.table_name LIKE 'WRH$%');
ENDSQL

REBUILD_COUNT=$(grep -c 'REBUILD' "\${SQL_FILE}" || true)
log "Generated \${REBUILD_COUNT} rebuild statements"

if [[ \${REBUILD_COUNT} -eq 0 ]]; then
  log "No UNUSABLE AWR indexes found. Skipping rebuild."
  exit 0
fi

sqlplus -s "/ as sysdba" <<ENDSQL >> "\${LOG_FILE}" 2>&1
SET ECHO ON TIMING ON FEEDBACK ON
SPOOL \${LOG_FILE} APPEND
@\${SQL_FILE}
SPOOL OFF
EXIT
ENDSQL

log "Index rebuild complete."
\`\`\`

---

## Phase 5 — Verification Script

### verify_awr_move.sh

\`\`\`bash
#!/usr/bin/env bash
# verify_awr_move.sh
# Confirms AWR segments have moved and snapshot collection is functional
set -euo pipefail

ORACLE_SID="\${1:-\${ORACLE_SID}}"
export ORACLE_SID

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1"; }

log "=== AWR Move Verification ==="
log "ORACLE_SID=\${ORACLE_SID}"

sqlplus -s "/ as sysdba" <<'ENDSQL'
SET LINESIZE 120 PAGESIZE 50

PROMPT
PROMPT --- 1. AWR segment distribution by tablespace ---
SELECT tablespace_name,
       COUNT(*)                            AS segments,
       ROUND(SUM(bytes)/1024/1024, 1)     AS total_mb
FROM   dba_segments
WHERE  owner = 'SYS'
  AND  (segment_name LIKE 'WRM$%' OR segment_name LIKE 'WRH$%')
GROUP  BY tablespace_name;

PROMPT
PROMPT --- 2. AWR segments remaining in SYSAUX (expect 0) ---
SELECT COUNT(*) AS awr_still_in_sysaux
FROM   dba_segments
WHERE  owner            = 'SYS'
  AND  tablespace_name  = 'SYSAUX'
  AND  (segment_name LIKE 'WRM$%' OR segment_name LIKE 'WRH$%');

PROMPT
PROMPT --- 3. UNUSABLE AWR indexes (expect 0) ---
SELECT COUNT(*) AS unusable_indexes
FROM   dba_indexes
WHERE  owner  = 'SYS'
  AND  status = 'UNUSABLE'
  AND  (table_name LIKE 'WRM$%' OR table_name LIKE 'WRH$%');

PROMPT
PROMPT --- 4. Taking test snapshot ---
EXEC DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT;

PROMPT
PROMPT --- 5. Verify test snapshot appeared ---
SELECT snap_id, begin_interval_time, end_interval_time
FROM   dba_hist_snapshot
ORDER  BY snap_id DESC
FETCH FIRST 3 ROWS ONLY;

PROMPT
PROMPT --- 6. AWR_DATA tablespace usage after move ---
SELECT tablespace_name,
       ROUND(used_space * 8192 / 1024 / 1024, 1)      AS used_mb,
       ROUND(tablespace_size * 8192 / 1024 / 1024, 1) AS total_mb,
       ROUND(used_percent, 1)                          AS pct_used
FROM   dba_tablespace_usage_metrics
WHERE  tablespace_name = 'AWR_DATA';

PROMPT
PROMPT === Verification complete ===
ENDSQL
\`\`\`

---

## Phase 6 — SYSAUX Reclamation

After the move, SYSAUX free space has increased but the datafile high-water mark has not dropped. Resize the datafile to reclaim space at the OS level.

\`\`\`sql
-- Identify lowest available resize boundary
-- (highest block address still occupied in SYSAUX)
SELECT CEIL((MAX(block_id + blocks)) * 8192 / 1024 / 1024) AS min_resize_mb
FROM   dba_extents
WHERE  tablespace_name = 'SYSAUX';

-- Get current SYSAUX datafile path and size
SELECT file_name,
       ROUND(bytes / 1024 / 1024, 1) AS current_mb
FROM   dba_data_files
WHERE  tablespace_name = 'SYSAUX';

-- Resize (target must exceed min_resize_mb; add at least 20% buffer)
ALTER DATABASE DATAFILE '/oradata/dbname/sysaux01.dbf' RESIZE 4G;
\`\`\`

If ORA-03297 is raised, increase the target size and try again, or identify which non-AWR segment sits above the target boundary:

\`\`\`sql
-- Find segments that prevent shrinking SYSAUX below a target block number
-- (replace 512000 with target_mb * 128 to convert MB to 8K blocks)
SELECT segment_name, segment_type,
       block_id, block_id + blocks - 1 AS last_block,
       ROUND(bytes / 1024 / 1024, 1) AS size_mb
FROM   dba_extents
WHERE  tablespace_name = 'SYSAUX'
  AND  block_id > 512000          -- segments above the resize target
ORDER  BY block_id DESC;
\`\`\`

Move or shrink those segments before retrying the SYSAUX resize.

---

## Phase 7 — AWR Snapshot Settings Review

After relocation, revisit the AWR configuration. With a dedicated tablespace, longer retention is viable if storage allows.

\`\`\`sql
-- Review current settings
SELECT ROUND(retention / 1440, 0) AS retention_days,
       ROUND(snap_interval * 24 * 60, 0) AS snap_interval_min,
       topnsql
FROM   dba_hist_wr_control;

-- Adjust as needed (values in minutes)
BEGIN
  DBMS_WORKLOAD_REPOSITORY.MODIFY_SNAPSHOT_SETTINGS(
    retention => 43200,  -- 30 days
    interval  => 60,     -- hourly snapshots
    topnsql   => 100
  );
END;
/
\`\`\`

---

## Phase 8 — Monitoring Scripts

### awr_monitor.sh — AWR Tablespace and Snapshot Health

This script checks AWR_DATA tablespace usage, monitors for snapshot gaps, and alerts when thresholds are exceeded.

\`\`\`bash
#!/usr/bin/env bash
# awr_monitor.sh — AWR tablespace and snapshot health monitor
# Deploy to /opt/oracle/scripts/awr/
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="\${SCRIPT_DIR}/logs"
mkdir -p "\${LOG_DIR}"

TIMESTAMP=$(date '+%Y%m%d_%H%M%S')
LOG_FILE="\${LOG_DIR}/awr_monitor_\${TIMESTAMP}.log"

ORACLE_SID="\${ORACLE_SID:-ORCL}"
export ORACLE_SID

ALERT_EMAIL="\${ALERT_EMAIL:-dba-team@company.example}"
TBS_WARN_PCT=75
TBS_CRIT_PCT=90
SNAP_GAP_WARN_HOURS=3    # warn if no snapshot for this many hours

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [$ORACLE_SID] $1" | tee -a "\${LOG_FILE}"; }

send_alert() {
  local SEVERITY="$1"
  local SUBJECT="$2"
  local BODY="$3"
  log "ALERT [\${SEVERITY}]: \${SUBJECT}"
  {
    echo "Subject: [\${SEVERITY}] AWR Monitor - \${SUBJECT}"
    echo ""
    echo "\${BODY}"
    echo ""
    echo "Database: \${ORACLE_SID}"
    echo "Host: $(hostname)"
    echo "Time: $(date)"
    echo "Log: \${LOG_FILE}"
  } | sendmail "\${ALERT_EMAIL}"
}

log "Starting AWR health check"

# --- Check 1: AWR_DATA tablespace usage ---
read -r USED_PCT <<< "$(sqlplus -s "/ as sysdba" <<'ENDSQL'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0
SELECT ROUND(used_percent, 1)
FROM   dba_tablespace_usage_metrics
WHERE  tablespace_name = 'AWR_DATA';
ENDSQL
)"

USED_PCT="\${USED_PCT// /}"
log "AWR_DATA usage: \${USED_PCT}%"

if (( $(echo "\${USED_PCT} >= \${TBS_CRIT_PCT}" | bc -l) )); then
  send_alert "CRITICAL" \
    "AWR_DATA tablespace at \${USED_PCT}% (threshold \${TBS_CRIT_PCT}%)" \
    "AWR_DATA tablespace is critically full at \${USED_PCT}%.
Add a datafile or increase AUTOEXTEND MAXSIZE immediately.

ALTER TABLESPACE awr_data ADD DATAFILE '/oradata/dbname/awr_data02.dbf'
  SIZE 4G AUTOEXTEND ON NEXT 512M MAXSIZE UNLIMITED;"

elif (( $(echo "\${USED_PCT} >= \${TBS_WARN_PCT}" | bc -l) )); then
  send_alert "WARNING" \
    "AWR_DATA tablespace at \${USED_PCT}% (threshold \${TBS_WARN_PCT}%)" \
    "AWR_DATA tablespace is approaching capacity at \${USED_PCT}%.
Plan to add a datafile within the next maintenance window."
else
  log "Check 1 passed: AWR_DATA at \${USED_PCT}%"
fi

# --- Check 2: Snapshot gap detection ---
read -r GAP_HOURS <<< "$(sqlplus -s "/ as sysdba" <<'ENDSQL'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0
SELECT ROUND((SYSDATE - MAX(end_interval_time)) * 24, 1)
FROM   dba_hist_snapshot;
ENDSQL
)"

GAP_HOURS="\${GAP_HOURS// /}"
log "Hours since last AWR snapshot: \${GAP_HOURS}"

if (( $(echo "\${GAP_HOURS} >= \${SNAP_GAP_WARN_HOURS}" | bc -l) )); then
  send_alert "WARNING" \
    "AWR snapshot gap: no snapshot for \${GAP_HOURS} hours" \
    "The last AWR snapshot was \${GAP_HOURS} hours ago.
AWR collection may have stopped after the tablespace move.

Investigate:
  SELECT status FROM v\$instance;
  SELECT * FROM v\$sysaux_occupants WHERE occupant_name = 'SM/AWR';
  EXEC DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT;"
else
  log "Check 2 passed: snapshot gap \${GAP_HOURS}h (threshold \${SNAP_GAP_WARN_HOURS}h)"
fi

# --- Check 3: UNUSABLE AWR indexes ---
read -r UNUSABLE_COUNT <<< "$(sqlplus -s "/ as sysdba" <<'ENDSQL'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0
SELECT COUNT(*) FROM dba_indexes
WHERE  owner = 'SYS' AND status = 'UNUSABLE'
  AND  (table_name LIKE 'WRM$%' OR table_name LIKE 'WRH$%');
ENDSQL
)"

UNUSABLE_COUNT="\${UNUSABLE_COUNT// /}"
if [[ "\${UNUSABLE_COUNT}" -gt 0 ]]; then
  send_alert "CRITICAL" \
    "\${UNUSABLE_COUNT} UNUSABLE AWR indexes detected" \
    "\${UNUSABLE_COUNT} AWR index(es) are in UNUSABLE state.
AWR snapshot writes may fail with ORA-01502.

Rebuild with:
  SELECT 'ALTER INDEX SYS.' || index_name || ' REBUILD TABLESPACE awr_data ONLINE;'
  FROM   dba_indexes
  WHERE  owner = 'SYS' AND status = 'UNUSABLE'
    AND  (table_name LIKE 'WRM$%' OR table_name LIKE 'WRH$%');"
else
  log "Check 3 passed: no UNUSABLE AWR indexes"
fi

# --- Check 4: SYSAUX health (confirm AWR no longer consuming it) ---
read -r SYSAUX_AWR_MB <<< "$(sqlplus -s "/ as sysdba" <<'ENDSQL'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0
SELECT NVL(ROUND(SUM(bytes)/1024/1024,1), 0)
FROM   dba_segments
WHERE  owner = 'SYS' AND tablespace_name = 'SYSAUX'
  AND  (segment_name LIKE 'WRM$%' OR segment_name LIKE 'WRH$%');
ENDSQL
)"

SYSAUX_AWR_MB="\${SYSAUX_AWR_MB// /}"
if (( $(echo "\${SYSAUX_AWR_MB} > 100" | bc -l) )); then
  send_alert "WARNING" \
    "\${SYSAUX_AWR_MB}MB of AWR segments found in SYSAUX" \
    "\${SYSAUX_AWR_MB}MB of AWR segments remain in SYSAUX.
New AWR snapshots may be routing back to SYSAUX.
Check dba_segments for WRM\$ and WRH\$ tables in SYSAUX and re-run the move script."
else
  log "Check 4 passed: \${SYSAUX_AWR_MB}MB AWR data in SYSAUX (expected near 0)"
fi

log "AWR health check complete"
\`\`\`

### awr_snapshot_report.sh — Daily Snapshot Summary

\`\`\`bash
#!/usr/bin/env bash
# awr_snapshot_report.sh — Daily AWR snapshot activity summary
set -euo pipefail

ORACLE_SID="\${ORACLE_SID:-ORCL}"
export ORACLE_SID
REPORT_EMAIL="\${REPORT_EMAIL:-dba-team@company.example}"

REPORT=$(sqlplus -s "/ as sysdba" <<'ENDSQL'
SET LINESIZE 120 PAGESIZE 60
SET FEEDBACK OFF HEADING ON

PROMPT === AWR Daily Report ===
PROMPT
PROMPT -- Snapshot activity in last 24 hours
SELECT COUNT(*)                         AS snapshots_taken,
       MIN(begin_interval_time)         AS first_snap,
       MAX(end_interval_time)           AS last_snap,
       ROUND(AVG(flush_elapsed) * 86400, 1) AS avg_flush_sec
FROM   dba_hist_snapshot
WHERE  begin_interval_time > SYSDATE - 1;

PROMPT
PROMPT -- AWR_DATA tablespace usage
SELECT used_space * 8192 / 1024 / 1024   AS used_mb,
       tablespace_size * 8192 / 1024 / 1024 AS total_mb,
       ROUND(used_percent, 1)              AS pct_used
FROM   dba_tablespace_usage_metrics
WHERE  tablespace_name = 'AWR_DATA';

PROMPT
PROMPT -- Top 5 largest AWR segments
SELECT segment_name,
       ROUND(bytes / 1024 / 1024, 1) AS size_mb
FROM   dba_segments
WHERE  owner = 'SYS'
  AND  (segment_name LIKE 'WRM$%' OR segment_name LIKE 'WRH$%')
ORDER  BY bytes DESC
FETCH FIRST 5 ROWS ONLY;
ENDSQL
)

echo "\${REPORT}" | mail -s "AWR Daily Report - \${ORACLE_SID} - $(date '+%Y-%m-%d')" "\${REPORT_EMAIL}"
\`\`\`

### awr_sysaux_guard.sh — SYSAUX Drift Guard

Detects if AWR data has begun accumulating back in SYSAUX (e.g. after a datapatch or upgrade that recreates segments in the default location).

\`\`\`bash
#!/usr/bin/env bash
# awr_sysaux_guard.sh — Alert if AWR segments appear in SYSAUX after relocation
set -euo pipefail

ORACLE_SID="\${ORACLE_SID:-ORCL}"
export ORACLE_SID
ALERT_EMAIL="\${ALERT_EMAIL:-dba-team@company.example}"
THRESHOLD_MB=50    # alert if AWR in SYSAUX exceeds this

AWR_SYSAUX_MB=$(sqlplus -s "/ as sysdba" <<'ENDSQL' | tr -d ' '
SET HEADING OFF FEEDBACK OFF PAGESIZE 0
SELECT NVL(ROUND(SUM(bytes)/1024/1024,1), 0)
FROM   dba_segments
WHERE  owner = 'SYS' AND tablespace_name = 'SYSAUX'
  AND  (segment_name LIKE 'WRM$%' OR segment_name LIKE 'WRH$%');
ENDSQL
)

if (( $(echo "\${AWR_SYSAUX_MB} > \${THRESHOLD_MB}" | bc -l) )); then
  echo "Subject: ALERT: AWR segments drifted back to SYSAUX (\${AWR_SYSAUX_MB}MB)

AWR segments have re-appeared in SYSAUX on \${ORACLE_SID}.
Current AWR in SYSAUX: \${AWR_SYSAUX_MB}MB (threshold: \${THRESHOLD_MB}MB)

This can occur after:
  - A database patch that re-creates AWR tables in the default location
  - An upgrade that resets AWR segment storage
  - A failed move that left partitions behind

Action: Re-run move_awr_tablespace.sh to relocate the new segments.

Host: $(hostname)
Time: $(date)" | sendmail "\${ALERT_EMAIL}"
fi
\`\`\`

---

## Phase 9 — Deploy Scripts and Crontab Schedule

### Directory Structure

\`\`\`bash
mkdir -p /opt/oracle/scripts/awr/logs
mkdir -p /opt/oracle/scripts/awr/ddl

cp move_awr_tablespace.sh     /opt/oracle/scripts/awr/
cp rebuild_awr_indexes.sh     /opt/oracle/scripts/awr/
cp verify_awr_move.sh         /opt/oracle/scripts/awr/
cp awr_monitor.sh             /opt/oracle/scripts/awr/
cp awr_snapshot_report.sh     /opt/oracle/scripts/awr/
cp awr_sysaux_guard.sh        /opt/oracle/scripts/awr/

chmod 750 /opt/oracle/scripts/awr/*.sh
chown oracle:oinstall /opt/oracle/scripts/awr -R
\`\`\`

### Crontab (as oracle OS user)

\`\`\`bash
# Install: crontab -e as oracle
SHELL=/bin/bash
MAILTO=dba-team@company.example
PATH=/usr/local/bin:/usr/bin:/bin:/u01/app/oracle/product/19c/dbhome_1/bin

# --- AWR Health Monitor (every 30 minutes) ---
# Checks tablespace usage, snapshot gaps, and UNUSABLE indexes
*/30 * * * * ORACLE_SID=ORCL ALERT_EMAIL=dba-team@company.example \
  /opt/oracle/scripts/awr/awr_monitor.sh >> /opt/oracle/scripts/awr/logs/monitor_cron.log 2>&1

# --- Daily Snapshot Summary Report (07:00 Monday-Friday) ---
0 7 * * 1-5 ORACLE_SID=ORCL REPORT_EMAIL=dba-team@company.example \
  /opt/oracle/scripts/awr/awr_snapshot_report.sh >> /opt/oracle/scripts/awr/logs/report_cron.log 2>&1

# --- SYSAUX Drift Guard (daily at 06:00) ---
# Detects AWR segments re-appearing in SYSAUX after patches/upgrades
0 6 * * * ORACLE_SID=ORCL ALERT_EMAIL=dba-team@company.example \
  /opt/oracle/scripts/awr/awr_sysaux_guard.sh >> /opt/oracle/scripts/awr/logs/guard_cron.log 2>&1

# --- Log Cleanup (weekly, Sunday 03:00) ---
0 3 * * 0 find /opt/oracle/scripts/awr/logs -name "*.log" -mtime +30 -delete
\`\`\`

---

## Phase 10 — Rollback Procedure

If the move must be reversed (e.g. a patch requires AWR in SYSAUX, or AWR_DATA has a storage issue), move all segments back to SYSAUX.

\`\`\`sql
-- Generate reverse move statements (AWR_DATA back to SYSAUX)
SELECT 'ALTER TABLE SYS.' || segment_name ||
       ' MOVE TABLESPACE sysaux ONLINE;'
FROM   dba_segments
WHERE  owner            = 'SYS'
  AND  tablespace_name  = 'AWR_DATA'
  AND  segment_type     = 'TABLE'
  AND  (segment_name LIKE 'WRM$%' OR segment_name LIKE 'WRH$%')
ORDER  BY bytes DESC;

-- For partitioned tables
SELECT 'ALTER TABLE SYS.' || table_name ||
       ' MOVE PARTITION ' || partition_name ||
       ' TABLESPACE sysaux UPDATE INDEXES ONLINE;'
FROM   dba_tab_partitions
WHERE  table_owner     = 'SYS'
  AND  tablespace_name = 'AWR_DATA'
  AND  (table_name LIKE 'WRM$%' OR table_name LIKE 'WRH$%')
ORDER  BY table_name, partition_name;
\`\`\`

After reversing, drop the AWR_DATA tablespace only after confirming no AWR segments remain in it:

\`\`\`sql
SELECT COUNT(*) FROM dba_segments WHERE tablespace_name = 'AWR_DATA';
-- Must return 0 before dropping

DROP TABLESPACE awr_data INCLUDING CONTENTS AND DATAFILES;
\`\`\`

---

## Quick Reference — Common ORA Errors During the Move

| ORA error | When it occurs | Fix |
|-----------|---------------|-----|
| ORA-01652 | AWR_DATA full during move | Add datafile to AWR_DATA |
| ORA-01502 | Query hits UNUSABLE index | Run rebuild_awr_indexes.sh |
| ORA-00054 | Table locked by MMON during move | Retry with ONLINE clause; wait for MMON to release |
| ORA-03297 | SYSAUX resize target too low | Increase resize target; check highest-address SYSAUX segment |
| ORA-14402 | Partition move on table with ROW MOVEMENT disabled | Enable row movement: ALTER TABLE SYS.tablename ENABLE ROW MOVEMENT |
| ORA-00942 | Generated DDL references wrong owner | Confirm script runs as SYS; check dba_segments owner column |`,
};

async function main() {
  await db
    .insert(posts)
    .values(post)
    .onConflictDoUpdate({
      target: posts.slug,
      set: { title: post.title, content: post.content, excerpt: post.excerpt, updatedAt: new Date() },
    });
  console.log('Inserted:', post.slug);
}

main().catch(console.error);
