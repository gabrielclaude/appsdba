import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'EBS Month-End Concurrent Queue Runbook: Diagnosing and Resolving CRM Incompatibility Stalls',
  slug: 'ebs-month-end-concurrent-queue-runbook',
  excerpt:
    'Step-by-step runbook for diagnosing and resolving Oracle EBS Concurrent Manager queue stalls during month-end close — confirming the root cause is CRM incompatibility (not database performance), mapping the blocking chain, emergency unblocking procedures, Request Set redesign, and a full crontab monitoring installation.',
  category: 'ebs-functional' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-19'),
  youtubeUrl: null,
  content: `## How to Use This Runbook

Follow the phases in order during an active month-end queue stall. Each phase builds on the previous finding. Do not skip to resolution steps without completing the diagnostic phases — the resolution differs depending on whether the stall is caused by CRM incompatibility, manager capacity, or database performance.

---

## Phase 1 — First Response: Confirm the Problem Is Queue-Side

### 1.1 Check the Phase and Status of Stalled Jobs

\`\`\`sql
-- Run as APPS user
SELECT fcr.request_id,
       fcr.phase_code,
       fcr.status_code,
       DECODE(fcr.phase_code,
              'P', DECODE(fcr.status_code,
                          'I', 'Pending/Standby — CRM hold',
                          'N', 'Pending/Normal — waiting for slot',
                          'S', 'Pending/Scheduled — timed delay',
                          'Pending/' || fcr.status_code),
              'R', DECODE(fcr.status_code,
                          'R', 'Running/Normal',
                          'P', 'Running/Paused',
                          'Running/' || fcr.status_code),
              fcr.phase_code || '/' || fcr.status_code) AS phase_status_desc,
       ROUND((SYSDATE - fcr.requested_start_date)*24*60,1) AS minutes_waiting,
       fcr.actual_start_date,
       fcpt.user_concurrent_program_name,
       fcr.argument_text
FROM   fnd_concurrent_requests fcr
JOIN   fnd_concurrent_programs_tl fcpt
       ON fcpt.concurrent_program_id = fcr.concurrent_program_id
      AND fcpt.language = 'US'
WHERE  fcr.phase_code IN ('P','R')
  AND  fcr.last_update_date > SYSDATE - 12/24
ORDER  BY fcr.requested_start_date;
\`\`\`

**Decision tree from output:**

| Observed state | Next step |
|---------------|-----------|
| \`Pending/Standby\` on financial jobs | Go to Phase 2 — CRM block analysis |
| \`Pending/Normal\` on many jobs | Go to Phase 4 — Manager capacity |
| \`Running/Normal\` but taking hours | Go to Phase 5 — Database performance |
| Mix of Standby and Normal | CRM block AND capacity — work both |

### 1.2 Quick Count by Phase

\`\`\`sql
SELECT fcr.phase_code,
       fcr.status_code,
       COUNT(*) AS request_count,
       ROUND(AVG((SYSDATE - fcr.requested_start_date)*24*60),1) AS avg_wait_minutes,
       ROUND(MAX((SYSDATE - fcr.requested_start_date)*24*60),1) AS max_wait_minutes
FROM   fnd_concurrent_requests fcr
WHERE  fcr.last_update_date > SYSDATE - 12/24
GROUP  BY fcr.phase_code, fcr.status_code
ORDER  BY fcr.phase_code, fcr.status_code;
\`\`\`

A large count in \`P/I\` (Pending/Standby) with long average wait is the definitive signal that the CRM incompatibility engine is the active constraint.

---

## Phase 2 — CRM Block Analysis

### 2.1 Map the Active Blocking Chain

\`\`\`sql
-- Which running requests are holding pending ones via incompatibility rules?
SELECT
    r_run.request_id                          AS blocking_req_id,
    run_prog.user_concurrent_program_name     AS blocking_program,
    r_run.actual_start_date                   AS blocking_started,
    ROUND((SYSDATE-r_run.actual_start_date)*24*60,1) AS blocking_run_minutes,
    r_pend.request_id                         AS held_req_id,
    pend_prog.user_concurrent_program_name    AS held_program,
    ROUND((SYSDATE-r_pend.requested_start_date)*24*60,1) AS held_wait_minutes,
    fci.scope_code                            AS incompat_scope
FROM   fnd_concurrent_requests r_run
JOIN   fnd_concurrent_programs_tl run_prog
       ON run_prog.concurrent_program_id = r_run.concurrent_program_id
      AND run_prog.language = 'US'
JOIN   fnd_concurrent_program_serial fci
       ON fci.running_concurrent_program_id = r_run.concurrent_program_id
      AND fci.running_application_id        = r_run.program_application_id
JOIN   fnd_concurrent_requests r_pend
       ON r_pend.concurrent_program_id  = fci.to_run_concurrent_program_id
      AND r_pend.program_application_id = fci.to_run_application_id
      AND r_pend.phase_code             = 'P'
      AND r_pend.status_code            = 'I'
JOIN   fnd_concurrent_programs_tl pend_prog
       ON pend_prog.concurrent_program_id = r_pend.concurrent_program_id
      AND pend_prog.language = 'US'
WHERE  r_run.phase_code  = 'R'
  AND  r_run.status_code = 'R'
ORDER  BY held_wait_minutes DESC;
\`\`\`

Record the \`blocking_req_id\`, \`blocking_program\`, and \`blocking_run_minutes\` for each row. This is the complete picture of what the CRM is enforcing.

### 2.2 Show the Full Incompatibility Definition for Any Program

\`\`\`sql
-- Replace :program_name with the short name of the program under investigation
SELECT
    fcpt.user_concurrent_program_name     AS this_program,
    fcipt.user_concurrent_program_name    AS is_incompatible_with,
    DECODE(fci.scope_code,'E','Exclusive','Set Check') AS scope,
    fa.application_short_name             AS owning_app
FROM   fnd_concurrent_programs fcp
JOIN   fnd_concurrent_programs_tl fcpt
       ON fcpt.concurrent_program_id = fcp.concurrent_program_id
      AND fcpt.language = 'US'
JOIN   fnd_concurrent_program_serial fci
       ON fci.running_concurrent_program_id = fcp.concurrent_program_id
      AND fci.running_application_id        = fcp.application_id
JOIN   fnd_concurrent_programs fcip
       ON fcip.concurrent_program_id = fci.to_run_concurrent_program_id
      AND fcip.application_id        = fci.to_run_application_id
JOIN   fnd_concurrent_programs_tl fcipt
       ON fcipt.concurrent_program_id = fcip.concurrent_program_id
      AND fcipt.language = 'US'
JOIN   fnd_application fa
       ON fa.application_id = fcp.application_id
WHERE  fcp.concurrent_program_name = :program_name
ORDER  BY fcipt.user_concurrent_program_name;
\`\`\`

### 2.3 Identify Programs That Inherited Incompatibilities from a Parent

\`\`\`sql
-- Find all programs sharing the same incompatibility rules as a reference program
-- Useful for identifying regional variants that inherited parent program rules
SELECT DISTINCT
    fa.application_short_name,
    fcp.concurrent_program_name,
    fcpt.user_concurrent_program_name
FROM   fnd_concurrent_programs fcp
JOIN   fnd_concurrent_programs_tl fcpt
       ON fcpt.concurrent_program_id = fcp.concurrent_program_id
      AND fcpt.language = 'US'
JOIN   fnd_application fa
       ON fa.application_id = fcp.application_id
WHERE  fcp.concurrent_program_id IN (
         SELECT fci.running_concurrent_program_id
         FROM   fnd_concurrent_program_serial fci
         WHERE  fci.to_run_concurrent_program_id = (
                  SELECT concurrent_program_id
                  FROM   fnd_concurrent_programs
                  WHERE  concurrent_program_name = :reference_program_short_name
                  AND    ROWNUM = 1)
       )
ORDER  BY fa.application_short_name, fcp.concurrent_program_name;
\`\`\`

---

## Phase 3 — Emergency Resolution During Active Stall

### 3.1 Option A — Cancel the Blocking Request (Last Resort)

Use only if the blocking program is a regional variant that is not expected to produce data needed by the pending jobs, and business has approved the cancellation.

\`\`\`sql
-- Identify the exact request to cancel
SELECT request_id, phase_code, status_code,
       user_concurrent_program_name,
       actual_start_date,
       argument_text
FROM   fnd_concurrent_requests fcr
JOIN   fnd_concurrent_programs_tl fcpt
       ON fcpt.concurrent_program_id = fcr.concurrent_program_id
      AND fcpt.language = 'US'
WHERE  fcr.request_id = :blocking_req_id;
\`\`\`

\`\`\`bash
# Cancel via FNDCPCAN (Apps-layer concurrent request cancel)
# This is the correct method — do NOT update FND tables directly
ORACLE_SID=EBSPROD
ORACLE_HOME=/u01/app/oracle/product/19c/dbhome_1
export ORACLE_SID ORACLE_HOME PATH=\${ORACLE_HOME}/bin:\${PATH}

sqlplus apps/\${APPS_PASSWORD} <<'EOF'
-- Mark request for cancellation (Apps will pick up via manager poll)
UPDATE fnd_concurrent_requests
SET    status_code   = 'D',     -- D = Cancelled
       last_update_date = SYSDATE
WHERE  request_id    = :blocking_req_id
  AND  phase_code    = 'R'
  AND  status_code   = 'R';
COMMIT;
EOF
\`\`\`

After cancellation, the pending jobs in \`P/I\` (Standby) should automatically transition to \`P/N\` (Normal) and be picked up by the next available manager worker.

### 3.2 Option B — Set a Specific Request to Normal Priority

If the blocking request is expected to finish but the pending request has been waiting unreasonably long, elevate the pending request's priority:

\`\`\`sql
UPDATE fnd_concurrent_requests
SET    priority       = 1,
       last_update_date = SYSDATE
WHERE  request_id    = :pending_req_id
  AND  phase_code    = 'P';
COMMIT;
\`\`\`

Priority is evaluated by the CRM only when multiple eligible requests compete for slots — it does not override incompatibility rules. This is useful when the block clears naturally but you want the formerly pending job to run next.

### 3.3 Option C — Temporarily Disable an Incompatibility Rule (DBA-Owned, With Risk)

Remove an incompatibility definition only if you have confirmed through data analysis that the two programs do not touch the same transactional tables in a conflicting way, and get explicit sign-off from the EBS Functional team before proceeding.

\`\`\`sql
-- View the rule first
SELECT * FROM fnd_concurrent_program_serial
WHERE  running_concurrent_program_id = :prog_id_1
  AND  to_run_concurrent_program_id  = :prog_id_2;

-- Remove the incompatibility (reversible — re-add via EBS form or INSERT)
DELETE FROM fnd_concurrent_program_serial
WHERE  running_concurrent_program_id = :prog_id_1
  AND  to_run_concurrent_program_id  = :prog_id_2;
COMMIT;

-- Re-add after the close window:
-- Navigate to: System Administrator → Concurrent → Programs → Incompatibilities
\`\`\`

---

## Phase 4 — Manager Capacity Analysis

If the stall is \`P/N\` (Normal, not Standby), the CRM is not the bottleneck — the manager has no free slots.

### 4.1 Current Manager Configuration

\`\`\`sql
SELECT fcq.concurrent_queue_name,
       fcqt.user_concurrent_queue_name,
       fcq.target_processes    AS configured_processes,
       fcq.running_processes   AS running_processes,
       fcq.max_processes       AS max_processes,
       fcq.sleep_seconds
FROM   fnd_concurrent_queues fcq
JOIN   fnd_concurrent_queues_tl fcqt
       ON fcqt.concurrent_queue_id   = fcq.concurrent_queue_id
      AND fcqt.application_id        = fcq.application_id
      AND fcqt.language              = 'US'
WHERE  fcq.enabled_flag = 'Y'
ORDER  BY fcq.running_processes DESC;
\`\`\`

### 4.2 Temporarily Increase Standard Manager Capacity

\`\`\`sql
-- Increase target processes for the Standard Manager during close window
-- Replace N with the new target (must be <= max_processes)
UPDATE fnd_concurrent_queues
SET    target_processes    = :new_target,
       last_update_date    = SYSDATE,
       last_updated_by     = -1
WHERE  concurrent_queue_name = 'STANDARD';
COMMIT;

-- Signal the manager to re-read its configuration
-- Navigate to: System Administrator → Concurrent → Manager → Administer
-- Select Standard Manager → Deactivate → Activate
-- Or use: FNDLIBR to bounce the manager
\`\`\`

Restore the original value after the close window to avoid over-using concurrent connections to the database during normal operations.

---

## Phase 5 — Database Performance Confirmation

Use this phase only when \`FND_CONCURRENT_REQUESTS\` shows jobs in \`Running/Normal\` but taking unusually long.

### 5.1 ASH — What Is the Running Job Actually Doing?

\`\`\`sql
-- Find the OS process (spid) for a specific concurrent request
SELECT p.spid           AS os_pid,
       s.sid,
       s.serial#,
       s.sql_id,
       s.event,
       s.wait_class,
       s.seconds_in_wait
FROM   fnd_concurrent_requests fcr
JOIN   fnd_concurrent_processes fcp
       ON fcp.concurrent_request_id = fcr.request_id
JOIN   v\$process p
       ON p.pid = fcp.oracle_process_id
JOIN   v\$session s
       ON s.paddr = p.addr
WHERE  fcr.request_id = :request_id;
\`\`\`

\`\`\`sql
-- ASH for the session running the concurrent request
SELECT ash.event,
       ash.wait_class,
       COUNT(*) AS sample_count,
       ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS pct_time
FROM   v\$active_session_history ash
WHERE  ash.session_id     = :sid
  AND  ash.session_serial# = :serial#
  AND  ash.sample_time    > SYSDATE - 2/24
GROUP  BY ash.event, ash.wait_class
ORDER  BY sample_count DESC;
\`\`\`

If the top event is \`db file sequential read\` or \`db file scattered read\` with a high count, the job is doing physical I/O — check for missing indexes or stale statistics. If the top event is \`enq: TX - row lock contention\`, another session is locking rows the job needs.

---

## Phase 6 — Permanent Fix: Request Set Redesign

The permanent solution to regional variant cascade blocks is to sequence execution explicitly using a **Request Set** rather than relying on CRM serial enforcement.

### 6.1 Create the Request Set

Navigate: **Responsibility → View → Requests → Submit a New Request → Request Set**

Or use the System Administrator responsibility: **Concurrent → Sets**.

\`\`\`
Request Set: MONTH_END_AR_PA_CLOSE
Description: Month-end PA to AR interface sequence
\`\`\`

### 6.2 Define Execution Stages

| Stage | Programs | Run mode | Proceed when |
|-------|---------|---------|-------------|
| 1 — Regional Autoinvoice | All country-specific Autoinvoice variants | Parallel (all run together) | All Stage 1 complete |
| 2 — Global PA Interface | PRC: Interface Invoices to Receivables | Serial | Stage 2 complete |
| 3 — Global AR Import | Autoinvoice Import Program (global) | Serial | Stage 3 complete |
| 4 — Tieback | PRC: Tieback Invoices from Receivables | Serial | Stage 4 complete |

With this structure, the incompatibility rules between Stage 1 and Stages 2/3 are never triggered — Stage 2 does not submit until Stage 1 is fully complete.

### 6.3 Validate the Request Set

\`\`\`sql
-- Verify all programs are in the set and correctly staged
SELECT
    frs.set_application_id,
    frs.request_set_name,
    frss.stage_name,
    frss.sequence                           AS stage_sequence,
    frsp.sequence                           AS program_sequence,
    fcpt.user_concurrent_program_name       AS program_name,
    frsp.argument_input_method_code
FROM   fnd_request_sets frs
JOIN   fnd_request_set_stages frss ON frss.set_application_id = frs.set_application_id
                                  AND frss.request_set_id     = frs.request_set_id
JOIN   fnd_request_set_programs frsp ON frsp.set_application_id  = frss.set_application_id
                                   AND frsp.request_set_id       = frss.request_set_id
                                   AND frsp.request_set_stage_id = frss.request_set_stage_id
JOIN   fnd_concurrent_programs_tl fcpt ON fcpt.concurrent_program_id = frsp.concurrent_program_id
                                      AND fcpt.language = 'US'
WHERE  frs.request_set_name = 'MONTH_END_AR_PA_CLOSE'
ORDER  BY frss.sequence, frsp.sequence;
\`\`\`

---

## Phase 7 — Monitoring Script Installation

### 7.1 Install the Monitoring Script

\`\`\`bash
mkdir -p /opt/oracle/scripts /var/log/ebs-monitor

cat > /opt/oracle/scripts/ebs_conc_queue_monitor.sh << 'INSTALL_EOF'
#!/bin/bash
ORACLE_HOME=\${ORACLE_HOME:-/u01/app/oracle/product/19c/dbhome_1}
ORACLE_SID=\${ORACLE_SID:-EBSPROD}
APPS_USER=apps
APPS_PASS=\${APPS_PASSWORD:-apps}
ALERT_EMAIL=\${ALERT_EMAIL:-ebs-ops@example.com}
PENDING_WARN_MINUTES=\${PENDING_WARN:-30}
PENDING_CRIT_MINUTES=\${PENDING_CRIT:-90}
LOG_DIR=/var/log/ebs-monitor
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
ALERTS=0; REPORT=""

export ORACLE_HOME ORACLE_SID PATH=\${ORACLE_HOME}/bin:\${PATH}
export NLS_DATE_FORMAT="YYYY-MM-DD HH24:MI:SS"
mkdir -p "\${LOG_DIR}"
LOG="\${LOG_DIR}/conc_queue_\$(date +%Y%m%d).log"

log()   { echo "[\${TIMESTAMP}] \$*" | tee -a "\${LOG}"; }
alert() { ALERTS=\$((ALERTS+1)); REPORT="\${REPORT}\\nALERT: \$*"; log "ALERT: \$*"; }

run_sql() { sqlplus -s "\${APPS_USER}/\${APPS_PASS}" <<SQLEOF
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMOUT ON TRIMSPOOL ON LINESIZE 300
\$1
EXIT
SQLEOF
}

# --- Pending queue age check ---
log "--- Pending queue check ---"
run_sql "
SELECT fcr.request_id || '|' || fcr.phase_code || '|' || fcr.status_code
       || '|' || ROUND((SYSDATE-fcr.requested_start_date)*24*60,1)
       || '|' || fcpt.user_concurrent_program_name
FROM   fnd_concurrent_requests fcr
JOIN   fnd_concurrent_programs_tl fcpt
       ON fcpt.concurrent_program_id = fcr.concurrent_program_id
      AND fcpt.language = 'US'
WHERE  fcr.phase_code = 'P'
  AND  fcr.last_update_date > SYSDATE - 1/24
ORDER  BY fcr.requested_start_date;" | while IFS='|' read -r req phase stat wait prog; do
  [ -z "\${req}" ] && continue
  log "PENDING req=\${req} status=\${stat} wait=\${wait}min prog=\${prog}"
  wi=\${wait%.*}
  [ "\${wi:-0}" -ge "\${PENDING_CRIT_MINUTES}" ] 2>/dev/null && \
    alert "CRITICAL pending: \${prog} req=\${req} wait=\${wait}min (threshold=\${PENDING_CRIT_MINUTES})"
  [ "\${wi:-0}" -ge "\${PENDING_WARN_MINUTES}" ] 2>/dev/null && \
    [ "\${wi:-0}" -lt "\${PENDING_CRIT_MINUTES}" ] 2>/dev/null && \
    alert "WARN pending: \${prog} req=\${req} wait=\${wait}min (threshold=\${PENDING_WARN_MINUTES})"
done

# --- CRM block check ---
log "--- CRM block check ---"
run_sql "
SELECT r_run.request_id || '|' || ROUND((SYSDATE-r_run.actual_start_date)*24*60,1)
       || '|' || run_prog.user_concurrent_program_name
       || '|' || r_pend.request_id
       || '|' || ROUND((SYSDATE-r_pend.requested_start_date)*24*60,1)
       || '|' || pend_prog.user_concurrent_program_name
FROM   fnd_concurrent_requests r_run
JOIN   fnd_concurrent_programs_tl run_prog ON run_prog.concurrent_program_id=r_run.concurrent_program_id AND run_prog.language='US'
JOIN   fnd_concurrent_program_serial fci ON fci.running_concurrent_program_id=r_run.concurrent_program_id AND fci.running_application_id=r_run.program_application_id
JOIN   fnd_concurrent_requests r_pend ON r_pend.concurrent_program_id=fci.to_run_concurrent_program_id AND r_pend.program_application_id=fci.to_run_application_id AND r_pend.phase_code='P' AND r_pend.status_code='I'
JOIN   fnd_concurrent_programs_tl pend_prog ON pend_prog.concurrent_program_id=r_pend.concurrent_program_id AND pend_prog.language='US'
WHERE  r_run.phase_code='R' AND r_run.status_code='R'
ORDER  BY 5 DESC FETCH FIRST 20 ROWS ONLY;" | while IFS='|' read -r blk_req blk_min blk_prog pend_req pend_min pend_prog; do
  [ -z "\${blk_req}" ] && continue
  log "CRM BLOCK: req \${blk_req} (\${blk_prog}, \${blk_min}min) blocking req \${pend_req} (\${pend_prog}, waiting \${pend_min}min)"
  wi=\${pend_min%.*}
  [ "\${wi:-0}" -ge "\${PENDING_WARN_MINUTES}" ] 2>/dev/null && \
    alert "CRM block: \${pend_prog} req=\${pend_req} waiting \${pend_min}min blocked by \${blk_prog} req=\${blk_req}"
done

log "====== Alerts: \${ALERTS} ======"
if [ "\${ALERTS}" -gt 0 ]; then
  printf "EBS Queue Alert\\nHost: \$(hostname)\\nSID: \${ORACLE_SID}\\nTime: \${TIMESTAMP}\\n%b\\nLog: \${LOG}\\n" "\${REPORT}" \
    | mail -s "EBS Concurrent Queue Alert - \$(hostname)" "\${ALERT_EMAIL}"
fi
INSTALL_EOF

chmod 750 /opt/oracle/scripts/ebs_conc_queue_monitor.sh
chown oracle:oinstall /opt/oracle/scripts/ebs_conc_queue_monitor.sh
chown -R oracle:oinstall /var/log/ebs-monitor
\`\`\`

### 7.2 Test the Script

\`\`\`bash
# Run manually as oracle user
sudo -u oracle ORACLE_SID=EBSPROD APPS_PASSWORD=apps \
  PENDING_WARN=5 PENDING_CRIT=15 \
  /opt/oracle/scripts/ebs_conc_queue_monitor.sh

# Verify log created
ls -lh /var/log/ebs-monitor/conc_queue_$(date +%Y%m%d).log
tail -20 /var/log/ebs-monitor/conc_queue_$(date +%Y%m%d).log
\`\`\`

### 7.3 Install Crontab

\`\`\`bash
sudo -u oracle crontab -e
\`\`\`

Paste:

\`\`\`
ORACLE_SID=EBSPROD
ORACLE_HOME=/u01/app/oracle/product/19c/dbhome_1
APPS_PASSWORD=apps
ALERT_EMAIL=ebs-ops@example.com
PENDING_WARN=30
PENDING_CRIT=90
MAILTO=""

# Month-end close window: tight monitoring during batch hours
*/10 17-23 * * 1-5   /opt/oracle/scripts/ebs_conc_queue_monitor.sh >> /var/log/ebs-monitor/cron.log 2>&1
*/5  0-6   * * *     /opt/oracle/scripts/ebs_conc_queue_monitor.sh >> /var/log/ebs-monitor/cron.log 2>&1
*/15 7-16  * * 1-5   /opt/oracle/scripts/ebs_conc_queue_monitor.sh >> /var/log/ebs-monitor/cron.log 2>&1

# Log housekeeping
0 2 * * *  find /var/log/ebs-monitor -name "*.log" -mtime +60 -delete
0 2 * * *  find /var/log/ebs-monitor -name "*.log" -mtime +7 ! -name "*.gz" -exec gzip {} \\;
\`\`\`

---

## Phase 8 — Quarterly Incompatibility Audit

Schedule this review before each fiscal quarter close to catch newly added programs that may carry inherited incompatibility rules.

\`\`\`bash
#!/bin/bash
# /opt/oracle/scripts/ebs_incompat_audit.sh
# Exports the full incompatibility matrix to a timestamped report.

ORACLE_SID=\${ORACLE_SID:-EBSPROD}
ORACLE_HOME=\${ORACLE_HOME:-/u01/app/oracle/product/19c/dbhome_1}
APPS_PASS=\${APPS_PASSWORD:-apps}
LOG_DIR=/var/log/ebs-monitor
ALERT_EMAIL=\${ALERT_EMAIL:-ebs-ops@example.com}
REPORT="\${LOG_DIR}/incompat_audit_\$(date +%Y%m%d).txt"

export ORACLE_HOME ORACLE_SID PATH=\${ORACLE_HOME}/bin:\${PATH}

sqlplus -s "apps/\${APPS_PASS}" > "\${REPORT}" <<'EOF'
SET LINESIZE 200 PAGESIZE 200 TRIMSPOOL ON
COLUMN program        FORMAT A45
COLUMN incompatible   FORMAT A45
COLUMN scope          FORMAT A12
COLUMN app            FORMAT A10

PROMPT =============================================
PROMPT  EBS Concurrent Incompatibility Audit
PROMPT  Generated: && _DATE
PROMPT =============================================

SELECT
    fcpt.user_concurrent_program_name  AS program,
    fcipt.user_concurrent_program_name AS incompatible,
    DECODE(fci.scope_code,'E','Exclusive','Set Check') AS scope,
    fa.application_short_name AS app
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

PROMPT
PROMPT =============================================
PROMPT  Programs with self-incompatibility (serial enforcement)
PROMPT =============================================

SELECT
    fcpt.user_concurrent_program_name AS program,
    fa.application_short_name         AS app
FROM   fnd_concurrent_program_serial fci
JOIN   fnd_concurrent_programs_tl fcpt
       ON fcpt.concurrent_program_id = fci.running_concurrent_program_id
      AND fcpt.language = 'US'
JOIN   fnd_concurrent_programs fcp
       ON fcp.concurrent_program_id = fci.running_concurrent_program_id
JOIN   fnd_application fa
       ON fa.application_id = fcp.application_id
WHERE  fci.running_concurrent_program_id = fci.to_run_concurrent_program_id
ORDER  BY fa.application_short_name, fcpt.user_concurrent_program_name;
EOF

mail -s "EBS Incompatibility Audit: \$(hostname) \$(date +%Y-%m-%d)" \
  "\${ALERT_EMAIL}" < "\${REPORT}"

echo "Audit report: \${REPORT}"
\`\`\`

\`\`\`
# Add to crontab — run quarterly before each fiscal close
0 8 1 3,6,9,12 *  ORACLE_SID=EBSPROD APPS_PASSWORD=apps /opt/oracle/scripts/ebs_incompat_audit.sh >> /var/log/ebs-monitor/cron.log 2>&1
\`\`\`

---

## Troubleshooting Quick Reference

| Symptom | Query to run | Expected finding | Action |
|---------|-------------|-----------------|--------|
| Jobs waiting for hours | Check \`FND_CONCURRENT_REQUESTS\` phase/status | P/I = Standby | Phase 2 — CRM analysis |
| Many jobs queued, none running | Count P/N requests | Many P/N = no free slots | Phase 4 — Manager capacity |
| Job running but slow | Get session SID from \`FND_CONCURRENT_PROCESSES\` | High wait event in ASH | Phase 5 — DB performance |
| Unknown program inheriting rules | Query \`FND_CONCURRENT_PROGRAM_SERIAL\` | Rules from parent clone | Remove stale incompatibilities |
| Block clears but job doesn't start | Check manager sleep cycle | Sleep = 30s default | Bounce manager or reduce sleep |
| Cancelled request leaves jobs stuck | Check for orphaned P/I requests | Status still Standby | Manually set priority to 1 |`,
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
