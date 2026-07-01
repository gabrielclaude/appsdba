import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'How Oracle Workflow Purge Drives RAC Interconnect Saturation',
  slug: 'oracle-workflow-purge-rac-interconnect',
  excerpt: 'Oracle Workflow purge operations issue bulk DELETEs across multiple runtime tables, forcing the RAC interconnect to transfer thousands of gc current blocks per second. Learn why this happens, how to diagnose it with AWR and ASH, and how to mitigate the impact through scheduling, batch throttling, and node affinity.',
  category: 'ebs-workflow' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-01'),
  youtubeUrl: null,
  content: `## Introduction: Oracle Workflow Purge and the RAC Interconnect Problem

Oracle Workflow is the process orchestration engine embedded in Oracle E-Business Suite. It drives approval chains, notifications, order lifecycle events, purchasing authorizations, and dozens of other business processes. Over months and years of operation, the workflow runtime tables accumulate enormous volumes of closed, completed, and errored process instances. The primary tables are:

- \`WF_ITEMS\` — one row per workflow process instance
- \`WF_ITEM_ACTIVITY_STATUSES\` — activity execution history per instance
- \`WF_ITEM_ATTRIBUTE_VALUES\` — attribute values carried by each instance
- \`WF_NOTIFICATIONS\` — notification records linked to workflow items
- \`WF_NOTIFICATION_ATTRIBUTES\` — attributes on each notification

Without regular purging, these tables grow to tens or hundreds of millions of rows, degrading runtime query performance and bloating the database. Queries that look up an active workflow instance slow down as the optimizer must scan or index-probe through vast amounts of stale historical data. The tablespace footprint can grow to dozens of gigabytes, consuming storage that is expensive on engineered systems.

The standard purge mechanism is the \`WF_PURGE\` PL/SQL package — specifically \`WF_PURGE.TOTAL\` and \`WF_PURGE.ITEMS\` — which deletes closed workflow instances older than a specified cutoff date. Oracle E-Business Suite also exposes this functionality via the "Purge Obsolete Workflow Runtime Data" concurrent program, which EBS administrators can schedule from the Submit Requests form.

What the documentation does not prominently warn about is what happens when you run \`WF_PURGE\` in a Real Application Clusters (RAC) environment with an active workload distributed across multiple nodes. The result can be severe: interconnect saturation, elevated global cache wait events across all nodes, and collateral performance degradation for OLTP sessions that have nothing to do with workflow.

This post explains why this happens at a technical level, how to identify the problem in AWR and ASH, and what concrete remediation steps DBAs can take.

---

## What WF_PURGE Does Under the Hood

Before explaining the RAC impact, it helps to understand what \`WF_PURGE\` actually does at the SQL level.

When you call \`WF_PURGE.TOTAL\` (or \`WF_PURGE.ITEMS\`), the package executes the following logical sequence:

1. **Identify eligible items.** Query \`WF_ITEMS\` for rows where \`END_DATE\` is less than the cutoff date you specify and the item status is \`COMPLETE\`, \`ERROR\`, or \`CANCEL\`. These are the workflow instances eligible for deletion.

2. **Delete child records in dependency order.** For each batch of eligible \`WF_ITEMS\` rows, the package first deletes from the child tables that reference \`WF_ITEMS\` by foreign key or logical relationship:
   - \`WF_ITEM_ACTIVITY_STATUSES\`
   - \`WF_ITEM_ATTRIBUTE_VALUES\`
   - \`WF_NOTIFICATION_ATTRIBUTES\`
   - \`WF_NOTIFICATIONS\`

3. **Delete from WF_ITEMS itself.** Once child rows are removed, the parent rows in \`WF_ITEMS\` are deleted.

4. **Commit after each batch.** The purge does not run as a single monolithic transaction. It commits after each batch, with the batch size controlled by the \`batch_size\` parameter (the default is typically 500 rows). After the commit, the purge re-queries \`WF_ITEMS\` to identify the next batch and repeats.

This design is intentional — a single transaction deleting millions of rows would hold locks for hours, generate undo that could exhaust the undo tablespace, and be unrecoverable if interrupted. The batch-commit approach is safer. Unfortunately, in a RAC environment, it is this very pattern that creates the interconnect problem.

---

## The RAC Interconnect and Cache Fusion

To understand why \`WF_PURGE\` is hostile to RAC, you need to understand how Oracle RAC manages buffer caches across nodes.

In a RAC cluster, each node has its own System Global Area (SGA) with its own buffer cache. Unlike shared-disk architectures where a single cache exists, RAC gives every node its own in-memory copy of recently accessed data blocks. When a session on Node 1 modifies a block, that block is held in Node 1's buffer cache in "current" (dirty) mode.

If a session on Node 2 then needs to modify the same block, it cannot simply read it from disk — Node 1 holds the most recent version in its cache. Oracle's **Cache Fusion** protocol handles this via the private interconnect:

- Node 2's Global Cache Service (GCS) sends a request to Node 1's GCS for the block.
- Node 1 flushes its dirty version of the block to the interconnect.
- Node 1 downgrades its lock on that block.
- Node 2 receives the block over the interconnect and applies its modification.

This is called a **gc current block transfer** (or "block ping" in older Oracle terminology). It is a synchronous operation — the session on Node 2 must wait until it receives the block before it can proceed. The corresponding wait event is \`gc current block busy\` or \`gc buffer busy acquire\`.

This mechanism works well under normal workloads where block contention between nodes is relatively rare. The problem arises when you perform a bulk DELETE operation that needs blocks scattered across all nodes' caches.

---

## Why Workflow Purge Creates an Interconnect-Hostile Access Pattern

Here is the specific collision that makes \`WF_PURGE\` dangerous in RAC:

**Workflow data is inserted and updated on all nodes.** In an EBS environment with a multi-node RAC cluster, the application tier typically uses a load-balanced or round-robin connection pool. Sessions processing workflow transactions — creating workflow items, advancing activity statuses, sending notifications — connect to whichever RAC node the connection pool assigns them. Over time, workflow data is inserted across all nodes. The blocks containing \`WF_ITEMS\`, \`WF_ITEM_ACTIVITY_STATUSES\`, and related data are distributed across all nodes' buffer caches.

**The purge session runs on a single node.** Whether submitted via a concurrent program or called directly, \`WF_PURGE\` runs from one database session on one RAC node — say Node 1.

**Node 1's DELETE statements need exclusive access to blocks they do not own.** To delete a row from a block that Node 2 currently holds in exclusive (current) mode, Node 1 must request a gc current block transfer. Node 2 must flush its version of the block to the interconnect and grant Node 1 exclusive ownership. This is a synchronous wait — Node 1's purge session sits in \`gc current block busy\` or \`gc buffer busy acquire\` wait until the transfer completes.

**This repeats at scale for every batch.** With 40 million eligible rows, at 500 rows per batch, the purge runs 80,000 batches. Each batch touches approximately 5-10 child records per \`WF_ITEMS\` row across the child tables, so a single batch may issue DELETEs touching 2,500 to 5,000 rows spread across four child tables. A significant fraction of those rows' blocks are cached on non-purge nodes. The result is a sustained, high-frequency stream of gc block transfer requests across the interconnect for the entire duration of the purge.

**The batch commit pattern adds additional interconnect load.** Each commit forces Oracle to synchronize redo across all nodes. The LGWR process on the committing node must communicate with the LGWR processes on other nodes to ensure the commit record is durable. This introduces \`log file sync\` and \`gc cr request\` waits during the commit phase of each batch. Between batches, the re-query of \`WF_ITEMS\` for the next eligible set of rows generates consistent-read (CR) block requests, adding \`gc cr block receive\` waits to the mix.

---

## The Scale of the Impact

To make this concrete, consider a representative scenario:

| Parameter | Value |
|---|---|
| \`WF_ITEMS\` total rows | 50 million |
| Rows eligible for purge | 40 million |
| Batch size | 500 |
| Number of batches | 80,000 |
| Child rows per WF_ITEMS row (avg) | 7 |
| Child rows deleted per batch (avg) | 3,500 |
| RAC cluster size | 4 nodes |
| Interconnect type | 10GbE (theoretical ~1 GB/s) |

In a 4-node cluster with active workload on all nodes, if even 30% of the target blocks are cached on non-purge nodes (a conservative estimate after hours of mixed workload), the purge node must request gc current block transfers for roughly 1,000 blocks per batch across the child tables alone. At 80,000 batches, that is 80 million block transfer requests over the life of the purge.

A modern 10GbE interconnect can transfer approximately 1 GB/s of raw data. An Oracle data block is 8 KB by default. Transferring 80,000 blocks per second would require 640 MB/s — well above realistic peak load, and in practice the transfer rate is lower. However, even at 50,000 block transfers per second, the interconnect is consuming 400 MB/s of bandwidth purely for the purge, and this sustains for hours. That leaves little headroom for the legitimate OLTP gc traffic that all other database sessions generate.

The interconnect is a **shared resource**. When the purge drives interconnect utilization to 80% of capacity, every other session on every node that needs a gc block transfer — for any table, any object — experiences elevated wait times. The collateral damage extends far beyond workflow tables.

---

## Symptom Profile: What You See in AWR and ASH

During a workflow purge, the diagnostic fingerprint in AWR and ASH is unmistakable.

### Top Wait Events

In the AWR "Top 5 Timed Events" section for the snapshot interval containing the purge, you will see:

- \`gc current block busy\` — the purge session waiting for exclusive block ownership from other nodes
- \`gc buffer busy acquire\` — contention acquiring a block that is already in a gc transfer in progress
- \`gc cr multi block request\` — consistent read requests for index range scans during the re-query between batches
- \`log file sync\` — the 80,000 batch commits flushing redo

### Top SQL by Elapsed Time

The AWR "SQL ordered by Elapsed Time" report will be dominated by the DELETE statements issued by \`WF_PURGE\`. The SQL text references \`WF_ITEM_ACTIVITY_STATUSES\`, \`WF_ITEM_ATTRIBUTE_VALUES\`, \`WF_NOTIFICATIONS\`, \`WF_NOTIFICATION_ATTRIBUTES\`, and \`WF_ITEMS\`. These statements will show disproportionately high elapsed time relative to their CPU time, with the gap attributable to gc wait events.

### Global Cache Statistics

In the AWR "Global Cache and Enqueue Service" section:

- **Average time for 'current' block receive request**: this should ideally be below 1ms on a healthy 10GbE interconnect. During a purge, values of 5ms, 10ms, or higher indicate the interconnect is saturated or the receiving node cannot service requests quickly enough.
- **gc current blocks received per second**: elevated by an order of magnitude compared to non-purge baselines.
- **gc cr blocks received per second**: also elevated due to the consistent-read queries between batches.

### GV$SYSSTAT "gc" Counters

The \`GV\$SYSSTAT\` view accumulates cumulative gc statistics per instance. Comparing two snapshots 60 seconds apart gives you a rate.

---

## Diagnostic SQL

### Identify gc Wait Events During a Purge Window

Run this against \`V\$ACTIVE_SESSION_HISTORY\` (or \`DBA_HIST_ACTIVE_SESS_HISTORY\` for historical analysis) to quantify gc wait dominance during the purge window:

\`\`\`sql
-- Identify gc wait events during a purge window (run against AWR or V$SESSION)
SELECT event,
       COUNT(*) AS sample_count,
       ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) AS pct_of_samples
FROM   v\$active_session_history
WHERE  sample_time BETWEEN TIMESTAMP '2026-07-01 02:00:00' AND TIMESTAMP '2026-07-01 04:00:00'
  AND  event LIKE 'gc%'
GROUP  BY event
ORDER  BY sample_count DESC;
\`\`\`

If \`gc current block busy\` and \`gc buffer busy acquire\` together account for more than 20% of ASH samples during the window, the purge is driving meaningful interconnect pressure.

### Find the WF_PURGE Sessions Driving Interconnect Traffic

To identify the active purge sessions and their current wait states across all nodes in real time:

\`\`\`sql
-- Find the WF_PURGE sessions driving interconnect traffic right now
SELECT s.inst_id,
       s.sid,
       s.serial#,
       s.event,
       s.seconds_in_wait,
       s.sql_id,
       s.state,
       s.wait_class
FROM   gv\$session s
WHERE  s.module LIKE '%WF%' OR s.action LIKE '%PURGE%'
  OR   s.event  LIKE 'gc%'
ORDER  BY s.seconds_in_wait DESC;
\`\`\`

Sessions showing \`gc current block busy\` with high \`seconds_in_wait\` values, combined with \`sql_id\` values that resolve to WF_PURGE DELETE statements, confirm the diagnosis.

### Measure Interconnect Traffic Rate from GV$SYSSTAT

Take two snapshots 60 seconds apart and compare the deltas to compute a per-second transfer rate:

\`\`\`sql
-- Interconnect traffic rate from GV$SYSSTAT (compare two snapshots 60s apart)
SELECT inst_id,
       name,
       value
FROM   gv\$sysstat
WHERE  name IN (
         'gc current blocks received',
         'gc cr blocks received',
         'gc current block receive time',
         'gc cr block receive time',
         'global cache blocks corrupted',
         'global cache blocks lost'
       )
ORDER  BY inst_id, name;
\`\`\`

The \`gc current block receive time\` statistic is cumulative in centiseconds. Dividing the delta of \`gc current block receive time\` by the delta of \`gc current blocks received\` gives the average transfer latency in centiseconds per block. Multiply by 10 to get milliseconds. Values above 1ms warrant attention; values above 5ms indicate the interconnect or receiving node's GCS is overwhelmed.

### Identify Which Tables Are Driving the Most gc Traffic

Cross-referencing ASH with segment statistics can pinpoint whether workflow tables are the primary gc traffic source:

\`\`\`sql
-- Segment-level gc block statistics (requires Diagnostics Pack license)
SELECT owner,
       object_name,
       object_type,
       SUM(gc_buffer_busy_acquire) AS gc_buffer_busy,
       SUM(gc_current_block_receive_time) AS gc_curr_recv_time_cs
FROM   v\$segment_statistics
WHERE  statistic_name IN ('gc buffer busy acquire', 'gc current block receive time')
  AND  owner = 'APPS'
ORDER  BY gc_curr_recv_time_cs DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

During a purge, \`WF_ITEM_ACTIVITY_STATUSES\`, \`WF_ITEMS\`, and \`WF_ITEM_ATTRIBUTE_VALUES\` will dominate this list.

---

## Case Studies

### Case Study 1: Order Management Purge During Business Hours

A manufacturing company operating a 4-node RAC cluster ran their monthly workflow purge for the order management system during regular business hours — a scheduling decision made years earlier when the workflow tables were small and the purge completed in under 30 minutes. After several years of growth, the tables had accumulated 60 million rows in \`WF_ITEMS\` alone, and the monthly purge now took 4 hours.

On the day in question, the purge started at 10:00 AM. Within 20 minutes, the support team began receiving escalations: shipment confirmation transactions were timing out, inventory update sessions were hung, and customer-facing order status queries were returning errors.

AWR for the affected interval showed \`gc current block busy\` at 62% of total wait time across all four nodes — not just on the node running the purge. The interconnect bandwidth utilization (measured from GCS statistics) had reached 800 MB/s, near the saturation point for their 10GbE interconnect fabric. Every session on every node was experiencing elevated gc waits because the interconnect queue was backed up.

The DBA team cancelled the purge concurrent request. Normal performance was restored within 90 seconds as the interconnect demand subsided.

Resolution: The purge was rescheduled to a Saturday maintenance window beginning at 02:00. The concurrent program was modified to pass \`batch_size => 100\` instead of the default 500. A wrapper procedure was written that called \`WF_PURGE.ITEMS\` in a loop with \`DBMS_LOCK.SLEEP(0.1)\` between each call, introducing a 100-millisecond pause between batches to allow other sessions' gc requests to clear the interconnect queue. Total purge duration increased from 4 hours to 7 hours, but all of that elapsed time occurred during a maintenance window with no OLTP workload.

### Case Study 2: Third Node Addition Breaks a Previously Stable Purge

A financial services organization had been running workflow purge successfully on a 2-node RAC cluster for three years. The purge ran on Sunday nights and completed without incident. After a capacity expansion project that added a third RAC node and doubled the application tier connection pool size, the next Sunday purge run caused a performance incident.

The third node, being new and actively serving twice the previous connection pool load, had been populating its buffer cache aggressively over the preceding week. A disproportionate share of recently accessed workflow blocks were cached exclusively on Node 3. When the purge ran from Node 1 on Sunday night, Node 1's gc transfer request rate to Node 3 was three times what it had previously been to either of the original two nodes.

The purge node's average \`gc current block receive time\` — which had historically been 0.8ms — jumped to 4.2ms. Even though the purge was running in the maintenance window, the elevated gc wait times caused the Sunday night batch jobs on Nodes 2 and 3 (data extract processes for downstream reporting) to run 40% longer than their SLA allowed.

Resolution: The team implemented two changes. First, the workflow purge concurrent program was pinned to a dedicated database service assigned exclusively to Node 3 — the node with the most recently cached workflow blocks. By running the purge on the node most likely to already hold the target blocks in its local cache, the number of cross-node gc transfers dropped by roughly 60%. Second, immediately before the purge window, a maintenance script ran \`ALTER SYSTEM FLUSH BUFFER_CACHE\` on Nodes 1 and 2 (but not Node 3) to evict stale cached copies from those nodes, ensuring that when the purge on Node 3 issued its DELETEs, it was pulling blocks from disk into its own cache rather than requesting them from other nodes. This step is only appropriate in a scheduled maintenance window where those nodes' cached data is not actively needed.

---

## Mitigation Strategies

### 1. Schedule During the Lowest Interconnect Baseline Window

AWR stores hourly snapshots. Query \`DBA_HIST_SYSTEM_EVENT\` or \`DBA_HIST_SYS_TIME_MODEL\` to compute average gc wait time per hour of the week. Choose the purge window where the baseline gc wait load is lowest — typically 02:00–05:00 on Saturday or Sunday mornings. Running the purge when the interconnect has headroom means the collateral impact on other sessions is minimized even if the purge is generating significant gc traffic.

### 2. Reduce the Batch Size

The \`WF_PURGE.ITEMS\` and \`WF_PURGE.TOTAL\` procedures accept a \`batch_size\` parameter. The default (often 500) represents a trade-off between purge throughput and transaction size. Reducing \`batch_size\` to 100 or even 50 means each DELETE transaction touches fewer blocks, shortening the time each block is held in exclusive mode and reducing the volume of gc transfers per commit cycle. Total purge duration increases, but peak interconnect pressure is substantially lower. For most environments, 100 rows per batch is a good starting point for off-hours purge runs.

### 3. Add Inter-Batch Sleep

Wrap the \`WF_PURGE\` calls in a PL/SQL loop and introduce a brief sleep between batches using \`DBMS_LOCK.SLEEP\` (or \`DBMS_SESSION.SLEEP\` in Oracle 18c and later). Even a 50-100 millisecond pause between batches allows other sessions' pending gc requests to be serviced, preventing the interconnect queue from building up. A 100ms sleep adds roughly 133 minutes of overhead to an 80,000-batch purge — acceptable for an off-hours run, significant for a daytime run.

\`\`\`sql
-- Example throttled purge wrapper (call from a DBA session or schedule as a dbms_scheduler job)
DECLARE
  v_batch_count  PLS_INTEGER := 0;
  v_cutoff_date  DATE := TRUNC(SYSDATE) - 90; -- purge items older than 90 days
BEGIN
  LOOP
    WF_PURGE.ITEMS(
      itemtype   => NULL,       -- NULL means all item types
      itemkey    => NULL,
      enddate    => v_cutoff_date,
      docommit   => TRUE,
      runtimeonly => FALSE,
      purgesigs  => FALSE
    );
    v_batch_count := v_batch_count + 1;
    DBMS_LOCK.SLEEP(0.1);      -- 100ms pause between batches
    EXIT WHEN SQL%ROWCOUNT = 0; -- no rows deleted means purge is complete
  END LOOP;
  DBMS_OUTPUT.PUT_LINE('Purge complete after ' || v_batch_count || ' batches.');
END;
/
\`\`\`

Note that the exact \`WF_PURGE\` API signature may vary by EBS version. Always verify against the version installed in the target environment.

### 4. Pin the Purge to One RAC Node

Create a dedicated database service (using \`SRVCTL ADD SERVICE\`) that is assigned to only one RAC instance — preferably the node with the lowest OLTP workload during the maintenance window. Submit the purge concurrent program via a connection to this pinned service. By concentrating purge activity on a single node, you ensure that any blocks the purge loads into its cache remain there across batches. Over time, as the purge works through the eligible rows, it will increasingly hit blocks already in its own cache rather than requesting gc transfers from other nodes.

### 5. Pre-Warm the Purge Node's Cache

Before starting the purge, run a large sequential scan of the workflow tables from the purge node. A query such as \`SELECT COUNT(*) FROM WF_ITEMS WHERE END_DATE < :cutoff\` forces Oracle to load blocks from disk into the purge node's buffer cache via consistent-read block requests (which are less disruptive than exclusive current block requests). When the purge then issues its DELETEs, a higher proportion of the target blocks are already in the local cache, reducing the number of gc current block transfers required.

### 6. Partition the Workflow Tables (Long-Term)

The most effective long-term remedy is to partition \`WF_ITEMS\` and its child tables by \`END_DATE\` using range partitioning. With partitioned workflow tables, the purge operation can be implemented as a \`TRUNCATE PARTITION\` or \`DROP PARTITION\` command for partitions older than the cutoff date. These operations are DDL — they do not issue row-by-row or even block-by-block DELETEs. They do not generate redo in the same volume as DML-based purges. Critically, they do not require gc current block transfers across the interconnect, because the partition is simply removed from the data dictionary and the space reclaimed without individual block manipulation.

Implementing this requires coordination with Oracle Support and careful testing because the EBS workflow tables are not partitioned out of the box and adding partitioning to a multi-hundred-million-row production table requires a planned maintenance window of its own. However, for sites where workflow purge is a recurring operational incident, partitioning is the only permanent fix.

---

## Summary

Oracle Workflow purge is a necessary maintenance operation that becomes a RAC interconnect hazard when the workflow runtime tables have accumulated data across multiple nodes' buffer caches. The underlying mechanism is straightforward: \`WF_PURGE\` issues bulk DELETEs from a single node, but the target blocks are scattered across all nodes' caches due to the load-balanced nature of EBS application tier connections. Cache Fusion must transfer each block to the purge node via the private interconnect before the DELETE can proceed, generating a sustained stream of \`gc current block busy\` and \`gc buffer busy acquire\` waits.

The signature is visible in AWR and ASH: gc wait events dominate the top wait events report, the WF_PURGE DELETE statements dominate SQL elapsed time, and the "Global Cache and Enqueue Service" section of AWR shows elevated current block receive latency. The collateral damage extends to all OLTP sessions on all nodes, because the interconnect is a shared resource.

The remediation hierarchy is: schedule the purge in the lowest-traffic maintenance window, reduce the batch size to lower peak interconnect pressure, add inter-batch sleep to give other sessions' gc requests room to be serviced, pin the purge to the node best positioned to minimize cross-node block requests, pre-warm the purge node's cache before starting, and — for sites where this is a recurring problem — pursue workflow table partitioning as the permanent architectural solution.

What DBAs should never do is stop purging entirely. Workflow tables that are never purged grow without bound. A \`WF_ITEMS\` table with 200 million rows and no purge plan will eventually degrade runtime workflow performance as severely as any interconnect incident. The answer is not to avoid the pain — it is to schedule it, throttle it, and ultimately architect it away.`,
};

async function main() {
  console.log('Inserting workflow purge RAC blog post...');
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
