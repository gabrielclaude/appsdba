import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'oracle-database-19c-docker-rhel9-installation';

const content = `
Oracle Database 19c in Docker on RHEL 9 gives you a fully isolated, version-pinned database environment that boots in minutes rather than hours. The same container image runs identically on a developer laptop, a CI pipeline, and a production host — eliminating the classic "works on my machine" problem that has plagued Oracle installs for decades.

This post covers the complete architecture, explains every design decision, and walks through a production-grade Docker deployment of Oracle 19c on Red Hat Enterprise Linux 9.

---

## Why Docker for Oracle?

Traditional Oracle installs on bare metal or VMs carry substantial overhead: kernel parameter tuning locked to a single tenant, manual hugepage allocation, and a sprawling \`$ORACLE_BASE\` tree that is painful to snapshot or replicate. Docker changes the calculus:

| Concern | Bare Metal / VM | Docker |
|---|---|---|
| Provisioning time | 2–4 hours | 5–10 minutes |
| Environment parity | Manual drift | Image-pinned |
| Side-by-side versions | Hard (ORACLE_HOME conflicts) | Trivial |
| Snapshot / rollback | LVM or snapshot agent | \`docker commit\` or volume backup |
| Resource limits | OS-level cgroups (manual) | \`--memory\`, \`--cpus\` flags |

Docker is not a replacement for Oracle RAC or Data Guard — those remain bare-metal or VM territory. Docker excels for **development**, **QA**, **CI pipelines**, and **single-node production** workloads where HA is handled at the application layer.

---

## Architecture Overview

\`\`\`
┌─────────────────────────────────────────────────────────┐
│                      RHEL 9 Host                        │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │              Docker Engine (daemon)               │  │
│  │                                                   │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │        oracle-db Container                  │  │  │
│  │  │                                             │  │  │
│  │  │  Oracle 19c EE                              │  │  │
│  │  │  ├── $ORACLE_BASE  /opt/oracle              │  │  │
│  │  │  ├── $ORACLE_HOME  /opt/oracle/product/19c  │  │  │
│  │  │  ├── Listener      port 1521                │  │  │
│  │  │  └── EM Express    port 5500                │  │  │
│  │  │                                             │  │  │
│  │  │  Volumes:                                   │  │  │
│  │  │  ├── oradata  → /opt/oracle/oradata         │  │  │
│  │  │  └── scripts → /opt/oracle/scripts/startup  │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  │                                                   │  │
│  │  Network: oracle-net (bridge, 172.20.0.0/16)      │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  Host ports: 1521 → 1521, 5500 → 5500                  │
│  Named volumes: oracle-data, oracle-scripts             │
└─────────────────────────────────────────────────────────┘
\`\`\`

### Key design decisions

**Named volumes over bind mounts** — Oracle writes heavily to datafiles, redo logs, and archive logs. Docker named volumes live inside \`/var/lib/docker/volumes/\` and are managed by the Docker daemon, which avoids the SELinux labeling complications that plague bind-mounts on RHEL 9.

**Bridge network with a fixed subnet** — A custom bridge (\`oracle-net\`) gives the container a predictable IP and lets you add application containers to the same network without host-port conflicts.

**Single-container, single-CDB** — One container runs one CDB (\`ORCLCDB\`) with one PDB (\`ORCLPDB1\`). This keeps the architecture simple and mirrors the Oracle official image defaults.

---

## Hardware and OS Requirements

| Resource | Minimum | Recommended |
|---|---|---|
| CPU cores | 2 | 4+ |
| RAM (host) | 8 GB | 16–32 GB |
| Container memory limit | 4 GB | 8–16 GB |
| Disk (oradata volume) | 20 GB | 50–100 GB |
| OS | RHEL 9.x | RHEL 9.3+ |
| Kernel | 5.14+ | Latest RHEL 9 kernel |
| Docker Engine | 24.x | 26.x |

Oracle 19c requires at minimum 2 GB of RAM inside the container (\`SGA_TARGET\` + \`PGA_AGGREGATE_TARGET\`). Allocating less causes the database to refuse to start.

---

## RHEL 9 Host Preparation

### 1. Kernel parameters

Oracle in a container still exercises the host kernel. Set these on the **host** — they propagate into the container via the shared kernel namespace:

\`\`\`bash
cat >> /etc/sysctl.d/97-oracle-docker.conf << 'EOF'
# Shared memory — Oracle SGA maps via /dev/shm
kernel.shmmax = 68719476736
kernel.shmall = 16777216
kernel.shmmni = 4096

# Semaphores — SEMMSL SEMMNS SEMOPM SEMMNI
kernel.sem = 250 32000 100 128

# File handles
fs.file-max = 6815744
fs.aio-max-nr = 1048576

# Network buffers (for SQL*Net)
net.core.rmem_max = 4194304
net.core.wmem_max = 1048576

# VM behaviour
vm.swappiness = 10
EOF

sysctl --system
\`\`\`

### 2. /dev/shm sizing

Oracle SGA uses shared memory. The container's \`/dev/shm\` must be large enough to hold the SGA:

\`\`\`bash
# Passed at container run time via --shm-size
# For an 8 GB SGA: --shm-size=8g
\`\`\`

### 3. Install Docker Engine

\`\`\`bash
# Remove any podman/docker conflicts
dnf remove -y podman buildah

# Add Docker CE repo
dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo

# Install
dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Enable and start
systemctl enable --now docker

# Allow oracle user to manage containers
usermod -aG docker oracle
\`\`\`

### 4. Configure SELinux for volumes

RHEL 9 ships with SELinux enforcing. Named volumes work without modification, but if you use bind mounts you must label them:

\`\`\`bash
# For bind mounts only — skip if using named volumes
chcon -Rt svirt_sandbox_file_t /path/to/oradata
\`\`\`

---

## Building the Oracle 19c Image

Oracle does not distribute pre-built images on Docker Hub. You build the image locally from Oracle's official Dockerfile repository using your Oracle software zip.

### 1. Clone oracle/docker-images

\`\`\`bash
git clone https://github.com/oracle/docker-images.git
cd docker-images/OracleDatabase/SingleInstance/dockerfiles
\`\`\`

### 2. Download Oracle 19c software

Download \`LINUX.X64_193000_db_home.zip\` from Oracle Software Delivery Cloud (edelivery.oracle.com) and place it in the \`19.3.0\` directory:

\`\`\`bash
ls docker-images/OracleDatabase/SingleInstance/dockerfiles/19.3.0/
# LINUX.X64_193000_db_home.zip  ← required
\`\`\`

### 3. Build the image

\`\`\`bash
cd docker-images/OracleDatabase/SingleInstance/dockerfiles

./buildContainerImage.sh -v 19.3.0 -e -t oracle/database:19.3.0-ee
# -v  version
# -e  Enterprise Edition
# -t  tag

# Build takes 20–40 minutes. Final image is ~6.5 GB.
docker images oracle/database
\`\`\`

---

## Container Deployment

### 1. Create the network and volumes

\`\`\`bash
docker network create --subnet=172.20.0.0/16 oracle-net

docker volume create oracle-data
docker volume create oracle-scripts
\`\`\`

### 2. Run the container

\`\`\`bash
docker run -d \\
  --name oracle-db \\
  --hostname oracle-db \\
  --network oracle-net \\
  --ip 172.20.0.10 \\
  -p 1521:1521 \\
  -p 5500:5500 \\
  --memory 8g \\
  --memory-swap 8g \\
  --cpus 4 \\
  --shm-size 4g \\
  -e ORACLE_SID=ORCLCDB \\
  -e ORACLE_PDB=ORCLPDB1 \\
  -e ORACLE_PWD=Oracle19c_Strong#Pwd \\
  -e ORACLE_EDITION=enterprise \\
  -e ORACLE_CHARACTERSET=AL32UTF8 \\
  -e ENABLE_ARCHIVELOG=true \\
  -v oracle-data:/opt/oracle/oradata \\
  -v oracle-scripts:/opt/oracle/scripts/startup \\
  --restart unless-stopped \\
  oracle/database:19.3.0-ee
\`\`\`

**Environment variables explained:**

| Variable | Purpose |
|---|---|
| \`ORACLE_SID\` | CDB name — becomes the instance identifier |
| \`ORACLE_PDB\` | PDB name created inside the CDB |
| \`ORACLE_PWD\` | Password for SYS, SYSTEM, PDBADMIN |
| \`ORACLE_EDITION\` | \`enterprise\` or \`standard\` |
| \`ORACLE_CHARACTERSET\` | AL32UTF8 is mandatory for Unicode support |
| \`ENABLE_ARCHIVELOG\` | Enables ARCHIVELOG mode — required for RMAN backups |

### 3. Monitor first-time initialization

The first start creates the CDB and PDB — this takes 10–20 minutes:

\`\`\`bash
docker logs -f oracle-db | grep -E 'DATABASE IS READY|ORA-|ERROR'

# Healthy output ends with:
# DATABASE IS READY TO USE!
\`\`\`

### 4. Connect to the database

\`\`\`bash
# From the host using sqlplus (Oracle client installed on host)
sqlplus sys/Oracle19c_Strong#Pwd@//localhost:1521/ORCLCDB as sysdba

# From inside the container
docker exec -it oracle-db sqlplus sys/Oracle19c_Strong#Pwd@ORCLCDB as sysdba

# Connect to PDB
docker exec -it oracle-db sqlplus sys/Oracle19c_Strong#Pwd@ORCLPDB1 as sysdba
\`\`\`

---

## Persistent Storage Layout

\`\`\`
oracle-data volume (/var/lib/docker/volumes/oracle-data/_data)
└── ORCLCDB/
    ├── control01.ctl
    ├── control02.ctl
    ├── redo01.log
    ├── redo02.log
    ├── redo03.log
    ├── system01.dbf
    ├── sysaux01.dbf
    ├── undotbs01.dbf
    ├── temp01.tmp
    └── ORCLPDB1/
        ├── system01.dbf
        ├── sysaux01.dbf
        ├── undotbs01.dbf
        └── users01.dbf
\`\`\`

Destroying and recreating the container does not destroy the volume:

\`\`\`bash
docker rm -f oracle-db
# Volume oracle-data is intact

docker run -d --name oracle-db ... -v oracle-data:/opt/oracle/oradata ...
# Existing database files are reused — no re-creation
\`\`\`

---

## Memory Configuration

The Oracle image auto-sizes \`SGA_TARGET\` and \`PGA_AGGREGATE_TARGET\` based on available container memory. For explicit control:

\`\`\`bash
docker exec -it oracle-db sqlplus / as sysdba << 'EOF'
ALTER SYSTEM SET sga_target=4G SCOPE=SPFILE;
ALTER SYSTEM SET pga_aggregate_target=2G SCOPE=SPFILE;
ALTER SYSTEM SET sga_max_size=4G SCOPE=SPFILE;
SHUTDOWN IMMEDIATE;
STARTUP;
SHOW PARAMETER sga_target;
SHOW PARAMETER pga_aggregate_target;
EOF
\`\`\`

---

## JVM and Container Resource Limits

Oracle 19c includes the JVM option (OJVM). If you use Java-based features, the JVM memory adds on top of the SGA. Account for it when setting \`--memory\`:

\`\`\`
Container memory budget:
  SGA:           4 GB
  PGA ceiling:   2 GB
  OS + JVM:      1 GB
  Buffer:        1 GB
  ──────────────────
  --memory:      8g
\`\`\`

---

## Systemd Unit File

For production hosts, manage the container as a systemd service so it survives reboots cleanly:

\`\`\`ini
# /etc/systemd/system/oracle-db.service
[Unit]
Description=Oracle Database 19c Docker Container
After=docker.service network-online.target
Requires=docker.service

[Service]
TimeoutStartSec=300
TimeoutStopSec=120
Restart=on-failure
RestartSec=30

ExecStartPre=-/usr/bin/docker stop oracle-db
ExecStartPre=-/usr/bin/docker rm oracle-db
ExecStart=/usr/bin/docker run \\
  --name oracle-db \\
  --hostname oracle-db \\
  --network oracle-net \\
  --ip 172.20.0.10 \\
  -p 1521:1521 \\
  -p 5500:5500 \\
  --memory 8g \\
  --memory-swap 8g \\
  --cpus 4 \\
  --shm-size 4g \\
  -e ORACLE_SID=ORCLCDB \\
  -e ORACLE_PDB=ORCLPDB1 \\
  -e ORACLE_PWD=Oracle19c_Strong#Pwd \\
  -e ORACLE_EDITION=enterprise \\
  -e ORACLE_CHARACTERSET=AL32UTF8 \\
  -e ENABLE_ARCHIVELOG=true \\
  -v oracle-data:/opt/oracle/oradata \\
  -v oracle-scripts:/opt/oracle/scripts/startup \\
  oracle/database:19.3.0-ee

ExecStop=/usr/bin/docker exec oracle-db sqlplus -S / as sysdba <<< "shutdown immediate;"
ExecStopPost=/usr/bin/docker stop oracle-db

[Install]
WantedBy=multi-user.target
\`\`\`

\`\`\`bash
systemctl daemon-reload
systemctl enable --now oracle-db
systemctl status oracle-db
\`\`\`

---

## Post-Installation Validation

\`\`\`bash
# 1. Database and instance state
docker exec oracle-db sqlplus -S / as sysdba <<< "
SELECT instance_name, status, database_status FROM v\\\$instance;
SELECT name, open_mode, log_mode FROM v\\\$database;
SELECT con_id, name, open_mode FROM v\\\$pdbs;
"

# 2. Listener status
docker exec oracle-db lsnrctl status

# 3. Alert log (last 20 lines)
docker exec oracle-db tail -20 /opt/oracle/diag/rdbms/orclcdb/ORCLCDB/trace/alert_ORCLCDB.log

# 4. Container resource usage
docker stats oracle-db --no-stream
\`\`\`

---

## Upgrade Path: 19c → 21c

When you need to upgrade, build a 21c image alongside the 19c image, export the 19c data with DataPump, and import into the new container:

\`\`\`bash
# Export from 19c
docker exec oracle-db expdp system/pwd@ORCLPDB1 \\
  DIRECTORY=DATA_PUMP_DIR DUMPFILE=full_19c.dmp FULL=Y LOGFILE=exp_19c.log

# Copy dumpfile to new container
docker cp oracle-db:/opt/oracle/admin/ORCLCDB/dpdump/full_19c.dmp .
docker cp full_19c.dmp oracle-db-21c:/opt/oracle/admin/ORCLCDB/dpdump/

# Import into 21c
docker exec oracle-db-21c impdp system/pwd@ORCLPDB1 \\
  DIRECTORY=DATA_PUMP_DIR DUMPFILE=full_19c.dmp FULL=Y LOGFILE=imp_21c.log
\`\`\`

---

## Summary

| Phase | What happens | Time |
|---|---|---|
| Host prep | Kernel params, Docker install, SELinux | 15 min |
| Image build | Download + \`buildContainerImage.sh\` | 30–45 min |
| Container start | First-time CDB + PDB creation | 10–20 min |
| Validation | Connect, check logs, stats | 5 min |
| Systemd | Service file, enable, reboot test | 5 min |

The result is a fully functional Oracle 19c Enterprise Edition instance, isolated in a container, surviving reboots, with persistent datafiles on a named Docker volume — ready for development, CI workloads, or single-node production use.

See the companion **Runbook** for day-two operations: container lifecycle management, RMAN backup, and the full performance monitoring script suite.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'Oracle Database 19c on RHEL 9 with Docker: Architecture and Installation Guide',
    slug,
    excerpt: 'Deploy Oracle Database 19c Enterprise Edition inside a Docker container on RHEL 9. Covers kernel tuning, image build from oracle/docker-images, persistent volume strategy, cgroup memory limits, systemd service management, and production-grade configuration.',
    content,
    category: 'docker-oracle',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
