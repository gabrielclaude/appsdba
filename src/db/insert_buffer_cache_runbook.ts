import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Buffer Cache Monitoring, Tuning, and Hot Block Diagnosis',
  slug: 'oracle-buffer-cache-monitoring-tuning-runbook',
  excerpt:
    'A step-by-step production runbook for Oracle buffer cache diagnosis and tuning — covering configuration audit, V$DB_CACHE_ADVICE sizing analysis, physical I/O wait decomposition, hot block identification via P1/P2 and V$BH, buffer pool assignment changes, and an automated monitoring shell script with Nagios-compatible exit codes.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-05'),
  youtubeUrl: null,
  content: `## Overview

This runbook covers systematic Oracle buffer cache diagnosis, tuning, and monitoring. All steps assume Oracle 12.2 or later, a DBA or SYSDBA-privileged session, and the Oracle Diagnostics Pack licensed for AWR access (\`DBA_HIST_*\` views). Steps that query \`V$\` views require only DBA privilege and do not require the Diagnostics Pack. Steps referencing \`DBA_HIST_*\` views are clearly marked; skip them and use \`V$\` equivalents in environments without the Diagnostics Pack licence. All SQL is tested on Oracle 12.2, 19c, and 21c. Bind variable substitution placeholders use \`&variable_name\` syntax consistent with SQL*Plus and SQLcl.

---

## Phase 0: Buffer Cache Configuration Audit

### Step 0.1 — Check SGA and Memory Management Parameters

Establishes whether the instance uses AMM (\`MEMORY_TARGET\`), ASMM (\`SGA_TARGET\`), or manual SGA management, and records the current buffer cache allocation.

\`\`\`sql
SELECT name, value, description
FROM v\$parameter
WHERE name IN (
  'sga_target', 'sga_max_size',
  'memory_target', 'memory_max_target',
  'db_cache_size', 'db_keep_cache_size', 'db_recycle_cache_size',
  'db_block_size', 'db_file_multiblock_read_count'
)
ORDER BY name;
\`\`\`

Interpretation: if \`memory_target > 0\`, AMM is active. If \`sga_target > 0\` and \`memory_target = 0\`, ASMM is active. If both are 0, SGA is manually managed. Record the \`db_cache_size\` value — in ASMM mode this is the minimum floor, not necessarily the current size.

### Step 0.2 — Current Buffer Pool Sizes and Utilisation

Shows all three buffer pools with current size, hit ratio, and key wait counts.

\`\`\`sql
SELECT name,
       block_size,
       round(buffers * block_size / 1073741824, 2)                               AS size_gb,
       round(
         physical_reads
         / nullif(db_block_gets + consistent_gets, 0)
         * 100, 4
       )                                                                          AS miss_pct,
       db_block_gets,
       consistent_gets,
       physical_reads,
       free_buffer_wait,
       write_complete_wait,
       buffer_busy_wait
FROM v\$buffer_pool_statistics
ORDER BY name;
\`\`\`

Interpretation: \`miss_pct\` above 10% for the DEFAULT pool is a warning. Non-zero \`free_buffer_wait\` indicates DBWR cannot recycle dirty buffers fast enough. Non-zero \`buffer_busy_wait\` on any pool warrants Phase 3 investigation.

### Step 0.3 — Buffer Cache Hit Ratio (Instance Lifetime)

Calculates the overall buffer cache hit ratio since instance startup.

\`\`\`sql
SELECT round(
         (1 - sum(CASE WHEN name = 'physical reads' THEN value END)
              / nullif(sum(CASE WHEN name IN ('db block gets', 'consistent gets') THEN value END), 0)
         ) * 100, 4
       ) AS buffer_cache_hit_pct
FROM v\$sysstat
WHERE name IN ('physical reads', 'db block gets', 'consistent gets');
\`\`\`

Note: this is a since-startup cumulative average. A hit ratio above 90% is generally healthy for OLTP. Below 90% suggests working set exceeds cache size or excessive scan activity. Always cross-reference with physical I/O wait times in Phase 2 before drawing conclusions.

### Step 0.4 — SGA Component Current Sizes

Shows each SGA component's current, minimum, maximum, and user-specified sizes under ASMM.

\`\`\`sql
SELECT component,
       round(current_size     / 1073741824, 2) AS current_gb,
       round(min_size         / 1073741824, 2) AS min_gb,
       round(max_size         / 1073741824, 2) AS max_gb,
       round(user_specified_size / 1073741824, 2) AS user_specified_gb
FROM v\$sga_dynamic_components
ORDER BY current_size DESC;
\`\`\`

Interpretation: if the buffer cache \`current_gb\` equals \`min_gb\`, Oracle is unable to grow it further — either \`SGA_TARGET\` is fully allocated among other components, or the buffer cache is at its floor. If \`current_gb\` is well above \`min_gb\`, Oracle has been actively managing it upward, which is normal and healthy.

---

## Phase 1: Buffer Cache Sizing Analysis

### Step 1.1 — V$DB_CACHE_ADVICE: Optimal Cache Size Recommendation

The primary sizing tool. Shows estimated physical reads at each hypothetical cache size from 10% to 200% of current size. Requires \`DB_CACHE_ADVICE = ON\` (the default in 11g+).

\`\`\`sql
SELECT size_for_estimate                                                AS cache_mb,
       buffers_for_estimate                                             AS buffers,
       estd_physical_read_factor                                        AS phys_read_factor,
       estd_physical_reads,
       round((1 - estd_physical_read_factor) * 100, 2)                 AS pct_improvement_vs_current
FROM v\$db_cache_advice
WHERE name       = 'DEFAULT'
  AND block_size = (SELECT to_number(value) FROM v\$parameter WHERE name = 'db_block_size')
  AND advice_status = 'ON'
ORDER BY size_for_estimate;
-- Look for the 'knee': the cache_mb where estd_physical_read_factor stops dropping sharply
-- Values below 1.0 mean fewer reads than current (current cache is too small for that size to matter)
-- The knee of the curve is the optimal sizing point
\`\`\`

Interpretation: find the row where \`phys_read_factor\` transitions from rapid decline to flat/slow decline. That \`cache_mb\` value is the knee. Size the buffer cache to the knee value plus 20–25% headroom. If the curve is already flat from the smallest size shown, the current cache is larger than necessary.

### Step 1.2 — Recent SGA Resize Operations

Shows the last 20 ASMM-driven resize operations to understand how Oracle has been redistributing SGA memory.

\`\`\`sql
SELECT component,
       oper_type,
       oper_mode,
       round(initial_size / 1073741824, 2) AS initial_gb,
       round(final_size   / 1073741824, 2) AS final_gb,
       round(target_size  / 1073741824, 2) AS target_gb,
       status,
       start_time,
       end_time
FROM v\$memory_resize_ops
ORDER BY start_time DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

Interpretation: repeated shrinking of the buffer cache (oper_type = 'SHRINK') to benefit the shared pool indicates library cache pressure — the buffer cache floor may be too low for the number of cursors the workload requires. Repeated GROW operations on the buffer cache indicate the working set is expanding.

### Step 1.3 — Buffer Cache Hit Ratio Trend from AWR (Diagnostics Pack Required)

Shows hit ratio per AWR snapshot interval for the past 7 days — 48 most recent intervals displayed.

\`\`\`sql
SELECT s.begin_interval_time,
       round(
         (1 - (e.physical_reads_delta
               / nullif(e.db_block_gets_delta + e.consistent_gets_delta, 0))
         ) * 100, 2
       )                                                                AS hit_pct,
       e.physical_reads_delta                                           AS physical_reads,
       e.db_block_gets_delta + e.consistent_gets_delta                  AS logical_reads
FROM dba_hist_buffer_pool_stat e
JOIN dba_hist_snapshot s
  ON s.snap_id = e.snap_id
 AND s.dbid    = e.dbid
 AND s.instance_number = e.instance_number
WHERE s.begin_interval_time > sysdate - 7
  AND e.name = 'DEFAULT'
ORDER BY s.begin_interval_time DESC
FETCH FIRST 48 ROWS ONLY;
\`\`\`

Interpretation: look for patterns — hit ratio degrading in a predictable window (batch job start time) and recovering afterward is classic scan pollution. Sustained degradation indicates the working set has grown beyond the cache. Sudden one-time degradation followed by recovery may indicate a warm-up after instance restart.

---

## Phase 2: Physical I/O Wait Analysis

### Step 2.1 — Average I/O Wait Times for Cache Miss Events

Shows the most important physical I/O wait events with average and total wait times.

\`\`\`sql
SELECT event,
       total_waits,
       round(time_waited / 100.0 / nullif(total_waits, 0), 4) AS avg_wait_sec,
       round(time_waited / 100.0, 2)                           AS total_wait_sec
FROM v\$system_event
WHERE event IN (
  'db file sequential read',
  'db file scattered read',
  'db file parallel read',
  'direct path read',
  'direct path read temp'
)
ORDER BY time_waited DESC;
\`\`\`

Thresholds: \`db file sequential read\` avg_wait_sec > 0.005 (5 ms) on SAN or > 0.001 (1 ms) on NVMe/flash warrants investigation. High \`direct path read\` with low \`db file scattered read\` confirms large scans are bypassing the cache correctly. High \`db file scattered read\` with cache hit ratio below 90% indicates scan pollution filling the cache.

### Step 2.2 — Top SQL by Physical Reads (Cache Miss Drivers)

Identifies the SQL statements responsible for the most physical reads — the primary cache miss drivers.

\`\`\`sql
SELECT sql_id,
       executions,
       round(elapsed_time / 1e6, 2)                                         AS elapsed_sec,
       disk_reads,
       round(disk_reads   / nullif(executions, 0), 0)                       AS disk_reads_per_exec,
       buffer_gets,
       round(buffer_gets  / nullif(executions, 0), 0)                       AS buffer_gets_per_exec,
       round(disk_reads * 100.0 / nullif(buffer_gets + disk_reads, 0), 2)   AS miss_pct,
       substr(sql_text, 1, 80)                                               AS sql_text
FROM v\$sql
WHERE executions > 0
  AND disk_reads  > 1000
ORDER BY disk_reads DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

Interpretation: high \`disk_reads_per_exec\` on a frequently executing SQL (high \`executions\`) is the worst combination — it means many executions each causing many physical reads. Consider adding an index, assigning the scanned table to the RECYCLE pool, or investigating whether the SQL plan is suboptimal.

### Step 2.3 — Top Segments Causing Physical I/O from AWR (Diagnostics Pack Required)

Identifies the database segments generating the most physical reads in a given AWR interval.

\`\`\`sql
SELECT o.object_name,
       o.object_type,
       o.tablespace_name,
       sum(s.physical_reads_delta)                                            AS physical_reads,
       sum(s.logical_reads_delta)                                             AS logical_reads,
       round(
         sum(s.physical_reads_delta) * 100.0
         / nullif(sum(s.logical_reads_delta), 0), 2
       )                                                                      AS miss_pct
FROM dba_hist_seg_stat s
JOIN dba_hist_seg_stat_obj o
  ON o.obj#  = s.obj#
 AND o.dbid  = s.dbid
WHERE s.snap_id BETWEEN &start_snap AND &end_snap
GROUP BY o.object_name, o.object_type, o.tablespace_name
ORDER BY sum(s.physical_reads_delta) DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

Use this to identify which specific tables and indexes are driving physical I/O. A large table with a high miss_pct and no RECYCLE pool assignment is a candidate for \`ALTER TABLE ... STORAGE (BUFFER_POOL RECYCLE)\`. A critical index with high miss_pct is a candidate for \`ALTER INDEX ... STORAGE (BUFFER_POOL KEEP)\`.

---

## Phase 3: Hot Block and Buffer Busy Wait Diagnosis

### Step 3.1 — Current Buffer Busy Waits and Related Events

Establishes whether hot block contention is present and at what scale.

\`\`\`sql
SELECT event,
       total_waits,
       round(time_waited / 100.0, 2)                         AS total_sec,
       round(time_waited / 100.0 / nullif(total_waits, 0), 4) AS avg_sec
FROM v\$system_event
WHERE event IN (
  'buffer busy waits',
  'read by other session',
  'latch: cache buffers chains'
)
ORDER BY time_waited DESC;
\`\`\`

Interpretation: \`buffer busy waits\` with avg_sec > 0.01 (10 ms) and total_waits in the thousands indicates a significant hot block problem. \`latch: cache buffers chains\` appearing at all is a strong signal of a single extremely hot block (sequence cache block or index root block accessed thousands of times per second). \`read by other session\` is typically caused by many parallel sessions all needing the same cold block simultaneously.

### Step 3.2 — Find the Hot Block: P1/P2 from Active Sessions

Captures the file number and block number of currently-hot blocks from sessions actively waiting.

\`\`\`sql
SELECT s.sid,
       s.event,
       s.p1                AS file_num,
       s.p2                AS block_num,
       s.p3                AS reason_code,
       s.seconds_in_wait,
       s.sql_id
FROM v\$session s
WHERE s.event IN ('buffer busy waits', 'read by other session')
ORDER BY s.seconds_in_wait DESC;
\`\`\`

Note the \`file_num\` and \`block_num\` values — they are used in Step 3.3. The \`reason_code\` indicates why the buffer is busy: 1 = another session is reading the block from disk (first read); 200 = another session is modifying the block. If reason_code is predominantly 200, the block is a write-hot contention point (sequence, HWM, or DML-heavy data block).

### Step 3.3 — Map Block Address to Object Name via V$BH

Identifies the owner, object name, and type for a specific hot block.

\`\`\`sql
-- Use file_num and block_num from Step 3.2
SELECT o.owner,
       o.object_name,
       o.object_type,
       o.subobject_name,
       b.status,
       count(*)            AS buffers_in_cache
FROM v\$bh b
JOIN dba_extents e
  ON e.file_id  = b.file#
 AND b.block#  BETWEEN e.block_id AND e.block_id + e.blocks - 1
JOIN dba_objects o
  ON o.object_id = e.object_id
WHERE b.file#   = &file_number
  AND b.block#  = &block_number
GROUP BY o.owner, o.object_name, o.object_type, o.subobject_name, b.status;
\`\`\`

Once the object is identified: if it is a SEQUENCE segment, proceed to Step 3.5. If it is an INDEX, consider KEEP pool assignment or reverse key index. If it is a TABLE and the block is near the HWM, consider ASSM or pre-allocating extents. If it is a small lookup TABLE, assign to KEEP pool.

### Step 3.4 — Find All Hot Blocks for a Specific Object in Cache

Lists all buffers in the cache for a given object, ordered by touch count (hottest first).

\`\`\`sql
SELECT b.file#,
       b.block#,
       b.status,
       b.dirty,
       b.temp,
       b.ping,
       b.stale
FROM v\$bh b
JOIN dba_extents e
  ON e.file_id  = b.file#
 AND b.block#  BETWEEN e.block_id AND e.block_id + e.blocks - 1
WHERE e.owner        = upper('&schema_name')
  AND e.segment_name = upper('&object_name')
ORDER BY b.tch DESC   -- tch = touch count; highest values = hottest blocks
FETCH FIRST 20 ROWS ONLY;
\`\`\`

The \`tch\` column is the touch count. Blocks with very high tch relative to other blocks are the hot blocks. If many blocks of the same object have uniformly high tch, the entire object is heavily accessed and is a strong KEEP pool candidate. If a single block has a tch orders of magnitude higher than all others, that block is an architectural hot block (segment header, sequence block, index root).

### Step 3.5 — Check for Hot Sequence Blocks

Lists sequences with their cache sizes. Low cache size on a high-frequency sequence is the root cause of sequence-driven hot block contention.

\`\`\`sql
SELECT s.sequence_name,
       s.sequence_owner,
       s.cache_size,
       s.last_number,
       s.increment_by,
       s.order_flag,
       s.cycle_flag
FROM dba_sequences s
WHERE s.sequence_owner = upper('&schema_name')
ORDER BY s.cache_size ASC;
-- Sequences with cache_size < 100 on high-frequency INSERT tables are hot block candidates
-- Fix: ALTER SEQUENCE owner.seq_name CACHE 1000;
-- On RAC with ORDER sequences, large cache reduces inter-instance traffic significantly
\`\`\`

Resolution for sequence hot blocks: \`ALTER SEQUENCE &schema_name..&sequence_name CACHE 1000;\` (or higher for very high frequency). For RAC databases, consider removing ORDER from sequences that do not require strict ordering across nodes — ORDER sequences generate inter-node synchronisation traffic for every cache refresh.

---

## Phase 4: Buffer Pool Assignment

### Step 4.1 — List Objects Currently Assigned to KEEP or RECYCLE Pools

Baseline view of the current pool assignment policy.

\`\`\`sql
SELECT owner,
       segment_name,
       segment_type,
       round(bytes / 1048576, 1)   AS size_mb,
       buffer_pool
FROM dba_segments
WHERE buffer_pool != 'DEFAULT'
  AND owner NOT IN ('SYS', 'SYSTEM', 'DBSNMP', 'OUTLN', 'APPQOSSYS')
ORDER BY buffer_pool, bytes DESC;
\`\`\`

### Step 4.2 — Identify Candidates for KEEP Pool (Small, Frequently Accessed)

Lists small objects (under 100 MB) with high logical read rates in the most recent AWR snapshot that are still in the DEFAULT pool.

\`\`\`sql
SELECT o.object_name,
       o.object_type,
       o.owner,
       round(s.bytes / 1048576, 1)    AS size_mb,
       st.logical_reads_delta          AS logical_reads_last_snap,
       s.buffer_pool
FROM dba_hist_seg_stat st
JOIN dba_hist_seg_stat_obj o
  ON o.obj#  = st.obj#
 AND o.dbid  = st.dbid
JOIN dba_segments s
  ON s.segment_name = o.object_name
 AND s.owner        = o.owner
 AND s.segment_type = o.object_type
WHERE st.snap_id = (
        SELECT max(snap_id)
        FROM dba_hist_snapshot
        WHERE begin_interval_time > sysdate - 1
      )
  AND s.bytes       < 100 * 1048576   -- smaller than 100 MB
  AND s.buffer_pool = 'DEFAULT'
  AND o.owner NOT IN ('SYS', 'SYSTEM', 'DBSNMP', 'OUTLN', 'APPQOSSYS')
ORDER BY st.logical_reads_delta DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

Candidates at the top of this list — especially small tables and indexes with extremely high logical read counts relative to their size — are strong KEEP pool candidates. The effective question: "if this object were evicted from cache at peak load, how long would it take to re-warm, and what would the cost be?"

### Step 4.3 — Assign a Table to the KEEP Pool

\`\`\`sql
ALTER TABLE &schema_name..&table_name STORAGE (BUFFER_POOL KEEP);
-- Force the object into the KEEP pool immediately by warming it:
SELECT COUNT(*) FROM &schema_name..&table_name;
-- Verify the assignment:
SELECT segment_name, buffer_pool FROM dba_segments
WHERE owner = upper('&schema_name') AND segment_name = upper('&table_name');
\`\`\`

Note: the KEEP pool must have sufficient \`DB_KEEP_CACHE_SIZE\` to hold all assigned objects. If \`DB_KEEP_CACHE_SIZE\` is 0, this assignment has no effect — set it with Step 5.2 first.

### Step 4.4 — Assign a Large Scan Table to the RECYCLE Pool

\`\`\`sql
ALTER TABLE &schema_name..&large_table STORAGE (BUFFER_POOL RECYCLE);
-- Verify:
SELECT segment_name, buffer_pool FROM dba_segments
WHERE owner = upper('&schema_name') AND segment_name = upper('&large_table');
\`\`\`

### Step 4.5 — Assign an Index to the KEEP Pool

\`\`\`sql
ALTER INDEX &schema_name..&index_name STORAGE (BUFFER_POOL KEEP);
-- Warm the index immediately (range scan to load all branch/root blocks):
SELECT /*+ index(&schema_name..&table_name &index_name) */ COUNT(*)
FROM &schema_name..&table_name
WHERE <indexed_column> IS NOT NULL;
\`\`\`

### Step 4.6 — Revert an Object to DEFAULT Pool

\`\`\`sql
ALTER TABLE &schema_name..&table_name STORAGE (BUFFER_POOL DEFAULT);
-- or for an index:
ALTER INDEX &schema_name..&index_name STORAGE (BUFFER_POOL DEFAULT);
\`\`\`

---

## Phase 5: Cache Sizing and Parameter Changes

### Step 5.1 — Increase DB_CACHE_SIZE (Minimum Floor Under ASMM)

Sets the DEFAULT buffer pool minimum floor. Under ASMM, Oracle grows above this floor as needed but never shrinks below it.

\`\`\`sql
-- Dynamic — takes effect immediately without restart:
ALTER SYSTEM SET db_cache_size = 8G SCOPE = BOTH;
-- Verify:
SELECT component, round(current_size/1073741824,2) AS current_gb,
       round(min_size/1073741824,2) AS min_gb
FROM v\$sga_dynamic_components
WHERE component = 'DEFAULT buffer cache';
\`\`\`

### Step 5.2 — Set KEEP and RECYCLE Pool Sizes

\`\`\`sql
ALTER SYSTEM SET db_keep_cache_size    = 2G   SCOPE = BOTH;
ALTER SYSTEM SET db_recycle_cache_size = 512M SCOPE = BOTH;
-- These are static allocations carved from SGA_TARGET (if set):
SELECT name, value FROM v\$parameter
WHERE name IN ('db_keep_cache_size', 'db_recycle_cache_size');
\`\`\`

### Step 5.3 — Increase SGA_TARGET (ASMM — Let Oracle Auto-Manage Pool Sizes)

\`\`\`sql
ALTER SYSTEM SET sga_target = 24G SCOPE = BOTH;
-- Oracle will redistribute among buffer cache, shared pool, large pool, etc.
-- Monitor v$memory_resize_ops to see redistribution activity
-- Ensure sga_max_size >= new sga_target value (sga_max_size requires restart to change)
SELECT name, value FROM v\$parameter
WHERE name IN ('sga_target', 'sga_max_size');
\`\`\`

### Step 5.4 — Flush Buffer Cache (Testing Only — Never Under Production Load)

\`\`\`sql
-- WARNING: This flushes the ENTIRE buffer cache.
-- All subsequent reads will be physical reads until the cache warms up.
-- ONLY use in a test environment to establish a cold-cache baseline.
-- NEVER run on a production system under load.
ALTER SYSTEM FLUSH BUFFER_CACHE;
\`\`\`

---

## Phase 6: Buffer Cache Monitoring Shell Script

Save as \`/u01/app/oracle/scripts/buffer_cache_monitor/buffer_cache_monitor.sh\`. Make executable with \`chmod 750\`.

\`\`\`bash
#!/bin/bash
# =============================================================================
# buffer_cache_monitor.sh
# Oracle Buffer Cache Health Monitor
# Usage: buffer_cache_monitor.sh <ORACLE_SID>
# Exit code = number of issues found (Nagios-compatible)
# =============================================================================

ORACLE_SID=\${1:?Usage: \$0 <ORACLE_SID>}
export ORACLE_SID

SCRIPT_DIR="/u01/app/oracle/scripts/buffer_cache_monitor"
LOG_DIR="\${SCRIPT_DIR}/logs"
TIMESTAMP=\$(date '+%Y%m%d_%H%M%S')
LOG_FILE="\${LOG_DIR}/bc_\${ORACLE_SID}_\${TIMESTAMP}.log"
ALERT_EMAIL="dba-alerts@example.com"
ISSUES=0
ISSUE_SUMMARY=""

# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------
mkdir -p "\${LOG_DIR}"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] \$*" | tee -a "\${LOG_FILE}"
}

issue() {
  ISSUES=\$((ISSUES + 1))
  ISSUE_SUMMARY="\${ISSUE_SUMMARY}\n[ISSUE \${ISSUES}] \$*"
  log "ISSUE \${ISSUES}: \$*"
}

ok() {
  log "OK: \$*"
}

# ---------------------------------------------------------------------------
# Oracle environment
# ---------------------------------------------------------------------------
if [ -f /etc/oratab ]; then
  ORACLE_HOME=\$(grep "^\${ORACLE_SID}:" /etc/oratab | cut -d: -f2)
  if [ -z "\${ORACLE_HOME}" ]; then
    log "ERROR: ORACLE_SID '\${ORACLE_SID}' not found in /etc/oratab"
    exit 1
  fi
  export ORACLE_HOME
  export PATH="\${ORACLE_HOME}/bin:\${PATH}"
  export LD_LIBRARY_PATH="\${ORACLE_HOME}/lib:\${LD_LIBRARY_PATH}"
fi

log "=== Buffer Cache Monitor: \${ORACLE_SID} ==="
log "Oracle Home: \${ORACLE_HOME}"

SQLPLUS="\${ORACLE_HOME}/bin/sqlplus"

# ---------------------------------------------------------------------------
# Check 1: DEFAULT pool hit ratio
# ---------------------------------------------------------------------------
log "--- Check 1: DEFAULT pool hit ratio ---"

HIT_RATIO=\$("\${SQLPLUS}" -s / as sysdba <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF VERIFY OFF TRIMSPOOL ON
SELECT to_char(round(
         physical_reads
         / nullif(db_block_gets + consistent_gets, 0)
         * 100, 4
       ))
FROM v\$buffer_pool_statistics
WHERE name = 'DEFAULT';
EXIT;
SQLEOF
)

HIT_RATIO=\$(echo "\${HIT_RATIO}" | tr -d '[:space:]')
MISS_PCT=\${HIT_RATIO:-0}

if [ -z "\${MISS_PCT}" ] || [ "\${MISS_PCT}" = "" ]; then
  issue "Could not read DEFAULT pool miss rate from V\$BUFFER_POOL_STATISTICS"
else
  MISS_INT=\$(echo "\${MISS_PCT}" | awk '{printf "%d", \$1 * 100}')
  if [ "\${MISS_INT}" -gt 1000 ]; then   # > 10.00%
    issue "DEFAULT pool miss rate \${MISS_PCT}% exceeds 10% threshold"
  else
    ok "DEFAULT pool miss rate \${MISS_PCT}% is within threshold"
  fi
fi

# ---------------------------------------------------------------------------
# Check 2: buffer busy waits — average wait time and volume
# ---------------------------------------------------------------------------
log "--- Check 2: buffer busy waits ---"

BBW_RESULT=\$("\${SQLPLUS}" -s / as sysdba <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF VERIFY OFF TRIMSPOOL ON
SELECT to_char(round(time_waited / 100.0 / nullif(total_waits,0), 4))
       || '|' ||
       to_char(total_waits)
FROM v\$system_event
WHERE event = 'buffer busy waits';
EXIT;
SQLEOF
)

BBW_RESULT=\$(echo "\${BBW_RESULT}" | tr -d '[:space:]')
BBW_AVG=\$(echo "\${BBW_RESULT}" | cut -d'|' -f1)
BBW_TOTAL=\$(echo "\${BBW_RESULT}" | cut -d'|' -f2)

if [ -n "\${BBW_AVG}" ]; then
  BBW_AVG_MS=\$(echo "\${BBW_AVG}" | awk '{printf "%d", \$1 * 1000}')
  if [ "\${BBW_AVG_MS}" -gt 10 ]; then
    issue "buffer busy waits avg \${BBW_AVG}s exceeds 10ms threshold (total_waits=\${BBW_TOTAL})"
  else
    ok "buffer busy waits avg \${BBW_AVG}s is within threshold"
  fi
  BBW_TOTAL_INT=\${BBW_TOTAL:-0}
  if [ "\${BBW_TOTAL_INT}" -gt 1000000 ]; then
    issue "buffer busy waits total count \${BBW_TOTAL} is very high — hot block contention likely"
  fi
else
  ok "No buffer busy waits recorded"
fi

# ---------------------------------------------------------------------------
# Check 3: db file sequential read — average wait time
# ---------------------------------------------------------------------------
log "--- Check 3: db file sequential read average wait time ---"

DFSR_AVG=\$("\${SQLPLUS}" -s / as sysdba <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF VERIFY OFF TRIMSPOOL ON
SELECT to_char(round(time_waited / 100.0 / nullif(total_waits,0), 4))
FROM v\$system_event
WHERE event = 'db file sequential read';
EXIT;
SQLEOF
)

DFSR_AVG=\$(echo "\${DFSR_AVG}" | tr -d '[:space:]')

if [ -n "\${DFSR_AVG}" ]; then
  DFSR_MS=\$(echo "\${DFSR_AVG}" | awk '{printf "%d", \$1 * 1000}')
  if [ "\${DFSR_MS}" -gt 5 ]; then
    issue "db file sequential read avg \${DFSR_AVG}s exceeds 5ms threshold — check storage I/O latency"
  else
    ok "db file sequential read avg \${DFSR_AVG}s is within threshold"
  fi
else
  ok "No db file sequential read events recorded"
fi

# ---------------------------------------------------------------------------
# Check 4: V$DB_CACHE_ADVICE — would doubling the cache reduce reads by > 20%?
# ---------------------------------------------------------------------------
log "--- Check 4: cache sizing adequacy via V\$DB_CACHE_ADVICE ---"

CACHE_ADVICE=\$("\${SQLPLUS}" -s / as sysdba <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF VERIFY OFF TRIMSPOOL ON
-- Compare current size bucket vs the bucket closest to 2x current size
-- If the 2x bucket reduces physical_read_factor by more than 20%, cache is undersized
SELECT to_char(round((1 - a.estd_physical_read_factor) * 100, 2))
FROM v\$db_cache_advice a
WHERE a.name       = 'DEFAULT'
  AND a.advice_status = 'ON'
  AND a.block_size = (SELECT to_number(value) FROM v\$parameter WHERE name = 'db_block_size')
  AND a.size_for_estimate = (
        -- Find the bucket closest to 2x the current cache size
        SELECT MIN(b.size_for_estimate)
        FROM v\$db_cache_advice b
        WHERE b.name       = 'DEFAULT'
          AND b.advice_status = 'ON'
          AND b.block_size = (SELECT to_number(value) FROM v\$parameter WHERE name = 'db_block_size')
          AND b.size_for_estimate >= (
                SELECT ROUND(c.size_for_estimate * 2 / 10) * 10
                FROM v\$db_cache_advice c
                WHERE c.name        = 'DEFAULT'
                  AND c.advice_status = 'ON'
                  AND c.block_size   = (SELECT to_number(value) FROM v\$parameter WHERE name = 'db_block_size')
                  AND c.estd_physical_read_factor BETWEEN 0.95 AND 1.05
                  AND ROWNUM = 1
              )
      );
EXIT;
SQLEOF
)

CACHE_ADVICE=\$(echo "\${CACHE_ADVICE}" | tr -d '[:space:]')

if [ -n "\${CACHE_ADVICE}" ]; then
  ADVICE_INT=\$(echo "\${CACHE_ADVICE}" | awk '{printf "%d", \$1 * 100}')
  if [ "\${ADVICE_INT}" -gt 2000 ]; then  # > 20.00%
    issue "V\$DB_CACHE_ADVICE: doubling the buffer cache would reduce physical reads by \${CACHE_ADVICE}% — cache is undersized"
  else
    ok "V\$DB_CACHE_ADVICE: doubling the cache would change physical reads by \${CACHE_ADVICE}% — cache size is adequate"
  fi
else
  ok "V\$DB_CACHE_ADVICE: no advice data available (possibly insufficient runtime since startup)"
fi

# ---------------------------------------------------------------------------
# Check 5: Is buffer cache at its ASMM minimum? (memory pressure indicator)
# ---------------------------------------------------------------------------
log "--- Check 5: buffer cache at ASMM minimum (memory pressure) ---"

AT_MIN=\$("\${SQLPLUS}" -s / as sysdba <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF VERIFY OFF TRIMSPOOL ON
SELECT CASE
         WHEN current_size <= min_size + 16 * 1048576
         THEN 'AT_MIN'
         ELSE 'OK'
       END
FROM v\$sga_dynamic_components
WHERE component = 'DEFAULT buffer cache';
EXIT;
SQLEOF
)

AT_MIN=\$(echo "\${AT_MIN}" | tr -d '[:space:]')

if [ "\${AT_MIN}" = "AT_MIN" ]; then
  issue "Buffer cache is at its ASMM minimum size — Oracle is under SGA memory pressure. Consider increasing SGA_TARGET or DB_CACHE_SIZE floor."
else
  ok "Buffer cache is above its ASMM minimum — no immediate memory pressure detected"
fi

# ---------------------------------------------------------------------------
# Summary and alerting
# ---------------------------------------------------------------------------
log "=== Summary: \${ISSUES} issue(s) found ==="

if [ "\${ISSUES}" -gt 0 ]; then
  log "\${ISSUE_SUMMARY}"
  SUBJECT="[ALERT] Oracle Buffer Cache: \${ISSUES} issue(s) on \${ORACLE_SID}"
  BODY="Buffer Cache Monitor Alert\nHost: \$(hostname)\nSID: \${ORACLE_SID}\nTime: \$(date)\n\nIssues:\n\${ISSUE_SUMMARY}\n\nFull log: \${LOG_FILE}"
  if command -v mailx >/dev/null 2>&1; then
    echo -e "\${BODY}" | mailx -s "\${SUBJECT}" "\${ALERT_EMAIL}"
  elif command -v sendmail >/dev/null 2>&1; then
    echo -e "To: \${ALERT_EMAIL}\nSubject: \${SUBJECT}\n\n\${BODY}" | sendmail -t
  else
    log "WARNING: No mail transport found (mailx/sendmail). Email not sent."
  fi
fi

log "Log: \${LOG_FILE}"
exit \${ISSUES}
\`\`\`

### Crontab Entry (Every 15 Minutes)

Add to the oracle user's crontab with \`crontab -e\`:

\`\`\`
*/15  *  *  *  *  /u01/app/oracle/scripts/buffer_cache_monitor/buffer_cache_monitor.sh PRODDB >> /u01/app/oracle/scripts/buffer_cache_monitor/logs/cron_bc.log 2>&1
\`\`\`

For a RAC environment, deploy the script on each node with the node-specific ORACLE_SID:

\`\`\`
*/15  *  *  *  *  /u01/app/oracle/scripts/buffer_cache_monitor/buffer_cache_monitor.sh PRODDB1 >> /u01/app/oracle/scripts/buffer_cache_monitor/logs/cron_bc.log 2>&1
\`\`\`

---

## Quick Reference

### Key Views

| View | Purpose |
|------|---------|
| \`V\$BUFFER_POOL_STATISTICS\` | Hit ratio and wait counts per pool (DEFAULT/KEEP/RECYCLE) |
| \`V\$DB_CACHE_ADVICE\` | Estimated physical reads at hypothetical cache sizes |
| \`V\$BH\` | Individual buffer headers: file#, block#, touch count (tch), dirty flag |
| \`V\$SYSSTAT\` | Physical reads, logical reads (lifetime cumulative) |
| \`V\$SYSTEM_EVENT\` | Wait event totals and averages (lifetime cumulative) |
| \`V\$SGA_DYNAMIC_COMPONENTS\` | Current/min/max size of each SGA component |
| \`V\$MEMORY_RESIZE_OPS\` | History of ASMM-driven resize operations |
| \`DBA_HIST_BUFFER_POOL_STAT\` | AWR history of buffer pool statistics (Diagnostics Pack) |
| \`DBA_HIST_SEG_STAT\` | AWR segment-level physical/logical read history (Diagnostics Pack) |

### Buffer Pool Assignment Commands

\`\`\`sql
-- Assign to KEEP pool (small, frequently accessed objects):
ALTER TABLE  owner.table_name  STORAGE (BUFFER_POOL KEEP);
ALTER INDEX  owner.index_name  STORAGE (BUFFER_POOL KEEP);

-- Assign to RECYCLE pool (large, infrequently scanned objects):
ALTER TABLE  owner.table_name  STORAGE (BUFFER_POOL RECYCLE);

-- Revert to DEFAULT pool:
ALTER TABLE  owner.table_name  STORAGE (BUFFER_POOL DEFAULT);
ALTER INDEX  owner.index_name  STORAGE (BUFFER_POOL DEFAULT);
\`\`\`

### Key Parameters

| Parameter | Purpose |
|-----------|---------|
| \`DB_CACHE_SIZE\` | DEFAULT buffer pool minimum floor (or static size if SGA_TARGET=0) |
| \`DB_KEEP_CACHE_SIZE\` | KEEP pool static allocation |
| \`DB_RECYCLE_CACHE_SIZE\` | RECYCLE pool static allocation |
| \`SGA_TARGET\` | Total SGA under ASMM (Oracle auto-manages component sizes) |
| \`MEMORY_TARGET\` | Total SGA + PGA under AMM |
| \`DB_CACHE_ADVICE\` | ON/OFF — enables V\$DB_CACHE_ADVICE population |

### Hot Block Resolution Decision Tree

\`\`\`
buffer busy waits or latch: cache buffers chains?
  │
  ├── Step 3.2: Get P1 (file#), P2 (block#)
  │
  ├── Step 3.3: Map to object name via V\$BH
  │
  ├── Object is SEQUENCE SEGMENT?
  │     └── ALTER SEQUENCE ... CACHE 10000;
  │
  ├── Object is INDEX (root/branch block)?
  │     ├── Assign to KEEP pool (Step 4.5)
  │     └── Consider reverse key or hash partitioning
  │
  ├── Object is TABLE SEGMENT HEADER (HWM)?
  │     └── Enable ASSM or pre-allocate extents
  │
  └── Object is TABLE DATA BLOCK (small lookup)?
        └── Assign to KEEP pool (Step 4.3)
\`\`\``,
};

async function main() {
  console.log('Inserting Oracle Buffer Cache Runbook post...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: { ...post },
  });
  console.log('Inserted: "' + post.title + '"');
}

main().catch(console.error);
