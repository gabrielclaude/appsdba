import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Internal Certificate Authority for OEM 13c: Architecture, Certificate Lifecycle, and Why It Matters',
  slug: 'internal-ca-oem13c-certificate-setup',
  excerpt:
    'A technical guide to building an internal OpenSSL certificate authority on RHEL 9, designing a two-tier Root CA / Intermediate CA hierarchy, generating and signing a certificate for Oracle Enterprise Manager 13c, and replacing the default self-signed OMS certificate — covering the OEM 13c SSL architecture, keystore and wallet structures, agent trust propagation, and validation methodology.',
  category: 'oracle-security' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-24'),
  youtubeUrl: null,
  content: `## Overview

Oracle Enterprise Manager 13c ships with a self-signed SSL certificate for the OMS (Oracle Management Service) web console. That certificate is functional for initial setup, but it creates two problems in production environments: every browser and every monitoring client shows a certificate warning that is habitually dismissed, training users to ignore security alerts; and any automation or API client must either disable certificate validation or hard-code an exception for a specific self-signed cert, making integrations fragile.

Replacing the OEM 13c certificate with one signed by an internal Certificate Authority solves both problems. The CA certificate is trusted by all managed hosts and browsers, the OEM console loads without warnings, and API integrations can validate the certificate chain without exceptions. This post explains why to build an internal CA rather than use a public CA for OEM, how the OEM 13c SSL architecture works, and what the certificate lifecycle looks like from CA setup through agent trust propagation.

---

## Why an Internal CA Rather Than a Public CA

For OEM 13c specifically, a public CA certificate is often the wrong choice:

**OEM is an internal tool.** The OMS hostname is typically an internal FQDN (e.g., \`oms-host.internal.company.com\`) that public CAs cannot validate via DNS or HTTP challenge because the host is not publicly reachable. Public CAs issue certificates for publicly resolvable hostnames.

**Certificate rotation frequency.** OEM agents re-authenticate against the OMS certificate. A public CA certificate that expires or is revoked triggers an agent communication failure across the entire managed estate simultaneously — a significant operational event. An internal CA lets the organisation control the certificate validity period (typically 2–5 years for an internal OMS cert) and rotate certificates on a planned schedule without dependency on an external CA's processes.

**Cost.** A public CA SAN certificate covering the OMS FQDN and any additional hostnames costs hundreds of dollars per year. An internal CA, once built, issues unlimited certificates at no marginal cost.

**Agent trust distribution.** OEM agents must trust the CA that signed the OMS certificate. For an internal CA, the CA certificate is distributed to all managed hosts once and placed in the OS trust store — agents automatically trust it. For a public CA, the same distribution is needed, but public CA intermediate certificates rotate on the CA's schedule, not yours.

---

## Internal CA Architecture: Two-Tier Hierarchy

A two-tier CA hierarchy is the minimum recommended structure for any production internal CA:

\`\`\`
Root CA (offline)
  └── Intermediate CA (online, signs server certificates)
        └── OEM OMS Certificate (server cert)
        └── Other internal server certs...
\`\`\`

**Root CA**: self-signed, the trust anchor for the entire PKI. Kept offline (disconnected from the network) after the Intermediate CA is signed. If the Root CA private key is compromised, every certificate in the PKI must be reissued. Keeping it offline limits that exposure. Validity: 10–20 years.

**Intermediate CA**: signed by the Root CA, kept online on the CA server, used for day-to-day certificate issuance. If the Intermediate CA is compromised, it can be revoked by the Root CA, and a new Intermediate CA can be issued without replacing every server certificate immediately. Validity: 5–10 years.

**Server certificates**: signed by the Intermediate CA. Include Subject Alternative Names (SANs) for every hostname by which the OMS is accessed (FQDN, short hostname, any load balancer aliases). Validity: 1–3 years.

The certificate chain that OEM clients verify is: server cert → Intermediate CA → Root CA. Clients that trust the Root CA automatically trust everything issued under it.

---

## OEM 13c SSL Architecture

OEM 13c has several distinct SSL/TLS endpoints, each with its own certificate configuration:

### OMS Console (WebLogic HTTPS)

The primary OEM web console runs on WebLogic Server, typically on port 7803 (HTTPS). The SSL certificate for this endpoint is stored in a Java KeyStore (JKS) within the WebLogic domain configuration:

\`\`\`
\$OMS_HOME/user_projects/domains/GCDomain/config/fmwconfig/
  ├── components/OPMN/opmn/
  └── ...
\$INSTANCE_HOME/em/EMGC_OMS1/sysman/config/
\`\`\`

OEM 13c provides \`emctl\` commands specifically for certificate management that handle the WebLogic keystore update, OPMN configuration, and the internal OEM wallet synchronisation in a single operation — rather than requiring manual WebLogic console manipulation.

### OMS Upload (Agent Communication)

Agents communicate with the OMS on a separate upload port (default: 4889 or 4903 HTTPS). This endpoint uses the same OMS certificate as the web console in OEM 13c — replacing the console certificate also replaces the upload certificate.

### Oracle Wallet

Some OEM 13c components use Oracle Wallet (\`ewallet.p12\`) rather than Java KeyStore for certificate storage. The wallet location:

\`\`\`
\$OMS_HOME/sysman/config/monwallet/
\`\`\`

\`emctl\` manages wallet updates as part of its certificate import workflow, so wallet synchronisation happens automatically during the emctl-based replacement procedure.

### Agent Trust Store

Each OEM agent has its own trust store containing the certificates it trusts for OMS connections. When the OMS certificate changes, the new CA chain must be pushed to all agents. In OEM 13c, this is handled by:
1. Adding the CA certificate to the OMS-side trust store
2. Running agent re-secure operations to push the updated trust configuration

---

## The OEM 13c Certificate Replacement Workflow

OEM 13c provides a purpose-built \`emctl\` workflow for certificate replacement that avoids the manual keystore manipulation required in OEM 12c and earlier:

### Step 1: Generate the CSR via emctl

\`emctl generateCSR oms\` produces a Certificate Signing Request directly from OEM. This CSR includes:
- The OMS Common Name (CN) — the primary hostname
- The OMS hostname as a Subject Alternative Name (SAN)
- The correct key usage extensions for a server certificate (Digital Signature, Key Encipherment, Server Authentication)

The CSR is sent to the CA for signing. This is the only point of contact between the CA and the OEM system — the private key never leaves the OMS host.

### Step 2: Sign the CSR at the CA

The CA (the Intermediate CA in a two-tier hierarchy) signs the CSR and produces a signed certificate and the certificate chain (server cert + Intermediate CA cert, or the full chain including Root CA).

### Step 3: Import the Signed Certificate

\`emctl importCertificate oms\` imports the signed server certificate and the CA chain into:
- The WebLogic domain JKS keystore
- The Oracle Wallet
- The OMS-side trust store

### Step 4: Restart and Propagate

After import, the OMS services restart to pick up the new certificate. The CA certificate (or the full chain) must then be distributed to:
- All managed host OS trust stores (so agents trust the CA)
- All browser clients (or pushed via Active Directory Group Policy, if applicable)
- Any external tools or scripts that connect to the OEM REST API

---

## Certificate SANs for OEM 13c

The OEM 13c OMS certificate must include SANs for every name by which the OMS is accessed. Missing SANs are the most common reason certificate replacement succeeds technically but causes browser or agent errors immediately after deployment.

Typical SANs for an OEM 13c OMS certificate:

| SAN Type | Value | Reason |
|----------|-------|--------|
| DNS | \`oms-host.internal.company.com\` | Primary FQDN used by agents and browsers |
| DNS | \`oms-host\` | Short hostname (some agents may resolve via short name) |
| DNS | \`ems.company.com\` | Load balancer alias or DNS alias if one exists |
| IP | \`10.0.1.50\` | IP address (add if any clients connect by IP — avoid if possible) |

Modern browsers and Java clients reject certificates where the accessed hostname does not match any SAN. The CN (Common Name) field is not checked for hostname matching by modern clients — SANs are mandatory.

---

## Validity Period and Renewal Planning

For an internal OEM CA certificate, recommended validity periods:

| Certificate | Validity | Renewal Trigger |
|------------|----------|----------------|
| Root CA | 20 years | Never (unless compromised) |
| Intermediate CA | 10 years | 1 year before Root CA expiry |
| OMS Server Cert | 2 years | 90 days before expiry |

OEM certificate expiry causes OMS console to become inaccessible (browser blocks expired cert) and agent communication failures if agents cannot verify the OMS certificate. Configure a crontab-based expiry monitor that alerts 90 days before the server certificate expires — the renewal procedure requires an OMS restart during a maintenance window.

---

## Validating the Certificate Chain

After installation, three validation checks confirm the certificate chain is correct:

**1. openssl s_client**: connects to the OMS SSL endpoint and prints the presented chain:
\`\`\`bash
openssl s_client -connect oms-host.internal.company.com:7803 -CAfile /etc/pki/ca-trust/source/anchors/internal-ca-chain.pem
\`\`\`
Look for \`Verify return code: 0 (ok)\`. Any other return code indicates a chain or trust problem.

**2. Certificate field check**: verifies SANs, validity dates, and issuer:
\`\`\`bash
openssl s_client -connect oms-host.internal.company.com:7803 </dev/null 2>/dev/null | openssl x509 -noout -text | grep -A5 "Subject Alternative Name"
\`\`\`

**3. OEM emctl status**: confirms OMS is up and processing agent uploads after the certificate change:
\`\`\`bash
\$OMS_HOME/bin/emctl status oms
\`\`\`

Agent-side validation confirms agents are communicating through the new certificate:
\`\`\`bash
\$AGENT_HOME/bin/emctl status agent
\`\`\`

A healthy agent status with \`OMS is not secure\` replaced by the new certificate chain in the agent wallet confirms end-to-end trust is established.

---

## Summary

Building an internal CA for OEM 13c is a one-time infrastructure investment that pays dividends across the entire certificate lifecycle: no browser warnings on the OEM console, trusted agent communication without manual exceptions, and full control over certificate validity and renewal scheduling. The two-tier hierarchy (offline Root CA, online Intermediate CA) follows PKI best practice and limits the blast radius of a CA key compromise. OEM 13c's \`emctl generateCSR\` and \`emctl importCertificate\` commands handle the WebLogic keystore, Oracle Wallet, and OMS trust store in a single operation — reducing the procedural complexity compared to earlier OEM releases. The companion runbook provides the complete step-by-step procedure for CA server setup on RHEL 9, CSR generation, certificate signing, OEM 13c import, agent trust distribution, and the crontab monitoring scripts that alert on certificate expiry before it becomes an outage.`,
};

async function main() {
  console.log('Inserting Internal CA / OEM 13c certificate blog post...');
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
