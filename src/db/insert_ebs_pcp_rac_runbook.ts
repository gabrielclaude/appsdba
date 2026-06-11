import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'EBS PCP on RAC: Configuration and Monitoring Runbook',
  slug: 'oracle-ebs-pcp-rac-failover-configuration-runbook',
  excerpt:
    'Step-by-step runbook for configuring Oracle EBS Parallel Concurrent Processing on RAC: profile option and TWO_TASK alignment for both dedicated and SCAN architectures, reviver.sh repair, PID directory setup, cascade failover test procedure, and a monitoring script that detects hung managers, Pending Standby lockups, and reviver failures before they reach production.',
  category: 'appsdba' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `## Scope

This runbook applies to Oracle E-Business Suite R12.2.x environments running Parallel Concurrent Processing (PCP) against a Real Application Clusters (RAC) database. It covers both valid PCP+RAC configurations, remediation for the four common failure patterns, and a monitoring script for ongoing health checks.

**Triggering symptoms:**
- Concurrent managers stuck in "Target node/queue unavailable" after node crash
- \`reviver.sh: line 175: ]: command not found\` in ICM log
- \`No such file or directory\` for \`$INST_TOP/pids/appl/reviver.sh_*.pid\`
- Requests remaining in phase_code = R after the owning node went down
- "Pending Standby" queue buildup lasting 60+ minutes after cascade failover

---

## Phase 1: Determine Current Configuration

### 1.1 Identify TWO_TASK alias type on each app node

\`\`\`bash
# Run on EACH application tier node as applmgr
grep -i 'TWO_TASK\|cp_twotask' \
  $ADMIN_SCRIPTS_HOME/adcmctl.sh \
  $ADMIN_SCRIPTS_HOME/gsmstart.sh 2>/dev/null

# Also check the running environment
echo "TWO_TASK=\$TWO_TASK"
\`\`\`

Note the alias name. Then look it up in \`tnsnames.ora\`:

\`\`\`bash
grep -A 12 "^\$TWO_TASK" $TNS_ADMIN/tnsnames.ora
\`\`\`

**Determine alias type:**

| TNS Entry Contains | Alias Type |
|-------------------|------------|
| \`INSTANCE_NAME = <name>\` | Dedicated instance |
| \`(HOST = *-vip.*)\` only | Dedicated VIP |
| \`LOAD_BALANCE = ON\` | SCAN / load-balanced |
| \`(HOST = *-scan.*)\` | SCAN |
| \`SERVICE_NAME\` only, no INSTANCE_NAME | Could be either — check the listener |

### 1.2 Check current PCP Instance Check profile value

\`\`\`sql
-- As APPS user
SELECT pov.profile_option_value,
       DECODE(pov.profile_option_value,'Y','ON','N','OFF',
              NVL(pov.profile_option_value,'NOT SET')) AS interpreted_value,
       DECODE(pov.level_id,10001,'Site',10002,'Application',
              10003,'Responsibility',10004,'User') AS level_name
FROM   fnd_profile_option_values  pov
JOIN   fnd_profile_options         po USING (profile_option_id)
WHERE  po.profile_option_name = 'CONC_PCP_INSTANCE_CHECK'
ORDER BY pov.level_id;
\`\`\`

### 1.3 Determine required configuration

| Alias Type | Required PCP Instance Check | Action If Wrong |
|-----------|---------------------------|-----------------|
| Dedicated VIP / INSTANCE_NAME | **ON (Y)** | Set profile to Y, bounce managers |
| SCAN / LOAD_BALANCE=ON | **OFF (N)** | Set profile to N, bounce managers |

---

## Phase 2: Set Profile Option (UI Method)

### 2.1 Navigate to profile option

1. Log in as **SYSADMIN**
2. Navigate: **System Administrator → Profiles → System**
3. In the Find System Profile Values form:
   - **Profile:** \`Concurrent%PCP%Instance%\` → click Find
4. Locate: **Concurrent: PCP Instance Check**

### 2.2 Set the value

- For **Dedicated Instance** environments: Set **Site** level value to **\`Yes\`** (ON)
- For **SCAN / Load-Balanced** environments: Set **Site** level value to **\`No\`** (OFF) or clear the value

Click **Save**.

### 2.3 Verify via SQL after saving

\`\`\`sql
SELECT profile_option_value
FROM   fnd_profile_option_values pov
JOIN   fnd_profile_options        po USING (profile_option_id)
WHERE  po.profile_option_name = 'CONC_PCP_INSTANCE_CHECK'
  AND  pov.level_id            = 10001;
-- Y = ON (Dedicated), N or null = OFF (SCAN)
\`\`\`

---

## Phase 3: Verify and Fix adcmctl.sh TWO_TASK

### 3.1 Inspect TWO_TASK on each node

\`\`\`bash
# Run on each app node
grep TWO_TASK $ADMIN_SCRIPTS_HOME/adcmctl.sh
\`\`\`

### 3.2 For Dedicated Instance (Option 1) — node-specific aliases

Each node must have a different TWO_TASK pointing to its own RAC instance VIP:

\`\`\`bash
# Node 1 — edit adcmctl.sh
# Change: export TWO_TASK=<GENERIC_OR_SCAN_ALIAS>
# To:     export TWO_TASK=EBSPROD1

# Node 2 — edit adcmctl.sh
# Change: export TWO_TASK=<GENERIC_OR_SCAN_ALIAS>
# To:     export TWO_TASK=EBSPROD2
\`\`\`

### 3.3 For SCAN / Load-Balanced (Option 2) — same alias on all nodes

\`\`\`bash
# All nodes must have the same SCAN alias
grep TWO_TASK $ADMIN_SCRIPTS_HOME/adcmctl.sh
# Expected: export TWO_TASK=DB_SCAN_LINK   (or your SCAN alias name)
\`\`\`

### 3.4 Test TNS connectivity from each app node

\`\`\`bash
# As applmgr — test the TWO_TASK alias resolves and connects
tnsping $TWO_TASK

# Test actual database authentication
sqlplus apps/<APPS_PWD>@$TWO_TASK <<'EOF'
SELECT instance_name, host_name FROM v\$instance;
EXIT;
EOF
\`\`\`

For a SCAN alias, run the connection test 5–10 times and verify requests land on different instances (load balancing confirmed).

---

## Phase 4: Fix reviver.sh Errors

### 4.1 Fix the stray ] at line 175

\`\`\`bash
# View the problem area
sed -n '172,178p' $FND_TOP/bin/reviver.sh
\`\`\`

The erroneous line looks like:

\`\`\`bash
if [ "$VARIABLE" = "value" ] ]   # extra ] at end
\`\`\`

Edit the file:

\`\`\`bash
# Back up first
cp $FND_TOP/bin/reviver.sh $FND_TOP/bin/reviver.sh.bak.$(date +%Y%m%d)

# Open in vi and fix line 175 — remove the trailing ]
vi +175 $FND_TOP/bin/reviver.sh
\`\`\`

Validate the fix:

\`\`\`bash
bash -n $FND_TOP/bin/reviver.sh && echo "Syntax: OK"
\`\`\`

### 4.2 Create the missing PID directory

This must be performed on **every** application node:

\`\`\`bash
# Verify $INST_TOP is set
echo "INST_TOP=\$INST_TOP"

# Create the full directory path
mkdir -p $INST_TOP/pids/appl
chown applmgr:dba $INST_TOP/pids/appl
chmod 755 $INST_TOP/pids/appl

# Confirm
ls -la $INST_TOP/pids/
# Expected: drwxr-xr-x applmgr dba appl
\`\`\`

### 4.3 Add to post-clone checklist

Include the PID directory creation in your \`adcfgclone\` post-processing script:

\`\`\`bash
# Add to your post-clone validation script
for dir in pids/appl pids/db; do
  mkdir -p $INST_TOP/$dir
  chown applmgr:dba $INST_TOP/$dir
  chmod 755 $INST_TOP/$dir
done
echo "PID directories verified."
\`\`\`

---

## Phase 5: Verify Concurrent Program Restart on Failure Flag

For requests to be automatically restarted by the ICM after a node failure, the program definition must have "Restart on Failure" enabled.

\`\`\`sql
-- Find programs that are NOT set to restart on failure
SELECT p.concurrent_program_name,
       t.user_concurrent_program_name,
       p.restart_flag,
       p.enabled_flag
FROM   fnd_concurrent_programs     p
JOIN   fnd_concurrent_programs_tl  t
       ON  t.concurrent_program_id = p.concurrent_program_id
       AND t.application_id        = p.application_id
       AND t.language               = 'US'
WHERE  p.enabled_flag = 'Y'
  AND  (p.restart_flag IS NULL OR p.restart_flag = 'N')
ORDER BY t.user_concurrent_program_name;
\`\`\`

Enable via UI for critical programs:
- **System Administrator → Concurrent → Programs**
- Query the program name
- Check **Restart on System Failure**
- Save

---

## Phase 6: Cascade Failover Test Procedure

Run this test in a non-production environment before any production configuration change. The single-node failover test is not sufficient — only cascade testing reliably exposes the SCAN + PCP Instance Check mismatch.

### 6.1 Pre-test setup

\`\`\`sql
-- Confirm managers are running on both nodes
SELECT concurrent_queue_name,
       node_name,
       running_processes,
       max_processes
FROM   fnd_concurrent_queues
WHERE  enabled_flag = 'Y'
ORDER BY node_name, concurrent_queue_name;

-- Submit a long-running test request that will run during the failover
-- (e.g., a report with a large date range or a custom sleep concurrent program)
\`\`\`

### 6.2 Cascade test sequence

\`\`\`
Step 1: Abort Node 2 database instance
  srvctl stop instance -d <DBNAME> -i <INSTANCE2> -o abort

  Wait: 3–5 minutes
  Check: V$INSTANCE on Node 1 shows only one instance
  Check: Concurrent managers on Node 1 continue processing

Step 2: Bring Node 2 back
  srvctl start instance -d <DBNAME> -i <INSTANCE2>

  Wait: 5 minutes for PMON cleanup and reconnects
  Check: fnd_concurrent_queues shows Node 2 managers Running

Step 3: Abort Node 1 (the cascade)
  srvctl stop instance -d <DBNAME> -i <INSTANCE1> -o abort

  Watch: fnd_concurrent_requests — look for Pending Standby buildup
  Watch: fnd_concurrent_queues — check manager statuses on Node 2
  Timer: If Pending Standby persists beyond 10 minutes → FAIL (PCP Instance Check mismatch)
\`\`\`

### 6.3 Pass / Fail criteria

| Observation | Result | Action |
|-------------|--------|--------|
| Requests resume on Node 2 within 5 min | PASS | Proceed to production |
| Managers show "Target node/queue unavailable" | FAIL | Fix profile option alignment |
| Requests in Pending Standby for >10 min | FAIL | Fix profile option alignment |
| Requests resume only after manual restart | WARN | Check restart_flag on programs |

---

## Phase 7: Monitoring Script

Save as \`/usr/local/bin/pcp_rac_monitor.sh\`. Run on each application node. Schedule 5 minutes after each CM restart or on a 15-minute cron.

\`\`\`bash
#!/bin/bash
# pcp_rac_monitor.sh — EBS PCP+RAC health monitor
# Usage: ./pcp_rac_monitor.sh [ORACLE_SID] [APPS_PWD]
# Schedule: */15 * * * * /usr/local/bin/pcp_rac_monitor.sh EBSPROD apps

ORACLE_SID="\${1:-EBSPROD}"
APPS_PWD="\${2:-apps}"
export ORACLE_SID
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
ALERT_LOG="/var/log/pcp_rac_monitor_alerts.log"
FAILURES=0
THIS_NODE=$(hostname -s)

log()   { echo "[$TIMESTAMP][$THIS_NODE] $*"; }
alert() { echo "[$TIMESTAMP][$THIS_NODE] ALERT: $*" | tee -a "$ALERT_LOG"; FAILURES=$((FAILURES + 1)); }

log "=== PCP+RAC Monitor Start ==="

# Source Oracle environment
source /home/applmgr/.bash_profile 2>/dev/null || true
export ORACLE_HOME="\${ORACLE_HOME:-/u01/app/oracle/product/19.0.0/dbhome_1}"
export PATH="$ORACLE_HOME/bin:$PATH"

SQLPLUS="$ORACLE_HOME/bin/sqlplus -s apps/$APPS_PWD"

# -----------------------------------------------------------------------
# CHECK 1: Managers in "Target node/queue unavailable" status
# -----------------------------------------------------------------------
log "Checking for unavailable manager statuses..."

UNAVAILABLE=$($SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT concurrent_queue_name || ' (node: ' || NVL(node_name,'?') || ')'
FROM   fnd_concurrent_queues
WHERE  enabled_flag = 'Y'
  AND  (running_processes < 0
     OR concurrent_queue_name IN (
          SELECT queue_name FROM fnd_cm_status
          WHERE  status LIKE '%unavailable%'
        ));
EXIT;
SQLEOF
)

if [[ -n "$UNAVAILABLE" ]]; then
  alert "Managers in unavailable state:"
  echo "$UNAVAILABLE"
else
  log "All enabled managers: reachable. OK."
fi

# -----------------------------------------------------------------------
# CHECK 2: Requests stuck in Pending Standby
# -----------------------------------------------------------------------
log "Checking for Pending Standby request buildup..."

PENDING_STANDBY=$($SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT COUNT(*)
FROM   fnd_concurrent_requests
WHERE  phase_code  = 'P'
  AND  status_code = 'S'   -- Standby
  AND  requested_start_date < SYSDATE - 10/1440;  -- Pending > 10 minutes
EXIT;
SQLEOF
)

PENDING_STANDBY=$(echo "$PENDING_STANDBY" | tr -d '[:space:]')
if [[ "$PENDING_STANDBY" -gt 0 ]]; then
  alert "$PENDING_STANDBY request(s) stuck in Pending Standby for more than 10 minutes"
  $SQLPLUS <<'SQLEOF'
SET LINESIZE 200 PAGESIZE 30 HEADING ON
SELECT r.request_id,
       t.user_concurrent_program_name,
       r.requested_start_date,
       r.node_name,
       ROUND((SYSDATE - r.requested_start_date) * 1440) AS pending_minutes
FROM   fnd_concurrent_requests     r
JOIN   fnd_concurrent_programs_tl  t
       ON  t.concurrent_program_id = r.concurrent_program_id
       AND t.language               = 'US'
WHERE  r.phase_code   = 'P'
  AND  r.status_code  = 'S'
  AND  r.requested_start_date < SYSDATE - 10/1440
ORDER BY pending_minutes DESC
FETCH FIRST 10 ROWS ONLY;
EXIT;
SQLEOF
else
  log "No Pending Standby backlog. OK."
fi

# -----------------------------------------------------------------------
# CHECK 3: Requests stuck in Running phase beyond threshold
# -----------------------------------------------------------------------
log "Checking for long-running requests that may be zombie (node died)..."

ZOMBIE_RUNNING=$($SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT COUNT(*)
FROM   fnd_concurrent_requests r
WHERE  r.phase_code   = 'R'
  AND  r.status_code  = 'R'
  AND  r.actual_start_date < SYSDATE - 2/24  -- Running > 2 hours
  AND  NOT EXISTS (
         SELECT 1 FROM v\$session s
         WHERE  s.module LIKE 'FND%'
           AND  REGEXP_LIKE(s.action, '^[0-9]+$')
           AND  TO_NUMBER(s.action) = r.request_id
       );
EXIT;
SQLEOF
)

ZOMBIE_RUNNING=$(echo "$ZOMBIE_RUNNING" | tr -d '[:space:]')
if [[ "$ZOMBIE_RUNNING" -gt 0 ]]; then
  alert "$ZOMBIE_RUNNING request(s) marked Running but have NO active V\$SESSION — possible zombie after node failure"
  $SQLPLUS <<'SQLEOF'
SET LINESIZE 200 PAGESIZE 20 HEADING ON
SELECT r.request_id,
       t.user_concurrent_program_name,
       r.actual_start_date,
       r.node_name,
       ROUND((SYSDATE - r.actual_start_date) * 60) AS running_minutes
FROM   fnd_concurrent_requests     r
JOIN   fnd_concurrent_programs_tl  t
       ON  t.concurrent_program_id = r.concurrent_program_id
       AND t.language               = 'US'
WHERE  r.phase_code  = 'R'
  AND  r.status_code = 'R'
  AND  r.actual_start_date < SYSDATE - 2/24
ORDER BY running_minutes DESC
FETCH FIRST 10 ROWS ONLY;
EXIT;
SQLEOF
else
  log "No zombie Running requests detected. OK."
fi

# -----------------------------------------------------------------------
# CHECK 4: PCP Instance Check vs TWO_TASK alignment
# -----------------------------------------------------------------------
log "Checking PCP Instance Check profile alignment with TWO_TASK..."

PCP_CHECK=$($SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT NVL(profile_option_value,'N')
FROM   fnd_profile_option_values pov
JOIN   fnd_profile_options        po USING (profile_option_id)
WHERE  po.profile_option_name = 'CONC_PCP_INSTANCE_CHECK'
  AND  pov.level_id            = 10001;
EXIT;
SQLEOF
)

PCP_CHECK=$(echo "$PCP_CHECK" | tr -d '[:space:]')

# Get TWO_TASK from the running environment
TWOTASK_VALUE="\${TWO_TASK:-UNKNOWN}"

# Check if TWO_TASK alias is a SCAN (load-balanced) entry
IS_SCAN=$(grep -A 12 "^\${TWOTASK_VALUE}" "\${TNS_ADMIN:-\$ORACLE_HOME/network/admin}/tnsnames.ora" 2>/dev/null \
          | grep -ci 'LOAD_BALANCE\|SCAN' || echo "0")

if [[ "$IS_SCAN" -gt 0 && "$PCP_CHECK" == "Y" ]]; then
  alert "CONFIGURATION MISMATCH: TWO_TASK='$TWOTASK_VALUE' appears to be a SCAN/load-balanced alias, but PCP Instance Check = ON (Y). This will cause manager hangs and Pending Standby lockups on node failover."
elif [[ "$IS_SCAN" -eq 0 && "$PCP_CHECK" == "N" ]]; then
  alert "POSSIBLE MISMATCH: TWO_TASK='$TWOTASK_VALUE' appears to be a dedicated alias, but PCP Instance Check = OFF. Restart detection may be impaired."
else
  log "PCP Instance Check ($PCP_CHECK) and TWO_TASK type (SCAN=$IS_SCAN): aligned. OK."
fi

# -----------------------------------------------------------------------
# CHECK 5: reviver.sh syntax and PID directory
# -----------------------------------------------------------------------
log "Checking reviver.sh integrity..."

if [[ -f "$FND_TOP/bin/reviver.sh" ]]; then
  if ! bash -n "$FND_TOP/bin/reviver.sh" 2>/dev/null; then
    alert "reviver.sh has syntax errors — run: bash -n \$FND_TOP/bin/reviver.sh for details"
  else
    log "reviver.sh syntax: OK."
  fi
else
  alert "reviver.sh not found at \$FND_TOP/bin/reviver.sh"
fi

# Check PID directory
if [[ -d "$INST_TOP/pids/appl" ]]; then
  log "PID directory \$INST_TOP/pids/appl: exists. OK."
else
  alert "PID directory \$INST_TOP/pids/appl does NOT exist — reviver.sh will fail at startup. Run: mkdir -p \$INST_TOP/pids/appl"
fi

# -----------------------------------------------------------------------
# CHECK 6: ICM log for reviver errors in last 24 hours
# -----------------------------------------------------------------------
log "Scanning ICM log for reviver errors..."

# Find the most recent ICM log
LATEST_ICM_LOG=$(ls -t "$APPLCSF/log"/*/cm*.req 2>/dev/null | head -1)

if [[ -n "$LATEST_ICM_LOG" ]]; then
  REVIVER_ERRORS=$(grep -c 'reviver.sh.*command not found\|reviver.sh.*No such file' \
                   "$LATEST_ICM_LOG" 2>/dev/null || echo "0")
  if [[ "$REVIVER_ERRORS" -gt 0 ]]; then
    alert "$REVIVER_ERRORS reviver.sh error(s) found in ICM log: $LATEST_ICM_LOG"
    grep 'reviver.sh.*command not found\|reviver.sh.*No such file' "$LATEST_ICM_LOG" | tail -5
  else
    log "No reviver.sh errors in current ICM log. OK."
  fi
else
  log "No ICM log found at \$APPLCSF/log — skipping reviver log scan."
fi

# -----------------------------------------------------------------------
# CHECK 7: TWO_TASK database link is reachable
# -----------------------------------------------------------------------
log "Testing database connectivity via TWO_TASK=$TWOTASK_VALUE..."

CONNECT_TEST=$($SQLPLUS "@$TWOTASK_VALUE" <<'SQLEOF' 2>&1
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT 'CONNECTED:' || instance_name FROM v\$instance;
EXIT;
SQLEOF
)

if echo "$CONNECT_TEST" | grep -q "^CONNECTED:"; then
  INST=$(echo "$CONNECT_TEST" | grep "^CONNECTED:" | sed 's/CONNECTED://')
  log "Database connection via TWO_TASK: OK (instance=$INST)"
else
  alert "Cannot connect to database via TWO_TASK=$TWOTASK_VALUE"
  echo "$CONNECT_TEST" | head -5
fi

# -----------------------------------------------------------------------
# CHECK 8: Concurrent manager process count vs expected
# -----------------------------------------------------------------------
log "Checking running manager process counts..."

$SQLPLUS <<'SQLEOF'
SET LINESIZE 150 PAGESIZE 30 HEADING ON FEEDBACK OFF
SELECT q.concurrent_queue_name,
       q.node_name,
       q.running_processes,
       q.max_processes,
       CASE WHEN q.running_processes < q.min_processes THEN '*** BELOW MIN ***'
            WHEN q.running_processes = 0               THEN '*** STOPPED ***'
            ELSE 'OK'
       END AS health
FROM   fnd_concurrent_queues q
WHERE  q.enabled_flag = 'Y'
  AND  q.max_processes > 0
ORDER BY q.node_name, q.concurrent_queue_name;
EXIT;
SQLEOF

# Alert on any queue below minimum
BELOW_MIN=$($SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT COUNT(*)
FROM   fnd_concurrent_queues
WHERE  enabled_flag      = 'Y'
  AND  max_processes     > 0
  AND  running_processes < min_processes;
EXIT;
SQLEOF
)
BELOW_MIN=$(echo "$BELOW_MIN" | tr -d '[:space:]')
if [[ "$BELOW_MIN" -gt 0 ]]; then
  alert "$BELOW_MIN concurrent queue(s) running below minimum process threshold"
fi

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
log "=== Monitor Complete: $FAILURES alert(s) ==="

if [[ "$FAILURES" -gt 0 ]]; then
  echo ""
  echo "ACTION REQUIRED: $FAILURES issue(s) detected. See $ALERT_LOG"
  exit 1
else
  log "All PCP+RAC checks passed."
  exit 0
fi
\`\`\`

### Install and schedule

\`\`\`bash
chmod +x /usr/local/bin/pcp_rac_monitor.sh

# Add to applmgr crontab on each app node
crontab -e
\`\`\`

\`\`\`
# PCP+RAC health check every 15 minutes
*/15 * * * * /usr/local/bin/pcp_rac_monitor.sh EBSPROD apps >> /var/log/pcp_rac_monitor.log 2>&1
\`\`\`

---

## Emergency Recovery: Flushing Pending Standby Lockup

If the monitoring script alerts on a Pending Standby queue buildup and the cascade failure is already in progress:

\`\`\`bash
# 1. Confirm which managers are stuck
sqlplus apps/<APPS_PWD> <<'EOF'
SELECT concurrent_queue_name, node_name, running_processes
FROM   fnd_concurrent_queues
WHERE  enabled_flag = 'Y'
ORDER BY node_name;
EOF

# 2. Perform a hard stop of all concurrent managers (run on each app node)
$ADMIN_SCRIPTS_HOME/adcmctl.sh stop apps/<APPS_PWD>

# 3. Wait for all CM processes to die (30–60 seconds)
sleep 60
ps -ef | grep -i [c]mcpw | wc -l   # Should be 0

# 4. Clean up any stale PID files
rm -f $INST_TOP/pids/appl/reviver.sh_*.pid 2>/dev/null

# 5. Restart
$ADMIN_SCRIPTS_HOME/adcmctl.sh start apps/<APPS_PWD>

# 6. Verify Pending Standby queue clears within 5 minutes
sqlplus apps/<APPS_PWD> <<'EOF'
SELECT COUNT(*), status_code
FROM   fnd_concurrent_requests
WHERE  phase_code = 'P'
GROUP BY status_code;
EOF
\`\`\`

---

## Troubleshooting Table

| Symptom | Check | Fix |
|---------|-------|-----|
| "Target node/queue unavailable" after node crash | Profile + TWO_TASK alignment | If SCAN: set PCP Instance Check to OFF |
| Pending Standby > 10 min during cascade failover | PCP Instance Check = ON with SCAN alias | Set profile OFF; restart all CMs |
| \`reviver.sh: line 175: ]: command not found\` | Syntax error in reviver.sh | Remove stray \`]\` at line 175; validate with \`bash -n\` |
| \`reviver.sh...pid: No such file or directory\` | Missing PID directory | \`mkdir -p \$INST_TOP/pids/appl\` |
| Requests not restarting on surviving node | restart_flag = N on program | Enable "Restart on System Failure" in program definition |
| Managers below minimum process count | Node partly down or CM crash | Check \`adcmctl.sh\` status; restart CM; check app-tier OS |
| TWO_TASK connection test fails | Network/TNS issue | \`tnsping \$TWO_TASK\`; check listener; verify VIP/SCAN DNS |
| reviver.sh errors persist after fix | Old PID file locked | Delete \`\$INST_TOP/pids/appl/reviver.sh_*.pid\` and restart CM |`,
};

async function main() {
  console.log('Inserting EBS PCP RAC runbook...');
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
