import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Implementing TLS 1.2 Across the OBIEE 12c Topology: OHS, WebLogic, BI Server, and Data Source Connections',
  slug: 'oracle-obiee-tls-1-2-implementation-topology',
  excerpt:
    'A complete guide to enforcing TLS 1.2 across the OBIEE 12c stack: Oracle HTTP Server ssl.conf and Oracle Wallet, WebLogic SSL identity and trust keystores, JVM-level JSSE enforcement in setDomainEnv.sh, BI Server TCPS database connections, LDAPS authentication source configuration, OAM SSO integration, rollout sequence, testing commands, and certificate expiry monitoring.',
  category: 'fusion-middleware' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-07'),
  youtubeUrl: null,
  content: `## Introduction

Oracle Business Intelligence Enterprise Edition (OBIEE) 12c is a multi-tier analytics platform. In a typical production deployment, a user's request to view a dashboard crosses six or more distinct communication channels before query results are returned — browser to OHS, OHS to WebLogic, WebLogic BI components to BI Server, BI Server to Oracle Database, BI Server to the LDAP directory for authentication. Each of those channels has its own certificate store, its own TLS configuration mechanism, and its own failure mode when TLS 1.2 is enforced but not fully wired.

Enforcing TLS 1.2 on OBIEE is not a single configuration change. It is a coordinated sequence across Oracle HTTP Server (Oracle Wallet), WebLogic Server (JKS keystores, JSSE JVM flags), the BI Server system components (sqlnet.ora TCPS, LDAPS trust), and optionally OAM when SSO is integrated. This post maps every communication channel in the OBIEE 12c topology, explains the correct configuration for TLS 1.2 on each, and provides the rollout sequence that avoids downtime caused by enforcing TLS 1.2 on an outer layer before the inner layers are ready.

---

## OBIEE 12c Communication Topology

\`\`\`
                 ┌─────────────────────────────────────────────────────────┐
                 │              OBIEE 12c TLS 1.2 Channel Map              │
                 └─────────────────────────────────────────────────────────┘

  Browser
  (Client)
     │
     │ [1] TLS 1.2 HTTPS :443
     │     OHS Oracle Wallet
     ▼
 ┌──────────────┐  [2] HTTPS (mod_wl_ohs)     ┌────────────────────────────┐
 │ Oracle HTTP  │ ──────────────────────────▶ │  WebLogic Managed Server   │
 │ Server (OHS) │     TLS 1.2 :9502           │  bi_server1                │
 │  :443        │     WLS JKS identity/trust  │  :9502 (SSL)               │
 └──────────────┘                             └───────────┬────────────────┘
                                                          │
                                 [3] Internal NQS :9703   │
                                     (localhost)          │
                                                          ▼
                                              ┌───────────────────────────┐
                                              │  BI Server (OBIS)         │
                                              │  Oracle BI Analytical     │
                                              │  Engine  :9703            │
                                              └──────┬──────────┬─────────┘
                                                     │          │
                                    [4] TCPS :1522   │          │ [5] LDAPS :636
                                        sqlnet.ora   │          │     Java cacerts
                                        Oracle Wallet│          │     / trust JKS
                                                     ▼          ▼
                                             ┌──────────┐  ┌──────────────┐
                                             │  Oracle  │  │  OID / AD    │
                                             │    DB    │  │  Directory   │
                                             └──────────┘  └──────────────┘

  WebLogic Admin Server :7002 (SSL)
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  [6] Admin channel → bi_server1 (TLS 1.2, same WLS JKS config)         │
  │  [7] OAM WebGate on OHS → OAM Server (OAP channel, if SSO configured)  │
  └─────────────────────────────────────────────────────────────────────────┘
\`\`\`

Seven distinct TLS channels. Each is owned by a different configuration layer.

---

## Certificate Store Types in OBIEE

| Component | Certificate Store | Format | Location |
|---|---|---|---|
| OHS web listener | Oracle Wallet | .p12 / ewallet.p12 | \`\$DOMAIN_HOME/config/fmwconfig/components/OHS/ohs1/keystores/\` |
| WebLogic SSL listener | JKS keystore | .jks | \`\$DOMAIN_HOME/security/\` or custom path |
| WebLogic trust | JKS truststore | .jks | Same as identity or separate |
| BI Server → Oracle DB | Oracle Wallet | ewallet.p12 | \`\$BI_HOME/network/admin/\` or custom |
| BI Server → LDAP | Java cacerts or trust JKS | .jks / .cer | \`\$JAVA_HOME/lib/security/cacerts\` |
| OAM WebGate (OHS) | Oracle Wallet | ewallet.p12 | WebGate config directory |
| WebLogic JVM (JSSE) | Controlled by JVM flags | — | setDomainEnv.sh |

---

## Layer 1: Oracle HTTP Server — OHS ssl.conf

OHS is the OBIEE entry point. All browser traffic arrives at OHS on port 443. OHS proxies requests to the WebLogic managed server (\`bi_server1\`) via the \`mod_wl_ohs\` module.

### Locating the OHS Configuration

In OBIEE 12c, OHS runs as a system component outside the WebLogic domain but within the same ORACLE_HOME. The SSL configuration is in:

\`\`\`
\$DOMAIN_HOME/config/fmwconfig/components/OHS/<instance_name>/ssl.conf
\`\`\`

For a typical OBIEE installation with OHS instance \`ohs1\`:

\`\`\`
\$DOMAIN_HOME/config/fmwconfig/components/OHS/ohs1/ssl.conf
\`\`\`

### TLS 1.2 Configuration in ssl.conf

\`\`\`apache
<VirtualHost *:443>
    ServerName obiee.company.com
    SSLEngine on
    SSLWallet "\${ORACLE_INSTANCE}/config/fmwconfig/components/OHS/ohs1/keystores/default"

    # Enforce TLS 1.2 — disable SSLv2, SSLv3, TLSv1.0, TLSv1.1
    SSLProtocol -ALL +TLSv1.2

    # Strong TLS 1.2 cipher suites — ECDHE for forward secrecy
    SSLCipherSuite TLSv1.2 ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384

    SSLCertificateFile "\${ORACLE_INSTANCE}/config/fmwconfig/components/OHS/ohs1/keystores/default/ohs-cert.pem"
    SSLCertificateKeyFile "\${ORACLE_INSTANCE}/config/fmwconfig/components/OHS/ohs1/keystores/default/ohs-key.pem"

    # Proxy to WebLogic managed server over HTTPS
    <Location /analytics>
        WLSRequest On
        WebLogicSSLPort 9502
        WebLogicCluster bi_server1.company.com:9502
        WLSSLWallet "\${ORACLE_INSTANCE}/config/fmwconfig/components/OHS/ohs1/keystores/default"
    </Location>
    <Location /wsm-pm>
        WLSRequest On
        WebLogicSSLPort 9502
        WebLogicCluster bi_server1.company.com:9502
    </Location>
</VirtualHost>
\`\`\`

**Key directives:**
- \`SSLProtocol -ALL +TLSv1.2\` disables all protocols and re-enables only TLS 1.2. Without the \`-ALL\` prefix, earlier protocols remain enabled.
- \`WebLogicSSLPort\` in the Location block tells mod_wl_ohs to connect to WebLogic over HTTPS rather than HTTP. Without this, OHS–WebLogic traffic is unencrypted HTTP even while the browser–OHS channel is HTTPS.
- \`WLSSLWallet\` specifies which Oracle Wallet contains the CA certificate to verify WebLogic's server certificate. The WebLogic self-signed cert's CA must be in this wallet.

### Oracle Wallet for OHS

The Oracle Wallet holds the OHS server certificate and its chain. Create or update it with \`orapki\`:

\`\`\`bash
# Create a new auto-login wallet
orapki wallet create -wallet \$DOMAIN_HOME/config/fmwconfig/components/OHS/ohs1/keystores/default -auto_login

# Import the server certificate (signed by your CA)
orapki wallet add -wallet .../default -cert ca-cert.pem -trusted_cert
orapki wallet add -wallet .../default -user_cert ohs-server.pem

# Import the WebLogic CA cert so OHS can verify WLS certificate
orapki wallet add -wallet .../default -cert wls-ca-cert.pem -trusted_cert

# Verify wallet contents
orapki wallet display -wallet .../default
\`\`\`

### AutoConfig Risk for OHS ssl.conf

In EBS-integrated OBIEE deployments, the OHS \`ssl.conf\` may be managed by EBS AutoConfig. Any AutoConfig run overwrites \`ssl.conf\` with the template defaults, which typically do not include \`SSLProtocol -ALL +TLSv1.2\`. Protect changes by updating the AutoConfig template at:

\`\`\`
\$AD_TOP/admin/driver/ohs_ssl.conf.template
\`\`\`

Add the \`SSLProtocol\` and \`SSLCipherSuite\` directives to the template so they survive AutoConfig runs. Verify after every EBS patch application.

---

## Layer 2: WebLogic SSL Listener — Identity and Trust Keystores

WebLogic \`bi_server1\` must have an SSL listener configured with a valid server certificate. The identity keystore holds the server's private key and certificate; the trust keystore holds the CA certificates used to authenticate clients and upstream components.

### Configuring SSL via WLST

\`\`\`python
connect('weblogic', 'password', 't3://admin-server:7001')

cd('/Servers/bi_server1/SSL/bi_server1')
cmo.setEnabled(True)
cmo.setServerCertificateChainFileName('')
cmo.setTwoWaySSLEnabled(False)

# Identity keystore
cd('/Servers/bi_server1')
cmo.setKeyStores('CustomIdentityAndCustomTrust')
cmo.setCustomIdentityKeyStoreFileName('/u01/oracle/keystores/obiee-identity.jks')
cmo.setCustomIdentityKeyStoreType('JKS')
cmo.setCustomIdentityKeyStorePassPhraseEncrypted('keystorepassword')
cmo.setCustomTrustKeyStoreFileName('/u01/oracle/keystores/obiee-trust.jks')
cmo.setCustomTrustKeyStoreType('JKS')
cmo.setCustomTrustKeyStorePassPhraseEncrypted('trustpassword')

# Private key alias and passphrase
cd('/Servers/bi_server1/SSL/bi_server1')
cmo.setPrivateKeyAlias('obiee-server')
cmo.setPrivateKeyPassPhraseEncrypted('keypassword')

# Minimum TLS protocol version
cmo.setMinimumTLSProtocolVersion('TLSv1.2')

save()
activate()
disconnect()
\`\`\`

\`setMinimumTLSProtocolVersion('TLSv1.2')\` instructs WebLogic's SSL stack to reject handshakes that propose TLS 1.1 or earlier. This is the WebLogic-native TLS 1.2 enforcement mechanism — it applies to the WebLogic SSL listener layer, separate from the JVM-level JSSE enforcement in Layer 3.

### Building the Identity and Trust JKS

\`\`\`bash
# Import the WebLogic server certificate and key into the identity JKS
openssl pkcs12 -export -in obiee-server.pem -inkey obiee-server.key \
    -certfile ca-chain.pem -out obiee-server.p12 -name obiee-server

keytool -importkeystore -srckeystore obiee-server.p12 -srcstoretype PKCS12 \
    -destkeystore obiee-identity.jks -deststoretype JKS \
    -srcalias obiee-server -destalias obiee-server

# Build the trust JKS — import all CA certs that WebLogic needs to trust
keytool -importcert -keystore obiee-trust.jks -alias company-root-ca \
    -file company-root-ca.pem -noprompt
keytool -importcert -keystore obiee-trust.jks -alias company-issuing-ca \
    -file company-issuing-ca.pem -noprompt

# Verify
keytool -list -keystore obiee-identity.jks
keytool -list -keystore obiee-trust.jks
\`\`\`

---

## Layer 3: JVM-Level TLS Enforcement — setDomainEnv.sh

WebLogic's SSL implementation delegates to the JVM's JSSE provider for actual TLS protocol negotiation. JSSE respects the \`jdk.tls.disabledAlgorithms\` security property, which is the most comprehensive mechanism for enforcing TLS 1.2 across all outbound and inbound JSSE connections in the JVM — including internal WebLogic channels, JDBC connections using JSSE, and LDAP over JSSE.

### setDomainEnv.sh Changes

Edit \`\$DOMAIN_HOME/bin/setDomainEnv.sh\` to add the disabled algorithms flag to EXTRA_JAVA_PROPERTIES:

\`\`\`bash
# Add to setDomainEnv.sh, before the existing JAVA_OPTIONS export
EXTRA_JAVA_PROPERTIES="\${EXTRA_JAVA_PROPERTIES} \\
  -Djdk.tls.disabledAlgorithms=SSLv3,TLSv1,TLSv1.1,RC4,DES,MD5withRSA,DH+keySize<2048,EC+keySize<224,3DES_EDE_CBC,anon,NULL"

export EXTRA_JAVA_PROPERTIES
\`\`\`

This flag applies to all Java processes that source \`setDomainEnv.sh\` — the Admin Server, bi_server1, and any Node Manager process that uses this domain environment. It is the broadest TLS 1.2 enforcement mechanism in the WebLogic tier.

**Why both setDomainEnv.sh and the WLST \`MinimumTLSProtocolVersion\` setting?** The WLST setting controls WebLogic's SSL subsystem for WebLogic-to-WebLogic channels. The JVM flag controls all JSSE channels including JDBC, outbound HTTP clients within deployed applications, and WebLogic's own SSL implementation when it falls back to JSSE. Setting both ensures complete coverage.

---

## Layer 4: BI Server → Oracle Database — TCPS

The BI Server (OBIS) connects to Oracle Database data sources for query execution. Enforcing TLS 1.2 on these connections requires configuring Oracle Net Services with TCPS and restricting to TLS 1.2 via \`SSL_VERSION\` in \`sqlnet.ora\`.

### sqlnet.ora for TCPS on the BI Server Host

\`\`\`ini
# \$BI_HOME/network/admin/sqlnet.ora
SQLNET.AUTHENTICATION_SERVICES = (NONE)
SSL_CLIENT_AUTHENTICATION = FALSE
WALLET_LOCATION =
  (SOURCE =
    (METHOD = FILE)
    (METHOD_DATA =
      (DIRECTORY = /u01/oracle/bi_wallet)))
SSL_VERSION = 1.2
\`\`\`

### tnsnames.ora TCPS Entry for the Data Source Database

\`\`\`ini
BIDB_TCPS =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCPS)(HOST = db-server.company.com)(PORT = 1522))
    (CONNECT_DATA =
      (SERVICE_NAME = bidb.company.com)))
\`\`\`

### Oracle Wallet for TCPS on the BI Server

\`\`\`bash
# Create wallet directory
mkdir -p /u01/oracle/bi_wallet

# Create auto-login wallet
orapki wallet create -wallet /u01/oracle/bi_wallet -auto_login

# Import the database server's CA certificate
orapki wallet add -wallet /u01/oracle/bi_wallet \
    -cert /u01/certs/db-ca.pem -trusted_cert

# Verify
orapki wallet display -wallet /u01/oracle/bi_wallet
\`\`\`

### Updating the BI Server RPD Connection Pool

After configuring TCPS on the BI Server host, update each affected connection pool in the RPD (Repository). In Oracle BI Administration Tool:

1. Open the RPD in offline mode
2. Navigate to Physical Layer → Connection Pool for the Oracle data source
3. Set **Call Interface** to \`OCI 10g/11g\`
4. Set the **Data Source Name** to the TCPS TNS alias (\`BIDB_TCPS\`)
5. Save and re-upload the RPD to the BI Server via Enterprise Manager or the \`biserverxmlgen\` CLI

The BI Server resolves TNS aliases from the \`tnsnames.ora\` in its \`\$ORACLE_HOME/network/admin/\` directory. Verify the path matches the wallet location in \`sqlnet.ora\`.

---

## Layer 5: BI Server → LDAP Authentication Source — LDAPS

OBIEE 12c uses an LDAP directory (OID, Oracle Unified Directory, or Active Directory) as its identity store for user and group information. The LDAP connection is configured in the WebLogic domain security realm.

### Configuring LDAPS in WebLogic Security Realm

To use LDAPS (LDAP over TLS, port 636):

1. In the WebLogic Administration Console, navigate to **Security Realms → myrealm → Providers → Authentication**
2. Select the OracleInternetDirectoryAuthenticator (or OracleUnifiedDirectoryAuthenticator / ActiveDirectoryAuthenticator)
3. Set **Host** to the LDAP server hostname
4. Set **Port** to \`636\`
5. Set **SSL Enabled** to \`true\`
6. Save and activate

### Importing the LDAP CA Certificate into the WebLogic Trust JKS

For WebLogic to verify the LDAP server's certificate, the LDAP server's CA certificate must be in WebLogic's trust keystore:

\`\`\`bash
# Import the OID/AD CA certificate into the WebLogic trust JKS
keytool -importcert -keystore /u01/oracle/keystores/obiee-trust.jks \
    -alias oid-ca -file /u01/certs/oid-ca.pem -noprompt

# Verify
keytool -list -keystore /u01/oracle/keystores/obiee-trust.jks | grep oid-ca
\`\`\`

After updating the trust JKS, restart bi_server1. The WebLogic authentication provider will then establish LDAPS connections using TLS 1.2 (enforced by the JVM flag set in Layer 3).

### LDAP Authentication Source in the RPD

If the RPD-level security (used for row-level security and variable initialisation blocks) directly queries LDAP via a connection pool rather than relying on the WebLogic security realm, that connection pool also needs to be updated to use \`ldaps://\` and port 636. Update the initialisation block data source accordingly in BI Administration Tool.

---

## Layer 6: WebLogic Admin Channel and Node Manager

WebLogic's Node Manager and Admin Server to Managed Server channel can be secured over SSL. For OBIEE deployments using the standard Node Manager setup:

\`\`\`bash
# Node Manager secure mode — in \$DOMAIN_HOME/nodemanager/nodemanager.properties
SecureListener=true
KeyStores=CustomIdentityAndCustomTrust
CustomIdentityKeyStoreFileName=/u01/oracle/keystores/obiee-nm-identity.jks
CustomIdentityKeyStorePassPhrase=password
CustomTrustKeyStoreFileName=/u01/oracle/keystores/obiee-trust.jks
CustomTrustKeyStorePassPhrase=password
\`\`\`

The Admin Server to Managed Server channel uses the same WebLogic SSL configuration established in Layer 2 — once \`bi_server1\` has its SSL listener enabled and \`MinimumTLSProtocolVersion\` set to TLSv1.2, all Admin channel communication to that server enforces TLS 1.2.

---

## Layer 7: OAM Integration — WebGate on OHS

When OBIEE 12c is integrated with Oracle Access Manager for enterprise SSO, an OAM WebGate is deployed on the OHS instance. The WebGate establishes an OAP channel to the OAM Server.

TLS 1.2 on this channel is covered by:
- **OHS ssl.conf** (Layer 1): browser–OHS channel uses TLS 1.2
- **OAP channel security**: configure the WebGate with \`Security=Simple\` (SSL) or \`Security=Cert\` (mutual TLS) in the WebGate configuration
- The OAM Server-side OAP listener is secured at the OAM layer

For the WebGate Oracle Wallet, import the OAM CA certificate into the WebGate's wallet so that the OAP SSL handshake succeeds:

\`\`\`bash
# WebGate wallet location
orapki wallet add \
    -wallet \$DOMAIN_HOME/config/fmwconfig/components/OHS/ohs1/webgate/config/wallet \
    -cert /u01/certs/oam-ca.pem -trusted_cert
\`\`\`

---

## Rollout Sequence

Enforce TLS 1.2 inside-out — secure data source connections first, then WebLogic, then OHS — to avoid breaking outer components before inner ones are ready.

**Step 1 — Database TCPS (BI Server → Oracle DB)**
Configure TCPS on the Oracle Database listener and the BI Server sqlnet.ora. Test BI Server connectivity before proceeding. This change is transparent to all upper layers.

**Step 2 — LDAPS (WebLogic → LDAP Directory)**
Update the WebLogic authentication provider to LDAPS port 636. Import the LDAP CA cert into the WebLogic trust JKS. Restart bi_server1. Verify user authentication still works.

**Step 3 — WebLogic SSL Listener and JVM Flag**
Enable SSL on bi_server1 (port 9502). Set \`MinimumTLSProtocolVersion=TLSv1.2\` via WLST. Add \`-Djdk.tls.disabledAlgorithms\` to setDomainEnv.sh. Restart Admin Server and bi_server1. Test HTTPS access directly on port 9502 with \`openssl s_client\`.

**Step 4 — OHS mod_wl_ohs Switch to HTTPS Backend**
Update the mod_wl_ohs Location blocks to use \`WebLogicSSLPort 9502\` instead of \`WebLogicPort 9500\`. Import the WebLogic CA cert into the OHS Oracle Wallet. Restart OHS. Test OHS → WebLogic HTTPS proxy.

**Step 5 — OHS TLS 1.2 on the Listener**
Add \`SSLProtocol -ALL +TLSv1.2\` and the cipher suite restriction to ssl.conf. Restart OHS. Test browser access with TLS 1.2. Verify TLS 1.0 and 1.1 connections are rejected.

**Step 6 — Disable Plain HTTP on WebLogic (optional)**
After the OHS proxy is confirmed working over HTTPS, disable the plain HTTP listener on bi_server1 (port 9500) to prevent bypass of TLS. Ensure no monitoring scripts or internal tools use port 9500 directly.

**Step 7 — OAM WebGate (if SSO configured)**
Update the WebGate OAP channel security mode. Import OAM CA cert into WebGate wallet. Test SSO authentication end-to-end.

---

## Testing Each Layer

### Layer 1: OHS TLS 1.2

\`\`\`bash
# Verify TLS 1.2 handshake succeeds
openssl s_client -connect obiee.company.com:443 -tls1_2

# Verify TLS 1.1 is rejected
openssl s_client -connect obiee.company.com:443 -tls1_1
# Expected: handshake failure

# Check certificate expiry
openssl s_client -connect obiee.company.com:443 </dev/null 2>&1 | openssl x509 -noout -dates

# Verify protocol negotiated
curl -v --tls-max 1.2 https://obiee.company.com/analytics/saw.dll?bieehome 2>&1 | grep -i "TLS\\|SSL\\|protocol"
\`\`\`

### Layer 2: WebLogic SSL Listener

\`\`\`bash
# Direct WebLogic SSL test (bypasses OHS)
openssl s_client -connect bi_server1.company.com:9502 -tls1_2

# Verify TLS 1.1 is rejected
openssl s_client -connect bi_server1.company.com:9502 -tls1_1

# Check cipher negotiated
openssl s_client -connect bi_server1.company.com:9502 </dev/null 2>&1 | grep "Cipher\\|Protocol"
\`\`\`

### Layer 4: BI Server TCPS Connection

\`\`\`bash
# Test TCPS connection from BI Server host
sqlplus user/password@BIDB_TCPS

# Or with explicit connection string
sqlplus user/password@'(DESCRIPTION=(ADDRESS=(PROTOCOL=TCPS)(HOST=db-server)(PORT=1522))(CONNECT_DATA=(SERVICE_NAME=bidb)))'

# Check Oracle DB alert log for SSL cipher line after connection:
# "SSL_CIPHER_SUITES=(TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384)"
\`\`\`

### Layer 5: LDAPS Authentication

\`\`\`bash
# Test LDAPS connectivity from WebLogic host
ldapsearch -H ldaps://oid-server.company.com:636 \
    -D "cn=orcladmin" -w password \
    -b "dc=company,dc=com" "(uid=testuser)" uid

# Verify TLS 1.1 is blocked
openssl s_client -connect oid-server.company.com:636 -tls1_1
\`\`\`

### End-to-End Browser Test

\`\`\`bash
# Full TLS chain validation
curl -v https://obiee.company.com/analytics/saw.dll?bieehome 2>&1 | grep -E "SSL connection|TLS|cipher"

# Test that TLS 1.1 is rejected end-to-end
curl --tls-max 1.1 https://obiee.company.com/analytics/saw.dll?bieehome
# Expected: curl: (35) OpenSSL SSL_connect: Connection reset by peer
\`\`\`

---

## Common Cross-Component Failures

| Symptom | Root Cause | Fix |
|---|---|---|
| OHS returns 503 after switching to WebLogicSSLPort | OHS Oracle Wallet does not contain the WebLogic CA cert; TLS handshake to bi_server1 fails | Add the WebLogic CA cert to the OHS wallet: \`orapki wallet add -wallet ... -cert wls-ca.pem -trusted_cert\` |
| \`javax.net.ssl.SSLHandshakeException: Received fatal alert: protocol_version\` in bi_server1 logs | An upstream component (OHS, load balancer) is connecting with TLS 1.0/1.1 to WLS after \`MinimumTLSProtocolVersion\` was set | Check that OHS \`WebLogicSSLPort\` connection uses TLS 1.2; inspect any load balancer SSL bridge settings |
| OBIEE login page renders but user authentication fails after enabling LDAPS | WebLogic trust JKS does not contain the LDAP server's CA cert | Import the OID/AD CA cert into the WebLogic trust JKS; restart bi_server1 |
| BI Server queries fail with \`ORA-12560: TNS:protocol adapter error\` after TCPS switch | sqlnet.ora wallet path is incorrect or wallet does not contain the database CA cert | Verify \`WALLET_LOCATION\` path; run \`orapki wallet display\` to confirm DB CA is present |
| \`ORA-28865: SSL connection closed\` during BI Server query | SSL version mismatch — BI Server \`SSL_VERSION=1.2\` but database listener configured for TLS 1.0 | Set \`SSL_VERSION = 1.2\` in the Oracle Database \`sqlnet.ora\` and \`listener.ora\` SSL configuration |
| OBIEE analytics URL accessible but BI Publisher reports fail | BI Publisher has a separate WebLogic connection pool that still uses HTTP to the database; BI Publisher JDBC not updated for TCPS | Update BI Publisher data sources in Enterprise Manager or BI Publisher Admin console to use TCPS JDBC URL |
| Node Manager cannot reconnect to bi_server1 after restart | Node Manager configured with \`SecureListener=false\` but Admin Server now requires SSL communication | Set \`SecureListener=true\` in nodemanager.properties; provide the Node Manager identity JKS |
| curl to OBIEE succeeds with TLSv1.2 but not with Firefox / Chrome | Cipher suite mismatch — configured suites not supported by modern browsers | Use GCM-based cipher suites (\`ECDHE-RSA-AES256-GCM-SHA384\`); remove CBC and older suites from \`SSLCipherSuite\` |

---

## Certificate Inventory and Expiry Monitoring

| Certificate | Location | Typical Validity | Impact if Expired |
|---|---|---|---|
| OHS server cert (browser-facing) | OHS Oracle Wallet | 1–2 years | All browser access fails immediately |
| WebLogic bi_server1 server cert | obiee-identity.jks | 1–2 years | OHS → WebLogic HTTPS proxy fails; 503 errors |
| BI Server TCPS wallet cert | /u01/oracle/bi_wallet | 1–2 years | All BI Server → DB queries fail; dashboards return errors |
| Oracle Database TCPS cert | DB Oracle Wallet | 1–2 years | BI Server TCPS connections refused |
| WebLogic trust JKS CA certs | obiee-trust.jks | 5–10 years | CA expiry breaks LDAPS and OHS proxy validation |
| LDAP server cert (OID/AD) | LDAP server wallet | 1–2 years | WebLogic LDAPS authentication fails; no OBIEE logins |
| OAM WebGate cert (if SSO) | WebGate wallet | 1–2 years | SSO authentication fails; users cannot log in |
| Node Manager cert | NM identity JKS | 1–2 years | Node Manager cannot start/stop managed servers |

### Expiry Monitoring Script

\`\`\`bash
#!/bin/bash
# obiee_cert_expiry_check.sh

WARN_DAYS=90
CRIT_DAYS=30
ALERT_EMAIL="dba-team@company.com"
HOSTNAME=\$(hostname -f)

check_ssl_cert() {
    local host=\$1
    local port=\$2
    local label=\$3
    local expiry
    expiry=\$(echo | openssl s_client -connect "\${host}:\${port}" -servername "\${host}" 2>/dev/null \\
        | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
    if [ -z "\$expiry" ]; then
        echo "UNKNOWN: Cannot retrieve cert from \${label} (\${host}:\${port})" | \\
            mail -s "OBIEE Cert Check UNKNOWN: \${label}" "\$ALERT_EMAIL"
        return
    fi
    local expiry_epoch
    expiry_epoch=\$(date -d "\$expiry" +%s 2>/dev/null || date -j -f "%b %d %T %Y %Z" "\$expiry" +%s)
    local now_epoch
    now_epoch=\$(date +%s)
    local days_left=\$(( (expiry_epoch - now_epoch) / 86400 ))

    if [ "\$days_left" -le "\$CRIT_DAYS" ]; then
        echo "CRITICAL: \${label} cert expires in \${days_left} days (\${expiry})" | \\
            mail -s "OBIEE Cert CRITICAL: \${label} expires in \${days_left}d" "\$ALERT_EMAIL"
    elif [ "\$days_left" -le "\$WARN_DAYS" ]; then
        echo "WARNING: \${label} cert expires in \${days_left} days (\${expiry})" | \\
            mail -s "OBIEE Cert WARNING: \${label} expires in \${days_left}d" "\$ALERT_EMAIL"
    fi
}

check_jks_cert() {
    local jks=\$1
    local alias=\$2
    local password=\$3
    local label=\$4
    local expiry
    expiry=\$(keytool -list -v -keystore "\$jks" -storepass "\$password" -alias "\$alias" 2>/dev/null \\
        | grep "Valid from" | sed 's/.*until: //')
    if [ -z "\$expiry" ]; then return; fi
    local expiry_epoch
    expiry_epoch=\$(date -d "\$expiry" +%s 2>/dev/null)
    local now_epoch
    now_epoch=\$(date +%s)
    local days_left=\$(( (expiry_epoch - now_epoch) / 86400 ))
    if [ "\$days_left" -le "\$CRIT_DAYS" ]; then
        echo "CRITICAL: JKS \${label} cert expires in \${days_left} days" | \\
            mail -s "OBIEE JKS Cert CRITICAL: \${label}" "\$ALERT_EMAIL"
    elif [ "\$days_left" -le "\$WARN_DAYS" ]; then
        echo "WARNING: JKS \${label} cert expires in \${days_left} days" | \\
            mail -s "OBIEE JKS Cert WARNING: \${label}" "\$ALERT_EMAIL"
    fi
}

# Layer 1: OHS browser-facing cert
check_ssl_cert "obiee.company.com" "443" "OHS-browser"

# Layer 2: WebLogic bi_server1 cert
check_ssl_cert "bi_server1.company.com" "9502" "WLS-bi_server1"

# Layer 5: LDAP server cert
check_ssl_cert "oid-server.company.com" "636" "OID-LDAPS"

# Layer 2: WebLogic identity JKS cert
check_jks_cert "/u01/oracle/keystores/obiee-identity.jks" "obiee-server" "keystorepass" "WLS-identity-JKS"

echo "OBIEE cert expiry check completed on \${HOSTNAME}"
\`\`\`

Add to crontab:

\`\`\`
0 7 * * * /u01/oracle/scripts/obiee_cert_expiry_check.sh >> /u01/oracle/logs/cert_check.log 2>&1
\`\`\`

---

## Conclusion

TLS 1.2 enforcement across the OBIEE 12c topology requires coordinated changes across four distinct configuration subsystems — Oracle Wallet (OHS), JKS keystores (WebLogic), sqlnet.ora and Oracle Net (BI Server to database), and the WebLogic security realm (LDAP authentication). The JVM-level \`-Djdk.tls.disabledAlgorithms\` flag in \`setDomainEnv.sh\` provides the broadest coverage for the WebLogic tier: it disables TLS 1.0 and 1.1 for every JSSE channel in the BI domain JVM simultaneously, complementing the WebLogic-native \`MinimumTLSProtocolVersion\` setting. The rollout must proceed from inner to outer — database and LDAP connections first, then WebLogic SSL, then OHS — so that each outer layer can successfully negotiate TLS 1.2 with the layer it proxies to before that inner layer drops support for earlier protocols. Certificate expiry monitoring across all eight certificate endpoints in the stack is the operational discipline that keeps TLS 1.2 working reliably after the initial rollout.`,
};

async function main() {
  console.log('Inserting OBIEE TLS topology post...');
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
