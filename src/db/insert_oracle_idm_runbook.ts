import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle IAM Health Checks, OAM SSO Validation, OID/OUD Administration, and OIM Provisioning',
  slug: 'oracle-identity-management-administration-runbook',
  excerpt:
    'Step-by-step administration runbook for Oracle Identity Management — OAM health check and SSO policy validation, OID and OUD LDAP user and group administration, WebGate configuration and testing, OIM provisioning and reconciliation verification, account unlock procedures, password policy management, log locations, and a daily IAM health check script.',
  category: 'identity-management' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-12'),
  youtubeUrl: null,
  content: `## Environment Assumptions

| Component | Host | Port | Version |
|-----------|------|------|---------|
| OAM Server | oam.corp.local | 14100 (admin), 14150 (managed) | 12c (12.2.1.4) |
| OHS + WebGate | ohs.corp.local | 7777/4443 | 12c |
| OID | oid.corp.local | 3060 (LDAP), 3131 (LDAPS) | 11g |
| OUD | oud.corp.local | 1389 (LDAP), 1636 (LDAPS) | 12c |
| OIM | oim.corp.local | 14000 (admin), 14002 (managed) | 12c |
| Database (MDS/OIM) | db.corp.local | 1521 | Oracle 19c |
| LDAP base DN | dc=corp,dc=local | — | — |
| OAM bind account | uid=oam_bind,ou=Services,dc=corp,dc=local | — | — |

---

## Part 1: OAM Health Check

### 1.1 Verify OAM Managed Server Status

\`\`\`bash
# Connect to the OAM Admin Server via WLST
source /u01/oracle/middleware/oracle_common/common/bin/setWlstEnv.sh

wlst.sh <<'EOF'
connect('weblogic', 'password', 't3://oam.corp.local:14100')
domainRuntime()
cd('ServerRuntimes')

for s in ls(returnMap='true').keys():
    cd(s)
    state  = cmo.getState()
    health = cmo.getHealthState().getState()
    print(s + ' | state=' + state + ' | health=' + str(health))
    cd('..')

disconnect()
EOF
\`\`\`

Expected output for a healthy deployment:
\`\`\`
AdminServer  | state=RUNNING | health=HEALTH_OK
oam_server1  | state=RUNNING | health=HEALTH_OK
oam_server2  | state=RUNNING | health=HEALTH_OK
\`\`\`

### 1.2 OAM Server Runtime Check via REST

\`\`\`bash
# Check OAM server is responding to requests
curl -s -o /dev/null -w "%{http_code}" \
  http://oam.corp.local:14150/oam/server/healthcheck
# Expected: 200

# OAM Admin Console availability
curl -s -o /dev/null -w "%{http_code}" \
  http://oam.corp.local:14100/oamconsole
# Expected: 200 or 302
\`\`\`

### 1.3 Validate OAM Policy Store Connectivity

\`\`\`bash
# OAM stores policies in an LDAP directory (OID/OUD) or database (DB policy store)
# Verify OAM can reach its policy store

wlst.sh <<'EOF'
connect('weblogic', 'password', 't3://oam.corp.local:14100')
custom()
cd('oracle.security.am.engines.sts:name=PolicyStoreRuntime,type=PolicyStore')
status = cmo.getStoreStatus()
print('Policy store status: ' + str(status))
disconnect()
EOF
\`\`\`

### 1.4 Check OAM Authentication Against OID/OUD

Test that OAM can authenticate a known user end-to-end:

\`\`\`bash
# Simulate an OAM authentication request
# This tests the OAM server → OID/OUD LDAP bind chain
curl -v -X POST \
  http://oam.corp.local:14150/oam/server/auth_cred_submit \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=testuser&password=TestPass1&OAM_REQ=<encoded_request_token>"
# Expected: 302 redirect to the original protected URL with ObSSOCookie set
\`\`\`

For a simpler connectivity test, bind directly to OID from the OAM host:

\`\`\`bash
ldapsearch -h oid.corp.local -p 3060 \
  -D "uid=oam_bind,ou=Services,dc=corp,dc=local" \
  -w "OAMBindPassword" \
  -b "ou=People,dc=corp,dc=local" \
  "(uid=testuser)" cn mail memberOf
\`\`\`

### 1.5 Verify WebGate Is Protecting Resources

\`\`\`bash
# Request a protected URL without a cookie — should redirect to OAM login
curl -v -L -c /dev/null \
  http://ohs.corp.local:7777/OA_HTML/AppsLocalLogin.jsp 2>&1 \
  | grep -E "Location:|HTTP/"

# Expected: HTTP/1.1 302 Found
#           Location: http://oam.corp.local:14150/oam/server/auth_cred_submit?...
\`\`\`

---

## Part 2: OAM SSO Policy Administration

### 2.1 List Application Domains via WLST

\`\`\`bash
wlst.sh <<'EOF'
connect('weblogic', 'password', 't3://oam.corp.local:14100')
custom()
cd('oracle.security.am.admin.config:name=OAMConfigMBean,type=OAMConfigMBean')
domains = cmo.getApplicationDomains()
for d in domains:
    print('Domain: ' + d.getName() + ' | Description: ' + str(d.getDescription()))
disconnect()
EOF
\`\`\`

### 2.2 Check Protected Resources for a Domain

\`\`\`bash
# Use the OAM REST management API (12c)
curl -s -u weblogic:password \
  "http://oam.corp.local:14100/oam/services/rest/ssa/api/v1/appdomain/EBS_Domain/resources" \
  | python3 -m json.tool | grep -E '"name"|"url"|"type"'
\`\`\`

### 2.3 Create a New Protected Resource via REST API

\`\`\`bash
curl -s -u weblogic:password \
  -X POST \
  -H "Content-Type: application/json" \
  "http://oam.corp.local:14100/oam/services/rest/ssa/api/v1/appdomain/EBS_Domain/resources" \
  -d '{
    "name": "NewApp_Resource",
    "type": "http",
    "hostIdentifier": "EBS_HOST",
    "resourceURL": "/newapp/...",
    "queryString": "",
    "operations": ""
  }'
\`\`\`

---

## Part 3: OID Administration

### 3.1 Check OID Instance Status

\`\`\`bash
# On the OID host
source /u01/oracle/middleware/oid/bin/oidenv.sh

# Check OPMN-managed OID process
opmnctl status

# Or directly
oidmon status
\`\`\`

### 3.2 User Lookup

\`\`\`bash
# Find a user by uid
ldapsearch -h oid.corp.local -p 3060 \
  -D "cn=orcladmin,dc=corp,dc=local" \
  -w "OrcladminPassword" \
  -b "ou=People,dc=corp,dc=local" \
  "(uid=jsmith)" \
  uid cn mail orclIsEnabled pwdAccountLockedTime memberOf

# Find all members of a group
ldapsearch -h oid.corp.local -p 3060 \
  -D "cn=orcladmin,dc=corp,dc=local" \
  -w "OrcladminPassword" \
  -b "ou=Groups,dc=corp,dc=local" \
  "(cn=EBS_Users)" member uniqueMember
\`\`\`

### 3.3 Unlock a Locked Account in OID

\`\`\`bash
# Unlock account (clear pwdAccountLockedTime)
ldapmodify -h oid.corp.local -p 3060 \
  -D "cn=orcladmin,dc=corp,dc=local" \
  -w "OrcladminPassword" <<EOF
dn: uid=jsmith,ou=People,dc=corp,dc=local
changetype: modify
delete: pwdAccountLockedTime
-
delete: pwdFailureTime
EOF

# Re-enable a disabled account (OID-specific attribute)
ldapmodify -h oid.corp.local -p 3060 \
  -D "cn=orcladmin,dc=corp,dc=local" \
  -w "OrcladminPassword" <<EOF
dn: uid=jsmith,ou=People,dc=corp,dc=local
changetype: modify
replace: orclIsEnabled
orclIsEnabled: ENABLED
EOF
\`\`\`

### 3.4 Reset a Password in OID

\`\`\`bash
# Force password reset (admin-initiated)
ldapmodify -h oid.corp.local -p 3060 \
  -D "cn=orcladmin,dc=corp,dc=local" \
  -w "OrcladminPassword" <<EOF
dn: uid=jsmith,ou=People,dc=corp,dc=local
changetype: modify
replace: userPassword
userPassword: NewTempPass1#
-
replace: pwdMustChange
pwdMustChange: TRUE
EOF
\`\`\`

### 3.5 Add a User to a Group

\`\`\`bash
ldapmodify -h oid.corp.local -p 3060 \
  -D "cn=orcladmin,dc=corp,dc=local" \
  -w "OrcladminPassword" <<EOF
dn: cn=EBS_Users,ou=Groups,dc=corp,dc=local
changetype: modify
add: uniqueMember
uniqueMember: uid=jsmith,ou=People,dc=corp,dc=local
EOF
\`\`\`

### 3.6 Bulk User Export from OID

\`\`\`bash
# Export all users to LDIF
ldapsearch -h oid.corp.local -p 3060 \
  -D "cn=orcladmin,dc=corp,dc=local" \
  -w "OrcladminPassword" \
  -b "ou=People,dc=corp,dc=local" \
  "(objectClass=inetOrgPerson)" \
  uid cn mail orclIsEnabled \
  > /tmp/oid_users_export_\$(date +%Y%m%d).ldif

wc -l /tmp/oid_users_export_\$(date +%Y%m%d).ldif
\`\`\`

---

## Part 4: OUD Administration (Modern Deployments)

### 4.1 OUD Status and Replication Check

\`\`\`bash
# On the OUD host
export OUD_INSTANCE_HOME=/u01/oracle/oud/instances/oud_inst1
\$OUD_INSTANCE_HOME/OUD/bin/status --hostname oud.corp.local --port 4444 \
  --bindDN "cn=Directory Manager" --bindPassword "DirMgrPassword" \
  --trustAll --noPropertiesFile

# Check replication topology
dsreplication status \
  --hostname oud.corp.local --port 4444 \
  --adminUID admin --adminPasswordFile /home/oracle/.oudadmin_pass \
  --trustAll --no-prompt
\`\`\`

### 4.2 LDAP Operations on OUD

\`\`\`bash
# OUD uses the same LDAP tools — just point to OUD's port
# Unlock user (OUD uses standard password policy attributes)
ldapmodify -h oud.corp.local -p 1389 \
  -D "cn=Directory Manager" \
  -w "DirMgrPassword" <<EOF
dn: uid=jsmith,ou=People,dc=corp,dc=local
changetype: modify
replace: pwdReset
pwdReset: TRUE
EOF

# OUD password policy — list current policy
ldapsearch -h oud.corp.local -p 1389 \
  -D "cn=Directory Manager" \
  -w "DirMgrPassword" \
  -b "cn=Default Password Policy,cn=Password Policies,cn=config" \
  "(objectClass=pwdPolicy)" -s base \
  pwdLockoutDuration pwdMaxFailure pwdLockout pwdMinLength pwdExpireWarning
\`\`\`

### 4.3 OUD Backend Status

\`\`\`bash
# Check entry count per backend
\$OUD_INSTANCE_HOME/OUD/bin/backend-status \
  --hostname oud.corp.local --port 4444 \
  --bindDN "cn=Directory Manager" --bindPassword "DirMgrPassword" \
  --trustAll

# Force an index rebuild after bulk load
\$OUD_INSTANCE_HOME/OUD/bin/rebuild-index \
  --hostname oud.corp.local --port 4444 \
  --bindDN "cn=Directory Manager" --bindPassword "DirMgrPassword" \
  --baseDN "dc=corp,dc=local" \
  --index uid,cn,mail \
  --trustAll
\`\`\`

---

## Part 5: OIM Provisioning Administration

### 5.1 OIM Managed Server Status

\`\`\`bash
wlst.sh <<'EOF'
connect('weblogic', 'password', 't3://oim.corp.local:14000')
domainRuntime()
cd('ServerRuntimes')
for s in ls(returnMap='true').keys():
    cd(s)
    print(s + ' | ' + cmo.getState() + ' | ' + str(cmo.getHealthState().getState()))
    cd('..')
disconnect()
EOF
\`\`\`

### 5.2 Check OIM Database Connectivity

OIM uses a schema in Oracle Database for workflow state, audit, and configuration.

\`\`\`sql
-- Connect to the OIM database schema (OIMDB)
sqlplus oimschema/password@OIMDB

-- Check scheduled job status
SELECT job_name, status, start_date, next_run_date
FROM   oimschema.sch_task
WHERE  status IN ('ERROR','SUSPENDED')
ORDER BY start_date DESC;

-- Check pending approvals stuck > 24 hours
SELECT t.process_instance_id, t.task_name, t.status,
       t.assigned_to, t.create_date
FROM   oimschema.wf_task t
WHERE  t.status IN ('ASSIGNED','PENDING')
  AND  t.create_date < SYSDATE - 1
ORDER BY t.create_date;
\`\`\`

### 5.3 Trigger a Manual Reconciliation Job

\`\`\`bash
# Trigger OID full reconciliation from OIM
# Use OIM's APIs via curl (REST) or the OIM Admin Console

# OIM 12c REST API — schedule reconciliation
curl -s -u xelsysadm:password \
  -X POST \
  -H "Content-Type: application/json" \
  "http://oim.corp.local:14002/iam/governance/selfservice/api/v1/scheduler/jobs/OID Full Reconciliation/run" \
  | python3 -m json.tool
\`\`\`

### 5.4 Check Reconciliation Event Status

\`\`\`sql
-- Recent reconciliation events
SELECT r.recon_key, r.status, r.recon_profile, r.create_date, r.update_date
FROM   oimschema.recon_events r
WHERE  r.create_date > SYSDATE - 1
ORDER BY r.create_date DESC
FETCH FIRST 50 ROWS ONLY;

-- Failed reconciliation events needing manual review
SELECT r.recon_key, r.status, r.recon_profile,
       e.err_msg, r.create_date
FROM   oimschema.recon_events r
JOIN   oimschema.recon_exceptions e ON r.recon_key = e.recon_key
WHERE  r.status = 'Event Failed'
  AND  r.create_date > SYSDATE - 7
ORDER BY r.create_date DESC;
\`\`\`

### 5.5 Provision/Deprovision a Resource via OIM REST API

\`\`\`bash
# Get a user's OIM internal ID
OIM_USER_ID=\$(curl -s -u xelsysadm:password \
  "http://oim.corp.local:14002/iam/governance/selfservice/api/v1/users?q=Login%20Name%3Djsmith&attributes=User%20Login,usr_key" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result'][0]['usr_key'])")

echo "OIM user key for jsmith: \$OIM_USER_ID"

# List resources provisioned to the user
curl -s -u xelsysadm:password \
  "http://oim.corp.local:14002/iam/governance/selfservice/api/v1/users/\${OIM_USER_ID}/accounts" \
  | python3 -m json.tool | grep -E '"appInstanceName"|"accountStatus"'
\`\`\`

---

## Part 6: Common Break-Fix Scenarios

### Scenario A: User Can't Log In — OAM Redirects but Login Fails

\`\`\`bash
# Step 1: Verify user exists and is enabled in OID
ldapsearch -h oid.corp.local -p 3060 \
  -D "cn=orcladmin,dc=corp,dc=local" -w "password" \
  -b "ou=People,dc=corp,dc=local" \
  "(uid=jsmith)" orclIsEnabled pwdAccountLockedTime pwdFailureTime

# Expected: orclIsEnabled=ENABLED, no pwdAccountLockedTime

# Step 2: Test an LDAP bind as the user directly (bypasses OAM, tests OID)
ldapsearch -h oid.corp.local -p 3060 \
  -D "uid=jsmith,ou=People,dc=corp,dc=local" \
  -w "UserPassword" \
  -b "uid=jsmith,ou=People,dc=corp,dc=local" \
  "(objectClass=*)" uid cn
# Success = LDAP bind valid. Failure = wrong password or account locked.

# Step 3: If locked — unlock (Part 3.3 above)

# Step 4: Verify OAM can reach OID (bind account test)
ldapsearch -h oid.corp.local -p 3060 \
  -D "uid=oam_bind,ou=Services,dc=corp,dc=local" \
  -w "OAMBindPassword" \
  -b "ou=People,dc=corp,dc=local" "(uid=jsmith)" uid
# If this fails — OAM's bind account password has changed or expired
\`\`\`

### Scenario B: SSO Cookie Not Accepted After Password Change

\`\`\`bash
# The SSO session is still valid but the user's password changed elsewhere
# OAM caches session tokens — sessions survive password changes
# Force logout to clear the OAM session token

# Invalidate all sessions for a user via OAM REST
curl -s -u weblogic:password \
  -X DELETE \
  "http://oam.corp.local:14100/oam/services/rest/ssa/api/v1/sessions/user/jsmith"
\`\`\`

### Scenario C: WebGate Not Redirecting to OAM

\`\`\`bash
# Step 1: Check WebGate registration is active
# WebGate registers itself with OAM at startup
# Look for WebGate agent in OAM console or via REST
curl -s -u weblogic:password \
  "http://oam.corp.local:14100/oam/services/rest/ssa/api/v1/agents/webgates" \
  | python3 -m json.tool | grep -E '"name"|"state"'

# Step 2: Check WebGate configuration files on OHS host
ls -la /u01/oracle/middleware/instance/config/OHS/ohs1/WebGate/config/
# Expected: ObAccessClient.xml, aaa_key.pem, aaa_cert.pem

# Step 3: Check OHS error log for WebGate messages
grep -i "webgate\|oam\|ObSSOCookie" \
  /u01/oracle/middleware/instance/diagnostics/logs/OHS/ohs1/ohs1.log \
  | tail -30

# Step 4: Validate WebGate can reach OAM
telnet oam.corp.local 5575   # OAM proxy port (WebGate communication)
\`\`\`

### Scenario D: OIM Provisioning Stuck / Not Creating Accounts

\`\`\`bash
# Step 1: Check OIM SOA/BPEL infrastructure
wlst.sh <<'EOF'
connect('weblogic', 'password', 't3://oim.corp.local:14000')
custom()
cd('oracle.soa.config:name=soainfra,type=SoaInfraConfig')
print('SOA status: ' + str(cmo.getStatus()))
disconnect()
EOF

# Step 2: Check for stuck BPEL instances in SOA
sqlplus soainfra/password@OIMDB <<'SQL'
SELECT COUNT(*), state
FROM soainfra.cube_instance
WHERE modified_time < SYSDATE - 1
  AND state NOT IN (2, 9)  -- 2=completed, 9=cancelled
GROUP BY state;
EXIT;
SQL

# Step 3: Check OIM server logs
tail -100 /u01/oracle/middleware/user_projects/domains/iam_domain/servers/oim_server1/logs/oim_server1.log \
  | grep -iE "error|exception|failed"
\`\`\`

---

## Part 7: Log Locations

| Component | Log File |
|-----------|---------|
| OAM Admin Server | \`\$DOMAIN_HOME/servers/AdminServer/logs/AdminServer.log\` |
| OAM Managed Server | \`\$DOMAIN_HOME/servers/oam_server1/logs/oam_server1.log\` |
| OAM Diagnostic | \`\$DOMAIN_HOME/servers/oam_server1/logs/oam_server1-diagnostic.log\` |
| OAM Access | \`\$ORACLE_INSTANCE/diagnostics/logs/OAM/\` |
| OHS/WebGate | \`\$ORACLE_INSTANCE/diagnostics/logs/OHS/ohs1/ohs1.log\` |
| WebGate Agent | \`\$WEBGATE_HOME/oblix/logs/oblog.log\` |
| OID | \`\$ORACLE_INSTANCE/diagnostics/logs/OID/oid1/oid1.log\` |
| OUD | \`\$OUD_INSTANCE/logs/server.out\`, \`access\`, \`errors\` |
| OIM Managed Server | \`\$DOMAIN_HOME/servers/oim_server1/logs/oim_server1.log\` |
| OIM Application | \`\$DOMAIN_HOME/servers/oim_server1/logs/xlserver.log\` |
| SOA (BPEL) | \`\$DOMAIN_HOME/servers/soa_server1/logs/soa_server1.log\` |

---

## Part 8: Daily IAM Health Check Script

\`\`\`bash
#!/bin/bash
# /home/oracle/scripts/iam_health_check.sh
# Checks OAM, OID/OUD, and OIM in one pass

source /u01/oracle/middleware/oracle_common/common/bin/setWlstEnv.sh

LOG_DIR="/home/oracle/scripts/logs"
REPORT="\${LOG_DIR}/iam_health_\$(date +%Y%m%d_%H%M%S).log"
EMAIL="dba-alerts@corp.local"
ALERT_FOUND=0

mkdir -p "\$LOG_DIR"
exec > >(tee "\$REPORT") 2>&1

log() { echo "\$(date '+%Y-%m-%d %H:%M:%S') [\${1:-INFO}] \$2"; }

echo "========================================"
echo "IAM Daily Health Check: \$(date)"
echo "========================================"

# --- 1. OAM server response ---
log INFO "Checking OAM server..."
OAM_HTTP=\$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 \
  http://oam.corp.local:14150/oam/server/healthcheck)

if [[ "\$OAM_HTTP" == "200" ]]; then
    log INFO "OAM healthcheck: HTTP \$OAM_HTTP OK"
else
    log CRITICAL "OAM healthcheck returned HTTP \$OAM_HTTP"
    ALERT_FOUND=1
fi

# --- 2. OAM Admin Console ---
OAM_CONSOLE=\$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 \
  http://oam.corp.local:14100/oamconsole)

if [[ "\$OAM_CONSOLE" =~ ^(200|302)$ ]]; then
    log INFO "OAM Admin Console: HTTP \$OAM_CONSOLE OK"
else
    log WARN "OAM Admin Console: HTTP \$OAM_CONSOLE"
    [[ \$ALERT_FOUND -lt 1 ]] && ALERT_FOUND=1
fi

# --- 3. OID/OUD LDAP bind test ---
log INFO "Testing LDAP bind to OID..."
ldapsearch -h oid.corp.local -p 3060 \
  -D "uid=oam_bind,ou=Services,dc=corp,dc=local" \
  -w "OAMBindPassword" \
  -b "ou=People,dc=corp,dc=local" \
  "(uid=healthcheck_user)" uid >/dev/null 2>&1

if [[ \$? -eq 0 ]]; then
    log INFO "OID LDAP bind: OK"
else
    log CRITICAL "OID LDAP bind FAILED — OAM cannot authenticate users"
    ALERT_FOUND=1
fi

# --- 4. Check OID for locked accounts (last 24h) ---
LOCKED_TODAY=\$(ldapsearch -h oid.corp.local -p 3060 \
  -D "cn=orcladmin,dc=corp,dc=local" -w "OrcladminPassword" \
  -b "ou=People,dc=corp,dc=local" \
  "(pwdAccountLockedTime=*)" uid 2>/dev/null \
  | grep "^uid:" | wc -l)

log INFO "Currently locked accounts in OID: \$LOCKED_TODAY"
if [[ "\$LOCKED_TODAY" -gt 10 ]]; then
    log WARN "High number of locked accounts: \$LOCKED_TODAY (possible password spray attack)"
    ALERT_FOUND=1
fi

# --- 5. OIM server check ---
log INFO "Checking OIM server..."
OIM_HTTP=\$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 \
  http://oim.corp.local:14002/oim/faces/pages/admin/Home.jspx)

if [[ "\$OIM_HTTP" =~ ^(200|302)$ ]]; then
    log INFO "OIM server: HTTP \$OIM_HTTP OK"
else
    log WARN "OIM server: HTTP \$OIM_HTTP"
    [[ \$ALERT_FOUND -lt 1 ]] && ALERT_FOUND=1
fi

# --- 6. WebGate redirect test ---
log INFO "Testing WebGate redirect..."
WG_RESPONSE=\$(curl -s -o /dev/null -w "%{http_code}" \
  --max-redirs 0 --connect-timeout 10 \
  http://ohs.corp.local:7777/OA_HTML/AppsLocalLogin.jsp)

if [[ "\$WG_RESPONSE" == "302" ]]; then
    log INFO "WebGate redirect: HTTP 302 (protected resource redirecting to OAM) OK"
else
    log WARN "WebGate redirect: HTTP \$WG_RESPONSE — expected 302"
    [[ \$ALERT_FOUND -lt 1 ]] && ALERT_FOUND=1
fi

# --- Summary ---
echo ""
echo "========================================"
if [[ \$ALERT_FOUND -gt 0 ]]; then
    log CRITICAL "IAM health check found issues — review: \$REPORT"
    cat "\$REPORT" | mail -s "IAM Health Check ALERTS: \$(date +%Y%m%d)" "\$EMAIL"
else
    log INFO "All IAM checks passed"
fi
echo "========================================"
\`\`\`

\`\`\`bash
# Crontab (oracle user)
# */15 * * * * /home/oracle/scripts/iam_health_check.sh
\`\`\``,
};

async function main() {
  console.log('Inserting Oracle Identity Management runbook...');
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
