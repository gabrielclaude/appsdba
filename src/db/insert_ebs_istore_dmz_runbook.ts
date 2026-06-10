import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Deploying Oracle EBS iStore with a DMZ Public Mid-Tier',
  slug: 'ebs-istore-dmz-public-mid-tier-runbook',
  excerpt:
    'Step-by-step runbook for installing and configuring a standalone Oracle HTTP Server in the DMZ for EBS iStore — covering OHS installation, SSL certificate deployment, mod_wl_ohs proxy configuration, firewall validation, iStore profile option setup, and end-to-end smoke testing.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-10'),
  youtubeUrl: null,
  content: `## Prerequisites

- Oracle EBS 12.2 fully installed and running on the internal application tier
- iStore licensed and enabled in the internal EBS instance
- DMZ host provisioned (RHEL 7/8 or Oracle Linux 7/8 recommended), with:
  - No EBS application tier installed
  - No WebLogic installed
  - Network routes open from DMZ to internal oacore managed server ports (TCP 7201/7202)
- Oracle WebTier 12c installer (or Fusion Middleware 12c) downloaded
- Public SSL certificate (PEM format: server cert + chain) from a trusted CA
- DNS entry for the public iStore hostname (e.g., \`store.yourcompany.com\`) pointing to DMZ OHS IP
- Firewall change request approved for the required port rules

---

## Phase 1: Install Oracle HTTP Server on the DMZ Host

### 1.1 Create OS User and Directories

\`\`\`bash
# On the DMZ host — as root
groupadd oinstall
groupadd dba
useradd -g oinstall -G dba -m -s /bin/bash oracle

mkdir -p /u01/oracle/web
mkdir -p /u01/oraInventory
chown -R oracle:oinstall /u01/oracle /u01/oraInventory
chmod -R 755 /u01/oracle
\`\`\`

### 1.2 Install Oracle HTTP Server (Standalone)

Oracle HTTP Server 12c can be installed standalone (without a full WebLogic domain) using the Oracle WebTier 12c installer.

\`\`\`bash
# As oracle user on the DMZ host
export ORACLE_BASE=/u01/oracle
export MW_HOME=/u01/oracle/web

# Run the WebTier installer (silent install)
./fmw_12.2.1.4.0_ohs_linux64.bin -silent \
  -responseFile /tmp/ohs_silent.rsp \
  -invPtrLoc /u01/oraInventory/oraInst.loc

# Silent response file contents (/tmp/ohs_silent.rsp):
# [ENGINE]
# Response File Version=1.0.0.0.0
# [GENERIC]
# ORACLE_HOME=/u01/oracle/web
# INSTALL_TYPE=Standalone HTTP Server
\`\`\`

### 1.3 Create the OHS Component Instance

\`\`\`bash
# Create a standalone OHS domain (no WebLogic required)
/u01/oracle/web/ohs/bin/createInstance \
  -oracleHome /u01/oracle/web \
  -instanceName ohs_dmz \
  -adminHost localhost \
  -adminPort 7001 \
  -smHost localhost \
  -smPort 5556 \
  -startupMode server

# Verify the instance was created
ls /u01/oracle/web/instances/ohs_dmz/config/OHS/ohs1/
\`\`\`

Expected output includes: \`httpd.conf\`, \`ssl.conf\`, \`mod_wl_ohs.conf\`

---

## Phase 2: Deploy the SSL Certificate

### 2.1 Place Certificate Files

\`\`\`bash
# As root — create the SSL directory
mkdir -p /etc/ssl/certs /etc/ssl/private
chmod 750 /etc/ssl/private

# Copy the certificate files obtained from your CA
cp istore.yourcompany.com.crt     /etc/ssl/certs/
cp istore_chain.crt               /etc/ssl/certs/
cp istore.yourcompany.com.key     /etc/ssl/private/

# Lock down the private key
chmod 600 /etc/ssl/private/istore.yourcompany.com.key
chown oracle:oinstall /etc/ssl/private/istore.yourcompany.com.key
chown oracle:oinstall /etc/ssl/certs/istore*.crt
\`\`\`

### 2.2 Verify Certificate Validity

\`\`\`bash
# Check certificate expiry and CN/SAN
openssl x509 -in /etc/ssl/certs/istore.yourcompany.com.crt \
  -noout -subject -issuer -dates

# Verify the private key matches the certificate
openssl rsa  -in /etc/ssl/private/istore.yourcompany.com.key -noout -modulus | md5sum
openssl x509 -in /etc/ssl/certs/istore.yourcompany.com.crt  -noout -modulus | md5sum
# Both MD5 hashes must match

# Verify the chain
openssl verify -CAfile /etc/ssl/certs/istore_chain.crt \
  /etc/ssl/certs/istore.yourcompany.com.crt
# Expected: /etc/ssl/certs/istore.yourcompany.com.crt: OK
\`\`\`

---

## Phase 3: Configure Oracle HTTP Server

### 3.1 ssl.conf — HTTPS Virtual Host

Edit \`/u01/oracle/web/instances/ohs_dmz/config/OHS/ohs1/ssl.conf\`:

\`\`\`apache
Listen 443

<VirtualHost *:443>
    ServerName  store.yourcompany.com

    SSLEngine           on
    SSLProtocol         TLSv1.2 TLSv1.3
    SSLCipherSuite      ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:!aNULL:!MD5
    SSLCertificateFile      /etc/ssl/certs/istore.yourcompany.com.crt
    SSLCertificateKeyFile   /etc/ssl/private/istore.yourcompany.com.key
    SSLCertificateChainFile /etc/ssl/certs/istore_chain.crt

    # Serve OA_MEDIA static content directly from the DMZ filesystem
    # Sync from internal tier using rsync (see Phase 4)
    Alias /OA_MEDIA  /u01/oracle/ebs_media/OA_MEDIA
    <Directory "/u01/oracle/ebs_media/OA_MEDIA">
        Options None
        AllowOverride None
        Require all granted
    </Directory>

    # Route all iStore OAF requests to internal WebLogic oacore cluster
    <Location /OA_HTML>
        SetHandler weblogic-handler
        WebLogicCluster  internal-app1.corp.local:7201,internal-app2.corp.local:7201
        WLCookieName     JSESSIONID
        WLLogFile        /u01/oracle/web/logs/wl_oacore_proxy.log
    </Location>

    <Location /oacore>
        SetHandler weblogic-handler
        WebLogicCluster  internal-app1.corp.local:7201,internal-app2.corp.local:7201
        WLCookieName     JSESSIONID
    </Location>

    # HTTP to HTTPS redirect
    RewriteEngine On
    RewriteCond %{HTTPS} !=on
    RewriteRule ^/?(.*) https://%{SERVER_NAME}/\$1 [R=301,L]

    ErrorLog    /u01/oracle/web/logs/istore_ssl_error.log
    CustomLog   /u01/oracle/web/logs/istore_ssl_access.log combined
</VirtualHost>
\`\`\`

### 3.2 httpd.conf — HTTP Redirect Virtual Host

Add to \`/u01/oracle/web/instances/ohs_dmz/config/OHS/ohs1/httpd.conf\`:

\`\`\`apache
Listen 80

<VirtualHost *:80>
    ServerName  store.yourcompany.com
    RewriteEngine On
    RewriteRule ^/?(.*) https://store.yourcompany.com/\$1 [R=301,L]
</VirtualHost>
\`\`\`

### 3.3 mod_wl_ohs.conf — WebLogic Proxy Module

Edit \`/u01/oracle/web/instances/ohs_dmz/config/OHS/ohs1/mod_wl_ohs.conf\`:

\`\`\`apache
LoadModule weblogic_module  modules/mod_wl_ohs.so

<IfModule mod_weblogic.c>
    # Health check and retry timings
    ConnectTimeoutSecs      10
    ConnectRetrySecs        2

    # Session stickiness — routes repeat requests to same managed server
    WLCookieName            JSESSIONID
    KeepAliveEnabled        ON
    KeepAliveSecs           20

    WLLogFile  /u01/oracle/web/logs/mod_wl_ohs.log
    Debug      ERR

    # Security — trust only the internal oacore servers
    WLTrustedServers  internal-app1.corp.local,internal-app2.corp.local
</IfModule>
\`\`\`

### 3.4 Validate OHS Configuration Syntax

\`\`\`bash
/u01/oracle/web/instances/ohs_dmz/bin/opmnctl validate
# Expected: No errors

# Or check using the Apache config test
/u01/oracle/web/ohs/bin/apachectl -f \
  /u01/oracle/web/instances/ohs_dmz/config/OHS/ohs1/httpd.conf \
  -t
# Expected: Syntax OK
\`\`\`

---

## Phase 4: Synchronise OA_MEDIA to the DMZ Tier

The DMZ OHS serves static media (images, CSS, JS) directly from the local filesystem to avoid unnecessary round-trips to the internal WebLogic cluster. This content must be synchronised from the internal EBS application tier.

### 4.1 Initial rsync

\`\`\`bash
# On the DMZ host — as oracle user
mkdir -p /u01/oracle/ebs_media/OA_MEDIA

# Initial sync from internal app tier
# Requires SSH key-based auth from DMZ oracle to internal oracle user
rsync -avz --delete \
  oracle@internal-app1.corp.local:/u01/oracle/ebs/fs1/EBSapps/appl/fnd/12.0.0/media/ \
  /u01/oracle/ebs_media/OA_MEDIA/
\`\`\`

### 4.2 Scheduled Sync via Cron

\`\`\`bash
# Add to oracle crontab on DMZ host
crontab -e

# Sync OA_MEDIA every 4 hours
0 */4 * * * rsync -az --delete \
  oracle@internal-app1.corp.local:/u01/oracle/ebs/fs1/EBSapps/appl/fnd/12.0.0/media/ \
  /u01/oracle/ebs_media/OA_MEDIA/ \
  >> /u01/oracle/web/logs/oa_media_sync.log 2>&1
\`\`\`

---

## Phase 5: Internal Mid-Tier Configuration

### 5.1 Verify oacore Managed Server Listen Address

On the **internal** EBS application tier, the oacore managed server must listen on all interfaces (not just localhost) so the DMZ OHS can reach it.

In WebLogic Admin Console: Servers → oacore_server1 → Configuration → General:

- **Listen Address:** leave blank (all interfaces) or set to the internal IP reachable from the DMZ
- **Listen Port:** 7201 (verify this matches what is configured in mod_wl_ohs.conf)

Or via WLST:

\`\`\`python
connect('weblogic', '<password>', 't3://internal-app1.corp.local:7001')
edit()
startEdit()
cd('Servers/oacore_server1')
cmo.setListenAddress('')
cmo.setListenPort(7201)
save()
activate()
disconnect()
\`\`\`

Restart the oacore managed server for the listen address change to take effect.

### 5.2 Configure WebLogic Connection Filter

In the WebLogic Admin Console: Domain → Security → Filter:

Set the **Connection Filter Class** to:
\`weblogic.security.net.ConnectionFilterImpl\`

Set **Connection Filter Rules** to allow only the DMZ subnet on the proxy ports:

\`\`\`
allow * * 7201 7202 from 10.10.1.0/24
deny * * 7201 7202 from *
allow * * * * from *
\`\`\`

Replace \`10.10.1.0/24\` with the actual DMZ subnet. The third rule allows all other ports from all hosts (for internal access).

### 5.3 Test Connectivity from DMZ to Internal oacore

\`\`\`bash
# From the DMZ host
telnet internal-app1.corp.local 7201
# Expected: Connected to internal-app1.corp.local.

curl -s -o /dev/null -w "%{http_code}" \
  http://internal-app1.corp.local:7201/oacore/
# Expected: 200 or 302 (any non-connection-refused response)
\`\`\`

---

## Phase 6: Configure iStore Profile Options

Connect to the internal EBS instance as SYSADMIN and navigate to **System Administrator → Profile → System**. Alternatively use SQL*Plus:

\`\`\`sql
-- Connect to internal EBS database as APPS
sqlplus apps/<password>@EBSDB

-- Query current values first
SELECT profile_option_name, profile_option_value
FROM   fnd_profile_options_value fpov
JOIN   fnd_profile_options fpo
       ON fpov.profile_option_id = fpo.profile_option_id
WHERE  fpo.profile_option_name IN (
    'IBE_STORE_URL',
    'IBE_MEDIA_URL',
    'IBE_DEFAULT_SERVLET_PORT',
    'IBE_MEDIA_PHYSICAL_LOCATION',
    'APPS_FRAMEWORK_AGENT',
    'ICX_FORMS_LAUNCHER'
)
AND fpov.level_id = 10001;  -- 10001 = Site level
\`\`\`

Set the profile options for the DMZ deployment:

| Profile Option | Required Value |
|----------------|----------------|
| \`IBE_STORE_URL\` | \`https://store.yourcompany.com\` |
| \`IBE_MEDIA_URL\` | \`https://store.yourcompany.com/OA_MEDIA\` |
| \`IBE_DEFAULT_SERVLET_PORT\` | \`443\` |
| \`IBE_MEDIA_PHYSICAL_LOCATION\` | \`/u01/oracle/ebs_media/OA_MEDIA\` (DMZ filesystem path) |
| \`APPS_FRAMEWORK_AGENT\` | \`https://internal.corp.local:4443\` (internal OHS — not DMZ) |
| \`ICX_FORMS_LAUNCHER\` | \`https://internal.corp.local:4443/forms/frmservlet\` (internal only) |

Update via FND_PROFILE API:

\`\`\`sql
BEGIN
    FND_PROFILE.SAVE(
        x_name         => 'IBE_STORE_URL',
        x_value        => 'https://store.yourcompany.com',
        x_level_name   => 'SITE',
        x_level_value  => NULL
    );
    FND_PROFILE.SAVE(
        x_name         => 'IBE_MEDIA_URL',
        x_value        => 'https://store.yourcompany.com/OA_MEDIA',
        x_level_name   => 'SITE',
        x_level_value  => NULL
    );
    FND_PROFILE.SAVE(
        x_name         => 'IBE_DEFAULT_SERVLET_PORT',
        x_value        => '443',
        x_level_name   => 'SITE',
        x_level_value  => NULL
    );
    COMMIT;
END;
/
\`\`\`

---

## Phase 7: Start DMZ OHS and Initial Validation

### 7.1 Start Oracle HTTP Server

\`\`\`bash
# On DMZ host — as oracle user
/u01/oracle/web/instances/ohs_dmz/bin/opmnctl start

# Check status
/u01/oracle/web/instances/ohs_dmz/bin/opmnctl status -l

# Expected output:
# Processes in Instance: ohs_dmz
# ---------------------------------+--------------------+---------+---------
# ias-component                    | process-type       |     pid | status
# ---------------------------------+--------------------+---------+---------
# ohs1                             | OHS                |   12345 | Alive
\`\`\`

### 7.2 Test HTTPS from DMZ Host Itself

\`\`\`bash
# Test SSL certificate presentation
openssl s_client -connect store.yourcompany.com:443 -servername store.yourcompany.com

# Expected output contains:
# subject=/CN=store.yourcompany.com
# issuer=<CA chain>
# SSL-Session: Protocol: TLSv1.3 (or TLSv1.2)

# Test basic HTTP connectivity
curl -I https://store.yourcompany.com/OA_HTML/ibeCZzpHome.jsp
# Expected: HTTP/1.1 200 OK  or  HTTP/1.1 302 Found
\`\`\`

### 7.3 Test OA_MEDIA Static Serving

\`\`\`bash
# Test that static media is served directly from the DMZ filesystem
curl -I https://store.yourcompany.com/OA_MEDIA/fndilogo.gif
# Expected: HTTP/1.1 200 OK
# Verify there is NO X-Powered-By WebLogic header — this should be served by Apache directly
\`\`\`

### 7.4 Check mod_wl_ohs Proxy Log

\`\`\`bash
tail -f /u01/oracle/web/logs/wl_oacore_proxy.log

# After loading an iStore page, look for:
# Connecting to WebLogic Server at: internal-app1.corp.local:7201
# Connected OK
\`\`\`

---

## Phase 8: End-to-End iStore Smoke Test

### 8.1 Browser Test

From an external machine (or using curl with the public DNS resolution):

1. Navigate to \`https://store.yourcompany.com/OA_HTML/ibeCZzpHome.jsp\`
2. Verify the iStore home page loads with images (OA_MEDIA serving correctly)
3. Verify the padlock shows the correct certificate for \`store.yourcompany.com\`
4. Log in as a test B2C customer — verify session works across page navigations (JSESSIONID stickiness)
5. Add an item to the shopping cart and proceed to checkout (verifies WebLogic session state is maintained through the proxy)

### 8.2 Verify Correct URL Generation

After logging in, check that all self-referencing links use the public DMZ URL, not the internal hostname:

\`\`\`bash
# Grep page source for internal hostname — should return nothing
curl -s https://store.yourcompany.com/OA_HTML/ibeCZzpHome.jsp \
  | grep -i "internal-app1\|corp.local\|7201\|7202"
# Expected: no output (no internal hostnames leaked to the public page)
\`\`\`

### 8.3 Verify Session Affinity

\`\`\`bash
# Login and capture the JSESSIONID cookie
curl -c /tmp/istore_cookies.txt \
  -d "username=testuser&password=testpass" \
  https://store.yourcompany.com/OA_HTML/OA.jsp?OAFunc=IBE_LOAD_LOGIN_PAGE

# Make 5 subsequent requests using the saved cookie
for i in {1..5}; do
  curl -b /tmp/istore_cookies.txt -s -o /dev/null \
    -w "Request \$i: HTTP %{http_code}, connected to: %{remote_ip}\n" \
    https://store.yourcompany.com/OA_HTML/ibeCZzpSctShop.jsp
done

# All 5 requests should return HTTP 200 — no 502/503 (which would indicate
# the proxy is not maintaining session affinity to the same oacore server)
\`\`\`

---

## Phase 9: Firewall Validation

Verify all required firewall rules are in place and all prohibited paths are blocked:

\`\`\`bash
# From Internet (or external test machine) — ALLOWED
curl -I https://store.yourcompany.com/OA_HTML/ibeCZzpHome.jsp
# Expected: HTTP 200

# From DMZ host — ALLOWED (proxy port to oacore)
nc -zv internal-app1.corp.local 7201
# Expected: Connection to internal-app1.corp.local 7201 port [tcp/*] succeeded!

# From DMZ host — BLOCKED (AdminServer must not be reachable from DMZ)
nc -zv -w 5 internal-app1.corp.local 7001
# Expected: Connection timed out or Connection refused

# From DMZ host — BLOCKED (Database port must not be reachable from DMZ)
nc -zv -w 5 db-host.corp.local 1521
# Expected: Connection timed out or Connection refused

# From Internet — BLOCKED (Internal network must not be directly reachable)
curl -m 5 http://internal-app1.corp.local:4443/OA_HTML/AppsLocalLogin.jsp
# Expected: curl: (7) Failed to connect to internal-app1.corp.local (timeout or refused)
\`\`\`

---

## Phase 10: OHS Startup at Boot

Configure OPMN to start automatically when the DMZ host boots:

\`\`\`bash
# Create a systemd service unit (RHEL/OL 7+)
cat > /etc/systemd/system/ohs-dmz.service << 'EOF'
[Unit]
Description=Oracle HTTP Server DMZ Instance
After=network.target

[Service]
Type=forking
User=oracle
Group=oinstall
ExecStart=/u01/oracle/web/instances/ohs_dmz/bin/opmnctl start
ExecStop=/u01/oracle/web/instances/ohs_dmz/bin/opmnctl stop
ExecReload=/u01/oracle/web/instances/ohs_dmz/bin/opmnctl reload
PIDFile=/u01/oracle/web/instances/ohs_dmz/config/OPMN/opmn/opmn.pid
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ohs-dmz
systemctl start ohs-dmz
systemctl status ohs-dmz
\`\`\`

---

## Phase 11: Monitoring Script

Deploy this script on the DMZ host to monitor OHS availability and proxy connectivity:

\`\`\`bash
#!/bin/bash
# /u01/oracle/web/scripts/check_istore_dmz.sh
# Run from cron every 5 minutes

ISTORE_URL="https://store.yourcompany.com/OA_HTML/ibeCZzpHome.jsp"
INTERNAL_HOST="internal-app1.corp.local"
INTERNAL_PORT="7201"
LOG="/u01/oracle/web/logs/istore_monitor.log"
EMAIL="dba-alerts@yourcompany.com"
HOSTNAME_DMZ=$(hostname -f)

log() { echo "\$(date '+%Y-%m-%d %H:%M:%S') \$1" >> "\$LOG"; }

# Test 1: HTTPS response from DMZ OHS
HTTP_CODE=\$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 "\$ISTORE_URL")
if [[ "\$HTTP_CODE" != "200" && "\$HTTP_CODE" != "302" ]]; then
    MSG="CRITICAL: iStore DMZ OHS returning HTTP \$HTTP_CODE on \$HOSTNAME_DMZ"
    log "\$MSG"
    echo "\$MSG" | mail -s "iStore DMZ OHS ALERT" "\$EMAIL"
    exit 2
fi
log "OK: iStore HTTPS returned HTTP \$HTTP_CODE"

# Test 2: TCP connectivity to internal oacore proxy port
if ! nc -zv -w 5 "\$INTERNAL_HOST" "\$INTERNAL_PORT" >/dev/null 2>&1; then
    MSG="CRITICAL: Cannot reach oacore at \${INTERNAL_HOST}:\${INTERNAL_PORT} from DMZ \$HOSTNAME_DMZ"
    log "\$MSG"
    echo "\$MSG" | mail -s "iStore Proxy Port ALERT" "\$EMAIL"
    exit 2
fi
log "OK: Proxy port \${INTERNAL_HOST}:\${INTERNAL_PORT} reachable"

# Test 3: OA_MEDIA static file available
MEDIA_CODE=\$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 \
  "https://store.yourcompany.com/OA_MEDIA/fndilogo.gif")
if [[ "\$MEDIA_CODE" != "200" ]]; then
    MSG="WARNING: OA_MEDIA not serving on \$HOSTNAME_DMZ (HTTP \$MEDIA_CODE)"
    log "\$MSG"
    echo "\$MSG" | mail -s "iStore OA_MEDIA WARNING" "\$EMAIL"
fi
log "OK: OA_MEDIA returned HTTP \$MEDIA_CODE"

# Test 4: OHS process running
if ! /u01/oracle/web/instances/ohs_dmz/bin/opmnctl status 2>&1 | grep -q "Alive"; then
    MSG="CRITICAL: OHS process is not Alive on \$HOSTNAME_DMZ"
    log "\$MSG"
    echo "\$MSG" | mail -s "iStore DMZ OHS Process DOWN" "\$EMAIL"
    exit 2
fi
log "OK: OHS process is Alive"

exit 0
\`\`\`

\`\`\`bash
# Install the monitoring script
chmod +x /u01/oracle/web/scripts/check_istore_dmz.sh

# Add to oracle crontab
crontab -e
# */5 * * * * /u01/oracle/web/scripts/check_istore_dmz.sh
\`\`\`

---

## Phase 12: SSL Certificate Renewal Procedure

Public CA certificates typically expire after 1 year. Document the renewal procedure now.

### 12.1 Generate a New CSR

\`\`\`bash
# On the DMZ host — generate a new private key and CSR
openssl req -newkey rsa:2048 -nodes \
  -keyout /etc/ssl/private/istore_new.yourcompany.com.key \
  -out    /etc/ssl/certs/istore_new.yourcompany.com.csr \
  -subj   "/C=US/ST=California/O=YourCompany/CN=store.yourcompany.com" \
  -reqexts SAN \
  -config <(cat /etc/ssl/openssl.cnf
    printf "[SAN]\nsubjectAltName=DNS:store.yourcompany.com")

# Submit the CSR to your CA and receive the renewed certificate
\`\`\`

### 12.2 Swap the Certificate (zero-downtime)

\`\`\`bash
# 1. Place new certificate files
cp istore.yourcompany.com.crt.new /etc/ssl/certs/istore.yourcompany.com.crt
cp istore_chain.crt.new           /etc/ssl/certs/istore_chain.crt
cp istore.yourcompany.com.key.new /etc/ssl/private/istore.yourcompany.com.key

# 2. Reload OHS (graceful — no new connections dropped)
/u01/oracle/web/instances/ohs_dmz/bin/opmnctl reload

# 3. Verify the new certificate is being served
openssl s_client -connect store.yourcompany.com:443 \
  -servername store.yourcompany.com 2>/dev/null \
  | openssl x509 -noout -dates
# Confirm notAfter shows the new expiry date
\`\`\`

---

## Troubleshooting

| Symptom | Where to Look | Likely Cause |
|---------|---------------|--------------|
| 502 Bad Gateway from DMZ OHS | \`mod_wl_ohs.log\` | oacore managed server not running, or firewall blocking 7201 |
| iStore pages load but images are broken | OHS error log, OA_MEDIA sync log | OA_MEDIA rsync not run or wrong path in Alias directive |
| Self-referencing links show internal hostname | EBS System Administrator → Profile | \`IBE_STORE_URL\` still set to internal URL |
| JSESSIONID cookie not set on redirect | OHS ssl.conf | \`WLCookieName JSESSIONID\` missing from Location block |
| SSL handshake failure | \`openssl s_client\` | Certificate/key mismatch, or SSLProtocol excludes client's TLS version |
| iStore not filtering by correct org | EBS WebLogic log | Profile option changes require WebLogic session flush (bounce oacore) |
| HTTP 403 on OA_MEDIA | OHS error log | File permissions on \`/u01/oracle/ebs_media/OA_MEDIA\` |

### OHS Log Locations

\`\`\`bash
# OHS access and error logs
/u01/oracle/web/logs/istore_ssl_access.log
/u01/oracle/web/logs/istore_ssl_error.log

# mod_wl_ohs proxy log
/u01/oracle/web/logs/mod_wl_ohs.log
/u01/oracle/web/logs/wl_oacore_proxy.log

# OPMN process management
/u01/oracle/web/instances/ohs_dmz/diagnostics/logs/OPMN/opmn/opmn.log

# OHS component log
/u01/oracle/web/instances/ohs_dmz/diagnostics/logs/OHS/ohs1/ohs1.log
\`\`\``,
};

async function main() {
  console.log('Inserting EBS iStore DMZ runbook...');
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
