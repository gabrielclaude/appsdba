import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-workflow-diagnostics-fnd-top-sql-performance-runbook';

const content = `
## Purpose

Use this runbook to systematically investigate Oracle EBS Workflow performance problems using the diagnostic scripts at \`\$FND_TOP/sql/\` and supplemental SQL queries. Covers all four Workflow failure modes: stuck/errored activities, deferred queue backlog, notification queue delay, and orphaned item accumulation.

Applies to EBS 11i, R12.1.3, and R12.2.x. Phase flow: environment → script inventory → aggregate health → deferred queue → errored activities → Background Engine → notification queue → per-item drill-down → remediation.

---

## Phase 1 — Source the Environment

### EBS 11i

\`\`\`bash
source /u01/applmgr/EBSPRD/EBSPRD_appnode01.env
echo "FND_TOP: \${FND_TOP}"
ls \$FND_TOP/sql/wf*.sql | wc -l
\`\`\`

### EBS R12.1.3

\`\`\`bash
source /u01/applmgr/EBSPRD/EBSPRD_appnode01.env
echo "FND_TOP: \${FND_TOP}"
ls \$FND_TOP/sql/wf*.sql | wc -l
\`\`\`

### EBS R12.2.x — Run Edition

\`\`\`bash
source /u01/applmgr/EBSPRD/EBSapps.env run
echo "FND_TOP: \${FND_TOP}"
ls \$FND_TOP/sql/wf*.sql | wc -l
\`\`\`

**Expected:** \`FND_TOP\` is set to a valid path and at least several \`wf*.sql\` files are found. If \`FND_TOP\` is unset, stop and fix the environment script.

---

## Phase 2 — Script Inventory and Version

\`\`\`bash
echo "=== Available Workflow diagnostic scripts ==="
ls -1 \$FND_TOP/sql/wf*.sql

echo ""
echo "=== Key scripts presence check ==="
for SCRIPT in wfver wfstat wfdiag wfmlrdbg wfitmcnt wfretry wfskipact wfrmitm; do
  if [ -f "\$FND_TOP/sql/\${SCRIPT}.sql" ]; then
    echo "[PRESENT] \${SCRIPT}.sql"
  else
    echo "[MISSING] \${SCRIPT}.sql -- obtain from Oracle Support if needed"
  fi
done
\`\`\`

\`\`\`bash
echo "=== Workflow version ==="
sqlplus -s apps/<apps_password> << 'EOF'
SET PAGESIZE 40 LINESIZE 120 FEEDBACK OFF
@\$FND_TOP/sql/wfver.sql
EOF
\`\`\`

Record the Workflow version (2.6 = 11i, 2.6.4 = R12.1/R12.2). Some error messages and available APIs differ between versions.

---

## Phase 3 — Aggregate Workflow Health

\`\`\`bash
echo "=== Workflow item counts by type and status ==="
sqlplus -s apps/<apps_password> << 'EOF'
SET PAGESIZE 100 LINESIZE 120 FEEDBACK OFF
@\$FND_TOP/sql/wfitmcnt.sql
EOF
\`\`\`

If \`wfitmcnt.sql\` is absent, run the equivalent query:

\`\`\`sql
SELECT item_type,
       root_activity,
       begin_date,
       end_date,
       CASE
         WHEN end_date IS NOT NULL             THEN 'COMPLETE'
         WHEN item_type IN (
                SELECT item_type FROM wf_item_activity_statuses
                WHERE activity_status = 'ERROR'
                AND   item_key = wi.item_key) THEN 'HAS_ERROR'
         ELSE 'ACTIVE'
       END                                   AS derived_status,
       COUNT(*)                              AS item_count
FROM   wf_items wi
GROUP  BY item_type, root_activity,
          CASE
            WHEN end_date IS NOT NULL THEN 'COMPLETE'
            WHEN item_type IN (
                   SELECT item_type FROM wf_item_activity_statuses
                   WHERE activity_status = 'ERROR'
                   AND   item_key = wi.item_key) THEN 'HAS_ERROR'
            ELSE 'ACTIVE'
          END
ORDER  BY item_type, derived_status;
\`\`\`

**Interpret:**
- Any ERROR count > 0 requires investigation in Phase 5
- Unusually high ACTIVE count for a workflow type relative to business volume may indicate items stalled in DEFERRED or NOTIFIED status

---

## Phase 4 — Deferred Queue Depth

\`\`\`sql
-- WF_DEFERRED queue state
SELECT msg_state,
       COUNT(*)                                          AS msg_count,
       TO_CHAR(MIN(enq_time), 'YYYY-MM-DD HH24:MI:SS') AS oldest,
       TO_CHAR(MAX(enq_time), 'YYYY-MM-DD HH24:MI:SS') AS newest
FROM   aq\$wf_deferred_in
GROUP  BY msg_state
ORDER  BY msg_state;
\`\`\`

**Expected:** READY count is small (single digits or zero between Background Engine runs). A large, static READY count means the Background Engine is not running.

\`\`\`sql
-- Activities currently in DEFERRED status for more than 30 minutes
SELECT wi.item_type,
       wi.item_key,
       wias.process_activity,
       TO_CHAR(wias.begin_date, 'YYYY-MM-DD HH24:MI:SS') AS deferred_since,
       ROUND((SYSDATE - wias.begin_date) * 60, 0)         AS minutes_deferred
FROM   wf_item_activity_statuses wias
JOIN   wf_items wi ON wi.item_type = wias.item_type
                  AND wi.item_key  = wias.item_key
WHERE  wias.activity_status = 'DEFERRED'
AND    wias.begin_date       < SYSDATE - 30/1440
ORDER  BY wias.begin_date;
\`\`\`

---

## Phase 5 — Errored Activities

\`\`\`sql
-- All activities in ERROR status with error detail
SELECT wi.item_type,
       wi.item_key,
       wias.process_activity,
       wias.error_name,
       SUBSTR(wias.error_message, 1, 250) AS error_message,
       TO_CHAR(wias.begin_date, 'YYYY-MM-DD HH24:MI:SS') AS errored_since
FROM   wf_item_activity_statuses wias
JOIN   wf_items wi ON wi.item_type = wias.item_type
                  AND wi.item_key  = wias.item_key
WHERE  wias.activity_status = 'ERROR'
ORDER  BY wi.item_type, wias.begin_date;
\`\`\`

For each errored item, run \`wfstat.sql\` to see the full process context:

\`\`\`bash
sqlplus apps/<apps_password> << EOF
SET PAGESIZE 200 LINESIZE 160
@\$FND_TOP/sql/wfstat.sql
-- Enter item_type and item_key at the prompts
EOF
\`\`\`

Or run \`wfdiag.sql\` to capture the full HTML report:

\`\`\`bash
cd /tmp
sqlplus apps/<apps_password> << EOF
@\$FND_TOP/sql/wfdiag.sql
-- Prompts: item_type, item_key, admin_email
EOF
ls -lh /tmp/wfdiag*.htm
\`\`\`

---

## Phase 6 — Background Engine Health

\`\`\`sql
-- Recent Background Engine (WFBGP) concurrent program runs
SELECT fcr.request_id,
       TO_CHAR(fcr.actual_start_date,       'YYYY-MM-DD HH24:MI:SS') AS start_time,
       TO_CHAR(fcr.actual_completion_date,  'YYYY-MM-DD HH24:MI:SS') AS end_time,
       fcr.status_code,
       SUBSTR(fcr.completion_text, 1, 100)                            AS completion_text
FROM   fnd_concurrent_requests fcr
JOIN   fnd_concurrent_programs fcp
       ON fcr.concurrent_program_id = fcp.concurrent_program_id
WHERE  fcp.concurrent_program_name = 'WFBGP'
ORDER  BY fcr.actual_start_date DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

**Expected:** Recent WFBGP runs with status_code = C (Completed Normal), running every few minutes. If the last run was more than 15 minutes ago or shows status E (Error), the deferred queue will not drain.

\`\`\`sql
-- Scheduled WFBGP requests (pending/waiting)
SELECT fcr.request_id,
       TO_CHAR(fcr.requested_start_date, 'YYYY-MM-DD HH24:MI:SS') AS scheduled_start,
       fcr.phase_code,
       fcr.status_code
FROM   fnd_concurrent_requests fcr
JOIN   fnd_concurrent_programs fcp
       ON fcr.concurrent_program_id = fcp.concurrent_program_id
WHERE  fcp.concurrent_program_name = 'WFBGP'
AND    fcr.phase_code IN ('P', 'I')
ORDER  BY fcr.requested_start_date;
\`\`\`

If no pending WFBGP request exists, the Background Engine is not scheduled — submit it via: System Administrator → Concurrent → Programs → Workflow Background Process with a repeat interval of 1–5 minutes.

---

## Phase 7 — Notification Queue and Mailer Health

\`\`\`sql
-- WF_NOTIFICATION_IN queue depth
SELECT msg_state,
       COUNT(*)                                          AS msg_count,
       TO_CHAR(MIN(enq_time), 'YYYY-MM-DD HH24:MI:SS') AS oldest
FROM   aq\$wf_notification_in
GROUP  BY msg_state
ORDER  BY msg_state;

-- Open notifications awaiting email reply
SELECT COUNT(*)                                   AS awaiting_response,
       ROUND((SYSDATE - MIN(sent_date)) * 24, 1) AS oldest_hours
FROM   wf_notifications
WHERE  status      = 'OPEN'
AND    mail_status = 'SENT';

-- Mailer service component status (R12.1 / R12.2)
SELECT component_name, component_status, last_update_date
FROM   fnd_svc_components
WHERE  component_type = 'WF_MAILER';
\`\`\`

For a specific delayed notification, run the mailer debug report:

\`\`\`bash
cd /tmp
sqlplus apps/<apps_password> << EOF
@\$FND_TOP/sql/wfmlrdbg.sql
-- Enter notification_id at the prompt
EOF
ls -lh /tmp/wfmlrdbg*.htm
\`\`\`

---

## Phase 8 — Per-Item Drill-Down

When a specific business object (PO, requisition, expense report) is reported as stuck, follow this sequence:

### Step 1 — Map item type and item key

\`\`\`sql
-- PO Approval
SELECT item_type, item_key, begin_date, end_date, user_key
FROM   wf_items
WHERE  item_type = 'POAPPRV'
AND    user_key  LIKE '%<DOCUMENT_NUMBER>%'
ORDER  BY begin_date DESC
FETCH FIRST 5 ROWS ONLY;

-- Requisition Approval
SELECT item_type, item_key, begin_date, end_date, user_key
FROM   wf_items
WHERE  item_type = 'REQAPPRV'
AND    user_key  LIKE '%<REQ_NUMBER>%'
ORDER  BY begin_date DESC
FETCH FIRST 5 ROWS ONLY;
\`\`\`

### Step 2 — Run wfstat.sql

\`\`\`bash
sqlplus apps/<apps_password> << EOF
SET PAGESIZE 500 LINESIZE 180
@\$FND_TOP/sql/wfstat.sql
EOF
\`\`\`

Enter the item_type and item_key at the prompts. Look for:
- Activities in ERROR status → root cause in the right-hand error column
- Activities in DEFERRED status for longer than expected → Background Engine issue
- Activities in NOTIFIED status → check notification ID and run wfmlrdbg.sql

### Step 3 — Run wfdiag.sql for escalation-ready output

\`\`\`bash
cd /tmp
sqlplus apps/<apps_password> << EOF
@\$FND_TOP/sql/wfdiag.sql
EOF
# Attach /tmp/wfdiag_<type>_<key>.htm to Oracle Support SR
\`\`\`

---

## Phase 9 — Remediation

### Option A — Retry an errored activity

Root cause must be resolved before retrying (e.g., missing profile option corrected, invalid object recompiled, locked record released).

\`\`\`bash
sqlplus apps/<apps_password> << EOF
@\$FND_TOP/sql/wfretry.sql
-- Enter item_type, item_key, activity label at prompts
EOF
\`\`\`

Confirm via wfstat.sql that the activity is no longer in ERROR.

### Option B — Skip an errored activity

Use when the activity cannot succeed and the business decision is to bypass it.

\`\`\`bash
sqlplus apps/<apps_password> << EOF
@\$FND_TOP/sql/wfskipact.sql
-- Enter item_type, item_key, activity label, result (#NULL if none)
EOF
\`\`\`

### Option C — Restart the Background Engine

Submit from: System Administrator → Concurrent → Programs → Workflow Background Process

Recommended parameters:
- Item Type: leave blank (all types)
- Process Deferred: Y
- Process Timeout: Y
- Process Stuck: N (set to Y only if you want stuck processes aborted automatically)
- Repeat interval: 1–5 minutes

\`\`\`sql
-- Confirm WFBGP is now running
SELECT TO_CHAR(actual_start_date, 'HH24:MI:SS') AS started,
       status_code
FROM   fnd_concurrent_requests fcr
JOIN   fnd_concurrent_programs fcp ON fcr.concurrent_program_id = fcp.concurrent_program_id
WHERE  fcp.concurrent_program_name = 'WFBGP'
ORDER  BY actual_start_date DESC
FETCH FIRST 5 ROWS ONLY;
\`\`\`

### Option D — Run Workflow purge

For chronic slow performance with large WF tables:

- System Administrator → Concurrent → Programs → Purge Obsolete Workflow Runtime Data
- Age: 30 (days)
- Core Workflow Only: **N**

Monitor the request until it completes, then recheck WF table sizes.

### Option E — Bulk retry for a specific item type

When many items of the same type have the same errored activity, retry in bulk via PL/SQL:

\`\`\`sql
-- Preview before retry
SELECT item_type, item_key, process_activity, error_name
FROM   wf_item_activity_statuses wias
WHERE  wias.activity_status  = 'ERROR'
AND    wias.item_type         = 'POAPPRV'
AND    wias.process_activity  = '<ACTIVITY_LABEL>';

-- Bulk retry (run after resolving root cause)
BEGIN
  FOR r IN (
    SELECT item_type, item_key, process_activity
    FROM   wf_item_activity_statuses
    WHERE  activity_status = 'ERROR'
    AND    item_type       = 'POAPPRV'
    AND    process_activity = '<ACTIVITY_LABEL>'
  ) LOOP
    wf_engine.handleerror(
      itemtype  => r.item_type,
      itemkey   => r.item_key,
      activity  => r.process_activity,
      command   => 'RETRY',
      result    => NULL
    );
  END LOOP;
  COMMIT;
END;
/
\`\`\`

Verify with wfitmcnt.sql that the ERROR count for that item type has dropped.

---

## Automation Script

The \`wf_diagnostics.sh\` script runs Phases 2–7 automatically and outputs a summary report. Pass an item type and item key as optional arguments to include per-item wfstat.sql output.

\`\`\`bash
#!/bin/bash
# wf_diagnostics.sh
# Usage: source <EBS env> && APPS_PWD=<password> ./wf_diagnostics.sh [item_type item_key]
# Exits 0 if no issues found, 1 if errors or stale deferred queue detected.

ITEM_TYPE="\${1:-}"
ITEM_KEY="\${2:-}"
PASS=0
FAIL=0
WARN=0

[ -n "\${FND_TOP}" ] || { echo "[FAIL] FND_TOP not set — source EBS environment first"; exit 1; }
[ -n "\${APPS_PWD}" ] || { echo "[FAIL] APPS_PWD not set — export APPS_PWD=<password>"; exit 1; }

echo "========================================"
echo " EBS Workflow Diagnostic Report"
echo " \$(date)"
echo " FND_TOP: \${FND_TOP}"
echo "========================================"
echo ""

# --- Script inventory ---
echo "=== Script Inventory ==="
for S in wfver wfstat wfdiag wfmlrdbg wfitmcnt wfretry wfskipact wfrmitm; do
  if [ -f "\$FND_TOP/sql/\${S}.sql" ]; then
    echo "[OK] \${S}.sql"
    PASS=\$((PASS+1))
  else
    echo "[MISSING] \${S}.sql"
    WARN=\$((WARN+1))
  fi
done
echo ""

# --- Database checks ---
sqlplus -s apps/"\${APPS_PWD}" << SQLEOF

SET PAGESIZE 100 LINESIZE 140 FEEDBACK OFF HEADING ON VERIFY OFF

PROMPT ========================================
PROMPT  Workflow Version
PROMPT ========================================
@\$FND_TOP/sql/wfver.sql

PROMPT ========================================
PROMPT  Item Counts by Type and Status
PROMPT ========================================
@\$FND_TOP/sql/wfitmcnt.sql

PROMPT ========================================
PROMPT  WF_DEFERRED Queue Depth
PROMPT ========================================
SELECT msg_state,
       COUNT(*)                                          AS msg_count,
       TO_CHAR(MIN(enq_time),'YYYY-MM-DD HH24:MI:SS')  AS oldest,
       TO_CHAR(MAX(enq_time),'YYYY-MM-DD HH24:MI:SS')  AS newest
FROM   aq\$wf_deferred_in
GROUP  BY msg_state
ORDER  BY msg_state;

PROMPT ========================================
PROMPT  Activities Deferred > 30 Minutes
PROMPT ========================================
SELECT wi.item_type,
       wi.item_key,
       wias.process_activity,
       ROUND((SYSDATE - wias.begin_date)*60, 0) AS minutes_deferred
FROM   wf_item_activity_statuses wias
JOIN   wf_items wi ON wi.item_type = wias.item_type
                  AND wi.item_key  = wias.item_key
WHERE  wias.activity_status = 'DEFERRED'
AND    wias.begin_date       < SYSDATE - 30/1440
ORDER  BY wias.begin_date
FETCH FIRST 20 ROWS ONLY;

PROMPT ========================================
PROMPT  Errored Activities
PROMPT ========================================
SELECT wi.item_type,
       wi.item_key,
       wias.process_activity,
       wias.error_name,
       SUBSTR(wias.error_message,1,120) AS error_message,
       TO_CHAR(wias.begin_date,'YYYY-MM-DD HH24:MI') AS errored_since
FROM   wf_item_activity_statuses wias
JOIN   wf_items wi ON wi.item_type = wias.item_type
                  AND wi.item_key  = wias.item_key
WHERE  wias.activity_status = 'ERROR'
ORDER  BY wi.item_type, wias.begin_date
FETCH FIRST 30 ROWS ONLY;

PROMPT ========================================
PROMPT  Background Engine (WFBGP) Recent Runs
PROMPT ========================================
SELECT TO_CHAR(fcr.actual_start_date,'YYYY-MM-DD HH24:MI:SS') AS started,
       TO_CHAR(fcr.actual_completion_date,'YYYY-MM-DD HH24:MI:SS') AS completed,
       fcr.status_code,
       SUBSTR(fcr.completion_text,1,80) AS completion_text
FROM   fnd_concurrent_requests fcr
JOIN   fnd_concurrent_programs fcp ON fcr.concurrent_program_id = fcp.concurrent_program_id
WHERE  fcp.concurrent_program_name = 'WFBGP'
ORDER  BY fcr.actual_start_date DESC
FETCH FIRST 10 ROWS ONLY;

PROMPT ========================================
PROMPT  WF_NOTIFICATION_IN Queue Depth
PROMPT ========================================
SELECT msg_state,
       COUNT(*)                                         AS msg_count,
       TO_CHAR(MIN(enq_time),'YYYY-MM-DD HH24:MI:SS') AS oldest
FROM   aq\$wf_notification_in
GROUP  BY msg_state;

PROMPT ========================================
PROMPT  Open Notifications Awaiting Reply
PROMPT ========================================
SELECT COUNT(*)                                   AS awaiting_response,
       ROUND((SYSDATE-MIN(sent_date))*24, 1)      AS oldest_hours
FROM   wf_notifications
WHERE  status      = 'OPEN'
AND    mail_status = 'SENT';

PROMPT ========================================
PROMPT  Workflow Table Sizes
PROMPT ========================================
SELECT segment_name,
       ROUND(bytes/1024/1024, 0) AS size_mb
FROM   dba_segments
WHERE  owner        = 'APPLSYS'
AND    segment_name IN (
         'WF_NOTIFICATIONS','WF_NOTIFICATION_ATTRIBUTES',
         'WF_ITEM_ACTIVITY_STATUSES','WF_ITEMS',
         'WF_ITEM_ATTRIBUTE_VALUES'
       )
ORDER  BY bytes DESC;

PROMPT ========================================
PROMPT  Mailer Service Components (R12.1/R12.2)
PROMPT ========================================
SELECT component_name, component_status,
       TO_CHAR(last_update_date,'YYYY-MM-DD HH24:MI:SS') AS last_updated
FROM   fnd_svc_components
WHERE  component_type LIKE 'WF_%';

SQLEOF

echo ""

# --- Per-item wfstat.sql (optional) ---
if [ -n "\${ITEM_TYPE}" ] && [ -n "\${ITEM_KEY}" ]; then
  echo "========================================"
  echo " wfstat.sql for \${ITEM_TYPE} / \${ITEM_KEY}"
  echo "========================================"
  sqlplus -s apps/"\${APPS_PWD}" << SQLEOF2
SET PAGESIZE 500 LINESIZE 180 FEEDBACK OFF VERIFY OFF
DEFINE item_type=\${ITEM_TYPE}
DEFINE item_key=\${ITEM_KEY}
@\$FND_TOP/sql/wfstat.sql
SQLEOF2
  echo ""

  # wfdiag.sql to /tmp if available
  if [ -f "\$FND_TOP/sql/wfdiag.sql" ]; then
    echo "Running wfdiag.sql → /tmp/wfdiag_\${ITEM_TYPE}_\${ITEM_KEY}.htm"
    ( cd /tmp && sqlplus -s apps/"\${APPS_PWD}" << SQLEOF3
DEFINE item_type=\${ITEM_TYPE}
DEFINE item_key=\${ITEM_KEY}
DEFINE admin_email=dba@example.com
@\$FND_TOP/sql/wfdiag.sql
SQLEOF3
    )
    ls -lh /tmp/wfdiag_\${ITEM_TYPE}_\${ITEM_KEY}.htm 2>/dev/null \
      && echo "[OK] wfdiag output written" \
      || echo "[WARN] wfdiag output file not found — check /tmp"
  fi
fi

echo ""
echo "========================================"
echo " RESULT: \${PASS} checks OK, \${FAIL} failed, \${WARN} warnings"
echo "========================================"

[ "\${FAIL}" -eq 0 ]
\`\`\`

**Usage examples:**

\`\`\`bash
# Aggregate health check only
source /u01/applmgr/EBSPRD/EBSapps.env run
APPS_PWD=apps_password ./wf_diagnostics.sh

# Include per-item drill-down for a specific PO approval
APPS_PWD=apps_password ./wf_diagnostics.sh POAPPRV 123456

# Requisition approval
APPS_PWD=apps_password ./wf_diagnostics.sh REQAPPRV 78901
\`\`\`

---

## Summary

| Phase | Check | Script / Query |
|-------|-------|---------------|
| 1 | Environment sourced, FND_TOP set | Shell |
| 2 | Workflow diagnostic scripts present at \$FND_TOP/sql | \`ls wf*.sql\` |
| 2 | Workflow version confirmed | \`wfver.sql\` |
| 3 | Item counts by type and status | \`wfitmcnt.sql\` |
| 4 | WF_DEFERRED queue depth and DEFERRED activity age | \`AQ\$WF_DEFERRED_IN\` query |
| 5 | Errored activities with error detail | \`WF_ITEM_ACTIVITY_STATUSES\` query + \`wfstat.sql\` |
| 6 | Background Engine recent runs and schedule | \`FND_CONCURRENT_REQUESTS\` (WFBGP) |
| 7 | Notification queue depth and mailer component status | \`AQ\$WF_NOTIFICATION_IN\` + \`FND_SVC_COMPONENTS\` |
| 8 | Per-item process status | \`wfstat.sql\` |
| 8 | Full HTML diagnostic for escalation | \`wfdiag.sql\` |
| 8 | Notification mailer debug for email delays | \`wfmlrdbg.sql\` |
| 9A | Retry errored activity | \`wfretry.sql\` |
| 9B | Skip errored activity | \`wfskipact.sql\` |
| 9C | Restart Background Engine | \`WFBGP\` concurrent program |
| 9D | Purge Workflow runtime data | Purge Obsolete Workflow Runtime |
| 9E | Bulk retry by item type | \`WF_ENGINE.HANDLEERROR\` PL/SQL |
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'EBS Workflow Diagnostics Runbook: Using $FND_TOP/sql Scripts to Investigate Performance Across 11i, R12.1.3, and R12.2.x',
    slug,
    excerpt: 'Step-by-step runbook for using the Oracle-provided workflow diagnostic scripts at $FND_TOP/sql — wfver.sql, wfstat.sql, wfdiag.sql, wfmlrdbg.sql, wfitmcnt.sql, wfretry.sql, and wfskipact.sql — to investigate all four Workflow performance failure modes. Covers aggregate health checks, deferred queue monitoring, Background Engine status, notification queue depth, per-item drill-down, and five remediation options. Includes the wf_diagnostics.sh automation script with optional per-item wfstat and wfdiag invocation.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
