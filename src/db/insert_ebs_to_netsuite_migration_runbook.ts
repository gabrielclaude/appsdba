import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle EBS 12.2.9 to NetSuite Migration — Extraction, Transformation, Import, and UAT',
  slug: 'oracle-ebs-to-netsuite-migration-runbook',
  excerpt:
    'Step-by-step migration runbook for Oracle EBS 12.2.9 to NetSuite: complete EBS extraction SQL for all data domains, NetSuite CSV import templates and field mappings, financial reconciliation procedures, and UAT sign-off checklists. Covers multi-org to subsidiary mapping, open transaction cutover, and the go-live sequence.',
  category: 'netsuite' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-15'),
  youtubeUrl: null,
  content: `## Prerequisites

Before starting this runbook:

- [ ] NetSuite instance configured through the configuration sequence runbook (COA, subsidiaries, dimensions, item master framework, roles)
- [ ] EBS 12.2.9 read access confirmed — DBA credentials for direct table queries on the target instance
- [ ] Cutover date agreed and signed off by the Controller
- [ ] Multi-org to subsidiary mapping worksheet completed and approved
- [ ] CSV staging folder created with subfolders per data domain
- [ ] NetSuite CSV Import permissions granted to the migration administrator role
- [ ] EBS Vision instance accessible (for extraction) — direct SQL access, not APPS forms

**Assumed EBS instance values used in this runbook:**
- Master inventory organization: 204 (Vision Operations)
- Primary operating unit ORG_ID: 204
- Primary ledger ID: 2 (Vision Operations USA)
- Cutover period: JUN-26
- Functional currency: USD

Substitute your production values for all hardcoded IDs before running any query.

---

## Phase 1: EBS Data Assessment and Profiling

Run all profiling queries before extraction begins. Record results in the Migration Inventory Log. These counts become the reconciliation targets for every subsequent validation step.

### 1.1 Operating Units and Ledgers

\`\`\`sql
SELECT gl.ledger_id,
       gl.name              AS ledger_name,
       gl.currency_code,
       gl.period_set_name,
       gl.chart_of_accounts_id,
       hou.organization_id  AS org_id,
       hou.name             AS operating_unit_name,
       hou.default_legal_context_id
FROM   gl_ledgers gl
JOIN   hr_operating_units hou
       ON hou.set_of_books_id = gl.ledger_id
ORDER  BY gl.name, hou.name;
\`\`\`

**Action**: For each Operating Unit, record the target NetSuite Subsidiary in the mapping worksheet. Confirm with the Controller before proceeding.

### 1.2 Master Data Volume Profile

\`\`\`sql
-- Active customers
SELECT 'Customers' AS domain, COUNT(*) AS record_count
FROM   hz_cust_accounts WHERE status = 'A'
UNION ALL
-- Active vendors
SELECT 'Vendors', COUNT(*)
FROM   ap_suppliers WHERE enabled_flag = 'Y'
UNION ALL
-- Active vendor sites
SELECT 'Vendor Sites', COUNT(*)
FROM   ap_supplier_sites_all WHERE inactive_date IS NULL
UNION ALL
-- Active inventory items (master org)
SELECT 'Items', COUNT(*)
FROM   mtl_system_items_b
WHERE  organization_id = 204 AND enabled_flag = 'Y'
UNION ALL
-- Active GL accounts
SELECT 'GL Accounts', COUNT(DISTINCT segment3)
FROM   gl_code_combinations
WHERE  chart_of_accounts_id = 1
AND    enabled_flag = 'Y'
AND    summary_flag = 'N';
\`\`\`

### 1.3 Open Transaction Volume

\`\`\`sql
-- Open AR by ORG_ID
SELECT org_id,
       COUNT(*)                        AS invoice_count,
       SUM(amount_due_remaining)       AS open_balance
FROM   ar_payment_schedules_all
WHERE  status = 'OP'
AND    amount_due_remaining != 0
GROUP  BY org_id
ORDER  BY org_id;

-- Open AP by ORG_ID
SELECT org_id,
       COUNT(*)                                     AS invoice_count,
       SUM(invoice_amount - NVL(amount_paid, 0))    AS open_balance,
       COUNT(CASE WHEN payment_status_flag = 'P' THEN 1 END) AS partial_count
FROM   ap_invoices_all
WHERE  payment_status_flag IN ('N', 'P')
AND    cancelled_date IS NULL
GROUP  BY org_id
ORDER  BY org_id;

-- Open PO lines
SELECT org_id,
       COUNT(DISTINCT poh.po_header_id)      AS po_count,
       COUNT(pll.line_location_id)           AS shipment_count,
       SUM(pll.quantity - NVL(pll.quantity_received, 0))
         * pll.price_override                AS open_value
FROM   po_headers_all poh
JOIN   po_lines_all pol        ON pol.po_header_id = poh.po_header_id
JOIN   po_line_locations_all pll ON pll.po_line_id = pol.po_line_id
WHERE  poh.closed_code NOT IN ('FINALLY CLOSED', 'CLOSED')
AND    poh.cancel_flag = 'N'
GROUP  BY org_id, pll.price_override
ORDER  BY org_id;
\`\`\`

**Record all counts in the Migration Inventory Log. Sign off with the data owners before Phase 2.**

---

## Phase 2: EBS Data Extraction

Export each domain to a separate CSV file. Use SQL*Plus spool, SQL Developer export, or an ETL tool. All CSVs use UTF-8 encoding with header rows.

### 2.1 Chart of Accounts Extraction

\`\`\`sql
SELECT DISTINCT
       gcc.segment3                    AS "External ID",
       fv.description                  AS "Name",
       CASE gcc.account_type
         WHEN 'A' THEN 'Other Current Asset'
         WHEN 'L' THEN 'Other Current Liability'
         WHEN 'O' THEN 'Equity'
         WHEN 'R' THEN 'Income'
         WHEN 'E' THEN 'Expense'
       END                             AS "Type",
       gcc.segment3                    AS "Number",
       fv.description                  AS "Description",
       'F'                             AS "Is Summary"
FROM   gl_code_combinations gcc
JOIN   fnd_flex_values_vl fv
       ON  fv.flex_value = gcc.segment3
       AND fv.flex_value_set_id = (
             SELECT id_flex_num
             FROM   fnd_id_flex_segments
             WHERE  application_id             = 101
             AND    id_flex_code               = 'GL#'
             AND    application_column_name    = 'SEGMENT3'
             AND    ROWNUM                     = 1
           )
WHERE  gcc.chart_of_accounts_id = 1
AND    gcc.enabled_flag = 'Y'
AND    gcc.summary_flag = 'N'
ORDER  BY gcc.segment3;
\`\`\`

**Output file**: \`01_chart_of_accounts.csv\`
**NetSuite import type**: Chart of Accounts
**Post-import check**: Run NetSuite Trial Balance with no date filter. Confirm every account from the EBS list appears.

### 2.2 Dimensions Extraction

**Departments (from EBS Department segment):**

\`\`\`sql
SELECT DISTINCT
       gcc.segment2          AS "External ID",
       fv.description        AS "Name",
       'F'                   AS "Is Inactive"
FROM   gl_code_combinations gcc
JOIN   fnd_flex_values_vl fv
       ON  fv.flex_value = gcc.segment2
       AND fv.flex_value_set_id = (
             SELECT id_flex_num
             FROM   fnd_id_flex_segments
             WHERE  application_id          = 101
             AND    id_flex_code            = 'GL#'
             AND    application_column_name = 'SEGMENT2'
             AND    ROWNUM                  = 1
           )
WHERE  gcc.chart_of_accounts_id = 1
AND    gcc.enabled_flag = 'Y'
ORDER  BY gcc.segment2;
\`\`\`

**Output file**: \`02_departments.csv\`
**NetSuite import type**: Departments

### 2.3 Customer Extraction

\`\`\`sql
SELECT hp.party_name                                 AS "Name",
       hca.account_number                            AS "External ID",
       hca.account_number                            AS "Customer ID",
       hca.customer_class_code                       AS "Category",
       hl.address1                                   AS "Address 1: Address",
       hl.address2                                   AS "Address 1: Address 2",
       hl.city                                       AS "Address 1: City",
       hl.state                                      AS "Address 1: State",
       hl.postal_code                                AS "Address 1: Zip",
       hl.country                                    AS "Address 1: Country",
       CASE hsu.site_use_code
         WHEN 'BILL_TO' THEN 'T'
         ELSE 'F'
       END                                           AS "Address 1: Default Billing",
       CASE hsu.site_use_code
         WHEN 'SHIP_TO' THEN 'T'
         ELSE 'F'
       END                                           AS "Address 1: Default Shipping",
       -- Map ORG_ID to NetSuite subsidiary internal ID using your mapping worksheet
       CASE hcas.org_id
         WHEN 204 THEN 'Vision Operations'
         ELSE 'Unknown'
       END                                           AS "Subsidiary"
FROM   hz_parties hp
JOIN   hz_cust_accounts hca        ON hca.party_id              = hp.party_id
JOIN   hz_cust_acct_sites_all hcas ON hcas.cust_account_id      = hca.cust_account_id
JOIN   hz_party_sites hps          ON hps.party_site_id         = hcas.party_site_id
JOIN   hz_locations hl             ON hl.location_id            = hps.location_id
JOIN   hz_cust_site_uses_all hsu   ON hsu.cust_acct_site_id     = hcas.cust_acct_site_id
WHERE  hca.status = 'A'
AND    hsu.status = 'A'
AND    hcas.org_id = 204
AND    hsu.site_use_code = 'BILL_TO'
ORDER  BY hp.party_name;
\`\`\`

**Output file**: \`03_customers.csv\`
**NetSuite import type**: Customers
**Note**: TCA may return multiple BILL_TO sites per customer if the customer was set up across multiple OU sites. Deduplicate on \`account_number\` — the first BILL_TO address wins. Shipping addresses load separately after the primary customer record is created.

### 2.4 Vendor Extraction

\`\`\`sql
SELECT aps.vendor_name                               AS "Name",
       aps.segment1                                  AS "External ID",
       aps.vendor_type_lookup_code                   AS "Category",
       apss.vendor_site_code                         AS "Address: Label",
       apss.address_line1                            AS "Address: Address",
       apss.address_line2                            AS "Address: Address 2",
       apss.city                                     AS "Address: City",
       apss.state                                    AS "Address: State",
       apss.zip                                      AS "Address: Zip",
       apss.country                                  AS "Address: Country",
       'T'                                           AS "Address: Default Billing",
       CASE apss.org_id
         WHEN 204 THEN 'Vision Operations'
         ELSE 'Unknown'
       END                                           AS "Subsidiary"
FROM   ap_suppliers aps
JOIN   ap_supplier_sites_all apss ON apss.vendor_id = aps.vendor_id
WHERE  aps.enabled_flag = 'Y'
AND    apss.inactive_date IS NULL
AND    apss.org_id = 204
ORDER  BY aps.vendor_name, apss.vendor_site_code;
\`\`\`

**Output file**: \`04_vendors.csv\`
**NetSuite import type**: Vendors / Suppliers

### 2.5 Item Extraction

\`\`\`sql
SELECT msi.segment1                                  AS "External ID",
       msi.description                               AS "Display Name / Code",
       msi.description                               AS "Description",
       msi.primary_uom_code                          AS "Units",
       CASE
         WHEN msi.inventory_item_flag = 'Y'
              AND msi.purchased_item_flag = 'Y'
              AND msi.customer_order_enabled_flag = 'Y'
              THEN 'inventoryItem'
         WHEN msi.inventory_item_flag = 'N'
              AND msi.purchased_item_flag = 'Y'
              THEN 'nonInvtPart'
         WHEN msi.inventory_item_flag = 'N'
              AND msi.customer_order_enabled_flag = 'Y'
              THEN 'nonInvtPart'
         ELSE 'serviceItem'
       END                                           AS "Type",
       -- Map to NetSuite GL accounts using COA mapping worksheet
       'Cost of Goods Sold'                          AS "COGS Account",
       'Product Sales'                               AS "Income Account",
       'Inventory Asset'                             AS "Asset Account"
FROM   mtl_system_items_b msi
WHERE  msi.organization_id = 204
AND    msi.enabled_flag = 'Y'
ORDER  BY msi.segment1;
\`\`\`

**Output file**: \`05_items.csv\`
**NetSuite import type**: Items
**Note**: The GL account column values must exactly match the account names in NetSuite as imported in step 2.1. Update the CASE expressions to use your actual NetSuite account names.

### 2.6 GL Beginning Balances Extraction

\`\`\`sql
SELECT gcc.segment3                              AS account_number,
       fv.description                            AS account_name,
       gcc.account_type,
       SUM(gb.begin_balance_dr
         - gb.begin_balance_cr
         + gb.period_net_dr
         - gb.period_net_cr)                    AS closing_balance
FROM   gl_balances gb
JOIN   gl_code_combinations gcc
       ON gcc.code_combination_id = gb.code_combination_id
JOIN   fnd_flex_values_vl fv
       ON  fv.flex_value        = gcc.segment3
       AND fv.flex_value_set_id = (
             SELECT id_flex_num
             FROM   fnd_id_flex_segments
             WHERE  application_id          = 101
             AND    id_flex_code            = 'GL#'
             AND    application_column_name = 'SEGMENT3'
             AND    ROWNUM = 1
           )
WHERE  gb.ledger_id     = 2
AND    gb.period_name   = 'JUN-26'
AND    gb.actual_flag   = 'A'
AND    gb.currency_code = 'USD'
GROUP  BY gcc.segment3, fv.description, gcc.account_type
HAVING SUM(gb.begin_balance_dr
         - gb.begin_balance_cr
         + gb.period_net_dr
         - gb.period_net_cr) != 0
ORDER  BY gcc.segment3;
\`\`\`

**Output file**: \`06_gl_beginning_balances.csv\`
**Import method**: Manual journal entry in NetSuite — one line per account, debit accounts with positive balance, credit accounts with negative balance. The journal must net to zero. Memo on every line: \`MIGRATION OPENING BALANCE JUN-26\`.

### 2.7 Open AR Extraction

\`\`\`sql
SELECT rct.trx_number                            AS "External ID",
       hp.party_name                             AS "Customer",
       hca.account_number                        AS "Customer: External ID",
       rct.trx_date                              AS "Date",
       rct.term_due_date                         AS "Due Date",
       rct.invoice_currency_code                 AS "Currency",
       aps.amount_due_original                   AS "Amount",
       aps.amount_due_remaining                  AS "Amount Due",
       rct.comments                              AS "Memo",
       CASE rct.org_id
         WHEN 204 THEN 'Vision Operations'
       END                                       AS "Subsidiary"
FROM   ra_customer_trx_all rct
JOIN   hz_cust_accounts hca ON hca.cust_account_id = rct.bill_to_customer_id
JOIN   hz_parties hp        ON hp.party_id         = hca.party_id
JOIN   ar_payment_schedules_all aps
       ON aps.customer_trx_id = rct.customer_trx_id
WHERE  rct.org_id = 204
AND    aps.status = 'OP'
AND    aps.amount_due_remaining != 0
AND    rct.complete_flag = 'Y'
ORDER  BY rct.trx_date, rct.trx_number;
\`\`\`

**Output file**: \`07_open_ar_invoices.csv\`
**NetSuite import type**: Invoices
**Note**: For partially paid invoices, \`amount_due_remaining\` is the open amount. Import as a new invoice for the remaining balance with memo \`MIGRATION OPEN BALANCE - ORIGINAL INV: [trx_number]\`. Do not import the original full amount with a partial payment — that creates incorrect AR aging history.

### 2.8 Open AP Extraction

\`\`\`sql
SELECT ai.invoice_num                                AS "External ID",
       aps.vendor_name                              AS "Vendor",
       aps.segment1                                 AS "Vendor: External ID",
       ai.invoice_date                              AS "Date",
       ai.invoice_currency_code                     AS "Currency",
       ROUND(ai.invoice_amount
           - NVL(ai.amount_paid, 0), 2)             AS "Amount",
       ai.description                               AS "Memo",
       CASE ai.payment_method_lookup_code
         WHEN 'CHECK' THEN 'Check'
         WHEN 'EFT'   THEN 'EFT'
         ELSE 'Check'
       END                                          AS "Payment Method",
       CASE ai.org_id
         WHEN 204 THEN 'Vision Operations'
       END                                          AS "Subsidiary"
FROM   ap_invoices_all ai
JOIN   ap_suppliers aps ON aps.vendor_id = ai.vendor_id
WHERE  ai.org_id = 204
AND    ai.payment_status_flag IN ('N', 'P')
AND    ai.cancelled_date IS NULL
AND    ai.approval_status_lookup_code = 'APPROVED'
ORDER  BY ai.invoice_date, ai.invoice_num;
\`\`\`

**Output file**: \`08_open_ap_bills.csv\`
**NetSuite import type**: Vendor Bills

### 2.9 Inventory On-Hand Extraction

\`\`\`sql
SELECT msi.segment1                              AS "Item",
       msi.segment1                              AS "Item: External ID",
       moq.subinventory_code                     AS "Location",
       moq.transaction_quantity                  AS "On Hand Qty",
       msi.primary_uom_code                      AS "Units",
       ciq.item_cost                             AS "Unit Cost"
FROM   mtl_onhand_quantities_detail moq
JOIN   mtl_system_items_b msi
       ON  msi.inventory_item_id = moq.inventory_item_id
       AND msi.organization_id   = moq.organization_id
LEFT JOIN cst_item_costs ciq
       ON  ciq.inventory_item_id = moq.inventory_item_id
       AND ciq.organization_id   = moq.organization_id
       AND ciq.cost_type_id      = 1   -- Frozen standard cost
WHERE  moq.organization_id = 204
AND    moq.transaction_quantity > 0
ORDER  BY msi.segment1, moq.subinventory_code;
\`\`\`

**Output file**: \`09_inventory_onhand.csv\`
**Import method**: NetSuite Inventory Adjustment (individual items) or Inventory Worksheet import. The adjustment account must be the migration clearing account — not COGS.

---

## Phase 3: Data Transformation and Template Preparation

### 3.1 COA Mapping Worksheet

Create a spreadsheet with the following columns. Complete with the Controller before any NetSuite import runs.

| EBS Segment3 | EBS Description | EBS Account Type | NetSuite Account Number | NetSuite Account Name | NetSuite Account Type | Notes |
|---|---|---|---|---|---|---|
| 1010 | Cash - Operating | A | 1010 | Cash - Operating | Bank | Direct map |
| 1200 | Accounts Receivable | A | 1200 | Accounts Receivable | Accounts Receivable | Direct map |
| 2000 | Accounts Payable | L | 2000 | Accounts Payable | Accounts Payable | Direct map |
| 4100 | Product Sales | R | 4100 | Product Sales | Income | Direct map |

Sign off required: Controller signature and date before COA import begins.

### 3.2 Multi-Org to Subsidiary Mapping

| EBS Org ID | EBS Operating Unit Name | EBS Ledger | NetSuite Subsidiary | NetSuite Currency | Notes |
|---|---|---|---|---|---|
| 204 | Vision Operations | Vision Operations USA | Vision Operations | USD | Primary subsidiary |
| 206 | Vision Services | Vision Operations USA | Vision Operations | USD | Collapse into primary — same legal entity |

This mapping drives the Subsidiary column on every imported record. Every record with an unmapped ORG_ID must be resolved before import.

### 3.3 Item Type Decision Matrix

Review every item in \`05_items.csv\` where the Type column is \`serviceItem\` (the default fallback). Confirm with the warehouse and procurement leads whether these should be Non-Inventory items or true Service items. Correct the Type column before the item import runs.

### 3.4 Currency Exchange Rates

Before importing any foreign currency open transactions:

1. Navigate to **Lists > Accounting > Currency Exchange Rates**
2. Enter the exchange rate as of the cutover date for every currency that appears in the open AR or open AP extract
3. Confirm with Treasury that the rates match the EBS \`GL_DAILY_RATES\` entries for the cutover date

\`\`\`sql
-- EBS exchange rates as of cutover date
SELECT from_currency,
       to_currency,
       conversion_date,
       conversion_rate
FROM   gl_daily_rates
WHERE  conversion_date = DATE '2026-06-30'
AND    conversion_type = 'Corporate'
AND    to_currency = 'USD'
ORDER  BY from_currency;
\`\`\`

---

## Phase 4: NetSuite Import Execution

Execute imports in strict sequence. Do not begin the next step until the current step has zero import errors (or documented exclusions).

### 4.1 Import Order

| Step | Record Type | File | NetSuite Path | Blocker If Skipped |
|------|------------|------|--------------|-------------------|
| 1 | Chart of Accounts | 01_chart_of_accounts.csv | Setup > Import/Export > Import CSV Records > Chart of Accounts | Items will have no account to reference |
| 2 | Departments | 02_departments.csv | Setup > Import/Export > Import CSV Records > Departments | Transactions will have no department dimension |
| 3 | Customers | 03_customers.csv | Setup > Import/Export > Import CSV Records > Customers | AR invoices will fail validation |
| 4 | Vendors | 04_vendors.csv | Setup > Import/Export > Import CSV Records > Vendors | AP bills will fail validation |
| 5 | Items | 05_items.csv | Setup > Import/Export > Import CSV Records > Items | Transactions cannot reference items |
| 6 | GL Beginning Balances | 06_gl_beginning_balances.csv | Transactions > Financial > Make Journal Entries | Trial balance will not reconcile |
| 7 | Open AR | 07_open_ar_invoices.csv | Setup > Import/Export > Import CSV Records > Invoices | AR aging will show zero |
| 8 | Open AP | 08_open_ap_bills.csv | Setup > Import/Export > Import CSV Records > Vendor Bills | AP aging will show zero |
| 9 | Inventory On-Hand | 09_inventory_onhand.csv | Transactions > Inventory > Inventory Adjustments | Inventory asset will not balance |

### 4.2 CSV Import Configuration

For each import in NetSuite:

1. Navigate to **Setup > Import/Export > Import CSV Records**
2. Select the record type
3. Upload the CSV file
4. On the Field Mapping screen: map each CSV column header to the corresponding NetSuite field internal ID
5. In Advanced Options: set **Run Server SuiteScripts** to YES (ensures validation triggers fire during import, not silently after)
6. Set **Ignore mandatory field warnings** to NO during initial test runs
7. Save the import map — you will reuse it if the file needs to be re-imported after error correction

### 4.3 Error Handling Protocol

Each import produces a Job Status page with an error log. For every error:

1. Open the error log and export to CSV
2. For each error row, identify the root cause (missing field, invalid value, referenced record not found)
3. Correct the source file or the referenced NetSuite record
4. Re-import the corrected rows only (not the entire file — use the error log as the re-import file after removing the error message column)

**Do not proceed to the next import step while error count > 0 on the current step.**

---

## Phase 5: Financial Reconciliation

Run all reconciliation checks after import steps 1–9 are complete and before UAT begins.

### 5.1 Record Count Reconciliation

| Domain | EBS Count (from Phase 1) | NetSuite Count | Variance | Status |
|--------|------------------------|---------------|---------|--------|
| GL Accounts | | | | |
| Customers | | | | |
| Vendors | | | | |
| Items | | | | |
| Open AR Invoices | | | | |
| Open AP Bills | | | | |

**NetSuite counts via Saved Search:**

- Customers: Lists > Customers > New Search > Criteria: Status = Active, Results: Count
- Vendors: Lists > Vendors > New Search > Criteria: Is Inactive = False, Results: Count
- Items: Lists > Items > New Search > Criteria: Is Inactive = False, Results: Count
- Open AR: Reports > Accounts Receivable > A/R Aging Summary — count of invoice lines
- Open AP: Reports > Accounts Payable > A/P Aging Summary — count of bill lines

Any variance requires investigation before UAT. A missing customer means open invoices cannot be matched. A missing item means purchase orders cannot be entered.

### 5.2 GL Trial Balance Reconciliation

1. In NetSuite: Reports > Financial > Trial Balance
   - Set Period: First period of new fiscal year (the period receiving the opening balances)
   - Show Columns: Account Number, Account Name, Debit, Credit, Net Balance
   - Export to Excel

2. From the EBS extraction (Phase 2, step 2.6): open \`06_gl_beginning_balances.csv\`

3. In Excel: VLOOKUP on account number. For each account, compare EBS closing balance to NetSuite opening balance.

**Tolerance**: Zero. Every account must reconcile exactly. Common causes of variance:
- An EBS account was mapped to a different NetSuite account (check COA mapping worksheet)
- A rounding difference in the journal entry (re-examine the opening balance import file)
- An account that was in EBS but was not created in NetSuite (check the COA import error log)

### 5.3 AR Aging Reconciliation

\`\`\`sql
-- EBS AR aging as of cutover date
SELECT hca.account_number,
       hp.party_name,
       rct.trx_number,
       rct.trx_date,
       aps.due_date,
       aps.amount_due_remaining,
       CASE
         WHEN aps.due_date >= DATE '2026-06-30' THEN 'Current'
         WHEN aps.due_date >= DATE '2026-06-30' - 30 THEN '1-30 Days'
         WHEN aps.due_date >= DATE '2026-06-30' - 60 THEN '31-60 Days'
         WHEN aps.due_date >= DATE '2026-06-30' - 90 THEN '61-90 Days'
         ELSE 'Over 90 Days'
       END AS aging_bucket
FROM   ra_customer_trx_all rct
JOIN   hz_cust_accounts hca ON hca.cust_account_id = rct.bill_to_customer_id
JOIN   hz_parties hp        ON hp.party_id         = hca.party_id
JOIN   ar_payment_schedules_all aps
       ON aps.customer_trx_id = rct.customer_trx_id
WHERE  rct.org_id = 204
AND    aps.status = 'OP'
AND    aps.amount_due_remaining != 0
ORDER  BY aging_bucket, hp.party_name;
\`\`\`

Compare bucket totals to NetSuite: Reports > Accounts Receivable > A/R Aging Summary, as of the cutover date.

### 5.4 AP Aging Reconciliation

\`\`\`sql
-- EBS AP aging as of cutover date
SELECT aps.vendor_name,
       apss.vendor_site_code,
       ai.invoice_num,
       ai.invoice_date,
       asp.due_date,
       ROUND(ai.invoice_amount - NVL(ai.amount_paid, 0), 2) AS open_amount,
       CASE
         WHEN asp.due_date >= DATE '2026-06-30' THEN 'Current'
         WHEN asp.due_date >= DATE '2026-06-30' - 30 THEN '1-30 Days'
         WHEN asp.due_date >= DATE '2026-06-30' - 60 THEN '31-60 Days'
         WHEN asp.due_date >= DATE '2026-06-30' - 90 THEN '61-90 Days'
         ELSE 'Over 90 Days'
       END AS aging_bucket
FROM   ap_invoices_all ai
JOIN   ap_suppliers aps         ON aps.vendor_id      = ai.vendor_id
JOIN   ap_supplier_sites_all apss ON apss.vendor_site_id = ai.vendor_site_id
JOIN   ap_payment_schedules_all asp ON asp.invoice_id = ai.invoice_id
WHERE  ai.org_id = 204
AND    ai.payment_status_flag IN ('N', 'P')
AND    ai.cancelled_date IS NULL
ORDER  BY aging_bucket, aps.vendor_name;
\`\`\`

Compare bucket totals to NetSuite: Reports > Accounts Payable > A/P Aging Summary.

### 5.5 Inventory Valuation Reconciliation

\`\`\`sql
-- EBS inventory value by item
SELECT msi.segment1                              AS item_number,
       msi.description,
       SUM(moq.transaction_quantity)             AS qty_on_hand,
       ciq.item_cost                             AS unit_cost,
       SUM(moq.transaction_quantity) * ciq.item_cost AS total_value
FROM   mtl_onhand_quantities_detail moq
JOIN   mtl_system_items_b msi
       ON  msi.inventory_item_id = moq.inventory_item_id
       AND msi.organization_id   = moq.organization_id
LEFT JOIN cst_item_costs ciq
       ON  ciq.inventory_item_id = moq.inventory_item_id
       AND ciq.organization_id   = moq.organization_id
       AND ciq.cost_type_id      = 1
WHERE  moq.organization_id = 204
GROUP  BY msi.segment1, msi.description, ciq.item_cost
ORDER  BY msi.segment1;
\`\`\`

Compare total inventory value to: NetSuite Reports > Financial > Balance Sheet — Inventory Asset account balance.

---

## Phase 6: UAT and Go-Live Sign-Off

### 6.1 UAT Test Cases

Execute each test case in a NetSuite sandbox populated with the migrated data before go-live.

**Test 1: Order-to-Cash with Migrated Customer**
- [ ] Create a sales order for a customer imported from EBS (use External ID to search)
- [ ] Fulfill and ship the order
- [ ] Invoice the customer
- [ ] Confirm the invoice posts to the correct revenue and AR accounts
- [ ] Compare the posting accounts to what EBS would have posted for the same item

**Test 2: Procure-to-Pay with Migrated Vendor**
- [ ] Create a purchase order for a vendor imported from EBS
- [ ] Receive goods against the PO
- [ ] Enter and match a vendor bill
- [ ] Confirm the bill posts to the correct expense and AP accounts
- [ ] Confirm the vendor payment terms migrated correctly from EBS

**Test 3: AR Invoice Payment Application**
- [ ] Locate a migrated open AR invoice (import External ID matches EBS trx_number)
- [ ] Apply a customer payment to the invoice
- [ ] Confirm the invoice closes and the AR account balance decrements correctly
- [ ] Run AR Aging and confirm the invoice no longer appears as open

**Test 4: AP Bill Payment**
- [ ] Locate a migrated open AP bill (import External ID matches EBS invoice_num)
- [ ] Process a vendor payment
- [ ] Confirm the bill closes and the AP account balance decrements correctly
- [ ] Run AP Aging and confirm the bill no longer appears as open

**Test 5: Inventory Receipt and COGS**
- [ ] Enter a sales order for an inventory item imported from EBS
- [ ] Fulfill and ship — confirm inventory decrements
- [ ] Invoice — confirm COGS and inventory asset post correctly
- [ ] Confirm the inventory account balance in GL matches the physical quantity times unit cost

**Test 6: Period-End Trial Balance**
- [ ] Close the first migration period in NetSuite
- [ ] Run Trial Balance for the period
- [ ] Confirm the closing balance matches the EBS opening balance (from Phase 5.2 reconciliation)
- [ ] Confirm the balance sheet balances (Assets = Liabilities + Equity)

### 6.2 UAT Sign-Off Matrix

| Stakeholder | Domain Covered | Required Tests | Signature | Date |
|------------|---------------|---------------|-----------|------|
| Controller | GL Trial Balance, Period Close | Test 6 | | |
| AR Manager | Customers, Open Invoices, Payments | Tests 1, 3 | | |
| AP Manager | Vendors, Open Bills, Payments | Tests 2, 4 | | |
| Warehouse Manager | Items, Inventory On-Hand | Test 5 | | |
| IT / System Admin | Import logs, error rates, role security | All | | |

**Go-live is blocked until all five signatures are obtained.**

### 6.3 Go-Live Cutover Sequence

| Day | Action | Owner | Verification |
|-----|--------|-------|-------------|
| D-3 | Freeze EBS — no new transactions after cutover date | EBS Admin | Lock concurrent programs in EBS |
| D-3 | Final EBS trial balance extraction | Controller | Sign off on PDF export |
| D-2 | Final extraction of open AR, open AP, inventory | Migration Lead | Row counts match Phase 1 log |
| D-2 | Load final open AR and AP to NetSuite production | Migration Lead | Counts match; aging reconciles |
| D-1 | UAT sign-off confirmation — all stakeholders | Project Manager | All signatures on matrix |
| D-1 | NetSuite production roles assigned to end users | System Admin | Each user logs in and confirms access |
| D-0 | Go-live — NetSuite is system of record | All | First transaction entered and posted |
| D+1 | Post-go-live check: AR aging, AP aging, GL balance | Controller | Any variances opened as P1 tickets |
| D+5 | First week close — confirm no missing data surfaced | Controller | Week 1 income statement reviewed |

### 6.4 Common Migration Failure Patterns

| Failure | Root Cause | Prevention |
|---------|-----------|-----------|
| AR balance does not match EBS | Partially paid invoices imported at original amount | Import open amount (\`amount_due_remaining\`), not original amount |
| Vendor bills post to wrong account | Item type mapped incorrectly in EBS → NetSuite matrix | Review all \`serviceItem\` fallbacks with procurement before import |
| Inventory asset GL does not match on-hand value | Unit cost not included in inventory adjustment import | Always include unit cost in \`09_inventory_onhand.csv\` |
| Customer invoices show wrong subsidiary | ORG_ID not mapped in subsidiary worksheet before import | Complete and sign off subsidiary mapping before extraction |
| Trial balance does not net to zero | Opening balance journal entry has rounding error | Sum debits and credits in Excel before importing the journal |
| Duplicate customers in NetSuite | TCA returned one party via multiple account records | Deduplicate on \`account_number\` before import, not on party name |
| Exchange rate variance on foreign AR | NetSuite recalculated exchange rate at import time | Load \`gl_daily_rates\` entries into NetSuite currency table before importing open transactions |`,
};

async function main() {
  console.log('Inserting EBS to NetSuite migration runbook...');
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
