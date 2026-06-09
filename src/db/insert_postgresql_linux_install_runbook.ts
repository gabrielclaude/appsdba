import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Installing and Configuring PostgreSQL on Linux',
  slug: 'postgresql-linux-install-runbook',
  excerpt:
    'Step-by-step runbook for installing PostgreSQL 16/17 on RHEL/OEL 8/9 and Ubuntu 22.04/24.04 LTS. Covers repository setup, initdb, postgresql.conf tuning, pg_hba.conf authentication, systemd service management, firewall configuration, superuser hardening, and post-install verification.',
  category: 'postgresql' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-09'),
  youtubeUrl: null,
  content: `## Purpose and Scope

This runbook installs PostgreSQL from the official PGDG (PostgreSQL Global Development Group) repository on Linux, performs initial cluster configuration, and validates a working installation. It covers:

- **RHEL / Oracle Linux (OEL) 8 and 9** via \`dnf\`
- **Ubuntu 22.04 LTS (Jammy) and 24.04 LTS (Noble)** via \`apt\`

The target PostgreSQL version is **17** (current major release as of 2026). Substitute \`17\` with \`16\` for the previous LTS version.

**Reference post:** [PostgreSQL: A Comprehensive Overview for Database Professionals](/posts/postgresql-overview)

---

## Prerequisites

| Item | Minimum | Recommended |
|------|---------|-------------|
| RAM | 1 GB | 8 GB+ for production |
| Disk (data) | 10 GB | Separate mount for \`PGDATA\` |
| OS | RHEL/OEL 8+ or Ubuntu 22.04+ | Latest minor release |
| CPU | 2 cores | 4+ cores |
| Open ports | 5432/tcp | — |
| OS user | root or sudo access | — |

All commands below run as **root** or with \`sudo\` unless the prompt shows \`postgres$\` (the PostgreSQL service account).

---

## Part 1 — RHEL / Oracle Linux 8 and 9

### 1.1 Disable the built-in PostgreSQL module

RHEL 8/9 ship a PostgreSQL AppStream module that conflicts with the PGDG repository packages. Disable it first:

\`\`\`bash
dnf -qy module disable postgresql
\`\`\`

### 1.2 Install the PGDG repository RPM

\`\`\`bash
# For RHEL/OEL 9
dnf install -y https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm

# For RHEL/OEL 8
dnf install -y https://download.postgresql.org/pub/repos/yum/reporpms/EL-8-x86_64/pgdg-redhat-repo-latest.noarch.rpm
\`\`\`

### 1.3 Install PostgreSQL server and contrib packages

\`\`\`bash
dnf install -y postgresql17-server postgresql17-contrib postgresql17
\`\`\`

Verify the installed version:

\`\`\`bash
/usr/pgsql-17/bin/postgres --version
# Expected: postgres (PostgreSQL) 17.x
\`\`\`

### 1.4 Initialise the database cluster

\`\`\`bash
/usr/pgsql-17/bin/postgresql-17-setup initdb
\`\`\`

This creates the data directory at \`/var/lib/pgsql/17/data/\` (the default \`PGDATA\` for RHEL PGDG packages) and writes the initial system catalog.

### 1.5 Enable and start the service

\`\`\`bash
systemctl enable postgresql-17
systemctl start  postgresql-17
systemctl status postgresql-17
\`\`\`

Expected status output: \`Active: active (running)\`.

---

## Part 2 — Ubuntu 22.04 / 24.04 LTS

### 2.1 Add the PGDG apt repository

\`\`\`bash
# Install prerequisites
apt-get install -y curl ca-certificates

# Add the PGDG signing key and repository
install -d /usr/share/postgresql-common/pgdg
curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc --fail \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc

sh -c 'echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
  https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list'

apt-get update
\`\`\`

### 2.2 Install PostgreSQL

\`\`\`bash
apt-get install -y postgresql-17 postgresql-contrib
\`\`\`

On Ubuntu, the PGDG apt package **automatically runs initdb** and starts the service. Confirm:

\`\`\`bash
systemctl status postgresql@17-main
pg_lsclusters
\`\`\`

\`pg_lsclusters\` shows all installed clusters with their status, port, and data directory.

The default \`PGDATA\` on Ubuntu PGDG is \`/var/lib/postgresql/17/main/\`.

---

## Part 3 — Locating Key Files

After installation, note the paths for your platform:

| File | RHEL/OEL path | Ubuntu path |
|------|---------------|-------------|
| \`PGDATA\` | \`/var/lib/pgsql/17/data/\` | \`/var/lib/postgresql/17/main/\` |
| \`postgresql.conf\` | \`\$PGDATA/postgresql.conf\` | \`/etc/postgresql/17/main/postgresql.conf\` |
| \`pg_hba.conf\` | \`\$PGDATA/pg_hba.conf\` | \`/etc/postgresql/17/main/pg_hba.conf\` |
| Server log | \`\$PGDATA/log/\` | \`/var/log/postgresql/\` |
| \`psql\` binary | \`/usr/pgsql-17/bin/psql\` | \`/usr/bin/psql\` |
| \`pg_ctl\` | \`/usr/pgsql-17/bin/pg_ctl\` | \`/usr/lib/postgresql/17/bin/pg_ctl\` |

Set \`PGDATA\` and \`PATH\` for convenience (add to \`/etc/profile.d/postgres.sh\` for persistence):

\`\`\`bash
# RHEL/OEL
export PGDATA=/var/lib/pgsql/17/data
export PATH=/usr/pgsql-17/bin:\$PATH

# Ubuntu
export PGDATA=/var/lib/postgresql/17/main
export PATH=/usr/lib/postgresql/17/bin:\$PATH
\`\`\`

---

## Part 4 — postgresql.conf Baseline Configuration

Edit \`postgresql.conf\` with your preferred editor. The settings below are a reasonable starting point for a dedicated database server. Uncomment lines and adjust values — all parameters are in this file, commented out at their compiled defaults.

\`\`\`bash
# Open the file (adjust path for Ubuntu)
vi \$PGDATA/postgresql.conf
\`\`\`

### Connection settings

\`\`\`ini
# Accept connections from all interfaces (or specify an IP)
listen_addresses = '*'

# Default port — change only if running multiple clusters
port = 5432

# Maximum concurrent client connections
# Rule of thumb: do not exceed RAM / (work_mem * expected concurrent queries)
max_connections = 200
\`\`\`

### Memory settings

\`\`\`ini
# Shared buffer cache — 25% of RAM up to 8 GB
shared_buffers = 2GB

# Per-sort/hash operation memory — keep conservative in shared environments
work_mem = 16MB

# Used by VACUUM, CREATE INDEX — can be set higher
maintenance_work_mem = 256MB

# Estimate of effective OS + PostgreSQL cache size — used only by the planner
effective_cache_size = 6GB
\`\`\`

### WAL and checkpointing

\`\`\`ini
# WAL level: 'replica' for streaming replication, 'logical' for logical replication
wal_level = replica

# Maximum WAL accumulation before a checkpoint is forced
max_wal_size = 2GB
min_wal_size = 512MB

# Time between automatic checkpoints
checkpoint_timeout = 10min

# Spread checkpoint I/O over this fraction of checkpoint_timeout
checkpoint_completion_target = 0.9
\`\`\`

### Logging

\`\`\`ini
# Log destination — 'stderr' writes to the systemd journal on RHEL; 'csvlog' for structured logs
log_destination = 'stderr'
logging_collector = on
log_directory = 'log'
log_filename = 'postgresql-%Y-%m-%d_%H%M%S.log'
log_rotation_age = 1d
log_rotation_size = 100MB

# Log slow queries — essential for performance tuning
log_min_duration_statement = 1000   # log queries taking > 1 second
log_checkpoints = on
log_connections = on
log_disconnections = on
log_lock_waits = on
log_temp_files = 0       # log all temp file creation (set to -1 to disable)

# Include query parameters in slow query logs
log_line_prefix = '%m [%p] %q%u@%d '
\`\`\`

### Autovacuum

Leave autovacuum enabled (it is on by default). These are conservative adjustments for a busier server:

\`\`\`ini
autovacuum = on
autovacuum_max_workers = 4
autovacuum_naptime = 1min
autovacuum_vacuum_scale_factor = 0.05    # vacuum when 5% of table is dead tuples
autovacuum_analyze_scale_factor = 0.02  # analyze when 2% of table has changed
\`\`\`

---

## Part 5 — pg_hba.conf: Client Authentication

\`pg_hba.conf\` controls which users can connect from which addresses using which authentication methods. Entries are evaluated top-to-bottom; the first match wins.

\`\`\`bash
vi \$PGDATA/pg_hba.conf
\`\`\`

Replace the default content with a production-safe baseline:

\`\`\`
# TYPE  DATABASE        USER            ADDRESS                 METHOD

# Local OS socket connections — trust for postgres superuser via peer auth
local   all             postgres                                peer
local   all             all                                     md5

# IPv4 loopback
host    all             all             127.0.0.1/32            md5

# IPv6 loopback
host    all             all             ::1/128                 md5

# Application server subnet — restrict to your actual app server CIDR
host    all             all             10.0.1.0/24             scram-sha-256

# Replication connections (required if setting up streaming replication)
local   replication     all                                     peer
host    replication     replication     10.0.1.0/24             scram-sha-256
\`\`\`

**Authentication method notes:**

| Method | Use case |
|--------|---------|
| \`peer\` | OS socket connections — maps the connecting OS user to a PostgreSQL role. Safest for local superuser access. |
| \`scram-sha-256\` | Password authentication using SCRAM (recommended for all network connections — more secure than \`md5\`) |
| \`md5\` | Legacy password authentication — use \`scram-sha-256\` for new deployments |
| \`trust\` | No password required — only safe on loopback for development clusters |

---

## Part 6 — Apply Configuration and Reload

Some parameters require a full restart; others take effect on reload.

\`\`\`bash
# Reload only (pg_hba.conf changes, most postgresql.conf changes)
systemctl reload postgresql-17          # RHEL
systemctl reload postgresql@17-main     # Ubuntu

# Full restart (required for listen_addresses, port, shared_buffers, max_connections)
systemctl restart postgresql-17         # RHEL
systemctl restart postgresql@17-main    # Ubuntu
\`\`\`

Check which parameters require restart:

\`\`\`sql
SELECT name, setting, pending_restart
FROM   pg_settings
WHERE  pending_restart = true;
\`\`\`

---

## Part 7 — Set the Superuser Password

By default the \`postgres\` OS user can connect via peer authentication with no password. Set a password for network access and vault it immediately.

\`\`\`bash
# Switch to the postgres OS user
sudo -i -u postgres

# Connect via psql and set the password
psql -c "ALTER USER postgres PASSWORD 'YourStrongPassword123!';"
\`\`\`

Or from root using a heredoc:

\`\`\`bash
sudo -u postgres psql <<'EOF'
ALTER USER postgres PASSWORD 'YourStrongPassword123!';
\pset format unaligned
SELECT usename, passwd IS NOT NULL AS has_password FROM pg_shadow WHERE usename = 'postgres';
EOF
\`\`\`

---

## Part 8 — Create a Service Account and Database

Do not use the \`postgres\` superuser for application connections. Create a dedicated role and database:

\`\`\`bash
sudo -u postgres psql <<'EOF'
-- Create an application role with login
CREATE ROLE appuser WITH LOGIN PASSWORD 'AppUserPassword456!' CONNECTION LIMIT 50;

-- Create the application database owned by the role
CREATE DATABASE appdb OWNER appuser ENCODING 'UTF8' LC_COLLATE 'en_US.UTF-8' LC_CTYPE 'en_US.UTF-8';

-- Grant connect privilege (already implied by ownership, but explicit is clearer)
GRANT CONNECT ON DATABASE appdb TO appuser;

-- Verify
\l appdb
\du appuser
EOF
\`\`\`

---

## Part 9 — Firewall Configuration

### RHEL / OEL (firewalld)

\`\`\`bash
firewall-cmd --permanent --add-port=5432/tcp
firewall-cmd --reload
firewall-cmd --list-ports   # should include 5432/tcp
\`\`\`

### Ubuntu (ufw)

\`\`\`bash
ufw allow 5432/tcp
ufw status
\`\`\`

Restrict to specific source addresses where possible:

\`\`\`bash
# RHEL — allow only from the application server subnet
firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="10.0.1.0/24" port port="5432" protocol="tcp" accept'
firewall-cmd --reload

# Ubuntu — allow only from a specific host
ufw allow from 10.0.1.50 to any port 5432
\`\`\`

---

## Part 10 — Post-Install Verification

Run these checks to confirm the installation is healthy before connecting applications.

### 10.1 Confirm cluster is running and accepting connections

\`\`\`bash
sudo -u postgres psql -c "SELECT version();"
sudo -u postgres psql -c "SELECT pg_postmaster_start_time();"
\`\`\`

### 10.2 Check all background processes are running

\`\`\`bash
ps aux | grep postgres | grep -v grep
\`\`\`

Expected processes: \`postgres: checkpointer\`, \`postgres: background writer\`, \`postgres: walwriter\`, \`postgres: autovacuum launcher\`.

### 10.3 Verify configuration was applied

\`\`\`sql
sudo -u postgres psql <<'EOF'
SELECT name, setting, unit, source
FROM   pg_settings
WHERE  name IN (
    'listen_addresses', 'port', 'max_connections',
    'shared_buffers', 'work_mem', 'maintenance_work_mem',
    'wal_level', 'max_wal_size', 'log_min_duration_statement',
    'autovacuum'
)
ORDER BY name;
EOF
\`\`\`

### 10.4 Confirm pg_hba.conf is effective

\`\`\`sql
sudo -u postgres psql -c "SELECT type, database, user_name, address, auth_method FROM pg_hba_file_rules;"
\`\`\`

### 10.5 Test network connection from the application server

From the application host:

\`\`\`bash
psql -h <db_server_ip> -U appuser -d appdb -c "SELECT current_database(), current_user, inet_server_addr();"
\`\`\`

### 10.6 Verify autovacuum is running

\`\`\`sql
sudo -u postgres psql <<'EOF'
SELECT schemaname, relname, last_autovacuum, last_autoanalyze, n_dead_tup
FROM   pg_stat_user_tables
ORDER BY n_dead_tup DESC NULLS LAST
LIMIT 10;
EOF
\`\`\`

### 10.7 Check for any startup warnings in the log

\`\`\`bash
# RHEL/OEL
journalctl -u postgresql-17 --since "1 hour ago" | grep -E "WARN|ERROR|FATAL"

# Ubuntu
grep -E "WARN|ERROR|FATAL" /var/log/postgresql/postgresql-17-main.log | tail -20
\`\`\`

---

## Part 11 — Enable pg_stat_statements (Recommended)

This extension is essential for query performance monitoring. Enable it before any application load hits the database.

\`\`\`bash
# Add to postgresql.conf
echo "shared_preload_libraries = 'pg_stat_statements'" >> \$PGDATA/postgresql.conf
echo "pg_stat_statements.track = all" >> \$PGDATA/postgresql.conf

# Restart is required for shared_preload_libraries
systemctl restart postgresql-17    # RHEL
systemctl restart postgresql@17-main  # Ubuntu

# Create the extension in each database you want to monitor
sudo -u postgres psql -d appdb -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;"
\`\`\`

Verify:

\`\`\`sql
sudo -u postgres psql -d appdb <<'EOF'
SELECT query, calls, total_exec_time, mean_exec_time, rows
FROM   pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
EOF
\`\`\`

---

## Post-Install Checklist

- [ ] PostgreSQL service running and enabled at boot (\`systemctl is-enabled\`)
- [ ] \`postgres\` superuser password set and stored in vault
- [ ] Application role and database created (no direct \`postgres\` user connections from application)
- [ ] \`pg_hba.conf\` restricts network access to known CIDR ranges
- [ ] \`listen_addresses\`, \`shared_buffers\`, \`max_connections\` tuned for the server's RAM
- [ ] \`log_min_duration_statement\` set (slow query logging active)
- [ ] Firewall rule allowing port 5432 only from application subnet
- [ ] \`pg_stat_statements\` extension installed
- [ ] Verified connectivity from application server via \`psql\` or \`pg_isready\`
- [ ] Backup strategy planned — at minimum, schedule \`pg_basebackup\` or configure WAL archiving

---

## Quick Reference

\`\`\`bash
# Service management (RHEL)
systemctl start   postgresql-17
systemctl stop    postgresql-17
systemctl restart postgresql-17
systemctl reload  postgresql-17
systemctl status  postgresql-17

# Connect as postgres superuser
sudo -u postgres psql

# Connect to a specific database as a specific user
psql -h localhost -U appuser -d appdb

# Check cluster is accepting connections (returns 0 = accepting, 1 = rejecting, 2 = no response)
pg_isready -h localhost -p 5432

# View current activity
sudo -u postgres psql -c "SELECT pid, usename, application_name, state, query FROM pg_stat_activity WHERE state != 'idle';"

# Show database sizes
sudo -u postgres psql -c "SELECT datname, pg_size_pretty(pg_database_size(datname)) FROM pg_database ORDER BY pg_database_size(datname) DESC;"

# Reload configuration without restart
sudo -u postgres psql -c "SELECT pg_reload_conf();"
\`\`\``,
};

async function main() {
  console.log('Inserting PostgreSQL Linux install runbook...');
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
