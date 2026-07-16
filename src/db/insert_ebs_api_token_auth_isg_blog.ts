import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-api-token-authentication-isg-gateway-architecture';

const content = `
Few problems in enterprise integration are as persistent or as operationally costly as hard-coded passwords in Oracle EBS API connections. A team integrates an external application with EBS, stores the credentials in a configuration file, and the system works reliably — until the next mandatory password rotation. The integration breaks. The account gets locked after repeated failed attempts from stale configuration on other nodes. A compliance audit flags the plaintext credential in the config. The cycle repeats every 90 days.

The underlying requirement in these situations is not complex: replace hard-coded EBS credentials with some form of token-based authentication that survives password rotation, supports centralized identity management, and is safe to expose to external systems. The challenge is that Oracle EBS was not built like a modern SaaS API platform, and the path to token-based authentication runs through a set of architectural decisions — not a single configuration switch.

This post covers why EBS handles authentication differently from modern APIs, the three architectural patterns for implementing token-based or token-mediated EBS access, how the options change across EBS 11i, 12.1.3, and 12.2.x, how to expose a custom PL/SQL API as a REST service through the Integrated SOA Gateway, and how an API Gateway layer translates OAuth2/JWT tokens into EBS-compatible credentials.

---

## Why EBS is Not a Modern SaaS API

Modern SaaS platforms validate OAuth2 bearer tokens or JWTs at the HTTP layer before any application logic executes. The token contains claims about the caller's identity and permissions, the platform's API gateway validates the signature and expiry, and the upstream service receives a verified identity context — no username or password is transmitted after the initial OAuth flow.

Oracle EBS authenticates at the application user layer using \`FND_USER\` validation. When an API call arrives — whether through the Integrated SOA Gateway, a custom REST service, or a direct PL/SQL invocation — EBS checks the caller's credentials against the \`FND_USER\` table. There is no native mechanism to present a JWT to EBS and have it validate the token signature, extract claims, and establish an application session from it.

This architectural constraint is not a bug or an oversight — it reflects how EBS was designed before modern identity federation standards were widely adopted. The consequence is that any token-based authentication strategy for EBS must introduce a translation layer between the external token and the EBS credential model.

### The password rotation problem in detail

Consider a typical integration: an external reporting system calls an EBS ISG REST endpoint every hour to pull outstanding AR data. The service account credentials are stored in the external system's configuration. When the EBS security team rotates the \`AR_READER\` user's password:

- The external system's configuration is not updated (or is updated with a delay)
- The external system continues trying the old password
- After the configured failed attempt threshold (typically 3–10 attempts in \`FND_USER\`), the account locks
- All AR data pulls fail until the password is updated in every system that references it and the account is unlocked

On a multi-node external system, each node may attempt authentication independently, multiplying the lockout risk. The lockout itself requires DBA intervention to clear — the external system failure has now created an EBS operational task.

---

## Version-Specific API Capabilities

The available authentication and integration options differ significantly across EBS major versions.

### EBS 11i

The Integrated SOA Gateway does not exist in 11i. API integration in 11i is handled through:

- **XML Gateway**: EDI and XML document exchange using the Oracle e-Commerce Gateway. Inbound and outbound XML transactions flow through the \`ECX\` schema.
- **PL/SQL direct calls**: External systems connecting with JDBC or SQLNet can call APPS-schema PL/SQL packages directly using database credentials.
- **Oracle Workflow Business Events**: Inbound events can trigger workflow subscriptions through the Business Event System.
- **Forms API / FNDCPQR**: Concurrent program submission through standard API procedures.

For 11i, the only practical token-mediated authentication pattern is the read-only database service account (Pattern 3 below) or an API Gateway that terminates the external connection and makes direct JDBC calls using stored database credentials.

### EBS 12.1.3

The Integrated SOA Gateway is available and supported in 12.1.3. REST services are available from 12.1 onward, but with limitations:

- REST services in 12.1.3 run through the EBS Apache/OC4J tier, not WebLogic
- The \`irep_parser.pl\` tool is available and the Integration Repository is the registration mechanism
- Basic Authentication over HTTPS is the supported authentication protocol
- SOAP/WS-Security with Username Token is supported
- OAuth2 and JWT are not natively supported — external gateway mediation is required

The ISG configuration process in 12.1.3 uses the Oracle HTTP Server (Apache) and the OC4J container. REST endpoints are exposed on the \`iplanet\` or \`apache\` web tier port (typically 8000 or 443).

### EBS 12.2.x

The Integrated SOA Gateway in 12.2.x runs through Oracle WebLogic Server, specifically the OAFM managed server. This is the most feature-complete ISG environment:

- REST services are fully integrated with the WebLogic HTTP stack
- The REST endpoint URL structure is \`https://<host>:<port>/webservices/rest/<alias>/<method>/\`
- Authentication is via HTTP Basic Auth (EBS \`FND_USER\` credentials encoded as Base64 in the \`Authorization: Basic\` header) or Token-Based Authentication profile options
- WS-Security Username Token and, on patched instances, SAML assertions are supported for SOAP
- The OAFM server (\`oafm_server1\`) handles REST service deployment and generates Java wrapper code from the PL/SQL annotations
- OAuth2 and JWT still require external gateway mediation — they are not validated natively by the OAFM server

The 12.2.x ISG also benefits from Online Patching (ADOP) — ISG service changes can be made in the patch edition and promoted without downtime.

---

## Three Architectural Patterns

### Pattern 1: ISG REST or SOAP with HTTP Basic Auth

The Oracle-recommended integration path for transactional EBS access is through the Integrated SOA Gateway. External applications call the ISG endpoint over HTTPS and authenticate using EBS \`FND_USER\` credentials encoded in the HTTP Basic Auth header.

\`\`\`
[External Application]
    │
    │  HTTPS + Authorization: Basic <base64(user:pass)>
    ▼
[EBS ISG / OAFM Server]  ──► FND_USER validation
    │
    ▼
[PL/SQL Business Logic / APPS Schema]
\`\`\`

**When to use:** Inbound integrations that must execute EBS business logic — creating purchase orders, submitting concurrent programs, triggering workflow events, or calling standard EBS public API packages.

**Limitations:** The external system must hold EBS \`FND_USER\` credentials directly. Password rotation must be coordinated between EBS and the external system. Not suitable for systems that require OAuth2/JWT for compliance or that connect from environments where EBS credentials cannot be stored.

**Version support:**
- 11i: Not applicable (no ISG)
- 12.1.3: REST via Apache/OC4J; Basic Auth supported
- 12.2.x: REST via WebLogic OAFM; Basic Auth and Token-Based profile option

### Pattern 2: API Gateway Mediation (OAuth2 / JWT to EBS)

When external systems or security policy require OAuth2 or JWT bearer tokens — and the integration must execute EBS business logic, not just read data — an API Gateway sits between the external caller and the EBS ISG layer.

\`\`\`
[External Application]
    │
    │  1. OAuth2 flow → receives JWT from Identity Provider
    ▼
[Identity Provider: Azure AD / Okta / OAM / IDCS]
    │
    │  2. JWT bearer token sent to API Gateway
    ▼
[API Gateway: Azure APIM / Apigee / Oracle API Gateway]
    │
    │  3. Validate JWT (signature, expiry, scopes)
    │  4. Retrieve EBS credentials from Secrets Manager
    │  5. Construct Authorization: Basic header
    ▼
[EBS ISG / OAFM Server]  ──► FND_USER validation
    │
    ▼
[PL/SQL / APPS Schema]
\`\`\`

The external application's JWT is never sent to EBS. The EBS credentials are never exposed to the external application. The API Gateway is the only component that holds both, and it holds the EBS credential in encrypted, ephemeral memory for the duration of each request.

**When to use:** Modern cloud-to-on-premise integrations, multi-factor authentication enforcement, centralized audit logging across both the identity layer and the EBS layer, or any environment where external systems are not permitted to hold EBS application credentials directly.

**Version support:** All EBS versions — the gateway abstracts the protocol entirely. EBS sees only an HTTP Basic Auth request from a trusted source IP.

### Pattern 3: Read-Only Database Service Account

If the integration's sole purpose is to read EBS data — for reporting, staging, analytics, or data mining — the cleanest and most operationally stable approach bypasses the EBS application tier entirely.

\`\`\`
[External Application or API Gateway]
    │
    │  JDBC / SQLNet (TLS)
    ▼
[Oracle Database]
    │
    │  Dedicated read-only service account
    │  SELECT grants on specific APPS schema tables/views
    ▼
[APPS Schema tables: AR_PAYMENT_SCHEDULES_ALL, HZ_CUST_ACCOUNTS, etc.]
\`\`\`

A dedicated database user is created with \`SELECT\` privileges on only the required tables or views. No application-tier session is established. No \`FND_USER\` validation occurs. The service account credentials are managed at the database level and can be rotated independently of any EBS application user.

**When to use:** Read-only integrations — reporting dashboards, data warehouse feeds, audit exports, cross-system data mining (including the Salesforce-Oracle patterns covered elsewhere in this library).

**Why it is safe for read-only access:** The account cannot modify EBS data. Granting \`SELECT\` on specific views or tables does not expose the write path. Oracle's fine-grained audit settings can log every query the service account executes. Password rotation affects only the database-level credential, not any FND_USER or ISG configuration.

**Version support:** All EBS versions — the database service account model is independent of the EBS application version.

---

## ISG REST Service Configuration: PL/SQL Annotation

For 12.2.x environments using Pattern 1 or Pattern 2, exposing a custom PL/SQL package as an ISG REST service follows a specific sequence. The ISG engine does not discover packages automatically — each package must be annotated, parsed, registered in the Integration Repository, and deployed through the EBS functional UI.

### Step 1: Annotate the PL/SQL package specification

ISG reads metadata from structured inline comments in the package specification. These annotations define the service name, scope, HTTP verb, and method display name. Add them to your package \`CREATE OR REPLACE PACKAGE\` spec before the header comment:

\`\`\`sql
CREATE OR REPLACE PACKAGE xx_custom_pub AUTHID CURRENT_USER AS
/* \$Header: xx_custom_pub.pls 1.0 2026/07/16 12:00:00 appsdba noship \$ */

/*--
 * Custom public API for external integration.
 * @rep:scope public
 * @rep:product fnd
 * @rep:displayname Custom Integration API
 * @rep:category BUSINESS_ENTITY FND_USER
 */

/*--
 * Returns customer information by customer ID.
 * @rep:scope public
 * @rep:lifecycle active
 * @rep:displayname Get Customer Info
 * @rep:httpverb get
 */
PROCEDURE get_customer_info(
    p_customer_id    IN  NUMBER,
    x_customer_name  OUT VARCHAR2,
    x_status_code    OUT VARCHAR2
);

/*--
 * Creates a new service request.
 * @rep:scope public
 * @rep:lifecycle active
 * @rep:displayname Create Service Request
 * @rep:httpverb post
 */
PROCEDURE create_service_request(
    p_customer_id   IN  NUMBER,
    p_description   IN  VARCHAR2,
    x_request_id    OUT NUMBER,
    x_return_status OUT VARCHAR2,
    x_msg_data      OUT VARCHAR2
);

END xx_custom_pub;
/
\`\`\`

Key annotations:
- \`@rep:scope public\` — required for ISG to register the interface
- \`@rep:httpverb get|post|put|delete\` — determines the HTTP method for the generated REST endpoint
- \`@rep:lifecycle active\` — marks the method as deployable
- \`@rep:displayname\` — the human-readable name shown in the Integration Repository UI

Compile the package body separately. The annotations only need to appear in the spec.

### Step 2: Parse the spec with irep_parser.pl

The \`irep_parser.pl\` utility reads the annotated spec and generates an Integration Repository Loader (\`.ildt\`) file that the EBS Integration Repository can consume.

Run on the application tier as the \`applmgr\` OS user:

\`\`\`bash
# Source the EBS environment first
source /u01/applmgr/EBSPRD/EBSprd_appnode01.env

# Run the ISG parser
\$IAS_ORACLE_HOME/perl/bin/perl \$FND_TOP/bin/irep_parser.pl \\
  -user apps \\
  -password <apps_password> \\
  -isg \\
  -verbose \\
  fnd:patch/115/sql:xx_custom_pub.pls
\`\`\`

The format of the last argument is \`product:relative_path:filename\`. The file must exist at \`\$FND_TOP/patch/115/sql/xx_custom_pub.pls\` on the application tier.

Successful output ends with a line similar to:
\`\`\`
IREP Parser completed successfully. Output file: xx_custom_pub.ildt
\`\`\`

If the parser fails with annotation errors, the output includes the line number and the specific annotation that was not recognized.

### Step 3: Upload the .ildt file to the Integration Repository

\`\`\`bash
FNDLOAD apps/<apps_password> 0 Y UPLOAD \\
  \$FND_TOP/patch/115/import/wfintegs.lct \\
  xx_custom_pub.ildt
\`\`\`

Verify the upload succeeded:

\`\`\`sql
SELECT interface_alias,
       product_code,
       deploy_status,
       last_update_date
FROM   fnd_svc_components
WHERE  interface_alias LIKE 'XX_CUSTOM%';

-- Or query the integration repository tables directly
SELECT b.interface_alias,
       b.interface_type,
       b.deploy_status,
       b.last_updated_by
FROM   fnd_irep_all_interfaces_vl b
WHERE  b.interface_alias LIKE 'XX%'
ORDER  BY b.last_update_date DESC;
\`\`\`

### Step 4: Generate and deploy through the Integration Repository UI

Log in to EBS with the **Integration Administrator** responsibility:

1. Navigate to **Integrated SOA Gateway → Integration Repository**
2. Search by Name (Custom Integration API) or by Product Family
3. Select the interface from the results list
4. On the **REST Service** tab:
   - Enter a **Service Alias** (determines the URL path, e.g., \`customApi\`)
   - Select the methods to expose (\`get_customer_info\`, \`create_service_request\`)
   - Click **Generate** — status transitions to \`Generated\`
5. On the **Grants** tab:
   - Click **Create Grant**
   - Select the grantee type and the specific user or responsibility that will call the service
   - Grant the required methods
6. Back on the **REST Service** tab, click **Deploy** — status transitions to \`Deployed\`

The deployed endpoint URL follows the pattern:

\`\`\`
https://<ebs_host>:<oafm_port>/webservices/rest/<service_alias>/<method_name>/
\`\`\`

Example:
\`\`\`
https://ebs-prod.example.com:443/webservices/rest/customApi/get_customer_info/
\`\`\`

### Step 5: Test the deployed service

\`\`\`bash
curl -X POST https://ebs-prod.example.com:443/webservices/rest/customApi/get_customer_info/ \\
  -H "Content-Type: application/json" \\
  -H "username: EBS_API_USER" \\
  -H "password: <ebs_user_password>" \\
  -d '{
    "GET_CUSTOMER_INFO_Input": {
      "P_CUSTOMER_ID": 100452
    }
  }'
\`\`\`

A successful response returns an HTTP 200 with a JSON body containing the \`x_customer_name\` and \`x_status_code\` OUT parameters.

If the service returns HTTP 500 or a deployment error, check the OAFM server log:

\`\`\`bash
tail -200 \$DOMAIN_HOME/servers/oafm_server1/logs/oafm_server1.log | grep -i "error\|exception\|deploy"
\`\`\`

---

## API Gateway Architecture: JWT to EBS Credential Translation

When external systems must use OAuth2/JWT — and the integration must call ISG rather than a read-only database account — the API Gateway handles the protocol translation. The EBS ISG endpoint is never exposed directly to the external network.

### Azure API Management (APIM) configuration

**Enable Managed Identity on the APIM instance:**

In the Azure Portal, navigate to your APIM instance → **Identity** → **System-assigned** → On.

**Store the EBS service account password in Azure Key Vault:**

\`\`\`bash
az keyvault secret set \\
  --vault-name "enterprise-kv" \\
  --name "EbsServiceUserPassword" \\
  --value "<ebs_service_user_password>"
\`\`\`

**Grant the APIM managed identity access to the secret:**

\`\`\`bash
az keyvault set-policy \\
  --name "enterprise-kv" \\
  --object-id <apim_managed_identity_object_id> \\
  --secret-permissions get
\`\`\`

**Create a Named Value in APIM referencing the Key Vault secret:**

In the APIM portal: **Named Values → Add** → type \`Key Vault\` → reference the secret URI.

**Define the inbound policy for the EBS API:**

\`\`\`xml
<inbound>
    <base />
    <!-- Validate the incoming JWT from Azure AD -->
    <validate-jwt header-name="Authorization" failed-validation-httpcode="401">
        <openid-config url="https://login.microsoftonline.com/<tenant-id>/.well-known/openid-configuration" />
        <required-claims>
            <claim name="scp" match="any">
                <value>EBS.Read</value>
                <value>EBS.Write</value>
            </claim>
        </required-claims>
    </validate-jwt>
    <!-- Inject EBS Basic Auth using the Key Vault-sourced secret -->
    <authentication-basic
        username="EBS_API_GATEWAY_USER"
        password="{{EbsServiceUserPassword}}" />
</inbound>
\`\`\`

The incoming JWT is validated by APIM. The request forwarded to EBS carries only the Basic Auth header — the JWT is stripped. EBS sees a standard FND_USER credential.

### Apigee (Google Cloud) configuration

**Create an Encrypted Key-Value Map:**

\`\`\`bash
gcloud apigee kvms create EbsCredentials \\
  --environments production \\
  --project your-gcp-project
\`\`\`

**Add the EBS credential to the KVM:**

\`\`\`bash
gcloud apigee kvms entries create ServiceUserPassword \\
  --kvm EbsCredentials \\
  --environment production \\
  --value "<ebs_service_user_password>"
\`\`\`

**Apigee PreFlow policies (target endpoint):**

\`\`\`xml
<!-- Step 1: Retrieve credential from encrypted KVM -->
<KeyValueMapOperations name="Get-Ebs-Credential"
                       mapIdentifier="EbsCredentials">
    <Get assignTo="private.ebsPassword" index="1">
        <Key><Parameter>ServiceUserPassword</Parameter></Key>
    </Get>
</KeyValueMapOperations>

<!-- Step 2: Remove the inbound JWT and inject EBS Basic Auth -->
<AssignMessage name="Set-EBS-Auth">
    <Remove>
        <Headers>
            <Header name="Authorization" />
        </Headers>
    </Remove>
    <Set>
        <Headers>
            <Header name="Authorization">
                Basic {toBase64String(concat('EBS_API_GATEWAY_USER', ':', private.ebsPassword))}
            </Header>
        </Headers>
    </Set>
    <IgnoreUnresolvedVariables>false</IgnoreUnresolvedVariables>
    <AssignTo createNew="false" type="request" />
</AssignMessage>
\`\`\`

---

## Operational Security Recommendations

**Dedicated EBS service accounts per integration:** Never share a single EBS FND_USER account across multiple external integrations. If one integration is compromised or misbehaves, revoking its credential must not affect others. Name accounts descriptively: \`API_REPORTING_RO\`, \`API_GATEWAY_ISG\`, \`API_EXTAPP_CREATE_SR\`.

**EBS accounts for read-only access should not be FND_USER accounts:** Database-level service accounts with \`SELECT\` grants on specific tables are preferable for read-only integrations. They cannot be locked by the EBS application-layer lockout policy (\`FND_PROFILE\` signon attempts) — only by Oracle database-level profile limits.

**Enforce IP allowlisting on the EBS ISG port:** The OAFM server (12.2.x) or the Apache web tier (12.1.3) should accept inbound REST calls only from the known IP range of the API Gateway. Block all other source IPs at the network or firewall layer.

**Rate limiting at the gateway layer:** The EBS OAFM JVM heap is finite. An external client sending burst traffic to an ISG endpoint can exhaust JVM memory, causing managed server OOM failures. Configure rate limiting on the API Gateway (e.g., 50 requests/second per client application) to protect the EBS tier.

**Never disable FND_USER account lockout policy:** The lockout threshold (\`SIGNON_UNSUCCESSFUL_LIMIT\` profile) exists to protect EBS from credential stuffing. The correct response to lockout-causing integrations is to fix the credential management in the external system, not to disable the lockout protection.

---

## Summary

EBS does not natively validate OAuth2 or JWT tokens at the API layer. Implementing token-based authentication for EBS integrations requires selecting the right architectural pattern for the specific access type:

Read-only data access belongs in Pattern 3 — a dedicated database service account with minimal \`SELECT\` grants, completely bypassing the EBS application tier and its credential complexity.

Transactional integrations that must execute EBS business logic belong in Pattern 1 (ISG with Basic Auth, tolerating EBS credential management in the external system) or Pattern 2 (API Gateway mediation, where the gateway validates external tokens and translates them to EBS credentials stored in a secrets manager).

In EBS 11i, ISG is not available — direct PL/SQL calls over JDBC or XML Gateway transactions are the integration options. In 12.1.3, ISG REST services run through the Apache/OC4J tier with Basic Auth. In 12.2.x, ISG runs through the WebLogic OAFM server with full REST support and the annotation-driven \`irep_parser.pl\` registration process.

The ISG service deployment sequence — PL/SQL annotation, \`irep_parser.pl\` parsing, \`.ildt\` upload via FNDLOAD, REST service generation, grant creation, and deployment through the Integration Administrator responsibility — is the same across 12.1.3 and 12.2.x with the difference being the web tier stack. The OAFM server log is the first place to check for deployment failures in 12.2.x.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'Token-Based Authentication for Oracle EBS API Integration: ISG, API Gateway, and Service Account Patterns',
    slug,
    excerpt: 'Oracle EBS does not natively validate OAuth2 or JWT bearer tokens at the API endpoint layer. Integrations that require token-based authentication must choose one of three architectural patterns: ISG REST services with HTTP Basic Auth, an API Gateway mediation layer that validates external tokens and translates them to EBS FND_USER credentials, or a dedicated read-only database service account that bypasses the application tier entirely. This post covers all three patterns across EBS 11i, 12.1.3, and 12.2.x, the full ISG PL/SQL annotation and irep_parser.pl registration sequence, Azure APIM and Apigee JWT-to-Basic-Auth translation, and the operational security recommendations that prevent account lockouts and protect the OAFM tier from burst traffic.',
    content,
    category: 'ebs-isg',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
