import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS SYSAUX Tablespace Management: Space Recovery and Monitoring Runbook',
  slug: 'oracle-ebs-sysaux-tablespace-management-runbook',
  excerpt:
    'Step-by-step runbook for managing SYSAUX tablespace growth in Oracle EBS production environments: occupant analysis, AWR retention tuning and snapshot purge, optimizer statistics history reduction, SQL Plan Management cleanup, emergency datafile expansion, and a monitoring script with configurable thresholds that tracks SYSAUX usage, growth rate, and occupant trends.',
  category: 'appsdba' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `## Scope

This runbook applies to Oracle Database 11g, 12c, 19c, and 21c installations hosting Oracle EBS R12.x. All procedures require DBA or SYSDBA access. No application downtime is required for any retention or purge operation — all steps are online.

**Triggering conditions for this runbook:**
- SYSAUX tablespace usage exceeds 80%
- AWR snapshot failures logged in the alert log (\`ORA-1688\`, \`ORA-1652\`)
- Optimizer statistics collection errors referencing SYSAUX
- SYSAUX growth rate exceeding 1 GB/week unexpectedly
- Proactive monthly SYSAUX maintenance window

---

## Phase 1: Assess Current SYSAUX State

### 1.1 Tablespace size, used, and free

\`\`\`sql
-- Full SYSAUX capacity picture
SELECT df.tablespace_name,
       ROUND(df.total_mb, 0)                            AS total_mb,
       ROUND(df.total_mb - NVL(fs.free_mb, 0), 0)      AS used_mb,
       ROUND(NVL(fs.free_mb, 0), 0)                     AS free_mb,
       ROUND((df.total_mb - NVL(fs.free_mb,0))
             / df.total_mb * 100, 1)                    AS pct_used,
       df.file_count,
       df.max_autoextend_gb
FROM (
    SELECT tablespace_name,
           SUM(bytes) / 1048576              AS total_mb,
           COUNT(*)                           AS file_count,
           ROUND(SUM(maxbytes) / 1073741824)  AS max_autoextend_gb
    FROM   dba_data_files
    GROUP BY tablespace_name
) df
LEFT JOIN (
    SELECT tablespace_name, SUM(bytes) / 1048576 AS free_mb
    FROM   dba_free_space
    GROUP BY tablespace_name
) fs USING (tablespace_name)
WHERE df.tablespace_name = 'SYSAUX';
\`\`\`

### 1.2 Occupant breakdown

\`\`\`sql
-- All SYSAUX occupants with space used
SELECT occupant_name,
       schema_name,
       ROUND(space_usage_kbytes / 1048576, 2) AS space_gb,
       ROUND(space_usage_kbytes / 1024, 0)    AS space_mb,
       move_procedure
FROM   v\$sysaux_occupants
WHERE  space_usage_kbytes > 0
ORDER BY space_usage_kbytes DESC;
\`\`\`

### 1.3 Top 20 segments in SYSAUX by size

\`\`\`sql
SELECT owner,
       segment_name,
       segment_type,
       ROUND(SUM(bytes) / 1048576, 0) AS size_mb
FROM   dba_segments
WHERE  tablespace_name = 'SYSAUX'
GROUP BY owner, segment_name, segment_type
ORDER BY size_mb DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

### 1.4 Current AWR configuration

\`\`\`sql
SELECT dbid,
       snap_interval,
       retention,
       most_recent_snap_id,
       most_recent_snap_time,
       topnsql
FROM   dba_hist_wr_control;
\`\`\`

### 1.5 AWR snapshot count and date range

\`\`\`sql
SELECT COUNT(*)                          AS total_snapshots,
       MIN(begin_interval_time)          AS oldest_snapshot,
       MAX(end_interval_time)            AS newest_snapshot,
       ROUND(MAX(end_interval_time) - MIN(begin_interval_time)) AS days_retained
FROM   dba_hist_snapshot;
\`\`\`

### 1.6 Optimizer statistics history current retention

\`\`\`sql
SELECT dbms_stats.get_stats_history_retention AS retention_days,
       dbms_stats.get_stats_history_availability AS oldest_available
FROM   dual;
\`\`\`

### 1.7 SQL Plan Management baseline count and space

\`\`\`sql
SELECT COUNT(*)                            AS total_baselines,
       SUM(CASE WHEN accepted = 'YES' THEN 1 ELSE 0 END) AS accepted,
       SUM(CASE WHEN accepted = 'NO'  THEN 1 ELSE 0 END) AS unaccepted,
       SUM(CASE WHEN enabled  = 'NO'  THEN 1 ELSE 0 END) AS disabled
FROM   dba_sql_plan_baselines;

-- SPM space in SYSAUX
SELECT segment_name,
       ROUND(SUM(bytes) / 1048576, 0) AS size_mb
FROM   dba_segments
WHERE  tablespace_name = 'SYSAUX'
  AND  segment_name IN ('SQLOBJ\$','SQLOBJ\$AUXDATA','SQLOBJ\$DATA',
                        'SQL\$','SQL\$TEXT','SQLOBJ\$PLAN')
GROUP BY segment_name
ORDER BY size_mb DESC;
\`\`\`

---

## Phase 2: Reduce AWR Retention

### 2.1 Set new retention period

The EBS-recommended retention for production is 14–30 days depending on your reporting cycle. Do not go below 7 days or you lose the ability to compare week-over-week performance.

\`\`\`sql
-- Change retention to 14 days (20,160 minutes) with hourly snapshots
BEGIN
  DBMS_WORKLOAD_REPOSITORY.MODIFY_SNAPSHOT_SETTINGS(
    retention => 20160,   -- 14 days in minutes
    interval  => 60       -- 60-minute snapshot interval
  );
END;
/

-- Verify
SELECT snap_interval, retention FROM dba_hist_wr_control;
\`\`\`

### 2.2 Manually purge snapshots older than new retention

Background purge runs in MMON but can take days. Trigger immediate purge:

\`\`\`sql
-- Find the snapshot range to drop
SELECT MIN(snap_id) AS min_snap,
       MAX(snap_id) AS max_snap
FROM   dba_hist_snapshot
WHERE  end_interval_time < SYSDATE - 14;

-- Drop the range (replace with actual values from above)
BEGIN
  DBMS_WORKLOAD_REPOSITORY.DROP_SNAPSHOT_RANGE(
    low_snap_id  => &min_snap,
    high_snap_id => &max_snap
  );
END;
/
\`\`\`

For very large ranges, process in batches of 1,000 snapshots to avoid long-running transactions:

\`\`\`sql
DECLARE
  CURSOR c_ranges IS
    SELECT MIN(snap_id) AS lo,
           MAX(snap_id) AS hi
    FROM (
        SELECT snap_id,
               CEIL(ROW_NUMBER() OVER (ORDER BY snap_id) / 1000) AS batch
        FROM   dba_hist_snapshot
        WHERE  end_interval_time < SYSDATE - 14
    )
    GROUP BY batch
    ORDER BY lo;
BEGIN
  FOR r IN c_ranges LOOP
    DBMS_WORKLOAD_REPOSITORY.DROP_SNAPSHOT_RANGE(
      low_snap_id  => r.lo,
      high_snap_id => r.hi
    );
    COMMIT;
    DBMS_OUTPUT.PUT_LINE('Dropped snaps ' || r.lo || ' to ' || r.hi);
  END LOOP;
END;
/
\`\`\`

### 2.3 Verify AWR purge completed

\`\`\`sql
-- After purge, confirm oldest snapshot matches new retention
SELECT MIN(begin_interval_time) AS oldest_snap,
       COUNT(*)                  AS remaining_snaps
FROM   dba_hist_snapshot;
-- oldest_snap should now be approximately SYSDATE - 14
\`\`\`

### 2.4 Shrink top AWR segments to reclaim extents

\`\`\`sql
-- Enable row movement and shrink (run for top 5 AWR tables by size)
ALTER TABLE sys.wrh\$_sqlstat                  ENABLE ROW MOVEMENT;
ALTER TABLE sys.wrh\$_sqlstat                  SHRINK SPACE CASCADE;

ALTER TABLE sys.wrh\$_active_session_history   ENABLE ROW MOVEMENT;
ALTER TABLE sys.wrh\$_active_session_history   SHRINK SPACE CASCADE;

ALTER TABLE sys.wrh\$_sql_plan                 ENABLE ROW MOVEMENT;
ALTER TABLE sys.wrh\$_sql_plan                 SHRINK SPACE CASCADE;

ALTER TABLE sys.wrh\$_seg_stat                 ENABLE ROW MOVEMENT;
ALTER TABLE sys.wrh\$_seg_stat                 SHRINK SPACE CASCADE;

ALTER TABLE sys.wrh\$_sysstat                  ENABLE ROW MOVEMENT;
ALTER TABLE sys.wrh\$_sysstat                  SHRINK SPACE CASCADE;
\`\`\`

**Note:** Shrink is an online operation but generates redo. Run during off-peak hours on very large tables.

---

## Phase 3: Reduce Optimizer Statistics History

### 3.1 Change retention to 14 days

\`\`\`sql
BEGIN
  DBMS_STATS.ALTER_STATS_HISTORY_RETENTION(14);
END;
/

-- Verify
SELECT dbms_stats.get_stats_history_retention FROM dual;
-- Expected: 14
\`\`\`

### 3.2 Purge statistics older than 14 days immediately

\`\`\`sql
BEGIN
  DBMS_STATS.PURGE_STATS(SYSDATE - 14);
END;
/
\`\`\`

**Note:** \`DBMS_STATS.PURGE_STATS\` can take 10–30 minutes on a large EBS database with many tables. Run in a dedicated session:

\`\`\`sql
-- Monitor progress from another session
SELECT opname, target, sofar, totalwork,
       ROUND(sofar / NULLIF(totalwork,0) * 100, 1) AS pct_done,
       elapsed_seconds
FROM   v\$session_longops
WHERE  opname LIKE '%STATS%'
  AND  sofar < totalwork;
\`\`\`

### 3.3 Shrink optimizer statistics tables

\`\`\`sql
ALTER TABLE sys.wri\$_optstat_tab_history     ENABLE ROW MOVEMENT;
ALTER TABLE sys.wri\$_optstat_tab_history     SHRINK SPACE CASCADE;
ALTER TABLE sys.wri\$_optstat_ind_history     ENABLE ROW MOVEMENT;
ALTER TABLE sys.wri\$_optstat_ind_history     SHRINK SPACE CASCADE;
ALTER TABLE sys.wri\$_optstat_histgrm_history ENABLE ROW MOVEMENT;
ALTER TABLE sys.wri\$_optstat_histgrm_history SHRINK SPACE CASCADE;
ALTER TABLE sys.wri\$_optstat_histhead_history ENABLE ROW MOVEMENT;
ALTER TABLE sys.wri\$_optstat_histhead_history SHRINK SPACE CASCADE;
\`\`\`

---

## Phase 4: SQL Plan Management Cleanup

### 4.1 Disable automatic baseline capture (if not deliberately enabled)

\`\`\`sql
-- Check current setting
SELECT value FROM v\$parameter WHERE name = 'optimizer_capture_sql_plan_baselines';

-- Disable if set to TRUE and you did not intentionally enable it
ALTER SYSTEM SET optimizer_capture_sql_plan_baselines = FALSE SCOPE=BOTH;
\`\`\`

### 4.2 Drop unaccepted plan baselines older than 30 days

\`\`\`sql
DECLARE
  v_dropped PLS_INTEGER;
BEGIN
  -- Drop unaccepted baselines
  v_dropped := DBMS_SPM.DROP_SQL_PLAN_BASELINE(
    sql_handle  => NULL,
    plan_name   => NULL,
    fixed       => 'NO',
    accepted    => 'NO',
    enabled     => 'YES'
  );
  DBMS_OUTPUT.PUT_LINE('Dropped unaccepted baselines: ' || v_dropped);
END;
/
\`\`\`

### 4.3 Configure SPM evolve task retention

\`\`\`sql
-- Limit STA / SPM evolve task retention to 30 days
BEGIN
  DBMS_AUTO_TASK_ADMIN.DISABLE(
    client_name => 'sql tuning advisor',
    operation   => NULL,
    window_name => NULL
  );
END;
/
-- Re-enable if needed after cleanup:
-- DBMS_AUTO_TASK_ADMIN.ENABLE('sql tuning advisor', NULL, NULL);
\`\`\`

---

## Phase 5: SQL Tuning Advisor Findings Purge

\`\`\`sql
-- Check space used by STA tasks
SELECT COUNT(*), SUM(DBMS_SQLTUNE.REPORT_TUNING_TASK_SIZE) AS total_bytes
FROM   dba_advisor_tasks
WHERE  advisor_name = 'SQL Tuning Advisor';

-- Drop all completed STA task findings older than 30 days
BEGIN
  FOR t IN (
    SELECT task_name
    FROM   dba_advisor_tasks
    WHERE  advisor_name = 'SQL Tuning Advisor'
      AND  status        = 'COMPLETED'
      AND  created       < SYSDATE - 30
  ) LOOP
    DBMS_SQLTUNE.DROP_TUNING_TASK(t.task_name);
  END LOOP;
END;
/
\`\`\`

---

## Phase 6: Emergency Datafile Addition

If SYSAUX is critically full (>95%) and purge operations cannot complete fast enough:

\`\`\`sql
-- Find current datafiles and their locations
SELECT file_name, ROUND(bytes / 1073741824, 1) AS size_gb,
       autoextensible, ROUND(maxbytes / 1073741824, 1) AS max_gb
FROM   dba_data_files
WHERE  tablespace_name = 'SYSAUX'
ORDER BY file_id;

-- Add a new datafile (use the same path convention as existing files)
ALTER TABLESPACE sysaux
  ADD DATAFILE '/u01/oradata/EBSPRD/sysaux02.dbf'
  SIZE 4G
  AUTOEXTEND ON
  NEXT 512M
  MAXSIZE 20G;

-- Confirm addition
SELECT file_name, ROUND(bytes / 1073741824, 1) AS size_gb
FROM   dba_data_files
WHERE  tablespace_name = 'SYSAUX';
\`\`\`

---

## Phase 7: SYSAUX Monitoring Script

Save as \`/usr/local/bin/sysaux_monitor.sh\`. Schedule daily and after any maintenance window. The script tracks SYSAUX utilization, growth rate, top occupants, AWR snapshot health, and alerts on configurable thresholds.

\`\`\`bash
#!/bin/bash
# sysaux_monitor.sh — Oracle EBS SYSAUX Tablespace Health Monitor
#
# Checks: tablespace % used, growth rate (7-day), top occupants,
#         AWR retention vs actual, AWR snapshot failures, optimizer
#         stats retention, SPM baseline count
#
# Usage:  ./sysaux_monitor.sh [ORACLE_SID]
# Cron:   0 8 * * * /usr/local/bin/sysaux_monitor.sh EBSPRD >> /var/log/sysaux_monitor.log 2>&1

ORACLE_SID="\${1:-EBSPRD}"
export ORACLE_SID
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
ALERT_LOG="/var/log/sysaux_monitor_alerts.log"
FAILURES=0

# Configurable thresholds
WARN_PCT=80
CRIT_PCT=90
GROWTH_WARN_GB_WEEK=2      # Alert if SYSAUX grew more than 2 GB in 7 days
AWR_RETAIN_MAX_DAYS=30     # Alert if AWR retention exceeds this
OPTSTAT_RETAIN_MAX_DAYS=20 # Alert if optimizer stats retention exceeds this
SPM_BASELINE_WARN=5000     # Alert if SPM baseline count exceeds this

log()   { echo "[$TIMESTAMP] $*"; }
alert() { echo "[$TIMESTAMP] ALERT: $*" | tee -a "$ALERT_LOG"; FAILURES=$((FAILURES + 1)); }

log "=== SYSAUX Monitor Start (SID: \$ORACLE_SID) ==="

source /home/oracle/.bash_profile 2>/dev/null || true
export ORACLE_HOME="\${ORACLE_HOME:-/u01/app/oracle/product/19.0.0/dbhome_1}"
export PATH="\$ORACLE_HOME/bin:\$PATH"
SQLPLUS="\$ORACLE_HOME/bin/sqlplus -s / as sysdba"

# -----------------------------------------------------------------------
# CHECK 1: SYSAUX usage percentage
# -----------------------------------------------------------------------
log "Checking SYSAUX usage..."

USAGE_DATA=\$(\$SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT ROUND(used_mb) || '|' || ROUND(total_mb) || '|' || ROUND(pct_used, 1)
FROM (
  SELECT (SUM(d.bytes) - NVL(SUM(f.bytes), 0)) / 1048576 AS used_mb,
         SUM(d.bytes) / 1048576 AS total_mb,
         (SUM(d.bytes) - NVL(SUM(f.bytes), 0)) / SUM(d.bytes) * 100 AS pct_used
  FROM   dba_data_files d
  LEFT JOIN dba_free_space f ON f.tablespace_name = d.tablespace_name
  WHERE  d.tablespace_name = 'SYSAUX'
);
EXIT;
SQLEOF
)

USED_MB=$(echo "\$USAGE_DATA" | cut -d'|' -f1 | tr -d '[:space:]')
TOTAL_MB=$(echo "\$USAGE_DATA" | cut -d'|' -f2 | tr -d '[:space:]')
PCT_USED=$(echo "\$USAGE_DATA" | cut -d'|' -f3 | tr -d '[:space:]')

log "SYSAUX: \${USED_MB}MB used / \${TOTAL_MB}MB total (\${PCT_USED}%)"

if (( \$(echo "\$PCT_USED >= \$CRIT_PCT" | bc -l) )); then
  alert "SYSAUX is \${PCT_USED}% full — CRITICAL (threshold: \${CRIT_PCT}%). Add datafile or purge immediately."
elif (( \$(echo "\$PCT_USED >= \$WARN_PCT" | bc -l) )); then
  alert "SYSAUX is \${PCT_USED}% full — WARNING (threshold: \${WARN_PCT}%). Schedule purge."
else
  log "SYSAUX usage \${PCT_USED}%: OK."
fi

# -----------------------------------------------------------------------
# CHECK 2: SYSAUX growth rate (compare to 7 days ago via DBA_HIST_TBSPC_STAT)
# -----------------------------------------------------------------------
log "Checking 7-day SYSAUX growth rate..."

GROWTH_DATA=\$(\$SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT ROUND((current_mb - week_ago_mb) / 1024, 2) AS growth_gb
FROM (
  SELECT MAX(CASE WHEN rn = 1 THEN tablespace_usedsize END) * 8 / 1024 AS current_mb,
         MAX(CASE WHEN rn >= 7 THEN tablespace_usedsize END) * 8 / 1024 AS week_ago_mb
  FROM (
    SELECT s.tablespace_usedsize,
           ROW_NUMBER() OVER (ORDER BY snap.end_interval_time DESC) AS rn
    FROM   dba_hist_tbspc_stat   s
    JOIN   dba_hist_snapshot     snap ON snap.snap_id = s.snap_id
    JOIN   v\$tablespace          ts   ON ts.ts# = s.tablespace_id
    WHERE  ts.name = 'SYSAUX'
      AND  snap.end_interval_time > SYSDATE - 8
  )
);
EXIT;
SQLEOF
)

GROWTH_GB=$(echo "\$GROWTH_DATA" | tr -d '[:space:]')
if [[ -n "\$GROWTH_GB" ]] && (( \$(echo "\$GROWTH_GB > \$GROWTH_WARN_GB_WEEK" | bc -l) )); then
  alert "SYSAUX grew \${GROWTH_GB}GB in the last 7 days (threshold: \${GROWTH_WARN_GB_WEEK}GB). Investigate top occupants."
else
  log "SYSAUX 7-day growth: \${GROWTH_GB:-unknown}GB. OK."
fi

# -----------------------------------------------------------------------
# CHECK 3: Top 5 SYSAUX occupants
# -----------------------------------------------------------------------
log "Reporting top SYSAUX occupants..."

\$SQLPLUS <<'SQLEOF'
SET HEADING ON FEEDBACK OFF LINESIZE 80 PAGESIZE 20 TRIMSPOOL ON
SELECT occupant_name,
       ROUND(space_usage_kbytes / 1048576, 2) AS space_gb
FROM   v\$sysaux_occupants
WHERE  space_usage_kbytes > 0
ORDER BY space_usage_kbytes DESC
FETCH FIRST 5 ROWS ONLY;
EXIT;
SQLEOF

# -----------------------------------------------------------------------
# CHECK 4: AWR retention vs configured value
# -----------------------------------------------------------------------
log "Checking AWR retention settings..."

AWR_DATA=\$(\$SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT ROUND(EXTRACT(DAY FROM retention) +
             EXTRACT(HOUR FROM retention)/24) || '|' ||
       ROUND(MIN(begin_interval_time) - SYSDATE + MAX(end_interval_time) - SYSDATE)
FROM   dba_hist_wr_control, dba_hist_snapshot
GROUP BY retention;
EXIT;
SQLEOF
)

RETAIN_DAYS=$(echo "\$AWR_DATA" | cut -d'|' -f1 | tr -d '[:space:]')
log "AWR configured retention: \${RETAIN_DAYS} days"

if [[ -n "\$RETAIN_DAYS" ]] && [[ "\$RETAIN_DAYS" -gt "\$AWR_RETAIN_MAX_DAYS" ]]; then
  alert "AWR retention is \${RETAIN_DAYS} days (threshold: \${AWR_RETAIN_MAX_DAYS}). Reduce with DBMS_WORKLOAD_REPOSITORY.MODIFY_SNAPSHOT_SETTINGS."
fi

# -----------------------------------------------------------------------
# CHECK 5: AWR snapshot failures in alert log
# -----------------------------------------------------------------------
log "Checking for AWR snapshot failure errors..."

ALERT_LOG_PATH=\$(\$SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT value FROM v\$diag_info WHERE name = 'Diag Alert';
EXIT;
SQLEOF
)
ALERT_LOG_PATH=$(echo "\$ALERT_LOG_PATH" | tr -d '[:space:]')

if [[ -f "\$ALERT_LOG_PATH/alert_\$ORACLE_SID.log" ]]; then
  SNAP_ERRORS=$(tail -500 "\$ALERT_LOG_PATH/alert_\$ORACLE_SID.log" \
                | grep -c 'ORA-1688\|ORA-1652\|SYSAUX.*full\|AWR.*error' || echo "0")
  if [[ "\$SNAP_ERRORS" -gt 0 ]]; then
    alert "\$SNAP_ERRORS AWR/SYSAUX error(s) found in alert log (ORA-1688, ORA-1652)"
    tail -500 "\$ALERT_LOG_PATH/alert_\$ORACLE_SID.log" \
      | grep 'ORA-1688\|ORA-1652\|SYSAUX.*full\|AWR.*error' | tail -5
  else
    log "No AWR snapshot errors in alert log. OK."
  fi
fi

# -----------------------------------------------------------------------
# CHECK 6: Optimizer statistics retention
# -----------------------------------------------------------------------
log "Checking optimizer statistics history retention..."

OPTSTAT_RETAIN=\$(\$SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT dbms_stats.get_stats_history_retention FROM dual;
EXIT;
SQLEOF
)
OPTSTAT_RETAIN=$(echo "\$OPTSTAT_RETAIN" | tr -d '[:space:]')

log "Optimizer statistics retention: \${OPTSTAT_RETAIN} days"
if [[ -n "\$OPTSTAT_RETAIN" ]] && [[ "\$OPTSTAT_RETAIN" -gt "\$OPTSTAT_RETAIN_MAX_DAYS" ]]; then
  alert "Optimizer statistics retention is \${OPTSTAT_RETAIN} days (threshold: \${OPTSTAT_RETAIN_MAX_DAYS}). Run: DBMS_STATS.ALTER_STATS_HISTORY_RETENTION(14)."
fi

# -----------------------------------------------------------------------
# CHECK 7: SQL Plan Management baseline count
# -----------------------------------------------------------------------
log "Checking SQL Plan Management baseline count..."

SPM_COUNT=\$(\$SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT COUNT(*) FROM dba_sql_plan_baselines;
EXIT;
SQLEOF
)
SPM_COUNT=$(echo "\$SPM_COUNT" | tr -d '[:space:]')

log "SPM baselines: \$SPM_COUNT"
if [[ -n "\$SPM_COUNT" ]] && [[ "\$SPM_COUNT" -gt "\$SPM_BASELINE_WARN" ]]; then
  alert "SQL Plan Management has \$SPM_COUNT baselines (threshold: \$SPM_BASELINE_WARN). Purge unaccepted baselines."
  \$SQLPLUS <<'SQLEOF'
SET HEADING ON FEEDBACK OFF LINESIZE 60 PAGESIZE 10
SELECT accepted, enabled, COUNT(*) AS cnt
FROM   dba_sql_plan_baselines
GROUP BY accepted, enabled
ORDER BY 1, 2;
EXIT;
SQLEOF
else
  log "SPM baseline count: OK."
fi

# -----------------------------------------------------------------------
# CHECK 8: SYSAUX autoextend headroom
# -----------------------------------------------------------------------
log "Checking SYSAUX autoextend headroom..."

AE_DATA=\$(\$SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT ROUND(SUM(bytes) / 1073741824, 1) || '|' ||
       ROUND(SUM(maxbytes) / 1073741824, 1)
FROM   dba_data_files
WHERE  tablespace_name   = 'SYSAUX'
  AND  autoextensible    = 'YES';
EXIT;
SQLEOF
)

CURR_GB=$(echo "\$AE_DATA" | cut -d'|' -f1 | tr -d '[:space:]')
MAX_GB=$(echo "\$AE_DATA" | cut -d'|' -f2 | tr -d '[:space:]')

if [[ -n "\$MAX_GB" ]] && [[ -n "\$CURR_GB" ]]; then
  HEADROOM=\$(echo "\$MAX_GB - \$CURR_GB" | bc)
  log "SYSAUX autoextend: \${CURR_GB}GB current / \${MAX_GB}GB max (\${HEADROOM}GB headroom)"
  if (( \$(echo "\$HEADROOM < 5" | bc -l) )); then
    alert "SYSAUX autoextend headroom is only \${HEADROOM}GB. Increase MAXSIZE or add a datafile."
  fi
else
  log "No autoextend datafiles found — SYSAUX is fixed-size. Monitor free space closely."
fi

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
log "=== SYSAUX Monitor Complete: \$FAILURES alert(s) ==="

if [[ "\$FAILURES" -gt 0 ]]; then
  echo ""
  echo "ACTION REQUIRED: \$FAILURES SYSAUX issue(s) detected. See \$ALERT_LOG"
  exit 1
else
  log "All SYSAUX checks passed."
  exit 0
fi
\`\`\`

### Install and schedule

\`\`\`bash
chmod +x /usr/local/bin/sysaux_monitor.sh

# Daily at 08:00 — review occupants each morning
crontab -e
\`\`\`

\`\`\`
0 8 * * * /usr/local/bin/sysaux_monitor.sh EBSPRD >> /var/log/sysaux_monitor.log 2>&1
\`\`\`

For immediate email alerts when SYSAUX exceeds 90%:

\`\`\`
*/30 * * * * /usr/local/bin/sysaux_monitor.sh EBSPRD 2>&1 | grep -q 'ACTION REQUIRED' && \
  /usr/local/bin/sysaux_monitor.sh EBSPRD | mailx -s "SYSAUX Alert - $(hostname)" dba-alerts@company.com
\`\`\`

---

## Monthly Maintenance Checklist

Run these steps on the first Monday of each month during a low-traffic window:

\`\`\`
[ ] Run sysaux_monitor.sh and review all alerts
[ ] Check V\$SYSAUX_OCCUPANTS — any occupant growing >10% month-over-month?
[ ] Purge AWR snapshots older than retention period (Phase 2.2)
[ ] Purge optimizer statistics history older than 14 days (Phase 3.2)
[ ] Drop unaccepted SPM baselines (Phase 4.2)
[ ] Drop completed SQL Tuning Advisor tasks older than 30 days (Phase 5)
[ ] Shrink top 5 AWR segments if reclaim > 500MB (Phase 2.4)
[ ] Verify SYSAUX autoextend headroom > 5 GB after purge
[ ] Record SYSAUX used_mb in capacity tracking spreadsheet
\`\`\`

---

## Troubleshooting Table

| Symptom | Root Cause | Fix |
|---------|-----------|-----|
| \`ORA-1688: unable to extend segment in SYSAUX\` | SYSAUX full — AWR or stats tables | Emergency datafile add (Phase 6), then purge (Phase 2–3) |
| AWR snapshots stop being created | SYSAUX > 97% full | Add datafile immediately; reduce retention |
| Purge runs but space not reclaimed | Segments not shrunk after purge | Run \`SHRINK SPACE CASCADE\` on top AWR tables (Phase 2.4) |
| \`DBMS_STATS.PURGE_STATS\` hangs | Very large stats history with index rebuilds | Run during off-peak; monitor with \`v\$session_longops\` |
| SPM baselines growing without known cause | \`optimizer_capture_sql_plan_baselines = TRUE\` | Set to FALSE; drop unaccepted baselines (Phase 4) |
| Growth resumes immediately after purge | AWR retention not changed — only snapshot deleted | Set new retention with \`MODIFY_SNAPSHOT_SETTINGS\` (Phase 2.1) |
| Shrink fails with \`ORA-10635\` | Table not in row-movement-enabled state | Run \`ALTER TABLE ... ENABLE ROW MOVEMENT\` first |
| Monitor reports occupant space but \`dba_free_space\` shows free space | High-water mark not reset after purge | Run \`SHRINK SPACE\` or \`MOVE\` to reset high-water mark |`,
};

async function main() {
  console.log('Inserting SYSAUX growth management runbook...');
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
