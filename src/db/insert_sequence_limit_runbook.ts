import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS Sequence Limit Runbook: Diagnosing, Remediating, and Monitoring Sequence Exhaustion',
  slug: 'oracle-ebs-sequence-limit-management-runbook',
  excerpt:
    'Step-by-step runbook for managing Oracle sequence exhaustion in EBS environments — from detecting a sequence approaching its MAXVALUE through DBA_SEQUENCES, to the column precision check that determines whether to raise MAXVALUE or perform a controlled negative-increment reset, through the exact ALTER SEQUENCE commands with the math for both paths, post-fix verification, and a weekly crontab monitoring script that alerts the DBA team at 80% and 90% sequence consumption before exhaustion becomes a P1 incident. Covers WSH_STOP_BATCH_S, OE_ORDER_HEADERS_S, FND_CONCURRENT_REQUESTS_S, and eight other high-risk EBS sequences with their target tables and business impact.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-29'),
  youtubeUrl: null,
  content: `## Introduction

This runbook addresses Oracle sequence exhaustion in EBS environments: the condition where a \`NOCYCLE\` sequence reaches its \`MAXVALUE\` and all subsequent calls to \`NEXTVAL\` fail with \`ORA-08004\`. Sequence exhaustion causes hard failures in any EBS workflow that calls the affected sequence — which, for sequences like \`WSH_STOP_BATCH_S\` or \`OE_ORDER_HEADERS_S\`, means order entry, pick release, or ship confirmation stops completely.

This runbook covers two scenarios:
- **Emergency response**: a sequence is already at or near its limit and causing failures
- **Proactive remediation**: monitoring has identified a sequence approaching 80%+ consumption

**Prerequisites**: DBA privilege (SYS or APPS DBA role). All \`ALTER SEQUENCE\` commands execute instantly and do not require downtime for the MAXVALUE raise. The negative-increment reset requires a maintenance window with no active transactions on the affected module.

---

## Phase 1: Detect the Problem Sequence

### Step 1.1 — Check a Specific Suspected Sequence

When a pick release, order entry, or concurrent program fails and the functional investigation reveals no configuration problem, check sequence consumption for the affected module:

\`\`\`sql
-- Full state of a specific sequence
SELECT sequence_owner,
       sequence_name,
       min_value,
       max_value,
       increment_by,
       cycle_flag,
       order_flag,
       cache_size,
       last_number,
       max_value - last_number                                  AS values_remaining,
       ROUND(last_number / NULLIF(max_value, 0) * 100, 4)      AS pct_consumed
FROM dba_sequences
WHERE sequence_name  = 'WSH_STOP_BATCH_S'
  AND sequence_owner = 'APPS';
\`\`\`

**Reading the output**:
- \`pct_consumed >= 100\`: sequence is exhausted — failures are happening right now
- \`pct_consumed >= 99\`: less than 1% remaining — emergency raise required immediately
- \`pct_consumed >= 90\`: WARNING — schedule remediation this week
- \`pct_consumed >= 80\`: WATCH — schedule remediation this month

Note: \`last_number\` is the next value to be pre-allocated from disk, not the last value issued to an application. Sequence caching means the true last-issued value is up to \`cache_size\` less than \`last_number\`. In a RAC environment with 2 instances and \`cache_size = 20\`, \`last_number\` may be up to 40 ahead of the highest value actually returned to a caller.

### Step 1.2 — Broad Scan: All At-Risk EBS Sequences

\`\`\`sql
-- Find all NOCYCLE sequences consuming 70%+ of their range
-- Run weekly as a proactive check
SELECT sequence_owner,
       sequence_name,
       last_number,
       max_value,
       max_value - last_number                             AS values_remaining,
       ROUND(last_number / NULLIF(max_value, 0) * 100, 2) AS pct_consumed,
       CASE
         WHEN last_number / NULLIF(max_value, 0) >= 0.999 THEN 'EXHAUSTED'
         WHEN last_number / NULLIF(max_value, 0) >= 0.99  THEN 'CRITICAL'
         WHEN last_number / NULLIF(max_value, 0) >= 0.90  THEN 'WARNING'
         WHEN last_number / NULLIF(max_value, 0) >= 0.80  THEN 'WATCH'
         WHEN last_number / NULLIF(max_value, 0) >= 0.70  THEN 'MONITOR'
       END AS status
FROM dba_sequences
WHERE sequence_owner IN ('APPS','WSH','ONT','INV','AR','AP','WF','FND','AX','CE')
  AND cycle_flag = 'N'
  AND last_number / NULLIF(max_value, 0) >= 0.70
ORDER BY pct_consumed DESC;
\`\`\`

### Step 1.3 — Confirm the Sequence Is Causing Application Failures

Check the concurrent request log or alert log for ORA-08004:

\`\`\`bash
# Scan alert log for sequence-related errors
grep -E "(ORA-08004|ORA-02289|MAXVALUE)" \${ORACLE_BASE}/diag/rdbms/\${ORACLE_SID}/\${ORACLE_SID}/trace/alert_\${ORACLE_SID}.log | tail -50

# Check concurrent request output files for ORA-08004
find \${APPLCSF}/\${APPLLOG} -name "*.req" -newer /tmp/hour_ago -exec grep -l "ORA-08004" {} \;
\`\`\`

From within EBS, query the concurrent request for the failing job:

\`\`\`sql
-- Get the error from a failing concurrent request
SELECT cr.request_id,
       cr.phase_code,
       cr.status_code,
       cr.completion_text,
       cr.actual_start_date
FROM fnd_concurrent_requests cr
WHERE cr.status_code IN ('E','X')
  AND cr.actual_start_date >= SYSDATE - 1/24
ORDER BY cr.actual_start_date DESC;

-- Get detailed output log for the failed request
SELECT fl.file_name, fl.file_type
FROM fnd_concurrent_requests cr
JOIN fnd_concurrent_request_files fl ON cr.request_id = fl.request_id
WHERE cr.request_id = &failing_request_id;
\`\`\`

---

## Phase 2: Pre-Remediation Assessment

### Step 2.1 — Identify the Target Table and Column

Find the table that stores values generated by the exhausted sequence:

\`\`\`sql
-- Search for the sequence in package bodies (reveals which table/column it feeds)
SELECT owner, name, line, SUBSTR(text, 1, 200) AS code_text
FROM dba_source
WHERE UPPER(text) LIKE UPPER('%WSH_STOP_BATCH_S%')
  AND type IN ('PACKAGE BODY', 'PROCEDURE', 'TRIGGER')
ORDER BY owner, name, line
FETCH FIRST 20 ROWS ONLY;

-- Also check for table triggers that call the sequence
SELECT trigger_name, table_name, trigger_body
FROM dba_triggers
WHERE UPPER(trigger_body) LIKE UPPER('%WSH_STOP_BATCH_S%');
\`\`\`

Common EBS sequence-to-table mappings for reference:

\`\`\`
WSH_STOP_BATCH_S          → WSH_PICKING_BATCHES.BATCH_ID
WSH_DELIVERY_DETAILS_S    → WSH_DELIVERY_DETAILS.DELIVERY_DETAIL_ID
WSH_TRIPS_S               → WSH_TRIPS.TRIP_ID
OE_ORDER_HEADERS_S        → OE_ORDER_HEADERS_ALL.HEADER_ID
OE_ORDER_LINES_S          → OE_ORDER_LINES_ALL.LINE_ID
MTL_MATERIAL_TRANSACTIONS_S → MTL_MATERIAL_TRANSACTIONS.TRANSACTION_ID
FND_CONCURRENT_REQUESTS_S → FND_CONCURRENT_REQUESTS.REQUEST_ID
AP_CHECKS_S               → AP_CHECKS_ALL.CHECK_ID
AR_RECEIVABLE_APPLICATIONS_S → AR_RECEIVABLE_APPLICATIONS_ALL.RECEIVABLE_APPLICATION_ID
WF_ITEMS_S                → WF_ITEMS.ITEM_KEY (partial)
\`\`\`

### Step 2.2 — Check the Column Data Type

This determines whether MAXVALUE can be raised or a reset is required:

\`\`\`sql
-- Check the data type and precision of the column fed by the sequence
SELECT c.table_name,
       c.column_name,
       c.data_type,
       c.data_precision,
       c.data_scale,
       c.data_length,
       c.nullable
FROM dba_tab_columns c
WHERE c.table_name = UPPER('&target_table_name')
  AND c.column_name = UPPER('&sequence_column_name');
\`\`\`

**Interpretation**:

| Column definition | Maximum storable value | Can raise MAXVALUE to? |
|---|---|---|
| NUMBER (no precision) | 9.99 × 10^37 | Virtually unlimited |
| NUMBER(9) | 999,999,999 | Up to 999,999,999 |
| NUMBER(7) | 9,999,999 | Up to 9,999,999 |
| NUMBER(6) | 999,999 | Up to 999,999 |

If the column is \`NUMBER\` without precision, always use Option A (raise MAXVALUE). If the column has a precision that already matches the current \`MAXVALUE\`, use Option B (controlled reset).

### Step 2.3 — Find the Highest Existing Value in the Target Table

For Option B (reset) only. This is the floor below which the new sequence starting point cannot fall:

\`\`\`sql
-- Find the maximum existing value in the sequence's primary key column
SELECT MAX(batch_id) AS max_existing_value
FROM wsh_picking_batches;

-- Also check any related archive or history tables
SELECT MAX(batch_id) AS max_in_history
FROM wsh_picking_batches_history;
-- (if such a table exists — substitute with the actual archive table name)
\`\`\`

The reset target must be above \`MAX(column_value)\` across all tables (including archive/history) that reference this sequence. The safe margin is the reset target minus the highest existing value. A margin of at least 10,000 is recommended.

---

## Phase 3A: Remediation — Raise MAXVALUE (Option A)

Use this when the column precision allows a larger value. Zero downtime, zero risk.

### Step 3A.1 — Execute the MAXVALUE Raise

\`\`\`sql
-- Record the before state
SELECT last_number, max_value, max_value - last_number AS remaining
FROM dba_sequences
WHERE sequence_name = 'WSH_STOP_BATCH_S' AND sequence_owner = 'APPS';

-- Raise MAXVALUE
-- Choose a value that provides many years of runway at the current consumption rate
-- For a sequence consuming 1,000 values/day: 365 * 1000 * 10 years = 3,650,000 additional headroom
ALTER SEQUENCE APPS.WSH_STOP_BATCH_S MAXVALUE 9999999999;

-- Optionally increase the cache to reduce I/O overhead on high-volume sequences
ALTER SEQUENCE APPS.WSH_STOP_BATCH_S CACHE 100;

-- Verify
SELECT last_number, max_value, max_value - last_number AS remaining,
       ROUND(last_number / max_value * 100, 4) AS pct_consumed
FROM dba_sequences
WHERE sequence_name = 'WSH_STOP_BATCH_S' AND sequence_owner = 'APPS';
\`\`\`

### Step 3A.2 — Confirm Application Is Processing Normally

Immediately after the ALTER SEQUENCE:

\`\`\`sql
-- Confirm the sequence now generates values without error
SELECT APPS.WSH_STOP_BATCH_S.NEXTVAL FROM DUAL;

-- Re-run a pick release batch that was previously failing (from the EBS Shipping form)
-- Or re-submit the failed concurrent request
\`\`\`

---

## Phase 3B: Remediation — Controlled Negative-Increment Reset (Option B)

Use this when the column precision prevents raising MAXVALUE. Requires a maintenance window.

### Step 3B.1 — Maintenance Window Preparation

Before executing:
1. Confirm no active shipping transactions are running (check \`WSH_PICKING_BATCHES\` for recent inserts)
2. Confirm the concurrent manager is paused for the affected module
3. Have the highest existing value from Step 2.3 confirmed and documented
4. Calculate the exact negative increment needed

\`\`\`sql
-- Gather all values needed for the calculation
SELECT sequence_name,
       last_number AS current_last_number,
       max_value,
       min_value,
       increment_by AS original_increment,
       cache_size
FROM dba_sequences
WHERE sequence_name = 'WSH_STOP_BATCH_S' AND sequence_owner = 'APPS';

-- Highest existing value in target table (from Step 2.3)
-- Example: highest_existing = 125,000

-- Proposed reset target: highest_existing + safety_margin
-- Example: 125,000 + 10,000 = 135,000

-- Current last_number: 999,901 (LAST_NUMBER from DBA_SEQUENCES)
-- NOTE: due to caching, the actual next NEXTVAL will be >= 999,881 (last_number - cache_size)
-- Use last_number directly; the NEXTVAL call will produce a value near the target

-- Negative increment = -(current_last_number - reset_target - 1)
-- = -(999,901 - 135,000 - 1) = -864,900
-- The -1 accounts for the NEXTVAL call consuming one value during the drop

-- VERIFY the math before executing:
-- After ALTER SEQUENCE INCREMENT BY -864900:
-- NEXTVAL = 999,901 + (-864,900) = 135,001 ✓ (above highest_existing 125,000)
\`\`\`

### Step 3B.2 — Execute the Reset

\`\`\`sql
-- !! Execute during maintenance window with no active transactions on the module !!

-- Step 1: Set negative increment
-- Replace -864900 with your calculated negative increment value
ALTER SEQUENCE APPS.WSH_STOP_BATCH_S INCREMENT BY -864900 MINVALUE 1;

-- Step 2: Advance once to apply the drop
SELECT APPS.WSH_STOP_BATCH_S.NEXTVAL FROM DUAL;
-- Record the value returned — this is the new current position

-- Step 3: Verify the returned value is above highest_existing and below max_value
-- If NEXTVAL returned 135,001 and highest_existing = 125,000 → SAFE to proceed
-- If NEXTVAL returned a value <= highest_existing → DO NOT restore increment, investigate

-- Step 4: Restore the original increment
ALTER SEQUENCE APPS.WSH_STOP_BATCH_S INCREMENT BY 1;

-- Step 5: Verify the sequence is now correctly positioned
SELECT APPS.WSH_STOP_BATCH_S.NEXTVAL FROM DUAL;
-- Should be 135,002 (one step past the reset point)
\`\`\`

### Step 3B.3 — Confirm No Conflict With Existing Data

\`\`\`sql
-- After the reset, confirm the new sequence value is strictly greater than
-- every existing primary key in the target table
SELECT COUNT(*) AS conflicts_found
FROM wsh_picking_batches
WHERE batch_id >= (SELECT last_number FROM dba_sequences
                   WHERE sequence_name = 'WSH_STOP_BATCH_S'
                     AND sequence_owner = 'APPS');
-- Expected: 0 rows

-- Also check the table the sequence will immediately insert into
-- by attempting a test insert and rollback (requires a test schema)
BEGIN
  SAVEPOINT test_sequence_reset;
  INSERT INTO wsh_picking_batches (batch_id, creation_date, created_by, last_update_date, last_updated_by)
  VALUES (APPS.WSH_STOP_BATCH_S.NEXTVAL, SYSDATE, -1, SYSDATE, -1);
  ROLLBACK TO SAVEPOINT test_sequence_reset;
  DBMS_OUTPUT.PUT_LINE('Test insert succeeded — no primary key conflict');
EXCEPTION
  WHEN DUP_VAL_ON_INDEX THEN
    ROLLBACK TO SAVEPOINT test_sequence_reset;
    DBMS_OUTPUT.PUT_LINE('CONFLICT DETECTED — primary key violation on test insert');
    -- If this fires, the reset target is too low — recalculate and redo from Step 3B.2
END;
/
\`\`\`

---

## Phase 4: Post-Fix Verification

### Step 4.1 — Full Sequence State Verification

\`\`\`sql
-- Confirm the sequence is in a healthy state after remediation
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
WHERE sequence_name = 'WSH_STOP_BATCH_S' AND sequence_owner = 'APPS';

-- For Option A: pct_consumed should be near 0% (last_number << max_value)
-- For Option B: pct_consumed should be above 0% but well below 80%
\`\`\`

### Step 4.2 — Functional Test

Submit or manually trigger the EBS process that was failing:

\`\`\`sql
-- For pick release: check that a new batch record can be created
SELECT batch_id, creation_date, status_code
FROM wsh_picking_batches
ORDER BY creation_date DESC
FETCH FIRST 5 ROWS ONLY;

-- For order entry: check that a new header ID was generated
SELECT header_id, order_number, creation_date
FROM oe_order_headers_all
ORDER BY creation_date DESC
FETCH FIRST 5 ROWS ONLY;
\`\`\`

Confirm the new IDs are generating in the expected range and that no ORA-08004 appears in the alert log:

\`\`\`bash
grep "ORA-08004" \${ORACLE_BASE}/diag/rdbms/\${ORACLE_SID}/\${ORACLE_SID}/trace/alert_\${ORACLE_SID}.log | tail -10
# Expected: no new entries after the fix timestamp
\`\`\`

### Step 4.3 — Project Time to Next Threshold

Based on current daily consumption, estimate when the sequence will next reach 80%:

\`\`\`sql
-- Estimate daily consumption rate from recent transaction volume
-- Example for WSH_STOP_BATCH_S: count pick release batches per day
SELECT TRUNC(creation_date) AS batch_date,
       COUNT(*) AS batches_per_day
FROM wsh_picking_batches
WHERE creation_date >= SYSDATE - 30
GROUP BY TRUNC(creation_date)
ORDER BY batch_date DESC;

-- With avg_daily_rate and new_remaining, calculate days to 80%
-- days_to_warning = (max_value * 0.80 - last_number) / avg_daily_rate
\`\`\`

---

## Monitoring Scripts

### Script 1: Weekly Sequence Limit Monitor (Crontab)

Runs weekly and emails the DBA team any sequence at 70% or above, categorized by severity. Schedule for Sunday morning before the business week begins.

\`\`\`bash
#!/bin/bash
# sequence_limit_monitor.sh
# Weekly scan for EBS sequences approaching their MAXVALUE.
# Schedule: 0 5 * * 0  (Sunday 05:00)

ORACLE_SID=EBSPRD
ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
PATH=\${ORACLE_HOME}/bin:\${PATH}
RECIPIENT="dba-team@example.com"
CRITICAL_RECIPIENT="dba-oncall@example.com,infra-team@example.com"
LOG=/var/log/sequence_limit_monitor.log
ENV_LABEL=PROD
HOST=\$(hostname -s)

export ORACLE_SID ORACLE_HOME PATH

TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')

log() { echo "[\${TIMESTAMP}] \$*" >> "\${LOG}"; }

# Query at-risk sequences
RESULT=\$(sqlplus -s / as sysdba << 'ENDSQL'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF VERIFY OFF LINESIZE 300
SELECT sequence_owner || '|' || sequence_name || '|' ||
       last_number || '|' || max_value || '|' ||
       (max_value - last_number) || '|' ||
       ROUND(last_number / NULLIF(max_value,0) * 100, 2) || '|' ||
       CASE
         WHEN last_number / NULLIF(max_value,0) >= 0.999 THEN 'EXHAUSTED'
         WHEN last_number / NULLIF(max_value,0) >= 0.99  THEN 'CRITICAL'
         WHEN last_number / NULLIF(max_value,0) >= 0.90  THEN 'WARNING'
         WHEN last_number / NULLIF(max_value,0) >= 0.80  THEN 'WATCH'
         ELSE 'MONITOR'
       END
FROM dba_sequences
WHERE sequence_owner IN ('APPS','WSH','ONT','INV','AR','AP','WF','FND')
  AND cycle_flag = 'N'
  AND last_number / NULLIF(max_value,0) >= 0.70
ORDER BY last_number / NULLIF(max_value,0) DESC;
ENDSQL
)

if [ -z "\${RESULT}" ]; then
  log "No at-risk sequences found — all below 70% consumption"
  exit 0
fi

CRITICAL_LINES=""
WARNING_LINES=""
WATCH_LINES=""
MONITOR_LINES=""
HAS_CRITICAL=0

while IFS='|' read -r owner seq_name last_num max_val remaining pct status; do
  [ -z "\${owner}" ] && continue
  LINE="  \${pct}% consumed: \${owner}.\${seq_name} (last=\${last_num}, max=\${max_val}, remaining=\${remaining})"
  case "\${status}" in
    EXHAUSTED|CRITICAL) CRITICAL_LINES="\${CRITICAL_LINES}\n\${LINE}"; HAS_CRITICAL=1 ;;
    WARNING)             WARNING_LINES="\${WARNING_LINES}\n\${LINE}" ;;
    WATCH)               WATCH_LINES="\${WATCH_LINES}\n\${LINE}" ;;
    MONITOR)             MONITOR_LINES="\${MONITOR_LINES}\n\${LINE}" ;;
  esac
done <<< "\${RESULT}"

SUBJECT="[\${ENV_LABEL}] Oracle Sequence Limit Report — \$(date '+%Y-%m-%d') — \${HOST}"

BODY="Oracle EBS Sequence Limit Weekly Report
Instance: \${ORACLE_SID} | Host: \${HOST} | Run time: \${TIMESTAMP}
\$(printf '%0.s─' \$(seq 1 60))
"

if [ -n "\${CRITICAL_LINES}" ]; then
  BODY="\${BODY}
CRITICAL / EXHAUSTED (immediate action required):
\$(printf '%b' "\${CRITICAL_LINES}")
  Action: ALTER SEQUENCE ... MAXVALUE <new_value> immediately.
  Reference: https://appsdba.vercel.app/blog/oracle-ebs-sequence-limit-management-runbook
"
fi

if [ -n "\${WARNING_LINES}" ]; then
  BODY="\${BODY}
WARNING (action required this week):
\$(printf '%b' "\${WARNING_LINES}")
"
fi

if [ -n "\${WATCH_LINES}" ]; then
  BODY="\${BODY}
WATCH (action required this month):
\$(printf '%b' "\${WATCH_LINES}")
"
fi

if [ -n "\${MONITOR_LINES}" ]; then
  BODY="\${BODY}
MONITOR (70-80% — review next cycle):
\$(printf '%b' "\${MONITOR_LINES}")
"
fi

# Always send weekly report
printf "From: Oracle Monitor <%s>\nTo: %s\nSubject: %s\n\n%s\n" \
  "oracle-monitor@\$(hostname -f)" "\${RECIPIENT}" "\${SUBJECT}" "\${BODY}" \
  | /usr/sbin/sendmail -t -oi

# Also send to oncall if CRITICAL
if [ "\${HAS_CRITICAL}" = "1" ]; then
  CRIT_SUBJECT="[CRITICAL] \${SUBJECT}"
  printf "From: Oracle Monitor <%s>\nTo: %s\nSubject: %s\n\n%s\n" \
    "oracle-monitor@\$(hostname -f)" "\${CRITICAL_RECIPIENT}" "\${CRIT_SUBJECT}" "\${BODY}" \
    | /usr/sbin/sendmail -t -oi
  log "CRITICAL alert sent for exhausted/near-exhausted sequences"
fi

log "Weekly sequence report sent to \${RECIPIENT}"
exit 0
\`\`\`

### Script 2: Daily Consumption Rate Report

Tracks how many values high-volume sequences consume per day, providing early warning when consumption accelerates due to increased transaction volume.

\`\`\`sql
-- sequence_consumption_report.sql
-- Run weekly to monitor daily consumption rate trends
-- Compares LAST_NUMBER against what it was a week ago using AWR snapshot data

SELECT s.snap_id,
       TO_CHAR(sn.begin_interval_time, 'YYYY-MM-DD') AS snap_date,
       s.sequence_owner,
       s.sequence_name,
       s.last_number,
       LAG(s.last_number) OVER (
         PARTITION BY s.sequence_owner, s.sequence_name
         ORDER BY s.snap_id
       ) AS prev_last_number,
       s.last_number - LAG(s.last_number) OVER (
         PARTITION BY s.sequence_owner, s.sequence_name
         ORDER BY s.snap_id
       ) AS values_consumed_since_last_snap
FROM dba_hist_seq_v s  -- available in Oracle 19c+
JOIN dba_hist_snapshot sn ON s.snap_id = sn.snap_id
WHERE s.sequence_name IN (
  'WSH_STOP_BATCH_S',
  'OE_ORDER_HEADERS_S',
  'OE_ORDER_LINES_S',
  'MTL_MATERIAL_TRANSACTIONS_S',
  'FND_CONCURRENT_REQUESTS_S'
)
ORDER BY s.sequence_name, s.snap_id;
\`\`\`

If \`DBA_HIST_SEQ_V\` is not available in your version, track changes manually:

\`\`\`sql
-- Create a simple sequence snapshot table (one-time setup)
CREATE TABLE xx_sequence_snapshots (
  snap_timestamp  TIMESTAMP DEFAULT SYSTIMESTAMP,
  sequence_owner  VARCHAR2(30),
  sequence_name   VARCHAR2(128),
  last_number     NUMBER,
  max_value       NUMBER,
  pct_consumed    NUMBER(6,2)
) TABLESPACE APPS_TS_TX_DATA;

-- Insert daily snapshot (add to crontab via DBMS_SCHEDULER)
INSERT INTO xx_sequence_snapshots (sequence_owner, sequence_name, last_number, max_value, pct_consumed)
SELECT sequence_owner, sequence_name, last_number, max_value,
       ROUND(last_number / NULLIF(max_value, 0) * 100, 2)
FROM dba_sequences
WHERE sequence_owner IN ('APPS','WSH','ONT','INV','AR','AP')
  AND cycle_flag = 'N';
COMMIT;

-- Weekly trend report
SELECT sequence_name,
       MIN(snap_timestamp) AS first_snap,
       MAX(snap_timestamp) AS last_snap,
       MIN(last_number)    AS start_value,
       MAX(last_number)    AS end_value,
       MAX(last_number) - MIN(last_number) AS consumed_in_period,
       ROUND((MAX(last_number) - MIN(last_number)) /
             NULLIF(EXTRACT(DAY FROM MAX(snap_timestamp) - MIN(snap_timestamp)), 0), 0)
         AS avg_per_day,
       MAX(pct_consumed) AS current_pct_consumed
FROM xx_sequence_snapshots
WHERE snap_timestamp >= SYSTIMESTAMP - INTERVAL '30' DAY
GROUP BY sequence_owner, sequence_name
ORDER BY current_pct_consumed DESC;
\`\`\`

---

## Quick Reference: ALTER SEQUENCE Commands

\`\`\`sql
-- View current sequence state
SELECT sequence_name, last_number, max_value, increment_by, cycle_flag, cache_size
FROM dba_sequences
WHERE sequence_name = '&sequence_name' AND sequence_owner = 'APPS';

-- Option A: Raise MAXVALUE (recommended — no downtime)
ALTER SEQUENCE APPS.&sequence_name MAXVALUE 9999999999;

-- Option A: Raise MAXVALUE + increase cache for high-volume sequences
ALTER SEQUENCE APPS.&sequence_name MAXVALUE 9999999999 CACHE 100;

-- Option B: Controlled reset — Step 1: set negative increment
-- (replace -N with calculated negative increment)
ALTER SEQUENCE APPS.&sequence_name INCREMENT BY -&negative_increment MINVALUE 1;

-- Option B: Step 2: advance once to apply the drop
SELECT APPS.&sequence_name..NEXTVAL FROM DUAL;

-- Option B: Step 3: restore original increment
ALTER SEQUENCE APPS.&sequence_name INCREMENT BY 1;

-- Verify new state after either option
SELECT last_number, max_value, max_value - last_number AS remaining,
       ROUND(last_number / max_value * 100, 2) AS pct_consumed
FROM dba_sequences
WHERE sequence_name = '&sequence_name' AND sequence_owner = 'APPS';

-- Test: confirm NEXTVAL works without ORA-08004
SELECT APPS.&sequence_name..NEXTVAL FROM DUAL;
\`\`\`

### Negative Increment Calculation Formula

\`\`\`
current_last_number   = LAST_NUMBER from DBA_SEQUENCES
highest_existing_pk   = MAX(column) from the target table
safety_margin         = 10000 (minimum recommended)
reset_target          = highest_existing_pk + safety_margin

negative_increment    = -(current_last_number - reset_target - 1)

After NEXTVAL:
  new_position        = current_last_number + negative_increment
                      = current_last_number - (current_last_number - reset_target - 1)
                      = reset_target + 1   ✓
\`\`\`

---

## Crontab Installation

\`\`\`bash
# Install as oracle user
crontab -e

# Add:
# Weekly sequence limit report — Sunday 05:00
0 5 * * 0 /opt/oracle/scripts/sequence_limit_monitor.sh >> /var/log/sequence_limit_monitor.log 2>&1

# Daily snapshot for trend tracking (via DBMS_SCHEDULER or cron)
0 23 * * * /opt/oracle/scripts/sequence_snapshot.sh >> /var/log/sequence_snapshot.log 2>&1
\`\`\`

For the daily snapshot via DBMS_SCHEDULER (preferred — runs as a database job):

\`\`\`sql
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'XX_SEQ_SNAPSHOT_JOB',
    job_type        => 'PLSQL_BLOCK',
    job_action      => q'[
      BEGIN
        INSERT INTO xx_sequence_snapshots (sequence_owner, sequence_name, last_number, max_value, pct_consumed)
        SELECT sequence_owner, sequence_name, last_number, max_value,
               ROUND(last_number / NULLIF(max_value, 0) * 100, 2)
        FROM dba_sequences
        WHERE sequence_owner IN ('APPS','WSH','ONT','INV','AR','AP','WF','FND')
          AND cycle_flag = 'N';
        COMMIT;
      END;
    ]',
    start_date      => SYSTIMESTAMP,
    repeat_interval => 'FREQ=DAILY;BYHOUR=23;BYMINUTE=0',
    enabled         => TRUE,
    comments        => 'Daily snapshot of EBS sequence last_number for trend tracking'
  );
END;
/
\`\`\`

---

## Summary

Oracle sequence exhaustion in EBS is one of the few production outages that is simultaneously catastrophic in impact — halting all order fulfillment, inventory, or payment processing — and completely preventable through a trivial weekly query. When a \`NOCYCLE\` sequence reaches its \`MAXVALUE\`, every subsequent call to \`NEXTVAL\` fails with \`ORA-08004\`, and the EBS application layer translates that into a generic error that takes time to trace back to its source.

The remediation is equally simple once diagnosed. **Raising MAXVALUE** via \`ALTER SEQUENCE\` is instantaneous, requires no downtime, and carries no risk — provided the column data type can store the new ceiling. For \`NUMBER\` columns without explicit precision (the EBS standard), \`MAXVALUE 9999999999\` provides effective immunity for decades of normal transaction volume. **The negative-increment reset** is the fallback when a column precision constraint prevents raising \`MAXVALUE\`; it requires a maintenance window and a careful check against the highest existing primary key value to prevent unique constraint violations, but it is equally non-destructive of sequence dependencies.

The proactive defense is a weekly crontab that scans \`DBA_SEQUENCES\` for all \`NOCYCLE\` sequences at 70% consumption or above, sends a severity-graded email report to the DBA team, and pages oncall for CRITICAL or EXHAUSTED entries. Combined with a daily snapshot of \`LAST_NUMBER\` values into a tracking table, this provides the trend data needed to project time-to-exhaustion and schedule remediation as a planned change — not a 2 AM war room.`,
};

async function main() {
  console.log('Inserting sequence limit management runbook...');
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
