import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Debugging IBY_0001: How a JDBC Cursor Leak in a Custom Payment Servlet Masquerades as a Network Failure',
  slug: 'ebs-iby-0001-jdbc-cursor-leak-payment-servlet',
  excerpt:
    'An intermittent IBY_0001 error during high-volume Automatic Receipts batch processing pointed to network failure — but tcpdump and curl tests came back clean. This post traces the real culprit: a JDBC cursor leak in a custom payment servlet that exhausted the Oracle database OPEN_CURSORS limit and crashed the servlet mid-response.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-18'),
  youtubeUrl: null,
  content: `## Introduction

An Oracle EBS 12.2 environment is running the Automatic Receipts Master Program against a batch of roughly 9,000 open AR transactions. The integration path is a custom Java servlet deployed on the OACORE WebLogic managed server cluster — it receives calls from the Oracle Payments (IBY) engine and wraps outbound calls to a third-party payment gateway. For small test batches everything works. At production scale, batches abort intermittently with:

\`\`\`
IBY_0001: The payment system is currently unavailable. Please try again later.
\`\`\`

The words "payment system unavailable" point squarely at the external gateway or the network between EBS and the gateway. The team runs connectivity tests. TLS handshakes succeed. The gateway API responds. A targeted \`tcpdump\` shows healthy connections. Nothing in the network is broken.

This post traces how the investigation pivoted from a false network hypothesis to the real root cause: a JDBC cursor leak inside the custom servlet that exhausted the Oracle database \`OPEN_CURSORS\` parameter after several hundred invoices — crashing the servlet mid-HTTP-response and leaving IBY with a dropped connection it could only interpret as "servlet unavailable."

---

## Understanding IBY_0001 in Oracle Payments Architecture

### What IBY_0001 Means

The Oracle Payments (IBY) module manages payment instrument processing for Oracle EBS. It exposes an engine — the iPayment engine — that orchestrates payment transactions by calling out to registered payment processing servlets over HTTP. \`IBY_0001\` is the error the iPayment engine raises when it receives no valid HTTP response from the servlet it called.

The precise wording in the IBY message dictionary is:

> "The payment system is currently unavailable."

This is accurate as far as the iPayment engine is concerned. It dispatched an HTTP request and received no usable response. What it cannot tell you is *why*.

### The Oracle Payments Servlet Architecture

In a standard Oracle Payments integration, the iPayment engine calls the payment processing servlet via HTTP on the OACORE managed server. The servlet is responsible for:

1. Accepting the IBY call with the transaction payload (amount, token, transaction reference)
2. Executing any business logic — in this case, querying AR tables for invoice data
3. Calling the third-party payment gateway API
4. Returning a structured XML or JSON response to IBY

The servlet runs inside the OACORE JVM. It uses JDBC (via \`AppsConnectionManager\`) to access the Oracle EBS database, and it uses the gateway's HTTP client library to call the external endpoint.

### Why IBY_0001 Is a Misleading Error

\`IBY_0001\` covers three distinct failure modes, all of which look identical to the iPayment engine:

1. **Network timeout** — the servlet is alive but the connection to the gateway times out; the servlet returns HTTP 500 or hangs
2. **Servlet throws an unhandled exception** — the servlet encounters a Java exception, WebLogic returns HTTP 500, and IBY receives a 500 it cannot parse as a valid payment response
3. **Servlet crashes mid-response** — the servlet starts processing, encounters a fatal error partway through, and drops the TCP connection without sending any HTTP response at all

All three produce the same \`IBY_0001\` error. The "communication error" framing in the UI makes mode 1 look the most plausible, but modes 2 and 3 are equally common in production.

### The Automatic Receipts Master Program

The Automatic Receipts Master Program (concurrent program \`ARACCPROG\`) automates the creation of receipts against open AR transactions. It iterates over a set of invoices, creates AR receipts, and for credit card or electronic payment transactions triggers the IBY payment engine to process each transaction.

At low volume — a few dozen or a few hundred invoices — the program runs fine. At scale (9,000 invoices), the program places sustained, repeated load on every component in the chain: the AR tables, the IBY engine, the custom servlet, and the database session those components share. Resource management bugs that GC or idle time can hide in short runs become catastrophic at this scale.

---

## Initial Triage — Following the Wrong Lead

### Why DBAs First Suspect Networking

The error message says "payment system unavailable." The Oracle Payments documentation lists network connectivity as the first thing to check. In most IBY_0001 incidents, that is the right call — a misconfigured firewall rule, an expired gateway certificate, or a routing change are the most frequent causes in environments without custom servlets.

The team followed the standard checklist:

**tcpdump test from the application tier:**

\`\`\`bash
# Run on the EBS application server, capture traffic to gateway endpoint
tcpdump -i eth0 -w /tmp/gateway_capture.pcap host gateway.example.internal port 443

# In a second terminal, run a test call to the gateway
curl -v --tlsv1.2 --cacert /etc/ssl/certs/gateway_ca.crt \
  https://gateway.example.internal/api/payment/ping \
  -H "Authorization: Bearer \${GATEWAY_TEST_TOKEN}"
\`\`\`

The \`tcpdump\` output showed complete TLS handshakes — ClientHello, ServerHello, certificate exchange, Finished — followed by a successful HTTP 200 response. No TCP RST packets. No retransmissions. The network was fine.

**WebLogic thread analysis:**

During a batch run, a thread dump of the OACORE managed server showed the servlet executing normally on WebLogic execute threads. Thread states were RUNNABLE. No stuck threads detected. The managed server heap was well within limits.

### The Pivot

With network and WebLogic heap ruled out, the investigation turned to WebLogic server logs. The key is to correlate the exact timestamp of an IBY_0001 failure — visible in the concurrent request output and FND log — with what the OACORE managed server log (\`oacore_server1.log\`) shows at that same second.

\`\`\`bash
# Get the failure timestamp from the concurrent request
# Then scan the OACORE server log for that window
grep "2026-06-15 14:37" \
  $DOMAIN_HOME/servers/oacore_server1/logs/oacore_server1.log | \
  grep -i "exception\|error\|cursor\|ORA-"
\`\`\`

The result was not a network error. It was a Java exception stack trace that included:

\`\`\`
java.sql.SQLException: ORA-01000: maximum open cursors exceeded
  at oracle.jdbc.driver.T4CTTIoer.processError(T4CTTIoer.java:450)
  at oracle.jdbc.driver.T4CTTIoer.processError(T4CTTIoer.java:399)
  at payment.oracle.apps.iby.servlet.PaymentGatewayServlet.processInvoice(PaymentGatewayServlet.java:183)
  at payment.oracle.apps.iby.servlet.PaymentGatewayServlet.doPost(PaymentGatewayServlet.java:97)
\`\`\`

ORA-01000. Not a gateway error. Not a network error. The Oracle database was refusing to open any more cursors for the OACORE session. The servlet hit that refusal mid-processing, threw an unhandled exception, and WebLogic dropped the connection. IBY received nothing and reported IBY_0001.

---

## Root Cause Deep Dive — The JDBC Cursor Leak

### What Oracle Database Cursors Are

Every SQL statement that executes on an Oracle database session holds a server-side cursor — a handle in the database's shared memory that tracks the parsed statement, the execution plan, and the current position in the result set. The \`OPEN_CURSORS\` database parameter caps how many cursors a single session can hold simultaneously.

In a well-written application, cursors are opened and closed as needed. JDBC \`Statement\`, \`PreparedStatement\`, and \`ResultSet\` objects map directly to Oracle server-side cursors. Calling \`.close()\` on these JDBC objects releases the corresponding Oracle cursor.

If close is never called — or is called only in the exception-free code path — the cursor stays open on the Oracle session until the JVM garbage collector finalizes the object. At low batch volumes, GC runs often enough to collect orphaned objects before the cursor limit is hit. At 9,000 invoices processed in a tight loop, orphaned cursors accumulate faster than GC can collect them.

### How the Bug Works Step by Step

The legacy \`PaymentGatewayServlet.java\` had this pattern in its invoice processing loop:

\`\`\`java
// WEAK: If exception thrown during rs.next() loop, close() is never reached
try {
    Connection conn = AppsConnectionManager.getAppsConnection();
    Statement stmt = conn.createStatement();
    ResultSet rs = stmt.executeQuery(
        "SELECT payment_schedule_id, amount_due_remaining " +
        "FROM ar_payment_schedules_all " +
        "WHERE customer_trx_id = " + customerTrxId);
    while (rs.next()) {
        // Gateway call happens here — can throw IOException, SQLException, or RuntimeException
        processPayment(rs.getLong("payment_schedule_id"),
                       rs.getBigDecimal("amount_due_remaining"));
    }
    rs.close();   // Never reached if exception thrown in loop body
    stmt.close(); // Never reached if exception thrown in loop body
} catch (SQLException e) {
    log.error("Payment processing failed for trx: " + customerTrxId, e);
    // Cursor leak — stmt and rs still open, will not be released until GC
}
\`\`\`

Here is what happened at runtime with 9,000 invoices:

1. The Automatic Receipts Master Program submits 9,000 invoices to the IBY engine
2. IBY calls \`PaymentGatewayServlet\` for each invoice via HTTP
3. For each invoice, the servlet opens a JDBC \`Statement\` and executes a query against \`ar_payment_schedules_all\` and \`ra_customer_trx_all\`
4. In the exception-free path: the loop completes, \`rs.close()\` and \`stmt.close()\` are called, the Oracle cursor is released
5. But gateway API calls inside the loop can throw exceptions (network timeouts, malformed responses, temporary declines that trigger retry logic)
6. When an exception occurs inside \`while (rs.next())\`, execution jumps to \`catch\`, skipping both \`rs.close()\` and \`stmt.close()\` entirely
7. Those JDBC objects become orphaned — the JVM holds references to them in the exception object's stack frame, preventing immediate GC
8. Oracle still shows those cursors as open on the OACORE session
9. After several hundred such exceptions, the session has accumulated hundreds of orphaned open cursors
10. Oracle throws \`ORA-01000: maximum open cursors exceeded\`
11. The next \`stmt.executeQuery()\` call fails before the servlet can even query AR
12. The servlet's \`catch\` block logs the error but the HTTP response to IBY is never written — WebLogic closes the connection
13. IBY receives a dropped connection with no HTTP response: IBY_0001

### Why Small Batches Hide the Problem

This is the deceptive quality of this class of bug. A 50-invoice test batch runs cleanly because:

- The absolute number of leaked cursors is small (a few exceptions out of 50 invoices might leak 3-5 cursors)
- Between batch runs, the JVM GC finalizes orphaned JDBC objects, which triggers JDBC driver cleanup that closes the Oracle cursor
- The Oracle session cursor count drops back to near-zero before the next run

At 9,000 invoices in a single continuous run, the accumulation rate outpaces GC. Oracle's \`OPEN_CURSORS\` default is commonly 300 in EBS environments (or up to 1000 in tuned environments). At a few percent exception rate — even just gateway timeouts or declined cards that take a retry path — several dozen cursors can leak per hundred invoices. At a thousand invoices in, the session is approaching the limit. At 9,000 invoices, it exhausts it completely.

---

## The Fix — Try-with-Resources

### Java 7 Try-with-Resources

Java 7 introduced the try-with-resources statement. Any object implementing the \`AutoCloseable\` interface (which \`java.sql.Connection\`, \`Statement\`, \`PreparedStatement\`, and \`ResultSet\` all do) placed in a try-with-resources declaration is guaranteed to have its \`close()\` method called when the block exits — whether it exits normally, via \`return\`, or via any exception.

This is not just a coding convenience. It is the only reliable way to ensure resource cleanup in a Java method that can throw exceptions at arbitrary points in its execution.

### The Refactored Code

\`\`\`java
// ROBUST: close() called on all paths including exceptions
try (Connection conn = AppsConnectionManager.getAppsConnection();
     PreparedStatement pstmt = conn.prepareStatement(
         "SELECT payment_schedule_id, amount_due_remaining " +
         "FROM ar_payment_schedules_all " +
         "WHERE customer_trx_id = ?")) {

    pstmt.setLong(1, customerTrxId);

    try (ResultSet rs = pstmt.executeQuery()) {
        while (rs.next()) {
            processPayment(rs.getLong("payment_schedule_id"),
                           rs.getBigDecimal("amount_due_remaining"));
        }
    } // rs.close() guaranteed here — even if processPayment() throws

} catch (SQLException e) {
    log.error("Payment processing failed for trx: " + customerTrxId, e);
} // pstmt.close() and conn.close() guaranteed here — even if SQLException thrown
\`\`\`

The \`ResultSet\` is in its own inner try-with-resources so that \`rs.close()\` is guaranteed before \`pstmt.close()\` is called (closing a \`PreparedStatement\` while its \`ResultSet\` is open generates a driver warning on some versions; closing \`rs\` first is the correct sequence). Both the \`PreparedStatement\` and the \`Connection\` close on the outer try-with-resources exit, regardless of what happens in the loop body.

### Why PreparedStatement Instead of Statement

The original code used \`Statement\` with string concatenation to embed \`customerTrxId\` directly into the SQL text. Beyond the cursor leak, this creates a secondary problem: Oracle parses a new SQL string for every invoice (each SQL string is unique because the literal ID differs). This floods the shared pool with hard parses and increases shared pool fragmentation under a 9,000-invoice batch.

\`PreparedStatement\` with a bind variable (\`?\`) sends the same SQL text for every invoice. Oracle parses it once, caches the execution plan, and reuses it on every subsequent \`pstmt.executeQuery()\` call. This dramatically reduces shared pool pressure and is also the correct defense against SQL injection for code paths that handle user-controlled or external data.

### Deployment

\`\`\`bash
# 1. Compile from the application tier
cd $JAVA_TOP/payment/oracle/apps/iby/servlet/
javac -cp $JAVA_TOP:$ORACLE_HOME/jdbc/lib/ojdbc8.jar PaymentGatewayServlet.java

# 2. Verify the new class file timestamp
ls -la PaymentGatewayServlet.class

# 3. Bounce OACORE to flush the JVM class cache
$ADMIN_SCRIPTS_HOME/oacorectl.sh stop
sleep 30
$ADMIN_SCRIPTS_HOME/oacorectl.sh start

# 4. Confirm OACORE is back and healthy
$ADMIN_SCRIPTS_HOME/oacorectl.sh status
\`\`\`

The class file must be staged to \`\$JAVA_TOP/payment/oracle/apps/iby/servlet/\` — the same path the WebLogic classloader uses to find it. Bouncing OACORE is required; WebLogic caches class files in the JVM after first load and will continue using the old \`.class\` until the JVM restarts.

---

## Verification — Test Results and Residual Analysis

### Results After the Fix

A full 9,000-invoice batch was re-run after the servlet fix and OACORE restart:

| Outcome | Count | Notes |
|---|---|---|
| **IBY_0001 errors** | **0** | Was: intermittent aborts aborting the batch |
| Clean success (receipt created, gateway approved) | 4,999 | Processed end-to-end without error |
| Functional declines (gateway declined payment) | 3,997 | Gateway-level card declines — not EBS errors |
| Residual data anomalies | 4 | \`COMMUNICATION_ERROR\` in \`CC_ERROR_CODE\` on \`RA_CUSTOMER_TRX_ALL\` |

### Understanding Each Outcome Category

**IBY_0001 errors: 0.** The cursor leak is gone. The OACORE session cursor count stayed well below the \`OPEN_CURSORS\` limit throughout the 9,000-invoice run. No servlet crashes. No dropped connections.

**Clean success: 4,999.** These are the happy-path transactions: IBY engine called the servlet, servlet queried AR, servlet called the gateway, gateway approved, servlet returned success to IBY, IBY created the receipt.

**Functional declines: 3,997.** The gateway declined these payments — insufficient funds, expired card, flagged account, and similar gateway-level responses. These are not EBS errors. IBY received a well-formed response from the servlet, interpreted the decline code, and recorded the decline on the AR transaction. This is correct behavior.

**Residual data anomalies: 4.** These 4 transactions show \`COMMUNICATION_ERROR\` in the \`CC_ERROR_CODE\` column on \`RA_CUSTOMER_TRX_ALL\`. This column is populated by the IBY engine based on the error code the servlet returns. A \`COMMUNICATION_ERROR\` code means the servlet returned a response, but the response indicated a communication failure with the gateway for that specific transaction.

### The 4 Residual Records

The critical question for the residual 4 records is whether they represent a systemic code bug (meaning: the same error will recur on many transactions in future batches) or data-specific issues tied to the particular accounts involved (legacy accounts with specific characteristics that trigger an unusual gateway response).

The approach is to isolate these 4 transactions and re-run them individually with FND debug logging enabled at the IBY module level:

\`\`\`sql
-- Enable FND debug logging for the IBY module at statement level
BEGIN
  FND_PROFILE.SAVE('AFLOG_ENABLED', 'Y', 'SITE');
  FND_PROFILE.SAVE('AFLOG_LEVEL', '1', 'SITE');
  FND_PROFILE.SAVE('AFLOG_MODULE', 'iby%', 'SITE');
  COMMIT;
END;
/
\`\`\`

After re-running those 4 transactions in isolation and capturing their concurrent request IDs, query the FND log:

\`\`\`sql
SELECT log.log_sequence,
       TO_CHAR(log.timestamp, 'YYYY-MM-DD HH24:MI:SS.FF3') AS log_time,
       log.module,
       SUBSTR(log.message_text, 1, 200) AS message_text
FROM fnd_log_messages log,
     fnd_log_transaction_context con
WHERE con.transaction_id = &Your_Concurrent_Request_ID
  AND con.transaction_type = 'REQUEST'
  AND con.transaction_context_id = log.transaction_context_id
ORDER BY log.log_sequence;
\`\`\`

If the FND log shows the same gateway communication error on retry, it points to a data issue — something specific about those 4 accounts that the gateway rejects. If it clears on retry, it was transient gateway behavior during the original batch run. Either finding is acceptable; what matters is ruling out a systemic code path that will affect large populations of invoices.

Disable debug logging after testing to avoid accumulating FND log data in production:

\`\`\`sql
BEGIN
  FND_PROFILE.SAVE('AFLOG_ENABLED', 'N', 'SITE');
  COMMIT;
END;
/
\`\`\`

---

## Key Takeaways for Apps DBAs

**Never trust IBY_0001 at face value.** The error says "payment system unavailable" but it fires on any of three failure modes: network timeout, servlet exception (HTTP 500), or servlet crash (dropped connection). Check the WebLogic server log for Java exceptions before assuming network failure.

**Correlate timestamps.** Get the exact second an IBY_0001 failure occurred from the concurrent request output or FND log, then search the OACORE managed server log for Java exceptions within that same window. The exception stack trace in the WLS log is the ground truth; the IBY error message is just the symptom.

**Audit custom servlet code for JDBC resource management.** Every \`Statement\`, \`PreparedStatement\`, and \`ResultSet\` opened in a custom EBS Java extension must be closed in all code paths — not just the happy path. Use Java 7 try-with-resources for any code running on EBS 12.2 (which runs on Java 7+). If you cannot modify the code immediately, at minimum add \`finally\` blocks with null-checked \`close()\` calls.

**OPEN_CURSORS exhaustion is silent until it isn't.** The Oracle database does not warn you as a session approaches the cursor limit. It just throws ORA-01000 when the limit is hit. Proactively monitor cursor counts per session during heavy batch runs using \`gv\$open_cursor\` — the companion runbook provides the SQL for this.

**Do not raise OPEN_CURSORS as a permanent fix.** Raising the parameter buys time but does not fix the leak. It shifts the failure point from "400 leaked cursors" to "1400 leaked cursors" — the batch may survive a few more runs, but the underlying accumulation is still happening and will eventually hit the new ceiling. The architectural fix (try-with-resources) is the only correct resolution.

**Use PreparedStatement with bind variables in production JDBC code.** Beyond the SQL injection risk, concatenating literal values into SQL strings causes hard parses on every execution. In a loop over 9,000 invoices, hard parses flood the shared pool and can cause latch contention and elevated \`library cache lock\` wait events. Bind variables let Oracle reuse the parsed plan.

---

## Summary

One unclosed JDBC \`ResultSet\` per invoice, multiplied across thousands of invoices in a batch, produces a cascade: cursor count accumulation → cursor limit exhaustion → servlet crash mid-HTTP-response → IBY receives dropped connection → IBY_0001.

The crash does not happen at invoice 1 or invoice 10. It happens at invoice 400 or invoice 700, depending on how many exceptions trigger the leak path. Small test batches never accumulate enough leaked cursors to hit the limit — which is why this class of bug can survive years in production before a large enough batch exposes it.

The fix is architectural, not configurational. Java 7 try-with-resources eliminates the entire class of "forget to close in the exception path" bugs by making resource cleanup implicit and unconditional. Any Java extension code running in the EBS JVM that opens JDBC resources must use it.

The companion runbook provides SQL diagnostic scripts to detect cursor leaks in progress, identify the offending session and its open cursors, verify the fix took effect, and enable FND debug logging to resolve the residual data anomalies.
`,
};

async function main() {
  console.log('Inserting blog post...');
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
