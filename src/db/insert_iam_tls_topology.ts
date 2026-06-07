import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Implementing TLS 1.2 Across the Oracle Identity Management Topology: OAM, OIM, OID, OIF, and ODSM',
  slug: 'oracle-iam-tls-1-2-implementation-topology',
  excerpt:
    'A comprehensive guide to enforcing TLS 1.2 across the full Oracle Identity Management stack: every communication channel between OAM, OIM, OID/OUD, OIF, ODSM, and their WebLogic domains. Covers OHS Oracle Wallet, WebLogic JKS configuration, LDAPS for identity stores, OAP channel security, SAML over HTTPS, certificate store types per component, rollout sequencing, and validation commands.',
  category: 'identity-management' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-07'),
  youtubeUrl: null,
  content: `## Introduction

The Oracle Identity Management (IAM) topology is one of the most communication-dense environments in an Oracle middleware deployment. At any given moment, a single user authentication event traverses at minimum four distinct TLS-capable channels: the browser connects to Oracle HTTP Server over HTTPS, OAM's WebGate queries the OAM Managed Server over the Oracle Access Protocol, OAM resolves the user's identity against OID or OUD over LDAP, and the SAML assertion — if the session is federated — travels to the Service Provider over HTTPS. Each of those channels has its own certificate store, its own TLS configuration, and its own failure mode when TLS 1.2 is enforced before all participants are ready.

Enforcing TLS 1.2 (and disabling SSL 3.0, TLS 1.0, TLS 1.1) across the full IAM stack is not a single-step change. It requires coordinated configuration at the OHS tier, inside each WebLogic domain (OAM, OIM, OIF), at the LDAP tier (OID/OUD), at the replication layer, at the database connection layer (OIM → DB, OID → ODS DB), and at every external integration boundary (SAML partners, Active Directory LDAPS, EBS TCPS). Miss one channel and the system either silently downgrades to TLS 1.0 — defeating the purpose of the exercise — or breaks entirely with cryptic connection errors.

This post maps every communication channel in the Oracle IAM topology, identifies the certificate store and TLS configuration mechanism for each channel, and describes the correct rollout sequence to enforce TLS 1.2 without causing outages.

---

## The IAM Communication Map

Before configuring anything, map every channel. A production Oracle IAM topology has these distinct TLS-capable paths:

\`\`\`
Browser
  │  HTTPS (OHS port 443)       ← OHS Oracle Wallet + mod_ossl
  ▼
Oracle HTTP Server (OHS) + WebGate
  │  OAP (port 5575)            ← OAP SSL with shared secret
  ▼
OAM Managed Server (WebLogic)
  │  LDAPS (OID port 636        ← WebLogic JSSE + JKS truststore
  │         OUD port 1636)
  ▼
OID / OUD (LDAP Directory)
  │  OID-to-OID replication     ← OID replication over SSL
  │  (port 636 or custom)
  ▼
ODS Oracle Database (OID backend)
  │  TCPS (port 2484)           ← OID Oracle Wallet + sqlnet.ora

OIM Managed Server (WebLogic)
  │  LDAPS → OID/OUD            ← WebLogic JSSE + JKS truststore
  │  TCPS → OIM Oracle DB       ← JDBC thin with javax.net.ssl
  │  HTTPS → EBS (connector)    ← WebLogic outbound SSL
  │  LDAPS → Active Directory   ← WebLogic JSSE + JKS truststore

OIF Managed Server (WebLogic)
  │  LDAPS → OID/OUD            ← WebLogic JSSE + JKS truststore
  │  HTTPS → SAML partners      ← WebLogic outbound SSL / OHS
  │  HTTPS ← SAML partners      ← OHS Oracle Wallet (inbound)

ODSM (WebLogic Admin Server)
  │  LDAPS → OID/OUD            ← WebLogic JSSE + JKS truststore
  │  HTTPS (admin console)      ← WebLogic SSL listen port

OAM ↔ OIM (same domain or cross-domain)
  │  t3s / IIOPS                ← WebLogic SSL channel
\`\`\`

Each arrow is a separate TLS configuration. They use different certificate stores (Oracle Wallet vs JKS), different configuration files (ssl.conf vs config.xml vs sqlnet.ora), and different tooling (orapki vs keytool vs WLST).

---

## Certificate Store Types in the IAM Stack

Understanding which component uses which certificate store is the foundation of IAM TLS planning.

### Oracle Wallet (ewallet.p12 + cwallet.sso)

Used by: Oracle HTTP Server (mod_ossl), Oracle Internet Directory (LDAPS listener), OID replication, TCPS database connections.

Oracle Wallet stores the server private key, server certificate, and trusted CA certificates in PKCS12 format. The \`orapki\` utility manages wallet contents. Auto-login wallets (\`cwallet.sso\`) allow the process to open the wallet without a password at startup.

Key principle: **every Oracle Wallet must contain the complete CA chain** — root CA, all intermediate CAs, then the server certificate. Add trusted CAs first with \`-trusted_cert\`, server cert last with \`-user_cert\`.

### Java KeyStore (JKS / PKCS12)

Used by: WebLogic Server SSL (OAM, OIM, OIF, ODSM Admin Server, all Managed Servers).

WebLogic uses JKS or PKCS12 keystores for its SSL identity (server certificate + private key) and a separate truststore for trusted CA certificates. The \`keytool\` utility manages JKS contents. WebLogic 12.2.1.4 supports both JKS and PKCS12 — PKCS12 is preferred for new deployments.

Key principle: **the WebLogic truststore must include the CA that signed every certificate WebLogic connects to** — OID/OUD LDAPS CA, OIM database TCPS CA, any external HTTPS endpoint. Missing CA in the truststore produces \`javax.net.ssl.SSLHandshakeException: PKIX path building failed\`.

### Java Default Truststore (\$JAVA_HOME/jre/lib/security/cacerts)

WebLogic uses JSSE, which by default falls back to the JDK's cacerts truststore for connections that don't specify an explicit truststore. Public CA certificates (DigiCert, Sectigo, GlobalSign) are typically already in cacerts. Internal CA or self-signed certificates must be added explicitly to either the WebLogic truststore or cacerts.

### sqlnet.ora + Oracle Wallet (Database TCPS)

Used by: OID connecting to its ODS Oracle Database over TCPS, OIM connecting to its repository database over TCPS.

JDBC thin driver uses \`javax.net.ssl\` for TCPS connections. The wallet path and SSL version are specified in sqlnet.ora or as JDBC connection properties.

---

## Layer 1: OHS / Oracle HTTP Server — Inbound HTTPS

This is the public face of the IAM deployment — the channel browsers use. All IAM admin consoles (OAM Admin Console at /oamconsole, OIM Self-Service at /oim, OIF at /fed), WebGate-protected applications, and SAML ACS endpoints are reached through OHS.

**TLS 1.2 enforcement in ssl.conf**:
\`\`\`apache
SSLProtocol -ALL +TLSv1.2
SSLCipherSuite ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384
SSLWallet "\${ORACLE_INSTANCE}/certs/ohs"
Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"
\`\`\`

OHS uses mod_ossl, not OpenSSL's mod_ssl. The \`SSLProtocol\` and \`SSLCipherSuite\` directives have the same semantics as Apache but work through Oracle's SSL implementation. Oracle Wallet at the SSLWallet path must be auto-login format.

**AutoConfig risk**: In EBS-integrated deployments, OHS ssl.conf is regenerated by AutoConfig on every patch run. The TLS 1.2 directives must be in the AutoConfig template, not just the generated ssl.conf, or they will be overwritten. See the EBS TLS runbook for the template path.

---

## Layer 2: WebGate → OAM Server (OAP Channel)

The Oracle Access Protocol (OAP) channel between WebGate and OAM Managed Server can be configured in three security modes:

- **Open**: No encryption. Acceptable only in isolated private networks.
- **Simple**: Certificate-based encryption without mutual authentication. OAM sends its certificate to WebGate; WebGate encrypts traffic to OAM.
- **Cert**: Mutual TLS — both OAM and WebGate present certificates. Highest security; required for PCI-DSS environments.

**Configure OAP in Cert mode** (recommended for TLS 1.2 compliance):

In OAM Admin Console → System Configuration → Access Manager Settings:
- Communication Mode: **Cert**
- Set the OAM Server certificate in the OAM keystore
- Set the WebGate certificate in the WebGate configuration

The OAP channel uses port 5575. WebGate's \`ObAccessClient.xml\` contains the security mode and certificate reference. After switching to Cert mode, all WebGate agents must have their configuration refreshed from OAM.

**TLS version on the OAP channel** is controlled by the JVM's JSSE configuration on the OAM Managed Server side and the Oracle SSL library on the WebGate/OHS side. Adding \`-Djdk.tls.disabledAlgorithms=SSLv3,TLSv1,TLSv1.1\` to the OAM Managed Server JVM startup arguments (in \`setDomainEnv.sh\`) enforces TLS 1.2 minimum on all JSSE channels from that JVM, including OAP.

---

## Layer 3: WebLogic SSL Configuration (All IAM Domains)

Every WebLogic domain in the IAM stack — OAM, OIM, OIF, ODSM — has its own SSL configuration. The configuration applies to:
- Inbound HTTPS/t3s connections to Admin Server and Managed Servers
- Outbound SSL connections initiated by WebLogic (LDAPS, HTTPS to external systems)

**Minimum TLS version via WLST**:
\`\`\`python
connect('weblogic', '<password>', 't3://server:7001')
for server_name in ['AdminServer', 'oam_server1', 'oim_server1', 'oif_server1']:
    cd('/Servers/' + server_name + '/SSL/' + server_name)
    set('MinimumTLSProtocolVersion', 'TLSv1.2')
    print('Set TLS 1.2 on:', server_name)
updateDomain()
\`\`\`

**JVM-level enforcement** (stronger — applies to all JSSE connections, not just WebLogic's SSL channels):

In \`\${DOMAIN_HOME}/bin/setDomainEnv.sh\`, add to \`JAVA_OPTIONS\`:
\`\`\`bash
JAVA_OPTIONS="\${JAVA_OPTIONS} -Djdk.tls.disabledAlgorithms=SSLv3,TLSv1,TLSv1.1,RC4,DES,MD5withRSA,DH keySize < 1024"
\`\`\`

This JVM property disables the specified algorithms at the JSSE layer — WebLogic cannot negotiate them even if a connecting client requests them. It is the most reliable enforcement mechanism because it applies to all SSL contexts within the JVM, including WebLogic's outbound LDAPS connections to OID/OUD, OIM's database TCPS connections, and OIF's outbound HTTPS calls to federation partners.

**WebLogic identity and trust keystores**: Each WebLogic domain needs a signed certificate for its SSL identity. Configure in Admin Console or via WLST:
\`\`\`python
cd('/Servers/oam_server1')
set('KeyStores', 'CustomIdentityAndCustomTrust')
set('CustomIdentityKeyStoreFileName', '/u01/keystores/oam_identity.jks')
set('CustomIdentityKeyStorePassPhrase', '<identity_keystore_password>')
set('CustomIdentityAlias', 'oam-server')
set('CustomIdentityPrivateKeyPassPhrase', '<private_key_password>')
set('CustomTrustKeyStoreFileName', '/u01/keystores/trust.jks')
set('CustomTrustKeyStorePassPhrase', '<trust_keystore_password>')
\`\`\`

---

## Layer 4: OID/OUD LDAPS — Identity Store Connections

OAM, OIM, OIF, and ODSM all connect to OID or OUD over LDAP to read user attributes and validate credentials. In a TLS 1.2 environment, all these connections must use LDAPS (port 636 for OID, port 1636 for OUD) rather than cleartext LDAP.

### Enabling LDAPS on OID

OID's LDAPS listener is configured with an Oracle Wallet containing the OID server certificate:

\`\`\`bash
# Enable SSL port on OID (port 636)
ldapmodify -h oid-host -p 389 -D "cn=orcladmin" -w <password> <<'LDIF_EOF'
dn: cn=oid1,cn=osdldapd,cn=subconfigsubentry
changetype: modify
replace: orclsslport
orclsslport: 636
-
replace: orclsslenable
orclsslenable: 1
-
replace: orclsslversion
orclsslversion: 33
LDIF_EOF
# orclsslversion 33 = TLS 1.2 only (Oracle SSL version flag)
\`\`\`

The OID server wallet at \`\${ORACLE_HOME}/ldap/security\` must contain the OID server certificate and trusted CA chain.

**TLS 1.2 enforcement in OID**: The \`orclsslversion\` attribute controls SSL/TLS version. Values: 4 = SSL3, 8 = TLS1.0, 16 = TLS1.1, 32 = TLS1.2. Set to 33 (32+1, which means TLS 1.2 + SSLv3 flags — in practice, Oracle's SSL layer interprets 32 as TLS 1.2 minimum). Verify with \`openssl s_client -connect oid-host:636 -tls1_2\`.

### Enabling LDAPS on OUD

OUD's LDAPS listener is configured via the dsconfig utility:
\`\`\`bash
\${OUD_HOME}/bin/dsconfig set-connection-handler-prop \
  --handler-name "LDAPS Connection Handler" \
  --set enabled:true \
  --set listen-port:1636 \
  --set ssl-cert-nickname:oud-server \
  --hostname oud-host \
  --port 4444 \
  --bindDN "cn=Directory Manager" \
  --bindPassword <password> \
  --trustAll --no-prompt

# Set minimum SSL/TLS protocol
\${OUD_HOME}/bin/dsconfig set-crypto-manager-prop \
  --set ssl-protocol:TLSv1.2 \
  --hostname oud-host --port 4444 \
  --bindDN "cn=Directory Manager" \
  --bindPassword <password> \
  --trustAll --no-prompt
\`\`\`

### Configuring OAM to Use LDAPS

In OAM Admin Console → Identity Stores → [OID/OUD store] → Edit:
- Change LDAP URL from \`ldap://oid-host:389\` to \`ldaps://oid-host:636\`
- Enable SSL
- Import the OID CA certificate into the OAM WebLogic domain's trust JKS

The OAM WebLogic truststore must contain the CA that signed the OID/OUD LDAPS certificate — if OID uses a corporate PKI CA, add that CA's certificate to the OAM trust JKS:
\`\`\`bash
keytool -import -alias oid-ca \
  -file /tmp/corporate-ca.crt \
  -keystore /u01/keystores/trust.jks \
  -storepass <truststore_password> -noprompt
\`\`\`

This same trust JKS update is required for OIM, OIF, and ODSM — each must explicitly trust the LDAP CA.

---

## Layer 5: OID Replication over SSL

In fan-out and multi-master OID topologies, the oidrepld replication server communicates between OID nodes. Configure replication to use SSL:

\`\`\`bash
# Configure OID replication to use SSL port
ldapmodify -h oid-host -p 389 -D "cn=orcladmin" -w <password> <<'LDIF_EOF'
dn: orclreplicaid=oid-replica-1,cn=replication configuration
changetype: modify
replace: orclreplicaport
orclreplicaport: 636
-
replace: orclreplicausessl
orclreplicausessl: 1
LDIF_EOF
\`\`\`

Both the master and replica OID nodes must have their LDAPS listeners enabled and their Oracle Wallets contain each other's CA certificate (for mutual trust).

---

## Layer 6: OID → ODS Database (TCPS)

OID stores its data in Oracle Database (ODS schema). If the database is configured for TCPS, OID must connect over TCPS. The connection is configured in \`\${ORACLE_HOME}/network/admin/sqlnet.ora\`:

\`\`\`ini
SSL_VERSION = 1.2
SSL_CIPHER_SUITES = (SSL_RSA_WITH_AES_256_CBC_SHA256)
WALLET_LOCATION =
  (SOURCE =
    (METHOD = FILE)
    (METHOD_DATA =
      (DIRECTORY = \${ORACLE_HOME}/ldap/security)))
\`\`\`

The OID process wallet (at the WALLET_LOCATION above) must contain the database server's CA certificate as a trusted cert. OID uses this wallet for both its LDAPS listener (server cert) and its outbound TCPS database connection (client trust).

OIM's connection to its repository database follows the same pattern, using JDBC connection properties:
\`\`\`
javax.net.ssl.trustStore=/u01/keystores/trust.jks
javax.net.ssl.trustStorePassword=<password>
oracle.net.ssl_version=TLSv1.2
oracle.net.ssl_cipher_suites=(SSL_RSA_WITH_AES_256_CBC_SHA256)
\`\`\`

These are set as JDBC DataSource connection properties in WebLogic Console → Services → Data Sources → [OIM datasource] → Connection Pool → Properties.

---

## Layer 7: OIF — SAML over HTTPS and Partner Connections

OIF's SAML federation operates entirely over HTTPS:
- Inbound AuthnRequests from SP partners arrive over HTTPS (handled by OHS)
- Outbound SAML Responses to SP ACS URLs are HTTP-POST via browser redirect — TLS of the SP's ACS URL is the SP's responsibility
- OIF's own SSO and SLO endpoints are served by OHS (Layer 1 configuration covers this)
- OIF as SP: outbound requests to external IdP SSO URLs are HTTPS — controlled by WebLogic outbound SSL (Layer 3)

OIF's SAML metadata endpoint (\`/fed/idp/metadata\`) is served by OHS over HTTPS. Partners access OIF metadata over TLS 1.2 automatically once OHS is configured.

**Federation partner certificates**: OIF stores each partner's SAML signing certificate in its metadata database. These are X.509 certificates used to verify assertion signatures — they are not part of the TLS channel but are referenced at the SAML layer. Certificate expiry monitoring for partner certificates is separate from TLS certificate monitoring.

For OIF's OAuth 2.0 / OIDC endpoints: all token endpoints, authorisation endpoints, and userinfo endpoints are served through OHS. TLS 1.2 enforcement at OHS (Layer 1) covers all of these.

---

## Layer 8: OIM Connector Outbound Connections

OIM's ICF connectors make outbound connections to target systems. Each connector uses the target system's protocol:

- **OUD/OID connector**: LDAPS (port 636/1636) — add OUD/OID CA to OIM's WebLogic trust JKS
- **Active Directory connector**: LDAPS (port 636) — add AD CA to OIM's trust JKS
- **Oracle EBS connector**: JDBC TCPS (port 2484) if EBS DB is TCPS-enabled — add EBS DB CA to OIM's trust JKS
- **Salesforce / ServiceNow cloud connectors**: HTTPS (public CA — already in JDK cacerts)

The OIM WebLogic trust JKS (\`/u01/keystores/trust.jks\`) must accumulate the CA certificates for every LDAPS/TCPS endpoint OIM connects to. This is a single trust JKS shared across all connectors in the OIM domain.

---

## Rollout Sequence: Avoiding Outages

The correct sequence for enforcing TLS 1.2 across the IAM topology is bottom-up — start at the inner tiers (database, LDAP) and work outward (WebLogic, OHS). Reversing the order breaks outer components before inner components are ready.

### Recommended Sequence

**Step 1: Certificate preparation (no downtime)**
- Generate CSRs and obtain signed certificates for OHS, each WebLogic domain (OAM, OIM, OIF), OID LDAPS, and the database TCPS listener
- Build Oracle Wallets and JKS keystores with full CA chains
- Validate all certificates: \`openssl verify -CAfile chain.pem server.crt\`

**Step 2: Enable LDAPS on OID/OUD (no existing connection interruption)**
- Add SSL port 636/1636 listener to OID/OUD (they continue serving plain LDAP on 389/1389)
- Test: \`openssl s_client -connect oid-host:636 -tls1_2\` must succeed

**Step 3: Update OAM, OIM, OIF, ODSM trust JKS (no restart yet)**
- Add OID/OUD CA to each domain's trust JKS
- Add database TCPS CA if applicable

**Step 4: Switch OAM, OIM, OIF LDAP connections to LDAPS (rolling restart)**
- Update each domain's identity store configuration URL from ldap:// to ldaps://
- Restart each Managed Server in turn
- Test authentication works after each restart before proceeding

**Step 5: Enforce TLS 1.2 minimum on WebLogic domains (rolling restart)**
- Add JVM \`-Djdk.tls.disabledAlgorithms\` to each domain's setDomainEnv.sh
- Set \`MinimumTLSProtocolVersion=TLSv1.2\` via WLST on all servers
- Restart Managed Servers in turn (Admin Server last)

**Step 6: Update OHS ssl.conf for TLS 1.2 enforcement (OHS restart)**
- Update SSLProtocol and SSLCipherSuite directives
- Update AutoConfig template to persist the change
- Restart OHS: \`opmnctl stopall && opmnctl startall\`
- Test: \`openssl s_client -connect ohs-host:443 -tls1_2\` and \`openssl s_client -connect ohs-host:443 -tls1\` (latter should fail)

**Step 7: Disable plain LDAP on OID/OUD (optional, high-security)**
- After confirming all components use LDAPS, disable the plain LDAP listener on 389/1389
- This is optional — many organisations keep LDAP available for internal monitoring tools
- Risk: any monitoring script, Nagios check, or integration that uses ldapsearch on port 389 breaks

**Step 8: Enable TCPS on database connections (if required)**
- Enable OID → ODS database TCPS
- Enable OIM → OIM database TCPS
- Requires coordinated database listener configuration change

---

## Testing TLS 1.2 at Each Layer

\`\`\`bash
# OHS/HTTPS — TLS 1.2 works, TLS 1.0 rejected
openssl s_client -connect ohs-host:443 -tls1_2 </dev/null 2>&1 | grep "Protocol"
openssl s_client -connect ohs-host:443 -tls1 </dev/null 2>&1 | grep -E "handshake|alert|error"

# OID LDAPS — TLS 1.2
openssl s_client -connect oid-host:636 -tls1_2 </dev/null 2>&1 | grep "Protocol"
ldapsearch -H ldaps://oid-host:636 -D "cn=orcladmin" -w <password> \
  -b "" -s base "(objectClass=*)" vendorName 2>&1

# OUD LDAPS — TLS 1.2
openssl s_client -connect oud-host:1636 -tls1_2 </dev/null 2>&1 | grep "Protocol"
ldapsearch -H ldaps://oud-host:1636 -D "cn=Directory Manager" -w <password> \
  -b "" -s base "(objectClass=*)" vendorName 2>&1

# WebLogic HTTPS — TLS 1.2
openssl s_client -connect oam-server:7002 -tls1_2 </dev/null 2>&1 | grep "Protocol"
curl -sk --tls-max 1.1 https://oam-server:7002/oamconsole 2>&1 | head -3
# TLS 1.1 and below should fail

# OAM login end-to-end (tests OAM → OID LDAPS chain)
curl -sk -D - https://ohs-host:443/oamconsole | grep -E "HTTP|Location"

# OIF SAML metadata endpoint
curl -sk https://ohs-host:443/fed/idp/metadata | grep "entityID"
openssl s_client -connect ohs-host:443 -tls1_2 </dev/null 2>&1 | \
  grep -E "Protocol|Cipher|Verify"
\`\`\`

---

## Common Cross-Component Failures

**OAM authentication fails after enabling LDAPS on OID**: The OAM WebLogic trust JKS does not contain the CA that signed the OID LDAPS certificate. Symptom: \`javax.net.ssl.SSLHandshakeException: PKIX path building failed\` in the OAM server log. Fix: import the OID CA into the OAM trust JKS and restart OAM.

**OIM provisioning fails after LDAPS switch**: Same root cause as above but in the OIM domain. Check OIM server log for \`SSLHandshakeException\` on the LDAP connection. Fix: add OID/OUD CA to OIM trust JKS.

**OIF SAML assertion validation fails**: OIF as SP is receiving an assertion from an external IdP whose signing certificate was issued by a CA that OIF does not trust. This is not a TLS channel issue but a SAML signature validation issue. Fix: ensure the IdP's CA certificate is in OIF's trust JKS.

**WebGate cannot reach OAM after TLS enforcement**: OAP in Cert mode requires both parties to present valid certificates. If the OAM certificate was renewed but the WebGate's ObAccessClient.xml still references the old certificate, the mutual TLS handshake fails. Fix: re-download the WebGate configuration artifact from OAM (which includes the updated certificate reference) and redeploy to the WebGate OHS host.

**OID replication stops after LDAPS enforcement**: If the replication agreement was updated to use port 636 but the replica's Oracle Wallet does not trust the master's LDAPS certificate (or vice versa), oidrepld cannot establish the replication SSL connection. Fix: ensure both master and replica wallets contain each other's CA as a trusted cert.

**TLS 1.0 still negotiated despite JVM flag**: The \`-Djdk.tls.disabledAlgorithms\` flag was added to setDomainEnv.sh but the Managed Server was restarted before the Admin Server. Admin Server also needs the flag — restarting only Managed Servers does not apply it to Admin Server. Fix: restart Admin Server with the flag, then confirm via \`openssl s_client -connect server:7002 -tls1\` (should fail).

**ODSM cannot browse OID after LDAPS switch**: ODSM's registered server connection still points to port 389. Update the registered connection in ODSM to port 636/ldaps, provide the new LDAPS URL, and import the OID CA into the ODSM WebLogic domain's trust JKS.

---

## Certificate Expiry Across the IAM Stack

With TLS 1.2 enforced across all channels, certificate expiry becomes the dominant operational risk. The IAM stack has more certificates than a typical application deployment:

| Certificate | Location | Typical Validity | Impact of Expiry |
|---|---|---|---|
| OHS public cert | Oracle Wallet | 1–2 years | All user-facing HTTPS broken |
| OAM WebLogic cert | JKS | 1–2 years | OAM Admin Console + OAP broken |
| OIM WebLogic cert | JKS | 1–2 years | OIM Admin Console + LDAPS broken |
| OIF WebLogic cert | JKS | 1–2 years | SAML endpoints broken |
| OID LDAPS cert | Oracle Wallet | 1–2 years | All LDAP authentication broken |
| OUD LDAPS cert | JKS | 1–2 years | All LDAP authentication broken |
| OIF SAML signing cert | OIF metadata | 2–3 years | Federation assertions rejected |
| Partner SAML certs | OIF metadata | Partner-controlled | Inbound federation broken |

Implement a unified certificate expiry monitoring approach that checks all certificate endpoints with a single script, alerting at 90 days (renewal planning), 30 days (escalation), and 7 days (emergency). The script should check \`openssl s_client\` output for OHS and WebLogic HTTPS ports, \`openssl s_client\` for OID/OUD LDAPS ports, and \`keytool -list -v\` for JKS keystores. See the individual OAM, OIM, OID, and OIF runbooks for component-specific certificate monitoring scripts.

---

## Conclusion

Enforcing TLS 1.2 across the Oracle IAM topology is a multi-layer, multi-certificate, multi-tool exercise. The foundation is understanding that each communication channel has its own certificate store type — Oracle Wallet for OHS and OID, JKS for WebLogic — and its own configuration mechanism. The JVM-level \`-Djdk.tls.disabledAlgorithms\` flag in each domain's setDomainEnv.sh is the most reliable mechanism for enforcing TLS 1.2 minimum across all JSSE channels simultaneously. The rollout must proceed bottom-up — LDAP tier first, then WebLogic, then OHS — to avoid breaking outer components before inner components are ready. And post-enforcement, certificate expiry monitoring across all eight or more certificate endpoints in the stack is the operational work that keeps TLS 1.2 working long after the initial implementation.`,
};

async function main() {
  console.log('Inserting IAM TLS topology post...');
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
