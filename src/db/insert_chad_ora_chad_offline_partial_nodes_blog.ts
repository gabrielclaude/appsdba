import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql);

const post = {
  title: 'Oracle CHAD Daemon Failing on a Subset of Cluster Nodes: Diagnosing ora.chad OFFLINE on Exadata and RAC',
  slug: 'oracle-chad-daemon-partial-node-failure-exadata-rac',
  excerpt:
    'The ora.chad resource shows ONLINE on four nodes and OFFLINE on two — but the GIMR database is healthy, the cluster is running, and there is no database outage. When CHAD fails on a subset of nodes, the fault is always local to the affected nodes. Root causes split into three categories: GIMR connectivity failure from the affected nodes, stale or corrupted local CHA model state (most common after patching), and GI patch level mismatch across the cluster. This post covers the diagnostic path and resolution for each.',
  category: 'exadata' as const,
  isPremium: false,
  published: true,
  publishedAt: new Date('2026-07-16T19:00:00.000Z'),
  content: `# Oracle CHAD Daemon Failing on a Subset of Cluster Nodes: Diagnosing ora.chad OFFLINE on Exadata and RAC

## Introduction

The scenario arrives without warning. You run your morning cluster health check and find \`crsctl stat res ora.chad -init\` reporting ONLINE on exadb-node03 through exadb-node06, and OFFLINE on exadb-node01 and exadb-node02. The rest of the cluster is healthy: Oracle Clusterware is running on all six nodes, the database instances are up, and the GIMR database is functional. There is no alert from the storage cells, no ORA- errors in the alert log, and no application downtime.

A typical \`crsctl stat res ora.chad -init\` output in this state looks like the following:

\`\`\`
NAME=ora.chad
TYPE=ora.chad.type
TARGET=ONLINE         ONLINE         ONLINE         ONLINE         ONLINE         ONLINE
STATE=OFFLINE         OFFLINE        ONLINE         ONLINE         ONLINE         ONLINE
                      (exadb-node01) (exadb-node02) (exadb-node03) (exadb-node04) (exadb-node05) (exadb-node06)
\`\`\`

Or in the more verbose per-node output format:

\`\`\`
NAME=ora.chad
TYPE=ora.chad.type
TARGET=ONLINE , ONLINE , ONLINE , ONLINE , ONLINE , ONLINE
STATE=OFFLINE on exadb-node01, OFFLINE on exadb-node02, ONLINE on exadb-node03, ONLINE on exadb-node04, ONLINE on exadb-node05, ONLINE on exadb-node06
\`\`\`

Why does this matter? The Cluster Health Advisor daemon (\`ochad\`) provides machine-learning-based predictive failure detection for cluster nodes, database instances, and — on Exadata — storage cells. When it is OFFLINE on two nodes, those nodes are operating without real-time anomaly detection. If exadb-node01 or exadb-node02 has a developing hardware problem, memory pressure, or I/O latency spike, CHAD will not generate an early warning. The monitoring blind spot exists precisely during the critical window before a hardware or OS event escalates into an outage.

This is not a database outage, and it does not require a maintenance window. But it must be resolved promptly — particularly if the two affected nodes have historically generated early warnings about CPU saturation, disk latency, or interconnect throughput degradation. CHAD's value is in the prediction, not the post-mortem.

---

## What CHAD Does and Why It Matters

CHAD — the Cluster Health Advisor — was introduced in Oracle Grid Infrastructure 12.2. It does not exist in GI 12.1 or earlier; if you are running GI 12.1 and do not see \`ora.chad\` in your CRS resource list, that is expected.

The \`ochad\` daemon runs as a per-node process, managed by CRS as an init resource (\`ora.chad\`). Unlike most CRS resources, init resources are managed outside the normal cluster resource framework — they start before the OCR and voting disk layer is fully initialized and are controlled with the \`-init\` flag in \`crsctl\` commands.

On each node, \`ochad\` continuously collects telemetry from multiple sources:

- **CPU utilization and scheduling latency** — distinguishing genuine saturation from temporary bursts
- **Memory pressure** — including swap activity, page fault rates, and SGA allocation patterns
- **I/O latency** — per-device read/write latency relative to historical baselines
- **Interconnect throughput** — private network traffic patterns between RAC nodes
- **Database wait events** — mapping wait class distributions against trained models
- **Exadata cell metrics** (when running on Exadata) — storage server CPU, flash cache hit rates, and cell offload efficiency

CHAD trains ML models on historical cluster telemetry and stores those models locally on each node. The central data warehouse is the GIMR — the Grid Infrastructure Management Repository — a RAC database running on the cluster itself, managed entirely by CRS. GIMR is also referred to as the management database (\`mgmtdb\`) and runs as a pluggable database inside a CRS-managed container. CHAD writes its collected telemetry to GIMR for persistence and cross-node correlation.

On Exadata, CHAD integrates with Exadata cell metrics collected via the \`exachk\` and \`TFA\` (Trace File Analyzer) pipelines, enabling storage server anomaly detection beyond what is visible from the database tier.

The \`chactl\` command set is the primary interface for CHAD operations:

| Command | Purpose |
|---|---|
| \`chactl status\` | Show daemon status and monitoring targets |
| \`chactl config\` | Display CHAD configuration and model paths |
| \`chactl start\` | Start CHAD monitoring on the current node |
| \`chactl stop\` | Stop CHAD monitoring on the current node |
| \`chactl calibrate\` | Rebuild ML models from historical GIMR data |
| \`chactl enable\` / \`chactl disable\` | Enable or disable per-node (GI 19c+) |

---

## How the CHAD Architecture Maps to Failure Modes

Understanding why CHAD fails on a subset of nodes requires mapping its three-layer dependency structure:

**Layer 1: The ochad binary and process itself**
The \`ochad\` process runs under the grid user on each node. CRS starts it as an init resource during GI startup. If the binary is missing, permissions are wrong, or a runtime library is unavailable, the process will not start.

**Layer 2: Local state files**
CHAD stores its trained ML models and local persistence data in \`$ORACLE_BASE/crsdata/<hostname>/chad/\`. This directory is node-specific — each node has its own copy of the models, which are rebuilt from GIMR telemetry during calibration. If these files are stale, corrupted, or version-incompatible with the installed ochad binary, CHAD will fail to initialize.

**Layer 3: Connectivity to GIMR**
CHAD must connect to MGMTDB (the GIMR container database) through MGMTLSNR (the management listener, typically on port 1525) from each node. If the TNS configuration on an affected node is wrong, the management listener is not accessible from that node's network interface, or the wallet credentials are stale, CHAD will fail its GIMR connection and exit.

The diagnostic key is this: when GIMR is confirmed healthy (because four of six nodes are successfully running CHAD against it), the fault must be in layer 1 or layer 2 on the two affected nodes. CRS attempts to restart \`ora.chad\` on each failure, and the repeated restart/fail cycle is visible in the CRS event log.

CRS can target init resources per node, which is useful for isolating and restarting CHAD without affecting the rest of the cluster:

\`\`\`bash
crsctl start res ora.chad -init -n exadb-node01
crsctl stop res ora.chad -init -n exadb-node01
crsctl stat res ora.chad -init
\`\`\`

The ochad trace file is the most direct path to the root cause. Its primary location in GI 19c and later is:

\`\`\`
\${ORACLE_BASE}/diag/crs/<hostname>/crs/trace/ochad.trc
\`\`\`

In GI 12.2 and 18c, the fallback location is:

\`\`\`
\${ORACLE_BASE}/crsdata/<hostname>/trace/ochad.trc
\`\`\`

---

## The Diagnostic Clue: Partial Node Failure

The partial failure pattern is the most important diagnostic signal in this scenario, and it is worth pausing on what it immediately rules out.

GIMR is a shared resource. It runs as a RAC database managed by CRS, with instances on two or more nodes. If four nodes can connect to GIMR and run CHAD successfully, then GIMR is definitively functional. This single observation eliminates the following candidates:

- **GIMR being down or unreachable** — four nodes would not be running CHAD if GIMR were inaccessible
- **Full cluster network partition** — the interconnect is clearly functional for most nodes
- **GI software corruption in the Oracle home** — a shared home issue would affect all nodes equally
- **CRS cluster-wide failure** — the cluster is healthy; this would be obvious from other symptoms
- **Storage cell outage** — Exadata cell problems produce entirely different error signatures

What remains after this elimination is exactly what needs investigation: what is different about exadb-node01 and exadb-node02 compared to the other four? The answer will fall into one of four categories: GIMR connectivity from those specific nodes, stale or incompatible local model state, GI patch level mismatch, or file system permission problems.

---

## Checking the Initial State

Before opening the trace file, collect the full state picture. Run these commands from one of the affected nodes and one of the healthy nodes, comparing output.

**Full resource state with node-level detail:**

\`\`\`bash
crsctl stat res ora.chad -init -v
\`\`\`

**High-level daemon status from chactl:**

\`\`\`bash
chactl status
\`\`\`

**Confirm GIMR is running:**

\`\`\`bash
srvctl status mgmtdb
\`\`\`

Expected output: \`Management database is running on node(s): exadb-node03, exadb-node04\` (or similar — at least one node must be active).

**GI active software version:**

\`\`\`bash
crsctl query crs activeversion -f
\`\`\`

**GI patch level — run on both an affected node and a healthy node and compare:**

\`\`\`bash
crsctl query crs releasepatch
\`\`\`

If the patch level output differs between exadb-node01/02 and exadb-node03/04/05/06, you have immediately identified the root cause: GI patch level mismatch from an incomplete rolling patch. If the levels match, proceed to the ochad trace file.

---

## Root Cause 1: GIMR Connectivity Failure from Affected Nodes

CHAD on each node connects to MGMTDB via MGMTLSNR, Oracle's dedicated management listener. By default MGMTLSNR listens on port 1525 on one or more cluster nodes. If the two affected nodes have a misconfigured local \`tnsnames.ora\`, a stale \`sqlnet.ora\` wallet reference, or if MGMTLSNR is not registering the MGMTDB service as accessible from those nodes' network interfaces, CHAD initialization fails at the connection step.

**Diagnosis steps on exadb-node01:**

Check whether MGMTLSNR is reachable and the MGMTDB service is registered:

\`\`\`bash
lsnrctl status MGMTLSNR
\`\`\`

Look for the \`MGMTDB\` service in the registered services section. If it is absent, the service is not registered with the management listener on this node.

Test TNS resolution and connectivity to MGMTDB from the affected node:

\`\`\`bash
tnsping mgmtdb
\`\`\`

If \`tnsping\` fails or times out, the TNS alias for \`mgmtdb\` is not resolving correctly from this node. Check \`$ORACLE_HOME/network/admin/tnsnames.ora\` and the GI-level \`tnsnames.ora\` in \`$ORACLE_BASE/crsdata/<hostname>/crs/\`.

**What appears in ochad.trc for Root Cause 1:**

\`\`\`
ORA-12541: TNS:no listener
ORA-12514: TNS:listener does not currently know of service requested in connect descriptor
ORA-01017: invalid username/password; logon denied
TNS-12535: TNS:operation timed out
\`\`\`

The \`ORA-01017\` case is particularly important: it indicates that CHAD is reaching the listener and the database service, but the wallet-based authentication credentials on the affected node are stale. This happens when the MGMTDB password was rotated and the wallet on exadb-node01/02 was not updated.

**Fix for Root Cause 1:**

If MGMTLSNR is not running on a node reachable from the affected hosts, start it:

\`\`\`bash
srvctl start mgmtlsnr
srvctl status mgmtlsnr
\`\`\`

If the MGMTDB service is not registered, force re-registration:

\`\`\`bash
srvctl stop mgmtdb
srvctl start mgmtdb
\`\`\`

If the wallet credentials are stale on the affected nodes, the wallet under \`\${ORACLE_BASE}/crsdata/<hostname>/crs/\` needs to be resynchronized. On healthy nodes, confirm the wallet content and copy or regenerate it on the affected nodes following your site's GI wallet management procedure.

After correcting the connectivity issue, restart CHAD on the affected node:

\`\`\`bash
crsctl start res ora.chad -init -n exadb-node01
\`\`\`

---

## Root Cause 2: Stale or Corrupted Local CHA State (Most Common After Patching)

This is the most common root cause when the cluster has recently been through a rolling GI patch cycle. After a GI patch or upgrade, the \`ochad\` binary version changes. The local CHA model files stored in \`$ORACLE_BASE/crsdata/<hostname>/chad/\` may be in a format that is incompatible with the new binary. When \`ochad\` starts, it attempts to load its model state from that directory, encounters the version mismatch, and exits. CRS detects the failure and attempts a restart, hitting the same error. After several restart attempts, CRS marks \`ora.chad\` as OFFLINE and stops retrying.

This pattern is especially common when a rolling patch was applied to nodes 1 and 2 first, and the patch cycle was not completed on the remaining nodes — or conversely, when nodes 1 and 2 were the last to be patched and the model files from the pre-patch binary are still present.

**What appears in ochad.trc for Root Cause 2:**

\`\`\`
model version mismatch: expected 19.x, found 18.x
failed to load CHA model from \${ORACLE_BASE}/crsdata/exadb-node01/chad/
error initializing CHA persistence layer
CHA repository initialization failed
\`\`\`

The exact wording varies by GI version, but the pattern is consistent: an initialization failure that references the local chad directory.

**Diagnosis:**

Compare the modification timestamps of the chad state directory on affected vs healthy nodes:

\`\`\`bash
ls -la \${ORACLE_BASE}/crsdata/exadb-node01/chad/
ls -la \${ORACLE_BASE}/crsdata/exadb-node03/chad/
\`\`\`

If the files on exadb-node01 are significantly older than on exadb-node03, or if the file sizes differ substantially, the state is likely from a previous binary version.

Also compare the GI patch level:

\`\`\`bash
# On affected node
crsctl query crs releasepatch

# On healthy node
crsctl query crs releasepatch
\`\`\`

**Fix for Root Cause 2:**

Stop CHAD on the affected node, move the stale state directory out of the way, and restart. CHAD will rebuild its models by pulling data from GIMR:

\`\`\`bash
# Stop CHAD on the affected node
chactl stop
# Alternatively, using crsctl:
crsctl stop res ora.chad -init -n exadb-node01

# Back up and remove the stale state directory
mv \${ORACLE_BASE}/crsdata/exadb-node01/chad \${ORACLE_BASE}/crsdata/exadb-node01/chad.bak

# Start CHAD — it will initialize a fresh state from GIMR
crsctl start res ora.chad -init -n exadb-node01
\`\`\`

Verify the resource comes ONLINE:

\`\`\`bash
crsctl stat res ora.chad -init
\`\`\`

Once CHAD is running, it will recalibrate its models against the historical GIMR data. Depending on how much telemetry is stored in GIMR and the cluster workload profile, full model readiness may take several minutes to hours. During this period, CHAD is collecting data but operating with reduced model confidence. You can force a calibration pass with:

\`\`\`bash
chactl calibrate
\`\`\`

---

## Root Cause 3: GI Patch Level Mismatch

Oracle's rolling patch process allows GI patches to be applied to cluster nodes one at a time while the cluster remains operational. The cluster temporarily runs at a mixed patch level during the rolling window. If the rolling patch was not completed — for example, if exadb-node01 and exadb-node02 were patched but the remaining nodes were not, or vice versa — the cluster can end up with a persistent patch level mismatch.

The \`ochad\` daemon communicates with peer nodes through GIPC (Grid Interprocess Communication) for cross-node anomaly correlation. A significant version difference between the ochad binary on the affected nodes and the healthy nodes can cause handshake failures at the GIPC layer, preventing CHAD from initializing.

**Diagnosis:**

\`\`\`bash
# Run on each node and compare
crsctl query crs releasepatch
\`\`\`

If exadb-node01 and exadb-node02 show a different patch level from exadb-node03 through exadb-node06, the rolling patch must be completed before CHAD will stabilize.

Check the ochad trace on the affected node for GIPC-related errors:

\`\`\`
GIPC error during peer registration
SKGXP: connection refused by peer
\`\`\`

**Fix for Root Cause 3:**

Complete the rolling patch on the nodes that are behind. Follow Oracle's standard rolling patch procedure for GI (typically using \`opatchauto apply\` with the \`-rolling\` flag). After all nodes are at the same patch level, restart CHAD on the previously affected nodes:

\`\`\`bash
crsctl start res ora.chad -init -n exadb-node01
crsctl start res ora.chad -init -n exadb-node02
\`\`\`

Do not attempt to force CHAD to run at a permanently mixed patch level — the GIPC communication layer requires consistent versions across cluster members.

---

## Root Cause 4: File Permission or ORACLE_BASE Issues

After a node rebuild, GI home relocation, or \`crsdata\` directory migration, the \`chad\` subdirectory may have incorrect ownership or permissions. The \`ochad\` process runs as the grid OS user; if the chad directory is owned by root or has permissions that block grid user access, the process will fail immediately at startup.

**Diagnosis:**

\`\`\`bash
ls -la \${ORACLE_BASE}/crsdata/exadb-node01/
ls -la \${ORACLE_BASE}/crsdata/exadb-node01/chad/
\`\`\`

Look for root ownership on the chad directory or its contents, or permissions set to 000. Compare with a healthy node:

\`\`\`bash
ls -la \${ORACLE_BASE}/crsdata/exadb-node03/chad/
\`\`\`

The chad directory and its contents should be owned by the grid user (commonly \`grid\` with group \`oinstall\` or \`asmadmin\`) with read-write permissions for the owner.

**What appears in ochad.trc for Root Cause 4:**

\`\`\`
permission denied: \${ORACLE_BASE}/crsdata/exadb-node01/chad/
cannot open file for write: chad_model.dat
\`\`\`

**Fix for Root Cause 4:**

\`\`\`bash
chown -R grid:oinstall \${ORACLE_BASE}/crsdata/exadb-node01/chad/
chmod -R 750 \${ORACLE_BASE}/crsdata/exadb-node01/chad/

# Then restart CHAD
crsctl start res ora.chad -init -n exadb-node01
\`\`\`

Adjust the group name to match your GI installation (some environments use \`dba\` or a custom group for the oracle home inventory group).

---

## Reading the ochad Trace File

The ochad trace file is the definitive first step. It names the failure explicitly. Every other diagnostic step is secondary to reading this file.

**Locate and grep the trace file on exadb-node01:**

\`\`\`bash
# GI 19c and later (standard ADR path)
grep -iE 'ORA-|error|fail|exception|refused|timeout|unable|cannot' \\
  \${ORACLE_BASE}/diag/crs/exadb-node01/crs/trace/ochad.trc | tail -100

# GI 12.2 / 18c (legacy path)
grep -iE 'ORA-|error|fail|exception|refused|timeout|unable|cannot' \\
  \${ORACLE_BASE}/crsdata/exadb-node01/trace/ochad.trc | tail -100
\`\`\`

The error pattern in the trace tells you exactly which root cause you are dealing with:

| Error pattern in ochad.trc | Root cause |
|---|---|
| \`ORA-12514\` or \`ORA-12541\` | GIMR connectivity — MGMTLSNR not reachable or service not registered |
| \`ORA-01017\` | GIMR connectivity — stale wallet credentials |
| \`model version mismatch\` | Stale local CHA model state (Root Cause 2) |
| \`CHA persistence\` or \`failed to load CHA model\` | Stale local CHA model state (Root Cause 2) |
| \`GIPC error\` or \`SKGXP\` | Interconnect/IPC issue, possibly patch level mismatch (Root Cause 3) |
| \`permission denied\` | File permissions on the chad state directory (Root Cause 4) |
| \`TNS-12535\` or \`TNS timeout\` | Network path to MGMTLSNR blocked from this node |

When the trace file is empty or very sparse, check whether the ochad process is even attempting to start:

\`\`\`bash
ps -ef | grep ochad
\`\`\`

If no ochad process appears at all, the CRS restart policy may have exhausted its retry count. Check the CRS event log:

\`\`\`bash
crsctl stat res ora.chad -init -v
\`\`\`

The \`LAST_SERVER_OFFLINE_REASON\` attribute in the verbose output provides the CRS-level failure code.

---

## GI Version Coverage

CHAD's behavior, trace file location, and available commands vary by GI version. Knowing which version you are on determines which diagnostics apply.

**GI 12.1 and earlier**
CHAD does not exist. The \`ora.chad\` resource is absent from the CRS resource list. \`chactl\` is not installed. If you are troubleshooting a cluster running GI 12.1, stop here — CHAD is simply not a feature in your version. Use OEM, exachk, and TFA for cluster health monitoring instead.

**GI 12.2**
CHAD is introduced. The \`ochad\` daemon is present. Basic \`chactl status\`, \`chactl start\`, \`chactl stop\`, and \`chactl config\` are available. The trace file lives in \`$ORACLE_BASE/crsdata/<hostname>/trace/ochad.trc\`. Calibration requires substantial historical GIMR data — a freshly installed GI 12.2 cluster needs at least a few days of normal workload before CHAD models are reliable.

**GI 18c**
\`chactl calibrate\` is improved and runs more efficiently. CHAD models gain I/O prediction capability (latency forecasting based on historical I/O patterns). The crsdata trace path is still used in 18c.

**GI 19c**
The most complete \`chactl\` command set: \`chactl enable\` and \`chactl disable\` allow per-node activation without stopping the resource cluster-wide. Trace files move to the standard ADR path under \`$ORACLE_BASE/diag/crs\`. The per-node targeting in \`crsctl start res ora.chad -init -n <node>\` is fully supported. GI 19c is the most widely deployed version for Exadata X8 and later and is the reference version for most production CHAD deployments.

**GI 21c**
CHAD is integrated with the Oracle Autonomous Health Framework (AHF). The \`ahf\` command set complements \`chactl\` — \`ahf status\`, \`ahf collect\`, and \`ahf analyze\` provide additional diagnostic depth. In GI 21c environments, running \`ahf analyze\` on the affected nodes after resolving the CHAD failure can surface related health issues that CHAD would have caught if it had been running.

---

## Prevention

The most reliable prevention for partial CHAD failures is completing rolling patches in a single maintenance window. A cluster with nodes at different GI patch levels is in a transitional state by design — leaving it overnight or across a weekend introduces risk, and CHAD failures are one of the more benign consequences. More serious consequences include voting disk communication problems and GIPC-layer hangs.

**Pre-patch backup of CHAD state:**

Before any GI patching operation, back up the local CHAD state directory on each node:

\`\`\`bash
cp -rp \${ORACLE_BASE}/crsdata/exadb-node01/chad/ /backup/chad_pre_patch/
\`\`\`

This preserves the trained models. If patching causes a version mismatch and you need to roll back the patch, the backup allows you to restore the pre-patch model state rather than waiting for CHAD to recalibrate.

**Daily health check inclusion:**

Include \`crsctl stat res ora.chad -init\` in daily cluster health checks alongside the standard \`crsctl stat res -t\`. CHAD is an init resource and is not visible in the regular resource table. A simple wrapper script or Enterprise Manager custom metric that checks for \`STATE=OFFLINE\` in the \`ora.chad\` resource output provides immediate notification.

**Enterprise Manager or custom alerting:**

Enterprise Manager 13c and later can monitor CRS init resources through the Grid Infrastructure target. If EM is not available, a custom CRS event hook can send an alert on \`ora.chad\` state transitions. CRS event hooks fire on resource state changes and can be configured to call an external notification script.

**Post-patch verification:**

After every GI patching cycle — whether rolling or full cluster — run the following immediately:

\`\`\`bash
crsctl stat res ora.chad -init
chactl status
srvctl status mgmtdb
\`\`\`

These three commands confirm that CHAD is running on all nodes, that the daemon is actively monitoring, and that GIMR is healthy. If any of the three shows a problem, resolve it before the maintenance window closes.

---

## Summary

Partial CHAD failures — where \`ora.chad\` is OFFLINE on a subset of cluster nodes while healthy on the rest — are always locally caused. The fact that GIMR is operational (proven by the working nodes) eliminates infrastructure-level failures and directs the diagnosis to what is different on the affected nodes. Read the \`ochad.trc\` trace file first: the error message classifies the failure into one of four root causes, and the fix for each is straightforward once the cause is identified. The overwhelming majority of post-patch cases are resolved by moving the stale \`$ORACLE_BASE/crsdata/<hostname>/chad/\` directory and allowing CHAD to rebuild its model state from GIMR. Complete your diagnosis before restarting to avoid masking an underlying connectivity issue — a connectivity failure that is silently ignored will cause CHAD to fail again at the next CRS restart cycle.`,
};

async function main() {
  console.log('Inserting Oracle CHAD partial node failure blog post...');
  await db.insert(posts).values(post).onConflictDoNothing();
  console.log(`Inserted: "${post.slug}"`);
}

main().catch(console.error);
