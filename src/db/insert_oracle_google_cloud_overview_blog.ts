import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Database@Google Cloud: What It Is and Why It Matters',
  slug: 'oracle-database-google-cloud-overview',
  excerpt:
    'A blog-style overview of Oracle Database@Google Cloud — the partnership that lets you run Oracle Exadata on Google infrastructure, connect to GCP services natively, and avoid rewriting your clinical applications.',
  category: 'oracle-google-cloud' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-22'),
  youtubeUrl: null,
  content: `Oracle and Google announced a landmark cloud partnership in 2023 that went live in the first two regions — Ashburn (us-east4) and London (europe-west2) — before expanding globally. The product is called Oracle Database@Google Cloud, abbreviated OD@GC. Understanding what it actually is — and is not — prevents the misconfigurations that trip up every initial deployment.

---

## What OD@GC Actually Is

Oracle Database@Google Cloud is Oracle Exadata hardware physically located inside Google Cloud data centres, operated and managed by Oracle, and connected directly to GCP's network fabric via a high-bandwidth private interconnect.

It is **not** a virtual machine running Oracle Database on GCP Compute Engine. It is dedicated Exadata X8M or X9M engineered hardware — the same chassis, storage cells, and InfiniBand (or RoCE on X9M) fabric that ships to on-premises customers — sitting in Google's cage, with Oracle engineers responsible for the infrastructure layer.

The implication: you get Exadata's Smart Scan offloading, Storage Index, Hybrid Columnar Compression, and IORM workload management, all inside GCP's networking boundary. You lose direct hardware access — Oracle manages firmware, patching, and storage cell operations. You keep Oracle Database licensing compliance and the same DBA skill set.

---

## Architecture

\`\`\`
┌─────────────────────────────────────────────────────────────────┐
│  Google Cloud Data Centre (e.g. us-east4 / Ashburn)            │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Oracle Database@Google Cloud (OD@GC)                   │   │
│  │                                                          │   │
│  │  Exadata X9M Compute Nodes  ←→  Storage Cells           │   │
│  │  (Oracle DB 19c / 21c)           (CELLSRV, Smart Scan)  │   │
│  │                                                          │   │
│  │  Managed by Oracle (firmware, storage, IORM)            │   │
│  └──────────────────────┬───────────────────────────────────┘   │
│                         │  Private Interconnect                  │
│                         │  (<1ms latency, 10 Gbps+)             │
│  ┌──────────────────────▼───────────────────────────────────┐   │
│  │  GCP VPC (customer-managed)                             │   │
│  │                                                          │   │
│  │  GCE Instances     BigQuery     Cloud Storage           │   │
│  │  (EBS app tier)    (analytics)  (RMAN backups)          │   │
│  │                                                          │   │
│  │  Vertex AI         Pub/Sub      Cloud Logging           │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
\`\`\`

The private interconnect between OD@GC and the customer VPC uses Google's internal network — not the public internet. Round-trip latency from a GCE instance in the same region to the OD@GC database is sub-millisecond under normal conditions, comparable to on-premises Exadata in the same data centre.

---

## Available Database Services

OD@GC offers two primary database services:

### Exadata Database Service (ExaDB-D)

The flagship service. You provision a VM Cluster on the Exadata infrastructure, choosing:

- **Shape**: X8M or X9M hardware
- **Compute nodes**: minimum 2 (RAC by default), scalable up to the full rack count
- **Storage**: Exadata storage cells with configurable ASM disk groups

You manage the Oracle Database instances (create CDBs, PDBs, configure parameters, apply Oracle patches via OPatch). Oracle manages the Exadata infrastructure below the OS level.

### Base Database Service (BaseDB) on OD@GC

Single-instance or RAC Oracle Database on Exadata infrastructure, with simpler provisioning for teams that do not need full ExaDB-D control.

---

## GCP-Native Integrations That Matter

One of the primary reasons to use OD@GC over running Oracle on a GCE VM is the set of native GCP service integrations included in the platform.

### Cloud Storage for RMAN

Configure RMAN to back up directly to GCS:

\`\`\`sql
-- RMAN configuration for GCS backup
CONFIGURE CHANNEL DEVICE TYPE SBT
  PARMS 'SBT_LIBRARY=/opt/oracle/dcs/commonstore/pkgrepos/oss/odbcs/libopc.so,
         SBT_PARMS=(OPC_PFILE=/u01/oracle/dcs/commonstore/oci_config.txt)';

CONFIGURE DEFAULT DEVICE TYPE TO SBT;
CONFIGURE BACKUP OPTIMIZATION ON;
CONFIGURE ARCHIVELOG DELETION POLICY TO APPLIED ON ALL STANDBY;
\`\`\`

Backup throughput to GCS from OD@GC within the same region is typically 500 MB/s–2 GB/s depending on RMAN channel count and object size.

### BigQuery External Tables

BigQuery can query Oracle data on OD@GC without copying it. Oracle BigQuery Connector creates a Federated External Table in BigQuery that issues queries to the Oracle database via an OMNI connection:

\`\`\`sql
-- Create a BigQuery external table over Oracle data (executed in BigQuery)
CREATE EXTERNAL TABLE project.dataset.gl_balances
OPTIONS (
  format = 'ORACLE',
  connection = 'projects/my-project/locations/us-east4/connections/oracle-conn',
  table_id = 'GL_BALANCES'
);

-- Query from BigQuery — predicates pushed down to Oracle Smart Scan
SELECT period_name, SUM(begin_balance_dr) total_dr
FROM project.dataset.gl_balances
WHERE ledger_id = 1001 AND period_year = 2026
GROUP BY period_name;
\`\`\`

This is particularly powerful for Oracle EBS shops that want to use BigQuery ML or Looker Studio against EBS GL data without a full ETL pipeline.

### Pub/Sub for Event Streaming

Oracle Database 19c+ supports Transactional Event Queues (TEQ, formerly Advanced Queuing). With the GCP Pub/Sub connector, Oracle can publish database events directly to a GCP Pub/Sub topic:

\`\`\`sql
-- Create a TEQ that publishes to GCP Pub/Sub
BEGIN
  DBMS_AQADM.CREATE_QUEUE_TABLE(
    queue_table        => 'ebs_events_qt',
    queue_payload_type => 'SYS.AQ$_JMS_TEXT_MESSAGE'
  );
  DBMS_AQADM.CREATE_QUEUE(
    queue_name  => 'ebs_events_q',
    queue_table => 'ebs_events_qt'
  );
  DBMS_AQADM.START_QUEUE(queue_name => 'ebs_events_q');
END;
/
\`\`\`

### Vertex AI Integration

Vertex AI can connect to OD@GC Oracle data for model training and inference. The typical pattern for Oracle EBS analytics:

1. Oracle data on OD@GC → BigQuery via external table or BigQuery Omni
2. BigQuery → Vertex AI Dataset for model training
3. Vertex AI model endpoint deployed → predictions written back to Oracle via Cloud Functions or OIC

### Cloud Monitoring and Logging

Oracle Cloud Observability integrates with GCP Cloud Monitoring. Database metrics (CPU, I/O, wait events, ASM disk group usage) are published as custom metrics to Cloud Monitoring:

\`\`\`bash
# Verify Oracle DB metrics are flowing to Cloud Monitoring
gcloud monitoring metrics list --filter="metric.type:custom.googleapis.com/oracle"
\`\`\`

Create alerting policies in GCP for Oracle metrics directly in the Google Cloud Console — no separate OEM instance required.

---

## Why It Matters for Oracle EBS Shops

The primary barrier to cloud migration for Oracle EBS customers has historically been: "Oracle doesn't certify EBS on AWS/Azure/GCP VMs." That barrier is resolved with OD@GC.

**EBS on OD@GC architecture:**

\`\`\`
EBS Application Tier (GCE instances, e.g. c3-highcpu-44)
  - WebLogic managed servers
  - Concurrent Manager
  - Forms/OHS
        ↓ 1521/TCP (private VPC interconnect, sub-ms latency)
OD@GC Exadata (ExaDB-D)
  - Oracle Database 19c
  - EBS APPS schema (APPLSYS, GL, AP, AR, etc.)
  - RMAN → GCS (automated daily backup)
  - Data Guard standby → second OD@GC region (us-central1)
\`\`\`

Oracle fully certifies EBS R12.2.x running with the database on OD@GC. Your DBA team manages the Oracle Database — parameters, patching, performance tuning — exactly as they would on-premises. No application rewrite. No schema migration. No Oracle license compliance gap.

---

## Oracle Clinical / Life Sciences Use Case

For pharmaceutical organisations running Oracle Clinical CDMS or NuGenesis SDMS on Oracle Database, OD@GC provides:

- **21 CFR Part 11 compliance**: GCP's audit logging captures all control plane actions (who provisioned what, when). Oracle Unified Auditing captures all database-level changes. The combined audit trail satisfies FDA requirements.
- **Annex 11 compliance**: Oracle Data Guard on OD@GC provides documented disaster recovery with RTO/RPO commitments.
- **ERES (Electronic Records / Electronic Signatures)**: Oracle Database Vault on OD@GC prevents even DBAs from directly modifying GxP-regulated data.
- **IQ/OQ support**: OD@GC's infrastructure layer is managed by Oracle and can be included in a Computer System Validation scope with Oracle-supplied documentation.

---

## Data Guard: On-Premises to OD@GC

You can configure Oracle Data Guard between an existing on-premises Oracle Database and OD@GC, enabling a hybrid DR strategy:

\`\`\`sql
-- On-premises primary: add standby log archive destination
ALTER SYSTEM SET log_archive_dest_2 =
  'SERVICE=odgc_standby_tns ASYNC NOAFFIRM
   VALID_FOR=(ONLINE_LOGFILES,PRIMARY_ROLE)
   DB_UNIQUE_NAME=ODGC_STANDBY'
SCOPE=BOTH;

ALTER SYSTEM SET log_archive_dest_state_2 = ENABLE SCOPE=BOTH;

-- Verify transport on primary
SELECT dest_name, status, error FROM v$archive_dest_status
WHERE dest_id = 2;

-- On OD@GC standby: confirm apply
SELECT name, open_mode, database_role, protection_mode
FROM v$database;
\`\`\`

This gives on-premises EBS shops a cloud-based DR standby without moving the primary database, as a first step toward full cloud migration.

---

## Pricing Model

OD@GC is priced in Oracle Cloud compute units (OCPUs) and storage, but **billed through your GCP invoice** — not Oracle Cloud Infrastructure. This means:

- Consolidated billing with other GCP services
- GCP committed use discounts (CUDs) can be applied to OD@GC compute
- Eligible for Google Cloud credits programs
- Oracle software licensing still required (BYOL or Oracle Cloud License Included)

Approximate pricing (X9M, per OCPU-hour, License Included): \$3.50–\$4.50/OCPU-hour depending on shape and commitment term. Compare against running Oracle SE2 on a c3-highmem-88 GCE instance (\$2.80/hr for the VM alone, before Oracle licensing).

---

## When NOT to Use OD@GC

OD@GC is the right choice when:
- You need Exadata performance (Smart Scan for large batch jobs, HCC for DW tables)
- You need Oracle-certified support for EBS, Oracle Clinical, or other Oracle applications
- You need GxP-compliant managed infrastructure with Oracle's SLA

OD@GC is **not** the right choice when:
- Your Oracle Database is small (< 500 GB) and OLTP-only — a GCE VM with Oracle SE2 or Oracle Autonomous Database is more cost-effective
- You are actively migrating away from Oracle to PostgreSQL or a cloud-native database
- You need sub-100ms provisioning — OD@GC Exadata provisioning takes hours, like on-premises Exadata

---

## Summary

Oracle Database@Google Cloud closes the gap that prevented Oracle EBS, Oracle Clinical, and other Oracle applications from migrating to GCP. It is real Exadata hardware inside Google's data centres, connected to GCP's VPC with sub-millisecond latency, billed on your GCP invoice, and managed by Oracle at the infrastructure layer. DBA teams manage the database layer as they always have — same tools, same SQL, same skill set — while gaining native connectivity to BigQuery, Cloud Storage, Vertex AI, and Cloud Monitoring.

The companion runbook covers provisioning, network configuration, Data Guard setup, RMAN to Cloud Storage, and day-2 operations in step-by-step detail.`,
};

async function main() {
  console.log('Inserting Oracle Database@Google Cloud overview blog post...');
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
