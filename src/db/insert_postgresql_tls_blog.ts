import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Securing PostgreSQL with TLS 1.2: Certificates and Encrypted Connections',
  slug: 'postgresql-tls-1-2-ssl-configuration',
  excerpt:
    'A practical guide to enabling TLS 1.2 on PostgreSQL — covering the server certificate architecture, postgresql.conf SSL parameters, pg_hba.conf hostssl enforcement, minimum protocol version configuration, cipher suite hardening, and optional mutual TLS with client certificates.',
  category: 'postgresql' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-09'),
  youtubeUrl: null,
  content: `By default, PostgreSQL accepts client connections without encryption. Any data traversing the network — query results, credentials, transaction data — travels in plaintext. In a production environment, whether on-premises or in the cloud, that is not acceptable. PCI-DSS, HIPAA, SOC 2, and most enterprise security baselines require encryption in transit for database connections.

PostgreSQL has built-in SSL/TLS support that requires no third-party plugins. Enabling it is a configuration change, not an architectural one. This guide covers the SSL model, the key configuration parameters, and how to enforce TLS 1.2 as the minimum protocol version.

---

## The PostgreSQL SSL Architecture

PostgreSQL's SSL implementation follows the standard TLS model with three optional certificate layers:

**Server certificate** — the only mandatory component. The PostgreSQL server presents this certificate to every connecting client. The client verifies it against a trusted CA. This establishes server identity and encrypts the connection.

**Certificate Authority (CA) certificate** — if you are issuing certificates from your own CA (internal PKI or a simple self-signed CA), the CA certificate must be placed on both the server and any clients that need to verify the server certificate.

**Client certificate** — optional. When configured, the server demands a certificate from each client, and only clients presenting a valid certificate signed by the trusted CA can connect. This is mutual TLS (mTLS) — both sides authenticate each other.

\`\`\`
Client                          PostgreSQL Server
  │                                    │
  │──── TCP SYN ──────────────────────►│
  │                                    │
  │──── TLS ClientHello ──────────────►│
  │                                    │
  │◄─── TLS ServerHello + Certificate ─│  ← Server presents server.crt
  │                                    │
  │  [Client verifies server.crt       │
  │   against root.crt]                │
  │                                    │
  │──── [Optional: Client Certificate]►│  ← mTLS only
  │                                    │
  │◄═══ Encrypted TLS channel ════════►│
  │                                    │
  │──── SSL STARTUP packet ───────────►│
  │──── Authentication ───────────────►│
  │◄═══ Encrypted query/result stream ═│
\`\`\`

---

## Key postgresql.conf SSL Parameters

All SSL configuration lives in \`postgresql.conf\`. A restart is required when enabling SSL for the first time; subsequent certificate rotations only require a reload.

\`\`\`ini
# Enable SSL — requires a valid server certificate and key to be present
ssl = on

# Server certificate — PEM format, readable by the postgres OS user
ssl_cert_file = 'server.crt'      # relative to PGDATA, or absolute path

# Server private key — PEM format, owned by postgres, mode 0600
ssl_key_file = 'server.key'

# CA certificate — clients use this to verify the server certificate
# Also used to verify client certificates if ssl_ca_file is set
ssl_ca_file = 'root.crt'

# Certificate Revocation List — optional
ssl_crl_file = ''

# Minimum TLS protocol version — TLSv1.2 is the current baseline
# Options: TLSv1, TLSv1.1, TLSv1.2, TLSv1.3
ssl_min_protocol_version = 'TLSv1.2'

# Maximum TLS protocol version — leave unset to allow TLSv1.3
# ssl_max_protocol_version = ''

# Cipher suites — restricts the negotiated cipher to strong options
# This is an OpenSSL cipher string
ssl_ciphers = 'HIGH:MEDIUM:+3DES:!aNULL'

# Prefer server cipher order over client's preference
ssl_prefer_server_ciphers = on

# Elliptic curve for ECDH key exchange (leave as default unless you have specific requirements)
ssl_ecdh_curve = 'prime256v1'
\`\`\`

### Minimum Protocol Version

\`ssl_min_protocol_version = 'TLSv1.2'\` is the critical parameter for compliance. It instructs OpenSSL to reject any TLS negotiation attempt that proposes TLS 1.0 or TLS 1.1. Older client libraries that do not support TLS 1.2 will fail to connect — this is intentional.

To allow only TLS 1.3 (future-proof but may exclude some older clients):

\`\`\`ini
ssl_min_protocol_version = 'TLSv1.3'
\`\`\`

### Cipher Suite Hardening

The default cipher string allows most ciphers that OpenSSL considers HIGH or MEDIUM strength. For PCI-DSS environments, a more restrictive set:

\`\`\`ini
ssl_ciphers = 'ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!3DES:!MD5:!PSK'
\`\`\`

This restricts to ECDHE key exchange with AES-GCM (authenticated encryption) and explicitly excludes null, export, legacy, and MD5-based cipher suites.

---

## pg_hba.conf: Enforcing SSL per Connection Type

\`pg_hba.conf\` controls authentication. The \`hostssl\` connection type requires an SSL connection and rejects plaintext:

\`\`\`
# TYPE      DATABASE   USER          ADDRESS           METHOD

# Require SSL for all network connections from the application subnet
hostssl     all        all           10.0.1.0/24       scram-sha-256

# Allow non-SSL only from localhost (for local administrative tools)
host        all        all           127.0.0.1/32      scram-sha-256
host        all        all           ::1/128           scram-sha-256

# Explicitly block non-SSL connections from any other host
hostnossl   all        all           0.0.0.0/0         reject
\`\`\`

**Connection type reference:**

| Type | Behaviour |
|------|-----------|
| \`host\` | Accepts both SSL and non-SSL connections |
| \`hostssl\` | Requires SSL — rejects plaintext |
| \`hostnossl\` | Requires no SSL — rejects SSL connections |
| \`local\` | Unix domain socket — not subject to SSL (no network traffic) |

The combination of \`hostssl\` for network connections and \`hostnossl reject\` as a catch-all ensures no unencrypted path exists from outside the server.

### Requiring Client Certificates (mTLS)

To enforce client certificate authentication in addition to password:

\`\`\`
hostssl     all        appuser       10.0.1.0/24       cert
\`\`\`

The \`cert\` method authenticates using the client certificate's CN (Common Name) field — the CN must match the PostgreSQL role name. No password is required or accepted.

For environments that want both certificate verification and password authentication, use the \`scram-sha-256\` method on a \`hostssl\` line — SSL is required but authentication is still password-based.

---

## Certificate Options

### Self-Signed (Development and Internal Use)

The quickest path to encrypted connections. A self-signed certificate is its own CA — the server presents it and clients must trust it explicitly. No external CA involvement.

**Limitation:** browsers and most standard tools will warn about self-signed certificates unless the root certificate is explicitly installed in the client trust store.

### Internal CA (Enterprise Standard)

Generate a CA key pair once. All database server certificates and client certificates are signed by that CA. Clients trust the CA root, which automatically trusts all certificates it has signed. This is the recommended approach for production environments with multiple database servers.

### Public CA or Enterprise PKI (Compliance Environments)

For internet-facing databases or environments under strict certificate management policy, certificates are issued by the organisation's enterprise PKI or a public CA (DigiCert, Sectigo, etc.). The same configuration applies — only the certificate issuance process differs.

---

## How Clients Connect with SSL

### psql

\`\`\`bash
# Require SSL (connection fails if server does not support SSL)
psql "host=db.example.com dbname=appdb user=appuser sslmode=require"

# Verify server certificate against a specific CA file
psql "host=db.example.com dbname=appdb user=appuser sslmode=verify-ca sslrootcert=/etc/ssl/certs/pg-root.crt"

# Verify server certificate AND hostname matches CN/SAN in certificate
psql "host=db.example.com dbname=appdb user=appuser sslmode=verify-full sslrootcert=/etc/ssl/certs/pg-root.crt"
\`\`\`

**sslmode values (in increasing security order):**

| sslmode | Behaviour |
|---------|-----------|
| \`disable\` | Never use SSL |
| \`allow\` | Use SSL only if server requires it |
| \`prefer\` | Try SSL first, fall back to plaintext (default) |
| \`require\` | Always use SSL; do not verify certificate |
| \`verify-ca\` | Verify server certificate is signed by trusted CA |
| \`verify-full\` | Verify certificate and hostname match (recommended for production) |

Set \`sslmode=verify-full\` in production application connection strings. \`require\` encrypts the connection but does not prevent man-in-the-middle attacks — the certificate is not verified.

### JDBC (Java Applications)

\`\`\`
jdbc:postgresql://db.example.com:5432/appdb?ssl=true&sslmode=verify-full&sslrootcert=/etc/ssl/certs/pg-root.crt
\`\`\`

### Connection String Environment Variables

\`\`\`bash
export PGHOST=db.example.com
export PGDATABASE=appdb
export PGUSER=appuser
export PGSSLMODE=verify-full
export PGSSLROOTCERT=/etc/ssl/certs/pg-root.crt
psql
\`\`\`

---

## Verifying SSL is Active

Once configured, confirm the connection is using TLS from within psql:

\`\`\`sql
-- Shows SSL status for the current connection
SELECT ssl, version, cipher, bits, client_dn
FROM pg_stat_ssl
WHERE pid = pg_backend_pid();
\`\`\`

| Column | Meaning |
|--------|---------|
| \`ssl\` | \`true\` if the connection is encrypted |
| \`version\` | Negotiated TLS version (e.g., \`TLSv1.3\`) |
| \`cipher\` | Negotiated cipher suite |
| \`bits\` | Key strength |
| \`client_dn\` | Client certificate DN (populated if mTLS is used) |

To see SSL status for all current connections:

\`\`\`sql
SELECT a.pid, a.usename, a.application_name, a.client_addr,
       s.ssl, s.version, s.cipher
FROM   pg_stat_activity a
JOIN   pg_stat_ssl      s ON a.pid = s.pid
WHERE  a.state != 'idle';
\`\`\`

The companion runbook covers the complete certificate generation, configuration, and validation procedure.`,
};

async function main() {
  console.log('Inserting PostgreSQL TLS 1.2 blog post...');
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
