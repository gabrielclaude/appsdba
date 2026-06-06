import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'TLS 1.2 Certificate Management in Oracle Enterprise Manager 13c',
  slug: 'oracle-oem-13c-tls-certificates-configuration',
  excerpt:
    'Oracle Enterprise Manager 13c uses a three-layer TLS architecture spanning the OMS WebLogic console (Java KeyStore), the OMS-to-Agent upload channel (Oracle Wallet), and Agent-to-database wallet connections — each requiring distinct tools and procedures. Self-signed certificates installed by default cause browser security warnings, agent connectivity problems, and compliance failures under PCI-DSS, SOC 2, and STIG frameworks. This post explains how enterprise CA-signed certificates are deployed correctly across all three layers and how TLS 1.2 enforcement and cipher suite hardening are applied to the full OEM stack.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-05'),
  youtubeUrl: null,
  content: `## Introduction

Oracle Enterprise Manager Cloud Control 13c operates over HTTPS across all of its communication channels: the browser-to-OMS console connection, the OMS-to-Agent upload channel, the Agent-to-target database wallet connections, and the WebLogic Admin Server interface. Every one of these channels uses TLS, and every one requires a certificate to authenticate the server to the connecting party. This pervasive use of TLS is appropriate — the OEM console provides access to database credentials, privileged job execution, and patch deployment across the entire Oracle estate. An unauthenticated or impersonated OEM connection is a critical security breach, not a configuration inconvenience.

Out of the box, OEM is installed with Oracle Wallet-based self-signed certificates that are technically functional but immediately problematic in enterprise environments. Browsers flag them as untrusted and require the user to click through a security warning on every session. Security scanners report them as findings. Penetration tests flag them as vulnerabilities. Compliance frameworks — PCI-DSS, SOC 2, DISA STIG — explicitly require CA-signed certificates on management interfaces. In many regulated environments, the existence of a self-signed certificate on a management console is a blocker for production approval, not a low-priority remediation item. Replacing OEM's self-signed certificates with enterprise CA-signed certificates is therefore not optional for production deployments — it is a mandatory post-installation step that belongs on the post-install checklist alongside OS hardening and RMAN configuration.

The complexity of OEM certificate management comes from the fact that OEM uses certificates in three distinct contexts — the OMS WebLogic console (Java KeyStore / JKS), the OMS upload service (Oracle Wallet), and the Management Agent (Oracle Wallet) — each requiring different tools and procedures. The WebLogic console certificate is managed with the JDK \`keytool\` command and the WebLogic Admin Console or \`wlst.sh\`. The OMS upload service certificate is managed with Oracle's \`orapki\` PKI toolkit or the \`emctl secure oms\` command. Agent certificates are managed with \`emctl secure agent\`, which re-downloads the OMS trust anchor into each agent's wallet. These are not variations of the same operation — they are genuinely different procedures that must all be completed for a fully CA-signed OEM deployment.

A misconfigured certificate in any one of these three layers will break OEM communication in ways that can be difficult to diagnose, particularly for administrators who are new to Oracle Wallet and are more familiar with the Linux/OpenSSL certificate ecosystem. The failure modes are often indirect: an agent shows as \`Blocked\` or \`Unreachable\` in the OEM console not because the agent process died but because the agent's wallet does not trust the new OMS certificate, causing the TLS handshake on the upload channel to fail silently. Understanding which layer a failure belongs to is the prerequisite for applying the correct fix. This post provides that architectural understanding before the companion runbook walks through the replacement procedure step by step.

---

## OEM TLS Architecture: Three Certificate Layers

OEM 13c's TLS implementation spans three layers, each with its own certificate store format, management tooling, and failure characteristics. Understanding this layered architecture is the foundation for both the initial certificate replacement and ongoing certificate lifecycle management.

**Layer 1 — OMS HTTPS Console (WebLogic/JKS):** The OMS runs on WebLogic Server, Oracle's Java EE application server. The HTTPS listener that serves the browser-facing OEM console operates on ports 7802 (HTTP, typically redirected) and 7803 (HTTPS). This listener uses a Java KeyStore (JKS) — the standard Java certificate store format — managed by the WebLogic server instance. When a DBA opens \`https://oms-host:7803/em\` in a browser, the browser validates the certificate served by WebLogic against its trusted CA store. If the certificate is self-signed or issued by a CA the browser does not trust, the browser displays a security warning. Replacing this certificate requires updating the WebLogic KeyStore configuration via the WebLogic Administration Console (or \`wlst.sh\` scripting), pointing WebLogic at a new JKS file containing the CA-signed server certificate. The JKS is managed entirely with the JDK's \`keytool\` command — \`orapki\` is not involved.

**Layer 2 — OMS Upload Service (Oracle Wallet):** In addition to the WebLogic console listener, the OMS exposes an upload endpoint on port 4900. This is the port that all Management Agents connect to for metric uploads. This service uses an Oracle Wallet — specifically, the PKCS#12 wallet files \`ewallet.p12\` and \`cwallet.sso\` — located in \`\$OMS_HOME/sysman/config/\`. The Oracle Wallet is Oracle's proprietary certificate container format, managed with the \`orapki\` command-line tool. Replacing the upload service certificate requires either the \`emctl secure oms\` command (which handles the wallet update and triggers agent re-trust automatically) or manual \`orapki\` operations. This certificate is distinct from the WebLogic console certificate — a browser never validates it directly, but every Management Agent validates it on every upload.

**Layer 3 — Management Agent (Oracle Wallet):** Each Management Agent has its own Oracle Wallet located in \`\$AGENT_HOME/sysman/config/\`. The agent uses this wallet for two purposes: to authenticate to the OMS upload service (Layer 2) when establishing the TLS connection to port 4900, and to establish trusted connections to monitored database targets that use Oracle wallets for authentication. The agent's wallet must contain the OMS server's certificate or CA certificate as a trusted entry. When the OMS certificate changes (whether to replace a self-signed certificate or to renew an expiring one), every agent's wallet must be updated to trust the new certificate. This is done by running \`emctl secure agent\` on each agent host, which re-downloads the current OMS certificate chain into the local wallet.

\`\`\`
OEM 13c TLS Certificate Layers

Browser / Client
     │
     │ HTTPS :7803 — Layer 1: WebLogic JKS Certificate
     ▼
┌─────────────────────────────────────┐
│   Oracle Management Service (OMS)   │
│   WebLogic Server                   │
│   JKS: em.keystore                  │
│                                     │
│   Upload Service :4900 ─────────────┼──► Layer 2: OMS Oracle Wallet
│   OMS_HOME/sysman/config/           │         ewallet.p12
│   ewallet.p12 / cwallet.sso         │         cwallet.sso
└─────────────────────────────────────┘
           ▲
           │ HTTPS :4900 — Agent Upload (uses OMS wallet trust)
           │
┌──────────┴──────────────────────────┐
│   Management Agent                  │
│   AGENT_HOME/sysman/config/         │◄── Layer 3: Agent Oracle Wallet
│   ewallet.p12 / cwallet.sso         │
└─────────────────────────────────────┘
\`\`\`

The critical insight from this architecture is that replacing the OMS console certificate (Layer 1) without replacing the upload service certificate (Layer 2) will fix the browser warning but leave agents connecting over an untrusted channel. Conversely, replacing the upload service certificate (Layer 2) without updating agent wallets (Layer 3) will cause all agents to lose connectivity to the OMS because their wallets still trust the old certificate. A complete certificate replacement must address all three layers in sequence: Layer 2 first (OMS wallet), then Layer 3 (agent wallets), then Layer 1 (WebLogic JKS). The \`emctl secure oms\` command is designed to handle Layers 2 and 3 together, but the WebLogic JKS update (Layer 1) always requires a separate procedure.

---

## Oracle Wallet vs Java KeyStore

The coexistence of two certificate storage formats in OEM is a frequent source of confusion for DBAs who primarily work in the Java and Linux ecosystem. Understanding why both formats exist — and which Oracle components use which — clarifies why OEM certificate management requires two distinct toolchains.

**Oracle Wallet (\`ewallet.p12\`)** is a PKCS#12 container file used by Oracle components for certificate storage. The Oracle database uses it for native network encryption and SSL/TLS on the listener. The Oracle HTTP Server uses it. The OMS upload service uses it. The Management Agent uses it. In all these contexts, the wallet is managed by Oracle's \`orapki\` command (Oracle PKI Toolkit), which ships with Oracle Database and Oracle client installations. \`orapki\` can create wallets, add and remove trusted certificates, import PKCS#12 key-certificate pairs, and display wallet contents. It is the Oracle-world equivalent of the OpenSSL command-line tool for certificate operations.

The auto-login wallet (\`cwallet.sso\`) is a companion file generated alongside \`ewallet.p12\`. The \`.sso\` (Single Sign-On) wallet allows Oracle processes to open the wallet without a password at runtime. This is required for OEM because the OMS and Management Agents start as OS services — typically via \`systemd\` or init scripts — without any mechanism for interactive password entry. Every Oracle Wallet used in an OEM context must have a corresponding \`cwallet.sso\` file. If the auto-login wallet is missing or out of sync with the \`ewallet.p12\`, the OMS or agent will fail to start with a wallet-related error. Creating or recreating the auto-login wallet is done with the \`-auto_login\` flag during \`orapki wallet create\`.

**Java KeyStore (JKS)** is the standard Java certificate store format used by Java applications to store private keys and certificates. WebLogic Server, as a Java application, uses JKS natively. The JDK ships with the \`keytool\` utility for JKS management — creating keystores, importing certificates, exporting entries, and listing contents. JKS is not PKCS#12; the two formats are not directly interchangeable, though modern Java (JDK 8+) can import from PKCS#12 into JKS using \`keytool -importkeystore\`. WebLogic's OEM console uses JKS because WebLogic is the application server hosting it — Oracle did not add Oracle Wallet support to the WebLogic HTTPS listener.

The distinction between these two formats has direct operational consequences. A DBA who correctly installs a new CA-signed certificate into the Oracle Wallet using \`orapki\` has fixed the agent upload channel but has not touched the browser-facing certificate, which is still the self-signed entry in the WebLogic JKS. Conversely, a DBA who updates the WebLogic JKS via \`keytool\` has fixed the browser warning but has not updated the upload channel or agent trust stores. Both operations must be completed, with separate tools, for the full three-layer certificate replacement to be complete. This is the most common mistake in OEM certificate replacements — treating it as a single-step operation when it is a three-step sequential process.

---

## Certificate Requirements for OEM

Before submitting a Certificate Signing Request to the enterprise CA, it is essential to understand the technical requirements that the issued certificate must meet for OEM to accept and use it correctly. Certificates that satisfy general HTTPS requirements may still fail in OEM due to missing Subject Alternative Names or incorrect key usage extensions.

**Subject Alternative Names (SANs):** The certificate must include all hostnames by which the OMS is accessed as SAN DNS entries. This includes the FQDN of the OMS host (\`oms-host.domain.com\`), any load balancer virtual hostname used to front the OMS (\`oem-console.domain.com\`), and the short hostname (\`oms-host\`). Modern browsers (Chrome 58+, released 2017) dropped support for validating the CN field as a hostname and require the hostname to appear in the SAN extension. A certificate with the correct CN but no SAN, or a SAN that doesn't include all access hostnames, will trigger \`NET::ERR_CERT_COMMON_NAME_INVALID\` in Chrome and equivalent errors in other browsers. The CA CSR must be generated with the SAN extension populated, not added after the fact — SANs must be included in the CSR for the CA to include them in the signed certificate.

**Key usage extensions:** The certificate must carry the correct X.509v3 extended key usage values. For a TLS server certificate: \`Key Usage: Digital Signature, Key Encipherment\` and \`Extended Key Usage: TLS Web Server Authentication (OID 1.3.6.1.5.5.7.3.1)\`. Enterprise CAs typically configure these correctly for server certificates, but it is worth verifying in the signed certificate before attempting to import it. A certificate with \`Client Authentication\` but not \`Server Authentication\` will be rejected by WebLogic during keystore configuration.

**Key size and algorithm:** Minimum 2048-bit RSA for compatibility with OEM 13.3 and earlier agents. For new deployments on OEM 13.4+, 4096-bit RSA or EC P-256 are preferred — they provide a stronger security margin and are required by some recent STIG versions. EC P-256 (\`prime256v1\`) offers equivalent security to 3072-bit RSA at significantly smaller key size, resulting in faster TLS handshakes — relevant in OEM where hundreds of agents simultaneously upload metrics every minute.

**Certificate validity period:** Most enterprise CAs issue server certificates with 1-year or 2-year validity. Plan the renewal cadence into the OEM operational calendar — if the first certificate expires without a replacement, OEM goes fully offline: the browser blocks the console, agents cannot upload to an OMS presenting an expired certificate, and the incident management system loses visibility precisely when it may be most needed. A 60-day advance renewal target is reasonable — the companion runbook includes a monitoring script that alerts at 60 days and again at 30 days before expiry.

**CA certificate chain:** OEM must trust the full certificate chain — not just the server certificate. Both the Oracle Wallet and the WebLogic JKS trust store must contain the Root CA certificate and any Intermediate CA certificates. This is especially important for enterprise PKI deployments where the Root CA is offline and a separate Intermediate CA issues server certificates. The Intermediate CA certificate must be present in both trust stores, or TLS clients will receive a chain validation error even though the server certificate itself is legitimately signed. The complete chain (Root + all Intermediates) must be imported as trusted certificates, and the server certificate must be imported separately as the identity certificate with its private key.

---

## Common Failure Modes

OEM certificate replacements fail in predictable ways. Understanding the failure signatures before beginning the replacement allows for faster diagnosis when something goes wrong, which is more likely than not on the first attempt in a complex enterprise environment.

**Browser \`NET::ERR_CERT_AUTHORITY_INVALID\`** after importing the CA-signed certificate into the WebLogic JKS: the JKS trust store is missing the Intermediate CA certificate. WebLogic serves the server certificate but the browser cannot build a chain to a trusted root. Fix: import both the Intermediate CA certificate and the Root CA certificate into the JKS using \`keytool -importcert\`, then restart WebLogic. This error also occurs if the certificate was issued by an Internal CA whose root is not in the OS trust store — import the CA chain explicitly into the JKS rather than relying on OS-level CA trust.

**Browser \`NET::ERR_CERT_COMMON_NAME_INVALID\`** after replacing the certificate: the new certificate's SAN extension does not include the hostname being used to access OEM. This is most commonly caused by using a certificate generated for the primary hostname but accessing OEM via a load balancer VIP or an alias. Fix: reissue the certificate with a CSR that includes all access hostnames in the SAN extension. This requires working with the CA again — the SAN cannot be modified in an issued certificate. Preventively, collect all hostnames used to access OEM before generating the CSR.

**Agent shows \`Blocked\` or \`Agent Unreachable\` in OEM console** after updating the OMS wallet: the agent's Oracle Wallet still contains the old OMS certificate as the trusted upload endpoint. The TLS handshake on port 4900 fails because the agent's wallet presents the old trust anchor but the OMS now serves the new certificate. Fix: run \`emctl secure agent -emdWalletSrcUrl https://oms-host:4900/em\` on the affected agent host. This re-downloads the current OMS certificate chain into the agent wallet. In large deployments with hundreds of agents, this must be done on every agent — the companion runbook includes a bulk resecure procedure using \`emcli\`.

**\`OMS is not secure\` error in \`emctl status oms\`** after wallet operations: the OMS Oracle Wallet is corrupted, the auto-login wallet (\`cwallet.sso\`) is missing or out of sync, or the wallet password provided during \`orapki\` operations does not match the password registered with the OMS. Fix: restore the wallet from the pre-change backup (a critical reason why the backup step in Phase 0 of the runbook is non-negotiable), then re-run the wallet update procedure. If the backup is not available, the wallet can be regenerated with \`emctl secure oms\`, but this requires re-securing all agents afterward.

**WebLogic Admin Server refuses to start** after updating the JKS configuration: the keystore alias or password specified in the WebLogic domain configuration does not match the actual alias or password in the JKS file. Fix: use \`keytool -list -v -keystore em.keystore -storepass <password>\` to list the actual alias in the keystore, then update the WebLogic domain configuration (via WLST or the Admin Console) to match. The keystore password and the private key password in WebLogic must both be correct — WebLogic stores them separately in the domain configuration.

**OMS starts but agents cannot upload after WebLogic restart** following a JKS update: the WebLogic SSL listener on port 7803 is functioning but the Oracle Wallet on port 4900 was not updated, or was updated incorrectly. The two ports use completely independent certificate stores — updating one does not affect the other. Diagnose by testing each port independently: \`openssl s_client -connect oms-host:7803\` for the console port and \`openssl s_client -connect oms-host:4900\` for the upload port.

---

## Certificate Renewal Planning

Certificates expire, and an expired OEM certificate causes an immediate hard outage. When the OMS certificate expires, the browser refuses to connect to the console, agents refuse to upload to the OMS (an expired server certificate fails TLS validation on the agent side), and the entire OEM monitoring and alerting capability goes dark. This is not a graceful degradation — it is a complete loss of centralised monitoring that occurs suddenly at midnight on the certificate expiry date.

The renewal window for OEM certificates should start at least 30 days before expiry for a standard enterprise CA process, or 60 days if the CA requires manager approval or has a slow issuance workflow. The practical renewal sequence is identical to the initial installation: generate a new CSR, submit to CA, receive signed certificate, import into Oracle Wallet and WebLogic JKS, restart OMS, re-secure agents. Because the sequence is known and documented, it can and should be tested in a lower environment (dev or staging OEM) before executing in production.

OEM provides built-in certificate expiry monitoring. Configure an OEM metric alert on the \`OMS Certificate Expiry\` and \`Agent Certificate Expiry\` metrics with a 60-day warning threshold and a 30-day critical threshold. This ensures the on-call DBA receives an actionable alert long before the expiry becomes an emergency. In practice, OEM certificate expirations are almost always avoidable outages — they occur when the renewal alert is missed, misrouted, or deprioritised. Building the renewal action into the DBA calendar as a hard date, scheduled 45 days before expiry, prevents this class of outage.

In a multi-OMS HA deployment, certificates must be replaced on every OMS instance. The OMS instances share the Software Library on NFS, but each has its own \`sysman/config/\` wallet directory. Both OMS instances must be updated, and if both are behind a load balancer, they must present identical certificates — a session that hits OMS1 during certificate replacement but switches to OMS2 (which still has the old certificate) after the browser has validated OMS1's certificate will cause a confusing certificate mismatch error. Coordinate the certificate replacement to update both OMS instances within the same maintenance window, with the load balancer directing all traffic to one OMS instance while the other is being updated.

The \`emctl secure\` command sequence that performs the replacement can be scripted and executed without manual interaction using response files and pre-configured passwords. Testing this script in a lower environment before the production maintenance window both validates the script and gives the DBA a confidence-building dry run of the full procedure. Always take a complete backup of all wallet files and JKS keystores before any certificate operation — the restore path from a failed certificate replacement depends entirely on having clean backups to revert to.

---

## TLS 1.2 Enforcement

Certificate management and TLS version enforcement are closely related — both are required for compliance with PCI-DSS 3.2.1+, NIST SP 800-52 Rev 2, and the DISA STIG for Oracle WebLogic. While replacing self-signed certificates addresses authentication and trust, TLS version enforcement addresses the cipher negotiation protocol and eliminates vulnerabilities specific to TLS 1.0 and 1.1 (BEAST, POODLE, and related attacks).

By default, OEM 13c supports TLS 1.0, 1.1, and 1.2. Disabling TLS 1.0 and 1.1 requires changes in two distinct places. The WebLogic Server SSL configuration controls the TLS versions offered on the console port (7803) and the WebLogic Admin port (7301). This is configured via the \`weblogic.security.SSL.minimumProtocolVersion\` Java system property in the WebLogic domain startup scripts — specifically, adding \`-Dweblogic.security.SSL.minimumProtocolVersion=TLSv1.2\` to the \`JAVA_OPTIONS\` environment variable in \`setDomainEnv.sh\`. The Oracle Network layer — which governs the agent upload channel on port 4900 — is separately configured via the \`SSL_VERSION\` parameter in the OMS host's \`sqlnet.ora\` file. Setting \`SSL_VERSION = 1.2\` in \`\$OMS_HOME/network/admin/sqlnet.ora\` restricts the Oracle Network TLS negotiation to TLS 1.2 only.

Before disabling TLS 1.0 and 1.1, verify that all Management Agents in the estate are running OEM 13.3 or later. Agents on OEM 12c or early 13c releases do not support TLS 1.2 on the upload channel and will immediately lose connectivity when TLS 1.0/1.1 are disabled on the OMS. The agent version can be verified from the OEM console under Setup → Manage Cloud Control → Agents, filtering by agent version. Agents that do not support TLS 1.2 must be upgraded before enforcing TLS 1.2 on the OMS — this sequencing requirement makes TLS 1.2 enforcement a planned project, not an overnight change.

After the TLS version changes, validate the enforcement with \`openssl s_client\`. The command \`openssl s_client -connect oms-host:7803 -tls1_2\` should succeed and display the certificate chain and session cipher. The command \`openssl s_client -connect oms-host:7803 -tls1\` should fail with an alert or handshake error. Test both the console port (7803) and, if accessible, the upload port (4900) to confirm enforcement applies to both communication channels.

---

## Cipher Suite Hardening

TLS version restriction eliminates the weakest protocol versions but does not by itself ensure strong cipher negotiation — a TLS 1.2 session using RC4 or 3DES is still cryptographically weak. Cipher suite hardening specifies exactly which cipher suites the OMS and agents will offer and accept, ensuring that TLS sessions use authenticated encryption with forward secrecy.

Oracle recommends the following cipher suites for OEM 13c compliant deployments: \`TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384\`, \`TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256\`, \`TLS_RSA_WITH_AES_256_GCM_SHA384\`, and \`TLS_RSA_WITH_AES_128_GCM_SHA256\`. The ECDHE variants (Elliptic Curve Diffie-Hellman Ephemeral) provide forward secrecy — each TLS session uses a fresh key exchange, so a compromised server private key does not retroactively expose past session traffic. The AES-GCM cipher suites provide authenticated encryption, combining encryption and message authentication in a single operation without separate HMAC. These are the suites that will satisfy PCI-DSS and NIST 800-52 cipher requirements.

Cipher suites that must be explicitly disabled include: all RC4 variants (broken, no longer considered secure), all DES and 3DES variants (DES is trivially brute-forced; 3DES is subject to the SWEET32 attack in long sessions), all export-grade cipher suites (intentionally weakened, breakable in hours on modern hardware), and anonymous Diffie-Hellman suites (no server authentication, subject to man-in-the-middle attacks). In OEM 13c, these weak suites are not disabled by default — they must be explicitly excluded via configuration.

WebLogic cipher suite configuration is applied via the \`SSLMBean\` in the WebLogic domain configuration, typically set via WLST. The property \`ciphersuites\` on the SSL MBean accepts a comma-separated list of approved cipher suite names. On the Oracle Network side, the agent upload channel's cipher suite list is configured in \`sqlnet.ora\` via \`SSL_CIPHER_SUITES = (suite1, suite2, ...)\`. Both must be configured consistently — a WebLogic cipher restriction that does not match the \`sqlnet.ora\` restriction creates an inconsistency where the console port is hardened but the agent upload channel still accepts weak suites.

After configuring cipher restrictions, validate the effective cipher suite list with an SSL scanner. The OpenSSL command \`openssl s_client -connect oms-host:7803 -cipher 'RC4'\` should fail with a handshake error if RC4 is properly disabled. For a comprehensive scan, \`testssl.sh\` (an open-source TLS scanning tool) provides a structured report of all offered cipher suites, TLS versions, certificate details, and known vulnerability exposure. If the OMS is externally accessible, Qualys SSL Labs provides the most widely recognised third-party validation report. For internal OEM deployments, \`testssl.sh\` running from the internal network is the appropriate tool.

---

## Summary

Oracle Enterprise Manager 13c TLS certificate management spans three layers that must all be addressed for a compliant, CA-signed deployment. Layer 1 is the WebLogic JKS keystore that authenticates the OMS console to browsers on port 7803 — managed with \`keytool\` and the WebLogic Admin Console. Layer 2 is the Oracle Wallet that authenticates the OMS upload service to Management Agents on port 4900 — managed with \`orapki\` or \`emctl secure oms\`. Layer 3 is each Management Agent's Oracle Wallet, which must be updated to trust the new OMS certificate after Layer 2 is replaced — done with \`emctl secure agent\` on each agent host. Replacing certificates in only one or two of these layers leaves OEM in a partially broken state that is more difficult to diagnose than a complete failure.

The certificate requirements that must be met before CA issuance are: Subject Alternative Names covering all access hostnames (FQDN, load balancer VIP, short hostname), correct extended key usage extensions (\`TLS Web Server Authentication\`), minimum 2048-bit RSA key (4096-bit or EC P-256 preferred for new deployments), and the full CA chain (Root CA + Intermediate CA) imported into both the Oracle Wallet trust store and the WebLogic JKS trust store. Missing SANs and missing intermediate CA certificates account for the majority of post-replacement failures. The common failure modes — \`ERR_CERT_AUTHORITY_INVALID\`, \`ERR_CERT_COMMON_NAME_INVALID\`, agent upload failures, wallet corruption errors — each map to a specific root cause with a specific fix.

TLS 1.2 enforcement requires changes in two places: the \`weblogic.security.SSL.minimumProtocolVersion\` Java property in the WebLogic domain startup scripts disables TLS 1.0/1.1 on the console port, and \`SSL_VERSION = 1.2\` in \`sqlnet.ora\` disables older protocols on the agent upload channel. Before enforcing TLS 1.2, verify that all agents in the estate support TLS 1.2 — agents on OEM 12c or early 13c do not. Cipher suite hardening is configured separately via the WebLogic \`SSLMBean\` and the \`SSL_CIPHER_SUITES\` parameter in \`sqlnet.ora\`, targeting ECDHE-AES-GCM suites and explicitly excluding RC4, 3DES, export-grade, and anonymous Diffie-Hellman suites.

OEM certificate management is a recurring operational task, not a one-time installation activity. Certificates expire — typically after 1–2 years — and an expired OEM certificate causes an immediate, complete monitoring outage. Build the renewal process into the DBA operational calendar before the first certificate expires, not after. Configure OEM's own certificate expiry alerts with 60-day warning and 30-day critical thresholds. Test the renewal procedure in a lower environment. Document the wallet backup and restore path. The few hours invested in building and testing the renewal process before it is needed will prevent the much more costly incident of an unexpected monitoring outage during a production event.`,
};

async function main() {
  console.log('Inserting OEM TLS certificate management post...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: { ...post },
  });
  console.log('Inserted: "' + post.title + '"');
}

main().catch(console.error);
