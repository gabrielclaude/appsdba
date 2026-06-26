import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'OBIEE Authentication Migration from Database to Active Directory: Why Are My Reports Empty?',
  slug: 'obiee-ad-authentication-migration-empty-reports',
  excerpt:
    'A technical guide to a common and frustrating OBIEE migration pitfall — users authenticate successfully against Active Directory but reports return no data. Covers the three root causes: RPD session variable identity mismatch when the username format changes from short database login to UPN or email format, broken connection pool impersonation for Shared Logon and VPD environments, and lost group memberships when catalog groups are not mapped to WebLogic enterprise application roles. Includes the troubleshooting checklist and the specific fixes that restore data visibility.',
  category: 'obiee' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-25'),
  youtubeUrl: null,
  content: `## Overview

Migrating authentication providers in Oracle Business Intelligence Enterprise Edition (OBIEE) is a common architectural task — particularly when decommissioning legacy database credential stores or consolidating identity management into Active Directory (AD). The migration often appears to succeed at first: users log in without errors, dashboards load, and report structures are visible. Then the reports run and return nothing.

This is one of the most disorienting post-migration states an OBIEE administrator can encounter, because the symptoms look like a data problem but the root cause is a security configuration problem. The connection pool is working. The physical data source is available. But data is simply not returning.

This post explains exactly where the pipeline breaks, why it breaks there when authentication providers change, and how to systematically identify and fix the specific point of failure.

---

## The Migration Sequence and Where It Goes Wrong

A typical OBIEE authentication migration follows two phases, and both must succeed completely for users to see data:

**Phase 1 — Authentication**: The WebLogic security realm is reconfigured to use an Active Directory LDAP authenticator as the primary identity provider. Database tables or a flat-file authenticator that previously held usernames and passwords are demoted or removed. Users test login and confirm they can reach OBIEE with their AD credentials. This phase is declared complete.

**Phase 2 — Authorization**: Web Catalog (Webcat) permissions are reviewed or migrated. Users are granted visibility to the correct dashboards, reports, and folders at the object level. Report structures and navigation render correctly. This phase is also declared complete.

**Phase 3 — The wall**: Users open a dashboard. The report executes. The result set is empty, or OBIEE returns a data access error even though the query completed.

At this point, attention typically turns to the connection pool — checking whether the back-end data warehouse or database is reachable, running connectivity tests, reviewing OBIEE server log files. The connection pool is almost always fine. The actual break is between the identity token that AD passes to OBIEE and the identity format that OBIEE's internal security model was built around.

---

## Root Cause 1: RPD Session Variable Identity Mismatch

The most common cause of empty reports after an AD authentication migration is a username format change that breaks row-level security filters embedded in the Repository (RPD).

### How RPD Row-Level Security Works

OBIEE enforces data-level visibility through data filters applied in the Business Model and Mapping layer of the RPD. These filters restrict which rows a user can see based on the value of the \`USER\` session variable — the identity token that OBIEE assigns to the current session. A typical filter looks like:

\`\`\`
"FactTable"."ASSIGNED_TO_USER" = VALUEOF(NQ_SESSION.USER)
\`\`\`

This filter says: only return rows where the \`ASSIGNED_TO_USER\` column matches the session user. If \`NQ_SESSION.USER\` equals \`DBUSER01\`, the query becomes \`WHERE ASSIGNED_TO_USER = 'DBUSER01'\`.

### The Identity Format Change

With database authentication, OBIEE historically received short-form usernames — the database account name: \`DBUSER01\`, \`ANALYST01\`, \`RPTSVC\`. These short names matched exactly the values stored in data tables for row-level filtering.

With Active Directory authentication, OBIEE receives the identity format that AD provides. Depending on how the LDAP authenticator and WebLogic security realm are configured, this is commonly:
- The User Principal Name (UPN): \`firstname.lastname@company.com\`
- The sAMAccountName: \`flastname\`
- The distinguished name: \`CN=First Last,OU=Users,DC=company,DC=com\`

If the data warehouse stores \`DBUSER01\` in the row-level security columns and OBIEE now sends \`firstname.lastname@company.com\` as \`NQ_SESSION.USER\`, the filter evaluates to:

\`\`\`sql
WHERE ASSIGNED_TO_USER = 'firstname.lastname@company.com'
\`\`\`

This matches zero rows. The query returns an empty result set. No error is raised, because the SQL is syntactically correct — there simply are no rows where the email address appears in a column that was always populated with short usernames.

### Init Block Identity Parsing

Custom Initialization Blocks often extend this pattern. An Init Block runs a SQL or LDAP query at login time to populate session variables like \`USER_REGION\`, \`USER_COST_CENTER\`, or \`USER_ORG_CODE\` — values used to drive additional data filters, prompt defaults, or row-level visibility across multiple subject areas.

If the Init Block SQL uses \`:USER\` as its parameter:

\`\`\`sql
SELECT REGION_CODE, COST_CENTER
FROM USER_SECURITY_TABLE
WHERE USER_ID = ':USER'
\`\`\`

...and \`:USER\` is now \`firstname.lastname@company.com\` instead of \`DBUSER01\`, the lookup returns no rows, the session variables are blank, and every filter that references those variables returns zero data. The user sees every report as empty.

---

## Root Cause 2: Broken Connection Pool Impersonation

Some OBIEE environments use database-level row security rather than (or in addition to) RPD filters. In these architectures, the connection pool is configured with a **Shared Logon** that also passes the authenticated user identity to the database for Virtual Private Database (VPD) enforcement.

### Shared Logon with NQ_SESSION.USER

When the connection pool's **User** field is set to \`VALUEOF(NQ_SESSION.USER)\` or an equivalent expression, OBIEE passes the session username as the database login for each physical query. The database then applies VPD policies or row-level security triggers based on the connecting username.

When the session username changes from \`DBUSER01\` (which has a database account and VPD grants) to \`firstname.lastname@company.com\` (which has no database account), the connection attempt fails. Depending on the database's error handling, this either:
- Raises an ORA-01017 login failure that OBIEE surfaces as a data source error
- Falls back to the shared service account, which bypasses the VPD policy entirely — returning all data to all users (a security regression rather than an empty report)

### Pass-Through Authentication

A variant of this issue occurs when the connection pool uses **pass-through authentication** — asking the database to verify the user's credentials directly via proxy authentication. After the AD migration, the database has no record of the AD identity format and rejects the proxy connection.

---

## Root Cause 3: Lost Group Memberships and Application Roles

OBIEE data access is also controlled by which **Application Roles** the user belongs to. Application Roles are defined in the RPD and in the WebLogic Enterprise Application, and they determine which subject areas a user can access, which row-level filters apply by role, and which dashboard filters are visible.

In database-authenticated environments, group memberships were often stored in database security tables or custom OBIEE catalog groups populated by Init Blocks at login. After migration to AD, OBIEE looks for group memberships in LDAP or in the WebLogic security realm's role mappings.

If the AD groups and their mapping to OBIEE Application Roles were not explicitly configured during the migration, the authenticated user arrives in OBIEE with no Application Role memberships. They can log in (authentication succeeded), they can see dashboards (Webcat permissions were preserved), but the data filters applied by Application Role return nothing, or OBIEE silently restricts all data for users with no recognized role.

---

## Troubleshooting Checklist

### Step 1: Read the NQ Query Log (The Smoking Gun)

OBIEE writes the full logical and physical SQL for every query to \`nqquery.log\` (location: \`\$ORACLE_INSTANCE/diagnostics/logs/OracleBIServerComponent/coreapplication_obis1/nqquery.log\`).

Reproduce the empty report scenario with the affected user active, then examine the physical SQL:

\`\`\`
[nQSError: 43113] Message returned from OBIS.
[nQSError: 17001] Oracle Error code: 1017 ...
\`\`\`

Or look at the WHERE clause of the physical SQL:

\`\`\`sql
WHERE "FACT_TABLE"."USER_ID" = 'firstname.lastname@company.com'
\`\`\`

If the filter contains the full UPN or email format where you expect a short username, Root Cause 1 is confirmed.

To increase log verbosity temporarily:
\`\`\`
Administration Tool → Manage → Sessions
  → Right-click affected user session → Set Log Level → 5
\`\`\`

### Step 2: Inspect Session Variables in the Administration Tool

Open the RPD online (connected to the running OBIEE BI Server) via the Administration Tool:

\`\`\`
Administration Tool → Manage → Sessions
  → Select the affected user's session
  → View → Variables
\`\`\`

Inspect the values of:
- \`USER\` — is this the short database username or the full UPN/email?
- \`DISPLAYNAME\` — is this populated?
- Any custom session variables populated by Init Blocks (\`USER_REGION\`, \`COST_CENTER\`, \`ORG_CODE\`, etc.) — are these blank?

Blank Init Block variables combined with a full-format \`USER\` value confirms Root Causes 1 and possibly 3.

### Step 3: Check the WebLogic Identity Virtualizer

For environments mixing multiple authenticators (LDAP + database, LDAP + default authenticator), WebLogic must aggregate group memberships across all providers. This requires:

\`\`\`
WebLogic Console → Security Realms → myrealm → Providers → [LDAP Authenticator]
  → Provider Specific tab
  → Control Flag: SUFFICIENT

WebLogic Console → Security Realms → myrealm
  → Configuration → General tab
  → Enable "Use Identity Domains": No (for on-premises OBIEE 11g/12c)
  → Virtualize: Yes (if mixing authenticators)
\`\`\`

Without \`Virtualize=true\`, group memberships from the LDAP authenticator are not combined with role assignments in the default authenticator — users appear group-less to the OBIEE application role layer.

### Step 4: Trace Init Block Execution

Temporarily elevate log level for Init Block execution in \`NQSConfig.INI\`:

\`\`\`ini
[ SERVER ]
...
INIT_BLOCK_LOG_LEVEL = 3
\`\`\`

Restart the BI Server and log in as the affected user. The log will show:
- Which Init Blocks executed
- The connection pool and SQL used by each block
- The values returned and assigned to session variables
- Any errors (including the critical case where no rows are returned)

---

## Summary and Fix Sequence

When reports are empty after an AD authentication migration, the fix sequence is:

**Fix 1 — Correct the username format in Init Blocks**: Update Init Block SQL to derive the lookup key from the format AD delivers. If AD sends \`firstname.lastname@company.com\`, parse out the short name, or update the USER_SECURITY_TABLE to store email-format keys instead of short usernames.

**Fix 2 — Normalize the session USER variable**: Add a Session Init Block that transforms \`NQ_SESSION.USER\` from AD format to the format expected by RPD data filters. For example:

\`\`\`sql
-- Init Block SQL to extract username prefix from UPN:
SELECT SUBSTR(':USER', 1, INSTR(':USER','@') - 1) FROM DUAL
\`\`\`

Assign the result to a custom \`NORMALIZED_USER\` variable and update RPD data filters to reference \`NQ_SESSION.NORMALIZED_USER\` instead of \`NQ_SESSION.USER\`.

**Fix 3 — Map AD groups to OBIEE Application Roles**: In WebLogic Console, navigate to **Security Realms → myrealm → Roles and Policies → Global Roles** and confirm that each OBIEE Application Role condition includes the AD group mapping:

\`\`\`
Callers with the group BIViewers in AD group → map to OBIEE Application Role BIViewers
\`\`\`

**Fix 4 — Update connection pool credentials**: If using Shared Logon with \`VALUEOF(NQ_SESSION.USER)\`, either update the database to recognize AD identities via proxy authentication grants, or switch the connection pool to a fixed service account and enforce data-level security entirely through RPD filters.

The essential principle: when authentication changes, authorization must be updated to match. Catalog object permissions and the login mechanism are only two of the four layers that govern what a user sees in OBIEE. The other two — session variable values and Application Role memberships — operate at the data layer, and they must be re-validated separately whenever the identity token format changes.`,
};

async function main() {
  console.log('Inserting OBIEE AD authentication blog post...');
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
