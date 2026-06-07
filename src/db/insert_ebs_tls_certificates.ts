import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'TLS 1.2 Certificate Architecture for Oracle E-Business Suite 12.2.9: OHS, WebLogic, and Database Tiers',
  slug: 'oracle-ebs-12-2-tls-certificates-configuration',
  excerpt:
    'A detailed guide to implementing TLS 1.2 across all three tiers of Oracle E-Business Suite 12.2.9: Oracle HTTP Server (OHS) with Oracle Wallet, WebLogic Server with JKS keystores, and the Oracle database listener with TCPS. Covers certificate authority trust chains, cipher suite hardening, HSTS headers, and AutoConfig safety for ssl.conf persistence.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-05'),
  youtubeUrl: null,
  content: `## Introduction

Oracle E-Business Suite 12.2.9 runs on a three-tier architecture — a web entry point handled by Oracle HTTP Server (OHS), an application tier running WebLogic Server (WLS), and a database tier running Oracle Database 19c or later. Securing this stack with TLS 1.2 requires separate configuration at each tier because each tier uses a different certificate store format and a different TLS implementation. OHS uses an Oracle Wallet (ewallet.p12) managed by the orapki utility. WebLogic uses a JKS or PKCS12 keystore managed by Java's keytool. The Oracle Database listener uses TCPS with its own Oracle Wallet for server authentication.

Getting TLS 1.2 right across all three tiers is not simply a matter of flipping a protocol switch. It requires generating CSRs at the correct key strength, importing the full certificate chain in the correct order, configuring ssl.conf with the correct SSLProtocol directive and cipher suites, ensuring AutoConfig does not overwrite your ssl.conf changes on the next run, propagating the CA certificate bundle to WebLogic's truststore, and configuring the database listener and sqlnet.ora for TCPS. Each step has specific failure modes — missing intermediate CA certificates cause chain validation errors at the browser, incorrect cipher ordering degrades to TLS 1.0 on older clients, and AutoConfig overwrites are the most common reason TLS configuration reverts after a patch run.

This post covers the architecture and reasoning behind each configuration step. The companion runbook provides the exact commands.

---

## Three-Tier TLS Architecture

### Oracle HTTP Server (OHS) — The Public Entry Point

OHS 12.1.3 (bundled with EBS 12.2) runs Apache-based SSL through the mod_ossl module, not OpenSSL's mod_ssl. This distinction matters because mod_ossl uses Oracle Wallet as its certificate store rather than PEM files, and its configuration directives — SSLWallet, SSLCertificate, SSLProtocol, SSLCipherSuite — differ from standard Apache mod_ssl syntax.

The OHS layer handles all inbound HTTPS connections from browsers and external systems. It terminates TLS and proxies requests to WebLogic via the WebLogic Plugin (mod_wl_ohs). The trust anchor for this layer is the certificate chain loaded into the Oracle Wallet at \`\${INST_TOP}/certs/ohs/\` — or whatever path is configured in ssl.conf's SSLWallet directive.

For a CA-signed certificate, the Oracle Wallet must contain three items: the server private key, the server certificate, and the full intermediate CA chain. Oracle Wallet validates the chain top-down during TLS handshake. If an intermediate CA certificate is missing, Apache serves a partial chain and modern browsers reject it with ERR_CERT_AUTHORITY_INVALID, even if the root CA is trusted by the OS.

### WebLogic Server — The Application Tier

WebLogic 12.2.1.3 (bundled with EBS 12.2.9) handles requests that OHS forwards via mod_wl_ohs. WLS has its own SSL implementation (the WebLogic SSL stack, not JSSE by default, though JSSE can be configured). It uses JKS or PKCS12 keystores for server identity and a separate truststore for CA certificates.

For EBS deployments, WLS is typically configured with a self-signed certificate or the same CA-signed certificate as OHS. The self-signed configuration is acceptable when OHS is the only system connecting to WLS — browsers never see the WLS certificate directly. However, integration systems that connect directly to WLS HTTPS ports (WebServices, REST APIs, SOA callbacks) will see the WLS certificate and need to trust it.

The critical configuration for WLS is \`keystoretype\`, \`keystore\`, \`keystorepassphrase\`, \`truststoretype\`, \`truststore\`, and \`truststorepassphrase\` in the WLS domain config.xml, plus setting the minimum TLS protocol in the SSL configuration object. WebLogic 12.2.1.3 supports TLS 1.2 by default but may negotiate TLS 1.0 or 1.1 unless explicitly disabled.

### Oracle Database Listener — TCPS

The database tier uses TCPS (TCP with SSL/TLS) for encrypted connections from WLS connection pools, integration systems, and DBAs using SQL*Plus. The database-side configuration involves three files: sqlnet.ora, listener.ora, and the server Oracle Wallet at \`\${ORACLE_HOME}/network/admin/wallet/\`.

TCPS configuration at the database is independent of OHS. A DBA can configure TCPS without touching the EBS web tier. However, when TCPS is enabled, all connection strings that use \`(PROTOCOL=TCP)\` must be updated to \`(PROTOCOL=TCPS)\` or the connection will fail with ORA-12560.

For EBS, the WLS data source connection strings in the domain's config.xml and the EBS JDBC configuration in \`\${APPL_TOP}/admin/\` must all be updated when the database moves from TCP to TCPS.

---

## Certificate Authority Chain Requirements

### Self-Signed vs. CA-Signed

Self-signed certificates work for internal EBS deployments where all clients are under your organisation's control and can import the self-signed root certificate into their browser trust store. They are not acceptable for EBS instances accessed by external users, partner integrations, or any environment subject to PCI-DSS or similar compliance standards.

CA-signed certificates from a public CA (DigiCert, Sectigo, GlobalSign) or a corporate PKI CA eliminate the need to distribute custom trust anchors to clients. The trade-off is cost, renewal process management, and the requirement to generate a CSR with the correct Subject Alternative Names (SANs) — if your EBS URL uses multiple hostnames or IP addresses, each must be listed in the SAN.

### Intermediate CA Certificates

Most public CAs use a two-level hierarchy: Root CA → Intermediate CA → Server Certificate. The Root CA certificate is embedded in browsers and operating systems. The Intermediate CA certificate is not — it must be served by your web server as part of the certificate chain.

Oracle Wallet's orapki utility requires you to add each trusted certificate individually using \`orapki wallet add -trusted_cert\`. The order matters: add the Root CA first, then each Intermediate CA in chain order, then add the server certificate last with \`-user_cert\`. Adding the server certificate before the full chain is present causes orapki to reject it with "the certificate issuer is not in the wallet."

### Key Strength and Algorithm

For TLS 1.2 compliance, server certificates must use RSA 2048-bit or ECDSA 256-bit keys. SHA-1 certificates are rejected by Chrome 57+, Firefox 51+, and Safari 10+ — any certificate signed with SHA-1 must be reissued with SHA-256 before attempting TLS 1.2 configuration.

CSRs generated with OpenSSL should use \`-newkey rsa:2048\` and \`-sha256\`. CSRs generated with orapki use \`orapki wallet add -dn "CN=..." -keysize 2048\` — orapki generates RSA 2048 by default.

---

## OHS ssl.conf Configuration

The OHS TLS configuration lives in \`\${INST_TOP}/ora/10.1.3/Apache/Apache/conf/ssl.conf\` (path varies by EBS installation). The critical directives for TLS 1.2 enforcement are:

**SSLProtocol**: Controls which TLS versions OHS will accept. To enforce TLS 1.2 only:
\`\`\`
SSLProtocol -ALL +TLSv1.2
\`\`\`
This syntax explicitly disables all protocols (\`-ALL\`) then re-enables TLS 1.2. Some hardening guides also add \`+TLSv1.3\` if the OHS version supports it. OHS 12.1.3 with the latest CPU supports TLS 1.2; TLS 1.3 support depends on the Oracle OpenSSL version linked into mod_ossl.

**SSLCipherSuite**: Specifies the cipher suites OHS will offer during the TLS handshake. A hardened TLS 1.2 cipher list:
\`\`\`
SSLCipherSuite ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256
\`\`\`
This list favours ECDHE key exchange (forward secrecy) with AES-GCM authenticated encryption. RC4, DES, 3DES, MD5, and NULL ciphers must not appear. BEAST-vulnerable CBC ciphers (AES-CBC with TLS 1.0) are not an issue when TLS 1.2 is enforced, but should still be deprioritised.

**SSLWallet**: Points OHS to the Oracle Wallet directory:
\`\`\`
SSLWallet "\${INST_TOP}/certs/ohs"
\`\`\`
The wallet must be auto-login format (ewallet.p12 + cwallet.sso) so OHS can open it without a password at startup. Create auto-login with \`orapki wallet create -wallet /path -auto_login\`.

**HSTS Header**: HTTP Strict Transport Security prevents SSL stripping attacks. Add to the VirtualHost block:
\`\`\`
Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"
\`\`\`
HSTS with a 1-year max-age is required for HTTPS preloading and recommended for PCI compliance.

---

## AutoConfig and ssl.conf Persistence

AutoConfig is EBS's mechanism for propagating configuration changes. It reads templates from \`\${AD_TOP}/admin/templates/\` and regenerates configuration files — including ssl.conf — during every AutoConfig run, which happens during patching, cloning, and manual \`adautocfg.sh\` execution.

If you edit ssl.conf directly without updating the AutoConfig template, your TLS 1.2 configuration is overwritten the next time AutoConfig runs. This is the most common reason EBS TLS configurations revert.

The correct approach is to modify the ssl.conf AutoConfig template:
\`\`\`
\${AD_TOP}/admin/templates/ssl.conf_\${CONTEXT_NAME}
\`\`\`
Or, if using the central template:
\`\`\`
\${INST_TOP}/ora/10.1.3/Apache/Apache/conf/ssl.conf
\`\`\`
The template uses AutoConfig context variables (prefixed with \`%\`) that are substituted at generation time. SSLProtocol and SSLCipherSuite directives can be added as static strings since they do not depend on environment-specific values.

After modifying the template, run AutoConfig to verify your changes survive:
\`\`\`bash
\${ADMIN_SCRIPTS_HOME}/adautocfg.sh
\`\`\`
Then inspect the generated ssl.conf to confirm the TLS 1.2 directives are present.

---

## WebLogic TLS 1.2 Configuration

WebLogic 12.2.1.3 negotiates TLS based on the SSL configuration of each network channel. To enforce TLS 1.2 minimum:

1. In the WLS Admin Console, navigate to **Environment → Servers → [server name] → SSL → Advanced**.
2. Set **Minimum TLS Protocol Version** to TLSv1.2.
3. Disable **Use JSSE SSL** only if you need the legacy WebLogic SSL stack — JSSE is recommended for TLS 1.2+ as it picks up JDK cipher updates.

For JKS keystore configuration, the domain config.xml stores keystore paths and types. The keystores themselves are typically located under \`\${WL_HOME}/server/lib/\` or a custom path specified in domain creation.

When replacing certificates in WebLogic:
1. Export the new certificate and key as PKCS12 from your CA.
2. Import into JKS: \`keytool -importkeystore -srckeystore server.p12 -srcstoretype PKCS12 -destkeystore keystore.jks -deststoretype JKS\`
3. Import the CA chain into the truststore: \`keytool -import -alias root-ca -keystore truststore.jks -file root-ca.crt\`
4. Restart WebLogic to pick up the new keystore contents.

---

## Database TCPS Configuration

Enabling TCPS on the Oracle Database listener requires three changes:

**listener.ora** — add a TCPS listener endpoint:
\`\`\`
LISTENER =
  (DESCRIPTION_LIST =
    (DESCRIPTION =
      (ADDRESS = (PROTOCOL = TCP)(HOST = dbhost)(PORT = 1521))
      (ADDRESS = (PROTOCOL = TCPS)(HOST = dbhost)(PORT = 2484))
    )
  )

SSL_CLIENT_AUTHENTICATION = FALSE
WALLET_LOCATION =
  (SOURCE =
    (METHOD = FILE)
    (METHOD_DATA =
      (DIRECTORY = /u01/app/oracle/product/19c/db_1/network/admin/wallet)))
\`\`\`

**sqlnet.ora** — configure SSL parameters:
\`\`\`
SSL_VERSION = 1.2
SSL_CIPHER_SUITES = (SSL_RSA_WITH_AES_256_CBC_SHA256)
WALLET_LOCATION =
  (SOURCE =
    (METHOD = FILE)
    (METHOD_DATA =
      (DIRECTORY = /u01/app/oracle/product/19c/db_1/network/admin/wallet)))
\`\`\`

**Server Wallet** — must contain the DB server certificate, CA chain, and be in auto-login format.

After changing listener.ora, reload the listener: \`lsnrctl reload\`. Verify TCPS is available: \`lsnrctl status\` should show the TCPS endpoint.

---

## Certificate Expiry Monitoring

TLS certificate expiry is the most common cause of EBS outages that could have been prevented. A certificate that expires on a Sunday causes an immediate browser rejection — users see "Your connection is not private" and cannot access EBS. Unlike application errors, certificate expiry affects every single user simultaneously.

Monitoring approaches:
- **OHS level**: Parse the Oracle Wallet with \`orapki wallet display -wallet /path\` and extract the "Validity" date. Script this to alert at 60 days, 30 days, and 7 days remaining.
- **WebLogic level**: Use \`keytool -list -v -keystore keystore.jks\` to extract the "Valid until" date.
- **Network level**: Use \`openssl s_client -connect hostname:443 </dev/null 2>/dev/null | openssl x509 -noout -dates\` — this tests the actual certificate being served, not the stored certificate, and catches mismatches between what is in the wallet and what OHS is serving.
- **Nagios/monitoring**: The \`check_http\` plugin with \`-C 30\` flag alerts when the certificate expires within 30 days.

Set renewal reminders 90 days before expiry for CA-signed certificates — this allows time for CSR review, CA processing (up to 5 business days for OV/EV certs), wallet replacement, testing, and change management approval.

---

## Common Failure Modes

**"SSL Handshake Failed" in OHS error log**: Usually caused by a cipher suite mismatch (client does not support any of the configured ciphers) or a missing intermediate CA certificate. Check \`\${INST_TOP}/logs/ora/10.1.3/Apache/ssl_error.log\`.

**"ORA-29024: Certificate Validation Failure"**: The database client cannot validate the TCPS server certificate. The CA certificate that signed the DB server cert is not in the client's Oracle Wallet or Java truststore.

**"DMS-10003: Unable to open wallet"**: OHS cannot open the Oracle Wallet at the SSLWallet path. Either the path is wrong, the wallet is not auto-login format (missing cwallet.sso), or the OHS process user does not have read permission on the wallet directory.

**TLS configuration reverts after patching**: AutoConfig overwrote ssl.conf. The fix is to apply TLS settings to the AutoConfig template, not directly to ssl.conf.

**WLS self-signed cert causes chain errors on direct connections**: Add the WLS self-signed certificate to the Java truststore (\`\$JAVA_HOME/jre/lib/security/cacerts\`) on all systems that connect directly to WLS ports.

---

## Conclusion

TLS 1.2 for Oracle EBS 12.2.9 is a three-layer implementation: Oracle Wallet and mod_ossl at the OHS tier, JKS keystores at the WebLogic tier, and TCPS wallets at the database tier. The AutoConfig template modification is the most critical operational step — without it, every patch run reverts the configuration. Certificate chain completeness (Root CA + Intermediate CA + Server cert, in that order in the wallet) is the most common technical failure. And proactive certificate expiry monitoring at the 60/30/7 day thresholds is the difference between a planned renewal and an emergency outage.

The companion runbook provides the exact orapki, keytool, and SSL/TLS configuration commands for a complete EBS 12.2.9 TLS 1.2 implementation.`,
};

async function main() {
  console.log('Inserting EBS 12.2 TLS certificates post...');
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
