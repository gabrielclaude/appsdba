import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Temp Tablespace Monitoring, Sizing, and ORA-01652 Diagnosis',
  slug: 'oracle-temp-tablespace-monitoring-ora-01652-runbook',
  excerpt:
    'A phased operational runbook for Oracle DBAs covering temp tablespace configuration audits, real-time usage monitoring via V$TEMPSEG_USAGE and V$SORT_SEGMENT, PGA work area analysis using V$SQL_WORKAREA, step-by-step ORA-01652 diagnosis and emergency resolution, temp tablespace maintenance procedures, and an automated shell monitoring script with Nagios-compatible exit codes and crontab integration.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-05'),
  youtubeUrl: null,
  content: `This runbook covers the full operational lifecycle of Oracle temporary tablespace management: initial configuration audit, real-time usage monitoring, PGA work area analysis, ORA-01652 diagnosis and resolution, tablespace maintenance, and continuous monitoring via a shell script. Assumptions: Oracle 12.2 or later, the executing user holds the DBA role (SYSDBA is noted explicitly where required), and the database is running on a supported Linux/Unix platform. Steps that modify system parameters or tablespace structure require a maintenance window or at minimum a change management approval in production environments.

---

## Phase 0: Temp Tablespace Configuration Audit

### Step 0.1 — List All Temp Tablespaces and Their Size

\`\`\`sql
SELECT t.tablespace_name,
       t.status,
       t.extent_management,
       t.allocation_type,
       round(sum(f.bytes) / 1073741824, 2) as total_gb
FROM dba_tablespaces t
JOIN dba_temp_files f ON f.tablespace_name = t.tablespace_name
WHERE t.contents = 'TEMPORARY'
GROUP BY t.tablespace_name, t.status, t.extent_management, t.allocation_type
ORDER BY t.tablespace_name;
\`\`\`

Expected: one or more rows with \`contents = TEMPORARY\`, \`extent_management = LOCAL\`, and \`allocation_type = UNIFORM\`. A \`UNIFORM SIZE 1M\` allocation policy is the standard for temp tablespaces — it allows efficient extent reuse and avoids fragmentation. Verify that the total GB is consistent with the workload's expected peak temp requirements.

### Step 0.2 — Check Temp Datafiles and Autoextend Settings

\`\`\`sql
SELECT file_name,
       tablespace_name,
       round(bytes / 1073741824, 2) as size_gb,
       autoextensible,
       round(maxbytes / 1073741824, 2) as max_gb,
       increment_by * 8192 / 1048576 as increment_mb,
       status
FROM dba_temp_files
ORDER BY tablespace_name, file_name;
\`\`\`

Note any files with \`autoextensible = NO\` — these represent hard capacity limits. An autoextend-disabled temp datafile that is fully allocated cannot absorb peak temp demand and will cause ORA-01652. For files with \`autoextensible = YES\`, verify that \`max_gb\` is set to a realistic value — an extremely low MAXSIZE will silently prevent extension and cause ORA-01652 even when disk space is available.

### Step 0.3 — Check Database Default Temporary Tablespace

\`\`\`sql
SELECT property_name, property_value
FROM database_properties
WHERE property_name = 'DEFAULT_TEMP_TABLESPACE';
\`\`\`

The result must never be \`SYSTEM\`. If the default temporary tablespace is SYSTEM, users without an explicit temp tablespace assignment will use the SYSTEM tablespace for sort operations — this is dangerous and can cause SYSTEM tablespace space exhaustion. If SYSTEM is the result, create a proper temp tablespace and set it as the default immediately.

### Step 0.4 — Check Which Users Are Assigned to Which Temp Tablespace

\`\`\`sql
SELECT username,
       temporary_tablespace,
       account_status
FROM dba_users
WHERE account_status = 'OPEN'
ORDER BY temporary_tablespace, username;
\`\`\`

Verify that no open user accounts are assigned to SYSTEM as their temporary tablespace. In a multitenant PDB, this query returns users within the current PDB context. Heavy analytic users should be assigned to a dedicated temp tablespace or temp tablespace group rather than sharing the default with OLTP users.

### Step 0.5 — Check PGA Parameters

\`\`\`sql
SELECT name, value, description
FROM v\$parameter
WHERE name IN (
  'pga_aggregate_target',
  'pga_aggregate_limit',
  'workarea_size_policy',
  'sort_area_size',
  'hash_area_size'
)
ORDER BY name;
\`\`\`

Expected: \`workarea_size_policy = AUTO\`, \`pga_aggregate_target\` set to a non-zero value appropriate for the server's memory, \`pga_aggregate_limit\` set (12c+, should be at least 2x \`pga_aggregate_target\`). If \`workarea_size_policy = MANUAL\`, the database is using the legacy \`sort_area_size\` and \`hash_area_size\` parameters — this configuration is suboptimal and should be migrated to automatic management.

---

## Phase 1: Current Temp Space Usage

### Step 1.1 — Current Temp Space Free vs Used

\`\`\`sql
SELECT tablespace_name,
       round(tablespace_size / 1073741824, 2) as total_gb,
       round(allocated_space / 1073741824, 2) as allocated_gb,
       round(free_space / 1073741824, 2) as free_gb,
       round((1 - free_space / nullif(tablespace_size, 0)) * 100, 2) as pct_used
FROM dba_temp_free_space
ORDER BY tablespace_name;
\`\`\`

This is the fastest check for overall temp space status. \`allocated_space\` is the space currently held by active sort segments (including pre-allocated extents that are not yet in active use by a session). \`free_space\` is the space not yet claimed by any sort segment. A high \`pct_used\` during peak load is expected; the same high percentage during a quiet period indicates that sort segments have not released their pre-allocated extents — which is normal behavior unless the tablespace is completely full.

### Step 1.2 — Active Temp Segment Usage by Session

\`\`\`sql
SELECT s.sid,
       s.serial#,
       s.username,
       s.sql_id,
       s.module,
       u.tablespace,
       u.segtype,
       round(u.blocks * 8192 / 1073741824, 3) as temp_gb,
       s.status
FROM v\$tempseg_usage u
JOIN v\$session s ON s.saddr = u.session_addr
ORDER BY u.blocks DESC;
\`\`\`

This is the primary diagnostic query for identifying which sessions are consuming temp space and for what operation type. \`segtype\` distinguishes SORT, HASH, DATA (global temporary table), LOB_DATA, and other types. The session with the largest \`temp_gb\` value is the primary candidate for investigation during an ORA-01652 incident. Save the \`sql_id\` for further analysis in Phase 3.

### Step 1.3 — Current Sort Segment Usage (Aggregate by Type)

\`\`\`sql
SELECT tablespace_name,
       segtype,
       round(sum(blocks) * 8192 / 1073741824, 3) as gb_used,
       count(*) as segments,
       sum(extents) as total_extents
FROM v\$tempseg_usage
GROUP BY tablespace_name, segtype
ORDER BY sum(blocks) DESC;
\`\`\`

This aggregated view shows the breakdown of temp consumption by operation type across the entire database. If HASH consumption dominates, hash join operations are the primary driver and increasing PGA or adding hints to reduce hash join frequency may help. If SORT dominates, sort operations are the primary driver. DATA segments indicate global temporary table usage.

### Step 1.4 — V$SORT_SEGMENT — Pre-Allocated Sort Segment Pool and High-Water Mark

\`\`\`sql
SELECT tablespace_name,
       current_users,
       total_blocks,
       used_blocks,
       free_blocks,
       round(used_blocks * 8192 / 1073741824, 3) as used_gb,
       round(free_blocks * 8192 / 1073741824, 3) as free_gb,
       max_used_blocks,
       round(max_used_blocks * 8192 / 1073741824, 3) as peak_used_gb
FROM v\$sort_segment;
-- max_used_blocks = high-water mark since instance startup — use for sizing
\`\`\`

The \`max_used_blocks\` column is the single most important figure for temp tablespace sizing. It records the maximum simultaneous temp block allocation since instance startup, regardless of how briefly that peak was sustained. Convert to gigabytes with \`max_used_blocks * db_block_size / 1073741824\`. Size the temp tablespace to at least 150% of this value. If \`current_users = 0\`, no sessions are currently using temp space — the tablespace is idle.

---

## Phase 2: PGA and Work Area Analysis

### Step 2.1 — PGA Aggregate Statistics

\`\`\`sql
SELECT name,
       round(value / 1048576, 1) as mb
FROM v\$pgastat
WHERE name IN (
  'aggregate PGA target parameter',
  'aggregate PGA auto target',
  'total PGA inuse',
  'total PGA allocated',
  'total freeable PGA memory',
  'maximum PGA allocated',
  'cache hit percentage',
  'recompute count (total)'
)
ORDER BY name;
-- cache hit percentage: target > 90% OLTP, > 80% analytical
\`\`\`

The \`cache hit percentage\` is the headline metric. A value consistently below 80% indicates excessive temp spill and \`PGA_AGGREGATE_TARGET\` should be increased. The \`aggregate PGA auto target\` shows how much PGA Oracle has actually made available to work areas after reserving space for non-work-area PGA usage (cursors, session memory, etc.) — this is typically lower than \`PGA_AGGREGATE_TARGET\` and is the effective ceiling for work area allocation.

### Step 2.2 — SQL with Work Area Spills (Last Execution Not OPTIMAL)

\`\`\`sql
SELECT sql_id,
       operation_type,
       last_execution,
       policy,
       round(estimated_optimal_size / 1048576, 1) as optimal_mb,
       round(last_memory_used / 1048576, 1) as used_mb,
       round(last_tempseg_size / 1048576, 1) as temp_spill_mb,
       active_time / 1e6 as active_sec
FROM v\$sql_workarea
WHERE last_execution IN ('ONE PASS', 'MULTI PASS')
ORDER BY last_tempseg_size DESC NULLS LAST
FETCH FIRST 20 ROWS ONLY;
\`\`\`

This identifies the SQL statements that spilled to temp on their most recent execution, sorted by temp consumption. \`estimated_optimal_size\` shows how much memory would have been required for a fully in-memory execution — compare this to \`last_memory_used\` to understand the gap. \`MULTI PASS\` entries are the highest priority: they represent operations where the work area was so undersized that multiple passes over temp data were required. The \`sql_id\` from this query can be used to pull the full SQL text from \`V\$SQLTEXT\` or \`V\$SQL\`.

### Step 2.3 — Work Area Execution Statistics (System-Wide Summary)

\`\`\`sql
SELECT operation_type,
       last_execution,
       count(*) as operations,
       round(sum(last_memory_used) / 1073741824, 3) as total_mem_gb,
       round(sum(last_tempseg_size) / 1073741824, 3) as total_temp_gb
FROM v\$sql_workarea
WHERE last_execution IS NOT NULL
GROUP BY operation_type, last_execution
ORDER BY operation_type, last_execution;
\`\`\`

The OPTIMAL / ONE PASS / MULTI PASS distribution across all operation types provides a system-wide picture of PGA sizing adequacy. A healthy system should show the vast majority of operations as OPTIMAL, a minority as ONE PASS, and zero or near-zero MULTI PASS. If SORT or HASH operations show significant MULTI PASS counts, PGA is undersized relative to the workload and both performance and temp consumption will improve with a larger \`PGA_AGGREGATE_TARGET\`.

### Step 2.4 — Historical PGA Statistics from AWR

\`\`\`sql
SELECT s.begin_interval_time,
       round(p.pga_cache_hit_percentage, 1) as cache_hit_pct,
       round(p.max_pga_allocated / 1073741824, 2) as max_pga_gb,
       p.over_alloc_count
FROM dba_hist_pgastat p
JOIN dba_hist_snapshot s ON s.snap_id = p.snap_id
WHERE s.begin_interval_time > sysdate - 7
ORDER BY s.begin_interval_time DESC
FETCH FIRST 48 ROWS ONLY;
\`\`\`

The \`over_alloc_count\` column indicates how many times Oracle had to allocate PGA beyond the \`PGA_AGGREGATE_TARGET\` limit to service active work areas — a non-zero count indicates that the target is set too low for the observed concurrency. The \`max_pga_allocated\` column shows the peak PGA allocation observed in each AWR snapshot interval; use the maximum of this across all intervals to size \`PGA_AGGREGATE_LIMIT\` with headroom.

---

## Phase 3: ORA-01652 Diagnosis and Resolution

### Step 3.1 — Find the Session Causing ORA-01652 (or Consuming Most Temp)

\`\`\`sql
SELECT s.sid,
       s.serial#,
       s.username,
       s.sql_id,
       s.program,
       s.module,
       round(u.blocks * 8192 / 1073741824, 3) as temp_gb,
       s.last_call_et as running_sec
FROM v\$tempseg_usage u
JOIN v\$session s ON s.saddr = u.session_addr
ORDER BY u.blocks DESC
FETCH FIRST 5 ROWS ONLY;
\`\`\`

The session at the top of this list is the primary temp space consumer. Record the \`sid\`, \`serial#\`, \`sql_id\`, \`username\`, and \`module\` — you will need these for the subsequent diagnostic steps and for the session kill if emergency recovery is required. The \`running_sec\` column (\`last_call_et\`) shows how long the current call has been executing — a large value combined with large temp consumption indicates a runaway operation.

### Step 3.2 — Get the SQL Text for the Offending SQL_ID

\`\`\`sql
SELECT sql_text
FROM v\$sqltext
WHERE sql_id = '&sql_id'
ORDER BY piece;
\`\`\`

Review the SQL text to understand what the operation is doing and why it might be consuming large amounts of temp space. Common culprits: a missing join predicate causing a Cartesian product, an ORDER BY on a very large unbounded result set, a hash join between two very large tables without appropriate filters, or a parallel query with high degree-of-parallelism operating on a large table.

### Step 3.3 — Check Estimated Optimal Work Area for the SQL

\`\`\`sql
SELECT sql_id,
       operation_type,
       estimated_optimal_size / 1048576 as optimal_mb,
       estimated_onepass_size / 1048576 as onepass_mb,
       last_execution,
       last_tempseg_size / 1048576 as last_temp_mb
FROM v\$sql_workarea
WHERE sql_id = '&sql_id';
\`\`\`

The \`estimated_optimal_size\` is Oracle's estimate of the memory required for a fully in-memory execution. Compare this to the current \`PGA_AGGREGATE_TARGET\` value from Phase 2 Step 2.1. If \`estimated_optimal_size\` exceeds the available PGA budget per session, the operation will always spill to temp regardless of PGA tuning — the query itself may need to be restructured. If \`estimated_optimal_size\` is within range of what PGA tuning could provide, increasing \`PGA_AGGREGATE_TARGET\` is the appropriate fix.

### Step 3.4 — Emergency: Add a Temp Datafile Immediately

\`\`\`sql
ALTER TABLESPACE temp
  ADD TEMPFILE '/u01/oradata/PRODDB/temp02.dbf'
  SIZE 10G AUTOEXTEND ON NEXT 1G MAXSIZE 50G;
\`\`\`

This is the fastest resolution for an active ORA-01652 incident. The new datafile is immediately available — no restart is required. Choose a path on fast storage (preferably the same storage tier as the existing temp datafiles) and size it generously enough to absorb the current peak demand plus headroom. If the incident is caused by a runaway query, adding the datafile alone may not be sufficient — combine with Step 3.5 to terminate the runaway session.

### Step 3.5 — Kill the Runaway Temp-Consuming Session (If Necessary)

\`\`\`sql
-- Confirm the session first:
SELECT sid, serial#, username, sql_id, last_call_et
FROM v\$session
WHERE sid = &sid;

-- Kill it:
ALTER SYSTEM KILL SESSION '&sid,&serial#' IMMEDIATE;
\`\`\`

Before killing the session, confirm with the application team or on-call support that the operation is genuinely runaway and not a legitimate long-running job that happens to use large amounts of temp space. The IMMEDIATE keyword causes the session to be terminated as quickly as possible — the session's temp space will be released back to the sort segment pool immediately, making it available to waiting sessions.

---

## Phase 4: Temp Tablespace Maintenance

### Step 4.1 — Shrink Temp Tablespace (Requires No Active Sort Segments)

\`\`\`sql
-- Check for active users first:
SELECT current_users FROM v\$sort_segment;
-- Must be 0 before shrinking

ALTER TABLESPACE temp SHRINK SPACE KEEP 2G;
-- Retains 2G minimum; shrinks the rest
\`\`\`

The SHRINK SPACE operation reclaims space from the temp tablespace that was pre-allocated by the sort segment pool but is not currently in use. It can only be performed when \`current_users = 0\` in \`V\$SORT_SEGMENT\` — meaning no sessions are currently allocated temp extents. In a busy production system, this window may only be available during maintenance periods. The KEEP clause specifies a minimum size to retain — setting it to zero would attempt to shrink the tablespace to its minimum possible size, which may be too small for normal operations.

### Step 4.2 — Create a New, Larger Temp Tablespace and Switch Default

\`\`\`sql
CREATE TEMPORARY TABLESPACE temp2
  TEMPFILE '/u01/oradata/PRODDB/temp2_01.dbf'
  SIZE 20G AUTOEXTEND ON NEXT 2G MAXSIZE 100G
  EXTENT MANAGEMENT LOCAL UNIFORM SIZE 1M;

-- Set as database default:
ALTER DATABASE DEFAULT TEMPORARY TABLESPACE temp2;

-- Move specific users if needed:
ALTER USER &username TEMPORARY TABLESPACE temp2;

-- Drop old tablespace (once all sessions have migrated):
DROP TABLESPACE temp INCLUDING CONTENTS AND DATAFILES;
\`\`\`

This approach is preferred when the existing temp tablespace cannot be grown in-place (storage layout constraints, need to move to faster storage) or when a complete rebuild is required to reclaim fragmented space. After changing the default, existing sessions retain their current temp tablespace assignment until they reconnect — new sessions receive the new default. Wait for all sessions to cycle before dropping the old tablespace. The DROP TABLESPACE command fails if any active sort segments remain in the tablespace.

### Step 4.3 — Create a Temp Tablespace Group (for Parallel Query Environments)

\`\`\`sql
-- Create two temp tablespaces in a group:
CREATE TEMPORARY TABLESPACE temp_grp1
  TEMPFILE '/u01/oradata/PRODDB/temp_g1.dbf'
  SIZE 20G AUTOEXTEND ON NEXT 2G MAXSIZE 100G
  TABLESPACE GROUP TMP_GROUP;

CREATE TEMPORARY TABLESPACE temp_grp2
  TEMPFILE '/u02/oradata/PRODDB/temp_g2.dbf'
  SIZE 20G AUTOEXTEND ON NEXT 2G MAXSIZE 100G
  TABLESPACE GROUP TMP_GROUP;

-- Set as default:
ALTER DATABASE DEFAULT TEMPORARY TABLESPACE TMP_GROUP;
\`\`\`

Adding a tablespace to a group is done by specifying the \`TABLESPACE GROUP\` clause on the CREATE or ALTER TEMPORARY TABLESPACE statement. The group name is created implicitly when the first member tablespace is assigned to it. Place member tablespaces on different storage devices (\`/u01\` and \`/u02\` in this example) to achieve I/O parallelism. For a parallel query workload with degree-of-parallelism 32, a two-member group distributes temp I/O across two storage paths, potentially doubling effective temp I/O throughput.

### Step 4.4 — Increase PGA_AGGREGATE_TARGET to Reduce Temp Spill

\`\`\`sql
-- Dynamic parameter — takes effect immediately:
ALTER SYSTEM SET pga_aggregate_target = 4G SCOPE = BOTH;

-- Verify the change:
SELECT name, round(value / 1073741824, 2) as gb
FROM v\$parameter
WHERE name = 'pga_aggregate_target';
\`\`\`

\`PGA_AGGREGATE_TARGET\` is a dynamic parameter — the change takes effect immediately without a database restart. Increase in increments of 25–50% and re-evaluate the cache hit percentage in \`V\$PGASTAT\` after each increment. Allow time for the workload to cycle through representative operations before assessing improvement — a single measurement immediately after the change may not reflect steady-state behavior. \`SCOPE = BOTH\` persists the change to the SPFILE so it survives restarts.

### Step 4.5 — Set PGA_AGGREGATE_LIMIT (Hard Cap — 12c+)

\`\`\`sql
-- Hard limit prevents runaway sessions from consuming all OS memory:
ALTER SYSTEM SET pga_aggregate_limit = 16G SCOPE = BOTH;
-- Sessions exceeding their share get ORA-04036 and are terminated
\`\`\`

\`PGA_AGGREGATE_LIMIT\` should be set to a value that leaves sufficient OS memory for the kernel, the SGA, and other processes. A common guideline is to set it to the total available memory minus the SGA size minus 4–8 GB for the OS. For a 128 GB server with a 64 GB SGA and \`PGA_AGGREGATE_TARGET = 24G\`, a \`PGA_AGGREGATE_LIMIT = 48G\` provides a safety ceiling while allowing PGA to exceed the soft target during peak demand. Sessions that cause PGA to reach the limit will receive ORA-04036 — this is a protection mechanism, not a normal operating condition. Frequent ORA-04036 indicates \`PGA_AGGREGATE_LIMIT\` is too tight or \`PGA_AGGREGATE_TARGET\` needs to be increased.

---

## Phase 5: Temp Tablespace Monitoring Shell Script (with Crontab)

Save as \`/u01/app/oracle/scripts/temp_monitor/temp_monitor.sh\` and make executable (\`chmod 750\`).

\`\`\`bash
#!/bin/bash
# temp_monitor.sh — Oracle temp tablespace health monitor
# Usage: temp_monitor.sh <ORACLE_SID>
# Returns exit code = number of issues found (Nagios-compatible)
# Sends email alert if issues > 0

ORACLE_SID=\${1:?Usage: temp_monitor.sh ORACLE_SID}
export ORACLE_SID
ORACLE_HOME=\${ORACLE_HOME:-/u01/app/oracle/product/19.0.0/dbhome_1}
export ORACLE_HOME
PATH=\${ORACLE_HOME}/bin:\${PATH}
export PATH
LD_LIBRARY_PATH=\${ORACLE_HOME}/lib:\${LD_LIBRARY_PATH:-}
export LD_LIBRARY_PATH

SCRIPT_DIR=/u01/app/oracle/scripts/temp_monitor
LOG_DIR=\${SCRIPT_DIR}/logs
TIMESTAMP=\$(date +%Y%m%d_%H%M%S)
LOG_FILE=\${LOG_DIR}/temp_\${ORACLE_SID}_\${TIMESTAMP}.log
ALERT_EMAIL=dba-alerts@example.com

# Configurable thresholds
TEMP_USAGE_WARN_PCT=85
SESSION_TEMP_WARN_GB=5
PGA_CACHE_HIT_WARN_PCT=80

ISSUES=0

mkdir -p "\${LOG_DIR}"

log() {
  echo "[\$(date '+%Y-%m-%d %H:%M:%S')] \${*}" | tee -a "\${LOG_FILE}"
}

log "=== Temp Tablespace Monitor: \${ORACLE_SID} ==="
log "Oracle Home: \${ORACLE_HOME}"
log "Thresholds: temp_usage_warn=\${TEMP_USAGE_WARN_PCT}% session_temp_warn=\${SESSION_TEMP_WARN_GB}GB pga_cache_hit_warn=\${PGA_CACHE_HIT_WARN_PCT}%"

# --- Check 1: Temp tablespace usage > TEMP_USAGE_WARN_PCT ---
log "--- Check 1: Temp tablespace space usage ---"
TEMP_SPACE_RESULT=\$(sqlplus -s / as sysdba <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF VERIFY OFF HEADING OFF TRIMSPOOL ON LINESIZE 200
SELECT tablespace_name || '|' ||
       round(tablespace_size / 1073741824, 2) || '|' ||
       round(free_space / 1073741824, 2) || '|' ||
       round((1 - free_space / nullif(tablespace_size, 0)) * 100, 1)
FROM dba_temp_free_space
ORDER BY tablespace_name;
EXIT;
SQLEOF
)

if [ -z "\${TEMP_SPACE_RESULT}" ]; then
  log "ERROR: Could not query DBA_TEMP_FREE_SPACE — check DB connectivity and DBA role"
  ISSUES=\$((ISSUES + 1))
else
  while IFS='|' read -r TS_NAME TOTAL_GB FREE_GB PCT_USED; do
    TS_NAME=\$(echo "\${TS_NAME}" | tr -d ' ')
    TOTAL_GB=\$(echo "\${TOTAL_GB}" | tr -d ' ')
    FREE_GB=\$(echo "\${FREE_GB}" | tr -d ' ')
    PCT_USED=\$(echo "\${PCT_USED}" | tr -d ' ')
    if [ -n "\${TS_NAME}" ]; then
      log "Temp tablespace \${TS_NAME}: total=\${TOTAL_GB}GB free=\${FREE_GB}GB used=\${PCT_USED}%"
      PCT_INT=\$(echo "\${PCT_USED}" | awk '{printf "%d", \$1}')
      if [ "\${PCT_INT}" -gt "\${TEMP_USAGE_WARN_PCT}" ] 2>/dev/null; then
        log "WARNING: Temp tablespace \${TS_NAME} is \${PCT_USED}% used (threshold: \${TEMP_USAGE_WARN_PCT}%) — consider adding a tempfile"
        ISSUES=\$((ISSUES + 1))
      else
        log "OK: Temp tablespace \${TS_NAME} usage within threshold (\${PCT_USED}%)"
      fi
    fi
  done <<< "\${TEMP_SPACE_RESULT}"
fi

# --- Check 2: Any single session using > SESSION_TEMP_WARN_GB of temp ---
log "--- Check 2: Per-session temp usage ---"
SESSION_TEMP_RESULT=\$(sqlplus -s / as sysdba <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF VERIFY OFF HEADING OFF TRIMSPOOL ON LINESIZE 300
SELECT s.sid || '|' || s.serial# || '|' || s.username || '|' || s.sql_id || '|' ||
       round(u.blocks * 8192 / 1073741824, 3)
FROM v\$tempseg_usage u
JOIN v\$session s ON s.saddr = u.session_addr
WHERE round(u.blocks * 8192 / 1073741824, 3) > 0
ORDER BY u.blocks DESC
FETCH FIRST 10 ROWS ONLY;
EXIT;
SQLEOF
)

if [ -z "\${SESSION_TEMP_RESULT}" ]; then
  log "OK: No sessions currently using temp space"
else
  FOUND_LARGE_SESSION=0
  while IFS='|' read -r SID SERIAL UNAME SQL_ID TEMP_GB; do
    SID=\$(echo "\${SID}" | tr -d ' ')
    SERIAL=\$(echo "\${SERIAL}" | tr -d ' ')
    UNAME=\$(echo "\${UNAME}" | tr -d ' ')
    SQL_ID=\$(echo "\${SQL_ID}" | tr -d ' ')
    TEMP_GB=\$(echo "\${TEMP_GB}" | tr -d ' ')
    if [ -n "\${SID}" ]; then
      log "Session SID=\${SID} SERIAL=\${SERIAL} USER=\${UNAME} SQL_ID=\${SQL_ID} temp=\${TEMP_GB}GB"
      EXCEEDS=\$(awk "BEGIN { print (\${TEMP_GB} > \${SESSION_TEMP_WARN_GB}) ? 1 : 0 }" 2>/dev/null)
      if [ "\${EXCEEDS}" = "1" ]; then
        log "WARNING: Session SID=\${SID} (user=\${UNAME}, sql_id=\${SQL_ID}) is using \${TEMP_GB}GB of temp (threshold: \${SESSION_TEMP_WARN_GB}GB)"
        ISSUES=\$((ISSUES + 1))
        FOUND_LARGE_SESSION=1
      fi
    fi
  done <<< "\${SESSION_TEMP_RESULT}"
  if [ "\${FOUND_LARGE_SESSION}" = "0" ]; then
    log "OK: No sessions exceed the \${SESSION_TEMP_WARN_GB}GB per-session temp threshold"
  fi
fi

# --- Check 3: PGA cache hit percentage < PGA_CACHE_HIT_WARN_PCT ---
log "--- Check 3: PGA cache hit percentage ---"
PGA_RESULT=\$(sqlplus -s / as sysdba <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF VERIFY OFF HEADING OFF TRIMSPOOL ON LINESIZE 200
SELECT round(value, 1)
FROM v\$pgastat
WHERE name = 'cache hit percentage';
EXIT;
SQLEOF
)

PGA_HIT_PCT=\$(echo "\${PGA_RESULT}" | tr -d ' \n')
if [ -z "\${PGA_HIT_PCT}" ]; then
  log "ERROR: Could not query V\$PGASTAT for cache hit percentage"
  ISSUES=\$((ISSUES + 1))
else
  log "PGA cache hit percentage: \${PGA_HIT_PCT}%"
  BELOW=\$(awk "BEGIN { print (\${PGA_HIT_PCT} < \${PGA_CACHE_HIT_WARN_PCT}) ? 1 : 0 }" 2>/dev/null)
  if [ "\${BELOW}" = "1" ]; then
    log "WARNING: PGA cache hit percentage \${PGA_HIT_PCT}% is below threshold \${PGA_CACHE_HIT_WARN_PCT}% — consider increasing PGA_AGGREGATE_TARGET to reduce temp spill"
    ISSUES=\$((ISSUES + 1))
  else
    log "OK: PGA cache hit percentage \${PGA_HIT_PCT}% is above threshold"
  fi
fi

# --- Check 4: MULTI PASS operations in V$SQL_WORKAREA ---
log "--- Check 4: MULTI PASS work area operations ---"
MULTIPASS_RESULT=\$(sqlplus -s / as sysdba <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF VERIFY OFF HEADING OFF TRIMSPOOL ON LINESIZE 200
SELECT count(*)
FROM v\$sql_workarea
WHERE last_execution = 'MULTI PASS';
EXIT;
SQLEOF
)

MULTIPASS_COUNT=\$(echo "\${MULTIPASS_RESULT}" | tr -d ' \n')
if [ -z "\${MULTIPASS_COUNT}" ]; then
  log "ERROR: Could not query V\$SQL_WORKAREA"
  ISSUES=\$((ISSUES + 1))
else
  log "MULTI PASS work area operations (cursor cache): \${MULTIPASS_COUNT}"
  if [ "\${MULTIPASS_COUNT}" -gt 0 ] 2>/dev/null; then
    log "WARNING: \${MULTIPASS_COUNT} SQL work area(s) have MULTI PASS as their last execution mode — severely undersized work areas detected; review V\$SQL_WORKAREA and increase PGA_AGGREGATE_TARGET"
    ISSUES=\$((ISSUES + 1))
  else
    log "OK: No MULTI PASS work area operations found in cursor cache"
  fi
fi

# --- Summary and alerting ---
log "=== Summary: \${ISSUES} issue(s) detected for \${ORACLE_SID} ==="

if [ "\${ISSUES}" -gt 0 ]; then
  log "Sending alert email to \${ALERT_EMAIL}"
  SUBJECT="[TEMP ALERT] \${ORACLE_SID}: \${ISSUES} issue(s) detected on \$(hostname)"
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
*/10  *  *  *  *  /u01/app/oracle/scripts/temp_monitor/temp_monitor.sh PRODDB >> /u01/app/oracle/scripts/temp_monitor/logs/cron_temp.log 2>&1
\`\`\`

The script runs every 10 minutes. Each execution writes a timestamped log file under \`/u01/app/oracle/scripts/temp_monitor/logs/\` named \`temp_ORACLE_SID_YYYYMMDD_HHMMSS.log\`. The crontab \`>>\` redirect captures any pre-connection errors (ORACLE_HOME misconfiguration, tns errors) that would not appear in the main log. The exit code equals the total number of issues detected across all four checks, making the script directly usable with Nagios/Icinga via a \`check_nrpe\` command definition.

To test manually:

\`\`\`bash
/u01/app/oracle/scripts/temp_monitor/temp_monitor.sh PRODDB
echo "Exit code: \$?"
\`\`\`

---

## Quick Reference

### Key Views

| View | Purpose |
|---|---|
| \`DBA_TEMP_FREE_SPACE\` | Current free/used per temp tablespace — fastest health check |
| \`V\$TEMPSEG_USAGE\` | Active temp allocations by session: blocks, segtype, session address |
| \`V\$SORT_SEGMENT\` | Sort segment pool state and peak usage high-water mark (MAX_USED_BLOCKS) |
| \`V\$SQL_WORKAREA\` | Per-SQL work area: OPTIMAL / ONE PASS / MULTI PASS, estimated optimal size |
| \`V\$PGASTAT\` | PGA aggregate stats: cache hit %, total inuse, max allocated |
| \`DBA_HIST_PGASTAT\` | AWR history of PGA metrics for trend analysis |
| \`DBA_TEMP_FILES\` | Temp datafiles, autoextend settings, and MAXSIZE |
| \`CDB_TEMP_FREE_SPACE\` | Cross-PDB view of temp space usage (query from CDB\$ROOT) |

### Key Parameters

| Parameter | Default | Purpose |
|---|---|---|
| \`PGA_AGGREGATE_TARGET\` | system-calculated | Total PGA target; increase to reduce temp spill |
| \`PGA_AGGREGATE_LIMIT\` | 2x PGA_AGGREGATE_TARGET | Hard PGA ceiling (12c+); prevents OS memory exhaustion |
| \`WORKAREA_SIZE_POLICY\` | \`AUTO\` | Enables automatic PGA work area management |
| \`SORT_AREA_SIZE\` | 65536 | Per-process sort area (legacy MANUAL mode only) |
| \`HASH_AREA_SIZE\` | 2x SORT_AREA_SIZE | Per-process hash area (legacy MANUAL mode only) |

### ORA-01652 Priority Checklist

1. Add a temp datafile immediately (Step 3.4) — buys time while the root cause is investigated
2. Identify the offending session via \`V\$TEMPSEG_USAGE\` (Step 3.1) — get the \`sql_id\`
3. Review the SQL (Step 3.2) for missing predicates, Cartesian joins, or unbounded result sets
4. Kill runaway session if necessary (Step 3.5) — confirm with application owner first
5. Check temp datafile autoextend and MAXSIZE settings (Phase 0 Step 0.2) — ensure files can grow
6. Increase \`PGA_AGGREGATE_TARGET\` to reduce future temp spill (Step 4.4)
7. Review \`V\$SQL_WORKAREA\` for MULTI PASS operations (Phase 2 Step 2.2) — address the worst offenders
8. Resize temp tablespace to cover peak HWM from \`V\$SORT_SEGMENT\` (\`max_used_blocks\`) × 1.5`,
};

async function main() {
  console.log('Inserting Oracle Temp Tablespace runbook post...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: { ...post },
  });
  console.log('Inserted: "' + post.title + '"');
}

main().catch(console.error);
