import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle RAC for EBS 12.2.11: Architecture, Services, and EBS-Specific Configuration',
  slug: 'oracle-ebs-12211-rac',
  excerpt:
    'A technical guide to Oracle Real Application Clusters for EBS 12.2.11: why RAC provides horizontal scalability and node-level HA at the database tier, how the EBS application tier connects to a RAC cluster via SCAN listener and database services rather than individual instance connections, TAF and FAN configuration for connection pool failover transparency, EBS-specific RAC initialization parameters, ASM disk group layout for EBS workloads, the service-based connection model that replaces direct instance connections, and how RAC interacts with Data Guard in a Maximum Availability Architecture deployment.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-29'),
  youtubeUrl: null,
  content: `## Introduction

Oracle Real Application Clusters (RAC) is the database tier high-availability and scalability technology for Oracle EBS 12.2.11 deployments that require more than a single database server can provide. Where Data Guard provides standby-based HA with automatic failover to a replica database, RAC provides active-active HA: all cluster nodes run the same database simultaneously, each serving a portion of the workload. A node failure in a RAC cluster transfers its sessions to surviving nodes with minimal disruption — no database failover, no role change, no Data Guard promotion sequence.

For EBS, RAC is the database tier architecture of choice when a single node cannot sustain the combined load of interactive Forms sessions, OAF page requests, concurrent program batch jobs, and reporting queries. It also provides node-level fault tolerance without the recovery time associated with a Data Guard failover.

This article covers the RAC architecture as it applies to EBS, the EBS-specific connection and service configuration that distinguishes an EBS RAC deployment from a generic database cluster, and the initialization parameter and storage considerations particular to EBS workloads.

---

## What RAC Adds and What It Does Not Add

RAC is a database clustering technology, not an application clustering technology. It clusters the database tier only. The EBS application tier (WebLogic, Oracle HTTP Server, Concurrent Processing Servers, Forms Server) is unaffected by RAC — it connects to the database cluster as if connecting to any other database, using the cluster's SCAN listener as the single point of contact.

**What RAC provides**:
- **Node-level HA**: A surviving RAC node continues serving database requests when another node fails. Active sessions on the failed node reconnect to a surviving node (with TAF configuration) without the application restarting.
- **Horizontal scalability**: Additional RAC nodes can be added to the cluster to handle increased database load. EBS workloads are distributed across nodes by service assignment.
- **Shared cache**: Oracle's Cache Fusion protocol synchronizes the buffer caches of all RAC nodes over the private interconnect. Any node can read or modify any database block — the cluster presents a single coherent database view regardless of which node holds a block in its cache.

**What RAC does not provide**:
- Application tier HA — the WebLogic managed servers, OHS, and Concurrent Managers are still single points of failure unless independently clustered
- Protection against storage failure — shared storage must be protected at the storage layer (ASM mirroring, SAN redundancy, or storage replication)
- Protection against full datacenter failure — for geographic DR, Data Guard combined with RAC (Extended RAC or MAA) is required

---

## RAC Architecture Components

### Oracle Grid Infrastructure (Clusterware)

Oracle Grid Infrastructure is the cluster management layer that must be installed before the database software. It provides:

**Oracle Clusterware**: the CSS (Cluster Synchronization Services), CRS (Cluster Ready Services), and EVMD (Event Management) daemons that manage cluster membership, resource availability, and event notification. Clusterware owns the SCAN listener, VIP addresses, and ASM instances.

**Automatic Storage Management (ASM)**: the volume manager and filesystem for shared database storage. ASM presents disk groups — logical storage pools — that are accessible from all RAC nodes simultaneously. The database writes directly to ASM disk groups; there is no traditional filesystem for datafiles, redo logs, or the Fast Recovery Area.

**Voting Disks and OCR**: the quorum mechanism. Voting disks (stored in ASM since Grid Infrastructure 11.2) allow nodes to resolve split-brain scenarios when the interconnect fails. The Oracle Cluster Registry (OCR) stores cluster configuration and resource definitions. Both require redundant ASM disk groups.

### SCAN Listener

The Single Client Access Name (SCAN) is a DNS name that resolves to multiple IP addresses — typically three for production clusters. Clients connect to the SCAN rather than to individual node VIPs. The SCAN listener load-balances incoming connections across nodes based on service placement and node load.

For EBS, every component that connects to the database — WebLogic JDBC data sources, tnsnames.ora entries for concurrent managers, SQL*Plus connections — should use the SCAN name as the host address. This provides:
- Location transparency: the application does not need to know which nodes are in the cluster or which node runs a particular service
- Automatic rerouting: if a SCAN listener on one node is unavailable, DNS round-robin routes to a SCAN listener on another node

### VIP Addresses

Each RAC node has a Virtual IP address in addition to its public IP. When a node fails, Clusterware relocates the VIP to another node and issues a TCP RST to any connections that were routed through the failed node's VIP. This causes TAF-enabled connection pools to immediately detect the failure and reconnect through the SCAN to a surviving node.

### Private Interconnect

The private interconnect is a dedicated, high-bandwidth, low-latency network used exclusively for Cache Fusion traffic (block-level data transfer between node buffer caches) and Clusterware heartbeats. This network must not carry application or management traffic. For production EBS RAC, the interconnect should be 25 GbE or faster with < 0.1ms latency. Interconnect congestion is the primary cause of RAC performance degradation.

---

## EBS Connection Architecture: Services, Not Instances

The most critical EBS RAC configuration decision is how the application tier connects to the database. EBS must connect via **database services**, not via the default database service or individual instance connections.

### Why Instance Connections Are Wrong for EBS

A connection string that references a specific instance (e.g., \`SERVICE_NAME=EBSPRD1\` — the per-instance service automatically created by Oracle) pins all sessions to that instance. If the instance fails, the application cannot fail over to another instance because the connection pool's session factory is bound to the dead instance's service. The SCAN provides no benefit.

### EBS Database Service Design

Create dedicated database services for each EBS functional tier. Services are cluster-aware: they can be assigned to preferred and available instances, and they travel with the cluster if an instance fails.

Recommended service layout for a two-node EBS RAC cluster:

\`\`\`
Service Name      Preferred Instance  Available Instance  Purpose
EBSPRD_APP        EBSPRD1             EBSPRD2             Forms, OAF, WebLogic connections
EBSPRD_BATCH      EBSPRD2             EBSPRD1             Concurrent Manager connections
EBSPRD_REPORT     EBSPRD2             EBSPRD1             Reporting tool connections (BI, OBIEE)
\`\`\`

With this layout, interactive EBS workload runs on node 1 by preference and batch processing runs on node 2 by preference. If either node fails, the service relocates to the surviving node automatically.

### TAF Configuration on EBS Services

Transparent Application Failover (TAF) allows an in-progress database session to transparently reconnect to a surviving instance when its current instance fails. For EBS:

- \`FAILOVER_TYPE=SELECT\`: in-flight SELECT queries are re-executed from the beginning on the new instance. Appropriate for EBS read queries.
- \`FAILOVER_TYPE=SESSION\`: the session reconnects but in-flight queries are not re-executed. The application must handle the resulting error. Appropriate for EBS DML-heavy sessions where automatic query replay would cause inconsistency.
- \`FAILOVER_RETRIES\` and \`FAILOVER_DELAY\`: control how many reconnection attempts TAF makes and how long it waits between attempts.

For EBS interactive connections, Oracle recommends TAF with FAILOVER_TYPE=SELECT and FAILOVER_RETRIES=30, FAILOVER_DELAY=5.

### Fast Application Notification (FAN) and Application Continuity

FAN events are ONS (Oracle Notification Service) messages published by Clusterware when cluster events occur — node failure, service relocation, instance start/stop. Connection pools that subscribe to FAN events can react to these events proactively rather than waiting for a TCP timeout.

WebLogic Active GridLink data sources support FAN natively. When configured with ONS subscription, the JDBC pool immediately drains connections to a failing instance and establishes connections to the surviving instance within seconds of a node failure — without waiting for TCP keepalive timeouts that can take minutes.

EBS 12.2 with WebLogic Active GridLink and FAN provides the fastest possible recovery from a RAC node failure for the connection pool layer.

---

## EBS-Specific RAC Initialization Parameters

Each RAC instance has its own SPFILE section (or a shared SPFILE with instance-specific overrides). The critical EBS RAC parameters:

### Cluster-Specific Parameters

\`\`\`sql
-- Set per-instance in SPFILE (using instance-specific notation: SID.parameter)
ALTER SYSTEM SET CLUSTER_DATABASE=TRUE SCOPE=SPFILE;

-- Instance number — must be unique per node
ALTER SYSTEM SET INSTANCE_NUMBER=1 SCOPE=SPFILE SID='EBSPRD1';
ALTER SYSTEM SET INSTANCE_NUMBER=2 SCOPE=SPFILE SID='EBSPRD2';

-- Thread number — matches instance number
ALTER SYSTEM SET THREAD=1 SCOPE=SPFILE SID='EBSPRD1';
ALTER SYSTEM SET THREAD=2 SCOPE=SPFILE SID='EBSPRD2';

-- Each instance must have its own UNDO tablespace
ALTER SYSTEM SET UNDO_TABLESPACE='UNDOTBS1' SCOPE=SPFILE SID='EBSPRD1';
ALTER SYSTEM SET UNDO_TABLESPACE='UNDOTBS2' SCOPE=SPFILE SID='EBSPRD2';
\`\`\`

### EBS Optimizer Parameters (Applied at Cluster Level)

The same EBS-specific optimizer parameters that prevent adaptive plan instability apply to RAC deployments:

\`\`\`sql
ALTER SYSTEM SET "_optimizer_adaptive_plans"=FALSE SCOPE=SPFILE;
ALTER SYSTEM SET "_optimizer_adaptive_statistics"=FALSE SCOPE=SPFILE;
ALTER SYSTEM SET "_optimizer_use_feedback"=FALSE SCOPE=SPFILE;
ALTER SYSTEM SET "_b_tree_bitmap_plans"=FALSE SCOPE=SPFILE;
ALTER SYSTEM SET CURSOR_SHARING=EXACT SCOPE=SPFILE;
\`\`\`

### SGA Sizing for RAC

In a RAC configuration, each node has its own SGA. The total memory available to the database is the sum of all node SGAs. However, Cache Fusion transfers block images across the interconnect when one node needs a block held in another node's buffer cache — so the effective buffer cache hit rate depends on both local cache hits and remote (cross-instance) access patterns.

EBS workloads typically show high session locality: a user's session touches the same set of blocks repeatedly. Assigning interactive EBS users to one instance and batch jobs to another reduces cross-instance cache traffic.

For a two-node RAC cluster on servers with 256 GB RAM each:
- SGA_TARGET per node: 160 GB (same as single-instance sizing)
- SHARED_POOL_SIZE per node: 6 GB minimum (EBS package cache is per-node)
- DB_CACHE_SIZE per node: 120 GB minimum

The SHARED_POOL in particular must be adequately sized per node — EBS PL/SQL packages are compiled into each node's shared pool independently. The \`DBMS_SHARED_POOL.KEEP\` calls to pin core EBS packages should be run once at startup (via a trigger) and take effect on each node's shared pool independently.

---

## ASM Disk Group Layout for EBS RAC

ASM provides the shared storage layer for RAC. The recommended disk group layout for an EBS RAC installation:

\`\`\`
Disk Group  Redundancy  Content                         Recommended Size
+DATA       EXTERNAL*   EBS datafiles (SYSTEM, SYSAUX,  2–4x database size
                        APPS, UNDOTBS1, UNDOTBS2,
                        tablespace datafiles)
+FRA        EXTERNAL*   Fast Recovery Area (archived    2–3x database size
                        logs, RMAN backups, flashback)
+REDO       EXTERNAL*   Online redo logs (all threads)  20–50 GB
                        Standby redo logs
\`\`\`

*EXTERNAL redundancy is used when the underlying SAN or NFS storage provides hardware-level mirroring (RAID-10 or equivalent). For environments without hardware redundancy, use NORMAL redundancy (two-way mirroring in ASM) requiring twice the raw disk capacity.

Separating redo logs into their own disk group (+REDO) is strongly recommended for EBS. EBS generates high redo volume during period-end processing, payroll runs, and large concurrent program batches. Isolating redo I/O prevents it from competing with datafile reads and writes on the +DATA disk group.

---

## RAC and Data Guard: Maximum Availability Architecture

For production EBS deployments requiring both horizontal scalability (RAC) and geographic DR (Data Guard), Oracle's Maximum Availability Architecture (MAA) combines both:

\`\`\`
Primary Site:
  RAC Node 1 (EBSPRD1) ─────┐
  RAC Node 2 (EBSPRD2) ─────┤──→ +DATA +FRA +REDO (shared ASM storage)
                             │
                      LGWR SYNC ↓
DR Site:
  Standby Node 1 (EBSPRD_STB) ──→ +DATA +FRA +REDO (standby ASM storage)
  (Physical standby, MRP0 applying redo from RAC primary)
\`\`\`

In this configuration, Data Guard ships redo from the RAC primary (from whichever node is the LGWR at any given time — both nodes ship redo to the same standby) to a single-node or RAC standby. The standby can be a single instance for cost efficiency or a two-node RAC for standby-side scalability.

---

## adop Online Patching in a RAC Environment

adop online patching is managed from a single application server but applies changes to the database that affect all RAC nodes simultaneously — as with any database change. The Edition-Based Redefinition model means that patching and cutover happen at the database level, and all RAC nodes see the edition change at the same time because the default edition is a database-level property, not a per-instance property.

One operational consideration: the adop cutover phase briefly quiesces all EBS services and switches the default database edition. Since the edition switch is a single DDL statement replicated across the cluster by Cache Fusion, all RAC instances complete the cutover together. No per-node cutover sequence is required.

---

## Summary

Oracle RAC for EBS 12.2.11 provides node-level fault tolerance and horizontal scalability at the database tier. The architecture requires Oracle Grid Infrastructure 19c for cluster management and ASM for shared storage. The critical EBS-specific configuration is service-based connectivity: EBS components must connect via named database services assigned to preferred and available instances, not via default instance services. TAF on interactive services provides session-level continuity after node failure; FAN events with WebLogic Active GridLink provide pool-level continuity within seconds.

EBS optimizer parameters (adaptive plan disables, CURSOR_SHARING=EXACT) apply identically to RAC as to single-instance. ASM disk groups should separate redo, data, and FRA to isolate EBS's high redo volume from datafile I/O. Combined with Data Guard, RAC forms the database tier of Oracle's Maximum Availability Architecture for EBS deployments that require both horizontal scale and geographic disaster recovery.

The companion runbook covers the complete sequence: Grid Infrastructure installation, ASM disk group creation, DBCA-silent RAC database creation, EBS service configuration with srvctl, TAF and FAN setup, EBS application tier AutoConfig updates, validation, and monitoring scripts for RAC service health, interconnect performance, and per-instance workload distribution.`,
};

async function main() {
  console.log('Inserting EBS RAC blog post...');
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
