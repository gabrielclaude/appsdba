import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Fusion Middleware Security Hardening',
  slug: 'fusion-middleware-security-hardening-runbook',
  excerpt:
    'Security hardening runbook for Oracle Fusion Middleware 12c — replacing demo SSL certificates, enforcing TLS 1.2+, disabling weak ciphers, locking down Node Manager and admin ports, configuring LDAP authentication, hardening OPSS, rotating RCU schema passwords, enabling audit services, and disabling remote debugging.',
  category: 'fusion-middleware' as const,
  published: true,
  publishedAt: new Date('2026-06-01'),
  youtubeUrl: null,
  content: `A default FMW 12c installation is not production-secure. It ships with demo SSL certificates, the admin console open to all networks, T3 protocol unauthenticated on internal ports, remote debugging potentially enabled, and default WebLogic sample deployments that expose known attack surfaces. This runbook addresses each of these systematically. Work through the phases in order — some later phases depend on SSL certificates configured in the earlier ones.

---

## Hardening Scope

| Area | Risk if unaddressed |
|---|---|
| Demo SSL certificates | Man-in-the-middle on HTTPS; certificates are publicly known |
| Weak TLS protocols (SSLv3, TLS 1.0/1.1) | POODLE, BEAST, CRIME attacks |
| Weak cipher suites | Downgrade attacks, export cipher exploitation |
| Admin console open to all networks | Direct browser-based attack surface from any network |
| T3 and IIOP protocols | Remote code execution via deserialization if reachable from untrusted networks |
| Default sample deployments | Known vulnerable endpoints (medrec, wl_management_internal) |
| Remote JDWP debug port | Full JVM control to anyone who connects |
| Default embedded LDAP admin password | Credential stuffing with known default |
| Node Manager unauthenticated | Can start/stop/kill any managed server in the domain |
| RCU schema passwords set during install | Often weak or shared across environments |
| Audit disabled | No trail for security incident investigation |

---

## Phase 1: Replace Demo SSL Certificates

The FMW installer creates a demo keystore and truststore under the domain home. These use the same private key across all Oracle installations — any attacker who has ever downloaded Oracle FMW can impersonate your server.

### 1.1 Generate a CSR and obtain a signed certificate

\`\`\`bash
# Create a directory for keystores
mkdir -p \${DOMAIN_HOME}/config/fmwconfig/keystores
cd \${DOMAIN_HOME}/config/fmwconfig/keystores

# Generate a new private key and keystore
keytool -genkeypair \\
  -alias server_cert \\
  -keyalg RSA \\
  -keysize 2048 \\
  -sigalg SHA256withRSA \\
  -validity 825 \\
  -keystore identity.jks \\
  -storepass <keystore_password> \\
  -keypass <key_password> \\
  -dname "CN=soa-node1.example.com, OU=IT, O=Example Corp, L=New York, ST=NY, C=US" \\
  -ext "SAN=dns:soa-node1.example.com,dns:lb.example.com"

# Generate a Certificate Signing Request (CSR)
keytool -certreq \\
  -alias server_cert \\
  -keystore identity.jks \\
  -storepass <keystore_password> \\
  -file soa_server.csr
\`\`\`

Submit \`soa_server.csr\` to your internal CA or a public CA. The CA returns a signed certificate (\`soa_server.crt\`) and its chain (\`ca_chain.crt\`).

### 1.2 Import the signed certificate into the identity keystore

\`\`\`bash
# Import CA chain first
keytool -importcert \\
  -alias ca_chain \\
  -file ca_chain.crt \\
  -keystore identity.jks \\
  -storepass <keystore_password> \\
  -noprompt

# Import the signed server certificate
keytool -importcert \\
  -alias server_cert \\
  -file soa_server.crt \\
  -keystore identity.jks \\
  -storepass <keystore_password>
\`\`\`

### 1.3 Create a trust keystore containing the CA certificate

\`\`\`bash
keytool -importcert \\
  -alias ca_root \\
  -file ca_chain.crt \\
  -keystore trust.jks \\
  -storepass <truststore_password> \\
  -noprompt

# Verify the keystore contents
keytool -list -v -keystore identity.jks -storepass <keystore_password>
keytool -list -v -keystore trust.jks -storepass <truststore_password>
\`\`\`

### 1.4 Configure WebLogic to use the new keystores

In Admin Console for **each server** (AdminServer, soa_server1, soa_server2):

**Environment > Servers > \`<server_name>\` > Configuration > Keystores**:
- Keystores: Custom Identity and Custom Trust
- Custom Identity Keystore: \`\${DOMAIN_HOME}/config/fmwconfig/keystores/identity.jks\`
- Custom Identity Keystore Type: JKS
- Custom Identity Keystore Passphrase: \`<keystore_password>\`
- Custom Trust Keystore: \`\${DOMAIN_HOME}/config/fmwconfig/keystores/trust.jks\`
- Custom Trust Keystore Type: JKS
- Custom Trust Keystore Passphrase: \`<truststore_password>\`

**Environment > Servers > \`<server_name>\` > Configuration > SSL**:
- Private Key Alias: \`server_cert\`
- Private Key Passphrase: \`<key_password>\`

Restart each server after changing keystore configuration.

### 1.5 Store keystore passwords in the OPSS credential store

Never put keystore passwords in plain text config files. Store them in the domain credential store:

\`\`\`bash
/u01/app/oracle/product/fmw/infra/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<password>','t3://localhost:7001')
createCred(map='keystore', key='identity.password', user='oracle', password='<keystore_password>')
createCred(map='keystore', key='trust.password', user='oracle', password='<truststore_password>')
exit()
EOF
\`\`\`

---

## Phase 2: Enforce TLS 1.2 and Disable Weak Ciphers

### 2.1 Disable SSLv3, TLS 1.0, and TLS 1.1

These protocols contain known vulnerabilities (POODLE for SSLv3, BEAST for TLS 1.0) and are prohibited by PCI DSS and most security frameworks.

Add the following JVM flag to \`setUserOverrides.sh\` for all servers:

\`\`\`bash
# Disable all protocols below TLS 1.2 at the JVM level
USER_MEM_ARGS="\${USER_MEM_ARGS} -Djava.security.properties=\${DOMAIN_HOME}/config/fmwconfig/java.security.override"
export USER_MEM_ARGS
\`\`\`

Create \`\${DOMAIN_HOME}/config/fmwconfig/java.security.override\`:

\`\`\`properties
jdk.tls.disabledAlgorithms=SSLv3, TLSv1, TLSv1.1, RC4, DES, 3DES_EDE_CBC, \
  MD5withRSA, DH keySize < 2048, EC keySize < 224, \
  anon, NULL, include jdk.disabled.namedCurves
jdk.certpath.disabledAlgorithms=MD2, MD5, SHA1 jdkCA & usage TLSServer, \
  RSA keySize < 2048, DSA keySize < 1024, EC keySize < 224
\`\`\`

### 2.2 Configure allowed cipher suites in WebLogic SSL

In Admin Console: **Environment > Servers > \`<server>\` > Configuration > SSL > Advanced**

Set **Ciphersuite** to a comma-separated list of strong ciphers only:

\`\`\`
TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
TLS_DHE_RSA_WITH_AES_256_GCM_SHA384,
TLS_DHE_RSA_WITH_AES_128_GCM_SHA256,
TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA384,
TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256
\`\`\`

Exclude: \`*_RC4_*\`, \`*_DES_*\`, \`*_3DES_*\`, \`*_NULL_*\`, \`*_EXPORT_*\`, \`*_anon_*\`.

### 2.3 Enable Hostname Verification

Hostname verification ensures the certificate CN/SAN matches the server being connected to. Without it, a valid certificate from any server can impersonate any other server in the cluster.

In Admin Console: **Environment > Servers > \`<server>\` > Configuration > SSL > Advanced**:
- Hostname Verification: **BEA Hostname Verifier** (validates against the CN and SAN fields)

Or via config.xml:

\`\`\`xml
<ssl>
  <hostname-verifier>weblogic.security.utils.SSLWLSWildcardHostnameVerifier</hostname-verifier>
  <hostname-verifier-ignored>false</hostname-verifier-ignored>
</ssl>
\`\`\`

### 2.4 Verify SSL configuration

\`\`\`bash
# Test from outside the server
openssl s_client -connect soa-node1.example.com:7002 -tls1_2
# Should connect and show the server certificate

openssl s_client -connect soa-node1.example.com:7002 -tls1
# Should fail with "alert protocol version" or "handshake failure"

# Enumerate offered ciphers
nmap --script ssl-enum-ciphers -p 7002 soa-node1.example.com
# Should show only TLS 1.2+ with A-grade ciphers
\`\`\`

---

## Phase 3: Lock Down Network Exposure

### 3.1 Restrict admin console to management network

By default, the Admin Console is accessible on port 7001 from any IP. Restrict it to the management network at the firewall and optionally at the server listen address level.

On the host firewall (as root):

\`\`\`bash
# Allow admin console only from management VLAN (e.g., 10.10.0.0/24)
firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=10.10.0.0/24 port port=7001 protocol=tcp accept'
firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=10.10.0.0/24 port port=7002 protocol=tcp accept'

# Allow managed server ports from load balancer and OHS only
firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=10.20.0.0/24 port port=8001 protocol=tcp accept'
firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=10.20.0.0/24 port port=8002 protocol=tcp accept'

# Reject all other access to WLS ports
firewall-cmd --permanent --add-rich-rule='rule port port=7001 protocol=tcp reject'
firewall-cmd --permanent --add-rich-rule='rule port port=7002 protocol=tcp reject'
firewall-cmd --reload
\`\`\`

### 3.2 Disable T3 and IIOP from external networks

T3 is WebLogic's proprietary protocol. It supports Java serialization which has been a major remote code execution vector. If T3 is not needed from untrusted networks, block it.

In Admin Console: **Environment > Servers > \`<server>\` > Protocols > General**:
- Uncheck **Enable T3** if T3 access from external networks is not required
- If T3 must remain enabled (e.g., for WLST administration), restrict it by ensuring T3 is only accessible on the admin channel, not the public channel

Alternatively, use a Java deserialization filter to block known gadget chains:

\`\`\`bash
# Add to setUserOverrides.sh
USER_MEM_ARGS="\${USER_MEM_ARGS} -Dweblogic.SerializedSystemIni.SerialFilterProperties=\${DOMAIN_HOME}/config/fmwconfig/serial.filter.properties"
export USER_MEM_ARGS
\`\`\`

Create \`serial.filter.properties\`:

\`\`\`properties
# Allow WebLogic internal classes, block known exploit gadgets
weblogic.serialized.filter.enable=true
weblogic.serialized.filter.blacklist=org.apache.commons.collections.functors.InvokerTransformer;\
org.apache.commons.collections.functors.InstantiateTransformer;\
org.apache.commons.collections4.functors.InvokerTransformer;\
org.codehaus.groovy.runtime.ConvertedClosure;\
org.springframework.beans.factory.ObjectFactory;\
com.sun.org.apache.xalan.internal.xsltc.trax.TemplatesImpl
\`\`\`

### 3.3 Disable the IIOP protocol

IIOP (CORBA/RMI-IIOP) is a legacy protocol rarely needed in modern FMW deployments. Disable it unless explicitly required.

In Admin Console: **Environment > Servers > \`<server>\` > Protocols > IIOP**:
- Uncheck **Enable IIOP**

---

## Phase 4: Disable Remote Debug Ports

A running JVM with a JDWP (Java Debug Wire Protocol) port open gives any connecting client complete control over the JVM — read any variable, call any method, inject code.

### 4.1 Check for active debug ports

\`\`\`bash
# Check if any WLS process has a JDWP agent loaded
ps -ef | grep -E "jdwp|agentlib:jdwp|Xdebug" | grep -v grep

# Check for open debug ports
ss -tlnp | grep -E "5005|8453|9453"
\`\`\`

### 4.2 Remove debug configuration from startup scripts

\`\`\`bash
# Scan all startup scripts for debug flags
grep -rn "jdwp\|Xdebug\|agentlib\|suspend=y\|transport=dt_socket" \\
  \${DOMAIN_HOME}/bin/ \${DOMAIN_HOME}/servers/*/security/

# Remove any lines containing debug flags
# Also check setDomainEnv.sh and setSOADomainEnv.sh
grep -n "JAVA_DEBUG\|DEBUG_PORT\|jdwp" \\
  \${DOMAIN_HOME}/bin/setDomainEnv.sh
\`\`\`

If \`setDomainEnv.sh\` contains a \`debugFlag\` or \`JAVA_DEBUG\` variable that enables debugging, ensure it is set to empty in production:

\`\`\`bash
# In setUserOverrides.sh, explicitly clear any debug flags
JAVA_DEBUG=""
export JAVA_DEBUG
\`\`\`

---

## Phase 5: Harden the Embedded LDAP and Authentication

### 5.1 Change the embedded LDAP administrator password

The embedded LDAP stores WebLogic realm user accounts. Its administrator password defaults to the WebLogic admin password but is a separate credential that is often overlooked.

In Admin Console: **Security Realms > myrealm > Providers > Authentication > DefaultAuthenticator > Configuration**:

Change the server's embedded LDAP admin credential via WLST:

\`\`\`bash
/u01/app/oracle/product/fmw/infra/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<admin_password>','t3://localhost:7001')
edit()
startEdit()
cd('/SecurityConfiguration/soa_domain')
set('CredentialEncrypted','<new_embedded_ldap_password>')
activate()
exit()
EOF
\`\`\`

### 5.2 Configure external LDAP / Active Directory authentication

Replace the embedded LDAP authenticator with an enterprise LDAP provider for centralized identity management:

In Admin Console: **Security Realms > myrealm > Providers > Authentication > New**

Select **ActiveDirectoryAuthenticator** (for AD) or **OracleUnifiedDirectoryAuthenticator** (for OUD/OID).

Configuration parameters:

\`\`\`
Host:           ad.example.com
Port:           389 (or 636 for LDAPS)
Principal:      CN=svc_wls,OU=Service Accounts,DC=example,DC=com
Credential:     <service_account_password>
User Base DN:   OU=Users,DC=example,DC=com
User Name Attr: sAMAccountName
Group Base DN:  OU=Groups,DC=example,DC=com
\`\`\`

Set the LDAP authenticator **Control Flag** to \`SUFFICIENT\` and move it above the default authenticator in the provider list.

Keep the DefaultAuthenticator as a fallback with \`SUFFICIENT\` flag — this ensures the \`weblogic\` admin account remains usable if LDAP is temporarily unavailable.

### 5.3 Remove or disable unused default users

\`\`\`bash
/u01/app/oracle/product/fmw/infra/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<admin_password>','t3://localhost:7001')

# List users in the default security realm
atnprovider = cmo.getSecurityConfiguration().getDefaultRealm().lookupAuthenticationProvider('DefaultAuthenticator')

# Identify and remove unused accounts (example: OracleSystemUser if not needed)
# atnprovider.removeUser('OracleSystemUser')

exit()
EOF
\`\`\`

Do not remove \`weblogic\` — it is required for domain management. Do remove sample or unused accounts.

---

## Phase 6: Secure Node Manager

### 6.1 Require SSL for Node Manager connections

Edit \`\${DOMAIN_HOME}/nodemanager/nodemanager.properties\`:

\`\`\`properties
SecureListener=true
NodeManagerHome=/u01/app/oracle/config/domains/soa_domain/nodemanager
ListenAddress=soa-node1.example.com
ListenPort=5556
# Point to the same identity and trust keystores as the domain
KeyStores=CustomIdentityAndCustomTrust
CustomIdentityKeyStoreFileName=\${DOMAIN_HOME}/config/fmwconfig/keystores/identity.jks
CustomIdentityKeyStorePassPhrase=<keystore_password>
CustomIdentityAlias=server_cert
CustomIdentityPrivateKeyPassPhrase=<key_password>
CustomTrustKeyStoreFileName=\${DOMAIN_HOME}/config/fmwconfig/keystores/trust.jks
CustomTrustKeyStorePassPhrase=<truststore_password>
\`\`\`

### 6.2 Restrict Node Manager to localhost or management network

Node Manager should not be reachable from untrusted networks — only from the AdminServer. Bind it to the node's internal IP and restrict with firewall rules:

\`\`\`bash
# NM should only accept connections from the AdminServer host
firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=10.10.0.5/32 port port=5556 protocol=tcp accept'
firewall-cmd --permanent --add-rich-rule='rule port port=5556 protocol=tcp reject'
firewall-cmd --reload
\`\`\`

---

## Phase 7: Disable Sample Deployments and Unnecessary Applications

FMW ships with sample applications and internal management endpoints that should be removed from production.

### 7.1 Remove sample applications

In Admin Console: **Deployments** — look for and undeploy/delete:
- \`medrec\` (medical records sample)
- \`wl_management_internal2\` (deployment if showing)
- \`wls-wsat\` — **critical**: the WS-AT (Web Services Atomic Transaction) service has known deserialization vulnerabilities; undeploy unless WS-AT is explicitly required

\`\`\`bash
# Verify wls-wsat is not deployed (CVE-2017-10271, CVE-2019-2729)
/u01/app/oracle/product/fmw/infra/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<admin_password>','t3://localhost:7001')
apps = cmo.getAppDeployments()
for app in apps:
    print(app.getName(), '|', app.getDeploymentState())
exit()
EOF

# If wls-wsat is present and not required, undeploy it:
# In Admin Console: Deployments > wls-wsat > Stop > Undeploy
\`\`\`

### 7.2 Disable AutoDeployment

In production mode, AutoDeployment is already disabled. Verify:

\`\`\`bash
grep -i "autodeploy\|auto-deploy" \${DOMAIN_HOME}/config/config.xml
# Should show production-mode-enabled=true; AutoDeployment is automatically disabled in production mode
\`\`\`

---

## Phase 8: Configure Oracle Audit Services

OPSS Audit (Oracle Platform Audit Service) records security-relevant events — authentication attempts, authorization decisions, and administrative changes.

### 8.1 Enable audit in jps-config.xml

Edit \`\${DOMAIN_HOME}/config/fmwconfig/jps-config.xml\`. Find the audit service provider and set:

\`\`\`xml
<serviceProvider type="AUDIT" name="audit.provider"
    class="oracle.security.jps.internal.audit.DefaultAuditProvider">
  <description>Default Audit Provider</description>
  <property name="audit.filterPreset" value="Medium"/>
  <property name="audit.maxDirSize" value="0"/>
  <property name="audit.maxFileSize" value="104857600"/>
</serviceProvider>
\`\`\`

Audit filter presets:
- **Low**: authentication events only
- **Medium**: authentication + authorization decisions (recommended for production)
- **High**: all audit-eligible events (high volume — use only for incident investigation periods)
- **Custom**: hand-pick event categories

### 8.2 Configure audit bus-stop for database persistence

File-based audit logs are not queryable and can be lost on disk failure. Route audit events to the IAU database schema for persistent, queryable storage:

In Admin Console: **Domain > Security > Audit**:
- Audit Repository Type: DB
- Data Source JNDI: \`jdbc/AuditAppendDataSource\` (points to FMW_IAU_APPEND schema)

### 8.3 Set log file permissions

\`\`\`bash
# Restrict access to server log files — should not be world-readable
find \${DOMAIN_HOME}/servers/*/logs -name "*.log" -exec chmod 640 {} \\;
find \${DOMAIN_HOME}/servers/*/logs -type d -exec chmod 750 {} \\;

# Audit files in oracle_common
find /u01/app/oracle/product/fmw/infra/oracle_common/modules -name "*.log" -exec chmod 640 {} \\;
\`\`\`

---

## Phase 9: Rotate RCU Schema Passwords

RCU schema passwords set during installation are often weak or reused across environments. Rotate them using the following procedure.

### 9.1 Change schema password in the Oracle database

\`\`\`sql
-- For each schema (run as SYSDBA or a DBA account)
ALTER USER FMW_SOAINFRA IDENTIFIED BY "<new_strong_password>";
ALTER USER FMW_MDS IDENTIFIED BY "<new_strong_password>";
ALTER USER FMW_OPSS IDENTIFIED BY "<new_strong_password>";
ALTER USER FMW_IAU IDENTIFIED BY "<new_strong_password>";
ALTER USER FMW_IAU_APPEND IDENTIFIED BY "<new_strong_password>";
ALTER USER FMW_IAU_VIEWER IDENTIFIED BY "<new_strong_password>";
ALTER USER FMW_STB IDENTIFIED BY "<new_strong_password>";
\`\`\`

### 9.2 Update datasource passwords in WebLogic

For each datasource in Admin Console: **Services > Data Sources > \`<datasource>\` > Configuration > Connection Pool**:
- Update the Password field with the new DB schema password
- Click **Test** to verify connectivity
- **Activate Changes**

### 9.3 Update OPSS schema password via credential store

The OPSS schema password is also stored in the domain credential store. Update it:

\`\`\`bash
/u01/app/oracle/product/fmw/infra/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<admin_password>','t3://localhost:7001')
modifyBootStrapCredential(jpsConfigFile='\${DOMAIN_HOME}/config/fmwconfig/jps-config.xml',
    username='FMW_OPSS',
    password='<new_opss_password>')
exit()
EOF
\`\`\`

Restart all servers after changing the OPSS schema password.

---

## Phase 10: WebLogic Admin Console Hardening

### 10.1 Enforce HTTPS-only for the admin console

In Admin Console: **Domain > Configuration > General**:
- Check **Administration Port Enabled**
- Set **Administration Port**: 9002 (dedicated HTTPS-only admin port)

With the Administration Port enabled, all admin traffic (Admin Console, WLST, deployment) moves to port 9002 over SSL. The standard port 7001 can then serve application traffic only.

### 10.2 Set admin console session timeout

In Admin Console: **Domain > Configuration > Web Applications**:
- Console Session Timeout: \`1800\` seconds (30 minutes — reduce for high-security environments)

### 10.3 Enable console login auditing

Ensure admin console login attempts (success and failure) are captured. With OPSS audit at Medium or High level, login events are automatically recorded. Verify by checking the audit trail after a test login:

\`\`\`sql
-- Query audit records for admin console logins
SELECT event_time, user_name, event_type, success, client_ip
FROM FMW_IAU.IAU_COMMON
WHERE event_type = 'AUTHENTICATION'
ORDER BY event_time DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

---

## Phase 11: Production Mode and Security Checks

### 11.1 Verify production mode is enabled

Production mode disables auto-deployment, enables security restrictions, and enforces stricter startup checks.

\`\`\`bash
grep "production-mode-enabled" \${DOMAIN_HOME}/config/config.xml
# Expected: <production-mode-enabled>true</production-mode-enabled>
\`\`\`

If not set, enable via WLST:

\`\`\`bash
/u01/app/oracle/product/fmw/infra/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<admin_password>','t3://localhost:7001')
edit()
startEdit()
cd('/SecurityConfiguration/soa_domain')
set('ProductionModeEnabled', 'true')
activate()
exit()
EOF
\`\`\`

### 11.2 Verify SSL is active on all servers

\`\`\`bash
/u01/app/oracle/product/fmw/infra/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<admin_password>','t3s://localhost:7002')
servers = cmo.getServers()
for s in servers:
    ssl = s.getSSL()
    print(s.getName(),
          '| SSL enabled:', ssl.isEnabled(),
          '| Listen port:', ssl.getListenPort(),
          '| Min protocol:', ssl.getMinimumTLSProtocolVersion() if hasattr(ssl,'getMinimumTLSProtocolVersion') else 'check manually')
exit()
EOF
\`\`\`

### 11.3 Security posture summary check

\`\`\`bash
echo "=== FMW Security Posture Check ==="
echo "--- Demo certs check ---"
keytool -list -v -keystore \${DOMAIN_HOME}/config/fmwconfig/keystores/identity.jks \\
  -storepass <keystore_password> 2>/dev/null | grep -E "Owner:|Issuer:|Valid"

echo "--- Debug port check ---"
ps -ef | grep -E "jdwp|agentlib:jdwp" | grep -v grep && echo "WARNING: Debug port open" || echo "OK: No debug ports"

echo "--- wls-wsat deployment check ---"
/u01/app/oracle/product/fmw/infra/oracle_common/common/bin/wlst.sh << 'EOF' 2>/dev/null
connect('weblogic','<admin_password>','t3://localhost:7001')
apps = [a.getName() for a in cmo.getAppDeployments()]
if 'wls-wsat' in apps: print('WARNING: wls-wsat is deployed')
else: print('OK: wls-wsat not deployed')
exit()
EOF

echo "--- T3 protocol check ---"
nc -zv localhost 7001 2>&1 | grep -q "succeeded" && echo "T3 port 7001 is open - verify firewall restricts access" || echo "OK: port 7001 not reachable"
\`\`\`

---

## Security Hardening Checklist

**SSL and TLS:**
- [ ] Demo keystores replaced with CA-signed certificates on all servers
- [ ] SSLv3, TLS 1.0, TLS 1.1 disabled via java.security.override
- [ ] Only approved cipher suites configured (AES-GCM, no RC4/DES/3DES/NULL/EXPORT)
- [ ] Hostname verification enabled on all servers
- [ ] SSL listener port active on AdminServer (7002) and managed servers (8002)
- [ ] Verified with \`openssl s_client\` that TLS 1.0 is rejected

**Network:**
- [ ] Admin console ports (7001, 7002) firewalled to management network only
- [ ] Node Manager port (5556) firewalled to AdminServer host only
- [ ] Managed server ports (8001, 8002) firewalled to OHS/load balancer only
- [ ] IIOP protocol disabled on all servers
- [ ] T3 access restricted to management network or disabled externally

**Authentication:**
- [ ] Embedded LDAP admin password changed from default
- [ ] External LDAP/AD authentication provider configured
- [ ] Unused default users removed from the realm
- [ ] Admin console session timeout set to 1800 seconds or less

**Deployments:**
- [ ] wls-wsat undeployed (critical — CVE-2017-10271, CVE-2019-2729)
- [ ] Sample applications (medrec, etc.) removed
- [ ] AutoDeployment disabled (enforced by production mode)
- [ ] Production mode enabled

**Security configuration:**
- [ ] Remote JDWP debug ports absent from all server startup configurations
- [ ] Node Manager configured with SSL and bound to management interface only
- [ ] Java deserialization filter configured for T3 protocol
- [ ] Administration Port (9002) enabled for dedicated HTTPS-only admin access

**Credentials and audit:**
- [ ] RCU schema passwords rotated from installation defaults
- [ ] Keystore passwords stored in OPSS credential store, not plain text
- [ ] OPSS audit enabled at Medium level minimum
- [ ] Audit events routing to IAU database schema
- [ ] Server log files restricted to oracle user and group (640/750)
- [ ] Audit trail query confirmed returning authentication events`,
};

async function main() {
  console.log('Inserting FMW security hardening runbook...');
  await db.insert(posts).values(post).onConflictDoNothing();
  console.log(`Inserted: "${post.title}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
