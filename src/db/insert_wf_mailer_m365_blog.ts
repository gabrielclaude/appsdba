import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS Workflow Mailer After Microsoft 365 Basic Auth Deprecation: The Real Root Cause',
  slug: 'oracle-ebs-workflow-mailer-m365-basic-auth-deprecation-fix',
  excerpt:
    'How a Microsoft 365 Basic Authentication deprecation forced an Oracle EBS R12.2.4 site through weeks of stunnel, NGINX, and queue rebuilds — and why intermittent notification failures persisted until the real culprit was identified: an unstable in-house reverse proxy architecture, not the Oracle Workflow Mailer.',
  category: 'appsdba' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `In October 2022, Microsoft deprecated Basic Authentication for Exchange Online and Microsoft 365. For most enterprise software, this was a scheduled inconvenience. For Oracle E-Business Suite R12.2.4 installations that relied on the native Workflow Mailer for inbound and outbound notifications, it was a hard wall.

The Oracle Workflow Mailer — the component responsible for delivering approval requests, FYI notifications, and response-processing via email — uses IMAP for inbound processing and SMTP for outbound delivery. In its stock configuration, it authenticates to mail servers using a username and password over unencrypted connections. Microsoft 365's removal of Basic Auth support broke both directions simultaneously.

This post documents a real-world resolution path: the technical decisions made when a production site needed to restore notification flow without applying new Oracle patches, the multi-week sequence of workarounds that appeared to solve the problem but did not, and the architectural realization that finally identified the true root cause.

---

## The Constraint: No New Patches

The site was running EBS R12.2.4 in production. Applying Oracle's officially recommended upgrade path — moving to a release that natively supports Modern Authentication (OAuth 2.0) for the Workflow Mailer — was ruled out by the change management window. The constraint was explicit: restore notification flow without a new Oracle patch application cycle.

This constraint shaped every decision that followed, and it is the reason the team pursued infrastructure-layer workarounds rather than the canonical fix.

---

## What the Workflow Mailer Actually Does

Understanding the failure requires understanding what the Workflow Mailer component is and what it connects to.

The Workflow Mailer is an Oracle Applications Technology (OAT) concurrent manager — specifically the \`FNDCPGSC\` (GSM) agent listener framework running the \`WF_MAILER\` agent. It operates on two queues:

| Queue | Direction | Purpose |
|-------|-----------|---------|
| \`WF_NOTIFICATION_OUT\` | Outbound | Holds notifications pending delivery to recipients |
| \`WF_NOTIFICATION_IN\` | Inbound | Holds email responses waiting to be processed back into workflow |

For outbound, the Mailer connects to an SMTP server and sends email. For inbound, it connects to an IMAP server, reads the inbox, and parses email responses to advance workflow states.

After M365 deprecated Basic Auth:
- **Outbound SMTP** — the internal Exchange relay server still accepted username/password on port 25 (unencrypted). Outbound mail continued to flow.
- **Inbound IMAP** — the M365 IMAP endpoint on port 143 no longer accepted Basic Auth. Inbound response processing stopped entirely.

This produced the classic one-way failure: notifications went out, but email responses (approvals, rejections, FYI acknowledgments) did not come back in. Workflow instances stalled waiting for responses that would never be processed.

---

## The Workaround Phase: stunnel and NGINX

With patching off the table, the engineering team pursued two infrastructure-layer solutions to bridge the TLS gap.

### Attempt 1: stunnel as a Secure Tunnel

stunnel is an open-source TLS proxy. The idea: run stunnel on the EBS application server, configure it to accept plain-text IMAP connections locally on port 1143, and tunnel them through TLS to the Exchange server's IMAPS port (993). The EBS Workflow Mailer configuration would then point to \`localhost:1143\` — an unencrypted local connection — while stunnel handled the TLS upgrade transparently.

Configuration (simplified):

\`\`\`
[imaps]
client  = yes
accept  = 127.0.0.1:1143
connect = mail.company.exchange.com:993
\`\`\`

EBS Mailer configuration would then use:
- **Inbound IMAP Server:** \`127.0.0.1\`
- **Inbound IMAP Port:** \`1143\`
- **SSL:** \`No\` (EBS side) — stunnel handles TLS upstream

**Result:** Configuration was accepted. The Mailer reported a connection to the IMAP server. But delivery remained erratic — some notifications processed, others did not.

### Attempt 2: NGINX as an IMAP Reverse Proxy

When stunnel produced inconsistent results, the team pivoted to NGINX with the \`mail\` module, configured as a stream-level proxy for IMAP traffic:

\`\`\`nginx
stream {
    upstream imap_backend {
        server mail.company.exchange.com:993;
    }
    server {
        listen 1144;
        proxy_pass imap_backend;
        proxy_ssl  on;
    }
}
\`\`\`

The Workflow Mailer was reconfigured to point to the NGINX listener. Again, the setup appeared functional — the Mailer connected, the test showed mail status updating to \`SENT\` in the database — but the intermittent delivery failures continued.

### The Queue Rebuild

Alongside the proxy work, the team rebuilt the \`WF_NOTIFICATION_OUT\` queue to eliminate any backlog of notifications that might be stuck in a corrupted or unprocessable state:

\`\`\`sql
-- Dequeue and discard stuck notifications
BEGIN
  WF_NOTIFICATION.DENQUEUE_NOTIFICATION(p_queue => 'WF_NOTIFICATION_OUT');
  COMMIT;
END;
/

-- Re-seed the queue from the notifications table
BEGIN
  WF_MAILER_PARAMETER.SETVALUE(p_name => 'RESET', p_value => 'Y');
  COMMIT;
END;
/
\`\`\`

From the database side, everything looked clean: notifications queued correctly, mail status columns updating to \`SENT\` as expected. The application logs showed no errors. Yet business users kept reporting that some approvals were never received.

---

## The Diagnostic Misdirection

The case exhibited a classic pattern in distributed systems troubleshooting: **the component being monitored was not the component that was failing.**

The EBS Workflow Mailer was functioning correctly. It was:
- Dequeuing notifications from \`WF_NOTIFICATION_OUT\`
- Connecting to the proxy (stunnel or NGINX) successfully
- Receiving a successful SMTP/IMAP handshake acknowledgment from the proxy
- Updating the \`WF_NOTIFICATIONS\` status to \`SENT\`

All of this was true. The Mailer had done its job. The proxy had received the connection. What the Oracle logs could not show was what happened *after* the proxy received the connection — whether the proxy successfully forwarded the traffic to Exchange, whether Exchange accepted the message, and whether the message was delivered to the recipient's mailbox.

The database logs showed \`SENT\`. The mail was not arriving. The gap was between the proxy and Exchange — a layer that Oracle's Workflow Mailer diagnostics cannot see.

---

## The Root Cause: Unstable In-House Reverse Proxy Architecture

The breakthrough came during an architectural review rather than a log analysis session.

A senior engineer mapped the complete traffic path:

\`\`\`
EBS Workflow Mailer
  → localhost:1143 (stunnel) / localhost:1144 (NGINX)
    → Exchange Online (port 993, IMAPS)
      → Microsoft 365 mailbox
\`\`\`

The stunnel and NGINX instances had been deployed on the EBS application server by the customer's internal sysadmin team without formal change management. The processes were:

- **Not managed by a service supervisor** (no systemd unit, no monit, no process restart on crash)
- **Not monitored** — no alerting if the tunnel process died
- **Memory-leaking** — the NGINX stream proxy configuration had no timeout or keepalive settings, causing connection pool exhaustion under load
- **Running as an ad-hoc shell process** — started manually, would not survive a server reboot

The intermittent failures followed the proxy process lifecycle exactly: notifications flowed correctly immediately after someone had manually restarted stunnel or NGINX, degraded as the proxy accumulated stale connections, and failed completely when the proxy process died — until someone restarted it again, sometimes days later.

The Oracle Mailer was updating status to \`SENT\` because it had successfully handed the message to the proxy. The proxy was silently dropping the message.

---

## The Resolution Path

### Immediate Fix: Stabilize the Proxy Infrastructure

Before any Oracle-side changes:

1. **Create a systemd service unit** for stunnel/NGINX to ensure automatic restart on failure and survival across server reboots
2. **Add connection timeout and keepalive settings** to the NGINX stream proxy configuration to prevent pool exhaustion
3. **Implement external monitoring** — a synthetic check that sends a test IMAP connection through the proxy every 5 minutes and alerts on failure

### Medium-Term Fix: Move to a Supported Mail Relay

The most architecturally sound solution — and the one that eliminates the proxy layer entirely — is to replace the M365 IMAP endpoint with an internal mail relay that the Workflow Mailer can connect to directly using Basic Auth over a controlled network path:

\`\`\`
EBS Workflow Mailer
  → Internal Exchange relay (SMTP port 25, unencrypted, on trusted LAN)
    → Microsoft 365 (via Exchange connector with Modern Auth)
\`\`\`

For inbound processing, a dedicated shared mailbox on the internal Exchange relay accepts responses, and the Mailer reads that mailbox directly — no TLS bridging required.

### Long-Term Fix: OAuth 2.0 Support

Oracle's supported path for M365 Modern Authentication is available in later EBS releases with the appropriate AD-TXK patches. This requires:

1. Azure AD application registration with IMAP/SMTP permissions
2. OAuth 2.0 client credentials flow configuration
3. EBS Workflow Mailer parameter updates for token-based authentication

This eliminates all proxy infrastructure and is the only fully supported, long-term solution.

---

## What the Database Logs Actually Tell You

One of the key lessons from this case: the EBS database logs report the state of the Mailer's interaction with the proxy — not the end-to-end delivery state.

| Log Location | What It Shows | What It Cannot Show |
|-------------|---------------|---------------------|
| \`WF_NOTIFICATIONS.MAIL_STATUS\` | Whether the Mailer handed the message to the SMTP endpoint | Whether SMTP relay delivered to recipient |
| Concurrent Manager log for FNDCPGSC | Mailer connection attempts, authentication result | Proxy-to-Exchange connection health |
| \`WF_NOTIFICATION_OUT\` queue depth | Backlog of unsent messages | Why a "sent" message didn't arrive |
| Alert log | ORA- errors in Workflow processing | Network-layer failures outside Oracle |

The critical monitoring gap was the proxy layer. Nothing in Oracle's standard logging stack reports on whether stunnel or NGINX is alive, whether it is forwarding connections successfully, or whether its connection pool is exhausted.

---

## Summary and Best Practices

### Configuration Decision Matrix for EBS Workflow Mailer Post-M365 Basic Auth

| Approach | Complexity | Patch Required | Risk | Recommendation |
|----------|-----------|----------------|------|----------------|
| stunnel + no service management | Low to deploy | No | High — silent failure | Do not use |
| NGINX stream proxy (managed service) | Medium | No | Medium — requires monitoring | Acceptable as interim |
| Internal Exchange relay (LAN SMTP) | Low | No | Low | Best no-patch option |
| OAuth 2.0 via AD-TXK patches | High | Yes | Low — fully supported | Production target |

### Best Practices

1. **Never deploy proxy infrastructure without a service supervisor.** stunnel and NGINX processes started manually from a shell will not survive a server reboot and will not restart after a crash. Always create a systemd unit file.

2. **Monitor the proxy layer independently of Oracle.** The EBS Workflow Mailer logs cannot see past the proxy. A synthetic IMAP connection check that bypasses Oracle entirely is required to detect proxy failures.

3. **Set NGINX stream proxy timeouts explicitly.** The default NGINX stream proxy configuration has no connection-level timeout — connections accumulate until the file descriptor limit is reached. Always configure \`proxy_timeout\`, \`proxy_connect_timeout\`, and upstream keepalive settings.

4. **Do not interpret \`MAIL_STATUS = 'SENT'\` as end-to-end delivery confirmation.** It means the Mailer handed the message to the configured SMTP endpoint. End-to-end delivery requires monitoring outside Oracle.

5. **Distinguish inbound from outbound failures before debugging.** Outbound SMTP and inbound IMAP are independent. The M365 deprecation broke inbound IMAP — outbound SMTP often continues via an internal relay. Separate diagnostic paths are required.

6. **Test failover of the proxy, not just initial connectivity.** A successful initial connection test does not reveal memory leaks, connection pool exhaustion, or process instability under sustained load. Run load tests against the proxy in non-production before deploying to production.

The companion runbook covers the complete stunnel and NGINX service deployment, systemd unit configuration, EBS Workflow Mailer parameter settings, WF queue rebuild procedure, and a monitoring script that independently validates each layer of the notification path.`,
};

async function main() {
  console.log('Inserting EBS Workflow Mailer M365 blog post...');
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
