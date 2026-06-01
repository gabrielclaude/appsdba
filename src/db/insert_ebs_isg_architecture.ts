import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS Integrated SOA Gateway: Architecture and Use Cases',
  slug: 'ebs-isg-architecture-use-cases',
  excerpt:
    'A deep dive into the Oracle E-Business Suite Integrated SOA Gateway — how its service infrastructure works, how REST and SOAP interfaces are deployed, what the key architectural components are, and practical use cases for integrating EBS with Oracle Integration Cloud, third-party systems, and mobile applications.',
  category: 'ebs-isg' as const,
  published: true,
  publishedAt: new Date('2026-05-31'),
  youtubeUrl: null,
  content: `Oracle E-Business Suite (EBS) houses decades of business logic — GL posting rules, purchasing approval workflows, order management orchestration, HR transaction validation — that organizations have refined over years of operation. The challenge is always the same: how do you let modern applications, cloud platforms, and integration middleware consume that logic without bypassing the business rules baked into the EBS forms?

The answer built into EBS 12.x is the **Integrated SOA Gateway (ISG)**. It exposes native EBS business objects — PL/SQL APIs, Java APIs, Business Events, and XML Gateway maps — as standards-based web services without custom code, without middleware connectors, and without touching the EBS application tier configuration.

---

## What the Integrated SOA Gateway Is

ISG is a built-in service infrastructure that ships as part of EBS 12.x. It consists of:

- A **Service Repository** that discovers and catalogs deployable interfaces from the EBS code base
- A **deployment engine** that generates WSDL (SOAP) and WADL (REST) definitions at runtime from the interface metadata
- An **Oracle Application Server** (OC4J/WebLogic) hosted service container where deployed services run
- A **Service Alias** mechanism that provides stable endpoint URLs independent of the underlying implementation

ISG does not replicate data. It does not stage business objects in a separate schema. Every service call executes directly inside the EBS application tier using the same code paths a forms-based user would trigger — subject to the same validation, the same security profiles, and the same audit trail.

---

## Architecture Components

### Interface Repository

The Interface Repository (\`irc_*\` tables in APPS schema) is the catalog from which ISG works. When EBS is patched or upgraded, new APIs are automatically registered in the repository. The DBA or integration developer browses this catalog through the **Integrated SOA Gateway Administrator** responsibility to find and deploy interfaces.

Interface types available for deployment:

- **PL/SQL API** — any public PL/SQL package procedure registered in the Interface Repository. This is the most common and most powerful interface type. Nearly every EBS module exposes its transactional API through a registered PL/SQL package (e.g. \`HR_EMPLOYEE_API\`, \`PO_HEADERS_INT\`, \`AR_INVOICE_API_PUB\`).
- **Java Bean Service** — Java methods exposed through JDeveloper-registered bean definitions.
- **Business Event** — Oracle Workflow Business Events that can be raised or subscribed to as web service endpoints.
- **XML Gateway Map** — existing EDI/XML transaction maps exposed as web service endpoints for direct XML message exchange.
- **Concurrent Program** — EBS concurrent programs wrapped as web services, allowing remote submission and status polling.

### Service Deployment and WSDL Generation

When you deploy an interface through ISG, the gateway:

1. Reads the interface metadata (procedure signature, parameter types, IN/OUT modes) from the Interface Repository
2. Auto-generates a WSDL or WADL document describing the service contract
3. Registers the service endpoint in the OC4J/WebLogic container
4. Publishes the endpoint URL in the Service Alias table

No hand-crafted WSDL. No custom wrapper code. The service contract is derived entirely from the registered API signature.

### Service Alias

A Service Alias is an indirection layer between the endpoint URL that external callers use and the underlying deployed service implementation. Aliases provide:

- **Stable URLs** — if the underlying service is re-deployed to a different port or context, only the alias mapping changes; callers are unaffected
- **Versioning** — multiple aliases can point to different versions of the same interface simultaneously
- **Load distribution** — multiple ISG nodes can serve the same alias in a clustered EBS environment

### Authentication and Security

ISG services authenticate callers using the standard EBS user/responsibility/security group model:

- **HTTP Basic Authentication** — username and password passed in the HTTP Authorization header. The service executes under that user's EBS session context, subject to their function security and data access sets.
- **WS-Security UsernameToken** — SOAP header-based credential passing for SOAP services
- **Oracle Web Services Manager (OWSM)** — policy attachment for OAuth, SAML tokens, and message-level encryption in 12.2 deployments with Oracle Fusion Middleware integration

Every ISG service call creates an EBS session. Responsibility context, org assignment, and operating unit must be set correctly for transactional APIs to resolve the right data partitioning context. This is done through ISG-specific HTTP headers or SOAP header elements:

\`\`\`
-- Required SOAP headers for responsibility context
<wsse:Security>
  <wsse:UsernameToken>
    <wsse:Username>JSMITH</wsse:Username>
    <wsse:Password>password</wsse:Password>
  </wsse:UsernameToken>
</wsse:Security>
<oas:ReqHeader xmlns:oas="...">
  <oas:responsibility>PAYABLES_MANAGER</oas:responsibility>
  <oas:respApplication>SQLAP</oas:respApplication>
  <oas:securityGroup>STANDARD</oas:securityGroup>
  <oas:nlsLanguage>AMERICAN</oas:nlsLanguage>
  <oas:orgId>204</oas:orgId>
</oas:ReqHeader>
\`\`\`

### REST vs SOAP

EBS 12.2 ISG supports both protocols. The choice depends on the calling system:

- **SOAP** is the legacy default and is supported across all 12.x releases. Use it when integrating with older SOA middleware, SAP PI/PO, or any system with a WS-* stack.
- **REST** was introduced in 12.2 and maps PL/SQL API parameters to JSON request/response bodies. Use it when integrating with Oracle Integration Cloud (OIC), modern iPaaS platforms, mobile applications, or any HTTP client that speaks JSON.

REST endpoints follow this URL pattern:

\`\`\`
https://<ebs-host>:<port>/webservices/rest/<ServiceAlias>/<MethodName>
\`\`\`

SOAP endpoints:

\`\`\`
https://<ebs-host>:<port>/webservices/soap/<ServiceAlias>
\`\`\`

---

## Deploying a Service — Step by Step

### 1. Navigate to the Interface Repository

Log in to EBS as a user with the **Integrated SOA Gateway Administrator** responsibility. Navigate to:

**Integrated SOA Gateway > Integration Repository**

### 2. Search for the interface

Use the search to find your target API. Example: search for \`HR_EMPLOYEE_API\` in the PL/SQL API category under the Human Resources product family.

### 3. Review the interface definition

The repository entry shows every procedure in the package, each parameter's name, data type, and IN/OUT mode. Review the parameters before deploying — understand which are mandatory and what data types the calling system must provide.

### 4. Deploy the service

Click **Deploy** on the interface entry. The deployment wizard prompts for:

- **Service Alias** — the URL-friendly name callers will use
- **Protocol** — SOAP, REST, or both
- **Authentication** — Basic or WS-Security
- **OWSM policy** (optional) — for OAuth or SAML if OWSM is configured

### 5. Verify endpoint availability

After deployment, the WSDL URL is available from the repository entry. Verify it returns a valid WSDL:

\`\`\`bash
curl -u JSMITH:password \
  "https://ebs-host:4443/webservices/soap/HrEmployeeService?WSDL"
\`\`\`

A 200 response with an XML body confirms the service is live.

---

## Use Case 1: Oracle Integration Cloud (OIC) to EBS Transaction Submission

**Scenario:** A new employee record created in Oracle HCM Cloud must be simultaneously created in EBS HR to maintain a synchronized employee master.

**Integration pattern:** OIC subscription trigger on HCM Cloud new-hire event → REST call to ISG \`HR_EMPLOYEE_API.CREATE_EMPLOYEE\` → response parsed for EBS person ID returned to HCM for cross-reference storage.

**ISG interface:** \`HR_EMPLOYEE_API\` — PL/SQL package, REST deployment.

**Sample REST request body (JSON):**

\`\`\`json
{
  "P_HIRE_DATE": "2026-06-01",
  "P_BUSINESS_GROUP_ID": 81,
  "P_LAST_NAME": "SMITH",
  "P_FIRST_NAME": "JOHN",
  "P_SEX": "M",
  "P_PERSON_TYPE_ID": 1,
  "P_EMPLOYEE_NUMBER": null,
  "P_VALIDATE": false
}
\`\`\`

**Why ISG rather than direct table insert:**
Direct inserts into \`PER_ALL_PEOPLE_F\` bypass EBS business rules: employee number generation sequences, person type defaulting, HR organization assignment, and the audit trail managed by the \`HR_EMPLOYEE_API\` code. ISG ensures every creation follows the same code path a data entry operator uses.

---

## Use Case 2: Third-Party Procurement Portal Submitting Purchase Requisitions

**Scenario:** A supplier portal built outside EBS allows requestors to browse a catalog and submit purchase requisitions. Approved requisitions must appear in EBS iProcurement as standard requisition lines for buyer review.

**ISG interface:** \`PO_REQUISITION_IMPORT_API\` or the \`REQUISITION_IMPORT\` concurrent program endpoint.

**Integration pattern:** Portal calls ISG SOAP endpoint with requisition header and lines → ISG executes the API under the requestor's EBS user context → EBS creates the requisition in \`PO_REQUISITION_HEADERS_ALL\` and \`PO_REQUISITION_LINES_ALL\` with full approval workflow routing → API returns the requisition number to the portal for reference.

**Key design consideration:** The ISG call must include the requestor's EBS responsibility and operating unit in the SOAP security header. Requestors must have valid EBS accounts with iProcurement access — ISG does not bypass EBS user provisioning.

---

## Use Case 3: Real-Time Inventory Queries from a Warehouse Management System

**Scenario:** A third-party WMS needs real-time on-hand quantity data from EBS Inventory before committing a pick. Instead of a nightly batch extract to a staging table, the WMS queries ISG directly.

**ISG interface:** \`INV_QUANTITY_TREE_PUB.QUERY_QUANTITIES\` — PL/SQL API, REST deployment.

**Sample REST call:**

\`\`\`bash
curl -X POST \
  -H "Content-Type: application/json" \
  -u WMS_INTEGRATION:password \
  -H "responsibility: INVENTORY_MANAGER" \
  -H "respApplication: INV" \
  -H "orgId: 207" \
  https://ebs-host:4443/webservices/rest/InvQuantityService/QueryQuantities \
  -d '{
    "P_API_VERSION_NUMBER": 1.0,
    "P_ORGANIZATION_ID": 207,
    "P_INVENTORY_ITEM_ID": 4832,
    "P_TREE_MODE": 1,
    "P_ONHAND_SOURCE": 3
  }'
\`\`\`

**Why this is better than a DB link query:** A DB link query against \`MTL_ONHAND_QUANTITIES_DETAIL\` returns raw storage rows without applying reservation netting, ATP rules, or lot/serial allocation logic. \`QUERY_QUANTITIES\` applies all of those rules and returns the same available quantity number the EBS forms show.

---

## Use Case 4: Raising Business Events from External Systems

**Scenario:** An external payment gateway confirms payment receipt. EBS Accounts Receivable must be notified to trigger its cash application workflow.

**ISG interface:** Business Event endpoint for \`oracle.apps.ar.payment.received\`.

**Integration pattern:** Payment gateway calls the ISG Business Event service endpoint with payment reference details → ISG raises the event on the Oracle Workflow Business Event System → EBS AR subscription fires the cash receipt application logic.

This pattern is particularly powerful because it completely decouples the external system from the EBS AR implementation. The external system only knows it received a payment and needs to tell EBS. The exact AR processing logic — which bank account, which receipt class, which auto-match rules apply — is entirely internal to EBS.

---

## Use Case 5: Concurrent Program Submission and Polling

**Scenario:** A BI reporting platform needs to trigger EBS month-end GL reports on demand and retrieve the output file.

**ISG interface:** Concurrent Program service for the target report.

**Integration pattern:**
1. Call ISG concurrent program submission endpoint → returns request ID
2. Poll ISG request status endpoint with request ID until status = \`Completed Normal\`
3. Retrieve output file via the ISG attachment/output endpoint

\`\`\`bash
# Step 1: Submit
curl -X POST \
  -u GL_SUPER_USER:password \
  -H "responsibility: GL_SUPER_USER" \
  -H "respApplication: SQLGL" \
  -H "orgId: 204" \
  https://ebs-host:4443/webservices/rest/ConcurrentProgram/submit \
  -d '{ "P_PROGRAM_NAME": "GLARBST", "P_ARGUMENT1": "204" }'

# Step 2: Poll (returns P_STATUS: "Completed Normal" when done)
curl -u GL_SUPER_USER:password \
  "https://ebs-host:4443/webservices/rest/ConcurrentProgram/getStatus?P_REQUEST_ID=1048234"
\`\`\`

---

## Operational Considerations

### Performance

ISG services execute synchronously in the EBS application tier. Every service call consumes an EBS session, a database connection from the connection pool, and CPU proportional to the underlying API complexity. High-frequency polling patterns (e.g. querying inventory every second for every WMS pick) should be replaced with bulk query calls or event-driven triggers.

Monitor ISG load through the EBS concurrent processing framework:

\`\`\`sql
-- Active ISG sessions
SELECT s.username, s.program, s.status, s.logon_time
FROM v$session s
WHERE s.program LIKE '%OC4J%' OR s.program LIKE '%ISG%'
ORDER BY s.logon_time DESC;
\`\`\`

### Error Handling

ISG services return structured fault elements for application-level errors. Always check for both HTTP-level errors (4xx/5xx) and application-level fault payloads in the response body. A successful HTTP 200 does not guarantee the EBS API succeeded — the API may have set its \`X_RETURN_STATUS\` output parameter to \`E\` (Error) or \`U\` (Unexpected Error) with message text in \`X_MSG_DATA\`.

\`\`\`json
{
  "X_RETURN_STATUS": "E",
  "X_MSG_COUNT": 1,
  "X_MSG_DATA": "APP-PER-50022: The employee number 40123 already exists."
}
\`\`\`

Callers must inspect \`X_RETURN_STATUS\` and surface \`X_MSG_DATA\` to the end user or integration log.

### Patching Considerations

When EBS is patched with adop, the Interface Repository is updated and some previously deployed services may have their underlying package signature changed. After each patch cycle:

- Review the ISG deployment log for invalidated services
- Re-deploy any service whose underlying API signature changed
- Update WSDL/WADL cached by calling systems if parameter names or types changed

---

## Summary

The Integrated SOA Gateway turns EBS into a first-class service provider without any custom code. Its value lies not in performance or throughput — it is not designed for bulk data movement — but in ensuring that every integration point goes through the same business logic, the same security model, and the same audit trail as native EBS operations. For Oracle Integration Cloud deployments, modern iPaaS patterns, and any scenario where EBS business rule enforcement is non-negotiable, ISG is the right integration surface.`,
};

async function main() {
  console.log('Inserting EBS ISG architecture post...');
  await db.insert(posts).values(post).onConflictDoNothing();
  console.log(`Inserted: "${post.title}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
