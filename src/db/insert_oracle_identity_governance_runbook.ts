import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Identity Governance — Installation, Administration, and Troubleshooting',
  slug: 'oracle-identity-governance-runbook',
  excerpt: 'A step-by-step operational runbook for Oracle Identity Governance (OIG): RCU schema creation, WebLogic domain setup, start/stop sequences, connector deployment, reconciliation operations, stuck orchestration recovery, SOA health, and performance maintenance.',
  category: 'identity-management' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-02'),
  youtubeUrl: null,
  content: `## Prerequisites and Architecture Sizing

Before deploying Oracle Identity Governance (OIG), validate that the target environment meets minimum hardware and software requirements. OIG is a resource-intensive platform — undersizing at install time leads to chronic performance problems that are difficult to remediate without downtime.

### Hardware Minimums for Production

| Component | CPU | RAM | Storage |
|---|---|---|---|
| OIG/SOA Server | 8 cores | 32 GB | 100 GB /u01 |
| Oracle DB Server | 8 cores | 64 GB | 500 GB+ (data) |
| Connector Server (if needed) | 2 cores | 8 GB | 20 GB |

For high-availability production deployments, run two OIG managed servers and two SOA managed servers in separate WebLogic clusters, with Oracle RAC or Data Guard protecting the backend database.

### Software Stack

- Oracle Linux 8 (RHEL 8 compatible) — OL8 is the recommended OS for OIG 12.2.1.4
- JDK 11 — use Oracle JDK, not OpenJDK, for production OIG. Oracle's support policy for OIG on OpenJDK is limited
- Oracle WebLogic Server 12.2.1.4 or later (12.2.1.4 includes critical security fixes over 12.2.1.3)
- Oracle SOA Suite 12.2.1.4 (must match WebLogic version)
- Oracle Database 19c (minimum 12.2 for OIG 12.2.1.4; 19c recommended for long-term support)
- Oracle Identity Governance 12.2.1.4 or later

Apply all available Bundle Patches (BPs) to each component before go-live. OIG, SOA, and WebLogic are patched independently via OPatch.

---

## Step 1: RCU Schema Creation

The Repository Creation Utility (RCU) creates the Oracle Database schemas that OIG requires. Run RCU from the Oracle Fusion Middleware home on a host that can reach the database.

\`\`\`bash
# Set environment
export ORACLE_HOME=/u01/oracle/middleware/Oracle_Home
export JAVA_HOME=/u01/oracle/jdk11

# Run RCU in silent mode
\${ORACLE_HOME}/oracle_common/bin/rcu \\
  -silent \\
  -createRepository \\
  -databaseType ORACLE \\
  -connectString db-host:1521:orcl \\
  -dbUser sys \\
  -dbRole sysdba \\
  -schemaPrefix OIM \\
  -component OIM \\
  -component MDS \\
  -component SOAINFRA \\
  -component STB \\
  -component OPSS \\
  -f < /tmp/rcu_passwords.txt
\`\`\`

The \`rcu_passwords.txt\` file provides the sys password followed by the schema password for each component (same password repeated is acceptable for non-production):

\`\`\`
sys_password
OIM_schema_password
OIM_schema_password
OIM_schema_password
OIM_schema_password
OIM_schema_password
\`\`\`

### Post-RCU Validation

Verify all schemas were created successfully before proceeding to domain configuration:

\`\`\`sql
-- Verify all schemas created
SELECT username, account_status, created
FROM dba_users
WHERE username LIKE 'OIM%'
ORDER BY created;
\`\`\`

Expected output: rows for OIM_OIM, OIM_MDS, OIM_SOAINFRA, OIM_STB, OIM_OPSS — all with OPEN status. If any show LOCKED or EXPIRED, reset the password and unlock before proceeding.

Also verify tablespace allocation:

\`\`\`sql
SELECT tablespace_name,
       ROUND(used_space * 8192 / 1073741824, 2) AS used_gb,
       ROUND(tablespace_size * 8192 / 1073741824, 2) AS total_gb
FROM dba_tablespace_usage_metrics
WHERE tablespace_name LIKE 'OIM%'
ORDER BY tablespace_name;
\`\`\`

---

## Step 2: WebLogic Domain Creation

Create the WebLogic domain using the Fusion Middleware Configuration Wizard in silent mode. Prepare a response file (\`oig_domain_config.rsp\`) with your environment-specific values before running this command.

\`\`\`bash
cd \${ORACLE_HOME}/oracle_common/common/bin
./config.sh -silent \\
  -responseFile /tmp/oig_domain_config.rsp
\`\`\`

### Key Domain Configuration Parameters

The response file (or interactive wizard) configures:

- **Domain type**: Oracle Identity Governance (selects all required JRF, SOA, and OIG templates)
- **Admin Server**: port 7001, listening on all interfaces
- **SOA Managed Server**: \`soa_server1\` on port 8001 (or 8443 for SSL)
- **OIG Managed Server**: \`oim_server1\` on port 14000 (or 14001 for SSL)
- **Cluster names**: \`soa_cluster\`, \`oim_cluster\`
- **Node Manager**: per-host, listening on port 5556, using plain or SSL socket type
- **JDBC data sources**: point to the OIM, MDS, SOAINFRA, STB, and OPSS schemas created by RCU

After domain creation, the directory structure under \`/u01/oracle/domains/oig_domain/\` will contain the servers, config, and bin directories. Validate the configuration by checking \`config/config.xml\` for the expected server count.

---

## Step 3: OIM Schema Post-Configuration

After WebLogic domain creation, run the OIG configurator to finalize the OIM schema setup. This step populates seed data (default roles, system configuration, connector metadata) into the OIM schema.

\`\`\`bash
cd \${ORACLE_HOME}/idm/server/bin
./oim_configurator.sh \\
  -domainHome /u01/oracle/domains/oig_domain \\
  -weblogicHome \${ORACLE_HOME} \\
  -oimAdminPassword \${OIM_ADMIN_PASS} \\
  -dbUrl jdbc:oracle:thin:@db-host:1521:orcl \\
  -schemaUser OIM_OIM \\
  -schemaPassword \${OIM_SCHEMA_PASS}
\`\`\`

This step can take 15–30 minutes. Watch the log output for errors. Common failure: the configurator cannot connect to the database because the OIM_OIM schema password was set differently in RCU than the value passed here. Verify the schema password with:

\`\`\`sql
-- Test from sqlplus
connect OIM_OIM/password@db-host:1521/orcl
SELECT COUNT(*) FROM usr;
\`\`\`

---

## Step 4: Starting and Stopping OIG

OIG has a strict startup order. Starting components out of order causes startup failures that can be difficult to diagnose because the error messages do not always indicate the root cause (missing SOA availability, for example, manifests as an OIG startup timeout, not a "SOA not found" error).

### Start Sequence

\`\`\`bash
# 1. Start Node Manager (manages other servers)
cd /u01/oracle/domains/oig_domain/bin
nohup ./startNodeManager.sh > /u01/logs/nodemanager.log 2>&1 &

# 2. Start Admin Server
nohup ./startWebLogic.sh > /u01/logs/adminserver.log 2>&1 &

# 3. Wait for Admin Server to reach RUNNING state
# Look for: "Server state changed to RUNNING"
tail -f /u01/logs/adminserver.log

# 4. Start SOA Managed Server (MUST start before OIG)
\${ORACLE_HOME}/oracle_common/common/bin/wlst.sh << 'EOF_WLST'
connect('weblogic', 'password', 't3://admin-host:7001')
start('soa_server1', 'Server')
EOF_WLST

# 5. Verify SOA is RUNNING before continuing
# Check: http://admin-host:7001/console -> Servers -> soa_server1

# 6. Start OIG Managed Server
\${ORACLE_HOME}/oracle_common/common/bin/wlst.sh << 'EOF_WLST'
connect('weblogic', 'password', 't3://admin-host:7001')
start('oim_server1', 'Server')
EOF_WLST
\`\`\`

OIG startup takes 5–15 minutes depending on server hardware and MDS cache warming. Monitor \`/u01/oracle/domains/oig_domain/servers/oim_server1/logs/oim_server1.log\` for "OIMStartup complete" or equivalent completion message.

### Stop Sequence

Stop in reverse order — OIG first, then SOA, then Admin Server:

\`\`\`bash
\${ORACLE_HOME}/oracle_common/common/bin/wlst.sh << 'EOF_WLST'
connect('weblogic', 'password', 't3://admin-host:7001')
shutdown('oim_server1', 'Server', ignoreSessions=true)
shutdown('soa_server1', 'Server', ignoreSessions=true)
shutdown('AdminServer', 'Server')
EOF_WLST
\`\`\`

The \`ignoreSessions=true\` flag allows shutdown to proceed even if active HTTP sessions exist. For a graceful shutdown during low-traffic windows, omit this flag to allow in-flight sessions to complete.

---

## Step 5: Key Administrative URLs

| URL | Purpose |
|---|---|
| http://host:7001/console | WebLogic Admin Console |
| http://host:7001/em | Enterprise Manager (SOA composite monitoring) |
| http://host:14000/identity | OIG Self-Service UI (end users, managers) |
| http://host:14000/sysadmin | OIG System Administrator Console |
| http://host:8001/soa-infra | SOA Infrastructure console |

All URLs listed use HTTP. In production, SSL-terminate at a load balancer or OHS (Oracle HTTP Server) reverse proxy. The backend WebLogic servers can use HTTPS internally (ports 7002, 8002, 14001) or T3S.

---

## Step 6: Connector Deployment

### Deploy a New ICF Connector Bundle

Connectors extend OIG's ability to provision to new target systems. The process for deploying an ICF connector bundle:

1. Download the connector bundle (.zip) from Oracle Support (My Oracle Support, Connector downloads section)
2. Extract the zip — it contains a connector .jar file and an XML configuration descriptor
3. Deploy via OIG console: **Identity System Administration → Manage → Configuration → Upload**
4. Upload the connector .jar file
5. Create the IT Resource: **Identity System Administration → Provisioning → IT Resources → Create**
   - Select the IT Resource Type matching the connector
   - Fill in connection parameters (host, port, credentials, protocol)
6. Test the connection from the IT Resource form — this verifies network connectivity and credential validity before running reconciliation
7. Create the Resource Object and Process Form if not provided by the connector (newer ICF connectors auto-provision these via the connector configuration XML)
8. Run a full reconciliation job to import existing accounts from the target system

### IT Resource Configuration: Active Directory Example

\`\`\`
Server Name: ad-dc01.example.com
Port: 636
Use SSL: true
Administrator DN: CN=svc-oig,OU=ServiceAccounts,DC=example,DC=com
Administrator Password: [vault reference or direct value]
Domain Name: example.com
Domain Controller Host: ad-dc01.example.com
\`\`\`

Use SSL (LDAPS on port 636) for all Active Directory connectors. Plain LDAP (port 389) transmits bind credentials in cleartext and will be blocked by AD's LDAP signing policy in most hardened environments.

For Connector Server deployments (when OIG cannot reach the target directly), add:
\`\`\`
Connector Server Name: [IT Resource name for the Connector Server]
\`\`\`

---

## Step 7: Reconciliation Operations

### Run Full Reconciliation Manually

1. OIG System Admin → Scheduler → search for the reconciliation task (e.g., "Active Directory User Reconciliation")
2. Click the task → **Run Now**
3. Monitor progress: Scheduler → Task History → look for COMPLETED status and the row count processed
4. Check exceptions post-run: Identity Audit → Reconciliation → Events → filter by status "No Match Found"

### Diagnose Reconciliation Backlog

Query the recon_events table for a status breakdown:

\`\`\`sql
SELECT re_status, COUNT(*) AS cnt
FROM recon_events
WHERE re_date > SYSDATE - 1
GROUP BY re_status
ORDER BY cnt DESC;
\`\`\`

Healthy output shows mostly "Event Linked" rows. "No Match Found" rows indicate matching failures. "Received" rows that are not declining indicate a processing backlog — the reconciliation engine is behind. Check OIG JVM thread dumps for blocked reconciliation threads.

### Clear Stale Reconciliation Exceptions

After investigating each exception batch and confirming they represent accounts that genuinely have no OIG user counterpart (orphaned accounts, service accounts intentionally outside OIG scope), close them manually:

\`\`\`sql
-- Mark exceptions as manually closed after investigation
-- Only run after confirming the exceptions are understood and safe to close
UPDATE recon_events
SET re_status = 'No Match Found - Manually Closed'
WHERE re_status = 'No Match Found'
  AND re_date < SYSDATE - 30;
COMMIT;
\`\`\`

Do not bulk-close exceptions without investigation. Each exception represents an account on a target system that OIG cannot account for — which may be an orphaned account, a provisioning gap, or a security risk.

---

## Step 8: Troubleshooting Stuck Orchestration

### Find All Stuck Processes

\`\`\`sql
SELECT o.orc_key,
       o.orc_orch_target,
       o.orc_status,
       u.usr_login,
       ROUND((SYSDATE - o.orc_create) * 24, 2) AS hrs_pending,
       o.orc_create
FROM orc o
JOIN usr u ON o.usr_key = u.usr_key
WHERE o.orc_status IN ('Running', 'Pending', 'Waiting')
  AND o.orc_create < SYSDATE - 1
ORDER BY hrs_pending DESC;
\`\`\`

Review the \`orc_orch_target\` column to identify which connector, workflow step, or approval task is stuck. Group by target to find systemic failures (e.g., all AD provisioning is stuck) versus isolated cases (a single user's workflow is blocked).

### Retry Failed Orchestration (OIG Admin Console)

1. System Admin → Provisioning → Pending / Failed Provisioning Tasks
2. Select the stuck tasks
3. Actions → Retry

For tasks that fail repeatedly, check the oim_server1 diagnostic log for the underlying error before retrying — retrying a task that fails due to a connector misconfiguration will loop indefinitely.

### Retry via WLST (Bulk Retries)

For large-scale failures (e.g., after a connector outage leaves hundreds of provisioning tasks stuck), use a WLST script to bulk-retry:

\`\`\`python
# WLST script to retry failed orchestration processes
# Run via: wlst.sh retry_orchestration.py
from java.util import HashMap

oimClient = OIMClient()
oimClient.login('xelsysadm', 'password'.toCharArray())
orchOps = oimClient.getService(OrchestrationEngine)

# Get failed process IDs from ORC table first, then iterate:
# orchOps.retryProcess(processId)
\`\`\`

Build the list of \`orc_key\` values from the diagnostic SQL above, then pass each to \`orchOps.retryProcess()\`.

### Force-Close a Permanently Stuck Orchestration (Last Resort)

Only perform this operation with change control approval, after confirming that the retry mechanism is exhausted and the target system is already in the correct state.

\`\`\`sql
-- Confirm the target system state before running this
UPDATE orc
SET orc_status = 'Completed'
WHERE orc_key = &stuck_orc_key;
COMMIT;

-- Clear the associated OST record if needed
UPDATE ost
SET ost_status = 'Provisioned'
WHERE orc_key = &stuck_orc_key;
COMMIT;
\`\`\`

**Warning**: This manual status update bypasses OIG's orchestration logic entirely. OIG will not execute any remaining steps in the workflow, will not send notifications, and will not update audit records to reflect the actual resolution path. Use only when the retry mechanism has been completely exhausted and the access state on the target system is already correct and verified.

---

## Step 9: Access Certification Campaigns

### Create a User Manager Certification

1. OIG System Admin → Identity Certification → Certification Definitions → **Create**
2. **Type**: Manager (certifiers are each user's direct manager)
3. **Scope**: All users, or filtered by Organization to limit scope to a business unit
4. **Content**: Roles, Entitlements, or both (select both for a comprehensive SOX-grade review)
5. **Reviewers**: User's manager as primary reviewer; skip-level manager as escalation path
6. **Duration**: 30 days (configure based on policy; shorter windows increase reviewer urgency but may reduce completion rates)
7. **Actions on expiry**: Set to **Certify** (auto-certify, not auto-revoke) for the first few campaigns — auto-revoke on expiry can accidentally deprovision active employees if reviewers do not complete in time

### Monitor Campaign Progress

\`\`\`sql
SELECT cc.name AS campaign_name,
       cc.status,
       cc.start_date,
       cc.end_date,
       cc.total_count,
       cc.completed_count,
       cc.revoke_count,
       ROUND(cc.completed_count / NULLIF(cc.total_count, 0) * 100, 1) AS pct_complete
FROM cert_campaign cc
WHERE cc.start_date > SYSDATE - 60
ORDER BY cc.start_date DESC;
\`\`\`

Run this query weekly during active campaigns. Campaigns below 80% completion with less than 7 days remaining need escalation.

### Identify Overdue Reviewers

\`\`\`sql
SELECT cr.reviewer_login,
       cr.reviewer_display_name,
       COUNT(*) AS pending_items,
       MIN(cc.end_date) AS campaign_end
FROM cert_reviewer cr
JOIN cert_campaign cc ON cr.campaign_id = cc.id
WHERE cr.status = 'Pending'
  AND cc.end_date < SYSDATE + 7
GROUP BY cr.reviewer_login, cr.reviewer_display_name
ORDER BY pending_items DESC;
\`\`\`

Share this list with the campaign owner and HR/management chain to drive completion. Reviewers with the highest \`pending_items\` counts are the blockers for overall campaign completion.

---

## Step 10: SOA Suite Health for OIG

OIG's approval workflows, provisioning sequences, and certification snapshot generation all execute as SOA composites. A faulted composite silently blocks every request that depends on it.

### Check for Faulted Composite Instances

\`\`\`sql
SELECT ci.composite_name,
       ci.state,
       COUNT(*) AS fault_count,
       MAX(ci.created_time) AS most_recent
FROM soainfra.cube_instance ci
WHERE ci.state = 3  -- 3 = FAULTED in SOA
  AND ci.created_time > SYSDATE - 7
GROUP BY ci.composite_name, ci.state
ORDER BY fault_count DESC;
\`\`\`

State values in \`cube_instance\`: 0 = Running, 1 = Completed, 2 = Stale, 3 = Faulted. Any non-zero fault_count returned by this query requires investigation.

### Recover Faulted SOA Instances via EM

1. Navigate to: **EM → SOA → soa-infra → Deployed Composites → [composite name]**
2. Click the **Instances** tab
3. Filter: State = Faulted
4. Select all faulted instances → **Actions → Recover**

Recovery re-submits the faulted instance from the point of failure. If the underlying cause (network timeout, target unavailable) has been resolved, recovery will succeed and the workflow will continue.

### Identify the Root Fault

Before bulk-recovering, drill into one faulted instance to understand the error. Common causes:
- Network timeout to target system (connector timeout)
- Database connectivity loss during dehydration
- Human task assignment failure (user referenced in approver expression no longer exists in OIG)
- Custom Java code exception in a composite service component

---

## Step 11: Performance Maintenance

### ORC/OST Table Purge

Configure and enable the OIG built-in purge scheduler:

1. OIG System Admin → Scheduler → search for **"Orchestration Process Completed Purge Task"**
2. Edit parameters: set \`OIM.COMPLETED.PROCESS.MAX.AGE\` = 90 (days to retain completed processes)
3. Schedule: weekly, during a low-traffic window
4. Enable the task

### Recon Events Purge

1. Scheduler → **"Recon Events Purge Task"**
2. Set \`recon.event.max.age\` = 30
3. Schedule: weekly

### SOA BPEL Purge

The SOAINFRA schema is the fastest-growing component and is not managed by OIG's own purge tasks. Check its size:

\`\`\`sql
-- Check CUBE_INSTANCE size by state
SELECT COUNT(*), state FROM soainfra.cube_instance GROUP BY state;
\`\`\`

Then purge via EM: **SOA → soa-infra → Administration → Purge → Closed Instances** older than 30 days. Schedule this as a weekly maintenance task. In environments with high provisioning volume, monthly purge is insufficient.

### Index Monitoring for ORC

The ORC table receives heavy DML — every provisioning operation inserts, updates, and eventually completes rows in this table. Indexes can become unusable or bloated over time.

\`\`\`sql
SELECT index_name, status, last_analyzed
FROM dba_indexes
WHERE table_owner = 'OIM_OIM'
  AND table_name = 'ORC'
ORDER BY last_analyzed;
\`\`\`

Ensure statistics are gathered at least weekly for ORC, OST, UPA, and RECON_EVENTS. Stale statistics on these high-DML tables lead to poor execution plans and high DB CPU from full table scans.

\`\`\`sql
-- Gather stats for OIG schema (run as DBA or schema owner)
EXEC DBMS_STATS.GATHER_SCHEMA_STATS('OIM_OIM', cascade => TRUE);
\`\`\`

---

## Step 12: Troubleshooting Quick Reference

| Symptom | Diagnosis | Resolution |
|---|---|---|
| Users cannot log in to OIG self-service | Check WebLogic oim_server1 status in Admin Console | Restart oim_server1 if crashed; check server log for OOM or deployment failure |
| Provisioning requests stuck in "Awaiting Approval" | SOA composite faulted | Recover faulted instances in EM; verify SOA soa_server1 is RUNNING |
| Reconciliation job shows ERROR in scheduler history | Connector or IT Resource connectivity failure | Test IT Resource connection from console; check Connector Server logs if remote |
| "MDS-00013: no metadata found" at startup | Stale MDS partition after upgrade | Run MDS purge via WLST, then restart oim_server1 |
| High DB CPU from OIM_OIM schema | Missing index or stale stats on ORC/UPA table | Gather stats, run AWR report filtered to OIM_OIM schema SQL IDs |
| Certification campaign stuck at 0% | SOA snapshot composite faulted | Recover composite in EM; re-trigger snapshot from campaign admin screen |
| "OIM-00001: Unknown error" in provisioning log | Usually a NullPointerException in a workflow step | Check oim_server1 diagnostic log for full stack trace; common cause is missing user attribute referenced in workflow expression |
| Password reset fails for all users | SPE (Password Policy Enforcement) service not running | Check SystemObjectStore for SPE availability; restart the SPE service via OIG System Configuration |
| OIG self-service UI loads but shows blank screens | MDS cache corrupted or MDS schema out of sync | Clear MDS cache via WLST; in severe cases, re-import MDS customizations from backup |
| Connector test connection succeeds but reconciliation returns 0 rows | Search filter or base DN misconfigured | Review IT Resource connector parameters; enable connector debug logging and re-run |

---

## Operational Checklist: Daily and Weekly Tasks

### Daily

- Check OIG self-service and sysadmin URLs are responding (synthetic monitoring)
- Verify soa_server1 and oim_server1 are RUNNING in WebLogic Admin Console
- Query ORC for stuck processes older than 4 hours
- Check RECON_EXCEPTIONS count trend (should be stable or declining)
- Review SOA CUBE_INSTANCE for faulted composites from the past 24 hours
- Review OIG scheduler task history for any ERROR status runs

### Weekly

- Review active certification campaign completion percentages; escalate laggards
- Run ORC/OST purge task if not scheduled
- Run recon_events purge task if not scheduled
- Gather statistics on OIM_OIM schema
- Check SOAINFRA tablespace usage; plan purge if > 70% utilized
- Review OIG server JVM heap utilization trends; tune \`-Xmx\` if consistently > 85%

---

## Appendix: WLST Quick Commands

Connect to Admin Server:
\`\`\`python
connect('weblogic', 'password', 't3://admin-host:7001')
\`\`\`

Check server state:
\`\`\`python
serverState('oim_server1')
serverState('soa_server1')
\`\`\`

Start a managed server via Node Manager:
\`\`\`python
nmConnect('weblogic', 'password', 'admin-host', '5556', 'oig_domain', '/u01/oracle/domains/oig_domain')
nmStart('oim_server1')
\`\`\`

Purge MDS metadata (after upgrade, to clear stale partitions):
\`\`\`python
connect('weblogic', 'password', 't3://admin-host:7001')
custom()
cd('com.oracle.jrockit.management:type=DiagnosticCommand')
# Use MDS purge utility from FMW install:
# \${ORACLE_HOME}/oracle_common/common/bin/wlst.sh
# Then: purgeMetaData(application='OIMMetaData', server='oim_server1', age='0d', purgeAll='false')
\`\`\`

Exit WLST:
\`\`\`python
exit()
\`\`\`
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
