import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle SOA Suite Architecture: Components, Runtime, and Integration Patterns',
  slug: 'soa-suite-architecture',
  excerpt:
    'A comprehensive look at Oracle SOA Suite 12c architecture — the service infrastructure, service engines (BPEL, Mediator, Human Workflow, Business Rules), Oracle Service Bus, JCA adapters, MDS, and how all the pieces fit together on a WebLogic runtime.',
  category: 'soa-suite' as const,
  published: true,
  publishedAt: new Date('2026-05-31'),
  youtubeUrl: null,
  content: `Oracle SOA Suite is Oracle's platform for building, deploying, and managing service-oriented integrations. It combines a BPEL process engine, a lightweight mediation layer, a human workflow engine, a business rules engine, and an enterprise service bus into a single, WebLogic-hosted runtime. Understanding how those components relate to each other — and to the underlying infrastructure — is the foundation for designing integrations that are maintainable, observable, and operationally sound.

---

## The Runtime Container: Oracle WebLogic Server

SOA Suite 12c runs entirely inside Oracle WebLogic Server (WLS). The SOA infrastructure is deployed as a set of managed applications and libraries within a WebLogic domain. A minimal SOA domain includes:

- **AdminServer** — domain administration, configuration management, Fusion Middleware Control (EM)
- **soa_server1** (or a cluster of SOA managed servers) — the SOA runtime: service engines, binding components, composite lifecycle manager
- **Shared database schema** — the SOA Infrastructure schema (\`SOAINFRA\`) in an Oracle database, used for instance state, audit trails, fault management, and human task storage

In production environments the SOA managed server is typically clustered across two or more nodes for high availability. The \`SOAINFRA\` database is the central persistence layer — every running process instance, every audit trail entry, every human task assignment is a row in that schema.

---

## The SOA Infrastructure

The SOA Infrastructure is the runtime fabric that hosts and coordinates all service components. Its responsibilities:

- **Composite lifecycle** — deploys, activates, retires, and redeploys SOA composites
- **Message routing** — dispatches inbound messages to the correct service component within a composite
- **Instance tracking** — assigns unique instance IDs to every composite invocation, records start/end times, payloads (if audit enabled), and fault details in \`SOAINFRA\`
- **Transaction management** — coordinates XA transactions across service components when the composite spans multiple JCA adapters and service engines
- **Fault management** — applies fault policies (retry, rethrow, human intervention) to faulted instances

The infrastructure is accessible through **Oracle Enterprise Manager Fusion Middleware Control** (EM FMW Control) at \`http://<host>:7001/em\`. Every deployed composite, every running instance, and every fault is visible through this console.

---

## SOA Composites

The deployment unit in SOA Suite is the **composite**. A composite is a JAR-based artifact (packaged as a SAR — SOA Archive) that declares:

- Which **service components** implement the business logic (BPEL process, Mediator routing rules, Human Workflow task, Business Rules ruleset)
- Which **binding components** expose the composite as an endpoint (SOAP/HTTP, JMS, AQ, REST) or connect it to external services
- The **wiring** between components — how messages flow from the inbound binding to the service engine and out through reference bindings

At runtime, one composite can contain multiple service components wired together. A common pattern:

\`\`\`
Inbound SOAP Binding → BPEL Process → (1) Human Workflow task + (2) DB Adapter insert → Outbound AQ Binding
\`\`\`

---

## Service Engines

Service engines are the pluggable execution environments inside the SOA Infrastructure for each component type.

### BPEL Process Manager

The **BPEL (Business Process Execution Language) engine** orchestrates long-running and synchronous processes. It is the most powerful component in SOA Suite.

Key capabilities:
- **Synchronous and asynchronous** process modes — synchronous processes block and return immediately; asynchronous processes dehydrate to database between receive/pick activities
- **Parallel flows** — \`<flow>\` activities execute branches concurrently; the engine waits for all branches or a subset using \`<wait>\`
- **Compensation and fault handling** — \`<compensationHandler>\` and \`<faultHandler>\` blocks define rollback logic for distributed transactions that cannot use XA
- **Correlation** — \`<correlationSet>\` ties asynchronous callback messages back to the correct waiting process instance using a business key (e.g., order number)
- **Dehydration** — asynchronous BPEL instances persist their state to \`SOAINFRA\` at each dehydration point (receive, wait, pick). The instance is removed from memory and rehydrated when the next message arrives. This is what allows BPEL to support processes that run for days or weeks.

Dehydration store tables (key ones in \`SOAINFRA\`):

\`\`\`sql
-- Active process instances
SELECT instance_id, composite_name, state, creation_date
FROM cube_instance
WHERE state IN (0, 1)  -- 0=open/running, 1=open/suspended
ORDER BY creation_date DESC;

-- Dehydrated (waiting) instances
SELECT ci.instance_id, ci.composite_name, cwi.wait_type
FROM cube_instance ci
JOIN cube_wait_instance cwi ON ci.instance_id = cwi.instance_id
WHERE ci.state = 0;
\`\`\`

### Mediator

The **Mediator** is a lightweight routing engine for stateless message transformation and fan-out/fan-in scenarios. It does not dehydrate to database — it processes in memory, making it significantly faster than BPEL for simple routing.

Mediator capabilities:
- **Content-based routing** — route a message to one of several targets based on XPath conditions evaluated against the payload
- **Fan-out** — deliver the same message to multiple targets (sequential or parallel)
- **Transformation** — apply XSLT stylesheets to transform the inbound message schema to one or more target schemas
- **Protocol bridging** — accept a SOAP message and invoke a REST endpoint, or consume an AQ message and produce a JMS message

Use Mediator instead of BPEL when there is no need for state, correlation, compensation, or human interaction — pure routing and transformation workloads belong in Mediator.

### Human Workflow

The **Human Workflow engine** manages task assignment, escalation, and approval routing for processes that require human decision-making.

Capabilities:
- **Assignment patterns** — single approver, parallel (all must approve), sequential chain, first-responder from a group, management chain traversal (using HR org data)
- **Escalation and expiration** — tasks can auto-escalate after a configured interval if not acted upon
- **Notification** — task notifications via email, SMS, or IM at assignment, reminder, escalation, and completion events
- **Oracle BPM Worklist** — the built-in web application where users manage their task inbox, approve/reject, and add comments
- **Task payload** — the task carries an XML payload (the business document requiring approval) that the assignee can view and, if permitted, modify

Human Workflow integrates tightly with BPEL: a BPEL \`<invoke>\` activity submits a task to the workflow engine, then waits (dehydrates) until the task is completed. The completion callback rehydrates the BPEL instance with the task outcome.

### Business Rules

The **Business Rules engine** (Oracle Business Rules, powered by the Rete algorithm) externalizes decision logic that would otherwise be hardcoded in BPEL or Mediator.

- Rules are organized into **rulesets** and **decision tables**
- **Decision tables** allow business users to maintain rules in a spreadsheet-style grid without touching the integration design
- Rules are versioned and can be updated at runtime without redeploying the composite — the composite calls the rules engine by reference
- Typical use: discount calculation, credit limit approval thresholds, message routing conditions that change frequently

---

## Oracle Service Bus (OSB)

The **Oracle Service Bus** (formerly AquaLogic Service Bus) is a separate runtime layer optimized for high-throughput, policy-enforced service virtualization. It runs in the same WebLogic domain as SOA Suite (on a dedicated OSB managed server in 12c joint install) but serves a different architectural role.

**SOA Suite vs OSB — the distinction:**

| Concern | SOA Suite (BPEL/Mediator) | Oracle Service Bus |
|---|---|---|
| Primary role | Process orchestration, stateful flows | Service virtualization, mediation, routing |
| State | Dehydrates long-running instances | Stateless (in-memory only) |
| Best for | Multi-step business processes, human tasks | High-volume routing, protocol bridging, service registry |
| Audit | Full instance audit trail in SOAINFRA | Pipeline statistics only (no per-message persistence) |
| Config artifact | SOA Composite (.SAR) | OSB project (Pipeline, ProxyService, BusinessService) |

**OSB core concepts:**

- **Proxy Service** — the inbound endpoint exposed to consumers. Receives the message and passes it to a Pipeline.
- **Business Service** — the outbound endpoint connecting to the actual backend service. OSB calls the Business Service after Pipeline processing.
- **Pipeline** — the mediation logic between Proxy and Business Service. Contains Stage nodes with actions: transformation (XQuery/XSLT), routing, logging, error handling, policy enforcement.
- **Service Registry** — UDDI-compatible catalog of all services registered in OSB, queryable from the OSB console.

A typical OSB flow:

\`\`\`
Consumer → [Proxy Service] → [Pipeline: validate, log, transform] → [Business Service] → Backend
\`\`\`

OSB is the right layer for:
- Abstracting backend service URLs so consumers are never directly coupled to backend endpoints
- Enforcing security policies (OAuth, WS-Security) at the gateway before messages reach SOA composites
- Protocol translation at scale (HTTP/SOAP → JMS → HTTP/REST)
- Throttling and SLA enforcement

---

## JCA Adapters

JCA (Java Connector Architecture) adapters are the binding components that connect SOA composites and OSB pipelines to external systems. Each adapter provides a standards-based interface to a specific technology.

Oracle ships the following adapters with SOA Suite:

| Adapter | Technology | Common use |
|---|---|---|
| **Database Adapter** | Oracle DB, SQL Server, DB2 | Query, insert, update, stored proc invocation, polling on new rows |
| **File/FTP Adapter** | Local filesystem, FTP/SFTP | Read/write files, poll directories for new files |
| **JMS Adapter** | JMS-compliant brokers (WLS JMS, ActiveMQ) | Produce/consume JMS messages |
| **AQ Adapter** | Oracle Advanced Queuing | Enqueue/dequeue Oracle AQ messages (single/multi-consumer queues) |
| **MQ Adapter** | IBM MQ | Produce/consume MQ messages |
| **Socket Adapter** | Raw TCP/IP sockets | Legacy mainframe and proprietary protocol integration |
| **EJB Adapter** | Enterprise JavaBeans | Invoke local/remote EJB methods from composites |
| **Oracle Applications Adapter** | Oracle EBS | Business Events, Concurrent Programs, open interface tables |
| **Siebel Adapter** | Oracle Siebel CRM | Siebel integration objects and business services |
| **SAP Adapter** | SAP R/3, S/4HANA | BAPI, IDoc, RFC invocation |

Adapters are configured as JCA connection factories in WebLogic. Each adapter instance in a composite references one of these connection factories by JNDI name. The adapter translates between the composite's XML message model and the native protocol of the target system.

**Database Adapter polling pattern (common for EBS open interface staging tables):**

\`\`\`xml
<!-- Activation spec for polling PO_HEADERS_INTERFACE for PROCESS_FLAG = 'P' -->
<adapter-config name="PollPOInterface" adapter="Database Adapter">
  <connection-factory location="eis/DB/EBSDB"/>
  <endpoint-activation portType="PollPOInterface_ptt" operation="receive">
    <activation-spec className="oracle.tip.adapter.db.DBActivationSpec">
      <property name="DescriptorName" value="PO_HEADERS_INTERFACE"/>
      <property name="PollingStrategy" value="LogicalDeletePollingStrategy"/>
      <property name="MarkReadColumn" value="PROCESS_FLAG"/>
      <property name="MarkReadValue" value="X"/>
      <property name="MarkUnreadValue" value="P"/>
      <property name="PollingInterval" value="10"/>
    </activation-spec>
  </endpoint-activation>
</adapter-config>
\`\`\`

---

## Metadata Services (MDS)

The **Metadata Services repository (MDS)** is a versioned metadata store used across all Fusion Middleware components. In SOA Suite, MDS stores:

- **Shared WSDL and XSD files** — referenced by composites using \`oramds://\` URLs instead of relative paths. A shared schema change propagates to all composites referencing it without redeployment.
- **Fault policy files** — referenced by composites to apply retry/rethrow/human-intervention policies to adapter faults
- **BPEL sensor action definitions**
- **Human Workflow notification templates**

MDS is backed by either a filesystem partition or a database schema (\`MDS\` schema created by RCU). Production deployments use database-backed MDS for cluster-safe concurrent access.

\`\`\`
oramds:/apps/SOA/WSDL/Common/ErrorFault.wsdl
oramds:/apps/SOA/XSD/Common/Address.xsd
oramds:/apps/SOA/FaultPolicies/RetryPolicy.xml
\`\`\`

---

## Database Schemas (RCU)

SOA Suite requires several database schemas created by the **Repository Creation Utility (RCU)** before domain creation:

| Schema prefix | Purpose |
|---|---|
| \`_SOAINFRA\` | BPEL instance state, audit trail, human tasks, fault management, Mediator routing, UMS messages |
| \`_MDS\` | Metadata Services repository (shared WSDLs, XSDs, fault policies) |
| \`_STB\` | Service Table — cross-component service discovery registry |
| \`_OPSS\` | Oracle Platform Security Services — credential store, policy store |
| \`_IAU\` | Audit (OPSS audit trail — not SOA audit trail) |
| \`_WLS\` | WebLogic JMS persistent stores (if using DB persistence) |
| \`_ESS\` | Enterprise Scheduler Service (if deployed) |

The \`SOAINFRA\` schema grows continuously as process instances accumulate. Purging is a critical operational task:

\`\`\`sql
-- Purge closed instances older than 30 days (run in SOAINFRA schema context)
BEGIN
  soa.purge_instances(
    p_max_creation_date => SYSDATE - 30,
    p_batch_size        => 10000,
    p_retries           => 3
  );
END;
/
\`\`\`

The built-in purge scripts are in \`\${ORACLE_HOME}/soa/common/sql/soainfra/\`.

---

## Monitoring and Observability

### EM Fusion Middleware Control

The primary management interface. Accessible at \`http://<AdminServer>:7001/em\`.

From EM you can:
- View all deployed composites and their revision history
- Drill into individual composite instances: flow trace, payload at each step (if payload capture is enabled), fault details
- Trigger fault recovery (retry, abort, skip activity) for faulted BPEL instances
- View adapter statistics (messages processed, faults, throughput per adapter endpoint)
- Manage Human Workflow task assignment rules

### Flow Trace

The **flow trace** is SOA Suite's end-to-end correlation across composite boundaries. When an integration spans multiple composites (Composite A calls Composite B via a service reference), the flow trace links all instance IDs into a single correlated view. This is the first tool to open when investigating an end-to-end failure.

### SOAINFRA Queries for Operations

\`\`\`sql
-- Faulted instances in the last 24 hours
SELECT ci.composite_name, ci.instance_id, fi.fault_name, fi.fault_time, fi.fault_message
FROM cube_instance ci
JOIN audit_trail at ON ci.instance_id = at.instance_id
JOIN fault_instance fi ON ci.instance_id = fi.instance_id
WHERE ci.state = 4  -- 4 = faulted
  AND fi.fault_time > SYSDATE - 1
ORDER BY fi.fault_time DESC;

-- Instance count by composite and state
SELECT composite_name,
       SUM(CASE WHEN state = 0 THEN 1 ELSE 0 END) AS running,
       SUM(CASE WHEN state = 2 THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN state = 4 THEN 1 ELSE 0 END) AS faulted
FROM cube_instance
WHERE creation_date > SYSDATE - 1
GROUP BY composite_name
ORDER BY faulted DESC;

-- Long-running dehydrated instances
SELECT ci.instance_id, ci.composite_name, ci.creation_date,
       ROUND(SYSDATE - ci.creation_date, 2) AS age_days
FROM cube_instance ci
WHERE ci.state = 0
  AND ci.creation_date < SYSDATE - 1
ORDER BY ci.creation_date ASC;
\`\`\`

---

## Typical Integration Topology

A production SOA Suite 12c deployment for a large Oracle EBS environment commonly looks like:

\`\`\`
                    ┌─────────────────────────────────────────┐
                    │         WebLogic Domain                  │
                    │                                         │
  External ────────▶│  OSB Proxy Service                      │
  consumers         │     │                                   │
                    │     ▼                                   │
  EBS Events ──────▶│  SOA Composite (BPEL/Mediator)         │
                    │     │          │                        │
  File drops ──────▶│  Human     Business                    │
                    │  Workflow   Rules                       │
                    │     │          │                        │
                    │     └────┬─────┘                        │
                    │          │                              │
                    │     JCA Adapters                        │
                    │  (DB / AQ / File / JMS)                 │
                    └──────────┼──────────────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │   Oracle Database   │
                    │  SOAINFRA / MDS     │
                    │  EBS APPS schema    │
                    └─────────────────────┘
\`\`\`

OSB sits at the edge, normalizing protocols and enforcing security policies. SOA composites implement the business process logic. JCA adapters connect to the Oracle EBS database directly or through AQ. Human Workflow handles approval steps. The Oracle DB houses both the SOA infrastructure schemas and the EBS application data.

---

## Choosing Between BPEL, Mediator, and OSB

| Scenario | Use |
|---|---|
| Multi-step approval with human tasks | BPEL + Human Workflow |
| Route inbound message to one of several targets based on content | Mediator |
| Transform and route at high volume, stateless | OSB Pipeline |
| Long-running process with compensation | BPEL with fault/compensation handlers |
| Frequently changing business rules | BPEL + Business Rules |
| Protocol bridging at service entry point | OSB Proxy Service |
| EBS API invocation with response handling | BPEL (with DB or EBS Adapter) |
| Raise an Oracle AQ event after process completes | BPEL (with AQ Adapter invoke) |

---

## Summary

Oracle SOA Suite is a layered platform. WebLogic provides the runtime container. The SOA Infrastructure manages composite lifecycle and instance tracking. BPEL, Mediator, Human Workflow, and Business Rules are service engines that each handle a specific class of integration logic. OSB sits at the edge for service virtualization. JCA adapters bridge to every external system. MDS provides shared, versioned metadata. The SOAINFRA and MDS database schemas are the persistence backbone that makes long-running, auditable, recoverable integrations possible.

The architectural principle is separation of concerns: routing belongs in OSB or Mediator, orchestration belongs in BPEL, human decisions belong in Human Workflow, and volatile business logic belongs in Business Rules. Putting everything in BPEL works until the first time a routing change requires a full composite redeploy — the architecture is designed to prevent that.`,
};

async function main() {
  console.log('Inserting SOA Suite architecture post...');
  await db.insert(posts).values(post).onConflictDoNothing();
  console.log(`Inserted: "${post.title}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
