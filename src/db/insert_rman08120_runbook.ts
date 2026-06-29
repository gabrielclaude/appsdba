import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'RMAN-08120 Runbook: Diagnosing and Fixing the APPLIED ON ALL STANDBY Archive Deletion Lock',
  slug: 'rman-08120-applied-on-all-standby-runbook',
  excerpt:
    'Step-by-step runbook for resolving RMAN-08120 when automated archive log deletion stops on an Oracle Data Guard primary despite logs being confirmed applied on the standby. Covers confirming the deletion policy with RMAN SHOW ALL, identifying the specific inactive or phantom destination blocking deletion via V$ARCHIVE_DEST and V$ARCHIVED_LOG, verifying the active standby is healthy, applying the correct fix (policy change to APPLIED ON STANDBY or phantom destination removal), verifying deletion proceeds without FORCE, and monitoring scripts that detect archive log accumulation rate and deletion policy drift before they become a disk space emergency.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-29'),
  youtubeUrl: null,
  content: `## Introduction

This runbook resolves RMAN-08120 warnings that appear when RMAN refuses to delete archived logs on an Oracle Data Guard primary database despite the standby being current. The root cause is almost always \`CONFIGURED ARCHIVELOG DELETION POLICY TO APPLIED ON ALL STANDBY\` evaluating an inactive, deferred, or phantom destination in \`LOG_ARCHIVE_DEST_n\` that cannot confirm log application.

Work through the phases in order. Phase 1 confirms the symptom. Phase 2 identifies the blocking destination. Phase 3 verifies the active standby is healthy (ruling out a real apply lag). Phase 4 applies the fix. Phase 5 verifies archive deletion now proceeds normally.

**Environment assumptions**: Oracle Database 19c, Data Guard physical standby, RMAN configured with archivelog deletion policy. For RAC primaries, use \`GV$\` views where noted.

---

## Phase 1: Confirm the Symptom and Deletion Policy

### Step 1.1 — Reproduce the RMAN-08120 Warning

Run a manual deletion attempt and capture the output:

\`\`\`
$ rman target /

RMAN> DELETE ARCHIVELOG ALL COMPLETED BEFORE 'sysdate-1';
\`\`\`

If RMAN-08120 is the root cause, output resembles:

\`\`\`
RMAN-08120: warning: archived log not deleted, not yet applied by standby
  archived log file name=+FRA/EBSPRD/ARCHIVELOG/2026_06_29/thread_1_seq_4821.dbf
RMAN-08120: warning: archived log not deleted, not yet applied by standby
  archived log file name=+FRA/EBSPRD/ARCHIVELOG/2026_06_29/thread_2_seq_3107.dbf
\`\`\`

Note the thread numbers and sequences — you will cross-reference these in Phase 2.

### Step 1.2 — Confirm the Deletion Policy

\`\`\`
RMAN> SHOW ALL;
\`\`\`

Look for:

\`\`\`
CONFIGURE ARCHIVELOG DELETION POLICY TO APPLIED ON ALL STANDBY;
\`\`\`

If the policy reads \`APPLIED ON STANDBY\` (without ALL) and you are still seeing RMAN-08120, the cause is different — check for a real standby apply lag before continuing with this runbook.

If the policy reads \`APPLIED ON ALL STANDBY\`, proceed to Phase 2.

### Step 1.3 — Check FRA Utilization

Before investigating the root cause, note the FRA utilization so you can track whether it is actively growing:

\`\`\`sql
-- Run on the primary as SYS
SELECT SPACE_LIMIT / 1024 / 1024 / 1024 AS limit_gb,
       SPACE_USED  / 1024 / 1024 / 1024 AS used_gb,
       SPACE_RECLAIMABLE / 1024 / 1024 / 1024 AS reclaimable_gb,
       ROUND(SPACE_USED / SPACE_LIMIT * 100, 1) AS pct_used
FROM V\$RECOVERY_FILE_DEST;
\`\`\`

Record \`pct_used\`. If it exceeds 85%, your cleanup window is short — prioritize the fix.

---

## Phase 2: Identify the Blocking Destination

### Step 2.1 — List All Archive Destinations

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

**Interpretation**:

| Column value | Meaning |
|---|---|
| STATUS = 'VALID', TARGET = 'STANDBY' | Active standby destination — this one should be applying logs |
| STATUS = 'INACTIVE' | Destination exists in parameter file but is not transmitting — potential blocking destination |
| SCHEDULE = 'INACTIVE' | Destination is deferred — potential blocking destination |
| ERROR is not null | Destination has an error — potential blocking destination |

Any row where \`TARGET = 'STANDBY'\` and \`STATUS != 'VALID'\` or \`SCHEDULE = 'INACTIVE'\` is a candidate for causing the lock.

### Step 2.2 — For RAC: Check Per-Instance Destination Configuration

In a RAC environment, destination configuration can differ between instances. Run on the primary cluster:

\`\`\`sql
-- Run on the primary RAC cluster as SYS
SELECT INST_ID,
       DEST_ID,
       STATUS,
       TARGET,
       SCHEDULE,
       DESTINATION,
       ERROR
FROM GV\$ARCHIVE_DEST
WHERE DEST_ID > 1
ORDER BY INST_ID, DEST_ID;
\`\`\`

If INST_ID 1 and INST_ID 2 show different DEST_ID rows, a per-instance parameter is causing an asymmetric destination configuration. This is Scenario 3 from the companion blog post — the fix requires removing the per-instance \`LOG_ARCHIVE_DEST_n\` setting from the instance-specific SPFILE section.

### Step 2.3 — Cross-Reference V$ARCHIVED_LOG for the Blocking Destination

For each destination identified as inactive or deferred in Step 2.1, check whether any archived logs show \`APPLIED = 'NO'\` at that DEST_ID:

\`\`\`sql
-- Substitute the blocking DEST_ID from Step 2.1 (e.g., 3)
SELECT THREAD#,
       SEQUENCE#,
       DEST_ID,
       APPLIED,
       COMPLETION_TIME
FROM V\$ARCHIVED_LOG
WHERE DEST_ID = 3
AND COMPLETION_TIME > SYSDATE - 2
ORDER BY THREAD#, SEQUENCE#;
\`\`\`

If no rows are returned for the blocking DEST_ID, the destination never received the logs (because it is deferred or inactive). RMAN-08120 evaluates this as "not applied" and locks all logs.

If rows are returned with \`APPLIED = 'NO'\`, the destination received the logs but has not applied them.

### Step 2.4 — Identify the Destination Parameter Name

Map the DEST_ID from Step 2.1 to the parameter name:

\`\`\`sql
-- Show the actual parameter value for the blocking destination
SELECT NAME, VALUE
FROM V\$PARAMETER
WHERE NAME LIKE 'log_archive_dest_%'
AND NAME NOT LIKE '%state%'
AND NAME NOT LIKE '%min%'
ORDER BY NAME;
\`\`\`

Identify which \`LOG_ARCHIVE_DEST_N\` corresponds to the blocking DEST_ID (e.g., DEST_ID 3 corresponds to LOG_ARCHIVE_DEST_3). Also check the corresponding state parameter:

\`\`\`sql
SELECT NAME, VALUE
FROM V\$PARAMETER
WHERE NAME LIKE 'log_archive_dest_state_%'
ORDER BY NAME;
\`\`\`

A state of \`DEFER\` confirms the destination is intentionally deferred.

---

## Phase 3: Verify the Active Standby Is Healthy

Before applying the fix, confirm that the active standby is genuinely current. If there is a real apply lag, changing the deletion policy would delete logs the standby still needs.

### Step 3.1 — Check Apply and Transport Lag on the Primary

\`\`\`sql
-- Run on the PRIMARY
SELECT NAME, VALUE, DATUM_TIME
FROM V\$DATAGUARD_STATS
WHERE NAME IN ('apply lag', 'transport lag', 'apply finish time');
\`\`\`

Expected healthy output:
\`\`\`
NAME                VALUE         DATUM_TIME
apply lag           +00 00:00:02  2026-06-29 14:23:11
transport lag       +00 00:00:01  2026-06-29 14:23:11
apply finish time   +00 00:00:00  2026-06-29 14:23:11
\`\`\`

If \`apply lag\` is greater than 10 minutes and growing, the standby has a genuine apply problem that must be resolved first. Do not change the deletion policy until the standby is confirmed current.

### Step 3.2 — Verify MRP Is Running on the Standby

\`\`\`sql
-- Run on the STANDBY
SELECT PROCESS, STATUS, THREAD#, SEQUENCE#, BLOCK#
FROM V\$MANAGED_STANDBY
WHERE PROCESS IN ('MRP0', 'RFS')
ORDER BY PROCESS, THREAD#;
\`\`\`

Expected healthy output:
\`\`\`
PROCESS  STATUS      THREAD#  SEQUENCE#
MRP0     APPLYING_LOG   1     4822
RFS      IDLE           1     4823
RFS      IDLE           2     3108
\`\`\`

MRP0 in \`APPLYING_LOG\` or \`IDLE\` (caught up) is healthy. MRP0 missing or in \`ERROR\` state indicates a real apply problem.

### Step 3.3 — Confirm the Standby Is Synchronized via Broker

If Data Guard Broker is configured:

\`\`\`
$ dgmgrl /

DGMGRL> SHOW CONFIGURATION;
DGMGRL> SHOW DATABASE VERBOSE ebsprd_stb;
\`\`\`

The configuration status should report \`SUCCESS\`. The apply lag should be near zero.

If all three checks confirm the standby is healthy and synchronized, the RMAN-08120 is definitively caused by the inactive or phantom destination identified in Phase 2 — not by a real apply lag.

---

## Phase 4: Apply the Fix

Choose **Option A** or **Option B** based on your topology.

### Option A: Change Policy to APPLIED ON STANDBY (Recommended for Single Active Standby)

This is the correct fix for any environment with exactly one active physical standby. The \`ALL\` policy is unnecessary when there is only one destination to evaluate.

\`\`\`
$ rman target /

RMAN> CONFIGURE ARCHIVELOG DELETION POLICY TO APPLIED ON STANDBY;

new RMAN configuration parameters:
CONFIGURE ARCHIVELOG DELETION POLICY TO APPLIED ON STANDBY;
new RMAN configuration parameters are successfully stored

RMAN> SHOW ALL;
\`\`\`

Verify the output contains:
\`\`\`
CONFIGURE ARCHIVELOG DELETION POLICY TO APPLIED ON STANDBY;
\`\`\`

No database restart is required. The policy change takes effect immediately.

---

### Option B: Remove Phantom Destinations (If ALL Is Required for Multi-Standby)

If you operate multiple active physical standbys and genuinely need the \`ALL\` policy, the fix is to clear the phantom or deferred destination from the parameter file rather than changing the policy.

**Step B.1 — Clear the phantom destination (example: DEST_ID 3)**

\`\`\`sql
-- Run on the primary as SYS
-- Clear the destination value — setting to empty string removes it from RMAN's scope
ALTER SYSTEM SET LOG_ARCHIVE_DEST_3='' SCOPE=BOTH;
ALTER SYSTEM SET LOG_ARCHIVE_DEST_STATE_3=ENABLE SCOPE=BOTH;
\`\`\`

**Step B.2 — Verify the destination is cleared**

\`\`\`sql
SELECT DEST_ID, STATUS, DESTINATION
FROM V\$ARCHIVE_DEST
WHERE DEST_ID = 3;
\`\`\`

The row should now show an empty destination and \`STATUS = 'INACTIVE'\`. RMAN excludes destinations with no configured target from the \`ALL STANDBY\` evaluation.

**Step B.3 — Verify SPFILE**

\`\`\`sql
SELECT NAME, VALUE
FROM V\$SPPARAMETER
WHERE NAME = 'log_archive_dest_3';
\`\`\`

The VALUE should be null or empty.

**For RAC with per-instance destination asymmetry**: clear the parameter from the specific instance SPFILE section:

\`\`\`sql
-- Replace EBSPRD2 with the instance SID that had the extra destination
ALTER SYSTEM SET LOG_ARCHIVE_DEST_4='' SCOPE=SPFILE SID='EBSPRD2';
-- Requires bounce of that instance to take effect
\`\`\`

---

## Phase 5: Verify Archive Log Deletion Works

### Step 5.1 — Run Deletion Without FORCE

\`\`\`
RMAN> DELETE ARCHIVELOG ALL COMPLETED BEFORE 'sysdate-1';
\`\`\`

Expected output after the fix: RMAN lists the files to delete and prompts for confirmation. No RMAN-08120 warnings appear.

If RMAN-08120 warnings still appear, return to Phase 2 — there may be a second inactive destination that was not identified in the initial investigation.

### Step 5.2 — Confirm FRA Utilization Decreased

\`\`\`sql
SELECT SPACE_LIMIT / 1024 / 1024 / 1024 AS limit_gb,
       SPACE_USED  / 1024 / 1024 / 1024 AS used_gb,
       SPACE_RECLAIMABLE / 1024 / 1024 / 1024 AS reclaimable_gb,
       ROUND(SPACE_USED / SPACE_LIMIT * 100, 1) AS pct_used
FROM V\$RECOVERY_FILE_DEST;
\`\`\`

Compare \`pct_used\` against the value recorded in Phase 1. It should have decreased. If \`pct_used\` is still above 85%, run an additional deletion to reclaim space:

\`\`\`
RMAN> DELETE ARCHIVELOG ALL COMPLETED BEFORE 'sysdate-2';
\`\`\`

### Step 5.3 — Run the Next Scheduled Cleanup Job

If the RMAN-08120 was stopping an automated archive log deletion job (a cron job or DBMS_SCHEDULER job), run it manually once to confirm it completes cleanly:

\`\`\`
-- Example: manual execution of the cleanup script
$ /home/oracle/scripts/rman_archive_cleanup.sh 2>&1 | tail -20
\`\`\`

Confirm no RMAN-08120 lines appear in the output.

---

## Phase 6: Post-Fix Hardening

### Step 6.1 — Audit All Archive Destinations

After resolving the immediate issue, audit the full destination configuration to ensure no other deferred or inactive destinations remain that could cause the problem again:

\`\`\`sql
-- Full destination audit: identify every non-standard destination
SELECT DEST_ID,
       STATUS,
       ENABLED,
       TARGET,
       ARCHIVER,
       SCHEDULE,
       DESTINATION,
       ERROR,
       TRANSMIT_MODE,
       AFFIRM
FROM V\$ARCHIVE_DEST
WHERE DEST_ID BETWEEN 2 AND 31
AND (DESTINATION IS NOT NULL OR STATUS != 'INACTIVE')
ORDER BY DEST_ID;
\`\`\`

For each row returned, verify whether the destination is intentional, active, and healthy.

### Step 6.2 — Document the Deletion Policy Decision

Record the deletion policy decision in your environment runbook:

\`\`\`sql
-- Show current policy in effect
RMAN> SHOW ARCHIVELOG DELETION POLICY;
\`\`\`

Document:
- The policy chosen (APPLIED ON STANDBY or APPLIED ON ALL STANDBY)
- The active standby destination DEST_IDs
- Any deferred destinations that were cleared and why

This prevents a future DBA from re-adding a deferred destination without understanding its impact on the deletion policy.

### Step 6.3 — Set an FRA Alert Threshold

If your environment does not already have a monitor for FRA utilization, add one. A deletion policy failure is silent — RMAN completes without error exit codes — so FRA fill is the only visible symptom until disk space is exhausted:

\`\`\`sql
-- Check if a space usage alert threshold is set
SELECT * FROM V\$RECOVERY_FILE_DEST;

-- Oracle generates ORA-19809 at 85% and RMAN errors at 100%
-- External monitoring (see monitoring script below) catches growth before ORA-19809
\`\`\`

---

## Monitoring Scripts

### Script 1: Archive Log Accumulation Rate Monitor

Detects when archived logs are accumulating faster than they are being deleted — the primary signal that the deletion policy is failing.

\`\`\`bash
#!/bin/bash
# archive_accumulation_monitor.sh
# Run hourly via cron. Alerts when FRA exceeds threshold or
# archive log count grows beyond a high-water mark.
#
# Configuration
ORACLE_SID=EBSPRD
ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
PATH=\${ORACLE_HOME}/bin:\${PATH}
WARN_PCT=75
CRIT_PCT=85
ALERT_LOG=/var/log/rman_fra_monitor.log

export ORACLE_SID ORACLE_HOME PATH

RESULT=\$(sqlplus -s / as sysdba <<'ENDSQL'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF VERIFY OFF
SELECT ROUND(SPACE_USED / SPACE_LIMIT * 100, 1)
FROM V\$RECOVERY_FILE_DEST;
ENDSQL
)

PCT_USED=\$(echo "\${RESULT}" | tr -d ' ')

TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')

if [ -z "\${PCT_USED}" ] || [ "\${PCT_USED}" = "" ]; then
  echo "\${TIMESTAMP} ERROR: could not query V\$RECOVERY_FILE_DEST" >> "\${ALERT_LOG}"
  exit 2
fi

# Use awk for floating point comparison
WARN_HIT=\$(awk -v pct="\${PCT_USED}" -v warn="\${WARN_PCT}" 'BEGIN { print (pct >= warn) ? "1" : "0" }')
CRIT_HIT=\$(awk -v pct="\${PCT_USED}" -v crit="\${CRIT_PCT}" 'BEGIN { print (pct >= crit) ? "1" : "0" }')

if [ "\${CRIT_HIT}" = "1" ]; then
  echo "\${TIMESTAMP} CRITICAL: FRA utilization \${PCT_USED}% — archive logs may not be deleting (check RMAN deletion policy)" >> "\${ALERT_LOG}"
  # Add pager/email notification here
  exit 2
elif [ "\${WARN_HIT}" = "1" ]; then
  echo "\${TIMESTAMP} WARNING: FRA utilization \${PCT_USED}%" >> "\${ALERT_LOG}"
  exit 1
else
  echo "\${TIMESTAMP} OK: FRA utilization \${PCT_USED}%" >> "\${ALERT_LOG}"
  exit 0
fi
\`\`\`

### Script 2: Deletion Policy Drift Monitor

Detects when the RMAN archivelog deletion policy changes to \`APPLIED ON ALL STANDBY\` — useful for environments where multiple DBAs can modify RMAN configuration.

\`\`\`bash
#!/bin/bash
# rman_policy_monitor.sh
# Run daily via cron. Alerts when deletion policy includes ALL STANDBY
# without all destinations being verified active.
#
ORACLE_SID=EBSPRD
ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
PATH=\${ORACLE_HOME}/bin:\${PATH}
ALERT_LOG=/var/log/rman_policy_monitor.log

export ORACLE_SID ORACLE_HOME PATH

TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')

# Check deletion policy
POLICY=\$(rman target / <<'ENDRMAN' 2>/dev/null | grep -i "ARCHIVELOG DELETION POLICY"
SHOW ALL;
ENDRMAN
)

if echo "\${POLICY}" | grep -qi "APPLIED ON ALL STANDBY"; then
  # Policy is ALL — now check if any standby destination is inactive
  INACTIVE_COUNT=\$(sqlplus -s / as sysdba <<'ENDSQL'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF VERIFY OFF
SELECT COUNT(*)
FROM V\$ARCHIVE_DEST
WHERE TARGET = 'STANDBY'
AND DEST_ID > 1
AND (STATUS != 'VALID' OR SCHEDULE = 'INACTIVE' OR ERROR IS NOT NULL);
ENDSQL
)
  INACTIVE_COUNT=\$(echo "\${INACTIVE_COUNT}" | tr -d ' ')

  if [ "\${INACTIVE_COUNT}" -gt "0" ]; then
    echo "\${TIMESTAMP} CRITICAL: RMAN policy is APPLIED ON ALL STANDBY but \${INACTIVE_COUNT} standby destination(s) are inactive/errored — RMAN-08120 will occur" >> "\${ALERT_LOG}"
    exit 2
  else
    echo "\${TIMESTAMP} OK: APPLIED ON ALL STANDBY — all \$(sqlplus -s / as sysdba <<'ENDSQL2' | tr -d ' '
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF VERIFY OFF
SELECT COUNT(*) FROM V\$ARCHIVE_DEST WHERE TARGET='STANDBY' AND DEST_ID > 1 AND STATUS='VALID';
ENDSQL2
) standby destinations are active" >> "\${ALERT_LOG}"
    exit 0
  fi
elif echo "\${POLICY}" | grep -qi "APPLIED ON STANDBY"; then
  echo "\${TIMESTAMP} OK: RMAN policy is APPLIED ON STANDBY (single active standby mode)" >> "\${ALERT_LOG}"
  exit 0
elif echo "\${POLICY}" | grep -qi "NONE"; then
  echo "\${TIMESTAMP} WARNING: RMAN archivelog deletion policy is NONE — archived logs will not be auto-deleted" >> "\${ALERT_LOG}"
  exit 1
else
  echo "\${TIMESTAMP} INFO: RMAN policy: \${POLICY}" >> "\${ALERT_LOG}"
  exit 0
fi
\`\`\`

### Script 3: Destination Health and RMAN-08120 Risk Assessment

Run this manually when investigating RMAN-08120 or before modifying the deletion policy. Produces a consolidated report of destination status, deletion policy, and standby apply lag.

\`\`\`sql
-- rman08120_health_check.sql
-- Run as SYS on the primary
-- Produces a consolidated view of deletion policy risk

PROMPT ============================================================
PROMPT RMAN Archivelog Deletion Policy Assessment
PROMPT ============================================================

PROMPT
PROMPT -- Section 1: Archive Destinations
PROMPT

SELECT DEST_ID,
       RPAD(STATUS, 10) AS STATUS,
       RPAD(TARGET, 8) AS TARGET,
       RPAD(SCHEDULE, 10) AS SCHEDULE,
       DESTINATION,
       CASE WHEN ERROR IS NOT NULL THEN 'ERROR: ' || ERROR ELSE 'OK' END AS HEALTH
FROM V\$ARCHIVE_DEST
WHERE DEST_ID BETWEEN 2 AND 10
AND (DESTINATION IS NOT NULL OR STATUS != 'INACTIVE')
ORDER BY DEST_ID;

PROMPT
PROMPT -- Section 2: Inactive or Errored Standby Destinations (RMAN-08120 Risk)
PROMPT

SELECT DEST_ID,
       STATUS,
       TARGET,
       SCHEDULE,
       DESTINATION,
       ERROR
FROM V\$ARCHIVE_DEST
WHERE TARGET = 'STANDBY'
AND DEST_ID > 1
AND (STATUS != 'VALID' OR SCHEDULE = 'INACTIVE' OR ERROR IS NOT NULL);

PROMPT
PROMPT -- Section 3: Active Standby Apply Status
PROMPT

SELECT NAME, VALUE, DATUM_TIME
FROM V\$DATAGUARD_STATS
WHERE NAME IN ('apply lag', 'transport lag');

PROMPT
PROMPT -- Section 4: Recent Archived Log Application Status (last 24 hours)
PROMPT

SELECT THREAD#,
       SEQUENCE#,
       DEST_ID,
       APPLIED,
       COMPLETION_TIME
FROM V\$ARCHIVED_LOG
WHERE COMPLETION_TIME > SYSDATE - 1
AND DEST_ID > 1
ORDER BY COMPLETION_TIME DESC, THREAD#, SEQUENCE#
FETCH FIRST 20 ROWS ONLY;

PROMPT
PROMPT -- Section 5: FRA Utilization
PROMPT

SELECT ROUND(SPACE_USED / 1024 / 1024 / 1024, 2) AS used_gb,
       ROUND(SPACE_LIMIT / 1024 / 1024 / 1024, 2) AS limit_gb,
       ROUND(SPACE_USED / SPACE_LIMIT * 100, 1) AS pct_used,
       ROUND(SPACE_RECLAIMABLE / 1024 / 1024 / 1024, 2) AS reclaimable_gb
FROM V\$RECOVERY_FILE_DEST;
\`\`\`

---

## Quick Reference

### RMAN Deletion Policy Commands

\`\`\`
-- Show current policy
RMAN> SHOW ALL;
RMAN> SHOW ARCHIVELOG DELETION POLICY;

-- Change to single-standby policy (recommended for most environments)
RMAN> CONFIGURE ARCHIVELOG DELETION POLICY TO APPLIED ON STANDBY;

-- Change to all-standby policy (only if all destinations are active)
RMAN> CONFIGURE ARCHIVELOG DELETION POLICY TO APPLIED ON ALL STANDBY;

-- Remove the policy entirely (not recommended — logs accumulate indefinitely)
RMAN> CONFIGURE ARCHIVELOG DELETION POLICY TO NONE;

-- Reset to default (NONE)
RMAN> CONFIGURE ARCHIVELOG DELETION POLICY CLEAR;
\`\`\`

### Destination Management Commands

\`\`\`sql
-- Clear a phantom destination (e.g., DEST_ID 3)
ALTER SYSTEM SET LOG_ARCHIVE_DEST_3='' SCOPE=BOTH;
ALTER SYSTEM SET LOG_ARCHIVE_DEST_STATE_3=ENABLE SCOPE=BOTH;

-- Defer a destination without clearing it
ALTER SYSTEM SET LOG_ARCHIVE_DEST_STATE_3=DEFER SCOPE=BOTH;

-- Re-enable a deferred destination
ALTER SYSTEM SET LOG_ARCHIVE_DEST_STATE_3=ENABLE SCOPE=BOTH;

-- For RAC: clear from a specific instance SPFILE section
ALTER SYSTEM SET LOG_ARCHIVE_DEST_4='' SCOPE=SPFILE SID='EBSPRD2';
\`\`\`

### Archive Log Deletion Commands

\`\`\`
-- Standard deletion (uses deletion policy)
RMAN> DELETE ARCHIVELOG ALL COMPLETED BEFORE 'sysdate-1';

-- Delete applied logs only (explicit filter, policy-independent)
RMAN> DELETE ARCHIVELOG ALL COMPLETED BEFORE 'sysdate-1' BACKED UP 1 TIMES TO DEVICE TYPE DISK;

-- Emergency deletion bypassing policy (use only when FRA is critically full
-- and policy cannot be changed immediately)
RMAN> DELETE FORCE ARCHIVELOG ALL COMPLETED BEFORE 'sysdate-1';
\`\`\`

---

## Summary

RMAN-08120 on a Data Guard primary with a synchronized standby is resolved by addressing the mismatch between \`APPLIED ON ALL STANDBY\` and the presence of inactive or phantom archive destinations.

The diagnostic sequence is straightforward:
1. Confirm \`APPLIED ON ALL STANDBY\` is the configured policy (RMAN SHOW ALL)
2. Identify the inactive or phantom destination (V$ARCHIVE_DEST)
3. Confirm the active standby is genuinely current (V$DATAGUARD_STATS, V$MANAGED_STANDBY)
4. Fix by changing the policy to \`APPLIED ON STANDBY\` (single standby) or clearing the phantom destination (multi-standby)
5. Verify deletion proceeds without RMAN-08120 warnings

For ongoing operational safety, deploy the accumulation rate monitor and policy drift monitor to catch future recurrences before they become a disk space emergency.`,
};

async function main() {
  console.log('Inserting RMAN-08120 runbook...');
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
