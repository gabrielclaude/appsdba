import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Dealing with Post-Clone Oracle EBS AutoInvoice Failures: Fixing ORA-03113 and Partner Integrations',
  slug: 'oracle-ebs-postclone-autoinvoice-ora03113',
  excerpt:
    'A deep technical investigation into ORA-03113 and ORA-03114 failures in Oracle EBS AutoInvoice concurrent programs after a production-to-DEV/QA clone — how a Brazil-localized Mastersaf fiscal integration invoked via Oracle Workflow Business Events crashed the database shadow process, and the diagnostic and remediation steps that resolved it.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-30'),
  youtubeUrl: null,
  content: `Environment clones are standard DBA practice. A production-to-DEV or production-to-QA refresh gives development and testing teams a realistic data set and a true representation of the application state. What it also gives them — invisibly and silently — is every third-party integration configuration that production carries, including the network endpoints, authentication credentials, and Oracle Workflow Business Event subscriptions that make those integrations fire.

When the non-production network topology cannot satisfy the outbound calls those integrations expect, the result is not a clean error. It is ORA-03113 or ORA-03114: signals that look exactly like a network infrastructure problem but are actually the Oracle database shadow process terminating because application code running inside the session threw an unhandled exception it could not recover from.

This post documents a real post-clone incident involving Brazil-localized Oracle EBS AutoInvoice programs, a Mastersaf fiscal integration, and a UTL_TCP call that the non-production firewall refused. The diagnostic path, the SQL queries, and the remediation steps apply equally to any EBS environment where a third-party integration is invoked via an Oracle Workflow Business Event during transaction processing.

---

## The Environment and the Trigger

The affected environment was Oracle E-Business Suite 12.2 deployed with Brazilian fiscal localization. The production-to-DEV and production-to-QA clone was a standard RMAN duplicate with a post-clone configuration script. The clone completed without errors and all standard post-clone steps — running AutoConfig, bouncing application services, recompiling invalid objects — were completed before any testing began.

The first concurrent program submissions after the clone were the Brazil-localized AutoInvoice programs:

- **Programa-mestre de NFFs Automáticas** (AutoInvoice Master Program — Brazilian Nota Fiscal Fatura variant)
- **Programa de Importação de NFFs Automáticas** (AutoInvoice Import Program — Brazilian NFF import variant)

These programs are the Brazilian localizations of the standard Oracle AR AutoInvoice RAXTRX concurrent program family. They process invoice interface records and generate Notas Fiscais Fatura (NFFs) — Brazilian fiscal documents — in addition to the standard Oracle AR transaction records.

Both programs failed within seconds of entering the running phase. No processing completed. Every submission ended with an error status.

---

## The Symptom: Concurrent Program Log Output

The concurrent program output logs contained the following entries:

\`\`\`
APP-AR-11526: ORA-03113: end-of-file on communication channel
update RA_INTERFACE_LINES_GT L set INTERFACE_STATUS='P',LAST_UPDATE_D!
APP-AR-11526: 5069629/ar/src/autoinv/raadtr.lpc 168
Erro ao chamar raadtr()
Erro ao chamar raapic()

APP-AR-11526: ORA-03114: not connected to ORACLE
delete from AR_CREDIT_MEMO_AMOUNTS cm where cm.customer_trx_line_id
APP-AR-11526: 8393427/ar/lib/raarrt.lpc 1199
Erro ao chamar raarrt2()
\`\`\`

The error messages are in Portuguese because the EBS environment runs under a Brazilian locale. "Erro ao chamar" means "Error calling." The source references (raadtr.lpc, raarrt.lpc) point to Oracle AR AutoInvoice C source modules — standard Oracle EBS code, not customization.

### What ORA-03113 Actually Means

ORA-03113 (end-of-file on communication channel) is one of the most misread Oracle errors. At the network layer, it signals that the TCP connection between the client process and the Oracle server process was closed unexpectedly. In a genuine network failure scenario — a dropped network link, a firewall timeout, a NIC failure — this is the error you see on the client side when the Oracle listener or server process goes away.

In an EBS concurrent program context, the "client" is the concurrent manager worker process and the "server" is the Oracle database shadow process (server process) dedicated to that session. When the shadow process dies, the worker loses its connection and sees ORA-03113.

The critical distinction is this: **ORA-03113 reports that the shadow process died, not why it died.** The shadow process can die because of a network failure, but it can also die because application code running inside the session caused a fatal error that Oracle could not recover from. In EBS post-clone scenarios, the latter is almost always the explanation.

ORA-03114 (not connected to ORACLE) is the companion error seen when the same dead connection is used for a subsequent SQL operation — the session has already lost its server process, and any further database call immediately fails.

Neither error points to the database infrastructure. Both point to something that killed the session from the inside.

---

## The Investigation

### Step 1: Rule Out Infrastructure

The first diagnostic pass covered the obvious suspects:

- **Alert log review**: No ORA-600, ORA-7445, or instance-level errors around the failure times.
- **Database availability**: Other sessions and concurrent programs in the same instance were running normally throughout.
- **Network connectivity**: The application tier could connect to the database tier on all standard ports. sqlplus connections from the application server succeeded.
- **Invalid object count**: A baseline query showed a post-clone invalid object count (expected), but the AutoInvoice Java and PL/SQL components compiled successfully when recompiled.

Infrastructure was ruled out. The failure was session-specific and reproducible: every AutoInvoice submission failed within seconds, every time.

### Step 2: Enable Session Tracing

Oracle EBS provides the ability to enable SQL trace for a specific concurrent request via the Diagnostics responsibility or directly through FND_CTL_REQUEST. The trace was enabled for the AutoInvoice submission at level 12 (SQL trace with bind variables and wait events).

The trace file was located on the database server under \`\$ORACLE_BASE/diag/rdbms/\${ORACLE_SID}/\${ORACLE_SID}/trace/\`. The relevant portion of the trace file, stripped of bind variable noise, showed:

\`\`\`
PARSING IN CURSOR ... len=... dep=0 uid=... oct=6 lid=... tim=...
update RA_INTERFACE_LINES_GT L set INTERFACE_STATUS='P'...
END OF STMT
EXEC #...: ...
*** SESSION KILLED ***
\`\`\`

Immediately before the "SESSION KILLED" marker, the trace showed a call stack entering a Java stored procedure: **\`Receiver.DfeUtil.PutFile\`**. The Java call did not return. The session was terminated from within that Java execution context.

### Step 3: Identify the Java Stored Procedure

With the class name from the trace, the next step was confirming the object existed and identifying its owner:

\`\`\`sql
-- Confirm the Java class exists and check its status
SELECT owner,
       object_name,
       object_type,
       status,
       last_ddl_time
FROM   dba_objects
WHERE  object_name LIKE '%DfeUtil%'
    OR object_name LIKE '%Mastersaf%'
    OR object_name LIKE '%Receiver%'
ORDER  BY owner, object_type, object_name;
\`\`\`

The query returned rows showing the Java class \`Receiver/DfeUtil\` owned by APPS, with object_type \`JAVA CLASS\`, status \`VALID\`. The class had been compiled and was in a valid state — meaning it would execute. It belonged to Mastersaf, a Brazilian fiscal software vendor whose product integrates with Oracle EBS to generate and transmit Notas Fiscais Eletrônicas (NF-e) and Notas Fiscais Fatura (NFF) to SEFAZ (Secretaria de Estado de Fazenda — the Brazilian state tax authority).

### Step 4: Find the Invocation Path

If the Java class was being called during AutoInvoice processing, there had to be an invocation point. The two most common integration patterns in Oracle EBS are database triggers and Oracle Workflow Business Events.

Triggers were checked first:

\`\`\`sql
-- Check for Mastersaf or fiscal integration triggers on key AR tables
SELECT trigger_name,
       trigger_type,
       triggering_event,
       status,
       table_name
FROM   dba_triggers
WHERE  table_name IN ('RA_CUSTOMER_TRX_ALL', 'RA_INTERFACE_LINES_ALL')
ORDER  BY table_name, trigger_name;
\`\`\`

No Mastersaf triggers were found on either table. The trigger approach was ruled out.

The Workflow Business Event subscriptions were queried next:

\`\`\`sql
-- Find Workflow Business Event subscriptions that reference the fiscal partner
SELECT we.name            AS event_name,
       wes.system_guid,
       wes.java_function,
       wes.rule_function,
       wes.status_code,
       wes.phase
FROM   wf_events we
JOIN   wf_event_subscriptions wes
       ON we.guid = wes.event_filter_guid
WHERE  wes.java_function LIKE '%Mastersaf%'
    OR wes.java_function LIKE '%DfeUtil%'
    OR wes.java_function LIKE '%Receiver%'
ORDER  BY we.name;
\`\`\`

This returned the answer. A Business Event subscription was found with:

- **Event name**: an Oracle AR transaction-related business event (fired on AutoInvoice completion)
- **java_function**: \`Receiver.DfeUtil.PutFile\` — the exact class identified in the trace
- **status_code**: \`ENABLED\`

The invocation path was now complete. During AutoInvoice processing, Oracle Workflow fires a Business Event on transaction creation. The subscription to that event calls \`Receiver.DfeUtil.PutFile\` via the Java stored procedure mechanism. That method attempts to transmit the fiscal document data to the SEFAZ endpoint using UTL_TCP. In the non-production environment, the outbound TCP connection is blocked by firewall rules. The Java method throws an unhandled network exception. The Oracle JVM running inside the database session cannot recover from it. The server process terminates.

---

## Why Java Stored Procedures Kill the Session

This requires a brief explanation because it surprises many DBAs who are accustomed to PL/SQL exceptions being catchable and non-fatal.

When Oracle executes a Java stored procedure, it runs the Java bytecode inside an Oracle JVM that is embedded in the database server process. A Java exception that is caught and handled within the Java code is transparent to Oracle — it looks like a normal return. A Java exception that propagates all the way up the call stack without being caught causes the Oracle JVM to terminate the server process abnormally.

Most Java exceptions thrown inside Oracle database Java stored procedures are wrapped by ORA-29532 (Java call terminated by uncaught Java exception). But a TCP connection failure that occurs during a streaming write — the pattern used by UTL_TCP when sending fiscal document XML to SEFAZ — can propagate as an unrecoverable I/O error that bypasses ORA-29532 wrapping and manifests as an abrupt server process termination: ORA-03113 on the client side.

The UTL_TCP package itself is a PL/SQL interface to TCP connections. When a Java stored procedure uses Java's native \`java.net.Socket\` class internally (as Mastersaf's \`PutFile\` method does), it bypasses the PL/SQL UTL_TCP layer entirely and makes the network call directly from within the JVM. If that Java socket call throws an exception that the Java code does not catch, the result is shadow process death.

---

## Why Clones Create This Specific Problem

The clone is a byte-for-byte copy of the production database. It carries:

1. **The Mastersaf Java class files** — compiled and valid in APPS schema
2. **The Oracle Workflow Business Event subscription** — status ENABLED, pointing to the Java class
3. **The Mastersaf parameter tables** — containing the production SEFAZ endpoint hostname and port
4. **The Mastersaf configuration records** — identifying which transaction types trigger fiscal document generation

Production has firewall rules that allow outbound TCP connections from the database server to the SEFAZ endpoint on the required port. Non-production environments do not. The outbound route does not exist in the test network. The Java socket connect() call blocks until it times out, or is refused immediately if the firewall returns a TCP RST. Either way, the Java exception propagates, and the shadow process dies.

This is not a bug in Mastersaf's code. It is an integration design assumption — that any environment running this code has network access to SEFAZ. Production does. Cloned non-production environments do not.

---

## Diagnostic Queries Reference

The following queries form a complete diagnostic kit for this class of post-clone failure. Run them in sequence after any post-clone AutoInvoice failure that shows ORA-03113.

**1. Baseline invalid object count (noise reduction)**

\`\`\`sql
SELECT status,
       COUNT(*) AS object_count
FROM   dba_objects
GROUP  BY status
ORDER  BY 1;
\`\`\`

A high count of INVALID objects after a clone is normal. Recompiling first removes noise so subsequent queries return meaningful results. Invalid Java classes in APPS schema are of particular interest — they may prevent the problematic Java call from executing at all (which can temporarily mask the symptom).

**2. Locate the Java class and related objects**

\`\`\`sql
SELECT owner,
       object_name,
       object_type,
       status,
       last_ddl_time
FROM   dba_objects
WHERE  object_name LIKE '%DfeUtil%'
    OR object_name LIKE '%Mastersaf%'
    OR object_name LIKE '%Receiver%'
ORDER  BY owner, object_type, object_name;
\`\`\`

**3. Check triggers on key AutoInvoice tables**

\`\`\`sql
SELECT trigger_name,
       trigger_type,
       triggering_event,
       status,
       table_name
FROM   dba_triggers
WHERE  table_name IN ('RA_CUSTOMER_TRX_ALL', 'RA_INTERFACE_LINES_ALL')
ORDER  BY table_name, trigger_name;
\`\`\`

If this query returns Mastersaf triggers, the invocation path is a trigger, not a Business Event. Disable the trigger rather than the subscription.

**4. Find Workflow Business Event subscriptions referencing the partner**

\`\`\`sql
SELECT we.name            AS event_name,
       wes.system_guid,
       wes.java_function,
       wes.rule_function,
       wes.status_code,
       wes.phase,
       wes.priority
FROM   wf_events we
JOIN   wf_event_subscriptions wes
       ON we.guid = wes.event_filter_guid
WHERE  wes.java_function LIKE '%Mastersaf%'
    OR wes.java_function LIKE '%DfeUtil%'
    OR wes.java_function LIKE '%Receiver%'
ORDER  BY we.name;
\`\`\`

**5. Check indexes on RA_CUSTOMER_TRX_ALL for rebuild candidates**

\`\`\`sql
SELECT index_name,
       status,
       index_type,
       partitioned
FROM   dba_indexes
WHERE  table_name = 'RA_CUSTOMER_TRX_ALL'
  AND  status != 'VALID'
ORDER  BY index_name;
\`\`\`

A shadow process crash mid-transaction can leave indexes in an UNUSABLE state. Any result from this query requires index rebuilds before AutoInvoice submissions will process cleanly.

**6. Check network ACLs governing outbound TCP access**

\`\`\`sql
-- Oracle 11g and above: UTL_TCP outbound connections require ACL grants
SELECT acl,
       host,
       lower_port,
       upper_port,
       privilege,
       is_grant
FROM   dba_network_acls
ORDER  BY host, lower_port;
\`\`\`

In a post-clone non-production environment, you may want to either revoke the ACL grant to the SEFAZ host (preventing the Java call from even reaching the TCP layer) or add a new ACL grant pointing to a sandbox endpoint.

---

## Two Concrete Examples

### Example 1: Mastersaf NFF Integration (Brazil Localization)

A Brazilian Oracle EBS customer running 12.2.10 with Mastersaf NFF integration. AutoInvoice fails immediately for all transaction types after a production-to-QA clone. The Workflow Business Event subscription fires on every NFF-eligible transaction regardless of whether fiscal output is needed in QA.

Investigation followed the path documented above. The Mastersaf parameter table (\`MSF_PARAMETERS\` or equivalent, depending on Mastersaf version) contained the production SEFAZ endpoint. The Business Event subscription was ENABLED.

**Resolution applied in QA**: The Mastersaf integration team's homologation (sandbox) environment was configured. A single parameter table update redirected outbound calls from the production SEFAZ endpoint to the Mastersaf homologation endpoint, which the QA network could reach. The Business Event subscription remained ENABLED, allowing realistic fiscal integration testing against the sandbox.

**Resolution applied in DEV**: The Business Event subscription was disabled. DEV does not need fiscal document generation. Disabling the subscription meant AutoInvoice ran without any fiscal output, which is acceptable for functional and technical development work.

### Example 2: Generic Third-Party EDI Integration (Same ORA-03113 Pattern)

A different client — not using Mastersaf, but using a custom third-party EDI integration for invoice delivery. The integration used a custom Java stored procedure invoked via a Workflow Business Event to PUT invoice XML to an SFTP server that only existed in production. Post-clone to UAT: ORA-03113 appeared identically, at the same point in AutoInvoice processing, in the concurrent program log.

The integration team had anticipated this problem partially. They maintained a parameter table (\`XX_INTEGRATION_PARAMS\`) storing environment-specific endpoints, with a column for environment identifier and a column for the target SFTP hostname. Post-clone, a single UPDATE statement redirected all outbound calls to the test SFTP server:

\`\`\`sql
-- Redirect EDI integration endpoint after clone (UAT environment)
UPDATE xx_integration_params
SET    endpoint_host = 'sftp-uat.internal.example.com',
       endpoint_port = 22,
       environment   = 'UAT',
       updated_by    = -1,
       last_update_date = SYSDATE
WHERE  integration_code = 'EDI_INVOICE_OUT'
  AND  environment      = 'PROD';

COMMIT;
\`\`\`

This is the correct long-term design pattern: the integration vendor does not control endpoint routing; the DBA team controls it via a parameter table that can be updated post-clone without modifying code or Workflow configuration.

---

## Resolution Steps

### Step 1: Recompile Invalid Objects

Run utlrp.sql as SYS immediately after the clone, before any application testing:

\`\`\`sql
-- Run as SYS
@?/rdbms/admin/utlrp.sql
\`\`\`

Why this matters in this specific scenario: If the Mastersaf Java class is INVALID after the clone (which happens if the class references other Java classes that are invalid), the Business Event invocation will fail with a compilation error rather than a TCP exception. This actually prevents ORA-03113 in that specific session, but it masks the root cause and gives a false impression that AutoInvoice is working. After utlrp.sql recompiles the Java class to VALID, the TCP exception begins occurring and ORA-03113 appears. Recompile first, then diagnose.

### Step 2: Rebuild Affected Indexes

If concurrent program failures occurred mid-transaction before this investigation completed, index corruption on AutoInvoice-related tables is possible:

\`\`\`sql
-- Generate rebuild statements for UNUSABLE indexes on key AR tables
SELECT 'ALTER INDEX ' || owner || '.' || index_name || ' REBUILD ONLINE;' AS rebuild_stmt
FROM   dba_indexes
WHERE  table_name IN (
         'RA_CUSTOMER_TRX_ALL',
         'RA_CUSTOMER_TRX_LINES_ALL',
         'RA_INTERFACE_LINES_ALL',
         'RA_INTERFACE_ERRORS_ALL',
         'AR_CREDIT_MEMO_AMOUNTS'
       )
  AND  status != 'VALID'
  AND  owner = 'AR'
ORDER  BY table_name, index_name;
\`\`\`

Execute each generated statement. For partitioned indexes, replace \`REBUILD ONLINE\` with \`REBUILD PARTITION <partition_name> ONLINE\` for each UNUSABLE partition.

### Step 3: Validate Database Links

Post-clone, all database links carry production credentials pointing at production target databases. These links will either fail to connect (if the non-production network cannot reach production targets) or, worse, succeed and allow non-production sessions to read or write production data.

\`\`\`sql
-- List all database links in the cloned environment
SELECT owner,
       db_link,
       username,
       host,
       created
FROM   dba_db_links
ORDER  BY owner, db_link;
\`\`\`

For each link, either drop it, modify the \`host\` definition to point to a non-production target, or explicitly test it:

\`\`\`sql
-- Test a specific database link (replace PROD_LINK with actual link name)
SELECT * FROM dual@PROD_LINK;
\`\`\`

A link that successfully connects to production from a non-production environment is a data governance risk. Drop or reroute it.

### Step 4: Disable or Reroute the Workflow Business Event Subscription

This is the root cause fix. There are two options:

**Option A — Disable the subscription (appropriate for DEV)**

\`\`\`sql
-- Disable the Mastersaf Workflow Business Event subscription in non-production
-- Identify the subscription GUID first
SELECT wes.guid,
       we.name AS event_name,
       wes.java_function,
       wes.status_code
FROM   wf_events we
JOIN   wf_event_subscriptions wes ON we.guid = wes.event_filter_guid
WHERE  wes.java_function LIKE '%DfeUtil%'
    OR wes.java_function LIKE '%Mastersaf%';

-- Disable using the GUID returned above
UPDATE wf_event_subscriptions
SET    status_code = 'DISABLED'
WHERE  guid = '<subscription_guid_from_above>';

COMMIT;
\`\`\`

Disabling the subscription means AutoInvoice will run without fiscal document generation. This is acceptable in DEV where the goal is functional or technical testing, not fiscal compliance validation.

**Option B — Point to sandbox/homologation endpoint (appropriate for QA and UAT)**

This requires access to the Mastersaf configuration tables. Work with the Mastersaf DBA or integration team to update the endpoint parameters to the Mastersaf homologation environment. The subscription remains ENABLED, and AutoInvoice generates and transmits fiscal documents to the sandbox SEFAZ endpoint rather than production SEFAZ.

This is the correct approach for QA and UAT environments where fiscal integration testing is part of the test plan.

### Step 5: Verify UTL_TCP Network Access Control Lists

In Oracle 11g and above, outbound TCP connections from the database (including those made by Java stored procedures via \`java.net.Socket\`) require an ACL grant. Post-clone, the ACL grants are copied from production.

\`\`\`sql
-- Check which ACLs exist and what hosts they permit
SELECT acl,
       host,
       lower_port,
       upper_port
FROM   dba_network_acls
ORDER  BY host;

-- Check which database users have grants on each ACL
SELECT acl,
       principal,
       privilege,
       is_grant
FROM   dba_network_acl_privileges
ORDER  BY acl, principal;
\`\`\`

For a non-production environment where fiscal integration should be disabled, revoke the ACL grant that permits connections to the SEFAZ endpoint:

\`\`\`sql
-- Revoke outbound TCP permission to production SEFAZ endpoint (DEV only)
BEGIN
  DBMS_NETWORK_ACL_ADMIN.revoke_privilege(
    acl       => '/sys/acls/mastersaf-sefaz.xml',   -- use actual ACL name from dba_network_acls
    principal => 'APPS',
    privilege => 'connect'
  );
  COMMIT;
END;
/
\`\`\`

Revoking the ACL makes the Java socket call fail with a permission exception rather than a TCP timeout, which is faster and produces a cleaner error — ORA-29532 wrapping \`java.security.AccessControlException\` — rather than ORA-03113.

---

## Prevention: Post-Clone Runbook Items

The following items should be part of every post-clone runbook for Oracle EBS environments that carry third-party fiscal or EDI integrations.

### 1. Automated Subscription Audit and Disable Script

\`\`\`sql
-- Post-clone: disable all external Java Workflow Business Event subscriptions
-- Run as APPS after every non-production clone
-- Review the output before executing the UPDATE to confirm the correct subscriptions

SELECT wes.guid,
       we.name          AS event_name,
       wes.java_function,
       wes.status_code
FROM   wf_events we
JOIN   wf_event_subscriptions wes
       ON we.guid = wes.event_filter_guid
WHERE  wes.java_function IS NOT NULL
  AND  wes.java_function NOT LIKE '%oracle%'      -- exclude Oracle standard subscriptions
  AND  wes.java_function NOT LIKE '%Oracle%'
  AND  wes.status_code = 'ENABLED'
ORDER  BY we.name;

-- After reviewing, execute the disable:
-- UPDATE wf_event_subscriptions
-- SET    status_code = 'DISABLED'
-- WHERE  java_function IS NOT NULL
--   AND  java_function NOT LIKE '%oracle%'
--   AND  java_function NOT LIKE '%Oracle%'
--   AND  status_code = 'ENABLED';
-- COMMIT;
\`\`\`

The commented UPDATE is intentionally left commented. Review the SELECT output first. Some third-party Java subscriptions may be Oracle-delivered and should not be disabled.

### 2. Environment-Aware Parameter Tables

The long-term architectural solution is to move integration endpoint configuration out of the vendor's parameter tables (which the DBA team cannot easily version-control or automate) and into a DBA-controlled table that maps environment to endpoint:

\`\`\`sql
-- Example: DBA-controlled integration endpoint table
-- Populate this table post-clone with non-production endpoints
-- The integration Java code reads from this table at runtime

CREATE TABLE apps.dba_integration_endpoints (
  integration_code   VARCHAR2(50)  NOT NULL,
  environment_name   VARCHAR2(20)  NOT NULL,
  endpoint_host      VARCHAR2(255) NOT NULL,
  endpoint_port      NUMBER(5),
  endpoint_protocol  VARCHAR2(20),
  is_active          VARCHAR2(1)   DEFAULT 'Y',
  last_updated_by    VARCHAR2(100),
  last_update_date   DATE          DEFAULT SYSDATE,
  CONSTRAINT dba_int_ep_pk PRIMARY KEY (integration_code, environment_name)
);
\`\`\`

Post-clone, a single script populates this table with non-production endpoints. The integration vendor's Java code is modified (once) to read the endpoint from this table using a JDBC call, removing hardcoded production endpoint references from the Mastersaf configuration tables.

### 3. Post-Clone Verification Query

Add this query to the post-clone verification checklist. It confirms that no external Java subscriptions are in ENABLED state before the first concurrent program submission:

\`\`\`sql
-- Post-clone verification: confirm no external Java subscriptions are enabled
SELECT COUNT(*) AS external_enabled_subscriptions
FROM   wf_event_subscriptions
WHERE  java_function IS NOT NULL
  AND  java_function NOT LIKE '%oracle%'
  AND  java_function NOT LIKE '%Oracle%'
  AND  status_code = 'ENABLED';
\`\`\`

A count of zero is the target for DEV environments. For QA and UAT, review each enabled subscription and confirm that its target endpoint is a non-production sandbox.

---

## Summary

ORA-03113 in post-clone Oracle EBS AutoInvoice is almost never a network infrastructure problem. The error signature — a concurrent program log showing ORA-03113 or ORA-03114 immediately after the program enters the running phase — points to a shadow process killed from within the session by application code that threw an unhandled exception.

The diagnostic path is predictable once you know the pattern:

1. Enable SQL trace for the failing concurrent request.
2. Identify the Java stored procedure or UTL_TCP call in the trace file immediately before the "SESSION KILLED" marker.
3. Query \`dba_objects\` to confirm the Java class owner and status.
4. Query \`dba_triggers\` on the key AR tables to determine whether the invocation is a trigger or a Business Event.
5. Query \`wf_event_subscriptions\` to find and disable or reroute the subscription.

The database healing steps — utlrp.sql to recompile invalids, index rebuilds on AutoInvoice tables, database link validation — are necessary to reduce noise and ensure the environment is clean, but they do not fix the root cause. The root cause is always the same: a production-only external call that the non-production network cannot satisfy, firing via a Workflow Business Event that the clone brought over in its ENABLED state.

The prevention is a post-clone runbook that treats Workflow Business Event subscription management as a first-class step alongside AutoConfig and utlrp. For environments with multiple third-party integrations, the automated subscription audit query provides a reproducible, auditable way to identify and disable every external Java subscriber before testing begins.`,
};

async function main() {
  console.log('Inserting post-clone AutoInvoice blog post...');
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
