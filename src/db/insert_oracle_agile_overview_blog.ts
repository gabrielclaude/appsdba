import { config } from 'dotenv';
config({ path: '.env.local' });
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Agile PLM Implementation Overview: Product Lifecycle Management for Manufacturing and High-Tech',
  slug: 'oracle-agile-plm-implementation-overview',
  excerpt:
    'A comprehensive technical overview of Oracle Agile PLM — covering the full suite of modules (Product Collaboration, PPM, PQM, Engineering Collaboration, PGC), the three-tier architecture, the core data model of items/BOMs/ECOs, integration with Oracle EBS and Oracle Fusion, implementation phases, and the most common challenges that derail Agile PLM deployments.',
  category: 'oracle-agile' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-17'),
  youtubeUrl: null,
  content: `Oracle Agile PLM (Product Lifecycle Management) is Oracle's enterprise platform for managing the complete lifecycle of a product — from the initial concept and engineering design through manufacturing, field support, and eventual retirement. It is the system of record for the product record in manufacturing-intensive industries: high-technology, aerospace and defense, industrial equipment, life sciences and medical devices, consumer packaged goods, and automotive supply chain.

At its core, Agile PLM answers the question every manufacturer needs to answer at any point in time: *What exactly is this product made of, who approved that, and when did it change?* The answers live in Bills of Materials, Engineering Change Orders, supplier part approvals, and compliance declarations — all managed in Agile.

This post provides a thorough technical overview of Oracle Agile PLM for DBAs, architects, and implementation consultants who need to understand the platform before beginning a deployment, integration project, or operational hand-off.

---

## 1. What Is Oracle Agile PLM?

Oracle Agile PLM began its life as Agile Software Corporation's flagship product, acquired by Oracle in 2007. It predates Oracle Fusion and remains a Java EE–based, on-premises (or hosted) application — not a SaaS product. Oracle continues to develop and support it, with Agile 9.3.x on WebLogic/JBoss and Agile 9.4.x bringing updated Java EE stack support.

Agile PLM is used across industries where product complexity, regulatory requirements, or global supply chains demand a structured approach to managing product information:

- **High-technology**: semiconductors, printed circuit board assemblies, consumer electronics. Agile manages BOM structures with hundreds of components, approved vendor lists (AVLs), and frequent ECO-driven changes to accommodate component obsolescence.
- **Life sciences and medical devices**: FDA 21 CFR Part 11 compliance requires electronic records with audit trails. Agile PQM supports the non-conformance, CAPA, and audit management workflows regulators require.
- **Aerospace and defense**: AS9100 quality standards, configuration management, and traceability requirements. Agile EC supports design data management with CAD integration.
- **Consumer goods and industrial**: sustainability and regulatory compliance (RoHS, REACH) require tracking hazardous substances in the product BOM. Agile PGC handles this.

The platform is distinct from an ERP like Oracle EBS. EBS owns the manufacturing execution, financial accounting, and procurement transactions. Agile PLM owns the engineering product definition — what the product is — and the ERP consumes that definition to drive production.

---

## 2. Oracle Agile PLM Suite Components

Oracle Agile PLM is sold and deployed as a suite of modules. Most enterprises deploy Product Collaboration as the foundation; the other modules are add-ons that expand coverage into adjacent domains.

| Module | Full Name | Core Purpose |
|--------|-----------|--------------|
| **PC** | Agile Product Collaboration | Item master, BOM management, ECO workflow, approved manufacturer/vendor lists, document management |
| **PPM** | Agile Product Portfolio Management | Project and program management, resource allocation, gate review processes, innovation pipeline management |
| **PQM** | Agile Product Quality Management | Non-conformance reports (NCR), corrective and preventive action (CAPA), audit management, supplier quality |
| **EC** | Agile Engineering Collaboration | CAD integration (SolidWorks, CATIA, NX, Creo), design data management, 3D visualization, markup and redlining |
| **PGC** | Agile Product Governance and Compliance | RoHS/REACH compliance tracking, substance declarations, regulatory reporting, materials compliance workflows |

### 2.1 Agile Product Collaboration (PC)

PC is the foundation module and the one nearly every Agile deployment begins with. Its core capabilities:

**Item Master**: The item is the central object in Agile. Every part, subassembly, finished good, document, and software deliverable is an item with a unique item number, a lifecycle phase, and a class that determines what attributes it carries and what workflows govern it.

**BOM Management**: Agile manages single-level and multi-level BOMs. Each BOM line (component) carries quantity, reference designators, find number, unit of measure, and effectivity dates. Agile supports alternate BOMs and redline (pending change) BOMs alongside the released BOM.

**ECO Workflow**: The Engineering Change Order is the mechanism through which controlled, auditable changes to the product record are introduced. An ECO carries a set of affected items, the redline BOM changes, a description of the reason for change, and a routing through an approver group structure. Approved ECOs update the released item record.

**Manufacturers Parts List (MPL)**: Also called the Approved Vendor List (AVL) or Approved Manufacturer List (AML). Each item in Agile can have a list of approved manufacturers and their part numbers. This is critical for procurement and for validating component substitutions during component shortages.

**Document Management**: Agile items can be attached with documents — datasheets, test reports, CAD drawings, specifications — stored in the Agile File Manager.

### 2.2 Agile Product Portfolio Management (PPM)

PPM extends Agile into the project management domain. It provides:

- Program and project records linked to Agile items and changes
- Resource allocation and capacity planning
- Gate review workflows (phase-gate product development process)
- Innovation pipeline management: ideation through business case approval through project launch
- Milestone tracking and Gantt-style schedule management

PPM is heavily used in high-tech and life sciences companies that run structured NPD (New Product Development) processes.

### 2.3 Agile Product Quality Management (PQM)

PQM brings quality management workflows into the Agile system:

- **Non-Conformance Reports (NCR)**: capturing quality escapes from manufacturing, incoming inspection, field returns
- **Corrective and Preventive Action (CAPA)**: structured root cause analysis and corrective action planning, with workflow routing through engineering, quality, and management approval
- **Supplier Corrective Action Requests (SCAR)**: extending CAPA to supplier quality issues
- **Audit Management**: internal audit scheduling, checklist management, finding and observation tracking, corrective action linking

In regulated industries (medical devices, pharma), PQM is required to support quality system compliance. The audit trail and electronic signature features support 21 CFR Part 11 requirements.

### 2.4 Agile Engineering Collaboration (EC)

EC is the CAD integration and design data management module:

- Native integrations with SolidWorks, CATIA V5/V6, PTC Creo, Siemens NX, AutoCAD
- CAD connectors allow designers to check CAD files into Agile directly from the CAD tool
- Agile Visualization (formerly Oracle AutoVue): browser-based 2D/3D viewing without requiring the CAD tool installed
- Redlining and markup on drawings directly in the browser
- Design structure (as-designed BOM) management separate from the as-built/as-released BOM in PC

### 2.5 Agile Product Governance and Compliance (PGC)

PGC addresses product regulatory compliance:

- **RoHS (Restriction of Hazardous Substances)**: tracking whether items contain restricted substances (lead, cadmium, mercury, etc.) at or above threshold levels
- **REACH**: tracking substances of very high concern (SVHC) per the EU REACH regulation
- **Conflict Minerals**: tracking use of tin, tantalum, tungsten, gold in supply chain per Dodd-Frank Section 1409
- **Substance declaration workflows**: suppliers submit substance data for their parts; PGC aggregates declarations up the BOM to determine product-level compliance
- Regulatory report generation (full materials declaration, RoHS compliance declaration)

---

## 3. Agile PLM Architecture

Oracle Agile PLM is a classic three-tier Java EE application:

| Tier | Component | Role |
|------|-----------|------|
| **Database Tier** | Oracle Database 19c / 12c | Stores all item, BOM, ECO, quality, and configuration data. The Agile schema (typically owned by a user named AGILE) contains 1,800+ tables in a full PC installation. |
| **Application Tier** | Agile Application Server on Oracle WebLogic or JBoss | Runs the Agile business logic as Java EE EJBs. Exposes the Agile Web Client UI and the Agile SDK/Web Services API. |
| **Client Tier** | Agile Web Client | Browser-based UI (HTML/JavaScript). Runs in modern browsers. The older Agile Java Client (thick client) was deprecated in 9.3.x. |
| **File Manager** | Agile File Manager Server | Dedicated server (or service on the app server) that manages file attachments — CAD files, documents, drawings. File vault stored on local disk, NFS, or SAN. |
| **SDK / API** | Agile SDK, Agile Web Services | Java SDK for custom integrations; SOAP/REST web services for external system connectivity. |

### 3.1 WebLogic Domain Layout

A production Agile deployment on WebLogic typically looks like:

- **AdminServer**: WebLogic domain administration. Heap: 2–4 GB.
- **Agile Managed Server** (one or more): Hosts the Agile EAR application. Heap: 8–16 GB per managed server for production loads.
- **File Manager** (can be a separate JVM): Manages file vault access.
- **Cluster**: In high-availability deployments, two or more managed servers behind an Oracle HTTP Server (OHS) or Apache load balancer.

### 3.2 Oracle Database Configuration

Agile is demanding on the Oracle Database:

- **Character set**: AL32UTF8 is strongly preferred (required if any multilingual item descriptions or supplier names). WE8ISO8859P1 is supported but limits international character support.
- **Block size**: 8192 bytes (8K)
- **init.ora key parameters**: \`open_cursors=1000\`, \`processes=500\` minimum for production, \`undo_retention=7200\` for long-running BOM explosion queries
- **Tablespaces**: Separate tablespaces for data, indexes, and LOBs (Agile stores file attachments as BLOBs in the AGILE_LOB tablespace when file manager uses in-database storage)

### 3.3 Integration Points

Agile PLM is never an island. Standard integration points:

- **Oracle EBS**: item master, BOM, and ECO synchronization (described in Section 5)
- **Oracle Fusion**: Agile to Fusion Product Hub synchronization (Section 6)
- **CAD Tools**: via Agile EC connectors
- **Supplier Portals**: for compliance declarations (PGC)
- **ERP systems** (SAP, others): via Agile SDK or Web Services

---

## 4. Core Data Model

Understanding Agile's data model is essential for anyone configuring or integrating the system.

### 4.1 Items: The Central Object

The **item** is the fundamental record in Agile PLM. An item represents a part, subassembly, finished product, document, software component, or any other object that needs to be managed in the product record.

Every Agile item has a **cover/page structure**:

| Page | Contents |
|------|----------|
| **Cover Page (Title Block)** | Item number, description, lifecycle phase, category/class, revision, unit of measure, create date, creator |
| **Page Two** | BOM (Bill of Materials) — the components that make up this item |
| **Changes Page** | History of all ECOs that have affected this item |
| **Attachments Page** | Files attached to this item (drawings, specs, datasheets) |
| **Manufacturers Page** | Approved manufacturers and their part numbers (MPL/AML) |
| **Quality Page** | NCRs and CAPAs associated with this item |

The pages that appear, and the attributes on each page, are controlled by the item's **class** and the **privilege gates** (role-based access controls on attributes).

### 4.2 Item Classes

Agile uses a hierarchical class system to organize items. The class controls:

- Which attributes appear on each page (user-defined attributes)
- Which lifecycle phases are available
- What numbering scheme is used (manual entry vs. auto-number)
- Which workflows are triggered by lifecycle phase changes

A typical class hierarchy for a high-tech manufacturer:

\`\`\`
Parts (base class)
├── Mechanical Parts
│   ├── Sheet Metal
│   ├── Castings and Forgings
│   └── Plastics and Molded Parts
├── Electronic Parts
│   ├── Active Components
│   ├── Passive Components
│   └── Connectors
├── Software
│   ├── Firmware
│   └── Application Software
└── Documentation
    ├── Engineering Drawings
    └── Test Procedures

Change Orders (base class)
├── Engineering Change Order (ECO)
├── Manufacturing Change Order (MCO)
└── Deviation

Quality Objects (base class)
├── Non-Conformance Report
└── CAPA
\`\`\`

Getting the class hierarchy right early is critical. Reclassifying items after they are in production use is complex and data-intensive.

### 4.3 BOM (Bill of Materials)

The BOM in Agile is a single-level, where-used structure. Key BOM attributes per component line:

- **Item Number**: the child component
- **Quantity**: numeric quantity
- **Unit of Measure**: EA, FT, ML, etc.
- **Reference Designators**: for PCBAs — component placement references (R1, C12, U5)
- **Find Number**: position number in the BOM listing
- **Effectivity Start/End Date**: for date-effective BOMs (manufacturing planning uses these)
- **Alternate BOM**: substitute components approved for use in place of the primary component

Multi-level BOM explosion (full where-used analysis) is a frequent and database-intensive operation. Agile caches BOM explosion results for performance.

### 4.4 ECO (Engineering Change Order)

The ECO is the controlled mechanism for making changes to released items. ECO workflow:

\`\`\`
Draft → Submitted → In Review → Released → Implemented
\`\`\`

Key ECO attributes:
- **Affected Items**: the items whose records will change when the ECO is approved
- **Redlines**: the pending BOM, attribute, or attachment changes on each affected item
- **Approver Groups**: one or more groups whose approval is required to advance the ECO
- **Reason for Change**: the business justification
- **Change Description**: technical description of what is changing
- **Disposition**: how to handle existing inventory affected by the change (use as-is, rework, scrap)

When an ECO reaches Released status, the redlined changes are applied to the affected items, their revision increments, and the change record is locked.

### 4.5 Manufacturers Parts List (MPL)

The MPL associates approved manufacturer/supplier part numbers with Agile items:

- **Manufacturer Name**: the component manufacturer
- **Manufacturer Part Number (MPN)**: the manufacturer's own part number
- **Approval Status**: Approved, Alternate, Preferred, Obsolete
- **Restriction**: RoHS status, compliance flag

The MPL is critical for procurement — the approved list controls which supplier parts can be used to build the product. Changes to the MPL are tracked through ECOs just like BOM changes.

---

## 5. Integration with Oracle EBS

In manufacturing companies running Oracle E-Business Suite, Agile PLM and EBS have complementary but distinct roles:

| System | Owns |
|--------|------|
| **Agile PLM** | Engineering item definition, BOM structure, ECO workflow, approved manufacturers |
| **Oracle EBS** | Manufacturing execution, inventory transactions, purchasing, financial accounting |

The integration synchronizes the product record from Agile (system of record for engineering) into EBS (system of execution for manufacturing).

### 5.1 Item Master Synchronization

Agile items map to EBS inventory items (\`MTL_SYSTEM_ITEMS_B\`). Key field mappings:

| Agile Attribute | EBS Column |
|-----------------|------------|
| Item Number | \`SEGMENT1\` (item number) |
| Description | \`DESCRIPTION\` |
| Unit of Measure | \`PRIMARY_UOM_CODE\` |
| Item Type | \`ITEM_TYPE\` |
| Lifecycle Phase | Maps to \`ITEM_STATUS_CODE\` (Active, Obsolete, etc.) |

Items are loaded via the EBS Item Interface: \`MTL_SYSTEM_ITEMS_INTERFACE\` → Import Items concurrent program.

### 5.2 BOM Synchronization

Agile BOMs map to EBS BOMs (\`BOM_BILL_OF_MATERIALS\`, \`BOM_COMPONENTS_B\`). The synchronization creates or updates the engineering BOM in EBS. EBS manufacturing then uses this BOM for work order material requirements, cost rollup, and production routing.

### 5.3 ECO Synchronization

Agile ECOs can be synchronized to EBS Engineering Change Orders (\`ENG_ENGINEERING_CHANGES\`, \`ENG_REVISED_ITEMS\`). Released Agile ECOs trigger the EBS ECO to implement the BOM change in EBS manufacturing.

### 5.4 Integration Methods

Three integration approaches are used in practice:

**Method 1 — Agile Integration Pack (AIA)**: Oracle provides a pre-built integration pack using Oracle SOA Suite and AIA Foundation Pack. This is the Oracle-recommended approach for enterprises already running Oracle SOA. It provides XSD-based message transformation and error handling.

**Method 2 — Direct REST/Web Services**: Agile 9.3.x and 9.4.x expose web services for item and BOM management. Custom middleware can call these services and map to EBS interface tables.

**Method 3 — Database Link (custom)**: For simpler environments, a scheduled PL/SQL procedure reads from the Agile schema via a database link and writes to EBS interface tables. Less maintainable than AIA but pragmatic for small deployments.

---

## 6. Integration with Oracle Fusion

For companies running or moving to Oracle Fusion Cloud applications, Agile PLM integrates with Oracle Fusion Product Hub (PIM):

- **Agile as system of record for engineering**: Engineering defines items, BOMs, and ECOs in Agile. Fusion Product Hub receives the approved product record.
- **Fusion as system of record for commercial/financial attributes**: Pricing, tax classification, and financial category assignments are managed in Fusion.

The integration uses Oracle's Product Hub Integration Service (PHIS) — a pre-built integration layer that maps Agile item attributes to Fusion Product Hub item structures. Released Agile ECOs trigger item updates flowing to Fusion.

Oracle's innovation roadmap positions Agile PLM as the engineering collaboration layer feeding into Fusion's supply chain planning and manufacturing modules (Fusion Manufacturing Cloud, Fusion SCM). For new deployments evaluating whether to extend Agile or move to a Fusion-native PLM solution, Oracle's Fusion Innovation Management and Fusion Product Lifecycle Management are positioned as the strategic direction.

---

## 7. Implementation Sequence

A well-structured Oracle Agile PLM implementation proceeds in seven phases. Skipping phases or running them in the wrong order is the most common cause of project overruns.

### Phase 1: Infrastructure

- Oracle Database 19c installation, parameter configuration, tablespace creation, and Agile schema user provisioning
- Oracle WebLogic installation, domain creation, JVM heap tuning
- File Manager server setup and file vault storage provisioning (NFS or SAN)
- Network configuration: load balancer for HA deployments, firewall rules for CAD tool connectivity

### Phase 2: Foundation Data Configuration

- **Class hierarchy design**: define the item class structure before any data is loaded. This decision is the most consequential configuration choice in the implementation.
- **User-Defined Attributes (UDA)**: create custom attributes for each class (Title Block attributes for engineering data, Page Two attributes for manufacturing data)
- **Privilege Gates**: define which user roles can read/modify which attributes at each lifecycle phase
- **List Values**: configure lifecycle phases, unit of measure codes, approval statuses, and all other enumerated attribute values
- **Auto-numbering**: configure item number sequences per class (e.g., P-prefix for parts, D-prefix for documents, ECO-prefix for change orders)

### Phase 3: Item and BOM Migration

- Extract item master and BOM data from legacy PDM (Windchill, Teamcenter, Enovia) or ERP
- Data cleansing: validate item numbers, descriptions, reference designators, UOM codes
- Transform to Agile import format (Agile supports bulk import via import templates or SDK)
- Load items in class dependency order (parent classes before child classes)
- Load BOMs after all component items are loaded (referential integrity in BOM structure)
- Load manufacturer parts lists
- Validate: sample BOM explosions, check where-used results for key items

### Phase 4: ECO Workflow Configuration

- Configure approver groups: Engineering Review Board, Manufacturing Engineering, Quality, Procurement
- Define routing logic: parallel vs. sequential approval, auto-advance rules
- Configure escalation: notify manager after N days without approval action
- Set up notification templates (Agile uses Velocity templates for email notifications)
- Test the complete ECO lifecycle: Draft → Submit → Approve (all groups) → Release → Verify item revision increments

### Phase 5: EBS/Fusion Integration Activation

- Establish connectivity (DB link, AIA SOA deployment, or REST endpoint configuration)
- Configure item mapping rules (Agile attribute → EBS column mappings)
- Test item synchronization: create test item in Agile, verify it appears in EBS \`MTL_SYSTEM_ITEMS_B\` after sync
- Test BOM synchronization: create test BOM, verify EBS BOM tables populated
- Test ECO synchronization: release ECO, verify EBS engineering change created
- Activate scheduled sync jobs; configure error alerting

### Phase 6: CAD Integration (Optional)

- Install Agile EC module and connectors for the CAD tools in use (SolidWorks, CATIA, NX, Creo)
- Configure CAD workstations with Agile EC client
- Set up design data vaulting: CAD files checked in to Agile from the design tool
- Configure visualization (AutoVue) for browser-based 3D viewing
- Test check-in/check-out, redlining, and approval workflows

### Phase 7: Quality Module (PQM)

- Configure NCR and CAPA workflows: approval routing, escalation, closure requirements
- Set up supplier SCAR workflow for supplier quality issues
- Configure audit management: audit types, checklist templates, finding categories
- Train quality team on NCR/CAPA entry, review, and closure procedures

---

## 8. Common Implementation Challenges

### 8.1 Item Class Hierarchy Design

The class hierarchy is the most consequential architectural decision in an Agile PLM implementation. Getting it wrong is expensive to fix after go-live:

- **Too flat**: a single "Parts" class with all attributes creates a cluttered, hard-to-use interface where every user sees every attribute regardless of relevance.
- **Too deep**: excessive class nesting creates administrative complexity and makes privilege gate configuration unmanageable.
- **Wrong classification criteria**: using manufacturing origin (domestic vs. import) rather than engineering function as the classification criterion leads to reclassification churn as products change suppliers.

The right approach: classify by engineering type (mechanical, electronic, software, documentation) at the first level, then by function at the second level. Keep the hierarchy to three levels maximum for most implementations.

### 8.2 Data Migration Quality

Legacy PDM and ERP systems accumulate decades of data quality debt. Common problems discovered during Agile migration:

- **Missing reference designators**: PCBA BOMs from legacy systems frequently have reference designators missing or inconsistently formatted. Agile enforces referential integrity between reference designator count and component quantity.
- **Orphaned BOM lines**: components referencing item numbers that don't exist in the item master (deleted parts still referenced in BOMs)
- **Duplicate item numbers**: different items with the same number in different locations of the legacy system
- **Inconsistent UOM**: items with unit of measure codes not mapped to Agile's UOM list

Mitigation: run data quality validation scripts against legacy data *before* the migration project begins. Fix data quality issues at the source, not during migration.

### 8.3 ECO Workflow Complexity

Organizations new to formal ECO workflows often over-engineer their initial approval routing:

- Too many approver groups (8–10 groups for every ECO) creates approval bottlenecks and user frustration
- No escalation rules means ECOs sit in-review indefinitely when an approver is on vacation
- Requiring all groups for minor changes (typo corrections, document updates) slows the change process for low-risk changes

Best practice: design change type-specific routing. High-impact changes (BOM structure changes affecting manufacturing) route through the full approver chain. Low-impact changes (description corrections, attachment updates) route through a simplified two-group approval.

### 8.4 File Manager Disk Sizing

Agile file attachments — CAD files, drawings, PDFs, test reports — grow rapidly and are difficult to move once the system is live. Undersizing the file vault is a frequent operational problem:

- A mid-size manufacturer with 50,000 parts and 3 years of CAD history can accumulate 500 GB–2 TB in the file vault
- CAD files (CATIA, NX assemblies) can be 50–200 MB each
- Each ECO revision creates new file versions

Size the file vault for 5x the initial import size, with a growth plan for 3 years at projected ECO volume.

### 8.5 BOM Explosion Performance

Multi-level BOM explosion (used for cost rollup, where-used analysis, compliance roll-up in PGC) is database-intensive. Products with 500–2,000 components in a multi-level structure can take 30–120 seconds for full explosion without proper database configuration:

- Ensure \`AGILE.BOM_STRUCTURE\` table has composite indexes on \`(PARENT_ID, CHILD_ID, EFFECTIVITY_DATE)\`
- Gather fresh statistics on the AGILE schema regularly: \`DBMS_STATS.GATHER_SCHEMA_STATS('AGILE', CASCADE => TRUE)\`
- Enable Agile's BOM caching for static released BOMs
- Size the SGA Result Cache for frequently accessed BOM structures

---

## 9. Summary

Oracle Agile PLM is a mature, purpose-built platform for managing the engineering product record in complex manufacturing environments. Its strength lies in structured BOM and ECO management with full audit trails, approved manufacturer list management, and deep integration with Oracle ERP. Its complexity lies in initial configuration — the class hierarchy, privilege gates, and workflow routing decisions made in the first 90 days of an implementation shape the usability and maintainability of the system for years.

### Key Success Factors

| Factor | What It Means in Practice |
|--------|---------------------------|
| **Class hierarchy design** | Engage business stakeholders early; finalize the class structure before data migration begins |
| **Data quality first** | Clean legacy data at the source; do not carry dirty data into Agile |
| **ECO workflow simplicity** | Start with simple routing; add complexity only when the business process demands it |
| **File vault sizing** | Size for 5x initial import; plan growth for 3 years; put file vault on monitored storage |
| **BOM performance** | Configure indexes, statistics, and result cache before user acceptance testing |
| **Integration testing** | Test the Agile-EBS or Agile-Fusion integration with real data, not just test items, before go-live |
| **Training investment** | Agile's cover/page/class mental model is unfamiliar; allocate training time for engineers, quality staff, and procurement |

The companion runbook for Oracle Agile PLM covers the database setup, WebLogic configuration, schema installation, class and workflow configuration, EBS integration, performance tuning, and the go-live validation matrix that every Agile DBA and implementation team needs.
`,
};

async function main() {
  console.log('Inserting Oracle Agile PLM overview blog post...');
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
