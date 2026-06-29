import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS Concurrent Manager: Architecture, Operations, and Troubleshooting',
  slug: 'oracle-ebs-concurrent-manager',
  excerpt:
    'The Oracle EBS Concurrent Manager is the batch processing backbone of every EBS environment — running payroll, period-end closes, invoicing runs, inventory valuations, and thousands of scheduled reports simultaneously. This post explains the full Concurrent Manager architecture: the Internal Concurrent Manager as the master supervisor, the Standard Manager and specialized managers that process requests, the Output Post Processor that handles report generation, and the Conflict Resolution Manager that enforces incompatibility rules. Covers the complete request lifecycle from submission to completion, the key FND tables that control every aspect of scheduling and execution, the most common failure modes (managers down, requests stuck in Pending/No Manager, OPP failures, zombie processes), and the diagnostic query pattern that identifies root cause in under five minutes.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-29'),
  youtubeUrl: null,
  content: `## Introduction

The Oracle EBS Concurrent Manager is the engine that keeps an EBS environment running between user interactions. While users work in forms and web pages during business hours, the Concurrent Manager is processing payroll calculations, generating invoices, running period-end GL closes, revaluing inventory, printing picking tickets, running MRP plans, and archiving completed transactions — all in the background, simultaneously, with configurable concurrency limits and scheduling rules.

For most users, the Concurrent Manager is invisible. Requests are submitted from a form or a scheduled job fires automatically, and the output appears in the notification history. For Apps DBAs, however, the Concurrent Manager is one of the most operationally demanding components of the EBS stack. When it fails — whether because a manager process crashes, the database connection drops, an incompatibility rule deadlocks the queue, or a specific program generates thousands of stuck processes — the impact is immediate: batch jobs stop, scheduled reports do not generate, and functional teams cannot complete period-end work.

This post explains the Concurrent Manager architecture from the ground up, the lifecycle of a concurrent request from submission to completion, the key database tables that control every aspect of the system, and the most common failure modes with their diagnostic signatures and remediation paths.

---

## Architecture Overview

The Oracle EBS Concurrent Manager is not a single process — it is a collection of cooperating OS-level processes, each with a specific role, all ultimately supervised by one master process.

\`\`\`
EBS Application Tier (OS Processes)
├── ICM (Internal Concurrent Manager) — master supervisor
│     Monitors all other managers. If ICM goes down, all managers go down.
│
├── FNDLIBR (Standard Manager workers) — request execution
│     One FNDLIBR process per concurrent worker slot.
│     Each process picks up a request, runs it, writes output, terminates.
│
├── FNDOPP (Output Post Processor) — post-completion processing
│     Converts request output to PDF, applies templates,
│     delivers to concurrent output directories.
│
├── FNDSM (Service Manager) — manages EBS services
│     Controls Workflow Mailer, XML Publisher, and other service components.
│
└── CRM (Conflict Resolution Manager) — incompatibility enforcement
      Checks incompatibility rules before allowing a request to run.
      Prevents conflicting programs from running simultaneously.
\`\`\`

### Internal Concurrent Manager (ICM)

The ICM is the single supervisory process that:
- Monitors the status of all other managers (Standard, OPP, CRM, custom)
- Restarts a manager if it terminates abnormally
- Reads the manager configuration from \`FND_CONCURRENT_QUEUES\` and applies changes (worker count, schedule, specialization rules) dynamically
- Writes heartbeat records to the database so other processes can detect its health

If the ICM itself goes down, it takes all other managers with it. The ICM is started by the application tier start script (\`adcmctl.sh\`) and writes its PID to the \`$APPLCSF/$APPLLOG\` directory.

### Standard Manager

The Standard Manager is the default manager that processes most concurrent requests. It is configured with a maximum number of simultaneous workers (\`MAX_PROCESSES\`) — each worker is a \`FNDLIBR\` OS process that picks up one request, executes it, and exits. The Standard Manager is the most commonly tuned component: too few workers causes request queuing during peak periods; too many exhausts database connections and OS resources.

### Output Post Processor (OPP)

The OPP handles all post-completion processing of concurrent request output: converting to PDF via Oracle XML Publisher, applying report templates, and writing the final output files to the concurrent output directory. The OPP runs as a separate service from the request executors. If OPP is down, requests that require post-processing complete with a "Warning" status rather than "Normal" — the data processing succeeded, but the formatted output was not generated.

### Conflict Resolution Manager (CRM)

The CRM evaluates incompatibility rules before any request starts. Incompatibility rules prevent specific program pairs from running simultaneously — for example, an inventory period-end close should not run concurrently with a cost rollup. When the CRM detects a conflict, it holds the newer request in Pending/Standby status until the conflicting program completes.

---

## Request Lifecycle: From Submission to Completion

Understanding the full lifecycle helps diagnose at exactly which stage a request is stalling.

\`\`\`
User submits request
        │
        ▼
FND_CONCURRENT_REQUESTS row inserted
  PHASE_CODE = 'P' (Pending)
  STATUS_CODE = 'N' (Normal) or 'S' (Scheduled for future time)
        │
        ▼ ICM wakes up and scans for pending requests
        │
CRM checks incompatibility rules
  ├── Conflict found → STATUS_CODE = 'B' (Standby, waiting for conflict to clear)
  └── No conflict   → request eligible for pickup
        │
        ▼ Standard Manager worker picks up the request
FND_CONCURRENT_PROCESSES row updated
  PHASE_CODE = 'R' (Running)
  STATUS_CODE = 'R' (Running)
  ACTUAL_START_DATE populated
        │
        ▼ FNDLIBR process executes the program
        │
Program completes
  PHASE_CODE = 'C' (Completed)
  STATUS_CODE = 'N' (Normal/Success) | 'E' (Error) | 'G' (Warning) | 'X' (Terminated)
  ACTUAL_COMPLETION_DATE populated
        │
        ▼ OPP picks up completed request (if output post-processing required)
        │
Output files written to $APPLCSF/$APPLOUT
\`\`\`

### Phase and Status Code Reference

\`FND_CONCURRENT_REQUESTS\` tracks every request through two fields — \`PHASE_CODE\` (the major stage) and \`STATUS_CODE\` (the specific state within that stage):

| PHASE_CODE | STATUS_CODE | Meaning |
|---|---|---|
| P | N | Pending, Normal — waiting for a worker |
| P | S | Pending, Scheduled — has a future start time |
| P | B | Pending, Standby — held by incompatibility rule |
| P | M | Pending, No Manager — no manager can run this program |
| P | H | Pending, On Hold — manually placed on hold |
| R | R | Running |
| R | T | Terminating — stop was requested |
| C | N | Completed, Normal (success) |
| C | E | Completed, Error |
| C | G | Completed, Warning |
| C | X | Completed, Terminated |
| C | D | Completed, Cancelled |
| I | U | Inactive, Disabled |

The \`No Manager\` status (\`P/M\`) is particularly important — it means the request's program is not assigned to any active manager's work queue. This is usually caused by a manager being down or by the program's application not being assigned to any running manager.

---

## Key Database Tables

Every aspect of the Concurrent Manager is controlled through a set of \`FND\` tables. Understanding these tables enables both diagnosis and administration.

### FND_CONCURRENT_REQUESTS

The central table. One row per submitted request, tracking its full lifecycle:

\`\`\`sql
SELECT request_id,
       phase_code,
       status_code,
       requested_start_date,
       actual_start_date,
       actual_completion_date,
       completion_text,
       logfile_name,
       outfile_name,
       concurrent_program_id,
       argument_text
FROM fnd_concurrent_requests
WHERE request_id = &target_request_id;
\`\`\`

### FND_CONCURRENT_MANAGERS (alias: FND_CONCURRENT_QUEUES)

Defines every manager: Standard Manager, OPP, CRM, custom managers. Key columns include \`MAX_PROCESSES\` (worker slots), \`RUNNING_PROCESSES\` (current active workers), and \`ENABLED_FLAG\`.

\`\`\`sql
SELECT fcq.concurrent_queue_name,
       fcq.max_processes,
       fcq.running_processes,
       fcq.worker_count,
       fcq.enabled_flag,
       fcq.cache_size
FROM fnd_concurrent_queues fcq
WHERE fcq.application_id = 0
ORDER BY fcq.concurrent_queue_name;
\`\`\`

### FND_CONCURRENT_PROCESSES

One row per live manager process (OS process). Cross-reference with \`V$SESSION\` to confirm the process is genuinely alive:

\`\`\`sql
SELECT fcp.concurrent_process_id,
       fcp.concurrent_queue_id,
       fcp.os_process_id,
       fcp.process_status_code,
       fcp.logfile_name,
       fcp.last_update_date
FROM fnd_concurrent_processes fcp
WHERE fcp.process_status_code = 'A'  -- A=Active
ORDER BY fcp.last_update_date DESC;
\`\`\`

### FND_CONCURRENT_PROGRAMS

Defines the programs that can be submitted as concurrent requests. Each program points to an executable (\`FND_EXECUTABLES\`) and carries configuration like the output format, the printer, and whether output post-processing is required.

---

## Common Failure Modes

### 1. Manager Down — All Requests Stuck in Pending

**Symptom**: All requests remain in \`P/N\` (Pending/Normal) status. The Concurrent Manager status form shows all managers as "Down." No FNDLIBR processes appear when listing OS processes.

**Cause**: ICM terminated abnormally — database connection lost, OS signal, or memory exhaustion. The managed processes detect ICM absence and self-terminate after a timeout.

**Diagnostic**:
\`\`\`bash
# Check for ICM process on the application tier
ps aux | grep -i fndlibr | grep -v grep
ps aux | grep -i fndsm | grep -v grep

# Check ICM log
ls -lt $APPLCSF/$APPLLOG/FNDLIBR*
tail -100 $APPLCSF/$APPLLOG/FNDLIBR.mgr
\`\`\`

\`\`\`sql
-- Check manager process status in the database
SELECT fcp.os_process_id, fcp.process_status_code, fcp.last_update_date,
       fcq.concurrent_queue_name
FROM fnd_concurrent_processes fcp
JOIN fnd_concurrent_queues fcq ON fcp.concurrent_queue_id = fcq.concurrent_queue_id
WHERE fcp.process_status_code IN ('A', 'C')
ORDER BY fcp.last_update_date DESC;
\`\`\`

**Resolution**: Run \`cmclean.sh\` to clear stale process records, then restart via \`adcmctl.sh\` (covered in the runbook).

### 2. Requests in No Manager (P/M) Status

**Symptom**: Specific requests have status \`M\` in the Concurrent Manager status view. Other requests process normally.

**Cause**: The program is not assigned to any active manager's work queue — the program's application is not in the Standard Manager's application specialization list, or the manager that handles this program is deactivated.

**Diagnostic**:
\`\`\`sql
-- Find which managers can run this program
SELECT fcq.concurrent_queue_name,
       fcq.running_processes,
       fcq.max_processes,
       fcq.enabled_flag
FROM fnd_concurrent_queues fcq
JOIN fnd_concurrent_queue_content fcqc
  ON fcq.concurrent_queue_id = fcqc.concurrent_queue_id
 AND fcq.application_id      = fcqc.queue_application_id
WHERE fcqc.type_application_id = (
  SELECT application_id FROM fnd_application
  WHERE application_short_name = '&program_application'
)
ORDER BY fcq.concurrent_queue_name;
\`\`\`

**Resolution**: Enable the appropriate manager or add the application to the Standard Manager's specialization rules via \`Administer Concurrent Managers\` → \`Work Shifts\` → \`Specialization Rules\`.

### 3. OPP Down — Requests Complete with Warning

**Symptom**: Requests that produce reports complete with \`C/G\` (Completed/Warning) instead of \`C/N\`. The completion text reads "One or more post-processing actions failed for this request."

**Cause**: The Output Post Processor service is down. The concurrent request itself ran successfully; the OPP step that converts output to PDF or applies templates failed.

**Diagnostic**:
\`\`\`bash
ps aux | grep -i fndopp | grep -v grep
# No output = OPP is not running
\`\`\`

\`\`\`sql
-- Check OPP request history for errors
SELECT fcr.request_id, fcr.actual_start_date, fcr.completion_text
FROM fnd_concurrent_requests fcr
WHERE fcr.concurrent_program_id = (
  SELECT concurrent_program_id FROM fnd_concurrent_programs
  WHERE concurrent_program_name = 'FNDPPOPP'
)
ORDER BY fcr.actual_start_date DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

**Resolution**: Restart the OPP service from the EBS Applications Manager or via \`adcmctl.sh\`. Pending OPP requests will be reprocessed automatically.

### 4. Stuck Running Requests (Zombie Processes)

**Symptom**: Requests show \`R/R\` (Running) status but the OS process no longer exists. The concurrent worker slot is occupied but doing no work, blocking other requests.

**Cause**: The FNDLIBR process crashed or was killed at the OS level without updating the database. The \`FND_CONCURRENT_REQUESTS\` row remains in Running status indefinitely.

**Diagnostic**:
\`\`\`sql
-- Find requests in Running status for more than 2 hours
SELECT fcr.request_id,
       fcr.actual_start_date,
       ROUND((SYSDATE - fcr.actual_start_date) * 24, 1) AS hours_running,
       fcp.os_process_id,
       fcr.completion_text
FROM fnd_concurrent_requests fcr
JOIN fnd_concurrent_processes fcp
  ON fcr.controlling_manager = fcp.concurrent_process_id
WHERE fcr.phase_code = 'R'
  AND fcr.status_code = 'R'
  AND fcr.actual_start_date < SYSDATE - 2/24
ORDER BY hours_running DESC;
\`\`\`

Cross-reference each \`OS_PROCESS_ID\` against the actual OS process list to confirm the process is genuinely absent.

---

## Request Incompatibilities and the CRM

Incompatibility rules define which programs cannot run simultaneously within the same application. When the CRM finds a conflict, the newer request waits in \`P/B\` (Standby) status.

Incorrectly configured incompatibility rules are a common cause of queue backlogs — a long-running program that is incompatible with a high-frequency program can block dozens of requests for hours.

\`\`\`sql
-- Find all incompatibility rules for a specific program
SELECT fcpi.concurrent_program_id AS program_id,
       fcp1.user_concurrent_program_name AS program_name,
       fcpi.to_run_concurrent_program_id AS incompatible_with_id,
       fcp2.user_concurrent_program_name AS incompatible_with_name,
       fcpi.running_type
FROM fnd_concurrent_program_incompatibilities fcpi
JOIN fnd_concurrent_programs_tl fcp1
  ON fcpi.concurrent_program_id = fcp1.concurrent_program_id
 AND fcp1.language = 'US'
JOIN fnd_concurrent_programs_tl fcp2
  ON fcpi.to_run_concurrent_program_id = fcp2.concurrent_program_id
 AND fcp2.language = 'US'
WHERE fcp1.user_concurrent_program_name LIKE '%&program_name%'
ORDER BY fcp1.user_concurrent_program_name;
\`\`\`

---

## Concurrent Manager Tuning

### Worker Count

The Standard Manager's \`MAX_PROCESSES\` setting controls peak concurrency. Each worker requires one database session (\`V$SESSION\`) and one OS process. Tuning considerations:

- **Too few workers**: requests queue during peak batch processing periods
- **Too many workers**: database session pool exhausted, OS fork overhead, SGA shared pool pressure

A baseline of 10–20 workers for mid-size EBS environments is common, with dedicated managers configured for high-volume programs (payroll, inventory, GL posting).

### Cache Size

The ICM's \`CACHE_SIZE\` parameter controls how many pending requests it retrieves from the database in a single query. Higher cache reduces ICM database round-trips during peak queueing but slightly delays manager awareness of newly submitted requests.

### Dedicated Managers for Heavy Programs

Rather than running all programs through the Standard Manager, high-volume programs benefit from a dedicated manager with its own worker pool and schedule. Common dedicated managers in large EBS environments:

- **Payroll Manager**: 4–8 workers, restricted to Payroll application
- **Inventory Costing Manager**: 2–4 workers, restricted to Inventory and Cost Management
- **GL Posting Manager**: 2–4 workers, restricted to General Ledger

---

## Monitoring the Concurrent Manager

A healthy EBS environment requires continuous awareness of:
1. Manager process status (all managers up and running expected worker count)
2. Request queue depth (backlog of Pending/Normal requests)
3. Long-running requests (Running for longer than the program's expected duration)
4. Error rate (percentage of completed requests ending in Error or Warning)

\`\`\`sql
-- Dashboard query: current queue health
SELECT
  SUM(CASE WHEN phase_code='P' AND status_code='N' THEN 1 ELSE 0 END) AS pending_normal,
  SUM(CASE WHEN phase_code='P' AND status_code='B' THEN 1 ELSE 0 END) AS pending_standby,
  SUM(CASE WHEN phase_code='P' AND status_code='M' THEN 1 ELSE 0 END) AS pending_no_manager,
  SUM(CASE WHEN phase_code='R'                     THEN 1 ELSE 0 END) AS running,
  SUM(CASE WHEN phase_code='C' AND status_code='E'
            AND actual_completion_date >= SYSDATE - 1/24 THEN 1 ELSE 0 END) AS errors_last_hour,
  SUM(CASE WHEN phase_code='C' AND status_code='G'
            AND actual_completion_date >= SYSDATE - 1/24 THEN 1 ELSE 0 END) AS warnings_last_hour
FROM fnd_concurrent_requests;
\`\`\`

---

## Summary

The Oracle EBS Concurrent Manager is a multi-process batch execution framework built around five core components: the Internal Concurrent Manager (the master supervisor), the Standard Manager (the general-purpose request executor), the Output Post Processor (the report formatter), the Conflict Resolution Manager (the incompatibility enforcer), and the Service Manager (the service lifecycle controller). Every batch job, scheduled report, period-end process, and background calculation in EBS passes through this framework.

The request lifecycle — submission → CRM check → worker pickup → execution → OPP post-processing — is tracked through \`FND_CONCURRENT_REQUESTS\` using a two-field phase/status code system that precisely identifies where in the lifecycle any request is stalled. The most critical failure modes are ICM down (all requests stop, requires process cleanup and restart), requests in No Manager status (program not assigned to any active manager's work queue), OPP down (requests complete but produce no formatted output), and zombie running requests (database records show Running but OS processes are gone).

Proactive operation requires weekly review of manager worker counts against queue depth, monitoring of stuck-running request counts with automatic alerting, and a dashboard query covering pending, running, and recent error counts across all request states. The companion runbook covers the complete operational sequence: starting and stopping the Concurrent Manager, the \`cmclean.sh\` stale process cleanup procedure, diagnosing and clearing stuck requests, OPP recovery, incompatibility rule investigation, and monitoring scripts for the DBA team.`,
};

async function main() {
  console.log('Inserting Concurrent Manager blog post...');
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
