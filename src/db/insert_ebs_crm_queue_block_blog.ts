import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'EBS Month-End Delays: When the Problem Is the Queue, Not the Database',
  slug: 'oracle-ebs-month-end-crm-incompatibility-queue-block-diagnosis',
  excerpt:
    'A 4-to-5-hour backlog hits PRC: Interface Invoices to Receivables, Autoinvoice Import, and GLO billing during month-end close. ASH shows no slow SQL. AWR shows no wait events. The Standard Manager has 80 free worker slots. This is a Conflict Resolution Manager incompatibility cascade — regional country programs like GLO Poland and GLO Brazil inherit the full incompatibility ruleset of their parent program, silently blocking the entire billing pipeline while the DBA chases database metrics that do not exist.',
  category: 'appsdba' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `During a critical financial closing window, the operations team flags severe delays. Three interconnected concurrent programs that normally complete within predictable windows are backing up for four to five hours:

- **PRC: Interface Invoices to Receivables** (Project Accounting)
- **Autoinvoice Import Program** (Accounts Receivable)
- **GLO - Draft Invoice Process** (Custom billing)

The DBA's first move is correct: pull Active Session History snapshots, query the Automated Workload Repository for long-running SQL IDs, look for buffer busy waits and latch contention in \`V\$SESSION\`. The profiling scripts run. They return empty. There are no active execution bottlenecks at the database layer.

The problem is not in the database. It never was.

---

## Two Failure Modes That Look Identical From the Outside

When a business user reports that a concurrent program is "taking five hours," that statement conflates two completely different failure modes:

**Mode 1 — The job is Running slowly.** Oracle is executing SQL, but the SQL is slow. Fix paths: execution plan regression, missing index, stale statistics, undo contention, segment locking.

**Mode 2 — The job is not Running at all.** The request has been submitted and accepted, but it is sitting in a PENDING state, waiting for a scheduling condition to clear. No SQL is executing. No database resources are being consumed. Database profiling tools return nothing because there is nothing to profile.

The distinction lives in two columns of \`FND_CONCURRENT_REQUESTS\`:

\`\`\`sql
-- Verify whether the job is actually executing or just queued
SELECT request_id,
       concurrent_program_name,
       phase_code,        -- 'P' = Pending, 'R' = Running, 'C' = Complete
       status_code,       -- 'I' = Normal, 'Q' = Standby, 'R' = Running, 'X' = Terminated
       requested_start_date,
       actual_start_date, -- NULL means it has never started
       actual_completion_date,
       hold_flag,
       priority
FROM   fnd_concurrent_requests
WHERE  concurrent_program_name IN ('PAXINPIR','RAXTRX','ARXTWAIT')
  AND  phase_code IN ('P','R')
ORDER BY requested_start_date;
\`\`\`

A row with \`phase_code = 'P'\` and \`actual_start_date IS NULL\` that has been in that state for hours is a scheduling problem. Stop tracing the database. Start tracing the Concurrent Manager.

---

## The Architecture of the Conflict Resolution Manager

Oracle EBS uses the **Conflict Resolution Manager (CRM)** to enforce logical scheduling rules across concurrent programs. The CRM exists because certain programs manipulate the same underlying transactional tables and cannot run simultaneously without risking logical data corruption — not physical corruption (which Oracle handles at the database level), but business-logic corruption: a billing program reading an invoice record while an interface program is mid-write, producing a half-processed transaction that passes all constraint checks but represents an invalid business state.

The CRM enforces these rules through **incompatibility definitions** stored in \`FND_CONCURRENT_PROGRAM_SERIAL\`. Each definition says: "If program A is running, program B cannot start (and vice versa)." The CRM checks these definitions every time a request moves from PENDING to RUNNING, and holds it in PENDING if any incompatible program is currently in a RUNNING state.

The incompatibility scope is either:
- **Exclusive** (\`scope_code = 'E'\`): the restriction applies across all requests system-wide
- **Set Check** (\`scope_code = 'S'\`): the restriction is scoped to a defined request set

In the month-end close scenario, all three programs have Exclusive incompatibilities:

| Program | Incompatible With |
|---------|------------------|
| PRC: Interface Invoices to Receivables | Itself (serial), Autoinvoice Import, PRC: Tieback Invoices |
| Autoinvoice Import Program | PRC: Interface Invoices, PRC: Tieback Invoices |
| PRC: Tieback Invoices from Receivables | Itself (serial), Autoinvoice Import |

These rules are correct. Running Interface Invoices and Autoinvoice Import simultaneously would create exactly the kind of half-processed invoice data the CRM exists to prevent.

The problem is not the rules. The problem is what else inherits them.

---

## The Cascade: Regional Programs Inheriting Global Incompatibilities

The month-end close introduced two regional country-specific programs to the processing pipeline:

- **GLO Poland — Pay on Receipt Autoinvoice Program**
- **GLO Brazil — Pay on Receipt Autoinvoice Program**

Both programs are localized variants built on the standard Autoinvoice framework. When they were created or cloned in the system, they were associated with the generic **Autoinvoice Import** concurrent program definition — which means they run under the same \`concurrent_program_id\` for incompatibility purposes, or they were explicitly added to the same incompatibility set as the parent.

The result: when the Poland and Brazil programs ran during the automated close, the CRM treated them as equivalent to the full Autoinvoice Import Program. Every other program that was incompatible with Autoinvoice Import was immediately blocked from starting. The Standard Manager had 80 free worker slots — but the CRM prevented the global billing and interface jobs from claiming any of them.

\`\`\`
Timeline:
12:00 — GLO Poland Pay on Receipt starts (treated as Autoinvoice)
12:00 — CRM blocks PRC: Interface Invoices to Receivables (incompatible with Autoinvoice)
12:00 — CRM blocks GLO Draft Invoice Process (incompatible with Autoinvoice)
14:30 — GLO Poland completes
12:00 — GLO Brazil Pay on Receipt starts (treated as Autoinvoice)
(same block continues)
17:00 — GLO Brazil completes
17:00 — PRC: Interface Invoices to Receivables finally starts (5 hours late)
17:05 — Cascade downstream jobs start, all 5 hours behind schedule
\`\`\`

From the DBA's perspective: ASH showed nothing. AWR showed nothing. The Standard Manager showed 60-70 idle slots. The jobs simply did not exist in \`V\$SESSION\` because they were never allowed to reach the database.

---

## Diagnosing the Incompatibility Web

The authoritative query for mapping which programs are blocking each other is a join across the FND incompatibility tables:

\`\`\`sql
SELECT
    fcp.concurrent_program_name              AS short_name,
    fcpt.user_concurrent_program_name        AS program_name,
    fcip.concurrent_program_name             AS incompat_short_name,
    fcipt.user_concurrent_program_name       AS incompat_program_name,
    DECODE(fci.scope_code, 'E', 'Exclusive', 'Set Check') AS scope
FROM   apps.fnd_concurrent_programs     fcp
JOIN   apps.fnd_concurrent_programs_tl  fcpt
       ON  fcp.concurrent_program_id = fcpt.concurrent_program_id
      AND  fcp.application_id        = fcpt.application_id
      AND  fcpt.language             = 'US'
JOIN   apps.fnd_concurrent_program_serial fci
       ON  fcp.concurrent_program_id = fci.running_concurrent_program_id
      AND  fcp.application_id        = fci.running_application_id
JOIN   apps.fnd_concurrent_programs     fcip
       ON  fci.to_run_concurrent_program_id = fcip.concurrent_program_id
      AND  fci.to_run_application_id        = fcip.application_id
JOIN   apps.fnd_concurrent_programs_tl  fcipt
       ON  fcip.concurrent_program_id = fcipt.concurrent_program_id
      AND  fcip.application_id        = fcipt.application_id
      AND  fcipt.language             = 'US'
WHERE  (
    UPPER(fcpt.user_concurrent_program_name) LIKE '%AUTOINVOICE%'
    OR UPPER(fcpt.user_concurrent_program_name) LIKE '%PRC: INTERFACE%'
    OR UPPER(fcpt.user_concurrent_program_name) LIKE '%TIEBACK%'
)
ORDER BY fcp.concurrent_program_name, fcip.concurrent_program_name;
\`\`\`

Run this with a broad WHERE clause during or after an incident to map the full incompatibility graph for the affected programs. Look specifically for:

1. **Self-incompatible programs** — programs that cannot run in parallel with themselves. These create an invisible serialization constraint that is easy to miss when multiple instances are submitted.
2. **Programs that appear multiple times as blockers** — these are hub nodes in the incompatibility graph. If one runs long, it blocks everything connected to it.
3. **Country or regional programs linked to standard program definitions** — these inherit all incompatibilities of the parent definition without the parent program's predictable runtime.

---

## Resolution: Three Paths Forward

### Path 1 (Immediate): Manual sequencing

During an active incident, identify which incompatible program is currently running (Phase = Running, Status = Normal) and whether it can be safely paused or allowed to complete first. If the blocking program is the regional variant and it is near completion, the fastest resolution is to wait. If it is early in its run, evaluate whether it can be rescheduled after the global jobs complete.

This is an operational decision, not a technical one — involve the business team before touching running jobs.

### Path 2 (Structural): Replace ad-hoc submissions with defined Request Sets

A **Request Set** in EBS defines a sequenced or staged group of programs with explicit ordering and stage dependencies. When regional programs are submitted inside a Request Set that defines their order relative to global programs, the CRM incompatibility collision becomes impossible: the Request Set handles the sequencing before the programs ever enter the manager queue.

In the month-end case: a Request Set that runs Poland and Brazil Pay on Receipt before the global Interface Invoices programs, and marks them Complete before the global programs are submitted, eliminates the incompatibility block entirely.

### Path 3 (Long-term): Audit and tighten the incompatibility matrix

Not every incompatibility on the books is still justified. Over years of EBS patches, customizations, and business process changes, incompatibility definitions accumulate. Some were added for a specific patch or upgrade and were never reviewed afterward. Schedule a quarterly review:

1. Query \`FND_CONCURRENT_PROGRAM_SERIAL\` for all Exclusive incompatibilities
2. For each pair, verify the underlying table dependency is still real (check actual DML in both programs)
3. Demote unnecessary Exclusive incompatibilities to Set Check, or remove them entirely

Reducing the incompatibility graph's density directly reduces the CRM's blocking surface area and makes month-end close scheduling more predictable.

---

## Summary

The four-hour delay in this case was caused by the CRM enforcing a correct but underspecified incompatibility rule. The rules themselves were right. The scheduling architecture that allowed regional programs with unpredictable runtimes to inherit global incompatibilities without explicit sequencing was the structural gap.

The key diagnostic insight: when a concurrent program is stalled, check \`phase_code\` and \`actual_start_date\` in \`FND_CONCURRENT_REQUESTS\` before opening a database profiling session. A PENDING job with a null \`actual_start_date\` is a scheduling problem. A RUNNING job with a high \`seconds_in_wait\` in \`V\$SESSION\` is a database problem. They look the same from the user's perspective — "the job is slow" — but they require completely different fix paths.

The companion runbook covers the complete diagnostic SQL set, how to identify the current blocking chain in real time, the Request Set configuration procedure, and a monitoring script that detects PENDING jobs stalled beyond configurable thresholds before they impact month-end close windows.`,
};

async function main() {
  console.log('Inserting EBS CRM queue block blog post...');
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
