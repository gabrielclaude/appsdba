import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS 12.2.11 on RHEL 9: Architecture, Physical Standby, Mid-Tier HA, and DR Strategy',
  slug: 'oracle-ebs-12211-rhel9-dr-architecture',
  excerpt:
    'A technical guide to Oracle E-Business Suite 12.2.11 on RHEL 9 — the online patching filesystem architecture, Oracle 19c Data Guard physical standby configuration for the database tier, rsync-based mid-tier filesystem replication for the application tier, RPO/RTO analysis, DR test methodology, and the monitoring architecture that keeps the entire stack visible.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-25'),
  youtubeUrl: null,
  content: `## Overview

Oracle E-Business Suite 12.2.11 is Oracle's current release of EBS 12.2, built on an online patching architecture that eliminates downtime for most patching operations. The combination of Oracle 19c as the database tier, WebLogic 12.1.3 as the application server, and Oracle HTTP Server 2.4 as the reverse proxy creates a multi-tier stack that requires a DR strategy addressing each tier independently — because the database tier and application tier have different replication mechanisms, different failure modes, and different recovery procedures.

This post covers the EBS 12.2.11 architecture as it relates to installation on RHEL 9, the physical standby design for the database tier, the rsync-based filesystem replication strategy for the application tier, the RPO/RTO implications of each approach, and the DR test methodology that verifies the architecture works before it is needed.

---

## EBS 12.2.11 Architecture

EBS 12.2.11 has a two-tier architecture: a database tier running Oracle 19c, and an application tier running WebLogic, Oracle HTTP Server, Forms & Reports, and Concurrent Managers. What distinguishes EBS 12.2 from earlier releases is the **online patching architecture** — every file on the application tier and every database object exists in two editions simultaneously (RUN and PATCH), enabling patches to be applied while the system remains online.

### Application Tier Filesystem Layout

The EBS 12.2 application tier maintains two parallel filesystem trees for online patching:

\`\`\`
/u01/oracle/VIS/                       (EBS base)
  ├── fs1/                             (Filesystem 1 — one of RUN or PATCH)
  │     ├── EBSapps/                   (APPL_TOP, COMMON_TOP, etc.)
  │     └── FMW/                       (WebLogic domain, OHS)
  ├── fs2/                             (Filesystem 2 — the other of RUN or PATCH)
  │     ├── EBSapps/
  │     └── FMW/
  └── fs_ne/                           (Non-Edition files — shared by both)
        ├── inst/                      (Context files, AutoConfig output)
        └── log/                       (Patch logs, application logs)
\`\`\`

At any given time, one filesystem is the **RUN filesystem** (serving live traffic) and the other is the **PATCH filesystem** (receiving patch updates). The \`adop cutover\` phase switches which is RUN and which is PATCH — the switch takes under 2 minutes and causes zero downtime for most patches.

### Database Tier: Edition-Based Redefinition

On the database side, Oracle 19c's Edition-Based Redefinition (EBR) maintains the same RUN/PATCH duality. During adop, the PATCH edition receives DDL changes while the RUN edition continues serving application traffic. The \`adop cutover\` phase makes the PATCH edition the new RUN edition.

### Key Application Tier Processes

| Process | Role | Port |
|---------|------|------|
| Oracle HTTP Server (OHS) | Reverse proxy, SSL termination | 443 / 4443 |
| WebLogic AdminServer | Domain administration | 7001 |
| oacore (WLS managed server) | OA Framework pages (AOL/J, self-service) | 8000 |
| oafm (WLS managed server) | OA Framework utilities, ADF | 8400 |
| oapls (WLS managed server) | PL/SQL gateway | 8200 |
| Forms Server (frmweb) | Oracle Forms | 9000 |
| Concurrent Manager | Batch processing | N/A (DB-connected) |
| Workflow Mailer | Email notifications | N/A |

---

## EBS 12.2.11 on RHEL 9

RHEL 9 introduces several changes that affect EBS 12.2.11 installation and operation:

**Python 3.9 as system Python**: EBS startup scripts and adop use Python internally. RHEL 9 ships without \`/usr/bin/python\` by default. The compatibility symlink or \`python3\` alias must be configured before running any EBS tooling.

**libnsl removal**: \`libnsl\` (the NIS library) was removed from RHEL 9 base packages. Oracle Forms and some EBS components depend on it. The \`libnsl2\` or \`libnsl2-devel\` packages from RHEL 9 must be installed as replacements.

**OpenSSL 3.0**: RHEL 9 ships with OpenSSL 3.0, which drops support for legacy algorithms (MD5, SHA-1 in some contexts, older TLS ciphers). OHS 2.4 and the EBS wallet configuration must use certificates and ciphers compatible with OpenSSL 3.0.

**systemd only**: RHEL 9 has no SysV init compatibility layer for most services. EBS startup scripts (\`adstrtal.sh\`, \`adstpall.sh\`) are called from custom systemd unit files rather than \`/etc/rc.d/rc.local\`.

**Firewalld**: RHEL 9 uses \`firewalld\`. The EBS port set (443, 4443, 8000, 8200, 8400, 9000, 1521) must be opened via \`firewall-cmd\`.

---

## Database Tier HA: Oracle Data Guard Physical Standby

The database tier DR strategy for EBS 12.2.11 uses Oracle 19c Physical Standby (Data Guard). A physical standby is a block-for-block copy of the primary database, kept current by continuously applying redo log streams from the primary.

### Redo Transport Mode

The choice of redo transport mode determines the RPO:

| Mode | Archive | Affirm | Data Loss | Performance Impact |
|------|---------|--------|-----------|-------------------|
| ASYNC NOAFFIRM | ASYNC | No | Seconds to minutes | Minimal |
| ASYNC AFFIRM | ASYNC | Yes | Seconds | Low |
| SYNC NOAFFIRM | SYNC | No | Near zero | Moderate |
| SYNC AFFIRM | SYNC | Yes | Zero (Maximum Protection) | High |

For most EBS 12.2.11 production deployments, **ASYNC NOAFFIRM** is the default — it provides good protection with negligible performance impact on the primary. The redo lag (how far behind the standby is) is typically 1–10 seconds for databases in the same datacenter.

For legally mandated zero data loss (financial consolidation close periods, regulatory submissions), **SYNC AFFIRM** can be activated temporarily, then switched back to ASYNC after the critical window.

### Data Guard and EBS Context Files

When Data Guard failover is triggered and the standby becomes the primary, the EBS application tier must be pointed at the new primary. This involves:

1. Updating the EBS context XML file (\`\${CONTEXT_FILE}\`) on the application tier — changing the database host, SID, and port entries to point to the new primary
2. Running AutoConfig on all application tier nodes with the updated context
3. Bouncing all EBS services (WebLogic, OHS, Concurrent Managers)

This post-failover application tier reconfiguration is the largest contributor to RTO. Automating it reduces the manual window from 45–60 minutes to 10–15 minutes.

---

## Application Tier HA: Mid-Tier Filesystem Replication via rsync

The EBS application tier filesystem is not automatically replicated — there is no Oracle-provided replication mechanism for the application tier files. The correct approach is periodic rsync of the application tier filesystem from the primary application server to the DR application server.

### What Must Be Replicated

The following directories must be in sync between primary and DR application servers:

| Directory | Contents | Rsync Frequency |
|-----------|----------|-----------------|
| \`fs1/EBSapps/\` | APPL_TOP, JAVA_TOP, OA_HTML for filesystem 1 | After each adop patch cycle |
| \`fs2/EBSapps/\` | APPL_TOP, JAVA_TOP, OA_HTML for filesystem 2 | After each adop patch cycle |
| \`fs1/FMW/\` | WebLogic domain for filesystem 1 | After config changes |
| \`fs2/FMW/\` | WebLogic domain for filesystem 2 | After config changes |
| \`fs_ne/inst/\` | Context files, AutoConfig output | Daily |
| Custom code | Any code under CUSTOM_TOP | After deployments |

### What Must NOT Be Replicated

| Directory | Reason |
|-----------|--------|
| \`fs_ne/log/\` | Logs are environment-specific, not needed on DR |
| WebLogic \`servers/\*/tmp/\` | Runtime temp files |
| WebLogic \`servers/\*/cache/\` | JVM class cache — regenerated on start |
| \`adop\` patch staging areas | Patch downloads are re-fetched as needed |

### Rsync Strategy for Online Patching

The online patching architecture creates a complication for rsync: when adop is running, the PATCH filesystem is being modified. Rsyncing during an adop \`apply\` phase will copy a partially-patched filesystem to DR, which is unusable.

Safe rsync windows:
- After \`adop cleanup\` completes (the entire patch cycle is done)
- During a maintenance window when no adop operations are in progress
- Using \`--checksum\` rather than timestamp-based comparison for critical directories

After rsyncing to the DR server, AutoConfig must be run on the DR application tier with the DR context file before the DR environment can serve traffic. This is because AutoConfig writes environment-specific paths, hostnames, and port numbers into configuration files throughout the filesystem — the DR server needs its own AutoConfig run, not a copy of the primary's AutoConfig output.

---

## RPO and RTO Analysis

### RPO (Recovery Point Objective)

| Component | Normal Operation RPO | Maximum Protection RPO |
|-----------|---------------------|----------------------|
| Database (ASYNC Data Guard) | 1–30 seconds of data | Switch to SYNC: zero |
| Application tier (rsync) | Time since last rsync (hours to days) | Continuous rsync: minutes |
| Context files and AutoConfig | Time since last rsync of fs_ne/inst | Same as above |

The application tier rsync RPO is often overlooked. If a patch is applied on Monday and DR is only rsynced weekly, a Monday-to-Friday failure means the DR application tier is running last week's code against this week's database. This mismatch produces errors — the DB schema (PATCH edition) was updated during adop, but the DR app tier still has the old application code.

**Key insight**: the database RPO and application tier RPO must be planned together. After every adop patch cycle completes (after \`adop cleanup\`), rsync must run before the next adop cycle begins. Otherwise the DR app tier and DB PATCH edition can diverge.

### RTO (Recovery Time Objective)

| Recovery Step | Typical Duration |
|--------------|----------------|
| Detect failure and decide to failover | 5–15 minutes |
| Data Guard failover (activate standby) | 2–5 minutes |
| Update EBS context file on DR app tier | 5 minutes (automated) |
| Run AutoConfig on DR app tier | 10–20 minutes |
| Start EBS services (WebLogic, OHS, CMs) | 5–10 minutes |
| Validate EBS is operational | 5–10 minutes |
| **Total RTO (automated)** | **~30–45 minutes** |
| **Total RTO (manual)** | **60–120 minutes** |

The AutoConfig step dominates RTO because it rewrites hundreds of configuration files across the application tier. Pre-running AutoConfig on the DR app tier during maintenance windows (when the DR DB is already the standby) reduces this to a pre-validated config that just needs service starts.

---

## DR Test Methodology

A DR plan that has never been tested is not a DR plan — it is a theory. DR tests for EBS 12.2.11 should be conducted quarterly and must exercise the complete failover procedure, not just database switchover in isolation.

### Test Categories

**Switchover Test (planned, no data loss)**: the primary and standby exchange roles in a controlled procedure. The primary is gracefully shut down, the standby is activated, EBS is validated on the DR site, then both databases switch back. No data loss. Use this for quarterly DR drills.

**Failover Test (simulated failure, possible data loss)**: the standby is activated without gracefully shutting down the primary — simulating an unplanned primary failure. Archive logs in transit at the moment of failure are lost. This tests the actual disaster scenario and must be done at least annually.

### Test Validation Checklist

A DR test is not complete until:
- Users can log into EBS on the DR site and navigate to their key modules
- Concurrent programs can be submitted and complete successfully
- A representative transaction (invoice entry, PO creation, journal entry) completes and posts correctly
- Integration endpoints (outbound interfaces to external systems) are either validated or documented as requiring manual re-pointing

### Application Tier Context After Failover

The most common DR test failure mode is an unconfigured application tier. After Data Guard failover:
\`\`\`
Primary DB host:   prod-db.internal.company.com (down or switched)
Standby DB host:   dr-db.internal.company.com   (now primary)
\`\`\`

The EBS context file on the DR app tier must reference \`dr-db.internal.company.com\` as its database host. If the context file still points to \`prod-db\`, AutoConfig will write incorrect configurations and EBS will fail to start or will silently fail to process transactions.

---

## Summary

Oracle EBS 12.2.11 on RHEL 9 requires a two-tier DR strategy because the database tier and application tier have different replication mechanisms. The database tier uses Oracle 19c Data Guard physical standby — ASYNC transport for normal operations with the option to switch to SYNC for zero data loss during critical periods. The application tier uses periodic rsync after each adop patch cycle — the rsync cadence must be aligned with patching frequency so the DR app tier never runs a different code version than the DR database schema edition. RPO for the database tier is seconds (ASYNC) or zero (SYNC); RPO for the application tier is hours unless rsync runs continuously or immediately after each patch cycle. RTO is dominated by the AutoConfig step on the DR application tier — automating the context file update and AutoConfig run reduces total RTO from 60–120 minutes (manual) to 30–45 minutes (automated). Quarterly DR switchover tests and annual failover tests are the only way to verify that the architecture actually delivers the documented RPO and RTO. The companion runbook provides the complete installation procedure for EBS 12.2.11 on RHEL 9, Data Guard configuration, rsync scripts, DR test procedures, and monitoring scripts for Data Guard lag, rsync freshness, and EBS service health.`,
};

async function main() {
  console.log('Inserting EBS 12.2.11 RHEL 9 blog post...');
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
