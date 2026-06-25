import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle RMAN Backup and Recovery: Architecture, Backup Strategy, and What Every DBA Must Know',
  slug: 'oracle-rman-backup-recovery-guide',
  excerpt:
    'A technical deep-dive into Oracle RMAN — how backup sets and image copies differ, why incremental backups require a Level 0 base, block change tracking and why it matters for large databases, the recovery catalog versus no-catalog trade-offs, retention policy design, the recovery scenarios most likely to occur in production, and the configuration decisions that determine whether a recovery completes in minutes or hours.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-24'),
  youtubeUrl: null,
  content: `## Overview

Oracle Recovery Manager (RMAN) is the standard backup and recovery tool for Oracle Database. It has been the Oracle-recommended utility since Oracle 8i and, as of Oracle 12c, is the only tool that supports all backup and recovery scenarios for a multitenant (CDB/PDB) database. Understanding how RMAN works architecturally — not just the commands to run — is the difference between a DBA who executes a backup strategy and a DBA who can design one and recover from any failure mode.

This post covers the RMAN architecture, the two backup format types and when each is appropriate, the incremental backup strategy and its dependency on block change tracking, the recovery catalog versus no-catalog decision, retention policy design, the key recovery scenarios, and the configuration decisions that have the largest impact on backup performance and recoverability.

---

## RMAN Architecture

RMAN is a client application that connects to the target database and coordinates backup and recovery operations through the Oracle server processes. The key components:

**Target Database**: the database being backed up or recovered. RMAN connects to it as SYSDBA or SYSBACKUP and uses internal Oracle mechanisms to read datafile blocks, manage archive logs, and write backup metadata.

**RMAN Executable**: the client binary (\`$ORACLE_HOME/bin/rman\`). It sends commands to the target database through a dedicated server process, which coordinates the actual I/O. The RMAN executable itself does not read or write backup files — the server processes on the database host do.

**Channels**: server processes on the database host that perform the actual backup and restore I/O. RMAN allocates one server process per channel. Multiple channels allow parallel backup and restore. Channels write to either disk (DEVICE TYPE DISK) or a media management library (DEVICE TYPE SBT) for tape.

**Recovery Catalog** (optional): a separate Oracle schema in a separate database that stores RMAN metadata — the backup history, datafile history, archived log history, and stored scripts. Without a catalog, RMAN stores this metadata in the target database control file only.

**Media Management Layer** (optional): for tape backups, a third-party library (Oracle Secure Backup, Veritas NetBackup, Commvault) that RMAN uses through the SBT (System Backup to Tape) interface. Disk backups do not require an MML.

---

## Backup Formats: Backup Sets vs Image Copies

RMAN produces backup output in one of two formats, and the choice matters for both storage efficiency and recovery time.

### Backup Sets

A backup set is RMAN's proprietary format. It contains only the used blocks from the datafile (blocks that have never been written are skipped), and it stores them in a compressed internal format. A backup set consists of one or more **backup pieces** — the actual files written to disk or tape.

Key characteristics:
- **Space-efficient**: a backup set for a 500 GB datafile that is only 200 GB full will be approximately 200 GB (plus overhead), not 500 GB
- **Supports compression**: binary compression can reduce size by 60–80% for typical OLTP data (requires Advanced Compression licence for MEDIUM/HIGH algorithms; BASIC compression is free)
- **Supports encryption**: backup sets can be AES encrypted for data-at-rest protection
- **Restore requires RMAN**: backup set files cannot be read or copied directly to a datafile location — RMAN must be used to restore them

### Image Copies

An image copy is a bit-for-bit copy of the datafile, identical in structure to the original. Image copies are created with the \`BACKUP AS COPY\` syntax or the \`COPY DATAFILE\` command.

Key characteristics:
- **Full size**: an image copy of a 500 GB datafile is 500 GB, regardless of how much data it contains
- **Instant recovery**: an image copy can be used directly as the current datafile by switching Oracle to use it (\`SWITCH DATAFILE TO COPY\`), then recovered in place — no restore step required
- **No RMAN required to copy**: image copies can be managed with OS tools once created
- **Foundation for fast incremental recovery**: the incremental-merge strategy (roll forward an image copy with Level 1 incrementals) provides a rolling up-to-date copy of the database that can be recovered with minimal redo application

---

## Incremental Backups: Level 0 and Level 1

Incremental backups are the most misunderstood aspect of RMAN for DBAs coming from other backup tools. RMAN's incremental levels are not "changes since the last backup" in the conventional sense — the level number defines which backups can serve as the base.

**Level 0**: a full backup of all used blocks in the database. It is the base for all subsequent incremental backups. A Level 0 is equivalent to a full database backup in terms of content, but it registers as the incremental base. A plain \`BACKUP DATABASE\` (no incremental keyword) is NOT an incremental base — it cannot serve as the parent for Level 1 incrementals.

**Level 1 Differential** (default): backs up all blocks changed since the most recent Level 0 or Level 1 backup — whichever is more recent. This minimises backup size but can produce a recovery chain that requires applying multiple Level 1 incrementals in sequence.

**Level 1 Cumulative**: backs up all blocks changed since the most recent Level 0 only. Larger than a differential but simpler to recover — only ever one Level 1 cumulative needs to be applied on top of the Level 0.

A typical production incremental strategy:
\`\`\`
Sunday:    Level 0 (full incremental base)
Monday-Saturday: Level 1 Differential or Cumulative
\`\`\`

Recovery from this strategy:
- Restore the Level 0
- Apply the most recent Level 1 (differential: may need multiple if Mon+Tue+Wed chained; cumulative: only the most recent)
- Apply archive logs from the Level 1's SCN to the desired recovery point

---

## Block Change Tracking

Block change tracking (BCT) is a database feature that maintains a bitmap of changed blocks since the last RMAN incremental backup. Without BCT, RMAN's Level 1 incremental must scan every block in every datafile to determine which ones changed — for a multi-terabyte database, this scan can take as long as a full backup.

With BCT enabled, RMAN reads only the changed blocks identified in the BCT file. Incremental backup time for a large database drops from hours (full scan) to minutes (BCT-driven changed block extraction).

BCT is almost always worth enabling for production databases over 100 GB where incremental backups are used:

\`\`\`sql
ALTER DATABASE ENABLE BLOCK CHANGE TRACKING
  USING FILE '/u01/fast_recovery_area/ORCL/bct.dbf';
\`\`\`

The BCT file grows proportionally with database size — approximately 1/30,000th of the total datafile size. A 1 TB database needs approximately 35 MB for the BCT file. The file must reside on a filesystem accessible to all RAC nodes.

---

## The Fast Recovery Area

The Fast Recovery Area (FRA) is an Oracle-managed disk location that stores backup-related files: RMAN backup pieces, image copies, archived redo logs, flashback logs, and control file autobackups. It is configured with two parameters:

\`\`\`sql
DB_RECOVERY_FILE_DEST     = '/u01/fast_recovery_area'
DB_RECOVERY_FILE_DEST_SIZE = 200G
\`\`\`

Oracle automatically manages space within the FRA according to the retention policy — obsolete backups are eligible for deletion to make room for new ones. When the FRA fills, Oracle raises ORA-19809 and stops archiving (archivelog mode) or backup operations, which can cause the database to hang if the archive log destination is also the FRA.

The FRA size must accommodate: the most recent backup + all archive logs since that backup + any flashback logs if Flashback Database is enabled. A common sizing mistake is setting the FRA to the database size but forgetting that archive log generation between backups can equal or exceed that size during high-DML periods.

---

## Recovery Catalog: When It Is and Is Not Required

The RMAN recovery catalog is a schema in a separate Oracle database that stores the complete backup history for one or more target databases. The alternative is storing RMAN metadata only in the target database's control file.

**Without a catalog**: RMAN metadata is stored in the control file. The control file has a fixed circular buffer — backup records older than CONTROL_FILE_RECORD_KEEP_TIME (default 7 days) are overwritten. This means: if you need to restore a backup from 30 days ago and the control file has been cycling for 30 days, RMAN cannot find the backup metadata. You must manually catalog the old backup files before RMAN can use them.

**With a catalog**: full backup history is preserved indefinitely. Cross-target reporting (showing backup status for all databases from one catalog) is possible. Stored scripts (reusable RMAN command sequences) are supported. Required for Oracle Data Guard environments when managing standby database backups from the primary.

**Recovery catalog is required for**:
- Retention periods longer than CONTROL_FILE_RECORD_KEEP_TIME
- RMAN stored scripts shared across DBA team members
- Multi-database environments where centralised backup reporting is needed
- Oracle Active Data Guard with offloaded backups (backups taken on standby, registered in catalog, used to recover the primary)

**Recovery catalog is NOT required for** a single database with a short retention period where the DBA can always catalog backup files manually if needed.

---

## Retention Policy Design

The retention policy tells RMAN which backups are obsolete and eligible for deletion. Two policy types:

### Recovery Window

\`CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS;\`

A backup is obsolete when restoring it and recovering forward to the present would require archive logs older than 7 days. This means: at any moment, there must be a backup from which the database can be recovered to the current time using 7 days' worth of archive logs. The most intuitive policy for production databases.

### Redundancy

\`CONFIGURE RETENTION POLICY TO REDUNDANCY 2;\`

RMAN keeps at least 2 copies of every datafile backup. Simpler to reason about but less directly tied to RPO.

**Sizing the retention period**: the retention window must be shorter than the archive log retention period. If archive logs are deleted after 3 days (e.g., the FRA cycles them) but the RMAN retention window is 7 days, a restore from 5 days ago will fail — the backup exists but the archive logs needed to recover it do not.

---

## Key Recovery Scenarios

### Complete Database Recovery

The most common scenario: media failure causes all or many datafiles to become inaccessible. The database is restored from backup and all available archive logs are applied to bring it current.

Key characteristics:
- Database must be mounted (not open) for a complete datafile restore
- RMAN automatically determines which backup to use based on the target SCN
- No data loss if all archive logs are available through the moment of failure

### Incomplete Recovery (Point-in-Time)

Used when the database must be rolled back to a specific time, SCN, or log sequence — typically after a logical error (accidental DROP TABLE, runaway DML, application bug).

- Requires the \`RESETLOGS\` option when opening — this creates a new incarnation of the database
- All standby databases (if any) must be rebuilt after RESETLOGS
- Flashback Database is often faster than RMAN incomplete recovery for recent point-in-time recovery (hours rather than days), if Flashback logging was enabled

### Single Datafile Recovery

One datafile is lost or corrupted while the rest of the database remains online. Oracle can keep the database open during the restore and recovery of a non-SYSTEM datafile by taking only the affected tablespace offline.

Recovery of a SYSTEM or UNDO datafile requires the database to be in MOUNT state.

### Block Media Recovery (BMR)

RMAN can recover individual corrupt data blocks without taking the datafile offline. BMR is the fastest recovery option for block corruption — the datafile remains online and accessible during recovery; only the specific corrupt blocks are restored from backup and recovered.

\`RECOVER CORRUPTION LIST;\` after a \`VALIDATE DATABASE\` or \`BACKUP VALIDATE CHECK LOGICAL DATABASE;\` triggers BMR for all detected corrupt blocks.

### Control File Recovery

If all control files are lost (without a multiplexed copy available), the control file must be restored from the RMAN autobackup. With \`CONFIGURE CONTROLFILE AUTOBACKUP ON\`, RMAN writes a control file backup after every backup and after any structural change. The autobackup format (\`%F\`) encodes the DBID, allowing RMAN to find it without a catalog, even before the database is mounted.

---

## Backup Optimisation and Compression

**Backup Optimisation** (\`CONFIGURE BACKUP OPTIMIZATION ON\`): RMAN skips backing up a file that has not changed since the last backup if a usable copy already exists within the retention window. Primarily relevant for read-only tablespaces and offline datafiles — avoids redundantly backing up unchanged files.

**Compression**:
- \`BASIC\`: free, no licence required, CPU-intensive, moderate compression ratio
- \`MEDIUM\`: requires Advanced Compression, better ratio than BASIC, less CPU impact than HIGH
- \`HIGH\`: maximum ratio, highest CPU, best for WAN backup or slow I/O targets

Compression is applied at the backup set level. Image copies cannot be compressed.

**Encryption**: RMAN supports AES encryption for backup sets. Two modes:
- Password-based: the backup is encrypted with a passphrase — portable between databases
- Wallet-based (Transparent Data Encryption): encryption key is managed by the Oracle wallet — more secure for automated operations, but requires the wallet to be open during restore

---

## Multitenant: CDB and PDB Backup

In a multitenant database (CDB), RMAN can back up at the CDB level (backs all PDBs) or at the PDB level:

\`\`\`
BACKUP DATABASE;                    -- backs the entire CDB including all PDBs
BACKUP PLUGGABLE DATABASE PROD_PDB; -- backs only the specified PDB
\`\`\`

PDB point-in-time recovery (PITR) restores and recovers a single PDB to a point in time without affecting other PDBs — a capability not available without the multitenant architecture.

The root container (CDB\$ROOT) cannot be backed up independently — it is always included in a \`BACKUP DATABASE\` command. The control file backup from a CDB-level backup can restore the entire CDB.

---

## Summary

RMAN is the only Oracle-supported backup and recovery tool for all database configurations and recovery scenarios. The two backup formats (backup sets for space efficiency and tape; image copies for instant recovery) serve different purposes and can be combined — image copies with incremental merge deliver the advantages of both. Block change tracking is a production necessity for any database over 100 GB using incremental backups; without it, RMAN scans every block in every datafile for each Level 1. The recovery catalog extends RMAN metadata retention beyond the control file's circular buffer and is required for multi-database environments, long retention periods, and Data Guard configurations. Retention policy design must account for archive log availability — a 7-day recovery window is meaningless if archive logs are purged after 3 days. The companion runbook provides the complete procedure for RMAN configuration, full and incremental backup schedules, all major recovery scenarios, database duplication, backup validation, and the crontab monitoring scripts that alert on missed backups and space conditions before they become outages.`,
};

async function main() {
  console.log('Inserting RMAN backup and recovery blog post...');
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
