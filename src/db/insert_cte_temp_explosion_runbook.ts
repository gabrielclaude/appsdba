import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle CTE TEMP Tablespace Explosion — Diagnosis, Physical GTT Migration, and PGA Tuning',
  slug: 'oracle-cte-temp-tablespace-explosion-runbook',
  excerpt:
    'Step-by-step runbook for a CTE query consuming 1.5 TB of Oracle TEMP: identify the offending session via V$SORT_USAGE and V$SQL_WORKAREA_ACTIVE, measure PGA spill statistics, create the physical indexed GTT to replace MATERIALIZE hint materialization, deploy the two-phase rewrite, verify TEMP consumption reduction, tune pga_aggregate_target and pga_aggregate_limit for RAC batch workloads, and a monitoring script watching TEMP usage percentage, per-session TEMP consumption, and PGA one-pass and multi-pass workarea spills.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `## Scope

This runbook addresses an Oracle query that exhausts TEMP tablespace (or consumes 1.5+ TB) due to unindexed CTE materialization combined with cascading hash join spills across a multi-level UNION ALL hierarchy. It applies to any Oracle 11g/12c/19c environment where a MATERIALIZE-hinted CTE is building implicit unindexed temporary segments.

**Phases 1–2 are [ACTIVE OUTAGE] triage. Phases 3–7 are the structural fix and can be deployed during a maintenance window.**

---

## Phase 1: Identify the Offending Session and SQL [ACTIVE OUTAGE]

### 1.1 Find sessions currently consuming TEMP

