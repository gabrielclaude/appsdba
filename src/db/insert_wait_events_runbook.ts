import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Wait Event Diagnosis and Tuning',
  slug: 'oracle-wait-events-tuning-runbook',
  excerpt:
    'A phased operational runbook for diagnosing Oracle wait events from live V$ views through historical AWR/ASH analysis, covering User I/O, Commit, Concurrency, Network, and RAC Cluster waits with production-ready SQL at each step. Includes a Nagios-compatible shell monitoring script that checks log file sync latency, I/O wait times, row lock blocking chains, and library cache contention on a 10-minute cron schedule with email alerting.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-05'),
  youtubeUrl: null,
  content: `# Runbook: Oracle Wait Event Diagnosis and Tuning

## Overview

This runbook provides a structured, phased approach to diagnosing and resolving Oracle wait event performance problems. Work through the phases sequentially during an active incident, or use individual phases for targeted investigation of specific wait categories.

**Assumptions:**
- Oracle 12.2 or later (19c recommended)
- Minimum privilege: DBA role for V$ and DBA_HIST views
- Diagnostics Pack licensed for AWR and ASH queries (\`DBA_HIST_*\`, \`V\$ACTIVE_SESSION_HISTORY\`)
- SYSDBA required for some initialization parameter checks
- RAC phases assume access to GV$ views from any node

**Variable placeholders used throughout:**
- \`&start_snap\` / \`&end_snap\` — AWR snapshot IDs for the problem window
- \`&start_time\` / \`&end_time\` — timestamp range for ASH queries
- \`&wait_event_name\` — specific wait event name (e.g., \`db file sequential read\`)

---

## Phase 0: System-Level Wait Profile

Begin every performance investigation here. Establish the current wait profile before drilling into any specific event.

### Step 0.1 — Current top wait events (live)

\`\`\`sql
SELECT event,
       wait_class,
       total_waits,
       round(time_waited / 100, 2)    AS time_waited_sec,
       round(average_wait / 100, 4)   AS avg_wait_sec,
       round(time_waited * 100.0 /
             nullif(sum(time_waited) OVER (), 0), 2) AS pct_db_time
FROM   v\$system_event
WHERE  wait_class != 'Idle'
ORDER  BY time_waited DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

> **Interpretation:** Focus on events with the highest \`time_waited_sec\`, not the highest \`total_waits\`. An event with 1 billion waits at 0.0001s average is less important than one with 5,000 waits at 0.5s average. The \`pct_db_time\` column puts each event in context — only events in your top 3 by percentage are worth tuning.

---

### Step 0.2 — DB time model breakdown (live)

\`\`\`sql
SELECT stat_name,
       round(value / 1e6, 2) AS seconds
FROM   v\$sys_time_model
WHERE  stat_name IN (
  'DB time',
  'DB CPU',
  'sql execute elapsed time',
  'parse time elapsed',
  'hard parse elapsed time',
  'PL/SQL execution elapsed time',
  'connection management call elapsed time',
  'background elapsed time'
)
ORDER  BY value DESC;
\`\`\`

> **Interpretation:** \`DB time\` is the sum of all foreground CPU + wait time. \`DB CPU\` shows pure compute. If \`hard parse elapsed time\` is more than a few percent of DB time, cursor sharing is a problem. If \`DB time\` is dominated by \`sql execute elapsed time\` that aligns with a specific wait class, proceed to that phase.

---

### Step 0.3 — Active session breakdown right now (ASH)

\`\`\`sql
SELECT event,
       wait_class,
       session_state,
       count(*)                                                  AS samples,
       round(count(*) * 100.0 / sum(count(*)) OVER (), 2)       AS pct
FROM   v\$active_session_history
WHERE  sample_time > sysdate - 10/1440
  AND  session_type = 'FOREGROUND'
GROUP  BY event, wait_class, session_state
ORDER  BY samples DESC
FETCH FIRST 15 ROWS ONLY;
\`\`\`

> **Interpretation:** This covers the last 10 minutes of ASH samples. A \`session_state\` of \`ON CPU\` with no event is pure CPU consumption. Events with many samples are where active sessions have been spending their time right now.

---

## Phase 1: AWR Wait Event Analysis (Historical)

Use these queries when investigating a past performance event — a specific time window when users reported slowness.

### Step 1.1 — Top waits for a snapshot range

\`\`\`sql
SELECT e.event_name,
       e.wait_class,
       sum(e.total_waits_fg)                              AS total_waits,
       round(sum(e.time_waited_fg) / 1e6, 2)             AS time_waited_sec,
       round(sum(e.time_waited_fg) /
             nullif(sum(e.total_waits_fg), 0) / 1e3, 3)  AS avg_wait_ms
FROM   dba_hist_system_event e
WHERE  e.snap_id    BETWEEN &start_snap AND &end_snap
  AND  e.wait_class != 'Idle'
GROUP  BY e.event_name, e.wait_class
ORDER  BY sum(e.time_waited_fg) DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

---

### Step 1.2 — DB time model from AWR

\`\`\`sql
SELECT stat_name,
       round(sum(value) / 1e6, 2) AS seconds
FROM   dba_hist_sys_time_model
WHERE  snap_id   BETWEEN &start_snap AND &end_snap
  AND  stat_name IN (
    'DB time',
    'DB CPU',
    'sql execute elapsed time',
    'parse time elapsed',
    'hard parse elapsed time',
    'PL/SQL execution elapsed time'
  )
GROUP  BY stat_name
ORDER  BY sum(value) DESC;
\`\`\`

---

### Step 1.3 — Top SQL driving a specific wait event (via ASH history)

\`\`\`sql
SELECT ash.sql_id,
       count(*) * 10                                   AS est_db_time_sec,
       max(t.sql_text)                                 AS sql_text
FROM   dba_hist_active_sess_history ash
LEFT   JOIN dba_hist_sqltext t
         ON t.sql_id = ash.sql_id
        AND t.dbid   = ash.dbid
WHERE  ash.sample_time BETWEEN to_timestamp('&start_time', 'YYYY-MM-DD HH24:MI')
                           AND to_timestamp('&end_time',   'YYYY-MM-DD HH24:MI')
  AND  ash.event        = '&wait_event_name'
  AND  ash.session_type = 'FOREGROUND'
  AND  ash.sql_id       IS NOT NULL
GROUP  BY ash.sql_id
ORDER  BY count(*) DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

> **Note:** Each ASH sample represents approximately 10 seconds of DB time (1-second sampling * 10s approximation factor). Multiply sample count by 10 to estimate total elapsed seconds contributed by that SQL to the wait event.

---

## Phase 2: User I/O Diagnostics

### Step 2.1 — Average I/O wait times by event

\`\`\`sql
SELECT event,
       total_waits,
       round(time_waited / 100.0 / nullif(total_waits, 0), 4) AS avg_wait_sec,
       round(time_waited / 100.0, 2)                          AS total_sec
FROM   v\$system_event
WHERE  event IN (
  'db file sequential read',
  'db file scattered read',
  'direct path read',
  'direct path read temp',
  'direct path write temp'
)
ORDER  BY time_waited DESC;
\`\`\`

> **Thresholds:** \`avg_wait_sec\` < 0.001 = NVMe / top-tier flash. 0.001–0.005 = SAN flash array. 0.005–0.020 = spinning disk or overloaded array. > 0.020 = storage problem requiring urgent investigation.

---

### Step 2.2 — Top segments causing physical I/O (AWR)

\`\`\`sql
SELECT object_name,
       object_type,
       tablespace_name,
       sum(logical_reads_delta)  AS logical_reads,
       sum(physical_reads_delta) AS physical_reads,
       sum(physical_writes_delta) AS physical_writes
FROM   dba_hist_seg_stat       s
JOIN   dba_hist_seg_stat_obj   o
    ON o.obj# = s.obj#
   AND o.dbid = s.dbid
WHERE  s.snap_id BETWEEN &start_snap AND &end_snap
GROUP  BY object_name, object_type, tablespace_name
ORDER  BY sum(physical_reads_delta) DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

> **Follow-up:** For any large table appearing here, check whether full table scans are intentional or a plan regression. Compare \`dba_hist_sql_plan\` between a healthy snapshot range and the problem window for SQL accessing this object.

---

### Step 2.3 — TEMP space usage and spill detection

\`\`\`sql
SELECT sql_id,
       operation_type,
       policy,
       round(estimated_optimal_size / 1048576, 1)  AS optimal_mb,
       round(last_memory_used / 1048576, 1)         AS used_mb,
       last_execution,
       active_time / 1e6                            AS active_sec
FROM   v\$sql_workarea
WHERE  last_execution != 'OPTIMAL'
ORDER  BY last_memory_used DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

> **Interpretation:** \`last_execution = 'ONEPASS'\` means the operation used one pass over TEMP (tolerable but slower). \`'MULTIPASS'\` means multiple passes — severely degraded performance. Increase \`PGA_AGGREGATE_TARGET\` or tune the SQL to reduce sort/hash memory demand.

---

### Step 2.4 — PGA aggregate tuning check

\`\`\`sql
SELECT name, round(value / 1048576, 1) AS mb
FROM   v\$pgastat
WHERE  name IN (
  'aggregate PGA target parameter',
  'aggregate PGA auto target',
  'total PGA inuse',
  'total PGA allocated',
  'total freeable PGA memory',
  'cache hit percentage'
);
\`\`\`

> **Target:** \`cache hit percentage\` should be >= 95%. Below 90% means significant PGA work area spill. If \`total PGA allocated\` is close to or exceeds \`aggregate PGA target parameter\`, the target is undersized for the workload.

---

## Phase 3: Commit and Redo Diagnostics

### Step 3.1 — Log file sync average wait time

\`\`\`sql
SELECT event,
       total_waits,
       round(time_waited / 100.0 / nullif(total_waits, 0), 4) AS avg_wait_sec,
       round(time_waited / 100.0, 2)                          AS total_sec
FROM   v\$system_event
WHERE  event IN (
  'log file sync',
  'log file parallel write',
  'log buffer space',
  'log file switch (checkpoint incomplete)',
  'log file switch completion'
)
ORDER  BY time_waited DESC;
\`\`\`

> **Thresholds for \`log file sync\` avg_wait_sec:** < 0.001 = excellent (NVMe). < 0.005 = acceptable. > 0.010 = problem — investigate redo log storage. If \`log file parallel write\` avg is close to \`log file sync\` avg, LGWR I/O is the bottleneck. If \`log file sync\` >> \`log file parallel write\`, there is CPU scheduling or post-wait notification latency.

---

### Step 3.2 — Check redo log configuration

\`\`\`sql
SELECT l.group#,
       l.members,
       l.bytes / 1048576  AS size_mb,
       l.status,
       l.archived,
       f.member           AS log_file_path
FROM   v\$log     l
JOIN   v\$logfile f ON f.group# = l.group#
ORDER  BY l.group#;
\`\`\`

> **Guidance:** Redo log size should be large enough that log switches occur no more than 4–6 times per hour under normal load. Logs smaller than 500MB on a busy OLTP system typically cause excessive switching. All redo log members should be on dedicated fast storage — not shared with datafiles or archive logs.

---

### Step 3.3 — Redo log I/O latency (OS-level check)

\`\`\`bash
# Identify the filesystem/device hosting redo logs from Step 3.2,
# then check its I/O latency with iostat.
# Target: await < 1ms for redo log devices.

# Check I/O statistics for all block devices (5 samples, 1-second interval)
iostat -x 1 5

# If using NVMe:
# iostat -x 1 5 | grep -E 'Device|nvme'

# If on SAN with dm-multipath:
# iostat -x 1 5 | grep -E 'Device|dm-'

# Key column: await (average I/O wait time in ms)
# If await > 5ms on redo log device — investigate storage queue depth,
# competing workloads on the same device, and HBA/fabric congestion.
\`\`\`

---

### Step 3.4 — Identify high-commit-frequency SQL

\`\`\`sql
SELECT s.sql_id,
       s.executions,
       s.end_of_fetch_count,
       round(s.elapsed_time / 1e6, 2)      AS elapsed_sec,
       s.user_io_wait_time / 1e6           AS user_io_sec,
       s.concurrency_wait_time / 1e6       AS concurrency_sec,
       substr(t.sql_text, 1, 100)          AS sql_text
FROM   v\$sql       s
JOIN   v\$sqltext   t ON t.sql_id = s.sql_id AND t.piece = 0
WHERE  s.executions > 100
  AND  s.user_io_wait_time > 0
ORDER  BY s.user_io_wait_time DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

> **Context:** High \`user_io_wait_time\` on DML statements (INSERT/UPDATE/DELETE) executing millions of times can indicate row-by-row commits inside application loops. Review the application code for commit calls inside loops — consolidate to batch commits of 1,000–10,000 rows per commit.

---

## Phase 4: Concurrency and Latch Diagnostics

### Step 4.1 — Top latch waits

\`\`\`sql
SELECT name,
       gets,
       misses,
       round(misses * 100.0 / nullif(gets, 0), 4) AS miss_pct,
       sleeps,
       spin_gets
FROM   v\$latch
WHERE  misses > 0
ORDER  BY misses DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

> **Thresholds:** \`miss_pct\` < 0.5% is normal. Above 1% indicates contention. Above 5% is a performance problem. Check \`cache buffers chains\` (hot blocks), \`shared pool\` (hard parsing), and \`library cache\` (cursor invalidation or DDL contention).

---

### Step 4.2 — Hot blocks causing CBC latch contention

\`\`\`sql
SELECT ash.current_obj#,
       o.object_name,
       o.object_type,
       count(*) AS samples
FROM   v\$active_session_history  ash
LEFT   JOIN dba_objects           o ON o.object_id = ash.current_obj#
WHERE  ash.sample_time > sysdate - 30/1440
  AND  ash.event = 'latch: cache buffers chains'
GROUP  BY ash.current_obj#, o.object_name, o.object_type
ORDER  BY count(*) DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

> **Follow-up:** For a hot sequence block (\`object_type = 'SEQUENCE'\`), increase the CACHE value: \`ALTER SEQUENCE seq_name CACHE 500;\`. For a hot table block (high-DML header), check if ASSM is enabled. For a hot index root block on a surrogate key sequence column, consider hash partitioning the index.

---

### Step 4.3 — Row lock contention — identify blocking chains

\`\`\`sql
SELECT h.session_id                AS waiter_sid,
       h.blocking_session          AS blocker_sid,
       h.event,
       h.sql_id                    AS waiter_sql_id,
       h.seconds_in_wait,
       sw.username                 AS waiter_user,
       sb.username                 AS blocker_user,
       sb.status                   AS blocker_status,
       sb.sql_id                   AS blocker_sql_id,
       sb.module                   AS blocker_module
FROM   v\$session_wait  h
JOIN   v\$session        sw ON sw.sid = h.session_id
JOIN   v\$session        sb ON sb.sid = h.blocking_session
WHERE  h.blocking_session IS NOT NULL
ORDER  BY h.seconds_in_wait DESC;
\`\`\`

> **Immediate action:** If \`seconds_in_wait\` > 60 and the blocker is INACTIVE (session connected but not executing), the blocking transaction may be abandoned or stuck. Identify the blocker's OS process and application, then escalate to the application team or kill the blocking session if authorised: \`ALTER SYSTEM KILL SESSION 'sid,serial#' IMMEDIATE;\`

---

### Step 4.4 — Library cache lock / pin waits

\`\`\`sql
SELECT s.sid,
       s.username,
       s.event,
       s.seconds_in_wait,
       s.p1,
       s.p2,
       o.object_name,
       o.object_type
FROM   v\$session   s
LEFT   JOIN dba_objects o ON o.object_id = s.row_wait_obj#
WHERE  s.event IN ('library cache lock', 'library cache pin')
ORDER  BY s.seconds_in_wait DESC;
\`\`\`

> **Context:** If multiple sessions wait on the same object simultaneously during application deployment, a DDL statement (COMPILE, GRANT, DROP) may be running against a heavily-used object. Check \`v\$session\` for sessions running DDL. If hard parsing is the cause (many distinct literal SQL statements), enable cursor sharing: \`ALTER SYSTEM SET cursor_sharing = FORCE;\` as a temporary measure while the application is fixed to use bind variables.

---

### Step 4.5 — Enqueue (lock type) breakdown

\`\`\`sql
SELECT event,
       total_waits,
       round(time_waited / 100.0, 2)                            AS total_sec,
       round(time_waited / 100.0 / nullif(total_waits, 0), 4)  AS avg_sec
FROM   v\$system_event
WHERE  event LIKE 'enq:%'
  AND  wait_class = 'Application'
ORDER  BY time_waited DESC
FETCH FIRST 15 ROWS ONLY;
\`\`\`

> **Common enqueue types:** \`enq: TX\` = row lock (application design issue). \`enq: TM\` = table-level lock (missing FK index — add index on FK column). \`enq: HW\` = high-water mark contention (pre-allocate extents or use APPEND). \`enq: ST\` = space management (consider ASSM). \`enq: CF\` = controlfile transaction (excessive checkpoint activity).

---

## Phase 5: Network Wait Diagnostics

### Step 5.1 — SQL*Net wait event summary

\`\`\`sql
SELECT event,
       total_waits,
       round(time_waited / 100.0, 2)                             AS total_sec,
       round(time_waited / 100.0 / nullif(total_waits, 0), 6)   AS avg_sec
FROM   v\$system_event
WHERE  event LIKE 'SQL*Net%'
ORDER  BY time_waited DESC;
\`\`\`

> **Key distinction:** \`SQL*Net message from client\` is an idle wait — the server is waiting for the client to send work. High total time here means client think time, not database latency. \`SQL*Net message to client\` means the server is waiting for the client to consume data — the client may be processing rows too slowly or the network pipe is saturated.

---

### Step 5.2 — Identify sessions with high SQL\*Net message from client (idle time)

\`\`\`sql
SELECT s.sid,
       s.username,
       s.module,
       s.action,
       s.program,
       se.total_waits,
       round(se.time_waited / 100.0, 2) AS waited_sec
FROM   v\$session       s
JOIN   v\$session_event se ON se.sid = s.sid
WHERE  se.event   = 'SQL*Net message from client'
  AND  s.status   = 'INACTIVE'
ORDER  BY se.time_waited DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

> **Action:** INACTIVE sessions with large \`waited_sec\` are connected but idle. If these sessions are holding row locks (check Phase 4.3), they are a problem. Otherwise, they indicate a connection pool that is keeping connections open beyond their useful lifetime — review connection pool minimum/maximum sizing and idle timeout settings.

---

## Phase 6: RAC Cluster Wait Diagnostics

*Skip this phase for single-instance databases.*

### Step 6.1 — Global cache wait summary

\`\`\`sql
SELECT event,
       total_waits,
       round(time_waited / 100.0, 2)                            AS total_sec,
       round(time_waited / 100.0 / nullif(total_waits, 0), 4)  AS avg_sec
FROM   gv\$system_event
WHERE  event      LIKE 'gc%'
  AND  wait_class  = 'Cluster'
ORDER  BY time_waited DESC
FETCH FIRST 15 ROWS ONLY;
\`\`\`

> **Thresholds for gc cr / gc current avg_sec:** < 0.001s (1ms) = healthy interconnect. 0.001–0.003s = monitor closely. > 0.005s = investigate interconnect congestion, NIC saturation, or OS network configuration (jumbo frames, interrupt affinity).

---

### Step 6.2 — Cache Fusion block transfer performance

\`\`\`sql
SELECT inst_id,
       round(
         sum(CASE WHEN name = 'gc cr block receive time'     THEN value END) /
         nullif(sum(CASE WHEN name = 'gc cr blocks received' THEN value END), 0),
         2
       ) AS avg_cr_cs,
       round(
         sum(CASE WHEN name = 'gc current block receive time'     THEN value END) /
         nullif(sum(CASE WHEN name = 'gc current blocks received' THEN value END), 0),
         2
       ) AS avg_current_cs
FROM   gv\$sysstat
WHERE  name IN (
  'gc cr block receive time',
  'gc cr blocks received',
  'gc current block receive time',
  'gc current blocks received'
)
GROUP  BY inst_id
ORDER  BY inst_id;
-- Values are in centiseconds (cs). Target: < 1.0 cs (10ms) per transfer.
-- Healthy 10GbE interconnect typically shows 0.1–0.3 cs.
\`\`\`

---

### Step 6.3 — Top objects causing gc waits (ASH)

\`\`\`sql
SELECT o.object_name,
       o.object_type,
       ash.event,
       count(*) AS samples
FROM   v\$active_session_history  ash
JOIN   dba_objects                 o ON o.object_id = ash.current_obj#
WHERE  ash.sample_time > sysdate - 30/1440
  AND  ash.event LIKE 'gc%'
GROUP  BY o.object_name, o.object_type, ash.event
ORDER  BY count(*) DESC
FETCH FIRST 15 ROWS ONLY;
\`\`\`

> **Action:** Objects with high gc wait sample counts are being accessed across multiple RAC nodes simultaneously. Consider: (1) routing all sessions for this object's application module to a single node using a dedicated service; (2) partitioning the table and using partition-wise joins with node affinity; (3) for read-mostly reference tables, enabling result cache to eliminate inter-node block transfers.

---

## Phase 7: Wait Event Monitoring Shell Script

Save as \`/u01/app/oracle/scripts/wait_monitor/wait_event_monitor.sh\` and make executable with \`chmod 750\`.

\`\`\`bash
#!/bin/bash
# =============================================================================
# wait_event_monitor.sh
# Oracle Wait Event Monitor — checks key wait thresholds and alerts on issues.
#
# Usage:   wait_event_monitor.sh <ORACLE_SID> [<TNS_ALIAS>]
# Returns: exit code = number of issues found (Nagios-compatible)
#          0 = OK, 1 = WARNING, 2+ = issues (WARNING or CRITICAL mix)
#
# Alerts checked:
#   1. Top 5 non-idle wait events by time_waited
#   2. log file sync avg wait time  (WARN > 5ms, CRIT > 10ms)
#   3. db file sequential read avg  (WARN > 5ms, CRIT > 15ms)
#   4. Row lock blocking chains > 60 seconds
#   5. Library cache lock/pin waits > 30 seconds
# =============================================================================
set -euo pipefail

# ── Arguments ────────────────────────────────────────────────────────────────
ORACLE_SID=\${1:-""}
TNS_ALIAS=\${2:-""}

if [[ -z "\${ORACLE_SID}" ]]; then
  echo "Usage: \$0 <ORACLE_SID> [<TNS_ALIAS>]"
  exit 1
fi

# ── Environment ───────────────────────────────────────────────────────────────
ORACLE_HOME=\${ORACLE_HOME:-/u01/app/oracle/product/19.0.0/dbhome_1}
export ORACLE_SID ORACLE_HOME
PATH=\${ORACLE_HOME}/bin:\${PATH}

# ── Directories and log file ──────────────────────────────────────────────────
LOG_BASE=/u01/app/oracle/scripts/wait_monitor/logs
mkdir -p "\${LOG_BASE}"
TIMESTAMP=\$(date +%Y%m%d_%H%M%S)
LOGFILE=\${LOG_BASE}/wait_monitor_\${ORACLE_SID}_\${TIMESTAMP}.log
ALERT_EMAIL=\${ALERT_EMAIL:-"dba@example.com"}
ISSUES=0

exec > >(tee -a "\${LOGFILE}") 2>&1

echo "============================================================"
echo "Oracle Wait Event Monitor"
echo "SID       : \${ORACLE_SID}"
echo "Timestamp : \${TIMESTAMP}"
echo "Log       : \${LOGFILE}"
echo "============================================================"
echo ""

# ── Connection string ─────────────────────────────────────────────────────────
if [[ -n "\${TNS_ALIAS}" ]]; then
  CONNECT_STR="/@\${TNS_ALIAS} as sysdba"
else
  CONNECT_STR="/ as sysdba"
fi

# ── Helper: run sqlplus and capture output ────────────────────────────────────
run_sql() {
  sqlplus -s "\${CONNECT_STR}" <<'SQLEOF_WRAPPER'
set pagesize 0 feedback off heading off trimout on trimspool on
SQLEOF_WRAPPER
}

# =============================================================================
# CHECK 1: Top 5 Non-Idle Wait Events
# =============================================================================
echo "──────────────────────────────────────────────────────────────"
echo "CHECK 1: Top 5 Non-Idle Wait Events (cumulative since startup)"
echo "──────────────────────────────────────────────────────────────"

sqlplus -s "\${CONNECT_STR}" <<'SQLEOF'
set lines 140 pages 50 feedback off
col event           format a45
col wait_class      format a18
col total_waits     format 9,999,999,999
col time_waited_sec format 99,999,990.00
col avg_wait_sec    format 990.0000
SELECT event,
       wait_class,
       total_waits,
       round(time_waited / 100, 2)                       AS time_waited_sec,
       round(average_wait / 100, 4)                      AS avg_wait_sec
FROM   v\$system_event
WHERE  wait_class != 'Idle'
ORDER  BY time_waited DESC
FETCH FIRST 5 ROWS ONLY;
exit;
SQLEOF

echo ""

# =============================================================================
# CHECK 2: log file sync — Commit Latency
# =============================================================================
echo "──────────────────────────────────────────────────────────────"
echo "CHECK 2: log file sync Average Wait Time"
echo "  WARN threshold : 5ms  (0.005 s)"
echo "  CRIT threshold : 10ms (0.010 s)"
echo "──────────────────────────────────────────────────────────────"

LFS_AVG=\$(sqlplus -s "\${CONNECT_STR}" <<'SQLEOF'
set pages 0 feedback off heading off
SELECT round(average_wait / 100, 6)
FROM   v\$system_event
WHERE  event = 'log file sync';
exit;
SQLEOF
)
LFS_AVG=\$(echo "\${LFS_AVG}" | tr -d ' \n')

if [[ -z "\${LFS_AVG}" || "\${LFS_AVG}" == "no rows selected" ]]; then
  echo "[INFO ] log file sync: no data (0 commits recorded)"
else
  echo "[INFO ] log file sync avg wait: \${LFS_AVG} s"
  # awk arithmetic comparison (bc alternative, portable)
  if awk "BEGIN {exit !(\${LFS_AVG} > 0.010)}"; then
    echo "[CRITICAL] log file sync avg \${LFS_AVG}s > 10ms threshold"
    echo "           ACTION: Move redo logs to dedicated NVMe / fast SAN LUN"
    echo "           CHECK : v\$log for redo log file paths"
    echo "           CHECK : iostat for redo log device await time"
    ISSUES=\$((ISSUES + 1))
  elif awk "BEGIN {exit !(\${LFS_AVG} > 0.005)}"; then
    echo "[WARNING ] log file sync avg \${LFS_AVG}s > 5ms threshold"
    echo "           MONITOR: redo log I/O, application commit frequency"
    ISSUES=\$((ISSUES + 1))
  else
    echo "[OK    ] log file sync avg \${LFS_AVG}s — within threshold"
  fi
fi
echo ""

# =============================================================================
# CHECK 3: db file sequential read — Single-Block I/O Latency
# =============================================================================
echo "──────────────────────────────────────────────────────────────"
echo "CHECK 3: db file sequential read Average Wait Time"
echo "  WARN threshold : 5ms  (0.005 s)"
echo "  CRIT threshold : 15ms (0.015 s)"
echo "──────────────────────────────────────────────────────────────"

SEQR_AVG=\$(sqlplus -s "\${CONNECT_STR}" <<'SQLEOF'
set pages 0 feedback off heading off
SELECT round(average_wait / 100, 6)
FROM   v\$system_event
WHERE  event = 'db file sequential read';
exit;
SQLEOF
)
SEQR_AVG=\$(echo "\${SEQR_AVG}" | tr -d ' \n')

if [[ -z "\${SEQR_AVG}" || "\${SEQR_AVG}" == "no rows selected" ]]; then
  echo "[INFO ] db file sequential read: no data"
else
  echo "[INFO ] db file sequential read avg wait: \${SEQR_AVG} s"
  if awk "BEGIN {exit !(\${SEQR_AVG} > 0.015)}"; then
    echo "[CRITICAL] db file sequential read avg \${SEQR_AVG}s > 15ms threshold"
    echo "           ACTION: Investigate storage subsystem — SAN queue depth,"
    echo "                   competing I/O workloads, HBA/fabric congestion"
    ISSUES=\$((ISSUES + 1))
  elif awk "BEGIN {exit !(\${SEQR_AVG} > 0.005)}"; then
    echo "[WARNING ] db file sequential read avg \${SEQR_AVG}s > 5ms threshold"
    echo "           MONITOR: storage latency trend, parallel backup/RMAN activity"
    ISSUES=\$((ISSUES + 1))
  else
    echo "[OK    ] db file sequential read avg \${SEQR_AVG}s — within threshold"
  fi
fi
echo ""

# =============================================================================
# CHECK 4: Row Lock Blocking Chains > 60 seconds
# =============================================================================
echo "──────────────────────────────────────────────────────────────"
echo "CHECK 4: Row Lock Blocking Chains (enq: TX > 60 seconds)"
echo "──────────────────────────────────────────────────────────────"

BLOCKER_COUNT=\$(sqlplus -s "\${CONNECT_STR}" <<'SQLEOF'
set pages 0 feedback off heading off
SELECT count(*)
FROM   v\$session_wait  w
JOIN   v\$session        s ON s.sid = w.blocking_session
WHERE  w.event LIKE 'enq: TX%'
  AND  w.blocking_session IS NOT NULL
  AND  w.seconds_in_wait  > 60;
exit;
SQLEOF
)
BLOCKER_COUNT=\$(echo "\${BLOCKER_COUNT}" | tr -d ' \n')

if [[ "\${BLOCKER_COUNT:-0}" -gt 0 ]]; then
  echo "[CRITICAL] \${BLOCKER_COUNT} blocking session(s) holding TX lock > 60 seconds"
  ISSUES=\$((ISSUES + 1))

  sqlplus -s "\${CONNECT_STR}" <<'SQLEOF'
set lines 160 pages 50 feedback off
col waiter_user   format a15
col blocker_user  format a15
col blocker_mod   format a20
col waiter_sql    format a15
col blocker_sql   format a15
SELECT w.session_id                AS waiter_sid,
       w.blocking_session          AS blocker_sid,
       w.seconds_in_wait           AS secs_waiting,
       sw.username                 AS waiter_user,
       sb.username                 AS blocker_user,
       sb.status                   AS blocker_status,
       sw.sql_id                   AS waiter_sql,
       sb.sql_id                   AS blocker_sql,
       sb.module                   AS blocker_mod
FROM   v\$session_wait  w
JOIN   v\$session        sw ON sw.sid = w.session_id
JOIN   v\$session        sb ON sb.sid = w.blocking_session
WHERE  w.event LIKE 'enq: TX%'
  AND  w.blocking_session IS NOT NULL
  AND  w.seconds_in_wait  > 60
ORDER  BY w.seconds_in_wait DESC;
exit;
SQLEOF

  echo ""
  echo "  To kill blocker: ALTER SYSTEM KILL SESSION 'sid,serial#' IMMEDIATE;"
  echo "  Get serial#: SELECT sid, serial# FROM v\\\$session WHERE sid = <blocker_sid>;"
else
  echo "[OK    ] No TX blocking chains > 60 seconds"
fi
echo ""

# =============================================================================
# CHECK 5: Library Cache Lock / Pin Waits > 30 seconds
# =============================================================================
echo "──────────────────────────────────────────────────────────────"
echo "CHECK 5: Library Cache Lock / Pin Waits > 30 seconds"
echo "──────────────────────────────────────────────────────────────"

LC_COUNT=\$(sqlplus -s "\${CONNECT_STR}" <<'SQLEOF'
set pages 0 feedback off heading off
SELECT count(*)
FROM   v\$session
WHERE  event IN ('library cache lock', 'library cache pin')
  AND  seconds_in_wait > 30;
exit;
SQLEOF
)
LC_COUNT=\$(echo "\${LC_COUNT}" | tr -d ' \n')

if [[ "\${LC_COUNT:-0}" -gt 0 ]]; then
  echo "[WARNING ] \${LC_COUNT} session(s) waiting on library cache lock/pin > 30 seconds"
  ISSUES=\$((ISSUES + 1))

  sqlplus -s "\${CONNECT_STR}" <<'SQLEOF'
set lines 140 pages 50 feedback off
col username  format a15
col event     format a25
col obj_name  format a30
col obj_type  format a15
SELECT s.sid,
       s.username,
       s.event,
       s.seconds_in_wait,
       o.object_name   AS obj_name,
       o.object_type   AS obj_type
FROM   v\$session    s
LEFT   JOIN dba_objects o ON o.object_id = s.row_wait_obj#
WHERE  s.event IN ('library cache lock', 'library cache pin')
  AND  s.seconds_in_wait > 30
ORDER  BY s.seconds_in_wait DESC;
exit;
SQLEOF

  echo ""
  echo "  Likely cause: DDL running against a heavily-used object, or cursor"
  echo "  sharing failure causing massive hard parsing under load."
  echo "  Check: SELECT sid, username, sql_id, status FROM v\\\$session"
  echo "         WHERE status='ACTIVE' AND last_call_et < 120;"
else
  echo "[OK    ] No library cache lock/pin waits > 30 seconds"
fi
echo ""

# =============================================================================
# SUMMARY AND EMAIL ALERT
# =============================================================================
echo "============================================================"
echo "SUMMARY"
echo "============================================================"
echo "Host        : \$(hostname)"
echo "SID         : \${ORACLE_SID}"
echo "Timestamp   : \${TIMESTAMP}"
echo "Issues found: \${ISSUES}"
echo ""

if [[ \${ISSUES} -gt 0 ]]; then
  echo "ISSUES DETECTED — review log: \${LOGFILE}"

  SUBJECT="[ORACLE WAIT ALERT] \${ORACLE_SID} on \$(hostname) — \${ISSUES} issue(s) \$(date '+%Y-%m-%d %H:%M')"

  # Build summary for email body
  SUMMARY_BODY=\$(cat <<MAILBODY
Oracle Wait Event Monitor Alert
================================
Host      : \$(hostname)
SID       : \${ORACLE_SID}
Time      : \$(date '+%Y-%m-%d %H:%M:%S')
Issues    : \${ISSUES}
Log file  : \${LOGFILE}

See attached log for full details.
MAILBODY
)

  if command -v mailx &>/dev/null; then
    echo "\${SUMMARY_BODY}" | mailx -s "\${SUBJECT}" "\${ALERT_EMAIL}" && \
      echo "[INFO ] Alert email sent to \${ALERT_EMAIL}"
  elif command -v sendmail &>/dev/null; then
    { echo "Subject: \${SUBJECT}"; echo "To: \${ALERT_EMAIL}"; echo ""; echo "\${SUMMARY_BODY}"; } \
      | sendmail "\${ALERT_EMAIL}" && \
      echo "[INFO ] Alert email sent via sendmail to \${ALERT_EMAIL}"
  else
    echo "[WARN ] No mail client (mailx/sendmail) found — email alert skipped"
  fi
else
  echo "STATUS: OK — all checks passed"
fi

echo ""
echo "Exit code: \${ISSUES}"
echo "============================================================"

# Keep only last 30 days of logs
find "\${LOG_BASE}" -name "wait_monitor_*.log" -mtime +30 -delete 2>/dev/null || true

exit \${ISSUES}
\`\`\`

### Deployment Steps

\`\`\`bash
# Create directories
mkdir -p /u01/app/oracle/scripts/wait_monitor/logs
chmod 750 /u01/app/oracle/scripts/wait_monitor
chmod 750 /u01/app/oracle/scripts/wait_monitor/logs

# Deploy the script
cp wait_event_monitor.sh /u01/app/oracle/scripts/wait_monitor/
chmod 750 /u01/app/oracle/scripts/wait_monitor/wait_event_monitor.sh
chown oracle:oinstall /u01/app/oracle/scripts/wait_monitor/wait_event_monitor.sh

# Test run (as oracle OS user)
ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1 \\
ALERT_EMAIL=dba@example.com \\
  /u01/app/oracle/scripts/wait_monitor/wait_event_monitor.sh PRODDB
echo "Exit code: \$?"
\`\`\`

### Crontab Entry (every 10 minutes)

\`\`\`
*/10  *  *  *  *  ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1 ALERT_EMAIL=dba@example.com /u01/app/oracle/scripts/wait_monitor/wait_event_monitor.sh PRODDB >> /u01/app/oracle/scripts/wait_monitor/logs/cron_wait.log 2>&1
\`\`\`

Add with \`crontab -e -u oracle\` or place in \`/etc/cron.d/oracle-wait-monitor\`.

---

## Quick Reference

### Key V$ Views

| View | Purpose |
|---|---|
| \`V\$SYSTEM_EVENT\` | Instance-wide cumulative wait totals since startup |
| \`V\$SESSION_WAIT\` | Current wait event for each session |
| \`V\$SESSION_EVENT\` | Per-session cumulative wait totals |
| \`V\$SYS_TIME_MODEL\` | DB Time component breakdown |
| \`V\$ACTIVE_SESSION_HISTORY\` | Last ~1 hour of 1-second ASH samples (in memory) |
| \`V\$SQL_WORKAREA\` | Sort/hash operation memory usage and spill status |
| \`V\$LATCH\` | Latch get/miss statistics |
| \`V\$PGASTAT\` | PGA memory aggregate statistics |

### Key DBA_HIST Views (Diagnostics Pack)

| View | Purpose |
|---|---|
| \`DBA_HIST_SYSTEM_EVENT\` | AWR delta wait event snapshots |
| \`DBA_HIST_ACTIVE_SESS_HISTORY\` | Historical ASH data (older than 1 hour) |
| \`DBA_HIST_SYS_TIME_MODEL\` | AWR delta DB Time model |
| \`DBA_HIST_SEG_STAT\` | AWR segment-level I/O statistics |
| \`DBA_HIST_SQLTEXT\` | SQL text for historical SQL IDs |
| \`DBA_HIST_SQL_PLAN\` | Historical execution plans |

### RAC Views

| View | Purpose |
|---|---|
| \`GV\$SYSTEM_EVENT\` | Wait events across all RAC instances |
| \`GV\$SYSSTAT\` | System statistics including gc block transfer counts |

### Wait Class Quick Reference

| Wait Class | Primary Root Cause | Phase |
|---|---|---|
| **User I/O** | Storage latency, missing index, plan regression | Phase 2 |
| **Commit** | Redo log I/O speed, commit frequency | Phase 3 |
| **Concurrency** | Hot blocks, cursor sharing, row locks | Phase 4 |
| **Application** | Row locks, application design | Phase 4.3 |
| **Cluster** | Cache Fusion latency, poor data affinity | Phase 6 |
| **Network** | Client think time (often idle), network bandwidth | Phase 5 |
| **Configuration** | Undersized redo logs, SGA/PGA too small | Phase 3.2, 2.4 |`,
};

async function main() {
  console.log('Inserting Oracle Wait Events runbook...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: { ...post },
  });
  console.log('Inserted: "' + post.title + '"');
}

main().catch(console.error);
