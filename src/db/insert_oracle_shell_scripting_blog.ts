import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Shell Scripting for Oracle Database Operations: Patterns Every DBA Needs',
  slug: 'shell-scripting-oracle-database-operations',
  excerpt:
    'A practical guide to writing production-quality shell scripts for Oracle DBA work — covering environment setup, sqlplus integration, exit code handling, here-doc SQL blocks, output parsing, parallel execution, cron scheduling, and the reusable patterns that turn one-off commands into reliable automation.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-11'),
  youtubeUrl: null,
  content: `Oracle DBAs spend a lot of time at the command line. Backups, space checks, user audits, alert log scans, session kills, statspack snapshots — most of these tasks are repetitive, time-sensitive, and error-prone when done manually. Shell scripts turn them into reliable, schedulable, auditable operations.

This post covers the patterns and techniques that separate a fragile one-liner from a production-quality DBA script.

---

## Environment Setup: The Foundation of Every Oracle Script

Every Oracle shell script must establish the correct environment before running \`sqlplus\` or any other Oracle tool. A script that works interactively often fails in cron because cron does not source \`~/.bash_profile\`.

### The Standard Oracle Environment Block

\`\`\`bash
#!/bin/bash
# Set Oracle environment — must be done before any Oracle command
export ORACLE_BASE=/u01/oracle
export ORACLE_HOME=\${ORACLE_BASE}/product/19.3.0/dbhome_1
export ORACLE_SID=PRODDB
export PATH=\${ORACLE_HOME}/bin:\${PATH}
export LD_LIBRARY_PATH=\${ORACLE_HOME}/lib:\${LD_LIBRARY_PATH}
export NLS_DATE_FORMAT='YYYY-MM-DD HH24:MI:SS'
\`\`\`

For environments with multiple databases or RAC, source a central environment file instead:

\`\`\`bash
#!/bin/bash
# Source the correct Oracle environment for this database
DB_NAME="\${1:-PRODDB}"
ENV_FILE="/home/oracle/env/\${DB_NAME}.env"

if [[ ! -f "\$ENV_FILE" ]]; then
    echo "ERROR: Environment file not found: \$ENV_FILE" >&2
    exit 1
fi

source "\$ENV_FILE"
\`\`\`

Where \`/home/oracle/env/PRODDB.env\` contains the exports above.

---

## Running SQL from Shell Scripts

### Here-Doc SQL Blocks

The cleanest way to embed SQL in a shell script is with a here-doc. The SQL block is readable, maintainable, and does not require a separate \`.sql\` file.

\`\`\`bash
sqlplus -s / as sysdba <<'EOF'
SET PAGESIZE 0
SET FEEDBACK OFF
SET HEADING OFF
SET TRIMSPOOL ON

SELECT SYSDATE FROM dual;

EXIT;
EOF
\`\`\`

The \`-s\` flag (silent) suppresses the SQL*Plus banner and version output. Always use \`'EOF'\` (quoted) rather than \`EOF\` to prevent shell variable expansion inside the SQL block.

### Passing Shell Variables into SQL

When you need to pass a shell variable into a SQL statement, use unquoted heredoc and be careful with quoting:

\`\`\`bash
TABLE_NAME="CUSTOMERS"

sqlplus -s / as sysdba <<EOF
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON
SELECT COUNT(*) FROM \${TABLE_NAME};
EXIT;
EOF
\`\`\`

Or use a bind approach to avoid SQL injection risk when the variable comes from external input:

\`\`\`bash
SCHEMA_NAME="\$1"

sqlplus -s / as sysdba <<EOF
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON
SELECT COUNT(*) FROM dba_objects WHERE owner = UPPER('\${SCHEMA_NAME}');
EXIT;
EOF
\`\`\`

---

## Exit Code Handling

**This is the most commonly neglected aspect of Oracle shell scripts.** \`sqlplus\` by default returns exit code 0 even when the SQL fails. You must explicitly tell it to exit with a non-zero code on error.

### Make sqlplus Return Non-Zero on SQL Errors

\`\`\`bash
sqlplus -s / as sysdba <<'EOF'
WHENEVER SQLERROR EXIT SQL.SQLCODE
WHENEVER OSERROR EXIT FAILURE

-- Your SQL here
SELECT COUNT(*) FROM nonexistent_table;

EXIT 0;
EOF

RC=\$?
if [[ \$RC -ne 0 ]]; then
    echo "ERROR: SQL execution failed with code \$RC" >&2
    exit \$RC
fi
\`\`\`

\`WHENEVER SQLERROR EXIT SQL.SQLCODE\` causes sqlplus to exit with the Oracle error code when a SQL statement fails. \`WHENEVER OSERROR EXIT FAILURE\` handles OS-level errors (file not found, permission denied).

### Capture sqlplus Output and Check It

\`\`\`bash
OUTPUT=\$(sqlplus -s / as sysdba <<'EOF'
WHENEVER SQLERROR EXIT SQL.SQLCODE
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON

SELECT status FROM v\$instance;

EXIT 0;
EOF
)

RC=\$?

if [[ \$RC -ne 0 ]]; then
    echo "ERROR: sqlplus failed (RC=\$RC)" >&2
    exit 1
fi

if [[ "\$OUTPUT" != "OPEN" ]]; then
    echo "ALERT: Database is not OPEN — status: \$OUTPUT"
    exit 2
fi

echo "Database status: \$OUTPUT"
\`\`\`

---

## Logging

Every production script should log to a file as well as stdout/stderr.

### Simple Logging Pattern

\`\`\`bash
#!/bin/bash
SCRIPT_NAME="\$(basename \$0 .sh)"
LOG_DIR="/u01/oracle/scripts/logs"
LOG_FILE="\${LOG_DIR}/\${SCRIPT_NAME}_\$(date +%Y%m%d_%H%M%S).log"
RETAIN_DAYS=30

mkdir -p "\$LOG_DIR"

# Redirect all output (stdout + stderr) to log and terminal simultaneously
exec > >(tee -a "\$LOG_FILE") 2>&1

log() {
    echo "\$(date '+%Y-%m-%d %H:%M:%S') [\${1:-INFO}] \${2}"
}

log INFO "Script started on \$(hostname) for \$ORACLE_SID"

# ... script body ...

log INFO "Script completed"

# Purge old log files
find "\$LOG_DIR" -name "\${SCRIPT_NAME}_*.log" -mtime +\${RETAIN_DAYS} -delete
\`\`\`

---

## Common DBA Script Patterns

### Pattern 1: Tablespace Space Check

\`\`\`bash
#!/bin/bash
source /home/oracle/env/PRODDB.env

WARN_PCT=80
CRIT_PCT=90
EXIT_CODE=0

RESULT=\$(sqlplus -s / as sysdba <<'EOF'
WHENEVER SQLERROR EXIT SQL.SQLCODE
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON LINESIZE 200

SELECT tablespace_name
       || '|' || ROUND(used_pct, 1)
FROM (
    SELECT
        t.tablespace_name,
        SUM(d.bytes) / 1024 / 1024 / 1024          AS total_gb,
        SUM(NVL(f.free_bytes, 0)) / 1024 / 1024 / 1024 AS free_gb,
        (1 - SUM(NVL(f.free_bytes, 0)) / SUM(d.bytes)) * 100 AS used_pct
    FROM dba_tablespaces t
    JOIN dba_data_files d  ON t.tablespace_name = d.tablespace_name
    LEFT JOIN (
        SELECT tablespace_name, SUM(bytes) AS free_bytes
        FROM dba_free_space
        GROUP BY tablespace_name
    ) f ON t.tablespace_name = f.tablespace_name
    WHERE t.contents = 'PERMANENT'
    GROUP BY t.tablespace_name
)
ORDER BY used_pct DESC;

EXIT 0;
EOF
)

while IFS='|' read -r ts_name used_pct; do
    [[ -z "\$ts_name" ]] && continue
    used_int=\$(echo "\$used_pct" | cut -d. -f1)
    if [[ \$used_int -ge \$CRIT_PCT ]]; then
        echo "CRITICAL: \$ts_name is \${used_pct}% full"
        EXIT_CODE=2
    elif [[ \$used_int -ge \$WARN_PCT ]]; then
        echo "WARNING: \$ts_name is \${used_pct}% full"
        [[ \$EXIT_CODE -lt 2 ]] && EXIT_CODE=1
    else
        echo "OK: \$ts_name is \${used_pct}% full"
    fi
done <<< "\$RESULT"

exit \$EXIT_CODE
\`\`\`

### Pattern 2: Alert Log Error Scanner

\`\`\`bash
#!/bin/bash
source /home/oracle/env/PRODDB.env

ALERT_LOG=\$(sqlplus -s / as sysdba <<'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON
SELECT value FROM v\$parameter WHERE name = 'background_dump_dest';
EXIT 0;
EOF
)

ALERT_LOG="\${ALERT_LOG}/alert_\${ORACLE_SID}.log"

if [[ ! -f "\$ALERT_LOG" ]]; then
    echo "ERROR: Alert log not found: \$ALERT_LOG" >&2
    exit 1
fi

# Scan last 500 lines for ORA- errors (exclude known noise)
ERRORS=\$(tail -500 "\$ALERT_LOG" \
    | grep "ORA-" \
    | grep -v "ORA-00020\|ORA-00060\|ORA-01013" \
    | tail -20)

if [[ -n "\$ERRORS" ]]; then
    echo "Alert log errors found in \$ORACLE_SID:"
    echo "\$ERRORS"
    exit 2
fi

echo "No ORA- errors in last 500 lines of alert log"
exit 0
\`\`\`

### Pattern 3: Long-Running Session Detection

\`\`\`bash
#!/bin/bash
source /home/oracle/env/PRODDB.env
THRESHOLD_MINS=60

SESSIONS=\$(sqlplus -s / as sysdba <<EOF
WHENEVER SQLERROR EXIT SQL.SQLCODE
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON LINESIZE 300

SELECT s.sid || ',' || s.serial# || ',' || s.username
       || ',' || ROUND((SYSDATE - s.logon_time) * 24 * 60) || ',' || s.status
       || ',' || SUBSTR(q.sql_text, 1, 80)
FROM   v\\\$session s
LEFT JOIN v\\\$sql q ON s.sql_id = q.sql_id
WHERE  s.username IS NOT NULL
  AND  s.type     = 'USER'
  AND  (SYSDATE - s.logon_time) * 24 * 60 > \${THRESHOLD_MINS}
ORDER BY s.logon_time;

EXIT 0;
EOF
)

if [[ -z "\$SESSIONS" ]]; then
    echo "No sessions running longer than \${THRESHOLD_MINS} minutes"
    exit 0
fi

echo "Sessions running longer than \${THRESHOLD_MINS} minutes:"
echo "SID,SERIAL#,USER,MINUTES,STATUS,SQL"
echo "\$SESSIONS"
exit 1
\`\`\`

Note: \`v\\\$session\` uses triple-escaped \`\$\` inside an unquoted heredoc — the first \`\\\` escapes for the shell heredoc, leaving \`v\\\$session\` in the SQL sent to sqlplus, which sqlplus then accepts as a synonym for \`v\$session\`.

---

## Parsing sqlplus Output

sqlplus output is whitespace-padded by default. Use \`SET TRIMSPOOL ON\` and \`SET LINESIZE\` to control it, and \`awk\` or \`IFS\` to parse structured output.

### Using a Delimiter for Reliable Parsing

\`\`\`bash
# Use | as a delimiter — avoids whitespace trimming issues
OUTPUT=\$(sqlplus -s / as sysdba <<'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON LINESIZE 500

SELECT tablespace_name || '|' || status || '|' || ROUND(pct_used, 1)
FROM dba_tablespace_usage_metrics;

EXIT 0;
EOF
)

while IFS='|' read -r tsname status pct; do
    printf "%-30s %-10s %s%%\n" "\$tsname" "\$status" "\$pct"
done <<< "\$OUTPUT"
\`\`\`

### Extracting a Single Value

\`\`\`bash
DB_SIZE_GB=\$(sqlplus -s / as sysdba <<'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON

SELECT ROUND(SUM(bytes) / 1024 / 1024 / 1024, 1)
FROM   dba_data_files;

EXIT 0;
EOF
)

# Trim any whitespace
DB_SIZE_GB="\$(echo -e "\${DB_SIZE_GB}" | tr -d '[:space:]')"
echo "Database size: \${DB_SIZE_GB} GB"
\`\`\`

---

## Running Scripts Against Multiple Databases

\`\`\`bash
#!/bin/bash
# Run a space check against all databases registered in oratab

ORATAB="/etc/oratab"
SCRIPT="/home/oracle/scripts/check_tablespace.sh"
REPORT_FILE="/tmp/space_report_\$(date +%Y%m%d).txt"

> "\$REPORT_FILE"

while IFS=: read -r sid home auto_start; do
    # Skip comment lines and entries with N start flag
    [[ "\$sid" =~ ^# ]] && continue
    [[ -z "\$sid" ]]    && continue
    [[ "\$sid" == "+" ]] && continue  # skip ASM

    echo "=== \$sid ===" | tee -a "\$REPORT_FILE"
    ORACLE_SID="\$sid" ORACLE_HOME="\$home" "\$SCRIPT" 2>&1 | tee -a "\$REPORT_FILE"
    echo "" >> "\$REPORT_FILE"

done < "\$ORATAB"

echo "Report written to \$REPORT_FILE"
\`\`\`

---

## Running SQL in Parallel Across Databases

For environments with many databases, sequential execution is too slow. Use background jobs with \`wait\`:

\`\`\`bash
#!/bin/bash
DATABASES=(PRODDB DRDB TESTDB DEVDB)
RESULTS_DIR="/tmp/parallel_check_\$(date +%Y%m%d_%H%M%S)"
mkdir -p "\$RESULTS_DIR"

check_db() {
    local sid="\$1"
    local outfile="\${RESULTS_DIR}/\${sid}.out"

    ORACLE_SID="\$sid" sqlplus -s / as sysdba >\$outfile 2>&1 <<'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMSPOOL ON
SELECT instance_name || ' ' || status || ' ' || database_status
FROM   v\$instance;
EXIT 0;
EOF
}

# Launch all checks in the background
for DB in "\${DATABASES[@]}"; do
    check_db "\$DB" &
done

# Wait for all background jobs to finish
wait

# Collect results
echo "Database Status Report:"
for DB in "\${DATABASES[@]}"; do
    echo -n "\$DB: "
    cat "\${RESULTS_DIR}/\${DB}.out"
done

rm -rf "\$RESULTS_DIR"
\`\`\`

---

## Cron Scheduling

### Standard crontab Format

\`\`\`bash
# Edit crontab as oracle user
crontab -e

# m  h  dom  mon  dow  command
# Tablespace check every 30 minutes
*/30 * * * * /home/oracle/scripts/check_tablespace.sh >> /home/oracle/logs/ts_check.log 2>&1

# Alert log scan every 5 minutes
*/5  * * * * /home/oracle/scripts/scan_alert_log.sh

# Daily stats gathering at 22:00
0 22 * * * /home/oracle/scripts/gather_stats.sh PRODDB >> /home/oracle/logs/stats.log 2>&1

# Weekly backup report on Sunday at 06:00
0 6 * * 0  /home/oracle/scripts/backup_report.sh | mail -s "Weekly Backup Report" dba@corp.local
\`\`\`

### Preventing Overlapping Cron Runs

Use a lock file to prevent a second instance running if the first is still active:

\`\`\`bash
#!/bin/bash
LOCK_FILE="/tmp/\$(basename \$0 .sh).lock"

# Acquire lock
if ! mkdir "\$LOCK_FILE" 2>/dev/null; then
    echo "Script already running (lock: \$LOCK_FILE)" >&2
    exit 0
fi

# Ensure lock is always released, even on error
trap "rmdir '\$LOCK_FILE'" EXIT

# ... script body ...
\`\`\`

---

## Security: Avoiding Passwords in Scripts

Never hardcode passwords in shell scripts. Oracle provides two secure alternatives:

### Oracle Wallet (Recommended for Production)

\`\`\`bash
# Use the wallet — sqlplus reads credentials from the wallet automatically
sqlplus -s /@db_alias <<'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT COUNT(*) FROM dba_objects;
EXIT 0;
EOF
\`\`\`

The wallet alias (\`db_alias\`) is defined in \`sqlnet.ora\` and \`tnsnames.ora\`. The password is stored encrypted in the wallet, never in the script.

### OS Authentication (For DBA Scripts on the DB Server)

\`\`\`bash
# Connect as SYSDBA using OS authentication — no password required
# Works only when the OS user is in the dba group on the database server
sqlplus -s / as sysdba <<'EOF'
SELECT status FROM v\$instance;
EXIT 0;
EOF
\`\`\`

This is the simplest and most secure option for scripts running directly on the database server as the oracle user.

The companion runbook provides a complete library of production-ready DBA scripts covering health checks, space management, session management, backup verification, and performance snapshot collection.`,
};

async function main() {
  console.log('Inserting Oracle shell scripting blog post...');
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
