import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Migrating from Oracle EBS to Oracle Cloud Fusion ERP: Strategy, Architecture, and What to Expect',
  slug: 'ebs-to-fusion-erp-migration-strategy',
  excerpt:
    'A comprehensive guide to understanding the differences between Oracle EBS and Oracle Fusion ERP, choosing the right migration approach, and preparing your organisation for a successful cloud transition.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-22'),
  youtubeUrl: null,
  content: `Oracle E-Business Suite and Oracle Fusion Cloud ERP are two entirely different products that happen to cover overlapping business functions. The mistake most organisations make is treating the migration as a data move. It is not. It is a re-implementation of your business processes in a fundamentally different technology platform — with a data migration component attached.

Understanding what you are actually changing, before the project scope is locked, prevents the two most common Fusion migration failures: underestimating the integration rebuild effort and bringing EBS-era complexity into a SaaS platform that was not designed for it.

---

## What EBS Is vs. What Fusion Is

### Oracle E-Business Suite: Architecture

EBS is a 3-tier, on-premises Oracle application. You own the hardware, the OS, the Oracle Database, the Oracle Fusion Middleware stack (WebLogic), and the EBS application binaries. Your DBA team patches it. Your developers customise it. Your infrastructure team monitors it.

The technology stack under EBS:
- **Database**: Oracle Database 12c/19c (your instance, your management)
- **Application tier**: WebLogic, Apache HTTP Server, OC4J/Servlet containers
- **UI**: Oracle Forms (legacy, thick client-style browser UI via JRE), OAF (Oracle Application Framework, JSF-based), Discoverer, XML Publisher
- **Process automation**: Oracle Workflow, Concurrent Manager
- **Reporting**: BI Publisher/XML Publisher, Discoverer

Every customisation is a code change to Oracle's own codebase — personalizations, OAF extensions, custom Forms, custom packages in the APPS schema. These must be tested after every Oracle patch.

### Oracle Fusion Cloud ERP: Architecture

Fusion is a SaaS product. Oracle runs the infrastructure. You log in via a browser and configure it. Your "DBA team" does not have access to the underlying Oracle Database.

The technology stack under Fusion:
- **Database**: Oracle Database (multi-tenant, managed entirely by Oracle)
- **UI**: Oracle Redwood (React-based, modern browser UX) — no Forms, no JRE
- **Process automation**: BPM Workflow (cloud-native), Oracle Integration Cloud (OIC) for external integrations
- **Reporting**: OTBI (Oracle Transactional Business Intelligence), BI Publisher on Fusion, Oracle Analytics Cloud
- **Extensibility**: VBCS (Visual Builder Cloud Service) for UI extensions, REST APIs, Oracle Integration Cloud for business logic extensions — all outside the Oracle core codebase

Customisations in Fusion do not touch Oracle's codebase. They run alongside it via extension frameworks. This means Oracle patches Fusion quarterly and your configurations/extensions survive — there is no patch regression testing burden equivalent to EBS.

---

## Key Functional Differences

EBS and Fusion cover similar business functions but with different models. Understanding the differences prevents scope underestimation.

| Area | Oracle EBS | Oracle Fusion Cloud ERP |
|------|-----------|------------------------|
| **GL Structure** | Set of Books, Chart of Accounts Flexfield with independent segments | Ledger, Chart of Accounts (same concept, different configuration model) |
| **Organisational Hierarchy** | Operating Unit → Legal Entity → Set of Books | Business Unit → Legal Entity → Ledger (different mapping rules) |
| **Subledger Accounting** | Fixed accounting rules in AR/AP/FA with limited override | SLA (Subledger Accounting) with full rule-based journal derivation — much more flexible |
| **Period Close** | Manual period close per module | Automated close workflow with configurable dependencies |
| **Procurement** | iProcurement + Purchasing module | Procurement Cloud (different UI, same concepts, different configuration) |
| **Payments** | Oracle Payments module | Oracle Payments Cloud (significantly refactored payment processing engine) |
| **Fixed Assets** | Oracle Assets module | Oracle Assets Cloud (similar function, different mass additions flow) |
| **Reporting Access** | Direct DB access for custom reports | OTBI (metadata-based BI tool); no direct DB access |
| **Data Integration** | DB links, FTP file drops, custom SQL | FBDI (file-based bulk import), REST APIs, Oracle Integration Cloud |
| **Customisation Method** | APPS schema custom packages, OAF extensions, Form personalizations | VBCS extensions, REST API customisations, sandbox configurations |

The most significant structural difference for DBA teams: **you cannot write SQL against the Fusion database**. All data access is through REST APIs or OTBI. Custom reports that previously ran as SQL against the APPS schema must be rewritten in OTBI or exported to Oracle Analytics Cloud.

---

## Migration Approaches

There is no single "right" migration approach. The choice depends on your organisation's risk tolerance, budget, timeline, and the complexity of your EBS customisation footprint.

### Approach 1: Big Bang

All EBS modules cut over to Fusion simultaneously in a single weekend.

**Pros:** Fastest to completion; eliminates complex interim-state integrations between live Fusion modules and remaining EBS modules; single go-live training event.

**Cons:** Highest risk; requires all modules to be configured, tested, and data-loaded before go-live; any show-stopper found late in the project delays the entire cutover.

**Best for:** Organisations with simple functional scope (financials only, 1–2 legal entities, minimal customisations), or organisations willing to accept higher risk in exchange for a shorter project duration.

**Typical timeline:** 6–12 months.

### Approach 2: Phased by Module

Go live with Fusion GL first, then AP, then AR, then Procurement — each module in a separate go-live event.

**Pros:** Reduced risk per go-live event; teams learn Fusion incrementally; enables early benefit realisation on high-priority modules.

**Cons:** Requires complex interim integrations (e.g., EBS AR posting journals to Fusion GL while AR still runs in EBS); extends the total project duration; teams must support two systems simultaneously.

**Best for:** Large, complex organisations with a clear module priority (e.g., GL/AP/AR are highest priority, procurement and supply chain can wait).

**Typical timeline:** 18–30 months for full cutover.

### Approach 3: Phased by Geography/Business Unit

One country or legal entity goes live first; others follow in subsequent waves.

**Pros:** Limits business disruption to one part of the organisation per wave; enables learning from the first go-live to improve subsequent waves.

**Cons:** Must maintain both EBS and Fusion in production for an extended period; inter-company transaction handling becomes complex when entities are on different platforms.

**Best for:** Multinational organisations where individual country operations are relatively independent.

### Approach 4: Hybrid (Keep Manufacturing in EBS/SCM)

Migrate financials to Fusion Cloud ERP while keeping Oracle EBS or Oracle SCM Cloud for manufacturing, ASCP, and supply chain.

**Pros:** Preserves complex manufacturing configuration; Oracle provides pre-built integration connectors between EBS and Fusion Financials.

**Cons:** Integration complexity; Oracle's EBS extended support timeline must be factored in.

---

## Data Migration Strategy

The single most important data migration decision is: **how much history to bring over**.

The answer, almost universally, is: **bring only open transactions and master data. Leave historical transactions in EBS as an archive.**

Here is why:

Migrating 10 years of historical AP invoices, AR invoices, and GL journals to Fusion requires transforming millions of records into FBDI format, loading them, validating they balanced to the GL, and testing that Fusion reporting over the historical data is accurate. This effort is typically larger than configuring the entire Fusion application — and the business value is low, because users rarely query invoices from 2015.

Instead:
1. Keep EBS live (read-only) as a historical archive for 1–3 years post-cutover
2. Migrate only: supplier master, customer master, item master, open AP invoices, open AR invoices, open POs, GL beginning balances at the cutover date
3. Run parallel for 1–3 periods post-cutover to validate Fusion balances match EBS balances

### FBDI (File-Based Data Import)

Fusion's bulk data load mechanism. For each object (Suppliers, Customers, GL Journals, etc.), Oracle provides an Excel or CSV template. You populate the template, upload it to Oracle's UCM or Object Storage, and submit an import process.

Key FBDI objects for financial migration:

| Object | FBDI Template | Notes |
|--------|--------------|-------|
| Suppliers | SupplierImportTemplate.xlsm | Includes supplier sites and bank accounts |
| Customers | CustomerImportTemplate.xlsm | Includes HZ_PARTIES and account sites |
| GL Journals | JournalImportTemplate.xlsm | For beginning balances; one journal per ledger per period |
| Open AP Invoices | PayablesInvoicesImport.xlsm | Only unpaid/partially-paid invoices |
| Open AR Invoices | ReceivablesTransactionImport.xlsm | Only open transactions at cutover |
| Fixed Assets | MassAdditionImport.xlsm | In-service assets at cutover |

---

## Integration Rebuild

This is the most underestimated part of every Fusion migration. Oracle EBS has integrations with dozens of external systems — banks, tax authorities, HR systems, third-party logistics, reporting tools. Every one of those integrations must be rebuilt for Fusion.

EBS integration patterns (outbound from EBS):
- Custom SQL export to flat file → FTP to bank
- Oracle SOA Suite composite → REST call to third party
- Custom PL/SQL in APPS schema → DB link to data warehouse

Fusion integration patterns (everything via API or file):
- Fusion REST API → Oracle Integration Cloud (OIC) → external system
- FBDI file upload → Fusion → OIC notification → external system
- Oracle Analytics Cloud → Fusion REST API → reporting platform

Every EBS integration must be mapped to its Fusion equivalent. Budget 1–2 weeks per integration for rebuild and test. A typical mid-sized EBS instance has 20–60 integrations. This is 20–120 weeks of integration effort — the dominant cost item in most Fusion migrations.

---

## What DBA Teams Should Expect

The DBA role changes dramatically post-Fusion. There is no production Oracle Database to manage. The infrastructure cost savings are real (no DB servers, no storage arrays, no Concurrent Manager infrastructure). But the skill transition is equally real.

DBA skills that become less relevant post-Fusion:
- Oracle DB performance tuning (AWR, ASH, ADDM)
- EBS patching (adop, AD-TXK)
- Concurrent Manager management
- RMAN backup management
- Oracle Forms and OAF troubleshooting

DBA/technical skills that become more relevant:
- Oracle Integration Cloud (OIC) — building and monitoring REST API integrations
- Oracle Analytics Cloud — administering and optimising analytics infrastructure
- FBDI troubleshooting — diagnosing failed data imports
- Oracle Identity Cloud (IDCS) / OCI IAM — user provisioning and SSO
- API monitoring and incident management

Most organisations retain 30–50% of their Oracle technical team post-Fusion, repurposed into integration and analytics roles.

---

## Timeline and Cost Expectations

| Organisation Size | Modules | Timeline | Rough Cost Range |
|-----------------|---------|----------|-----------------|
| Small (1 LE, < 200 users, financials only) | GL, AP, AR, FA | 6–9 months | \$500K–\$1.5M |
| Medium (3 LE, 1,000 users, full financials + procurement) | + Procurement, Expenses | 12–18 months | \$2M–\$5M |
| Large (10+ LE, 5,000+ users, financials + SCM) | + SCM Cloud or hybrid EBS | 24–36 months | \$8M–\$25M+ |

These ranges exclude Oracle SaaS subscription costs (which replace EBS license costs) and ongoing OIC/Analytics infrastructure.

The companion runbook provides the step-by-step execution plan for each phase: discovery, enterprise structure design, data extraction, FBDI loading, integration rebuild, and cutover.`,
};

async function main() {
  console.log('Inserting EBS to Fusion migration blog post...');
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
