import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: PostgreSQL DBA Shell Script Library',
  slug: 'postgresql-dba-shell-script-library-runbook',
  excerpt:
    'A complete library of production-ready PostgreSQL DBA shell scripts — health checks, bloat and dead-tuple monitoring, pg_dump backup with retention, vacuum automation, streaming replication lag alerting, connection and lock management, slow query detection, user audit, and a cron deployment guide.',
  category: 'postgresql' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-11'),
  youtubeUrl: null,
  content: `## Setup: Script Directory and Environment Files

### Directory Structure

\`\`\`bash
mkdir -p /home/postgres/scripts/{lib,logs,env,sql}
chmod 750 /home/postgres/scripts

# Layout:
# /home/postgres/scripts/
# ├── lib/           — shared functions
# ├── logs/          — all script log output
# ├── env/           — per-database connection environment files
# ├── sql/           — standalone SQL files used by scripts
# └── *.sh           — DBA scripts
\`\`\`

### Environment File Template

Create one file per database: \`/home/postgres/scripts/env/appdb.env\`

\`\`\`bash
export PGHOST=db.corp.local
export PGPORT=5432
export PGUSER=postgres
export PGDATABASE=appdb
export PGSSLMODE=require
\`\`\`

### .pgpass Credentials

\`\`\`bash
# /home/postgres/.pgpass  (chmod 600)
db.corp.local:5432:*:postgres:YourSecurePassword
\`\`\`

### Shared Library: /home/postgres/scripts/lib/pg_common.sh

\`\`\`bash
#!/bin/bash

LOG_DIR="/home/postgres/scripts/logs"
RETAIN_DAYS=30

setup_logging() {
    local name="\$1"
    mkdir -p "\$LOG_DIR"
    LOG_FILE="\${LOG_DIR}/\${name}_\$(date +%Y%m%d_%H%M%S).log"
    exec > >(tee -a "\$LOG_FILE") 2>&1
    find "\$LOG_DIR" -name "\${name}_*.log" -mtime +\${RETAIN_DAYS} -delete 2>/dev/null
}

log() {
    local level="\${1:-INFO}"
    local msg="\$2"
    echo "\$(date '+%Y-%m-%d %H:%M:%S') [\$level] \$msg"
}

load_env() {
    local db="\${1:-appdb}"
    local f="/home/postgres/scripts/env/\${db}.env"
    [[ ! -f "\$f" ]] && { echo "ERROR: env file not found: \$f" >&2; exit 1; }
    source "\$f"
}

acquire_lock() {
    LOCK_FILE="/tmp/\$(basename \$0 .sh).lock"
    if ! mkdir "\$LOCK_FILE" 2>/dev/null; then
        log WARN "Already running — \$LOCK_FILE exists"
        exit 0
    fi
    trap "rmdir '\$LOCK_FILE' 2>/dev/null" EXIT
}

# Run SQL and return output — exits non-zero on SQL error
run_sql() {
    psql -v ON_ERROR_STOP=1 -t -A -F'|' -c "\$1" 2>&1
}

# Run SQL silently, return exit code only
exec_sql() {
    psql -v ON_ERROR_STOP=1 -q -c "\$1" >/dev/null 2>&1
}
\`\`\`

---

## Script 1: Database Health Check

\`\`\`bash
#!/bin/bash
# /home/postgres/scripts/pg_health_check.sh
# Usage: ./pg_health_check.sh [dbname]
# Exit codes: 0=OK, 1=WARNING, 2=CRITICAL

source /home/postgres/scripts/lib/pg_common.sh
load_env "\${1:-appdb}"
setup_logging "pg_health_check"
acquire_lock

EXIT_CODE=0
EMAIL="dba-alerts@corp.local"

log INFO "Health check: \$PGDATABASE on \$PGHOST"

# --- 1. Can we connect? ---
if ! psql -c "SELECT 1" >/dev/null 2>&1; then
    MSG="CRITICAL: Cannot connect to \$PGDATABASE on \$PGHOST"
    log CRITICAL "\$MSG"
    echo "\$MSG" | mail -s "PG CRITICAL: \$PGDATABASE unreachable" "\$EMAIL"
    exit 2
fi
log INFO "Connection: OK"

# --- 2. Connection count vs max_connections ---
read -r current_conns max_conns <<< \$(psql -t -A -F' ' -c "
    SELECT COUNT(*),
           (SELECT setting::int FROM pg_settings WHERE name='max_connections')
    FROM pg_stat_activity
" | xargs)

pct=\$(( current_conns * 100 / max_conns ))
log INFO "Connections: \$current_conns / \$max_conns (\${pct}%)"

if   [[ \$pct -ge 90 ]]; then
    log CRITICAL "Connection count at \${pct}% of max_connections"
    echo "CRITICAL: \$PGDATABASE connections \${current_conns}/\${max_conns}" | mail -s "PG Connections CRITICAL" "\$EMAIL"
    EXIT_CODE=2
elif [[ \$pct -ge 75 ]]; then
    log WARN "Connection count at \${pct}% of max_connections"
    [[ \$EXIT_CODE -lt 2 ]] && EXIT_CODE=1
fi

# --- 3. Long-running queries (> 10 minutes) ---
LONG_QUERIES=\$(psql -t -A -F'|' -c "
    SELECT pid, usename, ROUND(EXTRACT(EPOCH FROM (NOW() - query_start))/60) AS mins,
           LEFT(query, 80)
    FROM   pg_stat_activity
    WHERE  state = 'active'
      AND  query NOT LIKE '%pg_stat_activity%'
      AND  query_start < NOW() - INTERVAL '10 minutes'
    ORDER BY query_start
")

if [[ -n "\$LONG_QUERIES" ]]; then
    log WARN "Long-running queries detected (>10 min):"
    while IFS='|' read -r pid user mins sql; do
        log WARN "  PID \$pid (\$user): \${mins}m — \$sql"
    done <<< "\$LONG_QUERIES"
    [[ \$EXIT_CODE -lt 1 ]] && EXIT_CODE=1
else
    log INFO "No long-running queries"
fi

# --- 4. Locks: blocked queries ---
BLOCKED=\$(psql -t -A -c "
    SELECT COUNT(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock'
" | xargs)

if [[ "\$BLOCKED" -gt 0 ]]; then
    log WARN "\$BLOCKED query/queries blocked on locks"
    psql -c "
        SELECT pid, usename, wait_event, LEFT(query,80) AS query
        FROM   pg_stat_activity
        WHERE  wait_event_type = 'Lock'
    "
    [[ \$EXIT_CODE -lt 1 ]] && EXIT_CODE=1
else
    log INFO "No lock-blocked queries"
fi

# --- 5. Replication lag (if standby exists) ---
IS_PRIMARY=\$(psql -t -A -c "SELECT NOT pg_is_in_recovery()" | xargs)
if [[ "\$IS_PRIMARY" == "t" ]]; then
    REP_LAG=\$(psql -t -A -c "
        SELECT COALESCE(
            MAX(EXTRACT(EPOCH FROM write_lag))::int, 0
        )
        FROM pg_stat_replication
    " | xargs)

    if [[ "\$REP_LAG" -ge 300 ]]; then
        log WARN "Replication write lag: \${REP_LAG}s"
        [[ \$EXIT_CODE -lt 1 ]] && EXIT_CODE=1
    else
        log INFO "Replication lag: \${REP_LAG}s"
    fi
fi

# --- 6. Dead tuple bloat ---
BLOATED=\$(psql -t -A -F'|' -c "
    SELECT schemaname||'.'||relname, n_dead_tup, n_live_tup,
           ROUND(n_dead_tup::numeric / GREATEST(n_live_tup + n_dead_tup,1) * 100, 1) AS dead_pct
    FROM   pg_stat_user_tables
    WHERE  n_dead_tup > 50000
      AND  n_dead_tup::numeric / GREATEST(n_live_tup + n_dead_tup,1) > 0.2
    ORDER BY n_dead_tup DESC
    LIMIT 5
")

if [[ -n "\$BLOATED" ]]; then
    log WARN "Tables with high dead-tuple ratio:"
    while IFS='|' read -r tbl dead live pct; do
        log WARN "  \$tbl — \$dead dead tuples (\${pct}%)"
    done <<< "\$BLOATED"
    [[ \$EXIT_CODE -lt 1 ]] && EXIT_CODE=1
else
    log INFO "Dead tuple bloat: within normal range"
fi

# --- 7. Disk usage (data directory) ---
DATA_DIR=\$(psql -t -A -c "SHOW data_directory" | xargs)
DISK_PCT=\$(df -P "\$DATA_DIR" | awk 'NR==2 {gsub(/%/,""); print \$5}')

if   [[ "\$DISK_PCT" -ge 90 ]]; then
    log CRITICAL "Data directory disk usage: \${DISK_PCT}%"
    EXIT_CODE=2
elif [[ "\$DISK_PCT" -ge 80 ]]; then
    log WARN "Data directory disk usage: \${DISK_PCT}%"
    [[ \$EXIT_CODE -lt 2 ]] && EXIT_CODE=1
else
    log INFO "Data directory disk: \${DISK_PCT}%"
fi

log INFO "Health check complete. Exit code: \$EXIT_CODE"
exit \$EXIT_CODE
\`\`\`

---

## Script 2: pg_dump Backup with Retention

\`\`\`bash
#!/bin/bash
# /home/postgres/scripts/pg_backup.sh
# Usage: ./pg_backup.sh [dbname] [backup_dir] [retain_days]

source /home/postgres/scripts/lib/pg_common.sh
load_env "\${1:-appdb}"
setup_logging "pg_backup"
acquire_lock

BACKUP_BASE="\${2:-/backups/postgres}"
RETAIN_DAYS="\${3:-14}"
BACKUP_DIR="\${BACKUP_BASE}/\${PGDATABASE}"
TIMESTAMP=\$(date +%Y%m%d_%H%M%S)
DUMP_FILE="\${BACKUP_DIR}/\${PGDATABASE}_\${TIMESTAMP}.dump"
START_TIME=\$(date +%s)

mkdir -p "\$BACKUP_DIR"

log INFO "Starting pg_dump: \$PGDATABASE → \$DUMP_FILE"

pg_dump \
    --host="\$PGHOST" \
    --port="\$PGPORT" \
    --username="\$PGUSER" \
    --format=custom \
    --compress=6 \
    --verbose \
    --file="\$DUMP_FILE" \
    "\$PGDATABASE" 2>&1

RC=\$?
END_TIME=\$(date +%s)
ELAPSED=\$(( END_TIME - START_TIME ))

if [[ \$RC -ne 0 ]]; then
    log CRITICAL "pg_dump FAILED for \$PGDATABASE (RC=\$RC, elapsed: \${ELAPSED}s)"
    echo "pg_dump failed for \$PGDATABASE on \$(hostname)" | mail -s "PG Backup FAILED: \$PGDATABASE" "dba-alerts@corp.local"
    exit 2
fi

SIZE=\$(du -sh "\$DUMP_FILE" | cut -f1)
log INFO "Backup complete: \$DUMP_FILE (\$SIZE) in \${ELAPSED}s"

# Verify the dump is readable
pg_restore --list "\$DUMP_FILE" >/dev/null 2>&1
if [[ \$? -ne 0 ]]; then
    log CRITICAL "Dump verification failed — file may be corrupt: \$DUMP_FILE"
    exit 2
fi
log INFO "Dump verification: OK"

# Purge old backups
PURGED=\$(find "\$BACKUP_DIR" -name "*.dump" -mtime +\${RETAIN_DAYS} -print -delete | wc -l)
[[ "\$PURGED" -gt 0 ]] && log INFO "Purged \$PURGED backup(s) older than \${RETAIN_DAYS} days"

exit 0
\`\`\`

---

## Script 3: Vacuum Automation

\`\`\`bash
#!/bin/bash
# /home/postgres/scripts/pg_vacuum.sh
# Runs VACUUM ANALYZE on tables with high dead-tuple ratios
# Usage: ./pg_vacuum.sh [dbname] [dead_tup_threshold] [dead_pct_threshold]

source /home/postgres/scripts/lib/pg_common.sh
load_env "\${1:-appdb}"
setup_logging "pg_vacuum"
acquire_lock

DEAD_THRESHOLD="\${2:-50000}"
PCT_THRESHOLD="\${3:-20}"

log INFO "Vacuum automation: \$PGDATABASE — dead_tup > \$DEAD_THRESHOLD or > \${PCT_THRESHOLD}%"

# Find tables needing vacuum
TABLES=\$(psql -t -A -F'|' -c "
    SELECT schemaname, relname,
           n_dead_tup,
           ROUND(n_dead_tup::numeric / GREATEST(n_live_tup + n_dead_tup, 1) * 100, 1) AS dead_pct,
           COALESCE(last_vacuum::text, 'never')   AS last_vacuum,
           COALESCE(last_autovacuum::text, 'never') AS last_autovacuum
    FROM   pg_stat_user_tables
    WHERE  n_dead_tup > \$DEAD_THRESHOLD
       OR  (n_dead_tup::numeric / GREATEST(n_live_tup + n_dead_tup, 1) * 100) > \$PCT_THRESHOLD
    ORDER BY n_dead_tup DESC
")

if [[ -z "\$TABLES" ]]; then
    log INFO "No tables require manual vacuum"
    exit 0
fi

VACUUMED=0
FAILED=0

while IFS='|' read -r schema table dead_tup dead_pct last_vac last_avac; do
    [[ -z "\$schema" ]] && continue
    log INFO "VACUUM ANALYZE \${schema}.\${table} (dead: \$dead_tup rows / \${dead_pct}%)"

    psql -v ON_ERROR_STOP=1 -c "VACUUM ANALYZE \${schema}.\${table}" 2>&1
    RC=\$?

    if [[ \$RC -eq 0 ]]; then
        log INFO "  Done: \${schema}.\${table}"
        (( VACUUMED++ ))
    else
        log WARN "  FAILED: \${schema}.\${table} (RC=\$RC)"
        (( FAILED++ ))
    fi
done <<< "\$TABLES"

log INFO "Vacuum complete: \$VACUUMED succeeded, \$FAILED failed"
[[ \$FAILED -gt 0 ]] && exit 1 || exit 0
\`\`\`

---

## Script 4: Replication Lag Monitor

\`\`\`bash
#!/bin/bash
# /home/postgres/scripts/pg_replication_monitor.sh
# Run on the PRIMARY — monitors all streaming standbys
# Usage: ./pg_replication_monitor.sh [dbname]

source /home/postgres/scripts/lib/pg_common.sh
load_env "\${1:-appdb}"
setup_logging "pg_replication_monitor"

WARN_LAG_BYTES=52428800    # 50 MB
CRIT_LAG_BYTES=524288000   # 500 MB
EMAIL="dba-alerts@corp.local"
EXIT_CODE=0

# Verify this is a primary
IS_PRIMARY=\$(psql -t -A -c "SELECT NOT pg_is_in_recovery()" | xargs)
if [[ "\$IS_PRIMARY" != "t" ]]; then
    log INFO "This instance is a standby — skipping replication monitor"
    exit 0
fi

# Check for any connected standbys
STANDBY_COUNT=\$(psql -t -A -c "SELECT COUNT(*) FROM pg_stat_replication" | xargs)
if [[ "\$STANDBY_COUNT" -eq 0 ]]; then
    log WARN "No standbys connected to primary"
    echo "WARNING: No standbys connected to \$PGHOST \$PGDATABASE" | mail -s "PG Replication WARNING" "\$EMAIL"
    exit 1
fi

log INFO "\$STANDBY_COUNT standby(s) connected"

# Check each standby
psql -t -A -F'|' -c "
    SELECT client_addr,
           application_name,
           state,
           sent_lsn,
           write_lsn,
           flush_lsn,
           replay_lsn,
           pg_wal_lsn_diff(sent_lsn, replay_lsn) AS replay_lag_bytes,
           COALESCE(EXTRACT(EPOCH FROM write_lag)::int, 0)  AS write_lag_secs,
           COALESCE(EXTRACT(EPOCH FROM replay_lag)::int, 0) AS replay_lag_secs,
           sync_state
    FROM   pg_stat_replication
    ORDER BY replay_lag_bytes DESC NULLS LAST
" | while IFS='|' read -r addr app state sent write flush replay lag_bytes write_secs replay_secs sync; do
    [[ -z "\$addr" ]] && continue
    log INFO "Standby \$addr (\$app) state=\$state sync=\$sync replay_lag=\${replay_secs}s lag_bytes=\$lag_bytes"

    if   [[ "\$lag_bytes" -ge "\$CRIT_LAG_BYTES" ]]; then
        MSG="CRITICAL: Standby \$addr (\$app) is \$(( lag_bytes / 1024 / 1024 ))MB behind"
        log CRITICAL "\$MSG"
        echo "\$MSG" | mail -s "PG Replication CRITICAL: \$PGDATABASE" "\$EMAIL"
        EXIT_CODE=2
    elif [[ "\$lag_bytes" -ge "\$WARN_LAG_BYTES" ]]; then
        log WARN "Standby \$addr (\$app) is \$(( lag_bytes / 1024 / 1024 ))MB behind"
        [[ \$EXIT_CODE -lt 2 ]] && EXIT_CODE=1
    fi

    if [[ "\$state" != "streaming" ]]; then
        MSG="WARNING: Standby \$addr (\$app) is in '\$state' state — not streaming"
        log WARN "\$MSG"
        echo "\$MSG" | mail -s "PG Replication State WARNING: \$PGDATABASE" "\$EMAIL"
        [[ \$EXIT_CODE -lt 1 ]] && EXIT_CODE=1
    fi
done

exit \$EXIT_CODE
\`\`\`

---

## Script 5: Lock and Blocked Query Report

\`\`\`bash
#!/bin/bash
# /home/postgres/scripts/pg_lock_report.sh
# Identifies lock chains and kills long-blocked queries if requested
# Usage: ./pg_lock_report.sh [dbname] [--kill-blocked-mins <N>]

source /home/postgres/scripts/lib/pg_common.sh
load_env "\${1:-appdb}"
setup_logging "pg_lock_report"

KILL_THRESHOLD=0
while [[ \$# -gt 0 ]]; do
    case "\$1" in
        --kill-blocked-mins) KILL_THRESHOLD="\$2"; shift 2 ;;
        *) shift ;;
    esac
done

log INFO "Lock report for \$PGDATABASE"

# Show full lock dependency tree
psql <<'SQL'
\echo '=== Lock Wait Chains ==='
SELECT
    blocked.pid                           AS blocked_pid,
    blocked.usename                       AS blocked_user,
    ROUND(EXTRACT(EPOCH FROM NOW() - blocked.query_start)) AS blocked_secs,
    LEFT(blocked.query, 80)               AS blocked_query,
    blocking.pid                          AS blocking_pid,
    blocking.usename                      AS blocking_user,
    ROUND(EXTRACT(EPOCH FROM NOW() - blocking.query_start)) AS blocking_secs,
    LEFT(blocking.query, 80)              AS blocking_query
FROM  pg_stat_activity AS blocked
JOIN  pg_stat_activity AS blocking
      ON  blocking.pid = ANY(pg_blocking_pids(blocked.pid))
WHERE NOT blocked.pg_catalog.pg_blocking_pids = '{}'
ORDER BY blocked_secs DESC;
SQL

# Kill long-blocked queries if threshold set
if [[ "\$KILL_THRESHOLD" -gt 0 ]]; then
    log INFO "Killing queries blocked > \${KILL_THRESHOLD} minutes..."

    BLOCKED_PIDS=\$(psql -t -A -c "
        SELECT pid
        FROM   pg_stat_activity
        WHERE  cardinality(pg_blocking_pids(pid)) > 0
          AND  query_start < NOW() - INTERVAL '\${KILL_THRESHOLD} minutes'
          AND  usename NOT IN ('postgres','replication')
    ")

    if [[ -z "\$BLOCKED_PIDS" ]]; then
        log INFO "No queries blocked longer than \${KILL_THRESHOLD} minutes"
    else
        while read -r pid; do
            [[ -z "\$pid" ]] && continue
            log WARN "Terminating blocked PID \$pid"
            psql -c "SELECT pg_terminate_backend(\$pid)"
        done <<< "\$BLOCKED_PIDS"
    fi
fi
\`\`\`

---

## Script 6: Slow Query Report from pg_stat_statements

\`\`\`bash
#!/bin/bash
# /home/postgres/scripts/pg_slow_query_report.sh
# Reports top slow queries using pg_stat_statements
# Usage: ./pg_slow_query_report.sh [dbname] [top_n]

source /home/postgres/scripts/lib/pg_common.sh
load_env "\${1:-appdb}"

TOP_N="\${2:-20}"

# Verify pg_stat_statements is loaded
EXT=\$(psql -t -A -c "SELECT COUNT(*) FROM pg_extension WHERE extname='pg_stat_statements'" | xargs)
if [[ "\$EXT" -eq 0 ]]; then
    echo "ERROR: pg_stat_statements is not installed in \$PGDATABASE" >&2
    echo "Install with: CREATE EXTENSION pg_stat_statements;" >&2
    exit 1
fi

echo "=== Top \$TOP_N Queries by Total Time: \$PGDATABASE @ \$(date) ==="

psql -x -c "
SELECT
    ROUND(total_exec_time::numeric, 0)          AS total_ms,
    calls,
    ROUND((total_exec_time / calls)::numeric, 2) AS avg_ms,
    ROUND(rows::numeric / calls, 1)             AS avg_rows,
    ROUND(100 * total_exec_time /
          SUM(total_exec_time) OVER (), 2)      AS pct_of_total,
    LEFT(query, 120)                             AS query
FROM  pg_stat_statements
WHERE calls > 10
ORDER BY total_exec_time DESC
LIMIT \$TOP_N;
"

echo ""
echo "=== Top \$TOP_N Queries by Average Time (min 100 calls) ==="

psql -x -c "
SELECT
    ROUND((total_exec_time / calls)::numeric, 2)  AS avg_ms,
    calls,
    ROUND(total_exec_time::numeric, 0)             AS total_ms,
    LEFT(query, 120)                               AS query
FROM  pg_stat_statements
WHERE calls >= 100
ORDER BY avg_ms DESC
LIMIT \$TOP_N;
"

echo ""
echo "=== Queries with High Cache Miss Rate (>20% heap fetch) ==="

psql -x -c "
SELECT
    calls,
    ROUND(total_exec_time::numeric, 0)       AS total_ms,
    shared_blks_read                         AS disk_reads,
    shared_blks_hit                          AS cache_hits,
    ROUND(100.0 * shared_blks_read /
          GREATEST(shared_blks_read + shared_blks_hit, 1), 1) AS miss_pct,
    LEFT(query, 120)                         AS query
FROM  pg_stat_statements
WHERE shared_blks_read + shared_blks_hit > 10000
  AND shared_blks_read::numeric /
      GREATEST(shared_blks_read + shared_blks_hit, 1) > 0.2
ORDER BY disk_reads DESC
LIMIT 10;
"
\`\`\`

---

## Script 7: User and Privilege Audit

\`\`\`bash
#!/bin/bash
# /home/postgres/scripts/pg_user_audit.sh
# Audits roles, privileges, and access patterns
# Usage: ./pg_user_audit.sh [dbname]

source /home/postgres/scripts/lib/pg_common.sh
load_env "\${1:-appdb}"
setup_logging "pg_user_audit"

REPORT_FILE="/home/postgres/scripts/logs/user_audit_\${PGDATABASE}_\$(date +%Y%m%d).txt"
exec > >(tee "\$REPORT_FILE") 2>&1

echo "=== PostgreSQL User Audit: \$PGDATABASE on \$PGHOST @ \$(date) ==="

psql <<'SQL'

\echo ''
\echo '=== ALL ROLES ==='
SELECT rolname,
       rolsuper      AS superuser,
       rolinherit    AS inherit,
       rolcreaterole AS createrole,
       rolcreatedb   AS createdb,
       rolcanlogin   AS canlogin,
       rolconnlimit  AS conn_limit,
       rolvaliduntil AS expires
FROM   pg_roles
ORDER BY rolname;

\echo ''
\echo '=== SUPERUSERS ==='
SELECT rolname FROM pg_roles WHERE rolsuper = true ORDER BY rolname;

\echo ''
\echo '=== ROLE MEMBERSHIPS ==='
SELECT r.rolname AS member, g.rolname AS member_of
FROM   pg_auth_members m
JOIN   pg_roles r ON m.member = r.oid
JOIN   pg_roles g ON m.roleid = g.oid
ORDER BY r.rolname, g.rolname;

\echo ''
\echo '=== ROLES WITH LOGIN — PASSWORD EXPIRY ==='
SELECT rolname,
       CASE WHEN rolpassword IS NULL THEN 'NO PASSWORD' ELSE 'has password' END AS pw_status,
       COALESCE(rolvaliduntil::text, 'never expires') AS expires
FROM   pg_authid
WHERE  rolcanlogin = true
ORDER BY rolname;

\echo ''
\echo '=== DATABASE-LEVEL GRANTS ==='
SELECT datname,
       pg_catalog.pg_get_userbyid(datdba) AS owner
FROM   pg_database
WHERE  datistemplate = false
ORDER BY datname;

\echo ''
\echo '=== SCHEMA OWNERSHIP ==='
SELECT nspname AS schema_name,
       pg_catalog.pg_get_userbyid(nspowner) AS owner
FROM   pg_namespace
WHERE  nspname NOT LIKE 'pg_%'
  AND  nspname != 'information_schema'
ORDER BY nspname;

\echo ''
\echo '=== TABLE-LEVEL GRANTS (non-owner access) ==='
SELECT grantee, table_schema, table_name,
       STRING_AGG(privilege_type, ', ' ORDER BY privilege_type) AS privileges
FROM   information_schema.role_table_grants
WHERE  grantee NOT IN ('PUBLIC','postgres')
  AND  table_schema NOT IN ('pg_catalog','information_schema')
GROUP BY grantee, table_schema, table_name
ORDER BY grantee, table_schema, table_name;

SQL

log INFO "User audit report written to: \$REPORT_FILE"
\`\`\`

---

## Script 8: Performance Snapshot

\`\`\`bash
#!/bin/bash
# /home/postgres/scripts/pg_perf_snapshot.sh
# Quick performance snapshot — cache hit, bloat, connections, checkpoints
# Usage: ./pg_perf_snapshot.sh [dbname]

source /home/postgres/scripts/lib/pg_common.sh
load_env "\${1:-appdb}"

echo "======================================================"
echo "Performance Snapshot: \$PGDATABASE @ \$(date)"
echo "======================================================"

psql <<'SQL'

\echo ''
\echo '=== DATABASE STATISTICS ==='
SELECT datname,
       numbackends                                         AS connections,
       xact_commit                                        AS commits,
       xact_rollback                                      AS rollbacks,
       ROUND(blks_hit * 100.0 / GREATEST(blks_hit + blks_read, 1), 2) AS cache_hit_pct,
       tup_inserted + tup_updated + tup_deleted           AS writes,
       deadlocks,
       conflicts
FROM   pg_stat_database
WHERE  datname = current_database();

\echo ''
\echo '=== TABLE CACHE HIT RATES (bottom 10) ==='
SELECT schemaname, relname,
       heap_blks_hit + heap_blks_read  AS total_reads,
       ROUND(heap_blks_hit * 100.0 /
             GREATEST(heap_blks_hit + heap_blks_read, 1), 2) AS cache_hit_pct,
       n_live_tup, n_dead_tup
FROM   pg_statio_user_tables
WHERE  heap_blks_hit + heap_blks_read > 1000
ORDER BY cache_hit_pct ASC
LIMIT 10;

\echo ''
\echo '=== INDEX USAGE (low usage = candidate for removal) ==='
SELECT schemaname, relname AS table_name, indexrelname AS index_name,
       idx_scan, idx_tup_read, idx_tup_fetch,
       pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM   pg_stat_user_indexes
WHERE  idx_scan < 100
  AND  pg_relation_size(indexrelid) > 1048576
ORDER BY pg_relation_size(indexrelid) DESC
LIMIT 15;

\echo ''
\echo '=== CHECKPOINT STATISTICS ==='
SELECT checkpoints_timed,
       checkpoints_req,
       ROUND(checkpoint_write_time / 1000.0, 1) AS write_secs,
       ROUND(checkpoint_sync_time  / 1000.0, 1) AS sync_secs,
       buffers_checkpoint, buffers_clean, buffers_backend,
       ROUND(100.0 * buffers_backend /
             GREATEST(buffers_checkpoint + buffers_clean + buffers_backend, 1), 1)
             AS pct_written_by_backends
FROM   pg_stat_bgwriter;

\echo ''
\echo '=== AUTOVACUUM ACTIVITY ==='
SELECT relname, n_dead_tup,
       last_autovacuum, last_autoanalyze,
       autovacuum_count, autoanalyze_count
FROM   pg_stat_user_tables
WHERE  last_autovacuum IS NOT NULL
ORDER BY last_autovacuum DESC
LIMIT 10;

\echo ''
\echo '=== CURRENT CONNECTIONS BY STATE ==='
SELECT state,
       COUNT(*)                                              AS count,
       COUNT(*) FILTER (WHERE wait_event_type = 'Lock')     AS waiting_on_lock,
       ROUND(AVG(EXTRACT(EPOCH FROM NOW() - query_start)))  AS avg_secs
FROM   pg_stat_activity
WHERE  pid <> pg_backend_pid()
GROUP BY state
ORDER BY count DESC;

SQL
\`\`\`

---

## Cron Schedule

Add to the \`postgres\` user crontab (\`crontab -e\`):

\`\`\`bash
MAILTO=dba-alerts@corp.local
SHELL=/bin/bash

# Health check every 5 minutes
*/5  * * * * /home/postgres/scripts/pg_health_check.sh appdb

# Replication lag check every 2 minutes
*/2  * * * * /home/postgres/scripts/pg_replication_monitor.sh appdb

# Lock report every 10 minutes
*/10 * * * * /home/postgres/scripts/pg_lock_report.sh appdb

# Nightly backup at 01:00
0    1 * * * /home/postgres/scripts/pg_backup.sh appdb /backups/postgres 14

# Vacuum automation at 03:00
0    3 * * * /home/postgres/scripts/pg_vacuum.sh appdb

# Slow query report at 08:00 weekdays
0    8 * * 1-5 /home/postgres/scripts/pg_slow_query_report.sh appdb 20 > /home/postgres/scripts/logs/slow_queries_\$(date +\%Y\%m\%d).txt

# Performance snapshot at peak hours
0    9,14 * * 1-5 /home/postgres/scripts/pg_perf_snapshot.sh appdb >> /home/postgres/scripts/logs/perf_\$(date +\%Y\%m\%d).log

# Monthly user audit on the 1st at 07:00
0    7 1 * * /home/postgres/scripts/pg_user_audit.sh appdb
\`\`\`

---

## Deployment and Testing

\`\`\`bash
# Set permissions
chmod 750 /home/postgres/scripts/*.sh
chmod 640 /home/postgres/scripts/lib/*.sh
chmod 600 /home/postgres/.pgpass

# Smoke-test each script
/home/postgres/scripts/pg_health_check.sh appdb;       echo "Exit: \$?"
/home/postgres/scripts/pg_perf_snapshot.sh appdb;      echo "Exit: \$?"
/home/postgres/scripts/pg_slow_query_report.sh appdb;  echo "Exit: \$?"

# Simulate cron environment (no profile, minimal PATH)
env -i HOME=/home/postgres PATH=/usr/bin:/bin \
    /home/postgres/scripts/pg_health_check.sh appdb
\`\`\``,
};

async function main() {
  console.log('Inserting PostgreSQL DBA shell script library runbook...');
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
