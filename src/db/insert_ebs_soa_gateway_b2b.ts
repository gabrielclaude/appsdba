import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const blogPost = {
  title: 'Oracle EBS 12.2 Integrated SOA Gateway: B2B-50079 Transport Error Diagnosis and Fix',
  slug: 'ebs-12-2-integrated-soa-gateway-b2b-50079',
  excerpt:
    'When Oracle EBS 12.2 Integrated SOA Gateway throws B2B-50079 with an HTTP 500 from OHS, the web tier is rejecting the request before it reaches WebLogic. This post explains the full component topology, the three most common root causes, and how to isolate and fix each one.',
  category: 'ebs-suite' as const,
  published: true,
  publishedAt: new Date('2026-06-03'),
  isPremium: false,
  youtubeUrl: null,
  content: `The error message \`B2B-50079: Transport error: [IPT_HttpSendError] HTTP encounters send error :500\` followed by a raw HTML page from OHS is one of the more disorienting failures you can hit in Oracle EBS 12.2 B2B integration. The HTML itself — a plain Apache-style 500 page — tells you the web tier is the one throwing the error, not the application. This post explains why, what the full component stack looks like, and how to fix the three most common causes.

---

## Component Topology

Understanding where the failure occurs requires a clear picture of how requests flow through EBS 12.2 and its SOA integration layer.

### EBS 12.2 Web Tier Stack

\`\`\`
Inbound HTTP/HTTPS Request
         │
         ▼
  ┌──────────────┐
  │  OHS (Oracle │  ← Oracle HTTP Server (Apache-derived)
  │  HTTP Server)│    Termination point for SSL/TLS
  └──────┬───────┘    mod_wl_ohs routes to WebLogic backends
         │
  mod_wl_ohs.conf directives
         │
   ┌─────▼──────────────────────────────────────────────┐
   │              WebLogic Domain                        │
   │  ┌────────────┐  ┌────────────┐  ┌───────────────┐ │
   │  │  oacore    │  │  oafm      │  │  soa_server   │ │
   │  │ (EBS core) │  │ (ISG/B2B)  │  │ (SOA Suite)   │ │
   │  └────────────┘  └────────────┘  └───────────────┘ │
   └─────────────────────────────────────────────────────┘
         │
         ▼
  Oracle Database (EBS schema + SOAINFRA schema)
\`\`\`

### Integrated SOA Gateway (ISG) Components

Oracle EBS 12.2 ships with **Integrated SOA Gateway** — a built-in integration framework that exposes EBS business services (PL/SQL APIs, concurrent programs, Oracle objects) as web services without requiring a separate SOA Suite licence.

| Component | Location | Purpose |
|---|---|---|
| **ISG Framework** | EBS application tier (oafm managed server) | Hosts deployed web service endpoints |
| **Integration Repository** | EBS database | Metadata for all published interfaces |
| **B2B Transport Layer** | oafm / SOA managed server | Handles inbound and outbound B2B messages |
| **OHS mod_wl_ohs** | Web tier | Routes /webservices/* and /b2b/* URIs to WebLogic |
| **OHS Wallet (cwallet.sso)** | Web tier (\`/etc/ORACLE/WALLETS/\` or instance dir) | SSL certificates for HTTPS termination |

### How ISG Web Service Calls Travel Outbound

When EBS triggers an outbound B2B call (e.g., sending an EDI document or invoking an external web service through an ISG interface):

1. The EBS concurrent request or PL/SQL API hands the payload to the **B2B transport engine** in the oafm managed server.
2. The transport engine resolves the trading partner endpoint — an HTTPS URL.
3. It opens an outbound HTTPS connection. If the destination URL is routed through OHS (e.g., an internal service), OHS is in the path.
4. OHS receives the outbound request, applies its SSL wallet and routing rules, and forwards to the backend.
5. If OHS cannot complete the handoff — SSL failure, backend down, routing misconfiguration — it returns its own 500 HTML error page.
6. The B2B engine receives the 500 HTML and surfaces it as **B2B-50079**.

The key diagnostic insight is: **the 500 HTML comes from OHS, not from the application**. The error message body (\`<!DOCTYPE HTML PUBLIC...>\`) is an OHS-generated error page, not an application exception.

---

## The B2B-50079 Error

The full error:

\`\`\`
B2B-50079: Transport error: [IPT_HttpSendError] HTTP encounters send error :500
<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">
<HTML><HEAD>
<TITLE>500 Internal Server Error</TITLE>
</HEAD>...
\`\`\`

This error has three primary causes. They are not mutually exclusive — after an adop patching cycle, you can hit all three simultaneously.

---

## Cause 1: WebLogic Backend Down or Overloaded

OHS is the front door. If the WebLogic managed servers behind it (oafm_server1, soa_server1) are not running, OHS has nowhere to send the request and returns 500.

**What to check:**

In the WebLogic Admin Console (\`http://admin-host:7001/console\`):
- Navigate to **Environment → Servers**
- Check the state of **oafm_server1** and **soa_server1**
- State must be **RUNNING**, not WARNING, FAILED, or STARTING

**What to look for in managed server logs:**

\`\`\`
OutOfMemoryError: Java heap space
\`\`\`
\`\`\`
weblogic.application.ModuleException
\`\`\`
\`\`\`
Stuck thread: "ExecuteThread" is stuck for N seconds
\`\`\`

Any of these indicates the managed server accepted connections but cannot process them — OHS gets a 500 or connection timeout from WebLogic and relays it.

**Fix:**

Increase heap if OOM is the cause (edit \`setUserOverrides.sh\` in the domain bin directory). Clear stuck threads by bouncing the managed server. For a quick restart:

\`\`\`bash
# Restart oafm managed server via admanagedsrvctl.sh
$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh stop oafm_server1
$ADMIN_SCRIPTS_HOME/admanagedsrvctl.sh start oafm_server1
\`\`\`

---

## Cause 2: SSL/TLS Certificate Failure (Most Common for B2B)

B2B traffic is almost always over HTTPS. OHS terminates SSL using a wallet (\`cwallet.sso\`). If that wallet is missing the server certificate, contains an expired certificate, or is missing a CA chain (root or intermediate), OHS will fail the handshake and return 500.

This is the **most common cause** after a certificate renewal or OS migration.

**What to look for in the OHS error log:**

\`\`\`
SSL handshake failed
\`\`\`
\`\`\`
[error] [client x.x.x.x] SSL library error 1 in handshake (server hostname:port)
certificate verify failed
\`\`\`
\`\`\`
[warn] RSA server certificate is a CA certificate (BasicConstraints: CA == TRUE)
\`\`\`

**OHS error log location in EBS 12.2:**

\`\`\`
$EBS_DOMAIN_HOME/config/fmwconfig/components/OHS/instances/<ohs_component>/logs/error_log
\`\`\`

or the symlinked path under the instance home:

\`\`\`
$INST_TOP/logs/ora/10.1.3/Apache/error_log
\`\`\`

**Fix — re-import the certificate chain into the OHS wallet:**

\`\`\`bash
# List current wallet contents
orapki wallet display -wallet /etc/ORACLE/WALLETS/ohs

# Import root CA
orapki wallet add -wallet /etc/ORACLE/WALLETS/ohs \
  -trusted_cert -cert /path/to/root_ca.crt -auto_login_only

# Import intermediate CA (if present)
orapki wallet add -wallet /etc/ORACLE/WALLETS/ohs \
  -trusted_cert -cert /path/to/intermediate_ca.crt -auto_login_only

# Import server certificate and private key (if renewing)
orapki wallet add -wallet /etc/ORACLE/WALLETS/ohs \
  -user_cert -cert /path/to/server.crt -auto_login_only

# Restart OHS after wallet changes
$ADMIN_SCRIPTS_HOME/adopmnctl.sh stop
$ADMIN_SCRIPTS_HOME/adopmnctl.sh start
\`\`\`

---

## Cause 3: Corrupted or Mismatched mod_wl_ohs.conf

In EBS 12.2, the \`mod_wl_ohs.conf\` file is **generated by AutoConfig**. During an adop patching cycle, the templates for this file can be updated, but if AutoConfig was not run after the patch (or ran but failed mid-way), the routing directives may point to wrong ports, wrong hostnames, or missing Location blocks for the B2B or ISG context roots.

**What to look for in mod_wl_ohs.conf:**

\`\`\`
# Location block for ISG / B2B should exist:
<Location /webservices>
  SetHandler weblogic-handler
  WebLogicCluster oafm-host:oafm-port
</Location>

<Location /b2b>
  SetHandler weblogic-handler
  WebLogicCluster soa-host:soa-port
</Location>
\`\`\`

If these blocks are absent or point to incorrect ports, OHS cannot route the request and returns 500.

**Also check the WebLogic plugin timeout:**

\`\`\`
<IfModule weblogic_module>
  ConnectTimeoutSecs     10
  ConnectRetrySecs       2
  WLIOTimeoutSecs        300   ← increase for long-running B2B transactions
  KeepAliveEnabled       ON
  KeepAliveSecs          20
</IfModule>
\`\`\`

A low \`WLIOTimeoutSecs\` causes OHS to abandon a slow WebLogic response and return 500 — indistinguishable from a backend-down scenario in the error log.

**Fix — regenerate mod_wl_ohs.conf via AutoConfig:**

\`\`\`bash
# On the EBS web tier (apptier)
source /u01/install/APPS/EBSapps.env run
$ADMIN_SCRIPTS_HOME/adautocfg.sh
# Enter APPS password when prompted
# Restart OHS after AutoConfig completes
$ADMIN_SCRIPTS_HOME/adopmnctl.sh stop
$ADMIN_SCRIPTS_HOME/adopmnctl.sh start
\`\`\`

---

## Verify the ISG Service is Deployed

Before chasing OHS issues, confirm the ISG interface itself is active:

1. In EBS: **Integrated SOA Gateway → Integration Repository**
2. Search for the interface by name or product
3. Status must be **Active** and **Deployed**
4. If it shows **Undeployed**: click **Deploy** and monitor the concurrent request

---

## Best Practices

### Certificate Lifecycle Management

- Store certificate expiry dates in a shared calendar or monitoring tool. OHS wallet certificates do not auto-renew — when they expire, all SSL-terminated B2B traffic stops.
- After any certificate renewal, always verify with \`orapki wallet display\` before restarting OHS.
- Keep the wallet in a consistent path defined by AutoConfig context variables (\`s_wallet_dir\`) so that AutoConfig always regenerates wallet references correctly.

### Post-Patch Discipline

- After every adop patch cycle, run AutoConfig on both the application tier and the web tier, even if the patch notes do not mention OHS. Many patches update FMW configuration templates.
- Verify managed server status after adop \`cutover\` and \`cleanup\` phases — the cutover can leave managed servers in a restart-required state.
- Check ISG deployed interfaces after a major patch — schema changes can require re-deploying ISG endpoints.

### Managed Server Sizing

- oafm_server1 handles ISG and B2B traffic. Default heap settings in EBS 12.2 templates are conservative. Monitor heap usage under load and set \`-Xmx\` in \`setUserOverrides.sh\` rather than editing the generated startup scripts (which AutoConfig will overwrite).
- Set JVM GC logging (\`-Xloggc:/path/gc.log -XX:+PrintGCDetails\`) on oafm and soa_server to detect OOM-induced slowdowns before they manifest as B2B-50079 errors.

### Transport Timeouts

- Match \`WLIOTimeoutSecs\` in mod_wl_ohs.conf to the longest expected B2B transaction. For EDI or large payload scenarios, 300s is a common starting point. This must be less than the browser/client TCP timeout to avoid phantom retries.
- Set matching read timeouts in the trading partner endpoint configuration in the B2B console.

### Proactive Monitoring

- Schedule a health check every 4 hours (see the companion runbook) that queries ISG error tables, checks OHS process status, validates certificate expiry, and checks managed server state via WLST.
- Alert on B2B error counts crossing a threshold before users notice failures.
`,
};

