import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Identity Management: OAM, OIM, and OID Architecture and Administration',
  slug: 'oracle-identity-management-oam-oim-oid',
  excerpt:
    'A technical overview of Oracle Identity and Access Management — covering Oracle Access Manager (OAM) SSO and WebGate architecture, Oracle Identity Manager (OIM/OIG) user provisioning workflows, Oracle Internet Directory (OID) and Oracle Unified Directory (OUD) LDAP administration, how the components integrate, and the administration tasks unique to each tier.',
  category: 'identity-management' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-12'),
  youtubeUrl: null,
  content: `Oracle Identity Management (Oracle IAM) is a suite of components that together handle authentication, authorisation, directory services, and user lifecycle management across an enterprise. The three core components are Oracle Access Manager (OAM), Oracle Identity Manager (OIM), and Oracle Internet Directory (OID) or its successor Oracle Unified Directory (OUD).

Understanding how they interact — and which tier owns which responsibility — is the starting point for administering or troubleshooting an Oracle IAM deployment.

---

## The Oracle IAM Stack

\`\`\`
External Users / Internal Employees
            │
            │ HTTPS
            ▼
┌───────────────────────────────────────┐
│  Oracle HTTP Server (OHS) + WebGate   │  ← Authentication enforcement point
│  - Intercepts every request           │
│  - Redirects unauthenticated users    │
│    to OAM login page                  │
│  - Validates OAM SSO cookie           │
└───────────────┬───────────────────────┘
                │ (authenticated requests pass through)
                ▼
┌───────────────────────────────────────┐
│  Oracle Access Manager (OAM)          │  ← Authentication & SSO engine
│  - Login page and credential          │
│    collection                         │
│  - Policy evaluation (who can         │
│    access what)                       │
│  - Issues SSO tokens (ObSSOCookie)    │
│  - Integrates with OID/OUD for        │
│    password validation                │
└───────────────┬───────────────────────┘
                │
                ▼
┌───────────────────────────────────────┐
│  Oracle Internet Directory (OID)      │  ← LDAP directory — source of truth
│  or Oracle Unified Directory (OUD)    │    for user identities and passwords
│  - Stores user accounts, groups,      │
│    org units                          │
│  - LDAP bind validation for OAM       │
│  - Password policy enforcement        │
└───────────────┬───────────────────────┘
                │
                ▼
┌───────────────────────────────────────┐
│  Oracle Identity Manager (OIM/OIG)    │  ← User provisioning and governance
│  - Self-service registration          │
│  - Approval workflows for access      │
│  - Creates/modifies/disables          │
│    accounts in OID and target systems │
│  - Reconciliation from HR systems     │
│  - Access certification campaigns     │
└───────────────────────────────────────┘
\`\`\`

---

## Oracle Access Manager (OAM)

OAM is the authentication and single sign-on engine. Once a user authenticates to OAM, they receive an SSO cookie (\`ObSSOCookie\` in 11g, \`OAMAuthnCookie\` in 12c) that is trusted by all WebGate-protected applications — the user does not need to log in again when moving between protected resources.

### WebGate

The WebGate is an OHS/Apache plugin (\`webgate.so\`) installed on the web server in front of each protected application. It intercepts every HTTP request and:

1. Checks whether the request URL matches a protected resource in the OAM policy store
2. If protected and no valid SSO cookie exists — redirects to the OAM login page
3. If a valid cookie exists — validates it with the OAM Server and passes the request through, injecting HTTP headers with the user identity

\`\`\`
Request arrives at OHS
        │
        ▼
WebGate checks: is this URL in a protected policy?
        │
        ├── No protection policy → pass through without authentication
        │
        └── Protected policy found
                │
                ├── Valid ObSSOCookie present?
                │       ├── Yes → validate with OAM Server → inject headers → pass through
                │       └── No  → redirect to OAM login URL
                                        │
                                OAM collects credentials
                                validates against OID/AD
                                issues ObSSOCookie
                                redirects back to original URL
\`\`\`

### OAM Policy Model

OAM policies are organised hierarchically:

**Identity Domain** (12c: Application Domain) → **Authentication Policy** → **Authorisation Policy** → **Resource**

| Object | Purpose |
|--------|---------|
| Application Domain | Groups related resources and policies (e.g., "EBS Suite", "HR Portal") |
| Authentication Scheme | Defines how users prove identity (Form, Basic, X.509 cert) |
| Authentication Policy | Maps URL patterns to Authentication Schemes |
| Authorisation Policy | Maps URL patterns to conditions (group membership, time of day, IP range) |
| Resource | A specific URL pattern being protected |

### OAM Authentication Schemes

| Scheme | Method | Use Case |
|--------|--------|---------|
| LDAP | Username/password validated against OID/OUD | Standard intranet SSO |
| Kerberos | Windows Integrated Authentication (NTLM/Kerberos ticket) | Domain-joined Windows clients |
| X.509 | Client certificate authentication | High-assurance, B2B |
| Multi-Factor | OTP + LDAP combination | External-facing, privileged access |
| Custom | Pluggable via IAP (Identity Assertion Provider) | Legacy systems |

---

## Oracle Internet Directory (OID) and Oracle Unified Directory (OUD)

OID and OUD are Oracle's LDAP v3 directory servers. OID is the older product (built on Oracle Database as its backend). OUD is the modern replacement — it does not use an Oracle Database backend, is written in Java, and is the recommended choice for new deployments.

### LDAP Directory Information Tree (DIT)

\`\`\`
dc=corp,dc=local                    ← Root suffix
│
├── ou=People                        ← User accounts
│   ├── uid=jsmith,ou=People,...     ← Individual user entry
│   └── uid=ajonas,ou=People,...
│
├── ou=Groups                        ← Group definitions
│   ├── cn=EBS_Users,ou=Groups,...
│   └── cn=DBA_Admins,ou=Groups,...
│
├── ou=OracleContext                  ← Oracle product configuration
│   └── cn=Products
│       └── cn=OracleAS,...
│
└── ou=Services                      ← Service accounts
    └── uid=oam_bind,ou=Services,...  ← OAM's bind account
\`\`\`

### Key LDAP Attributes for OAM Integration

OAM uses the following attributes from each user entry:

| LDAP Attribute | Purpose |
|---------------|---------|
| \`uid\` | Login name |
| \`userPassword\` | Hashed password (OID/OUD validates binds against this) |
| \`cn\` | Common name (display name) |
| \`mail\` | Email address — passed to applications via HTTP header |
| \`memberOf\` | Group memberships — used in OAM authorisation policies |
| \`orclIsEnabled\` | OID-specific: whether the account is active |
| \`pwdAccountLockedTime\` | Password policy: account lockout timestamp |
| \`pwdFailureTime\` | Password policy: failed attempt timestamps |

### OUD vs OID

| Feature | OID 11g | OUD 12c |
|---------|---------|---------|
| Backend storage | Oracle Database | Built-in LDAP-native storage |
| Performance | Limited by DB I/O | Scales to tens of millions of entries |
| Replication | Oracle Database replication | Built-in LDAP replication (multi-master) |
| Virtual Directory | No | OUD includes virtual directory capability |
| Password policy | Oracle-specific attributes | Standard LDAP password policy (RFC 3112) |
| Installation footprint | Requires Oracle Database | Standalone, no DB dependency |

---

## Oracle Identity Manager (OIM / Oracle Identity Governance)

OIM handles the lifecycle of user accounts across all connected systems. It is the layer that says: "When a new employee is hired in the HR system, create accounts in OID, Active Directory, EBS, and Salesforce — and when they leave, disable them all."

### OIM Architecture

\`\`\`
HR System (PeopleSoft / Fusion HCM)
        │
        │ Scheduled reconciliation / event trigger
        ▼
Oracle Identity Manager (OIM)
        │
        ├── User Management Engine
        │     ├── User creation/modification/deletion
        │     ├── Role assignment
        │     └── Access request workflows
        │
        ├── Connector Framework (ICF)
        │     ├── OID/OUD Connector
        │     ├── Active Directory Connector
        │     ├── Oracle EBS Connector
        │     └── Database User Management Connector
        │
        ├── Workflow Engine (SOA Suite / BPEL)
        │     ├── Approval workflows
        │     ├── Notification (UMS email/SMS)
        │     └── Audit trail
        │
        └── Access Certification (OIG)
              └── Periodic review of who has access to what
\`\`\`

### User Lifecycle in OIM

\`\`\`
1. Trigger: HR system adds new employee
        │
2. OIM Reconciliation: OIM reads HR record, creates OIM user
        │
3. Role Assignment: OIM applies roles based on job code + department
        │
4. Provisioning: OIM creates accounts in each target system
        │   ├── OID: creates ldap entry, sets password
        │   ├── AD: creates AD account
        │   ├── EBS: creates FND_USER record
        │   └── Other connected resources
        │
5. Notification: Welcome email sent to user and manager
        │
6. At termination: HR triggers disable event
        │
7. OIM disables/locks accounts across all connected resources
\`\`\`

### Reconciliation vs Provisioning

**Provisioning** is push — OIM pushes changes to target systems when a user's status or role changes in OIM.

**Reconciliation** is pull — OIM reads the current state from a target system and reconciles it against what OIM believes should be there. Used to detect:
- Accounts created directly in the target system (not via OIM)
- Accounts not yet in OIM (new employees loaded from HR)
- Accounts deleted in the target but still active in OIM

---

## Integration: How OAM, OID, and OIM Work Together

The three components divide responsibilities cleanly:

| Question | Component |
|----------|-----------|
| "Is this user who they claim to be?" | OAM + OID (authentication) |
| "Is this user allowed to access this URL?" | OAM (authorisation policy) |
| "Does this user exist in the directory?" | OID/OUD |
| "How did this user get their access?" | OIM (provisioning history) |
| "Should this user still have this access?" | OIG (certification) |

### Session Flow for EBS with OAM SSO

\`\`\`
1. User navigates to https://ebs.corp.local/OA_HTML/AppsLogin.jsp

2. OHS WebGate intercepts — checks OAM policy for /OA_HTML/*
   → Protected. No valid SSO cookie present.
   → Redirect to OAM login: https://oam.corp.local/oam/server/auth_cred_submit

3. OAM presents login form. User enters uid=jsmith, password.

4. OAM binds to OID as jsmith: ldap_bind(uid=jsmith,ou=People,dc=corp,dc=local, password)
   → OID validates password, returns success

5. OAM evaluates authorisation policy: is jsmith in EBS_Users group?
   → OID: memberOf check → cn=EBS_Users,ou=Groups,dc=corp,dc=local → Yes

6. OAM issues ObSSOCookie, redirects browser back to EBS URL

7. WebGate re-intercepts. Valid cookie present.
   → WebGate validates with OAM Server
   → Injects HTTP headers: OAM_REMOTE_USER=jsmith, OAM_GROUPS=EBS_Users,...
   → Passes request to EBS OHS

8. EBS AutoLogin reads OAM_REMOTE_USER header → logs in jsmith without password
\`\`\`

### EBS AutoLogin Configuration (Key Profile Options)

| Profile Option | Value |
|----------------|-------|
| \`APPS_SSO\` | \`SSWA_WEB_SSO\` |
| \`APPS_SSO_DEPLOY_MODE\` | \`SSWA_WEB_SSO\` |
| \`APPS_SSO_LDAP_SYNC\` | \`Y\` |
| \`ICX_SESSION_TIMEOUT\` | Match OAM session idle timeout |

---

## High Availability Considerations

All three components need HA treatment for production:

**OAM:** Deploy two OAM Managed Servers behind an OHS/load balancer. OAM session state is stored in a shared database (MDS schema) — both servers read and write the same session store, enabling transparent failover.

**OID:** Use Oracle Data Guard on the underlying Oracle Database. Multi-master replication across data centres requires Oracle Internet Directory Replication.

**OUD:** Built-in multi-master replication. Add two or more OUD instances; configure replication topology via \`dsreplication\`. OUD does not require a separate database for HA.

**OIM:** Deploy two OIM Managed Servers in a WebLogic cluster. OIM stores workflow state in an Oracle Database (via SOA infrastructure). Use Data Guard for the OIM database.

The companion runbook covers the complete health check procedure for all three tiers, key log locations, common troubleshooting scenarios, and the WLST and \`ldapsearch\` commands used in day-to-day OIM/OAM/OID administration.`,
};

async function main() {
  console.log('Inserting Oracle Identity Management blog post...');
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
