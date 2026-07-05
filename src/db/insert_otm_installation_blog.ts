import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Transportation Management 6.4: Installation, Architecture, and WebLogic Deployment',
  slug: 'oracle-transportation-management-installation-architecture-weblogic',
  excerpt:
    'A complete guide to installing Oracle Transportation Management 6.4 on Oracle Linux with WebLogic 14c and Oracle Database 19c — covering architecture, RCU schema provisioning, domain creation, application deployment, integration gateway setup, and production validation.',
  category: 'otm' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-05'),
  youtubeUrl: null,
  content: `## Introduction

Oracle Transportation Management (OTM) is Oracle's flagship logistics and freight planning application — a Java EE system built on Oracle WebLogic Server that handles freight order management, carrier tendering, route optimization, shipment tracking, and freight settlement across road, rail, air, and ocean modes.

OTM 6.4 is the current on-premise release. It sits on a three-tier stack: Oracle Database 19c (or 12.2) as the persistence layer, Oracle WebLogic Server 14.1.1 as the application container, and the OTM application itself deployed as a WebLogic application archive. The Oracle Fusion Middleware Java Required Files (JRF) layer provides ADF (Application Development Framework) for the web UI, Oracle Platform Security Services (OPSS) for authentication and authorization, and MDS (Metadata Services) for configuration storage.

This post walks through a single-node production-grade installation on Oracle Linux 8. Every command and configuration value is real — this is not a developer sandbox setup.

---

## Summary

| Component | Version | Notes |
|-----------|---------|-------|
| OS | Oracle Linux 8.9 | RHEL 8 compatible |
| JDK | Oracle JDK 17.0.x | Required for WLS 14.1.1 |
| WebLogic | 14.1.1.0.0 | FMW Infrastructure edition (includes JRF) |
| Oracle DB | 19.21 | Separate server strongly recommended |
| OTM | 6.4.3 | Includes GC3 Graphical Component |
| RCU Schemas | OTM, STB, OPSS, MDS, IAU | Provisioned via RCU before domain creation |

---

## Architecture Overview

### Component Layout

\`\`\`
                    ┌──────────────────────────────────────────────┐
                    │           Oracle Linux 8 — App Server         │
                    │                                              │
                    │   ┌─────────────────────────────────────┐   │
                    │   │        WebLogic Domain: otm_domain   │   │
                    │   │                                      │   │
                    │   │  AdminServer  :7001 (mgmt)           │   │
                    │   │  otm_server1  :7401 (OTM app)        │   │
                    │   │  intg_server1 :7501 (Integration GW) │   │
                    │   └──────────────┬──────────────────────┘   │
                    │                  │ JDBC                      │
                    └──────────────────┼──────────────────────────┘
                                       │
                    ┌──────────────────┼──────────────────────────┐
                    │    Oracle DB 19c  │   Separate DB Server      │
                    │                  │                           │
                    │   OTM Schema (GLOGOWNER)                     │
                    │   OPSS Schema    (DEV_OPSS)                  │
                    │   MDS Schema     (DEV_MDS)                   │
                    │   STB Schema     (DEV_STB)                   │
                    │   IAU Schema     (DEV_IAU)                   │
                    └──────────────────────────────────────────────┘
\`\`\`

### Key Schemas Explained

**GLOGOWNER** is the core OTM schema — every freight order, shipment, carrier rate, route, and business object lives here. It is the largest schema (50+ GB in production) and where all performance tuning effort is focused.

**DEV_OPSS** holds Oracle Platform Security Services data — user credentials, application roles, and security policy grants. OTM reads this on every login.

**DEV_MDS** holds ADF Metadata Services data — UI customizations, task flow definitions, and page layout overrides. Rarely changes after initial setup.

**DEV_STB** is the Service Table schema — a lightweight registry of FMW component service endpoints.

**DEV_IAU** is the Audit schema — records OPSS security events. Can grow large if auditing is fully enabled; partition this table in production.

### WebLogic Thread Pools

Each managed server maintains an execute thread pool. For OTM, thread pool sizing is critical:

| Server | Default Threads | Recommended Production |
|--------|----------------|----------------------|
| AdminServer | 25 | 25 (not user-facing) |
| otm_server1 | 25 | 75–150 |
| intg_server1 | 25 | 50 |

Threads that process requests for longer than 600 seconds become "stuck" — WebLogic logs a STUCK THREAD alert and marks the thread as unavailable. Threads active for 10+ minutes but under the stuck threshold are "hogging" threads. Both conditions degrade throughput and indicate either long-running OTM business logic or database contention.

---

## Prerequisites

### OS Configuration

\`\`\`bash
# Required kernel parameters — add to /etc/sysctl.d/99-otm.conf
cat >> /etc/sysctl.d/99-otm.conf << 'EOF'
fs.file-max = 6815744
kernel.sem = 250 32000 100 128
kernel.shmmni = 4096
kernel.shmall = 1073741824
kernel.shmmax = 4398046511104
net.core.rmem_default = 262144
net.core.rmem_max = 4194304
net.core.wmem_default = 262144
net.core.wmem_max = 1048576
net.ipv4.conf.all.rp_filter = 2
net.ipv4.conf.default.rp_filter = 2
fs.aio-max-nr = 1048576
net.ipv4.ip_local_port_range = 9000 65500
EOF
sysctl -p /etc/sysctl.d/99-otm.conf

# Required OS packages
dnf install -y gcc gcc-c++ make binutils glibc glibc-devel \
  libaio libaio-devel libgcc libstdc++ libstdc++-devel \
  ksh sysstat compat-openssl11 unzip tar

# Disable THP (TransparentHugePage) — required for Oracle DB, recommended for WLS JVM
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo 'echo never > /sys/kernel/mm/transparent_hugepage/enabled' >> /etc/rc.local
\`\`\`

### User and Directory Setup

\`\`\`bash
# Create OS users
groupadd -g 54321 oinstall
groupadd -g 54322 dba
useradd -u 54321 -g oinstall -G dba -m -s /bin/bash oracle

# Directory layout
mkdir -p /u01/app/oracle/product/jdk17
mkdir -p /u01/app/oracle/product/wls14
mkdir -p /u01/app/oracle/product/otm64
mkdir -p /u01/app/oracle/domains/otm_domain
mkdir -p /u01/app/oracle/logs
mkdir -p /data/otm/filestore
chown -R oracle:oinstall /u01/app/oracle /data/otm

# oracle user profile — add to ~oracle/.bash_profile
cat >> /home/oracle/.bash_profile << 'EOF'
export JAVA_HOME=/u01/app/oracle/product/jdk17
export WL_HOME=/u01/app/oracle/product/wls14/wlserver
export MW_HOME=/u01/app/oracle/product/wls14
export OTM_HOME=/u01/app/oracle/product/otm64
export DOMAIN_HOME=/u01/app/oracle/domains/otm_domain
export PATH=\${JAVA_HOME}/bin:\${MW_HOME}/oracle_common/bin:\${PATH}
export ORACLE_BASE=/u01/app/oracle
EOF
\`\`\`

### Limits Configuration

\`\`\`bash
# /etc/security/limits.d/99-otm.conf
cat > /etc/security/limits.d/99-otm.conf << 'EOF'
oracle   soft   nofile    131072
oracle   hard   nofile    131072
oracle   soft   nproc     131072
oracle   hard   nproc     131072
oracle   soft   memlock   134217728
oracle   hard   memlock   134217728
oracle   soft   stack     10240
oracle   hard   stack     32768
EOF
\`\`\`

---

## Step 1: Install Oracle JDK 17

\`\`\`bash
su - oracle
# Download Oracle JDK 17 (requires Oracle account — use wget with cookie)
# Assumes jdk-17_linux-x64_bin.tar.gz is staged in /tmp

tar xzf /tmp/jdk-17_linux-x64_bin.tar.gz -C /u01/app/oracle/product/jdk17 --strip-components=1
java -version
# Expected: openjdk version "17.0.x"
\`\`\`

---

## Step 2: Install WebLogic Server 14.1.1 (FMW Infrastructure)

OTM requires the **FMW Infrastructure** edition of WebLogic — not the standard WebLogic edition. FMW Infrastructure includes JRF (ADF, OPSS, MDS) which OTM depends on.

\`\`\`bash
su - oracle

# Assumes fmw_14.1.1.0.0_infrastructure.jar staged in /tmp
java -jar /tmp/fmw_14.1.1.0.0_infrastructure.jar \
  ORACLE_HOME=/u01/app/oracle/product/wls14 \
  -silent \
  -responseFile /tmp/wls_install.rsp

# /tmp/wls_install.rsp content:
# [ENGINE]
# Response File Version=1.0.0.0.0
# [GENERIC]
# ORACLE_HOME=/u01/app/oracle/product/wls14
# INSTALL_TYPE=FMW Infrastructure
\`\`\`

Verify the installation:

\`\`\`bash
ls /u01/app/oracle/product/wls14/wlserver/server/lib/weblogic.jar
ls /u01/app/oracle/product/wls14/oracle_common/bin/rcu
\`\`\`

---

## Step 3: Provision RCU Schemas

The Repository Creation Utility (RCU) creates the Oracle database schemas that WebLogic and OTM require. Run this against the target database as SYSDBA.

\`\`\`bash
su - oracle
cd /u01/app/oracle/product/wls14/oracle_common/bin

# Create schemas — replace DB_HOST, DB_PORT, DB_SERVICE with your values
./rcu \
  -silent \
  -createRepository \
  -connectString DB_HOST:1521/OTMPRD \
  -dbUser SYS \
  -dbRole SYSDBA \
  -schemaPrefix DEV \
  -component STB \
  -component OPSS \
  -component MDS \
  -component IAU \
  -component IAU_APPEND \
  -component IAU_VIEWER \
  -f < /tmp/rcu_passwords.txt

# /tmp/rcu_passwords.txt — one line per schema password (SYS password first):
# SysPassword1
# SchemaPassword1
# SchemaPassword1
# SchemaPassword1
# SchemaPassword1
# SchemaPassword1
# SchemaPassword1
\`\`\`

### OTM-Specific Schema (GLOGOWNER)

OTM's own schema is created by the OTM installer, not RCU. However, you must pre-create the tablespace and user grant:

\`\`\`sql
-- Run as SYSDBA on the database server
CREATE TABLESPACE glog_data
  DATAFILE '/data/oradata/OTMPRD/glog_data01.dbf' SIZE 10G
  AUTOEXTEND ON NEXT 1G MAXSIZE 200G
  EXTENT MANAGEMENT LOCAL UNIFORM SIZE 1M
  SEGMENT SPACE MANAGEMENT AUTO;

CREATE TABLESPACE glog_index
  DATAFILE '/data/oradata/OTMPRD/glog_index01.dbf' SIZE 5G
  AUTOEXTEND ON NEXT 512M MAXSIZE 100G
  EXTENT MANAGEMENT LOCAL UNIFORM SIZE 1M
  SEGMENT SPACE MANAGEMENT AUTO;

CREATE USER glogowner
  IDENTIFIED BY "SecurePassword1"
  DEFAULT TABLESPACE glog_data
  TEMPORARY TABLESPACE temp
  QUOTA UNLIMITED ON glog_data
  QUOTA UNLIMITED ON glog_index;

GRANT CONNECT, RESOURCE, DBA TO glogowner;
GRANT SELECT ANY DICTIONARY TO glogowner;
GRANT CREATE ANY DIRECTORY TO glogowner;
\`\`\`

---

## Step 4: Create WebLogic Domain

\`\`\`bash
su - oracle
source ~/.bash_profile

# Create domain using the FMW config wizard in silent mode
java -jar /u01/app/oracle/product/wls14/wlserver/common/bin/config.sh \
  -mode=silent \
  -template=/u01/app/oracle/product/wls14/oracle_common/common/templates/wls/oracle.wls_template.jar \
  -log=/tmp/domain_creation.log \
  DOMAIN_NAME=otm_domain \
  DOMAIN_HOME=/u01/app/oracle/domains/otm_domain \
  ADMIN_SERVER_NAME=AdminServer \
  ADMIN_SERVER_LISTEN_PORT=7001 \
  ADMIN_SERVER_LISTEN_ADDRESS= \
  ADMIN_USERNAME=weblogic \
  ADMIN_PASSWORD=WlsAdmin1 \
  SERVER_START_MODE=prod
\`\`\`

After domain creation, extend it with JRF (required for OTM):

\`\`\`bash
# Extend domain with JRF template
java -jar /u01/app/oracle/product/wls14/wlserver/common/bin/config.sh \
  -mode=silent \
  -extensiontemplate=/u01/app/oracle/product/wls14/oracle_common/common/templates/wls/oracle.jrf_template.jar \
  DOMAIN_HOME=/u01/app/oracle/domains/otm_domain

# Configure OPSS and MDS JDBC data sources — update datasources in config.xml
# to point to DEV_OPSS and DEV_MDS schemas created by RCU above
\`\`\`

### Add OTM Managed Servers

\`\`\`python
# connect_and_extend.py — WLST script to add managed servers
connect('weblogic', 'WlsAdmin1', 't3://localhost:7001')
edit()
startEdit()

# OTM application server
cd('/')
cmo.createServer('otm_server1')
cd('Servers/otm_server1')
cmo.setListenPort(7401)
cmo.setListenAddress('')

# Integration Gateway server
cd('/')
cmo.createServer('intg_server1')
cd('Servers/intg_server1')
cmo.setListenPort(7501)

# Thread pool sizing for OTM
cd('/Servers/otm_server1/ThreadPool/otm_server1')
cmo.setMaxThreadsConstraintMax(150)

# Stuck thread timeout (default 600s — increase for long freight optimization runs)
cd('/Servers/otm_server1')
cmo.setStuckThreadMaxTime(900)
cmo.setStuckThreadTimerInterval(60)

save()
activate()
disconnect()
\`\`\`

---

## Step 5: Install OTM 6.4

\`\`\`bash
su - oracle
source ~/.bash_profile

# Stage the OTM installer
# Assumes otm_V6.4.3_linux64.zip staged in /tmp
unzip /tmp/otm_V6.4.3_linux64.zip -d /tmp/otm_installer
cd /tmp/otm_installer

# Run OTM installer in silent mode
java -jar otm_installer.jar \
  -silent \
  -responseFile /tmp/otm_install.rsp

# Key /tmp/otm_install.rsp parameters:
# OTM_HOME=/u01/app/oracle/product/otm64
# DB_CONNECT_STRING=DB_HOST:1521/OTMPRD
# DB_SCHEMA_USER=glogowner
# DB_SCHEMA_PASSWORD=SecurePassword1
# DB_DBA_USER=SYS
# DB_DBA_PASSWORD=SysPassword1
# DOMAIN_HOME=/u01/app/oracle/domains/otm_domain
# MANAGED_SERVER_NAME=otm_server1
# MANAGED_SERVER_PORT=7401
# INTEGRATION_SERVER_NAME=intg_server1
# INTEGRATION_SERVER_PORT=7501
# FILESTORE_DIR=/data/otm/filestore
# ADMIN_SERVER_HOST=localhost
# ADMIN_SERVER_PORT=7001
# WEBLOGIC_USER=weblogic
# WEBLOGIC_PASSWORD=WlsAdmin1
\`\`\`

The OTM installer will:
1. Create the GLOGOWNER schema objects (800+ tables, indexes, packages)
2. Deploy the OTM EAR file to the WebLogic domain
3. Configure JDBC data sources for the GLOGOWNER connection pool
4. Set up the Integration Gateway EAR
5. Create the OTM FTP server configuration

---

## Step 6: Configure JDBC Connection Pool

OTM is database-intensive. The JDBC connection pool must be tuned before go-live.

\`\`\`xml
<!-- Edit via WebLogic Admin Console or config.xml -->
<!-- Path: domain/config/jdbc/otm-jdbc.xml -->

<jdbc-data-source>
  <name>OTMDataSource</name>
  <jdbc-driver-params>
    <url>jdbc:oracle:thin:@//DB_HOST:1521/OTMPRD</url>
    <driver-name>oracle.jdbc.OracleDriver</driver-name>
    <properties>
      <property><name>user</name><value>glogowner</value></property>
      <property><name>oracle.net.CONNECT_TIMEOUT</name><value>10000</value></property>
      <property><name>oracle.jdbc.ReadTimeout</name><value>300000</value></property>
    </properties>
    <password-encrypted>encrypted_password</password-encrypted>
  </jdbc-driver-params>
  <jdbc-connection-pool-params>
    <min-capacity>25</min-capacity>
    <max-capacity>100</max-capacity>
    <capacity-increment>5</capacity-increment>
    <test-connections-on-reserve>true</test-connections-on-reserve>
    <test-table-name>SQL SELECT 1 FROM DUAL</test-table-name>
    <connection-creation-retry-frequency-seconds>10</connection-creation-retry-frequency-seconds>
    <connection-reserve-timeout-seconds>30</connection-reserve-timeout-seconds>
    <statement-cache-size>100</statement-cache-size>
    <statement-cache-type>LRU</statement-cache-type>
    <init-sql>ALTER SESSION SET CURSOR_SHARING=EXACT</init-sql>
  </jdbc-connection-pool-params>
</jdbc-data-source>
\`\`\`

---

## Step 7: JVM Tuning

\`\`\`bash
# Edit /u01/app/oracle/domains/otm_domain/bin/setUserOverrides.sh

cat > /u01/app/oracle/domains/otm_domain/bin/setUserOverrides.sh << 'EOF'
#!/bin/bash
# OTM JVM settings for otm_server1 (adjust heap to 60-70% of available RAM)

if [ "\${SERVER_NAME}" = "otm_server1" ]; then
  JAVA_OPTIONS="\${JAVA_OPTIONS} -Xms8g -Xmx16g"
  JAVA_OPTIONS="\${JAVA_OPTIONS} -XX:+UseG1GC"
  JAVA_OPTIONS="\${JAVA_OPTIONS} -XX:MaxGCPauseMillis=500"
  JAVA_OPTIONS="\${JAVA_OPTIONS} -XX:G1HeapRegionSize=32m"
  JAVA_OPTIONS="\${JAVA_OPTIONS} -XX:+ParallelRefProcEnabled"
  JAVA_OPTIONS="\${JAVA_OPTIONS} -XX:+DisableExplicitGC"
  JAVA_OPTIONS="\${JAVA_OPTIONS} -Djava.security.egd=file:/dev/./urandom"
  JAVA_OPTIONS="\${JAVA_OPTIONS} -Doracle.jdbc.fanEnabled=false"
  export JAVA_OPTIONS
fi

if [ "\${SERVER_NAME}" = "intg_server1" ]; then
  JAVA_OPTIONS="\${JAVA_OPTIONS} -Xms2g -Xmx4g"
  JAVA_OPTIONS="\${JAVA_OPTIONS} -XX:+UseG1GC"
  export JAVA_OPTIONS
fi
EOF
chmod +x /u01/app/oracle/domains/otm_domain/bin/setUserOverrides.sh
\`\`\`

---

## Step 8: Start the Domain

\`\`\`bash
su - oracle
source ~/.bash_profile

# Start AdminServer
cd /u01/app/oracle/domains/otm_domain/bin
nohup ./startWebLogic.sh > /u01/app/oracle/logs/admin_server.log 2>&1 &
echo $! > /u01/app/oracle/logs/admin_server.pid

# Wait for AdminServer to be RUNNING (watch log)
tail -f /u01/app/oracle/logs/admin_server.log | grep -m1 "Server started in RUNNING mode"

# Start OTM managed server
nohup ./startManagedWebLogic.sh otm_server1 t3://localhost:7001 \
  > /u01/app/oracle/logs/otm_server1.log 2>&1 &

# Start Integration Gateway
nohup ./startManagedWebLogic.sh intg_server1 t3://localhost:7001 \
  > /u01/app/oracle/logs/intg_server1.log 2>&1 &
\`\`\`

### systemd Unit Files

\`\`\`ini
# /etc/systemd/system/wls-admin.service
[Unit]
Description=WebLogic AdminServer - OTM Domain
After=network.target

[Service]
Type=forking
User=oracle
Group=oinstall
Environment="JAVA_HOME=/u01/app/oracle/product/jdk17"
ExecStart=/u01/app/oracle/domains/otm_domain/bin/startWebLogic.sh
ExecStop=/u01/app/oracle/domains/otm_domain/bin/stopWebLogic.sh
PIDFile=/u01/app/oracle/logs/admin_server.pid
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
\`\`\`

---

## Step 9: Post-Install Validation

\`\`\`bash
# 1. Check all servers are RUNNING via WLST
/u01/app/oracle/product/wls14/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic', 'WlsAdmin1', 't3://localhost:7001')
domainRuntime()
cd('ServerRuntimes')
servers = ls(returnMap='true')
for s in servers:
    cd(s)
    state = get('State')
    print(s + ': ' + state)
    cd('..')
disconnect()
exit()
EOF

# 2. Verify OTM schema object count
sqlplus glogowner/SecurePassword1@DB_HOST:1521/OTMPRD << 'EOF'
SELECT object_type, COUNT(*) FROM user_objects
WHERE status = 'VALID'
GROUP BY object_type ORDER BY 1;
EXIT;
EOF
# Expected: ~800+ TABLE, ~400+ INDEX, ~200+ PACKAGE BODY entries

# 3. Test OTM web UI
curl -sk https://localhost:7401/GC3/glog.webserver.util.Ping | grep -i "ping"
# Expected: HTTP 200 with ping response

# 4. Verify JDBC pool connectivity
/u01/app/oracle/product/wls14/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic', 'WlsAdmin1', 't3://localhost:7001')
serverRuntime()
cd('JDBCServiceRuntime/otm_server1/JDBCDataSourceRuntimeMBeans/OTMDataSource')
print('Active connections: ' + str(get('ActiveConnectionsCurrentCount')))
print('Connection state:   ' + str(get('State')))
disconnect()
exit()
EOF
\`\`\`

---

## Database Tuning for OTM

OTM's GLOGOWNER schema runs complex multi-table joins for freight rate shopping and route optimization. Two init.ora parameters matter most:

\`\`\`sql
-- Run as SYSDBA
ALTER SYSTEM SET cursor_sharing = EXACT SCOPE=BOTH;
ALTER SYSTEM SET open_cursors = 2000 SCOPE=BOTH;
ALTER SYSTEM SET session_cached_cursors = 100 SCOPE=BOTH;
ALTER SYSTEM SET db_file_multiblock_read_count = 128 SCOPE=BOTH;

-- OTM frequently uses parallel query for large optimization runs
ALTER SYSTEM SET parallel_max_servers = 32 SCOPE=BOTH;
ALTER SYSTEM SET parallel_degree_policy = MANUAL SCOPE=BOTH;

-- Partitioning on the GLOG_ORDER table (largest table in GLOGOWNER)
-- Typically done during initial installation response file
\`\`\`

---

## Integration Gateway Configuration

The Integration Gateway (intg_server1) handles inbound and outbound message exchange with ERP systems (EBS, SAP, NetSuite) via XML, flat file, and web service adapters.

\`\`\`xml
<!-- /u01/app/oracle/product/otm64/conf/integration/gateway.conf -->
<gateway-config>
  <ftp-server>
    <enabled>true</enabled>
    <port>10021</port>
    <passive-port-range>10100-10200</passive-port-range>
    <root-dir>/data/otm/filestore/ftp</root-dir>
  </ftp-server>
  <inbound-directory>/data/otm/filestore/inbound</inbound-directory>
  <outbound-directory>/data/otm/filestore/outbound</outbound-directory>
  <error-directory>/data/otm/filestore/error</error-directory>
  <poll-interval-seconds>30</poll-interval-seconds>
  <thread-pool-size>10</thread-pool-size>
</gateway-config>
\`\`\`

---

## Conclusion

OTM 6.4 is a heavyweight application — the full stack (JDK, WebLogic FMW Infrastructure, RCU schemas, OTM itself) requires careful sequencing and a correctly prepared database. The schema provisioning sequence (RCU first, GLOGOWNER tablespace second, OTM installer third) is non-negotiable: skipping or reordering steps produces cryptic installer failures.

Production tuning focuses on three areas: JDBC connection pool sizing (too small causes request queuing; too large overwhelms the database), JVM heap allocation (OTM's ADF renderer is memory-intensive, especially during multi-stop route optimization), and WebLogic thread pool configuration (stuck and hogging threads are the primary indicator of database-side bottlenecks — see the companion runbook for monitoring scripts).
`,
};

async function main() {
  await db.insert(posts).values(post);
  console.log('Inserted:', post.slug);
}

main().catch(console.error);
