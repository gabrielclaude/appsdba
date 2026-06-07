import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Identity Manager (OIM) 12c Installation and EBS Connector Configuration',
  slug: 'oracle-identity-manager-oim-installation-runbook',
  excerpt:
    'Step-by-step runbook for installing Oracle Identity Manager (OIM) 12c: RCU schema setup, OIM WebLogic domain creation, SOA Suite integration, OUD/OID connector configuration, Oracle EBS connector deployment and reconciliation, role provisioning workflow, and an OIM health monitoring script.',
  category: 'identity-management' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-07'),
  youtubeUrl: null,
  content: `## Overview

This runbook installs Oracle Identity Manager (OIM) 12c (12.2.1.4) on Oracle Linux 8 / RHEL 8 with Oracle SOA Suite, configures the Oracle Unified Directory (OUD) connector for LDAP provisioning, deploys the Oracle E-Business Suite connector for EBS account management, and sets up a basic role provisioning workflow.

**Prerequisites**
- Oracle Linux 8 / RHEL 8, minimum 16 cores, 32 GB RAM, 400 GB disk
- Oracle Database 19c (for OIM, SOA, and MDS repository schemas)
- Oracle Unified Directory (OUD) or OID running
- Oracle EBS 12.2 accessible (for EBS connector)
- JDK 8 or 11 at \`/usr/java/jdk\`
- WebLogic 12.2.1.4 installed at \`\${WL_HOME}\`
- OIM 12.2.1.4 installer from MOS (Patch 30741414 or latest)
- sudo / oracle OS user access

---

## Phase 1: Environment Setup and RCU

\`\`\`bash
# OIM environment variables
export ORACLE_BASE=/u01/app/oracle
export MW_HOME=\${ORACLE_BASE}/middleware
export OIM_HOME=\${MW_HOME}/idm
export DOMAIN_HOME=\${ORACLE_BASE}/user_projects/domains/OIMDomain
export JAVA_HOME=/usr/java/jdk
export PATH=\${JAVA_HOME}/bin:\${PATH}

# OS kernel parameters
cat >> /etc/sysctl.conf <<'EOF'
fs.file-max = 6815744
kernel.sem = 250 32000 100 128
kernel.shmall = 2097152
kernel.shmmax = 4294967295
net.ipv4.tcp_keepalive_time = 1800
EOF
sysctl -p

# OS limits
cat >> /etc/security/limits.conf <<'EOF'
oracle soft nofile 65536
oracle hard nofile 65536
oracle soft nproc 16384
oracle hard nproc 16384
oracle soft stack 10240
oracle hard stack 32768
EOF

# Required packages
dnf install -y libaio libaio-devel libstdc++ libstdc++-devel \
  sysstat compat-openssl10 unzip bc hostname

# Run RCU for OIM + SOA schemas
\${MW_HOME}/oracle_common/bin/rcu \
  -silent \
  -createRepository \
  -connectString oimdb:1521:OIMDB \
  -dbUser sys \
  -dbRole sysdba \
  -schemaPrefix OIM \
  -component MDS \
  -component IAU \
  -component IAU_APPEND \
  -component IAU_VIEWER \
  -component OPSS \
  -component WLS \
  -component STB \
  -component OIM \
  -component SOAINFRA \
  -f < /tmp/rcu_pass.txt 2>&1 | tee /tmp/rcu_oim.log

# Verify schemas
sqlplus -s sys/<password>@oimdb:1521/OIMDB as sysdba <<'SQL_EOF'
SELECT username, account_status FROM dba_users
WHERE username LIKE 'OIM_%' ORDER BY username;
SQL_EOF

echo "RCU complete"
\`\`\`

---

## Phase 2: Install OIM Binaries and Create Domain

\`\`\`bash
# Install OIM binaries
cd /tmp/oim_installer
java -jar fmw_12.2.1.4.0_idm.jar -silent \
  -responseFile /tmp/oim_install.rsp \
  -jreLoc \${JAVA_HOME} 2>&1 | tee /tmp/oim_install.log

# Create OIM WebLogic domain using Config Wizard
\${MW_HOME}/oracle_common/common/bin/config.sh -silent \
  -responseFile /tmp/oim_domain.rsp 2>&1 | tee /tmp/oim_domain.log

# oim_domain.rsp must configure:
# - Domain name: OIMDomain
# - Admin user: weblogic / <password>
# - Template: OIM + SOA + Oracle Platform Security Services (OPSS)
# - DataSource URLs for each schema (OIM_OIM, OIM_SOAINFRA, OIM_MDS, etc.)
# - Managed Servers: oim_server1 (OIM), soa_server1 (SOA)

# Start Node Manager
nohup \${DOMAIN_HOME}/bin/startNodeManager.sh &
sleep 30

# Start Admin Server
nohup \${DOMAIN_HOME}/startWebLogic.sh &
sleep 90

# Verify Admin Server
curl -s http://oim-server:7001/console | grep -c "weblogic"

# Start SOA Managed Server (required before OIM)
\${MW_HOME}/oracle_common/common/bin/wlst.sh <<'WLST_EOF'
connect('weblogic', '<admin_password>', 't3://oim-server:7001')
start('soa_server1', 'Server')
disconnect()
exit()
WLST_EOF
sleep 90

# Start OIM Managed Server
\${MW_HOME}/oracle_common/common/bin/wlst.sh <<'WLST_EOF'
connect('weblogic', '<admin_password>', 't3://oim-server:7001')
start('oim_server1', 'Server')
disconnect()
exit()
WLST_EOF
sleep 120

echo "OIM domain started"
\`\`\`

---

## Phase 3: Initial OIM Configuration

\`\`\`bash
# OIM requires initial configuration via the Setup page
# Navigate to: http://oim-server:14000/oim/faces/pages/Admin.jspx

# OIM Design Console (Java Swing) for connector deployment:
OIM_DC=\${OIM_HOME}/idm/designconsole/xlclient.sh
# Run from a GUI session or X11 forwarding
# \${OIM_DC}

# Configure OIM system properties via REST or Admin console
# Key initial configurations:
# 1. Default email gateway (for notifications)
# 2. System administrator email
# 3. Password policy
# 4. Notification template language

# Configure via WLST/OIM API (headless):
cat > /tmp/oim_config.py <<'WLST_EOF'
import sys
sys.path.insert(0, '/u01/app/oracle/middleware/idm/idm/server/apps/oim.ear/iam-consoles-faces.war/WEB-INF/lib')

connect('weblogic', '<admin_password>', 't3://oim-server:7001')
domainRuntime()

# Set system properties via MBean
cd('/OIMRuntime/oim_server1/SystemProperty')

# Email notification gateway
createSystemProperty('XL.MailServer', 'smtp.example.com')
createSystemProperty('XL.MailServerPort', '25')
createSystemProperty('XL.SystemAdminEmail', 'oim-admin@example.com')

disconnect()
exit()
WLST_EOF

echo "OIM initial configuration complete"
\`\`\`

---

## Phase 4: Configure OUD/OID Connector (LDAP Provisioning)

\`\`\`bash
# Deploy the Oracle Directory (OUD/OID) connector from Connector Pack
# Download: Oracle Identity Governance Connector for OUD/LDAP from MOS

# Unzip connector bundle
unzip /tmp/Oracle.Identity.Connector.Bundle.LDAP-12.2.1.3.0.zip \
  -d /tmp/ldap_connector/

# Import connector via OIM Admin Console:
# Identity → Connectors → Import
# Select the connector XML file from /tmp/ldap_connector/

# Or via WLST/curl:
curl -s -X POST \
  http://oim-server:14000/iam/governance/connectors/provision \
  -H "Content-Type: multipart/form-data" \
  -F "connectorFile=@/tmp/ldap_connector/Oracle.Identity.Connector.Bundle.LDAP.xml" \
  -u xelsysadm:<admin_password>

# Create IT Resource for OUD/OID
# OIM Admin Console: Infrastructure → IT Resource → Create
# Or via API:
cat > /tmp/create_it_resource.json <<'JSON_EOF'
{
  "name": "OUD Identity Store",
  "resourceType": "LDAP",
  "parameters": {
    "Server": "oud-host",
    "Port": "1389",
    "SSL": "false",
    "Root Context": "dc=example,dc=com",
    "User Container": "ou=people,dc=example,dc=com",
    "Group Container": "ou=groups,dc=example,dc=com",
    "Bind DN": "cn=oimservice,ou=service-accounts,dc=example,dc=com",
    "Bind Password": "<service_account_password>",
    "GUID Attribute": "entryUUID",
    "UID Attribute": "uid"
  }
}
JSON_EOF

# Test connectivity via OIM connector test
curl -s -X POST \
  "http://oim-server:14000/iam/governance/connectors/test" \
  -H "Content-Type: application/json" \
  -u xelsysadm:<admin_password> \
  -d '{"itResourceName":"OUD Identity Store"}'

echo "LDAP connector configured"
\`\`\`

---

## Phase 5: Configure Oracle EBS Connector

\`\`\`bash
# Download Oracle EBS connector from Oracle Connector Pack
# File: Oracle.Identity.Connector.Bundle.EBS-HRMS-12.2.1.3.0.zip

unzip /tmp/Oracle.Identity.Connector.Bundle.EBS-HRMS-12.2.1.3.0.zip \
  -d /tmp/ebs_connector/

# Create EBS service account in Oracle Database
sqlplus -s apps/<apps_password>@ebs-db:1521/EBSDB <<'SQL_EOF'
-- Create dedicated OIM integration user
CREATE USER oimservice IDENTIFIED BY <oimservice_password>;
GRANT CONNECT TO oimservice;
GRANT SELECT ON fnd_user TO oimservice;
GRANT SELECT ON fnd_responsibility TO oimservice;
GRANT SELECT ON fnd_user_resp_groups_all TO oimservice;
GRANT EXECUTE ON fnd_user_pkg TO oimservice;
SQL_EOF

# Deploy EBS connector in OIM
# Import via OIM Admin Console → Connectors → Import
# Select: /tmp/ebs_connector/Oracle.Identity.Connector.Bundle.EBS.xml

# Create IT Resource for EBS
cat > /tmp/ebs_it_resource.json <<'JSON_EOF'
{
  "name": "Oracle EBS 12.2",
  "resourceType": "Oracle EBS",
  "parameters": {
    "Server": "ebs-host",
    "Port": "1521",
    "Database SID": "EBSDB",
    "EBS Schema": "APPS",
    "EBS Schema Password": "<apps_password>",
    "OIM Integration Schema": "oimservice",
    "OIM Integration Schema Password": "<oimservice_password>",
    "EBS JDBC Driver": "oracle.jdbc.OracleDriver",
    "EBS Application URL": "https://ebs-host:443/OA_HTML"
  }
}
JSON_EOF

# Test EBS connector connectivity
curl -s -X POST \
  "http://oim-server:14000/iam/governance/connectors/test" \
  -H "Content-Type: application/json" \
  -u xelsysadm:<admin_password> \
  -d '{"itResourceName":"Oracle EBS 12.2"}'

echo "EBS connector configured"
\`\`\`

---

## Phase 6: Configure EBS Reconciliation

\`\`\`bash
# Configure EBS Full Reconciliation scheduled task
# OIM Admin Console: Identity → Scheduled Tasks → Create

# EBS User Full Reconciliation job:
cat > /tmp/ebs_recon_job.json <<'JSON_EOF'
{
  "name": "EBS User Full Reconciliation",
  "scheduledTask": "EBS HRMS User Reconciliation",
  "parameters": {
    "IT Resource Name": "Oracle EBS 12.2",
    "Object Type": "User",
    "Reconciliation Mode": "Full"
  },
  "schedule": {
    "type": "DAILY",
    "hour": 2,
    "minute": 0
  }
}
JSON_EOF

# Run initial full reconciliation (manual trigger)
curl -s -X POST \
  "http://oim-server:14000/iam/governance/scheduledtasks/trigger" \
  -H "Content-Type: application/json" \
  -u xelsysadm:<admin_password> \
  -d '{"taskName":"EBS User Full Reconciliation"}'

# Monitor reconciliation progress
curl -s "http://oim-server:14000/iam/governance/reconciliation/events?status=PENDING" \
  -u xelsysadm:<admin_password> | python3 -m json.tool

# Check reconciliation results in OIM console:
# Identity → Reconciliation → Reconciliation Events
# Review: matched accounts, unmatched accounts, failed events

echo "EBS reconciliation configured"
\`\`\`

---

## Phase 7: Create Role and Provision EBS Access

\`\`\`bash
# Create an OIM role via REST API
curl -s -X POST \
  "http://oim-server:14000/iam/governance/v1/roles" \
  -H "Content-Type: application/json" \
  -u xelsysadm:<admin_password> \
  -d '{
    "Role Name": "EBS-HR-Analyst",
    "Role Display Name": "EBS HR Analyst",
    "Role Description": "Access to EBS HR responsibilities for analysts",
    "Role Category": "IT Roles"
  }' | python3 -m json.tool

# Assign EBS entitlement to role (EBS responsibility)
# OIM Admin Console: Roles → EBS-HR-Analyst → Entitlements → Add
# Select: IT Resource = "Oracle EBS 12.2", Responsibility = "HR Analyst"

# Grant role to a user
curl -s -X POST \
  "http://oim-server:14000/iam/governance/v1/users/jsmith/grants" \
  -H "Content-Type: application/json" \
  -u xelsysadm:<admin_password> \
  -d '{
    "requestType": "ASSIGN_ROLE",
    "roles": [{"roleName": "EBS-HR-Analyst"}],
    "justification": "New hire - HR analyst position",
    "effectiveDate": "2026-06-07"
  }' | python3 -m json.tool

# Monitor provisioning task
curl -s "http://oim-server:14000/iam/governance/requests?status=PENDING&assignee=jsmith" \
  -u xelsysadm:<admin_password> | python3 -m json.tool

# Verify EBS account created
sqlplus -s apps/<apps_password>@ebs-db:1521/EBSDB <<'SQL_EOF'
SELECT user_name, email_address, start_date, end_date
FROM fnd_user
WHERE user_name = 'JSMITH';
SQL_EOF

echo "Role provisioning complete"
\`\`\`

---

## Phase 8: OIM Health Monitoring Script

\`\`\`bash
cat > /u01/scripts/oim_health_check.sh <<'SCRIPT_EOF'
#!/bin/bash
# Oracle Identity Manager Health Monitor
# Nagios-compatible exit codes: 0=OK, 1=WARNING, 2=CRITICAL

OIM_HOST="oim-server"
OIM_PORT="14000"
WL_PORT="7001"
DB_HOST="oimdb"
DB_PORT="1521"
DB_SID="OIMDB"
DB_USER="sys"
DB_PASS="<sys_password>"
OIM_USER="xelsysadm"
OIM_PASS="<admin_password>"
EMAIL="dba-alerts@example.com"
LOG="/var/log/oim_health.log"
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')

STATUS=0
MESSAGES=""

# Check 1: WebLogic Admin Server
WL_CODE=\$(curl -s -o /dev/null -w "%{http_code}" \
  http://\${OIM_HOST}:\${WL_PORT}/console 2>/dev/null || echo "000")
if [ "\${WL_CODE}" = "200" ] || [ "\${WL_CODE}" = "302" ]; then
  MESSAGES+="OK: WebLogic Admin Server responding\n"
else
  MESSAGES+="CRITICAL: WebLogic Admin Server not responding (HTTP \${WL_CODE})\n"
  STATUS=2
fi

# Check 2: OIM Managed Server
OIM_CODE=\$(curl -s -o /dev/null -w "%{http_code}" \
  http://\${OIM_HOST}:\${OIM_PORT}/oim 2>/dev/null || echo "000")
if [ "\${OIM_CODE}" != "000" ]; then
  MESSAGES+="OK: OIM Server responding (HTTP \${OIM_CODE})\n"
else
  MESSAGES+="CRITICAL: OIM Managed Server not responding\n"
  STATUS=2
fi

# Check 3: SOA Server (required for OIM workflows)
SOA_CODE=\$(curl -s -o /dev/null -w "%{http_code}" \
  http://\${OIM_HOST}:8001/soa-infra 2>/dev/null || echo "000")
if [ "\${SOA_CODE}" != "000" ]; then
  MESSAGES+="OK: SOA Server responding (HTTP \${SOA_CODE})\n"
else
  MESSAGES+="CRITICAL: SOA Managed Server not responding — workflows will fail\n"
  STATUS=2
fi

# Check 4: OIM database connectivity
DB_STATUS=\$(sqlplus -s \${DB_USER}/\${DB_PASS}@\${DB_HOST}:\${DB_PORT}/\${DB_SID} as sysdba <<'SQL_EOF'
SET PAGESIZE 0 FEEDBACK OFF
SELECT 'connected' FROM dual;
SQL_EOF
)
if echo "\${DB_STATUS}" | grep -q "connected"; then
  MESSAGES+="OK: OIM repository database accessible\n"
else
  MESSAGES+="CRITICAL: OIM repository database not accessible\n"
  STATUS=2
fi

# Check 5: Pending requests older than 24 hours (stuck workflow indicator)
STUCK_REQUESTS=\$(curl -s \
  "http://\${OIM_HOST}:\${OIM_PORT}/iam/governance/requests?status=PENDING" \
  -u \${OIM_USER}:\${OIM_PASS} 2>/dev/null | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('requests',[])))"\
  2>/dev/null || echo "0")
if [ "\${STUCK_REQUESTS:-0}" -gt 50 ]; then
  MESSAGES+="WARNING: \${STUCK_REQUESTS} pending requests — possible workflow backlog\n"
  [ \${STATUS} -lt 1 ] && STATUS=1
else
  MESSAGES+="OK: Pending requests: \${STUCK_REQUESTS}\n"
fi

# Check 6: Failed reconciliation events
FAILED_RECON=\$(curl -s \
  "http://\${OIM_HOST}:\${OIM_PORT}/iam/governance/reconciliation/events?status=FAILED" \
  -u \${OIM_USER}:\${OIM_PASS} 2>/dev/null | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('events',[])))"\
  2>/dev/null || echo "0")
if [ "\${FAILED_RECON:-0}" -gt 0 ]; then
  MESSAGES+="WARNING: \${FAILED_RECON} failed reconciliation events\n"
  [ \${STATUS} -lt 1 ] && STATUS=1
else
  MESSAGES+="OK: No failed reconciliation events\n"
fi

# Check 7: OIM server log errors
OIM_LOG="\${DOMAIN_HOME:-/u01/app/oracle/user_projects/domains/OIMDomain}/servers/oim_server1/logs/oim_server1.log"
if [ -f "\${OIM_LOG}" ]; then
  RECENT_ERRORS=\$(tail -1000 "\${OIM_LOG}" | grep -c "SEVERE\|OIM-\|ERROR" 2>/dev/null || echo "0")
  if [ "\${RECENT_ERRORS:-0}" -gt 20 ]; then
    MESSAGES+="WARNING: \${RECENT_ERRORS} errors in recent OIM log\n"
    [ \${STATUS} -lt 1 ] && STATUS=1
  else
    MESSAGES+="OK: OIM log clean (\${RECENT_ERRORS} errors)\n"
  fi
fi

# Emit results
echo "[\${TIMESTAMP}] STATUS=\${STATUS}" >> \${LOG}
echo -e "\${MESSAGES}" >> \${LOG}

if [ \${STATUS} -ne 0 ]; then
  HOSTNAME=\$(hostname -f)
  echo -e "OIM Health Alert on \${HOSTNAME}\n\n\${MESSAGES}" | \
    mailx -s "OIM Alert [\${STATUS}] - \${HOSTNAME}" \${EMAIL}
fi

echo -e "\${MESSAGES}"
exit \${STATUS}
SCRIPT_EOF

chmod +x /u01/scripts/oim_health_check.sh
/u01/scripts/oim_health_check.sh
echo "Exit: \$?"

# Schedule every 15 minutes
(crontab -l 2>/dev/null; echo "*/15 * * * * /u01/scripts/oim_health_check.sh >> /var/log/oim_health.log 2>&1") | crontab -
crontab -l | grep oim_health

echo "OIM health monitoring configured"
\`\`\`

---

## Post-Installation Validation Checklist

- [ ] WebLogic Admin Server accessible at http://oim-server:7001/console
- [ ] OIM Admin Console accessible at http://oim-server:14000/oim
- [ ] SOA Server running (required for approval workflows)
- [ ] OIM repository database accessible (RCU schemas healthy)
- [ ] OUD/OID connector IT Resource connectivity test passes
- [ ] EBS connector IT Resource connectivity test passes
- [ ] EBS full reconciliation completes without errors
- [ ] Role "EBS-HR-Analyst" created in OIM
- [ ] Test provisioning: grant role to test user, verify EBS account created
- [ ] Test deprovisioning: revoke role, verify EBS account disabled
- [ ] Approval workflow triggers and routes to approver worklist
- [ ] Health check script returning OK
- [ ] Monitoring crontab scheduled (crontab -l | grep oim_health)`,
};

async function main() {
  console.log('Inserting OIM runbook...');
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
