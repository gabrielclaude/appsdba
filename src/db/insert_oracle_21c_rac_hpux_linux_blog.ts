import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle 21c RAC Migration: HP-UX to RHEL 9 — Topology, Strategy, and Operations',
  slug: 'oracle-21c-rac-hpux-to-rhel9-migration',
  excerpt:
    'A technical deep-dive into migrating Oracle RAC from HP-UX (big-endian) to Oracle 21c on RHEL 9 (little-endian x86_64). Covers endian conversion strategy, RAC topology on Linux, Grid Infrastructure setup, cross-platform transportable tablespace migration, and a complete health monitoring script with crontab scheduling.',
  category: 'rac-clusterware' as const,
  isPremium: false,
  published: true,
  publishedAt: new Date('2026-06-19'),
  content: `Migrating Oracle RAC from HP-UX to Red Hat Enterprise Linux 9 is one of the most technically demanding infrastructure projects an Oracle DBA can undertake. It combines a platform migration (RISC to x86_64), an endian conversion (big-endian to little-endian), a major version upgrade (typically from 11gR2 or 12c on HP-UX to 21c on Linux), and a clustering architecture rebuild — all while minimizing downtime on a system that is almost certainly business-critical. This post walks through the strategic framework, the RAC topology on the Linux side, and the operational baseline you need to keep the new environment healthy after cutover.

---

## Why HP-UX to RHEL 9?

HP-UX on Itanium has been in end-of-life trajectory since Oracle announced in 2019 that Itanium certifications for Oracle Database would not extend past 12c Release 2. Organizations still running Oracle on HP-UX PA-RISC or Itanium face a hard wall: no 19c, no 21c, no further patches. The migration to Linux is not optional — it is a platform survival requirement.

RHEL 9 on x86_64 is the preferred landing zone for Oracle 21c RAC for several reasons:

- Oracle 21c is certified on RHEL 9 with full RAC support
- x86_64 commodity hardware costs a fraction of equivalent Itanium iron
- Oracle Grid Infrastructure 21c on Linux has mature tooling, active community, and broad DBA expertise
- RHEL 9 ships with kernel 5.14+ which satisfies Oracle 21c requirements out of the box with minor parameter tuning

The central technical challenge is the **endian mismatch**. HP-UX (both PA-RISC and Itanium) stores Oracle datafiles in big-endian byte order. RHEL 9 x86_64 uses little-endian. You cannot copy a datafile from HP-UX and mount it on Linux — the bytes are literally backwards. Every migration approach must account for this conversion.

---

## Migration Strategy Options

### Option 1 — Cross-Platform Transportable Tablespaces (XTTS) with RMAN

The recommended approach for large databases (1 TB+) with a limited downtime window. XTTS allows you to convert and transfer tablespace datafiles incrementally while the source database remains open. Only the final delta requires downtime.

The process:
1. Run RMAN CONVERT TABLESPACE on HP-UX to produce platform-neutral datafiles
2. Transfer converted files to Linux via SCP or storage replication
3. Apply incremental RMAN backups from the HP-UX source to keep files current
4. At cutover: apply final incremental, import metadata with Data Pump, open tablespaces read-write on Linux

XTTS requires the \`COMPATIBLE\` parameter on the source to be at least 11.2.0, and the tablespaces being migrated must be set \`READ ONLY\` during the final conversion step.

### Option 2 — Full Data Pump Export/Import

The simplest approach for databases under 500 GB or where downtime window allows a full export/import cycle. Source database is exported with \`expdp\` on HP-UX, transferred to Linux, and imported with \`impdp\` into the new 21c RAC CDB/PDB structure. No endian concern — Data Pump exports logical data, not physical blocks.

Downtime equals export time + transfer time + import time. For large databases this can be days, making it impractical for production systems.

### Option 3 — GoldenGate Minimal Downtime

For the tightest downtime requirements (under 1 hour), Oracle GoldenGate can replicate changes from the HP-UX source to the Linux target in near-real-time while XTTS handles the bulk data transfer. When the target is current, a brief application freeze and switchover achieves cutover. This approach requires GoldenGate licenses and significantly more planning effort.

---

## Oracle 21c RAC Topology on RHEL 9

Understanding the target topology before building it prevents costly architectural mistakes.

### Node Layout

A production Oracle 21c RAC cluster has a minimum of two nodes, with three or four being common for workloads that require rolling patch application without impact:

\`\`\`
[ racnode1 ]     [ racnode2 ]     [ racnode3 ]
   RHEL 9           RHEL 9           RHEL 9
   21c DB           21c DB           21c DB
   GI 21c           GI 21c           GI 21c
        \\               |               /
         \\  Private Interconnect (10GbE)
          \\             |              /
           [  Cluster Interconnect Switch  ]
                        |
           [ Shared Storage — ASM Diskgroups ]
                (iSCSI / FC / NFS / NVMe-oF)
\`\`\`

Each node has:
- **Public network** (eth0 / bond0): client-facing, standard database connections
- **Private interconnect** (eth1 / bond1): Cache Fusion traffic, cluster heartbeat — must be dedicated, never shared with public traffic
- **Virtual IP (VIP)**: one per node, on the public network, managed by Clusterware for failover
- **SCAN (Single Client Access Name)**: three IPs registered in DNS resolving to the cluster name — SCAN listeners load-balance incoming connections across all nodes

### ASM Diskgroup Layout

\`\`\`
+DATA     — database datafiles, redo logs         NORMAL redundancy (3-way mirror optional)
+FRA      — fast recovery area, RMAN backups       NORMAL redundancy
+GRID     — OCR, Voting Disk                       HIGH redundancy (minimum 3 disks)
\`\`\`

In Oracle 21c, the Oracle Clusterware repository (OCR) and Voting Disks live inside the +GRID diskgroup. Never store user data in +GRID.

### Oracle 21c Mandatory Multitenant

A critical architectural difference from older versions: **Oracle 21c does not support non-CDB databases**. Every database must be a Container Database (CDB) with one or more Pluggable Databases (PDBs). This affects migration planning:

- The HP-UX source (likely a non-CDB 11gR2 or 12c) must be migrated into a PDB within a 21c CDB
- Use \`DBMS_PDB.DESCRIBE\` + \`DBMS_PDB.CHECK_PLUG_COMPATIBILITY\` during migration validation
- Each application schema becomes a PDB — consider whether to consolidate multiple HP-UX databases into a single 21c CDB

---

## Oracle 21c New Features Worth Exploiting Post-Migration

The migration is a natural opportunity to adopt capabilities unavailable on HP-UX:

- **Blockchain Tables**: append-only tables with cryptographic chaining — useful for audit trails in regulated industries
- **Native JSON Binary (OSON)**: JSON stored as binary OSON type is 5–10x faster to query than VARCHAR2-stored JSON
- **AutoML in Oracle Machine Learning**: in-database ML pipeline without Python or external tooling
- **Automatic In-Memory**: HEAT_MAP-driven automatic population of the In-Memory Column Store
- **Enhanced RAC Fast Application Notification (FAN)**: improved connection draining for rolling patches with zero client impact when using JDBC Universal Connection Pool

---

## Post-Migration RAC Topology Verification

After cutover, verify the cluster is healthy before declaring success:

\`\`\`bash
# Cluster status — all nodes should show online
crsctl stat res -t

# SCAN listener verification
srvctl status scan
srvctl status scan_listener

# VIP status (each node)
srvctl status vip -node racnode1
srvctl status vip -node racnode2

# ASM diskgroup status
asmcmd lsdg

# Database and instance status
srvctl status database -d PRODCDB
srvctl status service -d PRODCDB
\`\`\`

---

## Monitoring and Health Check Script

On RHEL 9, a cron-driven health script covers the key RAC failure modes: node eviction, voting disk loss, interconnect degradation, ASM diskgroup dismount, and CRS resource failures.

\`\`\`bash
#!/bin/bash
# Oracle 21c RAC Health Check — runs every 10 minutes via crontab
# Install: crontab -e  →  */10 * * * * /opt/scripts/rac21c_health.sh

ORACLE_HOME=/u01/app/oracle/product/21c/dbhome_1
GRID_HOME=/u01/app/21c/grid
ORACLE_SID=PRODCDB1         # local instance SID
DB_UNIQUE_NAME=PRODCDB
ALERT_EMAIL=dba-oncall@example.com
LOG=/var/log/rac21c_health.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
ALERT=0

export ORACLE_HOME GRID_HOME
export PATH=\${GRID_HOME}/bin:\${ORACLE_HOME}/bin:\${PATH}

log()   { echo "[\${TIMESTAMP}] \$*" | tee -a "\${LOG}"; }
alert() { ALERT=1; log "ALERT: \$*"; }

# 1 — Cluster resource status
check_crs() {
  log "--- CRS resource check ---"
  OFFLINE=\$(crsctl stat res -t 2>/dev/null | awk '/OFFLINE/ && !/ora.asm/ {count++} END {print count+0}')
  [ "\${OFFLINE}" -gt 0 ] && alert "\${OFFLINE} CRS resource(s) OFFLINE" || log "CRS: all resources online"
}

# 2 — Voting disk availability
check_voting() {
  log "--- Voting disk check ---"
  VDISK_COUNT=\$(crsctl query css votedisk 2>/dev/null | grep -c 'ONLINE')
  TOTAL=\$(crsctl query css votedisk 2>/dev/null | grep -c 'votedisk')
  log "Voting disks online: \${VDISK_COUNT}/\${TOTAL}"
  [ "\${VDISK_COUNT}" -lt 2 ] && alert "Fewer than 2 voting disks online — cluster at eviction risk"
}

# 3 — ASM diskgroup status
check_asm() {
  log "--- ASM diskgroup check ---"
  \${GRID_HOME}/bin/asmcmd lsdg 2>/dev/null | awk 'NR>1 && \$1 != "MOUNTED" {print \$0}' | while read line; do
    alert "ASM diskgroup not MOUNTED: \${line}"
  done
  log "ASM diskgroup check complete"
}

# 4 — Local instance availability
check_instance() {
  log "--- Local instance check ---"
  STATUS=\$(\${ORACLE_HOME}/bin/sqlplus -s / as sysdba 2>/dev/null <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF
SELECT status FROM v\$instance;
EXIT
SQLEOF
)
  echo "\${STATUS}" | grep -q "OPEN" && log "Instance \${ORACLE_SID}: OPEN" \
    || alert "Instance \${ORACLE_SID} not OPEN — status: \${STATUS}"
}

# 5 — Interconnect throughput check
check_interconnect() {
  log "--- Interconnect check ---"
  IC_IFACE=\$(oifcfg getif 2>/dev/null | awk '/cluster_interconnect/ {print \$1; exit}')
  if [ -n "\${IC_IFACE}" ]; then
    RX_ERR=\$(cat /sys/class/net/\${IC_IFACE}/statistics/rx_errors 2>/dev/null || echo 0)
    TX_ERR=\$(cat /sys/class/net/\${IC_IFACE}/statistics/tx_errors 2>/dev/null || echo 0)
    log "Interconnect \${IC_IFACE} rx_errors=\${RX_ERR} tx_errors=\${TX_ERR}"
    [ "\${RX_ERR}" -gt 1000 ] || [ "\${TX_ERR}" -gt 1000 ] && \
      alert "High error count on interconnect \${IC_IFACE}: rx=\${RX_ERR} tx=\${TX_ERR}"
  else
    log "Could not determine interconnect interface from oifcfg"
  fi
}

# 6 — Disk space: ORACLE_HOME and FRA
check_diskspace() {
  log "--- Disk space check ---"
  for MOUNT in /u01 /u02; do
    USAGE=\$(df -h "\${MOUNT}" 2>/dev/null | awk 'NR==2 {gsub(/%/,""); print \$5}')
    [ -n "\${USAGE}" ] && {
      log "Disk \${MOUNT}: \${USAGE}% used"
      [ "\${USAGE}" -ge 85 ] && alert "Disk \${MOUNT} at \${USAGE}% — approaching capacity"
    }
  done
}

# 7 — Alert log scan (last 10 minutes)
check_alert_log() {
  log "--- Alert log scan ---"
  ALERT_LOG=\$(find \${ORACLE_HOME}/../diag/rdbms -name "alert_\${ORACLE_SID}.log" 2>/dev/null | head -1)
  if [ -f "\${ALERT_LOG}" ]; then
    ERRORS=\$(find "\${ALERT_LOG}" -newer /tmp/.rac_health_last_run 2>/dev/null \
      | xargs grep -c "ORA-\|FATAL\|evict\|CSS\|RECONFIG" 2>/dev/null || echo 0)
    [ "\${ERRORS}" -gt 0 ] && alert "Alert log has \${ERRORS} new critical entries since last check"
    log "Alert log: \${ERRORS} new critical lines"
  else
    log "Alert log not found at expected path"
  fi
  touch /tmp/.rac_health_last_run
}

# 8 — Send summary
send_alert() {
  [ "\${ALERT}" -eq 1 ] && {
    grep "ALERT:" "\${LOG}" | tail -20 \
      | mail -s "RAC 21c Health Alert - \$(hostname)" "\${ALERT_EMAIL}"
    log "Alert email sent"
  }
}

log "====== RAC 21c Health Check Start ======"
check_crs
check_voting
check_asm
check_instance
check_interconnect
check_diskspace
check_alert_log
send_alert
log "====== RAC 21c Health Check End ======"
\`\`\`

Schedule in crontab (as oracle user):

\`\`\`
*/10 * * * * /opt/scripts/rac21c_health.sh >> /var/log/rac21c_health_cron.log 2>&1
\`\`\`

---

## Summary

Migrating Oracle RAC from HP-UX to RHEL 9 with Oracle 21c is a multi-dimensional project that demands careful attention to the endian conversion, the mandatory CDB architecture shift, and the new RAC topology on Linux. The XTTS approach minimizes downtime for large databases while GoldenGate closes any remaining gap for the most demanding SLAs. Once on RHEL 9, the health script above gives you a 10-minute monitoring cadence covering the failure modes that matter most in a RAC cluster: voting disk loss, CRS resource failures, ASM dismount, and interconnect degradation. The full runbook covers each phase in step-by-step detail.`,
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
