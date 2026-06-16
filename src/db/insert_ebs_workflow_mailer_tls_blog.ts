import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Troubleshooting Oracle EBS Workflow Mailer TLS/STARTTLS Authentication Errors on Port 587',
  slug: 'oracle-ebs-workflow-mailer-tls-starttls-port-587-troubleshooting',
  excerpt:
    'When Oracle EBS Workflow Notification Mailer fails on Port 587 with TLS authentication errors — even though telnet connects successfully — the problem is not your network. It is in the Java layer: missing CA certificates, deprecated TLS versions, or unconfigured STARTTLS properties. This guide walks through the three root causes and a structured diagnostic approach using the AFJVAPRG command-line mailer test.',
  category: 'ebs-workflow' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `## Introduction

The Oracle EBS Workflow Notification Mailer is a background Java service that delivers approval requests, alert notifications, and status updates to email addresses defined in EBS user accounts. When it works, business processes move invisibly. When it breaks, purchase order approvals stall in queue, expense reports sit unreviewed, and support tickets pile up within hours.

A particularly common and disorienting failure pattern occurs when organizations switch from open SMTP (port 25, no authentication) to a third-party SMTP relay service — SMTP2Go, SendGrid, Mailgun, Postmark — that enforces TLS on port 587. The Workflow Mailer starts throwing authentication or connection errors, but a \`telnet mail.smtp2go.com 587\` from the EBS application server connects immediately. The network is fine. So what is wrong?

The answer is that telnet proves the TCP port is reachable and the firewall rules allow traffic through. It tells you nothing about what happens during the TLS handshake, certificate trust validation, or protocol negotiation that follows. Oracle EBS's underlying Java Virtual Machine has to perform all of that work, and any gap in the Java environment — an expired CA certificate, a deprecated TLS version, a missing Java property — causes the handshake to fail before authentication can even begin.

---

## Why Telnet Succeeds but EBS Fails

When telnet connects to port 587, it establishes a plain TCP socket. The SMTP server responds with a greeting banner (typically \`220 mail.smtp2go.com ESMTP\`), and you can type EHLO to see the server's capability list. You will see \`250-STARTTLS\` in that list, confirming the server supports TLS upgrade. But the STARTTLS upgrade itself requires the client to initiate a TLS handshake — and telnet cannot do that. It hands the connection back to you as raw text.

What happens in a real STARTTLS connection:

1. Client connects to port 587 (plain TCP — telnet proves this works)
2. Server sends \`220\` greeting
3. Client sends \`EHLO hostname\`
4. Server returns capability list including \`250-STARTTLS\`
5. **Client sends \`STARTTLS\` command** (this is where EBS enters the picture)
6. Server responds \`220 Go ahead\`
7. **Client initiates TLS handshake** — exchanges cipher suites, validates the server certificate against a trusted CA, confirms TLS version compatibility
8. Only after the handshake succeeds does the client send AUTH credentials

Steps 5 through 7 are pure Java SSL/TLS work. If any of them fail, EBS logs an authentication error even though the underlying issue has nothing to do with the username or password.

---

## The Three Root Causes

### 1. Missing or Untrusted CA Certificate

During the TLS handshake (step 7), the SMTP server presents its certificate. The Java Virtual Machine validates this certificate by tracing its chain of trust back to a root Certificate Authority (CA) in the JVM's trusted keystore — the \`cacerts\` file located at \`$OA_JRE_TOP/lib/security/cacerts\`.

If the CA that signed the SMTP server's certificate is not in that keystore, the JVM throws a \`PKIX path building failed\` exception and terminates the connection. You will see something like:

\`\`\`
javax.net.ssl.SSLHandshakeException: sun.security.validator.ValidatorException:
PKIX path building failed: sun.security.provider.certpath.SunCertPathBuilderException:
unable to find valid certification path to requested target
\`\`\`

This is the most common cause when a third-party provider is new to your environment or when they recently renewed their certificate under a different CA chain (common when providers migrate to Let's Encrypt or DigiCert roots).

### 2. TLS Protocol Version Mismatch

EBS 12.1 and early 12.2 environments typically run on JDK 6 or JDK 7. These JDK versions default to TLS 1.0 as the maximum protocol version when initiating a connection. Modern SMTP relay providers have disabled TLS 1.0 and TLS 1.1 support as of 2020-2022 in response to IETF deprecation (RFC 8996). When the EBS JVM proposes TLS 1.0 during the handshake and the server only accepts TLS 1.2 or 1.3, the server closes the connection immediately.

This produces log output like:

\`\`\`
javax.net.ssl.SSLHandshakeException: Received fatal alert: protocol_version
\`\`\`

or:

\`\`\`
com.sun.mail.util.MailConnectException: Couldn't connect to host, port: mail.smtp2go.com, 587;
timeout -1: Connection reset
\`\`\`

The fix requires forcing the JVM to use TLS 1.2 via a Java system property passed to the mailer process, and confirming that the JDK version installed actually supports TLS 1.2 (JDK 6u111+, all JDK 7, all JDK 8).

### 3. STARTTLS Java Property Not Configured

Oracle EBS Workflow Mailer uses the JavaMail API under the hood. JavaMail requires explicit configuration to initiate a STARTTLS upgrade — it does not attempt the upgrade by default. The critical property is:

\`\`\`
mail.smtp.starttls.enable=true
\`\`\`

If this property is absent from the mailer Java arguments, the JVM connects to port 587 in plain-text mode and attempts to authenticate without upgrading to TLS. When the SMTP server requires TLS, it rejects the authentication attempt or closes the connection.

In older EBS patch levels, this property is not wired into the Workflow Mailer configuration UI and must be passed explicitly via the \`java.util.Properties\` mechanism or as a JVM argument. Later 12.2 ATG patches added the \`Security\` field in the mailer configuration that sets this property transparently.

---

## The Diagnostic Approach: AFJVAPRG Command-Line Test

Rather than cycling through Workflow Notification Mailer restarts in the EBS UI (which is slow and produces limited log output), use the \`AFJVAPRG\` command-line utility to run an isolated mailer test with full debug logging enabled. This bypasses the concurrent manager and gives you a direct view of the Java mail session negotiation.

### Setting the Environment

On the EBS application server, source the EBS environment:

\`\`\`bash
source /u01/oracle/EBS/apps/apps_st/appl/APPSORA.env
# or for 12.2 multi-node:
source /u01/oracle/EBS/EBSapps.env run
\`\`\`

Confirm the Java path:

\`\`\`bash
echo $OA_JRE_TOP
$OA_JRE_TOP/bin/java -version
\`\`\`

### Running the TLS Test

\`\`\`bash
AFJVAPRG \
  -classpath $AF_CLASSPATH \
  -Dprotocol=smtp \
  -Ddbcfile=<complete_DBC_file_path> \
  -Dport=587 \
  -Dsecurity=TLS \
  -Dtruststore=$OA_JRE_TOP/lib/security/cacerts \
  -Dserver=mail.smtp2go.com \
  -Daccount=<smtp_username> \
  -Dpassword=<smtp_password> \
  -Dconnect_timeout=120 \
  -Ddebug=Y \
  -Dlogfile=/tmp/smtp_tls_debug.log \
  -DdebugMailSession=Y \
  oracle.apps.fnd.wf.mailer.Mailer
\`\`\`

Replace \`<complete_DBC_file_path>\` with the full path to your DBC file (typically under \`$FND_SECURE\`), and supply real SMTP credentials.

The \`-DdebugMailSession=Y\` flag activates JavaMail's internal debug output, which prints every SMTP command and response plus the TLS handshake steps to the log file.

---

## Reading the Debug Log

Open \`/tmp/smtp_tls_debug.log\` and look for these specific patterns:

### Pattern 1: PKIX Path Failure → CA Certificate Problem

\`\`\`
javax.net.ssl.SSLHandshakeException: sun.security.validator.ValidatorException:
PKIX path building failed
\`\`\`

**Action**: Download the CA certificate chain from the SMTP provider and import it into the JVM keystore. The provider's documentation typically lists the root and intermediate CAs. Import with \`keytool\`:

\`\`\`bash
$OA_JRE_TOP/bin/keytool \
  -import \
  -alias smtp2go-root \
  -file /tmp/smtp2go-ca.crt \
  -keystore $OA_JRE_TOP/lib/security/cacerts \
  -storepass changeit
\`\`\`

After import, re-run the AFJVAPRG test without restarting EBS.

### Pattern 2: Protocol Version Alert → TLS Version Problem

\`\`\`
SSLHandshakeException: Received fatal alert: protocol_version
\`\`\`

**Action**: Add the TLS version constraint to the test command:

\`\`\`bash
-Dhttps.protocols=TLSv1.2 \
-Dmail.smtp.ssl.protocols=TLSv1.2
\`\`\`

If these properties resolve the test, add them permanently to the Workflow Mailer Java options in the EBS configuration.

### Pattern 3: Successful Handshake but AUTH Failure → Credentials or Relay Policy

\`\`\`
DEBUG SMTP: AUTH LOGIN command trace suppressed
535-5.7.8 Username and Password not accepted
\`\`\`

If the handshake succeeds (you see cipher suite negotiation and \`220 Go ahead\` in the log) but authentication fails, the problem is the credentials themselves, an account-level relay restriction at the provider, or a missing \`mail.smtp.auth=true\` property. Verify the credentials independently at the provider's dashboard.

---

## Permanent Fix: Workflow Mailer Configuration in EBS

Once the AFJVAPRG test succeeds, apply the same settings to the live Workflow Notification Mailer configuration:

1. In EBS, navigate to **Oracle Workflow Manager** (via Oracle Applications Manager or Workflow Administrator Web Applications)
2. Select the **Notification Mailer** service component
3. Click **Edit Parameters**
4. Set:
   - **Outbound Server**: \`mail.smtp2go.com\`
   - **Outbound Port**: \`587\`
   - **Connection Security**: \`STARTTLS\` (or \`TLS\` depending on the EBS version's terminology)
   - **Username**: your SMTP relay account
   - **Password**: your SMTP relay password
5. In the **Additional Java Arguments** field (if available at your patch level), add:
   - \`-Dhttps.protocols=TLSv1.2\`
   - \`-Dmail.smtp.ssl.protocols=TLSv1.2\`
6. Save and restart the Notification Mailer service component.

Monitor the Workflow Mailer log (typically under \`$APPLCSF/$APPLLOG/WFMLRSVC*.log\`) for the next send cycle to confirm clean authentication.

---

## Summary

A successful telnet connection to port 587 proves only that TCP traffic reaches the SMTP server. It does not validate the TLS handshake that must follow. When Oracle EBS Workflow Mailer fails on port 587 with TLS enabled, the root cause is almost always one of three Java-layer issues: the JVM's \`cacerts\` keystore does not trust the SMTP server's CA, the JVM is proposing a TLS version the server no longer accepts, or the \`mail.smtp.starttls.enable=true\` property is missing from the mailer configuration.

The \`AFJVAPRG\` command-line test is the fastest diagnostic tool available — it produces a full JavaMail debug trace without requiring a Workflow Mailer restart and pinpoints exactly which step of the STARTTLS negotiation fails. Fix the Java layer first, confirm with the command-line test, then apply the same settings to the live Workflow Notification Mailer configuration.

The companion runbook covers the complete keytool CA import procedure, the exact Java property additions for each EBS version, the Workflow Mailer service component restart sequence, and the post-fix verification queries against WF_NOTIFICATION and WF_MAILER_AGENT_STATUS.`,
};

async function main() {
  console.log('Inserting EBS Workflow Mailer TLS blog post...');
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
