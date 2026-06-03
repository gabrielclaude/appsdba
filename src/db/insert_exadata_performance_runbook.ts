import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Exadata Performance Analysis and Remediation Scripts',
  slug: 'exadata-performance-analysis-runbook',
  excerpt:
    'Executable scripts for end-to-end Exadata performance analysis — cell offloading efficiency, Smart Scan eligibility, Storage Index hit rates, IORM configuration, flash cache utilisation, wait event profiling, top SQL identification, and a remediation checklist with SQL and CellCLI commands.',
  category: 'exadata' as const,
  published: true,
  publishedAt: new Date('2026-06-02'),
  isPremium: true,
  youtubeUrl: null,
  content: `This runbook accompanies the [Exadata Performance Tuning guide](/posts/exadata-performance-tuning). It provides a structured set of SQL, shell, and CellCLI scripts that diagnose performance problems at every layer of the Exadata stack — from the database tier down to the storage cells — and produces an actionable remediation report.

**Prerequisites:**
- Oracle Database 19c or later on Exadata (queries reference v\\$cell_* and GV\\$ views)
- \`dcli\` available on the database node (comes with Exadata software)
- SYSDBA access for the AWR and ASH queries
- SSH access to at least one cell node for CellCLI commands
- An AWR snapshot pair bracketing the problem period (run Script 1 first if not available)

---

## Script 1: Create AWR Snapshot Pair

Run at the start and end of the problem window, or immediately before and after a load test.

\`\`\`sql
-- create_awr_snapshots.sql
-- Run on the primary database instance

-- Take a snapshot now (before the problem period or analysis window)
EXEC DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT();

-- After the problem window, take the closing snapshot
EXEC DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT();

-- Confirm the two most recent snapshots
SELECT snap_id,
       instance_number,
       TO_CHAR(begin_interval_time, 'YYYY-MM-DD HH24:MI') AS begin_time,
       TO_CHAR(end_interval_time,   'YYYY-MM-DD HH24:MI') AS end_time
FROM   dba_hist_snapshot
ORDER  BY snap_id DESC
FETCH FIRST 6 ROWS ONLY;
\`\`\`

Note the two snap_id values — substitute them as \`&begin_snap\` and \`&end_snap\` in the scripts below.

---

## Script 2: Exadata Offloading Efficiency Report

This is the first thing to check on Exadata. If offloading is low, Smart Scan is not running and the database is doing full table scans through the database nodes, bypassing all Exadata acceleration.

\`\`\`sql
-- exadata_offload_report.sql
-- Substitute your snap_id range for &begin_snap and &end_snap

SET LINESIZE 160 PAGESIZE 80
COLUMN metric_name FORMAT A45
COLUMN value       FORMAT 999,999,999,999,999
COLUMN pct         FORMAT 999.9

-- Offloading ratios from AWR (aggregated across all cells)
SELECT
    h.stat_name                          AS metric_name,
    SUM(h.value)                         AS value
FROM
    dba_hist_sysstat h,
    dba_hist_snapshot s
WHERE
    s.snap_id         = h.snap_id
AND s.instance_number = h.instance_number
AND s.snap_id BETWEEN &begin_snap AND &end_snap
AND h.stat_name IN (
    'cell IO uncompressed bytes',
    'cell physical IO bytes eligible for predicate offload',
    'cell physical IO interconnect bytes',
    'cell physical IO interconnect bytes returned by smart scan',
    'cell physical IO bytes saved by storage index',
    'cell physical IO bytes saved by columnar cache',
    'cell flash cache read hits',
    'cell IO bytes sent directly to DB node to balance CPU',
    'physical read total bytes',
    'physical write total bytes'
)
GROUP BY h.stat_name
ORDER BY h.stat_name;
\`\`\`

**Interpret results:**

| Metric | What it means |
|---|---|
| \`cell physical IO bytes eligible for predicate offload\` / \`cell IO uncompressed bytes\` | Smart Scan eligibility rate — should be > 80% for a data warehouse workload |
| \`cell physical IO interconnect bytes returned by smart scan\` / \`cell physical IO bytes eligible for predicate offload\` | Offload return ratio — how much data Smart Scan filtered out at the cell. Lower is better (0.1 = 90% filtered) |
| \`cell physical IO bytes saved by storage index\` | Bytes eliminated by Storage Indexes — high values mean storage index pruning is working |
| \`cell flash cache read hits\` / \`physical read total bytes\` | Flash cache hit rate — should be > 60% for OLTP workloads |

\`\`\`sql
-- Compute offload efficiency as percentages (current session — live view)
SELECT
    ROUND(
        (SELECT value FROM v\$sysstat WHERE name = 'cell physical IO bytes eligible for predicate offload')
      / NULLIF((SELECT value FROM v\$sysstat WHERE name = 'cell IO uncompressed bytes'), 0) * 100, 1
    ) AS smart_scan_eligibility_pct,
    ROUND(
        (SELECT value FROM v\$sysstat WHERE name = 'cell physical IO bytes saved by storage index')
      / NULLIF((SELECT value FROM v\$sysstat WHERE name = 'cell IO uncompressed bytes'), 0) * 100, 1
    ) AS storage_index_savings_pct,
    ROUND(
        (SELECT value FROM v\$sysstat WHERE name = 'cell flash cache read hits')
      / NULLIF((SELECT value FROM v\$sysstat WHERE name = 'physical read total bytes'), 0) * 100, 1
    ) AS flash_cache_hit_pct
FROM dual;
\`\`\`

---

## Script 3: Smart Scan Ineligibility Analysis

When Smart Scan eligibility is low, find out why. These queries identify objects and sessions where Smart Scan is being bypassed.

\`\`\`sql
-- smart_scan_ineligibility.sql

-- Top segments with high direct path reads but low Smart Scan
SELECT
    o.owner,
    o.object_name,
    o.object_type,
    s.physical_reads,
    s.physical_reads_direct,
    ROUND(s.physical_reads_direct / NULLIF(s.physical_reads, 0) * 100, 1) AS direct_read_pct
FROM
    v\$segment_statistics s
    JOIN dba_objects o ON o.object_id = s.obj#
WHERE
    s.statistic_name = 'physical reads direct'
AND s.physical_reads > 100000
ORDER BY s.physical_reads_direct DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

\`\`\`sql
-- Sessions currently bypassing Smart Scan (buffer cache reads on large objects)
SELECT
    s.sid,
    s.serial#,
    s.username,
    s.program,
    sq.sql_id,
    sq.sql_text,
    s.last_call_et          AS elapsed_secs,
    ss.value                AS buffer_gets
FROM
    v\$session s
    JOIN v\$sesstat ss ON ss.sid = s.sid
    JOIN v\$statname sn ON sn.statistic# = ss.statistic#
    JOIN v\$sql sq ON sq.sql_id = s.sql_id
WHERE
    sn.name    = 'session logical reads'
AND ss.value   > 1000000
AND s.status   = 'ACTIVE'
AND s.type     = 'USER'
ORDER BY ss.value DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

\`\`\`sql
-- Check if parallel query is configured (required for Smart Scan on most workloads)
SELECT name, value
FROM   v\$parameter
WHERE  name IN (
    'parallel_degree_policy',
    'parallel_min_servers',
    'parallel_max_servers',
    'parallel_force_local',
    'cell_offload_processing',
    'cell_offload_plan_display',
    '_serial_direct_read'
)
ORDER BY name;
\`\`\`

\`\`\`sql
-- Confirm cell_offload_processing is TRUE (must be enabled for all offloading)
SELECT name, value FROM v\$parameter WHERE name = 'cell_offload_processing';
-- Expected: TRUE
\`\`\`

---

## Script 4: Top Wait Events (AWR Period)

\`\`\`sql
-- top_wait_events_awr.sql

SET LINESIZE 160 PAGESIZE 60
COLUMN event_name    FORMAT A45
COLUMN waits         FORMAT 999,999,999
COLUMN total_wait_s  FORMAT 999,999,999
COLUMN avg_wait_ms   FORMAT 999,999.9
COLUMN pct_db_time   FORMAT 999.9

SELECT
    e.event_name,
    SUM(e.waits_delta)                              AS waits,
    ROUND(SUM(e.time_waited_micro_delta) / 1e6, 1) AS total_wait_s,
    ROUND(SUM(e.time_waited_micro_delta)
        / NULLIF(SUM(e.waits_delta), 0) / 1000, 2) AS avg_wait_ms,
    ROUND(SUM(e.time_waited_micro_delta)
        / NULLIF((
            SELECT SUM(d.value)
            FROM   dba_hist_sys_time_model d
            JOIN   dba_hist_snapshot ss
                   ON ss.snap_id = d.snap_id AND ss.instance_number = d.instance_number
            WHERE  d.stat_name = 'DB time'
            AND    ss.snap_id BETWEEN &begin_snap AND &end_snap
          ), 0) * 100, 1)                           AS pct_db_time
FROM
    dba_hist_system_event e
    JOIN dba_hist_snapshot s
         ON s.snap_id = e.snap_id AND s.instance_number = e.instance_number
WHERE
    s.snap_id BETWEEN &begin_snap AND &end_snap
AND e.wait_class != 'Idle'
GROUP BY e.event_name
ORDER BY total_wait_s DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

**Exadata-specific wait events to watch:**

| Wait Event | Likely Cause |
|---|---|
| \`cell single block physical read\` | OLTP single-block I/O — check flash cache hit rate |
| \`cell multiblock physical read\` | Full scan through cells — check Smart Scan eligibility |
| \`cell smart table scan\` | Smart Scan running — normal, but high avg wait suggests cell CPU pressure |
| \`cell list of blocks physical read\` | Index range scan with many small I/Os — consider hybrid columnar compression |
| \`cell smart index scan\` | Index-organized smart scan offload |
| \`gc buffer busy acquire\` | RAC block transfer — check interconnect and application partitioning |
| \`log file sync\` | Redo write latency — check IORM redo log priority |

---

## Script 5: Top SQL by Exadata Metrics

\`\`\`sql
-- top_sql_exadata.sql
-- Top SQL statements by Exadata cell I/O (AWR period)

SET LINESIZE 200 PAGESIZE 60
COLUMN sql_id         FORMAT A14
COLUMN sql_text       FORMAT A60
COLUMN cell_io_gb     FORMAT 999,999.9
COLUMN ss_eligible_gb FORMAT 999,999.9
COLUMN offload_pct    FORMAT 999.9
COLUMN executions     FORMAT 999,999,999

SELECT
    s.sql_id,
    SUBSTR(t.sql_text, 1, 60)                                    AS sql_text,
    SUM(s.executions_delta)                                      AS executions,
    ROUND(SUM(s.iowait_delta) / 1e6, 1)                         AS io_wait_s,
    ROUND(SUM(s.direct_writes_delta + s.direct_reads_delta)
          * 8192 / 1073741824, 1)                               AS direct_io_gb,
    ROUND(SUM(s.elapsed_time_delta)
          / NULLIF(SUM(s.executions_delta), 0) / 1e6, 3)        AS avg_elapsed_s
FROM
    dba_hist_sqlstat s
    JOIN dba_hist_snapshot sn
         ON sn.snap_id = s.snap_id AND sn.instance_number = s.instance_number
    JOIN dba_hist_sqltext t ON t.sql_id = s.sql_id
WHERE
    sn.snap_id BETWEEN &begin_snap AND &end_snap
AND s.iowait_delta > 0
GROUP BY s.sql_id, SUBSTR(t.sql_text, 1, 60)
ORDER BY io_wait_s DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

\`\`\`sql
-- Drill into a specific SQL — check plan for Smart Scan indicators
-- Replace &sql_id with the sql_id from above

SELECT
    p.operation,
    p.options,
    p.object_name,
    p.object_type,
    p.cost,
    p.cardinality,
    p.bytes,
    p.other_tag,
    SUBSTR(p.other_xml, 1, 200) AS other_xml_snippet
FROM
    dba_hist_sql_plan p
WHERE
    p.sql_id = '&sql_id'
AND p.plan_hash_value = (
        SELECT MIN(plan_hash_value) FROM dba_hist_sql_plan WHERE sql_id = '&sql_id'
    )
ORDER BY p.id;

-- Look for:
--   OPERATION = 'TABLE ACCESS'  OPTIONS = 'STORAGE FULL'  => Smart Scan running
--   OPERATION = 'TABLE ACCESS'  OPTIONS = 'FULL'          => No Smart Scan (buffer cache)
--   other_xml containing 'cell_offload_predicates'        => predicates pushed to cell
\`\`\`

---

## Script 6: Storage Cell Diagnostics via CellCLI

Run these on each cell node. Use \`dcli\` from a database node to fan out to all cells.

\`\`\`bash
#!/bin/bash
# cell_diagnostics.sh
# Usage: ./cell_diagnostics.sh
# Requires dcli and passwordless SSH to all cell nodes.

CELLS=$(cat /etc/oracle/cell/network-config/cellip.ora | grep -oP '(?<=//)[^/]+(?=:)')
LOGFILE="/tmp/cell_diag_$(date +%Y%m%d_%H%M%S).log"

log() { echo "[$(date +%H:%M:%S)] $1" | tee -a "$LOGFILE"; }

log "Exadata Cell Diagnostics — $(date)"
log "Cells: $CELLS"
log "$(printf '%.0s-' {1..70})"

# ── Cell state and mode ────────────────────────────────────────────────────
log ""
log "[1] Cell Status and Mode"
dcli -g /etc/oracle/cell/network-config/cellip.ora cellcli -e "list cell attributes name,cellsrvStatus,msStatus,rsStatus,flashCacheMode,cellDiskMode"  2>&1 | tee -a "$LOGFILE"

# ── Flash cache statistics ─────────────────────────────────────────────────
log ""
log "[2] Flash Cache Utilisation"
dcli -g /etc/oracle/cell/network-config/cellip.ora cellcli -e "list flashcache detail" 2>&1 | tee -a "$LOGFILE"

# ── Flash cache hit rate (from cell metrics) ───────────────────────────────
log ""
log "[3] Flash Cache Hit Rate (last 1 hour)"
dcli -g /etc/oracle/cell/network-config/cellip.ora cellcli -e \
  "list metriccurrent where metricObjectName like 'FC_.*' and metricType = 'Rate'" 2>&1 | tee -a "$LOGFILE"

# ── Smart Scan throughput ──────────────────────────────────────────────────
log ""
log "[4] Smart Scan Throughput Metrics"
dcli -g /etc/oracle/cell/network-config/cellip.ora cellcli -e \
  "list metriccurrent where metricObjectName like 'DB_.*' \
   and (name = 'DB_IO_SS_BYTES' or name = 'DB_IO_SS_ELIGIBLE_BYTES' \
     or name = 'DB_IO_OFFLOAD_RETURN_BYTES' or name = 'DB_IO_BYTES')" 2>&1 | tee -a "$LOGFILE"

# ── Storage index statistics ───────────────────────────────────────────────
log ""
log "[5] Storage Index Metrics"
dcli -g /etc/oracle/cell/network-config/cellip.ora cellcli -e \
  "list metriccurrent where name like 'DB_IO_ST.*'" 2>&1 | tee -a "$LOGFILE"

# ── Cell disk I/O rates ────────────────────────────────────────────────────
log ""
log "[6] Cell Disk I/O Rates (hot disks)"
dcli -g /etc/oracle/cell/network-config/cellip.ora cellcli -e \
  "list metriccurrent where metricObjectName like 'CD_.*' \
   and (name = 'CD_IO_RQ_R_LG' or name = 'CD_IO_RQ_W_LG' \
     or name = 'CD_IO_TM_R_LG' or name = 'CD_IO_TM_W_LG')" 2>&1 \
  | sort -t'=' -k2 -rn | head -40 | tee -a "$LOGFILE"

# ── IORM plan ─────────────────────────────────────────────────────────────
log ""
log "[7] IORM Plan"
dcli -g /etc/oracle/cell/network-config/cellip.ora cellcli -e "list iormplan detail" 2>&1 | tee -a "$LOGFILE"

# ── Cell alerts ───────────────────────────────────────────────────────────
log ""
log "[8] Recent Cell Alerts (last 24 hours)"
dcli -g /etc/oracle/cell/network-config/cellip.ora cellcli -e \
  "list alerthistory where beginTime > '$(date -d '-24 hours' '+%Y-%m-%dT%H:%M:%S')' \
   attributes beginTime,severity,alertMessage" 2>&1 | tee -a "$LOGFILE"

log ""
log "$(printf '%.0s-' {1..70})"
log "Cell diagnostics complete. Report: $LOGFILE"
\`\`\`

---

## Script 7: IORM Configuration and Tuning

\`\`\`bash
#!/bin/bash
# iorm_check.sh — Check and optionally configure IORM

CELLIP_FILE="/etc/oracle/cell/network-config/cellip.ora"
DB_NAME="EBSPROD"       # your database name as it appears in IORM

# ── Current IORM plan ─────────────────────────────────────────────────────
echo "=== Current IORM Plan ==="
dcli -g "$CELLIP_FILE" cellcli -e "list iormplan detail"

echo ""
echo "=== Database-level IORM directives ==="
dcli -g "$CELLIP_FILE" cellcli -e "list dbplan detail"
\`\`\`

To configure IORM for a multi-database Exadata (prioritise EBSPROD over batch):

\`\`\`sql
-- iorm_configure.sql — run as SYSDBA on the primary database
-- This sets database-level I/O shares; higher share = more I/O priority

BEGIN
  DBMS_RESOURCE_MANAGER.CLEAR_PENDING_AREA();
  DBMS_RESOURCE_MANAGER.CREATE_PENDING_AREA();

  -- Set I/O shares for this database relative to others on the same Exadata
  DBMS_RESOURCE_MANAGER.UPDATE_PLAN(
    plan        => 'INTERNAL_PLAN',
    comments    => 'Exadata IORM — EBSPROD higher priority than batch'
  );

  DBMS_RESOURCE_MANAGER.SUBMIT_PENDING_AREA();
END;
/

-- Set IORM objective at the cell level (run from dcli or CellCLI on each cell)
-- Options: auto, low_latency, high_throughput, balanced
-- ALTER IORMPLAN active OBJECTIVE = auto;
\`\`\`

\`\`\`bash
# Set IORM objective to balanced (recommended for mixed OLTP+batch Exadata)
dcli -g /etc/oracle/cell/network-config/cellip.ora \
  cellcli -e "alter iormplan active objective = balanced"
\`\`\`

---

## Script 8: Flash Cache Configuration Check

\`\`\`bash
#!/bin/bash
# flash_cache_check.sh

CELLIP_FILE="/etc/oracle/cell/network-config/cellip.ora"

echo "=== Flash Cache Size and Mode ==="
dcli -g "$CELLIP_FILE" cellcli -e \
  "list flashcache attributes name,size,status,flashCacheMode"

echo ""
echo "=== Flash Cache Write-Back Status ==="
dcli -g "$CELLIP_FILE" cellcli -e \
  "list flashcachecontent where cachedKeepSize > 0 attributes \
   dbUniqueName,tableSpaceName,objectNumber,cachedSize,cachedKeepSize,hitCount,missCount" \
  | sort -t',' -k5 -rn | head -30

echo ""
echo "=== Flash Disk Status ==="
dcli -g "$CELLIP_FILE" cellcli -e \
  "list flashdisk attributes name,status,diskType,size,freeSpace"
\`\`\`

To keep a specific tablespace permanently in flash cache (WriteBack mode):

\`\`\`sql
-- Pin a hot tablespace in Exadata Smart Flash Cache (WriteBack mode)
-- This survives flash cache flushes and is recommended for frequently-accessed indexes

ALTER TABLESPACE APPS_TS_TX_IDX STORAGE (CELL_FLASH_CACHE KEEP);
ALTER TABLESPACE SYSAUX              STORAGE (CELL_FLASH_CACHE KEEP);

-- To remove the pin:
ALTER TABLESPACE APPS_TS_TX_IDX STORAGE (CELL_FLASH_CACHE DEFAULT);

-- Check current flash cache pinning
SELECT tablespace_name, def_cell_flash_cache
FROM   dba_tablespaces
WHERE  def_cell_flash_cache != 'DEFAULT'
ORDER BY tablespace_name;
\`\`\`

---

## Script 9: Compression and Hybrid Columnar Compression Check

HCC is an Exadata-only feature. Segments eligible for HCC but stored uncompressed represent a significant opportunity for I/O reduction.

\`\`\`sql
-- hcc_opportunities.sql
-- Find large uncompressed tables that are good HCC candidates
-- (low DML rate + high read I/O = ideal for HCC)

SET LINESIZE 180 PAGESIZE 60
COLUMN owner        FORMAT A20
COLUMN segment_name FORMAT A35
COLUMN size_gb      FORMAT 999,999.9
COLUMN compress_for FORMAT A25

SELECT
    s.owner,
    s.segment_name,
    ROUND(SUM(s.bytes) / 1073741824, 1)  AS size_gb,
    t.compression,
    t.compress_for
FROM
    dba_segments s
    JOIN dba_tables t ON t.owner = s.owner AND t.table_name = s.segment_name
WHERE
    s.segment_type  = 'TABLE'
AND s.bytes         > 1073741824   -- larger than 1 GB
AND t.compression   = 'DISABLED'
GROUP BY s.owner, s.segment_name, t.compression, t.compress_for
ORDER BY size_gb DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

\`\`\`sql
-- Check DML rate on candidates (low inserts+updates+deletes = good HCC candidate)
SELECT
    o.name                                    AS table_name,
    SUM(m.inserts)                            AS total_inserts,
    SUM(m.updates)                            AS total_updates,
    SUM(m.deletes)                            AS total_deletes,
    SUM(m.inserts + m.updates + m.deletes)    AS total_dml,
    MAX(m.timestamp)                          AS last_monitored
FROM
    dba_tab_modifications m
    JOIN dba_objects o ON o.object_id = m.table_id
WHERE
    o.owner NOT IN ('SYS','SYSTEM','DBSNMP')
GROUP BY o.name
HAVING SUM(m.inserts + m.updates + m.deletes) < 10000   -- low DML
ORDER BY total_dml
FETCH FIRST 20 ROWS ONLY;
\`\`\`

---

## Script 10: Full Performance Report Generator

This script ties everything together and writes a single report file with findings and recommendations.

\`\`\`bash
#!/bin/bash
# exadata_perf_report.sh
# Usage: ./exadata_perf_report.sh <begin_snap_id> <end_snap_id> <db_sid> <sys_password>
# Generates /tmp/exadata_perf_report_YYYYMMDD_HHMMSS.txt

BEGIN_SNAP=\${1:?Usage: $0 begin_snap_id end_snap_id db_sid sys_password}
END_SNAP=\${2:?}
DB_SID=\${3:?}
SYS_PASS=\${4:?}
ORACLE_HOME=\${ORACLE_HOME:=/u01/app/oracle/product/19.0.0/dbhome_1}
REPORT="/tmp/exadata_perf_report_$(date +%Y%m%d_%H%M%S).txt"
CELLIP="/etc/oracle/cell/network-config/cellip.ora"

export ORACLE_HOME ORACLE_SID="$DB_SID" PATH="$ORACLE_HOME/bin:$PATH"

log()    { echo "$1" | tee -a "$REPORT"; }
header() { log ""; log "$(printf '%.0s=' {1..70})"; log "  $1"; log "$(printf '%.0s=' {1..70})"; }
hr()     { log "$(printf '%.0s-' {1..70})"; }

header "Exadata Performance Analysis Report"
log "  Database  : $DB_SID"
log "  AWR range : snap $BEGIN_SNAP  ->  snap $END_SNAP"
log "  Generated : $(date)"
log ""

# ── Section 1: Offloading summary ─────────────────────────────────────────
header "1. Cell Offloading Summary"
sqlplus -S sys/"$SYS_PASS"@"$DB_SID" as sysdba << EOF | tee -a "$REPORT"
SET PAGESIZE 0 LINESIZE 160 FEEDBACK OFF HEADING OFF
SELECT
    'Smart Scan Eligibility %  : ' ||
    ROUND(
        SUM(CASE WHEN stat_name = 'cell physical IO bytes eligible for predicate offload' THEN value END)
      / NULLIF(SUM(CASE WHEN stat_name = 'cell IO uncompressed bytes' THEN value END), 0) * 100, 1
    ) || '%'
FROM dba_hist_sysstat h JOIN dba_hist_snapshot s
     ON s.snap_id = h.snap_id AND s.instance_number = h.instance_number
WHERE s.snap_id BETWEEN $BEGIN_SNAP AND $END_SNAP
AND   stat_name IN ('cell physical IO bytes eligible for predicate offload',
                    'cell IO uncompressed bytes');
SELECT
    'Storage Index Savings %   : ' ||
    ROUND(
        SUM(CASE WHEN stat_name = 'cell physical IO bytes saved by storage index' THEN value END)
      / NULLIF(SUM(CASE WHEN stat_name = 'cell IO uncompressed bytes' THEN value END), 0) * 100, 1
    ) || '%'
FROM dba_hist_sysstat h JOIN dba_hist_snapshot s
     ON s.snap_id = h.snap_id AND s.instance_number = h.instance_number
WHERE s.snap_id BETWEEN $BEGIN_SNAP AND $END_SNAP
AND   stat_name IN ('cell physical IO bytes saved by storage index',
                    'cell IO uncompressed bytes');
SELECT
    'Flash Cache Hit Rate %    : ' ||
    ROUND(
        SUM(CASE WHEN stat_name = 'cell flash cache read hits' THEN value END)
      / NULLIF(SUM(CASE WHEN stat_name = 'physical read total bytes' THEN value END), 0) * 100, 1
    ) || '%'
FROM dba_hist_sysstat h JOIN dba_hist_snapshot s
     ON s.snap_id = h.snap_id AND s.instance_number = h.instance_number
WHERE s.snap_id BETWEEN $BEGIN_SNAP AND $END_SNAP
AND   stat_name IN ('cell flash cache read hits', 'physical read total bytes');
EXIT
EOF

# ── Section 2: Top 10 wait events ─────────────────────────────────────────
header "2. Top 10 Wait Events"
sqlplus -S sys/"$SYS_PASS"@"$DB_SID" as sysdba << EOF | tee -a "$REPORT"
SET LINESIZE 140 PAGESIZE 40 FEEDBACK OFF
COL event_name   FORMAT A45
COL total_wait_s FORMAT 999,999,999
COL avg_wait_ms  FORMAT 999,999.9
SELECT e.event_name,
       SUM(e.waits_delta)                              AS waits,
       ROUND(SUM(e.time_waited_micro_delta)/1e6,1)    AS total_wait_s,
       ROUND(SUM(e.time_waited_micro_delta)
           / NULLIF(SUM(e.waits_delta),0)/1000,2)     AS avg_wait_ms
FROM   dba_hist_system_event e
       JOIN dba_hist_snapshot s
            ON s.snap_id = e.snap_id AND s.instance_number = e.instance_number
WHERE  s.snap_id BETWEEN $BEGIN_SNAP AND $END_SNAP
AND    e.wait_class != 'Idle'
GROUP  BY e.event_name
ORDER  BY total_wait_s DESC
FETCH FIRST 10 ROWS ONLY;
EXIT
EOF

# ── Section 3: Top 10 SQL by I/O wait ─────────────────────────────────────
header "3. Top 10 SQL by I/O Wait"
sqlplus -S sys/"$SYS_PASS"@"$DB_SID" as sysdba << EOF | tee -a "$REPORT"
SET LINESIZE 180 PAGESIZE 40 FEEDBACK OFF
COL sql_id      FORMAT A14
COL sql_text    FORMAT A55
COL io_wait_s   FORMAT 999,999.9
COL executions  FORMAT 999,999,999
SELECT s.sql_id,
       SUBSTR(t.sql_text,1,55)                              AS sql_text,
       SUM(s.executions_delta)                              AS executions,
       ROUND(SUM(s.iowait_delta)/1e6,1)                    AS io_wait_s,
       ROUND(SUM(s.elapsed_time_delta)
           / NULLIF(SUM(s.executions_delta),0)/1e6,3)      AS avg_elapsed_s
FROM   dba_hist_sqlstat s
       JOIN dba_hist_snapshot sn
            ON sn.snap_id = s.snap_id AND sn.instance_number = s.instance_number
       JOIN dba_hist_sqltext t ON t.sql_id = s.sql_id
WHERE  sn.snap_id BETWEEN $BEGIN_SNAP AND $END_SNAP
AND    s.iowait_delta > 0
GROUP  BY s.sql_id, SUBSTR(t.sql_text,1,55)
ORDER  BY io_wait_s DESC
FETCH FIRST 10 ROWS ONLY;
EXIT
EOF

# ── Section 4: Cell metrics ────────────────────────────────────────────────
if [ -f "$CELLIP" ]; then
  header "4. Cell-Level Metrics"
  dcli -g "$CELLIP" cellcli -e \
    "list metriccurrent where name in \
    ('DB_IO_SS_BYTES','DB_IO_SS_ELIGIBLE_BYTES','DB_IO_ST_REQS', \
     'DB_IO_BYTES','FC_IO_RQST','FC_IO_BYPASS')" 2>&1 | tee -a "$REPORT"

  header "5. IORM Plan"
  dcli -g "$CELLIP" cellcli -e "list iormplan detail" 2>&1 | tee -a "$REPORT"

  header "6. Recent Cell Alerts"
  dcli -g "$CELLIP" cellcli -e \
    "list alerthistory where beginTime > '$(date -d '-24 hours' '+%Y-%m-%dT%H:%M:%S')' \
     attributes beginTime,severity,alertMessage" 2>&1 | tee -a "$REPORT"
fi

# ── Section 7: Recommendations ────────────────────────────────────────────
header "7. Automated Recommendations"
sqlplus -S sys/"$SYS_PASS"@"$DB_SID" as sysdba << 'SQLEOF' | tee -a "$REPORT"
SET PAGESIZE 0 LINESIZE 160 FEEDBACK OFF HEADING OFF SERVEROUTPUT ON

DECLARE
  v_ss_eligible   NUMBER;
  v_total_io      NUMBER;
  v_si_savings    NUMBER;
  v_fc_hits       NUMBER;
  v_phys_reads    NUMBER;
  v_ss_pct        NUMBER;
  v_si_pct        NUMBER;
  v_fc_pct        NUMBER;
BEGIN
  SELECT SUM(CASE WHEN stat_name = 'cell physical IO bytes eligible for predicate offload'
                  THEN value END),
         SUM(CASE WHEN stat_name = 'cell IO uncompressed bytes'
                  THEN value END),
         SUM(CASE WHEN stat_name = 'cell physical IO bytes saved by storage index'
                  THEN value END),
         SUM(CASE WHEN stat_name = 'cell flash cache read hits'
                  THEN value END),
         SUM(CASE WHEN stat_name = 'physical read total bytes'
                  THEN value END)
  INTO v_ss_eligible, v_total_io, v_si_savings, v_fc_hits, v_phys_reads
  FROM v\$sysstat
  WHERE stat_name IN (
    'cell physical IO bytes eligible for predicate offload',
    'cell IO uncompressed bytes',
    'cell physical IO bytes saved by storage index',
    'cell flash cache read hits',
    'physical read total bytes'
  );

  v_ss_pct := ROUND(v_ss_eligible / NULLIF(v_total_io, 0) * 100, 1);
  v_si_pct := ROUND(v_si_savings  / NULLIF(v_total_io, 0) * 100, 1);
  v_fc_pct := ROUND(v_fc_hits     / NULLIF(v_phys_reads, 0) * 100, 1);

  DBMS_OUTPUT.PUT_LINE('Metric snapshot at time of report:');
  DBMS_OUTPUT.PUT_LINE('  Smart Scan eligibility : ' || v_ss_pct || '%');
  DBMS_OUTPUT.PUT_LINE('  Storage Index savings  : ' || v_si_pct || '%');
  DBMS_OUTPUT.PUT_LINE('  Flash Cache hit rate   : ' || v_fc_pct || '%');
  DBMS_OUTPUT.PUT_LINE('');
  DBMS_OUTPUT.PUT_LINE('Recommendations:');

  IF v_ss_pct < 60 THEN
    DBMS_OUTPUT.PUT_LINE('  [HIGH] Smart Scan eligibility is low (' || v_ss_pct || '%).');
    DBMS_OUTPUT.PUT_LINE('         Check: cell_offload_processing=TRUE, parallel DOP, row-level locks,');
    DBMS_OUTPUT.PUT_LINE('         _serial_direct_read=always for large serial scans.');
    DBMS_OUTPUT.PUT_LINE('         Avoid: small tables (<= db_file_multiblock_read_count blocks),');
    DBMS_OUTPUT.PUT_LINE('         tables with chained rows, encrypted tablespaces (if offloading disabled).');
  ELSIF v_ss_pct < 80 THEN
    DBMS_OUTPUT.PUT_LINE('  [MED]  Smart Scan eligibility is moderate (' || v_ss_pct || '%).');
    DBMS_OUTPUT.PUT_LINE('         Review SQL plans for operations returning TABLE ACCESS FULL');
    DBMS_OUTPUT.PUT_LINE('         without STORAGE qualifier — these are bypassing Smart Scan.');
  ELSE
    DBMS_OUTPUT.PUT_LINE('  [OK]   Smart Scan eligibility is healthy (' || v_ss_pct || '%).');
  END IF;

  IF v_si_pct < 20 THEN
    DBMS_OUTPUT.PUT_LINE('  [MED]  Storage Index savings are low (' || v_si_pct || '%).');
    DBMS_OUTPUT.PUT_LINE('         Ensure queries use WHERE clauses on leading columns of large tables.');
    DBMS_OUTPUT.PUT_LINE('         Storage Indexes are built automatically — check for full-table scans');
    DBMS_OUTPUT.PUT_LINE('         without selective predicates that would allow cell pruning.');
  ELSE
    DBMS_OUTPUT.PUT_LINE('  [OK]   Storage Index savings are acceptable (' || v_si_pct || '%).');
  END IF;

  IF v_fc_pct < 50 THEN
    DBMS_OUTPUT.PUT_LINE('  [HIGH] Flash Cache hit rate is low (' || v_fc_pct || '%).');
    DBMS_OUTPUT.PUT_LINE('         Pin hot tablespaces: ALTER TABLESPACE <ts> STORAGE (CELL_FLASH_CACHE KEEP).');
    DBMS_OUTPUT.PUT_LINE('         Check flashcache size vs working set: dcli cellcli -e list flashcache.');
    DBMS_OUTPUT.PUT_LINE('         Consider WriteBack mode for write-intensive workloads.');
  ELSIF v_fc_pct < 70 THEN
    DBMS_OUTPUT.PUT_LINE('  [MED]  Flash Cache hit rate is moderate (' || v_fc_pct || '%).');
    DBMS_OUTPUT.PUT_LINE('         Consider pinning index tablespaces for OLTP workloads.');
  ELSE
    DBMS_OUTPUT.PUT_LINE('  [OK]   Flash Cache hit rate is healthy (' || v_fc_pct || '%).');
  END IF;
END;
/
SQLEOF

log ""
hr
log "  Report complete: $REPORT"
hr
\`\`\`

---

## Quick Reference: Run Order

\`\`\`bash
export ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export PATH=$ORACLE_HOME/bin:$PATH
ORACLE_SID=EBSPROD1
SYS_PASS=your_sys_password

# 1. Create AWR snapshots (at start and end of problem window)
sqlplus sys/"$SYS_PASS" as sysdba @create_awr_snapshots.sql

# 2. Get the snap_id range
sqlplus sys/"$SYS_PASS" as sysdba -s <<'EOF'
SELECT snap_id, TO_CHAR(end_interval_time,'HH24:MI') t
FROM dba_hist_snapshot ORDER BY snap_id DESC FETCH FIRST 6 ROWS ONLY;
EOF

# 3. Run the full report (substitute actual snap IDs)
chmod +x exadata_perf_report.sh
./exadata_perf_report.sh <begin_snap> <end_snap> $ORACLE_SID $SYS_PASS

# 4. Run cell diagnostics (from a database node with dcli)
chmod +x cell_diagnostics.sh
./cell_diagnostics.sh

# 5. Check and adjust IORM if needed
chmod +x iorm_check.sh
./iorm_check.sh

# 6. Check flash cache pinning opportunities
chmod +x flash_cache_check.sh
./flash_cache_check.sh
\`\`\`
`,
};

async function main() {
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
  console.log('inserted:', post.slug);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
