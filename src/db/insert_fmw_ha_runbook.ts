import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Configuring Oracle Fusion Middleware High Availability',
  slug: 'fusion-middleware-high-availability-runbook',
  excerpt:
    'Step-by-step runbook for configuring Oracle Fusion Middleware 12c high availability — WebLogic clusters, Node Manager failover, shared storage, GridLink JDBC datasources, JMS migratable targets, Automatic Service Migration, Oracle HTTP Server web tier, and load balancer configuration.',
  category: 'fusion-middleware' as const,
  published: true,
  publishedAt: new Date('2026-05-31'),
  youtubeUrl: null,
  content: `A highly available Oracle Fusion Middleware environment requires coordination across several layers: the web tier (load balancer and Oracle HTTP Server), the application tier (WebLogic cluster), the middleware services (JMS, transaction logs), and the data tier (RAC or Data Guard database). This runbook configures a two-node active-active WebLogic cluster for a SOA Suite 12.2.1.4 domain. The same pattern applies to OSB, OIM, OAM, and any other FMW product.

---

## Target Architecture

\`\`\`
                     ┌─────────────────────────────┐
                     │      Load Balancer VIP       │
                     │   lb.example.com:443/80      │
                     └──────────┬──────────┬────────┘
                                │          │
               ┌────────────────▼──┐  ┌────▼─────────────────┐
               │  Oracle HTTP Svr  │  │  Oracle HTTP Svr      │
               │    ohs1:7777      │  │    ohs2:7777          │
               │  (Node 1)         │  │  (Node 2)             │
               └────────┬──────────┘  └──────────┬────────────┘
                        │  mod_wl_ohs proxy        │
               ┌────────▼──────────────────────────▼────────┐
               │              WebLogic Cluster               │
               │  ┌────────────────┐  ┌────────────────┐    │
               │  │ soa_server1    │  │ soa_server2    │    │
               │  │ Node 1: 8001   │  │ Node 2: 8001   │    │
               │  └────────────────┘  └────────────────┘    │
               │                                             │
               │  AdminServer (Node 1: 7001)                 │
               └─────────────────────────────────────────────┘
                                    │
                        ┌───────────▼───────────┐
                        │   Oracle RAC / DB      │
                        │  (SOAINFRA, MDS, OPSS) │
                        └───────────────────────┘
\`\`\`

**Nodes:**
- \`soa-node1.example.com\` — AdminServer + soa_server1 + OHS1
- \`soa-node2.example.com\` — soa_server2 + OHS2
- \`lb.example.com\` — Load balancer VIP (hardware or software)

**Shared storage:** NFS mount at \`/u01/share\` on both nodes (required for JMS stores and transaction logs)

---

## Phase 1: Shared Storage Setup

### 1.1 NFS configuration

Both nodes must mount the same shared filesystem for JMS persistent stores and transaction logs. Without shared storage, JMS messages in flight at failover time are lost.

On the NFS server (as root):

\`\`\`bash
mkdir -p /export/fmw_share
chown oracle:oinstall /export/fmw_share
chmod 755 /export/fmw_share

# Add to /etc/exports
echo "/export/fmw_share soa-node1.example.com(rw,sync,no_root_squash) soa-node2.example.com(rw,sync,no_root_squash)" >> /etc/exports
exportfs -ra
\`\`\`

On both FMW nodes (as root):

\`\`\`bash
mkdir -p /u01/share
mount -t nfs nfs-server.example.com:/export/fmw_share /u01/share
chown oracle:oinstall /u01/share

# Add to /etc/fstab for persistent mount
echo "nfs-server.example.com:/export/fmw_share /u01/share nfs rw,sync,hard,intr,timeo=600,retrans=3 0 0" >> /etc/fstab

# Verify from both nodes
ls -la /u01/share
\`\`\`

Create subdirectories for JMS and TX log stores:

\`\`\`bash
mkdir -p /u01/share/jms/soa_server1
mkdir -p /u01/share/jms/soa_server2
mkdir -p /u01/share/tlogs/soa_server1
mkdir -p /u01/share/tlogs/soa_server2
chown -R oracle:oinstall /u01/share
\`\`\`

---

## Phase 2: Install FMW on Node 2

The Oracle Home must be installed on each node. The domain home can be local or shared — Oracle recommends **local domain homes** (one per node) with a shared NFS location for JMS/TX stores only. Shared domain homes introduce NFS latency on every configuration read.

On **soa-node2** (as oracle), repeat the FMW Infrastructure + SOA Suite installation steps from the installation runbook, using the same Oracle Home path:

\`\`\`bash
# Node 2 Oracle Home — same path as Node 1
/u01/app/oracle/product/fmw/soa
\`\`\`

Apply the same OPatch patches to Node 2 before domain configuration. Both nodes must be at identical patch levels.

\`\`\`bash
# Verify both nodes are at the same patch level
# Node 1:
ssh oracle@soa-node1 "opatch lspatches" > /tmp/node1_patches.txt
# Node 2:
opatch lspatches > /tmp/node2_patches.txt
diff /tmp/node1_patches.txt /tmp/node2_patches.txt
# Should produce no output (identical patch sets)
\`\`\`

---

## Phase 3: Configure the WebLogic Cluster

This phase extends the existing single-node domain (created in the installation runbook) to a two-node cluster.

### 3.1 Add soa_server2 to the domain

On **soa-node1**, use the Config Wizard to extend the domain:

\`\`\`bash
/u01/app/oracle/product/fmw/soa/oracle_common/common/bin/config.sh
\`\`\`

1. **Configuration Type**: Update an existing domain
2. **Select Domain**: \`/u01/app/oracle/config/domains/soa_domain\`
3. **Templates**: No new templates needed (extending existing)
4. **Advanced Configuration**: Topology
5. **Managed Servers**: Add \`soa_server2\`
   - Name: \`soa_server2\`
   - Listen Address: \`soa-node2.example.com\`
   - Listen Port: \`8001\`
   - Server Groups: \`SOA-MGD-SVRS-ONLY\`
6. **Clusters**: Create cluster \`soa_cluster\`
   - Cluster Messaging Mode: **Unicast**
   - Cluster Address: \`soa-node1.example.com:8001,soa-node2.example.com:8001\`
7. **Assign Servers to Clusters**: Assign \`soa_server1\` and \`soa_server2\` to \`soa_cluster\`
8. **Machines**: Add \`soa_machine2\`
   - Node Manager Listen Address: \`soa-node2.example.com\`
   - Node Manager Listen Port: \`5556\`
9. **Assign Servers to Machines**: Assign \`soa_server2\` to \`soa_machine2\`
10. **Configuration Summary**: Review and **Update**

### 3.2 Pack the domain for Node 2

\`\`\`bash
mkdir -p /u01/share/domain_templates

/u01/app/oracle/product/fmw/soa/oracle_common/common/bin/pack.sh \\
  -domain=/u01/app/oracle/config/domains/soa_domain \\
  -template=/u01/share/domain_templates/soa_domain_pack.jar \\
  -template_name="SOA Domain HA" \\
  -managed=true

# Verify pack succeeded
ls -lh /u01/share/domain_templates/soa_domain_pack.jar
\`\`\`

### 3.3 Unpack the domain on Node 2

On **soa-node2**:

\`\`\`bash
mkdir -p /u01/app/oracle/config/domains
mkdir -p /u01/app/oracle/config/applications

/u01/app/oracle/product/fmw/soa/oracle_common/common/bin/unpack.sh \\
  -domain=/u01/app/oracle/config/domains/soa_domain \\
  -template=/u01/share/domain_templates/soa_domain_pack.jar \\
  -app_dir=/u01/app/oracle/config/applications/soa_domain \\
  -server_name=soa_server2

# Create boot.properties for soa_server2
mkdir -p /u01/app/oracle/config/domains/soa_domain/servers/soa_server2/security
cat > /u01/app/oracle/config/domains/soa_domain/servers/soa_server2/security/boot.properties << 'EOF'
username=weblogic
password=<admin_password>
EOF
chmod 600 /u01/app/oracle/config/domains/soa_domain/servers/soa_server2/security/boot.properties
\`\`\`

---

## Phase 4: Configure Node Manager on Both Nodes

### 4.1 Node Manager configuration

On **each node**, verify the Node Manager properties file:

\`\`\`bash
cat /u01/app/oracle/config/domains/soa_domain/nodemanager/nodemanager.properties
\`\`\`

Key properties to verify or set:

\`\`\`properties
ListenAddress=<node-hostname>
ListenPort=5556
SecureListener=false
CrashRecoveryEnabled=true
StartScriptEnabled=true
StopScriptEnabled=false
QuitEnabled=true
LogCount=5
NodeManagerHome=/u01/app/oracle/config/domains/soa_domain/nodemanager
DomainsDirRemoteSharingEnabled=false
\`\`\`

\`CrashRecoveryEnabled=true\` is critical — it tells Node Manager to automatically restart a managed server that crashes without a clean shutdown.

### 4.2 Enroll the domain with Node Manager on Node 2

On **soa-node2**, after unpacking the domain:

\`\`\`bash
/u01/app/oracle/product/fmw/soa/oracle_common/common/bin/wlst.sh << 'EOF'
nmConnect('nmadmin','<nm_password>','soa-node2.example.com','5556',
          'soa_domain','/u01/app/oracle/config/domains/soa_domain')
nmEnroll('/u01/app/oracle/config/domains/soa_domain',
         '/u01/app/oracle/config/domains/soa_domain/nodemanager')
nmDisconnect()
exit()
EOF
\`\`\`

### 4.3 Start Node Manager on both nodes

\`\`\`bash
# On each node
nohup /u01/app/oracle/config/domains/soa_domain/bin/startNodeManager.sh \\
  > /u01/app/oracle/config/domains/soa_domain/nodemanager/nodemanager.out 2>&1 &
\`\`\`

---

## Phase 5: Configure Clustered JMS and Transaction Logs on Shared Storage

In a cluster, JMS persistent stores and transaction logs must be on shared storage so that if a server migrates to another node, the surviving node can read the pending messages and in-doubt transactions.

### 5.1 Configure JMS file stores on shared NFS

In Admin Console: **Services > Persistent Stores > New > Create FileStore**

Create two file stores — one per server, both on NFS:

| Store name | Directory | Target server |
|---|---|---|
| \`SOAJMSFileStore_soa_server1\` | \`/u01/share/jms/soa_server1\` | \`soa_server1\` |
| \`SOAJMSFileStore_soa_server2\` | \`/u01/share/jms/soa_server2\` | \`soa_server2\` |

### 5.2 Configure Transaction Logs (TLogs) on shared storage

In Admin Console: **Environment > Servers > soa_server1 > Services > Transaction**

Set **Transaction Log Store** to:
- Type: File
- Directory: \`/u01/share/tlogs/soa_server1\`

Repeat for **soa_server2** pointing to \`/u01/share/tlogs/soa_server2\`.

### 5.3 Retarget SOA JMS modules to the cluster

The SOA Suite JMS modules (UMS queues, BPEL deferred message queues) should target the cluster rather than individual servers. In Admin Console:

**Services > Messaging > JMS Servers** — for each SOA JMS server, change its Persistent Store to the shared file store created above.

**Services > Messaging > JMS Modules** — verify SOA JMS modules target \`soa_cluster\` rather than individual servers.

---

## Phase 6: Configure Migratable Targets and Automatic Service Migration

Migratable targets allow JMS servers and singleton services to automatically migrate to a surviving cluster member when a server fails.

### 6.1 Create migratable targets

In Admin Console: **Environment > Migratable Targets > New**

| Migratable target | User preferred server | Candidate servers |
|---|---|---|
| \`soa_server1 (migratable)\` | \`soa_server1\` | \`soa_server1, soa_server2\` |
| \`soa_server2 (migratable)\` | \`soa_server2\` | \`soa_server2, soa_server1\` |

### 6.2 Configure Automatic Service Migration

In Admin Console: **Environment > Clusters > soa_cluster > Migration**

- Migration Basis: **Database**
- Data Source For Automatic Migration: Select the SOA datasource (the one pointing to SOAINFRA schema — WebLogic uses it as a distributed lease store for ASM coordination)
- Auto Migration Table Name: \`ACTIVE\`

### 6.3 Retarget JMS servers to migratable targets

In Admin Console: **Services > Messaging > JMS Servers > SOAJMSServer_soa_server1**

Change **Target** from \`soa_server1\` to \`soa_server1 (migratable)\`.

Repeat for \`soa_server2\` migratable target.

This ensures that if soa_server1 crashes, its JMS server migrates to soa_server2 automatically, and messages already in the queue (on shared NFS) are processed by the surviving server.

---

## Phase 7: Configure GridLink JDBC Datasources for RAC

Standard JDBC datasources connect to a single DB endpoint. For Oracle RAC, use **GridLink** datasources which integrate with ONS (Oracle Notification Service) to receive real-time RAC node status events and automatically route connections away from failed RAC nodes.

### 7.1 Replace the existing SOAINFRA datasource with GridLink

In Admin Console: **Services > Data Sources > SOADataSource > Delete** (drain connections first)

Create a new GridLink datasource: **Services > Data Sources > New > GridLink Data Source**

Configuration:

\`\`\`
Name:         SOADataSource
JNDI Name:    jdbc/SOADataSource
Database:     Oracle
Driver:       oracle.jdbc.pool.OracleDataSource (XA-capable for SOA)
URL:          jdbc:oracle:thin:@(DESCRIPTION=
                (LOAD_BALANCE=ON)
                (ADDRESS=(PROTOCOL=TCP)(HOST=rac-scan.example.com)(PORT=1521))
                (CONNECT_DATA=(SERVICE_NAME=SOADB)(SERVER=DEDICATED)))

ONS node list: rac-node1.example.com:6200,rac-node2.example.com:6200
\`\`\`

GridLink ONS configuration enables:
- **Fast Connection Failover (FCF)** — dead connections are removed from the pool immediately when ONS reports a RAC node failure, rather than waiting for TCP timeout
- **Runtime Load Balancing (RLB)** — connections are distributed based on real-time RAC instance load metrics from ONS

### 7.2 Verify ONS port accessibility

\`\`\`bash
# Test ONS port from FMW nodes
nc -zv rac-node1.example.com 6200
nc -zv rac-node2.example.com 6200
\`\`\`

### 7.3 Test the GridLink datasource

In Admin Console: **Services > Data Sources > SOADataSource > Monitoring > Test**

All cluster members should show a successful test.

---

## Phase 8: Configure Oracle HTTP Server Web Tier

Oracle HTTP Server (OHS) acts as the HTTP/HTTPS front-end that proxies requests to the WebLogic cluster via the \`mod_wl_ohs\` module. Install OHS from the Oracle Web Tier installer on each web tier node (or on the same nodes as the WLS cluster for smaller deployments).

### 8.1 Install Oracle HTTP Server

\`\`\`bash
# OHS installer: fmw_12.2.1.4.0_ohs.jar
java -jar fmw_12.2.1.4.0_ohs.jar
# Installation type: Standalone HTTP Server (Managed independently of WebLogic)
# Oracle Home: /u01/app/oracle/product/fmw/ohs
\`\`\`

### 8.2 Create OHS instance

\`\`\`bash
/u01/app/oracle/product/fmw/ohs/oracle_common/common/bin/config.sh
\`\`\`

1. Configuration type: Standalone Domain
2. Add component: Oracle HTTP Server
3. Instance name: \`ohs1\` (on Node 1), \`ohs2\` (on Node 2)
4. HTTP port: \`7777\`
5. HTTPS port: \`4443\`

### 8.3 Configure mod_wl_ohs proxy

Edit \`/u01/app/oracle/config/domains/ohs_domain/config/fmwconfig/components/OHS/ohs1/moduleconf/soa_wl.conf\`:

\`\`\`apache
<IfModule weblogic_module>

  # SOA Infrastructure
  <Location /soa-infra>
    WLSRequest ON
    WebLogicCluster soa-node1.example.com:8001,soa-node2.example.com:8001
    WLProxySSL OFF
    WLCookieName JSESSIONID
  </Location>

  # EM FMW Control (proxy only to AdminServer)
  <Location /em>
    WLSRequest ON
    WebLogicHost soa-node1.example.com
    WebLogicPort 7001
  </Location>

  # WebLogic Admin Console
  <Location /console>
    WLSRequest ON
    WebLogicHost soa-node1.example.com
    WebLogicPort 7001
  </Location>

  # BPM Worklist / Human Workflow
  <Location /integration>
    WLSRequest ON
    WebLogicCluster soa-node1.example.com:8001,soa-node2.example.com:8001
    WLCookieName JSESSIONID
  </Location>

</IfModule>
\`\`\`

### 8.4 Start OHS

\`\`\`bash
/u01/app/oracle/config/domains/ohs_domain/bin/startComponent.sh ohs1

# Verify
curl -s -o /dev/null -w "%{http_code}" http://localhost:7777/soa-infra/
# Expected: 200 (proxied through to the WLS cluster)
\`\`\`

---

## Phase 9: Load Balancer Configuration

The load balancer VIP is the single entry point that distributes traffic between OHS1 and OHS2 (or directly to WLS nodes if OHS is omitted).

### 9.1 Virtual IP and health check

Configure the load balancer VIP \`lb.example.com\` with:

- **Port**: 443 (HTTPS) and 80 (HTTP redirect)
- **Pool members**: \`ohs1:7777\` and \`ohs2:7777\`
- **Algorithm**: Round robin or least connections
- **Session persistence**: Cookie-based on \`JSESSIONID\` for stateful applications (Human Workflow, BPM Worklist)
- **Health check URL**: \`http://<ohs-node>:7777/soa-infra/\` — expect HTTP 200

### 9.2 Session persistence configuration

SOA Infrastructure endpoints are mostly stateless — each service invocation is independent. However:

- **Human Workflow / BPM Worklist** requires session persistence (sticky sessions) because the task inbox UI maintains server-side session state
- **SOAP/REST service calls** should be load balanced without sticky sessions

Configure two virtual services on the load balancer:
1. \`/integration/*\` and \`/bpm/*\` — sticky sessions on JSESSIONID
2. \`/soa-infra/*\` and \`/webservices/*\` — no session persistence

### 9.3 WebLogic cluster frontend host configuration

Tell the WebLogic cluster its public-facing address (used for generating absolute URLs in WSDL endpoints, callback addresses, and redirect headers):

In Admin Console: **Environment > Clusters > soa_cluster > HTTP**

- Frontend Host: \`lb.example.com\`
- Frontend HTTP Port: \`80\`
- Frontend HTTPS Port: \`443\`

---

## Phase 10: Start the Full HA Environment

Start in this order:

\`\`\`bash
# 1. Start Node Manager on Node 1
ssh oracle@soa-node1 "nohup /u01/app/oracle/config/domains/soa_domain/bin/startNodeManager.sh > /u01/app/oracle/config/domains/soa_domain/nodemanager/nodemanager.out 2>&1 &"

# 2. Start Node Manager on Node 2
ssh oracle@soa-node2 "nohup /u01/app/oracle/config/domains/soa_domain/bin/startNodeManager.sh > /u01/app/oracle/config/domains/soa_domain/nodemanager/nodemanager.out 2>&1 &"

# 3. Start AdminServer on Node 1
ssh oracle@soa-node1 "nohup /u01/app/oracle/config/domains/soa_domain/bin/startWebLogic.sh > /u01/app/oracle/config/domains/soa_domain/servers/AdminServer/logs/AdminServer.out 2>&1 &"

# 4. Start soa_server1 and soa_server2 via WLST from Node 1
/u01/app/oracle/product/fmw/soa/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<password>','t3://soa-node1.example.com:7001')
nm()
nmStart('soa_server1', serverType='Server', domainDir='/u01/app/oracle/config/domains/soa_domain')
nmStart('soa_server2', serverType='Server', domainDir='/u01/app/oracle/config/domains/soa_domain')
exit()
EOF

# 5. Start OHS on both nodes
ssh oracle@soa-node1 "/u01/app/oracle/config/domains/ohs_domain/bin/startComponent.sh ohs1"
ssh oracle@soa-node2 "/u01/app/oracle/config/domains/ohs_domain/bin/startComponent.sh ohs2"
\`\`\`

---

## Phase 11: HA Verification and Failover Testing

### 11.1 Verify cluster member state

\`\`\`bash
/u01/app/oracle/product/fmw/soa/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<password>','t3://soa-node1.example.com:7001')
domainRuntime()
serverRuntime = cmo.lookupServerRuntime('soa_server1')
print('soa_server1 state:', serverRuntime.getState())
serverRuntime = cmo.lookupServerRuntime('soa_server2')
print('soa_server2 state:', serverRuntime.getState())
exit()
EOF
# Both should report: RUNNING
\`\`\`

### 11.2 Test load balancing

\`\`\`bash
# Make repeated requests and observe which server responds
for i in \$(seq 1 10); do
  curl -s -u weblogic:<password> \\
    "http://lb.example.com/soa-infra/management/SOACompositeLifecycleService?WSDL" \\
    -o /dev/null -w "Request \$i: HTTP %{http_code}\\n"
done
# All should return 200
\`\`\`

### 11.3 Test managed server crash recovery

Simulate a soa_server1 failure:

\`\`\`bash
# Kill soa_server1 process (simulates crash, not graceful shutdown)
PID=\$(ssh oracle@soa-node1 "ps -ef | grep soa_server1 | grep -v grep | awk '{print \$2}'")
ssh oracle@soa-node1 "kill -9 \${PID}"

# Node Manager should detect the crash and restart soa_server1
# Watch Node Manager log on Node 1:
tail -f /u01/app/oracle/config/domains/soa_domain/nodemanager/nodemanager.log | grep -i "soa_server1\\|restart\\|crash"

# Verify soa_server1 is restarted within ~60 seconds
\`\`\`

Expected Node Manager log entry:
\`\`\`
<INFO> <NodeManager> Server 'soa_server1' failed. Attempting to restart.
<INFO> <NodeManager> Server 'soa_server1' started successfully.
\`\`\`

### 11.4 Test JMS migration

\`\`\`bash
# 1. Submit a SOA composite that generates JMS messages
# 2. Kill soa_server1 hard (kill -9)
# 3. Observe JMS server migration to soa_server2 in Admin Console:
#    Services > Messaging > JMS Servers > SOAJMSServer_soa_server1
#    Current target should change from soa_server1 to soa_server2
# 4. Verify pending messages are processed by soa_server2
\`\`\`

### 11.5 Verify no single point of failure

| Component | HA mechanism | Test method |
|---|---|---|
| soa_server1 | Node Manager crash restart | kill -9 |
| soa_server2 | Node Manager crash restart | kill -9 |
| OHS1 | Load balancer health check failover | stop OHS1, verify LB routes to OHS2 |
| soa-node1 host | soa_server2 on Node 2 continues serving | reboot Node 1 |
| JMS server | Migratable target auto-migration | kill soa_server1 with messages in queue |
| DB connection | GridLink FCF removes dead pool connections | failover a RAC node |

---

## Monitoring HA State

### WLST cluster health query

\`\`\`bash
/u01/app/oracle/product/fmw/soa/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<password>','t3://soa-node1.example.com:7001')
domainRuntime()
serverRuntimes = cmo.getServerRuntimes()
for sr in serverRuntimes:
    print(sr.getName(), '|', sr.getState(), '|', sr.getHealthState().getState())
exit()
EOF
\`\`\`

### Admin Console cluster monitoring

**Environment > Clusters > soa_cluster > Monitoring > Servers** shows all cluster members and their current state. The **Summary** tab shows the cluster multicast/unicast communication health.

### JMS server location

\`\`\`bash
# Confirm where each JMS server is currently running
grep -i "migration\\|migrat\\|jms.*server" \\
  /u01/app/oracle/config/domains/soa_domain/servers/AdminServer/logs/AdminServer.log \\
  | tail -20
\`\`\`

---

## Troubleshooting

### soa_server2 fails to start — "Could not connect to AdminServer"

The AdminServer on Node 1 must be running and reachable from Node 2 before the managed server can start. Verify:

\`\`\`bash
nc -zv soa-node1.example.com 7001
# If this fails, check firewall rules between the two nodes
firewall-cmd --list-all
\`\`\`

### Cluster members cannot see each other — unicast messaging fails

WebLogic unicast clustering requires each cluster member to be able to open a TCP connection to every other member on the cluster listen port (8001) and the cluster messaging port (default: random port in the 5000–9000 range). Set an explicit cluster messaging port to simplify firewall rules:

In Admin Console: **Environment > Servers > soa_server1 > Cluster > Unicast**
- Cluster Message Channel: set explicit port (e.g., \`8100\`)

Repeat for soa_server2 with port \`8101\`. Open both ports on the host firewall:

\`\`\`bash
firewall-cmd --permanent --add-port=8100/tcp
firewall-cmd --permanent --add-port=8101/tcp
firewall-cmd --reload
\`\`\`

### JMS server does not migrate after soa_server1 crash

Verify:
1. The JMS server targets a **migratable target**, not the server directly
2. The migratable target has both servers in its candidate server list
3. Automatic Service Migration is configured with **Database** basis on the cluster
4. The migration lease table (\`ACTIVE\`) exists in the datasource schema — created automatically on first cluster start, but may need manual creation:

\`\`\`sql
CREATE TABLE ACTIVE (
  SERVER_NAME VARCHAR2(255) NOT NULL,
  INSTANCE_NAME VARCHAR2(255) NOT NULL,
  TIMEOUT TIMESTAMP NOT NULL,
  PRIMARY KEY (SERVER_NAME)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON ACTIVE TO <wls_datasource_schema_user>;
\`\`\`

### GridLink datasource shows all connections closed after RAC failover

ONS is not reachable. Confirm ONS port 6200 is open from FMW nodes to all RAC nodes, and the ONS node list in the datasource is correct. Re-test the datasource and check for ONS-related errors in the AdminServer log.

---

## Post-Configuration Checklist

- [ ] NFS share mounted on both nodes and survives reboot (\`/etc/fstab\`)
- [ ] JMS file store directories exist on NFS for each managed server
- [ ] Transaction log directories exist on NFS for each managed server
- [ ] soa_server2 unpacked and \`boot.properties\` in place on Node 2
- [ ] Node Manager running on both nodes with \`CrashRecoveryEnabled=true\`
- [ ] Both managed servers show RUNNING in Admin Console
- [ ] Cluster shows healthy unicast communication (no split-brain warnings in log)
- [ ] GridLink datasource configured with ONS node list and FCF enabled
- [ ] All JDBC datasource tests pass from both cluster members
- [ ] JMS servers retargeted to migratable targets
- [ ] Automatic Service Migration configured with Database migration basis
- [ ] OHS configured on both nodes with correct \`mod_wl_ohs\` cluster proxy
- [ ] Load balancer VIP routes to both OHS nodes with health check
- [ ] Frontend host set on cluster to load balancer hostname
- [ ] kill -9 test confirms Node Manager restarts the killed server
- [ ] JMS migration test confirms messages survive server failure`,
};

async function main() {
  console.log('Inserting FMW HA runbook...');
  await db.insert(posts).values(post).onConflictDoNothing();
  console.log(`Inserted: "${post.title}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
