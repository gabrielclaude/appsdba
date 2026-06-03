import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const blogPost = {
  title: 'Oracle EBS 12.2.9 with Oracle Database 19c on RHEL 8 Using Docker',
  slug: 'oracle-ebs-12-2-9-oracle-19c-rhel8-docker',
  excerpt:
    'A practical guide to containerising Oracle E-Business Suite 12.2.9 and Oracle Database 19c on Red Hat Enterprise Linux 8 — covering Oracle support policy, dual-tier container architecture, storage and networking design, memory requirements, and the trade-offs between Docker and bare-metal deployments for EBS.',
  category: 'ebs-suite' as const,
  published: true,
  publishedAt: new Date('2026-06-02'),
  isPremium: false,
  youtubeUrl: null,
  content: `Oracle E-Business Suite 12.2.9 on Docker is a legitimate deployment pattern with official Oracle support guidance, most commonly used for development, system testing, and cloned non-production environments. Understanding what Docker provides — and where it stops — is the starting point for any successful implementation.

---

## Oracle Support Policy for EBS on Docker

Oracle's position is documented in MOS Note **2592755.1** ("Oracle E-Business Suite Support on Docker and Container Environments"). The headline: Oracle will support EBS running in Docker containers on a certified host OS, provided:

- The host OS is a certified EBS platform (RHEL 7/8, Oracle Linux 7/8).
- The container OS matches the EBS certification matrix (RHEL 8 / OL 8 for EBS 12.2.9).
- The Oracle Database inside the container runs on a certified OS, version, and patch level.
- Oracle 19c (19.3 minimum, 19.22 RU recommended) is certified with EBS 12.2.9 per MOS Note **1565879.1**.

Docker adds a layer, but Oracle still certifies the software stack inside the container — not Docker itself. If you open an SR, Oracle may ask you to reproduce on a non-containerised platform if the container layer is suspected. For production, Oracle strongly recommends bare metal or engineered systems; for dev/test, Docker is practical and cost-effective.

---

## EBS 12.2 Architecture Primer

EBS 12.2 introduced the **Online Patching (Adop)** framework, which requires a dual-filesystem layout on the application tier:

- **Run Edition** — the active filesystem serving users.
- **Patch Edition** — an isolated copy where patches are applied without downtime.

This dual-filesystem requirement means the application tier container needs persistent volumes that survive container restarts, and both edition directories must be accessible to the same container.

A standard EBS 12.2.9 two-tier deployment consists of:

\`\`\`
┌──────────────────────────────────────────────────────┐
│  RHEL 8 Docker Host                                  │
│                                                      │
│  ┌─────────────────────┐  ┌───────────────────────┐  │
│  │  DB Container       │  │  App Container        │  │
│  │  oracle/db:19c      │  │  ebs/appstier:12.2.9  │  │
│  │                     │  │                       │  │
│  │  Oracle DB 19c      │  │  WebLogic 12.2.1.3    │  │
│  │  EBS schemas        │  │  Oracle HTTP Server   │  │
│  │  SYSTEM, APPS, etc. │  │  Concurrent Manager   │  │
│  │                     │  │  Run + Patch editions │  │
│  └──────────┬──────────┘  └──────────┬────────────┘  │
│             │                        │               │
│     Volume: /u01/oradata      Volume: /u01/EBSapps   │
│     Volume: /u01/fra          Volume: /u02/EBSapps   │
│                                                      │
│  docker network: ebs-net (172.20.0.0/24)             │
└──────────────────────────────────────────────────────┘
\`\`\`

The two containers communicate over a dedicated Docker bridge network. The application tier connects to the database using the DB container's DNS name (\`ebsdb\`) on port 1521.

---

## Why Docker for EBS

### Where it helps

**Consistent provisioning.** An EBS installation takes 4–8 hours on bare metal. A committed Docker image of a completed install reduces provisioning to a \`docker run\` and a refresh of the schema — typically under 30 minutes for a developer clone.

**Environment parity.** Dev, SIT, and UAT environments built from the same image have identical OS configuration, Oracle home layout, and patch levels. The "works on my environment" problem disappears.

**Isolation.** Multiple EBS instances on the same physical host (dev-1, dev-2, uat) without VM overhead. Each container gets its own listener port, web port, and filesystem.

**Snapshot and rollback.** Commit a Docker image before applying an Oracle patch or EBS RPC. If it fails, roll back to the committed image. This is substantially faster than RMAN + OS snapshot recovery.

### Where it does not help

**Production suitability.** EBS production instances handle thousands of concurrent users, require sub-second OLTP response times, and must meet strict availability SLAs. Docker adds a networking layer, storage abstraction, and process isolation that introduce latency and operational complexity not present on bare metal. Oracle's licensing model for production Docker deployments is also complex (see below).

**Online Patching with shared storage.** The \`adop\` dual-filesystem model works inside a single container but requires careful volume mapping. If you try to split run and patch editions across separate containers, the \`adop\` tooling — which expects both filesystems on the same mount namespace — breaks.

**Oracle RAC.** RAC requires shared raw storage across nodes, which is incompatible with standard Docker volumes. Oracle RAC on Docker exists experimentally but is not supported for production.

---

## Container Architecture Design Decisions

### Single-host vs multi-host
For dev/test: run both DB and app containers on the same RHEL 8 host. For closer production parity: use separate hosts connected by an overlay network (Docker Swarm or Kubernetes). This guide covers single-host; multi-host requires Swarm/K8s networking which adds significant complexity.

### Image strategy
Two approaches:

| Approach | Build time | Flexibility | Image size |
|---|---|---|---|
| Oracle official images from \`container-registry.oracle.com\` | Fast (pull) | Limited | ~8 GB (DB) |
| Custom Dockerfile from \`oracle/docker-images\` on GitHub | 4–6 hours | Full | 10–15 GB |
| Committed post-install image | Pull from registry | Full (frozen) | 20–40 GB |

For a repeatable pipeline: use Oracle's official DB image for the database container, and build a custom app-tier image from Oracle's Docker files with EBS pre-installed, then commit it.

### Persistent volumes
The two critical volume decisions:

1. **DB volumes** — map \`/u01/oradata\` and \`/u03/fra\` to host paths or named volumes. Use \`--mount type=bind\` to a dedicated XFS filesystem for best I/O performance.
2. **EBS app volumes** — map the EBS application base (\`/u01/EBSapps\` and \`/u02/EBSapps\`) to host paths. These hold the run and patch edition filesystems and must persist across container restarts.

Never store Oracle data files inside the container writable layer. Container restarts will not lose data with named volumes, but \`docker rm -v\` will. Use bind mounts for anything critical.

### Networking
Create a dedicated bridge network with a fixed subnet. Assign static IPs so the database hostname/IP remains stable across container restarts — EBS embeds the DB hostname in profile options that require manual updates if it changes.

---

## Memory and CPU Requirements

EBS 12.2.9 with Oracle 19c on a single Docker host is memory-intensive:

| Component | Minimum | Recommended |
|---|---|---|
| Oracle DB 19c SGA | 8 GB | 16 GB |
| Oracle DB PGA | 4 GB | 8 GB |
| WebLogic (OAF + Forms) | 8 GB | 16 GB |
| Concurrent Manager tier | 2 GB | 4 GB |
| Oracle HTTP Server | 1 GB | 2 GB |
| OS + Docker overhead | 4 GB | 4 GB |
| **Total host RAM** | **27 GB** | **50 GB** |

CPU: 8 vCPU minimum, 16 recommended for reasonable concurrent user simulation in test.

Storage: 500 GB minimum for a full EBS 12.2.9 installation including DB data files, FRA, and application filesystem.

---

## Oracle Licensing in Docker

Docker containers on Linux are treated the same as VMs for Oracle licensing purposes — **soft partitioning**. \`--cpus\` and \`--memory\` Docker flags do not constitute hard partitioning recognised by Oracle. You are required to license all physical cores on the host machine running the Docker engine.

For dev/test, Oracle allows licensing per Named User Plus (NUP) which is more economical than Processor licensing. Confirm with your Oracle LMS account manager before deploying any EBS production instance on Docker.

---

## EBS 12.2.9 on Docker: The Short Version

For dev/test and CI/CD pipelines, Docker-based EBS 12.2.9 is practical and well worth the setup investment. For production, bare metal or OCI Dedicated Infrastructure remains the correct choice. The runbook that accompanies this post walks through the full build step by step.
`,
};

