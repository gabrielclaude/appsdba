import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Directory Services Manager (ODSM) 12c Deployment, OID/OUD Connection, and Directory Administration',
  slug: 'oracle-directory-services-manager-odsm-administration-runbook',
  excerpt:
    'Step-by-step runbook for deploying Oracle Directory Services Manager (ODSM) 12c on WebLogic, connecting to OID and OUD instances, managing entries and groups via LDAP, extending directory schema, configuring Access Control Instructions (ACIs), managing password policies, monitoring replication, and an ODSM health monitoring script with crontab scheduling.',
  category: 'identity-management' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-07'),
  youtubeUrl: null,
  content: `## Overview

This runbook deploys Oracle Directory Services Manager (ODSM) 12c on a WebLogic Server domain, registers OID and OUD server connections, and walks through the most common directory administration tasks: entry and group management, schema extension, ACI configuration, password policy, replication monitoring, and DIP synchronisation management. It concludes with an ODSM and OID/OUD availability health monitoring script.

**Prerequisites**
- Oracle Linux 8 / RHEL 8, minimum 2 cores, 4 GB RAM
- WebLogic Server 12.2.1.4 installed at \`\${WL_HOME}\` (ODSM is bundled with Oracle IDM)
- Oracle Internet Directory (OID) or Oracle Unified Directory (OUD) running and accessible
- JDK 8 or 11 at \`/usr/java/jdk\`
- Browser access to the ODSM server (Chrome, Firefox, Edge — IE is not supported in 12c)
- \`ldap-utils\` (ldapsearch, ldapadd, ldapmodify) installed on the ODSM server

---

## Phase 1: Deploy ODSM on WebLogic

ODSM ships as part of the Oracle IDM installer. If OID is already installed in a WebLogic domain, ODSM is typically already deployed. Verify first.

\`\`\`bash
# Check if ODSM is already deployed in the OID domain
DOMAIN_HOME=\${DOMAIN_HOME:-/u01/app/oracle/user_projects/domains/OIDDomain}

# Check for odsm deployment
ls \${DOMAIN_HOME}/autodeploy/odsm* 2>/dev/null || \
ls \${DOMAIN_HOME}/servers/AdminServer/upload/odsm* 2>/dev/null || \
  echo "ODSM not found in autodeploy — check WL deployments"

# List all deployed applications in the domain
\${MW_HOME}/oracle_common/common/bin/wlst.sh <<'WLST_EOF'
connect('weblogic', '<admin_password>', 't3://odsm-server:7001')
domainRuntime()
cd('/AppRuntimeStateRuntime/AppRuntimeStateRuntime')
apps = cmo.getApplicationIds()
for app in apps:
    print(app)
disconnect()
exit()
WLST_EOF

# If ODSM is not deployed, deploy it manually
ODSM_WAR=\${MW_HOME}/idm/odsm/odsm.war

if [ -f "\${ODSM_WAR}" ]; then
  \${MW_HOME}/oracle_common/common/bin/wlst.sh <<'WLST_EOF'
connect('weblogic', '<admin_password>', 't3://odsm-server:7001')
deploy(
  appName='odsm',
  path='/u01/app/oracle/middleware/idm/odsm/odsm.war',
  targets='AdminServer',
  stageMode='nostage'
)
disconnect()
exit()
WLST_EOF
  echo "ODSM deployed"
else
  echo "odsm.war not found at \${ODSM_WAR} — verify IDM installation"
fi
\`\`\`

---

## Phase 2: Verify ODSM is Accessible

\`\`\`bash
# Start WebLogic Admin Server if not running
nohup \${DOMAIN_HOME}/startWebLogic.sh &
sleep 60

# Verify ODSM URL responds
HTTP_CODE=\$(curl -s -o /dev/null -w "%{http_code}" \
  http://odsm-server:7001/odsm 2>/dev/null)
echo "ODSM HTTP status: \${HTTP_CODE}"
# Expected: 200 or 302

# Check WebLogic deployment state
\${MW_HOME}/oracle_common/common/bin/wlst.sh <<'WLST_EOF'
connect('weblogic', '<admin_password>', 't3://odsm-server:7001')
domainRuntime()
cd('/AppRuntimeStateRuntime/AppRuntimeStateRuntime')
state = cmo.getCurrentState('odsm', 'AdminServer')
print('ODSM state:', state)
disconnect()
exit()
WLST_EOF
# Expected: STATE_ACTIVE

# Open in browser: http://odsm-server:7001/odsm
# Login with WebLogic admin credentials
echo "ODSM accessible at http://odsm-server:7001/odsm"
\`\`\`

---

## Phase 3: Register OID Server Connection in ODSM

\`\`\`bash
# OID server connections can be registered via ODSM REST API (12c) or through the UI

# Register OID connection via ODSM REST API
curl -s -X POST \
  "http://odsm-server:7001/odsm/faces/api/servers" \
  -H "Content-Type: application/json" \
  -u weblogic:<admin_password> \
  -d '{
    "serverName": "OID-Production",
    "serverType": "OID",
    "host": "oid-host",
    "port": 389,
    "sslEnabled": false,
    "description": "Oracle Internet Directory Production Instance"
  }' | python3 -m json.tool

# Verify by listing registered servers
curl -s "http://odsm-server:7001/odsm/faces/api/servers" \
  -u weblogic:<admin_password> | python3 -m json.tool

# Test OID LDAP connectivity from ODSM server
ldapsearch -H ldap://oid-host:389 \
  -D "cn=orcladmin" \
  -w <orcladmin_password> \
  -b "" -s base "(objectClass=*)" vendorName vendorVersion 2>&1

# Browser: Connect to OID via ODSM
# 1. Navigate to http://odsm-server:7001/odsm
# 2. Log in with weblogic credentials
# 3. Click "Connect to a Directory Server"
# 4. Select "OID-Production" → Enter bind DN + password
# 5. DIT browser opens with dc=example,dc=com root

echo "OID connection registered"
\`\`\`

---

## Phase 4: Register OUD Server Connection

\`\`\`bash
# Register OUD instance in ODSM
curl -s -X POST \
  "http://odsm-server:7001/odsm/faces/api/servers" \
  -H "Content-Type: application/json" \
  -u weblogic:<admin_password> \
  -d '{
    "serverName": "OUD-Production",
    "serverType": "OUD",
    "host": "oud-host",
    "port": 1389,
    "sslEnabled": false,
    "description": "Oracle Unified Directory Production Instance"
  }' | python3 -m json.tool

# Test OUD LDAP connectivity
ldapsearch -H ldap://oud-host:1389 \
  -D "cn=Directory Manager" \
  -w <directory_manager_password> \
  -b "" -s base "(objectClass=*)" vendorName 2>&1

# For OUD LDAPS (port 1636):
# ldapsearch -H ldaps://oud-host:1636 -Z \
#   -D "cn=Directory Manager" -w <password> \
#   -b "" -s base "(objectClass=*)" vendorName

echo "OUD connection registered"
\`\`\`

---

## Phase 5: Entry Management Operations

### 5.1 Create a User Entry

\`\`\`bash
# Via ODSM UI:
# 1. Connect to OID/OUD
# 2. Navigate to: ou=employees,ou=people,dc=example,dc=com
# 3. Actions → Create Entry
# 4. Add object classes: inetOrgPerson, orclUserV2
# 5. Fill attributes, click Save

# Equivalent LDIF (for bulk use outside ODSM):
cat > /tmp/new_user.ldif <<'LDIF_EOF'
dn: uid=alee,ou=employees,ou=people,dc=example,dc=com
objectClass: top
objectClass: person
objectClass: organizationalPerson
objectClass: inetOrgPerson
objectClass: orclUserV2
uid: alee
cn: Alice Lee
sn: Lee
givenName: Alice
mail: alice.lee@example.com
userPassword: TempPass123!
orclIsEnabled: ENABLED
employeeNumber: 10050
departmentNumber: Engineering
title: Senior Engineer
telephoneNumber: +1 555 200 0001
LDIF_EOF

ldapadd -H ldap://oid-host:389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -f /tmp/new_user.ldif

# Verify via ODSM search:
ldapsearch -H ldap://oid-host:389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -b "ou=people,dc=example,dc=com" \
  "(uid=alee)" uid cn mail orclIsEnabled
\`\`\`

### 5.2 Modify User Attributes

\`\`\`bash
# Via ODSM: locate entry → click attribute value → edit → save

# Equivalent LDIF for programmatic use:
cat > /tmp/modify_user.ldif <<'LDIF_EOF'
dn: uid=alee,ou=employees,ou=people,dc=example,dc=com
changetype: modify
replace: title
title: Principal Engineer
-
replace: telephoneNumber
telephoneNumber: +1 555 200 0099
-
add: l
l: Sydney
LDIF_EOF

ldapmodify -H ldap://oid-host:389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -f /tmp/modify_user.ldif
\`\`\`

### 5.3 Group Management

\`\`\`bash
# Create a new group entry
cat > /tmp/new_group.ldif <<'LDIF_EOF'
dn: cn=Engineering-Team,ou=groups,dc=example,dc=com
objectClass: top
objectClass: groupOfUniqueNames
cn: Engineering-Team
description: Engineering Department Users
uniqueMember: uid=alee,ou=employees,ou=people,dc=example,dc=com
LDIF_EOF

ldapadd -H ldap://oid-host:389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -f /tmp/new_group.ldif

# Add members to existing group
ldapmodify -H ldap://oid-host:389 \
  -D "cn=orcladmin" -w <orcladmin_password> <<'LDIF_EOF'
dn: cn=Engineering-Team,ou=groups,dc=example,dc=com
changetype: modify
add: uniqueMember
uniqueMember: uid=jsmith,ou=employees,ou=people,dc=example,dc=com
LDIF_EOF

# Remove a member from a group
ldapmodify -H ldap://oid-host:389 \
  -D "cn=orcladmin" -w <orcladmin_password> <<'LDIF_EOF'
dn: cn=Engineering-Team,ou=groups,dc=example,dc=com
changetype: modify
delete: uniqueMember
uniqueMember: uid=jsmith,ou=employees,ou=people,dc=example,dc=com
LDIF_EOF

# List all members of a group
ldapsearch -H ldap://oid-host:389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -b "cn=Engineering-Team,ou=groups,dc=example,dc=com" \
  "(objectClass=groupOfUniqueNames)" uniqueMember
\`\`\`

---

## Phase 6: Schema Extension

\`\`\`bash
# Add a custom attribute type and object class
# This adds a company-specific badge ID attribute to user entries

# Step 1: Add custom attribute type
cat > /tmp/schema_extension.ldif <<'LDIF_EOF'
dn: cn=subschemasubentry
changetype: modify
add: attributeTypes
attributeTypes: ( 1.3.6.1.4.1.99999.1.1
  NAME 'companyBadgeID'
  DESC 'Company physical access badge identifier'
  EQUALITY caseIgnoreMatch
  SUBSTR caseIgnoreSubstringsMatch
  SYNTAX 1.3.6.1.4.1.1466.115.121.1.15
  SINGLE-VALUE )
LDIF_EOF

ldapmodify -H ldap://oid-host:389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -f /tmp/schema_extension.ldif

# Step 2: Add custom auxiliary object class using the new attribute
cat >> /tmp/schema_extension.ldif <<'LDIF_EOF'

dn: cn=subschemasubentry
changetype: modify
add: objectClasses
objectClasses: ( 1.3.6.1.4.1.99999.2.1
  NAME 'companyPersonExtension'
  DESC 'Company-specific person attributes'
  SUP top
  AUXILIARY
  MAY ( companyBadgeID ) )
LDIF_EOF

ldapmodify -H ldap://oid-host:389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -f /tmp/schema_extension.ldif

# Step 3: Verify schema was added
ldapsearch -H ldap://oid-host:389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -b "cn=subschemasubentry" -s base "(objectClass=*)" \
  attributeTypes 2>/dev/null | grep "companyBadgeID"

# Step 4: Add custom object class and attribute to a user entry
ldapmodify -H ldap://oid-host:389 \
  -D "cn=orcladmin" -w <orcladmin_password> <<'LDIF_EOF'
dn: uid=alee,ou=employees,ou=people,dc=example,dc=com
changetype: modify
add: objectClass
objectClass: companyPersonExtension
-
add: companyBadgeID
companyBadgeID: BADGE-2026-10050
LDIF_EOF

# In ODSM: Schema → Attribute Types confirms companyBadgeID is visible
# ODSM entry editor will now offer companyBadgeID as an available attribute
echo "Schema extension complete"
\`\`\`

---

## Phase 7: Access Control Instructions (ACIs)

\`\`\`bash
# ACI 1: Allow OAM service account read access to all user attributes
# Apply at ou=people OU level — inherits to all entries beneath

ldapmodify -H ldap://oid-host:389 \
  -D "cn=orcladmin" -w <orcladmin_password> <<'ACI_EOF'
dn: ou=people,dc=example,dc=com
changetype: modify
add: aci
aci: (target="ldap:///ou=people,dc=example,dc=com")(targetattr="*")(version 3.0;
  acl "OAM bind account read access";
  allow (search,read,compare)
  userdn="ldap:///cn=oam-bind,ou=service-accounts,ou=people,dc=example,dc=com";)
ACI_EOF

# ACI 2: Allow OIM provisioning account to add/modify entries in employees OU
ldapmodify -H ldap://oid-host:389 \
  -D "cn=orcladmin" -w <orcladmin_password> <<'ACI_EOF'
dn: ou=employees,ou=people,dc=example,dc=com
changetype: modify
add: aci
aci: (target="ldap:///ou=employees,ou=people,dc=example,dc=com")(targetattr="*")(version 3.0;
  acl "OIM provisioning write access";
  allow (read,search,compare,add,write,delete)
  userdn="ldap:///cn=oimservice,ou=service-accounts,ou=people,dc=example,dc=com";)
ACI_EOF

# ACI 3: Allow users to modify their own telephone number (self-service)
ldapmodify -H ldap://oid-host:389 \
  -D "cn=orcladmin" -w <orcladmin_password> <<'ACI_EOF'
dn: ou=people,dc=example,dc=com
changetype: modify
add: aci
aci: (target="ldap:///ou=people,dc=example,dc=com")(targetattr="telephoneNumber || mobile")(version 3.0;
  acl "Self-service telephone update";
  allow (write)
  userdn="ldap:///self";)
ACI_EOF

# ACI 4: Deny anonymous access to userPassword attribute
ldapmodify -H ldap://oid-host:389 \
  -D "cn=orcladmin" -w <orcladmin_password> <<'ACI_EOF'
dn: dc=example,dc=com
changetype: modify
add: aci
aci: (targetattr="userPassword")(version 3.0;
  acl "Deny anonymous password read";
  deny (read,search,compare)
  userdn="ldap:///anyone";)
ACI_EOF

# View all ACIs on a DN (ODSM displays these in the ACI section)
ldapsearch -H ldap://oid-host:389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -b "ou=people,dc=example,dc=com" -s base "(objectClass=*)" aci

echo "ACIs configured"
\`\`\`

---

## Phase 8: Password Policy Configuration

\`\`\`bash
# View current password policy object
ldapsearch -H ldap://oid-host:389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -b "cn=default,cn=pwdpolicies,cn=common,cn=products,cn=OracleContext,dc=example,dc=com" \
  "(objectClass=*)" \
  pwdMinLength pwdMaxAge pwdInHistory pwdLockout pwdLockoutDuration pwdMaxFailure 2>&1

# Update password policy via ODSM:
# Navigate to: Data Browser → OracleContext → Products → Common → pwdpolicies → default
# Modify attributes in the entry editor

# Equivalent LDIF for key password policy settings:
ldapmodify -H ldap://oid-host:389 \
  -D "cn=orcladmin" -w <orcladmin_password> <<'PP_EOF'
dn: cn=default,cn=pwdpolicies,cn=common,cn=products,cn=OracleContext,dc=example,dc=com
changetype: modify
replace: pwdMinLength
pwdMinLength: 12
-
replace: pwdMaxAge
pwdMaxAge: 7776000
-
replace: pwdInHistory
pwdInHistory: 10
-
replace: pwdMaxFailure
pwdMaxFailure: 5
-
replace: pwdLockout
pwdLockout: TRUE
-
replace: pwdLockoutDuration
pwdLockoutDuration: 1800
-
replace: pwdGraceAuthNLimit
pwdGraceAuthNLimit: 3
PP_EOF

# Create a stricter password policy for service accounts
cat > /tmp/service_acct_policy.ldif <<'LDIF_EOF'
dn: cn=service-accounts,cn=pwdpolicies,cn=common,cn=products,cn=OracleContext,dc=example,dc=com
objectClass: top
objectClass: pwdPolicy
objectClass: orclPwdPolicyEntry
cn: service-accounts
pwdAttribute: userPassword
pwdMinLength: 20
pwdMaxAge: 15552000
pwdInHistory: 24
pwdMaxFailure: 3
pwdLockout: TRUE
pwdLockoutDuration: 0
pwdGraceAuthNLimit: 0
LDIF_EOF

ldapadd -H ldap://oid-host:389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -f /tmp/service_acct_policy.ldif

# Assign the service account policy to the service-accounts OU
ldapmodify -H ldap://oid-host:389 \
  -D "cn=orcladmin" -w <orcladmin_password> <<'PP_EOF'
dn: ou=service-accounts,ou=people,dc=example,dc=com
changetype: modify
add: orclpwdpolicydn
orclpwdpolicydn: cn=service-accounts,cn=pwdpolicies,cn=common,cn=products,cn=OracleContext,dc=example,dc=com
PP_EOF

echo "Password policies configured"
\`\`\`

---

## Phase 9: Replication Monitoring and Management

\`\`\`bash
# Check replication agreement status
ldapsearch -H ldap://oid-host:389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -b "cn=replication configuration" \
  "(objectClass=orclReplicationAgreement)" \
  orclreplicaid orclreplicahost orclreplicaport orclreplicastate 2>&1

# Check replication lag: query changelog entry count on master
CHANGELOG_COUNT=\$(ldapsearch -H ldap://oid-host:389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -b "cn=changelog" -s one "(objectClass=*)" dn 2>/dev/null | \
  grep -c "^dn:" || echo "0")
echo "Pending changelog entries: \${CHANGELOG_COUNT}"

# Check replication status on replica
ldapsearch -H ldap://oid-replica:389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -b "cn=replication configuration" \
  "(objectClass=orclReplicationAgreement)" \
  orclreplicastate 2>&1

# Force a replication cycle (run on master to push to replica immediately)
# Via ODSM: Replication → Agreements → [agreement] → Replicate Now

# Via oidctl (alternative to ODSM):
oidctl connect=OIDSID server=oidrepld \
  host=oid-host port=389 \
  flags="-replicatenow" restart

# Verify replication worked: add a test entry on master, check replica
ldapadd -H ldap://oid-host:389 \
  -D "cn=orcladmin" -w <orcladmin_password> <<'LDIF_EOF'
dn: uid=repltest,ou=employees,ou=people,dc=example,dc=com
objectClass: inetOrgPerson
objectClass: orclUserV2
uid: repltest
cn: Replication Test
sn: Test
mail: repltest@example.com
orclIsEnabled: ENABLED
LDIF_EOF

sleep 30

REPL_CHECK=\$(ldapsearch -H ldap://oid-replica:389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -b "ou=people,dc=example,dc=com" \
  "(uid=repltest)" uid 2>/dev/null | grep "^uid:")
echo "Replication test result: \${REPL_CHECK:-ENTRY NOT FOUND ON REPLICA}"

# Clean up test entry
ldapdelete -H ldap://oid-host:389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  "uid=repltest,ou=employees,ou=people,dc=example,dc=com"

echo "Replication check complete"
\`\`\`

---

## Phase 10: DIP Synchronisation Management

\`\`\`bash
# View DIP synchronisation profile status via ODSM
# ODSM → DIP Administration → Synchronization Profiles

# Check DIP status via command line (DIP admin tool)
DIP_HOME=\${MW_HOME}/idm/dip
\${DIP_HOME}/bin/manageSyncProfiles status \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -h oid-host -p 389

# View synchronisation errors
\${DIP_HOME}/bin/manageSyncProfiles getLastExecution \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -h oid-host -p 389 \
  -profile "ActiveDirectorySync"

# Trigger a manual sync run for a profile
\${DIP_HOME}/bin/manageSyncProfiles run \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -h oid-host -p 389 \
  -profile "ActiveDirectorySync"

# Check DIP agent log for errors
DIP_LOG=\${DOMAIN_HOME}/servers/AdminServer/logs/dip.log
tail -100 \${DIP_LOG} | grep -E "ERROR|WARN|skip|fail" | tail -20

echo "DIP synchronisation reviewed"
\`\`\`

---

## Phase 11: Common Troubleshooting Operations

\`\`\`bash
# Problem: ODSM cannot connect to OID ("Connection refused" or timeout)

# Check OID processes
pgrep -l oidmon oidldapd

# Check OID is listening on port 389
ss -tlnp | grep 389

# Check from ODSM server
telnet oid-host 389

# Check OID error log
tail -50 \${ORACLE_HOME}/ldap/log/oidldapd01.log | \
  grep -E "error|Error|SEVERE" | tail -20

# Restart OID if needed
\${ORACLE_HOME}/bin/opmnctl stopall
sleep 10
\${ORACLE_HOME}/bin/opmnctl startall
sleep 20
\${ORACLE_HOME}/bin/opmnctl status

# Problem: ODSM login fails ("Invalid credentials")
# Check WebLogic Admin credentials work
curl -s -u weblogic:<admin_password> http://odsm-server:7001/management/wls/latest/ | \
  python3 -m json.tool | grep "state"

# Problem: Schema change via ODSM returns "Constraint violation"
# Check syntax of the attribute type OID for uniqueness
ldapsearch -H ldap://oid-host:389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -b "cn=subschemasubentry" -s base "(objectClass=*)" \
  attributeTypes 2>/dev/null | grep "1.3.6.1.4.1.99999"

# Problem: ACI not taking effect (user still has access after deny ACI)
# Check effective ACI using orclaci effective privilege check
ldapsearch -H ldap://oid-host:389 \
  -D "uid=testuser,ou=employees,ou=people,dc=example,dc=com" \
  -w <user_password> \
  -b "ou=people,dc=example,dc=com" \
  -s one "(objectClass=inetOrgPerson)" dn 2>&1 | head -5

# Problem: Password reset via ODSM returns "Constraint violation"
# Likely password history violation — check pwdInHistory policy
ldapsearch -H ldap://oid-host:389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -b "uid=jsmith,ou=employees,ou=people,dc=example,dc=com" \
  "(objectClass=*)" pwdHistory | wc -l
\`\`\`

---

## Phase 12: ODSM and OID Health Monitoring Script

\`\`\`bash
cat > /u01/scripts/odsm_oid_health_check.sh <<'SCRIPT_EOF'
#!/bin/bash
# ODSM and OID/OUD Health Monitor
# Nagios-compatible exit codes: 0=OK, 1=WARNING, 2=CRITICAL

ODSM_HOST="odsm-server"
ODSM_PORT="7001"
OID_HOST="oid-host"
OID_PORT="389"
OID_BIND_DN="cn=orcladmin"
OID_BIND_PW="<orcladmin_password>"
OID_BASE="dc=example,dc=com"
OUD_HOST="oud-host"
OUD_PORT="1389"
OUD_BIND_DN="cn=Directory Manager"
OUD_BIND_PW="<directory_manager_password>"
OID_REPLICA_HOST="oid-replica"
EMAIL="dba-alerts@example.com"
LOG="/var/log/odsm_oid_health.log"
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
ORACLE_HOME=\${ORACLE_HOME:-/u01/app/oracle/middleware/oid}

STATUS=0
MESSAGES=""

# Check 1: ODSM web application responding
ODSM_CODE=\$(curl -s -o /dev/null -w "%{http_code}" \
  "http://\${ODSM_HOST}:\${ODSM_PORT}/odsm" 2>/dev/null || echo "000")
if [ "\${ODSM_CODE}" = "200" ] || [ "\${ODSM_CODE}" = "302" ]; then
  MESSAGES+="OK: ODSM web application responding (HTTP \${ODSM_CODE})\n"
else
  MESSAGES+="WARNING: ODSM not responding (HTTP \${ODSM_CODE}) — admin console unavailable\n"
  [ \${STATUS} -lt 1 ] && STATUS=1
fi

# Check 2: OID LDAP port
OID_BIND_RESULT=\$(ldapsearch -H ldap://\${OID_HOST}:\${OID_PORT} \
  -D "\${OID_BIND_DN}" -w "\${OID_BIND_PW}" \
  -b "" -s base "(objectClass=*)" vendorName 2>/dev/null | \
  grep "^vendorName" || echo "")
if [ -n "\${OID_BIND_RESULT}" ]; then
  MESSAGES+="OK: OID LDAP port \${OID_PORT} responding\n"
else
  MESSAGES+="CRITICAL: OID LDAP not responding or bind failed\n"
  STATUS=2
fi

# Check 3: OID oidldapd process
OIDLDAP_PID=\$(pgrep -x oidldapd 2>/dev/null || echo "")
if [ -n "\${OIDLDAP_PID}" ]; then
  MESSAGES+="OK: oidldapd process running (PID \${OIDLDAP_PID})\n"
else
  MESSAGES+="CRITICAL: oidldapd process not found\n"
  STATUS=2
fi

# Check 4: OID user count sanity check
USER_COUNT=\$(ldapsearch -H ldap://\${OID_HOST}:\${OID_PORT} \
  -D "\${OID_BIND_DN}" -w "\${OID_BIND_PW}" \
  -b "ou=people,\${OID_BASE}" \
  "(objectClass=inetOrgPerson)" dn 2>/dev/null | \
  grep -c "^dn:" || echo "0")
if [ "\${USER_COUNT:-0}" -gt 0 ]; then
  MESSAGES+="OK: OID user count: \${USER_COUNT}\n"
else
  MESSAGES+="WARNING: OID returned 0 users — possible DIT or connection issue\n"
  [ \${STATUS} -lt 1 ] && STATUS=1
fi

# Check 5: OID replication (if replica configured)
if [ -n "\${OID_REPLICA_HOST}" ]; then
  REPL_RESULT=\$(ldapsearch -H ldap://\${OID_REPLICA_HOST}:\${OID_PORT} \
    -D "\${OID_BIND_DN}" -w "\${OID_BIND_PW}" \
    -b "" -s base "(objectClass=*)" vendorName 2>/dev/null | \
    grep "^vendorName" || echo "")
  if [ -n "\${REPL_RESULT}" ]; then
    MESSAGES+="OK: OID replica (\${OID_REPLICA_HOST}) responding\n"
  else
    MESSAGES+="WARNING: OID replica (\${OID_REPLICA_HOST}) not responding\n"
    [ \${STATUS} -lt 1 ] && STATUS=1
  fi
fi

# Check 6: OUD LDAP port (if OUD is in use)
if [ -n "\${OUD_HOST}" ]; then
  OUD_RESULT=\$(ldapsearch -H ldap://\${OUD_HOST}:\${OUD_PORT} \
    -D "\${OUD_BIND_DN}" -w "\${OUD_BIND_PW}" \
    -b "" -s base "(objectClass=*)" vendorName 2>/dev/null | \
    grep "^vendorName" || echo "")
  if [ -n "\${OUD_RESULT}" ]; then
    MESSAGES+="OK: OUD LDAP port \${OUD_PORT} responding\n"
  else
    MESSAGES+="WARNING: OUD LDAP not responding\n"
    [ \${STATUS} -lt 1 ] && STATUS=1
  fi
fi

# Check 7: OID database connectivity (ODS schema)
OID_DB_LOG="\${ORACLE_HOME}/ldap/log/oidldapd01.log"
if [ -f "\${OID_DB_LOG}" ]; then
  DB_ERRORS=\$(tail -100 "\${OID_DB_LOG}" | \
    grep -c "ORA-\|TNS-\|database.*error\|connection.*fail" 2>/dev/null || echo "0")
  if [ "\${DB_ERRORS:-0}" -gt 0 ]; then
    MESSAGES+="CRITICAL: OID database errors detected in log (\${DB_ERRORS} entries)\n"
    STATUS=2
  else
    MESSAGES+="OK: OID log: no database errors in last 100 lines\n"
  fi
fi

# Check 8: WebLogic Admin Server (ODSM host)
WL_CODE=\$(curl -s -o /dev/null -w "%{http_code}" \
  "http://\${ODSM_HOST}:\${ODSM_PORT}/console" 2>/dev/null || echo "000")
if [ "\${WL_CODE}" = "200" ] || [ "\${WL_CODE}" = "302" ]; then
  MESSAGES+="OK: WebLogic Admin Server responding\n"
else
  MESSAGES+="WARNING: WebLogic Admin Server not responding (HTTP \${WL_CODE})\n"
  [ \${STATUS} -lt 1 ] && STATUS=1
fi

# Check 9: ODS tablespace usage
DB_HOST="oiddb"
DB_PORT="1521"
DB_SID="OIDDB"
TS_PCT=\$(sqlplus -s sys/<sys_password>@\${DB_HOST}:\${DB_PORT}/\${DB_SID} as sysdba <<'SQL_EOF'
SET PAGESIZE 0 FEEDBACK OFF
SELECT ROUND((1 - f.free / t.total) * 100, 1)
FROM (SELECT SUM(bytes) total FROM dba_data_files WHERE tablespace_name='ODS_TS') t,
     (SELECT SUM(bytes) free FROM dba_free_space WHERE tablespace_name='ODS_TS') f;
SQL_EOF
)
PCT=\$(echo "\${TS_PCT}" | grep -E "^[0-9]" | head -1 | tr -d ' ')
if [ -n "\${PCT}" ]; then
  if [ "\${PCT%.*}" -ge 90 ]; then
    MESSAGES+="CRITICAL: ODS tablespace \${PCT}% full\n"
    STATUS=2
  elif [ "\${PCT%.*}" -ge 80 ]; then
    MESSAGES+="WARNING: ODS tablespace \${PCT}% full\n"
    [ \${STATUS} -lt 1 ] && STATUS=1
  else
    MESSAGES+="OK: ODS tablespace \${PCT}% used\n"
  fi
fi

# Emit results
echo "[\${TIMESTAMP}] STATUS=\${STATUS}" >> \${LOG}
echo -e "\${MESSAGES}" >> \${LOG}

if [ \${STATUS} -ne 0 ]; then
  HOSTNAME=\$(hostname -f)
  echo -e "ODSM/OID Health Alert on \${HOSTNAME}\n\n\${MESSAGES}" | \
    mailx -s "ODSM/OID Alert [\${STATUS}] - \${HOSTNAME}" \${EMAIL}
fi

echo -e "\${MESSAGES}"
exit \${STATUS}
SCRIPT_EOF

chmod +x /u01/scripts/odsm_oid_health_check.sh
/u01/scripts/odsm_oid_health_check.sh
echo "Exit: \$?"

# Schedule every 10 minutes
(crontab -l 2>/dev/null; echo "*/10 * * * * /u01/scripts/odsm_oid_health_check.sh >> /var/log/odsm_oid_health.log 2>&1") | crontab -
crontab -l | grep odsm_oid

echo "ODSM/OID health monitoring configured"
\`\`\`

---

## Post-Deployment Validation Checklist

- [ ] ODSM accessible at http://odsm-server:7001/odsm (HTTP 200 or 302)
- [ ] WebLogic Admin Server running, ODSM deployment state is STATE_ACTIVE
- [ ] OID server connection registered (OID-Production visible in ODSM)
- [ ] OUD server connection registered (OUD-Production visible in ODSM, if applicable)
- [ ] ODSM can browse OID DIT (dc=example,dc=com root entry visible)
- [ ] ODSM can browse OUD DIT
- [ ] Test user entry created via LDIF and visible in ODSM DIT browser
- [ ] Schema extension (companyPersonExtension) visible in ODSM Schema section
- [ ] ACIs created on ou=people and ou=employees, verified via ldapsearch
- [ ] Password policy updated (pwdMinLength=12, pwdMaxFailure=5, lockout enabled)
- [ ] Replication agreement visible in ODSM Replication section
- [ ] Replication test: entry added on master appears on replica within 60 seconds
- [ ] DIP synchronisation profiles visible in ODSM DIP section (if DIP is deployed)
- [ ] Health monitoring script returning OK
- [ ] Crontab scheduled (crontab -l | grep odsm_oid)`,
};

async function main() {
  console.log('Inserting ODSM runbook...');
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
