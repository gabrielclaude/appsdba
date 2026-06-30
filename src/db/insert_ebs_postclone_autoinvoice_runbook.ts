import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Post-Clone AutoInvoice ORA-03113 Runbook: Isolating Third-Party Integration Failures in Oracle EBS',
  slug: 'oracle-ebs-postclone-autoinvoice-ora03113-runbook',
  excerpt:
    'Phased runbook for diagnosing and resolving ORA-03113/ORA-03114 failures in Oracle EBS AutoInvoice after a production-to-non-production clone. Covers Workflow Business Event subscription triage, Mastersaf/UTL_TCP outbound connection isolation, database object recompilation, index and DB link validation, and a permanent post-clone checklist to prevent recurrence.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-30'),
  youtubeUrl: null,
  content: `## Overview

This runbook addresses a specific and reproducible failure mode that appears immediately after cloning an Oracle EBS production database to a DEV, QA, or UAT environment. AutoInvoice concurrent programs terminate with ORA-03113 (end-of-file on communication channel) or ORA-03114 (not connected to Oracle) on every run, yet the production source environment is completely healthy.

**Root cause summary:** A third-party fiscal/partner Java stored procedure — commonly Mastersaf's \`Receiver.DfeUtil.PutFile\` or an equivalent NF-e integration class — is invoked by an Oracle Workflow Business Event subscription that fires during AutoInvoice processing. In production the Java class connects outbound via UTL_TCP to a licensed fiscal endpoint. In non-production that endpoint is either unreachable (firewall block) or the connection is refused (wrong credentials/certificate for the environment). The Java exception is not caught, it propagates up through the Oracle JVM, the database shadow process abnormally terminates, and the client-side JDBC/Net session sees ORA-03113.

**This runbook does NOT apply to:**
- Random ORA-03113 caused by network packet loss or listener bounce
- ORA-03113 on non-AutoInvoice programs (different code path)
- Environments where no third-party fiscal/NF-e integration is installed

---

## Phase 1: Incident Confirmation (5 minutes)

### 1.1 Verify the error signature

The distinguishing signature of this failure mode is ORA-03113 that appears immediately after the last line of AR concurrent program output, often preceded by APP-AR-11526 (AutoInvoice validation complete) or APP-AR-11548. The program does not produce a partial commit — it dies mid-session.

Open the concurrent request log from Requests → View Requests → View Log:

\`\`\`
APP-AR-11526: AutoInvoice validation complete
...
ORA-03113: end-of-file on communication channel
\`\`\`

If the log shows ORA-03113 without any preceding ORA-600 or ORA-7445, you are almost certainly in the integration failure scenario, not a genuine database crash.

### 1.2 Distinguish post-clone integration failure from genuine network ORA-03113

| Characteristic | Genuine network ORA-03113 | Post-clone integration ORA-03113 |
|---|---|---|
| Reproducibility | Random, intermittent | 100% reproducible on every AutoInvoice run |
| Programs affected | Any program, any timing | Only AutoInvoice (or programs that fire the same WF event) |
| Database alert log | Shows process death, OS process killed | Shows normal shutdown of shadow process |
| ORA-600/ORA-7445 | May be present | Absent |
| Network team confirmation | Packet loss or firewall drops detected | No network anomaly detected |
| Alert log timestamp | Random | Aligns precisely with AutoInvoice submission time |

### 1.3 Check whether this is a freshly cloned environment

\`\`\`sql
-- If DB_NAME does not match the expected non-production name,
-- the database may still be pointing to production identity
SELECT name          AS db_name,
       db_unique_name,
       open_mode,
       created,
       dbid
FROM   v\$database;

-- Cross-check instance name
SELECT instance_name,
       host_name,
       version,
       status
FROM   v\$instance;
\`\`\`

In a correctly cloned non-production environment, \`DB_NAME\` and \`INSTANCE_NAME\` should reflect the non-production SID (e.g., EBSDEV, EBSQA). If they still show the production SID after clone, the NLS and parameter file may not have been updated — this is a separate issue but worth flagging.

### 1.4 Locate the database alert log

\`\`\`sql
-- Find the background dump destination (alert log directory)
SELECT value AS background_dump_dest
FROM   v\$parameter
WHERE  name = 'background_dump_dest';

-- For Oracle 11g+ ADR-based alert log:
SELECT value AS adr_home
FROM   v\$diag_info
WHERE  name = 'Diag Trace';
\`\`\`

Review the alert log around the time of the AutoInvoice failure. The key line to look for is a process death entry such as:

\`\`\`
Process J999 died, see its trace file
\`\`\`

If the alert log shows only a clean process exit with no ORA-600 or stack dump, this confirms the JVM raised an uncaught exception that terminated the shadow process gracefully from the OS perspective but abruptly from the client perspective.

### 1.5 Query recent AutoInvoice concurrent request failures

\`\`\`sql
-- Last 5 AutoInvoice requests in error state
SELECT fcr.request_id,
       fcr.phase_code,
       fcr.status_code,
       fcr.actual_start_date,
       fcr.actual_completion_date,
       fcp.concurrent_program_name,
       fcr.argument_text
FROM   fnd_concurrent_requests  fcr
JOIN   fnd_concurrent_programs  fcp
       ON  fcr.concurrent_program_id = fcp.concurrent_program_id
       AND fcr.program_application_id = fcp.application_id
WHERE  fcp.concurrent_program_name IN ('RAXTRX','ARXINV','RAXMTR')
  AND  fcr.phase_code   = 'C'
  AND  fcr.status_code  = 'E'
ORDER BY fcr.actual_start_date DESC
FETCH FIRST 5 ROWS ONLY;

-- Pull associated log messages for the most recent failed request
-- Replace :request_id with the value from the query above
SELECT flm.log_sequence,
       flm.module,
       flm.message_text,
       flm.log_level
FROM   fnd_log_messages flm
WHERE  flm.transaction_context_id = (
         SELECT fct.transaction_context_id
         FROM   fnd_log_transaction_context fct
         WHERE  fct.module        = 'fnd.plsql.fnd_concurrent'
           AND  fct.transaction_id = :request_id
         FETCH FIRST 1 ROW ONLY
       )
ORDER BY flm.log_sequence DESC
FETCH FIRST 50 ROWS ONLY;
\`\`\`

---

## Phase 2: Database Object Triage

After a clone, it is normal for a subset of database objects to be invalid. Some of those invalid objects may be in the code path AutoInvoice exercises. Recompilation must be the first remediation step before any other diagnosis.

### 2.1 Check overall invalid object count

\`\`\`sql
SELECT status,
       COUNT(*) AS object_count
FROM   dba_objects
GROUP BY status
ORDER BY 1;
\`\`\`

A freshly cloned EBS R12.2 environment will typically show several hundred INVALID objects before \`utlrp\` is run. This is expected and does not by itself cause ORA-03113 — but it must be resolved first to eliminate it as a contributing factor.

### 2.2 Recompile all invalid objects

Run as SYSDBA:

\`\`\`sql
@?/rdbms/admin/utlrp.sql
\`\`\`

This script recompiles all invalid PL/SQL and Java objects in parallel. On a large EBS schema it can take 15–45 minutes. Do not interrupt it.

### 2.3 Re-check invalid count after utlrp

\`\`\`sql
SELECT status,
       COUNT(*) AS object_count
FROM   dba_objects
GROUP BY status
ORDER BY 1;
\`\`\`

Objects that remain INVALID after \`utlrp\` are genuinely broken — either due to missing dependencies, compilation errors, or, in the case of Java classes, classpath issues introduced by the clone. Document them. For the purposes of this runbook, focus on Java objects in the next step.

### 2.4 Identify third-party Java classes in the database

\`\`\`sql
-- All Java objects from non-Oracle, non-SYS owners
SELECT owner,
       object_name,
       object_type,
       status,
       last_ddl_time
FROM   dba_objects
WHERE  object_type IN ('JAVA CLASS','JAVA SOURCE','JAVA RESOURCE')
  AND  owner NOT IN ('SYS','SYSTEM','ORDSYS','MDSYS','XDB',
                     'WMSYS','EXFSYS','CTXSYS','OLAPSYS','SYSMAN')
ORDER BY owner, object_type, object_name;
\`\`\`

\`\`\`sql
-- Specifically look for fiscal/NF-e integration classes
SELECT owner,
       object_name,
       object_type,
       status
FROM   dba_objects
WHERE  object_type IN ('JAVA CLASS','JAVA SOURCE')
  AND  (UPPER(object_name) LIKE '%DFEUTIL%'
     OR UPPER(object_name) LIKE '%MASTERSAF%'
     OR UPPER(object_name) LIKE '%RECEIVER%'
     OR UPPER(object_name) LIKE '%FISCAL%'
     OR UPPER(object_name) LIKE '%NFE%'
     OR UPPER(object_name) LIKE '%SEFAZ%')
ORDER BY owner, object_name;
\`\`\`

### 2.5 Check Java class validity and recompile if needed

\`\`\`sql
SELECT object_name, object_type, status
FROM   dba_objects
WHERE  object_type IN ('JAVA CLASS','JAVA SOURCE')
  AND  status = 'INVALID'
ORDER BY object_type, object_name;
\`\`\`

To recompile a specific Java class (note: the class name is case-sensitive and uses forward-slash package notation):

\`\`\`sql
-- Example: recompile Mastersaf DfeUtil class
ALTER JAVA CLASS "Receiver/DfeUtil" COMPILE;

-- Verify
SELECT status FROM dba_objects
WHERE  object_name = 'Receiver/DfeUtil'
  AND  object_type = 'JAVA CLASS';
\`\`\`

**Important:** A Java class can be VALID in the database but still fail at runtime because it makes an outbound network connection that the non-production environment cannot complete. VALID status does not mean the class will execute successfully — it means it compiled without errors. This is exactly the trap this scenario falls into.

---

## Phase 3: Identify the Workflow Trigger

The most important diagnostic step: confirm that AutoInvoice is triggering the third-party Java code through an Oracle Workflow Business Event subscription, not through a database trigger.

### 3.1 Confirm no database triggers on key AutoInvoice tables

\`\`\`sql
SELECT trigger_name,
       trigger_type,
       triggering_event,
       status,
       action_type
FROM   dba_triggers
WHERE  table_name IN ('RA_CUSTOMER_TRX_ALL',
                      'RA_INTERFACE_LINES_ALL',
                      'RA_INTERFACE_LINES_GT',
                      'RA_CUSTOMER_TRX_LINES_ALL')
ORDER BY table_name, trigger_name;
\`\`\`

If this query returns rows with action_type = 'CALL' and the called code invokes a Java stored procedure, you have a trigger-based invocation path. More commonly in EBS fiscal integrations, this query returns no rows — the invocation path is entirely through Workflow.

### 3.2 Search Workflow Business Event subscriptions for partner Java functions

\`\`\`sql
-- Targeted search for known fiscal/NF-e integration vendors
SELECT we.name            AS event_name,
       we.display_name,
       wes.system_guid,
       wes.java_function,
       wes.status_code,
       wes.rule_function,
       wes.out_agent_guid
FROM   wf_events             we
JOIN   wf_event_subscriptions wes ON we.guid = wes.event_filter_guid
WHERE  wes.java_function IS NOT NULL
  AND (UPPER(wes.java_function) LIKE '%MASTERSAF%'
    OR UPPER(wes.java_function) LIKE '%DFEUTIL%'
    OR UPPER(wes.java_function) LIKE '%RECEIVER%'
    OR UPPER(wes.java_function) LIKE '%FISCAL%'
    OR UPPER(wes.java_function) LIKE '%NFE%'
    OR UPPER(wes.java_function) LIKE '%SEFAZ%')
ORDER BY we.name;
\`\`\`

### 3.3 Broader search — all enabled external Java subscriptions

\`\`\`sql
-- Show every enabled Workflow subscription that calls a Java function
-- Review carefully: any of these can produce ORA-03113 if the Java
-- function makes outbound network connections unavailable in non-prod
SELECT we.name        AS event_name,
       wes.java_function,
       wes.status_code,
       wes.phase,
       wes.rule_data,
       wes.subscription_guid
FROM   wf_events             we
JOIN   wf_event_subscriptions wes ON we.guid = wes.event_filter_guid
WHERE  wes.java_function IS NOT NULL
  AND  wes.status_code = 'ENABLED'
ORDER BY we.name;
\`\`\`

### 3.4 Document identified subscriptions

For each row returned, record:
- \`event_name\`: the Workflow event that fires the subscription (e.g., \`oracle.apps.ar.invoice.created\`)
- \`java_function\`: the fully qualified Java class and method (e.g., \`Receiver.DfeUtil.PutFile\`)
- \`status_code\`: currently ENABLED — this is what must be changed
- \`subscription_guid\`: the primary key you will use in the UPDATE statement

These are your candidates for disabling in Phase 5.

---

## Phase 4: Enable Tracing to Confirm the Exact Call Stack

If after Phase 3 you are still uncertain which subscription fires during AutoInvoice, enable tracing to capture the exact call path.

### 4.1 Enable FND debug logging for the test user

Connect to EBS as SYSADMIN and enable debug logging for the user who will submit the AutoInvoice test run:

\`\`\`sql
-- Enable FND logging at statement level for a specific user
-- Replace 'JSMITH' with the EBS username submitting the test run
BEGIN
  FND_LOG_REPOSITORY.INIT_LOG_FND_LOG_MESSAGES(
    p_module        => 'oracle.apps.ar',
    p_log_level     => 1,  -- 1=Statement, 2=Procedure, 3=Event, 4=Exception, 5=Error
    p_user_name     => 'JSMITH'
  );
END;
/
\`\`\`

### 4.2 Alternative: Enable SQL trace via DBMS_MONITOR

If you have access to the Oracle session running AutoInvoice (check V\$SESSION for the concurrent manager process):

\`\`\`sql
-- Find the database session for the AutoInvoice run
-- Run this immediately after submitting AutoInvoice
SELECT s.sid,
       s.serial#,
       s.username,
       s.program,
       s.module,
       s.action,
       s.status
FROM   v\$session s
WHERE  s.program LIKE '%FNDLIBR%'
   OR  s.module  LIKE '%RAXTRX%'
ORDER BY s.logon_time DESC;

-- Enable SQL trace for that session (replace SID and SERIAL# values)
EXEC DBMS_MONITOR.SESSION_TRACE_ENABLE(
       session_id  => :sid,
       serial_num  => :serial_num,
       waits       => TRUE,
       binds       => FALSE
     );
\`\`\`

### 4.3 Retrieve and analyze the trace file

After the AutoInvoice run fails, the trace file is in the directory returned by:

\`\`\`sql
SELECT value FROM v\$diag_info WHERE name = 'Diag Trace';
\`\`\`

Search the trace file for the Java call and UTL_TCP activity:

\`\`\`bash
grep -A5 'Receiver\\|DfeUtil\\|UTL_TCP\\|java\\|CALL.*fiscal' /path/to/tracefile.trc
\`\`\`

The expected pattern in the trace just before the ORA-03113 is:

\`\`\`
CALL #N:c=...,e=...,p=0,cr=0,cu=0,mis=0,r=0,dep=2,og=1,plh=0,tim=...
  CALL JAVA CLASS "Receiver/DfeUtil" method PutFile
    ... (no RETURN line — process died here)
ORA-03113: end-of-file on communication channel
\`\`\`

The absence of a RETURN or FETCH line after the CALL confirms the Java method never returned — the JVM exited instead.

### 4.4 Check the Java call trace in the database alert log

In the alert log, look for a Java exception dump immediately before the process death entry:

\`\`\`
java.net.ConnectException: Connection refused
  at java.net.PlainSocketImpl.socketConnect(Native Method)
  at java.net.AbstractPlainSocketImpl.doConnect(AbstractPlainSocketImpl.java:350)
  at Receiver.DfeUtil.PutFile(DfeUtil.java:112)
  ...
Process J012 died, see its trace file
\`\`\`

This confirms the Java code attempted a TCP connection (via UTL_TCP or direct socket), the connection was refused or timed out, the exception was unhandled, and the JVM terminated.

---

## Phase 5: Immediate Remediation — Disable Workflow Subscriptions

### 5.1 Option A: Disable specific Workflow subscriptions (recommended for DEV)

This is the safest and fastest remediation. It is a pure data change in the Workflow metadata tables and does not require an application tier bounce or patching. It will be reverted on the next clone (which is actually desirable — it forces you to re-evaluate each time).

\`\`\`sql
-- Step 1: Confirm the subscriptions you are about to disable
SELECT subscription_guid,
       java_function,
       status_code
FROM   wf_event_subscriptions
WHERE  java_function IS NOT NULL
  AND  status_code = 'ENABLED'
  AND (UPPER(java_function) LIKE '%MASTERSAF%'
    OR UPPER(java_function) LIKE '%DFEUTIL%'
    OR UPPER(java_function) LIKE '%RECEIVER%'
    OR UPPER(java_function) LIKE '%FISCAL%'
    OR UPPER(java_function) LIKE '%NFE%');

-- Step 2: Disable after review
UPDATE wf_event_subscriptions
SET    status_code      = 'DISABLED',
       last_update_date = SYSDATE,
       last_updated_by  = -1
WHERE  java_function IS NOT NULL
  AND  status_code = 'ENABLED'
  AND (UPPER(java_function) LIKE '%MASTERSAF%'
    OR UPPER(java_function) LIKE '%DFEUTIL%'
    OR UPPER(java_function) LIKE '%RECEIVER%'
    OR UPPER(java_function) LIKE '%FISCAL%'
    OR UPPER(java_function) LIKE '%NFE%');

COMMIT;

-- Step 3: Verify the disable
SELECT subscription_guid,
       java_function,
       status_code
FROM   wf_event_subscriptions
WHERE  java_function IS NOT NULL
  AND (UPPER(java_function) LIKE '%MASTERSAF%'
    OR UPPER(java_function) LIKE '%DFEUTIL%'
    OR UPPER(java_function) LIKE '%RECEIVER%'
    OR UPPER(java_function) LIKE '%FISCAL%'
    OR UPPER(java_function) LIKE '%NFE%');
\`\`\`

**What this change does:** Oracle Workflow will still fire the Business Event during AutoInvoice processing, but the disabled subscription will be skipped. AutoInvoice completes its normal processing without any fiscal document generation. This is correct for DEV and most QA testing — you want to test the EBS financial logic, not the fiscal integration.

**What this change does NOT do:** It does not affect production (different database). It does not remove the Java classes. It does not break any other programs. It is fully reversible.

### 5.2 Option B: Redirect to sandbox fiscal endpoint (recommended for QA/UAT)

When QA or UAT must test fiscal document generation end-to-end, the correct fix is to redirect the integration to a sandbox/homologation fiscal endpoint, not to disable it.

This requires coordination with the Mastersaf (or equivalent) vendor to obtain:
- Sandbox environment URL and port
- Sandbox authentication certificate or credentials
- Homologation NF-e schema version (may differ from production)

The integration parameters are typically stored in a vendor-specific configuration table. Query to find it:

\`\`\`sql
-- Common patterns for Mastersaf configuration tables
-- Exact table name varies by version — search systematically
SELECT table_name
FROM   dba_tables
WHERE  owner = 'APPS'
  AND (UPPER(table_name) LIKE '%MASTERSAF%'
    OR UPPER(table_name) LIKE '%FISCAL%'
    OR UPPER(table_name) LIKE '%NFE%'
    OR UPPER(table_name) LIKE '%SEFAZ%'
    OR UPPER(table_name) LIKE '%DFE%')
ORDER BY table_name;

-- Describe the configuration table once found
-- Then identify the endpoint/URL column and update it:
-- UPDATE apps.<vendor_config_table>
-- SET    endpoint_url = 'https://homologacao.sefaz.gov.br/...',
--        environment  = 'HOM'
-- WHERE  company_code = :your_company_code;
-- COMMIT;
\`\`\`

### 5.3 Which option for which environment

| Environment | Recommended Option | Rationale |
|---|---|---|
| DEV | Option A — Disable subscription | DEV tests EBS logic only; fiscal output not required |
| QA (functional) | Option A — Disable subscription | Functional QA rarely needs NF-e generation |
| QA (integration) | Option B — Sandbox redirect | Integration QA must validate end-to-end fiscal flow |
| UAT | Option B — Sandbox redirect with UAT homologation credentials | UAT must mirror production behavior against test environment |
| Pre-production | Option B — Confirm with vendor before enabling | Use separate homologation certificate set |

---

## Phase 6: Index and Database Link Validation

While the Workflow subscription is the primary cause of ORA-03113, a post-clone environment may also have unusable indexes on AutoInvoice tables that cause secondary performance issues or data integrity errors once the ORA-03113 is resolved.

### 6.1 Check for invalid or unusable indexes on AutoInvoice tables

\`\`\`sql
SELECT index_name,
       table_name,
       status,
       partitioned,
       index_type
FROM   dba_indexes
WHERE  table_name IN ('RA_CUSTOMER_TRX_ALL',
                      'RA_INTERFACE_LINES_ALL',
                      'RA_CUSTOMER_TRX_LINES_ALL',
                      'RA_INTERFACE_LINES_GT')
  AND  status NOT IN ('VALID','N/A')
ORDER BY table_name, index_name;
\`\`\`

### 6.2 Generate and execute rebuild statements

\`\`\`sql
-- Generate rebuild DDL for all unusable indexes on AutoInvoice tables
SELECT 'ALTER INDEX ' || owner || '.' || index_name || ' REBUILD ONLINE;'
         AS rebuild_sql
FROM   dba_indexes
WHERE  table_name IN ('RA_CUSTOMER_TRX_ALL',
                      'RA_INTERFACE_LINES_ALL',
                      'RA_CUSTOMER_TRX_LINES_ALL')
  AND  status NOT IN ('VALID','N/A')
ORDER BY table_name, index_name;
\`\`\`

Run each generated statement during a low-activity window. The \`ONLINE\` keyword prevents locking but requires the table to have no direct LOB columns that block online operations.

### 6.3 Test all database links

Database links in the cloned environment may still point to production systems. Test each one:

\`\`\`sql
-- List all database links visible from APPS schema
SELECT db_link,
       username,
       host,
       created
FROM   dba_db_links
ORDER BY db_link;
\`\`\`

For each link listed, run:

\`\`\`sql
-- Replace LINK_NAME with each db_link value from the query above
SELECT 1 FROM dual@LINK_NAME;
\`\`\`

Document which links succeed and which fail. Links that fail (ORA-12154, ORA-12541, ORA-01017) in non-production are expected if they point to production-only endpoints. These are not the cause of the ORA-03113 but should be documented and either disabled or redirected.

### 6.4 Check UTL_TCP and UTL_HTTP network ACLs

On Oracle 11g and later, outbound TCP connections from PL/SQL and Java require explicit ACL grants. In production these ACLs grant access to fiscal endpoints. In a cloned non-prod environment, those grants are still present and still allow the Java code to attempt the connection — which is why the error occurs at runtime rather than at compile time.

\`\`\`sql
-- Review all network ACLs (Oracle 11g+ / 12c+ format)
SELECT acl,
       principal,
       privilege,
       is_grant,
       host,
       lower_port,
       upper_port
FROM   dba_network_acl_privileges
ORDER BY host, principal;
\`\`\`

In non-production, consider restricting or revoking ACL grants for production fiscal endpoints:

\`\`\`sql
-- Revoke UTL_TCP/UTL_HTTP access to production fiscal endpoint
-- Replace 'nfe.sefaz.gov.br' with the actual production host
BEGIN
  DBMS_NETWORK_ACL_ADMIN.REMOVE_HOST_ACE(
    host       => 'nfe.sefaz.gov.br',
    lower_port => 443,
    upper_port => 443,
    ace        => xs\$ace_type(
                    privilege_list => xs\$name_list('connect','resolve'),
                    principal_name => 'APPS',
                    principal_type => xs_acl.ptype_db
                  )
  );
  COMMIT;
END;
/
\`\`\`

Revoking the ACL provides defense-in-depth: even if the Workflow subscription is accidentally re-enabled, the UTL_TCP call will fail at the ACL check (ORA-24247) rather than attempting the connection and dying with ORA-03113. ORA-24247 is a catchable PL/SQL exception; ORA-03113 is not.

---

## Phase 7: Verification and Resubmission

### 7.1 Resubmit AutoInvoice for a small test batch

After disabling the Workflow subscription(s), submit AutoInvoice for a small batch of interface lines:

1. Navigate: Receivables → Interfaces → AutoInvoice
2. Select a batch_source with a small number of rows in \`RA_INTERFACE_LINES_ALL\`
3. Submit and monitor via Requests → View Requests

### 7.2 Confirm ORA-03113 is absent from the new run

\`\`\`sql
SELECT fcr.request_id,
       fcr.phase_code,
       fcr.status_code,
       fcr.actual_start_date,
       fcr.actual_completion_date
FROM   fnd_concurrent_requests fcr
JOIN   fnd_concurrent_programs fcp
       ON  fcr.concurrent_program_id    = fcp.concurrent_program_id
       AND fcr.program_application_id   = fcp.application_id
WHERE  fcp.concurrent_program_name IN ('RAXTRX','ARXINV')
ORDER BY fcr.request_id DESC
FETCH FIRST 3 ROWS ONLY;
\`\`\`

A \`status_code\` of \`'C'\` (completed normal) with \`phase_code = 'C'\` confirms success. \`status_code = 'E'\` means completed with errors — open the log to read the error message.

### 7.3 Verify interface line processing status

\`\`\`sql
-- Check interface line disposition for the test request
-- Replace :request_id with the AutoInvoice concurrent request ID
SELECT interface_status,
       COUNT(*)  AS line_count
FROM   ra_interface_lines_all
WHERE  request_id = :request_id
GROUP BY interface_status
ORDER BY line_count DESC;
\`\`\`

Expected results:
- Rows with \`interface_status = 'P'\` (Processed): lines that were successfully imported into \`RA_CUSTOMER_TRX_ALL\`
- Rows with a numeric error code: data validation errors (wrong customer, missing GL date, etc.) — these are normal data errors, not session failures
- No rows remaining: AutoInvoice removed them all from the interface table (standard behavior on success)

### 7.4 Confirm RA_INTERFACE_LINES_GT is empty

\`\`\`sql
-- RA_INTERFACE_LINES_GT is a Global Temporary Table used during processing
-- It should be empty between runs (data is session-scoped)
-- This query verifies no stale data from a crashed session remains
SELECT COUNT(*) AS gt_row_count FROM ra_interface_lines_gt;
\`\`\`

If this returns a non-zero count from a different session, a prior crashed run may have leaked data into a persistent view of the GT table — this indicates a separate cleanup issue.

### 7.5 Final validation: processed vs errored count

\`\`\`sql
-- Comprehensive summary for the test AutoInvoice run
SELECT 'Lines processed to RA_CUSTOMER_TRX_ALL' AS metric,
       COUNT(*)
FROM   ra_customer_trx_all rct
JOIN   ra_interface_lines_all rail
       ON rct.request_id = rail.request_id
WHERE  rct.request_id = :request_id
UNION ALL
SELECT 'Lines still in RA_INTERFACE_LINES_ALL with errors' AS metric,
       COUNT(*)
FROM   ra_interface_lines_all
WHERE  request_id       = :request_id
  AND  interface_status != 'P'
UNION ALL
SELECT 'Total lines submitted in interface' AS metric,
       COUNT(*)
FROM   ra_interface_lines_all
WHERE  request_id = :request_id;
\`\`\`

---

## Phase 8: Post-Incident — Add to Post-Clone Runbook

Every Oracle EBS environment that has a third-party fiscal integration (Mastersaf, Synchro, GRC, or any vendor that uses Java stored procedures + UTL_TCP) must execute the following steps as part of the post-clone procedure. Add these steps to your clone runbook documentation.

### 8.1 Standard post-clone Workflow subscription script

\`\`\`sql
-- ============================================================
-- POST-CLONE SCRIPT: Disable external Java Workflow subscriptions
-- Run as APPS user immediately after clone refresh
-- Environment: DEV, QA, UAT (never on production)
-- ============================================================

-- Step 1: Review — run this first and review with DBA lead
-- Do not proceed without understanding each row returned
SELECT subscription_guid,
       java_function,
       status_code,
       phase,
       (SELECT we.name
        FROM   wf_events we
        WHERE  we.guid = wes.event_filter_guid) AS event_name
FROM   wf_event_subscriptions wes
WHERE  java_function IS NOT NULL
  AND  status_code   = 'ENABLED'
ORDER BY java_function;

-- Step 2: Disable after review — replace <VENDOR_PATTERN> with the
-- vendor-specific string identified in step 1 (e.g., 'Mastersaf', 'DfeUtil')
UPDATE wf_event_subscriptions
SET    status_code      = 'DISABLED',
       last_update_date = SYSDATE,
       last_updated_by  = -1
WHERE  java_function IS NOT NULL
  AND  java_function LIKE '%<VENDOR_PATTERN>%';

COMMIT;

-- Step 3: Verify
SELECT subscription_guid,
       java_function,
       status_code
FROM   wf_event_subscriptions
WHERE  java_function IS NOT NULL
ORDER BY java_function;
\`\`\`

### 8.2 Integration endpoint redirect script (for QA/UAT)

\`\`\`sql
-- POST-CLONE SCRIPT: Redirect fiscal integration to sandbox endpoint
-- Run after consulting with vendor for sandbox connection details
-- Replace all <PLACEHOLDER> values with actual sandbox values

-- Step 1: Find the vendor configuration table
SELECT table_name
FROM   dba_tables
WHERE  owner = 'APPS'
  AND (UPPER(table_name) LIKE '%MASTERSAF%'
    OR UPPER(table_name) LIKE '%FISCAL%'
    OR UPPER(table_name) LIKE '%NFE_CONFIG%')
ORDER BY table_name;

-- Step 2: Review current production endpoint values
-- Adjust column names to match the actual table structure
-- SELECT * FROM apps.<vendor_config_table>;

-- Step 3: Update to sandbox endpoint
-- UPDATE apps.<vendor_config_table>
-- SET    endpoint_url      = '<SANDBOX_URL>',
--        environment_code  = 'HOM',
--        certificate_alias = '<SANDBOX_CERT_ALIAS>',
--        last_update_date  = SYSDATE
-- WHERE  company_code = '<YOUR_COMPANY_CODE>';
-- COMMIT;
\`\`\`

---

## Monitoring and Diagnostic Scripts

### Script 1: Alert Log ORA-03113 Scanner

Save as \`/usr/local/bin/check_ora03113_alert.sh\`. Run after any AutoInvoice failure to quickly find ORA-03113 entries in the last 24 hours.

\`\`\`bash
#!/bin/bash
# check_ora03113_alert.sh
# Scans the Oracle alert log for ORA-03113/ORA-03114 entries
# in the last 24 hours and outputs them with 10 lines of context.
#
# Usage: ./check_ora03113_alert.sh [hours_back]
# Default: 24 hours

HOURS_BACK="\${1:-24}"
ORACLE_BASE="\${ORACLE_BASE:-/u01/app/oracle}"
ORACLE_SID="\${ORACLE_SID:-EBSPRD}"

# Locate alert log — try ADR path first, then legacy bdump
ADR_ALERT="\${ORACLE_BASE}/diag/rdbms/\$(echo \${ORACLE_SID} | tr '[:upper:]' '[:lower:]')/\${ORACLE_SID}/trace/alert_\${ORACLE_SID}.log"
LEGACY_ALERT="\${ORACLE_BASE}/admin/\${ORACLE_SID}/bdump/alert_\${ORACLE_SID}.log"

if [[ -f "\${ADR_ALERT}" ]]; then
  ALERT_LOG="\${ADR_ALERT}"
elif [[ -f "\${LEGACY_ALERT}" ]]; then
  ALERT_LOG="\${LEGACY_ALERT}"
else
  echo "ERROR: Cannot locate alert log for SID \${ORACLE_SID}"
  echo "Tried:"
  echo "  \${ADR_ALERT}"
  echo "  \${LEGACY_ALERT}"
  exit 1
fi

echo "=== ORA-03113/ORA-03114 Scanner ==="
echo "Alert log : \${ALERT_LOG}"
echo "Looking back : \${HOURS_BACK} hours"
echo "Scan time  : \$(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# Calculate the cutoff timestamp (GNU date)
CUTOFF=\$(date -d "\${HOURS_BACK} hours ago" '+%Y-%m-%d %H:%M:%S' 2>/dev/null) || \
  CUTOFF=\$(date -v-\${HOURS_BACK}H '+%Y-%m-%d %H:%M:%S' 2>/dev/null)  # macOS fallback

echo "Searching for ORA-03113 and ORA-03114 entries..."
echo "---"

# Use grep with context lines — adjust -B (before) and -A (after) as needed
grep -n -B2 -A10 'ORA-03113\|ORA-03114\|Process.*died\|java.net.Connect' "\${ALERT_LOG}" | \
  tail -500

MATCH_COUNT=\$(grep -c 'ORA-03113\|ORA-03114' "\${ALERT_LOG}" 2>/dev/null || echo 0)
echo ""
echo "--- Total ORA-03113/ORA-03114 occurrences in full alert log: \${MATCH_COUNT}"

# Check for Java exception stack in the last 200 lines (most recent)
echo ""
echo "=== Java exception stack in last 200 alert log lines ==="
tail -200 "\${ALERT_LOG}" | grep -A5 'java\.\|ConnectException\|DfeUtil\|Mastersaf\|Receiver' || \
  echo "No Java exception stack found in last 200 lines."
\`\`\`

### Script 2: AutoInvoice Error Log Query

Save and run as \`autoinvoice_error_report.sql\` (connect as APPS):

\`\`\`sql
-- autoinvoice_error_report.sql
-- Reports AutoInvoice concurrent requests in error state in the last 48 hours
-- and retrieves associated FND log messages.
-- Run as APPS user.

SET LINESIZE 200
SET PAGESIZE 50
SET TRIMSPOOL ON
COLUMN request_id     FORMAT 9999999999 HEADING 'Req ID'
COLUMN start_date     FORMAT A19        HEADING 'Started'
COLUMN end_date       FORMAT A19        HEADING 'Completed'
COLUMN status         FORMAT A6         HEADING 'Status'
COLUMN program        FORMAT A12        HEADING 'Program'
COLUMN argument_text  FORMAT A40        HEADING 'Arguments'

PROMPT =====================================================
PROMPT AutoInvoice Error Report - Last 48 Hours
PROMPT =====================================================

SELECT fcr.request_id,
       TO_CHAR(fcr.actual_start_date,      'YYYY-MM-DD HH24:MI:SS') AS start_date,
       TO_CHAR(fcr.actual_completion_date, 'YYYY-MM-DD HH24:MI:SS') AS end_date,
       fcr.status_code                                               AS status,
       fcp.concurrent_program_name                                   AS program,
       SUBSTR(fcr.argument_text, 1, 40)                              AS argument_text
FROM   fnd_concurrent_requests fcr
JOIN   fnd_concurrent_programs fcp
       ON  fcr.concurrent_program_id    = fcp.concurrent_program_id
       AND fcr.program_application_id   = fcp.application_id
WHERE  fcp.concurrent_program_name IN ('RAXTRX','ARXINV','RAXMTR')
  AND  fcr.phase_code               = 'C'
  AND  fcr.status_code              = 'E'
  AND  fcr.actual_start_date        > SYSDATE - 2
ORDER BY fcr.actual_start_date DESC;

PROMPT
PROMPT =====================================================
PROMPT FND Log Messages for Errored AutoInvoice Requests
PROMPT (Last 48 hours, log level ERROR and EXCEPTION only)
PROMPT =====================================================

SET LINESIZE 250
COLUMN log_sequence   FORMAT 9999999    HEADING 'Seq'
COLUMN module         FORMAT A40        HEADING 'Module'
COLUMN message_text   FORMAT A120       HEADING 'Message'
COLUMN log_level_name FORMAT A10        HEADING 'Level'

SELECT flm.log_sequence,
       flm.module,
       DECODE(flm.log_level, 4, 'EXCEPTION', 5, 'ERROR', 6, 'UNEXPECTED',
              TO_CHAR(flm.log_level)) AS log_level_name,
       SUBSTR(flm.message_text, 1, 120) AS message_text
FROM   fnd_log_messages flm
WHERE  flm.module LIKE 'oracle.apps.ar%'
  AND  flm.log_level >= 4
  AND  flm.timestamp > SYSTIMESTAMP - INTERVAL '48' HOUR
  AND  flm.message_text LIKE '%ORA-%'
ORDER BY flm.log_sequence DESC
FETCH FIRST 100 ROWS ONLY;
/
\`\`\`

### Script 3: Post-Clone Environment Health Check

Save and run as \`postclone_health_check.sql\` (connect as SYSDBA for full access):

\`\`\`sql
-- postclone_health_check.sql
-- Post-clone verification report for Oracle EBS environments
-- with third-party fiscal integrations.
-- Checks: invalid objects, disabled WF subscriptions,
--         unusable indexes, and DB link reachability.
-- Run as SYSDBA.

SET LINESIZE 120
SET PAGESIZE 30
SET FEEDBACK OFF
SET TRIMSPOOL ON

PROMPT ============================================================
PROMPT POST-CLONE HEALTH CHECK REPORT
PROMPT Generated: &_date
PROMPT ============================================================

PROMPT
PROMPT --- 1. DATABASE OBJECT STATUS SUMMARY ---
PROMPT

SELECT status,
       COUNT(*) AS object_count
FROM   dba_objects
GROUP BY status
ORDER BY status;

PROMPT
PROMPT --- 2. INVALID JAVA OBJECTS (third-party / fiscal) ---
PROMPT

SELECT owner,
       object_name,
       object_type,
       last_ddl_time
FROM   dba_objects
WHERE  object_type IN ('JAVA CLASS','JAVA SOURCE','JAVA RESOURCE')
  AND  status = 'INVALID'
  AND  owner NOT IN ('SYS','SYSTEM','ORDSYS','MDSYS','XDB',
                     'WMSYS','EXFSYS','CTXSYS','OLAPSYS','SYSMAN')
ORDER BY owner, object_name;

PROMPT
PROMPT --- 3. WORKFLOW BUSINESS EVENT SUBSCRIPTIONS WITH JAVA FUNCTIONS ---
PROMPT

SELECT wes.status_code,
       wes.java_function,
       (SELECT we.name
        FROM   wf_events we
        WHERE  we.guid = wes.event_filter_guid
        FETCH FIRST 1 ROW ONLY) AS event_name
FROM   wf_event_subscriptions wes
WHERE  wes.java_function IS NOT NULL
ORDER BY wes.status_code, wes.java_function;

PROMPT
PROMPT --- 4. UNUSABLE INDEXES ON AUTOINVOICE TABLES ---
PROMPT

SELECT index_name,
       table_name,
       status,
       partitioned
FROM   dba_indexes
WHERE  table_name IN ('RA_CUSTOMER_TRX_ALL',
                      'RA_INTERFACE_LINES_ALL',
                      'RA_CUSTOMER_TRX_LINES_ALL',
                      'RA_INTERFACE_LINES_GT')
  AND  status NOT IN ('VALID','N/A')
ORDER BY table_name, index_name;

PROMPT
PROMPT --- 5. DATABASE LINKS IN THIS ENVIRONMENT ---
PROMPT

SELECT db_link,
       username,
       host,
       created
FROM   dba_db_links
ORDER BY db_link;

PROMPT
PROMPT --- 6. NETWORK ACL GRANTS (outbound TCP/HTTP) ---
PROMPT

SELECT acl,
       principal,
       privilege,
       is_grant,
       host,
       lower_port,
       upper_port
FROM   dba_network_acl_privileges
ORDER BY host, principal;

PROMPT
PROMPT --- 7. AUTOINVOICE INTERFACE LINE BACKLOG ---
PROMPT

SELECT interface_status,
       COUNT(*) AS line_count,
       MIN(creation_date) AS oldest_line,
       MAX(creation_date) AS newest_line
FROM   ra_interface_lines_all
GROUP BY interface_status
ORDER BY line_count DESC;

PROMPT
PROMPT ============================================================
PROMPT END OF HEALTH CHECK REPORT
PROMPT ============================================================
/
\`\`\`

---

## Quick Reference

### ORA-03113 vs ORA-03114: What Each Means

| Error | Oracle Message | When It Appears |
|---|---|---|
| ORA-03113 | End-of-file on communication channel | The database shadow process for your session has died. The server side is gone. Your client receives EOF on the TCP socket. Caused by: JVM crash, server process killed by OS, network RST. |
| ORA-03114 | Not connected to Oracle | Your client attempted an operation but the connection was already lost (often seen on the retry after ORA-03113, or when connecting to a listener that has no available process). |

In the post-clone AutoInvoice scenario, you will see ORA-03113. ORA-03114 may appear if the application layer retries the connection before the listener is ready.

### Key Tables

| Table | Owner | Purpose |
|---|---|---|
| \`WF_EVENT_SUBSCRIPTIONS\` | APPS | Maps Workflow Business Events to handler functions (PL/SQL or Java). This is where you disable the fiscal integration. |
| \`WF_EVENTS\` | APPS | Defines Workflow Business Events. Join to WF_EVENT_SUBSCRIPTIONS on GUID. |
| \`DBA_OBJECTS\` | SYS | All database objects including Java classes. Check STATUS column. |
| \`DBA_NETWORK_ACLS\` | SYS | Network ACL definitions (11g+). Controls which users can make outbound TCP connections. |
| \`DBA_NETWORK_ACL_PRIVILEGES\` | SYS | Grants within network ACLs. Join to DBA_NETWORK_ACLS on ACL column. |
| \`RA_INTERFACE_LINES_ALL\` | APPS | AutoInvoice input table. INTERFACE_STATUS column tracks processing state. |
| \`FND_CONCURRENT_REQUESTS\` | APPS | Concurrent program run history. STATUS_CODE='E' means error. |

### Key Query: All Enabled External Java Workflow Subscribers

\`\`\`sql
SELECT we.name        AS event_name,
       wes.java_function,
       wes.status_code,
       wes.phase
FROM   wf_events             we
JOIN   wf_event_subscriptions wes ON we.guid = wes.event_filter_guid
WHERE  wes.java_function IS NOT NULL
  AND  wes.status_code = 'ENABLED'
ORDER BY we.name;
\`\`\`

### Post-Clone Checklist

1. **Run utlrp.sql** — recompile all invalid objects before any other testing
2. **Query WF_EVENT_SUBSCRIPTIONS** — identify all enabled Java function subscriptions
3. **Disable or redirect** fiscal/NF-e Workflow subscriptions per environment type
4. **Revoke or restrict network ACLs** — prevent outbound TCP to production fiscal endpoints
5. **Test all database links** — document which succeed and which fail in non-prod
6. **Rebuild unusable indexes** on RA_CUSTOMER_TRX_ALL and RA_INTERFACE_LINES_ALL
7. **Submit a small AutoInvoice test batch** — verify no ORA-03113 in the new run
8. **Document the subscription list** — record which subscriptions were disabled and when, so the next DBA knows what was changed

### One-Liners

**Disable all enabled external Java subscriptions (emergency — run after review):**

\`\`\`sql
UPDATE wf_event_subscriptions
SET status_code = 'DISABLED', last_update_date = SYSDATE, last_updated_by = -1
WHERE java_function IS NOT NULL AND status_code = 'ENABLED';
COMMIT;
\`\`\`

**Re-enable a specific subscription (when decommissioning non-prod or resetting before next clone):**

\`\`\`sql
UPDATE wf_event_subscriptions
SET status_code = 'ENABLED', last_update_date = SYSDATE, last_updated_by = -1
WHERE java_function LIKE '%<VENDOR_PATTERN>%'
  AND status_code = 'DISABLED';
COMMIT;
\`\`\`

**Find the exact event fired during AutoInvoice import:**

\`\`\`sql
SELECT we.name, we.display_name, we.status
FROM   wf_events we
WHERE  UPPER(we.name) LIKE '%AR%INVOICE%'
   OR  UPPER(we.name) LIKE '%RECEIVABLE%'
ORDER BY we.name;
\`\`\`

**Check network ACL for a specific host:**

\`\`\`sql
SELECT acl, principal, privilege, is_grant
FROM   dba_network_acl_privileges
WHERE  host LIKE '%sefaz%' OR host LIKE '%fiscal%' OR host LIKE '%mastersaf%';
\`\`\``,
};

async function main() {
  console.log('Inserting post-clone AutoInvoice runbook...');
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
