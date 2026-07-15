import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';
import { eq } from 'drizzle-orm';

const slug = 'ebs-workflow-diagnostics-fnd-top-sql-performance';

const content = `
Oracle ships a collection of diagnostic and remediation SQL scripts inside \`\$FND_TOP/sql/\` that are designed specifically for Workflow investigations. These scripts are available across all three major EBS release families — 11i, R12.1.3, and R12.2.x — and cover the full range of Workflow performance problems: stuck activities, deferred queue backlogs, notification failures, errored processes, and orphaned items.

Most DBAs discover these scripts during an Oracle Support engagement, where a service request asks you to run one and attach the output. But they are equally useful for proactive monitoring and self-directed triage, and knowing what each script does and how to interpret its output turns a multi-hour investigation into a structured thirty-minute diagnostic.

This post covers each script at \`\$FND_TOP/sql/\`, how it is run, what its output contains, and how to read the results.

---

## The Oracle Workflow Engine: Performance Failure Modes

Before reaching for the diagnostic scripts, it helps to know the four performance failure modes the Workflow Engine can enter:

**Stuck activities** — An activity in a process is in ERROR status. The process halts at that activity and will not advance until the error is resolved and the activity is retried or skipped.

**Deferred queue backlog** — Activities with a cost greater than 50 (set in the workflow process definition) are placed into the \`WF_DEFERRED\` queue for processing by the Background Engine. If the Background Engine is not running frequently enough, or if deferred activity volume exceeds its throughput, the queue accumulates unprocessed items and the processes appear frozen to end users.

**Notification queue delay** — Replies to email notifications pass through \`WF_NOTIFICATION_IN\` before the Workflow Engine sees them. A backed-up queue or an unhealthy Notification Mailer causes approval delays without raising any error in the workflow item itself.

**Orphaned or timed-out items** — Workflow items that missed their timeout window, were abandoned mid-process, or were left open after the underlying business object was cancelled accumulate in the WF tables over time and degrade query and queue performance.

All four failure modes are diagnosable with the scripts in \`\$FND_TOP/sql/\`.

---

## Script Inventory: What Is at \$FND_TOP/sql/

List the available workflow diagnostic scripts on any EBS tier:

\`\`\`bash
ls -1 \$FND_TOP/sql/wf*.sql
\`\`\`

The scripts most relevant to performance investigation:

| Script | Purpose | Input required |
|--------|---------|----------------|
| \`wfver.sql\` | Workflow server version | None |
| \`wfstat.sql\` | Full status of a single workflow process | Item type, item key |
| \`wfmlrdbg.sql\` | Notification mailer debug report (HTML) | Notification ID |
| \`wfitmcnt.sql\` | Item counts by type and status | None |
| \`wfdiag.sql\` | Comprehensive workflow diagnostic (HTML) | Item type, item key, admin email |
| \`wfretry.sql\` | Retry a specific errored activity | Item type, item key, activity label |
| \`wfskipact.sql\` | Skip an errored activity to the next | Item type, item key, activity label, result |
| \`wfrmitm.sql\` | Remove a workflow item | Item type, item key |

Not all scripts exist in all EBS versions. The set shipped with 11i is smaller than what ships with R12. If a script is missing, Oracle Support can provide it as a patch attachment.

---

## Running the Scripts: Environment and Prerequisites

All scripts run from sqlplus as the APPS user. Source the EBS environment first so \`\$FND_TOP\` resolves correctly.

### EBS 11i

\`\`\`bash
source /u01/applmgr/EBSPRD/EBSPRD_appnode01.env
sqlplus apps/<apps_password>
SQL> @\$FND_TOP/sql/wfver.sql
\`\`\`

In 11i, the Workflow schema is owned by OWF_MGR (older installations) or APPLSYS. The diagnostic scripts query both. If you see \`ORA-00942: table or view does not exist\`, the executing user needs SELECT grants on the WF views — verify you are connecting as APPS.

### EBS R12.1.3

\`\`\`bash
source /u01/applmgr/EBSPRD/EBSPRD_appnode01.env
sqlplus apps/<apps_password>
SQL> @\$FND_TOP/sql/wfver.sql
\`\`\`

In R12.1, Workflow is fully integrated into the APPLSYS schema. All WF_ tables and views are accessible through the APPS synonym layer.

### EBS R12.2.x

\`\`\`bash
source /u01/applmgr/EBSPRD/EBSapps.env run
sqlplus apps/<apps_password>
SQL> @\$FND_TOP/sql/wfver.sql
\`\`\`

In R12.2, Workflow data is in the non-editioned schema — not tied to fs1 or fs2 — so diagnostic scripts query consistent data regardless of which edition is the current run edition. Source the run edition environment before connecting so \`\$FND_TOP\` resolves to the active code tree.

---

## wfver.sql — Workflow Version

### What it does

Queries the Oracle Workflow server version from the database metadata and prints it alongside the database version. No parameters required.

\`\`\`sql
SQL> @\$FND_TOP/sql/wfver.sql
\`\`\`

### Sample output

\`\`\`
Oracle Workflow Version: 2.6.4
Oracle Database Version: Oracle Database 19c Enterprise Edition Release 19.0.0.0.0
\`\`\`

### How to interpret the results

The Workflow version number determines which internal APIs, AQ infrastructure, and diagnostic capabilities are available:

- **2.6** — EBS 11i. Older API set. \`wfdiag.sql\` may be absent. AQ integration exists but agent activity tables are less rich. Some performance APIs introduced in 2.6.4 are unavailable.
- **2.6.4** — EBS R12.1.3 and R12.2.x. Full API set. All diagnostic scripts are present. Generic Service Components (Notification Mailer, Agent Listener) are manageable via \`fnd_svc_components\`.

Run this first on any new engagement. If a MOS note or support engineer references a version-specific behaviour, use this output to confirm applicability before following the guidance.

---

## wfstat.sql — Single Process Status

### What it does

Queries the complete status of one workflow process instance — every activity in the process tree, its current status, the performer or notification waiting for response, any error message, and the begin/end timestamps. This is the most commonly used diagnostic script.

\`\`\`sql
SQL> @\$FND_TOP/sql/wfstat.sql
Enter value for item_type: POAPPRV
Enter value for item_key: 123456
\`\`\`

The script uses SQL\*Plus substitution variables and prompts for both inputs. The **item type** is the Workflow item type code assigned to the business process. The **item key** is the unique identifier for this specific workflow instance — for a PO it is the document ID, for a requisition it is the requisition ID.

### Finding the item type and key for a business object

\`\`\`sql
-- PO Approval
SELECT wi.item_type, wi.item_key, wi.begin_date, wi.end_date, wi.user_key
FROM   wf_items wi
WHERE  wi.item_type = 'POAPPRV'
AND    wi.user_key  LIKE '%<PO_NUMBER>%'
ORDER  BY wi.begin_date DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

Common EBS item type codes:

| Business Process | Item Type |
|-----------------|-----------|
| PO Approval | POAPPRV |
| Requisition Approval | REQAPPRV |
| AP Expense Report | APEXP |
| AP Invoice Approval | APINVAPR |
| Order Management Line | OEOL |
| Order Management Header | OEHDRWFT |
| HR Self-Service | HRSSA |

### Sample output

\`\`\`
===================================================================
Item Type:    POAPPRV
Item Key:     123456
User Key:     PO-2024-09876
Begin Date:   2024-11-15 09:22:04
End Date:
===================================================================

Process:      PO_APPROVAL_INIT  (ACTIVE)   Begin: 2024-11-15 09:22:05

  Activity            Status     Performer         Begin                Error
  ------------------- ---------- ----------------- -------------------- -----
  START               COMPLETE                     2024-11-15 09:22:05
  INITIALIZE          COMPLETE                     2024-11-15 09:22:06
  VERIFY_PO_DATA      COMPLETE                     2024-11-15 09:22:07
  DO_APPROVE          NOTIFIED   JSMITH            2024-11-15 09:23:01
    Notification ID:  98765
  COMPLETE_ACTIVITY   WAITING
\`\`\`

### Activity status codes and what they mean

| Status | Meaning | Action |
|--------|---------|--------|
| **COMPLETE** | Activity finished successfully | Normal — no action needed |
| **ACTIVE** | Activity is currently executing | Normal if recent; investigate if many hours old |
| **NOTIFIED** | Waiting for a user to respond to a notification | Normal for approval steps; check if notification is in mail_status = SENT |
| **DEFERRED** | Queued for Background Engine processing | Normal if Background Engine is running and age is short; investigate if >30 minutes |
| **ERROR** | Activity raised an unhandled exception | Always investigate — the process is halted |
| **SUSPEND** | Process explicitly suspended by a DBA or application | Intentional; check if it should be resumed |
| **CANCEL** | Activity was cancelled | May be expected or may indicate an abort |
| **WAITING** | Waiting for a preceding AND join to complete | Normal in parallel branches |

### Common findings and what they indicate

**All activities COMPLETE but process still ACTIVE with no further steps:** The process completed one branch but a parallel branch is still running. Look for the ACTIVE branch further down the output tree.

**ERROR on an early INITIALIZE or VERIFY activity:** Usually indicates a data problem — a required value is missing or a database object referenced in the workflow PL/SQL is invalid. The error message column gives the ORA- code and API call that failed.

**DEFERRED activity unchanged for more than 30 minutes:** The Background Engine (\`WFBGP\` concurrent program) is not running, is erroring, or is overwhelmed by queue volume. Run the Background Engine status queries in Phase 6 of the runbook.

**NOTIFIED for an activity that should have been responded to:** The approver may have replied by email but the Notification Mailer has not processed the reply. Check the notification ID shown in the output and run \`wfmlrdbg.sql\` for that ID.

**Process shows ACTIVE at the top but all visible activities are COMPLETE:** A subprocess is running. wfstat.sql shows subprocess activities indented under the parent — scroll down to find the subprocess that is still running.

---

## wfdiag.sql — Comprehensive HTML Diagnostic

### What it does

Generates a self-contained HTML report covering the full lifecycle of one workflow item. The report includes everything wfstat.sql shows, plus item attribute values, all notifications ever sent for this item, AQ queue activity for each notification, error stack traces with full PL/SQL call chains, and agent activity history.

\`\`\`sql
SQL> @\$FND_TOP/sql/wfdiag.sql
Enter value for item_type: POAPPRV
Enter value for item_key: 123456
Enter value for admin_email: dba@company.com
\`\`\`

The admin email is embedded into the report header and is used as a contact reference if Oracle Support needs to follow up. The output file is written to the current working directory.

\`\`\`bash
cd /tmp
sqlplus apps/<apps_password> @\$FND_TOP/sql/wfdiag.sql
ls -lh /tmp/wfdiag_POAPPRV_123456.htm
\`\`\`

Open the file in any browser to navigate the report sections.

### Report sections and how to read them

**Section 1 — Item Summary:** Shows item type, item key, user key, begin and end dates, and the root process name. Confirm these match the business object you are investigating. If \`end_date\` is populated, the process completed — the issue may be in a child process or a subsequent workflow.

**Section 2 — Process Status:** The same activity tree as wfstat.sql, reformatted as an HTML table. Sortable by status — click the Status column header to group all ERROR or DEFERRED activities together for fast identification.

**Section 3 — Item Attributes:** All workflow item attributes and their current values. Useful when an activity error references a specific attribute (e.g., \`DOCUMENT_ID\`, \`APPROVER_TYPE\`, \`FORWARD_FROM_USERNAME\`). If an attribute that should be populated is NULL, the workflow was likely not initialised correctly by the calling application code.

**Section 4 — Notification History:** Every notification ever raised for this item, with its ID, status, mail_status, sent date, recipient, and subject. Look for notifications in \`OPEN\` / \`SENT\` status that have been waiting for a response for longer than expected, and for notifications in \`CANCELLED\` status that were cancelled before a response arrived (may indicate a reassignment or escalation happened).

**Section 5 — Error Details:** Full PL/SQL error stack for each ERROR-status activity. The stack trace shows the exact package, procedure, and line number where the exception was raised. This is the section to focus on when triaging an ERROR you have not seen before — the stack trace narrows the fix to a specific code path.

**Section 6 — Agent Activity:** AQ message state history for any messages enqueued or dequeued for this item. Useful for confirming that a notification reply was actually enqueued into \`WF_NOTIFICATION_IN\` and subsequently dequeued by the Workflow Engine.

### When to use wfdiag.sql vs wfstat.sql

Use \`wfstat.sql\` for a quick check of where a specific process is halted. Use \`wfdiag.sql\` when:
- The error stack in wfstat.sql is truncated and you need the full PL/SQL trace
- You need to verify what attribute values the workflow was given at initialisation
- You need the notification history to confirm an approval response was received
- You are preparing an output to attach to an Oracle Support service request — wfdiag.html is the standard attachment format requested by Oracle Support engineers

**Availability:** \`wfdiag.sql\` is not present in all 11i installations. It was introduced with later 11i patchsets and is standard in R12.1 and R12.2. If absent on 11i, request it from Oracle Support.

---

## wfmlrdbg.sql — Notification Mailer Debug

### What it does

Generates an HTML report for a single notification that shows the complete IMAP lifecycle: when the notification was created, when it was sent via SMTP, when the mailer fetched the reply from the IMAP inbox, when the reply was enqueued into \`WF_NOTIFICATION_IN\`, and any errors the mailer encountered when processing it.

\`\`\`sql
SQL> @\$FND_TOP/sql/wfmlrdbg.sql
Enter value for notification_id: 98765
\`\`\`

Output file: \`wfmlrdbg98765.htm\` in the current working directory.

### Finding the notification ID

The notification ID appears in the output of \`wfstat.sql\` next to any NOTIFIED activity. It also appears in the email sent to the approver (embedded in the reply-to address or the email body, depending on EBS version). To retrieve it from the database:

\`\`\`sql
SELECT notification_id, status, mail_status, sent_date, to_user, subject
FROM   wf_notifications
WHERE  item_type = 'POAPPRV'
AND    item_key  = '123456'
ORDER  BY notification_id DESC;
\`\`\`

### Report sections and how to read them

**Notification Header:** The notification ID, item type, item key, status, mail_status, sent_date, and recipient. Confirm these match what you expect. \`mail_status = SENT\` means the outbound message was delivered to the SMTP server. \`mail_status = MAIL\` means it has not yet been picked up by the outbound mailer thread.

**IMAP Processing Timeline:** The timestamp sequence showing when the mailer logged into the IMAP inbox, found the reply, parsed the Notification ID from the message, moved it to the PROCESSED folder, and enqueued it into \`WF_NOTIFICATION_IN\`. This is where you measure the T2→T3 gap (IMAP inbox arrival to EBS fetch).

**Notification Attributes:** The attribute values carried by this notification, including the response value recorded when the approver clicked Approve or Reject. If the attribute is blank, the response was not captured — investigate whether the reply email format was recognised by the mailer.

**Error Messages:** Any errors the mailer encountered when processing this specific notification — IMAP parse failures, NID validation failures, or enqueue errors. A message moved to the DISCARD folder appears here with the reason.

### Common findings and what they indicate

**No IMAP processing timestamp present:** The mailer has not yet fetched the reply. Either the reply has not arrived in the IMAP inbox (T1→T2 delay — check the corporate mail system), or the mailer is not polling (check mailer service component status and FNDCPGSC log).

**Message processed but no enqueue timestamp:** The mailer parsed the message but failed to enqueue it into \`WF_NOTIFICATION_IN\`. Usually indicates an AQ error — check for ORA-25207 or AQ permission issues in the mailer log.

**Message shown in DISCARD folder:** The mailer could not match the message to a valid Notification ID. The reply email format may have been mangled by the mail client or relay (HTML vs plain text encoding, forwarding stripping the NID from the subject line).

**Large gap between IMAP arrival and mailer fetch timestamp:** The poll interval is too long or the inbound thread was processing a large number of other messages. Reduce \`POLL_INTERVAL\` in the Notification Mailer configuration.

---

## wfitmcnt.sql — Item Counts by Type and Status

### What it does

Queries aggregate counts of all workflow items grouped by item type, root process name, and status. No input required. This is the fastest way to identify which workflow types have backlog or errors at a systemic level — run it first when investigating a report that "many approvals are delayed" without a specific transaction to point at.

\`\`\`sql
SQL> @\$FND_TOP/sql/wfitmcnt.sql
\`\`\`

### Sample output

\`\`\`
ITEM_TYPE    ROOT_ACTIVITY          STATUS      COUNT
------------ ---------------------- ----------- ------
POAPPRV      PO_APPROVAL_INIT       ACTIVE        428
POAPPRV      PO_APPROVAL_INIT       COMPLETE     8821
POAPPRV      PO_APPROVAL_INIT       ERROR          17
REQAPPRV     REQUISITION_APPROVAL   ACTIVE        203
REQAPPRV     REQUISITION_APPROVAL   COMPLETE    14322
REQAPPRV     REQUISITION_APPROVAL   ERROR           4
APEXP        AP_EXPENSE_REPORT_WF   ACTIVE         89
APEXP        AP_EXPENSE_REPORT_WF   COMPLETE     5671
\`\`\`

### How to interpret the results

**ERROR count > 0 for any item type:** Immediate action item. Those processes are halted. Run the errored activity query to identify the common error, then use \`wfstat.sql\` on representative items to diagnose the root cause.

**ACTIVE count that looks disproportionately large:** Compare against the COMPLETE count and consider the expected volume for that workflow type. For example, if POAPPRV shows 428 ACTIVE but the business only processes 50 POs per day, there may be 370 items that started but have been stalled for days or weeks. Cross-reference with a query against \`wf_items.begin_date\` to check how old the ACTIVE items are.

**Very large COMPLETE counts with no recent purge:** COMPLETE items that have accumulated over months or years are the primary driver of WF schema bloat and slow queue performance. They are safe to purge with the Purge Obsolete Workflow Runtime concurrent program.

**Missing item types:** If you expect to see a specific workflow type but it does not appear in the output, no workflow items of that type have ever been created — or they were all purged. This can indicate a configuration problem where the calling application is not launching the workflow.

**Slow execution of wfitmcnt.sql itself:** On a large 11i installation with millions of WF_ITEMS rows and no purge history, this script can take several minutes. Run it during off-peak hours. On R12 with a maintained schema it should return in seconds.

---

## wfretry.sql — Retry an Errored Activity

### What it does

Calls \`WF_ENGINE.HANDLEERROR\` with the RETRY command for a specific activity. This reruns the activity from the beginning, exactly as if it had never executed. The process state for that activity is reset to ACTIVE and the activity function is invoked again.

\`\`\`sql
SQL> @\$FND_TOP/sql/wfretry.sql
Enter value for item_type: POAPPRV
Enter value for item_key: 123456
Enter value for activity: VERIFY_PO_DATA
\`\`\`

The **activity** parameter is the internal activity label as shown in the \`wfstat.sql\` output — not the display name. It is case-sensitive and must match exactly.

### When to use wfretry.sql

Use wfretry.sql only after the root cause of the error has been resolved. If the activity fails for the same reason again after retry, the root cause is still present. Common scenarios where retry is appropriate:

- A PL/SQL package referenced by the activity was invalid and has been recompiled
- A required profile option was missing and has been set
- A database link used by the activity was down and has been restored
- A record that was locked by another session has been released
- A temporary network timeout caused the activity to fail — retry may succeed immediately

### What to check after running wfretry.sql

Immediately run \`wfstat.sql\` for the same item. The retried activity should show ACTIVE (currently executing) or COMPLETE (succeeded) within a few seconds. If it returns to ERROR with the same error message, the root cause fix did not take effect. If it returns to DEFERRED, the Background Engine will process it on its next run.

### What wfretry.sql does NOT do

It does not send a new notification to the approver. If the process had previously sent a NOTIFIED activity to a user and that activity is what errored (rare but possible), the notification state is reset. It does not roll back any database changes made by the activity before the error — if the activity partially completed before failing, a retry may encounter data state left by the partial execution.

---

## wfskipact.sql — Skip an Errored Activity

### What it does

Calls \`WF_ENGINE.HANDLEERROR\` with the SKIP command. Instead of re-executing the errored activity, it marks the activity as COMPLETE with a specified result and moves the process forward to whatever activity the process definition routes to for that result.

\`\`\`sql
SQL> @\$FND_TOP/sql/wfskipact.sql
Enter value for item_type: POAPPRV
Enter value for item_key: 123456
Enter value for activity: VERIFY_PO_DATA
Enter value for result:   #NULL
\`\`\`

### The result parameter

The result value must match one of the valid transition labels defined in the Workflow process for the activity being skipped. If the activity has a result type with specific values (e.g., \`APPROVED\`, \`REJECTED\`, \`FORWARD\`), supply the appropriate internal lookup code. If the activity has no result type — for example, it is a procedure call that either succeeds or fails with no branching — use \`#NULL\`.

Using the wrong result value causes the process to route to an unexpected branch or raises a transition error. If you are unsure what result values are valid for a given activity, query the process definition:

\`\`\`sql
SELECT wfpa.instance_label   AS activity_label,
       wft.name              AS transition_result,
       wfpa2.instance_label  AS routes_to
FROM   wf_process_activities wfpa
JOIN   wf_activity_transitions wat  ON wat.from_process_activity = wfpa.instance_id
JOIN   wf_lookups wft               ON wft.lookup_type = wat.result_type
                                   AND wft.lookup_code = wat.result_code
JOIN   wf_process_activities wfpa2  ON wfpa2.instance_id = wat.to_process_activity
WHERE  wfpa.process_name = 'PO_APPROVAL_INIT'
AND    wfpa.instance_label = 'VERIFY_PO_DATA';
\`\`\`

### When to use wfskipact.sql vs wfretry.sql

| Situation | Use |
|-----------|-----|
| Root cause is fixed; activity should succeed on re-run | \`wfretry.sql\` |
| Activity cannot succeed and business decision is to bypass it | \`wfskipact.sql\` |
| Activity errored due to data that will never be corrected | \`wfskipact.sql\` |
| Oracle Support instructs a specific skip with a specific result | \`wfskipact.sql\` |

**Risk:** Skipping an activity bypasses whatever business logic that activity was supposed to perform. Always confirm with the functional team that skipping is acceptable before proceeding — the activity may enforce a compliance rule, update a required field, or send a mandatory notification.

---

## wfrmitm.sql — Remove a Workflow Item

### What it does

Completely removes a workflow item and all data associated with it from the WF schema: the item record from \`WF_ITEMS\`, all attribute values from \`WF_ITEM_ATTRIBUTE_VALUES\`, all activity status records from \`WF_ITEM_ACTIVITY_STATUSES\`, all notifications from \`WF_NOTIFICATIONS\` (including their attributes), and associated AQ messages.

\`\`\`sql
SQL> @\$FND_TOP/sql/wfrmitm.sql
Enter value for item_type: POAPPRV
Enter value for item_key: 123456
\`\`\`

### When to use wfrmitm.sql

**This script is destructive and irreversible.** Use it only for workflow items that have no corresponding active business object — for example:

- A PO was cancelled at the application level but the workflow item was left ACTIVE in the WF schema (the application did not cleanly terminate the workflow)
- A test workflow item created during development or QA was never closed
- An orphaned item with no matching record in the business application tables (PO_HEADERS, AP_INVOICES, etc.)

Never use wfrmitm.sql on an item that corresponds to an open, active business transaction. Removing the workflow item leaves the business object in a state the application cannot advance — the next time a user or process queries the transaction, the missing workflow state may cause application errors.

### Verify before removing

\`\`\`sql
-- Confirm the business object still exists and its status
SELECT document_num, status_lookup_code, cancel_flag, closed_code
FROM   po_headers_all
WHERE  po_header_id = 123456;

-- If the PO is CANCELLED or FINALLY CLOSED, the workflow item is safe to remove.
-- If the PO is OPEN or APPROVED, do not remove the workflow item.
\`\`\`

---

## Deferred Queue Monitoring — Supplemental Queries

The diagnostic scripts do not directly surface the WF_DEFERRED queue state. Use these supplemental queries alongside the scripts.

### Deferred queue depth

\`\`\`sql
SELECT msg_state,
       COUNT(*)           AS msg_count,
       MIN(enq_time)      AS oldest_enq,
       MAX(enq_time)      AS newest_enq
FROM   aq\$wf_deferred_in
GROUP  BY msg_state
ORDER  BY msg_state;
\`\`\`

A growing \`READY\` count that does not shrink between checks means the Background Engine is not running or cannot keep pace.

### Background Engine status (all versions)

\`\`\`sql
SELECT fcr.request_id,
       fcr.actual_start_date,
       fcr.actual_completion_date,
       fcr.status_code,
       fcr.completion_text
FROM   fnd_concurrent_requests fcr
JOIN   fnd_concurrent_programs fcp ON fcr.concurrent_program_id = fcp.concurrent_program_id
WHERE  fcp.concurrent_program_name = 'WFBGP'
ORDER  BY fcr.actual_start_date DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

### Activities in DEFERRED status for more than 30 minutes

\`\`\`sql
SELECT wi.item_type,
       wi.item_key,
       wias.process_activity,
       ROUND((SYSDATE - wias.begin_date) * 60, 0) AS minutes_deferred
FROM   wf_item_activity_statuses wias
JOIN   wf_items wi ON wi.item_type = wias.item_type
                  AND wi.item_key  = wias.item_key
WHERE  wias.activity_status = 'DEFERRED'
AND    wias.begin_date       < SYSDATE - 30/1440
ORDER  BY wias.begin_date;
\`\`\`

### All activities in ERROR status

\`\`\`sql
SELECT wi.item_type,
       wi.item_key,
       wias.process_activity,
       wias.error_name,
       SUBSTR(wias.error_message, 1, 200) AS error_message,
       wias.begin_date
FROM   wf_item_activity_statuses wias
JOIN   wf_items wi ON wi.item_type = wias.item_type
                  AND wi.item_key  = wias.item_key
WHERE  wias.activity_status = 'ERROR'
ORDER  BY wi.item_type, wias.begin_date;
\`\`\`

---

## Version-Specific Considerations

### EBS 11i

- Workflow version 2.6. \`wfdiag.sql\` may be absent — obtain from Oracle Support if needed.
- The Background Engine (\`WFBGP\`) is a scheduled concurrent program. There is no service component equivalent.
- Some \`AQ\$\` views may require explicit SELECT grants — run supplemental AQ queries as APPS, not as a DBA schema directly.
- \`wfitmcnt.sql\` can be slow on large unpartitioned WF tables on 11i. Run during off-peak hours.

### EBS R12.1.3

- Workflow version 2.6.4. All scripts are available.
- Workflow Agent Listeners run as Generic Service Components visible in \`fnd_svc_components\`. Check their status if the deferred or notification queues are not draining.
- \`wfdiag.sql\` output includes richer agent activity sections than in 11i.

### EBS R12.2.x

- Behaves identically to R12.1.3 for all diagnostic purposes.
- Workflow data is in the non-editioned schema and is not affected by \`adop\` patching cycles.
- After an adop cutover, verify Workflow service components are running before assuming mailer and agent listener health:

\`\`\`sql
SELECT component_name, component_status, last_update_date
FROM   fnd_svc_components
WHERE  component_type LIKE 'WF_%';
\`\`\`

---

## Common Investigation Patterns

### Pattern 1 — A specific approval transaction is stuck

\`\`\`
1. Get the item_type and item_key for the business object
2. Run wfstat.sql → identify the activity in ERROR or DEFERRED
3. If ERROR: read the error_message column, resolve the root cause, run wfretry.sql
4. If DEFERRED for >30 min: check Background Engine status (WFBGP recent runs)
5. If NOTIFIED: note the notification ID, run wfmlrdbg.sql for that ID
6. Run wfdiag.sql → attach output to any Oracle Support escalation
\`\`\`

### Pattern 2 — Many approvals are delayed across multiple transactions

\`\`\`
1. Run wfitmcnt.sql → identify which item types have ERROR or large ACTIVE counts
2. Query AQ$WF_DEFERRED_IN → check if READY count is large
3. Check WFBGP recent runs → confirm Background Engine is running on schedule
4. If email approvals specifically: query WF_NOTIFICATION_IN queue depth
5. For a representative delayed item: run wfstat.sql + wfmlrdbg.sql
\`\`\`

### Pattern 3 — Overall Workflow performance has degraded over time

\`\`\`
1. Check WF table sizes: WF_NOTIFICATIONS, WF_ITEMS, WF_ITEM_ACTIVITY_STATUSES
2. Run wfitmcnt.sql → look for very large COMPLETE counts indicating accumulated data
3. Run Purge Obsolete Workflow Runtime concurrent program (Core Workflow Only = N)
4. Rebuild indexes on WF tables if fragmentation is high after purge
5. Increase Background Engine frequency if the deferred queue is accumulating between runs
\`\`\`

---

## Summary

The scripts at \`\$FND_TOP/sql/\` provide a structured, version-consistent diagnostic path for all four Workflow performance failure modes. The investigation flow is the same across 11i, R12.1.3, and R12.2.x: confirm the Workflow version with \`wfver.sql\`, identify which item types have problems at scale with \`wfitmcnt.sql\`, drill into specific items with \`wfstat.sql\` and \`wfdiag.sql\`, and debug notification-specific delays with \`wfmlrdbg.sql\`.

Remediation follows directly from diagnosis: \`wfretry.sql\` for errored activities whose root cause is resolved, \`wfskipact.sql\` when bypassing is the business decision — with the correct result code confirmed from the process definition — and \`wfrmitm.sql\` only for orphaned items with no corresponding active business transaction. Supplementing the scripts with AQ queue queries and Background Engine status checks covers the performance dimensions the scripts themselves do not surface.
`.trim();

async function main() {
  await db.update(posts).set({
    title: 'Using the Oracle EBS Workflow Diagnostic Scripts at $FND_TOP/sql: Script Guide, Output Interpretation, and Performance Investigation for 11i, R12.1.3, and R12.2.x',
    excerpt: 'Oracle ships a complete set of Workflow diagnostic scripts inside $FND_TOP/sql — wfver.sql, wfstat.sql, wfdiag.sql, wfmlrdbg.sql, wfitmcnt.sql, wfretry.sql, wfskipact.sql, and wfrmitm.sql. This post covers what each script does, how to run it, what its output sections mean, and how to interpret the results for all four Workflow performance failure modes across EBS 11i, R12.1.3, and R12.2.x.',
    content,
    publishedAt: new Date(),
  }).where(eq(posts.slug, slug));
  console.log('Updated:', slug);
}

main().catch(console.error);
