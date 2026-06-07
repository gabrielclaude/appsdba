import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Directory Services Manager (ODSM) 12c: Web-Based Administration for OID and OUD',
  slug: 'oracle-directory-services-manager-odsm-architecture',
  excerpt:
    'A complete guide to Oracle Directory Services Manager (ODSM) 12c: architecture as a WebLogic-hosted Java EE application, connecting to OID and OUD instances, DIT browsing and entry management, schema extensions, Access Control Instructions (ACIs), password policies, replication monitoring, and how ODSM compares to command-line LDAP tools for directory administration.',
  category: 'identity-management' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-07'),
  youtubeUrl: null,
  content: `## Introduction

Oracle Directory Services Manager (ODSM) is Oracle's browser-based administration console for Oracle Internet Directory (OID) and Oracle Unified Directory (OUD). It replaces the earlier Oracle Directory Manager (ODM), a Java Swing desktop application that required local installation and direct database connectivity for OID administration. ODSM is a Java EE web application deployed on WebLogic Server that any administrator with a supported browser can use — without client-side installation, without direct LDAP tool access, and without familiarity with LDIF syntax.

ODSM serves as the primary graphical interface for directory administrators who manage user entries, configure schema extensions, define access control policies, monitor replication, tune server parameters, and diagnose connectivity issues across OID and OUD deployments. Understanding ODSM's capabilities and architecture helps directory administrators decide which tasks are best handled through the console and which require the command-line tools that ODSM cannot replace.

---

## Architecture

### Deployment Model

ODSM is deployed as a J2EE web application (\`odsm.war\`) inside a WebLogic Server domain. In most Oracle IAM deployments, ODSM shares a WebLogic domain with the directory server it manages:

- **OID 12c deployments**: ODSM is included in the OID WebLogic domain, deployed on the Admin Server or a dedicated Managed Server. The OID Admin Console (odsm.war) is accessible at \`http://oid-server:7001/odsm\`.
- **OUD 12c deployments**: OUD has its own administration framework (OUD Administration Console or oudadmin CLI). ODSM can be deployed separately in a standalone WebLogic domain to manage OUD over LDAP.
- **Multi-instance management**: A single ODSM deployment can connect to and manage multiple OID or OUD instances simultaneously — useful when administering master + replica topologies from a single console.

### Connection Architecture

ODSM does not embed directory data locally. Every ODSM operation — browsing entries, modifying attributes, running a search — translates into an LDAP operation executed against the target directory server. ODSM maintains a server connection registry: administrators register OID/OUD server connections (hostname, port, bind DN, password) once, and ODSM stores the connection metadata (not the password — credentials are entered per session).

The ODSM application server connects to OID/OUD over standard LDAP (port 389) or LDAPS (port 636). The LDAP connection runs inside the WebLogic application server process — browsers communicate with ODSM over HTTP/HTTPS, and ODSM makes LDAP calls on their behalf. This means the ODSM WebLogic host must have network access to the OID/OUD LDAP port, but administrator workstations do not.

### Session Management

ODSM uses WebLogic session management. Each administrator logs into ODSM with their browser, registers a directory server connection, and authenticates to that directory with an LDAP bind (typically as \`cn=orcladmin\` for OID or as the OUD admin user). The LDAP connection is held open for the duration of the browser session and released on logout or session timeout.

For OID, the bind DN must have sufficient privileges for the intended operations — \`cn=orcladmin\` has full directory administrator access. For OUD, the admin user configured during OUD setup has equivalent access.

---

## Key Features and Capabilities

### DIT Browser and Entry Management

The DIT (Directory Information Tree) browser is ODSM's most-used feature. It presents the directory hierarchy as an expandable tree panel. Administrators can:

- Navigate the DIT from the root entry (\`dc=example,dc=com\`) down through OUs to individual entries
- View all attributes of a selected entry in the right panel
- Add, modify, or delete attribute values with a form-based editor — no LDIF syntax required
- Create new entries using object class selection and attribute forms
- Delete entries (with optional subtree deletion for non-leaf nodes)
- Move or rename entries (LDAP ModifyDN operations)
- Search the directory with filter builder — construct LDAP search filters visually without writing RFC 4515 filter syntax
- Export search results to LDIF for offline review or scripting

The entry editor validates attribute values against the schema before submitting — entering an invalid value (wrong syntax, violated constraint) produces an error before the LDAP modify is sent.

### Schema Management

ODSM exposes OID/OUD schema management through the Schema section. Administrators can:

- Browse existing object classes, attribute types, and syntaxes
- Add custom attribute types (defining OID, syntax, single/multi-valued, equality/ordering/substring matching rules)
- Add custom object classes (defining required and optional attributes, structural/auxiliary/abstract type)
- Modify existing schema (with caveats — modifying core schema can break interoperability)
- View the schema as loaded, including Oracle-specific extensions (\`orclUserV2\`, \`orclGroup\`)

Schema changes in OID are stored in the directory itself (under \`cn=subschemasubentry\`) and replicated to all OID replica nodes — a schema extension added via ODSM on the master propagates to all replicas automatically. Schema changes in OUD follow the same replication path when OUD replication is configured.

**Schema extension best practice**: Always add new attribute types as AUXILIARY object classes, never modify STRUCTURAL object classes like \`inetOrgPerson\`. Structural class modification can cause existing entries to fail schema validation. Define a custom auxiliary class (e.g., \`companyPersonExtension\`) with your custom attributes, then add it to user entries alongside \`inetOrgPerson\`.

### Access Control Instructions (ACIs)

ODSM provides a graphical ACI editor that constructs LDAP access control rules without requiring knowledge of the Oracle ACI syntax. ACIs in OID and OUD are stored as values of the \`aci\` attribute on directory entries and apply to all entries at and below that entry in the tree.

An ACI has three components:
- **Target**: which entries or attributes the rule applies to (subtree, specific entry, specific attribute list)
- **Subject**: who the rule applies to (specific DN, members of a group, all authenticated users, anonymous)
- **Permission**: what the subject is allowed or denied (read, write, search, compare, add, delete, import, export)

Example use cases:
- Allow OAM's bind account to search and read all user attributes in \`ou=people,dc=example,dc=com\`
- Allow OIM's provisioning account to add and modify entries in \`ou=employees,ou=people,dc=example,dc=com\` but not in \`ou=service-accounts\`
- Deny all write access to the \`userPassword\` attribute except for the entry's own DN (self-service password change)
- Allow HR managers (members of \`cn=HR-Managers,ou=groups\`) to modify \`telephoneNumber\` and \`title\` attributes on entries in the HR subtree

ODSM's ACI editor translates selections into the Oracle ACI string format and stores it. The console also shows existing ACIs with a human-readable summary, which is significantly easier to audit than reading raw ACI strings.

### Password Policy Management

ODSM exposes OID's password policy configuration, which controls authentication behaviour for LDAP binds:

- **Minimum password length**: Minimum characters required
- **Password complexity**: Require uppercase, lowercase, digit, special character
- **Password history**: Number of previous passwords that cannot be reused
- **Maximum password age**: Days before password expiry; LDAP clients receive a warning before expiry
- **Grace logins**: Number of binds allowed after password expiry before lockout
- **Account lockout threshold**: Failed bind attempts before account lock
- **Lockout duration**: Automatic unlock after N minutes, or require manual unlock

OID supports per-subtree password policies — different policies for employees vs contractors vs service accounts. ODSM shows the policy assigned to each password policy object and which subtrees it applies to.

### Replication Monitoring

For OID deployments with replication configured, ODSM's Replication section provides:

- Replication agreement list with partner node details
- Replication status per agreement (current, lagging, error)
- Replication lag (number of changes pending on master, not yet applied to replica)
- Conflict log (entries where simultaneous multi-master changes produced conflicts)
- Manual replication initiation (trigger a replication cycle without waiting for the scheduled interval)

Replication lag monitoring through ODSM gives operations teams a visual indicator of directory synchronisation health. A lag spike following a large batch import (bulk user provisioning from OIM) is expected; a persistent lag indicates a replication connectivity issue or replica performance problem.

### Server Configuration

ODSM exposes OID server parameters that control connection limits, caching, and logging. Key configurable parameters:

- **Maximum connections** (\`orclmaxconnection\`): Total concurrent LDAP connections the OID server accepts
- **Number of worker processes** (\`orclserverprocs\`): oidldapd worker count — increase for high-concurrency environments
- **Log level**: Controls verbosity of OID's LDAP access log and error log
- **SSL configuration**: Enable/disable LDAPS, configure SSL version and cipher suites for OID's LDAP listener
- **Password policy assignment**: Assign password policy objects to subtrees
- **LDAP referrals**: Configure whether the server returns referrals for operations outside its suffix

Changes to server configuration via ODSM take effect after restarting the OID oidldapd process — ODSM displays a restart-required indicator when configuration changes are pending.

---

## ODSM vs Command-Line Tools

ODSM is a capable administration console but does not replace command-line tools for all use cases. Understanding which tool to use for which task prevents both over-reliance on ODSM (which is slow for bulk operations) and under-use (manually writing LDIF when ODSM would be faster).

| Task | Best Tool | Reason |
|---|---|---|
| Browse and inspect individual entries | ODSM | Visual DIT navigation is faster than constructing search DNs |
| Add or modify a single entry | ODSM | Form-based editor prevents syntax errors |
| Bulk load 10,000+ user entries | \`ldapadd\` / \`ldapmodify\` + LDIF | ODSM is not designed for bulk operations |
| Schema extension | ODSM | Visual ACI/schema editor reduces error risk |
| ACI management | ODSM | ACI syntax is complex; visual builder is safer |
| Password policy configuration | ODSM | Policy objects have many fields; form is clearer |
| Replication monitoring | ODSM | Real-time replication status is visual |
| OID server start/stop | \`oidctl\` / \`opmnctl\` CLI | ODSM cannot start/stop the directory server process |
| Performance diagnostics | Oracle AWR + \`oidindex\` CLI | AWR SQL analysis is outside ODSM's scope |
| LDAP search scripting / automation | \`ldapsearch\` + shell scripts | ODSM is interactive; cannot be scripted |
| LDIF export/import | \`ldapsearch\` / \`ldapadd\` | ODSM exports to LDIF but cannot import LDIF directly |
| OID replication setup | ODSM | Replication agreement creation is guided |
| Index management | \`oidindex.sh\` CLI | ODSM does not expose LDAP index management for OID |

### When ODSM Is Not Sufficient

**Large-scale attribute updates**: Modifying a single attribute on 50,000 user entries (e.g., adding a new required attribute or migrating a value format) must be done via \`ldapmodify\` with a prepared LDIF file. ODSM's entry editor is designed for one entry at a time.

**Automated provisioning workflows**: Any provisioning operation triggered by an application or script uses the LDAP protocol directly (via OIM, OAP, or custom LDAP client code). ODSM is a human interface, not a provisioning API.

**OID process management**: Starting, stopping, and monitoring the oidldapd and oidmon processes is done with \`opmnctl\` or \`oidctl\`. ODSM has no ability to start or stop the directory server.

**Database-level OID administration**: OID's Oracle Database backend (ODS schema) requires Oracle DBA tools — RMAN for backup, AWR for performance, SQL*Plus for schema-level operations. ODSM has no visibility into the Oracle Database layer.

---

## ODSM and Oracle Unified Directory (OUD)

ODSM 12c can manage OUD instances in addition to OID. For OUD, ODSM connects to OUD's LDAP port and performs the same browser, schema, and ACI operations. However, OUD has its own native administration interface:

- **OUD Administration Console**: Accessible at \`https://oud-server:4444\` (the OUD administration connector port), offering OUD-specific configuration (backend management, replication, monitoring, logging) that ODSM does not expose
- **oudadmin CLI**: The \`\${OUD_HOME}/bin/dsconfig\` tool for OUD administration from the command line

For OUD, ODSM is best used for entry-level operations (browsing, editing users, managing groups) while OUD Administration Console and \`dsconfig\` are preferred for server configuration, backend setup, and replication management.

---

## Integration with Oracle Directory Integration Platform (DIP)

Oracle Directory Integration Platform (DIP) is a synchronisation engine that keeps OID in sync with connected directories (Active Directory, Sun Directory, HR systems). ODSM includes a DIP administration section that allows administrators to:

- View configured DIP synchronisation profiles
- Check synchronisation status and last run timestamp
- Review synchronisation errors and skipped entries
- Manually trigger a synchronisation run
- Enable/disable individual synchronisation profiles

DIP synchronisation errors are the most common cause of account provisioning delays in OID-integrated environments. The ODSM DIP monitor provides the first-line view of these failures before investigating the DIP server logs.

---

## Common Administration Scenarios

### Adding a Service Account

A new application needs an LDAP bind account for OAM or OIM integration. In ODSM:
1. Navigate to \`ou=service-accounts,ou=people,dc=example,dc=com\`
2. Click Create Entry → select object classes \`inetOrgPerson\`, \`orclUserV2\`
3. Fill attributes: \`uid\`, \`cn\`, \`sn\`, \`userPassword\`, \`orclIsEnabled=ENABLED\`
4. Save — ODSM submits the LDAP add operation
5. Navigate to the groups OU, find the appropriate access group, add the new service account DN as a \`uniqueMember\`

### Unlocking a Locked Account

An OAM authentication failure has locked a user account (\`orclIsEnabled: DISABLED\`):
1. Search for the user by uid or cn
2. Select the entry in the DIT browser
3. In the attribute list, click \`orclIsEnabled\`, change value from \`DISABLED\` to \`ENABLED\`
4. Save — ODSM submits the LDAP modify

### Adding a Custom Attribute

The organisation needs to store a custom attribute (\`companyBadgeID\`) on user entries:
1. Schema → Attribute Types → Create New
2. Define: OID (e.g., \`1.3.6.1.4.1.99999.1.1\`), name (\`companyBadgeID\`), syntax (Directory String), single-valued
3. Save the attribute type
4. Schema → Object Classes → Create New
5. Define: OID, name (\`companyPersonExtension\`), type AUXILIARY, add \`companyBadgeID\` as optional attribute
6. Save the object class
7. On user entries: add \`companyPersonExtension\` to the \`objectClass\` attribute, then set \`companyBadgeID\` value

### Reviewing ACIs Before a Security Audit

Before a security audit, review all ACIs in the directory:
1. Navigate to the root entry (\`dc=example,dc=com\`) or each major OU
2. View the \`aci\` attribute values on each container entry
3. ODSM displays each ACI with a human-readable summary
4. Export the ACI list to LDIF for documentation: Search from root, filter \`(aci=*)\`, include only the \`aci\` attribute, export to LDIF

---

## Conclusion

Oracle Directory Services Manager 12c provides a practical web-based administration interface for OID and OUD that removes the barrier of LDIF syntax and command-line tooling for routine directory administration tasks. Its strengths are entry management, schema extension, ACI definition, password policy configuration, and replication monitoring — all areas where visual interaction and form-based validation reduce administrator error. For bulk operations, server process management, performance tuning, and automation, the command-line tools remain essential. The combination of ODSM for interactive administration and \`ldapsearch\`/\`ldapmodify\`/\`oidctl\` for bulk and scripted operations covers the full scope of OID and OUD administration.

The companion runbook provides the step-by-step commands for deploying ODSM, connecting it to OID and OUD instances, and performing the most common administration tasks.`,
};

async function main() {
  console.log('Inserting ODSM architecture post...');
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
