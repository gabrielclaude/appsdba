import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Enterprise Manager 13c: Architecture, Components, and Installation Planning',
  slug: 'oracle-oem-13c-architecture-installation-planning',
  excerpt:
    'Oracle Enterprise Manager Cloud Control 13c is Oracle\'s flagship centralised management platform, built on a three-tier architecture of Oracle Management Service (OMS), Management Repository (OMR), and Management Agents. This post covers OEM 13c\'s hardware and OS prerequisites — commonly underestimated — the three deployment topologies from single-OMS to multi-site HA, and what OEM monitors and manages out of the box before any customisation.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-05'),
  youtubeUrl: null,
  content: `## Introduction

Oracle Enterprise Manager Cloud Control 13c (OEM 13c) is Oracle's flagship centralised management platform for the Oracle technology stack. It provides a single console for monitoring, administration, patching, performance diagnostics, and compliance reporting across Oracle Databases, RAC clusters, Exadata, WebLogic, Fusion Middleware, and cloud services. No other tool in the Oracle ecosystem provides the same breadth of integrated visibility — from an individual SQL execution plan through to fleet-wide patch compliance status — from a single browser session.

For DBAs managing more than a handful of Oracle databases, OEM is the difference between reactive firefighting and proactive infrastructure management. Its alerting engine, AWR-based performance analysis, and automated patch workflows significantly reduce the operational burden of managing Oracle estates at scale. A DBA who previously spent two hours per week checking alert logs across eight databases can replace that with OEM's incident management system, which aggregates ORA- errors and threshold breaches into a single work queue and routes them via notification rules to the right people.

OEM 13c represents the evolution of a product that Oracle has been developing since the late 1990s. Cloud Control 13c (the current release train, with 13.5 as the latest significant release) replaced Grid Control in 2012 and has matured considerably. The plugin architecture allows Oracle and third parties to extend OEM to monitor non-Oracle targets — Linux hosts, VMware, network devices — but the core value proposition is always the Oracle-specific depth: the ability to drill from a tablespace alert directly into the AWR, launch an ADDM analysis, and create a patch plan, all without leaving the browser.

This post covers what OEM 13c is made of architecturally, the hardware and OS prerequisites that are commonly underestimated, the deployment topology options from a single OMS to a multi-site enterprise deployment, and what OEM monitors and manages out of the box before any customisation. Installation procedure is covered in the companion runbook.

---

## OEM Architecture: Three Tiers

OEM 13c is a three-tier architecture. Each tier has distinct resource requirements, failure characteristics, and scaling strategies. Understanding the architecture is not just academic — it directly determines how you size the infrastructure, plan for high availability, and diagnose problems when something is not working.

**The Oracle Management Service (OMS)** is a Java EE application deployed on an embedded WebLogic Server. It provides the web console, notification engine, job system, patch orchestration, and the BI Publisher reporting engine. The OMS receives metric uploads from agents, stores them in the repository, evaluates alert thresholds, fires notifications, and dispatches jobs back to agents. The OMS is typically the most resource-intensive component to size correctly — a single OMS instance requires a minimum of 8 CPU cores and 16 GB RAM for a small deployment. Production deployments managing hundreds of targets typically deploy two or more OMS instances behind a load balancer, both because of resource demands and because OMS availability is critical: if the OMS is down, agents continue collecting data locally but cannot upload, and the console is unavailable to DBAs.

**The Oracle Management Repository (OMR)** is an Oracle Database that stores all monitoring data, configuration metadata, job history, and performance diagnostics collected by the agents. The OMR is not a special-purpose appliance — it is a standard Oracle Database with the SYSMAN schema and dozens of related schemas installed by the OEM installer during configuration. This means the OMR itself benefits from all the standard Oracle DBA practices: RMAN backups, statspack or AWR tuning, and space management. The OMR is the most storage-intensive component because it retains historical metric data: by default, OEM retains 31 days of detailed metric data and up to a year of summary data. The OMR database must be Oracle Enterprise Edition — the OMR schema uses partitioning and other EE features. Oracle recommends 19c or 21c as the OMR database.

**The Management Agent** is a lightweight process installed on every monitored host. The agent collects OS metrics (CPU, memory, disk, network), runs database checks (alert log scanning, tablespace thresholds, RMAN status), uploads metric data to the OMS at a configurable interval (default 1 minute for most metrics), and executes jobs dispatched from the console — patch staging, script execution, database starts and stops. The agent is the most numerous component in any OEM deployment; a 50-database estate might have agents on 20–30 hosts. The agent communicates with the OMS over HTTPS on port 4900 for metric uploads, and the OMS connects back to the agent on port 3872 for job dispatch and interactive console operations.

\`\`\`
OEM 13c Architecture

┌─────────────────────────────────────────────────────────────┐
│                    DBA Browser / Client                      │
└─────────────────────────┬───────────────────────────────────┘
                          │ HTTPS :7802/:7803
┌─────────────────────────▼───────────────────────────────────┐
│           Oracle Management Service (OMS)                    │
│    WebLogic Server  │  EM Application  │  Job Engine         │
│    Notification Engine  │  Patch Mgmt  │  BI Publisher       │
└──────────┬──────────────────────────────────────────────────┘
           │ JDBC                           ▲ HTTPS :4900
┌──────────▼──────────┐          ┌──────────┴──────────────────┐
│  Management         │          │   Management Agents          │
│  Repository (OMR)   │          │   (one per monitored host)   │
│  Oracle DB 19c/21c  │          │                              │
│  EE Licensed        │          │  DB Host 1  │  DB Host 2     │
└─────────────────────┘          │  DB Host 3  │  WebLogic Host │
                                 └─────────────────────────────┘
\`\`\`

The OMS console is available on HTTP port 7802 and HTTPS port 7803. Oracle strongly recommends using HTTPS in all environments — the OEM console provides access to database credentials, patch deployment, and privileged job execution. WebLogic's Admin Server runs on port 7301 for OMS administrative tasks. The agent upload port 4900 must be reachable from all agent hosts to the OMS; the OMS management port 3872 must be reachable from the OMS to all agent hosts. These firewall requirements are one of the most common causes of failed agent deployments in restricted network environments.

---

## Hardware and OS Prerequisites

The hardware prerequisites for OEM are the most commonly underestimated aspect of planning an OEM deployment. Oracle's documentation lists minimum requirements, but those minimums describe a barely-functional lab installation. Production deployments require substantially more headroom, and the consequences of undersizing are severe: a slow OMS creates a cascade effect where agents time out uploading metrics, the job system falls behind, and alerts arrive hours late — exactly the opposite of the proactive monitoring OEM is supposed to provide.

**OMS host requirements** for a small deployment (up to 50 targets): minimum 8 CPU cores (16 recommended), 16 GB RAM (24 GB recommended), 50 GB for OMS software installation, 100 GB for the Middleware Home and configuration data, plus a separate Oracle Database Client installation for the repository connection. For medium deployments (50–500 targets), Oracle recommends two OMS instances each with 16 CPU cores and 32 GB RAM. For large deployments (500+ targets), plan for three or more OMS instances. The OMS is a Java application running on WebLogic — it exhibits the memory growth patterns typical of long-running JVMs, and the WebLogic thread pools must be sized to handle concurrent agent uploads and console sessions without queuing.

**OMR database host requirements**: dedicated Oracle EE database (19c or 21c recommended), minimum 4 CPU cores (8+ for medium deployments), 16 GB RAM (32 GB for larger estates), 100 GB initial storage for OMR data files with significant growth expectations — plan for 1–5 GB per monitored database per month depending on metric retention configuration. The OMR benefits from fast storage for the \`MGMT_TABLESPACE\` and \`MGMT_ECM_DEPOT_TS\` tablespaces; these are heavily written during agent uploads and heavily read during console reporting. SSDs or equivalent flash storage for the OMR data files measurably improve OEM console responsiveness.

**Management Agent requirements** are modest: 1 GB RAM per host, 1 GB disk for the agent home, plus a few hundred MB for agent state and local metric buffering when the OMS is temporarily unreachable. Agent CPU overhead is typically less than 1% on a database host; it spikes briefly during metric collection cycles but does not compete meaningfully with database workloads.

**OS requirements** for the OMS host: RHEL or Oracle Linux 7 or 8 (OEM 13.5 supports up to OL 9), minimum \`ulimit -n 65536\` open files (the OMS opens many file descriptors for agent connections), \`/tmp\` at least 1 GB, swap equal to RAM or 16 GB minimum. The required OS packages include \`ksh\`, \`glibc-devel\`, \`libaio\`, \`libstdc++-devel\`, \`libXrender\`, and \`sysstat\` — missing packages are a common cause of silent installer failures that are difficult to diagnose because the error messages appear deep in installation log files.

The single most common OEM installation failure — responsible for a disproportionate share of failed installations — is insufficient \`/tmp\` space or incorrect permissions during the OEM installer's extraction phase. The OEM 13.5 installer is a large self-extracting binary that decompresses several gigabytes of content into \`/tmp\` before beginning installation. If \`/tmp\` has less than 4 GB available, or if \`/tmp\` is mounted \`noexec\`, the installer will fail with cryptic errors that do not clearly identify the root cause. Always verify \`/tmp\` before installation.

---

## Repository Database Preparation

The OMR must be a pre-existing Oracle EE database — the OEM installer does not create the OMR database, it installs schemas into it. This means the OMR database must be fully operational, with its listener running and TNS connectivity verified from the OMS host, before the OEM installer is run. Oracle recommends 19c or 21c as the repository database.

Several OMR prerequisites are non-negotiable. The \`db_block_size\` must be exactly 8192 bytes. The OEM repository schema requires 8 KB block size and the installer will abort if this parameter is incorrect — it cannot be changed after database creation without recreating the database. The \`UNDO_RETENTION\` parameter must be set to at least 10800 seconds (3 hours); OEM's internal batch jobs run long and generate significant undo volume. The database must have the Java Virtual Machine option installed and valid — the OEM installer verifies this with \`SELECT status FROM dba_registry WHERE comp_id = 'JAVAVM'\` and will abort if the JVM status is not \`VALID\`. Sufficient UNDO and TEMP tablespace must exist: the OEM installer creates dozens of tablespaces and loads substantial reference data during repository configuration, which exercises TEMP heavily.

The \`SYSMAN\` and \`SYSMAN_RO\` accounts are created by the OEM installer — do not pre-create them. The installer also creates \`SYSMAN_OPSS\`, \`SYSMAN_APM\`, \`SYSMAN_MDS\`, and approximately 20 other schema owners depending on the plugins deployed. All of these are managed by the installer and the \`emctl\` administration utility after installation.

One important architectural constraint: the repository database must not itself be monitored by OEM during the installation process. This creates an apparent circular dependency — you need OEM to monitor the OMR, but the OMR must exist before OEM can be installed. The resolution is simple: install OEM using a standalone OMR database, complete the installation, then add the OMR database as a monitored target through the OEM console. After that, OEM can alert on OMR tablespace growth, RMAN backup status, and performance metrics like any other target.

The OMR's data retention and purging are controlled by the \`MGMT_PURGE_MGMT_DATA\` job in OEM. By default, detailed metric data is retained for 31 days and summary data for longer periods. For large estates, the OMR can grow at 20–50 GB per month. Capacity planning for the OMR storage should account for 12–18 months of growth before the first purge cycle stabilises the database size.

---

## Deployment Topologies

OEM 13c supports three standard deployment topologies that map to organisation size and availability requirements. Choosing the wrong topology is expensive to correct after the fact because the OMR schema is tied to a specific OMS configuration, and migrating between topologies requires Oracle Support involvement.

**Single OMS topology (small/dev)** is the minimum viable OEM deployment: one OMS server, one OMR database, suitable for up to approximately 100 targets. The OMS and OMR can share a host for lab or proof-of-concept deployments, though Oracle recommends separate hosts for production. This topology has no OMS-level high availability — if the OMS host fails, the console is unavailable and agents queue metrics locally until the OMS recovers. For a development or pre-production environment where brief OMS outages are acceptable, this is the appropriate starting point.

**High Availability topology (medium/production)** uses two OMS instances behind a Software Load Balancer (SLB) or hardware load balancer, with a shared OMR database (optionally on RAC or Data Guard for OMR-level HA). The two OMS instances share a Software Library on an NFS mount — this is a hard requirement, not optional. The Software Library stores patch bundles downloaded from My Oracle Support, provisioning artifacts, scripts, and compliance content. If the Software Library is not on shared NFS, OMS instances will have inconsistent views of available patches and deployments will fail randomly depending on which OMS instance handles a given request. The load balancer must support sticky sessions (session affinity) for the console port (7803) because the OEM browser console uses stateful WebLogic sessions. The agent upload port (4900) does not require sticky sessions and can use round-robin load balancing.

**Multi-site topology (large/enterprise)** deploys multiple OMS instances across data centres, with the OMR on Oracle RAC or Active Data Guard, and a Software Library on replicated NFS. This topology is appropriate for global organisations managing thousands of targets across geographically distributed data centres. The complexity of the multi-site topology is substantial: WAN latency between OMS instances and the OMR must be below 5 ms (Oracle's documented maximum for OMS-to-OMR communication), the Software Library NFS replication must be near-synchronous, and the load balancer configuration must route agent uploads to the nearest OMS instance while routing console traffic to a globally available URL.

The Software Library deserves specific attention regardless of topology. It must be allocated a minimum of 50 GB initially and will grow to several hundred GB as patching activity accumulates. Downloaded Oracle patches are stored here permanently — the Software Library is not a cache. Patch bundles for Oracle Database (Release Updates are 2–4 GB each), WebLogic patches, and Fusion Middleware patches accumulate rapidly. Many organisations undersize the Software Library during initial deployment and then face emergency NFS expansion when it fills during a quarterly patching cycle.

---

## What OEM Monitors Out of the Box

After deploying agents to database hosts, OEM automatically discovers Oracle Database instances (by scanning for running processes and TNS listener configurations) and begins monitoring immediately. The range of what OEM collects without any additional configuration is one of its strongest value propositions compared to open-source monitoring alternatives that require manual metric configuration.

For Oracle Database targets, OEM monitors out of the box: database availability (up/down, with configurable availability checks), alert log scanning (ORA- errors generate incidents automatically, with the specific ORA- code used for severity classification), tablespace usage (default warning at 85%, critical at 97%, applied to all tablespaces including TEMP and UNDO), active sessions and wait events (sampled from \`v\$session\`), CPU and I/O utilisation at the host level, archive log space consumption, Data Guard replication lag (if standby databases are configured and registered), RMAN backup status and age of the last successful backup, and Scheduler job completion status.

The Metric Collection Settings define what is collected and how frequently. Most availability metrics are checked every minute; most capacity metrics (tablespace, archive logs) are checked every 30 minutes; AWR-based performance metrics are collected from the AWR snapshots. The collection frequency can be adjusted per target or per metric using the Metric Collection Settings page. Reducing collection frequency on non-critical targets is one of the first tuning steps in large OEM deployments where agent upload volume creates OMS resource pressure.

The Incident Management system converts threshold breaches and alert log detections into incidents that can be assigned to DBAs, acknowledged with suppression windows, or routed to external ticketing systems via notification rules. OEM ships with integration hooks for SNMP traps, email, and webhook-based integrations that can connect to ServiceNow, PagerDuty, or any HTTP endpoint. The notification rule system allows routing: all ORA-00600 errors to the on-call DBA, all tablespace-full alerts to a capacity management queue, all Data Guard lag alerts to the replication team.

Out of the box, OEM ships with three pre-built compliance frameworks: the CIS Oracle Database Benchmark, the DISA STIG for Oracle Database, and Oracle's own Security Configuration Standards. Running a compliance check against a newly monitored database typically surfaces 20–40 configuration findings, even on databases that have been deliberately hardened. Most findings relate to password management policies, audit trail configuration, listener security, and OS-level file permissions on Oracle homes. The compliance framework is one of OEM's most valuable features for regulated environments — it produces audit-ready compliance reports without requiring custom scripting.

---

## Agent Deployment Methods

The management agent must be deployed to every host that OEM will monitor. For a handful of hosts, manual deployment is acceptable. For an estate of 50 or more hosts, agent deployment method selection has a significant impact on operational efficiency and ongoing maintainability.

**Push installation from OMS console** is the most discoverable method: the DBA navigates to Setup → Add Target → Add Targets Manually in the browser, provides SSH credentials (username/password or private key), and the OMS SSH's into the target host and runs the agent installer remotely. This method is appropriate when the OMS host can reach the target host on SSH port 22, which is not always the case in security-hardened environments where east-west SSH is restricted. Push installation is convenient for individual hosts but does not scale to large fleets without scripting the console interactions — and the console does not expose a batch push API.

**AgentDeploy script (pull installation)** reverses the network direction: the DBA or an Ansible/shell automation script on the target host downloads \`agentDeploy.sh\` from the OMS and runs it locally. This is used when the OMS cannot initiate SSH to target hosts due to firewall rules. The agent connects outbound to the OMS on port 4900 (the upload port) — this direction is almost always permitted because agents need this connectivity to function. Pull installation requires the oracle user on the target host to have HTTPS access to the OMS, which is usually available.

**RPM-based installation** (Oracle Linux and RHEL only): Oracle provides an agent RPM that encapsulates the agent binaries. The RPM can be deployed via Ansible, Puppet, Chef, Red Hat Satellite, or any standard package management workflow. After RPM installation, the agent is registered with the OMS using \`emctl secure agent\` with an agent registration password. This is the cleanest method for large-scale fleet deployment — it is fully reproducible, produces consistent installations, integrates with existing infrastructure automation, and can be version-pinned in Ansible playbooks or Satellite channels. RPM deployment separates the installation step (Ansible deploys RPM) from the OMS registration step (\`emctl secure agent\`), which maps well to standard infrastructure provisioning workflows.

**Silent installation via response file** uses a pre-configured \`agent.rsp\` file for fully automated, no-GUI installation. This method is the foundation for all automated deployment approaches and is what the RPM and pull methods use internally. A single response file specifying the OMS host, upload port, agent base directory, and registration password enables repeatable unattended installation.

For enterprise deployments managing 30 or more agent hosts, the RPM + Ansible approach is strongly recommended over the GUI-based push method. It is reproducible across environments, auditable in version control, testable in staging before production deployment, and integrates with certificate management and OS hardening automation. The GUI push method creates "snowflake" installations that are difficult to reproduce consistently and impossible to audit.

---

## Patching and Lifecycle Management

Oracle patch management integration is OEM's highest single-value feature for most production Oracle environments. Managing Oracle patches manually — downloading from MOS, staging, running \`opatch\`, validating — is time-consuming and error-prone when done across an estate of more than a handful of database homes. OEM's Automated Patch Workflow integrates directly with My Oracle Support to streamline this process.

OEM integrates with MOS to download Database Release Updates (RUs), Release Update Revisions (RURs), and one-off patches. The automated patch workflow proceeds as follows: the DBA selects a patch or patch plan in the OEM console, OEM downloads the patch binary to the Software Library (this is the step that requires the MOS credentials configured in OEM Setup and sufficient Software Library space), validates prerequisites using the \`opatch prereq\` checks, stages the patch to the target host, runs \`opatch apply\` or \`datapatch\` as appropriate, reports success or failure back to the console, and logs the patch action in the OEM patch history. All of these steps are visible in real time in the browser and logged for audit purposes.

Out-of-place patching for 12.2 and later databases is a significant operational improvement over in-place patching. Instead of patching the running Oracle Home (which requires downtime to stop and restart all databases using that home), OEM can provision a new Oracle Home, apply the target patch level to the new home while databases continue running on the old home, and then switch each database to the new home during a brief maintenance window. The databases on the old home remain available until the switch, and the switch itself requires only a database restart — not a re-patch of a running installation.

The Lifecycle Management pack (a separate license from the Database Management Pack required for basic OEM database monitoring) extends patching to fleet scale. With LM Pack, a DBA can define a gold image Oracle Home, distribute it to hundreds of hosts via the Software Library, patch the gold image once, and propagate the patched image to all hosts simultaneously. This changes quarterly patching from a weeks-long serialised process to a days-long parallel one. For large Oracle estates, the Lifecycle Management Pack pays for itself in reduced patching labour within the first patching cycle.

---

## Summary

Oracle Enterprise Manager 13c is built on a three-tier architecture: the Oracle Management Service (OMS) provides the console, job engine, and notification system; the Oracle Management Repository (OMR) stores all collected data and configuration in a licensed Oracle EE database; and Management Agents deployed on each monitored host collect metrics, scan alert logs, and execute jobs. The interplay between these three tiers — agent uploads flowing to OMS, OMS writing to OMR, DBA browser sessions reading from OMS — determines both the performance characteristics and the failure modes of the platform.

The hardware prerequisites for OEM are routinely underestimated, particularly for the OMS. The minimum 16 GB RAM for a small OMS installation is a true minimum that leaves little headroom; production deployments with more than 50 targets should plan for 24–32 GB. The OMR storage will grow at 1–5 GB per monitored database per month, and the Software Library will accumulate several hundred GB of patch content over time. NFS shared storage for the Software Library is mandatory for any HA or multi-OMS deployment and must be allocated and tested before installation begins.

The three deployment topologies — single OMS, two-OMS HA with load balancer, and multi-site enterprise — map to organisation size and availability requirements. For any production Oracle estate, the HA topology with two OMS instances is the minimum recommended deployment: the cost of the additional OMS host is trivial compared to the cost of OEM being unavailable when a critical alert fires and the on-call DBA cannot access the console. The multi-site topology is appropriate for global deployments where agent hosts and OMS instances span multiple data centres.

OEM is not a lightweight tool — it requires dedicated infrastructure investment, ongoing DBA attention to the OEM platform itself (patching the OMS, monitoring the OMR), and careful capacity planning. But for estates of more than 20–30 Oracle databases, the monitoring automation, centralised alerting, compliance reporting, and patch orchestration it provides return that investment quickly. The alternative — individual database monitoring scripts, manual alert log checks, manual patch deployments — does not scale, is inconsistent, and creates exactly the operational risk that OEM is designed to eliminate.`,
};

async function main() {
  console.log('Inserting OEM architecture/installation planning post...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: { ...post },
  });
  console.log('Inserted: "' + post.title + '"');
}

main().catch(console.error);
