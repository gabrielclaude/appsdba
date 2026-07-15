import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';
import { eq } from 'drizzle-orm';

const slug = 'ebs-tns-ifile-context-file-internal-concurrent-manager-runbook';

const content = `
## Purpose

Use this runbook when the Internal Concurrent Manager (ICM) fails to start with ORA-12154 after an AutoConfig run, code tree migration, or environment refresh — while Forms sessions and self-service connections continue working normally. The selective failure pattern is the primary indicator that the problem is in the TNS ifile chain.

In a multi-tier EBS deployment, the ICM runs on a single designated node, but worker concurrent managers run on all application server nodes. Each node has its own TNS admin directory and its own ifile. A broken ifile on any node causes CMs on that node to fail, even if the ICM node is healthy. This runbook covers the ICM node first, then extends the same checks to all other application tier nodes.

Phase flow: inventory nodes → environment → IFILE directive → ifile validation → tnsping → s_ifile consistency → cross-node check → DB-tier → ICM logs → remediation.

---

## Phase 1 — Identify All Application Tier Nodes

Before running checks, enumerate all application server nodes so nothing is missed.

\`\`\`bash
# List all inst directories — one per node for R12.1 and R12.2
ls /u01/applmgr/EBSPRD/inst/apps/

# Identify the ICM node from the database
sqlplus -s apps/<apps_password> << 'EOF'
SELECT node_name,
       concurrent_queue_name,
       manager_type
FROM   fnd_concurrent_queues
WHERE  manager_type = 'I'
UNION ALL
SELECT DISTINCT node_name,
       'WORKER NODE' AS concurrent_queue_name,
       'W' AS manager_type
FROM   fnd_concurrent_queues
WHERE  manager_type != 'I'
ORDER BY 3, 1;
EOF
\`\`\`

Record the ICM node name and all worker CM node names before proceeding.

---

## Phase 2 — Establish the Environment on the ICM Node

Source the EBS environment on the node where the ICM is configured to run.

### EBS 11i

\`\`\`bash
source /u01/applmgr/EBSPRD/EBSPRD_appnode01.env
echo "TWO_TASK     : \${TWO_TASK}"
echo "CP_TWO_TASK  : \${CP_TWO_TASK}"
echo "TNS_ADMIN    : \${TNS_ADMIN}"
echo "CONTEXT_FILE : \${CONTEXT_FILE}"
echo "Hostname     : \$(hostname -s)"
\`\`\`

### EBS R12.1.3

\`\`\`bash
source /u01/applmgr/EBSPRD/EBSPRD_appnode01.env
echo "TWO_TASK     : \${TWO_TASK}"
echo "CP_TWO_TASK  : \${CP_TWO_TASK}"
echo "TNS_ADMIN    : \${TNS_ADMIN}"
echo "CONTEXT_FILE : \${CONTEXT_FILE}"
echo "Hostname     : \$(hostname -s)"
\`\`\`

### EBS R12.2.x — Run Edition

\`\`\`bash
source /u01/applmgr/EBSPRD/EBSapps.env run
echo "TWO_TASK     : \${TWO_TASK}"
echo "CP_TWO_TASK  : \${CP_TWO_TASK}"
echo "TNS_ADMIN    : \${TNS_ADMIN}"
echo "CONTEXT_FILE : \${CONTEXT_FILE}"
echo "Hostname     : \$(hostname -s)"
\`\`\`

**Expected:** All four variables set. If \`CP_TWO_TASK\` is empty, the ICM falls back to \`TWO_TASK\`. If both are empty, the environment script has a problem — stop and fix it before continuing.

---

## Phase 3 — Verify the IFILE Directive in tnsnames.ora

\`\`\`bash
echo "=== IFILE directive in tnsnames.ora ==="
grep -i "^IFILE" \${TNS_ADMIN}/tnsnames.ora

echo "=== Full tnsnames.ora header (first 10 lines) ==="
head -10 \${TNS_ADMIN}/tnsnames.ora
\`\`\`

**Expected:** A line like:

\`\`\`
IFILE = /u01/applmgr/EBSPRD/inst/apps/EBSPRD_appnode01/ora/10.1.2/network/admin/ifile.ora
\`\`\`

**If missing:** AutoConfig was run with \`s_ifile\` blank. Jump to Phase 6 (context file audit).

**If present:** Capture the ifile path:

\`\`\`bash
IFILE_PATH=\$(grep -i "^IFILE" \${TNS_ADMIN}/tnsnames.ora | awk -F'=' '{print \$2}' | tr -d ' ')
echo "Derived ifile path: \${IFILE_PATH}"
\`\`\`

---

## Phase 4 — Validate the ifile

\`\`\`bash
echo "=== ifile existence check ==="
if [ -f "\${IFILE_PATH}" ]; then
  echo "EXISTS: \${IFILE_PATH}"
  ls -lh "\${IFILE_PATH}"
else
  echo "MISSING: \${IFILE_PATH}"
fi

echo ""
echo "=== ifile contents ==="
cat "\${IFILE_PATH}" 2>/dev/null || echo "[ifile not readable or missing]"

echo ""
echo "=== CP_TWO_TASK service in ifile ==="
grep -i "\${CP_TWO_TASK}" "\${IFILE_PATH}" 2>/dev/null \
  && echo "FOUND: CP_TWO_TASK entry present in ifile" \
  || echo "NOT FOUND: CP_TWO_TASK entry absent from ifile"
\`\`\`

---

## Phase 5 — Test TNS Resolution

\`\`\`bash
echo "=== tnsping TWO_TASK ==="
tnsping \${TWO_TASK} 2>&1 | tail -5

echo ""
echo "=== tnsping CP_TWO_TASK ==="
tnsping \${CP_TWO_TASK} 2>&1 | tail -5
\`\`\`

**Expected for CP_TWO_TASK:**

\`\`\`
Used TNSNAMES adapter to resolve the alias
OK (nn msec)
\`\`\`

If \`tnsping \${TWO_TASK}\` succeeds but \`tnsping \${CP_TWO_TASK}\` returns ORA-12154, the CP service is not in tnsnames.ora and either the ifile is missing or the service is not defined there.

---

## Phase 6 — Audit s_ifile in the Context File

\`\`\`bash
echo "=== s_ifile parameter in context file ==="
grep -i "s_ifile" \${CONTEXT_FILE}

echo ""
echo "=== Context file ==="
echo \${CONTEXT_FILE}
ls -lh \${CONTEXT_FILE}
\`\`\`

Compare the \`s_ifile\` value from the context file with \`IFILE_PATH\` from Phase 3:

\`\`\`bash
CTX_IFILE=\$(grep -i "s_ifile" \${CONTEXT_FILE} | sed 's/.*>\\(.*\\)<.*/\\1/' | tr -d '[:space:]')
echo "Context file s_ifile : \${CTX_IFILE}"
echo "tnsnames.ora IFILE   : \${IFILE_PATH}"

if [ "\${CTX_IFILE}" = "\${IFILE_PATH}" ]; then
  echo "MATCH: context file and tnsnames.ora agree on ifile path"
else
  echo "MISMATCH: AutoConfig was run after context file was edited, or context file was changed and AutoConfig has not been re-run"
fi
\`\`\`

---

## Phase 7 — Cross-Node ifile Check (Multi-Tier)

After confirming the ICM node state in Phases 3–6, run the same checks across all other application tier nodes. This is critical because worker CMs on those nodes also need the CP_TWO_TASK service resolvable through their local ifile chains.

### Automated cross-node check

\`\`\`bash
#!/bin/bash
# Run on the ICM node; SSH to each worker CM node and check ifile health.
# Adjust APP_NODES and EBS_VERSION for your environment.

APP_NODES="appnode02 appnode03"    # space-separated list of non-ICM app nodes
EBS_ENV_CMD="source /u01/applmgr/EBSPRD/EBSapps.env run"   # or .env for 11i/R12.1

for NODE in \${APP_NODES}; do
  echo "========================================"
  echo " Checking: \${NODE}"
  echo "========================================"
  ssh applmgr@\${NODE} "
    \${EBS_ENV_CMD} 2>/dev/null
    echo 'Hostname     : '\$(hostname -s)
    echo 'CP_TWO_TASK  : '\${CP_TWO_TASK:-[NOT SET]}
    echo 'TNS_ADMIN    : '\${TNS_ADMIN:-[NOT SET]}
    echo ''

    IFILE_LINE=\$(grep -i '^IFILE' \${TNS_ADMIN}/tnsnames.ora 2>/dev/null)
    if [ -n \"\${IFILE_LINE}\" ]; then
      echo 'IFILE directive: '\${IFILE_LINE}
      IFILE_PATH=\$(echo \"\${IFILE_LINE}\" | awk -F'=' '{print \$2}' | tr -d ' ')
      if [ -f \"\${IFILE_PATH}\" ]; then
        echo 'ifile          : EXISTS'
        ls -lh \"\${IFILE_PATH}\"
        grep -i \"\${CP_TWO_TASK}\" \"\${IFILE_PATH}\" > /dev/null 2>&1 \
          && echo 'CP_TWO_TASK    : FOUND in ifile' \
          || echo 'CP_TWO_TASK    : NOT in ifile'
      else
        echo 'ifile          : MISSING at '\${IFILE_PATH}
      fi
    else
      echo 'IFILE directive: MISSING from tnsnames.ora'
    fi

    echo ''
    echo 'tnsping CP_TWO_TASK:'
    tnsping \${CP_TWO_TASK} 2>&1 | tail -3
  " 2>&1
  echo ""
done
\`\`\`

### Per-version inst directory paths (reference)

| Version | Node | ifile path |
|---------|------|-----------|
| 11i | appnode01 | \`\$IAS_ORACLE_HOME_N1/network/admin/ifile.ora\` |
| 11i | appnode02 | \`\$IAS_ORACLE_HOME_N2/network/admin/ifile.ora\` |
| R12.1.3 | appnode01 | \`/u01/applmgr/EBSPRD/inst/apps/EBSPRD_appnode01/ora/10.1.2/network/admin/ifile.ora\` |
| R12.1.3 | appnode02 | \`/u01/applmgr/EBSPRD/inst/apps/EBSPRD_appnode02/ora/10.1.2/network/admin/ifile.ora\` |
| R12.1.3 (OC4J) | appnode01 | \`/u01/applmgr/EBSPRD/inst/apps/EBSPRD_appnode01/ora/10.1.3/network/admin/ifile.ora\` |
| R12.2.x | appnode01 | \`/u01/applmgr/EBSPRD/inst/apps/EBSPRD_appnode01/ora/10.1.2/network/admin/ifile.ora\` |
| R12.2.x | appnode02 | \`/u01/applmgr/EBSPRD/inst/apps/EBSPRD_appnode02/ora/10.1.2/network/admin/ifile.ora\` |

---

## Phase 8 — Check the DB-Tier ifile (if applicable)

Run on each database node as the oracle OS user.

\`\`\`bash
echo "=== DB-tier TNS_ADMIN ==="
echo \${ORACLE_HOME}/network/admin

echo ""
echo "=== DB-tier IFILE directive ==="
grep -i "^IFILE" \${ORACLE_HOME}/network/admin/tnsnames.ora 2>/dev/null \
  || echo "No IFILE directive in DB-tier tnsnames.ora"

DB_IFILE=\$(grep -i "^IFILE" \${ORACLE_HOME}/network/admin/tnsnames.ora 2>/dev/null | awk -F'=' '{print \$2}' | tr -d ' ')
if [ -n "\${DB_IFILE}" ]; then
  ls -lh "\${DB_IFILE}" 2>/dev/null || echo "DB-tier ifile MISSING: \${DB_IFILE}"
fi

echo ""
echo "=== DB-tier s_ifile ==="
grep -i "s_ifile" \${CONTEXT_FILE} 2>/dev/null || echo "No CONTEXT_FILE set on DB tier"
\`\`\`

---

## Phase 9 — ICM Startup Log Review

\`\`\`bash
echo "=== Recent ICM log files ==="
ls -lt \${APPLCSF}/log/\${APPL_SERVER_ID}/ 2>/dev/null | grep -i icm | head -5

LATEST_LOG=\$(ls -t \${APPLCSF}/log/\${APPL_SERVER_ID}/ICM*.log 2>/dev/null | head -1)
if [ -n "\${LATEST_LOG}" ]; then
  echo "Log: \${LATEST_LOG}"
  tail -50 "\${LATEST_LOG}"
else
  echo "No ICM log found — check \${APPLCSF}/log/"
fi
\`\`\`

Check fnd_svc_components for ICM and all worker manager statuses:

\`\`\`sql
SELECT component_name,
       component_status,
       node_name,
       startup_mode,
       last_update_date
FROM   fnd_svc_components
ORDER  BY node_name, component_name;
\`\`\`

---

## Phase 10 — Remediation

Choose based on what Phases 3–9 identified. For multi-tier environments, apply the fix to the ICM node first, verify, then propagate to all worker CM nodes.

---

### Option A — ifile missing on one or more nodes

The IFILE directive is present in tnsnames.ora but points to a non-existent file.

\`\`\`bash
# Fix on the ICM node first
cat > "\${IFILE_PATH}" << 'IFILEBLOCK'
# EBS Concurrent Processing TNS entry
# Maintained manually — do NOT replace with AutoConfig output
EBSPRD_CP =
  (DESCRIPTION =
    (ADDRESS_LIST =
      (ADDRESS = (PROTOCOL = TCP)(HOST = ebsdb-scan.example.com)(PORT = 1521))
    )
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = EBSPRD_CP)
    )
  )
IFILEBLOCK

chmod 640 "\${IFILE_PATH}"
tnsping \${CP_TWO_TASK}

# Propagate to all worker CM nodes
for NODE in appnode02 appnode03; do
  REMOTE_IFILE="/u01/applmgr/EBSPRD/inst/apps/EBSPRD_\${NODE}/ora/10.1.2/network/admin/ifile.ora"
  scp "\${IFILE_PATH}" applmgr@\${NODE}:"\${REMOTE_IFILE}"
  ssh applmgr@\${NODE} "chmod 640 \${REMOTE_IFILE} && source /u01/applmgr/EBSPRD/EBSapps.env run && tnsping \${CP_TWO_TASK}"
done
\`\`\`

---

### Option B — s_ifile blank in context file(s)

AutoConfig generated tnsnames.ora without any IFILE directive. Fix each affected node's context file.

\`\`\`bash
# On each affected node, edit its own context file
vi \${CONTEXT_FILE}
# Find: <s_ifile oa_var="s_ifile"></s_ifile>
# Change to: <s_ifile oa_var="s_ifile">/u01/applmgr/EBSPRD/inst/apps/EBSPRD_appnode01/ora/10.1.2/network/admin/ifile.ora</s_ifile>

# Re-run AutoConfig on this node
cd \${AD_TOP}/bin
./adautocfg.sh

# Confirm directive appeared
grep -i "^IFILE" \${TNS_ADMIN}/tnsnames.ora

# Confirm ifile exists (if not, run Option A to create it)
ls -lh "\${IFILE_PATH}"
tnsping \${CP_TWO_TASK}
\`\`\`

Repeat on each application tier node. In a three-node deployment, each node's context file must be edited individually (each has a different hostname in the CONTEXT_NAME and therefore a different s_ifile path).

---

### Option C — ifile path changed after AutoConfig (path mismatch)

Context file was updated to a new \`s_ifile\` path and AutoConfig was re-run, but the ifile was not created at the new path.

\`\`\`bash
# Find the old ifile path from the AutoConfig backup
OLD_CTX=\$(ls -t \${CONTEXT_FILE}.*.bak 2>/dev/null | head -1)
if [ -n "\${OLD_CTX}" ]; then
  OLD_IFILE=\$(grep -i "s_ifile" "\${OLD_CTX}" | sed 's/.*>\\(.*\\)<.*/\\1/' | tr -d '[:space:]')
  echo "Old ifile path: \${OLD_IFILE}"
  echo "New ifile path: \${IFILE_PATH}"
fi

# Option C1: Copy ifile from old path to new path
cp "\${OLD_IFILE}" "\${IFILE_PATH}"
chmod 640 "\${IFILE_PATH}"
tnsping \${CP_TWO_TASK}

# Option C2: Revert context file to old path and re-run AutoConfig
vi \${CONTEXT_FILE}
cd \${AD_TOP}/bin
./adautocfg.sh
tnsping \${CP_TWO_TASK}
\`\`\`

---

### Option D — CP_TWO_TASK not defined in ifile or tnsnames.ora

The ifile exists but lacks the CP service entry.

\`\`\`bash
cat >> "\${IFILE_PATH}" << 'CPENTRY'

EBSPRD_CP =
  (DESCRIPTION =
    (ADDRESS_LIST =
      (ADDRESS = (PROTOCOL = TCP)(HOST = ebsdb-scan.example.com)(PORT = 1521))
    )
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = EBSPRD_CP)
    )
  )
CPENTRY

tnsping \${CP_TWO_TASK}
\`\`\`

Then propagate as in Option A.

---

### Option E — Switch to shared NFS ifile (permanent multi-tier fix)

If repeated per-node ifile drift is the root cause, switch all nodes to a single shared ifile on NFS.

\`\`\`bash
# 1. Create the shared ifile on NFS with the current CP_TWO_TASK entry
SHARED_IFILE="/shared/nfs/ebsprd/tns/ifile.ora"
mkdir -p \$(dirname \${SHARED_IFILE})

cat > "\${SHARED_IFILE}" << 'IFILEBLOCK'
EBSPRD_CP =
  (DESCRIPTION =
    (ADDRESS_LIST =
      (ADDRESS = (PROTOCOL = TCP)(HOST = ebsdb-scan.example.com)(PORT = 1521))
    )
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = EBSPRD_CP)
    )
  )
IFILEBLOCK

chmod 644 "\${SHARED_IFILE}"

# 2. On each application tier node, update s_ifile in the context file to point
#    to the shared path, then re-run AutoConfig
for NODE in appnode01 appnode02 appnode03; do
  ssh applmgr@\${NODE} "
    source /u01/applmgr/EBSPRD/EBSapps.env run
    # Edit CONTEXT_FILE: change s_ifile to \${SHARED_IFILE}
    vi \${CONTEXT_FILE}
    cd \${AD_TOP}/bin && ./adautocfg.sh
    grep -i '^IFILE' \${TNS_ADMIN}/tnsnames.ora
    tnsping \${CP_TWO_TASK}
  "
done

# 3. Verify all nodes resolve the CP service
for NODE in appnode01 appnode02 appnode03; do
  echo "=== \${NODE} ==="
  ssh applmgr@\${NODE} "source /u01/applmgr/EBSPRD/EBSapps.env run && tnsping \${CP_TWO_TASK} | tail -2"
done
\`\`\`

---

## Phase 11 — Restart the ICM and Confirm

After resolving the ifile on all nodes, restart the concurrent managers:

\`\`\`bash
echo "=== Stopping all concurrent managers ==="
\${FND_TOP}/bin/adcmctl.sh stop apps/<apps_password>

sleep 30

echo "=== Starting ICM ==="
\${FND_TOP}/bin/adcmctl.sh start apps/<apps_password>

sleep 60

echo "=== ICM status check ==="
\${FND_TOP}/bin/adcmctl.sh status apps/<apps_password>
\`\`\`

Verify ICM and all worker manager nodes in sqlplus:

\`\`\`sql
SELECT component_name,
       component_status,
       node_name,
       startup_mode,
       last_update_date
FROM   fnd_svc_components
ORDER  BY node_name, component_name;
\`\`\`

Expected: ICM shows \`RUNNING\` on the ICM node; worker managers show \`RUNNING\` on their respective nodes.

---

## Automation Script

The \`check_tns_ifile.sh\` script checks the current node and optionally SSH-checks all other application tier nodes. Run it as the applmgr OS user after sourcing the EBS environment.

\`\`\`bash
#!/bin/bash
# check_tns_ifile.sh
# Usage: source <EBS env> && ./check_tns_ifile.sh [node2 node3 ...]
# Optional args: additional hostnames to SSH-check.
# Exits 0 if all checks pass, 1 if any check fails.

EXTRA_NODES="\$@"
PASS=0
FAIL=0

check_node() {
  local NODE_LABEL="\$1"
  local CP="\$2"
  local TNS="\$3"
  local CTX="\$4"

  echo "--- \${NODE_LABEL} ---"

  # IFILE directive
  IFILE_LINE=\$(grep -i "^IFILE" "\${TNS}/tnsnames.ora" 2>/dev/null)
  if [ -n "\${IFILE_LINE}" ]; then
    echo "[PASS] IFILE directive present"
    PASS=\$((PASS+1))
    IFILE_PATH=\$(echo "\${IFILE_LINE}" | awk -F'=' '{print \$2}' | tr -d ' ')
  else
    echo "[FAIL] No IFILE directive in \${TNS}/tnsnames.ora"
    FAIL=\$((FAIL+1))
    IFILE_PATH=""
  fi

  # ifile existence
  if [ -n "\${IFILE_PATH}" ]; then
    if [ -f "\${IFILE_PATH}" ]; then
      echo "[PASS] ifile exists: \${IFILE_PATH}"
      PASS=\$((PASS+1))
    else
      echo "[FAIL] ifile MISSING: \${IFILE_PATH}"
      FAIL=\$((FAIL+1))
    fi
  fi

  # CP_TWO_TASK in ifile
  if [ -n "\${IFILE_PATH}" ] && [ -f "\${IFILE_PATH}" ] && [ -n "\${CP}" ]; then
    if grep -qi "\${CP}" "\${IFILE_PATH}" 2>/dev/null; then
      echo "[PASS] CP_TWO_TASK (\${CP}) in ifile"
      PASS=\$((PASS+1))
    else
      echo "[WARN] CP_TWO_TASK (\${CP}) not in ifile — may be in tnsnames.ora"
    fi
  fi

  # s_ifile vs tnsnames.ora match
  if [ -f "\${CTX}" ] && [ -n "\${IFILE_PATH}" ]; then
    CTX_IFILE=\$(grep -i "s_ifile" "\${CTX}" | sed 's/.*>\\(.*\\)<.*/\\1/' | tr -d '[:space:]')
    if [ "\${CTX_IFILE}" = "\${IFILE_PATH}" ]; then
      echo "[PASS] s_ifile matches tnsnames.ora IFILE"
      PASS=\$((PASS+1))
    else
      echo "[FAIL] s_ifile mismatch: ctx=\${CTX_IFILE} tns=\${IFILE_PATH}"
      FAIL=\$((FAIL+1))
    fi
  fi

  # tnsping
  if [ -n "\${CP}" ]; then
    TNSPING_OUT=\$(tnsping "\${CP}" 2>&1 | tail -3)
    if echo "\${TNSPING_OUT}" | grep -qi "OK"; then
      echo "[PASS] tnsping \${CP}: OK"
      PASS=\$((PASS+1))
    else
      echo "[FAIL] tnsping \${CP} failed: \${TNSPING_OUT}"
      FAIL=\$((FAIL+1))
    fi
  fi

  echo ""
}

echo "============================"
echo " EBS TNS ifile health check"
echo " \$(date)"
echo "============================"
echo ""
echo "Local node: \$(hostname -s)"
echo "CP_TWO_TASK: \${CP_TWO_TASK:-[NOT SET]}"
echo "TNS_ADMIN  : \${TNS_ADMIN:-[NOT SET]}"
echo ""

# Check local (ICM) node
check_node "\$(hostname -s) [local]" "\${CP_TWO_TASK}" "\${TNS_ADMIN}" "\${CONTEXT_FILE}"

# Check additional nodes via SSH
for NODE in \${EXTRA_NODES}; do
  echo "--- SSH check: \${NODE} ---"
  ssh applmgr@\${NODE} "
    source /u01/applmgr/EBSPRD/EBSapps.env run 2>/dev/null \
      || source /u01/applmgr/EBSPRD/EBSPRD_\$(hostname -s).env 2>/dev/null
    IFILE_LINE=\$(grep -i '^IFILE' \${TNS_ADMIN}/tnsnames.ora 2>/dev/null)
    if [ -n \"\${IFILE_LINE}\" ]; then
      echo '[PASS] IFILE directive present'
      IFILE_PATH=\$(echo \"\${IFILE_LINE}\" | awk -F'=' '{print \$2}' | tr -d ' ')
      [ -f \"\${IFILE_PATH}\" ] && echo '[PASS] ifile exists' || echo '[FAIL] ifile MISSING'
    else
      echo '[FAIL] No IFILE directive'
    fi
    tnsping \${CP_TWO_TASK} 2>&1 | tail -2
  " 2>&1 | sed \"s/^/  /\"
  echo ""
done

echo "============================"
echo " RESULT: \${PASS} passed, \${FAIL} failed"
echo "============================"

[ \${FAIL} -eq 0 ]
\`\`\`

**Usage examples:**

\`\`\`bash
# Check only the current (ICM) node
source /u01/applmgr/EBSPRD/EBSapps.env run && ./check_tns_ifile.sh

# Check ICM node + two worker CM nodes
source /u01/applmgr/EBSPRD/EBSapps.env run && ./check_tns_ifile.sh appnode02 appnode03
\`\`\`

---

## Summary

| Phase | Check | Node scope |
|-------|-------|-----------|
| 1 | Identify all app tier nodes; confirm ICM node | DB query |
| 2 | Source EBS environment | ICM node |
| 3 | IFILE directive in tnsnames.ora | ICM node |
| 4 | ifile exists and contains CP_TWO_TASK | ICM node |
| 5 | tnsping TWO_TASK and CP_TWO_TASK | ICM node |
| 6 | s_ifile in context file matches tnsnames.ora | ICM node |
| 7 | Cross-node ifile check (IFILE directive + ifile existence + tnsping) | All worker CM nodes |
| 8 | DB-tier IFILE directive and ifile existence | Each DB node |
| 9 | ICM startup log — no ORA-12154 | ICM node |
| 10 | Remediation — fix ICM node first, then propagate to all other nodes | All affected nodes |
| 11 | Restart ICM; verify RUNNING on ICM node and all worker CM nodes | All |

Fix the ICM node's ifile first to restore CP startup. Then verify every worker CM node before restarting the concurrent manager stack — an ICM that starts successfully but cannot bring up worker CMs on other nodes will log a cascade of startup errors that are harder to diagnose than the original ORA-12154.
`.trim();

async function main() {
  await db.update(posts).set({
    title: 'EBS TNS ifile and ICM Startup Runbook: Multi-Tier ifile Diagnosis and Remediation Across 11i, R12.1.3, and R12.2.x',
    excerpt: 'Step-by-step runbook for diagnosing ICM and worker CM startup failures caused by a broken TNS ifile chain in multi-tier EBS deployments. Covers per-node IFILE directive verification, ifile existence and content validation, cross-node SSH checks, s_ifile context file consistency, DB-tier ifile review, and five remediation paths including a shared NFS ifile strategy. Includes the check_tns_ifile.sh automation script with optional multi-node SSH mode.',
    content,
    publishedAt: new Date(),
  }).where(eq(posts.slug, slug));
  console.log('Updated:', slug);
}

main().catch(console.error);
