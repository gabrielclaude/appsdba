import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'EBS IBY_0001 Payment Servlet Cursor Leak Runbook: Diagnosis, Remediation, and Batch Verification',
  slug: 'ebs-iby-0001-cursor-leak-remediation-runbook',
  excerpt:
    'A step-by-step remediation runbook for IBY_0001 errors caused by a JDBC cursor leak in a custom EBS payment servlet — covering concurrent request triage, WebLogic log analysis, live Oracle cursor diagnostics, try-with-resources code remediation, OACORE deployment, and a complete diagnostic shell script.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-18'),
  youtubeUrl: null,
  content: `# EBS IBY_0001 Payment Servlet Cursor Leak: Diagnosis, Remediation, and Batch Verification Runbook

## Overview

This runbook covers step-by-step diagnosis and remediation of \`IBY_0001\` errors caused by a JDBC cursor leak in a custom Oracle EBS payment processing servlet. The leak exhausts the Oracle database \`OPEN_CURSORS\` parameter under high-volume Automatic Receipts batch processing, causing the servlet to crash mid-HTTP-response and IBY to report the dropped connection as "payment system unavailable."

**Environment assumptions:**

- Oracle EBS 12.2.x on Linux
- Custom Java servlet deployed on OACORE WebLogic managed servers under \`\$JAVA_TOP/payment/oracle/apps/iby/servlet/\`
- Oracle Payments (IBY) module processing Automatic Receipts batches
- Oracle Database 12c or 19c (single instance or RAC)
- Run all SQL as APPS user unless noted; run all shell commands as \`oracle\` OS user

---

## Phase 1 — Confirm IBY_0001 Is the Error and Identify the Failing Request

Start by confirming that the concurrent request failures are carrying IBY_0001 and not a different IBY error code, and get the request IDs and timestamps you need for subsequent log correlation.

\`\`\`sql
-- Find recent IBY_0001 concurrent request failures (last 7 days)
SELECT fcr.request_id,
       fcp.concurrent_program_name,
       fcpt.user_concurrent_program_name,
       TO_CHAR(fcr.actual_start_date,  'YYYY-MM-DD HH24:MI:SS') AS started,
       TO_CHAR(fcr.actual_completion_date, 'YYYY-MM-DD HH24:MI:SS') AS completed,
       fcr.phase_code,
       fcr.status_code,
       fcr.completion_text
FROM fnd_concurrent_requests fcr
JOIN fnd_concurrent_programs fcp
  ON fcr.concurrent_program_id = fcp.concurrent_program_id
  AND fcr.program_application_id = fcp.application_id
JOIN fnd_concurrent_programs_tl fcpt
  ON fcp.concurrent_program_id = fcpt.concurrent_program_id
  AND fcpt.language = 'US'
WHERE (fcr.completion_text LIKE '%IBY_0001%' OR fcr.completion_text LIKE '%IBY%')
  AND fcr.actual_completion_date > SYSDATE - 7
ORDER BY fcr.actual_completion_date DESC;
\`\`\`

\`\`\`sql
-- Check FND_LOG for IBY_0001 text (last 7 days)
SELECT flt.log_sequence,
       TO_CHAR(flt.timestamp, 'YYYY-MM-DD HH24:MI:SS') AS log_time,
       flt.module,
       flt.message_text
FROM fnd_log_messages flt
WHERE flt.message_text LIKE '%IBY_0001%'
  AND flt.timestamp > SYSTIMESTAMP - INTERVAL '7' DAY
ORDER BY flt.log_sequence DESC
FETCH FIRST 50 ROWS ONLY;
\`\`\`

Record the \`request_id\` and \`actual_start_date\` of the failing requests. You need these timestamps to search WebLogic logs in Phase 2.

**Expected finding:** \`completion_text\` contains \`IBY_0001\` for requests that ran for a significant period before failing. Requests that fail immediately (within the first few invoices) are less likely to be this cursor leak — they would suggest a configuration error or the servlet not being deployed.

---

## Phase 2 — Confirm ORA-01000 Is the Java Exception (WebLogic Log Analysis)

The IBY error is the symptom. The root cause is inside the WebLogic OACORE managed server log. Match the failure timestamp from Phase 1 to Java exceptions in the WLS log.

\`\`\`bash
# Find OACORE server logs containing ORA-01000 or IBY errors
DOMAIN_HOME=\${DOMAIN_HOME:-"/u01/oracle/app/instance/domains/EBS_domain"}
LOG_DIR="\$DOMAIN_HOME/servers"

echo "=== Searching for ORA-01000 and IBY errors in OACORE logs ==="
grep -r "ORA-01000\|maximum open cursors\|IBY_0001\|cursor" \
  "\$LOG_DIR"/oacore*/logs/*.log \
  --include="*.log" -l 2>/dev/null

# Show the exact exception from the most recent OACORE log
LATEST_OACORE_LOG=\$(ls -t "\$LOG_DIR"/oacore*/logs/oacore*.log 2>/dev/null | head -1)
if [ -n "\$LATEST_OACORE_LOG" ]; then
  echo ""
  echo "=== ORA-01000 context from \$LATEST_OACORE_LOG ==="
  grep -B 5 -A 20 "ORA-01000\|maximum open cursors" "\$LATEST_OACORE_LOG" | tail -60
fi
\`\`\`

**What you are looking for:**

\`\`\`
java.sql.SQLException: ORA-01000: maximum open cursors exceeded
  at oracle.jdbc.driver.T4CTTIoer.processError(...)
  at payment.oracle.apps.iby.servlet.PaymentGatewayServlet.processInvoice(PaymentGatewayServlet.java:183)
  at payment.oracle.apps.iby.servlet.PaymentGatewayServlet.doPost(PaymentGatewayServlet.java:97)
\`\`\`

If you see \`ORA-01000\` in the OACORE log at the same timestamp as the IBY_0001 failure in Phase 1, the diagnosis is confirmed: the cursor leak caused the servlet to crash, and IBY reported the dropped connection as IBY_0001.

If you see a different exception (\`NullPointerException\`, \`OutOfMemoryError\`, SSL-related exceptions), the root cause is different and this runbook does not apply.

---

## Phase 3 — Database Cursor Usage Diagnostic

With the root cause confirmed in the logs, use live Oracle diagnostics to observe cursor accumulation in progress. If you can reproduce the batch, run these queries during the run.

\`\`\`sql
-- Check current OPEN_CURSORS parameter
SHOW PARAMETER open_cursors;
\`\`\`

\`\`\`sql
-- Find sessions approaching the cursor limit (>80% of OPEN_CURSORS)
SELECT s.inst_id,
       s.sid,
       s.serial#,
       s.username,
       s.program,
       s.module,
       s.action,
       s.status,
       c.cursor_count,
       ROUND(c.cursor_count /
         (SELECT value FROM v\$parameter WHERE name = 'open_cursors') * 100, 1)
         AS pct_of_limit
FROM gv\$session s
JOIN (
  SELECT inst_id, sid, COUNT(*) AS cursor_count
  FROM gv\$open_cursor
  GROUP BY inst_id, sid
) c ON c.sid = s.sid AND c.inst_id = s.inst_id
WHERE c.cursor_count > (
  SELECT value * 0.8 FROM v\$parameter WHERE name = 'open_cursors'
)
ORDER BY c.cursor_count DESC;
\`\`\`

\`\`\`sql
-- Check which SQL statements are consuming open cursors for a given session
-- (Substitute the SID of the OACORE session identified above)
SELECT oc.sid,
       oc.sql_text,
       COUNT(*) AS open_cursor_count
FROM gv\$open_cursor oc
WHERE oc.sid = &sid_of_oacore_session
GROUP BY oc.sid, oc.sql_text
ORDER BY open_cursor_count DESC;
\`\`\`

\`\`\`sql
-- Historical cursor usage trend (requires AWR license)
SELECT TO_CHAR(s.begin_interval_time, 'YYYY-MM-DD HH24') AS hour,
       MAX(ss.value) AS max_open_cursors
FROM dba_hist_sysstat ss
JOIN dba_hist_snapshot s ON s.snap_id = ss.snap_id
WHERE ss.stat_name = 'opened cursors cumulative'
  AND s.begin_interval_time > SYSDATE - 7
GROUP BY TO_CHAR(s.begin_interval_time, 'YYYY-MM-DD HH24')
ORDER BY hour;
\`\`\`

**Interpretation:**

- If \`pct_of_limit\` for an OACORE session exceeds 80 during a batch run: cursor leak is active and accumulating
- If the top SQL statements in \`gv\$open_cursor\` for that session all query \`ar_payment_schedules_all\` or \`ra_customer_trx_all\`: leak is coming from the payment servlet
- If cursor count rises steadily during the batch and never drops until the batch ends: GC is not reclaiming fast enough

---

## Phase 4 — Identify the Offending Custom Servlet Code

Locate the servlet source and class file, and confirm which version is deployed.

\`\`\`bash
# Locate the payment servlet source and class in JAVA_TOP
find \$JAVA_TOP -name "PaymentGatewayServlet.java" \
  -o -name "PaymentGatewayServlet.class" 2>/dev/null

# Check servlet registration in web.xml
find \$DOMAIN_HOME -name "web.xml" \
  -exec grep -l "PaymentGateway\|iby\|payment" {} \; 2>/dev/null | head -5

# Check last modification date of the class file to confirm version
find \$JAVA_TOP -name "PaymentGatewayServlet.class" -exec ls -la {} \;
\`\`\`

\`\`\`sql
-- Identify the SQL statements being leaked (look for AR payment tables)
SELECT oc.sid,
       s.username,
       s.program,
       s.module,
       oc.sql_text,
       COUNT(*) AS instances
FROM gv\$open_cursor oc
JOIN gv\$session s ON s.sid = oc.sid AND s.inst_id = oc.inst_id
WHERE oc.sql_text LIKE '%ar_payment_schedules_all%'
   OR oc.sql_text LIKE '%ra_customer_trx_all%'
GROUP BY oc.sid, s.username, s.program, s.module, oc.sql_text
ORDER BY instances DESC;
\`\`\`

If \`instances\` for a session is in the tens or hundreds for a single SQL text, that SQL is the leaked cursor. The session's SID and \`program\` column will confirm it is an OACORE WebLogic thread.

---

## Phase 5 — Check Residual Data Issues in RA_CUSTOMER_TRX_ALL

After the fix is applied and the batch re-run, inspect for any transactions that still show communication errors. These may be data-specific issues unrelated to the cursor leak.

\`\`\`sql
-- Find transactions with COMMUNICATION_ERROR in the payment error code column
SELECT rct.customer_trx_id,
       rct.trx_number,
       rct.trx_date,
       rct.bill_to_customer_id,
       rct.cc_error_code,
       rct.cc_error_text,
       rct.last_update_date
FROM ra_customer_trx_all rct
WHERE rct.cc_error_code = 'COMMUNICATION_ERROR'
  AND rct.last_update_date > SYSDATE - 30
ORDER BY rct.last_update_date DESC;
\`\`\`

\`\`\`sql
-- Cross-reference with IBY transaction status for the same transactions
SELECT iby.payment_id,
       iby.trxn_date,
       iby.status,
       iby.result_code,
       iby.result_msg,
       iby.error_code
FROM iby_trxn_summaries_all iby
JOIN ra_customer_trx_all rct ON rct.customer_trx_id = iby.tangible_id
WHERE rct.cc_error_code = 'COMMUNICATION_ERROR'
  AND rct.last_update_date > SYSDATE - 30
ORDER BY iby.trxn_date DESC;
\`\`\`

**Interpretation:**

- If the count of \`COMMUNICATION_ERROR\` records is small (single digits) after the fix: likely data-specific, not systemic
- If the count is high or growing on re-runs: the fix may not be complete, or a different code path has the same leak
- Cross-referencing with \`iby_trxn_summaries_all\` confirms whether IBY recorded the failure as a gateway communication issue or a servlet crash

---

## Phase 6 — Complete Diagnostic Shell Script

Run this script before or during a batch run to capture all diagnostic data in one pass.

\`\`\`bash
#!/bin/bash
# /u01/oracle/scripts/iby_cursor_diagnosis.sh
# Purpose: Diagnose IBY_0001 cursor leak and payment batch failures
# Usage:   ./iby_cursor_diagnosis.sh [apps_db_pass]
# Run as:  oracle OS user

APPS_PASS=\${1:-"\${APPS_DB_PASS}"}
ORACLE_SID=\${ORACLE_SID:-"EBSPROD"}
OUTPUT_DIR="/u01/oracle/iby_diagnosis/\$(date +%Y%m%d_%H%M%S)"
mkdir -p "\$OUTPUT_DIR"
LOG="\$OUTPUT_DIR/iby_diagnosis.log"
exec > >(tee -a "\$LOG") 2>&1

echo "======================================================"
echo "  IBY_0001 Cursor Leak Diagnostic"
echo "  Instance: \$ORACLE_SID"
echo "  Generated: \$(date)"
echo "======================================================"

# ---- PHASE 1: WebLogic Log Check ----
echo ""
echo "=== PHASE 1: WebLogic OACORE Log Analysis ==="
DOMAIN_HOME="\${DOMAIN_HOME:-/u01/oracle/app/instance/domains/EBS_domain}"

if ls "\$DOMAIN_HOME"/servers/oacore*/logs/oacore*.log 2>/dev/null | head -1 | grep -q .; then
  LATEST_LOG=\$(ls -t "\$DOMAIN_HOME"/servers/oacore*/logs/oacore*.log 2>/dev/null | head -1)
  echo "Scanning: \$LATEST_LOG"

  echo "--- ORA-01000 occurrences ---"
  grep -c "ORA-01000\|maximum open cursors" "\$LATEST_LOG" 2>/dev/null \
    && echo "Count found" || echo "None found"

  grep -B 3 -A 15 "ORA-01000\|maximum open cursors" "\$LATEST_LOG" 2>/dev/null \
    | tail -80 > "\$OUTPUT_DIR/wls_cursor_errors.txt"
  echo "Saved to: \$OUTPUT_DIR/wls_cursor_errors.txt"

  echo ""
  echo "--- IBY_0001 occurrences ---"
  grep -c "IBY_0001" "\$LATEST_LOG" 2>/dev/null && echo "IBY_0001 found" || echo "None found"
else
  echo "WARNING: OACORE logs not found at \$DOMAIN_HOME. Check DOMAIN_HOME variable."
fi

# ---- PHASE 2: Database Cursor Analysis ----
echo ""
echo "=== PHASE 2: Database Cursor Usage ==="

sqlplus -S apps/"\$APPS_PASS" <<SQL | tee "\$OUTPUT_DIR/cursor_analysis.txt"
SET LINESIZE 200 PAGESIZE 100 TRIMSPOOL ON
COLUMN program FORMAT A35
COLUMN module  FORMAT A30
COLUMN sql_text FORMAT A60

PROMPT --- OPEN_CURSORS Parameter ---
SHOW PARAMETER open_cursors

PROMPT
PROMPT --- Sessions with High Cursor Usage (>50% of limit) ---
SELECT s.inst_id,
       s.sid,
       s.serial#,
       s.username,
       SUBSTR(s.program, 1, 30) AS program,
       SUBSTR(s.module,  1, 25) AS module,
       s.status,
       c.cursor_count,
       ROUND(c.cursor_count /
         (SELECT TO_NUMBER(value) FROM v\$parameter WHERE name = 'open_cursors') * 100, 1)
         AS pct_of_limit
FROM gv\$session s
JOIN (
  SELECT inst_id, sid, COUNT(*) AS cursor_count
  FROM gv\$open_cursor
  GROUP BY inst_id, sid
) c ON c.sid = s.sid AND c.inst_id = s.inst_id
WHERE c.cursor_count >
  (SELECT TO_NUMBER(value) * 0.5 FROM v\$parameter WHERE name = 'open_cursors')
  AND s.username IS NOT NULL
ORDER BY c.cursor_count DESC
FETCH FIRST 20 ROWS ONLY;

PROMPT
PROMPT --- Payment Table SQL in Open Cursors (Potential Leaks) ---
SELECT s.username,
       SUBSTR(s.program, 1, 30) AS program,
       SUBSTR(oc.sql_text, 1, 80) AS sql_text,
       COUNT(*) AS open_instances
FROM gv\$open_cursor oc
JOIN gv\$session s ON s.sid = oc.sid AND s.inst_id = oc.inst_id
WHERE (oc.sql_text LIKE '%ar_payment_schedules_all%'
    OR oc.sql_text LIKE '%ra_customer_trx_all%'
    OR oc.sql_text LIKE '%iby%')
  AND s.username IS NOT NULL
GROUP BY s.username, s.program, oc.sql_text
HAVING COUNT(*) > 5
ORDER BY open_instances DESC;

PROMPT
PROMPT --- Recent IBY_0001 Concurrent Request Failures ---
SELECT fcr.request_id,
       fcp.concurrent_program_name,
       TO_CHAR(fcr.actual_start_date, 'MM/DD HH24:MI') AS started,
       fcr.phase_code,
       fcr.status_code,
       SUBSTR(fcr.completion_text, 1, 60) AS completion_text
FROM fnd_concurrent_requests fcr
JOIN fnd_concurrent_programs fcp
  ON fcr.concurrent_program_id = fcp.concurrent_program_id
  AND fcr.program_application_id = fcp.application_id
WHERE (fcr.completion_text LIKE '%IBY_0001%' OR fcr.completion_text LIKE '%IBY%')
  AND fcr.actual_completion_date > SYSDATE - 14
ORDER BY fcr.actual_completion_date DESC
FETCH FIRST 20 ROWS ONLY;

PROMPT
PROMPT --- RA_CUSTOMER_TRX_ALL COMMUNICATION_ERROR Records ---
SELECT rct.customer_trx_id,
       rct.trx_number,
       TO_CHAR(rct.trx_date, 'YYYY-MM-DD') AS trx_date,
       rct.cc_error_code,
       SUBSTR(rct.cc_error_text, 1, 60) AS cc_error_text,
       TO_CHAR(rct.last_update_date, 'MM/DD HH24:MI') AS last_updated
FROM ra_customer_trx_all rct
WHERE rct.cc_error_code IN ('COMMUNICATION_ERROR', 'IBY_0001')
  AND rct.last_update_date > SYSDATE - 30
ORDER BY rct.last_update_date DESC
FETCH FIRST 20 ROWS ONLY;

EXIT;
SQL

# ---- PHASE 3: Servlet Code Verification ----
echo ""
echo "=== PHASE 3: Payment Servlet Code Check ==="
echo "Looking for PaymentGatewayServlet in JAVA_TOP..."
find "\${JAVA_TOP:-/u01/oracle/apps/java}" \
  -name "PaymentGatewayServlet.java" -o \
  -name "PaymentGatewayServlet.class" 2>/dev/null | while read f; do
  echo "Found: \$f"
  ls -la "\$f"
done

echo ""
echo "--- Scanning servlet source for unclosed JDBC resources ---"
SERVLET_SRC=\$(find "\${JAVA_TOP:-/u01/oracle/apps/java}" \
  -name "PaymentGatewayServlet.java" 2>/dev/null | head -1)
if [ -n "\$SERVLET_SRC" ]; then
  echo "Source: \$SERVLET_SRC"
  echo "Lines with Statement/ResultSet opens (check for matching close calls):"
  grep -n "createStatement\|prepareStatement\|executeQuery\|ResultSet\|\.close()\|try-with\|AutoCloseable" \
    "\$SERVLET_SRC" | head -30
else
  echo "Source file not found — check compiled .class only"
fi

# ---- SUMMARY ----
echo ""
echo "======================================================"
echo "  DIAGNOSIS COMPLETE"
echo "  Output: \$OUTPUT_DIR"
echo ""
echo "  INTERPRETATION GUIDE:"
echo "  - pct_of_limit > 80 for OACORE sessions: cursor leak confirmed active"
echo "  - Payment Table SQL open_instances > 10: leak is in progress"
echo "  - WLS log has ORA-01000: servlet crashed due to cursor exhaustion"
echo "  - COMMUNICATION_ERROR in RA_CUSTOMER_TRX_ALL: data-level residual errors"
echo ""
echo "  IMMEDIATE ACTIONS:"
echo "  1. Refactor PaymentGatewayServlet.java to use try-with-resources"
echo "  2. Stage new .class to \$JAVA_TOP/payment/oracle/apps/iby/servlet/"
echo "  3. Bounce OACORE managed servers"
echo "  4. Re-run batch with FND debug logging enabled for residual failures"
echo "  5. Do NOT raise OPEN_CURSORS as a permanent fix"
echo "======================================================"
\`\`\`

---

## Phase 7 — Code Remediation

### Before: Weak Legacy Code (Cursor Leak)

The legacy code calls \`rs.close()\` and \`stmt.close()\` only in the normal exit path of the try block. Any exception thrown inside the \`while (rs.next())\` loop — from the gateway call, from a secondary SQL query, from a null reference — causes execution to jump directly to \`catch\`, skipping both close calls entirely:

\`\`\`java
// WEAK — DO NOT USE
// If any exception occurs inside the while loop, rs and stmt are never closed.
// Oracle cursor stays open on the session until JVM GC finalizes the object.
try {
    Connection conn = AppsConnectionManager.getAppsConnection();
    Statement stmt = conn.createStatement();
    ResultSet rs = stmt.executeQuery(
        "SELECT payment_schedule_id, amount_due_remaining " +
        "FROM ar_payment_schedules_all " +
        "WHERE customer_trx_id = " + customerTrxId  // literal concatenation — also a SQL injection risk
    );
    while (rs.next()) {
        // processPayment() calls the third-party gateway and can throw exceptions
        processPayment(rs.getLong("payment_schedule_id"),
                       rs.getBigDecimal("amount_due_remaining"));
    }
    rs.close();    // skipped if exception in loop
    stmt.close();  // skipped if exception in loop
} catch (SQLException e) {
    log.error("Payment processing failed for trx: " + customerTrxId, e);
    // cursor leak — stmt and rs still open, accumulating on the Oracle session
}
\`\`\`

### After: Correct Implementation Using Try-with-Resources (Java 7+)

Java's try-with-resources statement guarantees that \`close()\` is called on every \`AutoCloseable\` object declared in the resource list when the try block exits — regardless of whether it exits normally, via \`return\`, via \`break\`, or via any exception. \`java.sql.Connection\`, \`PreparedStatement\`, and \`ResultSet\` all implement \`AutoCloseable\`:

\`\`\`java
// CORRECT — try-with-resources guarantees close() on all exit paths
try (Connection conn = AppsConnectionManager.getAppsConnection();
     PreparedStatement pstmt = conn.prepareStatement(
         "SELECT payment_schedule_id, amount_due_remaining " +
         "FROM ar_payment_schedules_all " +
         "WHERE customer_trx_id = ?")) {   // bind variable — no SQL injection risk

    pstmt.setLong(1, customerTrxId);

    try (ResultSet rs = pstmt.executeQuery()) {
        while (rs.next()) {
            processPayment(rs.getLong("payment_schedule_id"),
                           rs.getBigDecimal("amount_due_remaining"));
            // if processPayment() throws any exception:
            // rs.close() is called immediately on inner try exit
            // pstmt.close() and conn.close() are called on outer try exit
            // Oracle cursors are released — no leak
        }
    }  // rs.close() guaranteed

} catch (SQLException e) {
    log.error("Payment processing failed for trx: " + customerTrxId, e);
}   // pstmt.close() and conn.close() guaranteed
\`\`\`

The \`ResultSet\` is in a separate inner try-with-resources block so that \`rs.close()\` executes before \`pstmt.close()\`. This matches the JDBC specification's requirement that a \`ResultSet\` be closed before its owning \`Statement\` or \`PreparedStatement\` is closed. Closing \`pstmt\` while \`rs\` is still open generates a driver-level warning in some Oracle JDBC driver versions.

### Deployment Steps

\`\`\`bash
# 1. Compile the fixed servlet from the application tier
cd \$JAVA_TOP/payment/oracle/apps/iby/servlet/
javac -cp \$JAVA_TOP:\$ORACLE_HOME/jdbc/lib/ojdbc8.jar PaymentGatewayServlet.java

# 2. Verify the new class file has today's timestamp
ls -la PaymentGatewayServlet.class

# 3. Bounce OACORE to flush the JVM class cache
# WebLogic caches .class files after first load — the old class runs until JVM restarts
\$ADMIN_SCRIPTS_HOME/oacorectl.sh stop
sleep 30
\$ADMIN_SCRIPTS_HOME/oacorectl.sh start

# 4. Confirm OACORE is back and all managed servers are running
\$ADMIN_SCRIPTS_HOME/oacorectl.sh status
\`\`\`

---

## Phase 8 — Post-Fix Verification

### 1. Verify Cursor Counts Dropped After OACORE Restart

Run this immediately after OACORE restarts and before starting the test batch, to establish a baseline:

\`\`\`sql
-- Baseline cursor count after restart (should be very low)
SELECT COUNT(*) AS total_open_cursors,
       MAX(cursor_count) AS max_per_session
FROM (
  SELECT sid, COUNT(*) AS cursor_count
  FROM gv\$open_cursor
  GROUP BY sid
);
\`\`\`

Run the same query during the batch run. With the fix in place, \`max_per_session\` for OACORE sessions should remain stable — it will not grow unboundedly.

### 2. Enable FND Debug for the 4 Residual Error Transactions

If residual \`COMMUNICATION_ERROR\` records remain after the fix, isolate and re-run those specific transaction IDs with IBY debug logging enabled:

\`\`\`sql
-- Enable FND debug logging for the IBY module at statement level (site-wide)
BEGIN
  FND_PROFILE.SAVE('AFLOG_ENABLED', 'Y', 'SITE');
  FND_PROFILE.SAVE('AFLOG_LEVEL',  '1', 'SITE');   -- 1 = Statement level
  FND_PROFILE.SAVE('AFLOG_MODULE', 'iby%', 'SITE');
  COMMIT;
END;
/
\`\`\`

Re-run only the residual transactions (use the customer_trx_id values from Phase 5 as input). After the run completes, query the FND log using the concurrent request ID:

\`\`\`sql
-- Query FND_LOG for a specific concurrent request
SELECT flt.log_sequence,
       TO_CHAR(flt.timestamp, 'HH24:MI:SS.FF3') AS log_time,
       flt.module,
       SUBSTR(flt.message_text, 1, 200) AS message_text
FROM fnd_log_messages flt
JOIN fnd_log_transaction_context con
  ON con.transaction_context_id = flt.transaction_context_id
WHERE con.transaction_id    = &Your_Request_ID
  AND con.transaction_type  = 'REQUEST'
ORDER BY flt.log_sequence;
\`\`\`

**After testing, always disable debug logging at the site level:**

\`\`\`sql
BEGIN
  FND_PROFILE.SAVE('AFLOG_ENABLED', 'N', 'SITE');
  COMMIT;
END;
/
\`\`\`

FND debug logging at Statement level (level 1) generates extremely high volumes of log data. Leaving it enabled in production will fill the \`FND_LOG_MESSAGES\` table rapidly and degrade performance.

### 3. Re-Run the Full 9,000-Invoice Batch

After OACORE is confirmed running with the new class and cursor baseline is clean:

1. Submit the Automatic Receipts Master Program for the full invoice population
2. Monitor cursor counts during the run using the Phase 3 query — refresh every 5 minutes
3. Watch the OACORE log for any new \`ORA-01000\` exceptions
4. After completion, query \`FND_CONCURRENT_REQUESTS\` for the request status

\`\`\`sql
-- Check the completion status of the most recent batch run
SELECT fcr.request_id,
       fcp.concurrent_program_name,
       TO_CHAR(fcr.actual_start_date,  'YYYY-MM-DD HH24:MI:SS') AS started,
       TO_CHAR(fcr.actual_completion_date, 'YYYY-MM-DD HH24:MI:SS') AS completed,
       fcr.phase_code,
       fcr.status_code,    -- C = Complete Normal
       fcr.completion_text
FROM fnd_concurrent_requests fcr
JOIN fnd_concurrent_programs fcp
  ON fcr.concurrent_program_id = fcp.concurrent_program_id
  AND fcr.program_application_id = fcp.application_id
WHERE fcp.concurrent_program_name = 'ARACCPROG'
ORDER BY fcr.actual_start_date DESC
FETCH FIRST 5 ROWS ONLY;
\`\`\`

\`status_code = 'C'\` (Complete Normal) with no \`IBY_0001\` in \`completion_text\` confirms the fix is effective.

---

## Phase 9 — Validation Matrix

Use this checklist to sign off the fix before returning the environment to production batch processing.

| Check | Command / Query | Pass Criterion |
|---|---|---|
| IBY_0001 errors in FND log | \`FND_LOG_MESSAGES\` query (Phase 1) | 0 new entries after fix |
| ORA-01000 in OACORE log | \`grep "ORA-01000" oacore*.log\` | 0 occurrences during batch run |
| Cursor usage during batch | High cursor usage query (Phase 3) | Max \`pct_of_limit\` < 50% during 9,000-invoice run |
| Payment table cursor leaks | Open cursor SQL query (Phase 4) | 0 instances with \`open_instances\` > 5 |
| Concurrent request success | \`FND_CONCURRENT_REQUESTS\` status | \`status_code = 'C'\` (Complete Normal) |
| COMMUNICATION_ERROR records | \`RA_CUSTOMER_TRX_ALL\` query (Phase 5) | Count not increasing after re-run (residuals only, not growing) |
| Servlet class timestamp | \`ls -la PaymentGatewayServlet.class\` | Modified date = deployment date |
| OACORE running | \`oacorectl.sh status\` | Running state, all managed servers UP |
| FND debug disabled (post-test) | \`FND_PROFILE query for AFLOG_ENABLED\` | Value = \`N\` at SITE level |

---

## Appendix — Why Not Just Raise OPEN_CURSORS?

The immediate temptation when hitting \`ORA-01000\` is to raise \`OPEN_CURSORS\`. This is an online parameter change requiring no restart:

\`\`\`sql
ALTER SYSTEM SET OPEN_CURSORS = 1000 SCOPE = BOTH;
\`\`\`

This is a band-aid, not a fix. The cursor leak is still occurring at the same rate. At 1,000 cursors the batch survives longer, but it will still eventually hit the new ceiling — at a larger batch size or after a longer run. And raising \`OPEN_CURSORS\` increases memory consumption: each open cursor holds Oracle library cache memory. Raising the limit without fixing the leak increases memory pressure on the database SGA.

The only correct remediation is to fix the code so that cursors are closed in all code paths. Try-with-resources does this unconditionally.

If you need immediate relief while the code fix is prepared and tested, raising \`OPEN_CURSORS\` is an acceptable temporary measure. Set an explicit remediation deadline and revert to a normal value (300-500) after the fix is deployed and verified.

---

## Appendix — Proactive Cursor Monitoring (Cron)

To detect cursor accumulation before it causes a batch failure, add this to the oracle user's crontab to run every 15 minutes during batch processing windows:

\`\`\`bash
#!/bin/bash
# /u01/oracle/scripts/cursor_monitor.sh
# Alert when any session exceeds 70% of OPEN_CURSORS limit
# Cron: */15 * * * * oracle /u01/oracle/scripts/cursor_monitor.sh

ALERT_EMAIL="\${ALERT_EMAIL:-dba-team@example.com}"
APPS_PASS=\$(cat /home/oracle/.oracle_apps_pass 2>/dev/null)
THRESHOLD=70

ALERT=\$(sqlplus -S apps/"\$APPS_PASS" <<SQL
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT s.username || ' SID=' || s.sid || ' program=' || SUBSTR(s.program,1,30) ||
       ' cursors=' || c.cursor_count || ' pct=' ||
       ROUND(c.cursor_count /
         (SELECT TO_NUMBER(value) FROM v\$parameter WHERE name='open_cursors') * 100,1)
FROM gv\$session s
JOIN (SELECT inst_id, sid, COUNT(*) cursor_count FROM gv\$open_cursor GROUP BY inst_id, sid) c
  ON c.sid=s.sid AND c.inst_id=s.inst_id
WHERE c.cursor_count >
  (SELECT TO_NUMBER(value) * \$THRESHOLD / 100 FROM v\$parameter WHERE name='open_cursors')
  AND s.username IS NOT NULL
ORDER BY c.cursor_count DESC
FETCH FIRST 5 ROWS ONLY;
EXIT;
SQL
)

if [ -n "\$ALERT" ]; then
  echo "\$ALERT" | mailx -s "[ALERT] Oracle cursor usage > \${THRESHOLD}% on \$(hostname)" "\$ALERT_EMAIL"
fi
\`\`\`

This provides early warning — when a session reaches 70% of the \`OPEN_CURSORS\` limit, the DBA has time to investigate or restart OACORE before the limit is exhausted and a batch fails.
`,
};

async function main() {
  console.log('Inserting runbook post...');
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
