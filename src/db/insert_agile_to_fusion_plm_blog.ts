import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Upgrading from Oracle Agile PLM to Oracle Fusion Cloud PLM: Migration Architecture and Key Decisions',
  slug: 'oracle-agile-plm-to-fusion-cloud-plm-migration',
  excerpt:
    'A technical guide to migrating from Oracle Agile PLM (on-premises) to Oracle Fusion Cloud Product Lifecycle Management — covering architecture differences, data migration strategy, integration rewiring, and what the DBA and functional team each own during the transition.',
  category: 'fusion-cloud-erp' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-20'),
  youtubeUrl: null,
  content: `Oracle Agile PLM has been the enterprise standard for product lifecycle management in manufacturing, electronics, and life sciences for over two decades. It manages the bill of materials, engineering change orders, quality records, and supplier collaboration workflows that engineering and supply chain teams depend on daily. But Agile PLM runs on-premises on an Oracle Database backend, and Oracle's investment in the on-premises product has shifted sharply toward Fusion Cloud PLM — the cloud-native successor built on the same SaaS platform as Oracle Fusion Cloud ERP.

Migrating from Agile to Fusion Cloud PLM is not a like-for-like upgrade. The two products share a product domain but differ in data model, extensibility model, integration approach, and operational ownership. This post maps the architecture of both systems, identifies the data migration strategy, and outlines what changes for DBAs, functional admins, and integration teams during the transition.

---

## What Each System Owns

### Oracle Agile PLM (On-Premises)

Agile PLM is a Java EE application deployed on Oracle Application Server or WebLogic, with all persistent data stored in a single Oracle Database schema — typically owned by the \`AGILE\` or \`AGS\` user. The schema is highly normalised and product-class driven: every product object type (Part, Document, Change Order, Manufacturer Part, Supplier) maps to a class hierarchy in the Agile data model.

Key Agile PLM modules relevant to migration:

| Module | What it manages |
|--------|----------------|
| Product Collaboration (PC) | Part master, BOM, AML (Approved Manufacturer List) |
| Product Quality Management (PQM) | NCRs, CAPAs, audit records, deviations |
| Product Governance & Compliance (PG&C) | RoHS, REACH, material declarations |
| Product Cost Management (PCM) | Cost rollups by BOM level |
| Supplier Management | Supplier qualification, scorecards |
| Engineering Change Management | ECOs, MCOs, SCOs, change workflows |

### Oracle Fusion Cloud PLM

Fusion Cloud PLM (also called Product Hub, Innovation Management, and Product Development in the Fusion applications menu) is a multi-tenant SaaS application. It does not expose the underlying database. All data access is through the Fusion REST API, SOAP services, OTBI reports, or Oracle Integration Cloud (OIC) pipelines. The persistent layer is Oracle's managed cloud infrastructure.

Fusion Cloud PLM core capabilities:

| Capability | Fusion Cloud PLM equivalent |
|-----------|----------------------------|
| Item Master | Product Hub — Item and Trading Partner Item |
| BOM | Product Development — Structure Management |
| Change Orders | Product Development — Change Management |
| AML | Product Hub — Approved Supplier List |
| Quality | Quality Management Cloud (separate module) |
| Compliance | Product Hub — Item Specifications and Attachments |
| Supplier Management | Supplier Qualification Management Cloud |

---

## Architecture Comparison

\`\`\`
Oracle Agile PLM (On-Premises)             Oracle Fusion Cloud PLM (SaaS)
─────────────────────────────              ──────────────────────────────
WebLogic / OAS Application Server          Oracle Cloud Infrastructure (OCI)
         │                                           │
   Agile PLM WAR                           Fusion application pods
         │                                           │
  Oracle Database (AGILE schema)           Managed Oracle DB (no DBA access)
         │                                           │
  File Server (attachments/vaults)         Oracle Content Management (OCM)
         │                                           │
  Custom SDK extensions (Java)             Sandboxes + Application Composer
         │                                           │
  Point-to-point integrations              Oracle Integration Cloud (OIC)
  (EBS via Agile-EBS adapter,             (pre-built adapters for ERP Cloud,
   custom SOAP, flat-file interfaces)       Mfg Cloud, Supply Chain Cloud)
\`\`\`

The most consequential architectural shift is ownership: in Agile PLM, the DBA controls the database, manages the schema, applies patches, and can write SQL against any table. In Fusion Cloud PLM, Oracle manages the infrastructure entirely. The DBA role transitions from database administration to integration platform administration (OIC) and data governance.

---

## Data Model Differences

### Item / Part Master

Agile PLM stores parts in the \`AGILE_PARTS\` table family with class-based extensibility. Custom attributes are added as class property extensions. A part in Agile has:
- A numeric part number (internal ID) and a user-defined part number string
- A lifecycle phase (Preliminary, Production, Phaseout, Obsolete)
- Class membership (component, assembly, document, software)
- Multi-revision history stored as separate revision records

Fusion Cloud PLM stores items in the Item Master in Oracle's Fusion schema. The key structural differences:

| Dimension | Agile PLM | Fusion Cloud PLM |
|-----------|-----------|-----------------|
| Item identifier | Part number (alphanumeric) | Item number + Inventory Organization |
| Lifecycle status | Agile lifecycle phase | Fusion item status (Active, Inactive, Pending, etc.) |
| Custom attributes | Class property extensions | Item attributes in extensible flexfields (EFF) |
| Revision control | Revision object in Agile | Item revision in Fusion (for revisions-controlled items) |
| BOM attachment | Agile BOM tab on Part | Structure in Product Development |
| AML attachment | Manufacturers tab on Part | Approved Supplier List in Product Hub |

### Bill of Materials

Agile BOM is stored as a parent-child part relationship with per-component attributes (quantity, UOM, reference designators, substitutes, effectivity dates). Fusion Cloud PLM structures serve the same function but are stored within the Product Development module and tied to the Inventory organization context — meaning every structure is valid within a specific manufacturing organization.

This is a critical migration decision point: Agile BOMs are organization-independent by default. Fusion structures are organization-specific. If the migrating organization uses a single global BOM model, one Fusion structure per item is straightforward. If it uses multi-site BOMs with site-specific overrides, the target structure model must be designed before migration begins.

### Engineering Change Orders

Agile ECOs are objects with a header (description, type, workflow routing), affected items (parts in the ECO scope), and redlines (before/after attribute values). Fusion Cloud PLM change orders follow the same conceptual model — Header, Affected Objects, Lines — but the workflow engine is Fusion Approvals Management Engine (AME) rather than Agile's proprietary workflow.

Change order migration is typically scoped to open or recently closed ECOs. Historical closed ECOs are usually archived rather than migrated to keep the target system clean.

---

## Data Migration Strategy

### What to Migrate vs. What to Archive

Not everything in Agile PLM should move to Fusion Cloud PLM. A typical scoping decision:

| Data type | Recommended approach |
|-----------|---------------------|
| Active production parts (lifecycle = Production) | Migrate to Fusion item master |
| Phaseout and Obsolete parts | Migrate as Inactive items or archive only |
| Active BOM structures | Migrate with effectivity dates |
| Superseded BOM revisions | Archive in Agile; migrate current revision only |
| Open ECOs | Migrate with status mapping |
| Closed ECOs (last 2 years) | Migrate as reference data |
| Closed ECOs (older) | Archive in Agile read-only instance |
| AML (Approved Manufacturer List) | Migrate active entries |
| NCRs and CAPAs | Migrate open items; archive closed |
| Attachments | Migrate attachments for active items; archive the rest |

### Migration Tool Options

Oracle provides File-Based Data Import (FBDI) as the primary bulk load mechanism for Fusion Cloud PLM. FBDI uses Excel or CSV templates that map to the Fusion item and structure import APIs.

For high-volume migrations, Oracle Integration Cloud (OIC) offers a structured pipeline approach:

\`\`\`
Agile DB (SQL extract)
       │
   Staging tables (intermediate schema)
       │
   Transform (Python / OIC mapper)
       │  ── field mapping, value set translation, validation
       │
   FBDI CSV files
       │
   Oracle UCM (Content Manager) upload
       │
   Fusion Import Job (scheduled via Scheduled Processes)
       │
   Fusion Item Master / Product Hub
\`\`\`

### Extracting from Agile

Data extraction from Agile PLM uses direct SQL against the Agile Oracle Database schema. Key tables for part master extraction:

\`\`\`sql
-- Active parts with lifecycle phase
SELECT
    p.part_number,
    p.description,
    p.lifecycle_phase,
    p.class_id,
    p.rev,
    p.unit_of_measure,
    p.creation_date,
    p.last_update_date
FROM   agile_parts p
WHERE  p.lifecycle_phase IN ('PRODUCTION', 'PRELIMINARY')
  AND  p.delete_flag = 'N'
ORDER  BY p.part_number;

-- BOM structures (single-level parent-child)
SELECT
    b.parent_part_number,
    b.child_part_number,
    b.quantity,
    b.uom,
    b.find_number,
    b.reference_designator,
    b.effective_date,
    b.obsolete_date,
    b.notes
FROM   agile_bom b
JOIN   agile_parts p ON p.part_number = b.parent_part_number
WHERE  p.lifecycle_phase = 'PRODUCTION'
  AND  b.obsolete_date IS NULL
ORDER  BY b.parent_part_number, b.find_number;

-- AML (Approved Manufacturer List entries)
SELECT
    a.part_number,
    a.manufacturer_name,
    a.manufacturer_part_number,
    a.approved_status,
    a.approved_date
FROM   agile_aml a
JOIN   agile_parts p ON p.part_number = a.part_number
WHERE  p.lifecycle_phase = 'PRODUCTION'
  AND  a.approved_status = 'APPROVED'
ORDER  BY a.part_number, a.manufacturer_name;
\`\`\`

Note: actual Agile table names vary by version and customisation. The above illustrates the extraction pattern; the DBA should query \`ALL_TABLES\` with owner = 'AGILE' (or the actual schema owner) to enumerate the exact table names in their instance.

---

## Integration Rewiring

### Agile-to-EBS Integration (Decommission)

Most Oracle Agile installations have a live integration to Oracle EBS that synchronises approved parts from Agile into the EBS item master, and routes ECO approvals through EBS workflow. This integration — typically implemented via the Agile EBS Adapter or a custom Oracle Data Integrator (ODI) pipeline — must be decommissioned as part of the Fusion Cloud PLM migration.

The replacement is the Fusion Cloud ERP native integration between Product Hub and Manufacturing/Inventory, which is a configured connection rather than a custom integration. If the target ERP is already Fusion Cloud ERP, this integration is pre-built and activated by configuration. If EBS remains in place during a phased rollout, an OIC integration between Fusion Cloud PLM and EBS must be built to replace the Agile-EBS adapter.

### Supplier Collaboration Portal

Agile PLM's Supplier Collaboration module (if used) is replaced by Supplier Portal in Fusion Cloud Procurement. Data migration covers active supplier contact records and pending supplier qualification workflows.

### CAD Integration

Agile PLM integrates with CAD tools (Creo, SolidWorks, CATIA) via the Agile CAD Connector. The Fusion Cloud PLM equivalent integration is the Product Development CAD connector for the same tools. CAD connector migration is a separate workstream that typically runs in parallel with the data migration.

---

## What Changes for Each Team

### DBA / Infrastructure Team

| Before (Agile PLM) | After (Fusion Cloud PLM) |
|--------------------|-------------------------|
| Manage Oracle DB schema, indexes, tablespaces | No database access — Oracle manages infra |
| Apply Agile patches via OPatch / Agile patch tool | Oracle applies Fusion patches quarterly |
| Monitor AWR, ASH for performance problems | Monitor OIC integration pipelines and Fusion Scheduled Process logs |
| Manage WebLogic domain (JVM, thread pools, datasources) | Manage OIC instances and Oracle Content Management |
| Write SQL reports against Agile tables | Build OTBI reports and BI Publisher layouts |
| Manage Agile file vault / attachment storage | Manage Oracle Content Management (OCM) storage policies |

### Functional / Configuration Team

| Before (Agile PLM) | After (Fusion Cloud PLM) |
|--------------------|-------------------------|
| Configure item classes via Agile Admin | Configure item classes in Product Hub Setup |
| Build workflow routes in Agile workflow editor | Configure approval rules in AME (Approval Management Engine) |
| Write SDK extensions (Java) | Use Application Composer (Groovy) in Sandbox |
| Manage flexfield extensions in Agile classes | Configure extensible flexfields (EFF) in Fusion |
| Run Agile reports (standard + Crystal Reports) | OTBI analyses, BI Publisher reports, Fusion transactional reports |

---

## Common Migration Failures

| Failure | Root cause | Resolution |
|---------|-----------|------------|
| FBDI item import rejects on Unit of Measure | Agile UOM codes do not match Fusion UOM lookup values | Map Agile UOMs to Fusion UOM codes in transformation step; seed missing UOMs first |
| BOM import fails: parent item not found | Items import and BOM import ran in wrong order | Always import item master before BOM structures |
| Duplicate part numbers in Fusion | Agile has variant part numbers that map to the same Fusion item number format | Cleanse part number format before migration; decide on canonical form |
| Custom attributes missing after import | Agile class extensions were not mapped to Fusion EFF segments | Extend Fusion EFF to hold equivalent attributes; include in FBDI template |
| ECO workflow stalls at approval | Agile workflow roles do not map to Fusion AME approval group members | Rebuild approval groups in AME before migrating open ECOs |
| Attachments inaccessible after migration | UCM upload succeeded but item attachment reference not created | Validate attachment import step separately from item import |
| AML entries rejected | Manufacturer not yet seeded in Fusion Trading Partner registry | Seed manufacturers as Trading Partners before loading AML |`,
};

async function main() {
  await db
    .insert(posts)
    .values(post)
    .onConflictDoUpdate({
      target: posts.slug,
      set: { title: post.title, content: post.content, excerpt: post.excerpt, updatedAt: new Date() },
    });
  console.log('Inserted:', post.slug);
}

main().catch(console.error);
