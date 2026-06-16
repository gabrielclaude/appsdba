import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Migrating from Oracle EBS 12.2.9 to NetSuite: Data Architecture, Extraction, and Validation',
  slug: 'oracle-ebs-to-netsuite-migration-guide',
  excerpt:
    'Moving from Oracle EBS 12.2.9 to NetSuite is not a lift-and-shift — it is a data transformation project that requires understanding both systems at the schema level. This guide covers the architectural differences that drive every mapping decision, the EBS base tables you extract from, the import sequence that NetSuite enforces, and the validation gates between data load and go-live.',
  category: 'netsuite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-15'),
  youtubeUrl: null,
  content: `Most ERP migrations fail not because the destination system is wrong, but because the source data is not understood well enough before the project starts. Oracle EBS 12.2.9 is one of the most data-rich ERP platforms ever built — two decades of functional depth stored in hundreds of interlocked base tables. NetSuite is architecturally elegant by comparison: a flat chart of accounts, subsidiary-based multi-entity model, and a unified data layer designed for cloud delivery. Moving data from one to the other requires understanding both systems at the schema level.

This guide covers the end-to-end migration path from EBS 12.2.9 to NetSuite — from Vision instance extraction queries through the NetSuite import sequence and the validation gates that separate a clean go-live from a financial restatement six months later.

---

## Why This Migration Is Different

A greenfield ERP implementation starts with clean data. A migration from EBS carries accumulated configuration decisions, workarounds, and data that made sense in 2004 but creates noise in 2026. Before any extraction query runs, three strategic decisions determine whether the migration succeeds:

**Decide on the data cutover boundary.** Most organizations migrate open balances only — AR aging, AP aging, inventory on-hand, and beginning GL balances as of the cutover date. Historical transaction detail remains in EBS read-only mode and is accessed for lookups via reports or a data warehouse. Migrating full transaction history into NetSuite is technically possible but rarely justified: the transformation cost is high, and NetSuite's reporting is forward-looking by design. The cleaner model is a hard cutover: EBS is frozen at period end, NetSuite opens with validated beginning balances.

**Decide what master data migrates versus gets rebuilt.** Customer records, vendor records, and items with clean, active data migrate via CSV import. But an EBS Vision instance running since its initial setup has inactive customers, duplicate vendor sites across operating units, and items created for testing that were never deactivated. Master data migration is 40% extraction and 60% cleansing. Data that cannot be validated against a source of truth should be rebuilt in NetSuite natively.

**Understand that EBS's multi-org model does not map directly to NetSuite subsidiaries.** This is the architectural decision that everything else depends on.

---

## The Architectural Gap: Multi-Org vs. Subsidiaries

EBS uses Operating Units (the \`ORG_ID\` column present on virtually every transactional table) to separate AR, AP, and purchasing transactions across legal entities and business units. A single EBS instance can have dozens of Operating Units under a single Ledger, or multiple Ledgers with separate charts of accounts.

NetSuite organizes entities differently. Each **Subsidiary** represents a distinct legal entity with its own currency, tax jurisdiction, and GL period. Intercompany transactions are handled through elimination entries at the parent level. A OneWorld account consolidates multiple subsidiaries into a unified financial view.

The mapping is not one-to-one:

| EBS Concept | NetSuite Equivalent | Notes |
|-------------|--------------------|----|
| Ledger | Subsidiary | One-to-one for legal entities |
| Operating Unit | Business Unit (custom) | EBS OUs may map to one subsidiary or be collapsed |
| Flex Segment - Company | Subsidiary | The company segment typically becomes the subsidiary |
| Flex Segment - Department | Department dimension | Direct mapping |
| Flex Segment - Account | GL Account (flat) | Natural account only — no segment string |
| Flex Segment - Cost Center | Class or custom segment | Depends on reporting requirements |
| Inventory Organization | Location | Warehouse/plant mapping |

The EBS chart of accounts uses a segmented string like \`01-100-4100-02\` where each segment encodes a dimension. NetSuite replaces this with a flat natural account (\`4100 - Software Revenue\`) plus independent dimensional fields. Every reporting query that filtered on segment values in EBS must be rebuilt using NetSuite's dimension filters.

---

## Phase 1: Assessment and Scope Definition

Before writing a single extraction query, profile the EBS instance to understand the volume and quality of data you are moving.

### Operating Unit and Ledger Inventory

\`\`\`sql
SELECT gl.name            AS ledger_name,
       gl.currency_code,
       gl.period_set_name,
       hou.name           AS operating_unit,
       hou.organization_id AS org_id
FROM   gl_ledgers gl
JOIN   hr_operating_units hou
       ON hou.set_of_books_id = gl.ledger_id
ORDER  BY gl.name, hou.name;
\`\`\`

This query identifies every Operating Unit and its parent Ledger — the first input into the subsidiary mapping worksheet.

### Master Data Volume Profile

\`\`\`sql
-- Active customers
SELECT COUNT(*) AS active_customers
FROM   hz_cust_accounts WHERE status = 'A';

-- Active vendors
SELECT COUNT(*) AS active_vendors
FROM   ap_suppliers WHERE enabled_flag = 'Y';

-- Inventory items (master org)
SELECT COUNT(*) AS active_items
FROM   mtl_system_items_b
WHERE  organization_id = 204   -- Vision Operations master org
AND    enabled_flag = 'Y';

-- Open AR invoices by ORG_ID
SELECT org_id, COUNT(*) AS open_invoices, SUM(amount_due_remaining) AS total_open
FROM   ar_payment_schedules_all
WHERE  status = 'OP' AND amount_due_remaining != 0
GROUP  BY org_id ORDER BY org_id;

-- Open AP invoices by ORG_ID
SELECT org_id, COUNT(*) AS open_ap, SUM(invoice_amount - amount_paid) AS open_balance
FROM   ap_invoices_all
WHERE  payment_status_flag IN ('N','P') AND cancelled_date IS NULL
GROUP  BY org_id ORDER BY org_id;
\`\`\`

Record the output. These numbers become your reconciliation targets: when the same counts appear in NetSuite after import, the data load is complete.

---

## Phase 2: EBS Data Extraction by Domain

Extract each data domain in dependency order. The same rule applies here that applies to NetSuite configuration: accounts before items, items before transactions.

### Chart of Accounts

The EBS chart of accounts lives in \`GL_CODE_COMBINATIONS\`. Extract the active natural accounts that will become flat NetSuite GL accounts:

\`\`\`sql
SELECT DISTINCT
       gcc.segment3          AS account_number,
       fv.description        AS account_name,
       gcc.account_type,
       gcc.enabled_flag
FROM   gl_code_combinations gcc
JOIN   fnd_flex_values_vl fv
       ON  fv.flex_value      = gcc.segment3
       AND fv.flex_value_set_id = (
             SELECT flex_value_set_id
             FROM   fnd_id_flex_segments
             WHERE  application_id   = 101
             AND    id_flex_code     = 'GL#'
             AND    segment_name     = 'Account'
             AND    application_column_name = 'SEGMENT3'
           )
WHERE  gcc.chart_of_accounts_id = 1
AND    gcc.enabled_flag = 'Y'
AND    gcc.summary_flag = 'N'
ORDER  BY gcc.segment3;
\`\`\`

The \`account_type\` column maps to NetSuite account types: \`A\` → Other Asset, \`L\` → Other Liability, \`O\` → Equity, \`R\` → Income, \`E\` → Expense.

### Customers (TCA Architecture)

EBS customers are stored in the Trading Community Architecture (TCA). Three layers join to produce a clean customer export:

\`\`\`sql
SELECT hp.party_name               AS customer_name,
       hca.account_number          AS customer_number,
       hca.status,
       hl.address1,
       hl.address2,
       hl.city,
       hl.state,
       hl.postal_code,
       hl.country,
       hsu.site_use_code           AS site_type,
       hca.customer_class_code
FROM   hz_parties hp
JOIN   hz_cust_accounts hca        ON hca.party_id = hp.party_id
JOIN   hz_cust_acct_sites_all hcas ON hcas.cust_account_id = hca.cust_account_id
JOIN   hz_party_sites hps          ON hps.party_site_id = hcas.party_site_id
JOIN   hz_locations hl             ON hl.location_id = hps.location_id
JOIN   hz_cust_site_uses_all hsu   ON hsu.cust_acct_site_id = hcas.cust_acct_site_id
WHERE  hca.status = 'A'
AND    hsu.site_use_code IN ('BILL_TO', 'SHIP_TO')
AND    hcas.org_id = 204
ORDER  BY hp.party_name;
\`\`\`

Expect duplicate party names in TCA — the same company may have been entered multiple times across different Operating Units. Deduplicate on \`account_number\` before loading into NetSuite. NetSuite customers are not OU-scoped; a customer belongs to the subsidiary and is visible across the entity.

### Vendors

\`\`\`sql
SELECT aps.vendor_name,
       aps.segment1              AS vendor_number,
       aps.vendor_type_lookup_code,
       apss.vendor_site_code,
       apss.address_line1,
       apss.city,
       apss.state,
       apss.zip,
       apss.country,
       apss.org_id,
       apss.inactive_date
FROM   ap_suppliers aps
JOIN   ap_supplier_sites_all apss ON apss.vendor_id = aps.vendor_id
WHERE  aps.enabled_flag = 'Y'
AND    apss.inactive_date IS NULL
ORDER  BY aps.vendor_name, apss.vendor_site_code;
\`\`\`

EBS allows the same vendor to have sites in multiple Operating Units with different payment terms and bank accounts per site. NetSuite vendors have a single record with multiple addresses. Consolidate multi-OU vendor sites into a single NetSuite vendor record during transformation.

### Inventory Items

\`\`\`sql
SELECT msi.segment1               AS item_number,
       msi.description,
       msi.primary_uom_code,
       msi.inventory_item_flag,
       msi.purchased_item_flag,
       msi.customer_order_enabled_flag,
       msi.asset_inventory_flag,
       mic.category_set_name,
       mc.segment1                AS category
FROM   mtl_system_items_b msi
LEFT JOIN mtl_item_categories mic
       ON mic.inventory_item_id = msi.inventory_item_id
       AND mic.organization_id = msi.organization_id
LEFT JOIN mtl_categories_b mc
       ON mc.category_id = mic.category_id
WHERE  msi.organization_id = 204
AND    msi.enabled_flag = 'Y'
ORDER  BY msi.segment1;
\`\`\`

Item type in NetSuite (Inventory Item, Non-Inventory Purchase, Service, Other Charge) is determined by the combination of \`inventory_item_flag\`, \`purchased_item_flag\`, and \`customer_order_enabled_flag\` from EBS. Build a mapping matrix during the assessment phase and validate it with the warehouse and procurement leads before loading.

---

## Phase 3: Data Transformation — Mapping EBS to NetSuite

Transformation is where most migration projects accumulate hidden debt. The output of transformation must be a set of CSV files that map exactly to NetSuite's import templates — one template per record type, with headers matching the NetSuite field internal IDs.

**The COA transformation** requires a segment mapping worksheet: for each EBS Segment 3 (natural account) value, identify the corresponding NetSuite account number, name, and type. This is a manual exercise with the controller. Do not automate it — account mapping is a business decision, not a technical one.

**The multi-org transformation** requires the subsidiary mapping decision: which EBS Operating Units collapse into a single NetSuite subsidiary, and which become separate subsidiaries. Every customer, vendor, and transaction extracted from EBS carries an \`ORG_ID\` that must resolve to a NetSuite subsidiary before import.

**The item type transformation** uses a decision matrix:

| inventory_item_flag | purchased_item_flag | customer_order_enabled_flag | NetSuite Item Type |
|--------------------|--------------------|-----------------------------|-------------------|
| Y | Y | Y | Inventory Item |
| N | Y | N | Non-Inventory Purchase Item |
| N | N | Y | Non-Inventory Sale Item |
| N | N | N | Service Item |
| Y | N | Y | Assembly/Kit (review individually) |

**Currency and exchange rates** require special handling. EBS stores foreign currency transactions with the functional currency equivalent already calculated using the exchange rate in \`GL_DAILY_RATES\`. NetSuite will recalculate exchange rates at import time using its own rate tables. Open transaction balances should be imported in the transaction currency, and the exchange rate as of the cutover date must be loaded into NetSuite's currency exchange rate table before importing open AR and AP.

---

## Phase 4: NetSuite Import Sequence

The same dependency rule that governs NetSuite configuration governs NetSuite import: a record cannot reference a parent that does not exist yet. The required sequence:

\`\`\`
1.  Chart of Accounts (GL accounts — flat list)
2.  Departments, Classes, Locations (dimensional segments)
3.  Subsidiaries (if OneWorld)
4.  Currency exchange rates (for foreign currency open items)
5.  Customers
6.  Vendors / Suppliers
7.  Items (with GL account mappings)
8.  Customer addresses and contacts
9.  Vendor addresses and contacts
10. GL Beginning Balances (journal entry import per subsidiary)
11. Open AR Invoices
12. Open AP Bills
13. Open Purchase Orders (if carrying forward)
14. Inventory on-hand quantities (inventory adjustment import)
\`\`\`

NetSuite's CSV Import tool handles steps 1–9 and 11–14 via **Setup > Import/Export > Import CSV Records**. GL beginning balances (step 10) are imported as a journal entry with a debit and credit for each account, balancing to zero net impact. Use a dedicated \`MIGRATION OPENING BALANCE\` memo on every journal line to make them identifiable in audit queries.

Each import run produces an error log. Process errors in batches — do not proceed to the next step until the current step's error rate is zero or all remaining errors are deliberate exclusions documented in the migration log.

---

## Phase 5: Validation and User Acceptance Requirements

Validation is not a single event at the end of the project — it is a gate at the end of each data load step. The three validation layers:

### Layer 1: Record Count Reconciliation

For every data domain, the count of records imported into NetSuite must equal the count of active records in the EBS extraction output. Any discrepancy is a blocker — the missing records must be found and loaded, or their exclusion must be documented and signed off by the data owner before the next step begins.

| Domain | EBS Source Query | NetSuite Verification |
|--------|-----------------|----------------------|
| Customers | \`hz_cust_accounts WHERE status = 'A'\` | Customer Saved Search (count) |
| Vendors | \`ap_suppliers WHERE enabled_flag = 'Y'\` | Vendor Saved Search (count) |
| Items | \`mtl_system_items_b WHERE enabled_flag = 'Y'\` | Item Saved Search (count) |
| Open AR | \`ar_payment_schedules_all WHERE status = 'OP'\` | AR Aging report total |
| Open AP | \`ap_invoices_all WHERE payment_status_flag IN ('N','P')\` | AP Aging report total |

### Layer 2: Financial Balance Reconciliation

The GL beginning balance you load into NetSuite must equal the EBS closing trial balance as of the cutover date — to the penny. Extract the trial balance from EBS:

\`\`\`sql
SELECT gcc.segment3      AS account,
       fv.description    AS account_name,
       gcc.account_type,
       SUM(gb.begin_balance_dr - gb.begin_balance_cr
         + gb.period_net_dr - gb.period_net_cr) AS closing_balance
FROM   gl_balances gb
JOIN   gl_code_combinations gcc
       ON gcc.code_combination_id = gb.code_combination_id
JOIN   fnd_flex_values_vl fv
       ON fv.flex_value = gcc.segment3
       AND fv.flex_value_set_id = 1234   -- account segment value set ID
WHERE  gb.ledger_id      = 2
AND    gb.period_name    = 'JUN-26'
AND    gb.actual_flag    = 'A'
AND    gb.currency_code  = 'USD'
GROUP  BY gcc.segment3, fv.description, gcc.account_type
HAVING SUM(gb.begin_balance_dr - gb.begin_balance_cr
         + gb.period_net_dr - gb.period_net_cr) != 0
ORDER  BY gcc.segment3;
\`\`\`

Run the NetSuite Trial Balance report for the same period. Export both to Excel and run a VLOOKUP reconciliation. Every variance, no matter how small, must be investigated and resolved before UAT begins.

### Layer 3: User Acceptance Testing (UAT)

UAT is not about testing NetSuite features — those were tested in the configuration phase. UAT for a migration project tests that the data in NetSuite is correct and complete enough to run the business from day one.

**Minimum UAT test cases:**

1. **Order-to-cash cycle**: Create a sales order against a migrated customer, ship and invoice it. Confirm the revenue posts to the correct GL account. Compare the account to what EBS would have posted for the same item.

2. **Procure-to-pay cycle**: Enter a purchase order against a migrated vendor, receive it, match a bill. Confirm the expense posts correctly. Check that the vendor payment terms migrated correctly.

3. **AR aging reconciliation**: Pull the NetSuite AR Aging report as of the cutover date. Reconcile the total to the EBS AR aging report for the same date. Identify any invoice where the amount differs and trace to the source.

4. **AP aging reconciliation**: Same exercise for AP. Pay particular attention to invoices that were partially paid in EBS — the open amount, not the original invoice amount, must appear in NetSuite.

5. **Inventory on-hand**: Run a NetSuite inventory valuation report. Compare unit quantities to the EBS on-hand quantity query by item and location. Confirm total inventory asset value matches the EBS GL balance for the inventory accounts.

6. **GL trial balance**: The first period-end trial balance in NetSuite must match the EBS closing trial balance to zero.

**UAT sign-off requirements** should include written approval from the Controller (financial balances), the AR Manager (customer and invoice data), the AP Manager (vendor and bill data), and the Warehouse Manager (item and inventory data). No go-live without all four signatures.

---

## Summary

An EBS to NetSuite migration succeeds when the data preparation work is treated as rigorously as the NetSuite configuration work — and when the project team understands that getting clean data out of EBS requires working at the schema level, not the UI level.

The five rules that prevent the most common migration failures:

1. **Extract from base tables, not views or reports.** EBS views apply business logic and filters that can exclude data you need. Query \`AR_PAYMENT_SCHEDULES_ALL\` directly, not through a UI aging report that applies open-item logic.

2. **Profile before you extract.** The volume and quality assessment from Phase 1 determines the project scope. Surprises in data quality discovered during UAT are expensive. Surprises discovered during profiling are just work.

3. **Resolve the multi-org to subsidiary mapping before touching anything else.** Every other data element's subsidiary assignment depends on this decision. Changing it after master data is loaded means re-loading master data.

4. **Load beginning balances before open transactions.** A NetSuite AR aging that shows open invoices but no corresponding AR account balance fails financial reconciliation. The trial balance journal entry must clear before invoice import begins.

5. **Test the cycle end-to-end, not just the data.** A customer record that imported correctly but was assigned to the wrong subsidiary will not appear on the correct subsidiary's AR report. Only running the order-to-cash cycle in UAT surfaces this class of error.

The companion runbook covers the complete extraction SQL for each EBS data domain, the NetSuite CSV import templates and field mappings, the reconciliation procedure with tolerance thresholds, and the UAT sign-off checklist with acceptance criteria for each test case.`,
};

async function main() {
  console.log('Inserting EBS to NetSuite migration blog post...');
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