\`\`\`sql
-- Sessions sorted by current TEMP consumption
SELECT s.sid,
       s.serial#,
       s.username,
       s.status,
       s.sql_id,
       s.event,
       s.seconds_in_wait,
       ROUND(su.blocks * 8192 / 1073741824, 2) AS temp_used_gb,
       su.segtype,
       s.module,
       s.action
FROM   v\$session s
JOIN   v\$sort_usage su ON su.session_addr = s.saddr
ORDER BY su.blocks DESC;
\`\`\`

### 1.2 Check the temporary segment breakdown by type

\`\`\`sql
-- Temporary segment types consuming the most space
SELECT su.segtype,
       su.sql_id,
       COUNT(DISTINCT su.session_addr)     AS session_count,
       ROUND(SUM(su.blocks) * 8192 / 1073741824, 2) AS total_gb
FROM   v\$sort_usage su
GROUP BY su.segtype, su.sql_id
ORDER BY total_gb DESC;
\`\`\`

Segment types to look for:
| segtype | Meaning |
|---------|---------|
| \`SORT\` | Sort operation spilling to TEMP |
| \`HASH\` | Hash join build phase spilling to TEMP |
| \`DATA\` | Implicit GTT materialization (MATERIALIZE hint) |
| \`INDEX\` | Index sort during CTAS or large index rebuild |

A combination of \`DATA\` and \`HASH\` segments from the same \`sql_id\` is the fingerprint of the MATERIALIZE + cascading hash join problem.

### 1.3 Get the SQL text for the offending sql_id

\`\`\`sql
-- Retrieve the full SQL text
SELECT sql_id,
       sql_text,
       executions,
       elapsed_time / 1e6          AS elapsed_sec,
       disk_reads,
       buffer_gets,
       rows_processed,
       parsing_schema_name
FROM   v\$sql
WHERE  sql_id = '&offending_sql_id'
ORDER BY last_active_time DESC
FETCH FIRST 3 ROWS ONLY;
\`\`\`

\`\`\`sql
-- Get the full text from v\$sqltext if v\$sql truncates
SELECT piece, sql_text
FROM   v\$sqltext
WHERE  sql_id = '&offending_sql_id'
ORDER BY piece;
\`\`\`

### 1.4 Check active workarea operations for the session

\`\`\`sql
-- Active in-memory and spilling workareas
SELECT wa.sid,
       wa.operation_type,
       wa.policy,
       wa.active_time / 1000        AS active_sec,
       ROUND(wa.work_area_size / 1048576, 0)   AS wa_mb,
       ROUND(wa.expected_size / 1048576, 0)    AS expected_mb,
       ROUND(wa.actual_mem_used / 1048576, 0)  AS actual_mb,
       wa.number_passes,
       wa.tempseg_size / 1073741824 AS tempseg_gb
FROM   v\$sql_workarea_active wa
ORDER BY wa.tempseg_size DESC NULLS LAST;
\`\`\`

\`number_passes > 1\` means the operation is doing multi-pass work — writing and re-reading TEMP multiple times. This is the most expensive scenario.

### 1.5 Emergency: kill the session if TEMP is at capacity

If the TEMP tablespace is at or above 95% full and the database is at risk:

\`\`\`sql
-- Confirm the session to kill and its TEMP consumption
SELECT s.sid, s.serial#, s.username, s.sql_id,
       ROUND(SUM(su.blocks) * 8192 / 1073741824, 2) AS temp_gb
FROM   v\$session s
JOIN   v\$sort_usage su ON su.session_addr = s.saddr
GROUP BY s.sid, s.serial#, s.username, s.sql_id
ORDER BY temp_gb DESC
FETCH FIRST 1 ROWS ONLY;

-- Kill the session (TEMP is released when the session terminates)
ALTER SYSTEM KILL SESSION '&sid,&serial' IMMEDIATE;
\`\`\`

TEMP space allocated by a killed session is released asynchronously — allow 60–120 seconds for the space to show as free before assuming success.

---

## Phase 2: Measure PGA and Workarea Statistics

### 2.1 Current PGA statistics

\`\`\`sql
-- PGA aggregate statistics
SELECT name, value / 1048576 AS mb
FROM   v\$pgastat
WHERE  name IN (
  'aggregate PGA target parameter',
  'aggregate PGA auto target',
  'total PGA inuse',
  'total PGA allocated',
  'maximum PGA allocated',
  'total bytes processed',
  'total extra bytes read/written',
  'cache hit percentage'
)
ORDER BY name;
\`\`\`

**Key metric:** \`cache hit percentage\` below 80% indicates that PGA work areas are insufficient and most operations are spilling. The target is > 95%.

\`total extra bytes read/written\` is the total TEMP I/O caused by spills since instance startup. A high value relative to \`total bytes processed\` indicates a chronic PGA shortage.

### 2.2 Workarea size distribution

\`\`\`sql
-- How workareas are distributed between optimal, one-pass, and multi-pass
SELECT low_optimal_size / 1024  AS low_optimal_kb,
       high_optimal_size / 1024 AS high_optimal_kb,
       optimal_executions,
       onepass_executions,
       multipasses_executions
FROM   v\$sql_workarea_histogram
WHERE  optimal_executions + onepass_executions + multipasses_executions > 0
ORDER BY low_optimal_size;
\`\`\`

For the specific SQL of concern, look at its workarea history:

\`\`\`sql
-- Workarea statistics for the offending SQL
SELECT sql_id,
       operation_type,
       optimal_executions,
       onepass_executions,
       multipasses_executions,
       total_executions,
       ROUND(estimated_optimal_size / 1048576, 0) AS estimated_optimal_mb
FROM   v\$sql_workarea
WHERE  sql_id = '&offending_sql_id'
ORDER BY multipasses_executions DESC;
\`\`\`

\`estimated_optimal_size\` tells you how much PGA memory this operation would need to run without spilling. If it is larger than the current \`pga_aggregate_target\` allows per session, it will always spill regardless of other changes.

### 2.3 Check TEMP tablespace usage and autoextend headroom

\`\`\`sql
-- TEMP tablespace total vs used vs autoextend ceiling
SELECT tf.tablespace_name,
       ROUND(SUM(tf.bytes) / 1073741824, 1)        AS total_gb,
       ROUND(SUM(tu.blocks) * 8192 / 1073741824, 1) AS used_gb,
       ROUND((SUM(tf.bytes) - SUM(tu.blocks) * 8192) / 1073741824, 1) AS free_gb,
       ROUND(SUM(tu.blocks) * 8192 / SUM(tf.bytes) * 100, 1)          AS pct_used,
       ROUND(SUM(CASE WHEN tf.autoextensible = 'YES'
                      THEN tf.maxbytes - tf.bytes ELSE 0 END) / 1073741824, 1) AS autoextend_headroom_gb
FROM   dba_temp_files tf
LEFT JOIN v\$sort_usage tu ON 1 = 1
GROUP BY tf.tablespace_name;

-- Simpler: current TEMP free space
SELECT tablespace_name,
       ROUND(tablespace_size * 8192 / 1073741824, 1)     AS total_gb,
       ROUND(allocated_space * 8192 / 1073741824, 1)      AS allocated_gb,
       ROUND(free_space * 8192 / 1073741824, 1)           AS free_gb
FROM   dba_temp_free_space;
\`\`\`

---

## Phase 3: Deploy the Physical GTT (One-Time DDL)

Run this DDL in the target schema before modifying any application code. The DDL only needs to be run once per environment (dev, staging, production).

### 3.1 Create the GTT with indexes

\`\`\`sql
-- Connect as a DBA or the schema owner
CREATE GLOBAL TEMPORARY TABLE dt.tmp_fnd_extract (
  finding_id           NUMBER,
  score_set_id         NUMBER,
  parent_finding_id    NUMBER,
  finding_type         VARCHAR2(100),
  finding_label        VARCHAR2(4000),
  entity_type_id       NUMBER,
  CONSTRAINT pk_tmp_fnd_extract PRIMARY KEY (finding_id)
) ON COMMIT PRESERVE ROWS;

CREATE INDEX idx_tmp_fnd_parent
  ON dt.tmp_fnd_extract (parent_finding_id, finding_type);

CREATE INDEX idx_tmp_fnd_score_set
  ON dt.tmp_fnd_extract (score_set_id);
\`\`\`

### 3.2 Grant access if needed

\`\`\`sql
-- Grant to the application schema if the GTT is in a separate owner schema
GRANT INSERT, SELECT, DELETE, UPDATE ON dt.tmp_fnd_extract TO <app_user>;
\`\`\`

### 3.3 Verify the GTT and indexes

\`\`\`sql
-- Confirm the GTT was created correctly
SELECT table_name, temporary, duration
FROM   dba_tables
WHERE  owner = 'DT' AND table_name = 'TMP_FND_EXTRACT';
-- Expected: temporary=Y, duration=SYS$SESSION

-- Confirm indexes
SELECT index_name, index_type, uniqueness, status
FROM   dba_indexes
WHERE  table_owner = 'DT' AND table_name = 'TMP_FND_EXTRACT';
-- Expected: PK_TMP_FND_EXTRACT (UNIQUE), IDX_TMP_FND_PARENT (NONUNIQUE), IDX_TMP_FND_SCORE_SET (NONUNIQUE)
\`\`\`

---

## Phase 4: Deploy the Two-Phase Query

Replace the existing single-block CTE INSERT with the two-phase wrapper below. This is the application code change.

### 4.1 Phase 1 — Populate the GTT

\`\`\`sql
-- Phase 1: Populate the indexed GTT
INSERT INTO dt.tmp_fnd_extract
  (finding_id, score_set_id, parent_finding_id, finding_type, finding_label, entity_type_id)
SELECT F.FINDING_ID,
       F.SCORE_SET_ID,
       F.PARENT_FINDING_ID,
       FTC.CODE,
       F.LABEL,
       F.ENTITY_TYPE_ID
FROM   STUDY.FINDING F
JOIN   DATADICTIONARY.FINDING_TYPE_CODE FTC
       ON FTC.FINDING_TYPE_CODE_ID = F.FINDING_TYPE_CODE_ID
JOIN   DT.GTT_EXTRACT_SCORE_SET SCSFP
       ON SCSFP.SCORE_SET_ID = F.SCORE_SET_ID
WHERE  SCSFP.VISIT_ID IS NOT NULL
  AND  F.DELETE_DATE IS NULL
  AND  FTC.CODE IN ('Form','Measurement','MaskMeasurement','MeasurementGroup',
                    'MeasurementChild','XMLGroup','ImportGroup','ImportChild',
                    'StructuredTableGroup','StructuredTableChild',
                    'SupplementalForms','GroovyPlugin');

COMMIT;
\`\`\`

### 4.2 Phase 2 — Run the main INSERT

\`\`\`sql
-- Phase 2: Main insertion using the indexed GTT
INSERT /*+ APPEND */ INTO DT.GTT_EXTRACT_SCORE_VERT
  (TRANSFER_ID, SCORE_SET_ID, FINDING_ID, SCORE_TYPE_PATH, MAPPED_LABEL,
   MAPPED_SUB_LABEL, TEXT_VALUE, UNIT_OF_MEASURE_CODE_ID, ENTITY_TYPE_ID, ATTRIBUTE_TYPE_ID)
WITH FORMS AS (
  SELECT FND.FINDING_ID, FND.FINDING_TYPE, FND.FINDING_LABEL,
         FND.PARENT_FINDING_ID, FND.SCORE_SET_ID,
         FND.ENTITY_TYPE_ID AS FORM_ENTITY_TYPE_ID,
         S.FINDING_LABEL AS MAPPED_SUB_LABEL
  FROM   dt.tmp_fnd_extract FND
  LEFT JOIN dt.tmp_fnd_extract S
         ON S.FINDING_ID = FND.PARENT_FINDING_ID
        AND S.finding_type = 'SupplementalForms'
  WHERE  FND.finding_type = 'Form'
    AND  (FND.PARENT_FINDING_ID IS NULL OR S.FINDING_ID IS NOT NULL)
),
FRMF AS (
  SELECT FINDING_ID, 1 AS FINDING_LEVEL, '' AS MAPPED_LABEL,
         FORMS.MAPPED_SUB_LABEL,
         '/' || FORMS.FINDING_LABEL AS FINDING_LABEL_PATH2,
         SCORE_SET_ID, FORM_ENTITY_TYPE_ID
  FROM   FORMS
  UNION ALL
  SELECT FNDC.FINDING_ID, 2 AS FINDING_LEVEL, '' AS MAPPED_LABEL,
         FORMS.MAPPED_SUB_LABEL,
         '/' || FORMS.FINDING_LABEL || '/' || FNDC.FINDING_LABEL AS FINDING_LABEL_PATH2,
         FORMS.SCORE_SET_ID, FORMS.FORM_ENTITY_TYPE_ID
  FROM   FORMS
  JOIN   dt.tmp_fnd_extract FNDC
         ON FORMS.FINDING_ID = FNDC.PARENT_FINDING_ID
        AND FNDC.finding_type IN ('Measurement','MaskMeasurement','MeasurementGroup',
                                  'GroovyPlugin','XMLGroup')
  UNION ALL
  SELECT FNDCC.FINDING_ID, 3 AS FINDING_LEVEL,
         FNDCC.FINDING_LABEL AS MAPPED_LABEL,
         FORMS.MAPPED_SUB_LABEL,
         '/' || FORMS.FINDING_LABEL || '/' || FNDC.FINDING_LABEL AS FINDING_LABEL_PATH2,
         FORMS.SCORE_SET_ID, FORMS.FORM_ENTITY_TYPE_ID
  FROM   FORMS
  JOIN   dt.tmp_fnd_extract FNDC
         ON FORMS.FINDING_ID = FNDC.PARENT_FINDING_ID
        AND FNDC.finding_type IN ('MeasurementGroup','ImportGroup','StructuredTableGroup')
  JOIN   dt.tmp_fnd_extract FNDCC
         ON FNDC.FINDING_ID = FNDCC.PARENT_FINDING_ID
        AND FNDCC.finding_type IN ('MeasurementChild','ImportChild','StructuredTableChild')
)
SELECT :B1,
       FRMF.SCORE_SET_ID, FRMF.FINDING_ID,
       CASE WHEN SC.ATTRIBUTE_TYPE_ID IS NULL
            THEN FINDING_LABEL_PATH2 || '|' || STC.CODE || '|' || SC.LABEL
       END AS SCORE_TYPE_PATH,
       FRMF.MAPPED_LABEL, FRMF.MAPPED_SUB_LABEL,
       TRIM(
         TO_CHAR(SC.DATE_TIME_VALUE,'DD-MON-YYYY HH24:MI:SS') || ' ' ||
         CASE WHEN SC.DECIMAL_VALUE IS NAN OR SC.DECIMAL_VALUE IS NULL THEN NULL
              ELSE TO_CHAR(SC.DECIMAL_VALUE,'9999999999.9999999') END || ' ' ||
         TO_CHAR(SC.INTEGER_VALUE,'9999999999999999') || ' ' ||
         CASE WHEN SC.TEXT_VALUE IS NULL THEN ' '
              WHEN LENGTH(SC.TEXT_VALUE) <= 3900 THEN TO_CHAR(SC.TEXT_VALUE)
              WHEN LENGTH(SC.TEXT_VALUE) >  3900
              THEN TO_CHAR(DBMS_LOB.SUBSTR(SC.TEXT_VALUE,3900,1)) END || ' ' ||
         DECODE(SC.BOOLEAN_VALUE,1,'TRUE',0,'FALSE',NULL)
       ) AS TEXT_VALUE,
       SC.UNIT_OF_MEASURE_CODE_ID,
       FRMF.FORM_ENTITY_TYPE_ID,
       SC.ATTRIBUTE_TYPE_ID
FROM   FRMF
JOIN   STUDY.SCORE SC  ON SC.FINDING_ID  = FRMF.FINDING_ID
JOIN   DATADICTIONARY.SCORE_TYPE_CODE STC
                       ON STC.SCORE_TYPE_CODE_ID = SC.SCORE_TYPE_CODE_ID
WHERE  SC.DELETE_DATE IS NULL
  AND  STC.CODE NOT IN ('FormComplete','SliceIndex','Available');

COMMIT;
\`\`\`

### 4.3 Phase 3 — Truncate the GTT

\`\`\`sql
-- Clean up the GTT data for this session
-- (ON COMMIT PRESERVE ROWS means it is not auto-cleared on COMMIT)
TRUNCATE TABLE dt.tmp_fnd_extract;
\`\`\`

---

## Phase 5: Verify TEMP Consumption Reduction

Run a controlled test on a staging environment with representative data volume before deploying to production.

### 5.1 Baseline: measure TEMP before the query starts

\`\`\`sql
-- Snapshot TEMP state before executing the query
SELECT tablespace_name,
       ROUND(free_space * 8192 / 1073741824, 2) AS free_gb
FROM   dba_temp_free_space;
\`\`\`

### 5.2 Mid-execution: monitor TEMP consumption

In a second session while the query runs:

\`\`\`sql
-- Per-session TEMP consumption during execution
SELECT s.sid,
       s.username,
       s.sql_id,
       su.segtype,
       ROUND(su.blocks * 8192 / 1073741824, 3) AS temp_gb
FROM   v\$session s
JOIN   v\$sort_usage su ON su.session_addr = s.saddr
ORDER BY temp_gb DESC;
\`\`\`

After the physical GTT migration, the \`DATA\` segment type should be absent or minimal (the GTT insert may generate a small amount), and \`HASH\` segments should be near zero.

### 5.3 Verify execution plan uses index access on the GTT

\`\`\`sql
-- Run EXPLAIN PLAN on Phase 2 INSERT
EXPLAIN PLAN FOR
INSERT /*+ APPEND */ INTO DT.GTT_EXTRACT_SCORE_VERT ...;

-- View the plan
SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY(FORMAT => 'ALL'));
\`\`\`

Look for:
- \`INDEX RANGE SCAN\` or \`INDEX UNIQUE SCAN\` on \`IDX_TMP_FND_PARENT\` or \`PK_TMP_FND_EXTRACT\`
- No \`HASH JOIN BUFFERED\` (which indicates a hash join spilling to TEMP)
- No \`SORT JOIN\` on large intermediate results

If you still see \`HASH JOIN BUFFERED\`, collect statistics on the GTT after population:

\`\`\`sql
-- Collect statistics on the GTT immediately after populating it
-- Run this between Phase 1 and Phase 2
EXEC DBMS_STATS.GATHER_TABLE_STATS('DT', 'TMP_FND_EXTRACT', cascade => TRUE);
\`\`\`

---

## Phase 6: PGA Configuration for RAC Batch Workloads

### 6.1 Current PGA parameter settings

\`\`\`sql
SELECT name, value, description
FROM   v\$parameter
WHERE  name IN ('pga_aggregate_target',
                'pga_aggregate_limit',
                'workarea_size_policy',
                'sort_area_size',
                'hash_area_size',
                '_smm_max_size')
ORDER BY name;
\`\`\`

### 6.2 Sizing recommendations for large batch INSERTs on 2-node RAC

The rule of thumb for \`pga_aggregate_target\` in a batch-heavy RAC environment:

\`\`\`
pga_aggregate_target = (Total physical RAM - SGA size) × 0.5 / RAC node count
\`\`\`

For a 256 GB node with a 64 GB SGA:
- Available RAM for PGA: (256 - 64) × 0.5 = 96 GB per node
- If two concurrent batch sessions expected: each gets ~48 GB work area budget at peak

Set both \`pga_aggregate_target\` and \`pga_aggregate_limit\` to prevent runaway PGA growth:

\`\`\`sql
-- Set on both nodes (or via SPFILE for persistence across restarts)
ALTER SYSTEM SET pga_aggregate_target = 96G SCOPE = BOTH;

-- pga_aggregate_limit is a hard cap — set to 2× the target to allow burst
ALTER SYSTEM SET pga_aggregate_limit = 192G SCOPE = BOTH;
\`\`\`

### 6.3 Verify the estimated optimal PGA for the query's workareas

\`\`\`sql
-- After the first execution with the new GTT, check the workarea history
SELECT sql_id,
       operation_type,
       optimal_executions,
       onepass_executions,
       multipasses_executions,
       ROUND(estimated_optimal_size / 1048576, 0) AS estimated_optimal_mb
FROM   v\$sql_workarea
WHERE  sql_id = '&phase2_sql_id'
ORDER BY estimated_optimal_size DESC;
\`\`\`

If \`estimated_optimal_size\` for the final SCORE hash join exceeds your per-session PGA budget, consider partitioning the Phase 2 INSERT by \`score_set_id\` ranges to reduce per-execution data volume.

---

## Phase 7: Storage Array Latency Verification

### 7.1 Check for high TEMP write latency via AWR

\`\`\`sql
-- AWR: I/O latency on TEMP files during the crash window
-- Replace snap_id range with snapshots surrounding the incident
SELECT f.filename,
       ROUND(ios.singleblkrds / NULLIF(ios.singleblkrdtim, 0) * 10, 1) AS avg_single_read_ms,
       ROUND(ios.readtim / NULLIF(ios.reads, 0) * 10, 1)                AS avg_read_ms,
       ROUND(ios.writetim / NULLIF(ios.writes, 0) * 10, 1)              AS avg_write_ms,
       ios.reads,
       ios.writes
FROM   dba_hist_filestatxs ios
JOIN   dba_hist_datafile f ON f.file# = ios.file# AND f.snap_id = ios.snap_id
WHERE  ios.snap_id BETWEEN &begin_snap AND &end_snap
  AND  f.filename LIKE '%temp%'
ORDER BY avg_write_ms DESC;
\`\`\`

Average TEMP write latency above 20 ms indicates the storage tier is not caching writes effectively. Values above 500 ms indicate either:
- Write-back cache disabled on the array
- Queue depth saturation (array receiving more I/O than it can buffer)
- Thin-provisioned volumes hitting physical space limits

### 7.2 Real-time TEMP I/O (current instance state)

\`\`\`sql
-- Current temp file I/O statistics
SELECT tf.name,
       tf.bytes / 1073741824     AS total_gb,
       f.phyrds,
       f.phywrts,
       ROUND(f.readtim / NULLIF(f.phyrds, 0) * 10, 1)  AS avg_read_ms,
       ROUND(f.writetim / NULLIF(f.phywrts, 0) * 10, 1) AS avg_write_ms
FROM   v\$tempstat f
JOIN   v\$tempfile tf ON tf.file# = f.file#
ORDER BY f.phywrts DESC;
\`\`\`

---

## Monitoring Script: temp_pga_monitor.sh

\`\`\`bash
#!/bin/bash
# temp_pga_monitor.sh
# Monitors Oracle TEMP tablespace usage and PGA spill health
# Cron: */5 * * * * /home/oracle/scripts/temp_pga_monitor.sh >> /home/oracle/logs/temp_pga_monitor.log 2>&1

set -euo pipefail

SCRIPT_NAME="temp_pga_monitor"
LOG_DATE=$(date '+%Y-%m-%d %H:%M:%S')
ALERT=0

ORACLE_SID=\${ORACLE_SID:-EBSPRD}
ORACLE_HOME=\${ORACLE_HOME:-/u01/app/oracle/product/19.0.0/dbhome_1}
ALERT_EMAIL=\${ALERT_EMAIL:-dba-alerts@example.com}

TEMP_PCT_THRESHOLD=80           # Alert if TEMP is above this % used
SESSION_TEMP_GB_THRESHOLD=50    # Alert if a single session consumes this many GB of TEMP
PGA_HIT_THRESHOLD=80            # Alert if PGA cache hit % drops below this
MULTIPASS_THRESHOLD=5           # Alert if multipass workarea executions exceed this per check

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

# --- Check 1: TEMP tablespace usage % ---
log "=== Check 1: TEMP tablespace usage ==="
TEMP_PCT=$(run_sql "
SELECT ROUND((1 - free_space / tablespace_size) * 100, 1)
FROM dba_temp_free_space
WHERE tablespace_name = 'TEMP'
FETCH FIRST 1 ROWS ONLY;
" | tr -d ' ')

log "TEMP used: \${TEMP_PCT}% (threshold: \${TEMP_PCT_THRESHOLD}%)"
if [ -n "$TEMP_PCT" ] && awk "BEGIN{exit !($TEMP_PCT > $TEMP_PCT_THRESHOLD)}"; then
  ALERT=1
  TOP_SESSIONS=$(run_sql "
SELECT s.sid || '/' || s.serial# || ' ' || s.username || ' sql=' || NVL(s.sql_id,'none') ||
       ' ' || ROUND(SUM(su.blocks)*8192/1073741824,2) || 'GB ' || su.segtype
FROM v\$session s JOIN v\$sort_usage su ON su.session_addr=s.saddr
GROUP BY s.sid,s.serial#,s.username,s.sql_id,su.segtype
ORDER BY SUM(su.blocks) DESC
FETCH FIRST 5 ROWS ONLY;
")
  send_alert "TEMP tablespace \${TEMP_PCT}% used" \
    "TEMP tablespace has reached \${TEMP_PCT}% capacity.
Top TEMP consumers:
$TOP_SESSIONS
Check for unindexed CTE materialization or excessive hash join spills."
fi

# --- Check 2: Single session TEMP threshold ---
log "=== Check 2: Per-session TEMP consumption ==="
HIGH_TEMP_SESSION=$(run_sql "
SELECT s.sid || '/' || s.serial# || ' user=' || NVL(s.username,'SYS') ||
       ' sql=' || NVL(s.sql_id,'N/A') ||
       ' temp=' || ROUND(SUM(su.blocks)*8192/1073741824,1) || 'GB'
FROM v\$session s JOIN v\$sort_usage su ON su.session_addr=s.saddr
GROUP BY s.sid,s.serial#,s.username,s.sql_id
HAVING SUM(su.blocks)*8192/1073741824 > $SESSION_TEMP_GB_THRESHOLD
ORDER BY SUM(su.blocks) DESC
FETCH FIRST 3 ROWS ONLY;
" | sed '/^$/d')

if [ -n "$HIGH_TEMP_SESSION" ]; then
  ALERT=1
  log "High TEMP session: $HIGH_TEMP_SESSION"
  send_alert "Session consuming >\${SESSION_TEMP_GB_THRESHOLD}GB TEMP" \
    "A session is consuming more than \${SESSION_TEMP_GB_THRESHOLD}GB of TEMP:
$HIGH_TEMP_SESSION

If this is a MATERIALIZE-hinted CTE, review the physical GTT migration in the runbook."
fi

# --- Check 3: PGA cache hit percentage ---
log "=== Check 3: PGA cache hit % ==="
PGA_HIT=$(run_sql "
SELECT ROUND(value, 1) FROM v\$pgastat WHERE name = 'cache hit percentage';
" | tr -d ' ')

log "PGA cache hit: \${PGA_HIT}% (threshold: \${PGA_HIT_THRESHOLD}%)"
if [ -n "$PGA_HIT" ] && awk "BEGIN{exit !($PGA_HIT < $PGA_HIT_THRESHOLD)}"; then
  ALERT=1
  PGA_STATS=$(run_sql "
SELECT RPAD(name,40,' ') || ROUND(value/1048576,0) || ' MB'
FROM v\$pgastat
WHERE name IN ('aggregate PGA target parameter','total PGA inuse',
               'total extra bytes read/written','maximum PGA allocated')
ORDER BY name;
")
  send_alert "PGA cache hit degraded: \${PGA_HIT}%" \
    "PGA cache hit percentage is \${PGA_HIT}%, below the \${PGA_HIT_THRESHOLD}% threshold.
SQL workareas are spilling to TEMP excessively.

PGA statistics:
$PGA_STATS

Consider increasing pga_aggregate_target."
fi

# --- Check 4: Multipass workarea executions (worst-case spill) ---
log "=== Check 4: Active multipass workareas ==="
MULTIPASS_COUNT=$(run_sql "
SELECT COUNT(*) FROM v\$sql_workarea_active WHERE number_passes > 1;
" | tr -d ' ')

log "Active multipass workareas: $MULTIPASS_COUNT (threshold: $MULTIPASS_THRESHOLD)"
if [ "$MULTIPASS_COUNT" -gt "$MULTIPASS_THRESHOLD" ]; then
  ALERT=1
  MULTIPASS_DETAIL=$(run_sql "
SELECT sid, operation_type,
       ROUND(work_area_size/1048576,0) || 'MB wa / ' ||
       ROUND(tempseg_size/1073741824,2) || 'GB temp' AS sizes,
       number_passes
FROM v\$sql_workarea_active WHERE number_passes > 1
ORDER BY tempseg_size DESC FETCH FIRST 5 ROWS ONLY;
")
  send_alert "Multipass workarea spills: $MULTIPASS_COUNT active" \
    "There are $MULTIPASS_COUNT active workareas running in multipass mode.
These are writing and re-reading TEMP multiple times, severely impacting performance.

Details:
$MULTIPASS_DETAIL

Increase pga_aggregate_target or reduce data volume per batch."
fi

# --- Check 5: TEMP write latency (if temp files show high avg write time) ---
log "=== Check 5: TEMP file write latency ==="
HIGH_LATENCY=$(run_sql "
SELECT tf.name || ' avg_write=' || ROUND(f.writetim/NULLIF(f.phywrts,0)*10,0) || 'ms'
FROM v\$tempstat f JOIN v\$tempfile tf ON tf.file# = f.file#
WHERE f.phywrts > 100
  AND f.writetim/NULLIF(f.phywrts,0)*10 > 100
ORDER BY f.writetim/NULLIF(f.phywrts,0) DESC
FETCH FIRST 3 ROWS ONLY;
" | sed '/^$/d')

if [ -n "$HIGH_LATENCY" ]; then
  ALERT=1
  log "High TEMP write latency: $HIGH_LATENCY"
  send_alert "TEMP file write latency >100ms" \
    "TEMP file write latency is elevated:
$HIGH_LATENCY

Check storage array write-back cache status and I/O queue depth.
High TEMP latency dramatically worsens sort and hash join spill performance."
fi

# --- Summary ---
log "=== Summary ==="
log "TEMP: \${TEMP_PCT}% | PGA hit: \${PGA_HIT}% | Multipass: $MULTIPASS_COUNT | High-TEMP session: \${HIGH_TEMP_SESSION:-none}"
[ "$ALERT" -eq 0 ] && log "STATUS: OK" || log "STATUS: ALERT SENT"
\`\`\`

### Deploy and schedule

\`\`\`bash
mkdir -p /home/oracle/scripts /home/oracle/logs
cp temp_pga_monitor.sh /home/oracle/scripts/
chmod 750 /home/oracle/scripts/temp_pga_monitor.sh

# Add Oracle environment source at the top of the script:
# source /home/oracle/.bash_profile

# Cron — every 5 minutes during active investigation
(crontab -l 2>/dev/null; echo "*/5 * * * * /home/oracle/scripts/temp_pga_monitor.sh >> /home/oracle/logs/temp_pga_monitor.log 2>&1") | crontab -
\`\`\`

---

## Quick Reference

| Symptom | Phase |
|---------|-------|
| Query filling TEMP or ORA-1652 error | Phase 1 — identify session |
| TEMP consumed but no clear session | Phase 1.2 — segtype breakdown |
| Need to stop the TEMP growth immediately | Phase 1.5 — kill session |
| Understand PGA health | Phase 2 |
| Create the physical GTT | Phase 3 |
| Run the rewrite in staging | Phase 4 |
| Verify TEMP is actually reduced | Phase 5 |
| Tune PGA for RAC batch workloads | Phase 6 |
| Storage latency contributing to slow spills | Phase 7 |

---

## Key Diagnostic Views Reference

| View | Purpose |
|------|---------|
| \`V\$SORT_USAGE\` | Current TEMP allocation by session and segment type |
| \`V\$SQL_WORKAREA_ACTIVE\` | Active sort/hash workareas with spill status |
| \`V\$SQL_WORKAREA\` | Historical workarea statistics per SQL |
| \`V\$SQL_WORKAREA_HISTOGRAM\` | Optimal/onepass/multipass distribution |
| \`V\$PGASTAT\` | Aggregate PGA statistics and cache hit % |
| \`DBA_TEMP_FREE_SPACE\` | TEMP tablespace free space summary |
| \`V\$TEMPSTAT\` | TEMP file I/O statistics |
| \`DBA_HIST_FILESTATXS\` | Historical I/O latency per file from AWR |`,
};

async function main() {
  console.log('Inserting CTE TEMP explosion runbook...');
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
