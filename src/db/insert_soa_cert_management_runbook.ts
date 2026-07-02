import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Node.js SOA Gateway Certificate Manager — Installation, Operation, and Troubleshooting',
  slug: 'nodejs-soa-gateway-cert-management-runbook',
  excerpt: 'Step-by-step operational runbook for installing, configuring, and operating the Node.js SOA Gateway Certificate Manager. Covers project setup, environments.json configuration, full certManager.js and weblogicClient.js implementations, systemd service, Nginx reverse proxy, operational procedures for certificate rotation, and a troubleshooting reference table.',
  category: 'soa-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-02'),
  youtubeUrl: null,
  content: `## Purpose

This runbook covers the installation, configuration, and day-to-day operation of the Node.js SOA Gateway Certificate Manager described in the companion blog post. It is intended for the DBA or middleware administrator responsible for maintaining Oracle SOA Suite gateway certificate health. Follow these steps sequentially for a new installation. Refer to the troubleshooting section and operational procedures for ongoing operations.

---

## Prerequisites

Before beginning, confirm the following on the admin server where the tool will be installed:

| Requirement | How to verify |
|---|---|
| Node.js 18 or later | \`node --version\` → must show v18.x or higher |
| npm 9 or later | \`npm --version\` |
| Java 8 or later (for keytool) | \`keytool -version\` → must resolve without "command not found" |
| Network access to WebLogic admin port (7001/7002) | \`curl -k https://soa-admin-host:7002/management/weblogic/latest/\` |
| Read access to keystore files | \`ls -la /u01/oracle/domains/soa_domain/security/identity.jks\` |
| Port 3443 available on admin server | \`ss -tlnp | grep 3443\` → no output means port is free |
| \`soaCertMgr\` OS user created | \`id soaCertMgr\` → must resolve |

Create the OS user if it does not exist:

\`\`\`bash
useradd -r -s /bin/false -d /opt/soa-cert-manager soaCertMgr
\`\`\`

Add it to the group that owns the keystore files (replace \`oinstall\` with the actual group):

\`\`\`bash
usermod -aG oinstall soaCertMgr
\`\`\`

---

## Step 1: Project Setup

Create the application directory and install dependencies:

\`\`\`bash
mkdir -p /opt/soa-cert-manager/{public,uploads,data,logs}
cd /opt/soa-cert-manager
npm init -y
npm install express multer better-sqlite3 axios node-cron express-session express-rate-limit
\`\`\`

Set directory ownership and permissions:

\`\`\`bash
chown -R soaCertMgr:soaCertMgr /opt/soa-cert-manager
chmod 700 /opt/soa-cert-manager/uploads
chmod 750 /opt/soa-cert-manager/data
\`\`\`

Expected directory structure after setup:

\`\`\`
/opt/soa-cert-manager/
├── server.js
├── certManager.js
├── weblogicClient.js
├── auditDb.js
├── environments.json
├── .secrets/
│   └── passwords.json        (chmod 600, owned by soaCertMgr)
├── public/
│   ├── index.html
│   └── app.js
├── uploads/                  (chmod 700 — temp staging for uploaded files)
├── data/
│   └── audit.db              (created automatically on first run)
└── logs/
    ├── app.log
    └── error.log
\`\`\`

---

## Step 2: environments.json

Create \`/opt/soa-cert-manager/environments.json\` with one entry per SOA environment. In this example \`dev\` and \`prod\` are shown; add \`test\`, \`uat\`, or additional entries following the same structure:

\`\`\`json
{
  "dev": {
    "host": "soa-dev-app01.example.com",
    "keystorePath": "/u01/oracle/domains/soa_domain/security/identity.jks",
    "truststorePath": "/u01/oracle/domains/soa_domain/security/trust.jks",
    "keystorePasswordKey": "dev_keystore",
    "weblogicAdminUrl": "https://soa-dev-admin01.example.com:7002",
    "weblogicUser": "weblogic",
    "weblogicPasswordKey": "dev_weblogic",
    "managedServers": ["soa_server1", "soa_server2"]
  },
  "prod": {
    "host": "soa-prod-app01.example.com",
    "keystorePath": "/u01/oracle/domains/soa_domain/security/identity.jks",
    "truststorePath": "/u01/oracle/domains/soa_domain/security/trust.jks",
    "keystorePasswordKey": "prod_keystore",
    "weblogicAdminUrl": "https://soa-prod-admin01.example.com:7002",
    "weblogicUser": "weblogic",
    "weblogicPasswordKey": "prod_weblogic",
    "managedServers": ["soa_server1", "soa_server2", "soa_server3"]
  }
}
\`\`\`

The \`keystorePasswordKey\` and \`weblogicPasswordKey\` fields reference keys in the secrets file rather than containing plaintext passwords. Create \`/opt/soa-cert-manager/.secrets/passwords.json\`:

\`\`\`json
{
  "dev_keystore": "ChangeMeDevKeystorePass",
  "dev_weblogic": "ChangeMeDevWLPass",
  "prod_keystore": "ChangeMeProdKeystorePass",
  "prod_weblogic": "ChangeMeProdWLPass"
}
\`\`\`

Lock down the secrets file:

\`\`\`bash
chmod 600 /opt/soa-cert-manager/.secrets/passwords.json
chown soaCertMgr:soaCertMgr /opt/soa-cert-manager/.secrets/passwords.json
\`\`\`

In production, replace plaintext passwords with calls to your secrets vault API (HashiCorp Vault, CyberArk, AWS Secrets Manager) in the startup code that loads this file.

---

## Step 3: Audit Database Initialization — auditDb.js

Create \`/opt/soa-cert-manager/auditDb.js\`:

\`\`\`javascript
'use strict';
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'audit.db');
const db = new Database(DB_PATH);

// Initialize schema on first run
db.exec(\`
  CREATE TABLE IF NOT EXISTS audit_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT    NOT NULL,
    user      TEXT    NOT NULL,
    environment TEXT  NOT NULL,
    action    TEXT    NOT NULL,
    alias     TEXT,
    result    TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log (timestamp);
  CREATE INDEX IF NOT EXISTS idx_audit_env       ON audit_log (environment);
\`);

function insertAudit({ user, environment, action, alias, result }) {
  db.prepare(
    'INSERT INTO audit_log (timestamp, user, environment, action, alias, result) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(new Date().toISOString(), user ?? 'unknown', environment, action, alias ?? null, result);
}

function getRecentAudit(limit = 100) {
  return db.prepare(
    'SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?'
  ).all(limit);
}

module.exports = { insertAudit, getRecentAudit };
\`\`\`

The database is created automatically at \`data/audit.db\` on the first run. The \`CREATE TABLE IF NOT EXISTS\` pattern means this file is safe to run repeatedly — it is idempotent.

---

## Step 4: certManager.js — Full Implementation

Create \`/opt/soa-cert-manager/certManager.js\`:

\`\`\`javascript
'use strict';
const { execSync } = require('child_process');
const fs = require('fs');

function sanitizePath(p) {
  if (!/^[\\/\\w.\\-]+$/.test(p)) throw new Error(\`Invalid path: \${p}\`);
  return p;
}

function sanitizeAlias(a) {
  if (!/^[\\w.\\-]+$/.test(a)) throw new Error(\`Invalid alias: \${a}\`);
  return a;
}

function listAliases(keystorePath, keystorePassword) {
  sanitizePath(keystorePath);
  const cmd = \`keytool -list -keystore "\${keystorePath}" -storepass "\${keystorePassword}"\`;
  let output;
  try {
    output = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error(\`keytool listAliases failed: \${e.stderr || e.message}\`);
  }
  const aliasRegex = /^(\\S+),\\s+/gm;
  const aliases = [];
  let match;
  while ((match = aliasRegex.exec(output)) !== null) {
    aliases.push(match[1]);
  }
  return aliases;
}

function getCertDetails(keystorePath, keystorePassword, alias) {
  sanitizePath(keystorePath);
  sanitizeAlias(alias);
  const cmd = [
    'keytool -list -v',
    \`-keystore "\${keystorePath}"\`,
    \`-storepass "\${keystorePassword}"\`,
    \`-alias "\${alias}"\`
  ].join(' ');
  let output;
  try {
    output = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error(\`keytool getCertDetails failed for alias "\${alias}": \${e.stderr || e.message}\`);
  }
  const result = { alias, expiry: null, subject: '', issuer: '', serialNumber: '' };
  for (const line of output.split('\\n')) {
    const t = line.trim();
    if (t.startsWith('Valid until:')) {
      result.expiry = new Date(t.replace('Valid until:', '').trim());
    } else if (t.startsWith('Owner:')) {
      result.subject = t.replace('Owner:', '').trim();
    } else if (t.startsWith('Issuer:')) {
      result.issuer = t.replace('Issuer:', '').trim();
    } else if (t.startsWith('Serial number:')) {
      result.serialNumber = t.replace('Serial number:', '').trim();
    }
  }
  return result;
}

function importPkcs12ToJks(p12Path, p12Password, jksPath, jksPassword, alias) {
  sanitizePath(p12Path);
  sanitizePath(jksPath);
  sanitizeAlias(alias);
  if (!fs.existsSync(p12Path)) throw new Error(\`Source PKCS12 file not found: \${p12Path}\`);
  const cmd = [
    'keytool -importkeystore',
    \`-srckeystore "\${p12Path}"\`,
    '-srcstoretype PKCS12',
    \`-srcstorepass "\${p12Password}"\`,
    \`-destkeystore "\${jksPath}"\`,
    '-deststoretype JKS',
    \`-deststorepass "\${jksPassword}"\`,
    \`-destalias "\${alias}"\`,
    '-noprompt'
  ].join(' ');
  try {
    execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error(\`keytool importPkcs12ToJks failed: \${e.stderr || e.message}\`);
  }
}

function importCaCert(caCertPath, truststorePath, truststorePassword, alias) {
  sanitizePath(caCertPath);
  sanitizePath(truststorePath);
  sanitizeAlias(alias);
  if (!fs.existsSync(caCertPath)) throw new Error(\`CA cert file not found: \${caCertPath}\`);
  const cmd = [
    'keytool -importcert',
    \`-keystore "\${truststorePath}"\`,
    \`-storepass "\${truststorePassword}"\`,
    \`-alias "\${alias}"\`,
    \`-file "\${caCertPath}"\`,
    '-noprompt',
    '-trustcacerts'
  ].join(' ');
  try {
    execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error(\`keytool importCaCert failed: \${e.stderr || e.message}\`);
  }
}

function deleteCert(keystorePath, keystorePassword, alias) {
  sanitizePath(keystorePath);
  sanitizeAlias(alias);
  const cmd = [
    'keytool -delete',
    \`-keystore "\${keystorePath}"\`,
    \`-storepass "\${keystorePassword}"\`,
    \`-alias "\${alias}"\`
  ].join(' ');
  try {
    execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error(\`keytool deleteCert failed for alias "\${alias}": \${e.stderr || e.message}\`);
  }
}

function checkExpiryAll(environments, secrets) {
  const results = [];
  for (const [envName, env] of Object.entries(environments)) {
    const ksPass = secrets[env.keystorePasswordKey];
    try {
      const aliases = listAliases(env.keystorePath, ksPass);
      for (const alias of aliases) {
        const detail = getCertDetails(env.keystorePath, ksPass, alias);
        const daysLeft = detail.expiry
          ? Math.floor((detail.expiry.getTime() - Date.now()) / 86400000)
          : -1;
        results.push({ env: envName, alias, daysLeft, subject: detail.subject, expiry: detail.expiry });
      }
    } catch (err) {
      results.push({ env: envName, alias: 'ERROR', daysLeft: -1, error: err.message });
    }
  }
  return results;
}

module.exports = { listAliases, getCertDetails, importPkcs12ToJks, importCaCert, deleteCert, checkExpiryAll };
\`\`\`

The \`sanitizePath\` and \`sanitizeAlias\` functions provide basic input validation before constructing shell commands. This prevents path traversal and command injection via crafted alias names or file paths submitted through the web UI.

---

## Step 5: weblogicClient.js — Full Implementation

Create \`/opt/soa-cert-manager/weblogicClient.js\`:

\`\`\`javascript
'use strict';
const axios = require('axios');
const https = require('https');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

async function getServerStatus(adminUrl, user, password, serverName) {
  const url = \`\${adminUrl}/management/weblogic/latest/domainRuntime/serverLifeCycleRuntimes/\${serverName}\`;
  try {
    const resp = await axios.get(url, { auth: { username: user, password }, httpsAgent });
    return resp.data.state ?? 'UNKNOWN';
  } catch (e) {
    throw new Error(\`getServerStatus failed for \${serverName}: \${e.response?.status} \${e.message}\`);
  }
}

async function shutdownServer(adminUrl, user, password, serverName, force = false) {
  const action = force ? 'forceShutdown' : 'shutdown';
  const url = \`\${adminUrl}/management/weblogic/latest/domainRuntime/serverLifeCycleRuntimes/\${serverName}/\${action}\`;
  try {
    await axios.post(url, {}, { auth: { username: user, password }, httpsAgent });
  } catch (e) {
    // 503 is expected during shutdown — the server stops accepting connections
    if (e.response?.status === 503) return;
    throw new Error(\`shutdownServer failed for \${serverName}: \${e.response?.status} \${e.message}\`);
  }
}

async function startServer(adminUrl, user, password, serverName) {
  const url = \`\${adminUrl}/management/weblogic/latest/domainRuntime/serverLifeCycleRuntimes/\${serverName}/start\`;
  try {
    await axios.post(url, {}, { auth: { username: user, password }, httpsAgent });
  } catch (e) {
    throw new Error(\`startServer failed for \${serverName}: \${e.response?.status} \${e.message}\`);
  }
}

async function waitForState(adminUrl, user, password, serverName, targetState, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const state = await getServerStatus(adminUrl, user, password, serverName);
      if (state === targetState) return;
    } catch (_) {
      // Server may be unreachable while shutting down — keep polling
    }
  }
  throw new Error(\`Timeout waiting for \${serverName} to reach state \${targetState}\`);
}

async function restartServer(adminUrl, user, password, serverName) {
  await shutdownServer(adminUrl, user, password, serverName, true);
  await waitForState(adminUrl, user, password, serverName, 'SHUTDOWN');
  await startServer(adminUrl, user, password, serverName);
  await waitForState(adminUrl, user, password, serverName, 'RUNNING');
}

module.exports = { getServerStatus, shutdownServer, startServer, restartServer };
\`\`\`

The \`waitForState\` function polls the server status every 5 seconds up to a configurable timeout (120 seconds by default). This is more reliable than a fixed \`setTimeout\` delay because WebLogic shutdown and startup times vary with deployment size and JVM heap.

---

## Step 6: server.js — Full Express Application

Create \`/opt/soa-cert-manager/server.js\`:

\`\`\`javascript
'use strict';
const express    = require('express');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const session    = require('express-session');
const rateLimit  = require('express-rate-limit');
const cron       = require('node-cron');

const certManager    = require('./certManager');
const weblogicClient = require('./weblogicClient');
const { insertAudit, getRecentAudit } = require('./auditDb');

const app  = express();
const PORT = process.env.PORT || 3443;

// Load config
const environments = JSON.parse(fs.readFileSync(path.join(__dirname, 'environments.json'), 'utf8'));
const secrets      = JSON.parse(fs.readFileSync(path.join(__dirname, '.secrets', 'passwords.json'), 'utf8'));

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 8 * 3600 * 1000 }
}));

// Auth middleware (replace with LDAP as needed)
function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// Upload rate limit
const uploadLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10 });

// Multer upload
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 5 * 1024 * 1024 } // 5 MB
});

// Helper: resolve env passwords
function envPasswords(envName) {
  const env = environments[envName];
  if (!env) throw new Error(\`Unknown environment: \${envName}\`);
  return {
    env,
    ksPass: secrets[env.keystorePasswordKey],
    tsPass: secrets[env.truststorePasswordKey ?? env.keystorePasswordKey],
    wlPass: secrets[env.weblogicPasswordKey]
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  // Replace with LDAP/database auth
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    req.session.user = username;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// GET /api/certs — dashboard data for all environments
app.get('/api/certs', requireAuth, async (req, res) => {
  const results = certManager.checkExpiryAll(environments, secrets);
  results.sort((a, b) => a.daysLeft - b.daysLeft);
  res.json(results);
});

// GET /api/certs/:env/:alias — detail for one certificate
app.get('/api/certs/:env/:alias', requireAuth, (req, res) => {
  try {
    const { env: ksPass } = envPasswords(req.params.env);
    const { env, ksPass: keystorePass } = envPasswords(req.params.env);
    const detail = certManager.getCertDetails(env.keystorePath, keystorePass, req.params.alias);
    res.json(detail);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/certs/:env/upload — import PKCS12 into identity JKS
app.post('/api/certs/:env/upload', requireAuth, uploadLimiter, upload.single('certFile'), async (req, res) => {
  const { env, ksPass } = envPasswords(req.params.env);
  const { alias, srcPassword } = req.body;
  const tmpPath = req.file?.path;
  try {
    if (!tmpPath) throw new Error('No file uploaded');
    // Backup existing keystore
    const bak = \`\${env.keystorePath}.bak.\${Date.now()}\`;
    fs.copyFileSync(env.keystorePath, bak);
    // Import
    certManager.importPkcs12ToJks(tmpPath, srcPassword, env.keystorePath, ksPass, alias);
    insertAudit({ user: req.session.user, environment: req.params.env, action: 'import', alias, result: 'success' });
    res.json({ ok: true, backup: bak });
  } catch (err) {
    insertAudit({ user: req.session.user, environment: req.params.env, action: 'import', alias, result: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
});

// POST /api/certs/:env/import-ca — import CA cert into trust JKS
app.post('/api/certs/:env/import-ca', requireAuth, upload.single('caCert'), async (req, res) => {
  const { env, tsPass } = envPasswords(req.params.env);
  const { alias } = req.body;
  const tmpPath = req.file?.path;
  try {
    if (!tmpPath) throw new Error('No CA cert file uploaded');
    certManager.importCaCert(tmpPath, env.truststorePath, tsPass, alias);
    insertAudit({ user: req.session.user, environment: req.params.env, action: 'import-ca', alias, result: 'success' });
    res.json({ ok: true });
  } catch (err) {
    insertAudit({ user: req.session.user, environment: req.params.env, action: 'import-ca', alias, result: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
});

// DELETE /api/certs/:env/:alias — delete alias from identity JKS
app.delete('/api/certs/:env/:alias', requireAuth, (req, res) => {
  const { env, ksPass } = envPasswords(req.params.env);
  const { alias } = req.params;
  try {
    certManager.deleteCert(env.keystorePath, ksPass, alias);
    insertAudit({ user: req.session.user, environment: req.params.env, action: 'delete', alias, result: 'success' });
    res.json({ ok: true });
  } catch (err) {
    insertAudit({ user: req.session.user, environment: req.params.env, action: 'delete', alias, result: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/servers/:env/:server/restart — restart a managed server
app.post('/api/servers/:env/:server/restart', requireAuth, async (req, res) => {
  const { env, wlPass } = envPasswords(req.params.env);
  const serverName = req.params.server;
  try {
    await weblogicClient.restartServer(env.weblogicAdminUrl, env.weblogicUser, wlPass, serverName);
    insertAudit({ user: req.session.user, environment: req.params.env, action: 'restart', alias: serverName, result: 'success' });
    res.json({ ok: true });
  } catch (err) {
    insertAudit({ user: req.session.user, environment: req.params.env, action: 'restart', alias: serverName, result: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/audit — last 100 audit log entries
app.get('/api/audit', requireAuth, (req, res) => {
  res.json(getRecentAudit(100));
});

// GET / — serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Background cron: check expiry every hour ──────────────────────────────────
cron.schedule('0 * * * *', () => {
  const results = certManager.checkExpiryAll(environments, secrets);
  for (const cert of results) {
    if (cert.daysLeft >= 0 && cert.daysLeft < 30) {
      console.warn(\`[CERT_EXPIRY_ALERT] \${cert.env}/\${cert.alias} expires in \${cert.daysLeft} days (\${cert.subject})\`);
    }
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(\`SOA Cert Manager listening on port \${PORT}\`);
});
\`\`\`

---

## Step 7: systemd Service File

Create \`/etc/systemd/system/soa-cert-manager.service\`:

\`\`\`ini
[Unit]
Description=SOA Gateway Certificate Manager
After=network.target

[Service]
Type=simple
User=soaCertMgr
WorkingDirectory=/opt/soa-cert-manager
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=10
StandardOutput=append:/opt/soa-cert-manager/logs/app.log
StandardError=append:/opt/soa-cert-manager/logs/error.log
Environment=NODE_ENV=production
Environment=PORT=3443
Environment=SESSION_SECRET=ReplaceWithAStrongRandomSecret
Environment=ADMIN_USER=certadmin
Environment=ADMIN_PASS=ReplaceWithAStrongPassword

[Install]
WantedBy=multi-user.target
\`\`\`

Enable and start the service:

\`\`\`bash
systemctl daemon-reload
systemctl enable soa-cert-manager
systemctl start soa-cert-manager
systemctl status soa-cert-manager
\`\`\`

Verify logs are being written:

\`\`\`bash
tail -f /opt/soa-cert-manager/logs/app.log
\`\`\`

Expected output on successful startup:

\`\`\`
SOA Cert Manager listening on port 3443
\`\`\`

---

## Step 8: Nginx Reverse Proxy Configuration

Install Nginx if not already present: \`yum install -y nginx\` or \`apt-get install -y nginx\`.

Create \`/etc/nginx/conf.d/soa-cert-manager.conf\`:

\`\`\`nginx
limit_req_zone \$binary_remote_addr zone=upload_limit:10m rate=1r/s;

server {
    listen 443 ssl;
    server_name soa-cert-mgr.example.com;

    ssl_certificate     /etc/ssl/certs/soa-cert-manager.crt;
    ssl_certificate_key /etc/ssl/private/soa-cert-manager.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    # Rate-limit the upload endpoint
    location ~ ^/api/certs/[^/]+/upload$ {
        limit_req zone=upload_limit burst=5 nodelay;
        proxy_pass         http://127.0.0.1:3443;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        client_max_body_size 10m;
    }

    location / {
        proxy_pass         http://127.0.0.1:3443;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
    }
}

server {
    listen 80;
    server_name soa-cert-mgr.example.com;
    return 301 https://\$host\$request_uri;
}
\`\`\`

Test and reload Nginx:

\`\`\`bash
nginx -t
systemctl reload nginx
\`\`\`

---

## Step 9: Operational Procedures

### Procedure 1: Planned Identity Certificate Rotation

Use this procedure when renewing an expiring identity certificate from the CA.

**Before you start:**
- Confirm the new certificate covers the same hostname SANs as the existing one
- Schedule a maintenance window if this is production (managed server restart required)
- Note the existing alias name: browse to the dashboard, click the environment, note the alias

**Steps:**

1. Obtain the new PKCS12 file from your CA and the import password.
2. In the dashboard, select the target environment and click **Upload Certificate**.
3. Choose the PKCS12 file, enter the alias (must match the existing alias WebLogic is configured to use), enter the PKCS12 source password, and submit.
4. The tool backs up the existing keystore automatically before import. Confirm the backup path shown in the success message.
5. Verify the import: the dashboard should now show the new certificate with an updated expiry date under the same alias.
6. Navigate to **Servers**, select the environment, and restart managed servers one at a time. Wait for each server to reach RUNNING status before restarting the next.
7. Verify from outside: run the openssl check below against each managed server's HTTPS endpoint.
8. Update your certificate expiry tracking (if maintained separately) with the new expiry date.

### Procedure 2: Emergency Certificate Replacement (Expired Certificate)

This procedure is identical to Procedure 1 but with urgency and caution notes.

**Critical: Do not restart all managed servers simultaneously.** An expired identity certificate causes SSL failures for all clients. If you restart all servers at once, there is a window where none are available. Always keep at least one server running while restarting others. The sequence:

1. Upload and import the new certificate (steps 1–5 above).
2. Restart \`soa_server1\`. Wait for RUNNING state. Verify SSL with openssl.
3. If \`soa_server1\` is healthy, restart \`soa_server2\`. Wait, verify.
4. Continue until all servers are restarted.

If any server fails to start after the import:
- Check \`/u01/oracle/domains/soa_domain/servers/<server_name>/logs/<server_name>.log\` for keystore exceptions
- Restore the backup keystore: \`cp identity.jks.bak.<timestamp> identity.jks\`
- Restart the server — it will come up with the old certificate (which may be expired, but at least it comes up)
- Investigate the import error before retrying

### Procedure 3: Import New CA Certificate into Trust Store

Use this when a backend service your SOA composites call has rotated its issuing CA.

1. Obtain the new CA certificate in PEM format from the backend service team.
2. In the dashboard, navigate to **Trust Store** for the target environment.
3. Click **Import CA Certificate**, upload the PEM file, and enter a descriptive alias (e.g., \`backend-payments-ca-2026\`).
4. The import does not require a server restart — WebLogic reads trust store changes without a full restart in most configurations. Test by triggering a composite call to the backend service and confirming it succeeds.
5. If WebLogic does not pick up the trust store change dynamically, a managed server restart is required. Follow the rolling restart sequence from Procedure 1.

### Procedure 4: Add a New Environment

1. Obtain the keystore paths, passwords, WebLogic admin URL, and managed server names for the new environment.
2. Add an entry to \`/opt/soa-cert-manager/environments.json\` following the existing structure.
3. Add the password keys to \`/opt/soa-cert-manager/.secrets/passwords.json\`.
4. Restart the service: \`systemctl restart soa-cert-manager\`
5. Open the dashboard and confirm the new environment appears in the certificate table.
6. If the keystore files are on a different host, verify the \`soaCertMgr\` user can read them (NFS mount or SSH tunnel as appropriate).

---

## Step 10: Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| \`keytool: keystore file does not exist\` | Path wrong in environments.json | Verify the exact path with \`ls -la\` as the \`soaCertMgr\` user; check NFS mount status |
| \`keytool: Keystore was tampered with, or password was incorrect\` | Wrong keystore password in secrets file | Confirm the correct password from vault; test manually: \`keytool -list -keystore <path> -storepass <pass>\` |
| Dashboard shows \`ERROR\` row for an environment | keytool command failed for that environment | Click the error row to see the full error message; check service logs at \`/opt/soa-cert-manager/logs/app.log\` |
| WebLogic restart returns 401 | \`weblogicUser\` or \`weblogicPassword\` wrong in secrets | Test manually with curl: \`curl -k -u weblogic:<pass> https://admin-host:7002/management/weblogic/latest/\` |
| Upload returns HTTP 413 | Uploaded file exceeds multer \`fileSize\` limit (5 MB default) | Increase the limit in server.js: \`limits: { fileSize: 20 * 1024 * 1024 }\` |
| \`Dashboard shows -1 days\` for a certificate | keytool \`Valid until\` line parse failed | Check Java locale — run \`keytool -list -v -keystore <path> -storepass <pass> -alias <alias>\` manually and inspect the exact output of the \`Valid until\` line |
| Certificate shows under wrong alias after import | Submitted wrong alias in the upload form | Use Delete + re-import with the correct alias. The correct alias is whatever is configured in WebLogic's \`CustomIdentityKeyStoreAliasName\` |
| Service fails to start — \`Cannot find module 'better-sqlite3'\` | npm install was not run as the correct user | Run \`npm install\` from \`/opt/soa-cert-manager/\` as root or \`soaCertMgr\`; verify \`node_modules/\` exists |
| Session expires after page reload | \`SESSION_SECRET\` changed between restarts | Set a stable \`SESSION_SECRET\` in the systemd unit file environment block |
| \`CERT_EXPIRY_ALERT\` not appearing in logs | Cron job not running | Confirm the service is running (\`systemctl status soa-cert-manager\`); check that the system clock is correct (\`date\`) |

---

## Verification Commands

### Verify the certificate from outside the server

Check the certificate presented by the SOA gateway HTTPS endpoint:

\`\`\`bash
openssl s_client -connect soa-gateway.example.com:443 -showcerts </dev/null 2>/dev/null | openssl x509 -noout -dates -subject
\`\`\`

Check just the expiry date:

\`\`\`bash
echo | openssl s_client -connect soa-gateway.example.com:443 2>/dev/null | openssl x509 -noout -enddate
\`\`\`

### Verify the certificate from inside the keystore

List all aliases with their expiry dates:

\`\`\`bash
keytool -list -v -keystore /u01/oracle/domains/soa_domain/security/identity.jks -storepass \${KEYSTORE_PASS} | grep -A3 "Alias name"
\`\`\`

Verify a specific alias:

\`\`\`bash
keytool -list -v \\
  -keystore /u01/oracle/domains/soa_domain/security/identity.jks \\
  -storepass \${KEYSTORE_PASS} \\
  -alias soagateway
\`\`\`

### Verify the trust store contents

List all CA certificates in the trust store:

\`\`\`bash
keytool -list -keystore /u01/oracle/domains/soa_domain/security/trust.jks -storepass \${TRUSTSTORE_PASS}
\`\`\`

### Test WebLogic Management API connectivity

\`\`\`bash
curl -sk -u weblogic:\${WL_PASS} \\
  https://soa-admin.example.com:7002/management/weblogic/latest/domainRuntime/serverLifeCycleRuntimes \\
  | python3 -m json.tool | grep -E '"name"|"state"'
\`\`\`

---

## Backup and Recovery

**Before any certificate operation:** the server.js upload route automatically creates a timestamped backup of the identity JKS before importing. Confirm the backup path in the API response. If the backup was not created automatically, create it manually:

\`\`\`bash
cp /u01/oracle/domains/soa_domain/security/identity.jks \\
   /u01/oracle/domains/soa_domain/security/identity.jks.bak.\$(date +%Y%m%d%H%M%S)
\`\`\`

**Recovery from a bad import:** if a managed server fails to start after a certificate import, restore the backup and restart:

\`\`\`bash
# Stop the managed server first (via NodeManager or Admin Console if it is in a failed state)
cp /u01/oracle/domains/soa_domain/security/identity.jks.bak.<timestamp> \\
   /u01/oracle/domains/soa_domain/security/identity.jks
# Then start the managed server through Admin Console or WLST
\`\`\`

**Audit log backup:** the SQLite audit database grows slowly (a few MB per year for typical usage). Include it in nightly backup jobs:

\`\`\`bash
# Add to cron or backup script
sqlite3 /opt/soa-cert-manager/data/audit.db ".backup /backup/audit-\$(date +%Y%m%d).db"
\`\`\`

The audit log records every operation — use it to reconstruct what happened if a certificate issue is discovered. The \`/api/audit\` route in the web UI shows the last 100 entries; for full historical queries, connect directly to the SQLite file:

\`\`\`bash
sqlite3 /opt/soa-cert-manager/data/audit.db \\
  "SELECT timestamp, user, environment, action, alias, result FROM audit_log ORDER BY timestamp DESC LIMIT 50;"
\`\`\``,
};

async function main() {
  console.log('Inserting SOA cert management runbook...');
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
