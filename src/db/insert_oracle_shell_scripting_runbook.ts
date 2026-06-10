import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle DBA Shell Script Library',
  slug: 'oracle-dba-shell-script-library-runbook',
  excerpt:
    'A complete library of production-ready Oracle DBA shell scripts — health checks, tablespace monitoring, session management, RMAN backup verification, AWR/statspack snapshots, user auditing, object recompilation, and a cron deployment guide. Each script is self-contained, uses OS authentication, and follows the exit code and logging conventions required for Nagios/OEM integration.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-11'),
  youtubeUrl: null,
  content: `## Setup: Script Directory and Environment Files

### Directory Structure

\`\`\`bash
mkdir -p /home/oracle/scripts/{lib,logs,env}
chmod 750 /home/oracle/scripts

# Directory layout:
# /home/oracle/scripts/
# ├── lib/           — shared functions (sourced by all scripts)
# ├── logs/          — log output from all scripts
# ├── env/           — per-database environment files
# └── *.sh           — individual DBA scripts
\`\`\`

### Environment File Template

Create one file per database: \`/home/oracle/scripts/env/PRODDB.env\`

\`\`\`bash
export ORACLE_BASE=/u01/oracle
export ORACLE_HOME=\${ORACLE_BASE}/product/19.3.0/dbhome_1
export ORACLE_SID=PRODDB
export PATH=\${ORACLE_HOME}/bin:/usr/local/bin:\${PATH}
export LD_LIBRARY_PATH=\${ORACLE_HOME}/lib:\${LD_LIBRARY_PATH}
export NLS_DATE_FORMAT='YYYY-MM-DD HH24:MI:SS'
export TNS_ADMIN=\${ORACLE_HOME}/network/admin
\`\`\`

### Shared Library: /home/oracle/scripts/lib/oracle_common.sh

\`\`\`bash
#!/bin/bash
# Shared functions sourced by all Oracle DBA scripts

LOG_DIR="/home/oracle/scripts/logs"
RETAIN_DAYS=30

setup_logging() {
    local script_name="\$1"
    mkdir -p "\$LOG_DIR"
    LOG_FILE="\${LOG_DIR}/\${script_name}_\$(date +%Y%m%d_%H%M%S).log"
    exec > >(tee -a "\$LOG_FILE") 2>&1
    find "\$LOG_DIR" -name "\${script_name}_*.log" -mtime +\${RETAIN_DAYS} -delete 2>/dev/null
}

log() {
    local level="\${1:-INFO}"
    local msg="\$2"
    echo "\$(date '+%Y-%m-%d %H:%M:%S') [\$level] \$msg"
}

load_env() {
    local sid="\${1:-\$ORACLE_SID}"
    local env_file="/home/oracle/scripts/env/\${sid}.env"
    if [[ ! -f "\$env_file" ]]; then
        echo "ERROR: Environment file not found: \$env_file" >&2
        exit 1
    fi
    source "\$env_file"
}

acquire_lock() {
    LOCK_FILE="/tmp/\$(basename \$0 .sh).lock"
    if ! mkdir "\$LOCK_FILE" 2>/dev/null; then
        log WARN "Already running — lock exists: \$LOCK_FILE"
        exit 0
    fi
    trap "rmdir '\$LOCK_FILE' 2>/dev/null" EXIT
}

run_sql() {
    # run_sql <sql_block> — returns output, exits non-zero on SQL error
    sqlplus -s / as sysdba 2>&1 <<EOF
WHENEVER SQLERROR EXIT SQL.SQLCODE
WHENEVER OSERROR  EXIT FAILURE
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON LINESIZE 500
\$1
EXIT 0;
EOF
}
\`\`\`

---

## Script 1: Database Health Check

\`\`\`bash
#!/bin/bash
# /home/oracle/scripts/db_health_check.sh
# Usage: ./db_health_check.sh [SID]
# Exit codes: 0=OK, 1=WARNING, 2=CRITICAL

source /home/oracle/scripts/lib/oracle_common.sh
load_env "\${1:-\$ORACLE_SID}"
setup_logging "db_health_check"
acquire_lock

EXIT_CODE=0

log INFO "Starting health check for \$ORACLE_SID on \$(hostname)"

# --- 1. Instance status ---
STATUS=\$(sqlplus -s / as sysdba <<'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON
SELECT status FROM v\$instance;
EXIT 0;
EOF
)
STATUS="\$(echo "\$STATUS" | tr -d '[:space:]')"

if [[ "\$STATUS" != "OPEN" ]]; then
    log CRITICAL "Instance is not OPEN — status: \$STATUS"
    exit 2
fi
log INFO "Instance status: \$STATUS"

# --- 2. Tablespace usage ---
log INFO "Checking tablespace usage..."
TS_OUTPUT=\$(sqlplus -s / as sysdba <<'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON LINESIZE 300
SELECT tablespace_name || '|' || ROUND(used_percent, 1)
FROM   dba_tablespace_usage_metrics
WHERE  contents != 'TEMPORARY'
ORDER BY used_percent DESC;
EXIT 0;
EOF
)

while IFS='|' read -r ts pct; do
    [[ -z "\$ts" ]] && continue
    pct_int=\$(echo "\$pct" | cut -d. -f1)
    if   [[ \$pct_int -ge 90 ]]; then log CRITICAL "Tablespace \$ts is \${pct}% full"; EXIT_CODE=2
    elif [[ \$pct_int -ge 80 ]]; then log WARN    "Tablespace \$ts is \${pct}% full"; [[ \$EXIT_CODE -lt 2 ]] && EXIT_CODE=1
    else                               log INFO    "Tablespace \$ts is \${pct}% full"
    fi
done <<< "\$TS_OUTPUT"

# --- 3. Archive log destination ---
log INFO "Checking archive log space..."
ARCH_PCT=\$(sqlplus -s / as sysdba <<'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON
SELECT ROUND(space_used / space_limit * 100, 1)
FROM   v\$recovery_file_dest
WHERE  rownum = 1;
EXIT 0;
EOF
)
ARCH_PCT="\$(echo "\$ARCH_PCT" | tr -d '[:space:]')"

if [[ -n "\$ARCH_PCT" ]]; then
    arch_int=\$(echo "\$ARCH_PCT" | cut -d. -f1)
    if   [[ \$arch_int -ge 85 ]]; then log CRITICAL "FRA is \${ARCH_PCT}% full"; EXIT_CODE=2
    elif [[ \$arch_int -ge 70 ]]; then log WARN    "FRA is \${ARCH_PCT}% full"; [[ \$EXIT_CODE -lt 2 ]] && EXIT_CODE=1
    else                               log INFO    "FRA usage: \${ARCH_PCT}%"
    fi
fi

# --- 4. Invalid objects ---
INVALID_COUNT=\$(sqlplus -s / as sysdba <<'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON
SELECT COUNT(*) FROM dba_objects WHERE status = 'INVALID' AND object_type != 'SYNONYM';
EXIT 0;
EOF
)
INVALID_COUNT="\$(echo "\$INVALID_COUNT" | tr -d '[:space:]')"

if [[ "\$INVALID_COUNT" -gt 0 ]]; then
    log WARN "\$INVALID_COUNT invalid objects found"
    [[ \$EXIT_CODE -lt 1 ]] && EXIT_CODE=1
else
    log INFO "No invalid objects"
fi

# --- 5. Last RMAN backup ---
LAST_BACKUP=\$(sqlplus -s / as sysdba <<'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON
SELECT ROUND((SYSDATE - MAX(completion_time)) * 24, 1)
FROM   v\$backup_set
WHERE  backup_type IN ('D', 'I');
EXIT 0;
EOF
)
LAST_BACKUP="\$(echo "\$LAST_BACKUP" | tr -d '[:space:]')"

if [[ -n "\$LAST_BACKUP" ]]; then
    hours_int=\$(echo "\$LAST_BACKUP" | cut -d. -f1)
    if   [[ \$hours_int -ge 48 ]]; then log CRITICAL "Last backup was \${LAST_BACKUP} hours ago"; EXIT_CODE=2
    elif [[ \$hours_int -ge 26 ]]; then log WARN    "Last backup was \${LAST_BACKUP} hours ago"; [[ \$EXIT_CODE -lt 2 ]] && EXIT_CODE=1
    else                               log INFO    "Last backup: \${LAST_BACKUP} hours ago"
    fi
else
    log WARN "No backup records found in v\$backup_set"
    [[ \$EXIT_CODE -lt 1 ]] && EXIT_CODE=1
fi

log INFO "Health check complete. Exit code: \$EXIT_CODE"
exit \$EXIT_CODE
\`\`\`

---

## Script 2: Alert Log Error Monitor

\`\`\`bash
#!/bin/bash
# /home/oracle/scripts/scan_alert_log.sh
# Usage: ./scan_alert_log.sh [SID] [lines_to_scan]
# Scans the alert log for ORA- errors not seen in the previous run

source /home/oracle/scripts/lib/oracle_common.sh
load_env "\${1:-\$ORACLE_SID}"

LINES="\${2:-1000}"
STATE_FILE="/tmp/alert_scan_\${ORACLE_SID}.pos"
EMAIL="dba-alerts@corp.local"

# Get alert log path
DIAG_DEST=\$(sqlplus -s / as sysdba <<'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON
SELECT value FROM v\$parameter WHERE name = 'diagnostic_dest';
EXIT 0;
EOF
)
DIAG_DEST="\$(echo "\$DIAG_DEST" | tr -d '[:space:]')"
ALERT_LOG="\${DIAG_DEST}/diag/rdbms/\${ORACLE_SID,,}/\${ORACLE_SID}/trace/alert_\${ORACLE_SID}.log"

if [[ ! -f "\$ALERT_LOG" ]]; then
    echo "ERROR: Alert log not found: \$ALERT_LOG" >&2
    exit 1
fi

# Track file size to avoid re-scanning
CURRENT_SIZE=\$(wc -c < "\$ALERT_LOG")
LAST_SIZE=\$(cat "\$STATE_FILE" 2>/dev/null || echo 0)

if [[ \$CURRENT_SIZE -le \$LAST_SIZE ]]; then
    echo "No new content in alert log since last scan"
    exit 0
fi

# Scan new content for ORA- errors (skip known non-critical ones)
NEW_ERRORS=\$(tail -c "\$((CURRENT_SIZE - LAST_SIZE))" "\$ALERT_LOG" \
    | grep "ORA-" \
    | grep -v "ORA-00020\|ORA-00060\|ORA-01013\|ORA-12012\|ORA-06512" \
    | sort -u)

echo "\$CURRENT_SIZE" > "\$STATE_FILE"

if [[ -n "\$NEW_ERRORS" ]]; then
    MSG="ORA- errors detected in \$ORACLE_SID alert log:\n\$NEW_ERRORS"
    echo -e "\$MSG"
    echo -e "\$MSG" | mail -s "ALERT: ORA- errors in \$ORACLE_SID" "\$EMAIL"
    exit 2
fi

echo "No new ORA- errors in alert log"
exit 0
\`\`\`

---

## Script 3: Session Report and Long-Session Killer

\`\`\`bash
#!/bin/bash
# /home/oracle/scripts/session_manager.sh
# Usage: ./session_manager.sh [SID] [--kill-long <minutes>]

source /home/oracle/scripts/lib/oracle_common.sh
load_env "\${1:-\$ORACLE_SID}"
setup_logging "session_manager"

KILL_LONG=0
THRESHOLD_MINS=120

while [[ \$# -gt 0 ]]; do
    case "\$1" in
        --kill-long) KILL_LONG=1; THRESHOLD_MINS="\$2"; shift 2 ;;
        *) shift ;;
    esac
done

log INFO "Session report for \$ORACLE_SID"

# --- Session summary by status ---
sqlplus -s / as sysdba <<'EOF'
SET PAGESIZE 100 FEEDBACK OFF LINESIZE 120
SET HEADING ON

SELECT   status, COUNT(*) AS session_count
FROM     v\$session
WHERE    type = 'USER'
GROUP BY status
ORDER BY status;

EXIT 0;
EOF

# --- Top 10 sessions by logical reads ---
log INFO "Top 10 sessions by logical reads:"
sqlplus -s / as sysdba <<'EOF'
SET PAGESIZE 20 FEEDBACK OFF LINESIZE 150
COLUMN username   FORMAT A20
COLUMN program    FORMAT A25
COLUMN sql_text   FORMAT A50
COLUMN logical_reads FORMAT 999,999,999

SELECT s.username,
       s.program,
       ROUND(sn.value / 1024 / 1024, 1) AS logical_reads_mb,
       SUBSTR(q.sql_text, 1, 50)         AS sql_text
FROM   v\$session  s
JOIN   v\$sesstat  sn ON s.sid = sn.sid
LEFT JOIN v\$sql   q  ON s.sql_id = q.sql_id
WHERE  sn.statistic# = (
           SELECT statistic# FROM v\$statname
           WHERE name = 'session logical reads'
       )
  AND  s.username IS NOT NULL
ORDER BY sn.value DESC
FETCH FIRST 10 ROWS ONLY;

EXIT 0;
EOF

# --- Kill long-running sessions if requested ---
if [[ \$KILL_LONG -eq 1 ]]; then
    log INFO "Identifying sessions running > \${THRESHOLD_MINS} minutes..."

    KILL_LIST=\$(sqlplus -s / as sysdba <<EOF
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON
SELECT s.sid || ',' || s.serial#
FROM   v\\\$session s
WHERE  s.username IS NOT NULL
  AND  s.type = 'USER'
  AND  s.status = 'ACTIVE'
  AND  (SYSDATE - s.logon_time) * 24 * 60 > \${THRESHOLD_MINS}
  AND  s.username NOT IN ('SYS','SYSTEM','DBSNMP');
EXIT 0;
EOF
)

    if [[ -z "\$KILL_LIST" ]]; then
        log INFO "No sessions to kill"
    else
        while IFS=',' read -r sid serial; do
            [[ -z "\$sid" ]] && continue
            log WARN "Killing session SID=\$sid SERIAL#=\$serial"
            sqlplus -s / as sysdba <<EOF > /dev/null
ALTER SYSTEM KILL SESSION '\${sid},\${serial}' IMMEDIATE;
EXIT 0;
EOF
        done <<< "\$KILL_LIST"
    fi
fi
\`\`\`

---

## Script 4: RMAN Backup Verification

\`\`\`bash
#!/bin/bash
# /home/oracle/scripts/verify_rman_backup.sh
# Checks last backup status and sends report

source /home/oracle/scripts/lib/oracle_common.sh
load_env "\${1:-\$ORACLE_SID}"
setup_logging "verify_rman_backup"

log INFO "RMAN backup verification for \$ORACLE_SID"

rman target / <<'EOF'
LIST BACKUP SUMMARY COMPLETED AFTER 'SYSDATE-2';
LIST EXPIRED BACKUP;
CROSSCHECK BACKUP;
EXIT;
EOF

# Check for FAILED or EXPIRED entries in recent backup catalog
FAILURES=\$(sqlplus -s / as sysdba <<'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON
SELECT COUNT(*)
FROM   v\$rman_backup_job_details
WHERE  status IN ('FAILED', 'FAILED WITH WARNINGS')
  AND  start_time > SYSDATE - 2;
EXIT 0;
EOF
)
FAILURES="\$(echo "\$FAILURES" | tr -d '[:space:]')"

if [[ "\$FAILURES" -gt 0 ]]; then
    log CRITICAL "\$FAILURES RMAN backup job(s) FAILED in the last 48 hours"
    exit 2
fi

# Confirm a full backup exists within 24 hours
LAST_FULL_HRS=\$(sqlplus -s / as sysdba <<'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON
SELECT ROUND((SYSDATE - MAX(completion_time)) * 24, 1)
FROM   v\$backup_set
WHERE  backup_type = 'D'
  AND  incremental_level = 0;
EXIT 0;
EOF
)
LAST_FULL_HRS="\$(echo "\$LAST_FULL_HRS" | tr -d '[:space:]')"

if [[ -z "\$LAST_FULL_HRS" ]]; then
    log CRITICAL "No full backup found in v\$backup_set"
    exit 2
fi

hrs_int=\$(echo "\$LAST_FULL_HRS" | cut -d. -f1)
if [[ \$hrs_int -ge 24 ]]; then
    log WARN "Last full backup was \${LAST_FULL_HRS} hours ago"
    exit 1
fi

log INFO "Last full backup: \${LAST_FULL_HRS} hours ago — OK"
exit 0
\`\`\`

---

## Script 5: AWR Snapshot and Report Generator

\`\`\`bash
#!/bin/bash
# /home/oracle/scripts/awr_report.sh
# Takes an AWR snapshot and optionally generates an HTML report
# Usage: ./awr_report.sh [SID] [--report <begin_snap> <end_snap>]

source /home/oracle/scripts/lib/oracle_common.sh
load_env "\${1:-\$ORACLE_SID}"
setup_logging "awr_report"

REPORT_DIR="/home/oracle/awr_reports"
mkdir -p "\$REPORT_DIR"

GENERATE_REPORT=0
BEGIN_SNAP=""
END_SNAP=""

while [[ \$# -gt 0 ]]; do
    case "\$1" in
        --report) GENERATE_REPORT=1; BEGIN_SNAP="\$2"; END_SNAP="\$3"; shift 3 ;;
        *) shift ;;
    esac
done

# --- Take an AWR snapshot ---
NEW_SNAP=\$(sqlplus -s / as sysdba <<'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON
SELECT DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT() FROM dual;
EXIT 0;
EOF
)
NEW_SNAP="\$(echo "\$NEW_SNAP" | tr -d '[:space:]')"
log INFO "Created AWR snapshot: \$NEW_SNAP"

# --- Generate report if requested ---
if [[ \$GENERATE_REPORT -eq 1 && -n "\$BEGIN_SNAP" && -n "\$END_SNAP" ]]; then
    DBID=\$(sqlplus -s / as sysdba <<'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON
SELECT dbid FROM v\$database;
EXIT 0;
EOF
)
    DBID="\$(echo "\$DBID" | tr -d '[:space:]')"

    INST_NUM=\$(sqlplus -s / as sysdba <<'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON
SELECT instance_number FROM v\$instance;
EXIT 0;
EOF
)
    INST_NUM="\$(echo "\$INST_NUM" | tr -d '[:space:]')"

    REPORT_FILE="\${REPORT_DIR}/awr_\${ORACLE_SID}_\${BEGIN_SNAP}_\${END_SNAP}_\$(date +%Y%m%d).html"
    log INFO "Generating AWR report: snap \$BEGIN_SNAP → \$END_SNAP"

    sqlplus -s / as sysdba <<EOF > "\$REPORT_FILE"
SET PAGESIZE 50000 LINESIZE 1500 FEEDBACK OFF HEADING OFF TRIMSPOOL ON MARKUP HTML ON
SELECT * FROM TABLE(
    DBMS_WORKLOAD_REPOSITORY.AWR_REPORT_HTML(
        l_dbid       => \${DBID},
        l_inst_num   => \${INST_NUM},
        l_bid        => \${BEGIN_SNAP},
        l_eid        => \${END_SNAP}
    )
);
EXIT 0;
EOF

    log INFO "AWR report written to: \$REPORT_FILE"
fi
\`\`\`

---

## Script 6: Schema Object Recompilation

\`\`\`bash
#!/bin/bash
# /home/oracle/scripts/recompile_invalid.sh
# Recompiles all invalid objects and reports remaining invalids
# Usage: ./recompile_invalid.sh [SID] [schema_name]

source /home/oracle/scripts/lib/oracle_common.sh
load_env "\${1:-\$ORACLE_SID}"
setup_logging "recompile_invalid"

SCHEMA="\${2:-ALL}"

log INFO "Recompiling invalid objects in \$ORACLE_SID (schema: \$SCHEMA)"

# Count before
BEFORE=\$(sqlplus -s / as sysdba <<EOF
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON
SELECT COUNT(*) FROM dba_objects
WHERE  status = 'INVALID'
  AND  object_type != 'SYNONYM'
  AND  ('\$SCHEMA' = 'ALL' OR owner = UPPER('\$SCHEMA'));
EXIT 0;
EOF
)
BEFORE="\$(echo "\$BEFORE" | tr -d '[:space:]')"
log INFO "Invalid objects before recompile: \$BEFORE"

if [[ "\$BEFORE" -eq 0 ]]; then
    log INFO "No invalid objects — nothing to do"
    exit 0
fi

# Recompile using UTL_RECOMP
sqlplus -s / as sysdba <<EOF
WHENEVER SQLERROR EXIT SQL.SQLCODE
SET SERVEROUTPUT ON SIZE 1000000
BEGIN
    IF '\$SCHEMA' = 'ALL' THEN
        UTL_RECOMP.RECOMP_PARALLEL(threads => 4);
    ELSE
        UTL_RECOMP.RECOMP_SERIAL(schema => UPPER('\$SCHEMA'));
    END IF;
END;
/
EXIT 0;
EOF

RC=\$?
if [[ \$RC -ne 0 ]]; then
    log CRITICAL "UTL_RECOMP failed with exit code \$RC"
    exit \$RC
fi

# Count after
AFTER=\$(sqlplus -s / as sysdba <<EOF
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON
SELECT COUNT(*) FROM dba_objects
WHERE  status = 'INVALID'
  AND  object_type != 'SYNONYM'
  AND  ('\$SCHEMA' = 'ALL' OR owner = UPPER('\$SCHEMA'));
EXIT 0;
EOF
)
AFTER="\$(echo "\$AFTER" | tr -d '[:space:]')"
log INFO "Invalid objects after recompile: \$AFTER"

if [[ "\$AFTER" -gt 0 ]]; then
    log WARN "\$AFTER objects could not be recompiled:"
    sqlplus -s / as sysdba <<EOF
SET PAGESIZE 50 LINESIZE 100 FEEDBACK OFF
COLUMN owner        FORMAT A20
COLUMN object_name  FORMAT A40
COLUMN object_type  FORMAT A20

SELECT owner, object_name, object_type
FROM   dba_objects
WHERE  status = 'INVALID'
  AND  object_type != 'SYNONYM'
  AND  ('\$SCHEMA' = 'ALL' OR owner = UPPER('\$SCHEMA'))
ORDER BY owner, object_type, object_name;

EXIT 0;
EOF
    exit 1
fi

log INFO "All objects recompiled successfully"
exit 0
\`\`\`

---

## Script 7: User Audit Report

\`\`\`bash
#!/bin/bash
# /home/oracle/scripts/user_audit_report.sh
# Reports on user accounts: locked, expired, default passwords, excessive privileges

source /home/oracle/scripts/lib/oracle_common.sh
load_env "\${1:-\$ORACLE_SID}"
setup_logging "user_audit_report"

REPORT_FILE="/home/oracle/scripts/logs/user_audit_\${ORACLE_SID}_\$(date +%Y%m%d).txt"
exec > >(tee "\$REPORT_FILE") 2>&1

log INFO "User audit report for \$ORACLE_SID"

sqlplus -s / as sysdba <<'EOF'
SET PAGESIZE 100 LINESIZE 150 FEEDBACK OFF
SET HEADING ON

PROMPT
PROMPT === LOCKED USER ACCOUNTS ===
COLUMN username        FORMAT A30
COLUMN account_status  FORMAT A20
COLUMN lock_date       FORMAT A20
COLUMN expiry_date     FORMAT A20

SELECT username, account_status, lock_date, expiry_date
FROM   dba_users
WHERE  account_status LIKE '%LOCKED%'
  AND  username NOT IN ('XS$NULL','MDDATA','DIP','ORACLE_OCM',
                        'SPATIAL_CSW_ADMIN_USR','SPATIAL_WFS_ADMIN_USR')
ORDER BY lock_date DESC NULLS LAST;

PROMPT
PROMPT === EXPIRED PASSWORD ACCOUNTS ===
SELECT username, account_status, expiry_date
FROM   dba_users
WHERE  account_status = 'EXPIRED'
ORDER BY expiry_date;

PROMPT
PROMPT === ACCOUNTS WITH DEFAULT PASSWORDS ===
SELECT u.username, u.account_status
FROM   dba_users u
JOIN   dba_profiles p ON u.profile = p.profile
WHERE  u.password = u.username
   OR  u.username IN (
           SELECT username FROM dba_users_with_defpwd
       )
ORDER BY u.username;

PROMPT
PROMPT === USERS WITH DBA ROLE ===
SELECT grantee, granted_role, admin_option, default_role
FROM   dba_role_privs
WHERE  granted_role = 'DBA'
  AND  grantee NOT IN ('SYS','SYSTEM')
ORDER BY grantee;

PROMPT
PROMPT === USERS WITH DIRECT SYSTEM PRIVILEGES ===
COLUMN grantee   FORMAT A30
COLUMN privilege FORMAT A40
SELECT grantee, privilege, admin_option
FROM   dba_sys_privs
WHERE  grantee NOT IN (
           SELECT role FROM dba_roles
       )
  AND  grantee NOT IN ('SYS','SYSTEM','DBA','DBSNMP','APPQOSSYS',
                       'ORACLE_OCM','XDB','WMSYS','EXFSYS')
  AND  privilege IN ('CREATE ANY TABLE','DROP ANY TABLE','ALTER ANY TABLE',
                     'DELETE ANY TABLE','GRANT ANY PRIVILEGE',
                     'GRANT ANY OBJECT PRIVILEGE','BECOME USER',
                     'ALTER SYSTEM','ALTER DATABASE')
ORDER BY grantee, privilege;

PROMPT
PROMPT === USER ACTIVITY — LAST LOGIN ===
COLUMN last_login FORMAT A30
SELECT username, last_login, account_status
FROM   dba_users
WHERE  username NOT LIKE 'ORACLE%'
  AND  username NOT IN ('SYS','SYSTEM','DBSNMP','APPQOSSYS',
                        'AUDSYS','DVSYS','GGSYS','GSMCATUSER',
                        'GSMROOTUSER','GSMUSER','XDB','WMSYS')
ORDER BY last_login DESC NULLS LAST
FETCH FIRST 30 ROWS ONLY;

EXIT 0;
EOF

log INFO "User audit report written to: \$REPORT_FILE"
\`\`\`

---

## Script 8: Performance Snapshot

\`\`\`bash
#!/bin/bash
# /home/oracle/scripts/perf_snapshot.sh
# Quick performance snapshot — top SQL, wait events, buffer cache hit

source /home/oracle/scripts/lib/oracle_common.sh
load_env "\${1:-\$ORACLE_SID}"
setup_logging "perf_snapshot"

echo "=============================================="
echo "Performance Snapshot: \$ORACLE_SID @ \$(date)"
echo "=============================================="

sqlplus -s / as sysdba <<'EOF'
SET PAGESIZE 100 LINESIZE 150 FEEDBACK OFF HEADING ON

PROMPT
PROMPT === TOP 10 WAIT EVENTS (last hour) ===
COLUMN event         FORMAT A40
COLUMN wait_class    FORMAT A20
COLUMN total_waits   FORMAT 999,999,999
COLUMN time_waited_s FORMAT 999,999.9

SELECT event, wait_class,
       total_waits,
       ROUND(time_waited / 100, 1) AS time_waited_s
FROM   v\$system_event
WHERE  wait_class != 'Idle'
ORDER BY time_waited DESC
FETCH FIRST 10 ROWS ONLY;

PROMPT
PROMPT === TOP 10 SQL BY ELAPSED TIME ===
COLUMN sql_text       FORMAT A60
COLUMN elapsed_secs   FORMAT 999,999.9
COLUMN executions     FORMAT 999,999,999
COLUMN avg_secs       FORMAT 999,999.99

SELECT SUBSTR(sql_text, 1, 60)        AS sql_text,
       executions,
       ROUND(elapsed_time / 1e6, 1)   AS elapsed_secs,
       ROUND(elapsed_time / GREATEST(executions, 1) / 1e6, 3) AS avg_secs
FROM   v\$sql
WHERE  executions > 0
ORDER BY elapsed_time DESC
FETCH FIRST 10 ROWS ONLY;

PROMPT
PROMPT === BUFFER CACHE HIT RATIO ===
SELECT ROUND((1 - (phy.value / GREATEST(log.value + con.value, 1))) * 100, 2)
       AS buffer_cache_hit_pct
FROM v\$sysstat phy,
     v\$sysstat log,
     v\$sysstat con
WHERE phy.name = 'physical reads'
  AND log.name = 'db block gets'
  AND con.name = 'consistent gets';

PROMPT
PROMPT === SGA MEMORY USAGE ===
COLUMN pool       FORMAT A25
COLUMN gb_used    FORMAT 999.99
COLUMN gb_free    FORMAT 999.99

SELECT pool,
       ROUND(SUM(bytes) / 1024 / 1024 / 1024, 2) AS gb_total
FROM   v\$sgastat
GROUP BY pool
ORDER BY pool;

PROMPT
PROMPT === REDO LOG SWITCHES (last 24 hours) ===
SELECT TO_CHAR(first_time, 'YYYY-MM-DD HH24') AS hour,
       COUNT(*) AS switches
FROM   v\$log_history
WHERE  first_time > SYSDATE - 1
GROUP BY TO_CHAR(first_time, 'YYYY-MM-DD HH24')
ORDER BY hour;

EXIT 0;
EOF
\`\`\`

---

## Cron Schedule

Add to the oracle user crontab (\`crontab -e\`):

\`\`\`bash
MAILTO=dba-alerts@corp.local
SHELL=/bin/bash

# Database health check every 15 minutes
*/15 * * * * /home/oracle/scripts/db_health_check.sh PRODDB

# Alert log scan every 5 minutes
*/5  * * * * /home/oracle/scripts/scan_alert_log.sh PRODDB

# Session report — top sessions every hour
0    * * * * /home/oracle/scripts/session_manager.sh PRODDB

# AWR snapshot every hour (default AWR interval is 60 minutes — adjust if custom)
5    * * * * /home/oracle/scripts/awr_report.sh PRODDB

# RMAN backup verification at 08:00 daily
0    8 * * * /home/oracle/scripts/verify_rman_backup.sh PRODDB

# Recompile invalid objects at 07:00 daily
0    7 * * * /home/oracle/scripts/recompile_invalid.sh PRODDB

# User audit report on the 1st of every month
0    6 1 * * /home/oracle/scripts/user_audit_report.sh PRODDB | mail -s "Monthly User Audit \$ORACLE_SID" dba-security@corp.local

# Performance snapshot at peak hours: 09:00 and 14:00 weekdays
0    9,14 * * 1-5 /home/oracle/scripts/perf_snapshot.sh PRODDB
\`\`\`

---

## Deploying Scripts

\`\`\`bash
# Set correct permissions — readable and executable by oracle only
chmod 750 /home/oracle/scripts/*.sh
chmod 640 /home/oracle/scripts/lib/*.sh
chmod 640 /home/oracle/scripts/env/*.env

# Test each script manually before scheduling
/home/oracle/scripts/db_health_check.sh PRODDB; echo "Exit: \$?"
/home/oracle/scripts/scan_alert_log.sh PRODDB; echo "Exit: \$?"
/home/oracle/scripts/perf_snapshot.sh PRODDB; echo "Exit: \$?"

# Verify cron picks up the environment correctly (simulate cron — no profile)
env -i HOME=/home/oracle /bin/bash -c \
  'ORACLE_SID=PRODDB /home/oracle/scripts/db_health_check.sh PRODDB'
\`\`\``,
};

async function main() {
  console.log('Inserting Oracle DBA shell script library runbook...');
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
