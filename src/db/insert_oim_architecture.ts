import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Identity Manager (OIM) 12c: User Provisioning, Roles, and Connector Architecture',
  slug: 'oracle-identity-manager-oim-architecture-provisioning',
  excerpt:
    'A comprehensive guide to Oracle Identity Manager 12c: the provisioning engine architecture, Identity Connector Framework (ICF) connectors, role and entitlement model, request catalog and approval workflows, reconciliation, and integration with OAM and OID/OUD for end-to-end identity lifecycle management.',
  category: 'identity-management' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-07'),
  youtubeUrl: null,
  content: `## Introduction

Oracle Identity Manager (OIM) 12c — previously known as Oracle Identity Governance (OIG) — is Oracle's enterprise identity lifecycle management platform. Where Oracle Access Manager handles access control (who can access what right now), OIM handles identity governance (who should have access, how access is requested and approved, and how it is provisioned and deprovisioned across connected systems). OIM manages the full lifecycle of a user identity from joiner (new hire provisioning) through mover (role change) to leaver (account deactivation and deprovisioning).

In a complete Oracle IAM deployment, OIM and OAM are complementary: OIM provisions user accounts in LDAP (OID/OUD) and target systems (EBS, Active Directory, databases, SaaS), OAM uses those LDAP accounts to authenticate and authorise users at the web tier. The integration between OIM and OAM ensures that when OIM provisions or deprovisions an account, access policy changes take effect immediately without manual intervention.

This post covers OIM's architecture, its connector model, the role and entitlement framework, request workflows, and reconciliation.

---

## OIM 12c Architecture Components

### OIM Server

OIM runs as a Java EE application on WebLogic Server, deployed as one or more OIM Managed Server instances in a WebLogic domain. The domain also hosts:
- **Oracle SOA Suite**: OIM uses SOA BPEL for approval workflow orchestration. All multi-step approval processes (request approval, role approval, certification) are implemented as SOA composite applications deployed in the OIM domain.
- **Design Console**: A Java Swing desktop application for administrative configuration (connector deployment, process definition, adapter configuration).
- **OIM Admin Console**: A web-based console for operational administration (user management, role management, request management, system configuration).

### Repository Database

OIM requires an Oracle Database (19c or later) as its repository. This database stores:
- User profiles, accounts, and entitlements
- Role definitions and role hierarchy
- Connector configuration and IT resource definitions
- Process task definitions and workflow state
- Audit and access history
- Pending and completed request data

The repository database is the most critical component in the OIM infrastructure — its availability directly determines OIM availability.

### Identity Connector Framework (ICF)

OIM provisions and reconciles with target systems through the Identity Connector Framework (ICF), an open standard connector API. Each connector is a Java bundle (JAR) deployed in OIM that implements the ICF SPI (Service Provider Interface) for a specific target system.

Connector types:
- **Oracle Connector Pack**: Pre-built connectors for Oracle EBS, Oracle Database, Oracle Directory (OID/OUD), Oracle E-Business Suite, PeopleSoft
- **Active Directory / LDAP**: Microsoft AD, generic LDAP, Open LDAP, OUD
- **Unix/Linux**: SSH-based connector for Linux/Unix account management
- **Cloud connectors**: Salesforce, ServiceNow, Workday, Office 365, Google Workspace
- **Custom ICF connectors**: Built using the ICF Java API for proprietary systems

Each connector is configured via an **IT Resource** definition in OIM — the IT Resource stores the target system hostname, port, credentials, and connection parameters (equivalent to an Oracle database db link, but for identity management).

### SOA Suite Integration

Every OIM approval workflow is a SOA composite deployed on the co-located SOA Suite. When a user submits an access request:
1. OIM creates a request object in its database
2. OIM triggers the associated SOA BPEL process via web service
3. The BPEL process routes approval tasks to approvers (via Human Workflow)
4. Each approval step creates a worklist task in the OIM/SOA worklist application
5. When all approvals complete, BPEL calls back OIM via web service to provision access
6. OIM executes the provisioning workflow via the ICF connector

The SOA dependency is significant from an operations perspective — SOA Managed Server must be running for any OIM approval workflow to function. SOA infrastructure (Coherence, MDS, SOAINFRA schema) must be healthy for OIM to process requests.

---

## Identity Lifecycle: Joiner, Mover, Leaver

### Joiner (New User Provisioning)

A new employee record arrives in OIM via a trusted source (HR system). OIM supports HR feed via:
- **Trusted source reconciliation**: HR system pushes flat file (CSV, XML) or OIM polls HR via a connector; OIM creates the master user profile
- **Direct API**: HR system calls OIM's SPML or REST API to create the user

Once the OIM master user profile exists, OIM evaluates **role assignment rules** (automated role grants based on user attributes: department, job code, location). Each role carries one or more **entitlements** — specific accounts and permissions in target systems. OIM provisions those entitlements automatically via the ICF connectors:
- Creates the user in OID/OUD (the LDAP account OAM uses for authentication)
- Creates the EBS user account and assigns responsibilities
- Creates the AD account and adds to distribution/security groups
- Creates the Unix account on relevant servers

### Mover (Role Change)

When a user transfers departments, their HR record updates. OIM's reconciliation detects the attribute change and re-evaluates role assignments:
- Roles no longer applicable to the new job code are revoked
- New applicable roles are granted
- OIM deprovisions removed entitlements and provisions new ones automatically

This is the identity governance answer to one of the most common compliance failures: employees who transfer departments and retain access from their previous role (privilege accumulation).

### Leaver (Deprovisioning)

When an employee terminates, HR updates the status. OIM detects the change via reconciliation and executes the leaver workflow:
1. Disable the OID/OUD account immediately (OAM can no longer authenticate the user)
2. Disable or lock accounts in all connected target systems
3. After a configurable retention period, delete accounts and remove entitlements
4. Archive user data per retention policy

Automated leaver processing eliminates the manual deprovisioning gap — the most common source of audit findings (ex-employees with active accounts).

---

## Role and Entitlement Model

### Roles

OIM roles are business-level groupings of entitlements that correspond to job functions. Examples: "HR Analyst", "Finance Read Only", "IT Administrator — Linux". Roles have a lifecycle: they are requested, approved, assigned, reviewed (certification), and revoked.

**Role hierarchy**: Roles can include other roles (parent-child role composition). An "IT Manager" role might include the "Linux Administrator" role, which includes the "SSH Access — Production" entitlement.

**Role categories**: OIM supports role categories (IT Roles, Business Roles, Default Roles) for organising large role catalogues.

**Segregation of Duties (SoD)**: OIM can enforce SoD rules that prevent a single user from holding incompatible roles — for example, preventing the same person from having both "Create Payment" and "Approve Payment" roles. SoD can be enforced at request time (preventive control) or detected via reporting (detective control).

### Entitlements

An entitlement is a specific permission granted in a target system: a Unix group membership, an EBS responsibility, an AD security group, a database role. Entitlements are attached to OIM roles. When OIM grants a role, it provisions all attached entitlements via ICF connectors.

Entitlements can also be requested directly (without a role) — users can request specific EBS responsibilities or AD group memberships from the request catalog.

### Access Request Catalog

The OIM request catalog is the self-service portal where users (and managers/admins on behalf of users) can browse and request:
- Pre-defined roles
- Individual entitlements (application accounts, groups)
- Custom catalog items (access packages)

Catalog items have descriptions, owners, risk levels, and approval policies. Users browse the catalog, add items to a "shopping cart," and submit the request. The approval workflow routes the request to the defined approvers (manager, role owner, application owner, IT security) in sequence or parallel.

---

## Reconciliation

Reconciliation is OIM's mechanism for detecting and synchronising identity data from external sources. There are two reconciliation directions:

### Trusted Source Reconciliation (Inbound)

Trusted source reconciliation imports authoritative identity data from HR or another source of truth into OIM's user store. OIM creates or updates master user profiles based on the incoming data. This is the "joiner" trigger.

Reconciliation modes:
- **Full reconciliation**: Import all records from the source; create/update as needed. Run initially and periodically (weekly).
- **Incremental reconciliation**: Import only records changed since the last run (using a change timestamp or watermark). Run frequently (hourly or continuous via event listener).

### Target Resource Reconciliation (Outbound)

Target resource reconciliation reads accounts from a target system (e.g., Active Directory, Oracle Database) and compares them against what OIM believes it has provisioned. Discrepancies trigger reconciliation events:
- Account exists in AD but OIM has no record → unmatched account (possible orphan, requires remediation)
- Account attribute differs between AD and OIM → drift (AD was modified outside OIM)
- Account in OIM is marked active but disabled in AD → manual intervention in target (flag for review)

Regular reconciliation is the mechanism that keeps OIM's view of the world consistent with actual target system state — essential for accurate access certification reporting.

---

## Access Certification

OIM's access certification (also called access review or recertification) provides periodic review of all user access entitlements. OIM generates certification campaigns that assign reviewers (typically managers or application owners) a list of access assignments to certify or revoke:

- Manager certifies their direct reports' role and entitlement assignments
- Application owner certifies who has access to their application
- Entitlement owner certifies who holds a specific sensitive entitlement (e.g., DBA role)

Reviewers approve or revoke assignments in the OIM worklist. Revoked assignments trigger deprovisioning workflows automatically. Certification history provides the audit trail required by SOX, ISO 27001, PCI-DSS, and similar compliance frameworks.

---

## OIM + OAM Integration

### Direct Integration

When OAM and OIM are deployed in the same WebLogic domain (the recommended "collocated" topology), OAM uses OIM as the identity provider:
- OAM authentication policies reference the OIM user store (via OUD/OID)
- OIM admin console is protected by OAM — OIM admins SSO with their enterprise credentials
- OAM session management triggers OIM audit events for compliance reporting

### Delegated Authentication

OIM can be configured to use OAM for authentication to the OIM self-service and admin consoles — so OIM users log in via OAM's login page, get the OAM SSO cookie, and can navigate between OIM self-service and other SSO-protected applications without repeated logins.

### SCIM Provisioning

In modern deployments, OIM provisions to OAM's policy store via SCIM REST APIs — user group memberships provisioned by OIM automatically update OAM authorisation policies without manual intervention.

---

## OIM and Oracle E-Business Suite

OIM's Oracle EBS connector provisions EBS user accounts and responsibilities. The EBS connector uses OIM's target resource reconciliation to detect accounts created directly in EBS (outside OIM) and matches them to OIM user profiles.

Key EBS provisioning capabilities via OIM:
- Create/update/disable/delete FND_USER accounts
- Assign/revoke EBS responsibilities
- Manage EBS user-organisation security profiles
- Propagate effective-dated changes (responsibilities with start/end dates)
- Reconcile EBS-side changes (manually assigned responsibilities detected by reconciliation)

The OIM-EBS integration requires the EBS connector (from Oracle Connector Pack for EBS) and an IT Resource configured with the EBS APPS schema credentials and JDBC URL.

---

## Common Administration Tasks

**User account unlock**: Users who fail OIM authentication (via OAM) are locked out at the LDAP level. OIM admin console: Users → search → Unlock Account. Or via OIM REST API for bulk unlocks.

**Orphan account remediation**: Target reconciliation finds unmatched accounts. OIM console: Provisioning → Reconciliation → Unmatched Accounts. Options: link to an existing OIM user (match), or flag as orphan for manual deprovisioning.

**Workflow hung in SOA**: Approval requests stuck in SOA can be diagnosed via the SOA Enterprise Manager console: \`http://oim-server:8001/em\`. Check composite instance state, review audit trail, retry or abort stuck instances.

**Role provisioning failure**: Check OIM provisioning workflow: Provisioning → Accounts → [user] → [provisioned resource] → Process Tasks. Failed task shows the error from the ICF connector. Common causes: target system unavailable, credential rotation on IT Resource, LDAP permission error.

---

## Conclusion

Oracle Identity Manager 12c provides the governance layer that complements OAM's access enforcement. OIM ensures that access is not just controlled but properly approved, provisioned through auditable workflows, and regularly reviewed through certification campaigns. The ICF connector model gives OIM the reach to govern identities across heterogeneous IT ecosystems — from Oracle EBS to Active Directory to cloud SaaS applications. For enterprises subject to SOX, PCI, or ISO 27001, the combination of OIM automated provisioning/deprovisioning and periodic access certification provides both the preventive controls and the audit evidence that compliance frameworks require.

The companion runbook provides step-by-step instructions for installing OIM 12c and configuring the EBS connector.`,
};

async function main() {
  console.log('Inserting OIM architecture post...');
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
