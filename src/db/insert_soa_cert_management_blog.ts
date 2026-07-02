import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Building a Node.js Web Interface for Oracle SOA Gateway Certificate Management',
  slug: 'nodejs-soa-gateway-cert-management',
  excerpt: 'Certificate management for Oracle SOA Suite gateway endpoints — renewals, CA trust chain updates, keystore rotations — traditionally requires direct server access and manual keytool commands. A Node.js web interface wraps these operations behind a browser UI, enforces audit logging, and gives the entire DBA and middleware team visibility into certificate expiry across every environment without SSH access.',
  category: 'soa-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-02'),
  youtubeUrl: null,
  content: `## Introduction

Oracle SOA Suite's integrated gateway exposes composite services over HTTPS. Certificate management for these endpoints — renewals, CA trust chain updates, keystore rotations — has traditionally required direct server access and manual keytool commands. The typical workflow involves SSH access to the WebLogic administration server, keytool invocations against JKS or PKCS12 files, a managed server restart, and manual verification. Each step is manual, undocumented unless the operator remembers to write it down, and error-prone. A wrong alias, wrong keystore path, or wrong password means the server does not start.

A Node.js web interface wraps these operations behind a browser UI, enforces audit logging, and gives the whole DBA/middleware team visibility into certificate expiry across every environment without SSH access. This post covers the architecture, the core implementation, security considerations, and deployment approach for such a tool.

---

## The Certificate Management Problem in SOA Environments

### Where Certificates Live

Oracle SOA Suite uses WebLogic Server as its application server runtime. WebLogic holds certificates in two types of stores:

**Identity keystores (JKS or PKCS12)** contain the private key and certificate chain that identify the SOA server to clients. When a client connects to the SOA gateway over HTTPS, the server presents the certificate from its identity keystore. The store is configured in the WebLogic Administration Console under **Environment → Servers → SSL** and referenced by the \`CustomIdentityKeyStoreFileName\` server parameter.

**Trust stores** hold CA certificates. When the SOA composite calls a backend HTTPS service, WebLogic validates the backend's certificate against its trust store. If the backend's issuing CA is not in the trust store, the SSL handshake fails. Trust store configuration sits under \`CustomTrustKeyStoreFileName\`.

Both stores are JKS files (or PKCS12 files in newer WebLogic versions) stored on the filesystem of each WebLogic node. In a clustered SOA environment, each node typically carries its own copy.

### The Multi-Environment Problem

A production SOA deployment spans at minimum three environments: development, test, and production. Each environment has separate keystores, separate passwords, and separate certificate lifecycle timelines. Development certs are often self-signed with short validity periods. Test certs may be issued by an internal CA. Production certs come from a commercial CA and expire on a 1- or 2-year cycle. Tracking these across environments without tooling is an exercise in spreadsheet management that eventually fails when someone misses a renewal.

### The Impact of Certificate Expiry

Certificate expiry in SOA environments causes hard failures, not graceful degradation. When the identity certificate expires:
- Clients connecting to the SOA gateway receive an SSL handshake error. There is no fallback, no retry mechanism, and no informative error message from the composite — the connection is rejected at the SSL layer before any SOA processing occurs.
- The standard Oracle ADF or JDeveloper client will log an opaque \`javax.net.ssl.SSLHandshakeException\` or \`sun.security.validator.ValidatorException\`, not a meaningful message about which certificate expired.
- In production, this surfaces as a complete outage for all composite services hosted on the gateway.

When a CA certificate in the trust store expires:
- All outbound calls from SOA composites to backend HTTPS services that were signed by that CA begin to fail.
- The failure manifests as \`SSL HANDSHAKE_FAILURE\` faults in the composite's BPEL or mediator instance logs.
- Since the CA cert expiry is often invisible on monitoring dashboards, teams can spend hours diagnosing what appears to be a network connectivity issue.

### The Manual Process and Its Risks

The manual certificate rotation process for a WebLogic-hosted SOA environment:
1. SSH to the administration server (or each managed server node if keystores are node-local)
2. Back up the existing keystore: \`cp identity.jks identity.jks.bak.\$(date +%Y%m%d)\`
3. Import the new certificate: \`keytool -importkeystore -srckeystore new.p12 -srcstoretype PKCS12 ...\`
4. Verify the import: \`keytool -list -v -keystore identity.jks ...\`
5. Restart the managed server through the WebLogic Admin Console or via WLST
6. Verify the SSL endpoint responds with the new certificate: \`openssl s_client -connect host:port\`

Each step has failure modes. The wrong alias during import means the old certificate remains active. The wrong keystore path means the import goes to a different file that WebLogic never reads. The wrong store password causes the server to fail on startup with a cryptic keystore exception in the server log. In a multi-node cluster, repeating this process on each node while keeping the cluster available (rolling restart) requires sequencing the restarts carefully — restarting all nodes simultaneously causes a service outage.

---

## Architecture of the Node.js Interface

The Node.js interface wraps the above manual process behind a web application with three layers.

### Backend Layers

**Express.js REST API layer** — HTTP routes that accept requests from the browser, validate input, call the service layer, log to the audit database, and return JSON responses. Routes are organized by resource: \`/api/certs\` for certificate operations, \`/api/servers\` for WebLogic server lifecycle management, \`/api/audit\` for audit log retrieval.

**\`certManager.js\` service layer** — Pure functions that construct and execute \`keytool\` commands via Node.js \`child_process.execSync\`. This layer knows about JKS operations but knows nothing about HTTP. It accepts paths, passwords, and aliases as parameters and returns structured objects or throws descriptive errors. The separation from the route layer makes the keytool logic independently testable.

**WebLogic REST API client (\`weblogicClient.js\`)** — Functions that call the WebLogic REST Management API (available in WebLogic 12.2.1+) to query server status and initiate server lifecycle operations. The WebLogic Management REST API is documented under the \`/management/weblogic/latest/\` path prefix on the admin server's HTTPS port.

### Frontend

The frontend is static HTML and vanilla JavaScript, served from the Express \`/public\` directory. No build step. This is intentional: the tool is infrastructure tooling, not a customer-facing application. Keeping the frontend dependency-free means it can be maintained by any team member regardless of familiarity with React/Vue/Webpack.

### Audit Database

SQLite via the \`better-sqlite3\` npm package. Every write operation — import, delete, restart — inserts a row into the \`audit_log\` table with timestamp, operator identity (from session), environment, action type, alias affected, and result (success or error message). SQLite is appropriate here: the tool runs on a single admin server, the audit log volume is low (tens of entries per day at most), and co-locating the audit store with the application removes an external dependency.

### Environment Configuration

Each target environment (dev/test/prod) is defined in \`environments.json\` with:
- \`host\` — the SOA server hostname
- \`keystorePath\` — absolute path to the identity JKS on that host (must be accessible from the tool server via NFS or SSH mount)
- \`truststorePath\` — absolute path to the trust JKS
- \`keystorePassword\` — store password (see security section for how to handle this safely)
- \`weblogicAdminUrl\` — HTTPS URL for the WebLogic admin server
- \`weblogicUser\` / \`weblogicPassword\` — credentials for the management API
- \`managedServers\` — array of managed server names in that domain

---

## Core Features

### 1. Certificate Dashboard

The main page renders a table of every alias in every keystore across every environment. Each row shows:
- Environment name
- Alias
- Subject DN
- Issuer
- Expiry date
- Days until expiry — color-coded: red for < 30 days, orange/yellow for < 90 days, green for > 90 days

The dashboard auto-refreshes every 60 seconds. A DBA opening the tool immediately sees the full certificate posture of all environments at a glance. Red rows require immediate attention; orange rows go into the sprint planning backlog.

### 2. Certificate Detail

Clicking an alias opens a detail panel showing the full certificate chain, Subject Alternative Names (SANs), key algorithm and size, SHA-256 fingerprint, and serial number. This is equivalent to running \`keytool -list -v ... -alias <alias>\` and parsing the output, but rendered in the browser with no SSH session required.

### 3. Upload and Import (Identity Certificate Rotation)

The upload form accepts a PKCS12 or PEM file. The backend stores the upload temporarily (in a \`chmod 700\` uploads directory), invokes keytool to import it into the target JKS under the specified alias, audits the operation, and returns the result. The operator specifies the alias, source password, and target environment in the form.

### 4. CA Trust Import

Separate from identity certificate rotation, the trust import feature accepts a PEM-encoded CA certificate and imports it into the trust JKS for the specified environment. This is the operation needed when a backend service rotates its issuing CA.

### 5. Expiry Monitoring (Background Cron)

A \`node-cron\` job runs every hour, reads the certificate details for every alias in every environment, and checks the expiry date. If any certificate expires within 30 days, the cron job:
- Writes an alert entry to the application log file (pickable by Nagios/Zabbix file monitoring)
- Optionally sends a POST to a configured webhook URL (Teams or Slack incoming webhook)

The webhook payload includes environment, alias, subject, and days remaining, formatted for Teams/Slack card rendering.

### 6. WebLogic Server Restart

After importing a new certificate, the identity keystore changes are not active until the managed server restarts (WebLogic reads the keystore at startup). The tool includes a restart button that calls the WebLogic REST Management API: graceful shutdown, wait, then start. The restart is sequenced for clustered environments — one server at a time with a health check between each — to avoid a simultaneous outage.

### 7. Audit Log

Every write operation is logged to the SQLite \`audit_log\` table. The \`/api/audit\` route returns the last 100 entries rendered in a table on the Audit page. Each entry records: timestamp, session user (from the Express session), environment, action (\`import\`, \`delete\`, \`import-ca\`, \`restart\`), alias affected, and result (\`success\` or the error message).

---

## Implementation Walk-through with Code Examples

### \`certManager.js\` — Reading Certificate Details

The core service reads certificate details by wrapping \`keytool -list -v\`:

\`\`\`javascript
const { execSync } = require('child_process');

function getCertDetails(keystorePath, keystorePassword, alias) {
  const cmd = [
    'keytool -list -v',
    \`-keystore "\${keystorePath}"\`,
    \`-storepass "\${keystorePassword}"\`,
    \`-alias "\${alias}"\`,
    '-rfc'
  ].join(' ');

  const output = execSync(cmd, { encoding: 'utf8' });
  return parseCertOutput(output);
}

function parseCertOutput(raw) {
  const lines = raw.split('\\n');
  const result = { alias: '', expiry: null, subject: '', issuer: '', serialNumber: '' };
  for (const line of lines) {
    if (line.startsWith('Alias name:')) result.alias = line.split(':')[1].trim();
    if (line.startsWith('Valid until:')) result.expiry = new Date(line.split(':').slice(1).join(':').trim());
    if (line.startsWith('Owner:')) result.subject = line.split(':').slice(1).join(':').trim();
    if (line.startsWith('Issuer:')) result.issuer = line.split(':').slice(1).join(':').trim();
  }
  return result;
}
\`\`\`

The \`parseCertOutput\` function handles the human-readable keytool output format. Note that the \`Valid until\` field from keytool is locale-dependent on older JDKs — in Java 8 it follows the JVM locale's date format, while Java 11+ standardizes it. In practice, parsing with \`new Date()\` works for English locale JVMs; for non-English locales, use \`keytool -printcert\` with the \`-J-Duser.language=en\` flag.

### Listing All Aliases in a Keystore

\`\`\`javascript
function listAliases(keystorePath, keystorePassword) {
  const cmd = \`keytool -list -keystore "\${keystorePath}" -storepass "\${keystorePassword}"\`;
  const output = execSync(cmd, { encoding: 'utf8' });
  const aliasRegex = /^(\\S+),\\s+/gm;
  const aliases = [];
  let match;
  while ((match = aliasRegex.exec(output)) !== null) {
    aliases.push(match[1]);
  }
  return aliases;
}
\`\`\`

The alias listing uses a regex against the brief (non-verbose) keytool output, where each alias appears at the start of a line followed by a comma and the creation date. This avoids parsing the verbose format for the listing operation.

### Importing a PKCS12 Certificate into JKS

\`\`\`javascript
function importPkcs12ToJks(p12Path, p12Password, jksPath, jksPassword, alias) {
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
  execSync(cmd, { encoding: 'utf8' });
}
\`\`\`

The \`-noprompt\` flag suppresses the interactive confirmation that keytool normally shows when overwriting an existing alias. Without it, \`execSync\` hangs waiting for stdin input that never comes.

### WebLogic REST API — Restart Managed Server

\`\`\`javascript
const axios = require('axios');

async function restartManagedServer(adminUrl, user, password, serverName) {
  const base = \`\${adminUrl}/management/weblogic/latest/domainRuntime/serverLifeCycleRuntimes/\${serverName}\`;

  // Graceful shutdown
  await axios.post(\`\${base}/forceShutdown\`, {}, {
    auth: { username: user, password },
    httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
  });

  // Wait for shutdown
  await new Promise(r => setTimeout(r, 10000));

  // Start
  await axios.post(\`\${base}/start\`, {}, {
    auth: { username: user, password },
    httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
  });
}
\`\`\`

The \`rejectUnauthorized: false\` setting is required when the WebLogic admin server itself uses a self-signed certificate — common in dev and test environments. In production, supply the admin server's CA certificate to the \`httpsAgent\` instead. The 10-second wait between shutdown and start is a conservative buffer; in practice WebLogic managed servers take 15–60 seconds to fully shut down, so the caller should poll the server status endpoint rather than using a fixed wait.

### Express Route — Certificate Dashboard Data

\`\`\`javascript
app.get('/api/certs', async (req, res) => {
  const results = [];
  for (const [envName, env] of Object.entries(environments)) {
    try {
      const aliases = listAliases(env.keystorePath, env.keystorePassword);
      for (const alias of aliases) {
        const detail = getCertDetails(env.keystorePath, env.keystorePassword, alias);
        const daysLeft = Math.floor((detail.expiry - Date.now()) / 86400000);
        results.push({ env: envName, alias, daysLeft, subject: detail.subject, expiry: detail.expiry });
      }
    } catch (err) {
      results.push({ env: envName, alias: 'ERROR', daysLeft: -1, error: err.message });
    }
  }
  results.sort((a, b) => a.daysLeft - b.daysLeft);
  res.json(results);
});
\`\`\`

The route iterates every environment, lists every alias, fetches the full detail for each alias, and computes days remaining. Errors at the environment level are caught and surfaced as an \`ERROR\` row rather than crashing the entire dashboard response. The sort puts the most critical (soonest expiring) certificates at the top of the table.

### Audit Logging

\`\`\`javascript
function auditLog(env, action, alias, user, result) {
  const entry = {
    timestamp: new Date().toISOString(),
    user: user ?? 'unknown',
    environment: env,
    action,
    alias,
    result
  };
  db.prepare('INSERT INTO audit_log (timestamp, user, environment, action, alias, result) VALUES (?, ?, ?, ?, ?, ?)').run(
    entry.timestamp, entry.user, entry.environment, entry.action, entry.alias, entry.result
  );
}
\`\`\`

The audit log uses \`better-sqlite3\`'s synchronous API, which is appropriate here — audit writes are infrequent and the synchronous call ensures the audit entry is committed before the HTTP response is sent. An asynchronous write could be lost if the process crashes between the operation completing and the audit write.

### Frontend Dashboard (Vanilla JavaScript)

\`\`\`javascript
async function loadDashboard() {
  const res = await fetch('/api/certs');
  const certs = await res.json();
  const tbody = document.getElementById('cert-table-body');
  tbody.innerHTML = '';
  for (const cert of certs) {
    const color = cert.daysLeft < 30 ? 'red' : cert.daysLeft < 90 ? 'orange' : 'green';
    const row = \`<tr>
      <td>\${cert.env}</td>
      <td>\${cert.alias}</td>
      <td>\${cert.subject}</td>
      <td style="color:\${color}; font-weight:bold">\${cert.daysLeft} days</td>
      <td>\${new Date(cert.expiry).toLocaleDateString()}</td>
    </tr>\`;
    tbody.insertAdjacentHTML('beforeend', row);
  }
}
\`\`\`

The frontend uses \`insertAdjacentHTML\` rather than building the entire \`innerHTML\` at once, which avoids losing event listeners on other table elements during refresh. The color coding gives the DBA an immediate visual triage of the certificate estate.

---

## Security Considerations

### Keystore Password Storage

Never store keystore passwords in environment variables that appear in application logs. Node.js logs the full environment on startup with some frameworks, and log aggregation tools may capture environment variables. The recommended approach:

- Store passwords in a secrets file at a path like \`/opt/soa-cert-manager/.secrets/env-passwords.json\` with permissions \`0600\`, owned by the tool's dedicated OS user.
- Read the secrets file at startup and hold the values in memory only.
- Do not log the secrets object or any field derived from it.
- For organizations with a secrets vault (HashiCorp Vault, CyberArk, AWS Secrets Manager), fetch the passwords via the vault API at startup instead.

### Filesystem Permissions

The Node.js process should run as a dedicated OS user — call it \`soaCertMgr\` — not as \`oracle\`, \`weblogic\`, or \`root\`. This user should have:
- Read access to the keystore files (via group membership in the group that owns the JKS files)
- Write access to the keystores only if the tool is handling imports (alternatively, import to a staging path and use a privileged wrapper script)
- No access to WebLogic domain home directories beyond the keystore paths

### HTTPS for the Tool Itself

The Node.js web interface should be served over HTTPS even though it is an internal tool. Keystore passwords transit the wire when the operator submits an import form. A self-signed certificate is acceptable for an internal tool; use a cert signed by the organization's internal CA if available. Nginx terminates TLS in front of the Node.js process (see deployment section).

### Authentication

Options in increasing order of rigor:
1. **Simple shared password** — Basic Auth via Express middleware with a single shared credential. Acceptable for a small team; the audit log provides operator accountability if everyone uses the same credential (not recommended for that reason).
2. **Session-based auth with individual accounts** — \`express-session\` with a local user table in the SQLite database. Each operator has their own login; session identity populates the audit log's \`user\` field.
3. **LDAP integration** — \`passport-ldapauth\` binds against Active Directory or LDAP. Operators log in with their corporate credentials; the tool respects AD group membership for access control (read-only vs. write).

### Upload Rate Limiting

The \`/api/certs/:env/upload\` endpoint accepts file uploads. Apply \`express-rate-limit\` to this route with a restrictive limit (e.g., 10 requests per 10 minutes per IP). This prevents the upload endpoint from being used as a denial-of-service vector against the keystore.

### Audit Log Integrity

The audit log is the paper trail for certificate management operations. Protect it:
- Use an append-only SQLite approach: grant the application user INSERT but not UPDATE or DELETE on the \`audit_log\` table. SQLite does not have row-level permissions natively, so enforce this at the application layer — never expose a delete route for audit entries.
- Ship the audit log to syslog or a central log aggregator (Splunk, ELK) so a local attacker cannot silently modify the on-disk SQLite file.

---

## Monitoring Integration

The background cron job uses \`node-cron\`:

\`\`\`javascript
const cron = require('node-cron');

cron.schedule('0 * * * *', async () => {
  const certs = await getAllCertDetails();
  for (const cert of certs) {
    if (cert.daysLeft < 30) {
      logger.warn(\`CERT_EXPIRY_ALERT: \${cert.env}/\${cert.alias} expires in \${cert.daysLeft} days\`);
      if (process.env.WEBHOOK_URL) {
        await sendWebhookAlert(cert);
      }
    }
  }
});
\`\`\`

The \`0 * * * *\` cron expression runs at minute 0 of every hour. The logger writes to \`/opt/soa-cert-manager/logs/app.log\`. A Nagios/Zabbix plugin can scan this file for the \`CERT_EXPIRY_ALERT\` string and raise an alert in the monitoring system. The webhook alert sends a Teams/Slack payload with the environment, alias, subject, and days remaining.

---

## Production Deployment

### systemd Service

Run the tool as a systemd service with the dedicated \`soaCertMgr\` user:

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

[Install]
WantedBy=multi-user.target
\`\`\`

Enable and start: \`systemctl enable soa-cert-manager && systemctl start soa-cert-manager\`.

### Nginx Reverse Proxy

Nginx terminates TLS and proxies to the Node.js process:

\`\`\`nginx
server {
    listen 443 ssl;
    server_name soa-cert-mgr.example.com;
    ssl_certificate     /etc/ssl/certs/cert-manager.crt;
    ssl_certificate_key /etc/ssl/private/cert-manager.key;

    location / {
        proxy_pass http://127.0.0.1:3443;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }
}
\`\`\`

### Filesystem Layout

Place the SQLite audit database on a separate filesystem from the application code, so a disk-full condition on the application partition does not corrupt the audit database. Example:

- \`/opt/soa-cert-manager/\` — application code (small, a few MB)
- \`/data/soa-cert-manager/audit.db\` — audit database (grows slowly; a few MB per year for normal usage)
- \`/data/soa-cert-manager/uploads/\` — temporary upload staging (purge after each successful import)

---

## Summary

A Node.js web interface for SOA gateway certificate management shifts what was a risky SSH/keytool exercise into a controlled, auditable web operation that any member of the DBA or middleware team can execute safely. The key architectural decisions — wrapping \`keytool\` via \`child_process\`, storing audit in SQLite, using the WebLogic REST Management API for server restarts, and keeping the frontend dependency-free — produce a tool that is straightforward to deploy, maintain, and hand off to a new team member.

The security properties that matter most are: dedicated OS user with minimal filesystem permissions, keystore passwords in a 0600 secrets file rather than environment variables, HTTPS for the tool itself, individual operator accounts so the audit log captures who did what, and audit log shipping to a central system so on-disk tampering is detectable.

Certificate expiry in a SOA environment causes hard outages. A tool that gives the entire team daily visibility into expiry timelines across all environments, and lets any authorized operator perform the rotation through a browser rather than an SSH session, eliminates both the surprise of unnoticed expiry and the risk of a manual error during the rotation itself.`,
};

async function main() {
  console.log('Inserting SOA cert management blog post...');
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
