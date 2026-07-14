import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-code-tree-s-cp-twotask-runbook';

const content = `
Operational runbook for inspecting and changing \`s_cp_twotask\` in the Oracle EBS Applications Context File across 11i, R12.1.3, and R12.2.x environments. Covers pre-change validation, the context file edit, AutoConfig execution, Concurrent Manager restart, and post-change verification on both the application and database tiers.

**When to use:** When changing the Oracle Net service used by the Concurrent Manager; when separating CP connections from OLTP connections in RAC; when configuring CP to use an Active Data Guard standby service; when troubleshooting CP connection failures that differ from general app tier failures.

---

## Phase 1: Pre-Change Audit

Before touching any configuration, capture the current state. This establishes a rollback baseline.

### 1.1 Identify the active CONTEXT_FILE and source the environment

\`\`\`bash
# EBS 11i
source /u01/applmgr/EBSPRD/appsutil/env/EBSPRD_\$(hostname -s).env
echo "CONTEXT_FILE: \$CONTEXT_FILE"

# EBS R12.1.3
source /u01/applmgr/EBSPRD/apps/apps_st/appl/EBSprd_\$(hostname -s).env
echo "CONTEXT_FILE: \$CONTEXT_FILE"

# EBS R12.2.x — always source the run edition for operational changes
source /u01/applmgr/EBSPRD/EBSapps.env run
echo "CONTEXT_FILE: \$CONTEXT_FILE"
\`\`\`

### 1.2 Capture current s_cp_twotask and s_twotask values

\`\`\`bash
echo "=== Context File Parameter Snapshot ==="
echo "CONTEXT_FILE : \$CONTEXT_FILE"
echo "s_twotask    : \$(grep -i '<s_twotask ' \$CONTEXT_FILE | sed 's/.*>\\(.*\\)<.*/\\1/')"
echo "s_cp_twotask : \$(grep -i 's_cp_twotask' \$CONTEXT_FILE | sed 's/.*>\\(.*\\)<.*/\\1/')"
echo ""
echo "=== Active Environment Variables ==="
echo "TWO_TASK    : \$TWO_TASK"
echo "CP_TWO_TASK : \$CP_TWO_TASK"
\`\`\`

Save this output to a file before proceeding.

### 1.3 Verify the current TNS service resolves

\`\`\`bash
CURRENT_CP=\$(grep -i 's_cp_twotask' \$CONTEXT_FILE | sed 's/.*>\\(.*\\)<.*/\\1/')
echo "Current CP service: \${CURRENT_CP}"
tnsping "\${CURRENT_CP}"
\`\`\`

### 1.4 Confirm Concurrent Manager is running and healthy

\`\`\`bash
\$FND_TOP/bin/adcmctl.sh status apps/<apps_password>
\`\`\`

Note how many managers are running. This is the baseline to compare against after the change.

### 1.5 Verify current CP sessions on the database tier

\`\`\`sql
-- Run in SQL*Plus as APPS or SYSTEM
SELECT s.service_name,
       s.program,
       COUNT(*) AS session_count
FROM   v\$session s
WHERE  s.username = 'APPS'
  AND  (s.program LIKE '%FNDLIBR%'
     OR s.program LIKE '%FNDSM%'
     OR s.program LIKE '%ICM%')
GROUP BY s.service_name, s.program
ORDER BY s.service_name, s.program;
\`\`\`

Record the \`SERVICE_NAME\` values. After the change, all CP sessions should appear under the new service.

### 1.6 Back up the context file

\`\`\`bash
BACKUP="\${CONTEXT_FILE}.\$(date +%Y%m%d_%H%M%S).bak"
cp \$CONTEXT_FILE "\${BACKUP}"
echo "Backup: \${BACKUP}"
ls -lh "\${BACKUP}"
\`\`\`

---

## Phase 2: Database Tier Preparation

Prepare the target service on the database before changing the app tier configuration. If the service already exists and resolves, skip to Phase 3.

### 2.1 Check whether the new service exists in the database

\`\`\`sql
SELECT name,
       network_name,
       enabled
FROM   v\$active_services
WHERE  name = UPPER('&new_cp_service')
ORDER BY name;
\`\`\`

A row with \`ENABLED = YES\` means the service is ready. No row means the service must be created.

### 2.2a Create the service — single instance

\`\`\`sql
BEGIN
  DBMS_SERVICE.CREATE_SERVICE(
    service_name => '&new_cp_service',
    network_name => '&new_cp_service'
  );
  DBMS_SERVICE.START_SERVICE('&new_cp_service');
END;
/
\`\`\`

Make the service persistent across database restarts by adding it to your DBSTART trigger or using a \`dbms_service\` call in a startup trigger. An unregistered service vanishes after a database restart.

\`\`\`sql
-- Startup trigger to auto-start the CP service
CREATE OR REPLACE TRIGGER start_cp_service
  AFTER STARTUP ON DATABASE
BEGIN
  DBMS_SERVICE.START_SERVICE('&new_cp_service');
END;
/
\`\`\`

### 2.2b Create the service — RAC with node preference

\`\`\`bash
# Preferred on rac2 (dedicated batch node), available on rac1
srvctl add service \\
  -db EBSPRD \\
  -service EBSPRD_CP \\
  -preferred EBSPRD2 \\
  -available EBSPRD1 \\
  -role PRIMARY \\
  -policy automatic

srvctl start service -db EBSPRD -service EBSPRD_CP

# Confirm
srvctl status service -db EBSPRD -service EBSPRD_CP
\`\`\`

### 2.3 Add a tnsnames.ora entry on the application tier

Add the new service entry on each application node under \`\$TNS_ADMIN\`:

\`\`\`
EBSPRD_CP =
  (DESCRIPTION =
    (LOAD_BALANCE = OFF)
    (ADDRESS = (PROTOCOL = TCP)(HOST = dbhost.example.com)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = EBSPRD_CP)
    )
  )
\`\`\`

\`SERVER = DEDICATED\` is strongly recommended for CP connections to avoid shared server holdover issues with long-running batch jobs.

### 2.4 Verify tnsping from each application node

\`\`\`bash
tnsping EBSPRD_CP
\`\`\`

Expected: \`OK (\`N\` msec)\`. Do not proceed until \`tnsping\` succeeds from every application node.

---

## Phase 3: Edit the Context File

### 3.1 Edit s_cp_twotask

\`\`\`bash
# Find the current line
grep -n "cp_twotask" \$CONTEXT_FILE

# Edit (replace OLD_SERVICE with the new service name)
# Example line to change:
#   <s_cp_twotask oa_var="s_cp_twotask">EBSPRD</s_cp_twotask>
# After edit:
#   <s_cp_twotask oa_var="s_cp_twotask">EBSPRD_CP</s_cp_twotask>

vi \$CONTEXT_FILE
\`\`\`

After editing, confirm the change:

\`\`\`bash
grep "cp_twotask" \$CONTEXT_FILE
\`\`\`

### 3.2 R12.2 — verify you are editing the run edition context file

\`\`\`bash
echo "Editing: \$CONTEXT_FILE"
# Should show fs1 or fs2 path, not fs_ne
echo "\$CONTEXT_FILE" | grep -E "fs1|fs2"
\`\`\`

If the path contains \`fs_ne\`, you sourced the wrong edition. Re-source with \`EBSapps.env run\` and repeat.

---

## Phase 4: Run AutoConfig on the Application Tier

AutoConfig must run on every application tier node. In multi-node environments, run it on all nodes before restarting the Concurrent Manager.

### 4.1 Run AutoConfig

\`\`\`bash
cd \$AD_TOP/bin

./adautocfg.sh
# Enter apps password when prompted
\`\`\`

Monitor progress:

\`\`\`bash
tail -f \$APPL_TOP/admin/\$CONTEXT_NAME/log/adautocfg*.log 2>/dev/null || \\
tail -f \$INST_TOP/admin/log/adautocfg*.log 2>/dev/null
\`\`\`

### 4.2 Verify AutoConfig completed cleanly

\`\`\`bash
# Check exit status and last lines of the log
ACLOG=\$(ls -t \$APPL_TOP/admin/log/adautocfg*.log 2>/dev/null | head -1)
[ -z "\$ACLOG" ] && ACLOG=\$(ls -t \$INST_TOP/admin/log/adautocfg*.log 2>/dev/null | head -1)
echo "AutoConfig log: \$ACLOG"
tail -20 "\$ACLOG"
grep -c "AutoConfig completed successfully" "\$ACLOG"
\`\`\`

Any \`AutoConfig completed successfully\` count of 1 means clean. Failures appear as \`ERRORCODE\` entries in the log — resolve them before restarting CP.

### 4.3 Confirm CP_TWO_TASK is updated in the generated environment

\`\`\`bash
# Re-source the environment to pick up AutoConfig changes
source \$CONTEXT_FILE   # or re-source the edition env file
echo "CP_TWO_TASK after AutoConfig: \$CP_TWO_TASK"
\`\`\`

The value should now reflect the new service name.

### 4.4 Run AutoConfig on the database tier (if applicable)

In environments where the database tier has its own context file (common in R12.1 and R12.2):

\`\`\`bash
# On the database server
source /u01/oracle/EBSPRD/appsutil/env/EBSPRD_\$(hostname -s).env
cd \$AD_TOP/bin
./adautocfg.sh
\`\`\`

The DB tier AutoConfig does not write \`CP_TWO_TASK\` — it regenerates \`tnsnames.ora\`, \`listener.ora\`, and database-side configuration files. Run it if the context file on the DB tier was also changed (e.g., to add the new service to the DB-side tnsnames).

---

## Phase 5: Restart the Concurrent Manager

The new \`CP_TWO_TASK\` value does not take effect until the ICM process is restarted. It reads the environment variables at startup — a running ICM ignores context file or AutoConfig changes until it is cycled.

### 5.1 Verify no critical jobs are running

\`\`\`sql
SELECT request_id,
       concurrent_program_name,
       requested_start_date,
       phase_code,
       status_code
FROM   fnd_concurrent_requests
WHERE  phase_code = 'R'   -- Running
ORDER BY requested_start_date;
\`\`\`

Wait for running requests to complete, or coordinate with business users before proceeding.

### 5.2 Stop the Concurrent Manager

\`\`\`bash
\$FND_TOP/bin/adcmctl.sh stop apps/<apps_password>
\`\`\`

Wait for all managers to shut down:

\`\`\`bash
\$FND_TOP/bin/adcmctl.sh status apps/<apps_password>
\`\`\`

Repeat the status check until output shows all managers inactive.

### 5.3 Start the Concurrent Manager

\`\`\`bash
\$FND_TOP/bin/adcmctl.sh start apps/<apps_password>
\`\`\`

### 5.4 Confirm ICM and managers are running

\`\`\`bash
\$FND_TOP/bin/adcmctl.sh status apps/<apps_password>
\`\`\`

The number of active managers should match the baseline captured in Phase 1.4.

---

## Phase 6: Post-Change Verification

### 6.1 Confirm CP sessions are on the new service

\`\`\`sql
SELECT s.service_name,
       s.program,
       COUNT(*) AS session_count,
       SUM(CASE WHEN s.status = 'ACTIVE' THEN 1 ELSE 0 END) AS active_count
FROM   v\$session s
WHERE  s.username = 'APPS'
  AND  (s.program LIKE '%FNDLIBR%'
     OR s.program LIKE '%FNDSM%'
     OR s.program LIKE '%ICM%')
GROUP BY s.service_name, s.program
ORDER BY s.service_name;
\`\`\`

All CP sessions should now show the new service name in \`SERVICE_NAME\`. If any sessions still show the old service name, the ICM restart did not complete cleanly — check \`\$APPLCSF/\$APPLLOG\` for ICM startup errors.

### 6.2 Submit a test concurrent request

Submit a lightweight concurrent program (e.g., **Active Users** under System Administrator) and confirm it completes with status \`Completed Normal\`.

\`\`\`sql
-- Check the result
SELECT request_id,
       concurrent_program_name,
       phase_code,
       status_code,
       completion_text
FROM   fnd_concurrent_requests
WHERE  requested_by = (SELECT user_id FROM fnd_user WHERE user_name = 'SYSADMIN')
ORDER BY request_id DESC
FETCH FIRST 5 ROWS ONLY;
\`\`\`

### 6.3 Confirm the CP log references the new service

The ICM log file will show the connection service used at startup:

\`\`\`bash
# Find the ICM log
ls -lt \$APPLCSF/\$APPLLOG/FNDLIBR*.log 2>/dev/null | head -5
ls -lt \$INST_TOP/logs/appl/conc/log/FNDLIBR*.log 2>/dev/null | head -5

# Search for the connection service in the latest log
grep -i "service\|twotask\|cp_two" \$(ls -t \$INST_TOP/logs/appl/conc/log/FNDLIBR*.log 2>/dev/null | head -1) | head -10
\`\`\`

---

## Automation Script

Save as \`check_cp_twotask.sh\`. Performs a read-only audit of the current \`s_cp_twotask\` configuration — context file value, environment variable, TNS resolution, and active CP sessions. Does not modify anything. Exits 1 if any discrepancy is found.

\`\`\`bash
#!/bin/bash
# s_cp_twotask Configuration Audit
# Usage: ./check_cp_twotask.sh <APPS_PWD>
# Requires: EBS environment already sourced

APPS_PWD=\${1:?"Usage: \$0 <APPS_PWD>"}
REPORT=/tmp/cp_twotask_audit_\$(date +%Y%m%d_%H%M%S).txt
FINDING=0

echo "============================================================" | tee "\${REPORT}"
echo "s_cp_twotask Configuration Audit"                             | tee -a "\${REPORT}"
echo "Host      : \$(hostname -s)"                                  | tee -a "\${REPORT}"
echo "Date      : \$(date)"                                         | tee -a "\${REPORT}"
echo "============================================================" | tee -a "\${REPORT}"

# --- Environment check ---
echo "" | tee -a "\${REPORT}"
echo "[1] Environment" | tee -a "\${REPORT}"
echo "--------------------------------------------------------------" | tee -a "\${REPORT}"

for VAR in CONTEXT_FILE ORACLE_HOME TWO_TASK; do
  VAL=\$(eval echo \$\${VAR})
  if [ -z "\${VAL}" ]; then
    echo "FAIL: \${VAR} is not set — source EBS environment first" | tee -a "\${REPORT}"
    exit 1
  fi
  echo "OK: \${VAR}=\${VAL}" | tee -a "\${REPORT}"
done

# --- Context file values ---
echo "" | tee -a "\${REPORT}"
echo "[2] Context File Parameters" | tee -a "\${REPORT}"
echo "--------------------------------------------------------------" | tee -a "\${REPORT}"

CTX_TWOTASK=\$(grep -i '<s_twotask ' "\${CONTEXT_FILE}" | sed 's/.*>\\(.*\\)<.*/\\1/' | tr -d '[:space:]')
CTX_CP=\$(grep -i 's_cp_twotask' "\${CONTEXT_FILE}" | sed 's/.*>\\(.*\\)<.*/\\1/' | tr -d '[:space:]')

echo "s_twotask    in context file : \${CTX_TWOTASK}"  | tee -a "\${REPORT}"
echo "s_cp_twotask in context file : \${CTX_CP}"       | tee -a "\${REPORT}"
echo "TWO_TASK    env var          : \${TWO_TASK}"      | tee -a "\${REPORT}"
echo "CP_TWO_TASK env var          : \${CP_TWO_TASK}"   | tee -a "\${REPORT}"

# Check env var matches context file
if [ "\${CP_TWO_TASK}" != "\${CTX_CP}" ]; then
  echo "FINDING: CP_TWO_TASK env var (\${CP_TWO_TASK}) does not match context file (\${CTX_CP})" | tee -a "\${REPORT}"
  echo "         AutoConfig may not have been run since last context file change" | tee -a "\${REPORT}"
  FINDING=1
else
  echo "OK: CP_TWO_TASK env matches context file" | tee -a "\${REPORT}"
fi

# --- TNS resolution ---
echo "" | tee -a "\${REPORT}"
echo "[3] TNS Resolution" | tee -a "\${REPORT}"
echo "--------------------------------------------------------------" | tee -a "\${REPORT}"

for SVC in "\${CTX_TWOTASK}" "\${CTX_CP}"; do
  if [ -z "\${SVC}" ]; then continue; fi
  TNSOUT=\$(tnsping "\${SVC}" 2>&1 | tail -3)
  if echo "\${TNSOUT}" | grep -qi "OK"; then
    echo "OK: tnsping \${SVC} resolved" | tee -a "\${REPORT}"
  else
    echo "FINDING: tnsping \${SVC} failed" | tee -a "\${REPORT}"
    echo "\${TNSOUT}" | tee -a "\${REPORT}"
    FINDING=1
  fi
done

# --- Active CP sessions on DB ---
echo "" | tee -a "\${REPORT}"
echo "[4] Active CP Sessions (from v\$session)" | tee -a "\${REPORT}"
echo "--------------------------------------------------------------" | tee -a "\${REPORT}"

SESSION_OUT=\$("\${ORACLE_HOME}/bin/sqlplus" -s apps/\${APPS_PWD} <<ENDSQL
SET PAGESIZE 100
SET LINESIZE 160
SET FEEDBACK OFF
COLUMN service_name FORMAT A30
COLUMN program FORMAT A25
COLUMN session_count FORMAT 999

SELECT s.service_name,
       SUBSTR(s.program, 1, 25) AS program,
       COUNT(*) AS session_count
FROM   v\$session s
WHERE  s.username = 'APPS'
  AND  (s.program LIKE '%FNDLIBR%'
     OR s.program LIKE '%FNDSM%'
     OR s.program LIKE '%ICM%')
GROUP BY s.service_name, s.program
ORDER BY s.service_name, s.program;
EXIT;
ENDSQL
)

echo "\${SESSION_OUT}" | tee -a "\${REPORT}"

# Check if any CP sessions are on wrong service
WRONG_SVC=\$(echo "\${SESSION_OUT}" | grep -v "\${CTX_CP}" | grep -E "FNDLIBR|FNDSM|ICM" | wc -l)
if [ "\${WRONG_SVC}" -gt 0 ]; then
  echo "FINDING: \${WRONG_SVC} CP session(s) are NOT on service '\${CTX_CP}'" | tee -a "\${REPORT}"
  echo "         ICM may need to be restarted to pick up the new CP_TWO_TASK" | tee -a "\${REPORT}"
  FINDING=1
fi

# --- DB service existence check ---
echo "" | tee -a "\${REPORT}"
echo "[5] Database Service Registration" | tee -a "\${REPORT}"
echo "--------------------------------------------------------------" | tee -a "\${REPORT}"

SVC_OUT=\$("\${ORACLE_HOME}/bin/sqlplus" -s apps/\${APPS_PWD} <<ENDSQL
SET PAGESIZE 50
SET LINESIZE 120
SET FEEDBACK OFF
COLUMN name FORMAT A30
COLUMN network_name FORMAT A30
COLUMN enabled FORMAT A8

SELECT name, network_name, enabled
FROM   v\$active_services
WHERE  UPPER(name) IN (UPPER('\${CTX_TWOTASK}'), UPPER('\${CTX_CP}'))
ORDER BY name;
EXIT;
ENDSQL
)

echo "\${SVC_OUT}" | tee -a "\${REPORT}"

for SVC in "\${CTX_TWOTASK}" "\${CTX_CP}"; do
  if [ -z "\${SVC}" ]; then continue; fi
  if echo "\${SVC_OUT}" | grep -qi "\${SVC}"; then
    echo "OK: Service '\${SVC}' found in v\\\$active_services" | tee -a "\${REPORT}"
  else
    echo "FINDING: Service '\${SVC}' NOT found in v\\\$active_services" | tee -a "\${REPORT}"
    FINDING=1
  fi
done

# --- Final result ---
echo "" | tee -a "\${REPORT}"
echo "============================================================" | tee -a "\${REPORT}"
if [ \${FINDING} -eq 1 ]; then
  echo "RESULT: One or more findings require attention (see above)" | tee -a "\${REPORT}"
else
  echo "RESULT: Clean — s_cp_twotask configuration is consistent" | tee -a "\${REPORT}"
fi
echo "Report saved to: \${REPORT}" | tee -a "\${REPORT}"
echo "============================================================" | tee -a "\${REPORT}"

exit \${FINDING}
\`\`\`

### Usage

\`\`\`bash
chmod +x check_cp_twotask.sh

# Source the EBS environment first
source /u01/applmgr/EBSPRD/EBSapps.env run    # R12.2
# or
source /u01/applmgr/EBSPRD/EBSprd/EBSprd_\$(hostname -s).env  # R12.1

# Run the audit
./check_cp_twotask.sh <apps_password>
\`\`\`

Run this script on each application node after any \`s_cp_twotask\` change and after every AutoConfig cycle to confirm the configuration is consistent and the target service is reachable.

---

## Rollback Procedure

If the new service causes CP connection failures, restore the previous configuration:

\`\`\`bash
# 1. Stop Concurrent Manager
\$FND_TOP/bin/adcmctl.sh stop apps/<apps_password>

# 2. Restore the context file backup
cp "\${CONTEXT_FILE}.<timestamp>.bak" "\$CONTEXT_FILE"

# 3. Re-run AutoConfig
cd \$AD_TOP/bin
./adautocfg.sh

# 4. Restart Concurrent Manager
\$FND_TOP/bin/adcmctl.sh start apps/<apps_password>

# 5. Verify
./check_cp_twotask.sh <apps_password>
\`\`\`

---

## Decision Matrix

| Finding | Cause | Action |
|---------|-------|--------|
| \`CP_TWO_TASK\` env differs from context file | AutoConfig not run after context file edit | Run \`adautocfg.sh\` on all app nodes |
| \`tnsping\` fails for CP service | Missing or incorrect \`tnsnames.ora\` entry | Add the TNS entry; verify \`TNS_ADMIN\` path |
| CP sessions on wrong service in \`v\$session\` | ICM not restarted after AutoConfig | Stop/start Concurrent Manager |
| Service missing from \`v\$active_services\` | Service not created on DB or not started | Create via \`DBMS_SERVICE\` or \`srvctl\`; add startup trigger |
| AutoConfig fails with ERRORCODE | Context file syntax error or env problem | Restore backup; check AutoConfig log |
| CP jobs fail with ORA-12514 | Service registered in TNS but not active on DB | Start the service: \`DBMS_SERVICE.START_SERVICE\` or \`srvctl start service\` |

---

## Summary

\`s_cp_twotask\` controls how every Concurrent Manager process connects to the Oracle database — independently of the general application TWO_TASK. Across 11i, R12.1.3, and R12.2.x the parameter lives in the same place (the Applications Context File at \`\$CONTEXT_FILE\`) and is changed the same way (edit → backup → AutoConfig → CM restart). The key operational sequence is: prepare the database service first, confirm TNS resolution from every app node, then change the context file and run AutoConfig. Changes take effect only after the Concurrent Manager is restarted. The audit script validates the full chain — context file, environment variable, TNS resolution, active database service, and active CP sessions — and exits non-zero on any gap in the configuration.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'EBS s_cp_twotask Runbook: Auditing, Changing, and Verifying the Concurrent Processing Database Service Across 11i, R12.1.3, and R12.2.x',
    slug,
    excerpt: 'Operational runbook for inspecting and changing s_cp_twotask in the Oracle EBS Applications Context File. Covers pre-change state capture, database service creation on single-instance and RAC, TNS resolution verification, context file editing, AutoConfig execution on app and DB tiers, Concurrent Manager restart, and post-change session verification. Includes an audit shell script that validates the complete configuration chain and exits non-zero on any discrepancy.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
