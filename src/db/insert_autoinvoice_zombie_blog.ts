import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Troubleshooting Oracle EBS AutoInvoice: When Month-End Concurrent Requests Go Ghostly Idle',
  slug: 'oracle-ebs-autoinvoice-zombie-request',
  excerpt:
    'A zombie AutoInvoice Import (RAXTRX) request that shows Running in the Concurrent Manager for 24+ hours is rarely processing data — it is usually a hung client-side process with a completely idle database session. This post explains how LAST_CALL_ET in V$SESSION exposes the difference between a long-running request and a ghost, how to map a concurrent request to its database session and OS process, what session wait events reveal about whether the process is working or waiting, the safe termination sequence (front-end cancel → ALTER SYSTEM KILL SESSION → OS kill), the RA_INTERFACE_LINES_ALL cleanup required before resubmission, and a monitoring pattern that catches AutoInvoice zombies automatically before they stall the entire month-end concurrent queue.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-30'),
  youtubeUrl: null,
  content: `## Introduction

Month-end processing in Oracle EBS is stressful enough without the AutoInvoice Import program (RAXTRX) quietly grinding to a halt while the Concurrent Manager reports it is still running. When a high-volume billing run shows 24 or 48 hours of runtime on a job that normally completes in two, the first instinct is to assume the data volume is unusually large. Sometimes that is correct. More often, a database-level investigation reveals something more unsettling: the session is not processing data at all. It finished its last database call hours ago and has been sitting idle ever since, occupying a worker slot, blocking the concurrent queue, and preventing every subsequent AutoInvoice batch from starting.

This is the zombie concurrent request pattern — a running process that is not running. Unlike a genuinely slow request that is grinding through millions of rows of billing data, a zombie produces no I/O, no CPU, and no change to the data. The Concurrent Manager has no way to distinguish between them without looking at the database session directly. From EBS's perspective, the request is Running. From the database's perspective, the session has been idle for twelve hours.

This post explains the LAST_CALL_ET diagnostic that instantly distinguishes real processing from idle waiting, the complete session mapping from concurrent request ID to database session to OS process, what wait events confirm the ghost diagnosis, and the safe termination and cleanup sequence that clears the zombie and prepares the AutoInvoice interface tables for a clean resubmission.

---

## Understanding LAST_CALL_ET

\`V$SESSION\` is Oracle's view of every currently connected database session. Among its columns, two are essential for zombie diagnosis:

**STATUS**: The session's current state. An \`ACTIVE\` session is currently executing a SQL statement. An \`INACTIVE\` session is connected but not executing — it is between SQL calls, waiting for the client application to send the next instruction.

**LAST_CALL_ET**: Elapsed time in seconds since the session's last database call. For an ACTIVE session, this resets to near-zero with every SQL execution. For an INACTIVE session, it counts up continuously — representing how long the session has been waiting for the application layer to issue another call.

A LAST_CALL_ET of 43,200 on an INACTIVE session means the database has been sitting idle for exactly twelve hours, waiting for the RAXTRX executable or the Concurrent Manager to send the next SQL command. The executable is either hung, crashed, or disconnected. The database session remains open because the TCP connection is still alive — but no work is happening or will ever happen through it again.

The trap is that the Concurrent Manager cannot see this. It knows the session is connected. It knows the request is Running. It has no mechanism to query LAST_CALL_ET on behalf of each of its workers. Without a DBA actively checking, the zombie runs indefinitely.

---

## The Anatomy of a Zombie Concurrent Request

Several conditions produce zombie concurrent requests in high-volume AutoInvoice environments:

**Application executable hang**: The FNDLIBR process running RAXTRX encounters an unhandled OS-level exception — a signal, a memory fault, a library error — and freezes. The database session stays open because the OS process is still alive but stuck in a non-signal-handling code path.

**Network session timeout without TCP reset**: A network device (load balancer, NAT gateway, firewall) silently drops the connection between the application tier and the database after an idle timeout. The FNDLIBR process still holds the socket file descriptor but cannot send or receive. The database session remains open because no RST packet arrived. Neither side knows the connection is dead.

**Client-side deadlock in PL/SQL package state**: RAXTRX calls a PL/SQL package that enters an infinite loop or a spin-wait on a global variable. The package is executing from the application tier's perspective — the OS process shows CPU or spin — but no database calls are made. LAST_CALL_ET climbs while the OS process burns cycles on the client side.

**Memory pressure causing FNDLIBR to swap**: The application tier server is under memory pressure. The FNDLIBR process is swapped out. The operating system never schedules it back to complete its next database call. The database session idles indefinitely.

In all four scenarios, the diagnostic signature is identical: LAST_CALL_ET is very high, STATUS is INACTIVE, and the wait event is \`SQL*Net message from client\` — the database is waiting for the client to say something. The client never will.

---

## Mapping a Concurrent Request to Its Database Session

The link between the EBS Concurrent Manager's request tracking and the Oracle database session is the OS process ID — specifically, \`FND_CONCURRENT_REQUESTS.ORACLE_PROCESS_ID\`, which stores the SPID of the FNDLIBR OS process that is running the request. \`V$PROCESS.SPID\` stores the same value. Joining through \`V$PROCESS.ADDR = V$SESSION.PADDR\` completes the mapping.

\`\`\`sql
SELECT fcr.request_id,
       vs.sid,
       vs.serial#,
       vp.spid           AS os_process_id,
       vs.status,
       vs.last_call_et   AS idle_seconds,
       ROUND(vs.last_call_et / 3600, 2) AS idle_hours,
       vs.event          AS current_wait_event,
       vs.state,
       vs.seconds_in_wait
FROM apps.fnd_concurrent_requests fcr
JOIN v\$process vp ON fcr.oracle_process_id = vp.spid
JOIN v\$session vs ON vp.addr = vs.paddr
WHERE fcr.request_id = &target_request_id;
\`\`\`

**What each column tells you**:

| Column | Zombie signature | Normal long-running signature |
|---|---|---|
| STATUS | INACTIVE | ACTIVE |
| LAST_CALL_ET | > 3,600 (> 1 hour) | < 60 (resets with each SQL) |
| EVENT | SQL*Net message from client | db file sequential read, latch free, etc. |
| STATE | WAITING | WAITING (on real work) |

A zombie shows all three signals simultaneously: INACTIVE status, LAST_CALL_ET measured in hours, and waiting on \`SQL*Net message from client\`. A genuinely slow request shows ACTIVE status, LAST_CALL_ET near zero, and a meaningful wait event related to I/O or locks.

---

## Confirming the Zombie: Additional Session Metrics

Before terminating any session, confirm the zombie diagnosis with two additional checks:

**Check session I/O**: A working request accumulates physical reads and consistent gets. A zombie accumulates nothing after its last call.

\`\`\`sql
SELECT vs.sid,
       vs.status,
       vs.last_call_et,
       vsio.block_gets,
       vsio.consistent_gets,
       vsio.physical_reads,
       vsio.block_changes
FROM v\$session vs
JOIN v\$sess_io vsio ON vs.sid = vsio.sid
WHERE vs.sid = &zombie_sid;
\`\`\`

Run this query twice, 60 seconds apart. A genuine long-running request shows increasing \`physical_reads\` and \`consistent_gets\` between samples. A zombie shows identical values — no I/O occurred during the interval.

**Check locks held**: A zombie may hold transaction locks (TM or TX) that are blocking other sessions waiting to insert or update the AutoInvoice interface tables.

\`\`\`sql
SELECT l.sid,
       l.type,
       l.lmode,
       l.request,
       l.block,
       o.object_name,
       o.object_type
FROM v\$lock l
JOIN dba_objects o ON l.id1 = o.object_id
WHERE l.sid = &zombie_sid
  AND l.type IN ('TM', 'TX')
ORDER BY l.block DESC;
\`\`\`

If \`BLOCK = 1\`, the zombie is actively blocking other sessions — immediate termination is warranted to unblock the queue.

---

## Example 1: AutoInvoice Zombie During Period-End Billing Run

**Scenario**: At 03:00 on the last day of the period, the AutoInvoice Import concurrent program is submitted to process 450,000 billing lines for a major business unit. By 06:00, it has not completed. By 09:00, the functional team raises an alert. By 11:00, when the DBA investigates, the request has been "Running" for eight hours.

**Diagnosis**:

\`\`\`sql
-- Run the session mapping query for the stuck request
-- Returns: SID=147, SERIAL#=4821, SPID=24311,
--          STATUS=INACTIVE, LAST_CALL_ET=27843 (7.7 hours), EVENT=SQL*Net message from client
\`\`\`

I/O check: \`physical_reads\` and \`consistent_gets\` are identical across two samples 60 seconds apart. The session has processed no data for nearly eight hours.

**Outcome**: The FNDLIBR process (SPID 24311) on the application tier is alive at the OS level but consumes no CPU and has made no system calls in hours — consistent with a process stuck in a spin-wait on a library function. The database session connection was never dropped because the OS process held the socket.

**Resolution**: Front-end cancellation from EBS (step 1), then \`ALTER SYSTEM KILL SESSION '147,4821' IMMEDIATE\` (step 2), then \`kill -9 24311\` on the application tier (step 3). Interface table cleanup follows before resubmission.

---

## Example 2: Network-Killed AutoInvoice Session That EBS Still Reports as Running

**Scenario**: The AutoInvoice Import runs normally across a scheduled maintenance window. During the window, the network team performs a firewall rule update that resets idle connections longer than 30 minutes. The RAXTRX session had been idle for 35 minutes (between two large batches) when the firewall dropped it. The FNDLIBR process never detected the disconnection — the OS socket showed no error because the RST packet was blocked by the updated rule. The session continues to appear Running in EBS.

**Diagnosis**: LAST_CALL_ET = 9,840 (2.7 hours). STATUS = INACTIVE. EVENT = SQL*Net message from client. I/O metrics: zero change over two samples.

The OS process \`ps aux\` shows FNDLIBR still alive with normal memory usage — it is not crashed, it is blocked waiting for a response on a dead socket.

**Resolution**: Same three-step termination sequence. The \`RA_INTERFACE_LINES_ALL\` records with the failed \`REQUEST_ID\` are reset to NULL and the job resubmits successfully. Post-fix: the network team adds the concurrent manager's application server IPs to the firewall's TCP keepalive exemption list.

---

## AutoInvoice Interface Tables: Pre-Resubmission Cleanup

Before resubmitting AutoInvoice after a zombie termination, the interface tables must be in a clean state. \`RA_INTERFACE_LINES_ALL\` stores the billing lines waiting to be processed. When AutoInvoice starts, it stamps each line it is processing with the concurrent request ID in the \`REQUEST_ID\` column. When the zombie left without completing, some lines may still carry the failed request ID — which prevents them from being picked up by the next run.

\`\`\`sql
-- Check how many lines are locked under the failed request ID
SELECT COUNT(*) AS locked_lines
FROM ra_interface_lines_all
WHERE request_id = &failed_request_id;

-- Also check for partial errors from the failed run
SELECT COUNT(*) AS interface_errors
FROM ra_interface_errors_all
WHERE request_id = &failed_request_id;
\`\`\`

If lines are locked, reset them to NULL to make them available to the next submission:

\`\`\`sql
UPDATE ra_interface_lines_all
SET request_id        = NULL,
    interface_status  = NULL
WHERE request_id = &failed_request_id;
COMMIT;

-- Also clear any partial error records from the failed run
DELETE FROM ra_interface_errors_all
WHERE request_id = &failed_request_id;
COMMIT;
\`\`\`

Similarly clear the distributions table if applicable:

\`\`\`sql
UPDATE ra_interface_distributions_all
SET request_id = NULL
WHERE request_id = &failed_request_id;
COMMIT;
\`\`\`

---

## Prevention: Proactive Zombie Detection

The most effective defense is an automated check that runs every 30 minutes during month-end and alerts the DBA team whenever any concurrent request transitions into the zombie pattern — INACTIVE session with LAST_CALL_ET exceeding a threshold.

\`\`\`sql
-- Zombie detection query: running concurrent requests with idle sessions
SELECT fcr.request_id,
       fcpt.user_concurrent_program_name AS program_name,
       ROUND((SYSDATE - fcr.actual_start_date) * 60, 1) AS total_minutes_running,
       vs.last_call_et AS idle_seconds,
       ROUND(vs.last_call_et / 3600, 2) AS idle_hours,
       vs.event,
       vp.spid AS os_pid
FROM fnd_concurrent_requests fcr
JOIN fnd_concurrent_programs_tl fcpt
  ON fcr.concurrent_program_id = fcpt.concurrent_program_id
 AND fcpt.language = 'US'
JOIN v\$process vp ON fcr.oracle_process_id = vp.spid
JOIN v\$session vs ON vp.addr = vs.paddr
WHERE fcr.phase_code  = 'R'
  AND fcr.status_code = 'R'
  AND vs.status = 'INACTIVE'
  AND vs.last_call_et > 3600  -- idle > 1 hour
ORDER BY vs.last_call_et DESC;
\`\`\`

Any row returned by this query is a zombie candidate. An idle threshold of 3,600 seconds (one hour) is conservative — legitimate long-running AutoInvoice processes make database calls far more frequently than once per hour. Raising the threshold to 7,200 (two hours) further reduces false positives.

---

## Summary

A zombie AutoInvoice concurrent request is distinguished from a legitimately slow one by a single database metric: \`V$SESSION.LAST_CALL_ET\`. When a Running request's database session shows INACTIVE status, LAST_CALL_ET measured in hours, and the wait event \`SQL*Net message from client\`, the process is not working — it is waiting indefinitely for an application layer that has hung, crashed, or lost its network connection.

The remediation follows a fixed sequence: attempt front-end cancellation from EBS first (clean and logged), then \`ALTER SYSTEM KILL SESSION\` to release the database session immediately, then \`kill -9\` of the OS process ID on the application tier to clean up the FNDLIBR process, then CMCLEAN or a status update to clear the request from the Concurrent Manager's Running state, and finally cleanup of \`RA_INTERFACE_LINES_ALL\` to reset the \`REQUEST_ID\` on any lines stamped by the failed run.

The cleanup step is the one most commonly skipped under month-end pressure — and skipping it guarantees the next AutoInvoice submission picks up zero lines from the failed batch, because every line is still locked under the dead request ID. Clearing \`REQUEST_ID\` and \`INTERFACE_STATUS\` to NULL for the failed request ID is the prerequisite for any successful resubmission.

The companion runbook covers the full diagnostic and remediation sequence with exact SQL, OS commands, and monitoring scripts that alert automatically when any concurrent session enters the zombie pattern during the month-end processing window.`,
};

async function main() {
  console.log('Inserting AutoInvoice zombie blog post...');
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
