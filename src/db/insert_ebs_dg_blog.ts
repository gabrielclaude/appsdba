import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Data Guard for EBS 12.2.11: Architecture, Protection Modes, and EBS-Specific Considerations',
  slug: 'oracle-ebs-12211-data-guard',
  excerpt:
    'A technical guide to Oracle Data Guard for EBS 12.2.11: why a physical standby is the standard HA/DR mechanism for the EBS database tier, how the three Data Guard protection modes trade off between RPO and performance, EBS-specific concerns that do not exist in standalone database deployments (application tier reconnection after failover, shared concurrent log filesystem, TNS service configuration for transparent failover, Active Data Guard reporting compatibility, and how adop online patching interacts with redo shipping), and the Data Guard Broker configuration that automates switchover and failover.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-29'),
  youtubeUrl: null,
  content: `## Introduction

Oracle Data Guard is the standard high-availability and disaster recovery mechanism for the Oracle Database tier in an EBS 12.2.11 deployment. It maintains one or more synchronized copies of the primary database — called standby databases — on separate servers that can be promoted to the primary role in minutes when the original primary fails or needs planned maintenance.

For a standalone Oracle database, Data Guard configuration is well-documented and relatively straightforward. For Oracle EBS, Data Guard introduces a set of additional concerns that stem from the application architecture: the application tier has no knowledge of Data Guard until the primary database becomes unavailable, the EBS application tier connection pools do not automatically reconnect to the new primary after a failover, the shared concurrent log filesystem lives on the primary and must be addressed in DR planning, and online patching via adop generates redo that the standby must apply correctly to maintain edition-consistent synchronization.

This article covers the architecture, the protection mode selection for EBS workloads, and the EBS-specific considerations that distinguish this deployment from a generic Data Guard setup.

---

## Data Guard Architecture for EBS

In an EBS Data Guard deployment, the Oracle Database tier follows the standard Data Guard physical standby model:

\`\`\`
EBS Application Tier (WebLogic, OHS, CM)
        │
        │ SQL*Net (primary service name)
        ▼
Primary Database Server
  ├── EBSPRD (primary role, READ WRITE)
  ├── Redo log groups 1–4
  └── LGWR → redo transport → Standby Server

Standby Database Server
  ├── EBSPRD_STB (physical standby, MOUNTED or READ ONLY)
  ├── Standby redo log groups 1–5
  └── MRP0 (Managed Recovery Process — applies redo from primary)
\`\`\`

The application tier connects exclusively to the primary. The standby is passive — it receives redo, applies it, and waits. Users never connect to the standby in a standard (non-Active Data Guard) configuration.

### Physical vs Logical Standby

**Physical standby** is the correct choice for EBS. It replicates the database block-for-block using redo apply. The standby database is an exact binary copy of the primary at all times. All Oracle database features work on a physical standby with no compatibility restrictions.

**Logical standby** replicates by translating redo into SQL and replaying it on the standby. EBS is not supported with logical standby — the EBS schema contains constructs (object types, materialized views, certain table designs) that logical standby cannot replicate reliably. Oracle's EBS documentation explicitly requires physical standby.

---

## Data Guard Protection Modes

Oracle Data Guard offers three protection modes that define the synchronization guarantee and the behavior when the standby becomes unavailable:

### Maximum Performance (Asynchronous)

Redo is shipped to the standby asynchronously — the primary's LGWR does not wait for the standby to acknowledge receipt before completing a commit. The primary runs at full speed regardless of standby availability or network latency.

\`\`\`
Primary LGWR → write redo to local log → commit returns to application
ARCH (async) → ship redo to standby → standby applies
\`\`\`

**RPO**: Seconds to minutes — however much redo has been shipped but not yet applied when the primary fails. In practice, the standby typically lags by a few seconds to a few minutes depending on redo volume and network bandwidth.

**Impact on primary**: None — the primary never waits for the standby.

**Use case**: EBS instances where the standby is geographically remote (WAN latency would make synchronous shipping impractical) or where zero primary performance impact is an absolute requirement.

### Maximum Availability (Synchronous with Fallback)

Redo is shipped synchronously using the SYNC/AFFIRM transport mode. The primary's LGWR waits for at least one standby to acknowledge that the redo has been written to the standby redo log before completing a commit. If the standby becomes unavailable or the network degrades, the primary automatically falls back to asynchronous shipping and continues processing — it does not stall.

\`\`\`
Primary LGWR → write redo to local log →
              → ship redo to standby (SYNC/AFFIRM) →
              ← standby acknowledges redo written →
commit returns to application (no data loss if standby was up at failover)
\`\`\`

**RPO**: Zero when the standby is synchronized. If the primary fails while the standby is available and synchronized, no committed transactions are lost.

**Impact on primary**: Adds the round-trip latency of the network between primary and standby to every commit. On a low-latency LAN or dedicated replication network, this is typically sub-millisecond. On a WAN, it can add 10–100ms per commit, which is significant for high-transaction-rate EBS workloads.

**Use case**: The recommended mode for same-datacenter or low-latency cross-datacenter EBS deployments where zero data loss is required.

### Maximum Protection (Synchronous, No Fallback)

Like Maximum Availability but with no fallback — the primary shuts itself down if it cannot confirm that at least one standby has received the redo. This guarantees zero data loss but means the primary goes down if the standby or network fails.

For EBS, Maximum Protection is almost never used in production. A standby network failure would take down the EBS production instance. Maximum Availability achieves the same RPO under normal conditions without this risk.

---

## Standby Redo Logs: Sizing for EBS

Standby redo logs (SRLs) are required for real-time apply (the LGWR SYNC transport writes directly to SRLs on the standby, not to archived logs). They must be:

- The same size as the largest online redo log group on the primary
- At least one more group than the primary has online redo log groups per thread
- Multiplexed on separate storage for recoverability

For an EBS primary with four online redo log groups of 512 MB each, the standby requires at minimum five SRL groups of 512 MB each.

EBS generates substantial redo volume — concurrent programs running batch jobs, GL period-end processing, AR auto-invoicing, payroll runs — so redo log sizing must accommodate peak load, not average load. Undersized redo logs cause log switch waits on the primary and redo shipping gaps on the standby.

---

## EBS-Specific Considerations

### Application Tier Connection Configuration

The EBS application tier connects to the primary database via a TNS service name configured in tnsnames.ora. After a Data Guard failover, the new primary has the same database name but is running on the standby server. The application tier connection pools are pointing at the old primary's hostname — they do not automatically reconnect to the new primary.

There are three approaches to address this:

**Static TNS update with AutoConfig**: The simplest approach. After a failover, update the EBS context file with the new primary's hostname and re-run AutoConfig on all application tiers. This regenerates tnsnames.ora and requires bouncing the application tier connection pools. Downtime is the duration of the AutoConfig run plus the pool bounce — typically 5–15 minutes for a single-node app tier.

**Oracle SCAN / Single Client Access Name (for RAC)**: If the EBS database tier uses Oracle RAC with a SCAN listener, the SCAN name resolves to whichever RAC nodes are currently serving the primary role. After a failover within RAC, the SCAN continues resolving correctly.

**Database resident connection pools with Fast Application Notification (FAN)**: EBS 12.2 supports FAN events for connection pool notification. When Data Guard completes a failover and the new primary opens, FAN events notify the WebLogic JDBC connection pools to drain connections to the old primary and establish new connections to the new primary. This requires the UCP (Universal Connection Pool) or WebLogic Active GridLink data source configuration — not the default configuration in most EBS deployments.

For most EBS implementations, the AutoConfig re-run approach is the operational standard. It is manual but reliable, and the downtime is bounded and predictable.

### Shared Concurrent Log and Output Filesystem

EBS concurrent programs write their log and output files to the concurrent log filesystem (\$APPLCSF/\$APPLLOG and \$APPLCSF/\$APPLOUT), which lives on the application tier server — not in the database. This filesystem is not replicated by Data Guard (Data Guard replicates the database, not the application tier filesystem).

After a failover, concurrent programs that ran on the primary's application tier have their log and output files on the old primary's application tier. If that server is available (planned switchover scenario), these files remain accessible. If the primary server is completely lost (disaster failover), the concurrent logs are lost along with the server.

For planned switchovers, this is not a concern — log files persist on the (now standby) server.

For DR planning, consider:
- rsync replication of the concurrent log filesystem from the primary to the DR application tier (covered in the DR runbook)
- Accepting log loss for completed programs (the program result is in the database; only the text output file is lost)
- NetApp SnapMirror or equivalent if the concurrent logs are on a SAN/NAS that supports storage-level replication

### Active Data Guard for EBS Reporting

Oracle Active Data Guard (licensed separately from physical standby) allows the physical standby to be open in read-only mode while Managed Recovery continues applying redo. EBS users and reporting tools can connect to the standby for read-only queries — GL inquiries, AP reports, inventory inquiries — reducing load on the primary.

EBS 12.2 is supported with Active Data Guard under specific conditions documented in MOS Doc ID 1905769.1:
- The standby must run the same Oracle Database version and EBS code level as the primary
- Read-only connections must use a separate TNS service name that resolves to the standby
- Write attempts (INSERT, UPDATE, DELETE) from EBS sessions connected to the standby will fail with ORA-16000 — read-only connections must be explicitly directed to the Active Data Guard service
- The adop patching cycle runs on the primary — the standby applies the edition changes via redo

### adop Online Patching and Data Guard

The adop patching cycle generates redo on the primary that the standby applies like any other redo. This includes:
- File copy operations (these do not generate database redo — they only affect the application filesystem)
- PL/SQL compilation in the PATCH edition (generates redo for the edition's object cache)
- DML against seed data tables (standard redo)
- DDL operations during finalize (generates redo via Edition-Based Redefinition metadata)
- The edition switchover at cutover (alters the default edition — generates redo)

The standby applies all of this redo correctly. When the primary switches its default database edition from RUN to PATCH at cutover, the standby's edition structure also switches — the standby and primary remain in sync at the edition level.

One operational implication: if a Data Guard switchover is performed while an adop cycle is in the APPLY phase (between prepare and cutover), the new primary inherits the partial cycle state. The cycle can be resumed on the new primary by running \`adop phase=apply status=resume\`.

### Flashback Database and Snapshot Standby

For DR testing, the standby can be converted to a snapshot standby — opened read-write while redo from the primary is buffered. When the DR test is complete, the snapshot standby is converted back to a physical standby with guaranteed restore point recovery. This is covered in the DR testing runbook.

Data Guard Broker manages the snapshot standby conversion with:

\`\`\`
DGMGRL> CONVERT DATABASE ebsprd_stb TO SNAPSHOT STANDBY;
DGMGRL> CONVERT DATABASE ebsprd_stb TO PHYSICAL STANDBY;
\`\`\`

Flashback Database must be enabled on the standby for snapshot standby to work. The Fast Recovery Area must be large enough to retain flashback logs for the duration of the DR test.

---

## Data Guard Broker

Oracle Data Guard Broker (DGMGRL) provides centralized management of the Data Guard configuration. It:
- Monitors primary and standby health and lag
- Automates switchover and failover operations with pre-flight checks
- Provides Fast-Start Failover (FSFO) — automated failover without DBA intervention when configured with an observer process
- Stores the configuration in a broker configuration file replicated to both primary and standby

For EBS, Broker simplifies the switchover and failover procedures to single commands:

\`\`\`
# Planned switchover (both databases available):
DGMGRL> SWITCHOVER TO ebsprd_stb;

# Failover (primary unavailable):
DGMGRL> FAILOVER TO ebsprd_stb;
\`\`\`

Each command runs the necessary pre-flight checks, sequences the role transitions, and confirms completion. Without Broker, the equivalent sequence requires multiple manual SQL commands on both primary and standby.

---

## Protection Mode Selection for EBS

For most EBS deployments:

| Scenario | Recommended Mode | Rationale |
|---|---|---|
| Same datacenter, < 1ms network | Maximum Availability | Zero RPO without performance impact |
| Cross-datacenter, < 5ms network | Maximum Availability | Synchronous commit overhead is acceptable |
| Cross-datacenter, > 10ms network | Maximum Performance | WAN latency makes synchronous impractical |
| Tertiary standby (cascade) | Maximum Performance | Cascaded standbys always use async |
| Active Data Guard reporting standby | Maximum Performance | Reporting standby does not need synchronous |

---

## Summary

Oracle Data Guard provides the database tier HA and DR foundation for EBS 12.2.11. Physical standby is the only supported Data Guard configuration for EBS — logical standby is not compatible. Maximum Availability mode (synchronous redo shipping with automatic fallback) is the recommended protection mode for same-datacenter and low-latency cross-datacenter deployments.

The EBS-specific considerations that distinguish this from a generic Data Guard deployment are: the application tier must be manually reconnected to the new primary via AutoConfig after a failover, the concurrent log filesystem is not replicated by Data Guard, Active Data Guard for reporting requires explicit connection routing and EBS compatibility validation, and adop patching cycles continue normally through Data Guard — the standby applies edition changes as standard redo.

The companion runbook covers the complete configuration sequence from primary parameter changes through RMAN active duplicate, standby redo log creation, Broker configuration, application tier TNS setup, and the exact switchover and failover command sequences with verification steps.`,
};

async function main() {
  console.log('Inserting EBS Data Guard blog post...');
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
