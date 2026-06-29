import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: "Clearing Fractured Free Blocks: When Oracle Block Corruption Isn't a Disaster",
  slug: 'oracle-fractured-free-block-corruption',
  excerpt:
    'Fractured block entries in V$DATABASE_BLOCK_CORRUPTION can trigger an emergency response — but when those blocks belong to unallocated free space, no user data is at risk and standard RMAN block recovery will fail by design. This post explains the Oracle block anatomy behind fractured corruption, why backup tools never captured a clean image of free blocks, the Catch-22 that leaves the corruption view permanently populated, and the dummy allocation technique that forces Oracle\'s space management layer to reformat the affected blocks and clear the corruption metadata without touching a single byte of production data.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-29'),
  youtubeUrl: null,
  content: `## Introduction

Few things trigger an immediate crisis response from a DBA team faster than the words "block corruption." The phrase conjures images of failed storage arrays, torn data structures, ORA-01578 errors cascading through an application, and an emergency phone call to Oracle Support. Discovering dozens or hundreds of entries in \`V$DATABASE_BLOCK_CORRUPTION\` on a multi-terabyte production database is enough to end a weekend.

But not all block corruption is equal. There is a specific scenario — encountered more often than most DBAs expect — where entries in \`V$DATABASE_BLOCK_CORRUPTION\` marked as \`FRACTURED\` are completely benign: the corrupted blocks belong to unallocated free space inside a tablespace. No tables, indexes, or LOBs reside on those blocks. No user data is affected. The database is entirely healthy.

The catch is that the standard fix — RMAN block recovery — will fail. Backup tools optimally skip free blocks during backup, so no clean historical image of those blocks exists to restore. The corruption view stays populated, monitoring alerts keep firing, and the problem appears unsolvable without a full datafile restore.

This post explains the Oracle block architecture that creates this scenario, why RMAN cannot fix it, and the elegant solution: forcing Oracle's own space management layer to reformat the blocks by allocating a dummy segment over the affected free space.

---

## Oracle Block Anatomy: Why Blocks Can Be Fractured

Every Oracle data block has a three-part structure: a **block header**, a **block body** (the actual row or index data), and a **block tail**. The header contains the block address, the SCN (System Change Number) at the time of the last write, and metadata about the block's contents. The tail is a checksum and a copy of the SCN from the header.

When Oracle writes a block to disk, the write is not guaranteed to be atomic at the operating system level. A block might be 8 KB or 16 KB — larger than a single disk sector. If a write is interrupted mid-block (a "partial write" or "split write"), the header may contain the new SCN while the tail still contains the old SCN from the previous write. The header and tail are now out of sync. This is the definition of a **fractured block**: the SCN or timestamp in the block header does not match the SCN or timestamp in the block tail.

Oracle's block checking routines — run during normal I/O, during RMAN backup validation, and during \`RMAN VALIDATE\` — detect the mismatch and log the block in \`V$DATABASE_BLOCK_CORRUPTION\` with \`CORRUPTION_TYPE = 'FRACTURED'\`.

### When Fractured Blocks Are Dangerous

A fractured block that belongs to an active segment — a table, index, LOB segment, undo segment — is a genuine problem. The data in that block is in an indeterminate state. Rows may be partially written. An ORA-01578 error will be thrown when a user's session attempts to read the block. Recovery from a backup is required.

### When Fractured Blocks Are Safe

A fractured block that belongs to **no segment** — a block that exists only in the tablespace's free space pool — contains no data. It was either never written to after its last format, or it was freed by a DROP or TRUNCATE operation. The fractured state reflects a partial write that occurred at some point in the block's history, but because no segment claims that block, no data structure references it. Oracle will never serve that block to a user query.

---

## Reading V$DATABASE_BLOCK_CORRUPTION

\`V$DATABASE_BLOCK_CORRUPTION\` is populated by RMAN's validation routines and is not automatically refreshed. Entries persist until RMAN re-validates the blocks and finds them clean, or until the database is restarted. The key columns:

\`\`\`sql
SELECT FILE#,
       BLOCK#,
       BLOCKS,         -- Number of contiguous corrupt blocks starting at BLOCK#
       CORRUPTION_TYPE,
       CORRUPTION_CHANGE#  -- SCN at which corruption was detected (0 for physical)
FROM V\$DATABASE_BLOCK_CORRUPTION
ORDER BY FILE#, BLOCK#;
\`\`\`

\`\`\`
FILE#   BLOCK#    BLOCKS   CORRUPTION_TYPE   CORRUPTION_CHANGE#
------  --------  -------  ----------------  ------------------
406     4055843   93       FRACTURED         0
406     4056498   78       FRACTURED         0
\`\`\`

**CORRUPTION_TYPE values**:

| Type | Meaning |
|---|---|
| FRACTURED | Header/tail SCN mismatch — partial write |
| CHECKSUM | DB_BLOCK_CHECKSUM enabled; checksum failed |
| CORRUPT | Block header marker is invalid |
| LOGICAL | Block is physically consistent but logically corrupt |
| ALL ZERO | Block contains all zeros — was never written |

\`CORRUPTION_CHANGE# = 0\` for FRACTURED and physical corruption types indicates Oracle cannot determine the SCN of the last good write — these are purely physical failures with no redo correlation.

---

## The Free Block Check: Is This Actually Safe?

Before treating fractured blocks as benign, verify that they genuinely belong to free space. Two queries confirm this.

### Query 1: Check DBA_EXTENTS

If the corrupted blocks belong to any segment — even a recycled one — \`DBA_EXTENTS\` will return a row:

\`\`\`sql
-- Replace FILE_ID and BLOCK# with values from V$DATABASE_BLOCK_CORRUPTION
SELECT segment_name, segment_type, owner, extent_id
FROM dba_extents
WHERE file_id = 406
  AND 4055843 BETWEEN block_id AND block_id + blocks - 1;

-- No rows selected → blocks are not allocated to any segment
\`\`\`

### Query 2: Check DBA_FREE_SPACE

Confirm the blocks appear in the tablespace's free space pool:

\`\`\`sql
SELECT tablespace_name, file_id, block_id, blocks, bytes / 1024 / 1024 AS mb_free
FROM dba_free_space
WHERE file_id = 406
  AND 4055843 BETWEEN block_id AND block_id + blocks - 1;

-- Should return a row showing a free extent that encompasses the corrupted blocks
\`\`\`

If both queries confirm — no segment owns the blocks and they appear in the free pool — you are in the safe scenario. The corruption is real (the blocks are genuinely fractured), but the impact is zero because no data structure references them.

---

## The Catch-22: Why RMAN Block Recovery Fails

The instinctive response to \`V$DATABASE_BLOCK_CORRUPTION\` entries is to run RMAN block recovery:

\`\`\`
RMAN> BLOCKRECOVER DATAFILE 406 BLOCK 4055843;
\`\`\`

In the free-block scenario, RMAN will typically respond with:

\`\`\`
RMAN-06026: some targets not found - aborting restore
RMAN-06023: no backup or copy of datafile 406 found to restore
\`\`\`

Or more specifically for block media recovery:

\`\`\`
RMAN-20230: block not found in recovery catalog
RMAN-06026: some targets not found - aborting restore
\`\`\`

**Why does RMAN fail?**

Oracle's backup infrastructure — whether RMAN, Rubrik, NetBackup, or any other backup product that integrates with Oracle's APIs — applies a critical optimization: **free blocks are not backed up**. When RMAN reads a datafile, it inspects each block's header. If the block has never been written to (all-zero block) or has been returned to the free pool, the backup agent skips it. This dramatically reduces backup size and time for databases with significant free space.

Because the block was in free space at the time of every backup, no historical image of that block in a clean state exists in any backup set. There is nothing to restore. RMAN cannot reconstruct a block it has never seen.

This creates the Catch-22:
- RMAN reports corruption
- RMAN cannot recover the corruption because it never backed up those blocks
- The corruption view stays populated indefinitely
- Standard monitoring alerts fire on every check

---

## The Solution: Force Oracle's Block Formatter

Oracle's database block formatter is the internal routine that writes a clean, freshly initialized block structure when a block is allocated to a segment for the first time. This routine writes both a valid header and a valid tail, with a consistent SCN — erasing whatever fractured state the block contained before allocation.

The solution exploits this behavior deliberately: create a segment in the affected tablespace and force Oracle to allocate extents over the corrupted free space. The moment Oracle's formatter writes to those blocks, it replaces the fractured header/tail pair with a consistent, clean block structure. The corruption is gone.

### Why This Works

Oracle does not check \`V$DATABASE_BLOCK_CORRUPTION\` before allocating a free block to a new segment. It simply reads the free space bitmap (ASSM) or free list, selects an available block, and formats it. The formatter does not care about the block's previous state — it overwrites the entire block structure unconditionally. After the write, the block is clean.

---

## Example 1: Single Tablespace, Small Free Space

**Scenario**: Datafile 406 belongs to tablespace \`BGN_MYCIMS_MIG_QDATA\`. Two ranges of fractured blocks are detected, totaling 171 blocks (approximately 1.3 MB at 8 KB block size). The tablespace has about 50 GB of free space.

**Approach**: Insert enough rows into a dummy table to force Oracle to allocate extents that cover the corrupted block ranges.

\`\`\`sql
-- Step 1: Confirm tablespace and create dummy table
SELECT tablespace_name FROM dba_data_files WHERE file_id = 406;
-- Result: BGN_MYCIMS_MIG_QDATA

CREATE TABLE bgn_mycims_mig.dummy_format (
    id  NUMBER,
    pad CHAR(2000)
) TABLESPACE BGN_MYCIMS_MIG_QDATA;

-- Step 2: Insert rows to force block allocations
BEGIN
    FOR i IN 1..100000 LOOP
        INSERT INTO bgn_mycims_mig.dummy_format VALUES (i, 'A');
    END LOOP;
    COMMIT;
END;
/

-- Step 3: Verify the table consumed space in the affected region
SELECT COUNT(*) FROM bgn_mycims_mig.dummy_format;

-- Step 4: Drop the dummy table to return space to free pool
DROP TABLE bgn_mycims_mig.dummy_format PURGE;
\`\`\`

After the drop, the RMAN validate step (covered in the runbook) confirms the blocks are clean.

---

## Example 2: Large Free Space — Accelerated Allocation

**Scenario**: The same tablespace has 500 GB of free space and the corrupted blocks are deep within the free pool. Inserting 100,000 rows would not reach the specific block addresses; Oracle's ASSM (Automatic Segment Space Management) allocates from the nearest available free blocks, which may be far from the corrupted range.

**Approach**: Use \`ALTER TABLE ... ALLOCATE EXTENT\` with a SIZE clause to rapidly claim large extents, forcing Oracle to traverse the entire free space pool and eventually format the corrupted blocks. This is orders of magnitude faster than row-by-row inserts for large free spaces.

\`\`\`sql
-- Create dummy table
CREATE TABLE bgn_mycims_mig.dummy_format (
    id  NUMBER,
    pad CHAR(2000)
) TABLESPACE BGN_MYCIMS_MIG_QDATA;

-- Force large extent allocations targeting the specific datafile
-- Repeat until V$DATABASE_BLOCK_CORRUPTION entries disappear
ALTER TABLE bgn_mycims_mig.dummy_format
  ALLOCATE EXTENT (DATAFILE '/path/to/datafile_406.dbf' SIZE 10G);

ALTER TABLE bgn_mycims_mig.dummy_format
  ALLOCATE EXTENT (DATAFILE '/path/to/datafile_406.dbf' SIZE 10G);

-- After each ALLOCATE EXTENT, run RMAN VALIDATE to check if corruption cleared
-- (see runbook for the full RMAN validate cycle)

-- Drop when done
DROP TABLE bgn_mycims_mig.dummy_format PURGE;
\`\`\`

The \`DATAFILE\` clause in \`ALLOCATE EXTENT\` pins the allocation to the specific file, ensuring Oracle formats blocks within datafile 406 rather than in a different member of the tablespace.

---

## Example 3: Multiple Corruption Ranges Across the Same File

**Scenario**: Several non-contiguous fractured ranges exist across datafile 406. Instead of running separate \`BLOCKRECOVER\` commands (which would all fail), a single allocation pass covers all ranges simultaneously because Oracle's extent allocation sweeps through the available free space in the file contiguously.

\`\`\`sql
-- All corruption ranges in file 406
SELECT block#, blocks, corruption_type
FROM v\$database_block_corruption
WHERE file# = 406
ORDER BY block#;

-- Result: 6 separate FRACTURED ranges across 406

-- A single round of ALLOCATE EXTENT with sufficient SIZE covers all ranges
-- because Oracle allocates from the beginning of contiguous free space,
-- traversing past all fractured blocks in order

ALTER TABLE bgn_mycims_mig.dummy_format
  ALLOCATE EXTENT (DATAFILE '/path/to/datafile_406.dbf' SIZE 20G);

-- One RMAN validate pass clears all 6 ranges simultaneously
\`\`\`

---

## Prevention and Future Avoidance

Fractured blocks in free space almost always originate from one of two scenarios:

**Scenario A: Backup during active formatting**
A storage-layer snapshot or a backup job reads a block at the exact moment Oracle is mid-write, formatting it for allocation to a new segment. The snapshot captures the fractured intermediate state. On restore or validation, RMAN detects the mismatch.

**Prevention**: Configure RMAN's \`DB_BLOCK_CHECKING\` and ensure all backups go through Oracle's backup APIs (RMAN, Oracle-integrated backup agents) rather than raw filesystem snapshots taken without putting the database in backup mode. Oracle-integrated backups use the block re-read retry mechanism — if a block's header and tail do not match on the first read, Oracle re-reads the block before declaring it fractured.

**Scenario B: Restore of a backup that skipped free blocks**
A full database restore is performed from a backup set where free blocks were skipped. The restored datafile contains the fractured blocks from the original database. RMAN validation after restore detects them.

**Prevention**: After any full restore, run \`RMAN VALIDATE DATABASE\` to identify and immediately remediate free-space fractured blocks before handing the database to users.

### Proactive Validation Schedule

\`\`\`
RMAN> VALIDATE DATABASE CHECK LOGICAL;
\`\`\`

Run monthly. This populates \`V$DATABASE_BLOCK_CORRUPTION\` with a current view of all corruption. Cross-referencing immediately with \`DBA_EXTENTS\` after each run catches free-block fractured entries early, before they accumulate across multiple backup cycles and obscure genuine corruption events.

---

## Summary

Block corruption marked as \`FRACTURED\` in \`V$DATABASE_BLOCK_CORRUPTION\` is not always a database emergency. When the corrupted blocks belong to unallocated free space — confirmed by the absence of any matching row in \`DBA_EXTENTS\` and the presence of a corresponding row in \`DBA_FREE_SPACE\` — no user data is at risk. The database is healthy.

Standard RMAN block recovery will fail in this scenario because backup tools optimize performance by skipping free blocks. No clean historical image of those blocks exists in any backup set, so RMAN has nothing to restore.

The correct remediation is to force Oracle's block formatter to overwrite the fractured blocks by allocating a dummy segment over the affected free space. Whether the free space is small (insert rows to fill it) or large (use \`ALTER TABLE ... ALLOCATE EXTENT\` with a \`DATAFILE\` clause and a large \`SIZE\` to sweep through it rapidly), the effect is the same: Oracle's formatter overwrites both the block header and tail with a consistent SCN, eliminating the fractured state. The dummy table is then dropped, returning space to the free pool, and an RMAN validate pass confirms the entries are cleared from \`V$DATABASE_BLOCK_CORRUPTION\`.

The companion runbook covers the complete diagnostic and remediation sequence with the exact SQL and RMAN commands, the decision logic for choosing between row insertion and direct extent allocation, and monitoring scripts that distinguish dangerous segment-level corruption from benign free-block fractured entries.`,
};

async function main() {
  console.log('Inserting fractured free block blog post...');
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
