import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS iStore: DMZ Public Mid-Tier Architecture with Apache and Private Network Separation',
  slug: 'ebs-istore-dmz-public-mid-tier-architecture',
  excerpt:
    'A technical deep-dive into deploying Oracle EBS iStore across a DMZ public mid-tier and a private internal mid-tier — covering the security zone architecture, Oracle HTTP Server reverse-proxy configuration in the DMZ, WebLogic backend routing, firewall rules between zones, and the iStore-specific profile options that wire the two tiers together.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-10'),
  youtubeUrl: null,
  content: `Oracle iStore is the B2B and B2C e-commerce module in Oracle E-Business Suite. Unlike internal EBS applications — GL, AP, AR — iStore is publicly accessible. External customers browse the online catalogue, place orders, and track shipments through it. Exposing a full EBS application tier directly to the internet is not acceptable. The solution is a split mid-tier architecture: a lightweight web tier sits in a DMZ, and the full EBS application stack lives entirely in the private network.

This post explains how that architecture works in EBS 12.2, what each tier does, and how Apache/Oracle HTTP Server connects the two zones.

---

## The Three-Tier Security Zone Model

A properly hardened iStore deployment spans three network zones:

\`\`\`
Internet / External Users
         │
         │ HTTPS 443
         ▼
┌─────────────────────────────────┐
│           DMZ (Zone 1)          │
│                                 │
│  Oracle HTTP Server (OHS)       │  ← Public mid-tier
│  - SSL termination              │
│  - Reverse proxy to app tier    │
│  - Static content (OA_MEDIA)    │
│  - No WebLogic, no DB access    │
└─────────────────────────────────┘
         │
         │ HTTP 7201/7202 (WebLogic proxy ports)
         │ (Firewall: DMZ → Internal only, specific ports)
         ▼
┌─────────────────────────────────┐
│      Internal Network (Zone 2)  │
│                                 │
│  Oracle HTTP Server (OHS)       │  ← Internal web tier
│  WebLogic Domain                │
│  - AdminServer                  │
│  - oacore_server1 (OAF/iStore)  │
│  - oafm_server1                 │
│  - forms-c4ws_server1           │
│  Node Manager                   │
└─────────────────────────────────┘
         │
         │ JDBC 1521 (JDBC from WebLogic only)
         │ (Firewall: App tier → DB only)
         ▼
┌─────────────────────────────────┐
│      Database Network (Zone 3)  │
│                                 │
│  Oracle Database 19c            │
│  - EBS APPS schema              │
│  - iStore catalog data          │
└─────────────────────────────────┘
\`\`\`

### What Lives Where

**DMZ public mid-tier:**
- Oracle HTTP Server 12c (Apache-based) — the only process with a public IP
- SSL certificate from a public CA (DigiCert, Sectigo, etc.)
- \`mod_wl_ohs\` module — reverse-proxies iStore requests to the internal WebLogic cluster
- Static media serving (\`/OA_MEDIA\`) — served directly from the DMZ tier, no trip to WebLogic
- **No WebLogic, no database listener, no EBS AdminServer**

**Internal private mid-tier:**
- Full WebLogic domain with all EBS managed servers
- Internal OHS instance (used by internal EBS users, not exposed to DMZ)
- Node Manager
- All EBS application file system (\`$APPL_TOP\`, \`$FND_TOP\`, etc.)
- iStore application code runs on the oacore managed server

**Database tier:**
- Oracle Database 19c with the EBS schema
- No direct access from the DMZ — all database traffic originates from the internal WebLogic DataSources

---

## Why This Architecture

**Blast radius reduction.** If the DMZ OHS is compromised, the attacker has a web server process and static files. They cannot reach the WebLogic AdminServer, the database, or any internal EBS functionality — the firewall blocks all connections from the DMZ except the specific proxy ports to the oacore managed servers.

**Oracle support requirements.** Oracle's EBS security hardening guide explicitly states that the database tier must not be accessible from the DMZ, and the WebLogic AdminServer must not be accessible from external networks.

**SSL offloading in the DMZ.** The public SSL certificate lives on the DMZ OHS only. Internal traffic between the DMZ proxy and the WebLogic backend can use HTTP (within the secured internal network) or internal SSL (if policy requires end-to-end encryption). This keeps certificate management simple — one public cert in one place.

**Independent scaling.** The DMZ OHS layer can be scaled horizontally (multiple OHS nodes behind a load balancer) without touching the internal EBS stack.

---

## Oracle HTTP Server in the DMZ

The DMZ OHS instance is a standalone Apache-based Oracle HTTP Server installation — not a full EBS application tier. It is installed from the Oracle WebTier 12c installer or the Fusion Middleware 12c installer, separately from the EBS application tier.

### Key Modules

**\`mod_wl_ohs\`** — the WebLogic proxy module. This is the core component that forwards HTTP requests from the DMZ to the internal WebLogic cluster. It is aware of WebLogic cluster topology and can perform server-affinity routing based on WebLogic session cookies.

**\`mod_ssl\`** — handles TLS termination for the public HTTPS listener. The SSL certificate and key are configured here.

**\`mod_rewrite\`** — used for URL rewriting, HTTP-to-HTTPS redirects, and canonicalising iStore URL patterns.

### URL Routing for iStore

iStore in EBS 12.2 is an OAF (Oracle Application Framework) application that runs inside the \`oacore\` managed server. The key URL namespaces are:

| URL Path | Content | Routed To |
|----------|---------|-----------|
| \`/OA_HTML/\` | iStore OAF pages | oacore_server1 (via mod_wl_ohs) |
| \`/OA_MEDIA/\` | Images, CSS, JS | Served directly from DMZ filesystem |
| \`/OA_CGI/\` | CGI scripts (legacy) | Served from DMZ |
| \`/oacore/\` | Direct WebLogic context | oacore_server1 (via mod_wl_ohs) |
| \`/pls/\` | mod_plsql DAD (if used) | Internal DB via DAD (avoid in DMZ) |

The critical rule: \`/OA_HTML\` requests go to the internal WebLogic oacore server, never to a database DAD from the DMZ.

---

## OHS Virtual Host Configuration for iStore

The DMZ OHS \`ssl.conf\` and \`mod_wl_ohs.conf\` work together to route iStore traffic:

### ssl.conf — HTTPS Virtual Host

\`\`\`apache
# /u01/oracle/web/instances/ohs_dmz/config/OHS/ohs1/ssl.conf

Listen 443

<VirtualHost *:443>
    ServerName  store.yourcompany.com
    ServerAlias store.yourcompany.com

    SSLEngine           on
    SSLProtocol         TLSv1.2 TLSv1.3
    SSLCipherSuite      ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:!aNULL:!MD5
    SSLCertificateFile      /etc/ssl/certs/istore.yourcompany.com.crt
    SSLCertificateKeyFile   /etc/ssl/private/istore.yourcompany.com.key
    SSLCertificateChainFile /etc/ssl/certs/istore_chain.crt

    # Serve static media directly from the DMZ — no round-trip to WebLogic
    Alias /OA_MEDIA  /u01/oracle/ebs/fs1/EBSapps/appl/fnd/12.0.0/media
    <Directory "/u01/oracle/ebs/fs1/EBSapps/appl/fnd/12.0.0/media">
        Options None
        AllowOverride None
        Require all granted
    </Directory>

    # Route all OAF/iStore requests to the internal WebLogic cluster
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

    # Redirect HTTP to HTTPS
    RewriteEngine On
    RewriteCond %{HTTPS} !=on
    RewriteRule ^/?(.*) https://%{SERVER_NAME}/\$1 [R=301,L]

    ErrorLog    /u01/oracle/web/logs/istore_ssl_error.log
    CustomLog   /u01/oracle/web/logs/istore_ssl_access.log combined
</VirtualHost>
\`\`\`

### mod_wl_ohs.conf — WebLogic Proxy Settings

\`\`\`apache
# /u01/oracle/web/instances/ohs_dmz/config/OHS/ohs1/mod_wl_ohs.conf

LoadModule weblogic_module  modules/mod_wl_ohs.so

<IfModule mod_weblogic.c>
    # Cluster health check interval (seconds)
    ConnectTimeoutSecs      10
    ConnectRetrySecs        2

    # Session stickiness — routes repeat requests to the same managed server
    WLCookieName            JSESSIONID
    KeepAliveEnabled        ON
    KeepAliveSecs           20

    # Log WebLogic proxy events
    WLLogFile  /u01/oracle/web/logs/mod_wl_ohs.log
    Debug      ERR

    # Security — do not forward the WebLogic internal headers
    WLTrustedServers  internal-app1.corp.local,internal-app2.corp.local
</IfModule>
\`\`\`

---

## Internal Mid-Tier: No Special iStore Configuration

The internal EBS application tier runs a standard EBS 12.2 WebLogic domain. The oacore managed server handles all OAF requests — iStore is just another OAF application from its perspective.

The internal OHS instance (\`httpd.conf\`) does not need to know about iStore specifically. It routes \`/OA_HTML\` to the oacore managed server through the internal WebLogic proxy, exactly as it would for any other OAF page.

What must be correct on the internal tier:

**WebLogic oacore listen address** must be set to \`0.0.0.0\` (all interfaces) or explicitly to the IP reachable from the DMZ. A listen address of \`127.0.0.1\` will silently drop all incoming proxy connections from the DMZ OHS.

**WebLogic connection filters** can whitelist only the DMZ OHS IP addresses for the oacore port — preventing any other DMZ host from connecting directly:

\`\`\`
weblogic.security.net.ConnectionFilterImpl
allow * * 7201 7202 from 10.10.1.0/24;    # DMZ subnet only
deny * * 7201 7202 from *;
\`\`\`

---

## iStore Profile Options That Drive the URL Architecture

iStore uses several EBS profile options to construct URLs. These must point to the DMZ OHS hostname, not the internal application tier:

| Profile Option | Purpose | DMZ Value |
|----------------|---------|-----------|
| \`IBE_STORE_URL\` | Base URL for iStore — used in all self-referencing links | \`https://store.yourcompany.com\` |
| \`IBE_ADMIN_EMAIL\` | Sender address for iStore transactional emails | \`noreply@yourcompany.com\` |
| \`IBE_DEFAULT_SERVLET_PORT\` | Port for iStore servlet | \`443\` |
| \`IBE_MEDIA_PHYSICAL_LOCATION\` | Filesystem path for media files (on DMZ) | Path to OA_MEDIA on DMZ tier |
| \`IBE_MEDIA_URL\` | URL prefix for media — must resolve via DMZ | \`https://store.yourcompany.com/OA_MEDIA\` |
| \`APPS_FRAMEWORK_AGENT\` | Base URL for OAF pages — used by internal users | \`https://internal.corp.local:4443\` (internal OHS) |
| \`ICX_FORMS_LAUNCHER\` | Forms URL — internal only | Internal OHS URL only |

The distinction between \`IBE_STORE_URL\` (pointing to the DMZ) and \`APPS_FRAMEWORK_AGENT\` (pointing to the internal tier) is the key to having external iStore customers use the public URL while internal EBS users use the internal URL for all other modules.

---

## Session Management Across the Proxy

Oracle Application Framework uses a \`JSESSIONID\` cookie for WebLogic session affinity. When the DMZ OHS proxies a request to oacore_server1, WebLogic sets \`JSESSIONID\` in the response. The OHS proxy module reads this cookie and routes subsequent requests from the same browser session back to the same managed server.

For this to work correctly:
- The cookie domain must match the public hostname (\`store.yourcompany.com\`)
- The \`mod_wl_ohs\` \`WLCookieName JSESSIONID\` directive must be set
- The load balancer in front of multiple DMZ OHS nodes must use session affinity (sticky sessions) at the OHS level, not just at the WebLogic level

---

## Firewall Rules Required

| From | To | Protocol/Port | Purpose |
|------|----|--------------|---------|
| Internet | DMZ OHS | TCP 443 | HTTPS iStore access |
| Internet | DMZ OHS | TCP 80 | HTTP → HTTPS redirect |
| DMZ OHS | Internal oacore servers | TCP 7201 | WebLogic HTTP proxy port |
| DMZ OHS | Internal oacore servers | TCP 7202 | WebLogic HTTPS proxy port (if internal SSL) |
| Internal app tier | DB tier | TCP 1521 | JDBC from WebLogic DataSources |
| **Explicitly blocked** | | | |
| DMZ OHS | Internal AdminServer (7001/7002) | TCP | No admin access from DMZ |
| DMZ OHS | DB tier | TCP 1521 | No DB access from DMZ |
| Internet | Internal network | Any | No direct access — all through DMZ |

The companion runbook covers the complete installation, OHS configuration, profile option setup, and end-to-end validation procedure.`,
};

async function main() {
  console.log('Inserting EBS iStore DMZ architecture blog post...');
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
