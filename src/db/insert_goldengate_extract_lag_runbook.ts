import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: GoldenGate Integrated Extract Lag — Diagnosis, Remediation, and Monitoring',
  slug: 'goldengate-extract-lag-diagnosis-runbook',
  excerpt:
    'A phased operational runbook for diagnosing and remediating GoldenGate Integrated Extract lag caused by ghost transactions and LogMiner internal process contention. Covers complete triage from GGSCI lag confirmation through V\$TRANSACTION cross-reference, LogMiner session analysis, LOGMNR dictionary table health assessment, statistics gather remediation, parallelism and Streams Pool tuning, automated monitoring with DBMS_SCHEDULER and UTL_MAIL alerting, and preventive maintenance schedules.',
  category: 'golden-gate' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-06'),
  youtubeUrl: null,
  content: `This runbook covers GoldenGate Integrated Extract lag caused by ghost transactions and LogMiner internal process contention. Execute phases in order. Verify results at each step before proceeding.

**Assumptions:**
- Oracle Database 12.2 or later with GoldenGate Integrated Extract configured
- GoldenGate 19c or later (GGSCI commands shown)
- Extract name: \`E_PROD\` (substitute your extract name throughout)
- DBA access to both the GoldenGate service host (for GGSCI) and the Oracle database (for SQL)
- UTL_MAIL configured and functional for automated alerting (Phase 8)

---

## Phase 0: Triage — Confirm Lag and Identify the Blocking Transaction

### Step 0.1: Check All Extract Status from GGSCI

Connect to GGSCI on the GoldenGate service host and check the full extract status:

\`\`\`ggsci
-- Show all extracts with detail including lag and checkpoint information
INFO EXTRACT * DETAIL
\`\`\`

Look for:
- **Lag at Chkpt** — time between the Recovery Checkpoint and current time; this is the reported lag
- **Time Since Chkpt** — how long since the last checkpoint write (should be seconds to minutes; if hours, the extract is stalled)
- **Recovery Checkpoint** — the timestamp the extract will restart from; if this is hours or days in the past while **Log Read Checkpoint** is recent, you have a pinned recovery position

Sample output showing a pinned recovery position:

\`\`\`
EXTRACT    E_PROD    Last Started 2026-06-02 11:45   Status RUNNING
Checkpoint Lag       42:17:23 (updated 00:00:04 ago)
Process ID           12847
Log Read Checkpoint  Oracle Integrated Redo Logs
                     2026-06-06 02:28:15
                     Scn 0x0000.15a3f9c2 (364,077,506)
Recovery Checkpoint  Oracle Integrated Redo Logs
                     2026-06-02 11:47:48
                     Scn 0x0000.15891a44 (360,431,172)
\`\`\`

The gap between **Recovery Checkpoint SCN** (360,431,172) and **Log Read Checkpoint SCN** (364,077,506) represents all the redo that must be re-mined on restart. Note both values for use in Phase 6.

### Step 0.2: Identify the Blocking Transaction

\`\`\`ggsci
-- Show all open transactions tracked by the extract
-- This will show transactions that are pinning the Recovery Checkpoint
SEND EXTRACT E_PROD, SHOWTRANS

-- Show only the top 10 by age (oldest first)
SEND EXTRACT E_PROD, SHOWTRANS COUNT 10
\`\`\`

Sample SHOWTRANS output for a ghost transaction:

\`\`\`
Sending SHOWTRANS request to EXTRACT E_PROD ...

XID:          0.446.22.12492469
Items:        0
Extract:      E_PROD
Redo Thread:  1
Start Time:   2026-06-02:11:47:48
Start SCN:    360431172 (0x0000.15891a44)
Status:       Running
\`\`\`

Record the XID components (XIDUSN=0, XIDSLOT=446, XIDSQN=22) for the next step.

### Step 0.3: Cross-Reference the XID Against V\$TRANSACTION

Run in SQL*Plus or SQL Developer against the source database:

\`\`\`sql
-- Confirm whether the transaction reported by GoldenGate still exists in the database
-- Substitute the XID components from SHOWTRANS output
SELECT xidusn,
       xidslot,
       xidsqn,
       start_scn,
       TO_CHAR(start_date, 'YYYY-MM-DD HH24:MI:SS') AS start_time,
       used_ublk,
       used_urec,
       log_io,
       status
FROM v\$transaction
WHERE xidusn = 0        -- XIDUSN from SHOWTRANS
  AND xidslot = 446     -- XIDSLOT from SHOWTRANS
  AND xidsqn = 22;      -- XIDSQN from SHOWTRANS

-- If this returns zero rows: CONFIRMED GHOST TRANSACTION
-- The transaction no longer exists on the database side.
-- GoldenGate's Recovery Checkpoint is pinned by a transaction the database has already closed.
\`\`\`

Zero rows = ghost transaction. The extract saw the BEGIN redo record but the COMMIT/ROLLBACK redo was never delivered by LogMiner (because LogMiner stalled — see Phase 2).

### Step 0.4: Check V\$GOLDENGATE_CAPTURE for Lag Metrics

\`\`\`sql
-- GoldenGate capture statistics from the database side
-- (This view is populated when Integrated Extract is registered)
SELECT capture_name,
       status,
       captured_scn,
       applied_scn,
       required_checkpoint_scn,
       TO_CHAR(capture_time, 'YYYY-MM-DD HH24:MI:SS') AS capture_time,
       lag_time,
       total_messages_captured,
       total_messages_enqueued
FROM v\$goldengate_capture
ORDER BY capture_name;
\`\`\`

The \`lag_time\` in this view is the database's view of the GoldenGate capture lag — it should match the GGSCI lag metric. \`required_checkpoint_scn\` is the minimum SCN that must remain available in the redo log for extract restart; if archive logs older than this SCN have been deleted, the extract cannot restart cleanly.

### Step 0.5: Estimate Redo Volume Between Recovery Checkpoint and Current SCN

This estimate tells you how long a full restart would take and helps size the recovery window:

\`\`\`sql
-- Calculate redo volume between the pinned Recovery Checkpoint SCN and current SCN
-- Substitute the Recovery Checkpoint SCN from INFO EXTRACT DETAIL output
WITH pinned_scn AS (
  SELECT 360431172 AS recovery_scn FROM dual  -- Replace with actual Recovery Checkpoint SCN
),
current_scn AS (
  SELECT current_scn FROM v\$database
)
SELECT
  (SELECT recovery_scn FROM pinned_scn) AS recovery_checkpoint_scn,
  c.current_scn AS current_scn,
  c.current_scn - (SELECT recovery_scn FROM pinned_scn) AS scn_gap,
  -- Redo volume from online logs
  (SELECT ROUND(SUM(blocks * block_size) / 1073741824, 2)
   FROM v\$log
   WHERE first_change# >= (SELECT recovery_scn FROM pinned_scn)) AS online_redo_gb,
  -- Redo volume from archived logs
  (SELECT ROUND(SUM(blocks * block_size) / 1073741824, 2)
   FROM v\$archived_log
   WHERE first_change# >= (SELECT recovery_scn FROM pinned_scn)
     AND standby_dest = 'NO'
     AND deleted = 'NO') AS archived_redo_gb
FROM current_scn c;
\`\`\`

If \`archived_redo_gb\` is NULL or 0 for old SCNs, the archived logs may no longer be on disk. Check with:

\`\`\`sql
-- Confirm archived logs still exist for the recovery window
SELECT name, first_change#, next_change#, archived, deleted,
       ROUND(blocks * block_size / 1073741824, 3) AS size_gb
FROM v\$archived_log
WHERE first_change# <= 360431172  -- Recovery Checkpoint SCN
  AND next_change# >= 360431172
  AND standby_dest = 'NO'
ORDER BY first_change#;
-- If this returns no rows, the required archived log has been deleted.
-- The extract cannot restart from the Recovery Checkpoint SCN.
-- Contact Oracle Support or consider resetting the extract (data loss risk).
\`\`\`

---

## Phase 2: Identify LogMiner Process Contention

### Step 2.1: Core LogMiner Session Monitoring Query

This is the primary diagnostic query. Run it immediately after confirming the ghost transaction:

\`\`\`sql
-- LogMiner background processes (program contains 'MS') that have been active > 15 minutes
SELECT s.sid,
       s.serial#,
       s.program,
       s.event,
       s.status,
       s.last_call_et,
       ROUND(s.last_call_et/60, 2) AS minutes_running,
       s.blocking_session,
       s.blocking_session_status,
       s.sql_id,
       SUBSTR(q.sql_text, 1, 200) AS sql_text_preview
FROM v\$session s
LEFT JOIN v\$sql q ON s.sql_id = q.sql_id
WHERE s.program LIKE '%(MS%'
  AND s.status = 'ACTIVE'
  AND s.last_call_et > 900
ORDER BY s.last_call_et DESC;
\`\`\`

Interpretation:
- **MS00 (Builder)** with high \`last_call_et\` and \`event = 'db file scattered read'\` — Builder is doing full table scans on LogMiner dictionary tables. Root cause is stale statistics.
- **MS01 (Preparer)** with \`event = 'enq: MN - contention'\` and \`blocking_session\` pointing to MS00 — Preparer is blocked by the Builder's MN enqueue. This confirms the full contention chain.
- Any MS process with \`minutes_running > 120\` — Critical threshold; extract lag is growing and will continue growing until the Builder is unblocked.

### Step 2.2: Current Wait Details for LogMiner Processes

\`\`\`sql
-- Current wait event details for all LogMiner processes
SELECT s.sid,
       s.serial#,
       s.program,
       s.status,
       sw.event,
       sw.wait_class,
       sw.state,
       sw.wait_time_micro / 1000000 AS wait_secs,
       sw.p1text, sw.p1,
       sw.p2text, sw.p2,
       sw.p3text, sw.p3
FROM v\$session s
JOIN v\$session_wait sw ON s.sid = sw.sid
WHERE s.program LIKE '%(MS%'
ORDER BY s.program, s.sid;
\`\`\`

For \`db file scattered read\`, P1=file#, P2=block#, P3=blocks — this tells you which file and block range the Builder is scanning.
For \`enq: MN - contention\`, P1 encodes the enqueue type (MN=0x4D4E) and mode requested.

### Step 2.3: Find the Exact SQL the Builder Is Running

\`\`\`sql
-- Identify the specific SQL being executed by the Builder (MS00 process)
-- First find the Builder's SID from Phase 2.1 output (e.g., SID = 245)
SELECT s.sid,
       s.serial#,
       s.program,
       s.sql_id,
       s.sql_child_number,
       q.sql_text,
       qs.executions,
       qs.elapsed_time / 1000000 AS total_elapsed_sec,
       ROUND(qs.elapsed_time / NULLIF(qs.executions, 0) / 1000000, 2) AS avg_elapsed_sec,
       qs.buffer_gets,
       qs.disk_reads
FROM v\$session s
JOIN v\$sql q ON s.sql_id = q.sql_id AND s.sql_child_number = q.child_number
JOIN v\$sqlstats qs ON q.sql_id = qs.sql_id
WHERE s.program LIKE '%(MS00%'
  AND s.status = 'ACTIVE';
\`\`\`

If the SQL references \`SYSTEM.LOGMNRT_MDDL\$\` or \`SYSTEM.LOGMNR_INDPART\$\` and \`disk_reads\` is very high (millions), the Builder is doing full table scans on fragmented LogMiner dictionary tables — stale statistics confirmed.

### Step 2.4: Check for Sessions Holding the MN Enqueue

\`\`\`sql
-- Find all sessions holding or waiting for the MN (LogMiner Management) enqueue
SELECT s.sid,
       s.serial#,
       s.program,
       s.status,
       l.type,
       l.lmode,      -- 0=none, 1=null, 2=row-S, 3=row-X, 4=share, 5=S/Row-X, 6=exclusive
       l.request,    -- mode being requested by waiting sessions
       l.block,      -- 1=this session is blocking others
       l.id1,
       l.id2
FROM v\$lock l
JOIN v\$session s ON l.sid = s.sid
WHERE l.type = 'MN'
ORDER BY l.block DESC, s.program;
\`\`\`

\`lmode = 6\` (exclusive) with \`block = 1\` on the Builder (MS00) confirms it holds the MN enqueue and is blocking the Preparer.

### Step 2.5: Full Blocking Chain for LogMiner Processes

\`\`\`sql
-- Recursive blocking chain starting from LogMiner processes
-- Shows the complete chain: who is blocked, who is blocking them, etc.
WITH RECURSIVE blocker_chain (
  sid, serial#, program, event, blocking_session, depth, chain_path
) AS (
  -- Anchor: LogMiner processes that are being blocked
  SELECT s.sid, s.serial#, s.program, s.event,
         s.blocking_session, 1 AS depth,
         CAST(s.program AS VARCHAR2(4000)) AS chain_path
  FROM v\$session s
  WHERE s.program LIKE '%(MS%'
    AND s.blocking_session IS NOT NULL
  UNION ALL
  -- Recursive: find what is blocking each blocker
  SELECT s.sid, s.serial#, s.program, s.event,
         s.blocking_session, bc.depth + 1,
         bc.chain_path || ' <- ' || s.program
  FROM v\$session s
  JOIN blocker_chain bc ON s.sid = bc.blocking_session
  WHERE bc.depth < 10
)
SELECT * FROM blocker_chain ORDER BY depth, sid;
\`\`\`

---

## Phase 3: Assess LogMiner Dictionary Table Health

### Step 3.1: Statistics Age and Freshness Check

\`\`\`sql
-- Check statistics freshness on all LogMiner-related tables
-- FLAG: last_analyzed > 7 days old OR stale_stats = 'YES'
SELECT owner,
       table_name,
       num_rows,
       blocks,
       avg_row_len,
       TO_CHAR(last_analyzed, 'YYYY-MM-DD HH24:MI') AS last_analyzed,
       ROUND(SYSDATE - last_analyzed, 1) AS days_since_analyzed,
       stale_stats,
       -- Flag tables that need immediate attention
       CASE
         WHEN last_analyzed IS NULL THEN 'CRITICAL: No statistics'
         WHEN SYSDATE - last_analyzed > 14 THEN 'CRITICAL: > 14 days stale'
         WHEN SYSDATE - last_analyzed > 7 THEN 'WARNING: > 7 days stale'
         WHEN stale_stats = 'YES' THEN 'WARNING: Marked stale by Oracle'
         ELSE 'OK'
       END AS health_status
FROM dba_tab_statistics
WHERE table_name LIKE 'LOGMN%'
  AND owner IN ('SYS', 'SYSTEM')
ORDER BY
  CASE
    WHEN last_analyzed IS NULL THEN 0
    WHEN SYSDATE - last_analyzed > 14 THEN 1
    WHEN stale_stats = 'YES' THEN 2
    ELSE 3
  END,
  owner, table_name;
\`\`\`

### Step 3.2: Table Size vs Row Count — Detect Fragmentation

A fragmented table has far more allocated blocks than its row count would justify. This is the signature of a table that experienced a large DELETE or ROLLBACK without a subsequent shrink:

\`\`\`sql
-- Compare actual segment sizes to statistics row counts
-- High block-to-row ratio (> 100:1 for LOGMNR tables) indicates fragmentation
SELECT dt.owner,
       dt.table_name,
       dt.num_rows AS stats_num_rows,
       dt.blocks AS stats_blocks,
       ds.bytes / 8192 AS actual_blocks_8k,
       ds.bytes / 1048576 AS segment_mb,
       CASE
         WHEN dt.num_rows > 0
         THEN ROUND((ds.bytes / 8192) / dt.num_rows, 1)
         ELSE NULL
       END AS blocks_per_row,
       -- Flag suspicious block:row ratios
       CASE
         WHEN dt.num_rows = 0 AND ds.bytes > 1048576 THEN 'FRAGMENTED: 0 rows but > 1MB allocated'
         WHEN dt.num_rows > 0 AND (ds.bytes / 8192) / dt.num_rows > 50
           THEN 'WARNING: High block:row ratio - possible fragmentation'
         ELSE 'OK'
       END AS fragmentation_flag
FROM dba_tab_statistics dt
JOIN dba_segments ds
  ON ds.owner = dt.owner
  AND ds.segment_name = dt.table_name
  AND ds.segment_type = 'TABLE'
WHERE dt.table_name LIKE 'LOGMN%'
  AND dt.owner IN ('SYS', 'SYSTEM')
ORDER BY (ds.bytes / 8192) / NULLIF(dt.num_rows, 0) DESC NULLS FIRST;
\`\`\`

### Step 3.3: Check for Locked or Invalid Statistics

\`\`\`sql
-- Check for any statistic preferences or locks that could prevent gather
SELECT owner, table_name, preference_name, preference_value
FROM dba_tab_stat_prefs
WHERE table_name LIKE 'LOGMN%'
  AND owner IN ('SYS', 'SYSTEM')
ORDER BY owner, table_name;

-- Check if statistics are locked (locked stats cannot be gathered without unlock first)
SELECT owner, table_name, stattype_locked
FROM dba_tab_statistics
WHERE table_name LIKE 'LOGMN%'
  AND owner IN ('SYS', 'SYSTEM')
  AND stattype_locked IS NOT NULL
ORDER BY owner, table_name;
\`\`\`

If any tables show \`stattype_locked = 'ALL'\`, unlock them before proceeding to Phase 4:

\`\`\`sql
-- Unlock statistics if locked (substitute actual owner and table_name)
BEGIN
  DBMS_STATS.UNLOCK_TABLE_STATS(
    ownname => 'SYSTEM',
    tabname => 'LOGMNRT_MDDL\$'
  );
END;
/
\`\`\`

---

## Phase 4: Remediation — Statistics Gather

### Step 4.1: Stop the Extract

**Critical:** Stop the extract before gathering statistics. Gathering statistics while the Builder is running risks the Builder using mid-gather partial statistics, and may cause the statistics job itself to block on the MN enqueue.

\`\`\`ggsci
-- Stop the extract gracefully
STOP EXTRACT E_PROD

-- Confirm the extract is stopped before proceeding
INFO EXTRACT E_PROD
-- STATUS should show: STOPPED
\`\`\`

Wait for the extract to reach STOPPED state. If the extract is hung and will not stop cleanly within 2 minutes:

\`\`\`ggsci
-- Force stop (only if graceful stop is not responding)
KILL EXTRACT E_PROD
\`\`\`

### Step 4.2: Gather Dictionary Statistics

\`\`\`sql
-- Step 1: Standard Oracle dictionary statistics gather
-- Covers SYS and SYSTEM objects broadly
BEGIN
  DBMS_STATS.GATHER_DICTIONARY_STATS(
    degree        => 4,
    no_invalidate => FALSE
  );
END;
/
-- Expected runtime: 5-30 minutes depending on database size

-- Step 2: Targeted gather on all LOGMNR* tables
-- Required because GATHER_DICTIONARY_STATS may not fully cover all LogMiner-specific
-- tables, especially recently fragmented ones
DECLARE
  v_start TIMESTAMP := SYSTIMESTAMP;
  v_count NUMBER := 0;
  CURSOR c_logmnr_tabs IS
    SELECT owner, table_name
    FROM dba_tables
    WHERE table_name LIKE 'LOGMN%'
      AND owner IN ('SYS', 'SYSTEM')
    ORDER BY owner, table_name;
BEGIN
  FOR r IN c_logmnr_tabs LOOP
    v_count := v_count + 1;
    DBMS_OUTPUT.PUT_LINE(
      TO_CHAR(SYSTIMESTAMP, 'HH24:MI:SS') || ' Gathering: ' ||
      r.owner || '.' || r.table_name
    );
    DBMS_STATS.GATHER_TABLE_STATS(
      ownname          => r.owner,
      tabname          => r.table_name,
      estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,
      cascade          => TRUE,          -- Include index statistics
      degree           => 4,
      no_invalidate    => FALSE,         -- Immediately invalidate dependent cursors
      method_opt       => 'FOR ALL COLUMNS SIZE AUTO'
    );
  END LOOP;
  DBMS_OUTPUT.PUT_LINE(
    'Completed: ' || v_count || ' tables in ' ||
    ROUND(EXTRACT(MINUTE FROM (SYSTIMESTAMP - v_start)) +
          EXTRACT(SECOND FROM (SYSTIMESTAMP - v_start)) / 60, 1) ||
    ' minutes'
  );
END;
/
\`\`\`

### Step 4.3: Verify Statistics Were Successfully Gathered

\`\`\`sql
-- Confirm all LOGMNR* tables have fresh statistics
-- All tables should show last_analyzed within the last 30 minutes
SELECT owner,
       table_name,
       num_rows,
       blocks,
       TO_CHAR(last_analyzed, 'YYYY-MM-DD HH24:MI:SS') AS last_analyzed,
       stale_stats
FROM dba_tab_statistics
WHERE table_name LIKE 'LOGMN%'
  AND owner IN ('SYS', 'SYSTEM')
  AND (last_analyzed IS NULL OR SYSDATE - last_analyzed > 1/48)  -- Older than 30 minutes
ORDER BY owner, table_name;
-- This query should return ZERO ROWS if all statistics were successfully gathered.
-- Any rows returned indicate tables that need re-gathering.
\`\`\`

### Step 4.4: Flush the Shared Pool

Force plan invalidation for all cached cursors referencing the LOGMNR\* tables. This ensures the Builder uses the new statistics immediately on restart rather than potentially using a cached plan.

\`\`\`sql
-- WARNING: This causes all subsequent queries to hard-parse.
-- Execute during a low-activity window or immediately before extract restart.
-- On a busy system, the increased parse load lasts 5-15 minutes until the cache repopulates.
ALTER SYSTEM FLUSH SHARED_POOL;
\`\`\`

**Alternative (less disruptive):** If you know the specific sql_ids from Phase 2.3, purge only those cursors:

\`\`\`sql
-- Purge a specific cursor by sql_id (less disruptive than flushing the entire pool)
-- Replace :sql_id_value with the actual sql_id from Phase 2.3
BEGIN
  FOR r IN (
    SELECT address, hash_value
    FROM v\$sqlarea
    WHERE sql_id = 'YOUR_SQL_ID_HERE'
  ) LOOP
    DBMS_SHARED_POOL.PURGE(r.address || ',' || r.hash_value, 'C');
  END LOOP;
END;
/
\`\`\`

### Step 4.5: Restart the Extract

\`\`\`ggsci
-- Start the extract
START EXTRACT E_PROD

-- Immediately check that it is running and the lag is shrinking
INFO EXTRACT E_PROD DETAIL
\`\`\`

Watch for the **Recovery Checkpoint** timestamp to begin advancing in the output. If it does not advance within 5 minutes of restart, run the LogMiner session query from Phase 2.1 again to confirm the Builder is no longer blocked.

---

## Phase 5: Remediation — Parallelism and Streams Pool

### Step 5.1: Check Current Parallelism and Streams Pool Configuration

\`\`\`ggsci
-- Show current extract parameter file
VIEW PARAMS E_PROD
\`\`\`

Look for the \`TRANLOGOPTIONS INTEGRATEDPARAMS\` line with \`parallelism\` setting.

\`\`\`sql
-- Check current Streams Pool size from the database side
SELECT name, value, description
FROM v\$parameter
WHERE name IN ('streams_pool_size', 'sga_target', 'memory_target')
ORDER BY name;

-- Check actual current SGA allocation for Streams Pool
SELECT component,
       current_size / 1048576 AS current_mb,
       min_size / 1048576 AS min_mb,
       max_size / 1048576 AS max_mb,
       user_specified_size / 1048576 AS user_spec_mb,
       last_oper_type,
       last_oper_mode
FROM v\$sga_dynamic_components
WHERE component IN ('streams pool', 'shared pool', 'DEFAULT buffer cache')
ORDER BY component;
\`\`\`

### Step 5.2: Reduce Parallelism (Immediate Workaround)

Reducing parallelism from 4 to 1 immediately reduces the number of MS processes competing for the Streams Pool, decreasing the probability of MN enqueue contention and memory pressure. This is a workaround — the permanent fix is the Streams Pool sizing in Step 5.3.

\`\`\`ggsci
-- Stop the extract before editing parameters
STOP EXTRACT E_PROD

-- Edit the parameter file
EDIT PARAMS E_PROD
\`\`\`

Find the TRANLOGOPTIONS line and change parallelism:

\`\`\`
-- Find this line (example):
TRANLOGOPTIONS INTEGRATEDPARAMS (parallelism 4)

-- Change to:
TRANLOGOPTIONS INTEGRATEDPARAMS (parallelism 1)
-- parallelism 1 = 1 Builder + 1 Preparer + 1 Reader
-- Reduces Streams Pool consumption and eliminates concurrent MN enqueue requests
-- Performance impact: lower throughput during catchup, acceptable for recovery
-- Restore to parallelism 4 after full catchup and Streams Pool is sized correctly
\`\`\`

Save the parameter file and restart:

\`\`\`ggsci
START EXTRACT E_PROD
\`\`\`

### Step 5.3: Set Static Streams Pool Size

\`\`\`sql
-- Streams Pool Sizing Formula:
--   Minimum safe size = (parallelism * 2 GB) + 25% buffer
--   parallelism 1: (1 * 2 GB) + 0.5 GB = 2.5 GB -- minimum for recovery
--   parallelism 2: (2 * 2 GB) + 1 GB = 5 GB
--   parallelism 4: (4 * 2 GB) + 2 GB = 10 GB -- production target
--   parallelism 4 (conservative): 12 GB -- recommended for production
--
-- CRITICAL: Never leave streams_pool_size = 0 on a database running Integrated Extract.
-- With streams_pool_size = 0, Oracle AMM can shrink the Streams Pool to a few hundred MB
-- under memory pressure, causing LogMiner to stall and extract lag to grow.

-- Set for current recovery (parallelism 1 workaround):
ALTER SYSTEM SET streams_pool_size = 3G SCOPE=BOTH;

-- After catchup is complete and parallelism is restored to 4:
-- ALTER SYSTEM SET streams_pool_size = 12G SCOPE=BOTH;

-- Verify the change took effect
SELECT component, current_size / 1048576 AS current_mb
FROM v\$sga_dynamic_components
WHERE component = 'streams pool';

-- Confirm the parameter setting is persistent
SELECT name, value FROM v\$parameter WHERE name = 'streams_pool_size';
\`\`\`

### Step 5.4: Verify Streams Pool Allocation After Change

\`\`\`sql
-- Confirm the Streams Pool is now allocated at the requested size
SELECT component,
       current_size / 1048576 AS current_mb,
       user_specified_size / 1048576 AS user_spec_mb,
       last_oper_type,
       last_oper_mode,
       last_oper_time
FROM v\$sga_dynamic_components
WHERE component = 'streams pool';

-- Check that SGA has sufficient room (current_size + streams pool target <= SGA_MAX_SIZE)
SELECT name, value FROM v\$parameter
WHERE name IN ('sga_max_size', 'sga_target', 'streams_pool_size');
\`\`\`

If the Streams Pool does not grow to the requested size, SGA_MAX_SIZE may be too small. Increase SGA_MAX_SIZE (requires database restart) or reduce the streams_pool_size target and increase other SGA components proportionally.

---

## Phase 6: Monitor Recovery After Restart

### Step 6.1: Watch the Recovery Checkpoint Advancing

Run this in GGSCI repeatedly to confirm the extract is catching up:

\`\`\`ggsci
-- Run every 5-10 minutes during catchup
INFO EXTRACT E_PROD DETAIL
\`\`\`

What to look for in the output:
- **Recovery Checkpoint** timestamp advancing toward the present — this confirms the extract is processing the backlog
- **Lag at Chkpt** decreasing over time
- **Time Since Chkpt** remaining in the seconds-to-minutes range (not growing) — confirms the extract is actively checkpointing

If **Recovery Checkpoint** is not advancing after 10 minutes from restart, return to Phase 2 and re-run the LogMiner session check.

### Step 6.2: Estimate Remaining Catchup Time

\`\`\`sql
-- Estimate remaining catchup time based on current mining rate
-- Run this 15-20 minutes after restart to let the extract establish a steady rate
WITH capture_stats AS (
  SELECT capture_name,
         total_messages_captured,
         total_messages_enqueued,
         -- lag_time is a INTERVAL DAY TO SECOND value
         lag_time,
         EXTRACT(HOUR FROM lag_time) * 3600 +
         EXTRACT(MINUTE FROM lag_time) * 60 +
         EXTRACT(SECOND FROM lag_time) AS lag_seconds,
         SYSDATE AS check_time
  FROM v\$goldengate_capture
  WHERE capture_name LIKE '%E_PROD%'
)
SELECT capture_name,
       ROUND(lag_seconds / 3600, 2) AS lag_hours,
       total_messages_captured,
       -- Estimated catchup rate (requires two readings 15+ minutes apart to be accurate)
       -- Manual calculation: note total_messages_captured, wait 15 min, note again
       -- Rate (msgs/min) = delta_messages / 15
       -- Remaining time = lag_seconds / (rate_per_second)
       'Check again in 15 min to calculate rate' AS instructions
FROM capture_stats;
\`\`\`

**Manual catchup rate calculation:**
1. Note \`total_messages_captured\` = N1 at time T1
2. Wait 15 minutes
3. Note \`total_messages_captured\` = N2 at time T2
4. Rate = (N2 - N1) / 900 messages per second
5. Remaining messages ≈ lag_seconds × (average messages per second at peak load)
6. Estimated remaining time = remaining_messages / rate

### Step 6.3: Verify LogMiner Processes Are No Longer Blocked

\`\`\`sql
-- Confirm MS processes are no longer in long-running blocked states
-- This should return ZERO ROWS during healthy catchup
SELECT s.sid,
       s.program,
       s.event,
       ROUND(s.last_call_et/60, 2) AS minutes_running,
       s.blocking_session
FROM v\$session s
WHERE s.program LIKE '%(MS%'
  AND s.status = 'ACTIVE'
  AND s.last_call_et > 900  -- 15 minutes
ORDER BY s.last_call_et DESC;
\`\`\`

During healthy catchup, the MS processes will still be ACTIVE but their \`last_call_et\` will cycle through normal values (seconds to a few minutes) rather than accumulating for hours.

---

## Phase 7: Verify Full Resolution

### Step 7.1: Confirm No More Ghost Transactions

\`\`\`ggsci
-- After extract catches up (lag approaches 0), confirm no open ghost transactions
SEND EXTRACT E_PROD, SHOWTRANS
\`\`\`

Expected output after full resolution:

\`\`\`
Sending SHOWTRANS request to EXTRACT E_PROD ...
No long running transactions found.
\`\`\`

If SHOWTRANS still shows old transactions with zero Items after catchup, they may be legitimately long-running transactions in the source database. Verify each XID against V\$TRANSACTION to confirm they are real (not ghosts).

### Step 7.2: Confirm Lag Has Reached Near-Zero

\`\`\`sql
-- Confirm lag is at or near zero from the database side
SELECT capture_name,
       status,
       lag_time,
       EXTRACT(SECOND FROM lag_time) +
       EXTRACT(MINUTE FROM lag_time) * 60 +
       EXTRACT(HOUR FROM lag_time) * 3600 AS lag_seconds,
       total_messages_captured,
       total_messages_enqueued
FROM v\$goldengate_capture
ORDER BY capture_name;
-- lag_seconds should be < 60 for a fully caught-up extract
\`\`\`

\`\`\`ggsci
-- Final GGSCI confirmation
INFO EXTRACT E_PROD DETAIL
-- Lag at Chkpt should be < 00:01:00
-- Recovery Checkpoint and Log Read Checkpoint should be within seconds of each other
\`\`\`

### Step 7.3: Confirm LogMiner Processes Are Healthy

\`\`\`sql
-- Final check: all LogMiner processes should be active with short call times
SELECT s.sid,
       s.serial#,
       s.program,
       s.status,
       s.event,
       s.last_call_et,
       ROUND(s.last_call_et/60, 2) AS minutes_running
FROM v\$session s
WHERE s.program LIKE '%(MS%'
ORDER BY s.program;
-- All processes should show last_call_et < 300 (5 minutes) for normal operations
\`\`\`

### Step 7.4: Restore Full Parallelism (After Streams Pool Is Sized)

Once lag is at near-zero and the Streams Pool is set to 12G:

\`\`\`ggsci
STOP EXTRACT E_PROD
EDIT PARAMS E_PROD
\`\`\`

Change back to production parallelism:

\`\`\`
-- Change from:
TRANLOGOPTIONS INTEGRATEDPARAMS (parallelism 1)
-- Back to:
TRANLOGOPTIONS INTEGRATEDPARAMS (parallelism 4)
\`\`\`

\`\`\`ggsci
START EXTRACT E_PROD
INFO EXTRACT E_PROD DETAIL
\`\`\`

---

## Phase 8: The Automated Monitoring Job

Implement automated monitoring to detect LogMiner contention before it causes catastrophic lag.

### Step 8.1: Create the Alert Log Table

\`\`\`sql
-- Create the monitoring alert log table
-- Run as a DBA user or the GoldenGate monitoring user
CREATE TABLE ggs_logminer_alert_log (
  id              NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_time      TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  sid             NUMBER,
  serial#         NUMBER,
  program         VARCHAR2(100),
  event           VARCHAR2(200),
  minutes_running NUMBER(10, 2),
  blocking_session NUMBER,
  sql_id          VARCHAR2(13),
  alert_level     VARCHAR2(20) NOT NULL,  -- 'ADVISORY', 'WARNING', 'CRITICAL'
  notes           VARCHAR2(4000)
);

-- Create index for time-based queries
CREATE INDEX ggs_logminer_alert_time_idx
  ON ggs_logminer_alert_log (alert_time DESC);

-- Create index for level-based queries
CREATE INDEX ggs_logminer_alert_level_idx
  ON ggs_logminer_alert_log (alert_level, alert_time DESC);
\`\`\`

### Step 8.2: Create the Monitoring Procedure

\`\`\`sql
CREATE OR REPLACE PROCEDURE check_logminer_health AS
  -- Alert Threshold Matrix:
  --   minutes_running > 15  : ADVISORY - monitor; check if dictionary stats are fresh
  --   minutes_running > 30  : WARNING  - gather dictionary stats proactively
  --   minutes_running > 60  : WARNING  - gather targeted LOGMNR* stats immediately
  --   minutes_running > 120 : CRITICAL - gather stats, reduce parallelism, page on-call DBA
  --   event = 'enq: MN - contention' (any duration): CRITICAL - extract lag growing

  v_alert_level   VARCHAR2(20);
  v_notes         VARCHAR2(4000);
  v_warning_count NUMBER := 0;
  v_critical_count NUMBER := 0;
  v_subject       VARCHAR2(200);
  v_body          CLOB;

  CURSOR c_ms_sessions IS
    SELECT s.sid,
           s.serial#,
           s.program,
           s.event,
           s.status,
           ROUND(s.last_call_et/60, 2) AS minutes_running,
           s.blocking_session,
           s.sql_id
    FROM v\$session s
    WHERE s.program LIKE '%(MS%'
      AND s.status = 'ACTIVE'
      AND s.last_call_et > 900  -- Only sessions active > 15 minutes
    ORDER BY s.last_call_et DESC;

BEGIN
  -- Evaluate each long-running LogMiner session
  FOR r IN c_ms_sessions LOOP

    -- Determine alert level based on duration and wait event
    IF r.event LIKE 'enq: MN%' THEN
      v_alert_level := 'CRITICAL';
      v_notes := 'CRITICAL: enq: MN - contention detected. Builder is blocking Preparer. ' ||
                 'Extract lag is growing. Immediate action required: gather LOGMNR* stats.';
      v_critical_count := v_critical_count + 1;
    ELSIF r.minutes_running > 120 THEN
      v_alert_level := 'CRITICAL';
      v_notes := 'CRITICAL: LogMiner process active for ' || r.minutes_running ||
                 ' minutes. Check Streams Pool size. Gather LOGMNR* statistics immediately.';
      v_critical_count := v_critical_count + 1;
    ELSIF r.minutes_running > 30 THEN
      v_alert_level := 'WARNING';
      v_notes := 'WARNING: LogMiner process active for ' || r.minutes_running ||
                 ' minutes on event: ' || r.event || '. Gather dictionary stats proactively.';
      v_warning_count := v_warning_count + 1;
    ELSE
      v_alert_level := 'ADVISORY';
      v_notes := 'ADVISORY: LogMiner process active for ' || r.minutes_running ||
                 ' minutes. Monitor for escalation.';
    END IF;

    -- Insert alert record
    INSERT INTO ggs_logminer_alert_log (
      sid, serial#, program, event, minutes_running,
      blocking_session, sql_id, alert_level, notes
    ) VALUES (
      r.sid, r.serial#, r.program, r.event, r.minutes_running,
      r.blocking_session, r.sql_id, v_alert_level, v_notes
    );
  END LOOP;

  COMMIT;

  -- Send email alerts for WARNING and CRITICAL thresholds
  IF v_critical_count > 0 OR v_warning_count > 0 THEN

    v_subject := 'GoldenGate LogMiner Alert: ' ||
      CASE WHEN v_critical_count > 0 THEN 'CRITICAL (' || v_critical_count || ' issues)'
           ELSE 'WARNING (' || v_warning_count || ' issues)'
      END || ' on ' || SYS_CONTEXT('USERENV', 'DB_NAME');

    v_body := 'GoldenGate LogMiner Health Alert' || CHR(10) ||
              'Database: ' || SYS_CONTEXT('USERENV', 'DB_NAME') || CHR(10) ||
              'Time: ' || TO_CHAR(SYSTIMESTAMP, 'YYYY-MM-DD HH24:MI:SS TZR') || CHR(10) ||
              CHR(10) ||
              'Critical Issues: ' || v_critical_count || CHR(10) ||
              'Warning Issues: ' || v_warning_count || CHR(10) ||
              CHR(10) ||
              'ACTION REQUIRED: Review ggs_logminer_alert_log table and run Phase 2 diagnosis.' || CHR(10) ||
              CHR(10) ||
              'Query: SELECT * FROM ggs_logminer_alert_log' || CHR(10) ||
              'WHERE alert_time > SYSDATE - 1/24' || CHR(10) ||
              'ORDER BY alert_time DESC;';

    -- Send email via UTL_MAIL
    -- Requires: GRANT EXECUTE ON UTL_MAIL TO <monitoring_user>;
    -- Requires: SMTP_OUT_SERVER parameter set in the database
    BEGIN
      UTL_MAIL.SEND(
        sender     => 'oracle-monitor@yourdomain.com',
        recipients => 'dba-oncall@yourdomain.com',
        subject    => v_subject,
        message    => v_body
      );
    EXCEPTION
      WHEN OTHERS THEN
        -- Log email failure but do not raise — monitoring must not fail silently
        INSERT INTO ggs_logminer_alert_log (
          alert_level, notes
        ) VALUES (
          'ADVISORY',
          'UTL_MAIL send failed: ' || SQLERRM || '. Alert was: ' || v_subject
        );
        COMMIT;
    END;

  END IF;

EXCEPTION
  WHEN OTHERS THEN
    -- Log procedure failure
    INSERT INTO ggs_logminer_alert_log (alert_level, notes)
    VALUES ('CRITICAL', 'CHECK_LOGMINER_HEALTH procedure failed: ' || SQLERRM);
    COMMIT;
    RAISE;
END check_logminer_health;
/
\`\`\`

### Step 8.3: Create the Monitoring Scheduler Job

\`\`\`sql
-- Create a job that runs CHECK_LOGMINER_HEALTH every 5 minutes
BEGIN
  -- Drop the job if it already exists
  BEGIN
    DBMS_SCHEDULER.DROP_JOB('CHECK_LOGMINER_HEALTH_JOB', FORCE => TRUE);
  EXCEPTION
    WHEN OTHERS THEN NULL;
  END;

  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'CHECK_LOGMINER_HEALTH_JOB',
    job_type        => 'STORED_PROCEDURE',
    job_action      => 'CHECK_LOGMINER_HEALTH',
    start_date      => SYSTIMESTAMP,
    repeat_interval => 'FREQ=MINUTELY;INTERVAL=5',
    enabled         => TRUE,
    auto_drop       => FALSE,
    comments        => 'Monitor LogMiner process health every 5 min. Alerts via GGS_LOGMINER_ALERT_LOG and UTL_MAIL.'
  );
END;
/

-- Verify the job was created and is enabled
SELECT job_name, enabled, state, repeat_interval, last_run_duration,
       next_run_date, run_count, failure_count
FROM dba_scheduler_jobs
WHERE job_name = 'CHECK_LOGMINER_HEALTH_JOB';
\`\`\`

### Step 8.4: Create the Alert Log Cleanup Job

\`\`\`sql
-- Purge alert log entries older than 30 days
CREATE OR REPLACE PROCEDURE cleanup_logminer_alert_log AS
BEGIN
  DELETE FROM ggs_logminer_alert_log
  WHERE alert_time < SYSTIMESTAMP - INTERVAL '30' DAY;
  COMMIT;
  DBMS_OUTPUT.PUT_LINE('Deleted ' || SQL%ROWCOUNT || ' old alert log entries.');
END cleanup_logminer_alert_log;
/

-- Schedule daily cleanup at 3:00 AM
BEGIN
  BEGIN
    DBMS_SCHEDULER.DROP_JOB('CLEANUP_LOGMINER_ALERT_JOB', FORCE => TRUE);
  EXCEPTION
    WHEN OTHERS THEN NULL;
  END;

  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'CLEANUP_LOGMINER_ALERT_JOB',
    job_type        => 'STORED_PROCEDURE',
    job_action      => 'CLEANUP_LOGMINER_ALERT_LOG',
    start_date      => TRUNC(SYSDATE + 1) + 3/24,  -- Next occurrence of 3:00 AM
    repeat_interval => 'FREQ=DAILY;BYHOUR=3;BYMINUTE=0',
    enabled         => TRUE,
    auto_drop       => FALSE,
    comments        => 'Purge GGS_LOGMINER_ALERT_LOG entries older than 30 days'
  );
END;
/
\`\`\`

---

## Phase 9: Preventive Maintenance Schedule

### Step 9.1: Weekly Statistics Freshness Check

Schedule this as a weekly report to detect stale statistics before they cause incidents:

\`\`\`sql
-- Weekly check: LOGMNR* tables with statistics older than 7 days
-- Add this to a weekly DBA report or schedule as a DBMS_SCHEDULER job
SELECT owner,
       table_name,
       num_rows,
       blocks,
       TO_CHAR(last_analyzed, 'YYYY-MM-DD') AS last_analyzed,
       ROUND(SYSDATE - last_analyzed, 0) AS days_stale,
       stale_stats,
       'ACTION: Run targeted LOGMNR* stats gather' AS recommendation
FROM dba_tab_statistics
WHERE table_name LIKE 'LOGMN%'
  AND owner IN ('SYS', 'SYSTEM')
  AND (last_analyzed IS NULL OR SYSDATE - last_analyzed > 7)
ORDER BY SYSDATE - last_analyzed DESC NULLS FIRST;
\`\`\`

### Step 9.2: Weekly Preventive Statistics Gather

Schedule a weekly targeted gather on LOGMNR\* tables, independent of the standard GATHER_DICTIONARY_STATS run:

\`\`\`sql
-- Procedure for weekly preventive stats gather on LogMiner tables
CREATE OR REPLACE PROCEDURE gather_logminer_stats AS
  v_start TIMESTAMP := SYSTIMESTAMP;
  v_count NUMBER := 0;
BEGIN
  DBMS_OUTPUT.PUT_LINE('Starting LogMiner statistics gather: ' ||
    TO_CHAR(v_start, 'YYYY-MM-DD HH24:MI:SS'));

  FOR r IN (
    SELECT owner, table_name
    FROM dba_tables
    WHERE table_name LIKE 'LOGMN%'
      AND owner IN ('SYS', 'SYSTEM')
    ORDER BY owner, table_name
  ) LOOP
    v_count := v_count + 1;
    DBMS_STATS.GATHER_TABLE_STATS(
      ownname          => r.owner,
      tabname          => r.table_name,
      estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,
      cascade          => TRUE,
      degree           => 2,          -- Lower degree for scheduled maintenance
      no_invalidate    => FALSE,
      method_opt       => 'FOR ALL COLUMNS SIZE AUTO'
    );
  END LOOP;

  DBMS_OUTPUT.PUT_LINE('Completed: ' || v_count || ' tables');
END gather_logminer_stats;
/

-- Schedule weekly gather every Sunday at 02:00 AM
BEGIN
  BEGIN
    DBMS_SCHEDULER.DROP_JOB('GATHER_LOGMINER_STATS_JOB', FORCE => TRUE);
  EXCEPTION
    WHEN OTHERS THEN NULL;
  END;

  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'GATHER_LOGMINER_STATS_JOB',
    job_type        => 'STORED_PROCEDURE',
    job_action      => 'GATHER_LOGMINER_STATS',
    start_date      => NEXT_DAY(TRUNC(SYSDATE), 'SUNDAY') + 2/24,
    repeat_interval => 'FREQ=WEEKLY;BYDAY=SUN;BYHOUR=2;BYMINUTE=0',
    enabled         => TRUE,
    auto_drop       => FALSE,
    comments        => 'Weekly preventive statistics gather on all LOGMNR* tables'
  );
END;
/
\`\`\`

### Step 9.3: Monthly Fragmentation Check

Detect LOGMNR\* table fragmentation early, before it causes Builder contention:

\`\`\`sql
-- Monthly fragmentation detection for LogMiner dictionary tables
-- Run first day of each month, or schedule via DBMS_SCHEDULER
SELECT dt.owner,
       dt.table_name,
       dt.num_rows,
       dt.blocks AS stats_blocks,
       ds.bytes / 8192 AS actual_blocks,
       ds.bytes / 1048576 AS segment_mb,
       CASE
         WHEN dt.num_rows = 0 THEN NULL
         ELSE ROUND((ds.bytes / 8192) / dt.num_rows, 2)
       END AS blocks_per_row,
       CASE
         WHEN dt.num_rows = 0 AND ds.bytes > 1048576
           THEN 'FRAGMENTED: Shrink candidate - 0 rows, segment has data'
         WHEN dt.num_rows > 0 AND (ds.bytes / 8192) / dt.num_rows > 100
           THEN 'FRAGMENTED: blocks_per_row > 100, consider SHRINK SPACE'
         WHEN dt.num_rows > 0 AND (ds.bytes / 8192) / dt.num_rows > 50
           THEN 'WARNING: blocks_per_row > 50, monitor for growth'
         ELSE 'OK'
       END AS fragmentation_status,
       -- Remediation hint
       CASE
         WHEN dt.num_rows > 0 AND (ds.bytes / 8192) / dt.num_rows > 50
           THEN 'ALTER TABLE ' || dt.owner || '.' || dt.table_name ||
                ' SHRINK SPACE COMPACT CASCADE;'
         ELSE NULL
       END AS remediation_hint
FROM dba_tab_statistics dt
JOIN dba_segments ds
  ON ds.owner = dt.owner
  AND ds.segment_name = dt.table_name
  AND ds.segment_type = 'TABLE'
WHERE dt.table_name LIKE 'LOGMN%'
  AND dt.owner IN ('SYS', 'SYSTEM')
ORDER BY
  CASE
    WHEN dt.num_rows > 0 THEN (ds.bytes / 8192) / dt.num_rows
    ELSE 999999
  END DESC NULLS FIRST;
\`\`\`

### Step 9.4: Schedule Monthly Fragmentation Check

\`\`\`sql
-- Procedure wrapper for monthly fragmentation report
CREATE OR REPLACE PROCEDURE check_logminer_fragmentation AS
  v_fragmented_count NUMBER := 0;
  v_body CLOB := '';
BEGIN
  FOR r IN (
    SELECT dt.owner, dt.table_name, dt.num_rows,
           ds.bytes / 8192 AS actual_blocks,
           CASE
             WHEN dt.num_rows = 0 THEN 999999
             ELSE ROUND((ds.bytes / 8192) / dt.num_rows, 2)
           END AS blocks_per_row
    FROM dba_tab_statistics dt
    JOIN dba_segments ds
      ON ds.owner = dt.owner AND ds.segment_name = dt.table_name
      AND ds.segment_type = 'TABLE'
    WHERE dt.table_name LIKE 'LOGMN%'
      AND dt.owner IN ('SYS', 'SYSTEM')
      AND (
        (dt.num_rows = 0 AND ds.bytes > 1048576) OR
        (dt.num_rows > 0 AND (ds.bytes / 8192) / dt.num_rows > 50)
      )
    ORDER BY blocks_per_row DESC NULLS FIRST
  ) LOOP
    v_fragmented_count := v_fragmented_count + 1;
    v_body := v_body || r.owner || '.' || r.table_name ||
              ': ' || r.actual_blocks || ' blocks, ' ||
              r.num_rows || ' rows, ratio=' || r.blocks_per_row || CHR(10);
  END LOOP;

  IF v_fragmented_count > 0 THEN
    INSERT INTO ggs_logminer_alert_log (alert_level, notes)
    VALUES ('WARNING', 'Monthly fragmentation check: ' || v_fragmented_count ||
            ' fragmented LOGMNR tables.' || CHR(10) || v_body);
    COMMIT;

    UTL_MAIL.SEND(
      sender     => 'oracle-monitor@yourdomain.com',
      recipients => 'dba-team@yourdomain.com',
      subject    => 'Monthly LogMiner Table Fragmentation Report: ' || v_fragmented_count ||
                    ' tables need attention on ' || SYS_CONTEXT('USERENV', 'DB_NAME'),
      message    => 'The following LOGMNR* tables show signs of fragmentation:' ||
                    CHR(10) || v_body || CHR(10) ||
                    'Consider running SHRINK SPACE on these tables during a maintenance window.'
    );
  END IF;
END check_logminer_fragmentation;
/

-- Schedule first day of each month at 04:00 AM
BEGIN
  BEGIN
    DBMS_SCHEDULER.DROP_JOB('CHECK_LOGMINER_FRAG_JOB', FORCE => TRUE);
  EXCEPTION
    WHEN OTHERS THEN NULL;
  END;

  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'CHECK_LOGMINER_FRAG_JOB',
    job_type        => 'STORED_PROCEDURE',
    job_action      => 'CHECK_LOGMINER_FRAGMENTATION',
    start_date      => TRUNC(ADD_MONTHS(SYSDATE, 1), 'MM') + 4/24,
    repeat_interval => 'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=4;BYMINUTE=0',
    enabled         => TRUE,
    auto_drop       => FALSE,
    comments        => 'Monthly LogMiner dictionary table fragmentation check'
  );
END;
/
\`\`\`

### Step 9.5: Verify All Scheduled Jobs Are Running

\`\`\`sql
-- Verify all LogMiner monitoring jobs are enabled and running
SELECT job_name,
       enabled,
       state,
       repeat_interval,
       last_run_duration,
       TO_CHAR(next_run_date, 'YYYY-MM-DD HH24:MI') AS next_run,
       run_count,
       failure_count
FROM dba_scheduler_jobs
WHERE job_name IN (
  'CHECK_LOGMINER_HEALTH_JOB',
  'GATHER_LOGMINER_STATS_JOB',
  'CHECK_LOGMINER_FRAG_JOB',
  'CLEANUP_LOGMINER_ALERT_JOB'
)
ORDER BY job_name;
-- All jobs should show: ENABLED=TRUE, STATE=SCHEDULED, failure_count=0
\`\`\`

---

## Quick Reference

### GGSCI Commands for Lag Diagnosis

\`\`\`ggsci
INFO EXTRACT * DETAIL                        -- All extracts: status, lag, checkpoints
INFO EXTRACT E_PROD DETAIL                   -- Specific extract: full checkpoint detail
SEND EXTRACT E_PROD, SHOWTRANS               -- All open transactions pinning Recovery Checkpoint
SEND EXTRACT E_PROD, SHOWTRANS COUNT 10      -- Top 10 oldest open transactions
STOP EXTRACT E_PROD                          -- Graceful stop before maintenance
START EXTRACT E_PROD                         -- Start after stats gather
VIEW PARAMS E_PROD                           -- Show current parameter file
EDIT PARAMS E_PROD                           -- Edit parameter file (for parallelism change)
\`\`\`

### Top 5 SQL Queries for LogMiner Health

**Query 1 — Active LogMiner processes with blocking info:**

\`\`\`sql
SELECT s.sid, s.program, s.event, ROUND(s.last_call_et/60,2) AS mins,
       s.blocking_session, s.sql_id
FROM v\$session s
WHERE s.program LIKE '%(MS%' AND s.status = 'ACTIVE' AND s.last_call_et > 300
ORDER BY s.last_call_et DESC;
\`\`\`

**Query 2 — LOGMNR\* statistics freshness:**

\`\`\`sql
SELECT owner, table_name, TO_CHAR(last_analyzed,'YYYY-MM-DD HH24:MI') AS analyzed,
       ROUND(SYSDATE - last_analyzed,1) AS days_old, stale_stats
FROM dba_tab_statistics
WHERE table_name LIKE 'LOGMN%' AND owner IN ('SYS','SYSTEM')
ORDER BY days_old DESC NULLS FIRST;
\`\`\`

**Query 3 — MN enqueue holders and waiters:**

\`\`\`sql
SELECT s.sid, s.program, l.type, l.lmode, l.request, l.block
FROM v\$lock l JOIN v\$session s ON l.sid = s.sid
WHERE l.type = 'MN' ORDER BY l.block DESC;
\`\`\`

**Query 4 — GoldenGate capture lag from the database:**

\`\`\`sql
SELECT capture_name, status, lag_time, total_messages_captured, required_checkpoint_scn
FROM v\$goldengate_capture ORDER BY capture_name;
\`\`\`

**Query 5 — Historical LogMiner contention from ASH (last 7 days):**

\`\`\`sql
SELECT TRUNC(sample_time, 'HH') AS hour_bucket, event, COUNT(*) AS ash_samples
FROM dba_hist_active_sess_history
WHERE program LIKE '%(MS%'
  AND (event LIKE 'enq: MN%' OR event LIKE 'db file scattered read%')
  AND sample_time > SYSDATE - 7
GROUP BY TRUNC(sample_time, 'HH'), event
ORDER BY hour_bucket DESC, ash_samples DESC
FETCH FIRST 50 ROWS ONLY;
\`\`\``,
};

async function main() {
  console.log('Inserting GoldenGate Extract Lag runbook post...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: {
      title: post.title,
      excerpt: post.excerpt,
      content: post.content,
      published: post.published,
      publishedAt: post.publishedAt,
      isPremium: post.isPremium,
    },
  });
  console.log(`Inserted: "${post.title}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
