import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const blogPost = {
  title: 'Oracle GoldenGate 21c Installation: Microservices Architecture on Linux',
  slug: 'goldengate-21c-installation-microservices',
  excerpt:
    'A practical guide to installing Oracle GoldenGate 21c using the Microservices Architecture on Linux — covering the shift from classic GGSCI to the REST API service model, component topology, source and target Oracle database prerequisites, deployment creation, and Extract/Replicat setup.',
  category: 'golden-gate' as const,
  published: true,
  publishedAt: new Date('2026-06-03'),
  isPremium: false,
  youtubeUrl: null,
  content: `Oracle GoldenGate 21c marks the point at which the Microservices Architecture (MA) became the dominant deployment model. The classic \`ggsci\` command-line is still present, but new installations default to MA — a collection of REST API-driven services with a web-based management console, centralised credential management, and built-in metrics. If you are familiar with GoldenGate 12c or 19c Classic, the mental model is different enough to cause confusion on first contact.

This post covers what changed, how the architecture works, and the key decisions to make before you start installing.

---

## What Changed in GoldenGate 21c

### Microservices Architecture is the Default

GoldenGate MA was introduced in 12.3, but 21c is the first release where Oracle's documentation, tooling, and certification focus is firmly on MA rather than Classic. The key architectural difference is that GoldenGate processes — Extract, Replicat, Distribution Paths, Receiver — are no longer managed by a single \`mgr\` process and a flat parameter file directory. Instead they run as named deployments inside a service container, managed via HTTP REST calls or the browser-based administration console.

### Five Service Components

A full MA deployment consists of five microservices:

| Service | Default Port | Purpose |
|---|---|---|
| **Service Manager** | 9011 | Root service; manages and monitors deployments |
| **Administration Server** | 9012 | Manages Extract and Replicat within a deployment |
| **Distribution Server** | 9013 | Sends trail files to remote targets |
| **Receiver Server** | 9014 | Receives trail files from remote sources |
| **Performance Metrics Server** | 9015 | Collects and exposes process metrics |

All services expose REST APIs. The web console is served by the Administration Server on its port.

### Deployment vs Installation

In GoldenGate 21c these are separate concepts:

- **Installation** — unzipping the GoldenGate software to \`OGG_HOME\`. This happens once per server.
- **Deployment** — a named instance of the GoldenGate services, with its own port range, credential store, trail file directory, and parameter files. One installation can host multiple deployments (e.g. one for PROD, one for UAT).

Each deployment has its own \`OGG_VAR_HOME\` directory containing the deployment's runtime state, parameter files, trail files, checkpoints, and log files.

### REST API and GGSCI

All management operations can be performed via:
1. **REST API** — \`curl\` or any HTTP client; full CRUD for all GoldenGate objects
2. **Admin Client** (\`adminclient\` binary) — a command-line client that speaks to the REST API; syntax is similar to classic \`ggsci\`
3. **Web Console** — browser UI served on the Administration Server port

For scripted deployments and runbooks, the Admin Client is the most practical. The web console is useful for initial exploration and monitoring.

---

## Architecture: Oracle-to-Oracle Replication Topology

\`\`\`
┌──────────────────────────────────────────────────────────────────┐
│  Source Server (RHEL 8)         Target Server (RHEL 8)           │
│                                                                  │
│  ┌───────────────────────┐      ┌────────────────────────────┐   │
│  │  GoldenGate MA        │      │  GoldenGate MA             │   │
│  │  Deployment: SRC      │      │  Deployment: TGT           │   │
│  │                       │      │                            │   │
│  │  [Extract: EXT_ORCL]  │─────▶│  [Receiver Server]        │   │
│  │  reads redo logs      │ TCP  │  [Replicat: REP_ORCL]     │   │
│  │  writes trail files   │ 9014 │  applies changes to DB    │   │
│  │                       │      │                            │   │
│  │  [Distribution Srv]   │      │                            │   │
│  │  sends trail to TGT   │      │                            │   │
│  └──────────┬────────────┘      └─────────────┬──────────────┘   │
│             │                                 │                  │
│  ┌──────────▼────────────┐      ┌─────────────▼──────────────┐   │
│  │  Oracle DB 19c        │      │  Oracle DB 19c             │   │
│  │  (source)             │      │  (target)                  │   │
│  │  ARCHIVELOG mode      │      │  No extra config needed    │   │
│  │  Supplemental logging │      │                            │   │
│  │  GGS admin user       │      │  GGS admin user            │   │
│  └───────────────────────┘      └────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
\`\`\`

---

## Source Database Prerequisites

GoldenGate Extract reads from the Oracle redo log stream. The source database must be configured before Extract can start.

### 1. ARCHIVELOG Mode

\`\`\`sql
-- Confirm archive log mode
SELECT log_mode FROM v\$database;
-- If NOARCHIVELOG: shutdown, mount, enable, open
SHUTDOWN IMMEDIATE;
STARTUP MOUNT;
ALTER DATABASE ARCHIVELOG;
ALTER DATABASE OPEN;
\`\`\`

### 2. Supplemental Logging

GoldenGate requires supplemental logging to capture the before-image of changed rows (needed for UPDATE and DELETE replication).

\`\`\`sql
-- Minimum: enable supplemental log data at database level
ALTER DATABASE ADD SUPPLEMENTAL LOG DATA;

-- For integrated extract (recommended for 19c+): enable all column logging
-- This captures all columns, not just the primary key, for every changed row.
-- Increases redo volume; right-size per-table if redo volume is a concern.
ALTER DATABASE ADD SUPPLEMENTAL LOG DATA ALL COLUMNS;

-- Alternatively, enable per-schema or per-table:
ALTER TABLE hr.employees ADD SUPPLEMENTAL LOG DATA ALL COLUMNS;

-- Confirm
SELECT supplemental_log_data_min,
       supplemental_log_data_pk,
       supplemental_log_data_ui,
       supplemental_log_data_fk,
       supplemental_log_data_all
FROM   v\$database;
\`\`\`

### 3. Enable GoldenGate Replication Parameter

\`\`\`sql
-- Required for Integrated Extract on Oracle 11.2.0.4+
ALTER SYSTEM SET enable_goldengate_replication = TRUE SCOPE=BOTH;

-- Confirm
SHOW PARAMETER enable_goldengate_replication;
\`\`\`

### 4. GoldenGate Database User

\`\`\`sql
-- Create GoldenGate admin user on source
CREATE USER c##ggadmin IDENTIFIED BY GG_Change_Me_21c
  DEFAULT TABLESPACE users
  TEMPORARY TABLESPACE temp
  QUOTA UNLIMITED ON users;

-- Required privileges for Integrated Extract
EXEC DBMS_GOLDENGATE_AUTH.GRANT_ADMIN_PRIVILEGE(
  username    => 'c##ggadmin',
  privilege_type => 'capture',
  grant_select_privileges => TRUE,
  do_grants => TRUE
);

GRANT CREATE SESSION, ALTER SESSION TO c##ggadmin;
GRANT RESOURCE TO c##ggadmin;
GRANT SELECT ANY DICTIONARY TO c##ggadmin;
GRANT SELECT ANY TABLE TO c##ggadmin;
GRANT FLASHBACK ANY TABLE TO c##ggadmin;
GRANT EXECUTE ON DBMS_FLASHBACK TO c##ggadmin;
\`\`\`

### 5. Target Database User

\`\`\`sql
-- Create GoldenGate admin user on target
CREATE USER ggadmin IDENTIFIED BY GG_Change_Me_21c
  DEFAULT TABLESPACE users
  TEMPORARY TABLESPACE temp
  QUOTA UNLIMITED ON users;

EXEC DBMS_GOLDENGATE_AUTH.GRANT_ADMIN_PRIVILEGE(
  username    => 'ggadmin',
  privilege_type => 'apply',
  grant_select_privileges => TRUE,
  do_grants => TRUE
);

GRANT CREATE SESSION, ALTER SESSION, RESOURCE TO ggadmin;
-- Replicat needs DML privilege on target schemas
GRANT INSERT, UPDATE, DELETE ON hr.employees TO ggadmin;
-- Or: GRANT DBA TO ggadmin;  (simpler for lab; restrict in production)
\`\`\`

---

## GoldenGate 21c Software

GoldenGate 21c is available from Oracle's eDelivery or My Oracle Support. The media for Oracle-to-Oracle replication on Linux x86-64 is:

\`OGG_LINUX_X64_Oracle_services_21.x.x.x.zip\`

Download this to \`/tmp\` on both source and target servers. The same software is installed on both — the deployment configuration determines whether a server acts as source, target, or both.

---

## Key Installation Decisions

**Port range.** Each deployment needs five consecutive ports. The default is 9011–9015 for the first deployment. If you run multiple deployments on one server, plan your port assignments in advance.

**Deployment directory.** Separate \`OGG_HOME\` (software) from \`OGG_VAR_HOME\` (deployment data). Software can be shared; deployment directories must be unique per deployment and should live on a filesystem with enough space for trail files.

**Security wallet.** GoldenGate MA uses an Oracle Wallet (\`CREDENTIAL STORE\`) for database credentials. The wallet is created per deployment and stored in \`OGG_VAR_HOME\`. Never put database passwords in parameter files.

**Trail file sizing.** Default trail file size is 500 MB. For high-throughput sources, increase this to 1 GB or more to reduce the number of trail files and improve Distribution Server efficiency.

The runbook that accompanies this post provides the complete step-by-step installation with scripts for both source and target, deployment creation, Extract/Replicat setup, and post-install validation.
`,
};

