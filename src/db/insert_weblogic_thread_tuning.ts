import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'WebLogic Thread Tuning: Diagnosing Hogging and Stuck Threads on the iStore DMZ Server',
  slug: 'weblogic-thread-tuning-istore-dmz',
  excerpt:
    'How to detect, diagnose, and resolve hogging threads and stuck threads in WebLogic Server — covering thread dump analysis, WLST monitoring scripts, execute queue configuration, and right-sizing the default thread count for an EBS iStore server hosted in the DMZ.',
  category: 'weblogic' as const,
  published: true,
  publishedAt: new Date('2026-06-02'),
  isPremium: false,
  youtubeUrl: null,
  content: `Thread exhaustion is one of the most common causes of WebLogic Server performance degradation in Oracle E-Business Suite deployments. When the iStore managed server — typically isolated in a DMZ — starts returning slow responses or HTTP 503 errors under normal load, hogging or stuck threads are the first thing to rule out.

This post covers how to identify both thread conditions, interpret thread dumps, and tune the execute thread pool to handle iStore workloads reliably.

---

## Understanding the Two Thread Conditions

WebLogic's self-tuning thread pool monitors thread health continuously. It classifies threads two ways:

### Hogging Threads

A thread is marked **hogging** when it holds the execute thread for longer than the configured threshold (default: 600 seconds) without yielding. The thread is still running — it has not blocked — but it is monopolising a slot in the pool.

Common iStore causes:
- A slow database query or PL/SQL call waiting on an Oracle lock
- An HTTP call from iStore to an external payment gateway or tax engine with no read timeout configured
- Large XML/XSLT rendering for a catalog page with thousands of items
- Poorly optimised custom OAF controller performing in-memory sorting

### Stuck Threads

A thread is **stuck** when it has been in the same state longer than the stuck thread max time (default: 600 seconds). Unlike a hogging thread, a stuck thread is typically blocked waiting on a resource — a JDBC connection, a remote socket, a JMS message, or a file lock.

WebLogic considers a server **unhealthy** once the ratio of stuck threads to total threads crosses a threshold. When all threads are stuck, the server stops accepting new requests entirely — from the load balancer's perspective it looks like a crash.

---

## Step 1: Confirm Thread Problems Are Occurring

### WebLogic Admin Console

Navigate to **Domain → Environment → Servers → istore_server1 → Monitoring → Threads**:

- **Hogging Thread Count** — threads currently over the threshold
- **Stuck Thread Count** — threads currently stuck
- **Execute Thread Total Count** — pool size
- **Execute Thread Idle Count** — available threads; if this is near zero under normal load, the pool is undersized

If both idle count is low and stuck/hogging counts are elevated, you have a thread exhaustion problem.

### WLST Real-Time Monitor

Connect to the iStore Admin Server and poll thread state:

\`\`\`python
# connect_wlst_threads.py — run with: wlst.sh connect_wlst_threads.py
import time

adminUrl  = 't3://istore-dmz-admin:7001'
adminUser = 'weblogic'
adminPass = 'your_password'
serverName = 'istore_server1'
interval   = 30  # seconds between polls

connect(adminUser, adminPass, adminUrl)
domainRuntime()

def poll_threads():
    cd('/ServerRuntimes/' + serverName + '/ThreadPoolRuntime/ThreadPoolRuntime')
    total    = get('ExecuteThreadTotalCount')
    idle     = get('ExecuteThreadIdleCount')
    hogging  = get('HoggingThreadCount')
    stuck    = get('StuckThreadCount')
    pending  = get('PendingUserRequestCount')
    print('%s  total=%d  idle=%d  hogging=%d  stuck=%d  pending=%d' %
          (time.strftime('%H:%M:%S'), total, idle, hogging, stuck, pending))

while True:
    poll_threads()
    time.sleep(interval)
\`\`\`

Run this during a slow period and watch whether idle drops to zero before response times climb. Pending request count accumulating while idle is zero confirms thread starvation.

### Check WebLogic Server Log

Stuck threads generate a log entry every time the check interval fires:

\`\`\`
<BEA-000337> <[STUCK] ExecuteThread: '15' for queue: 'weblogic.kernel.Default (self-tuning)'>
<BEA-000339> <Server health changed to FAILED. There are 10 stuck threads in the default execute queue.>
\`\`\`

\`\`\`bash
# Pull stuck thread warnings from the server log
grep -E 'BEA-000337|BEA-000339' \
  /u01/app/oracle/middleware/user_projects/domains/EBS_domain/servers/istore_server1/logs/istore_server1.log \
  | tail -50
\`\`\`

---

## Step 2: Capture a Thread Dump

A thread dump is the definitive diagnostic tool. Take **three dumps, 10 seconds apart**, during the problem window. A single dump shows state; three consecutive dumps show which threads are progressing and which are genuinely blocked.

### Method 1: Admin Console

**Domain → Environment → Servers → istore_server1 → Monitoring → Threads → Dump Thread Stacks**

### Method 2: WLST

\`\`\`python
connect('weblogic', 'your_password', 't3://istore-dmz-admin:7001')
serverRuntime = getMBean('/ServerRuntimes/istore_server1')
print(serverRuntime.dumpThreads())
\`\`\`

### Method 3: OS-Level (JVM)

\`\`\`bash
# Find the WebLogic JVM PID for istore_server1
ps -ef | grep istore_server1 | grep -v grep

# Send SIGQUIT — JVM writes thread dump to stdout (captured in nohup.out or wrapper log)
kill -3 <pid>

# With JDK: use jstack for cleaner output
jstack -l <pid> > /tmp/istore_thread_dump_$(date +%H%M%S).txt
\`\`\`

---

## Step 3: Interpret the Thread Dump

Each thread entry follows this structure:

\`\`\`
"[STUCK] ExecuteThread: '15' for queue: 'weblogic.kernel.Default (self-tuning)'" daemon prio=1 tid=0x... nid=0x... waiting for monitor entry [0x...]
   java.lang.Thread.State: BLOCKED (on object monitor)
        at oracle.jdbc.driver.OracleResultSetImpl.next(OracleResultSetImpl.java:363)
        - waiting to lock <0x...> (a oracle.jdbc.driver.T4CConnection)
        at com.sun.jndi.ldap.Connection.readReply(Connection.java:459)
        ...
\`\`\`

### Key patterns to look for

**JDBC connection wait — pool exhaustion:**
\`\`\`
waiting to lock <0x...> (a oracle.jdbc.driver.T4CConnection)
at weblogic.jdbc.common.internal.ConnectionEnv.setup(ConnectionEnv.java:...)
\`\`\`
→ The data source pool is too small. Threads queue for a connection. Fix: increase \`MaxCapacity\` on the JDBC data source.

**Stuck on external HTTP call — missing timeout:**
\`\`\`
java.lang.Thread.State: WAITING
at java.net.SocketInputStream.read(SocketInputStream.java:...)
at oracle.apps.ibe.store.HttpUtil.callPaymentGateway(HttpUtil.java:...)
\`\`\`
→ iStore is waiting indefinitely for a response from an external endpoint. Fix: set \`sun.net.client.defaultReadTimeout\` JVM argument and add connection timeouts to the HTTP client.

**Lock contention — multiple threads waiting on the same monitor:**
\`\`\`
"[STUCK] ExecuteThread: '15'" - waiting to lock <0x00000006a3c12340>
"[STUCK] ExecuteThread: '16'" - waiting to lock <0x00000006a3c12340>
"[STUCK] ExecuteThread: '17'" - waiting to lock <0x00000006a3c12340>
\`\`\`
→ One thread holds a lock that all others are blocked on. Find the thread that **owns** \`0x00000006a3c12340\` — that is the root cause thread.

**Healthy thread — for comparison:**
\`\`\`
"ExecuteThread: '3' for queue: 'weblogic.kernel.Default (self-tuning)'" daemon prio=1
   java.lang.Thread.State: WAITING (parking)
        at sun.misc.Unsafe.park(Native Method)
        - parking to wait for  <...> (a java.util.concurrent.locks.AbstractQueuedSynchronizer$ConditionObject)
\`\`\`
→ Idle thread parked waiting for work. This is normal.

---

## Step 4: Increase the Thread Count

WebLogic's self-tuning pool adjusts its size automatically, but it has a **minimum** that you can set. The pool grows by adding threads when throughput improves, and shrinks when threads are idle — but it never drops below the minimum.

For an iStore DMZ server handling EBS catalog browsing and checkout flows, the default minimum of 25 threads is almost always too low under concurrent user load.

### Calculate the right minimum

Use the formula:

\`\`\`
min_threads = (avg_concurrent_users × avg_request_duration_seconds) / target_response_time_seconds + buffer
\`\`\`

For an iStore server with:
- 200 concurrent sessions
- Average request duration of 0.5 seconds
- Target response time of 2 seconds
- 20% buffer

\`\`\`
min_threads = (200 × 0.5) / 2 × 1.20 = 60
\`\`\`

Start at 75 for a production iStore DMZ server and tune down if CPU headroom is limited.

### Set via Admin Console

**Domain → Environment → Servers → istore_server1 → Configuration → Tuning**

| Parameter | Default | Recommended (iStore DMZ) |
|---|---|---|
| Self Tuning Thread Pool Minimum Size | 25 | 75 |
| Self Tuning Thread Pool Maximum Size | 400 | 400 |
| Stuck Thread Max Time (seconds) | 600 | 300 |
| Stuck Thread Timer Interval (seconds) | 60 | 30 |

Reducing stuck thread max time to 300 seconds means WebLogic detects and reports stuck threads sooner, giving you more time to react before the server is marked unhealthy.

### Set via WLST (scriptable, recommended for consistency across environments)

\`\`\`python
# set_thread_pool.py
connect('weblogic', 'your_password', 't3://istore-dmz-admin:7001')
edit()
startEdit()

cd('/Servers/istore_server1/SelfTuning/istore_server1')
set('MinThreadsConstraintCount', 75)

cd('/Servers/istore_server1')
set('StuckThreadMaxTime', 300)
set('StuckThreadTimerInterval', 30)

activate()
disconnect()
\`\`\`

### Set via config.xml (for version-controlled deployments)

Locate the \`<server>\` element for \`istore_server1\` in \`$DOMAIN_HOME/config/config.xml\`:

\`\`\`xml
<server>
  <name>istore_server1</name>
  <listen-address>istore-dmz-host</listen-address>
  <listen-port>7778</listen-port>
  <stuck-thread-max-time>300</stuck-thread-max-time>
  <stuck-thread-timer-interval>30</stuck-thread-timer-interval>
  <self-tuning-thread-pool-size-min>75</self-tuning-thread-pool-size-min>
  <self-tuning-thread-pool-size-max>400</self-tuning-thread-pool-size-max>
</server>
\`\`\`

A restart of the managed server is required for \`config.xml\` changes. WLST changes made through \`edit()\`/\`activate()\` are dynamic for the thread pool minimum — no restart needed.

---

## Step 5: Tune JDBC Connection Pool for iStore

Thread starvation in iStore is frequently caused by JDBC connection pool exhaustion rather than the execute thread pool itself. Even with 75 execute threads, if the data source only has 25 connections, 50 threads will queue for a connection on every database call.

### Check current pool state

\`\`\`python
connect('weblogic', 'your_password', 't3://istore-dmz-admin:7001')
domainRuntime()
cd('/ServerRuntimes/istore_server1/JDBCServiceRuntime/istore_server1/JDBCDataSourceRuntimeMBeans')
datasources = ls(returnMap='true')
for ds in datasources:
    cd('/ServerRuntimes/istore_server1/JDBCServiceRuntime/istore_server1/JDBCDataSourceRuntimeMBeans/' + ds)
    print('%-40s  active=%-4s  waiting=%-4s  max=%-4s  failed=%-4s' % (
        ds,
        str(get('ActiveConnectionsCurrentCount')),
        str(get('WaitingForConnectionCurrentCount')),
        str(get('ConnectionsTotalCount')),
        str(get('FailedReserveRequestCount'))
    ))
\`\`\`

If \`WaitingForConnectionCurrentCount\` is non-zero during load, increase \`MaxCapacity\` on that data source.

### Recommended data source settings for iStore

\`\`\`
EBSDataSource (or equivalent iStore DS):
  InitialCapacity:      10
  MinCapacity:          10
  MaxCapacity:          100
  ConnectionReserveTimeoutSeconds: 10
  TestConnectionsOnReserve: true
  TestTableName:        SQL SELECT 1 FROM DUAL
\`\`\`

---

## Step 6: JVM Arguments for the iStore DMZ Server

Add these to \`istore_server1\`'s startup arguments in the Admin Console under **Configuration → Server Start → Arguments**:

\`\`\`bash
# Prevent indefinite socket hangs on outbound HTTP (payment gateways, tax engines)
-Dsun.net.client.defaultConnectTimeout=10000
-Dsun.net.client.defaultReadTimeout=30000

# GC tuning — reduce GC pauses that cause threads to appear stuck
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200
-XX:G1HeapRegionSize=16m

# Thread stack size — reduce if you need more threads within the same memory
-Xss512k

# Heap — size appropriately for your iStore workload
-Xms2048m
-Xmx4096m
\`\`\`

The socket timeout arguments are especially important for iStore in the DMZ — if the DMZ firewall silently drops packets to the internal network or external gateways, WebLogic threads will block indefinitely without them.

---

## Step 7: DMZ-Specific Network Considerations

The iStore server sits between the external load balancer and the internal EBS application tier. Several common DMZ network configurations cause thread accumulation that looks like an application problem but is actually infrastructure:

**Firewall idle connection timeout:** Firewalls in the DMZ path often drop TCP connections idle for more than 15–30 minutes without sending a RST. If iStore's JDBC connections to the internal database are idle during off-peak hours and the firewall drops them silently, the first request after the firewall timeout blocks until the TCP stack times out — often 10+ minutes — holding a thread the entire time.

Fix: Enable **Test Connections On Reserve** on the data source, and set \`TestTableName = SQL SELECT 1 FROM DUAL\`. This issues a lightweight query before giving a connection to a thread, detects stale connections, and replaces them without blocking the caller.

**Keep-alive mismatch:** Ensure the load balancer's connection timeout to iStore is shorter than WebLogic's idle connection timeout. If the load balancer holds a connection open longer than WebLogic expects, WebLogic closes the socket and the load balancer's next request on that connection gets a RST, triggering retries that create duplicate requests.

**MTU mismatch:** On some DMZ segments with VPN or tunnelling, the effective MTU is lower than the standard 1500 bytes. Large responses (iStore catalog pages with many items) can fragment and cause partial reads that stall threads waiting for the remaining bytes. Check with \`ping -s 1472 <internal-db-host>\` from the iStore server — if you see fragmentation, set \`-Doracle.net.ns.DataPacketSize=4096\` in the JDBC URL and reduce \`FetchSize\` on the data source.

---

## Monitoring Checklist (Ongoing)

Run these checks after each change and weekly in production:

\`\`\`bash
# 1. Tail the server log for stuck thread messages
grep -c 'BEA-000337' \
  $DOMAIN_HOME/servers/istore_server1/logs/istore_server1.log

# 2. Check current pool state via WLST
wlst.sh << 'EOF'
connect('weblogic','password','t3://istore-dmz-admin:7001')
domainRuntime()
cd('/ServerRuntimes/istore_server1/ThreadPoolRuntime/ThreadPoolRuntime')
print('idle=%s hogging=%s stuck=%s pending=%s' % (
    str(get('ExecuteThreadIdleCount')),
    str(get('HoggingThreadCount')),
    str(get('StuckThreadCount')),
    str(get('PendingUserRequestCount'))
))
EOF

# 3. Check server health state
wlst.sh << 'EOF'
connect('weblogic','password','t3://istore-dmz-admin:7001')
domainRuntime()
cd('/ServerRuntimes/istore_server1')
print('health=%s' % str(get('HealthState')))
EOF
\`\`\`

A healthy iStore server should show:
- **Idle count > 10** at all times during production hours
- **Stuck count = 0** continuously
- **Hogging count < 5** (a few long-running requests is normal; all of them hogging is not)
- **Health state = HEALTH_OK**
`,
};

async function main() {
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: {
      title: post.title,
      excerpt: post.excerpt,
      content: post.content,
      published: post.published,
      publishedAt: post.publishedAt,
      isPremium: post.isPremium,
    },
  });
  console.log('inserted:', post.slug);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
