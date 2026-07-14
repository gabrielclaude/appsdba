import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-adtmplreport-sh-runbook';

const content = `
Operational runbook for running \`adtmplreport.sh\` in Oracle EBS environments. Covers pre-run environment validation, application tier and database tier procedures, output interpretation, multi-node comparison, and a full automation script.

**When to run:** Before and after every significant \`adpatch\` cycle; during post-upgrade validation; when investigating unexpected behavior that may be file-version related; when opening an Oracle Support SR that requires evidence of installed file versions.

---

## Phase 1: Pre-Run Environment Validation

Run on whichever tier you are about to report on. Verify all required variables are set before invoking the script.

### 1.1 Confirm EBS environment is sourced

\`\`\`bash
# Verify core variables
echo "ORACLE_HOME : \${ORACLE_HOME}"
echo "APPL_TOP    : \${APPL_TOP}"
echo "AD_TOP      : \${AD_TOP}"
echo "TWO_TASK    : \${TWO_TASK}"
echo "ORACLE_SID  : \${ORACLE_SID}"
\`\`\`

All five should have non-empty values. If any are blank, source the EBS environment:

\`\`\`bash
# EBS 11i — adjust path and SID for your environment
source /u01/applmgr/EBSPRD/appsutil/env/EBSPRD_\$(hostname -s).env

# EBS R12
source /u01/applmgr/EBSPRD/EBSprd/EBSprd_\$(hostname -s).env
\`\`\`

### 1.2 Confirm sqlplus connectivity

\`\`\`bash
echo "SELECT 'DB OK' FROM dual;" | \\
  \${ORACLE_HOME}/bin/sqlplus -s apps/<apps_password>@\${TWO_TASK}
\`\`\`

Expected output: \`DB OK\`. Any ORA- error here means the database connection is not healthy — resolve before running \`adtmplreport.sh\`.

### 1.3 Confirm the script exists

\`\`\`bash
ls -lh \${AD_TOP}/bin/adtmplreport.sh
\`\`\`

If the file is missing, \`AD_TOP\` is not set correctly or the AD product home has not been installed. Verify \`AD_TOP\` points to the \`ad\` product directory under \`\$APPL_TOP\`.

### 1.4 Create output directory

\`\`\`bash
REPORT_DIR=/tmp/adtmpl_reports
mkdir -p \${REPORT_DIR}
df -h \${REPORT_DIR}   # confirm adequate free space (at least 500 MB)
\`\`\`

---

## Phase 2: Application Tier Report

Run on each application node. In a multi-node environment, repeat this phase on every node and compare outputs in Phase 4.

### 2.1 Run adtmplreport.sh — app tier

\`\`\`bash
REPORT_DIR=/tmp/adtmpl_reports
NODE=\$(hostname -s)
DATESTAMP=\$(date +%Y%m%d_%H%M%S)
REPORT_FILE=\${REPORT_DIR}/apptier_\${NODE}_\${DATESTAMP}.txt

cd \${AD_TOP}/bin

adtmplreport.sh \\
  apps=<apps_password> \\
  report_file=\${REPORT_FILE}

echo "Exit code: \$?"
echo "Report: \${REPORT_FILE}"
ls -lh "\${REPORT_FILE}"
\`\`\`

### 2.2 Check for successful completion

\`\`\`bash
tail -20 "\${REPORT_FILE}"
\`\`\`

The last lines should include a summary section with counts. If the file is empty or ends mid-output, the script encountered a connection or permissions error. Check:

\`\`\`bash
grep -i "error\|ora-\|failed" "\${REPORT_FILE}" | head -20
\`\`\`

### 2.3 Count discrepancies by section

\`\`\`bash
echo "=== Section counts ==="
echo "Files in AD not on disk (Section 1):"
grep -c "^Section 1" "\${REPORT_FILE}" 2>/dev/null || \
  awk '/SECTION 1/,/SECTION 2/' "\${REPORT_FILE}" | grep -c "^/" 2>/dev/null
echo "Version mismatches (Section 2):"
awk '/SECTION 2/,/SECTION 3/' "\${REPORT_FILE}" | grep -c "^/" 2>/dev/null
echo "Conflicting registrations (Section 3):"
awk '/SECTION 3/,/SECTION 4/' "\${REPORT_FILE}" | grep -c "^/" 2>/dev/null
\`\`\`

A clean environment after a complete patch cycle should return zero or near-zero counts in all three sections.

### 2.4 Product-scoped report (optional)

When investigating a specific module, run a product-scoped report to reduce output volume:

\`\`\`bash
adtmplreport.sh \\
  apps=<apps_password> \\
  product=<PRODUCT_SHORT_NAME> \\
  report_file=\${REPORT_DIR}/apptier_\${NODE}_<PRODUCT_SHORT_NAME>_\${DATESTAMP}.txt
\`\`\`

Replace \`<PRODUCT_SHORT_NAME>\` with the Oracle product abbreviation: \`AR\`, \`AP\`, \`GL\`, \`PO\`, \`INV\`, \`FND\`, etc.

---

## Phase 3: Database Tier Report

Run on the database server node. If the database and application tiers share a node (uncommon in production), the \`tier=db\` parameter distinguishes the report scope.

### 3.1 Source the database-side EBS environment

\`\`\`bash
# Database node environment file
source /u01/oracle/EBSPRD/appsutil/env/EBSPRD_\$(hostname -s).env

# Verify
echo "ORACLE_SID: \${ORACLE_SID}"
echo "AD_TOP    : \${AD_TOP}"
\`\`\`

### 3.2 Run adtmplreport.sh — database tier

\`\`\`bash
REPORT_DIR=/tmp/adtmpl_reports
DATESTAMP=\$(date +%Y%m%d_%H%M%S)
REPORT_FILE=\${REPORT_DIR}/dbtier_\${DATESTAMP}.txt

cd \${AD_TOP}/bin

adtmplreport.sh \\
  apps=<apps_password> \\
  tier=db \\
  report_file=\${REPORT_FILE}

echo "Exit code: \$?"
echo "Report: \${REPORT_FILE}"
\`\`\`

### 3.3 Correlate with invalid database objects

Run this immediately after capturing the database tier report to cross-reference registered-but-invalid objects:

\`\`\`sql
-- Run in SQL*Plus as APPS
SELECT object_name,
       object_type,
       status,
       TO_CHAR(last_ddl_time, 'YYYY-MM-DD HH24:MI') AS last_ddl
FROM   dba_objects
WHERE  owner  = 'APPS'
  AND  status = 'INVALID'
ORDER BY object_type, object_name;
\`\`\`

Save the output to a file:

\`\`\`bash
sqlplus -s apps/<apps_password>@\${TWO_TASK} <<ENDSQL > \${REPORT_DIR}/invalid_objects_\${DATESTAMP}.txt
SET PAGESIZE 1000
SET LINESIZE 160
SET FEEDBACK OFF
COLUMN object_name FORMAT A45
COLUMN object_type FORMAT A20
COLUMN status FORMAT A8
COLUMN last_ddl FORMAT A18
SELECT object_name,
       object_type,
       status,
       TO_CHAR(last_ddl_time, 'YYYY-MM-DD HH24:MI') AS last_ddl
FROM   dba_objects
WHERE  owner  = 'APPS'
  AND  status = 'INVALID'
ORDER BY object_type, object_name;
EXIT;
ENDSQL
\`\`\`

Any object name appearing in both the adtmplreport.sh Section 2 output (version mismatch) and the invalid objects list is a definitive finding: the patch registered the new version but the compilation step failed.

### 3.4 Recompile invalid objects (if findings warrant)

If invalid objects are present after a patch run:

\`\`\`sql
-- Standard Oracle invalid object recompile
EXEC DBMS_UTILITY.COMPILE_SCHEMA(schema => 'APPS', compile_all => FALSE);
\`\`\`

Or use the EBS utility:

\`\`\`bash
# From the application tier
cd \$FND_TOP/patch/115/sql
sqlplus apps/<apps_password>@\${TWO_TASK} @\$FND_TOP/patch/115/sql/adupdobj.sql APPS
\`\`\`

After recompile, re-run the invalid objects query. Any objects that remain invalid after recompile have unresolvable dependencies and require the relevant patch to be re-applied.

---

## Phase 4: Multi-Node Comparison

In multi-node EBS environments, all application nodes must have identical file version levels. This phase compares application tier reports across nodes.

### 4.1 Collect reports from all nodes

Run Phase 2 on each application node, saving output to a shared NFS path that all nodes can write to:

\`\`\`bash
# On each node (replace shared_path with NFS mount accessible from all nodes):
SHARED=/nfs/ebs_reports/adtmpl
NODE=\$(hostname -s)
DATESTAMP=\$(date +%Y%m%d_%H%M%S)

adtmplreport.sh \\
  apps=<apps_password> \\
  report_file=\${SHARED}/apptier_\${NODE}_\${DATESTAMP}.txt
\`\`\`

### 4.2 Diff reports between nodes

\`\`\`bash
SHARED=/nfs/ebs_reports/adtmpl

# Get the two most recent reports (one per node)
RPT1=\$(ls -t \${SHARED}/apptier_appnode01_*.txt | head -1)
RPT2=\$(ls -t \${SHARED}/apptier_appnode02_*.txt | head -1)

echo "Comparing:"
echo "  \${RPT1}"
echo "  \${RPT2}"

# Strip timestamp header lines before diffing
diff \\
  <(grep -v "^Date:\|^Requested" "\${RPT1}") \\
  <(grep -v "^Date:\|^Requested" "\${RPT2}") \\
  > \${SHARED}/node_diff_\$(date +%Y%m%d).txt

DIFF_LINES=\$(wc -l < \${SHARED}/node_diff_\$(date +%Y%m%d).txt)
echo "Diff lines: \${DIFF_LINES}"
[ "\${DIFF_LINES}" -gt 0 ] && cat \${SHARED}/node_diff_\$(date +%Y%m%d).txt
\`\`\`

Zero diff output (after excluding timestamps) means the nodes are at the same file level. Any diff output identifies the specific files where the nodes differ.

### 4.3 Remediate node discrepancies

For each file that differs between nodes:

1. Identify which patch last installed the file at the correct version: query \`AD_PATCH_FILE_RS\` joined to \`AD_APPLIED_PATCHES\` for the file name.
2. On the node with the older version, re-apply that patch using \`adpatch\` with \`options=noautoconfig\` if the discrepancy is file-only and configuration files are in sync.
3. Re-run \`adtmplreport.sh\` on the remediated node and re-diff to confirm alignment.

---

## Automation Script

Save as \`run_adtmplreport.sh\`. Handles environment validation, both tier types, optional multi-node diff, and exits non-zero if discrepancies are found.

\`\`\`bash
#!/bin/bash
# adtmplreport.sh Automation Wrapper
# Usage: ./run_adtmplreport.sh <APPS_PWD> [db|app] [product]
# Examples:
#   ./run_adtmplreport.sh mypassword app
#   ./run_adtmplreport.sh mypassword db
#   ./run_adtmplreport.sh mypassword app GL

APPS_PWD=\${1:?"Usage: \$0 <APPS_PWD> [db|app] [product]"}
TIER=\${2:-app}
PRODUCT=\${3:-}

REPORT_DIR=/tmp/adtmpl_reports
NODE=\$(hostname -s)
DATESTAMP=\$(date +%Y%m%d_%H%M%S)
REPORT_FILE=\${REPORT_DIR}/\${TIER}tier_\${NODE}_\${DATESTAMP}.txt
INVALID_FILE=\${REPORT_DIR}/invalid_objects_\${DATESTAMP}.txt
SUMMARY_FILE=\${REPORT_DIR}/summary_\${TIER}tier_\${NODE}_\${DATESTAMP}.txt
FINDING=0

echo "============================================================" | tee "\${SUMMARY_FILE}"
echo "adtmplreport.sh Wrapper"                                     | tee -a "\${SUMMARY_FILE}"
echo "Node      : \${NODE}"                                         | tee -a "\${SUMMARY_FILE}"
echo "Tier      : \${TIER}"                                         | tee -a "\${SUMMARY_FILE}"
echo "Product   : \${PRODUCT:-all}"                                 | tee -a "\${SUMMARY_FILE}"
echo "Date      : \$(date)"                                         | tee -a "\${SUMMARY_FILE}"
echo "============================================================" | tee -a "\${SUMMARY_FILE}"

# --- Environment validation ---
echo "" | tee -a "\${SUMMARY_FILE}"
echo "[1] Environment Validation" | tee -a "\${SUMMARY_FILE}"
echo "--------------------------------------------------------------" | tee -a "\${SUMMARY_FILE}"

for VAR in ORACLE_HOME APPL_TOP AD_TOP; do
  VAL=\$(eval echo \$\${VAR})
  if [ -z "\${VAL}" ]; then
    echo "FAIL: \${VAR} is not set — source the EBS environment file first" | tee -a "\${SUMMARY_FILE}"
    exit 1
  fi
  echo "OK: \${VAR}=\${VAL}" | tee -a "\${SUMMARY_FILE}"
done

if [ ! -f "\${AD_TOP}/bin/adtmplreport.sh" ]; then
  echo "FAIL: adtmplreport.sh not found in \${AD_TOP}/bin" | tee -a "\${SUMMARY_FILE}"
  exit 1
fi

# Database connectivity check
DB_CHECK=\$(echo "SELECT 'OK' FROM dual;" | \\
  "\${ORACLE_HOME}/bin/sqlplus" -s apps/\${APPS_PWD} 2>&1 | grep '^OK')
if [ "\${DB_CHECK}" != "OK" ]; then
  echo "FAIL: Cannot connect to database as APPS — check password and TWO_TASK/ORACLE_SID" | tee -a "\${SUMMARY_FILE}"
  exit 1
fi
echo "OK: Database connectivity confirmed" | tee -a "\${SUMMARY_FILE}"

mkdir -p "\${REPORT_DIR}"
echo "OK: Report directory: \${REPORT_DIR}" | tee -a "\${SUMMARY_FILE}"

# --- Run adtmplreport.sh ---
echo "" | tee -a "\${SUMMARY_FILE}"
echo "[2] Running adtmplreport.sh" | tee -a "\${SUMMARY_FILE}"
echo "--------------------------------------------------------------" | tee -a "\${SUMMARY_FILE}"
echo "Output: \${REPORT_FILE}" | tee -a "\${SUMMARY_FILE}"

cd "\${AD_TOP}/bin"

if [ -n "\${PRODUCT}" ]; then
  adtmplreport.sh \\
    apps=\${APPS_PWD} \\
    tier=\${TIER} \\
    product=\${PRODUCT} \\
    report_file=\${REPORT_FILE}
else
  adtmplreport.sh \\
    apps=\${APPS_PWD} \\
    tier=\${TIER} \\
    report_file=\${REPORT_FILE}
fi

RC=\$?
echo "Exit code: \${RC}" | tee -a "\${SUMMARY_FILE}"

if [ \${RC} -ne 0 ]; then
  echo "FAIL: adtmplreport.sh exited with non-zero status" | tee -a "\${SUMMARY_FILE}"
  FINDING=1
fi

if [ ! -s "\${REPORT_FILE}" ]; then
  echo "FAIL: Report file is empty — script may have failed silently" | tee -a "\${SUMMARY_FILE}"
  FINDING=1
fi

# --- Check for errors in report output ---
echo "" | tee -a "\${SUMMARY_FILE}"
echo "[3] Error Scan in Report" | tee -a "\${SUMMARY_FILE}"
echo "--------------------------------------------------------------" | tee -a "\${SUMMARY_FILE}"

ERROR_LINES=\$(grep -ic "error\|ora-\|failed\|cannot" "\${REPORT_FILE}" 2>/dev/null)
echo "Error indicator lines in report: \${ERROR_LINES}" | tee -a "\${SUMMARY_FILE}"
if [ "\${ERROR_LINES}" -gt 0 ]; then
  echo "FINDING: Errors detected in report output:" | tee -a "\${SUMMARY_FILE}"
  grep -i "error\|ora-\|failed\|cannot" "\${REPORT_FILE}" | head -10 | tee -a "\${SUMMARY_FILE}"
  FINDING=1
fi

# --- Database tier: invalid object check ---
if [ "\${TIER}" = "db" ]; then
  echo "" | tee -a "\${SUMMARY_FILE}"
  echo "[4] Invalid Object Check (DB Tier)" | tee -a "\${SUMMARY_FILE}"
  echo "--------------------------------------------------------------" | tee -a "\${SUMMARY_FILE}"

  "\${ORACLE_HOME}/bin/sqlplus" -s apps/\${APPS_PWD} <<ENDSQL > "\${INVALID_FILE}"
SET PAGESIZE 1000
SET LINESIZE 160
SET FEEDBACK OFF
SET HEADING ON
COLUMN object_name FORMAT A45
COLUMN object_type FORMAT A20
COLUMN status FORMAT A8
COLUMN last_ddl FORMAT A18

SELECT object_name,
       object_type,
       status,
       TO_CHAR(last_ddl_time, 'YYYY-MM-DD HH24:MI') AS last_ddl
FROM   dba_objects
WHERE  owner  = 'APPS'
  AND  status = 'INVALID'
ORDER BY object_type, object_name;
EXIT;
ENDSQL

  INVALID_COUNT=\$(grep -c "INVALID" "\${INVALID_FILE}" 2>/dev/null)
  echo "Invalid APPS objects: \${INVALID_COUNT}" | tee -a "\${SUMMARY_FILE}"
  if [ "\${INVALID_COUNT}" -gt 0 ]; then
    echo "FINDING: \${INVALID_COUNT} invalid object(s) in APPS schema" | tee -a "\${SUMMARY_FILE}"
    echo "Invalid objects list saved to: \${INVALID_FILE}" | tee -a "\${SUMMARY_FILE}"
    cat "\${INVALID_FILE}" | tee -a "\${SUMMARY_FILE}"
    FINDING=1
  fi
fi

# --- Final summary ---
echo "" | tee -a "\${SUMMARY_FILE}"
echo "============================================================" | tee -a "\${SUMMARY_FILE}"
echo "Full report  : \${REPORT_FILE}" | tee -a "\${SUMMARY_FILE}"
echo "Summary      : \${SUMMARY_FILE}" | tee -a "\${SUMMARY_FILE}"
[ "\${TIER}" = "db" ] && echo "Invalid objs : \${INVALID_FILE}" | tee -a "\${SUMMARY_FILE}"
echo "" | tee -a "\${SUMMARY_FILE}"

if [ \${FINDING} -eq 1 ]; then
  echo "RESULT: One or more findings require attention (see above)" | tee -a "\${SUMMARY_FILE}"
else
  echo "RESULT: Clean — no discrepancies detected" | tee -a "\${SUMMARY_FILE}"
fi
echo "============================================================" | tee -a "\${SUMMARY_FILE}"

exit \${FINDING}
\`\`\`

### Usage examples

\`\`\`bash
chmod +x run_adtmplreport.sh

# Source EBS environment first
source /u01/applmgr/EBSPRD/EBSprd/EBSprd_appnode01.env

# App tier — full report
./run_adtmplreport.sh <apps_password> app

# App tier — GL module only
./run_adtmplreport.sh <apps_password> app GL

# Database tier — full report with invalid object check
./run_adtmplreport.sh <apps_password> db
\`\`\`

The script exits with code 1 if any discrepancy, ORA- error, or invalid object is found, making it safe to use in CI/CD or post-patch validation pipelines.

---

## Decision Matrix

| Finding | Likely cause | Action |
|---------|-------------|--------|
| Section 1: files in AD not on disk | Patch not propagated to this node | Re-apply the patch on this node; confirm shared file systems are mounted |
| Section 2: version mismatch on disk vs. AD | Manual file replacement or hotfix without AD registration | Re-apply the authoritative patch; never manually edit \`\$Header\` tags |
| Section 3: conflicting registrations | Patches applied out of order or overlapping file ownership | Identify the correct authoritative patch from Oracle Support; re-apply it |
| DB tier: invalid objects after patch | Compilation failed silently during \`d\` driver execution | Run \`DBMS_UTILITY.COMPILE_SCHEMA\`; re-apply patch if objects remain invalid |
| Node diff shows file differences | Patch applied on some nodes but not all | Run \`adpatch\` on the lagging node; re-diff to confirm alignment |
| Report file empty | DB connection failed or environment not sourced | Verify \`TWO_TASK\`/\`ORACLE_SID\`, re-source environment, test sqlplus |

---

## Summary

\`adtmplreport.sh\` is the definitive tool for validating that an Oracle EBS environment's installed file versions match the AD schema patch history. Run it on the application tier after any copy-driver patch, and on the database tier after any database-driver patch. In multi-node environments, collect reports from each node and diff to catch propagation gaps. The automation script wraps the tool with environment validation, error scanning, invalid object detection on the DB tier, and a non-zero exit code on any finding — making it a reliable component of any post-patch or pre-upgrade verification procedure.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'adtmplreport.sh Runbook: Application Tier, Database Tier, Multi-Node Comparison, and Automation',
    slug,
    excerpt: 'Operational runbook for adtmplreport.sh in Oracle EBS environments. Covers pre-run environment validation, application tier and database tier invocation, output interpretation, multi-node diff procedure to catch patch propagation gaps, correlation with invalid database objects, and a shell automation script that validates the environment, runs the report, scans for discrepancies, and exits non-zero on findings.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
