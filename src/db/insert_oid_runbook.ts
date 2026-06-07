import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Internet Directory (OID) 12c Installation, DIT Configuration, and Replication',
  slug: 'oracle-internet-directory-oid-administration-runbook',
  excerpt:
    'Step-by-step runbook for installing Oracle Internet Directory (OID) 12c on Linux: RCU schema creation, OID instance startup, DIT population with LDIF, fan-out replication setup, OAM identity store integration, account management commands, and an OID health monitoring script with crontab scheduling.',
  category: 'identity-management' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-07'),
  youtubeUrl: null,
  content: `## Overview

This runbook installs Oracle Internet Directory (OID) 12c (12.2.1.4) on Oracle Linux 8 / RHEL 8, creates the ODS repository schema in Oracle Database 19c, populates the Directory Information Tree (DIT) with user and group entries, configures fan-out replication to a second OID node, and integrates OID as the identity store for Oracle Access Manager.

**Prerequisites**
- Oracle Linux 8 / RHEL 8, minimum 4 cores, 8 GB RAM, 100 GB disk (per OID node)
- Oracle Database 19c running and accessible (for ODS schema)
- Oracle Fusion Middleware 12.2.1.4 installed at \`\${MW_HOME}\`
- ldap-utils (ldapsearch, ldapadd, ldapmodify) available
- sudo / oracle OS user access

---

## Phase 1: Pre-Installation and RCU

\`\`\`bash
# Set environment
export ORACLE_BASE=/u01/app/oracle
export MW_HOME=\${ORACLE_BASE}/middleware
export ORACLE_HOME=\${MW_HOME}/oid
export DOMAIN_HOME=\${ORACLE_BASE}/user_projects/domains/OIDDomain
export JAVA_HOME=/usr/java/jdk
export PATH=\${ORACLE_HOME}/bin:\${JAVA_HOME}/bin:\${PATH}

# Required OS packages
dnf install -y libaio openldap-clients unzip bc

# Verify Oracle Database connectivity (ODS repository)
sqlplus -L sys/<password>@oiddb:1521/OIDDB as sysdba <<'SQL_EOF'
SELECT instance_name, status FROM v\$instance;
SELECT tablespace_name, bytes/1024/1024 AS mb_free
FROM dba_free_space
ORDER BY 1;
SQL_EOF

# Run RCU to create OID schemas (ODS + MDS + OPSS)
\${MW_HOME}/oracle_common/bin/rcu \
  -silent \
  -createRepository \
  -connectString oiddb:1521:OIDDB \
  -dbUser sys \
  -dbRole sysdba \
  -schemaPrefix OID \
  -component MDS \
  -component OPSS \
  -component IAU \
  -component STB \
  -component OID \
  -f < /tmp/rcu_pass.txt 2>&1 | tee /tmp/rcu_oid.log

# Verify ODS schema created
sqlplus -s sys/<password>@oiddb:1521/OIDDB as sysdba <<'SQL_EOF'
SELECT username, account_status, created
FROM dba_users WHERE username LIKE 'OID_%' ORDER BY username;
SELECT segment_name, bytes/1024/1024 AS mb
FROM dba_segments WHERE owner = 'OID_ODS' ORDER BY bytes DESC FETCH FIRST 10 ROWS ONLY;
SQL_EOF

echo "RCU complete"
\`\`\`

---

## Phase 2: Install OID Binaries and Configure Instance

\`\`\`bash
# Install OID (included in Oracle IDM / Fusion Middleware IDM installer)
cd /tmp/oid_installer
java -jar fmw_12.2.1.4.0_idm.jar -silent \
  -responseFile /tmp/oid_install.rsp \
  -jreLoc \${JAVA_HOME} 2>&1 | tee /tmp/oid_install.log

# Create OID WebLogic domain (OID uses WLS for admin console)
\${MW_HOME}/oracle_common/common/bin/config.sh -silent \
  -responseFile /tmp/oid_domain.rsp 2>&1 | tee /tmp/oid_domain.log

# The domain includes WebLogic Admin Server + OID server instance
# DataSource: OID_ODS schema (Oracle Database)

# Start Node Manager
nohup \${DOMAIN_HOME}/bin/startNodeManager.sh &
sleep 20

# Start Admin Server
nohup \${DOMAIN_HOME}/startWebLogic.sh &
sleep 60

# Verify Admin Server
curl -s http://oid-host:7001/console | grep -c "weblogic"
echo "Admin Server running"
\`\`\`

---

## Phase 3: Create and Start OID Server Instance

\`\`\`bash
# Create OID component instance
\${ORACLE_HOME}/bin/opmnctl createcomponent \
  -componentType OID \
  -componentName oid1 \
  -adminHost oid-host \
  -adminPort 7001 \
  -adminUsername weblogic \
  -adminPassword <admin_password> \
  -Port 389 \
  -SSLPort 636 \
  -dsport 1521 \
  -dbhost oiddb \
  -databaseService OIDDB \
  -replicationDN "cn=replication dn,orclreplicaid=oid1,cn=replication configuration" 2>&1

# Start OPMN and OID
\${ORACLE_HOME}/bin/opmnctl startall
sleep 30

# Check OID status
\${ORACLE_HOME}/bin/opmnctl status

# Expected output includes:
# Processes in Instance: oid1
# ias-component | process-type | pid | status
# oid1          | OID          | nnnn| Alive

# Verify OID is listening on port 389
ldapsearch -h oid-host -p 389 -D "cn=orcladmin" -w <orcladmin_password> \
  -b "" -s base "(objectClass=*)" vendorName vendorVersion 2>&1

echo "OID instance started"
\`\`\`

---

## Phase 4: Configure DIT and Populate Users

\`\`\`bash
# Create base DIT structure
cat > /tmp/base_dit.ldif <<'LDIF_EOF'
# Root entry (may already exist)
dn: dc=example,dc=com
objectClass: top
objectClass: domain
dc: example

# People OU
dn: ou=people,dc=example,dc=com
objectClass: top
objectClass: organizationalUnit
ou: people

# Employees sub-OU
dn: ou=employees,ou=people,dc=example,dc=com
objectClass: top
objectClass: organizationalUnit
ou: employees

# Service accounts sub-OU
dn: ou=service-accounts,ou=people,dc=example,dc=com
objectClass: top
objectClass: organizationalUnit
ou: service-accounts

# Groups OU
dn: ou=groups,dc=example,dc=com
objectClass: top
objectClass: organizationalUnit
ou: groups
LDIF_EOF

ldapadd -h oid-host -p 389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -f /tmp/base_dit.ldif

# Verify DIT structure
ldapsearch -h oid-host -p 389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -b "dc=example,dc=com" -s one "(objectClass=*)" dn

# Create sample user entries
cat > /tmp/sample_users.ldif <<'LDIF_EOF'
dn: uid=jsmith,ou=employees,ou=people,dc=example,dc=com
objectClass: top
objectClass: person
objectClass: organizationalPerson
objectClass: inetOrgPerson
objectClass: orclUserV2
uid: jsmith
cn: John Smith
sn: Smith
givenName: John
mail: john.smith@example.com
userPassword: {SSHA512}ChangeMe123!
orclIsEnabled: ENABLED
employeeNumber: 10001
departmentNumber: HR
title: HR Analyst
telephoneNumber: +1 555 100 0001

dn: uid=mjones,ou=employees,ou=people,dc=example,dc=com
objectClass: top
objectClass: person
objectClass: organizationalPerson
objectClass: inetOrgPerson
objectClass: orclUserV2
uid: mjones
cn: Mary Jones
sn: Jones
givenName: Mary
mail: mary.jones@example.com
userPassword: {SSHA512}ChangeMe123!
orclIsEnabled: ENABLED
employeeNumber: 10002
departmentNumber: Finance
title: Finance Analyst
LDIF_EOF

ldapadd -h oid-host -p 389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -f /tmp/sample_users.ldif

# Create groups
cat > /tmp/sample_groups.ldif <<'LDIF_EOF'
dn: cn=HR-Users,ou=groups,dc=example,dc=com
objectClass: top
objectClass: groupOfUniqueNames
cn: HR-Users
description: HR Department Users
uniqueMember: uid=jsmith,ou=employees,ou=people,dc=example,dc=com

dn: cn=Finance-Users,ou=groups,dc=example,dc=com
objectClass: top
objectClass: groupOfUniqueNames
cn: Finance-Users
description: Finance Department Users
uniqueMember: uid=mjones,ou=employees,ou=people,dc=example,dc=com
LDIF_EOF

ldapadd -h oid-host -p 389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -f /tmp/sample_groups.ldif

# Verify entries
ldapsearch -h oid-host -p 389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -b "ou=employees,ou=people,dc=example,dc=com" \
  "(objectClass=inetOrgPerson)" uid cn mail orclIsEnabled

echo "DIT populated"
\`\`\`

---

## Phase 5: Create LDAP Attribute Indexes

\`\`\`bash
# Create equality indexes for frequently searched attributes
# This significantly improves OAM authentication and OIM reconciliation performance

# Index uid (login attribute)
oidindex.sh \
  -connect oiddb:1521:OIDDB \
  -add -attr uid -type equality 2>&1

# Index mail
oidindex.sh \
  -connect oiddb:1521:OIDDB \
  -add -attr mail -type equality,substring 2>&1

# Index cn (common name)
oidindex.sh \
  -connect oiddb:1521:OIDDB \
  -add -attr cn -type equality,substring 2>&1

# Index orclIsEnabled (account status — checked on every auth)
oidindex.sh \
  -connect oiddb:1521:OIDDB \
  -add -attr orclIsEnabled -type equality 2>&1

# Index employeeNumber and departmentNumber (used in OIM rules)
oidindex.sh \
  -connect oiddb:1521:OIDDB \
  -add -attr employeeNumber -type equality 2>&1
oidindex.sh \
  -connect oiddb:1521:OIDDB \
  -add -attr departmentNumber -type equality 2>&1

# Verify indexes
ldapsearch -h oid-host -p 389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -b "cn=catalogs,cn=server,cn=subconfigsubentry" \
  "(objectClass=orclIndexedAttribute)" orclAttributeList 2>&1 | \
  grep "orclAttributeList"

echo "LDAP indexes created"
\`\`\`

---

## Phase 6: Configure Fan-Out Replication

\`\`\`bash
# Fan-out replication: OID Master (oid-host-1) → OID Replica (oid-host-2)
# Run on Master

# Create replication agreement LDIF
cat > /tmp/replication_agreement.ldif <<'LDIF_EOF'
dn: orclreplicaid=oid-replica-1,cn=replication configuration
objectClass: top
objectClass: orclReplicationAgreement
orclreplicaid: oid-replica-1
orclreplicahost: oid-host-2
orclreplicaport: 389
orclreplicadn: cn=replication dn,orclreplicaid=oid-replica-1,cn=replication configuration
orclreplicapwd: <replica_password>
orclreplicatype: 2
orclreplicastate: 0
orclbegintime: 20260101000000Z
orclscheduleinterval: 60
orclreplidcerts: 1
LDIF_EOF

ldapadd -h oid-host-1 -p 389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -f /tmp/replication_agreement.ldif

# Start replication server on Master
oidctl connect=OIDDB server=oidrepld \
  host=oid-host-1 port=389 start 2>&1

# Install OID on the Replica (repeat Phase 1-3 on oid-host-2)
# Then bootstrap the replica from master (copy ODS schema data)

# On Replica: configure as replica node
ldapmodify -h oid-host-2 -p 389 \
  -D "cn=orcladmin" -w <orcladmin_password> <<'LDIF_EOF'
dn: cn=oid1,cn=osdldapd,cn=subconfigsubentry
changetype: modify
replace: orclreplicationmode
orclreplicationmode: 1
LDIF_EOF

# Verify replication status
ldapsearch -h oid-host-1 -p 389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -b "cn=replication configuration" \
  "(objectClass=orclReplicationAgreement)" \
  orclreplicaid orclreplicahost orclreplicastate 2>&1

# Test replication: add user on master, verify it appears on replica
ldapadd -h oid-host-1 -p 389 \
  -D "cn=orcladmin" -w <orcladmin_password> <<'LDIF_EOF'
dn: uid=replicationtest,ou=employees,ou=people,dc=example,dc=com
objectClass: inetOrgPerson
objectClass: orclUserV2
uid: replicationtest
cn: Replication Test
sn: Test
mail: repl.test@example.com
orclIsEnabled: ENABLED
LDIF_EOF

sleep 30

# Check replica received the entry
ldapsearch -h oid-host-2 -p 389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -b "ou=people,dc=example,dc=com" \
  "(uid=replicationtest)" dn uid

echo "Replication configured and tested"
\`\`\`

---

## Phase 7: Common Account Management Operations

\`\`\`bash
# Reset user password
ldapmodify -h oid-host -p 389 \
  -D "cn=orcladmin" -w <orcladmin_password> <<'LDIF_EOF'
dn: uid=jsmith,ou=employees,ou=people,dc=example,dc=com
changetype: modify
replace: userPassword
userPassword: NewPassword123!
LDIF_EOF

# Lock a user account (OAM will reject authentication)
ldapmodify -h oid-host -p 389 \
  -D "cn=orcladmin" -w <orcladmin_password> <<'LDIF_EOF'
dn: uid=jsmith,ou=employees,ou=people,dc=example,dc=com
changetype: modify
replace: orclIsEnabled
orclIsEnabled: DISABLED
LDIF_EOF

# Unlock a user account
ldapmodify -h oid-host -p 389 \
  -D "cn=orcladmin" -w <orcladmin_password> <<'LDIF_EOF'
dn: uid=jsmith,ou=employees,ou=people,dc=example,dc=com
changetype: modify
replace: orclIsEnabled
orclIsEnabled: ENABLED
LDIF_EOF

# Add user to group
ldapmodify -h oid-host -p 389 \
  -D "cn=orcladmin" -w <orcladmin_password> <<'LDIF_EOF'
dn: cn=HR-Users,ou=groups,dc=example,dc=com
changetype: modify
add: uniqueMember
uniqueMember: uid=newuser,ou=employees,ou=people,dc=example,dc=com
LDIF_EOF

# Remove user from group
ldapmodify -h oid-host -p 389 \
  -D "cn=orcladmin" -w <orcladmin_password> <<'LDIF_EOF'
dn: cn=HR-Users,ou=groups,dc=example,dc=com
changetype: modify
delete: uniqueMember
uniqueMember: uid=jsmith,ou=employees,ou=people,dc=example,dc=com
LDIF_EOF

# Delete a user entry
ldapdelete -h oid-host -p 389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  "uid=jsmith,ou=employees,ou=people,dc=example,dc=com"

# Bulk export (LDIF backup)
BACKUP_DATE=\$(date +%Y%m%d)
ldapsearch -h oid-host -p 389 \
  -D "cn=orcladmin" -w <orcladmin_password> \
  -b "dc=example,dc=com" "(objectClass=*)" \
  > /backup/oid_export_\${BACKUP_DATE}.ldif
echo "Export: \$(wc -l < /backup/oid_export_\${BACKUP_DATE}.ldif) lines"
\`\`\`

---

## Phase 8: OID Health Monitoring Script

\`\`\`bash
cat > /u01/scripts/oid_health_check.sh <<'SCRIPT_EOF'
#!/bin/bash
# Oracle Internet Directory Health Monitor
# Nagios-compatible exit codes: 0=OK, 1=WARNING, 2=CRITICAL

OID_HOST="oid-host"
OID_PORT="389"
OID_BIND_DN="cn=orcladmin"
OID_BIND_PW="<orcladmin_password>"
OID_BASE="dc=example,dc=com"
REPLICA_HOST="oid-host-2"
DB_HOST="oiddb"
DB_PORT="1521"
DB_SID="OIDDB"
EMAIL="dba-alerts@example.com"
LOG="/var/log/oid_health.log"
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
ORACLE_HOME=\${ORACLE_HOME:-/u01/app/oracle/middleware/oid}

STATUS=0
MESSAGES=""

# Check 1: OID process running
OIDMON_PID=\$(pgrep -x oidmon 2>/dev/null || echo "")
OIDLDAP_PID=\$(pgrep -x oidldapd 2>/dev/null || echo "")
if [ -n "\${OIDMON_PID}" ] && [ -n "\${OIDLDAP_PID}" ]; then
  MESSAGES+="OK: oidmon (\${OIDMON_PID}) and oidldapd (\${OIDLDAP_PID}) running\n"
else
  MESSAGES+="CRITICAL: OID processes not running (oidmon: \${OIDMON_PID:-MISSING}, oidldapd: \${OIDLDAP_PID:-MISSING})\n"
  STATUS=2
fi

# Check 2: LDAP port responding
LDAP_RESULT=\$(ldapsearch -H ldap://\${OID_HOST}:\${OID_PORT} \
  -D "\${OID_BIND_DN}" -w "\${OID_BIND_PW}" \
  -b "" -s base "(objectClass=*)" vendorName 2>/dev/null | \
  grep "^vendorName" || echo "")
if [ -n "\${LDAP_RESULT}" ]; then
  MESSAGES+="OK: OID LDAP port \${OID_PORT} responding\n"
else
  MESSAGES+="CRITICAL: OID LDAP port \${OID_PORT} not responding or bind failed\n"
  STATUS=2
fi

# Check 3: User count (should be non-zero)
USER_COUNT=\$(ldapsearch -H ldap://\${OID_HOST}:\${OID_PORT} \
  -D "\${OID_BIND_DN}" -w "\${OID_BIND_PW}" \
  -b "ou=people,\${OID_BASE}" \
  "(objectClass=inetOrgPerson)" dn 2>/dev/null | \
  grep -c "^dn:" || echo "0")
if [ "\${USER_COUNT:-0}" -gt 0 ]; then
  MESSAGES+="OK: OID user count: \${USER_COUNT}\n"
else
  MESSAGES+="WARNING: OID returned 0 users — possible DIT issue\n"
  [ \${STATUS} -lt 1 ] && STATUS=1
fi

# Check 4: Replica connectivity (if replica configured)
if [ -n "\${REPLICA_HOST}" ]; then
  REPL_RESULT=\$(ldapsearch -H ldap://\${REPLICA_HOST}:\${OID_PORT} \
    -D "\${OID_BIND_DN}" -w "\${OID_BIND_PW}" \
    -b "" -s base "(objectClass=*)" vendorName 2>/dev/null | \
    grep "^vendorName" || echo "")
  if [ -n "\${REPL_RESULT}" ]; then
    MESSAGES+="OK: Replica OID (\${REPLICA_HOST}) responding\n"
    # Check replication lag
    REPL_LAG=\$(ldapsearch -H ldap://\${OID_HOST}:\${OID_PORT} \
      -D "\${OID_BIND_DN}" -w "\${OID_BIND_PW}" \
      -b "cn=replication configuration" "(objectClass=orclReplicationAgreement)" \
      orclreplicastate 2>/dev/null | grep "orclreplicastate" | head -1)
    MESSAGES+="INFO: Replication state: \${REPL_LAG:-unknown}\n"
  else
    MESSAGES+="WARNING: Replica OID (\${REPLICA_HOST}) not responding\n"
    [ \${STATUS} -lt 1 ] && STATUS=1
  fi
fi

# Check 5: ODS database connectivity
DB_STATUS=\$(sqlplus -s sys/<sys_password>@\${DB_HOST}:\${DB_PORT}/\${DB_SID} as sysdba <<'SQL_EOF'
SET PAGESIZE 0 FEEDBACK OFF
SELECT 'connected' FROM dual;
SQL_EOF
)
if echo "\${DB_STATUS}" | grep -q "connected"; then
  MESSAGES+="OK: ODS repository database accessible\n"
  # Check ODS tablespace usage
  TS_PCT=\$(sqlplus -s sys/<sys_password>@\${DB_HOST}:\${DB_PORT}/\${DB_SID} as sysdba <<'SQL_EOF'
SET PAGESIZE 0 FEEDBACK OFF
SELECT ROUND((1 - f.free_bytes / t.total_bytes) * 100, 1)
FROM (SELECT SUM(bytes) total_bytes FROM dba_data_files WHERE tablespace_name = 'ODS_TS') t,
     (SELECT SUM(bytes) free_bytes FROM dba_free_space WHERE tablespace_name = 'ODS_TS') f;
SQL_EOF
  )
  PCT=\$(echo "\${TS_PCT}" | grep -E "^[0-9]" | head -1 | tr -d ' ')
  if [ -n "\${PCT}" ]; then
    if [ "\${PCT%.*}" -ge 90 ]; then
      MESSAGES+="CRITICAL: ODS tablespace \${PCT}% full\n"
      STATUS=2
    elif [ "\${PCT%.*}" -ge 80 ]; then
      MESSAGES+="WARNING: ODS tablespace \${PCT}% full\n"
      [ \${STATUS} -lt 1 ] && STATUS=1
    else
      MESSAGES+="OK: ODS tablespace \${PCT}% used\n"
    fi
  fi
else
  MESSAGES+="CRITICAL: ODS repository database not accessible\n"
  STATUS=2
fi

# Check 6: OID server log for errors
OID_LOG="\${ORACLE_HOME}/ldap/log/oidldapd01.log"
if [ -f "\${OID_LOG}" ]; then
  RECENT_ERRORS=\$(tail -200 "\${OID_LOG}" | grep -c "error\|ERROR\|SEVERE" 2>/dev/null || echo "0")
  if [ "\${RECENT_ERRORS:-0}" -gt 20 ]; then
    MESSAGES+="WARNING: \${RECENT_ERRORS} errors in OID log\n"
    [ \${STATUS} -lt 1 ] && STATUS=1
  else
    MESSAGES+="OK: OID log: \${RECENT_ERRORS} errors in last 200 lines\n"
  fi
fi

# Emit results
echo "[\${TIMESTAMP}] STATUS=\${STATUS}" >> \${LOG}
echo -e "\${MESSAGES}" >> \${LOG}

if [ \${STATUS} -ne 0 ]; then
  HOSTNAME=\$(hostname -f)
  echo -e "OID Health Alert on \${HOSTNAME}\n\n\${MESSAGES}" | \
    mailx -s "OID Alert [\${STATUS}] - \${HOSTNAME}" \${EMAIL}
fi

echo -e "\${MESSAGES}"
exit \${STATUS}
SCRIPT_EOF

chmod +x /u01/scripts/oid_health_check.sh
/u01/scripts/oid_health_check.sh
echo "Exit: \$?"

# Schedule every 10 minutes
(crontab -l 2>/dev/null; echo "*/10 * * * * /u01/scripts/oid_health_check.sh >> /var/log/oid_health.log 2>&1") | crontab -
crontab -l | grep oid_health

echo "OID health monitoring configured"
\`\`\`

---

## Post-Installation Validation Checklist

- [ ] oidmon and oidldapd processes running (pgrep oidmon, pgrep oidldapd)
- [ ] LDAP port 389 accepting connections (ldapsearch to rootDSE succeeds)
- [ ] orcladmin bind succeeds (ldapsearch with orcladmin credentials returns results)
- [ ] DIT structure created (ou=people, ou=groups, cn=OracleContext exist)
- [ ] Sample user entries present (ldapsearch returns jsmith, mjones)
- [ ] Group entries present with correct uniqueMember values
- [ ] LDAP attribute indexes created (uid, mail, cn, orclIsEnabled)
- [ ] Replication agreement configured (ldapsearch of replication configuration returns agreement)
- [ ] Replica receives changes within 60 seconds of master write
- [ ] OAM connected to OID as identity store (OAM Admin Console → Identity Stores)
- [ ] OAM can authenticate using LDAP credentials (test user login via OAM)
- [ ] ODS tablespace below 80% full
- [ ] Health check script returning OK
- [ ] Monitoring crontab scheduled (crontab -l | grep oid_health)`,
};

async function main() {
  console.log('Inserting OID runbook...');
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
