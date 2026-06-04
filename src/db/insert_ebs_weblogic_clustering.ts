import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const blogPost = {
  title: 'Oracle EBS 12.2 WebLogic Clustering: Architecture, Load Balancing, and Thread Monitoring',
  slug: 'ebs-12-2-weblogic-clustering-load-balancing-monitoring',
  excerpt:
    'A deep look at how Oracle EBS 12.2 uses WebLogic clustering for high availability — covering the multi-tier architecture, HTTP and RMI load balancing strategies, stuck vs hogging thread diagnostics, and a production-ready WLST monitoring script for the EBS managed server fleet.',
  category: 'ebs-suite' as const,
  published: true,
  publishedAt: new Date('2026-06-03'),
  isPremium: false,
  youtubeUrl: null,
  content: `## Introduction

Oracle E-Business Suite 12.2 runs on a WebLogic Server domain. That is not an implementation detail — it is the foundation of every availability and performance characteristic the application tier exhibits. Understanding how WebLogic manages the EBS managed server fleet, how it balances load, and how it signals trouble through its thread pool metrics is as essential for an EBS DBA as understanding redo logs and execution plans.

This post covers the EBS 12.2 application tier structure, the WebLogic clustering model it uses, and the operational monitoring that keeps it healthy. A companion runbook (linked below) provides schedulable shell scripts, SQL queries, and a production-ready WLST health check that you can drop into a cron job today.

---

## The EBS 12.2 Application Tier File System

Oracle EBS 12.2 introduced Online Patching (adop), and with it a **dual-filesystem architecture** for application tier code. At any point in time there are two complete copies of the application tier:

| Edition | Path Variable | State |
|---|---|---|
| **Run edition** | \`\$RUN_BASE\` | Live — serving traffic right now |
| **Patch edition** | \`\$PATCH_BASE\` | Idle — receives patches via \`adop apply\` |

During an adop cycle, patches are applied to the Patch edition while the Run edition continues serving users. The \`cutover\` phase atomically switches the two — what was Patch becomes Run, and what was Run becomes Patch. This is why EBS 12.2 can patch without downtime.

### WebLogic Domain Structure

The WebLogic domain for EBS 12.2 lives under the application tier and contains all managed server configuration, startup scripts, and deployment descriptors.

\`\`\`
\$EBS_DOMAIN_HOME/
├── config/
│   ├── config.xml                    ← Domain configuration (servers, clusters, datasources)
│   └── fmwconfig/
│       └── components/OHS/           ← Oracle HTTP Server config and mod_wl_ohs.conf
├── servers/
│   ├── AdminServer/                  ← Admin Server logs, tmp, security
│   ├── oacore_server1/               ← EBS core managed server
│   ├── oafm_server1/                 ← OAF/ISG/B2B managed server
│   └── forms_server1/                ← Oracle Forms managed server
├── bin/
│   ├── setDomainEnv.sh               ← Sets JAVA_HOME, CLASSPATH, WL_HOME
│   └── setUserOverrides.sh           ← Heap, GC flags, custom JVM args (survives AutoConfig)
└── autodeploy/                       ← Auto-deployment directory
\`\`\`

### Key Managed Servers in EBS 12.2

| Managed Server | Default Port | Handles |
|---|---|---|
| **AdminServer** | 7001 | WebLogic console, domain config, WLST entry point |
| **oacore_server1** | 7201 | EBS core pages, OAF Framework, concurrent manager comms |
| **oafm_server1** | 7401 | Integrated SOA Gateway, B2B, Oracle Application Framework extensions |
| **forms_server1** | 9001 | Oracle Forms runtime (thin-client Forms applets) |

In a clustered EBS deployment, each managed server type has multiple instances across nodes: \`oacore_server1\` and \`oacore_server2\` on different hosts, both members of the \`oacore_cluster\`.

---

## The Architecture of a WebLogic Cluster in EBS

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

---

## Deep Dive: How WebLogic Handles Load Balancing

Load balancing in a WebLogic cluster distributes workloads across managed server instances so that no single node becomes a performance bottleneck. WebLogic handles this differently depending on the type of traffic.

### HTTP Request Load Balancing

HTTP requests from browsers reach OHS first. OHS uses \`mod_wl_ohs\` with a \`WebLogicCluster\` directive listing all managed server hosts and ports. Several algorithms govern how requests are routed:

**Round-Robin (Default):** The proxy rotates requests sequentially through the list of available managed servers. Each server receives an equal share of incoming requests over time. This is the default for EBS and works well when servers are homogeneous.

**Weight-Based:** When managed servers have differing hardware capabilities — a common scenario after incremental infrastructure upgrades — you can assign an execution weight to each server. A server with a weight of 2 receives twice the requests of a server with weight 1. Configure this in the WebLogic Admin Console under the cluster's load balancing settings.

**Session Affinity (Sticky Sessions):** EBS relies heavily on HTTP session state. Once a user establishes a session on \`oacore_server1\`, the load balancer directs all subsequent requests from that user to the same server. This prevents constant cross-cluster session data synchronisation. If \`oacore_server1\` becomes unavailable, WebLogic's in-memory replication mechanism allows the session to be reconstructed on a surviving node — the user may experience a brief page reload but their session data is preserved.

The \`mod_wl_ohs\` directive that controls this:

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

### Object and Remote Call Load Balancing (RMI / EJBs)

For internal tier-to-tier communication — such as an OAF page calling a business service component — WebLogic optimises traffic via the **T3 protocol**. When a client looks up a clustered object in JNDI, WebLogic returns a cluster-aware stub. This stub contains the routing logic and understands the availability of all nodes in the cluster. It load-balances subsequent method calls using round-robin or random algorithms, and handles transparent failover if an internal node disappears.

In an EBS context this matters for: concurrent manager communication with managed servers, ISG web service calls between oafm and oacore components, and AQ/JMS message consumption across cluster members.

---

## Automated Cluster Monitoring via WLST

Checking cluster health through the WebLogic Administration Console is adequate for daily spot checks but does not scale for automated monitoring or command-line triage during incidents. WLST (WebLogic Scripting Tool) provides programmatic access to every runtime MBean the Admin Server exposes.

### Stuck vs. Hogging Threads

The most operationally important metrics to monitor in the WebLogic thread pool are:

**Stuck Threads:** A thread that has been executing a single request for longer than the configured stuck thread timeout (default: 600 seconds). WebLogic marks it as stuck and logs a warning. A stuck thread count greater than zero requires immediate investigation. Threads can get stuck on: blocked JDBC calls (database lock wait), deadlocked synchronisation, hung external HTTP calls, or infinite loops in application code.

**Hogging Threads:** A thread that is taking significantly longer than average to complete its work, but has not yet exceeded the stuck thread threshold. It is actively consuming a CPU slot and preventing other requests from being served. A rising hogging thread count across multiple nodes simultaneously is an early warning of a shared downstream bottleneck — database connection pool exhaustion, a slow external API, or an under-resourced database tier.

The distinction matters operationally: stuck threads require a managed server restart if they do not clear. Hogging threads often resolve on their own once the downstream bottleneck clears, but they are the signal to investigate before stuck threads appear.

### The WLST Monitoring Script

The script below connects to the WebLogic Admin Server, navigates the \`DomainRuntime\` MBean tree, and reports state, JVM heap usage, stuck threads, and hogging threads for every member of a target cluster.

\`\`\`python
# monitor_cluster.py
# Connects to WebLogic Admin Server and reports health metrics,
# including hogging/stuck threads, for a named cluster.
# Usage: wlst.sh monitor_cluster.py [admin_url] [username] [password] [cluster_name]
import sys

# Configuration — override via command-line arguments or env vars
username            = sys.argv[1] if len(sys.argv) > 1 else 'weblogic'
password            = sys.argv[2] if len(sys.argv) > 2 else 'Welcome123'
admin_url           = sys.argv[3] if len(sys.argv) > 3 else 't3://localhost:7001'
target_cluster_name = sys.argv[4] if len(sys.argv) > 4 else 'oacore_cluster'

def report_cluster_health():
    try:
        print "----------------------------------------------------------------------"
        print "Connecting to Administration Server at " + admin_url
        print "----------------------------------------------------------------------"
        connect(username, password, admin_url)

        # Navigate to Domain Runtime to query real-time server statistics
        domainRuntime()

        # Access the Cluster Runtime MBean for our target cluster
        cd('/ClusterRuntimes/' + target_cluster_name)
        alive_nodes = cmo.getServerNames()

        print "Target Cluster : " + target_cluster_name
        print "Active Members : " + str(list(alive_nodes))
        print "----------------------------------------------------------------------"
        print "%-25s %-12s %-18s %-14s %-14s" % (
            "SERVER NAME", "STATE", "JVM HEAP (MB)", "STUCK THREADS", "HOGGING THREADS")
        print "----------------------------------------------------------------------"

        cd('/')

        stuck_total   = 0
        hogging_total = 0

        for server in alive_nodes:
            server_path = '/ServerRuntimes/' + server
            try:
                cd(server_path)
                state = cmo.getState()

                # JVM heap usage
                cd(server_path + '/JVMRuntime/JVMRuntime')
                heap_free = cmo.getHeapFreeCurrent() / (1024 * 1024)
                heap_size = cmo.getHeapSizeCurrent() / (1024 * 1024)
                heap_used = heap_size - heap_free
                heap_str  = str(int(heap_used)) + '/' + str(int(heap_size))

                # Thread pool
                cd(server_path + '/ThreadPoolRuntime/ThreadPoolRuntime')
                stuck_cnt   = cmo.getStuckThreadCount()
                hogging_cnt = cmo.getHoggingThreadCount()
                idle_cnt    = cmo.getIdleThreadCount()
                active_cnt  = cmo.getExecuteThreadTotalCount()

                stuck_total   += stuck_cnt
                hogging_total += hogging_cnt

                # Flag rows that need attention
                flag = ''
                if stuck_cnt   > 0: flag += ' [STUCK]'
                if hogging_cnt > 5: flag += ' [HOG]'

                print "%-25s %-12s %-18s %-14s %-14s%s" % (
                    server, state, heap_str,
                    str(stuck_cnt), str(hogging_cnt), flag)
                cd('/')

            except WLSTException:
                print "%-25s %-12s %-18s %-14s %-14s" % (
                    server, "UNKNOWN/DOWN", "N/A", "N/A", "N/A")
                cd('/')

        print "----------------------------------------------------------------------"
        print "TOTALS: stuck=%d  hogging=%d" % (stuck_total, hogging_total)
        print "----------------------------------------------------------------------"

        # Machine-readable summary for the shell wrapper
        if stuck_total > 0 or hogging_total > 5:
            print "STATUS: WARNING"
        else:
            print "STATUS: OK"

        disconnect()

    except Exception, e:
        print "ERROR: " + str(e)
        print "STATUS: ERROR"

report_cluster_health()
exit()
\`\`\`

### Running the Script

\`\`\`bash
# Source the WebLogic domain environment
source \$EBS_DOMAIN_HOME/bin/setDomainEnv.sh

# Run against the oacore cluster
wlst.sh monitor_cluster.py weblogic Welcome123 t3://adminhost:7001 oacore_cluster

# Run against the oafm cluster
wlst.sh monitor_cluster.py weblogic Welcome123 t3://adminhost:7001 oafm_cluster
\`\`\`

### Sample Output

\`\`\`
----------------------------------------------------------------------
Connecting to Administration Server at t3://adminhost:7001
----------------------------------------------------------------------
Target Cluster : oacore_cluster
Active Members : ['oacore_server1', 'oacore_server2']
----------------------------------------------------------------------
SERVER NAME               STATE        JVM HEAP (MB)      STUCK THREADS  HOGGING THREADS
----------------------------------------------------------------------
oacore_server1            RUNNING      1843/4096          0              1
oacore_server2            RUNNING      2011/4096          0              0
----------------------------------------------------------------------
TOTALS: stuck=0  hogging=1
----------------------------------------------------------------------
STATUS: OK
\`\`\`

---

## Key Maintenance Rules for EBS WebLogic Cluster Admins

**Homogeneous Configurations:** All managed servers within a cluster must share matching heap configurations (\`-Xms\` and \`-Xmx\`), identical patch levels, and equivalent hardware. Asymmetric nodes cause the load balancer to over-allocate work to weaker hardware, which surfaces as hogging threads on the underprovisioned servers. In EBS, heap settings should be in \`setUserOverrides.sh\` — never in the generated startup scripts that AutoConfig will overwrite.

**Monitor Hogging Threads as an Early Warning System:** A single isolated hogging thread is typically benign — a complex report, a slow EFT file generation. A rising hogging count across multiple nodes simultaneously points to a shared downstream problem: database connection pool exhaustion, a blocking lock, a slow response from an external web service invoked via ISG, or an undersized database tier. Catch it at the hogging stage and you avoid stuck threads and a managed server restart.

**Unicast Over Multicast for Cluster Messaging:** WebLogic cluster members communicate via a heartbeat and messaging protocol. Modern EBS deployments should use **Unicast** rather than the legacy Multicast protocol. Unicast does not require network-level multicast routing configuration, scales cleanly in virtualised and cloud environments, and avoids the multicast leakage issues that can appear in VLAN-segmented data centres.

**Match Thread Pool Size to Application Tier Load:** WebLogic's default execute thread count is self-tuning, but for EBS deployments where concurrent users are predictable, setting a baseline (\`-Dweblogic.threadpool.MinPoolSize\`) prevents the pool from starting too small and hogging threads appearing during the first load surge of the business day.

**Restart Strategy After Stuck Threads:** When stuck threads appear and do not clear within 10 minutes, do not attempt a graceful shutdown — it may hang. Use \`srvctl\` or \`admanagedsrvctl.sh\` with a \`kill\` option, wait for the OS process to terminate, then restart. Always investigate the alert log and managed server log for the root cause before restarting, so the problem is understood before the evidence is lost.

---

## Summary

Oracle EBS 12.2 is a WebLogic application. The dual-filesystem architecture with Run and Patch editions, the multi-tier layout behind OHS, and the managed server fleet — all of it runs on WebLogic clustering primitives. Monitoring it means monitoring the JVM heap on each managed server, the thread pool state (specifically stuck and hogging counts), the cluster membership as seen by the Admin Server, and the HTTP routing layer in OHS.

The WLST script in this post gives you a single-command view of all of that. Combined with the schedulable monitoring runbook below, you have proactive coverage that catches problems before users report them — and before a hogging thread becomes a stuck thread becomes a service outage.
`,
};

