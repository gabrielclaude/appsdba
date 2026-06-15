import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'The Explosive Self-Join: How a Staging Table Query Went from Seconds to 70 Minutes',
  slug: 'oracle-self-join-staging-table-low-cardinality-index-contention-fix',
  excerpt:
    'A production batch job that should finish in seconds suddenly runs for 70 minutes with no code changes, no locks, and no obvious database errors. The culprit: a self-join on a 3.3-million-row staging table using a low-cardinality single-column index, NVL-wrapped join predicates that destroy cardinality estimates, and an analytic COUNT window function that forces a massive WINDOW SORT before DISTINCT can trim anything. Follow the diagnostic path and the structural rewrite that eliminates the problem permanently.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-15'),
  youtubeUrl: null,
  content: `Staging tables in enterprise data processing environments are deceptively dangerous. They accumulate rows from multiple upstream sources, batch jobs write to them in parallel, and the queries that validate and promote their contents are often written once and never revisited — until data volumes cross the threshold where a design flaw that was always there suddenly becomes a crisis.

This post documents a real production incident where a member enrollment batch job went from completing in seconds to running for over 70 minutes with no code changes, no blocking sessions, and no obvious database errors. The investigation required tracing execution plans, understanding buffer busy wait mechanics, and ultimately recognizing an architectural SQL pattern that scales as O(N²). The fix is a structural rewrite that reduces the complexity to O(N).

---

## The Scenario

A health plan data processing system uses a staging table (\`AE_MEMBER_STG\`) to ingest and validate member enrollment records before promoting them to the core member system. A validation package runs routinely and is expected to complete in a few seconds per file. One morning, the job stops progressing — sessions pile up, the application team opens a P1, and the DBA team begins diagnosis under time pressure.

The critical observation from the outset: **no blocking sessions, no row-level locks, no obvious waits in the alert log.** The query is running; it is just running for 70+ minutes instead of seconds. Something changed about how the optimizer is executing it.

---

## The Query: Anatomy of a Performance Bomb

The core of the validation package is a duplicate-detection query. Simplified, it looks like this:

\`\`\`sql
SELECT INNER_QRY.MEMBER_STG_KEY,
       INNER_QRY.SUBSC_EXCH_ID,
       INNER_QRY.DEP_EXCH_ID,
       INNER_QRY.FILE_CTRL_NUM
FROM (
    SELECT DISTINCT
           B.SUBSC_EXCH_ID,
           B.DEP_EXCH_ID,
           B.FILE_CTRL_NUM,
           CASE WHEN B.MED_VRNT_CODE IS NOT NULL THEN 1 ELSE 0 END,
           CASE WHEN B.DEN_VRNT_CODE IS NOT NULL THEN 1 ELSE 0 END,
           B.MEMBER_STG_KEY,
           COUNT(1) OVER (
             PARTITION BY B.SUBSC_EXCH_ID, B.DEP_EXCH_ID, B.FILE_CTRL_NUM,
                          CASE WHEN B.MED_VRNT_CODE IS NOT NULL THEN 1 ELSE 0 END,
                          CASE WHEN B.DEN_VRNT_CODE IS NOT NULL THEN 1 ELSE 0 END
           ) AS MEMBER_COUNT
    FROM   AE_MEMBER_STG A,
           AE_MEMBER_STG B
    WHERE  A.MEMBER_LOAD_STATUS = 'N'
      AND  A.MEMBER_LOAD_STATUS = B.MEMBER_LOAD_STATUS
      AND  NVL(A.SUBSC_EXCH_ID,   '*') = NVL(B.SUBSC_EXCH_ID,   '*')
      AND  NVL(A.DEP_EXCH_ID,     '*') = NVL(B.DEP_EXCH_ID,     '*')
      AND  NVL(A.FILE_CTRL_NUM,   '*') = NVL(B.FILE_CTRL_NUM,   '*')
      AND  NVL(A.ACTIVITY_CODE,   '*') = NVL(B.ACTIVITY_CODE,   '*')
      AND  ((A.MED_VRNT_CODE IS NOT NULL AND B.MED_VRNT_CODE IS NOT NULL)
            OR (A.DEN_VRNT_CODE IS NOT NULL AND B.DEN_VRNT_CODE IS NOT NULL))
      AND  A.ACTIVITY_CODE <> 'AUD'
) INNER_QRY
WHERE INNER_QRY.MEMBER_COUNT > 1;
\`\`\`

There are three structural problems in this query, each compounding the others.

### Problem 1: The Self-Join Is O(N²)

\`FROM AE_MEMBER_STG A, AE_MEMBER_STG B\` joins the table to itself. With 3.3 million rows and a filter on \`MEMBER_LOAD_STATUS = 'N'\` that returns tens of thousands of rows, the self-join builds a Cartesian product of matching status rows before applying the multi-column NVL predicates. When the 'N' population is large, this scales quadratically.

At low data volumes — say, 1,000 'N' rows — the self-join evaluates at most 1,000,000 combinations. At 10,000 rows it becomes 100,000,000. At 50,000 rows: 2.5 billion potential combinations before any filtering. The application team confirmed no code changes. But the data volume did grow: a larger-than-normal file arrived with 25,000 rows in status 'N', pushing the optimizer into a territory where the execution plan it had been using broke catastrophically.

### Problem 2: Low-Cardinality Index Contention

The optimizer was leaning on an index called \`AE_MEMBER_STG_INDEX4\`, defined on the single column \`MEMBER_LOAD_STATUS\`. The actual value distribution across 3.3 million rows:

| MEMBER_LOAD_STATUS | Row Count |
|--------------------|-----------|
| Y | 1,681,903 |
| Z | 1,118,181 |
| R | 47,848 |
| I | 7,152 |
| H | 1 |

Five distinct values. A single-column index on a column with five distinct values across millions of rows is a low-cardinality index — and they are dangerous under write-heavy or concurrent-read workloads for a structural reason.

An Oracle B-tree index stores entries sorted by value. All 1.68 million rows with status 'Y' occupy a dense, contiguous block range in the index leaf layer. When multiple sessions concurrently read or update rows with the same status value, they hammer the same index leaf blocks simultaneously. Oracle's block-level locking means only one session can latch a buffer block at a time. The result: **buffer busy waits** — the diagnostic fingerprint that the DBAs found in \`V\$SESSION_WAIT\`.

The wait event was not pointing to a slow query. It was pointing to structural competition for the same index blocks across parallel processes.

### Problem 3: NVL in Join Predicates Breaks the Optimizer

Every join condition in the WHERE clause wraps both sides in \`NVL(column, '*')\`:

\`\`\`sql
NVL(A.SUBSC_EXCH_ID, '*') = NVL(B.SUBSC_EXCH_ID, '*')
\`\`\`

A standard B-tree index stores raw column values in sorted order. When the join predicate wraps a column in a function, Oracle cannot traverse the index tree to find the pre-computed \`NVL\` result — that result does not exist in the index. Unless a Function-Based Index explicitly pre-computes the same expression, Oracle must evaluate the function row-by-row against the full table.

More critically, the Cost-Based Optimizer (CBO) loses access to the column's statistics when the column is wrapped in a function. The column histogram and NDV (number of distinct values) cannot be applied to \`NVL(SUBSC_EXCH_ID, '*')\`. The optimizer falls back to internal defaults — often estimating that the predicate matches 1% or fewer rows. In this case, the plan showed \`E-Rows = 1\` for operations that were actually processing millions of rows. That cardinality underestimate led the optimizer to choose a Nested Loop join — correct for small driving sets, catastrophic when both sides have thousands of matching rows.

---

## What the Diagnostics Showed

### Plan Hash Value history

Pulling the PHV history for the SQL_ID from \`V\$SQL\` and \`DBA_HIST_SQLSTAT\` showed multiple plan variants had existed. The current bad plan showed:

\`\`\`
| Id | Operation                         | Name               | E-Rows |
|  0 | SELECT STATEMENT                  |                    |        |
|  1 |   SORT ORDER BY                   |                    |      1 |
|  2 |     VIEW (filter MEMBER_COUNT>1)  |                    |      1 |
|  3 |       HASH UNIQUE                 |                    |      1 |
|  4 |         WINDOW SORT               |                    |      1 |
|  5 |           NESTED LOOPS            |                    |      1 |
|  6 |             NESTED LOOPS          |                    |      1 |
|  7 |               TABLE ACCESS BY INDEX ROWID BATCHED | AE_MEMBER_STG | 1 |
|  8 |                 INDEX RANGE SCAN  | AE_MEMBER_STG_INDEX4 | 1 |
|  9 |               INDEX RANGE SCAN    | AE_MEMBER_STG_INDEX4 | 1 |
| 10 |             TABLE ACCESS BY INDEX ROWID | AE_MEMBER_STG | 1 |
\`\`\`

Notice: E-Rows = 1 throughout the plan. The optimizer believed the entire self-join would produce a single row. The actual execution was generating hundreds of millions of buffer gets before the HASH UNIQUE and WINDOW SORT stages could filter them. Those stages — WINDOW SORT and HASH UNIQUE — require materializing the full intermediate result set, which is exactly why the PGA work area swelled to the point of triggering \`PGA memory operation\` wait events.

### The SQL ran fine in isolation, not inside the package

This is one of the most confusing diagnostic signals: the SQL_ID executed directly in SQL*Plus completed in 35 seconds with a reasonable plan. But running from the package took 70+ minutes. Several factors can cause this divergence:

- **Bind variable peeking**: the package passes bind variables; SQL*Plus testing may use literals. The optimizer peeks at bind values on first parse and builds a plan assuming those specific values. If the package passes a value that selects a very different row set than the test run, the peeked plan is wrong.
- **Cursor sharing and adaptive plans**: Oracle's adaptive plan mechanism can switch join strategies mid-execution. If the package's cursor was parsed under conditions where adaptive statistics weren't collected, it retains a bad adaptive decision.
- **Session-level statistics level**: SQL*Plus testing with \`statistics_level = ALL\` activates runtime feedback. The package session may not have the same settings, disabling the adaptive cardinality correction that would have fixed the plan mid-run.

---

## Immediate Fixes Applied

### 1. Rebuild the low-cardinality index with higher INITRANS

\`\`\`sql
ALTER INDEX AEUSER.AE_MEMBER_STG_INDEX4 REBUILD
  INITRANS 8
  PCTFREE 20
  ONLINE;
\`\`\`

\`INITRANS 8\` reserves 8 transaction slots per index block, reducing the probability that concurrent sessions compete for a single slot and cause buffer busy waits. \`PCTFREE 20\` leaves more free space in each block, reducing block splits under insert load and spreading the contention across more physical blocks.

This resolved the buffer busy waits immediately. Sessions stopped stacking on the same index blocks.

### 2. Create a composite index for the access path

\`\`\`sql
CREATE INDEX AE_MEMBER_STG_CUSTOM_IDX
  ON AE_MEMBER_STG (MEMBER_LOAD_STATUS, APPLN_TYPE, SOURCE_ID);
\`\`\`

The composite index targets the full filter predicate, allowing Oracle to perform a range scan on \`MEMBER_LOAD_STATUS = 'N'\` while filtering \`APPLN_TYPE\` and \`SOURCE_ID\` without a table access for every index entry.

### 3. Batch splitting

Rather than submitting all files in a single bulk run, the operations team isolated the problematic file (25,000 rows) and processed it separately. Standard files (~42,000 rows of typical distribution) processed cleanly. This is a workaround, not a fix — it reduces the 'N' population the self-join must evaluate per execution, keeping it below the threshold where the plan breaks.

### 4. Purge the bad plan from the cursor cache

\`\`\`sql
DECLARE
  v_report CLOB;
BEGIN
  v_report := DBMS_SPM.EVOLVE_SQL_PLAN_BASELINE(
    sql_handle => NULL,
    plan_name  => NULL
  );
END;
/

-- Or flush the specific cursor:
EXEC DBMS_SHARED_POOL.PURGE('5kgs7qt376697','C');
\`\`\`

---

## The Permanent Fix: Eliminate the Self-Join

The structural rewrite replaces the self-join, DISTINCT, and analytic window function with a two-step CTE approach that performs aggregation first:

\`\`\`sql
WITH duplicate_groups AS (
    -- Step 1: aggregate to find only composite key groups with more than one member
    SELECT NVL(SUBSC_EXCH_ID, '*')  AS g_subsc_exch_id,
           NVL(DEP_EXCH_ID,   '*')  AS g_dep_exch_id,
           NVL(FILE_CTRL_NUM, '*')  AS g_file_ctrl_num,
           NVL(ACTIVITY_CODE, '*')  AS g_activity_code,
           CASE WHEN MED_VRNT_CODE IS NOT NULL THEN 1 ELSE 0 END AS is_med,
           CASE WHEN DEN_VRNT_CODE IS NOT NULL THEN 1 ELSE 0 END AS is_den
    FROM   AE_MEMBER_STG
    WHERE  MEMBER_LOAD_STATUS = 'N'
      AND  ACTIVITY_CODE <> 'AUD'
    GROUP BY
           NVL(SUBSC_EXCH_ID, '*'),
           NVL(DEP_EXCH_ID,   '*'),
           NVL(FILE_CTRL_NUM, '*'),
           NVL(ACTIVITY_CODE, '*'),
           CASE WHEN MED_VRNT_CODE IS NOT NULL THEN 1 ELSE 0 END,
           CASE WHEN DEN_VRNT_CODE IS NOT NULL THEN 1 ELSE 0 END
    HAVING COUNT(1) > 1
)
-- Step 2: join the compact duplicate-key list back to the base table
SELECT b.MEMBER_STG_KEY,
       b.SUBSC_EXCH_ID,
       b.DEP_EXCH_ID,
       b.FILE_CTRL_NUM
FROM   AE_MEMBER_STG b
JOIN   duplicate_groups dg
       ON  NVL(b.SUBSC_EXCH_ID, '*')  = dg.g_subsc_exch_id
      AND  NVL(b.DEP_EXCH_ID,   '*')  = dg.g_dep_exch_id
      AND  NVL(b.FILE_CTRL_NUM, '*')  = dg.g_file_ctrl_num
      AND  NVL(b.ACTIVITY_CODE, '*')  = dg.g_activity_code
      AND  CASE WHEN b.MED_VRNT_CODE IS NOT NULL THEN 1 ELSE 0 END = dg.is_med
      AND  CASE WHEN b.DEN_VRNT_CODE IS NOT NULL THEN 1 ELSE 0 END = dg.is_den
WHERE  b.MEMBER_LOAD_STATUS = 'N'
  AND  b.ACTIVITY_CODE <> 'AUD';
\`\`\`

**Why this is O(N) instead of O(N²):**

Step 1 scans \`AE_MEMBER_STG\` once. Oracle uses a HASH GROUP BY — the 'N' rows are bucketed into a hash table in a single pass. The HAVING clause drops any bucket with only one member. What remains is a compact list of composite key combinations that have duplicates — potentially a very small result set even if the base table has millions of rows.

Step 2 scans \`AE_MEMBER_STG\` again (or uses an index range scan on 'N' rows) and probes the small hash table built from Step 1. There is no combinatorial explosion. Each row from \`AE_MEMBER_STG\` is evaluated exactly once.

The WINDOW SORT and HASH UNIQUE operations — which were the primary PGA consumers — are completely eliminated.

---

## Why NVL in Join Predicates Is a Persistent Anti-Pattern

The NVL wrappers are not removed in the rewrite above because the staging table genuinely contains NULLs in these columns and NULL-equality comparison (\`NULL = NULL\` is FALSE in SQL) requires special handling. But it is worth understanding the cost.

When Oracle sees \`NVL(column, literal)\` in a WHERE clause or JOIN predicate, it cannot use a standard B-tree index on \`column\` because the index stores raw column values, not function outputs. The optimizer must evaluate the NVL expression for every row — effectively a full table scan for that predicate regardless of what other indexes exist.

The three clean alternatives:

**Option 1 — OR-expansion (restores index usage):**
\`\`\`sql
WHERE (A.SUBSC_EXCH_ID = B.SUBSC_EXCH_ID
       OR (A.SUBSC_EXCH_ID IS NULL AND B.SUBSC_EXCH_ID IS NULL))
\`\`\`
Oracle can use an Index Range Scan for the equality branch and a separate scan for the IS NULL branch, combining them via concatenation.

**Option 2 — Function-Based Index (infrastructure fix, no code change):**
\`\`\`sql
CREATE INDEX ams_fbi_subsc ON AE_MEMBER_STG (NVL(SUBSC_EXCH_ID, '*'));
\`\`\`
The index pre-computes the NVL result. The optimizer can now match the query's NVL expression to the index expression and use an Index Range Scan.

**Option 3 — Enforce NOT NULL with default values at ingestion:**
Define the columns as NOT NULL with a default value (\`DEFAULT '*'\`) in the staging table DDL. Eliminate NULLs at the source. This removes the need for NVL in all downstream SQL and produces the cleanest, fastest queries.

---

## Summary and Lessons

| Problem | Root Cause | Fix |
|---------|-----------|-----|
| 70-minute runtime | Self-join O(N²) with large 'N' population | GROUP BY/HAVING rewrite |
| Buffer busy waits | Low-cardinality single-column index INITRANS too low | Rebuild with INITRANS 8 + composite index |
| Bad execution plan | NVL predicate destroying cardinality estimates | OR-expansion or Function-Based Index |
| Package slow, SQL fast | Bind peeking with adaptive plan retained bad cardinality decision | Flush cursor cache + SQL Plan Baseline |
| PGA memory operation waits | WINDOW SORT + HASH UNIQUE materializing billions of intermediate rows | Eliminated by GROUP BY rewrite |

**The core lesson:** a self-join on a staging table with a large active population is an O(N²) operation waiting to emerge. It runs fine at low volume because the optimizer's bad cardinality estimates happen to coincide with execution patterns that work. As soon as data volume crosses a threshold — a larger-than-normal file, a month-end accumulation, a failed truncate — the quadratic growth becomes visible. The fix is architectural, not a tuning parameter.

The companion runbook covers the complete diagnostic procedure for this pattern: identifying the bad plan via PHV history, measuring buffer busy wait root cause, purging the cursor cache safely, validating the GROUP BY rewrite against the original with GATHER_PLAN_STATISTICS, and a monitoring script that catches self-join PGA blowups before they become outages.`,
};

async function main() {
  console.log('Inserting self-join staging table blog post...');
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
