import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Internet Directory: Architecture, Integration, and Migration to OUD',
  slug: 'oracle-internet-directory-implementation',
  excerpt: 'A comprehensive guide to Oracle Internet Directory (OID) — its Oracle Database-backed architecture, LDAP process model, replication, DIP synchronization, EBS integration, performance tuning, and migration path to Oracle Unified Directory (OUD).',
  category: 'identity-management' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-02'),
  youtubeUrl: null,
  content: `# Oracle Internet Directory: Architecture, Integration, and Migration to OUD

## Introduction

Oracle Internet Directory (OID) is Oracle's LDAP v3 directory server, unique among enterprise directory products in that it uses an Oracle Database as its storage backend rather than a purpose-built storage engine. Introduced with Oracle 9iAS, OID was Oracle's primary directory for over a decade — the LDAP foundation for Oracle Single Sign-On (OSSO), Oracle E-Business Suite user management, Oracle Application Server, and early Oracle Identity Management deployments. Today OID remains in production at many large Oracle shops, particularly those with deeply integrated Oracle EBS environments. While Oracle has shifted its strategic direction to Oracle Unified Directory (OUD) for new deployments, OID continues to receive sustaining support, and understanding its architecture is essential for administrators who maintain it and for those planning migrations away from it.

---

## OID Architecture

### What Makes OID Unique — the Oracle Database Backend

Unlike OpenLDAP, Active Directory, or Oracle Unified Directory (which all use embedded or proprietary storage engines), OID stores every LDAP entry, attribute, and schema definition in Oracle Database tables. This architectural choice has profound implications:

- **Storage**: LDAP entries are stored in tables like \`CT_DN\` (distinguished names), \`CT_SUBSCRIPTION\` (replication), and a set of attribute value tables partitioned by attribute type
- **Transactions**: LDAP write operations are Oracle Database transactions — committed with full ACID semantics, recoverable via Oracle RMAN
- **Scalability**: OID inherits Oracle Database's connection pooling, buffering, and I/O characteristics — but also its licensing costs and operational complexity
- **Performance ceiling**: OID's throughput is bounded by Oracle Database SQL performance, which makes it significantly slower than native LDAP storage engines for high-concurrency authentication workloads (typically 2,000–5,000 binds/sec maximum vs OUD's 50,000+)

### OID Process Architecture

- **oidmon**: OID Monitor process. The parent process that starts and monitors the other OID processes. Runs as the oracle OS user. Writes to \`\$ORACLE_HOME/ldap/log/oidmon.log\`.
- **oidldapd**: OID LDAP Server process (one or more instances). Handles incoming LDAP connections, translates LDAP operations to SQL, executes against the OID schema in Oracle Database. Multiple oidldapd instances can be started for load distribution on the same host.
- **oidrepld**: OID Replication Server process. Manages changelog propagation between OID nodes in a replicated topology.
- **odisrv**: Oracle Directory Integration Server. Part of Oracle Directory Integration Platform (DIP) — synchronizes OID with external directories (Active Directory, Sun Directory, etc.).

Text-based architecture:

\`\`\`
LDAP Clients (OAM, EBS, Apps)
        |
   LDAP :389 / LDAPS :636
        |
[oidldapd process(es)]
        |
[Oracle Database - OID Schema]
 CT_DN | CT_SUBSCRIPTION | ODSM tables
        |
[oidrepld] <---> [Remote OID node]
        |
[odisrv / DIP] <---> [Active Directory / Sun LDAP]
\`\`\`

### Key OID Oracle Database Tables

| Table | Purpose |
|---|---|
| CT_DN | Stores all distinguished names (DNs) — one row per LDAP entry |
| ODS.CT_SUBSCRIPTION | Replication changelog and subscriptions |
| ODS.SDUMP | Schema dump — LDAP schema definitions |
| ODS.ODS_PROCESS_STATUS | OID process health and status records |
| ODS.CT_PASSWORD | Hashed password storage (separate from attribute tables) |

---

## OID vs Oracle Unified Directory (OUD)

| Feature | OID | OUD |
|---|---|---|
| Storage backend | Oracle Database (separate license) | BDB JE (embedded, no DB) |
| Throughput | ~2,000–5,000 binds/sec | ~50,000+ binds/sec |
| Installation footprint | Oracle DB + WebLogic + OID binaries | JDK + OUD binary only |
| Backup/recovery | Oracle RMAN (DB backup) | LDIF export or BDB file backup |
| Replication | Fan-out (master/shadow) or multimaster | Peer-to-peer multimaster |
| REST/SCIM API | Not available natively | Built-in |
| Oracle EBS integration | Native (shipped with EBS) | Requires connector configuration |
| Strategic status | Sustaining support only | Active development, recommended |
| DIP (AD sync) | Built-in (odisrv) | Separate OUD Proxy / connector |

---

## OID Schema and Namespace

OID uses standard LDAP schema with Oracle extensions. The default namespace is typically \`dc=example,dc=com\` or \`cn=OracleContext,dc=example,dc=com\` for Oracle application-specific data.

### Oracle-Specific Schema Containers

- \`cn=OracleContext\`: Root container for Oracle application data. OAM, OHS, OracleAS store configuration here.
- \`cn=OracleSchemas,cn=OracleContext\`: Database schema registrations for Oracle databases using Advanced Security
- \`cn=Products,cn=OracleContext\`: Product-specific configuration subtrees
- \`cn=SSO,cn=OracleContext\`: Oracle Single Sign-On configuration (legacy)
- \`orclApplicationCommonName\`: Oracle-specific attribute for application distinguished names

### Extending the Schema (Adding a Custom Object Class)

\`\`\`ldif
dn: cn=schema
changetype: modify
add: attributeTypes
attributeTypes: ( 1.3.6.1.4.1.99999.1.100
  NAME 'employeeNumber'
  DESC 'Employee number from HR system'
  EQUALITY caseIgnoreMatch
  SYNTAX 1.3.6.1.4.1.1466.115.121.1.15
  SINGLE-VALUE )
-
add: objectClasses
objectClasses: ( 1.3.6.1.4.1.99999.2.100
  NAME 'hrEmployee'
  DESC 'HR employee record extension'
  SUP top
  AUXILIARY
  MAY ( employeeNumber ) )
\`\`\`

Apply with ldapmodify:

\`\`\`bash
ldapmodify -h oid-host -p 389 \\
  -D "cn=orcladmin" -w "\${ORCLADMIN_PASSWORD}" \\
  -f /tmp/add_employee_schema.ldif
\`\`\`

---

## Access Control Lists (ACLs)

OID uses Oracle-specific ACL syntax stored as \`orclACI\` attributes on directory entries (similar to standard LDAP ACIs but with Oracle extensions).

### OID ACI Syntax

\`\`\`
access to attr=<attribute>
  by dn="<bind DN>" <permissions>
  by * <permissions>
\`\`\`

### Example — Allow OAM Service Account to Search All User Attributes

\`\`\`ldif
dn: ou=People,dc=example,dc=com
changetype: modify
add: orclACI
orclACI: access to attr=*
  by dn="cn=oam-bind,cn=orcladmin,dc=example,dc=com" read
  by * none
\`\`\`

### Example — Allow Users to Change Their Own Password

\`\`\`ldif
dn: ou=People,dc=example,dc=com
changetype: modify
add: orclACI
orclACI: access to attr=userpassword
  by self write
  by * none
\`\`\`

### View Existing ACLs on an Entry

\`\`\`bash
ldapsearch -h oid-host -p 389 \\
  -D "cn=orcladmin" -w "\${ORCLADMIN_PASSWORD}" \\
  -b "ou=People,dc=example,dc=com" -s base \\
  "(objectclass=*)" orclACI
\`\`\`

---

## Password Policies

OID password policies are set via \`orclpwdpolicyenable\`, \`orclpwdminlength\`, \`orclmaxpwdage\`, \`orclpwdhistorycount\` attributes on the realm entry (\`cn=OracleContext,dc=example,dc=com\` or subtree entries).

### Key Password Policy Attributes

| Attribute | Purpose | Example |
|---|---|---|
| orclpwdpolicyenable | Enable policy (0=off, 1=on) | 1 |
| orclpwdminlength | Minimum length | 12 |
| orclmaxpwdage | Max age in seconds | 7776000 (90 days) |
| orclpwdhistorycount | Password history count | 10 |
| orclpwdmaxfailure | Account lockout threshold | 5 |
| orclpwdlockoutduration | Lockout duration in seconds | 1800 (30 min) |
| orclpwdexpwarning | Warning period before expiry (seconds) | 1209600 (14 days) |

### Check a User's Password Status

\`\`\`bash
ldapsearch -h oid-host -p 389 \\
  -D "cn=orcladmin" -w "\${ORCLADMIN_PASSWORD}" \\
  -b "uid=jsmith,ou=People,dc=example,dc=com" -s base \\
  "(objectclass=*)" \\
  pwdChangedTime pwdFailureTime pwdAccountLockedTime orclpwdaccountunlock
\`\`\`

---

## OID Replication

OID supports two replication modes:

### 1. Fan-Out (Master/Shadow) Replication

The most common OID topology:

- One master OID node accepts all writes
- One or more shadow (read replica) nodes receive replicated changes via oidrepld
- Writes go to master; reads can be directed to shadows
- Replication is asynchronous — shadows may lag behind master

### 2. Multimaster Replication

- Multiple nodes accept writes
- Changes propagate between all nodes via the replication server
- Last-write-wins conflict resolution
- More complex to configure and troubleshoot than fan-out

Replication agreements define which subtrees replicate to which nodes and via what transport. Stored as entries under \`cn=replication,cn=OracleContext\`.

### Check Replication Status

\`\`\`bash
oidctl connect=orcl server=oidrepld status
\`\`\`

### Diagnose Replication Lag

\`\`\`sql
-- Run in the OID Oracle Database schema (ODS)
SELECT agreement_name,
       supplier_dn,
       consumer_dn,
       last_applied_csn,
       last_generated_csn,
       (last_generated_csn - last_applied_csn) AS pending_changes
FROM ods.orclcatchangelog_status
ORDER BY pending_changes DESC;
\`\`\`

---

## Oracle Directory Integration Platform (DIP)

DIP (the \`odisrv\` process) synchronizes OID with external directories, primarily Active Directory. Common use cases:

- Sync AD users into OID so Oracle applications (EBS, OAM) can authenticate against their AD credentials
- Provision changes from OIG to AD via OID as an intermediary
- Sync group memberships bidirectionally

DIP synchronization profiles define:

- Source and target directories (connection string, bind DN)
- Which attributes to map
- Sync direction (import from AD, export to AD, or bidirectional)
- Sync schedule

### Check DIP Sync Status

\`\`\`bash
manageSyncProfiles status \\
  -h oid-host -p 389 \\
  -D "cn=orcladmin" -w "\${ORCLADMIN_PASSWORD}" \\
  -profile "AD Sync Profile"
\`\`\`

---

## Integration with Oracle EBS

OID was the original LDAP backend for Oracle EBS user management:

- **Native User Management**: EBS FND_USER records can be linked to OID entries via the \`orclApplicationCommonName\` attribute
- **EBS SSO (Legacy)**: OID was the authentication backend for Oracle Single Sign-On (OSSO), which was the predecessor to OAM-based SSO. Many EBS environments still run OSSO via OID.
- **EBS Directory Integration**: The EBS-OID connector (part of DIP) synchronizes FND_USER records with OID, allowing centralized password management

### Check If EBS Users Are Linked to OID

\`\`\`sql
-- Run in EBS APPS schema
SELECT usr_name,
       user_name,
       person_party_id,
       email_address
FROM fnd_user
WHERE user_guid IS NOT NULL  -- user_guid means linked to OID/LDAP
  AND end_date IS NULL
ORDER BY last_update_date DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

---

## Performance Tuning

OID performance is governed by two systems: the OID server processes (oidldapd) and the Oracle Database underneath.

### OID Server-Level Tuning (via oidctl or ODSM)

- **orclserverprocs**: Number of oidldapd worker processes (default: 1). Increase to match available CPU cores for high-concurrency environments. Each process handles connections independently.
- **orclmaxcc**: Maximum concurrent connections per oidldapd process (default: 100). Total connection capacity = orclserverprocs × orclmaxcc.
- **Connection timeout**: \`orclldapidle\` controls how long idle connections are held (seconds)

\`\`\`bash
# Increase server processes to 4
ldapmodify -h oid-host -p 389 \\
  -D "cn=orcladmin" -w "\${ORCLADMIN_PASSWORD}" <<'EOF_LDIF'
dn: cn=oid1,cn=osdldapd,cn=subconfigsubentry
changetype: modify
replace: orclserverprocs
orclserverprocs: 4
EOF_LDIF
\`\`\`

### Oracle Database Tuning for OID

- OID's primary DB tables are heavily indexed; the buffer cache hit rate should exceed 99% for the OID schema
- Shared pool: OID generates repetitive SQL that benefits from large shared pool and cursor_sharing=SIMILAR or FORCE
- Undo tablespace: OID write operations generate significant undo — ensure undo retention is adequate for peak load
- AWR reports: filter by schema ODS to identify the top SQL from OID operations

---

## Migration from OID to OUD

The migration path from OID to OUD is:

1. **Export OID data to LDIF**: Use \`ldapsearch\` or \`bulkexport\` to export all entries
2. **Schema migration**: Identify custom schema extensions in OID; replicate them in OUD using dsconfig
3. **ACI conversion**: OID uses \`orclACI\` syntax; OUD uses standard LDAP ACI syntax — manual conversion required
4. **Import into OUD**: Use OUD's \`import-ldif\` or \`ldapadd\`
5. **Application reconfiguration**: Update OAM identity store, OIG LDAP connector, and EBS DIP profiles to point to OUD
6. **Validation**: Run parallel for 30 days with OID as master and OUD as replica before cutover
7. **DIP replacement**: Replace odisrv with OUD Proxy AD connector or a dedicated AD sync solution

---

## Common Failure Patterns

### Pattern 1: OID Process Down (oidldapd Not Running)

**Symptom**: All LDAP clients return "Can't contact LDAP server"

**Diagnosis**: \`ps -ef | grep oidldapd\` shows no process; oidmon.log shows "Server is down"

**Resolution**: \`oidctl connect=orcl server=oidldapd start\`

### Pattern 2: Oracle Database Connection Exhausted

**Symptom**: OID responds slowly; new LDAP binds time out

**Diagnosis**: OID schema in Oracle DB shows ORA-00018 (maximum sessions exceeded)

**Resolution**: Increase DB sessions parameter; restart oidldapd to clear stale connections; check for abandoned LDAP sessions

### Pattern 3: Replication Stuck — Consumer Not Receiving Changes

**Symptom**: Shadow node shows stale data; orclcatchangelog_status shows large pending_changes

**Diagnosis**: oidrepld on supplier is not running, or changelog table has gaps

**Resolution**: Restart oidrepld on the supplier; check ODS.ORCLCATCHANGELOG for gaps in CSN sequence

### Pattern 4: ODSM Console Returns "Server Not Available"

**Symptom**: Cannot access Oracle Directory Services Manager web UI

**Diagnosis**: OID WebLogic application (odsm) is not started or OID LDAP port is unreachable

**Resolution**: Check WLS managed server hosting ODSM; verify OID LDAP port is listening

---

## Summary

OID remains a widely deployed and deeply integrated component in Oracle environments, particularly those with Oracle EBS and legacy OSSO. Its Oracle Database backend provides strong data integrity and familiar backup/recovery via RMAN, but at a significant cost in throughput and operational complexity compared to modern directory servers. For new deployments or high-throughput authentication workloads, Oracle's strategic direction is OUD. For existing OID deployments, the key operational skills are process management (oidmon/oidldapd/oidrepld), replication health monitoring, DIP synchronization administration, and understanding the Oracle Database layer that underpins everything OID does.
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