const runbookPost = {
  title: 'Oracle EBS 12.2 WebLogic Cluster Health Check Runbook',
  slug: 'ebs-12-2-weblogic-cluster-health-check-runbook',
  excerpt:
    'Runbook for monitoring Oracle EBS 12.2 WebLogic clusters — scheduled shell scripts calling WLST for thread and heap metrics, SQL queries for active sessions and datasource pool health, OHS access log analysis, and a 4-hour cron monitor with email alerting.',
  category: 'ebs-suite' as const,
  published: true,
  publishedAt: new Date('2026-06-03'),
  isPremium: true,
  youtubeUrl: null,
  content: `# Oracle EBS 12.2 WebLogic Cluster Health Check Runbook

## Overview

This runbook covers scheduled monitoring of the Oracle EBS 12.2 WebLogic application tier: managed server state, JVM heap, thread pool health, JDBC datasource pool saturation, active DB sessions, and OHS routing health.

**Assumptions:**
- EBS 12.2.x, WebLogic 12.2.1.x
- Domain home: \`\$EBS_DOMAIN_HOME\` (set in EBS environment)
- Admin Server: \`adminhost:7001\`
- Managed servers: \`oacore_server1\`, \`oacore_server2\`, \`oafm_server1\`
- Clusters: \`oacore_cluster\`, \`oafm_cluster\`
- Scripts run as \`oracle\` OS user
- WebLogic admin password stored in \`~/.wls_admin_pass\` (chmod 400)
- APPS password stored in \`~/.oracle_apps_pass\` (chmod 400)

---

## WLST Script Library

Save these scripts to \`/u01/app/oracle/scripts/ebs_monitor/\`.

### monitor_cluster.py — Cluster Thread and Heap Report

\`\`\`python
# monitor_cluster.py
# Reports state, heap, stuck threads, and hogging threads for a WebLogic cluster.
# Usage: wlst.sh monitor_cluster.py <username> <password> <admin_url> <cluster_name>
import sys

username            = sys.argv[1] if len(sys.argv) > 1 else 'weblogic'
password            = sys.argv[2] if len(sys.argv) > 2 else 'changeme'
admin_url           = sys.argv[3] if len(sys.argv) > 3 else 't3://localhost:7001'
target_cluster_name = sys.argv[4] if len(sys.argv) > 4 else 'oacore_cluster'

def report_cluster_health():
    try:
        connect(username, password, admin_url)
        domainRuntime()
        cd('/ClusterRuntimes/' + target_cluster_name)
        alive_nodes = cmo.getServerNames()

        print "CLUSTER=" + target_cluster_name
        print "MEMBERS=" + str(list(alive_nodes))
        print "%-25s|%-12s|%-18s|%-6s|%-6s|%-6s|%-6s" % (
            "SERVER", "STATE", "HEAP_USED/MAX_MB",
            "STUCK", "HOGG", "IDLE", "TOTAL")

        stuck_total   = 0
        hogging_total = 0
        down_count    = 0

        cd('/')
        for server in alive_nodes:
            sp = '/ServerRuntimes/' + server
            try:
                cd(sp)
                state = cmo.getState()

                cd(sp + '/JVMRuntime/JVMRuntime')
                heap_free = cmo.getHeapFreeCurrent() / (1024 * 1024)
                heap_size = cmo.getHeapSizeCurrent() / (1024 * 1024)
                heap_used = heap_size - heap_free
                heap_pct  = int(heap_used * 100 / heap_size) if heap_size > 0 else 0
                heap_str  = str(int(heap_used)) + '/' + str(int(heap_size)) + ' (' + str(heap_pct) + '%)'

                cd(sp + '/ThreadPoolRuntime/ThreadPoolRuntime')
                stuck   = cmo.getStuckThreadCount()
                hogging = cmo.getHoggingThreadCount()
                idle    = cmo.getIdleThreadCount()
                total   = cmo.getExecuteThreadTotalCount()

                stuck_total   += stuck
                hogging_total += hogging

                print "%-25s|%-12s|%-18s|%-6s|%-6s|%-6s|%-6s" % (
                    server, state, heap_str,
                    str(stuck), str(hogging), str(idle), str(total))
                cd('/')

            except WLSTException:
                print "%-25s|%-12s|%-18s|%-6s|%-6s|%-6s|%-6s" % (
                    server, "DOWN", "N/A", "N/A", "N/A", "N/A", "N/A")
                down_count += 1
                cd('/')

        print "TOTALS: stuck=" + str(stuck_total) + " hogging=" + str(hogging_total) + " down=" + str(down_count)

        if   stuck_total > 0 or down_count > 0: print "STATUS=CRITICAL"
        elif hogging_total > 5:                 print "STATUS=WARNING"
        else:                                   print "STATUS=OK"

        disconnect()

    except Exception, e:
        print "ERROR: " + str(e)
        print "STATUS=ERROR"

report_cluster_health()
exit()
\`\`\`

### monitor_datasources.py — JDBC Datasource Pool Health

\`\`\`python
# monitor_datasources.py
# Reports JDBC datasource connection pool capacity and waiters for all servers.
# Usage: wlst.sh monitor_datasources.py <username> <password> <admin_url>
import sys

username  = sys.argv[1] if len(sys.argv) > 1 else 'weblogic'
password  = sys.argv[2] if len(sys.argv) > 2 else 'changeme'
admin_url = sys.argv[3] if len(sys.argv) > 3 else 't3://localhost:7001'

def check_datasources():
    try:
        connect(username, password, admin_url)
        domainRuntime()

        print "%-30s|%-20s|%-6s|%-6s|%-6s|%-8s|%-8s" % (
            "DATASOURCE", "SERVER", "CAP", "ACTIVE", "FREE", "WAITERS", "FAIL_CNT")

        max_waiters = 0
        max_fails   = 0

        cd('/ServerRuntimes')
        server_list = ls(returnMap='true').keys()

        for srv in server_list:
            try:
                cd('/ServerRuntimes/' + srv + '/JDBCServiceRuntime/' + srv + '/JDBCDataSourceRuntimeMBeans')
                ds_list = ls(returnMap='true').keys()
                for ds in ds_list:
                    cd('/ServerRuntimes/' + srv + '/JDBCServiceRuntime/' + srv + '/JDBCDataSourceRuntimeMBeans/' + ds)
                    capacity      = cmo.getCurrCapacity()
                    active        = cmo.getActiveConnectionsCurrentCount()
                    available     = cmo.getNumAvailable()
                    waiters       = cmo.getWaitingForConnectionCurrentCount()
                    fail_cnt      = cmo.getConnectionsTotalCount()
                    ds_state      = cmo.getState()

                    max_waiters = max(max_waiters, waiters)
                    print "%-30s|%-20s|%-6s|%-6s|%-6s|%-8s|%-8s" % (
                        ds, srv, str(capacity), str(active), str(available),
                        str(waiters), str(fail_cnt))
                    cd('/')
            except WLSTException:
                cd('/')

        if   max_waiters > 10: print "STATUS=CRITICAL"
        elif max_waiters >  0: print "STATUS=WARNING"
        else:                  print "STATUS=OK"

        disconnect()

    except Exception, e:
        print "ERROR: " + str(e)
        print "STATUS=ERROR"

check_datasources()
exit()
\`\`\`

### monitor_server_state.py — All Managed Server States

\`\`\`python
# monitor_server_state.py
# Reports state and health of every managed server in the domain.
# Usage: wlst.sh monitor_server_state.py <username> <password> <admin_url>
import sys

username  = sys.argv[1] if len(sys.argv) > 1 else 'weblogic'
password  = sys.argv[2] if len(sys.argv) > 2 else 'changeme'
admin_url = sys.argv[3] if len(sys.argv) > 3 else 't3://localhost:7001'

def check_servers():
    try:
        connect(username, password, admin_url)
        domainRuntime()

        cd('/ServerLifeCycleRuntimes')
        server_list = ls(returnMap='true').keys()

        print "%-25s|%-15s|%-10s" % ("SERVER", "STATE", "HEALTH")

        non_running = 0
        for srv in server_list:
            cd('/ServerLifeCycleRuntimes/' + srv)
            state = cmo.getState()
            try:
                cd('/ServerRuntimes/' + srv)
                health = cmo.getHealthState().getState()
                cd('/')
            except WLSTException:
                health = 'N/A'
                cd('/')
            if state != 'RUNNING':
                non_running += 1
            print "%-25s|%-15s|%-10s" % (srv, state, str(health))

        if   non_running > 1: print "STATUS=CRITICAL"
        elif non_running > 0: print "STATUS=WARNING"
        else:                 print "STATUS=OK"

        disconnect()

    except Exception, e:
        print "ERROR: " + str(e)
        print "STATUS=ERROR"

check_servers()
exit()
\`\`\`

---

## SQL Script — EBS Session and Lock Health

Save as \`ebs_session_health.sql\`:

\`\`\`sql
-- ebs_session_health.sql
-- Queries active DB sessions, connection pool activity, and blocking locks.
-- Run as APPS user. Called by the monitoring shell script.

set lines 200 pages 100 feedback off trimspool on
col module      format a30
col action      format a25
col username    format a20
col status      format a10
col inst_id     format 99
col cnt         format 9999

prompt
prompt =============================================================================
prompt EBS WebLogic Application Tier DB Session Health
prompt Generated: &_DATE
prompt =============================================================================
prompt

-- ── [1] Active sessions by module (WebLogic datasource name) ─────────────────
prompt [1] Active Sessions by Module
prompt ---------------------------------------------------------------------------
select
  inst_id,
  module,
  status,
  count(*) as cnt
from
  gv$session
where
  type    = 'USER'
  and username is not null
group by
  inst_id, module, status
order by
  cnt desc
fetch first 20 rows only;

-- ── [2] Blocking lock chains ──────────────────────────────────────────────────
prompt
prompt [2] Blocking Lock Chains (blockers and their waiters)
prompt ---------------------------------------------------------------------------
select
  lpad(' ', 2 * level) || s.sid                        as session_tree,
  s.username,
  s.module,
  s.status,
  s.sql_id,
  s.wait_class,
  s.event,
  round(s.seconds_in_wait/60, 1)                       as wait_min
from
  gv$session s
  start with s.blocking_session is null
    and exists (select 1 from gv$session s2 where s2.blocking_session = s.sid)
  connect by prior s.sid = s.blocking_session
order by
  level, s.sid;

-- ── [3] Long-running SQL (> 5 minutes) ───────────────────────────────────────
prompt
prompt [3] Long-Running SQL from WebLogic Sessions (> 5 minutes)
prompt ---------------------------------------------------------------------------
select
  s.inst_id,
  s.sid,
  s.module,
  s.username,
  round(q.elapsed_time/1000000, 1)      as elapsed_sec,
  round(q.cpu_time/1000000, 1)          as cpu_sec,
  q.sql_id,
  substr(q.sql_text, 1, 80)             as sql_text
from
  gv$session s
  join gv$sql     q on q.sql_id    = s.sql_id
                    and q.inst_id  = s.inst_id
where
  s.type      = 'USER'
  and s.status = 'ACTIVE'
  and q.elapsed_time > 300 * 1000000    -- 5 minutes
  and s.module like '%weblogic%'
order by
  elapsed_sec desc
fetch first 20 rows only;

-- ── [4] JDBC connection pool sessions (by service name) ──────────────────────
prompt
prompt [4] EBS Service Session Counts
prompt ---------------------------------------------------------------------------
select
  service_name,
  inst_id,
  count(*) as sessions
from
  gv$session
where
  type = 'USER'
  and service_name not in ('SYS$BACKGROUND','SYS$USERS')
group by
  service_name, inst_id
order by
  sessions desc;

-- ── [5] Recent ORA- errors in DB alert for EBS connections ───────────────────
prompt
prompt [5] Recent ORA- Errors from Alert Log (last 4 hours)
prompt ---------------------------------------------------------------------------
select
  originating_timestamp,
  message_text
from
  v$diag_alert_ext
where
  originating_timestamp >= systimestamp - interval '4' hour
  and message_text like 'ORA-%'
order by
  originating_timestamp desc
fetch first 30 rows only;

prompt
prompt =============================================================================
prompt End of EBS Session Health Report
prompt =============================================================================
exit;
\`\`\`

---

## Shell Script 1 — OHS Access Log Analysis

\`\`\`bash
#!/bin/bash
# ebs_ohs_check.sh  — run as oracle on the EBS web tier
# Scans the OHS access log for HTTP 500/503 responses and slow requests.
set -euo pipefail

EBS_ENV=\${EBS_ENV:-/u01/install/APPS/EBSapps.env}
[[ -f "\${EBS_ENV}" ]] && source "\${EBS_ENV}" run 2>/dev/null || true

OHS_COMPONENT=\${OHS_COMPONENT:-ohs1}
OHS_LOG_DIR=\${EBS_DOMAIN_HOME}/config/fmwconfig/components/OHS/instances/\${OHS_COMPONENT}/logs
ACCESS_LOG=\${OHS_LOG_DIR}/access_log
ERROR_LOG=\${OHS_LOG_DIR}/error_log

echo "===== OHS Access Log Analysis: \$(date) ====="

if [[ ! -f "\${ACCESS_LOG}" ]]; then
  echo "Access log not found: \${ACCESS_LOG}"
  exit 1
fi

echo "[1] HTTP 500/503 count (last 5000 lines)"
tail -n 5000 "\${ACCESS_LOG}" | awk '\$9 ~ /^(500|503)$/ {count++} END {print count+0 " errors"}'

echo ""
echo "[2] Recent HTTP 500/503 entries"
tail -n 5000 "\${ACCESS_LOG}" | awk '\$9 ~ /^(500|503)$/' | tail -20

echo ""
echo "[3] OHS error log — mod_wl_ohs failures (last 2000 lines)"
tail -n 2000 "\${ERROR_LOG}" | grep -iE 'error|fail|refused|timeout' | tail -20 || echo "None found"

echo ""
echo "===== OHS check complete ====="
\`\`\`

---

## Shell Script 2 — Managed Server Log Scan

\`\`\`bash
#!/bin/bash
# ebs_server_log_check.sh  — scan managed server logs for errors
set -euo pipefail

EBS_ENV=\${EBS_ENV:-/u01/install/APPS/EBSapps.env}
[[ -f "\${EBS_ENV}" ]] && source "\${EBS_ENV}" run 2>/dev/null || true

DOMAIN_HOME=\${EBS_DOMAIN_HOME}
HOURS_BACK=\${1:-4}

echo "===== Managed Server Log Scan (last \${HOURS_BACK}h): \$(date) ====="

for SERVER_DIR in "\${DOMAIN_HOME}"/servers/*/; do
  SERVER_NAME=$(basename "\${SERVER_DIR}")
  LOG_FILE=\${SERVER_DIR}logs/\${SERVER_NAME}.log
  [[ ! -f "\${LOG_FILE}" ]] && continue

  echo ""
  echo "── \${SERVER_NAME} ──────────────────────────────────────────"

  # Error and critical lines in last 5000 lines
  ERROR_COUNT=$(tail -n 5000 "\${LOG_FILE}" | grep -cE '<Error>|<Critical>|STUCK|OutOfMemory|BEA-' || echo 0)
  echo "  Errors/Critical : \${ERROR_COUNT}"

  if [[ "\${ERROR_COUNT}" -gt 0 ]]; then
    tail -n 5000 "\${LOG_FILE}" | grep -E '<Error>|<Critical>|STUCK|OutOfMemory|BEA-' | tail -10
  fi

  # Stuck thread warnings
  STUCK=$(tail -n 5000 "\${LOG_FILE}" | grep -c 'STUCK' || echo 0)
  [[ "\${STUCK}" -gt 0 ]] && echo "  [WARNING] \${STUCK} stuck thread entries found"
done

echo ""
echo "===== Log scan complete ====="
\`\`\`

---

## Shell Script 3 — Main 4-Hour Monitor

This is the primary cron script. It calls the WLST scripts, the SQL script, and the OHS check, then aggregates results into a summary with email alerting.

\`\`\`bash
#!/bin/bash
# ebs_wl_monitor.sh
# Monitors the EBS 12.2 WebLogic application tier every 4 hours.
# Cron: 0 */4 * * * oracle /path/to/ebs_wl_monitor.sh >> /var/log/oracle/ebs_wl/monitor.log 2>&1
#
# Options:
#   --dry-run              Skip alerts; print only
#   --alert-email ADDR     Alert email address
#   --log-dir PATH         Log directory
#   --stuck-threshold N    Alert if stuck threads >= N (default 1)
#   --hogging-threshold N  Alert if hogging threads >= N (default 10)
#   --heap-warn PCT        Alert if heap usage > N% (default 85)

set -euo pipefail

DRY_RUN=false
ALERT_EMAIL=\${ALERT_EMAIL:-""}
LOG_DIR=\${LOG_DIR:-/var/log/oracle/ebs_wl}
STUCK_THRESHOLD=1
HOGGING_THRESHOLD=10
HEAP_WARN_PCT=85
EBS_ENV=\${EBS_ENV:-/u01/install/APPS/EBSapps.env}
ADMIN_URL=\${WL_ADMIN_URL:-t3://localhost:7001}
PASS_FILE=\${HOME}/.wls_admin_pass
APPS_PASS_FILE=\${HOME}/.oracle_apps_pass

while [[ \$# -gt 0 ]]; do
  case "\$1" in
    --dry-run)           DRY_RUN=true ;;
    --alert-email)       ALERT_EMAIL="\$2";        shift ;;
    --log-dir)           LOG_DIR="\$2";            shift ;;
    --stuck-threshold)   STUCK_THRESHOLD="\$2";    shift ;;
    --hogging-threshold) HOGGING_THRESHOLD="\$2";  shift ;;
    --heap-warn)         HEAP_WARN_PCT="\$2";      shift ;;
    *) echo "Unknown option: \$1"; exit 1 ;;
  esac
  shift
done

# ── Source EBS environment ─────────────────────────────────────────────────────
[[ -f "\${EBS_ENV}" ]] && source "\${EBS_ENV}" run 2>/dev/null || true
[[ -f "\${EBS_DOMAIN_HOME:-}/bin/setDomainEnv.sh" ]] && \
  source "\${EBS_DOMAIN_HOME}/bin/setDomainEnv.sh" 2>/dev/null || true

WLST_BIN=$(find /u01 -name wlst.sh 2>/dev/null | head -1 || echo "wlst.sh")
WL_PASS=$(cat "\${PASS_FILE}" 2>/dev/null || echo "")
APPS_PASS=$(cat "\${APPS_PASS_FILE}" 2>/dev/null || echo "")

mkdir -p "\${LOG_DIR}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOGFILE=\${LOG_DIR}/monitor_\${TIMESTAMP}.log
SUMMARY_FILE=\${LOG_DIR}/summary_\${TIMESTAMP}.txt
SCRIPT_DIR=$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)

exec > >(tee -a "\${LOGFILE}") 2>&1

echo "============================================================"
echo "EBS WebLogic Monitor — \$(date '+%Y-%m-%d %H:%M:%S')"
echo "Admin URL : \${ADMIN_URL}"
echo "Dry run   : \${DRY_RUN}"
echo "Log       : \${LOGFILE}"
echo "============================================================"

ALERTS=()

# ════════════════════════════════════════════════════════════════
# STEP 1: ALL SERVER STATES
# ════════════════════════════════════════════════════════════════
echo ""
echo "── Step 1: Managed Server States ───────────────────────────"

if [[ -n "\${WL_PASS}" ]] && [[ -f "\${SCRIPT_DIR}/monitor_server_state.py" ]]; then
  STATE_OUT=$(WL_PASS="\${WL_PASS}" "\${WLST_BIN}" "\${SCRIPT_DIR}/monitor_server_state.py" \
    weblogic "\${WL_PASS}" "\${ADMIN_URL}" 2>/dev/null || echo "STATUS=ERROR")
  echo "\${STATE_OUT}"

  WL_STATUS=$(echo "\${STATE_OUT}" | grep '^STATUS=' | cut -d= -f2)
  if [[ "\${WL_STATUS}" == "CRITICAL" ]]; then
    ALERTS+=("CRITICAL: One or more WebLogic managed servers are not RUNNING")
  elif [[ "\${WL_STATUS}" == "WARNING" ]]; then
    ALERTS+=("WARNING: A managed server is not in RUNNING state")
  elif [[ "\${WL_STATUS}" == "ERROR" ]]; then
    ALERTS+=("WARNING: Could not connect to WebLogic Admin Server at \${ADMIN_URL}")
  fi
else
  echo "[SKIP] monitor_server_state.py not found or no WL password"
fi

# ════════════════════════════════════════════════════════════════
# STEP 2: CLUSTER THREAD AND HEAP CHECK
# ════════════════════════════════════════════════════════════════
echo ""
echo "── Step 2: Cluster Thread and Heap Health ──────────────────"

for CLUSTER in oacore_cluster oafm_cluster; do
  CLUSTER_SCRIPT=\${SCRIPT_DIR}/monitor_cluster.py
  if [[ -f "\${CLUSTER_SCRIPT}" ]] && [[ -n "\${WL_PASS}" ]]; then
    echo ""
    echo "  Cluster: \${CLUSTER}"
    CLUSTER_OUT=$("\${WLST_BIN}" "\${CLUSTER_SCRIPT}" \
      weblogic "\${WL_PASS}" "\${ADMIN_URL}" "\${CLUSTER}" 2>/dev/null || echo "STATUS=ERROR")
    echo "\${CLUSTER_OUT}"

    CLUSTER_STATUS=$(echo "\${CLUSTER_OUT}" | grep '^STATUS=' | cut -d= -f2)
    STUCK_CNT=$(echo "\${CLUSTER_OUT}" | grep 'TOTALS:' | grep -oE 'stuck=[0-9]+' | cut -d= -f2 || echo 0)
    HOGG_CNT=$(echo "\${CLUSTER_OUT}" | grep 'TOTALS:' | grep -oE 'hogging=[0-9]+' | cut -d= -f2 || echo 0)

    if [[ "\${CLUSTER_STATUS}" == "CRITICAL" ]]; then
      ALERTS+=("CRITICAL: \${CLUSTER} — \${STUCK_CNT} stuck thread(s) or server(s) down")
    elif [[ "\${CLUSTER_STATUS}" == "WARNING" ]]; then
      ALERTS+=("WARNING: \${CLUSTER} — \${HOGG_CNT} hogging thread(s)")
    fi
  fi
done

# ════════════════════════════════════════════════════════════════
# STEP 3: DATASOURCE POOL HEALTH
# ════════════════════════════════════════════════════════════════
echo ""
echo "── Step 3: JDBC Datasource Pool Health ─────────────────────"

DS_SCRIPT=\${SCRIPT_DIR}/monitor_datasources.py
if [[ -f "\${DS_SCRIPT}" ]] && [[ -n "\${WL_PASS}" ]]; then
  DS_OUT=$("\${WLST_BIN}" "\${DS_SCRIPT}" weblogic "\${WL_PASS}" "\${ADMIN_URL}" 2>/dev/null || echo "STATUS=ERROR")
  echo "\${DS_OUT}"
  DS_STATUS=$(echo "\${DS_OUT}" | grep '^STATUS=' | cut -d= -f2)
  if [[ "\${DS_STATUS}" == "CRITICAL" ]]; then
    ALERTS+=("CRITICAL: JDBC datasource pool has > 10 connection waiters — pool may be exhausted")
  elif [[ "\${DS_STATUS}" == "WARNING" ]]; then
    ALERTS+=("WARNING: JDBC datasource pool has active connection waiters")
  fi
fi

# ════════════════════════════════════════════════════════════════
# STEP 4: DATABASE SESSION HEALTH
# ════════════════════════════════════════════════════════════════
echo ""
echo "── Step 4: EBS Database Session Health ─────────────────────"

SQL_SCRIPT=\${SCRIPT_DIR}/ebs_session_health.sql
if [[ -f "\${SQL_SCRIPT}" ]] && [[ -n "\${APPS_PASS}" ]]; then
  if [[ "\${DRY_RUN}" == "true" ]]; then
    echo "[DRY-RUN] Would run: sqlplus apps/*** @\${SQL_SCRIPT}"
  else
    SQL_LOG=\${LOG_DIR}/sql_\${TIMESTAMP}.log
    sqlplus -s "apps/\${APPS_PASS}@\${TWO_TASK:-}" @"\${SQL_SCRIPT}" > "\${SQL_LOG}" 2>&1 || true
    echo "[INFO] SQL report: \${SQL_LOG}"
    cat "\${SQL_LOG}"

    BLOCKING_COUNT=$(grep -c 'blocking_session' "\${SQL_LOG}" 2>/dev/null || echo 0)
    if [[ "\${BLOCKING_COUNT}" -gt 0 ]]; then
      ALERTS+=("WARNING: Blocking lock chain detected in EBS database session report")
    fi
  fi
else
  echo "[SKIP] SQL script or APPS password not available"
fi

# ════════════════════════════════════════════════════════════════
# STEP 5: OHS ACCESS LOG ERRORS
# ════════════════════════════════════════════════════════════════
echo ""
echo "── Step 5: OHS Error Check ──────────────────────────────────"

OHS_SCRIPT=\${SCRIPT_DIR}/ebs_ohs_check.sh
if [[ -f "\${OHS_SCRIPT}" ]]; then
  OHS_OUT=$(bash "\${OHS_SCRIPT}" 2>/dev/null || echo "OHS check failed")
  echo "\${OHS_OUT}"
  OHS_500=$(echo "\${OHS_OUT}" | grep '500 errors' | grep -oE '[0-9]+' | head -1 || echo 0)
  if [[ "\${OHS_500:-0}" -gt 10 ]]; then
    ALERTS+=("WARNING: \${OHS_500} HTTP 500 errors in OHS access log")
  fi
fi

# ════════════════════════════════════════════════════════════════
# STEP 6: MANAGED SERVER LOG SCAN
# ════════════════════════════════════════════════════════════════
echo ""
echo "── Step 6: Managed Server Log Scan ─────────────────────────"

LOG_SCRIPT=\${SCRIPT_DIR}/ebs_server_log_check.sh
if [[ -f "\${LOG_SCRIPT}" ]]; then
  bash "\${LOG_SCRIPT}" 4 2>/dev/null || echo "Log scan script not found"
fi

# ════════════════════════════════════════════════════════════════
# SUMMARY AND ALERT
# ════════════════════════════════════════════════════════════════
echo ""
echo "============================================================"
echo "SUMMARY — \$(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================================"

{
  echo "EBS WebLogic Monitor Summary — \$(date '+%Y-%m-%d %H:%M:%S')"
  echo "Host      : \$(hostname)"
  echo "Admin URL : \${ADMIN_URL}"
  echo ""
  if [[ \${#ALERTS[@]} -eq 0 ]]; then
    echo "STATUS: OK — no issues detected"
  else
    echo "STATUS: ALERTS DETECTED (\${#ALERTS[@]})"
    echo ""
    for ALERT in "\${ALERTS[@]}"; do
      echo "  • \${ALERT}"
    done
  fi
  echo ""
  echo "Log : \${LOGFILE}"
} | tee "\${SUMMARY_FILE}"

if [[ \${#ALERTS[@]} -gt 0 ]] && [[ -n "\${ALERT_EMAIL}" ]]; then
  SUBJECT="[EBS WL ALERT] \$(hostname) — \${#ALERTS[@]} issue(s) \$(date '+%Y-%m-%d %H:%M')"
  if command -v mailx &>/dev/null; then
    mailx -s "\${SUBJECT}" "\${ALERT_EMAIL}" < "\${SUMMARY_FILE}"
    echo "[INFO] Alert sent to \${ALERT_EMAIL}"
  elif command -v sendmail &>/dev/null; then
    { echo "Subject: \${SUBJECT}"; echo ""; cat "\${SUMMARY_FILE}"; } | sendmail "\${ALERT_EMAIL}"
  fi
fi

EXIT_CODE=0
for ALERT in "\${ALERTS[@]}"; do
  [[ "\${ALERT}" == CRITICAL* ]] && EXIT_CODE=2 && break
  EXIT_CODE=1
done

echo ""
echo "Exit code: \${EXIT_CODE}  (0=OK, 1=WARNING, 2=CRITICAL)"
exit "\${EXIT_CODE}"
\`\`\`

---

## Deployment and Cron Setup

\`\`\`bash
# Deploy all scripts
SCRIPT_DIR=/u01/app/oracle/scripts/ebs_monitor
mkdir -p "\${SCRIPT_DIR}"

# Copy shell and WLST scripts
cp ebs_wl_monitor.sh ebs_ohs_check.sh ebs_server_log_check.sh "\${SCRIPT_DIR}/"
cp monitor_cluster.py monitor_datasources.py monitor_server_state.py "\${SCRIPT_DIR}/"
cp ebs_session_health.sql "\${SCRIPT_DIR}/"

chmod 750 "\${SCRIPT_DIR}"/*.sh
chmod 640 "\${SCRIPT_DIR}"/*.py "\${SCRIPT_DIR}"/*.sql

# Password files
echo 'weblogic_password_here' > ~/.wls_admin_pass   && chmod 400 ~/.wls_admin_pass
echo 'apps_password_here'     > ~/.oracle_apps_pass  && chmod 400 ~/.oracle_apps_pass

mkdir -p /var/log/oracle/ebs_wl
chown oracle:oinstall /var/log/oracle/ebs_wl

# Add crontab entry
crontab -e -u oracle
\`\`\`

\`\`\`
# EBS WebLogic monitoring — every 4 hours
0 */4 * * *  EBS_ENV=/u01/install/APPS/EBSapps.env WL_ADMIN_URL=t3://adminhost:7001 ALERT_EMAIL=dba@example.com /u01/app/oracle/scripts/ebs_monitor/ebs_wl_monitor.sh >> /var/log/oracle/ebs_wl/cron.log 2>&1
\`\`\`

For the first run, verify the environment resolves cleanly:

\`\`\`bash
/u01/app/oracle/scripts/ebs_monitor/ebs_wl_monitor.sh --dry-run
\`\`\`

---

## Log Rotation

\`\`\`
# /etc/logrotate.d/oracle-ebs-wl-monitor
/var/log/oracle/ebs_wl/*.log {
    daily
    rotate 14
    compress
    missingok
    notifempty
    create 0640 oracle oinstall
}
\`\`\`
`,
};

async function main() {
  await db.insert(posts).values(blogPost);
  console.log('inserted:', blogPost.slug);

  await db.insert(posts).values(runbookPost);
  console.log('inserted:', runbookPost.slug);
}

main().catch(console.error);
