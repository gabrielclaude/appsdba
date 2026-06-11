import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle 19c: Materialized View Creation Hangs on Distributed Queries — Root Cause and Fix',
  slug: 'oracle-19c-materialized-view-distributed-query-hang-fix',
  excerpt:
    'A deep dive into the Oracle 19c optimizer bug that causes CREATE MATERIALIZED VIEW to hang indefinitely when the defining query mixes local tables with remote database link tables — and the three-tier MV architecture that bypasses it completely.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `There is a class of Oracle problem that is uniquely maddening: the standalone \`SELECT\` finishes in 90 seconds, the \`CREATE TABLE AS SELECT\` finishes in two minutes, but the moment you wrap the exact same query in a \`CREATE MATERIALIZED VIEW\` statement, the session hangs forever.

No blocking sessions appear in \`V\$SESSION\`. No row lock waits in \`V\$LOCK\`. No I/O stall in the alert log. The session simply sits — waiting on an event that never resolves — until you kill it manually.

This is not a performance problem. It is a specific Oracle 19c optimizer bug triggered by a well-defined combination: a materialized view definition that mixes local tables with remote tables accessed via a database link in the same query block.

This post explains why it happens, how to confirm you are hitting the bug versus a genuine resource issue, and the three-tier staging architecture that works around it completely.

---

## The Triggering Pattern

The hang occurs when all of the following are true simultaneously:

1. You are creating a materialized view with \`BUILD IMMEDIATE\`
2. The defining query joins **local schema tables** and **remote tables via \`@DBLINK\`** in the same query block (including CTEs)
3. The query involves at least one non-trivial predicate pushed through the dblink join

A typical failing definition:

\`\`\`sql
CREATE MATERIALIZED VIEW app_schema.mv_final_target
TABLESPACE data_ts
BUILD IMMEDIATE
REFRESH COMPLETE
AS
WITH local_filtered_data AS (
    SELECT c.customer_id, c.region_id
    FROM   local_schema.customers c
    JOIN   local_schema.orders o ON o.order_id = c.order_id
    WHERE  o.order_date >= TRUNC(SYSDATE) - 5
),
remote_data AS (
    SELECT p.phone_id,
           p.customer_id AS r_cust_id
    FROM   remote_table_phone@remote_link p
    JOIN   remote_table_type@remote_link  t
           ON t.type_id = p.phone_type_id
    JOIN   local_filtered_data lfd
           ON lfd.customer_id = p.customer_id
)
SELECT rd.phone_id, lfd.customer_id, lfd.region_id
FROM   remote_data rd
JOIN   local_filtered_data lfd ON lfd.customer_id = rd.r_cust_id;
\`\`\`

Run this as a plain \`SELECT\` — it completes. Run it as \`CREATE TABLE AS SELECT\` — it completes. Wrap it in \`CREATE MATERIALIZED VIEW\` — it hangs.

---

## Why It Hangs: The Distributed Compilation Bug

When Oracle compiles a materialized view definition, it does substantially more work than it does for a plain SQL statement:

1. **Dependency resolution** — Every referenced object (table, view, sequence) is registered in \`SYS.DEPENDENCY$\`. For remote objects, Oracle must query the remote dictionary to resolve column types, constraints, and privileges.
2. **Metadata lock acquisition** — Oracle acquires metadata locks (Library Cache locks, not row locks) on every object in the dependency graph while it writes the MV definition to \`SYS.OBJ$\`, \`SYS.COL$\`, and \`SYS.SNAP$\`.
3. **Query rewrite registration** — The query block must be registered in the query rewrite engine, which requires additional parsing passes over the SQL text.

The bug manifests during step 1 and step 2 together: when the optimizer attempts to resolve the **join predicate push-down plan** for a query that mixes local and remote objects, it enters a circular dependency evaluation loop while simultaneously holding Library Cache locks on the local objects and waiting for remote dictionary metadata. The session waits on event \`library cache lock\` or \`SQL*Net message from dblink\` indefinitely — neither of which shows up as a blocking session from the perspective of another DBA watching \`V\$LOCK\`.

This is distinct from a hung distributed transaction. No two-phase commit is involved at MV creation time. The hang is purely in the compilation and metadata registration phase.

### How to Confirm You Are Hitting the Bug

While the hung session is running:

\`\`\`sql
-- In a second session — check what the hung CREATE MV session is waiting on
SELECT s.sid,
       s.serial#,
       s.event,
       s.wait_class,
       s.seconds_in_wait,
       s.sql_id,
       s.state
FROM   v\$session s
WHERE  s.status = 'ACTIVE'
  AND  s.username IS NOT NULL
ORDER BY s.seconds_in_wait DESC;
\`\`\`

If the hang is this bug, you will typically see:

| Event | Wait Class | Interpretation |
|-------|-----------|----------------|
| \`library cache lock\` | Concurrency | MV compiler holding/waiting Library Cache lock |
| \`SQL*Net message from dblink\` | Network | Remote metadata resolution stuck |
| \`enq: JI - contention\` | Other | MV snapshot registration lock contention |

The same query run as a \`SELECT\` statement will show \`SQL*Net message from dblink\` briefly during execution, then complete. As a \`CREATE MATERIALIZED VIEW\`, it never progresses past this point.

**Control test — confirm the SELECT completes:**

\`\`\`sql
-- Replace CREATE MATERIALIZED VIEW ... AS with SELECT and time it
SET TIMING ON
SELECT rd.phone_id, lfd.customer_id, lfd.region_id
FROM  (
    SELECT p.phone_id, p.customer_id
    FROM   remote_table_phone@remote_link p
    JOIN   remote_table_type@remote_link  t ON t.type_id = p.phone_type_id
) rd
JOIN (
    SELECT c.customer_id, c.region_id
    FROM   local_schema.customers c
    JOIN   local_schema.orders o ON o.order_id = c.order_id
    WHERE  o.order_date >= TRUNC(SYSDATE) - 5
) lfd ON lfd.customer_id = rd.customer_id;
-- If this completes but CREATE MV hangs: you have the distributed MV bug.
\`\`\`

---

## The Solution: Three-Tier Materialized View Architecture

The fix is architectural: separate the remote data access from the local data access, materialize each independently, then join the two locally-materialized result sets in the final MV. Because the final MV query touches no database links, the compiler has no remote dependency resolution to perform, and the hang cannot occur.

### Step 1 — Remote Staging MV (remote objects only)

\`\`\`sql
-- No local tables in this query — only remote objects via @REMOTE_LINK
CREATE MATERIALIZED VIEW mv_remote_stage
TABLESPACE data_ts
BUILD IMMEDIATE
REFRESH COMPLETE ON DEMAND
AS
SELECT p.customer_id,
       p.phone_id,
       p.phone_number,
       t.type_name
FROM   remote_table_phone@remote_link p
JOIN   remote_table_type@remote_link  t
       ON t.type_id    = p.phone_type_id
WHERE  t.status        = 'ACTIVE';

CREATE INDEX mv_remote_stage_cust_ix ON mv_remote_stage (customer_id);
\`\`\`

This MV contains only remote data. Oracle can compile and build it without the mixed-source ambiguity because the entire dependency graph is remote — there is no local-vs-remote metadata lock contention.

### Step 2 — Local Staging MV (local objects only)

\`\`\`sql
-- No database links — only local schema tables
CREATE MATERIALIZED VIEW mv_local_stage
TABLESPACE data_ts
BUILD IMMEDIATE
REFRESH COMPLETE ON DEMAND
AS
SELECT c.customer_id,
       c.region_id,
       c.account_id
FROM   local_schema.customers c
JOIN   local_schema.orders    o
       ON  o.order_id   = c.order_id
WHERE  o.order_date    >= TRUNC(SYSDATE) - 5
  AND  o.status_id      = 9;

CREATE INDEX mv_local_stage_cust_ix ON mv_local_stage (customer_id);
\`\`\`

### Step 3 — Final Combination MV (no database links)

\`\`\`sql
-- Both source MVs are local objects — zero database link references
CREATE MATERIALIZED VIEW app_schema.mv_final_target
TABLESPACE data_ts
BUILD IMMEDIATE
REFRESH COMPLETE ON DEMAND
AS
SELECT l.customer_id,
       l.region_id,
       l.account_id,
       r.phone_id,
       r.phone_number,
       r.type_name
FROM   mv_local_stage  l
JOIN   mv_remote_stage r
       ON r.customer_id = l.customer_id;
\`\`\`

Because \`mv_local_stage\` and \`mv_remote_stage\` are both physical local objects, Oracle can compile \`mv_final_target\` without touching a single database link during the metadata resolution phase. The hang does not occur.

---

## Refresh Order Matters

When scheduling refreshes, the dependency chain must be respected:

\`\`\`
1. mv_remote_stage    (populates from remote)
2. mv_local_stage     (populates from local)
3. mv_final_target    (joins the two staging MVs)
\`\`\`

If you use \`DBMS_MVIEW.REFRESH\` to control refresh order manually:

\`\`\`sql
BEGIN
  -- Step 1: Refresh remote staging first
  DBMS_MVIEW.REFRESH(
    list          => 'MV_REMOTE_STAGE',
    method        => 'C',
    atomic_refresh => FALSE
  );

  -- Step 2: Refresh local staging
  DBMS_MVIEW.REFRESH(
    list          => 'MV_LOCAL_STAGE',
    method        => 'C',
    atomic_refresh => FALSE
  );

  -- Step 3: Refresh final target
  DBMS_MVIEW.REFRESH(
    list          => 'MV_FINAL_TARGET',
    method        => 'C',
    atomic_refresh => FALSE
  );
END;
/
\`\`\`

If you use a refresh group, add all three MVs in dependency order:

\`\`\`sql
-- Create a refresh group that maintains order
DBMS_REFRESH.MAKE(
  name           => 'MV_DISTRIBUTED_GRP',
  list           => 'MV_REMOTE_STAGE, MV_LOCAL_STAGE, MV_FINAL_TARGET',
  next_date      => SYSDATE,
  interval       => 'SYSDATE + 1/24',  -- Hourly
  implicit_destroy => FALSE,
  rollback_seg   => NULL,
  push_deferred_rpc => TRUE,
  refresh_after_errors => FALSE
);
\`\`\`

---

## Handling Large Initial Builds: BUILD DEFERRED + ATOMIC_REFRESH

For high-volume MVs where the initial population might take hours, avoid \`BUILD IMMEDIATE\` during your deployment window. Instead, create the metadata shell first, then populate asynchronously:

\`\`\`sql
-- Create the shell without populating (zero rows, instant DDL)
CREATE MATERIALIZED VIEW app_schema.mv_final_target
TABLESPACE data_ts
BUILD DEFERRED
REFRESH COMPLETE ON DEMAND
AS
SELECT l.customer_id, l.region_id, r.phone_number
FROM   mv_local_stage  l
JOIN   mv_remote_stage r ON r.customer_id = l.customer_id;

-- Populate later in a separate session or job
BEGIN
  DBMS_MVIEW.REFRESH(
    list           => 'APP_SCHEMA.MV_FINAL_TARGET',
    method         => 'C',
    atomic_refresh => FALSE   -- Non-atomic: TRUNCATE + INSERT, avoids undo explosion
  );
END;
/
\`\`\`

**\`ATOMIC_REFRESH => FALSE\`** is critical for large MVs. The default (\`TRUE\`) wraps the entire refresh in a single transaction, which can generate enormous undo and rollback segment pressure. Non-atomic refresh uses \`TRUNCATE\` followed by \`INSERT\`, which is both faster and far less undo-intensive.

---

## Accelerating Builds with PARALLEL

For the remote and local staging MVs where data volume is large, add a \`PARALLEL\` hint to the defining query:

\`\`\`sql
CREATE MATERIALIZED VIEW mv_local_stage
TABLESPACE data_ts
BUILD IMMEDIATE
REFRESH COMPLETE ON DEMAND
AS
SELECT /*+ PARALLEL(c, 4) PARALLEL(o, 4) */
       c.customer_id, c.region_id, c.account_id
FROM   local_schema.customers c
JOIN   local_schema.orders    o ON o.order_id = c.order_id
WHERE  o.order_date >= TRUNC(SYSDATE) - 5
  AND  o.status_id   = 9;
\`\`\`

Note that \`PARALLEL\` in the query hint affects the initial \`BUILD IMMEDIATE\` population. For subsequent refreshes, the degree of parallelism is controlled by the table/index statistics and the \`PARALLEL\` clause on the MV object itself.

---

## Summary and Best Practices

### What Causes the Hang

| Condition | Result |
|-----------|--------|
| \`SELECT\` mixing local + remote | Executes normally |
| \`CREATE TABLE AS SELECT\` mixing local + remote | Executes normally |
| \`CREATE MATERIALIZED VIEW\` mixing local + remote | Hangs on \`library cache lock\` / \`SQL*Net message from dblink\` |

The bug is in Oracle's MV compilation metadata resolution path — not in query execution. The standalone query works because no Library Cache locks on the MV object graph are involved.

### The Three-Tier Fix

| Tier | Contents | Purpose |
|------|----------|---------|
| \`MV_REMOTE_STAGE\` | Remote objects only | Materializes remote data locally |
| \`MV_LOCAL_STAGE\` | Local objects only | Pre-filters and pre-joins local data |
| \`MV_FINAL_TARGET\` | Joins two staging MVs | No dblinks — compiles cleanly |

### Best Practices

1. **Never mix local and remote objects in a single MV definition on Oracle 19c.** Even if your specific environment does not immediately hang, the bug is triggered by optimizer decision thresholds and can appear after data volume growth changes the optimizer's plan.

2. **Always index the join columns on staging MVs.** The final-tier MV join against two staging MVs benefits enormously from index-based lookups on the join key (\`customer_id\` in this example).

3. **Use \`ATOMIC_REFRESH => FALSE\` for any MV that contains more than a few hundred thousand rows.** The default atomic refresh generates undo that can fill your undo tablespace on large datasets.

4. **Refresh remote staging before local staging.** If your business logic depends on the remote data being current before the local filtering is applied, the remote MV must refresh first in the chain.

5. **Monitor refresh duration, not just completion.** A refresh that used to take 5 minutes taking 45 minutes is an early warning — either the remote database link latency has increased, the remote source table has grown, or the local join has become less selective.

6. **Check \`ALL_MVIEWS.LAST_REFRESH_TYPE\` and \`LAST_REFRESH_DATE\`** after each refresh cycle to confirm all three tiers completed. A failed middle-tier refresh leaves the final target stale without raising an obvious error if \`REFRESH_AFTER_ERRORS\` is set on the refresh group.

The companion runbook covers the complete deployment procedure — DDL execution order, index creation, refresh group setup, a monitoring query for refresh lag, and a diagnostic script for when a staging MV refresh hangs on the remote side.`,
};

async function main() {
  console.log('Inserting MV distributed query hang blog post...');
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
