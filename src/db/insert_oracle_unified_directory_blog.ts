import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Unified Directory: Architecture, Replication, and Integration with Oracle Identity Management',
  slug: 'oracle-unified-directory-implementation',
  excerpt:
    'A comprehensive guide to Oracle Unified Directory (OUD): its BDB JE storage architecture, peer-to-peer replication model, proxy mode, schema and ACI management, password policies, indexing, performance tuning, and integration with Oracle Access Manager and Oracle Identity Governance.',
  category: 'identity-management' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-02'),
  youtubeUrl: null,
  content: `## Introduction

Oracle Unified Directory (OUD) is Oracle's modern LDAP v3-compliant directory server, introduced as the strategic replacement for Oracle Internet Directory (OID). Where OID was built on top of the Oracle Database and required a full RDBMS tier, OUD is a standalone Java-based directory built on the same core as OpenDS/OpenDJ, designed for high-throughput LDAP workloads, horizontal scaling via replication, and deployment as both a data directory and an LDAP proxy.

In the Oracle Identity Management stack, OUD serves as the identity store for Oracle Access Manager (OAM), the policy store for OPSS-based applications, the authentication backend for Oracle Identity Governance (OIG), and as a virtual directory proxy that presents Active Directory or other LDAP sources through a unified namespace.

This post covers OUD's internal architecture, replication topology design, schema and ACI management, password policies, index management, performance tuning, and integration with OAM and OIG.

---

## OUD Architecture

OUD's architecture is fundamentally different from OID. Rather than delegating persistence to an Oracle Database, OUD embeds its own storage engine and exposes a set of configurable connection handlers that serve different protocols to different consumer types.

### Core Components

**LDAP Connection Handler** — Listens on port 1389 (LDAP) and 1636 (LDAPS). Supports TLS 1.2/1.3. Handles concurrent connections via a non-blocking NIO thread pool. This is the primary interface for all standard LDAP clients including OAM, OIG, and custom applications.

**HTTP/REST Connection Handler** — Port 8080 (HTTP) / 8443 (HTTPS). Exposes LDAP data via REST API for applications that cannot use an LDAP client library. Also serves the OUD Directory Services REST API and SCIM 1.1 endpoint. Useful for modern microservices-based applications that need user directory access without embedding an LDAP SDK.

**Administration Connector** — Port 4444. All \`dsconfig\` and \`dsreplication\` commands connect here. Uses the admin keystore (admin-keystore) for TLS. This port should never be exposed to application networks — restrict to the management subnet only.

**Replication Server** — Port 8989. Used for changelog replication between OUD instances. Each server maintains a replication domain per replicated backend. The replication server can run co-located with a data node or on a dedicated host in large topologies.

**Backend (JE Backend)** — Oracle Berkeley DB Java Edition (BDB JE) embedded storage engine. Each naming context (suffix) has its own backend. Stores entries as binary-encoded B-tree records. Highly optimised for LDAP access patterns (frequent point lookups by DN, equality searches on indexed attributes, full subtree enumeration for group membership).

**Work Queue** — Configurable thread pool for LDAP operation processing. Default: num_CPU × 2 worker threads. Tunable via \`dsconfig set-work-queue-prop\`. Operations are queued here when all worker threads are busy; the queue depth is bounded to prevent memory exhaustion under extreme load.

**Cache** — Entry cache (LRU, configurable size) and database cache (BDB JE buffer pool). The database cache holds BDB JE B-tree pages in memory and is the primary determinant of whether disk I/O occurs during LDAP searches. Memory allocation between the JVM heap and the BDB JE cache is the key OUD tuning parameter.

### Component Interaction Diagram

\`\`\`
LDAP Clients (OAM, OIG, Apps)
        |
[Connection Handlers]
 LDAP:1389  LDAPS:1636
 HTTP:8080  HTTPS:8443
        |
[Work Queue (thread pool)]
        |
[Request Handler / Access Control]
        |
[Backend: BDB JE]
 dc=example,dc=com
 cn=OAMConfig (policy store)
        |
[Replication Server :8989]
        |
[Peer OUD Instances]
\`\`\`

---

## OUD vs Oracle Internet Directory (OID)

OID was the original Oracle LDAP directory, introduced in the late 1990s and built entirely on top of the Oracle Database. Every LDAP entry is a row in an Oracle schema, and OID inherits all the HA characteristics of Oracle Database — including the need to run Oracle RAC for high availability, which adds cost and operational complexity.

| Feature | OUD | OID |
|---|---|---|
| Storage engine | BDB JE (embedded, no DB required) | Oracle Database (separate DB tier) |
| Installation footprint | ~500 MB, no DB | OID + Oracle DB + WebLogic |
| LDAP throughput | 50,000+ ops/sec per node | ~5,000–10,000 ops/sec |
| Scaling | Horizontal replication (peer-to-peer) | Active-Passive (DB HA) |
| Proxy / Virtual Directory | Yes (OUD Proxy mode) | No (separate OVD product) |
| REST/SCIM API | Built-in | Requires OIM |
| Recommended for new deployments | Yes | No (sustaining-mode only) |

Oracle's stated position is that OUD is the strategic direction for all new deployments. OID remains in sustaining support for customers who have not yet migrated, but no new feature development is planned. For any green-field OAM or OIG implementation, OUD is the correct choice.

---

## Deployment Modes

OUD supports three distinct deployment modes that can coexist in the same enterprise.

### 1. Data Directory Mode

The most common deployment. OUD stores the actual LDAP entries — user records, group memberships, application data. All writes go directly to the BDB JE backend and are immediately durably committed. This is the mode used when OUD serves as the OAM identity store and the OIG provisioning target.

### 2. Proxy Mode

OUD sits in front of one or more backend LDAP servers (Active Directory, OID, another OUD) and presents them as a unified namespace. The proxy mode has no local backend — it forwards every LDAP operation to the configured backend and relays the response.

Use cases for OUD Proxy Mode:
- Aggregate an AD forest and internal OUD users under a single \`dc=example,dc=com\` namespace
- Load-balance LDAP reads across multiple backend directory replicas
- Transform attribute names or DNs (virtual attribute mapping) — for example, presenting AD's \`sAMAccountName\` as \`uid\` to Oracle applications
- Expose a read-only view of Active Directory to Oracle applications without exposing AD bind credentials to every application tier
- Present a consistent LDAP namespace during a migration from OID to OUD

### 3. Replication Server Mode

A dedicated replication infrastructure node that does not hold a local backend but forwards changelog between other OUD data nodes. Used in large topologies with many data centres to create a hub-and-spoke replication graph without requiring every leaf node to maintain direct connections to every other leaf.

---

## Replication Architecture

OUD uses a multi-master replication model where all nodes accept writes. Conflict resolution uses a last-write-wins strategy based on change sequence numbers (CSN). There is no concept of a "primary" node — any OUD instance in the replication topology will serve both reads and writes.

### Replication Topology Types

**Two-node active-active** (most common for OAM/OIG):
\`\`\`
[OUD-Node1] <---replication port 8989---> [OUD-Node2]
     |                                           |
[OAM/OIG - primary]                   [OAM/OIG - secondary]
\`\`\`

Both OAM and OIG are configured with the LDAP URL of their local OUD node. Writes from OAM (password changes via OIG self-service) are committed on whichever node receives them and replicated asynchronously to the peer.

**Hub-and-spoke** (large enterprise, many data centres):
\`\`\`
[OUD-Hub-DC1] <---> [OUD-Hub-DC2]
     |                     |
[OUD-Leaf-Site1]    [OUD-Leaf-Site2]
     |
[OUD-Leaf-Site3]
\`\`\`

Leaf nodes replicate to their hub. Hub-to-hub replication carries changes between data centres. Leaf nodes in different data centres never connect directly, which limits the number of replication connections and makes topology management tractable.

### Replication Latency and Consistency

Replication is asynchronous. Within a single data centre over a LAN, replication lag is typically sub-second. Cross-DC replication over WAN depends on the round-trip time between data centres but is generally 1–5 seconds.

Applications must be designed to tolerate eventual consistency. A write to OUD-Node1 may not be immediately visible on OUD-Node2. This is relevant in OAM scenarios where a user changes their password via a self-service portal backed by OUD-Node1 — if their next login is routed to OUD-Node2 before replication completes, the authentication will fail momentarily.

### Monitoring Replication

The \`dsreplication status\` command shows the CSN lag (missing changes) per server per replication domain. Any lag greater than 1000 changes warrants investigation. Persistent lag usually indicates a network interruption between the two replication servers, or a crash on one node that interrupted the replication stream.

---

## Schema Management

OUD's LDAP schema is stored as LDIF files under \`\${OUD_INSTANCE}/OUD/config/schema/\`. Schema is loaded at startup and can be extended online without restarting OUD, which is an operational advantage over Oracle Database-backed directories where schema changes require database DDL.

### Standard Schema Files

- \`00-core.ldif\` — core LDAP schema (RFC 4519: person, organizationalPerson, inetOrgPerson, etc.)
- \`03-rfc2713.ldif\` — Java object schema
- \`05-rfc4876.ldif\` — DHCP schema
- \`10-sun-schema.ldif\` — OUD-specific operational attributes (\`ds-pwp-*\`, \`ds-cfg-*\`)

### Adding a Custom Attribute and Object Class

\`\`\`ldif
dn: cn=schema
changetype: modify
add: attributeTypes
attributeTypes: ( 1.3.6.1.4.1.99999.1.1
  NAME 'employeeId'
  DESC 'Corporate employee identifier'
  EQUALITY caseIgnoreMatch
  SYNTAX 1.3.6.1.4.1.1466.115.121.1.15
  SINGLE-VALUE )
-
add: objectClasses
objectClasses: ( 1.3.6.1.4.1.99999.2.1
  NAME 'corporateUser'
  DESC 'Corporate user with employee ID'
  SUP top
  AUXILIARY
  MAY ( employeeId ) )
\`\`\`

Apply online:
\`\`\`bash
ldapmodify -h oud-host -p 1389 \\
  -D "cn=Directory Manager" -w "\${DM_PASSWORD}" \\
  -f /tmp/add_employee_schema.ldif
\`\`\`

After applying the schema, the \`employeeId\` attribute becomes available for use in any entry. Because the object class is AUXILIARY, it can be added to any existing entry without replacing its structural object class.

---

## Access Control Instructions (ACIs)

OUD uses ACI-based access control inherited from Sun Directory Server. ACIs are stored as the \`aci\` operational attribute on directory entries — not in a separate policy database. This means access control is intrinsic to the directory data itself and is replicated along with the entries.

### ACI Syntax

\`\`\`
(target="ldap:///ou=People,dc=example,dc=com")
(targetattr="*")
(version 3.0; acl "Allow OAM bind account read";
  allow(read,search,compare)
  userdn="ldap:///cn=oam-bind,cn=ServiceAccounts,dc=example,dc=com";)
\`\`\`

The target specifies the subtree the ACI applies to. The targetattr specifies which attributes the ACI governs (\`*\` means all attributes). The bind rule (\`userdn\`) specifies who the ACI applies to.

### Common ACI Patterns

**Allow service account to search all user attributes** (required for OAM identity store bind account):
\`\`\`ldif
dn: ou=People,dc=example,dc=com
changetype: modify
add: aci
aci: (targetattr="*")(version 3.0; acl "OAM read";
  allow(read,search,compare)
  userdn="ldap:///cn=oam-bind,cn=ServiceAccounts,dc=example,dc=com";)
\`\`\`

**Allow users to change their own password**:
\`\`\`ldif
aci: (targetattr="userPassword")(version 3.0; acl "Self password change";
  allow(write)
  userdn="ldap:///self";)
\`\`\`

**Deny anonymous access to userPassword** (defence-in-depth — also blocked by default, but explicit denial is recommended):
\`\`\`ldif
aci: (targetattr="userPassword")(version 3.0; acl "Deny anon password read";
  deny(read,search,compare)
  userdn="ldap:///anyone";)
\`\`\`

ACIs are evaluated in the order: explicit deny before allow, and most specific target wins. The OUD ACI evaluator traverses the entry's DN hierarchy from root to the entry itself, collecting ACIs at each level, and applies them using this precedence model.

---

## Password Policies

OUD password policies are LDAP entries under \`cn=Password Policies,cn=config\`. Multiple password policies can coexist; individual users or groups can be assigned a non-default policy via the \`ds-pwp-password-policy-dn\` operational attribute. This allows, for example, service accounts to have non-expiring passwords while user accounts expire every 90 days.

### Key Password Policy Attributes

| Attribute | Purpose | Example value |
|---|---|---|
| ds-cfg-password-history-count | Prevent reuse of last N passwords | 12 |
| ds-cfg-max-password-age | Force rotation after N days | 90d |
| ds-cfg-lockout-failure-count | Lock after N failures | 5 |
| ds-cfg-lockout-duration | Auto-unlock after N minutes (0=permanent) | 30m |
| ds-cfg-minimum-password-length | Minimum length via validator | 12 |
| ds-cfg-password-expiration-warning-interval | Warn user N days before expiry | 14d |

### Checking a User's Password Policy Status

\`\`\`bash
ldapsearch -h oud-host -p 1389 \\
  -D "cn=Directory Manager" -w "\${DM_PASSWORD}" \\
  -b "uid=jsmith,ou=People,dc=example,dc=com" \\
  -s base \\
  "(objectclass=*)" \\
  pwdChangedTime pwdFailureTime pwdAccountLockedTime
\`\`\`

If \`pwdAccountLockedTime\` is present, the account is locked. If \`ds-cfg-lockout-duration\` is set to a non-zero value, the lock will expire automatically after that interval. Otherwise, an administrator must remove the \`pwdAccountLockedTime\` attribute manually.

---

## Indexing

OUD indexes attribute values to support fast LDAP search filters. Without an index, OUD performs a full backend scan (unindexed search) — logged as a warning and often disabled by the default search size and time limits configured on the backend. Unindexed searches are the most common performance problem in OUD deployments.

### Index Types

- **equality** — Index for \`(attr=value)\` filters. The most common and most important index type. Should be created for any attribute used in frequent LDAP search filters.
- **presence** — Index for \`(attr=*)\` filters. Useful when searching for entries that have a particular attribute set.
- **ordering** — Index for \`(attr>=value)\` and \`(attr<=value)\` filters. Required for range searches.
- **substring** — Index for \`(attr=*partial*)\` filters. Expensive to maintain because every modification must update multiple index keys. Use sparingly — only when substring search performance is genuinely required.
- **approximate** — Soundex-based matching for fuzzy searches. Rarely needed in production.

### Adding an Equality Index on employeeId

\`\`\`bash
dsconfig set-backend-index-prop \\
  --hostname oud-host --port 4444 \\
  --bindDN "cn=Directory Manager" --bindPassword "\${DM_PASSWORD}" \\
  --backend-name userRoot \\
  --index-name employeeId \\
  --set index-type:equality \\
  --trustAll --no-prompt

# Rebuild index (online, no restart required)
rebuild-index \\
  --hostname oud-host --port 4444 \\
  --bindDN "cn=Directory Manager" --bindPassword "\${DM_PASSWORD}" \\
  --baseDN "dc=example,dc=com" \\
  --index employeeId \\
  --trustAll
\`\`\`

The \`rebuild-index\` command runs online. It scans the backend and builds the index without taking the server offline. During the rebuild, searches on the attribute may still use the unindexed path until the rebuild completes.

---

## Performance Tuning

### JVM Heap Sizing

JVM heap sizing is the single most impactful OUD tuning parameter. OUD allocates memory across three competing pools: the JVM heap (for Java objects, entry cache, and OUD's own data structures), the BDB JE buffer pool (for B-tree pages), and the OS page cache. Getting this balance right for the workload is critical.

Recommended memory split for a dedicated OUD server:
- 40% of available RAM to JVM heap (\`-Xmx\`)
- 40% to BDB JE database cache (configured in \`dsjavaproperties\`)
- 20% reserved for the OS page cache and other processes

For a 32 GB server: \`-Xmx12g\`, BDB cache = 12g, OS = 8g.

If the BDB cache is too small, every LDAP search will result in BDB JE reading B-tree pages from disk — OUD will be I/O bound regardless of how fast the disks are. If the JVM heap is too large, the OS has no room for its own page cache and OUD JVM GC pauses will increase.

### dsconfig Tuning Parameters

\`\`\`bash
# Increase work queue threads (default: nCPU * 2)
dsconfig set-work-queue-prop \\
  --set num-worker-threads:32 \\
  --hostname oud-host --port 4444 \\
  --bindDN "cn=Directory Manager" --bindPassword "\${DM_PASSWORD}" \\
  --trustAll --no-prompt

# Increase max request size for large LDAP operations
dsconfig set-connection-handler-prop \\
  --handler-name "LDAP Connection Handler" \\
  --set max-request-size:5mb \\
  --hostname oud-host --port 4444 \\
  --bindDN "cn=Directory Manager" --bindPassword "\${DM_PASSWORD}" \\
  --trustAll --no-prompt
\`\`\`

### Monitoring Unindexed Searches

Unindexed searches are the most common OUD performance problem. When a client issues an LDAP search with a filter on an attribute that has no equality index, OUD must scan every entry in the backend. This is logged as a warning in the access log.

\`\`\`bash
# Check access log for unindexed search warnings
grep "Unindexed" \${OUD_INSTANCE}/OUD/logs/access | tail -20

# Check the current index entry limit via dsconfig
dsconfig get-backend-prop \\
  --backend-name userRoot \\
  --property index-entry-limit \\
  --hostname oud-host --port 4444 \\
  --bindDN "cn=Directory Manager" --bindPassword "\${DM_PASSWORD}" \\
  --trustAll
\`\`\`

The \`index-entry-limit\` property controls how many entries can match an indexed attribute before OUD falls back to an unindexed scan. The default is 4000. For large directories where group membership entries may have tens of thousands of values, this limit may need to be raised.

---

## Integration with Oracle Access Manager (OAM)

OUD serves two distinct roles in an OAM 12c deployment simultaneously, and understanding both is critical for OAM performance tuning.

### Role 1: Identity Store

OAM uses OUD as the identity store for user authentication and attribute retrieval:

1. User presents credentials to OAM via a WebGate-protected resource
2. OAM binds to OUD as the service account (e.g., \`cn=oam-bind,cn=ServiceAccounts,dc=example,dc=com\`) using the configured bind DN and password
3. OAM searches for the user entry by \`uid\` or \`mail\` and retrieves the \`userPassword\` attribute (or a hashed form) for credential validation, or performs a proxy bind as the user
4. After authentication, OAM searches for the user's attributes (uid, mail, memberOf, employeeId) to populate the SSO session and inject as HTTP headers into protected application requests

The combined authentication bind + user attribute search must complete in under 100 milliseconds for OAM to deliver acceptable SSO latency. This requires proper indexing on \`uid\`, \`mail\`, and any other attribute used as the OAM search key.

### Role 2: Policy Store (OAM 12c with LDAP Policy Store)

OAM stores Application Domains, Authentication Schemes, and Authorization Policies as LDAP entries under a dedicated subtree:

\`\`\`
cn=OAMConfig,cn=OAMConsole,dc=example,dc=com
\`\`\`

OAM reads its policy on every request, but policy caching in the OAM server reduces LDAP reads to occasional refreshes (typically every 5–15 minutes). The schema extensions required for the policy store must be applied to OUD before configuring OAM to use it as the policy store — these extensions add the OAM-specific object classes and attributes that OAM uses to persist its configuration.

### Key Performance Requirement

Authentication performance requirement: the combined LDAP bind plus user search must complete in less than 100 ms. With proper indexing on the search key attribute (\`uid\` or \`mail\`), OUD typically responds in 1–5 ms per operation on a well-sized server, leaving substantial headroom for network round trips between OAM and OUD.

---

## Integration with Oracle Identity Governance (OIG)

OIG provisions user accounts, group memberships, and passwords directly to OUD via the LDAP Connector (OUD Connector or Generic LDAP Connector). The connector translates OIG provisioning operations into LDAP protocol operations:

| OIG Operation | LDAP Operation | Notes |
|---|---|---|
| Create user | \`ldapadd\` of new person entry | Entry created under \`ou=People,dc=example,dc=com\` |
| Modify attributes | \`ldapmodify\` of existing entry | Attribute-level granularity |
| Disable account | \`ldapmodify\` set \`ds-pwp-account-disabled: TRUE\` | Entry remains; login blocked by OUD password policy |
| Delete/deprovision | \`ldapdelete\` of the entry | Removes entry from OUD permanently |
| Reset password | \`ldappasswd\` or modify \`userPassword\` | OIG passes cleartext; OUD hashes per password policy |
| Reconciliation | \`ldapsearch\` of all entries | OIG syncs existing OUD accounts back to OIG user store |

The OIG-OUD connector should be configured with a dedicated service account that has write access to \`ou=People,dc=example,dc=com\` and the ability to modify password policy operational attributes. This account is separate from the OAM identity store bind account — keeping them separate reduces the blast radius of a compromised service account credential.

---

## Summary

Oracle Unified Directory is the directory foundation of the Oracle Identity Management stack. It stores users for OAM to authenticate, policies for OAM to enforce, and accounts for OIG to provision.

Its embedded BDB JE storage makes it far lighter than OID — no Oracle Database license, no RAC requirement, and a fraction of the operational overhead. Its peer-to-peer replication model provides genuine active-active HA where all nodes accept writes. Its proxy mode makes it a versatile virtual directory layer that can front Active Directory for Oracle applications that expect an LDAP interface without exposing AD credentials to every application tier.

For administrators, the key operational skills are:

- **Replication monitoring** via \`dsreplication status\` — watching for CSN lag that signals a topology health problem
- **Index management** — identifying unindexed searches in the access log and adding the appropriate equality indexes before they become production performance incidents
- **ACI troubleshooting** — understanding the ACI evaluation order and using \`ldapsearch\` with \`-D\` as the service account to test effective permissions
- **Password policy management** — knowing how to inspect and reset \`pwdAccountLockedTime\`, \`pwdChangedTime\`, and \`pwdFailureTime\` for locked or expiring accounts
- **JVM and BDB cache tuning** — allocating memory correctly between JVM heap and BDB JE buffer pool to prevent I/O-bound search performance

OUD is mature, well-documented, and actively maintained by Oracle. Any administrator working with OAM 12c or OIG 12c will spend significant time in OUD — this architecture knowledge is the foundation for all the operational work that follows.
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