const runbookPost = {
  title: 'Runbook: Oracle GoldenGate 21c Microservices Installation — Oracle to Oracle',
  slug: 'goldengate-21c-installation-microservices-runbook',
  excerpt:
    'Step-by-step installation scripts for Oracle GoldenGate 21c Microservices Architecture — OS preparation, software deployment, Service Manager startup, credential store creation, Integrated Extract, Distribution Path, and Replicat configuration for Oracle-to-Oracle replication, with full validation.',
  category: 'golden-gate' as const,
  published: true,
  publishedAt: new Date('2026-06-03'),
  isPremium: true,
  youtubeUrl: null,
  content: `This runbook completes the Oracle GoldenGate 21c installation described in the [companion blog post](/posts/goldengate-21c-installation-microservices). Run all scripts in order. Source and target servers follow the same OS and software installation steps; divergence begins at Script 5 (database configuration).

**Environment assumptions:**
- Source and Target: Oracle Linux 8 / RHEL 8
- Oracle Database 19c (CDB with PDB, or non-CDB)
- GoldenGate 21c media: \`OGG_LINUX_X64_Oracle_services_21.x.x.x.zip\`
- Replicating schema: \`HR\` (source) → \`HR\` (target)

Set these on both servers before starting:

\`\`\`bash
export OGG_HOME=/u01/app/oracle/goldengate/21c
export OGG_VAR_HOME=/u01/app/oracle/gg_deployments/ora21c
export OGG_MEDIA=/tmp/OGG_LINUX_X64_Oracle_services_21.3.0.0.zip
export OGG_DEPLOYMENT=ora21c
export OGG_SM_PORT=9011           # Service Manager port
export OGG_ADMIN_PORT=9012        # Administration Server port
export OGG_DIST_PORT=9013         # Distribution Server port
export OGG_RECV_PORT=9014         # Receiver Server port
export OGG_PM_PORT=9015           # Performance Metrics Server port
export OGG_ADMIN_USER=oggadmin    # GoldenGate web console admin user
export DB_CONN_SRC=ORCLSRC        # TNS alias for source Oracle DB
export DB_CONN_TGT=ORCLTGT        # TNS alias for target Oracle DB
export ORACLE_HOME=/u01/app/oracle/product/19.3.0/dbhome_1
export PATH=\${ORACLE_HOME}/bin:\${OGG_HOME}/bin:\${PATH}
export LD_LIBRARY_PATH=\${ORACLE_HOME}/lib:\${LD_LIBRARY_PATH:-}
\`\`\`

---

## Script 1: OS Preparation (Both Servers — Run as Root)

\`\`\`bash
#!/bin/bash
# gg21c_os_prep.sh — prepare RHEL 8 / OL 8 for GoldenGate 21c MA
# Run as root on both source and target servers

set -euo pipefail
echo "[$(date +%H:%M:%S)] Preparing OS for GoldenGate 21c..."

# ── Packages ──────────────────────────────────────────────────────────────
dnf install -y \
  binutils \
  compat-openssl10 \
  glibc \
  glibc-devel \
  ksh \
  libaio \
  libgcc \
  libstdc++ \
  libstdc++-devel \
  libnsl \
  make \
  net-tools \
  sysstat \
  unzip

# ── Oracle / GoldenGate user ──────────────────────────────────────────────
id oracle &>/dev/null || {
  groupadd -g 54321 oinstall
  groupadd -g 54322 dba
  useradd -u 54321 -g oinstall -G dba -d /home/oracle -s /bin/bash oracle
  echo "[$(date +%H:%M:%S)] oracle user created"
}

# ── Kernel parameters ─────────────────────────────────────────────────────
cat > /etc/sysctl.d/98-goldengate.conf << 'SYSCTL'
fs.file-max = 6815744
fs.aio-max-nr = 1048576
net.ipv4.ip_local_port_range = 9000 65500
net.core.rmem_default = 262144
net.core.rmem_max = 4194304
net.core.wmem_default = 262144
net.core.wmem_max = 1048576
vm.swappiness = 10
SYSCTL
sysctl --system

# ── Security limits ───────────────────────────────────────────────────────
cat > /etc/security/limits.d/98-goldengate.conf << 'LIMITS'
oracle   soft   nofile    65536
oracle   hard   nofile    65536
oracle   soft   nproc     16384
oracle   hard   nproc     16384
oracle   soft   stack     10240
oracle   hard   stack     32768
LIMITS

# ── Firewall: open GoldenGate MA ports ───────────────────────────────────
for PORT in 9011 9012 9013 9014 9015; do
  firewall-cmd --permanent --add-port=\${PORT}/tcp 2>/dev/null && \
    echo "[$(date +%H:%M:%S)] Opened port \$PORT" || true
done
firewall-cmd --reload 2>/dev/null || true

# ── Directory structure ────────────────────────────────────────────────────
mkdir -p \${OGG_HOME} \${OGG_VAR_HOME}/{deployments,etc,temp,logs}
mkdir -p \${OGG_VAR_HOME}/deployments/\${OGG_DEPLOYMENT}/{var,etc,temp,logs,trails}
chown -R oracle:oinstall /u01/app/oracle/goldengate /u01/app/oracle/gg_deployments
chmod -R 755 /u01/app/oracle/goldengate /u01/app/oracle/gg_deployments

echo "[$(date +%H:%M:%S)] OS preparation complete"
\`\`\`

---

## Script 2: Install GoldenGate 21c Software (Both Servers — Run as oracle)

\`\`\`bash
#!/bin/bash
# gg21c_install_software.sh — unzip and verify GoldenGate 21c
# Run as oracle user

set -euo pipefail
source ~/.bash_profile

[ -f "\$OGG_MEDIA" ] || { echo "ERROR: Media not found at \$OGG_MEDIA"; exit 1; }

echo "[$(date +%H:%M:%S)] Installing GoldenGate 21c to \$OGG_HOME..."
unzip -q "\$OGG_MEDIA" -d "\$OGG_HOME"

# Verify key binaries
for BIN in adminclient ServiceManager; do
  [ -f "\${OGG_HOME}/bin/\${BIN}" ] || { echo "ERROR: \$BIN not found after unzip"; exit 1; }
done

echo "[$(date +%H:%M:%S)] GoldenGate 21c software installed"
ls -la "\${OGG_HOME}/bin/" | head -20

# ── GoldenGate environment in oracle bash profile ──────────────────────────
grep -q OGG_HOME ~/.bash_profile 2>/dev/null || cat >> ~/.bash_profile << PROFILE

# GoldenGate 21c
export OGG_HOME=\${OGG_HOME}
export OGG_VAR_HOME=\${OGG_VAR_HOME}
export PATH=\\\$OGG_HOME/bin:\\\$PATH
export LD_LIBRARY_PATH=\\\$OGG_HOME/lib:\\\$ORACLE_HOME/lib:\\\${LD_LIBRARY_PATH:-}
PROFILE

echo "[$(date +%H:%M:%S)] Installation complete. Source ~/.bash_profile before proceeding."
\`\`\`

---

## Script 3: Create and Start the Service Manager (Both Servers — Run as oracle)

The Service Manager is the root service for all GoldenGate MA deployments. It must be running before any deployment can start.

\`\`\`bash
#!/bin/bash
# gg21c_create_service_manager.sh — create deployment and start Service Manager
# Run as oracle user

set -euo pipefail
source ~/.bash_profile

# ── Read admin password securely ─────────────────────────────────────────
read -rsp "Set GoldenGate Admin Console password: " OGG_ADMIN_PASS; echo
read -rsp "Confirm password: " OGG_ADMIN_PASS2; echo
[ "\$OGG_ADMIN_PASS" = "\$OGG_ADMIN_PASS2" ] || { echo "Passwords do not match."; exit 1; }

# ── Generate Service Manager configuration ────────────────────────────────
SM_CONFIG="\${OGG_VAR_HOME}/etc/conf/ogg/ServiceManager.cfg"
mkdir -p "\$(dirname \$SM_CONFIG)"

cat > "\$SM_CONFIG" << SMCFG
{
  "config" : {
    "deployments" : [ ],
    "network" : {
      "serviceManagerNetwork" : {
        "host"        : "0.0.0.0",
        "port"        : \${OGG_SM_PORT},
        "tls"         : false,
        "tlsCertPath" : ""
      }
    }
  }
}
SMCFG

echo "[$(date +%H:%M:%S)] Service Manager config written to \$SM_CONFIG"

# ── Start Service Manager ─────────────────────────────────────────────────
nohup "\${OGG_HOME}/bin/ServiceManager" \
  --config "\$SM_CONFIG" \
  --deployment-home "\${OGG_VAR_HOME}" \
  > "\${OGG_VAR_HOME}/logs/ServiceManager.log" 2>&1 &

SM_PID=\$!
echo "\$SM_PID" > "\${OGG_VAR_HOME}/ServiceManager.pid"

echo "[$(date +%H:%M:%S)] Service Manager started (PID \$SM_PID)"

# Wait for Service Manager to be ready
echo -n "  Waiting for Service Manager on port \${OGG_SM_PORT} ..."
for i in \$(seq 1 30); do
  curl -s -o /dev/null -w "%{http_code}" \
    "http://localhost:\${OGG_SM_PORT}" 2>/dev/null | grep -q "200\|401" && {
    echo " ready."
    break
  }
  sleep 2; echo -n "."
  [ "\$i" -eq 30 ] && { echo " TIMEOUT"; exit 1; }
done

# ── Create the GoldenGate deployment via REST API ─────────────────────────
echo "[$(date +%H:%M:%S)] Creating deployment '\${OGG_DEPLOYMENT}'..."

curl -s -u "\${OGG_ADMIN_USER}:\${OGG_ADMIN_PASS}" \
  -X POST "http://localhost:\${OGG_SM_PORT}/services/v2/deployments" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\"        : \"\${OGG_DEPLOYMENT}\",
    \"description\" : \"Oracle to Oracle 21c replication\",
    \"oggHome\"     : \"\${OGG_HOME}\",
    \"deploymentHome\" : \"\${OGG_VAR_HOME}/deployments/\${OGG_DEPLOYMENT}\",
    \"adminServerNetwork\" : {
      \"host\" : \"0.0.0.0\",
      \"port\" : \${OGG_ADMIN_PORT}
    },
    \"distributionServerNetwork\" : {
      \"host\" : \"0.0.0.0\",
      \"port\" : \${OGG_DIST_PORT}
    },
    \"receiverServerNetwork\" : {
      \"host\" : \"0.0.0.0\",
      \"port\" : \${OGG_RECV_PORT}
    },
    \"metricsServerNetwork\" : {
      \"host\" : \"0.0.0.0\",
      \"port\" : \${OGG_PM_PORT}
    },
    \"credentials\" : {
      \"adminUser\"     : \"\${OGG_ADMIN_USER}\",
      \"adminPassword\" : \"\${OGG_ADMIN_PASS}\"
    }
  }" | python3 -m json.tool

echo "[$(date +%H:%M:%S)] Deployment created — Admin console: http://\$(hostname -f):\${OGG_ADMIN_PORT}"
\`\`\`

---

## Script 4: Create systemd Service for GoldenGate (Both Servers — Run as root)

\`\`\`bash
#!/bin/bash
# gg21c_systemd.sh — register GoldenGate Service Manager as a systemd service
# Run as root

cat > /etc/systemd/system/goldengate.service << UNIT
[Unit]
Description=Oracle GoldenGate 21c Service Manager
After=network-online.target oracledb.service
Wants=network-online.target

[Service]
Type=forking
User=oracle
Group=oinstall
Environment="OGG_HOME=\${OGG_HOME}"
Environment="OGG_VAR_HOME=\${OGG_VAR_HOME}"
Environment="ORACLE_HOME=\${ORACLE_HOME}"
Environment="LD_LIBRARY_PATH=\${OGG_HOME}/lib:\${ORACLE_HOME}/lib"
ExecStart=\${OGG_HOME}/bin/ServiceManager \\
  --config \${OGG_VAR_HOME}/etc/conf/ogg/ServiceManager.cfg \\
  --deployment-home \${OGG_VAR_HOME}
PIDFile=\${OGG_VAR_HOME}/ServiceManager.pid
Restart=on-failure
RestartSec=10
StandardOutput=append:\${OGG_VAR_HOME}/logs/ServiceManager.log
StandardError=append:\${OGG_VAR_HOME}/logs/ServiceManager.log

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable goldengate
echo "[$(date +%H:%M:%S)] GoldenGate systemd service registered and enabled"
\`\`\`

---

## Script 5: Configure Source Database and Create Credentials (Source Server — oracle)

\`\`\`bash
#!/bin/bash
# gg21c_source_db_config.sh — configure Oracle source DB and GGS credential store
# Run as oracle on source server

set -euo pipefail
source ~/.bash_profile

read -rsp "Enter GoldenGate DB user (c##ggadmin) password: " GG_DB_PASS; echo
read -rsp "Enter GoldenGate Admin Console password: "        OGG_ADMIN_PASS; echo

# ── Source DB: supplemental logging + parameter ───────────────────────────
echo "[$(date +%H:%M:%S)] Configuring source database \$DB_CONN_SRC..."
sqlplus -s / as sysdba << SQLEOF
ALTER SYSTEM SET enable_goldengate_replication = TRUE SCOPE=BOTH;

-- Enable minimum supplemental logging
ALTER DATABASE ADD SUPPLEMENTAL LOG DATA;

-- Enable all-column supplemental logging (recommended for full row capture)
-- Remove if redo volume is a concern; use per-table instead
ALTER DATABASE ADD SUPPLEMENTAL LOG DATA ALL COLUMNS;

-- Create GoldenGate capture user (adjust for non-CDB: remove c## prefix)
CREATE USER c##ggadmin IDENTIFIED BY "\${GG_DB_PASS}"
  DEFAULT TABLESPACE users QUOTA UNLIMITED ON users;

EXEC DBMS_GOLDENGATE_AUTH.GRANT_ADMIN_PRIVILEGE(
  username               => 'c##ggadmin',
  privilege_type         => 'capture',
  grant_select_privileges => TRUE,
  do_grants              => TRUE
);

GRANT CREATE SESSION, ALTER SESSION    TO c##ggadmin;
GRANT RESOURCE                         TO c##ggadmin;
GRANT SELECT ANY DICTIONARY            TO c##ggadmin;
GRANT SELECT ANY TABLE                 TO c##ggadmin;
GRANT FLASHBACK ANY TABLE              TO c##ggadmin;
GRANT EXECUTE ON DBMS_FLASHBACK        TO c##ggadmin;
GRANT EXECUTE ON SYS.DBMS_INTERNAL_CLKM TO c##ggadmin;

-- Create checkpoint table (used by Extract to track redo log position)
EXEC DBMS_GOLDENGATE_AUTH.GRANT_ADMIN_PRIVILEGE(
  username               => 'c##ggadmin',
  privilege_type         => 'capture',
  grant_select_privileges => TRUE,
  do_grants              => TRUE
);

SELECT log_mode, supplemental_log_data_min
FROM   v\\\$database;

SELECT name, value FROM v\\\$parameter
WHERE  name = 'enable_goldengate_replication';

EXIT;
SQLEOF

# ── Add GoldenGate credential to the deployment wallet ────────────────────
echo "[$(date +%H:%M:%S)] Adding database credential to GoldenGate wallet..."

adminclient << ADMEOF
connect http://localhost:\${OGG_ADMIN_PORT} deployment \${OGG_DEPLOYMENT} as \${OGG_ADMIN_USER} password \${OGG_ADMIN_PASS}
alter credentialstore add user c##ggadmin@\${DB_CONN_SRC} password \${GG_DB_PASS} alias srcdb
info credentialstore
exit
ADMEOF

echo "[$(date +%H:%M:%S)] Source database configuration complete"
\`\`\`

---

## Script 6: Configure Target Database and Create Credentials (Target Server — oracle)

\`\`\`bash
#!/bin/bash
# gg21c_target_db_config.sh — configure Oracle target DB and GGS credential store
# Run as oracle on target server

set -euo pipefail
source ~/.bash_profile

read -rsp "Enter GoldenGate DB user (ggadmin) password: " GG_DB_PASS; echo
read -rsp "Enter GoldenGate Admin Console password: "     OGG_ADMIN_PASS; echo

# ── Target DB: create replication user ────────────────────────────────────
echo "[$(date +%H:%M:%S)] Configuring target database \$DB_CONN_TGT..."
sqlplus -s / as sysdba << SQLEOF
CREATE USER ggadmin IDENTIFIED BY "\${GG_DB_PASS}"
  DEFAULT TABLESPACE users QUOTA UNLIMITED ON users;

EXEC DBMS_GOLDENGATE_AUTH.GRANT_ADMIN_PRIVILEGE(
  username               => 'ggadmin',
  privilege_type         => 'apply',
  grant_select_privileges => TRUE,
  do_grants              => TRUE
);

GRANT CREATE SESSION, ALTER SESSION TO ggadmin;
GRANT RESOURCE                       TO ggadmin;
-- Grant DML on replicated target schemas
GRANT INSERT, UPDATE, DELETE, SELECT ON hr.employees TO ggadmin;
GRANT INSERT, UPDATE, DELETE, SELECT ON hr.departments TO ggadmin;
-- For full schema replication, use: GRANT DBA TO ggadmin; (restrict in prod)

-- Disable triggers and constraints on target schema for replication
-- (Replicat will handle FK integrity via ordered apply)
ALTER TABLE hr.employees DISABLE ALL TRIGGERS;

EXIT;
SQLEOF

# ── Add database credential to target deployment wallet ───────────────────
echo "[$(date +%H:%M:%S)] Adding target DB credential to GoldenGate wallet..."

adminclient << ADMEOF
connect http://localhost:\${OGG_ADMIN_PORT} deployment \${OGG_DEPLOYMENT} as \${OGG_ADMIN_USER} password \${OGG_ADMIN_PASS}
alter credentialstore add user ggadmin@\${DB_CONN_TGT} password \${GG_DB_PASS} alias tgtdb
info credentialstore
exit
ADMEOF

echo "[$(date +%H:%M:%S)] Target database configuration complete"
\`\`\`

---

## Script 7: Create Extract, Distribution Path, and Replicat (Run as oracle)

Run Extract creation on the **source** server. Run Replicat creation on the **target** server.

\`\`\`bash
#!/bin/bash
# gg21c_create_processes.sh
# SOURCE SECTION: run on source server
# TARGET SECTION: run on target server
# Both sections use adminclient against the respective deployment

read -rsp "Enter GoldenGate Admin Console password: " OGG_ADMIN_PASS; echo

SOURCE_TARGET_HOST=target.example.com   # FQDN or IP of target server

# ════════════════════════════════════════
# SOURCE SERVER: Extract + Distribution
# ════════════════════════════════════════

echo "[$(date +%H:%M:%S)] Creating Integrated Extract and Distribution Path on source..."

adminclient << ADMEOF
connect http://localhost:\${OGG_ADMIN_PORT} deployment \${OGG_DEPLOYMENT} as \${OGG_ADMIN_USER} password \${OGG_ADMIN_PASS}

-- Create the Extract parameter file
edit params EXT_ORCL
EXTRACT EXT_ORCL
USERIDALIAS srcdb DOMAIN OracleGoldenGate
EXTTRAIL ./dirdat/et
-- Capture all tables in the HR schema
TABLE hr.*;

-- Add the Integrated Extract (reads from Oracle LogMiner)
add extract EXT_ORCL, integrated tranlog, begin now
add exttrail ./dirdat/et, extract EXT_ORCL, megabytes 500

-- Register Extract with the source database (Integrated mode)
register extract EXT_ORCL database

-- Create Distribution Path (sends trail to target Receiver Server)
add distpath DP_TO_TGT \
  source ./dirdat/et \
  targeturi ogg://\${SOURCE_TARGET_HOST}:\${OGG_RECV_PORT}/services/v2/targets?trail=./dirdat/rt

info all

exit
ADMEOF

echo "[$(date +%H:%M:%S)] Extract and Distribution Path created on source"
\`\`\`

\`\`\`bash
# TARGET SERVER: Replicat
# Run this section on the target server

echo "[$(date +%H:%M:%S)] Creating Replicat on target..."

adminclient << ADMEOF
connect http://localhost:\${OGG_ADMIN_PORT} deployment \${OGG_DEPLOYMENT} as \${OGG_ADMIN_USER} password \${OGG_ADMIN_PASS}

-- Create Replicat parameter file
edit params REP_ORCL
REPLICAT REP_ORCL
USERIDALIAS tgtdb DOMAIN OracleGoldenGate
ASSUMETARGETDEFS
-- Map source HR schema to target HR schema
MAP hr.*, TARGET hr.*;

-- Add checkpoint table (tracks replicat position)
add checkpointtable tgtdb.ggadmin.gg_checkpoint

-- Add Integrated Replicat
add replicat REP_ORCL, integrated, exttrail ./dirdat/rt, checkpointtable ggadmin.gg_checkpoint

info all

exit
ADMEOF

echo "[$(date +%H:%M:%S)] Replicat created on target"
\`\`\`

---

## Script 8: Start Processes and Validate

\`\`\`bash
#!/bin/bash
# gg21c_start_validate.sh — start GoldenGate processes and validate replication

read -rsp "Enter GoldenGate Admin Console password: " OGG_ADMIN_PASS; echo

# ── Start Extract (source server) ─────────────────────────────────────────
echo "[$(date +%H:%M:%S)] Starting Extract on source..."
adminclient << ADMEOF
connect http://localhost:\${OGG_ADMIN_PORT} deployment \${OGG_DEPLOYMENT} as \${OGG_ADMIN_USER} password \${OGG_ADMIN_PASS}
start extract EXT_ORCL
start distpath DP_TO_TGT
info extract EXT_ORCL, detail
info distpath DP_TO_TGT
exit
ADMEOF

# ── Start Replicat (target server — run separately on target) ──────────────
echo "[$(date +%H:%M:%S)] Starting Replicat on target..."
adminclient << ADMEOF
connect http://localhost:\${OGG_ADMIN_PORT} deployment \${OGG_DEPLOYMENT} as \${OGG_ADMIN_USER} password \${OGG_ADMIN_PASS}
start replicat REP_ORCL
info replicat REP_ORCL, detail
exit
ADMEOF

echo "[$(date +%H:%M:%S)] Waiting 30s for processes to initialise..."
sleep 30

# ── Validation ─────────────────────────────────────────────────────────────
PASS=0; WARN=0; FAIL=0
pass() { echo "  [PASS] \$1"; ((PASS++)); }
warn() { echo "  [WARN] \$1"; ((WARN++)); }
fail() { echo "  [FAIL] \$1"; ((FAIL++)); }

echo ""
echo "========================================================"
echo "  GoldenGate 21c Validation"
echo "  \$(date)"
echo "========================================================"

# Check Extract status via REST API
EXT_STATUS=\$(curl -s -u "\${OGG_ADMIN_USER}:\${OGG_ADMIN_PASS}" \
  "http://localhost:\${OGG_ADMIN_PORT}/services/v2/extracts/EXT_ORCL/status" \
  2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('response',{}).get('status','UNKNOWN'))" 2>/dev/null)

if [ "\$EXT_STATUS" = "RUNNING" ]; then
  pass "Extract EXT_ORCL is RUNNING"
else
  fail "Extract EXT_ORCL status: \${EXT_STATUS:-UNKNOWN}"
fi

# Check Distribution Path status
DIST_STATUS=\$(curl -s -u "\${OGG_ADMIN_USER}:\${OGG_ADMIN_PASS}" \
  "http://localhost:\${OGG_DIST_PORT}/services/v2/distpaths/DP_TO_TGT/status" \
  2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('response',{}).get('status','UNKNOWN'))" 2>/dev/null)

if [ "\$DIST_STATUS" = "RUNNING" ]; then
  pass "Distribution Path DP_TO_TGT is RUNNING"
else
  fail "Distribution Path status: \${DIST_STATUS:-UNKNOWN}"
fi

# Check Replicat status on target (remote curl if different server)
REP_STATUS=\$(curl -s -u "\${OGG_ADMIN_USER}:\${OGG_ADMIN_PASS}" \
  "http://localhost:\${OGG_ADMIN_PORT}/services/v2/replicats/REP_ORCL/status" \
  2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('response',{}).get('status','UNKNOWN'))" 2>/dev/null)

if [ "\$REP_STATUS" = "RUNNING" ]; then
  pass "Replicat REP_ORCL is RUNNING"
else
  fail "Replicat REP_ORCL status: \${REP_STATUS:-UNKNOWN}"
fi

# ── End-to-end replication smoke test ─────────────────────────────────────
echo ""
echo "  End-to-end test: insert row on source, verify on target..."

RAND_ID=\$((RANDOM + 90000))

# Insert on source
sqlplus -s c##ggadmin/\${GG_DB_PASS}@\${DB_CONN_SRC} << SQLEOF >/dev/null
INSERT INTO hr.employees (employee_id, first_name, last_name, email,
  hire_date, job_id, department_id)
VALUES (\${RAND_ID}, 'GG', 'Test-\${RAND_ID}', 'GGTEST\${RAND_ID}',
  SYSDATE, 'IT_PROG', 60);
COMMIT;
EXIT;
SQLEOF

echo "  Inserted test row employee_id=\${RAND_ID} on source — waiting 15s..."
sleep 15

# Check on target
TARGET_ROW=\$(sqlplus -s ggadmin/\${GG_DB_PASS}@\${DB_CONN_TGT} << SQLEOF 2>/dev/null
SET PAGES 0 FEEDBACK OFF
SELECT COUNT(*) FROM hr.employees WHERE employee_id = \${RAND_ID};
EXIT;
SQLEOF
)
TARGET_COUNT=\$(echo "\$TARGET_ROW" | tr -d ' \n')

if [ "\${TARGET_COUNT:-0}" -eq 1 ] 2>/dev/null; then
  pass "Row employee_id=\${RAND_ID} replicated to target"
  # Clean up test row on both sides
  sqlplus -s c##ggadmin/\${GG_DB_PASS}@\${DB_CONN_SRC} <<< "DELETE FROM hr.employees WHERE employee_id=\${RAND_ID}; COMMIT;" >/dev/null
else
  fail "Test row NOT found on target (count=\${TARGET_COUNT:-0}) — check Replicat lag"
fi

echo ""
echo "========================================================"
echo "  Result: PASS=\$PASS  WARN=\$WARN  FAIL=\$FAIL"
[ "\$FAIL" -gt 0 ] && echo "  Check process logs: \${OGG_VAR_HOME}/deployments/\${OGG_DEPLOYMENT}/var/log/" \
                  || echo "  GoldenGate 21c is replicating successfully."
echo ""
echo "  Admin Console : http://\$(hostname -f):\${OGG_ADMIN_PORT}"
echo "  Metrics       : http://\$(hostname -f):\${OGG_PM_PORT}"
echo "========================================================"
\`\`\`
`,
};

async function main() {
  for (const post of [blogPost, runbookPost]) {
    await db
      .insert(posts)
      .values({
        title: post.title,
        slug: post.slug,
        excerpt: post.excerpt,
        content: post.content,
        category: post.category,
        youtubeUrl: post.youtubeUrl,
        isPremium: post.isPremium,
        published: post.published,
        publishedAt: post.publishedAt,
      })
      .onConflictDoUpdate({
        target: posts.slug,
        set: {
          title: post.title,
          excerpt: post.excerpt,
          content: post.content,
          isPremium: post.isPremium,
          published: post.published,
          publishedAt: post.publishedAt,
        },
      });
    console.log('inserted:', post.slug);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
