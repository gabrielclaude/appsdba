import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Why Concurrent Manager Metadata Grows — and How to Stop the Slowdown',
  slug: 'ebs-concurrent-manager-metadata-growth',
  excerpt:
    'A plain-English guide to how Oracle EBS concurrent processing tables accumulate metadata, why it kills performance, and the overall strategy for keeping them lean.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-22'),
  youtubeUrl: null,
  content: `Every Oracle EBS instance has a ticking clock built into its concurrent processing architecture. On a moderately busy production instance running 20,000 requests per day, the main concurrent request table adds seven million rows per year. On a busy site with high-volume batch programs — AutoInvoice, GL Transfer, Order Import — that figure can reach 50 million rows per year. The performance consequences are predictable and, once you understand the mechanics, entirely preventable.

---

## The Three Tables That Accumulate

### FND_CONCURRENT_REQUESTS (FCR)

This is the central table. Every concurrent request ever submitted — whether it completed successfully, errored, was cancelled, or is still pending — generates a row. The row is never automatically deleted. It persists indefinitely unless explicitly purged.

Each row stores:

- \`REQUEST_ID\`: primary key, a sequence-generated number
- \`CONCURRENT_PROGRAM_ID\` + \`PROGRAM_APPLICATION_ID\`: what program ran
- \`PHASE_CODE\` / \`STATUS_CODE\`: C/C (Completed/Normal), C/E (Completed/Error), etc.
- \`ACTUAL_START_DATE\` / \`ACTUAL_COMPLETION_DATE\`: when it ran
- \`ARGUMENT_TEXT\`: the parameter values submitted with the request (can be several KB)
- \`LOGFILE_NAME\` / \`OUTFILE_NAME\`: paths to the log and output files
- \`REQUEST_DATE\`: when the request was submitted (used for purge date filtering)

On a 10-year-old EBS instance that has never been purged, FCR commonly reaches 100–500 million rows. At approximately 1–2 KB per row (including the ARGUMENT_TEXT and system fields), this means 100–500 GB of data in a single un-partitioned table.

### FND_CONCURRENT_PROCESSES (FCP)

One row per Concurrent Manager process that has ever started. The Internal Concurrent Manager, Standard Managers, Output Post Processor, and any custom managers each create a row when they start. This table is smaller than FCR but grows steadily and is included in the same purge operations.

### FND_FILE_TEMP

Concurrent program log and output content is sometimes cached in this table (in addition to being written to the filesystem). This is a LOB-based table — rows can be multi-megabyte. On instances with "Store log output in database" enabled, FND_FILE_TEMP can become larger than FCR itself.

---

## Why Accumulated Metadata Kills Performance

The performance degradation caused by FCR bloat operates through three distinct mechanisms.

### Mechanism 1: Concurrent Manager Scheduling Loop Degradation

The Internal Concurrent Manager runs a scheduling loop every few seconds. This loop queries FCR to:

1. Find pending requests that are eligible to run (phase_code = 'P', status_code = 'I')
2. Check the current active request count against manager capacities
3. Assign eligible requests to available manager worker processes

The key scheduling query joins FCR against FND_CONCURRENT_PROGRAMS and FND_CONCURRENT_QUEUES. On a table with 200 million rows, this query — even with optimal indexes — does significantly more index block reads than on a table with 10 million rows. As the scheduling loop slows, the effective throughput of the Concurrent Manager degrades. Users notice: requests that used to start in seconds now queue for minutes.

### Mechanism 2: User Interface Queries

The Submit Requests form, the View Requests form, and the System Administrator Concurrent Requests monitor all query FCR directly. The View Requests search in particular — which users run constantly to check whether their report has completed — performs range scans on FCR filtered by REQUESTED_BY and REQUEST_DATE. On a bloated FCR, these queries consume 10–30x more logical reads than on a lean table, making the UI slow even when the Concurrent Manager itself is lightly loaded.

### Mechanism 3: Bloated Indexes Consuming Buffer Cache

FCR has roughly a dozen indexes (N1 through N10 and variants). Each index entry for each FCR row consumes buffer cache when accessed. On a 200-million-row FCR, the index blocks alone may require 5–15 GB of buffer cache to stay reasonably warm. Buffer cache that Oracle is spending on FCR index blocks is not available for the actual application data (GL journal lines, AP invoice distributions) that determines EBS transaction performance.

---

## The Feedback Loop

Metadata bloat creates a self-reinforcing problem:

\`\`\`
Slow CM scheduling
    ↓
Requests wait longer in queue
    ↓
Users assume CM is broken, resubmit requests
    ↓
More duplicate requests in FCR
    ↓
FCR grows faster
    ↓
Scheduling loop slower still
\`\`\`

Breaking this loop requires purging FCR to interrupt the cycle, not just tuning Oracle parameters.

---

## Measuring the Problem

Before running any purge, quantify the current state:

\`\`\`sql
-- FCR and FCP segment sizes
SELECT segment_name, segment_type, ROUND(bytes/1024/1024/1024, 2) size_gb
FROM dba_segments
WHERE segment_name IN ('FND_CONCURRENT_REQUESTS', 'FND_CONCURRENT_PROCESSES', 'FND_FILE_TEMP')
  AND owner = 'APPLSYS'
ORDER BY bytes DESC;

-- FCR row count and date span
SELECT COUNT(*)                                      total_rows,
       MIN(request_date)                             oldest_request,
       MAX(request_date)                             newest_request,
       ROUND(COUNT(*) / (MAX(request_date) - MIN(request_date)), 0) rows_per_day
FROM applsys.fnd_concurrent_requests;

-- FCR breakdown by phase/status
SELECT phase_code, status_code,
       DECODE(phase_code, 'C', 'Completed', 'P', 'Pending', 'R', 'Running', 'I', 'Inactive', phase_code) phase_desc,
       DECODE(status_code, 'C', 'Normal', 'E', 'Error', 'W', 'Warning', 'D', 'Cancelled', 'X', 'Terminated', status_code) status_desc,
       COUNT(*) row_count
FROM applsys.fnd_concurrent_requests
GROUP BY phase_code, status_code
ORDER BY row_count DESC;

-- Top 20 programs by lifetime request count
SELECT cp.concurrent_program_name,
       cp.user_concurrent_program_name,
       COUNT(*) total_requests,
       ROUND(COUNT(*) / (SELECT MAX(request_date) - MIN(request_date) FROM applsys.fnd_concurrent_requests), 1) reqs_per_day
FROM applsys.fnd_concurrent_requests fcr
JOIN applsys.fnd_concurrent_programs cp
  ON fcr.concurrent_program_id = cp.concurrent_program_id
  AND fcr.program_application_id = cp.application_id
GROUP BY cp.concurrent_program_name, cp.user_concurrent_program_name
ORDER BY total_requests DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

---

## What Oracle's Purge Does (and Doesn't Do)

Oracle provides the \`FNDCPPUR\` concurrent program (Purge Concurrent Request and/or Manager Data) to remove old FCR rows. Understanding its behaviour prevents the common mistake of running it and expecting table space to shrink.

### What FNDCPPUR deletes

Running FNDCPPUR with Phase=Completed, Status=Normal, Days=60 deletes FCR rows where:
- \`phase_code = 'C'\` (Completed)
- \`status_code = 'C'\` (Normal)
- \`request_date < SYSDATE - 60\`

It also deletes matching rows from:
- \`FND_CONCURRENT_PROCESSES\` (orphaned manager process records)
- \`FND_CONCURRENT_QUEUES_SUMMARY\` (queue history)
- \`FND_FILE_TEMP\` (cached log/output content for deleted requests)

### What FNDCPPUR does NOT do

FNDCPPUR performs DELETE statements. The deleted rows leave empty space (free blocks) within the existing segment extents, but Oracle does **not** return that space to the operating system or shrink the segment. After purging 100 million rows from a 50 GB FCR segment, the segment is still 50 GB — it is just mostly empty blocks.

To actually reclaim space after a purge, use:

\`\`\`sql
-- Option 1: SHRINK SPACE (online, requires row movement)
ALTER TABLE applsys.fnd_concurrent_requests ENABLE ROW MOVEMENT;
ALTER TABLE applsys.fnd_concurrent_requests SHRINK SPACE CASCADE;
-- CASCADE includes indexes — this can take hours on a large table

-- Option 2: DBMS_REDEFINITION (zero-downtime, preferred for production)
-- Redefines the table in-place, keeping only non-deleted rows
EXEC DBMS_REDEFINITION.CAN_REDEF_TABLE('APPLSYS', 'FND_CONCURRENT_REQUESTS');
-- Then proceed with full DBMS_REDEFINITION.START_REDEF_TABLE / FINISH_REDEF_TABLE
\`\`\`

For most EBS sites, space reclaim is optional — the key goal is reducing row count for query performance, not recovering disk space.

---

## The Purge Strategy

### Tier 1: Immediate (Run Now if FCR > 20 Million Rows)

Purge completed-normal requests older than 60 days. This safely removes the bulk of historical data without affecting any in-flight or recently completed requests that users might still reference.

### Tier 2: Standard Ongoing Schedule

Run FNDCPPUR automatically, daily at 2:00 AM:

| Phase | Status | Retention Days | Rationale |
|-------|--------|---------------|-----------|
| Completed | Normal | 60 | Users rarely look at reports older than 2 months |
| Completed | Error | 30 | Keep recent errors for investigation |
| Completed | Warning | 30 | Same as errors |
| Pending | Cancelled | 7 | No value in keeping cancelled requests |
| Pending | Terminated | 7 | Same as cancelled |

### Tier 3: High-Volume Program Exception

Some concurrent programs generate extreme volumes of child requests. Oracle AutoInvoice, for example, creates one FCR row per invoice batch line in some configurations — potentially millions of rows per nightly run. For these programs, consider reducing the purge retention to 14–30 days to prevent accumulation.

Identify these programs:

\`\`\`sql
-- Programs generating > 10,000 requests per day on average
SELECT cp.concurrent_program_name,
       COUNT(*) total,
       ROUND(COUNT(*) / NULLIF(MAX(request_date) - MIN(request_date), 0), 0) avg_per_day
FROM applsys.fnd_concurrent_requests fcr
JOIN applsys.fnd_concurrent_programs cp
  ON fcr.concurrent_program_id = cp.concurrent_program_id
  AND fcr.program_application_id = cp.application_id
GROUP BY cp.concurrent_program_name
HAVING COUNT(*) / NULLIF(MAX(request_date) - MIN(request_date), 0) > 10000
ORDER BY avg_per_day DESC;
\`\`\`

---

## Post-Purge Index Maintenance

After a significant purge (deleting > 20% of FCR rows), indexes become less efficient — the deleted leaf blocks remain in the B-tree, increasing logical reads. Rebuild the key FCR indexes:

\`\`\`sql
-- Check index efficiency (ANALYZE, then check clustering factor)
ANALYZE INDEX applsys.fnd_concurrent_requests_n1 VALIDATE STRUCTURE;
SELECT del_lf_rows / lf_rows * 100 pct_deleted FROM index_stats;
-- If > 20%: rebuild

-- Online rebuild (minimal locking — safe for production)
ALTER INDEX applsys.fnd_concurrent_requests_n1 REBUILD ONLINE;
ALTER INDEX applsys.fnd_concurrent_requests_n2 REBUILD ONLINE;
ALTER INDEX applsys.fnd_concurrent_requests_n3 REBUILD ONLINE;
ALTER INDEX applsys.fnd_concurrent_requests_n4 REBUILD ONLINE;
ALTER INDEX applsys.fnd_concurrent_requests_n5 REBUILD ONLINE;

-- Gather statistics after rebuild
EXEC DBMS_STATS.GATHER_TABLE_STATS('APPLSYS', 'FND_CONCURRENT_REQUESTS', CASCADE => TRUE);
\`\`\`

---

## Summary

FND_CONCURRENT_REQUESTS grows by millions of rows per year on every active EBS instance. Left unpurged, it degrades the Concurrent Manager's scheduling loop, slows user interface queries, and consumes buffer cache with index blocks. The fix is straightforward: schedule FNDCPPUR to run daily, tune the retention periods for your site's request volume, and rebuild indexes after the first major purge. The companion runbook provides the step-by-step procedure for assessing bloat, running the initial purge, performing index maintenance, and setting up the ongoing schedule.`,
};

async function main() {
  console.log('Inserting EBS Concurrent Manager metadata blog post...');
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
