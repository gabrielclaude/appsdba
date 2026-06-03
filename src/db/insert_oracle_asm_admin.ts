import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const blogPost = {
  title: 'Oracle ASM Administration: Disk Groups, Redundancy, and Storage Management',
  slug: 'oracle-asm-administration',
  excerpt:
    'A practical guide to Oracle Automatic Storage Management — covering disk group architecture, redundancy types, failure groups, rebalancing, ASMCMD, and the operational tasks every DBA needs to keep ASM healthy in production.',
  category: 'oracle-database' as const,
  published: true,
  publishedAt: new Date('2026-06-03'),
  isPremium: false,
  youtubeUrl: null,
  content: `Oracle Automatic Storage Management (ASM) is Oracle's integrated volume manager and file system, built specifically for Oracle Database files. It eliminates the need for a third-party volume manager and filesystem (LVM + ext4/XFS), provides automatic I/O load balancing across all disks in a disk group, and handles mirroring and striping natively. Since Oracle 11g, ASM has been deployed as part of Oracle Grid Infrastructure, and for RAC environments it is effectively mandatory. For single-instance 19c databases it remains the recommended storage layer over filesystem deployments.

---

## Architecture

### The ASM Instance

ASM runs as a separate Oracle instance — it has its own SGA, background processes, and \`ORACLE_SID\` (conventionally \`+ASM\` or \`+ASM1\`/\`+ASM2\` in RAC). It does not use a datafile or redo logs of its own. Its purpose is to manage disk groups and serve I/O requests from database instances.

Database instances connect to the ASM instance on the same server through an internal IPC channel. From the database perspective, files are referenced by ASM paths like \`+DATA/ORCL/DATAFILE/system.256.1091234567\` — the ASM instance translates these to physical disk extents.

\`\`\`
Database Instance (ORCL)
        │  IPC channel
        ▼
   ASM Instance (+ASM)
        │  translates ASM paths → disk extents
        ▼
   Disk Groups (DATA, FRA, REDO)
        │  each DG spans one or more physical disks
        ▼
   OS Block Devices (/dev/sdb, /dev/sdc, ...)
\`\`\`

### Disk Groups

A **disk group** is a named collection of disks managed as a unit. ASM stripes all files across all disks in the disk group automatically — you do not partition disks or create filesystems. Common disk group naming conventions:

| Disk Group | Typical Contents |
|---|---|
| \`+DATA\` | Datafiles, control files, SPFILE |
| \`+FRA\` | Fast Recovery Area (archived logs, RMAN backups, flashback logs) |
| \`+REDO\` | Redo log groups (optional — separate DG for redo isolation) |

### Allocation Units and Extents

An **Allocation Unit (AU)** is the base unit of space within a disk group — by default 1MB, configurable to 2, 4, 8, 16, 32, or 64MB at disk group creation time. Larger AUs reduce metadata overhead for very large files (VLDB datafiles, large backups) but waste more space for small files. For most OLTP workloads 1MB or 4MB AUs are appropriate. For data warehousing or Exadata, 4MB or larger.

### Background Processes

| Process | Purpose |
|---|---|
| **RBAL** | Rebalance coordinator — manages disk adds/drops |
| **ARBn** | Rebalance worker processes (ARB0, ARB1, …) — do the actual extent movement |
| **GMON** | Disk group monitor — handles disk failure detection |
| **ASMB** | ASM background — database instance connection to ASM instance |
| **MARK** | Marks ASM extents as stale after a disk failure (for fast mirror resync) |

---

## Redundancy Types

Redundancy is set at disk group creation and cannot be changed afterwards without recreating the disk group.

| Redundancy | Mirrors | Failure Groups Required | Disk Overhead | Survives |
|---|---|---|---|---|
| **External** | None | 1 | 0% | Hardware RAID or no failure |
| **Normal** | 2-way | 2 minimum | ~50% | 1 failure group lost |
| **High** | 3-way | 3 minimum | ~67% | 2 failure groups lost |
| **Flex** | Configurable per file | 3 minimum | Varies | Configurable |

**External redundancy** is used when the underlying storage already provides RAID protection (SAN with RAID-5 or RAID-10). ASM writes each extent once and trusts the hardware.

**Normal redundancy** is the most common choice for software-defined environments. ASM maintains two copies of every extent, each on a different failure group. If one failure group is lost (a disk controller, a SAN port, a chassis), the other copy survives.

**High redundancy** is used for the most critical disk groups — typically the redo log group — where you cannot afford any single storage path failure to cause data loss.

### Failure Groups

A **failure group** is a subset of disks within a disk group that share a common failure domain. ASM places mirror copies of extents on different failure groups, so a single component failure cannot destroy both copies.

What constitutes a failure group depends on your hardware:
- **HBA-based**: each HBA is a failure group — losing one HBA does not take down the other path
- **Controller-based**: each disk controller is a failure group
- **SAN zone-based**: each SAN fabric path is a failure group
- **Chassis-based**: each physical chassis is a failure group (common in engineered systems)

If you do not explicitly assign failure groups, ASM assigns all disks to a single default failure group — effectively giving you normal redundancy syntax with zero actual redundancy.

---

## ASM Disk Discovery

ASM discovers candidate disks through the \`ASM_DISKSTRING\` parameter. This is a comma-separated list of patterns that ASM searches to find disks. Typical values:

\`\`\`
ASM_DISKSTRING = '/dev/oracleasm/disks/*'      -- ASMLib (RHEL/OL)
ASM_DISKSTRING = 'AFD:*'                        -- ASM Filter Driver (udev-based)
ASM_DISKSTRING = '/dev/sd[b-z]', '/dev/mapper/data*'  -- raw devices
\`\`\`

On Oracle Linux with ASMLib, \`oracleasm scandisks\` detects new LUNs presented by the SAN and makes them available. With ASM Filter Driver (AFD), the \`asmcmd afd_label\` command marks devices for ASM use.

---

## ASMCMD

\`ASMCMD\` is the command-line tool for navigating and managing the ASM file namespace. It presents disk group contents as a directory tree.

\`\`\`bash
# Connect to the ASM instance
export ORACLE_SID=+ASM
export ORACLE_HOME=/u01/app/grid/19.0.0
asmcmd
\`\`\`

Essential ASMCMD commands:

| Command | Purpose |
|---|---|
| \`lsdg\` | List disk groups with space and status |
| \`ls +DATA/ORCL\` | Navigate ASM file directory |
| \`lsod\` | List open ASM files (shows which DB has files open) |
| \`lsdsk\` | List ASM disks and their status |
| \`md_backup\` | Back up disk group metadata |
| \`md_restore\` | Restore disk group metadata from backup |
| \`cp\` | Copy ASM files (to/from ASM or OS filesystem) |
| \`du\` | Disk usage of an ASM directory |
| \`remap\` | Remap bad disk blocks |

---

## Key Operations

### Adding a Disk to an Existing Disk Group

Disks are added with \`ALTER DISKGROUP ... ADD DISK\`. ASM begins rebalancing immediately, redistributing existing extents across the new disk.

\`\`\`sql
ALTER DISKGROUP DATA
  ADD FAILGROUP FG3 DISK '/dev/sdf' NAME DATA_0006,
                         '/dev/sdg' NAME DATA_0007
  REBALANCE POWER 4;
\`\`\`

\`REBALANCE POWER\` (1–1024) controls how aggressively ASM uses I/O for rebalancing. Higher values complete faster but consume more I/O bandwidth. Default is the value of \`ASM_POWER_LIMIT\` (default 1 — deliberately conservative).

### Dropping a Disk

Dropping a disk causes ASM to migrate all extents off it before removing it.

\`\`\`sql
-- Check space first: the remaining disks must have room for the evicted extents
ALTER DISKGROUP DATA DROP DISK DATA_0005 REBALANCE POWER 8;
\`\`\`

If you need to cancel a drop mid-operation:

\`\`\`sql
ALTER DISKGROUP DATA UNDROP DISKS;
\`\`\`

### Rebalancing

Rebalancing redistributes extents evenly across all disks. It is triggered automatically when disks are added or dropped. You can also trigger it manually after replacing a failed disk:

\`\`\`sql
ALTER DISKGROUP DATA REBALANCE POWER 6 WAIT;
-- WAIT makes the command block until rebalance completes
\`\`\`

Monitor rebalance progress:

\`\`\`sql
SELECT inst_id, group_number, operation, state,
       power, actual, sofar, est_work, est_rate, est_minutes
FROM   gv$asm_operation
ORDER BY inst_id, group_number;
\`\`\`

### Disk Group Scrubbing (12c+)

ASM scrubbing reads all extents and checks logical consistency and mirror copy agreement. It detects silent data corruption that is not caught by normal I/O.

\`\`\`sql
-- Scrub a disk group (repair=TRUE fixes fixable mismatches)
ALTER DISKGROUP DATA SCRUB REPAIR POWER AUTO WAIT;
\`\`\`

Scrubbing can be run online without stopping the database. Schedule it quarterly on disk groups with high redundancy.

---

## Preferred Read Failure Groups (RAC/Extended Clusters)

In a RAC cluster where nodes are in different data centres (extended RAC / stretch cluster), you want each node to read from the nearest disk. \`ASM_PREFERRED_READ_FAILURE_GROUPS\` tells ASM which failure group is local to this node:

\`\`\`
ASM_PREFERRED_READ_FAILURE_GROUPS = '+DATA.FG_SITE_A'
\`\`\`

Writes still go to all mirrors, but reads are served locally, reducing cross-site latency.

---

## ASM Metadata Backup

ASM disk group metadata (directory, file extents, disk headers) is stored in the disk group itself. If all disks in a disk group are lost simultaneously (without normal/high redundancy protecting against it), the metadata can be reconstructed from a backup taken with \`md_backup\`.

\`\`\`bash
asmcmd md_backup -G DATA,FRA /u01/backup/asm_metadata_\$(date +%Y%m%d).bkp
\`\`\`

Run this after every disk group structural change (add/drop disk, disk group creation).

---

## Best Practices

**Always define explicit failure groups.** Letting ASM assign all disks to a default single failure group defeats the purpose of normal/high redundancy. Map your failure groups to your actual hardware failure domains.

**Match redundancy to your hardware.** If your SAN provides RAID-10, external redundancy avoids double-mirroring (wasting 50% of SAN capacity). If using JBOD or direct-attached storage without hardware RAID, use at least normal redundancy.

**Separate DATA and FRA into distinct disk groups.** Heavy RMAN backup activity against a combined DATA+FRA disk group causes I/O contention with the foreground database workload. Dedicated FRA disk groups with their own spindles isolate backup I/O.

**Set ASM_POWER_LIMIT appropriately for your environment.** The default of 1 makes rebalancing take a very long time. For most production environments, 4–8 is safe during off-peak hours. In emergencies (disk about to fail), use power 32+.

**Back up ASM metadata after every disk group change.** \`asmcmd md_backup\` takes seconds and can save hours of reconstruction work after a catastrophic failure.

**Monitor disk group free space proactively.** ASM will crash a database instance if a disk group runs out of space during a write. Alert at 75% full — not 95%.

**Use AFD (ASM Filter Driver) or ASMLib to prevent non-Oracle I/O.** Without AFD/ASMLib, there is a risk of the OS writing to an ASM disk (e.g., a misguided \`dd\` or partition operation), silently corrupting it. AFD is the current recommendation for new installations.

The companion runbook covers all key operational tasks with executable scripts, including a health check script that monitors disk group space, disk status, rebalance operations, and alerts on problems.
`,
};

