import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const runbookPost = {
  title: 'Runbook: Automated SQL Tuning Advisor Monitor for Literal-String Hard-Parse Flooding',
  slug: 'sql-tuning-advisor-auto-monitor-runbook',
  excerpt:
    'A shell script and cron runbook that queries v$sqlarea every 4 hours to detect SQL families causing shared-pool hard-parse flooding due to literal string predicates, automatically runs the SQL Tuning Advisor on each offender, and accepts the resulting force_match SQL Profile — with full logging, alerting, and a dry-run mode.',
  category: 'oracle-database' as const,
  published: true,
  publishedAt: new Date('2026-06-03'),
  isPremium: true,
  youtubeUrl: null,
  content: `This runbook provides a self-contained shell script — \`sql_tune_monitor.sh\` — that detects SQL suffering from literal-string hard-parse flooding, automatically applies a \`force_match\` SQL Profile via the SQL Tuning Advisor, and logs everything it touches. It is designed to run every 4 hours via cron as a background DBA automation layer.

The detection and profile mechanics are described in the companion post: [SQL Tuning Advisor: Using force_match to Fix Literal String Performance Without cursor_sharing](/posts/sql-tuning-advisor-force-match-literal-strings).

---

## How the Script Works

\`\`\`
Every 4 hours:
  1. DETECT  — query v\$sqlarea using DBMS_SQLTUNE.SQLTEXT_TO_SIGNATURE(force_match=>1)
               to group SQL families by their normalised (literal-free) signature.
               Flag families where: variants >= VARIANT_THRESHOLD (default 10)
               AND total parse_calls >= PARSE_THRESHOLD (default 5000)
               AND no force_match SQL Profile already exists.

  2. ANALYSE — for each flagged SQL ID (one representative per family):
               create and execute a DBMS_SQLTUNE tuning task.
               Parse the advisor report for a SQL Profile recommendation.

  3. APPLY   — if the advisor recommends a profile (and --dry-run is NOT set):
               DBMS_SQLTUNE.ACCEPT_SQL_PROFILE with force_match=>TRUE, replace=>TRUE.

  4. REPORT  — write structured log entry; optionally email a summary.
\`\`\`

The key detection query uses \`DBMS_SQLTUNE.SQLTEXT_TO_SIGNATURE(sql_fulltext, 1)\` — the second argument \`1\` activates the same literal-normalisation mode that \`force_match=>TRUE\` uses when matching a profile. This means the detection and the fix use identical normalisation: if the script groups two SQL IDs into the same family, the accepted profile will match both of them.

---

## Prerequisites

\`\`\`bash
# Oracle user running the script needs:
# EXECUTE on DBMS_SQLTUNE
# SELECT on V$SQL, V$SQLAREA, V$SQLTEXT, DBA_SQL_PROFILES, DBA_ADVISOR_TASKS
# CREATE ANY SQL PROFILE (included in DBA role; or grant explicitly)

# Run as SYSDBA to grant if needed:
sqlplus / as sysdba << 'SQLEOF'
GRANT EXECUTE ON DBMS_SQLTUNE      TO monitoring_user;
GRANT SELECT  ON v_\$sqlarea        TO monitoring_user;
GRANT SELECT  ON v_\$sql            TO monitoring_user;
GRANT SELECT  ON v_\$sqltext_with_newlines TO monitoring_user;
GRANT SELECT  ON dba_sql_profiles   TO monitoring_user;
GRANT SELECT  ON dba_advisor_tasks  TO monitoring_user;
GRANT CREATE ANY SQL PROFILE        TO monitoring_user;
SQLEOF
\`\`\`

---

## The Monitor Script

\`\`\`bash
#!/bin/bash
# sql_tune_monitor.sh
# Detect literal-string hard-parse flooding and auto-apply force_match SQL Profiles.
#
# Usage:
#   ./sql_tune_monitor.sh [OPTIONS]
#
# Options:
#   --dry-run              Detect and analyse but do NOT accept profiles
#   --variants  N          Minimum variant count to flag a family (default: 10)
#   --parses    N          Minimum parse_calls sum to flag a family (default: 5000)
#   --elapsed   N          Minimum total elapsed seconds to flag (default: 60)
#   --time-limit N         SQL Tuning Advisor time limit per task in seconds (default: 120)
#   --log-dir   PATH       Directory for log files (default: /var/log/oracle/sql_tuning)
#   --alert-email ADDR     Email address for summary report (optional)
#   --db-connect STR       DB connect string, e.g. ORCLPROD (default: \$ORACLE_SID)
#
# Environment:
#   ORACLE_HOME, ORACLE_SID, DB_PASSWORD or prompted interactively
#   DB_SCHEMA — monitoring user (default: system)

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────
DRY_RUN=false
VARIANT_THRESHOLD=10
PARSE_THRESHOLD=5000
ELAPSED_THRESHOLD=60
ADVISOR_TIME_LIMIT=120
LOG_DIR=/var/log/oracle/sql_tuning
ALERT_EMAIL=""
DB_SCHEMA=\${DB_SCHEMA:-system}
DB_CONNECT=\${ORACLE_SID:-""}

# ── Argument parsing ───────────────────────────────────────────────────────
while [ \$# -gt 0 ]; do
  case "\$1" in
    --dry-run)       DRY_RUN=true ;;
    --variants)      shift; VARIANT_THRESHOLD=\$1 ;;
    --parses)        shift; PARSE_THRESHOLD=\$1 ;;
    --elapsed)       shift; ELAPSED_THRESHOLD=\$1 ;;
    --time-limit)    shift; ADVISOR_TIME_LIMIT=\$1 ;;
    --log-dir)       shift; LOG_DIR=\$1 ;;
    --alert-email)   shift; ALERT_EMAIL=\$1 ;;
    --db-connect)    shift; DB_CONNECT=\$1 ;;
    *) echo "Unknown option: \$1"; exit 1 ;;
  esac
  shift
done

# ── Credentials ────────────────────────────────────────────────────────────
if [ -z "\${DB_PASSWORD:-}" ]; then
  # In cron, store password in a wallet-protected file: chmod 400
  if [ -f "\${HOME}/.oracle_monitor_pass" ]; then
    DB_PASSWORD=\$(cat "\${HOME}/.oracle_monitor_pass")
  else
    read -rsp "Enter DB password for \${DB_SCHEMA}: " DB_PASSWORD; echo
  fi
fi

[ -z "\$DB_CONNECT" ] && { echo "ERROR: Set --db-connect or ORACLE_SID"; exit 1; }

SQLPLUS_CONN="\${DB_SCHEMA}/\${DB_PASSWORD}@\${DB_CONNECT}"

# ── Logging ────────────────────────────────────────────────────────────────
mkdir -p "\$LOG_DIR"
TIMESTAMP=\$(date +%Y%m%d_%H%M%S)
LOG_FILE="\${LOG_DIR}/sql_tune_\${TIMESTAMP}.log"
SUMMARY_FILE="\${LOG_DIR}/sql_tune_\${TIMESTAMP}_summary.txt"

log()   { echo "[\$(date '+%Y-%m-%d %H:%M:%S')] \$1" | tee -a "\$LOG_FILE"; }
warn()  { echo "[\$(date '+%Y-%m-%d %H:%M:%S')] [WARN] \$1" | tee -a "\$LOG_FILE"; }
error() { echo "[\$(date '+%Y-%m-%d %H:%M:%S')] [ERROR] \$1" | tee -a "\$LOG_FILE"; }

# ── Run SQL, return trimmed output ─────────────────────────────────────────
run_sql() {
  sqlplus -s "\$SQLPLUS_CONN" << SQL 2>/dev/null
SET PAGES 0 FEEDBACK OFF HEADING OFF TRIMOUT ON TRIMSPOOL ON LINESIZE 500
\$1
EXIT;
SQL
}

# ── Run SQL block capturing full output ───────────────────────────────────
run_sql_verbose() {
  sqlplus -s "\$SQLPLUS_CONN" << SQL 2>&1
SET PAGES 100 FEEDBACK ON HEADING ON LINESIZE 200 TRIMSPOOL ON
\$1
EXIT;
SQL
}

# ── Counters ───────────────────────────────────────────────────────────────
FAMILIES_DETECTED=0
TASKS_CREATED=0
PROFILES_ACCEPTED=0
PROFILES_SKIPPED=0
ERRORS=0

log "========================================================"
log "  SQL Tuning Monitor — Literal Hard-Parse Detection"
log "  DB        : \$DB_CONNECT"
log "  Schema    : \$DB_SCHEMA"
log "  Dry-run   : \$DRY_RUN"
log "  Thresholds: variants>=\${VARIANT_THRESHOLD} parses>=\${PARSE_THRESHOLD} elapsed>=\${ELAPSED_THRESHOLD}s"
log "========================================================"

# ════════════════════════════════════════════════════════════════════════════
# STEP 1: DETECT — find SQL families with literal flooding
# Uses DBMS_SQLTUNE.SQLTEXT_TO_SIGNATURE(sql_fulltext, 1):
#   second arg = 1 activates force_match normalisation (literals replaced)
#   This groups SQL IDs that would share one force_match profile.
# ════════════════════════════════════════════════════════════════════════════
log ""
log "STEP 1: Detecting literal-string SQL families..."

DETECT_SQL="
WITH sql_families AS (
  SELECT
    DBMS_SQLTUNE.SQLTEXT_TO_SIGNATURE(sql_fulltext, 1)  forced_sig,
    MAX(sql_id)                                          sample_sql_id,
    COUNT(DISTINCT sql_id)                               variant_count,
    SUM(parse_calls)                                     total_parses,
    SUM(executions)                                      total_execs,
    ROUND(SUM(elapsed_time) / 1e6, 1)                   total_elapsed_sec,
    ROUND(SUM(parse_calls) /
      GREATEST(SUM(executions), 1), 3)                  parse_ratio,
    MAX(SUBSTR(sql_text, 1, 120))                        sample_sql_text
  FROM  v\\\$sqlarea
  WHERE executions        > 0
    AND sql_text NOT LIKE '%v\\\$%'
    AND sql_text NOT LIKE '%dba\\_%'
    AND sql_text NOT LIKE '%sql\\_%'
    AND sql_text NOT LIKE '%DBMS_%'
    AND UPPER(sql_text) LIKE 'SELECT%'
  GROUP BY DBMS_SQLTUNE.SQLTEXT_TO_SIGNATURE(sql_fulltext, 1)
)
SELECT forced_sig     || '|' ||
       sample_sql_id  || '|' ||
       variant_count  || '|' ||
       total_parses   || '|' ||
       total_elapsed_sec || '|' ||
       parse_ratio    || '|' ||
       REPLACE(sample_sql_text, CHR(10), ' ')
FROM   sql_families
WHERE  variant_count    >= \${VARIANT_THRESHOLD}
  AND  total_parses     >= \${PARSE_THRESHOLD}
  AND  total_elapsed_sec >= \${ELAPSED_THRESHOLD}
  AND  NOT EXISTS (
         SELECT 1 FROM dba_sql_profiles p
         WHERE  p.force_matching = 'YES'
           AND  p.signature      = forced_sig
           AND  p.status         = 'ENABLED'
       )
ORDER BY total_parses DESC
FETCH FIRST 20 ROWS ONLY;
"

DETECTIONS=\$(run_sql "\$DETECT_SQL" | grep -v "^$" | grep "|" || true)

if [ -z "\$DETECTIONS" ]; then
  log "  No SQL families exceeding thresholds — nothing to tune."
  log ""
  log "  Run summary: DETECTED=0 PROFILES_ACCEPTED=0"
  echo "No literal-flooding SQL found at \$(date)" >> "\$SUMMARY_FILE"
  exit 0
fi

FAMILIES_DETECTED=\$(echo "\$DETECTIONS" | wc -l | tr -d ' ')
log "  Found \${FAMILIES_DETECTED} SQL families exceeding thresholds:"
log ""
log "  \$(printf '%-14s  %-13s  %-9s  %-12s  %-10s  %-8s' 'FORCED_SIG' 'SAMPLE_SQL_ID' 'VARIANTS' 'PARSE_CALLS' 'ELAPSED_S' 'P/E RATIO')"
log "  \$(printf '%.0s-' {1..80})"

echo "\$DETECTIONS" | while IFS='|' read -r fsig sql_id variants parses elapsed pratio stext; do
  log "  \$(printf '%-14s  %-13s  %-9s  %-12s  %-10s  %-8s' \"\${fsig:0:14}\" \"\$sql_id\" \"\$variants\" \"\$parses\" \"\$elapsed\" \"\$pratio\")"
  log "    SQL: \${stext:0:100}..."
done

# ════════════════════════════════════════════════════════════════════════════
# STEP 2 & 3: ANALYSE + APPLY — one tuning task per detected family
# ════════════════════════════════════════════════════════════════════════════
log ""
log "STEP 2+3: Running SQL Tuning Advisor on each family..."

echo "\$DETECTIONS" | while IFS='|' read -r fsig sql_id variants parses elapsed pratio stext; do
  log ""
  log "  ── Processing sql_id=\${sql_id} (variants=\${variants}, parses=\${parses})"

  # Clean task name — Oracle task names max 30 chars, no special chars
  TASK_NAME="AUTOTUNE_\${sql_id}_\${TIMESTAMP:0:8}"
  TASK_NAME=\$(echo "\$TASK_NAME" | tr -dc 'A-Za-z0-9_' | cut -c1-30)

  # ── Check if a task for this SQL ID already ran recently ──────────────
  EXISTING_TASK=\$(run_sql "
SELECT task_name FROM dba_advisor_tasks
WHERE  description LIKE '%\${sql_id}%'
  AND  created > SYSDATE - 1
  AND  status = 'COMPLETED'
FETCH FIRST 1 ROW ONLY;" | tr -d ' \n')

  if [ -n "\$EXISTING_TASK" ]; then
    log "  [SKIP] Completed task already exists for \${sql_id} in last 24h: \$EXISTING_TASK"
    ((PROFILES_SKIPPED++)) || true
    continue
  fi

  # ── Drop any orphaned task with the same name ──────────────────────────
  run_sql "
BEGIN
  DBMS_SQLTUNE.DROP_TUNING_TASK('\${TASK_NAME}');
EXCEPTION WHEN OTHERS THEN NULL;
END;" > /dev/null 2>&1 || true

  # ── Create tuning task ────────────────────────────────────────────────
  log "  Creating tuning task: \$TASK_NAME"
  CREATE_RESULT=\$(run_sql_verbose "
DECLARE
  l_task VARCHAR2(30);
BEGIN
  l_task := DBMS_SQLTUNE.CREATE_TUNING_TASK(
    sql_id      => '\${sql_id}',
    scope       => DBMS_SQLTUNE.SCOPE_COMPREHENSIVE,
    time_limit  => \${ADVISOR_TIME_LIMIT},
    task_name   => '\${TASK_NAME}',
    description => 'Auto-tuning: sql_id=\${sql_id} variants=\${variants} parses=\${parses}'
  );
  DBMS_OUTPUT.PUT_LINE('Task created: ' || l_task);
END;
/" 2>&1)

  if echo "\$CREATE_RESULT" | grep -qi "ORA-\|error"; then
    error "  Failed to create task for \${sql_id}: \$(echo "\$CREATE_RESULT" | grep -i 'ORA-\|error' | head -3)"
    ((ERRORS++)) || true
    continue
  fi
  ((TASKS_CREATED++)) || true

  # ── Execute tuning task ───────────────────────────────────────────────
  log "  Executing task \$TASK_NAME (time limit: \${ADVISOR_TIME_LIMIT}s)..."
  run_sql "EXEC DBMS_SQLTUNE.EXECUTE_TUNING_TASK(task_name => '\${TASK_NAME}');" \
    >> "\$LOG_FILE" 2>&1

  # ── Wait for completion ────────────────────────────────────────────────
  WAIT_SEC=0
  TASK_STATUS=""
  while [ \$WAIT_SEC -lt \$((ADVISOR_TIME_LIMIT + 60)) ]; do
    TASK_STATUS=\$(run_sql "
SELECT status FROM dba_advisor_tasks WHERE task_name='\${TASK_NAME}';" \
      | tr -d ' \n')
    [ "\$TASK_STATUS" = "COMPLETED" ] || [ "\$TASK_STATUS" = "ERROR" ] && break
    sleep 10; WAIT_SEC=\$((WAIT_SEC + 10))
  done

  if [ "\$TASK_STATUS" != "COMPLETED" ]; then
    warn "  Task \$TASK_NAME status=\${TASK_STATUS} — skipping profile acceptance"
    ((ERRORS++)) || true
    continue
  fi

  # ── Check advisor report for SQL Profile recommendation ───────────────
  REPORT=\$(run_sql "SELECT DBMS_SQLTUNE.REPORT_TUNING_TASK('\${TASK_NAME}') FROM dual;" \
    2>/dev/null || true)

  echo "--- Advisor Report for \${sql_id} ---" >> "\$LOG_FILE"
  echo "\$REPORT" >> "\$LOG_FILE"

  PROFILE_RECOMMENDED=false
  if echo "\$REPORT" | grep -qi "SQL Profile\|sql profile"; then
    if echo "\$REPORT" | grep -qi "Recommendation\|potentially better\|benefit"; then
      PROFILE_RECOMMENDED=true
    fi
  fi

  if ! \$PROFILE_RECOMMENDED; then
    log "  [INFO] Advisor did not recommend a SQL Profile for \${sql_id}"
    log "         (may indicate the plan is already optimal; literal flooding still present)"
    # Still create a force_match profile to address the literal flooding directly
    # The profile may not improve the plan but WILL reduce hard parses
    log "         Creating force_match profile for parse-reduction even without plan change..."
    PROFILE_RECOMMENDED=true   # override: literal flooding is sufficient justification
  fi

  if \$PROFILE_RECOMMENDED; then
    PROFILE_NAME="AUTOPROF_\${sql_id}"
    PROFILE_NAME=\$(echo "\$PROFILE_NAME" | cut -c1-30)

    if \$DRY_RUN; then
      log "  [DRY-RUN] Would accept SQL Profile '\$PROFILE_NAME' with force_match=>TRUE"
      ((PROFILES_SKIPPED++)) || true
    else
      log "  Accepting SQL Profile '\$PROFILE_NAME' (force_match=>TRUE, replace=>TRUE)..."
      ACCEPT_RESULT=\$(run_sql_verbose "
BEGIN
  DBMS_SQLTUNE.ACCEPT_SQL_PROFILE(
    task_name   => '\${TASK_NAME}',
    task_owner  => '\${DB_SCHEMA}',
    name        => '\${PROFILE_NAME}',
    description => 'Auto: sql_id=\${sql_id} \${TIMESTAMP} variants=\${variants} parses=\${parses}',
    category    => 'DEFAULT',
    force_match => TRUE,
    replace     => TRUE
  );
  DBMS_OUTPUT.PUT_LINE('Profile accepted: \${PROFILE_NAME}');
END;
/" 2>&1)

      if echo "\$ACCEPT_RESULT" | grep -qi "accepted\|Profile accepted"; then
        log "  [OK] Profile '\$PROFILE_NAME' accepted — force_match active for all variants"
        ((PROFILES_ACCEPTED++)) || true

        # Verify profile is visible in DBA_SQL_PROFILES
        VERIFY=\$(run_sql "
SELECT name || ' status=' || status || ' force_match=' || force_matching
FROM   dba_sql_profiles
WHERE  name = '\${PROFILE_NAME}';" | tr -d ' \n')
        log "  Verified: \$VERIFY"

      elif echo "\$ACCEPT_RESULT" | grep -qi "ORA-\|error"; then
        error "  Profile acceptance failed for \${sql_id}:"
        error "  \$(echo "\$ACCEPT_RESULT" | grep -iE 'ORA-|error' | head -3)"
        ((ERRORS++)) || true
      fi
    fi
  fi
done

# ════════════════════════════════════════════════════════════════════════════
# STEP 4: SUMMARY REPORT
# ════════════════════════════════════════════════════════════════════════════
log ""
log "========================================================"
log "  Run Complete — \$(date '+%Y-%m-%d %H:%M:%S')"
log "  Families detected  : \$FAMILIES_DETECTED"
log "  Tasks created      : \$TASKS_CREATED"
log "  Profiles accepted  : \$PROFILES_ACCEPTED"
log "  Profiles skipped   : \$PROFILES_SKIPPED"
log "  Errors             : \$ERRORS"
log "  Log file           : \$LOG_FILE"
log "========================================================"

# Write summary
cat > "\$SUMMARY_FILE" << SUMMARY
Oracle SQL Tuning Monitor — Run Summary
Generated : \$(date '+%Y-%m-%d %H:%M:%S')
Database  : \$DB_CONNECT
Dry-run   : \$DRY_RUN

Results
-------
SQL families detected   : \$FAMILIES_DETECTED
Tuning tasks created    : \$TASKS_CREATED
force_match profiles accepted: \$PROFILES_ACCEPTED
Profiles skipped        : \$PROFILES_SKIPPED
Errors                  : \$ERRORS

Thresholds Used
---------------
Variant count  >= \$VARIANT_THRESHOLD
Parse calls    >= \$PARSE_THRESHOLD
Elapsed time   >= \${ELAPSED_THRESHOLD}s

Full log: \$LOG_FILE
SUMMARY

# Optional email alert
if [ -n "\$ALERT_EMAIL" ] && [ "\$PROFILES_ACCEPTED" -gt 0 -o "\$ERRORS" -gt 0 ]; then
  if command -v mailx &>/dev/null; then
    mailx -s "[SQL Tuning Monitor] \${DB_CONNECT}: \${PROFILES_ACCEPTED} profiles applied, \${ERRORS} errors" \
      "\$ALERT_EMAIL" < "\$SUMMARY_FILE"
    log "  Summary emailed to \$ALERT_EMAIL"
  fi
fi

# Exit non-zero if errors occurred so cron can detect failures
[ "\$ERRORS" -gt 0 ] && exit 2 || exit 0
\`\`\`

---

## Script 2: Standalone Detection Query (SQL*Plus)

Run this interactively at any time to see what the monitor would flag, without executing any tuning tasks.

\`\`\`sql
-- sql_literal_detection.sql
-- Run in SQL*Plus to identify literal-flooding SQL families
-- No changes are made

SET LINES 200 PAGES 100 FEEDBACK OFF
COLUMN sample_sql_id   FORMAT A14
COLUMN variants        FORMAT 9999     HEADING "VAR"
COLUMN total_parses    FORMAT 9,999,999 HEADING "PARSE_CALLS"
COLUMN total_elapsed   FORMAT 99,999   HEADING "ELAPSED_S"
COLUMN parse_ratio     FORMAT 9.999    HEADING "P/E"
COLUMN profile_exists  FORMAT A7       HEADING "PROFILED"
COLUMN sample_text     FORMAT A80      HEADING "SQL TEXT (truncated)"

SELECT
  s.sample_sql_id,
  s.variants,
  s.total_parses,
  s.total_elapsed_sec    total_elapsed,
  s.parse_ratio,
  NVL2(p.name, 'YES', 'NO')  profile_exists,
  SUBSTR(s.sample_sql_text, 1, 80)  sample_text
FROM (
  SELECT
    DBMS_SQLTUNE.SQLTEXT_TO_SIGNATURE(sql_fulltext, 1)  forced_sig,
    MAX(sql_id)                                          sample_sql_id,
    COUNT(DISTINCT sql_id)                               variants,
    SUM(parse_calls)                                     total_parses,
    ROUND(SUM(elapsed_time) / 1e6, 1)                   total_elapsed_sec,
    ROUND(SUM(parse_calls) /
      GREATEST(SUM(executions), 1), 3)                  parse_ratio,
    MAX(SUBSTR(sql_text, 1, 120))                        sample_sql_text
  FROM  v\$sqlarea
  WHERE executions   > 0
    AND sql_text NOT LIKE '%v\$%'
    AND sql_text NOT LIKE '%dba\\_%'
    AND sql_text NOT LIKE '%DBMS_%'
    AND UPPER(sql_text) LIKE 'SELECT%'
  GROUP BY DBMS_SQLTUNE.SQLTEXT_TO_SIGNATURE(sql_fulltext, 1)
  HAVING COUNT(DISTINCT sql_id) >= 5
    AND  SUM(parse_calls) >= 1000
) s
LEFT JOIN dba_sql_profiles p
  ON  p.signature     = DBMS_SQLTUNE.SQLTEXT_TO_SIGNATURE(
        (SELECT sql_fulltext FROM v\$sqlarea WHERE sql_id = s.sample_sql_id
         FETCH FIRST 1 ROW ONLY), 1)
  AND p.force_matching = 'YES'
  AND p.status         = 'ENABLED'
ORDER BY s.total_parses DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

---

## Script 3: Validate Active Profiles (SQL*Plus)

Run after the monitor has applied profiles to confirm they are in use.

\`\`\`sql
-- sql_profile_validation.sql
-- Shows all active force_match profiles and their usage in v\$sqlarea

SET LINES 200 PAGES 50

COLUMN profile_name   FORMAT A32    HEADING "PROFILE NAME"
COLUMN force_matching FORMAT A5     HEADING "FORCE"
COLUMN status         FORMAT A8     HEADING "STATUS"
COLUMN created        FORMAT A18    HEADING "CREATED"
COLUMN executions     FORMAT 9,999,999 HEADING "EXECUTIONS"
COLUMN sql_profile_ref FORMAT A32   HEADING "SQL_ID USING PROFILE"

-- All auto-created force_match profiles
SELECT p.name            profile_name,
       p.force_matching,
       p.status,
       TO_CHAR(p.created, 'YYYY-MM-DD HH24:MI')  created,
       p.description
FROM   dba_sql_profiles p
WHERE  p.name LIKE 'AUTOPROF_%'
  AND  p.status = 'ENABLED'
ORDER BY p.created DESC;

-- SQL IDs currently using these profiles (confirms match is working)
SELECT sql_id,
       sql_profile,
       version_count,
       parse_calls,
       executions,
       ROUND(elapsed_time / 1e6, 2) elapsed_sec,
       ROUND(buffer_gets / GREATEST(executions,1)) bgets_per_exec
FROM   v\$sqlarea
WHERE  sql_profile LIKE 'AUTOPROF_%'
ORDER BY parse_calls DESC;
\`\`\`

---

## Script 4: Drop a Profile (Emergency Rollback)

\`\`\`sql
-- Drop a specific auto-tuning profile (immediate rollback, no restart needed)
BEGIN
  DBMS_SQLTUNE.DROP_SQL_PROFILE(name => 'AUTOPROF_<sql_id>');
  DBMS_OUTPUT.PUT_LINE('Profile dropped — cursor sharing reverted to normal.');
END;
/

-- Drop ALL auto-tuning profiles (full rollback)
BEGIN
  FOR p IN (SELECT name FROM dba_sql_profiles WHERE name LIKE 'AUTOPROF_%') LOOP
    DBMS_SQLTUNE.DROP_SQL_PROFILE(name => p.name);
    DBMS_OUTPUT.PUT_LINE('Dropped: ' || p.name);
  END LOOP;
END;
/
\`\`\`

---

## Cron Schedule and Deployment

\`\`\`bash
# Install the script
mkdir -p /opt/oracle/scripts/sql_tuning
cp sql_tune_monitor.sh /opt/oracle/scripts/sql_tuning/
chmod 750 /opt/oracle/scripts/sql_tuning/sql_tune_monitor.sh
chown oracle:oinstall /opt/oracle/scripts/sql_tuning/sql_tune_monitor.sh

# Store DB password (chmod 400 so only oracle can read)
echo "YourMonitorPassword" > /home/oracle/.oracle_monitor_pass
chmod 400 /home/oracle/.oracle_monitor_pass

# /etc/cron.d/oracle_sql_tuning — run every 4 hours
0 */4 * * * oracle \
  ORACLE_HOME=/u01/app/oracle/product/19.3.0/dbhome_1 \
  ORACLE_SID=ORCLPROD \
  PATH=\$ORACLE_HOME/bin:/usr/bin:/bin \
  LD_LIBRARY_PATH=\$ORACLE_HOME/lib \
  DB_SCHEMA=monitoring_user \
  /opt/oracle/scripts/sql_tuning/sql_tune_monitor.sh \
    --db-connect ORCLPROD \
    --variants 10 \
    --parses 5000 \
    --elapsed 60 \
    --time-limit 120 \
    --log-dir /var/log/oracle/sql_tuning \
    --alert-email dba-team@example.com \
    >> /var/log/oracle/sql_tuning/cron.log 2>&1

# First run: dry-run to validate detection before enabling auto-accept
/opt/oracle/scripts/sql_tuning/sql_tune_monitor.sh --dry-run --db-connect ORCLPROD
\`\`\`

---

## Log Rotation

\`\`\`bash
# /etc/logrotate.d/oracle-sql-tuning
/var/log/oracle/sql_tuning/*.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    create 640 oracle oinstall
}
\`\`\`

---

## Tuning the Thresholds

| Parameter | Conservative | Typical Production | Aggressive |
|---|---|---|---|
| \`--variants\` | 20 | 10 | 5 |
| \`--parses\` | 20000 | 5000 | 1000 |
| \`--elapsed\` | 300 | 60 | 10 |
| \`--time-limit\` | 300 | 120 | 60 |

Start with conservative thresholds on a new deployment to avoid creating profiles for short-lived SQL or batch jobs that naturally produce many similar statements. Review the detection log for two or three runs before enabling auto-accept.

The \`--dry-run\` flag on the first few runs is strongly recommended on production systems — it logs everything the script would do without accepting any profiles.

---

## What the Script Does NOT Cover

- **DML statements** — The detection query filters to \`SELECT\` only. INSERT/UPDATE/DELETE literal flooding is less common but can be added by removing the \`UPPER(sql_text) LIKE 'SELECT%'\` filter.
- **Cross-instance RAC** — The script queries \`V\$SQLAREA\` (the current instance). On RAC, run the script on each instance, or query \`GV\$SQLAREA\` and deduplicate by \`DBMS_SQLTUNE.SQLTEXT_TO_SIGNATURE\`.
- **AWR-based detection** — The script looks at the current shared pool only. For detecting literals that were a problem in a previous AWR window, replace \`V\$SQLAREA\` with \`DBA_HIST_SQLSTAT\` joined to \`DBA_HIST_SQLTEXT\`.
- **Non-Oracle databases** — GoldenGate and EBS workloads on non-Oracle targets have their own cursor-sharing equivalents; this script is Oracle DB specific.
`,
};

async function main() {
  await db
    .insert(posts)
    .values({
      title: runbookPost.title,
      slug: runbookPost.slug,
      excerpt: runbookPost.excerpt,
      content: runbookPost.content,
      category: runbookPost.category,
      youtubeUrl: runbookPost.youtubeUrl,
      isPremium: runbookPost.isPremium,
      published: runbookPost.published,
      publishedAt: runbookPost.publishedAt,
    })
    .onConflictDoUpdate({
      target: posts.slug,
      set: {
        title: runbookPost.title,
        excerpt: runbookPost.excerpt,
        content: runbookPost.content,
        isPremium: runbookPost.isPremium,
        published: runbookPost.published,
        publishedAt: runbookPost.publishedAt,
      },
    });
  console.log('inserted:', runbookPost.slug);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
