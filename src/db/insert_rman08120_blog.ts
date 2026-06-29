import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: "RMAN-08120: The APPLIED ON ALL STANDBY Trap That Silently Breaks Archive Log Deletion",
  slug: 'rman-08120-applied-on-all-standby',
  excerpt:
    'A deep dive into RMAN-08120 — the warning that appears when automated archive log cleanup stops working on a Data Guard primary despite logs being confirmed applied on the standby. Covers the exact semantic difference between APPLIED ON STANDBY and APPLIED ON ALL STANDBY, how RMAN queries archive destination metadata to evaluate the policy, three real scenarios where ALL causes false positives (inactive destinations, pre-migration placeholder entries, and deferred destinations in RAC), and the fix sequence with verification queries.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-29'),
  youtubeUrl: null,
  content: `## Introduction

Standing up a new Oracle Data Guard physical standby database is a meaningful milestone. The redo transport is green, the apply lag is near zero, and the Data Guard Broker configuration reports SUCCESS across every health check. You hand the environment over to the operations team, confident that both HA and DR are covered.

Then the first automated archive log cleanup job runs. Instead of reclaiming disk space on the primary, RMAN prints a wall of warnings and touches nothing:

\`\`\`
RMAN-08120: warning: archived log not deleted, not yet applied by standby
  archived log file name=+FRA/EBSPRD/ARCHIVELOG/2026_06_29/thread_1_seq_4821.dbf
RMAN-08120: warning: archived log not deleted, not yet applied by standby
  archived log file name=+FRA/EBSPRD/ARCHIVELOG/2026_06_29/thread_2_seq_3107.dbf
\`\`\`

You check the standby. The logs are applied. The Data Guard apply lag in V\\$DATAGUARD_STATS is zero. The Broker reports the standby is synchronized. Yet RMAN refuses to delete a single file.

This is one of the most disorienting failures in Oracle Data Guard operations because every check that should confirm the problem is resolved — apply lag, standby status, Broker health — reports clean. The failure is not in the Data Guard configuration. It is in a single word in the RMAN deletion policy: **ALL**.

---

## Understanding the RMAN Archive Log Deletion Policy

RMAN's archivelog deletion policy controls when RMAN considers an archived log safe to delete from the primary or a local standby's Fast Recovery Area. The policy is set with:

\`\`\`
CONFIGURE ARCHIVELOG DELETION POLICY TO <policy>;
\`\`\`

Two policies are relevant to Data Guard environments:

### APPLIED ON STANDBY

\`\`\`
CONFIGURE ARCHIVELOG DELETION POLICY TO APPLIED ON STANDBY;
\`\`\`

An archived log satisfies this policy as soon as it has been applied by **at least one** active, mandatory remote standby destination. RMAN evaluates this by querying \`V\$ARCHIVED_LOG\` and checking whether any row for this log sequence has \`APPLIED = 'YES'\` at a remote standby site.

### APPLIED ON ALL STANDBY

\`\`\`
CONFIGURE ARCHIVELOG DELETION POLICY TO APPLIED ON ALL STANDBY;
\`\`\`

An archived log satisfies this policy only when it has been applied by **every** remote destination defined in the primary's \`LOG_ARCHIVE_DEST_n\` initialization parameters. RMAN does not limit its evaluation to currently active or healthy destinations. It evaluates every destination that is defined — including destinations that are deferred, have status INACTIVE, are in ERROR state, or are legacy placeholder entries from a previous configuration that were never cleaned up.

If any defined destination cannot confirm that the log has been applied — because it is inactive, unreachable, or never received the log — the policy is not satisfied and RMAN skips the deletion with RMAN-08120.

---

## How RMAN Evaluates the Policy

When RMAN prepares to delete an archived log under the \`APPLIED ON ALL STANDBY\` policy, it executes the equivalent of this internal query against the control file:

\`\`\`sql
-- RMAN's internal evaluation (simplified)
-- For each archive log candidate, check V$ARCHIVED_LOG across all defined destinations
SELECT DEST_ID, STANDBY_DEST, STATUS, TARGET
FROM V\$ARCHIVE_DEST
WHERE TARGET = 'STANDBY'
AND STATUS != 'INACTIVE'  -- RMAN does NOT filter inactive destinations
ORDER BY DEST_ID;
\`\`\`

The key misunderstanding is that RMAN does not ignore destinations just because they are in DEFERRED state or have a current error. Under \`ALL STANDBY\`, every destination is in scope — and if any destination cannot confirm application, the entire log is locked.

---

## Three Scenarios Where ALL Causes RMAN-08120

### Scenario 1: Inactive Placeholder Destination from Testing

A common source of phantom destinations is leftover testing or migration configuration. During a migration from an old DR site to a new one, a DBA sets:

\`\`\`sql
ALTER SYSTEM SET LOG_ARCHIVE_DEST_3='SERVICE=old_dr_site ASYNC OPTIONAL';
ALTER SYSTEM SET LOG_ARCHIVE_DEST_STATE_3=DEFER;
\`\`\`

After the migration completes, the old destination is deferred but never removed from the SPFILE. \`APPLIED ON ALL STANDBY\` sees this deferred destination, cannot confirm that the old DR site received or applied the log (it no longer exists), and refuses to delete any archived log.

\`\`\`sql
-- Diagnostic: list all archive destinations and their current status
SELECT DEST_ID, STATUS, TARGET, ARCHIVER, SCHEDULE,
       DESTINATION, ERROR
FROM V\$ARCHIVE_DEST
WHERE TARGET IN ('STANDBY','PRIMARY')
ORDER BY DEST_ID;

-- OUTPUT REVEALING THE PROBLEM:
-- DEST_ID  STATUS    TARGET    ARCHIVER  SCHEDULE  DESTINATION
-- 2        VALID     STANDBY   LGWR      ACTIVE    EBSPRD_STB        (active standby)
-- 3        INACTIVE  STANDBY   ARCH      INACTIVE  old_dr_site       ← phantom
\`\`\`

### Scenario 2: Pre-Migration Destination Entry in SPFILE

During initial Data Guard setup, some teams add a second destination as a placeholder for a future second standby that was planned but never provisioned:

\`\`\`
LOG_ARCHIVE_DEST_4='SERVICE=future_standby ASYNC'
LOG_ARCHIVE_DEST_STATE_4=DEFER
\`\`\`

The future standby never materialized. The destination sits in the SPFILE with DEFER state. \`APPLIED ON ALL STANDBY\` evaluates it and finds no evidence of log application. RMAN-08120 follows.

### Scenario 3: RAC with Thread-Specific Destination Configuration

In a two-node RAC primary, each thread generates its own archived logs. Under \`APPLIED ON ALL STANDBY\`, RMAN checks that the log from every thread has been applied at every defined destination. If a destination was added at the instance level (e.g., only in EBSPRD2's SPFILE section) rather than at the database level, it may appear in the destination list for one thread but not the other. RMAN finds an inconsistency and refuses deletion across both threads.

\`\`\`sql
-- Check for per-instance destination differences in RAC
SELECT INST_ID, DEST_ID, STATUS, TARGET, DESTINATION
FROM GV\$ARCHIVE_DEST
WHERE TARGET = 'STANDBY'
ORDER BY INST_ID, DEST_ID;

-- If INST_ID 1 and INST_ID 2 show different DEST_ID entries, this is the problem
\`\`\`

---

## Investigating the Root Cause

Before changing the deletion policy, identify which destination is causing the lock.

### Step 1: Check the Deletion Policy

\`\`\`
RMAN> SHOW ALL;
\`\`\`

Look for the line:
\`\`\`
CONFIGURE ARCHIVELOG DELETION POLICY TO APPLIED ON ALL STANDBY;
\`\`\`

If you see \`ALL\`, that is your starting point.

### Step 2: Examine V$ARCHIVE_DEST

\`\`\`sql
-- Run on the primary as SYS
SELECT DEST_ID,
       STATUS,
       ENABLED,
       TARGET,
       ARCHIVER,
       SCHEDULE,
       DESTINATION,
       ERROR
FROM V\$ARCHIVE_DEST
WHERE DEST_ID > 1
ORDER BY DEST_ID;
\`\`\`

Any row with \`STATUS = 'INACTIVE'\`, \`SCHEDULE = 'INACTIVE'\`, or a non-empty ERROR field that corresponds to a standby destination is a candidate for causing RMAN-08120.

### Step 3: Cross-Reference V$ARCHIVED_LOG

\`\`\`sql
-- Check apply status for recent archived logs at each standby destination
SELECT THREAD#, SEQUENCE#, DEST_ID, APPLIED, COMPLETION_TIME
FROM V\$ARCHIVED_LOG
WHERE DEST_ID > 1
AND COMPLETION_TIME > SYSDATE - 1
ORDER BY THREAD#, SEQUENCE#, DEST_ID;

-- If a DEST_ID appears with APPLIED = 'NO' for logs that the active standby
-- has confirmed applied, the inactive destination is the culprit
\`\`\`

### Step 4: Confirm the Active Standby IS Applying

\`\`\`sql
-- On the PRIMARY — confirm the active standby has applied recent logs
SELECT NAME, VALUE, DATUM_TIME
FROM V\$DATAGUARD_STATS
WHERE NAME IN ('apply lag','transport lag');

-- On the STANDBY — confirm MRP is active and current sequence
SELECT PROCESS, STATUS, THREAD#, SEQUENCE#
FROM V\$MANAGED_STANDBY
WHERE PROCESS IN ('MRP0','RFS')
ORDER BY PROCESS, THREAD#;
\`\`\`

If the active standby is current (apply lag near zero, MRP0 running) but RMAN still refuses to delete, the problem is definitively the inactive or phantom destination evaluated under \`ALL STANDBY\`.

---

## The Fix

### Option A: Change Policy to APPLIED ON STANDBY (Recommended for Single Standby)

For any topology with exactly one active physical standby, this is the correct policy:

\`\`\`
RMAN> CONFIGURE ARCHIVELOG DELETION POLICY TO APPLIED ON STANDBY;

RMAN> SHOW ALL;
-- Confirm: CONFIGURE ARCHIVELOG DELETION POLICY TO APPLIED ON STANDBY;
\`\`\`

After this change, re-run the deletion — RMAN will evaluate only the active standby destination and proceed normally:

\`\`\`
RMAN> DELETE ARCHIVELOG ALL COMPLETED BEFORE 'sysdate-1';
\`\`\`

No RMAN-08120 warnings. No FORCE flag required.

### Option B: Clean Up Inactive Destinations (If ALL Is Required)

If you genuinely operate multiple standbys and need ALL, remove or disable the phantom destinations:

\`\`\`sql
-- Identify the phantom DEST_ID (e.g., DEST_ID = 3)
-- Clear it from the SPFILE
ALTER SYSTEM SET LOG_ARCHIVE_DEST_3='' SCOPE=BOTH;
ALTER SYSTEM SET LOG_ARCHIVE_DEST_STATE_3=ENABLE SCOPE=BOTH;
-- (Setting the destination to empty effectively removes it from RMAN's scope)

-- Verify it is gone
SELECT DEST_ID, STATUS, DESTINATION FROM V\$ARCHIVE_DEST WHERE DEST_ID = 3;
\`\`\`

After clearing phantom destinations, \`APPLIED ON ALL STANDBY\` will evaluate only the genuine active standby and function correctly.

---

## When ALL Is the Right Choice

The \`APPLIED ON ALL STANDBY\` policy is appropriate in environments that maintain multiple physical standbys where all standbys are required to have applied the log before it can be purged. Example:

\`\`\`
Primary → Standby A (DR site 1) — operational, applying redo
        → Standby B (DR site 2) — operational, applying redo
        → Standby C (reporting, Active Data Guard) — operational, read-only with apply
\`\`\`

In this topology, \`ALL STANDBY\` ensures that no archived log is purged from the primary until Standby A, B, and C have all confirmed application. If Standby C's apply falls behind, archived logs are retained on the primary until C catches up. This provides a guarantee that any standby can be promoted without log gap at the cost of primary FRA space when any standby lags.

The critical discipline: if you use \`ALL STANDBY\`, every \`LOG_ARCHIVE_DEST_n\` parameter that points to a standby — including deferred and optional ones — must be actively functioning. A single inactive destination breaks the policy for the entire environment.

---

## Summary

RMAN-08120 on a newly provisioned Data Guard environment is almost always caused by \`APPLIED ON ALL STANDBY\` encountering a destination in the \`LOG_ARCHIVE_DEST_n\` parameter list that cannot confirm log application — because it is inactive, deferred, or a leftover placeholder from a previous configuration.

The semantic distinction is precise:
- **APPLIED ON STANDBY**: log is safe to delete once any active standby has applied it
- **APPLIED ON ALL STANDBY**: log is safe to delete only when every defined standby destination — including inactive ones — has applied it

For a standard single-standby deployment, the correct policy is \`APPLIED ON STANDBY\`. Changing this single word in the RMAN configuration restores automated archive log deletion without requiring the FORCE flag, without touching any Data Guard configuration, and without any risk to standby availability or data protection.

For multi-standby deployments that require \`ALL\`, the operational discipline is strict: every destination defined in \`LOG_ARCHIVE_DEST_n\` must be actively healthy. Phantom or deferred destinations must be cleared.`,
};

async function main() {
  console.log('Inserting RMAN-08120 blog post...');
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
