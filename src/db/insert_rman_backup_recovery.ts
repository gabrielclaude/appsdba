import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const blogPost = {
  title: 'Oracle RMAN Backup and Recovery: Architecture, Strategy, and Best Practices',
  slug: 'oracle-rman-backup-recovery',
  excerpt:
    'A comprehensive guide to Oracle RMAN — covering backup types, channels, the recovery catalog, incremental backup strategy, and the recovery scenarios every DBA needs to know before they need them.',
  category: 'oracle-database' as const,
  published: true,
  publishedAt: new Date('2026-06-03'),
  isPremium: false,
  youtubeUrl: null,
  content: `RMAN (Recovery Manager) is Oracle's built-in backup and recovery tool. It ships with every edition of Oracle Database and is the supported, recommended path for all backup and recovery operations. User-managed backups using OS commands are still documented but are rarely used in practice — RMAN knows the internal structure of Oracle datafiles, integrates with the control file and optional recovery catalog, and handles everything from block-level change tracking to automatic parallelism and tape streaming.

This post covers the architecture, the key decisions you need to make when designing a backup strategy, and the recovery scenarios that matter most in production.

---

## Architecture

### How RMAN Works

RMAN is a client/server application. The \`rman\` binary connects to the target database as a privileged internal user and issues server-side commands through Oracle's backup/restore infrastructure. It does not read datafiles directly from the OS — instead it instructs Oracle server processes to read blocks, perform incremental change detection, apply compression, and write to the backup destination.

\`\`\`
rman (client)
    │
    ├─ connects to TARGET (the database being backed up)
    │       MML / SBT channel → tape device / media manager
    │       DISK channel      → Fast Recovery Area or custom path
    │
    └─ connects to CATALOG (optional recovery catalog DB)
            stores backup metadata, cross-database history
\`\`\`

### Channels

A **channel** is a server process allocated by RMAN to perform I/O. Each channel maps to one output stream — one device, one file, one tape drive. Parallelism in RMAN is achieved by allocating multiple channels. With two disk channels, RMAN can write two backup pieces simultaneously.

Channels are either:
- **DISK** — writes to the filesystem or ASM
- **SBT_TAPE** (System Backup to Tape) — calls a media management library (MML) such as NetBackup, Commvault, or TSM

### Control File vs Recovery Catalog

RMAN must store its backup metadata somewhere. It has two options:

| Storage | Pros | Cons |
|---|---|---|
| **Control file** (default) | No extra setup; built in | Limited history; lost if control file is lost; no cross-database reporting |
| **Recovery catalog** | Full history; scripts; cross-database views; mandatory for some features (virtual private catalog, stored scripts) | Requires a dedicated schema in a separate database |

For any production environment backing up more than one database, a recovery catalog is strongly recommended. It is a lightweight schema — a small catalog database can serve dozens of production databases.

### Fast Recovery Area (FRA)

The **Fast Recovery Area** is a disk location managed by Oracle that automatically stores and manages:
- Archived redo logs
- RMAN backup pieces and backup sets
- Flashback logs (if Flashback Database is enabled)
- Control file and SPFILE auto-backups

Oracle ages out older files from the FRA automatically when space is needed, as long as the files are no longer required for recovery. The FRA simplifies backup management significantly — you set a size limit and a retention policy, and Oracle handles the rest.

---

## Backup Types

### Full vs Incremental

| Type | What It Contains | When to Use |
|---|---|---|
| **Full backup** | All used blocks in the datafile | Weekly baseline; standalone backups |
| **Incremental Level 0** | All used blocks (like full, but serves as incremental base) | Weekly base for incremental strategy |
| **Incremental Level 1 Differential** | Blocks changed since the most recent Level 0 or Level 1 | Daily incremental — smaller than cumulative |
| **Incremental Level 1 Cumulative** | Blocks changed since the most recent Level 0 only | Larger than differential but faster recovery (fewer pieces to apply) |

The most common production strategy is: **Level 0 on Sunday, Level 1 Differential Monday–Saturday**. Recovery applies the Level 0 and then only the most recent Level 1 — at most two backup pieces.

### Backup Sets vs Image Copies

| Format | Description | Recovery Speed |
|---|---|---|
| **Backup set** | RMAN's proprietary format; skips never-used blocks; supports compression | Slower to restore (must restore then recover) |
| **Image copy** | Block-for-block copy of the datafile; readable by OS and RMAN | Fastest recovery — switch datafile to copy instantly |

Image copies on disk combined with incremental merge (the \`RECOVER COPY\` command) give you a rolling full backup that can be activated instantly. This is called the **incrementally updated backup** strategy and is the recommended approach when disk space allows.

### Archived Log Backup

Archived redo logs are required for any recovery past the last full/incremental backup. RMAN should back up archived logs as part of every backup job, or on a separate schedule (e.g., every hour). The retention policy and \`DELETE INPUT\` flag control how long original archived logs are kept after backup.

---

## Retention Policy

The retention policy tells RMAN which backups are **obsolete** — no longer needed to meet the recovery window.

\`\`\`
CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS;
\`\`\`

This means RMAN guarantees you can recover to any point in the past 7 days. Backups outside that window are marked obsolete and can be deleted with \`DELETE OBSOLETE\`.

The alternative is \`REDUNDANCY n\` — keep at least n copies of each datafile. Simpler to reason about for tape environments.

---

## Block Change Tracking

For large databases, incremental backups can still be slow because RMAN must read every block to find which ones changed. **Block Change Tracking** solves this: a lightweight background process writes a bitmapped change tracking file that records which blocks have been modified since the last incremental. RMAN reads this file instead of scanning every block, dramatically reducing incremental backup time on large databases.

\`\`\`sql
ALTER DATABASE ENABLE BLOCK CHANGE TRACKING
  USING FILE '/u03/fra/change_tracking.ctf';
\`\`\`

On systems with 1TB+ databases, block change tracking can reduce Level 1 backup time by 80–90%.

---

## Compression

RMAN supports multiple compression algorithms:

| Algorithm | Ratio | CPU Cost | When to Use |
|---|---|---|---|
| \`BASIC\` | Moderate | Low | Default; always available |
| \`LOW\` | Lower | Very low | High-throughput environments where I/O is the bottleneck |
| \`MEDIUM\` | Good | Moderate | Balanced; recommended for most disk backups |
| \`HIGH\` | Best | High | Archival backups to tape where space matters most |

\`MEDIUM\` is the most common choice for disk-to-disk backups. Enable it globally:

\`\`\`
CONFIGURE COMPRESSION ALGORITHM 'MEDIUM' AS OF RELEASE 'DEFAULT' OPTIMIZE FOR LOAD TRUE;
CONFIGURE DEVICE TYPE DISK BACKUP TYPE TO COMPRESSED BACKUPSET;
\`\`\`

---

## Recovery Scenarios

### Complete Recovery (No Data Loss)

The database has crashed but all archived logs are available. RMAN restores the last backup and applies all archived logs up to the last SCN before the failure.

\`\`\`
RMAN> RESTORE DATABASE;
RMAN> RECOVER DATABASE;
RMAN> ALTER DATABASE OPEN;
\`\`\`

### Datafile Recovery (Single File)

A single datafile is lost or corrupted. The database stays open (for non-SYSTEM datafiles).

\`\`\`
RMAN> SQL 'ALTER DATABASE DATAFILE 7 OFFLINE';
RMAN> RESTORE DATAFILE 7;
RMAN> RECOVER DATAFILE 7;
RMAN> SQL 'ALTER DATABASE DATAFILE 7 ONLINE';
\`\`\`

### Point-in-Time Recovery (PITR)

Used after a logical error — a table was dropped, a batch job ran twice, a bad update was committed. RMAN restores to a point before the error occurred. This requires \`OPEN RESETLOGS\` which creates a new incarnation.

\`\`\`
RMAN> SHUTDOWN IMMEDIATE;
RMAN> STARTUP MOUNT;
RMAN> SET UNTIL TIME "TO_DATE('2026-06-03 14:30:00','YYYY-MM-DD HH24:MI:SS')";
RMAN> RESTORE DATABASE;
RMAN> RECOVER DATABASE;
RMAN> ALTER DATABASE OPEN RESETLOGS;
\`\`\`

After \`OPEN RESETLOGS\`, re-register the database with the recovery catalog (\`RESET DATABASE TO INCARNATION\`) and take a new Level 0 backup immediately.

### Tablespace Point-in-Time Recovery (TSPITR)

Recovers a single tablespace to a past point without affecting the rest of the database. RMAN does this using an auxiliary instance — a temporary database created internally. More complex to execute but avoids taking the whole database back in time.

### Control File Recovery

If the control file is lost and no multiplexed copies remain, RMAN can restore from the auto-backup:

\`\`\`
RMAN> STARTUP NOMOUNT;
RMAN> RESTORE CONTROLFILE FROM AUTOBACKUP;
RMAN> ALTER DATABASE MOUNT;
RMAN> RECOVER DATABASE;
RMAN> ALTER DATABASE OPEN RESETLOGS;
\`\`\`

This is why \`CONFIGURE CONTROLFILE AUTOBACKUP ON\` is non-negotiable.

---

## Best Practices

**Always enable controlfile autobackup.** The control file is needed to restore everything else. Without it, recovery becomes significantly harder.

**Test your backups regularly.** A backup that has never been restored is a guess, not a guarantee. Schedule quarterly restore tests to a non-production environment and time the recovery. Know your RTO before an outage, not during one.

**Validate before you need to recover.** Run \`BACKUP VALIDATE DATABASE\` or \`RESTORE DATABASE VALIDATE\` regularly to check for block corruption in your datafiles and in your backup pieces.

**Enable Block Change Tracking on large databases.** The performance difference for incremental backups is substantial once a database exceeds a few hundred GB.

**Use a recovery catalog for any production system.** The control file has limited history depth and is lost if the database is destroyed. A recovery catalog in a separate database survives any single-database failure.

**Back up archived logs frequently.** The gap between your last archived log backup and the time of a failure is your data loss window. For RPO under one hour, back up archived logs hourly and delete backed-up logs from disk.

**Size the FRA generously.** Undersized FRAs cause Oracle to aggressively expire archived logs before they are backed up, which creates unrecoverable gaps. A common rule: FRA = 3x database size minimum.

**Monitor for backup failures proactively.** RMAN exits with a non-zero code on failure but the output goes to a log file that nobody reads until there is a crisis. The companion runbook includes a 4-hour monitoring script that queries \`V\$RMAN_STATUS\`, \`V\$BACKUP_FILES\`, and the FRA usage to alert before failures become unrecoverable situations.
`,
};

