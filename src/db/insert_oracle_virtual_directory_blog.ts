import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Virtual Directory: Unified Identity Views Across Heterogeneous Directory Sources',
  slug: 'oracle-virtual-directory-implementation',
  excerpt:
    'Oracle Virtual Directory (OVD) presents a single, virtual LDAP namespace assembled in real time from Active Directory, Oracle Internet Directory, HR databases, and other sources — without replication or data migration. This post covers OVD architecture, adapter types, Join View configuration, OAM and EBS integration, caching, and common failure patterns.',
  category: 'identity-management' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-02'),
  youtubeUrl: null,
  content: `## Introduction

Oracle Virtual Directory (OVD) solves one of the most persistent problems in enterprise identity management: the existence of identity data in multiple, incompatible silos. A typical enterprise might have user records in Active Directory (for Windows authentication), Oracle Internet Directory (for Oracle application authentication), a PeopleSoft HR database (the authoritative source for employee attributes), and a partner LDAP for federated identity. Each application needs a different view of this data — Oracle Access Manager needs a unified user object with attributes from all sources; Oracle EBS needs an LDAP view of HR data; a custom application expects users in a flat namespace with normalized attribute names.

OVD addresses this without data migration or replication. It presents a single, virtual LDAP namespace that is assembled in real time from multiple backend sources — directories, databases, and web services — through a set of configurable adapters. From any LDAP client's perspective, OVD looks like a single LDAP server with a coherent directory. Behind that facade, OVD routes each search operation to the appropriate adapters, merges the results, applies attribute transformations, and returns a unified response. No data is physically copied or synchronized — it is assembled on demand.

---

## OVD Architecture

### Core Components

**Listeners**: OVD exposes LDAP endpoints to clients. Each listener is an inbound connection handler:

- **LDAP Listener**: Port 6389 (default). Standard LDAP v3 connection handler for all client applications.
- **LDAPS Listener**: Port 6636. TLS-encrypted LDAP for secure connections.
- **HTTP Listener**: Port 8080. Exposes OVD's administration interface and optionally a REST API for attribute retrieval.
- **Admin Listener**: Port 8899. Used by OVD Manager (the configuration tool) to manage the OVD instance.

**Adapters**: Each adapter connects OVD to one backend data source. Adapter types:

- **Local Store Adapter**: OVD's own embedded LDAP store for data that doesn't live elsewhere (e.g., groups that span multiple directories). Built on an embedded BDB-based directory.
- **LDAP Adapter**: Connects to any LDAP v3 directory — Active Directory, Oracle Internet Directory, Oracle Unified Directory, Sun Directory Server, OpenLDAP. OVD routes LDAP operations to the backend directory, translating namespace and attribute names as needed.
- **Database Adapter**: Connects to an Oracle or other JDBC-accessible database and presents relational data as an LDAP subtree. Each table row becomes an LDAP entry; column names map to attribute names.
- **Join View Adapter**: The most powerful adapter type. Joins data from multiple adapters to create a composite LDAP entry. For example, combine the user object from AD (authentication attributes) with employee attributes from an HR database (department, cost center, manager) into a single LDAP entry.

**Plug-ins**: Plug-ins intercept LDAP operations at various points in OVD's processing pipeline and can transform, filter, or route them:

- **Attribute Transformation Plug-in**: Rename attributes (e.g., sAMAccountName → uid), add static attributes, remove attributes from responses.
- **ACL Plug-in**: Apply access control rules before returning results.
- **Caching Plug-in**: Cache search results for a configurable TTL to reduce backend directory load.
- **Join Plug-in**: Used internally by the Join View adapter to merge results from multiple sources.
- **Custom Plug-ins**: Java-based plug-ins implementing the OVD plug-in API for organization-specific transformations.

### Architecture Diagram

\`\`\`
LDAP Clients (OAM, OIG, Apps)
     |
[OVD Listeners]
 LDAP:6389  LDAPS:6636
     |
[OVD Routing Engine]
  |          |           |
[LDAP      [DB        [Local
 Adapter]   Adapter]   Store]
  |          |
[Active    [Oracle DB /
 Directory] HR Schema]
     |
[Join View Adapter]
  merges AD + DB into unified entry
\`\`\`

Every inbound LDAP operation passes through the routing engine, which determines which adapter or combination of adapters is responsible for the target namespace, dispatches the operation, and assembles the response. The routing is based entirely on the LDAP base DN of the request — each adapter owns a local base DN in OVD's virtual namespace.

---

## Adapter Deep-Dive

### LDAP Adapter — Connecting to Active Directory

The LDAP adapter is the most commonly deployed adapter type. When connecting to AD, several configuration considerations apply:

- **Namespace mapping**: AD uses \`CN=Users,DC=example,DC=com\` for user objects; OVD can present these under \`ou=People,dc=example,dc=com\` — a more standard LDAP namespace that Oracle applications expect.
- **Attribute mapping**: AD uses \`sAMAccountName\` where Oracle apps expect \`uid\`; \`displayName\` where LDAP apps expect \`cn\`; \`mail\` is consistent. OVD's attribute mapping translates these transparently.
- **SSL/LDAPS**: Always use LDAPS (port 636) when connecting OVD to AD to protect credentials in transit. Import the AD domain controller's certificate into OVD's trust store.
- **Bind account**: Create a dedicated AD service account for OVD with read-only access to the user and group OUs. Do not use a domain admin account.
- **Referral handling**: AD returns LDAP referrals for objects in other domains. Configure the LDAP adapter to follow referrals (\`Follow Referrals: true\`) for multi-domain forests.

Example LDAP adapter configuration (OVD Manager):

\`\`\`
Adapter Name: AD_Users_Adapter
Remote Host: ad-dc01.example.com
Remote Port: 636
Use SSL: Yes
Remote Base: CN=Users,DC=example,DC=com
Local Base: ou=People,dc=example,dc=com
Bind DN: CN=svc-ovd,OU=ServiceAccounts,DC=example,DC=com
Bind Password: [CSF reference]
Attribute Mapping:
  sAMAccountName → uid
  displayName → cn
  givenName → givenName (passthrough)
  sn → sn (passthrough)
  mail → mail (passthrough)
  memberOf → groupMembership
\`\`\`

After saving this adapter, any LDAP search against \`ou=People,dc=example,dc=com\` on OVD is transparently proxied to AD and the results returned with the mapped attribute names. The calling application — whether OAM, OIG, or a custom application — never needs to know it is talking to AD.

### Database Adapter — HR System Integration

The Database adapter presents relational data as LDAP entries. Each row in a SQL result set becomes one LDAP entry; the adapter maps column names to LDAP attribute names.

Configuration:

\`\`\`
Adapter Name: HR_Employee_Adapter
JDBC URL: jdbc:oracle:thin:@hr-db-host:1521/hrprod
DB User: ovd_read
DB Password: [CSF reference]
SQL Query: SELECT employee_id, first_name, last_name, department, cost_center,
           manager_id, email, hire_date, job_code
           FROM hr.employees
           WHERE status = 'ACTIVE'
Local Base: ou=HREmployees,dc=example,dc=com
LDAP RDN Attribute: uid
RDN Column: employee_id
Attribute Mapping:
  employee_id → uid
  first_name → givenName
  last_name → sn
  department → departmentNumber
  cost_center → businessCategory
  email → mail
  hire_date → orclHireDate
  job_code → title
\`\`\`

The result: any LDAP search against \`ou=HREmployees,dc=example,dc=com\` executes the configured SQL query and returns the results as LDAP entries. OAM can use these entries for authorization (check departmentNumber); OIG can reconcile against them. No ETL process, no LDAP schema extension in the HR database, and no data copied to a separate directory.

The Database adapter supports parameterized queries — if the LDAP search filter contains a \`uid\` attribute, OVD appends \`AND employee_id = :uid\` to the SQL query, dramatically reducing the rows returned from the database and improving response time.

### Join View Adapter — Merging AD and HR into One Entry

The Join View adapter is what makes OVD uniquely powerful. It takes entries from two or more adapters and merges them into a single LDAP entry based on a common linking attribute.

**Scenario**: AD has the user's authentication credentials (sAMAccountName, userPassword via bind). The HR database has the authoritative department, cost center, and manager. Oracle applications need both sets of attributes in a single LDAP entry.

Join configuration:

\`\`\`
Primary Adapter: AD_Users_Adapter (source of truth for identity)
Secondary Adapter: HR_Employee_Adapter
Join Attribute: mail (exists in both AD and HR — the common key)
Conflict Resolution: Primary wins on conflict
Result Base: ou=People,dc=example,dc=com
\`\`\`

When OAM searches for \`(uid=jsmith)\` against OVD:

1. OVD queries AD_Users_Adapter: returns the AD entry with auth attributes
2. OVD extracts \`mail=jsmith@example.com\` from the AD entry
3. OVD queries HR_Employee_Adapter using mail as the join key: \`(mail=jsmith@example.com)\`
4. OVD merges the two entries: AD attributes + HR attributes in one response
5. OAM receives a unified entry with \`uid, cn, mail, departmentNumber, cost_center, manager\`

This join happens at query time, with no data warehouse or replication in between. The join is left outer by default — if an AD user has no HR record (e.g., a contractor with no HR system entry), OVD still returns the AD attributes; the HR attributes are simply absent from the merged entry.

---

## Integration with Oracle Access Manager

OVD integrates with OAM as the identity store — OAM sends LDAP bind and search requests to OVD, which routes them to the appropriate backends:

**Authentication**: OAM sends a bind request to OVD with the user's uid and password. OVD's LDAP adapter routes this to AD (or OID), which validates the credentials and returns success or failure. OVD never sees the password in cleartext for AD/OID authentication — it passes the bind through.

**Attribute retrieval**: After successful authentication, OAM searches OVD for the user's attributes. If OVD has a Join View adapter configured, this single search returns a combined set of attributes from all backends — AD authentication attributes + HR department/role data — without OAM needing to know about the multiple backends.

**OAM configuration**: In the OAM Admin Console, configure the identity store to point to OVD (localhost:6389 or the OVD host) instead of directly to AD or OID. OAM sees a standard LDAP server; OVD handles the backend complexity.

This configuration means that when HR updates a user's department in the HR system, OAM's next attribute retrieval after the cache TTL expires will automatically reflect the new department — enabling attribute-based authorization policies in OAM (e.g., only users in departmentNumber=Finance may access the finance application) to stay current with HR changes without any manual synchronization.

---

## Integration with Oracle EBS

OVD can serve as the LDAP backend for Oracle EBS in environments where:

- The enterprise uses AD for authentication but EBS expects LDAP
- HR system attributes need to be available in LDAP form for EBS access controls
- Multiple directory sources need to be unified for EBS Single Sign-On

OVD presents the combined AD + HR namespace to OAM, which in turn provides SSO to EBS via the OAM_REMOTE_USER header. EBS's directory integration (DIP) can be configured to read from OVD instead of OID, allowing EBS to get HR-enriched user data without OID.

In practice, the integration chain is: **AD** (authentication) → **OVD** (virtual namespace with HR enrichment) → **OAM** (SSO policy enforcement) → **EBS** (resource, receiving OAM_REMOTE_USER). The EBS application tier does not need to know how identity is structured in the backend — it trusts the OAM header.

---

## OVD vs OUD Proxy Mode

OUD 11g and 12c include a built-in proxy mode that partially overlaps with OVD's capabilities. Key differences:

| Feature | OVD | OUD Proxy |
|---|---|---|
| Database adapter | Yes — full JDBC/SQL to LDAP | No |
| Join View | Yes — merge multiple sources | Limited (attribute mapping only) |
| Custom plug-ins (Java) | Yes | Yes |
| Replication support | Via backend directories | Native OUD replication |
| Strategic status | Sustaining support | Active development |
| Installation complexity | Moderate (standalone process) | Simpler (part of OUD) |

For pure LDAP-to-LDAP proxy scenarios (e.g., front Active Directory with a standard LDAP namespace), OUD Proxy is the strategic choice. For scenarios requiring Database adapter (SQL-to-LDAP) or complex Join Views, OVD remains relevant.

Oracle's roadmap positions OUD as the long-term strategic directory product, with OVD receiving sustaining (bug-fix only) support. New deployments that do not require the Database adapter should strongly consider OUD Proxy. Existing OVD deployments with Database adapters have no direct migration path to OUD — OUD Proxy has no equivalent of OVD's JDBC/SQL adapter.

---

## Caching and Performance

OVD's Caching plug-in stores search results in memory for a configurable TTL, reducing backend directory load for read-heavy workloads (authentication, attribute lookup):

- **Entry cache**: Caches individual LDAP entries. TTL configurable per adapter (default: 600 seconds).
- **Search result cache**: Caches full search responses for identical filter + base + scope queries.
- **Cache invalidation**: Cache entries expire at TTL; no write-through invalidation. For environments where user data changes frequently (e.g., HR hires/terms), set TTL to 60–120 seconds.
- **Memory sizing**: Each cached entry consumes ~2–4 KB. A cache of 100,000 entries requires ~200–400 MB of JVM heap.

Performance tuning parameters (set in \`ovd.properties\`):

\`\`\`
worker.threads=32
cache.enabled=true
cache.ttl=300
cache.maxentries=50000
ldap.connect.timeout=10000
ldap.read.timeout=30000
\`\`\`

The \`worker.threads\` setting controls OVD's thread pool — the number of concurrent LDAP operations it can process simultaneously. In production, set this to 2× the expected peak concurrent authentication requests. The \`ldap.connect.timeout\` and \`ldap.read.timeout\` settings control how long OVD waits for backend adapters to respond before returning an error to the client.

For the Database adapter specifically, performance is dominated by the SQL query execution time. Ensure the HR database has appropriate indexes on the join key column (email or employee_id) and that the OVD database account's session parameters (e.g., \`optimizer_mode\`, \`cursor_sharing\`) are appropriate for the query pattern. Parameterized queries (where OVD pushes the LDAP filter value into a SQL bind variable) avoid hard-parsing and are far more efficient than queries that return all rows and filter in OVD.

---

## Common Failure Patterns

### Pattern 1: "No such object" for Entries That Exist in Backend

**Cause**: Namespace mapping misconfigured — OVD is routing the search to the wrong adapter base DN.

**Diagnosis**: Enable OVD debug logging; check that the search base maps to the correct adapter's local base.

**Fix**: Review adapter local base configuration; ensure the virtual namespace hierarchy is correct. A common error is configuring the adapter local base as \`ou=People,DC=example,DC=com\` (mixed case DC) when the search is using \`ou=People,dc=example,dc=com\` (lowercase dc). LDAP base DN matching in OVD is case-insensitive for the attribute type but case-sensitive for the value in some code paths — always use lowercase dc in OVD's virtual namespace.

### Pattern 2: Attribute Missing from Join View Results

**Cause**: Join key not matching — AD's mail attribute has different casing or format than HR database email column.

**Diagnosis**: Search each adapter individually; compare the join key values. For example, AD may store \`mail=John.Smith@example.com\` (mixed case) while the HR database stores \`email=john.smith@example.com\` (lowercase). OVD's join is case-sensitive by default.

**Fix**: Add a normalization transformation plug-in to lowercase the join attribute before comparison. Alternatively, update the HR database SQL query to use \`LOWER(email)\` and the AD adapter attribute mapping to lowercase the mail value on retrieval.

### Pattern 3: Authentication Succeeds but OAM Cannot Retrieve Attributes

**Cause**: Bind succeeds via LDAP adapter but subsequent search hits a different adapter scope that returns no attributes.

**Diagnosis**: Test with \`ldapsearch\` directly against OVD using the service account; compare with bind account results.

**Fix**: Ensure the OAM service account has ACI permission to search the virtual namespace. In some OVD configurations, ACLs on the Join View adapter restrict search results for accounts that are not the admin account — OAM's service account must be explicitly granted read access to all attribute types it needs for authorization.

### Pattern 4: OVD Returns Stale Data After User Update in Backend

**Cause**: Caching plug-in TTL is too long — cached entry doesn't reflect the backend change.

**Diagnosis**: Query OVD and backend directly; compare results; check cache TTL setting.

**Fix**: Reduce cache TTL or restart OVD to flush the cache immediately. For time-sensitive attribute changes (e.g., an employee's account is disabled in HR following a termination), consider setting the cache TTL to 60 seconds or disabling the cache entirely for the Join View adapter while keeping caching enabled for the pure LDAP adapters.

---

## Summary

Oracle Virtual Directory's unique value is its ability to present a coherent LDAP namespace assembled in real time from heterogeneous sources — without replication, data migration, or consolidation. Its Database adapter makes it the only Oracle directory product capable of presenting relational HR data as LDAP entries, and its Join View adapter enables attribute enrichment that no single-source directory can provide. For environments that must integrate Active Directory authentication with Oracle application attributes, OVD remains the most capable solution in Oracle's identity management portfolio.

Its strategic successor for pure proxy use cases is OUD Proxy, but for complex multi-source joins with database integration, OVD continues to serve scenarios that no other single product covers. Organizations planning new deployments should evaluate OUD Proxy for LDAP-to-LDAP proxying and reserve OVD for environments where the Database adapter is a hard requirement. Existing OVD deployments with working Join View and Database adapter configurations should treat migration to OUD as a strategic project requiring a custom data layer to replace the JDBC adapter capability, not a drop-in upgrade.
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
