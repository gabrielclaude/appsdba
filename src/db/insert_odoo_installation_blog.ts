import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Odoo ERP: Architecture, Installation, and Production Administration on Linux',
  slug: 'odoo-erp-installation-architecture-linux',
  excerpt:
    'Odoo is a modular open-source ERP that runs on Python and PostgreSQL. This post covers the architecture of an Odoo production deployment — the server tiers, database layout, and module system — followed by a complete installation walkthrough on Ubuntu 22.04 and Oracle Linux 9, including PostgreSQL setup, Python virtual environment, Nginx reverse proxy, TLS, and systemd service management.',
  category: 'odoo' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-03'),
  youtubeUrl: null,
  content: `## Introduction

Odoo is a suite of open-source business applications — ERP, CRM, accounting, inventory, manufacturing, HR, e-commerce, and more — built on a shared Python framework with a PostgreSQL database backend. The Community edition is free under LGPL. The Enterprise edition adds the Odoo.sh cloud platform, mobile apps, accounting localisations, and Studio (no-code customization) under a commercial license.

From a database administrator's perspective, Odoo is a Python application server that talks to one PostgreSQL database per company instance. There is no Oracle, no Java EE application server, no message queue middleware to configure. The stack is deliberately simple: PostgreSQL, Python, and an HTTP server (Nginx as a reverse proxy in front of the built-in Odoo HTTP server). That simplicity makes installation and administration accessible to any DBA or Linux system administrator familiar with PostgreSQL.

This post covers the architecture in enough depth to make production decisions, then walks through a complete installation on both Ubuntu 22.04 LTS and Oracle Linux 9 — the two most common targets for Odoo production deployments.

---

## Summary

| Layer | Technology | Notes |
|-------|-----------|-------|
| Application | Odoo 17 (Python 3.10+) | WSGI app server + asset bundler |
| Database | PostgreSQL 16 | One database per Odoo instance |
| Reverse proxy | Nginx | TLS termination, static assets, longpolling |
| Process manager | systemd | Restarts on crash, manages log rotation |
| Python env | virtualenv (venv) | Isolates Odoo dependencies from system Python |
| Assets | Node.js (build only) | Required for JavaScript/LESS compilation at install |
| File storage | Local filesystem | Filestore: attachments, session files, cache |
| Multi-instance | Multiple systemd services | One Odoo process + one PostgreSQL DB per instance |

---

## Architecture

### Application Tiers

A production Odoo deployment has three logical tiers:

\`\`\`
Internet
    │ HTTPS 443
    ▼
┌─────────────────────────────────────┐
│ Nginx (reverse proxy)               │
│ • TLS termination                   │
│ • Static files (/web/static)        │
│ • Longpolling proxy → port 8072     │
│ • HTTP proxy → port 8069            │
└──────────────┬──────────────────────┘
               │ HTTP
    ┌──────────┴───────────┐
    ▼                      ▼
┌──────────────┐    ┌──────────────┐
│ Odoo :8069   │    │ Odoo :8072   │
│ (HTTP)       │    │ (Longpolling)│
│              │    │ live chat,   │
│ ORM layer    │    │ IM, bus      │
│ Business     │    └──────────────┘
│ logic        │
│ Module       │
│ framework    │
└──────┬───────┘
       │ PostgreSQL wire protocol :5432
       ▼
┌──────────────────────────────────┐
│ PostgreSQL 16                    │
│ Database: odoo_prod              │
│ User: odoo (superuser on DB)     │
│ Tables: one per Odoo model       │
│ JSONB columns: dynamic fields    │
└──────────────────────────────────┘
\`\`\`

### Database Layout

Odoo creates tables automatically during module installation. Each Odoo model (res.partner, account.move, sale.order, etc.) maps to a PostgreSQL table with the dots replaced by underscores (res_partner, account_move, sale_order). Column types follow Odoo field types: Char → varchar, Integer → int4, Float → float8, Text → text, Binary → bytea, Many2one → int4 foreign key, Many2many → a junction table.

Odoo also uses JSONB columns for dynamically added fields (created by Studio or inherited models) — these do not require ALTER TABLE, which makes development fast but can make index design non-obvious.

The filestore — binary attachments, images, PDFs — is stored on the filesystem under the data directory (typically /var/lib/odoo/.local/share/Odoo/filestore/DATABASE_NAME/), not in the database. Backups must include both PostgreSQL and the filestore directory to be complete.

### Module System

Odoo's feature set is entirely module-driven. The base module is always present. Every other feature — accounting, inventory, HR, manufacturing — is a module that adds tables, views, menus, and business logic. Modules are installed per-database, not per-server. Two Odoo databases on the same server can have different modules installed.

Community modules live in /odoo/community/addons/ and /odoo/community/odoo/addons/. Enterprise modules (if licensed) go in /odoo/enterprise/. Custom or third-party modules go in a separate addons path configured in odoo.conf.

---

## System Requirements

| Component | Minimum | Production Recommended |
|-----------|---------|----------------------|
| CPU | 2 cores | 4–8 cores |
| RAM | 4 GB | 16–32 GB |
| Disk (OS + Odoo) | 20 GB | 50 GB SSD |
| Disk (filestore + DB) | 50 GB | 500 GB+ depending on attachments |
| OS | Ubuntu 22.04 or OL9 | Ubuntu 22.04 LTS or OL9 |
| Python | 3.10+ | 3.11 |
| PostgreSQL | 13+ | 16 |
| Node.js | 14+ (build only) | 18 LTS |

Odoo is single-threaded per worker process. It scales horizontally by running multiple worker processes (configured via workers = N in odoo.conf). Each worker handles one HTTP request at a time. A production server handling 50 concurrent users typically needs 4–8 workers, each requiring ~500 MB RAM.

---

## Installation on Ubuntu 22.04 LTS

### Step 1 — System Preparation

\`\`\`bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install system dependencies
sudo apt install -y \
  python3 python3-pip python3-dev python3-venv \
  libxml2-dev libxslt1-dev libldap2-dev libsasl2-dev \
  libssl-dev libjpeg-dev libpq-dev \
  build-essential git curl \
  wkhtmltopdf \
  nodejs npm

# Verify wkhtmltopdf (required for PDF generation — reports, invoices)
wkhtmltopdf --version
# Must be >= 0.12.6 with patched Qt for headers/footers in PDFs

# Install Node.js 18 LTS (Ubuntu default may be too old)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
node --version  # should be v18.x
\`\`\`

### Step 2 — PostgreSQL Installation and Configuration

\`\`\`bash
# Install PostgreSQL 16
sudo apt install -y postgresql-16 postgresql-client-16

# Start and enable
sudo systemctl enable --now postgresql

# Create Odoo database user
# Using peer authentication from postgres user
sudo -u postgres createuser --createdb --username postgres --no-createrole --no-superuser odoo
# For simplicity on a dedicated server, grant superuser (Odoo needs to create/drop databases)
sudo -u postgres psql -c "ALTER USER odoo WITH SUPERUSER;"

# Set a password for the odoo PostgreSQL user
sudo -u postgres psql -c "ALTER USER odoo WITH PASSWORD 'odoo_db_password';"
\`\`\`

Edit /etc/postgresql/16/main/pg_hba.conf to allow the odoo OS user to connect:

\`\`\`
# TYPE  DATABASE        USER            ADDRESS         METHOD
local   all             odoo                            md5
host    all             odoo            127.0.0.1/32    md5
\`\`\`

\`\`\`bash
sudo systemctl restart postgresql
\`\`\`

### Step 3 — Create Odoo System User and Directories

\`\`\`bash
# Create odoo system user (no login shell, no password)
sudo adduser --system --home /opt/odoo --group odoo

# Create directory structure
sudo mkdir -p /opt/odoo/odoo17
sudo mkdir -p /opt/odoo/custom_addons
sudo mkdir -p /var/log/odoo
sudo mkdir -p /var/lib/odoo

# Set ownership
sudo chown odoo:odoo /opt/odoo /var/log/odoo /var/lib/odoo
\`\`\`

### Step 4 — Download Odoo 17 Source

\`\`\`bash
# Clone Odoo 17.0 Community from GitHub
sudo -u odoo git clone \
  --depth 1 \
  --branch 17.0 \
  https://github.com/odoo/odoo.git \
  /opt/odoo/odoo17

# For Enterprise (requires Odoo partner credentials):
# sudo -u odoo git clone \
#   --branch 17.0 \
#   https://USERNAME:TOKEN@github.com/odoo/enterprise.git \
#   /opt/odoo/enterprise
\`\`\`

### Step 5 — Python Virtual Environment and Dependencies

\`\`\`bash
# Create virtualenv as odoo user
sudo -u odoo python3 -m venv /opt/odoo/venv

# Activate and install Odoo Python requirements
sudo -u odoo /opt/odoo/venv/bin/pip install --upgrade pip wheel
sudo -u odoo /opt/odoo/venv/bin/pip install -r /opt/odoo/odoo17/requirements.txt

# Additional production dependencies
sudo -u odoo /opt/odoo/venv/bin/pip install \
  psycopg2-binary \
  greenlet \
  gevent
\`\`\`

### Step 6 — Odoo Configuration File

Create /etc/odoo/odoo.conf:

\`\`\`bash
sudo mkdir -p /etc/odoo
sudo tee /etc/odoo/odoo.conf > /dev/null << 'EOF'
[options]
; --- Server ---
http_port = 8069
longpolling_port = 8072
workers = 4
max_cron_threads = 2

; --- Database ---
db_host = 127.0.0.1
db_port = 5432
db_user = odoo
db_password = odoo_db_password
db_maxconn = 64

; --- Paths ---
addons_path = /opt/odoo/odoo17/addons,/opt/odoo/odoo17/odoo/addons,/opt/odoo/custom_addons
data_dir = /var/lib/odoo

; --- Logging ---
logfile = /var/log/odoo/odoo.log
log_level = warn
log_db = False

; --- Security ---
admin_passwd = CHANGE_THIS_MASTER_PASSWORD
list_db = False

; --- Performance ---
limit_memory_hard = 2684354560
limit_memory_soft = 2147483648
limit_request = 8192
limit_time_cpu = 600
limit_time_real = 1200
EOF

sudo chown root:odoo /etc/odoo/odoo.conf
sudo chmod 640 /etc/odoo/odoo.conf
\`\`\`

**Key configuration parameters:**

| Parameter | Meaning |
|-----------|---------|
| workers | Number of parallel HTTP worker processes. Set to (CPU cores × 2) + 1 for balanced load |
| max_cron_threads | Threads for scheduled actions (email sending, stock reordering, etc.) |
| admin_passwd | Master password to create/delete/restore databases from the web UI — change this |
| list_db | False hides the database list from the login page — recommended for production |
| limit_memory_hard | Kills a worker that exceeds this RSS threshold (bytes). Prevents memory leaks from killing the server |
| limit_time_real | Maximum real-time seconds for one HTTP request. Long reports may need this increased |
| data_dir | Filestore root. Back this up with the database |

### Step 7 — systemd Service

\`\`\`bash
sudo tee /etc/systemd/system/odoo.service > /dev/null << 'EOF'
[Unit]
Description=Odoo 17 Community
After=network.target postgresql.service

[Service]
Type=simple
User=odoo
Group=odoo
ExecStart=/opt/odoo/venv/bin/python3 /opt/odoo/odoo17/odoo-bin \
  --config /etc/odoo/odoo.conf
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=odoo

; --- Resource limits ---
LimitNOFILE=65536
LimitNPROC=8192

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now odoo
sudo systemctl status odoo
\`\`\`

### Step 8 — Nginx Reverse Proxy with TLS

Install Certbot and obtain a certificate:

\`\`\`bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx -d erp.yourcompany.com
\`\`\`

Create /etc/nginx/sites-available/odoo:

\`\`\`nginx
upstream odoo {
    server 127.0.0.1:8069;
}
upstream odoo_longpolling {
    server 127.0.0.1:8072;
}

server {
    listen 80;
    server_name erp.yourcompany.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name erp.yourcompany.com;

    ssl_certificate     /etc/letsencrypt/live/erp.yourcompany.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/erp.yourcompany.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    # Increase limits for file uploads and large requests
    client_max_body_size 200m;
    proxy_read_timeout   720s;
    proxy_connect_timeout 720s;
    proxy_send_timeout   720s;

    # Proxy headers
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Gzip compression
    gzip on;
    gzip_min_length 1100;
    gzip_buffers 4 32k;
    gzip_types text/plain text/xml text/css application/json application/javascript;

    # Static assets — serve directly from disk
    location /web/static/ {
        alias /opt/odoo/odoo17/addons/web/static/;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    # Longpolling (live chat, notifications)
    location /longpolling {
        proxy_pass http://odoo_longpolling;
    }

    # All other requests to Odoo HTTP server
    location / {
        proxy_pass http://odoo;
        proxy_redirect off;
    }
}
\`\`\`

\`\`\`bash
sudo ln -s /etc/nginx/sites-available/odoo /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
\`\`\`

---

## Installation on Oracle Linux 9

The Oracle Linux 9 procedure differs mainly in package management (dnf vs apt) and PostgreSQL repository setup.

\`\`\`bash
# Enable EPEL and PowerTools
sudo dnf install -y epel-release
sudo dnf config-manager --set-enabled crb

# System dependencies
sudo dnf install -y \
  python3.11 python3.11-devel python3.11-pip \
  libxml2-devel libxslt-devel openldap-devel \
  openssl-devel libjpeg-turbo-devel \
  gcc git curl nodejs npm

# wkhtmltopdf (no package available — install from GitHub release)
curl -L https://github.com/wkhtmltopdf/packaging/releases/download/0.12.6.1-3/wkhtmltox-0.12.6.1-3.almalinux9.x86_64.rpm \
  -o /tmp/wkhtmltox.rpm
sudo rpm -i /tmp/wkhtmltox.rpm

# PostgreSQL 16 from official PGDG repo
sudo dnf install -y https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm
sudo dnf -qy module disable postgresql
sudo dnf install -y postgresql16 postgresql16-server postgresql16-devel
sudo /usr/pgsql-16/bin/postgresql-16-setup initdb
sudo systemctl enable --now postgresql-16

# pg_hba.conf is at /var/lib/pgsql/16/data/pg_hba.conf on OL9
# Remaining steps (createuser, virtualenv, odoo source, conf, systemd, nginx) are identical to Ubuntu
\`\`\`

---

## First-Run Database Initialization

With Odoo running, initialize the first database through the web UI or command line:

\`\`\`bash
# Create the production database from the command line (recommended — avoids web UI exposure)
sudo -u odoo /opt/odoo/venv/bin/python3 /opt/odoo/odoo17/odoo-bin \
  --config /etc/odoo/odoo.conf \
  --database odoo_prod \
  --init base \
  --without-demo all \
  --stop-after-init

# Verify the database was created
sudo -u postgres psql -c "\l" | grep odoo_prod
\`\`\`

The --without-demo all flag prevents demo data from being loaded — always use this in production. Demo data populates the database with sample customers, products, and transactions that are difficult to remove cleanly.

After initialization, log in at https://erp.yourcompany.com with the admin user and the master password, then install modules from the Apps menu.

---

## Module Management

### Installing Modules via CLI (recommended for production)

\`\`\`bash
# Install specific modules (comma-separated)
sudo -u odoo /opt/odoo/venv/bin/python3 /opt/odoo/odoo17/odoo-bin \
  --config /etc/odoo/odoo.conf \
  --database odoo_prod \
  --init account,account_accountant,stock,purchase,sale_management \
  --without-demo all \
  --stop-after-init

# Update modules after code changes
sudo -u odoo /opt/odoo/venv/bin/python3 /opt/odoo/odoo17/odoo-bin \
  --config /etc/odoo/odoo.conf \
  --database odoo_prod \
  --update account,stock \
  --stop-after-init
\`\`\`

### Common Module Groups

| Business Area | Key Modules |
|--------------|-------------|
| Accounting | account, account_accountant, account_reports |
| Inventory | stock, stock_account |
| Manufacturing | mrp, mrp_account |
| Sales | sale_management, crm |
| Purchase | purchase |
| HR & Payroll | hr, hr_payroll |
| Project | project, timesheet |
| E-Commerce | website, website_sale |

### Placing Custom or Third-Party Addons

\`\`\`bash
# Download a third-party module and place in custom addons path
cd /opt/odoo/custom_addons
sudo -u odoo git clone https://github.com/OCA/account-financial-reporting.git \
  --branch 17.0 --depth 1

# Restart Odoo so it scans the new addons path
sudo systemctl restart odoo

# Then install via CLI or Apps menu in the UI
\`\`\`

---

## PostgreSQL Tuning for Odoo

Odoo's PostgreSQL usage is moderate-intensity OLTP — many small transactions, JSON operations, and occasional large reports. Key parameters to tune in postgresql.conf:

\`\`\`
# Memory
shared_buffers          = 4GB          # 25% of RAM on a dedicated server
work_mem                = 64MB         # Per sort/hash operation; Odoo does many GROUP BY
maintenance_work_mem    = 512MB        # VACUUM, CREATE INDEX
effective_cache_size    = 12GB         # Planner hint: 75% of RAM

# WAL and checkpoints
wal_buffers             = 64MB
checkpoint_completion_target = 0.9
max_wal_size            = 4GB

# Connections
max_connections         = 200          # workers × db_maxconn should not exceed this
\`\`\`

\`\`\`bash
sudo -u postgres psql -c "SELECT pg_reload_conf();"
\`\`\`

---

## Backup Strategy

A complete Odoo backup requires two components: the PostgreSQL database dump and the filestore directory.

\`\`\`bash
#!/bin/bash
# /opt/odoo/scripts/backup.sh
# Cron: 0 2 * * * /opt/odoo/scripts/backup.sh

DB=odoo_prod
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=/var/backups/odoo
FILESTORE=/var/lib/odoo/.local/share/Odoo/filestore/\${DB}

mkdir -p \${BACKUP_DIR}

# 1. PostgreSQL dump (compressed)
pg_dump -U odoo -Fc \${DB} > \${BACKUP_DIR}/\${DB}_\${DATE}.dump

# 2. Filestore tar (compressed)
tar -czf \${BACKUP_DIR}/\${DB}_filestore_\${DATE}.tar.gz -C \${FILESTORE} .

# 3. Remove backups older than 14 days
find \${BACKUP_DIR} -name "*.dump" -mtime +14 -delete
find \${BACKUP_DIR} -name "*.tar.gz" -mtime +14 -delete

echo "Backup complete: \${DB} \${DATE}"
\`\`\`

Odoo also has a built-in backup/restore at https://erp.yourcompany.com/web/database/manager (only if list_db = True or accessed directly). This produces a zip containing the database dump and the filestore, which is convenient for migrations between servers.

---

## Upgrading Odoo

Odoo major version upgrades (e.g., 16 → 17) require a database migration performed by Odoo's upgrade script. Minor updates (patch releases within 17.0) are a git pull and service restart.

### Minor Update (same major version)

\`\`\`bash
# Stop Odoo
sudo systemctl stop odoo

# Pull latest commits on the 17.0 branch
sudo -u odoo git -C /opt/odoo/odoo17 pull

# Update all installed modules
sudo -u odoo /opt/odoo/venv/bin/python3 /opt/odoo/odoo17/odoo-bin \
  --config /etc/odoo/odoo.conf \
  --database odoo_prod \
  --update all \
  --stop-after-init

# Start Odoo
sudo systemctl start odoo
\`\`\`

### Major Version Upgrade

Major upgrades are performed using the Odoo Upgrade platform (upgrade.odoo.com for Enterprise) or the community OpenUpgrade project. The process:

1. Backup production database and filestore
2. Run the upgrade script against a copy of the database
3. Validate on a test server
4. Run production upgrade in a maintenance window

Major upgrades cannot be done by a simple git branch switch — the database schema migrations are managed by the upgrade platform.

---

## Conclusion

Odoo on Linux with PostgreSQL is a straightforward stack compared to Oracle EBS or SAP. There is no application server cluster to manage, no Oracle Listener to configure, no RAC to size. The complexity sits inside the Python application layer and in PostgreSQL performance tuning as the database grows. The patterns that apply to PostgreSQL administration in general — shared_buffers, work_mem, VACUUM tuning, index design — apply directly to Odoo's backend.

The configuration decisions that matter most in production are: setting workers correctly (under-provisioned workers cause slow response under load; over-provisioned workers exhaust RAM), setting limit_memory_hard to catch leaking workers before they affect neighbors, and keeping the master password and list_db = False to prevent unauthorized database operations from the web UI.
`,
};

async function main() {
  await db.insert(posts).values(post);
  console.log('Inserted:', post.slug);
}

main().catch(console.error);
