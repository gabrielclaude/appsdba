import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-workflow-email-approval-latency-notification-mailer';

const content = `
A procurement department releases high-value purchase orders — each worth several hundred thousand dollars — to overseas suppliers. When approving managers click Approve directly inside the EBS portal, the PO is released in under ten minutes. When they use email approval instead, the same action takes an average of five hours and sometimes stretches overnight to fifteen hours.

The two code paths are nearly identical from the Workflow Engine's perspective: in both cases, a notification is read, a response is recorded, and the business object is updated. The difference is entirely in the inbound leg of the email loop — the path from the approver's reply to the moment the Workflow Engine sees it. Understanding that path, and knowing where to measure it, is what separates a five-hour search from a twenty-minute diagnosis.

---

## How Oracle Workflow Email Approval Works

Oracle Workflow uses a dual-channel architecture for notification processing: outbound mail is sent via SMTP, and inbound responses are retrieved via IMAP. The Workflow Notification Mailer manages both channels.

### Outbound path

\`\`\`
Workflow Engine
     │
     ▼
WF_NOTIFICATIONS (status = OPEN, mail_status = MAIL)
     │
     ▼
Workflow Notification Mailer — outbound thread
     │
     ▼
SMTP relay → corporate mail server → approver inbox
\`\`\`

When the Workflow Engine raises a notification requiring email approval, it sets \`mail_status = MAIL\` on the \`WF_NOTIFICATIONS\` row. The mailer's outbound thread picks this up, formats the notification email with an embedded Notification ID (NID), and delivers it via the configured SMTP server. On success it sets \`mail_status = SENT\`.

### Inbound path

\`\`\`
Approver replies in email client
     │
     ▼
Corporate mail server — IMAP inbox
     │
     ▼ (poll interval)
Workflow Notification Mailer — inbound thread
     │
     ├── Parses NID from reply subject/body
     ├── Moves message to PROCESSED or DISCARD folder
     └── Enqueues into AQ$WF_NOTIFICATION_IN
          │
          ▼
     Workflow Inbound Agent Listener
          │
          ▼
     Workflow Engine processes response
          │
          ▼
     PO status updated → Approved
\`\`\`

The inbound thread logs into the IMAP inbox on a configurable schedule (the poll interval), reads new messages, validates the embedded NID, moves each message to the PROCESSED or DISCARD folder, and enqueues valid responses into the Oracle Advanced Queue \`WF_NOTIFICATION_IN\`. The Workflow Inbound Agent Listener dequeues from there and hands the response to the Workflow Engine.

Any delay in this chain — from the IMAP poll interval to a saturated inbound thread to a clogged queue — adds directly to the approval latency visible to users.

---

## Workflow Notification Mailer Across EBS Versions

The Workflow Notification Mailer exists in all three major EBS release families, but how it is managed, where its logs live, and how it is restarted differs by version.

### EBS 11i

In 11i, the Workflow Notification Mailer runs as a dedicated Java-based concurrent program managed through the Workflow Manager section of Oracle Applications Manager (OAM).

**Configuration location:**
- System Administrator responsibility → Oracle Applications Manager → Workflow Manager → Notification Mailer
- Parameters are stored in Workflow system resources and the \`WF_RESOURCES\` table

**Log files:**
\`\`\`
\$APPLCSF/\$APPLLOG/FNDCPGSC<pid>.txt
\`\`\`

The log level is set in the Notification Mailer configuration. For active debugging, set it to **Statement**.

**Restart procedure:**
\`\`\`bash
# Stop the mailer via concurrent manager (run as applmgr)
\$FND_TOP/bin/FNDLIBR FND FNDSCSGN apps/<pwd> 0 Y WFMLR STOP

# Or bounce the entire concurrent manager and let it restart automatically
\$FND_TOP/bin/adcmctl.sh stop apps/<pwd>
\$FND_TOP/bin/adcmctl.sh start apps/<pwd>
\`\`\`

**Key inbound configuration parameters in 11i:**
- \`INBOX_FOLDER\` — IMAP folder the mailer polls for new replies (typically \`INBOX\`)
- \`PROCESSED_FOLDER\` — folder to move processed messages into
- \`DISCARD_FOLDER\` — folder for messages with invalid NIDs
- \`POLL_INTERVAL\` — seconds between IMAP polls (default 120; reduce to 30–60 under high load)
- \`INBOUND_THREAD_COUNT\` — parallel threads for reading and processing IMAP messages

### EBS R12.1.3

In R12.1, the Workflow Notification Mailer is a Generic Service Component (GSC) running inside the Workflow Mailer Service Container (FNDCPGSC process). It is managed through Oracle Applications Manager's Service Components interface.

**Configuration location:**
- System Administrator responsibility → Oracle Applications Manager → Service Instances → Workflow Notification Mailer
- Parameters stored in \`FND_SVC_COMP_PARAM_VALS\`

**Log files:**
\`\`\`
\$APPLCSF/\$APPLLOG/FNDCPGSC<pid>.txt
\`\`\`

The log directory is the standard concurrent processing log directory. The FNDCPGSC process name in the OS process list identifies the container.

**Restart procedure:**
\`\`\`bash
# Via OAM Service Components UI (preferred)
# System Administrator → OAM → Service Components → Workflow Notification Mailer → Restart

# Or via concurrent manager
\$FND_TOP/bin/adcmctl.sh stop apps/<pwd>
\$FND_TOP/bin/adcmctl.sh start apps/<pwd>
\`\`\`

**Check the container status from the OS:**
\`\`\`bash
ps -ef | grep -i fndcpgsc | grep -v grep
\`\`\`

**Key configuration query:**
\`\`\`sql
SELECT p.parameter_name,
       v.parameter_value
FROM   fnd_svc_comp_param_vals v
JOIN   fnd_svc_comp_params_vl p ON v.parameter_id = p.parameter_id
JOIN   fnd_svc_components c     ON v.component_id = c.component_id
WHERE  c.component_type = 'WF_MAILER'
AND    p.parameter_name IN (
         'INBOX_FOLDER', 'PROCESSED_FOLDER', 'DISCARD_FOLDER',
         'IMAP_HOST', 'IMAP_PORT', 'POLL_INTERVAL',
         'INBOUND_THREAD_COUNT', 'OUTBOUND_THREAD_COUNT'
       )
ORDER  BY p.parameter_name;
\`\`\`

### EBS R12.2.x

In R12.2, the Workflow Notification Mailer remains a Generic Service Component and is managed identically to R12.1. The underlying FNDCPGSC process runs on the designated concurrent processing node, and the \`inst\` directory for that node contains the logs.

**Log files (R12.2):**
\`\`\`
\$INST_TOP/apps/\${CONTEXT_NAME}/logs/appl/conc/log/FNDCPGSC<pid>.txt
# or the legacy path still works:
\$APPLCSF/\$APPLLOG/FNDCPGSC<pid>.txt
\`\`\`

**R12.2-specific consideration — adop patching:**

After an \`adop phase=cutover\`, the concurrent processing stack is restarted. Verify that the Workflow Notification Mailer service component came back up on the run edition node before assuming it is healthy:

\`\`\`bash
# Source the run edition environment
source /u01/applmgr/EBSPRD/EBSapps.env run

# Confirm the FNDCPGSC container is running
ps -ef | grep -i fndcpgsc | grep -v grep

# Check service component status
sqlplus -s apps/<pwd> << 'EOF'
SELECT component_name, component_status, last_update_date
FROM   fnd_svc_components
WHERE  component_type = 'WF_MAILER';
EOF
\`\`\`

If the component shows \`STOPPED\` or \`DEACTIVATED_SYSTEM\` after a cutover, start it via OAM or bounce the concurrent manager.

**Multi-tier R12.2 note:**

The Workflow Notification Mailer container runs on the node designated as the primary concurrent processing node (the ICM node). It is not distributed across multiple nodes. In a multi-tier R12.2 deployment, verify that the ICM node is active and that \`\$TNS_ADMIN\` on that node can resolve the database service before troubleshooting the mailer itself.

---

## Mapping the Timeline: The Five-Timestamp Method

When an email approval is delayed, the first diagnostic step is to map the exact time spent at each hop in the inbound path. Collect five timestamps for any delayed notification:

| # | Event | Source |
|---|-------|--------|
| T1 | Approver clicked Reply/Approve in email client | Approver's sent folder or email client logs |
| T2 | Reply arrived in IMAP inbox on corporate mail server | Mail server message trace (Exchange, M365 admin center, Postfix logs) |
| T3 | EBS Notification Mailer fetched the message from IMAP | FNDCPGSC\*.txt mailer log |
| T4 | Message enqueued into \`WF_NOTIFICATION_IN\` | \`AQ\$WF_NOTIFICATION_IN.ENQ_TIME\` |
| T5 | Workflow Engine completed the approval | \`WF_NOTIFICATIONS.END_DATE\` |

The gaps tell you where the time is being spent:

- **T1 → T2 large:** The delay is in email delivery — network routing between the approver's location and the corporate mail server. This is outside EBS's control.
- **T2 → T3 large:** The EBS mailer is not polling frequently enough, or the IMAP connection is failing silently.
- **T3 → T4 large:** The mailer is spending excessive time parsing the IMAP inbox (junk mail, unrecognized messages, or a slow IMAP server).
- **T4 → T5 large:** The Workflow Inbound Agent Listener is behind, or the database queue (\`WF_NOTIFICATION_IN\`) is processing slowly due to a bloated Workflow schema.

Collect these timestamps for multiple delayed notifications before drawing conclusions — a single data point can be misleading if that approver was in an unusual network location.

---

## Diagnostic Queries

### Notification lifecycle status

Replace \`:nid\` with the actual Notification ID from the PO approval history:

\`\`\`sql
SELECT notification_id,
       status,
       mail_status,
       sent_date,
       end_date,
       to_user,
       subject,
       ROUND((NVL(end_date, SYSDATE) - sent_date) * 24, 2) AS hours_open
FROM   wf_notifications
WHERE  notification_id = :nid;
\`\`\`

### Notifications sent but not yet responded (delayed inbound)

\`\`\`sql
SELECT notification_id,
       to_user,
       subject,
       sent_date,
       ROUND((SYSDATE - sent_date) * 24, 2) AS hours_since_sent,
       mail_status
FROM   wf_notifications
WHERE  status    = 'OPEN'
AND    mail_status = 'SENT'
AND    sent_date < SYSDATE - 1/24
ORDER  BY sent_date;
\`\`\`

### WF_NOTIFICATION_IN queue depth

\`\`\`sql
SELECT msg_state,
       COUNT(*) AS message_count,
       MIN(enq_time) AS oldest_message
FROM   aq\$wf_notification_in
GROUP  BY msg_state
ORDER  BY msg_state;
\`\`\`

A large number of \`READY\` messages that are not shrinking indicates the Workflow Inbound Agent Listener is not processing.

### Workflow Inbound Agent Listener status

\`\`\`sql
SELECT agent_name,
       status,
       last_date,
       error_message
FROM   wf_agent_activity
WHERE  agent_name = 'WF_NOTIFICATION_IN'
ORDER  BY last_date DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

### Service component status (R12.1/R12.2)

\`\`\`sql
SELECT component_name,
       component_status,
       startup_mode,
       last_update_date
FROM   fnd_svc_components
WHERE  component_type = 'WF_MAILER';
\`\`\`

### Oracle-provided mailer debug report

Oracle ships a diagnostic script that generates a full HTML report for a given Notification ID:

\`\`\`bash
sqlplus apps/<pwd> @\$FND_TOP/sql/wfmlrdbg.sql
# Enter the Notification ID when prompted
# Output file: wfmlrdbg<nid>.htm in the current directory
\`\`\`

The report includes the message state, queue history, IMAP folder movement, and any error messages the mailer encountered when processing that notification.

---

## Three Common Root Causes

### 1. Poll interval too long or inbound threads too few

The default IMAP poll interval in many EBS installations is 120 seconds. Under high approval volume, a single inbound thread processing a 120-second poll cycle will queue replies for up to two minutes between batches. If the inbox also contains slow-parsing messages (see cause 2), the effective lag per reply can grow to several minutes per poll cycle — and if approvals arrive in bursts, they stack up across multiple cycles.

**Fix:**
- Reduce \`POLL_INTERVAL\` to 30–60 seconds in the Notification Mailer configuration
- Increase \`INBOUND_THREAD_COUNT\` from 1 to 2–4 if the inbox volume warrants it
- Monitor CPU usage on the CP node — thread count increases have a direct CPU cost

### 2. IMAP inbox contaminated with unrecognized messages

Every message in the IMAP inbox that the mailer cannot match to a valid NID must be moved to the \`DISCARD\` folder. This includes:

- Out-of-office autoreplies from approvers
- Bounce notifications for emails sent to inactive employee addresses
- Vendor replies forwarded to the EBS mailbox by mistake
- Test emails sent to the EBS notification address by IT staff

Each unrecognized message adds overhead to every poll cycle. In a mailbox with hundreds of accumulated junk messages, the mailer can spend the majority of each poll cycle handling discards rather than processing valid replies.

**Fix:**
- Periodically purge the DISCARD folder (archive or delete)
- Inactivate EBS user accounts for former employees and ensure the \`hz_contact_points\` email address for those users is cleared or set to a non-deliverable address — this prevents the mailer from sending notifications to addresses that will bounce back into the IMAP inbox
- Monitor the DISCARD folder size: if it grows by more than a few messages per day, investigate the source
- Add server-side mail filtering rules on the corporate mail server to pre-filter obvious autoresponders before they reach the IMAP inbox

To check the current DISCARD folder contents from the mailer log:

\`\`\`bash
grep -i "discard" \$APPLCSF/\$APPLLOG/FNDCPGSC*.txt | tail -50
\`\`\`

### 3. Geographic mail routing adding T1→T2 latency

When approvers are located at a remote regional office and the corporate mail infrastructure routes their replies through a relay chain before depositing them in the EBS IMAP inbox, the T1→T2 gap can absorb several hours of the total approval time. This delay is invisible to EBS diagnostics because the message has not yet arrived in the IMAP inbox when T2 is measured.

**Fix:**
- Obtain a mail trace from the corporate email system (Exchange message tracking, Microsoft 365 admin center, or the mail system's logs) showing the relay hops and timestamps for a specific delayed email
- If the T1→T2 gap is consistently large for approvers at a specific location, work with the network team to identify and shorten the mail routing path
- Consider configuring a regional mail relay closer to the approvers' location as a smart host, reducing transit time before the reply reaches the EBS IMAP mailbox

This distinction matters: if T2→T3 is five minutes and T1→T2 is four hours, reducing the EBS poll interval to 30 seconds will not help. The bottleneck is upstream of EBS entirely.

---

## Mailer Log Analysis

The FNDCPGSC log is the primary diagnostic source for T2→T3 and T3→T4 gaps.

### Locate the current mailer log

\`\`\`bash
# Most recent log file (works for 11i, R12.1, R12.2)
ls -lt \$APPLCSF/\$APPLLOG/FNDCPGSC*.txt | head -5

# R12.2 alternative path
ls -lt \$INST_TOP/apps/\${CONTEXT_NAME}/logs/appl/conc/log/FNDCPGSC*.txt 2>/dev/null | head -5
\`\`\`

### Search for inbound message processing

\`\`\`bash
# When did the mailer last successfully process an inbound message?
grep -i "processing inbound message" \$APPLCSF/\$APPLLOG/FNDCPGSC*.txt | tail -20

# Check for IMAP connection errors
grep -i "imap\|connection\|timeout\|error" \$APPLCSF/\$APPLLOG/FNDCPGSC*.txt | tail -50

# Check for DISCARD activity (unrecognized messages)
grep -i "discard\|no valid nid\|could not find" \$APPLCSF/\$APPLLOG/FNDCPGSC*.txt | tail -50
\`\`\`

### Set log level to Statement for deep debugging

Temporarily increase the log level to capture full IMAP transaction details. In R12.1/R12.2, do this via OAM:

- System Administrator → OAM → Service Components → Workflow Notification Mailer → Edit
- Set **Log Level** to \`Statement\`
- Restart the component
- Reproduce the delay and collect the log

Revert to the normal log level (Unexpected or Error) after capturing the needed data — Statement logging generates several megabytes per hour and will fill the log partition on a busy system.

---

## Maintenance: Purge Obsolete Workflow Runtime Data

A bloated Workflow runtime schema degrades AQ performance and slows all queue operations, including \`WF_NOTIFICATION_IN\` enqueue and dequeue. The symptom is a T4→T5 gap that grows over time regardless of mailer tuning.

Run the **Purge Obsolete Workflow Runtime** concurrent program:

- Navigation: System Administrator → Concurrent → Programs → Purge Obsolete Workflow Runtime Data
- Set **Core Workflow Only** = **N** — this purges not only old transaction logs but also obsolete workflow process definitions and unreferenced activity data, which provides broader schema cleanup
- Schedule weekly during off-peak hours

Check current Workflow table sizes before scheduling:

\`\`\`sql
SELECT segment_name,
       ROUND(bytes/1024/1024, 0) AS size_mb
FROM   dba_segments
WHERE  owner = 'APPLSYS'
AND    segment_name IN (
         'WF_NOTIFICATIONS', 'WF_NOTIFICATION_ATTRIBUTES',
         'WF_ITEM_ACTIVITY_STATUSES', 'WF_ITEMS'
       )
ORDER  BY size_mb DESC;
\`\`\`

If the WF tables are significantly large, consider running the purge with a shorter age threshold first (e.g., purge items closed more than 30 days ago) to avoid a single long-running purge operation locking up the concurrent processing queue.

---

## Summary

Email approval latency in Oracle EBS Workflow is almost always diagnosable by mapping five timestamps across the notification lifecycle: approver click time, IMAP inbox arrival time, EBS mailer fetch time, database enqueue time, and Workflow Engine completion time. Each gap corresponds to a specific system or configuration layer, and only the gap from T2 onward is within EBS's control.

Across all three EBS release families — 11i (Workflow Manager/OAM), R12.1.3 (Generic Service Component via OAM), and R12.2.x (same GSC framework, run on the ICM node, with post-adop restart verification) — the Workflow Notification Mailer's IMAP poll interval and inbound thread count are the primary tuning levers for T2→T3 latency. Poll interval contamination from unrecognized IMAP messages and a bloated Workflow schema are the two most common causes of degradation that are invisible to standard monitoring until the latency grows severe.

The diagnostic sequence is: collect timestamps → run \`wfmlrdbg.sql\` for the affected NID → check the queue depth → check the mailer log → check the DISCARD folder size → tune poll interval and thread count → schedule regular Workflow purge. Following this sequence consistently resolves the majority of email approval latency cases within a single working session.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'From Hours to Minutes: Troubleshooting EBS Workflow Email Approval Latency Across 11i, R12.1.3, and R12.2.x',
    slug,
    excerpt: 'Email approvals taking five to fifteen hours while portal approvals complete in under ten minutes is a classic Oracle EBS Workflow Notification Mailer problem. The delay is always in the inbound path — from the approver\'s reply to the Workflow Engine response. This post covers the five-timestamp diagnostic method, the Workflow Notification Mailer architecture across all three EBS release families, the three most common root causes (poll interval, IMAP inbox contamination, geographic mail routing), and how to tune the mailer and maintain the Workflow schema to keep approval latency low.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
