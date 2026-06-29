import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Wallet Certificate Monitoring: Automated Expiry Detection and Vendor Fingerprint Comparison',
  slug: 'oracle-wallet-certificate-monitoring',
  excerpt:
    'A practical guide to building a shell script that monitors all certificates in an Oracle Wallet for expiry, fingerprint drift after CA renewal, and chain completeness — with sendmail notification to an Apps DBA recipient list and crontab scheduling. Covers how Oracle Wallet stores trusted CA, intermediate, and identity certificates, why fingerprint comparison against a vendor reference store catches silent CA reissuance before it breaks SSL handshakes, how to choose WARN_DAYS and CRIT_DAYS thresholds for EBS environments, and a scheduling strategy that escalates check frequency as certificates approach expiry.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-29'),
  youtubeUrl: null,
  content: `## Introduction

Oracle EBS environments rely on Oracle Wallet for every SSL-secured connection the application tier initiates or accepts: HTTPS communication between OHS and WebLogic, outbound SOAP calls to external systems, database connections over TCPS, and integration endpoints with payment gateways, tax authorities, and third-party SaaS vendors. The wallet holds the certificates that make all of these connections possible.

Certificate expiry is one of the most predictable outages in enterprise infrastructure — and one of the most commonly missed. Every certificate has a fixed end date. Every CA issues certificates with a defined lifetime. Yet in environments where certificates are renewed manually, the renewal window is often allowed to slip until a monitoring alert fires — or until a production connection silently fails.

The second failure mode is less understood: fingerprint drift. A certificate authority can reissue a certificate for the same domain or organization with a new key pair, a new serial number, and a new expiry date — without changing the Subject name. If your Oracle Wallet contains the old issuing CA certificate and the vendor has switched to the new one, SSL handshakes begin failing for a reason that does not appear anywhere in ORA- error messages or in the Oracle Wallet itself. The wallet has a certificate. The certificate has not expired. But the fingerprint does not match what the vendor is presenting, and the trust chain cannot be completed.

This article describes a monitoring architecture that catches both failure modes before they reach production: a shell script that extracts every certificate from the Oracle Wallet, checks each one against configurable expiry thresholds, and compares fingerprints against a vendor reference store — with automated alerts sent to the Apps DBA team via sendmail and daily scheduling via crontab.

---

## What the Oracle Wallet Holds

An Oracle Wallet is a PKCS#12 container (\`ewallet.p12\`) that stores certificates in two categories:

### Trusted Certificates (CA and Intermediate)
Root CA certificates and intermediate CA certificates that Oracle's SSL implementation uses to build and verify trust chains. When Oracle EBS establishes an outbound SSL connection, it checks whether the server's certificate chains up to a trusted root in the wallet. When Oracle HTTP Server terminates inbound SSL, it uses these trusted certificates to validate client certificates if mutual TLS is configured.

Each trusted certificate is identified by its Subject, which may be shared across multiple reissuances — the same CA subject can appear with different keys, serial numbers, and validity windows at different points in the CA's lifecycle.

### Identity Certificates (User Certificates)
The certificate and private key pair that represents the server or application identity. For Oracle HTTP Server, this is the server certificate the browser or client validates. For outbound mutual TLS, this is the client certificate presented to the remote server.

The identity certificate has the shortest typical lifetime — one to two years for standard DV/OV certificates, up to three years for multi-year commercial certificates.

### What orapki Displays

When you run \`orapki wallet display -wallet /path/to/wallet\`, Oracle prints each certificate's Distinguished Name, not its fingerprint. Two certificates for the same subject will appear identically in the display output but have different fingerprints. This is the core problem that fingerprint-based monitoring solves.

---

## Three Failure Modes This Monitoring Catches

### Failure Mode 1: Certificate Expiry

Every certificate has a Not After date. When that date passes, Oracle's SSL implementation refuses to use the certificate in a trust evaluation. For trusted CA certificates, this means the entire trust chain built through that CA collapses. For identity certificates, it means the server is presenting an expired credential that clients will reject.

The monitoring script checks every certificate's Not After date against two thresholds:
- **WARN_DAYS** (default: 60): generates a WARNING alert. Sufficient lead time to schedule renewal through vendor and change control processes.
- **CRIT_DAYS** (default: 30): generates a CRITICAL alert. Immediate action required.

Intermediate CA certificates often have longer lifetimes (5–10 years) and are overlooked in renewal workflows focused on the identity certificate. The monitoring script checks every certificate in the wallet, not just the identity certificate.

### Failure Mode 2: Fingerprint Drift After CA Reissuance

A certificate authority can reissue a certificate with:
- The same Subject Distinguished Name
- A new public key and private key pair
- A new serial number
- A new Not Before and Not After date
- The same or different signature algorithm

From Oracle's perspective — and from \`orapki wallet display\` — the old and new certificates look identical in the summary view. But when a vendor switches from the old CA to the new CA for signing server certificates, the trust chain can no longer be completed through the old intermediate in your wallet.

The monitoring script maintains a **vendor certificate reference store**: a directory of PEM files downloaded from the certificate authority's public distribution points. On each run, the script computes the SHA-256 fingerprint of each wallet certificate and compares it against the fingerprint of the corresponding vendor reference certificate (matched by Common Name). A mismatch generates a CRITICAL alert — the vendor has reissued the certificate and the wallet needs to be updated.

### Failure Mode 3: Missing or Incomplete Chain

When a vendor provides a new server certificate, the installation package typically includes the full chain: root CA, intermediate CA(s), and server certificate. If an intermediate CA is not imported into the Oracle Wallet, the trust chain cannot be built. The monitoring script's vendor reference store approach also catches this: if a vendor reference certificate has no matching entry in the wallet, the script generates a WARNING indicating a potentially missing chain member.

---

## Architecture of the Monitoring Solution

\`\`\`
Oracle Wallet (ewallet.p12)
    │
    │ openssl pkcs12 -nokeys
    ▼
All Certificates (PEM, split to individual files)
    │
    ├──→ Expiry Check (Not After vs WARN_DAYS/CRIT_DAYS)
    │
    └──→ Fingerprint Comparison (SHA-256 vs vendor_certs/)
              │
              ├── Match → OK
              └── Mismatch → CRITICAL Alert
                  No vendor ref → INFO (add to reference store)

Alert Collection
    │
    └──→ sendmail → DBA Recipient List (wallet_monitor.conf)
         └──→ Log entry (/var/log/oracle_wallet_monitor.log)
\`\`\`

The script runs as the \`oracle\` OS user, which has read access to the wallet files. It requires no Oracle software beyond the standard \`openssl\` command available on Oracle Linux — it does not use the \`orapki\` utility for extraction, because \`openssl pkcs12\` provides more reliable certificate splitting and fingerprint computation.

---

## Vendor Certificate Reference Store

The vendor certificate reference store is a directory (\`vendor_certs/\`) alongside the monitoring script. Each file is a PEM-format certificate downloaded from the certificate authority's public distribution point or from the vendor's certificate portal.

### Populating the Reference Store

For each CA certificate in the Oracle Wallet, obtain the current version from the issuing CA:

**Root CAs**: downloaded directly from the CA's website (DigiCert, Entrust, GlobalSign, Sectigo). CA root certificates are publicly available.

**Intermediate CAs**: fetch from a live endpoint that presents the current certificate chain:
\`\`\`bash
# Fetch the full chain from a vendor endpoint and save each certificate
openssl s_client -showcerts -connect vendor.example.com:443 </dev/null 2>/dev/null \\
  | awk '/-----BEGIN CERTIFICATE-----/{n++} n{print > "/path/to/vendor_certs/chain_cert_" n ".pem"}'
\`\`\`

**Identity/server certificates**: obtain the renewed certificate from your vendor or CA portal before importing it into the wallet. Store a copy in the reference store so the script can verify the wallet was updated correctly.

### Reference Store Maintenance

The reference store requires periodic maintenance:
- When a CA announces a renewal, download the new certificate and replace the reference file
- When a new vendor integration is added, fetch its certificate chain and add to the reference store
- When a vendor rotates its intermediate CA, download the new intermediate and update the reference

The monitoring script's fingerprint comparison will alert on any wallet-to-reference mismatch, which prompts investigation. This creates a two-way alert: when the vendor updates their certificate before the wallet is updated (wallet is stale), and when the wallet is updated without updating the reference store (reference is stale).

---

## Alert Thresholds and Notification Strategy

### Threshold Recommendations for EBS Environments

| Certificate Type | WARN_DAYS | CRIT_DAYS | Rationale |
|---|---|---|---|
| Identity (server) cert | 60 | 30 | Standard change-control lead time |
| Intermediate CA | 90 | 60 | CA renewals require coordination with vendor |
| Root CA | 180 | 90 | Root CA renewals are rare but high-impact |

The default script uses a single WARN_DAYS and CRIT_DAYS for all certificate types. For environments with mixed certificate lifetimes, the per-certificate threshold logic can be added by matching on the Subject's O (Organization) or CN field.

### Recipient List Design

The monitoring script reads recipients from the configuration file as a comma-separated list. Recommended recipients:

\`\`\`
RECIPIENT_LIST="dba-team@example.com,security-team@example.com,infra-oncall@example.com"
\`\`\`

Consider separate recipient lists for WARNING and CRITICAL severity levels — WARNING alerts go to the DBA team for scheduled action, CRITICAL alerts go to the oncall distribution list for immediate response.

### Sendmail Integration

The script uses \`/usr/sbin/sendmail -t -oi\` with a properly formatted RFC 2822 message. This works with both Sendmail and Postfix (which is the default MTA on Oracle Linux 8/9 and provides a sendmail-compatible interface). The \`-t\` flag reads recipients from the message headers. The \`-oi\` flag prevents a line containing only a dot from terminating the message body.

If the environment requires SMTP relay (common in data centers where direct SMTP is blocked), configure Postfix with a relayhost in \`/etc/postfix/main.cf\` — the script's sendmail call is unaffected.

---

## Scheduling with Crontab

### Daily Check (Standard Monitoring)

Run the monitor daily at 6:00 AM, before the business day begins, so alerts are in the DBA team's inbox before production load peaks:

\`\`\`
0 6 * * * /opt/oracle/scripts/wallet_monitor/oracle_wallet_cert_monitor.sh
\`\`\`

### Escalated Frequency During Warning Window

During the 60-day warning window, running once daily is sufficient — there is ample lead time for action. During the 30-day critical window, running twice daily provides faster detection if a renewal is delayed or if a certificate is unexpectedly revoked:

\`\`\`
# Standard daily check
0 6 * * * /opt/oracle/scripts/wallet_monitor/oracle_wallet_cert_monitor.sh

# Additional midday check — active only when CRIT_DAYS threshold might be in play
# (Both entries active simultaneously; duplicate alerts are suppressed by the script's
#  deduplication logic if LAST_ALERT_FILE is configured)
0 12 * * * /opt/oracle/scripts/wallet_monitor/oracle_wallet_cert_monitor.sh
\`\`\`

### Log Rotation

The monitoring log grows with each run. Add a logrotate configuration so it does not accumulate indefinitely:

\`\`\`
/var/log/oracle_wallet_monitor.log {
    daily
    rotate 90
    compress
    missingok
    notifempty
}
\`\`\`

---

## Summary

Oracle Wallet certificate monitoring addresses two silent failure modes that standard infrastructure monitoring does not catch: certificate expiry and fingerprint drift after CA reissuance. Both failure modes produce identical symptoms — SSL handshake failures — but have different root causes and different remediation steps.

The monitoring architecture extracts all certificates from \`ewallet.p12\` using \`openssl pkcs12\`, applies per-certificate expiry checks against configurable WARN_DAYS and CRIT_DAYS thresholds, and compares SHA-256 fingerprints against a vendor certificate reference store maintained alongside the script. Alerts are collected, deduplicated, and delivered via sendmail to the Apps DBA recipient list with enough context to identify the failing certificate, its current expiry date, and the fingerprint delta if a mismatch is detected.

Scheduled daily via crontab under the \`oracle\` OS user, the script runs before production hours and logs its output to a rotating log file. The vendor reference store requires periodic maintenance as certificate authorities renew their intermediate CAs — the fingerprint comparison turns this into an active process: any vendor-side renewal that is not reflected in the wallet generates an alert, and any wallet update that is not reflected in the reference store generates an alert in the opposite direction.

The companion runbook covers the complete installation sequence: directory layout, wallet password file security, reference store population, full script deployment, sendmail configuration, crontab installation, and a validation checklist confirming the end-to-end alert path before going live.`,
};

async function main() {
  console.log('Inserting Oracle Wallet certificate monitoring blog post...');
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