const runbookPost = {
  title: 'Oracle ASM Administration Runbook',
  slug: 'oracle-asm-administration-runbook',
  excerpt:
    'Operational runbook for Oracle ASM — disk group creation, adding and dropping disks, rebalancing, metadata backup, ASMCMD navigation, and a 4-hour monitoring script that checks disk group space, disk health, active operations, and alerts on failures.',
  category: 'oracle-database' as const,
  published: true,
  publishedAt: new Date('2026-06-03'),
  isPremium: true,
  youtubeUrl: null,
  content: `# Oracle ASM Administration Runbook

## Overview

This runbook covers day-to-day ASM operations: disk group creation, disk management, rebalancing, metadata backup, and a schedulable health check script.

**Assumptions:**
- Oracle 19c Grid Infrastructure
- ASM instance SID: \`+ASM\` (single node) or \`+ASM1\`/\`+ASM2\` (RAC)
- Grid home: \`/u01/app/grid/19.0.0\`
- Oracle DB home: \`/u01/app/oracle/product/19.0.0/dbhome_1\`
- Disk devices managed via ASMLib (\`/dev/oracleasm/disks/\`)
- Scripts run as \`grid\` OS user (ASM instance owner)

---

## Script 1 — ASM Environment and Pre-Check

\`\`\`bash
#!/bin/bash
# asm_precheck.sh  — run as grid user
# Verifies ASM instance is up, lists disk groups and disk status.
set -euo pipefail

ORACLE_SID=+ASM
ORACLE_HOME=/u01/app/grid/19.0.0
export ORACLE_SID ORACLE_HOME
PATH=\${ORACLE_HOME}/bin:\${PATH}

echo "===== ASM Pre-Check: \$(hostname) — \$(date) ====="
echo ""

# ── ASM instance status ───────────────────────────────────────────────────────
echo "[1] ASM instance status"
sqlplus -s / as sysasm <<'SQLEOF'
  set lines 120 pages 50 feedback off
  select instance_name, status, database_status from v$instance;
SQLEOF

# ── Disk groups ───────────────────────────────────────────────────────────────
echo ""
echo "[2] Disk group summary"
sqlplus -s / as sysasm <<'SQLEOF'
  set lines 160 pages 50 feedback off
  col name           format a15
  col state          format a12
  col type           format a10
  col total_gb       format 99990.0
  col free_gb        format 99990.0
  col usable_gb      format 99990.0
  col pct_used       format 990.0
  select
    name,
    state,
    type,
    round(total_mb/1024,   1) as total_gb,
    round(free_mb/1024,    1) as free_gb,
    round(usable_file_mb/1024, 1) as usable_gb,
    round((1 - free_mb/nullif(total_mb,0)) * 100, 1) as pct_used
  from v$asm_diskgroup
  order by name;
SQLEOF

# ── Disk status ───────────────────────────────────────────────────────────────
echo ""
echo "[3] Disk status by disk group"
sqlplus -s / as sysasm <<'SQLEOF'
  set lines 200 pages 100 feedback off
  col group_number format 99
  col disk_number  format 999
  col name         format a20
  col failgroup    format a20
  col path         format a35
  col mode_status  format a15
  col state        format a12
  col total_gb     format 9990.0
  col free_gb      format 9990.0
  select
    group_number,
    disk_number,
    name,
    failgroup,
    path,
    mode_status,
    state,
    round(total_mb/1024, 1) as total_gb,
    round(free_mb/1024,  1) as free_gb
  from v$asm_disk
  order by group_number, disk_number;
SQLEOF

# ── Active rebalance operations ───────────────────────────────────────────────
echo ""
echo "[4] Active rebalance operations (empty = none running)"
sqlplus -s / as sysasm <<'SQLEOF'
  set lines 160 pages 50 feedback off
  select group_number, operation, state, power, actual,
         sofar, est_work, est_rate, est_minutes
  from v$asm_operation;
SQLEOF

echo ""
echo "===== Pre-check complete ====="
\`\`\`

---

## Script 2 — Create Disk Groups

\`\`\`bash
#!/bin/bash
# asm_create_diskgroups.sh  — run as grid user
# Creates DATA and FRA disk groups with normal redundancy.
# Adjust disk paths, failure group names, and AU size for your environment.
set -euo pipefail

ORACLE_SID=+ASM
ORACLE_HOME=/u01/app/grid/19.0.0
export ORACLE_SID ORACLE_HOME
PATH=\${ORACLE_HOME}/bin:\${PATH}
LOGFILE=/tmp/asm_create_dg_\$(date +%Y%m%d_%H%M%S).log
exec > >(tee -a "\${LOGFILE}") 2>&1

echo "===== Create ASM Disk Groups: \$(date) ====="

sqlplus / as sysasm <<'SQLEOF'

-- ─── DATA disk group — Normal Redundancy, 4MB AU ──────────────────────────────
-- Two failure groups: one per storage controller/HBA path
-- Adjust disk names and paths to match your environment
CREATE DISKGROUP DATA
  NORMAL REDUNDANCY
  FAILGROUP FG_CTRL1 DISK
    '/dev/oracleasm/disks/DATA01' NAME DATA_0001,
    '/dev/oracleasm/disks/DATA02' NAME DATA_0002,
    '/dev/oracleasm/disks/DATA03' NAME DATA_0003
  FAILGROUP FG_CTRL2 DISK
    '/dev/oracleasm/disks/DATA04' NAME DATA_0004,
    '/dev/oracleasm/disks/DATA05' NAME DATA_0005,
    '/dev/oracleasm/disks/DATA06' NAME DATA_0006
  ATTRIBUTE
    'AU_SIZE'          = '4194304',    -- 4MB allocation unit
    'COMPATIBLE.ASM'   = '19.0',
    'COMPATIBLE.RDBMS' = '19.0',
    'SECTOR_SIZE'      = '512';

-- ─── FRA disk group — Normal Redundancy, 4MB AU ───────────────────────────────
CREATE DISKGROUP FRA
  NORMAL REDUNDANCY
  FAILGROUP FG_CTRL1 DISK
    '/dev/oracleasm/disks/FRA01' NAME FRA_0001,
    '/dev/oracleasm/disks/FRA02' NAME FRA_0002
  FAILGROUP FG_CTRL2 DISK
    '/dev/oracleasm/disks/FRA03' NAME FRA_0003,
    '/dev/oracleasm/disks/FRA04' NAME FRA_0004
  ATTRIBUTE
    'AU_SIZE'          = '4194304',
    'COMPATIBLE.ASM'   = '19.0',
    'COMPATIBLE.RDBMS' = '19.0',
    'SECTOR_SIZE'      = '512';

-- ─── REDO disk group — High Redundancy ────────────────────────────────────────
-- Three failure groups for redo logs — zero RPO for redo loss
CREATE DISKGROUP REDO
  HIGH REDUNDANCY
  FAILGROUP FG_CTRL1 DISK
    '/dev/oracleasm/disks/REDO01' NAME REDO_0001
  FAILGROUP FG_CTRL2 DISK
    '/dev/oracleasm/disks/REDO02' NAME REDO_0002
  FAILGROUP FG_CTRL3 DISK
    '/dev/oracleasm/disks/REDO03' NAME REDO_0003
  ATTRIBUTE
    'AU_SIZE'          = '1048576',    -- 1MB for redo
    'COMPATIBLE.ASM'   = '19.0',
    'COMPATIBLE.RDBMS' = '19.0';

-- Verify creation
select name, state, type,
       round(total_mb/1024,1) total_gb,
       round(free_mb/1024,1)  free_gb
from   v$asm_diskgroup
order by name;

SQLEOF

echo "===== Disk group creation complete. Log: \${LOGFILE} ====="
\`\`\`

---

## Script 3 — Add Disks to an Existing Disk Group

\`\`\`bash
#!/bin/bash
# asm_add_disks.sh  — run as grid user
# Usage: asm_add_disks.sh <diskgroup> <failgroup> <disk_path> [<disk_path> ...]
# Example: asm_add_disks.sh DATA FG_CTRL1 /dev/oracleasm/disks/DATA07 /dev/oracleasm/disks/DATA08
set -euo pipefail

ORACLE_SID=+ASM
ORACLE_HOME=/u01/app/grid/19.0.0
export ORACLE_SID ORACLE_HOME
PATH=\${ORACLE_HOME}/bin:\${PATH}

DG_NAME=\${1:-""}
FAILGROUP=\${2:-""}
shift 2 2>/dev/null || true
DISK_PATHS=("$@")

if [[ -z "\${DG_NAME}" || -z "\${FAILGROUP}" || \${#DISK_PATHS[@]} -eq 0 ]]; then
  echo "Usage: \$0 <diskgroup> <failgroup> <disk_path> [<disk_path> ...]"
  echo "Example: \$0 DATA FG_CTRL1 /dev/oracleasm/disks/DATA07"
  exit 1
fi

LOGFILE=/tmp/asm_add_disks_\$(date +%Y%m%d_%H%M%S).log
exec > >(tee -a "\${LOGFILE}") 2>&1

echo "===== Add Disks to \${DG_NAME}: \$(date) ====="
echo "Failure group : \${FAILGROUP}"
echo "Disks         : \${DISK_PATHS[*]}"

# ── Check current space before adding ────────────────────────────────────────
echo ""
echo "[1] Current disk group space"
sqlplus -s / as sysasm <<SQLEOF
  set lines 120 pages 50 feedback off
  select name, round(total_mb/1024,1) total_gb, round(free_mb/1024,1) free_gb,
         round((1-free_mb/nullif(total_mb,0))*100,1) pct_used
  from   v\$asm_diskgroup
  where  name = upper('\${DG_NAME}');
SQLEOF

echo ""
read -rp "Proceed with adding disks? (yes/no): " CONFIRM
[[ "\${CONFIRM}" != "yes" ]] && echo "Aborted." && exit 1

# ── Build the ADD DISK SQL ────────────────────────────────────────────────────
DISK_CLAUSES=""
IDX=0
for DPATH in "\${DISK_PATHS[@]}"; do
  DISK_NAME=\${DG_NAME}_ADD_\$(printf '%04d' \${IDX})
  DISK_CLAUSES+="\${FAILGROUP} DISK '\${DPATH}' NAME \${DISK_NAME},"
  IDX=$(( IDX + 1 ))
done
DISK_CLAUSES=\${DISK_CLAUSES%,}   # strip trailing comma

echo ""
echo "[2] Adding disks and starting rebalance (power 4)..."
sqlplus / as sysasm <<SQLEOF
ALTER DISKGROUP \${DG_NAME}
  ADD FAILGROUP \${DISK_CLAUSES}
  REBALANCE POWER 4;

-- Monitor rebalance
select group_number, operation, state, power, sofar, est_work, est_minutes
from   v\$asm_operation;
SQLEOF

echo ""
echo "===== Disk add initiated. Monitor with:"
echo "  sqlplus / as sysasm"
echo "  select operation, state, sofar, est_work, est_minutes from v\\\$asm_operation;"
echo "Log: \${LOGFILE}"
\`\`\`

---

## Script 4 — Drop a Disk (Graceful Eviction)

\`\`\`bash
#!/bin/bash
# asm_drop_disk.sh  — run as grid user
# Gracefully evicts a disk, migrating all extents before removal.
# Usage: asm_drop_disk.sh <diskgroup> <disk_name>
# Disk name from: select name from v$asm_disk where group_number = <n>;
set -euo pipefail

ORACLE_SID=+ASM
ORACLE_HOME=/u01/app/grid/19.0.0
export ORACLE_SID ORACLE_HOME
PATH=\${ORACLE_HOME}/bin:\${PATH}

DG_NAME=\${1:-""}
DISK_NAME=\${2:-""}

if [[ -z "\${DG_NAME}" || -z "\${DISK_NAME}" ]]; then
  echo "Usage: \$0 <diskgroup> <disk_name>"
  echo "Example: \$0 DATA DATA_0003"
  exit 1
fi

LOGFILE=/tmp/asm_drop_disk_\$(date +%Y%m%d_%H%M%S).log
exec > >(tee -a "\${LOGFILE}") 2>&1

echo "===== Drop Disk \${DISK_NAME} from \${DG_NAME}: \$(date) ====="

# ── Space check — remaining disks must absorb the evicted extents ────────────
echo "[1] Space check: remaining capacity after drop"
sqlplus -s / as sysasm <<SQLEOF
  set lines 160 pages 50 feedback off
  col name format a20
  col path format a35
  col total_gb format 990.0
  col free_gb  format 990.0
  -- Show the disk being dropped
  select name, failgroup, path, mode_status, state,
         round(total_mb/1024,1) total_gb
  from   v\$asm_disk
  where  group_number = (select group_number from v\$asm_diskgroup where name=upper('\${DG_NAME}'))
    and  name = upper('\${DISK_NAME}');
  -- Show remaining disks and their free space
  select name, failgroup, round(free_mb/1024,1) free_gb
  from   v\$asm_disk
  where  group_number = (select group_number from v\$asm_diskgroup where name=upper('\${DG_NAME}'))
    and  name != upper('\${DISK_NAME}')
  order by failgroup, name;
SQLEOF

echo ""
echo "WARNING: Dropping a disk from a NORMAL REDUNDANCY group temporarily reduces fault tolerance."
read -rp "Drop disk \${DISK_NAME} from \${DG_NAME}? (yes/no): " CONFIRM
[[ "\${CONFIRM}" != "yes" ]] && echo "Aborted." && exit 1

echo ""
echo "[2] Initiating disk drop (rebalance power 8)..."
sqlplus / as sysasm <<SQLEOF
ALTER DISKGROUP \${DG_NAME} DROP DISK \${DISK_NAME} REBALANCE POWER 8;

select operation, state, power, sofar, est_work, est_rate, est_minutes
from   v\$asm_operation;
SQLEOF

echo ""
echo "===== Drop initiated. Monitor progress:"
echo "  select operation, state, sofar, est_work, est_minutes from v\\\$asm_operation;"
echo ""
echo "To cancel the drop (before it completes):"
echo "  ALTER DISKGROUP \${DG_NAME} UNDROP DISKS;"
echo ""
echo "Log: \${LOGFILE}"
\`\`\`

---

## Script 5 — Replace a Failed Disk

Use when a disk has entered FORCING or ERROR state after a hardware failure.

\`\`\`bash
#!/bin/bash
# asm_replace_disk.sh  — run as grid user
# Replaces a failed disk with a new one in the same failure group.
# Usage: asm_replace_disk.sh <diskgroup> <failed_disk_name> <new_disk_path>
set -euo pipefail

ORACLE_SID=+ASM
ORACLE_HOME=/u01/app/grid/19.0.0
export ORACLE_SID ORACLE_HOME
PATH=\${ORACLE_HOME}/bin:\${PATH}

DG_NAME=\${1:-""}
OLD_DISK=\${2:-""}
NEW_PATH=\${3:-""}

if [[ -z "\${DG_NAME}" || -z "\${OLD_DISK}" || -z "\${NEW_PATH}" ]]; then
  echo "Usage: \$0 <diskgroup> <old_disk_name> <new_disk_path>"
  echo "Example: \$0 DATA DATA_0003 /dev/oracleasm/disks/DATA_NEW"
  exit 1
fi

LOGFILE=/tmp/asm_replace_disk_\$(date +%Y%m%d_%H%M%S).log
exec > >(tee -a "\${LOGFILE}") 2>&1

echo "===== Replace Disk in \${DG_NAME}: \$(date) ====="

# ── Show current disk state ───────────────────────────────────────────────────
echo "[1] Current state of failed disk"
sqlplus -s / as sysasm <<SQLEOF
  set lines 160 pages 50 feedback off
  select name, failgroup, path, mode_status, state,
         reads, writes, read_errs, write_errs
  from   v\$asm_disk
  where  group_number = (select group_number from v\$asm_diskgroup where name=upper('\${DG_NAME}'))
    and  name = upper('\${OLD_DISK}');
SQLEOF

echo ""
read -rp "Replace \${OLD_DISK} with \${NEW_PATH}? (yes/no): " CONFIRM
[[ "\${CONFIRM}" != "yes" ]] && echo "Aborted." && exit 1

# ── ASMLib: label the new disk first ─────────────────────────────────────────
DEVICE_LABEL=$(basename "\${NEW_PATH}")
echo ""
echo "[2] Labelling new device via ASMLib (requires root or sudo)"
sudo /usr/sbin/oracleasm createdisk "\${DEVICE_LABEL}" "\${NEW_PATH}" || \
  echo "ASMLib label step failed — verify device is visible and not already labelled"
sudo /usr/sbin/oracleasm scandisks

echo ""
echo "[3] Replacing disk (drop + add in single operation with POWER 16)..."
sqlplus / as sysasm <<SQLEOF
-- Drop the failed disk and add the replacement in one statement.
-- The FAILGROUP clause inherits the old disk's failure group automatically.
ALTER DISKGROUP \${DG_NAME}
  DROP DISK \${OLD_DISK}
  ADD DISK '\${NEW_PATH}' NAME \${OLD_DISK}_REPL
  REBALANCE POWER 16;

select operation, state, power, sofar, est_work, est_minutes
from   v\$asm_operation;
SQLEOF

echo ""
echo "===== Disk replacement initiated. Log: \${LOGFILE} ====="
\`\`\`

---

## Script 6 — ASM Metadata Backup

\`\`\`bash
#!/bin/bash
# asm_metadata_backup.sh  — run as grid user
# Back up disk group metadata using asmcmd md_backup.
# Schedule after any disk group structural change.
set -euo pipefail

ORACLE_SID=+ASM
ORACLE_HOME=/u01/app/grid/19.0.0
export ORACLE_SID ORACLE_HOME
PATH=\${ORACLE_HOME}/bin:\${PATH}

BACKUP_DIR=/u01/app/grid/asm_metadata_backups
mkdir -p "\${BACKUP_DIR}"
BACKUP_FILE=\${BACKUP_DIR}/asm_md_backup_\$(date +%Y%m%d_%H%M%S).bkp
LOGFILE=/tmp/asm_md_backup_\$(date +%Y%m%d_%H%M%S).log
exec > >(tee -a "\${LOGFILE}") 2>&1

echo "===== ASM Metadata Backup: \$(date) ====="

# Discover current disk groups
DG_LIST=$(sqlplus -s / as sysasm <<'SQLEOF'
set pages 0 feedback off heading off
select listagg(name,',') within group (order by name) from v$asm_diskgroup where state='MOUNTED';
exit;
SQLEOF
)
DG_LIST=$(echo "\${DG_LIST}" | tr -d ' \n')

echo "Disk groups: \${DG_LIST}"
echo "Backup file: \${BACKUP_FILE}"
echo ""

asmcmd md_backup -G "\${DG_LIST}" "\${BACKUP_FILE}"

echo ""
echo "Backup size: \$(du -h "\${BACKUP_FILE}" | cut -f1)"
echo "===== Metadata backup complete. ====="

# Keep only the last 30 metadata backups
find "\${BACKUP_DIR}" -name "asm_md_backup_*.bkp" -mtime +30 -delete
echo "Old backups cleaned up (kept last 30 days)."
\`\`\`

---

## Script 7 — ASM Health Check and Monitoring (4-Hour Cron)

**SQL script** — save as \`asm_health_check.sql\`:

\`\`\`sql
-- asm_health_check.sql
-- Comprehensive ASM health check.
-- Connect as SYSASM.

set lines 200 pages 100 feedback off trimspool on
col name         format a15
col state        format a12
col type         format a10
col total_gb     format 99990.0
col free_gb      format 99990.0
col usable_gb    format 99990.0
col pct_used     format 990.0
col failgroup    format a20
col path         format a40
col mode_status  format a15
col disk_state   format a12
col operation    format a20
col est_minutes  format 999990

prompt
prompt =============================================================================
prompt ASM Health Check Report
prompt Generated: &_DATE
prompt =============================================================================
prompt

-- ── [1] Disk group space ──────────────────────────────────────────────────────
prompt [1] Disk Group Space Summary
prompt ---------------------------------------------------------------------------
select
  name,
  state,
  type,
  round(total_mb/1024,   1) as total_gb,
  round(free_mb/1024,    1) as free_gb,
  round(usable_file_mb/1024, 1) as usable_gb,
  round((1 - free_mb/nullif(total_mb,0)) * 100, 1) as pct_used
from
  v$asm_diskgroup
order by
  name;

-- ── [2] Disk status ───────────────────────────────────────────────────────────
prompt
prompt [2] Disk Status (non-NORMAL disks flagged first)
prompt ---------------------------------------------------------------------------
select
  dg.name                              as diskgroup,
  d.disk_number,
  d.name,
  d.failgroup,
  d.path,
  d.mode_status,
  d.state                              as disk_state,
  d.read_errs,
  d.write_errs,
  round(d.total_mb/1024, 1)           as total_gb,
  round(d.free_mb/1024,  1)           as free_gb
from
  v$asm_disk    d
  join v$asm_diskgroup dg on d.group_number = dg.group_number
order by
  case d.mode_status when 'ONLINE' then 1 else 0 end,
  dg.name, d.failgroup, d.disk_number;

-- ── [3] Active rebalance operations ──────────────────────────────────────────
prompt
prompt [3] Active Rebalance Operations
prompt ---------------------------------------------------------------------------
select
  group_number,
  operation,
  state,
  power,
  actual,
  sofar,
  est_work,
  est_rate,
  est_minutes
from
  v$asm_operation;

-- ── [4] Disk error counts ─────────────────────────────────────────────────────
prompt
prompt [4] Disks with I/O Errors
prompt ---------------------------------------------------------------------------
select
  dg.name as diskgroup,
  d.name  as disk_name,
  d.failgroup,
  d.read_errs,
  d.write_errs,
  d.mode_status,
  d.state
from
  v$asm_disk    d
  join v$asm_diskgroup dg on d.group_number = dg.group_number
where
  d.read_errs  > 0
  or d.write_errs > 0
  or d.mode_status != 'ONLINE'
  or d.state        != 'NORMAL'
order by
  dg.name, d.disk_number;

-- ── [5] Block change tracking file (per database) ─────────────────────────────
prompt
prompt [5] Block Change Tracking Status (connect to each DB separately)
prompt ---------------------------------------------------------------------------
select status, filename, bytes/1048576 mb
from   v$block_change_tracking;

prompt
prompt =============================================================================
prompt End of ASM Health Check
prompt =============================================================================
exit;
\`\`\`

**Shell monitoring script** — save as \`asm_monitor.sh\`:

\`\`\`bash
#!/bin/bash
# asm_monitor.sh
# Monitors ASM disk group health: space, disk errors, rebalance status.
# Cron: 0 */4 * * * grid /path/to/asm_monitor.sh >> /var/log/oracle/asm/monitor.log 2>&1
#
# Options:
#   --dry-run             Print checks without sending alerts
#   --alert-email ADDR    Alert email address
#   --log-dir PATH        Log directory (default /var/log/oracle/asm)
#   --dg-warn PCT         DG space % to trigger WARNING (default 75)
#   --dg-crit PCT         DG space % to trigger CRITICAL (default 90)

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
DRY_RUN=false
ALERT_EMAIL=\${ALERT_EMAIL:-""}
LOG_DIR=\${LOG_DIR:-/var/log/oracle/asm}
DG_WARN_PCT=75
DG_CRIT_PCT=90
ORACLE_SID=\${ORACLE_SID:-+ASM}
ORACLE_HOME=\${ORACLE_HOME:-/u01/app/grid/19.0.0}

while [[ \$# -gt 0 ]]; do
  case "\$1" in
    --dry-run)       DRY_RUN=true ;;
    --alert-email)   ALERT_EMAIL="\$2"; shift ;;
    --log-dir)       LOG_DIR="\$2"; shift ;;
    --dg-warn)       DG_WARN_PCT="\$2"; shift ;;
    --dg-crit)       DG_CRIT_PCT="\$2"; shift ;;
    *) echo "Unknown option: \$1"; exit 1 ;;
  esac
  shift
done

export ORACLE_SID ORACLE_HOME
PATH=\${ORACLE_HOME}/bin:\${PATH}

mkdir -p "\${LOG_DIR}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOGFILE=\${LOG_DIR}/asm_monitor_\${TIMESTAMP}.log
SUMMARY_FILE=\${LOG_DIR}/asm_summary_\${TIMESTAMP}.txt
SCRIPT_DIR=$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)
SQL_SCRIPT=\${SCRIPT_DIR}/asm_health_check.sql

exec > >(tee -a "\${LOGFILE}") 2>&1

echo "============================================================"
echo "ASM Monitor — \$(date '+%Y-%m-%d %H:%M:%S')"
echo "ASM SID  : \${ORACLE_SID}"
echo "Dry run  : \${DRY_RUN}"
echo "Log      : \${LOGFILE}"
echo "============================================================"

ALERTS=()

# ════════════════════════════════════════════════════════════════
# STEP 1: DISK GROUP SPACE
# ════════════════════════════════════════════════════════════════
echo ""
echo "── Step 1: Disk Group Space ─────────────────────────────────"

while IFS='|' read -r DG_NAME DG_PCT DG_TOTAL DG_FREE; do
  DG_NAME=$(echo "\${DG_NAME}" | tr -d ' ')
  DG_PCT=$(echo "\${DG_PCT}"   | tr -d ' ')
  DG_TOTAL=$(echo "\${DG_TOTAL}" | tr -d ' ')
  DG_FREE=$(echo "\${DG_FREE}"  | tr -d ' ')
  [[ -z "\${DG_NAME}" ]] && continue

  echo "[INFO] \${DG_NAME}: \${DG_PCT}% used (\${DG_FREE} GB free of \${DG_TOTAL} GB)"

  if awk "BEGIN {exit !(\${DG_PCT} >= \${DG_CRIT_PCT})}"; then
    echo "[CRITICAL] \${DG_NAME} at \${DG_PCT}% — critical threshold \${DG_CRIT_PCT}%"
    ALERTS+=("CRITICAL: Disk group \${DG_NAME} at \${DG_PCT}% (threshold: \${DG_CRIT_PCT}%)")
  elif awk "BEGIN {exit !(\${DG_PCT} >= \${DG_WARN_PCT})}"; then
    echo "[WARNING] \${DG_NAME} at \${DG_PCT}% — warning threshold \${DG_WARN_PCT}%"
    ALERTS+=("WARNING: Disk group \${DG_NAME} at \${DG_PCT}% (threshold: \${DG_WARN_PCT}%)")
  else
    echo "[OK] \${DG_NAME}: \${DG_PCT}% used — within thresholds"
  fi
done < <(sqlplus -s "/ as sysasm" <<'SQLEOF'
set pages 0 feedback off heading off colsep '|'
select name,
       round((1 - free_mb/nullif(total_mb,0)) * 100, 1),
       round(total_mb/1024, 1),
       round(free_mb/1024,  1)
from   v$asm_diskgroup
where  state = 'MOUNTED';
exit;
SQLEOF
)

# ════════════════════════════════════════════════════════════════
# STEP 2: DISK STATUS — CHECK FOR ERRORS OR OFFLINE DISKS
# ════════════════════════════════════════════════════════════════
echo ""
echo "── Step 2: Disk Status ──────────────────────────────────────"

PROBLEM_DISK_COUNT=$(sqlplus -s "/ as sysasm" <<'SQLEOF'
set pages 0 feedback off heading off
select count(*)
from   v$asm_disk
where  mode_status != 'ONLINE'
   or  state       != 'NORMAL'
   or  read_errs    > 0
   or  write_errs   > 0;
exit;
SQLEOF
)
PROBLEM_DISK_COUNT=$(echo "\${PROBLEM_DISK_COUNT}" | tr -d ' \n')

if [[ "\${PROBLEM_DISK_COUNT}" -gt 0 ]]; then
  echo "[CRITICAL] \${PROBLEM_DISK_COUNT} disk(s) with errors or non-NORMAL state"
  ALERTS+=("CRITICAL: \${PROBLEM_DISK_COUNT} ASM disk(s) in error or offline state")
  sqlplus -s "/ as sysasm" <<'SQLEOF'
    set lines 180 pages 50 feedback off
    col diskgroup format a12
    col name      format a20
    col failgroup format a20
    col mode_status format a12
    col state format a10
    select dg.name as diskgroup, d.name, d.failgroup,
           d.mode_status, d.state, d.read_errs, d.write_errs
    from   v$asm_disk d join v$asm_diskgroup dg on d.group_number = dg.group_number
    where  d.mode_status != 'ONLINE' or d.state != 'NORMAL'
           or d.read_errs > 0 or d.write_errs > 0;
    exit;
SQLEOF
else
  echo "[OK] All ASM disks are ONLINE/NORMAL with zero I/O errors"
fi

# ════════════════════════════════════════════════════════════════
# STEP 3: ACTIVE REBALANCE OPERATIONS
# ════════════════════════════════════════════════════════════════
echo ""
echo "── Step 3: Active Rebalance Operations ─────────────────────"

REBAL_COUNT=$(sqlplus -s "/ as sysasm" <<'SQLEOF'
set pages 0 feedback off heading off
select count(*) from v$asm_operation;
exit;
SQLEOF
)
REBAL_COUNT=$(echo "\${REBAL_COUNT}" | tr -d ' \n')

if [[ "\${REBAL_COUNT}" -gt 0 ]]; then
  echo "[INFO] \${REBAL_COUNT} rebalance operation(s) in progress"
  sqlplus -s "/ as sysasm" <<'SQLEOF'
    set lines 160 pages 50 feedback off
    select group_number, operation, state, power, sofar, est_work, est_rate, est_minutes
    from   v$asm_operation;
    exit;
SQLEOF
else
  echo "[OK] No active rebalance operations"
fi

# ════════════════════════════════════════════════════════════════
# STEP 4: DISMOUNTED OR RESTRICTED DISK GROUPS
# ════════════════════════════════════════════════════════════════
echo ""
echo "── Step 4: Disk Group Mount State ──────────────────────────"

BAD_DG_COUNT=$(sqlplus -s "/ as sysasm" <<'SQLEOF'
set pages 0 feedback off heading off
select count(*) from v$asm_diskgroup where state != 'MOUNTED';
exit;
SQLEOF
)
BAD_DG_COUNT=$(echo "\${BAD_DG_COUNT}" | tr -d ' \n')

if [[ "\${BAD_DG_COUNT}" -gt 0 ]]; then
  echo "[CRITICAL] \${BAD_DG_COUNT} disk group(s) not in MOUNTED state"
  ALERTS+=("CRITICAL: \${BAD_DG_COUNT} disk group(s) not MOUNTED — databases may be affected")
  sqlplus -s "/ as sysasm" <<'SQLEOF'
    set lines 120 pages 50 feedback off
    select name, state, type from v$asm_diskgroup where state != 'MOUNTED';
    exit;
SQLEOF
else
  echo "[OK] All disk groups are MOUNTED"
fi

# ════════════════════════════════════════════════════════════════
# STEP 5: FULL SQL REPORT
# ════════════════════════════════════════════════════════════════
echo ""
echo "── Step 5: Full SQL Report ──────────────────────────────────"

SQL_LOG=\${LOG_DIR}/sql_report_\${TIMESTAMP}.log

if [[ -f "\${SQL_SCRIPT}" ]]; then
  if [[ "\${DRY_RUN}" == "true" ]]; then
    echo "[DRY-RUN] Would run: sqlplus / as sysasm @\${SQL_SCRIPT}"
  else
    sqlplus -s "/ as sysasm" @"\${SQL_SCRIPT}" > "\${SQL_LOG}" 2>&1 || true
    echo "[INFO] SQL report written to: \${SQL_LOG}"
    cat "\${SQL_LOG}"
  fi
else
  echo "[WARN] asm_health_check.sql not found at \${SQL_SCRIPT}"
  ALERTS+=("WARNING: asm_health_check.sql not found — SQL report skipped")
fi

# ════════════════════════════════════════════════════════════════
# SUMMARY AND ALERT
# ════════════════════════════════════════════════════════════════
echo ""
echo "============================================================"
echo "SUMMARY — \$(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================================"

{
  echo "ASM Monitor Summary — \$(date '+%Y-%m-%d %H:%M:%S')"
  echo "Host     : \$(hostname)"
  echo "ASM SID  : \${ORACLE_SID}"
  echo ""
  if [[ \${#ALERTS[@]} -eq 0 ]]; then
    echo "STATUS: OK — no issues detected"
    echo ""
    echo "  Disk groups : all MOUNTED"
    echo "  Disks       : all ONLINE/NORMAL, zero I/O errors"
    echo "  Rebalance   : \${REBAL_COUNT} active operation(s)"
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

if [[ \${#ALERTS[@]} -gt 0 ]] && [[ -n "\${ALERT_EMAIL}" ]]; then
  SUBJECT="[ASM ALERT] \$(hostname) — \${#ALERTS[@]} issue(s) \$(date '+%Y-%m-%d %H:%M')"
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

## Cron Setup

\`\`\`bash
mkdir -p /u01/app/grid/scripts/asm_monitor
cp asm_monitor.sh asm_health_check.sql asm_metadata_backup.sh \
   /u01/app/grid/scripts/asm_monitor/
chmod 750 /u01/app/grid/scripts/asm_monitor/*.sh
chmod 640 /u01/app/grid/scripts/asm_monitor/*.sql

mkdir -p /var/log/oracle/asm
chown grid:oinstall /var/log/oracle/asm

crontab -e -u grid
\`\`\`

\`\`\`
# ASM Monitoring — every 4 hours
0 */4 * * *  ORACLE_SID=+ASM ORACLE_HOME=/u01/app/grid/19.0.0 ALERT_EMAIL=dba@example.com /u01/app/grid/scripts/asm_monitor/asm_monitor.sh

# ASM Metadata Backup — daily at 03:00
0 3 * * *  ORACLE_SID=+ASM ORACLE_HOME=/u01/app/grid/19.0.0 /u01/app/grid/scripts/asm_monitor/asm_metadata_backup.sh
\`\`\`

---

## Log Rotation

\`\`\`
# /etc/logrotate.d/oracle-asm-monitor
/var/log/oracle/asm/*.log {
    daily
    rotate 30
    compress
    missingok
    notifempty
    create 0640 grid oinstall
}
\`\`\`

---

## Common Issues and Fixes

### ORA-15032: not all alterations performed

Usually accompanies a more specific ORA- error. Check \`V\$ASM_DISK\` for disks in FORCING mode and the ASM alert log at \`\$ORACLE_BASE/diag/asm/+asm/\${ORACLE_SID}/trace/alert_\${ORACLE_SID}.log\`.

### Disk group will not mount after reboot

\`\`\`bash
# Re-scan ASM disks (ASMLib)
sudo /usr/sbin/oracleasm scandisks
# Then mount the disk group
sqlplus / as sysasm
ALTER DISKGROUP DATA MOUNT;
\`\`\`

### Rebalance running at power 1 — taking too long

\`\`\`sql
-- Increase power on a running rebalance
ALTER DISKGROUP DATA REBALANCE POWER 8;
\`\`\`

### FRA disk group full — archived logs not purging

\`\`\`bash
# Connect to the database (not ASM) and delete obsolete RMAN files
rman target /
DELETE NOPROMPT OBSOLETE;
DELETE NOPROMPT ARCHIVELOG ALL BACKED UP 2 TIMES TO DISK;
\`\`\`

Then increase FRA size if needed:

\`\`\`sql
-- In the database instance (not ASM)
ALTER SYSTEM SET db_recovery_file_dest_size = 400G;
\`\`\`
`,
};

async function main() {
  await db.insert(posts).values(blogPost);
  console.log('inserted:', blogPost.slug);

  await db.insert(posts).values(runbookPost);
  console.log('inserted:', runbookPost.slug);
}

main().catch(console.error);
