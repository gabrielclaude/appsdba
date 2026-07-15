import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-workflow-email-approval-latency-notification-mailer-runbook';

const content = `
## Purpose

Use this runbook when email-based workflow approvals (purchase orders, requisitions, expense reports, or any WF notification type) are taking significantly longer than in-portal approvals. The runbook walks through the five-timestamp diagnostic method to isolate exactly where in the approval chain the delay is occurring, then provides targeted remediation for each root cause.

Covers: mailer service status → five-timestamp gap analysis → queue depth → log file analysis → IMAP inbox contamination → tuning parameters → Workflow schema maintenance.

---

## Phase 1 — Establish the Environment and EBS Version

Source the EBS environment before running any checks.

### EBS 11i

\`\`\`bash
source /u01/applmgr/EBSPRD/EBSPRD_appnode01.env
echo "CONTEXT_FILE : \${CONTEXT_FILE}"
echo "APPLCSF      : \${APPLCSF}"
echo "APPLLOG      : \${APPLLOG}"
echo "FND_TOP      : \${FND_TOP}"
\`\`\`

### EBS R12.1.3

\`\`\`bash
source /u01/applmgr/EBSPRD/EBSPRD_appnode01.env
echo "CONTEXT_FILE : \${CONTEXT_FILE}"
echo "APPLCSF      : \${APPLCSF}"
echo "APPLLOG      : \${APPLLOG}"
echo "FND_TOP      : \${FND_TOP}"
\`\`\`

### EBS R12.2.x — Run Edition (ICM/CP node)

\`\`\`bash
source /u01/applmgr/EBSPRD/EBSapps.env run
echo "CONTEXT_FILE : \${CONTEXT_FILE}"
echo "APPLCSF      : \${APPLCSF}"
echo "APPLLOG      : \${APPLLOG}"
echo "FND_TOP      : \${FND_TOP}"
echo "INST_TOP     : \${INST_TOP}"
\`\`\`

---

## Phase 2 — Confirm Mailer Service Status

### R12.1.3 and R12.2.x — via fnd_svc_components

\`\`\`sql
SELECT component_name,
       component_status,
       startup_mode,
       last_update_date
FROM   fnd_svc_components
WHERE  component_type = 'WF_MAILER';
\`\`\`

Expected: \`component_status = RUNNING\`

If \`STOPPED\` or \`DEACTIVATED_SYSTEM\`, start via OAM or bounce the concurrent manager before continuing.

### All versions — OS process check

\`\`\`bash
ps -ef | grep -i fndcpgsc | grep -v grep
\`\`\`

At least one FNDCPGSC process should be visible. If none appear, the Workflow Mailer container is not running.

### All versions — locate the current mailer log

\`\`\`bash
# Standard log directory (11i, R12.1, R12.2)
LOG_FILE=\$(ls -t \$APPLCSF/\$APPLLOG/FNDCPGSC*.txt 2>/dev/null | head -1)

# R12.2 alternative
if [ -z "\${LOG_FILE}" ]; then
  LOG_FILE=\$(ls -t \$INST_TOP/apps/\${CONTEXT_NAME}/logs/appl/conc/log/FNDCPGSC*.txt 2>/dev/null | head -1)
fi

echo "Active mailer log: \${LOG_FILE}"
\`\`\`

---

## Phase 3 — Collect the Five Timestamps for a Delayed Notification

Gather a specific Notification ID (NID) from the delayed approval. The NID appears in the email subject line sent to the approver (typically in the format \`[NID:12345]\` or embedded in the reply-to address).

### T5 and T1 — Workflow Engine completion and notification send time

\`\`\`sql
SELECT notification_id,
       status,
       mail_status,
       sent_date                               AS t5_notification_sent,
       end_date                                AS t5_workflow_completed,
       ROUND((NVL(end_date,SYSDATE)-sent_date)*24,2) AS total_hours,
       to_user,
       subject
FROM   wf_notifications
WHERE  notification_id = &nid;
\`\`\`

### T4 — Database enqueue time (when mailer deposited reply into AQ)

\`\`\`sql
SELECT msg_id,
       corr_id,
       msg_state,
       enq_time   AS t4_enqueued,
       deq_time   AS dequeued
FROM   aq\$wf_notification_in
WHERE  corr_id LIKE '%' || &nid || '%'
ORDER  BY enq_time DESC
FETCH FIRST 5 ROWS ONLY;
\`\`\`

If no rows match, the mailer has not yet fetched the reply from IMAP (problem is T2→T3), or the reply has not yet arrived in the IMAP inbox (problem is T1→T2).

### T3 — EBS mailer fetch time (from mailer log)

\`\`\`bash
# Search for the NID in the mailer log
grep -i "\${NID_VALUE}" \${LOG_FILE}
grep -i "processing inbound message" \${LOG_FILE} | tail -30
\`\`\`

The log entry for a successfully processed inbound message looks like:

\`\`\`
[timestamp] Processing inbound message ... NID[12345] ... moved to PROCESSED
\`\`\`

The timestamp on that line is T3.

### T2 — IMAP inbox arrival time

Retrieve T2 from the corporate mail system's message trace (Exchange admin center, M365 message trace, Postfix logs). Compare the IMAP inbox arrival time with T3 from the mailer log to calculate the T2→T3 gap.

### Gap summary table — fill in during investigation

| Gap | Description | Duration | Likely cause if large |
|-----|-------------|----------|----------------------|
| T1 → T2 | Approver reply → IMAP inbox | __ min | Mail routing / geographic delay |
| T2 → T3 | IMAP inbox → EBS mailer fetch | __ min | Poll interval too long; IMAP conn failure |
| T3 → T4 | Mailer parse → AQ enqueue | __ min | Junk mail processing; slow IMAP server |
| T4 → T5 | AQ dequeue → Workflow complete | __ min | Agent listener down; bloated WF schema |

---

## Phase 4 — Check Queue Depth and Agent Listener

\`\`\`sql
-- WF_NOTIFICATION_IN queue state
SELECT msg_state,
       COUNT(*)         AS message_count,
       MIN(enq_time)    AS oldest,
       MAX(enq_time)    AS newest
FROM   aq\$wf_notification_in
GROUP  BY msg_state
ORDER  BY msg_state;

-- Workflow Inbound Agent Listener recent activity
SELECT agent_name,
       status,
       last_date,
       error_message
FROM   wf_agent_activity
WHERE  agent_name = 'WF_NOTIFICATION_IN'
ORDER  BY last_date DESC
FETCH FIRST 10 ROWS ONLY;

-- All notifications currently open and sent (pending inbound response)
SELECT COUNT(*) AS awaiting_response,
       MIN(sent_date) AS oldest_sent
FROM   wf_notifications
WHERE  status      = 'OPEN'
AND    mail_status = 'SENT';
\`\`\`

A large and static \`READY\` count in \`AQ\$WF_NOTIFICATION_IN\` indicates the Agent Listener is not running. A growing queue of OPEN/SENT notifications with no inbound completions indicates the mailer is not fetching replies.

---

## Phase 5 — Inspect the Mailer Log for IMAP Activity

\`\`\`bash
echo "=== Last 20 inbound processing entries ==="
grep -i "processing inbound message" \${LOG_FILE} | tail -20

echo ""
echo "=== IMAP connection errors ==="
grep -i "imap\|connection\|timeout\|socket\|error" \${LOG_FILE} | grep -iv "no error" | tail -30

echo ""
echo "=== DISCARD activity (unrecognized messages) ==="
grep -i "discard\|no valid nid\|could not find notification\|moved to discard" \${LOG_FILE} | tail -30

echo ""
echo "=== Last poll cycle timestamps ==="
grep -i "poll\|checking\|inbox\|scanning" \${LOG_FILE} | tail -20
\`\`\`

**Interpret results:**

- No \`processing inbound message\` entries in the last hour → mailer is not fetching or not finding replies
- Repeated IMAP connection timeouts → network or mail server issue between the CP node and the IMAP server
- High DISCARD rate → inbox contaminated with unrecognized mail; causes T3→T4 bloat
- Poll cycles with no messages found → check T2 gap first (messages may not be arriving in IMAP)

---

## Phase 6 — Check Mailer IMAP Configuration Parameters

### R12.1.3 and R12.2.x

\`\`\`sql
SELECT p.parameter_name,
       v.parameter_value
FROM   fnd_svc_comp_param_vals v
JOIN   fnd_svc_comp_params_vl  p ON v.parameter_id = p.parameter_id
JOIN   fnd_svc_components      c ON v.component_id = c.component_id
WHERE  c.component_type  = 'WF_MAILER'
AND    p.parameter_name  IN (
         'IMAP_HOST',            'IMAP_PORT',
         'INBOX_FOLDER',         'PROCESSED_FOLDER',  'DISCARD_FOLDER',
         'POLL_INTERVAL',        'INBOUND_THREAD_COUNT',
         'OUTBOUND_THREAD_COUNT','MAX_ERROR_COUNT'
       )
ORDER  BY p.parameter_name;
\`\`\`

**Expected values for a high-throughput environment:**

| Parameter | Conservative default | High-volume recommendation |
|-----------|---------------------|--------------------------|
| POLL_INTERVAL | 120 | 30–60 |
| INBOUND_THREAD_COUNT | 1 | 2–4 |
| OUTBOUND_THREAD_COUNT | 1 | 2–3 |
| MAX_ERROR_COUNT | 10 | 10–20 (increase only after fixing errors) |

### 11i — via Workflow system parameters

In 11i, mailer parameters are accessible via:
- System Administrator → Oracle Applications Manager → Workflow Manager → Notification Mailer
- Or query \`wf_resources\` for the relevant parameter names

---

## Phase 7 — Assess IMAP Inbox Contamination

\`\`\`bash
# Count discard events in the last 24 hours from the log
grep -i "discard" \${LOG_FILE} | grep "\$(date -d 'yesterday' '+%Y-%m-%d' 2>/dev/null || date -v-1d '+%Y-%m-%d' 2>/dev/null)" | wc -l

# Check for inactive user addresses still receiving notifications
sqlplus -s apps/<apps_password> << 'EOF'
SELECT wn.to_user,
       fu.email_address,
       fu.end_date,
       COUNT(*) AS open_notifications
FROM   wf_notifications wn
JOIN   fnd_user fu ON fu.user_name = wn.to_user
WHERE  wn.status      = 'OPEN'
AND    wn.mail_status = 'SENT'
AND    fu.end_date    < SYSDATE
GROUP  BY wn.to_user, fu.email_address, fu.end_date
ORDER  BY COUNT(*) DESC;
EOF
\`\`\`

If inactive users appear in the output, their notifications are generating bounce replies that re-enter the IMAP inbox as unrecognized messages. End-date the users in FND_USER and clear their contact points in HZ_CONTACT_POINTS.

---

## Phase 8 — Check Workflow Schema Size and Purge Status

\`\`\`sql
-- Workflow table sizes
SELECT segment_name,
       ROUND(bytes/1024/1024, 0) AS size_mb
FROM   dba_segments
WHERE  owner        = 'APPLSYS'
AND    segment_name IN (
         'WF_NOTIFICATIONS', 'WF_NOTIFICATION_ATTRIBUTES',
         'WF_ITEM_ACTIVITY_STATUSES', 'WF_ITEMS',
         'WF_ITEM_ATTRIBUTE_VALUES'
       )
ORDER  BY bytes DESC;

-- Check last successful purge run
SELECT argument_text,
       actual_start_date,
       actual_completion_date,
       status_code
FROM   fnd_concurrent_requests
WHERE  concurrent_program_id = (
         SELECT concurrent_program_id
         FROM   fnd_concurrent_programs
         WHERE  concurrent_program_name = 'FNDWFPR'
       )
ORDER  BY actual_start_date DESC
FETCH FIRST 5 ROWS ONLY;

-- Volume of completed items eligible for purge (older than 30 days)
SELECT COUNT(*) AS purgeable_items
FROM   wf_items
WHERE  end_date < SYSDATE - 30
AND    end_date IS NOT NULL;
\`\`\`

If WF_NOTIFICATIONS exceeds several gigabytes or no purge has run in the last 30 days, schedule an immediate purge with **Core Workflow Only = N**.

---

## Phase 9 — Remediation

### Option A — Reduce poll interval and increase inbound threads (T2→T3 large)

In OAM (R12.1/R12.2):
- System Administrator → OAM → Service Instances → Workflow Notification Mailer → Edit
- Change \`POLL_INTERVAL\` from 120 to 30
- Change \`INBOUND_THREAD_COUNT\` from 1 to 2
- Save and restart the component

Via SQL update (all versions — requires restart to take effect):

\`\`\`sql
UPDATE fnd_svc_comp_param_vals v
SET    v.parameter_value = '30'
WHERE  v.parameter_id = (
         SELECT p.parameter_id
         FROM   fnd_svc_comp_params_vl p
         WHERE  p.parameter_name = 'POLL_INTERVAL'
       )
AND    v.component_id = (
         SELECT c.component_id
         FROM   fnd_svc_components c
         WHERE  c.component_type = 'WF_MAILER'
       );
COMMIT;
\`\`\`

Restart the mailer after updating.

### Option B — Clean IMAP DISCARD folder and remove inactive user notifications (T3→T4 large)

\`\`\`sql
-- Cancel open notifications for end-dated users
BEGIN
  FOR r IN (
    SELECT wn.notification_id
    FROM   wf_notifications wn
    JOIN   fnd_user fu ON fu.user_name = wn.to_user
    WHERE  wn.status   = 'OPEN'
    AND    fu.end_date < SYSDATE
  ) LOOP
    wf_notification.cancel(r.notification_id, 'User account inactive');
  END LOOP;
  COMMIT;
END;
/
\`\`\`

After canceling, access the IMAP DISCARD folder via a mail client or server-side script and delete accumulated messages. Schedule regular monthly cleanup.

### Option C — Run Workflow purge (T4→T5 large)

Submit via: System Administrator → Concurrent → Programs → Purge Obsolete Workflow Runtime Data
- Item Type: leave blank (purge all)
- Age: 30 (purge items closed more than 30 days ago)
- Core Workflow Only: **N**
- Persistence Type: Temporary

Monitor the request to completion and re-check WF table sizes afterward.

### Option D — Restart mailer service component

\`\`\`bash
# Via adcmctl (bounces the entire concurrent processing stack)
\$FND_TOP/bin/adcmctl.sh stop apps/<apps_password>
sleep 30
\$FND_TOP/bin/adcmctl.sh start apps/<apps_password>
sleep 60
\$FND_TOP/bin/adcmctl.sh status apps/<apps_password>

# Confirm mailer component is running (R12.1/R12.2)
sqlplus -s apps/<apps_password> << 'EOF'
SELECT component_name, component_status, last_update_date
FROM   fnd_svc_components
WHERE  component_type = 'WF_MAILER';
EOF
\`\`\`

### Option E — Enable Statement log level for deep IMAP debugging

In OAM: Workflow Notification Mailer → Edit → Log Level = Statement → Save → Restart

Reproduce the delay and then collect:

\`\`\`bash
# Capture the Statement-level log for the debug window
LOG_FILE=\$(ls -t \$APPLCSF/\$APPLLOG/FNDCPGSC*.txt | head -1)
grep -A5 "processing inbound\|IMAP\|poll\|NID" \${LOG_FILE} | head -200
\`\`\`

Revert log level to Unexpected immediately after capturing the needed data.

---

## Automation Script

The \`ebs_wf_mailer_diag.sh\` script automates Phases 2–8 and outputs a summary report. Run it as the applmgr OS user after sourcing the EBS environment. Pass a Notification ID as an argument to include per-NID diagnostics.

\`\`\`bash
#!/bin/bash
# ebs_wf_mailer_diag.sh
# Usage: source <EBS env> && ./ebs_wf_mailer_diag.sh [notification_id]
# Exits 0 if all checks pass, 1 if any issue detected.

NID="\${1:-}"
PASS=0
FAIL=0
WARN=0
APPS_PWD=""  # set before running or pass via stdin

echo "============================================"
echo " EBS Workflow Mailer Diagnostic"
echo " \$(date)"
echo " NID: \${NID:-[not specified]}"
echo "============================================"
echo ""

# --- Phase 1: Environment ---
echo "=== Environment ==="
echo "FND_TOP  : \${FND_TOP:-[NOT SET]}"
echo "APPLCSF  : \${APPLCSF:-[NOT SET]}"
echo "APPLLOG  : \${APPLLOG:-[NOT SET]}"
[ -n "\${FND_TOP}" ] || { echo "[FAIL] FND_TOP not set — source EBS environment first"; exit 1; }
echo ""

# --- Phase 2: FNDCPGSC process ---
echo "=== FNDCPGSC OS Process ==="
PROCS=\$(ps -ef | grep -i fndcpgsc | grep -v grep | wc -l)
if [ "\${PROCS}" -gt 0 ]; then
  echo "[PASS] \${PROCS} FNDCPGSC process(es) running"
  ps -ef | grep -i fndcpgsc | grep -v grep
  PASS=\$((PASS+1))
else
  echo "[FAIL] No FNDCPGSC process found — mailer container not running"
  FAIL=\$((FAIL+1))
fi
echo ""

# --- Phase 3: Mailer log ---
echo "=== Mailer Log ==="
LOG_FILE=\$(ls -t \$APPLCSF/\$APPLLOG/FNDCPGSC*.txt 2>/dev/null | head -1)
if [ -z "\${LOG_FILE}" ] && [ -n "\${INST_TOP}" ]; then
  LOG_FILE=\$(ls -t \$INST_TOP/apps/\${CONTEXT_NAME}/logs/appl/conc/log/FNDCPGSC*.txt 2>/dev/null | head -1)
fi

if [ -n "\${LOG_FILE}" ]; then
  echo "[PASS] Log file: \${LOG_FILE}"
  echo "       Size: \$(ls -lh \${LOG_FILE} | awk '{print \$5}')"
  echo "       Last modified: \$(ls -l \${LOG_FILE} | awk '{print \$6, \$7, \$8}')"
  PASS=\$((PASS+1))

  # Last inbound processing
  LAST_INBOUND=\$(grep -i "processing inbound message" \${LOG_FILE} 2>/dev/null | tail -1)
  if [ -n "\${LAST_INBOUND}" ]; then
    echo "[PASS] Last inbound message: \${LAST_INBOUND}"
    PASS=\$((PASS+1))
  else
    echo "[WARN] No 'processing inbound message' found in log"
    WARN=\$((WARN+1))
  fi

  # Discard count (last 500 lines)
  DISCARD_CNT=\$(tail -500 \${LOG_FILE} | grep -ic "discard" 2>/dev/null)
  echo "       DISCARD occurrences (last 500 lines): \${DISCARD_CNT}"
  [ "\${DISCARD_CNT}" -gt 20 ] && { echo "[WARN] High DISCARD rate — IMAP inbox may be contaminated"; WARN=\$((WARN+1)); }

  # IMAP errors
  ERR_CNT=\$(tail -500 \${LOG_FILE} | grep -ic "error\|timeout\|exception" 2>/dev/null)
  echo "       Error/timeout occurrences (last 500 lines): \${ERR_CNT}"
  [ "\${ERR_CNT}" -gt 10 ] && { echo "[WARN] Elevated error count in mailer log"; WARN=\$((WARN+1)); }
else
  echo "[FAIL] No FNDCPGSC log file found"
  FAIL=\$((FAIL+1))
fi
echo ""

# --- Phase 4: Database checks ---
if [ -n "\${APPS_PWD}" ]; then
  echo "=== Database Checks ==="
  sqlplus -s apps/"\${APPS_PWD}" << SQLEOF

SET PAGESIZE 60 LINESIZE 120 FEEDBACK OFF HEADING ON

PROMPT --- Mailer service component status ---
SELECT component_name, component_status, startup_mode,
       TO_CHAR(last_update_date,'YYYY-MM-DD HH24:MI:SS') AS last_updated
FROM   fnd_svc_components
WHERE  component_type = 'WF_MAILER';

PROMPT
PROMPT --- WF_NOTIFICATION_IN queue depth ---
SELECT msg_state,
       COUNT(*)                                         AS msg_count,
       TO_CHAR(MIN(enq_time),'YYYY-MM-DD HH24:MI:SS')  AS oldest
FROM   aq\$wf_notification_in
GROUP  BY msg_state;

PROMPT
PROMPT --- Open notifications awaiting inbound reply ---
SELECT COUNT(*)                                          AS awaiting_response,
       ROUND((SYSDATE - MIN(sent_date)) * 24, 1)        AS oldest_hours
FROM   wf_notifications
WHERE  status      = 'OPEN'
AND    mail_status = 'SENT';

PROMPT
PROMPT --- Inactive users with open notifications ---
SELECT fu.user_name, fu.email_address,
       TO_CHAR(fu.end_date,'YYYY-MM-DD') AS end_date,
       COUNT(*) AS open_count
FROM   wf_notifications wn
JOIN   fnd_user fu ON fu.user_name = wn.to_user
WHERE  wn.status   = 'OPEN'
AND    fu.end_date < SYSDATE
GROUP  BY fu.user_name, fu.email_address, fu.end_date
ORDER  BY COUNT(*) DESC
FETCH FIRST 10 ROWS ONLY;

PROMPT
PROMPT --- Workflow table sizes ---
SELECT segment_name,
       ROUND(bytes/1024/1024, 0) AS size_mb
FROM   dba_segments
WHERE  owner        = 'APPLSYS'
AND    segment_name IN (
         'WF_NOTIFICATIONS','WF_NOTIFICATION_ATTRIBUTES',
         'WF_ITEM_ACTIVITY_STATUSES','WF_ITEMS'
       )
ORDER  BY bytes DESC;

SQLEOF

  # NID-specific queries run in a separate sqlplus block
  if [ -n "\${NID}" ]; then
    sqlplus -s apps/"\${APPS_PWD}" << SQLEOF2
SET PAGESIZE 60 LINESIZE 120 FEEDBACK OFF HEADING ON
PROMPT --- Notification \${NID} lifecycle ---
SELECT notification_id, status, mail_status,
       TO_CHAR(sent_date,'YYYY-MM-DD HH24:MI:SS')  AS sent,
       TO_CHAR(end_date, 'YYYY-MM-DD HH24:MI:SS')  AS completed,
       ROUND((NVL(end_date,SYSDATE)-sent_date)*24,2) AS total_hours,
       to_user
FROM   wf_notifications
WHERE  notification_id = \${NID};

PROMPT --- AQ enqueue time for NID \${NID} ---
SELECT TO_CHAR(enq_time,'YYYY-MM-DD HH24:MI:SS') AS enq_time,
       msg_state, corr_id
FROM   aq\$wf_notification_in
WHERE  corr_id LIKE '%\${NID}%'
ORDER  BY enq_time DESC
FETCH FIRST 5 ROWS ONLY;
SQLEOF2
  fi
  echo ""
else
  echo "[SKIP] Set APPS_PWD variable to enable database checks"
  echo "       Example: APPS_PWD=<password> ./ebs_wf_mailer_diag.sh \${NID}"
  echo ""
fi

# --- Summary ---
echo "============================================"
echo " RESULT: \${PASS} passed, \${FAIL} failed, \${WARN} warnings"
echo "============================================"

[ "\${FAIL}" -eq 0 ]
\`\`\`

**Usage examples:**

\`\`\`bash
# Basic OS and log checks only (no DB password required)
source /u01/applmgr/EBSPRD/EBSapps.env run
./ebs_wf_mailer_diag.sh

# Full check including database queries for notification ID 98765
APPS_PWD=apps_password ./ebs_wf_mailer_diag.sh 98765
\`\`\`

---

## Summary

| Phase | Check | Expected |
|-------|-------|----------|
| 1 | Environment sourced | FND_TOP, APPLCSF set |
| 2 | FNDCPGSC OS process | At least one process running |
| 3 | fnd_svc_components (R12.1+) | component_status = RUNNING |
| 4 | Mailer log — recent inbound activity | processing inbound message entries present |
| 5 | Mailer log — DISCARD rate | Low; high rate indicates inbox contamination |
| 6 | WF_NOTIFICATION_IN queue | READY count small and shrinking |
| 7 | Inbound Agent Listener | Active with recent last_date |
| 8 | Inactive users with open notifications | None |
| 9 | WF table sizes | Reasonable; purge scheduled if large |
| 10 | Five-timestamp gap analysis | All gaps documented; largest gap identifies root cause |

After identifying the largest gap, apply the corresponding remediation: reduce poll interval and increase threads for T2→T3 gaps; clean the IMAP inbox and cancel inactive user notifications for T3→T4 gaps; run the Workflow purge for T4→T5 gaps. For T1→T2 gaps, escalate to the corporate email team for mail routing analysis.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'EBS Workflow Email Approval Latency Runbook: Five-Timestamp Diagnosis and Notification Mailer Remediation Across 11i, R12.1.3, and R12.2.x',
    slug,
    excerpt: 'Step-by-step runbook for diagnosing and fixing Oracle EBS Workflow email approval latency. Uses the five-timestamp method (T1 approver click → T2 IMAP arrival → T3 mailer fetch → T4 AQ enqueue → T5 workflow complete) to pinpoint the bottleneck across all EBS release families. Covers mailer service status, queue depth, log analysis, IMAP inbox contamination, inactive user cleanup, and Workflow schema purge. Includes the ebs_wf_mailer_diag.sh automation script.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
