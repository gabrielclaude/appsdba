import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Implementing TLS 1.2 Across the SOA Suite 12c Topology: OHS, WebLogic, Composites, and Outbound Service Calls',
  slug: 'oracle-soa-suite-tls-1-2-implementation-topology',
  excerpt:
    'A complete guide to enforcing TLS 1.2 across the Oracle SOA Suite 12c stack: OHS ssl.conf and Oracle Wallet, WebLogic SSL identity and trust keystores, JVM JSSE enforcement, SOA database TCPS, LDAPS identity store, SOA composite outbound HTTPS trust configuration, Oracle Service Bus business service SSL, Oracle WSM policy store, and rollout sequence with testing commands.',
  category: 'soa-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-07'),
  youtubeUrl: null,
  content: `## Introduction

Oracle SOA Suite 12c is not a single-tier middleware platform — it is a cluster of cooperating components, each of which participates in one or more TLS-protected communication channels. A user invoking a composite service through the browser-facing URL traverses OHS, WebLogic, the SOA Infrastructure, and potentially Oracle Service Bus (OSB). Behind those visible layers, the SOA Infrastructure connects to an Oracle Database over JDBC, to an LDAP directory for identity resolution, and to external partner services and APIs over HTTPS — channels that are just as critical to TLS 1.2 enforcement as the browser-facing port.

Enforcing TLS 1.2 on SOA Suite is more complex than on a typical application stack because SOA composites are both consumers and producers of web services over HTTPS. Locking down inbound TLS 1.2 on WebLogic while leaving the JVM's outbound trust configuration unrestricted creates an asymmetric TLS posture that fails compliance requirements. This post maps every communication channel in the SOA Suite 12c topology, explains the TLS 1.2 configuration mechanism for each, and provides the rollout sequence that avoids breaking composite execution during the transition.

---

## SOA Suite 12c Communication Topology

\`\`\`
                ┌──────────────────────────────────────────────────────────────┐
                │              SOA Suite 12c TLS 1.2 Channel Map              │
                └──────────────────────────────────────────────────────────────┘

  Browser / SOAP Client
  (External Consumer)
        │
        │ [1] TLS 1.2 HTTPS :443
        │     OHS Oracle Wallet
        ▼
  ┌────────────┐  [2] HTTPS mod_wl_ohs    ┌──────────────────────────────────────┐
  │    OHS     │ ────────────────────────▶│  WebLogic Domain                     │
  │  :443      │     WLS JKS :8002        │                                      │
  └────────────┘                          │  ┌──────────────┐ ┌───────────────┐  │
                                          │  │ soa_server1  │ │ osb_server1   │  │
                                          │  │ :8001/:8002  │ │ :7004/:7005   │  │
                                          │  └──────┬───────┘ └───────┬───────┘  │
                                          │         │                 │          │
                                          │         └────────┬────────┘          │
                                          │                  │                   │
                                          │  [3] Admin channel :7002 (SSL)       │
                                          │  AdminServer ←──────────────────     │
                                          └──────────────────┼───────────────────┘
                                                             │
                          ┌──────────────────────────────────┼───────────────────┐
                          │                                  │                   │
                [4] TCPS  │                        [5] LDAPS │          [6] HTTPS│ outbound
                   :1522  │                            :636  │          composites│/ OSB
                          ▼                                  ▼                   ▼
                  ┌──────────────┐                  ┌──────────────┐   ┌──────────────────┐
                  │  Oracle DB   │                  │  OID / AD    │   │ External Services│
                  │  (SOA/MDS/   │                  │  Directory   │   │ APIs / Partners  │
                  │  OWSM schema)│                  └──────────────┘   └──────────────────┘
                  └──────────────┘

  Oracle WSM Policy Store: HTTPS to SOA DB (same TCPS connection as [4])
  Oracle B2B (if deployed): [7] HTTPS/AS2 outbound — same JVM truststore as [6]
\`\`\`

Eight TLS channels, each with its own configuration surface.

---

## Certificate Store Types in SOA Suite

| Component | Certificate Store | Format | Location |
|---|---|---|---|
| OHS web listener | Oracle Wallet | ewallet.p12 | \`\$DOMAIN_HOME/config/fmwconfig/components/OHS/ohs1/keystores/\` |
| WebLogic SSL listeners (all servers) | JKS identity keystore | .jks | Custom path, referenced in WLS config |
| WebLogic trust (all servers) | JKS truststore | .jks | Custom path, must include all upstream CAs |
| SOA/OSB → Oracle DB | Oracle Wallet or JDBC SSL props | ewallet.p12 / .jks | \`\$SOA_HOME/network/admin/\` or JDBC URL properties |
| SOA/OSB → LDAP | JKS truststore (same WLS trust) | .jks | Shared with WebLogic trust JKS |
| SOA composite outbound HTTPS | Java cacerts or custom trust JKS | .jks | \`\$JAVA_HOME/lib/security/cacerts\` or WLST-configured |
| Oracle WSM policy enforcement | Keystore service (KSS) | KSS or JKS | Managed via Oracle Platform Security Services |
| OAM WebGate (if SSO) | Oracle Wallet | ewallet.p12 | WebGate config directory |

---

## Layer 1: Oracle HTTP Server — OHS ssl.conf

OHS is the entry point for all inbound SOA Suite traffic: SOAP web service calls from external clients, REST API calls, and browser-based EM/composer access. OHS proxies to the SOA and OSB managed servers via mod_wl_ohs.

### TLS 1.2 Configuration in ssl.conf

\`\`\`apache
<VirtualHost *:443>
    ServerName soa.company.com
    SSLEngine on
    SSLWallet "\${ORACLE_INSTANCE}/config/fmwconfig/components/OHS/ohs1/keystores/default"

    SSLProtocol -ALL +TLSv1.2
    SSLCipherSuite TLSv1.2 ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384

    # SOA Composer and EM Console
    <Location /em>
        WLSRequest On
        WebLogicSSLPort 8002
        WebLogicCluster soa_server1.company.com:8002
        WLSSLWallet "\${ORACLE_INSTANCE}/config/fmwconfig/components/OHS/ohs1/keystores/default"
    </Location>

    # SOA Infrastructure — SOAP/REST composite endpoint
    <Location /soa-infra>
        WLSRequest On
        WebLogicSSLPort 8002
        WebLogicCluster soa_server1.company.com:8002
        WLSSLWallet "\${ORACLE_INSTANCE}/config/fmwconfig/components/OHS/ohs1/keystores/default"
    </Location>

    # Oracle Service Bus Admin Console
    <Location /sbconsole>
        WLSRequest On
        WebLogicSSLPort 7005
        WebLogicCluster osb_server1.company.com:7005
        WLSSLWallet "\${ORACLE_INSTANCE}/config/fmwconfig/components/OHS/ohs1/keystores/default"
    </Location>

    # OSB proxy service endpoints
    <Location /osb>
        WLSRequest On
        WebLogicSSLPort 7005
        WebLogicCluster osb_server1.company.com:7005
        WLSSLWallet "\${ORACLE_INSTANCE}/config/fmwconfig/components/OHS/ohs1/keystores/default"
    </Location>
</VirtualHost>
\`\`\`

The \`WebLogicSSLPort\` directive in each Location block is critical. Without it, mod_wl_ohs establishes a plain HTTP connection to the WebLogic managed server even while the browser–OHS channel is HTTPS. For SOA Suite, this means SOAP messages containing sensitive payload data would traverse the OHS–WebLogic leg unencrypted.

### Oracle Wallet for OHS

\`\`\`bash
WALLET_DIR=\$DOMAIN_HOME/config/fmwconfig/components/OHS/ohs1/keystores/default
orapki wallet create -wallet \$WALLET_DIR -auto_login

# Import CA chain
orapki wallet add -wallet \$WALLET_DIR -cert company-root-ca.pem -trusted_cert
orapki wallet add -wallet \$WALLET_DIR -cert company-issuing-ca.pem -trusted_cert

# Import OHS server certificate
orapki wallet add -wallet \$WALLET_DIR -user_cert ohs-server.pem

# Import WebLogic CA so OHS can verify the WLS server cert on the back channel
orapki wallet add -wallet \$WALLET_DIR -cert wls-ca.pem -trusted_cert

orapki wallet display -wallet \$WALLET_DIR
\`\`\`

---

## Layer 2: WebLogic SSL Listeners — SOA and OSB Managed Servers

SOA Suite 12c typically has multiple managed servers: \`soa_server1\` for the SOA Infrastructure (BPEL, Mediator, Human Workflow) and \`osb_server1\` for Oracle Service Bus. Both need SSL listeners configured with identity and trust JKS. In clustered deployments, each node in the SOA and OSB clusters requires the same SSL configuration.

### WLST Configuration for All SOA Domain Servers

\`\`\`python
connect('weblogic', 'password', 't3://admin-server:7001')

for server_name in ['soa_server1', 'osb_server1', 'AdminServer']:
    cd('/Servers/' + server_name + '/SSL/' + server_name)
    cmo.setEnabled(True)
    cmo.setTwoWaySSLEnabled(False)
    cmo.setMinimumTLSProtocolVersion('TLSv1.2')

    cd('/Servers/' + server_name)
    cmo.setKeyStores('CustomIdentityAndCustomTrust')
    cmo.setCustomIdentityKeyStoreFileName('/u01/oracle/keystores/soa-identity.jks')
    cmo.setCustomIdentityKeyStoreType('JKS')
    set('CustomIdentityKeyStorePassPhraseEncrypted', encrypt('Identity1'))
    cmo.setCustomTrustKeyStoreFileName('/u01/oracle/keystores/soa-trust.jks')
    cmo.setCustomTrustKeyStoreType('JKS')
    set('CustomTrustKeyStorePassPhraseEncrypted', encrypt('TrustStore1'))

    cd('/Servers/' + server_name + '/SSL/' + server_name)
    cmo.setPrivateKeyAlias('soa-server')
    set('PrivateKeyPassPhraseEncrypted', encrypt('Identity1'))

save()
activate()
disconnect()
\`\`\`

### SOA-Specific Trust JKS Contents

The SOA Suite trust JKS needs more CA entries than a typical WebLogic domain because SOA composites make outbound HTTPS calls to external partners, internal Oracle services, and the SOA Database. Every CA that signs a certificate the SOA JVM will connect to must be in this trust JKS:

\`\`\`bash
# CA for OHS (so WebLogic can verify OHS certificate on back-channel calls)
keytool -importcert -keystore soa-trust.jks -storepass TrustStore1 -alias ohs-ca -file ohs-ca.pem -noprompt

# CA for LDAP directory (OID or AD)
keytool -importcert -keystore soa-trust.jks -storepass TrustStore1 -alias oid-ca -file oid-ca.pem -noprompt

# CA for Oracle Database TCPS certificate
keytool -importcert -keystore soa-trust.jks -storepass TrustStore1 -alias db-ca -file db-ca.pem -noprompt

# CAs for external partner services called by composites
keytool -importcert -keystore soa-trust.jks -storepass TrustStore1 -alias partner-ca -file partner-ca.pem -noprompt

# Root CA and issuing CA (the company PKI)
keytool -importcert -keystore soa-trust.jks -storepass TrustStore1 -alias company-root-ca -file company-root-ca.pem -noprompt
keytool -importcert -keystore soa-trust.jks -storepass TrustStore1 -alias company-issuing-ca -file company-issuing-ca.pem -noprompt

keytool -list -keystore soa-trust.jks -storepass TrustStore1
\`\`\`

The trust JKS accumulation is an ongoing operational task — every time a new external partner is onboarded whose certificate is signed by a CA not yet in the trust JKS, that CA must be added and bi_server1 (or soa_server1) restarted.

---

## Layer 3: JVM-Level TLS Enforcement — setDomainEnv.sh

The \`jdk.tls.disabledAlgorithms\` JVM security property disables TLS 1.0 and 1.1 at the JSSE level for every connection in the JVM — inbound WebLogic SSL, outbound JDBC, outbound HTTP clients in SOA composites, and LDAP connections. This is the most comprehensive TLS 1.2 enforcement mechanism for the WebLogic tier.

### setDomainEnv.sh Update

\`\`\`bash
# Add to $DOMAIN_HOME/bin/setDomainEnv.sh
# Insert before the export EXTRA_JAVA_PROPERTIES line

EXTRA_JAVA_PROPERTIES="\${EXTRA_JAVA_PROPERTIES} \
  -Djdk.tls.disabledAlgorithms=SSLv3,TLSv1,TLSv1.1,RC4,DES,MD5withRSA,DH+keySize<2048,EC+keySize<224,3DES_EDE_CBC,anon,NULL \
  -Djavax.net.ssl.trustStore=/u01/oracle/keystores/soa-trust.jks \
  -Djavax.net.ssl.trustStorePassword=TrustStore1"

export EXTRA_JAVA_PROPERTIES
\`\`\`

The \`javax.net.ssl.trustStore\` system property ensures that all JSSE outbound connections — including those made by SOA composite HTTP bindings and OSB business services — use the SOA trust JKS rather than the JVM's default \`cacerts\`. This is essential for outbound HTTPS from composites: if the SOA trust JKS is not set as the JSSE default truststore, composite call-outs to HTTPS endpoints will fail with \`SSLHandshakeException: PKIX path building failed\` when the target server's CA is not in the JVM's built-in \`cacerts\`.

**SOA-specific note**: The \`javax.net.ssl.trustStore\` flag affects all composite outbound HTTP/HTTPS connections that go through the default JSSE provider. Composites that use Oracle WSM policies for message-level security manage their own keystore through the Keystore Service (KSS) and are not directly affected by this JVM flag.

---

## Layer 4: SOA Infrastructure Database — TCPS

The SOA Infrastructure schema (SOAINFRA, MDS, OWSM, STB) is stored in Oracle Database. WebLogic DataSources connect to this database continuously — BPEL dehydration, audit logs, human task storage, MDS metadata reads, OWSM policy lookups all use this connection. Enforcing TLS 1.2 on this connection requires TCPS on both the database listener and the WebLogic DataSource.

### WebLogic DataSource JDBC TCPS Properties

SOA Suite JDBC DataSources can be configured for TCPS using either the Oracle Wallet approach (sqlnet.ora on the WebLogic host) or JDBC URL properties. The JDBC URL properties approach is more portable in container environments:

\`\`\`
jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCPS)(HOST=db-server.company.com)(PORT=1522))(CONNECT_DATA=(SERVICE_NAME=soainfra.company.com))(SECURITY=(SSL_SERVER_DN_MATCH=YES)))
\`\`\`

With the corresponding JDBC connection properties in the WebLogic DataSource configuration:

\`\`\`
oracle.net.ssl_version=1.2
oracle.net.ssl_cipher_suites=(TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256)
oracle.net.authentication_services=NONE
javax.net.ssl.trustStore=/u01/oracle/keystores/soa-trust.jks
javax.net.ssl.trustStoreType=JKS
javax.net.ssl.trustStorePassword=TrustStore1
\`\`\`

These properties are set in the WebLogic Administration Console under the DataSource → Connection Pool → Properties tab, or via WLST:

\`\`\`python
connect('weblogic', 'password', 't3://admin-server:7001')

# Update each SOA DataSource
for ds_name in ['SOADataSource', 'mds-soa', 'mds-owsm', 'OraSDPMDataSource', 'OraSDPMDataSource_tlog']:
    try:
        cd('/JDBCSystemResources/' + ds_name + '/JDBCResource/' + ds_name +
           '/JDBCDriverParams/' + ds_name)
        cmo.setUrl('jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCPS)(HOST=db-server.company.com)(PORT=1522))(CONNECT_DATA=(SERVICE_NAME=soainfra.company.com)))')

        cd('/JDBCSystemResources/' + ds_name + '/JDBCResource/' + ds_name +
           '/JDBCDriverParams/' + ds_name + '/Properties/' + ds_name)
        # Add SSL properties
        create('oracle.net.ssl_version', 'Property')
        cd('oracle.net.ssl_version')
        cmo.setValue('1.2')
        cd('..')
    except Exception as e:
        print("DataSource " + ds_name + " error: " + str(e))

save()
activate()
disconnect()
\`\`\`

### SOA Suite DataSource Inventory

The full list of SOA Suite 12c DataSources that connect to the database and require TCPS updates:

| DataSource JNDI | Schema | Component |
|---|---|---|
| \`jdbc/SOADataSource\` | SOAINFRA | SOA Infrastructure (BPEL, Mediator, HWF) |
| \`jdbc/SOALocalTxDataSource\` | SOAINFRA | SOA local transaction (dehydration) |
| \`jdbc/mds-soa\` | MDS | Metadata Store (composite metadata) |
| \`jdbc/mds-owsm\` | MDS | OWSM policy metadata |
| \`jdbc/OraSDPMDataSource\` | UMS | Unified Messaging Service |
| \`jdbc/OraSDPMDataSource_tlog\` | UMS | UMS transaction log |
| \`jdbc/wlsbjmsrpDataSource\` | SOAINFRA | OSB JMS reporting |

---

## Layer 5: LDAP Identity Store — LDAPS

SOA Suite and OSB resolve user identities for human workflow task assignment, B2B trading partner authentication, and OSB security policies through the WebLogic security realm's LDAP authentication provider.

### Switching to LDAPS

\`\`\`python
connect('weblogic', 'password', 't3://admin-server:7001')

# Navigate to the LDAP authentication provider
# (provider name varies — check console: Security Realms → myrealm → Providers)
cd('/SecurityConfiguration/soa_domain/DefaultRealm/myrealm/AuthenticationProviders/OID_Authenticator')

cmo.setHost('oid-server.company.com')
cmo.setPort(636)
cmo.setSSLEnabled(True)

save()
activate()
disconnect()
\`\`\`

After updating the authentication provider, import the LDAP CA into the SOA trust JKS (already covered in Layer 2 trust JKS setup) and restart \`soa_server1\` and \`osb_server1\`.

---

## Layer 6: SOA Composite Outbound HTTPS — Trust Store Propagation

This layer is the most SOA-specific TLS concern and the one most commonly overlooked. SOA BPEL processes and Mediator routes frequently invoke external HTTPS web services as part of composite execution — payment gateways, partner APIs, government services, SaaS endpoints. Each of these outbound calls performs a TLS handshake where the SOA JVM acts as the TLS client and must verify the remote server's certificate.

### How SOA Composite Outbound HTTPS Works

When a SOA composite invokes an external HTTPS reference:
1. The composite's HTTP Binding Component or Web Service reference creates an outbound HTTPS connection
2. The JVM's JSSE provider performs the TLS handshake, including server certificate verification
3. The JSSE provider checks the remote server's certificate chain against the configured truststore
4. If the remote server's CA is not in the truststore → \`SSLHandshakeException: PKIX path building failed\` → composite fault

The \`javax.net.ssl.trustStore\` JVM flag set in Layer 3 ensures the SOA trust JKS is used for all these outbound checks. But the trust JKS must contain the CA certificates for every external service the composites call.

### Identifying All Outbound HTTPS Endpoints

Before enforcing TLS 1.2, audit all composite references:

\`\`\`bash
# Find all WSDL and binding files in the SOA composites that reference https://
find \$SOA_HOME/soa/deploy -name "*.wsdl" -o -name "*.jca" | \
    xargs grep -l "https://" 2>/dev/null

# Check Oracle EM composite dashboard for active web service references
# Navigate to: SOA → soa-infra → Composites → [composite] → Component Metrics → References
\`\`\`

For each HTTPS endpoint found:
\`\`\`bash
# Retrieve the remote server's CA certificate
echo | openssl s_client -connect external-partner.com:443 -showcerts 2>/dev/null | \
    awk '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/' | \
    csplit -z - '/-----BEGIN CERTIFICATE-----/' '{*}' 2>/dev/null

# Import each intermediate and root CA into the SOA trust JKS
keytool -importcert -keystore /u01/oracle/keystores/soa-trust.jks \
    -storepass TrustStore1 -alias external-partner-ca \
    -file external-partner-ca.pem -noprompt
\`\`\`

### Enforcing TLS 1.2 on Outbound Composite Calls

The JVM \`jdk.tls.disabledAlgorithms\` flag (Layer 3) enforces TLS 1.2 minimum on all outbound connections. This means any external service that only supports TLS 1.0 or 1.1 will fail after TLS 1.2 is enforced. Before rollout, identify all composites that call partners and confirm those partners support TLS 1.2:

\`\`\`bash
# Test each external endpoint for TLS 1.2 support
openssl s_client -connect external-partner.com:443 -tls1_2 </dev/null 2>&1 | \
    grep -E "Protocol|CONNECTED|alert"

# Test that TLS 1.2 is the minimum (check if 1.1 still works on partner side)
openssl s_client -connect external-partner.com:443 -tls1_1 </dev/null 2>&1 | \
    grep -E "Protocol|CONNECTED|alert"
\`\`\`

Partners that only support TLS 1.0 or 1.1 require engagement before SOA Suite TLS 1.2 enforcement.

---

## Layer 7: Oracle Service Bus — Business Service SSL

Oracle Service Bus (OSB) business services proxy outbound calls to external services. Like SOA composite references, OSB business services that call HTTPS endpoints use the JVM truststore configured in Layer 3. However, OSB has an additional SSL configuration layer: each business service can be configured with a specific SSL client keystore for mutual TLS (mTLS) when the external service requires a client certificate.

### OSB Business Service HTTPS Configuration

In the Oracle Service Bus Console (or JDeveloper/OEPE for 12c):

1. Navigate to the business service → Transport → HTTPS
2. Set **SSL Client Authentication**: \`None\` (server-cert only), \`One-Way SSL\` (default), or \`Two-Way SSL\` (mTLS)
3. For Two-Way SSL: specify the **Client Keystore** and **Client Key Alias** — these reference a Java KeyStore configured in WebLogic's Keystore Service or a file path
4. Set **Cipher Suite**: leave default (uses JVM \`jdk.tls.disabledAlgorithms\`) or specify explicit suites

OSB business services that use One-Way SSL rely entirely on the SOA trust JKS (via Layer 3 \`javax.net.ssl.trustStore\` flag) to verify the remote server certificate. No additional OSB-level configuration is needed for standard TLS 1.2 enforcement once the JVM flag is set.

For Two-Way SSL OSB business services, ensure the client certificate keystore is updated before TLS 1.2 enforcement if those keystores contain certificates signed with SHA-1 (which may be blocked by TLS 1.2-only policies on the remote end).

### OSB Proxy Service Inbound SSL

OSB proxy services that receive inbound HTTPS calls use the WebLogic SSL listener configured in Layer 2. The \`MinimumTLSProtocolVersion('TLSv1.2')\` WLST setting on \`osb_server1\` applies to all inbound proxy service HTTPS endpoints.

---

## Layer 8: Oracle WSM — Policy Store and Keystore Service

Oracle Web Services Manager (OWSM) enforces web service security policies — WS-Security message-level encryption, SAML token assertion, username token validation. OWSM operates at the message layer above TLS. However, OWSM's policy store and the Keystore Service (KSS) interact with TLS at several points:

**Policy Store Database Connection**: OWSM reads policies from the MDS schema in Oracle Database. This connection uses the same SOA DataSource TCPS configuration from Layer 4 (\`jdbc/mds-owsm\`).

**OWSM Keystore Service (KSS)**: KSS manages the certificates used by OWSM for message-level signing and encryption (separate from TLS certificates). KSS is accessed via WebLogic's OPSS framework, which uses the WebLogic SSL channel (Layer 2). No additional TLS configuration is needed for KSS beyond what Layer 2 and Layer 3 provide.

**OWSM Agent Interceptors**: OWSM agents intercept SOAP messages at the WebLogic policy enforcement point. The TLS session is already terminated by WebLogic before OWSM processes the message — OWSM operates on the decrypted SOAP payload. OWSM TLS compliance is therefore satisfied by the WebLogic-layer (Layers 2 and 3) configuration.

The main OWSM action required for TLS 1.2 enforcement is confirming that the OWSM SOAP call-out policies (policies that make outbound service calls as part of policy enforcement) use HTTPS references that are covered by the SOA trust JKS.

---

## Rollout Sequence

The inside-out sequence prevents outer components from enforcing TLS 1.2 against inner components that are not yet ready.

**Step 1 — Database TCPS**
Configure TCPS on the Oracle Database listener. Update all SOA Suite JDBC DataSources to use TCPS URLs. Test each DataSource connection from the WebLogic Admin Console (DataSources → Test). This is transparent to upper layers — SOA composites continue to work normally.

**Step 2 — LDAPS Identity Store**
Switch the WebLogic LDAP authentication provider to port 636 with SSL enabled. Import LDAP CA into the SOA trust JKS. Restart \`soa_server1\` and \`osb_server1\`. Test human workflow task assignment and OSB security policies that require LDAP group lookup.

**Step 3 — WebLogic SSL Listeners**
Enable SSL on \`soa_server1\`, \`osb_server1\`, and Admin Server. Set \`MinimumTLSProtocolVersion('TLSv1.2')\` on each. Restart the domain. Test SOAP calls directly to port 8002. Test OSB proxy services directly on port 7005.

**Step 4 — JVM TLS Enforcement and Trust JKS**
Add \`jdk.tls.disabledAlgorithms\` and \`javax.net.ssl.trustStore\` to \`setDomainEnv.sh\`. Restart the full domain. Test all composite outbound HTTPS call-outs. Identify any that fail due to untrusted CA or TLS version mismatch on the partner side.

**Step 5 — OHS ssl.conf TLS 1.2 and WebLogic HTTPS Backend**
Update \`ssl.conf\` with \`SSLProtocol -ALL +TLSv1.2\`. Switch mod_wl_ohs Location blocks to \`WebLogicSSLPort\`. Restart OHS. Test browser access to EM, SOA Composer, and OSB Console. Test SOAP client calls through the HTTPS endpoint.

**Step 6 — Disable Plain HTTP on WebLogic**
Once OHS–WebLogic HTTPS proxy is confirmed working, disable plain HTTP listeners on \`soa_server1\` and \`osb_server1\`. Verify no monitoring, load balancer health checks, or internal service calls use port 8001 or 7004 directly.

**Step 7 — Partner Notification**
For any partner or application that calls SOA Suite HTTPS endpoints directly (bypassing OHS, using WebLogic URLs), notify them of the TLS 1.2 requirement and coordinate the cutover.

---

## Testing Each Layer

\`\`\`bash
# Layer 1: OHS TLS 1.2 enforcement
openssl s_client -connect soa.company.com:443 -tls1_2 </dev/null 2>&1 | grep -E "Protocol|CONNECTED"
openssl s_client -connect soa.company.com:443 -tls1_1 </dev/null 2>&1 | grep -E "alert|failure"

# Layer 2: WebLogic soa_server1 SSL direct
openssl s_client -connect soa_server1.company.com:8002 -tls1_2 </dev/null 2>&1 | grep -E "Protocol|Cipher|CONNECTED"
openssl s_client -connect soa_server1.company.com:8002 -tls1_1 </dev/null 2>&1 | grep -E "alert|failure"

# Layer 2: WebLogic osb_server1 SSL direct
openssl s_client -connect osb_server1.company.com:7005 -tls1_2 </dev/null 2>&1 | grep -E "Protocol|Cipher|CONNECTED"

# Layer 4: SOA DataSource TCPS connectivity
# Test from WebLogic Admin Console: DataSources → SOADataSource → Monitoring → Test
# Or from command line — confirm TCPS port is open:
nc -zv db-server.company.com 1522 && echo "TCPS port open"

# Layer 5: LDAPS
ldapsearch -H ldaps://oid-server.company.com:636 \
    -D "cn=orcladmin" -w password \
    -b "dc=company,dc=com" "(uid=testuser)" uid

# Layer 6: SOA composite outbound HTTPS test
# Deploy a test composite with an HTTPS reference and invoke it
# Check soa_server1 log for SSLHandshakeException if CA trust is missing:
grep -i "PKIX\|SSLHandshake\|CertPath" \
    \$DOMAIN_HOME/servers/soa_server1/logs/soa_server1.log | tail -20

# End-to-end SOA SOAP call via OHS
curl -s -o /dev/null -w "%{http_code}\n" \
    --tls-max 1.2 \
    -H "Content-Type: text/xml" \
    -d '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body/></soapenv:Envelope>' \
    https://soa.company.com/soa-infra/services/default/HelloWorld/client
\`\`\`

---

## Common Failures in SOA Suite TLS 1.2 Enforcement

| Symptom | Root Cause | Fix |
|---|---|---|
| SOA composite fault: \`SSLHandshakeException: PKIX path building failed\` | External HTTPS endpoint CA not in SOA trust JKS | Import the external partner's CA certificate chain into \`soa-trust.jks\`; restart \`soa_server1\` |
| OHS returns 503 for /soa-infra after switching to WebLogicSSLPort | OHS wallet missing WebLogic CA cert; TLS handshake to \`soa_server1\` fails | \`orapki wallet add -wallet ... -cert wls-ca.pem -trusted_cert\`; restart OHS |
| Human workflow task assignment fails after LDAPS switch | SOA trust JKS missing OID CA cert | Import OID CA: \`keytool -importcert -keystore soa-trust.jks ... -file oid-ca.pem\` |
| \`SOADataSource\` connection test fails after TCPS switch | JDBC TCPS URL incorrect or DB wallet not configured | Verify TCPS listener on port 1522 with \`lsnrctl status\`; re-check JDBC URL syntax |
| OSB business service fails: \`SSL peer shut down incorrectly\` | External service called by OSB does not support TLS 1.2 | Check partner TLS capability with \`openssl s_client -tls1_2\`; request partner TLS 1.2 upgrade |
| EM Console 503 after OHS TLS 1.2 | \`/em\` Location block not updated to use \`WebLogicSSLPort\` | Add \`WebLogicSSLPort 8002\` and \`WLSSLWallet\` to the \`/em\` Location block in ssl.conf |
| SOA Admin Console login fails after LDAPS: no users found | LDAP group membership attribute mismatch — OWSM group-to-role mapping uses LDAP attribute that changed on LDAPS switch | Verify \`GroupMembershipSearching\` and \`MemberDNAttribute\` in the WebLogic LDAP authenticator settings |
| \`javax.net.ssl.SSLException: Received fatal alert: protocol_version\` in MDS connection | \`mds-owsm\` DataSource TCPS not updated; still using TCP while DB enforces TLS 1.2 | Update all MDS DataSources to TCPS URL alongside SOADataSource |

---

## Certificate Expiry Monitoring

| Certificate | Location | Impact if Expired |
|---|---|---|
| OHS server cert | OHS Oracle Wallet | All inbound SOAP/REST calls fail immediately |
| \`soa_server1\` SSL cert | \`soa-identity.jks\` | OHS–WebLogic proxy fails; 503 on all SOA endpoints |
| \`osb_server1\` SSL cert | \`soa-identity.jks\` | Same; OSB proxy services become unavailable |
| SOA DB TCPS cert | DB Oracle Wallet | All DataSource connections fail; SOA Infrastructure shuts down |
| OID LDAP cert | OID wallet | LDAP auth fails; human workflow and OSB security break |
| External partner certs (in trust JKS) | \`soa-trust.jks\` CA entries | Outbound composite calls to that partner fail |

\`\`\`bash
#!/bin/bash
# soa_cert_expiry_check.sh

WARN_DAYS=90; CRIT_DAYS=30; EMAIL="dba-team@company.com"
HOSTNAME=\$(hostname -f)

check_ssl() {
    local host=\$1 port=\$2 label=\$3
    local expiry days_left
    expiry=\$(echo | openssl s_client -connect "\${host}:\${port}" \
        -servername "\${host}" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
    [ -z "\$expiry" ] && { echo "UNKNOWN [\$label] \${host}:\${port} unreachable"; return; }
    days_left=\$(( ( \$(date -d "\$expiry" +%s) - \$(date +%s) ) / 86400 ))
    if [ \$days_left -le \$CRIT_DAYS ]; then
        echo "CRITICAL [\$label] expires \${days_left}d (\$expiry)" | \
            mail -s "SOA Cert CRITICAL: \${label} on \${HOSTNAME}" \$EMAIL
    elif [ \$days_left -le \$WARN_DAYS ]; then
        echo "WARNING  [\$label] expires \${days_left}d (\$expiry)" | \
            mail -s "SOA Cert WARNING: \${label} on \${HOSTNAME}" \$EMAIL
    else
        echo "OK       [\$label] expires \${days_left}d"
    fi
}

check_ssl "soa.company.com"         "443"  "OHS-SOA"
check_ssl "soa_server1.company.com" "8002" "WLS-soa_server1"
check_ssl "osb_server1.company.com" "7005" "WLS-osb_server1"
check_ssl "oid-server.company.com"  "636"  "OID-LDAPS"
echo "SOA cert check complete on \${HOSTNAME}"
\`\`\`

\`\`\`
0 6 * * * /u01/oracle/scripts/soa_cert_expiry_check.sh >> /u01/oracle/logs/cert_check.log 2>&1
\`\`\`

---

## Conclusion

TLS 1.2 enforcement across SOA Suite 12c is architecturally similar to other Oracle Fusion Middleware stacks — OHS Oracle Wallet, WebLogic JKS keystores, JVM JSSE flags — but the SOA-specific complexity lies in the outbound dimension. SOA composites and OSB business services are active TLS clients: they initiate HTTPS connections to external services, and every one of those connections must trust the remote server's certificate and negotiate TLS 1.2. The \`javax.net.ssl.trustStore\` JVM property in \`setDomainEnv.sh\` propagates the SOA trust JKS to all JSSE channels simultaneously, making it the single most important configuration change for outbound composite HTTPS compliance. The trust JKS itself is a living document — it must be updated whenever a new external HTTPS partner is onboarded — and its certificate expiry monitoring must cover the CA entries, not just the server certificates. With the inside-out rollout sequence and a thorough pre-flight audit of all composite outbound HTTPS endpoints, TLS 1.2 can be enforced across the full SOA Suite topology without composite downtime.`,
};

async function main() {
  console.log('Inserting SOA TLS topology post...');
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
