import { config } from 'dotenv';
config({ path: '.env.local' });
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

async function main() {
  const post = {
    title: 'SYSAUX Tablespace Reclamation Runbook — AWR Rebuild and Optimizer Stats Purge',
    slug: 'oracle-sysaux-tablespace-growth-runbook',
    excerpt:
      'Step-by-step DBA runbook for reclaiming a severely bloated SYSAUX tablespace on Oracle 11gR2/12c/19c. Covers all eight phases: assessment, AWR disable, RESTRICT restart, AWR repository rebuild, optimizer stats purge, WRI\$_OPTSTAT shrink, ORA-01502 index fix, high watermark reclamation, and AWR restore — with shell diagnostic scripts, generated DDL, and monitoring alerts.',
    category: 'oracle-database' as const,
    isPremium: true,
    published: true,
    publishedAt: new Date('2026-06-18'),
    content: `## Scope and Prerequisites

This runbook applies to Oracle Database 11gR2, 12c, and 19c single-instance and RAC databases where SYSAUX has grown beyond a manageable size due to unchecked AWR snapshot retention, runaway optimizer statistics history (SM/OPT occupant), or both.

**Triggering conditions:**
- SYSAUX tablespace usage exceeds 80% and does not decrease after a normal background purge cycle
- \`V\$SYSAUX_OCCUPANTS\` shows SM/AWR or SM/OPT consuming more than 50 GB
- AWR snapshot failures in the alert log (\`ORA-1688\`, \`ORA-1652\`)
- SYSAUX datafiles were recently added to cope with growth rather than resolving root cause

**What you need:**
- SYSDBA access
- A maintenance window for the RESTRICT restart (Phases 2 and 3 require no user connections)
- Access to \`\$ORACLE_HOME/rdbms/admin\` on the database server
- Disk space on the OS equal to current SYSAUX size (for the worst-case where the AWR rebuild generates temp objects)

**Estimated duration:** 2–6 hours depending on the size of the WRI\$_OPTSTAT tables and the number of datafiles to resize.

---

## Phase 0: Assess

Run all assessment queries before taking any action. Document the baseline so you can confirm improvement at the end.

### 0.1 SYSAUX occupants — identify dominant consumers

\`\`\`sql
SELECT occupant_name,
       schema_name,
       ROUND(space_usage_kbytes / 1048576, 2) AS space_gb,
       ROUND(space_usage_kbytes / 1024, 0)    AS space_mb
FROM v\$sysaux_occupants
ORDER BY space_usage_kbytes DESC;
\`\`\`

Key occupants to watch:
- **SM/AWR** — AWR snapshot data in \`WRH\$_*\` tables
- **SM/OPT** — optimizer statistics history in \`WRI\$_OPTSTAT_*\` tables
- **SM/OPTSTAT** — same occupant, different view alias on some Oracle versions

### 0.2 Top segments in SYSAUX by size

\`\`\`sql
SELECT owner,
       segment_name,
       segment_type,
       ROUND(SUM(bytes) / 1048576, 0) AS size_mb
FROM dba_segments
WHERE tablespace_name = 'SYSAUX'
GROUP BY owner, segment_name, segment_type
ORDER BY size_mb DESC
FETCH FIRST 25 ROWS ONLY;
\`\`\`

### 0.3 AWR retention and snapshot count

\`\`\`sql
SELECT retention FROM dba_hist_wr_control;

SELECT COUNT(*) AS total_snapshots,
       MIN(begin_interval_time) AS oldest_snap,
       MAX(end_interval_time)   AS newest_snap,
       ROUND(MAX(end_interval_time) - MIN(begin_interval_time), 0) AS days_retained
FROM dba_hist_snapshot;
\`\`\`

If \`days_retained\` is greater than 60 or \`total_snapshots\` is greater than 100,000, AWR is a primary contributor.

### 0.4 WRI\$_OPTSTAT table sizes

\`\`\`sql
SELECT segment_name,
       ROUND(SUM(bytes) / 1048576, 0) AS size_mb
FROM dba_segments
WHERE tablespace_name = 'SYSAUX'
  AND segment_name LIKE 'WRI\$_OPTSTAT%'
GROUP BY segment_name
ORDER BY size_mb DESC;
\`\`\`

### 0.5 Optimizer statistics history retention

\`\`\`sql
SELECT dbms_stats.get_stats_history_retention AS retention_days FROM dual;
\`\`\`

Default is 31 days. Anything higher is a risk factor.

### 0.6 SYSAUX datafiles — current allocation

\`\`\`sql
SELECT file_id,
       file_name,
       ROUND(bytes / 1073741824, 1)    AS current_gb,
       autoextensible,
       ROUND(maxbytes / 1073741824, 1) AS max_gb
FROM dba_data_files
WHERE tablespace_name = 'SYSAUX'
ORDER BY file_id;
\`\`\`

### 0.7 Invalid indexes in SYSAUX (baseline)

\`\`\`sql
SELECT owner, index_name, status, tablespace_name
FROM dba_indexes
WHERE tablespace_name = 'SYSAUX'
  AND status <> 'VALID'
ORDER BY owner, index_name;
\`\`\`

---

## Phase 1: Disable AWR Snapshots

Before any maintenance, stop AWR from writing new snapshots. This prevents new data from landing while you are purging:

\`\`\`sql
EXEC DBMS_WORKLOAD_REPOSITORY.MODIFY_SNAPSHOT_SETTINGS(interval => 0);

-- Confirm
SELECT snap_interval FROM dba_hist_wr_control;
-- snap_interval should be +00000 00:00:00.0 (zero = disabled)
\`\`\`

AWR disable takes effect immediately. Existing snapshot data is not deleted.

---

## Phase 2: Maintenance Window — Restart in RESTRICT

The AWR repository rebuild scripts (Phase 3) require exclusive access to SYS-owned objects. Start the database in RESTRICT mode to prevent non-DBA connections:

\`\`\`sql
SHUTDOWN IMMEDIATE;
STARTUP RESTRICT;
\`\`\`

Verify that only DBA sessions are connected:

\`\`\`sql
SELECT username, status, program
FROM v\$session
WHERE type = 'USER'
ORDER BY username;
\`\`\`

If any non-SYS, non-SYSTEM session appears, investigate before proceeding. The RESTRICT startup rejects new connections from users without the RESTRICTED SESSION privilege but does not kill existing sessions that connected before the restart.

---

## Phase 3: Rebuild AWR Repository

This phase is the most impactful step for SM/AWR bloat. It destroys all existing AWR history and recreates the schema. Only proceed if you have confirmed that the historical AWR data has no operational value and you accept its loss.

\`\`\`sql
-- Step 1: Drop all AWR objects
@\$ORACLE_HOME/rdbms/admin/catnoawr.sql

-- Step 2: Clear the recyclebin to remove any lingering AWR objects
PURGE DBA_RECYCLEBIN;

-- Step 3: Recreate the AWR schema
@\$ORACLE_HOME/rdbms/admin/catawrtb.sql

-- Step 4: Recompile any invalid objects
@\$ORACLE_HOME/rdbms/admin/utlrp.sql
\`\`\`

After \`utlrp.sql\` completes, confirm no invalid objects remain:

\`\`\`sql
SELECT COUNT(*) FROM dba_objects WHERE status = 'INVALID';
\`\`\`

If invalid objects remain, check whether they are Oracle-owned (unlikely after utlrp) or user-owned (less critical). Do not proceed with Phase 4 if any SYS-owned objects are invalid.

Check the SM/AWR occupant size after rebuild:

\`\`\`sql
SELECT occupant_name, ROUND(space_usage_kbytes / 1048576, 2) AS space_gb
FROM v\$sysaux_occupants
WHERE occupant_name IN ('SM/AWR','SM/OPT','SM/OPTSTAT')
ORDER BY space_usage_kbytes DESC;
\`\`\`

---

## Phase 4: Purge Optimizer Statistics History

After the AWR rebuild, optimizer statistics history (SM/OPT) is typically the remaining dominant occupant. Purge it using \`DBMS_STATS\`:

### 4.1 Check current retention

\`\`\`sql
SELECT dbms_stats.get_stats_history_retention AS retention_days FROM dual;
\`\`\`

### 4.2 Full purge — all history

Use this when the statistics history is entirely stale or the database has been cloned from an environment where it accumulated without value:

\`\`\`sql
EXEC DBMS_STATS.PURGE_STATS(DBMS_STATS.PURGE_ALL);
\`\`\`

This call can run for 20–60 minutes on a large database. Monitor from a second session:

\`\`\`sql
SELECT opname, target, sofar, totalwork,
       ROUND(sofar / NULLIF(totalwork, 0) * 100, 1) AS pct_done,
       elapsed_seconds
FROM v\$session_longops
WHERE sofar < totalwork
  AND last_update_time > SYSDATE - 1/24
ORDER BY last_update_time DESC;
\`\`\`

### 4.3 Targeted purge — keep recent history

If you want to retain recent statistics history for plan regression troubleshooting:

\`\`\`sql
-- Keep the last 10 days of statistics history
EXEC DBMS_STATS.PURGE_STATS(SYSDATE - 10);
\`\`\`

### 4.4 Set a permanent retention going forward

After the purge, set a retention that prevents re-accumulation. 14 days is recommended for most production databases:

\`\`\`sql
BEGIN DBMS_STATS.ALTER_STATS_HISTORY_RETENTION(14); END;
/

-- Confirm
SELECT dbms_stats.get_stats_history_retention FROM dual;
\`\`\`

---

## Phase 5: Move and Shrink WRI\$_OPTSTAT Tables

After purging the rows, the segments still occupy the original extents — the high watermark has not moved. Shrink or move each table to release extents back to the tablespace.

### 5.1 Generate the enable row movement DDL

\`\`\`sql
SELECT 'ALTER TABLE '||owner||'.'||segment_name||' ENABLE ROW MOVEMENT;'
FROM dba_segments
WHERE tablespace_name = 'SYSAUX'
  AND segment_name LIKE 'WRI\$_OPTSTAT%'
  AND segment_type = 'TABLE'
ORDER BY bytes DESC;
\`\`\`

Execute each generated statement.

### 5.2 Generate and execute the shrink DDL

\`\`\`sql
SELECT 'ALTER TABLE '||owner||'.'||segment_name||' SHRINK SPACE CASCADE;'
FROM dba_segments
WHERE tablespace_name = 'SYSAUX'
  AND segment_name LIKE 'WRI\$_OPTSTAT%'
  AND segment_type = 'TABLE'
ORDER BY bytes DESC;
\`\`\`

\`SHRINK SPACE CASCADE\` shrinks the table and all of its dependent indexes in one command. It is an online operation and does not prevent DML, but it generates redo — run the largest tables during off-peak hours.

### 5.3 Disable row movement after shrink

\`\`\`sql
SELECT 'ALTER TABLE '||owner||'.'||segment_name||' DISABLE ROW MOVEMENT;'
FROM dba_segments
WHERE tablespace_name = 'SYSAUX'
  AND segment_name LIKE 'WRI\$_OPTSTAT%'
  AND segment_type = 'TABLE'
ORDER BY bytes DESC;
\`\`\`

### 5.4 Alternative: MOVE instead of SHRINK

If \`SHRINK SPACE\` is slow or fails on a particular table, \`MOVE\` is a full rebuild into new extents:

\`\`\`sql
ALTER TABLE SYS.WRI\$_OPTSTAT_TAB_HISTORY MOVE TABLESPACE SYSAUX;
\`\`\`

After \`MOVE\`, all indexes on the table become unusable. Rebuild them immediately (see Phase 6).

---

## Phase 6: Fix ORA-01502 — Rebuild Blocking Index First

After shrinking or moving the \`WRI\$_OPTSTAT\` tables, some indexes will be in UNUSABLE state. When you attempt to rebuild them, you may encounter:

\`\`\`
ORA-01502: index 'SYS.I_WRI\$_OPTSTAT_IND_OBJ#_ST' or partition of such index is in unusable state
\`\`\`

This error can appear when rebuilding a *different* index — not the one named. \`I_WRI\$_OPTSTAT_IND_OBJ#_ST\` is a parent index that other SYSAUX indexes depend on during the rebuild operation. If it is unusable, all dependent index rebuilds will fail with ORA-01502.

**The fix: rebuild this index first, before all others.**

\`\`\`sql
-- Step 1: Rebuild the blocking parent index
ALTER INDEX SYS.I_WRI\$_OPTSTAT_IND_OBJ#_ST REBUILD ONLINE;

-- Step 2: Confirm it is now VALID
SELECT status FROM dba_indexes
WHERE owner = 'SYS' AND index_name = 'I_WRI\$_OPTSTAT_IND_OBJ#_ST';
-- Expected: VALID
\`\`\`

### 6.1 Identify all remaining invalid SYSAUX indexes

\`\`\`sql
SELECT 'ALTER INDEX '||owner||'.'||index_name||' REBUILD;' AS cmd
FROM dba_indexes
WHERE tablespace_name = 'SYSAUX'
  AND status <> 'VALID'
ORDER BY owner, index_name;
\`\`\`

Execute each generated \`ALTER INDEX ... REBUILD\` statement. For large indexes, add the \`ONLINE\` clause to avoid locking:

\`\`\`sql
ALTER INDEX SYS.I_WRI\$_OPTSTAT_IND_OBJ#_ST   REBUILD ONLINE;
ALTER INDEX SYS.I_WRI\$_OPTSTAT_TAB_OBJ#_ST   REBUILD ONLINE;
ALTER INDEX SYS.I_WRI\$_OPTSTAT_H_OBJ#_ICOL#_ST REBUILD ONLINE;
ALTER INDEX SYS.I_WRI\$_OPTSTAT_HH_OBJ#_ICOL#_ST REBUILD ONLINE;
\`\`\`

### 6.2 Confirm all indexes valid

\`\`\`sql
SELECT owner, index_name, status
FROM dba_indexes
WHERE tablespace_name = 'SYSAUX'
  AND status <> 'VALID'
ORDER BY owner, index_name;
-- Zero rows = all valid
\`\`\`

---

## Phase 7: Reclaim Disk Space — Move HWM and Resize Datafiles

Free space inside the tablespace does not translate to disk space reclamation until the datafiles are resized. To resize, you first need to ensure no extents are allocated near the end of each datafile.

### 7.1 Find the minimum safe resize size for each datafile

\`\`\`sql
SELECT e.file_id,
       df.file_name,
       ROUND(df.bytes / 1073741824, 2)                            AS current_gb,
       ROUND((MAX(e.block_id + e.blocks - 1) * 8192) / 1073741824 + 1, 1) AS min_safe_gb
FROM dba_extents e
JOIN dba_data_files df ON df.file_id = e.file_id
WHERE df.tablespace_name = 'SYSAUX'
GROUP BY e.file_id, df.file_name, df.bytes
ORDER BY e.file_id;
\`\`\`

If \`current_gb\` greatly exceeds \`min_safe_gb\` for any file, that file can be shrunk.

### 7.2 Move segments that are blocking a datafile resize

If any segment is allocated near the top of a datafile, it must be moved before the file can be resized. Generate the move DDL:

\`\`\`sql
-- Segments in the top 20% of each SYSAUX datafile
SELECT 'ALTER TABLE '||e.owner||'.'||e.segment_name||' MOVE TABLESPACE SYSAUX;' AS cmd,
       e.file_id,
       ROUND(e.block_id * 8192 / 1073741824, 2) AS start_gb
FROM dba_extents e
JOIN dba_data_files df ON df.file_id = e.file_id
WHERE df.tablespace_name = 'SYSAUX'
  AND e.segment_type = 'TABLE'
  AND e.block_id * 8192 > df.bytes * 0.8
ORDER BY e.file_id, e.block_id DESC;
\`\`\`

After moving each table, rebuild its indexes immediately:

\`\`\`sql
SELECT 'ALTER INDEX '||owner||'.'||index_name||' REBUILD;' AS cmd
FROM dba_indexes
WHERE table_name = '<MOVED_TABLE_NAME>'
  AND status = 'UNUSABLE';
\`\`\`

### 7.3 Resize the datafiles

After moving blocking segments, resize each datafile to its safe minimum plus a buffer (add at least 10% headroom for growth before the next maintenance window):

\`\`\`sql
-- Example: resize each datafile (replace paths and sizes with your values from 7.1)
ALTER DATABASE DATAFILE '/path/to/sysaux01.dbf' RESIZE 8G;
ALTER DATABASE DATAFILE '/path/to/sysaux02.dbf' RESIZE 4G;
\`\`\`

If \`ALTER DATABASE DATAFILE ... RESIZE\` fails with \`ORA-03297: file contains used data beyond requested RESIZE value\`, a segment is still allocated beyond the target size — go back to step 7.2 and move it.

### 7.4 Confirm reclamation

\`\`\`sql
-- Compare to the Phase 0 baseline
SELECT file_name,
       ROUND(bytes / 1073741824, 1) AS current_gb
FROM dba_data_files
WHERE tablespace_name = 'SYSAUX'
ORDER BY file_id;

SELECT occupant_name, ROUND(space_usage_kbytes / 1048576, 2) AS space_gb
FROM v\$sysaux_occupants
ORDER BY space_usage_kbytes DESC;
\`\`\`

---

## Phase 8: Restore and Validate

### 8.1 Re-enable AWR with correct retention

\`\`\`sql
-- 60-minute intervals, 30-day retention (43200 minutes)
EXEC DBMS_WORKLOAD_REPOSITORY.MODIFY_SNAPSHOT_SETTINGS(interval => 60, retention => 43200);

-- Verify
SELECT snap_interval, retention FROM dba_hist_wr_control;
\`\`\`

If your environment requires a longer or shorter AWR window, adjust the \`retention\` parameter accordingly:
- 7 days: 10080 minutes
- 14 days: 20160 minutes
- 30 days: 43200 minutes

### 8.2 Restart in normal mode

\`\`\`sql
SHUTDOWN IMMEDIATE;
STARTUP;
\`\`\`

Confirm AWR starts taking snapshots:

\`\`\`sql
-- Wait 5 minutes after startup, then check
SELECT COUNT(*) FROM dba_hist_snapshot
WHERE begin_interval_time > SYSDATE - 1/24;
-- Should be > 0
\`\`\`

### 8.3 Final validation checklist

\`\`\`sql
-- 1. SYSAUX occupants (compare to Phase 0 baseline)
SELECT occupant_name, ROUND(space_usage_kbytes / 1048576, 2) AS space_gb
FROM v\$sysaux_occupants ORDER BY space_usage_kbytes DESC;

-- 2. No invalid objects
SELECT COUNT(*) FROM dba_objects WHERE status = 'INVALID';

-- 3. No invalid indexes in SYSAUX
SELECT COUNT(*) FROM dba_indexes
WHERE tablespace_name = 'SYSAUX' AND status <> 'VALID';

-- 4. AWR retention confirmed
SELECT retention FROM dba_hist_wr_control;

-- 5. Optimizer stats retention confirmed
SELECT dbms_stats.get_stats_history_retention FROM dual;

-- 6. SYSAUX tablespace free space
SELECT ROUND(SUM(bytes) / 1073741824, 1) AS free_gb
FROM dba_free_space WHERE tablespace_name = 'SYSAUX';
\`\`\`

---

## Diagnostic Shell Script

Save as \`sysaux_diag.sh\` and run before starting the runbook to generate a complete baseline report and all DDL scripts needed for Phases 5–7.

\`\`\`bash
#!/bin/bash
# sysaux_diag.sh -- SYSAUX diagnostic and DDL generator
# Usage: ./sysaux_diag.sh [ORACLE_SID]
# Generates: occupant report, WRI\$_OPTSTAT sizes, invalid indexes, shrink DDL, resize estimates

ORACLE_SID="\${1:-ORCL}"
export ORACLE_SID
TIMESTAMP=\$(date '+%Y%m%d_%H%M%S')
OUTDIR="/tmp/sysaux_diag_\${TIMESTAMP}"
mkdir -p "\$OUTDIR"

source /home/oracle/.bash_profile 2>/dev/null || true
export ORACLE_HOME="\${ORACLE_HOME:-/u01/app/oracle/product/11.2.0/dbhome_1}"
export PATH="\$ORACLE_HOME/bin:\$PATH"
SP="\$ORACLE_HOME/bin/sqlplus -s / as sysdba"

log() { echo "[\$(date '+%H:%M:%S')] \$*"; }

log "=== SYSAUX Diagnostic for \$ORACLE_SID ==="
log "Output directory: \$OUTDIR"

# ------------------------------------------------------------------
# Report 1: SYSAUX occupants
# ------------------------------------------------------------------
log "Generating occupant report..."
\$SP > "\$OUTDIR/01_occupants.txt" <<'SQLEOF'
SET LINES 120 PAGES 200
COL occupant_name FORMAT A30
COL schema_name   FORMAT A20
COL space_gb      FORMAT 999,990.00
SELECT occupant_name,
       schema_name,
       ROUND(space_usage_kbytes / 1048576, 2) AS space_gb
FROM v\$sysaux_occupants
WHERE space_usage_kbytes > 0
ORDER BY space_usage_kbytes DESC;
SQLEOF

cat "\$OUTDIR/01_occupants.txt"

# ------------------------------------------------------------------
# Report 2: WRI\$_OPTSTAT table sizes
# ------------------------------------------------------------------
log "Generating WRI\$_OPTSTAT segment sizes..."
\$SP > "\$OUTDIR/02_wrioptstat_sizes.txt" <<'SQLEOF'
SET LINES 120 PAGES 200
COL segment_name FORMAT A50
COL size_mb      FORMAT 999,999,990
SELECT segment_name,
       ROUND(SUM(bytes) / 1048576, 0) AS size_mb
FROM dba_segments
WHERE tablespace_name = 'SYSAUX'
  AND segment_name LIKE 'WRI\$_OPTSTAT%'
GROUP BY segment_name
ORDER BY size_mb DESC;
SQLEOF

cat "\$OUTDIR/02_wrioptstat_sizes.txt"

# ------------------------------------------------------------------
# Report 3: AWR snapshot count and retention
# ------------------------------------------------------------------
log "Generating AWR snapshot report..."
\$SP > "\$OUTDIR/03_awr_snapshots.txt" <<'SQLEOF'
SET LINES 120 PAGES 50
SELECT snap_interval, retention FROM dba_hist_wr_control;

SELECT COUNT(*)                          AS total_snapshots,
       MIN(begin_interval_time)          AS oldest_snap,
       MAX(end_interval_time)            AS newest_snap,
       ROUND(MAX(end_interval_time) - MIN(begin_interval_time)) AS days_retained
FROM dba_hist_snapshot;
SQLEOF

cat "\$OUTDIR/03_awr_snapshots.txt"

# ------------------------------------------------------------------
# Report 4: Invalid indexes in SYSAUX
# ------------------------------------------------------------------
log "Generating invalid index report..."
\$SP > "\$OUTDIR/04_invalid_indexes.txt" <<'SQLEOF'
SET LINES 120 PAGES 200
COL owner       FORMAT A10
COL index_name  FORMAT A50
COL status      FORMAT A10
SELECT owner, index_name, status
FROM dba_indexes
WHERE tablespace_name = 'SYSAUX'
  AND status <> 'VALID'
ORDER BY owner, index_name;
SQLEOF

cat "\$OUTDIR/04_invalid_indexes.txt"

# ------------------------------------------------------------------
# DDL Generator 1: Enable row movement for WRI\$_OPTSTAT tables
# ------------------------------------------------------------------
log "Generating enable row movement DDL..."
\$SP > "\$OUTDIR/ddl_01_enable_rowmove.sql" <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON LINESIZE 200
SELECT 'ALTER TABLE '||owner||'.'||segment_name||' ENABLE ROW MOVEMENT;'
FROM dba_segments
WHERE tablespace_name = 'SYSAUX'
  AND segment_name LIKE 'WRI\$_OPTSTAT%'
  AND segment_type = 'TABLE'
ORDER BY bytes DESC;
SQLEOF

# ------------------------------------------------------------------
# DDL Generator 2: Shrink WRI\$_OPTSTAT tables
# ------------------------------------------------------------------
log "Generating shrink DDL..."
\$SP > "\$OUTDIR/ddl_02_shrink.sql" <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON LINESIZE 200
SELECT 'ALTER TABLE '||owner||'.'||segment_name||' SHRINK SPACE CASCADE;'
FROM dba_segments
WHERE tablespace_name = 'SYSAUX'
  AND segment_name LIKE 'WRI\$_OPTSTAT%'
  AND segment_type = 'TABLE'
ORDER BY bytes DESC;
SQLEOF

# ------------------------------------------------------------------
# DDL Generator 3: Disable row movement after shrink
# ------------------------------------------------------------------
log "Generating disable row movement DDL..."
\$SP > "\$OUTDIR/ddl_03_disable_rowmove.sql" <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON LINESIZE 200
SELECT 'ALTER TABLE '||owner||'.'||segment_name||' DISABLE ROW MOVEMENT;'
FROM dba_segments
WHERE tablespace_name = 'SYSAUX'
  AND segment_name LIKE 'WRI\$_OPTSTAT%'
  AND segment_type = 'TABLE'
ORDER BY bytes DESC;
SQLEOF

# ------------------------------------------------------------------
# DDL Generator 4: Rebuild invalid SYSAUX indexes
# ------------------------------------------------------------------
log "Generating index rebuild DDL..."
\$SP > "\$OUTDIR/ddl_04_rebuild_indexes.sql" <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON LINESIZE 200
-- Rebuild blocking parent index FIRST
SELECT 'ALTER INDEX SYS.I_WRI\$_OPTSTAT_IND_OBJ#_ST REBUILD ONLINE;' AS cmd
FROM dual
WHERE EXISTS (
  SELECT 1 FROM dba_indexes
  WHERE owner = 'SYS'
    AND index_name = 'I_WRI\$_OPTSTAT_IND_OBJ#_ST'
    AND status <> 'VALID'
)
UNION ALL
-- Then all other invalid SYSAUX indexes
SELECT 'ALTER INDEX '||owner||'.'||index_name||' REBUILD ONLINE;'
FROM dba_indexes
WHERE tablespace_name = 'SYSAUX'
  AND status <> 'VALID'
  AND NOT (owner = 'SYS' AND index_name = 'I_WRI\$_OPTSTAT_IND_OBJ#_ST')
ORDER BY 1;
SQLEOF

# ------------------------------------------------------------------
# DDL Generator 5: Datafile resize estimates
# ------------------------------------------------------------------
log "Generating datafile resize estimates..."
\$SP > "\$OUTDIR/05_resize_estimates.txt" <<'SQLEOF'
SET LINES 160 PAGES 100
COL file_name    FORMAT A60
COL current_gb   FORMAT 990.0
COL min_safe_gb  FORMAT 990.0
SELECT df.file_id,
       df.file_name,
       ROUND(df.bytes / 1073741824, 1) AS current_gb,
       ROUND((MAX(e.block_id + e.blocks - 1) * 8192) / 1073741824 + 1, 1) AS min_safe_gb
FROM dba_extents e
JOIN dba_data_files df ON df.file_id = e.file_id
WHERE df.tablespace_name = 'SYSAUX'
GROUP BY df.file_id, df.file_name, df.bytes
ORDER BY df.file_id;
SQLEOF

cat "\$OUTDIR/05_resize_estimates.txt"

log ""
log "=== Diagnostic complete. Files in \$OUTDIR ==="
ls -lh "\$OUTDIR/"
log ""
log "Next steps:"
log "  1. Review \$OUTDIR/01_occupants.txt — identify dominant SM/AWR or SM/OPT"
log "  2. Review \$OUTDIR/02_wrioptstat_sizes.txt — confirm WRI\$_OPTSTAT tables are large"
log "  3. Execute ddl_01_enable_rowmove.sql, ddl_02_shrink.sql, ddl_03_disable_rowmove.sql"
log "  4. Execute ddl_04_rebuild_indexes.sql IN ORDER (blocking index is first)"
log "  5. Review 05_resize_estimates.txt and run ALTER DATABASE DATAFILE ... RESIZE"
\`\`\`

Make the script executable and run it:

\`\`\`bash
chmod +x sysaux_diag.sh
./sysaux_diag.sh ORCL
\`\`\`

---

## SYSAUX Growth Monitoring Alert

Set up a cron-based check that alerts when SYSAUX exceeds configurable thresholds. Add to the oracle user's crontab:

\`\`\`bash
#!/bin/bash
# sysaux_alert.sh -- alert when SYSAUX exceeds threshold
# Cron: */30 * * * * /usr/local/bin/sysaux_alert.sh ORCL 75 90

ORACLE_SID="\${1:-ORCL}"
WARN_PCT="\${2:-75}"
CRIT_PCT="\${3:-90}"
export ORACLE_SID

source /home/oracle/.bash_profile 2>/dev/null || true
export ORACLE_HOME="\${ORACLE_HOME:-/u01/app/oracle/product/11.2.0/dbhome_1}"
export PATH="\$ORACLE_HOME/bin:\$PATH"

PCT_USED=\$(\$ORACLE_HOME/bin/sqlplus -s / as sysdba <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT ROUND((SUM(d.bytes) - NVL(SUM(f.bytes), 0)) / SUM(d.bytes) * 100, 1)
FROM dba_data_files d
LEFT JOIN dba_free_space f ON f.tablespace_name = d.tablespace_name
WHERE d.tablespace_name = 'SYSAUX';
EXIT;
SQLEOF
)

PCT_USED=\$(echo "\$PCT_USED" | tr -d '[:space:]')

if [[ -z "\$PCT_USED" ]]; then
  echo "[\$(date)] ERROR: Could not query SYSAUX usage for \$ORACLE_SID"
  exit 2
fi

# Alert threshold check
if (( \$(echo "\$PCT_USED >= \$CRIT_PCT" | bc -l) )); then
  echo "[\$(date)] CRITICAL: SYSAUX is \${PCT_USED}% full on \$ORACLE_SID (threshold: \${CRIT_PCT}%)"
  echo "[\$(date)] Run sysaux_diag.sh and initiate reclamation runbook immediately."
  exit 2
elif (( \$(echo "\$PCT_USED >= \$WARN_PCT" | bc -l) )); then
  echo "[\$(date)] WARNING: SYSAUX is \${PCT_USED}% full on \$ORACLE_SID (threshold: \${WARN_PCT}%)"
  echo "[\$(date)] Check SM/AWR and SM/OPT occupants and schedule maintenance."
  exit 1
else
  echo "[\$(date)] OK: SYSAUX is \${PCT_USED}% full on \$ORACLE_SID"
  exit 0
fi
\`\`\`

Add the SM/OPT occupant size check as an additional threshold — alert if SM/OPT exceeds 50 GB regardless of overall tablespace percentage:

\`\`\`bash
SMOPT_GB=\$(\$ORACLE_HOME/bin/sqlplus -s / as sysdba <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT ROUND(space_usage_kbytes / 1048576, 1)
FROM v\$sysaux_occupants
WHERE occupant_name IN ('SM/OPT','SM/OPTSTAT')
  AND ROWNUM = 1;
EXIT;
SQLEOF
)
SMOPT_GB=\$(echo "\$SMOPT_GB" | tr -d '[:space:]')

if [[ -n "\$SMOPT_GB" ]] && (( \$(echo "\$SMOPT_GB > 50" | bc -l) )); then
  echo "[\$(date)] WARNING: SM/OPT occupant is \${SMOPT_GB}GB on \$ORACLE_SID"
  echo "[\$(date)] Run: EXEC DBMS_STATS.PURGE_STATS(SYSDATE-14);"
fi
\`\`\`

---

## Troubleshooting Reference

| Error or Symptom | Root Cause | Resolution |
|-----------------|-----------|------------|
| \`ORA-01502: index ... in unusable state\` during index rebuild | \`I_WRI\$_OPTSTAT_IND_OBJ#_ST\` is unusable and must be rebuilt first | \`ALTER INDEX SYS.I_WRI\$_OPTSTAT_IND_OBJ#_ST REBUILD ONLINE;\` then retry other indexes |
| \`ORA-03297\` when resizing datafile | Segment allocated beyond target resize point | Run 7.2 move script to relocate blocking segments, then retry resize |
| \`ORA-10635\` when running SHRINK SPACE | Row movement not enabled | \`ALTER TABLE ... ENABLE ROW MOVEMENT;\` then retry shrink |
| \`DBMS_STATS.PURGE_STATS\` hangs for hours | Very large stats history, contention on SYS tables | Monitor with \`v\$session_longops\`; if truly stuck, kill and use targeted date-range purge in smaller batches |
| AWR snapshots fail after re-enable | Invalid AWR objects after rebuild | Run \`@\$ORACLE_HOME/rdbms/admin/utlrp.sql\` and recheck \`dba_objects\` for invalids |
| Space not reclaimed after purge | HWM not lowered — rows deleted but extents retained | Proceed with Phase 5 shrink or Phase 7 move and resize |
| catnoawr.sql errors | Some AWR objects already dropped or corrupted | Review spool output; missing objects during drop are usually safe to ignore |
| SYSAUX re-fills within weeks | AWR retention not changed before re-enable | Set retention explicitly with \`MODIFY_SNAPSHOT_SETTINGS\` before restart (Phase 8.1) |

---

## Post-Maintenance Checklist

Complete each item after finishing Phase 8:

\`\`\`
[ ] SYSAUX usage is below 50% of allocated size
[ ] V\$SYSAUX_OCCUPANTS — SM/AWR and SM/OPT each below 20 GB
[ ] No invalid objects in dba_objects
[ ] No invalid indexes in SYSAUX (dba_indexes WHERE status <> 'VALID')
[ ] AWR taking snapshots (dba_hist_snapshot has entries within last 2 hours)
[ ] AWR retention confirmed at target value in dba_hist_wr_control
[ ] Optimizer stats retention confirmed at 14 days
[ ] sysaux_alert.sh scheduled in cron with 75%/90% thresholds
[ ] Disk space reclamation confirmed (OS-level df -h on datafile filesystem)
[ ] Baseline SYSAUX size recorded in capacity tracking system
\`\`\``,
  };

  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: {
      title: post.title,
      content: post.content,
      excerpt: post.excerpt,
      updatedAt: new Date(),
    },
  });
  console.log('Inserted:', post.slug);
}

main().catch(console.error);
