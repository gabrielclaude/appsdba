import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Resolving GoldenGate Extract Lag: A Production Case Study',
  slug: 'goldengate-extract-lag-production-case-study',
  excerpt:
    'A production incident case study: an Oracle GoldenGate 21.7 Integrated Extract on Oracle 19c reporting 94 hours of lag while remaining in RUNNING status. How the team worked through OGG-01027 false signals, duplicate TABLE/MAP entries, and archive log purge policy gaps to find and resolve the real bottleneck.',
  category: 'golden-gate-problems' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-08'),
  youtubeUrl: null,
  content: `## The Problem: Persistent GoldenGate Lag

In a high-throughput production environment, data replication latency is a critical issue that demands immediate attention. This post details a recent production case study involving an Oracle GoldenGate (OGG) Integrated Extract experiencing severe lag, exploring how the engineering team isolated the bottleneck and navigated a complex troubleshooting path.

The production database — an **Oracle 19c (19.24)** single-instance database hosting critical transaction schemas — replicates data via **Oracle GoldenGate 21.7**.

The operations team flagged a major incident when the integrated extract (which we'll call **EXT_PROD**) reported **approximately 94 hours of lag**. Interestingly, the process itself was not failing; it maintained a steady \`RUNNING\` status.

### Initial Technical Findings

- **Status:** \`EXT_PROD\` remained active, with SCN (System Change Number) numbers continuously progressing.
- **GoldenGate Capture:** Queries against \`V$GOLDENGATE_CAPTURE\` confirmed that the state was actively \`CAPTURING CHANGES\` with no native internal failures.
- **Infrastructure:** Resource utilization wasn't an issue. The database servers are hosted on a high-specification cloud environment with top-tier CPU and I/O throughput allocations.
- **Database Lock Check:** Initial reviews of \`V$TRANSACTION\`, \`V$SESSION\`, and \`DBA_2PC_PENDING\` showed no long-running active user sessions or orphaned distributed transactions.

---

## Deep-Dive Investigation & False Signals

With the extract actively running but falling further behind, the team looked closely at the Extract Report file. The log surfaced repeated occurrences of the following warning:

> \`OGG-01027: Long running transaction warning ... XID 0.469.20.2669234, Items = 0\`

### Sifting Through the Red Herrings

An \`OGG-01027\` warning typically points to an uncommitted transaction in the database that forces GoldenGate to keep reading from an older checkpoint. However, cross-checking the Transaction ID (XID) against the database returned **no active records**.

Furthermore, a duplicate table/map entry was detected in the parameter file:

> \`OGG-02081 Detected duplicate TABLE/MAP entry\`

While parameters required cleaning, diagnostic data proved this metadata anomaly was not causing the performance degradation. Instead, checking the active processing rate showed that the extract's throughput was scaling upward — climbing steadily from **20 records/sec to 51 records/sec** — confirming the process was starved of data rather than frozen.

---

## Finding the Root Cause: The Missing Archive Logs

The turning point in the investigation came when analyzing the GoldenGate log read checkpoints and archive log sequence data.

\`\`\`sql
SELECT thread#, sequence#, first_time, next_time, blocks
FROM gv$archived_log
WHERE sequence# BETWEEN 166740 AND 166760
ORDER BY sequence#;
\`\`\`

The integrated capture architecture requires consecutive access to raw redo and archive streams. Diagrams of the transaction timelines revealed that the extract was attempting to read data modified days prior.

The core bottleneck was not the processing engine itself: **critical archive logs from days prior had been purged or unlinked from the active directory.** Because the required checkpoint SCN pointed back to a past timestamp, the integrated capture engine was bottlenecked, waiting on sequential log streams that were no longer directly accessible on the file system.

---

## Action Plan and Resolution

To safely recover without data loss, the engineering team executed a controlled, multi-stage recovery strategy.

### 1. Manual Bounded Recovery Checkpoint

To stabilize the current state and prevent the extract from needing to scan further back upon any accidental restart, a manual Bounded Recovery (BR) checkpoint was successfully forced:

\`\`\`
SEND EXTRACT EXT_PROD, BR BRCHECKPOINT IMMEDIATE
\`\`\`

The report files validated completion successfully (\`OGG-01738\` / \`OGG-01631\`), writing a clean recovery file to disk.

### 2. Archive Log Restoration

Because the extract required historical data, the client team immediately initiated a restore of the missing archive logs from their cloud storage buckets back to the database environment.

\`\`\`
Restoring sequence *_166747_* and 34 subsequent historical log files...
Estimated restoration time: 30–45 minutes.
\`\`\`

### 3. Verification Post-Restore

Once the required archive logs were restored to the filesystem and cataloged, the Integrated Extract automatically began sequentially processing the data. With the infrastructure's high-throughput I/O capacity, the extract was positioned to rapidly clear its processing backlog and reduce the 94-hour lag down to zero.

---

## Key Takeaways for DBAs

**1. Don't Trust Status Alone**
An extract in a \`RUNNING\` status can still be effectively stalled if it is missing the underlying OS-level log resources it needs to mine.

**2. Validate OGG Warnings Against DB Truth**
An \`OGG-01027\` warning showing \`Items = 0\` usually implies GoldenGate is tracking historical metadata internal to its cache, not necessarily a live database lock.

**3. Align Purge Policies with OGG Checkpoints**
Ensure your RMAN or filesystem archive log deletion policies are tightly coupled with the \`required_checkpoint_scn\` from \`dba_capture\` to prevent critical logs from being deleted before GoldenGate can process them.

\`\`\`sql
-- Run this before any archive log purge to confirm OGG has processed past this SCN
SELECT capture_name, required_checkpoint_scn, status
FROM   dba_capture;
\`\`\`

Never purge archive logs with a \`first_change#\` newer than \`required_checkpoint_scn\` from any active capture process.`,
};

async function main() {
  console.log('Inserting GoldenGate extract lag case study...');
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
