import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'OBIEE 12c TLS 1.2 Implementation Runbook: Step-by-Step Commands for OHS, WebLogic, BI Server, and TCPS',
  slug: 'oracle-obiee-tls-1-2-runbook',
  excerpt:
    'Step-by-step runbook for enforcing TLS 1.2 across the OBIEE 12c stack: Oracle Wallet creation for OHS, WebLogic JKS keystore setup via keytool and WLST, setDomainEnv.sh JVM flag, BI Server TCPS sqlnet.ora, LDAPS authentication realm configuration, RPD connection pool update, per-layer verification commands, and a cron-scheduled certificate expiry health script.',
  category: 'fusion-middleware' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-07'),
  youtubeUrl: null,
  content: `## Overview

This runbook implements TLS 1.2 across the OBIEE 12c topology in eight phases, following the inside-out rollout sequence: data source connections first, then WebLogic SSL, then OHS. Each phase includes verification steps. Do not proceed to the next phase until the verification passes.

**Environment assumptions:**
- OBIEE 12c installed under \`/u01/oracle/middleware\`
- WebLogic domain at \`/u01/oracle/config/domains/bi_domain\`
- OHS instance name: \`ohs1\`
- WebLogic Managed Server: \`bi_server1\` on port 9500 (HTTP) / 9502 (SSL)
- Oracle Database for BI data sources: \`db-server.company.com:1521\`
- OID LDAP for authentication: \`oid-server.company.com:389\` / LDAPS :636
- All certificate files staged at \`/u01/certs/\`

---

## Pre-flight: Audit Current TLS State

Before making any changes, document the current state.

\`\`\`bash
# Check what TLS versions OHS currently accepts
openssl s_client -connect obiee.company.com:443 -tls1   2>&1 | grep -E "Protocol|Alert|CONNECTED"
openssl s_client -connect obiee.company.com:443 -tls1_1 2>&1 | grep -E "Protocol|Alert|CONNECTED"
openssl s_client -connect obiee.company.com:443 -tls1_2 2>&1 | grep -E "Protocol|Alert|CONNECTED"

# Check OHS ssl.conf current SSLProtocol line
grep -i SSLProtocol /u01/oracle/config/domains/bi_domain/config/fmwconfig/components/OHS/ohs1/ssl.conf

# Check if WebLogic SSL is already enabled on bi_server1
grep -i "SSLEnabled\|ListenPort\|SSLListenPort" /u01/oracle/config/domains/bi_domain/config/config.xml | grep -A2 -B2 bi_server1

# Check current JAVA_OPTIONS in setDomainEnv.sh
grep -i "disabledAlgorithms\|EXTRA_JAVA" /u01/oracle/config/domains/bi_domain/bin/setDomainEnv.sh

# Check BI Server sqlnet.ora for existing SSL config
cat /u01/oracle/middleware/Oracle_Home/network/admin/sqlnet.ora 2>/dev/null || echo "No sqlnet.ora found"

# Check WebLogic LDAP authentication provider port
grep -r "LDAPPort\|636\|SSLEnabled" /u01/oracle/config/domains/bi_domain/config/fmwconfig/jps-config.xml 2>/dev/null | head -10
\`\`\`

---

## Phase 1: Prepare Certificate Files

All certificates and keys should be gathered and validated before any configuration changes.

\`\`\`bash
# Verify each certificate file
openssl x509 -in /u01/certs/ohs-server.pem -noout -subject -issuer -dates
openssl x509 -in /u01/certs/wls-server.pem -noout -subject -issuer -dates
openssl x509 -in /u01/certs/company-root-ca.pem -noout -subject -issuer -dates
openssl x509 -in /u01/certs/company-issuing-ca.pem -noout -subject -issuer -dates
openssl x509 -in /u01/certs/db-ca.pem -noout -subject -issuer -dates
openssl x509 -in /u01/certs/oid-ca.pem -noout -subject -issuer -dates

# Verify OHS private key matches its certificate
openssl x509 -noout -modulus -in /u01/certs/ohs-server.pem | md5sum
openssl rsa  -noout -modulus -in /u01/certs/ohs-server.key | md5sum
# Both md5 hashes must match

# Verify WebLogic server key matches its certificate
openssl x509 -noout -modulus -in /u01/certs/wls-server.pem | md5sum
openssl rsa  -noout -modulus -in /u01/certs/wls-server.key | md5sum
\`\`\`

---

## Phase 2: BI Server TCPS — Oracle Database Connection

### 2.1 Configure the Oracle Database for TCPS

On the **Oracle Database server**, update the listener to accept TCPS connections.

\`\`\`bash
# On the DB server — update listener.ora to add TCPS endpoint
# Add alongside the existing TCP listener:
cat >> \$ORACLE_HOME/network/admin/listener.ora << 'EOF'
LISTENER_TCPS =
  (DESCRIPTION_LIST =
    (DESCRIPTION =
      (ADDRESS = (PROTOCOL = TCPS)(HOST = db-server.company.com)(PORT = 1522))))

SSL_CLIENT_AUTHENTICATION = FALSE
WALLET_LOCATION =
  (SOURCE =
    (METHOD = FILE)
    (METHOD_DATA =
      (DIRECTORY = /u01/oracle/db_wallet)))
EOF

# Create the DB server wallet
mkdir -p /u01/oracle/db_wallet
orapki wallet create -wallet /u01/oracle/db_wallet -auto_login

# Import the DB server certificate
orapki wallet add -wallet /u01/oracle/db_wallet \
    -user_cert /u01/certs/db-server.pem -trusted_cert

# Import the CA that signed the DB cert
orapki wallet add -wallet /u01/oracle/db_wallet \
    -cert /u01/certs/company-issuing-ca.pem -trusted_cert
orapki wallet add -wallet /u01/oracle/db_wallet \
    -cert /u01/certs/company-root-ca.pem -trusted_cert

orapki wallet display -wallet /u01/oracle/db_wallet

# Reload the listener to pick up TCPS
lsnrctl reload
lsnrctl status | grep -i "TCPS\|1522"

# Update sqlnet.ora on DB server for TLS 1.2
cat >> \$ORACLE_HOME/network/admin/sqlnet.ora << 'EOF'
SSL_VERSION = 1.2
WALLET_LOCATION =
  (SOURCE =
    (METHOD = FILE)
    (METHOD_DATA =
      (DIRECTORY = /u01/oracle/db_wallet)))
EOF
\`\`\`

### 2.2 Configure the BI Server Host for TCPS

On the **OBIEE server**, set up the Oracle Net configuration and wallet for TCPS connections to the database.

\`\`\`bash
# Create the BI Server TCPS wallet directory
mkdir -p /u01/oracle/bi_wallet

# Create auto-login wallet
orapki wallet create -wallet /u01/oracle/bi_wallet -auto_login

# Import the database server's CA certificate
orapki wallet add -wallet /u01/oracle/bi_wallet \
    -cert /u01/certs/db-ca.pem -trusted_cert
orapki wallet add -wallet /u01/oracle/bi_wallet \
    -cert /u01/certs/company-root-ca.pem -trusted_cert

# Verify wallet
orapki wallet display -wallet /u01/oracle/bi_wallet

# Write sqlnet.ora for the BI Server Oracle Home
cat > /u01/oracle/middleware/Oracle_Home/network/admin/sqlnet.ora << 'EOF'
SQLNET.AUTHENTICATION_SERVICES = (NONE)
SSL_CLIENT_AUTHENTICATION = FALSE
WALLET_LOCATION =
  (SOURCE =
    (METHOD = FILE)
    (METHOD_DATA =
      (DIRECTORY = /u01/oracle/bi_wallet)))
SSL_VERSION = 1.2
EOF

# Add TCPS TNS alias
cat >> /u01/oracle/middleware/Oracle_Home/network/admin/tnsnames.ora << 'EOF'
BIDB_TCPS =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCPS)(HOST = db-server.company.com)(PORT = 1522))
    (CONNECT_DATA =
      (SERVICE_NAME = bidb.company.com)))
EOF
\`\`\`

### 2.3 Verify TCPS Connectivity

\`\`\`bash
# Test TCPS connection from the OBIEE host
sqlplus biuser/password@BIDB_TCPS

# If sqlplus not in PATH, use the full path
/u01/oracle/middleware/Oracle_Home/bin/sqlplus biuser/password@BIDB_TCPS

# Expected: SQL> prompt. Run a quick query:
# SQL> select sysdate from dual;
# SQL> exit
\`\`\`

### 2.4 Update RPD Connection Pool

Log in to Oracle BI Administration Tool (offline mode). For each Oracle data source connection pool that previously used TCP:
- Set **Data Source Name** to \`BIDB_TCPS\`
- Set **Call Interface** to \`OCI 10g/11g\`
- Save and upload the RPD to the BI Server via Enterprise Manager (BI Domain → Capacity Management → Repository → Upload).

Restart the BI Server after RPD upload:
\`\`\`bash
# Via OPMN (OBIEE 12c uses start/stop scripts)
/u01/oracle/middleware/Oracle_Home/user_projects/domains/bi_domain/bitools/bin/stop.sh
/u01/oracle/middleware/Oracle_Home/user_projects/domains/bi_domain/bitools/bin/start.sh

# Or stop/start only BI Server component via Enterprise Manager
# Navigate to: Business Intelligence → bi_server1 → Availability → Stop/Start
\`\`\`

---

## Phase 3: LDAPS — WebLogic LDAP Authentication Provider

### 3.1 Import the LDAP CA into the WebLogic Trust JKS

\`\`\`bash
# Create the WebLogic trust JKS (or add to existing)
keytool -importcert \
    -keystore /u01/oracle/keystores/obiee-trust.jks \
    -storepass TrustStore1 \
    -alias company-root-ca \
    -file /u01/certs/company-root-ca.pem \
    -noprompt

keytool -importcert \
    -keystore /u01/oracle/keystores/obiee-trust.jks \
    -storepass TrustStore1 \
    -alias company-issuing-ca \
    -file /u01/certs/company-issuing-ca.pem \
    -noprompt

# Import the OID/AD CA specifically
keytool -importcert \
    -keystore /u01/oracle/keystores/obiee-trust.jks \
    -storepass TrustStore1 \
    -alias oid-ca \
    -file /u01/certs/oid-ca.pem \
    -noprompt

# Verify trust JKS contents
keytool -list -keystore /u01/oracle/keystores/obiee-trust.jks -storepass TrustStore1
\`\`\`

### 3.2 Verify LDAPS Connectivity from the OBIEE Host

\`\`\`bash
# Test LDAPS before changing WebLogic configuration
ldapsearch -H ldaps://oid-server.company.com:636 \
    -D "cn=orcladmin" -w OrcladminPassword \
    -b "dc=company,dc=com" \
    -s sub "(uid=testuser)" uid cn

# Expected: at least one entry returned without SSL errors
\`\`\`

### 3.3 Update WebLogic LDAP Provider to LDAPS via WLST

\`\`\`bash
# Source domain environment
. /u01/oracle/config/domains/bi_domain/bin/setDomainEnv.sh

# Run WLST
java weblogic.WLST << 'WLST'
connect('weblogic', 'WlsPassword1', 't3://admin-server.company.com:7001')

cd('/SecurityConfiguration/bi_domain/DefaultRealm/myrealm/AuthenticationProviders/OID_Authenticator')

# Change port from 389 to 636
cmo.setPort(636)

# Enable SSL
cmo.setSSLEnabled(True)

save()
activate()

# Verify
print("LDAP Port:", cmo.getPort())
print("LDAP SSL:", cmo.getSSLEnabled())

disconnect()
exit()
WLST
\`\`\`

**Note**: The exact MBean path (\`OID_Authenticator\`) depends on the name given when the authentication provider was created. Find the correct name in the WebLogic Admin Console under Security Realms → myrealm → Providers → Authentication.

### 3.4 Restart bi_server1 and Verify LDAPS

\`\`\`bash
# Restart bi_server1 (Node Manager must be running)
java weblogic.WLST << 'WLST'
nmConnect('nmUser', 'nmPassword', 'admin-server.company.com', '5556', 'bi_domain',
          '/u01/oracle/config/domains/bi_domain')
nmServerStatus('bi_server1')
nmKill('bi_server1')
nmStart('bi_server1')
nmDisconnect()
exit()
WLST

# Verify LDAPS is working — check bi_server1 log for LDAP connection errors
grep -i "ldap\|ssl\|authentication" /u01/oracle/config/domains/bi_domain/servers/bi_server1/logs/bi_server1.log | tail -20

# Test OBIEE login with an OID-managed user account
curl -s -o /dev/null -w "%{http_code}" \
    "https://obiee.company.com/analytics/saw.dll?bieehome"
# Expected: 200
\`\`\`

---

## Phase 4: WebLogic SSL Listener — Identity and Trust JKS

### 4.1 Build the WebLogic Identity JKS

\`\`\`bash
mkdir -p /u01/oracle/keystores

# Convert PEM cert + key to PKCS12
openssl pkcs12 -export \
    -in /u01/certs/wls-server.pem \
    -inkey /u01/certs/wls-server.key \
    -certfile /u01/certs/company-issuing-ca.pem \
    -out /tmp/wls-server.p12 \
    -name obiee-server \
    -passout pass:KeyPass1

# Import PKCS12 into JKS identity keystore
keytool -importkeystore \
    -srckeystore /tmp/wls-server.p12 \
    -srcstoretype PKCS12 \
    -srcstorepass KeyPass1 \
    -srcalias obiee-server \
    -destkeystore /u01/oracle/keystores/obiee-identity.jks \
    -deststoretype JKS \
    -deststorepass Identity1 \
    -destalias obiee-server \
    -destkeypass Identity1 \
    -noprompt

# Verify identity JKS
keytool -list -v -keystore /u01/oracle/keystores/obiee-identity.jks \
    -storepass Identity1 | grep -E "Alias|Valid|Owner|Issuer"

# Clean up PKCS12 temp file
rm /tmp/wls-server.p12
\`\`\`

### 4.2 Configure WebLogic SSL Listener via WLST

\`\`\`bash
. /u01/oracle/config/domains/bi_domain/bin/setDomainEnv.sh

java weblogic.WLST << 'WLST'
connect('weblogic', 'WlsPassword1', 't3://admin-server.company.com:7001')

# Enable SSL listener on bi_server1
cd('/Servers/bi_server1/SSL/bi_server1')
cmo.setEnabled(True)
cmo.setListenPort(9502)
cmo.setTwoWaySSLEnabled(False)
cmo.setHostnameVerificationIgnored(False)
cmo.setMinimumTLSProtocolVersion('TLSv1.2')

# Set custom identity and trust keystores
cd('/Servers/bi_server1')
cmo.setKeyStores('CustomIdentityAndCustomTrust')
cmo.setCustomIdentityKeyStoreFileName('/u01/oracle/keystores/obiee-identity.jks')
cmo.setCustomIdentityKeyStoreType('JKS')
set('CustomIdentityKeyStorePassPhraseEncrypted', encrypt('Identity1'))
cmo.setCustomTrustKeyStoreFileName('/u01/oracle/keystores/obiee-trust.jks')
cmo.setCustomTrustKeyStoreType('JKS')
set('CustomTrustKeyStorePassPhraseEncrypted', encrypt('TrustStore1'))

# Set private key alias and passphrase
cd('/Servers/bi_server1/SSL/bi_server1')
cmo.setPrivateKeyAlias('obiee-server')
set('PrivateKeyPassPhraseEncrypted', encrypt('Identity1'))

# Enable SSL on Admin Server as well
cd('/Servers/AdminServer/SSL/AdminServer')
cmo.setEnabled(True)
cmo.setListenPort(7002)
cmo.setMinimumTLSProtocolVersion('TLSv1.2')

cd('/Servers/AdminServer')
cmo.setKeyStores('CustomIdentityAndCustomTrust')
cmo.setCustomIdentityKeyStoreFileName('/u01/oracle/keystores/obiee-identity.jks')
cmo.setCustomIdentityKeyStoreType('JKS')
set('CustomIdentityKeyStorePassPhraseEncrypted', encrypt('Identity1'))
cmo.setCustomTrustKeyStoreFileName('/u01/oracle/keystores/obiee-trust.jks')
cmo.setCustomTrustKeyStoreType('JKS')
set('CustomTrustKeyStorePassPhraseEncrypted', encrypt('TrustStore1'))

save()
activate()
print("SSL configuration saved and activated")
disconnect()
exit()
WLST
\`\`\`

### 4.3 Verify WebLogic SSL Listener

\`\`\`bash
# Restart bi_server1 to pick up SSL configuration
java weblogic.WLST << 'WLST'
nmConnect('nmUser', 'nmPassword', 'admin-server.company.com', '5556', 'bi_domain',
          '/u01/oracle/config/domains/bi_domain')
nmKill('bi_server1')
nmStart('bi_server1')
nmDisconnect()
exit()
WLST

# Wait for bi_server1 to reach RUNNING state — check log
tail -f /u01/oracle/config/domains/bi_domain/servers/bi_server1/logs/bi_server1.log &
LOG_PID=\$!
sleep 60
kill \$LOG_PID

# Test SSL directly on WebLogic port (bypass OHS)
openssl s_client -connect bi_server1.company.com:9502 -tls1_2 </dev/null 2>&1 | \
    grep -E "Protocol|Cipher|subject|issuer|notAfter|CONNECTED|HANDSHAKE"

# Verify TLS 1.1 is rejected
openssl s_client -connect bi_server1.company.com:9502 -tls1_1 </dev/null 2>&1 | \
    grep -E "alert|handshake failure|CONNECTED"
# Expected: alert handshake failure — no CONNECTED

# Check the negotiated cipher suite
openssl s_client -connect bi_server1.company.com:9502 </dev/null 2>&1 | \
    grep "Cipher is"
\`\`\`

---

## Phase 5: JVM TLS 1.2 Enforcement — setDomainEnv.sh

### 5.1 Update setDomainEnv.sh

\`\`\`bash
# Backup first
cp /u01/oracle/config/domains/bi_domain/bin/setDomainEnv.sh \
   /u01/oracle/config/domains/bi_domain/bin/setDomainEnv.sh.bak_\$(date +%Y%m%d)

# Add the JVM disabled algorithms flag
# Insert before the final export JAVA_OPTIONS line
sed -i.pre_tls '/^export EXTRA_JAVA_PROPERTIES/i\
EXTRA_JAVA_PROPERTIES="\${EXTRA_JAVA_PROPERTIES} -Djdk.tls.disabledAlgorithms=SSLv3,TLSv1,TLSv1.1,RC4,DES,MD5withRSA,DH+keySize<2048,EC+keySize<224,3DES_EDE_CBC,anon,NULL"' \
    /u01/oracle/config/domains/bi_domain/bin/setDomainEnv.sh

# Verify the change was inserted correctly
grep -n "disabledAlgorithms\|EXTRA_JAVA_PROPERTIES" \
    /u01/oracle/config/domains/bi_domain/bin/setDomainEnv.sh
\`\`\`

If the automated sed insert is unreliable, edit manually. Open \`setDomainEnv.sh\` in vi and locate the \`EXTRA_JAVA_PROPERTIES\` export block. Add the line immediately before the export:

\`\`\`bash
EXTRA_JAVA_PROPERTIES="\${EXTRA_JAVA_PROPERTIES} -Djdk.tls.disabledAlgorithms=SSLv3,TLSv1,TLSv1.1,RC4,DES,MD5withRSA,DH+keySize<2048,EC+keySize<224,3DES_EDE_CBC,anon,NULL"
\`\`\`

### 5.2 Restart Admin Server and bi_server1

\`\`\`bash
# Stop bi_server1 first, then Admin Server
java weblogic.WLST << 'WLST'
nmConnect('nmUser', 'nmPassword', 'admin-server.company.com', '5556', 'bi_domain',
          '/u01/oracle/config/domains/bi_domain')
nmKill('bi_server1')
nmDisconnect()
exit()
WLST

# Stop Admin Server
/u01/oracle/config/domains/bi_domain/bin/stopWebLogic.sh

# Start Admin Server (sources the updated setDomainEnv.sh)
nohup /u01/oracle/config/domains/bi_domain/bin/startWebLogic.sh > \
    /u01/oracle/config/domains/bi_domain/servers/AdminServer/logs/AdminServer.out 2>&1 &

# Wait for Admin Server to be ready
sleep 60
curl -s -o /dev/null -w "%{http_code}" http://admin-server.company.com:7001/console/
# Expected: 302 (redirect to login)

# Start bi_server1 via Node Manager
java weblogic.WLST << 'WLST'
nmConnect('nmUser', 'nmPassword', 'admin-server.company.com', '5556', 'bi_domain',
          '/u01/oracle/config/domains/bi_domain')
nmStart('bi_server1')
nmDisconnect()
exit()
WLST

# Verify the JVM flag is active in the running process
ps aux | grep bi_server1 | grep -o "disabledAlgorithms[^ ]*"
\`\`\`

### 5.3 Verify JVM TLS Enforcement

\`\`\`bash
# After bi_server1 restart, re-verify TLS 1.1 is rejected at WebLogic port
openssl s_client -connect bi_server1.company.com:9502 -tls1_1 </dev/null 2>&1 | \
    grep -E "alert|handshake failure|CONNECTED"
# Expected: handshake failure — TLS 1.1 disabled by JVM flag

# Verify TLS 1.2 still works
openssl s_client -connect bi_server1.company.com:9502 -tls1_2 </dev/null 2>&1 | \
    grep -E "Protocol|Cipher|CONNECTED"
# Expected: CONNECTED, TLSv1.2
\`\`\`

---

## Phase 6: OHS Oracle Wallet — TLS 1.2 on the Web Listener

### 6.1 Create the OHS Oracle Wallet

\`\`\`bash
WALLET_DIR=/u01/oracle/config/domains/bi_domain/config/fmwconfig/components/OHS/ohs1/keystores/default

mkdir -p \$WALLET_DIR

# Create auto-login wallet
orapki wallet create -wallet \$WALLET_DIR -auto_login -pwd WalletPass1

# Import root CA
orapki wallet add -wallet \$WALLET_DIR \
    -cert /u01/certs/company-root-ca.pem -trusted_cert -pwd WalletPass1

# Import issuing CA
orapki wallet add -wallet \$WALLET_DIR \
    -cert /u01/certs/company-issuing-ca.pem -trusted_cert -pwd WalletPass1

# Import OHS server certificate (must be signed by the imported CA)
orapki wallet add -wallet \$WALLET_DIR \
    -user_cert /u01/certs/ohs-server.pem -pwd WalletPass1

# Import the WebLogic CA cert (so OHS can verify bi_server1 certificate)
orapki wallet add -wallet \$WALLET_DIR \
    -cert /u01/certs/wls-ca.pem -trusted_cert -pwd WalletPass1

# Display and verify wallet contents
orapki wallet display -wallet \$WALLET_DIR

# Expected output should include:
# User Certificates: (the OHS server cert)
# Trusted Certificates: (company-root-ca, company-issuing-ca, wls-ca)
\`\`\`

### 6.2 Update ssl.conf for TLS 1.2

\`\`\`bash
SSL_CONF=/u01/oracle/config/domains/bi_domain/config/fmwconfig/components/OHS/ohs1/ssl.conf

# Backup
cp \$SSL_CONF \${SSL_CONF}.bak_\$(date +%Y%m%d)

# Verify current SSLProtocol setting
grep -n "SSLProtocol\|SSLCipherSuite\|WebLogicPort\|WebLogicSSLPort" \$SSL_CONF
\`\`\`

Edit \`ssl.conf\` to enforce TLS 1.2. The critical lines inside the \`<VirtualHost *:443>\` block:

\`\`\`bash
# Add or replace SSLProtocol — must include -ALL to disable all then re-enable TLS 1.2
vi \$SSL_CONF
\`\`\`

Ensure these directives are present inside the \`<VirtualHost *:443>\` block:

\`\`\`
SSLEngine on
SSLWallet "\${ORACLE_INSTANCE}/config/fmwconfig/components/OHS/ohs1/keystores/default"
SSLProtocol -ALL +TLSv1.2
SSLCipherSuite TLSv1.2 ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384
\`\`\`

And in each \`<Location>\` block that proxies to WebLogic, replace \`WebLogicPort 9500\` with:

\`\`\`
WebLogicSSLPort 9502
WLSSLWallet "\${ORACLE_INSTANCE}/config/fmwconfig/components/OHS/ohs1/keystores/default"
\`\`\`

### 6.3 Restart OHS and Verify

\`\`\`bash
# Restart OHS using OPMN control script
/u01/oracle/config/domains/bi_domain/system_components/OHS/ohs1/bin/restart.sh

# Or via the domain-level script
/u01/oracle/config/domains/bi_domain/bin/restartComponent.sh ohs1

# Check OHS error log for SSL startup errors
grep -i "ssl\|error\|warn" \
    /u01/oracle/config/domains/bi_domain/system_components/OHS/ohs1/logs/error_log | tail -30

# Verify TLS 1.2 on browser-facing port
openssl s_client -connect obiee.company.com:443 -tls1_2 </dev/null 2>&1 | \
    grep -E "Protocol|Cipher|subject|CONNECTED"

# Verify TLS 1.1 is rejected
openssl s_client -connect obiee.company.com:443 -tls1_1 </dev/null 2>&1 | \
    grep -E "alert|failure|CONNECTED"
# Expected: alert handshake failure

# Verify TLS 1.0 is rejected
openssl s_client -connect obiee.company.com:443 -tls1 </dev/null 2>&1 | \
    grep -E "alert|failure|CONNECTED"
# Expected: alert handshake failure

# Verify OHS → WebLogic HTTPS proxy is working
curl -s -o /dev/null -w "%{http_code}\n" https://obiee.company.com/analytics/saw.dll?bieehome
# Expected: 200 or 302 (redirect to login)
\`\`\`

### 6.4 AutoConfig Template Update (EBS-Integrated Deployments Only)

If this OBIEE deployment is integrated with Oracle E-Business Suite and OHS is managed by AutoConfig:

\`\`\`bash
# Locate the OHS ssl.conf AutoConfig template
find \$AD_TOP -name "ssl.conf*" -path "*/driver/*" 2>/dev/null | head -5

# Edit the template to include the TLS 1.2 directives
vi \$AD_TOP/admin/driver/ohs_ssl.conf.template

# Add to the <VirtualHost> section in the template:
# SSLProtocol -ALL +TLSv1.2
# SSLCipherSuite TLSv1.2 ECDHE-RSA-AES256-GCM-SHA384:...

# Run AutoConfig to regenerate and verify TLS 1.2 survives
perl \$AD_TOP/bin/adautocfg.pl appspass=AppsPassword

# Re-verify after AutoConfig
grep SSLProtocol \$SSL_CONF
\`\`\`

---

## Phase 7: Disable Plain HTTP on WebLogic (Optional Hardening)

After confirming the OHS → WebLogic HTTPS proxy is working correctly, optionally disable the plain HTTP listener on bi_server1 to prevent TLS bypass.

\`\`\`bash
. /u01/oracle/config/domains/bi_domain/bin/setDomainEnv.sh

java weblogic.WLST << 'WLST'
connect('weblogic', 'WlsPassword1', 't3s://admin-server.company.com:7002')

# Disable HTTP listener on bi_server1
cd('/Servers/bi_server1')
cmo.setListenPortEnabled(False)

save()
activate()
print("HTTP listener disabled on bi_server1")
disconnect()
exit()
WLST

# Restart bi_server1 for change to take effect
java weblogic.WLST << 'WLST'
nmConnect('nmUser', 'nmPassword', 'admin-server.company.com', '5556', 'bi_domain',
          '/u01/oracle/config/domains/bi_domain')
nmKill('bi_server1')
nmStart('bi_server1')
nmDisconnect()
exit()
WLST

# Verify HTTP port is no longer listening
nc -zv bi_server1.company.com 9500
# Expected: connection refused

# Verify HTTPS port is still listening
nc -zv bi_server1.company.com 9502
# Expected: connection succeeded
\`\`\`

**Important**: Before disabling HTTP, ensure:
- No monitoring tools poll bi_server1 port 9500 directly
- No internal scripts use the non-SSL URL
- Enterprise Manager agents and Node Manager use the SSL channel

---

## Phase 8: OAM WebGate (If SSO Is Configured)

Skip this phase if OBIEE does not use OAM for SSO.

\`\`\`bash
WEBGATE_DIR=/u01/oracle/config/domains/bi_domain/config/fmwconfig/components/OHS/ohs1/webgate/config

# Import OAM CA certificate into the WebGate wallet
orapki wallet add -wallet \${WEBGATE_DIR}/wallet \
    -cert /u01/certs/oam-ca.pem -trusted_cert -pwd WalletPass1

orapki wallet display -wallet \${WEBGATE_DIR}/wallet

# Update WebGate configuration for SSL OAP channel
# In WebGate config file (ObAccessClient.xml or webgate.conf):
vi \${WEBGATE_DIR}/ObAccessClient.xml
# Set: <SimpleMode>Simple</SimpleMode>  (SSL OAP)
# Or:  <CertMode>Cert</CertMode>       (mutual TLS OAP, requires WebGate cert)

# Restart OHS to apply WebGate config change
/u01/oracle/config/domains/bi_domain/bin/restartComponent.sh ohs1

# Test SSO end-to-end: navigate to OBIEE URL in browser
# Should redirect to OAM login page, authenticate, and land on OBIEE dashboard
\`\`\`

---

## Phase 9: End-to-End Verification

Run the full verification suite after all phases are complete.

\`\`\`bash
#!/bin/bash
# obiee_tls_verify.sh — run after completing all phases

OBIEE_HOST="obiee.company.com"
WLS_HOST="bi_server1.company.com"
OID_HOST="oid-server.company.com"
DB_HOST="db-server.company.com"
PASS=0
FAIL=0

check() {
    local label=\$1
    local result=\$2
    local expected=\$3
    if echo "\$result" | grep -q "\$expected"; then
        echo "[PASS] \$label"
        PASS=\$((PASS+1))
    else
        echo "[FAIL] \$label"
        echo "       Expected: \$expected"
        echo "       Got: \$(echo \$result | head -c 100)"
        FAIL=\$((FAIL+1))
    fi
}

# OHS TLS 1.2 enabled
R=\$(openssl s_client -connect \${OBIEE_HOST}:443 -tls1_2 </dev/null 2>&1)
check "OHS TLS 1.2 accepted" "\$R" "CONNECTED"

# OHS TLS 1.1 rejected
R=\$(openssl s_client -connect \${OBIEE_HOST}:443 -tls1_1 </dev/null 2>&1)
check "OHS TLS 1.1 rejected" "\$R" "handshake failure\|alert"

# OHS TLS 1.0 rejected
R=\$(openssl s_client -connect \${OBIEE_HOST}:443 -tls1 </dev/null 2>&1)
check "OHS TLS 1.0 rejected" "\$R" "handshake failure\|alert"

# WLS TLS 1.2 enabled
R=\$(openssl s_client -connect \${WLS_HOST}:9502 -tls1_2 </dev/null 2>&1)
check "WLS bi_server1 TLS 1.2 accepted" "\$R" "CONNECTED"

# WLS TLS 1.1 rejected
R=\$(openssl s_client -connect \${WLS_HOST}:9502 -tls1_1 </dev/null 2>&1)
check "WLS bi_server1 TLS 1.1 rejected" "\$R" "handshake failure\|alert"

# OID LDAPS accessible
R=\$(openssl s_client -connect \${OID_HOST}:636 -tls1_2 </dev/null 2>&1)
check "OID LDAPS TLS 1.2 accepted" "\$R" "CONNECTED"

# OBIEE analytics URL reachable
R=\$(curl -s -o /dev/null -w "%{http_code}" https://\${OBIEE_HOST}/analytics/saw.dll?bieehome)
check "OBIEE /analytics URL HTTP 200/302" "\$R" "^200\|^302"

# WLS HTTP port closed (if hardening was applied)
R=\$(nc -zv \${WLS_HOST} 9500 2>&1)
check "WLS HTTP port 9500 closed" "\$R" "refused\|failed"

echo ""
echo "Results: \${PASS} passed, \${FAIL} failed"
\`\`\`

\`\`\`bash
chmod +x /u01/oracle/scripts/obiee_tls_verify.sh
/u01/oracle/scripts/obiee_tls_verify.sh
\`\`\`

---

## Phase 10: Certificate Expiry Health Script

\`\`\`bash
cat > /u01/oracle/scripts/obiee_cert_health.sh << 'SCRIPT'
#!/bin/bash
# obiee_cert_health.sh — daily cert expiry monitoring

WARN_DAYS=90
CRIT_DAYS=30
ALERT_EMAIL="dba-team@company.com"
STATUS_FILE=/tmp/obiee_cert_status_\$(date +%Y%m%d).txt
> \$STATUS_FILE

check_ssl() {
    local host=\$1 port=\$2 label=\$3
    local expiry cert_cn days_left
    cert_cn=\$(echo | openssl s_client -connect "\${host}:\${port}" -servername "\${host}" \
        2>/dev/null | openssl x509 -noout -subject 2>/dev/null | sed 's/.*CN = //')
    expiry=\$(echo | openssl s_client -connect "\${host}:\${port}" -servername "\${host}" \
        2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
    if [ -z "\$expiry" ]; then
        echo "UNKNOWN  [\$label] Cannot connect to \${host}:\${port}" | tee -a \$STATUS_FILE
        return 2
    fi
    days_left=\$(( ( \$(date -d "\$expiry" +%s 2>/dev/null || date -j -f "%b %d %T %Y %Z" "\$expiry" +%s) - \$(date +%s) ) / 86400 ))
    if [ \$days_left -le \$CRIT_DAYS ]; then
        echo "CRITICAL [\$label] \${cert_cn} — expires in \${days_left}d (\$expiry)" | tee -a \$STATUS_FILE
    elif [ \$days_left -le \$WARN_DAYS ]; then
        echo "WARNING  [\$label] \${cert_cn} — expires in \${days_left}d (\$expiry)" | tee -a \$STATUS_FILE
    else
        echo "OK       [\$label] \${cert_cn} — expires in \${days_left}d" | tee -a \$STATUS_FILE
    fi
}

check_jks() {
    local jks=\$1 alias=\$2 pass=\$3 label=\$4
    local expiry days_left
    expiry=\$(keytool -list -v -keystore "\$jks" -storepass "\$pass" -alias "\$alias" 2>/dev/null \
        | grep "Valid from" | sed 's/.*until: //')
    [ -z "\$expiry" ] && { echo "UNKNOWN  [\$label] Alias \$alias not found in \$jks" | tee -a \$STATUS_FILE; return; }
    days_left=\$(( ( \$(date -d "\$expiry" +%s 2>/dev/null) - \$(date +%s) ) / 86400 ))
    if [ \$days_left -le \$CRIT_DAYS ]; then
        echo "CRITICAL [\$label] JKS alias \$alias — expires in \${days_left}d" | tee -a \$STATUS_FILE
    elif [ \$days_left -le \$WARN_DAYS ]; then
        echo "WARNING  [\$label] JKS alias \$alias — expires in \${days_left}d" | tee -a \$STATUS_FILE
    else
        echo "OK       [\$label] JKS alias \$alias — expires in \${days_left}d" | tee -a \$STATUS_FILE
    fi
}

check_ssl "obiee.company.com"          "443"  "OHS-browser"
check_ssl "bi_server1.company.com"     "9502" "WLS-bi_server1"
check_ssl "oid-server.company.com"     "636"  "OID-LDAPS"
check_ssl "admin-server.company.com"   "7002" "WLS-AdminServer"
check_jks "/u01/oracle/keystores/obiee-identity.jks" "obiee-server" "Identity1" "WLS-identity-JKS"

# Alert if any WARNING or CRITICAL lines found
if grep -qE "^(WARNING|CRITICAL)" \$STATUS_FILE; then
    mail -s "OBIEE Cert Expiry Alert - \$(hostname -f) - \$(date +%Y-%m-%d)" \
        "\$ALERT_EMAIL" < \$STATUS_FILE
fi
SCRIPT

chmod +x /u01/oracle/scripts/obiee_cert_health.sh

# Add to crontab — run at 07:00 daily
(crontab -l 2>/dev/null; echo "0 7 * * * /u01/oracle/scripts/obiee_cert_health.sh >> /u01/oracle/logs/cert_health.log 2>&1") | crontab -

# Test the script immediately
/u01/oracle/scripts/obiee_cert_health.sh
\`\`\`

---

## Rollback Procedure

If TLS 1.2 enforcement breaks OBIEE access, reverse the changes in the opposite order (OHS first, then WebLogic, then data sources).

\`\`\`bash
# Rollback OHS ssl.conf
cp /u01/oracle/config/domains/bi_domain/config/fmwconfig/components/OHS/ohs1/ssl.conf.bak_YYYYMMDD \
   /u01/oracle/config/domains/bi_domain/config/fmwconfig/components/OHS/ohs1/ssl.conf
/u01/oracle/config/domains/bi_domain/bin/restartComponent.sh ohs1

# Rollback setDomainEnv.sh
cp /u01/oracle/config/domains/bi_domain/bin/setDomainEnv.sh.bak_YYYYMMDD \
   /u01/oracle/config/domains/bi_domain/bin/setDomainEnv.sh

# Restart Admin Server and bi_server1
/u01/oracle/config/domains/bi_domain/bin/stopWebLogic.sh
nohup /u01/oracle/config/domains/bi_domain/bin/startWebLogic.sh &
# Then start bi_server1 via Node Manager

# Rollback LDAP provider port via WLST (change port back to 389, SSLEnabled=False)
# Rollback RPD connection pool to use TCP TNS alias

# Verify OBIEE accessible after rollback
curl -s -o /dev/null -w "%{http_code}\n" https://obiee.company.com/analytics/saw.dll?bieehome
\`\`\``,
};

async function main() {
  console.log('Inserting OBIEE TLS runbook...');
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
