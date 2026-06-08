import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Diagnosing and Recovering a GoldenGate Extract Lag Incident',
  slug: 'goldengate-extract-lag-incident-runbook',
  excerpt:
    'Step-by-step incident runbook for a GoldenGate Integrated Extract reporting hours of lag while remaining in RUNNING status. Covers the complete diagnostic path from OGG status commands through false-signal triage (OGG-01027, OGG-02081), archive log gap detection, Bounded Recovery checkpoint, archive log restoration, and purge-policy hardening to prevent recurrence.',
  category: 'golden-gate-problems' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-08'),
  youtubeUrl: null,
  content: `## Purpose and Scope

This runbook provides the complete diagnostic and recovery procedure for an Oracle GoldenGate Integrated Extract that is **in RUNNING status but accumulating lag**. That combination — process running, SCN advancing, yet lag growing — is the signature of a missing archive log gap rather than a process failure or database lock.

This runbook is a companion to [Resolving GoldenGate Extract Lag: A Production Case Study](/posts/goldengate-extract-lag-production-case-study), which narrates the investigation. This document is the operational checklist you run during the incident.

**Target environment:** Oracle 19c (19.24) + Oracle GoldenGate 21.7, Integrated Extract, single-instance or RAC.

---

## Incident Signature

Proceed with this runbook when all of the following are true:

| Symptom | How to Confirm |
|---------|---------------|
| Extract reports lag > 1 hour | \`INFO <EXTRACT_NAME>\` in GGSCI |
| Extract status is \`RUNNING\` | \`INFO ALL\` in GGSCI |
| SCN numbers are advancing | \`INFO <EXTRACT_NAME>\` shows progressing Log Read Checkpoint SCN |
| No active long-running transactions in the database | Query \`v$transaction\` — zero rows or rows with \`USED_UBLK = 0\` |
| No database errors in the Extract report | Report shows \`OGG-01027\` warnings with \`Items = 0\` (key indicator) |

---

## Prerequisites

- GGSCI access on the GoldenGate host
- SQL*Plus with DBA privileges on the source database
- OS access to the database server as \`oracle\` user
- RMAN access or cloud storage access to restore archive logs if needed

---

## Phase 1 — GoldenGate Status Assessment

### 1.1 Check Extract Lag and Checkpoint

In GGSCI on the GoldenGate host:

\`\`\`
GGSCI> INFO <EXTRACT_NAME>, DETAIL
\`\`\`

Record the following from the output:

| Field | What to Note |
|-------|-------------|
| \`Checkpoint Lag\` | Total hours behind — this is the incident severity |
| \`Log Read Checkpoint\` | The timestamp and SCN GoldenGate is currently mining from |
| \`Status\` | Must be \`RUNNING\` for this runbook to apply |

\`\`\`
GGSCI> INFO EXTRACT EXT_PROD, DETAIL

EXTRACT    EXT_PROD  Last Started 2026-06-02 09:10:48  Status RUNNING
Checkpoint Lag       94:12:33 (updated 00:00:02 ago)
Log Read Checkpoint  Oracle Integrated Redo Logs
                     2026-06-02 15:04:17
                     SCN 2515.609824878 (10802452574318)
\`\`\`

A lag measured in dozens of hours while the process is running is the primary indicator of a data starvation problem — not a process failure.

### 1.2 Check Active Transactions Visible to GoldenGate

\`\`\`
GGSCI> SEND EXTRACT <EXTRACT_NAME>, SHOWTRANS
\`\`\`

Look at the output closely. Transactions shown with **\`Items = 0\`** are GoldenGate's internal cache entries for historical transactions, not active database locks:

\`\`\`
Oldest running transaction:
XID:                0.469.20.2669234
Items:              0
Redo Thread:        1
Start Time:         2026-06-02 14:58:11
Start SCN:          10802452500000
\`\`\`

**\`Items = 0\` = false signal.** This is OGG-01027 behavior and does not indicate a live uncommitted transaction. Proceed to Phase 2.

### 1.3 Check the Extract Report File

\`\`\`bash
# On the GoldenGate host
tail -200 $GG_HOME/dirrpt/<EXTRACT_NAME>.rpt
\`\`\`

Look for these warning patterns:

| Warning | Meaning | Action |
|---------|---------|--------|
| \`OGG-01027 ... Items = 0\` | Stale internal cache entry, not a real lock | Cross-check against \`v$transaction\` (Phase 2) |
| \`OGG-02081 Detected duplicate TABLE/MAP entry\` | Parameter file has a table listed twice | Clean the parameter file — but this is cosmetic, not the lag cause |
| \`OGG-00446 Could not find archived log\` | Missing archive log — **this is the root cause** | Jump to Phase 4 |

---

## Phase 2 — Database-Side False Signal Triage

### 2.1 Verify No Active Long-Running Transactions

\`\`\`sql
-- Check for genuinely active uncommitted transactions
SELECT
    t.xidusn,
    t.xidslot,
    t.xidsqn,
    t.used_ublk,
    t.used_rec,
    ROUND((SYSDATE - t.start_date) * 24, 2) AS hours_open,
    s.username,
    s.program,
    s.status
FROM v$transaction t
JOIN v$session s ON t.ses_addr = s.saddr
WHERE t.start_date < SYSDATE - 1/24   -- open for more than 1 hour
ORDER BY hours_open DESC;
\`\`\`

If this returns **zero rows**: no real long-running transactions exist. The OGG-01027 warnings in the report are internal cache artifacts — confirmed false signals. The lag has a different cause.

### 2.2 Check GoldenGate Capture State

\`\`\`sql
SELECT
    capture_name,
    status,
    captured_scn,
    applied_scn,
    required_checkpoint_scn,
    (SYSDATE - SCN_TO_TIMESTAMP(required_checkpoint_scn)) * 24 AS req_checkpoint_age_hours
FROM dba_capture
ORDER BY req_checkpoint_age_hours DESC;
\`\`\`

The \`required_checkpoint_scn\` is the oldest SCN that GoldenGate must still be able to read from. If \`req_checkpoint_age_hours\` matches the lag duration (e.g., 94 hours), GoldenGate is stuck at that exact historical point — typically because the archive logs covering that SCN are no longer present.

### 2.3 Check v$goldengate_capture for Internal State

\`\`\`sql
SELECT
    capture_name,
    capture_type,
    state,
    captured_scn,
    required_checkpoint_scn,
    logminer_id
FROM v$goldengate_capture;
\`\`\`

A state of \`CAPTURING CHANGES\` with no error messages here confirms the engine is running — the bottleneck is at the data feed layer (archive logs), not the capture logic.

### 2.4 Clean Up Duplicate Parameter Entries (if OGG-02081 present)

If the report showed \`OGG-02081\`, clean the Extract parameter file:

\`\`\`
GGSCI> VIEW PARAMS <EXTRACT_NAME>
\`\`\`

Scan the TABLE/TRANLOGOPTIONS entries for exact duplicates. Remove duplicates with:

\`\`\`
GGSCI> EDIT PARAMS <EXTRACT_NAME>
\`\`\`

**This does not require stopping the extract** for cosmetic duplicate warnings, but note that duplicate entries will be flagged at every restart until removed.

---

## Phase 3 — Archive Log Gap Detection

### 3.1 Identify the Required Archive Log Sequence

Convert the \`required_checkpoint_scn\` from \`dba_capture\` to a log sequence number:

\`\`\`sql
-- Step 1: Get the required checkpoint SCN
SELECT capture_name, required_checkpoint_scn
FROM dba_capture;

-- Step 2: Find which archive log contains that SCN
SELECT thread#, sequence#, first_change#, next_change#,
       first_time, next_time,
       name, status
FROM v$archived_log
WHERE first_change# <= <required_checkpoint_scn>
  AND next_change#  >  <required_checkpoint_scn>
  AND dest_id = 1
ORDER BY thread#, sequence#;
\`\`\`

Note the \`sequence#\` returned — this is the log GoldenGate needs to start from.

### 3.2 Check Log Availability from That Sequence Forward

\`\`\`sql
-- Check a range of sequences around the required log
-- Replace 166740 and 166800 with your actual range
SELECT
    thread#,
    sequence#,
    first_time,
    next_time,
    blocks,
    block_size,
    status,
    name
FROM v$archived_log
WHERE sequence# BETWEEN 166740 AND 166800
  AND dest_id = 1
ORDER BY thread#, sequence#;
\`\`\`

Look for **gaps in the sequence number column**. If sequence 166747 is missing but 166746 and 166748 are present, the log was purged before GoldenGate could process it.

### 3.3 Verify Physical File Existence

\`\`\`bash
# On the database server — check whether the files listed in v$archived_log actually exist
ls -lh /u02/archivelog/  # replace with your archive log destination

# Or use RMAN to validate catalog vs filesystem state
rman target /
RMAN> LIST ARCHIVELOG ALL;
RMAN> CROSSCHECK ARCHIVELOG ALL;
\`\`\`

Any log showing \`EXPIRED\` in the RMAN crosscheck has been deleted from disk. A log that is \`EXPIRED\` and whose sequence covers the \`required_checkpoint_scn\` is the confirmed root cause.

### 3.4 One-Query Summary: Gap vs Required Checkpoint

\`\`\`sql
-- Shows which required logs are missing from the filesystem
SELECT
    al.thread#,
    al.sequence#,
    al.first_time,
    al.next_time,
    al.status,
    al.name,
    CASE WHEN al.first_change# <= dc.required_checkpoint_scn
              AND al.next_change# > dc.required_checkpoint_scn
         THEN 'REQUIRED START LOG'
         WHEN al.first_change# > dc.required_checkpoint_scn
         THEN 'REQUIRED FOR CATCHUP'
         ELSE 'NOT REQUIRED YET'
    END AS gg_requirement
FROM v$archived_log al
CROSS JOIN (SELECT required_checkpoint_scn FROM dba_capture WHERE rownum = 1) dc
WHERE al.sequence# >= (
    SELECT MIN(sequence#) FROM v$archived_log
    WHERE first_change# <= dc.required_checkpoint_scn
      AND dest_id = 1
)
AND al.dest_id = 1
ORDER BY al.thread#, al.sequence#;
\`\`\`

Any sequence showing \`STATUS = 'D'\` (deleted) or \`EXPIRED\` in RMAN that is marked \`REQUIRED START LOG\` or \`REQUIRED FOR CATCHUP\` must be restored before GoldenGate can clear the lag.

---

## Phase 4 — Recovery Procedure

### 4.1 Force a Bounded Recovery Checkpoint

Before restoring archive logs, stabilize GoldenGate's checkpoint to prevent it scanning further back on any accidental restart:

\`\`\`
GGSCI> SEND EXTRACT <EXTRACT_NAME>, BR BRCHECKPOINT IMMEDIATE
\`\`\`

Check the Extract report for confirmation:

\`\`\`bash
grep -E "OGG-01738|OGG-01631|BR Checkpoint" $GG_HOME/dirrpt/<EXTRACT_NAME>.rpt | tail -10
\`\`\`

Expected output:

\`\`\`
2026-06-08 10:14:22  INFO    OGG-01738  Bounded recovery file written.
2026-06-08 10:14:22  INFO    OGG-01631  Bounded recovery checkpoint completed.
\`\`\`

This writes a clean recovery file to \`$GG_HOME/dirbrr/\`. GoldenGate will use this as its restart point rather than scanning back to the original \`required_checkpoint_scn\`.

### 4.2 Restore Missing Archive Logs

Restore the required logs from your backup or cloud storage. The sequence range needed is from the \`required_checkpoint_scn\` log through to current:

**RMAN from backup:**

\`\`\`
rman target /

RMAN> RUN {
  SET ARCHIVELOG DESTINATION TO '/u02/archivelog/restore/';
  RESTORE ARCHIVELOG FROM SEQUENCE 166747 UNTIL SEQUENCE 166780 THREAD 1;
}
\`\`\`

**Cloud storage (example — adapt for your environment):**

\`\`\`bash
# Pull specific sequences from object storage
for SEQ in $(seq 166747 166780); do
  aws s3 cp s3://db-archive-backup/arch_1_\${SEQ}_*.arc /u02/archivelog/restore/ 2>/dev/null || true
done
\`\`\`

### 4.3 Catalog Restored Logs in RMAN

After placing the files on disk, update the RMAN catalog so Oracle can see them:

\`\`\`
rman target /
RMAN> CATALOG START WITH '/u02/archivelog/restore/';
RMAN> LIST ARCHIVELOG ALL;
\`\`\`

Verify the restored sequences now appear with \`STATUS = 'A'\` (available).

### 4.4 Verify GoldenGate Picks Up the Restored Logs

GoldenGate will detect the newly available archive logs within its next polling cycle (typically within 60 seconds). Monitor the Extract report:

\`\`\`bash
tail -f $GG_HOME/dirrpt/<EXTRACT_NAME>.rpt
\`\`\`

Look for lines indicating sequential log reads advancing past the previously stuck sequence:

\`\`\`
Processed log /u02/archivelog/restore/arch_1_166747_...arc
Processed log /u02/archivelog/restore/arch_1_166748_...arc
\`\`\`

---

## Phase 5 — Lag Reduction Monitoring

Once archive log reads resume, track lag reduction from GGSCI:

\`\`\`
GGSCI> INFO <EXTRACT_NAME>
\`\`\`

Or from SQL to monitor the \`dba_capture\` lag directly:

\`\`\`sql
-- Run every 5 minutes during recovery
SELECT
    capture_name,
    status,
    captured_scn,
    (SYSDATE - SCN_TO_TIMESTAMP(required_checkpoint_scn)) * 24     AS lag_hours_remaining,
    (SYSDATE - SCN_TO_TIMESTAMP(captured_scn)) * 24                AS current_capture_lag_hours,
    ROUND(
        (captured_scn - required_checkpoint_scn) /
        NULLIF((SYSDATE - SCN_TO_TIMESTAMP(required_checkpoint_scn)) * 3600, 0)
    )                                                               AS scn_per_second_catchup
FROM dba_capture;
\`\`\`

\`scn_per_second_catchup\` gives a rough throughput indicator. On a high-I/O environment with restored logs on fast storage, catchup rates of thousands of SCNs per second are normal.

---

## Phase 6 — Parameter File Cleanup

If OGG-02081 duplicate TABLE/MAP entries were identified in Phase 2, clean them now while the lag is recovering:

\`\`\`
GGSCI> VIEW PARAMS <EXTRACT_NAME>
\`\`\`

Open the parameter file, remove all duplicate TABLE entries, and save. The extract does not need to be restarted for this change to take effect at the next restart. Document the duplicates that were removed for the post-incident review.

---

## Phase 7 — Archive Log Purge Policy Hardening

This is the prevention step that stops a recurrence. The core rule: **never purge archive logs with a \`first_change#\` newer than the \`required_checkpoint_scn\` of any active capture process.**

### 7.1 Pre-Purge Safety Check Query

Add this check to any RMAN maintenance script that deletes archive logs:

\`\`\`sql
-- Run this before any archive log purge operation
-- Any sequence in this output must NOT be deleted
SELECT
    al.thread#,
    al.sequence#,
    al.first_change#,
    al.next_change#,
    dc.capture_name,
    dc.required_checkpoint_scn
FROM v$archived_log al
JOIN dba_capture dc
  ON al.first_change# <= dc.required_checkpoint_scn
 AND al.next_change#  >  dc.required_checkpoint_scn
WHERE al.dest_id = 1
ORDER BY al.thread#, al.sequence#;
\`\`\`

If this query returns any rows, those log sequences are still actively required by GoldenGate.

### 7.2 RMAN Deletion Policy Update

Replace any unconditional \`DELETE ARCHIVELOG\` commands in your RMAN scripts with a policy that respects GoldenGate:

\`\`\`
-- Safe RMAN deletion — only purge logs that are backed up AND applied by all capture processes
RMAN> DELETE NOPROMPT ARCHIVELOG ALL
      COMPLETED BEFORE 'SYSDATE - 7'
      BACKED UP 2 TIMES TO DISK;
\`\`\`

For environments where GoldenGate lag can exceed the retention window, set an explicit minimum retention:

\`\`\`
rman target /
RMAN> CONFIGURE ARCHIVELOG RETENTION POLICY TO RECOVERY WINDOW OF 10 DAYS;
\`\`\`

Choose a retention window that is longer than the maximum expected GoldenGate lag, including weekends and maintenance windows.

### 7.3 Cron-Based Pre-Purge Guard Script

Deploy this script on the database server to fail any RMAN purge job if GoldenGate has required logs that would be deleted:

\`\`\`bash
#!/bin/bash
# gg_archive_guard.sh — exits non-zero if RMAN purge would delete required GG logs
export ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_SID=PRODDB
export PATH=\$ORACLE_HOME/bin:\$PATH

REQUIRED_LOGS=$(sqlplus -s / as sysdba <<EOF
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF VERIFY OFF
SELECT COUNT(*)
FROM v\\$archived_log al
JOIN dba_capture dc
  ON al.first_change# <= dc.required_checkpoint_scn
 AND al.next_change#  >  dc.required_checkpoint_scn
WHERE al.dest_id = 1;
EXIT;
EOF
)

REQUIRED_LOGS=$(echo "\${REQUIRED_LOGS}" | tr -d '[:space:]')

if [ "\${REQUIRED_LOGS}" -gt "0" ]; then
    echo "ERROR: \${REQUIRED_LOGS} archive log(s) are still required by GoldenGate capture processes."
    echo "Do not purge archive logs until GoldenGate has advanced past these sequences."
    echo "Check: SELECT required_checkpoint_scn FROM dba_capture;"
    exit 1
fi

echo "OK: No GoldenGate-required archive logs at risk. Purge may proceed."
exit 0
\`\`\`

Call this from your RMAN cron wrapper before the DELETE command:

\`\`\`bash
/home/oracle/scripts/gg_archive_guard.sh || exit 1
# Only reaches here if guard passed
rman target / <<EOF
DELETE NOPROMPT ARCHIVELOG ALL COMPLETED BEFORE 'SYSDATE - 7';
EXIT;
EOF
\`\`\`

---

## Post-Incident Checklist

Run through these after the Extract lag returns to zero:

- [ ] Extract lag confirmed < 60 seconds in GGSCI \`INFO <EXTRACT_NAME>\`
- [ ] \`dba_capture.required_checkpoint_scn\` advancing normally (run the Phase 5 query twice, 5 minutes apart — \`lag_hours_remaining\` should be < 1)
- [ ] Duplicate TABLE/MAP parameter entries removed
- [ ] RMAN purge retention window reviewed and extended if needed
- [ ] \`gg_archive_guard.sh\` deployed and wired into the RMAN cron job
- [ ] Incident timeline documented: when lag started, which sequences were missing, restoration time, total recovery window
- [ ] Change request raised to add the pre-purge safety check SQL to the standard DBA runbook

---

## Quick Reference Card

\`\`\`sql
-- 1. How bad is the lag?
SELECT capture_name, status,
       (SYSDATE - SCN_TO_TIMESTAMP(required_checkpoint_scn)) * 24 AS lag_hours
FROM dba_capture;

-- 2. Is there a real long-running transaction?
SELECT COUNT(*), MAX(ROUND((SYSDATE - start_date) * 24, 2)) AS max_hours
FROM v$transaction;

-- 3. Which archive log does GoldenGate need first?
SELECT thread#, sequence#, first_change#, status, name
FROM v$archived_log
WHERE first_change# <= (SELECT MIN(required_checkpoint_scn) FROM dba_capture)
  AND dest_id = 1
ORDER BY thread#, sequence# DESC
FETCH FIRST 5 ROWS ONLY;

-- 4. Are those logs still on disk? (EXPIRED = deleted)
-- Run in RMAN: CROSSCHECK ARCHIVELOG ALL;

-- 5. After restore — is GoldenGate catching up?
SELECT capture_name,
       (SYSDATE - SCN_TO_TIMESTAMP(required_checkpoint_scn)) * 24 AS lag_hours
FROM dba_capture;
\`\`\`

\`\`\`
-- GoldenGate commands (GGSCI)
INFO <EXTRACT_NAME>, DETAIL        -- lag, checkpoint, status
SEND <EXTRACT_NAME>, SHOWTRANS     -- active transactions (Items = 0 = false signal)
SEND <EXTRACT_NAME>, BR BRCHECKPOINT IMMEDIATE  -- stabilize checkpoint before restore
INFO ALL                            -- all process status at a glance
\`\`\``,
};

async function main() {
  console.log('Inserting GoldenGate extract lag incident runbook...');
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
