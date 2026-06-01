import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Deploying the Oracle EBS Integrated SOA Gateway',
  slug: 'ebs-isg-deployment-runbook',
  excerpt:
    'Step-by-step operational runbook for enabling and deploying the Oracle E-Business Suite Integrated SOA Gateway — covering profile option configuration, responsibility grants, ISG administrator setup, service deployment from the Interface Repository, Service Alias creation, endpoint testing, and troubleshooting for both EBS 12.1 (OC4J) and EBS 12.2 (WebLogic).',
  category: 'ebs-isg' as const,
  published: true,
  publishedAt: new Date('2026-05-31'),
  youtubeUrl: null,
  content: `## Purpose

Enable the Oracle E-Business Suite Integrated SOA Gateway (ISG), configure its runtime environment, and deploy a working SOAP and REST service endpoint from the EBS Interface Repository.

---

## Scope and Assumptions

- EBS 12.1.3 or EBS 12.2.x (differences between the two are called out at each step)
- APPS DBA has access to the application server (OC4J on 12.1; WebLogic on 12.2)
- The EBS application tier is running and the middle tier services are healthy
- At least one EBS user with System Administrator access is available
- The target interface (PL/SQL API, Business Event, or Concurrent Program) is already registered in the Interface Repository — registration happens automatically with EBS patching

---

## Reference Variables

\`\`\`
EBS_HOST              = ebs-app.example.com
EBS_PORT (HTTPS)      = 4443
EBS_PORT (HTTP)       = 8000
APPS_USER             = apps
WEBLOGIC_ADMIN_URL    = http://ebs-app.example.com:7001/console  (12.2 only)
WEBLOGIC_ADMIN_USER   = weblogic
OC4J_HOME             = $ORACLE_HOME/opmn/                        (12.1 only)
ISG_RESP              = Integrated SOA Gateway Administrator
ISG_APP               = FND
SERVICE_ALIAS         = HrEmployeeService
INTERFACE_PACKAGE     = HR_EMPLOYEE_API
\`\`\`

---

## Pre-Flight Checks

### 1. Confirm ISG patch is applied

ISG requires ATG Rollup Patch 6 (RUP6) or later on 12.1, and is included in the base 12.2 release. Confirm the ISG schema objects are present:

\`\`\`sql
-- Connect as APPS
SELECT COUNT(*) FROM user_tables WHERE table_name LIKE 'IRC%';
-- Expected: 20+ tables
\`\`\`

\`\`\`sql
SELECT COUNT(*) FROM user_objects
WHERE object_name LIKE 'FND_SOA%' AND status = 'VALID';
-- Expected: several valid packages
\`\`\`

### 2. Confirm the application tier is running

**EBS 12.2 — WebLogic:**

\`\`\`bash
# As oracle OS user on the EBS app tier
$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh status oacore_server1
$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh status oafm_server1
\`\`\`

**Expected:** Both servers in \`RUNNING\` state.

**EBS 12.1 — OC4J:**

\`\`\`bash
$ORACLE_HOME/opmn/bin/opmnctl status
\`\`\`

**Expected:** All components in \`Alive\` state.

### 3. Confirm the ISG servlet is deployed

**EBS 12.2:**

\`\`\`bash
curl -sk -o /dev/null -w "%{http_code}" \
  https://ebs-app.example.com:4443/webservices/rest
\`\`\`

**Expected:** \`200\` or \`401\` (authentication required — both confirm the servlet is up). A \`404\` or connection refused means ISG is not deployed on this application server.

### 4. Verify the Interface Repository is populated

\`\`\`sql
SELECT COUNT(*) FROM apps.irc_interface_properties_b;
-- Expected: several thousand rows for a fully patched system
\`\`\`

---

## Step 1 — Set Required EBS Profile Options

Profile options control ISG's runtime behaviour. Set them at **Site** level unless noted otherwise.

Log in to EBS as System Administrator. Navigate to:

**System Administrator > Profile > System**

Set the following profile options:

**\`FND_SOA_SERVICE_PROVIDER_URL\`**
The base URL the ISG runtime uses to construct WSDL and endpoint addresses. Must be externally reachable by callers.

\`\`\`
Value: https://ebs-app.example.com:4443
\`\`\`

**\`FND_SOA_PROVIDER_PROTOCOL\`**

\`\`\`
Value: https
\`\`\`

**\`FND_SOA_PROVIDER_PORT\`**

\`\`\`
Value: 4443
\`\`\`

**\`FND_SOA_PROVIDER_HOST\`**

\`\`\`
Value: ebs-app.example.com
\`\`\`

**\`FND_SOA_REST_SERVICE_ENABLED\`** (12.2 only — enables REST in addition to SOAP)

\`\`\`
Value: Y
\`\`\`

**\`FND_SOA_DEFAULT_WSDL_STYLE\`**

\`\`\`
Value: DOCUMENT  (recommended; ENCODED is legacy)
\`\`\`

**\`FND_SOA_DEPLOYMENT_TIMEOUT\`**

\`\`\`
Value: 120  (seconds — increase to 300 for large package deployments)
\`\`\`

Verify the values are saved by querying directly:

\`\`\`sql
SELECT profile_option_name, profile_option_value
FROM fnd_profile_option_values fpov
JOIN fnd_profile_options fpo
  ON fpo.profile_option_id = fpov.profile_option_id
WHERE fpo.profile_option_name IN (
  'FND_SOA_SERVICE_PROVIDER_URL',
  'FND_SOA_PROVIDER_HOST',
  'FND_SOA_PROVIDER_PORT',
  'FND_SOA_REST_SERVICE_ENABLED'
)
AND fpov.level_id = 10001  -- Site level
ORDER BY profile_option_name;
\`\`\`

---

## Step 2 — Grant the ISG Administrator Responsibility

The **Integrated SOA Gateway Administrator** responsibility is required to browse the Interface Repository and deploy services. Grant it to the DBA or integration developer who will perform deployments.

### 2a. Via EBS UI

Log in as System Administrator. Navigate to:

**Security > User > Define**

Search for the user. Add the responsibility:

\`\`\`
Responsibility: Integrated SOA Gateway Administrator
Application:    Oracle Application Object Library
\`\`\`

### 2b. Via SQL (for bulk grants or scripted provisioning)

\`\`\`sql
DECLARE
  l_user_id   NUMBER;
  l_resp_id   NUMBER;
  l_app_id    NUMBER;
BEGIN
  SELECT user_id INTO l_user_id
  FROM fnd_user WHERE user_name = 'JSMITH';

  SELECT responsibility_id, application_id
  INTO l_resp_id, l_app_id
  FROM fnd_responsibility_vl
  WHERE responsibility_name = 'Integrated SOA Gateway Administrator';

  fnd_user_resp_groups_api.insert_assignment (
    user_id               => l_user_id,
    responsibility_id     => l_resp_id,
    responsibility_appl_id => l_app_id,
    security_group_id     => 0,
    start_date            => SYSDATE,
    end_date              => NULL,
    description           => 'ISG Admin access'
  );
  COMMIT;
END;
/
\`\`\`

### 2c. Bounce the ISG user's session or wait for cache expiry

Responsibility grants are cached per session. The user must log out and back in before the new responsibility appears.

---

## Step 3 — Configure the SOA Provider (12.2 WebLogic Only)

On EBS 12.2, ISG services run in the \`oafm_server1\` managed server. The web services context root must be confirmed in the WebLogic deployment.

### 3a. Verify the ISG application is deployed in WebLogic

Log in to the WebLogic Administration Console:

\`\`\`
http://ebs-app.example.com:7001/console
\`\`\`

Navigate to **Deployments**. Confirm the following applications are in **Active** state:

- \`FndSvcServlet\` — the core ISG servlet that handles service dispatch
- \`oafm\` — the Oracle Application Framework Middleware server

If either is not deployed or is in a failed state, proceed to Step 3b.

### 3b. Re-deploy the ISG servlet if missing (12.2)

\`\`\`bash
# On EBS app tier as oracle OS user
# Source the EBS environment
. $EBS_ENV_FILE

# Run the ISG deployment utility
$FND_TOP/patch/115/bin/fndsoacfg.sh \
  -apps_user apps \
  -apps_pwd "$APPS_PASSWORD" \
  -server oafm_server1
\`\`\`

Then restart the oafm managed server:

\`\`\`bash
$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh stop  oafm_server1
$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh start oafm_server1
\`\`\`

### 3c. Verify SSL certificate is valid for the ISG host

ISG WSDL and endpoint URLs use HTTPS. Callers will fail if the certificate is self-signed and they do not have it in their trust store.

\`\`\`bash
openssl s_client -connect ebs-app.example.com:4443 -showcerts </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
\`\`\`

If the certificate is about to expire or is self-signed, coordinate with the EBS admin to replace it before deploying services to production callers.

---

## Step 4 — Browse and Select the Interface in the Repository

Log in to EBS with the **Integrated SOA Gateway Administrator** responsibility.

Navigate to:

**Integrated SOA Gateway > Integration Repository**

### 4a. Search for the target interface

Use the search filters:

- **Interface Type:** PL/SQL, Java Bean, Business Event, Concurrent Program, or XML Gateway
- **Product Family:** Select the relevant EBS module (e.g. Human Resources, Purchasing, Receivables)
- **Interface Name:** Enter a partial name to narrow results (e.g. \`EMPLOYEE\`)

### 4b. Review the interface definition

Click the interface name to open its detail page. Review:

- **Procedure list** — each deployable method within the package
- **Parameter details** — name, data type (\`VARCHAR2\`, \`NUMBER\`, \`DATE\`, \`RECORD\`, \`TABLE\`), direction (\`IN\`, \`OUT\`, \`IN OUT\`), and whether mandatory
- **Notes** — any Oracle-documented restrictions on the interface

**Flag for attention:** If any parameter is of type \`RECORD\` or \`TABLE\` (PL/SQL complex types), confirm the calling system can serialize them correctly. REST/JSON callers handle nested JSON objects for RECORD types and JSON arrays for TABLE types.

---

## Step 5 — Deploy the Interface as a Web Service

From the interface detail page, click **Deploy**.

### 5a. Complete the Deployment Wizard

**Service Alias Name**

\`\`\`
HrEmployeeService
\`\`\`

Must be unique across all deployed services. Use PascalCase by convention. This name appears in the endpoint URL.

**Service Alias Description**

\`\`\`
HR Employee API — create, update, and query employee records
\`\`\`

**Authentication Type**

\`\`\`
Username Token  (for most integrations)
\`\`\`

Select \`None\` only for internal development/testing environments. Never deploy without authentication on a production system.

**Protocol** (12.2 only)

\`\`\`
SOAP and REST
\`\`\`

Deploying both protocols from a single deployment is supported. They share the same Service Alias but have distinct endpoint paths.

**OWSM Policy** (optional — 12.2 with OWSM configured)

Leave blank unless Oracle Web Services Manager is in use. If OWSM is configured, attach the appropriate policy here (e.g. \`oracle/wss_username_token_service_policy\`).

### 5b. Submit and confirm

Click **Deploy**. The page will display a progress indicator. On completion:

\`\`\`
Deployment Status: Deployed Successfully
SOAP Endpoint: https://ebs-app.example.com:4443/webservices/soap/HrEmployeeService
REST Endpoint: https://ebs-app.example.com:4443/webservices/rest/HrEmployeeService
WSDL URL:      https://ebs-app.example.com:4443/webservices/soap/HrEmployeeService?WSDL
WADL URL:      https://ebs-app.example.com:4443/webservices/rest/HrEmployeeService?WADL
\`\`\`

If the deployment fails with a timeout, increase \`FND_SOA_DEPLOYMENT_TIMEOUT\` (Step 1) and retry.

---

## Step 6 — Verify the Service Alias in the Database

\`\`\`sql
SELECT alias_name, deploy_status, soap_url, rest_url,
       deployed_by, deployed_date
FROM apps.irc_service_deployments
WHERE alias_name = 'HrEmployeeService';
\`\`\`

**Expected:**

\`\`\`
ALIAS_NAME         DEPLOY_STATUS  SOAP_URL                          ...
-----------------  -------------  --------------------------------  ---
HrEmployeeService  DEPLOYED       .../webservices/soap/HrEmployee   ...
\`\`\`

If \`DEPLOY_STATUS\` is \`ERROR\`, check the deployment log:

\`\`\`sql
SELECT message_text, message_date
FROM apps.irc_service_deploy_log
WHERE alias_name = 'HrEmployeeService'
ORDER BY message_date DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

---

## Step 7 — Retrieve and Validate the WSDL

\`\`\`bash
curl -sk \
  -u JSMITH:password \
  "https://ebs-app.example.com:4443/webservices/soap/HrEmployeeService?WSDL" \
  | xmllint --format - | head -60
\`\`\`

**Expected:** Well-formed XML starting with \`<definitions xmlns=...\` and containing \`<portType>\` and \`<binding>\` elements for each deployed procedure.

For REST, retrieve the WADL:

\`\`\`bash
curl -sk \
  -u JSMITH:password \
  "https://ebs-app.example.com:4443/webservices/rest/HrEmployeeService?WADL" \
  | xmllint --format - | head -60
\`\`\`

If either returns \`401 Unauthorized\`, the user does not have access to the deployed service or the authentication header is malformed.

If either returns \`404 Not Found\`, the service is deployed in the database but the servlet has not picked up the new deployment. Restart \`oafm_server1\` (12.2) or the OC4J container (12.1) and retry.

---

## Step 8 — Make a Test Service Call

### SOAP test call

\`\`\`bash
curl -sk -X POST \
  -H "Content-Type: text/xml;charset=UTF-8" \
  -H "SOAPAction: \"HrEmployeeService\"" \
  -u JSMITH:password \
  "https://ebs-app.example.com:4443/webservices/soap/HrEmployeeService" \
  -d '<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:hr="http://xmlns.oracle.com/apps/per/soaprovider/plsql/hr_employee_api/">
  <soapenv:Header>
    <wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
      <wsse:UsernameToken>
        <wsse:Username>JSMITH</wsse:Username>
        <wsse:Password>password</wsse:Password>
      </wsse:UsernameToken>
    </wsse:Security>
    <oa:ReqHeader xmlns:oa="http://xmlns.oracle.com/apps/fnd/soaprovider/plsql/fnd_global/set_nls/">
      <oa:Responsibility>HR_MANAGER</oa:Responsibility>
      <oa:RespApplication>PER</oa:RespApplication>
      <oa:SecurityGroup>STANDARD</oa:SecurityGroup>
      <oa:NLSLanguage>AMERICAN</oa:NLSLanguage>
      <oa:Org_Id>204</oa:Org_Id>
    </oa:ReqHeader>
  </soapenv:Header>
  <soapenv:Body>
    <hr:InputParameters>
      <hr:P_VALIDATE>true</hr:P_VALIDATE>
      <hr:P_HIRE_DATE>2026-06-01</hr:P_HIRE_DATE>
      <hr:P_BUSINESS_GROUP_ID>81</hr:P_BUSINESS_GROUP_ID>
      <hr:P_LAST_NAME>TESTUSER</hr:P_LAST_NAME>
      <hr:P_SEX>M</hr:P_SEX>
      <hr:P_PERSON_TYPE_ID>1</hr:P_PERSON_TYPE_ID>
    </hr:InputParameters>
  </soapenv:Body>
</soapenv:Envelope>'
\`\`\`

**Expected response body:** A SOAP envelope containing \`OutputParameters\` with \`X_RETURN_STATUS\` of \`S\` (Success) or \`E\` (Error with message). Because \`P_VALIDATE = true\`, no data is committed — this is a dry-run test.

### REST test call (12.2 only)

\`\`\`bash
curl -sk -X POST \
  -H "Content-Type: application/json" \
  -H "responsibility: HR_MANAGER" \
  -H "respApplication: PER" \
  -H "securityGroup: STANDARD" \
  -H "nlsLanguage: AMERICAN" \
  -H "orgId: 204" \
  -u JSMITH:password \
  "https://ebs-app.example.com:4443/webservices/rest/HrEmployeeService/CreateEmployee" \
  -d '{
    "P_VALIDATE": true,
    "P_HIRE_DATE": "2026-06-01",
    "P_BUSINESS_GROUP_ID": 81,
    "P_LAST_NAME": "TESTUSER",
    "P_SEX": "M",
    "P_PERSON_TYPE_ID": 1
  }'
\`\`\`

**Expected response:**

\`\`\`json
{
  "X_RETURN_STATUS": "S",
  "X_MSG_COUNT": 0,
  "X_PERSON_ID": null,
  "X_ASSIGNMENT_ID": null
}
\`\`\`

\`X_PERSON_ID\` is null because \`P_VALIDATE = true\` rolls back without committing. Set \`P_VALIDATE\` to \`false\` for a real transaction.

---

## Step 9 — Grant Execute Privilege on the Service to Integration Users

By default only the deploying user can call the service. Grant access to integration service accounts:

\`\`\`sql
-- As APPS
BEGIN
  fnd_soa_sr_pkg.grant_access (
    p_alias_name  => 'HrEmployeeService',
    p_user_name   => 'OIC_INTEGRATION',
    p_grant_type  => 'EXECUTE'
  );
  COMMIT;
END;
/
\`\`\`

Verify the grant:

\`\`\`sql
SELECT alias_name, grantee_user_name, grant_type
FROM apps.irc_service_grants
WHERE alias_name = 'HrEmployeeService';
\`\`\`

---

## Step 10 — Post-Deployment Verification Checklist

- WSDL URL returns valid XML for all deployed services
- REST WADL URL returns valid XML (12.2 only)
- Test SOAP call with \`P_VALIDATE = true\` returns \`X_RETURN_STATUS = S\`
- Test REST call returns HTTP 200 with JSON body (12.2 only)
- Integration service account (\`OIC_INTEGRATION\` or equivalent) can authenticate and retrieve WSDL
- Responsible user/org context is confirmed correct in test response data
- \`IRC_SERVICE_DEPLOYMENTS\` shows \`DEPLOY_STATUS = DEPLOYED\` for all deployed services
- No errors in \`IRC_SERVICE_DEPLOY_LOG\` for the current deployment
- oafm_server1 (12.2) or OC4J (12.1) shows no errors in the server log after test calls

---

## Ongoing Monitoring

### Check all deployed service statuses

\`\`\`sql
SELECT alias_name, deploy_status, deployed_date, deployed_by
FROM apps.irc_service_deployments
ORDER BY deployed_date DESC;
\`\`\`

### Check for recent deployment errors

\`\`\`sql
SELECT alias_name, message_text, message_date
FROM apps.irc_service_deploy_log
WHERE message_date > SYSDATE - 7
  AND message_text LIKE '%ERROR%'
ORDER BY message_date DESC;
\`\`\`

### Monitor active ISG sessions on the DB

\`\`\`sql
SELECT s.username, s.program, s.module, s.status,
       s.last_call_et AS seconds_active,
       s.logon_time
FROM v$session s
WHERE s.module LIKE '%ISG%'
   OR s.program LIKE '%oafm%'
   OR s.program LIKE '%OC4J%'
ORDER BY s.logon_time DESC;
\`\`\`

### Check oafm_server1 log for ISG errors (12.2)

\`\`\`bash
grep -i 'ISG\|SOA\|webservice\|ERROR\|Exception' \
  $LOG_HOME/appl/oafm/oafm_server1*.log \
  | tail -100
\`\`\`

---

## Troubleshooting

### 404 on WSDL URL after successful deployment

The \`oafm_server1\` servlet cache has not refreshed. Restart the managed server:

\`\`\`bash
$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh stop  oafm_server1
$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh start oafm_server1
\`\`\`

Then retry the WSDL URL.

### 401 Unauthorized on a correctly credentialed request

\`\`\`sql
-- Confirm the user has the ISG service grant
SELECT alias_name, grantee_user_name FROM apps.irc_service_grants
WHERE alias_name = 'HrEmployeeService';

-- Confirm the user account is active in EBS
SELECT user_name, start_date, end_date
FROM fnd_user
WHERE user_name = 'JSMITH';
\`\`\`

Also confirm the user has at least one active responsibility — ISG rejects users with no valid responsibilities even with valid credentials.

### SOAP response contains \`faultcode: Server\` with no detail

This is usually a missing or wrong responsibility context in the SOAP header. Verify:

- \`Responsibility\` matches an active EBS responsibility key (not the display name)
- \`RespApplication\` matches the application short name for that responsibility
- \`Org_Id\` is a valid operating unit ID for the logged-in user

\`\`\`sql
SELECT fr.responsibility_key, fr.application_id, fa.application_short_name
FROM fnd_responsibility fr
JOIN fnd_application fa ON fa.application_id = fr.application_id
JOIN fnd_responsibility_vl frv ON frv.responsibility_id = fr.responsibility_id
WHERE frv.responsibility_name = 'HR Manager';
\`\`\`

### REST call returns 500 with no body

ISG REST processing threw an unhandled exception before reaching the API. Check the oafm server log:

\`\`\`bash
grep -A 10 'NullPointer\|IllegalArgument\|ORABPEL' \
  $LOG_HOME/appl/oafm/oafm_server1*.log | tail -50
\`\`\`

Common causes: malformed JSON body, a mandatory parameter sent as null, or a DATE parameter in an unexpected format. ISG expects DATE strings in \`YYYY-MM-DD\` format by default.

### Deployment times out — \`FND_SOA_DEPLOYMENT_TIMEOUT exceeded\`

\`\`\`sql
-- Increase timeout profile option
BEGIN
  fnd_profile.save('FND_SOA_DEPLOYMENT_TIMEOUT', '300', 'SITE');
  COMMIT;
END;
/
\`\`\`

Then clear the failed deployment record and retry:

\`\`\`sql
UPDATE apps.irc_service_deployments
SET deploy_status = 'UNDEPLOYED'
WHERE alias_name = 'HrEmployeeService';
COMMIT;
\`\`\`

Return to the Interface Repository in the UI and re-deploy.

### Service deployed on one app tier node but not others (clustered EBS 12.2)

ISG deployments must be re-run for each managed server node in a cluster. From the Interface Repository, use **Re-deploy** to push the service to remaining nodes. Alternatively, run \`fndsoacfg.sh\` against each managed server:

\`\`\`bash
$FND_TOP/patch/115/bin/fndsoacfg.sh \
  -apps_user apps \
  -apps_pwd "$APPS_PASSWORD" \
  -server oafm_server2
\`\`\`

---

## Rollback — Undeploy a Service

### Via the EBS UI

Navigate to **Integrated SOA Gateway > Integration Repository**, locate the deployed service, and click **Undeploy**.

### Via SQL

\`\`\`sql
BEGIN
  irc_service_deploy_pub.undeploy_service (
    p_alias_name    => 'HrEmployeeService',
    p_apps_user     => 'SYSADMIN',
    p_apps_password => 'sysadmin_password'
  );
  COMMIT;
END;
/
\`\`\`

Verify the service is no longer reachable:

\`\`\`bash
curl -sk -o /dev/null -w "%{http_code}" \
  -u JSMITH:password \
  "https://ebs-app.example.com:4443/webservices/soap/HrEmployeeService?WSDL"
# Expected: 404
\`\`\`

### Revoke integration user access

\`\`\`sql
DELETE FROM apps.irc_service_grants
WHERE alias_name = 'HrEmployeeService'
  AND grantee_user_name = 'OIC_INTEGRATION';
COMMIT;
\`\`\``,
};

async function main() {
  console.log('Inserting EBS ISG deployment runbook...');
  await db.insert(posts).values(post).onConflictDoNothing();
  console.log(`Inserted: "${post.title}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
