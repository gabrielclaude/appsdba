import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'EBS Business Event System Runbook: Subscriptions, AQ Monitoring, Error Recovery, and Custom Events',
  slug: 'ebs-workflow-business-events-runbook',
  excerpt:
    'Step-by-step runbook for administering the Oracle EBS Business Event System. Covers subscription creation and testing, AQ queue depth monitoring for WF_IN/WF_OUT/WF_DEFERRED/WF_ERROR agents, deferred event processing diagnosis, error queue retry procedures, AQ propagation verification, custom event registration, and performance tuning for high-volume event environments.',
  category: 'ebs-workflow' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `## Overview

This runbook covers day-to-day administration and troubleshooting of the Oracle EBS Business Event System (BES). It applies to EBS 12.1.x and 12.2.x environments. All queries run as the APPS schema user unless noted otherwise.

**Prerequisites:** APPS schema access, SELECT on AQ queue tables (requires DBA or AQ_ADMINISTRATOR_ROLE for some queries), Workflow Administrator Web Application access for UI-based operations.

---

## Phase 1: Baseline Health Check

Run these queries at the start of any BES investigation to establish the state of the system.

### 1.1 Count Events in Each Agent Queue

\`\`\`sql
-- Queue depth for all BES-related AQ queues
SELECT q.name              AS queue_name,
       q.queue_table,
       NVL(qs.waiting, 0)  AS waiting,
       NVL(qs.ready, 0)    AS ready,
       NVL(qs.expired, 0)  AS expired,
       NVL(qs.total_wait, 0) AS total_wait_seconds
FROM   dba_queues q
LEFT JOIN v$aq qs ON qs.qname = q.name
                 AND qs.inst_id = USERENV('INSTANCE')
WHERE  q.name IN (
         'WF_IN', 'WF_OUT', 'WF_DEFERRED',
         'WF_CONTROL', 'WF_ERROR', 'WF_JAVA_IN', 'WF_JAVA_ERROR'
       )
ORDER  BY q.name;
\`\`\`

**Healthy baselines:**
- WF_DEFERRED: Should drain to near-zero within minutes of events being raised (requires Background Process to be running)
- WF_OUT: Should drain continuously if AQ propagation or an SOA adapter is consuming it
- WF_ERROR: Should be zero; any non-zero count requires investigation
- WF_IN: Should drain continuously if inbound event subscriptions are processing

### 1.2 Identify Enabled Subscriptions by Event

\`\`\`sql
SELECT we.name              AS event_name,
       we.status            AS event_status,
       wes.phase,
       wes.action_type,
       wes.rule_function,
       wes.wf_process_type,
       wes.wf_process_name,
       wes.on_error_code,
       wes.status           AS subscription_status,
       wes.description
FROM   wf_event_subscriptions wes
JOIN   wf_events we ON we.guid = wes.event_guid
WHERE  wes.status  = 'ENABLED'
AND    we.status   = 'ENABLED'
ORDER  BY we.name, wes.phase;
\`\`\`

### 1.3 Verify the Workflow Background Process Is Running

\`\`\`sql
SELECT request_id,
       status_code,
       phase_code,
       argument1       AS item_type,
       argument5       AS process_deferred,
       argument6       AS process_timeout,
       argument7       AS process_stuck,
       TO_CHAR(actual_start_date, 'YYYY-MM-DD HH24:MI:SS')      AS last_start,
       TO_CHAR(actual_completion_date, 'YYYY-MM-DD HH24:MI:SS') AS last_end,
       TO_CHAR(requested_start_date, 'YYYY-MM-DD HH24:MI:SS')   AS next_scheduled
FROM   fnd_concurrent_requests
WHERE  program_short_name = 'FNDWFBG'
ORDER  BY request_id DESC
FETCH  FIRST 5 ROWS ONLY;
\`\`\`

If STATUS_CODE is not 'I' (Inactive-Scheduled) for the next pending run, the Background Process is not keeping up with deferred events. Submit a new request per Phase 7.

### 1.4 Check AQ Propagation Jobs

AQ propagation moves messages from local outbound queues (WF_OUT) to remote queues on external systems. A stopped propagation job silently accumulates messages in WF_OUT.

\`\`\`sql
SELECT p.queue_name,
       p.destination,
       p.status,
       p.schedule_type,
       p.latency,
       p.last_run_date,
       p.total_msgs,
       p.total_bytes
FROM   dba_queue_schedules p
WHERE  p.queue_name LIKE 'WF%'
ORDER  BY p.queue_name;
\`\`\`

Status should be ENABLED for active propagation links. DISABLED means propagation was explicitly stopped; check with the integration team before re-enabling.

---

## Phase 2: Diagnose Failed or Missing Events

### 2.1 Inspect the WF_ERROR Queue

Events land in WF_ERROR when a subscription's ON_ERROR_CODE is ERROR and the subscription handler returned 'ERROR' or raised an exception.

\`\`\`sql
-- View events currently in WF_ERROR (requires SELECT on the AQ queue table)
SELECT msgid,
       enq_time,
       msg_state,
       consumer_name,
       queue
FROM   apps.aq$wf_error_t
WHERE  msg_state = 'READY'
ORDER  BY enq_time;
\`\`\`

For the event details (name, key, error message):

\`\`\`sql
-- Read WF_ERROR event content via the WF_EVENT_T payload
SELECT e.msgid,
       e.enq_time,
       t.event_name,
       t.event_key,
       t.error_name,
       t.error_message,
       t.error_stack
FROM   apps.aq$wf_error_t e,
       TABLE(CAST(e.user_data.parameter_list AS wf_parameter_list_t)) t
WHERE  ROWNUM <= 20;
\`\`\`

If the AQ object type query is not available in your environment, use the BES Error Queue UI:
1. EBS > Workflow Administrator Web Applications > Business Events
2. Select **Event Error Queue**
3. Filter by event name or time range

### 2.2 Trace a Specific Event Through the System

When a business event was raised but a downstream system did not receive it, trace the event by its key:

\`\`\`sql
-- Check WF_DEFERRED for unprocessed events
SELECT msgid,
       enq_time,
       msg_state,
       delay
FROM   apps.aq$wf_deferred_t
WHERE  user_data.event_key = '&EVENT_KEY'
ORDER  BY enq_time;
\`\`\`

\`\`\`sql
-- Check WF_OUT for events awaiting propagation to external system
SELECT msgid,
       enq_time,
       msg_state,
       delay
FROM   apps.aq$wf_out_t
WHERE  user_data.event_key = '&EVENT_KEY'
ORDER  BY enq_time;
\`\`\`

\`\`\`sql
-- Check WF_ERROR for events that failed subscription processing
SELECT msgid,
       enq_time,
       user_data.event_name,
       user_data.event_key,
       user_data.error_message
FROM   apps.aq$wf_error_t
WHERE  user_data.event_key = '&EVENT_KEY';
\`\`\`

If the event appears in none of these queues and no custom audit table captures it, the event may not have been raised. Check the application code path for the transaction in question.

### 2.3 Verify an Event Was Raised (Application Log Check)

For events that should have been raised by a specific EBS transaction:

\`\`\`sql
-- Check if the event exists in EBS and is enabled
SELECT name, status, owner_name, generate_function
FROM   wf_events
WHERE  name = '&EVENT_NAME';

-- Check that at least one ENABLED subscription exists
SELECT COUNT(*) AS enabled_subscriptions
FROM   wf_event_subscriptions wes
JOIN   wf_events we ON we.guid = wes.event_guid
WHERE  we.name     = '&EVENT_NAME'
AND    wes.status  = 'ENABLED';
\`\`\`

If the event is DISABLED or has zero enabled subscriptions, no processing will occur even if the raise call executes.

---

## Phase 3: Retry Failed Events from WF_ERROR

### 3.1 Retry a Single Event via the UI

1. Log in with Workflow Administrator responsibility
2. Navigate to **Workflow Administrator Web Applications > Business Events > Event Error Queue**
3. Find the failed event by name or key
4. Click **Retry** — this dequeues the event from WF_ERROR and re-enqueues it to WF_DEFERRED for reprocessing

### 3.2 Retry Events Programmatically

\`\`\`sql
-- Retry all events in WF_ERROR for a specific event name
DECLARE
  l_event  WF_EVENT_T;
  l_msgid  RAW(16);
  l_dequeue_options    DBMS_AQ.DEQUEUE_OPTIONS_T;
  l_message_properties DBMS_AQ.MESSAGE_PROPERTIES_T;
BEGIN
  l_dequeue_options.wait       := DBMS_AQ.NO_WAIT;
  l_dequeue_options.navigation := DBMS_AQ.FIRST_MESSAGE;

  LOOP
    BEGIN
      DBMS_AQ.DEQUEUE(
        queue_name         => 'APPS.WF_ERROR',
        dequeue_options    => l_dequeue_options,
        message_properties => l_message_properties,
        payload            => l_event,
        msgid              => l_msgid
      );

      IF l_event.event_name = '&EVENT_NAME' THEN
        -- Clear the error info and re-raise for reprocessing
        l_event.setErrorInfo(l_event, NULL);
        WF_EVENT.Raise(
          p_event_name => l_event.event_name,
          p_event_key  => l_event.event_key,
          p_event_data => l_event.event_data,
          p_parameters => l_event.parameter_list
        );
        DBMS_OUTPUT.PUT_LINE('Re-raised: ' || l_event.event_key);
      END IF;

      COMMIT;
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLCODE = -25228 THEN EXIT; END IF;  -- No more messages
        DBMS_OUTPUT.PUT_LINE('Error: ' || SQLERRM);
        ROLLBACK;
    END;
  END LOOP;
END;
/
\`\`\`

### 3.3 Abort an Event (Remove from Error Queue Without Retry)

When an event in WF_ERROR is stale or caused by a transient issue that has since been resolved by other means, remove it without reprocessing:

\`\`\`sql
-- Abort a specific event from WF_ERROR by msgid
BEGIN
  WF_EVENT.discard(
    p_event       => NULL,
    p_agent_name  => 'WF_ERROR',
    p_agent_system => NULL,
    p_msgid       => HEXTORAW('&MSGID')  -- from aq$wf_error_t.msgid
  );
  COMMIT;
END;
/
\`\`\`

---

## Phase 4: Create a New Subscription

### 4.1 Register a PL/SQL Function Subscription

\`\`\`sql
BEGIN
  WF_EVENT.AddSubscription(
    p_guid              => SYS_GUID(),
    p_system_guid       => WF_EVENT.LOCAL_SYSTEM_GUID,
    p_source_type       => 'LOCAL',
    p_source_agent_guid => NULL,
    p_event_guid        => (
                             SELECT guid
                             FROM   wf_events
                             WHERE  name = 'oracle.apps.po.event.approved'
                           ),
    p_phase             => 100,         -- phase 1-99 = synchronous; 100+ = deferred
    p_status            => 'ENABLED',
    p_rule_function     => 'WF_RULE.DEFAULT_RULE',
    p_out_agent_guid    => NULL,
    p_to_agent_guid     => NULL,
    p_priority          => NULL,
    p_rule_data         => 'MESSAGE',
    p_action_type       => 'FUNCTION',
    p_action            => 'CUSTOM.LOG_PO_APPROVAL',  -- your PL/SQL handler
    p_on_error_code     => 'SKIP',
    p_description       => 'Log PO approvals to custom audit table',
    p_wf_process_type   => NULL,
    p_wf_process_name   => NULL,
    p_owner_name        => 'CUSTOM',
    p_owner_tag         => 'CUSTOM',
    p_customization_level => 'U'
  );
  COMMIT;
  DBMS_OUTPUT.PUT_LINE('Subscription created');
END;
/
\`\`\`

**Phase values:**
- Phase 1–49: Synchronous, executes in the raising transaction's session (use sparingly — errors rollback the parent transaction)
- Phase 50–99: Synchronous, after the raising transaction commits
- Phase 100+: Deferred, processed asynchronously by the Workflow Background Process

### 4.2 Register a Workflow Launch Subscription

\`\`\`sql
BEGIN
  WF_EVENT.AddSubscription(
    p_guid              => SYS_GUID(),
    p_system_guid       => WF_EVENT.LOCAL_SYSTEM_GUID,
    p_source_type       => 'LOCAL',
    p_source_agent_guid => NULL,
    p_event_guid        => (SELECT guid FROM wf_events WHERE name = 'oracle.apps.per.employee.hire'),
    p_phase             => 100,
    p_status            => 'ENABLED',
    p_rule_function     => 'WF_RULE.DEFAULT_RULE',
    p_out_agent_guid    => NULL,
    p_to_agent_guid     => NULL,
    p_priority          => NULL,
    p_rule_data         => 'MESSAGE',
    p_action_type       => 'WORKFLOW',
    p_action            => NULL,
    p_on_error_code     => 'ERROR',
    p_description       => 'Launch onboarding workflow on new hire',
    p_wf_process_type   => 'CUSTOM_ONBOARD',   -- workflow item type name
    p_wf_process_name   => 'NEW_HIRE_PROCESS', -- process name in the item type
    p_owner_name        => 'CUSTOM',
    p_owner_tag         => 'CUSTOM',
    p_customization_level => 'U'
  );
  COMMIT;
END;
/
\`\`\`

### 4.3 Register an Outbound Message Subscription (Send to External System)

\`\`\`sql
BEGIN
  WF_EVENT.AddSubscription(
    p_guid              => SYS_GUID(),
    p_system_guid       => WF_EVENT.LOCAL_SYSTEM_GUID,
    p_source_type       => 'LOCAL',
    p_source_agent_guid => NULL,
    p_event_guid        => (SELECT guid FROM wf_events WHERE name = 'oracle.apps.ap.invoice.validated'),
    p_phase             => 100,
    p_status            => 'ENABLED',
    p_rule_function     => 'WF_RULE.DEFAULT_RULE',
    p_out_agent_guid    => (SELECT guid FROM wf_agents WHERE name = 'WF_OUT'),
    p_to_agent_guid     => (SELECT guid FROM wf_agents WHERE name = 'EXTERNAL_ERP_IN'),
    p_priority          => NULL,
    p_rule_data         => 'MESSAGE',
    p_action_type       => 'MESSAGE',
    p_action            => NULL,
    p_on_error_code     => 'ERROR',
    p_description       => 'Send validated invoice event to downstream ERP',
    p_wf_process_type   => NULL,
    p_wf_process_name   => NULL,
    p_owner_name        => 'CUSTOM',
    p_owner_tag         => 'CUSTOM',
    p_customization_level => 'U'
  );
  COMMIT;
END;
/
\`\`\`

---

## Phase 5: Test an Event Subscription

### 5.1 Raise an Event Manually for Testing

\`\`\`sql
-- Raise a test event with a synthetic key and parameter list
DECLARE
  l_params WF_PARAMETER_LIST_T := WF_PARAMETER_LIST_T();
BEGIN
  l_params.EXTEND;
  l_params(1) := WF_PARAMETER_T('TEST_PARAM', 'TEST_VALUE');

  WF_EVENT.Raise(
    p_event_name  => 'oracle.apps.po.event.approved',
    p_event_key   => 'TEST-' || TO_CHAR(SYSDATE, 'YYYYMMDDHH24MISS'),
    p_event_data  => NULL,
    p_parameters  => l_params
  );
  COMMIT;
  DBMS_OUTPUT.PUT_LINE('Test event raised at ' || TO_CHAR(SYSDATE, 'HH24:MI:SS'));
END;
/
\`\`\`

### 5.2 Confirm the Event Reached WF_DEFERRED

\`\`\`sql
-- Check WF_DEFERRED queue depth immediately after raising
SELECT COUNT(*) AS pending_in_deferred
FROM   apps.aq$wf_deferred_t
WHERE  msg_state = 'READY';
\`\`\`

### 5.3 Force-Process WF_DEFERRED (Without Waiting for Background Process)

\`\`\`sql
-- Process all deferred events immediately (use in non-production for testing)
BEGIN
  WF_ENGINE.BACKGROUND(
    itemtype        => NULL,        -- NULL = process all item types
    minthreshold    => NULL,
    maxthreshold    => NULL,
    process_deferred => TRUE,
    process_timeout  => FALSE,
    process_stuck    => FALSE
  );
  COMMIT;
  DBMS_OUTPUT.PUT_LINE('Deferred events processed at ' || TO_CHAR(SYSDATE, 'HH24:MI:SS'));
END;
/
\`\`\`

### 5.4 Confirm Subscription Handler Executed

If the subscription writes to a custom table, query it. If it launches a workflow, check WF_ITEMS:

\`\`\`sql
-- Check if a workflow was launched by the subscription
SELECT item_type,
       item_key,
       user_key,
       begin_date
FROM   wf_items
WHERE  item_type = 'CUSTOM_ONBOARD'  -- substitute your item type
ORDER  BY begin_date DESC
FETCH  FIRST 5 ROWS ONLY;
\`\`\`

---

## Phase 6: Register a Custom Business Event

### 6.1 Create the Generate Function

The generate function builds the XML payload when BES needs to serialize the event (e.g., for outbound message subscriptions):

\`\`\`sql
CREATE OR REPLACE FUNCTION CUSTOM.GENERATE_ORDER_EXPORT_EVENT(
  p_event_name IN VARCHAR2,
  p_event_key  IN VARCHAR2
) RETURN CLOB AS
  l_clob  CLOB;
  l_xmldoc DBMS_XMLDOM.DOMDocument;
BEGIN
  -- Build XML payload from the order identified by p_event_key
  SELECT XMLSERIALIZE(CONTENT
    XMLELEMENT("ORDER_EXPORT",
      XMLELEMENT("ORDER_ID",   oel.header_id),
      XMLELEMENT("ORDER_NUM",  oeh.order_number),
      XMLELEMENT("STATUS",     oeh.flow_status_code),
      XMLELEMENT("EXPORTED_DATE", TO_CHAR(SYSDATE, 'YYYY-MM-DD"T"HH24:MI:SS'))
    )
    AS CLOB INDENT
  )
  INTO  l_clob
  FROM  oe_order_headers_all oeh
  JOIN  oe_order_lines_all   oel ON oel.header_id = oeh.header_id
  WHERE oeh.header_id = TO_NUMBER(p_event_key)
  AND   ROWNUM = 1;

  RETURN l_clob;
EXCEPTION
  WHEN OTHERS THEN
    RETURN '<ERROR>' || SQLERRM || '</ERROR>';
END;
/
\`\`\`

### 6.2 Register the Event

\`\`\`sql
BEGIN
  WF_EVENT.AddEvent(
    p_name                => 'custom.apps.om.order.exported',
    p_display_name        => 'Custom: OM Order Exported to 3PL',
    p_description         => 'Raised when an OM order is successfully exported to 3PL system',
    p_status              => 'ENABLED',
    p_generate_func       => 'CUSTOM.GENERATE_ORDER_EXPORT_EVENT',
    p_owner_name          => 'CUSTOM',
    p_owner_tag           => 'CUSTOM',
    p_customization_level => 'U',
    p_licensed_flag       => 'N'
  );
  COMMIT;

  -- Verify registration
  SELECT name, status, generate_function
  FROM   wf_events
  WHERE  name = 'custom.apps.om.order.exported';
END;
/
\`\`\`

### 6.3 Grant Execute on the Generate Function to APPS

\`\`\`sql
GRANT EXECUTE ON CUSTOM.GENERATE_ORDER_EXPORT_EVENT TO APPS;
\`\`\`

---

## Phase 7: Schedule and Tune the Workflow Background Process

### 7.1 Submit the Background Process for Deferred Event Processing

In System Administrator responsibility:

1. Navigate to **Concurrent > Requests > Submit**
2. Program: **Workflow Background Process**
3. Parameters:
   - Item Type: blank (process all) or a specific item type
   - Minimum Threshold: 0
   - Maximum Threshold: 100
   - Process Deferred: **Yes**
   - Process Timeout: Yes
   - Process Stuck: No (run separately on a slower schedule)
4. Schedule: Periodically, every **1 minute** for event-heavy environments; every 5 minutes for moderate load
5. Submit

### 7.2 Monitor Deferred Queue Drain Rate

\`\`\`sql
-- Run every minute during a load test to observe drain rate
SELECT TO_CHAR(SYSDATE, 'HH24:MI:SS') AS sample_time,
       COUNT(*)                        AS messages_in_deferred
FROM   apps.aq$wf_deferred_t
WHERE  msg_state = 'READY';
\`\`\`

If the count grows rather than drains, either:
- The Background Process is not running frequently enough — decrease the schedule interval
- A subscription handler is slow or deadlocking — check the APPS session for long-running processes during Background Process execution

### 7.3 Identify Slow Subscription Handlers

\`\`\`sql
-- Find the slowest subscription function calls from v$session during Background Process runs
SELECT sql_id,
       elapsed_time / 1000000   AS elapsed_seconds,
       executions,
       sql_text
FROM   v$sql
WHERE  sql_text LIKE '%WF_EVENT%'
OR     sql_text LIKE '%CUSTOM.%'
ORDER  BY elapsed_time DESC
FETCH  FIRST 10 ROWS ONLY;
\`\`\`

---

## Phase 8: Disable and Enable Subscriptions

### 8.1 Disable a Subscription

\`\`\`sql
-- Disable by subscription GUID (from WF_EVENT_SUBSCRIPTIONS)
BEGIN
  UPDATE wf_event_subscriptions
  SET    status = 'DISABLED'
  WHERE  guid = HEXTORAW('&SUBSCRIPTION_GUID');
  COMMIT;
  DBMS_OUTPUT.PUT_LINE('Subscription disabled');
END;
/
\`\`\`

To find the GUID of a specific subscription:

\`\`\`sql
SELECT wes.guid,
       we.name AS event_name,
       wes.action_type,
       wes.rule_function,
       wes.description
FROM   wf_event_subscriptions wes
JOIN   wf_events we ON we.guid = wes.event_guid
WHERE  we.name = '&EVENT_NAME';
\`\`\`

### 8.2 Enable a Subscription

\`\`\`sql
BEGIN
  UPDATE wf_event_subscriptions
  SET    status = 'ENABLED'
  WHERE  guid = HEXTORAW('&SUBSCRIPTION_GUID');
  COMMIT;
END;
/
\`\`\`

---

## Phase 9: Verify AQ Propagation to External Systems

### 9.1 Check Propagation Schedule Status

\`\`\`sql
SELECT queue_name,
       destination,
       status,
       schedule_type,
       next_run_date,
       latency,
       failures,
       last_error_date,
       last_error_msg
FROM   dba_queue_schedules
WHERE  queue_name IN ('WF_OUT', 'WF_JAVA_OUT')
ORDER  BY queue_name;
\`\`\`

If FAILURES > 0 or STATUS is DISABLED:

\`\`\`sql
-- Re-enable a stopped propagation schedule
BEGIN
  DBMS_AQADM.ENABLE_PROPAGATION_SCHEDULE(
    queue_name  => 'APPS.WF_OUT',
    destination => '&REMOTE_DB_LINK'  -- the DB link to the remote AQ or SOA queue
  );
  COMMIT;
END;
/
\`\`\`

### 9.2 Manually Propagate Messages (One-Time Flush)

\`\`\`sql
BEGIN
  DBMS_AQADM.SCHEDULE_PROPAGATION(
    queue_name     => 'APPS.WF_OUT',
    destination    => '&REMOTE_DB_LINK',
    start_time     => SYSDATE,
    latency        => 0,
    duration       => NULL
  );
  COMMIT;
END;
/
\`\`\`

---

## Summary

| Problem | Diagnosis | Phase |
|---------|-----------|-------|
| Downstream system not receiving events | WF_OUT queue depth; AQ propagation status | 1.4, 9.1 |
| Events raised but not processed | WF_DEFERRED queue depth; Background Process schedule | 1.1, 1.3 |
| Events failing subscription handler | WF_ERROR queue content; error_message column | 2.1, 2.2 |
| Specific event never appears in any queue | Check event ENABLED; check subscription ENABLED | 2.3 |
| Outbound event stuck in WF_OUT | AQ propagation failures or disabled schedule | 9.1, 9.2 |
| Background Process not draining WF_DEFERRED | Schedule frequency; slow handler causing lock | 7.1, 7.2, 7.3 |
| New integration needs event trigger | Create subscription (Phase 4); test (Phase 5) | 4, 5 |
| Custom business process needs its own event | Register event and generate function | Phase 6 |
| Need to stop processing during maintenance | Disable subscriptions | Phase 8 |`,
};

async function main() {
  console.log('Inserting EBS Workflow Business Events runbook...');
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
