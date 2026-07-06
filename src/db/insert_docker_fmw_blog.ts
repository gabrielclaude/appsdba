import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'oracle-fusion-middleware-14-docker-rhel9-installation';

const content = `
Oracle Fusion Middleware 14 (WebLogic Server 14.1.2 FMW Infrastructure) in Docker on RHEL 9 gives you a reproducible, version-pinned middleware environment that eliminates the days-long manual installation process. A domain that used to take a DBA two days to build — RCU, domain creation, pack/unpack, JVM tuning — runs from a scripted container stack in under an hour.

This post covers the complete architecture, Docker image strategy, RCU schema provisioning, domain creation pattern, and production-grade container deployment for Oracle FMW 14 on RHEL 9.

---

## What Is Oracle Fusion Middleware 14?

Oracle Fusion Middleware 14 refers to the **WebLogic Server 14.1.2** release family with the **FMW Infrastructure** overlay. FMW Infrastructure adds the components that Oracle Fusion applications depend on:

| Component | Purpose |
|---|---|
| WebLogic Server 14.1.2 | Application server runtime |
| JRF (Java Required Files) | ADF, Oracle libraries, MBean framework |
| MDS (Metadata Services) | Repository for ADF metadata, SOA composites |
| OPSS (Oracle Platform Security Services) | Credential store, policy store, keystore |
| IAU (Audit Service) | Unified audit framework |
| STB (Service Table) | Service registry |

FMW 14 runs on **JDK 17** (LTS) and is the target platform for new Oracle SOA Suite, OIM, OAM, and WebCenter deployments.

---

## Architecture Overview

\`\`\`
┌───────────────────────────────────────────────────────────────┐
│                        RHEL 9 Host                            │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                  Docker Engine                          │  │
│  │                                                         │  │
│  │  ┌──────────────────────┐  ┌──────────────────────────┐ │  │
│  │  │   fmw-admin          │  │   fmw-managed1           │ │  │
│  │  │   AdminServer        │  │   ManagedServer1         │ │  │
│  │  │   port 7001 (http)   │  │   port 8001 (http)       │ │  │
│  │  │   port 7002 (https)  │  │   port 8002 (https)      │ │  │
│  │  │   port 9002 (nmgr)   │  │                          │ │  │
│  │  └──────────────────────┘  └──────────────────────────┘ │  │
│  │                  │                      │                │  │
│  │           fmw-network (bridge, 172.21.0.0/16)           │  │
│  │                                                         │  │
│  │  Volumes:                                               │  │
│  │  ├── fmw-domain   → /u01/oracle/user_projects/domains   │  │
│  │  └── fmw-aserver  → /u01/oracle/user_projects/domains   │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  External Oracle DB (RCU schemas):                            │
│  ├── PREFIX_MDS, PREFIX_OPSS, PREFIX_STB                      │
│  └── PREFIX_IAU, PREFIX_IAU_APPEND, PREFIX_IAU_VIEWER         │
└───────────────────────────────────────────────────────────────┘
\`\`\`

### Multi-container design

Each WebLogic server process runs in its own container. The AdminServer container owns the domain directory on a shared named volume; Managed Server containers mount the same volume read-write and start via Node Manager running in the AdminServer container. This mirrors the oracle/docker-images reference topology.

---

## Hardware Requirements

| Resource | Minimum | Recommended |
|---|---|---|
| CPU cores (host) | 4 | 8+ |
| RAM (host) | 16 GB | 32 GB |
| AdminServer container memory | 4 GB | 6 GB |
| Managed Server memory each | 4 GB | 8 GB |
| Domain volume (fmw-domain) | 10 GB | 20 GB |
| OS | RHEL 9.x | RHEL 9.3+ |
| JDK inside image | 17.0.x | JDK 17 LTS latest |
| Oracle DB for RCU | 19c+ | 19c EE |

---

## RHEL 9 Host Preparation

### Kernel parameters

\`\`\`bash
cat >> /etc/sysctl.d/98-fmw-docker.conf << 'EOF'
# WebLogic needs generous file handles and shared memory
fs.file-max = 6815744
kernel.shmmax = 68719476736
kernel.shmall = 16777216
net.core.somaxconn = 4096
vm.swappiness = 10
EOF
sysctl --system
\`\`\`

### Install Docker Engine

\`\`\`bash
dnf remove -y podman buildah
dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
\`\`\`

### Create the Docker network

\`\`\`bash
docker network create --subnet=172.21.0.0/16 fmw-network
\`\`\`

---

## Building the FMW 14 Docker Image

Oracle does not publish FMW images on Docker Hub. Build them from oracle/docker-images using software downloaded from Oracle Software Delivery Cloud.

### 1. Clone oracle/docker-images

\`\`\`bash
git clone https://github.com/oracle/docker-images.git
cd docker-images
\`\`\`

### 2. Download required software

From edelivery.oracle.com, download into the appropriate directories:

\`\`\`
OracleJava/jdk-17/
  └── jdk-17_linux-x64_bin.tar.gz

OracleFMWInfrastructure/dockerfiles/14.1.2.0/
  └── fmw_14.1.2.0.0_infrastructure.jar
\`\`\`

### 3. Build the JDK 17 base image

\`\`\`bash
cd OracleJava/jdk-17
docker build -t oracle/jdk:17 .
\`\`\`

### 4. Build FMW Infrastructure image

\`\`\`bash
cd ../../OracleFMWInfrastructure/dockerfiles

./buildDockerImage.sh -v 14.1.2.0 -s
# -v  version
# -s  slim (no samples, smaller image)

# Resulting image
docker images oracle/fmw-infrastructure
# oracle/fmw-infrastructure   14.1.2.0   ...   ~3.2 GB
\`\`\`

The build script installs FMW Infrastructure silently using a response file embedded in the Dockerfile. Total build time is 15–25 minutes.

---

## RCU Schema Provisioning

RCU creates the database schemas that FMW components use for persistent storage. Run RCU from an ephemeral container — it exits when done.

### Prerequisites in the target Oracle Database

\`\`\`sql
-- Connect to Oracle DB as SYSDBA
CREATE TABLESPACE FMW_DATA
  DATAFILE '/opt/oracle/oradata/ORCLCDB/ORCLPDB1/fmw_data01.dbf' SIZE 500M
  AUTOEXTEND ON NEXT 100M MAXSIZE 4G
  EXTENT MANAGEMENT LOCAL SEGMENT SPACE MANAGEMENT AUTO;

CREATE TABLESPACE FMW_IDX
  DATAFILE '/opt/oracle/oradata/ORCLCDB/ORCLPDB1/fmw_idx01.dbf' SIZE 200M
  AUTOEXTEND ON NEXT 50M MAXSIZE 2G
  EXTENT MANAGEMENT LOCAL SEGMENT SPACE MANAGEMENT AUTO;

-- Temp tablespace (usually already exists)
-- TEMP is shared; no custom temp needed unless isolating workload
\`\`\`

### Run RCU container

\`\`\`bash
docker run --rm \
  --network fmw-network \
  -e CONNECTION_STRING=<db-host>:1521/<pdb-service> \
  -e RCUPREFIX=FMW14 \
  -e DB_PASSWORD=<sys-password> \
  -e DB_SCHEMA_PASSWORD=<schema-password> \
  -e SYSDB_USER=sys \
  -e SYSDB_ROLE=sysdba \
  oracle/fmw-infrastructure:14.1.2.0 \
  /bin/bash -c "\$ORACLE_HOME/oracle_common/bin/rcu \
    -silent -createRepository \
    -connectString \$CONNECTION_STRING \
    -dbUser \$SYSDB_USER -dbRole \$SYSDB_ROLE \
    -schemaPrefix \$RCUPREFIX \
    -component MDS \
    -component STB \
    -component OPSS \
    -component IAU \
    -component IAU_APPEND \
    -component IAU_VIEWER \
    -component WLS \
    -f < /dev/null"
\`\`\`

RCU creates schemas: \`FMW14_MDS\`, \`FMW14_OPSS\`, \`FMW14_STB\`, \`FMW14_IAU\`, \`FMW14_IAU_APPEND\`, \`FMW14_IAU_VIEWER\`, \`FMW14_WLS\`.

---

## Domain Creation

Domain creation runs in a one-shot container that writes the domain config to the named volume, then exits.

### Create the domain volume

\`\`\`bash
docker volume create fmw-domain
\`\`\`

### Domain creation script (WLST)

Save this as \`create_domain.py\` on the host:

\`\`\`python
# create_domain.py — WLST offline domain creation for FMW 14
import os

DB_HOST     = os.environ.get('DB_HOST', 'oracle-db')
DB_PORT     = os.environ.get('DB_PORT', '1521')
DB_SERVICE  = os.environ.get('DB_SERVICE', 'ORCLPDB1')
RCU_PREFIX  = os.environ.get('RCU_PREFIX', 'FMW14')
RCU_SCHEMA_PWD = os.environ.get('RCU_SCHEMA_PWD', 'Welcome1#')
DOMAIN_NAME = os.environ.get('DOMAIN_NAME', 'fmw_domain')
ADMIN_PWD   = os.environ.get('ADMIN_PWD', 'Welcome1#Weblogic')
DOMAIN_PATH = '/u01/oracle/user_projects/domains/' + DOMAIN_NAME

selectTemplate('Basic WebLogic Server Domain', '14.1.2.0')
selectTemplate('Oracle JRF', '14.1.2.0')
loadTemplates()

cd('Servers/AdminServer')
set('ListenPort', 7001)
set('ListenAddress', '')

create('AdminServer', 'SSL')
cd('SSL/AdminServer')
set('Enabled', 'True')
set('ListenPort', 7002)

cd('/')
create('ms_template', 'ServerTemplate')
cd('ServerTemplates/ms_template')
set('ListenPort', 8001)
create('ms_template', 'SSL')
cd('SSL/ms_template')
set('Enabled', 'True')
set('ListenPort', 8002)

cd('/')
create('Cluster1', 'Cluster')
cd('Clusters/Cluster1')
set('ClusterMessagingMode', 'unicast')

cd('/')
create('ManagedServer1', 'Server')
cd('Servers/ManagedServer1')
set('ListenPort', 8001)
set('Cluster', 'Cluster1')
set('ServerTemplate', 'ms_template')

cd('/')
setOption('DomainName', DOMAIN_NAME)
setOption('JavaHome', '/usr/java/jdk-17')
setOption('ServerStartMode', 'prod')

cd('/Security/base_domain/User/weblogic')
cmo.setPassword(ADMIN_PWD)

# JRF datasource configuration
fmwDb = 'jdbc:oracle:thin:@//' + DB_HOST + ':' + DB_PORT + '/' + DB_SERVICE
getDatabaseDefaults()

cd('/')
setOption('AppDir', '/u01/oracle/user_projects/applications/' + DOMAIN_NAME)
writeDomain(DOMAIN_PATH)
closeTemplate()

readDomain(DOMAIN_PATH)

# Configure RCU datasources
cd('JDBCSystemResource/LocalSvcTblDataSource/JdbcResource/LocalSvcTblDataSource/JDBCDriverParams/NO_NAME_0')
set('URL', fmwDb)
set('PasswordEncrypted', RCU_SCHEMA_PWD)
cd('Properties/NO_NAME_0/Property/user')
set('Value', RCU_PREFIX + '_STB')

updateDomain()
closeDomain()
print('Domain created at: ' + DOMAIN_PATH)
\`\`\`

### Run the domain creation container

\`\`\`bash
docker run --rm \
  --network fmw-network \
  --name fmw-domain-creator \
  -e DB_HOST=oracle-db \
  -e DB_PORT=1521 \
  -e DB_SERVICE=ORCLPDB1 \
  -e RCU_PREFIX=FMW14 \
  -e RCU_SCHEMA_PWD=<schema-password> \
  -e DOMAIN_NAME=fmw_domain \
  -e ADMIN_PWD=Welcome1#Weblogic \
  -v fmw-domain:/u01/oracle/user_projects/domains \
  -v \$(pwd)/create_domain.py:/u01/oracle/create_domain.py:ro \
  oracle/fmw-infrastructure:14.1.2.0 \
  /u01/oracle/oracle_common/common/bin/wlst.sh /u01/oracle/create_domain.py

# Verify domain was created
docker run --rm -v fmw-domain:/u01/oracle/user_projects/domains \
  oracle/fmw-infrastructure:14.1.2.0 \
  ls /u01/oracle/user_projects/domains/fmw_domain/
\`\`\`

---

## AdminServer Container

\`\`\`bash
docker run -d \
  --name fmw-admin \
  --hostname fmw-admin \
  --network fmw-network \
  --ip 172.21.0.10 \
  -p 7001:7001 \
  -p 7002:7002 \
  -p 9002:9002 \
  --memory 6g \
  --memory-swap 6g \
  --cpus 4 \
  --shm-size 512m \
  -e DOMAIN_NAME=fmw_domain \
  -e ADMIN_NAME=AdminServer \
  -e ADMIN_LISTEN_PORT=7001 \
  -e ADMIN_PASSWORD=Welcome1#Weblogic \
  -e PRODUCTION_MODE=prod \
  -v fmw-domain:/u01/oracle/user_projects/domains \
  --restart unless-stopped \
  oracle/fmw-infrastructure:14.1.2.0 \
  /u01/oracle/user_projects/domains/fmw_domain/startWebLogic.sh

# Monitor startup — wait for "Server started in RUNNING mode"
docker logs -f fmw-admin | grep -E 'RUNNING|FAILED|Exception' &
TAIL_PID=\$!
# AdminServer takes 3–5 minutes on first start
\`\`\`

### AdminServer JVM tuning (override via setUserOverrides.sh)

\`\`\`bash
docker exec fmw-admin bash -c "cat >> /u01/oracle/user_projects/domains/fmw_domain/bin/setUserOverrides.sh << 'EOF'
# G1GC — best for FMW workloads with large heaps
JAVA_OPTIONS=\"\${JAVA_OPTIONS} -XX:+UseG1GC\"
JAVA_OPTIONS=\"\${JAVA_OPTIONS} -XX:MaxGCPauseMillis=200\"
JAVA_OPTIONS=\"\${JAVA_OPTIONS} -XX:G1HeapRegionSize=16m\"
JAVA_OPTIONS=\"\${JAVA_OPTIONS} -XX:InitiatingHeapOccupancyPercent=45\"

# Heap: AdminServer typically 2–4 GB
JAVA_OPTIONS=\"\${JAVA_OPTIONS} -Xms2g -Xmx4g\"
JAVA_OPTIONS=\"\${JAVA_OPTIONS} -XX:MetaspaceSize=512m -XX:MaxMetaspaceSize=1g\"

# GC logging
JAVA_OPTIONS=\"\${JAVA_OPTIONS} -Xlog:gc*:file=/u01/oracle/user_projects/domains/fmw_domain/servers/AdminServer/logs/gc.log:time,uptime:filecount=5,filesize=20m\"

# Thread stack and JIT
JAVA_OPTIONS=\"\${JAVA_OPTIONS} -Xss512k -XX:ReservedCodeCacheSize=256m\"

export JAVA_OPTIONS
EOF"
\`\`\`

---

## Managed Server Container

\`\`\`bash
docker run -d \
  --name fmw-managed1 \
  --hostname fmw-managed1 \
  --network fmw-network \
  --ip 172.21.0.11 \
  -p 8001:8001 \
  -p 8002:8002 \
  --memory 8g \
  --memory-swap 8g \
  --cpus 4 \
  --shm-size 512m \
  -e DOMAIN_NAME=fmw_domain \
  -e SERVER_NAME=ManagedServer1 \
  -e ADMIN_HOST=fmw-admin \
  -e ADMIN_PORT=7001 \
  -e ADMIN_PASSWORD=Welcome1#Weblogic \
  -e MANAGED_SERVER_PORT=8001 \
  -v fmw-domain:/u01/oracle/user_projects/domains \
  --restart unless-stopped \
  oracle/fmw-infrastructure:14.1.2.0 \
  /u01/oracle/user_projects/domains/fmw_domain/bin/startManagedWebLogic.sh ManagedServer1 http://fmw-admin:7001
\`\`\`

---

## Persistent Volume Strategy

\`\`\`
fmw-domain volume contents:
/u01/oracle/user_projects/domains/fmw_domain/
├── config/                   ← domain config.xml and component config
├── servers/
│   ├── AdminServer/
│   │   ├── logs/             ← AdminServer.log, access.log, gc.log
│   │   └── data/store/       ← JMS persistent store, transaction logs
│   └── ManagedServer1/
│       ├── logs/
│       └── data/store/
├── security/                 ← boot.properties (keep backed up)
└── bin/                      ← setDomainEnv.sh, startWebLogic.sh
\`\`\`

Back up the domain volume regularly:

\`\`\`bash
docker run --rm \
  -v fmw-domain:/source:ro \
  -v /backups/fmw:/backup \
  alpine tar czf /backup/fmw_domain_\$(date +%Y%m%d_%H%M%S).tar.gz -C /source .
\`\`\`

---

## Systemd Service Files

\`\`\`ini
# /etc/systemd/system/fmw-admin.service
[Unit]
Description=FMW 14 AdminServer
After=docker.service network-online.target
Requires=docker.service

[Service]
TimeoutStartSec=300
TimeoutStopSec=120
Restart=on-failure
ExecStartPre=-/usr/bin/docker stop fmw-admin
ExecStartPre=-/usr/bin/docker rm fmw-admin
ExecStart=/usr/bin/docker start -a fmw-admin
ExecStop=/usr/bin/docker exec fmw-admin \
  /u01/oracle/user_projects/domains/fmw_domain/bin/stopWebLogic.sh
[Install]
WantedBy=multi-user.target
\`\`\`

\`\`\`ini
# /etc/systemd/system/fmw-managed1.service
[Unit]
Description=FMW 14 ManagedServer1
After=fmw-admin.service
Requires=fmw-admin.service

[Service]
TimeoutStartSec=300
TimeoutStopSec=120
Restart=on-failure
ExecStartPre=-/usr/bin/docker stop fmw-managed1
ExecStartPre=-/usr/bin/docker rm fmw-managed1
ExecStart=/usr/bin/docker start -a fmw-managed1
ExecStop=/usr/bin/docker exec fmw-managed1 \
  /u01/oracle/user_projects/domains/fmw_domain/bin/stopManagedWebLogic.sh ManagedServer1 http://fmw-admin:7001
[Install]
WantedBy=multi-user.target
\`\`\`

\`\`\`bash
systemctl daemon-reload
systemctl enable fmw-admin fmw-managed1
systemctl start fmw-admin
sleep 60
systemctl start fmw-managed1
\`\`\`

---

## Post-Installation Validation

\`\`\`bash
# 1. AdminServer health via REST management API
curl -u weblogic:Welcome1#Weblogic \
  http://localhost:7001/management/weblogic/latest/serverRuntime?fields=state,healthState

# 2. Managed server state via WLST
docker exec fmw-admin /u01/oracle/oracle_common/common/bin/wlst.sh -skipADMinCheck << 'EOF'
connect('weblogic', 'Welcome1#Weblogic', 't3://fmw-admin:7001')
state('ManagedServer1')
serverRuntime()
cd('ThreadPoolRuntime/ThreadPoolRuntime')
print 'Execute threads:', get('ExecuteThreadTotalCount')
print 'Stuck threads:',  get('StuckThreadCount')
print 'Idle threads:',   get('IdleThreadsCurrentCount')
disconnect()
exit()
EOF

# 3. RCU schema connectivity
docker exec fmw-admin /u01/oracle/oracle_common/common/bin/wlst.sh -skipADMinCheck << 'EOF'
connect('weblogic', 'Welcome1#Weblogic', 't3://fmw-admin:7001')
cd('JDBCSystemResources/LocalSvcTblDataSource/JDBCResource/LocalSvcTblDataSource/JDBCConnectionPoolParams/NO_NAME_0')
print 'Active connections:', get('ActiveConnectionsCurrentCount')
disconnect()
exit()
EOF

# 4. Console accessibility
curl -s -o /dev/null -w "%{http_code}" http://localhost:7001/console/
# Expected: 302 (redirect to login) or 200
\`\`\`

---

## Patching Workflow

FMW patches (PSU, CPU) apply to the image layer — not the running container.

\`\`\`bash
# 1. Download patch zip from MOS (e.g., p36912578_141200_Generic.zip)
# 2. Place in OracleFMWInfrastructure/dockerfiles/14.1.2.0/

# 3. Rebuild image with patch
cd docker-images/OracleFMWInfrastructure/dockerfiles
./buildDockerImage.sh -v 14.1.2.0 -s -p 36912578 -t oracle/fmw-infrastructure:14.1.2.0-psu

# 4. Stop and remove servers (domain volume is safe)
systemctl stop fmw-managed1 fmw-admin
docker rm fmw-admin fmw-managed1

# 5. Update systemd ExecStart image tag → 14.1.2.0-psu
sed -i 's/fmw-infrastructure:14.1.2.0/fmw-infrastructure:14.1.2.0-psu/g' \
  /etc/systemd/system/fmw-admin.service \
  /etc/systemd/system/fmw-managed1.service
systemctl daemon-reload

# 6. Start and verify patch level
systemctl start fmw-admin
docker exec fmw-admin \$ORACLE_HOME/OPatch/opatch lsinventory | grep -i "patch description"
\`\`\`

---

## Summary

| Phase | Action | Time |
|---|---|---|
| Host prep | Kernel params, Docker | 15 min |
| Image build | JDK 17 base + FMW infra | 20–30 min |
| RCU | Schema creation in Oracle DB | 10 min |
| Domain creation | WLST offline domain + JRF config | 5 min |
| AdminServer start | First boot (JRF init, OPSS seeding) | 5–8 min |
| Managed Server start | Join domain, deploy apps | 3–5 min |
| Validation | REST + WLST health checks | 5 min |

See the companion **Runbook** for day-two operations: container lifecycle, WLST-based monitoring, JVM heap analysis, JDBC pool diagnostics, and the live performance dashboard.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'Oracle Fusion Middleware 14 on RHEL 9 with Docker: Architecture and Installation Guide',
    slug,
    excerpt: 'Deploy Oracle Fusion Middleware 14 (WebLogic 14.1.2 FMW Infrastructure) in Docker on RHEL 9. Covers JDK 17 image build, RCU schema provisioning, WLST offline domain creation, AdminServer and Managed Server containers, JVM G1GC tuning, persistent volume strategy, and systemd service management.',
    content,
    category: 'docker-oracle',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
