import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Fusion Cloud SCM Inventory R13: Architecture, Capabilities, and What to Understand Before You Implement',
  slug: 'oracle-fusion-cloud-scm-inventory-r13-overview',
  excerpt:
    'A technical overview of Oracle Fusion Cloud SCM Inventory Management R13 — the multi-org model, how Product Hub, Receiving, Cost Management, and transaction processing work together on OCI, what R13 changes from prior releases, and the implementation and integration patterns that determine whether a deployment goes smoothly or stalls.',
  category: 'fusion-cloud-scm' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-24'),
  youtubeUrl: null,
  content: `## Overview

Oracle Fusion Cloud SCM Inventory Management is the SaaS inventory and supply chain execution layer within Oracle Fusion Cloud. It runs on Oracle Cloud Infrastructure (OCI), which means there is no database to install, no application server to patch, and no operating system to tune. Oracle manages the infrastructure, quarterly patch cycles, and availability SLAs. What the customer manages is configuration, data, integration, and business process design — and those decisions are just as consequential as anything in an on-premises ERP implementation.

This post covers what Fusion Cloud SCM Inventory R13 actually contains, how its organisational model works, what the key modules do and how they connect, what changed with R13 relative to earlier Fusion releases, and the integration and implementation patterns that matter most for a successful deployment.

---

## The Fusion Cloud SCM Inventory Stack

Oracle Fusion Cloud SCM Inventory is not a single module — it is a set of interconnected functional areas that together handle the physical and financial lifecycle of inventory from receipt to issue:

- **Inventory Management**: the core transaction engine — receipts, issues, transfers, adjustments, and on-hand balances
- **Product Hub**: the item master and item attribute management layer — centralised catalogue of all items across the enterprise
- **Receiving**: inbound processing for purchase orders, transfer orders, and returned goods
- **Shipping**: outbound execution — pick-pack-ship workflow for sales orders and transfer orders
- **Cost Management**: financial layer that values inventory transactions — supports perpetual average cost, standard cost, and actual costing
- **Supply Chain Financial Orchestration (SCFO)**: handles multi-entity intercompany costing and the financial flows that accompany physical inventory movements across business units
- **Cycle Count and Physical Inventory**: periodic accuracy verification programs

In R13, these modules share a unified data model, a single item master, and a common transaction history. This is architecturally different from Oracle EBS, where Inventory, Purchasing, and Order Management each had their own item master records synchronised via concurrent programs, and where the transaction history lived across disconnected schema tables.

---

## The Multi-Org Model

Understanding the Fusion multi-org hierarchy is the single most important prerequisite for configuring Inventory. Transactions flow through this hierarchy; costing and financial accounting are driven by it; every configuration decision you make references a node in it.

\`\`\`
Enterprise
  └── Legal Entity (carries the legal and tax identity)
        └── Business Unit (the financial and operational unit; tied to a Ledger)
              └── Inventory Organisation (the physical location — warehouse, plant, DC)
                    └── Subinventory (zone within the org: FG, WIP, RETURNS, STAGING)
                          └── Locator (optional: bin, rack, aisle — for WMS-level tracking)
\`\`\`

**Enterprise**: the top-level grouping for the entire deployed environment. Typically one per Oracle Cloud tenant.

**Legal Entity**: maps to a legal company registration. Controls VAT/tax treatment, statutory reporting, and intercompany relationships. An inventory organisation belongs to exactly one legal entity.

**Business Unit**: the operational and financial unit. Controls which Ledger (Chart of Accounts + accounting calendar + currency) is used for financial accounting of inventory transactions. Procurement BU and Inventory BU may differ — a purchasing BU can own POs while a separate inventory BU owns the receiving organisation.

**Inventory Organisation**: the physical inventory location. This is where on-hand balance is tracked. An inventory org belongs to one BU and one Legal Entity. All inventory transactions are recorded at the org level. Item master records are enabled per organisation — an item must be explicitly assigned to each org in which it will be transacted.

**Subinventory**: a logical zone within an org. Subinventories are used to separate quality hold material from available stock, finished goods from raw material, or consignment stock from owned stock. Subinventory attributes control: whether material in that zone is nettable for supply planning, whether it is reservable, and whether it is tracked at the locator level.

---

## Product Hub: The Unified Item Master

Product Hub is the item master management layer. Every item in Fusion Cloud SCM is defined in Product Hub and then assigned to inventory organisations.

### Item Classes and Attribute Groups

Items are organised by Item Class, which controls:
- Which attribute groups are applicable (e.g., only purchased items need a Buyer attribute; only manufactured items need a BOM structure type)
- Default values for key attributes
- Lifecycle phases (prototype, production, obsolete)

The hierarchical Item Class structure allows organisations to define attribute inheritance: a child class inherits all attribute groups from its parent and can add additional groups.

### Item Master vs Organisation-Level Attributes

Fusion distinguishes between master-level attributes (shared across all orgs) and organisation-level attributes (specific to one org):

- **Master-level**: item name, description, primary unit of measure, item class, and most engineering attributes
- **Organisation-level**: on-hand tracking type (serialised, lot-controlled, or neither), planner, buyer, costing attributes, lead times

This distinction matters during FBDI data loading: master attributes are loaded in one template, organisation-level attributes in a separate template, and the item-organisation assignment is a third step.

---

## Receiving: The Inbound Transaction Engine

All inbound inventory transactions in Fusion are processed through Receiving. This includes:
- **PO Receipt**: goods received against a purchase order line
- **Transfer Order Receipt**: goods arriving from another inventory organisation
- **RMA Receipt**: goods returned from customers via a Return Material Authorisation

### Two-Step vs Direct Receipt

Receiving supports two modes:
1. **Direct Receipt**: the PO receipt creates both the receipt transaction and the inventory delivery in one step. The item moves directly to a destination subinventory.
2. **Standard (Two-Step) Receipt**: the receipt creates an \`In Receiving\` status record, and a separate Deliver transaction moves the goods from the receiving dock to the destination subinventory.

For organisations with physical inspection or quality control steps, the two-step model is mandatory — the item sits in the receiving dock (tracked in \`receiving\` subinventory) until the QA team passes it and triggers the deliver.

### Receipt Accounting

When a PO receipt is created, the Cost Management engine immediately records the receipt accounting entry:
\`\`\`
DR  Inventory Valuation (at standard or average cost)
DR  Invoice Price Variance (if standard cost; the difference between PO price and standard)
CR  Receiving Inspection (clearing account)
\`\`\`

When the invoice is matched in Payables:
\`\`\`
DR  Receiving Inspection
DR/CR  Invoice Price Variance (final purchase price variance)
CR  Accounts Payable
\`\`\`

This accounting flow is driven by Cost Management configuration — specifically the account derivation rules in the Subledger Accounting (SLA) layer.

---

## Cost Management: How Inventory is Valued

Fusion Cost Management supports three costing methods, set at the cost organisation level:

### Perpetual Average Cost

Each item has a running average cost that updates with every receipt. The average cost = (current on-hand value + new receipt value) / (current quantity + received quantity). Issues are valued at the current average cost.

Average costing is appropriate for discrete manufacturers and distributors where actual purchase costs drive inventory valuation. The risk is cost volatility — a single large receipt at an unusual price can significantly move the average cost for a high-volume item.

### Standard Cost

Each item has a defined standard cost, set by the cost accounting team. Receipts and issues are always valued at standard. All variances from standard (purchase price variance, WIP variance, usage variance) are posted to variance accounts.

Standard costing is common in process manufacturing and environments where management wants cost performance measured against a plan. Period-end variance analysis becomes the primary cost management activity.

### Actual Cost (FIFO)

Available in Fusion Cloud from R13 onward for organisations requiring FIFO (First In, First Out) inventory valuation. Each lot or receipt layer retains its actual cost, and issues deplete the oldest cost layer first.

---

## Key R13 Capabilities and Changes

Oracle Fusion R13 (the 19A/19B release cadence and subsequent quarterly updates) introduced or significantly enhanced several capabilities compared to earlier Fusion releases:

**REST API coverage**: R13 significantly expanded the inventory REST API surface. Item master, on-hand balances, transaction history, cycle counts, and receiving transactions are all accessible via documented REST APIs (under the \`/fscmRestApi/resources/\` base path). Earlier releases required SOAP-based web services for many of these operations.

**Enhanced Lot and Serial Management**: R13 improved the lot genealogy and serial tracking UI, making it practical to trace a lot through the entire supply chain — from supplier receipt through WIP consumption to customer shipment — in the Manage Lot Genealogy page without custom reports.

**Simplified Cost Accounting Configuration**: the account derivation rule framework in Subledger Accounting was simplified in R13, reducing the number of accounting method definitions required for standard cost accounting setups.

**Inventory Reservations**: the reservation model was enhanced to support multi-level ATP (Available to Promise) with integration to the Fusion Order Management ATP engine, enabling automatic reservation of inventory against sales orders at the lot/serial/subinventory level.

**BICC (Business Intelligence Cloud Connector)**: R13 formalised the BICC extract architecture for Inventory, providing a set of maintained view objects for extracting inventory transactions, on-hand balances, and cost accounting data to a customer-managed data warehouse or OAX (Oracle Analytics) instance.

---

## Integration Architecture

Fusion Cloud SCM Inventory exposes three integration patterns:

### 1. FBDI (File-Based Data Import)

FBDI uses structured spreadsheet templates (downloaded from the Cloud UI) that are uploaded as zip files and processed by ESS (Enterprise Scheduler Service) import jobs. FBDI is the primary mechanism for:
- Initial item master load
- Initial on-hand balance migration
- Bulk transaction creation (e.g., loading a year of historical receipts)

Each FBDI template maps directly to a set of interface tables in the Fusion schema; the ESS job reads those tables, validates the data, and creates the target objects. Errors are reported in the ESS job log and in a downloadable error report from the Scheduled Processes UI.

### 2. REST APIs

REST APIs are the primary mechanism for real-time integration — a WMS system pushing a goods receipt, a MES system reporting a production completion, or a custom portal querying on-hand balances. Key inventory REST APIs:

| Resource | Endpoint | Operation |
|----------|----------|-----------|
| Inventory Items | \`/fscmRestApi/resources/11.13.18.05/inventoryItems\` | GET, POST, PATCH |
| On-Hand Balances | \`/fscmRestApi/resources/11.13.18.05/inventoryOnhandBalances\` | GET |
| Misc Transactions | \`/fscmRestApi/resources/11.13.18.05/inventoryMiscTransactions\` | POST |
| Transfer Orders | \`/fscmRestApi/resources/11.13.18.05/transferOrders\` | GET, POST |
| Cycle Count Headers | \`/fscmRestApi/resources/11.13.18.05/cycleCounts\` | GET, POST |
| ESS Jobs | \`/fscmRestApi/resources/11.13.18.05/erpintegrations\` | POST (submit job) |

### 3. BICC (Business Intelligence Cloud Connector)

BICC provides scheduled bulk extracts of Fusion transactional data to an external OCI Object Storage bucket or UCM (Universal Content Management) location. It is the correct mechanism for BI/data warehouse feeds — not REST APIs, which are not designed for bulk historical extraction.

BICC offerings for Inventory include view objects for on-hand balances, material transactions, cost distributions, lot/serial details, and item attribute snapshots.

---

## Implementation Sequencing

The most common implementation sequencing failure in Fusion Cloud SCM Inventory is attempting to configure transaction flows before the foundation data is complete. The correct sequence is strictly ordered:

\`\`\`
1. Enterprise Structure  →  Legal Entity  →  Ledger  →  Business Unit
2. Reference Data Sets (set codes for shared reference data)
3. Inventory Organisations  →  Subinventories  →  Locators (if used)
4. Units of Measure (UOM classes and conversions)
5. Item Classes and Attribute Groups
6. Item master FBDI load (master-level attributes)
7. Item-Organisation assignment FBDI load
8. Organisation-level item attribute FBDI load
9. Cost Accounting setup (cost organisation, cost method, account derivation rules)
10. On-hand balance migration FBDI
11. Transaction type configuration
12. Integration setup (REST credentials, FBDI job scheduling, BICC)
13. User roles and data security (inventory org access)
14. Cycle count setup
15. End-to-end testing
\`\`\`

Skipping step 9 before step 10 is the most common mistake — loading on-hand balances before cost accounting is configured means the balances have no financial value, and the correction requires a full reversal and reload.

---

## Summary

Oracle Fusion Cloud SCM Inventory R13 is a SaaS supply chain execution platform on OCI that covers the physical and financial lifecycle of inventory from receipt through shipment. Its multi-org model (Enterprise → Legal Entity → Business Unit → Inventory Org → Subinventory) defines the scope and financial treatment of every transaction. Product Hub centralises the item master. Cost Management values transactions through perpetual average, standard, or actual (FIFO) costing. R13 expanded REST API coverage, improved lot genealogy, and formalised BICC extracts for BI integration. Implementation sequencing is strict: enterprise structure before organisations, item master before on-hand migration, cost setup before any financial transactions. The companion runbook covers the step-by-step configuration procedure, FBDI data loading, REST API integration setup, and the crontab-scheduled monitoring scripts that provide visibility into ESS job health, pending transactions, and integration errors on an ongoing basis.`,
};

async function main() {
  console.log('Inserting Oracle Fusion Cloud SCM Inventory R13 blog post...');
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
