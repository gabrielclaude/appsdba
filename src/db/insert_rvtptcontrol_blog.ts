import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS 12.1.3: Diagnosing rvtptcontrol Failed During Receiving and Inspection',
  slug: 'oracle-ebs-rvtptcontrol-failed-receiving-inspection-diagnosis',
  excerpt:
    'A production case study for the Oracle EBS rvtptcontrol failed error that blocks Receiving, Inspection, and Delivery across multiple plants: interface table diagnostics, RVCTP debug logging, WebLogic thread-to-database session mapping, and lock chain analysis to find the real root cause behind the cryptic error message.',
  category: 'appsdba' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `Few Oracle EBS errors hit as broadly and as suddenly as a Receiving Transaction Processor failure. One moment your manufacturing plants are processing receipts normally. The next, 20+ users across multiple sites cannot complete a single receiving, inspection, or delivery transaction. The error surfaced in the form log is cryptic — \`rvtptcontrol failed\` — and gives no hint about which of a dozen possible root causes is the actual culprit.

This post documents a real-world production incident on Oracle EBS 12.1.3 and walks through the complete diagnostic path: from interface table inspection through RVCTP debug logging to WebLogic thread-to-database session mapping.

---

## Environment and Symptoms

| Detail | Value |
|--------|-------|
| EBS Version | 12.1.3 |
| Instance | Production |
| Navigation | Inventory → Receiving → Receipts / Receiving Transactions |
| Error | \`rvtptcontrol failed\` |
| Scope | Reproducible on demand across multiple plants |
| Users Impacted | 20+ concurrent users |

When users attempted to save a receiving transaction, the form hung or returned a generic failure message. The underlying concurrent program — the Receiving Transaction Processor (RVCTP / RVCTP) — terminated with the rvtptcontrol error. The issue presented simultaneously across multiple inventory organizations, which immediately ruled out a single user's setup and pointed toward a shared infrastructure or data problem.

---

## What Is rvtptcontrol?

Understanding the error requires understanding where it comes from in the processing stack.

When a user saves a receipt or inspection in EBS, Oracle:
1. Inserts the transaction into the interface staging tables (\`RCV_TRANSACTIONS_INTERFACE\` and \`RCV_HEADERS_INTERFACE\`)
2. Calls the C-executable \`rvtptcontrol()\` inside the Receiving Transaction Processor binary
3. \`rvtptcontrol()\` reads the interface records, validates data integrity, determines the processing mode (Online, Immediate, or Batch), and routes records to the processing engines

\`rvtptcontrol()\` is the traffic cop before any real processing begins. When it fails, it means a pre-validation check broke or a database-level exception occurred before individual rows could be processed. The error is generic by design — it surfaces failures from multiple possible validation paths under a single message.

---

## The Processing Mode Architecture

The behavior of \`rvtptcontrol\` varies significantly depending on the configured processing mode, which controls how the transaction request flows through the middle tier:

| Mode | Processing Path | When rvtptcontrol Failure Is Visible |
|------|----------------|--------------------------------------|
| **Online** | WebLogic thread → database session (synchronous) | Immediately — form hangs or errors in real-time |
| **Immediate** | Concurrent manager spawned synchronously | Within seconds — request log generated |
| **Batch** | Scheduled concurrent request | On next batch run |

When \`RCV: Processing Mode\` is set to **Online**, the EBS form passes the transaction directly to the WebLogic managed server (typically \`oacore_server\`), which communicates synchronously with the database. If it hangs here, mapping the WebLogic thread to the database session is essential — covered in detail later in this post.

---

## Step 1: Check for Stuck Interface Records

When multiple plants report the issue simultaneously, the most likely first scenario is a corrupt or locked record in the interface table blocking the processor. Run a status breakdown:

\`\`\`sql
-- Interface table status breakdown
SELECT processing_status_code,
       transaction_status_code,
       COUNT(*) AS record_count,
       MIN(creation_date) AS oldest_record,
       MAX(creation_date) AS newest_record
FROM   rcv_transactions_interface
GROUP BY processing_status_code, transaction_status_code
ORDER BY record_count DESC;
\`\`\`

The key statuses to watch:

| processing_status_code | Meaning |
|-----------------------|---------|
| \`PENDING\` | Waiting to be processed — normal |
| \`RUNNING\` | Currently being processed |
| \`ERROR\` | Failed — blocking the queue |
| \`SUCCESS\` | Completed — should be aged out |

If \`ERROR\` rows are accumulating, read the interface error table for the actual failure messages:

\`\`\`sql
-- Detailed error messages for failed interface records
SELECT pie.interface_type,
       pie.error_message,
       pie.error_message_name,
       pie.table_name,
       pie.column_name,
       rti.transaction_type,
       rti.item_description,
       rti.quantity
FROM   po_interface_errors        pie
JOIN   rcv_transactions_interface rti
       ON rti.interface_transaction_id = pie.interface_transaction_id
WHERE  pie.interface_table_name = 'RCV_TRANSACTIONS_INTERFACE'
ORDER BY pie.creation_date DESC
FETCH FIRST 30 ROWS ONLY;
\`\`\`

---

## Step 2: Enable Receiving Engine Debug Logging

If the interface tables do not reveal an obvious error, enable debug logging to capture the exact SQL or validation error causing \`rvtptcontrol\` to fail.

### Profile Options to Set (at User Level for the Reproducing User)

| Profile Option | Value | Purpose |
|---------------|-------|---------|
| RCV: Processing Mode | **Online** | Forces synchronous processing — log is immediate |
| INV: Debug Trace | **Yes** | Enables C-executable debug output |
| INV: Debug Level | **11** | Maximum verbosity |
| TP: INV Transaction Processing Mode | **Online** | Ensures the transaction processor runs in-session |

Set these via: **System Administrator → Profiles → User** for the specific user who will reproduce the error.

### Reproducing and Locating the Log

After setting the profiles, have the user reproduce the error. Then locate the RVCTP log:

\`\`\`sql
-- Find the most recent RVCTP concurrent request log
SELECT r.request_id,
       r.phase_code,
       r.status_code,
       r.actual_start_date,
       r.actual_completion_date,
       r.logfile_name
FROM   fnd_concurrent_requests  r
JOIN   fnd_concurrent_programs  p
       ON  p.concurrent_program_id = r.concurrent_program_id
       AND p.application_id        = r.program_application_id
WHERE  p.concurrent_program_name IN ('RVCTP','RVCTP_ONLINE')
ORDER BY r.actual_start_date DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

Open the log file and search for \`rvtptcontrol\` or \`rvtptccreate\`. The real error appears immediately after these strings.

---

## Common Root Causes Found in RVCTP Logs

### Unit of Measure Mismatch

The most frequent cause in multi-plant environments. A conversion rate is missing between the item's primary UOM and the receiving UOM:

\`\`\`
rvtptcontrol: Error - No UOM conversion defined for item 12345
              From UOM: LB  To UOM: KG
\`\`\`

**Diagnosis:**

\`\`\`sql
-- Check for missing UOM conversions for items with active PO lines
SELECT pol.item_id,
       pol.unit_meas_lookup_code   AS po_uom,
       msi.primary_uom_code        AS primary_uom,
       muc.conversion_rate
FROM   po_lines_all   pol
JOIN   mtl_system_items_b msi
       ON  msi.inventory_item_id = pol.item_id
       AND msi.organization_id   = :receiving_org_id
LEFT JOIN mtl_uom_conversions muc
       ON  muc.inventory_item_id  = pol.item_id
       AND muc.uom_code           = pol.unit_meas_lookup_code
WHERE  muc.conversion_rate IS NULL
  AND  pol.unit_meas_lookup_code != msi.primary_uom_code
  AND  pol.po_header_id IN (
         SELECT po_header_id FROM rcv_transactions_interface
         WHERE  processing_status_code = 'ERROR'
       );
\`\`\`

### Closed Accounting Period

If the inventory period or purchasing period for the transaction date is closed, the processor fails validation before writing any rows:

\`\`\`sql
-- Check open periods for the receiving organization
SELECT organization_id,
       period_name,
       period_start_date,
       schedule_close_date,
       open_flag
FROM   org_acct_periods
WHERE  organization_id IN (
         SELECT organization_id
         FROM   rcv_transactions_interface
         WHERE  processing_status_code = 'ERROR'
       )
  AND  open_flag != 'Y'
  AND  schedule_close_date > SYSDATE - 10
ORDER BY schedule_close_date DESC;
\`\`\`

### Sequence Depletion

The receipt number or transaction sequence has reached its maximum value:

\`\`\`sql
-- Check sequences approaching or at maximum
SELECT sequence_name,
       last_number,
       max_value,
       ROUND(last_number / max_value * 100, 2) AS pct_consumed
FROM   dba_sequences
WHERE  sequence_name IN ('RCV_HEADERS_INTERFACE_S','RCV_TRANSACTIONS_INTERFACE_S',
                         'RCV_SHIPMENT_HEADERS_S','RCV_SHIPMENT_LINES_S')
ORDER BY pct_consumed DESC;
\`\`\`

### Custom PL/SQL Trigger Exception

Custom triggers on \`RCV_TRANSACTIONS\` or \`MTL_MATERIAL_TRANSACTIONS\` throwing unhandled exceptions produce rvtptcontrol failures with no application-level error message. Check for custom triggers:

\`\`\`sql
-- Custom triggers on receiving and inventory tables
SELECT owner, trigger_name, trigger_type, triggering_event, status
FROM   dba_triggers
WHERE  table_name IN ('RCV_TRANSACTIONS','RCV_SHIPMENT_LINES',
                      'MTL_MATERIAL_TRANSACTIONS','RCV_SHIPMENT_HEADERS')
  AND  owner != 'SYS'
ORDER BY table_name, trigger_name;
\`\`\`

---

## Step 3: Map WebLogic Threads to Database Sessions

When \`RCV: Processing Mode\` is Online, the failure happens synchronously inside a WebLogic thread. To diagnose a hang, you need to connect what WebLogic reports as a stuck thread to the exact Oracle database session executing the SQL.

### The Architecture Flow

\`\`\`
User (EBS Forms / OAF)
  → WebLogic oacore_server (ExecuteThread)
    → JDBC Connection Pool → Oracle Database Session (V$SESSION)
      → rvtptcontrol() C-executable or PL/SQL API
\`\`\`

### Identify the Stuck Thread in WebLogic

**Via WebLogic Admin Console:**
1. Navigate: **Environment → Servers → oacore_server1 → Monitoring → Threads**
2. Look for threads with status **Stuck** or **Hogging**
3. Note the exact thread name, e.g.: \`ExecuteThread: '12' for queue: 'weblogic.kernel.Default (self-tuning)'\`

**Via command-line thread dump:**

\`\`\`bash
# Find the WebLogic oacore PID
ps -ef | grep oacore | grep -v grep

# Send SIGQUIT to write a thread dump to the server's stdout log
kill -3 <weblogic_pid>

# The thread dump appears in:
grep -A 20 "ExecuteThread.*Stuck\|rvtpt\|rcv_transactions" \
  $APPLCSF/log/oacore_server1.out | head -60
\`\`\`

Look for a thread stack containing Oracle JDBC classes and note the thread name.

### Map the Thread to a Database Session

\`\`\`sql
-- Find all database sessions from WebLogic — look for CLIENT_IDENTIFIER
-- containing the stuck thread name
SELECT s.sid,
       s.serial#,
       s.process           AS client_os_pid,
       p.spid              AS db_server_pid,
       s.osuser,
       s.machine,
       s.program,
       s.client_identifier,
       s.module,
       s.action,
       s.sql_id,
       s.status,
       s.event,
       s.seconds_in_wait
FROM   v\$session s
JOIN   v\$process p ON p.addr = s.paddr
WHERE  (s.program LIKE '%WebLogic%'
     OR s.client_identifier LIKE '%ExecuteThread%')
  AND  s.status = 'ACTIVE'
ORDER BY s.seconds_in_wait DESC;
\`\`\`

If your environment populates the full thread name in \`CLIENT_IDENTIFIER\`:

\`\`\`sql
-- Target the specific stuck thread from the thread dump
SELECT sid, serial#, program, sql_id, status, event, seconds_in_wait
FROM   v\$session
WHERE  client_identifier LIKE '%ExecuteThread: ''12''%';
\`\`\`

### Drill Into the Active SQL

Once you have the \`SID\` and \`SQL_ID\`:

\`\`\`sql
-- See exactly what SQL the stuck session is executing
SELECT sql_text,
       elapsed_time / 1e6   AS elapsed_sec,
       executions,
       buffer_gets,
       disk_reads
FROM   v\$sql
WHERE  sql_id = '&target_sql_id';
\`\`\`

---

## Step 4: Diagnose Locks Blocking the Online Processor

The multi-plant, multi-user nature of this failure often points to a lock chain. One session holding a row lock or a sequence cache lock blocks every other online receiving transaction that needs the same resource.

### Check What the Stuck Session Is Waiting On

\`\`\`sql
-- Blocking chain for the stuck WebLogic session
SELECT s.sid             AS waiting_sid,
       s.serial#         AS waiting_serial,
       s.event           AS wait_event,
       s.p1text,
       s.p1,
       s.p2text,
       s.p2,
       s.blocking_session  AS blocking_sid,
       s.blocking_session_serial# AS blocking_serial,
       bs.program        AS blocking_program,
       bs.module         AS blocking_module,
       bs.sql_id         AS blocking_sql_id,
       bs.seconds_in_wait AS blocker_wait_secs
FROM   v\$session s
LEFT JOIN v\$session bs ON bs.sid = s.blocking_session
WHERE  s.sid = &target_sid;
\`\`\`

### Full Blocking Chain (Multi-Level)

If the blocking session is itself blocked, trace the full chain:

\`\`\`sql
SELECT LEVEL,
       s.sid,
       s.serial#,
       s.event,
       s.blocking_session,
       s.module,
       s.sql_id,
       s.seconds_in_wait
FROM   v\$session s
START WITH s.sid = &target_sid
CONNECT BY PRIOR s.blocking_session = s.sid
ORDER SIBLINGS BY s.seconds_in_wait DESC;
\`\`\`

### Check ASH for Recent Lock History

If the session resolved itself before you ran the query, use ASH to reconstruct what happened:

\`\`\`sql
-- ASH lock wait history for the last 30 minutes
SELECT ash.session_id,
       ash.blocking_session,
       ash.event,
       ash.sql_id,
       ash.module,
       COUNT(*) * 10    AS approx_wait_seconds
FROM   v\$active_session_history ash
WHERE  ash.sample_time  > SYSDATE - 30/1440
  AND  ash.event LIKE '%enq%'
  AND  ash.module LIKE '%RCV%'
GROUP BY ash.session_id, ash.blocking_session, ash.event, ash.sql_id, ash.module
ORDER BY approx_wait_seconds DESC;
\`\`\`

---

## Step 5: Clearing the Interface Backlog

Once the root cause is identified and fixed, clear the stuck interface records to restore normal processing.

### Archive and reset ERROR rows

\`\`\`sql
-- Review before deleting — confirm these are the stuck rows
SELECT COUNT(*), processing_status_code
FROM   rcv_transactions_interface
WHERE  processing_status_code IN ('ERROR','PENDING')
  AND  creation_date < SYSDATE - 1/24  -- Older than 1 hour
GROUP BY processing_status_code;

-- Archive to a holding table before deletion
CREATE TABLE rcv_intf_archive_backup AS
SELECT * FROM rcv_transactions_interface
WHERE  processing_status_code = 'ERROR';

-- Delete the ERROR rows (only after root cause is fixed)
DELETE FROM rcv_transactions_interface
WHERE  processing_status_code = 'ERROR'
  AND  group_id IN (
         SELECT group_id FROM rcv_intf_archive_backup
       );
COMMIT;
\`\`\`

### Restart the Receiving Transaction Processor managers

\`\`\`
Concurrent Manager Administration → Administer → Receiving Transaction Processor
Action: Deactivate → Activate
\`\`\`

---

## Summary and Best Practices

### Root Cause Decision Tree

\`\`\`
rvtptcontrol failed (multi-plant, simultaneous)
  │
  ├─ ERROR rows in RCV_TRANSACTIONS_INTERFACE?
  │    ├─ Yes → Read PO_INTERFACE_ERRORS → UOM? Period? Trigger?
  │    └─ No  → Enable INV:Debug + RVCTP log → Read exact C-level error
  │
  ├─ Processing Mode = Online → WebLogic thread hanging?
  │    └─ Yes → Thread dump → Map to V$SESSION → Check event + blocking_session
  │
  └─ Blocking_session populated in V$SESSION?
       └─ Yes → Trace full lock chain → Kill root blocker if uncommitted long
\`\`\`

### Best Practices

1. **Monitor \`RCV_TRANSACTIONS_INTERFACE\` for ERROR rows proactively.** A small number of stuck rows can cascade into a full processor stall affecting every plant. A daily alert when ERROR count exceeds 10 prevents surprise production outages.

2. **Run RVCTP in Online mode during troubleshooting, then return to Immediate or Batch.** Online mode produces the most detailed logs but adds synchronous latency to every user transaction in production.

3. **Never delete interface records without archiving first.** Stuck ERROR rows often contain the data that proves which item, PO, or plant triggered the failure — deleting them destroys the forensic evidence.

4. **Map WebLogic thread dumps to \`V\$SESSION\` using \`CLIENT_IDENTIFIER\`.** When the form hangs, the database session is still alive. The WebLogic thread dump tells you which thread; the \`CLIENT_IDENTIFIER\` in \`V\$SESSION\` connects it to the exact database activity.

5. **Validate UOM conversions after every new item or PO line setup in a multi-org environment.** Missing conversions are the most common silent cause of rvtptcontrol failures in manufacturing deployments with mixed metric and imperial units across plants.

6. **Check open periods before every month-end receiving push.** A period close on one organization blocks receiving transactions for that org even while other orgs continue processing — producing the confusing "some plants work, some don't" pattern.

The companion runbook covers the complete step-by-step diagnostic procedure, all SQL queries formatted for immediate use, the RVCTP manager restart sequence, and a monitoring script that continuously watches interface error accumulation and WebLogic thread health.`,
};

async function main() {
  console.log('Inserting rvtptcontrol blog post...');
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
