import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Diagnosing and Fixing an Explosive Staging Table Self-Join — PHV Triage, Index Contention, and SQL Rewrite',
  slug: 'oracle-staging-table-self-join-buffer-busy-wait-runbook',
  excerpt:
    'Step-by-step runbook for a staging table self-join query that degrades from seconds to 70 minutes: retrieve Plan Hash Value history and measure per-PHV elapsed time from ASH, identify low-cardinality index buffer busy waits, purge the bad cursor plan, rebuild the index with higher INITRANS, validate the GROUP BY/HAVING rewrite with GATHER_PLAN_STATISTICS, and a monitoring script that detects self-join PGA blowups and buffer busy wait spikes on staging tables before they escalate.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-15'),
  youtubeUrl: null,
  content: `## Scope

This runbook addresses a production query regression where a self-join on a staging table degrades from seconds to 70+ minutes when data volume grows. The immediate symptoms are: long-running sessions with no blocking locks, buffer busy waits on index blocks, PGA memory operation waits, and a discrepancy where the SQL runs fast in SQL*Plus but slowly inside a package. The pattern generalizes to any Oracle staging table with a low-cardinality status column and a self-join duplicate-detection query.

**Phases 1–3 are [ACTIVE OUTAGE] triage. Phases 4–6 are the structural fix and should be validated in a lower environment before production deployment.**

---

## Phase 1: Identify the Offending SQL and Its Plan History [ACTIVE OUTAGE]

### 1.1 Find currently running long-duration sessions

\`\`\`sql
-- Sessions running for more than 5 minutes
SELECT s.sid,
       s.serial#,
       s.username,
       s.status,
       s.sql_id,
       s.sql_child_number,
       s.sql_plan_hash_value,
       s.event,
       s.seconds_in_wait,
       ROUND((SYSDATE - s.sql_exec_start) * 60) AS exec_mins,
       s.module,
       s.action,
       s.machine
FROM   v\$session s
WHERE  s.status = 'ACTIVE'
  AND  s.username IS NOT NULL
  AND  s.sql_exec_start < SYSDATE - 5/1440
ORDER BY exec_mins DESC;
\`\`\`

### 1.2 Get the SQL text for the offending SQL_ID

\`\`\`sql
-- Full SQL text (use v\$sqltext for long statements)
SELECT piece, sql_text
FROM   v\$sqltext
WHERE  sql_id = '&sql_id'
ORDER BY piece;

-- Also check v\$sql for basic execution metrics
SELECT sql_id,
       child_number,
       plan_hash_value,
       executions,
       elapsed_time / 1e6     AS elapsed_sec,
       buffer_gets,
       disk_reads,
       rows_processed,
       optimizer_cost,
       last_active_time,
       parsing_schema_name
FROM   v\$sql
WHERE  sql_id = '&sql_id'
ORDER BY last_active_time DESC;
\`\`\`

### 1.3 Retrieve per-PHV execution history from ASH

This is the key diagnostic step: measure how long each plan hash value actually ran per execution. If multiple PHVs exist, compare their elapsed times to identify when the plan changed.

\`\`\`sql
-- Per-PHV execution duration from ASH (last 7 days)
WITH individual_executions AS (
  SELECT sql_id,
         sql_plan_hash_value,
         sql_exec_id,
         sql_exec_start,
         (CAST(MAX(sample_time) AS DATE) - CAST(sql_exec_start AS DATE)) * 86400
           AS elapsed_seconds
  FROM   v\$active_session_history
  WHERE  sql_id = '&sql_id'
    AND  sql_exec_id    IS NOT NULL
    AND  sql_exec_start IS NOT NULL
  GROUP BY sql_id, sql_plan_hash_value, sql_exec_id, sql_exec_start
)
SELECT sql_plan_hash_value,
       COUNT(*)                              AS execution_count,
       ROUND(MIN(elapsed_seconds), 1)       AS min_sec,
       ROUND(MAX(elapsed_seconds), 1)       AS max_sec,
       ROUND(AVG(elapsed_seconds), 1)       AS avg_sec,
       ROUND(MEDIAN(elapsed_seconds), 1)    AS median_sec,
       MIN(sql_exec_start)                  AS first_seen,
       MAX(sql_exec_start)                  AS last_seen
FROM   individual_executions
GROUP BY sql_plan_hash_value
ORDER BY avg_sec DESC;
\`\`\`

A PHV that was fast for weeks and is now slow indicates a plan regression — the optimizer switched to a worse plan without a code change. A new PHV that appears on the date of the incident is the target to investigate.

### 1.4 Get the full execution plan for the bad PHV

\`\`\`sql
-- Execution plan from AWR for a specific PHV
SELECT * FROM TABLE(
  DBMS_XPLAN.DISPLAY_AWR(
    sql_id         => '&sql_id',
    plan_hash_value => &bad_phv,
    format         => 'ALL'
  )
);

-- Or from the cursor cache if it is still there
SELECT * FROM TABLE(
  DBMS_XPLAN.DISPLAY_CURSOR(
    sql_id        => '&sql_id',
    child_number  => &child_number,
    format        => 'ALL +PEEKED_BINDS'
  )
);
\`\`\`

**Red flags in the plan to look for:**
- \`E-Rows = 1\` at any level where large intermediate result sets are expected (indicates cardinality miscalculation)
- \`NESTED LOOPS\` on a large driving set (correct for tiny sets, catastrophic for thousands of matching rows)
- \`WINDOW SORT\` + \`HASH UNIQUE\` in the same plan (materializing a large intermediate set before deduplication)
- \`INDEX RANGE SCAN\` on a single-column low-cardinality index used at both sides of a self-join

---

## Phase 2: Diagnose the Wait Events

### 2.1 Current wait events for the offending session

\`\`\`sql
SELECT sw.sid,
       sw.seq#,
       sw.event,
       sw.wait_class,
       sw.seconds_in_wait,
       sw.state,
       sw.p1text, sw.p1,
       sw.p2text, sw.p2,
       sw.p3text, sw.p3
FROM   v\$session_wait sw
WHERE  sw.sid = &target_sid
ORDER BY sw.seconds_in_wait DESC;
\`\`\`

**Interpreting the wait events:**

| Wait Event | What It Means |
|-----------|---------------|
| \`buffer busy waits\` | Multiple sessions competing for the same buffer block — classic low-cardinality index contention |
| \`db file sequential read\` | Index range scan doing single-block I/O — expected but excessive if E-Rows is underestimated |
| \`PGA memory operation\` | Sort or hash operation running out of PGA work area — WINDOW SORT or HASH UNIQUE materializing too much data |
| \`read by other session\` | Another session is reading the block this session needs — concurrent index contention |

A combination of \`buffer busy waits\` on index blocks followed by \`PGA memory operation\` is the exact fingerprint of the self-join + low-cardinality index pattern.

### 2.2 Identify which index blocks are causing buffer busy waits

\`\`\`sql
-- What objects are at the center of the buffer busy waits?
SELECT o.object_name,
       o.object_type,
       o.owner,
       COUNT(*)          AS wait_count,
       MAX(sw.seconds_in_wait) AS max_wait_sec
FROM   v\$session_wait sw
JOIN   dba_objects o ON o.object_id = sw.p1  -- P1 for buffer busy waits is the file#, adjust for your version
WHERE  sw.event = 'buffer busy waits'
GROUP BY o.object_name, o.object_type, o.owner
ORDER BY wait_count DESC;

-- Alternative: check which segment is generating the most buffer busy waits via ASH
SELECT ash.current_obj#,
       do.object_name,
       do.object_type,
       COUNT(*) AS sample_count
FROM   v\$active_session_history ash
LEFT JOIN dba_objects do ON do.object_id = ash.current_obj#
WHERE  ash.sample_time >= SYSDATE - 1/24
  AND  ash.event = 'buffer busy waits'
GROUP BY ash.current_obj#, do.object_name, do.object_type
ORDER BY sample_count DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

### 2.3 Check index column cardinality

\`\`\`sql
-- Value distribution for the index column
SELECT column_name,
       num_distinct,
       num_nulls,
       density,
       num_rows
FROM   dba_tab_col_statistics
WHERE  table_name = 'AE_MEMBER_STG'
  AND  column_name = 'MEMBER_LOAD_STATUS';

-- Actual value distribution (run on a sample if the table is large)
SELECT MEMBER_LOAD_STATUS,
       COUNT(*) AS row_count,
       ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS pct
FROM   AE_MEMBER_STG
GROUP BY MEMBER_LOAD_STATUS
ORDER BY row_count DESC;
\`\`\`

If the column has fewer than 10 distinct values across millions of rows, it is a low-cardinality column. An index on this column alone is a contention source under concurrent workloads and produces useless cardinality estimates for the optimizer.

---

## Phase 3: Immediate Relief [ACTIVE OUTAGE]

### 3.1 Purge the bad plan from the cursor cache

\`\`\`sql
-- Option 1: Purge the specific SQL child cursor
EXECUTE DBMS_SHARED_POOL.PURGE('&sql_id', 'C');

-- Option 2: If the specific cursor cannot be purged, flush the entire shared pool
-- (only in extreme situations — causes a parse storm)
-- ALTER SYSTEM FLUSH SHARED_POOL;

-- Option 3: Use SQL Plan Management to reject the bad plan
DECLARE
  v_plans PLS_INTEGER;
BEGIN
  v_plans := DBMS_SPM.LOAD_PLANS_FROM_CURSOR_CACHE(
    sql_id          => '&sql_id',
    plan_hash_value => &bad_phv
  );
  DBMS_OUTPUT.PUT_LINE('Loaded plans: ' || v_plans);
END;
/
-- Then evolve or drop the bad baseline
\`\`\`

After purging, force a fresh parse by running the query with \`GATHER_PLAN_STATISTICS\` in SQL*Plus using representative bind values. Verify the new plan is acceptable before allowing the package to pick it up.

### 3.2 Rebuild the low-cardinality index with higher INITRANS

\`\`\`sql
-- Rebuild with higher transaction slots per block to reduce contention
ALTER INDEX AEUSER.AE_MEMBER_STG_INDEX4 REBUILD
  INITRANS 8
  PCTFREE 20
  ONLINE;

-- Verify the rebuild completed and check the new settings
SELECT index_name, status, ini_trans, pct_free, blevel, leaf_blocks
FROM   dba_indexes
WHERE  index_name = 'AE_MEMBER_STG_INDEX4';
\`\`\`

\`INITRANS 8\` creates 8 transaction slots per index leaf block (default is 2). Under concurrent workloads, multiple sessions can latch separate slots in the same block, eliminating the queue that was producing buffer busy waits.

### 3.3 Create a composite index to reduce the 'N' scan cost

\`\`\`sql
-- Create the composite index to give the optimizer a selectivity-ordered access path
CREATE INDEX AE_MEMBER_STG_CUSTOM_IDX
  ON AE_MEMBER_STG (MEMBER_LOAD_STATUS, ACTIVITY_CODE, APPLN_TYPE, SOURCE_ID)
  PARALLEL 4
  ONLINE;

-- Gather fresh statistics on the table and all indexes
EXEC DBMS_STATS.GATHER_TABLE_STATS(
  ownname     => 'AEUSER',
  tabname     => 'AE_MEMBER_STG',
  cascade     => TRUE,
  method_opt  => 'FOR ALL COLUMNS SIZE AUTO',
  degree      => 4
);
\`\`\`

### 3.4 Enable SQL tracing if the plan is still not correct

Set up trace on the running session to capture the actual execution plan and wait events:

\`\`\`sql
-- Attach trace to the running session (from another DBA session)
EXECUTE DBMS_MONITOR.SESSION_TRACE_ENABLE(
  session_id  => &target_sid,
  serial_num  => &target_serial,
  waits       => TRUE,
  binds       => TRUE,
  plan_stat   => 'ALL_EXECUTIONS'
);

-- After the session completes or you have enough data:
EXECUTE DBMS_MONITOR.SESSION_TRACE_DISABLE(
  session_id  => &target_sid,
  serial_num  => &target_serial
);
-- Run tkprof on the resulting trace file
\`\`\`

---

## Phase 4: Validate the GROUP BY/HAVING Rewrite

Before deploying the rewritten query to production, validate it in a lower environment against the same data volume. The key test is confirming the rewrite produces identical results and a dramatically lower cost plan.

### 4.1 Run the original and rewritten queries with GATHER_PLAN_STATISTICS

\`\`\`sql
-- Tag the original query for comparison
SELECT /*+ GATHER_PLAN_STATISTICS */ *
FROM   (original_query);

-- Tag the rewrite
WITH duplicate_groups AS (
  SELECT /*+ GATHER_PLAN_STATISTICS */
         NVL(SUBSC_EXCH_ID, '*')  AS g_subsc_exch_id,
         NVL(DEP_EXCH_ID,   '*')  AS g_dep_exch_id,
         NVL(FILE_CTRL_NUM, '*')  AS g_file_ctrl_num,
         NVL(ACTIVITY_CODE, '*')  AS g_activity_code,
         CASE WHEN MED_VRNT_CODE IS NOT NULL THEN 1 ELSE 0 END AS is_med,
         CASE WHEN DEN_VRNT_CODE IS NOT NULL THEN 1 ELSE 0 END AS is_den
  FROM   AE_MEMBER_STG
  WHERE  MEMBER_LOAD_STATUS = 'N'
    AND  ACTIVITY_CODE <> 'AUD'
  GROUP BY
         NVL(SUBSC_EXCH_ID, '*'),
         NVL(DEP_EXCH_ID,   '*'),
         NVL(FILE_CTRL_NUM, '*'),
         NVL(ACTIVITY_CODE, '*'),
         CASE WHEN MED_VRNT_CODE IS NOT NULL THEN 1 ELSE 0 END,
         CASE WHEN DEN_VRNT_CODE IS NOT NULL THEN 1 ELSE 0 END
  HAVING COUNT(1) > 1
)
SELECT b.MEMBER_STG_KEY,
       b.SUBSC_EXCH_ID,
       b.DEP_EXCH_ID,
       b.FILE_CTRL_NUM
FROM   AE_MEMBER_STG b
JOIN   duplicate_groups dg
       ON  NVL(b.SUBSC_EXCH_ID, '*')  = dg.g_subsc_exch_id
      AND  NVL(b.DEP_EXCH_ID,   '*')  = dg.g_dep_exch_id
      AND  NVL(b.FILE_CTRL_NUM, '*')  = dg.g_file_ctrl_num
      AND  NVL(b.ACTIVITY_CODE, '*')  = dg.g_activity_code
      AND  CASE WHEN b.MED_VRNT_CODE IS NOT NULL THEN 1 ELSE 0 END = dg.is_med
      AND  CASE WHEN b.DEN_VRNT_CODE IS NOT NULL THEN 1 ELSE 0 END = dg.is_den
WHERE  b.MEMBER_LOAD_STATUS = 'N'
  AND  b.ACTIVITY_CODE <> 'AUD';
\`\`\`

### 4.2 Inspect the actual vs. estimated row counts

\`\`\`sql
-- Display the plan with actual row counts (A-Rows) vs. estimated (E-Rows)
SELECT * FROM TABLE(
  DBMS_XPLAN.DISPLAY_CURSOR(
    sql_id       => NULL,  -- NULL = most recent SQL in this session
    child_number => 0,
    format       => 'ALLSTATS LAST'
  )
);
\`\`\`

In the original query, A-Rows at the NESTED LOOPS steps will be in the millions while E-Rows shows 1 — this is the cardinality underestimate. In the rewrite, E-Rows and A-Rows should be close, and the plan should show a HASH GROUP BY replacing the WINDOW SORT + HASH UNIQUE.

### 4.3 Compare result sets for correctness

\`\`\`sql
-- Confirm the rewrite produces the same MEMBER_STG_KEY set as the original
-- (Run on a test dataset with known duplicates)
SELECT member_stg_key FROM original_query_result
MINUS
SELECT member_stg_key FROM rewrite_result;

SELECT member_stg_key FROM rewrite_result
MINUS
SELECT member_stg_key FROM original_query_result;
-- Both should return 0 rows
\`\`\`

---

## Phase 5: Address the NVL Anti-Pattern

If the NVL-wrapped join predicates cannot be removed immediately (because the staging table design requires them), choose one of these infrastructure alternatives.

### 5.1 Create Function-Based Indexes on the NVL expressions

\`\`\`sql
-- Function-based index to support NVL(SUBSC_EXCH_ID, '*') = NVL(..., '*') predicates
CREATE INDEX AE_MEMBER_STG_FBI_SUBSC
  ON AE_MEMBER_STG (NVL(SUBSC_EXCH_ID, '*'))
  ONLINE;

CREATE INDEX AE_MEMBER_STG_FBI_DEP
  ON AE_MEMBER_STG (NVL(DEP_EXCH_ID, '*'))
  ONLINE;

-- Composite FBI for the common access pattern
CREATE INDEX AE_MEMBER_STG_FBI_COMP
  ON AE_MEMBER_STG (
    MEMBER_LOAD_STATUS,
    NVL(SUBSC_EXCH_ID, '*'),
    NVL(DEP_EXCH_ID, '*'),
    NVL(FILE_CTRL_NUM, '*'),
    NVL(ACTIVITY_CODE, '*')
  )
  ONLINE;

-- After creating FBIs, gather stats explicitly (FBIs use hidden virtual columns)
EXEC DBMS_STATS.GATHER_TABLE_STATS(
  ownname   => 'AEUSER',
  tabname   => 'AE_MEMBER_STG',
  cascade   => TRUE,
  method_opt => 'FOR ALL HIDDEN COLUMNS SIZE AUTO'
);
\`\`\`

**Note:** Function-based indexes add overhead to every INSERT and UPDATE that touches the indexed columns. For high-write staging tables, test the insert performance impact before deploying to production.

### 5.2 OR-expansion rewrite (removes NVL without FBI)

\`\`\`sql
-- Replace NVL(A.col, '*') = NVL(B.col, '*') with explicit OR
WHERE (A.SUBSC_EXCH_ID = B.SUBSC_EXCH_ID
       OR (A.SUBSC_EXCH_ID IS NULL AND B.SUBSC_EXCH_ID IS NULL))
  AND (A.DEP_EXCH_ID = B.DEP_EXCH_ID
       OR (A.DEP_EXCH_ID IS NULL AND B.DEP_EXCH_ID IS NULL))
  AND (A.FILE_CTRL_NUM = B.FILE_CTRL_NUM
       OR (A.FILE_CTRL_NUM IS NULL AND B.FILE_CTRL_NUM IS NULL))
  AND (A.ACTIVITY_CODE = B.ACTIVITY_CODE
       OR (A.ACTIVITY_CODE IS NULL AND B.ACTIVITY_CODE IS NULL))
\`\`\`

Oracle performs OR-expansion (query concatenation) on these predicates, generating separate branches that can each use standard B-tree indexes.

### 5.3 Long-term: enforce NOT NULL with default values at ingestion

\`\`\`sql
-- Modify the staging table to default nullable join-key columns to a sentinel value
ALTER TABLE AE_MEMBER_STG MODIFY SUBSC_EXCH_ID DEFAULT '*';
ALTER TABLE AE_MEMBER_STG MODIFY DEP_EXCH_ID   DEFAULT '*';
ALTER TABLE AE_MEMBER_STG MODIFY FILE_CTRL_NUM  DEFAULT '*';
ALTER TABLE AE_MEMBER_STG MODIFY ACTIVITY_CODE  DEFAULT '*';

-- Update existing NULL rows
UPDATE AE_MEMBER_STG SET SUBSC_EXCH_ID = '*' WHERE SUBSC_EXCH_ID IS NULL;
UPDATE AE_MEMBER_STG SET DEP_EXCH_ID   = '*' WHERE DEP_EXCH_ID   IS NULL;
UPDATE AE_MEMBER_STG SET FILE_CTRL_NUM  = '*' WHERE FILE_CTRL_NUM  IS NULL;
UPDATE AE_MEMBER_STG SET ACTIVITY_CODE  = '*' WHERE ACTIVITY_CODE  IS NULL;
COMMIT;

-- Then add NOT NULL constraints
ALTER TABLE AE_MEMBER_STG MODIFY SUBSC_EXCH_ID NOT NULL;
-- (repeat for other columns)
\`\`\`

After this change, all NVL wrappers in the query can be removed and standard composite indexes apply cleanly.

---

## Phase 6: SQL Plan Baseline to Lock In the Good Plan

Once the GROUP BY rewrite is validated and produces a good execution plan, lock it in using a SQL Plan Baseline to prevent the optimizer from reverting to a self-join plan in the future.

\`\`\`sql
-- Load the good plan into SPM
DECLARE
  v_plans PLS_INTEGER;
BEGIN
  v_plans := DBMS_SPM.LOAD_PLANS_FROM_CURSOR_CACHE(
    sql_id          => '&rewrite_sql_id',
    plan_hash_value => &good_phv
  );
  DBMS_OUTPUT.PUT_LINE('Plans loaded: ' || v_plans);
END;
/

-- Confirm the baseline
SELECT sql_handle, plan_name, enabled, accepted, fixed, origin, created
FROM   dba_sql_plan_baselines
WHERE  sql_text LIKE '%AE_MEMBER_STG%'
  AND  sql_text LIKE '%duplicate_groups%'
ORDER BY created DESC;
\`\`\`

---

## Monitoring Script: staging_selfj_monitor.sh

This script checks the five leading indicators of self-join staging table performance degradation. Run it every 5 minutes during batch processing windows.

\`\`\`bash
#!/bin/bash
# staging_selfj_monitor.sh
# Monitors Oracle staging table self-join query performance and index contention
# Cron: */5 * * * * /home/oracle/scripts/staging_selfj_monitor.sh >> /home/oracle/logs/staging_selfj_monitor.log 2>&1

set -euo pipefail

SCRIPT_NAME="staging_selfj_monitor"
LOG_DATE=$(date '+%Y-%m-%d %H:%M:%S')
ALERT=0

ORACLE_SID=\${ORACLE_SID:-ORCL}
ORACLE_HOME=\${ORACLE_HOME:-/u01/app/oracle/product/19.0.0/dbhome_1}
ALERT_EMAIL=\${ALERT_EMAIL:-dba-alerts@example.com}

TARGET_TABLE="AE_MEMBER_STG"
TARGET_SQL_ID=\${TARGET_SQL_ID:-5kgs7qt376697}   # Override via env variable
LONG_RUN_MINS=15          # Alert if the target SQL runs longer than this
BUFFER_BUSY_THRESHOLD=50  # Alert if buffer busy wait sample count exceeds this per check
PGA_WAIT_THRESHOLD=20     # Alert if PGA memory operation sample count exceeds this per check

export ORACLE_HOME ORACLE_SID
export PATH=\${ORACLE_HOME}/bin:\${PATH}

log() { echo "[$LOG_DATE][$SCRIPT_NAME] $1"; }

send_alert() {
  local subject="$1" body="$2"
  log "ALERT: $subject"
  echo "$body" | mail -s "[$ORACLE_SID] ALERT: $subject" "$ALERT_EMAIL" 2>/dev/null || true
}

run_sql() {
  sqlplus -s "/ as sysdba" <<SQL
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMOUT ON TRIMSPOOL ON
$1
EXIT;
SQL
}

# --- Check 1: Long-running sessions on the target SQL ---
log "=== Check 1: Long-running sessions ==="
LONG_SESSIONS=$(run_sql "
SELECT sid || '/' || serial# || ' sql=' || NVL(sql_id,'N/A') ||
       ' mins=' || ROUND((SYSDATE-sql_exec_start)*60) ||
       ' wait=' || event
FROM v\$session
WHERE status='ACTIVE'
  AND username IS NOT NULL
  AND (sql_id = '$TARGET_SQL_ID'
       OR (module LIKE '%AE_MEMBER%' AND ROUND((SYSDATE-sql_exec_start)*60) > $LONG_RUN_MINS))
  AND sql_exec_start < SYSDATE - $LONG_RUN_MINS/1440
ORDER BY sql_exec_start;
" | sed '/^$/d')

log "Long-running sessions: \${LONG_SESSIONS:-none}"
if [ -n "$LONG_SESSIONS" ]; then
  ALERT=1
  send_alert "Long-running staging query: \${TARGET_TABLE}" \
    "Session(s) running the staging self-join query beyond \${LONG_RUN_MINS} minutes:
$LONG_SESSIONS

Check the execution plan for NESTED LOOPS + E-Rows=1 (cardinality underestimate).
Consider purging the cursor cache and running with GATHER_PLAN_STATISTICS to identify the bad PHV."
fi

# --- Check 2: Buffer busy waits on the target table ---
log "=== Check 2: Buffer busy waits on \${TARGET_TABLE} ==="
BUFFER_WAITS=$(run_sql "
SELECT COUNT(*) FROM v\$active_session_history ash
JOIN dba_objects do ON do.object_id = ash.current_obj#
WHERE ash.sample_time >= SYSDATE - 5/1440
  AND ash.event = 'buffer busy waits'
  AND do.object_name IN ('\${TARGET_TABLE}','AE_MEMBER_STG_INDEX4','AE_MEMBER_STG_CUSTOM_IDX');
" | tr -d ' ')

log "Buffer busy wait samples (last 5 min): $BUFFER_WAITS (threshold: $BUFFER_BUSY_THRESHOLD)"
if [ "$BUFFER_WAITS" -gt "$BUFFER_BUSY_THRESHOLD" ]; then
  ALERT=1
  WAIT_DETAIL=$(run_sql "
SELECT do.object_name || ' (' || do.object_type || ') samples=' || COUNT(*)
FROM v\$active_session_history ash
JOIN dba_objects do ON do.object_id = ash.current_obj#
WHERE ash.sample_time >= SYSDATE - 5/1440
  AND ash.event = 'buffer busy waits'
  AND do.object_name LIKE 'AE_MEMBER%'
GROUP BY do.object_name, do.object_type
ORDER BY COUNT(*) DESC;
")
  send_alert "Buffer busy waits on \${TARGET_TABLE}: $BUFFER_WAITS samples" \
    "High buffer busy wait activity detected on \${TARGET_TABLE} in the last 5 minutes.
$WAIT_DETAIL

Low-cardinality index contention likely. Consider:
1. Rebuilding the index with INITRANS 8 PCTFREE 20
2. Making the low-cardinality index invisible to force the composite index"
fi

# --- Check 3: PGA memory operation waits (WINDOW SORT / HASH UNIQUE spill) ---
log "=== Check 3: PGA memory operation waits ==="
PGA_WAITS=$(run_sql "
SELECT COUNT(*) FROM v\$active_session_history
WHERE sample_time >= SYSDATE - 5/1440
  AND event = 'PGA memory operation'
  AND sql_id = '$TARGET_SQL_ID';
" | tr -d ' ')

log "PGA memory operation samples for \${TARGET_SQL_ID} (last 5 min): $PGA_WAITS (threshold: $PGA_WAIT_THRESHOLD)"
if [ "$PGA_WAITS" -gt "$PGA_WAIT_THRESHOLD" ]; then
  ALERT=1
  send_alert "PGA memory operation spill for staging query: $PGA_WAITS samples" \
    "The staging query sql_id=$TARGET_SQL_ID is generating $PGA_WAITS PGA memory operation samples.
This indicates a WINDOW SORT or HASH UNIQUE operation is exceeding the PGA work area.

This is the fingerprint of the self-join + analytic COUNT pattern materializing too much data.
The permanent fix is the GROUP BY/HAVING rewrite. See the runbook for the validated alternative SQL."
fi

# --- Check 4: Plan Hash Value drift (new bad plan appeared) ---
log "=== Check 4: PHV drift for target SQL ==="
PHV_COUNT=$(run_sql "
SELECT COUNT(DISTINCT sql_plan_hash_value) FROM v\$sql
WHERE sql_id = '$TARGET_SQL_ID';
" | tr -d ' ')

PHV_LIST=$(run_sql "
SELECT sql_plan_hash_value || ' child=' || child_number ||
       ' gets=' || buffer_gets || ' elapsed=' || ROUND(elapsed_time/1e6) || 's'
FROM v\$sql
WHERE sql_id = '$TARGET_SQL_ID'
ORDER BY last_active_time DESC;
" | sed '/^$/d')

log "PHV count for \${TARGET_SQL_ID}: $PHV_COUNT"
log "PHV list: \${PHV_LIST:-none}"
if [ "$PHV_COUNT" -gt 2 ]; then
  ALERT=1
  send_alert "PHV proliferation for staging query: $PHV_COUNT plans" \
    "The staging query sql_id=$TARGET_SQL_ID has $PHV_COUNT plan hash values in the cursor cache.
This indicates bind variable peeking or adaptive plan instability.

Plan list:
$PHV_LIST

Consider creating a SQL Plan Baseline on the known-good PHV to prevent further plan drift."
fi

# --- Check 5: Staging table 'N' row count (data volume trend) ---
log "=== Check 5: Staging table active row count ==="
N_ROWS=$(run_sql "
SELECT COUNT(*) FROM AEUSER.AE_MEMBER_STG WHERE MEMBER_LOAD_STATUS='N';
" | tr -d ' ')

log "AE_MEMBER_STG rows with status N: $N_ROWS"
if [ -n "$N_ROWS" ] && [ "$N_ROWS" -gt 10000 ]; then
  log "WARNING: N-row count ($N_ROWS) is elevated — self-join will scale quadratically"
  if [ "$N_ROWS" -gt 50000 ]; then
    ALERT=1
    send_alert "Staging table N-row count critical: $N_ROWS rows" \
      "AE_MEMBER_STG has $N_ROWS rows with MEMBER_LOAD_STATUS='N'.
The self-join duplicate check scales as O(N^2) on this population.
At this volume, the original SQL will likely run for hours.

Immediate options:
1. Process files in smaller batches (reduce N-row count per run)
2. Deploy the GROUP BY/HAVING rewrite before the next batch run
3. Make AE_MEMBER_STG_INDEX4 invisible to force the composite index"
  fi
fi

# --- Summary ---
log "=== Summary ==="
log "Long sessions: \${LONG_SESSIONS:+yes}\${LONG_SESSIONS:-none} | Buffer waits: $BUFFER_WAITS | PGA waits: $PGA_WAITS | PHV count: $PHV_COUNT | N-rows: \${N_ROWS:-N/A}"
[ "$ALERT" -eq 0 ] && log "STATUS: OK" || log "STATUS: ALERT SENT"
\`\`\`

### Deploy and schedule

\`\`\`bash
mkdir -p /home/oracle/scripts /home/oracle/logs
cp staging_selfj_monitor.sh /home/oracle/scripts/
chmod 750 /home/oracle/scripts/staging_selfj_monitor.sh

# Set the target SQL_ID as an environment variable if it changes after the rewrite
# export TARGET_SQL_ID=<new_sql_id>

(crontab -l 2>/dev/null; echo "*/5 * * * * /home/oracle/scripts/staging_selfj_monitor.sh >> /home/oracle/logs/staging_selfj_monitor.log 2>&1") | crontab -
\`\`\`

---

## Quick Reference

| Symptom | Phase |
|---------|-------|
| Session running 15+ min, no blocking | Phase 1 — get PHV history from ASH |
| E-Rows = 1 but A-Rows = millions | Phase 1.4 — cardinality underestimate |
| Buffer busy waits on index blocks | Phase 2.1 + Phase 3.2 — INITRANS rebuild |
| PGA memory operation waits | Phase 2.1 + Phase 4 — GROUP BY rewrite |
| SQL fast in SQL*Plus, slow in package | Phase 1.3 — bind peeking / adaptive plan; Phase 3.1 — purge cursor |
| Multiple PHVs, unstable plan | Phase 3.1 + Phase 6 — SQL Plan Baseline |
| Staging table N-row count growing | Phase 5.3 — enforce NOT NULL at ingestion |

---

## Key Views Reference

| View | Purpose |
|------|---------|
| \`V\$ACTIVE_SESSION_HISTORY\` | Per-PHV execution duration history, wait event breakdown |
| \`V\$SQL\` | Current cursor cache with plan hash values and execution stats |
| \`V\$SESSION_WAIT\` | Real-time wait events for a specific session |
| \`DBA_HIST_SQLSTAT\` | AWR history of SQL performance by PHV |
| \`DBA_TAB_COL_STATISTICS\` | Column NDV and density — check cardinality assumptions |
| \`DBA_SQL_PLAN_BASELINES\` | SQL Plan Management baselines for plan stability |
| \`DBMS_XPLAN.DISPLAY_CURSOR\` | Full plan with ALLSTATS LAST showing actual vs. estimated rows |`,
};

async function main() {
  console.log('Inserting self-join staging table runbook...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: {
      title: post.title,
      excerpt: post.excerpt,
      content: post.content,
      category: post.category,
      published: post.published,
      isPremium: post.isPremium,
      publishedAt: post.publishedAt,
      youtubeUrl: post.youtubeUrl,
    },
  });
  console.log('Inserted:', JSON.stringify(post.title));
}

main().catch(console.error);
