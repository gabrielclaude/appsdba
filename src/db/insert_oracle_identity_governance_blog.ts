import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Identity Governance: Architecture, Implementation, and Operational Management',
  slug: 'oracle-identity-governance-implementation',
  excerpt: 'A comprehensive guide to Oracle Identity Governance (OIG) — covering the full stack architecture, user lifecycle management, role-based access control, access certification, reconciliation, and the database schema every OIG DBA must know.',
  category: 'identity-management' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-02'),
  youtubeUrl: null,
  content: `## Introduction

Oracle Identity Governance (OIG) — formerly Oracle Identity Manager (OIM) — is Oracle's enterprise identity administration and governance platform. It automates user lifecycle management (joiner/mover/leaver), role-based access control, access certification, and segregation of duties policy enforcement across heterogeneous IT environments.

For DBAs, OIG is both a consumer of Oracle Database infrastructure and a system that directly impacts every application in the estate. When provisioning breaks, users cannot get access. When reconciliation lags, access reviews are based on stale data. The DBA who understands OIG's internals — its schema, its orchestration model, its SOA dependency — is the person who gets called at 2 a.m. when provisioning grinds to a halt.

This post covers the full OIG stack: architecture, key capabilities, critical database tables, performance considerations, common failure patterns, and integration with Oracle E-Business Suite.

---

## OIG Architecture

OIG is a multi-tier Java EE platform that spans Oracle WebLogic Server, Oracle SOA Suite, and an Oracle Database backend. The components are tightly coupled — a problem in any one layer ripples into the others.

\`\`\`
[Users / Helpdesk]           [Target Systems]
       |                    AD / LDAP / EBS / DB
       v                           ^
[OIG Self-Service UI]              |
[OIG Admin Console ]     [Connector Framework]
       |                           |
[OIG Server (WebLogic)]----[Connector Server]
       |          |
  [SOA Suite]  [Scheduler]
       |
[Oracle Database]
 OIM | MDS | SOAINFRA | STB
\`\`\`

### OIG Server

OIG is deployed as a Java EE application on Oracle WebLogic Server 12.2.1.4 or later. It runs as one or more managed servers in a WebLogic domain (typically named \`oim_server1\`, \`oim_server2\` in clustered environments). All OIG business logic — policy evaluation, provisioning orchestration, role management, and the scheduler — executes inside this JVM.

WebLogic data sources connect OIG to the Oracle Database: \`oimOperationsDB\` handles transactional OIG operations, and \`oimJMSStoreDB\` persists JMS messages used for asynchronous provisioning events.

### Oracle SOA Suite

OIG delegates multi-step approval workflows to an embedded Oracle SOA/BPEL engine. SOA Suite runs as a co-deployed or separate managed server cluster (typically \`soa_server1\`). Every provisioning request that requires approval travels through a SOA BPEL composite, where it waits for human task completion (manager approval, application owner approval, security team sign-off) before returning to OIG to execute the actual provisioning.

The SOA BPEL engine persists workflow state in the \`SOAINFRA\` Oracle schema — specifically in the \`CUBE_INSTANCE\` and related tables. This is the most write-intensive component of the entire stack.

A healthy SOA server is a prerequisite for OIG provisioning. If SOA composites fault, provisioning requests silently stall with "Awaiting Approval" status even when approvals have been granted.

### Oracle Database

All OIG persistent state lives in Oracle Database. The RCU (Repository Creation Utility) creates four schemas:

- **OIM_OIM** (or your prefix + \`_OIM\`): The OIG application schema — users, accounts, roles, entitlements, policies, orchestration history, audit trails.
- **OIM_MDS**: Metadata Services schema — UI customizations, workflow definitions, connector metadata, sandbox configurations.
- **OIM_SOAINFRA**: SOA Suite's operational schema — BPEL composite instances, human task state, composite deployment descriptors.
- **OIM_STB**: Service Table schema — shared infrastructure used by Fusion Middleware for service registry.

In high-volume environments, the OIM schema grows aggressively. ORC (orchestration), OST (object status), and UPA (user provisioning attributes) tables can individually reach hundreds of millions of rows within a year at an enterprise that provisions thousands of users weekly.

### MDS (Metadata Services)

MDS is Oracle Fusion Middleware's metadata repository. OIG uses it to store UI customizations (sandbox configurations, customized pages), workflow metadata (approval process definitions), connector deployment descriptors, and system configuration. MDS data lives in the OIM_MDS Oracle schema and is cached in WebLogic memory.

MDS failures — most commonly seen after an OIG upgrade as "MDS-00013: no metadata found" — prevent the OIG server from starting. MDS corruption is rare but catastrophic.

### Connector Server

The Connector Server is a lightweight Java (or .NET) process that acts as a gateway for provisioning to target systems that the OIG server cannot reach directly. Common use cases:

- Active Directory provisioning via PowerShell (requires .NET Connector Server on Windows)
- Target systems in network segments with strict outbound firewall rules
- Systems that require a locally installed client library

The Connector Server runs the same ICF (Identity Connector Framework) connector bundles as OIG itself, but as a remote process. OIG connects to it via a secure socket.

### OIM Scheduler

OIG includes a built-in task scheduler for recurring background operations: reconciliation tasks, certification campaign snapshot generation, purge jobs (orchestration cleanup, recon event cleanup), and role mining updates. Each scheduled task is defined in the \`SCH_TASK\` table and its execution history tracked in \`SCH_TASK_EXEC\`.

---

## Key Capabilities

### 1. User Lifecycle Management (Joiner / Mover / Leaver)

OIG's core function is automating what happens to a user's system access at each stage of their employment lifecycle.

**Joiner**: An HR system — PeopleSoft, SAP HCM, Workday — feeds new employee records to OIG via reconciliation (batch) or real-time event notification. OIG receives the new user record, creates an OIG user (\`USR\` table), evaluates access policies to determine what systems and roles the user should have, and triggers provisioning workflows to create accounts on all applicable target systems (Active Directory, Oracle EBS, RACF, etc.).

**Mover**: When an employee changes department, location, or job title, HR sends an update. OIG's policy engine re-evaluates which roles the user should now hold. Roles no longer applicable are revoked (deprovisioning workflows fire); new roles are assigned (provisioning workflows fire). This is the most complex scenario because partial failures — one target system fails to provision while others succeed — leave the user in an inconsistent access state.

**Leaver**: On termination, OIG receives a disable/terminate event from HR. It immediately disables the user across all connected systems, then — after a configurable grace period — deletes the accounts. The orchestration engine sequences these operations across potentially dozens of target systems, tracking each step as a separate process instance in the ORC table.

The orchestration engine handles partial failures via retry logic and compensating transactions. Failed steps can be retried from the OIG admin console or via WLST scripting.

### 2. Role Management and RBAC

OIG maintains a role catalog with two role types:

**IT Roles** map directly to entitlements on target systems. An IT Role named "AD-Finance-Users" might provision membership in an Active Directory security group. When a user is assigned this IT Role, OIG provisions the corresponding group membership in AD.

**Business Roles** are abstract roles assigned by access policy based on user attributes (department, job code, location). Business Roles are composed of IT Roles. A "Finance Analyst" Business Role might encompass a set of IT Roles covering AD group membership, an EBS Responsibility, and a RACF data set permission.

**Role hierarchy and inheritance** allow child roles to inherit entitlements from parent roles, simplifying the role catalog for organizations with complex organizational structures.

**Segregation of Duties (SoD) policies** define which role combinations are prohibited. A user cannot hold both "Accounts Payable Entry" and "Accounts Payable Approval." OIG enforces SoD at request time (blocking conflicting requests) and surfaces SoD violations during access certification campaigns.

**Policy-based provisioning** automatically evaluates access policies whenever a user attribute changes. If a user's department changes from Operations to Finance, OIG computes the delta — which roles to add, which to revoke — and executes accordingly.

### 3. Access Request and Approval Workflow

OIG's self-service catalog allows users, managers, and helpdesk staff to browse available roles and entitlements and submit access requests. Each request type can have a customized approval workflow.

Approval workflows are BPEL processes deployed as SOA composites. A typical workflow might require:
1. Manager approval (human task in SOA)
2. Application owner approval (human task)
3. Security team final sign-off (conditional, based on request risk level)

SOA handles escalation (if the approver does not respond within N days, escalate to skip-level), delegation (approver has set a substitute during vacation), and parallel approval paths. Email notifications to approvers are sent via OIG's notification framework, which supports both OIG-native email templates and integration with SMTP servers.

All request tracking — when each approval was submitted, who approved, how long each step took — is visible in the OIG request tracking UI and stored in OIG audit tables.

### 4. Access Certification Campaigns

Access certification is the periodic review of user access rights, required by SOX, HIPAA, PCI-DSS, and most enterprise security policies. OIG automates this with certification campaigns.

**Campaign types**:
- **Manager certification**: Each manager reviews the roles and entitlements held by their direct reports.
- **Application owner certification**: The owner of a target system (e.g., the EBS System Administrator) reviews all users with access to that system.
- **Entitlement owner certification**: The owner of a specific entitlement (e.g., a privileged AD group) reviews all users holding it.
- **User certification**: Users review and attest to their own access.

When a certifier marks an access item as "Revoke," OIG automatically triggers deprovisioning on the target system. The revocation is tracked, timestamped, and stored for audit evidence. Certifiers who sign off are creating a legally meaningful attestation that the access is appropriate.

Campaign progress, completion rates, and pending reviewer workloads are visible in the OIG admin console. The underlying data lives in the \`CERT_CAMPAIGN\` and \`CERT_REVIEWER\` tables.

### 5. Reconciliation

Reconciliation is how OIG discovers and syncs with what actually exists on target systems. It answers the question: "What accounts exist in Active Directory right now, and do they match what OIG thinks should be there?"

**Full reconciliation** reads every account from the target system and processes each one. For large directories (100k+ users in AD), a full reconciliation run can take hours.

**Incremental reconciliation** reads only changes since the last run — new accounts, modified attributes, deleted accounts. This is faster but requires the target system to expose a change log or delta query mechanism (AD's \`uSNChanged\` attribute, LDAP changelog, etc.).

**Event-based reconciliation** triggers immediately when a change occurs on the target — real-time sync rather than batch.

Reconciliation events are staged in the \`RECON_EVENTS\` table. Each event goes through a matching phase (does this target account correspond to an existing OIG user?) using a configured matching rule. If the match succeeds, OIG links the account and updates its records. If the match fails (no corresponding OIG user found), the event lands in \`RECON_EXCEPTIONS\` with status "No Match Found" and requires manual investigation.

Reconciliation exceptions are the most common source of identity data quality problems. A misconfigured matching rule — for example, matching on \`sAMAccountName\` in AD against a field in \`USR\` that stores employee numbers — will flood the exceptions table and make OIG's view of access increasingly inaccurate.

### 6. Connector Framework

OIG uses the Identity Connector Framework (ICF) for provisioning to and reconciling from target systems. ICF connectors are Java bundles that implement a standard API (create, update, delete, search, authenticate) against a specific target system.

OIG ships out-of-the-box connectors for:
- Active Directory / Azure AD
- Generic LDAP (Oracle Internet Directory, OpenLDAP, Sun Directory)
- Oracle Database (OID, standard DB user management)
- Oracle E-Business Suite (FND_USER, Responsibilities)
- RACF (IBM mainframe)
- SAP (via JCo)
- Unix/Linux (via SSH)

Custom connectors for in-house systems are built via the ICF SDK, implementing the required operation handlers in Java. Complex targets (legacy mainframe screens, REST APIs without standard ICF support) are often handled by building a thin web service wrapper that exposes a clean API for the connector to call.

**Provisioning operations** that connectors implement:
- **Create**: Create a new account on the target
- **Update**: Modify account attributes
- **Delete**: Remove the account
- **Enable / Disable**: Toggle account active state
- **Reset Password**: Force a password change on the target
- **Add Entitlement / Remove Entitlement**: Manage group memberships, role assignments, data set permissions

---

## Database Schema: Key Tables

Every OIG DBA should have a working knowledge of these OIM schema tables:

| Table | Purpose |
|---|---|
| USR | Master user record — USR_KEY (PK), USR_LOGIN, USR_STATUS, USR_EMP_NO |
| ORC | Orchestration process instance — links user action to provisioning steps |
| OST | Object status — current state of each provisioned account |
| ACT | Account (provisioned resource) on a target system |
| UGP | User-group (role) membership |
| UPA | User provisioning attribute — stores entitlement assignments |
| SCH_TASK | Scheduled task definitions |
| SCH_TASK_EXEC | Scheduled task execution history and results |
| RECON_EVENTS | Reconciliation event staging table |
| RECON_EXCEPTIONS | Reconciliation exceptions awaiting resolution |

### Diagnostic SQL

**Find all active users with their provisioned account count:**

\`\`\`sql
SELECT u.usr_login,
       u.usr_display_name,
       u.usr_status,
       COUNT(a.act_key) AS provisioned_accounts
FROM usr u
LEFT JOIN act a ON u.usr_key = a.usr_key AND a.orc_status = 'Provisioned'
WHERE u.usr_status = 'Active'
GROUP BY u.usr_login, u.usr_display_name, u.usr_status
ORDER BY provisioned_accounts DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

This query joins the master user table to the ACT (accounts) table to show how many systems each active user is provisioned on. Users with zero provisioned accounts may have slipped through the provisioning process — worth investigating as part of reconciliation health checks.

**Find stuck orchestration processes (running > 2 hours):**

\`\`\`sql
SELECT o.orc_key,
       o.orc_orch_target,
       o.orc_status,
       o.usr_key,
       u.usr_login,
       ROUND((SYSDATE - o.orc_create) * 24, 1) AS hours_running
FROM orc o
JOIN usr u ON o.usr_key = u.usr_key
WHERE o.orc_status IN ('Running', 'Pending')
  AND o.orc_create < SYSDATE - 2/24
ORDER BY hours_running DESC;
\`\`\`

Any rows returned by this query represent provisioning operations that should have completed but have not. The \`orc_orch_target\` column tells you which connector or workflow step is stuck. Cross-reference with the SOA EM console to check for faulted composites.

**Reconciliation event backlog:**

\`\`\`sql
SELECT re.re_key,
       re.re_status,
       re.re_date,
       re.re_recon_used_name,
       COUNT(*) OVER (PARTITION BY re.re_status) AS status_count
FROM recon_events re
WHERE re.re_status NOT IN ('Event Linked', 'No Match Found - Manually Closed')
  AND re.re_date > SYSDATE - 7
ORDER BY re.re_date DESC
FETCH FIRST 50 ROWS ONLY;
\`\`\`

A healthy OIG environment has very few unlinked reconciliation events older than a few hours. A large backlog of "No Match Found" events indicates a matching rule problem. A large backlog of events still in "Received" status indicates the reconciliation processing thread is behind — check OIG server thread counts and JVM heap.

---

## Performance Tuning Considerations

### Schema Growth

The OIM schema grows rapidly in high-volume environments. Key growth drivers:

- **ORC**: One row per provisioning operation. An enterprise that onboards 500 employees per month, each provisioned to 20 systems, generates 10,000 ORC rows per month — plus additional rows for every entitlement change and password reset.
- **OST**: One or more rows per provisioned account, tracking status transitions.
- **UPA**: Stores the attribute-level detail of each provisioned entitlement — can dwarf ORC in environments with many granular entitlements.
- **RECON_EVENTS**: Grows with every reconciliation run. A full reconciliation of 100k AD accounts creates 100k rows.
- **SCH_TASK_EXEC**: One row per scheduled task execution. With hourly reconciliation jobs, this table adds thousands of rows daily.

### Partitioning

Partitioning the ORC table by \`ORC_CREATE\` date significantly reduces query scan range for diagnostic queries, purge operations, and the orchestration engine's internal lookups. Implement range partitioning with monthly partitions, and use partition pruning in all diagnostic SQL by always including an \`ORC_CREATE\` predicate.

### Purge Jobs

OIG ships scheduled tasks for purging aged data. These must be configured and running:

- **"Orchestration Process Completed Purge Task"**: Purges completed ORC/OST rows older than the configured age (default is often too long — set to 90 days for most environments).
- **"Recon Events Purge Task"**: Purges linked and closed reconciliation events older than 30 days.
- **SOA BPEL purge**: The \`SOAINFRA.CUBE_INSTANCE\` table must be purged separately via the SOA EM console or the SOA purge script. This is the most frequently missed maintenance task, and the one that causes the most dramatic schema growth.

### Connection Pool Sizing

OIG uses two WebLogic data sources:
- \`oimOperationsDB\`: transactional OIG operations
- \`oimJMSStoreDB\`: JMS message persistence

A general sizing guideline for production environments: pool maximum = 2× managed server count × CPU core count, capped at the Oracle Database's maximum process count divided by all connecting applications. Undersized pools create connection wait bottlenecks that manifest as provisioning latency spikes.

### SOA BPEL Dehydration Store

\`SOAINFRA.CUBE_INSTANCE\` is OIG's most write-intensive table — every approval workflow dehydrates (checkpoints) its state to this table at each human task step. In environments with high provisioning request volumes, this table's I/O can saturate a spinning-disk storage tier. Place SOAINFRA tablespace on SSD or high-IOPS block storage. Purge completed instances weekly.

---

## Common Failure Patterns

### Pattern 1: Provisioning Stuck in "Pending" Status

**Symptom**: Users submit access requests; they appear in the queue but never advance to "Approved" or "Provisioned."

**Causes**:
- SOA composite unreachable or faulted — the BPEL workflow that processes the approval request is not running.
- Target connector timeout — the connector attempt to provision timed out and OIG is in a retry backoff loop.
- Approval workflow waiting for human input — the approver has not acted and the workflow is parked in SOA awaiting a human task callback.

**Diagnosis**:
1. Query ORC table for stuck instances (see diagnostic SQL above).
2. Check SOA EM console (\`http://host:7001/em\`) for faulted composite instances under soa-infra.
3. OIG System Admin → Pending Approvals — check if there are pending human tasks that no approver has seen.

**Resolution**: Recover faulted SOA composites, retry failed orchestration processes from the OIG admin console.

### Pattern 2: Reconciliation Running but Not Linking

**Symptom**: The reconciliation scheduled task completes without error, but the \`RECON_EXCEPTIONS\` table fills with "No Match Found" rows. OIG's view of who has access doesn't match the target system.

**Cause**: The matching rule is misconfigured. The attribute used to match a target account back to an OIG user does not align. For example, the AD connector's matching rule is configured to match \`sAMAccountName\` against \`USR_LOGIN\`, but the OIG environment was loaded from HR with employee numbers in \`USR_LOGIN\` rather than AD login names.

**Diagnosis**: Query \`RECON_EXCEPTIONS\` to view the actual values in the exception records. Compare these values to the \`USR\` table values. The mismatch will be obvious.

**Resolution**: Correct the matching rule in the IT Resource or connector configuration. Then re-process the existing exceptions (OIG allows bulk re-evaluation of exceptions after a matching rule change).

### Pattern 3: "MDS-00013: no metadata found" on Startup

**Symptom**: The OIG managed server (oim_server1) fails to start, with "MDS-00013: no metadata found for" errors in the server log referencing OIG page or workflow metadata.

**Cause**: After an OIG upgrade, the MDS schema migration was not fully applied, or the shared MDS schema has stale partition entries from the previous OIG version that conflict with the new version's metadata paths.

**Fix**:
1. Connect to WebLogic via WLST.
2. Run the MDS purge utility: \`mdsdb.purgeMetadata()\`.
3. If the issue persists, run the OIG MDS migration script provided in the OIG upgrade documentation.
4. Restart the OIG managed server.

### Pattern 4: Access Certification Campaign Stuck at 0% Completion

**Symptom**: An access certification campaign was created and launched, but after hours or days it shows 0% completion — no reviewers see any items in their queue.

**Cause**: OIG 12c generates the campaign snapshot (the point-in-time list of all user access to be certified) as a background SOA composite job. If that SOA composite has faulted during snapshot generation, the campaign never populates reviewer queues.

**Diagnosis**: OIG Admin → Identity Certification → campaign status. Then check SOA EM for faulted instances of the certification snapshot composite.

**Resolution**: Recover the faulted SOA composite instance. The snapshot generation will resume or need to be re-triggered from the campaign administration screen.

---

## Integration with Oracle E-Business Suite

OIG integrates with EBS via the Oracle EBS User Management Connector, one of the most widely deployed OIG connectors in the Oracle ecosystem.

**Provisioning capabilities**:
- Creates and maintains \`FND_USER\` accounts on EBS
- Assigns and removes EBS Responsibilities to FND_USER records
- Manages Menu Exclusions (restricting specific menu items within a Responsibility)
- Sets password and expiry policies consistent with OIG's password policy for EBS

**Reconciliation**:
- Full reconciliation reads all \`FND_USER\` records and their current Responsibility assignments from EBS
- Links existing EBS accounts back to OIG users, establishing OIG as the authority on who has what access in EBS
- Exceptions (EBS accounts with no corresponding OIG user) represent orphaned accounts — a security risk requiring cleanup

**HR as System of Record**:
- Many EBS deployments use Oracle HRMS as the employee system of record. OIG's HR reconciliation connector reads from EBS HRMS tables (\`PER_ALL_PEOPLE_F\`, \`PER_ALL_ASSIGNMENTS_F\`) to drive the joiner/mover/leaver lifecycle
- New hires in HRMS trigger OIG user creation; terminations trigger deprovisioning across all connected systems
- This creates a tight coupling: OIG's data quality depends on the accuracy and timeliness of HRMS data

For environments running both EBS and OIG, the DBA must maintain both the EBS application schemas and the OIM/MDS/SOAINFRA schemas, coordinate patching windows (OIG and SOA patches are separate from EBS patches), and monitor reconciliation health as a daily operational task.

---

## Summary

Oracle Identity Governance is a complex platform that touches every application in an enterprise's IT estate. For the Oracle DBA and middleware administrator, the operational responsibilities span:

**Schema health**: Monitor and purge the OIM, SOAINFRA, and MDS schemas proactively. The ORC, CUBE_INSTANCE, and RECON_EVENTS tables are the growth hotspots. Implement partition pruning-friendly partitioning on ORC.

**Reconciliation health**: Run daily checks on RECON_EXCEPTIONS counts and trends. A growing exceptions backlog is an early warning sign of a matching rule or connectivity problem. Unresolved exceptions mean OIG's access data is drifting from reality.

**Orchestration monitoring**: Maintain awareness of stuck provisioning processes. Any ORC row stuck in "Running" or "Pending" for more than a few hours represents a user who is waiting for access — or worse, a terminated employee whose access has not been revoked on schedule.

**SOA health**: OIG's provisioning and certification capabilities depend entirely on SOA Suite's health. Faulted SOA composites silently block workflows. Include SOA composite fault monitoring in your OIG health check dashboard.

**Certification campaign management**: Access certification is often audit-critical. Proactively monitor campaign completion rates, identify overdue reviewers, and ensure the SOA snapshot generation completes before campaign deadlines.

Understanding these operational patterns transforms the DBA from a reactive firefighter into a proactive guardian of the identity governance platform — and, by extension, a guardian of access security across the entire Oracle estate.
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
