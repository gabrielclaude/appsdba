import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle 19c: Moving AWR Data Out of SYSAUX into a Dedicated Tablespace',
  slug: 'oracle-19c-awr-tablespace-relocation',
  excerpt:
    'How to assess AWR space consumption in SYSAUX, create a dedicated AWR tablespace, move all WRM$ and WRH$ segments online, rebuild partitioned indexes, and reclaim the freed space — including monitoring queries and the most common failure modes.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-20'),
  youtubeUrl: null,
  content: `The Automatic Workload Repository stores its performance snapshots in SYSAUX by default. In databases with long retention windows, short snapshot intervals, or high workload concurrency, AWR becomes the dominant occupant of SYSAUX and can consume enough space that the tablespace fills. When SYSAUX fills, Oracle cannot write new snapshots, cannot run background maintenance jobs that depend on SYSAUX, and raises ORA-01652 errors. The DBA loses diagnostic visibility at exactly the moment it matters most.

Relocating AWR to a dedicated tablespace gives the repository its own growth budget, separates it from the other SYSAUX occupants (Scheduler, Space Advisor, SQL Tuning Advisor, Streams metadata, and others), and allows the DBA to place it on a different storage tier. This post covers the full relocation procedure for Oracle 19c.

---

## Why SYSAUX Grows

AWR growth is driven by snapshot configuration and workload volume:

| Growth driver | Effect |
|---------------|--------|
| Long retention window | Expired snapshots accumulate before the purge job removes them |
| Short snapshot interval | More rows captured per day across all WRH$ tables |
| High TOPNSQL value | Larger SQL text and execution plan capture per snapshot |
| High session concurrency | WRH$_ACTIVE_SESSION_HISTORY rows scale with active session count |
| Failed AWR purge job | MMON purge cannot run — expired snapshots never cleared |
| Missed purge during outage | Purge skips windows and catches up slowly when the database restarts |

SYSAUX has no quota concept. AWR extends its segments until the tablespace is full or the datafile MAXSIZE is reached. Because SYSAUX is shared, a runaway AWR growth event blocks every other SYSAUX-dependent feature simultaneously.

---

## Assessing Current AWR Footprint

Before creating any tablespace, measure how much space AWR occupies and how it is distributed across segments.

### Occupant-Level View

\`\`\`sql
-- All SYSAUX occupants ordered by space consumed
SELECT occupant_name,
       occupant_desc,
       ROUND(space_usage_kbytes / 1024, 1)       AS used_mb,
       ROUND(space_usage_kbytes / 1024 / 1024, 2) AS used_gb,
       move_procedure
FROM   v$sysaux_occupants
ORDER  BY space_usage_kbytes DESC;
\`\`\`

AWR appears as \`SM/AWR\`. The \`MOVE_PROCEDURE\` column for this occupant is NULL — Oracle does not provide a single documented call to relocate all AWR segments. The relocation requires moving each segment individually.

### Segment-Level Breakdown

\`\`\`sql
-- Top AWR segments by size (WRM$ = metadata, WRH$ = historical data)
SELECT segment_name,
       segment_type,
       ROUND(bytes / 1024 / 1024, 1) AS size_mb
FROM   dba_segments
WHERE  owner            = 'SYS'
  AND  tablespace_name  = 'SYSAUX'
  AND  (segment_name LIKE 'WRM$%' OR segment_name LIKE 'WRH$%')
ORDER  BY bytes DESC
FETCH FIRST 25 ROWS ONLY;
\`\`\`

\`WRH$_ACTIVE_SESSION_HISTORY\`, \`WRH$_SQL_PLAN\`, \`WRH$_SQLSTAT\`, and \`WRH$_SQLTEXT\` are typically the largest. The total across all matching rows is the minimum size for the new tablespace.

### Snapshot Configuration and Age Range

\`\`\`sql
-- Current AWR snapshot settings
SELECT retention,
       snap_interval,
       topnsql,
       dbid
FROM   dba_hist_wr_control;

-- Snapshot count and actual retention in the repository
SELECT COUNT(*)                                     AS total_snapshots,
       MIN(begin_interval_time)                     AS oldest_snapshot,
       MAX(end_interval_time)                       AS newest_snapshot,
       ROUND(MAX(end_interval_time)
             - MIN(begin_interval_time), 0)         AS days_retained
FROM   dba_hist_snapshot;
\`\`\`

The \`retention\` column is in minutes. Divide by 1440 to convert to days. If the actual days retained is significantly less than the configured retention, the purge job is running and consuming space normally. If retained days equals or exceeds configured retention and space is high, the purge job has fallen behind.

---

## Creating the Dedicated AWR Tablespace

Size the new tablespace to hold current AWR data plus growth headroom for the full retention window. A multiplier of 1.5 times the current AWR segment total is a reasonable starting point.

\`\`\`sql
-- Create the dedicated AWR tablespace
-- Adjust the datafile path and initial size for your environment
CREATE TABLESPACE awr_data
  DATAFILE '/oradata/dbname/awr_data01.dbf'
    SIZE 4G
    AUTOEXTEND ON
    NEXT 512M
    MAXSIZE UNLIMITED
  EXTENT MANAGEMENT LOCAL AUTOALLOCATE
  SEGMENT SPACE MANAGEMENT AUTO;

-- Verify creation
SELECT tablespace_name,
       status,
       extent_management,
       segment_space_management,
       bigfile
FROM   dba_tablespaces
WHERE  tablespace_name = 'AWR_DATA';
\`\`\`

Use a locally managed tablespace with automatic segment space management. AWR segments are not supported in dictionary-managed tablespaces.

If the AWR footprint is large and storage allows, placing the datafile on a separate disk or volume from SYSAUX provides additional I/O isolation.

---

## Moving AWR Tables

AWR tables in Oracle 19c can be moved using \`ALTER TABLE ... MOVE TABLESPACE ... ONLINE\`. The ONLINE clause reduces the exclusive lock window to milliseconds per block, allowing concurrent reads and writes to continue during the move. Without ONLINE, the move takes a full table-level lock for the duration of the operation.

### Generate the Move Statements

\`\`\`sql
-- Generate ALTER TABLE MOVE statements for all AWR tables in SYSAUX
SELECT 'ALTER TABLE SYS.' || segment_name ||
       ' MOVE TABLESPACE awr_data ONLINE;' AS move_ddl,
       ROUND(bytes / 1024 / 1024, 1)       AS size_mb
FROM   dba_segments
WHERE  owner            = 'SYS'
  AND  tablespace_name  = 'SYSAUX'
  AND  segment_type     = 'TABLE'
  AND  (segment_name LIKE 'WRM$%' OR segment_name LIKE 'WRH$%')
ORDER  BY bytes DESC;
\`\`\`

### Execute the Moves

Run the largest tables first so that if the window is interrupted, the most space has already been recovered. Common tables to move include:

\`\`\`sql
ALTER TABLE SYS.WRH$_ACTIVE_SESSION_HISTORY MOVE TABLESPACE awr_data ONLINE;
ALTER TABLE SYS.WRH$_SQL_PLAN               MOVE TABLESPACE awr_data ONLINE;
ALTER TABLE SYS.WRH$_SQLSTAT                MOVE TABLESPACE awr_data ONLINE;
ALTER TABLE SYS.WRH$_SQLTEXT                MOVE TABLESPACE awr_data ONLINE;
ALTER TABLE SYS.WRH$_LATCH                  MOVE TABLESPACE awr_data ONLINE;
ALTER TABLE SYS.WRH$_SYSSTAT               MOVE TABLESPACE awr_data ONLINE;
ALTER TABLE SYS.WRH$_SEG_STAT              MOVE TABLESPACE awr_data ONLINE;
ALTER TABLE SYS.WRH$_ENQUEUE_STAT         MOVE TABLESPACE awr_data ONLINE;
ALTER TABLE SYS.WRM$_SNAPSHOT              MOVE TABLESPACE awr_data ONLINE;
ALTER TABLE SYS.WRM$_DATABASE_INSTANCE     MOVE TABLESPACE awr_data ONLINE;
-- Continue for all tables returned by the generation query above
\`\`\`

Many WRH$ tables are range-partitioned by DBID and SNAP_ID. For partitioned tables, Oracle 19c supports partition-level online moves. The generator above covers non-partitioned segments; for partitioned segments use the runbook companion script which handles partition enumeration.

---

## Rebuilding AWR Indexes

After an online table move, Oracle automatically maintains the index — indexes do not go UNUSABLE when ONLINE is specified in Oracle 12.2 and later. However, for any tables moved without the ONLINE clause, indexes become UNUSABLE immediately and must be rebuilt before Oracle can use them for queries or DML.

### Check for UNUSABLE Indexes After the Move

\`\`\`sql
-- Non-partitioned indexes in UNUSABLE state
SELECT index_name, table_name, status
FROM   dba_indexes
WHERE  owner       = 'SYS'
  AND  status      = 'UNUSABLE'
  AND  (table_name LIKE 'WRM$%' OR table_name LIKE 'WRH$%');

-- Partitioned indexes with UNUSABLE partitions
SELECT ip.index_name, ip.partition_name, ip.status
FROM   dba_ind_partitions ip
JOIN   dba_indexes i
       ON i.index_name = ip.index_name AND i.owner = 'SYS'
WHERE  ip.status = 'UNUSABLE'
  AND  (i.table_name LIKE 'WRM$%' OR i.table_name LIKE 'WRH$%');
\`\`\`

### Generate Rebuild Statements

\`\`\`sql
-- Non-partitioned
SELECT 'ALTER INDEX SYS.' || index_name ||
       ' REBUILD TABLESPACE awr_data ONLINE;'
FROM   dba_indexes
WHERE  owner  = 'SYS'
  AND  status = 'UNUSABLE'
  AND  (table_name LIKE 'WRM$%' OR table_name LIKE 'WRH$%');

-- Partitioned index partitions
SELECT 'ALTER INDEX SYS.' || ip.index_name ||
       ' REBUILD PARTITION ' || ip.partition_name ||
       ' TABLESPACE awr_data ONLINE;'
FROM   dba_ind_partitions ip
JOIN   dba_indexes i ON i.index_name = ip.index_name AND i.owner = 'SYS'
WHERE  ip.status = 'UNUSABLE'
  AND  (i.table_name LIKE 'WRM$%' OR i.table_name LIKE 'WRH$%');
\`\`\`

Run all generated statements before proceeding to verification.

---

## Verification

\`\`\`sql
-- 1. Confirm all AWR segments are now in AWR_DATA
SELECT tablespace_name,
       COUNT(*)                            AS segment_count,
       ROUND(SUM(bytes) / 1024 / 1024, 1) AS total_mb
FROM   dba_segments
WHERE  owner = 'SYS'
  AND  (segment_name LIKE 'WRM$%' OR segment_name LIKE 'WRH$%')
GROUP  BY tablespace_name;

-- Expected: one row with tablespace_name = 'AWR_DATA'
-- If SYSAUX still appears, some segments were missed — re-run the generator

-- 2. Confirm no UNUSABLE indexes remain
SELECT COUNT(*) AS unusable_idx_count
FROM   dba_indexes
WHERE  owner  = 'SYS'
  AND  status = 'UNUSABLE'
  AND  (table_name LIKE 'WRM$%' OR table_name LIKE 'WRH$%');

-- Expected: 0

-- 3. Take a manual snapshot to confirm AWR can write to the new tablespace
EXEC DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT;

-- 4. Confirm the new snapshot row appeared
SELECT snap_id,
       begin_interval_time,
       end_interval_time,
       flush_elapsed
FROM   dba_hist_snapshot
ORDER  BY snap_id DESC
FETCH FIRST 3 ROWS ONLY;
\`\`\`

If step 3 raises an error, check for UNUSABLE indexes (step 2) and check SYSAUX for any remaining AWR segments (step 1) that would block the snapshot write.

---

## Reclaiming SYSAUX Space

Moving segments out of SYSAUX reduces the used space but does not shrink the datafile below its high-water mark. To reclaim allocated but now-free space:

\`\`\`sql
-- Current SYSAUX allocation vs. usage after move
SELECT d.file_name,
       ROUND(d.bytes / 1024 / 1024, 1)         AS allocated_mb,
       ROUND(SUM(s.bytes) / 1024 / 1024, 1)    AS used_mb,
       ROUND((d.bytes - SUM(s.bytes)) / 1024 / 1024, 1) AS reclaimable_mb
FROM   dba_data_files d
JOIN   dba_segments   s ON s.tablespace_name = d.tablespace_name
WHERE  d.tablespace_name = 'SYSAUX'
GROUP  BY d.file_name, d.bytes;

-- Resize the SYSAUX datafile (set target below allocated_mb, above used_mb + buffer)
-- Example: if used_mb = 3200 and you want a 20% buffer, target = ~3840
ALTER DATABASE DATAFILE '/path/to/sysaux01.dbf' RESIZE 4G;
\`\`\`

If the resize fails with ORA-03297 (file contains used data beyond requested RESIZE value), there are segments above the target resize boundary. Use the runbook segment map script to identify the highest-address segment in SYSAUX and set the resize target above it.

---

## AWR Snapshot Settings Tuning

After relocating AWR data, revisit the snapshot configuration. A dedicated tablespace with a generous MAXSIZE makes it viable to keep a longer retention window, but the DBA should set it deliberately rather than relying on defaults.

\`\`\`sql
-- Adjust retention (43200 min = 30 days) and interval (60 min)
BEGIN
  DBMS_WORKLOAD_REPOSITORY.MODIFY_SNAPSHOT_SETTINGS(
    retention => 43200,  -- minutes; 43200 = 30 days
    interval  => 60,     -- minutes between automatic snapshots
    topnsql   => 100     -- top-N SQL statements per snapshot
  );
END;
/

-- Confirm new settings
SELECT ROUND(retention / 1440, 0) AS retention_days,
       ROUND(snap_interval * 24 * 60, 0) AS interval_minutes,
       topnsql
FROM   dba_hist_wr_control;
\`\`\`

---

## Common Failures

| Failure | Root cause | Resolution |
|---------|-----------|------------|
| ORA-01652 during move | AWR_DATA tablespace too small | Add a second datafile or increase AUTOEXTEND MAXSIZE |
| ORA-01502: index unusable | Table moved without ONLINE; index not yet rebuilt | Run rebuild DDL from the index generation query |
| ORA-00054: resource busy | AWR MMON flush holds a lock on the target table | Wait one snapshot interval and retry; use ONLINE keyword |
| Snapshot fails after move | UNUSABLE index blocks INSERT into AWR table | Rebuild all UNUSABLE AWR indexes; retry CREATE_SNAPSHOT |
| SYSAUX used_mb does not drop | Purge job still holds segments via deferred drop | Wait for MMON purge cycle; check V$SYSAUX_OCCUPANTS after next purge |
| ORA-03297 on SYSAUX resize | A non-AWR segment sits above the resize boundary | Use segment map query to find the highest address; move or shrink that segment first |
| TOPNSQL capture increases space faster than expected | Workload generates large numbers of distinct SQL statements | Lower TOPNSQL or shorten retention; add space and monitor weekly |`,
};

async function main() {
  await db
    .insert(posts)
    .values(post)
    .onConflictDoUpdate({
      target: posts.slug,
      set: { title: post.title, content: post.content, excerpt: post.excerpt, updatedAt: new Date() },
    });
  console.log('Inserted:', post.slug);
}

main().catch(console.error);
