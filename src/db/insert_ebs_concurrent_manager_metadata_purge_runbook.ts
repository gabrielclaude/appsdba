import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Purging Oracle EBS Concurrent Manager Metadata',
  slug: 'ebs-concurrent-manager-metadata-purge-runbook',
  excerpt:
    'Step-by-step operational runbook for assessing table bloat, running FNDCPPUR, post-purge index maintenance, scheduling recurring purges, and monitoring ongoing growth.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-22'),
  youtubeUrl: null,
  content: `This runbook provides the step-by-step procedure for purging Oracle EBS Concurrent Manager metadata. Assumptions: Oracle EBS R12.2.x, Oracle Database 12.2 or later, DBA access to APPLSYS schema, System Administrator responsibility in EBS.

---

## Phase 0: Assess Bloat

### Step 0.1 — Check FCR and FCP Segment Sizes

\`\`\`sql
-- Connect as DBA user (not APPS)
sqlplus / as sysdba

-- Segment sizes for key CM tables
SELECT segment_name,
       segment_type,
       ROUND(bytes/1024/1024/1024, 3) size_gb,
       ROUND(bytes/1024/1024, 0) size_mb
FROM dba_segments
WHERE owner = 'APPLSYS'
  AND segment_name IN (
    'FND_CONCURRENT_REQUESTS',
    'FND_CONCURRENT_PROCESSES',
    'FND_FILE_TEMP',
    'FND_CONCURRENT_QUEUES_SUMMARY'
  )
ORDER BY bytes DESC;
\`\`\`

Record the current sizes. You will compare these post-purge.

### Step 0.2 — Check FCR Row Count and Date Range

\`\`\`sql
SELECT COUNT(*) total_rows,
       MIN(request_date) oldest_row,
       MAX(request_date) newest_row,
       TRUNC(MAX(request_date)) - TRUNC(MIN(request_date)) days_of_history
FROM applsys.fnd_concurrent_requests;
\`\`\`

**Decision matrix:**

| FCR Row Count | Action |
|--------------|--------|
| < 5 million | Monthly purge schedule is adequate; no emergency action needed |
| 5–20 million | Run purge this week; implement daily schedule |
| 20–50 million | Run purge immediately; plan maintenance window for index rebuild |
| > 50 million | Emergency: run purge during off-hours; consider multiple purge passes |

### Step 0.3 — Check FCR by Phase/Status

\`\`\`sql
SELECT phase_code, status_code, COUNT(*) row_count,
       MIN(request_date) oldest, MAX(request_date) newest
FROM applsys.fnd_concurrent_requests
GROUP BY phase_code, status_code
ORDER BY row_count DESC;
\`\`\`

Note the breakdown. C/C (Completed/Normal) is always the largest group and safe to purge aggressively. C/E (Completed/Error) should be purged with a shorter retention for active investigation.

### Step 0.4 — Check FND_FILE_TEMP Size

\`\`\`sql
-- FND_FILE_TEMP LOB storage
SELECT s.segment_name, l.column_name,
       ROUND(s.bytes/1024/1024/1024, 2) segment_gb
FROM dba_segments s
JOIN dba_lobs l ON s.segment_name = l.segment_name
WHERE l.owner = 'APPLSYS'
  AND l.table_name = 'FND_FILE_TEMP'
ORDER BY s.bytes DESC;
\`\`\`

### Step 0.5 — Verify No Stuck Running Requests

Before purging, confirm no requests are in an incorrectly "Running" state (phase_code = 'R') that have been running for more than 24 hours — these may indicate CM problems that should be investigated before purging.

\`\`\`sql
SELECT fcr.request_id,
       cp.concurrent_program_name,
       fcr.actual_start_date,
       ROUND((SYSDATE - fcr.actual_start_date) * 24, 1) hours_running,
       fcr.phase_code, fcr.status_code
FROM applsys.fnd_concurrent_requests fcr
JOIN applsys.fnd_concurrent_programs cp
  ON fcr.concurrent_program_id = cp.concurrent_program_id
  AND fcr.program_application_id = cp.application_id
WHERE fcr.phase_code = 'R'
  AND (SYSDATE - fcr.actual_start_date) * 24 > 24
ORDER BY hours_running DESC;
\`\`\`

If stuck requests are found: investigate and terminate them before proceeding. Stuck requests in the Running state will not be purged by FNDCPPUR but may indicate a broader CM problem.

---

## Phase 1: Pre-Purge Snapshot

### Step 1.1 — Record Baseline Metrics

Save output from Phase 0 queries to a file. You will use this to measure purge effectiveness.

\`\`\`sql
-- Save to spool file
SPOOL /tmp/fcr_baseline_$(date +%Y%m%d).txt

SELECT SYSDATE snapshot_time, 'FCR' tbl, COUNT(*) rows,
       ROUND(SUM(CASE WHEN phase_code='C' AND status_code='C' THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) pct_completed_normal
FROM applsys.fnd_concurrent_requests;

SPOOL OFF
\`\`\`

### Step 1.2 — Verify Concurrent Manager is Running

\`\`\`sql
-- Check ICM (Internal Concurrent Manager) process
SELECT concurrent_process_id, concurrent_queue_id,
       process_status_code,
       os_process_id,
       last_update_date
FROM applsys.fnd_concurrent_processes
WHERE concurrent_queue_id = 1  -- ICM queue_id = 1
ORDER BY last_update_date DESC
FETCH FIRST 5 ROWS ONLY;
-- Expected: at least one row with process_status_code = 'A' (Active)
\`\`\`

### Step 1.3 — Identify Upcoming Critical Batch Schedules

Check whether any critical batch programs (GL period close, AutoInvoice, Order Import) are scheduled to run within the next 4 hours. If yes, delay the purge until those complete — FNDCPPUR itself is a concurrent request and will compete for CM workers.

---

## Phase 2: Run FNDCPPUR

FNDCPPUR is submitted as a concurrent request from within EBS. Navigate to:
**System Administrator > Concurrent > Run > Single Request**

Search for: **Purge Concurrent Request and/or Manager Data**

Submit the following passes in order, waiting for each to complete before submitting the next:

### Step 2.1 — Pass 1: Completed/Normal (primary cleanup)

| Parameter | Value |
|-----------|-------|
| Mode | Programs |
| Days | 60 |
| Phase | Completed |
| Status | Normal |

This deletes FCR rows where phase_code='C', status_code='C', request_date < SYSDATE-60.

### Step 2.2 — Pass 2: Completed/Error

| Parameter | Value |
|-----------|-------|
| Mode | Programs |
| Days | 30 |
| Phase | Completed |
| Status | Error |

### Step 2.3 — Pass 3: Completed/Warning

| Parameter | Value |
|-----------|-------|
| Mode | Programs |
| Days | 30 |
| Phase | Completed |
| Status | Warning |

### Step 2.4 — Pass 4: Cancelled

| Parameter | Value |
|-----------|-------|
| Mode | Programs |
| Days | 7 |
| Phase | Pending |
| Status | Cancelled |

### Step 2.5 — Pass 5: Terminated

| Parameter | Value |
|-----------|-------|
| Mode | Programs |
| Days | 7 |
| Phase | Pending |
| Status | Terminated |

### Step 2.6 — Monitor Purge Progress

\`\`\`sql
-- Watch active FNDCPPUR request
SELECT request_id,
       ROUND((SYSDATE - actual_start_date) * 60, 1) mins_running,
       phase_code, status_code
FROM applsys.fnd_concurrent_requests
WHERE concurrent_program_id = (
  SELECT concurrent_program_id FROM applsys.fnd_concurrent_programs
  WHERE concurrent_program_name = 'FNDCPPUR'
  AND application_id = 0)
ORDER BY request_id DESC
FETCH FIRST 3 ROWS ONLY;
\`\`\`

Expected runtime: 10–60 minutes for the first pass on a moderately bloated table, up to several hours on a 100M+ row table.

### Step 2.7 — Verify Row Count Reduction

\`\`\`sql
SELECT COUNT(*) rows_after_purge FROM applsys.fnd_concurrent_requests;
-- Compare to baseline. Successful purge should reduce count by 60-90% on first run.
\`\`\`

---

## Phase 3: Post-Purge Index Maintenance

### Step 3.1 — Identify Indexes on FCR

\`\`\`sql
SELECT index_name, status, blevel, leaf_blocks, distinct_keys,
       ROUND(leaf_blocks * 8192 / 1024 / 1024, 1) index_size_mb
FROM dba_indexes
WHERE table_owner = 'APPLSYS'
  AND table_name = 'FND_CONCURRENT_REQUESTS'
ORDER BY leaf_blocks DESC;
\`\`\`

### Step 3.2 — Check for Unusable Indexes

\`\`\`sql
SELECT index_name, status
FROM dba_indexes
WHERE table_owner = 'APPLSYS'
  AND table_name = 'FND_CONCURRENT_REQUESTS'
  AND status = 'UNUSABLE';
\`\`\`

If any indexes show UNUSABLE: rebuild them before proceeding. Unusable indexes cause query failures.

### Step 3.3 — Rebuild Key Indexes Online

\`\`\`sql
-- Rebuild the most heavily-used FCR indexes (online = no DML lock on table)
ALTER INDEX applsys.fnd_concurrent_requests_n1 REBUILD ONLINE;
ALTER INDEX applsys.fnd_concurrent_requests_n2 REBUILD ONLINE;
ALTER INDEX applsys.fnd_concurrent_requests_n3 REBUILD ONLINE;
ALTER INDEX applsys.fnd_concurrent_requests_n4 REBUILD ONLINE;
ALTER INDEX applsys.fnd_concurrent_requests_n5 REBUILD ONLINE;
ALTER INDEX applsys.fnd_concurrent_requests_n6 REBUILD ONLINE;
\`\`\`

Each rebuild takes 5–20 minutes depending on FCR size and server I/O capacity.

### Step 3.4 — Gather Optimizer Statistics

\`\`\`sql
EXEC DBMS_STATS.GATHER_TABLE_STATS(
  ownname    => 'APPLSYS',
  tabname    => 'FND_CONCURRENT_REQUESTS',
  cascade    => TRUE,          -- includes indexes
  degree     => 4,             -- parallel gather
  no_invalidate => FALSE       -- immediately invalidate cached cursors
);

EXEC DBMS_STATS.GATHER_TABLE_STATS('APPLSYS', 'FND_CONCURRENT_PROCESSES', CASCADE => TRUE);
\`\`\`

---

## Phase 4: Schedule Recurring Purge

### Step 4.1 — Submit FNDCPPUR as a Repeating Request

From EBS: System Administrator > Concurrent > Run > Single Request

Submit **Purge Concurrent Request and/or Manager Data** with:
- Mode: Programs
- Days: 60
- Phase: Completed
- Status: Normal

In the Schedule section:
- Recurrence: Periodically
- Interval: 1 Day
- Start Time: 02:00 (2:00 AM — low CM activity window)

### Step 4.2 — Verify the Scheduled Request

\`\`\`sql
-- Confirm the repeating request appears in pending/scheduled state
SELECT request_id, requested_start_date, phase_code, status_code,
       resubmit_interval, resubmit_interval_unit_code
FROM applsys.fnd_concurrent_requests
WHERE concurrent_program_id = (
  SELECT concurrent_program_id FROM applsys.fnd_concurrent_programs
  WHERE concurrent_program_name = 'FNDCPPUR' AND application_id = 0)
  AND phase_code = 'P'
  AND status_code = 'S'  -- Scheduled
ORDER BY requested_start_date;
\`\`\`

### Step 4.3 — Set Up Error/Warning Purge Weekly

Repeat Step 4.1 for Completed/Error and Completed/Warning with Days=30, scheduled weekly (Sundays at 03:00 AM).

---

## Phase 5: Monitoring

### Step 5.1 — FCR Size Alert Query

Add this to your monitoring framework (OEM, custom script, or Grafana):

\`\`\`sql
-- Alert if FCR exceeds 20 million rows
SELECT CASE WHEN COUNT(*) > 20000000
       THEN 'ALERT: FCR exceeds 20M rows — purge needed'
       ELSE 'OK: FCR row count within threshold'
       END alert_status,
       COUNT(*) current_row_count
FROM applsys.fnd_concurrent_requests;
\`\`\`

### Step 5.2 — Confirm Daily Purge is Running

\`\`\`sql
-- Check FNDCPPUR completed successfully in the last 24 hours
SELECT request_id, actual_start_date, actual_completion_date, phase_code, status_code
FROM applsys.fnd_concurrent_requests
WHERE concurrent_program_id = (
  SELECT concurrent_program_id FROM applsys.fnd_concurrent_programs
  WHERE concurrent_program_name = 'FNDCPPUR' AND application_id = 0)
  AND actual_start_date > SYSDATE - 1
ORDER BY request_id DESC;
-- Expected: phase_code=C, status_code=C (Completed/Normal)
\`\`\`

### Step 5.3 — Weekly FCR Growth Tracking

\`\`\`sql
-- Track week-over-week row count (run weekly, store results)
SELECT TRUNC(SYSDATE, 'IW') week_start,
       COUNT(*) fcr_row_count,
       COUNT(*) - LAG(COUNT(*)) OVER (ORDER BY TRUNC(request_date, 'IW')) weekly_delta
FROM applsys.fnd_concurrent_requests
WHERE request_date > SYSDATE - 90
GROUP BY TRUNC(request_date, 'IW')
ORDER BY week_start DESC;
\`\`\`

If weekly delta is consistently positive after establishing daily purge: the purge retention period is too long for your site's request volume. Reduce Days parameter from 60 to 30.`,
};

async function main() {
  console.log('Inserting EBS Concurrent Manager metadata purge runbook...');
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
