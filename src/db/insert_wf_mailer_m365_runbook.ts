import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'EBS Workflow Mailer After M365 Basic Auth Deprecation: Deployment and Monitoring Runbook',
  slug: 'oracle-ebs-workflow-mailer-m365-proxy-monitoring-runbook',
  excerpt:
    'Step-by-step runbook for restoring Oracle EBS R12.2.4 Workflow Mailer notification flow after Microsoft 365 Basic Authentication deprecation: stunnel and NGINX service deployment, systemd unit configuration, EBS Mailer parameter settings, WF queue rebuild, and a monitoring script that independently validates every layer of the notification path — from queue depth to proxy health to SMTP delivery.',
  category: 'appsdba' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `## Scope

This runbook applies to Oracle EBS R12.2.4 and R12.2.x environments where:

- The Workflow Mailer used Microsoft 365 (Exchange Online) for inbound IMAP or outbound SMTP
- Basic Authentication to M365 has been deprecated and notification flow has stopped
- A new Oracle patch application cycle is not available in the current change window

**The architecture this runbook deploys:**

\`\`\`
EBS Workflow Mailer
  ├─ Outbound SMTP → Internal Exchange relay (port 25, LAN) → M365
  └─ Inbound IMAP → stunnel (local port 1143) → Exchange IMAPS (port 993)
                  OR
                 NGINX stream proxy (local port 1144) → Exchange IMAPS (port 993)
\`\`\`

---

## Phase 1: Verify Current Workflow Mailer Configuration

### 1.1 Check current Mailer status

\`\`\`sql
-- As APPS user — check all Workflow Mailer agent configurations
SELECT name,
       component_type,
       component_status,
       startup_type
FROM   wf_all_activities_vl
WHERE  item_type = 'WFMAIL'
ORDER BY name;

-- Check Mailer parameters
SELECT parameter_name,
       text_value,
       number_value
FROM   wf_mailer_parameters
ORDER BY parameter_name;
\`\`\`

### 1.2 Check notification queue depth

\`\`\`sql
-- Outbound queue backlog
SELECT COUNT(*) AS pending_outbound,
       MIN(enq_time) AS oldest_message
FROM   aq\$wf_notification_out
WHERE  msg_state = 'READY';

-- Inbound queue state
SELECT COUNT(*) AS pending_inbound
FROM   aq\$wf_notification_in
WHERE  msg_state = 'READY';

-- Notifications stuck in error state
SELECT n.notification_id,
       n.recipient_role,
       n.mail_status,
       n.begin_date,
       n.end_date
FROM   wf_notifications n
WHERE  n.mail_status IN ('MAIL','ERROR')
  AND  n.status       = 'OPEN'
  AND  n.begin_date   < SYSDATE - 1
ORDER BY n.begin_date;
\`\`\`

### 1.3 Identify inbound mail failure mode

\`\`\`bash
# Test plain IMAP connection to M365 — this will FAIL after Basic Auth deprecation
telnet outlook.office365.com 143
# Expected: Connection refused or auth error

# Test IMAPS connection (TLS) — this is what stunnel/NGINX must bridge to
openssl s_client -connect outlook.office365.com:993 -crlf
# After TLS handshake, type:
# 1 LOGIN user@company.com "password"
# Expected: 1 NO AUTHENTICATE failed (Basic Auth deprecated) or
#           1 OK LOGIN completed (if internal Exchange relay)
\`\`\`

---

## Phase 2: Option A — stunnel Deployment (TLS Tunnel)

Use this option when pointing to Exchange Online IMAPS (port 993) and your EBS app server needs to bridge plain IMAP to TLS.

### 2.1 Install stunnel

\`\`\`bash
# Oracle Linux / RHEL
sudo yum install -y stunnel

# Verify installation
stunnel -version
\`\`\`

### 2.2 Configure stunnel

\`\`\`bash
sudo vi /etc/stunnel/wf_mailer.conf
\`\`\`

\`\`\`ini
; EBS Workflow Mailer — IMAP TLS bridge
; Plain IMAP on localhost:1143 → IMAPS on Exchange:993

pid = /var/run/stunnel/wf_mailer.pid
output = /var/log/stunnel/wf_mailer.log
debug = 4

[wf_imap]
client  = yes
accept  = 127.0.0.1:1143
connect = mail.company.exchange.com:993
sslVersion = TLSv1.2
verify = 0
; Set verify = 2 and cafile = /path/to/ca.pem for certificate validation
\`\`\`

\`\`\`bash
# Create log directory
sudo mkdir -p /var/log/stunnel /var/run/stunnel
sudo chown applmgr:dba /var/log/stunnel /var/run/stunnel
\`\`\`

### 2.3 Create systemd service unit

\`\`\`bash
sudo vi /etc/systemd/system/stunnel-wf-mailer.service
\`\`\`

\`\`\`ini
[Unit]
Description=stunnel TLS tunnel for EBS Workflow Mailer IMAP
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
ExecStart=/usr/bin/stunnel /etc/stunnel/wf_mailer.conf
ExecStop=/bin/kill -TERM \$MAINPID
PIDFile=/var/run/stunnel/wf_mailer.pid
Restart=on-failure
RestartSec=10
User=root

[Install]
WantedBy=multi-user.target
\`\`\`

\`\`\`bash
sudo systemctl daemon-reload
sudo systemctl enable stunnel-wf-mailer
sudo systemctl start stunnel-wf-mailer
sudo systemctl status stunnel-wf-mailer
\`\`\`

### 2.4 Test the stunnel bridge

\`\`\`bash
# Connect to stunnel local port — should complete TLS to Exchange transparently
telnet 127.0.0.1 1143
# Expected: * OK Microsoft Exchange Server IMAP4 service ready
\`\`\`

---

## Phase 3: Option B — NGINX Stream Proxy Deployment

Use this option when you prefer NGINX as the TLS proxy layer (e.g., already have NGINX deployed for other EBS purposes).

### 3.1 Install NGINX with stream module

\`\`\`bash
# Verify NGINX has stream module compiled in
nginx -V 2>&1 | grep -o 'with-stream'
# Expected: with-stream

# If not present, install from Oracle Linux extras
sudo yum install -y nginx
\`\`\`

### 3.2 Configure NGINX stream proxy

\`\`\`bash
sudo vi /etc/nginx/conf.d/wf_mailer_stream.conf
\`\`\`

\`\`\`nginx
stream {

    log_format stream_proxy '\$remote_addr [\$time_local] '
                             '\$protocol \$status \$bytes_sent \$bytes_received '
                             '\$session_time "\$upstream_addr"';

    access_log /var/log/nginx/wf_mailer_stream.log stream_proxy;

    upstream exchange_imaps {
        server mail.company.exchange.com:993;
        # Add second server for HA if available
        # server mail2.company.exchange.com:993;
    }

    server {
        listen 127.0.0.1:1144;

        proxy_pass            exchange_imaps;
        proxy_ssl             on;
        proxy_ssl_protocols   TLSv1.2 TLSv1.3;
        proxy_ssl_verify      off;

        # Connection management — critical to prevent pool exhaustion
        proxy_connect_timeout 10s;
        proxy_timeout         300s;

        # Keepalive to upstream
        # (requires upstream keepalive in stream context)
    }
}
\`\`\`

\`\`\`bash
# Test the configuration
sudo nginx -t

# Reload (or start)
sudo systemctl enable nginx
sudo systemctl reload nginx
\`\`\`

### 3.3 Test NGINX IMAP proxy

\`\`\`bash
telnet 127.0.0.1 1144
# Expected: * OK Microsoft Exchange Server IMAP4 service ready
\`\`\`

---

## Phase 4: EBS Workflow Mailer Parameter Configuration

### 4.1 Stop the Workflow Mailer

1. Log in as **SYSADMIN**
2. Navigate: **Workflow Administrator Web Applications → Oracle Workflow Manager**
3. Select **Notification Mailer** → **Stop**

Or via concurrent manager:

\`\`\`bash
# As applmgr
$FND_TOP/bin/wfntfqup.sh apps/<APPS_PWD> 0 WFMLRSVC
\`\`\`

### 4.2 Update Mailer parameters

Navigate: **Oracle Workflow Manager → Notification Mailer → Edit**

**Inbound settings (stunnel option):**

| Parameter | Value |
|-----------|-------|
| Inbound Server Name | \`127.0.0.1\` |
| Inbound Server Port | \`1143\` |
| Use SSL for Inbound | \`No\` |
| Inbound Account Name | \`notifications@company.com\` |
| Inbound Password | _(mailbox password)_ |

**Inbound settings (NGINX option):**

| Parameter | Value |
|-----------|-------|
| Inbound Server Name | \`127.0.0.1\` |
| Inbound Server Port | \`1144\` |
| Use SSL for Inbound | \`No\` |

**Outbound settings (internal Exchange relay):**

| Parameter | Value |
|-----------|-------|
| Outbound Server Name | \`internal-exchange-relay.company.com\` |
| Outbound Server Port | \`25\` |
| Use SSL for Outbound | \`No\` |
| From Address | \`ebs-workflow@company.com\` |

### 4.3 Verify via SQL after saving

\`\`\`sql
SELECT parameter_name,
       text_value
FROM   wf_mailer_parameters
WHERE  parameter_name IN (
         'INBOUND_SERVER','INBOUND_PORT','INBOUND_USE_SSL',
         'OUTBOUND_SERVER','OUTBOUND_PORT',
         'FROM','DISCARD'
       )
ORDER BY parameter_name;
\`\`\`

### 4.4 Restart the Workflow Mailer

\`\`\`bash
# Via Workflow Manager UI: Start the Notification Mailer
# Or via concurrent program:
# Submit: "Workflow Mailer Service Component Container Stop" then Start
\`\`\`

Verify the Mailer started clean:

\`\`\`bash
# Find the Mailer concurrent request log
grep -l 'WFMLRSVC\|WF_MAILER' $APPLCSF/log/*/cm*.req | tail -3

# Check for connection errors in the most recent log
tail -100 $(ls -t $APPLCSF/log/*/cm*.req | head -1) | grep -iE 'error|fail|refused|imap'
\`\`\`

---

## Phase 5: WF Notification Queue Rebuild

Only required if notifications are stuck in ERROR state or the queue has been manually corrupted.

### 5.1 Identify stuck notifications

\`\`\`sql
-- Notifications in mail error state
SELECT mail_status, COUNT(*) AS cnt
FROM   wf_notifications
WHERE  status    = 'OPEN'
GROUP BY mail_status
ORDER BY cnt DESC;
\`\`\`

### 5.2 Reset errored notifications for redelivery

\`\`\`sql
-- Reset ERROR notifications back to MAIL status for retry
BEGIN
  UPDATE wf_notifications
  SET    mail_status = 'MAIL'
  WHERE  mail_status = 'ERROR'
    AND  status       = 'OPEN'
    AND  begin_date   > SYSDATE - 30;  -- Only last 30 days
  COMMIT;
END;
/
\`\`\`

### 5.3 Purge old completed notifications (housekeeping)

\`\`\`sql
BEGIN
  WF_PURGE.TOTAL(
    itemtype => null,
    itemkey  => null,
    enddate  => SYSDATE - 90,
    docommit => TRUE,
    purgesigs => TRUE
  );
END;
/
\`\`\`

### 5.4 Rebuild WF_NOTIFICATION_OUT queue

Only required if the DBMS_AQ queue itself is corrupted:

\`\`\`sql
-- Stop the queue
BEGIN
  DBMS_AQADM.STOP_QUEUE(queue_name => 'APPLSYS.WF_NOTIFICATION_OUT');
END;
/

-- Remove all messages from the queue
BEGIN
  DBMS_AQADM.PURGE_QUEUE_TABLE(
    queue_table => 'APPLSYS.WF_NOTIFICATION_OUT',
    purge_condition => NULL,
    purge_options => DBMS_AQADM.AQ\$_PURGE_OPTIONS_T()
  );
END;
/

-- Restart the queue
BEGIN
  DBMS_AQADM.START_QUEUE(queue_name => 'APPLSYS.WF_NOTIFICATION_OUT');
END;
/
\`\`\`

---

## Phase 6: Monitoring Script

Save as \`/usr/local/bin/wf_mailer_monitor.sh\`. This script independently validates every layer of the notification path — from database queue depth through proxy health to a live IMAP connection test — and alerts if any layer fails silently.

\`\`\`bash
#!/bin/bash
# wf_mailer_monitor.sh — EBS Workflow Mailer + Proxy Health Monitor
# Validates: DB queue depth, WF Mailer status, stunnel/NGINX process,
#            IMAP proxy connectivity, SMTP relay connectivity
#
# Usage:  ./wf_mailer_monitor.sh [ORACLE_SID] [APPS_PWD]
# Cron:   */5 * * * * /usr/local/bin/wf_mailer_monitor.sh EBSPRD apps
# Alert:  Exits 1 on any failure; pipe to mailx for email alerts

ORACLE_SID="\${1:-EBSPRD}"
APPS_PWD="\${2:-apps}"
export ORACLE_SID
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
ALERT_LOG="/var/log/wf_mailer_monitor_alerts.log"
FAILURES=0

# Config — update to match your environment
IMAP_PROXY_HOST="127.0.0.1"
IMAP_PROXY_PORT="1143"          # stunnel port (or 1144 for NGINX)
SMTP_RELAY_HOST="internal-exchange-relay.company.com"
SMTP_RELAY_PORT="25"
STUNNEL_SERVICE="stunnel-wf-mailer"
NGINX_SERVICE="nginx"
USE_STUNNEL="yes"               # set to "no" if using NGINX only
QUEUE_DEPTH_WARN=100            # alert if outbound queue > this many messages
QUEUE_AGE_WARN_HOURS=2          # alert if oldest message > this many hours old

log()   { echo "[$TIMESTAMP] $*"; }
alert() { echo "[$TIMESTAMP] ALERT: $*" | tee -a "$ALERT_LOG"; FAILURES=$((FAILURES + 1)); }

log "=== WF Mailer Monitor Start ==="

source /home/applmgr/.bash_profile 2>/dev/null || true
export ORACLE_HOME="\${ORACLE_HOME:-/u01/app/oracle/product/19.0.0/dbhome_1}"
export PATH="\$ORACLE_HOME/bin:\$PATH"

SQLPLUS="\$ORACLE_HOME/bin/sqlplus -s apps/\$APPS_PWD"

# -----------------------------------------------------------------------
# CHECK 1: Workflow Mailer concurrent manager status
# -----------------------------------------------------------------------
log "Checking Workflow Mailer component status..."

MAILER_STATUS=\$(\$SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT component_status
FROM   wf_all_activities_vl
WHERE  item_type = 'WFMAIL'
  AND  name      = 'Notification Mailer'
FETCH FIRST 1 ROW ONLY;
EXIT;
SQLEOF
)
MAILER_STATUS=$(echo "\$MAILER_STATUS" | tr -d '[:space:]')

case "\$MAILER_STATUS" in
  RUNNING)  log "Workflow Mailer component: RUNNING. OK." ;;
  STOPPED)  alert "Workflow Mailer component is STOPPED" ;;
  DEACTIVATED) alert "Workflow Mailer component is DEACTIVATED" ;;
  *)        alert "Workflow Mailer status unknown or not found: '\$MAILER_STATUS'" ;;
esac

# -----------------------------------------------------------------------
# CHECK 2: Outbound queue depth and age
# -----------------------------------------------------------------------
log "Checking WF_NOTIFICATION_OUT queue depth..."

QUEUE_STATS=\$(\$SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT COUNT(*) || '|' ||
       NVL(TO_CHAR(ROUND((SYSDATE - MIN(enq_time)) * 24, 2)),'0')
FROM   aq\$wf_notification_out
WHERE  msg_state = 'READY';
EXIT;
SQLEOF
)
QUEUE_STATS=$(echo "\$QUEUE_STATS" | tr -d '[:space:]')
QUEUE_DEPTH=$(echo "\$QUEUE_STATS" | cut -d'|' -f1)
OLDEST_HRS=$(echo "\$QUEUE_STATS" | cut -d'|' -f2)

log "Outbound queue: \$QUEUE_DEPTH messages, oldest = \${OLDEST_HRS}h"

if [[ "\$QUEUE_DEPTH" -gt "\$QUEUE_DEPTH_WARN" ]]; then
  alert "WF_NOTIFICATION_OUT has \$QUEUE_DEPTH pending messages (threshold: \$QUEUE_DEPTH_WARN)"
fi
if (( \$(echo "\$OLDEST_HRS > \$QUEUE_AGE_WARN_HOURS" | bc -l) )); then
  alert "Oldest message in WF_NOTIFICATION_OUT is \${OLDEST_HRS} hours old"
fi

# -----------------------------------------------------------------------
# CHECK 3: Notifications stuck in ERROR mail status
# -----------------------------------------------------------------------
log "Checking for ERROR mail status notifications..."

ERROR_COUNT=\$(\$SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT COUNT(*)
FROM   wf_notifications
WHERE  mail_status = 'ERROR'
  AND  status       = 'OPEN';
EXIT;
SQLEOF
)
ERROR_COUNT=$(echo "\$ERROR_COUNT" | tr -d '[:space:]')

if [[ "\$ERROR_COUNT" -gt 0 ]]; then
  alert "\$ERROR_COUNT open notification(s) in ERROR mail status — not being delivered"
  \$SQLPLUS <<'SQLEOF'
SET LINESIZE 150 PAGESIZE 20 HEADING ON FEEDBACK OFF
SELECT notification_id,
       recipient_role,
       TO_CHAR(begin_date,'YYYY-MM-DD HH24:MI') AS sent_date,
       mail_status
FROM   wf_notifications
WHERE  mail_status = 'ERROR'
  AND  status       = 'OPEN'
ORDER BY begin_date
FETCH FIRST 10 ROWS ONLY;
EXIT;
SQLEOF
else
  log "No ERROR mail status notifications. OK."
fi

# -----------------------------------------------------------------------
# CHECK 4: stunnel process health
# -----------------------------------------------------------------------
if [[ "\$USE_STUNNEL" == "yes" ]]; then
  log "Checking stunnel service status..."

  if systemctl is-active --quiet "\$STUNNEL_SERVICE" 2>/dev/null; then
    log "stunnel service (\$STUNNEL_SERVICE): active. OK."
  else
    alert "stunnel service '\$STUNNEL_SERVICE' is NOT active"
    # Attempt to restart
    log "Attempting to restart stunnel..."
    systemctl restart "\$STUNNEL_SERVICE" 2>/dev/null
    sleep 3
    if systemctl is-active --quiet "\$STUNNEL_SERVICE" 2>/dev/null; then
      log "stunnel restarted successfully."
    else
      alert "stunnel failed to restart — manual intervention required"
    fi
  fi

  # Check stunnel log for recent errors
  STUNNEL_LOG="/var/log/stunnel/wf_mailer.log"
  if [[ -f "\$STUNNEL_LOG" ]]; then
    STUNNEL_ERRORS=$(tail -50 "\$STUNNEL_LOG" | grep -c -i 'error\|refused\|fail' || echo "0")
    if [[ "\$STUNNEL_ERRORS" -gt 5 ]]; then
      alert "\$STUNNEL_ERRORS errors found in stunnel log (last 50 lines)"
      tail -10 "\$STUNNEL_LOG" | grep -i 'error\|refused\|fail'
    else
      log "stunnel log: \$STUNNEL_ERRORS minor error(s) in last 50 lines. OK."
    fi
  fi
else
  # NGINX check
  log "Checking NGINX service status..."
  if systemctl is-active --quiet "\$NGINX_SERVICE" 2>/dev/null; then
    log "NGINX service: active. OK."
  else
    alert "NGINX service '\$NGINX_SERVICE' is NOT active"
    systemctl restart "\$NGINX_SERVICE" 2>/dev/null
  fi
fi

# -----------------------------------------------------------------------
# CHECK 5: Live IMAP connection through proxy
# -----------------------------------------------------------------------
log "Testing IMAP connectivity through proxy at \${IMAP_PROXY_HOST}:\${IMAP_PROXY_PORT}..."

IMAP_RESPONSE=$(timeout 10 bash -c "
  echo -e 'A001 CAPABILITY\r\nA002 LOGOUT\r\n' | nc \$IMAP_PROXY_HOST \$IMAP_PROXY_PORT 2>/dev/null
" 2>/dev/null)

if echo "\$IMAP_RESPONSE" | grep -qi "CAPABILITY\|OK\|IMAP"; then
  log "IMAP proxy connection: OK (received IMAP response)"
else
  alert "IMAP proxy at \${IMAP_PROXY_HOST}:\${IMAP_PROXY_PORT} is NOT responding to connections"
  log "Response received: '\${IMAP_RESPONSE:0:100}'"
fi

# -----------------------------------------------------------------------
# CHECK 6: SMTP relay connectivity
# -----------------------------------------------------------------------
log "Testing SMTP relay at \${SMTP_RELAY_HOST}:\${SMTP_RELAY_PORT}..."

SMTP_RESPONSE=$(timeout 10 bash -c "
  echo 'QUIT' | nc \$SMTP_RELAY_HOST \$SMTP_RELAY_PORT 2>/dev/null | head -1
" 2>/dev/null)

if echo "\$SMTP_RESPONSE" | grep -q "^220"; then
  log "SMTP relay: OK (220 banner received)"
else
  alert "SMTP relay at \${SMTP_RELAY_HOST}:\${SMTP_RELAY_PORT} is NOT responding (expected 220 banner)"
  log "Response: '\${SMTP_RESPONSE:0:100}'"
fi

# -----------------------------------------------------------------------
# CHECK 7: Notifications stuck in MAIL status (queued but not dequeued)
# -----------------------------------------------------------------------
log "Checking for notifications stuck in MAIL status longer than \${QUEUE_AGE_WARN_HOURS}h..."

STUCK_MAIL=\$(\$SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT COUNT(*)
FROM   wf_notifications
WHERE  mail_status = 'MAIL'
  AND  status       = 'OPEN'
  AND  begin_date   < SYSDATE - 2/24;
EXIT;
SQLEOF
)
STUCK_MAIL=$(echo "\$STUCK_MAIL" | tr -d '[:space:]')

if [[ "\$STUCK_MAIL" -gt 0 ]]; then
  alert "\$STUCK_MAIL notification(s) in MAIL status for >\${QUEUE_AGE_WARN_HOURS}h — Mailer may not be dequeuing"
else
  log "No long-stuck MAIL status notifications. OK."
fi

# -----------------------------------------------------------------------
# CHECK 8: NGINX connection pool saturation (if using NGINX)
# -----------------------------------------------------------------------
if [[ "\$USE_STUNNEL" != "yes" ]]; then
  log "Checking NGINX active connections..."
  if command -v curl &>/dev/null; then
    NGINX_STATUS=$(curl -s --max-time 5 http://127.0.0.1/nginx_status 2>/dev/null)
    if [[ -n "\$NGINX_STATUS" ]]; then
      ACTIVE_CONN=$(echo "\$NGINX_STATUS" | grep 'Active connections' | awk '{print \$3}')
      log "NGINX active connections: \$ACTIVE_CONN"
      if [[ "\$ACTIVE_CONN" -gt 500 ]]; then
        alert "NGINX active connections (\$ACTIVE_CONN) may indicate connection pool saturation"
      fi
    fi
  fi
fi

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
log "=== Monitor Complete: \$FAILURES alert(s) ==="

if [[ "\$FAILURES" -gt 0 ]]; then
  echo ""
  echo "ACTION REQUIRED: \$FAILURES issue(s) detected. See \$ALERT_LOG"
  exit 1
else
  log "All Workflow Mailer and proxy checks passed."
  exit 0
fi
\`\`\`

### Install and schedule

\`\`\`bash
chmod +x /usr/local/bin/wf_mailer_monitor.sh

# Add to applmgr crontab — every 5 minutes
crontab -e
\`\`\`

\`\`\`
*/5 * * * * /usr/local/bin/wf_mailer_monitor.sh EBSPRD apps >> /var/log/wf_mailer_monitor.log 2>&1
\`\`\`

For email alerts on failure:

\`\`\`
*/5 * * * * /usr/local/bin/wf_mailer_monitor.sh EBSPRD apps 2>&1 | grep -q 'ACTION REQUIRED' && \
  /usr/local/bin/wf_mailer_monitor.sh EBSPRD apps | mailx -s "WF Mailer Alert - $(hostname)" dba-alerts@company.com
\`\`\`

---

## Quick Diagnostic Queries

### What has the Mailer delivered in the last hour?

\`\`\`sql
SELECT mail_status,
       COUNT(*)                          AS count,
       MIN(begin_date)                   AS earliest,
       MAX(begin_date)                   AS latest
FROM   wf_notifications
WHERE  begin_date > SYSDATE - 1/24
GROUP BY mail_status
ORDER BY count DESC;
\`\`\`

### Find recipients who have not received recent notifications

\`\`\`sql
SELECT n.recipient_role,
       COUNT(*)                           AS stuck_count,
       MIN(n.begin_date)                  AS oldest
FROM   wf_notifications n
WHERE  n.mail_status IN ('MAIL','ERROR')
  AND  n.status        = 'OPEN'
  AND  n.begin_date    < SYSDATE - 4/24
GROUP BY n.recipient_role
ORDER BY stuck_count DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

### Check proxy configuration currently in use by the Mailer

\`\`\`sql
SELECT parameter_name, text_value, number_value
FROM   wf_mailer_parameters
WHERE  parameter_name IN (
         'INBOUND_SERVER','INBOUND_PORT','INBOUND_USE_SSL',
         'OUTBOUND_SERVER','OUTBOUND_PORT','FROM'
       )
ORDER BY parameter_name;
\`\`\`

---

## Troubleshooting Table

| Symptom | Check | Fix |
|---------|-------|-----|
| \`MAIL_STATUS = SENT\` but no email received | SMTP relay → M365 delivery | Check relay mail logs; test with \`sendmail\` directly |
| Notifications stuck in \`MAIL\` status | Mailer component stopped or IMAP proxy down | Check Monitor Check 1 and Check 4/5; restart Mailer |
| \`ERROR\` mail status accumulating | IMAP auth failure or proxy rejecting connections | Run Check 5 (IMAP proxy test); verify credentials |
| stunnel exits after hours of operation | Memory or connection leak in older stunnel versions | Add \`socket = l:SO_KEEPALIVE=1\` to stunnel config |
| NGINX drops connections under load | No proxy_timeout configured | Add \`proxy_timeout 300s; proxy_connect_timeout 10s;\` |
| Mailer starts then immediately stops | Parameter misconfiguration | Check Mailer log for \`IMAP connection refused\` or auth errors |
| WF queue rebuild did not clear backlog | WF_NOTIFICATIONS rows still in MAIL status | Reset with \`UPDATE wf_notifications SET mail_status='MAIL'\` |
| proxy survives restart but not server reboot | systemd unit not enabled | \`systemctl enable stunnel-wf-mailer\` |`,
};

async function main() {
  console.log('Inserting EBS Workflow Mailer M365 runbook...');
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
