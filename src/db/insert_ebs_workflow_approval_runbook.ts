import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'EBS Workflow Approval Runbook: Diagnosing Stuck Approvals, AME Validation, and Item Recovery',
  slug: 'ebs-workflow-approval-process-runbook',
  excerpt:
    'Complete runbook for diagnosing and recovering stuck Oracle EBS workflow approval transactions. Covers SQL queries to trace items through WF_ITEMS, WF_ITEM_ACTIVITY_STATUSES, and WF_NOTIFICATIONS; AME approval chain inspection; Workflow Background Process scheduling; errored item reset procedures; force-advance and reassignment without data corruption; and notification re-delivery.',
  category: 'ebs-workflow' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `## Overview

This runbook covers the diagnosis and recovery of stuck, errored, and stalled workflow approval transactions in Oracle EBS. It applies to all EBS modules that use Oracle Workflow for approvals: Purchasing (POAPPRV), iProcurement (REQAPPRV), Payables (APINVAPR), iExpense (AP_WEB_EXPENSE), General Ledger (GLPOST), and Order Management (OEOAPPRV).

**Prerequisites:** APPS schema SELECT access, WF_ADMIN_USER privilege (or SYSADMIN responsibility) for item reset operations, understanding of the affected module's approval configuration.

---

## Phase 1: Locate the Stuck Workflow Item

Every EBS transaction that goes through approval has a corresponding workflow item. The item is identified by its ITEM_TYPE and ITEM_KEY.

### 1.1 Map the Transaction to Its Workflow Item

**For Purchase Orders:**

\`\`\`sql
SELECT wh.item_type,
       wh.item_key,
       wh.activity_status,
       wh.begin_date,
       wh.end_date,
       wh.error_name,
       wh.error_message
FROM   wf_item_activity_statuses_h wh
WHERE  wh.item_type = 'POAPPRV'
AND    wh.item_key  = (
         SELECT wf_item_key
         FROM   po_headers_all
         WHERE  segment1 = '&PO_NUMBER'
         AND    org_id   = &ORG_ID
       )
ORDER  BY wh.begin_date DESC;
\`\`\`

**For AP Invoices:**

\`\`\`sql
SELECT i.item_type,
       i.item_key,
       i.begin_date,
       i.end_date,
       i.user_key,
       ia.name         AS current_activity,
       ias.activity_status,
       ias.error_message
FROM   wf_items i
JOIN   wf_item_activity_statuses ias
         ON ias.item_type = i.item_type
        AND ias.item_key  = i.item_key
JOIN   wf_process_activities pa
         ON pa.instance_id = ias.process_activity
JOIN   wf_activities ia
         ON ia.name        = pa.activity_name
        AND ia.item_type   = pa.activity_item_type
WHERE  i.item_type = 'APINVAPR'
AND    ias.activity_status IN ('NOTIFIED', 'DEFERRED', 'ERROR')
AND    i.end_date IS NULL
ORDER  BY i.begin_date DESC;
\`\`\`

**For Expense Reports:**

\`\`\`sql
SELECT i.item_type,
       i.item_key,
       iav.text_value  AS expense_report_id,
       ias.activity_status,
       a.display_name  AS current_activity_label,
       ias.error_name,
       ias.error_message,
       ias.begin_date
FROM   wf_items i
JOIN   wf_item_activity_statuses ias
         ON ias.item_type = i.item_type
        AND ias.item_key  = i.item_key
JOIN   wf_process_activities pa
         ON pa.instance_id = ias.process_activity
JOIN   wf_activities a
         ON a.name        = pa.activity_name
        AND a.item_type   = pa.activity_item_type
LEFT JOIN wf_item_attribute_values iav
         ON iav.item_type = i.item_type
        AND iav.item_key  = i.item_key
        AND iav.name      = 'EXPENSE_REPORT_ID'
WHERE  i.item_type = 'AP_WEB_EXPENSE'
AND    i.end_date  IS NULL
AND    ias.activity_status NOT IN ('COMPLETE')
ORDER  BY i.begin_date;
\`\`\`

### 1.2 Check All Active Items for a Module

\`\`\`sql
-- All open, non-completed workflow items for a given item type
SELECT i.item_type,
       i.item_key,
       i.user_key,
       i.begin_date,
       TRUNC(SYSDATE - i.begin_date)  AS days_open,
       ias.activity_status,
       a.display_name                  AS stuck_at_activity
FROM   wf_items i
JOIN   wf_item_activity_statuses ias
          ON ias.item_type = i.item_type
         AND ias.item_key  = i.item_key
JOIN   wf_process_activities pa
          ON pa.instance_id = ias.process_activity
JOIN   wf_activities a
          ON a.name       = pa.activity_name
         AND a.item_type  = pa.activity_item_type
WHERE  i.item_type = 'POAPPRV'       -- change to target item type
AND    i.end_date  IS NULL
AND    ias.activity_status IN ('NOTIFIED', 'DEFERRED', 'ERROR')
ORDER  BY days_open DESC;
\`\`\`

---

## Phase 2: Determine the Root Cause

### 2.1 Check for ERROR Status Items

\`\`\`sql
SELECT ias.item_type,
       ias.item_key,
       a.display_name   AS failed_activity,
       ias.error_name,
       ias.error_message,
       ias.error_stack,
       ias.begin_date
FROM   wf_item_activity_statuses ias
JOIN   wf_process_activities pa
          ON pa.instance_id = ias.process_activity
JOIN   wf_activities a
          ON a.name       = pa.activity_name
         AND a.item_type  = pa.activity_item_type
WHERE  ias.activity_status = 'ERROR'
AND    ias.item_type = '&ITEM_TYPE'
ORDER  BY ias.begin_date DESC;
\`\`\`

Record the ERROR_NAME and ERROR_STACK. Common error names and their meaning:

| ERROR_NAME | Meaning |
|-----------|---------|
| WF_NO_PERFORMER | No approver found — AME returned empty list or hierarchy broken |
| WF_INVALID_COMMAND | PL/SQL function returned an unexpected result code |
| NOTIF_SEND_FAILED | Notification Mailer failed to deliver the notification |
| FND_ACCESS_CONTROL | Responsibility or function access issue in the approval routing function |

### 2.2 Check Notification Status for NOTIFIED Items

When an item is stuck in NOTIFIED status, the workflow engine has created a notification and is waiting for a response. Check whether the notification was actually delivered:

\`\`\`sql
SELECT n.notification_id,
       n.item_type,
       n.item_key,
       n.recipient_role,
       r.email_address,
       n.status,
       n.mail_status,
       n.begin_date,
       n.due_date,
       n.responder,
       n.more_info_role
FROM   wf_notifications n
JOIN   wf_roles r ON r.name = n.recipient_role
WHERE  n.item_type = '&ITEM_TYPE'
AND    n.item_key  = '&ITEM_KEY'
AND    n.status    = 'OPEN'
ORDER  BY n.begin_date DESC;
\`\`\`

**Interpreting MAIL_STATUS:**

| MAIL_STATUS | Meaning | Action |
|------------|---------|--------|
| MAIL | Queued — mailer has not picked it up yet | Check if Notification Mailer is running |
| SENT | Email delivered successfully | Check approver's inbox; may have been filtered as spam |
| FAILED | Mailer attempted delivery but failed | Check mailer log for error; re-send after fix |
| INVALID | Recipient role has no valid email address | Add email to FND_USER; re-send |
| NULL | Email delivery not attempted | Mailer may be stopped; check WFMLRSVC status |

### 2.3 Check for Missing Email Address

\`\`\`sql
-- Find approvers on open notifications with no email
SELECT n.notification_id,
       n.recipient_role,
       u.email_address,
       u.user_name,
       n.mail_status
FROM   wf_notifications n
JOIN   fnd_user u ON u.user_name = n.recipient_role
WHERE  n.status     = 'OPEN'
AND    n.item_type  = '&ITEM_TYPE'
AND    (u.email_address IS NULL OR u.email_address = ' ');
\`\`\`

### 2.4 Inspect the AME Approval Chain

When AME is configured, use this to see what the engine built for a specific transaction:

\`\`\`sql
-- Check AME approval list for a PO (substitute transaction_id and type)
SELECT aa.approver_name,
       aa.approver_category,
       aa.api_insertion,
       aa.authority,
       aa.status,
       aa.approval_status,
       aa.occurrence
FROM   ame_approvals aa
WHERE  aa.application_id    = 201              -- 201 = Purchasing; 200 = Payables
AND    aa.transaction_id    = '&PO_HEADER_ID'
AND    aa.transaction_type  = 'PO_REQUISITION_INTERNAL'  -- adjust to your transaction type
ORDER  BY aa.occurrence;
\`\`\`

If this query returns no rows, AME has no approval chain for the transaction — either no AME rules fire (check rule conditions), or AME is not enabled for the transaction type.

### 2.5 Check the Workflow Background Process Schedule

\`\`\`sql
-- Confirm the WF Background Process is scheduled and running
SELECT request_id,
       program_short_name,
       phase_code,
       status_code,
       TO_CHAR(requested_start_date, 'YYYY-MM-DD HH24:MI:SS') AS next_run,
       TO_CHAR(actual_start_date, 'YYYY-MM-DD HH24:MI:SS')    AS last_start,
       TO_CHAR(actual_completion_date, 'YYYY-MM-DD HH24:MI:SS') AS last_end,
       argument_text
FROM   fnd_concurrent_requests
WHERE  program_short_name = 'FNDWFBG'
ORDER  BY request_id DESC
FETCH  FIRST 5 ROWS ONLY;
\`\`\`

The Background Process should run at least every 5-10 minutes for active environments. If STATUS_CODE is ERROR or it has not run recently, submit a new request immediately (Phase 4 covers this).

---

## Phase 3: Recover Errored Workflow Items

### 3.1 Retry an Errored Activity (Single Item)

For items in ERROR status where the underlying problem is fixed (e.g., the GL account is now valid, the email address is added), retry the errored activity:

\`\`\`sql
-- As APPS user — retry the errored activity for a specific item
BEGIN
  WF_ENGINE.handleError(
    itemtype => '&ITEM_TYPE',
    itemkey  => '&ITEM_KEY',
    activity => NULL,    -- NULL retries the most recently errored activity
    command  => 'RETRY',
    result   => NULL
  );
  COMMIT;
  DBMS_OUTPUT.PUT_LINE('Retry issued for item: &ITEM_KEY');
END;
/
\`\`\`

After executing, query WF_ITEM_ACTIVITY_STATUSES to confirm the activity is no longer in ERROR status.

### 3.2 Retry Multiple Errored Items in Bulk

\`\`\`sql
-- Retry all errored items for a given item type (use cautiously in production)
DECLARE
  CURSOR c_errored IS
    SELECT DISTINCT item_type, item_key
    FROM   wf_item_activity_statuses
    WHERE  item_type       = '&ITEM_TYPE'
    AND    activity_status = 'ERROR';
BEGIN
  FOR r IN c_errored LOOP
    BEGIN
      WF_ENGINE.handleError(
        itemtype => r.item_type,
        itemkey  => r.item_key,
        activity => NULL,
        command  => 'RETRY',
        result   => NULL
      );
      COMMIT;
      DBMS_OUTPUT.PUT_LINE('Retried: ' || r.item_key);
    EXCEPTION
      WHEN OTHERS THEN
        DBMS_OUTPUT.PUT_LINE('Failed retry for: ' || r.item_key || ' - ' || SQLERRM);
        ROLLBACK;
    END;
  END LOOP;
END;
/
\`\`\`

### 3.3 Skip an Errored Activity

When retrying will not succeed (e.g., a deprecated API call in a customized workflow that cannot be patched immediately), you can skip the errored activity and advance to a specific result:

\`\`\`sql
BEGIN
  WF_ENGINE.handleError(
    itemtype => '&ITEM_TYPE',
    itemkey  => '&ITEM_KEY',
    activity => '&ACTIVITY_NAME',   -- exact activity name from WF_ACTIVITIES
    command  => 'SKIP',
    result   => 'COMPLETE'          -- or the specific transition result needed
  );
  COMMIT;
END;
/
\`\`\`

**Warning**: Skipping activities bypasses business logic. Only use SKIP when the errored activity is a non-critical validation and you have confirmed with the functional team that skipping is safe.

---

## Phase 4: Re-Send Stuck Notifications

### 4.1 Re-Send a Single Notification

When MAIL_STATUS is FAILED, INVALID, or NULL and the underlying issue is fixed (email address added, mailer restarted), re-queue the notification:

\`\`\`sql
-- Re-send notification by setting MAIL_STATUS back to MAIL
BEGIN
  WF_NOTIFICATION.Send(
    nid => &NOTIFICATION_ID     -- from the WF_NOTIFICATIONS query in Phase 2
  );
  COMMIT;
  DBMS_OUTPUT.PUT_LINE('Notification ' || &NOTIFICATION_ID || ' re-queued for delivery');
END;
/
\`\`\`

Alternatively, update the status directly (use only when WF_NOTIFICATION.Send is unavailable):

\`\`\`sql
UPDATE wf_notifications
SET    mail_status = 'MAIL'
WHERE  notification_id = &NOTIFICATION_ID
AND    status = 'OPEN';
COMMIT;
\`\`\`

### 4.2 Re-Send All Failed Notifications for an Item Type

\`\`\`sql
BEGIN
  FOR n IN (
    SELECT notification_id
    FROM   wf_notifications
    WHERE  item_type   = '&ITEM_TYPE'
    AND    status      = 'OPEN'
    AND    mail_status IN ('FAILED', 'INVALID')
  ) LOOP
    BEGIN
      WF_NOTIFICATION.Send(nid => n.notification_id);
      COMMIT;
    EXCEPTION
      WHEN OTHERS THEN
        DBMS_OUTPUT.PUT_LINE('Send failed for nid: ' || n.notification_id);
        ROLLBACK;
    END;
  END LOOP;
END;
/
\`\`\`

---

## Phase 5: Reassign a Stuck Notification

When an approver is unavailable (terminated, on leave) and the notification needs to go to a different person immediately:

\`\`\`sql
-- Reassign an open notification to a different user
BEGIN
  WF_NOTIFICATION.Transfer(
    nid     => &NOTIFICATION_ID,
    newrole => 'NEW_USERNAME'    -- FND_USER.USER_NAME of the new approver
  );
  COMMIT;
  DBMS_OUTPUT.PUT_LINE('Notification transferred to NEW_USERNAME');
END;
/
\`\`\`

For bulk reassignment when an entire user's pending notifications must be delegated:

\`\`\`sql
-- Transfer all open notifications from one approver to another
BEGIN
  FOR n IN (
    SELECT notification_id
    FROM   wf_notifications
    WHERE  recipient_role = 'OLD_USERNAME'
    AND    status         = 'OPEN'
  ) LOOP
    BEGIN
      WF_NOTIFICATION.Transfer(
        nid     => n.notification_id,
        newrole => 'NEW_USERNAME'
      );
      COMMIT;
    EXCEPTION
      WHEN OTHERS THEN
        DBMS_OUTPUT.PUT_LINE('Transfer failed for nid: ' || n.notification_id);
    END;
  END LOOP;
END;
/
\`\`\`

---

## Phase 6: Force-Approve or Force-Reject a Stuck Item

When an approval must be completed immediately (e.g., end-of-period close is blocked) and the approver is unreachable, a workflow administrator can respond to a notification programmatically. This action is equivalent to the approver clicking Approve in the EBS worklist — it fully closes the notification and advances the workflow.

\`\`\`sql
-- Force-approve (response = 'APPROVED'; adjust to the notification's expected response)
BEGIN
  WF_NOTIFICATION.Respond(
    nid      => &NOTIFICATION_ID,
    respond_comment => 'Force approved by DBA due to approver unavailability - authorized by [manager name]',
    responder       => 'SYSADMIN',   -- FND_USER.USER_NAME of the person authorizing this action
    response_found  => NULL
  );
  COMMIT;
  DBMS_OUTPUT.PUT_LINE('Notification ' || &NOTIFICATION_ID || ' force-responded');
END;
/
\`\`\`

**Important**: Always document force-approval actions in your change management system. The responder value is stored in WF_NOTIFICATIONS.RESPONDER and is auditable.

To determine the correct response value for a specific notification:

\`\`\`sql
SELECT na.name,
       na.value
FROM   wf_notification_attributes na
WHERE  na.notification_id = &NOTIFICATION_ID
AND    na.name IN ('RESULT', 'RESPONSE', 'APPROVE_RESPONSE');
\`\`\`

---

## Phase 7: Validate and Schedule the Workflow Background Process

### 7.1 Submit the Background Process

In EBS System Administrator:

1. Navigate to **Concurrent > Requests > Submit**
2. Program: **Workflow Background Process**
3. Parameters:
   - **Item Type**: Leave blank to process all, or specify (e.g., POAPPRV)
   - **Minimum Threshold**: 0
   - **Maximum Threshold**: 100
   - **Process Deferred**: Yes
   - **Process Timeout**: Yes
   - **Process Stuck**: Yes
4. Schedule: **Periodically**, every 5 minutes, end date: none
5. Submit

### 7.2 Verify Background Process Parameters via SQL

\`\`\`sql
-- Confirm the last run's parameters and status
SELECT fcr.request_id,
       fcr.status_code,
       fcr.phase_code,
       fcr.argument1  AS item_type_param,
       fcr.argument5  AS process_deferred,
       fcr.argument6  AS process_timeout,
       fcr.argument7  AS process_stuck,
       TO_CHAR(fcr.actual_start_date, 'YYYY-MM-DD HH24:MI:SS') AS last_run,
       TO_CHAR(fcr.actual_completion_date, 'YYYY-MM-DD HH24:MI:SS') AS completed
FROM   fnd_concurrent_requests fcr
WHERE  fcr.program_short_name = 'FNDWFBG'
ORDER  BY fcr.request_id DESC
FETCH  FIRST 3 ROWS ONLY;
\`\`\`

---

## Phase 8: AME Rule Validation

### 8.1 Identify Which AME Rules Fire for a Transaction

\`\`\`sql
-- List all AME rules applicable to a transaction type
SELECT ar.name           AS rule_name,
       ar.description,
       ar.rule_type,
       ar.start_date,
       ar.end_date,
       ar.priority
FROM   ame_rules ar
WHERE  ar.rule_type = 'APPROVAL'
AND    (ar.end_date IS NULL OR ar.end_date > SYSDATE)
ORDER  BY ar.priority;
\`\`\`

### 8.2 Check AME Conditions for a Rule

\`\`\`sql
-- List conditions attached to a specific AME rule
SELECT rc.condition_id,
       c.condition_type,
       c.attribute_id,
       a.name       AS attribute_name,
       c.parameter_one,
       c.parameter_two,
       c.string_value
FROM   ame_rule_usages ru
JOIN   ame_rules r      ON r.rule_id      = ru.rule_id
JOIN   ame_conditions c ON c.condition_id = ru.condition_id
JOIN   ame_attributes a ON a.attribute_id = c.attribute_id
LEFT JOIN ame_rule_conditions rc ON rc.rule_id = r.rule_id AND rc.condition_id = c.condition_id
WHERE  r.name = '&AME_RULE_NAME'
AND    (r.end_date IS NULL OR r.end_date > SYSDATE)
ORDER  BY c.condition_type;
\`\`\`

### 8.3 Test AME Approval Chain Without Submitting a Transaction

Use the AME Test Workbench (available in EBS under AME Responsibility > Test Workbench) to simulate the approval chain for a specific transaction ID without actually routing the document:

1. Log in with the AME Responsibility
2. Navigate to **Transaction Types**
3. Select the transaction type (e.g., Oracle Purchasing)
4. Click **Test**
5. Enter a transaction ID (PO_HEADER_ID, INVOICE_ID, etc.)
6. Click **Get Approvers**

The workbench displays every rule that fired, the conditions evaluated, and the resulting approval list. This is the fastest way to confirm why a specific document is routing to an unexpected approver.

---

## Phase 9: Workflow Purge Maintenance

Old completed and errored workflow items accumulate in the WF tables and degrade performance. The standard purge is the Purge Obsolete Workflow Runtime Data concurrent request.

### 9.1 Assess Purge Candidate Volume

\`\`\`sql
-- Count purgeable items (completed or errored, older than 90 days)
SELECT item_type,
       COUNT(*) AS purgeable_items
FROM   wf_items
WHERE  end_date IS NOT NULL
AND    end_date < SYSDATE - 90
GROUP  BY item_type
ORDER  BY purgeable_items DESC;
\`\`\`

### 9.2 Submit the Purge Request

In System Administrator:

1. Submit: **Purge Obsolete Workflow Runtime Data**
2. Parameters:
   - **Item Type**: Leave blank for all, or specify one item type per run
   - **Item Key**: Leave blank
   - **Age**: 90 (days) — purge items older than 90 days
   - **Persistence Type**: TEMP
   - **Core Workflow Only**: No (purges all item types)
3. Run in off-peak hours; the first run after a long backlog may take several hours.

### 9.3 Verify Purge Results

\`\`\`sql
-- Count remaining items after purge
SELECT item_type,
       COUNT(*) AS remaining_open,
       MIN(begin_date) AS oldest_open
FROM   wf_items
WHERE  end_date IS NULL
GROUP  BY item_type
ORDER  BY oldest_open;
\`\`\`

---

## Summary

| Symptom | Diagnosis Query | Remediation |
|---------|----------------|-------------|
| Approval stuck for days | WF_ITEM_ACTIVITY_STATUSES — check activity_status | Phase 3 (ERROR) or Phase 4 (NOTIFIED) |
| No email received | WF_NOTIFICATIONS — check mail_status | Re-send (Phase 4) or fix email address |
| Wrong approver receiving notification | AME approval chain query (Phase 2.4) | Fix AME rule conditions |
| Workflow item in ERROR | WF_ITEM_ACTIVITY_STATUSES — read error_message | Phase 3 — retry or skip |
| Timeout not firing | Background Process schedule check (Phase 2.5) | Submit/reschedule FNDWFBG (Phase 7) |
| Terminated employee blocking approval | WF_NOTIFICATIONS — recipient_role | Transfer notification (Phase 5) |
| Need to force an approval urgently | WF_NOTIFICATION.Respond | Phase 6 — with manager authorization |
| WF tables growing, performance degrading | Count purgeable items (Phase 9.1) | Submit Purge request (Phase 9.2) |`,
};

async function main() {
  console.log('Inserting EBS Workflow Approval Process runbook...');
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
