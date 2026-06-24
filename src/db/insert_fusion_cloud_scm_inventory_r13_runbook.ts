import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Fusion Cloud SCM Inventory R13: Implementation Runbook, FBDI Data Loading, and Monitoring Scripts',
  slug: 'oracle-fusion-cloud-scm-inventory-r13-runbook',
  excerpt:
    'Step-by-step runbook for configuring Oracle Fusion Cloud SCM Inventory R13 — enterprise structure, inventory organisations, Product Hub FBDI item load, on-hand balance migration, cost accounting setup, transaction type configuration, REST API integration, and crontab-scheduled monitoring scripts for ESS job health, pending transactions, and integration errors.',
  category: 'fusion-cloud-scm' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-24'),
  youtubeUrl: null,
  content: `## Overview

This runbook covers the step-by-step configuration procedure for Oracle Fusion Cloud SCM Inventory R13 from initial tenant setup through production readiness. It follows the implementation sequencing outlined in the companion blog post: enterprise structure first, then organisations, then item master, then cost accounting, then on-hand migration, then transaction types and integrations. Each phase includes the specific navigation path in the Fusion Cloud UI, the key configuration decisions, and the validation check to confirm the step is complete before proceeding.

Monitoring scripts are provided at the end as a crontab-driven operations framework for day-two support.

---

## Phase 1: Enterprise Structure

Enterprise structure must exist before any inventory configuration. If the tenant is new, complete this phase first. If enterprise structure was set up during a Financials or Procurement implementation, verify it matches the inventory requirements before proceeding.

### 1.1 Verify Legal Entity and Ledger

**Navigation**: Setup and Maintenance → Manage Legal Entities

Confirm:
- The Legal Entity that will own the inventory organisations exists
- It has a valid Primary Ledger assigned (Chart of Accounts, Accounting Calendar, Currency)
- The Ledger period for the go-live month is open (or will be opened before the first transaction)

**Validation query** — run in OTBI or via REST:
\`\`\`
Navigator → Reports and Analytics → Financial Reporting → run a Ledger Period Status report
Confirm the go-live period is Open or Future-Entry for the target Ledger.
\`\`\`

### 1.2 Create or Verify Business Unit

**Navigation**: Setup and Maintenance → Manage Business Units

Each inventory organisation will be owned by a Business Unit. The BU controls:
- Which Ledger is used for financial accounting of inventory transactions
- Which Procurement BU submits purchase orders (may differ from the inventory BU)

For most single-company implementations, one BU owns all inventory organisations. Multi-company or intercompany setups require one BU per Legal Entity per currency.

Required BU function assignments for inventory:
| Function | Required |
|----------|---------|
| Inventory | Yes — enables inventory transaction processing |
| Receiving | Yes — enables inbound transactions |
| Materials Management | Yes — enables transfer orders and shipping |
| Procurement (optional) | Only if this BU also submits POs |

**Navigation to assign BU functions**: Setup and Maintenance → Manage Business Unit Set Assignments

---

## Phase 2: Reference Data Sets

Reference Data Sets (Set Codes) control which reference data is shared across Business Units. Fusion uses Set Codes to partition units of measure, transaction types, item catalogue categories, and other reference objects so that some can be shared globally while others are BU-specific.

**Navigation**: Setup and Maintenance → Manage Reference Data Sets

For most implementations, create two sets:
- **COMMON**: shared across all BUs — units of measure, global item catalogue categories
- **\`<BU_NAME>\`_SET**: BU-specific transaction types and lookup codes

**Assign sets to BU**: Setup and Maintenance → Manage Business Unit Set Assignments → assign COMMON to the UOM determinant, BU-specific set to transaction types.

---

## Phase 3: Inventory Organisations

### 3.1 Create Inventory Organisation

**Navigation**: Setup and Maintenance → Manage Inventory Organizations

Click Create. Required fields:

| Field | Value |
|-------|-------|
| Name | Descriptive name (e.g., CENTRAL_WAREHOUSE) |
| Code | Short code, max 3 characters (e.g., CW1) — cannot be changed after first transaction |
| Business Unit | BU from Phase 1 |
| Legal Entity | Auto-populated from BU; verify it is correct |
| Item Master Organization | The master org (first org created, or the designated master) |
| Calendar | Must match the Ledger calendar |
| Costing Method | Set in Phase 6 via Cost Org — leave blank here; it is inherited |

### 3.2 Create Subinventories

**Navigation**: Inventory → Manage Subinventories → Create

Create subinventories for each logical zone in the warehouse:

| Subinventory | Type | Nettable | Reservable | Notes |
|-------------|------|---------|-----------|-------|
| FG | Storable | Yes | Yes | Finished goods available for order fulfilment |
| RAW | Storable | Yes | Yes | Raw material for manufacturing |
| WIP | Storable | Yes | No | WIP staging — not directly reservable |
| RETURNS | Storable | No | No | Customer returns pending inspection |
| HOLD | Storable | No | No | Quality hold — excluded from supply planning |
| RECEIVING | Receiving | No | No | Auto-created; dock area for 2-step receipts |

Nettable = included in supply planning net available quantity.
Reservable = can have sales order reservations placed against it.

### 3.3 Configure Locators (Optional)

If WMS-level bin tracking is required:

**Navigation**: Inventory → Manage Locators

Enable locator control on the subinventory first (Subinventory form → Locator Control = Prespecified or Dynamic Entry).

Create locators in the format: \`<AISLE>-<RACK>-<BIN>\` (e.g., A-01-001). For large warehouses, use the bulk locator creation tool (Actions → Create Multiple Locators).

---

## Phase 4: Units of Measure

**Navigation**: Setup and Maintenance → Manage Units of Measure

### 4.1 Create UOM Classes

UOM Classes group compatible units. Create classes before individual UOMs:

| Class | Base Unit | Example Units |
|-------|---------|---------------|
| Weight | KG | KG, LB, G, OZ, MT |
| Volume | L | L, ML, GAL, FL_OZ, M3 |
| Each | EA | EA, DOZEN, GROSS |
| Length | M | M, CM, FT, IN |
| Time | HR | HR, MIN, DAY |

### 4.2 Create UOM Conversions

For units in the same class, define the conversion factor:
\`\`\`
1 LB = 0.453592 KG
1 GAL = 3.785411 L
1 DOZEN = 12 EA
\`\`\`

**Navigation**: Setup and Maintenance → Manage UOM Conversions

---

## Phase 5: Product Hub — Item Classes and Attribute Groups

### 5.1 Create Item Classes

**Navigation**: Product Management → Product Information Management → Manage Item Classes

Item Class hierarchy example for a discrete manufacturer:

\`\`\`
Root
  ├── Purchased Item
  │     ├── Purchased Component
  │     └── Purchased Consumable
  ├── Manufactured Item
  │     ├── Assembly
  │     └── Subassembly
  └── Service Item
        └── Labour
\`\`\`

For each Item Class, configure:
- **Lifecycle**: the allowed lifecycle phases (prototype, production, obsolete)
- **Attribute Groups**: which attribute groups are mandatory vs optional
- **Default values**: default UOM, tracking type defaults

### 5.2 Item Attribute Groups

Key attribute groups and whether they are master-level or org-level:

| Attribute Group | Level | Key Attributes |
|----------------|-------|----------------|
| Main | Master | Description, Primary UOM, Item Class |
| Inventory | Org | Inventory Item flag, Transactable, Tracking (lot/serial) |
| Purchasing | Org | Purchasable, Buyer, Lead time |
| Costing | Org | Costing Enabled, Inventory Asset Value |
| Planning | Org | MRP Planning, Safety Stock, Min/Max quantities |
| Order Management | Org | Customer Ordered, Shippable, Returnable |

---

## Phase 6: Cost Accounting Setup

Cost accounting must be configured before loading on-hand balances. On-hand balances without cost accounting have no financial value.

### 6.1 Create Cost Organisation

**Navigation**: Setup and Maintenance → Manage Cost Organizations

A Cost Organisation maps to one or more Inventory Organisations. It defines the costing method for all orgs within its scope.

| Field | Value |
|-------|-------|
| Name | Descriptive (e.g., CENTRAL_COST_ORG) |
| Business Unit | Same BU as inventory orgs |
| Costing Method | Perpetual Average, Standard, or Actual (FIFO) |
| Cost Calendar | Must match the Ledger accounting calendar |

### 6.2 Assign Inventory Organisations to Cost Organisation

**Navigation**: Setup and Maintenance → Manage Cost Organization Relationships

Assign each inventory org to exactly one cost organisation.

### 6.3 Configure Account Derivation Rules (Subledger Accounting)

**Navigation**: Accounting → Subledger Accounting → Manage Accounting Methods

Fusion uses the Subledger Accounting (SLA) framework to derive General Ledger accounts for inventory transactions. Out of the box, Fusion provides a default accounting method. For most implementations, the default method is a valid starting point — customise only the account derivation rules that differ from the defaults.

Key account assignments required:

| Account | Description |
|---------|-------------|
| Inventory Valuation | Balance sheet inventory asset account |
| Receiving Inspection | Clearing account between receipt and AP match |
| Invoice Price Variance (IPV) | P&L account — difference between PO price and standard cost |
| Material Usage Variance | P&L — consumption at standard vs actual BOM |
| Cycle Count Adjustment | P&L — inventory adjustments from cycle counts |
| Intercompany COGS | For transfer orders crossing BUs |

### 6.4 Define Standard Costs (Standard Costing only)

If using standard costing:

**Navigation**: Cost Accounting → Cost Scenarios → Create Cost Scenario

A cost scenario calculates standard costs for all items. Steps:
1. Create a new scenario with effective date = start of period
2. Add items or run auto-population to include all inventory-enabled items
3. Enter or import rolled costs (purchased item cost = most recent PO price or agreed standard; manufactured item cost = BOM + routing rollup)
4. Publish the scenario to make costs effective

---

## Phase 7: Item Master FBDI Load

The FBDI item load has three sequential steps. Each step must complete successfully before the next begins.

### 7.1 Download FBDI Templates

**Navigation**: Navigator → Tools → File-Based Data Import → Download Templates

Download:
- **EGP_ITEMS_TEMPLATE.xlsm** — master-level item attributes
- **EGP_ITEM_RELATIONSHIPS_TEMPLATE.xlsm** — item-organisation assignments
- **INV_EGP_ITEM_ORGS_TEMPLATE.xlsm** — org-level item attributes

### 7.2 Prepare Item Master File

\`EGP_ITEMS_TEMPLATE.xlsm\` — key columns:

| Column | Required | Notes |
|--------|---------|-------|
| ITEM_NUMBER | Yes | Unique item identifier, max 40 chars |
| ITEM_DESCRIPTION | Yes | Max 240 chars |
| ITEM_CLASS_NAME | Yes | Must match an existing Item Class exactly |
| PRIMARY_UOM_CODE | Yes | Must exist in UOM setup |
| ITEM_STATUS_CODE | Yes | Use 'Active' for production items |
| LONG_DESCRIPTION | No | Extended description |
| TEMPLATE_NAME | No | Item template to apply defaults |

Run the macro \`Generate CSV\` to produce the upload ZIP.

### 7.3 Upload and Submit Import Job

**Navigation**: Navigator → Tools → Scheduled Processes → Schedule New Process

| Job | Process |
|-----|---------|
| Step 1 | Import Item Classes (if new classes loaded) |
| Step 2 | Import Items and Item Revisions |

Upload the ZIP file to UCM (universal content management) first:
**Navigation**: Navigator → Tools → File Import and Export → Upload

Then reference the UCM file in the Scheduled Process parameters.

### 7.4 Assign Items to Organisations

After the master load is complete, assign items to each inventory organisation:

Submit job: **Import Item and Inventory Organization Assignment**

Template: \`EGP_ITEM_RELATIONSHIPS_TEMPLATE.xlsm\`

Key columns: \`ITEM_NUMBER\`, \`ORGANIZATION_CODE\`, \`ASSIGNMENT_TYPE\` (use \`Item Organization\`)

### 7.5 Load Org-Level Attributes

Submit job: **Import Inventory Item Attributes**

Template: \`INV_EGP_ITEM_ORGS_TEMPLATE.xlsm\`

Key org-level attributes to set:

| Attribute | Recommended Values |
|----------|-------------------|
| INVENTORY_ITEM_FLAG | Y |
| STOCK_ENABLED_FLAG | Y |
| TRANSACTABLE | Y |
| LOT_CONTROL_CODE | 1=No Control, 2=Full Control |
| SERIAL_NUMBER_CONTROL_CODE | 1=No Control, 2=Predefined, 5=At Receipt |
| COSTING_ENABLED_FLAG | Y |
| INVENTORY_ASSET_VALUE_FLAG | Y |

---

## Phase 8: On-Hand Balance Migration

On-hand balances must be loaded after item master, org assignments, and cost accounting are all complete.

### 8.1 Prepare On-Hand Balance File

Template: \`INV_ONHAND_QUANTITIES_TEMPLATE.xlsm\`

Download from: Navigator → Tools → File-Based Data Import → Download Templates

Key columns:

| Column | Required | Notes |
|--------|---------|-------|
| ITEM_NUMBER | Yes | Must already exist and be assigned to this org |
| ORGANIZATION_CODE | Yes | Target inventory org |
| SUBINVENTORY_CODE | Yes | Must exist in the org |
| LOCATOR_ID or LOCATOR | Conditional | Required if subinventory uses locator control |
| TRANSACTION_QUANTITY | Yes | Opening balance quantity |
| TRANSACTION_UOM | Yes | Must be a valid UOM for this item |
| LOT_NUMBER | Conditional | Required if item is lot-controlled |
| SERIAL_NUMBER | Conditional | Required if item is serial-controlled |
| TRANSACTION_DATE | Yes | Go-live date; must be in an open inventory period |
| COST_GROUP_CODE | No | Required for Actual (FIFO) costing |

### 8.2 Submit Import Job

**Navigation**: Navigator → Tools → Scheduled Processes → Schedule New Process

Job: **Perform Inventory Transactions**

Upload the ZIP to UCM, reference it in the job parameters.

### 8.3 Validate On-Hand Balances

After the import job completes, validate using the on-hand balance report:

**Navigation**: Inventory → Reports → On-Hand Quantity Report

Run for each organisation and compare against the source system extract totals. Row counts and total quantities must match. If using standard costing, the total inventory value (quantity × standard cost) must be reconciled to the subledger accounting entries created.

---

## Phase 9: Transaction Type Configuration

### 9.1 Inventory Transaction Types

**Navigation**: Setup and Maintenance → Manage Inventory Transaction Types

Transaction types control the accounting treatment of miscellaneous inventory transactions (adjustments, write-offs, issues to cost centres). Each transaction type is mapped to a transaction action and a transaction source type.

Common custom transaction types to create:

| Transaction Type | Action | Source Type | Account |
|-----------------|--------|-------------|---------|
| CYCLE_COUNT_ADJ | Cycle Count Adjustment | Cycle Count | Cycle Count Variance |
| MISC_ISSUE_SCRAP | Issue from Stores | Account | Scrap/Waste expense account |
| MISC_ISSUE_SAMPLE | Issue from Stores | Account | Quality sampling expense account |
| PHYSICAL_INV_ADJ | Physical Inventory Adj | Physical Inventory | Physical Inv Adjustment |

### 9.2 Receiving Transaction Source Types

**Navigation**: Setup and Maintenance → Manage Receiving Lookup Codes

Verify that the receiving transaction source types (PO Receipt, Transfer Order Receipt, RMA Receipt) have the correct accounting profile assigned. These are typically pre-seeded and require no modification unless intercompany costing is involved.

---

## Phase 10: REST API Integration Setup

### 10.1 Create Integration User

Create a dedicated Oracle Identity Cloud Service (IDCS) user for API integrations. Do not use a named user account.

\`\`\`
IDCS Admin Console → Users → Add User
Username: svc_inventory_api
Roles: Assign 'Inventory Integration' role
\`\`\`

Generate and record OAuth credentials (Client ID and Secret) for this user.

### 10.2 Test REST Connectivity

Test the on-hand balance GET endpoint from the integration server:

\`\`\`bash
#!/bin/bash
# Test Fusion Cloud SCM REST API connectivity

FUSION_HOST="your-tenant.oraclecloud.com"
API_USER="svc_inventory_api"
API_PASS="your_password"
ORG_CODE="CW1"

# Get on-hand balances for a specific item in an org
curl -s -u "\${API_USER}:\${API_PASS}" \\
  -H "Content-Type: application/json" \\
  "https://\${FUSION_HOST}/fscmRestApi/resources/11.13.18.05/inventoryOnhandBalances?q=OrganizationCode=\${ORG_CODE}" \\
  | python3 -m json.tool | head -50
\`\`\`

### 10.3 Inbound Transaction via REST

Example: post a miscellaneous receipt (inventory adjustment) via the Misc Transactions REST API:

\`\`\`bash
#!/bin/bash
FUSION_HOST="your-tenant.oraclecloud.com"
API_USER="svc_inventory_api"
API_PASS="your_password"

curl -s -X POST \\
  -u "\${API_USER}:\${API_PASS}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "OrganizationCode": "CW1",
    "TransactionTypeName": "Miscellaneous Receipt",
    "TransactionDate": "2026-06-24",
    "lines": [{
      "ItemNumber": "COMP-001",
      "SubinventoryCode": "RAW",
      "Quantity": 100,
      "UOMCode": "EA",
      "TransactionDate": "2026-06-24"
    }]
  }' \\
  "https://\${FUSION_HOST}/fscmRestApi/resources/11.13.18.05/inventoryMiscTransactions"
\`\`\`

---

## Phase 11: BICC Extract Setup

BICC (Business Intelligence Cloud Connector) provides scheduled bulk extracts of Fusion transactional data to OCI Object Storage or UCM.

### 11.1 Configure BICC Offering

**Navigation**: Navigator → Tools → Business Intelligence Cloud Connector

Create an Offering Extract:
1. Click **Create**
2. Select **Inventory Management** from the application list
3. Choose relevant View Objects:
   - \`FscmTopModelAM.InvTransactionsAM.InvMaterialTransactionsVVO\` — material transactions
   - \`FscmTopModelAM.InvOnhandBalancesAM.InvOnHandQuantityVVO\` — on-hand balances
   - \`FscmTopModelAM.CostAccountingAM.CostDistributionVVO\` — cost distributions
4. Set the extract target: OCI Object Storage bucket or UCM
5. Schedule: typically nightly at 01:00 AM tenant time

### 11.2 Monitor BICC Extract Jobs

\`\`\`bash
#!/bin/bash
# Check BICC extract job status via ESS REST API

FUSION_HOST="your-tenant.oraclecloud.com"
API_USER="svc_inventory_api"
API_PASS="your_password"

# Query last 5 ESS jobs for BICC
curl -s -u "\${API_USER}:\${API_PASS}" \\
  "https://\${FUSION_HOST}/fscmRestApi/resources/11.13.18.05/erpintegrations?q=OperationName=ExtractBulkData" \\
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data.get('items', [])
for item in items[:5]:
    print(f'Job: {item.get(\"JobName\",\"?\")} | Status: {item.get(\"Status\",\"?\")} | Submitted: {item.get(\"SubmittedOn\",\"?\")}')
"
\`\`\`

---

## Phase 12: Cycle Count Configuration

Cycle counts are the ongoing accuracy verification mechanism. Physical inventory counts are typically an annual full freeze count.

### 12.1 Create Cycle Count Header

**Navigation**: Inventory → Manage Cycle Counts → Create

| Field | Value |
|-------|-------|
| Name | Descriptive (e.g., WEEKLY_CYCLE_COUNT) |
| Organization | Target inventory org |
| Count Method | Dynamic ABC (recalculates ABC classification automatically) |
| Auto Schedule | Yes — generates count requests automatically |
| Serial Detail | Required if org has serialised items |

### 12.2 Define Count Schedule

**Navigation**: Cycle Count → Manage Count Schedules

Create schedule entries for each ABC class:

| ABC Class | Count Frequency | Cycle (days) |
|-----------|----------------|-------------|
| A (high value/velocity) | Weekly | 7 |
| B (medium) | Monthly | 30 |
| C (low) | Quarterly | 90 |
| Unclassified | Annual | 365 |

### 12.3 ABC Classification

Run ABC classification before the first cycle count:

**Navigation**: Inventory → ABC Compile → Create

Compile based on Annual Spend (quantity × current cost × 12). Assignment:
- A class: top 20% by value (typically 80% of total inventory value — Pareto principle)
- B class: next 30% by value
- C class: remaining 50%

---

## Phase 13: User Roles and Data Security

### 13.1 Standard Inventory Roles

Oracle provides predefined job roles for inventory:

| Role | Privileges |
|------|-----------|
| Inventory Manager | Full inventory configuration and transactions |
| Inventory Clerk | Transactions only — no configuration access |
| Warehouse Manager | Receiving, shipping, transfers, cycle counts |
| Receiving Agent | Receiving and delivery transactions only |
| Cost Accountant | Cost accounting and period close |
| Inventory Analyst | Read-only access to balances and transactions |

**Navigation**: Security Console → Roles → assign to users

### 13.2 Data Security — Inventory Organisation Access

Fusion data security controls which inventory organisations a user can transact in. A user with the Inventory Clerk role who is not granted data access to a specific org cannot see or transact in that org.

**Navigation**: Setup and Maintenance → Manage Data Access for Users

Assign each user to the specific inventory organisations they need access to. For administrators, a wildcard assignment grants access to all orgs.

---

## Phase 14: Period Open and Pre-Go-Live Validation

### 14.1 Open Inventory Period

**Navigation**: Inventory → Manage Inventory Accounting Periods

Open the go-live period for each inventory organisation. The period status must be **Open** before any transactions can be processed.

Confirm the Ledger period is also open in General Ledger for the same period.

### 14.2 Pre-Go-Live Checklist

\`\`\`
[ ] Enterprise structure confirmed (Legal Entity, Ledger, Business Unit)
[ ] All inventory organisations created and active
[ ] All subinventories created with correct nettable/reservable flags
[ ] UOM classes, units, and conversions complete
[ ] Item classes and attribute groups defined
[ ] Item master FBDI load complete — row count validated
[ ] Item-org assignment load complete
[ ] Org-level item attributes loaded and validated
[ ] Cost organisations created and cost method confirmed
[ ] Standard costs published (standard costing only)
[ ] Account derivation rules validated with test journal entries
[ ] On-hand balance FBDI load complete — quantity and value reconciled
[ ] Transaction types configured
[ ] REST API credentials tested — GET and POST endpoints verified
[ ] BICC extract scheduled and first run validated
[ ] Cycle count headers and schedules created
[ ] User roles and data security assignments complete
[ ] Inventory period open for go-live date
[ ] GL period open for go-live date
[ ] End-to-end transaction test: PO receipt → deliver → on-hand balance → misc issue → check journal
\`\`\`

---

## Phase 15: Monitoring Scripts

The following scripts provide ongoing visibility into ESS job health, pending inventory transactions, on-hand balance anomalies, and integration errors. Schedule them via crontab on any Linux host with network access to the Fusion Cloud tenant.

### Script 1: ESS Job Health Monitor

\`\`\`bash
#!/bin/bash
# /opt/fusion_monitor/check_ess_jobs.sh
# Checks recent ESS jobs and alerts on failures

FUSION_HOST="your-tenant.oraclecloud.com"
API_USER="svc_inventory_api"
API_PASS="your_password"
ALERT_EMAIL="dba-team@company.com"
LOG_FILE="/var/log/fusion_monitor/ess_jobs_\$(date +%Y%m%d).log"

TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
echo "=== ESS Job Health Check: \${TIMESTAMP} ===" >> "\${LOG_FILE}"

# Query ESS jobs from last 24 hours
FAILED_JOBS=\$(curl -s -u "\${API_USER}:\${API_PASS}" \\
  -H "Accept: application/json" \\
  "https://\${FUSION_HOST}/fscmRestApi/resources/11.13.18.05/erpintegrations?q=Status=ERROR&limit=20" \\
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data.get('items', [])
for item in items:
    print(f'FAILED: {item.get(\"JobName\",\"?\")} | Submitted: {item.get(\"SubmittedOn\",\"?\")} | RequestId: {item.get(\"ReqstId\",\"?\")}')
" 2>&1)

if [ -n "\${FAILED_JOBS}" ]; then
  echo "\${FAILED_JOBS}" >> "\${LOG_FILE}"
  echo -e "Subject: ALERT: Fusion ESS Job Failures Detected\n\n\${FAILED_JOBS}\n\nFull log: \${LOG_FILE}" \\
    | sendmail "\${ALERT_EMAIL}"
else
  echo "No ESS job failures in last query window." >> "\${LOG_FILE}"
fi
\`\`\`

### Script 2: Pending Transaction Monitor

Pending inventory transactions in error (stuck in interface tables) prevent period close and can indicate integration failures.

\`\`\`bash
#!/bin/bash
# /opt/fusion_monitor/check_pending_transactions.sh
# Checks for inventory transactions stuck in error state

FUSION_HOST="your-tenant.oraclecloud.com"
API_USER="svc_inventory_api"
API_PASS="your_password"
ALERT_EMAIL="dba-team@company.com"
THRESHOLD=50
LOG_FILE="/var/log/fusion_monitor/pending_txn_\$(date +%Y%m%d).log"

TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
echo "=== Pending Transaction Check: \${TIMESTAMP} ===" >> "\${LOG_FILE}"

# Get count of transactions in ERROR status via REST
ERROR_RESPONSE=\$(curl -s -u "\${API_USER}:\${API_PASS}" \\
  -H "Accept: application/json" \\
  "https://\${FUSION_HOST}/fscmRestApi/resources/11.13.18.05/inventoryMiscTransactions?q=TransactionStatus=ERROR&limit=1&totalResults=true" 2>&1)

ERROR_COUNT=\$(echo "\${ERROR_RESPONSE}" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('totalResults', 0))
except:
    print(0)
" 2>/dev/null)

echo "Transactions in ERROR: \${ERROR_COUNT}" >> "\${LOG_FILE}"

if [ "\${ERROR_COUNT}" -gt "\${THRESHOLD}" ]; then
  MSG="ALERT: \${ERROR_COUNT} inventory transactions in ERROR state (threshold: \${THRESHOLD}). Investigate in Fusion UI: Inventory > Manage Pending Transactions."
  echo "\${MSG}" >> "\${LOG_FILE}"
  echo -e "Subject: ALERT: Fusion Pending Transaction Errors\n\n\${MSG}" | sendmail "\${ALERT_EMAIL}"
fi
\`\`\`

### Script 3: On-Hand Balance Negative Quantity Check

Negative on-hand quantities indicate transaction sequencing problems or missing receipts.

\`\`\`bash
#!/bin/bash
# /opt/fusion_monitor/check_negative_onhand.sh
# Alerts on negative on-hand quantities in any organisation

FUSION_HOST="your-tenant.oraclecloud.com"
API_USER="svc_inventory_api"
API_PASS="your_password"
ALERT_EMAIL="dba-team@company.com"
LOG_FILE="/var/log/fusion_monitor/negative_onhand_\$(date +%Y%m%d).log"

TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
echo "=== Negative On-Hand Check: \${TIMESTAMP} ===" >> "\${LOG_FILE}"

NEGATIVE=\$(curl -s -u "\${API_USER}:\${API_PASS}" \\
  -H "Accept: application/json" \\
  "https://\${FUSION_HOST}/fscmRestApi/resources/11.13.18.05/inventoryOnhandBalances?q=OnhandQuantity<0&limit=50" \\
  | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    items = data.get('items', [])
    if items:
        for item in items:
            print(f'NEG: Org={item.get(\"OrganizationCode\",\"?\")} Item={item.get(\"ItemNumber\",\"?\")} Sub={item.get(\"SubinventoryCode\",\"?\")} Qty={item.get(\"OnhandQuantity\",\"?\")}')
    else:
        print('NONE')
except Exception as e:
    print(f'ERROR: {e}')
" 2>&1)

echo "\${NEGATIVE}" >> "\${LOG_FILE}"

if [ "\${NEGATIVE}" != "NONE" ] && [ -n "\${NEGATIVE}" ]; then
  echo -e "Subject: ALERT: Fusion Negative On-Hand Quantities Detected\n\n\${NEGATIVE}\n\nLog: \${LOG_FILE}" \\
    | sendmail "\${ALERT_EMAIL}"
fi
\`\`\`

### Script 4: Open Inventory Period Check

Alerts when an inventory period has been open longer than expected — a sign that period close is stalling.

\`\`\`bash
#!/bin/bash
# /opt/fusion_monitor/check_inventory_period.sh
# Alerts if inventory period is older than MAX_PERIOD_AGE_DAYS

FUSION_HOST="your-tenant.oraclecloud.com"
API_USER="svc_inventory_api"
API_PASS="your_password"
ALERT_EMAIL="dba-team@company.com"
MAX_PERIOD_AGE_DAYS=35
LOG_FILE="/var/log/fusion_monitor/period_check_\$(date +%Y%m%d).log"

TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
echo "=== Inventory Period Check: \${TIMESTAMP} ===" >> "\${LOG_FILE}"

# Get open inventory periods
PERIOD_INFO=\$(curl -s -u "\${API_USER}:\${API_PASS}" \\
  -H "Accept: application/json" \\
  "https://\${FUSION_HOST}/fscmRestApi/resources/11.13.18.05/inventoryAccountingPeriods?q=PeriodStatusCode=O&limit=10" \\
  | python3 -c "
import sys, json
from datetime import datetime, timezone
try:
    data = json.load(sys.stdin)
    items = data.get('items', [])
    today = datetime.now(timezone.utc)
    alerts = []
    for item in items:
        start_str = item.get('PeriodStartDate','')
        if start_str:
            try:
                start = datetime.fromisoformat(start_str.replace('Z','+00:00'))
                age = (today - start).days
                if age > \${MAX_PERIOD_AGE_DAYS}:
                    alerts.append(f'STALE_PERIOD: Org={item.get(\"InventoryOrganizationCode\",\"?\")} Period={item.get(\"PeriodName\",\"?\")} Open={age} days')
            except:
                pass
    print('\n'.join(alerts) if alerts else 'OK')
except Exception as e:
    print(f'ERROR: {e}')
" 2>&1)

echo "\${PERIOD_INFO}" >> "\${LOG_FILE}"

if [ "\${PERIOD_INFO}" != "OK" ] && [ -n "\${PERIOD_INFO}" ]; then
  echo -e "Subject: ALERT: Fusion Inventory Period Stale (> \${MAX_PERIOD_AGE_DAYS} days open)\n\n\${PERIOD_INFO}" \\
    | sendmail "\${ALERT_EMAIL}"
fi
\`\`\`

### Script 5: BICC Extract Validation

Verifies that BICC extracts completed within the expected time window and produced non-zero output files.

\`\`\`bash
#!/bin/bash
# /opt/fusion_monitor/check_bicc_extracts.sh
# Validates that nightly BICC inventory extract ran and produced output

BICC_OUTPUT_DIR="/mnt/oci_bucket/bicc_extracts/inventory"
EXPECTED_FILES=("material_transactions" "onhand_balances" "cost_distributions")
MAX_AGE_HOURS=26
ALERT_EMAIL="dba-team@company.com"
LOG_FILE="/var/log/fusion_monitor/bicc_check_\$(date +%Y%m%d).log"

TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
echo "=== BICC Extract Check: \${TIMESTAMP} ===" >> "\${LOG_FILE}"

ALERT_MSG=""
for EXTRACT in "\${EXPECTED_FILES[@]}"; do
  LATEST_FILE=\$(find "\${BICC_OUTPUT_DIR}" -name "\${EXTRACT}*.csv" -newer /tmp/.bicc_check_marker 2>/dev/null | head -1)
  if [ -z "\${LATEST_FILE}" ]; then
    ALERT_MSG+="\nMISSING: No recent \${EXTRACT} extract file found in last \${MAX_AGE_HOURS}h"
  else
    FILE_SIZE=\$(stat -c%s "\${LATEST_FILE}" 2>/dev/null || echo 0)
    if [ "\${FILE_SIZE}" -lt 100 ]; then
      ALERT_MSG+="\nEMPTY: \${EXTRACT} extract file is suspiciously small: \${FILE_SIZE} bytes"
    else
      echo "OK: \${EXTRACT} — \$(basename "\${LATEST_FILE}") — \${FILE_SIZE} bytes" >> "\${LOG_FILE}"
    fi
  fi
done

touch /tmp/.bicc_check_marker

if [ -n "\${ALERT_MSG}" ]; then
  echo -e "Subject: ALERT: Fusion BICC Extract Issues\n\n\${ALERT_MSG}" | sendmail "\${ALERT_EMAIL}"
fi
\`\`\`

### Crontab Configuration

\`\`\`bash
# /etc/cron.d/fusion_inventory_monitor
# Fusion Cloud SCM Inventory monitoring — runs as oracle user

MAILTO=""
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# ESS job failure check — every 30 minutes during business hours
*/30 7-19 * * 1-5  oracle  /opt/fusion_monitor/check_ess_jobs.sh >> /var/log/fusion_monitor/cron.log 2>&1

# Pending transaction check — every hour
0 * * * *          oracle  /opt/fusion_monitor/check_pending_transactions.sh >> /var/log/fusion_monitor/cron.log 2>&1

# Negative on-hand check — twice daily
0 8,17 * * *       oracle  /opt/fusion_monitor/check_negative_onhand.sh >> /var/log/fusion_monitor/cron.log 2>&1

# Open period staleness check — daily at 9am
0 9 * * *          oracle  /opt/fusion_monitor/check_inventory_period.sh >> /var/log/fusion_monitor/cron.log 2>&1

# BICC extract validation — every morning at 6am (after nightly extract window)
0 6 * * *          oracle  /opt/fusion_monitor/check_bicc_extracts.sh >> /var/log/fusion_monitor/cron.log 2>&1
\`\`\`

---

## Summary

Oracle Fusion Cloud SCM Inventory R13 implementation follows a strictly ordered sequence: enterprise structure and Business Unit before inventory organisations, organisations and item master before cost accounting, cost accounting before on-hand migration, and on-hand migration before any financial transactions. The three-stage FBDI item load (master attributes → item-org assignments → org-level attributes) is the most frequently mistimed step in practice. Cost accounting setup — cost organisation, cost method selection, and account derivation rules — must be complete and validated before loading on-hand balances, because on-hand records without cost accounting have no financial value and require a full reversal and reload to correct. REST API integration for real-time transaction feeds uses OAuth credentials assigned to a dedicated service account, not a named user. BICC provides the correct bulk extract mechanism for BI and data warehouse feeds — REST APIs are not designed for bulk historical extraction. The crontab monitoring framework provides day-two operational visibility into ESS job health, pending transaction backlogs, negative on-hand quantities, stale open periods, and BICC extract completeness, covering the most common failure modes in Fusion Cloud SCM Inventory production operations.`,
};

async function main() {
  console.log('Inserting Oracle Fusion Cloud SCM Inventory R13 runbook...');
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
