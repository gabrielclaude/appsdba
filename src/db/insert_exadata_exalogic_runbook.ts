import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Exadata Health Checks, Smart Scan Validation, and Exalogic WebLogic Administration',
  slug: 'exadata-exalogic-administration-runbook',
  excerpt:
    'Step-by-step administration runbook for Oracle Exadata and Exalogic — covering Exadata cell health checks via cellcli and dcli, Smart Scan eligibility validation, Storage Index effectiveness, IORM configuration, HCC compression verification, Exalogic WebLogic cluster health, ZFSSA NFS mount validation, and a daily health check script.',
  category: 'exadata' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-11'),
  youtubeUrl: null,
  content: `## Environment Assumptions

| Component | Details |
|-----------|---------|
| Exadata model | X8M or later (procedures apply to X6M+) |
| DB nodes | db01–db08 (adjust for your rack size) |
| Storage cells | cell01–cell14 (full rack) |
| Cell group file | /opt/oracle.SupportTools/hostgroups/cell_group |
| DB group file | /opt/oracle.SupportTools/hostgroups/dbs_group |
| Oracle SID | PRODDB (RAC: PRODDB1, PRODDB2, ...) |
| Exalogic nodes | exa01–exa30 |
| ZFSSA hosts | zfs01, zfs02 |

All cell CLI commands run as \`root\` on the cell. All DB node commands run as \`oracle\` unless noted.

---

## Part 1: Exadata Health Checks

### 1.1 Overall Exadata System Status

\`\`\`bash
# Run on any DB node — checks the full Exadata stack
exacheck run all

# Or run a specific check category
exacheck run --category storage
exacheck run --category database
exacheck run --category network

# View last run results
exacheck report
\`\`\`

\`exacheck\` is Oracle's Exadata health check framework. It runs hundreds of checks covering hardware, software versions, configuration, and best practices. Run it before and after any patching.

### 1.2 Storage Cell Status via dcli

\`\`\`bash
# Run from a DB node — checks all cells simultaneously
dcli -g /opt/oracle.SupportTools/hostgroups/cell_group \
  cellcli -e "LIST CELL ATTRIBUTES name, status, cellVersion, makeModel"

# Check for any cell alerts
dcli -g /opt/oracle.SupportTools/hostgroups/cell_group \
  cellcli -e "LIST ALERTHISTORY WHERE severity='critical' OR severity='warning'"

# Check all cell disks
dcli -g /opt/oracle.SupportTools/hostgroups/cell_group \
  cellcli -e "LIST CELLDISK ATTRIBUTES name, diskType, status, size"

# Check flash disks specifically
dcli -g /opt/oracle.SupportTools/hostgroups/cell_group \
  cellcli -e "LIST FLASHDISK ATTRIBUTES name, status, size, physicalSize"
\`\`\`

### 1.3 Individual Cell Deep Check

SSH to a cell and run detailed checks:

\`\`\`bash
ssh root@cell01
cellcli

# Full cell detail
CellCLI> LIST CELL DETAIL

# Check all grid disks (presented to ASM)
CellCLI> LIST GRIDDISK ATTRIBUTES name, asmDiskGroupName, asmModeName, status, size

# Flash cache statistics
CellCLI> LIST FLASHCACHE DETAIL

# Cell interconnect metrics (InfiniBand)
CellCLI> LIST INTERCONNECT ATTRIBUTES name, ipAddress, status, statistics

# Check for pending disk replacements
CellCLI> LIST PHYSICALDISK ATTRIBUTES name, status, diskType, makeModel WHERE status != 'normal'
\`\`\`

### 1.4 Check Disk Group Status (ASM)

\`\`\`sql
-- On a DB node, connect to the ASM instance
export ORACLE_SID=+ASM1
sqlplus / as sysasm

-- Disk group status and usage
SELECT group_number, name, state, type,
       ROUND(total_mb/1024, 0) AS total_gb,
       ROUND(free_mb/1024, 0)  AS free_gb,
       ROUND((1 - free_mb/total_mb) * 100, 1) AS used_pct
FROM   v\$asm_diskgroup
ORDER BY name;

-- Check for offline or missing disks
SELECT group_number, disk_number, name, state, mode_status, path, total_mb
FROM   v\$asm_disk
WHERE  state != 'NORMAL'
ORDER BY group_number, disk_number;

-- Rebalance operations in progress
SELECT group_number, operation, state, power, est_minutes
FROM   v\$asm_operation;
\`\`\`

---

## Part 2: Smart Scan Validation

### 2.1 Verify Smart Scan Is Active for a Query

\`\`\`sql
-- Connect to the Oracle Database
sqlplus / as sysdba

-- Enable SQL trace and run a full table scan query
ALTER SESSION SET EVENTS '10046 trace name context forever, level 12';
ALTER SESSION SET tracefile_identifier = 'smartscan_test';

SELECT COUNT(*), SUM(amount) FROM sales WHERE sale_date > DATE '2025-01-01';

ALTER SESSION SET EVENTS '10046 trace name context off';
\`\`\`

In the execution plan, look for \`TABLE ACCESS STORAGE FULL\` — the word STORAGE confirms Smart Scan:

\`\`\`sql
-- Check via DBMS_XPLAN
EXPLAIN PLAN FOR
SELECT COUNT(*), SUM(amount) FROM sales WHERE sale_date > DATE '2025-01-01';

SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY);
-- Look for: TABLE ACCESS STORAGE FULL
-- NOT:      TABLE ACCESS FULL  (non-Smart Scan)
\`\`\`

### 2.2 Smart Scan Effectiveness Statistics

\`\`\`sql
-- Session-level Smart Scan stats after running a query
SELECT name, value
FROM   v\$mystat ms
JOIN   v\$statname sn ON ms.statistic# = sn.statistic#
WHERE  sn.name IN (
    'cell physical IO bytes eligible for predicate offload',
    'cell physical IO bytes saved by storage index',
    'cell physical IO interconnect bytes returned by smart scan',
    'cell physical IO bytes eligible for smart IO',
    'cell scans',
    'cell blocks processed by cache layer',
    'cell blocks processed by data layer',
    'cell blocks processed by txn layer'
)
ORDER BY sn.name;
\`\`\`

Key ratios to evaluate:
- **Offload ratio** = \`bytes returned by smart scan\` / \`bytes eligible for predicate offload\` — lower is better (less data returned to DB node)
- **Storage Index savings** = \`bytes saved by storage index\` / \`bytes eligible\` — higher means more regions skipped

### 2.3 Diagnose Why Smart Scan Is Not Firing

\`\`\`sql
-- Check if the table is in the buffer cache (Smart Scan bypasses cache)
SELECT COUNT(*) FROM v\$bh b
JOIN dba_objects o ON b.objd = o.data_object_id
WHERE o.object_name = 'SALES';
-- If count is high, table is cached — Smart Scan may not fire

-- Check if there are chained/migrated rows (prevents Smart Scan)
ANALYZE TABLE sales COMPUTE STATISTICS;
SELECT num_rows, chain_cnt FROM user_tables WHERE table_name = 'SALES';
-- chain_cnt > 0 means row chaining present — run: ALTER TABLE sales MOVE;

-- Check if the table uses an unsupported data type for offload
-- LOBs stored out-of-line prevent Smart Scan on those columns
SELECT column_name, data_type FROM user_tab_columns
WHERE table_name = 'SALES'
  AND data_type IN ('BLOB','CLOB','NCLOB','XMLTYPE','VARRAY');
\`\`\`

---

## Part 3: Storage Index Effectiveness

Storage Indexes are automatic — but you can monitor whether they are saving I/O.

\`\`\`sql
-- Instance-level Storage Index savings (since last restart)
SELECT name, value
FROM v\$sysstat
WHERE name IN (
    'cell physical IO bytes saved by storage index',
    'cell physical IO bytes eligible for predicate offload'
);
-- bytes saved / bytes eligible = Storage Index effectiveness ratio

-- Storage Index column statistics per cell (requires cell metrics)
-- Run from cellcli on each cell:
-- CellCLI> LIST METRICCURRENT WHERE metricObjectName LIKE 'SI_%'
\`\`\`

### Reset Storage Indexes (use only in testing)

\`\`\`bash
# Storage Indexes can be invalidated by running an undocumented event
# This forces them to be rebuilt on the next full scan
# DO NOT run in production without Oracle Support guidance
# alter session set events 'cell_offload_processing off';
\`\`\`

---

## Part 4: IORM Configuration

IORM (I/O Resource Manager) controls how storage I/O is shared across databases on the same Exadata system.

### 4.1 Check Current IORM Plan

\`\`\`bash
# On any cell
ssh root@cell01
cellcli

CellCLI> LIST IORMPLAN DETAIL
\`\`\`

### 4.2 Configure a Basic IORM Plan

\`\`\`bash
# Set up IORM on all cells via dcli
# This example gives PRODDB 60% of I/O, TESTDB 20%, and leaves 20% for other DBs

dcli -g /opt/oracle.SupportTools/hostgroups/cell_group cellcli -e "
ALTER IORMPLAN
  dbPlan = ((name=PRODDB, level=1, allocation=60),
             (name=TESTDB,  level=1, allocation=20),
             (name=other,   level=1, allocation=20)),
  objective = auto"
\`\`\`

### 4.3 Monitor IORM Effectiveness

\`\`\`sql
-- DB node: check I/O wait by consumer group
SELECT consumer_group_name, requests, io_service_time_ms, wait_time_ms
FROM   v\$iorm_consumer_group_stats
ORDER BY io_service_time_ms DESC;
\`\`\`

---

## Part 5: HCC Compression Verification

### 5.1 Check Current Compression on a Table

\`\`\`sql
SELECT table_name, compression, compress_for
FROM   user_tables
WHERE  table_name = 'SALES_ARCHIVE';
-- compress_for = 'QUERY HIGH' / 'ARCHIVE HIGH' etc.

-- Row-level compression ratio (samples 5% of the table)
SELECT DBMS_COMPRESSION.GET_COMPRESSION_RATIO(
    scratchtbsname  => 'TEMP',
    ownname         => 'SALES',
    tabname         => 'SALES_ARCHIVE',
    partname        => NULL,
    comptype        => DBMS_COMPRESSION.COMP_QUERY_HIGH,
    blkcnt_cmp      => :blk_cmp,
    blkcnt_uncmp    => :blk_uncmp,
    row_cmp         => :row_cmp,
    row_uncmp       => :row_uncmp,
    cmp_ratio       => :ratio,
    comptype_str    => :type_str,
    subset_numrows  => DBMS_COMPRESSION.COMP_RATIO_MINROWS,
    objtype         => DBMS_COMPRESSION.OBJTYPE_TABLE
) FROM dual;
\`\`\`

### 5.2 Apply HCC to an Existing Table

\`\`\`sql
-- Online redefinition via DBMS_REDEFINITION (zero downtime for large tables)
-- Or for offline:
ALTER TABLE sales_archive MOVE COMPRESS FOR QUERY HIGH;

-- Re-create indexes after MOVE
ALTER INDEX sales_archive_pk REBUILD;
ALTER INDEX sales_archive_date_idx REBUILD;
\`\`\`

---

## Part 6: Exalogic WebLogic Cluster Health Checks

### 6.1 Verify All Managed Servers Are Running

\`\`\`bash
# From a DB node that can reach Exalogic management network
# Or directly from an Exalogic compute node

# WLST-based cluster status check
cat > /tmp/check_cluster.py << 'EOF'
connect('weblogic', 'password', 't3://exa01:7001')
domainRuntime()
cd('ServerRuntimes')
servers = cmo.getServerRuntimes()
for s in servers:
    print(s.getName() + ' | ' + s.getState() + ' | ' + s.getHealthState().getState())
disconnect()
EOF

java -classpath \$WL_HOME/server/lib/weblogic.jar weblogic.WLST /tmp/check_cluster.py
\`\`\`

### 6.2 Check ZFSSA NFS Mounts on All Compute Nodes

\`\`\`bash
# Run on all Exalogic compute nodes via parallel SSH
# Verify the shared domain directory is mounted
for node in exa01 exa02 exa03; do
    echo -n "\$node: "
    ssh oracle@\$node "df -h /u01/oracle/domains | tail -1"
done

# Check NFS mount options (should include rsize/wsize tuned for InfiniBand)
ssh oracle@exa01 "mount | grep zfs"
# Expected options: rw,bg,hard,nointr,rsize=1048576,wsize=1048576,tcp,actimeo=0
\`\`\`

### 6.3 Coherence Cache Cluster Status

\`\`\`bash
# On an Exalogic compute node running Coherence
# Use the Coherence management API or jconsole to check cluster membership

# Quick check via the Coherence command-line tool
\$COHERENCE_HOME/bin/cohql <<'EOF'
select * from "com.tangosol.net.management:type=Cluster";
quit
EOF

# Or via WLST if using Coherence Web
cat > /tmp/check_coherence.py << 'EOF'
connect('weblogic', 'password', 't3://exa01:7001')
custom()
cd('com.bea.wls.replication:Type=CoherenceClusterSystemRuntime')
state = cmo.getClusterState()
size = cmo.getClusterSize()
print('Coherence cluster state: ' + str(state))
print('Cluster size (nodes): ' + str(size))
disconnect()
EOF

java -classpath \$WL_HOME/server/lib/weblogic.jar weblogic.WLST /tmp/check_coherence.py
\`\`\`

---

## Part 7: Daily Exadata Health Check Script

\`\`\`bash
#!/bin/bash
# /home/oracle/scripts/exadata_daily_check.sh
# Run on a DB node — comprehensive daily health check
# Requires: oracle user, cell_group file, dcli in PATH

CELL_GROUP="/opt/oracle.SupportTools/hostgroups/cell_group"
DB_GROUP="/opt/oracle.SupportTools/hostgroups/dbs_group"
LOG_DIR="/home/oracle/scripts/logs"
REPORT="\${LOG_DIR}/exadata_daily_\$(date +%Y%m%d).txt"
EMAIL="dba-alerts@corp.local"
ALERT_FOUND=0

mkdir -p "\$LOG_DIR"
exec > >(tee "\$REPORT") 2>&1

log() { echo "\$(date '+%Y-%m-%d %H:%M:%S') [\${1:-INFO}] \$2"; }

echo "========================================"
echo "Exadata Daily Health Check: \$(date)"
echo "Host: \$(hostname)"
echo "========================================"

# --- 1. Cell status ---
echo ""
echo "=== STORAGE CELL STATUS ==="
dcli -g "\$CELL_GROUP" cellcli -e \
  "LIST CELL ATTRIBUTES name, status, cellVersion" 2>&1

CELL_ERRORS=\$(dcli -g "\$CELL_GROUP" cellcli -e \
  "LIST CELL ATTRIBUTES status" 2>/dev/null \
  | grep -v "normal" | grep -v "^$")

if [[ -n "\$CELL_ERRORS" ]]; then
    log CRITICAL "Cell status errors detected:"
    echo "\$CELL_ERRORS"
    ALERT_FOUND=1
fi

# --- 2. Disk status ---
echo ""
echo "=== DISK STATUS (non-normal only) ==="
DISK_ERRORS=\$(dcli -g "\$CELL_GROUP" cellcli -e \
  "LIST CELLDISK ATTRIBUTES name, status WHERE status != 'normal'" 2>/dev/null \
  | grep -v "^$")

if [[ -n "\$DISK_ERRORS" ]]; then
    log CRITICAL "Disk errors detected:"
    echo "\$DISK_ERRORS"
    ALERT_FOUND=1
else
    log INFO "All cell disks: normal"
fi

# --- 3. Cell alerts ---
echo ""
echo "=== CELL ALERTS (last 24 hours) ==="
ALERTS=\$(dcli -g "\$CELL_GROUP" cellcli -e \
  "LIST ALERTHISTORY WHERE alertTime > '\$(date -d '24 hours ago' '+%Y-%m-%dT%H:%M:%S')'" \
  2>/dev/null | grep -v "^$")

if [[ -n "\$ALERTS" ]]; then
    log WARN "Cell alerts in last 24 hours:"
    echo "\$ALERTS"
    ALERT_FOUND=1
else
    log INFO "No cell alerts in last 24 hours"
fi

# --- 4. ASM disk group status ---
echo ""
echo "=== ASM DISK GROUP STATUS ==="
export ORACLE_SID=+ASM1
sqlplus -s / as sysasm <<'SQL'
SET LINESIZE 120 PAGESIZE 50
COLUMN name FORMAT A20
COLUMN state FORMAT A10
COLUMN type FORMAT A8

SELECT name, state, type,
       ROUND(total_mb/1024,0) AS total_gb,
       ROUND(free_mb/1024,0)  AS free_gb,
       ROUND((1-free_mb/total_mb)*100,1) AS used_pct
FROM v\$asm_diskgroup
ORDER BY name;

SELECT COUNT(*) AS offline_disks FROM v\$asm_disk WHERE state != 'NORMAL';
EXIT 0;
SQL

# --- 5. Database instance status ---
echo ""
echo "=== DATABASE INSTANCE STATUS ==="
export ORACLE_SID=PRODDB1
sqlplus -s / as sysdba <<'SQL'
SET LINESIZE 100 PAGESIZE 10
SELECT instance_name, host_name, status, database_status
FROM   v\$instance;

SELECT COUNT(*) AS open_cursors FROM v\$open_cursor;
EXIT 0;
SQL

# --- 6. Smart Scan statistics ---
echo ""
echo "=== SMART SCAN STATISTICS (since instance start) ==="
sqlplus -s / as sysdba <<'SQL'
SET PAGESIZE 0 LINESIZE 100
SELECT name,
       CASE WHEN value > 1073741824
            THEN ROUND(value/1073741824,1) || ' GB'
            WHEN value > 1048576
            THEN ROUND(value/1048576,1) || ' MB'
            ELSE value || ' bytes'
       END AS formatted_value
FROM v\$sysstat
WHERE name IN (
    'cell physical IO bytes eligible for predicate offload',
    'cell physical IO bytes saved by storage index',
    'cell physical IO interconnect bytes returned by smart scan'
)
ORDER BY name;
EXIT 0;
SQL

# --- 7. Top tablespaces by usage ---
echo ""
echo "=== TABLESPACE USAGE (>70% full) ==="
sqlplus -s / as sysdba <<'SQL'
SET LINESIZE 100 PAGESIZE 50
COLUMN tablespace_name FORMAT A30
SELECT tablespace_name,
       ROUND(used_percent,1) AS used_pct,
       ROUND((used_space * 8192)/1073741824, 1) AS used_gb,
       ROUND((tablespace_size * 8192)/1073741824, 1) AS total_gb
FROM dba_tablespace_usage_metrics
WHERE used_percent > 70
  AND contents != 'TEMPORARY'
ORDER BY used_percent DESC;
EXIT 0;
SQL

# --- 8. IORM plan status ---
echo ""
echo "=== IORM PLAN STATUS ==="
dcli -g "\$CELL_GROUP" -l root cellcli -e \
  "LIST IORMPLAN ATTRIBUTES name, status, objective" 2>/dev/null | head -20

# --- 9. Flash cache hit rate ---
echo ""
echo "=== FLASH CACHE STATISTICS ==="
dcli -g "\$CELL_GROUP" -l root cellcli -e \
  "LIST FLASHCACHECONTENT ATTRIBUTES name, hitCount, missCount WHERE hitCount > 0" \
  2>/dev/null | head -30

# --- Summary ---
echo ""
echo "========================================"
if [[ \$ALERT_FOUND -eq 1 ]]; then
    log CRITICAL "Issues detected — review report: \$REPORT"
    echo "Exadata daily health check ALERTS found on \$(hostname)" \
        | mail -s "Exadata Daily Check: ALERTS" "\$EMAIL"
else
    log INFO "All checks passed"
fi
echo "Report: \$REPORT"
echo "========================================"
\`\`\`

\`\`\`bash
# Crontab (oracle user on a DB node)
# 0 7 * * * /home/oracle/scripts/exadata_daily_check.sh
\`\`\`

---

## Part 8: Exadata Patching Overview

### Pre-Patch Checklist

\`\`\`bash
# 1. Run exacheck to establish a baseline
exacheck run all > /home/oracle/scripts/logs/pre_patch_exacheck_\$(date +%Y%m%d).txt

# 2. Verify ASM disk groups are healthy
sqlplus -s / as sysasm <<'SQL'
SELECT name, state FROM v\$asm_diskgroup WHERE state != 'MOUNTED';
SELECT name, state FROM v\$asm_disk WHERE state != 'NORMAL';
EXIT 0;
SQL

# 3. Take an RMAN backup before patching
rman target / <<'EOF'
BACKUP DATABASE PLUS ARCHIVELOG;
EXIT;
EOF

# 4. Verify patch compatibility
# Download the Exadata Bundle Patch from My Oracle Support
# Check the README for supported upgrade paths from your current version
dcli -g /opt/oracle.SupportTools/hostgroups/cell_group \
  cellcli -e "LIST CELL ATTRIBUTES name, cellVersion"
\`\`\`

### Rolling Cell Patch (one cell at a time)

\`\`\`bash
# On each cell — rolling patch, one cell at a time
ssh root@cell01
/opt/oracle.SupportTools/patchmgr \
  -cells /root/cells.lst \
  -patch_check_prereq

/opt/oracle.SupportTools/patchmgr \
  -cells /root/cell01.lst \
  -patch

# Verify after each cell
cellcli -e "LIST CELL ATTRIBUTES name, cellVersion, status"
\`\`\`

---

## Troubleshooting Reference

| Symptom | Where to Check | Action |
|---------|---------------|--------|
| Smart Scan not firing (\`TABLE ACCESS FULL\` instead of \`STORAGE FULL\`) | v\$sql execution plan | Check table is on Exadata cells, no chained rows, direct path scan |
| Cell disk in ERROR state | \`cellcli LIST CELLDISK WHERE status='error'\` | Open SR with Oracle — likely disk replacement needed |
| ASM disk offline | \`v\$asm_disk WHERE state != 'NORMAL'\` | Check cell disk status; disk may need offline replacement |
| IORM causing I/O throttling | \`v\$iorm_consumer_group_stats\` | Review IORM plan allocations; increase share for affected DB |
| Flash cache miss rate high | \`cellcli LIST FLASHCACHE DETAIL\` | Flash cache may be undersized relative to working set; check buffer cache hit rate |
| Exalogic NFS mount lost | \`df -h /u01/oracle/domains\` on compute node | Remount: \`mount -a\`; check ZFSSA availability |
| Coherence cache split-brain | Coherence management MBean \`ClusterState\` | Restart the Coherence cache cluster node with split; allow it to rejoin |`,
};

async function main() {
  console.log('Inserting Exadata/Exalogic administration runbook...');
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
