import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'EBS Workflow Mailer TLS Runbook: STARTTLS Port 587, CA Certificate Import, and Java Property Fixes',
  slug: 'ebs-workflow-mailer-tls-starttls-runbook',
  excerpt:
    'Step-by-step runbook for resolving Oracle EBS Workflow Notification Mailer failures on port 587 with STARTTLS. Covers AFJVAPRG diagnostic testing, keytool CA certificate import into the JVM cacerts keystore, TLS version forcing for JDK 6/7/8, Java property configuration, Workflow Mailer service component restart sequence, and post-fix verification queries.',
  category: 'ebs-workflow' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `## Overview

This runbook resolves Oracle EBS Workflow Notification Mailer failures when connecting to a third-party SMTP relay (SMTP2Go, SendGrid, Mailgun, Postmark) on port 587 with STARTTLS or TLS. The failure presents as authentication errors or connection resets even though a telnet test to the same host and port succeeds.

**Symptoms addressed:**
- Workflow Notification Mailer service shows STOPPED or ERROR status
- WF_MAILER log contains SSLHandshakeException, PKIX path building failed, or protocol_version alerts
- Emails stopped after switching from port 25 (open relay) to port 587 (TLS)
- AFJVAPRG test fails with TLS-related errors

**EBS versions covered:** EBS 12.1.3, 12.2.x (all RUPs)

**Prerequisites:** OS-level access to the EBS application server, APPS schema access, SMTP relay credentials, DBC file path

---

## Phase 1: Environment Verification

### 1.1 Establish the EBS Environment

Log in to the EBS application server as the oracle OS user and source the environment:

\`\`\`bash
# EBS 12.1
source /u01/oracle/EBS/apps/apps_st/appl/APPSORA.env

# EBS 12.2 (run edition)
source /u01/oracle/EBS/EBSapps.env run
\`\`\`

Confirm the key variables are set:

\`\`\`bash
echo "OA_JRE_TOP: $OA_JRE_TOP"
echo "AF_CLASSPATH set: $(echo $AF_CLASSPATH | cut -c1-80)..."
echo "FND_SECURE: $FND_SECURE"
\`\`\`

### 1.2 Check the JDK Version

\`\`\`bash
$OA_JRE_TOP/bin/java -version
\`\`\`

Record the output. The JDK version determines which TLS versions are available:

| JDK Version | Max TLS Default | TLS 1.2 Available | TLS 1.3 Available |
|-------------|----------------|-------------------|-------------------|
| JDK 6 (< 6u111) | TLS 1.0 | No | No |
| JDK 6 (>= 6u111) | TLS 1.0 | Yes (explicit) | No |
| JDK 7 | TLS 1.0 | Yes (explicit) | No |
| JDK 8 | TLS 1.2 | Yes (default) | No |
| JDK 11+ | TLS 1.3 | Yes (default) | Yes (default) |

If JDK 6 < 6u111, TLS 1.2 is unavailable regardless of Java properties. The only remediation is upgrading the JDK. Check Oracle MOS for the certified JDK version for your EBS release.

### 1.3 Locate the DBC File

\`\`\`bash
ls -la $FND_SECURE/*.dbc
\`\`\`

The DBC file name typically matches the TWO_TASK database alias (e.g., \`EBSPRD.dbc\`). Record the full path — it is required for the AFJVAPRG test.

### 1.4 Confirm Network Reachability (Baseline)

\`\`\`bash
# Confirm port 587 is reachable at the TCP level
telnet mail.smtp2go.com 587
\`\`\`

Expected: \`220 mail.smtp2go.com ESMTP\`

Type \`EHLO testhost\` after connection. Look for \`250-STARTTLS\` in the response list. If you do NOT see \`250-STARTTLS\`, the provider is not offering STARTTLS on this port — contact provider support before proceeding.

Type \`quit\` to close the telnet session.

---

## Phase 2: Run the AFJVAPRG Diagnostic Test

The AFJVAPRG test runs the Workflow Mailer Java class directly from the command line with debug logging enabled. It is non-destructive and does not affect the running Workflow Notification Mailer service.

### 2.1 Prepare the Test Command

Replace the placeholders with your actual values:

\`\`\`bash
AFJVAPRG \
  -classpath $AF_CLASSPATH \
  -Dprotocol=smtp \
  -Ddbcfile=/u01/oracle/EBS/apps/apps_st/appl/fnd/12.0.0/secure/EBSPRD.dbc \
  -Dport=587 \
  -Dsecurity=TLS \
  -Dtruststore=$OA_JRE_TOP/lib/security/cacerts \
  -Dserver=mail.smtp2go.com \
  -Daccount=your_smtp_username \
  -Dpassword=your_smtp_password \
  -Dconnect_timeout=120 \
  -Ddebug=Y \
  -Dlogfile=/tmp/smtp_tls_debug.log \
  -DdebugMailSession=Y \
  oracle.apps.fnd.wf.mailer.Mailer
\`\`\`

### 2.2 Run and Capture Output

\`\`\`bash
# Run test and also capture terminal output
AFJVAPRG \
  -classpath $AF_CLASSPATH \
  -Dprotocol=smtp \
  -Ddbcfile=$FND_SECURE/EBSPRD.dbc \
  -Dport=587 \
  -Dsecurity=TLS \
  -Dtruststore=$OA_JRE_TOP/lib/security/cacerts \
  -Dserver=mail.smtp2go.com \
  -Daccount=your_smtp_username \
  -Dpassword=your_smtp_password \
  -Dconnect_timeout=120 \
  -Ddebug=Y \
  -Dlogfile=/tmp/smtp_tls_debug.log \
  -DdebugMailSession=Y \
  oracle.apps.fnd.wf.mailer.Mailer 2>&1 | tee /tmp/smtp_tls_terminal.log

echo "Exit code: $?"
\`\`\`

### 2.3 Parse the Log for Root Cause

\`\`\`bash
# Check for CA certificate failure
grep -i "PKIX\|ValidatorException\|path building\|certificate" /tmp/smtp_tls_debug.log | head -20

# Check for TLS version failure
grep -i "protocol_version\|SSLHandshake\|unrecognized ssl\|connection reset" /tmp/smtp_tls_debug.log | head -20

# Check for successful TLS handshake
grep -i "STARTTLS\|TLSv1\|cipher suite\|220 Go ahead" /tmp/smtp_tls_debug.log | head -20

# Check for authentication result
grep -i "AUTH\|535\|334\|235\|authenticated" /tmp/smtp_tls_debug.log | head -20
\`\`\`

Use the decision table below to identify your root cause:

| Log Pattern | Root Cause | Go To |
|------------|------------|-------|
| \`PKIX path building failed\` | CA certificate not trusted | Phase 3 |
| \`Received fatal alert: protocol_version\` | TLS version mismatch | Phase 4 |
| \`Unrecognized SSL message\` | TLS version mismatch | Phase 4 |
| \`Connection reset\` (before handshake) | TLS version mismatch | Phase 4 |
| \`220 Go ahead\` visible, then AUTH fails | Credentials or relay policy | Phase 5 |
| \`mail.smtp.starttls.enable\` errors | STARTTLS property missing | Phase 6 |

---

## Phase 3: Fix CA Certificate Trust (PKIX Path Failure)

### 3.1 Identify the Certificate Chain

Download the SMTP provider's CA certificate. Most providers document their certificate chain. For SMTP2Go, check their TLS documentation or inspect the certificate directly:

\`\`\`bash
# Use openssl to fetch and display the certificate chain from the server
openssl s_client \
  -connect mail.smtp2go.com:587 \
  -starttls smtp \
  -showcerts 2>/dev/null | \
  openssl x509 -noout -text | \
  grep -E "Issuer:|Subject:|Not After"
\`\`\`

This shows which CA signed the server certificate. Download the Root CA and any Intermediate CA certificates from the CA's public repository (DigiCert, Let's Encrypt, Comodo, etc.).

### 3.2 Check Current cacerts Content

\`\`\`bash
# List all currently trusted CAs
$OA_JRE_TOP/bin/keytool \
  -list \
  -keystore $OA_JRE_TOP/lib/security/cacerts \
  -storepass changeit \
  -v 2>/dev/null | grep -A2 "Alias name:"

# Search for a specific CA by keyword
$OA_JRE_TOP/bin/keytool \
  -list \
  -keystore $OA_JRE_TOP/lib/security/cacerts \
  -storepass changeit 2>/dev/null | grep -i "digicert\|letsencrypt\|comodo\|smtp2go"
\`\`\`

If the CA already appears, the issue may be an intermediate CA missing from the chain — you need to import the intermediate separately.

### 3.3 Back Up the cacerts Keystore

\`\`\`bash
cp $OA_JRE_TOP/lib/security/cacerts \
   $OA_JRE_TOP/lib/security/cacerts.backup.$(date +%Y%m%d_%H%M%S)
echo "Backup created"
\`\`\`

### 3.4 Import the CA Certificate

Save the CA certificate as a PEM file (e.g., \`/tmp/smtp_provider_ca.crt\`), then import:

\`\`\`bash
# Import root CA
$OA_JRE_TOP/bin/keytool \
  -import \
  -trustcacerts \
  -alias smtp2go-root-ca \
  -file /tmp/smtp_provider_root.crt \
  -keystore $OA_JRE_TOP/lib/security/cacerts \
  -storepass changeit \
  -noprompt

# Import intermediate CA (if required)
$OA_JRE_TOP/bin/keytool \
  -import \
  -trustcacerts \
  -alias smtp2go-intermediate-ca \
  -file /tmp/smtp_provider_intermediate.crt \
  -keystore $OA_JRE_TOP/lib/security/cacerts \
  -storepass changeit \
  -noprompt
\`\`\`

Expected output: \`Certificate was added to keystore\`

### 3.5 Verify Import

\`\`\`bash
$OA_JRE_TOP/bin/keytool \
  -list \
  -alias smtp2go-root-ca \
  -keystore $OA_JRE_TOP/lib/security/cacerts \
  -storepass changeit \
  -v 2>/dev/null | grep -E "Alias|Owner|Issuer|Valid"
\`\`\`

### 3.6 Re-Run the AFJVAPRG Test

Repeat Phase 2 with the same command. The PKIX error should be gone. If a \`protocol_version\` error appears now, proceed to Phase 4.

---

## Phase 4: Fix TLS Protocol Version

### 4.1 Force TLS 1.2 in the AFJVAPRG Test

Add two properties to the test command and re-run:

\`\`\`bash
AFJVAPRG \
  -classpath $AF_CLASSPATH \
  -Dprotocol=smtp \
  -Ddbcfile=$FND_SECURE/EBSPRD.dbc \
  -Dport=587 \
  -Dsecurity=TLS \
  -Dtruststore=$OA_JRE_TOP/lib/security/cacerts \
  -Dhttps.protocols=TLSv1.2 \
  -Dmail.smtp.ssl.protocols=TLSv1.2 \
  -Dserver=mail.smtp2go.com \
  -Daccount=your_smtp_username \
  -Dpassword=your_smtp_password \
  -Dconnect_timeout=120 \
  -Ddebug=Y \
  -Dlogfile=/tmp/smtp_tls_debug_v2.log \
  -DdebugMailSession=Y \
  oracle.apps.fnd.wf.mailer.Mailer 2>&1 | tee /tmp/smtp_tls_terminal_v2.log

grep -i "TLSv1\|cipher suite\|220 go ahead\|authenticated\|535" /tmp/smtp_tls_debug_v2.log | head -20
\`\`\`

If the test now shows \`220 Go ahead\` or \`235 authenticated\`, TLS version was the issue. Proceed to Phase 6 to apply these properties permanently.

### 4.2 JDK 6 Without TLS 1.2 Support

If the JDK is below 6u111 and TLS 1.2 is unavailable, the options are:

1. **Upgrade the JDK**: Apply the certified JDK update per MOS Note 393931.1 (EBS Certified JDK versions).
2. **Use SSL port 465**: If the SMTP provider supports SMTPS on port 465 (implicit SSL rather than STARTTLS), change the mailer configuration to port 465 with security=SSL. SSL connections on 465 still require the CA certificate import from Phase 3.
3. **Use port 25 with STARTTLS if provider permits**: Some providers offer TLS 1.0-compatible endpoints for legacy clients on port 25 — check with provider support.

---

## Phase 5: Fix Authentication Failures (Post-Handshake)

If the TLS handshake succeeds (visible \`220 Go ahead\` or cipher suite negotiation in the log) but authentication fails with \`535 Username and Password not accepted\`:

### 5.1 Verify Credentials Independently

Log in to the SMTP provider's dashboard and confirm:
- The account is active and not suspended
- The sending domain is verified
- The SMTP credentials shown match what you are using in the test
- There are no IP allowlist restrictions preventing connections from the EBS application server IP

### 5.2 Confirm AUTH Property

Ensure \`-Dmail.smtp.auth=true\` is present in the AFJVAPRG test command. Without it, JavaMail does not attempt SMTP authentication.

### 5.3 Check Username Format

Some providers require the username to be the full email address (\`user@yourdomain.com\`), not just the account name. Others use an API key as the password. Verify the exact credential format in the provider's SMTP documentation.

---

## Phase 6: Apply Fix Permanently to Workflow Mailer Configuration

Once the AFJVAPRG test succeeds, apply the working configuration to the live Workflow Notification Mailer.

### 6.1 Navigate to Workflow Mailer Configuration

In EBS, access the **Oracle Applications Manager** (OAM):

1. Log in as SYSADMIN
2. Navigate to: **Site Map > Administration > Oracle Applications Manager > Workflow Manager**
3. Click **Notification Mailers**
4. Click the name of the active Notification Mailer (typically \`WFMLRSVC\`)
5. Click **Edit**

### 6.2 Update Outbound Mail Server Settings

| Field | Value |
|-------|-------|
| Outbound Mail Server (SMTP) | \`mail.smtp2go.com\` |
| Outbound Mail Server Port | \`587\` |
| Outbound Mail Server Authentication | Username and Password |
| Username | your SMTP account username |
| Password | your SMTP account password |
| Connection Security | STARTTLS |

### 6.3 Add Java Arguments (If TLS Version Fix Was Required)

If Phase 4 was needed, find the **Additional Java Arguments** field. Append:

\`\`\`
-Dhttps.protocols=TLSv1.2 -Dmail.smtp.ssl.protocols=TLSv1.2
\`\`\`

If the field does not exist at your EBS/ATG patch level, add the properties to the service component startup script. On EBS 12.2, the service component Java arguments are configured in:

**Workflow Configuration > Service Component Containers > FNDSM > Java Options**

For EBS 12.1, add the properties to \`$FND_TOP/admin/template/wfmailer.sh\` and redeploy via autoconfig.

### 6.4 Save and Restart the Notification Mailer

In Oracle Workflow Manager:
1. Click **Apply** to save the configuration
2. Select the WFMLRSVC container
3. Click **Stop**, wait for status to show STOPPED
4. Click **Start**
5. Wait 60 seconds and refresh — status should show RUNNING

\`\`\`sql
-- Confirm mailer is running via database (as APPS)
SELECT agent_name, status, error_message
FROM   wf_agents
WHERE  type = 'WF_MAILER';

-- Check for recent mailer activity
SELECT notification_id, status, mail_status, sent_date
FROM   wf_notifications
WHERE  mail_status IN ('SENT', 'FAILED', 'ERROR')
ORDER  BY sent_date DESC
FETCH  FIRST 20 ROWS ONLY;
\`\`\`

---

## Phase 7: Post-Fix Verification

### 7.1 Send a Test Notification

From EBS System Administrator:
1. Navigate to **Workflow > Status Monitor**
2. Find a pending notification for a test user with a valid email address
3. Use the **Resend** action to queue a test send

Or trigger a new workflow notification from the FND Workflow Background Process concurrent request.

### 7.2 Monitor the Mailer Log

\`\`\`bash
# EBS 12.2 — find the current mailer log
ls -lt $APPLCSF/$APPLLOG/WFMLRSVC*.log | head -5

# Tail the log and look for send confirmation
tail -200 $APPLCSF/$APPLLOG/WFMLRSVC_<timestamp>.log | grep -i "sent\|error\|SMTP\|TLS\|AUTH"
\`\`\`

Successful send produces a line like:
\`\`\`
WF_MAILER: Message sent successfully to user@example.com
\`\`\`

### 7.3 Verify Notifications Cleared from Queue

\`\`\`sql
-- Notifications waiting to be sent (should decrease after mailer runs)
SELECT COUNT(*) AS pending_notifications
FROM   wf_notifications
WHERE  mail_status = 'MAIL'
AND    status = 'OPEN';

-- Notifications that failed (should be 0 after fix)
SELECT notification_id,
       recipient_role,
       mail_status,
       error_stack
FROM   wf_notifications
WHERE  mail_status = 'FAILED'
AND    begin_date >= TRUNC(SYSDATE) - 1
ORDER  BY begin_date DESC;
\`\`\`

### 7.4 Confirm Agent Status

\`\`\`sql
SELECT agent_name,
       status,
       direction,
       protocol,
       java_class,
       error_message,
       last_receive_date
FROM   wf_agents
WHERE  name LIKE 'WF_SMTP%'
OR     type = 'WF_MAILER'
ORDER  BY agent_name;
\`\`\`

All WF_SMTP agents should show STATUS = \`READY\` or \`RUNNING\`.

---

## Phase 8: Rollback Procedure

If the configuration change causes new errors:

### 8.1 Restore cacerts Backup

\`\`\`bash
# Only if keytool imports were the source of new errors
cp $OA_JRE_TOP/lib/security/cacerts.backup.<timestamp> \
   $OA_JRE_TOP/lib/security/cacerts
\`\`\`

### 8.2 Revert Mailer Configuration

In Oracle Workflow Manager, edit the Notification Mailer and restore:
- Port back to the previous working value (e.g., 25)
- Security back to NONE
- Remove any added Java arguments

Restart the WFMLRSVC container.

### 8.3 Verify Rollback

Re-run the AFJVAPRG test with the original port 25 / NONE security configuration to confirm the original behavior is restored.

---

## Summary

| Phase | Action | Resolves |
|-------|--------|---------|
| Phase 1 | Verify JDK version, DBC path, network TCP reachability | Baseline |
| Phase 2 | Run AFJVAPRG with debugMailSession=Y, parse log | Identifies root cause |
| Phase 3 | Import SMTP provider CA cert via keytool into cacerts | PKIX path failure |
| Phase 4 | Add -Dhttps.protocols=TLSv1.2 to Java args | Protocol version mismatch |
| Phase 5 | Verify credentials, AUTH property, username format | Post-handshake auth failure |
| Phase 6 | Apply working config to Workflow Mailer, restart WFMLRSVC | Production fix |
| Phase 7 | Query WF_NOTIFICATIONS, monitor mailer log | Confirmation |
| Phase 8 | Restore cacerts backup, revert mailer config | Rollback if needed |

The AFJVAPRG test is the critical diagnostic step. Every other phase flows from what that log reveals. Run it before making any configuration changes, and run it again after each fix to confirm progress before restarting the production Workflow Notification Mailer.`,
};

async function main() {
  console.log('Inserting EBS Workflow Mailer TLS runbook...');
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
