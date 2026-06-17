import { config } from 'dotenv';
config({ path: '.env.local' });
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Post-Mortem: Identifying the EBS Concurrent Request Behind an Oracle RAC Parallel Slave Instance Crash',
  slug: 'ebs-concurrent-request-rac-parallel-slave-crash-diagnosis',
  excerpt:
    'When an Oracle 10g RAC instance crashes at 2 AM with ORA-00600 [ksxpcre1] in a parallel slave process, this post walks you through the complete forensic chain — from alert log and trace file to EBS FND tables — to identify the exact concurrent request that triggered the failure and prevent it from happening again.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-17'),
  youtubeUrl: null,
  content: `## Introduction

The pager goes off at 2:47 AM. The alert log on the production Oracle 10g RAC primary node shows a cascade of errors — \`ORA-00600 [ksxpcre1]\` fired inside a \`P001\` parallel slave process, followed within seconds by \`ORA-29740\` (evicted by CSS), then the four words no on-call DBA wants to read: "Instance terminated by LMON."

At the time of the crash, the Concurrent Processing framework had hundreds of requests in flight — nightly GL closes, AR aging extracts, AP payment batch runs, custom PL/SQL purge jobs. One of them brought down the instance. Your job is to identify which one, explain to management why it happened, and prevent the next occurrence. This post is the full post-mortem methodology.

---

## Understanding Oracle RAC Parallel Execution in an EBS Context

### How EBS Uses Parallelism

Oracle E-Business Suite submits work to the database through the Concurrent Processing framework. Each concurrent program runs under a \`FNDLIBR\` process on the application tier, which opens a database session and executes SQL on behalf of the program. Many concurrent programs — Oracle Reports–based extracts, GL mass allocation, AR aging, custom PL/SQL using \`DBMS_PARALLEL_EXECUTE\` or explicit \`PARALLEL\` hints — either explicitly request parallel execution or rely on tables that have a default parallel degree set.

In a RAC environment, Oracle's default behavior is to distribute parallel slaves across all available instances. The **Query Coordinator (QC)** session runs on the instance where the FNDLIBR connection landed. Parallel slave processes — named \`P000\` through \`Pnnn\` — may be spawned on any instance in the cluster. A 16-way parallel query running from a FNDLIBR session on instance 1 might have eight slaves on instance 1 and eight on instance 2, all coordinated by the QC on instance 1.

This distribution is controlled by the \`PARALLEL_INSTANCE_GROUP\` parameter. If it is not set, Oracle distributes slaves freely across the cluster.

### What ORA-00600 [ksxpcre1] Means

The error code \`ORA-00600 [ksxpcre1]\` decodes as an internal exception in the **kernel service execution parallel communication** layer (\`ksxpc\` = kernel service execution parallel communication, \`re1\` = a specific subfunction). This layer manages the network communication buffers between the QC and parallel slaves when they are on different instances. In Oracle 10gR2, this error typically surfaces when:

- The private interconnect buffer allocation fails under high parallel load (too many concurrent inter-instance parallel query operations exhausting the available IPC buffer pool)
- There is a race condition in buffer handoff between a dying slave and the QC during error recovery
- A patch-level defect in the \`ksxpc\` module interacts with heavy inter-instance workload

The error is always internal — it means Oracle detected an unexpected state in its own parallel execution machinery, not a user error.

### ORA-07445 in PX Processes

\`ORA-07445\` is Oracle's wrapper for a fatal OS signal received by a database process — usually \`SIGSEGV\` (memory access violation) or \`SIGBUS\` (bus error) in a parallel slave. When a slave receives a fatal signal:

1. The slave process exits abruptly
2. The QC is notified via the IPC channel that the slave has failed
3. If the error is a memory corruption that also affects shared memory segments, other processes on the same instance begin to fail
4. PMON attempts to clean up but cannot recover from shared memory corruption
5. The Lock Manager Daemon (LMD) detects that the instance is behaving abnormally
6. CSS (Cluster Synchronization Services) evicts the instance from the cluster via STONITH (Shoot The Other Node In The Head) — a forced reboot of the failing node's database to protect shared storage
7. The surviving instance(s) perform instance recovery for the evicted node's redo thread

The cascade from a single parallel slave failure to full instance eviction is real but not universal. It happens specifically when the slave failure leaves shared memory in a corrupt state or causes a background process (particularly LMD or LMS) to fault.

---

## Step 1 — Alert Log and Trace File Forensics

### Locating the Alert Log (Oracle 10g)

In Oracle 10g, the alert log lives in the background dump destination:

\`\`\`
\$ORACLE_BASE/admin/\$ORACLE_SID/bdump/alert_\$ORACLE_SID.log
\`\`\`

This is a plain text file. Start by extracting the error sequence leading up to the crash. The pattern you are looking for is:

\`\`\`
ORA-00600: internal error code, arguments: [ksxpcre1], ...
ORA-29740: evicted by member 1, group incarnation 5
ORA-15064: communication failure with ASM instance
Instance terminated by LMON, pid = 12345
\`\`\`

The timestamp on the \`ORA-00600\` line is your **crash timestamp**. Write it down exactly — you will use it as the anchor for every subsequent lookup.

**RAC-specific note**: In a two-node cluster, determine which instance crashed. The parallel slave that faulted may have been on instance 2 even if the QC was on instance 1. The trace file for the slave will be on the node where the slave was running — which may not be the same node as the FNDLIBR session.

### Locating the Parallel Slave Trace File

User and background process trace files in Oracle 10g are in:

- \`\$ORACLE_BASE/admin/\$ORACLE_SID/udump/\` (user processes, including parallel slaves)
- \`\$ORACLE_BASE/admin/\$ORACLE_SID/bdump/\` (background processes)

Parallel slave trace files follow the naming convention:

\`\`\`
<SID>_p0nn_<OS_PID>.trc
\`\`\`

For example: \`PRODDB2_p001_28734.trc\` — the slave named P001, OS process ID 28734, on instance PRODDB2.

Look for trace files created within 10 minutes of the crash timestamp. On Linux:

\`\`\`bash
find \$ORACLE_BASE/admin/\$ORACLE_SID/udump/ -name "*_p0*.trc" -newer /tmp/ref_file
\`\`\`

where \`/tmp/ref_file\` was \`touch\`ed with the crash timestamp as its modification time.

### Parsing the Trace File Header

The first 30 lines of the slave trace file contain everything you need to begin the cross-reference:

\`\`\`
*** SESSION ID:(45.12345) 2026-01-15 02:47:33.421
*** CLIENT ID:() 2026-01-15 02:47:33.421
*** SERVICE NAME:(SYS\$USERS) 2026-01-15 02:47:33.421
*** MODULE NAME:(FND) 2026-01-15 02:47:33.421
*** ACTION NAME:(FNDLIBR) 2026-01-15 02:47:33.421
Parallel coordinator: pid=89, ospid=28734
Current SQL:
SELECT /*+ PARALLEL(T,8) */ ...
\`\`\`

Extract:

- **SESSION ID**: the \`SID.SERIAL#\` pair of the slave session — useful for ASH cross-reference
- **MODULE NAME / ACTION NAME**: EBS sets these when submitting work to the database — \`MODULE\` is typically the program short name, \`ACTION\` in many EBS 11.5.10+ versions is the concurrent request ID as a string
- **Parallel coordinator ospid**: the OS PID of the QC session — this is the \`oracle_process_id\` in \`FND_CONCURRENT_PROCESSES\`
- **Current SQL**: the SQL being executed at the time of the crash — this may be a large SELECT with parallel hints, or a DML statement

Write down the QC OSPID (the coordinator's OS process ID). It is the golden key for the EBS cross-reference in Step 3.

---

## Step 2 — SQL Identification from Trace and AWR

### SQL Hash Value from the Trace File

Deeper in the trace file you will find the \`PARSING IN CURSOR\` section, which includes the SQL hash value and the SQL ID:

\`\`\`
PARSING IN CURSOR #5 len=847 dep=0 uid=44 oct=3 lid=44 tim=... hv=3891234567 ad='...' sqlid='...'
SELECT /*+ PARALLEL(T,8) */ ...
END OF STMT
\`\`\`

The \`hv=\` value is the SQL hash value. Use it to look up the complete SQL text on the surviving instance:

\`\`\`sql
SELECT piece, sql_text
FROM v\$sqltext
WHERE hash_value = 3891234567
ORDER BY piece;
\`\`\`

If the SQL is no longer in the shared pool (the instance restarted), check AWR:

\`\`\`sql
SELECT piece, sql_text
FROM dba_hist_sqltext
WHERE sql_id = '<sqlid_from_trace>'
ORDER BY piece;
\`\`\`

### AWR / ASH Evidence

If AWR and Diagnostic Pack are licensed on this database, Active Session History is your most powerful tool. Query \`DBA_HIST_ACTIVE_SESS_HISTORY\` for the window around the crash. EBS sets \`MODULE\` and \`ACTION\` in the database session when a concurrent request begins — in many EBS 11.5.10+ versions, \`ACTION\` is literally the concurrent request ID as a character string.

\`\`\`sql
SELECT sql_id, module, action, program, COUNT(*) AS samples
FROM dba_hist_active_sess_history
WHERE sample_time BETWEEN TO_DATE('2026-01-15 02:45:00','YYYY-MM-DD HH24:MI:SS')
  AND TO_DATE('2026-01-15 02:48:00','YYYY-MM-DD HH24:MI:SS')
GROUP BY sql_id, module, action, program
ORDER BY samples DESC;
\`\`\`

If \`ACTION\` contains a numeric string in the results, that is almost certainly the concurrent request ID — go directly to Step 3, Approach C.

Also look at the in-memory ASH view immediately after the surviving instance comes back up or on the surviving instance. The buffer may still contain pre-crash samples:

\`\`\`sql
SELECT inst_id, session_id, sql_id, module, action,
       qc_session_id, qc_instance_id,
       TO_CHAR(sample_time,'YYYY-MM-DD HH24:MI:SS') AS sample_time
FROM gv\$active_session_history
WHERE sample_time BETWEEN TO_DATE('2026-01-15 02:40:00','YYYY-MM-DD HH24:MI:SS')
  AND TO_DATE('2026-01-15 02:50:00','YYYY-MM-DD HH24:MI:SS')
  AND qc_instance_id IS NOT NULL
ORDER BY sample_time DESC;
\`\`\`

The \`qc_instance_id IS NOT NULL\` filter restricts results to parallel slave sessions, which is exactly what you want — the coordinator reference gives you the QC's session ID, which maps to the FNDLIBR session.

---

## Step 3 — Cross-Reference with EBS Concurrent Framework

### The EBS Concurrent Processing Tables

| Table | Key Columns | Purpose |
|-------|------------|---------|
| \`FND_CONCURRENT_REQUESTS\` | \`request_id\`, \`actual_start_date\`, \`actual_completion_date\`, \`phase_code\`, \`status_code\`, \`controlling_manager\` | One row per submitted concurrent request |
| \`FND_CONCURRENT_PROCESSES\` | \`concurrent_process_id\`, \`oracle_process_id\`, \`oracle_session_id\`, \`db_instance\` | One row per FNDLIBR worker process — \`oracle_process_id\` is the OS PID |
| \`FND_CONCURRENT_PROGRAMS\` | \`concurrent_program_id\`, \`concurrent_program_name\` | Program metadata (short name) |
| \`FND_CONCURRENT_PROGRAMS_TL\` | \`user_concurrent_program_name\` | Human-readable program name (translatable) |
| \`FND_USER\` | \`user_id\`, \`user_name\` | EBS user who submitted the request |

The join chain is: \`FND_CONCURRENT_REQUESTS.controlling_manager\` → \`FND_CONCURRENT_PROCESSES.concurrent_process_id\` → \`FND_CONCURRENT_PROCESSES.oracle_process_id\` (= QC OS PID from the trace file).

### Approach A — QC SPID Mapping (Most Reliable)

When you have the QC OS PID from the trace file, this query directly identifies the concurrent request:

\`\`\`sql
SELECT fcr.request_id,
       fcp.concurrent_program_name,
       fcpt.user_concurrent_program_name,
       fcr.actual_start_date,
       fcr.actual_completion_date,
       fcr.argument_text,
       fu.user_name AS requested_by
FROM apps.fnd_concurrent_requests fcr
JOIN apps.fnd_concurrent_programs fcp
  ON fcr.concurrent_program_id = fcp.concurrent_program_id
JOIN apps.fnd_concurrent_programs_tl fcpt
  ON fcp.concurrent_program_id = fcpt.concurrent_program_id
JOIN apps.fnd_user fu ON fcr.requested_by = fu.user_id
JOIN apps.fnd_concurrent_processes fproc
  ON fcr.controlling_manager = fproc.concurrent_process_id
WHERE fproc.oracle_process_id = '&QC_SPID'
  AND fcpt.language = 'US';
\`\`\`

Replace \`&QC_SPID\` with the coordinator OS PID extracted from the slave trace file (the \`ospid=\` value in the "Parallel coordinator" line). This is a string comparison — make sure the value is quoted.

### Approach B — Timestamp-Based Active Request List

When the QC SPID is not available or you want to build a complete picture of all concurrently running programs, query by crash window:

\`\`\`sql
SELECT r.request_id,
       p.concurrent_program_name,
       t.user_concurrent_program_name,
       r.actual_start_date,
       r.phase_code,
       r.status_code
FROM apps.fnd_concurrent_requests r
JOIN apps.fnd_concurrent_programs p ON r.concurrent_program_id = p.concurrent_program_id
JOIN apps.fnd_concurrent_programs_tl t ON p.concurrent_program_id = t.concurrent_program_id
WHERE r.actual_start_date <= TO_DATE('&crash_time','YYYY-MM-DD HH24:MI:SS')
  AND (r.actual_completion_date IS NULL
       OR r.actual_completion_date >= TO_DATE('&crash_time','YYYY-MM-DD HH24:MI:SS'))
  AND t.language = 'US'
ORDER BY r.actual_start_date DESC;
\`\`\`

This returns every request that was still running at the exact crash timestamp. The result set may be large — use the \`status_code\` column to filter for requests that ended in error (\`status_code = 'E'\`) or were interrupted (\`status_code = 'X'\`).

### Approach C — MODULE/ACTION Decode from ASH

In EBS 11.5.10 and later, the database client registers the concurrent request ID in the \`ACTION\` column of \`V\$SESSION\` (and therefore in ASH). If ASH captured samples from the QC session before the crash:

\`\`\`sql
SELECT ash.sample_time, ash.session_id, ash.sql_id,
       ash.module, ash.action,
       TO_NUMBER(ash.action) AS probable_request_id
FROM dba_hist_active_sess_history ash
WHERE ash.sample_time BETWEEN TO_DATE('2026-01-15 02:40:00','YYYY-MM-DD HH24:MI:SS')
  AND TO_DATE('2026-01-15 02:48:00','YYYY-MM-DD HH24:MI:SS')
  AND ash.module IS NOT NULL
  AND ash.qc_instance_id IS NOT NULL
ORDER BY ash.sample_time DESC;
\`\`\`

If \`TO_NUMBER(ash.action)\` succeeds and returns a value in the range of valid concurrent request IDs (check \`FND_CONCURRENT_REQUESTS.request_id\` max values in your system), you can join directly:

\`\`\`sql
SELECT fcr.request_id, fcr.phase_code, fcr.status_code,
       fcp.concurrent_program_name, fcpt.user_concurrent_program_name
FROM apps.fnd_concurrent_requests fcr
JOIN apps.fnd_concurrent_programs fcp
  ON fcr.concurrent_program_id = fcp.concurrent_program_id
JOIN apps.fnd_concurrent_programs_tl fcpt
  ON fcp.concurrent_program_id = fcpt.concurrent_program_id
  AND fcpt.language = 'US'
WHERE fcr.request_id IN (
  SELECT DISTINCT TO_NUMBER(action)
  FROM dba_hist_active_sess_history
  WHERE sample_time BETWEEN TO_DATE('2026-01-15 02:40:00','YYYY-MM-DD HH24:MI:SS')
    AND TO_DATE('2026-01-15 02:48:00','YYYY-MM-DD HH24:MI:SS')
    AND REGEXP_LIKE(action, '^[0-9]+\$')
    AND qc_instance_id IS NOT NULL
);
\`\`\`

---

## Step 4 — Concurrent Manager Log Analysis

Once you have a shortlist of suspect request IDs (ideally one or two after combining all three approaches), examine the concurrent manager log files.

### Log File Location

Log files for EBS concurrent requests live on the application tier:

\`\`\`
\$APPLCSF/\$APPLLOG/<request_id>.req
\`\`\`

The exact path is also stored in the EBS tables — check \`FND_CONCURRENT_REQUESTS.logfile_name\` and \`outfile_name\` for the confirmed paths.

You can also view request logs from the EBS SysAdmin responsibility via **Requests → View → Log**.

### What Termination by Database Crash Looks Like

A normally completing concurrent request log ends with a message like:

\`\`\`
CP: [Concurrent:PCP] Request 12345678 completed
Program completed normally at 02:47:10
\`\`\`

A request that was active when the database crashed will look like one of these:

- **Log file ends abruptly mid-output** — no completion message, output stops in the middle of a report page or data extract
- **ORA-03113** appears near the end: "end of file on communication channel" — the database connection was severed while the FNDLIBR was executing SQL
- **ORA-03114** may appear: "not connected to ORACLE" — similar disconnection signature

Query the completion text for your shortlist:

\`\`\`sql
SELECT request_id, phase_code, status_code, completion_text
FROM fnd_concurrent_requests
WHERE request_id IN (<shortlist_ids>);
\`\`\`

A \`completion_text\` containing \`ORA-03113\` or \`ORA-03114\` combined with an interrupted log file and a \`status_code\` of \`E\` or \`X\` at the exact crash timestamp is your confirmation. This is the request that was running the parallel SQL when the slave crashed.

---

## Step 5 — Preventive Fixes

With the root cause identified, there are four complementary fixes to apply. Do not stop at the first one.

### Fix 1: Disable Cross-Instance Parallelism

The highest-impact single change for RAC stability when EBS concurrent programs use parallelism. Restricting parallel slaves to the local node eliminates the \`ksxpcre1\` communication path entirely:

\`\`\`sql
-- Run on each RAC instance as SYSDBA
ALTER SYSTEM SET PARALLEL_INSTANCE_GROUP = 'LOCAL_NODE' SCOPE=BOTH;
ALTER SYSTEM SET INSTANCE_GROUPS = 'LOCAL_NODE' SCOPE=SPFILE;
-- The SPFILE change requires a bounce to take full effect
\`\`\`

The trade-off: parallel queries on a given instance can only use slaves from that instance. You lose the ability to scale a single query across all nodes. For EBS workloads — where each concurrent program is essentially an independent job, and the Concurrent Manager already distributes programs across instances via service assignments — this is almost always the right call. You get horizontal scaling from the Concurrent Manager layer (many programs across many instances) without the inter-instance risk in parallel slave distribution.

### Fix 2: Audit and Reduce Concurrent Program Parallel Degree

Identify which APPS-schema tables have a non-default parallel degree, as these are the tables most likely to cause parallel slave spawning without explicit hints:

\`\`\`sql
SELECT owner, table_name, degree
FROM dba_tables
WHERE owner = 'APPS'
  AND TRIM(degree) NOT IN ('1','0','DEFAULT')
ORDER BY TO_NUMBER(TRIM(degree)) DESC;
\`\`\`

For any table that returns here, evaluate whether the parallel degree is intentional. For most APPS tables in a 10g environment, parallel degree is set during an Oracle-supplied patch or schema upgrade and then never revisited. Reset offenders:

\`\`\`sql
ALTER TABLE apps.<table_name> NOPARALLEL;
\`\`\`

Run this during a maintenance window. Gather fresh statistics after changing the storage attribute.

### Fix 3: Limit Parallelism via EBS Profile Options

EBS has profile options that can limit concurrent program parallelism at the application layer, before the SQL even reaches the database. Check the current site-level setting for the parallel degree profile:

\`\`\`sql
SELECT profile_option_value
FROM fnd_profile_option_values pov
JOIN fnd_profile_options po ON po.profile_option_id = pov.profile_option_id
WHERE po.profile_option_name = 'CONC_REPORT_ACCESS_LEVEL'
  AND pov.level_id = 10001;
\`\`\`

Also check the specific concurrent program's execution options for any parallel degree settings embedded in the program definition itself:

\`\`\`sql
SELECT fcp.concurrent_program_name, fcp.execution_options
FROM fnd_concurrent_programs fcp
WHERE UPPER(fcp.execution_options) LIKE '%PARALLEL%'
   OR UPPER(fcp.execution_options) LIKE '%DEGREE%';
\`\`\`

### Fix 4: Apply Oracle 10g RAC Patches

The \`ORA-00600 [ksxpcre1]\` error has known fixes in Oracle 10gR2 patchsets. Log into My Oracle Support and search for the error code combined with your exact patchset level (10.2.0.x). Filter for "parallel execution" and "RAC". The relevant patches address the interconnect buffer allocation race conditions in the \`ksxpc\` layer. Apply the highest-available cumulative patch for your patchset that includes the fix, following the standard Oracle rolling patch procedure for RAC.

---

## The Investigation Chain

The complete diagnostic path follows this sequence:

1. **Alert log** → crash timestamp + error signature (\`ksxpcre1\`)
2. **Slave trace file** → QC OSPID + SQL hash value + MODULE/ACTION
3. **V\$SQLTEXT / DBA_HIST_SQLTEXT** → full SQL text for context
4. **DBA_HIST_ACTIVE_SESS_HISTORY** → QC session confirmation, ACTION = request ID
5. **FND_CONCURRENT_PROCESSES** → QC OSPID → concurrent_process_id
6. **FND_CONCURRENT_REQUESTS** → request_id, program, submitter, start time
7. **Concurrent manager log file** → ORA-03113 / truncated log confirms root cause request

### The Fix Chain

1. Identify the offending concurrent program
2. Disable cross-instance parallelism (\`PARALLEL_INSTANCE_GROUP = 'LOCAL_NODE'\`)
3. Audit and reset high-DOP tables in the APPS schema
4. Apply the applicable 10gR2 RAC parallel execution patches
5. Re-run the offending program in a test environment with the fixes in place, confirming no cross-instance slave spawning

The companion runbook provides a self-contained shell script that automates phases 1 through 3 of evidence collection, queries the EBS FND tables directly, and produces a ranked suspect list with completion text in under five minutes — exactly what you need when you are on a 2 AM bridge call with management asking for answers.
`,
};

async function main() {
  console.log('Inserting EBS RAC parallel slave crash blog post...');
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
