import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Troubleshooting Oracle GoldenGate Extract Lag: Ghost Transactions and LogMiner Contention',
  slug: 'goldengate-extract-lag-ghost-transactions-logminer',
  excerpt:
    'A deep-dive incident post-mortem on GoldenGate Integrated Extract lag exceeding 42 hours caused by a ghost transaction pinning the Recovery Checkpoint and LogMiner internal process contention. Covers the full chain of causation from a canceled parallel DDL through bloated LOGMNR dictionary tables, stale optimizer statistics, Builder-to-Preparer blocking, and the complete remediation: statistics gather, parallelism reduction, Streams Pool sizing, and an automated monitoring framework using DBMS_SCHEDULER with UTL_MAIL alerting.',
  category: 'golden-gate' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-06'),
  youtubeUrl: null,
  content: `## The 2:30 AM Page

The on-call DBA's phone goes off at 2:31 AM. The alert is from the GoldenGate monitoring system: **Extract E_PROD lag exceeds 4 hours and is climbing**. This is a critical replication pipeline feeding a downstream analytics warehouse and a disaster recovery standby. At 4 hours of lag the business is already exposed. The DBA logs in from a laptop, connects to the GoldenGate service manager, and opens GGSCI.

The first command is \`INFO EXTRACT E_PROD DETAIL\`. The output shows the extract is running — no crash, no abort — but the lag metric is now 38 hours. The **Recovery Checkpoint** timestamp is pinned at 2026-06-02 11:47:48. The **Current Checkpoint** is hours ahead of it. That gap is the lag. The extract is mining redo but cannot advance its recovery position past that point in time from four days ago.

The next command is \`SEND E_PROD, SHOWTRANS\`. The output comes back immediately:

\`\`\`
XID: 0.446.22.12492469, Items: 0, Start Time: 2026-06-02:11:47:48, Status: Running
\`\`\`

A transaction that started at 11:47 AM on June 2nd is still open, according to GoldenGate. Zero items — no DML rows — have been captured for it. It is just sitting there, open, anchoring the recovery position to a point nearly four days in the past. The DBA switches to a SQL session and queries V\$TRANSACTION directly:

\`\`\`sql
SELECT xidusn, xidslot, xidsqn, start_scn, start_time, used_ublk, status
FROM v\$transaction
WHERE xidusn = 0 AND xidslot = 446 AND xidsqn = 22;
\`\`\`

Zero rows returned. The transaction does not exist in the database. It is a ghost.

The panic is real and it is rational. GoldenGate insists a transaction is open. The database says it never existed — or more precisely, that it no longer exists. The extract is not crashed, it is not errored, it is simply frozen in time at an SCN boundary that the database has long since moved past. The DBA's first instinct — restart the extract — is the worst possible move. This post explains why, and what to do instead.

---

## How GoldenGate Integrated Extract Tracks Transactions

To understand why a ghost transaction can freeze replication for days, you need to understand how GoldenGate Integrated Extract works at the architecture level — specifically the difference between its two checkpoint types and the role of SCN in recovery positioning.

### Integrated Extract vs Classic Extract

GoldenGate offers two extract modes. **Classic Extract** reads Oracle redo log files directly, using its own log reader. **Integrated Extract** registers with the Oracle database as a downstream capture process — essentially an inbound database server that receives a pre-filtered redo stream from the database's LogMiner infrastructure. Integrated Extract is the recommended mode for Oracle 11.2.0.4 and later because it supports internal Oracle features like compressed tables, SecureFiles LOBs, deferred primary key constraints, and automatic DDL capture that Classic Extract cannot handle.

The critical architectural consequence of Integrated Extract is that **it does not read redo files itself**. It communicates with a set of Oracle background processes — collectively the LogMiner infrastructure — through the Streams and Advanced Queuing (AQ) internal framework. The database does the redo mining; GoldenGate receives the results. This delegation gives GoldenGate access to Oracle internals but also means GoldenGate lag is directly coupled to the health of the LogMiner infrastructure running inside the database.

### The Two Checkpoints: Current vs Recovery

GoldenGate Extract maintains two distinct checkpoint positions, and understanding the difference is essential to diagnosing lag.

The **Current Checkpoint** (also called the Read Checkpoint in some GoldenGate versions) represents the position in the redo stream up to which the extract has successfully read and processed committed transactions. When you see \`INFO EXTRACT E_PROD\` and the lag is small, the Current Checkpoint is close to the current time. This checkpoint advances as GoldenGate successfully mines and writes committed transaction data to the trail file.

The **Recovery Checkpoint** is fundamentally different. It represents the **oldest SCN** from which GoldenGate must be able to restart without data loss. If the extract process crashes and restarts, it must re-read all redo from the Recovery Checkpoint forward to reconstruct its internal transaction table — the in-memory structure tracking every transaction that has started but not yet committed or rolled back. The Recovery Checkpoint is anchored to the **oldest open uncommitted transaction** that the extract has seen.

This is the mechanism behind ghost transaction lag. When Integrated Extract encountered XID 0.446.22.12492469 at 11:47 AM on June 2nd, it recorded the transaction in its internal table: a new transaction started at SCN X, and GoldenGate must track it until it COMMITs or ROLLBACKs. That is the contract. The Recovery Checkpoint moved back to SCN X. As hours and then days passed with no COMMIT or ROLLBACK observed for that XID, the Recovery Checkpoint stayed anchored at SCN X. The Current Checkpoint advanced — GoldenGate continued mining — but the recovery position could not move.

### Why the Transaction Disappeared from V\$TRANSACTION

Oracle's V\$TRANSACTION only shows **currently active** transactions. A transaction that committed, rolled back, or was killed is no longer in V\$TRANSACTION. But GoldenGate's transaction tracking is based on what it has **read from the redo stream** — not what is currently in V\$TRANSACTION.

What likely happened: the transaction represented by XID 0.446.22.12492469 was a distributed transaction, or it was a transaction associated with a session that was killed at the OS level, or it was rolled back in a way that generated a ROLLBACK redo record that GoldenGate's LogMiner stream did not deliver to the extract (because LogMiner itself was stalled, as we will see). GoldenGate saw the BEGIN of the transaction. It never saw the END. So it keeps waiting.

### Why Restarting the Extract Makes It Worse

When an extract restarts, it restores its position from the checkpoints stored in the checkpoint file (\`*.cpe\`). The restart position is the **Recovery Checkpoint** — because that is the point from which the extract can guarantee it has not missed any transaction. Restarting E_PROD at 2:31 AM would force it to re-read all redo from 2026-06-02 11:47:48 — nearly four days of redo volume. On a busy production database, that could be hundreds of gigabytes of archived redo. The extract would need hours or days to catch up, during which downstream systems remain starved of replication data.

This is why the correct response to extract lag from a pinned Recovery Checkpoint is **not to restart** but to diagnose and clear the root cause while the extract continues running.

---

## The LogMiner Internal Architecture

While the DBA was investigating the ghost transaction, a second problem was quietly making everything worse. The LogMiner background processes responsible for feeding the extract were themselves locked in contention. Understanding these processes is the key to the full diagnosis.

### The LogMiner Process Family

When an Integrated Extract registers with the database, Oracle spawns a family of background processes dedicated to that capture session. These processes are visible in V\$SESSION with program names matching the pattern \`ora_ms*\`:

**MS00 — LogMiner Builder (LMB):** The Builder is the most critical process. It reads the redo log stream from the log buffer or archive logs, parses individual redo change vectors, and constructs a coherent view of each transaction's DML operations. When it encounters a change vector referencing an object that has undergone recent DDL, it queries the LogMiner internal dictionary tables to resolve the object metadata (column names, data types, supplemental log column mappings). The Builder runs a continuous loop of redo parsing interspersed with dictionary lookups.

**MS01 — LogMiner Preparer (LMP):** The Preparer takes the parsed change records from the Builder and prepares them for delivery to the GoldenGate extract. It handles the transformation from internal redo change format to the LCR (Logical Change Record) format that GoldenGate consumes. The Preparer depends on the Builder completing its dictionary resolution before it can proceed with each change.

**MS02 through MS09 — LogMiner Readers (LMR):** The Reader processes handle the physical I/O of fetching redo data from log files and the log buffer. When multiple Reader processes exist, they work in parallel to feed the Builder. The number of Reader processes corresponds to the \`PARALLELISM\` parameter in the extract's parameter file.

The flow is: Readers fetch redo → Builder parses and resolves → Preparer formats LCRs → GoldenGate Extract consumes. A stall at any stage propagates upstream.

### The SYSTEM.LOGMNR_* Dictionary Tables

LogMiner maintains its own internal dictionary — separate from DBA_OBJECTS and DBA_COLUMNS — in a set of tables owned by SYSTEM and SYS. These tables exist because LogMiner must be able to resolve redo records that were generated by historical DDL operations, even when the current data dictionary no longer matches. The most relevant tables are:

**SYSTEM.LOGMNRT_MDDL\$** — stores metadata about DDL operations captured in the redo stream, including partial DDL records, pending DDL changes, and supplemental log column mappings. This table is queried intensively when LogMiner encounters SCN ranges that involve DDL changes.

**SYSTEM.LOGMNR_INDPART\$** — stores index partition metadata used by LogMiner to resolve the physical structure of partitioned indexes when reconstructing DML on partitioned tables. When a DROP PARTITION or EXCHANGE PARTITION DDL has been executed, this table is updated to reflect the new partition structure.

**SYS.LOGMNR_OBJ\$, SYS.LOGMNR_COL\$, SYS.LOGMNR_TAB\$** — object, column, and table metadata snapshots used by LogMiner to reconstruct row images from redo for objects that may have changed definition since the redo was written.

The Builder queries these tables constantly during redo mining — for every SCN range that involves DDL changes, for every supplemental log column mapping lookup, for every partition structure resolution. The optimizer's plan quality for these queries directly determines whether the Builder runs efficiently or grinds to a halt.

### The enq: MN — Contention Wait Event

The wait event \`enq: MN - contention\` is a LogMiner management lock. It serializes access to the internal LogMiner metadata tables during update operations. When the Builder needs to update LOGMNRT_MDDL\$ — for example, to record a newly encountered DDL in the redo stream — it acquires the MN enqueue in exclusive mode. While the Builder holds the MN enqueue, the Preparer blocks if it needs to access the same metadata structures.

This is a design serialization point. Under normal conditions, the MN enqueue is held briefly for metadata updates and released quickly. The contention only becomes pathological when the Builder is itself blocked — in \`db file scattered read\` for example — while holding the MN enqueue. At that point, the Preparer and any other LogMiner processes needing the lock queue behind the Builder indefinitely.

---

## The Root Cause: DDL Cancellation and Dictionary Table Fragmentation

The DBAs ran the LogMiner session analysis query and found a devastating picture. MS00 (Builder) had been ACTIVE for 18.2 hours, waiting on \`db file scattered read\`. MS01 (Preparer) was ACTIVE, waiting on \`enq: MN - contention\`, blocked by the Builder. The Builder was executing an internal PL/SQL block — queries against SYSTEM.LOGMNRT_MDDL\$ and SYSTEM.LOGMNR_INDPART\$.

\`\`\`sql
SELECT s.sid, s.serial#, s.program, s.event, s.status,
       s.last_call_et, ROUND(s.last_call_et/60,2) AS minutes_running,
       s.blocking_session, s.sql_id, q.sql_text
FROM v\$session s LEFT JOIN v\$sql q ON s.sql_id = q.sql_id
WHERE s.program LIKE '%(MS%' AND s.status = 'ACTIVE' AND s.last_call_et > 900
ORDER BY s.last_call_et DESC;
\`\`\`

The query output was unambiguous: the Builder had been blocked for over 1,000 minutes. The explanation required reconstructing what had happened to these tables in the days before the incident.

### The Canceled Parallel DDL

Three days before the incident, a database developer had attempted a \`DROP PARTITION\` operation on a large partitioned table during a period of high redo activity. The operation was run with parallelism (\`PARALLEL 4\`). Part-way through execution — likely after the partition had been logically dropped but before all cleanup was complete — the operation was canceled. The session was killed. The transaction was rolled back.

Parallel DDL operations in Oracle are not atomic in the same way that DML rollbacks are. When a parallel DDL is canceled mid-execution, the rollback of the parallel work generates a large volume of undo and redo. More importantly for LogMiner, the **partial execution leaves residual state in the LogMiner internal dictionary tables**. Specifically:

- SYSTEM.LOGMNR_INDPART\$ received partial updates reflecting the dropped partition structure, then received the rollback records — but the rollback process left the table with a higher high-water mark and fragmented block allocation.
- SYSTEM.LOGMNRT_MDDL\$ received records describing the DDL attempt — records that were never fully reconciled because the DDL did not complete normally.

### Why Stale Statistics Are Uniquely Dangerous on LOGMNR\* Tables

After the canceled DDL and its rollback, the LOGMNR_INDPART\$ and LOGMNRT_MDDL\$ tables were in a fragmented state: high block count relative to actual row count, stale rows from the partial DDL scattered through the table. The Oracle statistics on these tables had last been gathered during the previous \`DBMS_STATS.GATHER_DICTIONARY_STATS\` run — before the DDL incident.

The statistics showed NUM_ROWS and BLOCKS values that no longer matched reality. The CBO computed selectivity estimates for the Builder's internal queries based on old row counts. With stale statistics, the optimizer chose **full table scans** on LOGMNRT_MDDL\$ and LOGMNR_INDPART\$ — tables that now had far more blocks than rows because of fragmentation. The Builder ran \`db file scattered read\` for hours, multi-block reading through fragmented extents looking for rows that satisfied its predicates.

### The Complete Chain of Causation

The full causal chain connecting the canceled DDL to the 42-hour replication lag:

1. **Parallel DDL canceled** during high redo activity → partial rollback leaves LOGMNR_INDPART\$ and LOGMNRT_MDDL\$ fragmented and bloated above their high-water marks.
2. **Stale statistics** on LOGMNR\* tables → the CBO has no current picture of cardinality or block density after fragmentation.
3. **Bad optimizer plans** for the Builder's internal metadata queries → full table scans on fragmented tables → \`db file scattered read\` for hours.
4. **Builder stalls** while holding the MN enqueue → \`enq: MN - contention\` → Preparer cannot access LogMiner metadata → LCR delivery to GoldenGate halts.
5. **LogMiner redo stream delivery halts** → GoldenGate Extract stops receiving new committed transactions → Current Checkpoint stops advancing.
6. **Ghost transaction from the period of LogMiner stall** anchors the Recovery Checkpoint → **Extract lag grows** proportionally to the duration of the stall.

Every link in this chain was necessary. Removing any one of them — keeping dictionary statistics current, catching the DDL cancellation earlier, having monitoring on the LogMiner processes — would have broken the chain.

---

## The Remediation

The remediation requires two parallel tracks: clearing the LogMiner contention (so the extract can mine redo again) and addressing the memory configuration (so the contention does not recur at the next DDL event). The steps must be executed in order.

### Step 1: Stop the Extract

Before gathering statistics, the extract must be stopped. This is counterintuitive — the instinct is to leave the extract running so it can catch up. But there is a critical reason to stop it first: if statistics are gathered on the LOGMNR\* tables while the Builder is actively running queries against them, the Builder's in-flight queries are using the old plans. Oracle's cursor invalidation from \`no_invalidate => FALSE\` during stats gather will force hard parses on the next execution, but the Builder's current long-running SQL will not be interrupted. Worse, gathering statistics while the Builder holds the MN enqueue can cause the statistics gather itself to block. The correct sequence is: stop extract, gather statistics, restart extract.

\`\`\`ggsci
-- In GGSCI on the GoldenGate service host
STOP EXTRACT E_PROD
INFO EXTRACT E_PROD
-- Confirm status shows STOPPED before proceeding
\`\`\`

### Step 2: Gather Dictionary and LogMiner Statistics

The two-phase statistics gather covers both the standard Oracle dictionary objects and the LogMiner-specific tables that \`GATHER_DICTIONARY_STATS\` may not cover comprehensively:

\`\`\`sql
-- Phase 1: Standard dictionary statistics
-- This covers SYS and SYSTEM objects broadly but may miss some LogMiner tables
BEGIN
  DBMS_STATS.GATHER_DICTIONARY_STATS(
    degree       => 4,
    no_invalidate => FALSE
  );
END;
/

-- Phase 2: Targeted statistics on all LogMiner tables
-- GATHER_DICTIONARY_STATS can miss newly fragmented LOGMN* tables;
-- the targeted gather ensures complete coverage
DECLARE
  CURSOR c_logmnr_tabs IS
    SELECT owner, table_name
    FROM dba_tables
    WHERE table_name LIKE 'LOGMN%'
      AND owner IN ('SYS', 'SYSTEM')
    ORDER BY owner, table_name;
BEGIN
  FOR r IN c_logmnr_tabs LOOP
    DBMS_OUTPUT.PUT_LINE('Gathering: ' || r.owner || '.' || r.table_name);
    DBMS_STATS.GATHER_TABLE_STATS(
      ownname          => r.owner,
      tabname          => r.table_name,
      estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,
      cascade          => TRUE,
      degree           => 4,
      no_invalidate    => FALSE,
      method_opt       => 'FOR ALL COLUMNS SIZE AUTO'
    );
  END LOOP;
  DBMS_OUTPUT.PUT_LINE('LogMiner statistics gather complete.');
END;
/

-- Verify that statistics were refreshed (LAST_ANALYZED should be current)
SELECT owner, table_name, num_rows, blocks, last_analyzed, stale_stats
FROM dba_tab_statistics
WHERE table_name LIKE 'LOGMN%'
  AND owner IN ('SYS', 'SYSTEM')
ORDER BY owner, table_name;
\`\`\`

The \`no_invalidate => FALSE\` parameter is critical. It forces immediate invalidation of all cursors that reference the gathered tables. Without it, Oracle uses a randomized delay to spread out cursor invalidations, which means the Builder might continue using the bad plan for minutes or hours after the gather completes.

### Step 3: Flush the Shared Pool (Optional but Recommended)

Even with \`no_invalidate => FALSE\`, specific cursors that are deeply embedded in the PL/SQL call stack may not be immediately invalidated. Flushing the shared pool forces plan invalidation for all cached cursors. This is disruptive to other database activity — every subsequent query must hard-parse — so it should be done during a low-activity window:

\`\`\`sql
-- Caution: disruptive to all database activity — use during low-activity window
ALTER SYSTEM FLUSH SHARED_POOL;

-- Alternative: purge only the specific SQL cursors used by the Builder
-- Requires knowing the sql_id of the offending queries:
-- EXECUTE DBMS_SHARED_POOL.PURGE(':sql_id', 'C');
\`\`\`

### Step 4: Reduce Extract Parallelism (Immediate Workaround)

While the statistics gather addresses the root cause, reducing LogMiner parallelism from 4 to 1 provides immediate relief. With fewer MS processes running concurrently, there is less competition for the Streams Pool memory and fewer concurrent opportunities for MN enqueue contention. Edit the extract parameter file:

\`\`\`ggsci
-- Check current parameters
VIEW PARAMS E_PROD

-- Edit the parameter file to reduce parallelism
EDIT PARAMS E_PROD
\`\`\`

In the parameter file, find or add:

\`\`\`
-- Change:
TRANLOGOPTIONS INTEGRATEDPARAMS (parallelism 4)
-- To:
TRANLOGOPTIONS INTEGRATEDPARAMS (parallelism 1)
\`\`\`

### Step 5: Set Static Streams Pool Size

The permanent fix for Streams Pool exhaustion is to allocate static memory rather than relying on Automatic Memory Management. The Streams Pool is used by LogMiner to buffer the LCR stream between the Builder and the GoldenGate extract. When the Streams Pool is too small, Oracle's AMM (Automatic Memory Management) may not expand it fast enough under burst conditions, causing LogMiner to stall waiting for buffer space.

The sizing formula:

\`\`\`
streams_pool_size = (parallelism × 2 GB) + 25% buffer
\`\`\`

For parallelism 4: \`4 × 2 GB = 8 GB + 2 GB buffer = 10 GB\`. For parallelism 1 (the immediate workaround): \`1 × 2 GB = 2 GB + 0.5 GB buffer = 2.5 GB\`. Set the production target for when parallelism is restored to 4:

\`\`\`sql
-- Set static Streams Pool size
-- This prevents AMM from shrinking the pool during memory pressure
ALTER SYSTEM SET streams_pool_size = 12G SCOPE=BOTH;

-- Verify the parameter was applied
SELECT name, value, description
FROM v\$parameter
WHERE name = 'streams_pool_size';

-- Verify actual SGA allocation
SELECT component, current_size / 1048576 AS current_mb,
       min_size / 1048576 AS min_mb,
       max_size / 1048576 AS max_mb
FROM v\$sga_dynamic_components
WHERE component = 'streams pool';
\`\`\`

**Important note on STREAMS_POOL_SIZE=0:** The default value of 0 means Oracle manages the Streams Pool size automatically within the constraints of SGA_TARGET and SGA_MAX_SIZE. Under AMM, the Streams Pool can be sized as small as a few hundred megabytes if Oracle's memory pressure algorithm decides other components (buffer cache, shared pool) need the space more. For GoldenGate Integrated Extract, this is dangerous. A Streams Pool that is too small causes LogMiner to stall, which causes extract lag, which causes downstream replication gaps. Always set a static \`STREAMS_POOL_SIZE\` on any database running Integrated Extract.

### Step 6: Restart the Extract and Monitor Catchup

\`\`\`ggsci
START EXTRACT E_PROD
INFO EXTRACT E_PROD DETAIL
\`\`\`

Watch the output: the Recovery Checkpoint should begin advancing within a few minutes of restart. If the Recovery Checkpoint remains pinned after 10 minutes, the statistics gather did not resolve the Builder contention — run the LogMiner session monitoring query again to confirm the Builder is no longer blocked.

After a successful stats gather and restart with parallelism 1, the extract should catch up at a rate of several hours of lag per hour of real time (depending on redo volume). Full catchup from 42 hours of lag with a moderately busy database typically takes 2–4 hours. Once the Recovery Checkpoint matches the Current Checkpoint, restore parallelism to 4 for full throughput.

---

## Prevention and Monitoring

### The Core LogMiner Health Query

This query is the single most important tool for detecting LogMiner contention before it becomes catastrophic. It should be run every 5 minutes by a scheduled monitoring job:

\`\`\`sql
SELECT s.sid,
       s.serial#,
       s.program,
       s.event,
       s.status,
       s.last_call_et,
       ROUND(s.last_call_et/60,2) AS minutes_running,
       s.blocking_session,
       s.sql_id,
       q.sql_text
FROM v\$session s LEFT JOIN v\$sql q ON s.sql_id = q.sql_id
WHERE s.program LIKE '%(MS%' AND s.status = 'ACTIVE' AND s.last_call_et > 900
ORDER BY s.last_call_et DESC;
\`\`\`

### Alert Threshold Matrix

| \`minutes_running\` | Wait Event | Alert Level | Action |
|---|---|---|---|
| > 15 | Any | Advisory | Monitor; check if dictionary stats are fresh |
| > 30 | Any | **Warning** | Gather dictionary stats proactively; check for pending DDL |
| > 60 | \`db file scattered read\` | **Warning** | Gather targeted LOGMNR\* stats immediately |
| > 120 | Any | **Critical** | Gather stats, reduce parallelism, alert on-call DBA |
| Any | \`enq: MN - contention\` | **Critical** | Check Streams Pool size; Builder is blocked; extract lag growing |

### Detecting Historical Contention via ASH

Use Active Session History to find past occurrences of LogMiner contention. This is invaluable for post-incident analysis and for proving that the problem predates the alert threshold:

\`\`\`sql
-- Find all historical enq:MN contention events for LogMiner processes
SELECT sample_time,
       session_id,
       session_serial#,
       program,
       event,
       wait_class,
       blocking_session,
       sql_id,
       ROUND(COUNT(*) * 10 / 60, 1) AS approx_minutes_in_state
FROM dba_hist_active_sess_history
WHERE program LIKE '%(MS%'
  AND (event LIKE 'enq: MN%' OR event LIKE 'db file scattered read%')
  AND sample_time > SYSDATE - 14
GROUP BY sample_time, session_id, session_serial#, program,
         event, wait_class, blocking_session, sql_id
ORDER BY sample_time DESC
FETCH FIRST 100 ROWS ONLY;
\`\`\`

### Checking LogMiner Dictionary Statistics Age

This query provides immediate visibility into whether LOGMNR\* table statistics are current. Run it as part of any GoldenGate health check:

\`\`\`sql
SELECT owner,
       table_name,
       num_rows,
       blocks,
       TO_CHAR(last_analyzed, 'YYYY-MM-DD HH24:MI') AS last_analyzed,
       stale_stats,
       ROUND(SYSDATE - last_analyzed, 1) AS days_since_analyzed
FROM dba_tab_statistics
WHERE table_name LIKE 'LOGMN%'
  AND owner IN ('SYS', 'SYSTEM')
ORDER BY owner, table_name;
-- Flag any table with days_since_analyzed > 7
-- Flag any table with stale_stats = 'YES'
\`\`\`

### GGSCI Commands for Lag Diagnosis

\`\`\`ggsci
-- Check all extracts for lag summary
INFO EXTRACT * DETAIL

-- Check specific extract lag and checkpoint details
INFO EXTRACT E_PROD DETAIL

-- Show all open transactions tracked by the extract
SEND EXTRACT E_PROD, SHOWTRANS

-- Show top N longest-running open transactions
SEND EXTRACT E_PROD, SHOWTRANS COUNT 10
\`\`\`

### Automating the Monitoring Job

The companion runbook to this post provides the full DBMS_SCHEDULER implementation. The skeleton:

\`\`\`sql
-- Create the monitoring procedure
CREATE OR REPLACE PROCEDURE check_logminer_health AS
BEGIN
  -- Run the monitoring query
  -- Insert alerts into GGS_LOGMINER_ALERT_LOG
  -- Send UTL_MAIL notifications for WARNING and CRITICAL thresholds
  NULL; -- Full implementation in the runbook
END;
/

-- Create the scheduler job running every 5 minutes
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'CHECK_LOGMINER_HEALTH_JOB',
    job_type        => 'STORED_PROCEDURE',
    job_action      => 'CHECK_LOGMINER_HEALTH',
    repeat_interval => 'FREQ=MINUTELY;INTERVAL=5',
    enabled         => TRUE,
    comments        => 'Monitor LogMiner process health for GoldenGate extract lag prevention'
  );
END;
/
\`\`\`

---

## Summary

This incident illustrates a failure mode that is almost entirely invisible until it reaches crisis proportions. Nothing in the standard GoldenGate monitoring dashboards flagged the LogMiner internal process contention. The extract was running, not errored. The lag metric was growing, but slowly at first — the kind of drift that operators explain away as normal variation until it crosses into emergency territory.

**Ghost transactions — where GoldenGate's SHOWTRANS shows an XID that no longer exists in V\$TRANSACTION — are a symptom, not a root cause.** They occur when the LogMiner infrastructure stops delivering the COMMIT or ROLLBACK redo record for a transaction to the extract. The extract saw the BEGIN. It never saw the END. The Recovery Checkpoint cannot advance past the BEGIN SCN until the END is delivered. When LogMiner stalls — for any reason — every open transaction tracked by the extract becomes a potential ghost, and the oldest one pins the recovery position indefinitely.

**LogMiner contention is an underappreciated failure mode for GoldenGate.** Most GoldenGate troubleshooting documentation focuses on extract errors, trail file issues, and replicat conflicts. The LogMiner internal processes — MS00 Builder, MS01 Preparer — are rarely monitored independently. Yet they are the engine of Integrated Extract. When the Builder stalls on a bad optimizer plan against bloated internal dictionary tables, the entire replication pipeline freezes. The wait events — \`db file scattered read\` on the Builder, \`enq: MN - contention\` on the Preparer — are only visible if you know to look at Oracle sessions filtered by the \`(MS%)\` program name pattern.

**The two-part fix — dictionary statistics gather plus Streams Pool sizing — addresses different layers of the problem.** The statistics gather corrects the CBO's plan selection for the Builder's internal queries. Without it, the Builder will stall again the next time it encounters an SCN range involving the same bloated LOGMNR\* tables. The Streams Pool sizing prevents AMM from shrinking the buffer space that LogMiner needs to operate at full parallelism. Neither fix alone is sufficient: correct statistics with insufficient memory will cause intermittent stalls under load; sufficient memory with stale statistics will stall permanently at the next DDL event.

**The deeper principle is that GoldenGate health depends on Oracle dictionary health.** GoldenGate Integrated Extract is not an application running alongside the database — it is a participant in the database's internal replication framework. The LogMiner infrastructure it relies on uses Oracle's own data dictionary structures. When those structures become fragmented, bloated, or statistically stale, GoldenGate pays the price through lag and eventually through replication failure. Maintaining fresh statistics on LOGMNR\* tables, monitoring the MS process family, sizing the Streams Pool explicitly, and treating GoldenGate monitoring as part of database monitoring rather than a separate concern are the practices that prevent 2:30 AM pages from turning into 48-hour replication outages.`,
};

async function main() {
  console.log('Inserting GoldenGate Extract Lag blog post...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: {
      title: post.title,
      excerpt: post.excerpt,
      content: post.content,
      published: post.published,
      publishedAt: post.publishedAt,
      isPremium: post.isPremium,
    },
  });
  console.log(`Inserted: "${post.title}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
