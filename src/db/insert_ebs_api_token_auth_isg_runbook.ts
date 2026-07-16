import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-api-token-authentication-isg-gateway-architecture-runbook';

const content = `
This runbook provides step-by-step procedures for implementing token-mediated API authentication for Oracle EBS across all three supported patterns: read-only database service accounts, Integrated SOA Gateway REST service deployment, and API Gateway credential translation. It covers version-specific procedures for EBS 11i, 12.1.3, and 12.2.x, and includes the \`ebs_api_auth_check.sh\` automation script for environment pre-assessment and ongoing health monitoring.

---

## Phase 1: Pre-Assessment — Determine the Integration Pattern

Before any configuration changes, answer the following questions to identify which pattern applies.

### 1.1 Identify the access type

\`\`\`sql
-- Connect to EBS as APPS and verify what data the integration needs
-- If the answer is SELECT only → Pattern 3 (DB service account)
-- If the answer is INSERT/UPDATE/EXECUTE business logic → Pattern 1 or 2

-- Check what the integration currently uses
SELECT u.user_name,
       u.description,
       u.last_logon_date,
       u.password_lifespan_days,
       u.start_date,
       u.end_date
FROM   fnd_user u
WHERE  u.user_name LIKE 'API%'
OR     u.user_name LIKE '%SERVICE%'
OR     u.user_name LIKE '%INTEG%'
ORDER  BY u.last_logon_date DESC;
\`\`\`

### 1.2 Confirm EBS version and ISG availability

\`\`\`sql
SELECT release_name FROM fnd_product_groups;

-- Check if ISG is installed
SELECT fpi.application_short_name,
       fpi.product_version,
       fpi.status
FROM   fnd_product_installations fpi
JOIN   fnd_application_vl fa ON fa.application_id = fpi.application_id
WHERE  fa.application_short_name = 'FND'
AND    fpi.status = 'I';

-- Check ISG component status (12.1+)
SELECT component_id,
       component_name,
       component_type,
       startup_mode,
       component_status
FROM   fnd_svc_components
WHERE  component_type = 'WF_MAILER'
OR     component_name LIKE '%ISG%'
OR     component_name LIKE '%SOA%';
\`\`\`

### 1.3 Check account lockout profile settings

\`\`\`sql
SELECT profile_option_name,
       description
FROM   fnd_profile_options_vl
WHERE  profile_option_name IN (
  'SIGNON_UNSUCCESSFUL_LIMIT',
  'ACCOUNT_LOCK_DURATION'
);

SELECT b.profile_option_name,
       c.profile_option_value
FROM   fnd_profile_option_values c
JOIN   fnd_profile_options b
       ON b.profile_option_id = c.profile_option_id
WHERE  b.profile_option_name IN (
  'SIGNON_UNSUCCESSFUL_LIMIT',
  'ACCOUNT_LOCK_DURATION'
)
AND    c.level_id = 10001;   -- site level
\`\`\`

Note the lockout threshold. If the integration makes repeated failed attempts (e.g., from stale credentials), it will lock the account after this many failures.

### 1.4 Identify currently locked accounts related to the integration

\`\`\`sql
SELECT user_name,
       last_logon_date,
       last_connect,
       password_date,
       employee_id
FROM   fnd_user
WHERE  (end_date IS NOT NULL AND end_date < SYSDATE)
OR     (user_name LIKE 'API%' OR user_name LIKE '%SERVICE%')
ORDER  BY last_logon_date DESC NULLS LAST;
\`\`\`

---

## Phase 2: Pattern 3 — Read-Only Database Service Account

Use this phase for integrations that only read EBS data. This is the recommended first choice for reporting, analytics, data warehouse feeds, and external dashboard connections.

### 2.1 Create the database service account

\`\`\`sql
-- Run as SYSDBA or DBA
CREATE USER ebs_readonly_svc IDENTIFIED BY "<strong_password>"
  DEFAULT TABLESPACE users
  TEMPORARY TABLESPACE temp
  PROFILE DEFAULT;

GRANT CREATE SESSION TO ebs_readonly_svc;
\`\`\`

### 2.2 Grant SELECT on required tables

Grant only on the specific tables or views the integration needs. Do not grant broad schema access.

\`\`\`sql
-- Example: AR and Customer data for reporting integration
GRANT SELECT ON apps.ar_payment_schedules_all  TO ebs_readonly_svc;
GRANT SELECT ON apps.hz_cust_accounts          TO ebs_readonly_svc;
GRANT SELECT ON apps.hz_parties                TO ebs_readonly_svc;
GRANT SELECT ON apps.hz_cust_site_uses_all     TO ebs_readonly_svc;
GRANT SELECT ON apps.ra_customer_trx_all       TO ebs_readonly_svc;

-- Example: GL for financial reporting
GRANT SELECT ON apps.gl_balances               TO ebs_readonly_svc;
GRANT SELECT ON apps.gl_code_combinations      TO ebs_readonly_svc;
GRANT SELECT ON apps.gl_periods                TO ebs_readonly_svc;

-- Example: Inventory
GRANT SELECT ON apps.mtl_system_items_b        TO ebs_readonly_svc;
GRANT SELECT ON apps.mtl_onhand_quantities_detail TO ebs_readonly_svc;
\`\`\`

Create synonyms to avoid schema-qualifying every query from the external system:

\`\`\`sql
-- As ebs_readonly_svc user or via CREATE SYNONYM grant
CREATE SYNONYM ebs_readonly_svc.ar_payment_schedules_all
  FOR apps.ar_payment_schedules_all;

CREATE SYNONYM ebs_readonly_svc.hz_cust_accounts
  FOR apps.hz_cust_accounts;
\`\`\`

### 2.3 Create a database profile limiting failed login attempts

\`\`\`sql
CREATE PROFILE ebs_svc_profile LIMIT
  FAILED_LOGIN_ATTEMPTS   5
  PASSWORD_LOCK_TIME      1/24   -- 1 hour auto-unlock
  PASSWORD_LIFE_TIME      90
  PASSWORD_REUSE_TIME     365
  PASSWORD_REUSE_MAX      5
  SESSIONS_PER_USER       50
  IDLE_TIME               30;

ALTER USER ebs_readonly_svc PROFILE ebs_svc_profile;
\`\`\`

### 2.4 Enable Oracle Unified Auditing for the service account

\`\`\`sql
-- 12c+: Unified Auditing
AUDIT SELECT ANY TABLE BY ebs_readonly_svc;

-- 11g/earlier: Standard auditing
AUDIT SELECT TABLE BY ebs_readonly_svc BY SESSION;
\`\`\`

### 2.5 Test connectivity from the external system

\`\`\`bash
sqlplus ebs_readonly_svc/<password>@//<oracle-host>:1521/<service>
SQL> SELECT COUNT(*) FROM ar_payment_schedules_all WHERE ROWNUM = 1;
\`\`\`

Expected: count of 1 returned without errors.

---

## Phase 3: Pattern 1 — ISG REST Service Deployment (12.1.3 and 12.2.x)

### 3.1 Verify ISG prerequisites

\`\`\`bash
# On the application tier, confirm the OAFM server is running (12.2.x)
ps -ef | grep oafm | grep -v grep

# Check the WebLogic admin console for oafm_server1 status (12.2.x)
curl -s -o /dev/null -w "%{http_code}" \\
  http://localhost:7202/webservices/rest/

# For 12.1.3: verify ISG Apache modules are loaded
grep -i isg \$OA_HTML/../logs/Apache/error_log | tail -20
\`\`\`

\`\`\`sql
-- Confirm ISG schema objects exist
SELECT COUNT(*) FROM all_objects
WHERE object_name LIKE 'FND_IREP%'
AND   object_type = 'TABLE';
-- Expected: > 0
\`\`\`

### 3.2 Create the EBS FND_USER service account for ISG

\`\`\`sql
-- As APPS user
BEGIN
  fnd_user_pkg.createuser(
    x_user_name                => 'API_ISG_SERVICE',
    x_owner                    => 'SEED',
    x_unencrypted_password     => '<strong_password>',
    x_session_number           => 0,
    x_start_date               => SYSDATE,
    x_end_date                 => NULL,
    x_last_logon_date          => SYSDATE,
    x_password_date            => SYSDATE,
    x_password_accesses_left   => NULL,
    x_password_lifespan_accesses => NULL,
    x_password_lifespan_days   => 180,
    x_employee_id              => NULL,
    x_email_address            => 'api-isg@example.com',
    x_fax                      => NULL,
    x_customer_id              => NULL,
    x_supplier_id              => NULL
  );
  COMMIT;
END;
/
\`\`\`

Assign only the minimum responsibility needed to access the ISG service (not System Administrator):

\`\`\`sql
BEGIN
  fnd_user_pkg.addresp(
    username     => 'API_ISG_SERVICE',
    resp_app     => 'FND',
    resp_key     => 'INTEGRATION_ADMINISTRATOR',
    security_group => 'STANDARD',
    description  => 'API service account for ISG REST calls',
    start_date   => SYSDATE,
    end_date     => NULL
  );
  COMMIT;
END;
/
\`\`\`

### 3.3 Annotate the PL/SQL package spec

Place the spec file at \`\$FND_TOP/patch/115/sql/xx_custom_pub.pls\` on the application tier. The annotation block must appear before the first procedure/function declaration:

\`\`\`sql
CREATE OR REPLACE PACKAGE xx_custom_pub AUTHID CURRENT_USER AS
/* \$Header: xx_custom_pub.pls 1.0 2026/07/16 12:00:00 appsdba noship \$ */

/*--
 * @rep:scope public
 * @rep:product fnd
 * @rep:displayname Custom Integration API
 * @rep:category BUSINESS_ENTITY FND_USER
 */

/*--
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

END xx_custom_pub;
/
\`\`\`

\`\`\`bash
# Compile the spec
sqlplus apps/<password> << 'EOF'
@\$FND_TOP/patch/115/sql/xx_custom_pub.pls
SHOW ERRORS
EXIT;
EOF
\`\`\`

### 3.4 Run irep_parser.pl to generate the .ildt file

\`\`\`bash
source /u01/applmgr/EBSPRD/EBSprd_appnode01.env

\$IAS_ORACLE_HOME/perl/bin/perl \$FND_TOP/bin/irep_parser.pl \\
  -user apps \\
  -password <apps_password> \\
  -isg \\
  -verbose \\
  fnd:patch/115/sql:xx_custom_pub.pls 2>&1 | tee /tmp/irep_parse.log

grep -i "error\|fail\|complete" /tmp/irep_parse.log
\`\`\`

Verify the .ildt file was created:

\`\`\`bash
ls -la xx_custom_pub.ildt
\`\`\`

### 3.5 Upload the .ildt to the Integration Repository

\`\`\`bash
FNDLOAD apps/<apps_password> 0 Y UPLOAD \\
  \$FND_TOP/patch/115/import/wfintegs.lct \\
  xx_custom_pub.ildt 2>&1 | tee /tmp/fndload_upload.log

grep -i "error\|success\|fail" /tmp/fndload_upload.log
\`\`\`

Verify the interface is registered:

\`\`\`sql
SELECT interface_alias,
       interface_name,
       deploy_status,
       last_update_date
FROM   fnd_irep_all_interfaces_vl
WHERE  interface_alias LIKE 'XX_CUSTOM%'
ORDER  BY last_update_date DESC;
\`\`\`

### 3.6 Generate and deploy through the Integration Repository UI

1. Log in with a user that has the **Integration Administrator** responsibility
2. Navigate: **Integrated SOA Gateway → Integration Repository**
3. Search for **Custom Integration API**
4. Select the interface → **REST Service** tab
5. Enter Service Alias (e.g., \`customApi\`)
6. Select methods → click **Generate**
7. **Grants** tab → **Create Grant** → select grantee → apply to methods
8. **REST Service** tab → click **Deploy**

Verify deployment status:

\`\`\`sql
SELECT interface_alias,
       deploy_status,
       last_update_date
FROM   fnd_irep_all_interfaces_vl
WHERE  interface_alias = 'XX_CUSTOM_PUB';
-- Expected: deploy_status = 'DEPLOYED'
\`\`\`

### 3.7 Test the deployed endpoint

\`\`\`bash
# 12.2.x — OAFM port (confirm port from WebLogic admin)
curl -k -X POST \\
  https://ebs-prod.example.com:443/webservices/rest/customApi/get_customer_info/ \\
  -H "Content-Type: application/json" \\
  -H "username: API_ISG_SERVICE" \\
  -H "password: <service_account_password>" \\
  -d '{"GET_CUSTOMER_INFO_Input": {"P_CUSTOMER_ID": 100452}}'

# Check the OAFM log if the call fails
tail -100 \$DOMAIN_HOME/servers/oafm_server1/logs/oafm_server1.log \\
  | grep -i "error\|exception\|404\|500"
\`\`\`

---

## Phase 4: Pattern 2 — API Gateway JWT to EBS Credential Translation

### 4.1 Create the dedicated EBS gateway service account

This account is used exclusively by the API Gateway — never by human users or other integrations:

\`\`\`sql
BEGIN
  fnd_user_pkg.createuser(
    x_user_name            => 'API_GATEWAY_USER',
    x_owner                => 'SEED',
    x_unencrypted_password => '<strong_rotatable_password>',
    x_session_number       => 0,
    x_start_date           => SYSDATE,
    x_end_date             => NULL,
    x_last_logon_date      => SYSDATE,
    x_password_date        => SYSDATE,
    x_password_lifespan_days => 90,
    x_email_address        => 'api-gateway@example.com'
  );
  COMMIT;
END;
/
\`\`\`

Grant only the responsibilities needed to execute the specific ISG services this gateway account calls. Do not grant System Administrator.

### 4.2 Store EBS credential in secrets manager

**Azure Key Vault:**

\`\`\`bash
az keyvault secret set \\
  --vault-name "enterprise-kv" \\
  --name "EbsGatewayUserPassword" \\
  --value "<api_gateway_user_password>"

# Verify
az keyvault secret show --vault-name "enterprise-kv" --name "EbsGatewayUserPassword" \\
  --query "value" --output tsv | wc -c
# Should return non-zero character count
\`\`\`

**HashiCorp Vault:**

\`\`\`bash
vault kv put secret/ebs/gateway username=API_GATEWAY_USER password=<password>
vault kv get secret/ebs/gateway
\`\`\`

### 4.3 Configure Azure APIM inbound policy

In the APIM portal: **APIs → [Your EBS API] → Inbound processing → Edit policy**

\`\`\`xml
<inbound>
    <base />
    <validate-jwt header-name="Authorization"
                  failed-validation-httpcode="401"
                  failed-validation-error-message="Invalid or expired token">
        <openid-config url="https://login.microsoftonline.com/<tenant-id>/.well-known/openid-configuration" />
        <required-claims>
            <claim name="scp" match="any">
                <value>EBS.Read</value>
                <value>EBS.Write</value>
            </claim>
        </required-claims>
    </validate-jwt>
    <!-- Strip the JWT and inject EBS Basic Auth -->
    <set-header name="Authorization" exists-action="override">
        <value>@{
            var username = "API_GATEWAY_USER";
            var password = "{{EbsGatewayUserPassword}}";
            return "Basic " + Convert.ToBase64String(
                Encoding.ASCII.GetBytes(username + ":" + password)
            );
        }</value>
    </set-header>
    <!-- Remove client-identifying headers before forwarding to EBS -->
    <set-header name="X-Forwarded-For" exists-action="delete" />
</inbound>
\`\`\`

### 4.4 Enforce IP allowlisting on EBS

Restrict the OAFM port (12.2.x) or Apache port (12.1.3) to accept connections only from the API Gateway's outbound IP range.

**For 12.2.x — WebLogic network access rule:**

In the WebLogic admin console: **Environment → Servers → oafm_server1 → Protocols → HTTP → Advanced** → enable connection filters, or configure at the load balancer / firewall level.

**For 12.1.3 — Apache mod_access:**

\`\`\`apache
<Location /webservices>
    Order Deny,Allow
    Deny from all
    Allow from 20.37.0.0/24    # Azure APIM outbound IP range (example)
    Allow from 10.10.5.0/24   # Internal API Gateway subnet
</Location>
\`\`\`

### 4.5 Test end-to-end with a real JWT

\`\`\`bash
# Obtain a JWT from Azure AD
TOKEN=\$(curl -s -X POST \\
  "https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token" \\
  -d "client_id=<client-id>&client_secret=<client-secret>\\
      &scope=api://<api-app-id>/EBS.Read&grant_type=client_credentials" \\
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# Call EBS through the API Gateway using the JWT
curl -X POST https://apim.example.com/ebs/customApi/get_customer_info/ \\
  -H "Authorization: Bearer \${TOKEN}" \\
  -H "Content-Type: application/json" \\
  -d '{"GET_CUSTOMER_INFO_Input": {"P_CUSTOMER_ID": 100452}}'
\`\`\`

Expected: HTTP 200 with customer data. Verify in the APIM logs that the JWT was validated and that the request forwarded to EBS carried Basic Auth (not the JWT).

---

## Phase 5: FND_USER Account Health Monitoring

### 5.1 Identify accounts at risk of lockout

\`\`\`sql
-- FND_USER accounts with recent failed login attempts
-- (EBS tracks this internally per-session, not in a standard column,
--  but the following shows accounts that have not logged in recently
--  or are approaching their password expiry)

SELECT user_name,
       last_logon_date,
       password_date,
       password_lifespan_days,
       password_date + password_lifespan_days AS password_expires,
       ROUND(password_date + NVL(password_lifespan_days, 999) - SYSDATE) AS days_until_expiry
FROM   fnd_user
WHERE  user_name IN ('API_ISG_SERVICE', 'API_GATEWAY_USER')
ORDER  BY days_until_expiry;
\`\`\`

### 5.2 Unlock a locked FND_USER account

\`\`\`sql
-- If an API service account gets locked due to failed authentication attempts
EXEC fnd_user_pkg.updateuser(
  x_user_name => 'API_ISG_SERVICE',
  x_owner     => 'SEED',
  x_end_date  => NULL
);
COMMIT;

-- Reset password if needed
EXEC fnd_user_pkg.updateuser(
  x_user_name            => 'API_ISG_SERVICE',
  x_owner                => 'SEED',
  x_unencrypted_password => '<new_password>',
  x_password_date        => SYSDATE,
  x_password_lifespan_days => 180
);
COMMIT;
\`\`\`

### 5.3 Rotate the EBS service account password

**Step 1:** Update the password in the secrets manager (Azure Key Vault, Vault, or KVM) first.

**Step 2:** Verify the API Gateway picks up the new secret (for Azure APIM Named Values, there may be a short cache interval — force a refresh or redeploy the policy if needed).

**Step 3:** Update the EBS FND_USER password:

\`\`\`sql
EXEC fnd_user_pkg.updateuser(
  x_user_name            => 'API_GATEWAY_USER',
  x_owner                => 'SEED',
  x_unencrypted_password => '<new_rotated_password>',
  x_password_date        => SYSDATE,
  x_password_lifespan_days => 90
);
COMMIT;
\`\`\`

**Step 4:** Run the end-to-end JWT test from Phase 4.5 to confirm the rotation is seamless.

---

## Phase 6: Automation Script — ebs_api_auth_check.sh

This script performs environment pre-assessment and health checks for all three integration patterns. Run it as the \`applmgr\` OS user on the EBS application tier.

\`\`\`bash
#!/bin/bash
# ebs_api_auth_check.sh
# Checks EBS API authentication environment health across all three patterns.
# Usage: ebs_api_auth_check.sh <APPS_PASSWORD> [ISG_ENDPOINT_HOST] [ISG_PORT]

set -euo pipefail

APPS_PASS="\${1:?Usage: \$0 <APPS_PASSWORD> [HOST] [PORT]}"
ISG_HOST="\${2:-localhost}"
ISG_PORT="\${3:-443}"
LOG_DIR="/tmp/ebs_api_auth_check"
DATE_TAG=\$(date +%Y%m%d_%H%M%S)
LOG_FILE="\${LOG_DIR}/auth_check_\${DATE_TAG}.log"

mkdir -p "\${LOG_DIR}"

source_ebs_env() {
  local env_file
  env_file=\$(find /u01/applmgr -maxdepth 3 -name "*.env" | head -1)
  if [ -n "\${env_file}" ]; then
    # shellcheck disable=SC1090
    source "\${env_file}" 2>/dev/null || true
  fi
}

log() { echo "[$(date '+%H:%M:%S')] \$*" | tee -a "\${LOG_FILE}"; }
pass() { log "  PASS: \$*"; }
fail() { log "  FAIL: \$*"; }
info() { log "  INFO: \$*"; }

source_ebs_env

log "====================================================="
log "EBS API Auth Environment Check — \$(date)"
log "====================================================="

# ── Phase 1: EBS FND_USER service account health ─────────────────────────────
log ""
log "── Phase 1: FND_USER Service Account Health ──"

sqlplus -s apps/"\${APPS_PASS}" << SQLEOF 2>&1 | tee -a "\${LOG_FILE}"
SET LINESIZE 140 PAGESIZE 50
COLUMN user_name          FORMAT A25
COLUMN last_logon_date    FORMAT A22
COLUMN password_expires   FORMAT A22
COLUMN days_left          FORMAT 9999
COLUMN status             FORMAT A10

PROMPT
PROMPT Service accounts and password expiry:
SELECT u.user_name,
       TO_CHAR(u.last_logon_date, 'YYYY-MM-DD HH24:MI') AS last_logon_date,
       TO_CHAR(u.password_date + NVL(u.password_lifespan_days,9999), 'YYYY-MM-DD') AS password_expires,
       ROUND(u.password_date + NVL(u.password_lifespan_days,9999) - SYSDATE) AS days_left,
       CASE
         WHEN u.end_date IS NOT NULL AND u.end_date < SYSDATE THEN 'INACTIVE'
         WHEN ROUND(u.password_date + NVL(u.password_lifespan_days,9999) - SYSDATE) < 14 THEN 'EXPIRING'
         ELSE 'OK'
       END AS status
FROM   fnd_user u
WHERE  (u.user_name LIKE 'API%'
        OR u.user_name LIKE '%GATEWAY%'
        OR u.user_name LIKE '%SERVICE%'
        OR u.user_name LIKE '%INTEG%')
AND    NVL(u.end_date, SYSDATE+1) >= SYSDATE
ORDER  BY days_left;

PROMPT
PROMPT Account lockout profile settings (site level):
SELECT b.profile_option_name,
       c.profile_option_value
FROM   fnd_profile_option_values c
JOIN   fnd_profile_options b ON b.profile_option_id = c.profile_option_id
WHERE  b.profile_option_name IN ('SIGNON_UNSUCCESSFUL_LIMIT','ACCOUNT_LOCK_DURATION')
AND    c.level_id = 10001;

EXIT;
SQLEOF

# ── Phase 2: ISG deployment status ───────────────────────────────────────────
log ""
log "── Phase 2: ISG Service Deployment Status ──"

sqlplus -s apps/"\${APPS_PASS}" << SQLEOF 2>&1 | tee -a "\${LOG_FILE}"
SET LINESIZE 140 PAGESIZE 50
COLUMN interface_alias FORMAT A40
COLUMN deploy_status   FORMAT A12
COLUMN last_update     FORMAT A22

PROMPT
PROMPT ISG interfaces and deployment status:
SELECT interface_alias,
       deploy_status,
       TO_CHAR(last_update_date, 'YYYY-MM-DD HH24:MI') AS last_update
FROM   fnd_irep_all_interfaces_vl
WHERE  deploy_status != 'NOT_GENERATED'
ORDER  BY deploy_status, last_update_date DESC
FETCH FIRST 30 ROWS ONLY;

EXIT;
SQLEOF

# ── Phase 3: OAFM server health (12.2.x) ─────────────────────────────────────
log ""
log "── Phase 3: OAFM Server Health ──"

if pgrep -f "oafm_server" > /dev/null 2>&1; then
  pass "oafm_server process is running"
else
  fail "oafm_server process NOT found — ISG REST services may be unavailable"
fi

OAFM_STATUS=\$(curl -sk -o /dev/null -w "%{http_code}" \\
  --connect-timeout 5 \\
  "https://\${ISG_HOST}:\${ISG_PORT}/webservices/rest/" 2>/dev/null || echo "000")

case "\${OAFM_STATUS}" in
  200|401|403) pass "ISG endpoint reachable (HTTP \${OAFM_STATUS})" ;;
  000)         fail "ISG endpoint not reachable at https://\${ISG_HOST}:\${ISG_PORT}" ;;
  *)           info "ISG endpoint returned HTTP \${OAFM_STATUS}" ;;
esac

# ── Phase 4: Read-only DB service account check ───────────────────────────────
log ""
log "── Phase 4: Read-Only DB Service Account ──"

sqlplus -s apps/"\${APPS_PASS}" << SQLEOF 2>&1 | tee -a "\${LOG_FILE}"
SET LINESIZE 140 PAGESIZE 50
COLUMN username       FORMAT A25
COLUMN account_status FORMAT A20
COLUMN expiry_date    FORMAT A22
COLUMN profile        FORMAT A25

PROMPT
PROMPT Database-level read-only service accounts:
SELECT username,
       account_status,
       TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date,
       profile
FROM   dba_users
WHERE  (username LIKE 'EBS_%SVC%'
        OR username LIKE 'EBS_%READONLY%'
        OR username LIKE 'MULE_%'
        OR username LIKE '%_READONLY%')
ORDER  BY username;

PROMPT
PROMPT Grants held by read-only service accounts:
SELECT grantee,
       owner || '.' || table_name AS object_name,
       privilege,
       grantable
FROM   dba_tab_privs
WHERE  grantee IN (
  SELECT username FROM dba_users
  WHERE  username LIKE 'EBS_%SVC%'
  OR     username LIKE 'EBS_%READONLY%'
  OR     username LIKE '%_READONLY%'
)
ORDER  BY grantee, object_name;

EXIT;
SQLEOF

# ── Phase 5: OAFM log scan for recent errors ──────────────────────────────────
log ""
log "── Phase 5: OAFM Log Error Scan ──"

if [ -n "\${DOMAIN_HOME:-}" ]; then
  OAFM_LOG="\${DOMAIN_HOME}/servers/oafm_server1/logs/oafm_server1.log"
  if [ -f "\${OAFM_LOG}" ]; then
    ERROR_COUNT=\$(grep -ci "error\|exception\|ORA-\|deploy fail" "\${OAFM_LOG}" 2>/dev/null || echo 0)
    log "OAFM log errors in last 200 lines: \${ERROR_COUNT}"
    if [ "\${ERROR_COUNT}" -gt 0 ]; then
      tail -200 "\${OAFM_LOG}" | grep -i "error\|exception\|ORA-\|deploy fail" | tail -20 | tee -a "\${LOG_FILE}"
    fi
  else
    info "OAFM log not found at \${OAFM_LOG} — check DOMAIN_HOME"
  fi
else
  info "DOMAIN_HOME not set — skipping OAFM log scan (not a 12.2.x environment or env not sourced)"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
log ""
log "====================================================="
log "Check complete. Full log: \${LOG_FILE}"
log "====================================================="
\`\`\`

Make the script executable and run it:

\`\`\`bash
chmod 750 /u01/scripts/ebs_api_auth_check.sh
/u01/scripts/ebs_api_auth_check.sh <apps_password> ebs-prod.example.com 443
\`\`\`

---

## Phase 7: Troubleshooting

### ISG deployment stuck at Generated — not proceeding to Deployed

\`\`\`bash
# Restart the OAFM managed server
\$DOMAIN_HOME/bin/stopManagedWebLogic.sh oafm_server1 \\
  t3://\${WLS_ADMIN_HOST}:7001
\$DOMAIN_HOME/bin/startManagedWebLogic.sh oafm_server1 \\
  t3://\${WLS_ADMIN_HOST}:7001

# Re-attempt deploy from the Integration Repository UI
# If still failing, check:
tail -100 \$DOMAIN_HOME/servers/oafm_server1/logs/oafm_server1.log \\
  | grep -i "deploy\|error\|exception"
\`\`\`

### irep_parser.pl fails with annotation errors

Common causes:
- Missing required annotations (\`@rep:scope\`, \`@rep:displayname\`)
- Non-ASCII characters in annotation text
- Package spec file not accessible at the exact path given to the parser

\`\`\`bash
# Verify the file path is correct
ls -la \$FND_TOP/patch/115/sql/xx_custom_pub.pls

# Run with increased verbosity
\$IAS_ORACLE_HOME/perl/bin/perl \$FND_TOP/bin/irep_parser.pl \\
  -user apps -password <pass> -isg -verbose -debug \\
  fnd:patch/115/sql:xx_custom_pub.pls
\`\`\`

### HTTP 401 from ISG endpoint — credentials not accepted

\`\`\`sql
-- Confirm the FND_USER account is active and not locked
SELECT user_name, start_date, end_date, password_date
FROM   fnd_user
WHERE  user_name = 'API_ISG_SERVICE';

-- Check the account has the correct responsibility
SELECT r.responsibility_name,
       ur.start_date, ur.end_date
FROM   fnd_user_resp_groups_all ur
JOIN   fnd_responsibility_tl r
       ON  r.responsibility_id = ur.responsibility_id
       AND r.language          = USERENV('LANG')
JOIN   fnd_user u ON u.user_id = ur.user_id
WHERE  u.user_name = 'API_ISG_SERVICE';
\`\`\`

\`\`\`bash
# Verify Basic Auth encoding is correct
echo -n "API_ISG_SERVICE:<password>" | base64
# Use the output as: Authorization: Basic <output>

curl -v https://ebs-prod.example.com:443/webservices/rest/customApi/get_customer_info/ \\
  -H "Authorization: Basic <base64_encoded_credentials>" \\
  -H "Content-Type: application/json" \\
  -d '{"GET_CUSTOMER_INFO_Input": {"P_CUSTOMER_ID": 1}}'
\`\`\`

### JWT validation failing at API Gateway before EBS is reached

\`\`\`bash
# Decode the JWT and inspect the claims
JWT_PAYLOAD=\$(echo "\${TOKEN}" | cut -d. -f2)
# Pad base64 if needed
echo "\${JWT_PAYLOAD}==" | base64 -d 2>/dev/null | python3 -m json.tool
\`\`\`

Verify the \`scp\` (scope), \`aud\` (audience), and \`exp\` (expiry) claims match what the APIM policy requires.

---

## Quick Reference

| Task | Command / Location |
|---|---|
| Run environment health check | \`/u01/scripts/ebs_api_auth_check.sh <apps_pass> <host> <port>\` |
| Unlock FND_USER account | \`fnd_user_pkg.updateuser\` — set \`x_end_date => NULL\` |
| Reset FND_USER password | \`fnd_user_pkg.updateuser\` — set \`x_unencrypted_password\` |
| Check ISG deploy status | \`SELECT interface_alias, deploy_status FROM fnd_irep_all_interfaces_vl\` |
| Re-parse PL/SQL spec | \`irep_parser.pl -user apps -password <p> -isg fnd:patch/115/sql:<file>\` |
| Re-upload .ildt | \`FNDLOAD apps/<p> 0 Y UPLOAD \$FND_TOP/patch/115/import/wfintegs.lct <file>.ildt\` |
| Restart OAFM (12.2.x) | \`stopManagedWebLogic.sh oafm_server1\` then \`startManagedWebLogic.sh oafm_server1\` |
| Test ISG endpoint | \`curl -H "username: X" -H "password: Y" https://<host>/webservices/rest/<alias>/<method>/\` |
| Rotate service account password | Update secrets manager → update FND_USER → test end-to-end |
| Check OAFM logs | \`tail -200 \$DOMAIN_HOME/servers/oafm_server1/logs/oafm_server1.log\` |
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'EBS API Token Authentication and ISG Integration — Runbook',
    slug,
    excerpt: 'Step-by-step runbook for implementing token-mediated API authentication across Oracle EBS 11i, 12.1.3, and 12.2.x. Covers pre-assessment queries to determine the right architectural pattern, read-only database service account creation with minimal SELECT grants, ISG REST service deployment (PL/SQL annotation, irep_parser.pl, FNDLOAD upload, Integration Repository deploy), API Gateway credential translation with Azure APIM and Apigee policy XML, FND_USER account health monitoring, password rotation procedures, and the ebs_api_auth_check.sh automation script for environment assessment.',
    content,
    category: 'ebs-isg',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
