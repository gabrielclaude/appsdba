import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Fractured Free Block Runbook: Diagnosing and Clearing Non-Dangerous Block Corruption in Oracle',
  slug: 'oracle-fractured-free-block-corruption-runbook',
  excerpt:
    'Step-by-step runbook for investigating V$DATABASE_BLOCK_CORRUPTION FRACTURED entries, confirming the affected blocks are unallocated free space, and clearing the corruption through targeted extent allocation rather than RMAN block recovery. Covers the triage queries that distinguish safe free-block corruption from genuine segment-level corruption, two remediation paths (row insertion for small free spaces, ALLOCATE EXTENT with DATAFILE clause for large ones), the RMAN validate cycle that refreshes V$DATABASE_BLOCK_CORRUPTION after remediation, post-fix verification queries, and monitoring scripts that classify corruption entries by segment ownership so routine alerts are not triggered by benign free-block events.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-29'),
  youtubeUrl: null,
  content: `## Introduction

This runbook resolves \`V$DATABASE_BLOCK_CORRUPTION\` entries of type \`FRACTURED\` that occur in unallocated free space within an Oracle tablespace. These entries are generated when RMAN validation detects a block whose header and tail SCNs do not match — most commonly after a backup tool has captured a block mid-write during a storage snapshot or when a database is restored from a backup set that skipped free blocks.

When fractured blocks belong to free space (no segment owns them), no user data is at risk. Standard RMAN block recovery will fail because backup tools never captured a clean image of free blocks. The correct remediation forces Oracle's block formatter to overwrite the fractured blocks by allocating a dummy segment over the affected free space.

**Use this runbook when**: \`V$DATABASE_BLOCK_CORRUPTION\` contains \`FRACTURED\` entries that cross-reference to no rows in \`DBA_EXTENTS\`.

**Do not use this runbook when**: The corrupted blocks are owned by an active segment (a table, index, LOB, or undo segment). That scenario requires RMAN block media recovery or datafile restore and is outside the scope of this document.

---

## Phase 1: Initial Triage — Confirm Corruption Type and Scale

### Step 1.1 — Review All Current Corruption Entries

\`\`\`sql
-- As SYS or DBA — run on the primary database
SELECT FILE#,
       BLOCK#,
       BLOCKS,
       CORRUPTION_TYPE,
       CORRUPTION_CHANGE#
FROM V\$DATABASE_BLOCK_CORRUPTION
ORDER BY FILE#, BLOCK#;
\`\`\`

Record every row. Note which entries are \`FRACTURED\` (physical header/tail mismatch) versus other types:

| CORRUPTION_TYPE | Safe to use this runbook? |
|---|---|
| FRACTURED | Yes — if DBA_EXTENTS check returns no rows |
| ALL ZERO | Yes — never-formatted block, same approach |
| CHECKSUM | Investigate carefully — may be segment data |
| CORRUPT | No — requires RMAN or Oracle Support |
| LOGICAL | No — requires segment-level investigation |

This runbook applies to \`FRACTURED\` and \`ALL ZERO\` entries only.

### Step 1.2 — Map File Numbers to Datafile Names

\`\`\`sql
-- Identify which datafiles are affected
SELECT d.file#,
       d.name AS datafile_name,
       d.status,
       d.bytes / 1024 / 1024 / 1024 AS size_gb,
       t.name AS tablespace_name
FROM V\$DATAFILE d
JOIN V\$TABLESPACE t ON d.ts# = t.ts#
WHERE d.file# IN (
  SELECT DISTINCT file# FROM V\$DATABASE_BLOCK_CORRUPTION
)
ORDER BY d.file#;
\`\`\`

Record the \`datafile_name\` for each affected FILE# — you will need the full path in the \`ALLOCATE EXTENT\` command during remediation.

### Step 1.3 — Check Whether V$DATABASE_BLOCK_CORRUPTION Is Current

\`V$DATABASE_BLOCK_CORRUPTION\` is populated by RMAN and is not automatically updated. Entries can be stale — reflecting corruption detected weeks or months ago that was already remediated, or missed because no validation has run recently.

\`\`\`
-- Refresh the view by running a validation pass before investing in remediation
RMAN> VALIDATE DATABASE;
-- Or for a specific file:
RMAN> VALIDATE DATAFILE 406;
\`\`\`

After validate completes, re-query \`V$DATABASE_BLOCK_CORRUPTION\`. Remove any entries from your investigation list that disappeared (they were stale records from blocks already healed).

---

## Phase 2: Confirm the Blocks Are Free Space

This is the critical gate. Do not proceed to remediation until both queries confirm the blocks are unallocated.

### Step 2.1 — DBA_EXTENTS Check (Primary Confirmation)

Run this query for **each** corrupted block range. Substitute the FILE# and BLOCK# from Step 1.1:

\`\`\`sql
-- Template: replace file_id and block# with values from V$DATABASE_BLOCK_CORRUPTION
SELECT segment_name,
       segment_type,
       owner,
       extent_id,
       block_id,
       blocks
FROM dba_extents
WHERE file_id = &corrupted_file_id
  AND &corrupted_block# BETWEEN block_id AND block_id + blocks - 1;

-- Also check the last block in the range (BLOCK# + BLOCKS - 1):
SELECT segment_name, segment_type, owner
FROM dba_extents
WHERE file_id = &corrupted_file_id
  AND (&corrupted_block# + &corrupted_blocks - 1) BETWEEN block_id AND block_id + blocks - 1;
\`\`\`

**Expected result for a safe free-block scenario**: no rows returned from either query.

**If rows are returned**: the blocks belong to an active segment. Stop. This is genuine segment-level corruption requiring RMAN block media recovery or Oracle Support engagement.

### Step 2.2 — DBA_FREE_SPACE Check (Secondary Confirmation)

\`\`\`sql
SELECT tablespace_name,
       file_id,
       block_id,
       blocks,
       bytes / 1024 / 1024 AS mb_free
FROM dba_free_space
WHERE file_id = &corrupted_file_id
  AND &corrupted_block# BETWEEN block_id AND block_id + blocks - 1;
\`\`\`

**Expected result**: one or more rows showing a free extent that contains or overlaps the corrupted block range.

If \`DBA_FREE_SPACE\` also returns no rows, the blocks may be in a transitional state (being allocated or freed by an active transaction). Wait for active transactions to complete and re-check both views.

### Step 2.3 — Check the Recyclebin (Dropped Segments)

Blocks from recently dropped segments remain in \`DBA_EXTENTS\` until the recyclebin is purged. If Step 2.1 returned rows for a segment in the recyclebin:

\`\`\`sql
-- Check if the owning segment was dropped and is in the recyclebin
SELECT owner, original_name, object_name, type, droptime, can_purge
FROM dba_recyclebin
WHERE owner = '&segment_owner'
  AND original_name = '&segment_name';
\`\`\`

If the segment is in the recyclebin, purge it to release the blocks to free space, then re-run the DBA_EXTENTS check:

\`\`\`sql
-- Purge a specific recyclebin object
PURGE TABLE "&owner"."&recyclebin_object_name";

-- Or purge the full recyclebin
PURGE DBA_RECYCLEBIN;
\`\`\`

---

## Phase 3: Assess Remediation Strategy

The approach depends on how much free space exists in the tablespace and how far through the file the corrupted blocks are located.

### Step 3.1 — Identify the Tablespace and Available Free Space

\`\`\`sql
-- Get tablespace for the affected file
SELECT t.name AS tablespace_name,
       d.file# AS file_num,
       d.name AS datafile_path,
       d.bytes / 1024 / 1024 / 1024 AS total_gb
FROM V\$DATAFILE d
JOIN V\$TABLESPACE t ON d.ts# = t.ts#
WHERE d.file# = &corrupted_file_id;

-- Total free space in the tablespace
SELECT tablespace_name,
       ROUND(SUM(bytes) / 1024 / 1024 / 1024, 2) AS total_free_gb,
       COUNT(*) AS free_extents
FROM dba_free_space
WHERE tablespace_name = '&tablespace_name'
GROUP BY tablespace_name;

-- Free space specifically in the affected file
SELECT file_id,
       ROUND(SUM(bytes) / 1024 / 1024 / 1024, 2) AS free_gb_in_file,
       MIN(block_id) AS first_free_block,
       MAX(block_id + blocks - 1) AS last_free_block
FROM dba_free_space
WHERE file_id = &corrupted_file_id
GROUP BY file_id;
\`\`\`

### Step 3.2 — Determine Remediation Path

| Condition | Recommended approach |
|---|---|
| Corrupted blocks are near the start of the file's free space | Row insertion — Oracle ASSM allocates from the first available free extent |
| Corrupted blocks are deep in the file (high block numbers relative to first free block) | ALLOCATE EXTENT with DATAFILE + SIZE — sweep through free space directly |
| Multiple corruption ranges across a large file | ALLOCATE EXTENT with a SIZE large enough to span all corrupted ranges |
| Tablespace is nearly full (< 5% free) | Row insertion only — ALLOCATE EXTENT with large SIZE may fail if insufficient contiguous space |

---

## Phase 4: Remediation — Path A (Row Insertion, Small Free Spaces)

Use this path when the corrupted blocks are near the beginning of the tablespace's free space and the total free space is under 50 GB.

### Step 4.1 — Create the Dummy Table

\`\`\`sql
-- Use an existing admin or migration schema that owns space in this tablespace
-- Substitute &schema_name and &tablespace_name
CREATE TABLE &schema_name..dummy_block_format (
    id  NUMBER,
    pad CHAR(2000)
) TABLESPACE &tablespace_name;
\`\`\`

\`CHAR(2000)\` with a NUMBER column packs approximately 4 rows per Oracle block (at 8 KB block size). Each commit of 100,000 rows allocates roughly 25,000 blocks — about 195 MB at 8 KB.

### Step 4.2 — Insert Rows to Force Block Allocation

\`\`\`sql
-- First pass: 100,000 rows (~195 MB)
BEGIN
    FOR i IN 1..100000 LOOP
        INSERT INTO &schema_name..dummy_block_format VALUES (i, 'A');
        IF MOD(i, 1000) = 0 THEN COMMIT; END IF;
    END LOOP;
    COMMIT;
END;
/

-- Check if corruption entries have cleared
-- (run in a separate session while the above is running or after commit)
SELECT COUNT(*) AS remaining_corrupt
FROM V\$DATABASE_BLOCK_CORRUPTION
WHERE FILE# = &corrupted_file_id;
\`\`\`

Repeat the insert loop if blocks remain. Each pass covers approximately 195 MB of free space.

### Step 4.3 — Monitor Block Allocation Progress

\`\`\`sql
-- Find the highest block currently allocated to the dummy table
SELECT MAX(block_id + blocks - 1) AS highest_allocated_block
FROM dba_extents
WHERE segment_name = 'DUMMY_BLOCK_FORMAT'
  AND owner = '&schema_name'
  AND file_id = &corrupted_file_id;

-- Compare against the corrupted block ranges to estimate progress
-- When highest_allocated_block > MAX(BLOCK# + BLOCKS - 1) from V$DATABASE_BLOCK_CORRUPTION,
-- the allocation has passed all corrupted ranges
\`\`\`

---

## Phase 5: Remediation — Path B (ALLOCATE EXTENT, Large Free Spaces)

Use this path when the corrupted blocks are far into the free space pool, or when the total free space to traverse exceeds 50 GB and row insertion would be impractically slow.

### Step 5.1 — Create the Dummy Table

\`\`\`sql
CREATE TABLE &schema_name..dummy_block_format (
    id  NUMBER,
    pad CHAR(2000)
) TABLESPACE &tablespace_name;
\`\`\`

### Step 5.2 — Calculate Required Allocation Size

Determine how far through the file the corrupted blocks are and how much space must be allocated to force Oracle to format those blocks:

\`\`\`sql
-- Find the first free block in the file
SELECT MIN(block_id) AS first_free_block
FROM dba_free_space
WHERE file_id = &corrupted_file_id;

-- Find the last corrupted block in the file
SELECT MAX(block# + blocks - 1) AS last_corrupted_block
FROM V\$DATABASE_BLOCK_CORRUPTION
WHERE file# = &corrupted_file_id;

-- Required blocks = last_corrupted_block - first_free_block + buffer (add 10%)
-- Convert to GB: (required_blocks * block_size_bytes) / 1073741824
-- block_size_bytes is typically 8192 for Oracle 19c standard block size
SELECT ROUND(
  (MAX(c.block# + c.blocks - 1) - MIN(f.block_id) + 1000) * 8192 / 1073741824 * 1.1,
  2
) AS required_allocation_gb
FROM V\$DATABASE_BLOCK_CORRUPTION c
CROSS JOIN (
  SELECT MIN(block_id) AS block_id FROM dba_free_space WHERE file_id = &corrupted_file_id
) f
WHERE c.file# = &corrupted_file_id;
\`\`\`

### Step 5.3 — Allocate Extents Targeting the Specific Datafile

\`\`\`sql
-- Get the full datafile path (from Step 1.2)
-- Replace /path/to/datafile.dbf with the actual path
-- Replace 10G with the required_allocation_gb from Step 5.2 (round up to nearest 5G)

ALTER TABLE &schema_name..dummy_block_format
  ALLOCATE EXTENT (DATAFILE '/path/to/datafile_406.dbf' SIZE 10G);

-- If that is not enough (corrupted blocks still showing), allocate another extent
ALTER TABLE &schema_name..dummy_block_format
  ALLOCATE EXTENT (DATAFILE '/path/to/datafile_406.dbf' SIZE 10G);
\`\`\`

**For ASM datafiles**, the DATAFILE clause uses the ASM path:

\`\`\`sql
ALTER TABLE &schema_name..dummy_block_format
  ALLOCATE EXTENT (DATAFILE '+FRA/EBSPRD/DATAFILE/bgn_mycims_mig_qdata.406.1234567890' SIZE 10G);
\`\`\`

Get the ASM datafile name from:

\`\`\`sql
SELECT name FROM V\$DATAFILE WHERE file# = &corrupted_file_id;
\`\`\`

### Step 5.4 — Check After Each Allocation

\`\`\`sql
-- After each ALLOCATE EXTENT, check whether corruption entries remain
SELECT file#, block#, blocks, corruption_type
FROM V\$DATABASE_BLOCK_CORRUPTION
WHERE file# = &corrupted_file_id;

-- Also check the highest allocated block
SELECT MAX(block_id + blocks - 1) AS highest_allocated_block
FROM dba_extents
WHERE segment_name = 'DUMMY_BLOCK_FORMAT'
  AND owner = UPPER('&schema_name')
  AND file_id = &corrupted_file_id;
\`\`\`

Note: \`V$DATABASE_BLOCK_CORRUPTION\` does not update in real time as blocks are formatted. The RMAN validate step in Phase 6 will clear the entries after formatting is confirmed.

---

## Phase 6: Cleanup and RMAN Validation

### Step 6.1 — Drop the Dummy Table

Once the allocation pass is complete (highest allocated block exceeds all corrupted block ranges):

\`\`\`sql
-- PURGE removes the table immediately from the recyclebin, returning space to the free pool
DROP TABLE &schema_name..dummy_block_format PURGE;

-- Confirm the table is gone and space is released
SELECT COUNT(*) FROM dba_segments
WHERE segment_name = 'DUMMY_BLOCK_FORMAT'
  AND owner = UPPER('&schema_name');
-- Expected: 0
\`\`\`

### Step 6.2 — Run RMAN Validate to Refresh V$DATABASE_BLOCK_CORRUPTION

\`V$DATABASE_BLOCK_CORRUPTION\` is not updated by SQL operations. Only RMAN validation refreshes it. Run a targeted validate on the affected datafile:

\`\`\`
RMAN> VALIDATE DATAFILE 406;
\`\`\`

For multiple affected files:

\`\`\`
RMAN> VALIDATE DATAFILE 406, 407, 412;
\`\`\`

For a specific block range (faster for targeted verification):

\`\`\`
RMAN> VALIDATE DATAFILE 406 BLOCK 4055843 TO 4056576;
\`\`\`

RMAN will re-read every block in the specified range, check header/tail consistency, and update \`V$DATABASE_BLOCK_CORRUPTION\`. The validate will report:

\`\`\`
validated datafile: file number=406 name=+DATA/EBSPRD/DATAFILE/bgn_mycims_mig_qdata.dbf
channel ORA_DISK_1: validation complete, elapsed time: 00:04:17
Finished validate at 29-JUN-2026 06:45:22
\`\`\`

If any blocks remain corrupted after the allocation pass, RMAN validate will re-populate the view with them.

### Step 6.3 — Verify V$DATABASE_BLOCK_CORRUPTION Is Clear

\`\`\`sql
-- Confirm no FRACTURED entries remain for the affected file(s)
SELECT FILE#, BLOCK#, BLOCKS, CORRUPTION_TYPE
FROM V\$DATABASE_BLOCK_CORRUPTION
WHERE FILE# IN (&affected_file_list)
ORDER BY FILE#, BLOCK#;

-- Expected: no rows for the previously corrupted file

-- Check entire database corruption view to confirm clean state
SELECT COUNT(*) AS total_corruptions,
       SUM(CASE WHEN corruption_type = 'FRACTURED' THEN 1 ELSE 0 END) AS fractured_count,
       SUM(CASE WHEN corruption_type = 'CORRUPT'   THEN 1 ELSE 0 END) AS corrupt_count,
       SUM(CASE WHEN corruption_type = 'LOGICAL'   THEN 1 ELSE 0 END) AS logical_count
FROM V\$DATABASE_BLOCK_CORRUPTION;
\`\`\`

---

## Phase 7: Post-Remediation Validation

### Step 7.1 — Full Datafile Validate (If Time Permits)

After targeted remediation, run a full validate on the datafile to confirm no additional corruption exists in other block ranges:

\`\`\`
RMAN> VALIDATE DATAFILE 406 CHECK LOGICAL;
\`\`\`

The \`CHECK LOGICAL\` flag enables Oracle's internal logical block consistency checks in addition to the physical header/tail check. This takes longer but provides comprehensive assurance.

### Step 7.2 — Take a Fresh Backup of the Affected Datafile

After clearing the corruption, take an incremental or datafile-level backup to capture the newly formatted blocks:

\`\`\`
RMAN> BACKUP DATAFILE 406;
\`\`\`

This ensures future RMAN block recovery operations have a clean baseline for the affected datafile.

### Step 7.3 — Alert Log Review

\`\`\`bash
# Scan the alert log for any ORA- errors during the allocation and drop operations
grep -E "(ORA-|FRACTURED|CORRUPT|corrupt)" \${ORACLE_BASE}/diag/rdbms/\${ORACLE_SID}/\${ORACLE_SID}/trace/alert_\${ORACLE_SID}.log \
  | tail -100
\`\`\`

Confirm no ORA-01578 (block corruption detected during read) or ORA-08102 (index key not found) errors appear — these would indicate that the corruption was not purely in free space.

---

## Monitoring Scripts

### Script 1: Corruption Classifier — Segment vs Free Space

This script runs against the current \`V$DATABASE_BLOCK_CORRUPTION\` and classifies every entry as either SEGMENT-OWNED (dangerous) or FREE-SPACE (safe), producing an actionable report. Run it after any RMAN validate to immediately triage results.

\`\`\`sql
-- corruption_classifier.sql
-- Run as SYS or DBA immediately after RMAN VALIDATE DATABASE
-- Classifies each V$DATABASE_BLOCK_CORRUPTION entry by segment ownership

SET LINESIZE 160 PAGESIZE 50
COLUMN file_name      FORMAT A50
COLUMN tablespace     FORMAT A30
COLUMN ownership      FORMAT A15
COLUMN segment_info   FORMAT A50
COLUMN action         FORMAT A35

SELECT
  c.file#,
  c.block#,
  c.blocks                                           AS corrupt_blocks,
  c.corruption_type,
  df.name                                            AS file_name,
  ts.name                                            AS tablespace,
  CASE
    WHEN e.segment_name IS NOT NULL
    THEN 'SEGMENT-OWNED'
    WHEN f.block_id    IS NOT NULL
    THEN 'FREE-SPACE'
    ELSE 'UNRESOLVED'
  END                                                AS ownership,
  CASE
    WHEN e.segment_name IS NOT NULL
    THEN e.owner || '.' || e.segment_name || ' (' || e.segment_type || ')'
    WHEN f.block_id IS NOT NULL
    THEN 'Unallocated free space'
    ELSE 'Check recyclebin or transitional state'
  END                                                AS segment_info,
  CASE
    WHEN e.segment_name IS NOT NULL
    THEN 'RMAN block recovery required'
    WHEN f.block_id IS NOT NULL
    THEN 'Use dummy allocation runbook'
    ELSE 'Investigate manually'
  END                                                AS action
FROM V\$DATABASE_BLOCK_CORRUPTION c
JOIN V\$DATAFILE df ON c.file# = df.file#
JOIN V\$TABLESPACE ts ON df.ts# = ts.ts#
LEFT JOIN dba_extents e
  ON  e.file_id = c.file#
  AND c.block#  BETWEEN e.block_id AND e.block_id + e.blocks - 1
LEFT JOIN dba_free_space f
  ON  f.file_id = c.file#
  AND c.block#  BETWEEN f.block_id AND f.block_id + f.blocks - 1
ORDER BY
  CASE WHEN e.segment_name IS NOT NULL THEN 1
       WHEN f.block_id IS NOT NULL THEN 2
       ELSE 3 END,
  c.file#, c.block#;
\`\`\`

### Script 2: Automated Free-Block Corruption Monitor

A shell script that runs the corruption classifier daily, compares against known-safe free-block entries, and only pages the DBA team when segment-owned corruption is detected. Eliminates alert fatigue from benign free-block fractured entries.

\`\`\`bash
#!/bin/bash
# oracle_corruption_monitor.sh
# Daily corruption scan that distinguishes dangerous segment-level corruption
# from benign free-space fractured blocks. Sends email only for SEGMENT-OWNED corruption.
#
# Schedule: 0 5 * * * /opt/oracle/scripts/oracle_corruption_monitor.sh

ORACLE_SID=EBSPRD
ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
PATH=\${ORACLE_HOME}/bin:\${PATH}
RECIPIENT_LIST="dba-team@example.com"
ALERT_RECIPIENT="dba-oncall@example.com"
LOG=/var/log/oracle_corruption_monitor.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
HOST=\$(hostname -s)

export ORACLE_SID ORACLE_HOME PATH

log() { echo "[\${TIMESTAMP}] \$*" >> "\${LOG}"; }

# ── Query corruption view and classify entries ─────────────────────────────────
RESULT=\$(sqlplus -s / as sysdba <<'ENDSQL'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF VERIFY OFF LINESIZE 200
SELECT c.file# || '|' || c.block# || '|' || c.blocks || '|' || c.corruption_type || '|' ||
  CASE
    WHEN e.segment_name IS NOT NULL THEN 'SEGMENT:' || e.owner || '.' || e.segment_name
    WHEN f.block_id IS NOT NULL     THEN 'FREE'
    ELSE 'UNKNOWN'
  END
FROM V\$DATABASE_BLOCK_CORRUPTION c
LEFT JOIN dba_extents e
  ON e.file_id = c.file# AND c.block# BETWEEN e.block_id AND e.block_id + e.blocks - 1
LEFT JOIN dba_free_space f
  ON f.file_id = c.file# AND c.block# BETWEEN f.block_id AND f.block_id + f.blocks - 1
ORDER BY c.file#, c.block#;
ENDSQL
)

TOTAL=0
SEGMENT_CORRUPT=0
FREE_CORRUPT=0
SEGMENT_DETAILS=""
FREE_DETAILS=""

while IFS='|' read -r file blk blks ctype ownership; do
  [ -z "\${file}" ] && continue
  TOTAL=\$((TOTAL + 1))
  if [[ "\${ownership}" == SEGMENT:* ]]; then
    SEGMENT_CORRUPT=\$((SEGMENT_CORRUPT + 1))
    SEGMENT_DETAILS="\${SEGMENT_DETAILS}  FILE# \${file} BLOCK \${blk} (\${blks} blocks) TYPE=\${ctype} OWNER=\${ownership}\n"
  elif [[ "\${ownership}" == "FREE" ]]; then
    FREE_CORRUPT=\$((FREE_CORRUPT + 1))
    FREE_DETAILS="\${FREE_DETAILS}  FILE# \${file} BLOCK \${blk} (\${blks} blocks) TYPE=\${ctype} — free space, use dummy allocation runbook\n"
  fi
done <<< "\${RESULT}"

log "Corruption scan: total=\${TOTAL} segment=\${SEGMENT_CORRUPT} free=\${FREE_CORRUPT}"

# ── Alert on SEGMENT-OWNED corruption (genuine emergency) ─────────────────────
if [ "\${SEGMENT_CORRUPT}" -gt 0 ]; then
  SUBJECT="[CRITICAL] \${HOST}: \${SEGMENT_CORRUPT} SEGMENT-LEVEL block corruption(s) — immediate action required"
  BODY="ORACLE BLOCK CORRUPTION ALERT — \${HOST}
Instance: \${ORACLE_SID}
Timestamp: \${TIMESTAMP}

CRITICAL: \${SEGMENT_CORRUPT} corruption(s) in ACTIVE SEGMENTS — user data is at risk.
These require RMAN block media recovery or Oracle Support engagement.

AFFECTED SEGMENTS:
\$(printf '%b' "\${SEGMENT_DETAILS}")
"
  if [ "\${FREE_CORRUPT}" -gt 0 ]; then
    BODY="\${BODY}
INFO: \${FREE_CORRUPT} additional corruption(s) in FREE SPACE — no data risk, see runbook.
\$(printf '%b' "\${FREE_DETAILS}")"
  fi

  printf "From: oracle-monitor@%s\nTo: %s\nSubject: %s\n\n%s\n" \
    "\$(hostname -f)" "\${ALERT_RECIPIENT}" "\${SUBJECT}" "\${BODY}" \
    | /usr/sbin/sendmail -t -oi

  log "CRITICAL alert sent: \${SEGMENT_CORRUPT} segment-level corruption(s)"
  exit 2
fi

# ── Notify on FREE-SPACE corruption (low priority) ────────────────────────────
if [ "\${FREE_CORRUPT}" -gt 0 ]; then
  SUBJECT="[INFO] \${HOST}: \${FREE_CORRUPT} free-space block corruption(s) — non-urgent, use runbook"
  BODY="ORACLE BLOCK CORRUPTION — FREE SPACE ONLY — \${HOST}
Instance: \${ORACLE_SID}
Timestamp: \${TIMESTAMP}

INFO: \${FREE_CORRUPT} FRACTURED block range(s) in unallocated free space.
No user data is affected. Use the dummy allocation runbook to clear.

DETAILS:
\$(printf '%b' "\${FREE_DETAILS}")

Runbook: https://appsdba.vercel.app/blog/oracle-fractured-free-block-corruption-runbook"

  printf "From: oracle-monitor@%s\nTo: %s\nSubject: %s\n\n%s\n" \
    "\$(hostname -f)" "\${RECIPIENT_LIST}" "\${SUBJECT}" "\${BODY}" \
    | /usr/sbin/sendmail -t -oi

  log "INFO notification sent: \${FREE_CORRUPT} free-space corruption(s)"
  exit 1
fi

log "No corruption detected — database clean"
exit 0
\`\`\`

### Script 3: Post-Remediation Verification Report

Run immediately after dropping the dummy table and completing the RMAN validate cycle. Produces a clean-state certificate confirming no corruption remains.

\`\`\`sql
-- post_remediation_report.sql
-- Run as SYS after RMAN VALIDATE completes following dummy allocation cleanup

SET LINESIZE 120 PAGESIZE 60

PROMPT ============================================================
PROMPT Post-Remediation Block Corruption Verification Report
PROMPT ============================================================
PROMPT

PROMPT Database identity:
SELECT name, db_unique_name, open_mode, log_mode
FROM V\$DATABASE;

PROMPT
PROMPT V\$DATABASE_BLOCK_CORRUPTION — current state (all entries):
SELECT file#, block#, blocks, corruption_type
FROM V\$DATABASE_BLOCK_CORRUPTION
ORDER BY file#, block#;

PROMPT
PROMPT If no rows returned above, database has no known block corruption.
PROMPT

PROMPT Affected datafile(s) current status:
SELECT file#,
       name,
       status,
       checkpoint_change#,
       TO_CHAR(checkpoint_time, 'YYYY-MM-DD HH24:MI:SS') AS checkpoint_time
FROM V\$DATAFILE
WHERE file# IN (&affected_file_list)
ORDER BY file#;

PROMPT
PROMPT Last RMAN validate completion for affected file(s):
SELECT INPUT_TYPE,
       STATUS,
       TO_CHAR(START_TIME, 'YYYY-MM-DD HH24:MI:SS') AS start_time,
       TO_CHAR(END_TIME,   'YYYY-MM-DD HH24:MI:SS') AS end_time,
       TIME_TAKEN_DISPLAY
FROM V\$RMAN_BACKUP_JOB_DETAILS
WHERE INPUT_TYPE IN ('DB FULL', 'DATAFILE FULL')
  AND START_TIME > SYSDATE - 1
ORDER BY START_TIME DESC
FETCH FIRST 5 ROWS ONLY;
\`\`\`

---

## Quick Reference

### Triage Decision Tree

\`\`\`
V$DATABASE_BLOCK_CORRUPTION has FRACTURED entries?
│
├── Run DBA_EXTENTS check for each corrupted block range
│   │
│   ├── DBA_EXTENTS returns rows? → SEGMENT-OWNED corruption
│   │   └── Use RMAN BLOCKRECOVER or contact Oracle Support
│   │
│   └── DBA_EXTENTS returns no rows?
│       │
│       └── Run DBA_FREE_SPACE check
│           │
│           ├── DBA_FREE_SPACE returns rows? → FREE SPACE corruption
│           │   └── Use this runbook (dummy allocation)
│           │
│           └── Neither returns rows? → Check recyclebin, then UNKNOWN state
│               └── Investigate manually before proceeding
\`\`\`

### Key Commands Quick Reference

\`\`\`sql
-- Identify corruption
SELECT file#, block#, blocks, corruption_type FROM V\$DATABASE_BLOCK_CORRUPTION;

-- Map file# to name and tablespace
SELECT file#, name, ts# FROM V\$DATAFILE WHERE file# = 406;
SELECT tablespace_name FROM dba_data_files WHERE file_id = 406;

-- Confirm free space ownership
SELECT segment_name, owner FROM dba_extents
  WHERE file_id=406 AND 4055843 BETWEEN block_id AND block_id+blocks-1;

-- Confirm in free pool
SELECT block_id, blocks FROM dba_free_space
  WHERE file_id=406 AND 4055843 BETWEEN block_id AND block_id+blocks-1;

-- Remediation (small free space)
CREATE TABLE admin.dummy_block_format (id NUMBER, pad CHAR(2000)) TABLESPACE ts_name;
BEGIN FOR i IN 1..100000 LOOP INSERT INTO admin.dummy_block_format VALUES(i,'A');
  IF MOD(i,1000)=0 THEN COMMIT; END IF; END LOOP; COMMIT; END; /

-- Remediation (large free space)
ALTER TABLE admin.dummy_block_format
  ALLOCATE EXTENT (DATAFILE '/path/to/file.dbf' SIZE 10G);

-- Cleanup
DROP TABLE admin.dummy_block_format PURGE;
\`\`\`

\`\`\`
-- RMAN commands
RMAN> VALIDATE DATAFILE 406;
RMAN> VALIDATE DATAFILE 406 BLOCK 4055843 TO 4056576;
RMAN> VALIDATE DATAFILE 406 CHECK LOGICAL;
RMAN> BACKUP DATAFILE 406;
\`\`\`

---

## Summary

This runbook resolves a specific, non-dangerous form of Oracle block corruption: \`FRACTURED\` entries in \`V$DATABASE_BLOCK_CORRUPTION\` that belong to unallocated free space inside a tablespace. The scenario arises when backup tools skip free blocks (by design), leaving no historical clean image for RMAN block recovery to use — creating a Catch-22 where corruption is reported but standard recovery refuses to act.

The remediation exploits Oracle's block formatter: by allocating a dummy segment over the corrupted free space, Oracle rewrites both the block header and tail with a consistent SCN, eliminating the fractured state unconditionally. For small free spaces, row insertion drives allocation naturally. For large free spaces (tens or hundreds of GB), \`ALTER TABLE ... ALLOCATE EXTENT (DATAFILE '...' SIZE nG)\` sweeps directly through the affected region in minutes rather than hours.

The critical gate before any remediation is the triage sequence: \`DBA_EXTENTS\` must return no rows for the corrupted block range, and \`DBA_FREE_SPACE\` must confirm the blocks are in the free pool. Skipping this triage on a block range that genuinely belongs to an active segment would attempt to overwrite live user data — an outcome far worse than the original corruption.

After remediation, \`RMAN VALIDATE DATAFILE\` refreshes \`V$DATABASE_BLOCK_CORRUPTION\`, and a fresh datafile-level backup captures the newly formatted blocks. The corruption classifier monitoring script distinguishes segment-owned from free-space corruption on each validation run, ensuring the DBA team receives a CRITICAL page only for genuine emergencies and an informational notification for benign free-block events.`,
};

async function main() {
  console.log('Inserting fractured free block runbook...');
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
