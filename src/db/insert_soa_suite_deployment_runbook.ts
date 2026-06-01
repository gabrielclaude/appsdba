import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Deploying Oracle SOA Suite 12c',
  slug: 'soa-suite-deployment-runbook',
  excerpt:
    'Step-by-step runbook for installing and configuring Oracle SOA Suite 12c — OS prerequisites, JDK, WebLogic, Infrastructure installer, RCU schema creation, domain configuration, Node Manager, and post-install verification.',
  category: 'soa-suite' as const,
  published: true,
  publishedAt: new Date('2026-05-31'),
  youtubeUrl: null,
  content: `This runbook covers a single-node Oracle SOA Suite 12c (12.2.1.4) installation on Oracle Linux. It produces a working SOA domain with one AdminServer and one SOA managed server (\`soa_server1\`), backed by an Oracle database running the RCU schemas. Adapt node counts and cluster configuration for production HA deployments.

---

## Environment Reference

| Item | Value |
|---|---|
| OS | Oracle Linux 8.x (x86_64) |
| Oracle DB | 19c (separate host or CDB/PDB) |
| SOA Suite version | 12.2.1.4.0 |
| JDK | Oracle JDK 8u361+ (JDK 8 required for 12.2.1.4) |
| Oracle Home | \`/u01/app/oracle/product/fmw/soa\` |
| Domain Home | \`/u01/app/oracle/config/domains/soa_domain\` |
| Application Home | \`/u01/app/oracle/config/applications/soa_domain\` |
| OS user | \`oracle\` |
| DB service | \`soadb.example.com:1521/SOADB\` |
| RCU prefix | \`SOA\` |

All commands run as the \`oracle\` OS user unless noted.

---

## Phase 1: OS Prerequisites

### 1.1 Kernel and package requirements

Run as \`root\`:

\`\`\`bash
# Install required packages
dnf install -y libaio libaio-devel gcc gcc-c++ make glibc glibc-devel \\
  libgcc libstdc++ libstdc++-devel sysstat binutils compat-openssl11 \\
  ksh unzip zip

# Verify swap (minimum 8 GB for SOA + WebLogic)
free -h

# Verify /tmp free space (minimum 1 GB)
df -h /tmp
\`\`\`

### 1.2 Create OS user and directory structure

\`\`\`bash
# As root
groupadd oinstall
groupadd dba
useradd -g oinstall -G dba -m -s /bin/bash oracle

mkdir -p /u01/app/oracle/product/fmw/soa
mkdir -p /u01/app/oracle/config/domains
mkdir -p /u01/app/oracle/config/applications
mkdir -p /u01/app/oraInventory
chown -R oracle:oinstall /u01/app/oracle
chown oracle:oinstall /u01/app/oraInventory
\`\`\`

### 1.3 Set oracle user environment

Add to \`/home/oracle/.bash_profile\`:

\`\`\`bash
export ORACLE_BASE=/u01/app/oracle
export MW_HOME=/u01/app/oracle/product/fmw/soa
export DOMAIN_HOME=/u01/app/oracle/config/domains/soa_domain
export JAVA_HOME=/u01/app/oracle/product/jdk8
export PATH=\${JAVA_HOME}/bin:\${PATH}
export ORACLE_HOSTNAME=$(hostname -f)
\`\`\`

\`\`\`bash
source ~/.bash_profile
\`\`\`

---

## Phase 2: Install Oracle JDK 8

Download \`jdk-8u361-linux-x64.tar.gz\` from Oracle support (requires MOS login — patch 35638318 or current JDK 8 release).

\`\`\`bash
mkdir -p /u01/app/oracle/product/jdk8
tar -xzf jdk-8u361-linux-x64.tar.gz -C /u01/app/oracle/product/jdk8 --strip-components=1

# Verify
java -version
# Expected: java version "1.8.0_361"
\`\`\`

---

## Phase 3: Install Oracle Fusion Middleware Infrastructure

SOA Suite 12.2.1.4 requires the Fusion Middleware Infrastructure (WebLogic Server + JRF) to be installed first.

**Installer files required:**
- \`fmw_12.2.1.4.0_infrastructure.jar\` (Fusion Middleware Infrastructure)
- \`fmw_12.2.1.4.0_soa.jar\` (SOA Suite)

### 3.1 Run Infrastructure installer

\`\`\`bash
java -jar fmw_12.2.1.4.0_infrastructure.jar
\`\`\`

In the installer wizard:

1. **Installation Inventory Setup** — set Inventory Directory to \`/u01/app/oraInventory\`, OS group \`oinstall\`
2. **Welcome** — Next
3. **Auto Updates** — Skip Auto Updates (or configure if you have Oracle Support credentials)
4. **Installation Location** — Oracle Home: \`/u01/app/oracle/product/fmw/soa\`
5. **Installation Type** — **Fusion Middleware Infrastructure** (not "Infrastructure With Examples")
6. **Prerequisite Checks** — resolve any failures before continuing
7. **Installation Summary** — review, then **Install**
8. **Installation Progress** — wait for completion (~10 min)
9. **Installation Complete** — Finish

Verify:

\`\`\`bash
ls /u01/app/oracle/product/fmw/soa/wlserver/
# Should show: common  modules  server  etc.
\`\`\`

---

## Phase 4: Install Oracle SOA Suite

\`\`\`bash
java -jar fmw_12.2.1.4.0_soa.jar
\`\`\`

1. **Installation Location** — same Oracle Home as Infrastructure: \`/u01/app/oracle/product/fmw/soa\`
2. **Installation Type** — **SOA Suite and Business Activity Monitoring** (includes BPEL, Mediator, Human Workflow, BAM). Select **SOA Suite** only if BAM is not needed.
3. **Prerequisite Checks** — resolve failures
4. **Installation Summary** — verify Oracle Home, then **Install**
5. **Installation Complete** — Finish

Verify SOA Suite files were layered on top of Infrastructure:

\`\`\`bash
ls /u01/app/oracle/product/fmw/soa/soa/
# Should show: bin  common  connectors  dbscripts  modules  plugins  soa-infra-mgmt
\`\`\`

---

## Phase 5: Run Repository Creation Utility (RCU)

RCU creates the database schemas required by SOA Suite. Run from the Oracle Home.

### 5.1 Prerequisites on the database

Connect to the target Oracle DB as \`SYSDBA\` and verify:

\`\`\`sql
-- Minimum DB version for SOA 12.2.1.4: 12.2.0.1 or 19c
SELECT version FROM v$instance;

-- Check character set (AL32UTF8 required)
SELECT value FROM nls_database_parameters WHERE parameter = 'NLS_CHARACTERSET';

-- Verify sufficient tablespace (SOAINFRA alone needs 2+ GB initial)
SELECT tablespace_name, ROUND(bytes/1073741824,2) AS size_gb
FROM dba_data_files ORDER BY tablespace_name;
\`\`\`

Create a dedicated tablespace for SOA schemas if not using an existing one:

\`\`\`sql
CREATE TABLESPACE SOA_DATA
  DATAFILE '/u01/oradata/SOADB/soa_data01.dbf' SIZE 2G AUTOEXTEND ON NEXT 512M MAXSIZE 20G
  EXTENT MANAGEMENT LOCAL SEGMENT SPACE MANAGEMENT AUTO;
\`\`\`

### 5.2 Run RCU

\`\`\`bash
/u01/app/oracle/product/fmw/soa/oracle_common/bin/rcu
\`\`\`

RCU wizard steps:

1. **Create Repository** — select **System Load and Product Load**
2. **Database Connection Details**:
   - Database Type: Oracle Database
   - Host: \`soadb.example.com\`
   - Port: \`1521\`
   - Service Name: \`SOADB\`
   - Username: \`SYS\`, Role: SYSDBA
3. **Select Components** — enter prefix \`SOA\`, then check:
   - **AS Common Schemas**: Common Infrastructure Services (STB), Oracle Platform Security Services (OPSS), Audit Services (IAU), Audit Services Append (IAU_APPEND), Audit Services Viewer (IAU_VIEWER)
   - **SOA Suite**: SOA and BPM Infrastructure (SOAINFRA)
   - **User Messaging Service**: UMS
   - **WebLogic Services**: WebLogic Services (WLS)
   - **Metadata Services**: Metadata Services (MDS)
4. **Schema Passwords** — set passwords for each schema (or use same password for all)
5. **Map Tablespaces** — assign \`SOA_DATA\` as default tablespace for SOAINFRA and MDS. Accept defaults for others.
6. **Summary** — review schemas to be created
7. **Completion Summary** — all schemas created. Note the connect strings displayed for each schema.

Verify schemas were created:

\`\`\`sql
SELECT username, account_status, default_tablespace
FROM dba_users
WHERE username LIKE 'SOA%'
ORDER BY username;
\`\`\`

---

## Phase 6: Create the WebLogic Domain

### 6.1 Launch Configuration Wizard

\`\`\`bash
/u01/app/oracle/product/fmw/soa/oracle_common/common/bin/config.sh
\`\`\`

### 6.2 Wizard walkthrough

**Step 1 — Configuration Type**: Create a new domain

**Step 2 — Templates**: Select these templates (in addition to the default WebLogic Server Domain):
- Oracle SOA Suite — \`soa-mbeans-appserver-template_12.2.1.4.jar\`
- Oracle SOA Suite for healthcare integration (if B2B is needed)
- Oracle Enterprise Manager — for EM FMW Control
- Oracle JRF — required for JRF-based domain
- WebLogic Coherence Cluster Extension

**Step 3 — Application Location**: \`/u01/app/oracle/config/applications/soa_domain\`

**Step 4 — Administrator Account**: Set WebLogic admin username (e.g., \`weblogic\`) and password (12+ chars, 1 numeric, 1 special)

**Step 5 — Domain Mode and JDK**:
- Mode: **Production**
- JDK: \`/u01/app/oracle/product/jdk8\`

**Step 6 — Database Configuration Type**: RCU Data

**Step 7 — RCU Data**:
- Vendor: Oracle
- DBMS/Service: \`soadb.example.com:1521/SOADB\`
- Schema Owner: \`SOA_STB\` (Service Table schema)
- Password: (STB schema password set in RCU)
- Click **Get RCU Configuration** — wizard auto-populates all other schema connections

Verify all connections show green checkmarks, then Next.

**Step 8 — JDBC Component Schema Test**: Run tests, verify all pass.

**Step 9 — Advanced Configuration**: Select:
- Administration Server
- Node Manager
- Topology (Managed Servers, Clusters, Coherence)

**Step 10 — Administration Server**:
- Server Name: \`AdminServer\`
- Listen Address: \`(All Local Addresses)\` or specific hostname
- Listen Port: \`7001\`
- Enable SSL: optional (configure port 7002 if enabling)

**Step 11 — Managed Servers**: The wizard auto-creates \`soa_server1\`:
- Name: \`soa_server1\`
- Listen Address: \`(All Local Addresses)\`
- Listen Port: \`8001\`
- Server Groups: \`SOA-MGD-SVRS-ONLY\` (assigns SOA targeting)

**Step 12 — Clusters**: Skip (single-node) or create cluster for HA.

**Step 13 — Coherence**: Accept defaults (Coherence cluster port 7574).

**Step 14 — Machines**: Create a machine entry:
- Machine Name: \`soa_machine1\`
- Node Manager Listen Address: \`localhost\`
- Node Manager Listen Port: \`5556\`

Assign \`AdminServer\` and \`soa_server1\` to \`soa_machine1\`.

**Step 15 — Node Manager**:
- Node Manager Type: Per Domain Custom Location
- Node Manager Home: \`/u01/app/oracle/config/domains/soa_domain/nodemanager\`
- Credentials: set NM username (e.g., \`nmadmin\`) and password

**Step 16 — Configuration Summary**: Review, then **Create**.

**Step 17 — Configuration Progress**: Domain creation takes 5–10 minutes.

**Step 18 — End of Configuration**: Note the domain directory and AdminServer URL.

---

## Phase 7: Start the Domain

### 7.1 Start AdminServer

\`\`\`bash
cd /u01/app/oracle/config/domains/soa_domain/bin
./startWebLogic.sh > /u01/app/oracle/config/domains/soa_domain/servers/AdminServer/logs/AdminServer.out 2>&1 &

# Tail the log until "Server started in RUNNING mode"
tail -f /u01/app/oracle/config/domains/soa_domain/servers/AdminServer/logs/AdminServer.out
\`\`\`

Expected startup sequence:
\`\`\`
<Server state changed to STARTING.>
<Server state changed to STANDBY.>
<Server state changed to STARTING.>
<Server state changed to ADMIN.>
<Server state changed to RESUMING.>
<Server state changed to RUNNING.>
\`\`\`

Verify AdminServer is accessible:

\`\`\`bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:7001/console
# Expected: 200 or 302
\`\`\`

### 7.2 Start Node Manager

\`\`\`bash
cd /u01/app/oracle/config/domains/soa_domain/bin
./startNodeManager.sh > /u01/app/oracle/config/domains/soa_domain/nodemanager/nodemanager.out 2>&1 &

# Wait for "Listener started on port 5556"
tail -f /u01/app/oracle/config/domains/soa_domain/nodemanager/nodemanager.out
\`\`\`

### 7.3 Start soa_server1 via WLST

\`\`\`bash
/u01/app/oracle/product/fmw/soa/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<admin_password>','t3://localhost:7001')
nm()
nmStart('soa_server1')
exit()
EOF
\`\`\`

Or start through the AdminServer console: **Domain Structure > Environment > Servers > soa_server1 > Start**.

Monitor startup (SOA Suite is slower than plain WLS — allow 10–20 minutes on first start):

\`\`\`bash
tail -f /u01/app/oracle/config/domains/soa_domain/servers/soa_server1/logs/soa_server1.log
\`\`\`

Look for:
\`\`\`
SOA Platform is running and accepting requests
\`\`\`

---

## Phase 8: Post-Install Verification

### 8.1 WebLogic Admin Console

\`http://<host>:7001/console\` — log in with the weblogic admin account.

Verify:
- AdminServer: RUNNING
- soa_server1: RUNNING
- No failed deployments under **Deployments**

### 8.2 EM Fusion Middleware Control

\`http://<host>:7001/em\` — log in with the same weblogic admin account.

Navigate to **SOA > soa-infra (soa_server1)**. Confirm:
- SOA Infrastructure state: **Running**
- No faulted system composites

### 8.3 SOA Infrastructure health check

\`\`\`bash
# Confirm SOA Infrastructure servlet responds
curl -u weblogic:<password> -s -o /dev/null -w "%{http_code}" \\
  http://localhost:8001/soa-infra/
# Expected: 200

# Confirm default composites are deployed
curl -u weblogic:<password> \\
  "http://localhost:8001/soa-infra/management/SOACompositeLifecycleService?wsdl" \\
  | grep -c "definitions"
# Expected: 1 (confirms WSDL returned)
\`\`\`

### 8.4 Verify SOAINFRA schema connectivity

From \`soa_server1\` log check for successful SOAINFRA datasource connection:

\`\`\`bash
grep -i "soainfra" /u01/app/oracle/config/domains/soa_domain/servers/soa_server1/logs/soa_server1.log | grep -i "success\\|connect\\|error"
\`\`\`

Or query via WLST:

\`\`\`bash
/u01/app/oracle/product/fmw/soa/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<admin_password>','t3://localhost:7001')
cd('JDBCSystemResources/SOADataSource/JDBCResource/SOADataSource/JDBCConnectionPoolParams/SOADataSource')
print(get('TestConnectionsOnReserve'))
exit()
EOF
\`\`\`

### 8.5 Deploy a test composite

Deploy the HelloWorld sample composite from the SOA Suite samples:

\`\`\`bash
ls /u01/app/oracle/product/fmw/soa/soa/integration/
# Locate HelloWorld or BPELHelloWorld sample SAR
\`\`\`

Or use the EM FMW Control **Deploy** button under **SOA > soa-infra** to deploy any SAR and confirm ACTIVE status.

---

## Phase 9: systemd Service Units

Create service units so the SOA domain starts automatically after server reboots.

### 9.1 Node Manager service

Create \`/etc/systemd/system/wls-nodemanager.service\` as \`root\`:

\`\`\`ini
[Unit]
Description=Oracle WebLogic Node Manager
After=network.target

[Service]
Type=simple
User=oracle
Environment="JAVA_HOME=/u01/app/oracle/product/jdk8"
ExecStart=/u01/app/oracle/config/domains/soa_domain/bin/startNodeManager.sh
ExecStop=/u01/app/oracle/config/domains/soa_domain/bin/stopNodeManager.sh
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
\`\`\`

### 9.2 AdminServer service

Create \`/etc/systemd/system/wls-admin.service\`:

\`\`\`ini
[Unit]
Description=Oracle WebLogic AdminServer
After=wls-nodemanager.service
Requires=wls-nodemanager.service

[Service]
Type=simple
User=oracle
Environment="JAVA_HOME=/u01/app/oracle/product/jdk8"
WorkingDirectory=/u01/app/oracle/config/domains/soa_domain
ExecStart=/u01/app/oracle/config/domains/soa_domain/bin/startWebLogic.sh
ExecStop=/u01/app/oracle/config/domains/soa_domain/bin/stopWebLogic.sh
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
\`\`\`

### 9.3 SOA managed server WLST start script

Create \`/u01/app/oracle/config/domains/soa_domain/bin/start_soa_server1.sh\`:

\`\`\`bash
#!/bin/bash
source /home/oracle/.bash_profile
/u01/app/oracle/product/fmw/soa/oracle_common/common/bin/wlst.sh << EOF
connect('weblogic','\${WLS_ADMIN_PASS}','t3://localhost:7001')
nm()
nmStart('soa_server1')
exit()
EOF
\`\`\`

Create \`/etc/systemd/system/wls-soa-server1.service\`:

\`\`\`ini
[Unit]
Description=Oracle SOA Managed Server soa_server1
After=wls-admin.service
Requires=wls-admin.service

[Service]
Type=oneshot
User=oracle
EnvironmentFile=/etc/sysconfig/wls-soa
ExecStart=/u01/app/oracle/config/domains/soa_domain/bin/start_soa_server1.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
\`\`\`

Create \`/etc/sysconfig/wls-soa\`:

\`\`\`bash
WLS_ADMIN_PASS=<admin_password>
\`\`\`

Enable and start all services:

\`\`\`bash
systemctl daemon-reload
systemctl enable wls-nodemanager wls-admin wls-soa-server1
systemctl start wls-nodemanager
systemctl start wls-admin
# Wait for AdminServer to reach RUNNING state, then:
systemctl start wls-soa-server1
\`\`\`

---

## Phase 10: JVM Tuning

SOA Suite's BPEL dehydration and Human Workflow are memory-intensive. Set JVM arguments in \`/u01/app/oracle/config/domains/soa_domain/servers/soa_server1/security/boot.properties\` (create this file for passwordless startup) and in the server startup args.

Edit \`/u01/app/oracle/config/domains/soa_domain/bin/setUserOverrides.sh\` (create if absent):

\`\`\`bash
#!/bin/bash
# SOA managed server JVM tuning
if [ "\${SERVER_NAME}" = "soa_server1" ]; then
  JAVA_OPTIONS="\${JAVA_OPTIONS} -Xms4g -Xmx8g"
  JAVA_OPTIONS="\${JAVA_OPTIONS} -XX:+UseG1GC"
  JAVA_OPTIONS="\${JAVA_OPTIONS} -XX:MaxGCPauseMillis=500"
  JAVA_OPTIONS="\${JAVA_OPTIONS} -XX:+HeapDumpOnOutOfMemoryError"
  JAVA_OPTIONS="\${JAVA_OPTIONS} -XX:HeapDumpPath=/u01/app/oracle/config/domains/soa_domain/servers/soa_server1/logs/"
  export JAVA_OPTIONS
fi
\`\`\`

Minimum heap for SOA Suite soa_server1: **4 GB**. Recommended for production: **8–12 GB**.

---

## Troubleshooting

### AdminServer fails to start — port 7001 in use

\`\`\`bash
lsof -i :7001
# Identify the conflicting process and stop it before retrying
\`\`\`

### soa_server1 fails with "SOAINFRA datasource unavailable"

Check DB connectivity from the SOA host:

\`\`\`bash
/u01/app/oracle/product/fmw/soa/oracle_common/bin/sqlplus SOA_SOAINFRA/<password>@soadb.example.com:1521/SOADB
\`\`\`

If the login fails, check network ACLs, Oracle listener status, and that the \`SOA_SOAINFRA\` account is unlocked in the database.

### SOA Infrastructure shows "Resuming" indefinitely

This usually means a background thread is waiting on a DB lock or the SOAINFRA schema has a large backlog of unprocessed messages on startup. Check:

\`\`\`sql
-- Long-running locks in SOAINFRA schema
SELECT s.username, s.sid, s.serial#, s.status, s.wait_class, s.event,
       ROUND(s.seconds_in_wait/60,1) AS wait_min
FROM v$session s
WHERE s.username LIKE 'SOA%'
  AND s.seconds_in_wait > 30
ORDER BY s.seconds_in_wait DESC;
\`\`\`

### WSDL endpoint returns 404

Confirm \`soa_server1\` is in RUNNING (not ADMIN) state. In ADMIN mode, only the admin console is available; SOA endpoints are not accessible until the server resumes.

\`\`\`bash
grep "state changed to RUNNING" /u01/app/oracle/config/domains/soa_domain/servers/soa_server1/logs/soa_server1.log | tail -1
\`\`\`

### EM FMW Control shows composites but SOA Infrastructure is "Down"

Restart SOA Infrastructure without restarting the managed server:

\`\`\`bash
/u01/app/oracle/product/fmw/soa/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<password>','t3://localhost:7001')
cd('/AppDeployments/soa-infra/Targets/soa_server1')
cmo.start()
exit()
EOF
\`\`\`

---

## Rollback: Uninstall SOA Suite

If the installation fails and you need to start over:

\`\`\`bash
# 1. Stop all servers
systemctl stop wls-soa-server1 wls-admin wls-nodemanager

# 2. Drop RCU schemas (run as SYSDBA in the target DB)
# Re-run RCU in "Drop" mode, or manually:
# DROP USER SOA_SOAINFRA CASCADE;
# DROP USER SOA_MDS CASCADE;
# DROP USER SOA_STB CASCADE;
# DROP USER SOA_OPSS CASCADE;
# DROP USER SOA_IAU CASCADE;
# DROP USER SOA_IAU_APPEND CASCADE;
# DROP USER SOA_IAU_VIEWER CASCADE;
# DROP USER SOA_WLS CASCADE;
# DROP USER SOA_UMS CASCADE;

# 3. Remove Oracle Home
rm -rf /u01/app/oracle/product/fmw/soa

# 4. Remove domain
rm -rf /u01/app/oracle/config/domains/soa_domain
rm -rf /u01/app/oracle/config/applications/soa_domain

# 5. Clean inventory
rm -rf /u01/app/oraInventory
\`\`\`

---

## Post-Install Checklist

- [ ] AdminServer starts and reaches RUNNING state
- [ ] Node Manager starts and connects to AdminServer
- [ ] soa_server1 starts and logs "SOA Platform is running and accepting requests"
- [ ] EM FMW Control accessible at \`:7001/em\`
- [ ] SOA Infrastructure shows Running in EM
- [ ] SOAINFRA datasource test passes in Admin Console
- [ ] All RCU schemas are OPEN (not EXPIRED/LOCKED) in the database
- [ ] systemd services enabled for automatic restart
- [ ] JVM heap set to minimum 4 GB for soa_server1
- [ ] \`boot.properties\` created for passwordless managed server startup
- [ ] Test composite deployed and activated successfully`,
};

async function main() {
  console.log('Inserting SOA Suite deployment runbook...');
  await db.insert(posts).values(post).onConflictDoNothing();
  console.log(`Inserted: "${post.title}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
