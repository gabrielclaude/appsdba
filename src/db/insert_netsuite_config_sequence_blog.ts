import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'The Blueprint for a Clean NetSuite Build: Why Configuration Order Is Everything',
  slug: 'netsuite-configuration-sequence-blueprint-clean-build',
  excerpt:
    'NetSuite is a direct-posting system with no buffering layer between configuration errors and your general ledger. Configure features out of order and the mistakes embed themselves in transaction history, item records, and posting rules that are painful to unwind. This guide covers the definitive setup sequence — from company information and COA design through item master, entities, and role-based security — and explains why each step must happen before the next one can be trusted.',
  category: 'netsuite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-15'),
  youtubeUrl: null,
  content: `Most ERP implementations fail quietly. The system goes live, the data gets loaded, users log in — and then, slowly, the cracks appear. Financial reports don't match operational reports. Item receipts post to the wrong accounts. A subsidiary consolidation doesn't roll up correctly. Month-end close requires manual journal entries to correct posting errors that should never have happened.

In nearly every case, these problems trace back to the same root cause: configuration was done in the wrong order.

NetSuite is not a forgiving system when it comes to sequencing. Unlike batch-oriented ERP platforms that can buffer and validate data before committing it, **NetSuite is a direct-posting system**. Transactions hit the general ledger the moment they are saved. A misconfigured item account mapping means every sales order that references that item has been posting to the wrong revenue account since day one. There is no batch to roll back.

This post establishes the definitive configuration sequence for a clean NetSuite implementation — from the global company envelope down to individual user roles — and explains why each layer must be stable before the next one is built on top of it.

---

## Why Order Matters More Than Speed

The temptation in any NetSuite project is to move fast. Consultants have project plans, clients have go-live dates, and everyone wants to see data in the system. This pressure leads to the most common implementation anti-pattern: configuring items before accounts are finalized, loading customers before entity forms are designed, or activating features after transactions have already been entered.

Each of these shortcuts creates a dependency inversion. When you need to change an account that is already referenced by 10,000 item records, you are no longer making a configuration decision — you are running a remediation project. When you activate Multi-Currency after customers already exist, some entity records may not be updated correctly and will need manual correction.

The sequence below is not arbitrary. Each step creates the scaffolding that the next step requires. Violating the order means building on an unstable foundation.

---

## Step 1: Company Information and Core Features

Before a single account, item, or customer record exists, you must define the global envelope of your NetSuite instance.

Navigate to **Setup > Company > Company Information** and populate:
- Legal company name (used on all printed documents and tax filings)
- Tax ID and registered address (sourced directly into transaction forms)
- Base currency (cannot be changed after transactions are entered — this is the most irreversible decision in a NetSuite implementation)
- Default time zone and date format

Then go to **Setup > Company > Enable Features** and activate only what your minimum viable product requires.

> **The most common implementation mistake:** activating every feature that looks relevant on the first day. Each enabled feature adds fields, subtabs, and UI elements to transaction forms. Advanced Revenue Management adds revenue arrangements and element lines to every sales order. Bin Management adds bin allocation to every inventory transaction. Multi-Book Accounting adds a secondary ledger to every posting. These are powerful features — but enabling them before you have the data architecture to support them means every transaction you enter during setup will be incomplete or incorrect by design.

Enable features in phases. Start with what is needed for the first operational workflow. Add features when the underlying configuration to support them is ready.

---

## Step 2: Chart of Accounts and Financial Segmentation

The traditional ERP Chart of Accounts used a complex segmented string to encode all financial dimensions into a single account number — something like \`01-100-4100-02\`, where each segment encoded the entity, department, account, and location. This approach created rigid, large COAs with thousands of permutations.

NetSuite replaces this model entirely. The COA should be **flat and clean**, containing only natural account types:
- Assets
- Liabilities
- Equity
- Revenue
- Expenses

Financial segmentation is handled by separate structural dimensions that are applied at the transaction line level:

| Dimension | What It Represents |
|-----------|-------------------|
| **Subsidiaries** | Legal entities for consolidated financial reporting |
| **Departments** | Internal cost centers (Engineering, Sales, Operations) |
| **Classes** | Revenue streams, product lines, or business segments |
| **Locations** | Warehouses, offices, or geographic regions |
| **Custom Segments** | Any additional dimension not covered by the native three |

This separation is the architectural advantage NetSuite provides over legacy ERP systems. An account for \`Software Revenue\` is a single account. When you want to see Software Revenue by Department and by Location for a specific Subsidiary, you apply those dimensions as filters — you do not create separate accounts for every combination.

**Why this must come before items:** Every item record in NetSuite maps to specific GL accounts. If those accounts do not exist yet, or if the account structure changes after items are created, you face a mass re-mapping effort that touches every item and every historical transaction.

### Custom Segments

If Department, Class, and Location do not cover your dimensional reporting requirements, create Custom Segments via **Customization > Lists, Records & Fields > Custom Segments** before creating any transaction records. Custom Segments that are added after transactions exist will have gaps in their historical data — those older transactions will show as unclassified.

---

## Step 3: The Item Master

Approximately 90% of all ledger-posting transactions in NetSuite are driven directly by the Item Master. A sales order posts revenue through its line items. A purchase order posts expense through its line items. A vendor bill posts COGS through its line items. If the item is mapped to the wrong account, every transaction that uses it is wrong.

Item configuration covers:

**Account mapping per item type:**

| Item Type | Accounts Required |
|-----------|------------------|
| Inventory Item | Asset (Inventory), COGS, Revenue, Purchase Price Variance |
| Non-Inventory (Purchase) | Expense |
| Non-Inventory (Sale) | Revenue |
| Service | Revenue or Expense |
| Other Charge | Revenue or Expense (context-dependent) |

**Operational dependencies:**
- **Units of Measure (UOM) Schedules:** If you purchase in cases and sell in units, the UOM conversion must be defined before items are created — not added later when discrepancies appear in receiving.
- **Reorder Points and Preferred Vendors:** Supply chain logic attached to the item at creation time ensures replenishment runs correctly from day one.
- **Bin Allocations:** If Bin Management is active, item-to-bin mappings must exist before inventory transactions begin.

The principle here is the same as the COA: get it right before transactions start. A COGS account correction on a live item requires a physical inventory adjustment to correctly revalue the asset — a significant operational disruption.

---

## Step 4: Entities and Relationships

With accounts defined and items mapped, the entities that conduct business — Customers, Vendors, Partners, Employees — can now be created correctly.

**Subsidiary mapping:** In a multi-subsidiary environment, every entity must be associated with the correct subsidiary (or marked as shared across subsidiaries). The subsidiary assignment determines which legal entity's financials the transactions post to. Getting this wrong at the entity level means correcting transaction-by-transaction.

**Multi-currency entities:** If Multi-Currency is enabled, entity records need the correct currency assigned. Currency cannot easily be changed on an entity after transactions exist in that entity's history.

**Parent-child relationships:** NetSuite supports customer hierarchies where a parent company handles billing consolidation and individual sub-customer records represent distinct locations or divisions. Design this hierarchy before creating customer records — retrofitting a parent-child structure onto flat customer records requires merging or relinking records and can disrupt historical reporting.

---

## Step 5: Forms, Workflows, and Role-Based Security

Once the data structures are stable — accounts, items, entities — the focus shifts to the user experience and security model.

### Form Customization

Standard NetSuite forms contain every field that every user in every industry might ever need. For a specific business, 60–70% of those fields are irrelevant noise that increases cognitive load and data entry errors. Customize your forms via **Customization > Forms > Transaction Forms**:

- Hide fields that are not used in your business process
- Make business-critical fields mandatory (required) rather than optional
- Group related fields into logical subtabs
- Create role-specific form variants so a warehouse user sees a different view of a receipt than a finance user sees

> **Do this before training users.** If users learn to navigate a cluttered form during UAT, and you clean it up afterward, you have re-trained them. Design the final form first.

### SuiteFlow Workflows

NetSuite's visual workflow engine (SuiteFlow) allows point-and-click business logic without code:
- Route purchase orders above a dollar threshold to an approver
- Send automated email notifications when inventory drops below a reorder point
- Lock transaction records after a period closes

Build workflows in the sandbox with representative test data before production deployment. A workflow trigger condition that is slightly too broad will fire on transactions it should not touch.

### Role-Based Security

Never assign standard Oracle NetSuite out-of-the-box roles to production users. Standard roles are intentionally broad — they give the role enough permissions to function in any NetSuite environment, which is almost certainly more access than any specific user at your organization needs.

The correct approach:
1. Clone the closest standard role (Accountant, Warehouse Manager, Sales Rep)
2. Audit the permission list and remove anything not required for that user's actual job function
3. Assign a role-specific dashboard with the Saved Searches, KPIs, and reminders relevant to that role
4. Test the role by logging in as a test user with that role before assigning it to real users

Proper role design enforces segregation of duties at the system level rather than relying on organizational policy — no single user should be able to create a vendor, approve a bill, and process the payment.

---

## Configuration Sequence Summary

\`\`\`
1. Company Information & Base Currency  (irreversible — do first)
2. Enable Features (MVP only)
3. Subsidiaries & Legal Entity Structure
4. Chart of Accounts (flat, natural accounts only)
5. Financial Dimensions (Departments, Classes, Locations, Custom Segments)
6. Item Master (account mappings, UOM, operational dependencies)
7. Entities (Customers, Vendors — with correct subsidiary and currency)
8. Transaction Forms (customized, role-appropriate)
9. Workflows (SuiteFlow business logic)
10. Roles & Security (cloned, scoped, tested)
\`\`\`

Each step is a prerequisite for the one that follows. Accounts must exist before items can be mapped. Items must be mapped before sales orders post correctly. Sales orders must post correctly before you can trust your financial reports. Financial reports must be trusted before you can close a period.

---

## Summary and Best Practices

A NetSuite implementation that follows this sequence is not just cleaner on day one — it is dramatically easier to maintain, audit, and extend over time. The platform receives two mandatory upgrades per year. Environments with minimal customization and clean underlying data structures survive those upgrades with almost no remediation work. Environments built through rapid, out-of-order configuration often require significant testing and correction after every upgrade cycle.

**The five rules that prevent the most common implementation failures:**

1. **Test everything in a sandbox first.** Configuration changes in production are immediately live. There is no undo for a misconfigured posting account on a high-volume item.

2. **Enable features only when you have the supporting configuration ready.** An active feature without its required data structures produces gaps, errors, and UI confusion.

3. **Keep the COA flat.** Resist pressure to create segmented account numbers. NetSuite's dimensional model handles this better than any account string ever could.

4. **Never use stock roles in production.** They are a template, not a finished product.

5. **Limit custom code to what native functionality cannot do.** SuiteScript persists across upgrades but requires testing with every release. Every custom script is maintenance overhead that accumulates over the life of the system.

The companion runbook covers the step-by-step verification checklist for each configuration phase, the SuiteScript snippets for auditing account mappings and entity configurations, and the pre-go-live validation procedure that confirms each layer is correctly set up before the next one is started.`,
};

async function main() {
  console.log('Inserting NetSuite configuration sequence blog post...');
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
