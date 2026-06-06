import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Shared Pool Monitoring, Hard Parse Elimination, and ORA-04031 Diagnosis',
  slug: 'oracle-shared-pool-monitoring-hard-parse-runbook',
  excerpt:
    'A production runbook for Oracle shared pool monitoring and diagnosis — covering configuration audit, library cache and dictionary cache health checks, hard parse root-cause analysis via V$SQL and AWR, shared pool sizing with V$SHARED_POOL_ADVICE, PL/SQL pinning with DBMS_SHARED_POOL.KEEP, ORA-04031 emergency resolution, and an automated monitoring shell script with Nagios-compatible exit codes.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-05'),
  youtubeUrl: null,
  content: `## Overview

This runbook covers systematic Oracle shared pool diagnosis, tuning, and monitoring. All steps assume Oracle 12.2 or later, a DBA or SYSDBA-privileged session, and the Oracle Diagnostics Pack licensed for AWR access (\`DBA_HIST_*\` views). Steps that query \`V$\` views require only DBA privilege and do not require the Diagnostics Pack. Steps referencing \`DBA_HIST_*\` views are clearly marked; skip them and use \`V$\` equivalents in environments without the Diagnostics Pack licence. All SQL is tested on Oracle 12.2, 19c, and 21c. Bind variable substitution placeholders use \`&variable_name\` syntax consistent with SQL*Plus and SQLcl.

---

## Phase 0: Shared Pool Configuration Audit

### Step 0.1 — Check Shared Pool Parameters

Establishes the current memory management model, shared pool sizing, cursor sharing policy, and session cursor cache configuration.

\`\`\`sql
SELECT name, value, description
FROM v\$parameter
WHERE name IN (
  'shared_pool_size',
  'shared_pool_reserved_size',
  'sga_target',
  'cursor_sharing',
  'session_cached_cursors',
  'open_cursors',
  'result_cache_mode',
  'result_cache_max_size'
)
ORDER BY name;
\`\`\`

Interpretation: if \`sga_target > 0\`, ASMM is managing the shared pool dynamically; \`shared_pool_size\` is the minimum floor in this mode. If \`sga_target = 0\`, the shared pool is static at \`shared_pool_size\`. \`cursor_sharing = EXACT\` is the default and safest setting; \`FORCE\` is enabled only if literal SQL is causing parse storms. \`session_cached_cursors\` below 50 may cause excessive soft parses for applications that close and reopen cursors frequently.

### Step 0.2 — Current Shared Pool Memory Breakdown

Shows the top-20 sub-components of shared pool memory consumption from \`V$SGASTAT\`.

\`\`\`sql
SELECT name,
       round(bytes / 1048576, 2) as mb
FROM v\$sgastat
WHERE pool = 'shared pool'
ORDER BY bytes DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

Key components to note: \`free memory\` (available for new allocations), \`library cache\` (parsed cursors and PL/SQL), \`row cache\` (data dictionary cache), \`sql area\` (open cursor overhead), \`KGLH0\` and \`KGLHD\` (library cache heap structures). If \`free memory\` is below 10% of total shared pool, the pool is under memory pressure.

### Step 0.3 — Shared Pool Free Memory and Utilisation

Calculates the shared pool utilisation as a single summary row.

\`\`\`sql
SELECT round(sum(CASE WHEN name = 'free memory' THEN bytes END) / 1048576, 2) as free_mb,
       round(sum(bytes) / 1048576, 2) as total_mb,
       round(sum(CASE WHEN name = 'free memory' THEN bytes END) * 100.0 / sum(bytes), 2) as free_pct
FROM v\$sgastat
WHERE pool = 'shared pool';
\`\`\`

Threshold: \`free_pct\` below 10% is a warning; below 5% is critical. Note that adequate \`free_pct\` does not guarantee immunity from ORA-04031 — fragmentation can prevent large allocations even with 20–30% free memory. See Phase 5 for fragmentation-specific diagnosis.

### Step 0.4 — Reserved Pool Status

The reserved pool handles large allocations (> \`_SHARED_POOL_RESERVED_MIN_ALLOC\`, typically 4 KB) and has its own failure counter.

\`\`\`sql
SELECT request_misses,
       request_failures,
       free_memory / 1048576 as free_mb,
       reserved_size / 1048576 as reserved_mb,
       used_memory / 1048576 as used_mb
FROM v\$shared_pool_reserved;
-- request_failures > 0 = reserved pool too small or shared pool too small
\`\`\`

Interpretation: \`REQUEST_FAILURES > 0\` means the reserved pool has been unable to satisfy at least one large allocation request since instance startup — this is a direct precursor to or symptom of ORA-04031. \`REQUEST_MISSES\` counts requests that could not be immediately satisfied (required waiting for free memory) but eventually succeeded. A high \`REQUEST_MISSES\` with zero \`REQUEST_FAILURES\` indicates reserved pool pressure that has not yet resulted in errors.

---

## Phase 1: Library Cache Health

### Step 1.1 — Library Cache Hit Ratios by Namespace

Shows get and pin hit ratios, reload rates, and invalidation counts per library cache namespace.

\`\`\`sql
SELECT namespace,
       gets,
       gethits,
       round(gethitratio * 100, 4) as get_hit_pct,
       pins,
       pinhits,
       round(pinhitratio * 100, 4) as pin_hit_pct,
       reloads,
       invalidations
FROM v\$librarycache
ORDER BY gets DESC;
-- get_hit_pct and pin_hit_pct should both be > 99% for a healthy pool
-- reloads > 0 = objects being evicted and re-loaded (pool pressure)
-- invalidations > 0 = DDL invalidating cached cursors
\`\`\`

Thresholds: \`get_hit_pct\` and \`pin_hit_pct\` should both be above 99% in a well-tuned shared pool. Values below 95% indicate significant cache churn. Non-zero \`reloads\` in the SQL AREA or BODY namespaces means cursors and packages are being evicted and reloaded under memory pressure. \`invalidations\` count DDL operations that have invalidated cached objects; high values indicate either frequent DDL or statistics gathering invalidating dependent cursors.

### Step 1.2 — Data Dictionary Cache Hit Ratio

Calculates the overall row cache (data dictionary cache) hit ratio from \`V$ROWCACHE\`.

\`\`\`sql
SELECT round(
         (sum(gets) - sum(misses)) * 100.0 / nullif(sum(gets), 0),
         4
       ) as dict_cache_hit_pct,
       sum(gets) as total_gets,
       sum(misses) as total_misses,
       sum(modifications) as modifications
FROM v\$rowcache;
-- Target: > 95%; below 90% = dictionary cache being churned, shared pool too small
\`\`\`

Interpretation: the row cache hit ratio below 95% indicates the data dictionary cache cannot retain the dictionary rows needed by the active SQL workload. This causes every hard parse to incur additional latency for dictionary row lookups. In a new or recently restarted instance the ratio may be low while the cache warms up — allow 15–30 minutes of workload before treating a low ratio as a problem.

### Step 1.3 — Library Cache Latch Activity

Reports latch get counts, miss rates, and sleep counts for library cache and shared pool latches.

\`\`\`sql
SELECT l.name,
       l.gets,
       l.misses,
       round(l.misses * 100.0 / nullif(l.gets, 0), 4) as miss_pct,
       l.sleeps,
       l.spin_gets
FROM v\$latch l
WHERE l.name LIKE 'library cache%'
   OR l.name LIKE 'shared pool%'
ORDER BY l.misses DESC;
-- miss_pct > 1% = latch contention, likely caused by hard parse storms
\`\`\`

Threshold: \`miss_pct\` above 1% on any library cache or shared pool latch indicates latch contention that is limiting parse throughput. In modern Oracle (12c+) many library cache operations use mutexes rather than latches, so latch statistics alone may understate contention — also check \`V$MUTEX_SLEEP\` and the \`cursor: mutex S\` / \`cursor: mutex X\` wait events in \`V$SESSION_WAIT\`.

---

## Phase 2: Hard Parse Analysis

### Step 2.1 — System-Wide Parse Statistics

Retrieves the cumulative parse counters from \`V$SYSSTAT\` to establish the overall hard parse rate since instance startup.

\`\`\`sql
SELECT name, value
FROM v\$sysstat
WHERE name IN (
  'parse count (total)',
  'parse count (hard)',
  'parse count (failures)',
  'parse count (describe)',
  'execute count',
  'session cursor cache hits',
  'cursor authentications'
)
ORDER BY name;
-- parse count (hard) / parse count (total) ratio: target < 1%
-- session cursor cache hits / execute count: target > 90%
\`\`\`

Interpretation: \`parse count (hard) / parse count (total)\` above 1% is a warning; above 10% is a critical hard parse problem. \`session cursor cache hits / execute count\` above 90% means most executions are benefiting from the session cursor cache — high values are desirable. \`parse count (failures)\` counts parses that raised errors (ORA-04031 counts here); any non-zero value warrants investigation.

### Step 2.2 — Top SQL by Hard Parse Rate

Identifies SQL statements that are being re-parsed on a high fraction of their executions — the primary symptom of cursors not being reused.

\`\`\`sql
SELECT sql_id,
       parse_calls,
       executions,
       round(parse_calls * 100.0 / nullif(executions, 0), 2) as parse_rate_pct,
       loads,
       invalidations,
       round(elapsed_time / 1e6, 2) as elapsed_sec,
       substr(sql_text, 1, 80) as sql_text
FROM v\$sql
WHERE executions > 10
  AND parse_calls > executions * 0.5   -- parsed more than 50% of executions
ORDER BY parse_calls DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

Interpretation: \`parse_rate_pct = 100\` means every execution involves a parse call — the cursor is closed and reopened between every execution, yielding no cursor reuse benefit. Investigate these statements first. Check the application code for the corresponding SQL — is it using bind variables? Is the application closing the cursor after each use? A high \`loads\` count relative to \`parse_calls\` indicates the cursor is also being evicted from the library cache and reloaded (hard parsed), not just soft parsed.

### Step 2.3 — Identify Literal SQL (No Bind Variables)

Uses \`FORCE_MATCHING_SIGNATURE\` to group logically identical SQL statements that differ only in literal values — the literal SQL flood pattern.

\`\`\`sql
SELECT force_matching_signature,
       count(*) as cursor_variants,
       sum(executions) as total_executions,
       round(sum(elapsed_time) / 1e6, 2) as total_elapsed_sec,
       max(substr(sql_text, 1, 100)) as sample_sql_text
FROM v\$sql
WHERE force_matching_signature != 0
  AND parsing_schema_name NOT IN ('SYS', 'SYSTEM', 'DBSNMP')
GROUP BY force_matching_signature
HAVING count(*) > 10   -- same SQL with > 10 different literal values
ORDER BY count(*) DESC
FETCH FIRST 20 ROWS ONLY;
-- High cursor_variants for same signature = literal SQL candidate for bind variables
\`\`\`

Interpretation: a \`cursor_variants\` count of 1000 for a single \`force_matching_signature\` means 1000 distinct literal values have each produced a separate hard parse and a separate library cache entry. This is the clearest evidence of a literal SQL problem. Report these statements to the application team for bind variable refactoring. As an emergency mitigation, set \`CURSOR_SHARING = FORCE\` at the session or system level.

### Step 2.4 — Hard Parse Rate Trend from AWR

Shows the hard parse rate per AWR snapshot interval for the past 7 days to identify when parse storms occur.

\`\`\`sql
SELECT s.begin_interval_time,
       round(st_hard.value_delta / nullif(st_total.value_delta, 0) * 100, 4) as hard_parse_pct,
       st_hard.value_delta as hard_parses,
       st_total.value_delta as total_parses
FROM dba_hist_sysstat st_hard
JOIN dba_hist_sysstat st_total ON st_total.snap_id = st_hard.snap_id
                               AND st_total.instance_number = st_hard.instance_number
                               AND st_total.stat_name = 'parse count (total)'
JOIN dba_hist_snapshot s ON s.snap_id = st_hard.snap_id
WHERE st_hard.stat_name = 'parse count (hard)'
  AND s.begin_interval_time > sysdate - 7
ORDER BY s.begin_interval_time DESC
FETCH FIRST 48 ROWS ONLY;
\`\`\`

Requires Diagnostics Pack. Interpretation: look for intervals where \`hard_parse_pct\` spikes above 5% — these correspond to parse storms, often correlated with application deployments, batch job starts, or post-restart warmup. Cross-reference with \`DBA_HIST_ACTIVE_SESS_HISTORY\` for those intervals to identify which SQL statements were being hard parsed. Persistent high hard parse rate across all intervals indicates a systemic bind variable problem.

---

## Phase 3: Shared Pool Sizing

### Step 3.1 — V$SHARED_POOL_ADVICE — Size Recommendations

Shows the estimated parse time savings curve at different shared pool sizes. Use this to identify the appropriate sizing target.

\`\`\`sql
SELECT shared_pool_size_for_estimate as pool_mb,
       estd_lc_size as estd_library_cache_mb,
       estd_lc_memory_objects as estd_cached_objects,
       estd_lc_time_saved as estd_parse_time_saved_sec,
       estd_lc_time_saved_factor as time_saved_factor,
       estd_lc_load_time as estd_load_time_sec
FROM v\$shared_pool_advice
ORDER BY shared_pool_size_for_estimate;
-- Look for: where estd_lc_time_saved_factor stops improving sharply
\`\`\`

Interpretation: the \`time_saved_factor\` column shows estimated parse time saved at each size relative to the smallest size shown. Find the "knee" — the point where the factor stops increasing steeply and flattens out. The shared pool size at the knee is the minimum effective size; add 20–25% headroom. If the curve is already flat from the smallest size, the current shared pool is larger than the workload requires.

### Step 3.2 — Largest Objects Currently in Library Cache

Identifies the largest PL/SQL objects and other non-cursor objects consuming library cache memory — candidates for pinning with \`DBMS_SHARED_POOL.KEEP\`.

\`\`\`sql
SELECT owner,
       name,
       type,
       round(sharable_mem / 1048576, 2) as sharable_mb,
       loads,
       executions,
       kept
FROM v\$db_object_cache
WHERE type NOT IN ('CURSOR', 'NOT LOADED')
  AND sharable_mem > 102400   -- > 100KB
ORDER BY sharable_mem DESC
FETCH FIRST 30 ROWS ONLY;
\`\`\`

Focus on objects where \`kept = 'NO'\` and \`loads > 1\` — these are large objects that have been evicted and reloaded at least once. Each reload cycle contributes to fragmentation. Objects with \`sharable_mb > 1\` that are loaded frequently are prime candidates for \`DBMS_SHARED_POOL.KEEP\`.

### Step 3.3 — Large Cursors Consuming Shared Pool Memory

Identifies individual SQL cursors with unusually large memory footprints — complex plans or queries with many filter predicates can generate very large cursor structures.

\`\`\`sql
SELECT sql_id,
       round(sharable_mem / 1048576, 3) as sharable_mb,
       executions,
       loads,
       round(elapsed_time / 1e6, 2) as elapsed_sec,
       substr(sql_text, 1, 80) as sql_text
FROM v\$sql
WHERE sharable_mem > 1048576   -- > 1MB per cursor
ORDER BY sharable_mem DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

Interpretation: SQL cursors above 1 MB are unusual and warrant investigation. They may represent queries with extremely complex predicates, queries that reference a very large number of objects, or adaptive cursor sharing children that have accumulated state. Large cursors increase ORA-04031 risk because they require large contiguous allocations.

### Step 3.4 — Total Shared Pool Used by Single-Use Cursors (Literal SQL Waste)

Quantifies the shared pool memory consumed by cursors that have been executed exactly once — the definitive measure of literal SQL waste.

\`\`\`sql
SELECT round(sum(sharable_mem) / 1048576, 2) as single_use_cursor_mb,
       count(*) as cursor_count
FROM v\$sql
WHERE executions = 1
  AND parsing_schema_name NOT IN ('SYS', 'SYSTEM');
-- High value = literal SQL flooding the shared pool
\`\`\`

Interpretation: \`single_use_cursor_mb\` above 100 MB is a significant waste signal. These cursors consume shared pool memory for each unique literal value query — they will be evicted quickly (since they are never re-executed, they accumulate no heat in the LRU algorithm) but their frequent creation and eviction fragments the free list. If \`cursor_count\` exceeds 50,000, literal SQL is likely causing measurable shared pool fragmentation.

---

## Phase 4: Pinning PL/SQL Objects

### Step 4.1 — List Large PL/SQL Objects That Should Be Pinned

Queries \`V$DB_OBJECT_CACHE\` for large PL/SQL objects above 512 KB that are not yet pinned.

\`\`\`sql
SELECT name,
       type,
       round(sharable_mem / 1048576, 2) as size_mb,
       loads,
       kept
FROM v\$db_object_cache
WHERE type IN ('PACKAGE', 'PACKAGE BODY', 'PROCEDURE', 'FUNCTION', 'TRIGGER')
  AND sharable_mem > 524288   -- > 512KB
ORDER BY sharable_mem DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

Any object above 1 MB with \`kept = 'NO'\` and \`loads > 0\` is a candidate for pinning. Prioritise objects where \`loads\` is high (indicating frequent eviction/reload cycles) and where the object is called by frequently executed SQL or is on the critical transaction path.

### Step 4.2 — Pin a Package into the Shared Pool

Permanently pins a PL/SQL package or other object into the shared pool. Should be executed in a post-startup script before application connections arrive.

\`\`\`sql
-- Pin at instance startup (add to post-startup script):
EXEC sys.dbms_shared_pool.keep('&schema_name..&package_name', 'P');
-- 'P' = package/package body; 'R' = trigger; 'Q' = sequence; 'T' = type body
\`\`\`

Best practice: create a SQL script \`pin_objects.sql\` containing all \`DBMS_SHARED_POOL.KEEP\` calls for the instance, and execute it from a post-startup trigger or a startup script called by the Oracle Scheduler job \`AFTER STARTUP ON DATABASE\`. Pinning must be done after every instance restart — the pin state is not persisted across shutdowns.

### Step 4.3 — List Currently Pinned Objects

Verifies which objects are currently pinned (kept) in the shared pool.

\`\`\`sql
SELECT owner,
       name,
       type,
       round(sharable_mem / 1048576, 2) as size_mb,
       kept
FROM v\$db_object_cache
WHERE kept = 'YES'
ORDER BY sharable_mem DESC;
\`\`\`

This query is useful for auditing whether the post-startup pinning script ran correctly after an instance restart. If expected objects show \`kept = 'NO'\`, the script may have failed or run before the objects were compiled.

### Step 4.4 — Unpin an Object (If Needed to Free Memory)

Releases a pinned object back to the normal LRU-managed pool. Used when a pinned object is no longer needed or when shared pool memory pressure requires freeing the pinned space.

\`\`\`sql
EXEC sys.dbms_shared_pool.unkeep('&schema_name..&package_name', 'P');
\`\`\`

Note: unpinning does not immediately free the memory — it only makes the object eligible for LRU eviction. The memory is reclaimed when Oracle needs to evict objects to satisfy a new allocation request.

### Step 4.5 — List Objects Above a Size Threshold Using DBMS_SHARED_POOL.SIZES

Uses the \`SIZES\` procedure to list all shared pool objects above a specified size threshold — a quick survey without writing a custom query.

\`\`\`sql
-- Shows objects > 100KB in the shared pool:
SET SERVEROUTPUT ON SIZE 1000000
EXEC sys.dbms_shared_pool.sizes(100);
\`\`\`

The threshold argument is in kilobytes. Output is written via \`DBMS_OUTPUT\` and requires \`SET SERVEROUTPUT ON\` before the call. Use larger threshold values (500, 1000) to focus on the largest objects; use smaller values to get a comprehensive list.

---

## Phase 5: ORA-04031 Diagnosis and Resolution

### Step 5.1 — Check for ORA-04031 in Alert Log

Searches the Oracle alert log for ORA-04031 errors to establish when the errors occurred and how frequently.

\`\`\`bash
grep -i "ORA-04031" \${ORACLE_BASE}/diag/rdbms/\${ORACLE_SID}/\${ORACLE_SID}/trace/alert_\${ORACLE_SID}.log | tail -20
\`\`\`

Note the timestamps of ORA-04031 occurrences and cross-reference with system activity at those times — batch job starts, application deployments, post-restart warm-up, or unusual workload spikes. The alert log entry includes the allocation size that failed and the pool name, which helps distinguish pool-size-based failures from fragmentation-based failures.

### Step 5.2 — Check Shared Pool Pressure Indicators

Consolidates the most important pressure indicators into a single diagnostic query.

\`\`\`sql
SELECT 'Free memory (MB)' as metric,
       round(sum(CASE WHEN name = 'free memory' THEN bytes END) / 1048576, 2) as value
FROM v\$sgastat WHERE pool = 'shared pool'
UNION ALL
SELECT 'Reload rate (reloads/gets %)', round(sum(reloads) * 100.0 / nullif(sum(gets), 0), 4)
FROM v\$librarycache
UNION ALL
SELECT 'Dict cache miss pct', round((sum(misses) * 100.0) / nullif(sum(gets), 0), 4)
FROM v\$rowcache
UNION ALL
SELECT 'Reserved pool failures', to_number(request_failures)
FROM v\$shared_pool_reserved;
\`\`\`

Interpret as a triage checklist: free memory below 50 MB (absolute) warrants investigation regardless of percentage. Reload rate above 0.1% indicates pool pressure. Dict cache miss above 5% indicates dictionary cache being churned. Reserved pool failures above 0 requires immediate action.

### Step 5.3 — Flush Shared Pool (Emergency — Causes Hard Parse Storm, Use With Caution)

Evicts all cached cursors and PL/SQL objects from the shared pool. This is a last-resort intervention for production ORA-04031 situations where fragmentation is preventing any new allocation.

\`\`\`sql
-- Only as last resort when ORA-04031 is causing production failure:
ALTER SYSTEM FLUSH SHARED_POOL;
-- This evicts ALL cached cursors — expect a spike in hard parses immediately after
\`\`\`

Warning: flushing the shared pool causes every SQL statement to be hard parsed on its next execution. On a high-throughput OLTP system, this can cause a severe parse storm immediately after the flush — CPU spikes to 100%, library cache latch waits explode, and response times can temporarily worsen before recovering. Only use when the alternative is continued ORA-04031 failures blocking production operations. After flushing, immediately execute the post-startup pinning script to pin large packages before fragmentation begins again.

### Step 5.4 — Increase Shared Pool Size (Dynamic)

Increases the shared pool allocation, either via ASMM (\`SGA_TARGET\`) or directly (\`SHARED_POOL_SIZE\`).

\`\`\`sql
-- If SGA_TARGET is set (ASMM), increase SGA_TARGET:
ALTER SYSTEM SET sga_target = 20G SCOPE = BOTH;

-- If manually sizing (no ASMM):
ALTER SYSTEM SET shared_pool_size = 4G SCOPE = BOTH;

-- Increase reserved pool (if request_failures > 0):
ALTER SYSTEM SET shared_pool_reserved_size = 200M SCOPE = SPFILE;
-- shared_pool_reserved_size is NOT dynamic — requires restart
\`\`\`

Note: \`SHARED_POOL_RESERVED_SIZE\` cannot exceed 50% of \`SHARED_POOL_SIZE\`. It is not dynamically adjustable — changes take effect only after the next instance restart. Plan this change during a maintenance window.

### Step 5.5 — Enable CURSOR_SHARING as Emergency Mitigation for Literal SQL

Enables server-side literal substitution to reduce hard parses from literal SQL. Test at session level first before applying system-wide.

\`\`\`sql
-- Session-level test first:
ALTER SESSION SET cursor_sharing = FORCE;
-- Run the problem workload, measure hard parse rate

-- System-level (use with caution — may change execution plans):
ALTER SYSTEM SET cursor_sharing = FORCE SCOPE = BOTH;
\`\`\`

Warning: \`CURSOR_SHARING = FORCE\` can cause execution plan changes for SQL where different literal values warrant different plans. Monitor \`V$SQL\` for plan regressions after enabling. This is a mitigation, not a permanent fix — schedule application refactoring to use bind variables and revert \`CURSOR_SHARING\` to \`EXACT\` after refactoring is complete.

---

## Phase 6: Shared Pool Monitoring Shell Script (With Crontab)

Save as \`/u01/app/oracle/scripts/shared_pool_monitor/shared_pool_monitor.sh\`. Make executable with \`chmod 750\`.

\`\`\`bash
#!/bin/bash
# ============================================================
# shared_pool_monitor.sh
# Oracle Shared Pool Monitor — Library Cache, Dictionary Cache,
# Reserved Pool, and Hard Parse Rate
#
# Usage: shared_pool_monitor.sh <ORACLE_SID>
# Exit code = number of issues found (Nagios-compatible)
# ============================================================

ORACLE_SID=\${1:-""}

if [[ -z "\${ORACLE_SID}" ]]; then
  echo "Usage: \$0 <ORACLE_SID>"
  exit 1
fi

export ORACLE_SID
ORACLE_HOME=\${ORACLE_HOME:-/u01/app/oracle/product/19.0.0/dbhome_1}
export ORACLE_HOME
PATH=\${ORACLE_HOME}/bin:\${PATH}
export PATH

TIMESTAMP=\$(date +%Y%m%d_%H%M%S)
LOG_BASE="/u01/app/oracle/scripts/shared_pool_monitor/logs"
mkdir -p "\${LOG_BASE}"
LOGFILE="\${LOG_BASE}/sp_\${ORACLE_SID}_\${TIMESTAMP}.log"
ALERT_EMAIL=\${ALERT_EMAIL:-"dba@example.com"}

ISSUES=0

# ============================================================
# Logging helpers
# ============================================================
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] \$*" | tee -a "\${LOGFILE}"
}

issue() {
  log "[WARNING] \$*"
  ISSUES=\$((ISSUES + 1))
}

ok() {
  log "[OK     ] \$*"
}

SQLPLUS="\${ORACLE_HOME}/bin/sqlplus"

# ============================================================
# Verify connectivity
# ============================================================
log "=== Shared Pool Monitor: \${ORACLE_SID} ==="
log "Timestamp : \${TIMESTAMP}"
log "Log file  : \${LOGFILE}"

PING_RESULT=\$("\${SQLPLUS}" -s / as sysdba <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF VERIFY OFF HEADING OFF TRIMSPOOL ON
SELECT 'CONNECTED' FROM dual;
EXIT;
SQLEOF
)

if [[ "\${PING_RESULT}" != *"CONNECTED"* ]]; then
  log "[CRITICAL] Cannot connect to \${ORACLE_SID} as sysdba"
  exit 1
fi

log "Connected to \${ORACLE_SID} successfully"

# ============================================================
# Check 1: Shared Pool Free Memory Percentage
# ============================================================
log "--- Check 1: Shared Pool Free Memory ---"

FREE_PCT=\$("\${SQLPLUS}" -s / as sysdba <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF VERIFY OFF HEADING OFF TRIMSPOOL ON NUMFORMAT 999990.00
SELECT round(
         sum(CASE WHEN name = 'free memory' THEN bytes END) * 100.0 / sum(bytes),
         2
       )
FROM v$sgastat
WHERE pool = 'shared pool';
EXIT;
SQLEOF
)

FREE_PCT=\$(echo "\${FREE_PCT}" | tr -d ' \n')

if [[ -z "\${FREE_PCT}" || "\${FREE_PCT}" == "no rows selected" ]]; then
  log "[INFO  ] Could not retrieve shared pool free memory percentage"
else
  log "[INFO  ] Shared pool free memory: \${FREE_PCT}%"
  if awk "BEGIN {exit !(\${FREE_PCT} < 5)}"; then
    issue "Shared pool free memory \${FREE_PCT}% is critically low (< 5%)"
  elif awk "BEGIN {exit !(\${FREE_PCT} < 10)}"; then
    issue "Shared pool free memory \${FREE_PCT}% is below 10% threshold"
  else
    ok "Shared pool free memory \${FREE_PCT}% is within threshold"
  fi
fi

# ============================================================
# Check 2: Reserved Pool Request Failures
# ============================================================
log "--- Check 2: Reserved Pool Request Failures ---"

RESERVED_FAILURES=\$("\${SQLPLUS}" -s / as sysdba <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF VERIFY OFF HEADING OFF TRIMSPOOL ON
SELECT request_failures FROM v$shared_pool_reserved;
EXIT;
SQLEOF
)

RESERVED_FAILURES=\$(echo "\${RESERVED_FAILURES}" | tr -d ' \n')

if [[ -z "\${RESERVED_FAILURES}" || "\${RESERVED_FAILURES}" == "no rows selected" ]]; then
  log "[INFO  ] Could not retrieve reserved pool failure count"
else
  log "[INFO  ] Reserved pool request failures: \${RESERVED_FAILURES}"
  if awk "BEGIN {exit !(\${RESERVED_FAILURES} > 0)}"; then
    issue "Reserved pool has \${RESERVED_FAILURES} request failure(s) — shared pool may be too small or too fragmented"
  else
    ok "Reserved pool request failures: 0 — no allocation failures"
  fi
fi

# ============================================================
# Check 3: Library Cache Reload Rate
# ============================================================
log "--- Check 3: Library Cache Reload Rate ---"

RELOAD_RATE=\$("\${SQLPLUS}" -s / as sysdba <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF VERIFY OFF HEADING OFF TRIMSPOOL ON NUMFORMAT 999990.0000
SELECT round(sum(reloads) * 100.0 / nullif(sum(gets), 0), 4)
FROM v$librarycache;
EXIT;
SQLEOF
)

RELOAD_RATE=\$(echo "\${RELOAD_RATE}" | tr -d ' \n')

if [[ -z "\${RELOAD_RATE}" || "\${RELOAD_RATE}" == "no rows selected" ]]; then
  log "[INFO  ] Could not retrieve library cache reload rate"
else
  log "[INFO  ] Library cache reload rate: \${RELOAD_RATE}%"
  if awk "BEGIN {exit !(\${RELOAD_RATE} > 1)}"; then
    issue "Library cache reload rate \${RELOAD_RATE}% exceeds 1% threshold — objects being evicted and reloaded"
  elif awk "BEGIN {exit !(\${RELOAD_RATE} > 0.1)}"; then
    issue "Library cache reload rate \${RELOAD_RATE}% is elevated (> 0.1%)"
  else
    ok "Library cache reload rate \${RELOAD_RATE}% is within threshold"
  fi
fi

# ============================================================
# Check 4: Hard Parse Rate (Current Sample)
# ============================================================
log "--- Check 4: Hard Parse Rate ---"

HARD_PARSE_RESULT=\$("\${SQLPLUS}" -s / as sysdba <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF VERIFY OFF HEADING OFF TRIMSPOOL ON NUMFORMAT 999990.0000
SELECT round(
         max(CASE WHEN name = 'parse count (hard)' THEN value END) * 100.0
         / nullif(max(CASE WHEN name = 'parse count (total)' THEN value END), 0),
         4
       )
FROM v$sysstat
WHERE name IN ('parse count (hard)', 'parse count (total)');
EXIT;
SQLEOF
)

HARD_PARSE_RESULT=\$(echo "\${HARD_PARSE_RESULT}" | tr -d ' \n')

if [[ -z "\${HARD_PARSE_RESULT}" || "\${HARD_PARSE_RESULT}" == "no rows selected" ]]; then
  log "[INFO  ] Could not retrieve hard parse rate"
else
  log "[INFO  ] Cumulative hard parse rate: \${HARD_PARSE_RESULT}%"
  if awk "BEGIN {exit !(\${HARD_PARSE_RESULT} > 10)}"; then
    issue "Hard parse rate \${HARD_PARSE_RESULT}% exceeds 10% — severe literal SQL or cursor reuse problem"
  elif awk "BEGIN {exit !(\${HARD_PARSE_RESULT} > 5)}"; then
    issue "Hard parse rate \${HARD_PARSE_RESULT}% exceeds 5% threshold"
  else
    ok "Hard parse rate \${HARD_PARSE_RESULT}% is within threshold"
  fi
fi

# ============================================================
# Check 5: Dictionary Cache Hit Ratio
# ============================================================
log "--- Check 5: Dictionary Cache Hit Ratio ---"

DICT_HIT=\$("\${SQLPLUS}" -s / as sysdba <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF VERIFY OFF HEADING OFF TRIMSPOOL ON NUMFORMAT 999990.00
SELECT round(
         (sum(gets) - sum(misses)) * 100.0 / nullif(sum(gets), 0),
         2
       )
FROM v$rowcache;
EXIT;
SQLEOF
)

DICT_HIT=\$(echo "\${DICT_HIT}" | tr -d ' \n')

if [[ -z "\${DICT_HIT}" || "\${DICT_HIT}" == "no rows selected" ]]; then
  log "[INFO  ] Could not retrieve dictionary cache hit ratio"
else
  log "[INFO  ] Dictionary cache hit ratio: \${DICT_HIT}%"
  if awk "BEGIN {exit !(\${DICT_HIT} < 90)}"; then
    issue "Dictionary cache hit ratio \${DICT_HIT}% is below 90% — shared pool may be undersized"
  elif awk "BEGIN {exit !(\${DICT_HIT} < 95)}"; then
    issue "Dictionary cache hit ratio \${DICT_HIT}% is below 95% threshold"
  else
    ok "Dictionary cache hit ratio \${DICT_HIT}% is within threshold"
  fi
fi

# ============================================================
# Summary and notification
# ============================================================
log "=== Summary: \${ISSUES} issue(s) found for \${ORACLE_SID} ==="

if [[ \${ISSUES} -gt 0 ]]; then
  SUBJECT="[WARNING] Oracle Shared Pool Alert: \${ISSUES} issue(s) on \${ORACLE_SID}"
  BODY=\$(cat "\${LOGFILE}")
  echo "\${BODY}" | mailx -s "\${SUBJECT}" "\${ALERT_EMAIL}" 2>/dev/null \
    || echo "\${BODY}" | sendmail "\${ALERT_EMAIL}" 2>/dev/null \
    || log "[INFO  ] Email notification could not be sent (mailx/sendmail not available)"
fi

log "Log written to: \${LOGFILE}"
exit \${ISSUES}
\`\`\`

Crontab entry — runs every 15 minutes:

\`\`\`
*/15  *  *  *  *  /u01/app/oracle/scripts/shared_pool_monitor/shared_pool_monitor.sh PRODDB >> /u01/app/oracle/scripts/shared_pool_monitor/logs/cron_sp.log 2>&1
\`\`\`

---

## Quick Reference

**Key views:**
- \`V$SGASTAT\` — memory breakdown by pool and component
- \`V$LIBRARYCACHE\` — hit ratios and reload rates per namespace
- \`V$ROWCACHE\` — data dictionary cache hit ratio
- \`V$SHARED_POOL_RESERVED\` — reserved pool status and failures
- \`V$SHARED_POOL_ADVICE\` — size vs. parse time savings curve
- \`V$SQL\` — cursor-level parse/execute stats, sharable_mem, force_matching_signature
- \`V$DB_OBJECT_CACHE\` — all cached objects with size and kept flag
- \`DBA_HIST_SYSSTAT\` — AWR parse count history (requires Diagnostics Pack)

**Key parameters:**
- \`SHARED_POOL_SIZE\` — minimum floor (ASMM respects this as a lower bound)
- \`SHARED_POOL_RESERVED_SIZE\` — reserved sub-pool for large allocations (not dynamic — requires restart to change)
- \`CURSOR_SHARING\` — EXACT (default) / FORCE (server-side bind variable substitution)
- \`SESSION_CACHED_CURSORS\` — per-session cursor cache depth (default 50)
- \`OPEN_CURSORS\` — max open cursors per session (default 300; raise if ORA-01000 occurs)

**Key package procedures:**
- \`DBMS_SHARED_POOL.KEEP(name, type)\` — pin object permanently into shared pool
- \`DBMS_SHARED_POOL.UNKEEP(name, type)\` — remove pin (object becomes LRU-eligible)
- \`DBMS_SHARED_POOL.SIZES(minsize_kb)\` — list all objects above size threshold via DBMS_OUTPUT

**Hard parse elimination priority order:**
1. Use bind variables in application SQL — this is the only complete and permanent fix
2. Increase \`SESSION_CACHED_CURSORS\` to reduce re-parses within sessions (try 100–200)
3. Set \`CURSOR_SHARING = FORCE\` as temporary mitigation for legacy literal SQL
4. Pin large PL/SQL packages with \`DBMS_SHARED_POOL.KEEP\` in post-startup script
5. Increase \`SHARED_POOL_SIZE\` / \`SGA_TARGET\` if \`V$SHARED_POOL_ADVICE\` indicates genuine undersizing
6. Increase \`SHARED_POOL_RESERVED_SIZE\` (SPFILE, restart required) if \`V$SHARED_POOL_RESERVED.REQUEST_FAILURES > 0\``,
};

async function main() {
  console.log('Inserting shared pool runbook post...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: { ...post },
  });
  console.log('Inserted: "' + post.title + '"');
}

main().catch(console.error);
