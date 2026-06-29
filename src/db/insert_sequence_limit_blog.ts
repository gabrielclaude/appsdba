import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Running Out of Runway: Managing Database Sequence Limits in Oracle EBS',
  slug: 'oracle-ebs-sequence-limit-management',
  excerpt:
    'A single database sequence quietly hitting its ceiling can halt order fulfillment, pick release, and ship confirmation across an entire Oracle EBS environment during peak business hours — with no server crash, no network outage, and no visible warning until ORA-08004 fires. This post explains how Oracle sequences work, what WSH_STOP_BATCH_S does in the Shipping Execution module, the two safe remediation paths (raising MAXVALUE vs a controlled negative-increment reset), how to identify other at-risk sequences in EBS before they fail, and a proactive monitoring strategy that catches sequences at 80% capacity before they become a P1 incident.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-29'),
  youtubeUrl: null,
  content: `## Introduction

Imagine it is peak business hours. Orders are flowing, inventory is moving, warehouse staff are confirming shipments, and the billing system is processing invoices downstream. Then, without warning, the shipping application stops. No new batches can be created. Pick release requests queue up and fail. The operations team opens tickets. Management escalates. A war room convenes.

The culprit is not a server crash, a network partition, or a storage failure. It is a single integer counter — a database sequence — that silently reached its maximum value and refused to generate another number.

This is a real, recurring scenario in Oracle EBS environments, and it is entirely avoidable. Unlike hardware failures or code bugs, sequence exhaustion is completely predictable: every sequence has a defined ceiling, a measurable current value, and a calculable time-to-exhaustion. The problem is that the ceiling is rarely monitored, the current value is rarely reviewed, and the first signal most operations teams receive is a P1 incident in the middle of peak processing.

This post explains how Oracle sequences work, what the Shipping Execution module's \`WSH_STOP_BATCH_S\` sequence does and why its exhaustion cascades into a complete order fulfillment halt, the two safe remediation approaches for a sequence at or near its limit, and how to build a proactive monitoring strategy that catches at-risk sequences weeks before they fail.

---

## What an Oracle Sequence Is and How EBS Uses Them

An Oracle sequence is a schema object that generates a monotonically increasing (or decreasing) series of unique integers on demand. Applications call \`SEQUENCE_NAME.NEXTVAL\` to obtain the next value; the database guarantees uniqueness across concurrent sessions without requiring row-level locking on the sequence object itself.

In Oracle EBS, sequences are the primary mechanism for generating primary keys across every functional module. When a user enters a sales order, \`OE_ORDER_HEADERS_S.NEXTVAL\` provides the \`HEADER_ID\`. When RMAN writes a backup piece, internal sequences generate piece IDs. When Shipping Execution creates a delivery, \`WSH_DELIVERY_DETAILS_S.NEXTVAL\` provides the \`DELIVERY_DETAIL_ID\`. Every insert into every key EBS transaction table is guarded by a sequence call.

A sequence is created with several defining parameters:

\`\`\`sql
CREATE SEQUENCE apps.wsh_stop_batch_s
  START WITH   1
  INCREMENT BY 1
  MAXVALUE     999999
  NOCYCLE
  CACHE        20;
\`\`\`

| Parameter | Purpose | Risk |
|---|---|---|
| START WITH | Initial value | Fixed at creation |
| INCREMENT BY | Step per call | Usually 1; becomes important during reset |
| MAXVALUE | Hard ceiling | If NOCYCLE, calls beyond this throw ORA-08004 |
| NOCYCLE | No wrap-around after MAXVALUE | Exhaustion = hard failure |
| CYCLE | Wraps to MINVALUE after MAXVALUE | Risks primary key conflicts on historical data |
| CACHE | Pre-allocated values in memory | Causes gaps after instance restarts |

The combination of \`NOCYCLE\` and a fixed \`MAXVALUE\` is the standard EBS configuration. It prevents the primary key reuse that \`CYCLE\` would introduce, but it means the sequence will fail hard when it reaches its ceiling rather than wrapping around.

---

## WSH_STOP_BATCH_S: What It Controls and Why It Matters

\`WSH_STOP_BATCH_S\` is the sequence Oracle Shipping Execution uses to generate batch identifiers when processing delivery stops and trip scheduling. When a pick release batch is initiated — whether from the Pick Release SRS concurrent program, from the Shipping Transactions form, or programmatically through the shipping API — this sequence provides the internal \`BATCH_ID\` that groups all the delivery details in that processing run.

Without a valid \`NEXTVAL\` from \`WSH_STOP_BATCH_S\`, the shipping engine cannot create the batch record. Without the batch record, pick release cannot proceed. Without pick release, deliveries cannot be confirmed. Without confirmed deliveries, inventory quantities are not updated, invoices cannot be generated, and the entire order-to-cash workflow stalls.

The cascade is not limited to the shipping module:

\`\`\`
WSH_STOP_BATCH_S exhausted
    │
    ├── Pick release batches fail to create
    │     └── Delivery details remain in READY TO RELEASE status
    │           └── Ship confirmation cannot proceed
    │
    ├── Inventory on-hand not updated (no confirmed shipments)
    │
    ├── AR auto-invoice cannot generate invoices (no ship-confirmed lines)
    │
    └── Revenue recognition stalls for all affected orders
\`\`\`

A sequence that appears to be a low-level technical detail controls a critical revenue-generating workflow end to end.

---

## How Sequence Exhaustion Manifests

When a sequence is defined as \`NOCYCLE\` and a call to \`NEXTVAL\` would exceed \`MAXVALUE\`, Oracle raises:

\`\`\`
ORA-08004: sequence WSH_STOP_BATCH_S.NEXTVAL exceeds MAXVALUE and cannot be instantiated
\`\`\`

From the EBS application layer, this rarely surfaces as a clean \`ORA-08004\`. The sequence call is buried inside a PL/SQL procedure or an API call stack. The exception propagates up through several layers and is caught generically, producing application-level error messages like:

\`\`\`
APP-WSH-00001: Error while trying to process pick release batch
\`\`\`

or

\`\`\`
FRM-40735: ON-INSERT trigger raised unhandled exception ORA-08004
\`\`\`

The ORA-08004 appears in the concurrent request log, in the alert log, or in the FND debug log — rarely directly on screen. DBAs investigating a pick release failure may spend significant time on functional configuration before discovering that the root cause is a two-word sequence definition problem: \`MAXVALUE 999999\`.

### Checking a Sequence's Current State

\`\`\`sql
-- Examine WSH_STOP_BATCH_S (or any suspect sequence)
SELECT sequence_owner,
       sequence_name,
       min_value,
       max_value,
       increment_by,
       cycle_flag,
       cache_size,
       last_number,
       max_value - last_number AS values_remaining,
       ROUND(last_number / NULLIF(max_value, 0) * 100, 4) AS pct_consumed
FROM dba_sequences
WHERE sequence_name = 'WSH_STOP_BATCH_S'
  AND sequence_owner = 'APPS';
\`\`\`

Note that \`LAST_NUMBER\` in \`DBA_SEQUENCES\` reflects the next value that will be allocated from disk — not the last value actually issued to a caller. Due to sequence caching, \`LAST_NUMBER\` is always ahead of the last-issued value by up to \`CACHE_SIZE\` increments. In a RAC environment, each instance has its own cache, so the true highest-issued value may be up to \`CACHE_SIZE × NUMBER_OF_INSTANCES\` less than \`LAST_NUMBER\`.

---

## Option 1: Raise the MAXVALUE (Recommended)

If the column that stores the sequence value can hold a larger number, the cleanest fix is to raise \`MAXVALUE\`. This is a zero-risk, zero-downtime operation that completes instantly. The sequence continues from its current value without interruption.

\`\`\`sql
-- Before raising, confirm the current state
SELECT last_number, max_value, max_value - last_number AS remaining
FROM dba_sequences
WHERE sequence_name = 'WSH_STOP_BATCH_S' AND sequence_owner = 'APPS';

-- Raise MAXVALUE to accommodate the next several years of volume
ALTER SEQUENCE APPS.WSH_STOP_BATCH_S MAXVALUE 9999999999;

-- Verify
SELECT last_number, max_value, max_value - last_number AS remaining
FROM dba_sequences
WHERE sequence_name = 'WSH_STOP_BATCH_S' AND sequence_owner = 'APPS';
\`\`\`

### Column Data Type Check

Before raising \`MAXVALUE\`, verify the column that stores the sequence value can hold the new ceiling without truncation or overflow:

\`\`\`sql
-- Find tables that use WSH_STOP_BATCH_S values
-- The column is typically BATCH_ID in WSH_TRIPS_STOPS or a related shipping table
SELECT c.table_name,
       c.column_name,
       c.data_type,
       c.data_precision,
       c.data_scale,
       c.nullable
FROM dba_tab_columns c
WHERE c.table_name IN ('WSH_TRIPS_STOPS', 'WSH_TRIP_STOPS', 'WSH_PICKING_BATCHES')
  AND c.column_name LIKE '%BATCH%'
ORDER BY c.table_name, c.column_name;
\`\`\`

A \`NUMBER\` column without explicit precision can store up to 38 significant digits — effectively unlimited. A \`NUMBER(7)\` column can hold a maximum of 9,999,999. A \`NUMBER(9)\` holds up to 999,999,999. If the column definition allows it, always prefer raising \`MAXVALUE\` over resetting the sequence.

---

## Option 2: Controlled Negative-Increment Reset (When MAXVALUE Cannot Be Raised)

If the column precision or an application-side validation prevents raising \`MAXVALUE\`, the alternative is a controlled reset: temporarily set the sequence increment to a large negative value, advance the sequence by one step to drop its current value, then restore the original increment. No sequence is dropped or recreated — all grants, synonyms, and dependencies are preserved.

**Critical prerequisite**: confirm that the proposed new starting value does not conflict with existing primary key values in the target tables. A sequence reset to a value already present in the table will cause \`ORA-00001: unique constraint violated\` errors on the next inserts.

\`\`\`sql
-- Step 1: Find the current LAST_NUMBER and determine how far back to reset
SELECT last_number, max_value, increment_by, cache_size
FROM dba_sequences
WHERE sequence_name = 'WSH_STOP_BATCH_S' AND sequence_owner = 'APPS';
-- Assume: last_number = 999901, and we want to reset to 1001

-- Step 2: Check that no existing batch_id in the target table conflicts with the new range
SELECT MAX(batch_id) AS highest_existing_batch_id
FROM wsh_picking_batches;
-- If MAX = 150, then resetting to 1001 is safe — the new sequence starts above all existing records

-- Step 3: Calculate the negative increment needed
-- We need the sequence to jump from 999901 back to 1001
-- That is a drop of 999901 - 1001 = 998900
-- We use -(998900 + 1) = -998901 to account for the NEXTVAL call itself

ALTER SEQUENCE APPS.WSH_STOP_BATCH_S INCREMENT BY -998900 MINVALUE 1;

-- Step 4: Call NEXTVAL once to execute the drop
SELECT APPS.WSH_STOP_BATCH_S.NEXTVAL FROM DUAL;
-- Sequence is now at 1001

-- Step 5: Restore the original increment
ALTER SEQUENCE APPS.WSH_STOP_BATCH_S INCREMENT BY 1;

-- Step 6: Verify the new current value
SELECT APPS.WSH_STOP_BATCH_S.NEXTVAL FROM DUAL;
-- Should return 1002 (one step past the post-reset value)
\`\`\`

**Perform this operation during a maintenance window** with no active shipping transactions. Any in-flight pick release batch that calls \`NEXTVAL\` during the negative-increment step may receive an unexpectedly low value that conflicts with existing records.

---

## Common EBS Sequences That Approach Limits

\`WSH_STOP_BATCH_S\` is not the only EBS sequence that can exhaust. High-volume environments should monitor all of these:

| Sequence | Module | Table | Impact if Exhausted |
|---|---|---|---|
| WSH_STOP_BATCH_S | Shipping | WSH_PICKING_BATCHES | Pick release halted |
| WSH_DELIVERY_DETAILS_S | Shipping | WSH_DELIVERY_DETAILS | Delivery detail creation fails |
| WSH_TRIPS_S | Shipping | WSH_TRIPS | Trip creation fails |
| OE_ORDER_HEADERS_S | Order Management | OE_ORDER_HEADERS | New order entry fails |
| OE_ORDER_LINES_S | Order Management | OE_ORDER_LINES | Order line creation fails |
| MTL_MATERIAL_TRANSACTIONS_S | Inventory | MTL_MATERIAL_TRANSACTIONS | Inventory transactions fail |
| FND_CONCURRENT_REQUESTS_S | Concurrent Manager | FND_CONCURRENT_REQUESTS | All concurrent programs fail |
| AP_CHECKS_S | Payables | AP_CHECKS | Payment processing fails |
| AR_RECEIVABLE_APPLICATIONS_S | Receivables | AR_RECEIVABLE_APPLICATIONS | Cash application fails |
| WF_ITEMS_S | Workflow | WF_ITEMS | All workflow-driven processes fail |

Sequences in lower-volume modules may take years to approach their limit. High-volume transactional sequences in Order Management, Shipping, and Inventory can exhaust within months if their \`MAXVALUE\` was set conservatively at implementation.

---

## Example 1: WSH_STOP_BATCH_S at 99.97% — Emergency Raise

**Scenario**: A DBA receives a P2 ticket at 14:00 reporting intermittent pick release failures. A query shows \`WSH_STOP_BATCH_S\` at \`LAST_NUMBER = 998,900\` against a \`MAXVALUE = 999,999\`. At the current daily pick volume of ~300 batches per day, exhaustion is 3.6 days away.

\`\`\`sql
-- Confirm: column in WSH_PICKING_BATCHES is NUMBER with no precision limit
SELECT column_name, data_type, data_precision
FROM dba_tab_columns
WHERE table_name = 'WSH_PICKING_BATCHES' AND column_name = 'BATCH_ID';
-- Result: NUMBER (no precision) → safe to raise to 9,999,999,999

ALTER SEQUENCE APPS.WSH_STOP_BATCH_S MAXVALUE 9999999999;
\`\`\`

Total downtime: zero. Operation completes in under one second.

---

## Example 2: OE_ORDER_HEADERS_S — Reset Required Due to Legacy Column Constraint

**Scenario**: \`OE_ORDER_HEADERS_S\` has \`MAXVALUE = 9999999\` and \`LAST_NUMBER = 9999850\`. The \`HEADER_ID\` column is defined as \`NUMBER(7)\` due to a legacy integration system that sends seven-digit order IDs. Raising \`MAXVALUE\` beyond 9,999,999 would exceed the column's data type. A reset is required.

\`\`\`sql
-- Check highest existing HEADER_ID to find a safe reset target
SELECT MAX(header_id) FROM oe_order_headers_all;
-- Result: 4,821,033

-- There are 5,178,966 values between 4,821,034 and 9,999,999
-- Reset to 5,000,000 to give clean headroom above existing records

-- Current LAST_NUMBER is 9,999,850. Drop to 5,000,001.
-- Negative increment = 9,999,850 - 5,000,001 = 4,999,849

ALTER SEQUENCE APPS.OE_ORDER_HEADERS_S INCREMENT BY -4999849 MINVALUE 1;
SELECT APPS.OE_ORDER_HEADERS_S.NEXTVAL FROM DUAL;  -- drops to ~5,000,001
ALTER SEQUENCE APPS.OE_ORDER_HEADERS_S INCREMENT BY 1;

-- Verify next value is above all existing HEADER_IDs
SELECT APPS.OE_ORDER_HEADERS_S.NEXTVAL FROM DUAL;  -- should be 5,000,002
\`\`\`

---

## Proactive Monitoring: Scanning for At-Risk Sequences

The standard recommendation is to alert when any EBS sequence has consumed 80% of its available range. This provides time for investigation, change control, and scheduling a maintenance window — rather than an emergency fix under production pressure.

\`\`\`sql
-- Weekly scan: sequences consuming more than 80% of their range
SELECT sequence_owner,
       sequence_name,
       last_number,
       max_value,
       max_value - last_number AS values_remaining,
       ROUND(last_number / NULLIF(max_value, 0) * 100, 2) AS pct_consumed,
       CASE
         WHEN last_number / NULLIF(max_value, 0) >= 0.99 THEN 'CRITICAL'
         WHEN last_number / NULLIF(max_value, 0) >= 0.90 THEN 'WARNING'
         WHEN last_number / NULLIF(max_value, 0) >= 0.80 THEN 'WATCH'
         ELSE 'OK'
       END AS status
FROM dba_sequences
WHERE sequence_owner IN ('APPS', 'WSH', 'ONT', 'INV', 'AR', 'AP', 'WF', 'FND')
  AND cycle_flag = 'N'
  AND last_number / NULLIF(max_value, 0) >= 0.80
ORDER BY pct_consumed DESC;
\`\`\`

Schedule this query as a weekly report to the DBA team. Any CRITICAL or WARNING entry becomes a ticket requiring resolution before the next peak processing period.

---

## Summary

Oracle database sequences are the invisible scaffolding that makes every EBS transaction possible. They are created once, increment quietly in the background, and are rarely reviewed until they stop working. When a critical sequence like \`WSH_STOP_BATCH_S\` reaches its \`MAXVALUE\` in a \`NOCYCLE\` configuration, the result is a hard \`ORA-08004\` error that cascades through pick release, ship confirmation, inventory updates, and downstream billing — a P1 outage traceable to a single integer that needed to be larger.

The two remediation paths are both straightforward when executed correctly. **Raising MAXVALUE** is the preferred approach: it is instantaneous, zero-downtime, and zero-risk — provided the column storing the sequence value has sufficient numeric precision. **A controlled negative-increment reset** is the fallback when a column precision constraint prevents raising \`MAXVALUE\`: it preserves all sequence dependencies and completes in seconds, but requires a maintenance window, a careful check against the highest existing primary key value in the target table, and verification that the reset target does not overlap with any historical records.

Neither remediation requires recreating the sequence object. Dropping and recreating a sequence voids all grants, invalidates dependent procedures, and risks losing the exact last-issued value in a concurrent environment. \`ALTER SEQUENCE\` is always the correct path.

The most important takeaway is operational: sequence exhaustion is the rarest class of production outage in that it is 100% predictable and 100% preventable. A weekly scan of \`DBA_SEQUENCES\` comparing \`LAST_NUMBER\` to \`MAXVALUE\` across all APPS-owned sequences, with alerts at 80% and 90% consumption, provides weeks of lead time for a zero-urgency resolution. The companion runbook covers the full diagnostic and remediation sequence, including the monitoring script, the column constraint check, the reset math, and a post-fix verification checklist.`,
};

async function main() {
  console.log('Inserting sequence limit management blog post...');
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
