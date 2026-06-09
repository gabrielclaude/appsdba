import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Connecting OBIEE to Oracle EBS 12.2: Architecture and Data Access Patterns',
  slug: 'obiee-pull-data-from-ebs-12-2',
  excerpt:
    'A technical guide to connecting Oracle Business Intelligence Enterprise Edition (OBIEE 12c) to Oracle E-Business Suite 12.2.9 — covering the RPD connection pool architecture, EBS Multi-Org VPD security context, FND_GLOBAL initialisation blocks, key EBS reporting views across GL, AP, AR, and PO, and the common data access patterns that make EBS reporting work correctly.',
  category: 'fusion-middleware' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-09'),
  youtubeUrl: null,
  content: `Oracle E-Business Suite 12.2.9 is a dense source system. Its schema spans hundreds of tables across GL, AP, AR, PO, HR, and INV modules, all layered over a Multi-Org architecture that uses Oracle Virtual Private Database (VPD) to enforce row-level security. Getting OBIEE to report against it correctly requires understanding not just the database objects, but the session context that EBS expects before it will show you the right data.

This post covers the architecture, the EBS-specific session initialisation that OBIEE must perform, the key reporting objects to build against, and the patterns that separate a functional integration from one that returns wrong or missing rows.

---

## The Architecture

OBIEE connects to EBS through the **Oracle BI Server** (the \`nqsserver\` process), which manages a pool of database connections defined in the RPD (Repository Definition File). Every OBIEE query resolves through the RPD's Physical layer → Business Model layer → Presentation layer semantic stack before a SQL statement is issued to the EBS database.

\`\`\`
OBIEE Web Layer (Presentation Services / Analytics UI)
         ↓
Oracle BI Server (nqsserver)
    ├── RPD Semantic Layer
    │     ├── Presentation Layer (subject areas, folders, columns)
    │     ├── Business Model & Mapping Layer (logical tables, metrics, joins)
    │     └── Physical Layer (connection pools, physical tables, physical joins)
         ↓
EBS 12.2.9 Database (Oracle 19c / 12.2)
    ├── APPS schema (core EBS views and packages)
    ├── Module schemas (GL, AP, AR, PO, HR...)
    └── FND infrastructure (FND_USER, FND_PROFILE, MO_GLOBAL, VPD policies)
\`\`\`

### Connection Methods

**Direct JDBC to the EBS database** is the standard approach for operational reporting. OBIEE connects to EBS using a JDBC connection pool, authenticates as the APPS user (or a dedicated read-only reporting user), and issues queries against EBS views and tables.

**Oracle BI Applications (OBIA)** is Oracle's pre-built analytics product that sits on top of EBS. It uses ODI or Informatica to ETL data from EBS into a dedicated data warehouse schema, and OBIEE reports against the warehouse rather than EBS directly. This guide covers the direct connection approach.

---

## The EBS Multi-Org Problem

EBS stores data for multiple operating units in the same tables. The column \`ORG_ID\` partitions rows by operating unit. Oracle's VPD engine automatically appends a predicate to every query against Multi-Org tables — but only when the correct session context is set.

If the session context is not initialised, one of two things happens:
1. Queries return **zero rows** (the VPD policy returns an empty predicate for an unrecognised session)
2. Queries return **all rows from all operating units** (the policy is not enforced)

Neither is acceptable. OBIEE's connection pool must initialise the EBS session context for every connection before any report query runs.

### How EBS Multi-Org Context Works

EBS uses two packages to manage session context:

**\`MO_GLOBAL.INIT\`** — sets the Multi-Org access mode. Two modes are relevant:
- Single-org mode: \`MO_GLOBAL.INIT('M')\` initialises for a specific \`ORG_ID\`
- Multi-org mode: \`MO_GLOBAL.SET_POLICY_CONTEXT('M', :org_id)\` restricts to one org while allowing cross-org joins

**\`FND_GLOBAL.APPS_INITIALIZE\`** — sets the FND session context: user ID, responsibility ID, and application ID. Required for any function that calls FND APIs, evaluates profile options, or uses FlexField lookups.

\`\`\`sql
-- Minimum initialisation for a read-only reporting session
BEGIN
    FND_GLOBAL.APPS_INITIALIZE(
        user_id      => 1234,    -- FND_USER.USER_ID for the BI reporting user
        resp_id      => 50001,   -- FND_RESPONSIBILITY.RESPONSIBILITY_ID
        resp_appl_id => 101      -- FND_APPLICATION.APPLICATION_ID (101 = GL)
    );
    MO_GLOBAL.INIT('M');
    MO_GLOBAL.SET_POLICY_CONTEXT('M', 204);  -- 204 = your ORG_ID
END;
\`\`\`

This block must run in the connection pool's **Connection Pool Init String** in the RPD so it executes automatically when each pooled connection is established.

---

## Key EBS Reporting Objects

EBS 12.2.9 exposes data through several layers of views designed for reporting. Using the correct view layer avoids direct base table joins and respects Multi-Org and Multi-Ledger security.

### General Ledger

| Object | Purpose |
|--------|---------|
| \`GL_BALANCES\` | Period-level account balances (actual, budget, encumbrance) |
| \`GL_CODE_COMBINATIONS\` | Chart of accounts — maps CCID to segments |
| \`GL_JE_HEADERS\` | Journal entry headers |
| \`GL_JE_LINES\` | Journal entry line detail |
| \`GL_SETS_OF_BOOKS\` / \`GL_LEDGERS\` | Ledger definitions (12.2 uses GL_LEDGERS) |
| \`GL_PERIODS\` | Accounting calendar periods |
| \`FND_FLEX_VALUES_VL\` | FlexField segment value descriptions |

The key join pattern for GL balance reporting:

\`\`\`sql
SELECT
    gcc.segment1                        AS company,
    gcc.segment2                        AS cost_centre,
    gcc.segment3                        AS account,
    gp.period_name,
    gb.currency_code,
    gb.period_net_dr - gb.period_net_cr AS net_activity,
    gb.begin_balance_dr - gb.begin_balance_cr AS opening_balance
FROM   gl_balances          gb
JOIN   gl_code_combinations gcc ON gb.code_combination_id = gcc.code_combination_id
JOIN   gl_periods           gp  ON gb.period_name = gp.period_name
                                AND gb.period_type  = gp.period_type
WHERE  gb.ledger_id    = :ledger_id
  AND  gb.actual_flag  = 'A'           -- A=Actual, B=Budget, E=Encumbrance
  AND  gb.currency_code = 'USD'
ORDER BY gp.period_year, gp.period_num;
\`\`\`

### Accounts Payable

| Object | Purpose |
|--------|---------|
| \`AP_INVOICES_ALL\` | Invoice headers (all orgs) |
| \`AP_INVOICES\` | Invoice headers (filtered to current ORG_ID via VPD) |
| \`AP_INVOICE_LINES_ALL\` | Invoice line detail |
| \`AP_INVOICE_DISTRIBUTIONS_ALL\` | Accounting distributions |
| \`AP_PAYMENT_SCHEDULES_ALL\` | Payment due dates and amounts |
| \`AP_CHECKS_ALL\` | Payment batches and check details |
| \`AP_SUPPLIERS\` (view) | Supplier master (wraps PO_VENDORS) |

Always use the \`_ALL\` table variant with an explicit \`ORG_ID\` filter in the connection pool init, or use the non-\`_ALL\` synonym (e.g., \`AP_INVOICES\`) which VPD filters automatically for the initialised ORG_ID.

### Accounts Receivable

| Object | Purpose |
|--------|---------|
| \`RA_CUSTOMER_TRX_ALL\` | Transaction headers (invoices, credit memos, debit memos) |
| \`RA_CUSTOMER_TRX_LINES_ALL\` | Transaction line detail |
| \`AR_PAYMENT_SCHEDULES_ALL\` | Amounts due, remaining, applied |
| \`AR_CASH_RECEIPTS_ALL\` | Cash receipts |
| \`HZ_PARTIES\` | Customer master (Trading Community Architecture) |
| \`HZ_CUST_ACCOUNTS\` | Customer account definitions |
| \`HZ_PARTY_SITES\` | Address records |

### Purchasing

| Object | Purpose |
|--------|---------|
| \`PO_HEADERS_ALL\` | Purchase order headers |
| \`PO_LINES_ALL\` | PO line items |
| \`PO_LINE_LOCATIONS_ALL\` | Shipment schedules (delivery lines) |
| \`PO_DISTRIBUTIONS_ALL\` | Accounting distributions |
| \`PO_REQUISITION_HEADERS_ALL\` | Purchase requisition headers |
| \`RCV_SHIPMENT_HEADERS\` | Receipt headers |
| \`RCV_TRANSACTIONS\` | Receipt transactions |

### Human Resources / Payroll

| Object | Purpose |
|--------|---------|
| \`PER_ALL_PEOPLE_F\` | Employee/person master (date-tracked) |
| \`PER_ALL_ASSIGNMENTS_F\` | Employment assignments (date-tracked) |
| \`PAY_PAYROLL_ACTIONS\` | Payroll run details |
| \`PAY_RUN_RESULTS\` | Payroll element results |
| \`HR_ALL_ORGANIZATION_UNITS\` | Organisation structure |

**Date-tracked tables** (suffix \`_F\`) require effective-date filtering. Always join with:

\`\`\`sql
WHERE  :report_date BETWEEN p.effective_start_date AND p.effective_end_date
\`\`\`

---

## EBS Lookup Descriptions

EBS stores most code-to-description mappings in the \`FND_LOOKUPS\` framework. Rather than decoding values in OBIEE metrics, join to the lookup view:

\`\`\`sql
-- Decode AP invoice type
SELECT
    ai.invoice_num,
    ai.invoice_date,
    ai.invoice_amount,
    fl.meaning                  AS invoice_type_desc
FROM   ap_invoices_all  ai
JOIN   fnd_lookups      fl ON fl.lookup_type = 'INVOICE TYPE'
                           AND fl.lookup_code = ai.invoice_type
                           AND fl.enabled_flag = 'Y'
WHERE  ai.org_id = :org_id;
\`\`\`

Key lookup types:

| Lookup Type | Used For |
|-------------|---------|
| \`INVOICE TYPE\` | AP invoice categories |
| \`INVOICE PAYMENT STATUS\` | AP payment status codes |
| \`PO DOCUMENT SUBTYPES\` | PO type descriptions |
| \`PAYMENT METHOD\` | Payment method descriptions |
| \`YES_NO\` | Flag field descriptions |

---

## FlexField Segment Descriptions

EBS chart of accounts and other FlexField segments store code values only. Descriptions live in \`FND_FLEX_VALUES_VL\`:

\`\`\`sql
SELECT
    ffv.flex_value          AS segment_value,
    ffv.description         AS segment_description,
    ffv.enabled_flag
FROM   fnd_flex_values_vl  ffv
JOIN   fnd_flex_value_sets fvs ON ffv.flex_value_set_id = fvs.flex_value_set_id
WHERE  fvs.flex_value_set_name = 'XX_COMPANY_SEGMENT'
  AND  ffv.enabled_flag = 'Y';
\`\`\`

In the OBIEE RPD, these description lookups are typically modelled as lookup dimensions joined to the fact on the segment value columns from \`GL_CODE_COMBINATIONS\`.

---

## Connection Pool Initialisation Patterns

### Single Operating Unit (most common for departmental reports)

\`\`\`sql
-- RPD Connection Pool Init String
BEGIN
    FND_GLOBAL.APPS_INITIALIZE(
        user_id      => 1234,
        resp_id      => 50001,
        resp_appl_id => 101
    );
    MO_GLOBAL.INIT('M');
    MO_GLOBAL.SET_POLICY_CONTEXT('M', 204);
END;
\`\`\`

### Multiple Operating Units (enterprise-wide reports)

\`\`\`sql
BEGIN
    FND_GLOBAL.APPS_INITIALIZE(
        user_id      => 1234,
        resp_id      => 50001,
        resp_appl_id => 101
    );
    MO_GLOBAL.INIT('M');
    -- Set multi-org mode — VPD is disabled; ORG_ID filter must be in report SQL
    MO_GLOBAL.SET_OU_IN_SESSION(NULL);
END;
\`\`\`

In multi-org mode, always include \`AND org_id IN (SELECT org_id FROM mo_glob_org_access_tmp)\` in queries against \`_ALL\` tables to respect the user's operating unit access list.

### Dynamic User-Based Initialisation with OBIEE Session Variables

For environments where different OBIEE users should see different operating units, use OBIEE Session Variables populated from an Init Block:

1. Create an Init Block in the RPD that queries \`FND_USER\`, \`FND_USER_RESP_GROUPS\`, and the EBS org assignment tables
2. Populate session variables: \`USER_ID\`, \`RESP_ID\`, \`ORG_ID\`
3. Reference them in the Connection Pool Init String:

\`\`\`sql
BEGIN
    FND_GLOBAL.APPS_INITIALIZE(
        user_id      => VALUEOF(NQ_SESSION.USER_ID),
        resp_id      => VALUEOF(NQ_SESSION.RESP_ID),
        resp_appl_id => 101
    );
    MO_GLOBAL.INIT('M');
    MO_GLOBAL.SET_POLICY_CONTEXT('M', VALUEOF(NQ_SESSION.ORG_ID));
END;
\`\`\`

---

## Common Pitfalls

**Missing org context returns no rows.** If the \`MO_GLOBAL.INIT\` or \`SET_POLICY_CONTEXT\` call is absent or fails silently, VPD returns an impossible predicate (\`1=2\`) and every query returns zero rows. Always test the init string independently in SQL*Plus before deploying to the RPD.

**APPS user password changes break the connection pool.** If the APPS schema password is rotated, the RPD connection pool stops working immediately. Consider a dedicated read-only reporting user (\`BI_REPORTING\`) granted SELECT on required views rather than using APPS directly.

**Date-tracked table joins missing effective date.** \`PER_ALL_PEOPLE_F\` and \`PER_ALL_ASSIGNMENTS_F\` return duplicate rows if the effective-date filter is missing. Every join to a \`_F\` table must include the \`effective_start_date\`/\`effective_end_date\` filter.

**NUMBER precision differences.** EBS uses \`NUMBER\` columns without explicit precision on many amount fields. OBIEE maps these to the physical layer as \`DOUBLE\` by default, which can cause floating-point rounding in aggregations. Override the physical column data type to \`DECIMAL(28,2)\` in the RPD for amount columns.

**NLS settings.** The EBS database NLS character set must match the OBIEE connection pool NLS settings. Mismatches cause character corruption in reports containing non-ASCII characters. Set \`NLS_CHARACTERSET=AL32UTF8\` in the connection pool's session init string if not already the database default.

The companion runbook covers the complete RPD configuration, connection pool setup, Init Block creation, and validation procedure.`,
};

async function main() {
  console.log('Inserting OBIEE EBS data integration blog post...');
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
