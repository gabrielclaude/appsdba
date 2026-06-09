import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Installing TLS 1.2 Certificates on PostgreSQL (Linux)',
  slug: 'postgresql-tls-1-2-ssl-runbook',
  excerpt:
    'Step-by-step runbook for enabling TLS 1.2 on a PostgreSQL instance on Linux — self-signed CA generation, server certificate issuance, postgresql.conf SSL parameters, pg_hba.conf hostssl enforcement, file permission hardening, openssl s_client verification, optional client certificate (mTLS) setup, and a certificate expiry monitoring script.',
  category: 'postgresql' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-09'),
  youtubeUrl: null,
  content: `## Purpose and Scope

This runbook enables TLS 1.2 encryption on a PostgreSQL instance running on Linux. It covers three certificate paths:

- **Path A** — Self-signed CA and server certificate (development, internal use)
- **Path B** — Enterprise or public CA-signed server certificate (production)
- **Path C** — Mutual TLS (mTLS) with client certificates (high-security environments)

**Reference post:** [Securing PostgreSQL with TLS 1.2: Certificates and Encrypted Connections](/posts/postgresql-tls-1-2-ssl-configuration)

**Applies to:** PostgreSQL 14–17, RHEL/OEL 8/9 and Ubuntu 22.04/24.04.

---

## Prerequisites

| Item | Requirement |
|------|-------------|
| PostgreSQL | Running instance with OS-level access |
| OS user | \`root\` or \`sudo\` for file operations; \`postgres\` for psql |
| OpenSSL | Version 1.1.1+ (confirm with \`openssl version\`) |
| PGDATA | Know the data directory path (\`SHOW data_directory;\` in psql) |
| Downtime | A service restart is required when enabling SSL for the first time |

\`\`\`bash
# Record PGDATA before starting
sudo -u postgres psql -c "SHOW data_directory;"
export PGDATA=$(sudo -u postgres psql -t -A -c "SHOW data_directory;")
echo "PGDATA: \$PGDATA"
\`\`\`

---

## Phase 0 — Pre-Flight Checks

### 0.1 Check current SSL status

\`\`\`bash
sudo -u postgres psql -c "SHOW ssl;"
# Expected if not yet enabled: off
\`\`\`

### 0.2 Confirm OpenSSL version supports TLS 1.2

\`\`\`bash
openssl version
# Must be >= 1.1.1 for TLS 1.3 support; >= 1.0.1 for TLS 1.2
openssl ciphers -v 'HIGH:MEDIUM:!aNULL' | grep -c "TLSv1.2"
\`\`\`

### 0.3 Check if PostgreSQL was compiled with SSL support

\`\`\`bash
sudo -u postgres psql -c "SHOW ssl_cert_file;"
# If this returns an error "unrecognized configuration parameter", PostgreSQL was built without SSL
# In that case, reinstall from the PGDG repository which always includes SSL
\`\`\`

---

## Path A — Self-Signed CA and Server Certificate

Use this path for development environments, internal services, or as a starting point before transitioning to an enterprise CA.

### A.1 Create a working directory for certificate generation

\`\`\`bash
mkdir -p /etc/postgresql/ssl
chmod 750 /etc/postgresql/ssl
cd /etc/postgresql/ssl
\`\`\`

### A.2 Generate the CA private key and self-signed root certificate

\`\`\`bash
# Generate CA private key (4096-bit RSA)
openssl genrsa -out root.key 4096
chmod 400 root.key

# Generate the CA self-signed certificate (valid 10 years)
openssl req -new -x509 \
    -key root.key \
    -out root.crt \
    -days 3650 \
    -subj "/CN=PostgreSQL Internal CA/O=YourOrg/C=US"

# Verify the CA certificate
openssl x509 -noout -text -in root.crt | grep -E "Subject:|Issuer:|Not Before:|Not After:"
\`\`\`

### A.3 Generate the server private key and CSR

\`\`\`bash
# Replace 'db.example.com' with the actual FQDN or IP address clients will use to connect
SERVER_FQDN="db.example.com"

# Generate server private key (2048-bit RSA minimum; 4096 recommended for new deployments)
openssl genrsa -out server.key 2048
chmod 400 server.key

# Generate Certificate Signing Request
openssl req -new \
    -key server.key \
    -out server.csr \
    -subj "/CN=\${SERVER_FQDN}/O=YourOrg/C=US"
\`\`\`

### A.4 Create an extensions file for Subject Alternative Names

SAN (Subject Alternative Name) is required for \`sslmode=verify-full\` to work correctly. Modern clients reject certificates that only use CN for hostname verification.

\`\`\`bash
cat > server.ext <<EOF
[req_ext]
subjectAltName = @alt_names

[alt_names]
DNS.1 = \${SERVER_FQDN}
DNS.2 = localhost
IP.1  = 127.0.0.1
EOF
# Add additional IPs or DNS names if needed (e.g., load balancer VIPs, secondary hostnames)
\`\`\`

### A.5 Sign the server certificate with the CA

\`\`\`bash
openssl x509 -req \
    -in server.csr \
    -CA root.crt \
    -CAkey root.key \
    -CAcreateserial \
    -out server.crt \
    -days 825 \
    -extensions req_ext \
    -extfile server.ext

# Verify the signed certificate
openssl x509 -noout -text -in server.crt | grep -E "Subject:|Issuer:|Not Before:|Not After:|DNS:|IP:"
\`\`\`

**Why 825 days?** Apple's App Transport Security and several enterprise PKI policies cap certificate validity at 825 days. Using a shorter validity than the CA (10 years) with regular renewal is a security best practice.

### A.6 Copy certificates to PGDATA and set permissions

PostgreSQL requires specific ownership and permissions on the key file:

\`\`\`bash
cp server.crt server.key root.crt \$PGDATA/

# The key must be owned by postgres and NOT readable by group or world
chown postgres:postgres \$PGDATA/server.key \$PGDATA/server.crt \$PGDATA/root.crt
chmod 600 \$PGDATA/server.key
chmod 644 \$PGDATA/server.crt \$PGDATA/root.crt

# Verify
ls -la \$PGDATA/server.key \$PGDATA/server.crt \$PGDATA/root.crt
\`\`\`

**Permission errors cause PostgreSQL to refuse to start.** If \`server.key\` is group or world readable, PostgreSQL rejects it with:
\`\`\`
FATAL: private key file "server.key" has group or world access
\`\`\`

---

## Path B — Enterprise or Public CA-Signed Certificate

Use this path for production environments with an internal PKI or a public CA.

### B.1 Generate the server private key and CSR

\`\`\`bash
SERVER_FQDN="db.example.com"
mkdir -p /etc/postgresql/ssl && cd /etc/postgresql/ssl

openssl genrsa -out server.key 2048
chmod 400 server.key

openssl req -new \
    -key server.key \
    -out server.csr \
    -subj "/CN=\${SERVER_FQDN}/O=YourOrg/OU=Database/C=US" \
    -addext "subjectAltName=DNS:\${SERVER_FQDN},IP:10.0.1.20"

# Inspect the CSR before submitting
openssl req -noout -text -in server.csr
\`\`\`

### B.2 Submit the CSR to your CA

Submit \`server.csr\` to your enterprise PKI portal or public CA. Specify:
- **Key usage:** Digital Signature, Key Encipherment
- **Extended key usage:** Server Authentication (OID 1.3.6.1.5.5.7.3.1)
- **SAN:** DNS name matching the FQDN clients will use

Receive back: \`server.crt\` (your signed certificate) and optionally an intermediate CA bundle.

### B.3 Build the certificate chain file

If your CA provided an intermediate certificate:

\`\`\`bash
# Concatenate server cert + intermediate chain (order matters: server first, then intermediates)
cat server.crt intermediate.crt > server_chain.crt
cp server_chain.crt \$PGDATA/server.crt

# The CA root goes in root.crt — clients need this to verify
cp ca_root.crt \$PGDATA/root.crt
\`\`\`

### B.4 Copy key and set permissions

\`\`\`bash
cp server.key \$PGDATA/
chown postgres:postgres \$PGDATA/server.key \$PGDATA/server.crt \$PGDATA/root.crt
chmod 600 \$PGDATA/server.key
chmod 644 \$PGDATA/server.crt \$PGDATA/root.crt
\`\`\`

---

## Phase 1 — Configure postgresql.conf

\`\`\`bash
vi \$PGDATA/postgresql.conf
\`\`\`

Add or update the following block:

\`\`\`ini
# --- SSL / TLS Configuration ---

ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file  = 'server.key'
ssl_ca_file   = 'root.crt'

# Minimum TLS protocol version — rejects TLS 1.0 and TLS 1.1 clients
ssl_min_protocol_version = 'TLSv1.2'

# Prefer server cipher order (prevents clients from negotiating weaker ciphers)
ssl_prefer_server_ciphers = on

# Hardened cipher suite — AES-GCM with ECDHE key exchange, SHA-2 MAC
ssl_ciphers = 'ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!3DES:!MD5:!PSK'

# Elliptic curve for ECDH
ssl_ecdh_curve = 'prime256v1'
\`\`\`

---

## Phase 2 — Configure pg_hba.conf

\`\`\`bash
vi \$PGDATA/pg_hba.conf
\`\`\`

Replace or update the network connection entries:

\`\`\`
# TYPE      DATABASE   USER          ADDRESS             METHOD

# Local Unix socket connections — no SSL on socket, use peer auth for postgres
local       all        postgres                          peer
local       all        all                               md5

# Loopback — allow SSL and non-SSL for local admin tools
host        all        all           127.0.0.1/32        scram-sha-256
host        all        all           ::1/128             scram-sha-256

# Application network — REQUIRE SSL
hostssl     all        all           10.0.1.0/24         scram-sha-256

# Replication — require SSL
hostssl     replication  replication 10.0.1.0/24         scram-sha-256

# Catch-all: block any non-SSL connection from outside loopback
hostnossl   all        all           0.0.0.0/0           reject
\`\`\`

---

## Phase 3 — Restart PostgreSQL

A full restart is required when enabling SSL for the first time (\`ssl = on\` is not a reload-only parameter):

\`\`\`bash
# RHEL / OEL
systemctl restart postgresql-17
systemctl status  postgresql-17

# Ubuntu
systemctl restart postgresql@17-main
systemctl status  postgresql@17-main
\`\`\`

Check the PostgreSQL log for SSL startup confirmation:

\`\`\`bash
# RHEL
journalctl -u postgresql-17 --since "5 minutes ago" | grep -i ssl

# Ubuntu
grep -i ssl /var/log/postgresql/postgresql-17-main.log | tail -5
\`\`\`

Expected log line:
\`\`\`
LOG:  SSL enabled, version: TLSv1.3, cipher: TLS_AES_256_GCM_SHA384, bits: 256
\`\`\`

---

## Phase 4 — Verify TLS from the Command Line

### 4.1 OpenSSL s_client handshake test

\`\`\`bash
# Test from the application server (not the DB server itself)
# Replace 5432 and hostname with your values
openssl s_client -connect db.example.com:5432 -starttls postgres \
    -CAfile /etc/ssl/certs/pg-root.crt \
    -showcerts 2>&1 | grep -E "Protocol|Cipher|Server certificate|subject|issuer|Verify return"
\`\`\`

Expected output:
\`\`\`
Server certificate
subject=CN = db.example.com, O = YourOrg, C = US
issuer=CN = PostgreSQL Internal CA, O = YourOrg, C = US
Protocol  : TLSv1.3     ← or TLSv1.2
Cipher    : TLS_AES_256_GCM_SHA384
Verify return code: 0 (ok)
\`\`\`

\`Verify return code: 0 (ok)\` confirms the certificate chain validates correctly. Any non-zero code indicates a certificate trust problem.

### 4.2 Confirm TLS 1.0 and 1.1 are rejected

\`\`\`bash
# These must FAIL — if they succeed, ssl_min_protocol_version is not enforced
openssl s_client -connect db.example.com:5432 -starttls postgres -tls1
# Expected: handshake failure

openssl s_client -connect db.example.com:5432 -starttls postgres -tls1_1
# Expected: handshake failure
\`\`\`

### 4.3 Confirm TLS 1.2 succeeds

\`\`\`bash
openssl s_client -connect db.example.com:5432 -starttls postgres -tls1_2 \
    -CAfile /etc/ssl/certs/pg-root.crt 2>&1 | grep -E "Protocol|Verify"
# Expected: Protocol: TLSv1.2, Verify return code: 0 (ok)
\`\`\`

---

## Phase 5 — Verify from psql

### 5.1 Connect with SSL required

\`\`\`bash
psql "host=db.example.com port=5432 dbname=appdb user=appuser \
      sslmode=verify-full sslrootcert=/etc/ssl/certs/pg-root.crt"
\`\`\`

### 5.2 Check SSL details for the current connection

\`\`\`sql
SELECT ssl, version, cipher, bits, client_dn
FROM   pg_stat_ssl
WHERE  pid = pg_backend_pid();
\`\`\`

| ssl | version | cipher | bits |
|-----|---------|--------|------|
| t | TLSv1.3 | TLS_AES_256_GCM_SHA384 | 256 |

### 5.3 Check SSL status across all active connections

\`\`\`sql
SELECT a.pid,
       a.usename,
       a.client_addr,
       s.ssl,
       s.version,
       s.cipher,
       s.client_dn
FROM   pg_stat_activity a
JOIN   pg_stat_ssl      s ON a.pid = s.pid
WHERE  a.backend_type = 'client backend'
ORDER BY a.pid;
\`\`\`

Any row with \`ssl = false\` is a plaintext connection. If \`hostnossl reject\` is configured, only loopback connections should show \`ssl = false\`.

---

## Path C — Mutual TLS (Client Certificate Authentication)

Use this path for high-security environments (DBA access, CI/CD pipelines, internal service accounts).

### C.1 Generate a client certificate signed by the CA

\`\`\`bash
CLIENT_CN="appuser"   # Must match the PostgreSQL role name exactly

openssl genrsa -out \${CLIENT_CN}.key 2048
chmod 400 \${CLIENT_CN}.key

openssl req -new \
    -key \${CLIENT_CN}.key \
    -out \${CLIENT_CN}.csr \
    -subj "/CN=\${CLIENT_CN}/O=YourOrg/C=US"

openssl x509 -req \
    -in \${CLIENT_CN}.csr \
    -CA root.crt \
    -CAkey root.key \
    -CAcreateserial \
    -out \${CLIENT_CN}.crt \
    -days 365

# Verify
openssl x509 -noout -subject -dates -in \${CLIENT_CN}.crt
\`\`\`

### C.2 Distribute the client certificate

Place these three files on the client machine:

| File | Location | Purpose |
|------|----------|---------|
| \`root.crt\` | \`~/.postgresql/root.crt\` | Verifies the server |
| \`appuser.crt\` | \`~/.postgresql/postgresql.crt\` | Client identity certificate |
| \`appuser.key\` | \`~/.postgresql/postgresql.key\` | Client private key (chmod 600) |

\`\`\`bash
mkdir -p ~/.postgresql
cp root.crt      ~/.postgresql/root.crt
cp appuser.crt   ~/.postgresql/postgresql.crt
cp appuser.key   ~/.postgresql/postgresql.key
chmod 600 ~/.postgresql/postgresql.key
\`\`\`

### C.3 Update pg_hba.conf to require client certificate

\`\`\`
# Require client certificate — CN of the cert must match the PostgreSQL role name
hostssl     appdb      appuser       10.0.1.0/24         cert
\`\`\`

Reload pg_hba.conf:
\`\`\`bash
sudo -u postgres psql -c "SELECT pg_reload_conf();"
\`\`\`

### C.4 Test the mTLS connection

\`\`\`bash
psql "host=db.example.com dbname=appdb user=appuser sslmode=verify-full \
      sslrootcert=\$HOME/.postgresql/root.crt \
      sslcert=\$HOME/.postgresql/postgresql.crt \
      sslkey=\$HOME/.postgresql/postgresql.key"
\`\`\`

---

## Phase 6 — Certificate Expiry Monitoring

Deploy this script to alert before any certificate expires.

\`\`\`bash
#!/bin/bash
# pg_cert_expiry_check.sh — alerts when PostgreSQL TLS certs approach expiry

PGDATA=$(sudo -u postgres psql -t -A -c "SHOW data_directory;" 2>/dev/null)
ALERT_DAYS=60
EMAIL="dba_team@yourcompany.com"
HOSTNAME_FQDN=$(hostname -f)
ALERTS=""

check_cert() {
    local LABEL="\$1"
    local CERT_FILE="\$2"

    if [ ! -f "\$CERT_FILE" ]; then
        ALERTS+="\$LABEL: file not found at \$CERT_FILE\n"
        return
    fi

    EXPIRY=$(openssl x509 -noout -enddate -in "\$CERT_FILE" 2>/dev/null \
             | sed 's/notAfter=//')
    EXPIRY_EPOCH=$(date -d "\$EXPIRY" +%s 2>/dev/null)
    NOW_EPOCH=$(date +%s)
    DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))

    if [ "\$DAYS_LEFT" -lt "\$ALERT_DAYS" ]; then
        ALERTS+="\$LABEL: expires in \${DAYS_LEFT} days (\${EXPIRY})\n"
    fi
}

check_cert "PostgreSQL Server Certificate" "\${PGDATA}/server.crt"
check_cert "PostgreSQL CA Certificate"     "\${PGDATA}/root.crt"

if [ -n "\$ALERTS" ]; then
    (
      echo "To: \${EMAIL}"
      echo "Subject: CERT EXPIRY WARNING — PostgreSQL TLS on \${HOSTNAME_FQDN}"
      echo "Content-Type: text/plain"
      echo ""
      echo "The following PostgreSQL TLS certificates on \${HOSTNAME_FQDN} are approaching expiry:"
      echo ""
      echo -e "\${ALERTS}"
      echo "Renew the certificates and restart PostgreSQL before they expire."
      echo "A reloaded server will pick up new certificates without a restart when using"
      echo "pg_ctl reload, but a key change requires a full restart."
    ) | /usr/sbin/sendmail -t
fi
\`\`\`

\`\`\`bash
chmod +x /home/postgres/scripts/pg_cert_expiry_check.sh

# Schedule weekly — every Monday at 07:00
crontab -e
# 0 7 * * 1 /home/postgres/scripts/pg_cert_expiry_check.sh > /dev/null 2>&1
\`\`\`

---

## Phase 7 — Certificate Renewal Procedure

When a certificate is within 60 days of expiry, renew it using the same procedure as issuance.

### 7.1 Generate a new certificate (do not reuse the old CSR)

Repeat the key generation and certificate signing steps from Path A or B. Always generate a new private key rather than reusing the old one.

### 7.2 Replace files in PGDATA

\`\`\`bash
# Back up the old certificate
cp \$PGDATA/server.crt \$PGDATA/server.crt.bak_\$(date +%Y%m%d)
cp \$PGDATA/server.key \$PGDATA/server.key.bak_\$(date +%Y%m%d)

# Install the new certificate
cp /etc/postgresql/ssl/server.crt \$PGDATA/server.crt
cp /etc/postgresql/ssl/server.key \$PGDATA/server.key
chown postgres:postgres \$PGDATA/server.crt \$PGDATA/server.key
chmod 600 \$PGDATA/server.key
chmod 644 \$PGDATA/server.crt
\`\`\`

### 7.3 Reload vs Restart

\`\`\`bash
# If only the certificate changed (not the key or ssl parameters):
sudo -u postgres psql -c "SELECT pg_reload_conf();"

# If the key also changed, a full restart is required:
systemctl restart postgresql-17
\`\`\`

### 7.4 Verify the new certificate is live

\`\`\`bash
openssl s_client -connect db.example.com:5432 -starttls postgres \
    -CAfile /etc/ssl/certs/pg-root.crt 2>&1 \
    | openssl x509 -noout -dates
\`\`\`

Confirm \`notAfter\` reflects the new expiry date.

---

## Post-Configuration Checklist

- [ ] \`SHOW ssl;\` returns \`on\`
- [ ] \`openssl s_client -tls1\` and \`-tls1_1\` both fail (TLS 1.0/1.1 rejected)
- [ ] \`openssl s_client -tls1_2\` succeeds with \`Verify return code: 0 (ok)\`
- [ ] \`pg_stat_ssl\` shows \`ssl = true\` and \`version = TLSv1.2\` or \`TLSv1.3\` for all app connections
- [ ] \`pg_hba.conf\` has \`hostnossl reject\` catch-all to block plaintext from external hosts
- [ ] \`server.key\` permissions are \`-rw-------\` (600), owned by \`postgres\`
- [ ] Certificate expiry monitoring script deployed and crontab entry confirmed
- [ ] CA root certificate (\`root.crt\`) distributed to all application servers trust stores
- [ ] Application connection strings updated to \`sslmode=verify-full\`
- [ ] Certificate renewal procedure documented with the renewal date noted`,
};

async function main() {
  console.log('Inserting PostgreSQL TLS 1.2 runbook...');
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