const runbookPost = {
  title: 'Oracle RMAN Backup and Recovery Runbook',
  slug: 'oracle-rman-backup-recovery-runbook',
  excerpt:
    'Step-by-step RMAN runbook covering baseline configuration, incremental backup strategy, archived log management, block change tracking, complete and point-in-time recovery procedures, and a 4-hour monitoring script that checks backup status, validates the FRA, and alerts on failures.',
  category: 'oracle-database' as const,
  published: true,
  publishedAt: new Date('2026-06-03'),
  isPremium: true,
  youtubeUrl: null,
  content: `# Oracle RMAN Backup and Recovery Runbook

## Overview

This runbook covers RMAN baseline configuration, incremental backup strategy (Level 0 weekly / Level 1 daily), archived log management, recovery procedures, and a schedulable health check script.

**Assumptions:**
- Oracle 19c, single-instance or RAC
- Oracle user: \`oracle\`, \`ORACLE_SID=ORCL\`
- FRA: \`/u03/fra\`, FRA size: 200GB
- Backup disk: \`/u04/rman_backups\`
- Recovery catalog database at \`catalog.example.com:1521/RMANCAT\` (optional but recommended)

---

## Script 1 — RMAN Baseline Configuration

Run once after installation or when establishing a new backup strategy.

\`\`\`bash
#!/bin/bash
# rman_configure.sh  — run as oracle
set -euo pipefail
ORACLE_SID=ORCL
ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_SID ORACLE_HOME
PATH=\${ORACLE_HOME}/bin:\${PATH}
LOGFILE=/tmp/rman_configure_\$(date +%Y%m%d_%H%M%S).log
exec > >(tee -a "\${LOGFILE}") 2>&1

echo "===== RMAN Baseline Configuration ====="
echo "SID: \${ORACLE_SID}  Date: \$(date)"

rman target / <<'REOF'

-- ─── Controlfile autobackup (non-negotiable) ──────────────────────────────────
CONFIGURE CONTROLFILE AUTOBACKUP ON;
CONFIGURE CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE DISK TO '/u04/rman_backups/cf_%F';

-- ─── Channels: 2 parallel disk channels ────────────────────────────────────────
CONFIGURE DEVICE TYPE DISK PARALLELISM 2 BACKUP TYPE TO COMPRESSED BACKUPSET;
CONFIGURE DEFAULT DEVICE TYPE TO DISK;
CONFIGURE CHANNEL DEVICE TYPE DISK FORMAT '/u04/rman_backups/%d_%T_%U';

-- ─── Compression ────────────────────────────────────────────────────────────────
CONFIGURE COMPRESSION ALGORITHM 'MEDIUM' AS OF RELEASE 'DEFAULT' OPTIMIZE FOR LOAD TRUE;

-- ─── Retention: 7-day recovery window ───────────────────────────────────────────
CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS;

-- ─── Archived log deletion policy (after 2 backups to disk) ─────────────────────
CONFIGURE ARCHIVELOG DELETION POLICY TO BACKED UP 2 TIMES TO DISK;

-- ─── Backup optimization: skip unchanged files when retention is met ─────────────
CONFIGURE BACKUP OPTIMIZATION ON;

-- ─── Exclude NOARCHIVELOG temp tablespace from backups ───────────────────────────
-- CONFIGURE EXCLUDE FOR TABLESPACE TEMP;

-- ─── Show resulting configuration ───────────────────────────────────────────────
SHOW ALL;

REOF

echo "===== Configuration complete. Log: \${LOGFILE} ====="
\`\`\`

---

## Script 2 — Enable Block Change Tracking

Run after configuration on databases over 100GB.

\`\`\`bash
#!/bin/bash
# rman_enable_bct.sh  — run as oracle
ORACLE_SID=ORCL
ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_SID ORACLE_HOME
PATH=\${ORACLE_HOME}/bin:\${PATH}
BCT_FILE=/u03/fra/\${ORACLE_SID}_change_tracking.ctf

sqlplus -s / as sysdba <<SQLEOF
-- Check current BCT status
select status, filename, bytes/1048576 mb from v\$block_change_tracking;

-- Enable BCT (skip if already enabled)
declare
  v_status varchar2(20);
begin
  select status into v_status from v\$block_change_tracking;
  if v_status = 'DISABLED' then
    execute immediate 'ALTER DATABASE ENABLE BLOCK CHANGE TRACKING USING FILE ''/u03/fra/\${ORACLE_SID}_change_tracking.ctf''';
    dbms_output.put_line('Block change tracking enabled.');
  else
    dbms_output.put_line('Block change tracking already enabled: '||v_status);
  end if;
end;
/

-- Verify
select status, filename, bytes/1048576 mb from v\$block_change_tracking;
exit;
SQLEOF
\`\`\`

---

## Script 3 — Weekly Level 0 (Full Baseline) Backup

Schedule: Sunday 22:00

\`\`\`bash
#!/bin/bash
# rman_level0.sh  — weekly Level 0 backup
# Cron: 0 22 * * 0 oracle /path/to/rman_level0.sh >> /var/log/oracle/rman/level0.log 2>&1
set -euo pipefail

ORACLE_SID=ORCL
ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_SID ORACLE_HOME
PATH=\${ORACLE_HOME}/bin:\${PATH}
LOG_DIR=/var/log/oracle/rman
mkdir -p "\${LOG_DIR}"
LOGFILE=\${LOG_DIR}/level0_\$(date +%Y%m%d_%H%M%S).log
exec > >(tee -a "\${LOGFILE}") 2>&1

echo "===== RMAN Level 0 Backup: \$(date) ====="
START_TIME=\$(date +%s)

rman target / <<'REOF'

RUN {
  -- Two parallel channels
  ALLOCATE CHANNEL c1 DEVICE TYPE DISK FORMAT '/u04/rman_backups/%d_L0_%T_%U';
  ALLOCATE CHANNEL c2 DEVICE TYPE DISK FORMAT '/u04/rman_backups/%d_L0_%T_%U';

  -- Backup database (Level 0 incremental — serves as base for daily Level 1s)
  BACKUP INCREMENTAL LEVEL 0
    DATABASE
    TAG 'WEEKLY_LEVEL0'
    PLUS ARCHIVELOG
      TAG 'ARCH_WITH_LEVEL0'
      DELETE INPUT;

  -- Backup current controlfile and SPFILE explicitly
  BACKUP CURRENT CONTROLFILE TAG 'CF_WITH_LEVEL0';
  BACKUP SPFILE TAG 'SPFILE_LEVEL0';

  -- Delete obsolete backups (outside retention window)
  DELETE NOPROMPT OBSOLETE;

  RELEASE CHANNEL c1;
  RELEASE CHANNEL c2;
}

-- Report what is now available for recovery
REPORT NEED BACKUP;
LIST BACKUP SUMMARY;

REOF

END_TIME=\$(date +%s)
ELAPSED=$(( END_TIME - START_TIME ))
echo "===== Level 0 complete. Duration: \${ELAPSED}s. Log: \${LOGFILE} ====="

# Non-zero RMAN exit = failure
if [[ \${PIPESTATUS[0]} -ne 0 ]]; then
  echo "ERROR: RMAN exited with non-zero status — check \${LOGFILE}"
  exit 1
fi
\`\`\`

---

## Script 4 — Daily Level 1 Differential Backup

Schedule: Monday–Saturday 22:00

\`\`\`bash
#!/bin/bash
# rman_level1.sh  — daily Level 1 differential backup
# Cron: 0 22 * * 1-6 oracle /path/to/rman_level1.sh >> /var/log/oracle/rman/level1.log 2>&1
set -euo pipefail

ORACLE_SID=ORCL
ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_SID ORACLE_HOME
PATH=\${ORACLE_HOME}/bin:\${PATH}
LOG_DIR=/var/log/oracle/rman
mkdir -p "\${LOG_DIR}"
LOGFILE=\${LOG_DIR}/level1_\$(date +%Y%m%d_%H%M%S).log
exec > >(tee -a "\${LOGFILE}") 2>&1

echo "===== RMAN Level 1 Differential Backup: \$(date) ====="
START_TIME=\$(date +%s)

rman target / <<'REOF'

RUN {
  ALLOCATE CHANNEL c1 DEVICE TYPE DISK FORMAT '/u04/rman_backups/%d_L1_%T_%U';
  ALLOCATE CHANNEL c2 DEVICE TYPE DISK FORMAT '/u04/rman_backups/%d_L1_%T_%U';

  BACKUP INCREMENTAL LEVEL 1
    DATABASE
    TAG 'DAILY_LEVEL1'
    PLUS ARCHIVELOG
      TAG 'ARCH_WITH_LEVEL1'
      DELETE INPUT;

  BACKUP CURRENT CONTROLFILE TAG 'CF_WITH_LEVEL1';

  RELEASE CHANNEL c1;
  RELEASE CHANNEL c2;
}

LIST BACKUP SUMMARY;

REOF

END_TIME=\$(date +%s)
ELAPSED=$(( END_TIME - START_TIME ))
echo "===== Level 1 complete. Duration: \${ELAPSED}s. Log: \${LOGFILE} ====="
\`\`\`

---

## Script 5 — Hourly Archived Log Backup

Reduces data loss window to ~1 hour. Schedule every hour between full/incremental jobs.

\`\`\`bash
#!/bin/bash
# rman_archlog.sh  — hourly archived log backup
# Cron: 0 * * * * oracle /path/to/rman_archlog.sh >> /var/log/oracle/rman/archlog.log 2>&1
set -euo pipefail

ORACLE_SID=ORCL
ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_SID ORACLE_HOME
PATH=\${ORACLE_HOME}/bin:\${PATH}

rman target / <<'REOF'

BACKUP ARCHIVELOG ALL
  NOT BACKED UP 1 TIMES
  TAG 'HOURLY_ARCH'
  FORMAT '/u04/rman_backups/%d_arch_%T_%U'
  DELETE INPUT;

REOF
\`\`\`

---

## Script 6 — Validate Backups (Weekly)

Schedule: Saturday morning before the Sunday Level 0. Verifies backup pieces are readable and uncorrupted.

\`\`\`bash
#!/bin/bash
# rman_validate.sh  — validate database and backups
# Cron: 0 6 * * 6 oracle /path/to/rman_validate.sh >> /var/log/oracle/rman/validate.log 2>&1
set -euo pipefail

ORACLE_SID=ORCL
ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_SID ORACLE_HOME
PATH=\${ORACLE_HOME}/bin:\${PATH}
LOG_DIR=/var/log/oracle/rman
mkdir -p "\${LOG_DIR}"
LOGFILE=\${LOG_DIR}/validate_\$(date +%Y%m%d_%H%M%S).log
exec > >(tee -a "\${LOGFILE}") 2>&1

echo "===== RMAN Backup Validation: \$(date) ====="

rman target / <<'REOF'

-- Validate all backup pieces (checks headers and block checksums — no data written)
RESTORE DATABASE VALIDATE CHECK LOGICAL;

-- Validate archived logs needed for full recovery
RESTORE ARCHIVELOG ALL VALIDATE;

-- Check for block corruption in the live datafiles
BACKUP VALIDATE CHECK LOGICAL DATABASE;

-- Report any corruption found
SELECT * FROM V$DATABASE_BLOCK_CORRUPTION;

REOF

echo "===== Validation complete. Log: \${LOGFILE} ====="
\`\`\`

---

## Script 7 — Complete Recovery (Database Crash)

Use when the database is down due to media failure and all archived logs are available.

\`\`\`bash
#!/bin/bash
# rman_recover_complete.sh  — complete database recovery (no data loss)
set -euo pipefail

ORACLE_SID=ORCL
ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_SID ORACLE_HOME
PATH=\${ORACLE_HOME}/bin:\${PATH}

echo "===== Complete Recovery: \$(date) ====="
echo "This will restore the most recent backup and apply all archived logs."
read -rp "Confirm recovery (yes/no): " CONFIRM
[[ "\${CONFIRM}" != "yes" ]] && echo "Aborted." && exit 1

rman target / <<'REOF'

-- Mount the instance (do not open it)
STARTUP MOUNT;

-- Restore all datafiles from the most recent backup
RESTORE DATABASE;

-- Apply all archived logs through the last available SCN
RECOVER DATABASE;

-- Open the database
ALTER DATABASE OPEN;

-- Verify all datafiles are online
REPORT SCHEMA;

REOF

echo "===== Complete recovery finished: \$(date) ====="
echo "IMPORTANT: Take a new Level 0 backup immediately."
\`\`\`

---

## Script 8 — Point-in-Time Recovery (PITR)

Use after logical corruption: dropped table, bad batch update, accidental delete. You must know the target time (or SCN) before the error occurred.

\`\`\`bash
#!/bin/bash
# rman_pitr.sh  — point-in-time recovery
# Usage: rman_pitr.sh "2026-06-03 14:30:00"
set -euo pipefail

ORACLE_SID=ORCL
ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_SID ORACLE_HOME
PATH=\${ORACLE_HOME}/bin:\${PATH}

TARGET_TIME=\${1:-""}
if [[ -z "\${TARGET_TIME}" ]]; then
  echo "Usage: \$0 'YYYY-MM-DD HH24:MI:SS'"
  echo "Example: \$0 '2026-06-03 14:30:00'"
  exit 1
fi

echo "===== Point-in-Time Recovery ====="
echo "Target time : \${TARGET_TIME}"
echo "Current time: \$(date)"
echo ""
echo "WARNING: The database will open with RESETLOGS after PITR."
echo "All archived logs created after \${TARGET_TIME} will be discarded."
echo "Take a new Level 0 backup immediately after recovery."
echo ""
read -rp "Confirm PITR to '\${TARGET_TIME}' (yes/no): " CONFIRM
[[ "\${CONFIRM}" != "yes" ]] && echo "Aborted." && exit 1

rman target / <<REOF

STARTUP MOUNT;

RUN {
  SET UNTIL TIME "TO_DATE('\${TARGET_TIME}','YYYY-MM-DD HH24:MI:SS')";
  RESTORE DATABASE;
  RECOVER DATABASE;
}

ALTER DATABASE OPEN RESETLOGS;

-- Verify
SELECT name, open_mode, resetlogs_time FROM v\$database;

REOF

echo ""
echo "===== PITR complete: \$(date) ====="
echo "CRITICAL NEXT STEPS:"
echo "  1. Verify data is as expected before informing users"
echo "  2. Register new incarnation in recovery catalog (if used):"
echo "     rman target / catalog rman/pass@RMANCAT"
echo "     RESET DATABASE TO INCARNATION <new_incarnation#>;"
echo "  3. Take a new Level 0 backup NOW before doing anything else"
\`\`\`

---

## Script 9 — Single Datafile Recovery (Hot)

Use when a single non-SYSTEM datafile is lost. Database stays open for other tablespaces.

\`\`\`bash
#!/bin/bash
# rman_recover_datafile.sh  — recover a single datafile while database is open
# Usage: rman_recover_datafile.sh <file_number>
set -euo pipefail

ORACLE_SID=ORCL
ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_SID ORACLE_HOME
PATH=\${ORACLE_HOME}/bin:\${PATH}

FILE_NUM=\${1:-""}
if [[ -z "\${FILE_NUM}" ]]; then
  echo "Usage: \$0 <datafile_number>"
  echo ""
  echo "To find datafile numbers:"
  echo "  sqlplus / as sysdba"
  echo "  SELECT file#, name, status FROM v\\\$datafile;"
  exit 1
fi

echo "===== Datafile \${FILE_NUM} Recovery ====="

# Confirm the file is offline or missing before proceeding
sqlplus -s / as sysdba <<SQLEOF
set lines 160 pages 50
col name format a70
select file#, name, status from v\$datafile where file# = \${FILE_NUM};
exit;
SQLEOF

read -rp "Proceed with recovery of datafile \${FILE_NUM}? (yes/no): " CONFIRM
[[ "\${CONFIRM}" != "yes" ]] && echo "Aborted." && exit 1

rman target / <<REOF

-- Take the datafile offline (required if not already)
SQL 'ALTER DATABASE DATAFILE \${FILE_NUM} OFFLINE';

-- Restore from the most recent backup
RESTORE DATAFILE \${FILE_NUM};

-- Apply archived logs to bring it current
RECOVER DATAFILE \${FILE_NUM};

-- Bring it back online
SQL 'ALTER DATABASE DATAFILE \${FILE_NUM} ONLINE';

-- Verify
REPORT SCHEMA;

REOF

echo "===== Datafile \${FILE_NUM} recovery complete: \$(date) ====="
\`\`\`

---

## Script 10 — RMAN Health Check and Monitoring (4-Hour Cron)

Queries \`V\$RMAN_STATUS\`, \`V\$BACKUP_FILES\`, and FRA usage. Alerts when backups fail, the FRA is near full, or the last successful backup is overdue.

**SQL script** — save as \`rman_health_check.sql\`:

\`\`\`sql
-- rman_health_check.sql
-- Comprehensive RMAN backup status check.
-- Run as SYSDBA. Called by rman_monitor.sh.

set lines 200 pages 100 feedback off trimspool on
set colsep '|'
col status        format a15
col operation     format a25
col object_type   format a20
col start_time    format a22
col end_time      format a22
col input_bytes   format a15
col output_bytes  format a15
col elapsed_sec   format 999999
col pct_full      format 999
col file_type     format a25
col space_limit_g format 999990.0
col space_used_g  format 999990.0

prompt
prompt =============================================================================
prompt RMAN Health Check Report
prompt Generated: &_DATE
prompt =============================================================================
prompt

-- ── [1] Last 7 days of RMAN jobs ──────────────────────────────────────────────
prompt [1] RMAN Job History — last 7 days
prompt ---------------------------------------------------------------------------
select
  to_char(start_time, 'YYYY-MM-DD HH24:MI') as start_time,
  to_char(end_time,   'YYYY-MM-DD HH24:MI') as end_time,
  operation,
  object_type,
  status,
  round(output_bytes/1073741824, 2)  as out_gb,
  round(elapsed_seconds/60, 1)       as elapsed_min
from
  v$rman_status
where
  start_time >= sysdate - 7
  and operation in ('BACKUP','RESTORE','RECOVER','VALIDATE')
order by
  start_time desc
fetch first 40 rows only;

-- ── [2] Last successful backup by type ────────────────────────────────────────
prompt
prompt [2] Last Successful Backup by Type
prompt ---------------------------------------------------------------------------
select
  object_type,
  max(to_char(end_time,'YYYY-MM-DD HH24:MI')) as last_success,
  round((sysdate - max(end_time)) * 24, 1)    as hours_ago
from
  v$rman_status
where
  status  = 'COMPLETED'
  and operation = 'BACKUP'
group by
  object_type
order by
  3 desc;

-- ── [3] Failed jobs in last 48 hours ──────────────────────────────────────────
prompt
prompt [3] Failed / Warning RMAN Jobs — last 48 hours
prompt ---------------------------------------------------------------------------
select
  to_char(start_time,'YYYY-MM-DD HH24:MI') as start_time,
  operation,
  object_type,
  status,
  output_bytes,
  elapsed_seconds
from
  v$rman_status
where
  status in ('FAILED','COMPLETED WITH WARNINGS','COMPLETED WITH ERRORS')
  and start_time >= sysdate - 2
order by
  start_time desc;

-- ── [4] FRA usage ─────────────────────────────────────────────────────────────
prompt
prompt [4] Fast Recovery Area Usage
prompt ---------------------------------------------------------------------------
select
  name,
  round(space_limit/1073741824,   1) as space_limit_g,
  round(space_used/1073741824,    1) as space_used_g,
  round(space_reclaimable/1073741824, 1) as space_reclaimable_g,
  round(space_used * 100 / nullif(space_limit,0), 1) as pct_used
from
  v$recovery_file_dest;

-- ── [5] FRA file breakdown ────────────────────────────────────────────────────
prompt
prompt [5] FRA File Breakdown by Type
prompt ---------------------------------------------------------------------------
select
  file_type,
  count(*)                                      as file_count,
  round(sum(space_used)/1073741824, 2)          as used_gb,
  round(sum(space_reclaimable)/1073741824, 2)   as reclaimable_gb,
  sum(percent_space_used)                       as pct_space_used
from
  v$recovery_area_usage
group by
  file_type
order by
  used_gb desc;

-- ── [6] Datafiles needing backup (outside retention) ─────────────────────────
prompt
prompt [6] Datafiles Needing Backup (REPORT NEED BACKUP equivalent)
prompt ---------------------------------------------------------------------------
select
  file#,
  name,
  round(bytes/1073741824, 2) as size_gb,
  to_char(last_time,'YYYY-MM-DD HH24:MI')  as last_backup
from
  v$datafile df
  left join (
    select file1# as file_id, max(completion_time) as last_time
    from   v$backup_datafile
    group by file1#
  ) bdf on df.file# = bdf.file_id
where
  last_time is null
  or last_time < sysdate - 2   -- flagged if not backed up in 2 days
order by
  last_time nulls first;

-- ── [7] Block corruptions ─────────────────────────────────────────────────────
prompt
prompt [7] Block Corruption (V$DATABASE_BLOCK_CORRUPTION)
prompt ---------------------------------------------------------------------------
select count(*) as corruption_count from v$database_block_corruption;

select file#, block#, blocks, corruption_type
from   v$database_block_corruption;

prompt
prompt =============================================================================
prompt End of RMAN Health Check
prompt =============================================================================
exit;
\`\`\`

**Shell monitoring script** — save as \`rman_monitor.sh\`:

\`\`\`bash
#!/bin/bash
# rman_monitor.sh
# Monitors RMAN backup health: job failures, FRA usage, backup currency.
# Cron: 0 */4 * * * oracle /path/to/rman_monitor.sh >> /var/log/oracle/rman/monitor.log 2>&1
#
# Options:
#   --dry-run           Print what would be checked; no alerts sent
#   --alert-email ADDR  Email address for alerts
#   --log-dir PATH      Directory for log files (default /var/log/oracle/rman)
#   --fra-warn PCT      FRA usage % to trigger WARNING (default 75)
#   --fra-crit PCT      FRA usage % to trigger CRITICAL (default 90)
#   --backup-age-hrs N  Alert if last successful DB backup older than N hours (default 26)
#
# Password: SYSDBA connection via OS authentication (/ as sysdba)
# No password file needed when run as oracle OS user.

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
DRY_RUN=false
ALERT_EMAIL=\${ALERT_EMAIL:-""}
LOG_DIR=\${LOG_DIR:-/var/log/oracle/rman}
FRA_WARN_PCT=75
FRA_CRIT_PCT=90
BACKUP_AGE_WARN=26    # hours — level 1 runs daily, warn if > 26h since last success
ORACLE_SID=\${ORACLE_SID:-ORCL}
ORACLE_HOME=\${ORACLE_HOME:-/u01/app/oracle/product/19.0.0/dbhome_1}

# ── Parse arguments ────────────────────────────────────────────────────────────
while [[ \$# -gt 0 ]]; do
  case "\$1" in
    --dry-run)        DRY_RUN=true ;;
    --alert-email)    ALERT_EMAIL="\$2"; shift ;;
    --log-dir)        LOG_DIR="\$2"; shift ;;
    --fra-warn)       FRA_WARN_PCT="\$2"; shift ;;
    --fra-crit)       FRA_CRIT_PCT="\$2"; shift ;;
    --backup-age-hrs) BACKUP_AGE_WARN="\$2"; shift ;;
    *) echo "Unknown option: \$1"; exit 1 ;;
  esac
  shift
done

export ORACLE_SID ORACLE_HOME
PATH=\${ORACLE_HOME}/bin:\${PATH}

# ── Setup ──────────────────────────────────────────────────────────────────────
mkdir -p "\${LOG_DIR}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOGFILE=\${LOG_DIR}/monitor_\${TIMESTAMP}.log
SUMMARY_FILE=\${LOG_DIR}/summary_\${TIMESTAMP}.txt
SCRIPT_DIR=$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)
SQL_SCRIPT=\${SCRIPT_DIR}/rman_health_check.sql

exec > >(tee -a "\${LOGFILE}") 2>&1

echo "============================================================"
echo "RMAN Monitor — \$(date '+%Y-%m-%d %H:%M:%S')"
echo "SID      : \${ORACLE_SID}"
echo "Dry run  : \${DRY_RUN}"
echo "Log      : \${LOGFILE}"
echo "============================================================"

ALERTS=()

# ════════════════════════════════════════════════════════════════
# STEP 1: RMAN JOB STATUS
# ════════════════════════════════════════════════════════════════
echo ""
echo "── Step 1: RMAN Job Status (last 48 hours) ─────────────────"

JOB_STATUS=$(sqlplus -s "/ as sysdba" <<'SQLEOF'
set pages 0 feedback off heading off
select nvl(to_char(count(*)),'0')
from   v$rman_status
where  status in ('FAILED','COMPLETED WITH WARNINGS','COMPLETED WITH ERRORS')
and    start_time >= sysdate - 2;
exit;
SQLEOF
)
JOB_FAILURES=$(echo "\${JOB_STATUS}" | tr -d ' \n')

if [[ "\${JOB_FAILURES}" -gt 0 ]]; then
  echo "[CRITICAL] \${JOB_FAILURES} failed/warning RMAN job(s) in last 48 hours"
  ALERTS+=("CRITICAL: \${JOB_FAILURES} RMAN job failure(s) in last 48 hours")
  # Show the failures
  sqlplus -s "/ as sysdba" <<'SQLEOF'
  set lines 180 pages 50 feedback off
  col operation format a20
  col object_type format a20
  col status format a30
  select to_char(start_time,'YYYY-MM-DD HH24:MI') start_time,
         operation, object_type, status
  from   v$rman_status
  where  status in ('FAILED','COMPLETED WITH WARNINGS','COMPLETED WITH ERRORS')
  and    start_time >= sysdate - 2
  order by start_time desc;
  exit;
SQLEOF
else
  echo "[OK] No RMAN job failures in last 48 hours"
fi

# ════════════════════════════════════════════════════════════════
# STEP 2: LAST SUCCESSFUL DATABASE BACKUP AGE
# ════════════════════════════════════════════════════════════════
echo ""
echo "── Step 2: Last Successful DB Backup Currency ──────────────"

LAST_BACKUP_AGE=$(sqlplus -s "/ as sysdba" <<'SQLEOF'
set pages 0 feedback off heading off
select nvl(to_char(round((sysdate - max(end_time))*24, 1)), '9999')
from   v$rman_status
where  status    = 'COMPLETED'
and    operation = 'BACKUP'
and    object_type like '%DATABASE%';
exit;
SQLEOF
)
LAST_BACKUP_AGE=$(echo "\${LAST_BACKUP_AGE}" | tr -d ' \n')

echo "[INFO] Last successful database backup: \${LAST_BACKUP_AGE} hours ago"

# Compare using awk for decimal comparison
if awk "BEGIN {exit !(\${LAST_BACKUP_AGE} > \${BACKUP_AGE_WARN})}"; then
  echo "[CRITICAL] Backup is \${LAST_BACKUP_AGE}h old — exceeds threshold of \${BACKUP_AGE_WARN}h"
  ALERTS+=("CRITICAL: Last database backup is \${LAST_BACKUP_AGE} hours old (threshold: \${BACKUP_AGE_WARN}h)")
else
  echo "[OK] Last backup is \${LAST_BACKUP_AGE} hours ago (threshold: \${BACKUP_AGE_WARN}h)"
fi

# ════════════════════════════════════════════════════════════════
# STEP 3: FRA USAGE
# ════════════════════════════════════════════════════════════════
echo ""
echo "── Step 3: Fast Recovery Area Usage ────────────────────────"

FRA_PCT=$(sqlplus -s "/ as sysdba" <<'SQLEOF'
set pages 0 feedback off heading off
select nvl(to_char(round(space_used * 100 / nullif(space_limit,0), 1)), '0')
from   v$recovery_file_dest;
exit;
SQLEOF
)
FRA_PCT=$(echo "\${FRA_PCT}" | tr -d ' \n')

FRA_RECLAIMABLE=$(sqlplus -s "/ as sysdba" <<'SQLEOF'
set pages 0 feedback off heading off
select nvl(to_char(round(space_reclaimable/1073741824, 1)), '0')
from   v$recovery_file_dest;
exit;
SQLEOF
)
FRA_RECLAIMABLE=$(echo "\${FRA_RECLAIMABLE}" | tr -d ' \n')

echo "[INFO] FRA usage: \${FRA_PCT}%  (reclaimable: \${FRA_RECLAIMABLE} GB)"

if awk "BEGIN {exit !(\${FRA_PCT} >= \${FRA_CRIT_PCT})}"; then
  echo "[CRITICAL] FRA at \${FRA_PCT}% — critical threshold is \${FRA_CRIT_PCT}%"
  ALERTS+=("CRITICAL: FRA usage at \${FRA_PCT}% (critical threshold: \${FRA_CRIT_PCT}%)")
elif awk "BEGIN {exit !(\${FRA_PCT} >= \${FRA_WARN_PCT})}"; then
  echo "[WARNING] FRA at \${FRA_PCT}% — warning threshold is \${FRA_WARN_PCT}%"
  ALERTS+=("WARNING: FRA usage at \${FRA_PCT}% (warning threshold: \${FRA_WARN_PCT}%)")
else
  echo "[OK] FRA usage: \${FRA_PCT}% (within thresholds)"
fi

# ════════════════════════════════════════════════════════════════
# STEP 4: BLOCK CORRUPTIONS
# ════════════════════════════════════════════════════════════════
echo ""
echo "── Step 4: Block Corruption Check ──────────────────────────"

CORRUPTION_COUNT=$(sqlplus -s "/ as sysdba" <<'SQLEOF'
set pages 0 feedback off heading off
select count(*) from v$database_block_corruption;
exit;
SQLEOF
)
CORRUPTION_COUNT=$(echo "\${CORRUPTION_COUNT}" | tr -d ' \n')

if [[ "\${CORRUPTION_COUNT}" -gt 0 ]]; then
  echo "[CRITICAL] \${CORRUPTION_COUNT} block corruption(s) detected in V\$DATABASE_BLOCK_CORRUPTION"
  ALERTS+=("CRITICAL: \${CORRUPTION_COUNT} block corruption(s) in V\$DATABASE_BLOCK_CORRUPTION")
  sqlplus -s "/ as sysdba" <<'SQLEOF'
  set lines 120 pages 50 feedback off
  select file#, block#, blocks, corruption_type
  from   v$database_block_corruption;
  exit;
SQLEOF
else
  echo "[OK] No block corruptions in V\$DATABASE_BLOCK_CORRUPTION"
fi

# ════════════════════════════════════════════════════════════════
# STEP 5: FULL HEALTH CHECK SQL REPORT
# ════════════════════════════════════════════════════════════════
echo ""
echo "── Step 5: Full SQL Report ──────────────────────────────────"

SQL_LOG=\${LOG_DIR}/sql_report_\${TIMESTAMP}.log

if [[ -f "\${SQL_SCRIPT}" ]]; then
  if [[ "\${DRY_RUN}" == "true" ]]; then
    echo "[DRY-RUN] Would run: sqlplus / as sysdba @\${SQL_SCRIPT}"
  else
    sqlplus -s "/ as sysdba" @"\${SQL_SCRIPT}" > "\${SQL_LOG}" 2>&1 || true
    echo "[INFO] Full SQL report written to: \${SQL_LOG}"
    cat "\${SQL_LOG}"
  fi
else
  echo "[WARN] SQL script not found: \${SQL_SCRIPT} — place rman_health_check.sql alongside this script"
  ALERTS+=("WARNING: rman_health_check.sql not found — SQL report skipped")
fi

# ════════════════════════════════════════════════════════════════
# SUMMARY AND ALERT
# ════════════════════════════════════════════════════════════════
echo ""
echo "============================================================"
echo "SUMMARY — \$(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================================"

{
  echo "RMAN Monitor Summary — \$(date '+%Y-%m-%d %H:%M:%S')"
  echo "Database : \${ORACLE_SID} on \$(hostname)"
  echo ""
  if [[ \${#ALERTS[@]} -eq 0 ]]; then
    echo "STATUS: OK — no issues detected"
    echo ""
    echo "  Last backup : \${LAST_BACKUP_AGE}h ago"
    echo "  FRA usage   : \${FRA_PCT}%"
    echo "  Job failures: 0 (last 48h)"
    echo "  Corruptions : 0"
  else
    echo "STATUS: ALERTS DETECTED (\${#ALERTS[@]})"
    echo ""
    for ALERT in "\${ALERTS[@]}"; do
      echo "  • \${ALERT}"
    done
  fi
  echo ""
  echo "Log : \${LOGFILE}"
  [[ -f "\${SQL_LOG:-}" ]] && echo "SQL : \${SQL_LOG}"
} | tee "\${SUMMARY_FILE}"

# ── Email alert ────────────────────────────────────────────────
if [[ \${#ALERTS[@]} -gt 0 ]] && [[ -n "\${ALERT_EMAIL}" ]]; then
  SUBJECT="[RMAN ALERT] \${ORACLE_SID}@\$(hostname) — \${#ALERTS[@]} issue(s) \$(date '+%Y-%m-%d %H:%M')"
  if command -v mailx &>/dev/null; then
    mailx -s "\${SUBJECT}" "\${ALERT_EMAIL}" < "\${SUMMARY_FILE}"
    echo "[INFO] Alert sent to \${ALERT_EMAIL}"
  elif command -v sendmail &>/dev/null; then
    { echo "Subject: \${SUBJECT}"; echo ""; cat "\${SUMMARY_FILE}"; } | sendmail "\${ALERT_EMAIL}"
  fi
fi

EXIT_CODE=0
for ALERT in "\${ALERTS[@]}"; do
  [[ "\${ALERT}" == CRITICAL* ]] && EXIT_CODE=2 && break
  EXIT_CODE=1
done

echo ""
echo "Exit code: \${EXIT_CODE}  (0=OK, 1=WARNING, 2=CRITICAL)"
exit "\${EXIT_CODE}"
\`\`\`

---

## Cron Schedule

\`\`\`bash
# Deploy scripts
mkdir -p /u01/app/oracle/scripts/rman
cp rman_level0.sh rman_level1.sh rman_archlog.sh rman_validate.sh \
   rman_monitor.sh rman_health_check.sql /u01/app/oracle/scripts/rman/
chmod 750 /u01/app/oracle/scripts/rman/*.sh
chmod 640 /u01/app/oracle/scripts/rman/*.sql

mkdir -p /var/log/oracle/rman
chown oracle:oinstall /var/log/oracle/rman

crontab -e -u oracle
\`\`\`

\`\`\`
# RMAN Backup Schedule
# Weekly Level 0 — Sunday 22:00
0 22 * * 0  ORACLE_SID=ORCL ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1 /u01/app/oracle/scripts/rman/rman_level0.sh

# Daily Level 1 — Monday to Saturday 22:00
0 22 * * 1-6  ORACLE_SID=ORCL ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1 /u01/app/oracle/scripts/rman/rman_level1.sh

# Hourly archived log backup
0 * * * *  ORACLE_SID=ORCL ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1 /u01/app/oracle/scripts/rman/rman_archlog.sh

# Weekly validation — Saturday 06:00
0 6 * * 6  ORACLE_SID=ORCL ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1 /u01/app/oracle/scripts/rman/rman_validate.sh

# 4-hour monitoring check
0 */4 * * *  ORACLE_SID=ORCL ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1 ALERT_EMAIL=dba@example.com /u01/app/oracle/scripts/rman/rman_monitor.sh
\`\`\`

---

## Log Rotation

\`\`\`
# /etc/logrotate.d/oracle-rman
/var/log/oracle/rman/*.log {
    daily
    rotate 30
    compress
    missingok
    notifempty
    create 0640 oracle oinstall
}
\`\`\`

---

## Quick Reference: Recovery Decision Tree

\`\`\`
Database will not open
│
├─ Missing/corrupt datafile (non-SYSTEM)?
│    └─ Datafile offline → RESTORE DATAFILE n → RECOVER → ONLINE
│       (database stays open for other tablespaces)
│
├─ Missing/corrupt SYSTEM, UNDO, or multiple datafiles?
│    └─ Shutdown → STARTUP MOUNT → RESTORE DATABASE → RECOVER → OPEN
│
├─ Missing control file?
│    └─ STARTUP NOMOUNT → RESTORE CONTROLFILE FROM AUTOBACKUP
│       → MOUNT → RECOVER DATABASE → OPEN RESETLOGS
│
├─ Logical error (dropped table, bad DML)?
│    └─ Determine target time/SCN → PITR (Script 8) → OPEN RESETLOGS
│       → Level 0 backup immediately after
│
└─ Single tablespace back to point in time (rest of DB untouched)?
     └─ TSPITR via RMAN auxiliary instance
        (complex — verify with Oracle Support before first execution)
\`\`\`

---

## Common Issues and Fixes

### ORA-19809: limit exceeded for recovery files

The FRA is full. Oracle cannot write more archived logs or backup pieces.

\`\`\`
rman target /
DELETE NOPROMPT OBSOLETE;
DELETE NOPROMPT ARCHIVELOG ALL BACKED UP 2 TIMES TO DISK;
\`\`\`

If still full, increase the FRA size:

\`\`\`sql
ALTER SYSTEM SET db_recovery_file_dest_size = 400G;
\`\`\`

### RMAN-08120: WARNING: archived log not deleted, not yet backed up

The archivelog deletion policy requires 2 backups before deleting, but recent logs have only been backed up once. Run the archlog backup script to create the second backup, then re-run the backup job.

### RMAN-06171: not connected to recovery catalog

You configured RMAN to use a catalog but the catalog database is unavailable. Either fix catalog connectivity or run with \`rman target / nocatalog\` temporarily (uses control file only). Re-sync the catalog when it is back: \`RESYNC CATALOG\`.

### Backup completing with warnings: archived log missing

Archived logs were deleted before RMAN backed them up, creating a gap. Check the archivelog deletion policy and FRA usage — an undersized FRA causes Oracle to override retention and delete logs early.
`,
};

async function main() {
  await db.insert(posts).values(blogPost);
  console.log('inserted:', blogPost.slug);

  await db.insert(posts).values(runbookPost);
  console.log('inserted:', runbookPost.slug);
}

main().catch(console.error);
