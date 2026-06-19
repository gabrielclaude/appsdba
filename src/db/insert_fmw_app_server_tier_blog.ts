import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'FMW Application Server Tier: WebLogic, Coherence, and Enterprise Runtime Architecture',
  slug: 'fmw-application-server-tier-weblogic-coherence',
  excerpt:
    'A deep technical look at the Oracle Fusion Middleware application server tier — how WebLogic Server hosts Jakarta EE workloads, how Coherence extends the tier with distributed caching and data management, and how the two components combine to deliver scalable, transaction-safe enterprise application infrastructure.',
  category: 'fusion-middleware' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-19'),
  youtubeUrl: null,
  content: `## The Application Server Tier

This layer handles the processing, runtime execution, and transaction management of enterprise workloads.

- **Oracle WebLogic Server**: The core Jakarta EE application server that hosts your business applications and middleware components.
- **Oracle Coherence**: A distributed caching solution that provides high scalability and data management capabilities to the application server layer.

Together, these two components form the compute and memory fabric of every Oracle Fusion Middleware deployment — from a single-node development environment to a fifty-node production cluster running SOA Suite, Oracle Service Bus, or Oracle Identity Management.

---

## Oracle WebLogic Server

WebLogic Server is the runtime engine that every other FMW component sits on top of. Understanding its architecture is prerequisite to understanding any FMW product.

### Domain Architecture

A WebLogic domain is the fundamental management unit. It contains:

\`\`\`
Domain (base_domain)
  │
  ├── Administration Server  (admin host:7001)
  │     └── Manages the domain — deploys apps, configures datasources,
  │           accepts WLST/console commands. Not for production traffic.
  │
  └── Cluster (soa_cluster / osb_cluster / etc.)
        ├── Managed Server 1  (app_host1:8001)  ← Production traffic
        ├── Managed Server 2  (app_host2:8001)
        └── Managed Server N  (app_hostN:8001)
\`\`\`

The Administration Server is a control plane only — it should never handle application traffic. Managed Servers in a cluster handle all runtime load. Node Manager runs as a daemon on each host and is responsible for starting, stopping, and monitoring Managed Servers on behalf of the Administration Server.

### Java EE / Jakarta EE Runtime Containers

WebLogic provides four runtime containers. Each container has its own threading model and management lifecycle:

| Container | What it runs | Key config |
|-----------|-------------|-----------|
| Web container | Servlets, JSPs, WAR files | \`web.xml\`, \`weblogic.xml\` |
| EJB container | Session beans, MDBs, entity beans | \`ejb-jar.xml\`, \`weblogic-ejb-jar.xml\` |
| JMS subsystem | Message queues, topics, distributed destinations | JMS Server, JMS Module |
| JTA subsystem | Distributed transactions (XA) | Transaction log, XA timeout |

### Work Managers and Thread Pools

WebLogic does not use a fixed thread pool in the traditional sense. It uses a self-tuning thread pool governed by Work Managers. Each Work Manager defines scheduling constraints:

\`\`\`xml
<!-- weblogic-ejb-jar.xml excerpt -->
<work-manager>
  <name>SoaWorkManager</name>
  <max-threads-constraint>
    <name>SoaMaxThreads</name>
    <count>50</count>
  </max-threads-constraint>
  <min-threads-constraint>
    <name>SoaMinThreads</name>
    <count>5</count>
  </min-threads-constraint>
  <capacity>
    <name>SoaQueueCapacity</name>
    <count>1000</count>
  </capacity>
</work-manager>
\`\`\`

The self-tuning thread pool grows and shrinks automatically based on throughput. A thread is considered stuck when it has been executing for longer than the stuck thread detection timeout (default 600 seconds). Stuck threads are the most common cause of WebLogic Managed Server restarts in production.

\`\`\`bash
# Check current thread pool state via WLST
wlst.sh <<'EOF'
connect('weblogic', 'password', 't3://admin-host:7001')
cd('/ServerRuntimes/soa_server1/ThreadPoolRuntime/ThreadPoolRuntime')
print('Execute threads:', get('ExecuteThreadTotalCount'))
print('Idle threads:', get('ExecuteThreadIdleCount'))
print('Stuck threads:', get('StuckThreadCount'))
print('Pending requests:', get('PendingUserRequestCount'))
print('Throughput:', get('Throughput'))
exit()
EOF
\`\`\`

### JDBC Datasources and Connection Pools

WebLogic JDBC datasources are the bridge between application code and the Oracle database. They maintain a pool of pre-authenticated database connections that applications borrow and return.

\`\`\`
Application Request
       │
       ▼
JDBC Datasource (java:comp/env/jdbc/SOADataSource)
       │
       ▼
Connection Pool (min=5, max=50, timeout=300s)
       │
       ├── Connection 1 ─── Oracle DB Node 1 (RAC)
       ├── Connection 2 ─── Oracle DB Node 2 (RAC)
       ├── Connection 3 ─── Oracle DB Node 1 (RAC)
       └── ... up to max
\`\`\`

**GridLink datasources** are the recommended type for RAC databases. Unlike generic multi-datasources, GridLink subscribes to Oracle FAN (Fast Application Notification) events so that WebLogic can immediately remove connections to a failed RAC instance and fan-out to surviving instances without waiting for a TCP timeout.

\`\`\`sql
-- Verify FAN/ONS is working from the DB side
SELECT instance_name, status FROM v$instance;

-- Check that FAN events are being published
SELECT * FROM v$ons;
\`\`\`

\`\`\`bash
# Verify ONS configuration in WebLogic datasource
grep -r "onsNodeList\|fanEnabled\|GridLinkSource" \
  \${DOMAIN_HOME}/config/jdbc/
\`\`\`

### Transaction Management

WebLogic's JTA subsystem coordinates distributed transactions across multiple XA resources (database, JMS, adapters). Each domain stores transaction logs in a Transaction Log (TLOG) store — by default a file-based store on the local filesystem.

**Critical production requirement**: the TLOG must be on shared storage (NFS, SAN) when using cluster migration or Automatic Service Migration (ASM), so the new host can recover in-flight transactions from the log.

\`\`\`bash
# Check transaction log store location
grep -r "TransactionLog\|tlog" \${DOMAIN_HOME}/config/config.xml | grep -i "directory\|file"

# Move TLOG to shared storage (WLST)
wlst.sh <<'EOF'
connect('weblogic', 'password', 't3://admin-host:7001')
edit()
startEdit()
cd('/Servers/soa_server1/TransactionLogJDBCStore/soa_server1')
set('PrefixName', 'SOATLOG1_')
set('DataSource', 'LocalSvcTblDataSource')
activate()
exit()
EOF
\`\`\`

Using a JDBC TLOG store (pointing to the Oracle database) eliminates the shared filesystem dependency and is the preferred approach in cloud and virtualized environments.

### Deployment Architecture for FMW Products

Every Oracle FMW product (SOA Suite, OSB, OIM, OAM, OHS, etc.) is deployed as one or more Java EE applications on top of WebLogic:

| FMW Product | WebLogic Applications | Key EJBs / Servlets |
|------------|----------------------|---------------------|
| SOA Suite | soa-infra, b2bui, composer | BPEL engine, Mediator, B2B |
| Oracle Service Bus | service-bus | Message pipeline engine |
| Oracle Identity Manager | oim, sysadmin, iam-consoles | Scheduler, Connector framework |
| Oracle Access Manager | oam_server | Access gate, policy engine |
| Oracle HTTP Server | Standalone process (OHS) | mod_wl_ohs proxy |

---

## Oracle Coherence

Coherence is a distributed in-memory data grid. It extends the application server tier by providing a shared memory layer that spans all JVMs in a cluster — allowing data to be stored, retrieved, and processed without going to the database for every operation.

### Coherence Cluster Architecture

\`\`\`
┌─────────────────────────────────────────────────────┐
│                  Coherence Cluster                   │
│                                                     │
│  ┌──────────────────┐    ┌──────────────────┐       │
│  │  Storage Node 1  │    │  Storage Node 2  │       │
│  │  (Managed Srvr1) │    │  (Managed Srvr2) │       │
│  │  Partition 0..127│    │  Partition 128..255│      │
│  │  + backup of     │    │  + backup of     │       │
│  │    Node 2's data │    │    Node 1's data │       │
│  └──────────────────┘    └──────────────────┘       │
│                                                     │
│  ┌──────────────────┐                               │
│  │  Extend Client   │  ← Application code running  │
│  │  (App Server)    │    outside the storage tier   │
│  └──────────────────┘                               │
└─────────────────────────────────────────────────────┘
\`\`\`

Coherence automatically partitions data across storage-enabled cluster members. Each partition is assigned to one primary member and one backup member. When a storage node fails, the remaining nodes immediately redistribute the orphaned partitions — no data is lost because the backup partitions are already held on surviving nodes.

### Coherence Deployment Modes

| Mode | Description | Use case |
|------|------------|---------|
| Embedded | Coherence runs inside the same JVM as the application | Development, single-node testing |
| Client-Server (Extend) | Application connects via TCP to a remote Coherence cluster | Production — isolates app JVM from cache JVM |
| Storage-Disabled Client | JVM joins cluster but holds no partitions | Proxy nodes, application servers |
| Storage-Enabled Member | JVM holds primary and backup partitions | Dedicated cache tier nodes |

In production FMW deployments, the recommended pattern is **client-server**: the WebLogic Managed Servers run as Coherence Extend clients, and a separate set of JVMs forms the storage-enabled Coherence cluster. This isolates cache GC pressure from application GC pressure.

### Coherence and WebLogic Integration (Coherence*Web)

Coherence*Web replaces the default WebLogic HTTP session store with a Coherence-backed distributed session store. This enables:

- **Session failover**: if a Managed Server crashes, any other server in the cluster can serve the user's next request without re-authentication
- **Zero-downtime rolling restarts**: Managed Servers can be restarted one at a time without losing active user sessions
- **Session data visibility**: sessions can be queried and inspected directly from the Coherence cache

\`\`\`xml
<!-- weblogic.xml — enable Coherence*Web session persistence -->
<session-descriptor>
  <persistent-store-type>coherence-web</persistent-store-type>
</session-descriptor>
\`\`\`

### Coherence Caches and Cache Configuration

Coherence caches are declared in \`coherence-cache-config.xml\`. Each cache has a scheme that governs eviction, expiry, backing map type, and persistence behaviour:

\`\`\`xml
<cache-config>
  <caching-scheme-mapping>
    <!-- Application data cache — 30 minute expiry -->
    <cache-mapping>
      <cache-name>app-data-*</cache-name>
      <scheme-name>distributed-expiring</scheme-name>
    </cache-mapping>

    <!-- Session cache — no expiry, controlled by application logout -->
    <cache-mapping>
      <cache-name>session-*</cache-name>
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
          <high-units>50000</high-units>
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
          <high-units>100000</high-units>
        </local-scheme>
      </backing-map-scheme>
      <autostart>true</autostart>
    </distributed-scheme>
  </caching-schemes>
</cache-config>
\`\`\`

### Near Caches

A near cache is a two-level cache: a small, fast local cache (L1) in front of the distributed Coherence cluster (L2). Applications get L1 hit rates on frequently accessed data while still benefiting from cluster-wide consistency for cache misses.

\`\`\`xml
<near-scheme>
  <scheme-name>near-reference-data</scheme-name>
  <front-scheme>
    <local-scheme>
      <high-units>1000</high-units>
      <expiry-delay>5m</expiry-delay>
    </local-scheme>
  </front-scheme>
  <back-scheme>
    <distributed-scheme>
      <scheme-ref>distributed-expiring</scheme-ref>
    </distributed-scheme>
  </back-scheme>
  <invalidation-strategy>present</invalidation-strategy>
</near-scheme>
\`\`\`

---

## WebLogic and Coherence Together: The Runtime Picture

When WebLogic and Coherence are deployed together in a production FMW environment, the runtime interaction looks like this:

\`\`\`
Client HTTP Request
        │
        ▼
Oracle HTTP Server (mod_wl_ohs)
        │  routes to cluster
        ▼
WebLogic Managed Server 1 (or 2, or N)
        │
        ├── JTA Transaction Manager ─────────────────────────┐
        │                                                     │
        ├── EJB Container                                     │
        │     └── Business Logic                             │
        │           │                                         │
        │           ├── Coherence Extend Client (L1/L2)      │
        │           │      └── Coherence Storage Cluster ─── │──► Distributed Cache
        │           │                                         │
        │           └── JDBC GridLink Datasource ─────────────┴──► Oracle RAC DB
        │
        └── JMS Subsystem (SOA/OSB messaging)
                └── XA-enrolled in the JTA transaction above
\`\`\`

The JTA transaction manager coordinates across JDBC (database) and JMS (message broker) as XA resources. Coherence deliberately sits outside XA — it uses its own optimistic locking and partition ownership model rather than two-phase commit, which is why it can deliver the throughput and scale that XA-bound resources cannot.

---

## Key Metrics to Monitor

### WebLogic

\`\`\`bash
# WLST — poll key server metrics
wlst.sh <<'EOF'
connect('weblogic', 'password', 't3://admin-host:7001')
servers = ['soa_server1', 'soa_server2']
for svr in servers:
    cd('/ServerRuntimes/' + svr)
    print('=== ' + svr + ' ===')
    print('State:', cmo.getState())
    cd('ThreadPoolRuntime/ThreadPoolRuntime')
    print('Execute threads total:', get('ExecuteThreadTotalCount'))
    print('Stuck threads:', get('StuckThreadCount'))
    print('Pending requests:', get('PendingUserRequestCount'))
    cd('../../JVMRuntime/' + svr)
    print('Heap used MB:', get('HeapSizeCurrent')//1024//1024)
    print('GC time ms:', get('GarbageCollectionTotalTimeMs'))
    cd('../..')
exit()
EOF
\`\`\`

### Coherence

\`\`\`bash
# Check Coherence cluster membership and partition distribution via JMX/WLST
wlst.sh <<'EOF'
connect('weblogic', 'password', 't3://admin-host:7001')
cd('/CoherenceClusterSystemResources/defaultCoherenceCluster/CoherenceClusterRuntime/defaultCoherenceCluster')
print('Cluster name:', get('Name'))
print('Members:', get('MemberCount'))
cd('CoherenceCacheRuntimes')
for cache in ls(returnMap='true').keys():
    cd(cache)
    print('Cache:', cache)
    print('  Size:', get('Size'))
    print('  Memory MB:', get('CacheMemoryUnits')//1024//1024 if get('CacheMemoryUnits') else 'N/A')
    cd('..')
exit()
EOF
\`\`\`

---

## Common Architecture Anti-Patterns

| Anti-pattern | Problem | Correct approach |
|-------------|---------|-----------------|
| Admin Server handling production traffic | Admin Server crash stops domain management AND application traffic | Keep Admin Server on separate host, never in load balancer pool |
| TLOG on local filesystem | Managed Server migration loses in-flight transactions | Use JDBC TLOG store on Oracle DB |
| Coherence storage-enabled in app JVM | Cache GC pauses cause application latency | Run storage tier as separate JVM set |
| Generic multi-datasource to RAC | TCP-timeout based failover (30+ seconds) | Use GridLink datasource with FAN/ONS |
| Single Work Manager for all apps | Runaway workload starves critical applications | Define separate Work Managers with capacity constraints |
| No Node Manager | Managed Servers must be restarted manually on host reboot | Install and configure Node Manager on every host |

---

## Summary

The FMW application server tier is not a single product — it is the combination of WebLogic's Jakarta EE runtime (execution, transactions, messaging, JDBC) and Coherence's distributed memory grid (session storage, data caching, near-cache acceleration). WebLogic provides the transactional correctness; Coherence provides the scale. Every FMW product from SOA Suite to Oracle Identity Manager depends on both layers being correctly sized, configured, and monitored. The runbook companion to this post walks through the step-by-step configuration of a production-ready two-node cluster covering domain creation, Coherence integration, GridLink datasources, JDBC TLOG stores, Node Manager, and the monitoring commands that keep the tier healthy.`,
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
