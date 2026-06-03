import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const blogPost = {
  title: 'Oracle RAC Administration: Cluster Architecture, Services, and Operations',
  slug: 'oracle-rac-administration',
  excerpt:
    'A comprehensive guide to Oracle Real Application Clusters administration — covering Grid Infrastructure components, Cache Fusion, voting disks, OCR, services, node management, and the operational tasks every RAC DBA must know.',
  category: 'oracle-database' as const,
  published: true,
  publishedAt: new Date('2026-06-03'),
  isPremium: false,
  youtubeUrl: null,
  content: `Oracle Real Application Clusters (RAC) allows multiple server nodes to access a single Oracle database simultaneously. Each node runs its own Oracle instance — its own SGA, background processes, and connections — but all instances share the same set of datafiles on shared storage (ASM or shared filesystem). From the application perspective, the database appears as a single logical system, but the workload is distributed across all nodes.

RAC is fundamentally different from a standalone database not just in complexity, but in how it fails. Individual nodes can be evicted from the cluster without data loss. The database continues running on the remaining nodes. Understanding why Oracle behaves this way — and what it protects against — is essential before you can administer it effectively.

---

## Cluster Architecture

### Grid Infrastructure

Oracle Grid Infrastructure (GI) is the foundation layer that must be installed and running before the database software. It provides:

- **Oracle Clusterware** — the cluster membership and resource management layer
- **Oracle ASM** — shared storage management (covered separately)
- **Oracle Restart** (single node) — automatic restart of database components after failure

GI has its own Oracle Home (\`ORACLE_HOME\` for grid, separate from the DB home) and is owned by the \`grid\` OS user.

### The Five Core Clusterware Components

| Component | Process | Purpose |
|---|---|---|
| **Cluster Synchronization Services** | \`ocssd.bin\` | Heartbeat between nodes; detects node failures; manages voting disks |
| **Cluster Ready Services** | \`crsd.bin\` | Manages cluster resources (databases, services, VIPs, listeners) |
| **Oracle High Availability Services** | \`ohasd.bin\` | Root-level daemon; starts/monitors all other GI processes |
| **Grid Interprocess Communication** | \`gpnpd.bin\` | Profile-based network configuration distribution |
| **Multicast Domain Name Service** | \`mdnsd.bin\` | DNS resolution within the cluster |

These processes are managed by \`init.ohasd\` at the OS level — they start before the oracle user processes and must not be stopped manually.

### Cluster Interconnect

The **private interconnect** is a dedicated high-speed network (typically 10GbE or InfiniBand) used exclusively for inter-node communication. It carries:

- **Cache Fusion** traffic — block transfers between node buffer caches
- **GCS/GES** messaging — global cache and lock coordination
- **Heartbeat** messages — CSS node liveness detection

The interconnect must never be shared with application traffic. Latency on the interconnect directly impacts the performance of inter-node block transfers. Typical healthy interconnect latency is under 0.5ms. Above 2ms, you will see cache fusion wait events rising.

### Voting Disks

Voting disks are the tie-breaker in a network partition. If nodes cannot see each other over the private interconnect, each node checks the voting disk to determine cluster membership. The node with a majority of votes survives; the minority is evicted (fenced).

In Oracle 11gR2+ with ASM, voting disks are stored **inside the OCR/VOTE disk group** and are backed up/restored automatically. There is no separate raw device or filesystem path. The recommended configuration is 3 voting disk copies across separate failure groups in the disk group.

\`\`\`sql
-- Check voting disk location
crsctl query css votedisk
\`\`\`

### Oracle Cluster Registry (OCR)

The OCR stores the cluster configuration: resource definitions, node membership, network configuration, and database/service registrations. It is also stored in ASM (11gR2+). Changes to the OCR are made by \`srvctl\`, \`crsctl\`, and DBCA — never by editing files directly.

OCR is automatically backed up every 4 hours by the CRS stack to \`$ORACLE_BASE/crsdata/<hostname>/olr/\`.

\`\`\`bash
# List OCR backups
ocrconfig -showbackup
\`\`\`

---

## Cache Fusion

Cache Fusion is the technology that makes RAC work as a single logical database across multiple instances. When Instance 1 needs a block that is currently in Instance 2's buffer cache, Cache Fusion transfers that block directly over the private interconnect — without writing it to disk and re-reading it.

### Global Cache Service (GCS) and Global Enqueue Service (GES)

| Service | Background Process | Role |
|---|---|---|
| **GCS** | \`LMS0\`, \`LMS1\` (Log Merge Servers) | Manages block-level cache coherency — transfers dirty blocks between instances |
| **GES** | \`LMD\` (Lock Manager Daemon) | Manages distributed lock enqueues across instances |

### Block Transfer Modes

When one instance needs a block held by another:

- **Current mode transfer**: the holding instance flushes the current version of the block to the requestor directly (and possibly to disk first if dirty)
- **Consistent read transfer**: a CR (consistent read) copy is constructed and sent

Heavy current-mode transfers (\`gc current block busy\`, \`gc cr grant 2-way\`) indicate hot blocks being accessed from multiple nodes simultaneously — classic RAC contention. Solutions include application partitioning (route node 1 to schema A, node 2 to schema B) or sequence caching tuning.

### Key RAC Wait Events

| Wait Event | Meaning |
|---|---|
| \`gc current block 2-way\` | Block transfer between instances — normal |
| \`gc current block busy\` | Block being modified by another instance — contention |
| \`gc cr block 2-way\` | CR copy transfer — normal read consistency |
| \`gc buffer busy acquire\` | Local instance waiting for a block being fetched from remote |
| \`gc current grant busy\` | Lock grant from GCS delayed — GCS load |
| \`latch: cache buffers chains\` | Hot block — many sessions accessing the same buffer |

---

## Node Eviction (STONITH)

When a node fails to respond to CSS heartbeats within the \`misscount\` timeout (default 30 seconds for disk heartbeat, \`disktimeout\` default 200 seconds), CSS initiates node eviction. The failing node is **fenced** — forcibly rebooted — to ensure it cannot write to shared storage while other nodes are recovering its in-flight transactions.

This is called **STONITH** (Shoot The Other Node In The Head). It is not a bug or an overreaction — it is the correct behaviour for protecting data integrity. A node that is partially alive (lost interconnect but still running) could corrupt shared data if not stopped.

After eviction, the surviving nodes perform **instance recovery** for the evicted node — rolling back uncommitted transactions and completing committed ones using the evicted node's redo thread.

---

## Services

RAC **services** are the recommended way to connect applications to the cluster. A service:

- Has a name (e.g., \`OLTP_SVC\`, \`REPORTS_SVC\`)
- Is assigned preferred and available instances
- Has a connection load balancing policy (SHORT for session counts, LONG for throughput)
- Supports TAF (Transparent Application Failover) or Application Continuity
- Automatically fails over to available instances on node failure

Applications connect to the service name through a SCAN (Single Client Access Name) listener — a single DNS name that resolves to 3 IP addresses (SCAN VIPs), which in turn load balance connections to the appropriate node.

\`\`\`
Application → SCAN DNS (3 IPs) → SCAN Listener → Node VIP Listener → Instance
\`\`\`

Direct node connections (bypassing SCAN and services) should be avoided — they defeat load balancing and TAF.

---

## Key Administrative Tools

| Tool | Purpose |
|---|---|
| \`crsctl\` | Manage cluster resources, check/start/stop CRS stack |
| \`srvctl\` | Manage database, instance, service, listener, and VIP resources |
| \`olsnodes\` | List cluster nodes and their node numbers |
| \`oifcfg\` | Configure network interfaces for cluster use |
| \`cluvfy\` | Cluster verification utility — run before installs and patches |
| \`asmcmd\` | ASM management (separate from CRS but integral to RAC) |
| \`ocrdump\` / \`ocrconfig\` | OCR inspection and backup management |

---

## Patching RAC: Rolling vs Non-Rolling

One of RAC's key advantages is the ability to apply patches in a **rolling** fashion — one node at a time, while the cluster stays up and serves traffic.

- **Rolling patches**: most Oracle quarterly RUs (Release Updates) support rolling apply. One node is patched while the others continue running. No downtime.
- **Non-rolling patches**: some patches require all instances to be down simultaneously (rare in 19c, always noted in the patch README).

The \`opatch auto\` command handles rolling patch application for Grid Infrastructure and database homes in RAC.

---

## Best Practices

**Always use services for application connections.** Direct instance connections bypass TAF, load balancing, and fail to fail over automatically. Services are the abstraction layer that makes RAC transparent to applications.

**Separate the private interconnect from public networks.** A single network card handling both application traffic and cache fusion traffic will cause interconnect latency spikes under load, leading to node evictions.

**Verify the OCR and voting disk configuration after any storage change.** Adding or replacing disks in the OCR/VOTE disk group requires verifying that voting disk redundancy is maintained.

**Run \`cluvfy\` before patching.** The Cluster Verification Utility catches configuration drift before it causes a patch to fail mid-way.

**Monitor interconnect utilisation.** Cache Fusion bandwidth is not infinite. RAC does not scale linearly if the workload requires heavy cross-node block transfers. Monitor \`gv\$sysstat\` for \`gc\` statistics and interconnect utilisation.

**Size the private interconnect for peak Cache Fusion load.** For databases with heavy DML, the interconnect can saturate at 40–60% of its rated bandwidth due to protocol overhead. 25GbE or InfiniBand is recommended for high-throughput OLTP RAC.

**Keep node clocks synchronised.** CSS requires time synchronisation within a few milliseconds. Use Chrony or NTP, and verify with \`cluvfy comp clocksync\`. Time drift causes spurious node evictions.

The companion runbook covers all key operational tasks: cluster health checks, starting and stopping the stack, service management, node eviction forensics, and a 4-hour monitoring script that checks all cluster resources, interconnect health, and GCS wait event rates.
`,
};

