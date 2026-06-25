import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Internal CA and OEM 13c Certificate Replacement: Step-by-Step Runbook for RHEL 9',
  slug: 'internal-ca-oem13c-certificate-runbook',
  excerpt:
    'Complete runbook for building an internal two-tier OpenSSL CA on RHEL 9, generating a signed server certificate for Oracle Enterprise Manager 13c, importing the certificate via emctl, distributing CA trust to managed hosts and agents, and validating end-to-end TLS with crontab expiry monitoring scripts.',
  category: 'oracle-security' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-24'),
  youtubeUrl: null,
  content: `## Overview

This runbook covers the complete procedure for:
1. Building a two-tier internal Certificate Authority (Root CA + Intermediate CA) on RHEL 9 using OpenSSL
2. Generating a Certificate Signing Request (CSR) for Oracle Enterprise Manager 13c OMS
3. Signing the certificate with the Intermediate CA
4. Installing the certificate in OEM 13c via emctl
5. Distributing CA trust to managed hosts and agents
6. Testing and validating the full certificate chain
7. Crontab monitoring scripts for ongoing expiry alerting

---

## Environment Assumptions

| Component | Value (replace with site values) |
|-----------|----------------------------------|
| CA server hostname | ca-server.internal.company.com |
| CA server OS | RHEL 9 |
| OEM OMS hostname | oms-host.internal.company.com |
| OEM OMS short name | oms-host |
| OEM upload port | 4889 |
| OEM console port | 7803 |
| OMS home | /u01/app/oracle/middleware |
| OMS instance home | /u01/app/oracle/gc_inst |
| CA base directory | /opt/ca |
| Certificate validity | Server: 730 days (2 years) |
| CA intermediate validity | 3650 days (10 years) |
| CA root validity | 7300 days (20 years) |

---

## Phase 1: CA Server Setup

### 1.1 Install OpenSSL and Prepare the CA Host

\`\`\`bash
# On ca-server.internal.company.com — run as root
dnf install -y openssl openssl-libs

# Verify OpenSSL version — must be 1.1.1 or 3.x
openssl version

# Create CA directory structure
mkdir -p /opt/ca/{root-ca,intermediate-ca}/{certs,crl,csr,newcerts,private}
mkdir -p /opt/ca/{root-ca,intermediate-ca}/index

# Secure the private key directories
chmod 700 /opt/ca/root-ca/private
chmod 700 /opt/ca/intermediate-ca/private

# Initialise the certificate databases
touch /opt/ca/root-ca/index.txt
touch /opt/ca/intermediate-ca/index.txt
echo 1000 > /opt/ca/root-ca/serial
echo 1000 > /opt/ca/intermediate-ca/serial
echo 1000 > /opt/ca/root-ca/crlnumber
echo 1000 > /opt/ca/intermediate-ca/crlnumber
\`\`\`

### 1.2 Create Root CA OpenSSL Configuration

\`\`\`bash
cat > /opt/ca/root-ca/openssl.cnf << 'ROOTCNF'
[ ca ]
default_ca = CA_default

[ CA_default ]
dir               = /opt/ca/root-ca
certs             = \$dir/certs
crl_dir           = \$dir/crl
new_certs_dir     = \$dir/newcerts
database          = \$dir/index.txt
serial            = \$dir/serial
RANDFILE          = \$dir/private/.rand
private_key       = \$dir/private/root-ca.key
certificate       = \$dir/certs/root-ca.crt
crlnumber         = \$dir/crlnumber
crl               = \$dir/crl/root-ca.crl
crl_extensions    = crl_ext
default_crl_days  = 365
default_md        = sha256
name_opt          = ca_default
cert_opt          = ca_default
default_days      = 3650
preserve          = no
policy            = policy_strict

[ policy_strict ]
countryName             = match
stateOrProvinceName     = match
organizationName        = match
organizationalUnitName  = optional
commonName              = supplied
emailAddress            = optional

[ req ]
default_bits        = 4096
distinguished_name  = req_distinguished_name
string_mask         = utf8only
default_md          = sha256
x509_extensions     = v3_ca

[ req_distinguished_name ]
countryName                     = Country Name (2 letter code)
stateOrProvinceName             = State or Province Name
localityName                    = Locality Name
0.organizationName              = Organization Name
organizationalUnitName          = Organizational Unit Name
commonName                      = Common Name
emailAddress                    = Email Address

[ v3_ca ]
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always,issuer
basicConstraints = critical, CA:true
keyUsage = critical, digitalSignature, cRLSign, keyCertSign

[ v3_intermediate_ca ]
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always,issuer
basicConstraints = critical, CA:true, pathlen:0
keyUsage = critical, digitalSignature, cRLSign, keyCertSign

[ crl_ext ]
authorityKeyIdentifier = keyid:always

[ ocsp ]
basicConstraints = CA:FALSE
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, OCSPSigning
ROOTCNF
\`\`\`

### 1.3 Create Intermediate CA OpenSSL Configuration

\`\`\`bash
cat > /opt/ca/intermediate-ca/openssl.cnf << 'INTCNF'
[ ca ]
default_ca = CA_default

[ CA_default ]
dir               = /opt/ca/intermediate-ca
certs             = \$dir/certs
crl_dir           = \$dir/crl
new_certs_dir     = \$dir/newcerts
database          = \$dir/index.txt
serial            = \$dir/serial
RANDFILE          = \$dir/private/.rand
private_key       = \$dir/private/intermediate-ca.key
certificate       = \$dir/certs/intermediate-ca.crt
crlnumber         = \$dir/crlnumber
crl               = \$dir/crl/intermediate-ca.crl
crl_extensions    = crl_ext
default_crl_days  = 180
default_md        = sha256
name_opt          = ca_default
cert_opt          = ca_default
default_days      = 730
preserve          = no
policy            = policy_loose
copy_extensions   = copy

[ policy_loose ]
countryName             = optional
stateOrProvinceName     = optional
localityName            = optional
organizationName        = optional
organizationalUnitName  = optional
commonName              = supplied
emailAddress            = optional

[ req ]
default_bits        = 2048
distinguished_name  = req_distinguished_name
string_mask         = utf8only
default_md          = sha256

[ req_distinguished_name ]
countryName                     = Country Name (2 letter code)
stateOrProvinceName             = State or Province Name
localityName                    = Locality Name
0.organizationName              = Organization Name
organizationalUnitName          = Organizational Unit Name
commonName                      = Common Name

[ server_cert ]
basicConstraints = CA:FALSE
nsCertType = server
nsComment = "Internal CA Server Certificate"
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer:always
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[ crl_ext ]
authorityKeyIdentifier = keyid:always
INTCNF
\`\`\`

---

## Phase 2: Generate Root CA

\`\`\`bash
# Generate Root CA private key — 4096-bit RSA, encrypted with AES-256
# You will be prompted to set a passphrase — store it in a password vault
openssl genrsa -aes256 -out /opt/ca/root-ca/private/root-ca.key 4096
chmod 400 /opt/ca/root-ca/private/root-ca.key

# Generate Root CA self-signed certificate
# When prompted, fill in your organisation's details consistently across all CA certs
openssl req -config /opt/ca/root-ca/openssl.cnf \\
  -key /opt/ca/root-ca/private/root-ca.key \\
  -new -x509 -days 7300 -sha256 \\
  -extensions v3_ca \\
  -subj "/C=US/ST=California/L=San Jose/O=Company Internal/OU=PKI/CN=Company Internal Root CA" \\
  -out /opt/ca/root-ca/certs/root-ca.crt

chmod 444 /opt/ca/root-ca/certs/root-ca.crt

# Verify the Root CA certificate
openssl x509 -noout -text -in /opt/ca/root-ca/certs/root-ca.crt | grep -E "Subject:|Issuer:|Not (Before|After)|CA:"
\`\`\`

Expected output:
\`\`\`
Subject: C=US, ST=California, L=San Jose, O=Company Internal, OU=PKI, CN=Company Internal Root CA
Issuer:  C=US, ST=California, L=San Jose, O=Company Internal, OU=PKI, CN=Company Internal Root CA
CA: TRUE
\`\`\`

---

## Phase 3: Generate Intermediate CA

### 3.1 Create the Intermediate CA Key and CSR

\`\`\`bash
# Generate Intermediate CA private key — 4096-bit, encrypted
openssl genrsa -aes256 -out /opt/ca/intermediate-ca/private/intermediate-ca.key 4096
chmod 400 /opt/ca/intermediate-ca/private/intermediate-ca.key

# Generate the Intermediate CA CSR
openssl req -config /opt/ca/intermediate-ca/openssl.cnf \\
  -new -sha256 \\
  -key /opt/ca/intermediate-ca/private/intermediate-ca.key \\
  -subj "/C=US/ST=California/L=San Jose/O=Company Internal/OU=PKI/CN=Company Internal Intermediate CA" \\
  -out /opt/ca/intermediate-ca/csr/intermediate-ca.csr
\`\`\`

### 3.2 Sign the Intermediate CA with the Root CA

\`\`\`bash
# Sign the Intermediate CA CSR with the Root CA
# This creates the Intermediate CA certificate
openssl ca -config /opt/ca/root-ca/openssl.cnf \\
  -extensions v3_intermediate_ca \\
  -days 3650 -notext -md sha256 \\
  -in /opt/ca/intermediate-ca/csr/intermediate-ca.csr \\
  -out /opt/ca/intermediate-ca/certs/intermediate-ca.crt

chmod 444 /opt/ca/intermediate-ca/certs/intermediate-ca.crt

# Verify the Intermediate CA certificate
openssl x509 -noout -text -in /opt/ca/intermediate-ca/certs/intermediate-ca.crt | \\
  grep -E "Subject:|Issuer:|Not (Before|After)|CA:|pathlen"

# Verify the chain: Intermediate CA verifies against Root CA
openssl verify -CAfile /opt/ca/root-ca/certs/root-ca.crt \\
  /opt/ca/intermediate-ca/certs/intermediate-ca.crt
# Expected output: /opt/ca/intermediate-ca/certs/intermediate-ca.crt: OK
\`\`\`

### 3.3 Build the CA Chain Bundle

The chain bundle (Intermediate CA + Root CA) is what gets distributed to client trust stores and included alongside server certificates.

\`\`\`bash
cat /opt/ca/intermediate-ca/certs/intermediate-ca.crt \\
    /opt/ca/root-ca/certs/root-ca.crt > \\
    /opt/ca/intermediate-ca/certs/ca-chain.crt

# Verify the chain bundle
openssl verify -CAfile /opt/ca/root-ca/certs/root-ca.crt \\
  -untrusted /opt/ca/intermediate-ca/certs/intermediate-ca.crt \\
  /opt/ca/intermediate-ca/certs/intermediate-ca.crt
\`\`\`

---

## Phase 4: Generate the OEM 13c Server Certificate

The OEM 13c OMS certificate can be generated in two ways: using OpenSSL directly on the CA server (method A), or using emctl's built-in CSR generation on the OMS host (method B). Method B is preferred because it generates the CSR from the actual OMS keystore — the private key is created inside OEM and never transmitted. Use Method A only if emctl CSR generation is unavailable.

### Method B (Recommended): Generate CSR via emctl on OMS Host

\`\`\`bash
# --- Run on oms-host.internal.company.com as the oracle user ---

# Set OMS environment
export ORACLE_HOME=/u01/app/oracle/middleware
export OMS_HOME=/u01/app/oracle/middleware
export PATH=\${OMS_HOME}/bin:\${PATH}

# Stop OMS (CSR generation requires OMS to be down)
emctl stop oms -all

# Generate the OEM CSR
# This creates a CSR and a new private key inside the OEM keystore
emctl generateCSR oms

# The CSR is written to:
# \$INSTANCE_HOME/em/EMGC_OMS1/sysman/config/emoms_req.csr
\`\`\`

Copy the CSR to the CA server:
\`\`\`bash
scp oracle@oms-host.internal.company.com:/u01/app/oracle/gc_inst/em/EMGC_OMS1/sysman/config/emoms_req.csr \\
    /opt/ca/intermediate-ca/csr/oem-oms.csr
\`\`\`

### Method A (Alternative): Generate CSR with OpenSSL

If using Method A, generate both the key and CSR on the CA server. The key will need to be transferred to the OEM host securely (encrypted channel, delete after import).

\`\`\`bash
# Create SAN configuration for the OEM OMS certificate
cat > /opt/ca/intermediate-ca/csr/oem-oms-san.cnf << 'SANCNF'
[ req ]
default_bits        = 2048
distinguished_name  = req_distinguished_name
req_extensions      = req_ext
string_mask         = utf8only
default_md          = sha256

[ req_distinguished_name ]
countryName             = US
stateOrProvinceName     = California
localityName            = San Jose
organizationName        = Company Internal
organizationalUnitName  = IT Operations
commonName              = oms-host.internal.company.com

[ req_ext ]
subjectAltName = @alt_names

[ alt_names ]
DNS.1 = oms-host.internal.company.com
DNS.2 = oms-host
DNS.3 = oem.company.com
# Add additional DNS aliases here if a load balancer or DNS alias exists
# IP.1 = 10.0.1.50  # Add only if clients connect by IP
SANCNF

# Generate key and CSR
openssl genrsa -out /opt/ca/intermediate-ca/private/oem-oms.key 2048
chmod 400 /opt/ca/intermediate-ca/private/oem-oms.key

openssl req -config /opt/ca/intermediate-ca/csr/oem-oms-san.cnf \\
  -key /opt/ca/intermediate-ca/private/oem-oms.key \\
  -new -sha256 \\
  -out /opt/ca/intermediate-ca/csr/oem-oms.csr
\`\`\`

### 4.1 Sign the OEM CSR with the Intermediate CA

Regardless of which method was used to generate the CSR, signing is done on the CA server with the Intermediate CA:

\`\`\`bash
# Create a SAN extension file for the certificate being signed
# This ensures SANs are included in the signed cert even if the CSR's extensions
# are not preserved by the CA signing process
cat > /opt/ca/intermediate-ca/csr/oem-oms-ext.cnf << 'EXTCNF'
subjectAltName = DNS:oms-host.internal.company.com,DNS:oms-host,DNS:oem.company.com
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
EXTCNF

# Sign the OEM OMS CSR
openssl ca -config /opt/ca/intermediate-ca/openssl.cnf \\
  -extensions server_cert \\
  -extfile /opt/ca/intermediate-ca/csr/oem-oms-ext.cnf \\
  -days 730 -notext -md sha256 \\
  -in /opt/ca/intermediate-ca/csr/oem-oms.csr \\
  -out /opt/ca/intermediate-ca/certs/oem-oms.crt

# Verify the signed certificate
openssl x509 -noout -text -in /opt/ca/intermediate-ca/certs/oem-oms.crt | \\
  grep -A 10 "Subject Alternative Name"

# Verify certificate chain
openssl verify \\
  -CAfile /opt/ca/intermediate-ca/certs/ca-chain.crt \\
  /opt/ca/intermediate-ca/certs/oem-oms.crt
# Expected: oem-oms.crt: OK
\`\`\`

### 4.2 Prepare the Certificate Bundle for OEM

\`\`\`bash
# Create a combined file: server cert + intermediate CA cert
# (OEM emctl importCertificate accepts this as the -chain_cert argument)
cat /opt/ca/intermediate-ca/certs/intermediate-ca.crt \\
    /opt/ca/root-ca/certs/root-ca.crt > \\
    /opt/ca/intermediate-ca/certs/oem-ca-chain.crt

# Copy the signed cert and chain to OMS host
scp /opt/ca/intermediate-ca/certs/oem-oms.crt \\
    oracle@oms-host.internal.company.com:/tmp/oem-oms.crt

scp /opt/ca/intermediate-ca/certs/oem-ca-chain.crt \\
    oracle@oms-host.internal.company.com:/tmp/oem-ca-chain.crt

# If using Method A: also copy the private key (encrypt or use a secure transfer method)
# scp /opt/ca/intermediate-ca/private/oem-oms.key oracle@oms-host:/tmp/oem-oms.key
\`\`\`

---

## Phase 5: Install the Certificate in OEM 13c

**All commands in this phase run on oms-host.internal.company.com as the oracle user.**

### 5.1 Pre-installation Checks

\`\`\`bash
export OMS_HOME=/u01/app/oracle/middleware
export PATH=\${OMS_HOME}/bin:\${PATH}

# Confirm OMS is stopped before certificate import
emctl status oms
# Expected: OMS is not running (it was stopped in Phase 4 for CSR generation)
# If OMS is running, stop it:
# emctl stop oms -all

# Verify the certificate and chain files are present
ls -la /tmp/oem-oms.crt /tmp/oem-ca-chain.crt

# Verify the signed certificate matches the CSR/key
# (For Method B — key is inside OEM, so this check is done implicitly by emctl)
# For Method A, verify key matches cert before import:
# openssl x509 -noout -modulus -in /tmp/oem-oms.crt | md5sum
# openssl rsa -noout -modulus -in /tmp/oem-oms.key | md5sum
# Both outputs must be identical

# Verify the chain verifies correctly from the OMS host
openssl verify -CAfile /tmp/oem-ca-chain.crt /tmp/oem-oms.crt
# Expected: /tmp/oem-oms.crt: OK
\`\`\`

### 5.2 Import the Certificate into OEM 13c

\`\`\`bash
# Import the signed certificate and CA chain
# -sign_cert: the signed server certificate
# -chain_cert: the CA certificate chain (Intermediate + Root CA)
emctl importCertificate oms \\
  -sign_cert /tmp/oem-oms.crt \\
  -chain_cert /tmp/oem-ca-chain.crt

# For Method A (OpenSSL-generated key), also provide the private key:
# emctl importCertificate oms \
#   -sign_cert /tmp/oem-oms.crt \
#   -chain_cert /tmp/oem-ca-chain.crt \
#   -priv_key /tmp/oem-oms.key
\`\`\`

The command will prompt for the OMS sysman password and perform:
- Import of the server certificate and chain into the WebLogic domain keystore
- Import into the Oracle Wallet at \`\$OMS_HOME/sysman/config/monwallet/\`
- Update of the OMS-side trust store

### 5.3 Start OMS and Verify

\`\`\`bash
# Start OMS
emctl start oms

# Wait 3-5 minutes for WebLogic and OMS to fully initialise, then check status
sleep 180
emctl status oms

# Expected output includes:
# Oracle Management Service is Up
# HTTPS console URL at port 7803
\`\`\`

### 5.4 Secure OMS Console Certificate (Additional Step for Console)

In some OEM 13c installations, the WebLogic console SSL port requires a separate step:

\`\`\`bash
# If the browser still shows a certificate warning after importCertificate,
# re-secure the OMS console explicitly
emctl secure oms -console

# Then restart
emctl stop oms -all
emctl start oms
\`\`\`

---

## Phase 6: Distribute CA Trust to Managed Hosts

Every managed host (where an OEM agent runs) must trust the internal CA. This is done by adding the CA chain to the OS trust store on each managed host.

### 6.1 Distribute CA Certificate via Ansible or Script

\`\`\`bash
#!/bin/bash
# /opt/scripts/distribute_ca_cert.sh
# Run from a host with SSH key access to all managed hosts
# Usage: ./distribute_ca_cert.sh <hostfile>

HOSTFILE=\${1:-/opt/scripts/managed_hosts.txt}
CA_CERT="/opt/ca/intermediate-ca/certs/ca-chain.crt"
REMOTE_DEST="/etc/pki/ca-trust/source/anchors/internal-ca-chain.crt"

if [ ! -f "\${HOSTFILE}" ]; then
  echo "ERROR: host file not found: \${HOSTFILE}"
  exit 1
fi

while IFS= read -r HOST; do
  [ -z "\${HOST}" ] && continue
  echo "Distributing CA cert to \${HOST}..."
  scp "\${CA_CERT}" "root@\${HOST}:\${REMOTE_DEST}" && \\
    ssh "root@\${HOST}" "update-ca-trust extract && echo 'CA trust updated on \${HOST}'" || \\
    echo "ERROR: failed on \${HOST}"
done < "\${HOSTFILE}"

echo "CA certificate distribution complete."
\`\`\`

### 6.2 Manual CA Trust Update on Individual Host

\`\`\`bash
# Run on each managed host as root
# Copy the CA chain certificate
cp /tmp/internal-ca-chain.crt /etc/pki/ca-trust/source/anchors/

# Update the system trust store
update-ca-trust extract

# Verify the CA is now trusted
trust list | grep -i "Company Internal"
# Expected: shows both Root CA and Intermediate CA entries
\`\`\`

### 6.3 Update Agent Wallet with CA Certificate

After the OMS certificate is updated and agents can connect, force a re-secure of all agents to push the new CA trust into each agent wallet:

\`\`\`bash
# On the OMS host — push updated trust to all agents
# This triggers each agent to re-download the OMS certificate chain
# and update its local wallet

# Option 1: resecure all agents from OEM console
# OEM Cloud Control → Setup → Security → Agents → Select All → Resecure

# Option 2: resecure a specific agent from the OMS host
# Run on the agent host as oracle user:
# \$AGENT_HOME/bin/emctl secure agent -emdWalletSrcUrl https://oms-host.internal.company.com:4889/em

# Option 3: script-driven agent resecure (run on OMS host)
\$OMS_HOME/bin/emcli login -username=sysman -password_file=/tmp/sysman_pwd.txt
\$OMS_HOME/bin/emcli resecure_agents -targets=all
\`\`\`

---

## Phase 7: Browser Trust Configuration

### 7.1 Corporate Workstations (Linux Firefox)

\`\`\`bash
# Add the CA chain to the Firefox NSS trust store
# for system-wide Firefox on RHEL 9
certutil -A -n "Company Internal Root CA" \\
  -t "CT,," \\
  -i /opt/ca/root-ca/certs/root-ca.crt \\
  -d /etc/pki/nssdb

certutil -A -n "Company Internal Intermediate CA" \\
  -t "CT,," \\
  -i /opt/ca/intermediate-ca/certs/intermediate-ca.crt \\
  -d /etc/pki/nssdb
\`\`\`

### 7.2 Windows Workstations (Group Policy)

Distribute the CA chain via Windows Group Policy:
\`\`\`
Computer Configuration → Windows Settings → Security Settings →
  Public Key Policies → Trusted Root Certification Authorities
  → Import root-ca.crt

Computer Configuration → Windows Settings → Security Settings →
  Public Key Policies → Intermediate Certification Authorities
  → Import intermediate-ca.crt
\`\`\`

After Group Policy propagation (or \`gpupdate /force\`), all browsers and tools on Windows workstations will trust certificates issued by the internal CA.

---

## Phase 8: Testing and Validation

### 8.1 TLS Handshake Validation

\`\`\`bash
#!/bin/bash
# /opt/scripts/validate_oem_cert.sh
# Run from any host that has the CA trust installed

OMS_HOST="oms-host.internal.company.com"
OMS_PORT="7803"
CA_CHAIN="/etc/pki/ca-trust/source/anchors/internal-ca-chain.crt"

echo "=== OEM 13c Certificate Validation ==="
echo ""

# 1. TLS handshake verification
echo "--- 1. TLS Handshake ---"
openssl s_client \\
  -connect "\${OMS_HOST}:\${OMS_PORT}" \\
  -CAfile "\${CA_CHAIN}" \\
  -verify_return_error \\
  </dev/null 2>&1 | grep -E "Verify return code|depth|issuer|subject|CN ="

echo ""

# 2. Certificate details
echo "--- 2. Certificate Details ---"
openssl s_client -connect "\${OMS_HOST}:\${OMS_PORT}" </dev/null 2>/dev/null | \\
  openssl x509 -noout -text | \\
  grep -E "Subject:|Issuer:|Not Before:|Not After:|DNS:|IP Address:"

echo ""

# 3. Days until expiry
echo "--- 3. Certificate Expiry ---"
EXPIRY_DATE=\$(openssl s_client -connect "\${OMS_HOST}:\${OMS_PORT}" </dev/null 2>/dev/null | \\
  openssl x509 -noout -enddate | cut -d= -f2)
EXPIRY_EPOCH=\$(date -d "\${EXPIRY_DATE}" +%s)
NOW_EPOCH=\$(date +%s)
DAYS_LEFT=\$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))

echo "Certificate expires: \${EXPIRY_DATE}"
echo "Days remaining:      \${DAYS_LEFT}"

if [ "\${DAYS_LEFT}" -lt 90 ]; then
  echo "WARNING: Certificate expires in less than 90 days — schedule renewal"
fi

echo ""

# 4. Check upload port as well
echo "--- 4. Agent Upload Port (4889) ---"
openssl s_client \\
  -connect "\${OMS_HOST}:4889" \\
  -CAfile "\${CA_CHAIN}" \\
  -verify_return_error \\
  </dev/null 2>&1 | grep -E "Verify return code|CN ="

echo ""
echo "=== Validation Complete ==="
\`\`\`

### 8.2 OMS and Agent Status Check

\`\`\`bash
#!/bin/bash
# Run on oms-host.internal.company.com as oracle user

export OMS_HOME=/u01/app/oracle/middleware
export PATH=\${OMS_HOME}/bin:\${PATH}

echo "=== OMS Status ==="
emctl status oms

echo ""
echo "=== Checking Agent Connectivity ==="
# List agents reporting successfully after certificate change
\$OMS_HOME/bin/emcli login -username=sysman -password_file=/tmp/sysman_pwd.txt
\$OMS_HOME/bin/emcli list_targets -targets="oracle_emd" -format=name:csv 2>/dev/null | \\
  while IFS=',' read -r NAME HOST STATUS; do
    if [ "\${STATUS}" != "UP" ]; then
      echo "AGENT_DOWN: \${NAME} on \${HOST} — Status: \${STATUS}"
    fi
  done
echo "Agent connectivity check complete."
\`\`\`

### 8.3 Browser Validation

Open \`https://oms-host.internal.company.com:7803/em\` in a browser on a workstation where the CA chain has been installed. Verify:

- The browser shows a green padlock with no warnings
- Clicking the padlock shows the certificate issued by "Company Internal Intermediate CA"
- The certificate chain shows: OEM OMS cert → Company Internal Intermediate CA → Company Internal Root CA
- The SAN list includes the hostname used to access OEM

### 8.4 Python / curl API Validation

\`\`\`bash
# Test OEM REST API with CA verification (no --insecure flag)
curl --cacert /etc/pki/ca-trust/source/anchors/internal-ca-chain.crt \\
  -u sysman:your_password \\
  "https://oms-host.internal.company.com:7803/em/websvcs/restful/extws/cloudservices/admin/cfw/v2/targets?target_type=oracle_database" \\
  | python3 -m json.tool | head -20

# If curl returns any SSL error, the CA trust distribution step is incomplete
\`\`\`

---

## Phase 9: Certificate Expiry Monitoring Scripts

### Script 1: OEM Certificate Expiry Alert

\`\`\`bash
#!/bin/bash
# /opt/scripts/check_oem_cert_expiry.sh
# Alerts when OEM 13c OMS certificate is within the warning threshold

OMS_HOST="oms-host.internal.company.com"
OMS_PORT="7803"
WARN_DAYS=90
CRIT_DAYS=30
ALERT_EMAIL="dba-team@company.com"
LOG_FILE="/var/log/cert_monitor/oem_cert_\$(date +%Y%m%d).log"

mkdir -p /var/log/cert_monitor

TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
echo "=== OEM Certificate Expiry Check: \${TIMESTAMP} ===" >> "\${LOG_FILE}"

# Get certificate expiry date
EXPIRY_DATE=\$(openssl s_client -connect "\${OMS_HOST}:\${OMS_PORT}" -servername "\${OMS_HOST}" \\
  </dev/null 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)

if [ -z "\${EXPIRY_DATE}" ]; then
  MSG="ERROR: Could not retrieve certificate from \${OMS_HOST}:\${OMS_PORT}"
  echo "\${MSG}" >> "\${LOG_FILE}"
  echo -e "Subject: ALERT: OEM Certificate Check Failed\n\n\${MSG}" | sendmail "\${ALERT_EMAIL}"
  exit 1
fi

EXPIRY_EPOCH=\$(date -d "\${EXPIRY_DATE}" +%s 2>/dev/null)
NOW_EPOCH=\$(date +%s)
DAYS_LEFT=\$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))

echo "Certificate: \${OMS_HOST}:\${OMS_PORT}" >> "\${LOG_FILE}"
echo "Expires:     \${EXPIRY_DATE}" >> "\${LOG_FILE}"
echo "Days left:   \${DAYS_LEFT}" >> "\${LOG_FILE}"

if [ "\${DAYS_LEFT}" -le "\${CRIT_DAYS}" ]; then
  SEVERITY="CRITICAL"
elif [ "\${DAYS_LEFT}" -le "\${WARN_DAYS}" ]; then
  SEVERITY="WARNING"
else
  SEVERITY="OK"
  echo "Status: OK — \${DAYS_LEFT} days until expiry" >> "\${LOG_FILE}"
  exit 0
fi

MSG="\${SEVERITY}: OEM 13c OMS certificate expires in \${DAYS_LEFT} days (\${EXPIRY_DATE}).
Host: \${OMS_HOST}:\${OMS_PORT}
Action required: schedule certificate renewal maintenance window."

echo "\${MSG}" >> "\${LOG_FILE}"
echo -e "Subject: \${SEVERITY}: OEM Certificate Expiry in \${DAYS_LEFT} Days\n\n\${MSG}" \\
  | sendmail "\${ALERT_EMAIL}"
\`\`\`

### Script 2: CA Certificate Expiry Monitor

Monitors both the Intermediate CA and Root CA certificate expiry:

\`\`\`bash
#!/bin/bash
# /opt/scripts/check_ca_cert_expiry.sh
# Run on ca-server.internal.company.com

ALERT_EMAIL="dba-team@company.com"
LOG_FILE="/var/log/cert_monitor/ca_certs_\$(date +%Y%m%d).log"
WARN_DAYS=365

mkdir -p /var/log/cert_monitor

declare -A CA_CERTS=(
  ["Root CA"]="/opt/ca/root-ca/certs/root-ca.crt"
  ["Intermediate CA"]="/opt/ca/intermediate-ca/certs/intermediate-ca.crt"
)

TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
echo "=== CA Certificate Expiry Check: \${TIMESTAMP} ===" >> "\${LOG_FILE}"

ALERT_MSG=""
for NAME in "\${!CA_CERTS[@]}"; do
  CERT_FILE="\${CA_CERTS[\${NAME}]}"
  EXPIRY_DATE=\$(openssl x509 -noout -enddate -in "\${CERT_FILE}" 2>/dev/null | cut -d= -f2)

  if [ -z "\${EXPIRY_DATE}" ]; then
    ALERT_MSG+="\nERROR: Could not read \${NAME} at \${CERT_FILE}"
    continue
  fi

  EXPIRY_EPOCH=\$(date -d "\${EXPIRY_DATE}" +%s)
  NOW_EPOCH=\$(date +%s)
  DAYS_LEFT=\$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))

  echo "\${NAME}: expires \${EXPIRY_DATE} (\${DAYS_LEFT} days)" >> "\${LOG_FILE}"

  if [ "\${DAYS_LEFT}" -le "\${WARN_DAYS}" ]; then
    ALERT_MSG+="\nWARNING: \${NAME} expires in \${DAYS_LEFT} days (\${EXPIRY_DATE}) — plan CA renewal"
  fi
done

if [ -n "\${ALERT_MSG}" ]; then
  echo -e "Subject: WARNING: Internal CA Certificate Expiry Alert\n\n\${ALERT_MSG}" \\
    | sendmail "\${ALERT_EMAIL}"
fi
\`\`\`

### Script 3: Multi-Host Certificate Inventory

Scans all known OEM-connected hosts for any certificates expiring within the threshold:

\`\`\`bash
#!/bin/bash
# /opt/scripts/cert_inventory_scan.sh
# Scans a list of host:port pairs and reports expiry status

HOSTPORT_FILE="/opt/scripts/cert_scan_targets.txt"
WARN_DAYS=90
ALERT_EMAIL="dba-team@company.com"
REPORT_FILE="/var/log/cert_monitor/cert_inventory_\$(date +%Y%m%d).log"

# cert_scan_targets.txt format: host:port  description
# oms-host.internal.company.com:7803  OEM OMS Console
# oms-host.internal.company.com:4889  OEM OMS Upload

mkdir -p /var/log/cert_monitor
echo "=== Certificate Inventory Scan: \$(date) ===" > "\${REPORT_FILE}"
printf "%-55s %-12s %-30s %s\n" "ENDPOINT" "DAYS_LEFT" "EXPIRES" "STATUS" >> "\${REPORT_FILE}"
echo "$(printf '%0.s-' {1..110})" >> "\${REPORT_FILE}"

ALERT_LINES=""
while IFS=' ' read -r HOSTPORT DESC; do
  [ -z "\${HOSTPORT}" ] && continue
  HOST=\$(echo "\${HOSTPORT}" | cut -d: -f1)
  PORT=\$(echo "\${HOSTPORT}" | cut -d: -f2)

  EXPIRY_DATE=\$(openssl s_client -connect "\${HOSTPORT}" -servername "\${HOST}" \\
    </dev/null 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)

  if [ -z "\${EXPIRY_DATE}" ]; then
    printf "%-55s %-12s %-30s %s\n" "\${HOSTPORT}" "ERROR" "N/A" "Connection failed" >> "\${REPORT_FILE}"
    ALERT_LINES+="\nERROR: \${HOSTPORT} (\${DESC}) — could not connect"
    continue
  fi

  EXPIRY_EPOCH=\$(date -d "\${EXPIRY_DATE}" +%s)
  DAYS_LEFT=\$(( (EXPIRY_EPOCH - \$(date +%s)) / 86400 ))

  if [ "\${DAYS_LEFT}" -le "\${WARN_DAYS}" ]; then
    STATUS="EXPIRING SOON"
    ALERT_LINES+="\nWARN: \${HOSTPORT} (\${DESC}) — \${DAYS_LEFT} days (\${EXPIRY_DATE})"
  else
    STATUS="OK"
  fi

  printf "%-55s %-12s %-30s %s\n" "\${HOSTPORT}" "\${DAYS_LEFT}" "\${EXPIRY_DATE}" "\${STATUS}" >> "\${REPORT_FILE}"

done < "\${HOSTPORT_FILE}"

cat "\${REPORT_FILE}"

if [ -n "\${ALERT_LINES}" ]; then
  echo -e "Subject: Certificate Inventory Alert — Certificates Expiring Soon\n\n\${ALERT_LINES}\n\nFull report: \${REPORT_FILE}" \\
    | sendmail "\${ALERT_EMAIL}"
fi
\`\`\`

### Crontab Configuration

\`\`\`bash
# /etc/cron.d/cert_monitor
# Certificate expiry monitoring

MAILTO=""
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# OEM OMS certificate expiry — check daily at 8am
0 8 * * *    root  /opt/scripts/check_oem_cert_expiry.sh >> /var/log/cert_monitor/cron.log 2>&1

# CA certificate expiry — check weekly on Monday at 8am
0 8 * * 1    root  /opt/scripts/check_ca_cert_expiry.sh >> /var/log/cert_monitor/cron.log 2>&1

# Full certificate inventory scan — weekly on Monday at 9am
0 9 * * 1    root  /opt/scripts/cert_inventory_scan.sh >> /var/log/cert_monitor/cron.log 2>&1
\`\`\`

---

## Phase 10: OEM Certificate Renewal Procedure

When the OEM OMS certificate approaches expiry, the renewal procedure is:

\`\`\`bash
# 1. On the CA server — generate a new CSR or reuse existing key
#    (best practice: generate a fresh key for each renewal)
openssl genrsa -out /opt/ca/intermediate-ca/private/oem-oms-v2.key 2048
openssl req -config /opt/ca/intermediate-ca/csr/oem-oms-san.cnf \\
  -key /opt/ca/intermediate-ca/private/oem-oms-v2.key \\
  -new -sha256 -out /opt/ca/intermediate-ca/csr/oem-oms-v2.csr

# 2. Sign the new CSR (same as Phase 4)
openssl ca -config /opt/ca/intermediate-ca/openssl.cnf \\
  -extensions server_cert \\
  -extfile /opt/ca/intermediate-ca/csr/oem-oms-ext.cnf \\
  -days 730 -notext -md sha256 \\
  -in /opt/ca/intermediate-ca/csr/oem-oms-v2.csr \\
  -out /opt/ca/intermediate-ca/certs/oem-oms-v2.crt

# 3. Copy to OMS host
scp /opt/ca/intermediate-ca/certs/oem-oms-v2.crt oracle@oms-host:/tmp/
scp /opt/ca/intermediate-ca/private/oem-oms-v2.key oracle@oms-host:/tmp/

# 4. On OMS host — import during maintenance window (same as Phase 5)
emctl stop oms -all
emctl importCertificate oms \\
  -sign_cert /tmp/oem-oms-v2.crt \\
  -chain_cert /tmp/oem-ca-chain.crt \\
  -priv_key /tmp/oem-oms-v2.key
emctl start oms

# 5. Validate (same as Phase 8)
/opt/scripts/validate_oem_cert.sh

# 6. Securely delete private key from OMS host after import
shred -u /tmp/oem-oms-v2.key
\`\`\`

---

## Summary

The internal CA setup on RHEL 9 follows a two-tier hierarchy: an offline Root CA (20-year validity, private key encrypted and air-gapped) and an online Intermediate CA (10-year validity) that handles all day-to-day certificate issuance. OEM 13c certificate replacement uses \`emctl generateCSR oms\` to generate the CSR from within OEM (keeping the private key inside OEM) and \`emctl importCertificate oms\` to install the signed certificate and CA chain in a single operation that updates the WebLogic keystore, Oracle Wallet, and OMS trust store simultaneously. CA trust distribution to managed hosts requires both the OS-level \`update-ca-trust\` step on each agent host and an agent re-secure operation to push the updated trust chain into each agent wallet. Validation uses \`openssl s_client\` with the CA file to confirm a clean verify return code on both the console port (7803) and the upload port (4889). The three crontab monitoring scripts — OEM cert expiry check (daily), CA cert expiry check (weekly), and full certificate inventory scan (weekly) — provide early warning at 90 days before the OMS certificate expires, giving adequate lead time to schedule the renewal maintenance window.`,
};

async function main() {
  console.log('Inserting Internal CA / OEM 13c certificate runbook...');
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
