import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Access Manager (OAM) 12c Installation, WebGate, and SSO Policy Configuration',
  slug: 'oracle-access-manager-oam-installation-runbook',
  excerpt:
    'Step-by-step runbook for installing Oracle Access Manager 12c on Linux: RCU schema creation, OAM WebLogic domain configuration, WebGate deployment on OHS, authentication and authorisation policy setup, OAM-OID identity store integration, and a health monitoring script with crontab scheduling.',
  category: 'identity-management' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-07'),
  youtubeUrl: null,
  content: `## Overview

This runbook installs Oracle Access Manager (OAM) 12c (12.2.1.4) on Oracle Linux 8 / RHEL 8, configures OAM to use Oracle Internet Directory (OID) or Oracle Unified Directory (OUD) as the identity store, deploys a WebGate agent on Oracle HTTP Server (OHS), and creates SSO policies to protect a sample application.

**Prerequisites**
- Oracle Linux 8 / RHEL 8, minimum 8 cores, 16 GB RAM, 200 GB disk
- Oracle Database 19c running and accessible (for OAM repository schemas)
- Oracle Internet Directory (OID) or OUD running and accessible on port 389/636
- Oracle JDK 8 or 11 installed at \`/usr/java/jdk\`
- OAM 12c installer downloaded from My Oracle Support (Fusion Middleware 12.2.1.4)
- WebLogic 12.2.1.4 already installed at \`\${WL_HOME}\` (or bundled OAM installer includes WLS)
- sudo / oracle OS user access

---

## Phase 1: Pre-Installation Checks

\`\`\`bash
# Kernel parameters for WebLogic + OAM
cat >> /etc/sysctl.conf <<'EOF'
fs.file-max = 6815744
kernel.sem = 250 32000 100 128
net.core.rmem_max = 4194304
net.core.wmem_max = 4194304
net.ipv4.tcp_rmem = 4096 87380 4194304
net.ipv4.tcp_wmem = 4096 65536 4194304
EOF
sysctl -p

# OS limits for oracle user
cat >> /etc/security/limits.conf <<'EOF'
oracle soft nofile 65536
oracle hard nofile 65536
oracle soft nproc 16384
oracle hard nproc 16384
EOF

# Required packages
dnf install -y libaio libaio-devel gcc libstdc++ libstdc++-devel \
  sysstat unzip zip hostname bc

# Verify JDK
java -version
echo \${JAVA_HOME}

# Verify DB connectivity (OAM schema DB)
sqlplus -L sys/<password>@oamdb:1521/OAMDB as sysdba <<'SQL_EOF'
SELECT instance_name, status FROM v\$instance;
SQL_EOF

# Set OAM environment variables
export ORACLE_BASE=/u01/app/oracle
export MW_HOME=\${ORACLE_BASE}/middleware
export WL_HOME=\${MW_HOME}/wlserver
export IAM_HOME=\${MW_HOME}/idm
export DOMAIN_HOME=\${ORACLE_BASE}/user_projects/domains/IAMDomain
export JAVA_HOME=/usr/java/jdk
export PATH=\${JAVA_HOME}/bin:\${PATH}

echo "Pre-installation checks complete"
\`\`\`

---

## Phase 2: Run Repository Creation Utility (RCU)

RCU creates the database schemas required by OAM and its supporting components (WebLogic, SOA Suite if collocated).

\`\`\`bash
cd \${MW_HOME}/oracle_common/bin

./rcu \
  -silent \
  -createRepository \
  -connectString oamdb:1521:OAMDB \
  -dbUser sys \
  -dbRole sysdba \
  -oracleHome \${MW_HOME} \
  -schemaPrefix DEV \
  -component MDS \
  -component IAU \
  -component IAU_APPEND \
  -component IAU_VIEWER \
  -component OPSS \
  -component WLS \
  -component STB \
  -component OAM \
  -f < /tmp/rcu_passwords.txt 2>&1 | tee /tmp/rcu_output.log

# rcu_passwords.txt format (one line per schema, sys password on first line):
# <sys_password>
# <common_schema_password>
# <common_schema_password>
# ... (repeat for each component)

# Verify schemas created
sqlplus -s sys/<password>@oamdb:1521/OAMDB as sysdba <<'SQL_EOF'
SELECT username, account_status, created
FROM dba_users
WHERE username LIKE 'DEV_%'
ORDER BY username;
SQL_EOF
\`\`\`

---

## Phase 3: Install OAM 12c Binaries

\`\`\`bash
cd /tmp/oam_installer

# Run OAM installer (silent mode)
java -jar fmw_12.2.1.4.0_idm.jar -silent \
  -responseFile /tmp/oam_install_response.rsp \
  -jreLoc \${JAVA_HOME} 2>&1 | tee /tmp/oam_install.log

# oam_install_response.rsp:
cat > /tmp/oam_install_response.rsp <<'RSP_EOF'
[ENGINE]
Response File Version=1.0.0.0.0
[GENERIC]
ORACLE_HOME=/u01/app/oracle/middleware/idm
INSTALL_TYPE=Complete
MYORACLESUPPORT_USERNAME=
MYORACLESUPPORT_PASSWORD=<SECURE VALUE>
DECLINE_SECURITY_UPDATES=true
SECURITY_UPDATES_VIA_MYORACLESUPPORT=false
RSP_EOF

# Verify installation
ls \${IAM_HOME}/idm/server/
\`\`\`

---

## Phase 4: Configure OAM WebLogic Domain

\`\`\`bash
# Use OAM configuration wizard to create the domain
cd \${MW_HOME}/oracle_common/common/bin

# Create domain using WLST offline
cat > /tmp/create_oam_domain.py <<'WLST_EOF'
import os
readTemplate('/u01/app/oracle/middleware/idm/common/templates/wls/iam12212-oam-soa_template.jar')

# Domain settings
set('Name', 'IAMDomain')
set('DomainVersion', '12.2.1.4.0')
cd('/Security/IAMDomain/User/weblogic')
cmo.setPassword('<admin_password>')

# DataSource for OAM schemas
cd('/JDBCSystemResources/opss-datasource/JDBCResource/opss-datasource/JDBCDriverParams/opss-datasource')
set('Url', 'jdbc:oracle:thin:@oamdb:1521:OAMDB')
set('DriverName', 'oracle.jdbc.OracleDriver')
cd('/JDBCSystemResources/opss-datasource/JDBCResource/opss-datasource/JDBCDriverParams/opss-datasource/Properties/opss-datasource/Property/user')
set('Value', 'DEV_OPSS')

# Repeat for OAM datasource, MDS, IAU, STB as needed

setOption('CreateStartMenu', 'false')
setOption('OverwriteDomain', 'true')
writeDomain('/u01/app/oracle/user_projects/domains/IAMDomain')
closeTemplate()
WLST_EOF

\${MW_HOME}/oracle_common/common/bin/wlst.sh /tmp/create_oam_domain.py

# Set domain scripts path
ADMIN_SCRIPTS=\${DOMAIN_HOME}/bin

# Start Node Manager
nohup \${DOMAIN_HOME}/bin/startNodeManager.sh &
sleep 30

# Start Admin Server
nohup \${ADMIN_SCRIPTS}/startWebLogic.sh &
sleep 60

# Verify Admin Server
curl -s http://oam-server:7001/console | grep -i "weblogic"
echo "Admin Server running"
\`\`\`

---

## Phase 5: Configure OAM Identity Store (OID/OUD)

\`\`\`bash
# Use OAM Admin Console or WLST to configure identity store
# Navigate to: http://oam-server:7001/oamconsole

# Or configure via WLST online
\${MW_HOME}/oracle_common/common/bin/wlst.sh <<'WLST_EOF'
connect('weblogic', '<admin_password>', 't3://oam-server:7001')

# Navigate to OAM service
domainRuntime()
cd('/OAMRuntime/oam_server1')

# Configure LDAP identity store
configureIdentityStore(
  name='OIDStore',
  idstoreType='OID',
  host='oid-host',
  port='389',
  bindDN='cn=orcladmin,dc=example,dc=com',
  bindPassword='<oid_admin_password>',
  userSearchBase='ou=people,dc=example,dc=com',
  groupSearchBase='ou=groups,dc=example,dc=com',
  userNameAttribute='uid',
  returnAttribute='uid,cn,mail,orclGUID'
)

# Set as primary identity store
setPrimaryIdentityStore('OIDStore')

disconnect()
exit()
WLST_EOF

# Test LDAP connectivity
ldapsearch -h oid-host -p 389 \
  -D "cn=orcladmin,dc=example,dc=com" \
  -w <oid_admin_password> \
  -b "ou=people,dc=example,dc=com" \
  "(uid=testuser)" dn uid mail

echo "Identity store configured and tested"
\`\`\`

---

## Phase 6: Start OAM Managed Servers

\`\`\`bash
# Start OAM Managed Server via WLST
\${MW_HOME}/oracle_common/common/bin/wlst.sh <<'WLST_EOF'
connect('weblogic', '<admin_password>', 't3://oam-server:7001')
start('oam_server1', 'Server')
disconnect()
exit()
WLST_EOF

sleep 90

# Verify OAM server
curl -s http://oam-server:14100/oam/server/pages/servererror.jsp | head -5
echo "OAM server started"

# Check OAM server log
tail -50 \${DOMAIN_HOME}/servers/oam_server1/logs/oam_server1.log | \
  grep -E "STARTED|ERROR|WARNING" | tail -20
\`\`\`

---

## Phase 7: Register WebGate with OAM

\`\`\`bash
# In OAM Admin Console: http://oam-server:7001/oamconsole
# Navigate to: Infrastructure → Access Manager → SSO Agents → OAM Agents → Create

# Or via OAM REST API (OAM 12c supports REST for WebGate registration)
curl -s -X POST \
  http://oam-server:7001/oam/services/rest/11.1.2.0.0/ssa/agents \
  -H "Content-Type: application/json" \
  -u weblogic:<admin_password> \
  -d '{
    "agentName": "ohs-webgate-01",
    "agentType": "OAM",
    "agentVersion": "12c",
    "hostName": "ohs-webgate-host",
    "port": "7778",
    "security": "open",
    "maxConnections": 1,
    "primaryServerList": [{"host":"oam-server","port":"5575","numConns":1}],
    "preferredHost": "ohs-webgate-host"
  }' | python3 -m json.tool

# Download the generated WebGate configuration (ObAccessClient.xml + wallet)
# OAM Admin Console: Agents → ohs-webgate-01 → Download
# Or via REST - download the agent artifact
curl -s http://oam-server:7001/oam/services/rest/11.1.2.0.0/ssa/agents/ohs-webgate-01/artifact \
  -u weblogic:<admin_password> \
  -o /tmp/webgate-config.zip

echo "WebGate registered with OAM"
\`\`\`

---

## Phase 8: Deploy WebGate on Oracle HTTP Server

\`\`\`bash
# Install WebGate on OHS host (separate from OAM server)
OHS_HOME=/u01/app/oracle/middleware/ohs

cd /tmp/webgate_installer
java -jar fmw_12.2.1.4.0_ohs.jar -silent \
  -responseFile /tmp/ohs_install_response.rsp \
  -jreLoc \${JAVA_HOME}

# Run WebGate installer/configurator
cd \${OHS_HOME}/webgate/ohs/tools/deployWebGate

./deployWebGateInstance.sh \
  -w \${OHS_HOME}/instances/ohs1 \
  -oh \${OHS_HOME}

# Copy the WebGate configuration (from OAM registration)
unzip /tmp/webgate-config.zip -d /tmp/webgate-config/

WEBGATE_CONF_DIR=\${OHS_HOME}/instances/ohs1/config/OHS/ohs1/webgate

cp /tmp/webgate-config/ObAccessClient.xml \${WEBGATE_CONF_DIR}/config/
cp /tmp/webgate-config/password.xml \${WEBGATE_CONF_DIR}/config/
cp -r /tmp/webgate-config/wallet/ \${WEBGATE_CONF_DIR}/

# Configure OHS mod_webgate module
cat >> \${OHS_HOME}/instances/ohs1/config/OHS/ohs1/httpd.conf <<'OHS_EOF'
LoadModule webgate_module \${ORACLE_HOME}/webgate/ohs/lib/webgate.so

# WebGate configuration
WebGateInstalldir \${ORACLE_HOME}/webgate/ohs
WebGateMode Online
OAMRestEndPoint http://oam-server:14100/oam
OAMServerCommunicationMode HTTP
OAMTransferMode Open
OHS_EOF

# Restart OHS
\${OHS_HOME}/instances/ohs1/bin/opmnctl stopall
sleep 10
\${OHS_HOME}/instances/ohs1/bin/opmnctl startall
sleep 20
\${OHS_HOME}/instances/ohs1/bin/opmnctl status

# Test WebGate is loaded
curl -sI http://ohs-webgate-host:7778/ | grep -E "HTTP|Server"
echo "WebGate deployed on OHS"
\`\`\`

---

## Phase 9: Configure Application Domain and SSO Policies

\`\`\`bash
# Create Application Domain via OAM Admin Console
# Navigate to: Infrastructure → Application Domains → Create

# Example: protect the /hrapp/ URL space

# Via REST API:
# 1. Create Application Domain
curl -s -X POST \
  http://oam-server:7001/oam/services/rest/11.1.2.0.0/ssa/policyadmin/appdomain \
  -H "Content-Type: application/json" \
  -u weblogic:<admin_password> \
  -d '{
    "name": "HRApplication",
    "description": "HR Application Domain",
    "agents": ["ohs-webgate-01"],
    "sessionTimeout": 30,
    "maxSession": 480
  }' | python3 -m json.tool

# 2. Add protected resource
curl -s -X POST \
  "http://oam-server:7001/oam/services/rest/11.1.2.0.0/ssa/policyadmin/appdomain/HRApplication/resource" \
  -H "Content-Type: application/json" \
  -u weblogic:<admin_password> \
  -d '{
    "name": "HRProtectedPages",
    "resourceType": "HTTP",
    "resourceURL": "/hrapp/**",
    "queryString": "",
    "operationsList": ["GET","POST","PUT","DELETE"]
  }' | python3 -m json.tool

# 3. Create Authentication Policy
curl -s -X POST \
  "http://oam-server:7001/oam/services/rest/11.1.2.0.0/ssa/policyadmin/appdomain/HRApplication/authnpolicy" \
  -H "Content-Type: application/json" \
  -u weblogic:<admin_password> \
  -d '{
    "name": "HRAuthNPolicy",
    "authnSchemeName": "LDAPScheme",
    "resources": [{"resourceName":"HRProtectedPages"}]
  }' | python3 -m json.tool

# 4. Create Authorisation Policy with response (header injection)
curl -s -X POST \
  "http://oam-server:7001/oam/services/rest/11.1.2.0.0/ssa/policyadmin/appdomain/HRApplication/authzpolicy" \
  -H "Content-Type: application/json" \
  -u weblogic:<admin_password> \
  -d '{
    "name": "HRAuthZPolicy",
    "resources": [{"resourceName":"HRProtectedPages"}],
    "conditionOperator": "AND",
    "conditions": [{"name":"GroupCheck","type":"membershipCondition","groups":["cn=HR-Users,ou=groups,dc=example,dc=com"]}],
    "successActions": [
      {"type":"headerBasedAction","name":"OAM_REMOTE_USER","value":"\${user.attr.uid}"},
      {"type":"headerBasedAction","name":"OAM_USER_EMAIL","value":"\${user.attr.mail}"}
    ]
  }' | python3 -m json.tool

echo "Application domain and SSO policies configured"
\`\`\`

---

## Phase 10: Test SSO End-to-End

\`\`\`bash
# Test 1: Unauthenticated access to protected resource → redirect to OAM login
HTTP_CODE=\$(curl -sk -o /dev/null -w "%{http_code}" \
  http://ohs-webgate-host:7778/hrapp/test)
echo "Unauthenticated access HTTP code: \${HTTP_CODE}"
# Expected: 302 (redirect to OAM login)

# Test 2: Authenticate and get SSO cookie
# Use curl to simulate login
LOGIN_RESP=\$(curl -s -c /tmp/oam_cookies.txt \
  -d "userid=testuser&password=<user_password>" \
  http://oam-server:14100/oam/server/auth_cred_submit 2>&1)
echo "Login response: \$(echo \${LOGIN_RESP} | head -c 200)"

# Test 3: Access protected resource with SSO cookie
curl -sb /tmp/oam_cookies.txt \
  -w "HTTP Status: %{http_code}\n" \
  http://ohs-webgate-host:7778/hrapp/test

# Test 4: Verify OAM header injection
curl -sb /tmp/oam_cookies.txt \
  -D - http://ohs-webgate-host:7778/hrapp/test 2>&1 | \
  grep -E "OAM_REMOTE_USER|OAM_USER_EMAIL|HTTP"

echo "SSO end-to-end test complete"
\`\`\`

---

## Phase 11: OAM Health Monitoring Script

\`\`\`bash
cat > /u01/scripts/oam_health_check.sh <<'SCRIPT_EOF'
#!/bin/bash
# Oracle Access Manager Health Monitor
# Nagios-compatible exit codes: 0=OK, 1=WARNING, 2=CRITICAL

set -euo pipefail

OAM_HOST="oam-server"
OAM_PORT="7001"
OAM_CONSOLE_PORT="14100"
OHS_HOST="ohs-webgate-host"
OHS_PORT="7778"
PROTECTED_URL="/hrapp/healthcheck"
LDAP_HOST="oid-host"
LDAP_PORT="389"
LDAP_BIND_DN="cn=orcladmin,dc=example,dc=com"
LDAP_BIND_PW="<oid_admin_password>"
LDAP_SEARCH_BASE="ou=people,dc=example,dc=com"
EMAIL="dba-alerts@example.com"
LOG="/var/log/oam_health.log"
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')

STATUS=0
MESSAGES=""

# Check 1: WebLogic Admin Server
ADMIN_CODE=\$(curl -s -o /dev/null -w "%{http_code}" \
  http://\${OAM_HOST}:\${OAM_PORT}/console 2>/dev/null || echo "000")
if [ "\${ADMIN_CODE}" = "200" ] || [ "\${ADMIN_CODE}" = "302" ]; then
  MESSAGES+="OK: WebLogic Admin Server responding (HTTP \${ADMIN_CODE})\n"
else
  MESSAGES+="CRITICAL: WebLogic Admin Server not responding (HTTP \${ADMIN_CODE})\n"
  STATUS=2
fi

# Check 2: OAM Managed Server
OAM_CODE=\$(curl -s -o /dev/null -w "%{http_code}" \
  http://\${OAM_HOST}:\${OAM_CONSOLE_PORT}/oam/server/pages/servererror.jsp 2>/dev/null || echo "000")
if [ "\${OAM_CODE}" = "200" ] || [ "\${OAM_CODE}" = "500" ]; then
  MESSAGES+="OK: OAM Server responding (HTTP \${OAM_CODE})\n"
else
  MESSAGES+="CRITICAL: OAM Managed Server not responding (HTTP \${OAM_CODE})\n"
  STATUS=2
fi

# Check 3: WebGate / OHS
OHS_CODE=\$(curl -s -o /dev/null -w "%{http_code}" \
  http://\${OHS_HOST}:\${OHS_PORT}/ 2>/dev/null || echo "000")
if [ "\${OHS_CODE}" != "000" ]; then
  MESSAGES+="OK: OHS WebGate responding (HTTP \${OHS_CODE})\n"
else
  MESSAGES+="CRITICAL: OHS WebGate not responding\n"
  STATUS=2
fi

# Check 4: SSO redirect (unauthenticated access → OAM redirect)
SSO_CODE=\$(curl -s -o /dev/null -w "%{http_code}" \
  http://\${OHS_HOST}:\${OHS_PORT}\${PROTECTED_URL} 2>/dev/null || echo "000")
if [ "\${SSO_CODE}" = "302" ] || [ "\${SSO_CODE}" = "301" ]; then
  MESSAGES+="OK: SSO redirect working (HTTP \${SSO_CODE})\n"
elif [ "\${SSO_CODE}" = "200" ]; then
  MESSAGES+="WARNING: Protected URL returned 200 without auth — check policy\n"
  [ \${STATUS} -lt 1 ] && STATUS=1
else
  MESSAGES+="WARNING: SSO redirect returned unexpected code \${SSO_CODE}\n"
  [ \${STATUS} -lt 1 ] && STATUS=1
fi

# Check 5: LDAP identity store connectivity
LDAP_RESULT=\$(ldapsearch -H ldap://\${LDAP_HOST}:\${LDAP_PORT} \
  -D "\${LDAP_BIND_DN}" -w "\${LDAP_BIND_PW}" \
  -b "\${LDAP_SEARCH_BASE}" -s one "(objectClass=inetOrgPerson)" dn \
  2>/dev/null | grep "^dn:" | wc -l)
if [ "\${LDAP_RESULT:-0}" -gt 0 ]; then
  MESSAGES+="OK: LDAP identity store accessible (\${LDAP_RESULT} entries found)\n"
else
  MESSAGES+="CRITICAL: LDAP identity store not accessible or empty\n"
  STATUS=2
fi

# Check 6: OAP port (WebGate-to-OAM communication)
OAP_CHECK=\$(timeout 5 bash -c "echo '' > /dev/tcp/\${OAM_HOST}/5575" 2>&1 && echo "open" || echo "closed")
if [ "\${OAP_CHECK}" = "open" ]; then
  MESSAGES+="OK: OAP port 5575 reachable\n"
else
  MESSAGES+="WARNING: OAP port 5575 not reachable from monitoring host\n"
  [ \${STATUS} -lt 1 ] && STATUS=1
fi

# Check 7: OAM server log for recent errors
OAM_LOG="\${DOMAIN_HOME:-/u01/app/oracle/user_projects/domains/IAMDomain}/servers/oam_server1/logs/oam_server1.log"
if [ -f "\${OAM_LOG}" ]; then
  RECENT_ERRORS=\$(tail -500 "\${OAM_LOG}" | grep -c "SEVERE\|ERROR" 2>/dev/null || echo "0")
  if [ "\${RECENT_ERRORS:-0}" -gt 10 ]; then
    MESSAGES+="WARNING: \${RECENT_ERRORS} ERROR/SEVERE entries in recent OAM log\n"
    [ \${STATUS} -lt 1 ] && STATUS=1
  else
    MESSAGES+="OK: OAM log clean (\${RECENT_ERRORS} errors in last 500 lines)\n"
  fi
fi

# Write log and alert
echo "[\${TIMESTAMP}] STATUS=\${STATUS}" >> \${LOG}
echo -e "\${MESSAGES}" >> \${LOG}

if [ \${STATUS} -ne 0 ]; then
  HOSTNAME=\$(hostname -f)
  echo -e "OAM Health Alert on \${HOSTNAME}\n\n\${MESSAGES}" | \
    mailx -s "OAM Alert [\${STATUS}] - \${HOSTNAME}" \${EMAIL}
fi

echo -e "\${MESSAGES}"
exit \${STATUS}
SCRIPT_EOF

chmod +x /u01/scripts/oam_health_check.sh

# Test
/u01/scripts/oam_health_check.sh
echo "Exit: \$?"

# Schedule every 10 minutes
(crontab -l 2>/dev/null; echo "*/10 * * * * /u01/scripts/oam_health_check.sh >> /var/log/oam_health.log 2>&1") | crontab -
crontab -l | grep oam_health

echo "OAM health monitoring configured"
\`\`\`

---

## Post-Installation Validation Checklist

- [ ] WebLogic Admin Server accessible at http://oam-server:7001/console
- [ ] OAM Admin Console accessible at http://oam-server:7001/oamconsole
- [ ] OAM Managed Server status RUNNING in Admin Console
- [ ] Identity store connectivity verified (ldapsearch returns user entries)
- [ ] WebGate agent registered in OAM Admin Console (Agents → ohs-webgate-01)
- [ ] OHS restarted with WebGate module loaded (opmn status shows ohs1 running)
- [ ] Unauthenticated access to protected URL returns 302 redirect to OAM login
- [ ] Successful authentication creates OAM SSO cookie
- [ ] Authenticated access to protected URL returns 200 with OAM headers injected
- [ ] OAP port 5575 open between WebGate host and OAM Managed Server
- [ ] Health check script returning OK
- [ ] Monitoring crontab scheduled (crontab -l | grep oam_health)`,
};

async function main() {
  console.log('Inserting OAM runbook...');
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