const runbookPost = {
  title: 'Oracle EBS 12.2 Integrated SOA Gateway Health Check Runbook',
  slug: 'ebs-12-2-integrated-soa-gateway-health-check-runbook',
  excerpt:
    'Runbook for diagnosing and resolving B2B-50079 transport errors in Oracle EBS 12.2 Integrated SOA Gateway — covering OHS log analysis, SSL wallet validation, mod_wl_ohs.conf regeneration, and a 4-hour cron monitoring script that queries ISG error tables and checks the full stack.',
  category: 'ebs-suite' as const,
  published: true,
  publishedAt: new Date('2026-06-03'),
  isPremium: true,
  youtubeUrl: null,
  content: `# Oracle EBS 12.2 Integrated SOA Gateway Health Check Runbook

## Overview

This runbook covers diagnosis and resolution of B2B-50079 transport errors in Oracle EBS 12.2, including a schedulable monitoring script that checks the full ISG/B2B stack every 4 hours and alerts on anomalies.

**Environment assumptions:**
- EBS 12.2.x application tier and web tier on Linux
- WebLogic domain at \`\$EBS_DOMAIN_HOME\`
- OHS component at \`\$EBS_DOMAIN_HOME/config/fmwconfig/components/OHS/instances/ohs1\`
- Oracle DB connection via \`TWO_TASK\` / standard EBS env
- Oracle wallet at \`/etc/ORACLE/WALLETS/ohs\` (adjust to your site)

---

## Script 1 — OHS Error Log Analysis

\`\`\`bash
#!/bin/bash
# isg_ohs_log_analysis.sh  — run as oracle or applmgr on the EBS web tier
# Tails and scans the OHS error log for B2B/ISG-related failures.
set -euo pipefail

# ── Source EBS environment ────────────────────────────────────────────────────
EBS_ENV=\${EBS_ENV:-/u01/install/APPS/EBSapps.env}
if [[ -f "\$EBS_ENV" ]]; then
  source "\$EBS_ENV" run 2>/dev/null || true
fi

OHS_COMPONENT=\${OHS_COMPONENT:-ohs1}
OHS_LOG_DIR=\${EBS_DOMAIN_HOME}/config/fmwconfig/components/OHS/instances/\${OHS_COMPONENT}/logs

# Fallback to older EBS instance path if domain home not set
if [[ ! -d "\$OHS_LOG_DIR" ]]; then
  OHS_LOG_DIR=\${INST_TOP:-/u01/install/APPS}/logs/ora/10.1.3/Apache
fi

ERROR_LOG=\${OHS_LOG_DIR}/error_log
ACCESS_LOG=\${OHS_LOG_DIR}/access_log

HOURS_BACK=\${1:-4}   # default: scan last 4 hours
TIMESTAMP_FROM=$(date -d "-\${HOURS_BACK} hours" '+%Y-%m-%d %H:%M' 2>/dev/null || \
                 date -v -\${HOURS_BACK}H '+%Y-%m-%d %H:%M')   # GNU / BSD date

echo "===== OHS Error Log Analysis ====="
echo "Log dir : \$OHS_LOG_DIR"
echo "Period  : last \${HOURS_BACK} hours (from \$TIMESTAMP_FROM)"
echo ""

if [[ ! -f "\$ERROR_LOG" ]]; then
  echo "ERROR: OHS error_log not found at \$ERROR_LOG"
  echo "Check OHS_COMPONENT and EBS_DOMAIN_HOME environment variables."
  exit 1
fi

# ── Recent error count ────────────────────────────────────────────────────────
echo "[1] Recent error summary (last \${HOURS_BACK}h)"
tail -n 5000 "\$ERROR_LOG" | grep -cE '\[error\]|\[crit\]|\[alert\]' || echo "0 errors found"
echo ""

# ── B2B / ISG context errors ──────────────────────────────────────────────────
echo "[2] B2B and /webservices context errors"
tail -n 5000 "\$ERROR_LOG" | grep -iE '/b2b|/webservices|mod_wl_ohs|weblogic' | \
  grep -iE 'error|fail|refused|timeout|500|503' | tail -30 || echo "None found."
echo ""

# ── SSL errors ────────────────────────────────────────────────────────────────
echo "[3] SSL/TLS errors"
tail -n 5000 "\$ERROR_LOG" | grep -iE 'ssl|handshake|certificate|wallet|cwallet' | \
  tail -20 || echo "None found."
echo ""

# ── Backend connection failures (mod_wl_ohs) ─────────────────────────────────
echo "[4] WebLogic backend connection failures"
tail -n 5000 "\$ERROR_LOG" | grep -iE 'connect.*fail|refused|no backend|no server' | \
  tail -20 || echo "None found."
echo ""

# ── Recent 500s in access log ─────────────────────────────────────────────────
echo "[5] Recent HTTP 500 responses in access log"
if [[ -f "\$ACCESS_LOG" ]]; then
  tail -n 10000 "\$ACCESS_LOG" | awk '\$9 == "500"' | tail -20 || echo "No 500s found."
else
  echo "Access log not found at \$ACCESS_LOG"
fi

echo ""
echo "===== OHS log analysis complete ====="
\`\`\`

---

## Script 2 — SSL Wallet Certificate Validation

\`\`\`bash
#!/bin/bash
# isg_cert_check.sh  — run as oracle on the EBS web tier
# Validates the OHS wallet and warns on certificates expiring within 60 days.
set -euo pipefail

WALLET_DIR=\${OHS_WALLET_DIR:-/etc/ORACLE/WALLETS/ohs}
WARN_DAYS=60
ORACLE_HOME_ORAPKI=\${ORACLE_HOME:-/u01/app/oracle/product/19.0.0/dbhome_1}

# orapki may live in FMW OHS home, not the DB home
ORAPKI=$(find /u01 -name orapki -type f 2>/dev/null | head -1)
ORAPKI=\${ORAPKI:-\$ORACLE_HOME_ORAPKI/bin/orapki}

echo "===== OHS Wallet Certificate Check ====="
echo "Wallet  : \$WALLET_DIR"
echo "Warn at : \$WARN_DAYS days to expiry"
echo ""

if [[ ! -d "\$WALLET_DIR" ]]; then
  echo "ERROR: Wallet directory not found: \$WALLET_DIR"
  exit 1
fi

# ── Display wallet contents ───────────────────────────────────────────────────
echo "[1] Wallet contents"
"\$ORAPKI" wallet display -wallet "\$WALLET_DIR" 2>&1
echo ""

# ── Check certificate expiry using openssl ────────────────────────────────────
echo "[2] Certificate expiry check"
for CERT_FILE in "\$WALLET_DIR"/*.p12 "\$WALLET_DIR"/*.pem "\$WALLET_DIR"/*.crt; do
  [[ -f "\$CERT_FILE" ]] || continue
  EXPIRY=$(openssl x509 -in "\$CERT_FILE" -noout -enddate 2>/dev/null | cut -d= -f2)
  [[ -z "\$EXPIRY" ]] && continue
  EXPIRY_EPOCH=$(date -d "\$EXPIRY" +%s 2>/dev/null || date -j -f "%b %d %T %Y %Z" "\$EXPIRY" +%s)
  NOW_EPOCH=$(date +%s)
  DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))
  if (( DAYS_LEFT <= WARN_DAYS )); then
    echo "  WARNING: \$CERT_FILE expires in \$DAYS_LEFT days (\$EXPIRY)"
  else
    echo "  OK     : \$CERT_FILE — \$DAYS_LEFT days remaining (\$EXPIRY)"
  fi
done

# ── Test TLS connectivity to the B2B endpoint ────────────────────────────────
B2B_HOST=\${B2B_ENDPOINT_HOST:-localhost}
B2B_PORT=\${B2B_ENDPOINT_PORT:-443}
echo ""
echo "[3] TLS connectivity test to \${B2B_HOST}:\${B2B_PORT}"
timeout 10 openssl s_client -connect "\${B2B_HOST}:\${B2B_PORT}" -brief 2>&1 | \
  grep -E 'Protocol|Cipher|Verify|CONNECTED|error' || echo "Connection test failed — check host/port."

echo ""
echo "===== Certificate check complete ====="
\`\`\`

---

## Script 3 — mod_wl_ohs.conf Validation

\`\`\`bash
#!/bin/bash
# isg_mod_wl_check.sh  — run as oracle on the EBS web tier
# Validates that the B2B and ISG Location blocks exist and point to live WebLogic ports.
set -euo pipefail

OHS_COMPONENT=\${OHS_COMPONENT:-ohs1}
EBS_ENV=\${EBS_ENV:-/u01/install/APPS/EBSapps.env}
[[ -f "\$EBS_ENV" ]] && source "\$EBS_ENV" run 2>/dev/null || true

CONF_DIR=\${EBS_DOMAIN_HOME}/config/fmwconfig/components/OHS/instances/\${OHS_COMPONENT}/config
MOD_WL_CONF=\${CONF_DIR}/mod_wl_ohs.conf

echo "===== mod_wl_ohs.conf Validation ====="
echo "Config file: \$MOD_WL_CONF"
echo ""

if [[ ! -f "\$MOD_WL_CONF" ]]; then
  echo "ERROR: mod_wl_ohs.conf not found at \$MOD_WL_CONF"
  echo "Try: find \$EBS_DOMAIN_HOME -name mod_wl_ohs.conf 2>/dev/null"
  exit 1
fi

# ── Check required Location blocks ───────────────────────────────────────────
echo "[1] Required Location blocks"
for CONTEXT in "/webservices" "/b2b" "/oafm" "/soa-infra"; do
  if grep -q "Location \${CONTEXT}" "\$MOD_WL_CONF" 2>/dev/null; then
    CLUSTER_LINE=$(grep -A5 "Location \${CONTEXT}" "\$MOD_WL_CONF" | grep -i 'WebLogicCluster\|WebLogicHost')
    echo "  FOUND  : \$CONTEXT  →  \$CLUSTER_LINE"
  else
    echo "  MISSING: \$CONTEXT  ← may cause 404 or 500 for ISG/B2B requests"
  fi
done
echo ""

# ── Check timeout settings ────────────────────────────────────────────────────
echo "[2] WebLogic plugin timeout settings"
grep -iE 'WLIOTimeoutSecs|ConnectTimeoutSecs|WLSocketTimeoutSecs' "\$MOD_WL_CONF" || \
  echo "  No explicit timeout settings found — defaults apply (may be too short for B2B)"
echo ""

# ── Test connectivity from OHS host to each WebLogic backend ─────────────────
echo "[3] TCP connectivity to WebLogic backends listed in mod_wl_ohs.conf"
grep -oE '[a-zA-Z0-9._-]+:[0-9]+' "\$MOD_WL_CONF" | sort -u | while read HOST_PORT; do
  HOST=$(echo "\$HOST_PORT" | cut -d: -f1)
  PORT=$(echo "\$HOST_PORT" | cut -d: -f2)
  [[ "\$PORT" -lt 1024 ]] && continue   # skip port 80/443 OHS entries
  if nc -z -w 3 "\$HOST" "\$PORT" 2>/dev/null; then
    echo "  OPEN   : \$HOST:\$PORT"
  else
    echo "  CLOSED : \$HOST:\$PORT  ← WebLogic managed server may be down"
  fi
done

echo ""
echo "===== mod_wl_ohs.conf check complete ====="
\`\`\`

---

## Script 4 — WebLogic Managed Server Status via WLST

\`\`\`bash
#!/bin/bash
# isg_wl_server_status.sh  — run as oracle on the EBS application tier
# Uses WLST to query managed server state and heap usage.
set -euo pipefail

EBS_ENV=\${EBS_ENV:-/u01/install/APPS/EBSapps.env}
[[ -f "\$EBS_ENV" ]] && source "\$EBS_ENV" run 2>/dev/null || true

WL_HOME=\${WL_HOME:-\$EBS_DOMAIN_HOME/../../wlserver}
WLST=\${WLST:-\$(find /u01 -name wlst.sh 2>/dev/null | head -1)}
ADMIN_URL=\${WL_ADMIN_URL:-t3://localhost:7001}

read -rsp "Enter WebLogic admin password: " WL_PASS; echo

echo "===== WebLogic Managed Server Status ====="
echo "Admin URL: \$ADMIN_URL"
echo ""

"\$WLST" /dev/stdin <<WLSTEOF
import sys

connect('weblogic', '\$WL_PASS', '\$ADMIN_URL')

print("\\n[1] Managed Server States")
print("-" * 60)
domainConfig()
servers = cmo.getServers()
serverRuntime()
cd('/')

for srv in servers:
    sname = srv.getName()
    try:
        cd('/ServerLifeCycleRuntimes/' + sname)
        state = cmo.getState()
        cd('/')
        cd('/ServerRuntimes/' + sname)
        heap_used  = cmo.getJVMRuntime().getHeapSizeCurrent() / 1048576
        heap_max   = cmo.getJVMRuntime().getHeapSizeMax()    / 1048576
        heap_pct   = int(heap_used * 100 / heap_max) if heap_max > 0 else 0
        cd('/')
        flag = "WARNING" if heap_pct > 80 else "OK"
        print("  %-25s  state=%-12s  heap=%d/%dMB (%d%%)  [%s]" % (sname, state, heap_used, heap_max, heap_pct, flag))
    except Exception as e:
        print("  %-25s  state=UNKNOWN  (admin server only or not running)" % sname)
        cd('/')

print("\\n[2] Stuck Threads")
print("-" * 60)
serverRuntime()
cd('/')
for srv in servers:
    sname = srv.getName()
    try:
        cd('/ServerRuntimes/' + sname + '/ThreadPoolRuntime/ThreadPoolRuntime')
        stuck = cmo.getStuckThreadCount()
        active = cmo.getExecuteThreadTotalCount()
        idle   = cmo.getIdleThreadCount()
        cd('/')
        flag = "WARNING" if stuck > 0 else "OK"
        print("  %-25s  stuck=%d  active=%d  idle=%d  [%s]" % (sname, stuck, active, idle, flag))
    except Exception:
        cd('/')

disconnect()
exit()
WLSTEOF

echo ""
echo "===== WebLogic status check complete ====="
\`\`\`

---

## Script 5 — ISG B2B Error Query (SQL)

Save this as \`isg_b2b_errors.sql\` — called by the monitoring script in Script 6.

\`\`\`sql
-- isg_b2b_errors.sql
-- Queries ISG and B2B error tables in the EBS schema.
-- Run as APPS user via SQL*Plus.
-- Parameterised: HOURS_BACK substitution variable (default 4).

define HOURS_BACK = &1

set lines 200 pages 100 feedback off trimspool on
set colsep '|'
col msg_id         format a36
col msg_type       format a20
col direction      format a10
col state          format a15
col error_text     format a80
col created_time   format a22
col trading_partner format a30

prompt
prompt ===================================================================
prompt ISG B2B Error Report — last &&HOURS_BACK hours
prompt Generated: &_DATE
prompt ===================================================================
prompt

-- ── B2B Message errors ───────────────────────────────────────────────────────
prompt [1] B2B Messages in ERROR state (last &&HOURS_BACK hours)
prompt -------------------------------------------------------------------
select
  m.msg_id,
  m.msg_type,
  m.direction,
  m.state,
  to_char(m.created_time, 'YYYY-MM-DD HH24:MI:SS') as created_time,
  substr(e.error_text, 1, 80) as error_text
from
  b2b_message_store m
  left join b2b_data_storage e on m.msg_id = e.msg_id
where
  m.state in ('MSG_ERROR','TRANSPORT_ERROR','APP_ERROR')
  and m.created_time >= sysdate - &&HOURS_BACK/24
order by
  m.created_time desc
fetch first 50 rows only;

prompt
prompt [2] B2B Error count by type (last &&HOURS_BACK hours)
prompt -------------------------------------------------------------------
select
  state,
  msg_type,
  count(*) as error_count
from
  b2b_message_store
where
  state like '%ERROR%'
  and created_time >= sysdate - &&HOURS_BACK/24
group by
  state, msg_type
order by
  error_count desc;

prompt
prompt [3] ISG Web Service Invocation Errors (last &&HOURS_BACK hours)
prompt -------------------------------------------------------------------
select
  to_char(error_time, 'YYYY-MM-DD HH24:MI:SS') as error_time,
  interface_name,
  error_code,
  substr(error_message, 1, 80) as error_message,
  request_id
from
  jtf_isg_service_log
where
  status = 'E'
  and error_time >= sysdate - &&HOURS_BACK/24
order by
  error_time desc
fetch first 50 rows only;

prompt
prompt [4] Recent successful B2B messages (last &&HOURS_BACK hours — confirm traffic is flowing)
prompt -------------------------------------------------------------------
select
  state,
  direction,
  count(*) as msg_count,
  min(to_char(created_time,'HH24:MI:SS')) as first_msg,
  max(to_char(created_time,'HH24:MI:SS')) as last_msg
from
  b2b_message_store
where
  created_time >= sysdate - &&HOURS_BACK/24
group by
  state, direction
order by
  msg_count desc;

prompt
prompt [5] B2B Trading Partner error breakdown (last &&HOURS_BACK hours)
prompt -------------------------------------------------------------------
select
  tp_id,
  count(*) as error_count,
  max(to_char(created_time,'YYYY-MM-DD HH24:MI:SS')) as last_error
from
  b2b_message_store
where
  state like '%ERROR%'
  and created_time >= sysdate - &&HOURS_BACK/24
group by
  tp_id
order by
  error_count desc
fetch first 20 rows only;

prompt
prompt ===================================================================
prompt End of report
prompt ===================================================================
exit;
\`\`\`

---

## Script 6 — ISG/B2B 4-Hour Monitoring Script

This is the main monitoring script. It calls the SQL above, checks OHS process status, validates certificate expiry, and emails an alert when error thresholds are crossed. Schedule via cron every 4 hours.

\`\`\`bash
#!/bin/bash
# isg_b2b_monitor.sh
# Monitors the EBS 12.2 Integrated SOA Gateway / B2B stack.
# Schedule: 0 */4 * * * oracle /path/to/isg_b2b_monitor.sh >> /var/log/oracle/isg_monitor.log 2>&1
#
# Usage:
#   isg_b2b_monitor.sh [--dry-run] [--hours N] [--alert-email addr] [--log-dir /path]
#
# Password: store APPS password in ~/.oracle_apps_pass (chmod 400, owned by oracle)
#           echo "myappspassword" > ~/.oracle_apps_pass && chmod 400 ~/.oracle_apps_pass

set -euo pipefail

# ── Defaults ─────────────────────────────────────────────────────────────────
DRY_RUN=false
HOURS_BACK=4
ALERT_EMAIL=\${ALERT_EMAIL:-""}
LOG_DIR=\${LOG_DIR:-/var/log/oracle/isg}
EBS_ENV=\${EBS_ENV:-/u01/install/APPS/EBSapps.env}
OHS_COMPONENT=\${OHS_COMPONENT:-ohs1}
CERT_WARN_DAYS=60
ERROR_THRESHOLD=5     # alert if more than this many B2B errors in the period
PASS_FILE=\${HOME}/.oracle_apps_pass

# ── Parse arguments ───────────────────────────────────────────────────────────
while [[ \$# -gt 0 ]]; do
  case "\$1" in
    --dry-run)       DRY_RUN=true ;;
    --hours)         HOURS_BACK="\$2"; shift ;;
    --alert-email)   ALERT_EMAIL="\$2"; shift ;;
    --log-dir)       LOG_DIR="\$2"; shift ;;
    *) echo "Unknown option: \$1"; exit 1 ;;
  esac
  shift
done

# ── Setup ─────────────────────────────────────────────────────────────────────
mkdir -p "\$LOG_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOGFILE=\${LOG_DIR}/isg_monitor_\${TIMESTAMP}.log
SUMMARY_FILE=\${LOG_DIR}/isg_summary_\${TIMESTAMP}.txt
SCRIPT_DIR=$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)
SQL_SCRIPT=\${SCRIPT_DIR}/isg_b2b_errors.sql

exec > >(tee -a "\$LOGFILE") 2>&1

echo "============================================================"
echo "ISG/B2B Monitor — \$(date '+%Y-%m-%d %H:%M:%S')"
echo "Dry run  : \$DRY_RUN"
echo "Period   : last \${HOURS_BACK} hours"
echo "Log file : \$LOGFILE"
echo "============================================================"

# ── Source EBS environment ────────────────────────────────────────────────────
if [[ -f "\$EBS_ENV" ]]; then
  source "\$EBS_ENV" run 2>/dev/null || true
  echo "[env] EBS environment sourced from \$EBS_ENV"
else
  echo "[WARN] EBS environment file not found: \$EBS_ENV — set manually or adjust EBS_ENV"
fi

ALERTS=()   # accumulate alert messages

# ════════════════════════════════════════════════════════════════
# STEP 1: OHS PROCESS CHECK
# ════════════════════════════════════════════════════════════════
echo ""
echo "── Step 1: OHS Process Status ──────────────────────────────"

OHS_LOG_DIR=\${EBS_DOMAIN_HOME:-}/config/fmwconfig/components/OHS/instances/\${OHS_COMPONENT}/logs
[[ ! -d "\$OHS_LOG_DIR" ]] && OHS_LOG_DIR=\${INST_TOP:-/tmp}/logs/ora/10.1.3/Apache

# Check if OHS httpd process is running
OHS_PID_COUNT=$(pgrep -c -f "httpd.*ohs" 2>/dev/null || echo 0)
if [[ "\$OHS_PID_COUNT" -eq 0 ]]; then
  echo "[CRITICAL] OHS httpd processes not found — OHS may be down"
  ALERTS+=("CRITICAL: OHS httpd process not running")
else
  echo "[OK] OHS httpd processes running (count: \$OHS_PID_COUNT)"
fi

# OHS error log — recent error count
ERROR_LOG=\${OHS_LOG_DIR}/error_log
if [[ -f "\$ERROR_LOG" ]]; then
  OHS_ERROR_COUNT=$(tail -n 5000 "\$ERROR_LOG" | grep -cE '\[error\]|\[crit\]' || true)
  B2B_ERROR_COUNT=$(tail -n 5000 "\$ERROR_LOG" | grep -icE '/b2b|mod_wl_ohs|weblogic' | grep -icE 'error|fail|500' || true)
  echo "[INFO] OHS error_log: \$OHS_ERROR_COUNT recent errors; \$B2B_ERROR_COUNT B2B/WL-related"
  if [[ "\$B2B_ERROR_COUNT" -gt 0 ]]; then
    ALERTS+=("WARNING: \$B2B_ERROR_COUNT OHS errors related to B2B/WebLogic in last log tail")
    echo "[WARN] B2B-related OHS errors detected — check \$ERROR_LOG"
    tail -n 2000 "\$ERROR_LOG" | grep -iE '/b2b|mod_wl_ohs' | grep -iE 'error|fail|500' | tail -10
  fi
else
  echo "[WARN] OHS error_log not found at \$ERROR_LOG"
  ALERTS+=("WARNING: OHS error_log not found at \$ERROR_LOG — check OHS_COMPONENT")
fi

# ════════════════════════════════════════════════════════════════
# STEP 2: SSL CERTIFICATE EXPIRY
# ════════════════════════════════════════════════════════════════
echo ""
echo "── Step 2: SSL Certificate Expiry ─────────────────────────"

WALLET_DIR=\${OHS_WALLET_DIR:-/etc/ORACLE/WALLETS/ohs}
if [[ -d "\$WALLET_DIR" ]]; then
  ORAPKI=$(find /u01 -name orapki -type f 2>/dev/null | head -1 || echo "orapki")
  if "\$ORAPKI" wallet display -wallet "\$WALLET_DIR" 2>/dev/null | grep -q "Certificate"; then
    # Extract expiry from any PEM/DER certs in the wallet
    for CERT_FILE in "\$WALLET_DIR"/*.pem "\$WALLET_DIR"/*.crt; do
      [[ -f "\$CERT_FILE" ]] || continue
      EXPIRY=$(openssl x509 -in "\$CERT_FILE" -noout -enddate 2>/dev/null | cut -d= -f2 || true)
      [[ -z "\$EXPIRY" ]] && continue
      EXPIRY_EPOCH=$(date -d "\$EXPIRY" +%s 2>/dev/null || true)
      NOW_EPOCH=$(date +%s)
      DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))
      if [[ "\$DAYS_LEFT" -le \$CERT_WARN_DAYS ]]; then
        echo "[WARN] Certificate \$CERT_FILE expires in \$DAYS_LEFT days"
        ALERTS+=("WARNING: SSL certificate \$(basename "\$CERT_FILE") expires in \$DAYS_LEFT days")
      else
        echo "[OK]   Certificate \$CERT_FILE — \$DAYS_LEFT days remaining"
      fi
    done
  else
    echo "[WARN] orapki wallet display returned no certificate info"
  fi
else
  echo "[WARN] Wallet directory not found: \$WALLET_DIR — set OHS_WALLET_DIR"
  ALERTS+=("WARNING: OHS wallet directory not found: \$WALLET_DIR")
fi

# ════════════════════════════════════════════════════════════════
# STEP 3: mod_wl_ohs.conf — Required Context Blocks
# ════════════════════════════════════════════════════════════════
echo ""
echo "── Step 3: mod_wl_ohs.conf Context Blocks ─────────────────"

CONF_DIR=\${EBS_DOMAIN_HOME:-}/config/fmwconfig/components/OHS/instances/\${OHS_COMPONENT}/config
MOD_WL_CONF=\${CONF_DIR}/mod_wl_ohs.conf

if [[ -f "\$MOD_WL_CONF" ]]; then
  for CONTEXT in "/webservices" "/b2b" "/oafm"; do
    if grep -q "Location \${CONTEXT}" "\$MOD_WL_CONF" 2>/dev/null; then
      echo "[OK]      Location \${CONTEXT} present"
    else
      echo "[MISSING] Location \${CONTEXT} — ISG/B2B routing may fail"
      ALERTS+=("WARNING: mod_wl_ohs.conf missing Location block for \${CONTEXT}")
    fi
  done
else
  echo "[WARN] mod_wl_ohs.conf not found at \$MOD_WL_CONF"
  ALERTS+=("WARNING: mod_wl_ohs.conf not found — OHS routing cannot be verified")
fi

# ════════════════════════════════════════════════════════════════
# STEP 4: B2B / ISG DATABASE ERROR QUERY
# ════════════════════════════════════════════════════════════════
echo ""
echo "── Step 4: B2B / ISG Database Error Query ──────────────────"

if [[ ! -f "\$SQL_SCRIPT" ]]; then
  echo "[WARN] SQL script not found: \$SQL_SCRIPT"
  echo "       Place isg_b2b_errors.sql in the same directory as this script."
  ALERTS+=("WARNING: SQL script isg_b2b_errors.sql not found — database check skipped")
else
  # Read APPS password
  if [[ -f "\$PASS_FILE" ]]; then
    APPS_PASS=$(cat "\$PASS_FILE")
  else
    echo "[WARN] Password file not found: \$PASS_FILE"
    echo "       Create it: echo 'password' > \$PASS_FILE && chmod 400 \$PASS_FILE"
    APPS_PASS=""
  fi

  if [[ -n "\$APPS_PASS" ]] && command -v sqlplus &>/dev/null; then
    SQL_LOG=\${LOG_DIR}/isg_sql_\${TIMESTAMP}.log

    if [[ "\$DRY_RUN" == "true" ]]; then
      echo "[DRY-RUN] Would run: sqlplus apps/*** @\$SQL_SCRIPT \$HOURS_BACK"
    else
      echo "[INFO] Running B2B error query (last \$HOURS_BACK hours)..."
      sqlplus -s "apps/\${APPS_PASS}@\${TWO_TASK:-}" @"\$SQL_SCRIPT" \$HOURS_BACK > "\$SQL_LOG" 2>&1 || true

      # ── Parse SQL output for error counts ────────────────────────────────
      B2B_DB_ERRORS=$(grep -c 'MSG_ERROR\|TRANSPORT_ERROR\|APP_ERROR' "\$SQL_LOG" 2>/dev/null || echo 0)
      ISG_DB_ERRORS=$(grep -c 'status.*E\|error_code' "\$SQL_LOG" 2>/dev/null || echo 0)

      echo "[INFO] B2B message errors in DB: \$B2B_DB_ERRORS"
      echo "[INFO] ISG invocation errors in DB: \$ISG_DB_ERRORS"

      # Show the report
      cat "\$SQL_LOG"

      if [[ "\$B2B_DB_ERRORS" -gt \$ERROR_THRESHOLD ]]; then
        ALERTS+=("CRITICAL: \$B2B_DB_ERRORS B2B message errors in last \${HOURS_BACK}h (threshold: \$ERROR_THRESHOLD)")
      fi
      if [[ "\$ISG_DB_ERRORS" -gt \$ERROR_THRESHOLD ]]; then
        ALERTS+=("WARNING: \$ISG_DB_ERRORS ISG invocation errors in last \${HOURS_BACK}h")
      fi
    fi
  else
    echo "[SKIP] SQL*Plus not available or APPS password not set — database check skipped"
  fi
fi

# ════════════════════════════════════════════════════════════════
# SUMMARY AND ALERT
# ════════════════════════════════════════════════════════════════
echo ""
echo "============================================================"
echo "SUMMARY — \$(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================================"

{
  echo "ISG/B2B Monitor Summary — \$(date '+%Y-%m-%d %H:%M:%S')"
  echo "Monitoring period : last \${HOURS_BACK} hours"
  echo "Host              : \$(hostname)"
  echo ""
  if [[ \${#ALERTS[@]} -eq 0 ]]; then
    echo "STATUS: OK — no issues detected"
  else
    echo "STATUS: ALERTS DETECTED (\${#ALERTS[@]})"
    echo ""
    for ALERT in "\${ALERTS[@]}"; do
      echo "  • \$ALERT"
    done
  fi
  echo ""
  echo "Log : \$LOGFILE"
  echo "SQL : \${SQL_LOG:-N/A}"
} | tee "\$SUMMARY_FILE"

# ── Email alert ────────────────────────────────────────────────
if [[ \${#ALERTS[@]} -gt 0 ]] && [[ -n "\$ALERT_EMAIL" ]]; then
  SUBJECT="[ISG/B2B ALERT] \$(hostname) — \${#ALERTS[@]} issue(s) detected \$(date '+%Y-%m-%d %H:%M')"
  if command -v mailx &>/dev/null; then
    mailx -s "\$SUBJECT" "\$ALERT_EMAIL" < "\$SUMMARY_FILE"
    echo "[INFO] Alert email sent to \$ALERT_EMAIL"
  elif command -v sendmail &>/dev/null; then
    { echo "Subject: \$SUBJECT"; echo ""; cat "\$SUMMARY_FILE"; } | sendmail "\$ALERT_EMAIL"
    echo "[INFO] Alert email sent via sendmail to \$ALERT_EMAIL"
  else
    echo "[WARN] No mail client found (mailx/sendmail) — email not sent"
    echo "       Install: yum install mailx"
  fi
fi

EXIT_CODE=0
for ALERT in "\${ALERTS[@]}"; do
  [[ "\$ALERT" == CRITICAL* ]] && EXIT_CODE=2 && break
  EXIT_CODE=1
done

echo ""
echo "Exit code: \$EXIT_CODE  (0=OK, 1=WARNING, 2=CRITICAL)"
exit \$EXIT_CODE
\`\`\`

---

## Cron Setup

\`\`\`bash
# Deploy scripts to a consistent location
mkdir -p /u01/app/oracle/scripts/isg_monitor
cp isg_b2b_monitor.sh /u01/app/oracle/scripts/isg_monitor/
cp isg_b2b_errors.sql /u01/app/oracle/scripts/isg_monitor/
chmod 750 /u01/app/oracle/scripts/isg_monitor/isg_b2b_monitor.sh
chmod 640 /u01/app/oracle/scripts/isg_monitor/isg_b2b_errors.sql

# Password file
echo 'apps_password_here' > /home/oracle/.oracle_apps_pass
chmod 400 /home/oracle/.oracle_apps_pass

# Log directory
mkdir -p /var/log/oracle/isg
chown oracle:oinstall /var/log/oracle/isg

# Add to oracle user crontab
crontab -e -u oracle
\`\`\`

Add this line:

\`\`\`
0 */4 * * * EBS_ENV=/u01/install/APPS/EBSapps.env OHS_COMPONENT=ohs1 ALERT_EMAIL=dba-team@example.com /u01/app/oracle/scripts/isg_monitor/isg_b2b_monitor.sh --hours 4 >> /var/log/oracle/isg/cron.log 2>&1
\`\`\`

For the first run, use \`--dry-run\` to verify the environment resolves correctly:

\`\`\`bash
/u01/app/oracle/scripts/isg_monitor/isg_b2b_monitor.sh --dry-run --hours 4
\`\`\`

---

## Log Rotation

\`\`\`
# /etc/logrotate.d/oracle-isg-monitor
/var/log/oracle/isg/*.log {
    daily
    rotate 14
    compress
    missingok
    notifempty
    create 0640 oracle oinstall
}
\`\`\`

---

## AutoConfig Regeneration (after patching)

If OHS routing is broken after an adop patch cycle:

\`\`\`bash
# Run on the EBS web tier as applmgr/oracle
source /u01/install/APPS/EBSapps.env run
$ADMIN_SCRIPTS_HOME/adautocfg.sh
# Enter APPS password when prompted

# Restart OHS after AutoConfig
$ADMIN_SCRIPTS_HOME/adopmnctl.sh stop
sleep 10
$ADMIN_SCRIPTS_HOME/adopmnctl.sh start

# Verify OHS is up and routing
curl -I http://localhost/webservices/
# Expect: 401 Unauthorized (means OHS routed to WL and WL responded — not 500)
\`\`\`

---

## Quick Reference: B2B-50079 Decision Tree

\`\`\`
B2B-50079 HTTP 500 from OHS
│
├─ OHS error_log shows SSL/certificate error?
│    └─ YES → Check wallet expiry → re-import cert chain → restart OHS
│
├─ OHS error_log shows connection refused / no backend?
│    └─ YES → Check managed server state in WL console → restart oafm/soa_server
│
├─ mod_wl_ohs.conf missing Location blocks for /b2b or /webservices?
│    └─ YES → Run adautocfg.sh → restart OHS
│
├─ Managed server state is RUNNING but 500 still occurs?
│    └─ Check WLIOTimeoutSecs in mod_wl_ohs.conf → increase to 300+
│
├─ ISG interface status in Integration Repository?
│    └─ UNDEPLOYED → Deploy it → monitor concurrent request
│
└─ All above OK, errors only in DB (b2b_message_store)?
     └─ Trading partner endpoint config issue → check TP setup in B2B console
\`\`\`
`,
};

async function main() {
  await db.insert(posts).values(blogPost);
  console.log('inserted:', blogPost.slug);

  await db.insert(posts).values(runbookPost);
  console.log('inserted:', runbookPost.slug);
}

main().catch(console.error);
