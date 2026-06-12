import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Anatomy of an Instance Crash: ORA-00600 [kglLockOwnersListDelete] on Oracle 11gR2',
  slug: 'oracle-ora-00600-kgllockownerslistdelete-instance-crash-diagnosis',
  excerpt:
    'A production Oracle 11gR2 instance on AIX drops offline with ORA-00600 [kglLockOwnersListDelete]. Walk through the exact alert log timeline, decode what the kgl (Kernel Generic Library cache) prefix tells you, interpret the LibraryHandle dump showing zero locks and no cursor, distinguish a software-level memory tracking bug from physical corruption, and understand why SMON terminates the instance rather than allowing it to continue.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `Production database instance crashes are the ultimate test of a DBA's nerves. One minute everything is operating within normal parameters, and the next, your alert log is filled with automated memory dumps, ORA-00600 internal errors, and an abrupt instance termination notice.

This post walks through a real production crash on an Oracle 11gR2 database running on IBM AIX. By analyzing the alert log timeline, interpreting the LibraryHandle dump produced by the incident workbench, and understanding the internal background paths involved, we identified the root cause: a memory cleanup failure inside the library cache. Here is how the crash unfolded and what the diagnostic signature actually means.

---

## The Alert Log Timeline

When an Oracle instance crashes abruptly, the timeline in the alert log reveals the precise sequence of failures. Below is the chronological progression extracted from the diagnostic data.

