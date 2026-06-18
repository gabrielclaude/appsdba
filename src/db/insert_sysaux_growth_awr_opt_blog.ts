import { config } from 'dotenv';
config({ path: '.env.local' });
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

async function main() {
  const post = {
    title: 'Oracle SYSAUX Tablespace Runaway Growth: AWR and Optimizer Stats Cleanup',
    slug: 'oracle-sysaux-tablespace-growth-awr-optimizer-stats-reclaim',
    excerpt:
      'A real-world case study of SYSAUX growing to 221 GB on Oracle 11gR2 — unchecked AWR snapshot retention and runaway optimizer statistics history (WRI\$_OPTSTAT tables) were the culprits. Covers the full resolution: disabling AWR, rebuilding the AWR repository, purging optimizer stats, the ORA-01502 index dependency trap, high watermark reclamation, and the 110 GB that came back to disk.',
    category: 'oracle-database' as const,
    isPremium: false,
    published: true,
    publishedAt: new Date('2026-06-18'),
    content: `SYSAUX is Oracle's auxiliary system tablespace, introduced in Oracle 10g to consolidate the growing family of Oracle-owned components that had previously crowded SYSTEM. It holds Automatic Workload Repository (AWR) snapshots, Active Session History (ASH), optimizer statistics history, SQL Tuning Advisor findings, SQL Plan Management baselines, XML DB metadata, and more. In a healthy database, SYSAUX stays manageable — typically a few gigabytes to a few tens of gigabytes. When it reaches 200 GB on a single-instance 11gR2 database, something has gone wrong at the operational level, and the fix requires more than just adding datafiles.

This post walks through a real case: SYSAUX growing to 221 GB on Oracle 11gR2 on Oracle Linux 7.9, the root causes, the resolution sequence, the ORA-01502 index dependency trap that almost derailed the cleanup, and how 110 GB was reclaimed back to disk.

---

## What SYSAUX Stores and Why It Grows

SYSAUX is mandatory and managed exclusively by Oracle. You cannot place user objects there, and you cannot move most of its occupants to another tablespace. The two dominant occupants in most production databases are:

- **SM/AWR** — the Automatic Workload Repository. AWR stores time-series snapshots of database performance statistics: wait events, SQL execution statistics, segment activity, ASH samples, and much more. Every snapshot row lands in \`WRH\$_*\` tables owned by SYS. With default settings (hourly snapshots, 8-day retention), this is manageable. With years of unchecked retention or a very high snapshot frequency, it becomes the single largest consumer in SYSAUX.

- **SM/OPT** — the optimizer statistics history. Every time \`DBMS_STATS\` gathers statistics on a table or index, the previous generation of statistics is saved into \`WRI\$_OPTSTAT_*\` tables in SYSAUX. The default retention is 31 days. On a database with thousands of tables and nightly statistics collection, this means 31 generations of full statistics data sitting in SYSAUX indefinitely.

Both occupants are entirely normal. The problem arises when their retention policies go unreviewed and space is never reclaimed.

---

## The AWR Snapshot Retention Problem

AWR retention is controlled by \`DBMS_WORKLOAD_REPOSITORY.MODIFY_SNAPSHOT_SETTINGS\`. The defaults — 60-minute snapshot interval, 10,080-minute (7-day) retention — are conservative. But on a database that has been running for years without maintenance, the retention setting may have been changed, never set at all, or simply left at a non-default value by a long-departed DBA.

To check current settings:

\`\`\`sql
SELECT snap_interval, retention FROM dba_hist_wr_control;
SELECT COUNT(*) FROM dba_hist_snapshot;
SELECT MIN(begin_interval_time), MAX(end_interval_time) FROM dba_hist_snapshot;
\`\`\`

In this case, the retention had been set to an extended period at some point in the past, and the AWR tables — particularly \`WRI\$_OPTSTAT_*\` — had grown without bound. The \`V\$SYSAUX_OCCUPANTS\` view reported SM/OPT consuming over 225 GB, virtually all of it in the \`WRI\$_OPTSTAT\` family of tables.

The important distinction: **SM/AWR** stores snapshot data in \`WRH\$_*\` tables. **SM/OPT** stores optimizer statistics history in \`WRI\$_OPTSTAT_*\` tables. Both live in SYSAUX, but they have separate retention controls and separate purge mechanisms.

---

## Why Adding Datafiles Is a Trap

When SYSAUX fills up, the immediate symptom is AWR snapshot failures in the alert log — \`ORA-1688\` or \`ORA-1652\` when Oracle cannot extend a segment. The natural DBA response is to add a datafile to relieve the pressure, and this is correct as an emergency measure. But it masks the underlying problem entirely.

The database continues filling. The retention policies that caused the growth are still in place. The new datafile buys time, but the next alert arrives sooner because the base is now larger. Each added datafile pushes the high watermark higher, which creates a second problem: even after you purge the data, the high watermark does not automatically drop. Oracle will not return extents to the operating system just because the rows are gone. The segment must be explicitly shrunk or moved before the tablespace can be resized and disk space reclaimed.

In this case, multiple datafiles had been added over time, bringing the total allocated size to 221 GB. After purging the root cause data, only about 110 GB could be reclaimed — the rest was locked in the high watermark of segments that had never been shrunk.

---

## The Resolution Sequence

### Step 1: Disable AWR Snapshots

Before doing anything destructive, disable AWR snapshot collection so no new data lands while you are working:

\`\`\`sql
EXEC DBMS_WORKLOAD_REPOSITORY.MODIFY_SNAPSHOT_SETTINGS(interval => 0);
\`\`\`

Setting the interval to zero disables new snapshots without deleting existing data.

### Step 2: Identify the Dominant Occupant

\`\`\`sql
SELECT occupant_name, ROUND(space_usage_kbytes / 1048576, 2) AS space_gb
FROM v\$sysaux_occupants
ORDER BY space_usage_kbytes DESC;
\`\`\`

In this case, SM/OPT returned 225 GB. The \`WRI\$_OPTSTAT_*\` tables were the primary target.

### Step 3: Restart in RESTRICT Mode

For an AWR repository rebuild, Oracle requires the database to be started in RESTRICT mode. This prevents non-DBA users from connecting during the maintenance window:

\`\`\`sql
SHUTDOWN IMMEDIATE;
STARTUP RESTRICT;
\`\`\`

### Step 4: Rebuild the AWR Repository

The cleanest approach for severely bloated AWR data is to drop and recreate the entire AWR repository using the scripts Oracle ships in \`\$ORACLE_HOME/rdbms/admin\`:

\`\`\`sql
@\$ORACLE_HOME/rdbms/admin/catnoawr.sql
PURGE DBA_RECYCLEBIN;
@\$ORACLE_HOME/rdbms/admin/catawrtb.sql
@\$ORACLE_HOME/rdbms/admin/utlrp.sql
\`\`\`

\`catnoawr.sql\` drops all AWR objects. \`PURGE DBA_RECYCLEBIN\` ensures nothing lingers in the recyclebin that could confuse the next step. \`catawrtb.sql\` recreates the AWR schema from scratch. \`utlrp.sql\` recompiles any invalid objects left after the rebuild.

This is the nuclear option, and it destroys all historical AWR data. For a database where the AWR data is unreliable or worthless (as was the case here after years of unchecked growth), this is the right call.

### Step 5: Purge Optimizer Statistics History

After the AWR rebuild, the optimizer statistics history remained as the dominant consumer. Purge all of it:

\`\`\`sql
EXEC DBMS_STATS.PURGE_STATS(DBMS_STATS.PURGE_ALL);
\`\`\`

\`DBMS_STATS.PURGE_ALL\` is a constant that instructs Oracle to delete all statistics history regardless of age. This call can take tens of minutes on a large database with a heavily populated \`WRI\$_OPTSTAT_*\` table family.

For a less aggressive approach that keeps recent history:

\`\`\`sql
EXEC DBMS_STATS.PURGE_STATS(SYSDATE - 10);
\`\`\`

This purges statistics older than 10 days and is appropriate for a targeted cleanup rather than a full reset.

### Step 6: Shrink the WRI\$_OPTSTAT Tables

Purging the rows does not move the high watermark. After the purge, the \`WRI\$_OPTSTAT_*\` segments still occupy the same number of extents — the blocks are now empty but not returned to the tablespace. To reclaim that space, each table must be moved or shrunk:

\`\`\`sql
-- Enable row movement, then shrink
ALTER TABLE SYS.WRI\$_OPTSTAT_TAB_HISTORY     ENABLE ROW MOVEMENT;
ALTER TABLE SYS.WRI\$_OPTSTAT_TAB_HISTORY     SHRINK SPACE CASCADE;

ALTER TABLE SYS.WRI\$_OPTSTAT_IND_HISTORY     ENABLE ROW MOVEMENT;
ALTER TABLE SYS.WRI\$_OPTSTAT_IND_HISTORY     SHRINK SPACE CASCADE;

ALTER TABLE SYS.WRI\$_OPTSTAT_HISTGRM_HISTORY ENABLE ROW MOVEMENT;
ALTER TABLE SYS.WRI\$_OPTSTAT_HISTGRM_HISTORY SHRINK SPACE CASCADE;

ALTER TABLE SYS.WRI\$_OPTSTAT_HISTHEAD_HISTORY ENABLE ROW MOVEMENT;
ALTER TABLE SYS.WRI\$_OPTSTAT_HISTHEAD_HISTORY SHRINK SPACE CASCADE;

-- Disable row movement after shrink
ALTER TABLE SYS.WRI\$_OPTSTAT_TAB_HISTORY     DISABLE ROW MOVEMENT;
ALTER TABLE SYS.WRI\$_OPTSTAT_IND_HISTORY     DISABLE ROW MOVEMENT;
ALTER TABLE SYS.WRI\$_OPTSTAT_HISTGRM_HISTORY DISABLE ROW MOVEMENT;
ALTER TABLE SYS.WRI\$_OPTSTAT_HISTHEAD_HISTORY DISABLE ROW MOVEMENT;
\`\`\`

\`SHRINK SPACE CASCADE\` shrinks the table and all of its dependent indexes in a single operation. It is an online operation — it does not lock the table for DML — but it does require \`ROW MOVEMENT\` to be enabled because Oracle physically relocates rows during the compaction.

---

## The ORA-01502 Cascade Failure

This is where the cleanup hit an unexpected blocker. After shrinking the tables and attempting to rebuild the invalid indexes in SYSAUX, several \`ALTER INDEX ... REBUILD\` commands failed with:

\`\`\`
ORA-01502: index 'SYS.I_WRI\$_OPTSTAT_IND_OBJ#_ST' or partition of such index is in unusable state
\`\`\`

The error is misleading because it surfaces when rebuilding a *different* index — not the one named in the error. Oracle's index rebuild mechanism checks certain dependent indexes during the rebuild process, and if a parent or prerequisite index is unusable, the rebuild of the dependent index fails with this ORA-01502 referencing the blocking index.

The fix is straightforward but non-obvious: **you must rebuild \`I_WRI\$_OPTSTAT_IND_OBJ#_ST\` before any other SYSAUX index**. This is the parent index that other dependent indexes rely on during the rebuild path. Once it is valid, the other rebuilds proceed without error:

\`\`\`sql
-- Rebuild the blocking index FIRST
ALTER INDEX SYS.I_WRI\$_OPTSTAT_IND_OBJ#_ST REBUILD ONLINE;

-- Then rebuild all remaining invalid SYSAUX indexes
SELECT 'ALTER INDEX '||owner||'.'||index_name||' REBUILD;' AS cmd
FROM dba_indexes
WHERE tablespace_name = 'SYSAUX'
  AND status <> 'VALID'
ORDER BY owner, index_name;
\`\`\`

Run the generated DDL from the second query after confirming \`I_WRI\$_OPTSTAT_IND_OBJ#_ST\` is back to VALID status. The pattern of one unusable index blocking all others is a known behavior in Oracle 11g and 12c when optimizer statistics tables are heavily modified.

---

## High Watermark and Disk Space Reclamation

After shrinking and rebuilding indexes, the tablespace free space picture improved significantly — but the datafiles themselves still allocated 221 GB to the OS. The free space was inside the tablespace (available for new extents), but the datafiles had not been resized. Oracle cannot automatically shrink a datafile beyond the highest extent boundary currently in use.

To return disk space to the OS, two steps are needed:

**Step 1: Move remaining large segments below the high watermark.**

Generate a move script for any segments still near the top of the datafiles:

\`\`\`sql
SELECT 'ALTER TABLE '||owner||'.'||segment_name||' MOVE TABLESPACE SYSAUX;' AS cmd
FROM dba_segments
WHERE tablespace_name = 'SYSAUX'
  AND segment_type = 'TABLE'
  AND bytes > 1048576
ORDER BY bytes DESC;
\`\`\`

\`MOVE\` rebuilds the segment from scratch into newly allocated extents at the bottom of the tablespace, freeing the high-watermark blocks. Unlike \`SHRINK SPACE\`, \`MOVE\` invalidates all indexes on the table — rebuild them immediately after moving each table.

**Step 2: Resize the datafiles.**

Find the lowest safe resize point for each datafile:

\`\`\`sql
SELECT file_id,
       file_name,
       ROUND(bytes / 1073741824, 1) AS current_gb,
       ROUND(MAX(block_id + blocks - 1) * 8192 / 1073741824 + 0.5, 1) AS min_safe_gb
FROM dba_data_files df
JOIN dba_extents e ON e.file_id = df.file_id
WHERE df.tablespace_name = 'SYSAUX'
GROUP BY file_id, file_name, bytes
ORDER BY file_id;
\`\`\`

Then resize each file to its safe minimum plus a comfortable buffer:

\`\`\`sql
ALTER DATABASE DATAFILE '/path/to/sysaux01.dbf' RESIZE 8G;
ALTER DATABASE DATAFILE '/path/to/sysaux02.dbf' RESIZE 4G;
\`\`\`

In this case, the combination of purge, shrink, move, and resize operations returned approximately 110 GB to disk from a starting point of 221 GB. The residual ~111 GB reflects the space needed for a healthy AWR history at the correct retention setting plus room for normal growth.

---

## Restoring AWR and Setting Correct Retention

After reclamation, re-enable AWR with a sane retention policy. For most production databases, 30 days of AWR history is sufficient for performance trending:

\`\`\`sql
-- Re-enable AWR: 60-minute interval, 30-day retention (43200 minutes)
EXEC DBMS_WORKLOAD_REPOSITORY.MODIFY_SNAPSHOT_SETTINGS(interval => 60, retention => 43200);

-- Verify
SELECT snap_interval, retention FROM dba_hist_wr_control;
\`\`\`

Also set a reasonable optimizer statistics history retention — 14 days is enough for most environments to support statistics restore if a plan regression occurs:

\`\`\`sql
BEGIN DBMS_STATS.ALTER_STATS_HISTORY_RETENTION(14); END;
/
\`\`\`

---

## What to Monitor Going Forward

The cleanup is only durable if the monitoring that would have caught this problem earlier is now in place. At a minimum:

- **Check \`V\$SYSAUX_OCCUPANTS\` monthly.** A single query gives the complete space picture by occupant. Set up an alert when any occupant grows by more than 10% month-over-month.

- **Monitor SYSAUX tablespace usage directly.** Alert at 75% used so you have time to react before hitting 90%.

- **Confirm AWR retention is set correctly after any patching.** Some Oracle patches and upgrades can reset AWR retention to default values. Always verify \`DBA_HIST_WR_CONTROL\` after patching.

- **Verify optimizer statistics history retention after database recreation or clone.** Clones frequently inherit the source database's statistics history but with the source's retention policy, which may not be appropriate for the clone's lifecycle.

- **Do not add datafiles as the first response to SYSAUX growth.** Identify the occupant, understand why it grew, purge the data, then resize. Adding datafiles without purging guarantees the problem returns on a larger scale.

---

The premium runbook for this post covers every step in detail with exact SQL commands, the shell diagnostic script that generates shrink and rebuild DDL automatically, and the complete phase-by-phase procedure for a controlled maintenance window.`,
  };

  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: {
      title: post.title,
      content: post.content,
      excerpt: post.excerpt,
      updatedAt: new Date(),
    },
  });
  console.log('Inserted:', post.slug);
}

main().catch(console.error);
