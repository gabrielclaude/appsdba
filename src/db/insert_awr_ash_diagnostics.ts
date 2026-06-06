import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle AWR and ASH: Performance Diagnostics Architecture and Methodology',
  slug: 'oracle-awr-ash-performance-diagnostics',
  excerpt:
    'Oracle AWR and ASH form the foundation of performance diagnostics in Oracle Database — AWR captures time-series snapshots of system-wide statistics while ASH samples every active session every second, together enabling precise identification of bottlenecks down to the minute. This post explains the MMON/MMNL architecture, wait event model, SQL-level diagnosis, ADDM automated analysis, and the Diagnostics Pack licensing requirements every DBA must understand.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-05'),
  youtubeUrl: null,
  content: `## Introduction

Oracle Database has included self-managing performance infrastructure since Oracle 10g, when Oracle introduced the Automatic Workload Repository (AWR) and Active Session History (ASH) as replacements for the aging STATSPACK framework. Before AWR, DBAs relied on manually scheduled STATSPACK snapshots or timed operating-system-level captures using tools like \`vmstat\`, \`iostat\`, and \`sar\`. STATSPACK was valuable but required manual setup, produced no automated analysis, and its sampling granularity was limited to the interval between snapshots — typically 30 or 60 minutes. Finding out exactly what happened at 2:17 AM was genuinely difficult.

The introduction of ASH changed the field by making one-second session sampling practical. Rather than waiting for a snapshot interval to conclude, Oracle's MMNL background process continuously samples every non-idle session from the \`V\$SESSION\` view once per second, storing these samples in an in-memory circular buffer within the SGA. This means a DBA can ask "what was every session doing at 14:32:07?" and get a precise, per-session answer. ASH samples capture the SQL ID being executed, the wait event the session was blocked on, the blocking session if any, the module and action set by the application, and the wait class. This level of granularity transformed reactive performance diagnosis from an art relying on intuition into a data-driven process.

AWR operates at a higher level than ASH. Where ASH captures individual session states once per second, AWR aggregates cumulative database statistics — wait event totals, SQL execution statistics, segment-level I/O, operating system CPU and memory metrics — into periodic snapshots stored persistently in the SYSAUX tablespace. Each AWR snapshot is a delta against the previous snapshot for counters, plus point-in-time values for gauges like SGA component sizes. AWR snapshots are taken by the MMON background process every 60 minutes by default, with a default retention of 8 days (11520 minutes). Because AWR data persists across instance restarts, it enables week-over-week trend analysis and post-incident investigation even when the problem occurred days ago.

AWR and ASH together form the data layer that powers Oracle's Automatic Database Diagnostic Monitor (ADDM). After each AWR snapshot completes, ADDM automatically analyzes the new snapshot pair and identifies the single most significant performance bottleneck during the interval — whether that is a CPU-bound workload, an I/O throughput constraint, a specific SQL statement consuming excessive resources, or a PGA memory over-allocation causing excessive disk sorts. The combination of one-second ASH granularity for real-time investigation, AWR's multi-day historical depth for trending, and ADDM's automated bottleneck analysis gives Oracle DBAs a diagnostics framework with no close equivalent in other relational database platforms.

---

## AWR: Architecture and Snapshot Mechanics

AWR is driven by two background processes: MMON (Manageability Monitor) and MMNL (Manageability Monitor Light). MMON wakes approximately every 60 minutes (controlled by the \`DBMS_WORKLOAD_REPOSITORY\` configuration), flushes accumulated statistics from memory to the SYSAUX tablespace, and triggers ADDM analysis. MMNL is a lighter process that runs continuously, flushing ASH samples from the in-memory buffer to disk before the buffer fills, and collecting lighter-weight metrics that MMON does not handle.

AWR snapshots capture a comprehensive set of statistics. Wait event totals and average waits are stored in \`WRH\$_SYSTEM_EVENT\`. SQL execution statistics — elapsed time, CPU time, buffer gets, disk reads, executions, rows processed, parse calls — are stored in \`WRH\$_SQLSTAT\`. Segment-level statistics (logical reads, physical reads, row lock waits, ITL waits per segment) are in \`WRH\$_SEG_STAT\`. The time model, which partitions DB time into SQL execution, PL/SQL execution, hard parsing, connection management, and other categories, is stored in \`WRH\$_SYS_TIME_MODEL\`. Operating system statistics (CPU utilization, run queue depth, physical memory, I/O throughput) are captured in \`WRH\$_OSSTAT\`. Together these tables, all prefixed with \`WRH\$_\`, are the raw storage layer that the \`DBA_HIST_*\` views expose to DBAs.

The distinction between \`DBA_HIST_*\` views and \`V\$\` dynamic performance views is fundamental to Oracle performance work. \`V\$\` views (sometimes called dynamic performance views) reflect the current state of the running instance — they are constructed from memory structures and are reset when the instance restarts. \`V\$SYSTEM_EVENT\` shows cumulative wait totals since the last instance startup. \`V\$SQLSTATS\` shows statistics for SQL still in the shared pool. \`DBA_HIST_*\` views, by contrast, query the persistent AWR tables in SYSAUX and reflect historical data across snapshot intervals. A DBA investigating yesterday's incident uses \`DBA_HIST_SYSTEM_EVENT\` joined to \`DBA_HIST_SNAPSHOT\` to filter to the problem period; a DBA watching an active slowdown in real time queries \`V\$ACTIVE_SESSION_HISTORY\` and \`V\$SESSION\`.

AWR baselines allow a reference period to be preserved beyond the normal retention window and compared against current or future periods. Oracle supports two baseline types: fixed baselines, which capture a specific snapshot range (such as a known-good Monday-morning period before a code deployment), and moving window baselines, which dynamically track the last N days of AWR data. Baselines are used in AWR diff reports (\`@\$ORACLE_HOME/rdbms/admin/awrddrpt.sql\`) to compare the top SQL, wait events, and system load between two periods. When a deployment causes performance degradation, a pre-deployment fixed baseline provides an objective before/after comparison that is far more useful than informal recollection.

---

## ASH: Active Session History Sampling

ASH samples every active, non-idle session in the database once per second. A session is considered active if it is on CPU or waiting for a non-idle wait event — sessions waiting in SQL*Net message from client (idle) are excluded, which means the ASH sample set reflects genuine database work, not sleeping application connection-pool threads.

The primary storage for ASH samples is the \`V\$ACTIVE_SESSION_HISTORY\` view, which reads from a circular buffer in the SGA. This buffer is typically sized to hold approximately 30 minutes of samples, though the actual capacity depends on the number of active sessions and SGA memory available. The buffer is pre-allocated at instance startup. When the buffer approaches 2/3 capacity, MMNL flushes accumulated samples to the \`WRH\$_ACTIVE_SESSION_HISTORY\` AWR table in SYSAUX, which is exposed through the \`DBA_HIST_ACTIVE_SESS_HISTORY\` view. MMNL also flushes every 10 seconds during normal operation to prevent the buffer from stalling under very high session counts.

The critical detail about persistent ASH data is the 1-in-10 sampling ratio. Not every in-memory ASH sample is written to \`WRH\$_ACTIVE_SESSION_HISTORY\` — only approximately 1 in every 10 samples survives to disk. This is a deliberate space-saving measure. The 1-in-10 ratio means that a \`count(*)\` against \`DBA_HIST_ACTIVE_SESS_HISTORY\` must be multiplied by 10 to estimate actual active session-seconds, a convention you will see in many production ASH analysis queries. For real-time investigation of the last 30 minutes, always use \`V\$ACTIVE_SESSION_HISTORY\` (full sampling); for historical analysis of periods older than the SGA buffer retains, use \`DBA_HIST_ACTIVE_SESS_HISTORY\` with the 10x multiplier.

Each ASH row captures a rich set of attributes about the sampled session. The most important columns are: \`SQL_ID\` (the SQL being executed when sampled), \`EVENT\` (the specific wait event if the session is waiting), \`WAIT_CLASS\` (the wait class of the event), \`SESSION_STATE\` (either 'ON CPU' or 'WAITING'), \`BLOCKING_SESSION\` and \`BLOCKING_SESSION_SERIAL#\` (the session holding a lock that this session is waiting for), \`MODULE\` and \`ACTION\` (application context set via \`DBMS_APPLICATION_INFO\`), \`PROGRAM\` (the client program name), \`MACHINE\` (the client hostname), \`SQL_PLAN_HASH_VALUE\` (enabling correlation of session waits to specific execution plans), and \`CURRENT_OBJ#\` (the object being accessed). This combination allows reconstruction of exactly what each session was doing, which SQL it was running, what it was waiting for, and who was blocking it.

---

## Reading Wait Events and Wait Classes

Oracle's wait event model is the primary mechanism for diagnosing where database time is being spent. Every time a session must wait for a resource — an I/O call to complete, a lock to be released, a latch to be acquired — Oracle records the wait event name, the total time spent waiting, and the number of times the wait occurred. There are currently over 1,000 distinct wait events in Oracle 19c, grouped into 12 wait classes: User I/O, System I/O, Concurrency, Application, Commit, Network, Configuration, Administrative, Scheduler, Queueing, Other, and Idle.

The first section to read in any AWR report is Top 5 Timed Foreground Events, which shows the five wait events (including CPU) that consumed the most DB time during the snapshot interval. DB time is the aggregate time spent by foreground sessions — it is the fundamental measure of database workload. If a single wait event accounts for 60% of DB time, that event is the bottleneck to address. Understanding which wait class that event belongs to determines the diagnostic direction.

The distinction between CPU time and wait time is important but often misunderstood. In the AWR Top Events section, "CPU time" represents time sessions were actively executing on a CPU core — not waiting for I/O or locks, but genuinely computing. High CPU time relative to DB time means the workload is CPU-bound: the bottleneck is either the CPU itself (in which case you need more cores or faster cores) or SQL that performs too much logical I/O (which can be fixed with indexes or query rewriting). High wait time with low CPU time means sessions are blocked waiting for something external — I/O, locks, latches, or network.

The most common wait events in production Oracle environments and what they indicate are: \`db file sequential read\` — a single-block random I/O read from a datafile, the normal signature of an index range scan or table access by rowid. High average wait times (above 5-10ms) indicate slow storage. \`db file scattered read\` — a multi-block I/O read from a datafile, the signature of a full table scan or fast full index scan. Frequent occurrence indicates missing indexes or poor index selectivity. \`log file sync\` — the time a committing session waits for LGWR to write the redo log buffer to disk and acknowledge the commit. Values above 5ms indicate redo log I/O latency, possibly from a slow disk or from redo logs stored on a busy filesystem. \`enq: TX - row lock contention\` — a session is waiting for another session to release a row lock. This is an application design issue: long-running transactions holding locks on rows that other sessions need. \`latch: cache buffers chains\` — multiple sessions are contending for the same latch protecting the buffer cache hash chain for a specific block, a symptom of a "hot block" (a very frequently accessed data block such as a sequence header or the root block of a high-traffic index).

Distinguishing CPU-bound from I/O-bound or lock-bound workloads requires reading the DB time composition. On a CPU-bound system, CPU time will be the top item in Top 5 Events and the CPU utilization reported in the OS section will be at or near 100%. On an I/O-bound system, User I/O wait class events will dominate and CPU will be relatively low. On a lock-bound system, Application or Concurrency class events will dominate — look for \`enq:\` events, \`latch:\` events, and \`buffer busy waits\`.

---

## SQL-Level Diagnosis with AWR

After identifying the dominant wait class, the next step is identifying the SQL statements responsible. AWR captures per-SQL statistics for every SQL statement that executes during a snapshot interval, stored in \`DBA_HIST_SQLSTAT\`. The most important columns for SQL triage are: \`ELAPSED_TIME_DELTA\` (total elapsed time for all executions during the interval), \`CPU_TIME_DELTA\` (CPU component of elapsed time), \`EXECUTIONS_DELTA\` (number of executions), \`BUFFER_GETS_DELTA\` (logical I/O), \`DISK_READS_DELTA\` (physical I/O), and \`ROWS_PROCESSED_DELTA\` (rows returned). All delta columns represent the incremental change during the snapshot interval, not cumulative totals.

The standard pattern for computing per-execution averages is \`ELAPSED_TIME_DELTA / NULLIF(EXECUTIONS_DELTA, 0)\`, which avoids division-by-zero for SQL that appears in the AWR history from a prior interval's carryover with zero new executions. Per-execution average elapsed time is often more diagnostic than total elapsed time: a SQL with 1,000ms total elapsed time that ran 1,000 times (1ms average) is probably not a problem, while a SQL with 900ms total that ran once (900ms average) may be critical.

The \`FORCE_MATCHING_SIGNATURE\` column in \`DBA_HIST_SQLSTAT\` is invaluable for identifying SQL that should use bind variables but does not. Oracle computes this signature by normalizing literal values in SQL text, so two statements that differ only in literal values will share the same \`FORCE_MATCHING_SIGNATURE\`. Grouping \`DBA_HIST_SQLSTAT\` by \`FORCE_MATCHING_SIGNATURE\` with \`count(DISTINCT sql_id) > 1\` reveals cursor proliferation: applications generating thousands of unique SQL IDs for what is logically a single parameterized statement. Cursor proliferation causes shared pool pressure, high hard parse rates, and mutex contention.

Plan stability analysis uses \`DBA_HIST_SQL_PLAN\` to track the execution plan (identified by \`PLAN_HASH_VALUE\`) used for a given \`SQL_ID\` across snapshot intervals. A SQL regression — a query that suddenly becomes slow after a statistics refresh or an index addition — typically manifests as a change in \`PLAN_HASH_VALUE\` in \`DBA_HIST_SQLSTAT\`. Joining \`DBA_HIST_SQLSTAT\` and grouping by \`SQL_ID, PLAN_HASH_VALUE\` with per-execution averages across the snap range will show multiple rows for the same \`SQL_ID\` when a plan change occurred, with different performance characteristics for each plan. The full SQL text for any \`SQL_ID\` is available in \`DBA_HIST_SQLTEXT\`, though very long SQL statements may be truncated in the base table — full text capture requires \`CLOB_STATISTICS_LEVEL=TYPICAL\` (the default).

---

## ADDM: Automated Diagnosis

The Automatic Database Diagnostic Monitor runs automatically after every AWR snapshot pair completes. ADDM analyzes the delta between the two most recent snapshots and produces a structured finding report identifying the highest-impact performance issue during that interval. ADDM findings are stored in \`DBA_ADVISOR_FINDINGS\` and can also be retrieved programmatically via \`DBMS_ADDM\`.

An ADDM finding has a type (PROBLEM, SYMPTOM, ERROR, or INFORMATION), a short finding message, a quantified impact expressed as a percentage of DB time, and one or more recommendations with associated benefit estimates. Typical ADDM findings include: "SQL statements consuming significant database time" (with the specific SQL IDs listed), "Top SQL statements using excessive I/O" (pointing to SQL with high disk reads), "CPU was a bottleneck" (when CPU time exceeds a threshold percentage of DB time), "Hard parse due to high version count" (pointing at cursor proliferation), and "PGA memory was over-allocated" (when aggregate PGA exceeds \`PGA_AGGREGATE_LIMIT\`).

To run ADDM manually for a specific snapshot range, call \`DBMS_ADDM.ANALYZE_DB(:task_name, start_snap_id, end_snap_id)\`. This creates an advisor task visible in \`DBA_ADVISOR_TASKS\` and populates \`DBA_ADVISOR_FINDINGS\` with the results. The classic interactive path is to run \`@\$ORACLE_HOME/rdbms/admin/addmrpt.sql\` from SQL*Plus, which prompts for the snapshot range and produces a formatted text report.

ADDM has meaningful limitations. It operates at the instance level using aggregate statistics — it cannot isolate the performance experience of a specific user session, a specific application tier, or a specific transaction. ADDM also analyzes a complete snapshot interval as a unit; if a performance spike lasted only 3 minutes within a 60-minute AWR interval, ADDM will see the averaged statistics and may not identify the spike at all. For short-duration incidents, real-time ASH analysis using \`V\$ACTIVE_SESSION_HISTORY\` is more appropriate than ADDM. ADDM is most useful for sustained, repeating performance patterns that span multiple snapshot intervals.

---

## ASH Analytics for Blocking and Contention

Blocking session analysis is one of ASH's highest-value use cases. When session A is blocked waiting for session B to release a lock, ASH captures this in the \`BLOCKING_SESSION\` and \`BLOCKING_SESSION_SERIAL#\` columns of the waiting session's sample row. By querying ASH for samples where \`BLOCKING_SESSION IS NOT NULL\` and joining the blocker session's own ASH rows (or \`V\$SESSION\` for current state), it is possible to reconstruct the full blocking chain: session C blocked by session B blocked by session A. This is especially useful for diagnosing "lock convoy" situations where one long-running transaction causes a cascade of blocked sessions visible across the application tier.

Time-series analysis using the \`SAMPLE_TIME\` column enables precise identification of when contention started and ended. Grouping ASH samples by \`TRUNC(SAMPLE_TIME, 'MI')\` (minute granularity) and \`WAIT_CLASS\` produces a minute-by-minute breakdown of where sessions were spending time. This query pattern frequently reveals that what appeared to be a "slow database" was actually a 4-minute window of heavy lock contention between 14:31 and 14:35 — information that completely changes the investigation direction compared to a 60-minute AWR average showing 2% lock waits.

The \`MODULE\` and \`ACTION\` columns in ASH, populated when application code calls \`DBMS_APPLICATION_INFO.SET_MODULE\` and \`SET_ACTION\`, allow correlation of database-level waits back to specific application features. Grouping ASH by \`MODULE, ACTION, EVENT\` shows which application functions are experiencing which waits. On a well-instrumented application, this can immediately answer "the checkout workflow is experiencing \`enq: TX - row lock contention\` waits during peak load" — a finding that points directly at application code rather than requiring a DBA to reverse-engineer the SQL IDs.

For current session-level wait detail beyond the single most recent ASH sample, the \`V\$SESSION_WAIT_HISTORY\` view retains the last 10 wait events for each currently connected session, including the wait event name, parameters (P1, P2, P3 which encode event-specific details like file number, block number, or lock mode), and wait time in hundredths of a second. This view is useful when investigating an individual session's recent behavior without needing to query ASH.

---

## Licensing: AWR and ASH Require Diagnostics Pack

This section warrants direct, unambiguous statement: AWR, ASH, ADDM, and the \`DBA_HIST_*\` family of views all require the Oracle Diagnostics Pack license. The Diagnostics Pack is an additional-cost option for Oracle Database Enterprise Edition. It is not included in the base Enterprise Edition license and is not available for Standard Edition 2. Using \`DBA_HIST_SQLSTAT\`, running AWR reports, or querying \`DBA_HIST_ACTIVE_SESS_HISTORY\` without a Diagnostics Pack license is an Oracle license compliance violation, regardless of whether Oracle's enforcement mechanisms would detect it.

The in-memory component of ASH — \`V\$ACTIVE_SESSION_HISTORY\` — is generally considered to be included with Oracle Database Enterprise Edition without requiring the Diagnostics Pack, because this view reads from SGA memory that Oracle always populates as part of normal database operation. However, this interpretation should be confirmed with Oracle License Management Services for any given contract, as Oracle's licensing documentation has not always been unambiguous on this point.

AWR collection is controlled by the \`STATISTICS_LEVEL\` initialization parameter. At the default value of \`TYPICAL\`, AWR collects the full set of time model, wait event, SQL statistics, and system statistics. Setting \`STATISTICS_LEVEL=ALL\` adds additional row-source execution statistics and timed OS statistics. Setting \`STATISTICS_LEVEL=BASIC\` disables AWR collection entirely, which also disables the Automatic Memory Management advisors (SGA Target advisor, PGA advisor), the Segment Advisor, and the SQL Tuning Advisor — a significant loss of self-management capability that is rarely justified except in highly constrained environments.

For Oracle Database environments without a Diagnostics Pack license, the primary alternative is STATSPACK. STATSPACK is a free, manually installed Oracle-supplied package (\`@\$ORACLE_HOME/rdbms/admin/spcreate.sql\`) that replicates much of AWR's functionality using similar snapshot-based collection. STATSPACK lacks ASH (no 1-second session sampling), ADDM, and the SQL execution detail depth of AWR, but provides reasonable workload trend data for licensing-constrained environments. Manual \`V\$\` view polling scripts (querying \`V\$SYSTEM_EVENT\`, \`V\$SQLSTATS\`, \`V\$OSSTAT\` on a scheduled basis) are another option, though they lack the delta-computation and report generation that STATSPACK provides.

---

## Summary

Oracle AWR and ASH represent a self-contained, self-managing performance diagnostics architecture built into every Oracle Database Enterprise Edition instance. The architecture is driven by two background processes: MMON, which triggers AWR snapshots every 60 minutes (configurable) and stores persistent statistics in the SYSAUX tablespace, and MMNL, which continuously flushes 1-second ASH samples from the in-memory SGA buffer to \`WRH\$_ACTIVE_SESSION_HISTORY\` every 10 seconds. The in-memory ASH buffer holds approximately 30 minutes of full-resolution session data; persistent AWR storage defaults to 8 days of snapshots. AWR baselines extend specific snapshot ranges beyond the retention window, enabling precise before/after performance comparisons across deployments and changes.

The wait event model underlying both AWR and ASH divides all database time into CPU time and named wait events grouped into 12 wait classes. Reading the Top 5 Timed Foreground Events in an AWR report identifies the dominant bottleneck type: I/O-bound workloads show User I/O class events, CPU-bound workloads show high CPU time, and lock-bound or concurrency-bound workloads show Application and Concurrency class events. ASH's one-second sampling granularity and \`BLOCKING_SESSION\` column enable precise reconstruction of lock blocking chains and contention windows down to the minute — a level of diagnostic detail that STATSPACK and traditional OS monitoring could never approach.

ADDM automates the first-pass diagnosis by analyzing each AWR snapshot pair and identifying the highest-impact bottleneck with a quantified DB time impact percentage. ADDM is most effective for sustained, recurring performance patterns spanning multiple snapshot intervals. For short-duration spikes or session-level investigation, direct ASH queries against \`V\$ACTIVE_SESSION_HISTORY\` and \`DBA_HIST_ACTIVE_SESS_HISTORY\` provide the necessary granularity. SQL-level diagnosis using \`DBA_HIST_SQLSTAT\`, \`DBA_HIST_SQLTEXT\`, and \`DBA_HIST_SQL_PLAN\` closes the loop by identifying the specific statements driving the bottleneck and detecting plan regressions.

When properly licensed, AWR and ASH together constitute the most complete picture of database performance available in any relational database platform. The combination of persistent multi-day statistics, one-second session sampling, automated bottleneck analysis, and plan history gives Oracle DBAs an evidence base for every tuning decision. Understanding the architecture — what MMON and MMNL collect, how ASH sampling works, what each AWR view contains, and what the Diagnostics Pack license enables — is the prerequisite for using these tools effectively rather than cargo-culting queries found online.`,
};

async function main() {
  console.log('Inserting Oracle AWR and ASH diagnostics post...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: { ...post },
  });
  console.log('Inserted: "' + post.title + '"');
}

main().catch(console.error);
