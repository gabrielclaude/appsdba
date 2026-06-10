import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Shell Scripting for PostgreSQL DBA Operations: Patterns and Techniques',
  slug: 'shell-scripting-postgresql-database-operations',
  excerpt:
    'A practical guide to writing production-quality shell scripts for PostgreSQL DBA work — covering environment setup, psql invocation modes, ON_ERROR_STOP exit code handling, unaligned output parsing, .pgpass credential management, pg_dump backup patterns, parallel execution across databases, and the reusable techniques that turn ad-hoc psql commands into reliable automation.',
  category: 'postgresql' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-11'),
  youtubeUrl: null,
  content: `PostgreSQL has clean, composable command-line tools. \`psql\`, \`pg_dump\`, \`pg_restore\`, \`pg_basebackup\`, \`vacuumdb\`, \`reindexdb\` — they all behave like proper Unix programs: they read environment variables, accept input on stdin, write results to stdout, and return meaningful exit codes. This makes PostgreSQL DBA work well-suited to shell automation.

This post covers the patterns that make PostgreSQL shell scripts reliable, composable, and safe to run unattended in cron.

---

## Environment Setup

psql and all PostgreSQL tools read connection parameters from environment variables. Setting these in the script header replaces the need to pass \`-h\`, \`-p\`, \`-U\`, and \`-d\` flags on every command.

\`\`\`bash
#!/bin/bash
export PGHOST=db.corp.local
export PGPORT=5432
export PGUSER=postgres
export PGDATABASE=appdb
# PGPASSWORD is read automatically — avoid it in scripts (see .pgpass below)
export PGSSLMODE=require
\`\`\`

For environments with multiple databases, source a per-database env file:

\`\`\`bash
#!/bin/bash
DB_NAME="\${1:-appdb}"
ENV_FILE="/home/postgres/env/\${DB_NAME}.env"

[[ ! -f "\$ENV_FILE" ]] && { echo "ERROR: \$ENV_FILE not found" >&2; exit 1; }
source "\$ENV_FILE"
\`\`\`

---

## Credential Management: .pgpass

Never put passwords in scripts or environment variables that leak into \`ps\` output. PostgreSQL's \`.pgpass\` file is the correct credential store for automation.

\`\`\`bash
# /home/postgres/.pgpass
# Format: hostname:port:database:username:password
db.corp.local:5432:*:postgres:s3cur3p@ss
db.corp.local:5432:appdb:appuser:app_pass

# Permissions must be 0600 — PostgreSQL ignores .pgpass with looser permissions
chmod 600 ~/.pgpass
\`\`\`

With \`.pgpass\` in place, all \`psql\`, \`pg_dump\`, and other tools connect without prompting or environment variable exposure.

For service accounts, PostgreSQL also supports **peer authentication** (OS user = database role) — the most secure option for scripts running as the \`postgres\` OS user:

\`\`\`bash
# Peer auth — no password needed when OS user matches the database role
psql -U postgres -c "SELECT 1"  # works if script runs as the postgres OS user
\`\`\`

---

## Invoking psql from Scripts

### Single Command: \`-c\`

\`\`\`bash
psql -c "SELECT version();"
\`\`\`

### Multiple Statements: Here-Doc

\`\`\`bash
psql <<'SQL'
SELECT datname, numbackends FROM pg_stat_database ORDER BY numbackends DESC;
SELECT schemaname, tablename, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 10;
SQL
\`\`\`

Use \`'SQL'\` (quoted) to prevent shell variable expansion inside the block. Use unquoted \`SQL\` when you need shell variables substituted.

### Running a SQL File

\`\`\`bash
psql -f /home/postgres/scripts/sql/check_bloat.sql
\`\`\`

### Silent Mode: \`-q\` and \`-t -A\`

\`\`\`bash
# -t  suppress column headers and row count
# -A  unaligned output (no padding)
# -F  field separator (default is |)
psql -t -A -F'|' -c "SELECT datname, numbackends FROM pg_stat_database"
# Output: postgres|3
#         appdb|47
\`\`\`

This produces clean, parseable output — the equivalent of Oracle's \`SET HEADING OFF FEEDBACK OFF\`.

---

## Exit Code Handling

By default, psql exits 0 even when a SQL statement fails. You must set \`ON_ERROR_STOP\` to make psql exit non-zero on SQL errors.

\`\`\`bash
psql -v ON_ERROR_STOP=1 -c "SELECT * FROM nonexistent_table"
echo "Exit code: \$?"
# Exit code: 3  (psql exits 3 on SQL error with ON_ERROR_STOP=1)
\`\`\`

In here-docs:

\`\`\`bash
psql -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
UPDATE accounts SET balance = balance + 100 WHERE id = 2;
COMMIT;
SQL

RC=\$?
if [[ \$RC -ne 0 ]]; then
    echo "ERROR: transaction failed (RC=\$RC)" >&2
    exit \$RC
fi
\`\`\`

**psql exit codes:**
| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Fatal error (connection failure, bad option) |
| 2 | Shell or init file error |
| 3 | SQL error (only with \`ON_ERROR_STOP=1\`) |

---

## Parsing psql Output

### Extracting a Single Value

\`\`\`bash
# -t strips headers, xargs trims whitespace
CONN_COUNT=\$(psql -t -A -c "SELECT COUNT(*) FROM pg_stat_activity" | xargs)
echo "Active connections: \$CONN_COUNT"
\`\`\`

### Parsing Multi-Column Output

Use \`-F\` to set a delimiter and IFS to split:

\`\`\`bash
psql -t -A -F'|' -c "
    SELECT datname, numbackends, xact_commit, xact_rollback
    FROM pg_stat_database
    WHERE datname NOT LIKE 'template%'
" | while IFS='|' read -r dbname backends commits rollbacks; do
    echo "DB: \$dbname  Connections: \$backends  Commits: \$commits  Rollbacks: \$rollbacks"
done
\`\`\`

### Iterating Over Result Rows in a Loop

\`\`\`bash
# Build a list in the shell and act on each item
BLOATED_TABLES=\$(psql -t -A -F'|' -c "
    SELECT schemaname, tablename
    FROM pg_stat_user_tables
    WHERE n_dead_tup > 100000
      AND n_dead_tup > n_live_tup * 0.2
")

while IFS='|' read -r schema table; do
    [[ -z "\$schema" ]] && continue
    echo "Running VACUUM ANALYZE on \${schema}.\${table}"
    psql -c "VACUUM ANALYZE \${schema}.\${table}"
done <<< "\$BLOATED_TABLES"
\`\`\`

---

## pg_dump Backup Patterns

### Custom Format Backup (Recommended)

\`\`\`bash
#!/bin/bash
source /home/postgres/env/appdb.env

BACKUP_DIR="/backups/postgres/appdb"
TIMESTAMP=\$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="\${BACKUP_DIR}/appdb_\${TIMESTAMP}.dump"

mkdir -p "\$BACKUP_DIR"

pg_dump \
  --format=custom \
  --compress=6 \
  --verbose \
  --file="\$BACKUP_FILE" \
  "\$PGDATABASE"

RC=\$?
if [[ \$RC -ne 0 ]]; then
    echo "ERROR: pg_dump failed for \$PGDATABASE" >&2
    exit 1
fi

echo "Backup complete: \$BACKUP_FILE (\$(du -sh "\$BACKUP_FILE" | cut -f1))"

# Retain 7 days
find "\$BACKUP_DIR" -name "*.dump" -mtime +7 -delete
\`\`\`

### Parallel Backup with pg_dump \`-j\` (Large Databases)

\`\`\`bash
# Directory format required for parallel (-j) — not custom format
BACKUP_DIR="/backups/postgres/appdb_\$(date +%Y%m%d_%H%M%S)"

pg_dump \
  --format=directory \
  --jobs=4 \
  --compress=6 \
  --file="\$BACKUP_DIR" \
  "\$PGDATABASE"
\`\`\`

### Cluster-Wide Backup with pg_dumpall

\`\`\`bash
# Backs up all databases + roles + tablespaces (schema only for globals)
pg_dumpall --globals-only > /backups/postgres/globals_\$(date +%Y%m%d).sql
\`\`\`

---

## Running Scripts Across All Databases

\`\`\`bash
#!/bin/bash
# Run a SQL check against every non-template database on the instance

source /home/postgres/env/postgres.env

CHECK_SQL="SELECT schemaname, tablename, n_dead_tup FROM pg_stat_user_tables WHERE n_dead_tup > 100000 ORDER BY n_dead_tup DESC LIMIT 5;"

# Get list of user databases
DATABASES=\$(psql -t -A -c "
    SELECT datname FROM pg_database
    WHERE datistemplate = false
      AND datname != 'postgres'
    ORDER BY datname
")

for DB in \$DATABASES; do
    echo "=== \$DB ==="
    psql -d "\$DB" -c "\$CHECK_SQL"
done
\`\`\`

---

## Running Checks in Parallel Across Databases

\`\`\`bash
#!/bin/bash
source /home/postgres/env/postgres.env

RESULTS_DIR=\$(mktemp -d)

check_db() {
    local db="\$1"
    psql -t -A -d "\$db" -c "
        SELECT '\$db'||'|'||COUNT(*)
        FROM pg_stat_activity
        WHERE state = 'active'
    " > "\${RESULTS_DIR}/\${db}.txt" 2>&1
}

DATABASES=\$(psql -t -A -c "SELECT datname FROM pg_database WHERE datistemplate = false AND datname != 'postgres'")

for DB in \$DATABASES; do
    check_db "\$DB" &
done
wait

echo "Active connections per database:"
cat "\${RESULTS_DIR}"/*.txt | grep -v '^$'
rm -rf "\$RESULTS_DIR"
\`\`\`

---

## Logging

\`\`\`bash
#!/bin/bash
SCRIPT_NAME="\$(basename \$0 .sh)"
LOG_DIR="/home/postgres/scripts/logs"
LOG_FILE="\${LOG_DIR}/\${SCRIPT_NAME}_\$(date +%Y%m%d_%H%M%S).log"

mkdir -p "\$LOG_DIR"
exec > >(tee -a "\$LOG_FILE") 2>&1

log() { echo "\$(date '+%Y-%m-%d %H:%M:%S') [\${1:-INFO}] \${2}"; }

log INFO "Script started: \$SCRIPT_NAME"
\`\`\`

---

## Useful psql Meta-Commands in Scripts

\`\`\`bash
# \\copy — client-side COPY (works without superuser, paths are on the client machine)
psql -c "\\copy (SELECT * FROM orders WHERE created_at > NOW() - INTERVAL '7 days') TO '/tmp/recent_orders.csv' CSV HEADER"

# Server-side COPY (requires superuser or pg_write_server_files role)
psql -c "COPY orders TO '/var/lib/postgresql/exports/orders.csv' CSV HEADER"

# Execute a command and immediately disconnect (useful for one-liners in cron)
psql -c "VACUUM ANALYZE;" -d appdb

# Connect to each database in a list and run maintenance
for DB in appdb reporting archive; do
    psql -d "\$DB" -c "ANALYZE;"
done
\`\`\`

---

## pg_dump Restore Patterns

\`\`\`bash
# Restore a custom-format dump to a new database
createdb appdb_restore
pg_restore --format=custom --jobs=4 --dbname=appdb_restore appdb_20260611.dump

# Restore a single table only
pg_restore --format=custom --table=orders --dbname=appdb appdb_20260611.dump

# List contents of a dump (no restore)
pg_restore --list appdb_20260611.dump | head -40
\`\`\`

---

## Lock Files to Prevent Overlapping Cron Runs

\`\`\`bash
LOCK_FILE="/tmp/\$(basename \$0 .sh).lock"
if ! mkdir "\$LOCK_FILE" 2>/dev/null; then
    echo "Already running — exiting" >&2
    exit 0
fi
trap "rmdir '\$LOCK_FILE'" EXIT
\`\`\`

The companion runbook provides a complete deployable library of PostgreSQL DBA scripts covering health checks, bloat monitoring, backup verification, vacuum automation, replication lag alerting, connection management, and performance snapshots.`,
};

async function main() {
  console.log('Inserting PostgreSQL shell scripting blog post...');
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
