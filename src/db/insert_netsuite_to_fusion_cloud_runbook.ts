import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: NetSuite to Oracle Fusion Cloud ERP Migration — Extraction, FBDI Import, and UAT',
  slug: 'netsuite-to-oracle-fusion-cloud-erp-migration-runbook',
  excerpt:
    'Step-by-step NetSuite to Oracle Fusion Cloud ERP migration runbook: NetSuite Saved Search configurations for all data domains, FBDI template field mappings for Customers, Suppliers, GL Journals, AR Invoices, and AP Invoices, data transformation procedures, Fusion Cloud organizational hierarchy mapping, FBDI import execution, financial reconciliation queries, and the UAT sign-off checklist with cutover sequence.',
  category: 'fusion-cloud-erp' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-15'),
  youtubeUrl: null,
  content: `## Prerequisites

Before starting this runbook:

- [ ] Fusion Cloud Financials environment provisioned (Production and Test environments)
- [ ] Fusion Cloud implementation complete: Legal Entities, Ledgers, Business Units, Accounting Calendar, and Account Flexfield structure defined and configured
- [ ] COA mapping worksheet signed off by Controller (NetSuite flat account + dimension → Fusion Cloud Account Flexfield string)
- [ ] Legal Entity to NetSuite Subsidiary mapping worksheet signed off by CFO
- [ ] NetSuite Administrator access confirmed (required to create and run Saved Searches and export)
- [ ] Cutover date agreed and signed off
- [ ] Fusion Cloud Data Integration Administrator role assigned to the migration user
- [ ] FBDI templates downloaded from Oracle documentation (or from Fusion Cloud Help > Tools > File Import and Export)
- [ ] Staging folder structure created on local drive or shared drive:
  - \`/migration/netsuite_extracts/\` — raw CSV exports from NetSuite
  - \`/migration/fbdi_ready/\` — transformed CSVs ready for FBDI packaging
  - \`/migration/fbdi_logs/\` — FBDI error logs per import run

---

## Phase 1: Data Assessment — NetSuite Record Counts

Run all assessment Saved Searches before extraction begins. Record the output in the Migration Inventory Log. These counts become the reconciliation targets.

### 1.1 Create Assessment Saved Searches in NetSuite

Navigate to **Reports > Saved Searches > All Saved Searches > New** for each domain.

**Customer Count by Subsidiary:**
- Record Type: Customer
- Criteria: Status = Active
- Results: Count, Group By: Subsidiary
- Save as: MIGRATION_ASSESSMENT_CUSTOMERS

**Vendor Count by Subsidiary:**
- Record Type: Vendor
- Criteria: Inactive = False
- Results: Count, Group By: Subsidiary
- Save as: MIGRATION_ASSESSMENT_VENDORS

**Item Count by Type:**
- Record Type: Item
- Criteria: Is Inactive = False
- Results: Count, Group By: Type
- Save as: MIGRATION_ASSESSMENT_ITEMS

**Open AR by Subsidiary:**
- Record Type: Transaction (Invoice)
- Criteria: Status = Open, Date = on or before [cutover date]
- Results: Count, Sum(Amount Remaining), Group By: Subsidiary
- Save as: MIGRATION_ASSESSMENT_OPEN_AR

**Open AP by Subsidiary:**
- Record Type: Transaction (Bill)
- Criteria: Status = Open, Date = on or before [cutover date]
- Results: Count, Sum(Amount Remaining), Group By: Subsidiary
- Save as: MIGRATION_ASSESSMENT_OPEN_AP

### 1.2 Assessment Results Log

| Domain | NetSuite Count | Subsidiary/Type Breakdown | Notes |
|--------|---------------|--------------------------|-------|
| Active Customers | | | |
| Active Vendors | | | |
| Inventory Items | | | |
| Non-Inventory Items | | | |
| Service Items | | | |
| Open AR Invoices | | | |
| Open AR — Total Balance | | | |
| Open AP Bills | | | |
| Open AP — Total Balance | | | |

Sign off: _________________ (Migration Lead)  Date: _________________

---

## Phase 2: NetSuite Data Extraction

### 2.1 Chart of Accounts Export

Navigate to **Lists > Accounting > Chart of Accounts**.

Click **Export** > **CSV**. The export includes:
- Account Number
- Account Name
- Account Type
- Currency
- Description
- Restriction (subsidiary assignments if restricted)

Save as: \`/migration/netsuite_extracts/01_chart_of_accounts.csv\`

**Transformation step**: Using the signed COA mapping worksheet, add a column to each row for the mapped Fusion Cloud Account Flexfield value. This becomes the lookup reference for all subsequent import steps.

### 2.2 Department Export

Navigate to **Lists > Accounting > Departments**.

Click **Export** > **CSV**. Save as: \`/migration/netsuite_extracts/02_departments.csv\`

Fields: Name, Subsidiary

**Transformation step**: Map each NetSuite Department name to its corresponding Fusion Cloud Cost Center segment value (or other designated segment per the Account Flexfield design).

### 2.3 Customer Extraction Saved Search

Navigate to **Reports > Saved Searches > New**.

- Record Type: Customer
- Name: MIGRATION_EXTRACT_CUSTOMERS

**Criteria tab:**
- Inactive: is False
- Subsidiary: is [target subsidiary — run once per subsidiary]

**Results tab — add the following columns:**
- Internal ID (required as the External ID reference in FBDI)
- Name
- Customer Number (or Auto-Generated Number)
- Primary Email
- Primary Phone
- Bill To: Address 1, Address 2, City, State, Zip, Country
- Ship To: Address 1, Address 2, City, State, Zip, Country
- Terms (payment terms)
- Currency
- Subsidiary
- Credit Limit

Click **Save & Run**. Export to CSV.

Save as: \`/migration/netsuite_extracts/03_customers_[subsidiary].csv\`

### 2.4 Vendor/Supplier Extraction Saved Search

Navigate to **Reports > Saved Searches > New**.

- Record Type: Vendor
- Name: MIGRATION_EXTRACT_VENDORS

**Criteria tab:**
- Inactive: is False
- Subsidiary: is [target subsidiary]

**Results tab:**
- Internal ID
- Company Name
- Vendor Number
- Email, Phone
- Address: Line 1, Line 2, City, State, Zip, Country
- Default Payment Terms
- Default Currency
- Tax ID / EIN
- 1099 Eligible (checkbox — maps to 1099 reporting in Fusion Cloud)
- Subsidiary

Export to CSV. Save as: \`/migration/netsuite_extracts/04_vendors_[subsidiary].csv\`

### 2.5 Item Extraction Saved Search

- Record Type: Item
- Name: MIGRATION_EXTRACT_ITEMS

**Criteria tab:**
- Is Inactive: is False
- Subsidiary: is [target subsidiary] OR is empty (shared items)

**Results tab:**
- Internal ID
- Name (Item Number)
- Display Name
- Description
- Type (Inventory Item, Non-Inventory, Service, Other Charge)
- Units of Measure
- Purchase Price
- Sales Price
- Income Account (GL account number)
- COGS Account
- Asset Account
- Tax Code (Purchase), Tax Code (Sales)

Export to CSV. Save as: \`/migration/netsuite_extracts/05_items.csv\`

### 2.6 GL Opening Balances

**NetSuite Trial Balance extraction:**

1. Navigate to **Reports > Financial > Balance Sheet**
   - Set date: last day of cutover period
   - Set subsidiary: run once per subsidiary
   - Display by: Account
   - Export to Excel

2. Navigate to **Reports > Financial > Income Statement**
   - Set date range: beginning of fiscal year through cutover date
   - Set subsidiary: same as above
   - Export to Excel

3. Consolidate both exports into a single GL balance file with columns:
   - NetSuite Account Number
   - NetSuite Account Name
   - Fusion Cloud Account Flexfield (from COA mapping worksheet — VLOOKUP)
   - Fusion Cloud Ledger Name (from subsidiary mapping)
   - Debit Balance (if normal debit balance)
   - Credit Balance (if normal credit balance)

Save as: \`/migration/netsuite_extracts/06_gl_opening_balances.xlsx\`

### 2.7 Open AR Invoice Extraction

- Record Type: Transaction
- Name: MIGRATION_EXTRACT_OPEN_AR

**Criteria tab:**
- Type: is Invoice
- Status: is Open
- Date: on or before [cutover date]
- Subsidiary: is [target subsidiary]

**Results tab:**
- Transaction Number (becomes the Invoice Number in Fusion Cloud)
- Name (Customer)
- Customer Internal ID
- Date, Due Date
- Currency
- Amount (original)
- Amount Remaining (the open balance to import)
- Memo / Description
- Subsidiary
- Department
- Class

Export to CSV. Save as: \`/migration/netsuite_extracts/07_open_ar.csv\`

> **For partially paid invoices**: use Amount Remaining as the import amount, not the original Amount. Add the original invoice number to the Memo field for audit trail.

### 2.8 Open AP Bill Extraction

- Record Type: Transaction
- Name: MIGRATION_EXTRACT_OPEN_AP

**Criteria tab:**
- Type: is Bill
- Status: is Open
- Date: on or before [cutover date]
- Subsidiary: is [target subsidiary]

**Results tab:**
- Transaction Number
- Vendor Name, Vendor Internal ID
- Date, Due Date
- Payment Terms
- Currency
- Amount (original)
- Amount Remaining
- Memo / Description
- Subsidiary
- Department

Export to CSV. Save as: \`/migration/netsuite_extracts/08_open_ap.csv\`

---

## Phase 3: Data Transformation

### 3.1 COA Mapping Validation

Before running any transformation, validate the COA mapping worksheet is complete:

1. Open \`/migration/netsuite_extracts/01_chart_of_accounts.csv\`
2. Open the COA mapping worksheet
3. VLOOKUP each NetSuite Account Number to confirm a Fusion Cloud flexfield value exists
4. Flag any account with no mapping — these must be resolved with the Controller before proceeding
5. Confirm all Fusion Cloud Account Flexfield values exist in the Fusion Cloud value sets (navigate to **Setup and Maintenance > Manage Chart of Accounts Value Sets** and verify each segment value)

### 3.2 Subsidiary to Fusion Cloud Mapping Table

Build this reference table and use it to populate the Legal Entity, Ledger, and Business Unit columns in every FBDI template:

| NetSuite Subsidiary | Fusion Cloud Legal Entity | Fusion Cloud Ledger | Fusion Cloud Business Unit |
|--------------------|--------------------------|---------------------|---------------------------|
| Vision Operations | Vision Operations Inc. | Vision US Primary Ledger | Vision US BU |
| Vision Services | Vision Services LLC | Vision US Primary Ledger | Vision Services BU |

### 3.3 Customer FBDI Transformation

Open the Customer FBDI template (from Oracle's FBDI template set for Fusion Cloud Financials).

Map NetSuite extracted fields to FBDI template columns:

| FBDI Column | NetSuite Source Field | Notes |
|------------|----------------------|-------|
| PARTY_ORIG_SYSTEM | Migration source name (e.g., NETSUITE) | Constant |
| PARTY_ORIG_SYSTEM_REFERENCE | Customer Internal ID | Becomes External ID for future reference |
| PARTY_NAME | Name | |
| ACCOUNT_ORIG_SYSTEM | Migration source name | Constant |
| ACCOUNT_ORIG_SYSTEM_REFERENCE | Customer Number | |
| CUSTOMER_NUMBER | Customer Number | |
| ADDRESS1 | Bill To: Address 1 | |
| CITY | Bill To: City | |
| STATE | Bill To: State | |
| POSTAL_CODE | Bill To: Zip | |
| COUNTRY | Bill To: Country | ISO 3166-1 alpha-2 code |
| ORG_UNIT_NAME | Business Unit name | From subsidiary mapping table |
| PAYMENT_TERM | Terms | Map to Fusion Cloud payment term name |
| CURRENCY_CODE | Currency | ISO 4217 code |

Save transformed file as: \`/migration/fbdi_ready/03_customers_fbdi.csv\`

### 3.4 Supplier FBDI Transformation

Open the Supplier FBDI template.

| FBDI Column | NetSuite Source Field | Notes |
|------------|----------------------|-------|
| VENDOR_ORIG_SYSTEM_REFERENCE | Vendor Internal ID | |
| VENDOR_NAME | Company Name | |
| VENDOR_NUM | Vendor Number | |
| VENDOR_TYPE_LOOKUP_CODE | 1099 Eligible → FEDERAL if True; FOREIGN if tax ID starts with EIN | Review individually |
| ADDRESS_LINE1 | Address: Line 1 | |
| CITY | Address: City | |
| STATE | Address: State | |
| ZIP | Address: Zip | |
| COUNTRY | Address: Country | ISO code |
| ORG_ID | Business Unit ID | From subsidiary mapping |
| PAYMENT_TERM_ID | Payment Terms | Map to Fusion Cloud payment term internal name |
| DEFAULT_CURRENCY_CODE | Currency | ISO 4217 |
| NUM_1099 | Tax ID / EIN | |

### 3.5 GL Journal FBDI Transformation

The GL opening balance journal is the most critical import. Every debit and credit must net to zero within each ledger.

Open the GL Journal Import FBDI template.

For each account balance row from Phase 2.6:

| FBDI Column | Value | Notes |
|------------|-------|-------|
| STATUS | NEW | |
| LEDGER_NAME | Fusion Cloud Ledger Name | From subsidiary mapping |
| ACCOUNTING_DATE | Last day of cutover period | e.g., 2026-06-30 |
| USER_JE_CATEGORY_NAME | Other | Or create a Migration category |
| USER_JE_SOURCE_NAME | Manual | |
| CURRENCY_CODE | USD (or transaction currency) | |
| SEGMENT1 through SEGMENT6 | Each segment of the Account Flexfield | From COA mapping |
| ENTERED_DR | Debit amount | For asset and expense accounts with positive balance |
| ENTERED_CR | Credit amount | For liability, equity, and revenue accounts |
| DESCRIPTION | MIGRATION OPENING BALANCE JUN-26 | Standard memo for all migration entries |

Validation before import:
\`\`\`
SUM(ENTERED_DR) must equal SUM(ENTERED_CR) across all rows for each ledger.
\`\`\`
Any imbalance is a blocker — the GL Import process will reject the batch.

---

## Phase 4: FBDI Import Execution

### 4.1 Upload Files to Fusion Cloud UCM

1. Navigate to **Tools > File Import and Export**
2. Click **Upload**
3. Select the FBDI zip file (package the CSV into a zip before uploading)
4. Account: \`/fin/generalLedger/import\` for GL, \`/fin/receivables/import\` for AR, \`/fin/payables/import\` for AP
5. Note the Document ID assigned after upload

### 4.2 Schedule the Import Process

Navigate to **Tools > Scheduled Processes > Schedule New Process**.

| Data Domain | Process Name | Parameters |
|------------|-------------|-----------|
| Customers | Import Trading Community Foundation Entities | UCM document ID, Purge Staging: No |
| Suppliers | Import Suppliers | UCM document ID |
| GL Journals | Import Journals | Ledger, Source: Manual, Category: Other |
| GL Post | Post Journals | Ledger, Period: cutover period |
| AR Invoices | AutoInvoice Import Program | Business Unit, Transaction Source: Migration |
| AP Invoices | Import Payables Invoices | Business Unit |
| AP Validate | Validate Payables Invoices | Business Unit |

Submit each process and note the Process ID for monitoring.

### 4.3 Monitor and Retrieve Error Logs

After each process completes:

1. Navigate to **Tools > Scheduled Processes > Search** by Process ID
2. Click the process name to open the details
3. Click **View Log** to see the import summary
4. Download the **output** file — this contains the detailed error report with row-level rejection messages
5. For any rejected rows: correct the source file, re-package, re-upload, and re-submit for the error rows only

**Import Error Log fields to focus on:**
- ROW_NUMBER: the CSV row that failed
- ERROR_MESSAGE: the specific rejection reason
- ORIG_SYSTEM_REFERENCE: the external ID of the failed record

Common errors:

| Error Message | Cause | Fix |
|--------------|-------|-----|
| Invalid payment term | Payment term in CSV does not match Fusion Cloud term name exactly | Verify term names in Fusion Cloud: Setup > Manage Payment Terms |
| Invalid account combination | Account Flexfield string references an invalid segment value | Check each segment value in Manage Chart of Accounts Value Sets |
| Duplicate customer number | Customer number already exists in Fusion Cloud | Confirm this is the same customer — merge or renumber |
| Invalid country code | NetSuite country code not in ISO 3166-1 alpha-2 format | Map country names to ISO codes before import |
| Ledger not found | Ledger name in GL journal does not match exactly | Verify ledger name spelling: Setup > Manage Primary Ledgers |

---

## Phase 5: Financial Reconciliation

### 5.1 Record Count Reconciliation

| Domain | NetSuite Count (Phase 1) | Fusion Cloud Count | Variance | Resolution |
|--------|------------------------|-------------------|---------|-----------|
| Customers | | | | |
| Suppliers | | | | |
| Items | | | | |
| Open AR — Invoice count | | | | |
| Open AR — Total balance | | | | |
| Open AP — Bill count | | | | |
| Open AP — Total balance | | | | |

**Fusion Cloud counts via OTBI (Oracle Transactional Business Intelligence):**

Navigate to **Reports and Analytics > Browse Catalog > My Folders** or the shared migration folder.

Create a simple OTBI analysis for each domain (Customers, Suppliers, AR Invoices with status Open, AP Invoices with status Unpaid).

Any variance in count or balance is a blocker. Trace the variance to specific records before proceeding to UAT.

### 5.2 GL Trial Balance Reconciliation

1. In Fusion Cloud: navigate to **General Accounting > Journals > Inquire and Reports > Trial Balance**
   - Ledger: [each ledger]
   - Period: cutover period
   - Currency: USD
   - Export to Excel

2. In NetSuite (already exported in Phase 2.6): open the Balance Sheet and Income Statement exports

3. VLOOKUP: match each Fusion Cloud account (using the COA mapping worksheet) to the corresponding NetSuite account balance

4. Compute variance for each account: NetSuite balance minus Fusion Cloud balance

**Acceptable tolerance**: Zero. Any non-zero variance must be investigated, corrected, and re-reconciled before UAT begins.

### 5.3 AR Aging Reconciliation

In Fusion Cloud: navigate to **Receivables > Manage Transactions > Reports > Aging — 7 Buckets by Account**.
- As-of date: cutover date
- Export to Excel

In NetSuite: run the A/R Aging Detail Saved Search with cutover date as the as-of date.

Match invoice-by-invoice for the top 20 highest-balance open invoices. Verify:
- Invoice number matches (or maps via the migration memo field)
- Customer name matches
- Open balance matches
- Due date matches

### 5.4 AP Aging Reconciliation

In Fusion Cloud: navigate to **Payables > Reports > Aging**.
In NetSuite: run the A/P Aging Detail Saved Search.

Same matching procedure as AR — invoice-by-invoice for the top 20 balances.

---

## Phase 6: UAT Test Cases

Run all UAT test cases in the Fusion Cloud Test environment with a full data load before running them in production.

### Test 1: Order-to-Cash with Migrated Customer

- [ ] Navigate to **Order Management > Orders > Create Order** (if Order Cloud in scope) or **Receivables > Create Transaction > Invoice**
- [ ] Search for a customer imported from NetSuite (search by Customer Number = NetSuite Internal ID)
- [ ] Create invoice with a line item
- [ ] Complete the invoice (click Complete or Submit)
- [ ] Confirm the Subledger Accounting journal is created
- [ ] Navigate to the journal: verify AR account debited and Revenue account credited
- [ ] Confirm the GL account strings match the COA mapping worksheet for the line item's revenue account

### Test 2: Supplier Invoice and Payment

- [ ] Navigate to **Payables > Invoices > Create Invoice**
- [ ] Select a supplier imported from NetSuite
- [ ] Add an invoice line with an expense distribution
- [ ] Validate and account the invoice
- [ ] Confirm the journal: Expense account debited, AP account credited
- [ ] Process a payment run
- [ ] Confirm the payment journal: AP account debited, Bank account credited

### Test 3: Period Close

- [ ] Navigate to **General Accounting > Period Close > Open/Close Periods**
- [ ] Close the cutover period
- [ ] Navigate to **Reports > Trial Balance** for the closed period
- [ ] Confirm the Trial Balance matches the pre-UAT reconciliation output (Phase 5.2)
- [ ] Confirm the balance sheet balances (Total Assets = Total Liabilities + Equity)

### Test 4: AR Payment Application

- [ ] Navigate to **Receivables > Receipts > Create Receipt**
- [ ] Apply the receipt to a migrated open invoice
- [ ] Confirm the invoice status changes to Closed
- [ ] Confirm the AR account balance decrements by the applied amount
- [ ] Run the AR Aging report — confirm the closed invoice no longer appears

### Test 5: Intercompany (if multiple legal entities)

- [ ] Create an intercompany transaction between two legal entities mapped from NetSuite subsidiaries
- [ ] Run the Intercompany Reconciliation process
- [ ] Confirm elimination entries are generated in the consolidation ledger
- [ ] Confirm the intercompany accounts net to zero on the consolidated Trial Balance

---

## Phase 7: Cutover Sequence

| Day | Action | Owner | Verification |
|-----|--------|-------|-------------|
| D-5 | Final NetSuite data extraction (customers, vendors, items) | Migration Lead | Record counts match assessment |
| D-3 | Freeze NetSuite — no new transactions after cutover date | NetSuite Admin | Notify all users; disable transaction entry roles |
| D-3 | Final NetSuite Trial Balance extraction | Controller | PDF signed and dated |
| D-2 | Final open AR and AP extraction from NetSuite | Migration Lead | Counts match assessment |
| D-2 | Load final GL opening balances to Fusion Cloud | Migration Lead | GL trial balance reconciles |
| D-2 | Load final open AR invoices | Migration Lead | AR aging reconciles |
| D-2 | Load final open AP bills | Migration Lead | AP aging reconciles |
| D-1 | Full UAT sign-off confirmation | Project Manager | All signatures obtained |
| D-1 | Fusion Cloud user accounts and roles activated | IT Admin | Each user logs in and confirms access |
| D-0 | Go-live — Fusion Cloud is system of record | All | First production transaction entered and posted |
| D+1 | Post-go-live reconciliation: AR aging, AP aging, GL | Controller | Any variance opened as P1 incident |
| D+5 | First week review: all transaction types confirmed working | All stakeholders | Week 1 signoff meeting |

---

## Common Migration Failure Patterns

| Failure | Root Cause | Prevention |
|---------|-----------|-----------|
| GL opening balance journal rejected | Debits do not equal credits within the ledger | Sum DR and CR in Excel before FBDI packaging |
| Customers imported to wrong Business Unit | Subsidiary mapping table had an error | Validate subsidiary-to-BU mapping before Customer FBDI run |
| AR invoices fail AutoInvoice | Transaction source not configured in Fusion Cloud | Set up Transaction Source in Receivables Setup before AR FBDI |
| Supplier invoices not matching expected AP balance | Partially paid bills imported at original amount | Import Amount Remaining, not original Amount |
| Account flexfield string rejected | Segment value does not exist in the value set | Validate all flexfield values against Manage Value Sets before GL import |
| COA mapping gap discovered post-import | New accounts found in open transactions not in mapping worksheet | Run a pre-import unique account query across all open AR/AP rows and reconcile to mapping worksheet |
| Payment terms not matching | NetSuite term name differs from Fusion Cloud term name | Build a payment term lookup table as part of transformation; verify all unique terms before FBDI run |`,
};

async function main() {
  console.log('Inserting NetSuite to Fusion Cloud ERP migration runbook...');
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
