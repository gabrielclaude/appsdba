import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Extract Lags: A Real-World Masterclass in LogMiner Contention',
  slug: 'goldengate-extract-lag-logminer-contention',
  excerpt:
    'A production case study of a 135-hour GoldenGate Integrated Extract lag on Oracle 19c/OGG 21.7 caused not by application transactions but by enq: MN - contention between LogMiner background processes. Root cause: stale CBO statistics on LOGMN% dictionary tables. Includes diagnostic path through gv$session, the targeted DBMS_STATS fix, and why Classic Extract is no longer an option on OGG 21.1+.',
  category: 'golden-gate-problems' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-08'),
  youtubeUrl: null,
  content: `Database Administrators (DBAs) running Oracle GoldenGate (OGG) integrated capture environments are likely familiar with the dreaded scenario: an Extract process begins falling behind, reporting severe checkpoint lag, while warning of long-running transactions.

Yet, when you query active sessions on the database, there isn't a single long-running transaction to be found.

This exact issue recently surfaced in a critical production environment (Oracle Database 19c / GoldenGate 21.7). The breakdown of the diagnostic journey offers a textbook case of how database-level dictionary contention can cripple real-time data replication — and how to fix it.

---

## The Anatomy of the Ghost Lag

In an integrated deployment, the OGG Extract process doesn't mine raw redo logs directly from the OS file system. Instead, it delegates that heavy lifting to an internal database infrastructure called LogMiner, communicating via an inbound server.

When the replication pipeline backed up, a deep dive into the OGG status (\`info ELASAUD\`) revealed an astonishing metric:

\`\`\`
Checkpoint Lag:  135 Hours, 46 Minutes, 57 Seconds

Log Read Checkpoint: Oracle Integrated Redo Logs
2026-06-02 15:04:17
SCN 2515.609824878 (10802452574318)
\`\`\`

The extract was running, but it was stuck processing redo data from nearly six days prior. Even worse, the OGG command \`send extract ELASAUD, showtrans\` displayed dozens of active transactions with 0 items inside them, completely stagnant since June 2nd.

The database itself was sending warnings about long-running transactions because LogMiner couldn't advance its recovery checkpoint. But why?

---

## Chasing Down the Blocker: enq: MN - contention

By shifting focus from GoldenGate commands directly to Oracle's session views (\`gv$session\`), the engineering team found the true culprit lurking in the database kernel.

The background processes assigned to the GoldenGate capture mechanism (MS00 and MS06) were trapped in a classic blocker-waiter deadlock:

- **BLOCKER (SID 5428):** Executing an internal LogMiner module (MS00), holding up resources while performing a heavy physical read (\`db file scattered read\`).
- **WAITER (SID 2209):** A secondary LogMiner process (MS06), stuck in a hard wait state for the event \`enq: MN - contention\`.

In Oracle Database, the MN enqueue protects the internal metadata and dictionary objects used by LogMiner. When multiple LogMiner processes compete for this enqueue, or when the queries managing the internal LogMiner tables run exceptionally slow, replication grinds to a halt.

The diagnostic query that surfaced the contention:

\`\`\`sql
SELECT
    s.sid,
    s.serial#,
    s.status,
    s.program,
    s.event,
    s.wait_class,
    s.seconds_in_wait,
    s.blocking_session,
    s.blocking_session_serial#
FROM gv$session s
WHERE s.program LIKE '%OGG%'
   OR s.event    LIKE '%MN%'
   OR s.event    LIKE '%LogMiner%'
ORDER BY s.seconds_in_wait DESC;
\`\`\`

---

## The Solution: Banishing Stale Dictionary Stats

When LogMiner catalog queries slow down to a crawl, it is almost always driven by one foundational database issue: stale Cost-Based Optimizer (CBO) statistics on data dictionary and system tables.

As millions of rows flow through an enterprise database, Oracle's internal tracking tables — specifically those prefixed with \`LOGMN%\` inside the \`SYS\` and \`SYSTEM\` schemas — fluctuate wildly in size. If the statistics on these internal tables are out-of-date, Oracle's optimizer chooses highly inefficient execution plans, triggering immense I/O bottlenecks and the resulting \`enq: MN - contention\`.

### Verify Whether Stats Are Stale

Before running the fix, confirm the problem:

\`\`\`sql
SELECT owner, table_name, num_rows, last_analyzed, stale_stats
FROM   dba_tab_statistics
WHERE  table_name LIKE 'LOGMN%'
AND    owner IN ('SYS','SYSTEM')
ORDER BY last_analyzed NULLS FIRST;
\`\`\`

Tables showing \`STALE_STATS = YES\` or a \`LAST_ANALYZED\` date weeks in the past are the likely cause.

### Targeted Fix: Rebuild LogMiner Table Statistics

While executing a global dictionary analysis via \`DBMS_STATS.GATHER_DICTIONARY_STATS\` is the ultimate long-term fix, production databases during peak hours need immediate, surgical relief.

A targeted workaround forces the database to specifically rebuild the metadata routing maps for LogMiner partitions:

\`\`\`sql
BEGIN
    FOR c_tab IN (
        SELECT owner, table_name
        FROM dba_tables
        WHERE table_name LIKE 'LOGMN%'
          AND owner IN ('SYS','SYSTEM')
    ) LOOP
        DBMS_STATS.GATHER_TABLE_STATS(
            ownname          => c_tab.owner,
            tabname          => c_tab.table_name,
            estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,
            method_opt       => 'FOR ALL COLUMNS SIZE AUTO',
            degree           => 4,
            no_invalidate    => FALSE
        );
    END LOOP;
END;
/
\`\`\`

The \`no_invalidate => FALSE\` parameter is critical — it forces immediate cursor invalidation so the optimizer picks up the new statistics without waiting for the next natural invalidation cycle.

### Longer-Term: Full Dictionary Stats Refresh

Once the immediate pressure is relieved, schedule a full dictionary stats gather in the next available maintenance window:

\`\`\`sql
EXEC DBMS_STATS.GATHER_DICTIONARY_STATS;
\`\`\`

Consider automating this as part of a weekly maintenance job rather than leaving it to the default automatic stats collection window, which may deprioritise system schema tables during high-throughput periods.

---

## The Pitfall to Avoid: Don't Rush to Classic Extract

When troubleshooting an integrated capture lag under extreme pressure, a common temptation is to propose downgrading or converting the architecture back to a Classic Extract. The rationale is that bypassing LogMiner will eliminate database-side enqueue bottlenecks entirely.

However, modern OGG environments have a hard boundary. **Oracle GoldenGate entirely desupported Classic Extract for Oracle Databases starting with version 21.1.**

If you are running modern versions like OGG 21.7 or higher, attempting a downgrade to Classic Extract isn't just an unsupported strategy — it's a technical impossibility. The architecture must remain integrated, which highlights why mastering system-level dictionary health is vital for production DBAs.

---

## Monitoring Script: Catching enq: MN - contention Early

Add this to your DBA toolkit to catch LogMiner contention before it builds into hours of lag:

\`\`\`sql
-- Flag any session waiting on MN enqueue for more than 30 seconds
SELECT
    inst_id,
    sid,
    serial#,
    username,
    program,
    event,
    seconds_in_wait,
    blocking_session,
    state
FROM gv$session
WHERE event = 'enq: MN - contention'
AND   seconds_in_wait > 30
ORDER BY seconds_in_wait DESC;
\`\`\`

Pair this with a check on GoldenGate capture lag from the database side:

\`\`\`sql
SELECT
    capture_name,
    status,
    captured_scn,
    applied_scn,
    required_checkpoint_scn,
    (SYSDATE - SCN_TO_TIMESTAMP(required_checkpoint_scn)) * 24 AS lag_hours
FROM dba_capture
ORDER BY lag_hours DESC NULLS LAST;
\`\`\`

If \`lag_hours\` from \`dba_capture\` is growing and \`enq: MN - contention\` is present in \`gv$session\`, stale \`LOGMN%\` statistics are the first thing to investigate.

---

## Lessons Learned for Production DBAs

**Look Beneath the App**
GoldenGate performance issues are frequently symptoms of underlying Oracle database performance tuning anomalies. The extract report and GoldenGate commands are the first stop, but the real answer is often in \`gv$session\` and the wait event interface.

**Monitor Your Enqueues**
Keep scripts handy to flag \`enq: MN - contention\` and trace them back to the active \`gv$session\` IDs. A blocker holding an MN enqueue for more than a few minutes while GoldenGate is running is a reliable early warning of impending lag.

**Automate Dictionary Maintenance**
Ensure your standard database maintenance windows include regular statistic collections for system metadata, preventing LogMiner tables from blinding the cost-based optimizer. The \`LOGMN%\` tables are invisible to most DBAs until GoldenGate starts screaming.

**Classic Extract Is Gone**
If you're running OGG 21.1 or later, there is no fallback to Classic Extract. Integrated capture is the only supported path, making database-level LogMiner health a first-class operational concern rather than a nice-to-have.`,
};

async function main() {
  console.log('Inserting GoldenGate LogMiner contention post...');
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