const runbookPost = {
  title: 'Oracle RAC Administration Runbook',
  slug: 'oracle-rac-administration-runbook',
  excerpt:
    'Operational runbook for Oracle RAC — cluster health checks, start/stop procedures, service management, node eviction forensics, OCR backup, and a 4-hour monitoring script that checks CRS resources, interconnect health, GCS wait rates, and service availability.',
  category: 'oracle-database' as const,
  published: true,
  publishedAt: new Date('2026-06-03'),
  isPremium: true,
  youtubeUrl: null,
  content: `# Oracle RAC Administration Runbook

## Overview

This runbook covers day-to-day Oracle RAC operations on a two-node 19c cluster. All scripts use \`srvctl\` and \`crsctl\` as the primary management interface — direct \`sqlplus\` commands to individual instances are used only for diagnostic queries.

**Assumptions:**
- Two-node RAC: \`rac1\`, \`rac2\`
- Grid home: \`/u01/app/grid/19.0.0\` (grid OS user)
- DB home: \`/u01/app/oracle/product/19.0.0/dbhome_1\` (oracle OS user)
- Database unique name: \`ORCL\` (instances: \`ORCL1\`, \`ORCL2\`)
- SCAN name: \`orcl-scan.example.com\`
- ASM disk group for OCR/VOTE: \`+VOTE\`

---

## Script 1 — Cluster Health Pre-Check

Run this before any maintenance operation or when investigating a reported issue.

\`\`\`bash
#!/bin/bash
# rac_precheck.sh  — run as grid user on any cluster node
set -euo pipefail

GRID_HOME=/u01/app/grid/19.0.0
export ORACLE_HOME=\${GRID_HOME}
PATH=\${ORACLE_HOME}/bin:\${PATH}

echo "===== RAC Cluster Health Check: \$(hostname) — \$(date) ====="

# ── Cluster nodes ─────────────────────────────────────────────────────────────
echo ""
echo "[1] Cluster nodes"
olsnodes -n -i -s

# ── CRS stack status ──────────────────────────────────────────────────────────
echo ""
echo "[2] CRS stack status (ohasd, crsd, ocssd)"
crsctl check crs

# ── All cluster resources ─────────────────────────────────────────────────────
echo ""
echo "[3] All cluster resources"
crsctl status res -t

# ── Database and instance status ──────────────────────────────────────────────
echo ""
echo "[4] Database resource status"
srvctl status database -d ORCL -v

# ── Services ──────────────────────────────────────────────────────────────────
echo ""
echo "[5] Service status"
srvctl status service -d ORCL

# ── SCAN listeners ────────────────────────────────────────────────────────────
echo ""
echo "[6] SCAN listener status"
srvctl status scan_listener

# ── VIP status ────────────────────────────────────────────────────────────────
echo ""
echo "[7] VIP status"
srvctl status vip -n rac1
srvctl status vip -n rac2

# ── Voting disks ──────────────────────────────────────────────────────────────
echo ""
echo "[8] Voting disks"
crsctl query css votedisk

# ── OCR integrity ─────────────────────────────────────────────────────────────
echo ""
echo "[9] OCR integrity check"
ocrcheck

# ── Interconnect configuration ────────────────────────────────────────────────
echo ""
echo "[10] Cluster interconnect interfaces"
oifcfg getif

echo ""
echo "===== Pre-check complete: \$(date) ====="
\`\`\`

---

## Script 2 — Start and Stop the RAC Stack

### Stop Order (always: database → ASM → CRS)

\`\`\`bash
#!/bin/bash
# rac_stop.sh  — run as grid user; stops all resources on this node
# For full cluster shutdown, run on BOTH nodes.
set -euo pipefail

GRID_HOME=/u01/app/grid/19.0.0
export ORACLE_HOME=\${GRID_HOME}
PATH=\${ORACLE_HOME}/bin:\${PATH}

NODE=\$(hostname -s)
echo "===== Stopping RAC stack on \${NODE}: \$(date) ====="

# ── Step 1: Stop database instances on this node ─────────────────────────────
echo "[1] Stopping database instance..."
srvctl stop instance -d ORCL -i \${ORACLE_SID:-ORCL1} -stopoption immediate -force
echo "    Instance stopped."

# ── Step 2: Stop all services on this node (may already be stopped) ──────────
echo "[2] Stopping services on \${NODE}..."
srvctl stop service -d ORCL -node \${NODE} 2>/dev/null || echo "    No services to stop."

# ── Step 3: Stop ASM on this node ────────────────────────────────────────────
echo "[3] Stopping ASM instance..."
srvctl stop asm -node \${NODE} -stopoption immediate -force
echo "    ASM stopped."

# ── Step 4: Stop the CRS stack (this will also stop ohasd) ───────────────────
echo "[4] Stopping CRS stack..."
echo "    NOTE: This step requires root or sudo."
sudo crsctl stop crs
echo "    CRS stack stopped."

echo ""
echo "===== Stack stopped on \${NODE}: \$(date) ====="
\`\`\`

### Start Order (always: CRS → ASM → database)

\`\`\`bash
#!/bin/bash
# rac_start.sh  — run as grid user; starts all resources on this node
set -euo pipefail

GRID_HOME=/u01/app/grid/19.0.0
export ORACLE_HOME=\${GRID_HOME}
PATH=\${ORACLE_HOME}/bin:\${PATH}

NODE=\$(hostname -s)
echo "===== Starting RAC stack on \${NODE}: \$(date) ====="

# ── Step 1: Start the CRS stack ───────────────────────────────────────────────
echo "[1] Starting CRS stack (requires root)..."
sudo crsctl start crs
echo "    Waiting 60s for CRS to initialise..."
sleep 60

# ── Step 2: Verify CRS is up ──────────────────────────────────────────────────
echo "[2] CRS status..."
crsctl check crs

# ── Step 3: CRS normally auto-starts ASM and the database.
#            If AUTOSTART policy is set (default), skip manual steps below.
echo "[3] Checking auto-started resources..."
sleep 30
crsctl status res -t | grep -E 'ONLINE|OFFLINE'

# ── Step 4: If ASM did not auto-start ────────────────────────────────────────
ASM_STATE=$(srvctl status asm -node \${NODE} 2>/dev/null | grep -o 'running\|stopped' | head -1)
if [[ "\${ASM_STATE}" != "running" ]]; then
  echo "[4] ASM not running — starting manually..."
  srvctl start asm -node \${NODE}
fi

# ── Step 5: If database did not auto-start ────────────────────────────────────
DB_STATE=$(srvctl status instance -d ORCL -i \${ORACLE_SID:-ORCL1} 2>/dev/null | grep -o 'running\|stopped' | head -1)
if [[ "\${DB_STATE}" != "running" ]]; then
  echo "[5] Database instance not running — starting..."
  srvctl start instance -d ORCL -i \${ORACLE_SID:-ORCL1}
fi

# ── Step 6: Final status ──────────────────────────────────────────────────────
echo ""
echo "[6] Final cluster resource status:"
crsctl status res -t
srvctl status database -d ORCL -v

echo ""
echo "===== Stack started on \${NODE}: \$(date) ====="
\`\`\`

---

## Script 3 — Service Management

\`\`\`bash
#!/bin/bash
# rac_service_mgmt.sh  — run as oracle user
# Demonstrates creating, starting, stopping, and relocating RAC services.
set -euo pipefail

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_HOME
PATH=\${ORACLE_HOME}/bin:\${PATH}

echo "===== RAC Service Management Examples ====="

# ── Create an OLTP service (preferred on both nodes, SHORT load balance) ──────
echo "[1] Create OLTP service"
srvctl add service \
  -d ORCL \
  -s OLTP_SVC \
  -preferred ORCL1,ORCL2 \
  -available "" \
  -clbgoal SHORT \
  -rlbgoal SERVICE_TIME \
  -failovertype SELECT \
  -failovermethod BASIC \
  -failoverretry 30 \
  -failoverdelay 5 \
  -commit_outcome TRUE \
  -policy AUTOMATIC

# ── Create a REPORTS service (preferred node 2 only — offload reporting) ──────
echo "[2] Create REPORTS service (node 2 preferred)"
srvctl add service \
  -d ORCL \
  -s REPORTS_SVC \
  -preferred ORCL2 \
  -available ORCL1 \
  -clbgoal LONG \
  -rlbgoal THROUGHPUT \
  -policy AUTOMATIC

# ── Start services ────────────────────────────────────────────────────────────
echo "[3] Starting services"
srvctl start service -d ORCL -s OLTP_SVC
srvctl start service -d ORCL -s REPORTS_SVC

# ── Check service status ──────────────────────────────────────────────────────
echo "[4] Service status"
srvctl status service -d ORCL -v

# ── Relocate a service (planned node maintenance) ────────────────────────────
echo "[5] Relocate REPORTS_SVC from rac2 to rac1 (for maintenance)"
srvctl relocate service -d ORCL -s REPORTS_SVC -oldinst ORCL2 -newinst ORCL1

# ── Verify active connections via service ─────────────────────────────────────
echo "[6] Active sessions per service"
ORACLE_SID=ORCL1 sqlplus -s / as sysdba <<'SQLEOF'
  set lines 160 pages 50 feedback off
  col service_name format a25
  col inst_id      format 99
  col sessions     format 9999
  select s.service_name, s.inst_id, count(*) as sessions
  from   gv$session s
  where  s.type = 'USER'
    and  s.service_name not in ('SYS$BACKGROUND','SYS$USERS')
  group by s.service_name, s.inst_id
  order by s.service_name, s.inst_id;
SQLEOF
\`\`\`

---

## Script 4 — Node Eviction Forensics

After a node eviction, run this to understand what happened before attempting to rejoin the node.

\`\`\`bash
#!/bin/bash
# rac_eviction_forensics.sh  — run as grid user on the SURVIVING node
set -euo pipefail

GRID_HOME=/u01/app/grid/19.0.0
ORACLE_BASE=/u01/app/grid
export ORACLE_HOME=\${GRID_HOME}
PATH=\${ORACLE_HOME}/bin:\${PATH}

EVICTED_NODE=\${1:-rac2}
HOURS_BACK=\${2:-4}
TIMESTAMP_FROM=$(date -d "-\${HOURS_BACK} hours" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || \
                 date -v -\${HOURS_BACK}H '+%Y-%m-%d %H:%M:%S')

echo "===== Node Eviction Forensics ====="
echo "Evicted node : \${EVICTED_NODE}"
echo "Window       : last \${HOURS_BACK} hours (from \${TIMESTAMP_FROM})"
echo ""

# ── Current cluster membership ────────────────────────────────────────────────
echo "[1] Current cluster membership"
olsnodes -n -s

# ── CRS alert log ─────────────────────────────────────────────────────────────
echo ""
echo "[2] CRS alert log — eviction-related entries"
CRS_ALERT=\${ORACLE_BASE}/diag/crs/\$(hostname -s)/crs/trace/alert.log
if [[ -f "\${CRS_ALERT}" ]]; then
  grep -iE 'evict|reconfig|member.*left|node.*down|CSSD|clssnmvDiskPing|misscount|network.*split' \
    "\${CRS_ALERT}" | tail -40
else
  echo "CRS alert log not found at \${CRS_ALERT}"
  echo "Try: find \${ORACLE_BASE}/diag/crs -name alert.log 2>/dev/null"
fi

# ── CSS trace for the evicted node ───────────────────────────────────────────
echo ""
echo "[3] CSS disk/network heartbeat diagnostics"
CSS_TRACE_DIR=\${ORACLE_BASE}/diag/crs/\$(hostname -s)/crs/trace
if [[ -d "\${CSS_TRACE_DIR}" ]]; then
  # Find the most recent ocssd trace file
  OCSSD_TRACE=$(ls -t "\${CSS_TRACE_DIR}"/ocssd*.trc 2>/dev/null | head -1)
  if [[ -n "\${OCSSD_TRACE:-}" ]]; then
    echo "CSS trace: \${OCSSD_TRACE}"
    grep -iE 'misscount|disktimeout|reconfig|evict|network.*fail|disk.*fail' \
      "\${OCSSD_TRACE}" | tail -30
  fi
fi

# ── Database alert log — instance recovery messages ──────────────────────────
echo ""
echo "[4] Database alert log — instance recovery for evicted node"
DB_ALERT=\${ORACLE_BASE}/diag/rdbms/orcl/ORCL1/trace/alert_ORCL1.log
if [[ -f "\${DB_ALERT}" ]]; then
  grep -iE 'recovery|reconfigur|thread.*recovery|evict|ORCL2' "\${DB_ALERT}" | tail -30
else
  echo "DB alert log not found — adjust ORACLE_BASE/SID path"
fi

# ── Voting disk health ────────────────────────────────────────────────────────
echo ""
echo "[5] Current voting disk status"
crsctl query css votedisk

# ── Network interface check ───────────────────────────────────────────────────
echo ""
echo "[6] Private interconnect interface status"
oifcfg getif
echo ""
ip link show | grep -E 'state|ether' | head -20

echo ""
echo "===== Forensics complete. ====="
echo "Common causes of eviction:"
echo "  - Interconnect packet loss > misscount threshold (check [3])"
echo "  - CSS disk heartbeat timeout (check [3] for disktimeout messages)"
echo "  - OS hang / OOM killer killed ocssd.bin process"
echo "  - Network misconfiguration after patching or interface replacement"
\`\`\`

---

## Script 5 — OCR Backup and Restore

\`\`\`bash
#!/bin/bash
# rac_ocr_backup.sh  — run as root (OCR operations require root)
set -euo pipefail

GRID_HOME=/u01/app/grid/19.0.0
ORACLE_BASE=/u01/app/grid
BACKUP_DIR=\${ORACLE_BASE}/ocr_manual_backups
mkdir -p "\${BACKUP_DIR}"

echo "===== OCR Manual Backup: \$(date) ====="

# ── List automatic backups ────────────────────────────────────────────────────
echo "[1] Automatic OCR backups (created every 4 hours by CRS)"
\${GRID_HOME}/bin/ocrconfig -showbackup

# ── Manual backup ─────────────────────────────────────────────────────────────
echo ""
echo "[2] Taking manual backup before this change..."
\${GRID_HOME}/bin/ocrconfig -manualbackup
\${GRID_HOME}/bin/ocrconfig -showbackup

# ── Verify OCR integrity ──────────────────────────────────────────────────────
echo ""
echo "[3] OCR integrity check"
\${GRID_HOME}/bin/ocrcheck

echo ""
echo "===== OCR backup complete ====="
echo "To restore from backup (requires all CRS stopped):"
echo "  crsctl stop crs -f    (on all nodes)"
echo "  ocrconfig -restore /path/to/backup_file"
echo "  crsctl start crs      (on all nodes)"
\`\`\`

---

## Script 6 — Add a New Node to the Cluster

High-level checklist — adding a node is a multi-step process that MUST follow Oracle's documentation exactly.

\`\`\`bash
#!/bin/bash
# rac_add_node_checklist.sh  — run as grid user on an EXISTING node
# This script validates prerequisites and guides through the add-node process.
# The actual add-node uses the cluvfy and gridSetup.sh utilities interactively.
set -euo pipefail

GRID_HOME=/u01/app/grid/19.0.0
export ORACLE_HOME=\${GRID_HOME}
PATH=\${ORACLE_HOME}/bin:\${PATH}

NEW_NODE=\${1:-"rac3"}
NEW_NODE_IP=\${2:-"192.168.1.13"}

echo "===== Add Node Pre-Check: \${NEW_NODE} (\${NEW_NODE_IP}) ====="
echo ""

# ── Network reachability ──────────────────────────────────────────────────────
echo "[1] Network reachability to new node"
ping -c 3 "\${NEW_NODE}" && echo "PUBLIC: OK" || echo "PUBLIC: UNREACHABLE"
ping -c 3 "\${NEW_NODE}-priv" 2>/dev/null && echo "PRIVATE: OK" || echo "PRIVATE: Check private network"

# ── SSH equivalence ───────────────────────────────────────────────────────────
echo ""
echo "[2] SSH equivalence (oracle and grid users)"
ssh -o BatchMode=yes -o ConnectTimeout=5 grid@\${NEW_NODE} hostname 2>/dev/null && \
  echo "SSH grid@\${NEW_NODE}: OK" || \
  echo "SSH grid@\${NEW_NODE}: FAILED — run ssh-copy-id or orainstRoot.sh to set up equivalence"

ssh -o BatchMode=yes -o ConnectTimeout=5 oracle@\${NEW_NODE} hostname 2>/dev/null && \
  echo "SSH oracle@\${NEW_NODE}: OK" || \
  echo "SSH oracle@\${NEW_NODE}: FAILED"

# ── Shared storage visible on new node ───────────────────────────────────────
echo ""
echo "[3] Shared storage (ASM disks) — verify on new node:"
ssh grid@\${NEW_NODE} "sudo /usr/sbin/oracleasm scandisks && /usr/sbin/oracleasm listdisks" 2>/dev/null || \
  echo "Cannot check — fix SSH equivalence first"

# ── Run cluvfy pre-check ──────────────────────────────────────────────────────
echo ""
echo "[4] Running cluvfy pre-check for node addition..."
cluvfy stage -pre nodeadd -n "\${NEW_NODE}" -verbose 2>&1 | tail -30

echo ""
echo "===== Prerequisites checked. ====="
echo ""
echo "To add the node (run on existing node as root):"
echo "  cd \${GRID_HOME}/addnode"
echo "  ./addnode.sh CLUSTER_NEW_NODES={\${NEW_NODE}}"
echo ""
echo "After Grid Infrastructure is extended to the new node:"
echo "  cd \$ORACLE_HOME/addnode"
echo "  ./addnode.sh CLUSTER_NEW_NODES={\${NEW_NODE}}  (DB home)"
echo ""
echo "  srvctl add instance -d ORCL -i ORCL3 -n \${NEW_NODE}"
echo "  srvctl start instance -d ORCL -i ORCL3"
\`\`\`

---

## Script 7 — GCS / Cache Fusion Wait Analysis

\`\`\`sql
-- rac_gc_waits.sql
-- Identifies Cache Fusion wait events across all instances.
-- Run as SYSDBA on any instance.

set lines 200 pages 100 feedback off trimspool on
col event       format a40
col inst_id     format 99
col waits       format 999999990
col avg_wait_ms format 9990.0
col total_wait_s format 9999990.0

prompt
prompt ================================================================
prompt Cache Fusion (GC) Wait Analysis — All Instances
prompt ================================================================
prompt

-- ── Top GC wait events by total time ─────────────────────────────────────────
prompt [1] Top GC Wait Events (all instances, ordered by total wait time)
select
  inst_id,
  event,
  total_waits                                   as waits,
  round(time_waited_micro / 1000000, 1)         as total_wait_s,
  round(time_waited_micro / nullif(total_waits,0) / 1000, 2) as avg_wait_ms
from
  gv$system_event
where
  event like 'gc%'
  and total_waits > 0
order by
  total_wait_s desc
fetch first 20 rows only;

-- ── GCS statistics: blocks sent / received ────────────────────────────────────
prompt
prompt [2] GCS Block Transfer Statistics (per instance)
select
  inst_id,
  name,
  value
from
  gv$sysstat
where
  name in (
    'gc cr blocks received',
    'gc current blocks received',
    'gc cr blocks served',
    'gc current blocks served',
    'gc blocks lost',
    'gc cr block receive time',
    'gc current block receive time'
  )
order by
  name, inst_id;

-- ── Hot blocks causing GC contention ─────────────────────────────────────────
prompt
prompt [3] Hot Blocks — GC Waits on Specific Objects
select
  o.owner,
  o.object_name,
  o.object_type,
  s.inst_id,
  count(*) as gc_waits
from
  gv$session_wait s
  join dba_objects o on o.object_id = s.p1
where
  s.event like 'gc%'
group by
  o.owner, o.object_name, o.object_type, s.inst_id
order by
  gc_waits desc
fetch first 20 rows only;

-- ── Interconnect throughput ───────────────────────────────────────────────────
prompt
prompt [4] Private Interconnect Throughput (gv$cluster_interconnects)
select
  inst_id,
  name,
  ip_address,
  is_public,
  source,
  round(transfer_bytes/1073741824, 2)      as transfer_gb,
  round(send_bytes_dispatched/1073741824,2) as sent_gb,
  round(recv_bytes_dispatched/1073741824,2) as recv_gb
from
  gv$cluster_interconnects
order by
  inst_id;

prompt
prompt ================================================================
prompt End of Cache Fusion Analysis
prompt ================================================================
exit;
\`\`\`

---

## Script 8 — RAC Health Check and Monitoring (4-Hour Cron)

**Shell monitoring script** — save as \`rac_monitor.sh\`:

\`\`\`bash
#!/bin/bash
# rac_monitor.sh
# Monitors Oracle RAC cluster health: CRS resources, interconnect, GCS waits.
# Cron: 0 */4 * * * grid /path/to/rac_monitor.sh >> /var/log/oracle/rac/monitor.log 2>&1
#
# Options:
#   --dry-run             Print checks without alerting
#   --alert-email ADDR    Email address for alerts
#   --log-dir PATH        Log directory (default /var/log/oracle/rac)
#   --gc-wait-ms N        Alert if avg GC wait > N ms (default 10)

set -euo pipefail

DRY_RUN=false
ALERT_EMAIL=\${ALERT_EMAIL:-""}
LOG_DIR=\${LOG_DIR:-/var/log/oracle/rac}
GC_WAIT_THRESHOLD_MS=10
GRID_HOME=\${GRID_HOME:-/u01/app/grid/19.0.0}
ORACLE_HOME=\${ORACLE_HOME:-/u01/app/oracle/product/19.0.0/dbhome_1}
DB_NAME=\${DB_NAME:-ORCL}
LOCAL_INSTANCE=\${ORACLE_SID:-ORCL1}

while [[ \$# -gt 0 ]]; do
  case "\$1" in
    --dry-run)       DRY_RUN=true ;;
    --alert-email)   ALERT_EMAIL="\$2"; shift ;;
    --log-dir)       LOG_DIR="\$2"; shift ;;
    --gc-wait-ms)    GC_WAIT_THRESHOLD_MS="\$2"; shift ;;
    *) echo "Unknown option: \$1"; exit 1 ;;
  esac
  shift
done

export ORACLE_HOME=\${GRID_HOME}
PATH=\${GRID_HOME}/bin:\${ORACLE_HOME}/bin:\${PATH}

mkdir -p "\${LOG_DIR}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOGFILE=\${LOG_DIR}/rac_monitor_\${TIMESTAMP}.log
SUMMARY_FILE=\${LOG_DIR}/rac_summary_\${TIMESTAMP}.txt
SCRIPT_DIR=$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)

exec > >(tee -a "\${LOGFILE}") 2>&1

echo "============================================================"
echo "RAC Monitor — \$(date '+%Y-%m-%d %H:%M:%S')"
echo "Node     : \$(hostname)"
echo "Dry run  : \${DRY_RUN}"
echo "============================================================"

ALERTS=()

# ════════════════════════════════════════════════════════════════
# STEP 1: CRS RESOURCE STATUS
# ════════════════════════════════════════════════════════════════
echo ""
echo "── Step 1: CRS Resource Status ─────────────────────────────"

OFFLINE_RESOURCES=$(crsctl status res -t 2>/dev/null | \
  grep -c 'OFFLINE' || echo 0)
FAILED_RESOURCES=$(crsctl status res -t 2>/dev/null | \
  grep -c 'FAILED' || echo 0)

echo "[INFO] Offline resources: \${OFFLINE_RESOURCES}"
echo "[INFO] Failed resources : \${FAILED_RESOURCES}"

if [[ "\${FAILED_RESOURCES}" -gt 0 ]]; then
  echo "[CRITICAL] \${FAILED_RESOURCES} cluster resource(s) in FAILED state"
  ALERTS+=("CRITICAL: \${FAILED_RESOURCES} cluster resource(s) FAILED")
  crsctl status res -t | grep FAILED
fi

if [[ "\${OFFLINE_RESOURCES}" -gt 2 ]]; then
  # Some OFFLINE is expected (e.g., ons, eons) — only flag if count is high
  echo "[WARNING] \${OFFLINE_RESOURCES} resources OFFLINE — review manually"
  ALERTS+=("WARNING: \${OFFLINE_RESOURCES} cluster resources OFFLINE — verify expected")
fi

# ════════════════════════════════════════════════════════════════
# STEP 2: CLUSTER NODE COUNT
# ════════════════════════════════════════════════════════════════
echo ""
echo "── Step 2: Cluster Membership ───────────────────────────────"

ACTIVE_NODES=$(olsnodes -s 2>/dev/null | grep -c Active || echo 0)
TOTAL_NODES=$(olsnodes 2>/dev/null | wc -l | tr -d ' ')

echo "[INFO] Active nodes: \${ACTIVE_NODES} of \${TOTAL_NODES}"
olsnodes -n -s

if [[ "\${ACTIVE_NODES}" -lt "\${TOTAL_NODES}" ]]; then
  INACTIVE=$(( TOTAL_NODES - ACTIVE_NODES ))
  echo "[CRITICAL] \${INACTIVE} node(s) inactive/evicted"
  ALERTS+=("CRITICAL: \${INACTIVE} cluster node(s) inactive — possible recent eviction")
fi

# ════════════════════════════════════════════════════════════════
# STEP 3: DATABASE AND SERVICE STATUS
# ════════════════════════════════════════════════════════════════
echo ""
echo "── Step 3: Database and Service Status ─────────────────────"

DB_STATUS=$(srvctl status database -d \${DB_NAME} 2>/dev/null || echo "ERROR")
echo "\${DB_STATUS}"

STOPPED_INSTANCES=$(echo "\${DB_STATUS}" | grep -c 'stopped' || echo 0)
if [[ "\${STOPPED_INSTANCES}" -gt 0 ]]; then
  echo "[CRITICAL] \${STOPPED_INSTANCES} database instance(s) stopped"
  ALERTS+=("CRITICAL: \${STOPPED_INSTANCES} RAC database instance(s) stopped")
fi

echo ""
srvctl status service -d \${DB_NAME} 2>/dev/null || echo "No services or srvctl error"

# ════════════════════════════════════════════════════════════════
# STEP 4: GCS WAIT EVENT CHECK
# ════════════════════════════════════════════════════════════════
echo ""
echo "── Step 4: GCS Cache Fusion Wait Events ────────────────────"

export ORACLE_HOME=\${ORACLE_HOME}
export ORACLE_SID=\${LOCAL_INSTANCE}
PATH=\${ORACLE_HOME}/bin:\${PATH}

GC_WAIT_DATA=$(sqlplus -s "/ as sysdba" <<'SQLEOF' 2>/dev/null || echo "SQLERROR"
set pages 0 feedback off heading off
select round(sum(time_waited_micro) / nullif(sum(total_waits),0) / 1000, 2)
from   gv$system_event
where  event like 'gc current block%'
and    total_waits > 0;
exit;
SQLEOF
)
GC_AVG_MS=$(echo "\${GC_WAIT_DATA}" | tr -d ' \n')

if [[ "\${GC_AVG_MS}" == "SQLERROR" || -z "\${GC_AVG_MS}" ]]; then
  echo "[WARN] Could not query GC wait stats — instance may be down"
  ALERTS+=("WARNING: Could not query GC wait stats on \${LOCAL_INSTANCE}")
else
  echo "[INFO] Average gc current block wait: \${GC_AVG_MS} ms"
  if awk "BEGIN {exit !(\${GC_AVG_MS} > \${GC_WAIT_THRESHOLD_MS})}"; then
    echo "[WARNING] GC wait \${GC_AVG_MS}ms exceeds threshold \${GC_WAIT_THRESHOLD_MS}ms"
    ALERTS+=("WARNING: Average Cache Fusion gc current block wait = \${GC_AVG_MS}ms (threshold: \${GC_WAIT_THRESHOLD_MS}ms)")
  else
    echo "[OK] GC wait \${GC_AVG_MS}ms — within threshold (\${GC_WAIT_THRESHOLD_MS}ms)"
  fi
fi

# ════════════════════════════════════════════════════════════════
# STEP 5: VOTING DISK AND OCR HEALTH
# ════════════════════════════════════════════════════════════════
echo ""
echo "── Step 5: Voting Disk and OCR Health ───────────────────────"

export ORACLE_HOME=\${GRID_HOME}
PATH=\${GRID_HOME}/bin:\${PATH}

OCR_STATUS=$(ocrcheck 2>&1)
if echo "\${OCR_STATUS}" | grep -q "FAILED\|ERROR"; then
  echo "[CRITICAL] OCR health check failed"
  echo "\${OCR_STATUS}"
  ALERTS+=("CRITICAL: OCR health check reports failure")
else
  echo "[OK] OCR health check passed"
fi

VOTEDISK_ONLINE=$(crsctl query css votedisk 2>/dev/null | grep -c 'ONLINE' || echo 0)
VOTEDISK_TOTAL=$(crsctl query css votedisk 2>/dev/null | grep -c 'votedisk' || echo 0)
echo "[INFO] Voting disks: \${VOTEDISK_ONLINE}/\${VOTEDISK_TOTAL} online"

if [[ "\${VOTEDISK_ONLINE}" -lt "\${VOTEDISK_TOTAL}" ]]; then
  echo "[WARNING] Not all voting disks online: \${VOTEDISK_ONLINE}/\${VOTEDISK_TOTAL}"
  ALERTS+=("WARNING: \${VOTEDISK_ONLINE}/\${VOTEDISK_TOTAL} voting disks online")
fi

# ════════════════════════════════════════════════════════════════
# STEP 6: INTERCONNECT ERRORS
# ════════════════════════════════════════════════════════════════
echo ""
echo "── Step 6: Private Interconnect Errors ─────────────────────"

export ORACLE_HOME=\${ORACLE_HOME}
export ORACLE_SID=\${LOCAL_INSTANCE}
PATH=\${ORACLE_HOME}/bin:\${PATH}

LOST_BLOCKS=$(sqlplus -s "/ as sysdba" <<'SQLEOF' 2>/dev/null || echo "0"
set pages 0 feedback off heading off
select nvl(sum(value),0)
from   gv$sysstat
where  name = 'gc blocks lost';
exit;
SQLEOF
)
LOST_BLOCKS=$(echo "\${LOST_BLOCKS}" | tr -d ' \n')

echo "[INFO] Total gc blocks lost (cumulative): \${LOST_BLOCKS}"
if [[ "\${LOST_BLOCKS}" -gt 0 ]]; then
  echo "[WARNING] gc blocks lost > 0 — check interconnect for packet loss"
  ALERTS+=("WARNING: \${LOST_BLOCKS} gc blocks lost — possible interconnect packet loss")
fi

# ════════════════════════════════════════════════════════════════
# SUMMARY AND ALERT
# ════════════════════════════════════════════════════════════════
echo ""
echo "============================================================"
echo "SUMMARY — \$(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================================"

{
  echo "RAC Monitor Summary — \$(date '+%Y-%m-%d %H:%M:%S')"
  echo "Cluster  : \$(hostname) (\${ACTIVE_NODES}/\${TOTAL_NODES} nodes active)"
  echo "Database : \${DB_NAME}"
  echo ""
  if [[ \${#ALERTS[@]} -eq 0 ]]; then
    echo "STATUS: OK — no issues detected"
    echo ""
    echo "  CRS resources  : \${FAILED_RESOURCES} failed, \${OFFLINE_RESOURCES} offline"
    echo "  Cluster nodes  : \${ACTIVE_NODES}/\${TOTAL_NODES} active"
    echo "  GC wait avg    : \${GC_AVG_MS:-N/A} ms"
    echo "  GC blocks lost : \${LOST_BLOCKS}"
    echo "  OCR            : OK"
  else
    echo "STATUS: ALERTS DETECTED (\${#ALERTS[@]})"
    echo ""
    for ALERT in "\${ALERTS[@]}"; do
      echo "  • \${ALERT}"
    done
  fi
  echo ""
  echo "Log: \${LOGFILE}"
} | tee "\${SUMMARY_FILE}"

if [[ \${#ALERTS[@]} -gt 0 ]] && [[ -n "\${ALERT_EMAIL}" ]]; then
  SUBJECT="[RAC ALERT] \$(hostname) — \${#ALERTS[@]} issue(s) \$(date '+%Y-%m-%d %H:%M')"
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
mkdir -p /u01/app/grid/scripts/rac_monitor
cp rac_monitor.sh rac_gc_waits.sql /u01/app/grid/scripts/rac_monitor/
chmod 750 /u01/app/grid/scripts/rac_monitor/*.sh

mkdir -p /var/log/oracle/rac
chown grid:oinstall /var/log/oracle/rac

# Add to grid user crontab on each node
crontab -e -u grid
\`\`\`

\`\`\`
# RAC monitoring — every 4 hours
0 */4 * * *  ORACLE_SID=ORCL1 GRID_HOME=/u01/app/grid/19.0.0 ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1 DB_NAME=ORCL ALERT_EMAIL=dba@example.com /u01/app/grid/scripts/rac_monitor/rac_monitor.sh
\`\`\`

On node 2, change \`ORACLE_SID=ORCL2\`.

---

## Log Rotation

\`\`\`
# /etc/logrotate.d/oracle-rac-monitor
/var/log/oracle/rac/*.log {
    daily
    rotate 30
    compress
    missingok
    notifempty
    create 0640 grid oinstall
}
\`\`\`

---

## Quick Reference

### Common srvctl Commands

\`\`\`bash
# Database
srvctl status database -d ORCL -v
srvctl start  database -d ORCL
srvctl stop   database -d ORCL -stopoption immediate

# Individual instance
srvctl status instance -d ORCL -i ORCL1
srvctl start  instance -d ORCL -i ORCL2
srvctl stop   instance -d ORCL -i ORCL2 -stopoption immediate

# Services
srvctl status  service -d ORCL
srvctl start   service -d ORCL -s OLTP_SVC
srvctl stop    service -d ORCL -s OLTP_SVC
srvctl relocate service -d ORCL -s OLTP_SVC -oldinst ORCL1 -newinst ORCL2

# SCAN listener
srvctl status scan_listener
srvctl start  scan_listener
srvctl stop   scan_listener
\`\`\`

### Common crsctl Commands

\`\`\`bash
# Cluster health
crsctl check crs
crsctl check cluster -all
crsctl status res -t

# Start / stop CRS (requires root)
crsctl stop  crs
crsctl start crs

# Enable / disable auto-start
crsctl disable crs    # prevent CRS from starting at boot
crsctl enable  crs    # re-enable auto-start
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
