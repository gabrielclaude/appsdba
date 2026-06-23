import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Migrating Oracle On-Premises to Oracle 19c on RHEL 9 on Google Cloud: Strategy, Architecture, and What Actually Changes',
  slug: 'oracle-onprem-to-19c-rhel9-gcp-migration-strategy',
  excerpt:
    'A practical guide to migrating a self-managed Oracle database from on-premises infrastructure to Oracle 19c on RHEL 9 on Google Cloud Compute Engine — covering migration method selection, GCP storage and network architecture, RMAN and Data Guard migration paths, backup strategy with Cloud Storage, and the operational differences DBAs encounter after cutover.',
  category: 'oracle-google-cloud' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-22'),
  youtubeUrl: null,
  content: `## Overview

Moving an Oracle database from on-premises hardware to Google Cloud Platform (GCP) is not a software upgrade — it is an infrastructure migration that changes how compute, storage, networking, backup, and monitoring work simultaneously. Done without a clear architecture plan, the result is a cloud-hosted database that performs worse than the system it replaced, costs more than expected, and behaves differently enough that the operations team is constantly reacting to new failure modes.

Done with the right approach, a GCP migration gives an Oracle 19c database elastic compute scaling, managed storage with defined SLA tiers, integrated backup to Google Cloud Storage (GCS), native GCP monitoring and alerting, and a network architecture that eliminates the single-datacenter failure domain of on-premises hardware.

This post covers the migration strategy options, GCP architecture for self-managed Oracle 19c on RHEL 9, the key differences in storage and networking compared to on-premises, backup strategy with GCS, and what changes operationally for the DBA team after cutover.

---

## Migration Strategy: Choosing the Right Method

The first decision is which migration method matches your RPO/RTO requirements and the acceptable downtime window. There are four viable approaches for Oracle to GCP:

### 1. RMAN Active Duplicate (Online, No Downtime During Copy)

RMAN active duplicate copies the database over the network from the source to the target while the source remains open. The target database is built from a live backup of the source. After the duplicate completes, a final incremental catch-up and a controlled cutover window (typically 30–60 minutes) applies remaining redo and opens the target database.

**Best for:** databases up to 2–4 TB, acceptable downtime of 1–2 hours for the final cutover increment, no existing Oracle Data Guard infrastructure.

**Limitation:** the entire database must be transferred over the network during the duplicate. On a constrained WAN link between on-premises and GCP, transfer time for large databases can be days.

### 2. Oracle Data Guard (Zero-Downtime Cutover)

A physical standby database is built on GCP from an RMAN backup of the source, then configured as a Data Guard standby. It applies redo logs from the primary continuously. When ready to cut over, the standby is activated as the new primary with a switchover (planned, zero data loss) or failover (unplanned, possible seconds of lag).

**Best for:** large databases (> 4 TB), mission-critical systems where downtime must be under 5 minutes, or when a GCP-based DR site is also required post-migration.

**Limitation:** requires configuring Oracle Net connectivity between on-premises and GCP for redo transport, which involves VPN or Cloud Interconnect setup and firewall rules in both directions.

### 3. Oracle Data Pump (Logical Export/Import)

Data Pump exports schema objects and data to a dump file set, transfers the files to GCP via \`gsutil\` or Storage Transfer Service, and imports them into a freshly created Oracle 19c database on GCP.

**Best for:** major version upgrades (e.g., Oracle 11g or 12c on-premises to 19c on GCP), schema restructuring during migration, selective object migration (not full database).

**Limitation:** Data Pump is a logical migration — it does not transfer redo history, sequence states (sequences must be re-created at the correct next value), or optimizer statistics at the block level. Downtime window equals export + transfer + import time, which for large schemas is typically many hours to days.

### 4. Oracle GoldenGate (Continuous Replication, Near-Zero Downtime)

GoldenGate captures changes from the source database's redo log and applies them continuously to the target Oracle 19c on GCP. The initial load is handled by a parallel extract/apply; ongoing changes are replicated in near real-time. Cutover is a controlled stop of writes at the source, a final apply at the target, and traffic redirection.

**Best for:** zero-downtime migrations with very tight downtime windows (< 1 minute), heterogeneous migrations (Oracle to Oracle at different versions or platforms), or when the target needs to be a different schema version than the source.

**Limitation:** GoldenGate licensing, DDL replication complexity, and the requirement that the source database have supplemental logging enabled.

---

## GCP Architecture for Self-Managed Oracle 19c on RHEL 9

The term "Oracle on Google Cloud" covers two distinct deployment models that are frequently confused:

**Oracle Database@Google Cloud (OD@GC)**: Oracle-managed Exadata hardware physically located inside Google data centres, connected to GCP networking. Fully managed by Oracle at the infrastructure layer. This is a premium service optimised for very large Oracle workloads.

**Self-managed Oracle on GCE**: Oracle 19c installed by the customer on a Google Compute Engine virtual machine running RHEL 9. The customer manages the OS, Oracle software, patching, backup, and HA. This is the subject of this post — it is the direct equivalent of running Oracle on-premises, except the server is a GCE VM.

### Compute: GCE Instance Selection

GCE instance family selection for Oracle 19c follows different logic than on-premises server sizing:

| Workload Type | Recommended Family | Notes |
|--------------|-------------------|-------|
| OLTP (EBS, ERP) | n2-standard, n2-highmem | Balanced vCPU/RAM, good baseline IOPS |
| Analytics / DW | m3-ultramem, m2-megamem | Up to 12 TB RAM for in-memory analytics |
| Dev / Test | e2-standard | Cost-optimised, lower guaranteed performance |
| ASCP / Batch | c2-standard | High-frequency CPU for compute-intensive planning |

For production Oracle 19c OLTP workloads, \`n2-highmem-32\` (32 vCPU, 256 GB RAM) or \`n2-highmem-64\` (64 vCPU, 512 GB RAM) are common starting points. GCE instances can be resized online (with a reboot) as workload requirements change — a significant advantage over on-premises hardware.

**Oracle licensing on GCE**: Oracle licenses count vCPUs on GCE as physical cores for licensing purposes at a 0.5 core factor (i.e., 2 vCPUs = 1 Oracle processor license). This is the same as on-premises multi-core Intel processors. Confirm the current Oracle licensing rules for your GCE machine type before deployment.

### Storage: Persistent Disk and Hyperdisk

On-premises Oracle databases typically use SAN storage (iSCSI or Fibre Channel) or local NVMe for redo logs and datafiles. On GCP, storage is network-attached block storage in the form of Persistent Disk (PD) or Hyperdisk.

| Storage Type | Use Case | Max IOPS | Max Throughput | Notes |
|-------------|----------|----------|----------------|-------|
| \`pd-standard\` | Dev/Test, archive | 3,000 | 200 MB/s | HDD-backed, avoid for Oracle production |
| \`pd-balanced\` | General-purpose Oracle | 80,000 | 1,200 MB/s | Good default for non-latency-sensitive workloads |
| \`pd-ssd\` | Production Oracle OLTP | 100,000 | 2,400 MB/s | IOPS and throughput scale linearly with disk size |
| \`pd-extreme\` | High-performance OLTP | 350,000 | 7,200 MB/s | Requires n2 or c2 instance family |
| Hyperdisk Extreme | Redo logs, latency-critical | 1,000,000 | 9,600 MB/s | Best for LGWR — lowest write latency on GCP |

**Critical storage layout rule**: Oracle online redo logs must be on a separate disk from datafiles, for the same reason as on-premises. On GCP, use a dedicated Hyperdisk Extreme or \`pd-extreme\` volume for redo logs and a separate \`pd-ssd\` volume for datafiles. Never share a single GCP disk across redo and datafiles.

**IOPS provisioning on pd-ssd**: GCP \`pd-ssd\` provides 30 IOPS per GB provisioned. A 2 TB \`pd-ssd\` disk provides 60,000 IOPS — adequate for most Oracle production workloads. If you need more IOPS without more space, use \`pd-extreme\` which allows manual IOPS provisioning.

### Networking: VPC and Connectivity

On-premises Oracle databases communicate with application servers over a physical LAN (sub-millisecond latency). On GCP:

- **Application servers in GCP**: sub-millisecond latency over GCP's internal VPC network. No performance regression from on-premises LAN.
- **Application servers on-premises**: latency depends on connectivity type. Cloud VPN (IPsec over internet): 20–80 ms typical. Cloud Interconnect (dedicated fibre): 1–5 ms typical. For Oracle EBS or other latency-sensitive applications, Cloud Interconnect is mandatory if the application tier remains on-premises during migration.

**Firewall rules**: GCP VPC firewall rules replace on-premises network ACLs. Oracle Net (listener) typically uses TCP port 1521. The VPC firewall must allow traffic from application server subnets to the Oracle host on port 1521.

### Backup Strategy with Google Cloud Storage

On-premises Oracle backup typically writes to tape, NAS, or a dedicated backup appliance. On GCP, the natural target is Google Cloud Storage (GCS), which provides:

- Infinite capacity (no pre-provisioned storage to run out of)
- 11 nines durability (geo-redundant storage class)
- Lifecycle policies for automatic tiering from Standard to Nearline to Coldline/Archive as backups age
- \`gsutil\` and GCS FUSE for integration with RMAN

**RMAN backup to GCS** is accomplished via the Oracle Cloud Backup Module (OCBM), which integrates RMAN channels directly with GCS. Alternatively, RMAN backs up to local disk and a \`gsutil rsync\` cron job copies backup files to GCS.

\`\`\`bash
# Example: rsync RMAN backups to GCS after each backup completes
gsutil -m rsync -r /u01/app/oracle/rman_backup/ gs://company-oracle-backups/prod/rman/
\`\`\`

GCS lifecycle policy to tier backups:
\`\`\`json
{
  "lifecycle": {
    "rule": [
      {
        "action": {"type": "SetStorageClass", "storageClass": "NEARLINE"},
        "condition": {"age": 7}
      },
      {
        "action": {"type": "SetStorageClass", "storageClass": "COLDLINE"},
        "condition": {"age": 30}
      },
      {
        "action": {"type": "Delete"},
        "condition": {"age": 365}
      }
    ]
  }
}
\`\`\`

---

## Oracle 19c Specifics for RHEL 9 on GCP

Oracle 19c is certified on RHEL 9 (as of Oracle 19c RU 19.19+). The key differences from RHEL 7/8 installations:

- **\`systemd\` manages Oracle services**: \`oracleasm\` and Oracle listener/database startup use systemd unit files rather than init scripts. \`/etc/rc.d/rc.local\` is deprecated — use \`/etc/systemd/system/oracle.service\` for startup automation.
- **Python 3.9+ is the system Python**: Oracle installer scripts that assume \`/usr/bin/python\` is Python 2 will fail. Create a compatibility symlink: \`ln -s /usr/bin/python3 /usr/bin/python\`.
- **\`firewalld\` replaces \`iptables\`**: Oracle Net listener port (1521) must be opened via \`firewall-cmd\`, not \`iptables -A INPUT\`.
- **Async I/O**: \`FILESYSTEMIO_OPTIONS=SETALL\` and \`DISK_ASYNCH_IO=TRUE\` remain the correct settings for GCE Persistent Disk on RHEL 9.

---

## What Changes Operationally After Cutover

**Patching**: On-premises Oracle patching required coordinating with the storage and OS teams for maintenance windows. On GCP, the GCE instance can be snapshot before patching (10-second operation), providing an instant rollback point if the patch causes problems.

**Scaling**: Adding RAM or CPU on-premises required a hardware procurement cycle (weeks to months). On GCP, a GCE instance resize is a configuration change and a reboot — minutes to complete.

**Monitoring**: On-premises monitoring typically used Nagios, Zabbix, or a commercial APM tool deployed internally. On GCP, Cloud Monitoring (formerly Stackdriver) provides native integration with GCE host metrics (CPU, memory, disk IOPS, throttle events). Oracle-level metrics (wait events, tablespace utilisation) still require database-aware scripts or Oracle Enterprise Manager.

**Disaster Recovery**: On-premises DR typically required a second physical datacenter and dedicated hardware. On GCP, a Data Guard standby can be placed in a second GCP region with Cloud Interconnect between regions, at a fraction of the cost of a second physical datacenter.

**Backup windows**: On-premises RMAN backups wrote to NAS or tape — backup window was determined by the write speed of the backup target. On GCP, RMAN backs up to local \`pd-ssd\` (fast write, high cost) and a \`gsutil\` job moves files to GCS Standard → Nearline → Coldline automatically. Effective backup storage cost drops significantly as backups age.

---

## Summary

Migrating Oracle on-premises to Oracle 19c on RHEL 9 on GCE is an infrastructure migration with four viable execution paths: RMAN active duplicate (simple, minutes of cutover downtime), Data Guard (near-zero downtime, requires redo transport connectivity), Data Pump (logical migration, best for version upgrades), and GoldenGate (zero downtime, highest complexity and cost). Storage architecture on GCP requires deliberate design — Hyperdisk Extreme or \`pd-extreme\` for redo logs, \`pd-ssd\` for datafiles, never sharing a single disk — and GCP enforces hard IOPS/throughput ceilings that must be provisioned ahead of workload demand. Backup to GCS with lifecycle tiering replaces tape and NAS infrastructure with infinite-capacity managed storage at progressively lower cost. The operational changes after cutover — GCE snapshot-before-patch, elastic compute resizing, and Cloud Monitoring integration — represent genuine improvements over on-premises operations once the team adapts to the different tooling model. The companion runbook provides the step-by-step implementation procedure and monitoring scripts for day-two operations.`,
};

async function main() {
  console.log('Inserting Oracle on-prem to GCP migration blog post...');
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
