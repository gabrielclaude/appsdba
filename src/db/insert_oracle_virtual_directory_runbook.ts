import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Virtual Directory — Installation, Adapter Configuration, and Troubleshooting',
  slug: 'oracle-virtual-directory-runbook',
  excerpt:
    'Step-by-step operational runbook for Oracle Virtual Directory (OVD): installation, LDAP adapter (Active Directory), Database adapter (HR system), Join View adapter, caching plug-in, OAM identity store integration, log analysis, monitoring script, troubleshooting table, and backup procedures.',
  category: 'identity-management' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-02'),
  youtubeUrl: null,
  content: `## Overview

This runbook covers the end-to-end operational lifecycle of Oracle Virtual Directory (OVD): installation, instance creation, adapter configuration (LDAP, Database, Join View), plug-in configuration, OAM integration, log analysis, monitoring, and troubleshooting. All commands assume Oracle Linux 7/8 or RHEL 7/8, user \`oracle\`, and OVD 11gR2 PS3 (11.1.2.3).

---

## Prerequisites

### Hardware per OVD Node

| Resource | Minimum | Recommended |
|---|---|---|
| CPU | 4 cores | 8 cores |
| RAM | 8 GB | 16 GB |
| JVM heap | 2 GB | 4–8 GB |
| Storage | 20 GB | 50 GB |

### Software Requirements

- Oracle Linux 7/8 or RHEL 7/8
- JDK 8 or JDK 11 (Oracle JDK)
- Oracle Virtual Directory 11gR2 PS3 (11.1.2.3) — current supported release
- Network access from OVD host to: backend AD DC (port 636), backend OID/OUD (port 1636/1389), Oracle DB (port 1521)
- OVD Manager (GUI) available as a standalone tool or via ODSM on WebLogic

No Oracle Database is required on the OVD server itself — OVD is a standalone Java process.

### Port Summary

| Port | Protocol | Purpose |
|---|---|---|
| 6389 | LDAP | Client LDAP connections (plaintext) |
| 6636 | LDAPS | Client LDAP connections (TLS) |
| 8080 | HTTP | OVD admin / REST interface |
| 8899 | HTTPS | OVD Manager admin connection |
| 8900 | HTTPS | OVD Manager admin connection (SSL) |

---

## Step 1: OVD Installation

\`\`\`bash
export JAVA_HOME=/u01/oracle/jdk8
export OVD_HOME=/u01/oracle/ovd
export OVD_INSTANCE=/u01/oracle/ovd_instances/instance1

# Silent install
java -jar /tmp/ovd_install.jar \\
  -silent \\
  -response /tmp/ovd_install.rsp \\
  ORACLE_HOME=\${OVD_HOME} \\
  JAVA_HOME=\${JAVA_HOME}
\`\`\`

Create OVD instance:

\`\`\`bash
\${OVD_HOME}/ovd/bin/config.sh \\
  -instance \${OVD_INSTANCE} \\
  -port 6389 \\
  -sslport 6636 \\
  -httpport 8080 \\
  -adminport 8899 \\
  -adminssl 8900 \\
  -hostname ovd-host.example.com \\
  -adminPassword "\${OVD_ADMIN_PASSWORD}"
\`\`\`

Verify installation:

\`\`\`bash
ls \${OVD_INSTANCE}/
# Should show: OVD/ config/ logs/ stores/
\`\`\`

The instance directory contains the entire runtime state of OVD: configuration files, keystores, local store data, and log files. The OVD_HOME directory contains the software binaries shared across all instances on the host. Multiple OVD instances can be configured on the same host using different ports — useful for separating development, test, and production environments.

---

## Step 2: Start, Stop, Status

\`\`\`bash
# Start OVD instance
\${OVD_INSTANCE}/OVD/bin/start.sh

# Stop OVD instance (graceful)
\${OVD_INSTANCE}/OVD/bin/stop.sh

# Check status
\${OVD_INSTANCE}/OVD/bin/status.sh

# Test LDAP listener is up
ldapsearch -h ovd-host -p 6389 \\
  -D "cn=orcladmin" -w "\${OVD_ADMIN_PASSWORD}" \\
  -b "" -s base "(objectclass=*)" namingcontexts
\`\`\`

The base DSE (\`-b "" -s base\`) query is the canonical health check for any LDAP server — it returns the server's naming contexts (root suffixes). A successful response confirms the LDAP listener is up and OVD is ready to serve requests. If this query times out, OVD is either not started or the LDAP listener port is blocked.

### systemd Service

\`\`\`ini
[Unit]
Description=Oracle Virtual Directory Instance1
After=network.target

[Service]
Type=forking
User=oracle
ExecStart=/u01/oracle/ovd_instances/instance1/OVD/bin/start.sh
ExecStop=/u01/oracle/ovd_instances/instance1/OVD/bin/stop.sh
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
\`\`\`

Save to \`/etc/systemd/system/ovd-instance1.service\`, then:

\`\`\`bash
systemctl daemon-reload
systemctl enable ovd-instance1
systemctl start ovd-instance1
systemctl status ovd-instance1
\`\`\`

---

## Step 3: Configure an LDAP Adapter (Active Directory)

Use OVD Manager (GUI) or the command-line \`ovdconfig\` tool.

### Via OVD Manager

1. Open OVD Manager: \`\${OVD_HOME}/ovd/bin/ovdmanager.sh\` (or connect via ODSM)
2. Connect to OVD Admin port: ovd-host:8899 as orcladmin
3. Adapters → New → LDAP Adapter
4. Fill in:
   - Adapter Name: \`AD_Users\`
   - Remote Host: \`ad-dc01.example.com\`
   - Remote Port: \`636\`
   - Use SSL: \`Yes\`
   - Remote Base DN: \`CN=Users,DC=example,DC=com\`
   - Local Base DN: \`ou=People,dc=example,dc=com\`
   - Bind DN: \`CN=svc-ovd,OU=ServiceAccounts,DC=example,DC=com\`
   - Bind Password: [enter and store securely]
5. Add attribute mappings:
   - \`sAMAccountName\` → \`uid\`
   - \`displayName\` → \`cn\`
6. Test Connection → Save

### Import AD Domain Controller SSL Certificate

\`\`\`bash
keytool -importcert \\
  -alias ad-dc01 \\
  -file /tmp/ad-dc01-cert.pem \\
  -keystore \${OVD_INSTANCE}/OVD/config/keystores/adapters.jks \\
  -storepass \${KEYSTORE_PASSWORD} \\
  -noprompt
\`\`\`

Restart OVD after importing the certificate:

\`\`\`bash
\${OVD_INSTANCE}/OVD/bin/stop.sh && \${OVD_INSTANCE}/OVD/bin/start.sh
\`\`\`

Verify the adapter works:

\`\`\`bash
ldapsearch -h ovd-host -p 6389 \\
  -D "cn=orcladmin" -w "\${OVD_ADMIN_PASSWORD}" \\
  -b "ou=People,dc=example,dc=com" \\
  "(uid=jsmith)" uid cn mail
\`\`\`

A successful result shows the user's \`uid\`, \`cn\` (mapped from AD's \`displayName\`), and \`mail\` returned as LDAP attributes — even though the data lives in Active Directory and OVD translated the AD attribute names.

---

## Step 4: Configure a Database Adapter (HR System)

1. OVD Manager → Adapters → New → Database Adapter
2. Fill in:
   - Adapter Name: \`HR_Employees\`
   - JDBC Driver: \`oracle.jdbc.OracleDriver\`
   - JDBC URL: \`jdbc:oracle:thin:@hr-db:1521/hrprod\`
   - DB Username: \`ovd_read\`
   - DB Password: [enter]
   - DB Table/View: \`HR.EMPLOYEES\` (or use custom SQL)
   - Custom SQL Query:

\`\`\`sql
SELECT employee_id, first_name, last_name, department_name,
       cost_center, email, job_title
FROM hr.employees e
JOIN hr.departments d ON e.department_id = d.department_id
WHERE e.status = 'ACTIVE'
\`\`\`

   - RDN Attribute (LDAP): \`uid\`
   - RDN Column (DB): \`employee_id\`
   - Local Base DN: \`ou=HREmployees,dc=example,dc=com\`
3. Add column-to-attribute mappings:
   - \`employee_id\` → \`uid\`
   - \`first_name\` → \`givenName\`
   - \`last_name\` → \`sn\`
   - \`department_name\` → \`departmentNumber\`
   - \`email\` → \`mail\`
   - \`job_title\` → \`title\`

### Create Read-Only DB Account for OVD

\`\`\`sql
CREATE USER ovd_read IDENTIFIED BY "\${OVD_READ_PASSWORD}";
GRANT CREATE SESSION TO ovd_read;
GRANT SELECT ON hr.employees TO ovd_read;
GRANT SELECT ON hr.departments TO ovd_read;
\`\`\`

Verify the adapter:

\`\`\`bash
ldapsearch -h ovd-host -p 6389 \\
  -D "cn=orcladmin" -w "\${OVD_ADMIN_PASSWORD}" \\
  -b "ou=HREmployees,dc=example,dc=com" \\
  "(uid=12345)" uid givenName sn departmentNumber mail
\`\`\`

Expected: the SQL row for employee 12345 returned as an LDAP entry with mapped attribute names. If the query returns nothing, verify the JDBC URL, that the \`ovd_read\` account can connect, and that employee 12345 has status = 'ACTIVE' in the HR database.

---

## Step 5: Configure a Join View Adapter

1. OVD Manager → Adapters → New → Join View Adapter
2. Fill in:
   - Adapter Name: \`Unified_Users\`
   - Local Base DN: \`ou=UnifiedUsers,dc=example,dc=com\`
3. Add primary source: \`AD_Users\` adapter (contains authentication attributes)
4. Add secondary source: \`HR_Employees\` adapter (contains HR attributes)
5. Join configuration:
   - Join Type: Left Outer (return AD entry even if no HR match)
   - Join Attribute — Primary: \`mail\`
   - Join Attribute — Secondary: \`mail\`
6. Save and restart OVD

Verify the join works — the result should contain attributes from both AD and HR:

\`\`\`bash
ldapsearch -h ovd-host -p 6389 \\
  -D "cn=orcladmin" -w "\${OVD_ADMIN_PASSWORD}" \\
  -b "ou=UnifiedUsers,dc=example,dc=com" \\
  "(uid=jsmith)" \\
  uid cn mail departmentNumber title givenName sn
\`\`\`

Expected result: single entry with \`uid\` and \`cn\` (from AD) + \`departmentNumber\` and \`title\` (from HR database).

If the join returns only the primary (AD) attributes and the secondary (HR) attributes are absent, the join key is not matching. Confirm by running the same search against \`ou=People,dc=example,dc=com\` (AD adapter) and \`ou=HREmployees,dc=example,dc=com\` (DB adapter) individually and comparing the \`mail\` values character-by-character.

---

## Step 6: Configure the Caching Plug-in

1. OVD Manager → Plug-ins → New → Caching Plug-in
2. Apply to: all adapters or specific adapter
3. Settings:
   - Cache TTL: \`300\` (seconds — 5 minutes for frequently queried, stable data)
   - Max Cache Entries: \`50000\`
   - Cache Groups: \`true\` (cache group membership searches)
4. Save and restart OVD

### Flush Cache Manually

When user data changes require immediate refresh (e.g., a terminated employee's account must be disabled immediately):

\`\`\`bash
# OVD provides a JMX endpoint for cache management
# Connect via JConsole to ovd-host:PORT (check ovd.properties for JMX port)
# MBean: oracle.ods.virtualserver:type=Cache
# Operation: flushAll()

# Alternatively, restart OVD to flush all caches:
\${OVD_INSTANCE}/OVD/bin/stop.sh && \${OVD_INSTANCE}/OVD/bin/start.sh
\`\`\`

Cache sizing guidance: \`maxentries × 3 KB ≈ heap consumed\`. For 50,000 entries, budget approximately 150 MB of JVM heap for the cache. If OVD's JVM heap is 4 GB, a 50,000-entry cache consumes under 4% of heap — well within safe limits.

---

## Step 7: Configure OAM to Use OVD as Identity Store

In OAM Admin Console (http://oam-host:14100/oamconsole):

1. System Configuration → Data Sources → User Identity Stores → Create
2. Fill in:
   - Store Type: OVD / Generic LDAP
   - Host: ovd-host.example.com
   - Port: 6389 (or 6636 for LDAPS)
   - Bind DN: \`cn=oam-svc,ou=ServiceAccounts,dc=example,dc=com\`
   - User Search Base: \`ou=UnifiedUsers,dc=example,dc=com\`
   - User Name Attribute: \`uid\`
3. Test connection → Save
4. Set as System Store

### Create OAM Service Account in OVD Local Store

\`\`\`bash
ldapadd -h ovd-host -p 6389 \\
  -D "cn=orcladmin" -w "\${OVD_ADMIN_PASSWORD}" <<'EOF_LDIF'
dn: cn=oam-svc,ou=ServiceAccounts,dc=example,dc=com
objectClass: inetOrgPerson
objectClass: person
objectClass: top
cn: oam-svc
sn: oam-svc
uid: oam-svc
userPassword: \${OAM_SVC_PASSWORD}
EOF_LDIF
\`\`\`

The OAM service account is stored in OVD's Local Store adapter (not in AD or the HR database). The Local Store adapter handles entries that do not belong to any backend — service accounts, groups that span multiple directories, and organizational unit entries that define the virtual namespace structure. Verify the account was created:

\`\`\`bash
ldapsearch -h ovd-host -p 6389 \\
  -D "cn=orcladmin" -w "\${OVD_ADMIN_PASSWORD}" \\
  -b "ou=ServiceAccounts,dc=example,dc=com" \\
  "(cn=oam-svc)" cn uid
\`\`\`

---

## Step 8: OVD Log Analysis

### Log Files

| File | Purpose |
|---|---|
| \${OVD_INSTANCE}/OVD/logs/ovd.log | Main OVD application log |
| \${OVD_INSTANCE}/OVD/logs/access.log | LDAP access log (all operations) |
| \${OVD_INSTANCE}/OVD/logs/server.log | JVM startup and fatal errors |

### Enable Debug Logging

Use temporarily; disable in production (debug logging generates very large log files and adds latency):

Edit \`\${OVD_INSTANCE}/OVD/config/log.xml\`:

\`\`\`xml
<logger name="oracle.ods.virtualserver" level="FINE"/>
<logger name="oracle.ods.adapter.ldap" level="FINE"/>
<logger name="oracle.ods.adapter.db" level="FINE"/>
\`\`\`

Restart OVD after changing log levels.

### Common Log Patterns

\`\`\`bash
# Find authentication failures
grep -i "invalid credentials\\|bind failed" \${OVD_INSTANCE}/OVD/logs/access.log | tail -20

# Find adapter connection errors
grep -i "connection refused\\|adapter error" \${OVD_INSTANCE}/OVD/logs/ovd.log | tail -20

# Find slow operations (> 1 second elapsed time)
grep "elapsed=[0-9]\\{4,\\}" \${OVD_INSTANCE}/OVD/logs/access.log | tail -20
\`\`\`

The access log records every LDAP operation: bind, search, modify, add, delete. Each line includes the operation type, bind DN, base DN, filter, result code, and elapsed time in milliseconds. For authentication troubleshooting, filter for \`BIND\` operations with result code \`49\` (invalidCredentials) to find failed logins.

---

## Step 9: Monitoring Script

\`\`\`bash
#!/bin/bash
OVD_HOST="ovd-host.example.com"
OVD_PORT=6389
ADMIN_DN="cn=orcladmin"
ADMIN_PW="\${OVD_ADMIN_PASSWORD}"

# Test LDAP listener
RESULT=\$(ldapsearch -h "\${OVD_HOST}" -p "\${OVD_PORT}" \\
  -D "\${ADMIN_DN}" -w "\${ADMIN_PW}" \\
  -b "" -s base "(objectclass=*)" namingcontexts 2>&1)

if ! echo "\${RESULT}" | grep -q "namingcontexts"; then
  echo "CRITICAL: OVD LDAP listener not responding"
  exit 2
fi

# Test AD adapter (search for a known user)
AD_TEST=\$(ldapsearch -h "\${OVD_HOST}" -p "\${OVD_PORT}" \\
  -D "\${ADMIN_DN}" -w "\${ADMIN_PW}" \\
  -b "ou=People,dc=example,dc=com" \\
  "(uid=svc-health-check)" uid 2>&1)

if echo "\${AD_TEST}" | grep -q "No such object\\|Can't contact"; then
  echo "WARNING: OVD AD adapter not returning results"
  exit 1
fi

# Test DB adapter
DB_TEST=\$(ldapsearch -h "\${OVD_HOST}" -p "\${OVD_PORT}" \\
  -D "\${ADMIN_DN}" -w "\${ADMIN_PW}" \\
  -b "ou=HREmployees,dc=example,dc=com" -s base \\
  "(objectclass=*)" 2>&1)

if echo "\${DB_TEST}" | grep -q "Can't contact\\|error"; then
  echo "WARNING: OVD DB adapter not responding"
  exit 1
fi

echo "OK: OVD healthy - LDAP listener up, AD and DB adapters responding"
exit 0
\`\`\`

Deploy this script as a Nagios/NRPE check or Oracle Enterprise Manager 13c custom metric. The health-check user (\`svc-health-check\`) should be a real, low-privilege AD account whose existence is guaranteed — using a service account that will never be deleted. If the account is returned by the AD adapter search, the adapter is live and routing correctly.

---

## Step 10: Troubleshooting Table

| Symptom | Diagnosis | Fix |
|---|---|---|
| ldapsearch returns "No such object" | Virtual namespace not mapped correctly | Check adapter local base DN matches the search base |
| Join View returns only primary attributes | Join key mismatch between primary and secondary | Verify join attribute values match in both sources (case, format) |
| AD bind succeeds but search returns empty | OVD service account lacks read permission on AD OU | Grant read access on the AD OU to the OVD bind account |
| DB adapter returns "Connection refused" | Oracle DB down or JDBC URL wrong | Test JDBC connection independently; check DB host/port/SID |
| DB adapter entries missing attributes | Column name mapping incorrect | Verify column names in SQL match the adapter column mappings |
| OVD returns stale user data | Caching plug-in TTL too long | Reduce cache TTL; flush cache via OVD Manager |
| OVD starts but no LDAP response | Port 6389 blocked by firewall | Test \`telnet ovd-host 6389\`; open firewall rule |
| "SSL handshake failed" connecting to AD | AD DC cert not in OVD trust store | Import AD DC certificate into adapters.jks; restart OVD |
| High JVM memory / OOM | Cache too large or leak in Join View | Reduce max cache entries; increase JVM heap in \`ovd.properties\` |
| OVD Manager cannot connect to admin port | OVD not started or admin port 8899 blocked | Check OVD process (\`ps -ef | grep ovd\`); verify port is listening |

### Additional Diagnostic Commands

\`\`\`bash
# Check OVD process is running
ps -ef | grep -i ovd | grep -v grep

# Verify all OVD ports are listening
ss -tlnp | grep -E "6389|6636|8080|8899|8900"

# Test direct LDAPS connectivity to AD (bypass OVD)
ldapsearch -h ad-dc01.example.com -p 636 -Z \\
  -D "CN=svc-ovd,OU=ServiceAccounts,DC=example,DC=com" \\
  -w "\${OVD_BIND_PASSWORD}" \\
  -b "CN=Users,DC=example,DC=com" \\
  "(sAMAccountName=jsmith)" sAMAccountName displayName mail

# Test JDBC connectivity to HR database (using sqlplus as oracle user)
sqlplus ovd_read/"\${OVD_READ_PASSWORD}"@hr-db:1521/hrprod \\
  <<< "SELECT COUNT(*) FROM hr.employees WHERE status = 'ACTIVE';"
\`\`\`

---

## Step 11: Backup

### Backup OVD Instance Configuration

OVD's configuration is entirely file-based — there is no metadata repository or database. Back up the instance directory:

\`\`\`bash
# OVD config is file-based — just tar the instance directory
tar czf /backup/ovd/ovd_instance_\$(date +%Y%m%d).tar.gz \\
  /u01/oracle/ovd_instances/instance1/OVD/config

# Also backup the keystore separately (contains SSL certs and adapter passwords)
cp \${OVD_INSTANCE}/OVD/config/keystores/adapters.jks \\
  /backup/ovd/adapters_\$(date +%Y%m%d).jks
\`\`\`

### Backup Schedule

| Backup | Frequency | Retention |
|---|---|---|
| Full instance config | Daily | 30 days |
| Keystore | After any cert change | 90 days |
| Pre-change snapshot | Before any config change | Until next change is verified stable |

### Recovery Procedure

1. Stop OVD: \`\${OVD_INSTANCE}/OVD/bin/stop.sh\`
2. Extract config backup: \`tar xzf /backup/ovd/ovd_instance_YYYYMMDD.tar.gz -C /\`
3. Restore keystore: \`cp /backup/ovd/adapters_YYYYMMDD.jks \${OVD_INSTANCE}/OVD/config/keystores/adapters.jks\`
4. Start OVD: \`\${OVD_INSTANCE}/OVD/bin/start.sh\`
5. Run health check: \`ldapsearch -h ovd-host -p 6389 -D "cn=orcladmin" -w "\${OVD_ADMIN_PASSWORD}" -b "" -s base "(objectclass=*)" namingcontexts\`

Since OVD holds no authoritative data (all identity data lives in AD, OID, and the HR database), recovery only requires restoring the configuration — not the data. The adapters reconnect to their backends on startup and immediately begin serving requests. Total RTO for an OVD instance restore from backup is typically under 10 minutes.

---

## Quick Reference

\`\`\`
Key directories:
  OVD binaries:   /u01/oracle/ovd/
  OVD instance:   /u01/oracle/ovd_instances/instance1/OVD/
  Config:         .../OVD/config/
  Logs:           .../OVD/logs/
  Keystores:      .../OVD/config/keystores/
  Local store:    .../OVD/stores/

Key ports:
  LDAP:  6389
  LDAPS: 6636
  HTTP:  8080
  Admin: 8899 / 8900

Key files:
  ovd.properties      — JVM and worker thread settings
  log.xml             — logging levels
  adapters.jks        — SSL keystore for adapter connections
  server.cer          — OVD's own server certificate
\`\`\`
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
