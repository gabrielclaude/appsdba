import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS FNDWFPR RAC Interconnect Saturation: Pinning DBMS_PARALLEL_EXECUTE Worker Jobs to a Single Instance',
  slug: 'ebs-fndwfpr-rac-dbms-parallel-execute-instance-pinning',
  excerpt:
    'FNDWFPR is pinned to instance 1 — so why is your RAC interconnect saturated every night? This post explains how FNDWFPR uses DBMS_PARALLEL_EXECUTE to spawn DBMS_SCHEDULER worker jobs that Oracle distributes across all nodes, the Cache Fusion traffic that results, and the service-based job class technique that pins all workers back to the parent instance.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-17'),
  youtubeUrl: null,
  content: `Every Oracle DBA who manages EBS 12.2 on a RAC cluster has seen the pattern at least once: you pin the FNDWFPR concurrent program to instance 1 in the EBS Concurrent Manager configuration, you verify the pin, you submit the job — and your RAC interconnect still lights up like a Christmas tree during the 11 PM maintenance window.

The reason is counterintuitive, and it is one of the most under-documented traps in Oracle EBS RAC administration: **FNDWFPR itself runs on instance 1, but the worker jobs it creates internally do not.**

This post explains the full mechanism, shows you how to confirm the problem with AWR and ASH queries, and walks through the service-based DBMS_SCHEDULER job class approach that solves it cleanly.

---

## The Problem ExampleCorp Saw

A large retail enterprise — call it ExampleCorp — runs Oracle E-Business Suite 12.2 on a 3-node RAC cluster. Database performance degrades every night between 11 PM and 1 AM. The AWR report for that window is dominated by RAC Cache Fusion wait events: \`gc buffer busy acquire\`, \`gc cr multi block request\`, and \`gc current block 2-way\`.

The DBA team's first move was to check which process was driving the interconnect load. ASH showed sessions with \`MODULE = 'FNDWFPR'\` or \`PROGRAM LIKE '%FNDWFPR%'\` — the Workflow Background Process purge. Fair enough. They checked the EBS Concurrent Manager configuration and confirmed that FNDWFPR's concurrent queue was assigned to the node connected to instance 1. FNDWFPR was, by every EBS measure, pinned.

So why were the gc wait events coming from sessions on instances 2 and 3?

The answer lies inside FNDWFPR's implementation.

---

## What FNDWFPR Does (and How It Does It)

FNDWFPR — the Oracle Workflow Background Process Purge — cleans up completed, errored, and timed-out workflow items from the core workflow tables:

- \`WF_ITEMS\` — the top-level workflow item record
- \`WF_ITEM_ATTRIBUTE_VALUES\` — runtime attribute values associated with each item
- \`WF_ITEM_ACTIVITY_STATUSES\` — per-activity execution history
- \`WF_NOTIFICATIONS\` — workflow notification records
- \`WF_NOTIFICATION_ATTRIBUTES\` — notification payload attributes

It accepts parameters: \`item_type\`, \`begin_date\`, \`end_date\`, \`purge_mode\` (TEMP for temporary items, TOTAL for all), and \`correlation\`. For large EBS deployments, these tables grow to gigabyte scale quickly — especially in manufacturing and order management environments where workflow events fire on every transaction.

Because the volume of data to be purged can be enormous, Oracle implemented FNDWFPR using \`DBMS_PARALLEL_EXECUTE\`. Instead of one session doing all the deletes serially, the program:

1. Creates a parallel execution task via \`DBMS_PARALLEL_EXECUTE.CREATE_TASK\`
2. Divides the \`WF_ITEMS\` rows into chunks by ROWID range using \`DBMS_PARALLEL_EXECUTE.CREATE_CHUNKS_BY_ROWID\`
3. Calls \`DBMS_PARALLEL_EXECUTE.RUN_TASK\` with a \`parallel_level\` parameter (typically 2–8 workers depending on configuration)

The \`RUN_TASK\` call is where the trouble starts. Internally, \`DBMS_PARALLEL_EXECUTE.RUN_TASK\` calls \`DBMS_SCHEDULER.CREATE_JOB\` for each parallel worker — one job per chunk batch. These are real Oracle Scheduler jobs. They appear in \`DBA_SCHEDULER_JOBS\` and their execution history appears in \`DBA_SCHEDULER_JOB_RUN_DETAILS\`.

And Oracle Scheduler, left to its own devices on a RAC cluster, distributes those jobs across all available instances.

---

## DBMS_PARALLEL_EXECUTE in Oracle RAC: The Hidden Behavior

Here is the mechanics spelled out precisely:

\`\`\`
FNDWFPR (session on instance 1)
  └── DBMS_PARALLEL_EXECUTE.RUN_TASK(parallel_level => 4)
        ├── DBMS_SCHEDULER.CREATE_JOB('PARALLEL_EXECUTE$_xyz_0001') → runs on instance 1
        ├── DBMS_SCHEDULER.CREATE_JOB('PARALLEL_EXECUTE$_xyz_0002') → runs on instance 2
        ├── DBMS_SCHEDULER.CREATE_JOB('PARALLEL_EXECUTE$_xyz_0003') → runs on instance 3
        └── DBMS_SCHEDULER.CREATE_JOB('PARALLEL_EXECUTE$_xyz_0004') → runs on instance 1
\`\`\`

The Oracle Scheduler treats these jobs exactly like any other scheduled job. It does not know or care that the job's purpose is to help a parallel task executing on instance 1. It applies its normal load balancing logic and distributes the workers across the available instances in the cluster.

The critical point: **the EBS Concurrent Manager pin controls which instance FNDWFPR's own session runs on. It has no authority over the DBMS_SCHEDULER jobs that FNDWFPR spawns internally.**

---

## Why Cross-Instance Worker Distribution Causes Interconnect Saturation

This is a Cache Fusion problem. Cache Fusion is Oracle RAC's mechanism for sharing database buffer cache blocks across instances. When a session on instance 2 needs a block that is cached on instance 1, Oracle transfers that block over the cluster interconnect rather than reading it from disk.

Here is the precise sequence that saturates the interconnect during an FNDWFPR run:

1. FNDWFPR on instance 1 begins the purge. It reads WF_ITEMS rows to identify candidates. Those data blocks load into instance 1's buffer cache.

2. Four parallel worker jobs are spawned. Two land on instance 2 and instance 3 respectively (the Scheduler's load balancing at work).

3. Worker on instance 2 attempts to delete a WF_ITEMS row. The block containing that row is in instance 1's buffer cache. Cache Fusion must transfer the block from instance 1 to instance 2 over the interconnect — a \`gc current block 2-way\` transfer.

4. Worker on instance 3 does the same. Now both the incoming transfer requests and the block grants flow over the interconnect in all directions.

5. With 4 workers across 3 nodes all working on the same WF_ITEMS row ranges simultaneously, the interconnect receives a continuous flood of \`gc buffer busy acquire\` waits (sessions queuing to acquire a block being transferred), \`gc cr multi block request\` (multi-block reads triggering CR copies), and \`gc current block 2-way\` grants.

6. This continues for the entire 2-hour purge window. AWR shows the gc wait events as the top-3 waits by elapsed time for that period.

---

## Diagnosing the Problem with AWR and ASH

Before implementing any fix, confirm that FNDWFPR's scheduler workers are actually the interconnect source. These queries do that.

**Identify the top RAC wait events during the problem window:**

\`\`\`sql
SELECT event,
       ROUND(SUM(wait_delta)/1000000, 2) AS total_wait_sec,
       COUNT(*) AS samples
FROM dba_hist_active_sess_history
WHERE sample_time BETWEEN TO_DATE('2026-01-15 23:00','YYYY-MM-DD HH24:MI')
  AND TO_DATE('2026-01-16 01:00','YYYY-MM-DD HH24:MI')
  AND event LIKE 'gc%'
GROUP BY event
ORDER BY total_wait_sec DESC;
\`\`\`

On a system with the FNDWFPR distribution problem, you will see \`gc buffer busy acquire\` and \`gc current block 2-way\` at the top of this list with hundreds or thousands of total wait-seconds during the window.

**Confirm cross-instance worker distribution:**

\`\`\`sql
SELECT inst_id, program, module, action, COUNT(*) AS sessions
FROM gv\$session
WHERE program LIKE '%FNDWFPR%'
   OR module LIKE '%FNDWFPR%'
   OR action LIKE '%parallel%'
GROUP BY inst_id, program, module, action
ORDER BY inst_id;
\`\`\`

Run this during an active FNDWFPR execution. If you see rows for inst_id values other than 1, the worker distribution problem is confirmed.

**Check historical job run instance distribution:**

\`\`\`sql
SELECT job_name, instance_id, start_date, run_duration, status
FROM dba_scheduler_job_run_details
WHERE job_name LIKE 'PARALLEL_EXECUTE%'
  AND start_date > SYSDATE - 7
ORDER BY start_date DESC;
\`\`\`

This shows which instance each PARALLEL_EXECUTE worker job ran on over the past week. If you see instance_id values of 2 and 3 mixed in with instance_id 1, the problem is confirmed historically.

---

## Solution 1: Service-Based DBMS_SCHEDULER Job Class (Recommended)

The cleanest solution is to tell the Oracle Scheduler exactly which instance to run FNDWFPR's worker jobs on. This works because \`DBMS_SCHEDULER\` respects the \`service\` attribute of a job class when selecting which RAC instance to execute a job on. A RAC service that is restricted to only one instance effectively becomes a hard instance pin for any job running under that class.

The approach has three steps:

**Step 1 — Create a RAC service restricted to instance 1.**

At the OS level, using Oracle Grid Infrastructure's \`srvctl\` utility:

\`\`\`bash
srvctl add service -db PRODDB -service FNDWFPR_SVC \
  -preferred PROD1 \
  -available "" \
  -role PRIMARY

srvctl start service -db PRODDB -service FNDWFPR_SVC
srvctl status service -db PRODDB -service FNDWFPR_SVC
\`\`\`

The \`-preferred PROD1\` argument (where PROD1 is the name of the first RAC instance) and the empty \`-available\` argument mean this service has no failover node — it runs exclusively on instance 1.

**Step 2 — Create a DBMS_SCHEDULER job class that uses this service.**

\`\`\`sql
BEGIN
  DBMS_SCHEDULER.CREATE_JOB_CLASS(
    job_class_name          => 'FNDWFPR_INST1_CLASS',
    resource_consumer_group => NULL,
    service                 => 'FNDWFPR_SVC',
    logging_level           => DBMS_SCHEDULER.LOGGING_RUNS,
    log_history             => 30,
    comments                => 'Pins FNDWFPR parallel workers to RAC instance 1'
  );
END;
/

-- Enable instance stickiness so workers do not migrate once started
BEGIN
  DBMS_SCHEDULER.SET_ATTRIBUTE(
    'FNDWFPR_INST1_CLASS',
    'instance_stickiness',
    TRUE
  );
END;
/

-- Grant EXECUTE to APPS schema so EBS can use this class
GRANT EXECUTE ON SYS.FNDWFPR_INST1_CLASS TO APPS;
\`\`\`

**Step 3 — Configure FNDWFPR to use this job class.**

The mechanism for wiring the job class into FNDWFPR depends on your EBS version and patch level. The cleanest approach is via an EBS profile option. The companion runbook covers all three configuration options (profile option, concurrent program definition, and DEFAULT_JOB_CLASS modification) in detail.

---

## Solution 2: Reduce Parallel Workers to Zero (Fallback)

If service-based job class pinning cannot be implemented in the current environment — for example, in a test environment where srvctl changes require a change management window that has not been approved — the simplest fallback is to disable FNDWFPR parallelism entirely.

The EBS profile option \`FND_WFPR_PARALLEL_WORKERS\` (name varies by version — check the profile option query in the runbook) controls how many parallel workers FNDWFPR spawns. Setting it to \`0\` or \`1\` causes FNDWFPR to process the purge sequentially without invoking \`DBMS_PARALLEL_EXECUTE\` or creating any DBMS_SCHEDULER worker jobs.

Before choosing this approach, check the size of your WF tables to understand the performance trade-off:

\`\`\`sql
SELECT segment_name, ROUND(SUM(bytes)/1024/1024/1024, 2) AS size_gb
FROM dba_segments
WHERE segment_name IN ('WF_ITEMS','WF_ITEM_ACTIVITY_STATUSES',
                       'WF_NOTIFICATION_ATTRIBUTES','WF_NOTIFICATIONS')
  AND owner = 'APPS'
GROUP BY segment_name
ORDER BY size_gb DESC;
\`\`\`

If WF_ITEMS is above 5 GB, sequential purge may run longer than the allocated maintenance window. In that case, implement Solution 1 rather than disabling parallelism.

---

## Solution 3: Instance Stickiness as a Supplemental Control

\`DBMS_SCHEDULER\` job classes have an \`instance_stickiness\` attribute. When set to \`TRUE\`, a job that has started on a given instance will not migrate to another instance during execution. This does not control *which* instance the job starts on — Oracle Scheduler still distributes the initial placement across available nodes — but it prevents mid-execution migration, which reduces some forms of cross-instance traffic.

Instance stickiness is most useful as a supplement to Solution 1 (the service-based pin), not as a standalone fix. Combined with the service-based job class, it ensures that even if the job class service configuration has an edge case, jobs will not drift once running.

---

## Verification

After implementing Solution 1 or Solution 2, verify the fix during the next FNDWFPR maintenance window:

\`\`\`sql
SELECT job_name, instance_id, start_date, run_duration, status
FROM dba_scheduler_job_run_details
WHERE job_name LIKE 'FNDWFPR%' OR job_name LIKE 'PARALLEL_EXECUTE%'
ORDER BY start_date DESC;
\`\`\`

With Solution 1 applied, all rows should show \`instance_id = 1\`. With Solution 2 applied, no rows should appear at all (no scheduler jobs are created in sequential mode).

Check the AWR for the next 11 PM–1 AM window. The \`gc buffer busy acquire\` and \`gc current block 2-way\` events should drop from the top-10 waits list entirely or appear at negligible levels.

---

## Summary

The FNDWFPR interconnect saturation problem is a collision between two independently correct behaviors: EBS Concurrent Manager correctly pins FNDWFPR to instance 1, and Oracle Scheduler correctly distributes DBMS_PARALLEL_EXECUTE worker jobs across the RAC cluster for load balancing. The collision happens because neither system knows about the other's decision.

The fix is to make the Scheduler aware of the instance requirement by using a job class bound to a RAC service that only runs on instance 1. This approach:

- Requires no code changes to FNDWFPR or EBS internals
- Works on all EBS 12.2 releases
- Is fully reversible (drop the job class and service to revert)
- Does not affect any other DBMS_SCHEDULER jobs in the system

The companion runbook covers the complete implementation: exact \`srvctl\` commands, job class creation SQL, EBS profile option queries, and the verification matrix for confirming all workers are pinned to instance 1.`,
};

async function main() {
  console.log('Inserting EBS FNDWFPR RAC blog post...');
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
