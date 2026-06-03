import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Essbase: Core Concepts and Deployment Topology',
  slug: 'essbase-concepts-topology',
  excerpt:
    'A comprehensive introduction to Oracle Essbase — the multidimensional database engine at the heart of Oracle EPM. Covers BSO vs ASO cube types, dimensions and hierarchies, dense and sparse classification, the block storage engine, aggregate storage internals, deployment topology options, and integration with Hyperion Planning, OBIEE, and Smart View.',
  category: 'essbase' as const,
  published: true,
  publishedAt: new Date('2026-06-02'),
  isPremium: false,
  youtubeUrl: null,
  content: `Oracle Essbase (Extended Spread Sheet dataBASE) is a multidimensional analytic database engine designed for financial reporting, planning, budgeting, and OLAP analysis. It stores data in cubes — multidimensional structures organised around business dimensions — rather than in relational tables. This design makes certain classes of queries (slice-and-dice, drilldown, aggregation across hierarchies) orders of magnitude faster than a relational approach at the cost of flexibility in ad hoc querying.

Essbase is the data engine underlying several Oracle EPM (Enterprise Performance Management) products: Hyperion Planning, Hyperion Financial Management (HFM), Hyperion Profitability and Cost Management (HPCM), and Oracle PBCS/EPBCS in the cloud.

---

## The Multidimensional Data Model

### Dimensions and Members

Every piece of data in Essbase lives at the intersection of a set of **members**, one from each **dimension**. A financial planning cube might have:

- **Year** — FY2024, FY2025, Q1, Q2, Jan, Feb, …
- **Scenario** — Actual, Budget, Forecast
- **Version** — Working, Final
- **Entity** — a hierarchy of legal entities or cost centres
- **Account** — a chart of accounts hierarchy (Revenue, Expenses, Net Income, …)
- **Product** — a product hierarchy

A data cell is the value stored at a specific combination of members:
\`\`\`
[Jan] [Actual] [Final] [US-West] [Gross Revenue] [Software] = 4,250,000
\`\`\`

### Hierarchies

Dimensions are hierarchical. The **Account** dimension might look like:

\`\`\`
Net Income
  Revenue
    Gross Revenue
      Product Revenue
      Service Revenue
    Deductions
  Expenses
    COGS
    OpEx
      Salaries
      Marketing
\`\`\`

Parent members consolidate their children using a **consolidation operator** (+, -, ~, *, /, ^). In the example above, Net Income = Revenue - Expenses. Essbase calculates and stores these aggregations automatically.

### Data Blocks

Essbase does not store one value per cell. Instead it organises data into **blocks** — fixed-size arrays that correspond to one combination of **sparse** dimension members and contain a complete array of values for all **dense** dimension intersections.

This distinction between dense and sparse is the most important design decision in BSO cube development.

---

## BSO vs ASO: Choosing the Right Storage Engine

Essbase offers two fundamentally different storage engines. Choosing the wrong one for a use case degrades both load performance and query performance.

### Block Storage Option (BSO)

BSO is the original Essbase engine. Data is physically organised into blocks indexed by sparse dimension combinations. Within each block, dense dimension values are stored as a contiguous array.

**BSO characteristics:**
- Supports **two-pass calculations** and complex Essbase calculation scripts
- Supports **write-back** — users can enter data directly into cells (used heavily in Hyperion Planning)
- Calculation must be triggered explicitly (dense dimension aggregations can be set to calculate on demand; sparse aggregations require a calc script or a \`CALC ALL\`)
- Performance depends heavily on the block size and the ratio of populated to allocated data blocks (sparsity ratio)
- Optimal for cubes where users write data, run complex allocations, and need calculation control

**When to use BSO:**
- Hyperion Planning applications (write-back is mandatory)
- Financial consolidation with complex elimination and translation logic
- Cubes with fewer than ~100 million populated cells
- Applications requiring custom calculation scripts (XREF, ALLOCATE, member formulas)

### Aggregate Storage Option (ASO)

ASO is a read-optimised engine designed for very large, read-heavy cubes. It stores data in a compressed columnar format and computes aggregations dynamically at query time rather than pre-calculating and storing parent values.

**ASO characteristics:**
- No block structure — data is stored as a sparse set of input-level values
- Aggregations are computed on the fly from input data; the engine can optionally materialise aggregation **views** for frequently used aggregation paths
- Write-back is limited (supported in recent releases but with restrictions vs BSO)
- Load performance is significantly faster than BSO for large datasets
- Query performance is excellent for aggregation queries across large hierarchies without pre-calculation
- Cannot use the full BSO calculation scripting language

**When to use ASO:**
- Reporting cubes fed from a data warehouse (GL actuals, headcount, spend analytics)
- Very large cubes (hundreds of millions to billions of cells)
- Cubes where users query but rarely write back
- Oracle PBCS/EPBCS reporting and analytics layers

---

## Dense and Sparse Dimension Classification (BSO)

This is the most impactful tuning decision for a BSO cube. Getting it wrong causes large blocks, excessive memory usage, and slow calculation.

### Dense dimensions

A dimension is **dense** when most combinations of its members with other dense members contain data. Dense dimensions are represented as axes inside each block. Every block contains a slot for every intersection of all dense member combinations — the array is pre-allocated whether or not it contains data.

**Typical dense dimensions:** Account, Period/Month, Scenario, Version

Example: if Account has 500 members and Period has 12 members, and both are dense, each block contains 6,000 (500 × 12) data slots.

### Sparse dimensions

A dimension is **sparse** when most combinations of its members with others do not contain data. Sparse dimensions form the block index. Essbase only creates a block when at least one data value exists for that combination of sparse members.

**Typical sparse dimensions:** Entity, Product, Customer, Employee, Project

### Block size formula

\`\`\`
Block size (bytes) = (Product of all dense member counts) × 8
\`\`\`

**Target block size: 8 KB – 100 KB.** Blocks smaller than 4 KB waste I/O (too many small reads). Blocks larger than 200 KB waste memory and slow calculation.

If Account (500) × Period (12) × Scenario (5) are all dense:
\`\`\`
Block size = 500 × 12 × 5 × 8 = 240,000 bytes (240 KB) — too large
\`\`\`
Move Scenario to sparse to reduce to 48 KB.

### Checking current block size

\`\`\`
/* In Essbase Administration Services (EAS) or MaxL: */
query database EBSPlanning.PlanType1 get statistics;

/* Look for:
   Block size (B): 49152
   Number of existing blocks: 1,842,000
   Block density (%): 12.5
*/
\`\`\`

---

## Essbase Deployment Topology

### Standalone (Development / Small Production)

\`\`\`
┌─────────────────────────────────────────┐
│           Application Server            │
│                                         │
│  ┌──────────────┐  ┌──────────────────┐ │
│  │ Essbase       │  │  EAS (Admin UI)  │ │
│  │ Server        │  │                  │ │
│  │ (ESSBASE.exe) │  │  Port: 7777      │ │
│  │ Port: 1423    │  └──────────────────┘ │
│  └──────────────┘                       │
│                                         │
│  ┌──────────────────────────────────┐   │
│  │   Oracle HTTP Server / OHS       │   │
│  │   Port: 80 / 443                 │   │
│  └──────────────────────────────────┘   │
└─────────────────────────────────────────┘
         │                  │
    Smart View          Web Browser
    (Excel Add-in)     (Workspace / EAS)
\`\`\`

Used for development and proof-of-concept. All components on one host. Not suitable for production — no high availability and resource contention between Essbase Server and EAS.

### EPM Suite Topology (On-Premises Production)

A full Oracle EPM deployment separates the web tier, application tier, and data tier across dedicated servers. The typical components are:

\`\`\`
                     ┌─────────────────┐
     Users ────────▶ │  Load Balancer  │ ◀─── Smart View (Excel)
                     └────────┬────────┘
                              │
            ┌─────────────────┼─────────────────┐
            │                 │                 │
   ┌────────▼────────┐ ┌──────▼──────┐ ┌───────▼────────┐
   │   Web Tier      │ │  Web Tier   │ │   Web Tier     │
   │   Node 1        │ │  Node 2     │ │   Node 3       │
   │  Oracle HTTP    │ │ Oracle HTTP │ │  Oracle HTTP   │
   │  Server (OHS)   │ │ Server      │ │  Server        │
   └────────┬────────┘ └──────┬──────┘ └───────┬────────┘
            └─────────────────┼─────────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            │                                   │
   ┌────────▼────────┐             ┌────────────▼────────┐
   │  App Tier       │             │  App Tier           │
   │  Node 1         │             │  Node 2 (Failover)  │
   │                 │             │                     │
   │  Essbase Server │             │  Essbase Server     │
   │  Hyperion       │             │  Hyperion           │
   │   Planning App  │             │   Planning App      │
   │  EAS            │             │  EAS                │
   │  Workspace      │             │  Workspace          │
   │  EPMA           │             │  EPMA               │
   └────────┬────────┘             └────────────┬────────┘
            └─────────────────┬─────────────────┘
                              │
                   ┌──────────▼──────────┐
                   │   Database Tier     │
                   │                    │
                   │  Oracle Database   │
                   │  (Hyperion repos,  │
                   │   Planning app DB, │
                   │   EPMA metadata)   │
                   └─────────────────────┘
\`\`\`

**Key components in this topology:**

| Component | Role | Default Port |
|---|---|---|
| Oracle HTTP Server (OHS) | Reverse proxy and SSL termination for all EPM web applications | 80 / 443 |
| Essbase Server | Hosts and manages Essbase cubes; processes MDX and Essbase queries | 1423 |
| Essbase Administration Services (EAS) | Java web app for cube administration, outline editing, calc scripts, data loads | 7777 |
| Hyperion Workspace | Unified web portal for accessing Hyperion reports, Planning forms, Smart View web | 19000 |
| Hyperion Planning | Financial planning application — stores Planning metadata in Oracle DB; cube data in Essbase | 8300 |
| EPMA (Enterprise Performance Management Architect) | Dimension management — synchronises dimensions across Planning, HFM, Essbase | 5250 |
| Oracle Database | Relational repository for all EPM product metadata, Planning app data, security | 1521 |

### Essbase Cluster (Essbase 21c / EPBCS Cloud)

Modern on-premises Essbase 21c and the cloud PBCS/EPBCS service use a containerised, clustered topology with Kubernetes-style orchestration:

\`\`\`
┌─────────────────────────────────────────────────────┐
│               Essbase 21c Cluster                   │
│                                                     │
│  ┌───────────────┐      ┌───────────────────────┐  │
│  │  Essbase UI   │      │  Essbase Agent        │  │
│  │  (Web Console)│      │  (Cluster Coordinator)│  │
│  │  Port: 9000   │      │  Port: 1423           │  │
│  └───────────────┘      └──────────┬────────────┘  │
│                                    │               │
│           ┌────────────────────────┤               │
│           │                        │               │
│  ┌────────▼──────┐      ┌──────────▼────────┐     │
│  │  Essbase Node │      │  Essbase Node 2   │     │
│  │  1            │      │  (Active Standby) │     │
│  └───────────────┘      └───────────────────┘     │
│                                                     │
│  ┌────────────────────────────────────────────┐    │
│  │  Shared Storage (NFS / Block)              │    │
│  │  Cube data, outlines, calc scripts         │    │
│  └────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
              │
    ┌─────────▼─────────┐
    │  Oracle Database  │
    │  (Essbase 21c     │
    │   metadata repo)  │
    └───────────────────┘
\`\`\`

---

## Essbase Application and Database Structure

Essbase organises data in a two-level hierarchy:

**Application** — a container that holds one or more related databases (cubes). An application shares a single process space and configuration. For example, a \`BudgetPlanning\` application might contain cubes named \`Workforce\`, \`CapEx\`, and \`Revenue\`.

**Database (Cube)** — a single multidimensional database with its own outline, data, and security. Each database is independently loadable, calculable, and lockable.

\`\`\`
Essbase Server
  ├── Application: BudgetPlanning
  │     ├── Database: Workforce      (BSO)
  │     ├── Database: CapEx          (BSO)
  │     └── Database: Revenue        (BSO)
  ├── Application: GLReporting
  │     └── Database: Actuals        (ASO)
  └── Application: SampleBasic
        └── Database: Basic          (BSO, ships with Essbase)
\`\`\`

### Key database files

| File | Extension | Contents |
|---|---|---|
| Outline | \`.otl\` | Dimension structure, member properties, consolidation operators, UDAs, member formulas |
| Data files | \`.pag\` (BSO) / \`.ess\` (ASO) | Block data storage |
| Index files | \`.ind\` | Sparse block index |
| Calc scripts | \`.csc\` | Stored calculation scripts |
| Rules files | \`.rul\` | Data load and dimension build rules |
| Substitution variables | server-level | Named variables used in calc scripts and reports |

---

## Data Load and Dimension Build

Essbase loads data and dimensions through **rules files** — transformation mappings that tell Essbase how to map source columns to dimensions and members.

### Data load flow

\`\`\`
Source (flat file, SQL, Hyperion Planning interface)
  │
  ▼
Rules File (column mapping, header skip, token replacement)
  │
  ▼
Essbase Load Buffer (held in memory)
  │
  ▼
Essbase Database (blocks created or updated)
\`\`\`

### MaxL data load (scripted)

\`\`\`bash
# Load data from a flat file using a rules file
essmsh << 'EOF'
login admin password on localhost;
import database BudgetPlanning.Revenue data
  from local_file '/data/revenue_actuals.csv'
  using local_file '/essbase/rules/rev_load.rul'
  on error write to '/logs/revenue_load_errors.txt';
logout;
EOF
\`\`\`

### Dimension build from relational source

\`\`\`bash
essmsh << 'EOF'
login admin password on localhost;
import database BudgetPlanning.Revenue dimensions
  from data_source
    using server rules_file 'dim_build_account'
    on error write to '/logs/dim_build_errors.txt';
logout;
EOF
\`\`\`

---

## Security Model

Essbase security works at three levels:

**Application-level access** — users are granted access to an application as \`None\`, \`Read\`, \`Write\`, \`Database Manager\`, or \`Application Manager\`.

**Database-level filters** — Essbase filters restrict access to specific dimension member combinations within a cube. A filter can grant \`Read\`, \`Write\`, or \`MetaRead\` (see member names but not data) on any intersection.

**Shared Services / Native Directory** — Oracle Shared Services (part of EPM) provides centralised user and group management and provisions Essbase security alongside Planning, HFM, and other EPM products. In Essbase 21c, the built-in identity store is used instead.

\`\`\`
-- Check current user access via MaxL
display user all;
display group all;
display filter BudgetPlanning.Revenue all;
\`\`\`

---

## Integration Points

### Smart View (Excel Add-in)

Smart View is the primary end-user client for Essbase. It connects directly to the Essbase Server (or through the Essbase Provider Services layer for older topologies) and allows users to:
- Ad hoc query and drilldown through dimension hierarchies
- Submit write-back data for BSO planning cubes
- Run saved reports and templates
- Connect to Hyperion Planning, HFM, and OBIEE via the same interface

**Smart View connection provider types:**
- **Essbase** — direct Essbase connection (port 1423 or via HTTP Provider)
- **Planning** — connects to Hyperion Planning, which reads/writes Essbase behind the scenes
- **HFM** — connects to Hyperion Financial Management
- **OBIEE** — connects to Oracle BI Server for relational and pre-built BI content

### Hyperion Planning Integration

Hyperion Planning uses Essbase as its cube engine. Planning stores metadata (form definitions, task lists, workflow) in an Oracle relational database but stores all numeric data in Essbase cubes. When a Planning application is created, it automatically provisions a corresponding Essbase application and database.

Administrators manage dimension structures in Planning (or EPMA), and Planning synchronises them to Essbase. Data entered via Planning forms is written directly into Essbase cells.

\`\`\`
Oracle DB (Planning metadata)
  ↕ Planning Application Server
Essbase Server (Planning cube data)
  ↕ Smart View / Planning web
End Users
\`\`\`

### Oracle OBIEE / Analytics Server

OBIEE can connect to Essbase as a data source through the Essbase XMLA provider or the Essbase OBI EE connector. This allows Essbase cube data to be combined with relational sources in OBIEE RPD (repository) physical layers and exposed through BI Answers and Dashboards.

For large-scale reporting workloads, it is common to have an ASO reporting cube that mirrors the BSO planning cube, loaded via a MaxL or Planning import job — allowing heavy OBIEE report queries to run against ASO without impacting Planning users on the BSO cube.

---

## Key Administrative Commands (MaxL)

MaxL is Essbase's scripting language for administrative operations. All routine maintenance should be scripted in MaxL rather than performed manually through EAS.

\`\`\`bash
# Connect to Essbase and run a MaxL script
essmsh /scripts/maintenance/clear_and_calc.mxl

# Common MaxL operations:

# Start and stop a database
alter database BudgetPlanning.Revenue enable start;
alter database BudgetPlanning.Revenue disable connects;

# Run a calculation
execute calculation BudgetPlanning.Revenue default;
execute calculation BudgetPlanning.Revenue 'CALC ALL;';
execute calculation BudgetPlanning.Revenue calc_script 'full_consol';

# Export data to a flat file
export database BudgetPlanning.Revenue level0 data
  to local_file '/backup/revenue_l0_export.txt';

# Backup (archive)
alter database BudgetPlanning.Revenue backup to '/backup/revenue_backup.zip';

# Display application status
display application all;
display database BudgetPlanning.Revenue;

# Display active users and locks
display session all on BudgetPlanning.Revenue;
\`\`\`

---

## Essbase 21c vs Classic Essbase (11.x)

| Area | Classic Essbase 11.x | Essbase 21c |
|---|---|---|
| Deployment | On-premises, Java EE app server (WebLogic) | Containerised (Docker/Kubernetes) or Oracle Cloud |
| Admin UI | Essbase Administration Services (EAS) — thick Java client | Essbase Web Console — browser-based |
| Identity | Shared Services / LDAP | Built-in identity store or IDCS |
| Cube types | BSO, ASO | BSO, ASO, Hybrid (BSO with ASO-style aggregations) |
| REST API | MaxL only | REST API + MaxL |
| EPM integration | Tight coupling with Hyperion Planning, HFM via EPMA | Looser; EPM Cloud products use their own Essbase service |
| High Availability | Manual clustering, shared storage | Native active-active clustering |

Essbase 21c introduces the **Hybrid** cube type, which combines a BSO storage layer for write-back and complex calc with ASO-style on-demand aggregation for certain dimensions. This allows Planning cubes to have very large reporting dimensions without pre-calculating and storing all aggregation combinations.
`,
};

async function main() {
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: {
      title: post.title,
      excerpt: post.excerpt,
      content: post.content,
      published: post.published,
      publishedAt: post.publishedAt,
      isPremium: post.isPremium,
    },
  });
  console.log('inserted:', post.slug);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
