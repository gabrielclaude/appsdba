import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Hyperion Financial Management 11.2 Installation Runbook: RHEL 8, EPM Configurator, and Monitoring Scripts',
  slug: 'oracle-hyperion-financial-management-install-runbook',
  excerpt:
    'Step-by-step runbook for installing Oracle Hyperion Financial Management 11.2 on RHEL 8 — OS prerequisites, Oracle 19c repository database preparation, EPM System Installer, EPM System Configurator, post-configuration validation, HFM application creation, and crontab monitoring scripts for WebLogic server health, HFM process availability, application schema tablespace growth, and consolidation status drift.',
  category: 'fusion-middleware' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-25'),
  youtubeUrl: null,
  content: `## Overview

This runbook covers the complete Oracle Hyperion Financial Management (HFM) 11.2 installation on RHEL 8, including Oracle EPM Foundation Services (Shared Services, Workspace), HFM, Financial Reporting, and Oracle HTTP Server. The EPM System uses its own installer and configurator rather than Oracle Universal Installer and WLST — following the correct sequence is critical because the EPM Configurator both creates database schemas and configures the WebLogic domain in a single, partially-resumable process.

---

## Environment Assumptions

| Parameter | Value (replace with site values) |
|-----------|----------------------------------|
| EPM host | epm-host.internal.company.com |
| OS | RHEL 8 |
| Oracle OS user | oracle |
| Oracle OS group | oinstall |
| EPM Oracle Home | /u01/app/oracle/Middleware/EPMSystem11R1 |
| WebLogic home | /u01/app/oracle/Middleware/EPMSystem11R1/wlserver |
| Domain home | /u01/app/oracle/config/domains/EPMSystem |
| JDK 8 home | /u01/app/oracle/java/jdk1.8.0_xxx |
| Repository DB host | repo-db.internal.company.com |
| Repository DB service | ORCL19C |
| Repository DB port | 1521 |
| HSS schema prefix | HSS |
| HFM application name | CORPFINANCE |
| WebLogic admin port | 9001 |
| Workspace port | 19000 |
| HFM managed server port | 19000 (shared with Foundation) |
| OHS HTTP port | 80 |

---

## Phase 1: OS Prerequisites (RHEL 8)

### 1.1 Install Required Packages

\`\`\`bash
# Run as root
dnf install -y \\
  binutils \\
  compat-openssl10 \\
  elfutils-libelf \\
  fontconfig \\
  glibc \\
  glibc-devel \\
  ksh \\
  libaio \\
  libaio-devel \\
  libgcc \\
  libnsl \\
  libstdc++ \\
  libstdc++-devel \\
  libX11 \\
  libXau \\
  libxcb \\
  libXi \\
  libXrender \\
  libXtst \\
  make \\
  net-tools \\
  nss \\
  sysstat \\
  unzip \\
  xorg-x11-utils

# Additional packages required for OHS
dnf install -y \\
  apr \\
  apr-util \\
  openssl \\
  openssl-devel
\`\`\`

### 1.2 Create Oracle OS User and Groups

\`\`\`bash
groupadd -g 1001 oinstall
groupadd -g 1002 dba
useradd -u 1001 -g oinstall -G dba -d /home/oracle -s /bin/bash oracle
passwd oracle

mkdir -p /u01/app/oracle/Middleware
mkdir -p /u01/app/oracle/config/domains
mkdir -p /u01/app/oracle/config/applications
mkdir -p /u01/app/oracle/java
mkdir -p /u01/app/oraInventory
mkdir -p /u01/epm_install

chown -R oracle:oinstall /u01/app/oracle
chown -R oracle:oinstall /u01/app/oraInventory
chown -R oracle:oinstall /u01/epm_install
chmod 775 /u01/app/oracle
\`\`\`

### 1.3 OS Kernel Parameters

\`\`\`bash
cat > /etc/sysctl.d/99-epm.conf << 'SYSCTL'
fs.file-max = 6815744
kernel.sem = 250 32000 100 128
kernel.shmmni = 4096
kernel.shmall = 1073741824
kernel.shmmax = 4398046511104
net.core.rmem_default = 262144
net.core.rmem_max = 4194304
net.core.wmem_default = 262144
net.core.wmem_max = 1048576
vm.swappiness = 10
SYSCTL
sysctl -p /etc/sysctl.d/99-epm.conf
\`\`\`

### 1.4 OS User Limits

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
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

cat >> /etc/rc.d/rc.local << 'RC'
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag
RC
chmod +x /etc/rc.d/rc.local
\`\`\`

### 1.6 Configure oracle User Environment

\`\`\`bash
cat >> /home/oracle/.bash_profile << 'PROFILE'
# EPM System 11.2 Environment
export JAVA_HOME=/u01/app/oracle/java/jdk1.8.0_xxx
export EPM_ORACLE_HOME=/u01/app/oracle/Middleware/EPMSystem11R1
export MW_HOME=/u01/app/oracle/Middleware/EPMSystem11R1
export DOMAIN_HOME=/u01/app/oracle/config/domains/EPMSystem
export PATH=\${JAVA_HOME}/bin:\${EPM_ORACLE_HOME}/common/bin:\${PATH}
export ORACLE_HOME=\${EPM_ORACLE_HOME}
PROFILE
\`\`\`

---

## Phase 2: Install JDK 8

EPM System 11.2 requires JDK 8 (64-bit). JDK 11 support was added in later 11.2.x updates but JDK 8 remains the most compatible option for initial installation.

\`\`\`bash
# Run as oracle user
cd /u01/app/oracle/java

# Extract JDK 8 (from Oracle download or adoptium.net)
tar -xzf /u01/epm_install/jdk-8uxxx-linux-x64.tar.gz
ln -s jdk1.8.0_xxx /u01/app/oracle/java/jdk8

export JAVA_HOME=/u01/app/oracle/java/jdk8
export PATH=\${JAVA_HOME}/bin:\${PATH}

java -version
# Expected: java version "1.8.0_xxx" 64-Bit Server VM
\`\`\`

---

## Phase 3: Prepare the Repository Database

### 3.1 Create Tablespaces

\`\`\`bash
# Run on repo-db as oracle/sysdba
sqlplus / as sysdba << 'SQL'
-- Shared Services tablespace
CREATE TABLESPACE EPM_HSS
  DATAFILE '/u01/oradata/ORCL19C/epm_hss01.dbf' SIZE 2G
  AUTOEXTEND ON NEXT 512M MAXSIZE 20G
  EXTENT MANAGEMENT LOCAL SEGMENT SPACE MANAGEMENT AUTO;

-- HFM system tablespace
CREATE TABLESPACE EPM_HFM
  DATAFILE '/u01/oradata/ORCL19C/epm_hfm01.dbf' SIZE 2G
  AUTOEXTEND ON NEXT 512M MAXSIZE 20G
  EXTENT MANAGEMENT LOCAL SEGMENT SPACE MANAGEMENT AUTO;

-- HFM application data tablespace (large for production)
CREATE TABLESPACE EPM_APPDATA
  DATAFILE '/u01/oradata/ORCL19C/epm_appdata01.dbf' SIZE 10G
  AUTOEXTEND ON NEXT 2G MAXSIZE UNLIMITED
  EXTENT MANAGEMENT LOCAL SEGMENT SPACE MANAGEMENT AUTO;

-- FDMEE tablespace (if installing FDMEE)
CREATE TABLESPACE EPM_FDMEE
  DATAFILE '/u01/oradata/ORCL19C/epm_fdmee01.dbf' SIZE 2G
  AUTOEXTEND ON NEXT 512M MAXSIZE 10G
  EXTENT MANAGEMENT LOCAL SEGMENT SPACE MANAGEMENT AUTO;

-- Temp tablespace (ensure adequate size)
ALTER TABLESPACE TEMP ADD TEMPFILE '/u01/oradata/ORCL19C/temp02.dbf' SIZE 4G AUTOEXTEND ON;

-- Set DB parameters required for EPM
ALTER SYSTEM SET OPEN_CURSORS = 1000 SCOPE=BOTH;
ALTER SYSTEM SET PROCESSES = 800 SCOPE=SPFILE;
ALTER SYSTEM SET SESSION_CACHED_CURSORS = 200 SCOPE=BOTH;

SHOW PARAMETER open_cursors;
SHOW PARAMETER processes;
SQL
\`\`\`

### 3.2 Create Repository DB Schemas

The EPM System Configurator creates schemas automatically, but pre-creating the schema users with correct tablespace assignments avoids tablespace errors during configuration.

\`\`\`bash
sqlplus / as sysdba << 'SQL'
-- Shared Services schema
CREATE USER HSS IDENTIFIED BY "HSS_Password_2026#"
  DEFAULT TABLESPACE EPM_HSS
  TEMPORARY TABLESPACE TEMP
  QUOTA UNLIMITED ON EPM_HSS;

GRANT CONNECT, RESOURCE, CREATE VIEW, CREATE SYNONYM TO HSS;
GRANT SELECT_CATALOG_ROLE TO HSS;
GRANT SELECT ON SYS.V_\$SESSION TO HSS;
GRANT SELECT ON SYS.V_\$SQL TO HSS;

-- HFM system schema
CREATE USER HYPADMIN IDENTIFIED BY "HFM_Admin_2026#"
  DEFAULT TABLESPACE EPM_HFM
  TEMPORARY TABLESPACE TEMP
  QUOTA UNLIMITED ON EPM_HFM;

GRANT CONNECT, RESOURCE, CREATE VIEW, CREATE SYNONYM TO HYPADMIN;
GRANT SELECT_CATALOG_ROLE TO HYPADMIN;

-- HFM application schema (named same as the HFM application)
CREATE USER CORPFINANCE IDENTIFIED BY "App_Password_2026#"
  DEFAULT TABLESPACE EPM_APPDATA
  TEMPORARY TABLESPACE TEMP
  QUOTA UNLIMITED ON EPM_APPDATA;

GRANT CONNECT, RESOURCE, CREATE VIEW, CREATE SYNONYM, CREATE DATABASE LINK TO CORPFINANCE;
GRANT SELECT_CATALOG_ROLE TO CORPFINANCE;
SQL
\`\`\`

### 3.3 Verify DB Connectivity from EPM Host

\`\`\`bash
# Run on epm-host as oracle user — test SQL*Net connectivity to repo DB
export ORACLE_HOME=/u01/app/oracle/Middleware/EPMSystem11R1
export PATH=\${ORACLE_HOME}/oracle_common/bin:\${PATH}

# HFM uses the Oracle thin JDBC driver — test via SQL*Plus if available,
# or via Java-based connectivity check:
\${JAVA_HOME}/bin/java \\
  -cp \${ORACLE_HOME}/oracle_common/modules/oracle.jdbc/ojdbc8.jar \\
  oracle.jdbc.OracleDriver 2>/dev/null
echo "JDBC driver check complete"

# Verify tnsnames or JDBC URL is reachable
tnsping "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=repo-db.internal.company.com)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=ORCL19C)))"
\`\`\`

---

## Phase 4: Run the EPM System Installer

### 4.1 Stage Installer Files

Download from Oracle eDelivery (search "Oracle EPM System 11.2"):
- \`V1234567-01.zip\` — EPM System Installer Part 1
- \`V1234568-01.zip\` — EPM System Installer Part 2 (if split)

\`\`\`bash
mkdir -p /u01/epm_install/media
cd /u01/epm_install/media
unzip -q /u01/epm_install/V1234567-01.zip
unzip -q /u01/epm_install/V1234568-01.zip

ls /u01/epm_install/media/
# Should contain: runInstaller or installTool.sh
\`\`\`

### 4.2 Run the EPM System Installer (Silent Mode)

\`\`\`bash
# Create silent install response file
cat > /tmp/epm_install.rsp << 'RSP'
[ENGINE]
Response File Version=1.0.0.0.0

[GENERIC]
ORACLE_HOME=/u01/app/oracle/Middleware/EPMSystem11R1
INSTALL_TYPE=EPM System
INSTALL_LOCATION=/u01/app/oracle/Middleware/EPMSystem11R1

# Components to install — select all needed
COMPONENT_SELECTION=HFM,FOUNDATION,FINANCIALREPORTING,FDMEE,OHS
RSP

# Run installer as oracle user
cd /u01/epm_install/media
\${JAVA_HOME}/bin/java -Xmx1024m \\
  -jar epmsys_installer.jar \\
  -silent \\
  -waitForCompletion \\
  -responseFile /tmp/epm_install.rsp \\
  | tee /tmp/epm_install_\$(date +%Y%m%d).log

# Verify installation completed
ls /u01/app/oracle/Middleware/EPMSystem11R1/products/FinancialManagement/
ls /u01/app/oracle/Middleware/EPMSystem11R1/products/Foundation/
\`\`\`

---

## Phase 5: Run the EPM System Configurator

The EPM System Configurator is the most critical and failure-prone step. It creates WebLogic domain, deploys applications, creates/upgrades database schemas, and registers all components in the EPM Registry. It is partially resumable — if it fails mid-way, the failed task can be re-run after fixing the root cause.

### 5.1 Pre-Configurator Checklist

\`\`\`bash
# Verify database is accessible and schemas exist
tnsping ORCL19C

# Verify adequate disk space
df -h /u01/app/oracle     # Need >= 20 GB
df -h /tmp                # Need >= 4 GB (Configurator writes temp files here)

# Verify DISPLAY is set if running GUI mode on a remote session
export DISPLAY=:0.0   # Or use X11 forwarding: ssh -X oracle@epm-host

# Verify JDK 8 is active
java -version
\`\`\`

### 5.2 Launch EPM System Configurator

\`\`\`bash
# Run as oracle user
export JAVA_HOME=/u01/app/oracle/java/jdk8
export EPM_ORACLE_HOME=/u01/app/oracle/Middleware/EPMSystem11R1
export PATH=\${JAVA_HOME}/bin:\${EPM_ORACLE_HOME}/common/bin:\${PATH}

# Launch configurator GUI
\${EPM_ORACLE_HOME}/common/config/11.2.0.0.0/configtool.sh

# For silent/CLI mode (advanced):
\${EPM_ORACLE_HOME}/common/config/11.2.0.0.0/configtool.sh -silent \\
  -responseFile /tmp/epm_config.rsp
\`\`\`

### 5.3 Configurator Step Sequence

The Configurator presents tasks in sequence. Complete them in this order without skipping:

**Step 1: Database Configuration**
- Database Type: Oracle Database
- Host: repo-db.internal.company.com
- Port: 1521
- Service Name: ORCL19C
- HSS Schema User: HSS
- HSS Schema Password: HSS_Password_2026#
- DBA User: SYS (with SYSDBA role)
- DBA Password: \<sys_password\>

**Step 2: Configure Foundation Services (Shared Services)**
- WebLogic Admin User: weblogic
- WebLogic Admin Password: WLS_Admin_2026#
- WebLogic Domain: EPMSystem
- Domain Home: /u01/app/oracle/config/domains/EPMSystem
- Admin Server Port: 9001
- Foundation Services Server Port: 28080

**Step 3: Deploy Foundation Services Applications**
- The Configurator deploys Shared Services and Workspace to WebLogic
- This step starts the AdminServer and FoundationServices managed server
- Wait for both servers to reach RUNNING state before proceeding

**Step 4: Configure HFM**
- HFM Server Host: epm-host.internal.company.com
- HFM Port: 19000
- HFM Schema User: HYPADMIN
- HFM Schema Password: HFM_Admin_2026#

**Step 5: Deploy HFM**
- Deploys HFM web application to the HFM managed server
- Starts the HFM managed server

**Step 6: Configure Financial Reporting**
- FR Server Port: 8200
- FR Print Server: configured on same host

**Step 7: Configure Oracle HTTP Server (if installed)**
- OHS HTTP Port: 80
- OHS HTTPS Port: 443
- Configure as reverse proxy for Workspace (port 19000 → OHS 80)

**Step 8: Validate Configuration**
- The Configurator runs internal validation checks
- All components should show green checkmarks
- Any red indicator requires investigating the Configurator log before proceeding

### 5.4 Configurator Log Location

\`\`\`bash
# Review configurator logs if any step fails
ls /u01/app/oracle/Middleware/EPMSystem11R1/diagnostics/logs/config/

# Main configuration log
tail -100 /u01/app/oracle/Middleware/EPMSystem11R1/diagnostics/logs/config/configtool.log

# Component-specific deploy log
ls /u01/app/oracle/Middleware/EPMSystem11R1/diagnostics/logs/deployments/
\`\`\`

---

## Phase 6: Post-Configuration Validation

### 6.1 Verify All EPM Services Are Running

\`\`\`bash
# Check WebLogic domain status via Node Manager or directly
# EPM provides start/stop scripts in the domain bin directory

\${DOMAIN_HOME}/bin/startWebLogic.sh &
sleep 120

# Check AdminServer is running
curl -s -o /dev/null -w "%{http_code}" \\
  http://epm-host.internal.company.com:9001/console/login/LoginForm.jsp
# Expected: 200

# Check Foundation Services (Shared Services)
curl -s -o /dev/null -w "%{http_code}" \\
  http://epm-host.internal.company.com:28080/interop/index.jsp
# Expected: 200 or 302

# Check Workspace
curl -s -o /dev/null -w "%{http_code}" \\
  http://epm-host.internal.company.com:19000/workspace/browse/index.jsp
# Expected: 200 or 302

# Check HFM
curl -s -o /dev/null -w "%{http_code}" \\
  http://epm-host.internal.company.com:19000/hfmadf/
# Expected: 200 or 302
\`\`\`

### 6.2 EPM Diagnostics Utility

EPM System provides a built-in diagnostics tool that tests connectivity between all components:

\`\`\`bash
# Launch EPM Diagnostics Framework
\${EPM_ORACLE_HOME}/common/diagnostics/11.2.0.0.0/bin/runDiag.sh \\
  -username admin \\
  -password Admin_2026# \\
  -outputDir /tmp/epm_diag

# Review the generated HTML report
ls /tmp/epm_diag/
# Open epm_diag_report.html in a browser — green = OK, red = configuration issue
\`\`\`

### 6.3 Create the EPM System systemd Services

\`\`\`bash
# Run as root — create systemd service for EPM startup/shutdown

cat > /etc/systemd/system/epm-nodemanager.service << 'SERVICE'
[Unit]
Description=Oracle EPM Node Manager
After=network.target

[Service]
Type=forking
User=oracle
Group=oinstall
Environment="JAVA_HOME=/u01/app/oracle/java/jdk8"
Environment="EPM_ORACLE_HOME=/u01/app/oracle/Middleware/EPMSystem11R1"
ExecStart=/u01/app/oracle/Middleware/EPMSystem11R1/common/bin/startEPMSystem.sh nodemanager
ExecStop=/u01/app/oracle/Middleware/EPMSystem11R1/common/bin/stopEPMSystem.sh nodemanager
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
SERVICE

cat > /etc/systemd/system/epm-system.service << 'SERVICE'
[Unit]
Description=Oracle EPM System Components
After=network.target epm-nodemanager.service
Requires=epm-nodemanager.service

[Service]
Type=forking
User=oracle
Group=oinstall
Environment="JAVA_HOME=/u01/app/oracle/java/jdk8"
Environment="EPM_ORACLE_HOME=/u01/app/oracle/Middleware/EPMSystem11R1"
ExecStart=/u01/app/oracle/Middleware/EPMSystem11R1/common/bin/startEPMSystem.sh
ExecStop=/u01/app/oracle/Middleware/EPMSystem11R1/common/bin/stopEPMSystem.sh
TimeoutStartSec=600
Restart=on-failure
RestartSec=60

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable epm-nodemanager epm-system
\`\`\`

---

## Phase 7: Create and Validate an HFM Application

### 7.1 Access Shared Services Console

Open a browser and navigate to:
\`http://epm-host.internal.company.com:19000/workspace\`

Log in with the EPM admin account configured during installation.

Navigate: **Application → Consolidation → Financial Management**

### 7.2 Create an HFM Application

\`\`\`
Application → Financial Management → New Application

Application Name: CORPFINANCE
Description: Corporate Financial Consolidation
Profile File: (upload a pre-configured .per profile file or use defaults)
Application Server: epm-host.internal.company.com
Database: ORCL19C
Application Schema User: CORPFINANCE
Application Schema Password: App_Password_2026#
\`\`\`

The application creation process:
1. Creates the application schema tables in the CORPFINANCE Oracle schema
2. Loads the default metadata template
3. Registers the application in the HFM system schema
4. Makes the application available to provisioned users

### 7.3 Verify Application Database Schema

\`\`\`bash
sqlplus sys/password@"(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=repo-db.internal.company.com)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=ORCL19C)))" as sysdba << 'SQL'
-- Verify HFM application schema objects
SELECT OBJECT_TYPE, COUNT(*) AS CNT
FROM DBA_OBJECTS
WHERE OWNER = 'CORPFINANCE'
GROUP BY OBJECT_TYPE
ORDER BY CNT DESC;

-- Verify key HFM tables
SELECT TABLE_NAME FROM DBA_TABLES
WHERE OWNER = 'CORPFINANCE'
  AND TABLE_NAME IN ('HSVCELL','HSVEVENTDATA','HSVJOURNALHDR','HSVACCOUNTDESC')
ORDER BY TABLE_NAME;
SQL
\`\`\`

---

## Phase 8: Monitoring Scripts

### Script 1: EPM Component Health Check

\`\`\`bash
#!/bin/bash
# /opt/scripts/check_epm_health.sh
# Checks HTTP availability of all EPM components

EPM_HOST="epm-host.internal.company.com"
ALERT_EMAIL="dba-team@company.com"
LOG_FILE="/var/log/epm_monitor/health_\$(date +%Y%m%d_%H%M).log"
TIMEOUT=15

mkdir -p /var/log/epm_monitor

declare -A EPM_URLS=(
  ["WebLogic Admin"]="http://\${EPM_HOST}:9001/console/login/LoginForm.jsp"
  ["Workspace"]="http://\${EPM_HOST}:19000/workspace/browse/index.jsp"
  ["Shared Services"]="http://\${EPM_HOST}:28080/interop/index.jsp"
  ["HFM Web"]="http://\${EPM_HOST}:19000/hfmadf/"
  ["Financial Reporting"]="http://\${EPM_HOST}:8200/hr/common/logon/logon.jsp"
)

TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
echo "=== EPM Health Check: \${TIMESTAMP} ===" | tee "\${LOG_FILE}"

ALERTS=""
for NAME in "\${!EPM_URLS[@]}"; do
  URL="\${EPM_URLS[\${NAME}]}"
  HTTP_CODE=\$(curl -s -o /dev/null -w "%{http_code}" --max-time \${TIMEOUT} "\${URL}" 2>/dev/null)
  if [[ "\${HTTP_CODE}" =~ ^(200|302|301)$ ]]; then
    echo "OK:   \${NAME} — HTTP \${HTTP_CODE}" | tee -a "\${LOG_FILE}"
  else
    echo "FAIL: \${NAME} — HTTP \${HTTP_CODE} (URL: \${URL})" | tee -a "\${LOG_FILE}"
    ALERTS+="\nFAIL: \${NAME} — HTTP \${HTTP_CODE}"
  fi
done

if [ -n "\${ALERTS}" ]; then
  echo -e "Subject: ALERT: EPM Component Down on \${EPM_HOST}\n\n\${ALERTS}\n\nLog: \${LOG_FILE}" \\
    | sendmail "\${ALERT_EMAIL}"
fi
\`\`\`

### Script 2: HFM WebLogic Process Monitor

\`\`\`bash
#!/bin/bash
# /opt/scripts/check_hfm_processes.sh
# Verifies WebLogic managed servers and HFM Financial Management process

EPM_ORACLE_HOME=/u01/app/oracle/Middleware/EPMSystem11R1
JAVA_HOME=/u01/app/oracle/java/jdk8
export JAVA_HOME EPM_ORACLE_HOME PATH=\${JAVA_HOME}/bin:\${EPM_ORACLE_HOME}/common/bin:\${PATH}

ALERT_EMAIL="dba-team@company.com"
LOG_FILE="/var/log/epm_monitor/process_\$(date +%Y%m%d_%H%M).log"
WLS_ADMIN_URL="t3://epm-host.internal.company.com:9001"
WLS_USER="weblogic"
WLS_PASS="WLS_Admin_2026#"

mkdir -p /var/log/epm_monitor
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
echo "=== HFM Process Monitor: \${TIMESTAMP} ===" | tee "\${LOG_FILE}"

# 1. Check WebLogic managed server states via WLST
\${EPM_ORACLE_HOME}/common/bin/wlst.sh /dev/stdin << WLST 2>&1 | tee -a "\${LOG_FILE}"
try:
    connect('\${WLS_USER}','\${WLS_PASS}','\${WLS_ADMIN_URL}')
    servers = cmo.getServers()
    for s in servers:
        name = s.getName()
        try:
            state = serverRuntime(name).getState()
        except:
            state = 'UNKNOWN (AdminServer may be checking)'
        print('WLS Server: ' + name + ' | State: ' + str(state))
    disconnect()
except Exception as e:
    print('ERROR connecting to WebLogic: ' + str(e))
WLST

# 2. Check HFM Java process (Financial Management service)
HFM_PROCS=\$(pgrep -f "HFMFinancialManagementServer\|hypfmapi" | wc -l)
echo "HFM Financial Management processes running: \${HFM_PROCS}" | tee -a "\${LOG_FILE}"

if [ "\${HFM_PROCS}" -eq 0 ]; then
  MSG="ALERT: No HFM Financial Management processes found on \$(hostname) at \${TIMESTAMP}"
  echo "\${MSG}" | tee -a "\${LOG_FILE}"
  echo -e "Subject: ALERT: HFM Process Not Running\n\n\${MSG}" | sendmail "\${ALERT_EMAIL}"
fi
\`\`\`

### Script 3: HFM Application Schema Tablespace Monitor

\`\`\`bash
#!/bin/bash
# /opt/scripts/check_hfm_tablespace.sh
# Monitors EPM/HFM database tablespace usage

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_HOME PATH=\${ORACLE_HOME}/bin:\${PATH}
DB_CONNECT="sys/sys_password@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=repo-db.internal.company.com)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=ORCL19C)))"

ALERT_EMAIL="dba-team@company.com"
WARN_PCT=70
CRIT_PCT=85
LOG_FILE="/var/log/epm_monitor/tablespace_\$(date +%Y%m%d).log"

mkdir -p /var/log/epm_monitor
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
echo "=== HFM Tablespace Check: \${TIMESTAMP} ===" | tee "\${LOG_FILE}"

sqlplus -S "\${DB_CONNECT}" as sysdba << 'SQL' | tee -a "\${LOG_FILE}"
SET LINESIZE 120 PAGESIZE 40 FEEDBACK OFF
COLUMN TABLESPACE_NAME FORMAT A20
COLUMN USED_GB FORMAT 9999.9
COLUMN TOTAL_GB FORMAT 9999.9
COLUMN PCT_USED FORMAT 999.9

SELECT M.TABLESPACE_NAME,
       ROUND(M.USED_SPACE * 8192 / 1073741824, 1) AS USED_GB,
       ROUND(M.TABLESPACE_SIZE * 8192 / 1073741824, 1) AS TOTAL_GB,
       ROUND(100 * M.USED_SPACE / NULLIF(M.TABLESPACE_SIZE, 0), 1) AS PCT_USED
FROM DBA_TABLESPACE_USAGE_METRICS M
WHERE M.TABLESPACE_NAME IN ('EPM_HSS','EPM_HFM','EPM_APPDATA','EPM_FDMEE')
ORDER BY PCT_USED DESC;
SQL

# Parse max PCT and alert
MAX_PCT=\$(grep -E "EPM_" "\${LOG_FILE}" | awk '{print \$4}' | sort -rn | head -1)
MAX_PCT_INT=\${MAX_PCT%.*}

if [ -n "\${MAX_PCT_INT}" ] && [ "\${MAX_PCT_INT}" -ge "\${CRIT_PCT}" ]; then
  SEVERITY="CRITICAL"
elif [ -n "\${MAX_PCT_INT}" ] && [ "\${MAX_PCT_INT}" -ge "\${WARN_PCT}" ]; then
  SEVERITY="WARNING"
else
  SEVERITY="OK"
fi

if [ "\${SEVERITY}" != "OK" ]; then
  echo -e "Subject: \${SEVERITY}: EPM Tablespace \${MAX_PCT}% Full\n\n\$(cat \${LOG_FILE})" \\
    | sendmail "\${ALERT_EMAIL}"
fi
\`\`\`

### Script 4: HFM Consolidation Status Drift Monitor

A large count of entities in CN (Consolidation Needed) status indicates stalled consolidations.

\`\`\`bash
#!/bin/bash
# /opt/scripts/check_hfm_consolidation_status.sh
# Alerts on excessive CN-status cells in the HFM application

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_HOME PATH=\${ORACLE_HOME}/bin:\${PATH}

# Connect as the HFM application schema user
APP_SCHEMA="CORPFINANCE"
APP_PASS="App_Password_2026#"
DB_CONNECT="\${APP_SCHEMA}/\${APP_PASS}@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=repo-db.internal.company.com)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=ORCL19C)))"

ALERT_EMAIL="dba-team@company.com"
CN_THRESHOLD=500   # Alert if more than 500 entity/period cells need consolidation
LOG_FILE="/var/log/epm_monitor/consol_status_\$(date +%Y%m%d).log"

mkdir -p /var/log/epm_monitor
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
echo "=== HFM Consolidation Status: \${TIMESTAMP} ===" | tee "\${LOG_FILE}"

sqlplus -S "\${DB_CONNECT}" << 'SQL' | tee -a "\${LOG_FILE}"
SET LINESIZE 120 PAGESIZE 30 FEEDBACK OFF
COLUMN SCENARIO FORMAT A20
COLUMN YEAR_PER FORMAT A12
COLUMN CN_COUNT FORMAT 999999

-- Count CN-status cells by Scenario and Period
-- HSVCELL stores consolidation status; consol_status = 1 means CN
SELECT S.SCENARIO_DESC AS SCENARIO,
       TO_CHAR(C.YEAR) || '/' || LPAD(C.PERIOD,2,'0') AS YEAR_PER,
       COUNT(*) AS CN_COUNT
FROM HSVCELL C
JOIN HSVSCENDESC S ON C.SCENARIO = S.SCENARIO_NUM
WHERE C.CONSOL_STATUS = 1   -- CN = Consolidation Needed
  AND C.YEAR >= TO_NUMBER(TO_CHAR(SYSDATE,'YYYY')) - 1
GROUP BY S.SCENARIO_DESC, C.YEAR, C.PERIOD
HAVING COUNT(*) > 50
ORDER BY CN_COUNT DESC;

-- Total CN count
SELECT COUNT(*) AS TOTAL_CN_CELLS
FROM HSVCELL
WHERE CONSOL_STATUS = 1
  AND YEAR >= TO_NUMBER(TO_CHAR(SYSDATE,'YYYY')) - 1;
SQL

# Extract total CN count
TOTAL_CN=\$(grep "TOTAL_CN_CELLS" -A2 "\${LOG_FILE}" | tail -1 | tr -d ' ')

if [ -n "\${TOTAL_CN}" ] && [ "\${TOTAL_CN}" -gt "\${CN_THRESHOLD}" ]; then
  MSG="ALERT: \${TOTAL_CN} HFM cells in CN (Consolidation Needed) status — threshold: \${CN_THRESHOLD}. Check HFM for stalled consolidation jobs."
  echo "\${MSG}" | tee -a "\${LOG_FILE}"
  echo -e "Subject: ALERT: HFM Consolidation Backlog (\${TOTAL_CN} cells)\n\n\${MSG}\n\nLog: \${LOG_FILE}" \\
    | sendmail "\${ALERT_EMAIL}"
fi
\`\`\`

### Script 5: HFM Log Error Scanner

\`\`\`bash
#!/bin/bash
# /opt/scripts/check_hfm_logs.sh
# Scans HFM and WebLogic logs for critical errors

EPM_ORACLE_HOME=/u01/app/oracle/Middleware/EPMSystem11R1
DOMAIN_HOME=/u01/app/oracle/config/domains/EPMSystem
ALERT_EMAIL="dba-team@company.com"
LOG_FILE="/var/log/epm_monitor/log_scan_\$(date +%Y%m%d_%H%M).log"

mkdir -p /var/log/epm_monitor
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
echo "=== HFM Log Error Scan: \${TIMESTAMP} ===" | tee "\${LOG_FILE}"

# HFM application log
HFM_LOG="\${EPM_ORACLE_HOME}/diagnostics/logs/hfm/hfm.log"
# WebLogic HFM managed server log
WLS_HFM_LOG="\${DOMAIN_HOME}/servers/HFM0/logs/HFM0.log"

declare -A LOG_FILES=(
  ["HFM Application"]="\${HFM_LOG}"
  ["WLS HFM Server"]="\${WLS_HFM_LOG}"
  ["Foundation Services"]="\${DOMAIN_HOME}/servers/FoundationServices0/logs/FoundationServices0.log"
)

ERRORS_FOUND=""
for NAME in "\${!LOG_FILES[@]}"; do
  LOGF="\${LOG_FILES[\${NAME}]}"
  if [ -f "\${LOGF}" ]; then
    # Scan last 1000 lines for CRITICAL/ERROR/Exception entries from last hour
    RECENT_ERRORS=\$(tail -1000 "\${LOGF}" | \\
      grep -E "(CRITICAL|ORA-|java\.lang\.OutOfMemory|FatalError|SEVERE)" | \\
      grep -v "^#" | tail -20)
    if [ -n "\${RECENT_ERRORS}" ]; then
      echo "=== ERRORS in \${NAME} ===" | tee -a "\${LOG_FILE}"
      echo "\${RECENT_ERRORS}" | tee -a "\${LOG_FILE}"
      ERRORS_FOUND+="\n=== \${NAME} ===\n\${RECENT_ERRORS}"
    else
      echo "OK: No critical errors in \${NAME}" | tee -a "\${LOG_FILE}"
    fi
  else
    echo "WARN: Log file not found: \${LOGF}" | tee -a "\${LOG_FILE}"
  fi
done

if [ -n "\${ERRORS_FOUND}" ]; then
  echo -e "Subject: ALERT: Critical Errors in HFM Logs\n\n\${ERRORS_FOUND}\n\nFull scan: \${LOG_FILE}" \\
    | sendmail "\${ALERT_EMAIL}"
fi
\`\`\`

### Crontab Configuration

\`\`\`bash
# /etc/cron.d/epm_monitor
# Oracle EPM / HFM monitoring

MAILTO=""
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# EPM component HTTP health check — every 5 minutes
*/5 * * * *       oracle  /opt/scripts/check_epm_health.sh >> /var/log/epm_monitor/cron.log 2>&1

# HFM WebLogic process check — every 5 minutes
*/5 * * * *       oracle  /opt/scripts/check_hfm_processes.sh >> /var/log/epm_monitor/cron.log 2>&1

# HFM tablespace check — every hour
0 * * * *         oracle  /opt/scripts/check_hfm_tablespace.sh >> /var/log/epm_monitor/cron.log 2>&1

# Consolidation status drift — every 30 minutes during business hours
*/30 6-22 * * *   oracle  /opt/scripts/check_hfm_consolidation_status.sh >> /var/log/epm_monitor/cron.log 2>&1

# Log error scan — every 15 minutes
*/15 * * * *      oracle  /opt/scripts/check_hfm_logs.sh >> /var/log/epm_monitor/cron.log 2>&1
\`\`\`

---

## Phase 9: Common Post-Installation Issues and Fixes

### EPM Registry Connectivity Failure

If components fail to start citing EPM Registry errors:

\`\`\`bash
# Re-run the EPM System Configurator for the affected component only
\${EPM_ORACLE_HOME}/common/config/11.2.0.0.0/configtool.sh

# Select "Re-configure" for the failed component
# The Configurator re-registers the component in the Shared Services database
# without recreating existing schemas or losing data
\`\`\`

### Shared Services Cannot Connect to DB

\`\`\`bash
# Verify HSS schema connectivity from EPM host
sqlplus HSS/HSS_Password_2026#@"(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=repo-db.internal.company.com)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=ORCL19C)))" << 'SQL'
SELECT COUNT(*) FROM HFM_APPLICATIONS;
SQL

# If login fails, check:
# 1. DB account is not locked: SELECT ACCOUNT_STATUS FROM DBA_USERS WHERE USERNAME='HSS';
# 2. DB listener is running on repo-db
# 3. Network/firewall allows TCP 1521 from epm-host to repo-db
\`\`\`

### HFM Application Locked After Failed Consolidation

\`\`\`bash
# If a consolidation was interrupted, entities may be locked in the HFM schema
# Unlock via HFM web UI:
# Tools → Manage → Consolidation Process → select locked entity → Unlock

# Or directly in the DB (last resort — take a backup first):
sqlplus CORPFINANCE/App_Password_2026#@ORCL19C << 'SQL'
-- Check for locked consolidation processes
SELECT ENTITY, SCENARIO, YEAR, PERIOD, LOCK_USER, LOCK_TIME
FROM HSVLOCKS
WHERE LOCK_TYPE = 'C';  -- C = consolidation lock

-- Remove stale locks (only if confirmed stale — verify no consolidation is running)
-- DELETE FROM HSVLOCKS WHERE LOCK_TYPE = 'C' AND LOCK_TIME < SYSDATE - 1;
-- COMMIT;
SQL
\`\`\`

---

## Summary

Oracle Hyperion Financial Management 11.2 installation follows a strictly sequential process: OS prerequisites → JDK 8 → repository database tablespace and schema preparation → EPM System Installer (binaries only) → EPM System Configurator (WebLogic domain + schema creation + application deployment). The Configurator is the most failure-sensitive step — interrupting it mid-run leaves the environment in a partially configured state that requires careful log analysis and selective re-execution of failed tasks. The EPM Registry in the Shared Services database is the central coordination point for all EPM components; registry connectivity failures affect all components simultaneously and are resolved by re-running the Configurator for the affected component. The five monitoring scripts — EPM HTTP health check, HFM process availability, application schema tablespace usage, consolidation status drift, and log error scanning — cover the primary failure modes that affect production HFM environments: component availability, JVM crashes, database space exhaustion, stalled consolidations, and application-level errors that surface in logs before they cause user-visible failures.`,
};

async function main() {
  console.log('Inserting Oracle Hyperion Financial Management runbook...');
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
