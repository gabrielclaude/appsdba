import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: ORA-00600 [kglLockOwnersListDelete] — Instance Recovery, Root Cause Isolation, and Library Cache Hardening',
  slug: 'oracle-ora-00600-kgllockownerslistdelete-runbook',
  excerpt:
    'Step-by-step runbook for an Oracle 11gR2 ORA-00600 [kglLockOwnersListDelete] crash: ADRCI incident packaging, shared pool and library cache health verification, alert log triage SQL, patch identification for 11.2.0.4 on AIX, hard-parse rate reduction, and a monitoring script that watches for kgl assertion errors, library cache reload spikes, and shared pool free memory degradation before they produce another instance crash.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `## Scope

This runbook covers an Oracle 11gR2 (11.2.0.4) instance crash caused by \`ORA-00600 [kglLockOwnersListDelete]\` — a library cache memory management assertion failure. It applies to instances on any platform (AIX, Linux, Solaris) running the same PSU level.

**Phases 1–3 are [ACTIVE OUTAGE] procedures. Phases 4–7 are post-recovery hardening.**

---

## Phase 1: Immediate Recovery [ACTIVE OUTAGE]

### 1.1 Confirm SMON terminated the instance

\`\`\`bash
# Verify no Oracle processes remain (stale processes can block a clean restart)
ps -ef | grep pmon | grep -v grep
ps -ef | grep smon | grep -v grep

# On AIX: check for defunct processes
ps -ef | grep <ORACLE_SID> | grep -v grep
\`\`\`

If any Oracle background processes (PMON, SMON, LGWR, DBWn) are still running after the crash, they must be cleaned up before restart. Force-kill only if they do not self-terminate within 2 minutes:

\`\`\`bash
# Kill surviving Oracle processes for this instance only
# Replace EBSPRD with your actual ORACLE_SID
for pid in $(ps -ef | grep ora_[sp]mon_EBSPRD | grep -v grep | awk '{print $2}'); do
  echo "Killing PID $pid"
  kill -9 $pid
done
\`\`\`

### 1.2 Clean the IPC resources

On AIX (and Linux), a crashed Oracle instance may leave shared memory segments and semaphores that block a clean restart:

\`\`\`bash
# As oracle user — check for orphaned IPC resources
ipcs -ma | grep oracle

# Remove orphaned shared memory segments
# ipcrm -m <shmid>   (for each orphaned segment belonging to oracle)

# Oracle provides a cleanup script for this:
$ORACLE_HOME/bin/localconfig reset   # Resets local configuration (use with care)

# Or simply use sysresv to list and clean:
$ORACLE_HOME/bin/sysresv
\`\`\`

### 1.3 Start the instance

\`\`\`bash
export ORACLE_SID=EBSPRD
sqlplus / as sysdba
\`\`\`

\`\`\`sql
STARTUP;
\`\`\`

Oracle will run instance recovery (rolling back uncommitted transactions from before the crash) automatically. This typically completes in under 2 minutes for an OLTP instance.

\`\`\`sql
-- Confirm clean startup — no errors during recovery
SELECT status FROM v\$instance;
-- Expected: OPEN

-- Verify no alert log errors since startup
SELECT originating_timestamp, message_text
FROM   v\$diag_alert_ext
WHERE  originating_timestamp >= SYSTIMESTAMP - INTERVAL '10' MINUTE
  AND  message_text LIKE 'ORA-%'
ORDER BY originating_timestamp;
-- Expected: 0 rows (or only informational startup messages)
\`\`\`

---

## Phase 2: Preserve Diagnostics Before Any Purge [ACTIVE OUTAGE]

Do not flush the shared pool, run any purge scripts, or restart the listener before completing this phase. The diagnostic data is in the ADR and must be packaged first.

### 2.1 Locate the incident in ADR

\`\`\`bash
adrci

-- Inside adrci:
SHOW HOMES
-- Note your ADR home path, e.g.: diag/rdbms/ebsprd/EBSPRD

-- List incidents near the crash time
SHOW INCIDENT -MODE DETAIL -P "incident_time > '2026-06-12 12:00:00' AND incident_time < '2026-06-12 13:00:00'"
\`\`\`

\`\`\`sql
-- Confirm incident ID from the database side
SELECT incident_id, create_time, error_code, error_argument1
FROM   v\$diag_incident
WHERE  create_time >= SYSTIMESTAMP - INTERVAL '2' HOUR
  AND  error_code = 600
ORDER BY create_time;
\`\`\`

### 2.2 Package the incident

\`\`\`bash
adrci

-- Package all incidents from the crash window into a single zip
IPS CREATE PACKAGE INCIDENT <incident_id> CORRELATE ALL
IPS GENERATE PACKAGE <package_id> IN /tmp

-- Or use the simpler one-liner if you know the incident ID:
IPS PACK INCIDENT <incident_id> IN /tmp
\`\`\`

The resulting zip file contains:
- Full alert log extract around the incident
- Foreground process trace file (the ORA-00600 originator)
- SMON trace file (ORA-00039 initiator)
- LibraryHandle dump
- Any core dumps produced

### 2.3 Extract the critical trace files manually

If ADRCI is unavailable or the ADR is damaged:

\`\`\`bash
# Find the alert log
find $ORACLE_BASE/diag -name "alert_\${ORACLE_SID}.log" 2>/dev/null | head -3

# Find trace files from the crash window (last 2 hours)
find $ORACLE_BASE/diag/rdbms -name "*.trc" -newer /tmp/crash_marker -type f 2>/dev/null | \
  xargs ls -lt 2>/dev/null | head -20

# Filter for ORA-600 or kgl content
grep -l "kglLockOwnersListDelete\|ORA-00600" \
  $(find $ORACLE_BASE/diag/rdbms -name "*.trc" -type f 2>/dev/null) 2>/dev/null | head -5
\`\`\`

---

## Phase 3: Alert Log Triage

### 3.1 Extract the crash sequence from the alert log

\`\`\`sql
-- Query the alert log for the 10 minutes surrounding the crash
-- (replace timestamps with your actual crash time)
SELECT originating_timestamp,
       message_text
FROM   v\$diag_alert_ext
WHERE  originating_timestamp BETWEEN
         TIMESTAMP '2026-06-12 12:05:00 +00:00' AND
         TIMESTAMP '2026-06-12 12:15:00 +00:00'
ORDER BY originating_timestamp;
\`\`\`

Look for this sequence in the output:
1. \`ORA-00600: internal error code, arguments: [kglLockOwnersListDelete]\` — from the foreground process
2. \`ORA-00039: error during periodic action\` — from SMON
3. \`Instance termination due to error 39\` — SMON issuing the shutdown
4. \`Instance terminated by SMON\` — confirmation

If you see other \`ORA-600\` arguments in the same window, note them — they indicate whether this was an isolated incident or part of a cascade.

### 3.2 Check for preceding stress signals

\`\`\`sql
-- Were there ORA-04031 (out of shared memory) errors before the crash?
SELECT originating_timestamp, message_text
FROM   v\$diag_alert_ext
WHERE  originating_timestamp >= SYSTIMESTAMP - INTERVAL '24' HOUR
  AND  (message_text LIKE 'ORA-04031%' OR message_text LIKE '%library cache%')
ORDER BY originating_timestamp;

-- Any prior ORA-600 kgl arguments in the past 7 days?
SELECT originating_timestamp, message_text
FROM   v\$diag_alert_ext
WHERE  originating_timestamp >= SYSTIMESTAMP - INTERVAL '7' DAY
  AND  message_text LIKE '%kgl%'
ORDER BY originating_timestamp;
\`\`\`

### 3.3 Verify database uptime before the crash

\`\`\`sql
-- Current uptime
SELECT SYSDATE - startup_time AS days_up,
       startup_time
FROM   v\$instance;

-- AWR uptime history to see prior restarts
SELECT begin_interval_time,
       end_interval_time,
       snap_id
FROM   dba_hist_snapshot
WHERE  begin_interval_time >= SYSDATE - 30
ORDER BY snap_id DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

Instances running for more than 200 days without a restart on Oracle 11gR2 are more susceptible to gradual shared pool fragmentation. This does not cause the kgl bug directly, but it increases the probability of a timing-window defect surfacing.

---

## Phase 4: Library Cache Health Assessment

### 4.1 Current library cache hit and reload rates

\`\`\`sql
-- Library cache statistics (post-restart baseline)
SELECT namespace,
       gets,
       hits,
       ROUND(hits / NULLIF(gets, 0) * 100, 2)   AS get_hit_pct,
       pins,
       pinhits,
       ROUND(pinhits / NULLIF(pins, 0) * 100, 2) AS pin_hit_pct,
       reloads,
       invalidations
FROM   v\$librarycache
ORDER BY gets DESC;
\`\`\`

**Healthy thresholds:**
- Pin hit ratio > 99%
- Reload-to-pin ratio < 1% (reloads / pins * 100)
- Invalidations should be near zero for SQL AREA

### 4.2 Hard parse rate and cursor sharing

\`\`\`sql
-- Hard parse rate — high values indicate bind variable issues
SELECT name, value
FROM   v\$sysstat
WHERE  name IN ('parse count (total)',
                'parse count (hard)',
                'parse count (failures)',
                'execute count',
                'sorts (memory)',
                'sorts (disk)')
ORDER BY name;

-- Ratio: hard parses should be < 1% of total parses in a healthy system
SELECT ROUND(
         (SELECT value FROM v\$sysstat WHERE name = 'parse count (hard)') /
         NULLIF((SELECT value FROM v\$sysstat WHERE name = 'parse count (total)'), 0) * 100,
         2
       ) AS hard_parse_pct
FROM   dual;
\`\`\`

### 4.3 Shared pool free memory

\`\`\`sql
-- Shared pool allocation breakdown
SELECT pool,
       name,
       ROUND(bytes / 1048576, 1) AS mb
FROM   v\$sgastat
WHERE  pool = 'shared pool'
  AND  name IN ('free memory',
                'library cache',
                'sql area',
                'dictionary cache',
                'miscellaneous')
ORDER BY bytes DESC;

-- Check for shared pool advisor recommendation
SELECT shared_pool_size_for_estimate AS estimate_mb,
       estd_lc_time_saved_factor,
       estd_lc_memory_object_hits
FROM   v\$shared_pool_advice
ORDER BY shared_pool_size_for_estimate;
\`\`\`

### 4.4 Identify top hard-parsing SQL (high-literal-cardinality)

\`\`\`sql
-- SQL with version_count > 20 indicates excessive hard parsing with different literals
SELECT sql_id,
       version_count,
       executions,
       parse_calls,
       ROUND(elapsed_time / 1e6, 1) AS elapsed_sec,
       SUBSTR(sql_text, 1, 120) AS sql_text
FROM   v\$sqlarea
WHERE  version_count > 20
ORDER BY version_count DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

Child cursor proliferation (high \`version_count\`) is a primary driver of library cache pressure. Each version creates and manages its own set of library cache handles.

---

## Phase 5: Patch Identification and Application

### 5.1 Confirm your exact Oracle version and PSU level

\`\`\`sql
SELECT banner FROM v\$version;
-- Example: Oracle Database 11g Enterprise Edition Release 11.2.0.4.0

-- Current PSU/patch history
SELECT patch_id,
       patch_uid,
       version,
       action,
       status,
       description,
       action_time
FROM   dba_registry_history
ORDER BY action_time DESC;
\`\`\`

\`\`\`bash
# From the OS as oracle user
$ORACLE_HOME/OPatch/opatch lsinventory | grep -A2 "Patch description"
$ORACLE_HOME/OPatch/opatch lspatches
\`\`\`

### 5.2 Search My Oracle Support for kglLockOwnersListDelete

Use the packaged diagnostic zip from Phase 2 when opening a Service Request. Key search terms on MOS:
- \`kglLockOwnersListDelete\`
- Bug 11.2.0.4 library cache lock owners
- ORA-600 kgl assertion

Oracle has published specific one-off patches for this argument on 11.2.0.4. The SR process will identify the exact patch number for your platform (AIX POWER vs. Linux x86-64 have different binaries).

### 5.3 Apply the patch during the next maintenance window

\`\`\`bash
# Test the patch against your ORACLE_HOME before production
$ORACLE_HOME/OPatch/opatch prereq CheckConflictAgainstOHWithDetail -phBaseDir /tmp/<patch_dir>

# Apply
$ORACLE_HOME/OPatch/opatch apply /tmp/<patch_dir>

# Confirm
$ORACLE_HOME/OPatch/opatch lspatches | grep <patch_number>

# Post-patch: run utlrp to recompile any invalidated objects
sqlplus / as sysdba
@?/rdbms/admin/utlrp.sql
\`\`\`

---

## Phase 6: Application-Level Hardening

### 6.1 Audit CURSOR_SHARING and OPEN_CURSORS

\`\`\`sql
-- Current parameter values
SELECT name, value, description
FROM   v\$parameter
WHERE  name IN ('cursor_sharing',
                'open_cursors',
                'session_cached_cursors',
                'shared_pool_size',
                'sga_target',
                'memory_target')
ORDER BY name;
\`\`\`

For applications with uncontrolled literal SQL, consider setting \`CURSOR_SHARING = FORCE\` as a temporary measure. This forces Oracle to replace literal values with system-generated bind variables, dramatically reducing hard parse rate and child cursor proliferation.

**Important:** \`CURSOR_SHARING = FORCE\` can mask application defects. It is a mitigation, not a fix. The correct long-term solution is bind variables in the application code.

\`\`\`sql
-- Enable at session level for testing before system-wide change
ALTER SESSION SET CURSOR_SHARING = FORCE;

-- After validating no plan regressions:
ALTER SYSTEM SET CURSOR_SHARING = FORCE SCOPE = BOTH;
\`\`\`

### 6.2 Increase OPEN_CURSORS if sessions are close to the limit

\`\`\`sql
-- Check how close active sessions are to the OPEN_CURSORS limit
SELECT s.sid,
       s.serial#,
       s.username,
       s.status,
       COUNT(*) AS open_cursors
FROM   v\$open_cursor oc
JOIN   v\$session s ON s.sid = oc.sid
WHERE  s.username IS NOT NULL
GROUP BY s.sid, s.serial#, s.username, s.status
ORDER BY open_cursors DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

### 6.3 Flush the shared pool (only if library cache health is poor post-restart)

Do not flush the shared pool routinely — it causes a parse storm. Only flush if the post-restart library cache shows abnormal state that did not self-correct within 30 minutes:

\`\`\`sql
-- Check before deciding to flush
SELECT COUNT(*) AS invalid_objects
FROM   v\$db_object_cache
WHERE  sharable_mem > 0
  AND  kept = 'NO'
  AND  type = 'CURSOR'
  AND  executions = 0;

-- Flush only if directed by Oracle Support or if invalid cursor count is very high
ALTER SYSTEM FLUSH SHARED_POOL;
\`\`\`

---

## Phase 7: Uptime and Restart Cadence

For Oracle 11gR2 instances with a history of gradual shared pool fragmentation, establish a planned rolling restart schedule:

\`\`\`sql
-- Check instance uptime monthly and flag instances > 180 days
SELECT host_name,
       instance_name,
       startup_time,
       ROUND(SYSDATE - startup_time, 0) AS days_up
FROM   v\$instance;
\`\`\`

A planned monthly or quarterly restart during a low-traffic window resets the shared pool allocator state and eliminates residual fragmentation before it accumulates to the point of triggering edge-case defects.

---

## Monitoring Script: ora600_kgl_monitor.sh

This script monitors the five leading indicators for library cache instability. Run it every 5 minutes during the post-crash stabilization period and every 15 minutes as steady-state monitoring.

\`\`\`bash
#!/bin/bash
# ora600_kgl_monitor.sh
# Monitors Oracle library cache health and ORA-600 kgl error recurrence
# Cron (5 min during incident, 15 min steady state):
# */5 * * * * /home/oracle/scripts/ora600_kgl_monitor.sh >> /home/oracle/logs/ora600_kgl_monitor.log 2>&1

set -euo pipefail

SCRIPT_NAME="ora600_kgl_monitor"
LOG_DATE=$(date '+%Y-%m-%d %H:%M:%S')
ALERT=0

# --- Configuration ---
ORACLE_USER=\${ORACLE_USER:-/}          # Use OS auth by default
ORACLE_SID=\${ORACLE_SID:-EBSPRD}
ORACLE_HOME=\${ORACLE_HOME:-/u01/app/oracle/product/11.2.0/dbhome_1}
ALERT_EMAIL=\${ALERT_EMAIL:-dba-alerts@example.com}

PIN_HIT_THRESHOLD=95          # Alert if library cache pin hit ratio drops below this %
HARD_PARSE_THRESHOLD=5        # Alert if hard parse % exceeds this
RELOAD_THRESHOLD=1000         # Alert if reload count increases by this much in one interval
FREE_POOL_MB_THRESHOLD=200    # Alert if shared pool free memory drops below this MB
KGL_ERROR_CHECK_HOURS=1       # Look back this many hours for kgl errors in alert log

STATE_FILE="/tmp/ora600_kgl_monitor_state_\${ORACLE_SID}"

export ORACLE_HOME ORACLE_SID
export PATH=\${ORACLE_HOME}/bin:\${PATH}

log() {
  echo "[$LOG_DATE][$SCRIPT_NAME] $1"
}

send_alert() {
  local subject="$1"
  local body="$2"
  log "ALERT: $subject"
  echo "$body" | mail -s "[$ORACLE_SID] ALERT: $subject" "$ALERT_EMAIL" 2>/dev/null || true
}

run_sql() {
  sqlplus -s "/ as sysdba" <<SQL
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMOUT ON TRIMSPOOL ON
ALTER SESSION SET NLS_NUMERIC_CHARACTERS='.,';
$1
EXIT;
SQL
}

# --- Check 1: ORA-600 kgl errors in alert log (recurrence check) ---
log "=== Check 1: ORA-600 kgl errors in alert log ==="
KGL_ERRORS=$(run_sql "
SELECT COUNT(*) FROM v\$diag_alert_ext
WHERE originating_timestamp >= SYSTIMESTAMP - INTERVAL '$KGL_ERROR_CHECK_HOURS' HOUR
  AND (message_text LIKE '%kglLockOwnersListDelete%'
       OR message_text LIKE '%kglLock%'
       OR (message_text LIKE 'ORA-00600%' AND message_text LIKE '%kgl%'));
" | tr -d ' ')

log "KGL errors in past \${KGL_ERROR_CHECK_HOURS}h: $KGL_ERRORS"
if [ "$KGL_ERRORS" -gt 0 ]; then
  ALERT=1
  DETAIL=$(run_sql "
SELECT TO_CHAR(originating_timestamp,'YYYY-MM-DD HH24:MI:SS') || ' ' || SUBSTR(message_text,1,150)
FROM v\$diag_alert_ext
WHERE originating_timestamp >= SYSTIMESTAMP - INTERVAL '$KGL_ERROR_CHECK_HOURS' HOUR
  AND (message_text LIKE '%kglLock%'
       OR (message_text LIKE 'ORA-00600%' AND message_text LIKE '%kgl%'))
ORDER BY originating_timestamp DESC
FETCH FIRST 5 ROWS ONLY;
")
  send_alert "ORA-600 kgl error RECURRENCE: $KGL_ERRORS in past \${KGL_ERROR_CHECK_HOURS}h" \
    "The kgl library cache error is recurring. Immediate action required.
Recent occurrences:
$DETAIL

Open Oracle SR immediately with the packaged diagnostics."
fi

# --- Check 2: Library cache pin hit ratio ---
log "=== Check 2: Library cache pin hit ratio ==="
PIN_HIT_RATIO=$(run_sql "
SELECT ROUND(SUM(pinhits) / NULLIF(SUM(pins),0) * 100, 1)
FROM v\$librarycache;
" | tr -d ' ')

log "Library cache pin hit ratio: \${PIN_HIT_RATIO}% (threshold: \${PIN_HIT_THRESHOLD}%)"
if [ -n "$PIN_HIT_RATIO" ] && awk "BEGIN{exit !($PIN_HIT_RATIO < $PIN_HIT_THRESHOLD)}"; then
  ALERT=1
  send_alert "Library cache pin hit ratio degraded: \${PIN_HIT_RATIO}%" \
    "Library cache pin hit ratio is \${PIN_HIT_RATIO}%, below the \${PIN_HIT_THRESHOLD}% threshold.
This indicates the shared pool is too small or hard parsing is excessive.
Check v\$librarycache for namespace-level breakdown and v\$sqlarea for high version_count cursors."
fi

# --- Check 3: Hard parse ratio ---
log "=== Check 3: Hard parse ratio ==="
HARD_PARSE_PCT=$(run_sql "
SELECT ROUND(
  (SELECT value FROM v\$sysstat WHERE name='parse count (hard)') /
  NULLIF((SELECT value FROM v\$sysstat WHERE name='parse count (total)'),0) * 100, 1)
FROM dual;
" | tr -d ' ')

log "Hard parse ratio: \${HARD_PARSE_PCT}% (threshold: \${HARD_PARSE_THRESHOLD}%)"
if [ -n "$HARD_PARSE_PCT" ] && awk "BEGIN{exit !($HARD_PARSE_PCT > $HARD_PARSE_THRESHOLD)}"; then
  ALERT=1
  TOP_HARD=$(run_sql "
SELECT sql_id, version_count, parse_calls, SUBSTR(sql_text,1,80) AS sql_text
FROM v\$sqlarea
WHERE version_count > 20
ORDER BY version_count DESC
FETCH FIRST 5 ROWS ONLY;
")
  send_alert "High hard parse ratio: \${HARD_PARSE_PCT}%" \
    "Hard parse ratio is \${HARD_PARSE_PCT}%, exceeding the \${HARD_PARSE_THRESHOLD}% threshold.
Top high-version-count cursors:
$TOP_HARD

Consider CURSOR_SHARING=FORCE as an interim measure while investigating application bind variable usage."
fi

# --- Check 4: Library cache reload delta ---
log "=== Check 4: Library cache reloads delta ==="
CURRENT_RELOADS=$(run_sql "
SELECT SUM(reloads) FROM v\$librarycache;
" | tr -d ' ')

if [ -f "$STATE_FILE" ]; then
  PREV_RELOADS=$(cat "$STATE_FILE")
  RELOAD_DELTA=$((CURRENT_RELOADS - PREV_RELOADS))
  log "Library cache reload delta: $RELOAD_DELTA (threshold: $RELOAD_THRESHOLD)"
  if [ "$RELOAD_DELTA" -gt "$RELOAD_THRESHOLD" ]; then
    ALERT=1
    send_alert "Library cache reload spike: $RELOAD_DELTA reloads since last check" \
      "Library cache reloads increased by $RELOAD_DELTA in the last monitoring interval.
Reload spikes indicate cursors are being aged out and re-parsed under load — a precursor to kgl assertion failures.
Check shared pool free memory and consider increasing SHARED_POOL_SIZE."
  fi
else
  log "No previous reload state — baseline established at $CURRENT_RELOADS"
fi
echo "$CURRENT_RELOADS" > "$STATE_FILE"

# --- Check 5: Shared pool free memory ---
log "=== Check 5: Shared pool free memory ==="
FREE_MB=$(run_sql "
SELECT ROUND(SUM(bytes)/1048576,0)
FROM v\$sgastat
WHERE pool='shared pool' AND name='free memory';
" | tr -d ' ')

log "Shared pool free memory: \${FREE_MB} MB (threshold: \${FREE_POOL_MB_THRESHOLD} MB)"
if [ -n "$FREE_MB" ] && [ "$FREE_MB" -lt "$FREE_POOL_MB_THRESHOLD" ]; then
  ALERT=1
  POOL_BREAKDOWN=$(run_sql "
SELECT name, ROUND(bytes/1048576,1) AS mb
FROM v\$sgastat
WHERE pool='shared pool'
  AND name IN ('free memory','library cache','sql area','dictionary cache','miscellaneous')
ORDER BY bytes DESC;
")
  send_alert "Shared pool free memory critically low: \${FREE_MB} MB" \
    "Shared pool has only \${FREE_MB} MB free, below the \${FREE_POOL_MB_THRESHOLD} MB threshold.
A near-exhausted shared pool increases the probability of kgl assertion failures.

Pool breakdown:
$POOL_BREAKDOWN

Consider increasing SHARED_POOL_SIZE or SGA_TARGET. Review high-version-count cursors immediately."
fi

# --- Summary ---
log "=== Monitor Summary ==="
log "KGL errors: $KGL_ERRORS | Pin hit: \${PIN_HIT_RATIO}% | Hard parse: \${HARD_PARSE_PCT}% | Reloads delta: \${RELOAD_DELTA:-N/A} | Free pool: \${FREE_MB} MB"
if [ "$ALERT" -eq 0 ]; then
  log "STATUS: OK — All checks passed"
else
  log "STATUS: ALERT SENT — One or more checks failed"
fi
\`\`\`

### Deploy and schedule

\`\`\`bash
mkdir -p /home/oracle/scripts /home/oracle/logs
cp ora600_kgl_monitor.sh /home/oracle/scripts/
chmod 750 /home/oracle/scripts/ora600_kgl_monitor.sh

# Source the Oracle environment in the script (add after the shebang):
# source /home/oracle/.bash_profile
# or
# export ORACLE_HOME=/u01/app/oracle/product/11.2.0/dbhome_1
# export ORACLE_SID=EBSPRD

# Cron — every 5 minutes during active incident monitoring
(crontab -l 2>/dev/null; echo "*/5 * * * * /home/oracle/scripts/ora600_kgl_monitor.sh >> /home/oracle/logs/ora600_kgl_monitor.log 2>&1") | crontab -

# Reduce to every 15 minutes once stable
# Change */5 to */15 in crontab
\`\`\`

---

## Quick Reference: Symptom to Phase Mapping

| Symptom | Phase |
|---------|-------|
| Instance down, no Oracle processes running | Phase 1.1 — restart |
| IPC resources blocking restart | Phase 1.2 — ipcrm cleanup |
| Need to preserve trace before any action | Phase 2 — ADRCI package |
| Need to read the crash timeline | Phase 3 — alert log triage |
| Post-restart library cache looks unhealthy | Phase 4 — cache assessment |
| Need to identify and apply the patch | Phase 5 — patch process |
| Hard parse rate is high | Phase 6.1 — CURSOR_SHARING |
| Recurring crashes / library cache instability | Phase 7 — restart cadence |

---

## Key Parameters Reference

| Parameter | Recommended Value | Notes |
|-----------|------------------|-------|
| \`CURSOR_SHARING\` | \`EXACT\` (default) or \`FORCE\` if hard parse > 5% | FORCE is a mitigation, not a fix |
| \`OPEN_CURSORS\` | 300–1000 depending on load | Check actual session usage first |
| \`SESSION_CACHED_CURSORS\` | 50–100 | Reduces soft parse overhead |
| \`SHARED_POOL_SIZE\` | Size so free memory stays > 10% | Use Shared Pool Advisor to tune |
| \`_CURSOR_DB_BUFFERS_PINNED\` | Default (do not change) | Oracle Support may set for specific bugs |`,
};

async function main() {
  console.log('Inserting ORA-00600 kglLockOwnersListDelete runbook...');
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
