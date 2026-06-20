import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'EBS Month-End Delays: When the Bottleneck Is Queue Incompatibility, Not Database Performance',
  slug: 'ebs-month-end-concurrent-queue-incompatibility',
  excerpt:
    'A technical case study of a multi-hour month-end close backlog in Oracle EBS — how a production team ruled out database performance as the root cause and traced the real problem to Conflict Resolution Manager incompatibility rules blocking PA and AR concurrent programs from entering the run phase.',
  category: 'ebs-functional' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-19'),
  youtubeUrl: null,
  content: `In an Oracle E-Business Suite environment, a sudden spike in concurrent processing times during month-end close can cause significant business disruption. When critical financial jobs stall, the initial reaction is often to start database performance tracing to look for slow SQL queries or wait events.

As this technical case study demonstrates, what looks like a classic database performance problem can sometimes turn out to be a **queue management and phase concurrency block** — a distinction that fundamentally changes both the diagnosis path and the resolution.

---

## The Symptom: Stalled Month-End Financial Flows

During a critical financial closing window, the operations team flagged severe delays impacting three core interconnected concurrent programs:

- **PRC: Interface Invoices to Receivables** (Project Accounting)
- **Autoinvoice Import Program** (Accounts Receivable)
- **Custom Draft Invoice Process** (Regional Billing Architecture)

These processes, which normally complete within predictable windows, were suddenly backing up for several hours. Initial diagnostics focused on database monitoring: pulling Active Session History (ASH) snapshots, examining Automated Workload Repository (AWR) reports, and searching for long-running SQL statements by \`SQL_ID\`.

---

## The Investigation: Shifting from Database Tracing to Concurrent Manager Queues

When structural database profiling returned empty datasets — no active execution bottlenecks, no block wait events at the database layer — the engineering team shifted focus to the **Concurrent Manager Engine** and historical workload timings.

### Step 1 — Analysing Manager Capacity

A review of the Standard Concurrent Manager configuration showed a well-provisioned environment:

- **Processes (Worker Threads):** A large number of parallel slots (well above the typical single-digit default)
- **Cache Size:** Matching the process count
- **Sleep Time:** Standard interval (30 seconds)

With many processing threads active, the infrastructure had ample bandwidth. Yet critical requests were discovered sitting in a \`PENDING\` phase for hours before ever transitioning to \`RUNNING\`. The issue was not that jobs were running slowly — **they were not being allowed to start at all.**

\`\`\`sql
-- Check current pending and running requests for the affected programs
SELECT fcr.request_id,
       fcr.phase_code,
       fcr.status_code,
       fcr.requested_start_date,
       fcr.actual_start_date,
       fcr.actual_completion_date,
       ROUND((SYSDATE - fcr.requested_start_date) * 24 * 60, 1) AS minutes_waiting,
       fcp.concurrent_program_name,
       fcpt.user_concurrent_program_name
FROM   fnd_concurrent_requests fcr
JOIN   fnd_concurrent_programs fcp
       ON fcp.concurrent_program_id = fcr.concurrent_program_id
      AND fcp.application_id        = fcr.program_application_id
JOIN   fnd_concurrent_programs_tl fcpt
       ON fcpt.concurrent_program_id = fcp.concurrent_program_id
      AND fcpt.language              = 'US'
WHERE  fcr.phase_code IN ('P', 'R')   -- Pending or Running
  AND  fcpt.user_concurrent_program_name IN (
         'PRC: Interface Invoices to Receivables',
         'Autoinvoice Import Program',
         'Custom Draft Invoice Process')
ORDER  BY fcr.requested_start_date;
\`\`\`

A request in \`phase_code = 'P'\` with a non-null \`requested_start_date\` but a null \`actual_start_date\` is the clearest signal that a scheduling rule — not database performance — is holding the job.

### Step 2 — Checking the Conflict Resolution Manager

Oracle EBS uses the **Conflict Resolution Manager (CRM)** to enforce logical scheduling rules and maintain data integrity across core business modules. If two programs manipulate the same underlying transactional tables simultaneously, running them concurrently risks logical data corruption.

By examining the program definitions, the team mapped a web of structural mutual exclusions (incompatibilities) between the critical tasks:

| Concurrent Program | Incompatible With |
|-------------------|------------------|
| PRC: Interface Invoices to Receivables | Itself (serial execution), Autoinvoice Import Program, PRC: Tieback Invoices from Receivables |
| Autoinvoice Import Program | PRC: Interface Invoices to Receivables, PRC: Tieback Invoices from Receivables |
| PRC: Tieback Invoices from Receivables | Itself (serial execution), Autoinvoice Import Program |

These incompatibility definitions are not bugs — they are intentional protections that prevent AR subledger data from being simultaneously written by the PA interface and the AR autoinvoice engine. The problem was not the rules themselves, but which programs were inheriting them.

---

## Isolating the Root Cause: Phase Block Overlap

The root cause was a structural overlap introduced by localized country-specific program variants.

During the automated close, regional program instances — variants of the Autoinvoice Import Program scoped to specific country billing requirements — were introduced into the processing pipeline alongside the global billing jobs. Because these localized programs execute under the same generic \`Autoinvoice Import\` application module definition, they **inherited the full scope of system-wide incompatibility rules** from the parent program.

The cascade:

\`\`\`
Region A Autoinvoice variant submitted
       │
       ├── CRM marks: incompatible with PRC: Interface Invoices to Receivables
       │
Region B Autoinvoice variant submitted (overlapping window)
       │
       ├── CRM marks: incompatible with PRC: Interface Invoices to Receivables
       │
Global billing programs submitted
       │
       └── CRM sees both region variants still running
             → Places global jobs in PENDING/Standby
             → Global jobs wait for ALL regional variants to complete
             → Duration of wait = sum of all regional run times
\`\`\`

While the Standard Manager had many free worker slots, the CRM was doing exactly what it was programmed to do: enforcing the incompatibility queue. It placed global billing and interface jobs into a \`PENDING\` wait state until every regional Autoinvoice variant finished. Because multiple regional variants ran in sequence across different time zones and submission windows, the wait compounded.

---

## Querying the Incompatibility Matrix

To systematically identify which incompatibility definitions are blocking an active close window, query the \`FND\` application object library tables directly. This maps exactly which programs are holding each other out of the run phase:

\`\`\`sql
SELECT
    fcp.concurrent_program_name          AS short_name,
    fcpt.user_concurrent_program_name    AS program_name,
    fci.to_run_application_id            AS incompat_app_id,
    fcip.concurrent_program_name         AS incompat_short_name,
    fcipt.user_concurrent_program_name   AS incompat_program_name,
    DECODE(fci.scope_code,
           'E', 'Exclusive',
           'Set Check')                  AS incompatibility_scope
FROM   fnd_concurrent_programs fcp
JOIN   fnd_concurrent_programs_tl fcpt
       ON fcp.concurrent_program_id = fcpt.concurrent_program_id
      AND fcp.application_id        = fcpt.application_id
JOIN   fnd_concurrent_program_serial fci
       ON fcp.concurrent_program_id = fci.running_concurrent_program_id
      AND fcp.application_id        = fci.running_application_id
JOIN   fnd_concurrent_programs fcip
       ON fci.to_run_concurrent_program_id = fcip.concurrent_program_id
      AND fci.to_run_application_id        = fcip.application_id
JOIN   fnd_concurrent_programs_tl fcipt
       ON fcip.concurrent_program_id = fcipt.concurrent_program_id
      AND fcip.application_id        = fcipt.application_id
WHERE  fcpt.language  = 'US'
  AND  fcipt.language = 'US'
  AND (UPPER(fcpt.user_concurrent_program_name)  LIKE '%AUTOINVOICE%'
       OR UPPER(fcpt.user_concurrent_program_name) LIKE '%PRC: INTERFACE%')
ORDER  BY fcp.concurrent_program_name, fcip.concurrent_program_name;
\`\`\`

Run this query during an active stall and compare the \`incompat_short_name\` list against the currently running requests in \`fnd_concurrent_requests\`. Every match is a program that is legally blocking your pending jobs.

### Extended View: Who Is Blocking Right Now

\`\`\`sql
-- Show which currently running requests are holding pending jobs via CRM incompatibility
SELECT
    r_run.request_id                          AS blocking_request_id,
    r_run.actual_start_date                   AS blocking_started,
    ROUND((SYSDATE - r_run.actual_start_date)*24*60,1) AS blocking_minutes,
    run_prog.user_concurrent_program_name     AS blocking_program,
    r_pend.request_id                         AS pending_request_id,
    r_pend.requested_start_date               AS pending_submitted,
    ROUND((SYSDATE - r_pend.requested_start_date)*24*60,1) AS pending_wait_minutes,
    pend_prog.user_concurrent_program_name    AS pending_program
FROM   fnd_concurrent_requests r_run
JOIN   fnd_concurrent_programs_tl run_prog
       ON run_prog.concurrent_program_id = r_run.concurrent_program_id
      AND run_prog.language              = 'US'
JOIN   fnd_concurrent_program_serial fci
       ON fci.running_concurrent_program_id = r_run.concurrent_program_id
      AND fci.running_application_id        = r_run.program_application_id
JOIN   fnd_concurrent_requests r_pend
       ON r_pend.concurrent_program_id  = fci.to_run_concurrent_program_id
      AND r_pend.program_application_id = fci.to_run_application_id
      AND r_pend.phase_code             = 'P'
      AND r_pend.status_code            = 'I'   -- Standby
JOIN   fnd_concurrent_programs_tl pend_prog
       ON pend_prog.concurrent_program_id = r_pend.concurrent_program_id
      AND pend_prog.language              = 'US'
WHERE  r_run.phase_code  = 'R'
  AND  r_run.status_code = 'R'
ORDER  BY pending_wait_minutes DESC;
\`\`\`

---

## The Monitoring Script

The following shell script wraps the key diagnostic queries into a scheduled check that runs during the close window, logs results, and alerts when pending wait times cross a threshold.

\`\`\`bash
#!/bin/bash
# ============================================================
# ebs_conc_queue_monitor.sh
# Monitors EBS Concurrent Manager queue for month-end stalls
# caused by CRM incompatibility blocks.
# Schedule during close windows via crontab.
# Usage: APPS_PASSWORD=apps ORG_ID=101 ./ebs_conc_queue_monitor.sh
# ============================================================

ORACLE_HOME=\${ORACLE_HOME:-/u01/app/oracle/product/19c/dbhome_1}
ORACLE_SID=\${ORACLE_SID:-EBSPROD}
APPS_USER=apps
APPS_PASS=\${APPS_PASSWORD:-apps}
ALERT_EMAIL=ebs-ops@example.com
LOG_DIR=/var/log/ebs-monitor
PENDING_WARN_MINUTES=30    # Alert if a job waits more than 30 min
PENDING_CRIT_MINUTES=90    # Critical if more than 90 min
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
ALERTS=0
REPORT=""

export ORACLE_HOME ORACLE_SID
export PATH=\${ORACLE_HOME}/bin:\${PATH}
export NLS_DATE_FORMAT="YYYY-MM-DD HH24:MI:SS"

mkdir -p "\${LOG_DIR}"
LOG="\${LOG_DIR}/conc_queue_\$(date +%Y%m%d).log"

log()   { echo "[\${TIMESTAMP}] \$*" | tee -a "\${LOG}"; }
alert() { ALERTS=\$((ALERTS+1)); REPORT="\${REPORT}\\nALERT: \$*"; log "ALERT: \$*"; }
info()  { log "INFO:  \$*"; }

run_sql() {
  sqlplus -s "\${APPS_USER}/\${APPS_PASS}" <<SQLEOF
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMOUT ON TRIMSPOOL ON LINESIZE 300
\$1
EXIT
SQLEOF
}

# -----------------------------------------------
# 1. Count and age of pending financial programs
# -----------------------------------------------
check_pending_queue() {
  info "--- Checking pending queue for PA/AR programs ---"
  RESULTS=\$(run_sql "
SELECT request_id
       || '|' || phase_code
       || '|' || status_code
       || '|' || ROUND((SYSDATE - requested_start_date)*24*60,1)
       || '|' || user_concurrent_program_name
FROM   fnd_concurrent_requests fcr
JOIN   fnd_concurrent_programs_tl fcpt
       ON fcpt.concurrent_program_id = fcr.concurrent_program_id
      AND fcpt.language = 'US'
WHERE  fcr.phase_code IN ('P','R')
  AND  (UPPER(fcpt.user_concurrent_program_name) LIKE '%AUTOINVOICE%'
        OR UPPER(fcpt.user_concurrent_program_name) LIKE '%INTERFACE INVOICES%'
        OR UPPER(fcpt.user_concurrent_program_name) LIKE '%TIEBACK INVOICES%'
        OR UPPER(fcpt.user_concurrent_program_name) LIKE '%DRAFT INVOICE%')
ORDER  BY fcr.requested_start_date;")

  if [ -z "\${RESULTS}" ]; then
    info "No pending or running PA/AR financial programs found"
    return
  fi

  while IFS='|' read -r req_id phase status wait_min prog_name; do
    [ -z "\${req_id}" ] && continue
    info "REQ_ID=\${req_id} PHASE=\${phase} STATUS=\${status} WAIT=\${wait_min}min PROG=\${prog_name}"
    if [ "\${phase}" = "P" ]; then
      WAIT_INT=\${wait_min%.*}
      [ "\${WAIT_INT}" -ge "\${PENDING_CRIT_MINUTES}" ] 2>/dev/null && \
        alert "CRITICAL: \${prog_name} (req \${req_id}) has been PENDING \${wait_min} minutes"
      [ "\${WAIT_INT}" -ge "\${PENDING_WARN_MINUTES}" ] && [ "\${WAIT_INT}" -lt "\${PENDING_CRIT_MINUTES}" ] 2>/dev/null && \
        alert "WARN: \${prog_name} (req \${req_id}) has been PENDING \${wait_min} minutes"
    fi
  done <<< "\${RESULTS}"
}

# -----------------------------------------------
# 2. Identify active incompatibility blocks
# -----------------------------------------------
check_crm_blocks() {
  info "--- Checking CRM incompatibility blocks ---"
  BLOCKS=\$(run_sql "
SELECT r_run.request_id
       || '|' || ROUND((SYSDATE-r_run.actual_start_date)*24*60,1)
       || '|' || run_prog.user_concurrent_program_name
       || '|' || r_pend.request_id
       || '|' || ROUND((SYSDATE-r_pend.requested_start_date)*24*60,1)
       || '|' || pend_prog.user_concurrent_program_name
FROM   fnd_concurrent_requests r_run
JOIN   fnd_concurrent_programs_tl run_prog
       ON run_prog.concurrent_program_id = r_run.concurrent_program_id
      AND run_prog.language = 'US'
JOIN   fnd_concurrent_program_serial fci
       ON fci.running_concurrent_program_id = r_run.concurrent_program_id
      AND fci.running_application_id = r_run.program_application_id
JOIN   fnd_concurrent_requests r_pend
       ON r_pend.concurrent_program_id = fci.to_run_concurrent_program_id
      AND r_pend.program_application_id = fci.to_run_application_id
      AND r_pend.phase_code = 'P'
      AND r_pend.status_code = 'I'
JOIN   fnd_concurrent_programs_tl pend_prog
       ON pend_prog.concurrent_program_id = r_pend.concurrent_program_id
      AND pend_prog.language = 'US'
WHERE  r_run.phase_code = 'R'
  AND  r_run.status_code = 'R'
ORDER  BY 5 DESC
FETCH FIRST 20 ROWS ONLY;")

  if [ -z "\${BLOCKS}" ]; then
    info "No active CRM incompatibility blocks detected"
    return
  fi

  while IFS='|' read -r blk_req blk_min blk_prog pend_req pend_min pend_prog; do
    [ -z "\${blk_req}" ] && continue
    info "BLOCK: req \${blk_req} (\${blk_prog}, running \${blk_min}min) is blocking req \${pend_req} (\${pend_prog}, waiting \${pend_min}min)"
    PEND_INT=\${pend_min%.*}
    [ "\${PEND_INT:-0}" -ge "\${PENDING_WARN_MINUTES}" ] 2>/dev/null && \
      alert "CRM block: \${pend_prog} (req \${pend_req}) blocked \${pend_min}min by \${blk_prog} (req \${blk_req})"
  done <<< "\${BLOCKS}"
}

# -----------------------------------------------
# 3. Standard Manager worker utilisation
# -----------------------------------------------
check_manager_capacity() {
  info "--- Checking Standard Manager capacity ---"
  RESULT=\$(run_sql "
SELECT NVL(running_count,0)
       || '|' || NVL(pending_count,0)
       || '|' || NVL(max_processes,0)
FROM (
  SELECT COUNT(CASE WHEN phase_code='R' THEN 1 END) AS running_count,
         COUNT(CASE WHEN phase_code='P' THEN 1 END) AS pending_count
  FROM   fnd_concurrent_requests
  WHERE  requested_start_date > SYSDATE - 1/24  -- last hour
) req,
(SELECT target_processes AS max_processes
 FROM   fnd_concurrent_queues
 WHERE  concurrent_queue_name = 'STANDARD') mgr;")

  if [ -n "\${RESULT}" ]; then
    RUNNING=\$(echo "\${RESULT}" | cut -d'|' -f1)
    PENDING=\$(echo "\${RESULT}" | cut -d'|' -f2)
    MAX=\$(echo "\${RESULT}" | cut -d'|' -f3)
    info "Manager: running=\${RUNNING} pending=\${PENDING} max_processes=\${MAX}"
    UTIL=0
    [ "\${MAX:-0}" -gt 0 ] && UTIL=\$((RUNNING * 100 / MAX))
    info "Worker utilisation: \${UTIL}%"
    [ "\${UTIL}" -gt 90 ] && alert "Standard Manager at \${UTIL}% capacity — consider adding worker slots"
  fi
}

# -----------------------------------------------
# 4. Summary and alert
# -----------------------------------------------
log "====== EBS Concurrent Queue Monitor Start ======"
check_pending_queue
check_crm_blocks
check_manager_capacity

log "====== Summary: ALERTS=\${ALERTS} ======"
if [ "\${ALERTS}" -gt 0 ]; then
  printf "EBS Month-End Queue Alert\\nHost: \$(hostname)\\nSID: \${ORACLE_SID}\\nTime: \${TIMESTAMP}\\nAlerts: \${ALERTS}\\n%b\\n\\nLog: \${LOG}\\n" \
    "\${REPORT}" | mail -s "EBS Concurrent Queue Alert - \$(hostname)" "\${ALERT_EMAIL}"
  log "Alert email sent to \${ALERT_EMAIL}"
else
  log "All checks passed — no queue blocks detected"
fi
log "====== EBS Concurrent Queue Monitor End ======"
\`\`\`

### Crontab Schedule

Run the monitor every 10 minutes throughout the close window. Tighten to every 5 minutes during the critical overnight batch:

\`\`\`
# EBS month-end concurrent queue monitor
# Install under the oracle OS user: crontab -e

ORACLE_SID=EBSPROD
ORACLE_HOME=/u01/app/oracle/product/19c/dbhome_1
APPS_PASSWORD=apps
ALERT_EMAIL=ebs-ops@example.com
MAILTO=""

# Every 10 minutes during business close window (weekdays, 5 PM to midnight)
*/10 17-23 * * 1-5  /opt/oracle/scripts/ebs_conc_queue_monitor.sh >> /var/log/ebs-monitor/cron.log 2>&1

# Every 5 minutes overnight — tightest monitoring during batch peak
*/5  0-6   * * *    /opt/oracle/scripts/ebs_conc_queue_monitor.sh >> /var/log/ebs-monitor/cron.log 2>&1

# Every 15 minutes during daytime (reduced cadence — fewer batch jobs running)
*/15 7-16  * * 1-5  /opt/oracle/scripts/ebs_conc_queue_monitor.sh >> /var/log/ebs-monitor/cron.log 2>&1

# Log cleanup — keep 60 days, compress after 7
0 2 * * *  find /var/log/ebs-monitor -name "*.log" -mtime +60 -delete
0 2 * * *  find /var/log/ebs-monitor -name "*.log" -mtime +7 ! -name "*.gz" -exec gzip {} \\;
\`\`\`

---

## Lessons for Production DBAs and EBS Architects

### 1. Distinguish Pending from Running

When application teams report that a job is "taking hours," always check the \`PHASE_CODE\` and \`STATUS_CODE\` in \`FND_CONCURRENT_REQUESTS\` before starting database tracing:

| Phase | Status | Meaning | Where to look |
|-------|--------|---------|--------------|
| P | Normal | Eligible, waiting for a free slot | Manager capacity |
| P | Standby | Held by CRM incompatibility | Incompatibility matrix |
| P | Scheduled | Waiting for defined start time | Request schedule |
| R | Normal | Executing | Database performance, AWR, ASH |
| R | Paused | Waiting on a sub-request | Sub-request state |

A job in \`Pending/Standby\` is a CRM problem. A job in \`Running/Normal\` is a database or application problem. They require completely different diagnostic paths.

### 2. Review the Incompatibility Matrix Regularly

Over time, custom programs and localized country modifications are added to the system. If they are cloned from standard templates, they carry the parent program's incompatibility rules. Establish a quarterly audit:

\`\`\`sql
-- Audit all incompatibility definitions in the system
SELECT
    fcpt.user_concurrent_program_name    AS program,
    fcipt.user_concurrent_program_name   AS incompatible_with,
    DECODE(fci.scope_code,'E','Exclusive','Set Check') AS scope,
    fa.application_short_name            AS app
FROM   fnd_concurrent_program_serial fci
JOIN   fnd_concurrent_programs_tl fcpt
       ON fcpt.concurrent_program_id = fci.running_concurrent_program_id
      AND fcpt.language = 'US'
JOIN   fnd_concurrent_programs_tl fcipt
       ON fcipt.concurrent_program_id = fci.to_run_concurrent_program_id
      AND fcipt.language = 'US'
JOIN   fnd_concurrent_programs fcp
       ON fcp.concurrent_program_id = fci.running_concurrent_program_id
JOIN   fnd_application fa
       ON fa.application_id = fcp.application_id
ORDER  BY fa.application_short_name, fcpt.user_concurrent_program_name;
\`\`\`

### 3. Optimise Month-End Batch Scheduling

If programs are genuinely incompatible due to data dependencies, decouple their execution sequences using defined **Request Sets** rather than allowing them to collide inside the manager engine and compete for priority at the CRM level.

The correct model for regional Autoinvoice variants:

\`\`\`
Request Set: MONTH_END_CLOSE_BATCH
  Stage 1 — Regional Variants (parallel, all regions simultaneously)
    │  Region A Autoinvoice
    │  Region B Autoinvoice
    │  Region C Autoinvoice
    └─ [wait for all Stage 1 to complete]
  Stage 2 — Global Interface (runs after Stage 1 is fully clear)
    │  PRC: Interface Invoices to Receivables
    └─ [wait for Stage 2 to complete]
  Stage 3 — AR Processing
       Autoinvoice Import Program (global)
\`\`\`

Explicit stage sequencing eliminates the CRM standby queue entirely — the incompatible programs never run concurrently because the Request Set engine enforces the dependency order before the CRM ever sees the requests.

---

## Summary

Month-end concurrent processing delays in Oracle EBS are frequently diagnosed as database performance problems when the true root cause is a CRM queue incompatibility cascade. The diagnostic path is short once you know what to look for: check \`FND_CONCURRENT_REQUESTS\` phase and status codes first, then query \`FND_CONCURRENT_PROGRAM_SERIAL\` to map the incompatibility chain, then look at which running requests are holding pending ones in standby. The monitoring script and crontab schedule in this post automate that diagnostic path so that queue jams are detected in minutes rather than discovered hours into a stalled close.`,
};

async function main() {
  await db
    .insert(posts)
    .values(post)
    .onConflictDoUpdate({
      target: posts.slug,
      set: { title: post.title, content: post.content, excerpt: post.excerpt, updatedAt: new Date() },
    });
  console.log('Inserted:', post.slug);
}

main().catch(console.error);
