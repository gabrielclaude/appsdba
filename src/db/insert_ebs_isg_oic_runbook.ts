import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Integrating Oracle EBS ISG with Oracle Integration Cloud',
  slug: 'ebs-isg-oracle-integration-cloud-runbook',
  excerpt:
    'End-to-end operational runbook for connecting Oracle Integration Cloud (OIC) to EBS via the Integrated SOA Gateway — covering the OIC Connectivity Agent for on-premises EBS, EBS Adapter connection configuration, outbound integration flow design (OIC trigger to EBS API invoke), request/response mapping, activation, monitoring, and troubleshooting.',
  category: 'ebs-isg' as const,
  published: true,
  publishedAt: new Date('2026-05-31'),
  youtubeUrl: null,
  content: `## Purpose

Connect Oracle Integration Cloud (OIC) to an Oracle E-Business Suite instance via the Integrated SOA Gateway and build a working integration flow that invokes an EBS API from OIC in response to an external trigger.

---

## Scope and Assumptions

- Oracle Integration Cloud Generation 3 (OIC3) on Oracle Cloud Infrastructure
- EBS 12.2.x with ISG enabled and at least one service already deployed (see the ISG Deployment Runbook)
- EBS is on-premises or in a private network — the OIC Connectivity Agent is required. If EBS is directly internet-accessible, the Agent steps are skipped.
- The target EBS ISG service (\`HrEmployeeService\`) is deployed, WSDL is accessible, and the integration service account (\`OIC_INTEGRATION\`) has execute permission on the service
- OIC user has the **ServiceAdministrator** or **ServiceDeveloper** role

---

## Architecture

\`\`\`
External Client
     |
     v
OIC REST Trigger Endpoint
     |
     v
OIC Integration Flow (mapper + error handling)
     |
     v  (via OIC Connectivity Agent tunnel if EBS is on-premises)
EBS ISG REST/SOAP Endpoint
     |
     v
EBS PL/SQL API (HR_EMPLOYEE_API)
     |
     v
EBS Database
\`\`\`

The **OIC Connectivity Agent** is a lightweight Java process installed on a host that can reach EBS. It opens an outbound HTTPS tunnel to OIC and proxies OIC's outbound calls to EBS through that tunnel — no inbound firewall ports need to be opened on the EBS network.

---

## Reference Variables

\`\`\`
OIC_INSTANCE_URL       = https://oic-tenant.integration.ocp.oraclecloud.com
OIC_REGION             = us-ashburn-1
EBS_ISG_HOST           = ebs-app.example.com
EBS_ISG_PORT           = 4443
EBS_WSDL_URL           = https://ebs-app.example.com:4443/webservices/rest/HrEmployeeService?WADL
EBS_SERVICE_ACCOUNT    = OIC_INTEGRATION
EBS_RESPONSIBILITY     = HR_MANAGER
EBS_RESP_APPLICATION   = PER
EBS_ORG_ID             = 204
AGENT_HOST             = oic-agent.example.com  (host on EBS network)
AGENT_INSTALLER_DIR    = /u01/oic_agent
CONNECTION_NAME        = EBS-HrEmployeeService
INTEGRATION_NAME       = CreateEBSEmployee
\`\`\`

---

## Pre-Flight Checks

### 1. Confirm OIC instance is running

Log in to OIC. Navigate to **Home > Integrations**. If the page loads without error the instance is operational.

Confirm your OIC URL pattern:

\`\`\`
https://<instance-name>.integration.ocp.oraclecloud.com/ic/home
\`\`\`

### 2. Confirm EBS ISG service is reachable from the agent host

\`\`\`bash
# On the agent host (oic-agent.example.com)
curl -sk -o /dev/null -w "%{http_code}" \
  -u OIC_INTEGRATION:password \
  "https://ebs-app.example.com:4443/webservices/rest/HrEmployeeService?WADL"
# Expected: 200
\`\`\`

If the response is not 200, resolve the ISG connectivity issue before proceeding. The agent cannot proxy calls it cannot reach.

### 3. Confirm the EBS SSL certificate is trusted by the agent JVM

\`\`\`bash
# Extract the EBS certificate
openssl s_client -connect ebs-app.example.com:4443 -showcerts \
  </dev/null 2>/dev/null | openssl x509 -outform PEM > /tmp/ebs_cert.pem

# Import into the agent JVM trust store (password: changeit by default)
$JAVA_HOME/bin/keytool -import \
  -alias ebs-isg \
  -keystore $JAVA_HOME/lib/security/cacerts \
  -file /tmp/ebs_cert.pem \
  -storepass changeit \
  -noprompt

echo "Certificate imported"
\`\`\`

If the EBS certificate is signed by an enterprise CA, import the CA root instead.

### 4. Confirm OIC agent download is available

Log in to OIC. Navigate to **Home > Settings > Agents**. The **Download** button for the **Connectivity Agent** must be present. You will need this in Step 1.

---

## Step 1 — Install the OIC Connectivity Agent (On-Premises EBS Only)

Skip this step if EBS ISG is directly reachable from OIC over the internet.

### 1a. Download the agent installer from OIC

In OIC: **Settings > Agents > Download**. Select **Connectivity Agent**. Download the ZIP to \`$AGENT_INSTALLER_DIR\` on the agent host.

\`\`\`bash
# On agent host
mkdir -p /u01/oic_agent
cd /u01/oic_agent
unzip oic_connectivity_agent_*.zip
\`\`\`

### 1b. Configure the agent properties

Edit \`/u01/oic_agent/agent-installer/config/InstallerProfile.cfg\`:

\`\`\`
# OIC instance connection details
oic_URL=https://oic-tenant.integration.ocp.oraclecloud.com
agent_GROUP_IDENTIFIER=EBS_AGENT_GROUP
oic_USER=oic-agent-user@example.com
\`\`\`

\`agent_GROUP_IDENTIFIER\` is a logical name for this agent group. Use something descriptive — OIC connections reference agent groups, not individual agents.

### 1c. Run the agent installer

\`\`\`bash
cd /u01/oic_agent/agent-installer
java -jar oic-connectivity-agent-installer.jar
\`\`\`

Enter the OIC user password when prompted. The installer registers the agent group with your OIC instance and outputs the agent binary directory.

### 1d. Start the agent

\`\`\`bash
cd /u01/oic_agent/agent
nohup ./agent.sh start > /u01/oic_agent/logs/agent.log 2>&1 &
\`\`\`

### 1e. Verify agent registration in OIC

In OIC: **Settings > Agents**. The agent group \`EBS_AGENT_GROUP\` should appear with status \`Active\`. Allow up to 2 minutes for the initial heartbeat.

\`\`\`bash
# Check agent log for confirmation
grep -i 'connected\|registered\|heartbeat' /u01/oic_agent/logs/agent.log | tail -20
\`\`\`

### 1f. Configure agent as a system service (optional but recommended)

\`\`\`bash
# Create a systemd unit file
cat > /etc/systemd/system/oic-agent.service <<'EOF'
[Unit]
Description=Oracle Integration Cloud Connectivity Agent
After=network.target

[Service]
Type=forking
User=oracle
ExecStart=/u01/oic_agent/agent/agent.sh start
ExecStop=/u01/oic_agent/agent/agent.sh stop
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable oic-agent
systemctl start oic-agent
\`\`\`

---

## Step 2 — Create the EBS Adapter Connection in OIC

In OIC: **Home > Integrations > Connections > Create**

### 2a. Select the adapter

Search for and select **Oracle E-Business Suite**. This adapter understands ISG's WSDL/WADL structure and automatically handles responsibility context headers.

### 2b. Configure connection properties

**Connection Name:** \`EBS-HrEmployeeService\`

**Connection Role:** \`Invoke\` (OIC will call EBS — EBS is not initiating)

**Connection Properties:**

\`\`\`
EBS Service Catalog WSDL URL:
  https://ebs-app.example.com:4443/webservices/rest/HrEmployeeService?WADL

EBS Host:   ebs-app.example.com
EBS Port:   4443
SSL:        Yes
\`\`\`

**Connectivity Agent** (on-premises EBS only):

\`\`\`
Agent Group: EBS_AGENT_GROUP
\`\`\`

### 2c. Configure security credentials

**Security Policy:** \`Basic Authentication\`

\`\`\`
Username: OIC_INTEGRATION
Password: <service account password>
\`\`\`

### 2d. Configure the EBS responsibility context

The EBS Adapter has a dedicated section for responsibility headers. Expand **EBS Context Properties**:

\`\`\`
Responsibility:       HR_MANAGER
Responsibility App:   PER
Security Group:       STANDARD
NLS Language:         AMERICAN
Org ID:               204
\`\`\`

These values are injected as HTTP headers on every call OIC makes through this connection. Set them to a generic integration responsibility — individual callers should not hardcode responsibilities; the connection sets them centrally.

### 2e. Save and test the connection

Click **Save**, then **Test**. OIC will attempt to retrieve the WSDL/WADL from the configured URL through the agent (if on-premises).

**Expected result:** A green \`Connection was successful\` banner.

**If test fails:** Check the agent log, confirm the WSDL URL is reachable from the agent host, and verify the service account credentials.

---

## Step 3 — Create the Integration Flow

In OIC: **Home > Integrations > Create**. Select **Application** as the integration style.

### 3a. Configure the trigger (inbound)

The trigger defines how external callers invoke this OIC integration.

Click the **+** trigger slot. Select **REST** adapter.

**Connection Name:** Create a new REST connection named \`REST-TriggerEndpoint\` or select an existing one.

**Configure the REST trigger:**

\`\`\`
Endpoint Name:   CreateEBSEmployee
Endpoint URL:    /employees
HTTP Method:     POST
Request Body:    JSON Sample (paste sample below)
Response Body:   JSON Sample
\`\`\`

**Sample request JSON** (paste into the OIC wizard):

\`\`\`json
{
  "hireDate": "2026-06-01",
  "businessGroupId": 81,
  "lastName": "SMITH",
  "firstName": "JOHN",
  "sex": "M",
  "personTypeId": 1
}
\`\`\`

**Sample response JSON:**

\`\`\`json
{
  "status": "SUCCESS",
  "personId": 12345,
  "assignmentId": 67890,
  "message": ""
}
\`\`\`

Click **Next** through the wizard and **Done**.

### 3b. Configure the invoke (EBS outbound call)

Click the **+** invoke slot between the trigger and the response. Select the \`EBS-HrEmployeeService\` connection.

**Configure the EBS invoke:**

\`\`\`
What do you want to call this endpoint?   InvokeCreateEmployee
What is the operation?                    CreateEmployee
                                          (select from the list — OIC reads the WADL)
Request type:                             JSON
Response type:                            JSON
\`\`\`

OIC reads the WADL from EBS and presents the available methods. Select \`CreateEmployee\` (or whichever method maps to \`HR_EMPLOYEE_API.CREATE_EMPLOYEE\`).

Click **Done**.

---

## Step 4 — Map the Request

OIC creates a mapper between the trigger request and the EBS invoke request. Click the **Map** icon between the trigger and the EBS invoke.

### 4a. Map trigger fields to EBS API parameters

Drag and drop from the left (trigger source) to the right (EBS target):

\`\`\`
hireDate       --> P_HIRE_DATE
businessGroupId--> P_BUSINESS_GROUP_ID
lastName       --> P_LAST_NAME
firstName      --> P_FIRST_NAME
sex            --> P_SEX
personTypeId   --> P_PERSON_TYPE_ID
\`\`\`

### 4b. Set fixed values for non-variable parameters

Some EBS API parameters are fixed for all calls through this integration. Use the **Literal** function in the mapper:

\`\`\`
P_VALIDATE         --> false      (commit the transaction)
P_EMPLOYEE_NUMBER  --> (leave unmapped — EBS auto-generates)
\`\`\`

To set a literal: in the target parameter field, click the function icon and enter:

\`\`\`
xp20:lower-case("false")
\`\`\`

Or simply type \`false\` as a string literal in the expression editor.

### 4c. Date format transformation

OIC trigger receives ISO date (\`2026-06-01\`). EBS API expects Oracle date format. Add a transformation using the mapper's built-in \`fn:concat\` or date functions if the format needs converting. For most 12.2 ISG REST endpoints, ISO-8601 date strings are accepted directly.

Click **Validate** in the mapper to confirm there are no unresolved required fields, then **Close**.

---

## Step 5 — Map the Response

Click the **Map** icon between the EBS invoke response and the trigger response.

### 5a. Map EBS output parameters to the trigger response

\`\`\`
X_RETURN_STATUS   --> (use in expression for "status" field)
X_PERSON_ID       --> personId
X_ASSIGNMENT_ID   --> assignmentId
X_MSG_DATA        --> message
\`\`\`

### 5b. Transform X_RETURN_STATUS to a readable status string

In the mapper expression editor for the \`status\` field:

\`\`\`
if (X_RETURN_STATUS = "S") then "SUCCESS"
else if (X_RETURN_STATUS = "E") then "ERROR"
else "UNEXPECTED_ERROR"
\`\`\`

Click **Validate**, then **Close**.

---

## Step 6 — Add Error Handling

OIC integrations should handle EBS API errors gracefully rather than returning a raw fault to the caller.

### 6a. Add a global fault handler

In the integration canvas, click the **Global Fault Handler** scope (the red error path at the bottom of the canvas).

Add a **Return** action in the fault handler and map:

\`\`\`
fault.message  --> message
"ERROR"        --> status (literal)
"0"            --> personId (literal)
"0"            --> assignmentId (literal)
\`\`\`

### 6b. Add a scope with a fault handler for the EBS invoke

Wrap the EBS invoke action in a **Scope** action. Add a fault handler to the scope. In the fault handler, log the error using a **Logger** action and re-throw or return a structured error response.

---

## Step 7 — Configure Tracking Fields

OIC requires at least one tracking field to identify integration instances in the monitoring console. Click **Tracking** in the top right of the canvas.

Drag a source field to the tracking slot:

\`\`\`
Tracking Field 1:  lastName    (identifies the employee being created)
Tracking Field 2:  hireDate
\`\`\`

---

## Step 8 — Activate the Integration

Click **Save**, then **Activate**.

**Activation options:**

\`\`\`
Enable Tracing:     Yes (recommended for initial deployment; disable after stabilization)
Include Payload:    Yes (during testing — logs full request/response; disable for production)
\`\`\`

Click **Activate**.

**Expected:** The integration moves from \`Configured\` to \`Active\` state and OIC displays the REST endpoint URL:

\`\`\`
https://oic-tenant.integration.ocp.oraclecloud.com/ic/api/integration/v1/flows/rest/CREATEEBSEMPLOYEE/1.0/employees
\`\`\`

---

## Step 9 — Test the Integration End to End

### 9a. Retrieve the OIC endpoint URL and authentication

The endpoint URL is shown on the integration tile after activation. OIC REST triggers require **Basic Authentication** with an OIC user credential or an **OAuth token**.

### 9b. Send a test request

\`\`\`bash
curl -sk -X POST \
  -H "Content-Type: application/json" \
  -u oic-caller-user@example.com:password \
  "https://oic-tenant.integration.ocp.oraclecloud.com/ic/api/integration/v1/flows/rest/CREATEEBSEMPLOYEE/1.0/employees" \
  -d '{
    "hireDate": "2026-06-01",
    "businessGroupId": 81,
    "lastName": "TESTUSER",
    "firstName": "JOHN",
    "sex": "M",
    "personTypeId": 1
  }'
\`\`\`

**Expected response:**

\`\`\`json
{
  "status": "SUCCESS",
  "personId": 10042,
  "assignmentId": 20087,
  "message": ""
}
\`\`\`

### 9c. Verify the record was created in EBS

\`\`\`sql
-- On the EBS database
SELECT papf.person_id, papf.last_name, papf.first_name,
       papf.start_date, papf.effective_start_date
FROM per_all_people_f papf
WHERE papf.last_name = 'TESTUSER'
  AND papf.effective_end_date = DATE '4712-12-31'
ORDER BY papf.effective_start_date DESC;
\`\`\`

### 9d. Review the instance in OIC Monitoring

In OIC: **Home > Monitoring > Integrations > Tracking**

Locate the test instance by the tracking field value (\`TESTUSER\`). Click to open the instance details. Verify:

- All activity steps show green checkmarks
- The EBS invoke step shows HTTP 200
- The response payload matches the EBS API output

---

## Step 10 — Post-Activation Checklist

- Integration status is **Active** in OIC
- Test call returns HTTP 200 with \`"status": "SUCCESS"\`
- EBS record confirmed in \`PER_ALL_PEOPLE_F\`
- OIC monitoring shows successful instance trace
- EBS audit trail confirms the record was created by the \`OIC_INTEGRATION\` user
- Enable Tracing is set appropriately (on during stabilization, off for steady-state production to reduce storage)

Verify the EBS audit entry:

\`\`\`sql
SELECT who_column.last_updated_by, fnd_user.user_name, papf.last_name
FROM per_all_people_f papf
JOIN fnd_user ON fnd_user.user_id = papf.last_updated_by
WHERE papf.last_name = 'TESTUSER';
-- Expected: user_name = OIC_INTEGRATION
\`\`\`

---

## Ongoing Monitoring

### OIC integration activity dashboard

In OIC: **Monitoring > Integrations > Dashboard**

Review:
- **Success rate** — percentage of integration instances that completed without fault
- **Average latency** — end-to-end time from trigger receipt to response
- **Error count** — any non-zero value requires investigation

### View failed instances

In OIC: **Monitoring > Integrations > Errors**

Failed instances show the step where the fault occurred and the fault message. For EBS-related failures, the fault message will contain the EBS API error text or HTTP status code.

### Resubmit failed instances

OIC allows manual resubmission of failed instances directly from the monitoring console without rebuilding the request:

**Monitoring > Integrations > Errors > select instance > Resubmit**

Use resubmission carefully — verify the root cause before resubmitting to avoid creating duplicate records in EBS.

### OIC agent health

\`\`\`bash
# On the agent host
grep -i 'heartbeat\|error\|disconnect\|reconnect' \
  /u01/oic_agent/logs/agent.log | tail -50
\`\`\`

In OIC: **Settings > Agents** — confirm the agent group shows \`Active\` with a recent heartbeat timestamp.

---

## Troubleshooting

### Connection test fails — \`Unable to connect to endpoint\`

\`\`\`bash
# From the agent host — confirm WSDL is reachable
curl -sk -o /dev/null -w "%{http_code}" \
  -u OIC_INTEGRATION:password \
  "https://ebs-app.example.com:4443/webservices/rest/HrEmployeeService?WADL"
\`\`\`

If 200: the agent host can reach EBS but OIC cannot reach the agent. Check that the agent service is running and has an active OIC heartbeat.

If not 200: resolve the EBS network/ISG issue first. The agent cannot proxy what it cannot reach.

### Integration instance fails at EBS invoke — HTTP 401

OIC is sending credentials that EBS is rejecting. Verify:

- The EBS service account (\`OIC_INTEGRATION\`) password has not expired
- The account has not been locked (check \`FND_USER.LAST_LOGON_DATE\` and \`END_DATE\`)
- The OIC connection security credentials are current

\`\`\`sql
SELECT user_name, start_date, end_date, last_logon_date,
       encrypted_user_password
FROM fnd_user WHERE user_name = 'OIC_INTEGRATION';
\`\`\`

Re-enter the password in the OIC connection and re-test.

### Integration instance fails at EBS invoke — HTTP 500 with no body

Check the oafm_server1 log on EBS for the corresponding request:

\`\`\`bash
grep -A 20 'HrEmployeeService\|OIC_INTEGRATION' \
  $LOG_HOME/appl/oafm/oafm_server1*.log | tail -80
\`\`\`

Common causes: missing mandatory parameter, wrong data type, DATE format mismatch. The oafm log shows the full stack trace.

### EBS API returns \`X_RETURN_STATUS = E\` — application error

The EBS API ran successfully but rejected the business data. The error text is in \`X_MSG_DATA\`. Surface this to the caller and log it:

In OIC monitoring, click the failed instance and expand the EBS invoke step. The response payload shows \`X_MSG_DATA\` with the specific EBS validation message (e.g. \`APP-PER-50022: Employee number already exists\`).

Resolution: fix the source data and resubmit the instance.

### Agent loses connectivity and OIC shows agent \`Inactive\`

\`\`\`bash
# Check agent logs for disconnect reason
tail -100 /u01/oic_agent/logs/agent.log

# Restart the agent service
systemctl restart oic-agent
\`\`\`

In OIC: **Settings > Agents** — the agent group status should return to \`Active\` within 2 minutes of agent restart.

If the agent repeatedly disconnects, verify:
- Outbound HTTPS (port 443) from the agent host to \`*.integration.ocp.oraclecloud.com\` is not blocked
- No corporate proxy is intercepting and breaking the long-lived HTTPS tunnel

### Mapper validation error — required EBS parameter not mapped

In the OIC mapper, required parameters (those without a default in the WADL) are flagged red if unmapped. Common omissions:

- \`P_VALIDATE\` — must be explicitly mapped to \`false\` for production transactions
- \`P_API_VERSION_NUMBER\` — typically \`1.0\`, set as a literal
- Complex type parameters (RECORD types) — must be expanded in the mapper to reveal child fields

---

## Rollback

### Deactivate the integration

In OIC: **Integrations > select integration > Deactivate**

The trigger endpoint becomes unavailable immediately. In-flight instances that have already reached the EBS invoke step will complete; new requests after deactivation receive HTTP 404.

### Delete the integration and connection

\`\`\`
Integrations > select integration > Delete
Connections  > EBS-HrEmployeeService > Delete
\`\`\`

### Stop and unregister the Connectivity Agent

\`\`\`bash
# On agent host
systemctl stop oic-agent
systemctl disable oic-agent
\`\`\`

In OIC: **Settings > Agents > EBS_AGENT_GROUP > Delete**

### Revoke the EBS service account grant

\`\`\`sql
-- On EBS as APPS
DELETE FROM apps.irc_service_grants
WHERE alias_name = 'HrEmployeeService'
  AND grantee_user_name = 'OIC_INTEGRATION';
COMMIT;
\`\`\``,
};

async function main() {
  console.log('Inserting EBS ISG + OIC runbook post...');
  await db.insert(posts).values(post).onConflictDoNothing();
  console.log(`Inserted: "${post.title}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
