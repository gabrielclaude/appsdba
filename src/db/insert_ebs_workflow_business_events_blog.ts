import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS Workflow Business Events: Architecture, Subscriptions, and Integration Patterns',
  slug: 'oracle-ebs-workflow-business-events-architecture-subscriptions',
  excerpt:
    'Oracle EBS Business Event System (BES) is the publish-subscribe backbone of EBS integration — every significant state change in the application raises a business event that external systems, workflow processes, and custom PL/SQL handlers can subscribe to. Understanding how events are defined, raised, routed through Oracle Advanced Queuing agents, and consumed by subscriptions is essential for building reliable EBS integrations and diagnosing broken event flows.',
  category: 'ebs-workflow' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `## Introduction

Oracle EBS ships with over 2,000 pre-defined business events — named signals that fire whenever something significant happens in the application. A purchase order is approved. A supplier invoice is validated. A new employee is hired. A GL journal batch is posted. Each of these state changes raises a business event through the Business Event System (BES), a publish-subscribe messaging infrastructure built into Oracle Workflow.

The Business Event System is the correct integration point for EBS. When you need to notify an external system that a PO was approved, trigger a custom workflow when an invoice is created, or synchronize HR data to a downstream HCM platform, the right approach is to subscribe to the relevant business event — not to poll tables, not to build batch extracts, and not to call EBS APIs directly from external systems on a schedule.

Understanding BES is understanding how EBS is meant to be integrated. This guide covers the architecture, the key components, how events flow from the raising application through Oracle Advanced Queuing to subscriptions, and the integration patterns that make BES effective at scale.

---

## The Business Event System Architecture

The Business Event System has three core concepts:

**Events**: Named signals representing a specific state change. An event name follows a dotted reverse-domain convention, e.g., \`oracle.apps.po.event.approved\`. Events are defined in the WF_EVENTS table and carry a payload — an XML document called the event data — that describes the specific instance of the state change (which PO was approved, by whom, at what time).

**Agents**: Named queues that carry events between systems. Agents are backed by Oracle Advanced Queuing (AQ) queues in the database. The primary local agents are WF_IN (inbound from external systems), WF_OUT (outbound to external systems), and WF_DEFERRED (events deferred for asynchronous subscription processing). External agents represent queues on remote systems — Oracle SOA Suite, Oracle Integration Cloud, or any JMS-compliant message broker.

**Subscriptions**: Rules that say "when event X is raised on agent Y, execute action Z." An action can be a PL/SQL function, a workflow process launch, a message send to an outbound agent, or a Java function call. Multiple subscriptions can respond to the same event. Subscriptions are defined in WF_EVENT_SUBSCRIPTIONS.

### How an Event Flows

\`\`\`
EBS Application Code
  → WF_EVENT.Raise('oracle.apps.po.event.approved', event_key, event_data)
      → BES evaluates all subscriptions for this event
          → Synchronous subscriptions execute immediately in the same session
          → Deferred subscriptions enqueue to WF_DEFERRED agent (AQ queue)
              → Workflow Background Process dequeues WF_DEFERRED
              → Subscription action executes (PL/SQL, workflow launch, outbound message)
          → External-send subscriptions enqueue to WF_OUT agent
              → Oracle AQ propagation (or SOA adapter) moves message to external queue
\`\`\`

The raising application does not wait for subscription processing unless the subscription is configured as synchronous. This is the architectural guarantee that makes BES safe to embed in transactional EBS code — raising an event adds microseconds to the transaction, not the full execution time of all subscribers.

---

## The Key Database Objects

### WF_EVENTS

The event registry. Each row defines one event by name, GUID, owner application, and status.

\`\`\`sql
SELECT name,
       display_name,
       owner_name,
       status,
       generate_function,
       java_generate_func
FROM   wf_events
WHERE  status = 'ENABLED'
AND    name LIKE 'oracle.apps.po%'
ORDER  BY name;
\`\`\`

Important columns:
- **NAME**: The dotted event name (the primary key for subscription matching)
- **GENERATE_FUNCTION**: PL/SQL function that produces the XML event data payload when called
- **STATUS**: ENABLED or DISABLED — disabled events are not raised

### WF_EVENT_SUBSCRIPTIONS

Every subscription is a row in this table.

\`\`\`sql
SELECT wes.guid,
       we.name              AS event_name,
       wes.source_type,
       wes.source_agent_guid,
       wes.rule_function,
       wes.action_type,
       wes.wf_process_type,
       wes.wf_process_name,
       wes.out_agent_guid,
       wes.phase,
       wes.status,
       wes.on_error_code
FROM   wf_event_subscriptions wes
JOIN   wf_events we ON we.guid = wes.event_guid
WHERE  wes.status = 'ENABLED'
AND    we.name LIKE 'oracle.apps.po%'
ORDER  BY we.name, wes.phase;
\`\`\`

Key columns:
- **PHASE**: Execution order among subscriptions for the same event (lower phase = earlier)
- **ACTION_TYPE**: FUNCTION (PL/SQL), WORKFLOW (launch a process), MESSAGE (send to agent), ERROR (error handler), JAVA (Java class)
- **ON_ERROR_CODE**: What to do if the subscription fails — SKIP, STOP, or ERROR
- **SOURCE_TYPE**: LOCAL (event raised on a local agent), EXTERNAL (event received from external system), ERROR (event in the error queue)

### WF_AGENTS

Named queues. Each agent maps to an Oracle AQ queue.

\`\`\`sql
SELECT wa.name,
       wa.display_name,
       wa.system_guid,
       wa.protocol,
       wa.address,
       wa.queue_handler,
       wa.inbound_agent_flag,
       wa.outbound_agent_flag,
       wa.status
FROM   wf_agents wa
WHERE  wa.status = 'ENABLED'
ORDER  BY wa.name;
\`\`\`

Standard local agents in every EBS installation:

| Agent Name | Direction | Purpose |
|-----------|-----------|---------|
| WF_IN | Inbound | Receive events from external systems |
| WF_OUT | Outbound | Send events to external systems |
| WF_DEFERRED | Internal | Queue deferred subscription processing |
| WF_CONTROL | Internal | Workflow engine control messages |
| WF_ERROR | Internal | Failed events pending retry or manual handling |

---

## Standard EBS Business Events by Module

Oracle ships thousands of pre-defined events. The most commonly subscribed-to events by module:

### Purchasing

| Event Name | Trigger |
|-----------|---------|
| oracle.apps.po.event.approved | PO approved (any document type) |
| oracle.apps.po.event.rejected | PO rejected by approver |
| oracle.apps.po.event.submitted | PO submitted for approval |
| oracle.apps.po.requisition.approve | Requisition approved |
| oracle.apps.rcv.receive | Goods receipt created |

### Payables

| Event Name | Trigger |
|-----------|---------|
| oracle.apps.ap.invoice.created | Invoice created (any method) |
| oracle.apps.ap.invoice.validated | Invoice validation run completed |
| oracle.apps.ap.payment.created | Payment batch created |
| oracle.apps.ap.supplier.created | New supplier created in TCA |

### Human Resources

| Event Name | Trigger |
|-----------|---------|
| oracle.apps.per.employee.hire | New hire transaction completed |
| oracle.apps.per.employee.terminate | Termination processed |
| oracle.apps.per.assignment.update | Assignment change (position, grade, org) |
| oracle.apps.per.salary.update | Salary change approved |

### General Ledger

| Event Name | Trigger |
|-----------|---------|
| oracle.apps.gl.batch.posted | Journal batch posted successfully |
| oracle.apps.gl.period.closed | Accounting period closed |

### Order Management

| Event Name | Trigger |
|-----------|---------|
| oracle.apps.ont.salesorder.created | Sales order created |
| oracle.apps.ont.salesorder.booked | Sales order booked |
| oracle.apps.ont.line.shipped | Order line shipped |

---

## Event Data: The XML Payload

When an event is raised, the application (or the event's GENERATE_FUNCTION) produces an XML document that travels with the event through the queuing system. This payload contains the instance-specific data a subscriber needs to process the event.

For a PO approval event, the payload might include:

\`\`\`xml
<PO_DOCUMENT>
  <HEADER>
    <PO_HEADER_ID>123456</PO_HEADER_ID>
    <SEGMENT1>PO-2026-001</SEGMENT1>
    <VENDOR_ID>5001</VENDOR_ID>
    <APPROVED_DATE>2026-06-16</APPROVED_DATE>
    <TOTAL_AMOUNT>45000.00</TOTAL_AMOUNT>
    <CURRENCY_CODE>USD</CURRENCY_CODE>
    <APPROVED_BY>JSMITH</APPROVED_BY>
  </HEADER>
</PO_DOCUMENT>
\`\`\`

Subscribers access this payload through the event object passed to their PL/SQL function. The event object type is WF_EVENT_T, a PL/SQL object with methods including:

- \`event.getEventName()\` — the event name string
- \`event.getEventKey()\` — the unique instance identifier
- \`event.getEventData()\` — the XML CLOB payload
- \`event.getParameterList()\` — a name-value parameter list attached to the event
- \`event.getAttribute('PARAM_NAME')\` — retrieve a specific parameter value

---

## Subscription Action Types

### PL/SQL Function Subscription

The most common action type. When the event fires, BES calls a PL/SQL function with the signature:

\`\`\`sql
FUNCTION my_subscription_handler(
  p_subscription_guid IN RAW,
  p_event             IN OUT NOCOPY WF_EVENT_T
) RETURN VARCHAR2
\`\`\`

The function must return \`'SUCCESS'\` to indicate successful processing, or \`'ERROR'\` to trigger the subscription's ON_ERROR_CODE behavior.

Example — a handler that logs PO approval events to a custom audit table:

\`\`\`sql
CREATE OR REPLACE FUNCTION CUSTOM.LOG_PO_APPROVAL(
  p_subscription_guid IN RAW,
  p_event             IN OUT NOCOPY WF_EVENT_T
) RETURN VARCHAR2 AS
  l_po_header_id   NUMBER;
  l_event_data     CLOB;
  l_xml            XMLTYPE;
BEGIN
  l_event_data   := p_event.getEventData();
  l_xml          := XMLTYPE(l_event_data);

  SELECT EXTRACTVALUE(l_xml, '/PO_DOCUMENT/HEADER/PO_HEADER_ID')
  INTO   l_po_header_id
  FROM   DUAL;

  INSERT INTO custom_po_approval_log (
    po_header_id, event_key, approved_date, logged_by
  ) VALUES (
    l_po_header_id,
    p_event.getEventKey(),
    SYSDATE,
    p_event.getAttribute('APPROVED_BY')
  );
  COMMIT;

  RETURN 'SUCCESS';
EXCEPTION
  WHEN OTHERS THEN
    WF_CORE.CONTEXT('CUSTOM', 'LOG_PO_APPROVAL', p_event.getEventKey());
    WF_EVENT.setErrorInfo(p_event, 'ERROR');
    RETURN 'ERROR';
END;
/
\`\`\`

### Workflow Process Launch Subscription

When the subscription action type is WORKFLOW, BES launches a new workflow process instance and passes the event as an item attribute. The workflow item type and process name are specified in the subscription. This is the standard pattern for triggering approval workflows from business events.

### Outbound Message Subscription

When action type is MESSAGE and an outbound agent is configured, BES serializes the event into the outbound queue (WF_OUT or a remote agent). Oracle AQ propagation then moves the message from WF_OUT to a remote queue on an external system. Oracle SOA Suite's EBS adapter uses this mechanism to consume EBS events in SOA composite applications.

---

## Raising a Custom Business Event

Oracle allows custom events to be raised alongside standard EBS events. A custom event follows the same architecture: define the event, create a generate function for the payload, raise it from application code, and subscribe to it.

### Defining a Custom Event

\`\`\`sql
-- Register a custom event in the BES registry
DECLARE
  l_guid RAW(16) := SYS_GUID();
BEGIN
  WF_EVENT.AddEvent(
    p_name             => 'custom.apps.mymodule.order.exported',
    p_display_name     => 'Custom: Order Exported to 3PL',
    p_description      => 'Raised when a sales order is exported to the 3PL system',
    p_status           => 'ENABLED',
    p_generate_func    => 'CUSTOM.GENERATE_ORDER_EXPORTED_EVENT',
    p_owner_name       => 'CUSTOM',
    p_owner_tag        => 'CUSTOM',
    p_customization_level => 'U',
    p_licensed_flag    => 'N'
  );
  COMMIT;
  DBMS_OUTPUT.PUT_LINE('Event registered');
END;
/
\`\`\`

### Raising the Event from Application Code

\`\`\`sql
DECLARE
  l_event_data CLOB;
  l_param_list WF_PARAMETER_LIST_T := WF_PARAMETER_LIST_T();
BEGIN
  -- Build the event parameter list (lightweight alternative to XML payload)
  l_param_list.EXTEND;
  l_param_list(l_param_list.LAST) := WF_PARAMETER_T('ORDER_ID', TO_CHAR(:order_id));
  l_param_list.EXTEND;
  l_param_list(l_param_list.LAST) := WF_PARAMETER_T('3PL_CODE', :tpl_code);

  -- Raise the event
  WF_EVENT.Raise(
    p_event_name  => 'custom.apps.mymodule.order.exported',
    p_event_key   => TO_CHAR(:order_id),
    p_event_data  => NULL,              -- NULL = generate function will build payload on demand
    p_parameters  => l_param_list,
    p_send_date   => NULL               -- NULL = raise immediately
  );
  COMMIT;
END;
/
\`\`\`

---

## Integration Patterns

### Pattern 1: EBS to External System (Outbound)

Subscribe to a standard EBS event with action type MESSAGE pointing to WF_OUT. Configure Oracle AQ propagation (or the AQ JMS adapter) to forward messages from the WF_OUT queue to the external system's inbound queue. The external system's queue consumer reads the event and processes it.

This is the pattern used by Oracle SOA Suite's EBS adapter and by Oracle Integration Cloud's EBS trigger connections.

### Pattern 2: External System to EBS (Inbound)

External system enqueues a message to the WF_IN agent (AQ queue). WF_EVENT automatically processes WF_IN messages and invokes subscriptions registered for the event name in the inbound message. The subscription's PL/SQL handler calls EBS APIs to create or update records.

### Pattern 3: EBS to EBS (Internal Trigger)

Subscribe to an EBS event with a PL/SQL function that calls another EBS API or raises a second event. Used for cross-module automation — e.g., when an HR termination event triggers automatic deactivation of the employee's purchasing card and revocation of system access.

### Pattern 4: Event-Triggered Workflow

Subscribe to an EBS event with action type WORKFLOW. When the event fires, a custom workflow process starts with the event data as input. The workflow can route approvals, send notifications, or orchestrate multi-step business processes based on the event context.

---

## Monitoring and Error Handling

### Viewing Events in the Error Queue

Failed subscriptions place the event on WF_ERROR. Query the error queue:

\`\`\`sql
SELECT eq.msgid,
       eq.user_data.event_name         AS event_name,
       eq.user_data.event_key          AS event_key,
       eq.user_data.error_subscription AS failed_subscription,
       eq.user_data.error_message      AS error_message,
       eq.enq_time
FROM   apps.wf_event_t2             eq,  -- AQ queue table for WF_ERROR
       TABLE(eq.user_data.parameter_list) p
WHERE  ROWNUM <= 50;
\`\`\`

Alternatively, use the BES Event Manager UI in EBS (Workflow Administrator responsibility > Business Events > Event Error Queue) to retry or abort individual failed events.

### Subscription Execution Status

\`\`\`sql
-- Recent subscription processing history
SELECT we.name         AS event_name,
       wes.description AS subscription,
       wes.status,
       wes.on_error_code,
       wes.action_type,
       wes.rule_function
FROM   wf_event_subscriptions wes
JOIN   wf_events we ON we.guid = wes.event_guid
WHERE  wes.status = 'ENABLED'
ORDER  BY we.name, wes.phase;
\`\`\`

---

## Summary

The Oracle EBS Business Event System is the publish-subscribe messaging layer that connects EBS transactional events to downstream processes and external systems. Its four components work together: events define what happened, agents carry the signal, subscriptions decide what to do with it, and Oracle AQ provides the reliable asynchronous delivery mechanism underneath.

For integration architects, BES is the correct alternative to polling-based integrations. Instead of querying EBS tables every five minutes to detect new purchase orders, subscribe to \`oracle.apps.po.event.approved\` and process each approval as it occurs — with exactly-once delivery guaranteed by Oracle AQ.

For EBS administrators, BES is a diagnostic surface for understanding why downstream systems are not receiving updates. A broken subscription, a disabled event, a failed WF_DEFERRED dequeue, or a stopped AQ propagation job each produces a distinct and queryable failure mode. The companion runbook covers the complete SQL diagnostic toolkit for tracing events from the raise point through WF_DEFERRED to subscription execution, the procedures for creating and testing custom subscriptions, AQ queue depth monitoring, error queue retry procedures, and subscription performance tuning.`,
};

async function main() {
  console.log('Inserting EBS Workflow Business Events blog post...');
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
