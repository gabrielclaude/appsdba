import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle CHAD Daemon ora.chad OFFLINE on Subset of Cluster Nodes',
  slug: 'oracle-chad-daemon-partial-node-failure-exadata-rac-runbook',
  excerpt:
    'Step-by-step runbook for diagnosing and recovering ora.chad OFFLINE on a subset of cluster nodes while other nodes are healthy. Covers GIMR health check, GI version and patch inventory, ochad trace analysis, and three resolution paths: GIMR connectivity fix, stale CHA model state purge (most common after patching), and GI patch level remediation. Includes chad_diagnose.sh automation script.',
  category: 'exadata' as const,
  isPremium: false,
  published: true,
  publishedAt: new Date('2026-07-16T19:05:00.000Z'),
  youtubeUrl: null,
  content: `# Runbook: Oracle CHAD Daemon ora.chad OFFLINE on Subset of Cluster Nodes

The Cluster Health Advisor (CHA) daemon — \`ora.chad\` — runs as an Oracle Clusterware init resource on every node in a RAC or Exadata cluster. Its job is to collect real-time performance data, detect anomalies, and feed the GIMR (Grid Infrastructure Management Repository). When \`ora.chad\` goes OFFLINE on one or two nodes while the rest of the cluster is healthy, the failure is almost always one of three things: a GIMR connectivity problem on those nodes, a stale or corrupted local CHA state directory (common after patch application), or a GI patch-level mismatch between affected and healthy nodes.

This runbook covers a six-node Exadata cluster (exadb-node01 through exadb-node06) where exadb-node01 and exadb-node02 are affected. Adapt node names to your environment.

---

## Phase 1: Assess Impact and Confirm the Failure Pattern

The first step is to confirm exactly which nodes are OFFLINE and verify that this is not a full cluster outage.

\`\`\`bash
# Run as grid owner on any healthy node
crsctl stat res ora.chad -init
\`\`\`

Expected output when two nodes are affected:

\`\`\`
NAME=ora.chad
TYPE=ora.chad.type
TARGET=ONLINE ONLINE ONLINE ONLINE ONLINE ONLINE
STATE=OFFLINE OFFLINE ONLINE ONLINE ONLINE ONLINE
    (exadb-node01) (exadb-node02) (exadb-node03) (exadb-node04) (exadb-node05) (exadb-node06)
\`\`\`

The STATE line is what matters. OFFLINE on exadb-node01 and exadb-node02, ONLINE on all others — this is the partial failure pattern this runbook addresses.

\`\`\`bash
# CHAD daemon-level view
chactl status
\`\`\`

The \`chactl status\` output gives a more human-readable view, listing which nodes the daemon is running on.

**Confirm the database is not impacted.** CHAD going OFFLINE does not stop Oracle Database instances. Verify this before anything else — if databases are also down, you have a different and more urgent problem.

\`\`\`bash
crsctl stat res -t | grep -i db
\`\`\`

All database instance resources should show ONLINE. If they do, CHAD is the only affected service and you can proceed methodically.

**Document the state explicitly before touching anything:**
- Affected nodes: exadb-node01, exadb-node02
- Healthy nodes: exadb-node03, exadb-node04, exadb-node05, exadb-node06
- Database instances: ONLINE (confirmed)
- Time of failure first observed: (record from alert log or monitoring system)

This asymmetry — some nodes healthy, same nodes affected — is the key diagnostic signal. It rules out cluster-wide GIMR outages and points to either node-local configuration drift or a patch state difference.

---

## Phase 2: Verify GIMR Health

CHAD depends on the GIMR (Grid Infrastructure Management Repository), which is backed by MGMTDB — a pluggable database hosted in the GI home. If MGMTDB is down, CHAD will fail everywhere, not just on two nodes. But confirming MGMTDB health is the right first step regardless.

\`\`\`bash
srvctl status mgmtdb
\`\`\`

The output will show which nodes MGMTDB instances are running on:

\`\`\`
Database is running on node(s): exadb-node03,exadb-node04
\`\`\`

MGMTDB is a policy-managed database and does not need to run on every node — it just needs at least one instance running somewhere in the cluster to be functional.

\`\`\`bash
srvctl config mgmtdb
\`\`\`

This shows the MGMTDB configuration including the db_unique_name (typically \`-MGMTDB\`), spfile location (typically on the DATA disk group), and the server pool it is assigned to.

**If MGMTDB is completely down (no instances on any node):**
This changes the diagnosis entirely. A fully down MGMTDB would explain CHAD failures everywhere, but in a partial failure scenario it is unlikely. If it is down, start MGMTDB first:

\`\`\`bash
srvctl start mgmtdb
\`\`\`

Wait for it to come up, then attempt to restart CHAD on all nodes:

\`\`\`bash
crsctl start res ora.chad -init
\`\`\`

If CHAD comes up after MGMTDB restart, the root cause was a temporary MGMTDB outage and the investigation is complete. Monitor for recurrence.

**If MGMTDB is running on at least one node (the expected case in a partial failure):**
GIMR is functional. The problem is node-local to exadb-node01 and exadb-node02. Proceed to Phase 3.

---

## Phase 3: Collect GI Version and Patch Level from All Nodes

A patch level mismatch between nodes is a common cause of partial CHAD failures. When rolling patches are applied, a window exists where some nodes are at a higher patch level than others. If the patch changes CHAD internal state formats or GIMR schema structures, the older-patch nodes can fail to start CHAD against a GIMR that was updated by the newer-patch nodes.

Run these commands on any node (they query cluster-wide data):

\`\`\`bash
# Active CRS software version across the cluster
crsctl query crs activeversion -f

# Patch level on the current node
crsctl query crs releasepatch
\`\`\`

The \`releasepatch\` command shows the patch release string for the GI home on the node you run it from. **Run it on exadb-node01, exadb-node02, and at least one healthy node** to compare:

\`\`\`bash
# Run on exadb-node01 (affected)
ssh grid@exadb-node01 "$ORACLE_HOME/bin/crsctl query crs releasepatch"

# Run on exadb-node02 (affected)
ssh grid@exadb-node02 "$ORACLE_HOME/bin/crsctl query crs releasepatch"

# Run on exadb-node03 (healthy, for comparison)
ssh grid@exadb-node03 "$ORACLE_HOME/bin/crsctl query crs releasepatch"
\`\`\`

**If patch levels differ between affected and healthy nodes:**
Patch mismatch is the likely root cause. Go to Resolution Path C (Phase 8).

**If patch levels match on all nodes:**
Patch level is not the cause. Proceed to trace analysis in Phase 4.

---

## Phase 4: Collect CHAD Trace and CRS Alert Log from Affected Nodes

Run the following as the grid owner (GI software owner) on exadb-node01 and exadb-node02. The primary CHAD trace file is \`ochad.trc\` inside the CRS trace directory.

\`\`\`bash
# On exadb-node01 as grid owner
cd $ORACLE_BASE/diag/crs/exadb-node01/crs/trace

# Scan for error patterns in all ochad trace files
grep -iE 'ORA-|error|fail|exception|refused|timeout|unable|cannot' ochad.trc* | tail -n 100

# Show the last 150 lines of the current trace file
tail -n 150 ochad.trc
\`\`\`

If that directory does not exist or the trace file is empty, try the fallback location:

\`\`\`bash
# Fallback trace location on some GI versions
ls $ORACLE_BASE/crsdata/exadb-node01/trace/ochad.trc
\`\`\`

Also scan the CRS alert log for CHAD-specific entries:

\`\`\`bash
grep -iE 'chad|ochad|CRS-' $ORACLE_BASE/diag/crs/exadb-node01/crs/trace/alert.log | tail -n 50
\`\`\`

**Timestamp analysis:** Note the timestamp of the last entry in \`ochad.trc\`. If the last entry is from days ago (before the OFFLINE was first observed), CHAD has not even attempted to start since then. This happens when the Clusterware stack itself never tried to start CHAD — which points to a stack-level dependency issue rather than a CHAD-specific error.

Repeat all of the above on exadb-node02 before proceeding.

---

## Phase 5: Classify the Root Cause from Trace Evidence

Use the error patterns found in the trace files to route to the correct resolution path.

| Trace Pattern | Root Cause | Go To |
|---|---|---|
| \`ORA-12541\`, \`ORA-12514\`, \`no listener\` | GIMR connectivity | Resolution Path A |
| \`model version mismatch\`, \`CHA persistence\`, \`failed to load\` | Stale CHA state | Resolution Path B |
| \`GIPC error\`, \`IPC\`, \`SKGXP\` | Interconnect issue | Resolution Path B + network check |
| \`permission denied\` | File permissions | Resolution Path D |
| No recent errors in trace | CHAD never attempted startup | Force start attempt |

**Notes on classification:**

The \`model version mismatch\` and \`CHA persistence\` patterns are by far the most common after patching. CHA maintains a local state directory that stores model data, historical baselines, and version metadata. After a patch changes the internal state format, the existing state directory is incompatible with the new CHAD binary. CHAD fails to load the model and exits rather than risking data corruption.

The \`ORA-12541 TNS:no listener\` pattern means the affected node cannot reach MGMTLSNR on the MGMTDB nodes — the local CHAD binary starts fine but cannot connect to GIMR.

If the trace shows no recent errors at all, use \`crsctl debug log res ora.chad:5\` to enable verbose GI debug logging before attempting a restart. The verbose log will show exactly where in the startup sequence CHAD fails.

---

## Phase 6: Resolution Path A — GIMR Connectivity

Run these checks on exadb-node01 (affected node) as the grid owner.

\`\`\`bash
# Check if MGMTLSNR is reachable from this node
lsnrctl status MGMTLSNR

# Test TNS connectivity to the MGMTDB service
tnsping mgmtdb
\`\`\`

In the \`lsnrctl status MGMTLSNR\` output, look for the MGMTDB service name (typically \`-mgmtdb\` or similar). If the service is not listed, MGMTDB has not registered with the listener on that endpoint — which can happen after a MGMTDB instance restart if the node's networking was briefly disrupted.

**If wallet authentication is configured for GIMR access:**

\`\`\`bash
# Check wallet directory and permissions
ls -la $ORACLE_BASE/network/admin/
ls -la $WALLET_LOCATION
\`\`\`

The wallet files (\`ewallet.p12\` and \`cwallet.sso\`) must be readable by the grid owner. If they are root-owned or have restrictive permissions, CHAD cannot authenticate to GIMR even if the listener is reachable.

**If TNS resolution is broken (\`tnsping\` fails with SP2 or TNS errors):**

\`\`\`bash
cat $ORACLE_HOME/network/admin/tnsnames.ora | grep -A5 -i mgmtdb
\`\`\`

Verify that the MGMTDB TNS entry is present and points to the correct host(s) and port. Compare with a healthy node's \`tnsnames.ora\` — they should be identical.

**After fixing the connectivity issue, start CHAD on the affected node:**

\`\`\`bash
crsctl start res ora.chad -init -n exadb-node01
\`\`\`

Wait 60 seconds and check:

\`\`\`bash
crsctl stat res ora.chad -init
\`\`\`

If the node shows ONLINE, repeat for exadb-node02. If it goes back OFFLINE within a few minutes, the connectivity problem was not fully resolved — re-examine ochad.trc immediately after the failed start.

---

## Phase 7: Resolution Path B — Stale or Corrupted CHA State (Most Common)

This is the most common resolution path after a GI patch application. It is safe to perform on a running cluster — CHAD on the other nodes continues operating normally while you purge the state on affected nodes one at a time.

**On exadb-node01 as grid owner:**

First, stop CHAD on the affected node:

\`\`\`bash
crsctl stop res ora.chad -init -n exadb-node01
\`\`\`

Back up the existing state directory before removing it:

\`\`\`bash
cp -rp $ORACLE_BASE/crsdata/exadb-node01/chad /tmp/chad_backup_$(date +%Y%m%d)
\`\`\`

Remove the state directory:

\`\`\`bash
rm -rf $ORACLE_BASE/crsdata/exadb-node01/chad
\`\`\`

Start CHAD. Clusterware will detect the missing state directory and recreate it, pulling the current model data from GIMR:

\`\`\`bash
crsctl start res ora.chad -init -n exadb-node01
\`\`\`

Verify the result within 60–90 seconds:

\`\`\`bash
crsctl stat res ora.chad -init
\`\`\`

exadb-node01 should now show ONLINE. If it does, the stale state was the cause — proceed with exadb-node02 using the same steps.

\`\`\`bash
# On exadb-node02 as grid owner
crsctl stop res ora.chad -init -n exadb-node02
cp -rp $ORACLE_BASE/crsdata/exadb-node02/chad /tmp/chad_backup_$(date +%Y%m%d)
rm -rf $ORACLE_BASE/crsdata/exadb-node02/chad
crsctl start res ora.chad -init -n exadb-node02
\`\`\`

**Why this works:** The CHA state directory stores model version metadata. After a patch changes the CHAD binary version, the old state directory's version tag no longer matches what the new binary expects. By removing the directory, you force CHAD to start with a clean slate. The model rebuild takes 2–3 minutes and uses data from GIMR, so no historical data is permanently lost as long as GIMR was healthy during the outage period.

---

## Phase 8: Resolution Path C — GI Patch Level Mismatch

If Phase 3 revealed that exadb-node01 and exadb-node02 are at a different GI patch level than the healthy nodes, patch remediation is the correct path.

First, confirm the mismatch on all six nodes:

\`\`\`bash
for NODE in exadb-node01 exadb-node02 exadb-node03 exadb-node04 exadb-node05 exadb-node06; do
  echo -n "$NODE: "
  ssh grid@$NODE "$ORACLE_HOME/bin/crsctl query crs releasepatch"
done
\`\`\`

**If affected nodes are at a lower patch level than healthy nodes:**
The patch was applied to the healthy nodes but not the affected nodes (or the application failed on those nodes). Apply the current GI patch to exadb-node01 and exadb-node02 in a rolling maintenance window.

For GI 12.2 and later, always use \`opatchauto\` — do NOT use \`opatch\` directly on the GI home:

\`\`\`bash
# Run as root on each affected node (one node at a time for rolling patch)
$ORACLE_HOME/OPatch/opatchauto apply /path/to/patch/XXXXXXX
\`\`\`

After \`opatchauto\` completes (it handles CRS stop/start automatically), verify:

\`\`\`bash
crsctl stop crs
crsctl start crs
crsctl stat res ora.chad -init
\`\`\`

**If affected nodes are at a HIGHER patch level than healthy nodes:**
This is unusual and suggests a patch was rolled back on the healthy nodes or applied only to the affected nodes without completing the rolling upgrade. Investigate the patch application history:

\`\`\`bash
$ORACLE_HOME/OPatch/opatch lspatches
\`\`\`

Compare output across nodes. Contact Oracle Support if the patch history shows an incomplete rollback — attempting to manually align patch levels without understanding the failure mode can make the situation worse.

---

## Phase 9: Resolution Path D — File Permission Issues

If the trace shows \`permission denied\` errors, the CHAD state directory or binaries have incorrect ownership.

\`\`\`bash
# Check ownership of the CHA state directory on exadb-node01
ls -la $ORACLE_BASE/crsdata/exadb-node01/chad/
\`\`\`

Expected output: all files and directories owned by the GI software owner (typically \`grid\`) with group \`oinstall\`. If files are owned by \`root\` or another user, CRS cannot write to the directory when running as the grid owner.

Fix the ownership:

\`\`\`bash
# Run as root
chown -R grid:oinstall $ORACLE_BASE/crsdata/exadb-node01/chad/
\`\`\`

After fixing permissions, stop and start CHAD:

\`\`\`bash
crsctl stop res ora.chad -init -n exadb-node01
crsctl start res ora.chad -init -n exadb-node01
\`\`\`

Permission issues on the CHA state directory are most often caused by a root-owned process writing into the directory during a failed upgrade or by a manual copy performed as root. Check whether any administrative activity on that node involved running GI commands as root that should have been run as the grid owner.

---

## Phase 10: Verify Full Recovery

After completing the applicable resolution path on both exadb-node01 and exadb-node02:

\`\`\`bash
# All six nodes should show ONLINE
crsctl stat res ora.chad -init
\`\`\`

\`\`\`bash
# Daemon-level confirmation
chactl status
\`\`\`

Both commands should now show all nodes healthy. Wait 2–3 minutes for CHAD to finish initializing its models after a state purge or fresh start, then check the CHA configuration:

\`\`\`bash
chactl config
\`\`\`

This confirms CHAD is configured for monitoring and shows which features (database performance, OS metrics, cluster health) are active.

**Confirm CHAD is collecting data** by checking the trace file for successful connection messages:

\`\`\`bash
tail -n 30 $ORACLE_BASE/diag/crs/exadb-node01/crs/trace/ochad.trc
\`\`\`

Look for messages indicating a successful connection to GIMR and the start of metric collection. The absence of ORA- errors in the first few minutes after startup is a good sign.

**Final validation checklist:**
- \`crsctl stat res ora.chad -init\`: all six nodes ONLINE
- \`chactl status\`: daemon running on all nodes
- \`chactl config\`: configuration shown (no error)
- ochad.trc (node01): no ORA- errors after restart timestamp
- ochad.trc (node02): no ORA- errors after restart timestamp
- Root cause documented for the post-incident record

---

## Phase 11: Automation Script — chad_diagnose.sh

Save this script as \`chad_diagnose.sh\` on a node with cluster connectivity. It collects all diagnostic data in one pass and prints a recommended action based on the errors found.

\`\`\`bash
#!/bin/bash
# chad_diagnose.sh
# Collects CHAD diagnostic data from all cluster nodes and recommends an action.
# Run as grid owner on any cluster node.

set -uo pipefail

# ============================================================
# CONFIGURATION
# ============================================================
AFFECTED_NODES="exadb-node01 exadb-node02"
ORACLE_BASE="/u01/app/grid"
GRID_HOME="/u01/app/19.3.0/grid"
LOG_DIR="/tmp/chad_diag"

# ============================================================
# SETUP
# ============================================================
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DIAG_DIR="$LOG_DIR/run_$TIMESTAMP"
LOG_FILE="$DIAG_DIR/chad_diag_$TIMESTAMP.log"

mkdir -p "$DIAG_DIR"

log() {
  echo "$1" | tee -a "$LOG_FILE"
}

section() {
  log ""
  log "============================================================"
  log "  $1"
  log "============================================================"
}

# Track what error patterns we find for the summary
FOUND_ORA_12541=0
FOUND_MODEL_MISMATCH=0
FOUND_PERMISSION=0
FOUND_NO_TRACE=0

log "CHAD Diagnostic Report"
log "Run time  : $(date)"
log "Run host  : $HOSTNAME"
log "Log file  : $LOG_FILE"

# ============================================================
# SECTION 1: Cluster-wide CHAD resource status
# ============================================================
section "1. CHAD Resource Status (all nodes)"
$GRID_HOME/bin/crsctl stat res ora.chad -init 2>&1 | tee -a "$LOG_FILE"

# ============================================================
# SECTION 2: chactl daemon status
# ============================================================
section "2. chactl status"
$GRID_HOME/bin/chactl status 2>&1 | tee -a "$LOG_FILE"

# ============================================================
# SECTION 3: MGMTDB health
# ============================================================
section "3. MGMTDB Status"
$GRID_HOME/bin/srvctl status mgmtdb 2>&1 | tee -a "$LOG_FILE"
log ""
log "--- MGMTDB Configuration ---"
$GRID_HOME/bin/srvctl config mgmtdb 2>&1 | tee -a "$LOG_FILE"

# ============================================================
# SECTION 4: GI active version
# ============================================================
section "4. GI Active Software Version"
$GRID_HOME/bin/crsctl query crs activeversion -f 2>&1 | tee -a "$LOG_FILE"

# ============================================================
# SECTION 5: GI patch level per node
# ============================================================
section "5. GI Patch Level Per Node"
for NODE in $AFFECTED_NODES; do
  log ""
  log "--- Node: $NODE ---"
  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
    "grid@$NODE" \
    "$GRID_HOME/bin/crsctl query crs releasepatch" 2>&1 | tee -a "$LOG_FILE" || \
    log "  [WARN] SSH to $NODE failed or timed out"
done
log ""
log "--- Local node ($HOSTNAME) for comparison ---"
$GRID_HOME/bin/crsctl query crs releasepatch 2>&1 | tee -a "$LOG_FILE"

# ============================================================
# SECTION 6: ochad trace analysis per affected node
# ============================================================
section "6. ochad Trace Analysis (Affected Nodes)"

for NODE in $AFFECTED_NODES; do
  log ""
  log "=== Node: $NODE ==="

  # Determine trace path
  PRIMARY_TRACE="$ORACLE_BASE/diag/crs/$NODE/crs/trace/ochad.trc"
  FALLBACK_TRACE="$ORACLE_BASE/crsdata/$NODE/trace/ochad.trc"

  TRACE_PATH=""
  if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "grid@$NODE" \
    "test -f $PRIMARY_TRACE" 2>/dev/null; then
    TRACE_PATH="$PRIMARY_TRACE"
  elif ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "grid@$NODE" \
    "test -f $FALLBACK_TRACE" 2>/dev/null; then
    TRACE_PATH="$FALLBACK_TRACE"
  fi

  if [ -z "$TRACE_PATH" ]; then
    log "  [WARN] ochad.trc not found on $NODE in primary or fallback locations"
    FOUND_NO_TRACE=1
    continue
  fi

  log "  Trace path: $TRACE_PATH"
  log ""
  log "  --- Last 150 lines of ochad.trc ---"
  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "grid@$NODE" \
    "tail -n 150 $TRACE_PATH" 2>&1 | tee -a "$LOG_FILE"

  log ""
  log "  --- Error patterns in ochad.trc ---"
  ERRORS=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "grid@$NODE" \
    "grep -iE 'ORA-|error|fail|exception|refused|timeout|unable|cannot' $TRACE_PATH 2>/dev/null | tail -n 100" 2>&1)

  echo "$ERRORS" | tee -a "$LOG_FILE"

  # Check for specific patterns
  if echo "$ERRORS" | grep -qiE 'ORA-12541|ORA-12514|no listener'; then
    FOUND_ORA_12541=1
  fi
  if echo "$ERRORS" | grep -qiE 'model version|CHA persistence|failed to load|mismatch'; then
    FOUND_MODEL_MISMATCH=1
  fi
  if echo "$ERRORS" | grep -qi 'permission denied'; then
    FOUND_PERMISSION=1
  fi
done

# ============================================================
# SECTION 7: CRS alert.log CHAD references
# ============================================================
section "7. CRS Alert Log — CHAD References (Affected Nodes)"

for NODE in $AFFECTED_NODES; do
  log ""
  log "=== Node: $NODE ==="
  ALERT_LOG="$ORACLE_BASE/diag/crs/$NODE/crs/trace/alert.log"
  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "grid@$NODE" \
    "grep -iE 'chad|ochad|CRS-' $ALERT_LOG 2>/dev/null | tail -n 50" 2>&1 | tee -a "$LOG_FILE" || \
    log "  [WARN] Could not read alert.log on $NODE"
done

# ============================================================
# SECTION 8: CHA state directory inspection
# ============================================================
section "8. CHA State Directory (Affected Nodes)"

for NODE in $AFFECTED_NODES; do
  log ""
  log "=== Node: $NODE ==="
  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "grid@$NODE" \
    "ls -la $ORACLE_BASE/crsdata/$NODE/chad/ 2>/dev/null || echo '  [INFO] State directory does not exist (already purged or never created)'" \
    2>&1 | tee -a "$LOG_FILE" || \
    log "  [WARN] Could not check state directory on $NODE"
done

# ============================================================
# SECTION 9: Summary and recommended action
# ============================================================
section "9. SUMMARY AND RECOMMENDED ACTION"

log ""
log "Diagnostic findings:"
log "  GIMR listener error (ORA-12541/12514) : $([ $FOUND_ORA_12541 -eq 1 ] && echo 'YES' || echo 'no')"
log "  CHA state/model mismatch              : $([ $FOUND_MODEL_MISMATCH -eq 1 ] && echo 'YES' || echo 'no')"
log "  File permission denied                : $([ $FOUND_PERMISSION -eq 1 ] && echo 'YES' || echo 'no')"
log "  ochad.trc not found or empty          : $([ $FOUND_NO_TRACE -eq 1 ] && echo 'YES' || echo 'no')"
log ""

if [ $FOUND_MODEL_MISMATCH -eq 1 ]; then
  log "RECOMMENDED ACTION: Resolution Path B — Stale CHA State Purge"
  log "  For each affected node:"
  log "    crsctl stop res ora.chad -init -n <node>"
  log "    cp -rp \$ORACLE_BASE/crsdata/<node>/chad /tmp/chad_backup_$(date +%Y%m%d)"
  log "    rm -rf \$ORACLE_BASE/crsdata/<node>/chad"
  log "    crsctl start res ora.chad -init -n <node>"
  log "  See Phase 7 of the runbook for full steps."
elif [ $FOUND_ORA_12541 -eq 1 ]; then
  log "RECOMMENDED ACTION: Resolution Path A — GIMR Connectivity Fix"
  log "  On each affected node, run:"
  log "    lsnrctl status MGMTLSNR"
  log "    tnsping mgmtdb"
  log "  Check tnsnames.ora, wallet permissions, and MGMTLSNR reachability."
  log "  See Phase 6 of the runbook for full steps."
elif [ $FOUND_PERMISSION -eq 1 ]; then
  log "RECOMMENDED ACTION: Resolution Path D — File Permission Fix"
  log "  Run as root on each affected node:"
  log "    chown -R grid:oinstall \$ORACLE_BASE/crsdata/<node>/chad/"
  log "  Then stop and start ora.chad on each node."
  log "  See Phase 9 of the runbook for full steps."
elif [ $FOUND_NO_TRACE -eq 1 ]; then
  log "RECOMMENDED ACTION: Enable verbose logging and attempt forced start"
  log "  \$GRID_HOME/bin/crsctl debug log res ora.chad:5"
  log "  \$GRID_HOME/bin/crsctl start res ora.chad -init -n <node>"
  log "  Then re-examine ochad.trc immediately after the start attempt."
else
  log "RECOMMENDED ACTION: Review ochad.trc manually — no clear pattern matched."
  log "  Full trace output is in: $LOG_FILE"
  log "  Compare patch levels between affected and healthy nodes (Phase 3)."
  log "  If patch levels differ, proceed to Resolution Path C (Phase 8)."
fi

log ""
log "Full diagnostic log: $LOG_FILE"
log "Diagnostic complete: $(date)"
\`\`\`

Make the script executable and run it:

\`\`\`bash
chmod +x chad_diagnose.sh
./chad_diagnose.sh
\`\`\`

The script writes all output to \`$LOG_DIR/run_TIMESTAMP/chad_diag_TIMESTAMP.log\` and prints the recommended action at the end.

---

## Phase 12: Troubleshooting

**CHAD restarts briefly then goes OFFLINE again**

The most important thing to do is examine ochad.trc immediately after the failed restart — the trace is overwritten on each start attempt and the error from the latest attempt will be at the bottom. If you purged the state directory (Path B) but CHAD keeps failing, the state was not the only problem. Proceed to the connectivity check (Path A) and look for \`ORA-12541\` or \`ORA-12514\` errors in the new trace content.

**\`crsctl start res ora.chad -init\` fails with CRS-5702**

CRS-5702 means the resource cannot start on the specified node because the GI stack itself is not fully operational on that node. Verify the stack first:

\`\`\`bash
crsctl stat res -t | head -20
\`\`\`

Look for OCR, voting disk, and CSS resources. If those are OFFLINE, the node needs its full CRS stack restarted before CHAD can be addressed:

\`\`\`bash
crsctl start crs
\`\`\`

**MGMTDB will not start**

If MGMTDB (which backs GIMR) cannot start, check its alert log at \`$ORACLE_BASE/diag/rdbms/\-mgmtdb/-MGMTDB/trace/alert_-MGMTDB.log\`. The most common reasons are that the DATA or FRA ASM disk groups are not mounted on the node where MGMTDB is trying to start. Verify:

\`\`\`bash
srvctl status asm
asmcmd lsdg
\`\`\`

If the disk groups are mounted, look for ORA-01033 or ORA-03113 in the MGMTDB alert log.

**\`chactl\` commands return "CHAD is not running"**

This is a synonym for \`crsctl stat res ora.chad -init\` showing OFFLINE on the local node. It does not indicate a separate issue — the daemon is not running and must be started through CRS. Do not attempt to start CHAD manually outside of CRS (\`crsctl start res ora.chad -init -n <node>\` is the correct method).

**CHA state purge completes but CHAD still will not start**

Proceed to connectivity check (Path A). In some cases both a stale state and a connectivity issue are present simultaneously — the state purge removes the first barrier and exposes the second. Check ochad.trc after the failed restart following the purge and look for \`ORA-12541\` or TNS errors that were previously masked.

**ochad.trc shows no errors at all (CHAD never attempted startup)**

Enable verbose CRS logging for the CHAD resource before the next start attempt:

\`\`\`bash
crsctl debug log res ora.chad:5
\`\`\`

This sets debug level 5 for the ora.chad resource in Clusterware. Then attempt the start:

\`\`\`bash
crsctl start res ora.chad -init -n exadb-node01
\`\`\`

The CRS alert log and ochad.trc will now contain far more detail about exactly where in the startup sequence the failure occurs.

---

## Quick Reference

| Command | Purpose |
|---|---|
| \`crsctl stat res ora.chad -init\` | Status of CHAD on all nodes |
| \`chactl status\` | CHAD daemon status (user-friendly) |
| \`srvctl status mgmtdb\` | GIMR health |
| \`chactl start\` | Start CHAD on local node |
| \`crsctl start res ora.chad -init -n <node>\` | Start CHAD on specific node |
| \`crsctl stop res ora.chad -init -n <node>\` | Stop CHAD on specific node |
| \`crsctl query crs releasepatch\` | GI patch level |
| \`grep -i 'error\\|fail' ochad.trc\` | Scan CHAD trace for failures |
`,
};

async function main() {
  console.log('Inserting ora.chad partial-node OFFLINE runbook...');
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
  console.log('Inserted:', post.slug);
}

main().catch(console.error);
