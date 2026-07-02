import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Internet Directory — Installation, Administration, and Troubleshooting',
  slug: 'oracle-internet-directory-runbook',
  excerpt: 'Step-by-step operational runbook for Oracle Internet Directory (OID): RCU schema creation, OID configuration, start/stop/status procedures, LDAP operations, bulk export/import, replication setup, Oracle DB maintenance, DIP sync management, monitoring scripts, backup, and a complete troubleshooting table.',
  category: 'identity-management' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-02'),
  youtubeUrl: null,
  content: `# Runbook: Oracle Internet Directory — Installation, Administration, and Troubleshooting

## Prerequisites

### Hardware Per OID Node (Production)

| Component | Minimum | Recommended |
|---|---|---|
| CPU | 4 cores | 8 cores |
| RAM | 8 GB | 32 GB |
| Storage (\$ORACLE_HOME) | 50 GB | 100 GB |
| Oracle DB tier | 4 cores / 16 GB / 200 GB | Dedicated DB server |

### Software Stack

- Oracle Linux 7/8 or RHEL 7/8
- Oracle Database 12.2+ (19c recommended) — separate install before OID
- Oracle WebLogic Server 12.2.1.4+ (for ODSM and DIP console)
- Oracle Identity Management 11gR2 PS3 or 12c
- JDK 8+ (Oracle JDK)

OID requires a running Oracle Database — create the OID schema using RCU before installing OID.

---

## Step 1: RCU Schema Creation

\`\`\`bash
export ORACLE_HOME=/u01/oracle/middleware/Oracle_Home
export JAVA_HOME=/u01/oracle/jdk8

\${ORACLE_HOME}/oracle_common/bin/rcu \\
  -silent \\
  -createRepository \\
  -databaseType ORACLE \\
  -connectString db-host:1521/orcl \\
  -dbUser sys \\
  -dbRole sysdba \\
  -schemaPrefix OID \\
  -component OID \\
  -component MDS \\
  -component OPSS \\
  -f < /tmp/rcu_passwords.txt
\`\`\`

Post-RCU — verify OID schema tables:

\`\`\`sql
SELECT table_name
FROM dba_tables
WHERE owner = 'OID_OID'
  AND table_name IN ('CT_DN', 'SDUMP', 'ODS_PROCESS_STATUS')
ORDER BY table_name;
\`\`\`

---

## Step 2: OID Configuration

After OID binary installation, run the OID Configuration Wizard:

\`\`\`bash
\${ORACLE_HOME}/bin/config.sh
\`\`\`

Select:
- Configure Oracle Internet Directory
- LDAP Port: 389 (or 3060 for non-root install)
- LDAPS Port: 636 (or 3131 for non-root)
- OID Administrator Password (orcladmin)
- DB Connect String: db-host:1521/orcl
- Schema prefix: OID

---

## Step 3: Start, Stop, Status

**Start OID** (always start Oracle DB first):

\`\`\`bash
# Set environment
export ORACLE_HOME=/u01/oracle/middleware/Oracle_Home
export ORACLE_SID=orcl
export PATH=\${ORACLE_HOME}/bin:\$PATH

# Start OID Monitor (which starts oidldapd and oidrepld)
oidctl connect=orcl server=oidmon start

# Verify
oidctl connect=orcl server=oidmon status
\`\`\`

**Start/stop individual processes**:

\`\`\`bash
# Start LDAP server
oidctl connect=orcl server=oidldapd start

# Stop LDAP server (graceful)
oidctl connect=orcl server=oidldapd stop

# Start replication server
oidctl connect=orcl server=oidrepld start

# Stop all OID processes
oidctl connect=orcl server=oidmon stop
\`\`\`

**Check process status**:

\`\`\`bash
ps -ef | grep -E "oidmon|oidldapd|oidrepld" | grep -v grep
\`\`\`

**Test LDAP connectivity**:

\`\`\`bash
ldapsearch -h oid-host -p 389 \\
  -D "cn=orcladmin" -w "\${ORCLADMIN_PASSWORD}" \\
  -b "" -s base \\
  "(objectclass=*)" namingcontexts
\`\`\`

**Key URLs**:

| URL | Purpose |
|---|---|
| http://wls-host:7001/console | WebLogic Admin Console |
| http://wls-host:7001/odsm | Oracle Directory Services Manager |
| http://wls-host:7001/dip | Directory Integration Platform console |

---

## Step 4: Common LDAP Operations

**Search — find a user**:

\`\`\`bash
ldapsearch -h oid-host -p 389 \\
  -D "cn=orcladmin" -w "\${ORCLADMIN_PASSWORD}" \\
  -b "ou=People,dc=example,dc=com" \\
  "(uid=jsmith)" \\
  uid cn mail orclguid pwdChangedTime
\`\`\`

**Add a user**:

\`\`\`bash
ldapadd -h oid-host -p 389 \\
  -D "cn=orcladmin" -w "\${ORCLADMIN_PASSWORD}" <<'EOF_LDIF'
dn: uid=jsmith,ou=People,dc=example,dc=com
objectClass: inetOrgPerson
objectClass: organizationalPerson
objectClass: person
objectClass: orclUser
objectClass: orclUserV2
objectClass: top
uid: jsmith
cn: John Smith
sn: Smith
givenName: John
mail: john.smith@example.com
userPassword: \${INITIAL_PASSWORD}
EOF_LDIF
\`\`\`

Note: Oracle applications typically require \`orclUser\` and \`orclUserV2\` object classes in addition to standard LDAP classes.

**Modify an attribute**:

\`\`\`bash
ldapmodify -h oid-host -p 389 \\
  -D "cn=orcladmin" -w "\${ORCLADMIN_PASSWORD}" <<'EOF_LDIF'
dn: uid=jsmith,ou=People,dc=example,dc=com
changetype: modify
replace: mail
mail: jsmith-new@example.com
EOF_LDIF
\`\`\`

**Reset a password**:

\`\`\`bash
ldapmodify -h oid-host -p 389 \\
  -D "cn=orcladmin" -w "\${ORCLADMIN_PASSWORD}" <<'EOF_LDIF'
dn: uid=jsmith,ou=People,dc=example,dc=com
changetype: modify
replace: userPassword
userPassword: \${NEW_PASSWORD}
EOF_LDIF
\`\`\`

**Unlock a locked account**:

\`\`\`bash
ldapmodify -h oid-host -p 389 \\
  -D "cn=orcladmin" -w "\${ORCLADMIN_PASSWORD}" <<'EOF_LDIF'
dn: uid=jsmith,ou=People,dc=example,dc=com
changetype: modify
replace: orclpwdaccountunlock
orclpwdaccountunlock: 1
EOF_LDIF
\`\`\`

**Add user to a group**:

\`\`\`bash
ldapmodify -h oid-host -p 389 \\
  -D "cn=orcladmin" -w "\${ORCLADMIN_PASSWORD}" <<'EOF_LDIF'
dn: cn=AppAdmins,ou=Groups,dc=example,dc=com
changetype: modify
add: uniqueMember
uniqueMember: uid=jsmith,ou=People,dc=example,dc=com
EOF_LDIF
\`\`\`

---

## Step 5: Bulk Operations

**Bulk export to LDIF**:

\`\`\`bash
# Online export via ldapsearch (small-medium directories)
ldapsearch -h oid-host -p 389 \\
  -D "cn=orcladmin" -w "\${ORCLADMIN_PASSWORD}" \\
  -b "dc=example,dc=com" \\
  "(objectclass=*)" \\
  > /backup/oid_export_\$(date +%Y%m%d).ldif

# Offline bulk export (large directories — faster, requires OID stop)
bulkexport connect=orcl \\
  ldiffile=/backup/oid_export_\$(date +%Y%m%d).ldif
\`\`\`

**Bulk import from LDIF**:

\`\`\`bash
# Online import (small datasets)
ldapadd -h oid-host -p 389 \\
  -D "cn=orcladmin" -w "\${ORCLADMIN_PASSWORD}" \\
  -f /tmp/new_users.ldif

# Offline bulk import (large datasets — OID must be stopped)
oidctl connect=orcl server=oidldapd stop
bulkload connect=orcl \\
  ldiffile=/tmp/new_users.ldif \\
  check=false
oidctl connect=orcl server=oidldapd start
\`\`\`

---

## Step 6: Replication Configuration

**Configure fan-out (master to shadow) replication**:

On the supplier (master) node:

\`\`\`bash
ldapadd -h oid-host-master -p 389 \\
  -D "cn=orcladmin" -w "\${ORCLADMIN_PASSWORD}" <<'EOF_LDIF'
dn: orclreplicaid=shadow1_agreement,cn=replication,cn=OracleContext
objectClass: orclReplicationAgreement
objectClass: top
orclreplicaid: shadow1_agreement
orclsupplierurl: ldap://oid-host-master:389
orclconsumerurl: ldap://oid-host-shadow:389
orclreplicadn: dc=example,dc=com
orclreplicatype: 1
orclreplicationmode: 1
orclnamingattrname: uid
orclhostname: oid-host-master
orclport: 389
EOF_LDIF
\`\`\`

Start replication:

\`\`\`bash
oidctl connect=orcl server=oidrepld start
\`\`\`

**Check replication health via SQL**:

\`\`\`sql
-- In the Oracle DB (ODS schema)
SELECT r.agreement_name,
       r.supplier_dn,
       r.consumer_dn,
       r.last_applied_csn,
       r.last_generated_csn,
       (r.last_generated_csn - r.last_applied_csn) AS pending_changes,
       r.last_replication_time
FROM ods.orclcatchangelog_status r
ORDER BY pending_changes DESC;
\`\`\`

Healthy state: pending_changes = 0 or a small, stable number. A growing pending_changes count indicates the consumer is falling behind.

---

## Step 7: Database Maintenance for OID

Because OID uses Oracle Database as its backend, standard Oracle DB maintenance applies:

**Gather statistics on OID schema tables**:

\`\`\`sql
EXEC DBMS_STATS.GATHER_SCHEMA_STATS('ODS', cascade=>TRUE);
\`\`\`

**Check OID tablespace usage**:

\`\`\`sql
SELECT tablespace_name,
       ROUND(used_space * 8192 / 1073741824, 2) AS used_gb,
       ROUND(tablespace_size * 8192 / 1073741824, 2) AS total_gb,
       ROUND(used_percent, 1) AS pct_used
FROM dba_tablespace_usage_metrics
WHERE tablespace_name LIKE 'ODS%'
   OR tablespace_name LIKE 'OID%'
ORDER BY pct_used DESC;
\`\`\`

**Check for long-running OID SQL** (during performance issues):

\`\`\`sql
SELECT s.sql_id,
       ROUND(s.elapsed_time / 1000000, 2) AS elapsed_sec,
       s.executions,
       ROUND(s.elapsed_time / NULLIF(s.executions, 0) / 1000000, 4) AS avg_sec,
       s.sql_text
FROM v\$sql s
WHERE s.parsing_schema_name = 'ODS'
  AND s.elapsed_time / NULLIF(s.executions, 0) > 1000000
ORDER BY avg_sec DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

**Purge old changelog entries** (critical — changelog table grows unbounded without purging):

\`\`\`sql
-- Remove changelog entries older than 30 days
DELETE FROM ods.orclcatchangelog
WHERE changedate < SYSDATE - 30;
COMMIT;
\`\`\`

Schedule this as a weekly Oracle job or add it to a cron-triggered script.

---

## Step 8: DIP (Directory Integration Platform) Operations

**Start/stop DIP**:

\`\`\`bash
# Via WLST
\${ORACLE_HOME}/oracle_common/common/bin/wlst.sh <<'EOF'
connect('weblogic','password','t3://wls-host:7001')
start('dipserver','Application')
EOF
\`\`\`

**Run a DIP sync profile manually**:

\`\`\`bash
manageSyncProfiles syncNow \\
  -h oid-host -p 389 \\
  -D "cn=orcladmin" -w "\${ORCLADMIN_PASSWORD}" \\
  -profile "AD_Import_Profile"
\`\`\`

**Check DIP sync errors**:

\`\`\`bash
manageSyncProfiles getReport \\
  -h oid-host -p 389 \\
  -D "cn=orcladmin" -w "\${ORCLADMIN_PASSWORD}" \\
  -profile "AD_Import_Profile" \\
  -reportType error
\`\`\`

**DIP log location**: \`\${ORACLE_HOME}/ldap/log/odisrv.log\` (or under the WLS domain logs for 12c DIP)

---

## Step 9: Monitoring Script

\`\`\`bash
#!/bin/bash
# OID health check
OID_HOST="oid-host.example.com"
OID_PORT=389
BIND_DN="cn=orcladmin"
BIND_PW="\${ORCLADMIN_PASSWORD}"

# Test LDAP connectivity
RESULT=\$(ldapsearch -h "\${OID_HOST}" -p "\${OID_PORT}" \\
  -D "\${BIND_DN}" -w "\${BIND_PW}" \\
  -b "" -s base "(objectclass=*)" namingcontexts 2>&1)

if echo "\${RESULT}" | grep -q "namingcontexts"; then
  echo "OK: OID LDAP responding on \${OID_HOST}:\${OID_PORT}"
else
  echo "CRITICAL: OID not responding - \${RESULT}"
  exit 2
fi

# Check oidldapd process
if ! pgrep -x oidldapd > /dev/null; then
  echo "CRITICAL: oidldapd process not running"
  exit 2
fi

# Check replication lag via SQL (requires sqlplus)
LAG=\$(sqlplus -s / as sysdba <<'EOF' 2>/dev/null
SET HEADING OFF FEEDBACK OFF PAGESIZE 0
SELECT MAX(last_generated_csn - last_applied_csn)
FROM ods.orclcatchangelog_status;
EXIT;
EOF
)
LAG=\$(echo "\${LAG}" | tr -d ' ')
if [ -n "\${LAG}" ] && [ "\${LAG}" -gt 1000 ]; then
  echo "WARNING: Replication lag = \${LAG} pending changes"
  exit 1
fi

echo "OK: OID healthy, replication lag = \${LAG:-0} changes"
exit 0
\`\`\`

---

## Step 10: Backup and Recovery

**OID backup = Oracle Database backup** (the most important distinction from other LDAP servers):

\`\`\`bash
# RMAN backup of OID DB (run as oracle OS user)
rman target / <<'EOF'
BACKUP DATABASE PLUS ARCHIVELOG DELETE INPUT;
EOF
\`\`\`

**Supplementary LDIF backup** (logical backup, independent of RMAN):

\`\`\`bash
ldapsearch -h oid-host -p 389 \\
  -D "cn=orcladmin" -w "\${ORCLADMIN_PASSWORD}" \\
  -b "dc=example,dc=com" \\
  "(objectclass=*)" \\
  > /backup/oid/ldif/oid_\$(date +%Y%m%d_%H%M).ldif

gzip /backup/oid/ldif/oid_\$(date +%Y%m%d_%H%M).ldif
find /backup/oid/ldif -name "*.ldif.gz" -mtime +30 -delete
\`\`\`

**Recovery from RMAN backup**:

1. Restore Oracle DB from RMAN backup on the OID host
2. Start Oracle DB, verify ODS tables are intact
3. Start oidmon → oidldapd
4. Test LDAP connectivity
5. If replication exists, re-initialize shadow nodes from the restored master

---

## Step 11: Troubleshooting Table

| Symptom | Diagnosis | Fix |
|---|---|---|
| "Can't contact LDAP server" | oidldapd not running | \`oidctl connect=orcl server=oidldapd start\` |
| OID starts then immediately stops | Oracle DB unreachable or ODS schema corrupt | Check \`oidmon.log\`; verify Oracle DB is up and ODS schema accessible |
| "Invalid credentials" for orcladmin | orcladmin password forgotten or expired | Reset via \`oidpasswd connect=orcl\` |
| Slow LDAP searches | Unindexed attribute or OID DB stats stale | Run \`ldapsearch -b ... -E pr=1000/noreferal\` to check; gather DB stats on ODS |
| Replication stopped — changelog gap | oidrepld crashed mid-replication | Restart oidrepld; if gap too large, re-initialize shadow from master |
| DIP sync profile failing | AD connectivity or schema mapping error | Check odisrv.log; test AD bind manually; review attribute mapping in DIP console |
| ODSM shows "OID unavailable" | ODSM WLS app cannot reach OID LDAP port | Verify firewall; test \`ldapsearch\` from WLS host to OID host |
| High CPU on Oracle DB from OID | Heavy unindexed search or missing cursor sharing | Enable cursor_sharing=FORCE; gather ODS stats; check AWR for top ODS SQL |
| LDAP modify rejected "Object class violation" | orclUser / orclUserV2 not added to new entries | Add required Oracle object classes to the LDIF before importing |
| orclcatchangelog table filling tablespace | Changelog purge job not running | Run DELETE from ods.orclcatchangelog WHERE changedate < SYSDATE - 30 |
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
