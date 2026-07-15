import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-tns-ifile-context-file-internal-concurrent-manager-runbook';

const content = `
## Purpose

Use this runbook when the Internal Concurrent Manager (ICM) fails to start with ORA-12154 after an AutoConfig run, code tree migration, or environment refresh — while Forms sessions and self-service connections continue working normally. The selective failure pattern is the primary indicator that the problem is in the TNS ifile chain rather than in tnsnames.ora or the network.

The runbook covers: ifile location audit → IFILE directive verification → ICM startup triage → ifile content validation → s_ifile context file check → DB-tier ifile → remediation paths.

---

## Phase 1 — Establish the Environment

Source the EBS environment before running any checks.

### EBS 11i

\`\`\`bash
source /u01/applmgr/EBSPRD/EBSPRD_appnode01.env
echo "TWO_TASK     : \${TWO_TASK}"
echo "CP_TWO_TASK  : \${CP_TWO_TASK}"
echo "TNS_ADMIN    : \${TNS_ADMIN}"
echo "CONTEXT_FILE : \${CONTEXT_FILE}"
\`\`\`

### EBS R12.1.3

\`\`\`bash
source /u01/applmgr/EBSPRD/EBSPRD_appnode01.env
echo "TWO_TASK     : \${TWO_TASK}"
echo "CP_TWO_TASK  : \${CP_TWO_TASK}"
echo "TNS_ADMIN    : \${TNS_ADMIN}"
echo "CONTEXT_FILE : \${CONTEXT_FILE}"
\`\`\`

### EBS R12.2.x — Run Edition (ICM target)

\`\`\`bash
source /u01/applmgr/EBSPRD/EBSapps.env run
echo "TWO_TASK     : \${TWO_TASK}"
echo "CP_TWO_TASK  : \${CP_TWO_TASK}"
echo "TNS_ADMIN    : \${TNS_ADMIN}"
echo "CONTEXT_FILE : \${CONTEXT_FILE}"
\`\`\`

**Expected output:** All four variables should be set. If \`CP_TWO_TASK\` is empty, the ICM will fall back to \`TWO_TASK\`. If both are empty, there is a sourcing problem — stop and fix the environment script.

---

## Phase 2 — Verify the IFILE Directive in tnsnames.ora

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

**If missing:** AutoConfig was run with \`s_ifile\` blank in the context file. Jump to Phase 5.

**If present:** Capture the ifile path for Phase 3.

\`\`\`bash
IFILE_PATH=\$(grep -i "^IFILE" \${TNS_ADMIN}/tnsnames.ora | awk -F'=' '{print \$2}' | tr -d ' ')
echo "Derived ifile path: \${IFILE_PATH}"
\`\`\`

---

## Phase 3 — Validate the ifile

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
cat "\${IFILE_PATH}" 2>/dev/null || echo "[ifile not readable]"

echo ""
echo "=== CP_TWO_TASK service in ifile ==="
grep -i "\${CP_TWO_TASK}" "\${IFILE_PATH}" 2>/dev/null \
  && echo "FOUND: CP_TWO_TASK entry present in ifile" \
  || echo "NOT FOUND: CP_TWO_TASK entry absent from ifile"
\`\`\`

---

## Phase 4 — Test TNS Resolution

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

If \`tnsping \${TWO_TASK}\` succeeds but \`tnsping \${CP_TWO_TASK}\` returns ORA-12154, the CP service is not in tnsnames.ora and either the ifile is missing or the service is not defined in the ifile.

---

## Phase 5 — Audit s_ifile in the Context File

\`\`\`bash
echo "=== s_ifile parameter in context file ==="
grep -i "s_ifile" \${CONTEXT_FILE}

echo ""
echo "=== Context file location ==="
echo \${CONTEXT_FILE}
ls -lh \${CONTEXT_FILE}
\`\`\`

Compare the \`s_ifile\` value from the context file with \`IFILE_PATH\` from Phase 2.

\`\`\`bash
CTX_IFILE=\$(grep -i "s_ifile" \${CONTEXT_FILE} | sed 's/.*>\\(.*\\)<.*/\\1/' | tr -d '[:space:]')
echo "Context file s_ifile : \${CTX_IFILE}"
echo "tnsnames.ora IFILE   : \${IFILE_PATH}"

if [ "\${CTX_IFILE}" = "\${IFILE_PATH}" ]; then
  echo "MATCH: context file and tnsnames.ora agree on ifile path"
else
  echo "MISMATCH: context file and tnsnames.ora differ — AutoConfig was run after context file was edited, or context file was updated and AutoConfig has not been re-run"
fi
\`\`\`

---

## Phase 6 — Check the DB-Tier ifile (if applicable)

If the ICM connects through a SCAN listener or dedicated connection that the DB team manages in the DB-tier tnsnames.ora, check the DB-tier ifile from the database node.

\`\`\`bash
# Run on the database node as oracle
echo "=== DB-tier TNS_ADMIN ==="
echo \${ORACLE_HOME}/network/admin

echo ""
echo "=== DB-tier IFILE directive ==="
grep -i "^IFILE" \${ORACLE_HOME}/network/admin/tnsnames.ora 2>/dev/null \
  || echo "No IFILE directive in DB-tier tnsnames.ora"

echo ""
DB_IFILE=\$(grep -i "^IFILE" \${ORACLE_HOME}/network/admin/tnsnames.ora 2>/dev/null | awk -F'=' '{print \$2}' | tr -d ' ')
if [ -n "\${DB_IFILE}" ]; then
  ls -lh "\${DB_IFILE}" 2>/dev/null || echo "DB-tier ifile MISSING: \${DB_IFILE}"
fi

echo ""
echo "=== DB-tier s_ifile in DB context file ==="
grep -i "s_ifile" \${CONTEXT_FILE} 2>/dev/null || echo "No DB-tier CONTEXT_FILE set"
\`\`\`

---

## Phase 7 — ICM Startup Log Review

Review the FNDLIBR and ICM startup logs for the ORA-12154 context.

\`\`\`bash
echo "=== Last 50 lines of ICM startup log ==="
ls -lt \${APPLCSF}/log/\${APPL_SERVER_ID}/ 2>/dev/null | grep -i icm | head -5
LATEST_LOG=\$(ls -t \${APPLCSF}/log/\${APPL_SERVER_ID}/ICM*.log 2>/dev/null | head -1)
if [ -n "\${LATEST_LOG}" ]; then
  echo "Log: \${LATEST_LOG}"
  tail -50 "\${LATEST_LOG}"
else
  echo "No ICM log found — check \${APPLCSF}/log/"
fi

echo ""
echo "=== fnd_svc_components for ICM status ==="
echo "Run as apps in sqlplus:"
echo "  SELECT component_name, component_status, startup_mode"
echo "  FROM fnd_svc_components"
echo "  WHERE component_type = 'INTERNAL_MANAGER';"
\`\`\`

---

## Phase 8 — Remediation

Choose the appropriate option based on what Phases 2–7 identified.

---

### Option A — ifile is missing at the path in tnsnames.ora

The IFILE directive is present but points to a non-existent file. Restore or recreate the ifile:

\`\`\`bash
# Create a new ifile at the expected path and populate it with the CP service
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
ls -lh "\${IFILE_PATH}"

# Verify resolution
tnsping \${CP_TWO_TASK}
\`\`\`

---

### Option B — s_ifile is blank in the context file

AutoConfig generated a tnsnames.ora without any IFILE directive. Update the context file and re-run AutoConfig:

\`\`\`bash
# Edit the context file — set s_ifile to the intended ifile path
vi \${CONTEXT_FILE}
# Find: <s_ifile oa_var="s_ifile"></s_ifile>
# Change to: <s_ifile oa_var="s_ifile">/u01/applmgr/EBSPRD/inst/apps/EBSPRD_appnode01/ora/10.1.2/network/admin/ifile.ora</s_ifile>

# Re-run AutoConfig to regenerate tnsnames.ora with the IFILE directive
cd \${AD_TOP}/bin
./adautocfg.sh

# Confirm the directive appeared
grep -i "^IFILE" \${TNS_ADMIN}/tnsnames.ora

# Confirm the ifile itself exists (if it does not, run Option A to create it)
ls -lh "\${IFILE_PATH}"

# Verify CP_TWO_TASK resolves
tnsping \${CP_TWO_TASK}
\`\`\`

---

### Option C — ifile path changed after AutoConfig (path mismatch)

The context file \`s_ifile\` value was updated and AutoConfig was re-run, but the ifile was not created at the new path. The ifile exists at the old path.

\`\`\`bash
# Identify old path (check AutoConfig backup of context file)
OLD_CTX=\$(ls -t \${CONTEXT_FILE}.*.bak 2>/dev/null | head -1)
if [ -n "\${OLD_CTX}" ]; then
  OLD_IFILE=\$(grep -i "s_ifile" "\${OLD_CTX}" | sed 's/.*>\\(.*\\)<.*/\\1/' | tr -d '[:space:]')
  echo "Old ifile path: \${OLD_IFILE}"
  echo "New ifile path: \${IFILE_PATH}"
fi

# Option C1: Copy from old path to new path
cp "\${OLD_IFILE}" "\${IFILE_PATH}"
chmod 640 "\${IFILE_PATH}"
tnsping \${CP_TWO_TASK}

# Option C2: Revert s_ifile in context file to old path, re-run AutoConfig
# (use when the new path was an unintended change)
vi \${CONTEXT_FILE}
cd \${AD_TOP}/bin
./adautocfg.sh
tnsping \${CP_TWO_TASK}
\`\`\`

---

### Option D — CP_TWO_TASK service not defined in ifile or tnsnames.ora

The ifile exists and is readable, but does not contain a TNS entry for the CP_TWO_TASK service. This happens when the ifile was created as a placeholder (empty or with wrong service names) or was restored from a backup taken before the CP service was added.

\`\`\`bash
# Add the CP_TWO_TASK service to the ifile
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

---

## Phase 9 — Restart the ICM and Confirm

After resolving the ifile issue, restart the concurrent managers:

\`\`\`bash
echo "=== Stopping all concurrent managers ==="
\${FND_TOP}/bin/adcmctl.sh stop apps/<apps_password>

# Wait for shutdown
sleep 30

echo "=== Starting ICM ==="
\${FND_TOP}/bin/adcmctl.sh start apps/<apps_password>

# Allow ICM to initialize
sleep 60

echo "=== ICM status check ==="
\${FND_TOP}/bin/adcmctl.sh status apps/<apps_password>
\`\`\`

Verify in sqlplus:

\`\`\`sql
SELECT component_name,
       component_status,
       startup_mode,
       last_update_date
FROM   fnd_svc_components
WHERE  component_type = 'INTERNAL_MANAGER';
\`\`\`

Expected: \`component_status = RUNNING\`

---

## Automation Script

The \`check_tns_ifile.sh\` script automates Phases 1–5 and outputs a summary. Run it as the applmgr OS user after sourcing the EBS environment.

\`\`\`bash
#!/bin/bash
# check_tns_ifile.sh
# Usage: source <EBS env> && ./check_tns_ifile.sh
# Exits 0 if all checks pass, 1 if any check fails.

PASS=0
FAIL=0

check() {
  local label="\$1"
  local result="\$2"
  local expected="\$3"
  if echo "\${result}" | grep -q "\${expected}" 2>/dev/null; then
    echo "[PASS] \${label}"
    PASS=\$((PASS+1))
  else
    echo "[FAIL] \${label}"
    echo "       Result  : \${result}"
    echo "       Expected: contains '\${expected}'"
    FAIL=\$((FAIL+1))
  fi
}

echo "==========================="
echo " EBS TNS ifile health check"
echo " \$(date)"
echo "==========================="
echo ""

# 1. Environment variables
echo "--- Environment ---"
echo "TWO_TASK    : \${TWO_TASK:-[NOT SET]}"
echo "CP_TWO_TASK : \${CP_TWO_TASK:-[NOT SET]}"
echo "TNS_ADMIN   : \${TNS_ADMIN:-[NOT SET]}"
echo "CONTEXT_FILE: \${CONTEXT_FILE:-[NOT SET]}"
echo ""

[ -n "\${CP_TWO_TASK}" ] || { echo "[FAIL] CP_TWO_TASK is not set"; FAIL=\$((FAIL+1)); }
[ -n "\${TNS_ADMIN}" ] || { echo "[FAIL] TNS_ADMIN is not set"; FAIL=\$((FAIL+1)); }

# 2. IFILE directive in tnsnames.ora
echo "--- tnsnames.ora IFILE directive ---"
IFILE_LINE=\$(grep -i "^IFILE" \${TNS_ADMIN}/tnsnames.ora 2>/dev/null)
if [ -n "\${IFILE_LINE}" ]; then
  echo "[PASS] IFILE directive present: \${IFILE_LINE}"
  PASS=\$((PASS+1))
  IFILE_PATH=\$(echo "\${IFILE_LINE}" | awk -F'=' '{print \$2}' | tr -d ' ')
else
  echo "[FAIL] No IFILE directive in \${TNS_ADMIN}/tnsnames.ora"
  FAIL=\$((FAIL+1))
  IFILE_PATH=""
fi
echo ""

# 3. ifile existence
echo "--- ifile existence ---"
if [ -n "\${IFILE_PATH}" ]; then
  if [ -f "\${IFILE_PATH}" ]; then
    echo "[PASS] ifile exists: \${IFILE_PATH}"
    echo "       \$(ls -lh \${IFILE_PATH})"
    PASS=\$((PASS+1))
  else
    echo "[FAIL] ifile MISSING: \${IFILE_PATH}"
    FAIL=\$((FAIL+1))
  fi
else
  echo "[SKIP] No IFILE path to check (no directive found)"
fi
echo ""

# 4. CP_TWO_TASK in ifile
echo "--- CP_TWO_TASK entry in ifile ---"
if [ -n "\${IFILE_PATH}" ] && [ -f "\${IFILE_PATH}" ] && [ -n "\${CP_TWO_TASK}" ]; then
  if grep -qi "\${CP_TWO_TASK}" "\${IFILE_PATH}" 2>/dev/null; then
    echo "[PASS] CP_TWO_TASK (\${CP_TWO_TASK}) entry found in ifile"
    PASS=\$((PASS+1))
  else
    echo "[WARN] CP_TWO_TASK (\${CP_TWO_TASK}) not in ifile — may be in tnsnames.ora (check tnsping)"
  fi
else
  echo "[SKIP] ifile not available for CP_TWO_TASK search"
fi
echo ""

# 5. s_ifile context file vs tnsnames.ora match
echo "--- s_ifile context file consistency ---"
if [ -f "\${CONTEXT_FILE}" ] && [ -n "\${IFILE_PATH}" ]; then
  CTX_IFILE=\$(grep -i "s_ifile" \${CONTEXT_FILE} | sed 's/.*>\\(.*\\)<.*/\\1/' | tr -d '[:space:]')
  if [ "\${CTX_IFILE}" = "\${IFILE_PATH}" ]; then
    echo "[PASS] s_ifile in context file matches IFILE in tnsnames.ora"
    echo "       \${CTX_IFILE}"
    PASS=\$((PASS+1))
  else
    echo "[FAIL] s_ifile mismatch"
    echo "       context file : \${CTX_IFILE}"
    echo "       tnsnames.ora : \${IFILE_PATH}"
    FAIL=\$((FAIL+1))
  fi
else
  echo "[SKIP] Cannot compare — CONTEXT_FILE or IFILE_PATH not available"
fi
echo ""

# 6. tnsping CP_TWO_TASK
echo "--- tnsping CP_TWO_TASK ---"
if [ -n "\${CP_TWO_TASK}" ]; then
  TNSPING_OUT=\$(tnsping \${CP_TWO_TASK} 2>&1 | tail -3)
  if echo "\${TNSPING_OUT}" | grep -qi "OK"; then
    echo "[PASS] tnsping \${CP_TWO_TASK}: OK"
    PASS=\$((PASS+1))
  else
    echo "[FAIL] tnsping \${CP_TWO_TASK} failed"
    echo "       \${TNSPING_OUT}"
    FAIL=\$((FAIL+1))
  fi
else
  echo "[SKIP] CP_TWO_TASK not set"
fi
echo ""

# Summary
echo "==========================="
echo " RESULT: \${PASS} passed, \${FAIL} failed"
echo "==========================="

[ \${FAIL} -eq 0 ]
\`\`\`

---

## Summary

| Phase | Check | Expected |
|-------|-------|----------|
| 1 | Environment sourced | CP_TWO_TASK, TNS_ADMIN, CONTEXT_FILE set |
| 2 | IFILE directive in tnsnames.ora | Line beginning with IFILE = |
| 3 | ifile file exists at IFILE path | File present and readable |
| 4 | CP_TWO_TASK in ifile | Entry found, or tnsping OK from tnsnames.ora |
| 5 | s_ifile matches tnsnames.ora IFILE | Identical paths |
| 6 | DB-tier ifile (if applicable) | DB-tier IFILE directive present and ifile exists |
| 7 | ICM startup logs | No ORA-12154 after remediation |
| 8 | tnsping CP_TWO_TASK | Returns OK |
| 9 | ICM restart | component_status = RUNNING |

The selective failure signature — ICM fails, Forms sessions succeed — always points to the CP_TWO_TASK service being inaccessible. The first tnsping call in Phase 4 confirms it in under a minute. Phases 2–5 then identify which link in the chain is broken: missing directive, missing file, missing entry, or stale context file.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'EBS TNS ifile and ICM Startup Runbook: Diagnosing and Fixing ORA-12154 After AutoConfig Across 11i, R12.1.3, and R12.2.x',
    slug,
    excerpt: 'Step-by-step runbook for diagnosing ICM startup failures caused by a broken TNS ifile chain after an AutoConfig run, code tree migration, or environment refresh. Covers IFILE directive verification, ifile existence and content validation, s_ifile context file consistency checks, DB-tier ifile review, and four remediation paths. Includes the check_tns_ifile.sh automation script.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
