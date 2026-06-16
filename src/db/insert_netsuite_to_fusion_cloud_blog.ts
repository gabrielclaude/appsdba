import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Migrating from NetSuite to Oracle Fusion Cloud ERP: Architecture, Data Migration, and Validation',
  slug: 'netsuite-to-oracle-fusion-cloud-erp-migration-guide',
  excerpt:
    'Organizations migrate from NetSuite to Oracle Fusion Cloud ERP when they outgrow NetSuite\'s subsidiary model — when multi-ledger consolidation, advanced project accounting, complex procurement approval hierarchies, or global tax compliance requirements exceed what NetSuite can deliver without heavy customization. This guide covers the architectural differences that drive every mapping decision, the NetSuite data extraction approach, the Fusion Cloud FBDI import sequence, and the validation gates between load and go-live.',
  category: 'fusion-cloud-erp' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-15'),
  youtubeUrl: null,
  content: `Organizations migrate from NetSuite to Oracle Fusion Cloud ERP for a consistent reason: scale. NetSuite is a well-designed SaaS ERP for companies from startup to mid-market — but its subsidiary model has limits, its project accounting depth is constrained, its global tax engine requires third-party bolt-ons at enterprise scale, and its reporting architecture (Saved Searches, SuiteAnalytics) becomes a bottleneck when finance teams need multi-dimensional OLAP queries across complex legal entity structures. When those limits are hit, Fusion Cloud becomes the destination.

Oracle Fusion Cloud ERP (Oracle Financials Cloud + Procurement Cloud + Supply Chain Cloud) is Oracle's fully SaaS, multi-tenant cloud ERP. It shares architectural DNA with Oracle EBS — the Trading Community Architecture for customer and supplier data, a segmented Account Flexfield for the chart of accounts, Subledger Accounting for transaction-to-GL posting — but it delivers these capabilities through a modern, continuously updated cloud platform rather than on-premise software.

Migrating data from NetSuite to Fusion Cloud is, at the data level, a problem in three parts: extract cleanly from NetSuite (which has limited bulk export tooling compared to an Oracle database), transform the flat NetSuite data model to the hierarchical Fusion Cloud organizational structure, and import via FBDI (File-Based Data Import) — Fusion Cloud's primary bulk load mechanism.

---

## Why This Migration Is Architecturally Complex

The NetSuite data model is deliberately simple. A subsidiary is the top-level organizational container. Everything — customers, vendors, transactions, GL entries — belongs to a subsidiary or is shared across subsidiaries. The chart of accounts is flat (a single account number) with separate dimension fields for Department, Class, and Location.

Fusion Cloud's organizational model is layered and more expressive:

| Concept | NetSuite | Oracle Fusion Cloud ERP |
|---------|----------|------------------------|
| Legal entity | Subsidiary | Legal Entity (with registered address, tax registration) |
| Financial reporting unit | Subsidiary | Primary Ledger (with currency, calendar, COA) |
| Operational unit | Business Unit (custom) | Business Unit (built-in; owns AP, AR, Purchasing transactions) |
| Chart of accounts | Flat account number | Account Flexfield (segmented string: Company.Cost Center.Account.Product.Intercompany) |
| Department dimension | Department | Cost Center segment within the Account Flexfield |
| Class dimension | Class | Product or program segment |
| Location dimension | Location | Location segment or separate Location reference |
| Intercompany | Manual journal entries | Native intercompany with elimination rules |
| Tax engine | Basic SuiteTax or Avalara integration | Oracle Tax with regime/rule engine |

The single largest mapping challenge is the COA. NetSuite uses a flat account number (e.g., account 4100 = Product Revenue) plus separate dimension fields. Fusion Cloud's Account Flexfield encodes all dimensions into a single structured string — similar to the EBS GL flexfield. A revenue line in NetSuite that carries account 4100, Department Engineering, Class SaaS might become 01.500.4100.SAS.000 in Fusion Cloud, where each segment has its own value set, validation, and reporting purpose.

This transformation — from a flat account + three dimension fields to a structured multi-segment flexfield — is the architectural decision that shapes the entire COA migration, and it must be made and signed off by the Controller and the CFO before any technical work begins.

---

## Phase 1: Assessment — What to Extract from NetSuite

NetSuite does not expose its data via SQL queries the way Oracle Database does. Extraction relies on:

**Saved Searches** (the primary method): NetSuite Saved Searches can be exported to CSV from the UI or accessed programmatically via the SuiteAnalytics API. For each data domain, a dedicated Saved Search filters for active records and exports the fields needed for the Fusion Cloud import template.

**SuiteScript REST API**: For complex or high-volume extracts, a SuiteScript 2.1 script can be deployed as a RESTlet that exports records in JSON format. This is more reliable than UI-based CSV export for datasets with more than 10,000 records.

**NetSuite Record Export (Setup > Export)**: Some record types (Items, Chart of Accounts) can be exported directly from the NetSuite UI setup pages. Use this for the COA and item master when record counts are manageable.

### Master Data Volume Profile

Build this inventory before defining the extraction scope:

| Domain | NetSuite Path | Export Method | Expected Volume |
|--------|--------------|--------------|-----------------|
| Chart of Accounts | Lists > Accounting > Accounts | Setup export | < 1,000 typical |
| Departments | Lists > Accounting > Departments | Saved Search | < 500 typical |
| Customers | Lists > Relationships > Customers | Saved Search | Hundreds to hundreds of thousands |
| Vendors/Suppliers | Lists > Relationships > Vendors | Saved Search | Hundreds to tens of thousands |
| Items | Lists > Accounting > Items | Saved Search | Thousands to tens of thousands |
| Open AR Invoices | Transactions > Customers > Invoices | Saved Search | Open items only |
| Open AP Bills | Transactions > Vendors > Bills | Saved Search | Open items only |
| GL Balances | Reports > Financial > Balance Sheet / Income Statement | Report export | By subsidiary and period |

---

## Phase 2: Fusion Cloud Organizational Setup (Before Data Migration)

Data cannot be loaded into Fusion Cloud until the organizational hierarchy is established. This is not a migration task — it is a Fusion Cloud implementation task that must be completed by the Fusion Cloud implementation team before the migration team can begin import work.

**Required setup in Fusion Cloud before data migration:**

1. **Enterprise structure**: Legal Entities, Ledgers (with currency and calendar), Business Units
2. **Account Flexfield structure**: segment definitions, value sets, segment labels
3. **Accounting Calendar**: defined and assigned to ledgers
4. **Currencies and exchange rates**: all transaction currencies configured
5. **Payment terms**: payment term definitions loaded
6. **Tax configuration**: tax regimes, rates, and rules (if Oracle Tax is used)

The migration team requires the following from the Fusion Cloud implementation team before extraction begins:
- The Account Flexfield segment structure (how many segments, their meaning and format)
- The Legal Entity and Business Unit mapping from NetSuite subsidiaries
- The COA mapping worksheet (NetSuite flat account + dimension → Fusion Cloud flexfield string)

---

## Phase 3: NetSuite Data Extraction

### Chart of Accounts

Navigate to **Lists > Accounting > Chart of Accounts**. Export to CSV.

Each NetSuite account record contains:
- Account Number (the flat number, e.g., 4100)
- Account Name
- Account Type (Income, Expense, Bank, Other Asset, etc.)
- Subsidiary (if restricted to specific subsidiaries)

**Transformation required**: Map each NetSuite account to a Fusion Cloud Account Flexfield string using the COA mapping worksheet. This is a manual process — every account mapping must be reviewed by the Controller. The mapping worksheet becomes the authoritative reference for every subsequent import step.

### Customers

Create a Saved Search on the Customer record type with the following criteria and results:

**Criteria:**
- Status: is Active
- Subsidiary: is [target subsidiary]

**Columns to include:**
- Name, Customer Number, Email, Phone
- Billing Address fields (line 1, line 2, city, state, zip, country)
- Shipping Address fields
- Default Payment Terms
- Currency
- Subsidiary

Export each subsidiary's customers separately if you have multiple subsidiaries mapping to different Fusion Cloud Business Units.

### Vendors/Suppliers

Create a Saved Search on the Vendor record type:

**Criteria:**
- Inactive: is False
- Subsidiary: is [target subsidiary]

**Columns to include:**
- Company Name, Vendor Number
- Primary Address fields
- Default Payment Terms
- Currency
- Tax ID (EIN/VAT number — required in Fusion Cloud for tax reporting)

### Items

Create a Saved Search on the Item record type:

**Criteria:**
- Is Inactive: is False
- Type: is [Inventory Item, Non-Inventory Item, Service Item, Assembly]

**Columns to include:**
- Item Name / Number, Display Name, Description
- Type, Subtype
- Units of Measure
- Purchase Price, Sales Price
- Income Account, Expense Account, Asset Account (from the NetSuite item record)
- Purchasing Tax Code, Sales Tax Code

**Transformation required**: Map NetSuite item types to Fusion Cloud inventory organization item types. NetSuite's non-inventory items may become Fusion Cloud description-only PO lines or standard items depending on the procurement configuration.

### GL Opening Balances

Fusion Cloud GL balances are loaded as journal entries via FBDI. The source data is the NetSuite Trial Balance as of the cutover period end.

Navigate to **Reports > Financial > Balance Sheet** and **Reports > Financial > Income Statement**. Set the date to the last day of the cutover period. Export both reports to Excel.

For the GL import: each account in the Fusion Cloud COA must have a debit or credit balance entry. The sum of all entries must net to zero across the entire batch (Asset + Expense accounts debit; Liability + Equity + Revenue accounts credit for their normal balance positions).

---

## Phase 4: FBDI Import — Fusion Cloud's Primary Data Load Tool

FBDI (File-Based Data Import) is the standard mechanism for bulk data loading in Oracle Fusion Cloud ERP. The process:

1. Download the FBDI template for the target record type from Oracle's documentation or from **Tools > File Import and Export** within Fusion Cloud
2. Populate the template with the transformed data (one CSV file per data domain, packaged in a zip file)
3. Upload the zip file to Fusion Cloud's Universal Content Management (UCM) server via **Tools > File Import and Export**
4. Schedule the import process via **Tools > Scheduled Processes** — select the appropriate FBDI import process
5. Monitor the process completion and download the error log
6. Correct errors in the source file and re-import error rows

### FBDI Import Sequence

Follow strict order — records that are referenced by later imports must exist before those imports run:

\`\`\`
1.  Chart of Accounts Values (Account Flexfield values, value sets)
2.  Departments and Cost Centers
3.  Legal Entity and Business Unit setup (done by implementation team)
4.  Customers (HZ_TCA import via Customer FBDI)
5.  Suppliers / Vendors
6.  Items (if Inventory Cloud is in scope)
7.  Payment Terms (if not already configured)
8.  GL Journal Import — Opening Balances (AutoPost to All Ledgers)
9.  Open AR Invoices (Receivables FBDI — AutoInvoice program)
10. Open AP Invoices (Payables FBDI — Open Interface Import)
11. Open Purchase Orders (Purchasing FBDI — if carrying forward open POs)
\`\`\`

### Key FBDI Templates

**For Customers** — use the Customer FBDI template:
- File: HbfImportTemplate.zip
- Programs: Import Trading Community Foundation Entities → Import Trading Community Members

**For Suppliers** — use the Supplier FBDI template:
- File: SupplierImportTemplate.zip
- Programs: Import Suppliers

**For GL Journals** — use the Journal Import FBDI:
- File: GlJournalImportTemplate.zip
- Programs: Import Journals → Post Journals

**For AR Invoices** — use the AutoInvoice FBDI:
- File: ArAutoInvoiceImportTemplate.zip
- Programs: AutoInvoice Import Program

**For AP Invoices** — use the Payables Invoice FBDI:
- File: ApInvoiceImportTemplate.zip
- Programs: Import Payables Invoices

---

## Phase 5: Validation and User Acceptance Requirements

### Financial Reconciliation

The same reconciliation logic applies here as in any ERP migration: record counts must match, financial balances must match, and the cycle tests must pass.

**Trial Balance reconciliation**: Run the Fusion Cloud Trial Balance report (General Accounting > Journals > Inquire and Reports > Account Analysis) for the first period. Compare to the NetSuite Balance Sheet and Income Statement used as the cutover source. Every account must tie.

**AR Aging reconciliation**: Run the Fusion Cloud Aging — 7 Buckets by Account report (Receivables > Manage Transactions > Reports). Compare total open AR to the NetSuite A/R Aging Detail Saved Search as of the cutover date.

**AP Aging reconciliation**: Run the Fusion Cloud A/P Aging report (Payables > Reports > Aging). Compare to the NetSuite A/P Aging Detail Saved Search.

### UAT Test Cases

The minimum UAT test cases for this migration:

1. **Order-to-cash cycle**: Create a sales order against a migrated customer. Ship and invoice. Confirm Subledger Accounting generates the correct journal entries to the mapped GL accounts.

2. **Procure-to-pay cycle**: Create a purchase order against a migrated supplier. Receive goods. Match and pay a supplier invoice. Confirm the accounting entries and the supplier balance.

3. **Period close**: Close the first period in Fusion Cloud Financials. Confirm the close process completes without errors and that the Trial Balance matches the expected opening balance.

4. **Customer payment application**: Apply a payment to an open migrated AR invoice. Confirm the invoice closes and the AR account decrements.

5. **Supplier payment**: Pay an open migrated AP invoice. Confirm the invoice closes and the AP account decrements.

6. **Intercompany transaction** (if applicable): Create an intercompany sale between two legal entities. Confirm the eliminations run correctly in the consolidation ledger.

### UAT Sign-Off

| Stakeholder | Domain | Required Tests | Signature | Date |
|------------|--------|---------------|-----------|------|
| CFO / Controller | GL Trial Balance, Period Close | Test 3 | | |
| AR Manager | Customers, Open AR, Payments | Tests 1, 4 | | |
| AP Manager | Suppliers, Open AP, Payments | Tests 2, 5 | | |
| Tax Lead | Tax configuration on transactions | Tests 1, 2 | | |
| IT / Implementation Lead | FBDI errors, role security | All | | |

Go-live is blocked until all signatures are obtained.

---

## Summary

NetSuite to Fusion Cloud is a migration between two modern SaaS ERP platforms — but the architectural gap is significant. NetSuite's simplicity becomes a liability at enterprise scale. Fusion Cloud's depth requires more pre-work to configure correctly before data can be loaded.

The five principles that determine migration success:

1. **Complete the Fusion Cloud implementation before the migration starts.** The organizational hierarchy, Account Flexfield structure, and COA mapping must be finalized and signed off before extraction begins. A COA mapping change after AR invoices are loaded means re-loading AR invoices.

2. **Extract from NetSuite Saved Searches, not from the UI.** UI-based NetSuite reports apply display filters that can exclude records you need. Build dedicated Saved Searches for each data domain with explicit criteria and include all fields needed for the FBDI template.

3. **Map every NetSuite dimension to a Fusion Cloud flexfield segment before loading any account.** A Department value that is not mapped before the COA load becomes an unmapped dimension on every transaction that references it.

4. **Use FBDI's error log as the primary quality gate.** FBDI imports that complete with errors generate a detailed error log with row-level rejection messages. Process the entire error log before considering an import step complete — partial imports create gaps that are difficult to detect later.

5. **Test the Subledger Accounting (SLA) rules before UAT.** Fusion Cloud's SLA engine determines how transactions post to the GL. An SLA rule that maps to the wrong account is not visible until a transaction is created and the journal entry is generated. Test the mapping with sample transactions in a test environment before migrating any open transactions.

The companion runbook covers the complete NetSuite Saved Search configurations for each data domain, the FBDI template field mapping for Customers, Suppliers, Journals, AR Invoices, and AP Invoices, the reconciliation procedure with tolerance thresholds, and the cutover checklist.`,
};

async function main() {
  console.log('Inserting NetSuite to Fusion Cloud ERP migration blog post...');
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
