import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'FMW Application Server Tier Runbook: WebLogic and Coherence Production Configuration',
  slug: 'fmw-application-server-tier-runbook',
  excerpt:
    'Step-by-step runbook for configuring a production Oracle Fusion Middleware application server tier — WebLogic domain creation, cluster setup, Node Manager, GridLink datasources, JDBC transaction logs, Coherence integration, Coherence*Web session persistence, and a crontab-scheduled monitoring stack for the full tier.',
  category: 'fusion-middleware' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-19'),
  youtubeUrl: null,
  content: `## Pre-Configuration Checklist

Before starting, confirm the following are in place on all application server hosts.

### Environment Inventory

| Component | Minimum version | Notes |
|-----------|----------------|-------|
| Oracle JDK | 17 (LTS) | Must match WebLogic certification matrix |
| WebLogic Server | 14.1.2 | Or 12.2.1.4 for FMW 12c products |
| Oracle Coherence | 14.1.2 | Ships bundled with WebLogic 14c |
| Oracle DB | 19c / 21c | For RCU schemas and JDBC TLOG |
| OS | OL 8 / RHEL 8/9 | 64-bit, kernel tuning applied |

### Pre-Flight Checks

\`\`\`bash
# Verify Java version
java -version 2>&1 | head -1

# Verify WebLogic installation
ls -la \${MW_HOME}/wlserver/server/lib/weblogic.jar

# Verify Coherence installation
ls -la \${MW_HOME}/coherence/lib/coherence.jar

# Verify OS ulimits for oracle/wls user
ulimit -n   # open files — must be >= 65536
ulimit -u   # max processes — must be >= 16384
ulimit -s   # stack size — must be unlimited or >= 10240

# Verify hostname resolves on all hosts
for host in wls-host1 wls-host2 coherence-node1 coherence-node2; do
  nslookup \${host} || echo "FAIL: \${host} does not resolve"
done

# Verify ports are free
for port in 7001 8001 8002 8888 9000; do
  ss -tnlp | grep -q ":\${port} " && echo "PORT \${port} IN USE" || echo "PORT \${port} free"
done
\`\`\`

---

## Phase 1 — RCU Schema Creation

The Repository Creation Utility (RCU) creates the database schemas required by FMW products. Run RCU before creating the WebLogic domain.

\`\`\`bash
# Run RCU (graphical or silent mode)
\${MW_HOME}/oracle_common/bin/rcu \
  -silent \
  -createRepository \
  -connectString db-host:1521/SOAEDG \
  -dbUser sys \
  -dbRole sysdba \
  -schemaPrefix DEV \
  -component SOAINFRA \
  -component ESB \
  -component MDS \
  -component IAU \
  -component IAU_APPEND \
  -component IAU_VIEWER \
  -component OPSS \
  -component WLS \
  -f < rcu_passwords.txt
\`\`\`

\`\`\`bash
# rcu_passwords.txt — one password per schema (in order)
# Main schema password
WelcomePass1
# STB password
WelcomePass1
# OPSS
WelcomePass1
# MDS
WelcomePass1
# IAU
WelcomePass1
# IAU_APPEND
WelcomePass1
# IAU_VIEWER
WelcomePass1
# WLS
WelcomePass1
# SOAINFRA
WelcomePass1
# ESB
WelcomePass1
\`\`\`

\`\`\`sql
-- Verify RCU schemas were created
SELECT username, account_status, created
FROM   dba_users
WHERE  username LIKE 'DEV_%'
ORDER  BY username;
\`\`\`

---

## Phase 2 — WebLogic Domain Creation

### 2.1 Run the Configuration Wizard

\`\`\`bash
\${MW_HOME}/oracle_common/common/bin/config.sh
\`\`\`

In the wizard:
1. **Create a new domain** → select domain location: \`/u01/app/oracle/user_projects/domains/soa_domain\`
2. **Templates**: select "Oracle SOA Suite" (or your FMW product)
3. **Application location**: \`/u01/app/oracle/user_projects/applications/soa_domain\`
4. **Admin credentials**: set \`weblogic\` password
5. **Domain mode**: Production
6. **JDK**: confirm path to JDK 17
7. **Database**: enter RCU connection details and test
8. **Managed Servers**: add \`soa_server1\` (host1:8001) and \`soa_server2\` (host2:8001)
9. **Cluster**: create \`soa_cluster\`, add both servers
10. **Machines**: create Machine1 (host1) and Machine2 (host2)
11. **Assign**: \`soa_server1\` → Machine1, \`soa_server2\` → Machine2

### 2.2 Verify Domain Structure

\`\`\`bash
DOMAIN_HOME=/u01/app/oracle/user_projects/domains/soa_domain

ls \${DOMAIN_HOME}/
# Expected: bin  config  init-info  logs  nodemanager  servers  wlst_offline_utils.jar

ls \${DOMAIN_HOME}/config/
# Expected: config.xml  fmwconfig  jdbc  jms  lib  nodemanager  security

cat \${DOMAIN_HOME}/config/config.xml | grep -E '<name>|<listen-port>|<cluster-name>' | head -30
\`\`\`

---

## Phase 3 — Node Manager Configuration

Node Manager must run on every host. It is the process that starts, stops, and monitors Managed Servers on behalf of the Administration Server.

### 3.1 Configure Node Manager

\`\`\`bash
DOMAIN_HOME=/u01/app/oracle/user_projects/domains/soa_domain
NM_HOME=\${DOMAIN_HOME}/nodemanager

# Edit nodemanager.properties
cat > \${NM_HOME}/nodemanager.properties <<'NM_PROPS'
NodeManagerHome=/u01/app/oracle/user_projects/domains/soa_domain/nodemanager
ListenAddress=wls-host1
ListenPort=5556
SecureListener=true
LogFile=/u01/app/oracle/user_projects/domains/soa_domain/nodemanager/nodemanager.log
LogLevel=INFO
DomainsFile=/u01/app/oracle/user_projects/domains/soa_domain/nodemanager/nodemanager.domains
NodeManagerType=PerDomainNodeManager
StartScriptEnabled=true
StartScriptName=startManagedWebLogic.sh
StopScriptEnabled=false
CrashRecoveryEnabled=true
NativeVersionEnabled=true
QuitEnabled=false
AuthenticationEnabled=true
NM_PROPS

# Create the domains file
echo "soa_domain=\${DOMAIN_HOME}" > \${NM_HOME}/nodemanager.domains
\`\`\`

### 3.2 Create Node Manager systemd Service

\`\`\`bash
cat > /etc/systemd/system/wls-nodemanager.service <<'SYSTEMD'
[Unit]
Description=WebLogic Node Manager
After=network.target

[Service]
Type=simple
User=oracle
Group=oinstall
Environment=MW_HOME=/u01/app/oracle/product/fmw
Environment=JAVA_HOME=/u01/jdk17
Environment=DOMAIN_HOME=/u01/app/oracle/user_projects/domains/soa_domain
ExecStart=/u01/app/oracle/user_projects/domains/soa_domain/bin/startNodeManager.sh
ExecStop=/u01/app/oracle/user_projects/domains/soa_domain/bin/stopNodeManager.sh
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
SYSTEMD

systemctl daemon-reload
systemctl enable wls-nodemanager
systemctl start wls-nodemanager
systemctl status wls-nodemanager
\`\`\`

### 3.3 Enroll Domain with Node Manager

\`\`\`bash
\${MW_HOME}/oracle_common/common/bin/wlst.sh <<'EOF'
nmConnect('weblogic', 'password', 'wls-host1', '5556', 'soa_domain',
          '/u01/app/oracle/user_projects/domains/soa_domain', 'SSL')
nmEnroll('/u01/app/oracle/user_projects/domains/soa_domain',
         '/u01/app/oracle/user_projects/domains/soa_domain/nodemanager')
nmDisconnect()
exit()
EOF
\`\`\`

Repeat on wls-host2 with updated \`ListenAddress\`.

---

## Phase 4 — GridLink Datasource Configuration

### 4.1 Verify ONS on the Database

\`\`\`sql
-- Run on the Oracle RAC database
SELECT inst_id, instance_name, status FROM gv$instance ORDER BY inst_id;
SELECT * FROM v$ons;
EXEC dbms_service.create_service('soasvc', 'soasvc');
EXEC dbms_service.start_service('soasvc');
\`\`\`

\`\`\`bash
# Verify ONS is reachable from the WebLogic host
\${MW_HOME}/oracle_common/jdk/jre/bin/java \
  -cp \${MW_HOME}/oracle_common/modules/oracle.ons/ons.jar \
  oracle.ons.ONSClient -nodes db-node1:6200,db-node2:6200 -status
\`\`\`

### 4.2 Create GridLink Datasource via WLST

\`\`\`bash
\${MW_HOME}/oracle_common/common/bin/wlst.sh <<'EOF'
connect('weblogic', 'password', 't3://admin-host:7001')
edit()
startEdit()

# Create GridLink datasource
cd('/')
cmo.createJDBCSystemResource('SOADataSource')
cd('/JDBCSystemResources/SOADataSource/JDBCResource/SOADataSource')
cmo.setName('SOADataSource')

cd('/JDBCSystemResources/SOADataSource/JDBCResource/SOADataSource/JDBCDataSourceParams/SOADataSource')
set('JNDINames', jarray.array(['jdbc/SOADataSource'], String))

cd('/JDBCSystemResources/SOADataSource/JDBCResource/SOADataSource/JDBCConnectionPoolParams/SOADataSource')
cmo.setInitialCapacity(5)
cmo.setMaxCapacity(50)
cmo.setMinCapacity(5)
cmo.setConnectionCreationRetryFrequencySeconds(10)
cmo.setTestConnectionsOnReserve(True)
cmo.setTestTableName('SQL SELECT 1 FROM DUAL')
cmo.setStatementCacheSize(50)

cd('/JDBCSystemResources/SOADataSource/JDBCResource/SOADataSource/JDBCDriverParams/SOADataSource')
cmo.setUrl('jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS_LIST=(ADDRESS=(PROTOCOL=TCP)(HOST=scan-host)(PORT=1521)))(CONNECT_DATA=(SERVICE_NAME=soasvc)))')
cmo.setDriverName('oracle.jdbc.OracleDriver')
cmo.setPassword('dbpassword')
cd('Properties/SOADataSource')
p = cmo.createProperty('user')
p.setValue('DEV_SOAINFRA')

# Enable FAN
cd('/JDBCSystemResources/SOADataSource/JDBCResource/SOADataSource/JDBCOracleParams/SOADataSource')
cmo.setFanEnabled(True)
cmo.setOnsNodeList('db-node1:6200,db-node2:6200')

# Target to cluster
cd('/JDBCSystemResources/SOADataSource')
set('Targets', jarray.array([ObjectName('com.bea:Name=soa_cluster,Type=Cluster')], ObjectName))

save()
activate()
exit()
EOF
\`\`\`

### 4.3 Validate Datasource

\`\`\`bash
# Test datasource connection from Admin Console or WLST
\${MW_HOME}/oracle_common/common/bin/wlst.sh <<'EOF'
connect('weblogic', 'password', 't3://admin-host:7001')
cd('/ServerRuntimes/soa_server1/JDBCServiceRuntime/soa_server1/JDBCDataSourceRuntimeMBeans/SOADataSource')
print('State:', get('State'))
print('Active connections:', get('ActiveConnectionsCurrentCount'))
print('Wait seconds high:', get('WaitSecondsHighCount'))
print('Failures to reconnect:', get('FailuresToReconnectCount'))
exit()
EOF
\`\`\`

---

## Phase 5 — JDBC Transaction Log (TLOG) Store

Moving the transaction log to the database removes the dependency on shared filesystem for Managed Server migration.

### 5.1 Create TLOG Store via WLST

\`\`\`bash
\${MW_HOME}/oracle_common/common/bin/wlst.sh <<'EOF'
connect('weblogic', 'password', 't3://admin-host:7001')
edit()
startEdit()

for server in ['soa_server1', 'soa_server2']:
    prefix = 'TLOG_' + server + '_'
    cd('/Servers/' + server)
    cmo.setTransactionLogJDBCStore(True)

    cd('/Servers/' + server + '/TransactionLogJDBCStore/' + server)
    cmo.setPrefixName(prefix)
    cmo.setDataSource('LocalSvcTblDataSource')

    print('Configured JDBC TLOG for', server, 'prefix:', prefix)

save()
activate()
exit()
EOF
\`\`\`

\`\`\`sql
-- After restarting servers, verify TLOG tables exist
SELECT table_name FROM dba_tables
WHERE  table_name LIKE 'TLOG_%'
ORDER  BY table_name;
\`\`\`

---

## Phase 6 — Coherence Cluster Configuration

### 6.1 Configure Coherence Cluster in WebLogic Domain

\`\`\`bash
\${MW_HOME}/oracle_common/common/bin/wlst.sh <<'EOF'
connect('weblogic', 'password', 't3://admin-host:7001')
edit()
startEdit()

# Create Coherence cluster resource
cd('/')
cmo.createCoherenceClusterSystemResource('defaultCoherenceCluster')
cd('/CoherenceClusterSystemResources/defaultCoherenceCluster/CoherenceClusterResource/defaultCoherenceCluster/CoherenceClusterParams/defaultCoherenceCluster')
cmo.setClusterListenPort(9000)
cmo.setClusteringMode('unicast')
cmo.setWellKnownAddresses('coherence-node1,coherence-node2')

# Assign Coherence cluster to the WebLogic cluster
cd('/Clusters/soa_cluster/CoherenceTierParams/soa_cluster')
cmo.setCoherenceClusterSystemResource('defaultCoherenceCluster')
cmo.setStorageEnabled(False)   # App servers are Extend clients, not storage nodes

save()
activate()
exit()
EOF
\`\`\`

### 6.2 Configure Coherence Cache Config

\`\`\`bash
DOMAIN_HOME=/u01/app/oracle/user_projects/domains/soa_domain

mkdir -p \${DOMAIN_HOME}/config/coherence

cat > \${DOMAIN_HOME}/config/coherence/coherence-cache-config.xml <<'CACHEXML'
<?xml version="1.0" encoding="UTF-8"?>
<cache-config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns="http://xmlns.oracle.com/coherence/coherence-cache-config"
  xsi:schemaLocation="http://xmlns.oracle.com/coherence/coherence-cache-config
  coherence-cache-config.xsd">

  <caching-scheme-mapping>
    <cache-mapping>
      <cache-name>app-data-*</cache-name>
      <scheme-name>distributed-expiring</scheme-name>
    </cache-mapping>
    <cache-mapping>
      <cache-name>session-storage-*</cache-name>
      <scheme-name>distributed-session</scheme-name>
    </cache-mapping>
  </caching-scheme-mapping>

  <caching-schemes>
    <distributed-scheme>
      <scheme-name>distributed-expiring</scheme-name>
      <service-name>DistributedCache</service-name>
      <backing-map-scheme>
        <local-scheme>
          <expiry-delay>30m</expiry-delay>
          <high-units>100000</high-units>
          <eviction-policy>LRU</eviction-policy>
        </local-scheme>
      </backing-map-scheme>
      <autostart>true</autostart>
    </distributed-scheme>

    <distributed-scheme>
      <scheme-name>distributed-session</scheme-name>
      <service-name>SessionDistributedCache</service-name>
      <backing-map-scheme>
        <local-scheme>
          <high-units>200000</high-units>
        </local-scheme>
      </backing-map-scheme>
      <autostart>true</autostart>
    </distributed-scheme>

    <proxy-scheme>
      <scheme-name>extend-proxy</scheme-name>
      <service-name>ExtendTcpProxyService</service-name>
      <acceptor-config>
        <tcp-acceptor>
          <local-address>
            <address system-property="coherence.extend.address">0.0.0.0</address>
            <port system-property="coherence.extend.port">9099</port>
          </local-address>
        </tcp-acceptor>
      </acceptor-config>
      <autostart>true</autostart>
    </proxy-scheme>
  </caching-schemes>
</cache-config>
CACHEXML
\`\`\`

### 6.3 Configure Coherence Operational Override

\`\`\`bash
cat > \${DOMAIN_HOME}/config/coherence/tangosol-coherence-override.xml <<'OVERRIDE'
<?xml version="1.0" encoding="UTF-8"?>
<coherence xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns="http://xmlns.oracle.com/coherence/coherence-operational-config"
  xsi:schemaLocation="http://xmlns.oracle.com/coherence/coherence-operational-config
  coherence-operational-config.xsd">

  <cluster-config>
    <member-identity>
      <cluster-name system-property="coherence.cluster">FMWCluster</cluster-name>
      <site-name system-property="coherence.site">Site1</site-name>
    </member-identity>

    <unicast-listener>
      <well-known-addresses>
        <socket-address id="1">
          <address>coherence-node1</address>
          <port>9000</port>
        </socket-address>
        <socket-address id="2">
          <address>coherence-node2</address>
          <port>9000</port>
        </socket-address>
      </well-known-addresses>
    </unicast-listener>

    <packet-publisher>
      <packet-size>
        <maximum-length>65535</maximum-length>
      </packet-size>
    </packet-publisher>
  </cluster-config>

  <logging-config>
    <severity-level>5</severity-level>
    <destination>log4j</destination>
  </logging-config>
</coherence>
OVERRIDE
\`\`\`

---

## Phase 7 — Coherence*Web Session Persistence

### 7.1 Enable Coherence*Web for Web Applications

\`\`\`bash
# Locate the Coherence*Web libraries in the WebLogic installation
ls \${MW_HOME}/coherence/lib/coherence-web-spi.jar
ls \${MW_HOME}/coherence/lib/coherence.jar

# Add to WebLogic Managed Server classpath via setUserOverridesLax.sh
cat >> \${DOMAIN_HOME}/bin/setUserOverridesLax.sh <<'OVERRIDES'
export PRE_CLASSPATH="\${MW_HOME}/coherence/lib/coherence.jar:\${MW_HOME}/coherence/lib/coherence-web-spi.jar:\${PRE_CLASSPATH}"
OVERRIDES
\`\`\`

### 7.2 Configure weblogic.xml in Application

\`\`\`xml
<!-- Add to WEB-INF/weblogic.xml of each web application -->
<weblogic-web-app>
  <session-descriptor>
    <persistent-store-type>coherence-web</persistent-store-type>
    <cookie-name>SOASESSION</cookie-name>
    <cookie-path>/</cookie-path>
    <invalidation-interval-secs>60</invalidation-interval-secs>
    <timeout-secs>3600</timeout-secs>
  </session-descriptor>
  <coherence-cluster-ref>
    <coherence-cluster-name>defaultCoherenceCluster</coherence-cluster-name>
  </coherence-cluster-ref>
</weblogic-web-app>
\`\`\`

### 7.3 Validate Session Persistence

\`\`\`bash
# After deploying app with Coherence*Web, create a test session and fail over
# Step 1: create session on soa_server1
curl -c /tmp/test_cookies.txt http://wls-host1:8001/your-app/login

# Step 2: stop soa_server1 via Node Manager
\${MW_HOME}/oracle_common/common/bin/wlst.sh <<'EOF'
connect('weblogic', 'password', 't3://admin-host:7001')
nmConnect('weblogic', 'password', 'wls-host1', '5556', 'soa_domain',
          '/u01/app/oracle/user_projects/domains/soa_domain', 'SSL')
nmKill('soa_server1')
exit()
EOF

# Step 3: verify session still valid on soa_server2
curl -b /tmp/test_cookies.txt http://wls-host2:8002/your-app/profile
# Should return the user's session data without re-login
\`\`\`

---

## Phase 8 — Work Manager Configuration

### 8.1 Create Targeted Work Managers

\`\`\`bash
\${MW_HOME}/oracle_common/common/bin/wlst.sh <<'EOF'
connect('weblogic', 'password', 't3://admin-host:7001')
edit()
startEdit()

# Create max threads constraint
cd('/SelfTuningDeployments/soa_domain/Partitions/DOMAIN/SelfTuning/soa_domain')
cmo.createMaxThreadsConstraint('SoaMaxThreads')
cd('MaxThreadsConstraints/SoaMaxThreads')
cmo.setCount(50)

# Create min threads constraint
cd('/SelfTuningDeployments/soa_domain/Partitions/DOMAIN/SelfTuning/soa_domain')
cmo.createMinThreadsConstraint('SoaMinThreads')
cd('MinThreadsConstraints/SoaMinThreads')
cmo.setCount(5)

# Create Work Manager
cd('/SelfTuningDeployments/soa_domain/Partitions/DOMAIN/SelfTuning/soa_domain')
cmo.createWorkManager('SoaWorkManager')
cd('WorkManagers/SoaWorkManager')
cmo.setMaxThreadsConstraint(getMBean('/SelfTuningDeployments/soa_domain/Partitions/DOMAIN/SelfTuning/soa_domain/MaxThreadsConstraints/SoaMaxThreads'))
cmo.setMinThreadsConstraint(getMBean('/SelfTuningDeployments/soa_domain/Partitions/DOMAIN/SelfTuning/soa_domain/MinThreadsConstraints/SoaMinThreads'))

save()
activate()
exit()
EOF
\`\`\`

---

## Phase 9 — Monitoring Scripts and Crontab

### 9.1 WebLogic Health Check Script

\`\`\`bash
#!/bin/bash
# /opt/oracle/scripts/monitor_wls_tier.sh
# Monitors WebLogic and Coherence application server tier.

MW_HOME=\${MW_HOME:-/u01/app/oracle/product/fmw}
DOMAIN_HOME=\${DOMAIN_HOME:-/u01/app/oracle/user_projects/domains/soa_domain}
ADMIN_HOST=\${ADMIN_HOST:-admin-host}
ADMIN_PORT=\${ADMIN_PORT:-7001}
WLS_USER=\${WLS_USER:-weblogic}
WLS_PASS=\${WLS_PASS:-password}
ALERT_EMAIL=fmw-dba@example.com
LOG_DIR=/var/log/fmw-monitor
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
ALERT=0
REPORT=""

mkdir -p "\${LOG_DIR}"
LOG="\${LOG_DIR}/wls_tier_$(date +%Y%m%d).log"

log()   { echo "[\${TIMESTAMP}] $*" | tee -a "\${LOG}"; }
alert() { ALERT=1; REPORT="\${REPORT}\nALERT: $*"; log "ALERT: $*"; }
pass()  { log "PASS:  $*"; }

# ---
# 1. Run WLST health check inline
# ---
\${MW_HOME}/oracle_common/common/bin/wlst.sh /dev/stdin <<WLST_EOF 2>>"\${LOG}" | tee -a "\${LOG}"
import sys

try:
    connect('\${WLS_USER}', '\${WLS_PASS}', 't3://\${ADMIN_HOST}:\${ADMIN_PORT}')
except:
    print('WLST_CONNECT_FAILED')
    exit()

servers = domainRuntimeService.getServerRuntimes()
for svr in servers:
    name = svr.getName()
    state = svr.getState()
    if state != 'RUNNING':
        print('SERVER_DOWN|' + name + '|' + state)
    else:
        tp = svr.getThreadPoolRuntime()
        stuck = tp.getStuckThreadCount()
        pending = tp.getPendingUserRequestCount()
        jvm = svr.getJVMRuntime()
        heap_pct = int(jvm.getHeapSizeCurrent() * 100 / jvm.getHeapSizeMax()) if jvm.getHeapSizeMax() > 0 else 0
        print('SERVER_OK|' + name + '|stuck=' + str(stuck) + '|pending=' + str(pending) + '|heap_pct=' + str(heap_pct))

exit()
WLST_EOF

# Parse WLST output
while IFS='|' read -r status name details; do
  case "\${status}" in
    WLST_CONNECT_FAILED)
      alert "Cannot connect to Admin Server at \${ADMIN_HOST}:\${ADMIN_PORT}"
      ;;
    SERVER_DOWN)
      alert "Managed Server \${name} is in state: \${details}"
      ;;
    SERVER_OK)
      log "INFO:  Server \${name} OK — \${details}"
      stuck=$(echo "\${details}" | grep -o 'stuck=[0-9]*' | cut -d= -f2)
      pending=$(echo "\${details}" | grep -o 'pending=[0-9]*' | cut -d= -f2)
      heap=$(echo "\${details}" | grep -o 'heap_pct=[0-9]*' | cut -d= -f2)
      [ "\${stuck:-0}" -gt 0 ] && alert "Server \${name}: \${stuck} STUCK THREADS"
      [ "\${pending:-0}" -gt 500 ] && alert "Server \${name}: \${pending} pending requests — possible thread starvation"
      [ "\${heap:-0}" -gt 90 ] && alert "Server \${name}: heap at \${heap}% — GC pressure risk"
      ;;
  esac
done < <(grep -E 'SERVER_OK|SERVER_DOWN|WLST_CONNECT' "\${LOG}" | tail -20)

# ---
# 2. Node Manager process check
# ---
pgrep -f "NodeManager" > /dev/null \
  && pass "Node Manager running on $(hostname)" \
  || alert "Node Manager process not found on $(hostname)"

# ---
# 3. Admin Server process check
# ---
ADMIN_PID=$(pgrep -f "weblogic.Name=AdminServer" 2>/dev/null)
[ -n "\${ADMIN_PID}" ] \
  && pass "Admin Server running PID=\${ADMIN_PID}" \
  || alert "Admin Server process not found — domain management unavailable"

# ---
# 4. Datasource connection pool check via REST API
# ---
for DS in SOADataSource LocalSvcTblDataSource; do
  RESULT=$(curl -s -u "\${WLS_USER}:\${WLS_PASS}" \
    "http://\${ADMIN_HOST}:\${ADMIN_PORT}/management/wls/latest/datasources/id/\${DS}" \
    2>/dev/null | grep -o '"state":"[^"]*"' | head -1)
  if echo "\${RESULT}" | grep -q '"Running"'; then
    pass "Datasource \${DS}: Running"
  else
    alert "Datasource \${DS}: \${RESULT:-no response}"
  fi
done

# ---
# 5. Transaction log check
# ---
TLOG_ERRORS=$(grep -r "TransactionLog\|TLOG\|JTA" "\${DOMAIN_HOME}/servers/*/logs/*.log" \
  2>/dev/null | grep -i "error\|exception" | wc -l)
[ "\${TLOG_ERRORS}" -gt 0 ] \
  && alert "Transaction log errors found: \${TLOG_ERRORS} error lines in server logs" \
  || pass "No transaction log errors in server logs"

# ---
# 6. Alert summary
# ---
if [ "\${ALERT}" -eq 1 ]; then
  printf "FMW Application Tier Alert\nHost: $(hostname)\nTime: \${TIMESTAMP}\n%b\n\nLog: \${LOG}\n" \
    "\${REPORT}" | mail -s "FMW Tier Alert: $(hostname)" "\${ALERT_EMAIL}"
fi
\`\`\`

### 9.2 Coherence Cluster Health Script

\`\`\`bash
#!/bin/bash
# /opt/oracle/scripts/monitor_coherence.sh
# Checks Coherence cluster membership and cache health via JMX/WLST.

MW_HOME=\${MW_HOME:-/u01/app/oracle/product/fmw}
ADMIN_HOST=\${ADMIN_HOST:-admin-host}
ADMIN_PORT=\${ADMIN_PORT:-7001}
WLS_USER=\${WLS_USER:-weblogic}
WLS_PASS=\${WLS_PASS:-password}
ALERT_EMAIL=fmw-dba@example.com
LOG_DIR=/var/log/fmw-monitor
EXPECTED_MEMBERS=2
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
ALERT=0
REPORT=""

mkdir -p "\${LOG_DIR}"
LOG="\${LOG_DIR}/coherence_$(date +%Y%m%d).log"

log()   { echo "[\${TIMESTAMP}] $*" | tee -a "\${LOG}"; }
alert() { ALERT=1; REPORT="\${REPORT}\nALERT: $*"; log "ALERT: $*"; }
pass()  { log "PASS:  $*"; }

\${MW_HOME}/oracle_common/common/bin/wlst.sh /dev/stdin <<WLST_EOF 2>>"\${LOG}" | tee -a "\${LOG}"
try:
    connect('\${WLS_USER}', '\${WLS_PASS}', 't3://\${ADMIN_HOST}:\${ADMIN_PORT}')
except:
    print('COH_CONNECT_FAILED')
    exit()

try:
    cd('/CoherenceClusterSystemResources/defaultCoherenceCluster/CoherenceClusterRuntime/defaultCoherenceCluster')
    members = get('MemberCount')
    print('COH_MEMBERS|' + str(members))
    cd('CoherenceCacheRuntimes')
    caches = ls(returnMap='true')
    if caches:
        for c in list(caches.keys())[:10]:
            cd(c)
            sz = get('Size')
            print('COH_CACHE|' + str(c) + '|size=' + str(sz))
            cd('..')
    else:
        print('COH_NO_CACHES')
except Exception as e:
    print('COH_ERROR|' + str(e))

exit()
WLST_EOF

# Parse Coherence output
while IFS='|' read -r status detail1 detail2; do
  case "\${status}" in
    COH_CONNECT_FAILED)
      alert "Cannot connect to WebLogic Admin Server to check Coherence"
      ;;
    COH_MEMBERS)
      log "INFO:  Coherence cluster members: \${detail1}"
      [ "\${detail1:-0}" -lt "\${EXPECTED_MEMBERS}" ] \
        && alert "Coherence cluster has \${detail1} members (expected >= \${EXPECTED_MEMBERS})"
      ;;
    COH_CACHE)
      log "INFO:  Cache \${detail1}: \${detail2}"
      ;;
    COH_NO_CACHES)
      alert "No Coherence caches found — Coherence may not have started"
      ;;
    COH_ERROR)
      alert "Coherence JMX error: \${detail1}"
      ;;
  esac
done < <(grep -E 'COH_' "\${LOG}" | tail -30)

if [ "\${ALERT}" -eq 1 ]; then
  printf "FMW Coherence Alert\nHost: $(hostname)\nTime: \${TIMESTAMP}\n%b\n\nLog: \${LOG}\n" \
    "\${REPORT}" | mail -s "Coherence Alert: $(hostname)" "\${ALERT_EMAIL}"
fi
\`\`\`

### 9.3 Performance Snapshot Script

\`\`\`bash
#!/bin/bash
# /opt/oracle/scripts/fmw_perf_snapshot.sh
# Writes a 15-minute performance record of WLS JVM and OS metrics.

MW_HOME=\${MW_HOME:-/u01/app/oracle/product/fmw}
LOG_DIR=/var/log/fmw-monitor/snapshots
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
mkdir -p "\${LOG_DIR}"
SNAP="\${LOG_DIR}/fmw_perf_$(date +%Y%m%d).log"

# OS metrics
CPU_IDLE=$(awk '/^cpu /{tot=$2+$3+$4+$5+$6+$7+$8+$9; idle=$5; printf "%d", idle*100/tot}' /proc/stat)
CPU_UTIL=$((100 - CPU_IDLE))
MEM_AVAIL=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
MEM_TOTAL=$(awk '/MemTotal/{print $2}' /proc/meminfo)
LOAD=$(awk '{print $1}' /proc/loadavg)

# WLS JVM metrics (per Managed Server process)
WLS_JVM_LINE=""
for svr_proc in $(pgrep -f 'weblogic.Name=soa_server'); do
  svr_name=$(cat /proc/\${svr_proc}/cmdline 2>/dev/null | tr '\\0' ' ' | grep -o 'weblogic.Name=[^ ]*' | cut -d= -f2)
  vm_rss=$(awk '/VmRSS/{print $2}' /proc/\${svr_proc}/status 2>/dev/null || echo 0)
  vm_swap=$(awk '/VmSwap/{print $2}' /proc/\${svr_proc}/status 2>/dev/null || echo 0)
  WLS_JVM_LINE="\${WLS_JVM_LINE}|\${svr_name}:rss=$((vm_rss/1024))MB:swap=$((vm_swap/1024))MB"
done

echo "\${TIMESTAMP}|cpu_util=\${CPU_UTIL}%|mem_avail_mb=$((MEM_AVAIL/1024))|mem_total_mb=$((MEM_TOTAL/1024))|load=\${LOAD}\${WLS_JVM_LINE}" \
  >> "\${SNAP}"
\`\`\`

### 9.4 Crontab Schedule

\`\`\`
# FMW Application Tier Monitoring — install as oracle user
# crontab -e (as oracle user)

MW_HOME=/u01/app/oracle/product/fmw
DOMAIN_HOME=/u01/app/oracle/user_projects/domains/soa_domain
ADMIN_HOST=admin-host
ADMIN_PORT=7001
WLS_USER=weblogic
WLS_PASS=password
ALERT_EMAIL=fmw-dba@example.com
MAILTO=""

# WebLogic tier health — every 5 minutes during business hours
*/5  7-20 * * 1-5  /opt/oracle/scripts/monitor_wls_tier.sh    >> /var/log/fmw-monitor/cron.log 2>&1
*/10 0-6  * * *    /opt/oracle/scripts/monitor_wls_tier.sh    >> /var/log/fmw-monitor/cron.log 2>&1
*/10 21-23 * * *   /opt/oracle/scripts/monitor_wls_tier.sh    >> /var/log/fmw-monitor/cron.log 2>&1

# Coherence cluster check — every 5 minutes
*/5 * * * *  /opt/oracle/scripts/monitor_coherence.sh         >> /var/log/fmw-monitor/cron.log 2>&1

# FMW performance snapshot — every 15 minutes
*/15 * * * *  /opt/oracle/scripts/fmw_perf_snapshot.sh        >> /var/log/fmw-monitor/cron.log 2>&1

# Log rotation — daily at 1 AM
0 1 * * *  find /var/log/fmw-monitor -name "*.log" -mtime +30 -delete
0 1 * * *  find /var/log/fmw-monitor -name "*.log" -mtime +7 ! -name "*.gz" -exec gzip {} \\;

# Node Manager watchdog — every 2 minutes (restarts NM if dead)
*/2 * * * *  systemctl is-active --quiet wls-nodemanager || systemctl start wls-nodemanager
\`\`\`

---

## Phase 10 — Troubleshooting Quick Reference

| Symptom | Diagnosis | Resolution |
|---------|-----------|-----------|
| Managed Server won't start | Check NM log: \`\${DOMAIN_HOME}/nodemanager/nodemanager.log\` | Verify NM enrolled, ports free, JAVA_HOME set |
| Stuck threads increasing | \`wlst: get('StuckThreadCount')\` | Increase Work Manager max threads; check DB response time |
| Datasource connection failures | Check \`FailuresToReconnectCount\` in WLST | Verify Oracle DB / RAC service is running; check ONS |
| Heap OOM in Managed Server | \`grep OutOfMemoryError \${DOMAIN_HOME}/servers/*/logs/*.log\` | Increase \`-Xmx\`; check for session accumulation |
| Coherence split brain | \`COH_MEMBERS\` alert shows fewer than expected | Check network between Coherence nodes; verify well-known addresses |
| Session data lost on failover | Users re-prompted to login after server bounce | Verify Coherence*Web configured; check \`session-storage-*\` cache size > 0 |
| XA transaction timeout | \`JTA: transaction timeout\` in server log | Increase JTA timeout; check long-running DB queries |
| TLOG not found on migration | Server fails to start on new host | Confirm JDBC TLOG datasource is accessible from all hosts |
| Admin Console unreachable | \`curl -v http://admin-host:7001/console\` times out | Check Admin Server process; check firewall on port 7001 |
| OHS not routing to WLS | 503 from load balancer | Check \`mod_wl_ohs\` config; verify Managed Server listen address matches OHS target |`,
};

async function main() {
  await db
    .insert(posts)
    .values(post)
    .onConflictDoUpdate({
      target: posts.slug,
      set: { title: post.title, content: post.content, excerpt: post.excerpt, updatedAt: new Date() },
    });
  console.log('Inserted:', post.slug);
}

main().catch(console.error);