| Timestamp | Event |
|-----------|-------|
| 12:10:13 | Foreground server process aborts with unhandled \`ORA-00600\` |
| 12:10:15 | SMON encounters secondary error \`ORA-00039\` and initiates system dump |
| 12:10:16 | SMON issues fatal termination command due to corrupted tracking state |
| 12:10:51 | Instance terminated by SMON (pid=66782030); all active connections dropped |

The 38-second span from first ORA-600 to full instance termination is characteristic of Oracle's internal error propagation model: a foreground process hits an assertion failure, the background monitoring layer (SMON) detects the inconsistency, and the protective shutdown follows.

---

## Decoding ORA-00600 [kglLockOwnersListDelete]

\`ORA-00600\` is Oracle's catch-all internal error code, fired when the database engine fails its own assertion checks — places in the source code where Oracle says "this condition must be true; if it isn't, the instance is in an unknown state." The first argument in brackets identifies the specific assertion site.

Here, the argument is **\`kglLockOwnersListDelete\`**. Breaking that down:

- **\`kgl\`** — Kernel Generic Library cache. This layer manages everything stored in the Shared Pool: parsed SQL cursors, execution plans, PL/SQL object metadata, Java classes, and package state. It is the heart of Oracle's parsed-statement caching mechanism.
- **\`Lock\`** — a library cache lock, which controls concurrent access to a cache object. Distinct from row-level or DML locks, library cache locks are granted when a session needs to parse, execute, or pin a cursor.
- **\`OwnersListDelete\`** — the specific operation: removing a session's entry from the ownership list of a library cache lock. This is a cleanup step that runs when a cursor is released, a session disconnects, or a cursor is aged out of the pool.

The full function name tells you that the crash occurred inside the code path responsible for deleting a session's ownership record from a library cache lock's internal linked list — and that delete operation found something unexpected.

---

## The LibraryHandle Dump

When the incident workbench captured the trace, it produced a dump of the target \`LibraryHandle\` — the in-memory data structure that represents the SQL cursor at the time of failure:

\`\`\`text
LibraryHandle: Address=7000103f5b298e0 Hash=0 LockMode=0 PinMode=0 LoadLockMode=0 Status=0
Name: Namespace=SQL AREA(00) Type=CURSOR(00)
Statistics: InvalidationCount=0 ExecutionCount=0 LoadCount=0 ActiveLocks=0 TotalLockCount=0 TotalPinCount=0
...
----- SQL Statement (None) -----
Current SQL information unavailable - no cursor.
\`\`\`

### What each field tells you

**\`Namespace=SQL AREA(00)\` and \`Type=CURSOR(00)\`**

The failure is localized to the SQL cursor namespace within the library cache — not a table definition, index, PL/SQL package, or any other object type. The shared pool manages dozens of namespace types; this one is the execution context for SQL statements.

**\`ActiveLocks=0\`, \`TotalLockCount=0\`, \`TotalPinCount=0\`**

Every lock and pin counter reads zero. This is the most diagnostic piece of the dump. The handle shows that at the time the engine tried to delete the ownership list entry, there were no active locks to delete. The list was already empty — or the pointer to the ownership record itself was stale or mislinked.

**\`Current SQL information unavailable - no cursor\`**

The handle exists as a data structure in memory, but it has no associated cursor. The foreground process was in the middle of a cleanup path for a cursor that had already been released or was in an intermediate deallocation state.

### What the combination means

The foreground process reached \`kglLockOwnersListDelete\` holding a reference to a \`LibraryHandle\` whose lock ownership list was already empty or structurally inconsistent. When the function attempted to walk the list and remove the entry, it found a pointer that did not match its expectations — a classic double-free or use-after-free scenario at the C heap level, translated into Oracle's internal memory management layer.

Oracle's response to this condition is correct by design: it is safer to crash the instance than to allow a process to continue operating with a corrupted Shared Pool state. Corrupted cursor metadata can lead to wrong execution plans being applied to wrong SQL, incorrect parse trees being reused, or memory being freed multiple times — any of which can cause data-corrupting execution.

---

## Corruption vs. Software Bug: How to Tell the Difference

The most important triage decision after an ORA-00600 crash is whether the underlying problem is physical or logical data corruption versus a software defect.

### Ruling out data corruption

There are no signs of block-level corruption in this incident:

- No \`ORA-01110\` (datafile corruption), \`ORA-01578\` (data block corruption), or \`ORA-00376\` (file read errors) in the alert log
- No \`ORA-00600 [kcbzib]\` or other buffer cache assertion failures
- No undo segment errors (\`ORA-01555\`, \`ORA-30036\`)
- The crash is entirely contained within volatile memory (Shared Pool), not persistent storage

Physical corruption leaves traces in both the alert log and in \`V\$DATABASE_BLOCK_CORRUPTION\`. None of those patterns exist here.

### The software bug fingerprint

This crash has the signature of a concurrency or memory tracking bug in Oracle's library cache management code:

1. **Zero-counter LibraryHandle**: a handle in memory with all statistics at zero and no associated cursor is not a normal operating state. It suggests the handle was in mid-deallocation when another code path attempted to reference it.

2. **kgl assertion failures are version-correlated**: Oracle's kgl layer has historically accumulated a set of known defects in specific PSU levels. Argument \`[kglLockOwnersListDelete]\` appears in Oracle's bug database and has been associated with timing-window defects where concurrent foreground sessions race to clean up the same cursor allocation.

3. **SMON involvement via ORA-00039**: Oracle error 39 ("error during periodic action") is SMON's way of reporting it encountered an error during one of its background maintenance tasks — in this case, detecting the inconsistent state left by the foreground crash and initiating a protective shutdown. SMON does not normally terminate instances; when it does, it is because the inconsistency is severe enough that continued operation would risk data integrity.

4. **No prior degradation signals**: The crash occurred without preceding waits, latch contention spikes, or ORA-04031 (out of shared memory) errors. This is consistent with a sudden assertion failure rather than a gradual resource exhaustion leading to instability.

---

## Why This Happens More Often Under Load

The timing-window class of library cache bug is harder to reproduce in low-concurrency environments and more likely to surface under conditions that Oracle 11gR2 on AIX was designed to handle but occasionally struggles with at extreme concurrency:

**High parse rate workloads**: Applications that hard-parse frequently — submitting SQL with literal values rather than bind variables — generate constant cursor allocation and deallocation in the library cache. Each parse/execute/close cycle touches the kgl lock management code path. Higher throughput = more concurrent cleanup operations = wider window for a race condition.

**Long instance uptime with gradual pool fragmentation**: Library cache memory is allocated from the Shared Pool using Oracle's internal allocator. Over hundreds of days of uptime, small allocation residue and freed-but-not-reused blocks can accumulate. While Oracle's allocator is generally robust, known edge cases exist where a handle's reference counting drifts from its actual state — which is precisely what the zero-counter dump here suggests.

**Large number of distinct SQL IDs**: Oracle 11gR2's library cache uses hash chains to find cached cursors. Applications that generate high cardinality of distinct SQL (often due to ERP systems, reporting tools, or ORMs that embed literals) can create hash chain pressure, making cleanup operations more likely to collide.

---

## Immediate Actions After the Crash

### Step 1: Verify clean instance startup

Before doing anything else, confirm that the instance came up cleanly with no residual errors:

\`\`\`sql
-- Check alert log for errors after startup
-- In sqlplus:
SELECT value FROM v\$diag_info WHERE name = 'Diag Trace';
-- Then review the alert log manually, or:

-- Check for any ORA- errors in the past hour
SELECT originating_timestamp, message_text
FROM   v\$diag_alert_ext
WHERE  originating_timestamp >= SYSTIMESTAMP - INTERVAL '1' HOUR
  AND  message_text LIKE 'ORA-%'
ORDER BY originating_timestamp;
\`\`\`

### Step 2: Package the incident with ADRCI

Before restarting or running any purge operations, preserve the full diagnostic package. Oracle Support will need this.

\`\`\`bash
adrci

# List incidents from around the crash time
adrci> show incident -mode detail -p "incident_time > 'YYYY-MM-DD HH:MI:SS'"

# Package the specific incident (replace with your incident ID)
adrci> ips pack incident 13185436 in /tmp

# This creates a zip file that includes:
# - Alert log extract
# - Trace files (foreground and SMON)
# - Core dumps if present
# - Incident package manifest
\`\`\`

### Step 3: Cross-reference with Oracle PSU patch history

\`\`\`sql
-- Check current patch level
SELECT patch_id, patch_uid, description, action_time
FROM   dba_registry_history
ORDER BY action_time DESC
FETCH FIRST 10 ROWS ONLY;

-- Check opatch inventory from OS
-- As oracle user:
-- $ORACLE_HOME/OPatch/opatch lsinventory -detail | grep -A3 "Patch description"
\`\`\`

Cross-reference the PSU version with Oracle Support's known bug list for \`kglLockOwnersListDelete\`. Oracle 11.2.0.4 has specific one-off patches addressing this argument. The companion runbook covers the full patch identification procedure.

### Step 4: Review shared pool and library cache health post-restart

\`\`\`sql
-- Library cache hit ratio (should be > 99% in a healthy shared pool)
SELECT SUM(pins) AS total_pins,
       SUM(pinhits) AS total_pinhits,
       ROUND(SUM(pinhits) / NULLIF(SUM(pins), 0) * 100, 2) AS pin_hit_ratio,
       SUM(reloads) AS total_reloads,
       SUM(invalidations) AS total_invalidations
FROM   v\$librarycache;

-- Shared pool free memory
SELECT name, bytes, bytes / 1048576 AS mb
FROM   v\$sgastat
WHERE  pool = 'shared pool'
  AND  name IN ('free memory', 'library cache', 'sql area')
ORDER BY bytes DESC;
\`\`\`

A low pin hit ratio (< 95%) or a high reload count after a fresh startup indicates the library cache did not warm up cleanly and may need investigation.

---

## Summary

### What happened

A foreground session invoked \`kglLockOwnersListDelete\` — the internal function that removes a session's ownership entry from a library cache lock's linked list. The function found the target \`LibraryHandle\` in an inconsistent state: all counters at zero, no associated cursor, and a pointer mismatch in the ownership list. Oracle's assertion check fired \`ORA-00600\`, SMON detected the corrupted state, and the instance was terminated to prevent further damage.

### What it is not

This is not physical data corruption, media failure, or a storage subsystem problem. No datafiles, control files, redo logs, or undo segments were affected. The crash is entirely within volatile memory — the Shared Pool — and is fully recoverable via restart.

### What to do

1. **Package and preserve diagnostics** with ADRCI before any purge or flush operations
2. **Apply the relevant Oracle one-off patch** for \`kglLockOwnersListDelete\` on 11.2.0.4/AIX (details from Oracle Support via SR)
3. **Review application SQL practices**: reduce hard parsing, enforce bind variable usage, and audit any application that submits high-literal-cardinality SQL
4. **Monitor uptime**: consider a scheduled rolling restart cadence for long-running instances to reset gradual shared pool fragmentation
5. **Set up proactive monitoring** for library cache reload rates and kgl-related errors in the alert log before they escalate to a crash

The companion runbook covers the complete diagnostic and remediation procedure, the shared pool health monitoring script, and the ADRCI packaging workflow.`,
};

async function main() {
  console.log('Inserting ORA-00600 kglLockOwnersListDelete blog post...');
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
