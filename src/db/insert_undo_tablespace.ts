import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Undo Tablespace: Architecture, Sizing, and ORA-01555 Prevention',
  slug: 'oracle-undo-tablespace-architecture-sizing-ora-01555',
  excerpt:
    'A deep-dive into Oracle undo segment architecture and Automatic Undo Management (AUM) — covering consistent read block construction, undo retention tuning, the three root causes of ORA-01555 "snapshot too old", and a proven sizing methodology using V$UNDOSTAT to prevent ORA-01555 in production databases.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-05'),
  youtubeUrl: null,
  content: `## Introduction

Oracle's undo mechanism is one of the foundational pillars of the database's ACID compliance — specifically the Isolation and Consistency guarantees. A relational database that cannot provide read consistency is not a database in the proper sense: without undo, a long-running query would see intermediate states of rows being modified by concurrent transactions, producing results that correspond to no consistent point in time. Oracle's solution to this problem is elegant: every modification writes a before-image of the affected data into an undo segment before applying the change, and every read that encounters a block modified after the reader's query began reconstructs the original version of that block from undo. Readers never block writers, and writers never block readers.

Undo data serves three distinct purposes in Oracle. First and most fundamentally, it enables **read consistency** — the construction of consistent read (CR) blocks that represent the state of data as of the reader's query SCN, regardless of what concurrent transactions are doing. Second, it enables **transaction rollback**: when a transaction is rolled back explicitly or an instance crashes, Oracle uses undo to restore every modified block to its pre-transaction state. Third, it supports **Flashback features** (Flashback Query, Flashback Versions Query, Flashback Transaction Query) by retaining historical row versions in the undo tablespace beyond the life of the originating transaction.

The introduction of Automatic Undo Management (AUM) in Oracle 9i replaced the manual rollback segment model — the era of creating individual \`ROLLBACK SEGMENT\` objects, sizing them explicitly, and assigning transactions to them. Under AUM, Oracle manages a pool of undo segments within a single designated UNDO tablespace automatically, allocating undo extents to transactions as needed and recycling expired undo space when fresh undo is required. This removed a significant operational burden, but it created a new class of DBA responsibility: sizing the UNDO tablespace correctly and tuning \`UNDO_RETENTION\` appropriately for the workload.

ORA-01555 "snapshot too old" is among the most misunderstood errors in Oracle. DBAs encountering it for the first time often search for a patch or a workaround, but ORA-01555 is not a bug — it is a predictable consequence of the undo tablespace being too small, \`UNDO_RETENTION\` being set too low relative to query duration, or occasionally of delayed block cleanout. The error means that a query needed to reconstruct a CR block but the undo data required to do so has been overwritten by a newer transaction. The fix is always a configuration change: more undo space, a higher retention setting, or a combination of both. This article explains the mechanism thoroughly enough that you can diagnose which cause applies and implement the correct fix.

---

## How Undo Works: The CR Mechanism

When a session modifies a row, Oracle does not modify the data block in place without preparation. Before writing the new value into the data block, Oracle first writes the **before-image** of the row — its current column values — into an undo segment block. The undo entry records the original column values, the SCN at which the change is being made, and a pointer back to the data block that is being modified. Only after the undo entry is safely written does Oracle apply the change to the data block in the buffer cache. This ordering is enforced by redo logging: both the undo write and the data block change are recorded in the redo log, guaranteeing that crash recovery can replay or reverse any change with full fidelity.

When another session issues a query, Oracle assigns it a **query SCN** — the SCN at the moment the query begins (or, for a serializable transaction, the SCN at transaction start). As the query scans data blocks, it checks the SCN recorded in each block's header against its own query SCN. If the block's SCN is lower than the query SCN — meaning the block has not been modified since the query started — the block is current and can be read directly. If the block's SCN is higher — meaning the block has been modified by a transaction that started after the query began — Oracle cannot use the current version of the block. Instead, it must reconstruct the version that existed at the query SCN.

CR block construction is the process of building a synthetic copy of the block as it existed at the query SCN. Oracle allocates a new buffer in the buffer cache, copies the current block into it, then applies undo entries in reverse chronological order — effectively "un-doing" each change that was applied after the query SCN — until it has reconstructed a version of the block whose SCN is at or below the query SCN. The result is a consistent read block: a logical snapshot of the data as of the query's point in time. The original (current) block in the buffer cache is untouched, and the CR block is a temporary construct used only by this reader.

The SCN chain makes this process efficient. Each undo entry contains a pointer to the previous undo entry for the same block, forming a linked list of changes in reverse chronological order. Oracle walks this chain, applying reversals, until it reaches the desired SCN. In a moderately active system, a typical CR block construction requires applying only a handful of undo entries. In a very active system with many concurrent modifications to the same block, the chain can be long, and CR construction contributes to I/O and CPU overhead — this is visible in the \`consistent gets\` and \`CR blocks created\` statistics in \`V$SYSSTAT\`. The critical point is this: if the undo entry needed to reconstruct a CR block has been overwritten — because the undo retention period expired and Oracle reused that space for a new transaction's undo — Oracle raises ORA-01555. The chain has been broken, and the consistent read cannot be completed.

---

## Automatic Undo Management (AUM)

AUM replaces the manual \`ROLLBACK SEGMENT\` creation model with a single UNDO tablespace managed entirely by Oracle. Under AUM, Oracle automatically creates a pool of undo segments within the designated UNDO tablespace when the instance starts. The number of undo segments scales with the number of CPUs and concurrent transactions; DBAs do not create, name, or assign rollback segments. The transition from manual to automatic management was one of the most significant operational simplifications Oracle introduced in the 9i era, but understanding the underlying model is still essential for sizing and troubleshooting.

The key initialization parameters governing AUM are \`UNDO_MANAGEMENT\` and \`UNDO_TABLESPACE\`. Since Oracle 10g, \`UNDO_MANAGEMENT = AUTO\` is the default — if you are running a production database in manual mode in 2025, it is an artifact of an old upgrade and should be corrected. \`UNDO_TABLESPACE\` specifies which tablespace Oracle uses for its undo pool. In a RAC environment, each node (instance) uses its own separate undo tablespace — you cannot share an undo tablespace between instances. The naming convention is typically \`UNDOTBS1\` on node 1, \`UNDOTBS2\` on node 2, and so on, though the names are arbitrary.

The undo retention model is the heart of AUM's space management strategy. Oracle tries to retain committed undo data for at least \`UNDO_RETENTION\` seconds (default: 900 seconds, or 15 minutes) after the transaction that generated it commits. Undo is categorised into three states in \`DBA_UNDO_EXTENTS\`: **ACTIVE** (the undo belongs to an uncommitted or partially committed transaction — it must not be overwritten under any circumstances), **UNEXPIRED** (the transaction has committed, but the undo is within the retention window — Oracle prefers not to overwrite it but will do so if the tablespace is full), and **EXPIRED** (the transaction committed and the retention window has passed — this undo is freely recyclable). When a transaction needs undo space, Oracle allocates EXPIRED extents first, then — if the undo tablespace is full and no EXPIRED extents are available — it will overwrite UNEXPIRED extents rather than raise an error. This is the scenario that leads to ORA-01555.

The \`RETENTION GUARANTEE\` option changes this behaviour fundamentally. When a tablespace is created with \`RETENTION GUARANTEE\` (or altered to add it), Oracle will never overwrite UNEXPIRED undo — not even when the tablespace is full. Instead, if the tablespace cannot accommodate new undo without overwriting unexpired data, Oracle raises ORA-30036 "unable to extend segment in undo tablespace". For most OLTP databases, \`RETENTION GUARANTEE\` is inappropriate because it allows write transactions to fail when the undo tablespace is under pressure. For databases where Flashback Query SLAs must be enforced absolutely — where the business requires that row history back to a specific point in time is always available — \`RETENTION GUARANTEE\` is the correct approach, combined with a tablespace sized generously enough that ORA-30036 does not occur in practice.

---

## ORA-01555: Snapshot Too Old — Root Causes

ORA-01555 occurs when a query attempts to construct a CR block but the undo entry needed to reconstruct the before-image has been overwritten. The error message includes the undo segment number and the wrap count — details that help identify which of the three distinct causes applies, each of which has a different resolution.

The **first cause** is the most common: the undo tablespace is too small relative to the rate of data modification during long-running queries. If the workload generates undo faster than the tablespace can accommodate, Oracle is forced to recycle unexpired undo extents before the retention period expires. A batch job that reads a large result set — running for 2 hours — while another process performs high-volume inserts, updates, or deletes will frequently encounter ORA-01555 if the undo tablespace cannot hold 2 hours of undo at the peak modification rate. The fix is to increase the undo tablespace size, either by adding a datafile or replacing the tablespace with a larger one.

The **second cause** is an \`UNDO_RETENTION\` parameter set too low. Even when the undo tablespace has ample free space, Oracle will mark undo as EXPIRED after \`UNDO_RETENTION\` seconds and begin reusing it. If the longest-running queries in the system execute for 3 hours but \`UNDO_RETENTION\` is 900 seconds (15 minutes), Oracle has license to recycle the undo those queries depend on well before they complete — even if there is gigabytes of free space in the undo tablespace. The fix is to increase \`UNDO_RETENTION\` to at least the duration of the longest expected query or batch operation. \`UNDO_RETENTION\` is a dynamic parameter that can be changed with \`ALTER SYSTEM SET undo_retention = <seconds> SCOPE = BOTH\` without a restart.

The **third cause** is delayed block cleanout. When a transaction commits, Oracle cleans out the block headers of modified blocks to record the commit SCN. However, if a transaction modified many blocks, Oracle may not visit all of them at commit time — it cleans out only a subset. The remaining blocks retain the transaction's "interested transaction list" (ITL) entry without a commit SCN. When a later reader encounters such a block, Oracle must consult the undo segment header to determine the commit SCN so it can correctly classify the block's SCN relative to the query SCN. If the undo segment has wrapped (recycled) since the transaction committed, Oracle cannot find the commit SCN and raises ORA-01555 — even if the transaction committed long before the query started. This cause is identifiable through \`V$SYSSTAT\` statistics for "cleanouts and rollbacks - consistent read gets". The standard remedy is to run a full table scan against the affected objects in a dedicated session to force block cleanout, and then the problem typically does not recur.

Identifying which cause applies in a production incident requires checking \`V$UNDOSTAT\` (look at \`SSOLDERRCNT\`, \`MAXQUERYLEN\`, and \`TUNED_UNDORETENTION\` in the interval when the error occurred), the database alert log (the ORA-01555 entry includes the undo segment number and wrap count), and \`V$TRANSACTION\` at the time of the error to identify any long-running transactions.

---

## Sizing the Undo Tablespace

The undo retention sizing formula is straightforward: **required undo size = undo blocks per second × DB block size × target retention seconds**. Each term must be measured from the production system to be meaningful; guessing any of them produces an undersized undo tablespace.

**Undo blocks per second** is the undo generation rate, measured from \`V$UNDOSTAT\`. This view contains one row per 10-minute interval, recording how many undo blocks (\`UNDOBLKS\`) were generated in that interval. The rate is \`UNDOBLKS / ((END_TIME - BEGIN_TIME in seconds))\`. Query \`V$UNDOSTAT\` over a representative busy period — a full business day, or better yet, the period that includes your peak batch workload — and use the maximum rate observed, not the average. Using the average will produce an undersized tablespace that fails during peak load.

The practical query is:

\`\`\`sql
SELECT MAX(undoblks / ((CAST(end_time AS DATE) - CAST(begin_time AS DATE)) * 86400)) AS peak_undo_blocks_per_sec
FROM v\$undostat
WHERE begin_time > SYSDATE - 7;
\`\`\`

Multiply the peak rate by the DB block size (typically 8192 bytes) and by the target retention in seconds (the duration of the longest acceptable query or batch job — not \`UNDO_RETENTION\`, but the actual workload requirement). Add 20–25% headroom. The result is the minimum undo tablespace size for your workload.

The **\`AUTOEXTEND ON\`** consideration deserves careful thought. If the undo tablespace datafiles have \`AUTOEXTEND ON\`, Oracle will extend the tablespace rather than overwrite unexpired undo when space is exhausted — which means ORA-01555 will not occur due to space pressure, but the tablespace can grow without bound if a long-running batch job or a spike in DML rate is not anticipated. In production, \`AUTOEXTEND ON\` with a realistic \`MAXSIZE\` is the right configuration: it provides a safety buffer against unexpected growth while preventing uncontrolled disk consumption. Monitor \`DBA_DATA_FILES\` for undo tablespace files approaching their \`MAXBYTES\` limit.

**\`UNDO_RETENTION\` tuning**: the parameter should be set to at least 150% of the longest expected query or batch job duration — the 50% buffer accounts for timing variance. For a reporting database where overnight batch jobs run for 4 hours, \`UNDO_RETENTION = 21600\` (6 hours) is a reasonable starting point. For Flashback Query, \`UNDO_RETENTION\` must cover the full intended flashback horizon — if you need to flash back up to 24 hours, \`UNDO_RETENTION\` must be at least 86400 seconds and the tablespace must be large enough to hold 24 hours of undo at your peak generation rate.

The \`SSOLDERRCNT\` column in \`V$UNDOSTAT\` is the most direct measure of whether the current configuration is producing ORA-01555 errors — it records the count of ORA-01555 errors per 10-minute interval. If \`SSOLDERRCNT > 0\` in any recent interval, the configuration is insufficient and action is required. \`TUNED_UNDORETENTION\` in the same view shows the retention Oracle actually achieved (which may be higher than \`UNDO_RETENTION\` if the tablespace has free space) — if \`MAXQUERYLEN\` is approaching \`TUNED_UNDORETENTION\`, the system is at risk even if no errors have occurred yet.

---

## Undo in CDB/PDB Architecture (12c+)

In the multitenant Container Database (CDB) architecture introduced in Oracle 12c, undo management changed significantly across two releases. In Oracle 12c, all PDBs share the CDB's single undo tablespace — this is **shared undo mode**. All undo generated by transactions in any PDB resides in the CDB's UNDOTBS, and ORA-01555 errors in one PDB can be caused by undo pressure from a completely different PDB running in the same CDB. Diagnosing these issues is more complex because the undo contention crosses PDB boundaries.

Oracle 18c introduced **local undo mode**, where each PDB maintains its own independent undo tablespace. This is now the strongly recommended configuration and the default for new CDBs created in 18c and later. Local undo mode provides true PDB isolation: undo pressure in one PDB cannot cause ORA-01555 in another. It also enables PDB-level point-in-time recovery (which requires local undo to reconstruct the PDB's state at the target SCN), faster PDB unplug and plug operations (the undo tablespace travels with the PDB), and clearer monitoring — each PDB's \`V$UNDOSTAT\` shows only its own undo activity.

The \`DATABASE_PROPERTIES\` view (queried from \`CDB\$ROOT\`) shows \`LOCAL_UNDO_ENABLED = TRUE\` or \`FALSE\`. Converting an existing CDB from shared undo to local undo mode requires restarting the CDB in migration mode (\`STARTUP MIGRATE\`) and running \`ALTER DATABASE LOCAL UNDO ON\`. After the restart, Oracle creates an undo tablespace in each PDB automatically, though DBAs should review the sizing of those tablespaces and add datafiles as needed. In a RAC+CDB environment, each instance of each PDB still uses a separate undo tablespace — the RAC requirement for per-instance undo is orthogonal to the PDB-level isolation that local undo provides.

---

## Flashback and Undo Retention

Flashback Query (\`AS OF SCN\` or \`AS OF TIMESTAMP\`) uses the undo tablespace to reconstruct past row versions. It is not a separate historical store — it reads from the same undo segments that support CR block construction during normal DML operations. A query like \`SELECT * FROM orders AS OF TIMESTAMP SYSDATE - 1/24\` asks Oracle to reconstruct every row in the \`orders\` table as it existed one hour ago. Oracle applies exactly the same CR block construction mechanism, using the undo chain to reverse modifications that occurred during the past hour. The undo data required for this query must still be in the UNEXPIRED state in the undo tablespace — if it has been recycled, the query fails with ORA-01555 (or a Flashback-specific variant of the error).

Flashback Versions Query (\`VERSIONS BETWEEN SCN\` or \`VERSIONS BETWEEN TIMESTAMP\`) retrieves all versions of each row that existed between two points in time. Each version corresponds to a committed transaction that modified the row. Oracle walks the undo chain for each row to reconstruct its history. The further back in time the query reaches, the more undo data it must traverse, and the more likely it is to encounter recycled undo. \`FLASHBACK_TRANSACTION_QUERY\` provides a row-level audit trail of what each transaction in the undo retention window actually did — it is useful for diagnosing accidental data changes and for constructing compensating transactions.

Flashback Database is a different mechanism entirely. It uses a dedicated **Flashback Recovery Area (FRA)** and flashback logs (not undo logs) to restore the entire database to a past state. Flashback Database can reach back as far as the flashback retention target (\`DB_FLASHBACK_RETENTION_TARGET\` parameter), which is independent of undo retention. Because Flashback Database does not rely on undo, it is not subject to ORA-01555. It is the appropriate tool when you need to wind back the entire database (for example, after an application deployment error or a logical corruption), whereas Flashback Query is the appropriate tool for examining or recovering individual rows or tables.

The relationship to keep clear: \`UNDO_RETENTION\` controls how far back Flashback Query and Flashback Versions Query can reach. \`DB_FLASHBACK_RETENTION_TARGET\` controls how far back Flashback Database can reach. The two are independent parameters using independent storage mechanisms. Setting \`UNDO_RETENTION\` to 86400 (24 hours) does not give you 24-hour Flashback Database capability — it gives you 24-hour Flashback Query capability, assuming the undo tablespace is large enough to hold 24 hours of undo at your generation rate.

---

## Monitoring Undo Health

Routine undo health monitoring centres on a small set of views that together tell the complete story of undo activity, space usage, and error occurrence.

**\`V$UNDOSTAT\`** is the primary monitoring view. It contains one row per completed 10-minute interval (plus a current in-progress row) with the following key columns: \`UNDOBLKS\` (total undo blocks generated), \`TXNCOUNT\` (transaction count), \`MAXQUERYLEN\` (longest-running query in seconds during the interval), \`MAXCONCURRENCY\` (peak concurrent transactions), \`TUNED_UNDORETENTION\` (the retention Oracle actually achieved — may exceed \`UNDO_RETENTION\` if space was available), \`SSOLDERRCNT\` (count of ORA-01555 errors), and \`NOSPACEERRCNT\` (count of failures due to undo tablespace full with \`RETENTION GUARANTEE\` enabled). Any non-zero \`SSOLDERRCNT\` value requires immediate investigation.

**\`DBA_UNDO_EXTENTS\`** shows the current state of every extent in the undo tablespace, classified as ACTIVE, UNEXPIRED, or EXPIRED. A healthy undo tablespace has a small proportion of ACTIVE extents, a comfortable buffer of UNEXPIRED extents representing recent committed transactions, and a pool of EXPIRED extents available for immediate reuse. If the EXPIRED pool is very small relative to the total tablespace size, the tablespace is under pressure and ORA-01555 risk is elevated.

**\`V$TRANSACTION\`** shows all currently active (uncommitted) transactions, including their undo segment (\`XIDUSN\`) and the number of undo blocks used (\`USED_UBLK\`). Large \`USED_UBLK\` values indicate transactions that will generate significant undo and whose undo must be retained for the duration of any concurrent long-running queries. A transaction accumulating tens of thousands of undo blocks while a batch reporting job is running is a classic setup for ORA-01555 if the undo tablespace is not sized for both.

**\`DBA_HIST_UNDOSTAT\`** is the AWR-persisted version of \`V$UNDOSTAT\`. It retains the 10-minute undo statistics for as long as the AWR retention period covers (typically 8–30 days). Use it to analyse peak undo generation rates over a week or more, to size a new undo tablespace accurately, or to identify recurring patterns in ORA-01555 occurrence — for example, errors that only occur during end-of-month batch processing.

The key diagnostic check: compare \`MAXQUERYLEN\` against \`TUNED_UNDORETENTION\` in \`V$UNDOSTAT\`. If \`MAXQUERYLEN\` is consistently above 80% of \`TUNED_UNDORETENTION\`, the system is at risk. If \`SSOLDERRCNT > 0\` in any recent interval, the risk has materialized. Cross-reference \`NOSPACEERRCNT\` — if it is zero, the undo tablespace has space available, and the problem is purely a retention setting issue; if \`NOSPACEERRCNT > 0\`, the tablespace itself is too small.

---

## Summary

Oracle's undo mechanism is the enabler of read consistency, transaction atomicity, and the Flashback feature set. The consistent read block construction process — using undo chains to reconstruct block versions at a query's SCN — is what allows Oracle to guarantee that readers see a consistent snapshot of the database regardless of concurrent write activity. Understanding this mechanism is prerequisite knowledge for diagnosing any ORA-01555 error, because the error is always a statement that the undo chain needed by a specific query has been broken.

Automatic Undo Management removed the operational complexity of manual rollback segment maintenance and replaced it with a simpler model: one UNDO tablespace per instance, sized and tuned via \`UNDO_RETENTION\` and the tablespace's physical size. The sizing formula — peak undo blocks per second from \`V$UNDOSTAT\`, multiplied by DB block size, multiplied by target retention — is straightforward to apply once you have gathered representative data from the production system. The \`SSOLDERRCNT\` column in \`V$UNDOSTAT\` is the definitive indicator of whether the current configuration is sufficient.

ORA-01555 is always a configuration problem, not a database bug. The three causes — undo tablespace too small, \`UNDO_RETENTION\` too low, and delayed block cleanout — each have distinct signatures and distinct fixes. Distinguishing between them requires checking \`V$UNDOSTAT\` for the interval in which errors occurred, the alert log for the undo segment number in the error detail, and \`V$SYSSTAT\` for cleanout statistics. Applying the right fix — more tablespace space, a higher retention parameter, or a proactive table scan to force block cleanout — eliminates the error completely rather than merely reducing its frequency.

In the multitenant architecture, local undo mode (18c+) is the correct operating model for all new deployments. It provides PDB-level isolation, enabling each PDB to be sized, monitored, and tuned independently. The \`RETENTION GUARANTEE\` option is the definitive configuration when Flashback Query SLAs must be contractually enforced — it prevents any overwrite of unexpired undo at the cost of allowing write transactions to fail if the tablespace becomes full. In practice, \`RETENTION GUARANTEE\` should be combined with a tablespace sized at 150% or more of the theoretical minimum to ensure ORA-30036 does not occur under normal load. Together, the correct tablespace size, appropriate \`UNDO_RETENTION\` setting, and optional \`RETENTION GUARANTEE\` constitute a complete undo management strategy for any Oracle production database.`,
};

async function main() {
  console.log('Inserting Oracle Undo Tablespace concept post...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: { ...post },
  });
  console.log('Inserted: "' + post.title + '"');
}

main().catch(console.error);
