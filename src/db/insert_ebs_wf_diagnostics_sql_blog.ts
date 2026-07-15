import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-workflow-diagnostics-fnd-top-sql-performance';

const content = `
Oracle ships a collection of diagnostic and remediation SQL scripts inside \`\$FND_TOP/sql/\` that are designed specifically for Workflow investigations. These scripts are available across all three major EBS release families — 11i, R12.1.3, and R12.2.x — and cover the full range of Workflow performance problems: stuck activities, deferred queue backlogs, notification failures, errored processes, and orphaned items.

Most DBAs discover these scripts during an Oracle Support engagement, where a service request asks you to run one of them and attach the output. But they are equally useful for proactive monitoring and self-directed triage, and knowing what each script does and how to interpret its output turns a multi-hour investigation into a structured thirty-minute diagnostic.

This post covers the diagnostic scripts available at \`\$FND_TOP/sql/\`, how each one is run, what its output reveals, and how the relevant Workflow performance concepts differ across 11i, R12.1.3, and R12.2.x.

---

## The Oracle Workflow Engine: Performance Failure Modes

Before reaching for the diagnostic scripts, it helps to know the four performance failure modes the Workflow Engine can enter:

**Stuck activities** — An activity in a process is in ERROR status. The process halts at that activity and will not advance until the error is resolved and the activity is retried or skipped.

**Deferred queue backlog** — Activities with a cost greater than 50 (set in the workflow process definition) are placed into the \`WF_DEFERRED\` queue for processing by the Background Engine. If the Background Engine is not running frequently enough, or if deferred activity volume exceeds its throughput, the queue accumulates unprocessed items and the processes appear frozen to end users.

**Notification queue delay** — As covered separately, replies to email notifications pass through \`WF_NOTIFICATION_IN\` before the Workflow Engine sees them. A backed-up queue or an unhealthy Notification Mailer causes approval delays without raising any error in the workflow item itself.

**Orphaned or timed-out items** — Workflow items that missed their timeout window, were abandoned mid-process, or were left open after the underlying business object was cancelled accumulate in the WF tables over time and degrade query and queue performance.

All four failure modes are diagnosable with the scripts in \`\$FND_TOP/sql/\`.

---

## Script Inventory: What Is at \$FND_TOP/sql/

List the available workflow diagnostic scripts on any EBS tier:

\`\`\`bash
ls -1 \$FND_TOP/sql/wf*.sql
\`\`\`

The scripts most relevant to performance investigation:

| Script | Purpose | Input |
|--------|---------|-------|
| \`wfver.sql\` | Workflow server version | None |
| \`wfstat.sql\` | Full status of a single workflow process | Item type, item key |
| \`wfmlrdbg.sql\` | Notification mailer debug report (HTML) | Notification ID |
| \`wfitmcnt.sql\` | Item counts by type and status | None |
| \`wfdiag.sql\` | Comprehensive Workflow diagnostic (HTML) | Item type, item key, admin email |
| \`wfretry.sql\` | Retry a specific errored activity | Item type, item key, activity label |
| \`wfskipact.sql\` | Skip an errored activity to the next | Item type, item key, activity label, result |
| \`wfrmitm.sql\` | Remove a workflow item (use with care) | Item type, item key |
| \`wfload.sql\` | Workflow loader utility (not a diagnostic) | — |

Not all scripts exist in all EBS versions. The set shipped with 11i is smaller than what ships with R12. If a script is missing in your installation, Oracle Support can provide it as a patch or attachment.

---

## Running the Scripts: Environment and Prerequisites

All scripts run from sqlplus as the APPS user. Source the EBS environment first so \`\$FND_TOP\` resolves correctly.

### EBS 11i

\`\`\`bash
source /u01/applmgr/EBSPRD/EBSPRD_appnode01.env
sqlplus apps/<apps_password>
SQL> @\$FND_TOP/sql/wfver.sql
\`\`\`

In 11i, the Workflow schema is owned by OWF_MGR (in older installations) or APPLSYS. The diagnostic scripts query both. If you see \`ORA-00942: table or view does not exist\`, the executing user needs SELECT grants on the WF views — check that you are connecting as APPS.

### EBS R12.1.3

\`\`\`bash
source /u01/applmgr/EBSPRD/EBSPRD_appnode01.env
sqlplus apps/<apps_password>
SQL> @\$FND_TOP/sql/wfver.sql
\`\`\`

In R12.1, Workflow is fully integrated into the APPLSYS schema. All WF_ tables and views are accessible to the APPS synonym layer. The scripts work without modification.

### EBS R12.2.x

\`\`\`bash
source /u01/applmgr/EBSPRD/EBSapps.env run
sqlplus apps/<apps_password>
SQL> @\$FND_TOP/sql/wfver.sql
\`\`\`

In R12.2, Workflow data is in the non-editioned schema (not tied to fs1 or fs2), so the diagnostic scripts query consistent data regardless of which edition is the current run edition. Source the run edition environment before connecting so \`\$FND_TOP\` resolves to the active code tree.

---

## wfver.sql — Workflow Version

Run this first on any new engagement to confirm the Workflow version installed.

\`\`\`sql
SQL> @\$FND_TOP/sql/wfver.sql
\`\`\`

Output:

\`\`\`
Oracle Workflow Version: 2.6.4
Oracle Database Version: Oracle Database 19c Enterprise Edition
\`\`\`

The version number matters because some diagnostic behaviors and available internal procedures differ between Workflow 2.6 (11i) and 2.6.4 (R12). If a MOS note or support engineer references a Workflow version-specific behaviour, use this output to confirm applicability.

---

## wfstat.sql — Single Process Status

This is the most commonly used diagnostic script. Given an item type and item key, it displays the complete status of a single workflow process instance — every activity, its current status, the performer, any error message, and the elapsed time.

\`\`\`sql
SQL> @\$FND_TOP/sql/wfstat.sql
Enter value for item_type: POAPPRV
Enter value for item_key: 123456
\`\`\`

The script prompts for the item type and key using SQL\*Plus substitution variables. The item type is the Workflow item type code (e.g., \`POAPPRV\` for PO Approval, \`REQAPPRV\` for Requisition Approval, \`APEXP\` for AP Expense Reports, \`OEOL\` for Order Management). The item key is the unique identifier for this specific workflow instance — for a PO it is typically the document ID.

### Finding the item type and key for a business object

\`\`\`sql
-- PO Approval workflow for a specific PO header
SELECT wi.item_type,
       wi.item_key,
       wi.begin_date,
       wi.end_date,
       wi.user_key
FROM   wf_items wi
WHERE  wi.item_type = 'POAPPRV'
AND    wi.user_key  LIKE '%<PO_NUMBER>%'
ORDER  BY wi.begin_date DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

### Interpreting wfstat.sql output

The output is a text report showing each activity in the process tree. Look for:

- **ERROR** status — the activity raised an exception; the error message in the right column tells you what failed
- **NOTIFIED** status — the process is waiting for a notification response; this is normal for approval steps
- **DEFERRED** status — the activity is queued for the Background Engine; if this has been unchanged for more than a few minutes it indicates a deferred queue backlog
- **ACTIVE** status — the activity is currently executing; if it has been ACTIVE for an unusually long time it may be hanging

Example output (partial):

\`\`\`
Item Type:  POAPPRV
Item Key:   123456
User Key:   PO-2024-09876

Process:    PO_APPROVAL_INIT (ACTIVE)
 > Start  (COMPLETE)
 > Verify PO Data  (COMPLETE)
 > Approve PO  (NOTIFIED)    [Performer: JSMITH  Notification: 98765]
\`\`\`

---

## wfdiag.sql — Comprehensive HTML Diagnostic

\`wfdiag.sql\` generates a detailed HTML report covering the full lifecycle of a workflow item. It includes the process status (like wfstat.sql), all notification history, attribute values, error stack traces, and AQ queue activity — all in a single browsable file.

\`\`\`sql
SQL> @\$FND_TOP/sql/wfdiag.sql
Enter value for item_type: POAPPRV
Enter value for item_key: 123456
Enter value for admin_email: dba@company.com
\`\`\`

The output file is written to the current directory with a name like \`wfdiag_POAPPRV_123456.htm\`. Open it in a browser to navigate the report sections.

\`wfdiag.sql\` is the recommended script to run and attach to a MOS service request when escalating a complex workflow issue, because it captures everything in a single file without requiring Oracle Support to ask follow-up questions.

**Availability:** \`wfdiag.sql\` is not present in all 11i installations. It was introduced with later 11i patchsets and is standard in R12.1 and R12.2. If it is absent on 11i, Oracle Support can provide it.

---

## wfmlrdbg.sql — Notification Mailer Debug

For email approval latency investigations, \`wfmlrdbg.sql\` generates an HTML report for a specific notification that shows the complete IMAP lifecycle — when it was sent, when the mailer fetched the reply, when it was enqueued, and any errors encountered.

\`\`\`sql
SQL> @\$FND_TOP/sql/wfmlrdbg.sql
Enter value for notification_id: 98765
\`\`\`

Output file: \`wfmlrdbg98765.htm\` in the current directory.

Find the notification ID from the WF_NOTIFICATIONS table:

\`\`\`sql
SELECT notification_id, status, mail_status, sent_date, to_user, subject
FROM   wf_notifications
WHERE  item_type = 'POAPPRV'
AND    item_key  = '123456'
ORDER  BY notification_id DESC;
\`\`\`

---

## wfitmcnt.sql — Item Counts by Type and Status

This script requires no input and shows aggregate counts of all workflow items grouped by item type and status. It is the fastest way to identify which workflow types have backlog or errors at a systemic level.

\`\`\`sql
SQL> @\$FND_TOP/sql/wfitmcnt.sql
\`\`\`

Sample output:

\`\`\`
ITEM_TYPE    STATUS      COUNT
------------ ----------- ------
POAPPRV      ACTIVE        428
POAPPRV      COMPLETE     8821
POAPPRV      ERROR          17
REQAPPRV     ACTIVE        203
REQAPPRV     COMPLETE    14322
REQAPPRV     ERROR           4
APEXP        ACTIVE         89
APEXP        COMPLETE     5671
\`\`\`

A non-zero ERROR count for any item type is an immediate action item — those processes are halted and will not complete without intervention. A very high ACTIVE count relative to the COMPLETE count may indicate items that have been open longer than expected.

---

## wfretry.sql and wfskipact.sql — Remediation Scripts

Once \`wfstat.sql\` or \`wfdiag.sql\` identifies a specific errored activity, use these scripts to advance the process.

### wfretry.sql — Retry an errored activity

Retries the same activity from the beginning. Use when the root cause of the error has been resolved (e.g., a database object was invalid and has been recompiled, or a required profile option was missing and has been set).

\`\`\`sql
SQL> @\$FND_TOP/sql/wfretry.sql
Enter value for item_type: POAPPRV
Enter value for item_key: 123456
Enter value for activity: VERIFY_PO_DATA
\`\`\`

The activity label is the internal name shown in the wfstat.sql output.

### wfskipact.sql — Skip an errored activity

Marks the errored activity as complete with a specified result and moves the process to the next activity. Use when the activity cannot succeed and the business decision is to bypass it.

\`\`\`sql
SQL> @\$FND_TOP/sql/wfskipact.sql
Enter value for item_type: POAPPRV
Enter value for item_key: 123456
Enter value for activity: VERIFY_PO_DATA
Enter value for result:   #NULL
\`\`\`

Use \`#NULL\` as the result when the activity has no meaningful result code, or supply the specific result expected by the process definition (e.g., \`APPROVED\`, \`REJECTED\`).

---

## Deferred Queue Monitoring — Supplemental Queries

The diagnostic scripts do not directly surface the WF_DEFERRED queue state. Use these supplemental queries alongside the scripts.

### Deferred queue depth

\`\`\`sql
-- Activities currently queued for Background Engine processing
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

The Background Engine runs as the \`Workflow Background Process\` concurrent program. Check its recent runs:

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

If there are no recent WFBGP runs, or if they all show an error status, the deferred queue will not drain regardless of how the Workflow engine is otherwise configured.

### Activities in DEFERRED status for a long time

\`\`\`sql
SELECT wi.item_type,
       wi.item_key,
       wias.process_activity,
       wias.assigned_user,
       ROUND((SYSDATE - wias.begin_date) * 24, 1) AS hours_deferred,
       wias.error_name,
       wias.error_message
FROM   wf_item_activity_statuses wias
JOIN   wf_items wi ON wi.item_type = wias.item_type
                  AND wi.item_key  = wias.item_key
WHERE  wias.activity_status = 'DEFERRED'
AND    wias.begin_date       < SYSDATE - 1/24
ORDER  BY wias.begin_date;
\`\`\`

### Activities in ERROR status (systemic view)

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

- Workflow version 2.6; \`wfdiag.sql\` may be absent and must be obtained from Oracle Support
- The Background Engine (\`WFBGP\`) is a scheduled concurrent program — there is no service component equivalent
- AQ infrastructure exists but is less deeply integrated; some \`AQ\$\` views may not be queryable without additional grants
- \`wfitmcnt.sql\` output can be slow on large 11i installations because the WF tables are not partitioned — run during off-peak hours

### EBS R12.1.3

- Workflow version 2.6.4; all scripts listed above are available
- Workflow Agent Listeners run as Generic Service Components (visible in \`fnd_svc_components\`)
- The \`WF_DEFERRED\` and \`WF_NOTIFICATION_IN\` queues are managed via Oracle AQ; subscribe agents are visible in \`wf_agents\`
- \`wfdiag.sql\` produces richer output than in 11i because it can query the agent activity tables introduced in 2.6.4

### EBS R12.2.x

- Workflow behaves identically to R12.1.3 for all diagnostic purposes
- Workflow data lives in the non-editioned schema and is not affected by \`adop\` patching cycles
- After a cutover, verify the Workflow Agent Listener service components are running:

\`\`\`sql
SELECT component_name, component_status, last_update_date
FROM   fnd_svc_components
WHERE  component_type LIKE 'WF_%';
\`\`\`

- The Background Engine concurrent program (\`WFBGP\`) should be scheduled to run every few minutes on the run edition; after a cutover it starts automatically but verify it did not stay in INACTIVE status

---

## Common Investigation Patterns

### Pattern 1 — "A specific PO approval is stuck"

\`\`\`
1. Get the PO header_id and derive item_type = POAPPRV, item_key = header_id
2. Run: @\$FND_TOP/sql/wfstat.sql → identify the activity in ERROR or DEFERRED
3. If ERROR: note the error_message, resolve the root cause, run wfretry.sql
4. If DEFERRED for >30 min: check Background Engine status (WFBGP recent runs)
5. Run: @\$FND_TOP/sql/wfdiag.sql → attach output to any escalation
\`\`\`

### Pattern 2 — "Many approvals are delayed across multiple POs"

\`\`\`
1. Run: @\$FND_TOP/sql/wfitmcnt.sql → count ACTIVE items by type; look for ERROR spike
2. Query AQ\$WF_DEFERRED_IN → check if READY count is large
3. Check WFBGP recent runs → confirm Background Engine is running on schedule
4. If email approvals specifically: query WF_NOTIFICATION_IN queue depth
5. For a representative delayed PO: run wfstat.sql + wfmlrdbg.sql
\`\`\`

### Pattern 3 — "Overall Workflow performance has degraded over time"

\`\`\`
1. Check WF table sizes: WF_NOTIFICATIONS, WF_ITEMS, WF_ITEM_ACTIVITY_STATUSES
2. Run: Purge Obsolete Workflow Runtime (Core Workflow Only = N)
3. Rebuild indexes on WF tables if fragmentation is high
4. Check Background Engine schedule — increase frequency if deferred queue is accumulating
5. Review wfitmcnt.sql output for COMPLETE items that should have been purged
\`\`\`

---

## Summary

The scripts at \`\$FND_TOP/sql/\` provide a structured, version-consistent diagnostic path for all four Workflow performance failure modes. The investigation flow is the same across 11i, R12.1.3, and R12.2.x: start with \`wfver.sql\` to confirm the Workflow version, use \`wfitmcnt.sql\` to identify which item types have backlog or errors at scale, then drill into specific items with \`wfstat.sql\` and \`wfdiag.sql\`. Supplement the scripts with AQ queue queries and Background Engine status checks, because those performance dimensions are not directly covered by the script output.

Remediation follows directly from diagnosis: \`wfretry.sql\` for errored activities whose root cause is resolved, \`wfskipact.sql\` when bypassing is the business decision, and the Purge Obsolete Workflow Runtime concurrent program for the long-term table bloat that underlies most chronic Workflow performance degradation.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'Using the Oracle EBS Workflow Diagnostic Scripts at $FND_TOP/sql: A Performance Investigation Guide for 11i, R12.1.3, and R12.2.x',
    slug,
    excerpt: 'Oracle ships a complete set of Workflow diagnostic and remediation SQL scripts inside $FND_TOP/sql/ that cover all four Workflow performance failure modes: stuck activities, deferred queue backlog, notification queue delay, and orphaned items. This post covers the script inventory, how each script is run and interpreted, version differences across all three EBS release families, and the three most common multi-item investigation patterns.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
