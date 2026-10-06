import { config } from 'dotenv';
config({ path: '.env.local' });

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL!);

const content = `By Kenji Watanabe

Every Oracle EBS 12.2 environment ships with a runtime paradox baked into its architecture: the application depends on a clustered Java application server for high availability, yet the moment that cluster becomes a black box, the DBA loses the ability to distinguish between a misbehaving managed server and a healthy one absorbing legitimate load. The clustered WebLogic tier is not complicated — it is a small number of JVMs behind a proxy — but its failure modes are subtle, and the metrics that matter are buried inside MBean trees that most monitoring tools never surface. That is the core tension this post works through: how the cluster is structured, how it distributes and replicates work, and what a competent administrator needs to watch to keep it healthy.

---

## The Architecture of a WebLogic Cluster

To understand how to monitor the cluster, you first need the structural picture. A standard EBS 12.2 multi-tier deployment breaks into distinct layers.

\`\`\`
User Requests (browser / integration)
           │
           ▼
┌──────────────────────────┐
│   Oracle HTTP Server     │  ← Presentation layer front door
│   (OHS + mod_wl_ohs)     │    SSL termination, static content
└───────────┬──────────────┘
            │ mod_wl_ohs routes by URI context
            ▼
┌──────────────────────────────────────────────────────┐
│            WebLogic Cluster                           │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐ │
│  │  oacore_1   │  │  oacore_2   │  │  oafm_1      │ │
│  │  (EBS core) │  │  (EBS core) │  │  (ISG / B2B) │ │
│  └─────────────┘  └─────────────┘  └──────────────┘ │
└──────────────────────────────────────────────────────┘
            │
            ▼
┌──────────────────────────┐
│   Oracle Database        │  ← Back end
│   (RAC or single)        │    EBS schema + SOAINFRA
└──────────────────────────┘
\`\`\`

1. **Presentation layer**: OHS receives HTTP/HTTPS requests and routes them to the WebLogic cluster via \`mod_wl_ohs\`. OHS does not run Java — it is a pure proxy at this tier.
2. **Business layer**: The WebLogic managed servers run the EBS application code. \`oacore\` handles the majority of EBS page traffic; \`oafm\` handles integration and SOA Gateway workloads.
3. **Back end**: Oracle Database handles transactional storage. WebLogic connects via Active GridLink (for RAC) or standard JDBC datasources.

The WebLogic domain lives under the application tier and contains all managed server configuration, startup scripts, and deployment descriptors. In a clustered EBS deployment, each managed server type has multiple instances across nodes: \`oacore_server1\` and \`oacore_server2\` on different hosts, both members of the \`oacore_cluster\`.

---

## How WebLogic Handles Load Balancing

Load balancing in a WebLogic cluster distributes workloads across managed server instances so that no single node becomes a performance bottleneck. WebLogic handles this differently depending on the type of traffic.

### HTTP Request Load Balancing

HTTP requests from browsers reach OHS first. OHS uses \`mod_wl_ohs\` with a \`WebLogicCluster\` directive listing all managed server hosts and ports. Several algorithms govern how requests are routed:

**Round-Robin (Default):** The proxy rotates requests sequentially through the list of available managed servers. Each server receives an equal share of incoming requests over time. This is the default for EBS and works well when servers are homogeneous.

**Weight-Based:** When managed servers have differing hardware capabilities — a common scenario after incremental infrastructure upgrades — you can assign an execution weight to each server. A server with a weight of 2 receives twice the requests of a server with weight 1. Configure this in the WebLogic Admin Console under the cluster's load balancing settings, or via WLST:

\`\`\`python
# Set server weight in WLST (run in edit mode)
connect('weblogic', 'password', 't3://ebsapp01:7001')
edit()
startEdit()
cd('/Clusters/oacore_cluster/ClusterMemberWeight/oacore_server1')
cmo.setWeight(2)
cd('/Clusters/oacore_cluster/ClusterMemberWeight/oacore_server2')
cmo.setWeight(1)
save()
activate()
\`\`\`

**Session Affinity (Sticky Sessions):** EBS relies heavily on HTTP session state. Once a user establishes a session on \`oacore_server1\`, the load balancer directs all subsequent requests from that user to the same server. This prevents constant cross-cluster session data synchronisation. If \`oacore_server1\` becomes unavailable, WebLogic's in-memory replication mechanism allows the session to be reconstructed on a surviving node — the user may experience a brief page reload but their session data is preserved.

The \`mod_wl_ohs\` directive that controls cluster routing:

\`\`\`
<IfModule weblogic_module>
  WebLogicCluster oacore1.example.com:7201,oacore2.example.com:7201
  WLLogFile       /var/log/oracle/ohs/mod_wl_ohs.log
</IfModule>

<Location /OA_HTML>
  SetHandler    weblogic-handler
  WebLogicCluster oacore1.example.com:7201,oacore2.example.com:7201
</Location>
\`\`\`

### Session Replication and the Replication Group

WebLogic in-memory replication creates a secondary copy of each session on a designated peer. The replication group configuration in \`config.xml\` controls which servers replicate to which:

\`\`\`xml
<cluster>
  <name>oacore_cluster</name>
  <replication-channel>ReplicationChannel</replication-channel>
</cluster>

<server>
  <name>oacore_server1</name>
  <replication-group>GROUP_A</replication-group>
  <preferred-secondary-group>GROUP_B</preferred-secondary-group>
</server>

<server>
  <name>oacore_server2</name>
  <replication-group>GROUP_B</replication-group>
  <preferred-secondary-group>GROUP_A</preferred-secondary-group>
</server>
\`\`\`

Grouping paired servers — where each server's preferred secondary resides on a different physical host — ensures that session failover survives a complete host failure, not just a JVM restart. This is the minimum viable replication topology for a two-node EBS cluster. For larger clusters, extend the pattern: servers on host A replicate to servers on host B, and vice versa.

### Object and Remote Call Load Balancing (RMI / EJBs)

For internal tier-to-tier communication — such as an OAF page calling a business service component — WebLogic optimises traffic via the **T3 protocol**. When a client looks up a clustered object in JNDI, WebLogic returns a cluster-aware stub. This stub contains the routing logic and understands the availability of all nodes in the cluster. It load-balances subsequent method calls using round-robin or random algorithms, and handles transparent failover if an internal node disappears.

In an EBS context this matters for: concurrent manager communication with managed servers, ISG web service calls between oafm and oacore components, and AQ/JMS message consumption across cluster members.

### Active GridLink for RAC Data Sources

When the back-end Oracle Database runs as RAC, WebLogic should use an Active GridLink (AGL) data source rather than a multi-data-source. AGL is a single logical connection pool that is aware of all RAC instances via ONS (Oracle Notification Service). When a RAC instance fails, AGL drains existing connections to that instance, uses Fast Application Notification to detect the failure, and routes new connections to surviving instances — all without requiring the application tier to be restarted.

The AGL data source entry in \`config.xml\` includes the ONS endpoints alongside the JDBC URL:

\`\`\`xml
<jdbc-data-source>
  <name>EBSDataSource</name>
  <jdbc-driver-params>
    <url>jdbc:oracle:thin:@(DESCRIPTION=
      (ADDRESS=(PROTOCOL=TCP)(HOST=rac1-vip)(PORT=1521))
      (ADDRESS=(PROTOCOL=TCP)(HOST=rac2-vip)(PORT=1521))
      (CONNECT_DATA=(SERVICE_NAME=EBSPROD)))</url>
    <driver-name>oracle.jdbc.OracleDriver</driver-name>
  </jdbc-driver-params>
  <jdbc-oracle-params>
    <fan-enabled>true</fan-enabled>
    <ons-node-list>rac1:6200,rac2:6200</ons-node-list>
  </jdbc-oracle-params>
  <jdbc-connection-pool-params>
    <initial-capacity>10</initial-capacity>
    <max-capacity>100</max-capacity>
    <test-connections-on-reserve>true</test-connections-on-reserve>
  </jdbc-connection-pool-params>
</jdbc-data-source>
\`\`\`

FAN-enabled AGL is the correct default for all EBS 12.2 deployments on RAC. The older pattern of configuring a multi-data-source with separate pools per RAC instance is still present in some environments that were cloned from older baseline builds and never updated — check the Admin Console's data source listing to confirm.

---

## Unicast vs. Multicast Cluster Messaging

WebLogic cluster members exchange heartbeats and service updates over a cluster messaging channel. Two transport options exist:

**Multicast:** The legacy default. Members broadcast discovery messages to a multicast IP address and port, and all members on that multicast group receive them. This requires network-level multicast routing to be enabled across the VLANs connecting the application tier nodes. In many modern data centres and all public cloud environments, multicast is either disabled or unavailable. Even where it works, multicast traffic can escape VLAN boundaries if the network is not carefully segmented, causing discovery noise between clusters.

**Unicast:** The modern default for EBS 12.2 deployments. Members communicate point-to-point using the listen address and a dedicated messaging port. No network-level multicast routing is required. Unicast scales cleanly in virtualised environments, works correctly in cloud VPCs, and avoids the broadcast overhead that multicast generates on large L2 segments.

The unicast configuration in \`config.xml\`:

\`\`\`xml
<cluster>
  <name>oacore_cluster</name>
  <messaging-mode>unicast</messaging-mode>
  <cluster-broadcast-channel>ClusterBroadcastChannel</cluster-broadcast-channel>
  <migration-basis>consensus</migration-basis>
</cluster>
\`\`\`

Unicast requires that all cluster members can reach each other's listen addresses on the messaging port (default 7001 range, configurable). The \`migration-basis>consensus</migration-basis\` setting is appropriate when there is no separate Node Manager network and the cluster uses server-side consensus for singletons.

Any EBS 12.2 deployment that was configured or upgraded from a pre-12.2 environment should be audited to confirm unicast is in use. Running multicast in a network environment that does not properly support it is a source of intermittent cluster split-brain events and erratic session failover behaviour.

---

## Automated Cluster Health Monitoring via WLST

Checking cluster health through the WebLogic Administration Console is adequate for daily spot checks but does not scale for automated monitoring or command-line triage during incidents. WLST (WebLogic Scripting Tool) provides programmatic access to every runtime MBean the Admin Server exposes.

The two thread-pool metrics that matter most operationally are the stuck thread count and the hogging thread count. A **stuck thread** has been executing a single request for longer than the configured stuck thread timeout (default: 600 seconds). A stuck count above zero requires immediate investigation — threads can get stuck on blocked JDBC calls, deadlocked synchronisation, hung external HTTP calls, or infinite loops in application code. A **hogging thread** is consuming a CPU execute slot significantly longer than average, but has not yet tripped the stuck threshold. Rising hogging counts across multiple nodes simultaneously are an early warning of a shared downstream bottleneck: connection pool exhaustion, a blocking database lock, or a slow external service call through ISG.

The distinction is operationally important. Stuck threads often require a managed server restart if they do not clear. Hogging threads frequently resolve on their own once the downstream bottleneck clears — but they are the signal to investigate before the situation escalates to a stuck state and a service outage.

WLST monitoring for the EBS cluster fleet involves connecting to the Admin Server, navigating the \`DomainRuntime\` MBean tree, and iterating over the \`ClusterRuntime\` membership to collect \`JVMRuntime\` heap metrics and \`ThreadPoolRuntime\` thread counts for each managed server. The full \`monitor_cluster.py\` script, running instructions, sample output, and operational log rotation procedures are all covered in the companion premium runbook below. That runbook also includes the complete cron-based scheduling setup and alert integration — everything needed to put automated monitoring into production.

If you are responding to an active incident and need the monitoring script immediately, the runbook is the right starting point. The sections below cover the diagnostic approach for drilling into a server that the monitoring script has flagged.

---

## Drilling Into a Flagged Server

When the cluster health monitor reports a non-zero stuck thread count on a specific managed server, the immediate diagnostic goal is to determine whether the stuck threads have a common root cause — a shared SQL wait, a blocked data source connection, or a single problematic request — or whether they represent independent failures.

Start with the JVM heap diagnostic to rule out memory pressure as the driver. A managed server that is in full GC more than 5% of the time will present with threads that appear stuck because they are stalled waiting for GC to complete. Run the following WLST block against the flagged server:

\`\`\`python
connect('weblogic', 'password', 't3://ebsapp01:7001')
domainRuntime()
cd('ServerRuntimes/oacore_server1/JVMRuntime/JVMRuntime')
print 'Heap free (MB):  ', cmo.getHeapFreeCurrent() / (1024*1024)
print 'Heap size (MB):  ', cmo.getHeapSizeCurrent() / (1024*1024)
print 'GC overhead (%): ', cmo.getGCOverheadPercent()
\`\`\`

GC overhead above 5% warrants scrutiny — it means the JVM is spending more than 5% of wall-clock time in garbage collection, which directly reduces throughput. Sustained overhead above 10% is a serious problem and will contribute to stuck threads. The immediate remediation is to trigger an explicit GC cycle via JMX and monitor whether heap usage recovers; the longer-term fix is to tune the heap size in \`setUserOverrides.sh\` and review whether any large cache or session object is accumulating across requests.

If heap is not the issue, the next step is to pull the stuck thread stack traces directly — which reveals whether the threads are blocked on a JDBC call (data source saturation), waiting on an external service call via ISG, or caught in a synchronised block. The full stuck thread stack trace extraction script and the procedure for correlating those stacks to Oracle database sessions via ECID are in the runbook.

---

## Summary

- **Cluster structure is the foundation**: OHS routes via \`mod_wl_ohs\`, the WebLogic cluster handles Java workloads, and Active GridLink connects to RAC. Understanding this three-tier layout is prerequisite to interpreting any health metric.
- **Unicast is the correct default**: Any environment still using multicast cluster messaging should be migrated. Multicast is a known source of intermittent cluster split-brain on virtualised and cloud-hosted infrastructure.
- **Replication groups must be cross-host**: Configuring \`preferred-secondary-group\` to point to a server on a different physical host is the minimum viable session availability guarantee. Same-host pairing defeats the purpose of in-memory replication.
- **Hogging threads are the leading indicator**: Stuck threads are the emergency; hogging threads are the warning. A DBA who monitors hogging counts proactively catches the downstream bottleneck before users experience degradation.
- **WLST is the right tool for production triage**: The Admin Console is not scriptable and does not produce output you can pipe into monitoring systems. WLST gives you the same MBean data in a form that supports automated alerting, log archival, and incident evidence collection.`;

async function main() {
  console.log('Updating WebLogic clustering blog post (id=14)...');
  await sql`UPDATE posts SET content = ${content} WHERE id = 14`;
  console.log('Updated post id=14 (slug: weblogic-clustering-load-balancing-monitoring)');
}

main().catch(console.error);
