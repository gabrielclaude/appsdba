import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Troubleshooting Intermittent "Material Sourcing Process Failed" Errors in Oracle EBS',
  slug: 'oracle-ebs-material-sourcing-process-failed',
  excerpt:
    'Intermittent "Material Sourcing Process Failed" errors during move order allocations or pick confirmation — where a retry immediately succeeds with no data changes — are almost never a functional setup issue. This post walks through the four investigation layers: inventory quantity tree lock timeouts and backorder caching profiles, orphan records in MTL_MATERIAL_TRANSACTIONS_TEMP left by crashed prior attempts, FND session framework anomalies including unexpected SSO validation failures, and custom interceptors or license validation hooks that throw unhandled exceptions inside the picking API call stack. Includes diagnostic SQL for each layer and a framework for isolating the true failure in high-volume production environments where the error cannot be reproduced in test.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-29'),
  youtubeUrl: null,
  content: `## Introduction

Few failure modes test a developer or Apps DBA's patience like an intermittent error that disappears on retry. In Oracle EBS Supply Chain Management, the error message "The Material Sourcing process failed to create picking suggestions for line X of move order" is one of the most reliably misleading messages in the inventory transaction stack. It is misleading not because the system is lying — material sourcing genuinely did fail — but because the word "material sourcing" implies the problem is with on-hand quantities, lot availability, or sourcing rules. In most cases of intermittent failure, none of those things are wrong.

The tell is the retry behavior. If a move order allocation or pick confirmation fails and then succeeds immediately on retry — with no data changes between the two attempts — the failure was not caused by a functional configuration deficiency. Functional deficiencies (missing sourcing rules, exhausted on-hand, expired lots) fail every time and keep failing until the data is corrected. Intermittent failures that self-resolve point to one of three categories: **concurrency** (two processes competing for the same resource), **caching** (stale in-memory state making the engine see unavailable material), or **session framework anomalies** (something in the application technology stack failing during the transaction that is unrelated to inventory logic).

This post walks through all four investigation layers in order of likelihood and diagnostic ease, from standard profile options to deep custom API hooks, with the diagnostic SQL and observation techniques for each layer.

---

## The Symptom in Detail

The error surfaces during:
- Move order allocation triggered from the Move Orders form
- Pick release executed from the Pick Release SRS or programmatically via \`INV_REPLENISH_DETAIL_PUB.REPLENISH_DETAIL\`
- Pick confirmation through the Confirm Picks form or via \`WMS_PICK_CONFIRM_PUB\`

The standard error message is:

\`\`\`
The Material Sourcing process failed to create picking suggestions for line X of move order Y.
\`\`\`

A physical check confirms everything looks correct:
- Sufficient on-hand quantity exists in the subinventory and locator
- Lots are active, not expired, not reserved by another order
- Sourcing rules are defined and active
- Picking rules are correctly configured for the organization

The retry completes without any manual intervention, data corrections, or wait period. The exact same move order line processes cleanly the second time.

This retry pattern eliminates the most common causes a DBA checks first: missing on-hand, incorrect lot status, reservation conflicts. Those are deterministic failures. What we are dealing with is a transient state that existed during the first attempt and cleared itself before the second.

---

## Layer 1: Inventory Quantity Tree Lock Timeouts

Oracle Inventory maintains an in-memory **quantity tree** structure that tracks available-to-promise (ATP) and physical on-hand quantities for each subinventory, locator, lot, and revision combination. When the sourcing engine evaluates whether material is available for allocation, it locks nodes in the quantity tree to prevent concurrent modifications from producing inconsistent reads.

In high-volume warehouse environments — where pick release processes run simultaneously from multiple worker threads or concurrent programs — multiple processes attempt to lock the same quantity tree nodes at the same time. If process A holds a lock on a quantity tree node and process B needs the same node, process B waits. If the wait exceeds the configured timeout, process B fails the allocation with a material sourcing error and immediately releases, allowing a subsequent attempt (which finds no competing lock) to succeed.

### Profile Option: INV: Quantity Tree Timeout for Lock

This profile controls how long the sourcing engine waits (in seconds) for a quantity tree lock before failing:

\`\`\`sql
-- Check current value at Site, Application, Responsibility, and User levels
SELECT level_id,
       level_value,
       profile_option_value,
       creation_date
FROM fnd_profile_option_values fpov
JOIN fnd_profile_options fpo
  ON fpo.profile_option_id = fpov.profile_option_id
WHERE fpo.profile_option_name = 'INV_QUANTITY_TREE_TIMEOUT'
ORDER BY level_id;
\`\`\`

A NULL value defaults to the Oracle database session timeout, which may be far too long — causing sourcing processes to hang rather than fail fast and allow retry. A value of **10 seconds** at the Site level is the standard recommendation for busy warehouses: the sourcing engine fails fast enough to release resources, and the automatic retry mechanism (in pick release batch programs) immediately re-queues the line.

### Profile Option: INV: Use Backorder Caching

Backorder caching stores the result of a previous ATP inquiry in session memory. In a long-running pick release session processing thousands of lines, a cached "backorder this line" decision made early in the session may persist and incorrectly apply to later lines where on-hand has become available through a completed receipt or transfer.

\`\`\`sql
-- Check INV: Use Backorder Caching
SELECT profile_option_value
FROM fnd_profile_option_values fpov
JOIN fnd_profile_options fpo
  ON fpo.profile_option_id = fpov.profile_option_id
WHERE fpo.profile_option_name = 'INV_BACKORDER_CACHING'
  AND fpov.level_id = 10001;  -- Site level
\`\`\`

Setting this to **No** at the Site level forces the engine to re-evaluate ATP on every line rather than relying on a cached state from earlier in the session.

### Discovering Hidden Cache-Related Profiles

Not all inventory caching configurations are visible in the standard Profiles form under their user-facing names. Query \`FND_PROFILE_OPTIONS\` directly for any INV cache-related entries:

\`\`\`sql
SELECT fpo.profile_option_name,
       fpot.user_profile_option_name,
       fpo.start_date_active,
       fpo.end_date_active
FROM fnd_profile_options fpo
JOIN fnd_profile_options_tl fpot
  ON fpo.profile_option_id = fpot.profile_option_id
WHERE fpot.language = 'US'
  AND UPPER(fpo.profile_option_name) LIKE 'INV%CACHE%'
ORDER BY fpo.profile_option_name;
\`\`\`

---

## Layer 2: Orphan Records in MTL_MATERIAL_TRANSACTIONS_TEMP

\`MTL_MATERIAL_TRANSACTIONS_TEMP\` (MMTT) is the staging table for in-flight inventory transactions. When the sourcing engine builds picking suggestions, it writes records to MMTT before they are processed by the material transaction manager (MTTM) and moved to the permanent transaction history. While a record exists in MMTT, the sourcing engine treats the associated material as effectively allocated — even if the transaction never completed.

If a prior allocation attempt was interrupted — by a network timeout, a database session disconnect, an application server crash, or an unhandled exception in a custom wrapper — the MMTT record may persist after the session that created it is gone. The next allocation attempt finds this orphan record and concludes that the material is already allocated, failing the sourcing process.

This is why the error clears on retry without data changes: the orphan record is eventually detected and resolved by the concurrent manager's MMTT cleanup process, or it expires naturally. The second attempt finds no orphan and succeeds.

### Diagnostic Query: Check for Orphan MMTT Records

\`\`\`sql
-- Immediately after a sourcing failure, run this query
-- Replace &target_mo_line_id with the failing move order line ID
SELECT mmtt.transaction_temp_id,
       mmtt.transaction_type_id,
       mmtt.transaction_action_id,
       mmtt.transaction_source_type_id,
       mmtt.move_order_line_id,
       mmtt.inventory_item_id,
       mmtt.organization_id,
       mmtt.subinventory_code,
       mmtt.locator_id,
       mmtt.lot_number,
       mmtt.transaction_quantity,
       mmtt.process_flag,
       mmtt.lock_flag,
       mmtt.creation_date,
       mmtt.created_by
FROM mtl_material_transactions_temp mmtt
WHERE mmtt.move_order_line_id = &target_mo_line_id;

-- Also check by item and org if move_order_line_id is not known
SELECT mmtt.transaction_temp_id,
       mmtt.move_order_line_id,
       mmtt.transaction_quantity,
       mmtt.process_flag,
       mmtt.lock_flag,
       mmtt.creation_date
FROM mtl_material_transactions_temp mmtt
WHERE mmtt.inventory_item_id  = &item_id
  AND mmtt.organization_id    = &org_id
  AND mmtt.creation_date     >= SYSDATE - 1/24  -- last hour
ORDER BY mmtt.creation_date DESC;
\`\`\`

**Key columns to evaluate**:

| Column | Value | Interpretation |
|---|---|---|
| PROCESS_FLAG | 1 | Ready for processing — may be orphaned |
| PROCESS_FLAG | 2 | Being processed — check for active backend session |
| LOCK_FLAG | 1 | Locked — check if locking session is still active |
| LOCK_FLAG | 2 | Unlocked |

An orphan has \`LOCK_FLAG = 1\` or \`PROCESS_FLAG = 1\` but no active database session holding the lock.

### Cross-Reference Against Active Sessions

\`\`\`sql
-- Check if any active session holds a lock on the MMTT record
SELECT s.sid, s.serial#, s.username, s.status, s.program, s.module,
       s.action, s.logon_time
FROM v\$session s
WHERE s.username IS NOT NULL
  AND s.status = 'ACTIVE'
  AND s.module LIKE '%INV%'
ORDER BY s.logon_time;

-- Check for row-level locks on MMTT
SELECT l.sid, l.type, l.lmode, l.request, l.block,
       o.object_name
FROM v\$lock l
JOIN dba_objects o ON l.id1 = o.object_id
WHERE o.object_name = 'MTL_MATERIAL_TRANSACTIONS_TEMP'
  AND l.type = 'TM';
\`\`\`

If the MMTT record exists but no session holds the lock, the record is orphaned.

---

## Layer 3: FND Session Framework Anomalies

If Layer 1 and Layer 2 are clean — profiles are correctly configured and no orphan MMTT records exist at the time of failure — the issue is deeper in the application technology stack. This layer is harder to diagnose because the failures are logged at the \`FND_LOG\` level rather than surfacing as standard functional errors.

### FND SSO Internal Validation Failures

EBS internally calls FND Single Sign-On validation routines during certain API executions, even when the organization is not using third-party SSO for user authentication. These internal calls validate the session security context. If the \`FND: SSO Type\` profile option is incorrectly populated — or if there is a mismatch between User-level and Site-level SSO configuration — the internal validation can throw an unexpected exception (\`FND_SSO_UNEXP_ERROR\`) that is not caught by the calling program.

The calling program — in this case, the pick release or move order allocation API — catches the unhandled exception generically and reports it as a sourcing failure. The actual cause (an SSO context validation failure) is buried in the FND debug log.

\`\`\`sql
-- Check SSO-related profile options
SELECT fpo.profile_option_name,
       fpot.user_profile_option_name,
       fpov.profile_option_value,
       DECODE(fpov.level_id, 10001,'SITE', 10002,'APP',
                              10003,'RESP', 10004,'USER') AS level_name,
       fpov.level_value
FROM fnd_profile_option_values fpov
JOIN fnd_profile_options fpo
  ON fpo.profile_option_id = fpov.profile_option_id
JOIN fnd_profile_options_tl fpot
  ON fpo.profile_option_id = fpot.profile_option_id
WHERE fpot.language = 'US'
  AND fpo.profile_option_name LIKE 'FND_SSO%'
ORDER BY fpo.profile_option_name, fpov.level_id;
\`\`\`

A \`FND: SSO Type\` value of \`SSO\` at the User level while the Site level is set to \`Local\` (or blank) creates a mismatched context that triggers these intermittent failures.

### FND Debug Logs: Isolating the True Error

The most important technique for this layer is enabling FND debug logging at the **User level only**, not at the Site level. Site-level debug logging in a production environment generates millions of rows per hour and makes the database I/O-bound.

\`\`\`sql
-- Enable FND debug logging for a specific user experiencing the issue
-- Replace &target_user_id with the FND_USER.USER_ID of the affected user

-- Set log level to STATEMENT (most verbose) for Inventory and Shipping modules
EXEC FND_PROFILE.SAVE('FND_DEBUG_LOG_LEVEL', '6', 'USER', &target_user_id);
EXEC FND_PROFILE.SAVE('FND_DEBUG_LOG_ENABLED', 'Y', 'USER', &target_user_id);

-- Set module filter to focus on INV and WSH
EXEC FND_PROFILE.SAVE('FND_DEBUG_LOG_MODULE', '%INV%:%WSH%:%WMS%', 'USER', &target_user_id);
\`\`\`

After the user reproduces the error, query the log within a short time window:

\`\`\`sql
-- Retrieve FND debug log entries around the time of failure
SELECT flm.log_sequence,
       flm.module,
       flm.message_text,
       flm.timestamp
FROM fnd_log_messages flm
WHERE flm.user_id = &target_user_id
  AND flm.timestamp >= SYSDATE - 1/1440  -- last minute
ORDER BY flm.log_sequence DESC
FETCH FIRST 200 ROWS ONLY;

-- Search specifically for error-level entries
SELECT flm.log_sequence, flm.module, flm.message_text, flm.timestamp
FROM fnd_log_messages flm
WHERE flm.user_id = &target_user_id
  AND flm.message_level >= 6  -- EXCEPTION and above
  AND flm.timestamp >= SYSDATE - 5/1440  -- last 5 minutes
ORDER BY flm.log_sequence;
\`\`\`

---

## Layer 4: Custom Interceptors and Inline Validation Hooks

This layer applies only to environments where custom code wraps or intercepts standard inventory API calls. It is particularly relevant when the issue is **only reproducible in production** and never in freshly cloned test instances — a strong indicator that the test environment is missing a dependency that exists only in production (a running concurrent program, a licensed third-party module, or a custom schema object).

### The Architecture of the Problem

Many enterprise EBS deployments implement custom picking or move order wrappers that:
1. Call standard inventory APIs (\`INV_REPLENISH_DETAIL_PUB\`, \`WMS_PICKING_PKG\`)
2. Inline with custom validation logic (compliance checks, license validation, operational constraints)
3. Return a combined success/failure status to the calling form or program

If the custom validation logic throws an unhandled exception — or if an inline database lock inside the custom package conflicts with a lock held by the standard API — the exception bubbles up through the call stack. The standard API sees an unexpected failure in what it assumed was a clean execution environment and reports a generic material sourcing failure rather than the actual cause.

### Example: License Validation Hook

A custom compliance package runs inside the pick confirmation flow:

\`\`\`
Standard API: WMS_PICK_CONFIRM_PUB.PICK_CONFIRM
  └── Custom hook: XX_LICENSE_VALIDATION_PKG.VALIDATE_PICK
        └── ORA-00054: resource busy (table-level lock conflict)
              └── Unhandled exception propagates up
Standard API reports: "Material Sourcing Process Failed"
Actual error: License validation table locked by maintenance job
\`\`\`

The intermittent nature comes from the maintenance job holding the lock — it runs for a few seconds, the first pick attempt hits the lock window, the second attempt runs outside the window.

### Identifying Custom Interceptors

\`\`\`sql
-- Find custom packages or triggers that reference standard inventory APIs
SELECT owner, name, type, line, text
FROM dba_source
WHERE UPPER(text) LIKE '%INV_REPLENISH_DETAIL_PUB%'
   OR UPPER(text) LIKE '%WMS_PICK_CONFIRM_PUB%'
   OR UPPER(text) LIKE '%WMS_PICKING_PKG%'
ORDER BY owner, name, line;

-- Find database triggers on inventory transaction tables that might intercept picks
SELECT trigger_name, table_name, trigger_type, triggering_event, status
FROM dba_triggers
WHERE table_name IN ('MTL_MATERIAL_TRANSACTIONS_TEMP',
                     'WSH_DELIVERY_DETAILS',
                     'MTL_TXN_REQUEST_LINES')
  AND owner NOT IN ('SYS','SYSTEM')
ORDER BY table_name, trigger_name;
\`\`\`

### Auditing Wrapper Exception Handling

Custom wrapper packages that suppress the true SQLERRM before re-raising a generic error are the single most common cause of misleading EBS error messages. When reviewing custom code, look for patterns like:

\`\`\`sql
-- Anti-pattern: error detail is discarded
EXCEPTION
  WHEN OTHERS THEN
    x_return_status := fnd_api.g_ret_sts_error;
    RAISE;  -- original SQLERRM is not logged anywhere

-- Correct pattern: log first, then handle
EXCEPTION
  WHEN OTHERS THEN
    -- Capture the true error before raising or rolling back
    INSERT INTO xx_custom_error_log (
      log_timestamp, calling_program, sqlcode, sqlerrm, backtrace
    ) VALUES (
      SYSTIMESTAMP, 'XX_PICK_WRAPPER', SQLCODE, SQLERRM,
      DBMS_UTILITY.FORMAT_ERROR_BACKTRACE
    );
    COMMIT;  -- commit the log before rolling back the transaction
    x_return_status := fnd_api.g_ret_sts_error;
    RAISE;
\`\`\`

If custom wrappers do not log \`DBMS_UTILITY.FORMAT_ERROR_BACKTRACE\`, the exact line and package that generated the original exception is permanently lost when the transaction rolls back.

---

## Example 1: Quantity Tree Timeout in High-Volume Pick Release

**Scenario**: A warehouse running 15 simultaneous pick release workers processing 10,000 lines each sees the sourcing failure approximately 2–3% of the time during peak shift hours. Each failure clears on the automated retry.

**Diagnosis**: \`INV: Quantity Tree Timeout for Lock\` is NULL at all levels, defaulting to the Oracle database lock timeout (300 seconds). Pick release workers hold quantity tree locks while evaluating 30–40 lines in sequence. Later workers time out waiting for the lock.

**Resolution**: Set \`INV: Quantity Tree Timeout for Lock\` to 10 at the Site level. Workers now fail fast, release resources, and the retry mechanism re-queues the line to the next available worker without competing for the same lock window.

---

## Example 2: Orphan MMTT From Application Server Crash

**Scenario**: The pick release concurrent program occasionally terminates abnormally when the managed server pod is recycled mid-execution. After the restart, the next pick release batch fails on specific lines — always the same lines — then succeeds on retry 15 minutes later.

**Diagnosis**: MMTT contains records with \`LOCK_FLAG = 1\` and \`PROCESS_FLAG = 1\` from the crashed session. The move order line IDs match exactly the failing lines. No active database session holds the lock.

**Resolution**: The concurrent manager's transaction cleanup program (\`Transaction Manager Cleanup\`) runs every 10 minutes and identifies orphaned MMTT records with no active session. After it runs, the second pick release batch succeeds. Reducing the cleanup interval from 10 minutes to 2 minutes eliminates the window in which the orphan blocks subsequent attempts.

---

## Example 3: Custom License Validation Causing Intermittent Misreported Failures

**Scenario**: A custom picking confirmation wrapper calls a third-party license validation package that queries a \`LICENSE_CONSTRAINTS\` table. A nightly maintenance job runs a DELETE/INSERT cycle on that table between 2:00 AM and 2:15 AM. During that window, pick confirmation intermittently fails with "Material Sourcing Process Failed" — the actual error (ORA-00054: resource busy) never appears in the standard error log.

**Diagnosis**: Reviewing the custom wrapper code reveals no \`DBMS_UTILITY.FORMAT_ERROR_BACKTRACE\` logging before the ROLLBACK. A custom staging log table is added to the wrapper's EXCEPTION block. On the next occurrence, the log shows \`ORA-00054\` against the \`LICENSE_CONSTRAINTS\` table at exactly 02:07.

**Resolution**: The custom wrapper adds a \`NOWAIT\` clause to the validation query (to fail fast if locked) and falls back to a cached license result stored in a global PL/SQL variable. Pick confirmation no longer calls the underlying table; the cache refreshes from the table every 30 minutes when no lock is held.

---

## Summary

Intermittent "Material Sourcing Process Failed" errors that resolve on retry are almost never caused by a functional inventory setup deficiency. The four investigation layers — in order of diagnostic ease — are:

**Layer 1 (Quantity Tree Locking)**: Check \`INV: Quantity Tree Timeout for Lock\` and \`INV: Use Backorder Caching\` profile options. High-volume environments without a finite lock timeout suffer race conditions where competing pick release workers block each other on quantity tree nodes.

**Layer 2 (MMTT Orphans)**: Query \`MTL_MATERIAL_TRANSACTIONS_TEMP\` immediately after a failure for records tied to the failing move order line or item/org combination. Orphan records from crashed sessions make material appear allocated. Cross-reference against \`V$SESSION\` to confirm no live session holds the lock.

**Layer 3 (FND Session Framework)**: Enable FND debug logging at the User level only (never Site level in production). Search \`FND_LOG_MESSAGES\` for \`FND_SSO_UNEXP_ERROR\` or any EXCEPTION-level entries from INV or WSH modules. Mismatched SSO profile settings at User vs Site level trigger internal validation failures that the calling API reports generically.

**Layer 4 (Custom Interceptors)**: Identify custom packages, triggers, or wrappers that intercept standard inventory APIs. Review their exception handling for missing \`DBMS_UTILITY.FORMAT_ERROR_BACKTRACE\` logging before rollback. Add a pre-rollback INSERT to a staging log table to capture the true \`SQLCODE\` and \`SQLERRM\` — this one change almost always reveals the actual root cause on the first occurrence after deployment.

The companion runbook covers the complete diagnostic sequence: profile validation queries, MMTT orphan detection and safe clearance, FND debug logging setup and log mining, database-level session and lock investigation, and a checklist for auditing custom wrapper exception handling.`,
};

async function main() {
  console.log('Inserting material sourcing blog post...');
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
