import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Odoo 17 ERP Installation on Ubuntu 22.04 and Oracle Linux 9',
  slug: 'odoo-erp-installation-runbook-ubuntu-oracle-linux',
  excerpt:
    'Step-by-step runbook for installing Odoo 17 Community on Ubuntu 22.04 LTS or Oracle Linux 9 — PostgreSQL 16 setup, Python virtualenv, Nginx with TLS, systemd service, first-database initialization, module installation, backup configuration, and post-install health checks. Every command is copy-paste ready.',
  category: 'odoo' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-03'),
  youtubeUrl: null,
  content: `## Overview

This runbook installs Odoo 17 Community Edition on a single Linux server. It covers all steps from a fresh OS image to a running, TLS-secured Odoo instance with PostgreSQL 16, Nginx reverse proxy, and systemd process management.

**Estimated time:** 45–60 minutes on a fresh server with a reliable internet connection.

**Variables used throughout — set these before starting:**

\`\`\`bash
export ODOO_USER=odoo
export ODOO_HOME=/opt/odoo
export ODOO_VERSION=17.0
export ODOO_DB=odoo_prod
export ODOO_DB_PASS=odoo_db_password      # change this
export ODOO_MASTER_PASS=changeme_master   # change this
export ODOO_DOMAIN=erp.yourcompany.com    # change this
export PG_VERSION=16
\`\`\`

---

## Phase 1 — System Preparation

### 1.1 Ubuntu 22.04 — System Dependencies

\`\`\`bash
sudo apt update && sudo apt upgrade -y

sudo apt install -y \
  python3 python3-pip python3-dev python3-venv \
  libxml2-dev libxslt1-dev libldap2-dev libsasl2-dev \
  libssl-dev libjpeg-dev libpq-dev \
  build-essential git curl nginx certbot python3-certbot-nginx

# Node.js 18 LTS (for JavaScript/LESS asset compilation)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# wkhtmltopdf with patched Qt (required for PDF invoice/report headers)
sudo apt install -y wkhtmltopdf
wkhtmltopdf --version
# Verify output includes "with patched qt"
\`\`\`

### 1.2 Oracle Linux 9 — System Dependencies

\`\`\`bash
sudo dnf install -y epel-release
sudo dnf config-manager --set-enabled crb

sudo dnf install -y \
  python3.11 python3.11-devel python3.11-pip \
  libxml2-devel libxslt-devel openldap-devel \
  openssl-devel libjpeg-turbo-devel gcc git curl \
  nginx certbot python3-certbot-nginx

# Node.js 18 from NodeSource
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo dnf install -y nodejs

# wkhtmltopdf from GitHub release (no OL9 package)
curl -L https://github.com/wkhtmltopdf/packaging/releases/download/0.12.6.1-3/wkhtmltox-0.12.6.1-3.almalinux9.x86_64.rpm \
  -o /tmp/wkhtmltox.rpm
sudo rpm -i /tmp/wkhtmltox.rpm
wkhtmltopdf --version
\`\`\`

### 1.3 Set Kernel and System Limits

\`\`\`bash
# Increase file descriptor limits for Odoo workers
sudo tee /etc/security/limits.d/odoo.conf > /dev/null << 'EOF'
odoo soft nofile 65536
odoo hard nofile 65536
odoo soft nproc  8192
odoo hard nproc  8192
EOF

# Shared memory for PostgreSQL
sudo tee -a /etc/sysctl.d/99-odoo.conf > /dev/null << 'EOF'
kernel.shmmax = 17179869184
kernel.shmall = 4194304
vm.swappiness = 10
EOF
sudo sysctl --system
\`\`\`

---

## Phase 2 — PostgreSQL Setup

### 2.1 Ubuntu — Install PostgreSQL 16

\`\`\`bash
sudo apt install -y postgresql-16 postgresql-client-16
sudo systemctl enable --now postgresql
\`\`\`

### 2.2 Oracle Linux 9 — Install PostgreSQL 16

\`\`\`bash
sudo dnf install -y \
  https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm
sudo dnf -qy module disable postgresql
sudo dnf install -y postgresql16 postgresql16-server postgresql16-devel
sudo /usr/pgsql-16/bin/postgresql-16-setup initdb
sudo systemctl enable --now postgresql-16
\`\`\`

### 2.3 Create Odoo Database Role

\`\`\`bash
# Create database user
sudo -u postgres createuser --superuser \${ODOO_USER}

# Set password
sudo -u postgres psql -c "ALTER USER \${ODOO_USER} WITH PASSWORD '\${ODOO_DB_PASS}';"

# Verify
sudo -u postgres psql -c "\du" | grep odoo
\`\`\`

### 2.4 Configure pg_hba.conf

Ubuntu path: /etc/postgresql/16/main/pg_hba.conf
OL9 path: /var/lib/pgsql/16/data/pg_hba.conf

Add these lines above the existing local rules:

\`\`\`
# Odoo application user — md5 password authentication
local   all             odoo                            md5
host    all             odoo            127.0.0.1/32    md5
host    all             odoo            ::1/128         md5
\`\`\`

\`\`\`bash
# Ubuntu
sudo systemctl restart postgresql

# OL9
sudo systemctl restart postgresql-16

# Test connection
psql -U odoo -h 127.0.0.1 -d postgres -c "SELECT version();"
\`\`\`

### 2.5 PostgreSQL Performance Tuning

Identify the postgresql.conf path and apply settings:

\`\`\`bash
# Ubuntu
PG_CONF=/etc/postgresql/\${PG_VERSION}/main/postgresql.conf

# OL9
# PG_CONF=/var/lib/pgsql/16/data/postgresql.conf

# RAM on this server (GB) — adjust values below accordingly
FREE_RAM_GB=32

sudo tee -a \${PG_CONF} > /dev/null << EOF

# --- Odoo tuning ---
shared_buffers = 8GB
work_mem = 64MB
maintenance_work_mem = 512MB
effective_cache_size = 24GB
wal_buffers = 64MB
checkpoint_completion_target = 0.9
max_wal_size = 4GB
max_connections = 200
random_page_cost = 1.1
effective_io_concurrency = 200
EOF

# Ubuntu
sudo systemctl restart postgresql

# OL9
sudo systemctl restart postgresql-16
\`\`\`

---

## Phase 3 — Odoo Application Setup

### 3.1 Create System User and Directories

\`\`\`bash
# Ubuntu
sudo adduser --system --home \${ODOO_HOME} --group \${ODOO_USER}

# OL9
sudo useradd --system --home-dir \${ODOO_HOME} --create-home \
  --shell /sbin/nologin --user-group \${ODOO_USER}

# Create required directories
sudo mkdir -p \${ODOO_HOME}/odoo17
sudo mkdir -p \${ODOO_HOME}/custom_addons
sudo mkdir -p /var/log/odoo
sudo mkdir -p /var/lib/odoo

sudo chown -R \${ODOO_USER}:\${ODOO_USER} \${ODOO_HOME} /var/log/odoo /var/lib/odoo
\`\`\`

### 3.2 Clone Odoo Source

\`\`\`bash
sudo -u \${ODOO_USER} git clone \
  --depth 1 \
  --branch \${ODOO_VERSION} \
  https://github.com/odoo/odoo.git \
  \${ODOO_HOME}/odoo17

# Verify
ls \${ODOO_HOME}/odoo17/odoo-bin
\`\`\`

### 3.3 Python Virtual Environment

\`\`\`bash
# Ubuntu uses python3; OL9 may need python3.11 explicitly
sudo -u \${ODOO_USER} python3 -m venv \${ODOO_HOME}/venv

# Install Odoo requirements
sudo -u \${ODOO_USER} \${ODOO_HOME}/venv/bin/pip install --upgrade pip wheel
sudo -u \${ODOO_USER} \${ODOO_HOME}/venv/bin/pip install \
  -r \${ODOO_HOME}/odoo17/requirements.txt

# Production extras
sudo -u \${ODOO_USER} \${ODOO_HOME}/venv/bin/pip install \
  psycopg2-binary greenlet gevent

# Verify key packages
sudo -u \${ODOO_USER} \${ODOO_HOME}/venv/bin/pip show psycopg2-binary | grep Version
\`\`\`

### 3.4 Configuration File

\`\`\`bash
sudo mkdir -p /etc/odoo
sudo tee /etc/odoo/odoo.conf > /dev/null << EOF
[options]
http_port = 8069
longpolling_port = 8072
workers = 4
max_cron_threads = 2

db_host = 127.0.0.1
db_port = 5432
db_user = \${ODOO_USER}
db_password = \${ODOO_DB_PASS}
db_maxconn = 64

addons_path = \${ODOO_HOME}/odoo17/addons,\${ODOO_HOME}/odoo17/odoo/addons,\${ODOO_HOME}/custom_addons
data_dir = /var/lib/odoo

logfile = /var/log/odoo/odoo.log
log_level = warn
log_db = False

admin_passwd = \${ODOO_MASTER_PASS}
list_db = False

limit_memory_hard = 2684354560
limit_memory_soft = 2147483648
limit_request = 8192
limit_time_cpu = 600
limit_time_real = 1200
EOF

sudo chown root:\${ODOO_USER} /etc/odoo/odoo.conf
sudo chmod 640 /etc/odoo/odoo.conf
\`\`\`

### 3.5 systemd Service

\`\`\`bash
sudo tee /etc/systemd/system/odoo.service > /dev/null << EOF
[Unit]
Description=Odoo 17 ERP
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=\${ODOO_USER}
Group=\${ODOO_USER}
ExecStart=\${ODOO_HOME}/venv/bin/python3 \${ODOO_HOME}/odoo17/odoo-bin \\
  --config /etc/odoo/odoo.conf
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=odoo
LimitNOFILE=65536
LimitNPROC=8192

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable odoo
\`\`\`

---

## Phase 4 — Nginx and TLS

### 4.1 Obtain TLS Certificate

\`\`\`bash
# Point DNS A record for \${ODOO_DOMAIN} to this server's IP before running
sudo certbot certonly --standalone \
  --non-interactive \
  --agree-tos \
  --email admin@yourcompany.com \
  -d \${ODOO_DOMAIN}

# Verify certificate files
ls /etc/letsencrypt/live/\${ODOO_DOMAIN}/
\`\`\`

### 4.2 Nginx Configuration

\`\`\`bash
sudo tee /etc/nginx/sites-available/odoo > /dev/null << 'EOF'
upstream odoo_http {
    server 127.0.0.1:8069;
}
upstream odoo_longpoll {
    server 127.0.0.1:8072;
}

server {
    listen 80;
    server_name ODOO_DOMAIN_PLACEHOLDER;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ODOO_DOMAIN_PLACEHOLDER;

    ssl_certificate     /etc/letsencrypt/live/ODOO_DOMAIN_PLACEHOLDER/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ODOO_DOMAIN_PLACEHOLDER/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;

    client_max_body_size 200m;
    proxy_read_timeout   720s;
    proxy_connect_timeout 720s;
    proxy_send_timeout   720s;

    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    gzip on;
    gzip_types text/plain text/xml text/css application/json application/javascript;

    location /web/static/ {
        alias /opt/odoo/odoo17/addons/web/static/;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    location /longpolling {
        proxy_pass http://odoo_longpoll;
    }

    location / {
        proxy_pass http://odoo_http;
        proxy_redirect off;
    }
}
EOF

# Substitute actual domain
sudo sed -i "s/ODOO_DOMAIN_PLACEHOLDER/\${ODOO_DOMAIN}/g" \
  /etc/nginx/sites-available/odoo

# Enable site
sudo ln -s /etc/nginx/sites-available/odoo /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default   # remove default site

# Test and reload
sudo nginx -t
sudo systemctl enable --now nginx
\`\`\`

### 4.3 Firewall Rules

\`\`\`bash
# Ubuntu (ufw)
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable

# OL9 (firewalld)
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --permanent --add-service=ssh
sudo firewall-cmd --reload

# Odoo ports (8069, 8072) should NOT be open externally — Nginx proxies them
\`\`\`

---

## Phase 5 — First Database and Module Installation

### 5.1 Start Odoo and Initialize Database

\`\`\`bash
# Start Odoo service
sudo systemctl start odoo
sudo systemctl status odoo

# Watch the log during initialization
sudo journalctl -u odoo -f &

# Initialize the first database from CLI (preferred over web UI for production)
sudo -u \${ODOO_USER} \${ODOO_HOME}/venv/bin/python3 \
  \${ODOO_HOME}/odoo17/odoo-bin \
  --config /etc/odoo/odoo.conf \
  --database \${ODOO_DB} \
  --init base \
  --without-demo all \
  --stop-after-init

# Verify database was created
sudo -u postgres psql -c "\l" | grep \${ODOO_DB}
\`\`\`

### 5.2 Install Core Business Modules

Decide which modules your business needs and install them all in one pass — installing modules later is fine but each install locks the database briefly.

\`\`\`bash
# Example: accounting + inventory + sales + purchasing
sudo -u \${ODOO_USER} \${ODOO_HOME}/venv/bin/python3 \
  \${ODOO_HOME}/odoo17/odoo-bin \
  --config /etc/odoo/odoo.conf \
  --database \${ODOO_DB} \
  --init account,account_accountant,stock,purchase,sale_management \
  --without-demo all \
  --stop-after-init

# Restart Odoo after module install
sudo systemctl restart odoo
\`\`\`

### 5.3 Set Admin Password

\`\`\`bash
# Reset admin user password via psql (use when first logging in)
sudo -u postgres psql -d \${ODOO_DB} << 'EOF'
-- Odoo stores passwords as pbkdf2_sha512 hashes via the ORM.
-- Reset by setting password field NULL and triggering reset via UI,
-- or set directly via the web login after first connecting.
-- The admin_passwd in odoo.conf is the MASTER password (DB management only).
-- The admin USER password is set in Settings > Users after first login.
EOF
\`\`\`

Log in at https://\${ODOO_DOMAIN} with username: admin and the admin password set during database initialization (defaults to admin — change immediately under Settings > Users > Administrator).

---

## Phase 6 — Backup Configuration

### 6.1 Automated Daily Backup Script

\`\`\`bash
sudo tee \${ODOO_HOME}/scripts/backup_odoo.sh > /dev/null << 'SCRIPT'
#!/bin/bash
set -e

DB=odoo_prod
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=/var/backups/odoo
FILESTORE=/var/lib/odoo/.local/share/Odoo/filestore/\${DB}

mkdir -p \${BACKUP_DIR}

echo "[\$(date)] Starting Odoo backup..."

# Database dump
pg_dump -U odoo -h 127.0.0.1 -Fc \${DB} \
  > \${BACKUP_DIR}/\${DB}_\${DATE}.dump
echo "  DB dump: \${BACKUP_DIR}/\${DB}_\${DATE}.dump"

# Filestore
if [ -d "\${FILESTORE}" ]; then
  tar -czf \${BACKUP_DIR}/\${DB}_filestore_\${DATE}.tar.gz \
    -C "\${FILESTORE}" .
  echo "  Filestore: \${BACKUP_DIR}/\${DB}_filestore_\${DATE}.tar.gz"
fi

# Prune backups older than 14 days
find \${BACKUP_DIR} -name "*.dump" -mtime +14 -delete
find \${BACKUP_DIR} -name "*.tar.gz" -mtime +14 -delete

echo "[\$(date)] Backup complete."
SCRIPT

sudo chmod +x \${ODOO_HOME}/scripts/backup_odoo.sh

# Install cron (run as postgres user so pg_dump has db access)
echo "0 2 * * * \${ODOO_HOME}/scripts/backup_odoo.sh >> /var/log/odoo/backup.log 2>&1" \
  | sudo crontab -u \${ODOO_USER} -
\`\`\`

### 6.2 Test Backup Restore

\`\`\`bash
# Create test restore of the database under a different name
pg_restore -U odoo -h 127.0.0.1 \
  --create --no-owner \
  -d postgres \
  /var/backups/odoo/odoo_prod_YYYYMMDD_HHMMSS.dump

# Verify the restored database
psql -U odoo -h 127.0.0.1 -d odoo_prod_restore \
  -c "SELECT COUNT(*) FROM res_partner;"

# Drop test restore
dropdb -U odoo -h 127.0.0.1 odoo_prod_restore
\`\`\`

---

## Phase 7 — Post-Install Health Checks

### 7.1 Service Status

\`\`\`bash
# All services should show active (running)
sudo systemctl status odoo
sudo systemctl status nginx
sudo systemctl status postgresql   # Ubuntu
# sudo systemctl status postgresql-16   # OL9
\`\`\`

### 7.2 Port Check

\`\`\`bash
# Odoo HTTP and longpolling ports listening on localhost only
ss -tlnp | grep -E '8069|8072'
# Expected: 127.0.0.1:8069 and 127.0.0.1:8072 — NOT 0.0.0.0

# Nginx listening on 80 and 443
ss -tlnp | grep nginx
\`\`\`

### 7.3 TLS Certificate

\`\`\`bash
# Verify certificate is valid and shows correct domain
curl -vI https://\${ODOO_DOMAIN}/web/login 2>&1 | grep -E 'subject|issuer|SSL|HTTP'
\`\`\`

### 7.4 Odoo Log — No Errors

\`\`\`bash
# Tail the Odoo log — should show worker startup messages, no ERROR lines
sudo tail -50 /var/log/odoo/odoo.log | grep -E 'ERROR|WARNING|CRITICAL'
# Empty output = clean startup
\`\`\`

### 7.5 Database Connection Test

\`\`\`bash
psql -U odoo -h 127.0.0.1 -d \${ODOO_DB} \
  -c "SELECT COUNT(*) AS modules_installed FROM ir_module_module WHERE state = 'installed';"
\`\`\`

### 7.6 Worker Process Count

\`\`\`bash
# Verify the correct number of Odoo worker processes are running
ps aux | grep odoo-bin | grep -v grep | wc -l
# Should equal workers value in odoo.conf plus 1 (master process)
\`\`\`

### 7.7 Scheduled Actions (Cron) Running

\`\`\`bash
# Confirm cron threads are active in the log
grep 'cron' /var/log/odoo/odoo.log | tail -10
\`\`\`

### 7.8 wkhtmltopdf Test

\`\`\`bash
# Test PDF generation from the command line
wkhtmltopdf https://\${ODOO_DOMAIN}/web/login /tmp/odoo_test.pdf
ls -lh /tmp/odoo_test.pdf
# File should be > 20 KB; zero-byte output means wkhtmltopdf is failing
\`\`\`

---

## Phase 8 — Common Issues and Fixes

### Issue: Odoo starts but browser shows "502 Bad Gateway"

\`\`\`bash
# Check Odoo is actually listening on 8069
ss -tlnp | grep 8069
# If not listening: Odoo crashed during startup
sudo journalctl -u odoo --since "5 minutes ago" | grep -i error
\`\`\`

### Issue: "Connection refused" or "could not connect to server" in Odoo log

\`\`\`bash
# PostgreSQL not accepting connections
sudo -u postgres psql -c "\conninfo"
# Verify pg_hba.conf has the odoo user entry and was reloaded
sudo -u postgres psql -c "SELECT pg_reload_conf();"
# Re-test connection
psql -U odoo -h 127.0.0.1 -d postgres -c "SELECT 1;"
\`\`\`

### Issue: Workers keep restarting — "Limit Memory Hard exceeded"

\`\`\`bash
# Workers are hitting the memory limit — increase it in odoo.conf
sudo grep limit_memory_hard /etc/odoo/odoo.conf
# Increase to 3 GB (3221225472) if server has the RAM
sudo sed -i 's/limit_memory_hard = .*/limit_memory_hard = 3221225472/' /etc/odoo/odoo.conf
sudo systemctl restart odoo
\`\`\`

### Issue: PDF reports generate without headers/footers

The installed wkhtmltopdf is not the patched Qt version. Install from the wkhtmltopdf GitHub releases for the correct platform (see Phase 1 OL9 section). Headers and footers in Odoo reports require the patched Qt build.

### Issue: Module installation fails with "Table already exists"

\`\`\`bash
# A previous partial install left the database in an inconsistent state
# Remove the partially-installed module from ir_module_module and retry
psql -U odoo -h 127.0.0.1 -d \${ODOO_DB} << 'EOF'
UPDATE ir_module_module
SET state = 'uninstalled'
WHERE name = 'module_name_here'
  AND state = 'to install';
EOF
sudo systemctl restart odoo
# Then retry module install via CLI --init
\`\`\`

### Issue: Slow page loads under load

\`\`\`bash
# Check workers are not exhausted
ps aux | grep odoo-bin | grep -v grep | wc -l

# Check PostgreSQL connection count
psql -U odoo -h 127.0.0.1 -d \${ODOO_DB} \
  -c "SELECT COUNT(*) FROM pg_stat_activity WHERE datname = '\${ODOO_DB}';"

# If connections > (workers × 4), reduce db_maxconn in odoo.conf
# or increase max_connections in postgresql.conf

# Check if Nginx is buffering properly
sudo tail -50 /var/log/nginx/access.log | awk '{print \$9}' | sort | uniq -c | sort -rn
# High 502/503 counts = Odoo worker exhaustion
\`\`\`

---

## Monitoring Checklist (Daily)

\`\`\`bash
#!/bin/bash
# /opt/odoo/scripts/health_check.sh
# Run via cron: */10 * * * * /opt/odoo/scripts/health_check.sh

DOMAIN=erp.yourcompany.com
LOG=/var/log/odoo/health_check.log
ALERT=0

# 1. Odoo service
if ! systemctl is-active --quiet odoo; then
  echo "ALERT: odoo service not running" | tee -a \${LOG}
  ALERT=1
fi

# 2. Nginx service
if ! systemctl is-active --quiet nginx; then
  echo "ALERT: nginx service not running" | tee -a \${LOG}
  ALERT=1
fi

# 3. HTTP response check
HTTP_CODE=\$(curl -s -o /dev/null -w "%{http_code}" https://\${DOMAIN}/web/login)
if [ "\${HTTP_CODE}" != "200" ]; then
  echo "ALERT: HTTP \${HTTP_CODE} from https://\${DOMAIN}/web/login" | tee -a \${LOG}
  ALERT=1
fi

# 4. Odoo error rate in log (errors in last 10 minutes)
ERROR_COUNT=\$(awk -v d="\$(date -d '10 minutes ago' '+%Y-%m-%d %H:%M')" \
  '\$0 >= d && /ERROR/' /var/log/odoo/odoo.log | wc -l)
if [ "\${ERROR_COUNT}" -gt 10 ]; then
  echo "ALERT: \${ERROR_COUNT} ERROR lines in Odoo log last 10 minutes" | tee -a \${LOG}
  ALERT=1
fi

# 5. Disk space (data_dir and backup)
for DIR in /var/lib/odoo /var/backups/odoo; do
  USED=\$(df \${DIR} | tail -1 | awk '{print \$5}' | tr -d '%')
  if [ "\${USED}" -gt 85 ]; then
    echo "ALERT: \${DIR} at \${USED}% disk usage" | tee -a \${LOG}
    ALERT=1
  fi
done

# 6. PostgreSQL accepting connections
if ! psql -U odoo -h 127.0.0.1 -d \${ODOO_DB} -c "SELECT 1;" > /dev/null 2>&1; then
  echo "ALERT: PostgreSQL not accepting Odoo connections" | tee -a \${LOG}
  ALERT=1
fi

# 7. Backup file freshness (backup should exist from today or yesterday)
LATEST=\$(find /var/backups/odoo -name "*.dump" -mtime -2 | head -1)
if [ -z "\${LATEST}" ]; then
  echo "ALERT: No Odoo backup file found from the last 2 days" | tee -a \${LOG}
  ALERT=1
fi

if [ \${ALERT} -eq 1 ]; then
  mail -s "Odoo Health Alert: \$(hostname)" dba-oncall@yourcompany.com < \${LOG}
fi
\`\`\`

\`\`\`bash
sudo chmod +x \${ODOO_HOME}/scripts/health_check.sh
# Install cron
echo "*/10 * * * * \${ODOO_HOME}/scripts/health_check.sh" \
  | sudo crontab -u \${ODOO_USER} -
\`\`\`

---

## Certificate Renewal

Certbot installs a systemd timer that renews certificates automatically. Verify it is active:

\`\`\`bash
sudo systemctl status certbot.timer
sudo certbot renew --dry-run
\`\`\`

If the timer is not present (OL9 or minimal installs):

\`\`\`bash
# Add cron for renewal
echo "0 3 * * 1 certbot renew --quiet --post-hook 'systemctl reload nginx'" \
  | sudo crontab -u root -
\`\`\`

---

## Quick Reference

| Task | Command |
|------|---------|
| Start Odoo | sudo systemctl start odoo |
| Stop Odoo | sudo systemctl stop odoo |
| Restart Odoo | sudo systemctl restart odoo |
| Tail Odoo log | sudo journalctl -u odoo -f |
| Install module | odoo-bin --config ... --database DB --init module_name --stop-after-init |
| Update module | odoo-bin --config ... --database DB --update module_name --stop-after-init |
| Backup DB | pg_dump -U odoo -h 127.0.0.1 -Fc odoo_prod > backup.dump |
| Restore DB | pg_restore -U odoo -h 127.0.0.1 --create -d postgres backup.dump |
| Check workers | ps aux | grep odoo-bin | grep -v grep | wc -l |
| Check connections | psql -c "SELECT COUNT(*) FROM pg_stat_activity WHERE datname='odoo_prod';" |
| Nginx config test | sudo nginx -t |
| Reload Nginx | sudo systemctl reload nginx |
`,
};

async function main() {
  await db.insert(posts).values(post);
  console.log('Inserted:', post.slug);
}

main().catch(console.error);
