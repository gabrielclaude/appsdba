import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Deploying Oracle Service Bus 12c',
  slug: 'oracle-service-bus-deployment-runbook',
  excerpt:
    'Step-by-step runbook for a standalone Oracle Service Bus 12c (12.2.1.4) installation — OS prerequisites, JDK, FMW Infrastructure, OSB installer, RCU schema creation, domain configuration, Node Manager, and deploying a first proxy service.',
  category: 'soa-suite' as const,
  published: true,
  publishedAt: new Date('2026-05-31'),
  youtubeUrl: null,
  content: `This runbook installs Oracle Service Bus (OSB) 12c (12.2.1.4) as a standalone deployment — separate from SOA Suite. A standalone OSB installation is appropriate when you need only the service virtualization and mediation layer without the BPEL orchestration engine or Human Workflow. If you are deploying OSB alongside SOA Suite on the same WebLogic domain, follow the SOA Suite runbook and add the OSB templates during domain creation; the phases here cover the standalone path.

---

## Standalone vs Joint Install

| Scenario | Approach |
|---|---|
| OSB only — service virtualization, protocol bridging, routing | This runbook (standalone OSB domain) |
| OSB + BPEL orchestration on same server | SOA Suite runbook — add OSB template during domain creation |
| OSB in front of SOA Suite (separate tiers) | This runbook for OSB tier; SOA Suite runbook for SOA tier |

---

## Environment Reference

| Item | Value |
|---|---|
| OS | Oracle Linux 8.x (x86_64) |
| Oracle DB | 19c (separate host or local) |
| OSB version | 12.2.1.4.0 |
| JDK | Oracle JDK 8u361+ |
| Oracle Home | \`/u01/app/oracle/product/fmw/osb\` |
| Domain Home | \`/u01/app/oracle/config/domains/osb_domain\` |
| Application Home | \`/u01/app/oracle/config/applications/osb_domain\` |
| OS user | \`oracle\` |
| DB service | \`osbdb.example.com:1521/OSBDB\` |
| RCU prefix | \`OSB\` |
| AdminServer port | \`7001\` |
| OSB managed server port | \`9001\` |

All commands run as the \`oracle\` OS user unless noted.

---

## Phase 1: OS Prerequisites

### 1.1 Packages and system settings

Run as \`root\`:

\`\`\`bash
dnf install -y libaio libaio-devel gcc gcc-c++ make glibc glibc-devel \\
  libgcc libstdc++ libstdc++-devel sysstat binutils compat-openssl11 \\
  ksh unzip zip

# Verify minimum 4 GB swap
free -h

# /tmp must have at least 1 GB free
df -h /tmp
\`\`\`

### 1.2 OS user and directories

\`\`\`bash
# As root
groupadd oinstall
groupadd dba
useradd -g oinstall -G dba -m -s /bin/bash oracle

mkdir -p /u01/app/oracle/product/fmw/osb
mkdir -p /u01/app/oracle/config/domains
mkdir -p /u01/app/oracle/config/applications
mkdir -p /u01/app/oraInventory
chown -R oracle:oinstall /u01/app/oracle
chown oracle:oinstall /u01/app/oraInventory
\`\`\`

### 1.3 oracle user environment

Add to \`/home/oracle/.bash_profile\`:

\`\`\`bash
export ORACLE_BASE=/u01/app/oracle
export MW_HOME=/u01/app/oracle/product/fmw/osb
export DOMAIN_HOME=/u01/app/oracle/config/domains/osb_domain
export JAVA_HOME=/u01/app/oracle/product/jdk8
export PATH=\${JAVA_HOME}/bin:\${PATH}
export ORACLE_HOSTNAME=\$(hostname -f)
\`\`\`

\`\`\`bash
source ~/.bash_profile
\`\`\`

---

## Phase 2: Install Oracle JDK 8

\`\`\`bash
mkdir -p /u01/app/oracle/product/jdk8
tar -xzf jdk-8u361-linux-x64.tar.gz -C /u01/app/oracle/product/jdk8 --strip-components=1

java -version
# Expected: java version "1.8.0_361"
\`\`\`

---

## Phase 3: Install Fusion Middleware Infrastructure

OSB 12.2.1.4 requires the FMW Infrastructure (WebLogic Server + JRF) as a prerequisite layer.

**Installer file:** \`fmw_12.2.1.4.0_infrastructure.jar\`

\`\`\`bash
java -jar fmw_12.2.1.4.0_infrastructure.jar
\`\`\`

Wizard steps:

1. **Inventory Setup** — Directory: \`/u01/app/oraInventory\`, OS Group: \`oinstall\`
2. **Installation Location** — Oracle Home: \`/u01/app/oracle/product/fmw/osb\`
3. **Installation Type** — **Fusion Middleware Infrastructure** (not "With Examples")
4. **Prerequisite Checks** — resolve failures before continuing
5. **Install** — complete, then Finish

Verify:

\`\`\`bash
ls /u01/app/oracle/product/fmw/osb/wlserver/server/lib/weblogic.jar
\`\`\`

---

## Phase 4: Install Oracle Service Bus

**Installer file:** \`fmw_12.2.1.4.0_osb.jar\`

\`\`\`bash
java -jar fmw_12.2.1.4.0_osb.jar
\`\`\`

Wizard steps:

1. **Installation Location** — same Oracle Home: \`/u01/app/oracle/product/fmw/osb\`
2. **Installation Type** — **Service Bus** (standalone; do not select "SOA Suite and Service Bus" here)
3. **Prerequisite Checks** — resolve failures
4. **Install** — complete, then Finish

Verify OSB files:

\`\`\`bash
ls /u01/app/oracle/product/fmw/osb/osb/
# Should show: bin  coherence  common  config  lib  modules  plugins
\`\`\`

---

## Phase 5: Run Repository Creation Utility (RCU)

OSB does not use the SOAINFRA schema. The required schemas are a smaller set than a full SOA Suite installation.

### 5.1 Database prerequisites

Connect to the target DB as SYSDBA:

\`\`\`sql
-- Verify AL32UTF8 character set
SELECT value FROM nls_database_parameters WHERE parameter = 'NLS_CHARACTERSET';

-- Create a dedicated tablespace for OSB schemas
CREATE TABLESPACE OSB_DATA
  DATAFILE '/u01/oradata/OSBDB/osb_data01.dbf' SIZE 512M AUTOEXTEND ON NEXT 256M MAXSIZE 5G
  EXTENT MANAGEMENT LOCAL SEGMENT SPACE MANAGEMENT AUTO;
\`\`\`

### 5.2 Run RCU

\`\`\`bash
/u01/app/oracle/product/fmw/osb/oracle_common/bin/rcu
\`\`\`

Wizard steps:

1. **Create Repository** — System Load and Product Load
2. **Database Connection** — Host: \`osbdb.example.com\`, Port: \`1521\`, Service: \`OSBDB\`, Username: SYS, Role: SYSDBA
3. **Select Components** — Prefix: \`OSB\`, check:
   - **AS Common Schemas**: Common Infrastructure Services (**STB**), Oracle Platform Security Services (**OPSS**), Audit Services (**IAU**), Audit Services Append (**IAU_APPEND**), Audit Services Viewer (**IAU_VIEWER**)
   - **Metadata Services**: Metadata Services (**MDS**)
   - **WebLogic Services**: WebLogic Services (**WLS**)
   - **User Messaging Service**: User Messaging Service (**UMS**) — include if OSB alert/notification features are needed
4. **Schema Passwords** — set passwords
5. **Map Tablespaces** — assign \`OSB_DATA\` as default tablespace for MDS and OPSS
6. **Create** — confirm all schemas created successfully

Verify:

\`\`\`sql
SELECT username, account_status FROM dba_users
WHERE username LIKE 'OSB%'
ORDER BY username;
\`\`\`

---

## Phase 6: Create the WebLogic Domain

### 6.1 Launch Config Wizard

\`\`\`bash
/u01/app/oracle/product/fmw/osb/oracle_common/common/bin/config.sh
\`\`\`

### 6.2 Wizard walkthrough

**Step 1 — Configuration Type**: Create a new domain

**Step 2 — Templates**: Select:
- Oracle Service Bus — \`oracle.osb.12.2.1_template.jar\`
- Oracle Enterprise Manager — for EM FMW Control
- Oracle JRF
- WebLogic Coherence Cluster Extension

Do **not** select SOA templates unless this is a joint install.

**Step 3 — Application Location**: \`/u01/app/oracle/config/applications/osb_domain\`

**Step 4 — Administrator Account**: Set WebLogic admin username (e.g., \`weblogic\`) and password

**Step 5 — Domain Mode and JDK**:
- Mode: **Production**
- JDK: \`/u01/app/oracle/product/jdk8\`

**Step 6 — Database Configuration Type**: RCU Data

**Step 7 — RCU Data**:
- DBMS/Service: \`osbdb.example.com:1521/OSBDB\`
- Schema Owner: \`OSB_STB\`
- Password: (STB schema password)
- Click **Get RCU Configuration** — populates all other schema connection fields automatically

Run connection tests — all must pass green.

**Step 8 — Advanced Configuration**: Select Administration Server, Node Manager, Topology

**Step 9 — Administration Server**:
- Name: \`AdminServer\`
- Listen Port: \`7001\`

**Step 10 — Managed Servers**: The wizard auto-creates \`osb_server1\`:
- Name: \`osb_server1\`
- Listen Port: \`9001\`
- Server Groups: \`OSB-MGD-SVRS\`

**Step 11 — Clusters**: Skip for single-node; create cluster for HA.

**Step 12 — Coherence**: Accept defaults (port 9575 for OSB domain).

**Step 13 — Machines**: Create \`osb_machine1\`:
- Node Manager Listen Address: \`localhost\`
- Node Manager Listen Port: \`5556\`

Assign both \`AdminServer\` and \`osb_server1\` to \`osb_machine1\`.

**Step 14 — Node Manager**:
- Type: Per Domain Custom Location
- Home: \`/u01/app/oracle/config/domains/osb_domain/nodemanager\`
- Set NM username and password

**Step 15 — Configuration Summary**: Review, then **Create**.

Domain creation completes in 3–5 minutes.

---

## Phase 7: Start the Domain

### 7.1 Start AdminServer

\`\`\`bash
cd /u01/app/oracle/config/domains/osb_domain/bin
nohup ./startWebLogic.sh > /u01/app/oracle/config/domains/osb_domain/servers/AdminServer/logs/AdminServer.out 2>&1 &

tail -f /u01/app/oracle/config/domains/osb_domain/servers/AdminServer/logs/AdminServer.out
# Wait for: Server state changed to RUNNING
\`\`\`

Create \`boot.properties\` for passwordless startup:

\`\`\`bash
mkdir -p /u01/app/oracle/config/domains/osb_domain/servers/AdminServer/security
cat > /u01/app/oracle/config/domains/osb_domain/servers/AdminServer/security/boot.properties << 'EOF'
username=weblogic
password=<admin_password>
EOF
\`\`\`

### 7.2 Start Node Manager

\`\`\`bash
cd /u01/app/oracle/config/domains/osb_domain/bin
nohup ./startNodeManager.sh > /u01/app/oracle/config/domains/osb_domain/nodemanager/nodemanager.out 2>&1 &

tail -f /u01/app/oracle/config/domains/osb_domain/nodemanager/nodemanager.out
# Wait for: Listener started on port 5556
\`\`\`

### 7.3 Start osb_server1

Create \`boot.properties\` for the managed server:

\`\`\`bash
mkdir -p /u01/app/oracle/config/domains/osb_domain/servers/osb_server1/security
cat > /u01/app/oracle/config/domains/osb_domain/servers/osb_server1/security/boot.properties << 'EOF'
username=weblogic
password=<admin_password>
EOF
\`\`\`

Start via WLST:

\`\`\`bash
/u01/app/oracle/product/fmw/osb/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<admin_password>','t3://localhost:7001')
nm()
nmStart('osb_server1')
exit()
EOF
\`\`\`

Monitor startup:

\`\`\`bash
tail -f /u01/app/oracle/config/domains/osb_domain/servers/osb_server1/logs/osb_server1.log
# Wait for: Server state changed to RUNNING
\`\`\`

OSB managed server startup is faster than SOA Suite — typically 2–5 minutes.

---

## Phase 8: Post-Install Verification

### 8.1 WebLogic Admin Console

\`http://<host>:7001/console\` — verify AdminServer and osb_server1 both show RUNNING.

### 8.2 EM Fusion Middleware Control

\`http://<host>:7001/em\` — navigate to **Service Bus > sb (osb_server1)**. Confirm the Service Bus runtime shows no errors.

### 8.3 OSB Console

The OSB management console runs on the AdminServer (not the managed server):

\`http://<host>:7001/sbconsole\`

Log in with the WebLogic admin credentials. Confirm:
- The console loads with an empty project list
- No system errors in the banner

### 8.4 Service Bus endpoint probe

\`\`\`bash
# Probe the OSB transport servlet on the managed server
curl -s -o /dev/null -w "%{http_code}" \\
  http://localhost:9001/sbinspection.wsil
# Expected: 200

# Probe the UDDI service registry
curl -s -o /dev/null -w "%{http_code}" \\
  "http://localhost:7001/uddi/inquiry"
# Expected: 200
\`\`\`

### 8.5 Verify MDS datasource

\`\`\`bash
grep -i "mds\\|metadata" \\
  /u01/app/oracle/config/domains/osb_domain/servers/osb_server1/logs/osb_server1.log \\
  | grep -iv "debug" | tail -10
# Should show successful MDS datasource initialization, no errors
\`\`\`

---

## Phase 9: Deploy a Test Proxy Service

Verify the OSB pipeline is functional by deploying a minimal pass-through proxy.

### 9.1 Create a test project in OSB Console

1. Log in to \`http://<host>:7001/sbconsole\`
2. Click **Create** in the Projects pane → name it \`TestProject\`
3. Inside \`TestProject\`, create a **Business Service**:
   - Name: \`EchoBS\`
   - Service Type: Any SOAP Service
   - WSDL URL: leave blank for now; set Transport to HTTP
   - Endpoint URI: \`http://localhost:7001/sbconsole\` (any reachable URL for testing)
4. Create a **Proxy Service**:
   - Name: \`EchoPS\`
   - Service Type: Any XML Service
   - Transport: HTTP
   - Endpoint URI: \`/TestProject/EchoPS\`
   - Routing: Route to \`EchoBS\`
5. **Activate** the session (click the session name > Activate)

### 9.2 Test the proxy endpoint

\`\`\`bash
curl -s -o /dev/null -w "%{http_code}" \\
  http://localhost:9001/TestProject/EchoPS
# Expected: 200 or 500 (proxy is live; 500 means routing reached the backend and got a response)
# A 404 means the proxy is not deployed or the URI is wrong
\`\`\`

### 9.3 Verify in OSB console monitoring

In OSB Console > **Operations > Dashboard**, the \`EchoPS\` proxy should show message count > 0 after the test call.

---

## Phase 10: JVM Tuning

OSB is stateless — it does not dehydrate process instances to database. Its memory footprint is smaller than SOA Suite's BPEL engine. Set JVM arguments in \`setUserOverrides.sh\`:

\`\`\`bash
vi /u01/app/oracle/config/domains/osb_domain/bin/setUserOverrides.sh
\`\`\`

\`\`\`bash
#!/bin/bash
if [ "\${SERVER_NAME}" = "osb_server1" ]; then
  JAVA_OPTIONS="\${JAVA_OPTIONS} -Xms2g -Xmx4g"
  JAVA_OPTIONS="\${JAVA_OPTIONS} -XX:+UseG1GC"
  JAVA_OPTIONS="\${JAVA_OPTIONS} -XX:MaxGCPauseMillis=200"
  JAVA_OPTIONS="\${JAVA_OPTIONS} -XX:+HeapDumpOnOutOfMemoryError"
  JAVA_OPTIONS="\${JAVA_OPTIONS} -XX:HeapDumpPath=/u01/app/oracle/config/domains/osb_domain/servers/osb_server1/logs/"
  export JAVA_OPTIONS
fi
\`\`\`

Minimum heap for OSB standalone: **2 GB**. For production with high-throughput pipelines: **4–6 GB**.

For high-throughput proxy scenarios also tune the WebLogic execute thread pool on \`osb_server1\`. In Admin Console:

**Servers > osb_server1 > Configuration > Tuning**:
- Self-Tuning Thread Pool Min: \`25\`
- Self-Tuning Thread Pool Max: \`400\`

---

## Phase 11: systemd Service Units

Create as \`root\`:

### 11.1 Node Manager

\`/etc/systemd/system/osb-nodemanager.service\`:

\`\`\`ini
[Unit]
Description=Oracle WebLogic Node Manager (OSB Domain)
After=network.target

[Service]
Type=simple
User=oracle
Environment="JAVA_HOME=/u01/app/oracle/product/jdk8"
ExecStart=/u01/app/oracle/config/domains/osb_domain/bin/startNodeManager.sh
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
\`\`\`

### 11.2 AdminServer

\`/etc/systemd/system/osb-admin.service\`:

\`\`\`ini
[Unit]
Description=Oracle WebLogic AdminServer (OSB Domain)
After=osb-nodemanager.service
Requires=osb-nodemanager.service

[Service]
Type=simple
User=oracle
Environment="JAVA_HOME=/u01/app/oracle/product/jdk8"
WorkingDirectory=/u01/app/oracle/config/domains/osb_domain
ExecStart=/u01/app/oracle/config/domains/osb_domain/bin/startWebLogic.sh
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
\`\`\`

### 11.3 Managed server start script

\`/u01/app/oracle/config/domains/osb_domain/bin/start_osb_server1.sh\`:

\`\`\`bash
#!/bin/bash
source /home/oracle/.bash_profile
/u01/app/oracle/product/fmw/osb/oracle_common/common/bin/wlst.sh << 'WLSTEOF'
connect('weblogic','<admin_password>','t3://localhost:7001')
nm()
nmStart('osb_server1')
exit()
WLSTEOF
\`\`\`

\`\`\`bash
chmod 750 /u01/app/oracle/config/domains/osb_domain/bin/start_osb_server1.sh
\`\`\`

\`/etc/systemd/system/osb-server1.service\`:

\`\`\`ini
[Unit]
Description=Oracle OSB Managed Server osb_server1
After=osb-admin.service
Requires=osb-admin.service

[Service]
Type=oneshot
User=oracle
ExecStart=/u01/app/oracle/config/domains/osb_domain/bin/start_osb_server1.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
\`\`\`

Enable services:

\`\`\`bash
systemctl daemon-reload
systemctl enable osb-nodemanager osb-admin osb-server1
\`\`\`

---

## Troubleshooting

### sbconsole returns 404

Confirm the \`sbconsole\` application is deployed to AdminServer (not osb_server1). In Admin Console under **Deployments**, verify \`com.bea.alsb.console.core\` is Active and targeted to \`AdminServer\`.

### osb_server1 starts but proxy endpoints return 503

The OSB transport layer may not have initialized. Check:

\`\`\`bash
grep -i "transport\\|http channel\\|osb" \\
  /u01/app/oracle/config/domains/osb_domain/servers/osb_server1/logs/osb_server1.log \\
  | grep -i "error\\|warn\\|fail"
\`\`\`

A common cause is the Coherence cluster failing to initialize. Verify port 9575 is not blocked by a local firewall:

\`\`\`bash
firewall-cmd --list-ports
# If needed:
# firewall-cmd --permanent --add-port=9575/tcp && firewall-cmd --reload
\`\`\`

### OSB session activation fails with "Merge conflict"

Another admin session was left open without activating or discarding. In OSB Console > **Sessions**, discard any orphaned sessions, then retry activation.

### MDS datasource connection failure on startup

Test the connection directly from the OSB host:

\`\`\`bash
/u01/app/oracle/product/fmw/osb/oracle_common/bin/sqlplus OSB_MDS/<password>@osbdb.example.com:1521/OSBDB
\`\`\`

If this fails, check network routing to the DB host, Oracle listener status (\`lsnrctl status\`), and that the \`OSB_MDS\` account is unlocked.

### Proxy receives requests but pipeline changes are not reflected

Sessions in OSB are not committed until activated. After editing any pipeline, proxy, or business service, you must activate the session. Uncommitted changes are visible only to the current session owner.

### OSB console login hangs or returns 401 after domain restart

The OPSS policy store may need to be re-bootstrapped if the domain was moved or restored. Check:

\`\`\`bash
grep -i "opss\\|policy\\|credential" \\
  /u01/app/oracle/config/domains/osb_domain/servers/AdminServer/logs/AdminServer.log \\
  | grep -i "error\\|fail" | tail -20
\`\`\`

---

## Rollback: Uninstall

\`\`\`bash
# 1. Stop all servers
systemctl stop osb-server1 osb-admin osb-nodemanager

# 2. Drop RCU schemas (as SYSDBA in target DB)
# Run RCU in Drop mode, or manually:
# DROP USER OSB_MDS CASCADE;
# DROP USER OSB_STB CASCADE;
# DROP USER OSB_OPSS CASCADE;
# DROP USER OSB_IAU CASCADE;
# DROP USER OSB_IAU_APPEND CASCADE;
# DROP USER OSB_IAU_VIEWER CASCADE;
# DROP USER OSB_WLS CASCADE;
# DROP USER OSB_UMS CASCADE;
# DROP TABLESPACE OSB_DATA INCLUDING CONTENTS AND DATAFILES;

# 3. Remove Oracle Home
rm -rf /u01/app/oracle/product/fmw/osb

# 4. Remove domain
rm -rf /u01/app/oracle/config/domains/osb_domain
rm -rf /u01/app/oracle/config/applications/osb_domain

# 5. Remove oraInventory if this is the only FMW install on the host
rm -rf /u01/app/oraInventory

# 6. Remove systemd units
systemctl disable osb-nodemanager osb-admin osb-server1
rm /etc/systemd/system/osb-nodemanager.service
rm /etc/systemd/system/osb-admin.service
rm /etc/systemd/system/osb-server1.service
systemctl daemon-reload
\`\`\`

---

## Post-Install Checklist

- [ ] AdminServer starts and reaches RUNNING state
- [ ] Node Manager starts and connects on port 5556
- [ ] osb_server1 starts and reaches RUNNING state
- [ ] OSB Console accessible at \`:7001/sbconsole\`
- [ ] EM FMW Control accessible at \`:7001/em\`
- [ ] Service Bus runtime shows Running in EM
- [ ] MDS and OPSS datasource tests pass in Admin Console
- [ ] All RCU schemas OPEN (not EXPIRED/LOCKED) in database
- [ ] Test proxy service deployed, activated, and receiving requests
- [ ] \`:9001/sbinspection.wsil\` returns 200
- [ ] systemd services enabled for automatic restart
- [ ] \`boot.properties\` created for AdminServer and osb_server1 (passwordless startup)
- [ ] JVM heap set to minimum 2 GB on osb_server1
- [ ] Thread pool tuning applied for expected throughput`,
};

async function main() {
  console.log('Inserting OSB deployment runbook...');
  await db.insert(posts).values(post).onConflictDoNothing();
  console.log(`Inserted: "${post.title}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
