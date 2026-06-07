import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Identity Federation (OIF) 12c Installation, SAML 2.0 Configuration, and OAM Integration',
  slug: 'oracle-identity-federation-oif-installation-runbook',
  excerpt:
    'Step-by-step runbook for installing Oracle Identity Federation (OIF) 12c on Linux: RCU schema creation, OIF WebLogic domain setup, OAM authentication provider integration, Circle of Trust and SAML partner configuration, SP metadata import, attribute mapping, IdP-initiated and SP-initiated SSO testing, federation certificate management, and an OIF health monitoring script.',
  category: 'identity-management' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-07'),
  youtubeUrl: null,
  content: `## Overview

This runbook installs Oracle Identity Federation (OIF) 12c (12.2.1.4) on Oracle Linux 8 / RHEL 8, configures OIF as a SAML 2.0 Identity Provider (IdP) integrated with Oracle Access Manager (OAM) for authentication, registers a SAML Service Provider (SP) partner, configures attribute mapping, and tests end-to-end SP-initiated SSO. It also covers OIF as SP for inbound federation from an external IdP (Azure AD / ADFS pattern).

**Prerequisites**
- Oracle Linux 8 / RHEL 8, minimum 4 cores, 8 GB RAM, 100 GB disk
- Oracle Database 19c for OIF repository schemas
- Oracle Access Manager 12c running and accessible (OIF delegates auth to OAM)
- Oracle Unified Directory / OID running (identity store for user attributes)
- JDK 8 or 11 at \`/usr/java/jdk\`
- Oracle Fusion Middleware 12.2.1.4 (OIF is part of the IDM installer)
- sudo / oracle OS user access

---

## Phase 1: Pre-Installation Setup and RCU

\`\`\`bash
# Set OIF environment
export ORACLE_BASE=/u01/app/oracle
export MW_HOME=\${ORACLE_BASE}/middleware
export OIF_HOME=\${MW_HOME}/idm
export DOMAIN_HOME=\${ORACLE_BASE}/user_projects/domains/OIFDomain
export JAVA_HOME=/usr/java/jdk
export PATH=\${JAVA_HOME}/bin:\${PATH}

# Required OS packages
dnf install -y libaio openssl unzip bc hostname

# Verify JDK
java -version

# Verify OAM is accessible (OIF will integrate with OAM)
curl -s -o /dev/null -w "%{http_code}" http://oam-server:14100/oam/server/pages/servererror.jsp
echo " - OAM server reachable"

# Verify OUD/OID is accessible (user attribute source)
ldapsearch -H ldap://oud-host:1389 \
  -D "cn=oimservice,ou=service-accounts,dc=example,dc=com" \
  -w <service_account_password> \
  -b "ou=people,dc=example,dc=com" -s one "(objectClass=*)" dn 2>/dev/null | head -5

# Run RCU for OIF schemas
\${MW_HOME}/oracle_common/bin/rcu \
  -silent \
  -createRepository \
  -connectString oifdb:1521:OIFDB \
  -dbUser sys \
  -dbRole sysdba \
  -schemaPrefix OIF \
  -component MDS \
  -component IAU \
  -component IAU_APPEND \
  -component IAU_VIEWER \
  -component OPSS \
  -component WLS \
  -component STB \
  -component OIF \
  -f < /tmp/rcu_pass.txt 2>&1 | tee /tmp/rcu_oif.log

# Verify schemas
sqlplus -s sys/<password>@oifdb:1521/OIFDB as sysdba <<'SQL_EOF'
SELECT username, account_status FROM dba_users
WHERE username LIKE 'OIF_%' ORDER BY username;
SQL_EOF

echo "RCU complete"
\`\`\`

---

## Phase 2: Install OIF Binaries and Create Domain

\`\`\`bash
# OIF is installed via the IDM installer (same binary as OAM/OIM)
cd /tmp/oif_installer
java -jar fmw_12.2.1.4.0_idm.jar -silent \
  -responseFile /tmp/oif_install.rsp \
  -jreLoc \${JAVA_HOME} 2>&1 | tee /tmp/oif_install.log

# Create OIF WebLogic domain
# OIF can be in a standalone domain or in the same domain as OAM
# Standalone domain is recommended for production (independent lifecycle)
\${MW_HOME}/oracle_common/common/bin/wlst.sh <<'WLST_EOF'
readTemplate('/u01/app/oracle/middleware/idm/common/templates/wls/iam12212-oif_template.jar')

set('Name', 'OIFDomain')
cd('/Security/OIFDomain/User/weblogic')
cmo.setPassword('<admin_password>')

# DataSources
cd('/JDBCSystemResources/opss-datasource/JDBCResource/opss-datasource/JDBCDriverParams/opss-datasource')
set('Url', 'jdbc:oracle:thin:@oifdb:1521:OIFDB')
set('DriverName', 'oracle.jdbc.OracleDriver')
cd('/JDBCSystemResources/opss-datasource/JDBCResource/opss-datasource/JDBCDriverParams/opss-datasource/Properties/opss-datasource/Property/user')
set('Value', 'OIF_OPSS')

# OIF-specific DataSource
cd('/JDBCSystemResources/oif-datasource/JDBCResource/oif-datasource/JDBCDriverParams/oif-datasource')
set('Url', 'jdbc:oracle:thin:@oifdb:1521:OIFDB')
cd('/JDBCSystemResources/oif-datasource/JDBCResource/oif-datasource/JDBCDriverParams/oif-datasource/Properties/oif-datasource/Property/user')
set('Value', 'OIF_OIF')

setOption('CreateStartMenu', 'false')
setOption('OverwriteDomain', 'true')
writeDomain('/u01/app/oracle/user_projects/domains/OIFDomain')
closeTemplate()
WLST_EOF

# Start Node Manager
nohup \${DOMAIN_HOME}/bin/startNodeManager.sh &
sleep 20

# Start Admin Server
nohup \${DOMAIN_HOME}/startWebLogic.sh &
sleep 90

# Verify
curl -s -o /dev/null -w "%{http_code}" http://oif-server:7001/console
echo " - OIF Admin Server responding"

# Start OIF Managed Server
\${MW_HOME}/oracle_common/common/bin/wlst.sh <<'WLST_EOF'
connect('weblogic', '<admin_password>', 't3://oif-server:7001')
start('oif_server1', 'Server')
disconnect()
exit()
WLST_EOF
sleep 90

echo "OIF domain started"
\`\`\`

---

## Phase 3: Configure OIF IdP Identity Store

\`\`\`bash
# OIF needs access to the LDAP identity store to retrieve user attributes
# for inclusion in SAML assertions

# Configure via OIF Admin Console:
# http://oif-server:7001/fed/admin

# Or via WLST:
\${MW_HOME}/oracle_common/common/bin/wlst.sh <<'WLST_EOF'
connect('weblogic', '<admin_password>', 't3://oif-server:7001')
domainRuntime()

# Configure OIF identity store (OUD/OID)
cd('/OIFRuntime/oif_server1')
configureIdentityStore(
  name='OUDStore',
  host='oud-host',
  port='1389',
  bindDN='cn=oifservice,ou=service-accounts,dc=example,dc=com',
  bindPassword='<oif_service_password>',
  userSearchBase='ou=people,dc=example,dc=com',
  groupSearchBase='ou=groups,dc=example,dc=com',
  userIDAttribute='uid',
  userPasswordAttribute='userPassword',
  useSSL='false'
)

disconnect()
exit()
WLST_EOF

# Test identity store connectivity
ldapsearch -H ldap://oud-host:1389 \
  -D "cn=oifservice,ou=service-accounts,dc=example,dc=com" \
  -w <oif_service_password> \
  -b "ou=people,dc=example,dc=com" \
  "(uid=testuser)" uid mail cn

echo "OIF identity store configured"
\`\`\`

---

## Phase 4: Integrate OIF with OAM for Authentication

OIF delegates user authentication to OAM rather than collecting credentials directly.

\`\`\`bash
# Configure OAM integration in OIF Admin Console
# Navigate to: http://oif-server:7001/fed/admin
# Configuration → Authentication Engines → OAM Integration

# Or via WLST:
\${MW_HOME}/oracle_common/common/bin/wlst.sh <<'WLST_EOF'
connect('weblogic', '<admin_password>', 't3://oif-server:7001')
domainRuntime()
cd('/OIFRuntime/oif_server1')

# Register OAM as the authentication engine
configureOAMIntegration(
  oamServerHost='oam-server',
  oamServerPort='14100',
  oamAdminUser='weblogic',
  oamAdminPassword='<oam_admin_password>',
  cookieDomain='.example.com',
  cookieName='OAMAuthnCookie',
  loginURL='http://oam-server:14100/oam/server/auth_cred_submit',
  logoutURL='http://oam-server:14100/oam/server/logout'
)

disconnect()
exit()
WLST_EOF

# Register OIF in OAM as a protected application
# OIF Admin Console and OAM both need to know about each other:
# In OAM Admin Console, protect /fed/idp/sso with a FormScheme policy
# so unauthenticated users hitting OIF's SSO endpoint get redirected to OAM login

curl -s -X POST \
  "http://oam-server:7001/oam/services/rest/11.1.2.0.0/ssa/policyadmin/appdomain" \
  -H "Content-Type: application/json" \
  -u weblogic:<oam_admin_password> \
  -d '{
    "name": "OIF-Federation",
    "description": "OIF SSO endpoint protection",
    "agents": ["ohs-webgate-01"],
    "sessionTimeout": 480
  }' | python3 -m json.tool

echo "OAM-OIF integration configured"
\`\`\`

---

## Phase 5: Generate and Export OIF IdP Metadata

\`\`\`bash
# OIF generates its SAML 2.0 metadata automatically after startup
# Retrieve OIF IdP metadata
curl -s "http://oif-server:7778/fed/idp/metadata" \
  -o /tmp/oif_idp_metadata.xml

# Verify metadata content
python3 -c "
import xml.etree.ElementTree as ET
tree = ET.parse('/tmp/oif_idp_metadata.xml')
root = tree.getroot()
print('EntityID:', root.get('entityID'))
# Print SSO endpoints
for child in root.iter('{urn:oasis:names:tc:SAML:2.0:metadata}SingleSignOnService'):
    print('SSO:', child.get('Binding').split(':')[-1], '->', child.get('Location'))
for child in root.iter('{urn:oasis:names:tc:SAML:2.0:metadata}SingleLogoutService'):
    print('SLO:', child.get('Binding').split(':')[-1], '->', child.get('Location'))
"

# Check signing certificate expiry
openssl x509 -noout -dates -in <(
  python3 -c "
import xml.etree.ElementTree as ET, base64
tree = ET.parse('/tmp/oif_idp_metadata.xml')
for elem in tree.iter('{http://www.w3.org/2000/09/xmldsig#}X509Certificate'):
    print('-----BEGIN CERTIFICATE-----')
    print(elem.text.strip())
    print('-----END CERTIFICATE-----')
    break
"
)

echo "OIF IdP metadata generated"
# Share /tmp/oif_idp_metadata.xml with federation partners
\`\`\`

---

## Phase 6: Register a SAML SP Partner (Salesforce Example)

\`\`\`bash
# Obtain Salesforce SP metadata from Salesforce Setup:
# Setup → Identity → Single Sign-On Settings → Download Metadata
# Save as /tmp/salesforce_sp_metadata.xml

# Import SP metadata into OIF
curl -s -X POST \
  "http://oif-server:7001/fed/admin/api/v1/partners/import" \
  -H "Content-Type: multipart/form-data" \
  -F "metadataFile=@/tmp/salesforce_sp_metadata.xml" \
  -F "partnerType=SP" \
  -u weblogic:<admin_password>

# Alternatively via OIF Admin Console:
# Federations → Partners → Add → Import Metadata → upload salesforce_sp_metadata.xml

# Configure NameID format for Salesforce (uses emailAddress)
curl -s -X PUT \
  "http://oif-server:7001/fed/admin/api/v1/partners/salesforce.com" \
  -H "Content-Type: application/json" \
  -u weblogic:<admin_password> \
  -d '{
    "nameIDFormat": "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    "nameIDAttribute": "mail",
    "enabled": true,
    "defaultAttributeProfile": "Salesforce-Attributes"
  }' | python3 -m json.tool

# Create Circle of Trust and add Salesforce SP
curl -s -X POST \
  "http://oif-server:7001/fed/admin/api/v1/cots" \
  -H "Content-Type: application/json" \
  -u weblogic:<admin_password> \
  -d '{
    "name": "ExternalPartnersCOT",
    "description": "Circle of Trust for external SaaS partners",
    "idpList": ["https://oif.example.com"],
    "spList": ["https://saml.salesforce.com"]
  }' | python3 -m json.tool

echo "Salesforce SP partner registered"
\`\`\`

---

## Phase 7: Configure Attribute Mapping

\`\`\`bash
# Create attribute profile for Salesforce
# Maps LDAP attributes to SAML assertion attributes

cat > /tmp/salesforce_attr_mapping.json <<'JSON_EOF'
{
  "profileName": "Salesforce-Attributes",
  "description": "Attribute mapping for Salesforce SP",
  "attributes": [
    {
      "assertionAttributeName": "Email",
      "ldapAttribute": "mail",
      "format": "urn:oasis:names:tc:SAML:2.0:attrname-format:basic"
    },
    {
      "assertionAttributeName": "FirstName",
      "ldapAttribute": "givenName",
      "format": "urn:oasis:names:tc:SAML:2.0:attrname-format:basic"
    },
    {
      "assertionAttributeName": "LastName",
      "ldapAttribute": "sn",
      "format": "urn:oasis:names:tc:SAML:2.0:attrname-format:basic"
    },
    {
      "assertionAttributeName": "Department",
      "ldapAttribute": "departmentNumber",
      "format": "urn:oasis:names:tc:SAML:2.0:attrname-format:basic"
    },
    {
      "assertionAttributeName": "EmployeeID",
      "ldapAttribute": "employeeNumber",
      "format": "urn:oasis:names:tc:SAML:2.0:attrname-format:basic"
    }
  ]
}
JSON_EOF

curl -s -X POST \
  "http://oif-server:7001/fed/admin/api/v1/attributeprofiles" \
  -H "Content-Type: application/json" \
  -u weblogic:<admin_password> \
  -d @/tmp/salesforce_attr_mapping.json | python3 -m json.tool

echo "Attribute mapping configured"
\`\`\`

---

## Phase 8: Register an External IdP Partner (Azure AD Example)

OIF as SP — allow Azure AD-authenticated users to access Oracle applications.

\`\`\`bash
# Obtain Azure AD IdP metadata
# Azure Portal → Azure Active Directory → Enterprise Applications
# → New Application → SAML → Download Federation Metadata XML
# Save as /tmp/azure_ad_metadata.xml

# Import Azure AD IdP metadata into OIF
curl -s -X POST \
  "http://oif-server:7001/fed/admin/api/v1/partners/import" \
  -H "Content-Type: multipart/form-data" \
  -F "metadataFile=@/tmp/azure_ad_metadata.xml" \
  -F "partnerType=IDP" \
  -u weblogic:<admin_password>

# Export OIF SP metadata for Azure AD registration
curl -s "http://oif-server:7778/fed/sp/metadata" \
  -o /tmp/oif_sp_metadata.xml

# Verify SP metadata
grep -E "entityID|AssertionConsumerService|Location" /tmp/oif_sp_metadata.xml | head -10

# Upload /tmp/oif_sp_metadata.xml to Azure AD Enterprise App SAML configuration:
# Azure Portal → Enterprise App → Single sign-on → Upload metadata file

# Configure OIF inbound attribute mapping for Azure AD users
# Azure AD sends claims like:
# http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress
# http://schemas.microsoft.com/identity/claims/displayname

cat > /tmp/azuread_attr_mapping.json <<'JSON_EOF'
{
  "profileName": "AzureAD-Inbound",
  "description": "Map Azure AD claims to OIF user session attributes",
  "inboundMappings": [
    {
      "samlAttribute": "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
      "localAttribute": "mail"
    },
    {
      "samlAttribute": "http://schemas.microsoft.com/identity/claims/displayname",
      "localAttribute": "cn"
    },
    {
      "samlAttribute": "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
      "localAttribute": "givenName"
    }
  ]
}
JSON_EOF

curl -s -X POST \
  "http://oif-server:7001/fed/admin/api/v1/attributeprofiles/inbound" \
  -H "Content-Type: application/json" \
  -u weblogic:<admin_password> \
  -d @/tmp/azuread_attr_mapping.json | python3 -m json.tool

echo "Azure AD IdP partner registered"
\`\`\`

---

## Phase 9: Test SSO End-to-End

\`\`\`bash
# Test 1: Retrieve OIF IdP metadata (confirms OIF is serving SAML metadata)
HTTP_CODE=\$(curl -s -o /dev/null -w "%{http_code}" \
  http://oif-server:7778/fed/idp/metadata)
echo "Metadata endpoint HTTP code: \${HTTP_CODE}"
# Expected: 200

# Test 2: SP-Initiated SSO redirect (should redirect to OAM login)
# Construct a minimal SAML AuthnRequest
python3 - <<'PYEOF'
import base64, zlib, urllib.parse

authn_req = '''<samlp:AuthnRequest
  xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  ID="_testid001"
  Version="2.0"
  IssueInstant="2026-06-07T00:00:00Z"
  Destination="http://oif-server:7778/fed/idp/sso"
  AssertionConsumerServiceURL="https://saml.salesforce.com/..."
  ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">
  <saml:Issuer>https://saml.salesforce.com</saml:Issuer>
</samlp:AuthnRequest>'''

compressed = zlib.compress(authn_req.encode())[2:-4]
encoded = base64.b64encode(compressed).decode()
url_encoded = urllib.parse.quote(encoded)
print(f"http://oif-server:7778/fed/idp/sso?SAMLRequest={url_encoded[:80]}...")
PYEOF

# Test 3: Check OIF logs for SAML processing messages
OIF_LOG="\${DOMAIN_HOME}/servers/oif_server1/logs/oif_server1.log"
tail -50 \${OIF_LOG} | grep -E "SAML|federation|AuthnRequest|Assertion|ERROR" | tail -20

# Test 4: Verify partner is registered and enabled
curl -s "http://oif-server:7001/fed/admin/api/v1/partners" \
  -u weblogic:<admin_password> | python3 -m json.tool | grep -E "name|enabled|partnerType"

# Test 5: SP-initiated SSO via browser
# Navigate to: https://login.salesforce.com (Salesforce SSO entry point)
# → Salesforce sends AuthnRequest to OIF
# → OIF redirects to OAM login if no session
# → User authenticates with OAM
# → OAM cookie created; OIF issues SAML assertion
# → Salesforce receives assertion, logs user in
echo "SSO testing complete — verify in browser"
\`\`\`

---

## Phase 10: Federation Certificate Management

\`\`\`bash
# Check current signing certificate expiry
curl -s "http://oif-server:7778/fed/idp/metadata" | \
  python3 -c "
import sys, base64, subprocess
from xml.etree import ElementTree as ET

tree = ET.parse(sys.stdin)
for elem in tree.iter('{http://www.w3.org/2000/09/xmldsig#}X509Certificate'):
    cert_pem = '-----BEGIN CERTIFICATE-----\n' + elem.text.strip() + '\n-----END CERTIFICATE-----'
    result = subprocess.run(
        ['openssl', 'x509', '-noout', '-dates', '-subject'],
        input=cert_pem.encode(), capture_output=True
    )
    print(result.stdout.decode())
    break
"

# Rotate signing certificate (requires partner coordination)
# Step 1: Generate new key pair in OIF keystore
keytool -genkeypair \
  -alias oif-signing-new \
  -keyalg RSA \
  -keysize 2048 \
  -validity 1095 \
  -keystore \${DOMAIN_HOME}/config/fmwconfig/oif_keystore.jks \
  -storepass <keystore_password> \
  -dname "CN=oif.example.com, OU=IAM, O=Example Corp, L=Sydney, ST=NSW, C=AU"

# Step 2: Export new public cert for distribution to partners
keytool -exportcert \
  -alias oif-signing-new \
  -keystore \${DOMAIN_HOME}/config/fmwconfig/oif_keystore.jks \
  -storepass <keystore_password> \
  -rfc \
  -file /tmp/oif_new_signing_cert.pem

openssl x509 -in /tmp/oif_new_signing_cert.pem -noout -dates -subject

# Step 3: Update OIF to publish both old and new certs in metadata
# (dual-cert period allows partners to pre-load the new cert before switchover)
# OIF Admin Console: Security → Keystore → Add Second Signing Certificate

# Step 4: Notify all partners to update OIF metadata in their systems
# Partners must import new OIF metadata before switchover date

# Step 5: On switchover date, activate new signing key in OIF
# OIF Admin Console: Security → Keystore → Set Active Signing Key → oif-signing-new

echo "Certificate rotation initiated — notify partners to update metadata"
\`\`\`

---

## Phase 11: OIF Health Monitoring Script

\`\`\`bash
cat > /u01/scripts/oif_health_check.sh <<'SCRIPT_EOF'
#!/bin/bash
# Oracle Identity Federation Health Monitor
# Nagios-compatible exit codes: 0=OK, 1=WARNING, 2=CRITICAL

OIF_HOST="oif-server"
OIF_ADMIN_PORT="7001"
OIF_HTTP_PORT="7778"
OAM_HOST="oam-server"
OAM_PORT="14100"
LDAP_HOST="oud-host"
LDAP_PORT="1389"
LDAP_BIND_DN="cn=oifservice,ou=service-accounts,dc=example,dc=com"
LDAP_BIND_PW="<service_account_password>"
LDAP_BASE="ou=people,dc=example,dc=com"
EMAIL="dba-alerts@example.com"
LOG="/var/log/oif_health.log"
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
DOMAIN_HOME="\${DOMAIN_HOME:-/u01/app/oracle/user_projects/domains/OIFDomain}"

STATUS=0
MESSAGES=""

# Check 1: OIF Admin (WebLogic) Server
WL_CODE=\$(curl -s -o /dev/null -w "%{http_code}" \
  "http://\${OIF_HOST}:\${OIF_ADMIN_PORT}/console" 2>/dev/null || echo "000")
if [ "\${WL_CODE}" = "200" ] || [ "\${WL_CODE}" = "302" ]; then
  MESSAGES+="OK: WebLogic Admin Server responding\n"
else
  MESSAGES+="CRITICAL: WebLogic Admin Server not responding (HTTP \${WL_CODE})\n"
  STATUS=2
fi

# Check 2: OIF Managed Server SAML metadata endpoint
META_CODE=\$(curl -s -o /dev/null -w "%{http_code}" \
  "http://\${OIF_HOST}:\${OIF_HTTP_PORT}/fed/idp/metadata" 2>/dev/null || echo "000")
if [ "\${META_CODE}" = "200" ]; then
  MESSAGES+="OK: OIF IdP metadata endpoint responding\n"
else
  MESSAGES+="CRITICAL: OIF SAML metadata endpoint not responding (HTTP \${META_CODE})\n"
  STATUS=2
fi

# Check 3: OIF signing certificate expiry
CERT_EXPIRY=\$(curl -s "http://\${OIF_HOST}:\${OIF_HTTP_PORT}/fed/idp/metadata" 2>/dev/null | \
  python3 -c "
import sys, base64, subprocess
from xml.etree import ElementTree as ET
try:
    tree = ET.parse(sys.stdin)
    for elem in tree.iter('{http://www.w3.org/2000/09/xmldsig#}X509Certificate'):
        cert_pem = '-----BEGIN CERTIFICATE-----\n' + elem.text.strip() + '\n-----END CERTIFICATE-----'
        result = subprocess.run(['openssl','x509','-noout','-enddate'], input=cert_pem.encode(), capture_output=True)
        print(result.stdout.decode().strip().replace('notAfter=',''))
        break
except: print('')
" 2>/dev/null || echo "")

if [ -n "\${CERT_EXPIRY}" ]; then
  CERT_EPOCH=\$(date -d "\${CERT_EXPIRY}" +%s 2>/dev/null || \
               date -jf "%b %d %H:%M:%S %Y %Z" "\${CERT_EXPIRY}" +%s 2>/dev/null || echo "0")
  NOW_EPOCH=\$(date +%s)
  DAYS_LEFT=\$(( (CERT_EPOCH - NOW_EPOCH) / 86400 ))
  if [ "\${DAYS_LEFT}" -le 30 ]; then
    MESSAGES+="CRITICAL: OIF signing cert expires in \${DAYS_LEFT} days — rotate immediately\n"
    STATUS=2
  elif [ "\${DAYS_LEFT}" -le 90 ]; then
    MESSAGES+="WARNING: OIF signing cert expires in \${DAYS_LEFT} days — plan rotation\n"
    [ \${STATUS} -lt 1 ] && STATUS=1
  else
    MESSAGES+="OK: OIF signing cert valid for \${DAYS_LEFT} days\n"
  fi
else
  MESSAGES+="WARNING: Could not parse OIF signing cert expiry\n"
  [ \${STATUS} -lt 1 ] && STATUS=1
fi

# Check 4: OAM (authentication engine) accessibility
OAM_CODE=\$(curl -s -o /dev/null -w "%{http_code}" \
  "http://\${OAM_HOST}:\${OAM_PORT}/oam/server/pages/servererror.jsp" 2>/dev/null || echo "000")
if [ "\${OAM_CODE}" != "000" ]; then
  MESSAGES+="OK: OAM authentication engine reachable (HTTP \${OAM_CODE})\n"
else
  MESSAGES+="CRITICAL: OAM not reachable — federation logins will fail\n"
  STATUS=2
fi

# Check 5: LDAP identity store accessibility
LDAP_COUNT=\$(ldapsearch -H ldap://\${LDAP_HOST}:\${LDAP_PORT} \
  -D "\${LDAP_BIND_DN}" -w "\${LDAP_BIND_PW}" \
  -b "\${LDAP_BASE}" -s one "(objectClass=inetOrgPerson)" dn \
  2>/dev/null | grep -c "^dn:" || echo "0")
if [ "\${LDAP_COUNT:-0}" -gt 0 ]; then
  MESSAGES+="OK: LDAP identity store accessible (\${LDAP_COUNT} users)\n"
else
  MESSAGES+="CRITICAL: LDAP identity store not accessible — attribute resolution will fail\n"
  STATUS=2
fi

# Check 6: OIF log for SAML errors
OIF_LOG="\${DOMAIN_HOME}/servers/oif_server1/logs/oif_server1.log"
if [ -f "\${OIF_LOG}" ]; then
  SAML_ERRORS=\$(tail -500 "\${OIF_LOG}" | \
    grep -c "SEVERE\|SAML.*error\|federation.*fail\|signature.*invalid" 2>/dev/null || echo "0")
  if [ "\${SAML_ERRORS:-0}" -gt 5 ]; then
    MESSAGES+="WARNING: \${SAML_ERRORS} SAML/federation errors in recent log\n"
    [ \${STATUS} -lt 1 ] && STATUS=1
  else
    MESSAGES+="OK: OIF log: \${SAML_ERRORS} errors in last 500 lines\n"
  fi
fi

# Check 7: Partner count (sanity check)
PARTNER_COUNT=\$(curl -s \
  "http://\${OIF_HOST}:\${OIF_ADMIN_PORT}/fed/admin/api/v1/partners" \
  -u weblogic:<admin_password> 2>/dev/null | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('partners',[])))" \
  2>/dev/null || echo "0")
MESSAGES+="INFO: Registered federation partners: \${PARTNER_COUNT}\n"

# Emit results
echo "[\${TIMESTAMP}] STATUS=\${STATUS}" >> \${LOG}
echo -e "\${MESSAGES}" >> \${LOG}

if [ \${STATUS} -ne 0 ]; then
  HOSTNAME=\$(hostname -f)
  echo -e "OIF Health Alert on \${HOSTNAME}\n\n\${MESSAGES}" | \
    mailx -s "OIF Alert [\${STATUS}] - \${HOSTNAME}" \${EMAIL}
fi

echo -e "\${MESSAGES}"
exit \${STATUS}
SCRIPT_EOF

chmod +x /u01/scripts/oif_health_check.sh
/u01/scripts/oif_health_check.sh
echo "Exit: \$?"

# Schedule every 10 minutes
(crontab -l 2>/dev/null; echo "*/10 * * * * /u01/scripts/oif_health_check.sh >> /var/log/oif_health.log 2>&1") | crontab -
crontab -l | grep oif_health

echo "OIF health monitoring configured"
\`\`\`

---

## Post-Installation Validation Checklist

- [ ] WebLogic Admin Server accessible at http://oif-server:7001/console
- [ ] OIF Admin Console accessible at http://oif-server:7001/fed/admin
- [ ] OIF Managed Server status RUNNING
- [ ] OIF IdP metadata served at http://oif-server:7778/fed/idp/metadata (HTTP 200)
- [ ] OIF SP metadata served at http://oif-server:7778/fed/sp/metadata (HTTP 200)
- [ ] LDAP identity store connectivity test passes (ldapsearch returns users)
- [ ] OAM accessible from OIF server on port 14100
- [ ] Salesforce SP partner registered and enabled in OIF Admin Console
- [ ] Azure AD IdP partner registered and enabled in OIF Admin Console
- [ ] Circle of Trust created with both IdP and SP members
- [ ] Attribute profile "Salesforce-Attributes" created with email/name/dept mappings
- [ ] SP-initiated SSO redirects to OAM login page (unauthenticated browser test)
- [ ] Authenticated SSO delivers SAML assertion to SP ACS URL
- [ ] Signing certificate valid for more than 90 days
- [ ] Health check script returning OK (\`/u01/scripts/oif_health_check.sh\`)
- [ ] Monitoring crontab scheduled (\`crontab -l | grep oif_health\`)`,
};

async function main() {
  console.log('Inserting OIF runbook...');
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
