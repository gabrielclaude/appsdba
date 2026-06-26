import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'OBIEE AD Authentication Migration Runbook: Fixing Empty Reports After Switching from Database to LDAP',
  slug: 'obiee-ad-authentication-migration-runbook',
  excerpt:
    'Step-by-step runbook for diagnosing and fixing empty reports after migrating OBIEE authentication from database to Active Directory — reading the NQ query log for identity mismatch evidence, inspecting live session variables via the Administration Tool, tracing Init Block execution, correcting username format normalization, remapping AD groups to WebLogic Application Roles, updating connection pool credentials, and validating that data returns correctly after each fix.',
  category: 'obiee' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-25'),
  youtubeUrl: null,
  content: `## Overview

This runbook covers the complete diagnosis and remediation sequence for the most common post-migration OBIEE failure mode: users authenticate successfully against Active Directory but every report returns empty results. The steps proceed from log-based evidence gathering through targeted fixes for each of the three root causes — session variable identity mismatch, broken connection pool impersonation, and unmapped Application Roles.

**Environment assumptions**:
- OBIEE version: 12c (12.2.1.x) on-premises
- WebLogic version: 12.2.1.x
- Authentication: migrating from database authenticator to Active Directory LDAP
- OS: Oracle Linux / RHEL
- OBIEE instance name: \`coreapplication\`
- BI Server log path: \`\$ORACLE_INSTANCE/diagnostics/logs/OracleBIServerComponent/coreapplication_obis1/\`

---

## Phase 1: Pre-Diagnosis — Gather Baseline Information

Before touching any configuration, record the current state to enable comparison and rollback.

### 1.1 Export the Current RPD

\`\`\`bash
# Take a binary backup of the RPD before making any changes
# In OBIEE 12c: export from Enterprise Manager or from command line

cd \$ORACLE_HOME/user_projects/domains/bi/bitools/bin

# Export RPD online
./datamodel.sh exportrpd \\
  -o /backup/obiee_rpd_premigration_\$(date +%Y%m%d).rpd \\
  -P AdminPassword \\
  -U weblogic \\
  -SI ssi

echo "RPD backed up."
\`\`\`

### 1.2 Export the WebLogic Security Configuration

\`\`\`bash
# From WLST: export the security realm configuration including authenticator settings
\$ORACLE_HOME/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic', '<weblogic_password>', 't3://localhost:9500')
edit()
startEdit()
# Export authenticator configuration
exportSecurityConfiguration('/backup/wls_security_\$(date +%Y%m%d).xml')
stopEdit()
disconnect()
exit()
EOF
\`\`\`

### 1.3 Record Affected User Details

For each affected user, document:
- Their AD username (sAMAccountName)
- Their AD UPN (User Principal Name, typically \`firstname.lastname@company.com\`)
- Their previous database username (the short-form login that existed before migration)
- Which AD groups they belong to (run: \`gpresult /r\` on Windows, or query AD)
- Which OBIEE Application Roles they should have (check production RPD or previous system)

---

## Phase 2: Read the NQ Query Log

The NQ query log is the primary diagnostic tool. It shows the exact SQL OBIEE sends to the database, including all WHERE clause filters — which reveals whether the identity mismatch is producing incorrect filter values.

### 2.1 Increase Log Verbosity for the Affected User

Log into the OBIEE Administration Tool and connect to the online RPD:

\`\`\`
File → Open → Online
Server: localhost:9506   (BI Server port)
Username: weblogic (or an OBIEE Administrator account)
Password: <admin_password>
\`\`\`

Navigate to: **Manage → Sessions**

Find the affected user's active session. Right-click → **Set Log Level → 5**

Level 5 logs the full logical request, the logical SQL, the physical SQL with all bind variables resolved, and the session variable values used in each query.

### 2.2 Reproduce the Issue

Have the affected user run the failing report while log level 5 is active.

### 2.3 Locate and Read the Log Entry

\`\`\`bash
# Find recent entries in the NQ query log
LOGDIR="\$ORACLE_INSTANCE/diagnostics/logs/OracleBIServerComponent/coreapplication_obis1"
tail -500 "\${LOGDIR}/nqquery.log" | grep -A 30 "affected_username\|firstname.lastname@company.com\|Physical Query"
\`\`\`

**Evidence of Root Cause 1 — Username format mismatch in WHERE clause**:
\`\`\`
[Physical Query]
  SELECT ... FROM FACT_TABLE
  WHERE FACT_TABLE.ASSIGNED_USER = 'firstname.lastname@company.com'
  -- Expected: WHERE ASSIGNED_USER = 'DBUSER01'
  -- Result: 0 rows returned
\`\`\`

**Evidence of Root Cause 2 — Connection pool authentication failure**:
\`\`\`
[nQSError: 17001] Oracle Error code: 1017, message: ORA-01017: invalid username/password; logon denied
[nQSError: 43113] Message returned from OBIS.
\`\`\`

**Evidence of Root Cause 3 — Init Block returning no rows**:
\`\`\`
[Security] Initialization block 'User_Attributes_Init' executed SQL:
  SELECT REGION_CODE, ORG_CODE FROM USER_SECURITY_TABLE
  WHERE USER_ID = 'firstname.lastname@company.com'
Result: 0 rows. Variables USER_REGION, USER_ORG_CODE set to NULL.
\`\`\`

---

## Phase 3: Inspect Live Session Variables

### 3.1 View Session Variables in the Administration Tool

In the Administration Tool with the online RPD open:

\`\`\`
Manage → Sessions → [select affected user session]
→ Actions → View session variables
\`\`\`

Record the values of all session variables. Pay particular attention to:

| Variable | Expected Value | Actual Value (post-migration) | Action Needed |
|----------|----------------|-------------------------------|---------------|
| \`USER\` | \`DBUSER01\` | \`firstname.lastname@company.com\` | Add normalization Init Block |
| \`DISPLAYNAME\` | \`First Last\` | \`First Last\` (usually OK from AD) | None |
| \`USER_REGION\` | \`WEST\` | \`(blank)\` | Fix Init Block lookup key |
| \`USER_ORG\` | \`FIN\` | \`(blank)\` | Fix Init Block lookup key |

---

## Phase 4: Fix Root Cause 1 — Session Variable Identity Normalization

### 4.1 Identify All Init Blocks That Use :USER

In the Administration Tool (offline copy of RPD for editing):

\`\`\`
Manage → Variables → Initialization Blocks
→ Review each Init Block's Connection Pool and Default Initialization String
→ Note which Init Blocks use ':USER' as a query parameter
\`\`\`

### 4.2 Option A — Normalize the USER Variable at Login

Create a new Session Init Block that runs first (lowest execution order) to transform the AD-provided identity into the format expected by existing filters and Init Block lookups.

\`\`\`
Manage → Variables → New Session Variable:
  Name: NORMALIZED_USER
  Type: Dynamic

Manage → Variables → Initialization Blocks → New:
  Name: Normalize_User_Identity
  Execution Order: 1  (runs before all other Init Blocks)
  Connection Pool: (select any connection pool that can reach your Oracle DB)

Default Initialization String:
  SELECT UPPER(SUBSTR(':USER', 1,
    CASE WHEN INSTR(':USER','@') > 0
         THEN INSTR(':USER','@') - 1
         ELSE LENGTH(':USER')
    END))
  FROM DUAL

Variable Targets:
  NORMALIZED_USER → column 1
\`\`\`

This extracts the prefix before the \`@\` sign from a UPN. If AD sends \`firstname.lastname@company.com\`, \`NORMALIZED_USER\` becomes \`FIRSTNAME.LASTNAME\`. Adjust the SUBSTR/REPLACE logic to match whatever short-form your data tables use.

### 4.3 Update Existing Init Blocks to Use NORMALIZED_USER

For each Init Block that queries with \`:USER\`:

\`\`\`sql
-- Before:
SELECT REGION_CODE, ORG_CODE FROM USER_SECURITY_TABLE WHERE USER_ID = ':USER'

-- After:
SELECT REGION_CODE, ORG_CODE FROM USER_SECURITY_TABLE WHERE USER_ID = ':NORMALIZED_USER'
\`\`\`

### 4.4 Update RPD Data Filters

For each data filter in the Business Model layer that references \`NQ_SESSION.USER\`:

\`\`\`
Double-click the logical table source → Content tab → Where clause filter:
  Before: "FACT_TABLE"."ASSIGNED_USER" = VALUEOF(NQ_SESSION.USER)
  After:  "FACT_TABLE"."ASSIGNED_USER" = VALUEOF(NQ_SESSION.NORMALIZED_USER)
\`\`\`

### 4.5 Alternative Approach — Update the Data Tables

If the data warehouse's user reference columns can be updated to store UPN/email format, update the USER_SECURITY_TABLE and FACT_TABLE.ASSIGNED_USER values to match the AD UPN format instead of changing the RPD. This avoids RPD changes but requires a data migration in the warehouse:

\`\`\`sql
-- Update USER_SECURITY_TABLE to store AD UPN format
UPDATE USER_SECURITY_TABLE u
SET u.USER_ID = (
  SELECT ad.UPN
  FROM AD_USER_MAPPING ad
  WHERE ad.SHORT_NAME = u.USER_ID
);
COMMIT;
\`\`\`

---

## Phase 5: Fix Root Cause 2 — Connection Pool Credentials

### 5.1 Identify Connection Pools Using Pass-Through or USER-Based Logon

In the Administration Tool → Physical layer → connection pool properties for each pool:

\`\`\`
Right-click Connection Pool → Properties → General tab
  User: VALUEOF(NQ_SESSION.USER)   ← this is the pattern to fix
  Password: (blank, means pass-through)
\`\`\`

### 5.2 Switch to Fixed Service Account

The cleanest fix for most environments: replace the NQ_SESSION.USER-based logon with a dedicated BI service account that has SELECT access to all required tables. Enforce row-level security entirely through RPD data filters (Root Cause 1 approach) rather than database-level VPD:

\`\`\`
Connection Pool → General tab:
  Authentication: Use specified user name and password
  User: BISVC_ACCOUNT
  Password: <service_account_password>
\`\`\`

### 5.3 If VPD Must Be Retained — Grant Proxy Authentication for AD Identities

If VPD enforcement at the database layer is required, the database must recognize the AD identity format. Configure Oracle Database proxy authentication for AD users:

\`\`\`sql
-- Grant proxy authentication to the BISVC_ACCOUNT for AD-format usernames
-- (requires users to exist in the database, or use enterprise users with OID)
ALTER USER BISVC_ACCOUNT GRANT CONNECT THROUGH <service_account>;

-- For Enterprise User Security with OID/AD mapping:
-- Follow Oracle EUS (Enterprise User Security) setup — map AD identities
-- to Oracle database schema users via the Oracle Internet Directory
\`\`\`

---

## Phase 6: Fix Root Cause 3 — Map AD Groups to OBIEE Application Roles

### 6.1 Identify Required Application Roles

In the RPD → Security → Application Roles:

\`\`\`
Manage → Security → Application Roles
→ List all roles and their associated data filter permissions
→ Note which roles the affected users should have
\`\`\`

### 6.2 Map AD Groups to WebLogic Global Roles

Log into the WebLogic Console (\`http://localhost:9500/console\`):

\`\`\`
Security Realms → myrealm → Roles and Policies → Global Roles
→ Find or create a role for each OBIEE Application Role
→ Edit role conditions:

Role Name: BIAdministrators
Conditions: Group: CN=OBIEE_Admins,OU=Groups,DC=company,DC=com

Role Name: BIViewers
Conditions: Group: CN=OBIEE_Viewers,OU=Groups,DC=company,DC=com

Role Name: BIAuthors
Conditions: Group: CN=OBIEE_Authors,OU=Groups,DC=company,DC=com
\`\`\`

### 6.3 Map WebLogic Global Roles to OBIEE Application Roles

In the RPD → Security → Application Roles:

\`\`\`
Double-click Application Role: BIAdministrators
→ Add: WebLogic Global Role → BIAdministrators
  (this links the WebLogic role to the OBIEE RPD role)
\`\`\`

This creates the chain:
\`\`\`
AD User → AD Group (CN=OBIEE_Admins) → WebLogic Global Role (BIAdministrators) → OBIEE Application Role (BIAdministrators) → RPD data filters
\`\`\`

### 6.4 Enable Identity Virtualization in WebLogic

If mixing the LDAP authenticator with the default authenticator (for maintaining local admin accounts), WebLogic must be configured to virtualize — aggregate — group memberships from all providers:

\`\`\`
WebLogic Console → Security Realms → myrealm
→ Providers tab → Authentication Providers
  → Set LDAP Authenticator Control Flag: SUFFICIENT
  → Set Default Authenticator Control Flag: SUFFICIENT

→ Configuration tab → General
  → Check: "Use Identity Domains" = No (on-premises)
  → Advanced: Add attribute: Virtualize = true
\`\`\`

\`\`\`bash
# Alternatively, set Virtualize via WLST:
\$ORACLE_HOME/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<password>','t3://localhost:9500')
edit()
startEdit()
realm = cmo.getSecurityConfiguration().getDefaultRealm()
realm.setVirtualize(true)
activate()
disconnect()
exit()
EOF
\`\`\`

**Restart the WebLogic Admin Server and Managed Servers after this change.**

---

## Phase 7: Deploy and Test RPD Changes

### 7.1 Validate RPD Changes in Offline Mode

Before deploying, run the RPD consistency check:

\`\`\`
In Administration Tool → File → Check Global Consistency (Ctrl+K)
→ Review and resolve all errors (not warnings) before publishing
\`\`\`

### 7.2 Deploy Updated RPD via Enterprise Manager

\`\`\`
EM Fusion Middleware Control → Business Intelligence → coreapplication
→ Deployment tab → Lock and Edit Configuration
→ Repository section → Upload BI Server Repository
→ Browse → select updated RPD file
→ Enter RPD password
→ Apply → Activate Changes
→ Restart Required: restart BI Server component only (not full domain)
\`\`\`

Or via command line:
\`\`\`bash
cd \$ORACLE_HOME/user_projects/domains/bi/bitools/bin
./datamodel.sh uploadrpd \\
  -I /backup/obiee_rpd_updated_\$(date +%Y%m%d).rpd \\
  -P <rpd_password> \\
  -U weblogic \\
  -SI ssi
\`\`\`

### 7.3 Restart the BI Server Component

\`\`\`bash
# Restart only the BI Server (not full domain restart)
\$ORACLE_HOME/user_projects/domains/bi/bitools/bin/stop.sh -i obis1
\$ORACLE_HOME/user_projects/domains/bi/bitools/bin/start.sh -i obis1
\`\`\`

---

## Phase 8: Validation Checklist

After each fix is applied, validate before moving to the next:

### 8.1 Session Variable Validation

\`\`\`
Administration Tool → Manage → Sessions → [affected user]
→ View session variables

Expected after fix:
  USER            = firstname.lastname@company.com   (AD UPN — unchanged)
  NORMALIZED_USER = DBUSER01                          (extracted short form)
  USER_REGION     = WEST                              (now populated from Init Block)
  USER_ORG        = FIN                               (now populated from Init Block)
\`\`\`

### 8.2 Data Return Validation

\`\`\`
□ Affected user logs in to OBIEE
□ Navigate to the previously-empty dashboard
□ Report executes and returns data rows (not empty)
□ Data visible is correctly scoped — user sees only their assigned region/org/cost center
□ Data visible is NOT unrestricted — user cannot see data outside their scope
  (this would indicate filters are bypassed, which is a security regression)
□ Admin user sees all data (no filter applied to admin role)
\`\`\`

### 8.3 NQ Log Confirmation

\`\`\`bash
# Confirm WHERE clause in physical SQL now uses normalized username
tail -200 "\${LOGDIR}/nqquery.log" | grep "WHERE.*ASSIGNED_USER"
# Expect: WHERE ASSIGNED_USER = 'DBUSER01'
# Not:    WHERE ASSIGNED_USER = 'firstname.lastname@company.com'
\`\`\`

### 8.4 Application Role Validation

\`\`\`
Administration Tool → Manage → Sessions → [affected user]
→ View Groups and Roles

Expected:
  Groups:          CN=OBIEE_Viewers,OU=Groups,DC=company,DC=com   (from AD)
  WebLogic Roles:  BIViewers
  OBIEE App Roles: BIViewers
\`\`\`

If groups are empty, Identity Virtualization is not working — recheck the Virtualize setting and ensure WebLogic was restarted after the change.

---

## Phase 9: Rollback Procedure

If fixes produce unexpected results, roll back in reverse order:

\`\`\`bash
# 1. Restore original RPD from backup
./datamodel.sh uploadrpd \\
  -I /backup/obiee_rpd_premigration_<date>.rpd \\
  -P <rpd_password> \\
  -U weblogic -SI ssi

# 2. Restart BI Server
./stop.sh -i obis1 && ./start.sh -i obis1

# 3. Restore WebLogic security configuration
# Re-import from /backup/wls_security_<date>.xml via WebLogic Console
# Security Realms → myrealm → Migration → Import

# 4. Re-enable database authenticator if it was disabled
# WebLogic Console → Security Realms → myrealm → Providers
#   → Set database authenticator Control Flag: REQUIRED
#   → Set LDAP authenticator Control Flag: OPTIONAL
\`\`\`

---

## Quick Reference

| Symptom | Diagnostic | Likely Root Cause | Fix |
|---------|-----------|-------------------|-----|
| Reports empty, no error | Check NQ log WHERE clause | RPD filter using wrong username format | Add NORMALIZED_USER Init Block |
| Init Block variables blank | Check session variables in Manage → Sessions | Init Block lookup key format mismatch | Update Init Block SQL to use NORMALIZED_USER |
| ORA-01017 in NQ log | Connection pool logon failure | Connection pool passing AD UPN to database | Switch to fixed service account |
| All data visible (no filter) | Check data filters in RPD | VPD fallback to service account | Re-check connection pool config |
| Groups empty in session | Check Manage → Sessions → Roles | Identity Virtualization not enabled | Set Virtualize=true in WebLogic realm |
| AD groups present but no OBIEE roles | Check Global Role conditions | AD groups not mapped to WebLogic roles | Add group conditions to Global Roles |

| File/Location | Purpose |
|---------------|---------|
| \`\$ORACLE_INSTANCE/diagnostics/logs/.../nqquery.log\` | Physical SQL and session variable values |
| Administration Tool → Manage → Sessions | Live session variable inspection |
| Administration Tool → Manage → Variables → Init Blocks | Init Block SQL and variable mapping |
| Administration Tool → Security → Application Roles | OBIEE role to permission mapping |
| WebLogic Console → Security Realms → myrealm → Providers | LDAP authenticator and Virtualize setting |
| WebLogic Console → Security Realms → Global Roles | AD group to WebLogic role mapping |`,
};

async function main() {
  console.log('Inserting OBIEE AD authentication runbook...');
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
