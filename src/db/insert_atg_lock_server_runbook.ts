import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'ATG Lock Server Contention Runbook: Diagnosing and Resolving Client Lock Manager Bottlenecks',
  slug: 'oracle-atg-lock-server-contention-runbook',
  excerpt: 'A phased operations runbook for diagnosing and resolving Oracle ATG Web Commerce Lock Server (Client Lock Manager) contention — covering triage, thread dump analysis, lock scope identification, immediate relief, configuration fixes, and long-term monitoring.',
  category: 'oracle-atg' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-30'),
  youtubeUrl: null,
  content: `# ATG Lock Server Contention Runbook: Diagnosing and Resolving Client Lock Manager Bottlenecks

## Overview

Oracle ATG Web Commerce relies on a distributed lock coordination mechanism — the **Client Lock Manager (CLM)** — to ensure transactional consistency across repository items such as orders, profiles, and shopping baskets. The Lock Server JVM acts as the authoritative arbitrator: every participating application server node acquires and releases named locks through this central process before mutating shared state.

When the Lock Server becomes a bottleneck — due to high concurrency, GC pauses, slow external integrations, or misconfigured lock scopes — threads pile up in BLOCKED or WAITING state across all app server nodes simultaneously. The symptom is a platform-wide stall that appears to the end user as extreme latency or HTTP timeouts, while the database AWR shows near-zero active sessions. This pattern is the primary diagnostic fingerprint of CLM contention, distinguishing it from database or network issues.

This runbook is structured in six phases: triage, thread dump analysis, lock scope identification, immediate relief, configuration fixes, and long-term monitoring. Follow the phases in sequence during an active incident. Use the Quick Reference section at the end for repeated lookups during or after the incident.

---

## Phase 1: Incident Triage (First 5 Minutes)

### Objective

Confirm that the incident is a Lock Server issue rather than a database bottleneck, network partition, or application bug on a single node.

### Prerequisites

- Access to Oracle AWR or real-time V$SESSION views on the ATG database schema.
- SSH access to at least one ATG application server node.
- Access to WebLogic Admin Console or JMX port on the Lock Server JVM (default: 1099 or as configured in \`atg/service/lockmanager/LockServer.properties\`).
- Lock Server host and JMX port confirmed with the platform team before the incident.

### Step 1.1 — Confirm Database Is Not the Bottleneck

Run the following query against the ATG database while the incident is active. If the result shows fewer than 5–10 active sessions with no long-running waits, the database is not the root cause.

\`\`\`sql
SELECT
  s.sid,
  s.username,
  s.status,
  s.wait_class,
  s.event,
  s.seconds_in_wait,
  s.sql_id
FROM v\$session s
WHERE s.type = 'USER'
  AND s.status = 'ACTIVE'
ORDER BY s.seconds_in_wait DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

**Expected output during CLM contention:** Near-zero active sessions, or only background jobs. No long SQL_IDs pinned. If you see 50+ ACTIVE sessions all waiting on the same event (e.g., "enq: TX - row lock contention"), escalate to the Database DBA team — this is not a Lock Server issue.

### Step 1.2 — Check Application Thread State

Trigger a thread dump on one ATG application server node. Use one of the following methods depending on your environment.

**Method A — POSIX kill signal (Linux/AIX):**

\`\`\`bash
# Identify the JVM PID
ps -ef | grep -i [A]tg | grep java

# Send thread dump signal (safe, non-destructive)
kill -3 \${ATG_JVM_PID}
\`\`\`

The thread dump will appear in the managed server's standard output log, typically under \`\${DOMAIN_HOME}/servers/\${SERVER_NAME}/logs/\${SERVER_NAME}.out\`.

**Method B — jstack (recommended when log output is unavailable):**

\`\`\`bash
jstack -l \${ATG_JVM_PID} > /tmp/threaddump_\$(hostname)_\$(date +%Y%m%d%H%M%S).txt
\`\`\`

**Method C — WebLogic Admin Console:** Navigate to **Environment > Servers > [server name] > Monitoring > Threads**, then click **Dump Thread Stacks**. Download the output.

### Step 1.3 — Quick Lock Count Check via JMX

Connect to the Lock Server JMX port and query the \`atg.service.lockmanager:type=ClientLockManager\` MBean for the \`lockCount\` attribute. Use \`jmxterm\` if available:

\`\`\`bash
# Launch jmxterm (download from https://github.com/jiaqi/jmxterm if not present)
java -jar jmxterm.jar

# Inside jmxterm:
open \${LOCK_SERVER_HOST}:\${LOCK_SERVER_JMX_PORT}
bean atg.service.lockmanager:type=ClientLockManager
get lockCount
\`\`\`

**Decision Table:**

| lockCount Value | Status    | Action Required                                              |
|-----------------|-----------|--------------------------------------------------------------|
| < 20            | Normal    | Continue monitoring; lock server is not the cause            |
| 20 – 50         | Elevated  | Monitor every 60 seconds; collect thread dumps proactively  |
| 50 – 100        | Warning   | Begin Phase 2 investigation immediately                      |
| > 100           | Critical  | Execute immediate relief (Phase 4) while investigating       |

---

## Phase 2: Thread Dump Analysis

### Objective

Identify the thread that owns the contested lock, trace its call stack to the root cause, and determine whether the bottleneck is an external call, a GC pause, a deadlock, or a configuration defect.

### Step 2.1 — Collect Thread Dumps from All Nodes Simultaneously

For an accurate picture of the contention graph, collect thread dumps from all ATG app server nodes at approximately the same time. Use a loop from a jump host or Ansible:

\`\`\`bash
#!/bin/bash
# Collect thread dumps from all ATG nodes simultaneously
ATG_NODES=("atg-node-01" "atg-node-02" "atg-node-03")
TIMESTAMP=\$(date +%Y%m%d%H%M%S)
DUMP_DIR="/var/tmp/threaddumps_\${TIMESTAMP}"
mkdir -p "\${DUMP_DIR}"

for NODE in "\${ATG_NODES[@]}"; do
  ssh -o StrictHostKeyChecking=no "\${NODE}" "
    PID=\$(pgrep -f 'atg' | head -1)
    if [ -n \"\${PID}\" ]; then
      jstack -l \${PID} > /tmp/td_\${NODE}_\${TIMESTAMP}.txt 2>&1
      echo \"Captured PID \${PID} on \${NODE}\"
    else
      echo \"No ATG JVM found on \${NODE}\"
    fi
  " &
done
wait

# Retrieve all dumps
for NODE in "\${ATG_NODES[@]}"; do
  scp "\${NODE}:/tmp/td_\${NODE}_\${TIMESTAMP}.txt" "\${DUMP_DIR}/" 2>/dev/null
done
echo "Thread dumps collected in \${DUMP_DIR}"
\`\`\`

### Step 2.2 — Extract CLM-Related Blocked Threads

\`\`\`bash
# Find all BLOCKED threads mentioning ClientLockManager
grep -B 5 -A 30 "BLOCKED" /var/tmp/threaddumps_*/td_*.txt | grep -A 30 "lockmanager"

# Count how many threads are blocked on CLM across the dump
grep -c "ClientLockManager" /var/tmp/threaddumps_*/td_*.txt

# Extract the lock owner (the thread HOLDING the lock that others are BLOCKED on)
grep -A 50 "ClientLockManager" /var/tmp/threaddumps_*/td_*.txt | grep -B 2 "locked <"

# Identify WAITING threads in the lock manager's internal queue
grep -B 2 -A 20 "atg.service.lockmanager" /var/tmp/threaddumps_*/td_*.txt | grep -E "(WAITING|BLOCKED|TIMED_WAITING)"
\`\`\`

### Step 2.3 — Interpret the Stack Trace Patterns

**Pattern A — External REST/SOAP call holding the lock:**

Look for a stack that enters \`ClientLockManager.acquireLock()\` and then calls out to \`java.net.SocketInputStream.read()\` or an HTTP client class without ever reaching \`ClientLockManager.releaseLock()\`. This is the most common production cause.

\`\`\`
"atg-request-handler-47" #1234 daemon prio=5 os_prio=0 tid=0x... nid=0x... runnable
   java.lang.Thread.State: RUNNABLE
    at java.net.SocketInputStream.read(SocketInputStream.java:189)
    at atg.adapter.gsa.payment.PaymentServiceClient.authorizePayment(...)
    at atg.commerce.order.purchase.PaymentGroupFormHandler.handleSubmit(...)
    at atg.service.lockmanager.ClientLockManager.runWithLock(...)  ← lock is held here
    ...
\`\`\`

**Pattern B — GC pause signature:**

If many threads show \`WAITING (on object monitor)\` and the lock owner thread itself shows no external call — just a \`VM_Operation\` or safepoint — a Stop-The-World GC pause is holding the lock thread while GC runs.

\`\`\`
"VM Thread" os_prio=2 tid=0x... nid=0x... [0x...]
   ...
"atg-request-handler-47" #1234 WAITING (on object monitor)
    at java.lang.Object.wait(Native Method)
    - waiting on <0x... (a atg.service.lockmanager.LockToken)>
\`\`\`

**Pattern C — Deadlock detection:**

jstack will print a "Found one Java-level deadlock" section if two threads hold each other's required locks. This is rare in ATG but can occur with multi-item basket operations.

\`\`\`bash
# Check for deadlock section in the dump
grep -A 30 "Found.*Java-level deadlock" /var/tmp/threaddumps_*/td_*.txt
\`\`\`

---

## Phase 3: Identify Lock Type and Scope

### Objective

Determine whether the contention is occurring on global locks (managed by the central Lock Server JVM) or local locks (in-process, per-node), and identify which ATG component is the locking point.

### Step 3.1 — Inspect Repository Lock Configuration

Check the following key property files on the ATG deployment filesystem. These files govern whether each repository uses the global CLM or a local in-process lock manager.

**Order Repository:**
\`\`\`
/atg/commerce/order/OrderRepository.properties
\`\`\`
\`\`\`properties
# Relevant properties:
useGlobalLocks=true
lockManager=/atg/service/lockmanager/ClientLockManager

# For read-heavy repositories, consider:
readLockManager=/atg/service/lockmanager/LocalLockManager
writeLockManager=/atg/service/lockmanager/ClientLockManager
\`\`\`

**Profile Repository:**
\`\`\`
/atg/userprofiling/ProfileRepository.properties
\`\`\`
\`\`\`properties
useGlobalLocks=true
lockManager=/atg/service/lockmanager/ClientLockManager
lockServerAddress=atg-lockserver-01:9015
\`\`\`

**Scenario Manager:**
\`\`\`
/atg/scenario/ScenarioManager.properties
\`\`\`
\`\`\`properties
lockManager=/atg/service/lockmanager/ClientLockManager
\`\`\`

### Step 3.2 — Enable DEBUG Logging for CLM

To see which item keys are being locked in real time, enable DEBUG logging on the lock manager component without restarting the JVM, via Dynamo Admin:

**Dynamo Admin URL:**
\`\`\`
http://<host>:<port>/dyn/admin/nucleus/atg/service/lockmanager/ClientLockManager/
\`\`\`

In the Dynamo Admin interface for this component, set the \`loggingDebug\` property to \`true\`. This will produce log lines of the form:

\`\`\`
[ClientLockManager] Acquiring lock for key: order:12345678
[ClientLockManager] Lock acquired for key: order:12345678 after 2341ms
[ClientLockManager] Releasing lock for key: order:12345678
\`\`\`

High hold times (> 500ms) on a particular item type (e.g., \`profile:\`, \`order:\`, \`basket:\`) will confirm the contended namespace.

**Important:** Disable DEBUG logging after diagnosis. The log volume at high traffic is significant.

### Step 3.3 — Review Active Lock Server Component State

From the Dynamo Admin URL above, review the following MBean attributes:

| Attribute            | Meaning                                                    |
|----------------------|------------------------------------------------------------|
| \`lockCount\`          | Current number of named locks held across all app nodes    |
| \`waitingThreadCount\` | Threads queued waiting to acquire a lock                   |
| \`averageWaitTime\`    | Rolling average time to acquire a lock (ms)                |
| \`maxHoldTime\`        | Longest single lock hold time in the current window (ms)   |

---

## Phase 4: Immediate Relief Actions

### Objective

Restore service availability while root cause analysis continues. Choose the option that matches the diagnosed cause from Phase 2.

### Option A — Runaway Bot/Crawler Traffic (Anonymous GetBasket Storm)

If thread dumps show hundreds of anonymous sessions all competing for basket or profile locks — a pattern typical of aggressive bots calling add-to-cart or get-basket endpoints — throttle at the load balancer before requests reach ATG:

**NGINX rate limit example (insert at load balancer):**
\`\`\`nginx
# Temporary: limit anonymous basket requests to 10 req/s, burst 20
limit_req_zone \${binary_remote_addr} zone=basket_anon:10m rate=10r/s;

location /store/cart/ {
    limit_req zone=basket_anon burst=20 nodelay;
    limit_req_status 429;
    proxy_pass http://atg_backend;
}
\`\`\`

**ATG pipeline-level 429 for guest basket:** Add a pipeline servlet early in the \`GetBasket\` pipeline that returns HTTP 429 for non-authenticated requests. This is configured in the pipeline configuration XML:

\`\`\`xml
<pipelinechain name="GetBasketChain" transaction="TX_REQUIRED">
  <pipelinelink name="GuestBasketThrottle" transaction="TX_NOT_SUPPORTED">
    <servlet-bean>
      /atg/commerce/order/pipeline/GuestBasketThrottleServlet
    </servlet-bean>
    <transition returnvalue="SUCCESS" transition-to="AcquireOrderLock"/>
    <transition returnvalue="THROTTLED" transition-to="SendTooManyRequests"/>
  </pipelinelink>
  ...
</pipelinechain>
\`\`\`

### Option B — Slow External Service Holding the Lock

If the thread dump stack trace (Pattern A from Phase 2) shows an external payment gateway, inventory service, or fulfillment API blocking while the ATG lock is held:

1. Identify the integration component from the stack trace class name.
2. In Dynamo Admin, navigate to that component (e.g., \`/atg/commerce/payment/ExternalPaymentService/\`).
3. Set the component's \`enabled\` property to \`false\` to circuit-break the call. This will cause payment or inventory calls to fail fast, releasing lock hold time immediately.
4. Monitor lock queue drain via JMX \`lockCount\` — expect to see the value drop within 30–120 seconds.
5. Coordinate with the external service team on resolution before re-enabling.

### Option C — Lock Server JVM GC Pause

If Pattern B from Phase 2 (GC pause holding threads) is confirmed:

**Warning:** Restarting the Lock Server JVM drops all active named locks immediately. All connected app server nodes will experience a brief lock storm as they re-acquire locks. This is preferable to a multi-minute stall but must be coordinated.

**Lock Server Restart Sequence:**

\`\`\`bash
# Step 1: Notify connected app server nodes (if possible, drain connections first)
# Stop all ATG managed server nodes
for NODE in \${ATG_APP_NODES}; do
  ssh \${NODE} "\${DOMAIN_HOME}/bin/stopManagedWebLogic.sh \${ATG_SERVER_NAME} t3://\${ADMIN_HOST}:7001"
done

# Step 2: Restart the Lock Server JVM (standalone process or WebLogic managed server)
# If standalone:
ssh \${LOCK_SERVER_HOST} "kill \${LOCK_SERVER_PID} && \${ATG_ROOT}/home/bin/startLockServer.sh"

# If WebLogic-managed:
ssh \${LOCK_SERVER_HOST} "\${DOMAIN_HOME}/bin/startManagedWebLogic.sh LockServerMS t3://\${ADMIN_HOST}:7001"

# Step 3: Verify Lock Server MBean responds before restarting app nodes
# (see Phase 6 post-incident script for the verification command)

# Step 4: Restart ATG app nodes
for NODE in \${ATG_APP_NODES}; do
  ssh \${NODE} "\${DOMAIN_HOME}/bin/startManagedWebLogic.sh \${ATG_SERVER_NAME} t3://\${ADMIN_HOST}:7001"
done
\`\`\`

**Expected recovery time:** Lock queue will drain within 30–120 seconds of the root cause being removed, under normal production traffic. Bot storms or retry avalanches may extend this to 3–5 minutes.

---

## Phase 5: Configuration Fixes (Preventing Recurrence)

### Fix 1 — Guest Session Short-Circuit

Guest (anonymous) users do not maintain persistent carts across sessions in most ATG configurations. Acquiring a distributed CLM lock for a guest basket is unnecessary overhead. Add a null/guest check at the pipeline entry point before the lock is acquired.

**Pipeline servlet configuration (\`GuestBasketGuardServlet.properties\`):**
\`\`\`properties
$class=atg.commerce.order.pipeline.GuestBasketGuardServlet
profileComponent=/atg/userprofiling/Profile

# Return SKIP_PIPELINE for non-authenticated users before lock acquisition
skipForAnonymous=true
anonymousReturnCode=SKIP_PIPELINE
\`\`\`

Register this servlet as the first link in the \`GetBasketPipelineChain\` and \`AddItemToOrderPipelineChain\`.

### Fix 2 — Switch to Local Locking for Guest Profiles

For anonymous profiles, there is no cross-node state to protect. Switching the ProfileRepository to use the \`LocalLockManager\` for guest sessions eliminates Lock Server calls entirely for that traffic class.

\`\`\`properties
# /atg/userprofiling/ProfileRepository.properties
$class=atg.adapter.gsa.GSARepository

# Use local locking for guest profiles; CLM only for authenticated profiles
lockManager=/atg/service/lockmanager/LocalLockManager

# If you need CLM only for authenticated profiles, use a custom lockManager
# that delegates to CLM for real profiles and LocalLockManager for transient profiles
lockManagerComponent=/atg/userprofiling/ProfileLockManagerSelector
\`\`\`

### Fix 3 — Read/Write Lock Split

Many ATG repositories acquire write locks even for operations that only read data. If \`OrderRepository\` or \`ProductCatalog\` is acquiring CLM locks for lookups, configure separate read and write lock managers:

\`\`\`properties
# /atg/commerce/order/OrderRepository.properties

# Write operations use CLM (global, serialized)
writeLockManager=/atg/service/lockmanager/ClientLockManager

# Read operations use local (no Lock Server round-trip)
readLockManager=/atg/service/lockmanager/LocalLockManager
\`\`\`

For the product catalog (rarely mutated), switch entirely to local locking:

\`\`\`properties
# /atg/commerce/catalog/ProductCatalog.properties
lockManager=/atg/service/lockmanager/LocalLockManager
\`\`\`

### Fix 4 — Lock Boundary Discipline (Release Before External Calls)

The pattern of holding a CLM lock across an external service call is the single most common cause of severe CLM contention. The correct ATG pattern uses try/finally to release the lock before any network I/O.

**Incorrect pattern (lock held across external call):**
\`\`\`java
// WRONG: lock held while making external payment call
lockManager.acquireLock(orderId);
paymentService.authorize(order);   // may block for seconds
lockManager.releaseLock(orderId);
\`\`\`

**Correct pattern (release before external I/O):**
\`\`\`java
// Correct Formhandler / pipeline servlet pattern
String lockKey = "order:" + orderId;
try {
    lockManager.acquireLock(lockKey);
    // Only mutate in-memory/repository state inside the lock
    order.setState(Order.STATE_PENDING_PAYMENT);
    orderRepository.updateItem(order);
} finally {
    // Release BEFORE external service call
    lockManager.releaseLock(lockKey);
}

// External call happens OUTSIDE the lock scope
PaymentResult result = paymentService.authorize(order);

// Re-acquire lock only if repository mutation is needed based on result
try {
    lockManager.acquireLock(lockKey);
    if (result.isApproved()) {
        order.setState(Order.STATE_SUBMITTED);
        orderRepository.updateItem(order);
    }
} finally {
    lockManager.releaseLock(lockKey);
}
\`\`\`

Apply this pattern in all \`Formhandler\` subclasses and pipeline servlets that make outbound calls.

### Fix 5 — Lock Server JVM Tuning

Run the Lock Server in a **dedicated JVM separate from ATG app servers**. Apply G1GC tuning to minimize STW pause duration.

**Recommended JVM flags for Lock Server JVM (Java 11+):**

\`\`\`bash
# Lock Server JVM startup flags
LOCK_SERVER_JAVA_OPTS="-Xms2g -Xmx2g \
  -XX:+UseG1GC \
  -XX:MaxGCPauseMillis=150 \
  -XX:G1HeapRegionSize=16m \
  -XX:InitiatingHeapOccupancyPercent=35 \
  -XX:G1ReservePercent=20 \
  -XX:+ParallelRefProcEnabled \
  -XX:+PrintGCDetails \
  -XX:+PrintGCDateStamps \
  -Xloggc:\${LOG_DIR}/lockserver_gc_\$(date +%Y%m%d).log \
  -XX:+UseGCLogFileRotation \
  -XX:NumberOfGCLogFiles=5 \
  -XX:GCLogFileSize=20m \
  -Dcom.sun.management.jmxremote \
  -Dcom.sun.management.jmxremote.port=\${LOCK_SERVER_JMX_PORT} \
  -Dcom.sun.management.jmxremote.authenticate=false \
  -Dcom.sun.management.jmxremote.ssl=false"
\`\`\`

**Target:** STW GC pause < 200ms. If pauses regularly exceed 200ms, review object allocation rate in the Lock Server process — it should be extremely low. High allocation in the Lock Server JVM indicates application code is incorrectly routing business logic through the Lock Server process.

**Heap sizing:** A dedicated Lock Server JVM handling 50–200 concurrent locks requires no more than 2–4 GB heap. Oversizing the heap increases GC pause duration — keep it small and well-tuned.

---

## Phase 6: Monitoring and Alerting

### Monitoring Script 1 — JMX Lock Count Poller

Deploy this script on the Lock Server host or a monitoring node. It polls \`lockCount\` every 60 seconds and sends an email alert when the count exceeds 50.

\`\`\`bash
#!/bin/bash
# atg_lockcount_monitor.sh
# Polls ATG Lock Server JMX lockCount every 60 seconds
# Alerts via email when lockCount exceeds WARNING or CRITICAL threshold

LOCK_SERVER_HOST="\${1:-atg-lockserver-01}"
JMX_PORT="\${2:-1099}"
WARNING_THRESHOLD=50
CRITICAL_THRESHOLD=100
ALERT_EMAIL="dba-oncall@example.com"
JMXTERM_JAR="/opt/tools/jmxterm.jar"
LOG_FILE="/var/log/atg/lockcount_monitor.log"
LAST_ALERT_FILE="/tmp/atg_lock_last_alert"

log() {
  echo "\$(date '+%Y-%m-%d %H:%M:%S') \$1" | tee -a "\${LOG_FILE}"
}

get_lock_count() {
  local count
  count=\$(java -jar "\${JMXTERM_JAR}" <<EOF 2>/dev/null | grep -E '^[0-9]+$'
open \${LOCK_SERVER_HOST}:\${JMX_PORT}
bean atg.service.lockmanager:type=ClientLockManager
get lockCount
close
EOF
)
  echo "\${count:-UNAVAILABLE}"
}

send_alert() {
  local level="\$1"
  local count="\$2"
  local now=\$(date +%s)
  local last_alert=0

  [ -f "\${LAST_ALERT_FILE}" ] && last_alert=\$(cat "\${LAST_ALERT_FILE}")

  # Rate-limit alerts: no more than one per 10 minutes
  if [ \$(( now - last_alert )) -lt 600 ]; then
    return
  fi

  echo "\${now}" > "\${LAST_ALERT_FILE}"

  mail -s "ATG Lock Server \${level}: lockCount=\${count} on \${LOCK_SERVER_HOST}" \
    "\${ALERT_EMAIL}" <<EOF
ATG Lock Server alert triggered on \${LOCK_SERVER_HOST}.

Severity : \${level}
lockCount: \${count}
Threshold: \${level} = \$([ "\${level}" = "CRITICAL" ] && echo "\${CRITICAL_THRESHOLD}" || echo "\${WARNING_THRESHOLD}")
Timestamp: \$(date)

Immediate action required. Refer to the ATG CLM Contention Runbook.

--- JMX MBean ---
Host     : \${LOCK_SERVER_HOST}:\${JMX_PORT}
Bean     : atg.service.lockmanager:type=ClientLockManager
Attribute: lockCount
EOF

  log "Alert sent: \${level} level, lockCount=\${count}"
}

log "ATG Lock Server monitor started. Target: \${LOCK_SERVER_HOST}:\${JMX_PORT}"

while true; do
  COUNT=\$(get_lock_count)

  if [ "\${COUNT}" = "UNAVAILABLE" ]; then
    log "ERROR: Could not retrieve lockCount from JMX. Lock Server may be down."
    send_alert "CRITICAL" "UNAVAILABLE"
  elif [ "\${COUNT}" -ge "\${CRITICAL_THRESHOLD}" ]; then
    log "CRITICAL: lockCount=\${COUNT}"
    send_alert "CRITICAL" "\${COUNT}"
  elif [ "\${COUNT}" -ge "\${WARNING_THRESHOLD}" ]; then
    log "WARNING: lockCount=\${COUNT}"
    send_alert "WARNING" "\${COUNT}"
  else
    log "OK: lockCount=\${COUNT}"
  fi

  sleep 60
done
\`\`\`

**Deployment:**
\`\`\`bash
chmod +x /opt/monitoring/atg_lockcount_monitor.sh
nohup /opt/monitoring/atg_lockcount_monitor.sh atg-lockserver-01 1099 >> /var/log/atg/lockcount_monitor.log 2>&1 &
\`\`\`

### Monitoring Script 2 — Thread Dump BLOCKED Thread Extractor

Use this script during an incident to parse collected thread dumps and produce a structured report of all BLOCKED threads and their lock owners.

\`\`\`bash
#!/bin/bash
# parse_thread_dump.sh
# Extracts all BLOCKED threads and their lock owners from ATG thread dump files
# Usage: ./parse_thread_dump.sh /path/to/threaddump_dir/

DUMP_DIR="\${1:-.}"
OUTPUT_FILE="/tmp/blocked_thread_report_\$(date +%Y%m%d%H%M%S).txt"

echo "ATG Thread Dump BLOCKED Thread Analysis" > "\${OUTPUT_FILE}"
echo "Generated: \$(date)" >> "\${OUTPUT_FILE}"
echo "Source directory: \${DUMP_DIR}" >> "\${OUTPUT_FILE}"
echo "============================================" >> "\${OUTPUT_FILE}"

for DUMP_FILE in "\${DUMP_DIR}"/*.txt; do
  [ -f "\${DUMP_FILE}" ] || continue

  FILENAME=\$(basename "\${DUMP_FILE}")
  echo "" >> "\${OUTPUT_FILE}"
  echo "=== File: \${FILENAME} ===" >> "\${OUTPUT_FILE}"

  # Count BLOCKED threads total
  BLOCKED_COUNT=\$(grep -c "java.lang.Thread.State: BLOCKED" "\${DUMP_FILE}" 2>/dev/null || echo 0)
  CLM_BLOCKED=\$(grep -B 2 "BLOCKED" "\${DUMP_FILE}" | grep -c "lockmanager" || echo 0)
  echo "Total BLOCKED threads: \${BLOCKED_COUNT}" >> "\${OUTPUT_FILE}"
  echo "BLOCKED on lockmanager: \${CLM_BLOCKED}" >> "\${OUTPUT_FILE}"
  echo "" >> "\${OUTPUT_FILE}"

  # Extract each BLOCKED thread with 30 lines of stack context
  echo "--- BLOCKED Thread Stacks ---" >> "\${OUTPUT_FILE}"
  awk '
    /java.lang.Thread.State: BLOCKED/ {
      in_block = 1
      line_count = 0
    }
    in_block {
      print
      line_count++
      if (line_count >= 35 || /^$/) {
        in_block = 0
        print "---"
      }
    }
  ' "\${DUMP_FILE}" >> "\${OUTPUT_FILE}"

  # Extract lock owner threads (threads holding locks that BLOCKED threads wait on)
  echo "" >> "\${OUTPUT_FILE}"
  echo "--- Lock Owner Identification ---" >> "\${OUTPUT_FILE}"
  echo "(Threads holding locks referenced by BLOCKED threads)" >> "\${OUTPUT_FILE}"

  # Find all "waiting to lock <0x...>" references and then find "locked <0x...>" owners
  grep "waiting to lock <" "\${DUMP_FILE}" | grep -oP '0x[0-9a-f]+' | sort -u | while read LOCK_ADDR; do
    OWNER=\$(grep -B 50 "locked <\${LOCK_ADDR}>" "\${DUMP_FILE}" | grep '"' | tail -1)
    echo "Lock \${LOCK_ADDR} owned by: \${OWNER}" >> "\${OUTPUT_FILE}"
  done

  # Extract CLM-specific lock acquire/hold entries from the stack
  echo "" >> "\${OUTPUT_FILE}"
  echo "--- ClientLockManager Stack Occurrences ---" >> "\${OUTPUT_FILE}"
  grep -n "ClientLockManager\|lockmanager" "\${DUMP_FILE}" | head -40 >> "\${OUTPUT_FILE}"
done

echo "" >> "\${OUTPUT_FILE}"
echo "============================================" >> "\${OUTPUT_FILE}"
echo "Analysis complete. Review \${OUTPUT_FILE} for full report." >> "\${OUTPUT_FILE}"

cat "\${OUTPUT_FILE}"
echo ""
echo "Full report saved to: \${OUTPUT_FILE}"
\`\`\`

### Monitoring Script 3 — Post-Incident Verification

Run this script after applying any fix or restarting the Lock Server to confirm the system has returned to normal operation.

\`\`\`bash
#!/bin/bash
# atg_lockserver_verify.sh
# Post-incident verification: confirms Lock Server is responsive and lock queue is clear
# Usage: ./atg_lockserver_verify.sh <lockserver_host> <jmx_port>

LOCK_SERVER_HOST="\${1:-atg-lockserver-01}"
JMX_PORT="\${2:-1099}"
JMXTERM_JAR="/opt/tools/jmxterm.jar"
PASS=0
FAIL=0

ok()   { echo "[PASS] \$1"; PASS=\$((PASS + 1)); }
fail() { echo "[FAIL] \$1"; FAIL=\$((FAIL + 1)); }
info() { echo "[INFO] \$1"; }

echo "============================================"
echo "ATG Lock Server Post-Incident Verification"
echo "Target: \${LOCK_SERVER_HOST}:\${JMX_PORT}"
echo "Timestamp: \$(date)"
echo "============================================"

# Check 1: JMX port is reachable
info "Check 1: JMX port connectivity..."
if timeout 5 bash -c "echo >/dev/tcp/\${LOCK_SERVER_HOST}/\${JMX_PORT}" 2>/dev/null; then
  ok "JMX port \${JMX_PORT} is reachable on \${LOCK_SERVER_HOST}"
else
  fail "JMX port \${JMX_PORT} is NOT reachable on \${LOCK_SERVER_HOST} — Lock Server may be down"
fi

# Check 2: MBean responds and lockCount is below warning threshold
info "Check 2: Querying lockCount via JMX..."
LOCK_COUNT=\$(java -jar "\${JMXTERM_JAR}" <<EOF 2>/dev/null | grep -E '^[0-9]+'
open \${LOCK_SERVER_HOST}:\${JMX_PORT}
bean atg.service.lockmanager:type=ClientLockManager
get lockCount
close
EOF
)

if [ -z "\${LOCK_COUNT}" ]; then
  fail "Could not retrieve lockCount — MBean may be unregistered or Lock Server is initializing"
elif [ "\${LOCK_COUNT}" -le 20 ]; then
  ok "lockCount=\${LOCK_COUNT} — within normal range (<= 20)"
elif [ "\${LOCK_COUNT}" -le 50 ]; then
  fail "lockCount=\${LOCK_COUNT} — elevated (20–50); continue monitoring"
else
  fail "lockCount=\${LOCK_COUNT} — still above warning threshold; incident may not be resolved"
fi

# Check 3: waitingThreadCount is zero or near-zero
info "Check 3: Querying waitingThreadCount..."
WAITING_COUNT=\$(java -jar "\${JMXTERM_JAR}" <<EOF 2>/dev/null | grep -E '^[0-9]+'
open \${LOCK_SERVER_HOST}:\${JMX_PORT}
bean atg.service.lockmanager:type=ClientLockManager
get waitingThreadCount
close
EOF
)

if [ -z "\${WAITING_COUNT}" ]; then
  fail "Could not retrieve waitingThreadCount"
elif [ "\${WAITING_COUNT}" -eq 0 ]; then
  ok "waitingThreadCount=0 — no threads queued for lock acquisition"
elif [ "\${WAITING_COUNT}" -le 5 ]; then
  ok "waitingThreadCount=\${WAITING_COUNT} — low, within acceptable range"
else
  fail "waitingThreadCount=\${WAITING_COUNT} — threads still queuing; check for lingering contention"
fi

# Check 4: averageWaitTime is below 500ms
info "Check 4: Querying averageWaitTime..."
AVG_WAIT=\$(java -jar "\${JMXTERM_JAR}" <<EOF 2>/dev/null | grep -E '^[0-9]+'
open \${LOCK_SERVER_HOST}:\${JMX_PORT}
bean atg.service.lockmanager:type=ClientLockManager
get averageWaitTime
close
EOF
)

if [ -z "\${AVG_WAIT}" ]; then
  info "averageWaitTime not available (attribute may not be exposed on this version)"
elif [ "\${AVG_WAIT}" -lt 500 ]; then
  ok "averageWaitTime=\${AVG_WAIT}ms — below 500ms threshold"
else
  fail "averageWaitTime=\${AVG_WAIT}ms — above 500ms; locks are still slow to acquire"
fi

# Check 5: Verify ATG app server nodes have reconnected to Lock Server
info "Check 5: Checking connected client count..."
CONNECTED_CLIENTS=\$(java -jar "\${JMXTERM_JAR}" <<EOF 2>/dev/null | grep -E '^[0-9]+'
open \${LOCK_SERVER_HOST}:\${JMX_PORT}
bean atg.service.lockmanager:type=ClientLockManager
get connectedClientCount
close
EOF
)

EXPECTED_CLIENTS=3  # Update to match your environment's app node count
if [ -z "\${CONNECTED_CLIENTS}" ]; then
  info "connectedClientCount not available"
elif [ "\${CONNECTED_CLIENTS}" -ge "\${EXPECTED_CLIENTS}" ]; then
  ok "connectedClientCount=\${CONNECTED_CLIENTS} — all expected app nodes connected"
else
  fail "connectedClientCount=\${CONNECTED_CLIENTS} — fewer than expected (\${EXPECTED_CLIENTS}); some app nodes may not have reconnected"
fi

# Summary
echo ""
echo "============================================"
echo "Verification Summary"
echo "PASS: \${PASS}  FAIL: \${FAIL}"
if [ "\${FAIL}" -eq 0 ]; then
  echo "STATUS: CLEAR — Lock Server appears healthy. Incident resolved."
else
  echo "STATUS: ACTION REQUIRED — \${FAIL} check(s) failed. Do not close the incident."
fi
echo "============================================"
\`\`\`

### Recommended Monitoring Thresholds

| Metric                  | Normal      | Warning        | Critical        |
|-------------------------|-------------|----------------|-----------------|
| \`lockCount\`             | < 20        | 20 – 50        | > 50            |
| \`waitingThreadCount\`    | 0 – 3       | 4 – 15         | > 15            |
| \`averageWaitTime\` (ms)  | < 100ms     | 100 – 500ms    | > 500ms         |
| \`maxHoldTime\` (ms)      | < 200ms     | 200 – 1000ms   | > 1000ms        |
| Thread pool queue depth  | < 10        | 10 – 50        | > 50            |
| Lock Server GC STW pause | < 100ms     | 100 – 200ms    | > 200ms         |

### Log-Based Alerting Pattern

ATG logs lock timeout messages when a thread has waited too long for lock acquisition. Configure Splunk, ELK, or a simple grep-based monitor for this pattern:

\`\`\`bash
# Real-time log watch for CLM timeout messages
tail -f \${ATG_LOG_DIR}/atg_application.log | grep -E \
  "ClientLockManager|LockTimeout|lock.*timeout|waiting.*lock.*exceeded|lockmanager.*ERROR"
\`\`\`

Typical ATG lock timeout log entry:
\`\`\`
[ERROR] [ClientLockManager] Timed out waiting to acquire lock for key: order:12345678 after 30000ms
[ERROR] [ClientLockManager] Thread queue depth exceeded maximum: 150 threads waiting
\`\`\`

---

## Quick Reference

### JMX MBean Path for Lock Count

\`\`\`
MBean ObjectName : atg.service.lockmanager:type=ClientLockManager
Primary Attribute: lockCount
Other Attributes : waitingThreadCount, averageWaitTime, maxHoldTime, connectedClientCount
JMX URL format   : service:jmx:rmi:///jndi/rmi://<host>:<port>/jmxrmi
\`\`\`

### Thread Dump Command for WebLogic-Managed JVM

\`\`\`bash
# Via jstack (preferred)
jstack -l \$(pgrep -f '\${SERVER_NAME}') > /tmp/td_\$(date +%Y%m%d%H%M%S).txt

# Via kill signal
kill -3 \$(pgrep -f '\${SERVER_NAME}')
# Output appears in: \${DOMAIN_HOME}/servers/\${SERVER_NAME}/logs/\${SERVER_NAME}.out

# Via WLST
java weblogic.WLST -e "
connect('weblogic','\${WL_PASSWORD}','t3://\${ADMIN_HOST}:7001')
threadDump(server='\${SERVER_NAME}')
"
\`\`\`

### Key Component Property Files and Properties

| File Path                                              | Key Property               | Value Options                                                |
|--------------------------------------------------------|----------------------------|--------------------------------------------------------------|
| \`/atg/service/lockmanager/LockServer.properties\`      | \`port\`                     | Default: 9015                                                |
| \`/atg/service/lockmanager/ClientLockManager.properties\`| \`lockServerAddress\`       | \`<host>:<port>\`                                            |
| \`/atg/commerce/order/OrderRepository.properties\`      | \`lockManager\`              | \`/atg/service/lockmanager/ClientLockManager\` (global)      |
| \`/atg/userprofiling/ProfileRepository.properties\`     | \`lockManager\`              | \`/atg/service/lockmanager/LocalLockManager\` (guest-safe)   |
| \`/atg/scenario/ScenarioManager.properties\`            | \`lockManager\`              | \`/atg/service/lockmanager/ClientLockManager\`               |
| Any GSA repository                                     | \`readLockManager\`          | \`LocalLockManager\` for read-only lock split                |
| Any GSA repository                                     | \`writeLockManager\`         | \`ClientLockManager\` for write operations                   |

### Lock Server Restart Sequence (Summary)

\`\`\`bash
# 1. Stop all ATG app server nodes
# 2. Restart Lock Server JVM (standalone or WebLogic managed server)
# 3. Verify JMX MBean responds: bean atg.service.lockmanager:type=ClientLockManager; get lockCount
# 4. Confirm connectedClientCount = 0 (no old stale connections)
# 5. Start ATG app server nodes
# 6. Verify connectedClientCount matches expected node count
# 7. Run post-incident verification script (Script 3)
\`\`\`

### Post-Incident Verification Checklist

- [ ] \`lockCount\` is below 20 on JMX
- [ ] \`waitingThreadCount\` is 0 or near-zero
- [ ] \`averageWaitTime\` is below 100ms
- [ ] All ATG app server nodes reconnected (\`connectedClientCount\` matches expected)
- [ ] No CLM timeout errors in ATG application log for past 5 minutes
- [ ] Thread dump shows no BLOCKED threads on \`ClientLockManager\`
- [ ] Database AWR shows normal active session count (not suppressed — confirm it's rising back to baseline)
- [ ] Load balancer health checks green on all ATG nodes
- [ ] External service (payment/inventory) confirmed responsive if that was the cause
- [ ] DEBUG logging on \`ClientLockManager\` disabled after incident
- [ ] Incident timeline documented with root cause, actions taken, and configuration changes applied
- [ ] Fix 4 (lock boundary discipline) scheduled for next sprint if external-call-under-lock pattern was the cause
`,
};

async function main() {
  console.log('Inserting ATG lock server runbook...');
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
