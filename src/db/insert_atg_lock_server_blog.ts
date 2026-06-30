import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'When "Out of the Box" Fails: Demystifying Oracle ATG Lock Server Contention',
  slug: 'oracle-atg-lock-server-contention',
  excerpt:
    'A deep-dive into Oracle ATG Web Commerce Client Lock Manager contention: how the Lock Server works, why OOTB configuration silently extends lock hold times from milliseconds to minutes, and how to diagnose, resolve, and prevent the ghost bottleneck that keeps your database idle while your commerce platform grinds to a halt.',
  category: 'oracle-atg' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-30'),
  youtubeUrl: null,
  content: `Intermittent production incidents in Oracle ATG Web Commerce follow a recognizable pattern. Customers report being unable to check out. Response times spike to two or three minutes for basket operations that normally complete in under a second. The monitoring team opens a war room bridge. Someone pulls up Oracle AWR. Active Sessions is in single digits. Wait events are dominated by idle categories. CPU on the database host is at four percent. The DBA team reports a clean bill of health.

The incident self-resolves thirty minutes later. Two days later it happens again.

The root cause is almost never in the database. It is in the ATG Client Lock Manager — the component responsible for coordinating thread safety across JVM nodes in an ATG cluster. The database is idle because the database is not the bottleneck. The contention lives entirely in the JVM layer, and without understanding how ATG's locking subsystem works, it is nearly impossible to find.

This post covers how the ATG Lock Server functions, why out-of-the-box configuration creates the conditions for lock contention at scale, how to diagnose an active incident, two concrete case studies, and the configuration and architectural changes that prevent recurrence.

---

## How ATG Lock Servers Work

### The Client Lock Manager Role

Oracle ATG Web Commerce is a distributed, session-aware commerce platform. Multiple JVM nodes in a cluster operate on shared repository objects: customer profiles, shopping carts (baskets), order items, promotions, and pricing rules. When two threads on different nodes modify the same basket simultaneously, the result without coordination is data corruption — last-write-wins races, lost updates, and inconsistent item totals.

The Client Lock Manager (CLM) solves this by providing a distributed locking layer that sits above the repository tier. Before any thread can modify a lockable item — a profile, a basket, an order — it must acquire a named lock from the Lock Server. The Lock Server is a dedicated ATG nucleus component, often running in its own JVM process, that maintains the authoritative state of which items are currently locked and by which thread.

### Transaction Flow

The sequence for a basket operation is as follows:

\`\`\`
User Request
  |
  v
App Server Thread (Node 1)
  |
  +-- Requests lock: "Basket ID: ORD-20240618-00442"
  |
  v
ATG Lock Server (LockManager JVM)
  |
  +-- Lock available? YES
  |   Grant lock to Thread-47 on Node 1
  |
  v
App Server Thread (Node 1)
  |
  +-- Executes repository operations (in-memory + DB sync)
  +-- Completes business logic
  |
  v
ATG Lock Server
  |
  +-- Receives release signal from Thread-47
  +-- Lock state: available
  |
  v
Next waiting thread may proceed
\`\`\`

If Thread-47 on Node 1 holds a lock on basket ORD-20240618-00442, any subsequent thread on any cluster node requesting the same lock enters a wait queue. The waiting thread blocks at the CLM client boundary. It does not issue database queries. It does not consume CPU. It simply sits blocked at a Java \`Object.wait()\` call, consuming a thread from the application server's worker pool.

### Thread Exhaustion Cascade

This is the critical failure mode. WebLogic and ATG's Dynamo Application Server each manage a finite pool of worker threads. If enough threads accumulate in lock wait states, the thread pool is exhausted. New requests cannot be dispatched. From the outside, the server becomes unresponsive. Components that share the thread pool — including search API handlers, page rendering pipelines, and inventory check endpoints — all stop responding, even though none of them have any connection to basket locking.

After restart, the Lock Server shows 120 to 190 active locks because in-flight requests that were holding locks at shutdown time were abandoned without releasing them. The Lock Server's internal state is orphaned until the locks expire via configurable timeout.

---

## Why Out-of-the-Box Code Extends Locks to Minutes

Three architectural weak points in default ATG configuration combine to convert millisecond-scale locking operations into multi-minute lock holds.

### Weak Point 1: Global vs. Local Locking Topologies

ATG repository definitions carry a \`useGlobalLocks\` flag. When set to \`true\`, every lock acquisition routes through the central Lock Server JVM. When set to \`false\` (local mode), locking is handled within the local JVM — no network round-trip, no central coordination, but also no protection against cross-node conflicts.

Out-of-the-box, many ATG profile and commerce repository definitions ship with \`useGlobalLocks=true\` as a conservative default. The problem is that not every lockable item requires multi-cluster safety. Guest session profiles are ephemeral and node-local by nature. Read-heavy product catalog items do not need global coordination at all. When global locking is applied indiscriminately, every read path competes for the central Lock Server's attention alongside every write path.

**JVM Stop-The-World GC pauses compound this.** The Lock Server runs in a JVM. A Stop-The-World garbage collection event — common on under-tuned heap configurations using the default parallel GC collector — freezes all JVM threads, including the lock grant and release signal processors. During a 2-8 second STW pause, no lock releases are processed. Threads on all app nodes that are waiting for lock releases pile up. The database remains at zero utilization because none of those waiting threads are issuing queries. The GC pause ends, the Lock Server resumes processing, and the queue drains — but if the burst was large enough, thread pool exhaustion has already occurred.

### Weak Point 2: Lock Contention via Guest Profiling

ATG's out-of-the-box \`GetBasket\` pipeline evaluates the current profile and retrieves or creates a basket object before determining whether the session represents a unique guest, an anonymous crawler, or a returning customer. This evaluation acquires a lock.

High-volume automated traffic — price comparison bots, search engine crawlers, security scanners, and rogue performance test agents that slip past IP allowlists — generates a continuous stream of guest sessions. Each request triggers a \`GetBasket\` evaluation. Because these sessions share common parent object definitions in the ATG nucleus hierarchy, their lock acquisition requests collide on the same lock identifiers.

The result is a self-reinforcing queue: 150 or more concurrent lock acquisition requests waiting behind each other, each holding the lock for the full duration of the pipeline execution (which itself is waiting for earlier requests to release the same lock). The queue depth grows faster than it drains. The database is completely idle.

### Weak Point 3: Read/Write Lock Mismatches

ATG's locking subsystem supports two lock granularities: a Write Lock (exclusive) and a split Read/Write Lock. Out-of-the-box repository definitions frequently use Write Lock for items that are almost always accessed in read-only fashion — product descriptions, category hierarchies, promotions that have already been evaluated and cached.

A Write Lock is exclusive in both directions: no reader can hold the lock while a writer holds it, and no reader can hold the lock while another reader holds it. This removes all concurrency from read paths. Ten simultaneous product page renders requesting a Write Lock on the same promotion object form a single-file queue, each waiting for the previous to complete. Switching these definitions to a split Read/Write Lock allows all ten readers to hold the lock simultaneously, with writers queuing only against active readers.

---

## Diagnostic Approach

### Step 1: Thread Dump Analysis

When a lock contention incident is active, collect thread dumps from each app server node at 15-second intervals. On WebLogic, use the WebLogic admin console thread dump facility or:

\`\`\`bash
# WebLogic managed server thread dump via wlst
java weblogic.WLST <<WLST_EOF
connect('weblogic','<password>','t3://appnode1:7001')
cd('Servers/ATGServer_1')
threadDump = cmo.getThreadDump()
print(threadDump)
WLST_EOF
\`\`\`

Search the thread dump output for threads blocked on CLM:

\`\`\`
grep -A 20 "ClientLockManager" threaddump.txt | grep -E "BLOCKED|WAITING|atg.service"
\`\`\`

A contention signature looks like this in the raw dump:

\`\`\`
"ExecuteThread: '47' for queue: 'weblogic.kernel.Default'" daemon prio=5 Id=1221 WAITING
    at java.lang.Object.wait(Native Method)
    at atg.service.lockmanager.ClientLockManager.acquireLock(ClientLockManager.java:412)
    at atg.commerce.order.OrderManager.getOrder(OrderManager.java:887)
    at atg.commerce.order.purchase.PurchaseProcessHelper.loadOrder(PurchaseProcessHelper.java:1144)
    at atg.commerce.order.purchase.CartModifierFormHandler.handleAddItemToOrder(CartModifierFormHandler.java:2201)
    ...

"ExecuteThread: '23' for queue: 'weblogic.kernel.Default'" daemon prio=5 Id=1089 TIMED_WAITING
    at java.lang.Object.wait(Native Method)
    at atg.service.lockmanager.ClientLockManager.acquireLock(ClientLockManager.java:412)
    at atg.commerce.order.OrderManager.getOrder(OrderManager.java:887)
    ...
\`\`\`

The lock **owner** — the thread that currently holds the lock and is delaying everyone else — will NOT appear in a BLOCKED or WAITING state. It will appear as RUNNABLE, but its stack trace will show it executing something slow: an external REST call, a long-running collection loop, a slow payment authorization, or a nested lock acquisition on a different object.

\`\`\`
"ExecuteThread: '12' for queue: 'weblogic.kernel.Default'" daemon prio=5 Id=998 RUNNABLE
    at java.net.SocketInputStream.socketRead0(Native Method)        <-- waiting on external socket
    at atg.payment.cybersource.CyberSourceManager.authorize(CyberSourceManager.java:334)
    at atg.commerce.order.purchase.PaymentGroupFormHandler.handleAuthorize(...)
    at atg.commerce.order.purchase.PurchaseProcessHelper.processOrder(...)
    at atg.service.lockmanager.ClientLockManager$LockContext.run(...)
    ...
\`\`\`

The lock owner is blocked on a socket read to an external payment gateway. Every other thread attempting to access the same basket is waiting for this one thread to complete and release the lock.

### Step 2: Lock Server Metrics and Component Verification

Verify the Lock Server addressing configuration. In the ATG nucleus component browser or by inspecting configuration files:

\`\`\`
# /atg/commerce/order/OrderRepository.properties
useGlobalLocks=true
lockServerAddress=lockserver.internal.example.com
lockServerPort=9010

# /atg/scenario/ScenarioManager.properties
useGlobalLocks=true
lockServerAddress=lockserver.internal.example.com
lockServerPort=9010
\`\`\`

Check Lock Server connectivity and active lock count via the ATG Dynamo Admin UI:

\`\`\`
http://appnode1:8080/dyn/admin/nucleus/atg/service/lockmanager/ClientLockManager/
\`\`\`

Key metrics to check:
- **activeLockCount**: active locks held right now. Normal at steady state: under 20. Alert: 50+. Page: 100+.
- **lockWaiters**: threads currently waiting for lock acquisition.
- **averageLockHoldTime**: if this exceeds 500ms, investigate the lock owner stack.

### Step 3: GC Log Correlation

Enable GC logging on the Lock Server JVM if not already active:

\`\`\`bash
# Add to Lock Server JVM startup arguments
-Xlog:gc*:file=/opt/atg/lockserver/logs/gc.log:time,uptime,level,tags:filecount=5,filesize=20m
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200
\`\`\`

Overlay incident timestamps against GC pause events:

\`\`\`bash
# Extract STW pause durations from G1GC log
grep "Pause Full\|Pause Young\|Pause Mixed" /opt/atg/lockserver/logs/gc.log | \
  awk '{print $1, $NF}' | sort -k2 -rn | head -20
\`\`\`

A single heap sizing imbalance — for example, a 2GB heap with a 1.5GB live set, forcing frequent full GC cycles — can generate 4-8 second STW pauses that are indistinguishable from a dead network connection between app nodes and the Lock Server. The app nodes time out their lock acquisition attempts, log errors, and retry, while the Lock Server resumes after the GC pause with a full queue.

---

## Case Study 1: Black Friday Bot Flood

### Context

A retail ATG implementation with eight app nodes and one Lock Server node. Traffic on Black Friday morning was approximately 4x normal peak. Incident triggered at 09:47 EST: basket API latency climbed from 180ms average to 3 minutes 20 seconds. Database AWR showed 0.3 average active sessions. CPU on all app nodes: 8%. Thread dumps showed 140+ threads in WAITING state on \`ClientLockManager.acquireLock\`.

### Root Cause

Analysis of access logs showed 38% of the basket API traffic was coming from fourteen IP address ranges associated with price comparison aggregators and automated crawlers. Each request triggered the full \`GetBasket\` pipeline evaluation. The OOTB guest profile lock topology routed all lock acquisitions through the central Lock Server using a common parent object namespace. Lock acquisition requests were colliding on the same lock identifiers — different guest sessions but sharing a common parent profile object definition that the OOTB code locked at evaluation time.

The Lock Server itself was healthy. It was processing requests. The queue depth had simply reached a point where the drain rate could not keep up with the arrival rate of new lock requests.

### Resolution

Two changes applied in sequence:

1. Added a guest session short-circuit check at the entry point of the \`GetBasket\` pipeline — before any lock acquisition. If the session has no persisted profile ID (indicating a new anonymous session), the pipeline returns an empty basket reference without acquiring a lock. Guest basket creation is deferred until the first item is added.

2. Switched guest profile repository definition from \`useGlobalLocks=true\` to \`useGlobalLocks=false\`. Guest sessions are single-node by design; there is no legitimate cross-node consistency requirement for an ephemeral guest profile.

Lock queue depth dropped below 10 within five minutes of deployment. Basket API latency returned to sub-200ms.

---

## Case Study 2: Payment Gateway Lock Extension

### Context

A post-deployment incident triggered forty-eight hours after a new payment gateway integration went live. Incident pattern: progressive degradation starting at 14:00 on a Tuesday, escalating to full checkout unavailability by 14:40. Database: idle. App node CPU: low. Thread dumps: 80+ threads WAITING on \`ClientLockManager.acquireLock\`. Lock owner: one thread, RUNNABLE, stack trace showing a socket read against the new payment gateway's \`/authorize\` endpoint.

### Root Cause

The new payment integration had been written to call the external \`/authorize\` REST endpoint from inside the ATG order pipeline, after basket lock acquisition but before lock release. This is a common implementation mistake: the developer needed access to the locked order object to construct the payment authorization request, so the external call was placed inside the lock boundary.

The payment gateway's \`/authorize\` endpoint had an average response time of 8 seconds and an occasional timeout tail latency of 45+ seconds on high-load days. The basket lock was held for the entire duration of the external call. Other threads attempting to access the same basket (retry logic, concurrent tab submissions, fraud check pipelines) were queued behind the lock holder.

With 80 concurrent orders in flight and an 8-second average hold time, the math was straightforward: a queue of 80 requests at 8 seconds each would take over 10 minutes to drain sequentially through a single-threaded lock. Thread pool exhaustion followed within minutes.

### Resolution

The payment call was extracted from inside the lock boundary. The order pipeline was restructured as follows:

1. Acquire basket lock
2. Read order details required for payment request construction
3. Release basket lock
4. Call external payment gateway \`/authorize\` (no lock held)
5. Re-acquire basket lock
6. Update order with authorization response
7. Release basket lock

The double lock acquisition adds a small overhead on successful payment flows, but it eliminates the possibility of the lock hold time being extended by external service latency. Lock hold time dropped from 8-45 seconds to under 40 milliseconds.

---

## Prevention and Configuration Best Practices

### Lock Topology Audit

Review every repository definition that carries a \`useGlobalLocks\` setting. Apply the following decision criteria:

| Repository Item | useGlobalLocks | Rationale |
|---|---|---|
| Shopping Cart / Order | true | Multiple nodes may access same cart |
| Authenticated Customer Profile | true | Profile state must be consistent across nodes |
| Guest / Anonymous Profile | false | Ephemeral, single-node scope |
| Product Catalog Item | false | Read-heavy, catalog managed by admin tools not commerce tier |
| Promotion Definition | false | Read-only at runtime; updates via admin, not storefront |
| Inventory Cache | Depends | If using real-time inventory across nodes: true; if using local cache with async sync: false |

### Guest Session Short-Circuit

Add a nucleus pipeline step before any basket lock acquisition:

\`\`\`xml
<!-- /atg/commerce/order/purchase/GuestSessionCheck.xml -->
<component name="GuestSessionCheck"
           class="atg.commerce.order.purchase.GuestSessionCheckDroplet">
  <property name="bypassLockIfGuestSession" value="true"/>
</component>
\`\`\`

The check should evaluate whether a profile ID has been persisted to the session. If no persisted profile exists, skip lock acquisition and return a transient basket reference.

### Read/Write Lock Split

For read-heavy repository items that use Write Lock today, switch to the split lock type:

\`\`\`
# /atg/commerce/catalog/ProductCatalog.properties
# Before:
lockType=WRITE

# After:
lockType=READ_WRITE
\`\`\`

With \`READ_WRITE\` lock type, concurrent read operations no longer queue behind each other. Writers still acquire an exclusive lock and queue against active readers, but the common case — many readers, infrequent writes — becomes fully concurrent.

### Never Hold Locks Across External Calls

Enforce this as a code review standard. Any call that crosses a network boundary — payment gateways, inventory systems, fraud scoring APIs, tax calculation services — must occur outside the ATG lock boundary. The pattern is:

1. Acquire lock, read state, release lock.
2. Call external service (no lock held).
3. Acquire lock, write result, release lock.

If the external call fails and the order must be rolled back, handle that as an exception flow, not by extending the lock hold time.

### Lock Server JVM Tuning

The Lock Server JVM should be tuned independently of the app server JVMs. Recommended configuration:

\`\`\`bash
# Lock Server JVM arguments
-server
-Xms2g
-Xmx2g
-XX:+UseG1GC
-XX:MaxGCPauseMillis=100
-XX:G1HeapRegionSize=16m
-XX:InitiatingHeapOccupancyPercent=35
-Xlog:gc*:file=/opt/atg/lockserver/logs/gc-%t.log:time,uptime,level,tags:filecount=10,filesize=50m
\`\`\`

Key tuning rationale:
- **Fixed heap (-Xms = -Xmx)**: Eliminates heap resize pauses. The Lock Server has a predictable memory profile.
- **G1GC**: Provides bounded pause time guarantees that the parallel collector does not. A 100ms target is achievable for a well-sized heap.
- **Conservative IHOP (35%)**: Triggers concurrent marking earlier, reducing the likelihood of full GC cycles caused by allocation exhausting the heap before concurrent marking can complete.

### JMX Monitoring

Expose Lock Server metrics via JMX and configure alerting:

\`\`\`bash
# Add to Lock Server JVM startup arguments
-Dcom.sun.management.jmxremote
-Dcom.sun.management.jmxremote.port=9099
-Dcom.sun.management.jmxremote.authenticate=false
-Dcom.sun.management.jmxremote.ssl=false
\`\`\`

Query active lock count via JMX command line:

\`\`\`bash
# Using jmxterm or equivalent
java -jar jmxterm.jar <<JMXEOF
open lockserver.internal.example.com:9099
bean atg.service.lockmanager:type=ClientLockManager
run getActiveLockCount
run getLockWaiterCount
run getAverageLockHoldTimeMs
exit
JMXEOF
\`\`\`

Alerting thresholds:

| Metric | Warning | Critical |
|---|---|---|
| activeLockCount | 50 | 100 |
| lockWaiterCount | 20 | 50 |
| averageLockHoldTimeMs | 500ms | 2000ms |
| LockServer JVM GC STW pause | 500ms | 2000ms |

---

## Summary

When an Oracle ATG commerce platform exhibits multi-minute latency on basket and checkout operations while the database shows near-zero utilization, the database metrics are not reassuring — they are a diagnostic clue. The Oracle database is idle because nothing is asking it to do work. The contention lives upstream in the ATG Client Lock Manager, where JVM threads queue for lock acquisition behind a single thread that is either waiting on an external service, paused by a JVM GC event, or stuck in a code path that holds the lock far longer than the transaction warrants.

The OOTB ATG configuration makes this failure mode easy to stumble into: global locking applied where local locking would suffice, no guest session short-circuit before lock acquisition, write-exclusive locks on read-heavy items, and no enforcement of the rule that external calls must never occur inside a lock boundary.

The diagnostic path is thread dumps, not AWR reports. The equivalent of Oracle's LAST_CALL_ET in the ATG world is lock hold time and the stack depth of the lock owner thread. Find the thread holding the lock. Find what it is waiting on. Fix that wait. The queue clears.

Prevention requires treating the CLM configuration as a first-class architectural concern: auditing \`useGlobalLocks\` settings by item type, implementing guest session short-circuits, splitting read/write lock types where appropriate, enforcing no-lock-across-external-calls as a code review gate, tuning the Lock Server JVM for minimal GC pause times, and monitoring lock queue depth with alert thresholds that fire before thread exhaustion occurs.

A Lock Server that restarts with 150 orphaned locks is not a component failure. It is an audit finding waiting to be written.`,
};

async function main() {
  console.log('Inserting ATG lock server blog post...');
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
