import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'rman-backup-oracle-data-guard-standby';

const content = `
One of the most underused capabilities in Oracle Data Guard environments is the ability to run RMAN backups entirely from the physical standby database, with those backups used to recover the primary. Offloading backups to the standby eliminates backup I/O from the primary host, reduces impact on production workloads, and provides a meaningful use for standby hardware that otherwise spends most of its time replaying redo. The mechanism is not intuitive — the backup runs on the standby, but RMAN registers it as a backup of the primary — and getting it right requires understanding how RMAN distinguishes the two databases, how the recovery catalog connects them, and where the common failure points are.

This post covers the RMAN Data Guard architecture, recovery catalog requirements, persistent configuration for standby backups, archive log management in a standby environment, the complete backup scripts, restoring a primary from a standby backup, block change tracking on standby, and the version-specific differences that affect what is and is not possible in 11g, 12c, and 19c.

---

## How RMAN Identifies Primary and Standby

RMAN uses the \`DB_UNIQUE_NAME\` parameter to distinguish databases that share the same \`DBID\`. A primary and its physical standby have the same DBID — they are the same database — but different \`DB_UNIQUE_NAME\` values. The typical convention is \`PRODDB\` for the primary and \`PRODDB_STB\` for the standby.

When RMAN connects to the standby and takes a backup, the backup metadata is recorded under the primary's DBID in the recovery catalog. RMAN knows the backup was taken from standby storage, but it is registered as valid for recovering the primary. This is the fundamental property that makes standby backups usable for primary recovery.

Without a recovery catalog, RMAN must store backup metadata in the target database's control file. In a Data Guard environment, the standby's control file is a replica of the primary's, but metadata written during a standby backup session may not survive a switchover or failover without a catalog. For this reason, **a recovery catalog is required for production-grade standby backup offload**. Running standby backups without a catalog is possible but significantly limits recoverability and is not recommended.

---

## Recovery Catalog Setup for Data Guard

The recovery catalog must be registered with both the primary and standby databases.

### Register both databases

\`\`\`bash
# Connect to primary and register
rman target sys@PRODDB catalog rman_owner@CATALOG
\`\`\`

\`\`\`text
REGISTER DATABASE;
RESYNC CATALOG;
\`\`\`

\`\`\`bash
# Connect to standby and register (same DBID, different DB_UNIQUE_NAME)
rman target sys@PRODDB_STB catalog rman_owner@CATALOG
\`\`\`

\`\`\`text
REGISTER DATABASE;
RESYNC CATALOG;
\`\`\`

After both registrations, the catalog contains two entries under the same DBID — one for each \`DB_UNIQUE_NAME\`. RMAN queries this relationship when determining whether a backup taken from the standby can satisfy a restore request for the primary.

### Verify both are registered

\`\`\`sql
-- Run in the recovery catalog schema
SELECT db_unique_name,
       dbid,
       db_key,
       curr_dbinc_key,
       TO_CHAR(resetlogs_time, 'YYYY-MM-DD HH24:MI:SS') AS resetlogs
FROM   rc_database
WHERE  dbid = <your_dbid>
ORDER  BY db_unique_name;
\`\`\`

Both \`PRODDB\` and \`PRODDB_STB\` should appear with the same DBID and the same \`resetlogs_time\`.

---

## RMAN Configuration for Data Guard

RMAN persistent configuration in a Data Guard environment can be set per-database using the \`FOR DB_UNIQUE_NAME\` clause. This allows different channel settings, backup locations, and deletion policies for primary and standby without one overwriting the other.

### Connect to catalog and configure per-database settings

\`\`\`bash
rman catalog rman_owner@CATALOG
\`\`\`

\`\`\`text
-- Configuration that applies to primary
CONFIGURE DEFAULT DEVICE TYPE TO DISK FOR DB_UNIQUE_NAME PRODDB;
CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 14 DAYS FOR DB_UNIQUE_NAME PRODDB;
CONFIGURE BACKUP OPTIMIZATION ON FOR DB_UNIQUE_NAME PRODDB;
CONFIGURE CONTROLFILE AUTOBACKUP ON FOR DB_UNIQUE_NAME PRODDB;
CONFIGURE CONTROLFILE AUTOBACKUP FORMAT
  FOR DEVICE TYPE DISK
  TO '/backup/PRODDB/cf_%F'
  FOR DB_UNIQUE_NAME PRODDB;

-- Configuration that applies to standby (where backups actually run)
CONFIGURE DEFAULT DEVICE TYPE TO DISK FOR DB_UNIQUE_NAME PRODDB_STB;
CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 14 DAYS FOR DB_UNIQUE_NAME PRODDB_STB;
CONFIGURE BACKUP OPTIMIZATION ON FOR DB_UNIQUE_NAME PRODDB_STB;
CONFIGURE CONTROLFILE AUTOBACKUP ON FOR DB_UNIQUE_NAME PRODDB_STB;
CONFIGURE CONTROLFILE AUTOBACKUP FORMAT
  FOR DEVICE TYPE DISK
  TO '/backup/PRODDB/cf_%F'
  FOR DB_UNIQUE_NAME PRODDB_STB;

-- Archive log deletion policy: do not delete until backed up from standby
CONFIGURE ARCHIVELOG DELETION POLICY
  TO APPLIED ON ALL STANDBY
  FOR DB_UNIQUE_NAME PRODDB;
\`\`\`

The \`ARCHIVELOG DELETION POLICY TO APPLIED ON ALL STANDBY\` setting on the primary instructs RMAN (and the FRA management in Oracle) not to delete archive logs from the primary until they have been shipped to and applied on all registered standby databases. This prevents archive gap — the standby falling behind because the primary deleted logs it still needed — while still allowing the primary FRA to be managed automatically.

### Verify configuration per database

\`\`\`text
-- Show standby-specific configuration
SHOW ALL FOR DB_UNIQUE_NAME PRODDB_STB;

-- Show primary-specific configuration
SHOW ALL FOR DB_UNIQUE_NAME PRODDB;
\`\`\`

---

## Archive Log Management in a Standby Environment

Archive logs in a Data Guard environment flow from primary to standby through the log shipping mechanism. The standby receives and applies them, and they exist on both the primary (in the primary FRA) and the standby (in the standby FRA or archive log destination).

### Archive log status on standby

\`\`\`sql
-- Run on the standby instance
SELECT thread#,
       sequence#,
       applied,
       status,
       TO_CHAR(completion_time, 'YYYY-MM-DD HH24:MI:SS') AS completed
FROM   v\$archived_log
WHERE  standby_dest = 'NO'
ORDER  BY thread#, sequence# DESC
FETCH FIRST 30 ROWS ONLY;
\`\`\`

The \`APPLIED\` column shows whether MRP has applied the log. Logs with \`APPLIED = YES\` are candidates for backup from the standby. Logs with \`APPLIED = NO\` but present on disk can also be backed up — they are available even if not yet applied.

### Check for archive gap on the standby

\`\`\`sql
-- Run on the standby
SELECT thread#,
       low_sequence#,
       high_sequence#
FROM   v\$archive_gap;
\`\`\`

If this query returns rows, the standby has a gap — it is missing archive logs between \`LOW_SEQUENCE#\` and \`HIGH_SEQUENCE#\` for that thread. A backup taken from the standby at this point will not contain those gap sequences. Before relying on standby-only backups for primary recovery, ensure the gap is resolved.

\`\`\`sql
-- Also check MRP status
SELECT process,
       status,
       thread#,
       sequence#,
       block#
FROM   v\$managed_standby
WHERE  process IN ('MRP0','RFS')
ORDER  BY process;
\`\`\`

\`MRP0\` should show \`APPLYING_LOG\` or \`WAIT_FOR_LOG\`. If it shows \`ERROR\` or is absent, MRP is not running and archive log application has stopped.

---

## Block Change Tracking on Standby

Block change tracking (BCT) records which blocks have been changed since the last backup, allowing Level 1 incremental backups to skip unchanged blocks without scanning the entire datafile. In Oracle 11g, BCT can only be enabled on the primary database — standby-based incremental backups must scan all blocks.

From Oracle 12c onward, BCT can be enabled on the physical standby, allowing incremental backups from standby to benefit from the change tracking file:

\`\`\`sql
-- Oracle 12c+ only — run on the standby as sysdba
ALTER DATABASE ENABLE BLOCK CHANGE TRACKING
  USING FILE '/u01/oracle/bct/PRODDB_STB_bct.dbf';
\`\`\`

Confirm it is active:

\`\`\`sql
SELECT status,
       filename,
       bytes / 1024 / 1024 AS size_mb
FROM   v\$block_change_tracking;
\`\`\`

Expected: \`STATUS = ENABLED\`. Once enabled, the next Level 0 incremental from standby establishes the BCT baseline, and subsequent Level 1 backups will be tracked incrementals rather than full-scan incrementals.

In Oracle 11g on standby (no BCT support), incremental backups from standby still produce valid results — they just scan all blocks each time. Level 0 followed by archive log backups is the more practical strategy for 11g standby environments.

---

## Connecting to the Standby for Backup

RMAN connects to the standby using the \`TARGET\` keyword, just as it would connect to the primary. The standby must be in MOUNT or READ ONLY state — \`BACKUP DATABASE\` does not require the standby to be open for read-write.

\`\`\`bash
# Connect to standby with catalog
rman target sys@PRODDB_STB catalog rman_owner@CATALOG
\`\`\`

Verify the connection sees the standby's role:

\`\`\`text
RMAN> SELECT db_unique_name, database_role FROM v\$database;
\`\`\`

Expected:

\`\`\`
DB_UNIQUE_NAME    DATABASE_ROLE
----------------- ----------------
PRODDB_STB        PHYSICAL STANDBY
\`\`\`

---

## Complete Backup Scripts for Standby

All backup scripts below run with RMAN connected to the standby. The backup pieces are registered in the catalog as valid for the primary DBID.

### Weekly Level 0 from standby

\`\`\`text
RUN {
  ALLOCATE CHANNEL c1 DEVICE TYPE DISK MAXPIECESIZE 64G;
  ALLOCATE CHANNEL c2 DEVICE TYPE DISK MAXPIECESIZE 64G;
  ALLOCATE CHANNEL c3 DEVICE TYPE DISK MAXPIECESIZE 64G;
  ALLOCATE CHANNEL c4 DEVICE TYPE DISK MAXPIECESIZE 64G;

  -- Back up the standby database (registered as primary backup in catalog)
  BACKUP AS COMPRESSED BACKUPSET
    INCREMENTAL LEVEL 0
    DATABASE
    FORMAT '/backup/PRODDB/%d_STB_L0_%T_%U.bkp'
    TAG 'STB_WEEKLY_L0';

  -- Back up archive logs present on standby (all threads)
  BACKUP AS COMPRESSED BACKUPSET
    ARCHIVELOG ALL
    NOT BACKED UP 1 TIMES
    FORMAT '/backup/PRODDB/%d_STB_arch_%T_%s_%p.bkp'
    TAG 'STB_ARCH_L0'
    DELETE INPUT;

  -- Back up the standby control file
  BACKUP CURRENT CONTROLFILE FOR STANDBY
    FORMAT '/backup/PRODDB/%d_STB_ctl_%T_%U.bkp'
    TAG 'STB_CTL_L0';

  -- Back up the SPFILE
  BACKUP SPFILE
    FORMAT '/backup/PRODDB/%d_STB_spf_%T_%U.bkp'
    TAG 'STB_SPF_L0';

  RESYNC CATALOG;
}
\`\`\`

The \`BACKUP CURRENT CONTROLFILE FOR STANDBY\` clause creates a control file backup that can be used to create a new standby or restore this standby's control file. To back up a control file usable for restoring the primary, use \`BACKUP CURRENT CONTROLFILE\` (without FOR STANDBY) — this works correctly from a standby connection in 12c and 19c; in 11g it requires the catalog to resolve correctly.

### Daily Level 1 from standby

\`\`\`text
RUN {
  ALLOCATE CHANNEL c1 DEVICE TYPE DISK MAXPIECESIZE 32G;
  ALLOCATE CHANNEL c2 DEVICE TYPE DISK MAXPIECESIZE 32G;
  ALLOCATE CHANNEL c3 DEVICE TYPE DISK MAXPIECESIZE 32G;
  ALLOCATE CHANNEL c4 DEVICE TYPE DISK MAXPIECESIZE 32G;

  BACKUP AS COMPRESSED BACKUPSET
    INCREMENTAL LEVEL 1
    DATABASE
    FORMAT '/backup/PRODDB/%d_STB_L1_%T_%U.bkp'
    TAG 'STB_DAILY_L1';

  BACKUP AS COMPRESSED BACKUPSET
    ARCHIVELOG ALL
    NOT BACKED UP 1 TIMES
    FORMAT '/backup/PRODDB/%d_STB_arch_%T_%s_%p.bkp'
    TAG 'STB_ARCH_L1'
    DELETE INPUT;

  BACKUP CURRENT CONTROLFILE FOR STANDBY
    FORMAT '/backup/PRODDB/%d_STB_ctl_%T_%U.bkp'
    TAG 'STB_CTL_L1';

  RESYNC CATALOG;
}
\`\`\`

### Frequent archive log backup from standby (every 2 hours)

\`\`\`text
RUN {
  ALLOCATE CHANNEL c1 DEVICE TYPE DISK MAXPIECESIZE 16G;
  ALLOCATE CHANNEL c2 DEVICE TYPE DISK MAXPIECESIZE 16G;

  BACKUP AS COMPRESSED BACKUPSET
    ARCHIVELOG ALL
    NOT BACKED UP 1 TIMES
    FORMAT '/backup/PRODDB/%d_STB_arch_%T_%s_%t_%p.bkp'
    TAG 'STB_ARCH_FREQ'
    DELETE INPUT;

  RESYNC CATALOG;
}
\`\`\`

---

## Verifying Standby Backups Are Usable for Primary Recovery

After running a standby backup, confirm the catalog has registered the backup against the primary:

\`\`\`bash
# Connect to catalog directly
rman catalog rman_owner@CATALOG
\`\`\`

\`\`\`text
-- List backups by database (will show backups from all registered databases)
LIST BACKUP OF DATABASE;
\`\`\`

Backups taken from the standby appear with \`DB_UNIQUE_NAME = PRODDB_STB\` but are listed under the primary's DBID and can satisfy a \`RESTORE DATABASE\` command against the primary.

\`\`\`text
-- Preview what RMAN would use to restore the primary at this moment
CONNECT TARGET sys@PRODDB;
RESTORE DATABASE PREVIEW;
\`\`\`

The \`RESTORE DATABASE PREVIEW\` command lists every backup piece and archive log RMAN would use to perform the restore, without actually restoring anything. If any backup pieces come from \`PRODDB_STB\`, the standby offload is working correctly. If the output shows no valid backup or falls back to primary-side pieces, the catalog registration may be incomplete.

---

## Restoring the Primary from a Standby Backup

When a primary database failure requires a restore, connect RMAN to the primary (or the host where the primary will be rebuilt) with the catalog:

\`\`\`bash
rman target sys@PRODDB catalog rman_owner@CATALOG
\`\`\`

The catalog resolves the backup location regardless of which database (primary or standby) produced the backup pieces. The restore procedure is identical to restoring from primary-side backups:

\`\`\`text
STARTUP MOUNT;

RUN {
  ALLOCATE CHANNEL c1 DEVICE TYPE DISK;
  ALLOCATE CHANNEL c2 DEVICE TYPE DISK;
  ALLOCATE CHANNEL c3 DEVICE TYPE DISK;
  ALLOCATE CHANNEL c4 DEVICE TYPE DISK;

  RESTORE DATABASE;
  RECOVER DATABASE;
}

ALTER DATABASE OPEN RESETLOGS;
\`\`\`

If the backup pieces physically reside on the standby server's filesystem (not a shared NFS or tape), RMAN will attempt to read them over the network using the channel connection. This works when the Oracle Net configuration allows the primary-side RMAN process to reach the standby-side backup files. In practice, most environments use a shared backup filesystem (NAS, SAN, or object storage) accessible from both primary and standby hosts, which makes the backup pieces available without any cross-host data transfer.

### Point-in-time recovery from standby backup

\`\`\`text
RUN {
  ALLOCATE CHANNEL c1 DEVICE TYPE DISK;
  ALLOCATE CHANNEL c2 DEVICE TYPE DISK;

  SET UNTIL TIME "TO_DATE('2026-07-14 22:00:00','YYYY-MM-DD HH24:MI:SS')";

  RESTORE DATABASE;
  RECOVER DATABASE;
}

ALTER DATABASE OPEN RESETLOGS;
\`\`\`

For PITR to succeed, archive logs covering all threads from the Level 0 SCN to the target time must be in the catalog — whether backed up from the primary or the standby. If the standby was behind at the time of the backup (archive gap), logs for the gap period must come from primary-side backups.

---

## Version-Specific Behaviour

### Oracle 11g (11.2.0.x)

- Recovery catalog is mandatory for standby backup offload. Without it, RMAN cannot cross-reference standby backup pieces with the primary.
- Block change tracking is not supported on the standby. All Level 1 incrementals from standby scan the full datafile.
- \`CONFIGURE ... FOR DB_UNIQUE_NAME\` is available in 11.2.0.2+.
- \`BACKUP DATABASE\` from the standby works but requires the standby to be in MOUNT state (not READ ONLY WITH APPLY) on some patchsets — test before relying on it.
- \`DUPLICATE TARGET DATABASE FOR STANDBY FROM ACTIVE DATABASE\` is available and is the recommended method for creating a new standby in 11g.

### Oracle 12c (12.1 and 12.2)

- Block change tracking is supported on the physical standby — enables true incremental backups from standby with block-level tracking.
- \`RECOVER ... NOREDO\` can be used after restoring incremental backups to roll forward the standby without applying archived redo, significantly reducing recovery time for large databases.
- The catalog requirement is relaxed in 12.2 — RMAN can use the control file to track cross-database backups in simple single-standby configurations, though the catalog remains strongly recommended.
- Active Data Guard (standby open READ ONLY) is supported during backup in 12c — backups can run while users query the standby.

### Oracle 19c

- All 12c features apply.
- \`BACKUP DATABASE\` on Active Data Guard (READ ONLY WITH APPLY) standby is fully supported and is the standard configuration.
- In 19c with multitenant (CDB/PDB), \`BACKUP DATABASE\` from the standby backs up all PDBs in the CDB. Individual PDB backup from standby requires connecting to the root container.
- \`SECTION SIZE\` for parallel datafile-level backup is supported from standby.

---

## Monitoring Standby Backups

### Backup job history filtered to standby

\`\`\`sql
-- Run in the recovery catalog schema, or from RMAN LIST commands
-- From RMAN connected to catalog:
\`\`\`

\`\`\`text
LIST BACKUP SUMMARY;
\`\`\`

\`\`\`sql
-- From the catalog database directly
SELECT b.db_unique_name,
       j.input_type,
       j.status,
       ROUND(j.input_bytes  / 1073741824, 1) AS input_gb,
       ROUND(j.output_bytes / 1073741824, 1) AS output_gb,
       ROUND((j.end_time - j.start_time) * 24 * 60, 0) AS duration_min,
       TO_CHAR(j.start_time, 'YYYY-MM-DD HH24:MI:SS')  AS started
FROM   rc_rman_backup_job_details j
JOIN   rc_database b ON j.db_key = b.db_key
WHERE  b.db_unique_name = 'PRODDB_STB'
AND    j.start_time >= SYSDATE - 7
ORDER  BY j.start_time DESC;
\`\`\`

### Standby apply lag vs backup currency

If the standby has significant apply lag, the archive logs backed up from the standby may not include the most recent sequences. Check the apply lag and compare against the last archive log sequence backed up:

\`\`\`sql
-- Run on the standby
SELECT name,
       value,
       datum_time
FROM   v\$dataguard_stats
WHERE  name IN ('apply lag','transport lag')
ORDER  BY name;
\`\`\`

\`\`\`sql
-- Most recent archive log sequence backed up per thread (standby)
SELECT b.thread#,
       MAX(b.sequence#)  AS last_backed_seq,
       TO_CHAR(MAX(b.completion_time), 'YYYY-MM-DD HH24:MI:SS') AS last_backed_at
FROM   v\$backup_archivelog_details b
WHERE  b.completion_time >= SYSDATE - 1
GROUP  BY b.thread#
ORDER  BY b.thread#;
\`\`\`

\`\`\`sql
-- Current applied sequence on the standby
SELECT thread#,
       sequence#,
       applied
FROM   v\$archived_log
WHERE  applied = 'YES'
AND    standby_dest = 'NO'
ORDER  BY thread#, sequence# DESC
FETCH FIRST 4 ROWS ONLY;
\`\`\`

If the last backed-up sequence is significantly behind the last applied sequence, recent archive logs generated on the primary are not yet covered by the standby-side backup. This is expected for logs generated after the most recent archive log backup run — the 2-hour archive log backup schedule closes this window.

### FRA usage on standby

\`\`\`sql
-- Run on the standby
SELECT file_type,
       percent_space_used,
       percent_space_reclaimable,
       number_of_files
FROM   v\$recovery_area_usage
ORDER  BY percent_space_used DESC;
\`\`\`

The standby FRA accumulates archive logs received from the primary plus the backup pieces if backup pieces are written to the FRA. Monitor standby FRA space independently from the primary — they consume different disk allocations and can fill at different rates.

---

## Common Failure Points

### ORA-19815 or ORA-19809: standby FRA full

If the standby FRA fills, archive log receive from the primary stalls. Gaps form in the standby archive sequence, and the next backup from standby will be incomplete.

\`\`\`bash
# Immediate space recovery on standby
rman target sys@PRODDB_STB catalog rman_owner@CATALOG
\`\`\`

\`\`\`text
DELETE NOPROMPT ARCHIVELOG ALL COMPLETED BEFORE 'SYSDATE-3' BACKED UP 1 TIMES TO DISK;
DELETE NOPROMPT OBSOLETE;
\`\`\`

After reclaiming space, confirm MRP resumes shipping and the gap closes before the next scheduled backup.

### RMAN-06820 or catalog sync failures

If the catalog is out of sync with the standby's control file, RMAN operations may fail with metadata errors. Resync after any standby restart or role transition:

\`\`\`text
RESYNC CATALOG FROM DB_UNIQUE_NAME ALL;
\`\`\`

### Backup taken during standby gap

If a backup runs while the standby has an archive gap, the backup set will not contain the gap sequences. Verify after every backup:

\`\`\`sql
SELECT thread#, low_sequence#, high_sequence# FROM v\$archive_gap;
\`\`\`

If a gap existed during the backup window, ensure the primary still has those sequences in its FRA and run a supplemental archive log backup from the primary to fill the gap in the catalog:

\`\`\`bash
rman target sys@PRODDB catalog rman_owner@CATALOG
\`\`\`

\`\`\`text
BACKUP ARCHIVELOG FROM SEQUENCE <low_sequence> UNTIL SEQUENCE <high_sequence>
  THREAD <thread#>
  FORMAT '/backup/PRODDB/%d_PRIMARY_gap_%T_%s_%p.bkp'
  TAG 'GAP_FILL';
\`\`\`

---

## Summary

RMAN backup offload to a physical standby reduces primary I/O impact while producing backups that are fully valid for primary recovery. The mechanism relies on the recovery catalog's ability to associate standby backup pieces with the primary's DBID — without the catalog, standby backups can be taken but primary recovery from them is operationally fragile.

The persistent configuration must address both databases explicitly using \`FOR DB_UNIQUE_NAME\`. The archive log deletion policy on the primary should be set to \`APPLIED ON ALL STANDBY\` to prevent the primary from deleting logs the standby has not yet received.

Archive gap on the standby is the most common operational failure mode: a gap at backup time produces a backup set that cannot satisfy recovery to any point after the gap without supplemental primary-side archive log backups. Monitoring \`V\$ARCHIVE_GAP\` and comparing the most recently backed-up archive log sequence against the most recently applied sequence catches this condition before it becomes a recovery problem.

In 12c and 19c, block change tracking on the standby enables true incremental backups that skip unchanged blocks, reducing both backup time and backup storage for Level 1 runs. In 11g, incremental backups from standby are full-scan incrementals — effective but slower than primary-side BCT-enabled incrementals on large databases.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'RMAN Backup from Oracle Data Guard Physical Standby',
    slug,
    excerpt: 'Running RMAN backups from a physical standby offloads backup I/O from the production primary, but requires understanding how RMAN uses DB_UNIQUE_NAME to associate standby backup pieces with the primary DBID, why a recovery catalog is mandatory for production standby backup offload, how archive gap on the standby produces silently incomplete backup sets, and what changes between 11g, 12c, and 19c for block change tracking and Active Data Guard backup support.',
    content,
    category: 'disaster-recovery',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
