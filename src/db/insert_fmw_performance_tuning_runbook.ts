import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Fusion Middleware Performance Tuning',
  slug: 'fusion-middleware-performance-tuning-runbook',
  excerpt:
    'Performance tuning runbook for Oracle Fusion Middleware 12c — JVM heap and GC tuning, WebLogic thread pool and Work Manager configuration, JDBC connection pool sizing, SOA Infrastructure audit level and dehydration settings, SOAINFRA schema purging and statistics, MDS caching, OS-level limits, and diagnostic tooling for identifying bottlenecks.',
  category: 'fusion-middleware' as const,
  published: true,
  publishedAt: new Date('2026-06-01'),
  youtubeUrl: null,
  content: `Performance problems in Fusion Middleware almost always trace to one of four root causes: undersized JVM heap driving excessive GC, a saturated WebLogic thread pool, a depleted JDBC connection pool, or an unchecked SOAINFRA schema that has grown to hundreds of millions of rows without purging. This runbook works through each tuning layer systematically, starting with measurement and working down from the JVM to the database.

---

## Step 0: Establish a Baseline Before Tuning

Never tune without first recording the current state. Changes that feel like improvements may actually introduce regressions in areas you did not check.

### Collect baseline metrics

\`\`\`bash
# JVM: current heap flags and GC settings
ps -ef | grep soa_server1 | grep -v grep | tr ' ' '\\n' | grep -E "Xms|Xmx|GC|Pause|Meta"

# WebLogic: thread pool state via WLST
/u01/app/oracle/product/fmw/infra/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<password>','t3://localhost:7001')
serverRuntime()
tp = cmo.getThreadPoolRuntime()
print('Threads total:    ', tp.getAllThreadsCount())
print('Threads active:   ', tp.getExecuteThreadCurrentIdleCount())
print('Threads standby:  ', tp.getStandbyThreadCount())
print('Queue length:     ', tp.getPendingUserRequestCount())
print('Throughput (req/s):', tp.getThroughput())
exit()
EOF

# SOAINFRA: row counts in hot tables
sqlplus -s FMW_SOAINFRA/<password>@fmwdb.example.com:1521/FMWDB << 'EOF'
SELECT 'CUBE_INSTANCE'    AS tbl, COUNT(*) AS rows FROM cube_instance
UNION ALL SELECT 'CUBE_SCOPE', COUNT(*) FROM cube_scope
UNION ALL SELECT 'AUDIT_TRAIL', COUNT(*) FROM audit_trail
UNION ALL SELECT 'AUDIT_DETAILS', COUNT(*) FROM audit_details
UNION ALL SELECT 'FAULT_INSTANCE', COUNT(*) FROM fault_instance
ORDER BY rows DESC;
EOF
\`\`\`

Record these numbers. Return to them after each tuning change.

---

## Part 1: JVM Tuning

### 1.1 Heap sizing

FMW managed servers have large, long-lived object graphs. Undersized heaps cause frequent GC and long pause times. Oversized heaps cause single GC cycles that pause the JVM for multiple seconds.

**Starting point guidelines:**

| Server role | Min heap (\`-Xms\`) | Max heap (\`-Xmx\`) |
|---|---|---|
| AdminServer | 512 MB | 1 GB |
| SOA managed server (light load) | 4 GB | 6 GB |
| SOA managed server (production) | 6 GB | 10 GB |
| OSB managed server | 2 GB | 4 GB |

Set \`-Xms\` equal to \`-Xmx\` in production to eliminate heap resizing pauses at startup.

Edit \`\${DOMAIN_HOME}/bin/setUserOverrides.sh\` (create if absent):

\`\`\`bash
#!/bin/bash
if [ "\${SERVER_NAME}" = "soa_server1" ]; then
  USER_MEM_ARGS="-Xms8g -Xmx8g"
  USER_MEM_ARGS="\${USER_MEM_ARGS} -XX:MetaspaceSize=512m"
  USER_MEM_ARGS="\${USER_MEM_ARGS} -XX:MaxMetaspaceSize=1g"
  USER_MEM_ARGS="\${USER_MEM_ARGS} -XX:+UseG1GC"
  USER_MEM_ARGS="\${USER_MEM_ARGS} -XX:MaxGCPauseMillis=500"
  USER_MEM_ARGS="\${USER_MEM_ARGS} -XX:G1HeapRegionSize=16m"
  USER_MEM_ARGS="\${USER_MEM_ARGS} -XX:InitiatingHeapOccupancyPercent=45"
  USER_MEM_ARGS="\${USER_MEM_ARGS} -XX:+HeapDumpOnOutOfMemoryError"
  USER_MEM_ARGS="\${USER_MEM_ARGS} -XX:HeapDumpPath=\${DOMAIN_HOME}/servers/soa_server1/logs/"
  export USER_MEM_ARGS
fi

if [ "\${SERVER_NAME}" = "AdminServer" ]; then
  USER_MEM_ARGS="-Xms1g -Xmx1g -XX:+UseG1GC -XX:MaxGCPauseMillis=500"
  export USER_MEM_ARGS
fi
\`\`\`

### 1.2 GC algorithm selection

Use **G1GC** for all FMW 12c servers on JDK 8. G1 is a region-based collector designed for large heaps (4 GB+) with predictable pause targets.

Key G1 parameters:

| Parameter | Recommended | Purpose |
|---|---|---|
| \`-XX:MaxGCPauseMillis\` | \`500\` | Target maximum GC pause. G1 adjusts region collection to meet this target. For interactive applications, lower to 200. For batch workloads, 1000 is acceptable. |
| \`-XX:G1HeapRegionSize\` | \`16m\` | Region size for heaps 8–16 GB. Default is calculated automatically but explicit control prevents thrashing on large object allocations. |
| \`-XX:InitiatingHeapOccupancyPercent\` | \`45\` | Heap fill percentage at which G1 starts a concurrent marking cycle. Default 45 is appropriate; lower it (to 35) if you see frequent Full GCs. |
| \`-XX:G1ReservePercent\` | \`15\` | Headroom reserved for promotion. Increase to 20 if you see "evacuation failure" in GC logs. |

### 1.3 Enable GC logging

GC logs are essential for diagnosing memory pressure. Without them you are guessing.

\`\`\`bash
# Add to setUserOverrides.sh within the server block
GC_LOG="\${DOMAIN_HOME}/servers/\${SERVER_NAME}/logs/gc_\$(date +%Y%m%d_%H%M).log"
USER_MEM_ARGS="\${USER_MEM_ARGS} -Xlog:gc*:file=\${GC_LOG}:time,uptime,level,tags:filecount=5,filesize=50m"
export USER_MEM_ARGS
\`\`\`

After enabling, use GC log analysis to look for:
- **Pause time spikes** above the \`MaxGCPauseMillis\` target
- **Concurrent mark failures** (logged as "to-space exhausted") indicating the heap is too small or promotion is too fast
- **Full GC events** — any Full GC in production is a problem that needs heap sizing or allocation rate investigation

### 1.4 Diagnose high GC with heap histogram

\`\`\`bash
# Live heap object histogram without a full heap dump (low overhead)
jcmd <PID_OF_SOA_SERVER1> GC.class_histogram | head -30

# Full heap dump for deep analysis (causes a stop-the-world pause)
jcmd <PID_OF_SOA_SERVER1> GC.heap_dump \${DOMAIN_HOME}/servers/soa_server1/logs/heap_\$(date +%Y%m%d).hprof
\`\`\`

---

## Part 2: WebLogic Thread Pool Tuning

### 2.1 Understanding the self-tuning thread pool

WebLogic uses a single self-tuning thread pool. It grows and shrinks automatically based on throughput. The key metric is **pending request queue length** — if this is consistently above zero, the pool is too small for the workload.

### 2.2 Thread pool monitoring via WLST

\`\`\`bash
/u01/app/oracle/product/fmw/infra/oracle_common/common/bin/wlst.sh << 'EOF'
import time
connect('weblogic','<password>','t3://localhost:8001')
serverRuntime()
for i in range(6):
    tp = cmo.getThreadPoolRuntime()
    print(time.strftime('%H:%M:%S'),
          '| total:', tp.getAllThreadsCount(),
          '| idle:', tp.getExecuteThreadCurrentIdleCount(),
          '| queue:', tp.getPendingUserRequestCount(),
          '| tput:', round(tp.getThroughput(), 1))
    time.sleep(10)
exit()
EOF
\`\`\`

If \`queue\` is consistently > 0 and \`idle\` is 0, the pool is saturated.

### 2.3 Set thread pool minimum and maximum

In Admin Console: **Environment > Servers > soa_server1 > Configuration > Tuning**

| Setting | Recommended | Notes |
|---|---|---|
| Self-Tuning Thread Pool Minimum Size | \`25\` | Default 5 is too low for SOA workloads |
| Self-Tuning Thread Pool Maximum Size | \`400\` | WLS will not grow beyond this; increase if consistently saturated |

Or via config.xml (requires restart):

\`\`\`xml
<server>
  <name>soa_server1</name>
  <self-tuning-thread-pool-size-min>25</self-tuning-thread-pool-size-min>
  <self-tuning-thread-pool-size-max>400</self-tuning-thread-pool-size-max>
</server>
\`\`\`

### 2.4 Stuck thread detection

WebLogic marks a thread "stuck" if it has been executing a request for longer than the stuck thread timeout (default: 600 seconds). Stuck threads indicate either genuinely slow external calls or deadlocks.

In Admin Console: **Environment > Servers > soa_server1 > Configuration > Tuning**:
- Stuck Thread Max Time: \`600\` (seconds — lower to 300 for interactive service tier)
- Stuck Thread Timer Interval: \`60\`

Detect stuck threads via WLST:

\`\`\`bash
/u01/app/oracle/product/fmw/infra/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<password>','t3://localhost:8001')
serverRuntime()
threads = cmo.getThreadPoolRuntime().getExecuteThreads()
for t in threads:
    if t.getStuck():
        print('STUCK:', t.getName(), '| time:', t.getCurrentRequestStartTime(), '| req:', t.getCurrentRequest())
exit()
EOF
\`\`\`

### 2.5 Work Managers for priority isolation

Work Managers partition the thread pool to prevent low-priority batch workloads from starving real-time service requests.

Example: isolate BPEL asynchronous callbacks from synchronous REST service invocations.

In Admin Console: **Deployments > soa-infra > Configuration > Work Managers > New**

\`\`\`
Work Manager: SOAAsyncWM
Max Threads Constraint: 20    (cap async work to 20 threads)
Response Time Request Class: 5000ms  (target 5 second response for async)
\`\`\`

Assign the Work Manager to the BPEL engine's async dispatch thread via the SOA MBean configuration (see Part 4).

---

## Part 3: JDBC Connection Pool Tuning

### 3.1 Connection pool sizing

Each SOA server thread that executes a BPEL dehydration, a Mediator routing step, or a Human Workflow task assignment needs a database connection. Undersized pools cause threads to queue waiting for a connection — amplifying any thread pool pressure.

**Formula:** Pool size ≈ (Thread pool maximum) × (fraction of threads doing DB work simultaneously)

For SOA Suite where most work touches the DB:

\`\`\`
Thread pool max: 400
Estimated DB-active threads at peak: 50%
Minimum pool size: 200
\`\`\`

In Admin Console: **Services > Data Sources > SOADataSource > Configuration > Connection Pool**

| Parameter | Value | Notes |
|---|---|---|
| Initial Capacity | \`25\` | Connections created at datasource startup |
| Maximum Capacity | \`200\` | Maximum open connections to the DB |
| Minimum Capacity | \`25\` | Shrink threshold — pool will not shrink below this |
| Inactive Connection Timeout | \`300\` | Reclaim idle connections after 5 min |
| Connection Timeout | \`30\` | Fail fast if DB unreachable — do not set to 0 (infinite) |
| Statement Cache Size | \`100\` | Cache prepared statements per connection; reduces parse overhead |
| Test Connections On Reserve | \`true\` | Validate connection before lending to thread |
| Test Table Name | \`SQL ISVALID\` | Lightweight Oracle-native health check |

### 3.2 Monitor connection pool state via WLST

\`\`\`bash
/u01/app/oracle/product/fmw/infra/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<password>','t3://localhost:8001')
serverRuntime()
cd('JDBCServiceRuntime/soa_server1/JDBCDataSourceRuntimeMBeans/SOADataSource')
print('Active connections:   ', get('ActiveConnectionsCurrentCount'))
print('Max active (peak):    ', get('ActiveConnectionsHighCount'))
print('Waiting threads:      ', get('WaitingForConnectionCurrentCount'))
print('Wait failures:        ', get('WaitingForConnectionFailureTotal'))
print('Leaked connections:   ', get('LeakedConnectionCount'))
exit()
EOF
\`\`\`

If \`WaitingForConnectionCurrentCount\` is ever > 0 in steady state, increase \`Maximum Capacity\`.

### 3.3 Statement cache tuning

The statement cache reduces database parse time by reusing already-parsed SQL cursors. SOAINFRA executes a high volume of parameterized SQL (dehydration inserts, instance state updates). A cache size of 50–100 per connection is appropriate.

Check shared pool hit rate in Oracle DB to confirm the cache is working:

\`\`\`sql
SELECT ROUND((1 - (phy.value / (cur.value + con.value))) * 100, 2) AS parse_hit_pct
FROM v\$sysstat phy, v\$sysstat cur, v\$sysstat con
WHERE phy.name = 'parse count (hard)'
  AND cur.name = 'parse count (total)'
  AND con.name = 'parse count (failures)';
-- Target: > 95%
\`\`\`

---

## Part 4: SOA Infrastructure Tuning

### 4.1 Audit level

The SOA audit level controls how much payload and execution data is written to the SOAINFRA database for every composite invocation. This is the single biggest performance lever in SOA Suite.

| Audit level | Description | I/O impact | Recommended for |
|---|---|---|---|
| **Off** | No audit data written | Minimal | Not recommended — no troubleshooting data |
| **Minimal** (Production) | Instance state only — no payload capture | Low | Production default |
| **Inherit** | Uses parent composite setting | Varies | — |
| **Development** | Full payload capture at every step | Very high | Development/test only — never production |

Set via EM FMW Control: **SOA > soa-infra > Administration > System MBean Browser**

Navigate to: \`oracle.as.soainfra.config > Server: soa_server1 > SoaInfraConfig > SoaInfraConfig\`

Set \`AuditLevel\` to \`Production\` (which is Oracle's label for "Minimal").

Or via WLST:

\`\`\`bash
/u01/app/oracle/product/fmw/infra/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<password>','t3://localhost:8001')
cd('oracle.as.soainfra.config:Server=soa_server1,name=SoaInfraConfig,type=SoaInfraConfig')
set('AuditLevel','Production')
exit()
EOF
\`\`\`

**Impact of switching from Development to Production audit level:** expect a 30–60% reduction in SOAINFRA write I/O and a proportional improvement in composite throughput.

### 4.2 Payload persistence for BPEL

Separately from audit level, BPEL payload persistence controls whether the process variable values are written to the audit trail at each activity. Disable for high-throughput processes where troubleshooting from payload data is not needed:

In EM: \`SoaInfraConfig\` MBean > \`PayloadValidationLevel\` → set to \`Off\`

### 4.3 BPEL synchronous thread count

The BPEL engine uses a fixed thread pool for synchronous request processing. The default is 16 threads per server, which is undersized for most production workloads.

\`\`\`bash
/u01/app/oracle/product/fmw/infra/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<password>','t3://localhost:8001')
cd('oracle.as.soainfra.bpel:Server=soa_server1,name=BPELConfig,type=BPELConfig')
print('Sync thread count:', get('SyncMaxThreads'))
set('SyncMaxThreads', 50)
print('Updated to:', get('SyncMaxThreads'))
exit()
EOF
\`\`\`

### 4.4 Dehydration chunk size

BPEL dehydrates process state to SOAINFRA in chunks. Larger chunks reduce the number of DB round-trips but increase memory usage per thread.

\`\`\`bash
/u01/app/oracle/product/fmw/infra/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<password>','t3://localhost:8001')
cd('oracle.as.soainfra.bpel:Server=soa_server1,name=BPELConfig,type=BPELConfig')
print('Dehydration chunk size:', get('DehydrationChunkSize'))
# Default is 8; increase to 16 for large variable payloads
set('DehydrationChunkSize', 16)
exit()
EOF
\`\`\`

---

## Part 5: SOAINFRA Schema Tuning

The SOAINFRA schema is the most common database-level performance bottleneck in a running SOA Suite environment. Without regular purging, tables grow unbounded and every query performs full or near-full table scans.

### 5.1 Instance purge — the most critical tuning action

Run a purge of closed instances older than 30 days:

\`\`\`sql
-- Run as FMW_SOAINFRA schema owner or DBA
BEGIN
  soa.purge_instances(
    p_max_creation_date  => SYSDATE - 30,
    p_batch_size         => 10000,
    p_retries            => 3
  );
END;
/
\`\`\`

For very large SOAINFRA tables (hundreds of millions of rows), purge in smaller time windows to control UNDO usage:

\`\`\`sql
DECLARE
  v_end DATE := SYSDATE - 30;
BEGIN
  FOR d IN 0..89 LOOP
    soa.purge_instances(
      p_max_creation_date  => v_end - d,
      p_batch_size         => 5000,
      p_retries            => 3
    );
    COMMIT;
  END LOOP;
END;
/
\`\`\`

Schedule daily via Oracle DBMS_SCHEDULER or a cron job. The purge must be an ongoing process, not a one-time catch-up.

### 5.2 Gather statistics after purge

After a large purge, the optimizer statistics are stale — the tables shrank but the stats still reflect the old row counts, causing the optimizer to choose full scans where index access is now better.

\`\`\`sql
BEGIN
  DBMS_STATS.GATHER_SCHEMA_STATS(
    ownname          => 'FMW_SOAINFRA',
    estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,
    cascade          => TRUE,
    degree           => 4,
    options          => 'GATHER AUTO'
  );
END;
/
\`\`\`

### 5.3 Key index health

Check for index fragmentation on hot SOAINFRA tables:

\`\`\`sql
-- Find unusable indexes
SELECT index_name, status
FROM dba_indexes
WHERE owner = 'FMW_SOAINFRA'
  AND status <> 'VALID'
ORDER BY index_name;

-- Rebuild unusable indexes
ALTER INDEX FMW_SOAINFRA.<index_name> REBUILD ONLINE;

-- Check index bloat on top tables
SELECT i.index_name,
       ROUND(i.leaf_blocks * 8192 / 1048576, 1) AS size_mb,
       ROUND(i.del_leaf_rows * 100.0 / NULLIF(i.leaf_rows, 0), 1) AS del_pct
FROM index_stats i
WHERE del_pct > 30;
-- Rebuild indexes with > 30% deleted rows
\`\`\`

### 5.4 CUBE_INSTANCE partition consideration

For very high-volume environments, the \`CUBE_INSTANCE\` table (central process instance registry) can be partitioned by \`CREATION_DATE\` using interval partitioning. This makes purge operations partition drops (near-instant) rather than row deletes (slow):

\`\`\`sql
-- Convert to interval-partitioned table (requires Oracle 11g+ and an outage)
-- This is a significant DBA operation — plan carefully with Oracle Support guidance
ALTER TABLE FMW_SOAINFRA.CUBE_INSTANCE MODIFY
  PARTITION BY RANGE (CREATION_DATE)
  INTERVAL (NUMTOYMINTERVAL(1,'MONTH'))
  (PARTITION p_initial VALUES LESS THAN (DATE '2026-01-01'));
\`\`\`

### 5.5 SOAINFRA AWR/ASH analysis for top SQL

\`\`\`sql
-- Top SQL by elapsed time hitting SOAINFRA tables (from AWR)
SELECT SUBSTR(sql_text, 1, 80) AS sql_preview,
       executions,
       ROUND(elapsed_time/1000000/NULLIF(executions,0), 3) AS avg_elapsed_sec,
       ROUND(buffer_gets/NULLIF(executions,0)) AS avg_lio
FROM v\$sqlarea
WHERE (UPPER(sql_text) LIKE '%CUBE_INSTANCE%'
    OR UPPER(sql_text) LIKE '%AUDIT_TRAIL%'
    OR UPPER(sql_text) LIKE '%CUBE_SCOPE%')
  AND executions > 10
ORDER BY elapsed_time DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

---

## Part 6: MDS Tuning

MDS (Metadata Services) is read frequently — every composite deployment lookup, every shared WSDL reference. Caching reduces MDS database reads significantly.

### 6.1 Enable MDS caching

In Admin Console or via config.xml, verify the MDS cache is enabled on the datasource:

\`\`\`bash
/u01/app/oracle/product/fmw/infra/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<password>','t3://localhost:8001')
cd('oracle.mds.config:Server=soa_server1,name=MDSConfig,type=MDSConfig')
print('Cache enabled:', get('CacheEnabled'))
print('Cache size (MB):', get('CacheMaxSize'))
set('CacheEnabled', 'true')
set('CacheMaxSize', 512)
exit()
EOF
\`\`\`

### 6.2 MDS namespace isolation

In multi-application environments, isolating MDS namespaces prevents one application's metadata changes from invalidating the cache entries of other applications. Each application should use its own MDS partition.

---

## Part 7: OS-Level Tuning

### 7.1 File descriptor limits

WebLogic opens a file descriptor for every socket connection (HTTP clients, DB connections, cluster messaging), every open log file, and every JMS file store page. Default OS limits (1024 per process) are far too low.

\`\`\`bash
# Check current limits for the oracle user
ulimit -n      # open files
ulimit -u      # max processes/threads

# Set permanent limits in /etc/security/limits.conf (as root):
cat >> /etc/security/limits.conf << 'EOF'
oracle soft nofile 65536
oracle hard nofile 65536
oracle soft nproc  16384
oracle hard nproc  16384
EOF

# Apply immediately (re-login or):
ulimit -n 65536
ulimit -u 16384

# Verify (must be checked as oracle user after re-login)
ulimit -Hn
ulimit -Sn
\`\`\`

### 7.2 TCP tuning for high connection count

\`\`\`bash
# Add to /etc/sysctl.conf (as root)
net.ipv4.tcp_fin_timeout = 30
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_intvl = 60
net.ipv4.tcp_keepalive_probes = 5
net.core.somaxconn = 4096
net.ipv4.tcp_max_syn_backlog = 4096
net.core.netdev_max_backlog = 4096

sysctl -p
\`\`\`

\`tcp_fin_timeout = 30\` is important for WebLogic environments with high HTTP request rates — sockets in TIME_WAIT state are released in 30 seconds instead of the default 60, reducing ephemeral port exhaustion.

### 7.3 Transparent Huge Pages (THP) — disable for JVM workloads

THP causes unpredictable GC pause spikes by triggering kernel memory compaction during GC cycles.

\`\`\`bash
# Check current setting
cat /sys/kernel/mm/transparent_hugepage/enabled
# If output shows [always], disable it:

# Disable immediately
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# Make persistent (add to /etc/rc.d/rc.local or use a systemd unit):
cat >> /etc/rc.d/rc.local << 'EOF'
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag
EOF
chmod +x /etc/rc.d/rc.local
\`\`\`

### 7.4 JVM thread stack size

Each WebLogic thread allocates stack space. For a server with 400 threads, the default 512KB stack means 200 MB of virtual memory for stacks alone. Reduce to 256KB for FMW environments where deep recursive call stacks are not expected:

\`\`\`bash
# In setUserOverrides.sh
USER_MEM_ARGS="\${USER_MEM_ARGS} -Xss256k"
\`\`\`

---

## Part 8: Diagnosing Performance Problems in Production

### 8.1 Thread dump analysis

Thread dumps reveal whether the thread pool is blocked on I/O, lock contention, or external calls.

\`\`\`bash
# Capture 3 thread dumps 10 seconds apart
PID=\$(ps -ef | grep soa_server1 | grep -v grep | awk '{print \$2}')
for i in 1 2 3; do
  jstack \${PID} > /tmp/tdump_\${i}_\$(date +%H%M%S).txt
  sleep 10
done

# Count thread states across all three dumps
grep -h "java.lang.Thread.State" /tmp/tdump_*.txt | sort | uniq -c | sort -rn
\`\`\`

Common patterns and diagnoses:

| Thread state pattern | Diagnosis |
|---|---|
| Many threads in \`BLOCKED\` on same monitor | Lock contention — identify the lock object and the thread holding it |
| Many threads in \`WAITING\` on \`execute_thread_pool\` | Healthy idle threads — no problem |
| Many threads in \`RUNNABLE\` inside DB driver code | JDBC pool exhaustion or slow DB |
| Many threads in \`RUNNABLE\` inside socket read | Slow or unresponsive upstream service |
| \`ExecuteThread\` threads with same stack, different counts | Repeated pattern of slow operation |

### 8.2 SOA composite throughput monitoring

\`\`\`sql
-- Composite throughput: instances per minute in the last hour
SELECT composite_name,
       COUNT(*) AS instances,
       ROUND(COUNT(*) / 60.0, 2) AS per_minute,
       SUM(CASE WHEN state = 2 THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN state = 4 THEN 1 ELSE 0 END) AS faulted,
       ROUND(AVG(CASE WHEN state = 2
                      THEN (last_update_time - creation_date) * 86400
                      END), 1) AS avg_duration_sec
FROM cube_instance
WHERE creation_date > SYSDATE - 1/24
GROUP BY composite_name
ORDER BY instances DESC;
\`\`\`

### 8.3 Identify slow database queries from SOA

\`\`\`sql
-- Active sessions from the SOA datasource user right now
SELECT s.sid, s.serial#, s.status, s.event, s.wait_class,
       s.seconds_in_wait, SUBSTR(q.sql_text, 1, 100) AS sql_text
FROM v\$session s
LEFT JOIN v\$sql q ON s.sql_id = q.sql_id AND s.sql_child_number = q.child_number
WHERE s.username = 'FMW_SOAINFRA'
  AND s.status = 'ACTIVE'
ORDER BY s.seconds_in_wait DESC;
\`\`\`

---

## Performance Tuning Quick Reference

\`\`\`
Layer           | Key setting                        | Default     | Recommended
----------------|-------------------------------------|-------------|------------------
JVM heap        | -Xms / -Xmx                        | 512m / 512m | 8g / 8g (SOA)
GC algorithm    | -XX:+UseG1GC                       | (varies)    | Always G1 for FMW
GC pause target | -XX:MaxGCPauseMillis               | 200         | 500 (SOA)
Thread pool min | SelfTuningThreadPoolSizeMin        | 5           | 25
Thread pool max | SelfTuningThreadPoolSizeMax        | 400         | 400
JDBC max pool   | MaxCapacity on SOADataSource       | 15          | 200
JDBC stmt cache | StatementCacheSize                 | 10          | 100
SOA audit level | AuditLevel MBean                   | Development | Production
BPEL sync thds  | SyncMaxThreads MBean               | 16          | 50
File descriptors| ulimit -n                          | 1024        | 65536
THP             | /sys/kernel/mm/transparent_hugepage| always      | never
SOAINFRA purge  | soa.purge_instances()              | (none)      | Daily, 30-day retention
\`\`\`

---

## Performance Tuning Checklist

- [ ] GC log enabled and baseline GC pause times recorded
- [ ] JVM heap set to minimum 4 GB, Xms == Xmx in production
- [ ] G1GC enabled with MaxGCPauseMillis=500
- [ ] MetaspaceSize set explicitly to prevent unbounded growth
- [ ] Thread pool minimum raised to 25
- [ ] Thread dump taken and no chronic BLOCKED threads identified
- [ ] JDBC Maximum Capacity set to match expected concurrent DB threads
- [ ] Statement cache size set to 100
- [ ] Test connections on reserve enabled
- [ ] SOA audit level confirmed as Production (not Development)
- [ ] BPEL SyncMaxThreads raised from default 16
- [ ] SOAINFRA row count checked — purge schedule in place
- [ ] SOAINFRA statistics gathered after any large purge
- [ ] Unusable indexes identified and rebuilt
- [ ] File descriptor limit raised to 65536 for oracle user
- [ ] Transparent Huge Pages disabled
- [ ] TCP fin_timeout reduced to 30
- [ ] MDS cache enabled`,
};

async function main() {
  console.log('Inserting FMW performance tuning runbook...');
  await db.insert(posts).values(post).onConflictDoNothing();
  console.log(`Inserted: "${post.title}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
