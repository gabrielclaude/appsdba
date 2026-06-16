import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: NetSuite Configuration Sequence — Phase-by-Phase Setup, Verification, and Pre-Go-Live Audit',
  slug: 'netsuite-configuration-sequence-runbook-verification-audit',
  excerpt:
    'Step-by-step NetSuite configuration runbook covering all five setup phases: company information and feature activation, COA and financial dimensions, item master account mapping, entity and relationship setup, and forms/workflows/roles. Each phase includes a verification checklist, common mistakes to avoid, and a pre-go-live audit procedure using SuiteScript and Saved Searches to confirm every layer is correctly configured before the next phase begins.',
  category: 'netsuite' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-15'),
  youtubeUrl: null,
  content: `## Scope

This runbook provides a phased, verifiable approach to configuring a NetSuite environment from scratch. It applies to new implementations (greenfield), fresh sandbox builds for testing, and re-implementation projects where a previous configuration needs to be rebuilt cleanly. Each phase ends with a verification checklist that must pass before the next phase begins.

**Important:** All configuration should be completed and verified in a Sandbox account before being replicated in Production. NetSuite sandboxes can be refreshed from production at any time — use them aggressively.

---

## Phase 1: Company Information and Feature Activation

### 1.1 Set Company Information

Navigate to **Setup > Company > Company Information**

Required fields to populate before proceeding:

\`\`\`
□ Legal Name (as it appears on tax filings and contracts)
□ Address (registered business address for tax purposes)
□ Base Currency (CRITICAL — cannot be changed after transactions exist)
□ Default Time Zone
□ Fiscal Year Start Month
□ Tax ID / EIN (if applicable)
□ Logo (used on printed transaction forms)
\`\`\`

**Base currency decision:** In a multi-subsidiary environment, the base currency set here is the reporting currency for the parent subsidiary. All other currencies will be converted to this currency for consolidated reporting. Choose carefully — changing this after any transaction is saved requires a full system re-implementation.

### 1.2 Configure Subsidiaries (Multi-Subsidiary / OneWorld only)

Navigate to **Setup > Company > Subsidiaries > New**

For each legal entity:
\`\`\`
□ Subsidiary Name (legal entity name)
□ Country
□ Currency
□ Address (legal registered address)
□ Tax Registration Number
□ Fiscal Calendar (if different from parent)
□ Intercompany relationship (if applicable)
\`\`\`

Establish the subsidiary hierarchy before creating any accounts, items, or entities. Subsidiaries cannot be deleted once transactions reference them.

### 1.3 Enable Features (MVP Only)

Navigate to **Setup > Company > Enable Features**

Enable only the features required for the first operational workflow. Recommended MVP feature set for a standard implementation:

**Accounting tab:**
\`\`\`
□ Advanced Revenue Management — only if your revenue model requires deferred/recognized revenue
□ Multi-Currency — only if transacting in more than one currency
□ Multiple Budgets — only if managing budgets in NetSuite
□ Intercompany Management — only if subsidiaries transact with each other
\`\`\`

**Inventory tab:**
\`\`\`
□ Inventory Management — if tracking physical inventory
□ Bin Management — only if tracking inventory at bin/shelf level
□ Lot Tracking / Serial Tracking — only if tracking individual units
□ Units of Measure — if purchasing and selling in different units
\`\`\`

**CRM tab:**
\`\`\`
□ Customer Relationship Management — only if using NetSuite as CRM
□ Partner Relationship Management — only if managing partner portals
\`\`\`

**SuiteCloud tab:**
\`\`\`
□ SuiteFlow (Workflow) — enable immediately; needed for approval routing
□ SuiteScript — enable if custom scripting is planned
□ Custom Records — enable if custom data objects are needed
□ Custom Segments — enable immediately; needed before COA is finalized
\`\`\`

### 1.4 Phase 1 Verification Checklist

\`\`\`
□ Company Information saved and visible on Setup > Company > Company Information
□ Base Currency confirmed correct and matches tax reporting requirements
□ All required subsidiaries created and hierarchy is correct
  □ Parent subsidiary has base currency set
  □ Child subsidiaries have correct local currency and address
□ Features enabled match the MVP requirements document (no extras)
□ SuiteFlow and Custom Segments are enabled
□ Sandbox and Production have identical feature sets (verify after sandbox refresh)
\`\`\`

---

## Phase 2: Chart of Accounts and Financial Dimensions

### 2.1 Design the Chart of Accounts

**Before creating accounts in NetSuite**, finalize the account list in a spreadsheet. Map each account to:
- Account Type (Asset, Liability, Equity, Income, Expense, Other Income, Other Expense, COGS)
- Account Number (numeric, sequential within type — e.g., 1000s for Assets, 2000s for Liabilities)
- Description
- Subsidiary (which subsidiaries use this account)
- Currency (if multi-currency — most accounts should be all currencies)

**COA design rules:**
\`\`\`
□ No segmented account numbers (1000-01-DEPT is wrong — use dimensions instead)
□ One account per natural category (one Software Revenue, not one per department)
□ Parent/summary accounts are optional but useful for financial statement mapping
□ Retained Earnings account must exist before the fiscal year can be closed
\`\`\`

### 2.2 Create Accounts in NetSuite

Navigate to **Setup > Accounting > Chart of Accounts > New**

For each account:
\`\`\`
□ Account Number
□ Account Name
□ Type (must match your spreadsheet)
□ Currency (All or specific)
□ Subsidiary (select all applicable)
□ Description
□ Parent Account (if creating a summary hierarchy)
\`\`\`

**Import option:** For accounts > 20, use the CSV Import Assistant:
**Setup > Import/Export > Import CSV Records > Type: Accounts**

Validate the import against your design spreadsheet before proceeding.

### 2.3 Configure Financial Dimensions

**Departments:**
Navigate to **Setup > Company > Departments > New**
\`\`\`
□ Create all departments (cost centers)
□ Set subsidiary for each department
□ Create parent departments for rollup reporting if needed
\`\`\`

**Classes:**
Navigate to **Setup > Company > Classes > New**
\`\`\`
□ Create product lines, revenue streams, or business segments
□ Set subsidiary for each class
\`\`\`

**Locations:**
Navigate to **Setup > Company > Locations > New**
\`\`\`
□ Create all warehouses, offices, and virtual locations
□ Set address for each location (used for shipping/tax)
□ Set subsidiary for each location
\`\`\`

**Custom Segments (if needed):**
Navigate to **Customization > Lists, Records & Fields > Custom Segments > New**
\`\`\`
□ Define the segment name and values
□ Apply to the correct transaction types (which forms use this segment)
□ Set as mandatory or optional per form
□ Test that the segment appears correctly on a test transaction in sandbox
\`\`\`

### 2.4 Phase 2 Verification Checklist

\`\`\`
□ Account count matches the approved COA design document
□ All account types are correct (verify with: Lists > Accounting > Accounts, sort by Type)
□ No duplicate account numbers
□ Retained Earnings account exists (required for period close)
□ All departments, classes, and locations are created
□ Each dimension has the correct subsidiary assignment(s)
□ Custom segments appear on the correct transaction forms (test in sandbox)
□ A test journal entry can be posted with all required dimensions populated
□ Financial statements render correctly for the test JE:
  □ Balance Sheet
  □ Income Statement
  □ Trial Balance
\`\`\`

---

## Phase 3: Item Master

### 3.1 Design the Item Account Mapping Matrix

Before creating items, produce an account mapping matrix in a spreadsheet:

| Item Type | Income Account | Asset/Inventory Account | COGS Account | Expense Account |
|-----------|---------------|------------------------|--------------|-----------------|
| Inventory Item | [Revenue acct] | [Inventory asset acct] | [COGS acct] | — |
| Non-Inventory (Purchase) | — | — | — | [Expense acct] |
| Non-Inventory (Sale) | [Revenue acct] | — | — | — |
| Service (Sale) | [Revenue acct] | — | — | — |
| Other Charge | [Revenue or Expense] | — | — | — |

Have the Controller or CFO sign off on this matrix before creating items. Changing it after transactions exist requires a complex remediation.

### 3.2 Configure Units of Measure (if enabled)

Navigate to **Lists > Accounting > Units of Measure > New**

\`\`\`
□ Create base units for each unit type (EA, LB, FT, etc.)
□ Create UOM schedules with conversion ratios for items that buy/sell in different units
□ Example: Cases (purchase) → Each (sale), ratio = 12
□ Assign base unit to each UOM schedule
□ Test conversion: create a test PO and verify the unit conversion calculates correctly
\`\`\`

### 3.3 Create Items

Navigate to **Lists > Accounting > Items > New** (or use CSV Import for bulk)

For each item, verify:
\`\`\`
□ Item Name/Number (must be unique)
□ Item Type (Inventory, Non-Inventory, Service, Other Charge)
□ Subsidiary
□ Income Account (mapped from the matrix)
□ Asset/Inventory Account (for Inventory Items only)
□ COGS Account (for Inventory Items only)
□ Expense Account (for expense items)
□ UOM / Purchase Unit / Sale Unit (if UOM feature is active)
□ Reorder Point and Preferred Quantity (if using demand planning)
□ Preferred Vendor (if using replenishment)
□ Tax Schedule (if applicable)
\`\`\`

### 3.4 Validate Item Postings

Before loading production items, test the posting behavior with representative items in sandbox:

\`\`\`
Test 1: Create a Sales Order for an Inventory Item → Save → View GL Impact
  □ Confirm no GL impact on SO (orders are non-posting in standard NetSuite)

Test 2: Create an Item Receipt for the Inventory Item
  □ Confirm: DR Inventory Asset, CR Accounts Payable (or Accrued Liability)

Test 3: Create an Invoice for the Inventory Item
  □ Confirm: DR Accounts Receivable, CR Revenue
  □ Confirm: DR COGS, CR Inventory Asset

Test 4: Create a Vendor Bill for a Non-Inventory Expense Item
  □ Confirm: DR Expense Account, CR Accounts Payable
\`\`\`

If any posting is wrong, correct the item account mapping before proceeding. Do not move to Phase 4 with unvalidated item postings.

### 3.5 Phase 3 Verification Checklist

\`\`\`
□ Item count matches the approved item list
□ All items have income/COGS/asset accounts mapped (verify via Saved Search: Items with blank Income Account)
□ UOM conversions tested and confirmed correct
□ All four posting tests passed in sandbox
□ No items assigned to wrong account type (e.g., revenue account on an expense item)
□ Item list exported to spreadsheet and reviewed by Controller
\`\`\`

**Saved Search to find unmapped items:**

Navigate to **Reports > Saved Searches > All Saved Searches > New > Item**
Add filter: Income Account is empty OR COGS Account is empty (for Inventory Items)
Run and resolve all results before proceeding.

---

## Phase 4: Entities — Customers, Vendors, and Partners

### 4.1 Design Entity Forms

Before importing entities, customize the entity forms to include only required fields. Navigate to:
- **Customization > Forms > Entity Forms** (for Customer forms)
- **Customization > Forms > Vendor Forms**

\`\`\`
□ Remove unused fields from the main tab
□ Make required fields mandatory (Name, Subsidiary, Currency, Terms, Tax ID)
□ Add custom fields if business requires non-standard data on entity records
□ Create separate form variants for domestic vs. international entities if needed
\`\`\`

### 4.2 Import Customers

Use **Setup > Import/Export > Import CSV Records > Type: Customers**

Required fields per customer record:
\`\`\`
□ Company Name (or Individual Name for individual customers)
□ Subsidiary
□ Currency (must match an active currency in the system)
□ Payment Terms
□ Tax Status / Tax Item
□ Billing Address
□ Shipping Address (if different)
□ Parent Customer (if this is a sub-customer in a hierarchy)
□ Accounts Receivable Account (leave blank to use subsidiary default)
\`\`\`

### 4.3 Import Vendors

Use **Setup > Import/Export > Import CSV Records > Type: Vendors**

Required fields per vendor record:
\`\`\`
□ Company Name
□ Subsidiary
□ Currency
□ Payment Terms
□ Default Expense Account (used on Vendor Bills when no item is specified)
□ Tax ID / 1099 eligibility (for US vendors)
□ Billing Address (where checks/ACH are sent)
□ Accounts Payable Account (leave blank to use subsidiary default)
\`\`\`

### 4.4 Establish Customer Hierarchies

For parent-child customer structures:
\`\`\`
□ Create the parent customer record first (top of hierarchy)
□ Create sub-customer records with Parent Customer field set
□ Confirm that the billing account consolidates at the parent level
□ Test: create a transaction on a sub-customer and verify it rolls up to the parent in reports
\`\`\`

### 4.5 Phase 4 Verification Checklist

\`\`\`
□ Customer count matches the approved customer list
□ Vendor count matches the approved vendor list
□ All entities assigned to correct subsidiary
□ All multi-currency entities have the correct currency set
□ Parent-child hierarchies display correctly (check: Lists > Relationships > Customers, group by Parent)
□ Test transaction: create a draft Invoice for a customer, confirm AR account and subsidiary are correct
□ Test transaction: create a draft Vendor Bill, confirm AP account and subsidiary are correct
□ No duplicate entity records (run: Customers Saved Search, group by Name, filter Count > 1)
\`\`\`

---

## Phase 5: Forms, Workflows, and Role-Based Security

### 5.1 Customize Transaction Forms

Navigate to **Customization > Forms > Transaction Forms**

For each primary transaction type (Sales Order, Invoice, Purchase Order, Vendor Bill, Item Receipt, Journal Entry):
\`\`\`
□ Clone the standard form (do not modify standard forms directly)
□ Remove fields not used in your business process
□ Set required fields as mandatory
□ Reorder fields for logical data entry flow
□ Create role-specific variants if different users need different views
□ Set the customized form as the Preferred form for the relevant role
\`\`\`

### 5.2 Build Approval Workflows in SuiteFlow

Navigate to **Customization > Workflow > Workflows > New**

For each approval workflow (e.g., Purchase Order Approval):
\`\`\`
□ Define the trigger (record type: Purchase Order, event: Before Record Submit)
□ Add condition (Amount > 10,000)
□ Add action: Set Approval Status to Pending Approval
□ Add action: Send Email to Approver
□ Define the Approved state and the Rejected state
□ Test with a test PO in sandbox:
  □ PO below threshold: saves without routing
  □ PO above threshold: routes to approver, cannot be approved by submitter
  □ Approved PO: can proceed to receipt and bill matching
  □ Rejected PO: returns to submitter with reason
\`\`\`

### 5.3 Create Custom Roles

Navigate to **Setup > Users/Roles > Manage Roles**

For each user type:
\`\`\`
□ Find the closest standard role (Accountant, A/R Clerk, Warehouse Manager, etc.)
□ Click Customize to clone it into a custom role
□ Rename with a clear convention (e.g., "ACME — Accounts Receivable Clerk")
□ Audit the Permissions tab:
  □ Remove any permission not required for this role's job function
  □ Add any permission that is required but missing
  □ Set permission levels (View, Create, Edit, Full) appropriately
□ Design a role-specific Dashboard:
  □ Add Saved Searches for the role's primary data (open invoices, unposted receipts, etc.)
  □ Add KPI tiles for metrics the role monitors
  □ Remove portlets that are irrelevant to the role
□ Test the role: assign to a test user, log in as that user, and verify:
  □ Can see and perform all required transactions
  □ Cannot see or perform restricted transactions
  □ Dashboard shows relevant data
\`\`\`

### 5.4 Assign Roles to Users

Navigate to **Setup > Users/Roles > Manage Users**

\`\`\`
□ Assign only custom roles (no standard roles in production)
□ Each user should have the minimum role(s) required for their job
□ Verify no user has both an AP role and an Approver role (segregation of duties)
□ Verify no user has both a Payroll role and a GL role (segregation of duties)
□ Document the role assignment matrix and have it signed off by management
\`\`\`

### 5.5 Phase 5 Verification Checklist

\`\`\`
□ All primary transaction forms are customized (not standard)
□ All approval workflows pass the four-state test (below threshold / above threshold / approved / rejected)
□ No standard roles assigned to production users
□ Segregation of duties matrix documented and approved
□ Each role tested by logging in as a user with that role
□ Role-specific dashboards show relevant KPIs and Saved Searches
□ User access provisioning process documented for onboarding new users
\`\`\`

---

## Pre-Go-Live Audit Procedure

Run this complete audit in the sandbox using production-equivalent data before scheduling a go-live date.

### Audit 1: Account Mapping Completeness

Navigate to **Reports > Saved Searches > All Saved Searches > New > Item**

Create a Saved Search with these results columns:
- Item Name
- Item Type
- Income Account
- COGS Account
- Asset Account
- Expense Account

Add filter: **Type is any of** [Inventory Item, Non-Inventory Item, Service Item, Other Charge Item]

Export to CSV and verify:
\`\`\`
□ No Inventory Items have blank COGS Account
□ No Inventory Items have blank Asset/Inventory Account
□ No Revenue items have blank Income Account
□ No Expense items have blank Expense Account
\`\`\`

### Audit 2: Entity Subsidiary and Currency Validation

Saved Search > Customers:
\`\`\`
□ All customers have Subsidiary populated
□ All customers have Currency populated
□ No customers have Subsidiary that doesn't match their expected operating entity
\`\`\`

### Audit 3: End-to-End Transaction Flow Test

Execute a complete procure-to-pay and order-to-cash cycle in sandbox:

**Order-to-Cash:**
\`\`\`
□ Create Sales Order → Save → Verify: no GL impact
□ Create Item Fulfillment from SO → Save → Verify: DR COGS, CR Inventory
□ Create Invoice from SO → Save → Verify: DR AR, CR Revenue
□ Create Customer Payment → Apply to Invoice → Save → Verify: DR Cash, CR AR
□ All four posting entries match the account mapping matrix
\`\`\`

**Procure-to-Pay:**
\`\`\`
□ Create Purchase Order → Save → Verify: no GL impact
□ Create Item Receipt from PO → Save → Verify: DR Inventory, CR Accrued Liability
□ Create Vendor Bill → Match to PO/Receipt → Save → Verify: DR Accrued Liability, CR AP
□ Create Vendor Payment → Apply to Bill → Save → Verify: DR AP, CR Cash
\`\`\`

### Audit 4: Period Close Readiness

\`\`\`
□ All accounting periods are set up through end of current fiscal year
□ Retained Earnings account exists and is mapped in the accounting preferences
□ At least one test period close completed successfully in sandbox
□ Period lock procedure is documented (who closes periods, in what order)
□ Financial statements (Balance Sheet, P&L) reconcile to the test transaction data
\`\`\`

### Audit 5: Security and Compliance Review

\`\`\`
□ No production users assigned to standard roles
□ Segregation of duties matrix reviewed by management
□ Administrator role assigned to no more than 2 named individuals
□ All custom roles documented with the permissions they include and exclude
□ Password policy configured (Setup > Company > General Preferences > Security)
□ Two-factor authentication enabled for Administrator and high-privilege roles
\`\`\`

---

## Go-Live Sequence

If all five phases and all five audits pass, proceed in this order:

\`\`\`
Day 1 — Go-Live Preparation:
  □ Sandbox refresh from a clean state (or production clone if available)
  □ Final pre-go-live audit passes in sandbox
  □ All configuration documented and reviewed

Day 2 — Production Configuration:
  □ Replicate all Phase 1–5 configuration in production
  □ Do NOT import live data yet
  □ Run Audit 1–5 in production (no data — verify structure only)

Day 3 — Data Migration:
  □ Import Chart of Accounts
  □ Import Items
  □ Import Customers and Vendors
  □ Post opening balances (journal entries)
  □ Verify Trial Balance matches legacy system's closing trial balance

Day 4 — User Onboarding:
  □ Assign roles to all production users
  □ Each user logs in and confirms dashboard is correct
  □ First live transactions processed and verified by Controller
\`\`\`

---

## Common Mistakes and How to Avoid Them

| Mistake | Impact | Prevention |
|---------|--------|-----------|
| Setting base currency incorrectly | Full re-implementation required | Confirm with CFO before saving Company Information |
| Enabling features before their dependencies exist | UI confusion, broken transaction forms | Enable features in phases with supporting config ready |
| Creating items before COA is finalized | Mass re-mapping exercise | Complete Phase 2 sign-off before starting Phase 3 |
| Using standard roles in production | Over-privileged users, audit findings | Clone and customize before assigning any user |
| Importing legacy data without deduplication | Duplicate entities, orphaned records | Scrub data with a dedup tool before CSV import |
| Building workflows in production first | Workflow fires on real transactions during testing | Build and test all workflows in sandbox only |
| Skipping the end-to-end posting test | Wrong postings discovered after go-live | Audit 3 is mandatory — do not skip it |`,
};

async function main() {
  console.log('Inserting NetSuite configuration runbook...');
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
