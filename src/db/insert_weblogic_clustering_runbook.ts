import { config } from 'dotenv';
config({ path: '.env.local' });

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL!);

const title = 'WebLogic Clustering Operations Runbook: Monitoring, Diagnostics, and Incident Response';
const slug = 'weblogic-clustering-load-balancing-monitoring-runbook';
const category = 'weblogic';

const content = `By Kenji Watanabe

A cluster health monitor that runs once and stops is not a monitor — it is a snapshot. The difference between a WebLogic environment that quietly degrades into an outage and one that surfaces problems early enough to respond is almost always a matter of what is being measured, how often, and whether the right people see it before the first user complaint arrives. This runbook is the operational counterpart to the WebLogic clustering architecture post: it covers every script, procedure, and checklist needed to run the oacore and oafm clusters as a production system rather than a configuration exercise.

---

## Prerequisites

Before running any script in this runbook, confirm the following are in place on the application tier host where you will execute WLST.

**Admin Server URL and WebLogic path**

\`\`\`bash
# Verify the Admin Server is reachable
curl -sk https://ebsapp01:7002/console/ | grep -i "weblogic"

# Locate WLST
find /u01 -name wlst.sh 2>/dev/null | head -3
# Typical EBS 12.2 location:
# /u01/oracle/middleware/oracle_common/common/bin/wlst.sh
\`\`\`

**Domain environment**

\`\`\`bash
# Source EBS run edition environment, then the WebLogic domain env
source /u01/install/APPS/EBSapps.env run
source \${EBS_DOMAIN_HOME}/bin/setDomainEnv.sh
\`\`\`

\`setDomainEnv.sh\` sets \`JAVA_HOME\`, \`CLASSPATH\`, and \`WL_HOME\`. If WLST fails to connect with \`ClassNotFoundException\`, the domain environment was not sourced correctly. Confirm \`\$EBS_DOMAIN_HOME\` is set before proceeding.

**Required permissions**

The account connecting to the Admin Server must hold the WebLogic \`Admin\` security role (or at minimum the \`Monitor\` role for read-only diagnostic scripts). On EBS, the \`weblogic\` user is the default Admin Server administrator. Store the password in a mode-400 file to avoid shell history exposure:

\`\`\`bash
echo 'your_weblogic_password' > ~/.wls_admin_pass
chmod 400 ~/.wls_admin_pass
WL_PASS=\$(cat ~/.wls_admin_pass)
\`\`\`

**Finding the target cluster name if unknown**

If you are connecting to an environment for the first time and do not know the cluster names, discover them from WLST before running any monitoring script:

\`\`\`python
connect('weblogic', 'password', 't3://ebsapp01:7001')
domainRuntime()
cd('/ClusterRuntimes')
ls()
# Output lists all cluster runtime objects, e.g.:
# oacore_cluster
# oafm_cluster
\`\`\`

Record the exact cluster names — they are case-sensitive and must match the \`target_cluster_name\` parameter in all monitoring scripts.

---

## Cluster Health Monitor Script

Save this script as \`monitor_cluster.py\` in \`/u01/app/oracle/scripts/ebs_monitor/\`.

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

### Running the script

\`\`\`bash
# Source the WebLogic domain environment
source \${EBS_DOMAIN_HOME}/bin/setDomainEnv.sh

# Run against the oacore cluster
wlst.sh monitor_cluster.py weblogic Welcome123 t3://adminhost:7001 oacore_cluster

# Run against the oafm cluster
wlst.sh monitor_cluster.py weblogic Welcome123 t3://adminhost:7001 oafm_cluster
\`\`\`

### Sample output

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

### Interpreting the output

Each column tells you something specific:

- **STATE**: \`RUNNING\` is the only healthy state. \`ADMIN\` means the server is in administration mode — it accepts only local connections for maintenance. \`STARTING\` or \`STANDBY\` are transient. \`FAILED\` or \`UNKNOWN/DOWN\` require immediate investigation.
- **JVM HEAP (MB)**: The format is used/max. A ratio above 80% sustained across multiple polling cycles indicates heap pressure. A ratio that climbs monotonically between polling cycles without decreasing indicates a memory leak or a cache that is not being evicted. Correlate with GC overhead using the diagnostic block in the next section.
- **STUCK THREADS**: Any value above zero is an incident-level signal for oacore. A stuck thread has been executing a single request for longer than 600 seconds (the WebLogic default timeout). If the count does not decrease within 10 minutes, plan for a graceful restart of the affected server.
- **HOGGING THREADS**: A count up to 2–3 on a busy EBS system during business hours is not unusual — complex reports and large concurrent program requests occasionally take longer than average. A count above 5, or a count that is increasing across consecutive polling cycles, points to a shared bottleneck: database lock, connection pool saturation, or slow external service call via ISG.

Triage priority: STUCK > hogging count rising across both nodes > hogging count elevated on one node > high heap with stable threads.

---

## Drilling Into a Flagged Server

### JVM heap diagnostic

When the monitor flags a server for high heap usage or you suspect GC pressure is contributing to stuck threads, run this block to get exact heap metrics and the GC overhead percentage:

\`\`\`python
connect('weblogic', 'password', 't3://ebsapp01:7001')
domainRuntime()
cd('ServerRuntimes/oacore_server1/JVMRuntime/JVMRuntime')
print 'Heap free (MB):  ', cmo.getHeapFreeCurrent() / (1024*1024)
print 'Heap size (MB):  ', cmo.getHeapSizeCurrent() / (1024*1024)
print 'GC overhead (%): ', cmo.getGCOverheadPercent()
\`\`\`

\`getGCOverheadPercent()\` is the fraction of elapsed wall-clock time that the JVM has spent in garbage collection. A value below 3% is normal background collection overhead. Between 3% and 5% warrants attention if it is sustained across multiple polling cycles — the JVM is spending meaningful time on GC rather than executing application code. Above 5%, throughput is visibly impacted. Above 10%, the server is in GC distress: requests queue behind GC pauses, which can artificially inflate stuck thread counts because threads appear to be running for a long time while actually paused in a GC cycle. The correct response is to increase the heap size in \`setUserOverrides.sh\` (both \`-Xms\` and \`-Xmx\`), but never increase \`-Xmx\` beyond 75% of the physical RAM available to the JVM process on that host. After increasing heap, verify that GC pause duration decreases — a larger heap delays collection but individual GC pauses may become longer if the heap is excessively large.

### Stuck thread stack traces

Once heap is ruled out as the driver, pull the stack trace of every stuck thread on the flagged server. The stack trace reveals whether the threads are blocked on a JDBC call (data source exhaustion), waiting on a remote HTTP call (ISG external service), or stuck in a synchronised block (application code deadlock):

\`\`\`python
connect('weblogic', 'password', 't3://ebsapp01:7001')
domainRuntime()
cd('ServerRuntimes/oacore_server1/ThreadPoolRuntime/ThreadPoolRuntime')
threads = cmo.getExecuteThreads()
for t in threads:
    if t.getState() == 'STUCK':
        print '--- STUCK THREAD:', t.getName()
        print t.getStackTrace()
\`\`\`

Read the stack traces from the bottom frame upward. The bottom frame is the oldest call — it shows what the thread originally entered. The top frame is where execution is currently blocked. Common patterns and their meaning:

- Stack trace ending in \`oracle.jdbc.OracleConnection.getMetaData\` or any JDBC call inside \`weblogic.jdbc.wrapper\`: the thread is blocked waiting for a database response. Cross-reference with the data source health check in the next section and with Oracle session activity in \`GV\$SESSION\`.
- Stack trace ending in \`sun.net.www.protocol.http.HttpURLConnection.getInputStream\` or a similar HTTP client method: the thread is waiting for a response from an external HTTP endpoint — typically an ISG outbound service call or a custom REST integration. Check whether the target endpoint is responding.
- Stack trace ending in \`java.util.concurrent.locks.AbstractQueuedSynchronizer.parkAndCheckInterrupt\` or similar lock primitives: the thread is blocked on a Java-level monitor, indicating application code contention. This requires application-level analysis of the synchronised code path visible in the middle frames.

### Correlating stuck threads to Oracle database sessions via ECID

WebLogic propagates an Execution Context ID (ECID) through every request, from the HTTP layer into the JDBC connection. When a stuck thread is blocked on a JDBC call, the Oracle session executing the SQL for that thread carries the ECID as the \`CLIENT_IDENTIFIER\` attribute in \`V\$SESSION\`. To find the Oracle session corresponding to a stuck thread, extract the ECID from the thread's stack trace (it appears in the \`weblogic.work.ExecuteThread\` frame as a context attribute), then query:

\`\`\`sql
SELECT
  s.sid,
  s.serial#,
  s.status,
  s.event,
  s.sql_id,
  s.wait_class,
  s.seconds_in_wait,
  s.module,
  s.client_identifier
FROM v\$session s
WHERE s.client_identifier LIKE '%<ECID_VALUE>%'
   OR s.module             LIKE '%oacore%'
ORDER BY s.seconds_in_wait DESC;
\`\`\`

If the session is waiting on \`enq: TX - row lock contention\` or \`db file sequential read\` on a hot block, the database tier — not the WebLogic tier — is the root cause of the stuck thread. The thread is stuck because it is waiting for a database operation to complete, not because of a JVM-level problem. Resolving the database bottleneck (killing the blocking session, fixing the query plan) clears the WebLogic stuck thread without requiring a managed server restart.

---

## Data Source Health Check

Connection pool exhaustion is one of the most common causes of stuck threads in EBS WebLogic clusters. When every connection in the pool is in use and new requests arrive, they queue as \`waitingForConnection\` — and threads servicing those requests remain in a hogging or stuck state until a connection is returned to the pool or the wait timeout expires. Run this check whenever stuck or hogging threads are present:

\`\`\`python
connect('weblogic', 'password', 't3://ebsapp01:7001')
domainRuntime()
cd('ServerRuntimes/oacore_server1/JDBCServiceRuntime/JDBCServiceRuntime/JDBCDataSourceRuntimeMBeans/EBSDataSource')
print 'State:          ', cmo.getState()
print 'Active:         ', cmo.getActiveConnectionsCurrentCount()
print 'Waiting:        ', cmo.getWaitingForConnectionCurrentCount()
print 'Failed Reconnect:', cmo.getFailedReserveRequestCount()
print 'Leaked:         ', cmo.getLeakedConnectionCount()
\`\`\`

Interpret each metric as follows:

- **State**: \`Running\` is healthy. \`Suspended\` means the data source was explicitly suspended — this is an administrative action, not an automatic failure. \`Overloaded\` means the pool has reached maximum capacity and is actively rejecting new connection requests. \`Unknown\` or any error state means the data source cannot reach the database.
- **Active**: The number of connections currently checked out and in use by application threads. Compare this against the \`max-capacity\` setting in \`config.xml\`. If Active equals max-capacity, the pool is exhausted.
- **Waiting**: The number of threads currently waiting for a connection. Any value above zero means the pool is saturated and requests are queueing. A Waiting count above 5 in a production environment is a critical signal — these waiting threads will become stuck threads if the wait exceeds the stuck thread timeout. The immediate mitigation is to increase \`max-capacity\`, but the root cause is almost always a long-running or blocked Oracle session that is not returning its connection.
- **Failed Reconnect**: A cumulative count of connection test failures since the server started. A non-zero and growing value means the pool is losing connections to the database and failing to re-establish them — this points to a network or Oracle listener issue, not a pool configuration problem.
- **Leaked**: Connections that were checked out but never returned within the connection leak timeout. A non-zero value indicates application code that is not closing connections — a code-level bug. Leaked connections reduce the effective pool capacity and contribute to exhaustion over time.

For a two-node EBS deployment, run this check against both \`oacore_server1\` and \`oacore_server2\` — the pool is per-managed-server, not shared across the cluster.

---

## Scheduling Continuous Monitoring

### Cron job

Add the following entry to the oracle user's crontab to run the cluster monitor every 15 minutes:

\`\`\`
# EBS WebLogic cluster health check — every 15 minutes
*/15 * * * *  EBS_ENV=/u01/install/APPS/EBSapps.env WL_ADMIN_URL=t3://adminhost:7001 /u01/app/oracle/scripts/ebs_monitor/run_cluster_monitor.sh >> /var/log/oracle/ebs_wl/cron.log 2>&1
\`\`\`

The wrapper script \`run_cluster_monitor.sh\` sources the EBS environment, calls \`wlst.sh monitor_cluster.py\` for both \`oacore_cluster\` and \`oafm_cluster\`, appends the timestamped output to the day's log file, and exits with a non-zero code if \`STATUS: WARNING\` appears in the output so that the cron email alert fires.

### Log rotation

\`\`\`
# /etc/logrotate.d/oracle-ebs-wl-monitor
/var/log/oracle/ebs_wl/*.log {
    daily
    rotate 30
    compress
    missingok
    notifempty
    dateext
    create 0640 oracle oinstall
    postrotate
        find /var/log/oracle/ebs_wl -name "*.log.*.gz" -mtime +30 -delete
    endscript
}
\`\`\`

The \`dateext\` option appends the rotation date to archived filenames, making it straightforward to retrieve the log from a specific incident date. The \`postrotate\` block removes compressed archives older than 30 days to prevent unbounded log accumulation.

### Parsing logs for alert conditions

To extract all WARNING or ERROR status lines from the past 24 hours of monitor output:

\`\`\`bash
# All warning or error lines from today's monitor log
grep -E 'STATUS: (WARNING|ERROR)|\[STUCK\]|\[HOG\]' /var/log/oracle/ebs_wl/monitor_\$(date +%Y%m%d)*.log

# Count of stuck thread events in the past week
grep -c '\[STUCK\]' /var/log/oracle/ebs_wl/monitor_\$(date +%Y%m%d --date='7 days ago')*.log \
  /var/log/oracle/ebs_wl/monitor_\$(date +%Y%m%d)*.log 2>/dev/null

# Extract server name and timestamp for every STUCK event
grep -hE '\[STUCK\]' /var/log/oracle/ebs_wl/*.log | \
  awk '{print \$1, \$2, \$3}' | sort | uniq -c | sort -rn
\`\`\`

A recurring STUCK pattern on the same server at the same time of day — for example, every morning at 08:30 when the concurrent manager scheduler fires its first batch — points to a predictable load spike rather than a random failure. That pattern calls for a pre-emptive connection pool increase or a scheduled managed server pre-warm, not an ad hoc restart.

---

## Incident Response Checklist

When a user reports that EBS is slow or unresponsive, or when the cron monitor fires a WARNING, work through the following steps in order. Do not skip to step 4 without completing steps 1–3 — the data source check in step 3 and the stuck thread stack traces in step 4 often share the same root cause, and resolving one resolves both.

1. **Run \`monitor_cluster.py\` to confirm scope.** Determine which servers are affected and whether the issue is isolated to one managed server or present across the full cluster. An issue on one server with healthy neighbours is a JVM-level problem. An issue on all servers simultaneously is a shared downstream problem — database, network, or external service.

2. **Identify affected server(s) and pending request count.** From the monitor output, note the stuck and hogging thread counts per server. Check the WebLogic server log (\`\$EBS_DOMAIN_HOME/servers/oacore_server1/logs/oacore_server1.log\`) for BEA-000394 (stuck thread) entries — these include the thread name and the request URL, which identifies what the user was doing when the thread got stuck.

3. **Check data source pool — waiting connections indicate DB bottleneck.** Run the data source health check block against all affected servers. If \`WaitingForConnectionCurrentCount\` is greater than zero on any server, the database is the bottleneck. A Waiting count above zero combined with a stuck thread count above zero is near-certain evidence that the threads are stuck waiting for database connections, not for any application-level reason.

4. **Pull stuck thread stack traces via WLST.** Run the stuck thread extraction block and capture the full output to a file for incident documentation. Read each stack trace to identify the blocking call. Group threads by the top frame — if 10 of 12 stuck threads share the same top frame (e.g., all waiting at \`oracle.jdbc.OracleConnection.prepareStatement\`), they have a single root cause.

5. **Correlate thread ECID to Oracle session via \`V\$SESSION\`.** For threads blocked on JDBC calls, find the corresponding Oracle sessions using the ECID correlation query. Look at the \`EVENT\` and \`SQL_ID\` columns. A single SQL_ID appearing in multiple sessions suggests a plan regression or statistics staleness on a table accessed by that query. The \`SECONDS_IN_WAIT\` column shows how long the session has been waiting.

6. **If DB wait confirmed: kill Oracle session or tune query.** If a blocking session is identified (another session holding a lock that the WebLogic sessions are waiting on), assess whether the blocking session can be killed. Check \`V\$SESSION\` for the blocker's \`MODULE\` and \`PROGRAM\` — if it is a long-running concurrent program or a batch job, killing it requires coordination with the business team. If the wait is \`db file sequential read\` or a CPU-heavy operation on a single SQL_ID, check for a plan change using \`DBA_HIST_SQL_PLAN\` and pin the historical good plan as an SPM baseline.

7. **If heap pressure: trigger GC, consider graceful restart.** If the JVM heap diagnostic shows GC overhead above 10% and heap free below 20%, the managed server is in GC distress. First attempt a forced GC via JMX (or through the Admin Console under the server's Monitoring > JVM tab). If heap does not recover within 5 minutes, proceed to a graceful restart: \`admanagedsrvctl.sh stop oacore_server1\` followed by \`admanagedsrvctl.sh start oacore_server1\`. Verify the server transitions through STARTING to RUNNING and that the cluster view shows it as a full member before redirecting traffic.

8. **Verify cluster rebalances after server recovery.** After the affected server returns to RUNNING state, confirm that OHS is routing traffic to it by checking the OHS access log for requests landing on the recovered server's port. Confirm that the cluster membership from \`/ClusterRuntimes/oacore_cluster\` includes the recovered server. Monitor the hogging and stuck thread counts for 15 minutes post-restart to confirm the problem is fully resolved and did not transfer to the remaining healthy servers during the outage window.

---

## Summary

- The \`monitor_cluster.py\` script provides a complete per-server view of state, JVM heap, stuck threads, and hogging threads in a single WLST connection — it is the first tool to run in any WebLogic incident.
- Stuck thread stack traces from WLST are the bridge between a WebLogic-level symptom (thread stuck) and a database-level root cause (blocked session, plan regression, pool exhaustion) — do not restart a managed server without first reading the stack traces.
- Data source pool metrics expose connection exhaustion before it becomes a stuck thread event — routine monitoring of \`WaitingForConnectionCurrentCount\` is the most effective early warning available at the WebLogic tier.
- ECID correlation between WebLogic stack traces and \`V\$SESSION\` eliminates ambiguity about whether a WebLogic incident is driven by the JVM or by the database, which determines the correct remediation path.
- Log rotation, cron scheduling, and grep-based log parsing turn this runbook from a break-fix reference into a continuous monitoring system that surfaces problems before users encounter them.`;

async function main() {
  console.log('Inserting WebLogic clustering operations runbook...');
  await sql`
    INSERT INTO posts (title, slug, category, content, published, is_premium)
    VALUES (${title}, ${slug}, ${category}, ${content}, true, true)
    ON CONFLICT (slug) DO UPDATE SET
      content    = EXCLUDED.content,
      title      = EXCLUDED.title,
      is_premium = EXCLUDED.is_premium
  `;
  console.log('Inserted/updated runbook slug:', slug);
}

main().catch(console.error);