const runbookPost = {
  title: 'Runbook: Oracle EBS 12.2.9 + Oracle 19c on RHEL 8 with Docker',
  slug: 'oracle-ebs-12-2-9-oracle-19c-rhel8-docker-runbook',
  excerpt:
    'Step-by-step scripts for building Oracle E-Business Suite 12.2.9 with Oracle Database 19c on Red Hat Enterprise Linux 8 using Docker — host preparation, container networking, Oracle 19c database container, EBS application tier container, RapidInstall configuration, and post-install validation.',
  category: 'ebs-suite' as const,
  published: true,
  publishedAt: new Date('2026-06-02'),
  isPremium: true,
  youtubeUrl: null,
  content: `This runbook accompanies the [EBS 12.2.9 on Docker guide](/posts/oracle-ebs-12-2-9-oracle-19c-rhel8-docker). It provides ready-to-run scripts that build a two-container EBS environment on a single RHEL 8 host.

**Prerequisites:**
- RHEL 8.6+ or Oracle Linux 8.6+ registered with a valid subscription
- 50 GB RAM, 16 CPU cores, 500 GB disk (XFS recommended)
- Oracle 19c (19.3.0) media: \`LINUX.X64_193000_db_home.zip\`
- Oracle EBS 12.2.9 media (Rapid Install disk set from eDelivery)
- Internet access for dnf and Docker Hub (or local mirror)

Set these once before running any script:

\`\`\`bash
export EBS_HOST_IP=192.168.10.50        # host IP visible to clients
export EBS_HOSTNAME=ebsapp.example.com  # FQDN for EBS app tier
export DB_HOSTNAME=ebsdb.example.com    # FQDN for Oracle DB container
export ORACLE_SID=EBSDB
export APPS_PASSWORD=Apps_Change_Me_1   # EBS APPS schema password
export SYS_PASSWORD=Sys_Change_Me_1     # Oracle SYS password
export DOCKER_BRIDGE_SUBNET=172.20.0.0/24
export DB_CONTAINER_IP=172.20.0.10
export APP_CONTAINER_IP=172.20.0.20
export EBS_BASE_DIR=/data/ebs           # host base directory for bind mounts
\`\`\`

---

## Script 1: RHEL 8 Docker Host Preparation

Run as root on the RHEL 8 host before creating any containers.

\`\`\`bash
#!/bin/bash
# rhel8_docker_host_prep.sh — prepare RHEL 8 for Oracle EBS Docker deployment
# Run as root

set -euo pipefail
echo "[$(date +%H:%M:%S)] Starting RHEL 8 host preparation..."

# ── Subscription and repos ────────────────────────────────────────────────
subscription-manager repos --enable=rhel-8-for-x86_64-baseos-rpms
subscription-manager repos --enable=rhel-8-for-x86_64-appstream-rpms
dnf update -y

# ── Required packages ─────────────────────────────────────────────────────
dnf install -y \
  bind-utils \
  bridge-utils \
  compat-openssl10 \
  device-mapper-persistent-data \
  lvm2 \
  net-tools \
  nfs-utils \
  numactl \
  sysstat \
  tcpdump \
  wget \
  xfsprogs

# ── Install Docker CE on RHEL 8 ───────────────────────────────────────────
# RHEL 8 ships podman by default; remove it to avoid conflicts
dnf remove -y podman buildah 2>/dev/null || true

# Add Docker CE repo
dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# ── Docker daemon configuration ────────────────────────────────────────────
mkdir -p /etc/docker
cat > /etc/docker/daemon.json << 'DOCKERD'
{
  "storage-driver": "overlay2",
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "100m",
    "max-file": "5"
  },
  "default-ulimits": {
    "nofile": {
      "Name": "nofile",
      "Hard": 65536,
      "Soft": 65536
    }
  },
  "live-restore": true
}
DOCKERD

systemctl enable --now docker
echo "[$(date +%H:%M:%S)] Docker CE installed and started"

# ── Kernel parameters for Oracle inside containers ────────────────────────
cat > /etc/sysctl.d/99-oracle-docker.conf << 'SYSCTL'
# Allow containers to use large shared memory segments
kernel.shmmax = 137438953472
kernel.shmall = 33554432
kernel.shmmni = 4096
kernel.sem = 250 32000 100 128

# File handles for Oracle + EBS workload
fs.file-max = 6815744
fs.aio-max-nr = 1048576

# Network
net.ipv4.ip_local_port_range = 9000 65500
net.core.rmem_default = 262144
net.core.rmem_max = 4194304
net.core.wmem_default = 262144
net.core.wmem_max = 1048576

# Docker overlay networking
net.ipv4.ip_forward = 1
net.bridge.bridge-nf-call-iptables = 1
net.bridge.bridge-nf-call-ip6tables = 1

# Reduce swappiness — Oracle SGA must not be swapped
vm.swappiness = 1
vm.dirty_ratio = 20
vm.dirty_background_ratio = 3
SYSCTL

sysctl --system
echo "[$(date +%H:%M:%S)] Kernel parameters applied"

# ── Disable THP (Transparent Huge Pages) ─────────────────────────────────
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

cat > /etc/systemd/system/disable-thp.service << 'THP'
[Unit]
Description=Disable Transparent Huge Pages
After=sysinit.target

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/enabled'
ExecStart=/bin/sh -c 'echo never > /sys/kernel/mm/transparent_hugepage/defrag'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
THP
systemctl daemon-reload && systemctl enable --now disable-thp

# ── Create bind-mount directories ─────────────────────────────────────────
mkdir -p \${EBS_BASE_DIR}/{oradata,fra,arch,ebs_run,ebs_patch,ebs_stage,logs}
chmod 755 \${EBS_BASE_DIR}

# ── /etc/hosts entries for container DNS ─────────────────────────────────
grep -q "\$DB_HOSTNAME" /etc/hosts || \
  echo "\$DB_CONTAINER_IP  \$DB_HOSTNAME ebsdb" >> /etc/hosts
grep -q "\$EBS_HOSTNAME" /etc/hosts || \
  echo "\$APP_CONTAINER_IP  \$EBS_HOSTNAME ebsapp" >> /etc/hosts

echo "[$(date +%H:%M:%S)] Host preparation complete"
echo "  Reboot recommended before proceeding to apply all kernel changes."
\`\`\`

---

## Script 2: Docker Network and Volume Setup

\`\`\`bash
#!/bin/bash
# ebs_docker_network.sh — create Docker network and named volumes for EBS

set -euo pipefail

echo "[$(date +%H:%M:%S)] Creating Docker network..."

# Create isolated bridge network for EBS components
docker network create \
  --driver bridge \
  --subnet \${DOCKER_BRIDGE_SUBNET} \
  --gateway 172.20.0.1 \
  --opt "com.docker.network.bridge.name=br-ebs" \
  ebs-net 2>/dev/null || echo "  Network ebs-net already exists"

docker network inspect ebs-net --format \
  "  Network: {{.Name}} Subnet: {{range .IPAM.Config}}{{.Subnet}}{{end}}"

# Named volumes (alternative to bind mounts — easier to backup with docker cp)
# Using bind mounts here for explicit host path control:
echo "[$(date +%H:%M:%S)] Bind-mount directories:"
ls -la \${EBS_BASE_DIR}/

echo "[$(date +%H:%M:%S)] Docker network setup complete"
\`\`\`

---

## Script 3: Oracle 19c Database Container

Build and start the Oracle 19c database container using Oracle's official Dockerfile from \`oracle/docker-images\`.

\`\`\`bash
#!/bin/bash
# build_oracle19c_container.sh — build Oracle 19c image and start DB container
# Requires: LINUX.X64_193000_db_home.zip copied to the dockerfiles/19.3.0/ directory

set -euo pipefail

DOCKER_IMAGES_DIR=/opt/oracle-docker-images
DB_MEDIA=/tmp/LINUX.X64_193000_db_home.zip

[ -f "\$DB_MEDIA" ] || { echo "ERROR: Oracle 19c media not found at \$DB_MEDIA"; exit 1; }

# ── Clone Oracle docker-images repo ──────────────────────────────────────
if [ ! -d "\$DOCKER_IMAGES_DIR" ]; then
  git clone https://github.com/oracle/docker-images.git \$DOCKER_IMAGES_DIR
fi

cp "\$DB_MEDIA" "\${DOCKER_IMAGES_DIR}/OracleDatabase/SingleInstance/dockerfiles/19.3.0/"

echo "[$(date +%H:%M:%S)] Building Oracle 19c Enterprise Edition image..."
cd "\${DOCKER_IMAGES_DIR}/OracleDatabase/SingleInstance/dockerfiles"
./buildContainerImage.sh -v 19.3.0 -e -i
echo "[$(date +%H:%M:%S)] Image build complete"

# ── Start DB container ────────────────────────────────────────────────────
echo "[$(date +%H:%M:%S)] Starting Oracle 19c DB container..."

docker run -d \
  --name ebsdb \
  --hostname \$DB_HOSTNAME \
  --network ebs-net \
  --ip \$DB_CONTAINER_IP \
  --restart unless-stopped \
  --shm-size=4g \
  --ulimit nofile=65536:65536 \
  --ulimit nproc=16384:16384 \
  -p 1521:1521 \
  -p 5500:5500 \
  -e ORACLE_SID=\${ORACLE_SID} \
  -e ORACLE_PDB="" \
  -e ORACLE_PWD=\${SYS_PASSWORD} \
  -e ORACLE_EDITION=enterprise \
  -e ORACLE_CHARACTERSET=AL32UTF8 \
  -e INIT_SGA_SIZE=16384 \
  -e INIT_PGA_SIZE=4096 \
  -e ENABLE_ARCHIVELOG=true \
  -v \${EBS_BASE_DIR}/oradata:/opt/oracle/oradata \
  -v \${EBS_BASE_DIR}/fra:/opt/oracle/fast_recovery_area \
  oracle/database:19.3.0-ee

echo "[$(date +%H:%M:%S)] Container started — waiting for DB to be ready (this takes 10–20 minutes)..."

# Wait for healthy status
TIMEOUT=1800
ELAPSED=0
until docker exec ebsdb /bin/bash -c \
  'sqlplus -s / as sysdba <<< "SELECT 1 FROM dual;" 2>/dev/null | grep -q "1"' 2>/dev/null; do
  sleep 30; ELAPSED=\$((ELAPSED+30))
  echo "  ... waiting (\${ELAPSED}s elapsed)"
  [ "\$ELAPSED" -ge "\$TIMEOUT" ] && { echo "ERROR: Timed out waiting for DB"; exit 1; }
done

echo "[$(date +%H:%M:%S)] Oracle 19c database is ready"
docker logs ebsdb --tail 5
\`\`\`

---

## Script 4: Prepare Oracle 19c Database for EBS

Once the DB container is running, apply EBS-required configuration. Run from the Docker host.

\`\`\`bash
#!/bin/bash
# prep_oracle19c_for_ebs.sh — configure Oracle 19c for EBS 12.2.9
# Runs SQL inside the ebsdb container

set -euo pipefail

run_sql() {
  docker exec ebsdb sqlplus -s / as sysdba << SQL
$1
SQL
}

echo "[$(date +%H:%M:%S)] Configuring Oracle 19c for EBS 12.2.9..."

# ── EBS-required init parameters ─────────────────────────────────────────
run_sql "
ALTER SYSTEM SET db_name='\${ORACLE_SID}' SCOPE=SPFILE;
ALTER SYSTEM SET open_cursors=500 SCOPE=BOTH;
ALTER SYSTEM SET session_cached_cursors=200 SCOPE=BOTH;
ALTER SYSTEM SET processes=600 SCOPE=SPFILE;
ALTER SYSTEM SET sessions=800 SCOPE=SPFILE;
ALTER SYSTEM SET undo_retention=900 SCOPE=BOTH;
ALTER SYSTEM SET db_block_checking=FALSE SCOPE=BOTH;
ALTER SYSTEM SET db_block_checksum=TYPICAL SCOPE=BOTH;
ALTER SYSTEM SET enable_pluggable_database=FALSE SCOPE=SPFILE;
ALTER SYSTEM SET nls_language='AMERICAN' SCOPE=SPFILE;
ALTER SYSTEM SET nls_territory='AMERICA' SCOPE=SPFILE;
ALTER SYSTEM SET nls_date_format='DD-MON-RR' SCOPE=SPFILE;
ALTER SYSTEM SET nls_numeric_characters='.,' SCOPE=SPFILE;
ALTER SYSTEM SET nls_sort='BINARY' SCOPE=SPFILE;
ALTER SYSTEM SET nls_comp='BINARY' SCOPE=SPFILE;

-- Disable case-insensitive comparison (EBS requires binary comparison)
ALTER SYSTEM SET nls_comp='BINARY' SCOPE=SPFILE;

-- Required for EBS online patching (adop)
ALTER SYSTEM SET _adg_parselock_timeout=600 SCOPE=SPFILE;

-- Shared pool sizing for EBS
ALTER SYSTEM SET shared_pool_size=1G SCOPE=SPFILE;
ALTER SYSTEM SET shared_pool_reserved_size=100M SCOPE=SPFILE;
ALTER SYSTEM SET java_pool_size=200M SCOPE=SPFILE;

SHUTDOWN IMMEDIATE;
STARTUP;

-- Confirm version
SELECT version_full, instance_name, status FROM v\\\$instance;

-- Verify NLS settings
SELECT parameter, value FROM nls_database_parameters
WHERE parameter IN ('NLS_CHARACTERSET','NLS_NCHAR_CHARACTERSET','NLS_LANGUAGE','NLS_TERRITORY')
ORDER BY 1;
"

# ── Create EBS-required tablespaces ───────────────────────────────────────
run_sql "
CREATE TABLESPACE SYSTEM DATAFILE '/opt/oracle/oradata/\${ORACLE_SID}/system01.dbf'
  SIZE 2G AUTOEXTEND ON NEXT 500M MAXSIZE UNLIMITED;
-- Note: SYSTEM tablespace already exists from DBCA; this is a no-op if already present
-- The following creates EBS-specific tablespaces

CREATE TABLESPACE APPS_TS_TX_DATA
  DATAFILE '/opt/oracle/oradata/\${ORACLE_SID}/apptx01.dbf'
  SIZE 2G AUTOEXTEND ON NEXT 500M MAXSIZE 50G
  EXTENT MANAGEMENT LOCAL SEGMENT SPACE MANAGEMENT AUTO;

CREATE TABLESPACE APPS_TS_TX_IDX
  DATAFILE '/opt/oracle/oradata/\${ORACLE_SID}/apptxidx01.dbf'
  SIZE 1G AUTOEXTEND ON NEXT 200M MAXSIZE 20G
  EXTENT MANAGEMENT LOCAL SEGMENT SPACE MANAGEMENT AUTO;

CREATE TABLESPACE APPS_TS_SEED
  DATAFILE '/opt/oracle/oradata/\${ORACLE_SID}/appseed01.dbf'
  SIZE 500M AUTOEXTEND ON NEXT 100M MAXSIZE 10G;

CREATE TABLESPACE APPS_TS_INTERFACE
  DATAFILE '/opt/oracle/oradata/\${ORACLE_SID}/appintf01.dbf'
  SIZE 500M AUTOEXTEND ON NEXT 100M MAXSIZE 10G;

CREATE TABLESPACE APPS_TS_ARCHIVE
  DATAFILE '/opt/oracle/oradata/\${ORACLE_SID}/apparch01.dbf'
  SIZE 2G AUTOEXTEND ON NEXT 500M MAXSIZE 30G;

CREATE TABLESPACE APPS_UNDOTS1
  DATAFILE '/opt/oracle/oradata/\${ORACLE_SID}/appundo01.dbf'
  SIZE 2G AUTOEXTEND ON NEXT 500M MAXSIZE 30G;

SELECT tablespace_name, status FROM dba_tablespaces ORDER BY 1;
"

echo "[$(date +%H:%M:%S)] Oracle 19c prepared for EBS 12.2.9"
\`\`\`

---

## Script 5: Build the EBS 12.2.9 Application Tier Docker Image

\`\`\`bash
#!/bin/bash
# build_ebs_app_image.sh — create RHEL 8 base image for EBS application tier
# This builds the base OS image; EBS RapidInstall is run separately (Script 6)

set -euo pipefail

EBS_IMAGE_DIR=/opt/ebs-docker
mkdir -p \$EBS_IMAGE_DIR

cat > \${EBS_IMAGE_DIR}/Dockerfile << 'EOF'
FROM redhat/ubi8:latest

LABEL maintainer="DBA Team" \
      description="Oracle EBS 12.2.9 Application Tier Base — RHEL 8"

# Install Oracle EBS application tier prerequisites
RUN dnf install -y \
      bc \
      binutils \
      compat-openssl10 \
      elfutils-libelf \
      elfutils-libelf-devel \
      fontconfig \
      glibc \
      glibc-devel \
      glibc-headers \
      hostname \
      ksh \
      libaio \
      libaio-devel \
      libgcc \
      libnsl \
      libstdc++ \
      libstdc++-devel \
      libX11 \
      libXau \
      libxcb \
      libXi \
      libXtst \
      libXrender \
      libXext \
      make \
      net-tools \
      nfs-utils \
      openssh-server \
      openssh-clients \
      procps-ng \
      psmisc \
      smartmontools \
      sudo \
      sysstat \
      unzip \
      wget \
      xorg-x11-utils \
      xterm \
    && dnf clean all

# Create oracle user and groups
RUN groupadd -g 54321 oinstall && \
    groupadd -g 54322 dba && \
    useradd -u 54321 -g oinstall -G dba \
            -d /home/oracle -s /bin/bash oracle && \
    echo "oracle ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers

# Create EBS directory structure
RUN mkdir -p /u01/EBSapps/appl \
             /u01/EBSapps/comn \
             /u01/EBSapps/10.1.2 \
             /u02/EBSapps/appl \
             /u02/EBSapps/comn \
             /u01/oracle/VIS/db/apps_st/appl \
             /stage && \
    chown -R oracle:oinstall /u01 /u02 /stage && \
    chmod -R 755 /u01 /u02

# SSH for EBS concurrent manager and inter-service communication
RUN ssh-keygen -A && \
    echo "PermitRootLogin no" >> /etc/ssh/sshd_config && \
    echo "AllowUsers oracle" >> /etc/ssh/sshd_config

USER oracle
WORKDIR /home/oracle

RUN ssh-keygen -t rsa -N "" -f ~/.ssh/id_rsa && \
    cat ~/.ssh/id_rsa.pub >> ~/.ssh/authorized_keys && \
    chmod 600 ~/.ssh/authorized_keys

# Oracle and EBS environment
RUN cat >> /home/oracle/.bash_profile << 'PROFILE'
export ORACLE_BASE=/u01/app/oracle
export EBS_APP_BASE=/u01/EBSapps
export NLS_LANG=AMERICAN_AMERICA.AL32UTF8
export NLS_DATE_FORMAT='DD-MON-RR'
export JAVA_HOME=/u01/EBSapps/comn/util/jdk
export PATH=\$JAVA_HOME/bin:\$PATH
umask 022
PROFILE

USER root

EXPOSE 8000 8001 7001 7002

CMD ["/usr/sbin/sshd", "-D"]
EOF

echo "[$(date +%H:%M:%S)] Building EBS app tier base image..."
docker build -t ebs/appstier-base:rhel8 \$EBS_IMAGE_DIR
echo "[$(date +%H:%M:%S)] Base image built: ebs/appstier-base:rhel8"
\`\`\`

---

## Script 6: Start EBS App Tier Container and Run RapidInstall

\`\`\`bash
#!/bin/bash
# start_ebs_app_container.sh — start the EBS app tier container and mount stage media

set -euo pipefail

EBS_STAGE_DIR=/data/ebs_stage   # host path where EBS 12.2.9 media is extracted

[ -d "\$EBS_STAGE_DIR" ] || { echo "ERROR: EBS stage directory \$EBS_STAGE_DIR not found"; exit 1; }

echo "[$(date +%H:%M:%S)] Starting EBS 12.2.9 application tier container..."

docker run -d \
  --name ebsapp \
  --hostname \$EBS_HOSTNAME \
  --network ebs-net \
  --ip \$APP_CONTAINER_IP \
  --restart unless-stopped \
  --add-host \${DB_HOSTNAME}:\${DB_CONTAINER_IP} \
  --ulimit nofile=65536:65536 \
  --ulimit nproc=16384:16384 \
  -p 8000:8000 \
  -p 8001:8001 \
  -p 7001:7001 \
  -v \${EBS_BASE_DIR}/ebs_run:/u01/EBSapps \
  -v \${EBS_BASE_DIR}/ebs_patch:/u02/EBSapps \
  -v \$EBS_STAGE_DIR:/stage:ro \
  ebs/appstier-base:rhel8

echo "[$(date +%H:%M:%S)] Container ebsapp started"

# ── Generate RapidInstall configuration file (conf_EBS.txt) ───────────────
cat > /tmp/ebs_rapidinstall.conf << CONF
[GENERAL]
s_dbSid=\${ORACLE_SID}
s_dbHost=\${DB_HOSTNAME}
s_dbPort=1521
s_dbSidName=\${ORACLE_SID}
s_apps_pwd=\${APPS_PASSWORD}
s_systemPassword=\${SYS_PASSWORD}

[APPLTOP]
s_base=/u01/EBSapps
s_appsbasepath=/u01/EBSapps/appl
s_commontop=/u01/EBSapps/comn

[PATCHFSBASE]
s_patch_base=/u02/EBSapps
s_patch_appsbasepath=/u02/EBSapps/appl
s_patch_commontop=/u02/EBSapps/comn

[WEBLOGIC]
s_wls_admin_port=7001
s_oafm_port=7002
s_forms_port=8001
s_http_port=8000
s_https_port=4443
s_webentryhost=\${EBS_HOSTNAME}
s_webentrydomain=example.com
CONF

docker cp /tmp/ebs_rapidinstall.conf ebsapp:/home/oracle/conf_EBS.txt
docker exec ebsapp chown oracle:oinstall /home/oracle/conf_EBS.txt
echo "[$(date +%H:%M:%S)] RapidInstall config copied to container"

# ── Instructions for running RapidInstall ─────────────────────────────────
cat << 'INSTRUCTIONS'

To proceed with EBS 12.2.9 installation, exec into the container as oracle:

  docker exec -it -u oracle ebsapp /bin/bash

Then run RapidInstall (adjust path to match your stage directory):

  cd /stage/Disk1
  ./rapidwiz \
    -skipdbinstall \
    -conf /home/oracle/conf_EBS.txt \
    -appltop /u01/EBSapps/appl \
    -patchfsbasepath /u02/EBSapps \
    -dbhost \${DB_HOSTNAME} \
    -dbport 1521 \
    -dbsid \${ORACLE_SID} \
    -appspwd \${APPS_PASSWORD}

RapidInstall will prompt for confirmation; review and proceed.
For a fully silent install, add: -silent

The install takes approximately 90–120 minutes.
INSTRUCTIONS
\`\`\`

---

## Script 7: Post-Install EBS Environment Configuration

Run after RapidInstall completes, inside the ebsapp container as oracle.

\`\`\`bash
#!/bin/bash
# ebs_post_install_config.sh — run inside ebsapp container as oracle after rapidwiz

set -euo pipefail
source /home/oracle/.bash_profile

APP_BASE=/u01/EBSapps/appl
CONTEXT_FILE=\$(find \$APP_BASE -name "*.xml" -path "*/admin/*" | grep -v patch | head -1)

echo "[$(date +%H:%M:%S)] Post-install EBS configuration..."
echo "  Context file: \$CONTEXT_FILE"

# ── Source the EBS environment ─────────────────────────────────────────────
source \$APP_BASE/EBSapps.env run

# ── Verify APPS connection to database ────────────────────────────────────
echo "[$(date +%H:%M:%S)] Testing APPS database connection..."
sqlplus -s apps/\${APPS_PASSWORD}@\${TWO_TASK} << 'SQLEOF'
SET PAGES 20 LINES 120 FEEDBACK OFF
SELECT 'DB Connection OK' status, instance_name, version_full
FROM   v\$instance;
SELECT 'EBS Release: ' || release_name FROM fnd_product_groups;
SQLEOF

# ── Start EBS application services ────────────────────────────────────────
echo "[$(date +%H:%M:%S)] Starting EBS application services..."
\$ADMIN_SCRIPTS_HOME/adstrtal.sh apps/\${APPS_PASSWORD} << 'START_INPUT'
y
START_INPUT

echo "[$(date +%H:%M:%S)] Waiting 120s for services to stabilise..."
sleep 120

# ── Verify services ───────────────────────────────────────────────────────
echo "[$(date +%H:%M:%S)] Checking service status..."
\$ADMIN_SCRIPTS_HOME/adsstpll.sh

# ── Run autoconfig to apply context file settings ─────────────────────────
echo "[$(date +%H:%M:%S)] Running Autoconfig on application tier..."
\$AD_TOP/bin/adautocfg.sh apps/\${APPS_PASSWORD}

echo "[$(date +%H:%M:%S)] EBS post-install configuration complete"
\`\`\`

---

## Script 8: Full Validation

Run from the Docker host to validate both containers and EBS connectivity.

\`\`\`bash
#!/bin/bash
# ebs_docker_validate.sh — full validation of EBS 12.2.9 + Oracle 19c on Docker
# Run as root on the Docker host

PASS=0; WARN=0; FAIL=0
pass() { echo "  [PASS] \$1"; ((PASS++)); }
warn() { echo "  [WARN] \$1"; ((WARN++)); }
fail() { echo "  [FAIL] \$1"; ((FAIL++)); }

echo "============================================================"
echo "  Oracle EBS 12.2.9 + Oracle 19c Docker Validation"
echo "  \$(date)"
echo "============================================================"

# ── Container running state ────────────────────────────────────────────────
for CTR in ebsdb ebsapp; do
  STATUS=\$(docker inspect --format '{{.State.Status}}' "\$CTR" 2>/dev/null)
  if [ "\$STATUS" = "running" ]; then
    pass "Container \$CTR is running"
  else
    fail "Container \$CTR is not running (status: \${STATUS:-not found})"
  fi
done

# ── Oracle DB health inside ebsdb ─────────────────────────────────────────
DB_STATUS=\$(docker exec ebsdb sqlplus -s / as sysdba \
  <<< "SELECT status FROM v\\\$instance;" 2>/dev/null \
  | grep -E "OPEN|MOUNTED" | tr -d ' ')
if [ "\$DB_STATUS" = "OPEN" ]; then
  pass "Oracle 19c database is OPEN inside ebsdb container"
else
  fail "Oracle DB status: '\${DB_STATUS:-unknown}' — expected OPEN"
fi

# ── Listener health ────────────────────────────────────────────────────────
if docker exec ebsdb lsnrctl status 2>/dev/null | grep -q "READY"; then
  pass "Oracle Listener is READY inside ebsdb container"
else
  fail "Oracle Listener not READY — check: docker exec ebsdb lsnrctl status"
fi

# ── Network connectivity: app -> db ──────────────────────────────────────
if docker exec ebsapp bash -c \
   "nc -z \$DB_HOSTNAME 1521 2>/dev/null"; then
  pass "ebsapp can reach ebsdb on port 1521"
else
  fail "ebsapp cannot reach ebsdb on port 1521 — check ebs-net Docker network"
fi

# ── EBS APPS schema connection ─────────────────────────────────────────────
APPS_OK=\$(docker exec -u oracle ebsapp \
  bash -c "source /u01/EBSapps/appl/EBSapps.env run 2>/dev/null; \
  sqlplus -s apps/\${APPS_PASSWORD}@\\\$TWO_TASK <<< \
  \"SELECT 'OK' FROM dual;\" 2>/dev/null | grep -c OK" 2>/dev/null || echo 0)
if [ "\$APPS_OK" -ge 1 ] 2>/dev/null; then
  pass "APPS schema connection to database successful"
else
  fail "APPS schema cannot connect — verify APPS password and DB connectivity"
fi

# ── WebLogic Admin Server ────────────────────────────────────────────────
WLS_STATUS=\$(docker exec ebsapp bash -c \
  "curl -s -o /dev/null -w '%{http_code}' \
   http://localhost:7001/console/ 2>/dev/null" 2>/dev/null || echo "000")
if [ "\$WLS_STATUS" = "200" ] || [ "\$WLS_STATUS" = "302" ]; then
  pass "WebLogic Admin Console responding on port 7001 (HTTP \$WLS_STATUS)"
else
  warn "WebLogic Admin Console not responding on port 7001 (HTTP \$WLS_STATUS) — may still be starting"
fi

# ── EBS HTTP port ────────────────────────────────────────────────────────
EBS_STATUS=\$(curl -s -o /dev/null -w "%{http_code}" \
  "http://\${EBS_HOST_IP}:8000/OA_HTML/AppsLocalLogin.jsp" 2>/dev/null || echo "000")
if [ "\$EBS_STATUS" = "200" ] || [ "\$EBS_STATUS" = "302" ]; then
  pass "EBS login page responding on port 8000 (HTTP \$EBS_STATUS)"
else
  warn "EBS login page not responding on port 8000 (HTTP \$EBS_STATUS) — check if services are started"
fi

# ── EBS release version ──────────────────────────────────────────────────
EBS_REL=\$(docker exec -u oracle ebsapp \
  bash -c "source /u01/EBSapps/appl/EBSapps.env run 2>/dev/null; \
  sqlplus -s apps/\${APPS_PASSWORD}@\\\$TWO_TASK <<< \
  \"SELECT release_name FROM fnd_product_groups;\" 2>/dev/null | grep -oP '12\.[0-9.]+'" 2>/dev/null)
if echo "\$EBS_REL" | grep -q "12\.2"; then
  pass "EBS release confirmed: \$EBS_REL"
else
  warn "Could not confirm EBS release (got: '\${EBS_REL:-empty}')"
fi

# ── Persistent volume integrity ──────────────────────────────────────────
for DIR in \${EBS_BASE_DIR}/oradata \${EBS_BASE_DIR}/ebs_run \${EBS_BASE_DIR}/ebs_patch; do
  if [ -d "\$DIR" ] && [ "\$(ls -A \$DIR 2>/dev/null)" ]; then
    pass "Volume \$DIR exists and is populated"
  else
    warn "Volume \$DIR is empty or missing — data may not be persisted"
  fi
done

echo ""
echo "============================================================"
echo "  Result: PASS=\$PASS  WARN=\$WARN  FAIL=\$FAIL"
[ "\$FAIL" -gt 0 ] && \
  echo "  Address failures before use. Warnings are advisory." || \
  echo "  All critical checks passed."
echo "============================================================"
echo ""
echo "  EBS Login URL : http://\${EBS_HOST_IP}:8000/OA_HTML/AppsLocalLogin.jsp"
echo "  WebLogic Admin: http://\${EBS_HOST_IP}:7001/console"
echo "  DB Container  : docker exec -it ebsdb sqlplus / as sysdba"
echo "  App Container : docker exec -it -u oracle ebsapp /bin/bash"
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
