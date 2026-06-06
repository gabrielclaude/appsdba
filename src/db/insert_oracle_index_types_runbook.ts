import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Index Design, Monitoring, and Maintenance',
  slug: 'oracle-index-types-design-monitoring-runbook',
  excerpt:
    'A complete operational runbook for Oracle DBA index management covering inventory checks, creation of all major index types, clustering factor analysis, usage monitoring, fragmentation detection, rebuild procedures, and identification of missing and harmful indexes. Includes a shell script for automated nightly index health alerting with Nagios-compatible exit codes.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-05'),
  youtubeUrl: null,
  content: `## Overview

This runbook provides ready-to-run SQL and shell scripts for every phase of Oracle index management. Assumptions: Oracle 12.2 or later, DBA role for all diagnostic queries, CREATE INDEX privilege on the target schema for index creation steps, and SYSDBA for any steps that modify system-level parameters. Test all DDL in a non-production environment before executing in production. Replace \`&schema_name\`, \`&table_name\`, \`&index_name\`, \`&partition_name\`, and \`&sql_id\` with actual values when running interactively, or bind them as shell variables when scripting.

---

## Phase 0: Index Inventory and Health Check

### Step 0.1: List all indexes on a table with type and status

\`\`\`sql
SELECT index_name,
       index_type,
       uniqueness,
       status,
       num_rows,
       distinct_keys,
       clustering_factor,
       last_analyzed,
       visibility,
       partitioned
FROM dba_indexes
WHERE table_owner = upper('&schema_name')
  AND table_name  = upper('&table_name')
ORDER BY index_name;
\`\`\`

### Step 0.2: List index columns and column order

\`\`\`sql
SELECT i.index_name,
       ic.column_position,
       ic.column_name,
       ic.descend,
       i.index_type,
       i.uniqueness
FROM dba_indexes i
JOIN dba_ind_columns ic ON ic.index_name = i.index_name
                        AND ic.index_owner = i.owner
WHERE i.table_owner = upper('&schema_name')
  AND i.table_name  = upper('&table_name')
ORDER BY i.index_name, ic.column_position;
\`\`\`

### Step 0.3: Find UNUSABLE indexes

\`\`\`sql
SELECT owner, index_name, table_name, status, last_analyzed
FROM dba_indexes
WHERE status = 'UNUSABLE'
  AND owner NOT IN ('SYS','SYSTEM','DBSNMP','OUTLN')
ORDER BY owner, table_name;

-- Also check unusable index partitions:
SELECT index_owner, index_name, partition_name, status
FROM dba_ind_partitions
WHERE status = 'UNUSABLE'
ORDER BY index_owner, index_name;
\`\`\`

### Step 0.4: Check index segment size

\`\`\`sql
SELECT s.owner,
       s.segment_name,
       s.segment_type,
       round(s.bytes / 1048576, 1) as size_mb,
       s.extents,
       s.blocks
FROM dba_segments s
WHERE s.owner = upper('&schema_name')
  AND s.segment_type LIKE 'INDEX%'
ORDER BY s.bytes DESC
FETCH FIRST 30 ROWS ONLY;
\`\`\`

---

## Phase 1: Creating Index Types

### Step 1.1: Standard B-Tree index

\`\`\`sql
CREATE INDEX idx_emp_last_name
  ON employees(last_name)
  TABLESPACE users
  PARALLEL 4
  NOLOGGING;
-- After creation, reset logging and parallelism for DML:
ALTER INDEX idx_emp_last_name LOGGING NOPARALLEL;
\`\`\`

**Note:** Always reset NOLOGGING to LOGGING after creation in production. NOLOGGING indexes are not recoverable from archived redo logs — after a media recovery, NOLOGGING indexes must be rebuilt. Accept this risk only during initial build; remove it immediately after.

### Step 1.2: Unique index (preferred over UNIQUE constraint for control)

\`\`\`sql
CREATE UNIQUE INDEX idx_emp_email_uk
  ON employees(email)
  TABLESPACE users;
\`\`\`

Using a unique index directly rather than a UNIQUE constraint gives you explicit control over the index name, tablespace, and storage parameters. A UNIQUE constraint implicitly creates a unique index, but the index name is system-generated and the storage parameters default to the table's tablespace.

### Step 1.3: Composite index (equality column first, then range column)

\`\`\`sql
CREATE INDEX idx_orders_cust_date
  ON orders(customer_id, order_date)
  TABLESPACE users;
\`\`\`

This index supports \`WHERE customer_id = :cid\`, \`WHERE customer_id = :cid AND order_date BETWEEN :d1 AND :d2\`, and potentially a skip scan for \`WHERE order_date BETWEEN :d1 AND :d2\` if customer_id cardinality is very low. It does not support efficient range scan on order_date alone without the leading customer_id predicate.

### Step 1.4: Function-based index (case-insensitive search)

\`\`\`sql
CREATE INDEX idx_emp_upper_name
  ON employees(UPPER(last_name))
  TABLESPACE users;
-- Query must use UPPER(last_name) in WHERE clause to use this index:
-- WHERE UPPER(last_name) = 'SMITH'
\`\`\`

Verify the session parameter: \`SHOW PARAMETER query_rewrite_enabled\`. It must be TRUE. Also verify: \`SELECT value FROM v\$option WHERE parameter = 'Query Rewrite'\` returns TRUE.

### Step 1.5: Bitmap index (OLAP/DW only — never on OLTP tables)

\`\`\`sql
CREATE BITMAP INDEX idx_orders_status_bmp
  ON orders(status)
  TABLESPACE users;
\`\`\`

Only create bitmap indexes on tables that receive bulk-loaded data and no concurrent DML during query hours. Creating a bitmap index on an OLTP table will cause severe transaction serialization.

### Step 1.6: Reverse key index (sequence-generated key hotspot relief)

\`\`\`sql
CREATE INDEX idx_orders_id_rev
  ON orders(order_id)
  REVERSE
  TABLESPACE users;
\`\`\`

Confirm the hotspot problem exists before creating a reverse key index. Query \`V\$SESSION_WAIT\` for \`buffer busy waits\` with P3 = 1 (data block), and check \`V\$BH\` to identify the block. Only use reverse key indexes when range scans on the indexed column are never required.

### Step 1.7: Invisible index (safe testing)

\`\`\`sql
CREATE INDEX idx_emp_dept_hire
  ON employees(department_id, hire_date)
  INVISIBLE;

-- Test with invisible indexes visible in this session only:
ALTER SESSION SET optimizer_use_invisible_indexes = TRUE;
-- Run query, check plan, then decide whether to make visible:
ALTER INDEX idx_emp_dept_hire VISIBLE;
\`\`\`

Use invisible indexes to test new indexes without affecting production execution plans. Also use them when decommissioning an index: make it invisible, monitor for a week, then drop if no regressions.

### Step 1.8: Local partitioned index (on a partitioned table)

\`\`\`sql
CREATE INDEX idx_orders_local_date
  ON orders(order_date)
  LOCAL
  TABLESPACE users;
\`\`\`

Local indexes are automatically maintained when table partitions are added or dropped. No \`UPDATE INDEXES\` clause is required for partition DROP or TRUNCATE when using local indexes.

### Step 1.9: Global partitioned index (range-partitioned by its own key)

\`\`\`sql
CREATE INDEX idx_orders_global_cust
  ON orders(customer_id)
  GLOBAL PARTITION BY RANGE (customer_id) (
    PARTITION p_low    VALUES LESS THAN (100000),
    PARTITION p_mid    VALUES LESS THAN (500000),
    PARTITION p_high   VALUES LESS THAN (MAXVALUE)
  )
  TABLESPACE users;
\`\`\`

Global indexes require explicit partition management. When dropping or truncating table partitions, use \`UPDATE GLOBAL INDEXES\` to prevent the global index from becoming UNUSABLE.

---

## Phase 2: Index Clustering Factor Analysis

### Step 2.1: Clustering factor vs num_rows comparison

\`\`\`sql
SELECT i.index_name,
       t.num_rows,
       t.blocks as table_blocks,
       i.clustering_factor,
       round(i.clustering_factor / nullif(t.num_rows, 0) * 100, 2) as cf_pct_rows,
       round(i.clustering_factor / nullif(t.blocks, 0), 2) as cf_per_block,
       CASE
         WHEN i.clustering_factor <= t.blocks * 2 THEN 'EXCELLENT'
         WHEN i.clustering_factor <= t.num_rows * 0.1 THEN 'GOOD'
         WHEN i.clustering_factor <= t.num_rows * 0.5 THEN 'FAIR'
         ELSE 'POOR - consider table reorganisation'
       END as cf_rating
FROM dba_indexes i
JOIN dba_tables t ON t.owner = i.table_owner
                 AND t.table_name = i.table_name
WHERE i.table_owner = upper('&schema_name')
  AND i.table_name  = upper('&table_name')
ORDER BY i.clustering_factor DESC;
\`\`\`

A clustering factor close to \`num_blocks\` is excellent. A clustering factor close to \`num_rows\` is poor and means index range scans will cause one I/O per row — often worse than a full table scan. To improve a poor clustering factor, reorganise the table (INSERT ... SELECT into a new table in the desired order, or use online table redefinition with \`DBMS_REDEFINITION\`).

### Step 2.2: Simulate improved clustering factor without table reorganisation (column groups)

\`\`\`sql
-- Create extended statistics on a column group to help cardinality estimates:
SELECT dbms_stats.create_extended_stats(
  ownname  => '&schema_name',
  tabname  => '&table_name',
  extension => '(department_id, job_id)'
) AS ext_stat_name
FROM dual;
\`\`\`

Extended statistics on column groups improve the optimizer's cardinality estimates for multi-column predicates, which can cause it to choose a more efficient access path even when the physical clustering factor is poor.

---

## Phase 3: Index Usage Monitoring

### Step 3.1: Enable usage monitoring on all indexes for a schema

\`\`\`sql
BEGIN
  FOR i IN (
    SELECT index_name
    FROM dba_indexes
    WHERE owner = upper('&schema_name')
      AND index_type NOT IN ('LOB')
  ) LOOP
    EXECUTE IMMEDIATE 'ALTER INDEX '
      || upper('&schema_name') || '.' || i.index_name
      || ' MONITORING USAGE';
  END LOOP;
END;
/
\`\`\`

Run this at the start of a representative workload period (ideally a full business week including batch jobs). Leave monitoring enabled for at minimum 24–48 hours; 7 days is preferable for workloads with weekly batch patterns.

### Step 3.2: Check index usage after a representative workload period

\`\`\`sql
SELECT u.index_name,
       u.table_name,
       u.monitoring,
       u.used,
       u.start_monitoring,
       u.end_monitoring,
       i.num_rows,
       round(s.bytes / 1048576, 1) as index_size_mb
FROM v\$object_usage u
JOIN dba_indexes i ON i.index_name = u.index_name
                   AND i.owner = upper('&schema_name')
JOIN dba_segments s ON s.segment_name = u.index_name
                    AND s.owner = upper('&schema_name')
WHERE u.used = 'NO'
ORDER BY s.bytes DESC;
\`\`\`

Indexes with \`used = 'NO'\` were not accessed by any optimizer during the monitoring period. Large unused indexes (high index_size_mb) are the highest-priority candidates for removal. Before dropping, make the index invisible and monitor for another week.

### Step 3.3: Find duplicate or redundant indexes (same leading columns)

\`\`\`sql
SELECT a.owner,
       a.table_name,
       a.index_name as index_a,
       b.index_name as index_b,
       a_cols.cols as cols_a,
       b_cols.cols as cols_b
FROM dba_indexes a
JOIN dba_indexes b ON b.table_owner = a.table_owner
                   AND b.table_name = a.table_name
                   AND b.index_name > a.index_name
JOIN (
  SELECT index_name, index_owner,
         listagg(column_name, ',') WITHIN GROUP (ORDER BY column_position) as cols
  FROM dba_ind_columns
  GROUP BY index_name, index_owner
) a_cols ON a_cols.index_name = a.index_name AND a_cols.index_owner = a.owner
JOIN (
  SELECT index_name, index_owner,
         listagg(column_name, ',') WITHIN GROUP (ORDER BY column_position) as cols
  FROM dba_ind_columns
  GROUP BY index_name, index_owner
) b_cols ON b_cols.index_name = b.index_name AND b_cols.index_owner = b.owner
WHERE a.owner = upper('&schema_name')
  AND (a_cols.cols LIKE b_cols.cols || '%'
    OR b_cols.cols LIKE a_cols.cols || '%')
ORDER BY a.table_name, a.index_name;
\`\`\`

This query finds pairs of indexes where one index's column list is a prefix of the other. The shorter index is usually redundant — any query the shorter index could serve can be served by the longer index. Exceptions: the shorter index may have a much better clustering factor, or the shorter index may be a covering index for a specific query.

---

## Phase 4: Index Rebuild and Maintenance

### Step 4.1: Check index fragmentation (blevel and del_lf_rows)

\`\`\`sql
SELECT index_name,
       blevel,
       leaf_blocks,
       distinct_keys,
       num_rows,
       del_lf_rows,
       round(del_lf_rows * 100.0 / nullif(num_rows, 0), 2) as pct_deleted,
       last_analyzed
FROM dba_indexes
WHERE table_owner = upper('&schema_name')
  AND table_name  = upper('&table_name')
ORDER BY del_lf_rows DESC;
-- blevel > 4 or pct_deleted > 30% are candidates for rebuild
\`\`\`

\`BLEVEL\` is the height of the B-Tree minus 1 (number of branch levels above the leaf level). A BLEVEL above 4 indicates an unusually deep tree, typically caused by a large number of inserts followed by deletions that left the tree unbalanced. \`DEL_LF_ROWS\` counts soft-deleted leaf entries that have not yet been reused. These inflate the index size without contributing to query performance. Note that \`DBA_INDEXES\` statistics are populated by \`DBMS_STATS\` or \`ANALYZE\` — if \`LAST_ANALYZED\` is stale, the reported values may not reflect current state.

### Step 4.2: Validate index structure

\`\`\`sql
ANALYZE INDEX &schema_name..&index_name VALIDATE STRUCTURE;

SELECT name, height, blocks, lf_rows, lf_blks, del_lf_rows,
       round(del_lf_rows * 100 / nullif(lf_rows, 0), 2) as pct_deleted
FROM index_stats;
\`\`\`

\`ANALYZE INDEX ... VALIDATE STRUCTURE\` performs a full scan of the index B-Tree and populates the session-level \`INDEX_STATS\` view with current structural metrics. Unlike \`DBA_INDEXES\`, this data is always current. Run this on a non-production replica or during a maintenance window — the command acquires a share lock on the index for the duration. \`INDEX_STATS\` contains only one row at a time (the result of the most recent ANALYZE in the session).

### Step 4.3: Rebuild an index online (non-blocking)

\`\`\`sql
ALTER INDEX &schema_name..&index_name REBUILD ONLINE
  PARALLEL 4
  NOLOGGING;
-- Reset after:
ALTER INDEX &schema_name..&index_name LOGGING NOPARALLEL;
\`\`\`

\`REBUILD ONLINE\` creates a new index structure while allowing concurrent DML. It uses a journal table to capture changes made during the build and applies them before completing the swap. It requires a brief exclusive lock at the end of the rebuild to apply the final journal entries — typically sub-second. Note that REBUILD ONLINE is not supported for IOTs, bitmap indexes, or indexes containing LOB columns.

### Step 4.4: Coalesce index (merges leaf blocks, less disruptive than rebuild)

\`\`\`sql
ALTER INDEX &schema_name..&index_name COALESCE;
\`\`\`

COALESCE merges adjacent under-full leaf blocks into single blocks, reducing fragmentation without rebuilding the entire index structure. It is faster and less resource-intensive than REBUILD for indexes that are primarily fragmented by leaf-block under-fill (many soft-deleted entries) rather than by tree depth. It does not reset the high-water mark of the index segment — it cannot reduce the total number of blocks allocated. REBUILD is required to reduce the index segment's allocated size.

### Step 4.5: Rebuild a specific index partition

\`\`\`sql
ALTER INDEX &schema_name..&index_name
  REBUILD PARTITION &partition_name
  ONLINE PARALLEL 4 NOLOGGING;
\`\`\`

Use this to rebuild individual UNUSABLE global index partitions after partition maintenance operations, rather than rebuilding the entire global index. After rebuilding, reset logging: \`ALTER INDEX &schema_name..&index_name MODIFY PARTITION &partition_name LOGGING NOPARALLEL\`.

### Step 4.6: Rebuild all UNUSABLE indexes for a table

\`\`\`sql
BEGIN
  FOR i IN (
    SELECT owner, index_name
    FROM dba_indexes
    WHERE table_owner = upper('&schema_name')
      AND table_name  = upper('&table_name')
      AND status = 'UNUSABLE'
  ) LOOP
    EXECUTE IMMEDIATE
      'ALTER INDEX ' || i.owner || '.' || i.index_name || ' REBUILD ONLINE';
    dbms_output.put_line('Rebuilt: ' || i.index_name);
  END LOOP;
END;
/
\`\`\`

Run this after any partition maintenance operation that did not include \`UPDATE INDEXES\` or \`UPDATE GLOBAL INDEXES\`. Also run after importing data with \`SKIP_UNUSABLE_INDEXES = TRUE\`.

---

## Phase 5: Identifying Missing and Harmful Indexes

### Step 5.1: Find full table scans with filter predicates on high-row tables

\`\`\`sql
SELECT p.sql_id,
       p.object_owner,
       p.object_name,
       p.filter_predicates,
       t.num_rows,
       s.executions,
       round(s.elapsed_time / 1e6, 2) as total_elapsed_sec,
       round(s.disk_reads / nullif(s.executions, 0), 0) as disk_reads_per_exec
FROM v\$sql_plan p
JOIN v\$sql s ON s.sql_id = p.sql_id AND s.child_number = p.child_number
JOIN dba_tables t ON t.owner = p.object_owner AND t.table_name = p.object_name
WHERE p.operation = 'TABLE ACCESS'
  AND p.options = 'FULL'
  AND p.filter_predicates IS NOT NULL
  AND t.num_rows > 100000
  AND s.executions > 5
ORDER BY s.elapsed_time DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

This query identifies the most expensive full table scans in the shared SQL area that have filter predicates — meaning an index might help. The \`filter_predicates\` column shows the WHERE clause columns. Sort by \`total_elapsed_sec\` to prioritise. A filter predicate on a high-cardinality column in a large table with many executions is the strongest signal for a missing index.

### Step 5.2: Use SQL Tuning Advisor to get index recommendations

\`\`\`sql
DECLARE
  l_task VARCHAR2(30);
BEGIN
  l_task := dbms_sqltune.create_tuning_task(
    sql_id      => '&sql_id',
    scope       => 'COMPREHENSIVE',
    time_limit  => 60,
    task_name   => 'TUNE_&sql_id'
  );
  dbms_sqltune.execute_tuning_task(task_name => l_task);
END;
/

SELECT dbms_sqltune.report_tuning_task('TUNE_&sql_id') FROM dual;
\`\`\`

SQL Tuning Advisor runs the SQL optimizer in tuning mode, which explores alternative access paths including indexes that do not yet exist. It will recommend specific index creation statements if an index would improve the plan cost. The recommendation includes the estimated benefit. Requires the \`ADVISOR\` system privilege. Task results persist in the data dictionary and can be retrieved later with \`DBMS_SQLTUNE.REPORT_TUNING_TASK\`.

### Step 5.3: Identify indexes causing DML overhead (high DML tables with many indexes)

\`\`\`sql
SELECT t.owner,
       t.table_name,
       t.num_rows,
       count(i.index_name) as index_count,
       round(sum(s.bytes) / 1048576, 1) as total_index_mb
FROM dba_tables t
JOIN dba_indexes i ON i.table_owner = t.owner AND i.table_name = t.table_name
JOIN dba_segments s ON s.segment_name = i.index_name AND s.owner = i.owner
WHERE t.owner = upper('&schema_name')
GROUP BY t.owner, t.table_name, t.num_rows
HAVING count(i.index_name) > 5
ORDER BY count(i.index_name) DESC;
\`\`\`

Tables with more than 5–7 indexes on a high-throughput OLTP workload are candidates for an index rationalisation review. Cross-reference with AWR top SQL to identify whether insert/update/delete statements on these tables appear in the top elapsed time list — if so, redundant indexes are a likely contributor.

---

## Phase 6: Index Monitoring Shell Script (with crontab)

### index_health_check.sh

\`\`\`bash
#!/bin/bash
# index_health_check.sh
# Oracle Index Health Check Script
# Usage: ./index_health_check.sh <ORACLE_SID> <SCHEMA_NAME>
# Returns: exit code = number of issues found (Nagios-compatible)
# Requires: Oracle client environment, sqlplus, mailx or sendmail

ORACLE_SID=\${1:?Usage: \$0 ORACLE_SID SCHEMA_NAME}
SCHEMA_NAME=\${2:?Usage: \$0 ORACLE_SID SCHEMA_NAME}

export ORACLE_SID
ORACLE_HOME=\${ORACLE_HOME:-/u01/app/oracle/product/19.0.0/dbhome_1}
export ORACLE_HOME
export PATH=\${ORACLE_HOME}/bin:\${PATH}
export LD_LIBRARY_PATH=\${ORACLE_HOME}/lib:\${LD_LIBRARY_PATH:-}

LOG_DIR="/u01/app/oracle/scripts/index_monitor/logs"
LOG_FILE="\${LOG_DIR}/index_health_\${ORACLE_SID}_\$(date +%Y%m%d).log"
ALERT_EMAIL="dba-alerts@example.com"
ISSUE_COUNT=0

mkdir -p "\${LOG_DIR}"

log() {
  echo "[\$(date '+%Y-%m-%d %H:%M:%S')] \$*" | tee -a "\${LOG_FILE}"
}

log "=== Oracle Index Health Check: SID=\${ORACLE_SID} SCHEMA=\${SCHEMA_NAME} ==="

# ---------------------------------------------------------------
# Run SQL and capture output to a temp file
# ---------------------------------------------------------------
TMP_SQL="\${LOG_DIR}/tmp_index_check_\$\$.sql"
TMP_OUT="\${LOG_DIR}/tmp_index_out_\$\$.txt"

trap 'rm -f "\${TMP_SQL}" "\${TMP_OUT}"' EXIT

# ---------------------------------------------------------------
# Check 1: UNUSABLE indexes
# ---------------------------------------------------------------
log "--- Check 1: UNUSABLE indexes ---"

cat > "\${TMP_SQL}" <<'SQLEOF'
SET PAGESIZE 200 LINESIZE 200 FEEDBACK OFF HEADING ON
COLUMN owner          FORMAT A20
COLUMN index_name     FORMAT A40
COLUMN table_name     FORMAT A30
COLUMN status         FORMAT A10
COLUMN last_analyzed  FORMAT A20

SELECT owner,
       index_name,
       table_name,
       status,
       to_char(last_analyzed, 'YYYY-MM-DD HH24:MI') as last_analyzed
FROM dba_indexes
WHERE status = 'UNUSABLE'
  AND owner NOT IN ('SYS','SYSTEM','DBSNMP','OUTLN')
ORDER BY owner, table_name;

COLUMN index_owner     FORMAT A20
COLUMN index_name      FORMAT A40
COLUMN partition_name  FORMAT A30

SELECT index_owner,
       index_name,
       partition_name,
       status
FROM dba_ind_partitions
WHERE status = 'UNUSABLE'
ORDER BY index_owner, index_name;
SQLEOF

sqlplus -s / as sysdba @"\${TMP_SQL}" > "\${TMP_OUT}" 2>&1
UNUSABLE_COUNT=\$(grep -cE 'UNUSABLE' "\${TMP_OUT}" || true)

if [ "\${UNUSABLE_COUNT}" -gt 0 ]; then
  log "ALERT: Found \${UNUSABLE_COUNT} UNUSABLE index entries"
  cat "\${TMP_OUT}" >> "\${LOG_FILE}"
  ISSUE_COUNT=\$((ISSUE_COUNT + UNUSABLE_COUNT))
else
  log "OK: No UNUSABLE indexes found"
fi

# ---------------------------------------------------------------
# Check 2: Indexes with BLEVEL > 4 (over-deep B-Tree)
# ---------------------------------------------------------------
log "--- Check 2: Indexes with BLEVEL > 4 ---"

cat > "\${TMP_SQL}" <<'SQLEOF'
SET PAGESIZE 200 LINESIZE 200 FEEDBACK OFF HEADING ON
COLUMN owner       FORMAT A20
COLUMN index_name  FORMAT A40
COLUMN table_name  FORMAT A30

SELECT owner,
       index_name,
       table_name,
       blevel,
       leaf_blocks,
       num_rows
FROM dba_indexes
WHERE blevel > 4
  AND owner NOT IN ('SYS','SYSTEM','DBSNMP','OUTLN')
ORDER BY blevel DESC, num_rows DESC;
SQLEOF

sqlplus -s / as sysdba @"\${TMP_SQL}" > "\${TMP_OUT}" 2>&1
BLEVEL_COUNT=\$(grep -c '^[A-Z]' "\${TMP_OUT}" || true)

if [ "\${BLEVEL_COUNT}" -gt 0 ]; then
  log "ALERT: Found \${BLEVEL_COUNT} indexes with BLEVEL > 4 (over-deep B-Tree, rebuild candidate)"
  cat "\${TMP_OUT}" >> "\${LOG_FILE}"
  ISSUE_COUNT=\$((ISSUE_COUNT + BLEVEL_COUNT))
else
  log "OK: No indexes with BLEVEL > 4"
fi

# ---------------------------------------------------------------
# Check 3: Indexes with pct_deleted > 30% (fragmented)
# ---------------------------------------------------------------
log "--- Check 3: Indexes with pct_deleted > 30% ---"

cat > "\${TMP_SQL}" <<'SQLEOF'
SET PAGESIZE 200 LINESIZE 200 FEEDBACK OFF HEADING ON
COLUMN owner        FORMAT A20
COLUMN index_name   FORMAT A40
COLUMN table_name   FORMAT A30
COLUMN pct_deleted  FORMAT 999.99

SELECT owner,
       index_name,
       table_name,
       num_rows,
       del_lf_rows,
       round(del_lf_rows * 100.0 / nullif(num_rows, 0), 2) as pct_deleted,
       to_char(last_analyzed, 'YYYY-MM-DD') as last_analyzed
FROM dba_indexes
WHERE num_rows > 10000
  AND del_lf_rows * 100.0 / nullif(num_rows, 0) > 30
  AND owner NOT IN ('SYS','SYSTEM','DBSNMP','OUTLN')
ORDER BY del_lf_rows DESC;
SQLEOF

sqlplus -s / as sysdba @"\${TMP_SQL}" > "\${TMP_OUT}" 2>&1
FRAG_COUNT=\$(grep -c '^[A-Z]' "\${TMP_OUT}" || true)

if [ "\${FRAG_COUNT}" -gt 0 ]; then
  log "ALERT: Found \${FRAG_COUNT} indexes with >30% deleted leaf rows (coalesce/rebuild candidate)"
  cat "\${TMP_OUT}" >> "\${LOG_FILE}"
  ISSUE_COUNT=\$((ISSUE_COUNT + FRAG_COUNT))
else
  log "OK: No indexes with excessive deleted leaf rows"
fi

# ---------------------------------------------------------------
# Check 4: Large indexes not analyzed in > 30 days (> 10GB)
# ---------------------------------------------------------------
log "--- Check 4: Large indexes (>10GB) not analyzed in 30+ days ---"

cat > "\${TMP_SQL}" <<'SQLEOF'
SET PAGESIZE 200 LINESIZE 220 FEEDBACK OFF HEADING ON
COLUMN owner        FORMAT A20
COLUMN index_name   FORMAT A40
COLUMN table_name   FORMAT A30
COLUMN size_gb      FORMAT 99999.99
COLUMN last_analyzed FORMAT A20

SELECT i.owner,
       i.index_name,
       i.table_name,
       round(s.bytes / 1073741824, 2) as size_gb,
       to_char(i.last_analyzed, 'YYYY-MM-DD HH24:MI') as last_analyzed,
       i.status
FROM dba_indexes i
JOIN dba_segments s ON s.segment_name = i.index_name
                    AND s.owner = i.owner
WHERE s.bytes > 10737418240
  AND (i.last_analyzed IS NULL OR i.last_analyzed < sysdate - 30)
  AND i.owner NOT IN ('SYS','SYSTEM','DBSNMP','OUTLN')
ORDER BY s.bytes DESC;
SQLEOF

sqlplus -s / as sysdba @"\${TMP_SQL}" > "\${TMP_OUT}" 2>&1
STALE_COUNT=\$(grep -c '^[A-Z]' "\${TMP_OUT}" || true)

if [ "\${STALE_COUNT}" -gt 0 ]; then
  log "ALERT: Found \${STALE_COUNT} indexes over 10GB with stale statistics (not analyzed in 30+ days)"
  cat "\${TMP_OUT}" >> "\${LOG_FILE}"
  ISSUE_COUNT=\$((ISSUE_COUNT + STALE_COUNT))
else
  log "OK: All large indexes have recent statistics"
fi

# ---------------------------------------------------------------
# Final summary and alert email
# ---------------------------------------------------------------
log "=== SUMMARY: \${ISSUE_COUNT} issue(s) found for SID=\${ORACLE_SID} SCHEMA=\${SCHEMA_NAME} ==="

if [ "\${ISSUE_COUNT}" -gt 0 ]; then
  SUBJECT="[INDEX ALERT] \${ORACLE_SID}: \${ISSUE_COUNT} index issue(s) found on \$(date +%Y-%m-%d)"
  if command -v mailx &>/dev/null; then
    mailx -s "\${SUBJECT}" "\${ALERT_EMAIL}" < "\${LOG_FILE}"
  elif command -v sendmail &>/dev/null; then
    {
      echo "Subject: \${SUBJECT}"
      echo "To: \${ALERT_EMAIL}"
      echo ""
      cat "\${LOG_FILE}"
    } | sendmail "\${ALERT_EMAIL}"
  else
    log "WARNING: Neither mailx nor sendmail found — email alert skipped"
  fi
fi

exit "\${ISSUE_COUNT}"
\`\`\`

### Crontab entry (daily at 2 AM)

\`\`\`
0  2  *  *  *  /u01/app/oracle/scripts/index_monitor/index_health_check.sh PRODDB APPSCHEMA >> /u01/app/oracle/scripts/index_monitor/logs/cron_index.log 2>&1
\`\`\`

Add this to the oracle OS user's crontab: \`crontab -e\` as oracle. The script returns exit code = number of issues, which is Nagios-compatible (0 = OK, >0 = problem). Ensure the script is executable: \`chmod 750 /u01/app/oracle/scripts/index_monitor/index_health_check.sh\`.

---

## Quick Reference

### Index creation syntax recap

| Index Type | Syntax |
|---|---|
| B-Tree | \`CREATE INDEX name ON table(col)\` |
| Unique | \`CREATE UNIQUE INDEX name ON table(col)\` |
| Composite | \`CREATE INDEX name ON table(col1, col2)\` — leading column is everything |
| Function-Based | \`CREATE INDEX name ON table(UPPER(col))\` |
| Bitmap | \`CREATE BITMAP INDEX name ON table(col)\` — OLAP only |
| Reverse Key | \`CREATE INDEX name ON table(col) REVERSE\` |
| Invisible | \`CREATE INDEX name ON table(col) INVISIBLE\` |
| Local Partitioned | \`CREATE INDEX name ON table(col) LOCAL\` |
| Global Partitioned | \`CREATE INDEX name ON table(col) GLOBAL PARTITION BY RANGE (...)\` |

### Key data dictionary views

- \`DBA_INDEXES\` — index metadata, statistics, status, visibility
- \`DBA_IND_COLUMNS\` — index columns and column positions
- \`DBA_IND_PARTITIONS\` — index partition status and statistics
- \`DBA_IND_EXPRESSIONS\` — function-based index expressions
- \`DBA_SEGMENTS\` — index segment sizes
- \`V\$OBJECT_USAGE\` — index usage monitoring results
- \`INDEX_STATS\` — structural analysis results after ANALYZE ... VALIDATE STRUCTURE

### Maintenance command reference

\`\`\`sql
-- Rebuild online (non-blocking):
ALTER INDEX schema.index_name REBUILD ONLINE;

-- Coalesce (merge under-full leaf blocks):
ALTER INDEX schema.index_name COALESCE;

-- Make invisible (hide from optimizer, still maintained):
ALTER INDEX schema.index_name INVISIBLE;

-- Make visible (restore to optimizer consideration):
ALTER INDEX schema.index_name VISIBLE;

-- Enable usage monitoring:
ALTER INDEX schema.index_name MONITORING USAGE;

-- Disable usage monitoring:
ALTER INDEX schema.index_name NOMONITORING USAGE;

-- Rebuild unusable index partition:
ALTER INDEX schema.index_name REBUILD PARTITION partition_name ONLINE;

-- Drop index partition maintenance overhead (always use this):
ALTER TABLE schema.table_name DROP PARTITION partition_name UPDATE GLOBAL INDEXES;
\`\`\`

### Decision framework summary

1. **High-cardinality OLTP column** (unique IDs, emails, order numbers) → B-Tree
2. **Low-cardinality analytical column** (status, region, category) on read-heavy DW → Bitmap
3. **Expression predicate** (UPPER, TRIM, EXTRACT, arithmetic) → Function-Based index
4. **Multi-column access pattern** → Composite index; put equality column first, range column last
5. **Sequence-generated PK with insert contention** (equality access only) → Reverse Key
6. **Index key matches table partition key** → Local partitioned index
7. **Uniqueness across partitions or non-partition-key access** → Global partitioned index
8. **Testing without production risk** → Invisible index
9. **Primary-key dominated access, small rows** → IOT (Index-Organised Table)
10. **Archive partitions never queried via index** → Partial index (\`INDEXING OFF\`)`,
};

async function main() {
  console.log('Inserting Oracle Index Types runbook...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: { ...post },
  });
  console.log('Inserted: "' + post.title + '"');
}

main().catch(console.error);
