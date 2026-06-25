import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Fusion Middleware 14 Installation Runbook: RHEL 9, RCU, Domain Creation, SOA Suite, and Monitoring Scripts',
  slug: 'oracle-fusion-middleware-14-install-runbook',
  excerpt:
    'Step-by-step runbook for installing Oracle Fusion Middleware 14 on RHEL 9 — OS prerequisites, JDK 17 installation, WebLogic 14.1.1 and JRF installation, RCU schema creation against Oracle 19c, WebLogic domain creation and configuration, Node Manager as a systemd service, SOA Suite deployment, post-install validation, and crontab monitoring scripts for server health, SOAINFRA tablespace growth, and composite instance backlog.',
  category: 'fusion-middleware' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-24'),
  youtubeUrl: null,
  content: `## Overview

This runbook covers the complete Oracle Fusion Middleware 14 installation on RHEL 9, from OS prerequisite configuration through post-installation monitoring. The procedure installs WebLogic Server 14.1.1 with JRF, creates RCU schemas against an Oracle 19c repository database, creates a WebLogic domain with SOA Suite, and registers Node Manager as a systemd service for automatic restart.

---

## Environment Assumptions

| Parameter | Value (replace with site values) |
|-----------|----------------------------------|
| FMW host | fmw-host.internal.company.com |
| OS | RHEL 9 |
| Oracle OS user | oracle |
| Oracle OS group | oinstall |
| Middleware home | /u01/app/oracle/middleware |
| Domain home | /u01/app/oracle/config/domains/soa_domain |
| Application home | /u01/app/oracle/config/applications/soa_domain |
| JDK 17 home | /u01/app/oracle/java/jdk-17 |
| Repository DB host | repo-db.internal.company.com |
| Repository DB service | ORCL19C |
| Repository DB port | 1521 |
| RCU schema prefix | DEV1 |
| WebLogic admin port | 7001 (HTTP) / 7002 (HTTPS) |
| SOA managed server port | 8001 |

---

## Phase 1: OS Prerequisites (RHEL 9)

### 1.1 Install Required OS Packages

\`\`\`bash
# Run as root
dnf install -y \\
  binutils \\
  compat-openssl11 \\
  elfutils-libelf \\
  fontconfig \\
  glibc \\
  glibc-devel \\
  ksh \\
  libaio \\
  libgcc \\
  libnsl \\
  libstdc++ \\
  libstdc++-devel \\
  libXi \\
  libXrender \\
  libXtst \\
  make \\
  net-tools \\
  smartmontools \\
  sysstat \\
  unzip \\
  zip

# Verify key packages
rpm -q binutils glibc libaio libstdc++
\`\`\`

### 1.2 Create Oracle OS User and Groups

\`\`\`bash
# Run as root
groupadd -g 1001 oinstall
groupadd -g 1002 dba
useradd -u 1001 -g oinstall -G dba -d /home/oracle -s /bin/bash oracle
passwd oracle

# Create directory structure
mkdir -p /u01/app/oracle/middleware
mkdir -p /u01/app/oracle/config/domains
mkdir -p /u01/app/oracle/config/applications
mkdir -p /u01/app/oracle/java
mkdir -p /u01/app/oraInventory

chown -R oracle:oinstall /u01/app/oracle
chown -R oracle:oinstall /u01/app/oraInventory
chmod -R 775 /u01/app/oracle
\`\`\`

### 1.3 Configure OS Kernel Parameters

\`\`\`bash
# Add to /etc/sysctl.conf or /etc/sysctl.d/99-fmw.conf
cat >> /etc/sysctl.d/99-fmw.conf << 'SYSCTL'
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
SYSCTL

sysctl -p /etc/sysctl.d/99-fmw.conf
\`\`\`

### 1.4 Configure OS User Limits

\`\`\`bash
cat >> /etc/security/limits.conf << 'LIMITS'
oracle   soft   nofile    65536
oracle   hard   nofile    65536
oracle   soft   nproc     16384
oracle   hard   nproc     16384
oracle   soft   stack     10240
oracle   hard   stack     32768
LIMITS
\`\`\`

### 1.5 Disable Transparent Huge Pages

\`\`\`bash
# Add to /etc/rc.d/rc.local or create a systemd service
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# Persist across reboots via tuned profile or rc.local
cat >> /etc/rc.d/rc.local << 'RC'
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag
RC
chmod +x /etc/rc.d/rc.local
\`\`\`

### 1.6 Configure oracle User Environment

\`\`\`bash
cat >> /home/oracle/.bash_profile << 'PROFILE'
# FMW 14 Environment
export JAVA_HOME=/u01/app/oracle/java/jdk-17
export MW_HOME=/u01/app/oracle/middleware
export WL_HOME=\${MW_HOME}/wlserver
export DOMAIN_HOME=/u01/app/oracle/config/domains/soa_domain
export PATH=\${JAVA_HOME}/bin:\${MW_HOME}/oracle_common/common/bin:\${PATH}
export ORACLE_HOME=\${MW_HOME}
export CONFIG_JVM_ARGS="-Djava.security.egd=file:/dev/./urandom"
PROFILE
\`\`\`

---

## Phase 2: Install JDK 17

\`\`\`bash
# Run as oracle user
# Download OpenJDK 17 (or Oracle JDK 17) from adoptium.net or oracle.com
# Place installer in /u01/install/

cd /u01/app/oracle/java

# Extract JDK 17 (tar.gz distribution)
tar -xzf /u01/install/jdk-17.0.x_linux-x64_bin.tar.gz
ln -s jdk-17.0.x /u01/app/oracle/java/jdk-17

# Verify
export JAVA_HOME=/u01/app/oracle/java/jdk-17
export PATH=\${JAVA_HOME}/bin:\${PATH}
java -version
# Expected: openjdk version "17.x.x" or java version "17.x.x"
\`\`\`

---

## Phase 3: Install WebLogic Server 14.1.1 and JRF

### 3.1 Download Installers

From Oracle eDelivery or My Oracle Support:
- \`fmw_14.1.1.0.0_wls.jar\` — WebLogic Server 14.1.1
- \`fmw_14.1.1.0.0_infrastructure.jar\` — WebLogic + JRF (Infrastructure)
- \`fmw_14.1.1.0.0_soa.jar\` — SOA Suite (if deploying SOA)
- \`fmw_14.1.1.0.0_osb.jar\` — Service Bus (if deploying OSB)

For FMW 14 with JRF (required for SOA/OSB), use the **Infrastructure** installer, not the WebLogic-only installer.

### 3.2 Install WebLogic Infrastructure (JRF Included)

\`\`\`bash
# Run as oracle user — silent install with response file

cat > /tmp/wls_install.rsp << 'RSP'
[ENGINE]
Response File Version=1.0.0.0.0

[GENERIC]
ORACLE_HOME=/u01/app/oracle/middleware
INSTALL_TYPE=WebLogic Server
MYORACLESUPPORT_USERNAME=
MYORACLESUPPORT_PASSWORD=
DECLINE_AUTO_UPDATES=true
MOS_AUTO_UPDATES_LOCATION=
SOFTWARE_UPDATES_PROXY_SERVER=
SOFTWARE_UPDATES_PROXY_PORT=
SOFTWARE_UPDATES_PROXY_USER=
SOFTWARE_UPDATES_PROXY_PASSWORD=
SECURITY_UPDATES_VIA_MYORACLESUPPORT=false
PROXY_HOST=
PROXY_PORT=
PROXY_USER=
PROXY_PWD=
COLLECTOR_SUPPORTHUB_URL=
RSP

\${JAVA_HOME}/bin/java -Xmx1024m \\
  -jar /u01/install/fmw_14.1.1.0.0_infrastructure.jar \\
  -silent \\
  -responseFile /tmp/wls_install.rsp \\
  -invPtrLoc /u01/app/oraInventory/oraInst.loc \\
  | tee /tmp/wls_install_\$(date +%Y%m%d).log

# Verify installation
ls \${MW_HOME}/wlserver/server/lib/weblogic.jar
\${MW_HOME}/wlserver/common/bin/wlst.sh -version 2>/dev/null | head -3
\`\`\`

### 3.3 Install SOA Suite

\`\`\`bash
cat > /tmp/soa_install.rsp << 'RSP'
[ENGINE]
Response File Version=1.0.0.0.0

[GENERIC]
ORACLE_HOME=/u01/app/oracle/middleware
INSTALL_TYPE=SOA Suite
MYORACLESUPPORT_USERNAME=
MYORACLESUPPORT_PASSWORD=
DECLINE_AUTO_UPDATES=true
SECURITY_UPDATES_VIA_MYORACLESUPPORT=false
RSP

\${JAVA_HOME}/bin/java -Xmx1024m \\
  -jar /u01/install/fmw_14.1.1.0.0_soa.jar \\
  -silent \\
  -responseFile /tmp/soa_install.rsp \\
  -invPtrLoc /u01/app/oraInventory/oraInst.loc \\
  | tee /tmp/soa_install_\$(date +%Y%m%d).log

# Verify
ls \${MW_HOME}/soa/
\`\`\`

---

## Phase 4: Create RCU Schemas

RCU (Repository Creation Utility) creates the database schemas required by FMW 14 components.

### 4.1 Run RCU for JRF + SOA Suite

\`\`\`bash
# Run as oracle user
# RCU is at \${MW_HOME}/oracle_common/bin/rcu

\${MW_HOME}/oracle_common/bin/rcu \\
  -silent \\
  -createRepository \\
  -databaseType ORACLE \\
  -connectString "repo-db.internal.company.com:1521/ORCL19C" \\
  -dbUser SYS \\
  -dbRole SYSDBA \\
  -schemaPrefix DEV1 \\
  -component MDS \\
  -component IAU \\
  -component IAU_APPEND \\
  -component IAU_VIEWER \\
  -component OPSS \\
  -component WLS \\
  -component WLS_RUNTIME \\
  -component STB \\
  -component SOAINFRA \\
  -component ESS \\
  -f < /tmp/rcu_passwords.txt \\
  | tee /tmp/rcu_create_\$(date +%Y%m%d).log

# rcu_passwords.txt contains passwords in sequence (one per line):
# SYS_password
# DEV1_schema_password (used for all component schemas)
\`\`\`

### 4.2 Verify RCU Schema Creation

\`\`\`bash
sqlplus sys/password@"(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=repo-db.internal.company.com)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=ORCL19C)))" as sysdba << 'SQL'
-- Verify all RCU schemas exist
SELECT USERNAME, ACCOUNT_STATUS, DEFAULT_TABLESPACE
FROM DBA_USERS
WHERE USERNAME LIKE 'DEV1%'
ORDER BY USERNAME;

-- Check RCU version registry
SELECT COMP_ID, VERSION, STATUS FROM SCHEMA_VERSION_REGISTRY
WHERE MRC_NAME = 'DEV1'
ORDER BY COMP_ID;
SQL
\`\`\`

Expected output: all DEV1\_\* schemas with ACCOUNT\_STATUS = OPEN and all components STATUS = VALID.

---

## Phase 5: Create WebLogic Domain with SOA Suite

### 5.1 Generate Domain Creation Script

\`\`\`bash
cat > /tmp/create_soa_domain.py << 'WLST'
# WLST offline script — creates SOA Suite domain

import os

# Domain configuration
domainName      = 'soa_domain'
domainHome      = '/u01/app/oracle/config/domains/soa_domain'
appHome         = '/u01/app/oracle/config/applications/soa_domain'
mwHome          = '/u01/app/oracle/middleware'

# Credentials
adminUser       = 'weblogic'
adminPassword   = 'WebLogic_Admin_2026#'
adminPort       = 7001

# Repository DB
rcuDbUrl        = 'repo-db.internal.company.com:1521/ORCL19C'
rcuSchemaPrefix = 'DEV1'
rcuSchemaPass   = 'RCU_Schema_Pass_2026#'

# Select domain template
readTemplate(mwHome + '/soa/common/templates/wls/oracle.soa_template.jar')

# Admin server
cd('Servers/AdminServer')
set('ListenPort', adminPort)
set('ListenAddress', '')

# Create SOA Managed Server
cd('/')
create('soa_server1', 'Server')
cd('Servers/soa_server1')
set('ListenPort', 8001)
set('ListenAddress', '')

# Credentials
cd('/')
cd('Security/base_domain/User/weblogic')
cmo.setPassword(adminPassword)

# Set domain log location
setOption('DomainName', domainName)

# Configure JRF DataSource (RCU schemas)
cd('/')
getDatabaseDefaults()

# Write domain
writeDomain(domainHome)
closeTemplate()

print('Domain created successfully at: ' + domainHome)
WLST

# Run the domain creation script
\${MW_HOME}/oracle_common/common/bin/wlst.sh /tmp/create_soa_domain.py
\`\`\`

### 5.2 Configure RCU Datasources in the Domain

\`\`\`bash
# After domain creation, configure the RCU DB connection using the domain config utility
\${MW_HOME}/oracle_common/common/bin/wlst.sh << 'WLST'
connect('weblogic','WebLogic_Admin_2026#','t3://localhost:7001')

edit()
startEdit()

# Update the LocalSvcTblDataSource connection (used by all JRF components)
cd('/JDBCSystemResources/LocalSvcTblDataSource/JDBCResource/LocalSvcTblDataSource/JDBCDriverParams/LocalSvcTblDataSource')
cmo.setUrl('jdbc:oracle:thin:@//repo-db.internal.company.com:1521/ORCL19C')
cd('/JDBCSystemResources/LocalSvcTblDataSource/JDBCResource/LocalSvcTblDataSource/JDBCDriverParams/LocalSvcTblDataSource/Properties/LocalSvcTblDataSource/Property/user')
cmo.setValue('DEV1_STB')

# Set password for the datasource (use encrypt in production)
cd('/JDBCSystemResources/LocalSvcTblDataSource/JDBCResource/LocalSvcTblDataSource/JDBCDriverParams/LocalSvcTblDataSource')
cmo.setPassword('RCU_Schema_Pass_2026#')

save()
activate()
disconnect()
WLST
\`\`\`

### 5.3 Apply JRF Template to Domain (Post-Creation)

\`\`\`bash
# Extend the base domain with JRF and SOA templates
\${MW_HOME}/oracle_common/common/bin/wlst.sh << 'WLST'
readDomain('/u01/app/oracle/config/domains/soa_domain')

addTemplate('/u01/app/oracle/middleware/oracle_common/common/templates/wls/oracle.jrf_template.jar')
addTemplate('/u01/app/oracle/middleware/soa/common/templates/wls/oracle.soa.b2b_template.jar')

updateDomain()
closeDomain()

print('JRF and SOA templates applied.')
WLST
\`\`\`

---

## Phase 6: Configure Node Manager as systemd Service

### 6.1 Configure Node Manager

\`\`\`bash
# Node Manager configuration is in the domain's nodemanager directory
mkdir -p \${DOMAIN_HOME}/nodemanager

cat > \${DOMAIN_HOME}/nodemanager/nodemanager.properties << 'NM'
#Node Manager Properties
NodeManagerHome=/u01/app/oracle/config/domains/soa_domain/nodemanager
ListenAddress=fmw-host.internal.company.com
ListenPort=5556
NativeVersionEnabled=true
LogLevel=INFO
DomainsFileEnabled=true
LogFile=/u01/app/oracle/config/domains/soa_domain/nodemanager/nodemanager.log
LogLimit=0
LogCount=1
QuitEnabled=false
StartScriptEnabled=true
StartScriptName=startWebLogic.sh
StopScriptEnabled=false
CrashRecoveryEnabled=true
ServerStartFileName=startup.properties
NM
\`\`\`

### 6.2 Create systemd Service for Node Manager

\`\`\`bash
# Run as root — create systemd service
cat > /etc/systemd/system/wls-nodemanager.service << 'SERVICE'
[Unit]
Description=Oracle WebLogic Node Manager
After=network.target

[Service]
Type=forking
User=oracle
Group=oinstall
Environment="JAVA_HOME=/u01/app/oracle/java/jdk-17"
Environment="MW_HOME=/u01/app/oracle/middleware"
Environment="DOMAIN_HOME=/u01/app/oracle/config/domains/soa_domain"
ExecStart=/u01/app/oracle/config/domains/soa_domain/bin/startNodeManager.sh
ExecStop=/u01/app/oracle/config/domains/soa_domain/bin/stopNodeManager.sh
Restart=on-failure
RestartSec=30
PIDFile=/u01/app/oracle/config/domains/soa_domain/nodemanager/nodemanager.pid

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable wls-nodemanager
systemctl start wls-nodemanager
systemctl status wls-nodemanager
\`\`\`

### 6.3 Create systemd Service for Admin Server

\`\`\`bash
cat > /etc/systemd/system/wls-adminserver.service << 'SERVICE'
[Unit]
Description=Oracle WebLogic AdminServer (soa_domain)
After=network.target wls-nodemanager.service
Requires=wls-nodemanager.service

[Service]
Type=forking
User=oracle
Group=oinstall
Environment="JAVA_HOME=/u01/app/oracle/java/jdk-17"
Environment="WL_HOME=/u01/app/oracle/middleware/wlserver"
WorkingDirectory=/u01/app/oracle/config/domains/soa_domain
ExecStart=/u01/app/oracle/config/domains/soa_domain/startWebLogic.sh
ExecStop=/u01/app/oracle/config/domains/soa_domain/bin/stopWebLogic.sh
Restart=on-failure
RestartSec=60

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable wls-adminserver
systemctl start wls-adminserver
\`\`\`

---

## Phase 7: Start and Validate the Domain

### 7.1 Start Managed Servers

\`\`\`bash
# Start SOA Managed Server via Node Manager (recommended)
\${MW_HOME}/oracle_common/common/bin/wlst.sh << 'WLST'
nmConnect('weblogic','WebLogic_Admin_2026#','fmw-host.internal.company.com',5556,'soa_domain','/u01/app/oracle/config/domains/soa_domain')
nmStart('soa_server1')
nmServerStatus('soa_server1')
WLST
\`\`\`

### 7.2 Post-Installation Validation

\`\`\`bash
#!/bin/bash
# /opt/scripts/validate_fmw14_install.sh

MW_HOME=/u01/app/oracle/middleware
DOMAIN_HOME=/u01/app/oracle/config/domains/soa_domain
ADMIN_URL="http://fmw-host.internal.company.com:7001"
SOA_URL="http://fmw-host.internal.company.com:8001"
JAVA_HOME=/u01/app/oracle/java/jdk-17

echo "=== FMW 14 Post-Installation Validation: \$(date) ==="

# 1. Check Admin Server HTTP response
echo "--- 1. Admin Server Console ---"
HTTP_CODE=\$(curl -s -o /dev/null -w "%{http_code}" \\
  "\${ADMIN_URL}/console/login/LoginForm.jsp" --max-time 15)
if [ "\${HTTP_CODE}" = "200" ]; then
  echo "OK: Admin Server console accessible (HTTP \${HTTP_CODE})"
else
  echo "FAIL: Admin Server console returned HTTP \${HTTP_CODE}"
fi

# 2. Check SOA Managed Server
echo "--- 2. SOA Managed Server ---"
SOA_CODE=\$(curl -s -o /dev/null -w "%{http_code}" \\
  "\${SOA_URL}/soa-infra" --max-time 15)
if [ "\${SOA_CODE}" = "200" ]; then
  echo "OK: SOA Infrastructure endpoint accessible (HTTP \${SOA_CODE})"
else
  echo "WARN: SOA Infrastructure returned HTTP \${SOA_CODE}"
fi

# 3. Check BPEL engine via REST
echo "--- 3. SOA BPEL Engine Health ---"
curl -s -u weblogic:WebLogic_Admin_2026# \\
  "\${SOA_URL}/soa-infra/management/server/info" \\
  --max-time 15 | python3 -c "import sys,json; d=json.load(sys.stdin); print('SOA version:', d.get('serverVersion','?'))" 2>/dev/null || \\
  echo "WARN: Could not query SOA server info"

# 4. Check Node Manager
echo "--- 4. Node Manager Status ---"
systemctl is-active wls-nodemanager && echo "OK: Node Manager running" || echo "FAIL: Node Manager not running"

# 5. JDK version
echo "--- 5. JDK Version ---"
\${JAVA_HOME}/bin/java -version 2>&1 | head -1

echo "=== Validation Complete ==="
\`\`\`

---

## Phase 8: Monitoring Scripts

### Script 1: WebLogic Server Status Monitor

\`\`\`bash
#!/bin/bash
# /opt/scripts/check_wls_servers.sh
# Monitors all WebLogic Managed Servers via WLST REST

MW_HOME=/u01/app/oracle/middleware
ADMIN_URL="t3://fmw-host.internal.company.com:7001"
WLS_USER="weblogic"
WLS_PASS="WebLogic_Admin_2026#"
ALERT_EMAIL="dba-team@company.com"
LOG_FILE="/var/log/fmw_monitor/wls_status_\$(date +%Y%m%d_%H%M).log"

mkdir -p /var/log/fmw_monitor

TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
echo "=== WLS Server Status: \${TIMESTAMP} ===" | tee "\${LOG_FILE}"

\${MW_HOME}/oracle_common/common/bin/wlst.sh /dev/stdin << WLST 2>&1 | tee -a "\${LOG_FILE}"
connect('\${WLS_USER}','\${WLS_PASS}','\${ADMIN_URL}')

# Check all servers in the domain
servers = cmo.getServers()
alerts = []
for s in servers:
    name = s.getName()
    try:
        state = getCurrentServerHealth(name)
    except:
        state = 'UNKNOWN'
    print('Server: ' + name + ' | State: ' + str(state))
    if str(state) not in ['RUNNING','ADMIN']:
        alerts.append(name + ': ' + str(state))

if alerts:
    print('ALERT: Servers not in RUNNING state: ' + str(alerts))

disconnect()
WLST

# Alert if any server is not RUNNING
if grep -q "ALERT:" "\${LOG_FILE}"; then
  ALERT_BODY=\$(grep "ALERT:" "\${LOG_FILE}")
  echo -e "Subject: ALERT: WebLogic Server Down on fmw-host\n\n\${ALERT_BODY}\n\nLog: \${LOG_FILE}" \\
    | sendmail "\${ALERT_EMAIL}"
fi
\`\`\`

### Script 2: SOAINFRA Tablespace Growth Monitor

The \`_SOAINFRA\` schema stores all BPEL instance state and can grow very rapidly. Alert before it fills the tablespace.

\`\`\`bash
#!/bin/bash
# /opt/scripts/check_soainfra_tablespace.sh

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
ORACLE_SID=ORCL19C
export ORACLE_HOME ORACLE_SID PATH=\${ORACLE_HOME}/bin:\${PATH}

ALERT_EMAIL="dba-team@company.com"
WARN_PCT=70
CRIT_PCT=85
LOG_FILE="/var/log/fmw_monitor/soainfra_ts_\$(date +%Y%m%d).log"

mkdir -p /var/log/fmw_monitor
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
echo "=== SOAINFRA Tablespace Check: \${TIMESTAMP} ===" | tee "\${LOG_FILE}"

sqlplus -S / as sysdba << 'SQL' | tee -a "\${LOG_FILE}"
SET LINESIZE 120 PAGESIZE 30 FEEDBACK OFF
COLUMN TABLESPACE_NAME FORMAT A20
COLUMN USED_GB FORMAT 9999.9
COLUMN TOTAL_GB FORMAT 9999.9
COLUMN PCT_USED FORMAT 999.9

SELECT M.TABLESPACE_NAME,
       ROUND(M.USED_SPACE * 8192 / 1073741824, 1) AS USED_GB,
       ROUND(M.TABLESPACE_SIZE * 8192 / 1073741824, 1) AS TOTAL_GB,
       ROUND(100 * M.USED_SPACE / NULLIF(M.TABLESPACE_SIZE, 0), 1) AS PCT_USED
FROM DBA_TABLESPACE_USAGE_METRICS M
JOIN DBA_TABLESPACES T ON M.TABLESPACE_NAME = T.TABLESPACE_NAME
WHERE M.TABLESPACE_NAME IN (
  SELECT DEFAULT_TABLESPACE FROM DBA_USERS WHERE USERNAME LIKE '%SOAINFRA%'
  UNION
  SELECT DEFAULT_TABLESPACE FROM DBA_USERS WHERE USERNAME LIKE '%MDS%'
)
ORDER BY PCT_USED DESC;
SQL

# Read PCT_USED from query output and alert if over threshold
PCT=\$(grep -E "^\s+[A-Z_]+\s" "\${LOG_FILE}" | awk '{print \$4}' | sort -rn | head -1)

if [ -n "\${PCT}" ]; then
  PCT_INT=\${PCT%.*}
  if [ "\${PCT_INT}" -ge "\${CRIT_PCT}" ]; then
    SEVERITY="CRITICAL"
  elif [ "\${PCT_INT}" -ge "\${WARN_PCT}" ]; then
    SEVERITY="WARNING"
  else
    SEVERITY="OK"
  fi

  if [ "\${SEVERITY}" != "OK" ]; then
    echo -e "Subject: \${SEVERITY}: SOAINFRA Tablespace \${PCT}% Full\n\n\$(cat \${LOG_FILE})" \\
      | sendmail "\${ALERT_EMAIL}"
  fi
fi
\`\`\`

### Script 3: SOA Composite Instance Backlog Monitor

A growing backlog of OPEN or RUNNING BPEL instances can indicate stuck composites, slow adapters, or database contention.

\`\`\`bash
#!/bin/bash
# /opt/scripts/check_soa_instance_backlog.sh

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
ORACLE_SID=ORCL19C
export ORACLE_HOME ORACLE_SID PATH=\${ORACLE_HOME}/bin:\${PATH}

ALERT_EMAIL="dba-team@company.com"
OPEN_THRESHOLD=5000
OLD_THRESHOLD_HOURS=48
LOG_FILE="/var/log/fmw_monitor/soa_backlog_\$(date +%Y%m%d).log"

mkdir -p /var/log/fmw_monitor
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
echo "=== SOA Instance Backlog Check: \${TIMESTAMP} ===" | tee "\${LOG_FILE}"

sqlplus -S dev1_soainfra/password@"(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=repo-db.internal.company.com)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=ORCL19C)))" << SQL | tee -a "\${LOG_FILE}"
SET LINESIZE 120 PAGESIZE 30 FEEDBACK OFF
-- Open instance count by composite
SELECT COMPONENT_NAME,
       COUNT(*) AS OPEN_INSTANCES,
       MIN(CREATED_TIME) AS OLDEST_INSTANCE,
       ROUND((SYSDATE - MIN(CREATED_TIME)) * 24, 1) AS OLDEST_HOURS
FROM SOAINFRA.COMPOSITE_INSTANCE
WHERE STATE IN (0, 1)  -- 0=OPEN, 1=RUNNING
GROUP BY COMPONENT_NAME
HAVING COUNT(*) > 100
ORDER BY OPEN_INSTANCES DESC;

-- Total open instance count
SELECT COUNT(*) AS TOTAL_OPEN_INSTANCES
FROM SOAINFRA.COMPOSITE_INSTANCE
WHERE STATE IN (0, 1);

-- Instances stuck for more than 48 hours
SELECT COUNT(*) AS STUCK_INSTANCES
FROM SOAINFRA.COMPOSITE_INSTANCE
WHERE STATE IN (0, 1)
  AND CREATED_TIME < SYSDATE - 2;
SQL
\`\`\`

### Script 4: WLST-Based JVM Heap Monitor

\`\`\`bash
#!/bin/bash
# /opt/scripts/check_wls_jvm_heap.sh
# Monitors heap usage for each WLS Managed Server

MW_HOME=/u01/app/oracle/middleware
ALERT_EMAIL="dba-team@company.com"
HEAP_WARN_PCT=80
LOG_FILE="/var/log/fmw_monitor/jvm_heap_\$(date +%Y%m%d_%H%M).log"

mkdir -p /var/log/fmw_monitor
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
echo "=== JVM Heap Monitor: \${TIMESTAMP} ===" | tee "\${LOG_FILE}"

\${MW_HOME}/oracle_common/common/bin/wlst.sh /dev/stdin << 'WLST' 2>&1 | tee -a "\${LOG_FILE}"
import sys, os

try:
    connect('weblogic','WebLogic_Admin_2026#','t3://fmw-host.internal.company.com:7001')
    domainRuntime()

    servers = cmo.getServerRuntimes()
    for srv in servers:
        name = srv.getName()
        jvm = srv.getJVMRuntime()
        heap_free = jvm.getHeapFreeCurrent()
        heap_max  = jvm.getHeapSizeCurrent()
        if heap_max > 0:
            used_pct = round(100.0 * (heap_max - heap_free) / heap_max, 1)
            used_gb  = round((heap_max - heap_free) / 1073741824.0, 2)
            total_gb = round(heap_max / 1073741824.0, 2)
            status = 'WARN' if used_pct >= 80 else 'OK'
            print('Server=%s HeapUsed=%sGB/%sGB (%s%%) Status=%s' % (name, used_gb, total_gb, used_pct, status))
    disconnect()
except Exception as e:
    print('ERROR: ' + str(e))
WLST
\`\`\`

### Crontab Configuration

\`\`\`bash
# /etc/cron.d/fmw14_monitor
# Oracle Fusion Middleware 14 monitoring

MAILTO=""
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# WebLogic server status — every 5 minutes
*/5 * * * *      oracle  /opt/scripts/check_wls_servers.sh >> /var/log/fmw_monitor/cron.log 2>&1

# SOAINFRA tablespace check — every hour
0 * * * *        oracle  /opt/scripts/check_soainfra_tablespace.sh >> /var/log/fmw_monitor/cron.log 2>&1

# SOA instance backlog check — every 30 minutes
*/30 * * * *     oracle  /opt/scripts/check_soa_instance_backlog.sh >> /var/log/fmw_monitor/cron.log 2>&1

# JVM heap check — every 15 minutes during business hours
*/15 7-19 * * *  oracle  /opt/scripts/check_wls_jvm_heap.sh >> /var/log/fmw_monitor/cron.log 2>&1
\`\`\`

---

## Summary

Oracle Fusion Middleware 14 installation on RHEL 9 follows the same broad sequence as FMW 12c: OS prerequisites → JDK installation → WebLogic Infrastructure installer → product-specific installer (SOA/OSB) → RCU schema creation → domain creation via WLST → Node Manager and server configuration. The key differences from FMW 12c are JDK 17 (with module system implications), the Oracle 19c minimum requirement for the RCU repository database, and the updated TLS default settings that must be validated against all inbound integrations before go-live. Node Manager registered as a systemd service ensures managed server recovery after host reboots without manual intervention. The four monitoring scripts — WebLogic server state every 5 minutes, SOAINFRA tablespace every hour, SOA composite instance backlog every 30 minutes, and JVM heap every 15 minutes during business hours — provide operational visibility for the failure modes most common in production FMW 14 environments.`,
};

async function main() {
  console.log('Inserting Oracle Fusion Middleware 14 runbook...');
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
