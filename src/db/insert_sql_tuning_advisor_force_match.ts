import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const blogPost = {
  title: 'SQL Tuning Advisor: Using force_match to Fix Literal String Performance Without cursor_sharing',
  slug: 'sql-tuning-advisor-force-match-literal-strings',
  excerpt:
    'How to use the SQL Tuning Advisor with force_match=>TRUE to fix a SQL statement that is flooding the shared pool with hard parses and mutex sleep waits due to embedded literal date values — a surgical alternative to cursor_sharing=FORCE that scopes the fix to a single SQL pattern.',
  category: 'oracle-database' as const,
  published: true,
  publishedAt: new Date('2026-06-03'),
  isPremium: false,
  youtubeUrl: null,
  content: `The report landed at 09:15: a batch job that normally finishes in four minutes had been running for forty. AWR showed elapsed time dominated by two wait events that do not appear together by accident — **library cache: mutex X** and **cursor: pin S wait on X** — both concentrated in the shared pool. The SQL involved was fetching order data filtered by a date range, and the application had been changed the previous week to pass dates as formatted string literals instead of bind variables.

This is one of the most common performance pathways in Oracle: a well-intentioned application change that looks harmless on a development database with a cold shared pool, but produces a cascade of hard-parse contention on a busy production instance. This post walks through diagnosing the problem, running the SQL Tuning Advisor, and accepting the resulting SQL Profile with \`force_match => TRUE\` — a setting that deserves its own detailed explanation.

---

## What the Symptoms Look Like

When a query uses literal values for date predicates, Oracle treats every unique combination of literals as a distinct SQL statement. The parser computes a hash of the full SQL text, finds no match in the library cache, and performs a **hard parse** — a full syntax check, semantic analysis, privilege validation, optimisation pass, and execution plan generation. On a system receiving hundreds or thousands of executions per minute of essentially the same query with different date literals, the result is:

**In AWR Top Wait Events:**

| Wait Event | Category | Why it appears |
|---|---|---|
| \`library cache: mutex X\` | Concurrency | Sessions competing to add new cursors to the library cache during hard parse |
| \`cursor: pin S wait on X\` | Concurrency | Sessions trying to execute a cursor that another session is currently hard-parsing |
| \`latch: shared pool\` | Concurrency | Shared pool memory allocator under pressure from constant cursor creation |

**In AWR Instance Activity Statistics:**

\`\`\`sql
-- Look for a hard parse rate that is high relative to total parses
SELECT stat_name,
       value,
       ROUND(value / NULLIF(
         (SELECT value FROM v\$sysstat WHERE stat_name = 'parse count (total)'),
         0) * 100, 2) pct_of_total
FROM   v\$sysstat
WHERE  stat_name IN (
         'parse count (total)',
         'parse count (hard)',
         'parse count (failures)',
         'parse time cpu',
         'parse time elapsed'
       )
ORDER BY stat_name;
\`\`\`

A healthy OLTP system typically shows hard parses at 1–5% of total parses. When literal-heavy SQL is running, you will see hard parses at 30–80% of total parses, and parse time dominating the CPU profile.

**In the Shared Pool:**

The buffer cache request activity is elevated not because the query is doing excessive I/O, but because each hard parse forces the optimiser to re-evaluate access paths, re-check object statistics, and re-examine index ranges — even though the execution plan for date range X is identical to the plan for date range Y. Every distinct literal set produces its own cursor occupying shared pool memory, fragmenting the pool and triggering the aged-out-cursor churn that drives the mutex waits.

---

## Identifying the SQL

The first diagnostic step is finding the SQL IDs in \`V\$SQL\` that represent different literal variants of the same underlying statement.

\`\`\`sql
-- Step 1: Find SQL IDs with unusually high version counts
-- High version_count on a single SQL_ID means bind variable peeking is producing
-- many child cursors. A cluster of DIFFERENT SQL_IDs with near-identical text
-- means literal variation is producing distinct parent cursors.
SELECT sql_id,
       version_count,
       parse_calls,
       executions,
       ROUND(elapsed_time/1e6, 2)      elapsed_sec,
       ROUND(cpu_time/1e6, 2)          cpu_sec,
       ROUND(buffer_gets/NULLIF(executions,0)) bgets_per_exec,
       sql_text
FROM   v\$sqlarea
WHERE  (  version_count > 50
       OR ROUND(elapsed_time / NULLIF(parse_calls * 1e6, 0)) < 0.1  -- parse-dominated
       )
  AND  executions > 0
ORDER BY parse_calls DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

\`\`\`sql
-- Step 2: Find clusters of SQL with the same structure but different literals
-- Use REGEXP_REPLACE to normalise date literals and group by normalised text
SELECT normalised_text,
       COUNT(DISTINCT sql_id)    cursor_variants,
       SUM(parse_calls)          total_parses,
       SUM(executions)           total_execs,
       ROUND(SUM(elapsed_time)/1e6, 1) total_elapsed_sec,
       MIN(sql_id)               sample_sql_id
FROM (
  SELECT sql_id,
         parse_calls,
         executions,
         elapsed_time,
         REGEXP_REPLACE(
           REGEXP_REPLACE(sql_text,
             '\\''[0-9]{2}-[A-Z]{3}-[0-9]{4}\\''',    -- DD-MON-YYYY literals
             ':dt_bind'),
           '''[0-9]{4}-[0-9]{2}-[0-9]{2}''',           -- YYYY-MM-DD literals
           ':dt_bind'
         ) normalised_text
  FROM   v\$sqlarea
  WHERE  sql_text NOT LIKE '%v\$%'
    AND  sql_text NOT LIKE '%dba_%'
)
GROUP BY normalised_text
HAVING COUNT(DISTINCT sql_id) > 5
ORDER BY total_parses DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

The output will reveal a pattern like this — hundreds of distinct \`sql_id\` values that are semantically the same query with different date literals hardcoded:

\`\`\`
CURSOR_VARIANTS  TOTAL_PARSES  SAMPLE_SQL_ID  NORMALISED_TEXT
---------------  ------------  -------------  -----------------------------------------
            847       612,400  g4p3nkqx72ysf  SELECT ... WHERE order_date = :dt_bind ...
             23        48,200  9xmr2kw4v01tz  SELECT ... WHERE trx_date BETWEEN :dt_b...
\`\`\`

Pick the worst offender by \`TOTAL_PARSES\`. Use the \`SAMPLE_SQL_ID\` as the input to the SQL Tuning Advisor — the profile we create with \`force_match => TRUE\` will apply to all variants.

---

## Examining the Problem SQL

\`\`\`sql
-- Pull the full text and current plan for the sample SQL ID
SELECT sql_fulltext FROM v\$sqlarea WHERE sql_id = 'g4p3nkqx72ysf';

-- Typical appearance of the problem statement:
-- SELECT o.order_id, o.customer_id, o.total_amount, ol.line_item_desc
-- FROM   oe.orders o
-- JOIN   oe.order_lines ol ON ol.order_id = o.order_id
-- WHERE  o.order_date >= '01-JAN-2024'
--   AND  o.order_date <  '01-FEB-2024'
--   AND  o.status = 'COMPLETE';
--
-- Every unique pair of date strings ('01-JAN-2024','01-FEB-2024'),
-- ('01-FEB-2024','01-MAR-2024'), etc. produces a distinct SQL_ID.
-- Oracle cannot reuse the cursor — it hard-parses every single one.
\`\`\`

The fix in application code is to parameterise the query with bind variables. That is always the right long-term answer. But when the application is a third-party product, an ERP system, or a legacy codebase with a long release cycle, you need an immediate in-database remedy — and that is where the SQL Tuning Advisor's \`force_match\` profile parameter comes in.

---

## Running the SQL Tuning Advisor

\`\`\`sql
-- Step 1: Create a tuning task for the SQL ID
-- scope => 'COMPREHENSIVE' runs all advisor checks including SQL Profile recommendation
DECLARE
  l_task_name VARCHAR2(30);
BEGIN
  l_task_name := DBMS_SQLTUNE.CREATE_TUNING_TASK(
    sql_id      => 'g4p3nkqx72ysf',
    scope       => DBMS_SQLTUNE.SCOPE_COMPREHENSIVE,
    time_limit  => 300,         -- seconds; increase for complex SQL
    task_name   => 'tune_order_date_literals',
    description => 'Tuning task for order date literal SQL - force_match profile'
  );
  DBMS_OUTPUT.PUT_LINE('Task created: ' || l_task_name);
END;
/

-- Step 2: Execute the tuning task
EXEC DBMS_SQLTUNE.EXECUTE_TUNING_TASK(task_name => 'tune_order_date_literals');

-- Step 3: Monitor task status (poll until COMPLETED)
SELECT task_name,
       status,
       TO_CHAR(created,    'DD-MON-YYYY HH24:MI') created,
       TO_CHAR(last_modified, 'DD-MON-YYYY HH24:MI') last_modified,
       description
FROM   dba_advisor_tasks
WHERE  task_name = 'tune_order_date_literals';
\`\`\`

\`\`\`sql
-- Step 4: Read the full report
SELECT DBMS_SQLTUNE.REPORT_TUNING_TASK('tune_order_date_literals')
FROM   dual;
\`\`\`

The report will contain sections for:
- **Statistics Findings** — whether object statistics are stale
- **Index Findings** — whether a new index would help
- **SQL Profile** — a set of hints and cardinality adjustments the optimiser can use
- **Restructure SQL** — recommendations to rewrite the query

In a case dominated by literal-string hard parses, the SQL Profile recommendation is the key finding. The report will note something like:

\`\`\`
FINDINGS SECTION (1 finding)
-----------------------------------------------------------------------
1- SQL Profile Finding
   A potentially better execution plan was found for this statement.
   Recommendation: Accept the SQL profile.
   Benefit: 98% improvement in elapsed time across all executions.

   Validation Results:
   The SQL profile was tested by executing both its plan and the original
   plan and measuring their respective execution statistics.
   A plan was found with a full cost of 312 (original: 14,820).

   The SQL profile will also normalise literal values in the SQL text,
   allowing it to match future executions of structurally identical SQL
   with different literal values (force_match parameter).
\`\`\`

---

## Accepting the SQL Profile: force_match and replace

\`\`\`sql
-- Accept the SQL Profile with force_match => TRUE
BEGIN
  DBMS_SQLTUNE.ACCEPT_SQL_PROFILE(
    task_name    => 'tune_order_date_literals',
    task_owner   => USER,
    name         => 'SYS_SQLPROF_order_date_force',
    description  => 'Force-match profile for order date literal SQL — fixes hard parse flood',
    category     => 'DEFAULT',
    force_match  => TRUE,    -- the critical parameter: see explanation below
    replace      => TRUE     -- overwrite if a profile for this SQL already exists
  );
  DBMS_OUTPUT.PUT_LINE('SQL Profile accepted.');
END;
/
\`\`\`

### What force_match => TRUE Does

Without \`force_match\`, a SQL Profile is associated with the exact normalised SQL text of the statement it was created from. The profile will match future executions of that specific SQL only — including its literal values. A query with \`order_date >= '01-JAN-2024'\` would match; a query with \`order_date >= '01-FEB-2024'\` would not, because after text hashing, Oracle treats them as different statements.

With \`force_match => TRUE\`, Oracle takes an additional normalisation step when matching the profile. Before looking up the profile, Oracle replaces all literal values in the incoming SQL with system-generated bind variable placeholders — exactly the same transformation that \`cursor_sharing = FORCE\` applies at parse time. The profile is then stored against this fully normalised form.

The result: every variant of the order date query — regardless of which date range is passed as a literal — matches the same SQL Profile and inherits the same execution plan hints. Oracle reuses a single child cursor across all literal variants instead of creating a new cursor for each one. The hard-parse flood stops. The shared pool mutex contention drops. The elapsed time returns to the four-minute baseline.

### Why This is Safer Than cursor_sharing = FORCE

The system parameter \`cursor_sharing = FORCE\` applies this same literal-replacement normalisation to **every SQL statement** executed against the instance. It is a blunt instrument. It can corrupt execution plans for queries where the optimiser legitimately needs to see the literal value to choose the right plan (e.g. a histogram-driven range query where the optimal index depends on selectivity). It has also historically triggered bugs in specific Oracle versions. DBAs generally avoid it in production.

\`force_match => TRUE\` in a SQL Profile is a **scalpel**. The normalisation applies only to SQL statements whose structure matches the profile's normalised text — a single SQL pattern. All other SQL on the instance is completely unaffected. The behaviour is contained, auditable, and reversible:

\`\`\`sql
-- Drop the profile to immediately revert to original behaviour
EXEC DBMS_SQLTUNE.DROP_SQL_PROFILE(name => 'SYS_SQLPROF_order_date_force');
\`\`\`

The profile is stored in the SQL Management Base (SMB) in \`SYSAUX\` and survives database restarts and upgrades.

### What replace => TRUE Does

\`replace => TRUE\` tells \`ACCEPT_SQL_PROFILE\` to overwrite an existing profile with the same name if one already exists. Without it, re-running the accept call after a profile has already been accepted raises \`ORA-13831: SQL profile name already exists\`. This parameter is primarily useful when iterating — if the advisor produced a better profile after re-running the task with updated statistics, you can re-accept it cleanly without manually dropping the old one first.

---

## Verifying the Profile is Applied

\`\`\`sql
-- Confirm the profile exists and is enabled
SELECT name,
       status,
       force_matching,
       created,
       last_modified,
       description
FROM   dba_sql_profiles
WHERE  name = 'SYS_SQLPROF_order_date_force';

-- FORCE_MATCHING = YES confirms force_match => TRUE was applied
\`\`\`

\`\`\`sql
-- Confirm the profile is being used by the executing SQL
-- After the next execution of the order date query, check v$sql:
SELECT sql_id,
       sql_profile,
       version_count,
       parse_calls,
       executions,
       ROUND(elapsed_time / NULLIF(executions,1e6)) avg_elapsed_us,
       sql_text
FROM   v\$sqlarea
WHERE  sql_text LIKE '%order_date%'
  AND  sql_text NOT LIKE '%v\$%'
ORDER BY parse_calls DESC;

-- sql_profile column will show 'SYS_SQLPROF_order_date_force'
-- version_count should collapse toward 1 (all variants sharing one cursor)
-- parse_calls should drop sharply on the next AWR snapshot
\`\`\`

\`\`\`sql
-- Validate in the execution plan — the profile hints appear in the Note section
SELECT * FROM TABLE(
  DBMS_XPLAN.DISPLAY_CURSOR(
    sql_id     => 'g4p3nkqx72ysf',
    cursor_child_no => 0,
    format     => 'ALLSTATS LAST +NOTE'
  )
);
-- Look for: Note: SQL profile "SYS_SQLPROF_order_date_force" used for this statement
\`\`\`

---

## Before and After: What Changes in AWR

After the profile is accepted and a few AWR snapshots collect:

| Metric | Before | After |
|---|---|---|
| Hard parses / second | 400–800 | 1–5 |
| \`library cache: mutex X\` wait (ms/s) | 120–400 | < 5 |
| \`cursor: pin S wait on X\` wait (ms/s) | 80–200 | < 2 |
| Shared pool free memory trend | Declining | Stable |
| \`V\$SQL\` rows for this statement family | 800+ | 1–3 |
| Batch job elapsed time | 40 minutes | 4 minutes |

The fix does not change the application. It does not change the execution plan in a destructive way. It applies the optimiser's own recommended hints and adds cursor sharing at the statement level. When the application code is eventually updated to use bind variables, dropping the profile is a one-line operation.

---

## Summary

Literal string values in SQL predicates are not a correctness problem — they are a scalability problem. A query that works fine under light load becomes a shared-pool fragmentation engine at scale. The SQL Tuning Advisor exposes this and provides a precise fix through the SQL Profile mechanism.

The two parameters to remember:

- **\`force_match => TRUE\`** — normalises literal values before profile lookup, giving you the hard-parse reduction of \`cursor_sharing = FORCE\` scoped to one SQL pattern only. This is the parameter that actually solves the problem.
- **\`replace => TRUE\`** — allows clean re-acceptance of an improved profile without dropping the old one first. Use it whenever re-running the advisor after a statistics refresh or workload change.

Neither parameter is widely documented in the standard Oracle guides, and \`force_match\` in particular is the reason many DBAs overlook the SQL Profile as the right tool for this class of problem.
`,
};

async function main() {
  await db
    .insert(posts)
    .values({
      title: blogPost.title,
      slug: blogPost.slug,
      excerpt: blogPost.excerpt,
      content: blogPost.content,
      category: blogPost.category,
      youtubeUrl: blogPost.youtubeUrl,
      isPremium: blogPost.isPremium,
      published: blogPost.published,
      publishedAt: blogPost.publishedAt,
    })
    .onConflictDoUpdate({
      target: posts.slug,
      set: {
        title: blogPost.title,
        excerpt: blogPost.excerpt,
        content: blogPost.content,
        isPremium: blogPost.isPremium,
        published: blogPost.published,
        publishedAt: blogPost.publishedAt,
      },
    });
  console.log('inserted:', blogPost.slug);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
