import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'EBS Workflow Slow Performance: Diagnosing Unsent Notifications and Debugging by NID',
  slug: 'ebs-workflow-slow-performance-unsent-notifications-nid-debug',
  excerpt:
    'Workflow slowdowns in Oracle EBS are rarely random — they trace back to notification backlogs, deferred queue congestion, or a handful of stuck items blocking the engine. This post covers the SQL to quantify unsent notification counts, how to identify and isolate a specific Notification ID (NID) that is causing problems, and what monitoring to put in place so you catch queue buildup before it degrades the whole system.',
  category: 'ebs-workflow' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-02'),
  youtubeUrl: null,
  content: `## Introduction

Oracle EBS Workflow is a shared engine. Every approval transaction — purchase orders, invoices, expense reports, journal entries — runs through the same background process, the same notification tables, and the same deferred agent queue. When that engine slows down, every approval in the system slows with it.

Workflow performance problems usually surface as user complaints: "My PO is stuck in approval," "I submitted a requisition an hour ago and the approver has not received an email," or "The workflow mailer stopped sending notifications." The root cause is almost always one of three things:

1. **Unsent notification backlog** — WF_NOTIFICATIONS rows in OPEN status that the mailer has not processed, usually because the outbound agent (WF_NOTIFICATION_OUT) is congested or the mailer is not running
2. **WF_DEFERRED queue congestion** — deferred activities piling up because the Background Engine is not running frequently enough or is single-threaded while thousands of items wait
3. **Stuck workflow items** — a small number of items in ERROR or NOTIFIED status that are not advancing, consuming engine resources on every sweep

This post walks through the SQL queries to diagnose all three, how to drill into a specific Notification ID (NID) to understand exactly what is happening with one notification, and what continuous monitoring to put in place to catch problems early.

---

## Summary

| Symptom | Root Cause | First Query |
|---------|-----------|-------------|
| Mailer not sending | WF_NOTIFICATION_OUT agent congested or mailer stopped | Count OPEN notifications by age |
| Approvals not advancing | WF_DEFERRED queue backlog | Count deferred queue by age bucket |
| One user never receives email | Single stuck NID | Query WF_NOTIFICATIONS by NID |
| Slowdown after patch or clone | Background Engine not restarted | Check agent and engine status |
| Random delays across all modules | WF_DEFERRED queue depth > 10k | Check queue depth and engine concurrency |

If you are responding to a user complaint right now, start with the unsent notification count query — it tells you in seconds whether the mailer is keeping up.

---

## Key Tables and Concepts

Before running any queries, understand the four tables that matter most for workflow performance diagnosis:

| Table | What It Holds |
|-------|--------------|
| WF_NOTIFICATIONS | One row per notification instance — status, recipient, send date, NID |
| WF_NOTIFICATION_ATTRIBUTES | Attribute values for a notification (subject, body tokens, URLs) |
| WF_DEFERRED | AQ-backed queue of activities deferred for background processing |
| WF_ITEM_ACTIVITY_STATUSES | Current status of every activity in every workflow item |

The **NID** (Notification ID) is the primary key of WF_NOTIFICATIONS. It links a notification to the workflow item, the recipient, the message content, and all attribute values. Every mailer log entry references the NID. Every stuck notification query returns a NID. Once you have a NID, you can reconstruct everything about that notification and the item it belongs to.

---

## Runbook

### Step 1 — Check Active Notification Backlog

The first thing to check when users report that workflow emails are not arriving is how many notifications are queued and how old the oldest ones are.

\`\`\`sql
-- Overall unsent notification count by status
SELECT status,
       COUNT(*)                                      AS cnt,
       MIN(begin_date)                               AS oldest,
       MAX(begin_date)                               AS newest,
       ROUND(AVG(SYSDATE - begin_date) * 24, 1)     AS avg_age_hrs
FROM   wf_notifications
WHERE  status IN ('OPEN', 'FAILED', 'CANCELED')
GROUP  BY status
ORDER  BY status;
\`\`\`

**Interpret results:**

- OPEN count under 500 with avg age under 1 hour: normal, mailer is keeping up
- OPEN count in thousands or avg age over 2 hours: mailer is behind — check mailer status next
- High FAILED count: delivery errors — check WF_NOTIFICATION_ATTRIBUTES for error messages
- OPEN count = 0 but users not receiving emails: check if notifications are being created at all

### Step 2 — Age Distribution of Unsent Notifications

A count alone does not tell you whether the backlog is growing or stable. The age distribution tells you.

\`\`\`sql
-- Age buckets for OPEN notifications
SELECT CASE
         WHEN (SYSDATE - begin_date) * 24 < 1   THEN '< 1 hour'
         WHEN (SYSDATE - begin_date) * 24 < 4   THEN '1-4 hours'
         WHEN (SYSDATE - begin_date) * 24 < 24  THEN '4-24 hours'
         WHEN (SYSDATE - begin_date) * 24 < 72  THEN '1-3 days'
         ELSE '> 3 days'
       END                    AS age_bucket,
       COUNT(*)               AS cnt,
       MIN(notification_id)   AS min_nid,
       MAX(notification_id)   AS max_nid
FROM   wf_notifications
WHERE  status = 'OPEN'
GROUP  BY CASE
            WHEN (SYSDATE - begin_date) * 24 < 1   THEN '< 1 hour'
            WHEN (SYSDATE - begin_date) * 24 < 4   THEN '1-4 hours'
            WHEN (SYSDATE - begin_date) * 24 < 24  THEN '4-24 hours'
            WHEN (SYSDATE - begin_date) * 24 < 72  THEN '1-3 days'
            ELSE '> 3 days'
          END
ORDER  BY MIN(SYSDATE - begin_date);
\`\`\`

If notifications older than 24 hours exist in OPEN status, the mailer has stalled — not just fallen behind. Notifications older than 72 hours indicate a systemic problem that has been running for days.

### Step 3 — Notifications by Message Type

Break down the backlog by message type to identify which workflow is generating the most volume or which are stuck.

\`\`\`sql
-- Unsent notifications by item type and message name
SELECT n.message_type,
       n.message_name,
       COUNT(*)                                    AS cnt,
       MIN(n.begin_date)                           AS oldest,
       ROUND(AVG(SYSDATE - n.begin_date) * 24, 1) AS avg_age_hrs
FROM   wf_notifications n
WHERE  n.status = 'OPEN'
GROUP  BY n.message_type, n.message_name
ORDER  BY COUNT(*) DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

A single message type dominating the backlog (e.g., POAPPRV, APEXP, ARNOTICE) tells you which module is the source.

### Step 4 — Check the WF_DEFERRED Queue Depth

The deferred queue drives background workflow activity. A healthy queue has less than a few hundred rows. Thousands of rows means the Background Engine cannot keep up.

\`\`\`sql
-- WF_DEFERRED queue depth by age bucket
SELECT CASE
         WHEN (SYSDATE - enq_time) * 60 < 5    THEN '< 5 min'
         WHEN (SYSDATE - enq_time) * 60 < 30   THEN '5-30 min'
         WHEN (SYSDATE - enq_time) * 60 < 60   THEN '30-60 min'
         WHEN (SYSDATE - enq_time) * 24 < 4    THEN '1-4 hours'
         ELSE '> 4 hours'
       END              AS age_bucket,
       COUNT(*)          AS cnt
FROM   wf_deferred
GROUP  BY CASE
            WHEN (SYSDATE - enq_time) * 60 < 5    THEN '< 5 min'
            WHEN (SYSDATE - enq_time) * 60 < 30   THEN '5-30 min'
            WHEN (SYSDATE - enq_time) * 60 < 60   THEN '30-60 min'
            WHEN (SYSDATE - enq_time) * 24 < 4    THEN '1-4 hours'
            ELSE '> 4 hours'
          END
ORDER  BY MIN(SYSDATE - enq_time);
\`\`\`

Note: In EBS 12.2, WF_DEFERRED is an Oracle AQ table. On older releases you may need to query through the AQ view: SELECT COUNT(*) FROM AQ\$WF_DEFERRED;

### Step 5 — Identify the Oldest Blocked Items

Long-running items in the deferred queue or in NOTIFIED status consume resources on every Background Engine sweep. Find them.

\`\`\`sql
-- Oldest workflow items still in progress
SELECT i.item_type,
       i.item_key,
       i.begin_date,
       ROUND(SYSDATE - i.begin_date, 1)  AS age_days,
       i.user_key
FROM   wf_items i
WHERE  i.end_date IS NULL
  AND  i.begin_date < SYSDATE - 30      -- older than 30 days, likely stuck
ORDER  BY i.begin_date
FETCH FIRST 25 ROWS ONLY;
\`\`\`

Items older than 30 days that have not completed are almost always stuck. They should be investigated item by item — do not purge them without understanding what transaction they belong to.

### Step 6 — Debug a Specific Notification ID (NID)

When a user says "I submitted my PO three hours ago and the approver has not received an email," you need the NID to diagnose exactly what happened. Get it from the user's transaction number or query by role.

**Find NID from an approver's username:**

\`\`\`sql
-- Find open notifications for a specific recipient
SELECT n.notification_id   AS nid,
       n.item_type,
       n.item_key,
       n.message_type,
       n.message_name,
       n.recipient_role,
       n.status,
       n.begin_date,
       n.mail_status,
       n.sent_date,
       ROUND((SYSDATE - n.begin_date) * 24, 2)  AS age_hrs
FROM   wf_notifications n
WHERE  n.recipient_role = UPPER('&approver_username')
  AND  n.status = 'OPEN'
ORDER  BY n.begin_date DESC;
\`\`\`

**Find NID from a PO or requisition number:**

\`\`\`sql
-- Find NID linked to a specific workflow item key
SELECT n.notification_id   AS nid,
       n.message_name,
       n.recipient_role,
       n.status,
       n.mail_status,
       n.begin_date,
       n.sent_date
FROM   wf_notifications n
WHERE  n.item_type = 'POAPPRV'
  AND  n.item_key LIKE '%&document_number%'
ORDER  BY n.begin_date DESC;
\`\`\`

**Once you have the NID, inspect the full notification detail:**

\`\`\`sql
SELECT n.notification_id,
       n.item_type,
       n.item_key,
       n.message_type,
       n.message_name,
       n.recipient_role,
       n.status,
       n.mail_status,
       n.begin_date,
       n.sent_date,
       n.due_date,
       n.responder,
       n.respond_date,
       n.from_role,
       n.subject
FROM   wf_notifications n
WHERE  n.notification_id = &nid;
\`\`\`

**Inspect notification attributes for the NID:**

\`\`\`sql
-- Attribute values for a specific NID (body content, URLs, error tokens)
SELECT na.name,
       na.type,
       na.text_value,
       na.number_value,
       na.date_value
FROM   wf_notification_attributes na
WHERE  na.notification_id = &nid
ORDER  BY na.name;
\`\`\`

**Interpret key fields:**

| Field | What to Look For |
|-------|-----------------|
| mail_status | NULL = not yet picked up by mailer; SENT = delivered; FAILED = delivery error |
| status | OPEN = awaiting response; CANCELED = canceled; CLOSED = responded |
| sent_date | NULL with OPEN mail_status = mailer has not processed it yet |
| from_role | The workflow role that sent the notification |
| subject | Rendered subject line — useful for identifying which document |
| ERROR_MESSAGE attribute | Set when mail_status = FAILED, contains the error |

A notification with status = OPEN, mail_status = NULL, and sent_date = NULL that is hours old means the mailer has not picked it up. Check mailer agent status next.

### Step 7 — Check Workflow Mailer Agent Status

\`\`\`sql
-- Check notification mailer service component status
SELECT component_name,
       component_status,
       startup_mode,
       last_update_date
FROM   fnd_svc_components
WHERE  component_name LIKE '%Mailer%'
   OR  component_name LIKE '%Notification%'
ORDER  BY component_name;
\`\`\`

If the mailer shows STOPPED or DEACTIVATED, it must be restarted from the Workflow Configuration page in EBS System Administrator responsibility, or via the Service Manager in Oracle Applications Manager.

### Step 8 — Check the WF_NOTIFICATION_OUT Agent Queue

The outbound agent queue (WF_NOTIFICATION_OUT) is where notifications wait before the mailer processes them. A large outbound queue means the mailer is not consuming messages fast enough.

\`\`\`sql
-- Messages waiting in the outbound notification agent
SELECT COUNT(*) AS pending_outbound
FROM   wf_notifications
WHERE  status     = 'OPEN'
  AND  mail_status IS NULL;
\`\`\`

On EBS 12.2 with Oracle AQ backing, also check V$AQ:

\`\`\`sql
-- AQ queue depth for notification agents
SELECT name,
       waiting,
       ready,
       processed,
       dequeued,
       time_of_last_dequeue
FROM   v$aq
WHERE  name IN ('WF_NOTIFICATION_OUT', 'WF_NOTIFICATION_IN', 'WF_DEFERRED')
ORDER  BY name;
\`\`\`

### Step 9 — Find Workflow Items in ERROR Status

ERROR items stop advancing but stay in the deferred queue, consuming resources on every sweep.

\`\`\`sql
-- Items in ERROR across all item types
SELECT ias.item_type,
       ias.item_key,
       ias.activity_status,
       ias.error_name,
       ias.error_message,
       ias.error_stack,
       ias.begin_date
FROM   wf_item_activity_statuses ias
WHERE  ias.activity_status = 'ERROR'
ORDER  BY ias.begin_date DESC
FETCH FIRST 50 ROWS ONLY;
\`\`\`

For each ERROR item, assess whether to retry, skip, or abort:

- **Retry**: WF_ENGINE.HandleError(item_type, item_key, activity, 'RETRY', null)
- **Skip**: WF_ENGINE.HandleError(item_type, item_key, activity, 'SKIP', null)
- **Abort**: WF_ENGINE.AbortProcess(item_type, item_key) — only when the underlying transaction is already canceled

### Step 10 — Manually Resend a Stuck Notification

If a specific NID is confirmed stuck (OPEN, mail_status NULL, old), you can reset it so the mailer picks it up again:

\`\`\`sql
-- Reset mail_status so mailer re-attempts delivery
-- Confirm NID first — only run after verifying notification_id
UPDATE wf_notifications
SET    mail_status = NULL,
       sent_date   = NULL
WHERE  notification_id = &nid
  AND  status          = 'OPEN';

COMMIT;
\`\`\`

After this update, the next mailer sweep will pick up the notification. Do not batch-reset large numbers of notifications at once — the mailer can saturate if thousands of notifications are requeued simultaneously.

---

## Monitoring

The goal of ongoing monitoring is to detect queue buildup and mailer stalls before users notice them. The following queries are suitable for OEM user-defined metrics or a simple scheduled alert script.

### Alert: Unsent Notification Count

\`\`\`sql
-- Returns notification count for alerting
-- Threshold: > 1000 = warning, > 5000 = critical
SELECT COUNT(*) AS open_notifications
FROM   wf_notifications
WHERE  status     = 'OPEN'
  AND  mail_status IS NULL;
\`\`\`

### Alert: Aged Notifications Over 4 Hours

\`\`\`sql
-- Notifications unsent for more than 4 hours (should be 0 in a healthy system)
SELECT COUNT(*) AS stale_notifications
FROM   wf_notifications
WHERE  status      = 'OPEN'
  AND  mail_status IS NULL
  AND  begin_date  < SYSDATE - (4/24);
\`\`\`

Target: zero. One or two aged notifications may indicate a delivery problem with a specific recipient. Dozens indicate a mailer stall.

### Alert: WF_DEFERRED Queue Depth

\`\`\`sql
-- Deferred queue depth
-- Threshold: > 500 = warning, > 2000 = critical
SELECT COUNT(*) AS deferred_count
FROM   wf_deferred;
\`\`\`

A growing deferred count with a flat or decreasing notification count means the Background Engine is congested but the mailer is working. Increasing both counts simultaneously means both are backed up.

### Alert: ERROR Item Count

\`\`\`sql
-- ERROR workflow items (should be 0 — any ERROR item needs investigation)
SELECT COUNT(*) AS error_count
FROM   wf_item_activity_statuses
WHERE  activity_status = 'ERROR';
\`\`\`

### Alert: Mailer Component Status

\`\`\`sql
-- Returns rows only when mailer is NOT running — suitable for alert trigger
SELECT component_name, component_status, last_update_date
FROM   fnd_svc_components
WHERE  component_name LIKE '%Notification Mailer%'
  AND  component_status != 'RUNNING';
\`\`\`

### Baseline Queries: Run Weekly

Run these weekly to establish normal ranges for your system:

\`\`\`sql
-- Weekly workflow health snapshot
SELECT 'open_notifications' AS metric, COUNT(*) AS value
FROM   wf_notifications WHERE status = 'OPEN' AND mail_status IS NULL
UNION ALL
SELECT 'deferred_count',             COUNT(*)
FROM   wf_deferred
UNION ALL
SELECT 'error_items',                COUNT(*)
FROM   wf_item_activity_statuses WHERE activity_status = 'ERROR'
UNION ALL
SELECT 'open_items_30d',             COUNT(*)
FROM   wf_items WHERE end_date IS NULL AND begin_date < SYSDATE - 30
ORDER  BY 1;
\`\`\`

Store these results in a simple monitoring table with a timestamp. After a few weeks you will have baseline values that make anomaly detection straightforward.

---

## Common Scenarios and Quick Fixes

### Scenario: All approvals suddenly stopped after a database restart

After a database restart, AQ agents and the workflow mailer do not always restart automatically.

1. Verify AQ agents are started: SELECT name, status FROM dba_queues WHERE name IN ('WF_NOTIFICATION_OUT', 'WF_DEFERRED');
2. If stopped: DBMS_AQADM.START_QUEUE('APPLSYS.WF_DEFERRED'); and similarly for WF_NOTIFICATION_OUT
3. Restart the Notification Mailer from Oracle Applications Manager → Service Components

### Scenario: One specific module's approvals are stuck, others work fine

The deferred and notification queues are shared, but activities are filtered by item type. If only POAPPRV items are stuck, look for a PL/SQL error in the approval function.

\`\`\`sql
-- ERROR activities for a specific item type
SELECT item_key, activity_result_code, error_name, error_message, begin_date
FROM   wf_item_activity_statuses
WHERE  item_type        = 'POAPPRV'
  AND  activity_status  = 'ERROR'
ORDER  BY begin_date DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

The error_message column usually identifies the exact PL/SQL exception. Common causes: missing employee supervisor record in HR, AME rule returning no approvers, or a customized PL/SQL function that raised an unhandled exception.

### Scenario: Notification count is 0 but approvers say they have not received emails

The notifications may have been sent to a different email address, delivered to spam, or sent to a role that has no email address configured.

\`\`\`sql
-- Check recipient email for a specific notification
SELECT wf_directory.getroleinfo('EMAIL', n.recipient_role) AS recipient_email,
       n.recipient_role,
       n.mail_status,
       n.sent_date
FROM   wf_notifications n
WHERE  n.notification_id = &nid;
\`\`\`

If recipient_email is null, the role has no email configured — the mailer will mark it sent but nothing is delivered. Update the FND_USER or WF_LOCAL_ROLES email for the user.

---

## Conclusion

EBS Workflow performance problems are diagnostic problems — the data is there in the database, and the queries in this post will surface it within seconds. Start with the notification count. If the count is large or old notifications exist, the mailer is stalled. If the count is zero but items are not advancing, the deferred queue or Background Engine is the problem. Once you have a NID, every attribute of the notification and its parent workflow item is a single join away.

The monitoring queries are simple enough to implement in OEM user-defined metrics with alert thresholds. Set them up before a problem occurs, and the next Workflow performance incident will resolve itself before the first user calls.
`,
};

async function main() {
  await db.insert(posts).values(post);
  console.log('Inserted:', post.slug);
}

main().catch(console.error);
