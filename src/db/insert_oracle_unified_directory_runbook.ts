import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Unified Directory — Installation, Replication, and Day-to-Day Administration',
  slug: 'oracle-unified-directory-runbook',
  excerpt:
    'Step-by-step operational runbook for Oracle Unified Directory (OUD): silent installation, TLS certificate setup, OU and service account creation, two-node active-active replication, start/stop procedures, common LDAP operations, bulk import/export, monitoring scripts, and a troubleshooting table for the most common OUD failure modes.',
  category: 'identity-management' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-02'),
  youtubeUrl: null,
  content: `## Overview

This runbook covers the complete operational lifecycle of an Oracle Unified Directory (OUD) deployment: from silent installation and TLS certificate configuration, through two-node active-active replication setup, to day-to-day administration tasks including user management, bulk import/export, monitoring, and backup. It is written for Oracle DBAs and middleware administrators responsible for the OUD tier in an Oracle Identity Management (OAM/OIG) deployment.

All commands assume:
- OUD 12c (12.2.1.4 or later)
- Oracle Linux 8 / RHEL 8
- Two-node active-active topology: \`oud-node1.example.com\` and \`oud-node2.example.com\`
- Base DN: \`dc=example,dc=com\`

---

## Prerequisites

### Hardware Per OUD Node

| Resource | Minimum | Recommended |
|---|---|---|
| CPU | 4 cores | 8 cores |
| RAM | 8 GB | 32 GB |
| Storage (\${OUD_INSTANCE}) | 50 GB | 200 GB SSD |
| OS | Oracle Linux 7/8 or RHEL 7/8 | Oracle Linux 8 |
| JDK | JDK 11 (Oracle JDK) | JDK 11+ |

### OS Prerequisites

\`\`\`bash
# Install required packages
dnf install -y libaio libnsl compat-openssl10

# Set file descriptor limits for the oracle OS user
cat >> /etc/security/limits.conf <<'EOF'
oracle soft nofile 65536
oracle hard nofile 65536
oracle soft nproc 16384
oracle hard nproc 16384
EOF

# Verify JDK
java -version
# Expected: openjdk version "11.x.x" or oracle java "11.x.x"
\`\`\`

### Environment Variables

Set these in \`~oracle/.bash_profile\` before running any OUD commands:

\`\`\`bash
export OUD_HOME=/u01/oracle/middleware/oud
export JAVA_HOME=/u01/oracle/jdk11
export OUD_INSTANCE=/u01/oracle/oud_instances/instance1
export PATH=\${OUD_HOME}/bin:\${JAVA_HOME}/bin:\${PATH}
\`\`\`

---

## Step 1: OUD Installation

Download \`oud-setup.jar\` from Oracle Software Delivery Cloud (or My Oracle Support patch for the latest OUD 12.2.1.4.x release). Place at \`/tmp/oud-setup.jar\`.

\`\`\`bash
# Create directories
mkdir -p \${OUD_HOME} \${OUD_INSTANCE}
chown -R oracle:oinstall /u01/oracle

# Silent install (run as oracle OS user)
java -jar /tmp/oud-setup.jar \\
  -silent \\
  --acceptLicense \\
  --instancePath \${OUD_INSTANCE} \\
  --adminConnectorPort 4444 \\
  --ldapPort 1389 \\
  --ldapsPort 1636 \\
  --httpPort 8080 \\
  --httpsPort 8443 \\
  --rootUserDN "cn=Directory Manager" \\
  --rootUserPassword "\${DM_PASSWORD}" \\
  --baseDN "dc=example,dc=com" \\
  --addBaseEntry \\
  --sampleData 0 \\
  --enableStartTLS \\
  --generateSelfSignedCertificate \\
  --hostName oud-node1.example.com
\`\`\`

### Verify Startup

\`\`\`bash
\${OUD_INSTANCE}/OUD/bin/status \\
  --hostname oud-node1.example.com \\
  --port 4444 \\
  --bindDN "cn=Directory Manager" \\
  --bindPassword "\${DM_PASSWORD}" \\
  --trustAll
\`\`\`

Expected output shows:

\`\`\`
Server Run Status:        Started
Open Connections:         1
Administration Connector: Port 4444 (LDAPS)
Connection Handlers:
  LDAP  : Port 1389 (LDAP)
  LDAPS : Port 1636 (LDAPS)
  HTTP  : Port 8080 (HTTP)
  HTTPS : Port 8443 (HTTPS)
Data Sources:
  Backend ID:  userRoot    State: ENABLED
  Base DN:     dc=example,dc=com    Entries: 1
\`\`\`

Repeat the silent install on oud-node2 with \`--hostName oud-node2.example.com\`. Do not configure replication yet — complete Steps 2–3 on both nodes first.

---

## Step 2: TLS Certificate Configuration (Production)

The silent install generates a self-signed certificate. Replace it with a CA-signed certificate before connecting OAM, OIG, or any other consumer.

### Generate a CSR

\`\`\`bash
\${OUD_INSTANCE}/OUD/bin/manage-certificates generate-certificate-request \\
  --keystore \${OUD_INSTANCE}/OUD/config/keystore \\
  --keystore-password-file \${OUD_INSTANCE}/OUD/config/keystore.pin \\
  --alias server-cert \\
  --subject-dn "CN=oud-node1.example.com,O=Example Corp,C=US" \\
  --output-file /tmp/oud-node1.csr
\`\`\`

Submit \`/tmp/oud-node1.csr\` to your internal CA or a public CA. Once the signed certificate and CA chain are returned:

### Import the Signed Certificate

\`\`\`bash
\${OUD_INSTANCE}/OUD/bin/manage-certificates import-certificate \\
  --keystore \${OUD_INSTANCE}/OUD/config/keystore \\
  --keystore-password-file \${OUD_INSTANCE}/OUD/config/keystore.pin \\
  --alias server-cert \\
  --certificate-file /tmp/oud-node1-signed.pem \\
  --certificate-file /tmp/ca-chain.pem

# Restart OUD to pick up the new certificate
\${OUD_INSTANCE}/OUD/bin/stop-ds
\${OUD_INSTANCE}/OUD/bin/start-ds
\`\`\`

### Verify Certificate

\`\`\`bash
openssl s_client -connect oud-node1.example.com:1636 -showcerts </dev/null 2>/dev/null \\
  | openssl x509 -noout -subject -dates
\`\`\`

Confirm the subject CN matches the hostname and the \`notAfter\` date is at least 1 year out.

---

## Step 3: Create Organizational Units and Service Accounts

Run on oud-node1. After replication is configured in Step 4, these entries will replicate to oud-node2.

### Base OU Structure

\`\`\`bash
ldapadd -h oud-node1 -p 1389 \\
  -D "cn=Directory Manager" -w "\${DM_PASSWORD}" <<'EOF_LDIF'
dn: ou=People,dc=example,dc=com
objectClass: organizationalUnit
ou: People

dn: ou=Groups,dc=example,dc=com
objectClass: organizationalUnit
ou: Groups

dn: cn=ServiceAccounts,dc=example,dc=com
objectClass: organizationalUnit
ou: ServiceAccounts
EOF_LDIF
\`\`\`

### OAM Identity Store Bind Account

\`\`\`bash
ldapadd -h oud-node1 -p 1389 \\
  -D "cn=Directory Manager" -w "\${DM_PASSWORD}" <<'EOF_LDIF'
dn: cn=oam-bind,cn=ServiceAccounts,dc=example,dc=com
objectClass: inetOrgPerson
objectClass: person
objectClass: top
cn: oam-bind
sn: oam-bind
uid: oam-bind
userPassword: \${OAM_BIND_PASSWORD}
description: OAM identity store bind account - do not delete
EOF_LDIF
\`\`\`

### Apply ACI for OAM Bind Account

\`\`\`bash
ldapmodify -h oud-node1 -p 1389 \\
  -D "cn=Directory Manager" -w "\${DM_PASSWORD}" <<'EOF_LDIF'
dn: ou=People,dc=example,dc=com
changetype: modify
add: aci
aci: (targetattr="*")(version 3.0; acl "OAM read access";
  allow(read,search,compare)
  userdn="ldap:///cn=oam-bind,cn=ServiceAccounts,dc=example,dc=com";)
EOF_LDIF
\`\`\`

### OIG Provisioning Account

\`\`\`bash
ldapadd -h oud-node1 -p 1389 \\
  -D "cn=Directory Manager" -w "\${DM_PASSWORD}" <<'EOF_LDIF'
dn: cn=oig-provisioning,cn=ServiceAccounts,dc=example,dc=com
objectClass: inetOrgPerson
objectClass: person
objectClass: top
cn: oig-provisioning
sn: oig-provisioning
uid: oig-provisioning
userPassword: \${OIG_PROV_PASSWORD}
description: OIG provisioning account - write access to ou=People
EOF_LDIF
\`\`\`

---

## Step 4: Configure Replication (Two-Node Active-Active)

The \`dsreplication configure\` command must be run as a single operation specifying both nodes. It connects to the admin connector of each node (port 4444) to establish the replication agreement.

### Configure Replication

Run from oud-node1 (it will connect to both nodes):

\`\`\`bash
\${OUD_INSTANCE}/OUD/bin/dsreplication configure \\
  --adminUID admin \\
  --adminPassword "\${REPL_ADMIN_PASSWORD}" \\
  --baseDN "dc=example,dc=com" \\
  --host1 oud-node1.example.com \\
  --port1 4444 \\
  --bindDN1 "cn=Directory Manager" \\
  --bindPassword1 "\${DM_PASSWORD}" \\
  --replicationPort1 8989 \\
  --host2 oud-node2.example.com \\
  --port2 4444 \\
  --bindDN2 "cn=Directory Manager" \\
  --bindPassword2 "\${DM_PASSWORD}" \\
  --replicationPort2 8989 \\
  --trustAll \\
  --no-prompt
\`\`\`

### Initialize Replication (Copy Node1 Data to Node2)

\`\`\`bash
\${OUD_INSTANCE}/OUD/bin/dsreplication initialize \\
  --adminUID admin \\
  --adminPassword "\${REPL_ADMIN_PASSWORD}" \\
  --baseDN "dc=example,dc=com" \\
  --hostSource oud-node1.example.com \\
  --portSource 4444 \\
  --hostDestination oud-node2.example.com \\
  --portDestination 4444 \\
  --trustAll \\
  --no-prompt
\`\`\`

The \`dsreplication initialize\` command streams the entire backend from the source to the destination node. This can take several minutes for large directories. Progress is logged to the OUD error log on both nodes.

### Verify Replication Status

\`\`\`bash
\${OUD_INSTANCE}/OUD/bin/dsreplication status \\
  --adminUID admin \\
  --adminPassword "\${REPL_ADMIN_PASSWORD}" \\
  --hostname oud-node1.example.com \\
  --port 4444 \\
  --trustAll
\`\`\`

Healthy output shows both nodes with 0 Missing Changes for all replication domains (\`dc=example,dc=com\` and optionally the admin backend if also replicated).

---

## Step 5: Start, Stop, Restart

### Manual Commands

\`\`\`bash
# Start OUD
\${OUD_INSTANCE}/OUD/bin/start-ds

# Graceful stop (waits for in-progress operations to complete)
\${OUD_INSTANCE}/OUD/bin/stop-ds

# Restart
\${OUD_INSTANCE}/OUD/bin/stop-ds && \${OUD_INSTANCE}/OUD/bin/start-ds

# Status check (no credentials required for basic status)
\${OUD_INSTANCE}/OUD/bin/status \\
  --bindDN "cn=Directory Manager" \\
  --bindPassword "\${DM_PASSWORD}" \\
  --hostname localhost --port 4444 --trustAll
\`\`\`

### systemd Service (Recommended for Production)

Create \`/etc/systemd/system/oud-instance1.service\`:

\`\`\`ini
[Unit]
Description=Oracle Unified Directory Instance1
After=network.target

[Service]
Type=forking
User=oracle
ExecStart=/u01/oracle/oud_instances/instance1/OUD/bin/start-ds
ExecStop=/u01/oracle/oud_instances/instance1/OUD/bin/stop-ds
PIDFile=/u01/oracle/oud_instances/instance1/OUD/logs/server.pid
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
\`\`\`

\`\`\`bash
systemctl daemon-reload
systemctl enable oud-instance1
systemctl start oud-instance1
systemctl status oud-instance1
\`\`\`

The \`Restart=on-failure\` directive ensures OUD automatically restarts if it crashes. \`RestartSec=30\` prevents rapid restart loops after repeated failures.

---

## Step 6: Common LDAP Operations

### Search — Find a User

\`\`\`bash
ldapsearch -h oud-node1 -p 1389 \\
  -D "cn=Directory Manager" -w "\${DM_PASSWORD}" \\
  -b "ou=People,dc=example,dc=com" \\
  "(uid=jsmith)" \\
  uid cn mail memberOf pwdChangedTime
\`\`\`

### Add a User

\`\`\`bash
ldapadd -h oud-node1 -p 1389 \\
  -D "cn=Directory Manager" -w "\${DM_PASSWORD}" <<'EOF_LDIF'
dn: uid=jsmith,ou=People,dc=example,dc=com
objectClass: inetOrgPerson
objectClass: person
objectClass: organizationalPerson
objectClass: top
uid: jsmith
cn: John Smith
sn: Smith
givenName: John
mail: john.smith@example.com
userPassword: \${INITIAL_PASSWORD}
EOF_LDIF
\`\`\`

### Modify an Attribute

\`\`\`bash
ldapmodify -h oud-node1 -p 1389 \\
  -D "cn=Directory Manager" -w "\${DM_PASSWORD}" <<'EOF_LDIF'
dn: uid=jsmith,ou=People,dc=example,dc=com
changetype: modify
replace: mail
mail: jsmith@example.com
EOF_LDIF
\`\`\`

### Disable an Account (OIG Deprovisioning Pattern)

\`\`\`bash
ldapmodify -h oud-node1 -p 1389 \\
  -D "cn=Directory Manager" -w "\${DM_PASSWORD}" <<'EOF_LDIF'
dn: uid=jsmith,ou=People,dc=example,dc=com
changetype: modify
add: ds-pwp-account-disabled
ds-pwp-account-disabled: TRUE
EOF_LDIF
\`\`\`

This sets the OUD password policy operational attribute that prevents the account from authenticating, without deleting the entry. OIG typically uses this for "disable" operations, reserving \`ldapdelete\` for full deprovision.

### Reset a Password

\`\`\`bash
ldappasswd -h oud-node1 -p 1389 \\
  -D "cn=Directory Manager" -w "\${DM_PASSWORD}" \\
  -s "\${NEW_PASSWORD}" \\
  "uid=jsmith,ou=People,dc=example,dc=com"
\`\`\`

### Unlock a Locked Account

\`\`\`bash
ldapmodify -h oud-node1 -p 1389 \\
  -D "cn=Directory Manager" -w "\${DM_PASSWORD}" <<'EOF_LDIF'
dn: uid=jsmith,ou=People,dc=example,dc=com
changetype: modify
delete: pwdAccountLockedTime
EOF_LDIF
\`\`\`

Removing the \`pwdAccountLockedTime\` operational attribute clears the lockout. This also resets the \`pwdFailureTime\` counter. If the password policy has \`ds-cfg-lockout-duration\` set to a non-zero value, the lock would have auto-cleared after that interval anyway — but for immediate unlock, the manual delete is required.

---

## Step 7: Bulk Import and Export

### Export Backend to LDIF (Backup or Migration)

\`\`\`bash
\${OUD_INSTANCE}/OUD/bin/export-ldif \\
  --backendID userRoot \\
  --ldifFile /backup/oud_export_\$(date +%Y%m%d).ldif \\
  --hostname oud-node1.example.com \\
  --port 4444 \\
  --bindDN "cn=Directory Manager" \\
  --bindPassword "\${DM_PASSWORD}" \\
  --trustAll
\`\`\`

The online export takes a consistent snapshot of the backend without stopping OUD. For very large directories (millions of entries), the export may take 10–30 minutes.

### Offline Import LDIF (Restore or Initial Bulk Load)

Use offline import for large initial data loads — it is significantly faster than online import because it bypasses the LDAP protocol layer.

\`\`\`bash
# Stop OUD first
\${OUD_INSTANCE}/OUD/bin/stop-ds

# Import with --clearBackend to replace all existing data
\${OUD_INSTANCE}/OUD/bin/import-ldif \\
  --backendID userRoot \\
  --ldifFile /backup/oud_export_20260702.ldif \\
  --clearBackend \\
  --trustAll

# Restart OUD
\${OUD_INSTANCE}/OUD/bin/start-ds
\`\`\`

After an offline import, re-initialize replication from this node to the other node (Step 4: Initialize Replication) to ensure the peer is consistent.

### Online Import (No Downtime, Smaller Datasets)

\`\`\`bash
\${OUD_INSTANCE}/OUD/bin/import-ldif \\
  --backendID userRoot \\
  --ldifFile /tmp/new_users.ldif \\
  --append \\
  --hostname oud-node1.example.com \\
  --port 4444 \\
  --bindDN "cn=Directory Manager" \\
  --bindPassword "\${DM_PASSWORD}" \\
  --trustAll
\`\`\`

The \`--append\` flag adds entries without clearing the existing backend. Entries that already exist (duplicate DN) will be skipped with an error. Review the import summary output for any rejected entries.

---

## Step 8: Monitoring

### Current Connections and Throughput

\`\`\`bash
ldapsearch -h oud-node1 -p 1389 \\
  -D "cn=Directory Manager" -w "\${DM_PASSWORD}" \\
  -b "cn=monitor" \\
  "(objectclass=*)" \\
  currentConnections totalConnections operationsCompleted \\
  addOperations bindOperations searchOperations modifyOperations
\`\`\`

### Backend Entry Count and Index Status

\`\`\`bash
ldapsearch -h oud-node1 -p 1389 \\
  -D "cn=Directory Manager" -w "\${DM_PASSWORD}" \\
  -b "cn=userRoot,cn=backends,cn=monitor" \\
  "(objectclass=*)" entryCount indexFiles
\`\`\`

### LDAP Health Check Script

Use this as a Nagios/Icinga check or in a cron-based monitoring loop:

\`\`\`bash
#!/bin/bash
OUD_HOST="oud-node1.example.com"
OUD_PORT=1389
BIND_DN="cn=Directory Manager"
BIND_PW="\${DM_PASSWORD}"

# Test LDAP connectivity with a simple base search
RESULT=\$(ldapsearch -h "\${OUD_HOST}" -p "\${OUD_PORT}" \\
  -D "\${BIND_DN}" -w "\${BIND_PW}" \\
  -b "dc=example,dc=com" -s base \\
  "(objectclass=*)" 2>&1)

if echo "\${RESULT}" | grep -q "dc=example,dc=com"; then
  echo "OK: OUD responding on \${OUD_HOST}:\${OUD_PORT}"
  exit 0
else
  echo "CRITICAL: OUD not responding - \${RESULT}"
  exit 2
fi
\`\`\`

### Replication Lag Alert Script

Run from a monitoring server. Alerts if Missing Changes exceeds 100:

\`\`\`bash
#!/bin/bash
REPL_STATUS=\$(\${OUD_INSTANCE}/OUD/bin/dsreplication status \\
  --adminUID admin --adminPassword "\${REPL_ADMIN_PASSWORD}" \\
  --hostname oud-node1 --port 4444 --trustAll 2>&1)

MISSING=\$(echo "\${REPL_STATUS}" | grep "Missing Changes" | awk '{print \$NF}' | sort -n | tail -1)
if [ "\${MISSING:-0}" -gt 100 ]; then
  echo "WARNING: OUD replication lag - \${MISSING} missing changes"
  exit 1
fi
echo "OK: Replication in sync (\${MISSING} missing changes)"
exit 0
\`\`\`

### Access Log Monitoring

The OUD access log at \`\${OUD_INSTANCE}/OUD/logs/access\` records every LDAP operation with timing. Key patterns to watch:

\`\`\`bash
# Unindexed searches (most common performance problem)
grep "Unindexed" \${OUD_INSTANCE}/OUD/logs/access | tail -20

# Slow operations (> 100ms)
grep "etime=0\\.1" \${OUD_INSTANCE}/OUD/logs/access | tail -20

# Authentication failures
grep "resultCode=49" \${OUD_INSTANCE}/OUD/logs/access | tail -20

# Account locked errors
grep "resultCode=53" \${OUD_INSTANCE}/OUD/logs/access | tail -20
\`\`\`

---

## Step 9: Troubleshooting Table

| Symptom | Diagnosis | Fix |
|---|---|---|
| \`ldapsearch\` returns "Invalid credentials" for service account | Account locked or wrong password | Check \`pwdAccountLockedTime\` attribute; reset password or remove lockout attribute as Directory Manager |
| OAM shows "LDAP bind failed" | OUD down or wrong bind DN/password configured in OAM | Test bind manually with \`ldapsearch\` using same DN/password; verify OAM identity store config in OAM Console |
| Unindexed search warnings in access log | Filter attribute has no equality index | Run \`dsconfig set-backend-index-prop\` to add index, then \`rebuild-index\` online |
| Replication shows large Missing Changes count | Network interruption between nodes or one node crashed | Check \`dsreplication status\`; if diverged beyond repair, run \`dsreplication initialize\` from healthy node |
| OUD fails to start after power loss | BDB JE journal recovery running | Start with \`start-ds --nodetach\` to observe recovery progress in console; check \`logs/errors\` for completion |
| Schema modification rejected "Object class violation" | Entry is missing a required attribute for the new objectClass | Add the required attribute first in a separate \`ldapmodify\`, then add the objectClass |
| Password reset not visible on second node | Replication lag between nodes | Check \`dsreplication status\`; wait for replication or reinitialize if missing changes count is high |
| High memory / OOM kill on OUD process | JVM heap too large, no room for BDB cache or OS | Reduce \`-Xmx\` to 40% of total RAM; set BDB cache to 40% via \`dsjavaproperties\`; leave 20% for OS |
| Slow searches involving large groups (\`member\` attribute) | No index on \`member\` attribute, or group has > index-entry-limit members | Add equality index on \`member\`; raise \`index-entry-limit\` for groups with very large membership |
| TLS handshake failure from OAM or OIG connecting to OUD | OUD certificate expired or CA not trusted by OAM/OIG | Rotate OUD certificate via \`manage-certificates\`; update OAM/OIG trust store with the new CA certificate chain |
| \`dsreplication configure\` fails with "already configured" | Replication was previously configured and not cleanly removed | Run \`dsreplication unconfigure\` to remove existing replication config, then reconfigure |
| Entry not found in search but exists in LDAP browser | Search base DN is incorrect or ACI is blocking visibility for the bind DN | Verify base DN with \`ldapsearch\` as Directory Manager; then test as the application service account to isolate ACI issue |

---

## Step 10: Backup Strategy

### Daily LDIF Export (Cron)

\`\`\`bash
# /etc/cron.d/oud-backup
0 2 * * * oracle \${OUD_INSTANCE}/OUD/bin/export-ldif \\
  --backendID userRoot \\
  --ldifFile /backup/oud/daily/oud_\$(date +\%Y\%m\%d).ldif \\
  --hostname localhost --port 4444 \\
  --bindDN "cn=Directory Manager" \\
  --bindPasswordFile /u01/oracle/oud_instances/.dm_password \\
  --trustAll >> /var/log/oud_backup.log 2>&1

# Retain 30 days of backups
0 3 * * * oracle find /backup/oud/daily -name "*.ldif" -mtime +30 -delete
\`\`\`

Store the Directory Manager password in \`/u01/oracle/oud_instances/.dm_password\` (mode 400, owned by oracle). Never put the password directly in the crontab.

### Config Backup

\`\`\`bash
tar czf /backup/oud/config_\$(date +%Y%m%d).tar.gz \\
  \${OUD_INSTANCE}/OUD/config \\
  \${OUD_INSTANCE}/OUD/db/userRoot
\`\`\`

Include this in the daily cron or run separately. The \`config\` directory contains the \`config.ldif\` file (all \`dsconfig\` settings), schema files, certificates, and password policy definitions. The \`db/userRoot\` directory contains the BDB JE database files — backing this up with a running OUD is safe because BDB JE maintains internal consistency.

### Recovery Procedure

To restore OUD from a daily LDIF backup:

\`\`\`bash
# 1. Stop OUD
\${OUD_INSTANCE}/OUD/bin/stop-ds

# 2. Import the most recent daily backup
\${OUD_INSTANCE}/OUD/bin/import-ldif \\
  --backendID userRoot \\
  --ldifFile /backup/oud/daily/oud_20260702.ldif \\
  --clearBackend \\
  --trustAll

# 3. Start OUD
\${OUD_INSTANCE}/OUD/bin/start-ds

# 4. Re-initialize replication to resync the peer node
\${OUD_INSTANCE}/OUD/bin/dsreplication initialize \\
  --adminUID admin \\
  --adminPassword "\${REPL_ADMIN_PASSWORD}" \\
  --baseDN "dc=example,dc=com" \\
  --hostSource oud-node1.example.com \\
  --portSource 4444 \\
  --hostDestination oud-node2.example.com \\
  --portDestination 4444 \\
  --trustAll --no-prompt
\`\`\`

---

## Quick Reference Card

| Task | Command |
|---|---|
| Start OUD | \`\${OUD_INSTANCE}/OUD/bin/start-ds\` |
| Stop OUD | \`\${OUD_INSTANCE}/OUD/bin/stop-ds\` |
| Check status | \`\${OUD_INSTANCE}/OUD/bin/status --trustAll ...\` |
| Check replication | \`\${OUD_INSTANCE}/OUD/bin/dsreplication status --trustAll ...\` |
| Search for user | \`ldapsearch -h host -p 1389 -D "cn=DM" -w pw -b "ou=People,..." "(uid=jsmith)" uid cn mail\` |
| Reset password | \`ldappasswd -h host -p 1389 -D "cn=DM" -w pw -s newpw "uid=jsmith,..."\` |
| Unlock account | \`ldapmodify\` delete \`pwdAccountLockedTime\` |
| Disable account | \`ldapmodify\` add \`ds-pwp-account-disabled: TRUE\` |
| Add index | \`dsconfig set-backend-index-prop\` then \`rebuild-index\` |
| Export LDIF | \`\${OUD_INSTANCE}/OUD/bin/export-ldif --backendID userRoot ...\` |
| Import LDIF | Stop OUD → \`import-ldif --clearBackend\` → Start OUD |
| Rotate certificate | \`manage-certificates generate-certificate-request\` → CA → \`import-certificate\` → restart |
`,
};

async function main() {
  console.log('Inserting...');
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
