import { config } from 'dotenv';
config({ path: '.env.local' });
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'EBS RAC Parallel Slave Crash Diagnosis Runbook: Forensics, Concurrent Request Identification, and Stabilization',
  slug: 'ebs-concurrent-request-rac-crash-diagnosis-runbook',
  excerpt:
    'A complete operational runbook for diagnosing an Oracle 10g RAC instance crash caused by a parallel slave exception — covering alert log forensics, trace file parsing, ASH evidence collection, EBS FND table cross-referencing via three approaches, and a self-contained shell script that produces a ranked suspect request list in under five minutes.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-17'),
  youtubeUrl: null,
  content: `# EBS RAC Parallel Slave Crash Diagnosis Runbook

## Overview

This runbook covers the complete forensic and stabilization procedure for an Oracle 10g RAC instance crash caused by a parallel slave exception (\`ORA-00600 [ksxpcre1]\` or \`ORA-07445\` in a PX process), where the root cause must be traced back to a specific EBS concurrent request.

**Assumptions:**
- Oracle 10gR2 RAC, two nodes: \`PRODDB1\` (instance 1), \`PRODDB2\` (instance 2)
- EBS 11.5.10 or 12.1.x with Concurrent Processing
- Oracle base: \`/u01/app/oracle\`
- Scripts run as \`oracle\` OS user
- APPS password stored in the environment variable \`APPS_DB_PASS\`
- SYS password stored in the environment variable \`SYS_DB_PASS\`

---

## Phase 1 — Immediate Triage (First 15 Minutes)

The goal of Phase 1 is to extract the crash timestamp, the failing slave process details, and the QC (Query Coordinator) OS PID from the alert log and trace files. All subsequent steps depend on these identifiers.

### 1.1 — Alert Log Evidence

\`\`\`bash
# On the affected RAC node (or the surviving node after crash)
# Locate the alert log
ALERT_LOG=\$ORACLE_BASE/admin/\$ORACLE_SID/bdump/alert_\$ORACLE_SID.log

# Extract errors near the crash window (last 200 lines)
grep -n "ORA-00600\\|ORA-07445\\|Instance terminated\\|NODE EVICTION\\|ksxpcre\\|parallel" \\
  \$ALERT_LOG | tail -50

# Find the exact crash timestamp (the line immediately before eviction)
grep -n "Instance terminated" \$ALERT_LOG | tail -5
\`\`\`

What you are looking for in the alert log output:

\`\`\`
ORA-00600: internal error code, arguments: [ksxpcre1], [0xC0000002], [], [], [], [], [], []
ORA-29740: evicted by member 1, group incarnation 5
Instance terminated by LMON, pid = 12301
\`\`\`

Write down:
- The **exact timestamp** of the \`ORA-00600\` line (format: \`Mon Jan 15 02:47:33 2026\`)
- The **node** where this appears (PRODDB1 or PRODDB2)
- The **process name** in the error header — it will be a parallel slave like \`P001\`, \`P002\`

### 1.2 — Parallel Slave Trace File Discovery

\`\`\`bash
# Find trace files created around the crash time (within 30 minutes)
# Method 1: by modification time (use -mmin with a generous window)
find \$ORACLE_BASE/admin/\$ORACLE_SID/udump/ -name "*.trc" -mmin -30 | sort | head -20

# Also check bdump for background process traces
find \$ORACLE_BASE/admin/\$ORACLE_SID/bdump/ -name "*p0*.trc" -mmin -30

# Method 2: create a reference file at the crash timestamp and use -newer
# (Replace with actual crash time before running)
touch -t 202601150244 /tmp/crash_minus_3min
touch -t 202601150250 /tmp/crash_plus_3min
find \$ORACLE_BASE/admin/\$ORACLE_SID/udump/ -name "*_p0*.trc" \\
  -newer /tmp/crash_minus_3min ! -newer /tmp/crash_plus_3min
\`\`\`

**RAC note:** If the slave ran on instance 2 (PRODDB2), the trace file is in PRODDB2's udump directory on node 2. SSH to node 2 and run the same search:

\`\`\`bash
ssh oracle@proddb2-host \\
  "find \$ORACLE_BASE/admin/PRODDB2/udump/ -name '*_p0*.trc' -mmin -30"
\`\`\`

### 1.3 — Parse the Slave Trace File

Once you have identified the primary slave trace file, extract the key identifiers:

\`\`\`bash
TRACE_FILE="\$ORACLE_BASE/admin/\$ORACLE_SID/udump/PRODDB1_p001_28734.trc"

echo "=== Session ID ==="
grep "SESSION ID" "\$TRACE_FILE" | head -3

echo "=== Module and Action (EBS sets these) ==="
grep "MODULE NAME\\|ACTION NAME" "\$TRACE_FILE" | head -4

echo "=== Parallel Coordinator OS PID ==="
grep -i "parallel coordinator\\|coordinator pid\\|qc pid\\|ospid=" "\$TRACE_FILE" | head -5

echo "=== Current SQL at crash ==="
grep -A 20 "^Current SQL\\|^CURRENT SQL" "\$TRACE_FILE" | head -25

echo "=== SQL Hash Value ==="
grep "hv=" "\$TRACE_FILE" | head -5

echo "=== Error Stack ==="
grep -B 2 -A 5 "ORA-00600\\|ORA-07445" "\$TRACE_FILE" | head -30
\`\`\`

From this output, record:
- **Coordinator ospid** (e.g., \`28734\`) — this is \`\$QC_SPID\` for Phase 3
- **MODULE NAME** — should show the EBS program short name (e.g., \`GLMASSALC\`)
- **ACTION NAME** — in EBS 11.5.10+, this is often the concurrent request ID
- **SQL hash value** (\`hv=\` field) — for SQL lookup in Phase 2
- **SQL ID** (\`sqlid=\` field) — for AWR lookup if shared pool was cleared

---

## Phase 2 — Database-Level Evidence Collection

Run these queries on the **surviving instance** (PRODDB1 if PRODDB2 crashed, or after restart). In-memory ASH on the surviving instance may still contain pre-crash samples — do not delay this phase.

\`\`\`sql
-- 1. Confirm instance startup times — identify which instance crashed and when it restarted
SELECT inst_id, instance_name, startup_time, status
FROM gv\$instance
ORDER BY instance_number;

-- 2. In-memory ASH: parallel sessions active near the crash window
-- Run immediately after the surviving instance is accessible
SELECT inst_id,
       session_id,
       sql_id,
       sql_hash_value,
       event,
       module,
       action,
       program,
       qc_session_id,
       qc_instance_id,
       TO_CHAR(sample_time, 'YYYY-MM-DD HH24:MI:SS') AS sample_time
FROM gv\$active_session_history
WHERE sample_time BETWEEN TO_DATE('2026-01-15 02:40:00','YYYY-MM-DD HH24:MI:SS')
  AND TO_DATE('2026-01-15 02:50:00','YYYY-MM-DD HH24:MI:SS')
  AND qc_instance_id IS NOT NULL
ORDER BY sample_time DESC;

-- 3. Look up SQL text for the hash value extracted from the trace file
SELECT piece, sql_text
FROM v\$sqltext
WHERE hash_value = <hash_from_trace>
ORDER BY piece;

-- 4. AWR historical ASH (requires Diagnostic Pack license)
SELECT ash.sample_time,
       ash.inst_id,
       ash.session_id,
       ash.sql_id,
       ash.module,
       ash.action,
       ash.qc_session_id,
       ash.qc_instance_id,
       ROUND(ash.delta_interconnect_io_bytes/1024/1024,2) AS interconnect_mb
FROM dba_hist_active_sess_history ash
WHERE ash.snap_id IN (
  SELECT snap_id FROM dba_hist_snapshot
  WHERE begin_interval_time >= SYSDATE - 1
)
AND ash.sample_time BETWEEN TO_DATE('2026-01-15 02:40:00','YYYY-MM-DD HH24:MI:SS')
  AND TO_DATE('2026-01-15 02:50:00','YYYY-MM-DD HH24:MI:SS')
ORDER BY ash.sample_time DESC;
\`\`\`

---

## Phase 3 — EBS Concurrent Request Identification

Use all three approaches. Approaches A and C are the most definitive when their prerequisites are available. Approach B casts a wide net and produces a shortlist to validate against the log files in Phase 4.

### Approach A — Map via QC Oracle SPID (Most Reliable)

Requires: the coordinator OS PID (\`\$QC_SPID\`) extracted from the slave trace file.

\`\`\`sql
SELECT
    fcr.request_id,
    fcp.concurrent_program_name,
    fcpt.user_concurrent_program_name,
    TO_CHAR(fcr.actual_start_date,'YYYY-MM-DD HH24:MI:SS')       AS actual_start,
    TO_CHAR(fcr.actual_completion_date,'YYYY-MM-DD HH24:MI:SS')  AS actual_end,
    fcr.argument_text,
    fcr.phase_code,
    fcr.status_code,
    fcr.completion_text,
    fu.user_name         AS requested_by,
    fproc.oracle_process_id  AS manager_os_pid,
    fproc.oracle_session_id  AS manager_db_session
FROM apps.fnd_concurrent_requests fcr
JOIN apps.fnd_concurrent_programs fcp
  ON  fcr.concurrent_program_id  = fcp.concurrent_program_id
  AND fcr.program_application_id = fcp.application_id
JOIN apps.fnd_concurrent_programs_tl fcpt
  ON  fcp.concurrent_program_id = fcpt.concurrent_program_id
  AND fcpt.language = 'US'
JOIN apps.fnd_user fu
  ON fcr.requested_by = fu.user_id
JOIN apps.fnd_concurrent_processes fproc
  ON fcr.controlling_manager = fproc.concurrent_process_id
WHERE fproc.oracle_process_id = '&QC_SPID';
\`\`\`

If this returns one row: that is your root cause request. Note the \`request_id\` and \`concurrent_program_name\` and proceed to Phase 4.

### Approach B — All Requests Active During the Crash Window

Returns every concurrent request that was in flight at the exact crash timestamp. Use the timestamp from the alert log.

\`\`\`sql
SELECT
    fcr.request_id,
    fcp.concurrent_program_name,
    fcpt.user_concurrent_program_name,
    TO_CHAR(fcr.actual_start_date,'YYYY-MM-DD HH24:MI:SS')      AS actual_start,
    TO_CHAR(fcr.actual_completion_date,'YYYY-MM-DD HH24:MI:SS') AS actual_end,
    fcr.phase_code,
    fcr.status_code,
    fcr.completion_text,
    fu.user_name        AS requested_by,
    fproc.oracle_process_id AS manager_pid,
    fproc.db_instance       AS manager_instance
FROM apps.fnd_concurrent_requests fcr
JOIN apps.fnd_concurrent_programs fcp
  ON  fcr.concurrent_program_id  = fcp.concurrent_program_id
  AND fcr.program_application_id = fcp.application_id
JOIN apps.fnd_concurrent_programs_tl fcpt
  ON  fcp.concurrent_program_id = fcpt.concurrent_program_id
  AND fcpt.language = 'US'
JOIN apps.fnd_user fu ON fcr.requested_by = fu.user_id
LEFT JOIN apps.fnd_concurrent_processes fproc
  ON fcr.controlling_manager = fproc.concurrent_process_id
WHERE fcr.actual_start_date <= TO_DATE('&crash_time', 'YYYY-MM-DD HH24:MI:SS')
  AND (fcr.actual_completion_date IS NULL
       OR fcr.actual_completion_date >= TO_DATE('&crash_time', 'YYYY-MM-DD HH24:MI:SS'))
ORDER BY fcr.actual_start_date DESC;
\`\`\`

Narrow the results by:
1. Looking for \`status_code = 'E'\` (Error) or \`status_code = 'X'\` (Terminated) combined with \`phase_code = 'C'\` (Completed)
2. Cross-referencing \`manager_pid\` against the QC SPID from Approach A
3. Filtering for programs known to use parallelism (GL, AR, custom extract programs)

### Approach C — MODULE/ACTION Decode from ASH

Works when EBS set the \`ACTION\` in the database session before the crash (standard behavior in EBS 11.5.10+). This approach uses the AWR ASH data from Phase 2.

\`\`\`sql
SELECT
    TO_NUMBER(ash.action)           AS probable_request_id,
    fcr.concurrent_program_name,
    fcpt.user_concurrent_program_name,
    TO_CHAR(fcr.actual_start_date,'YYYY-MM-DD HH24:MI:SS') AS actual_start,
    fcr.phase_code,
    fcr.status_code,
    fcr.completion_text
FROM (
    SELECT DISTINCT action, module
    FROM dba_hist_active_sess_history
    WHERE sample_time BETWEEN TO_DATE('2026-01-15 02:40:00','YYYY-MM-DD HH24:MI:SS')
      AND TO_DATE('2026-01-15 02:50:00','YYYY-MM-DD HH24:MI:SS')
      AND action IS NOT NULL
      AND REGEXP_LIKE(action, '^[0-9]+\$')
      AND qc_instance_id IS NOT NULL
) ash
JOIN apps.fnd_concurrent_requests fcr
  ON fcr.request_id = TO_NUMBER(ash.action)
JOIN apps.fnd_concurrent_programs fcp
  ON fcr.concurrent_program_id = fcp.concurrent_program_id
JOIN apps.fnd_concurrent_programs_tl fcpt
  ON fcp.concurrent_program_id = fcpt.concurrent_program_id
  AND fcpt.language = 'US'
ORDER BY fcr.actual_start_date;
\`\`\`

---

## Phase 4 — Confirm the Root Cause Request

For each request ID in your shortlist, run this confirmation query:

\`\`\`sql
SELECT fcr.request_id,
       fcr.phase_code,
       fcr.status_code,
       fcr.completion_text,
       fcr.logfile_name,
       fcr.outfile_name,
       ROUND((fcr.actual_completion_date - fcr.actual_start_date)*24*60, 1) AS runtime_minutes
FROM fnd_concurrent_requests fcr
WHERE fcr.request_id IN (<shortlist_ids>)
ORDER BY fcr.actual_start_date;
\`\`\`

Then examine the log file for each suspect. Key confirmation signatures:

**Signature 1 — ORA-03113 in the log:**
\`\`\`
REP-0069: Internal error
ORA-03113: end of file on communication channel
\`\`\`

**Signature 2 — Abrupt truncation:**
The log file ends mid-report, mid-page, or mid-data row with no "Program completed" or "Request completed" message.

**Signature 3 — Timing matches:**
The request's \`actual_start_date\` is before the crash timestamp, and either \`actual_completion_date\` is NULL or equals the crash timestamp (rounded to the nearest minute by the Concurrent Manager's error handling).

The request that shows all three is your confirmed root cause.

---

## Phase 5 — Complete Diagnostic Shell Script

This script automates Phases 1 through 4. Run it immediately after the crash event. It collects alert log evidence, parses available slave trace files, runs all three EBS identification approaches, and writes a ranked suspect list to the output directory.

\`\`\`bash
#!/bin/bash
# /u01/oracle/scripts/rac_crash_diagnosis.sh
# Purpose: Collect evidence after an Oracle RAC instance crash traced to EBS concurrent request
# Usage:   ./rac_crash_diagnosis.sh "<crash_timestamp>" [qc_spid]
# Example: ./rac_crash_diagnosis.sh "2026-01-15 02:47:33" 28734
#
# Run as: oracle OS user with sqlplus access to APPS schema
# Requires: ORACLE_SID and ORACLE_BASE set in environment
#           APPS_DB_PASS environment variable with APPS schema password

CRASH_TIME=\${1:-"\$(date +'%Y-%m-%d %H:%M:%S')"}
QC_SPID=\${2:-""}
ORACLE_SID=\${ORACLE_SID:-"PRODDB1"}
APPS_PASS=\${APPS_DB_PASS:-"apps"}
OUTPUT_DIR="/u01/oracle/crash_reports/\$(date +%Y%m%d_%H%M%S)"

mkdir -p "\$OUTPUT_DIR"
LOG="\$OUTPUT_DIR/diagnosis.log"
exec > >(tee -a "\$LOG") 2>&1

echo "============================================================"
echo "  EBS RAC Crash Diagnosis Report"
echo "  Crash Time : \$CRASH_TIME"
echo "  Instance   : \$ORACLE_SID"
echo "  QC SPID    : \${QC_SPID:-'(not provided — will use timestamp approach)'}"
echo "  Generated  : \$(date)"
echo "============================================================"

# ---- PHASE 1: Alert Log Evidence ----------------------------------------
echo ""
echo "=== PHASE 1: Alert Log Evidence ==="
ALERT_LOG="\$ORACLE_BASE/admin/\$ORACLE_SID/bdump/alert_\${ORACLE_SID}.log"
if [ -f "\$ALERT_LOG" ]; then
  echo "Alert log: \$ALERT_LOG"
  echo "--- Errors near crash time ---"
  grep -n "ORA-00600\\|ORA-07445\\|ksxpcre\\|Instance terminated\\|NODE EVICTION\\|parallel" \\
    "\$ALERT_LOG" | tail -30 | tee "\$OUTPUT_DIR/alert_log_errors.txt"
else
  echo "WARNING: Alert log not found at \$ALERT_LOG"
  echo "Check: find \$ORACLE_BASE -name 'alert_\${ORACLE_SID}.log' 2>/dev/null"
fi

# ---- PHASE 2: Trace File Discovery --------------------------------------
echo ""
echo "=== PHASE 2: Parallel Slave Trace Files ==="
UDUMP="\$ORACLE_BASE/admin/\$ORACLE_SID/udump"
BDUMP="\$ORACLE_BASE/admin/\$ORACLE_SID/bdump"

echo "Looking for P0nn trace files modified in last 30 minutes..."
find "\$UDUMP" "\$BDUMP" -name "*_p0*.trc" -mmin -30 2>/dev/null | \\
  sort | tee "\$OUTPUT_DIR/slave_trace_files.txt"

# Parse the most recently modified slave trace file
LATEST_SLAVE_TRACE=\$(find "\$UDUMP" "\$BDUMP" -name "*_p0*.trc" -mmin -30 2>/dev/null | \\
  xargs ls -t 2>/dev/null | head -1)

if [ -n "\$LATEST_SLAVE_TRACE" ]; then
  echo ""
  echo "--- Parsing latest slave trace: \$LATEST_SLAVE_TRACE ---"
  echo "Session ID:"
  grep "SESSION ID" "\$LATEST_SLAVE_TRACE" | head -2

  echo "Module/Action (EBS sets these):"
  grep "MODULE NAME\\|ACTION NAME" "\$LATEST_SLAVE_TRACE" | head -4

  echo "Parallel Coordinator OS PID:"
  grep -i "parallel coordinator\\|coordinator pid\\|ospid=" "\$LATEST_SLAVE_TRACE" | head -3

  echo "SQL Hash Value:"
  grep "hv=" "\$LATEST_SLAVE_TRACE" | head -3

  echo "Current SQL at crash:"
  grep -A 10 "^Current SQL\\|^CURRENT SQL" "\$LATEST_SLAVE_TRACE" | head -15

  echo "Error Stack:"
  grep -B 2 -A 5 "ORA-00600\\|ORA-07445" "\$LATEST_SLAVE_TRACE" | head -20

  cp "\$LATEST_SLAVE_TRACE" "\$OUTPUT_DIR/primary_slave_trace.trc"
  echo "(Copied to \$OUTPUT_DIR/primary_slave_trace.trc)"
else
  echo "No P0nn trace files found modified in last 30 minutes."
  echo "If the crash was on a different node, SSH to that node and re-run."
fi

# ---- PHASE 3: Database Evidence Collection ------------------------------
echo ""
echo "=== PHASE 3: EBS Concurrent Request Identification ==="

# Compute time window: 10 minutes before crash through 5 minutes after
# GNU date syntax (Linux):
WINDOW_START=\$(date -d "\$CRASH_TIME - 10 minutes" +'%Y-%m-%d %H:%M:%S' 2>/dev/null || \\
               date -v-10M -j -f "%Y-%m-%d %H:%M:%S" "\$CRASH_TIME" +'%Y-%m-%d %H:%M:%S' 2>/dev/null || \\
               echo "2026-01-15 02:37:00")
WINDOW_END=\$(date -d "\$CRASH_TIME + 5 minutes" +'%Y-%m-%d %H:%M:%S' 2>/dev/null || \\
             date -v+5M -j -f "%Y-%m-%d %H:%M:%S" "\$CRASH_TIME" +'%Y-%m-%d %H:%M:%S' 2>/dev/null || \\
             echo "2026-01-15 02:52:00")

echo "Evidence window: \$WINDOW_START  to  \$WINDOW_END"
echo "Running EBS FND queries and ASH queries..."

sqlplus -S apps/"\$APPS_PASS" <<SQL | tee "\$OUTPUT_DIR/db_evidence.txt"
SET LINESIZE 200 PAGESIZE 100 TRIMSPOOL ON FEEDBACK OFF
COLUMN concurrent_program_name      FORMAT A30
COLUMN user_concurrent_program_name FORMAT A40
COLUMN user_name                    FORMAT A20
COLUMN actual_start                 FORMAT A20
COLUMN actual_end                   FORMAT A20
COLUMN completion_text              FORMAT A50
COLUMN mgr_pid                      FORMAT A10
COLUMN manager_instance             FORMAT A15

PROMPT
PROMPT ========================================================
PROMPT APPROACH B: All EBS Requests Active at Crash Time
PROMPT ========================================================
SELECT fcr.request_id,
       fcp.concurrent_program_name,
       TO_CHAR(fcr.actual_start_date,'YYYY-MM-DD HH24:MI:SS')       AS actual_start,
       TO_CHAR(fcr.actual_completion_date,'YYYY-MM-DD HH24:MI:SS')  AS actual_end,
       fcr.phase_code,
       fcr.status_code,
       fu.user_name,
       fproc.oracle_process_id AS mgr_pid,
       fproc.db_instance       AS manager_instance
FROM apps.fnd_concurrent_requests fcr
JOIN apps.fnd_concurrent_programs fcp
  ON  fcr.concurrent_program_id  = fcp.concurrent_program_id
  AND fcr.program_application_id = fcp.application_id
JOIN apps.fnd_user fu ON fcr.requested_by = fu.user_id
LEFT JOIN apps.fnd_concurrent_processes fproc
  ON fcr.controlling_manager = fproc.concurrent_process_id
WHERE fcr.actual_start_date <= TO_DATE('\${CRASH_TIME}', 'YYYY-MM-DD HH24:MI:SS')
  AND (fcr.actual_completion_date IS NULL
       OR fcr.actual_completion_date >= TO_DATE('\${CRASH_TIME}', 'YYYY-MM-DD HH24:MI:SS'))
ORDER BY fcr.actual_start_date DESC;

\$(if [ -n "\$QC_SPID" ]; then
cat <<INNER
PROMPT
PROMPT ========================================================
PROMPT APPROACH A: Requests Mapped to QC SPID \${QC_SPID}
PROMPT ========================================================
SELECT fcr.request_id,
       fcp.concurrent_program_name,
       TO_CHAR(fcr.actual_start_date,'YYYY-MM-DD HH24:MI:SS') AS actual_start,
       fcr.phase_code,
       fcr.status_code,
       fcr.completion_text
FROM apps.fnd_concurrent_requests fcr
JOIN apps.fnd_concurrent_programs fcp
  ON  fcr.concurrent_program_id  = fcp.concurrent_program_id
  AND fcr.program_application_id = fcp.application_id
JOIN apps.fnd_concurrent_processes fproc
  ON fcr.controlling_manager = fproc.concurrent_process_id
WHERE fproc.oracle_process_id = '\${QC_SPID}';
INNER
fi)

PROMPT
PROMPT ========================================================
PROMPT In-Memory ASH: Parallel Sessions Near Crash Window
PROMPT ========================================================
SELECT TO_CHAR(sample_time,'HH24:MI:SS') AS time_of_sample,
       inst_id,
       session_id,
       sql_hash_value,
       module,
       action,
       qc_session_id,
       qc_instance_id,
       event
FROM gv\$active_session_history
WHERE sample_time BETWEEN TO_DATE('\${WINDOW_START}','YYYY-MM-DD HH24:MI:SS')
  AND TO_DATE('\${WINDOW_END}','YYYY-MM-DD HH24:MI:SS')
  AND qc_instance_id IS NOT NULL
ORDER BY sample_time DESC
FETCH FIRST 30 ROWS ONLY;

PROMPT
PROMPT ========================================================
PROMPT APPROACH C: Requests Decoded from ASH ACTION Column
PROMPT ========================================================
SELECT DISTINCT TO_NUMBER(ash.action) AS request_id_from_ash,
       fcr.phase_code,
       fcr.status_code,
       fcp.concurrent_program_name,
       fcr.completion_text
FROM (SELECT DISTINCT action
      FROM gv\$active_session_history
      WHERE sample_time BETWEEN TO_DATE('\${WINDOW_START}','YYYY-MM-DD HH24:MI:SS')
        AND TO_DATE('\${WINDOW_END}','YYYY-MM-DD HH24:MI:SS')
        AND REGEXP_LIKE(action,'^[0-9]+\$')) ash
JOIN apps.fnd_concurrent_requests fcr
  ON fcr.request_id = TO_NUMBER(ash.action)
JOIN apps.fnd_concurrent_programs fcp
  ON  fcr.concurrent_program_id  = fcp.concurrent_program_id
  AND fcr.program_application_id = fcp.application_id
WHERE fcr.actual_start_date IS NOT NULL
ORDER BY request_id_from_ash;

EXIT;
SQL

# ---- PHASE 4: High-DOP Tables (Parallel Risk Audit) --------------------
echo ""
echo "=== PHASE 4: High Parallel Degree Tables (Parallel Risk) ==="
sqlplus -S apps/"$APPS_PASS" <<SQL | tee "$OUTPUT_DIR/high_dop_tables.txt"
SET LINESIZE 150 PAGESIZE 50 FEEDBACK OFF
COLUMN owner       FORMAT A10
COLUMN table_name  FORMAT A40
COLUMN degree      FORMAT A10
COLUMN partitioned FORMAT A5
COLUMN num_rows    FORMAT 999999999990

PROMPT Tables in EBS schemas with degree > 1:
SELECT owner, table_name, degree, partitioned, num_rows
FROM dba_tables
WHERE TRIM(degree) NOT IN ('1','DEFAULT','0')
  AND owner IN ('APPS','AR','AP','GL','INV','PO','ONT','WIP','FND','XLA')
ORDER BY TO_NUMBER(TRIM(degree)) DESC
FETCH FIRST 30 ROWS ONLY;

EXIT;
SQL

# ---- SUMMARY -----------------------------------------------------------
echo ""
echo "============================================================"
echo "  DIAGNOSIS COMPLETE"
echo "  Output directory : \$OUTPUT_DIR"
echo ""
echo "  Files generated:"
ls -lh "\$OUTPUT_DIR/"
echo ""
echo "  NEXT STEPS:"
echo "  1. Review \$OUTPUT_DIR/db_evidence.txt"
echo "     Look for requests with status_code E or X at crash time"
echo "     Cross-reference mgr_pid against QC SPID from trace file"
echo "  2. For each suspect request:"
echo "     Check FND_CONCURRENT_REQUESTS.logfile_name"
echo "     Look for ORA-03113 or abrupt truncation at crash time"
echo "  3. Immediate stabilization fix:"
echo "     sqlplus / as sysdba"
echo "     ALTER SYSTEM SET PARALLEL_INSTANCE_GROUP = 'LOCAL_NODE' SCOPE=BOTH;"
echo "  4. Review \$OUTPUT_DIR/high_dop_tables.txt"
echo "     ALTER TABLE apps.<table> NOPARALLEL;  -- for degree > 4 offenders"
echo "  5. Check MOS for ORA-00600 [ksxpcre1] patches for your 10gR2 patchset"
echo "============================================================"
\`\`\`

Save this script to \`/u01/oracle/scripts/rac_crash_diagnosis.sh\` and make it executable:

\`\`\`bash
chmod 750 /u01/oracle/scripts/rac_crash_diagnosis.sh
\`\`\`

Run example for the scenario in this runbook:

\`\`\`bash
ORACLE_SID=PRODDB1 ORACLE_BASE=/u01/app/oracle APPS_DB_PASS=apps_password \\
  /u01/oracle/scripts/rac_crash_diagnosis.sh "2026-01-15 02:47:33" 28734
\`\`\`

---

## Phase 6 — Stabilization Queries

Run these on all RAC instances as SYSDBA after the root cause is confirmed.

\`\`\`sql
-- Fix 1: Restrict parallel execution to local instance on ALL nodes
-- Run on each instance separately (or use ALTER SYSTEM on each node)
ALTER SYSTEM SET PARALLEL_INSTANCE_GROUP = 'LOCAL_NODE' SCOPE=BOTH;
ALTER SYSTEM SET INSTANCE_GROUPS = 'LOCAL_NODE' SCOPE=SPFILE;
-- SPFILE change requires bounce; SCOPE=BOTH handles the live system immediately

-- Fix 2: Generate ALTER TABLE NOPARALLEL statements for all high-DOP tables
-- Review output before executing — do not blindly run on partition-heavy schemas
SELECT 'ALTER TABLE ' || owner || '.' || table_name || ' NOPARALLEL;' AS fix_statement
FROM dba_tables
WHERE TRIM(degree) NOT IN ('1','DEFAULT','0')
  AND TO_NUMBER(TRIM(degree)) > 4
  AND owner IN ('APPS','AR','AP','GL','INV','PO','ONT','WIP','FND','XLA')
ORDER BY TO_NUMBER(TRIM(degree)) DESC;

-- Fix 3: Check concurrent programs with parallel execution options set
-- These programs may need to have their execution options adjusted in EBS SysAdmin
SELECT fcp.concurrent_program_name,
       fcp.execution_options
FROM fnd_concurrent_programs fcp
WHERE UPPER(fcp.execution_options) LIKE '%PARALLEL%'
   OR UPPER(fcp.execution_options) LIKE '%DEGREE%'
ORDER BY fcp.concurrent_program_name;

-- Fix 4: After bounce, verify PARALLEL_INSTANCE_GROUP is set on all nodes
SELECT inst_id, name, value
FROM gv\$parameter
WHERE name IN ('parallel_instance_group', 'instance_groups', 'parallel_max_servers')
ORDER BY inst_id, name;

-- Fix 5: Confirm no cross-instance parallel slaves appear in a test run
-- After running the identified program in test, check this:
SELECT inst_id, sid, sql_id, program, module, action,
       qc_session_id, qc_instance_id
FROM gv\$active_session_history
WHERE sample_time > SYSDATE - 1/24
  AND qc_instance_id IS NOT NULL
  AND inst_id != qc_instance_id;  -- cross-instance slaves — should return 0 rows after fix
\`\`\`

---

## Phase 7 — Validation Matrix

| Check | Command / Query | Pass Criterion |
|-------|----------------|----------------|
| Crash timestamp identified | \`grep "Instance terminated" alert_\$ORACLE_SID.log\` | Exact timestamp found |
| Slave trace file found | \`find \$ORACLE_BASE .../udump -name "*p0*.trc" -mmin -30\` | At least one trace file found |
| QC SPID extracted | \`grep "parallel coordinator" primary_slave_trace.trc\` | Numeric SPID value found |
| SQL hash value extracted | \`grep "hv=" primary_slave_trace.trc\` | Numeric hash value found |
| Suspect request IDs — Approach A | \`fnd_concurrent_processes.oracle_process_id = QC_SPID\` | 1+ request IDs returned |
| Suspect request IDs — Approach B | Timestamp window query | Active request list returned |
| Suspect request IDs — Approach C | \`REGEXP_LIKE(action,'^[0-9]+\$')\` in ASH | Request IDs decoded from ASH |
| Root cause request confirmed | \`completion_text\` contains ORA-03113 or log truncated | Log ends without "Process completed" |
| PARALLEL_INSTANCE_GROUP set | \`gv\$parameter\` query | \`value = LOCAL_NODE\` on all instances |
| High-DOP tables reset | \`dba_tables\` query | No tables with \`degree > 4\` in target schemas |
| Cross-instance slaves eliminated | \`gv\$active_session_history\` cross-instance check | 0 rows returned |
| No new parallel crashes | Alert log check next morning | No \`ORA-00600 [ksxpcre1]\` in last 24h |

---

## Quick Reference — Key Locations and Commands

\`\`\`bash
# Alert log (Oracle 10g)
\$ORACLE_BASE/admin/\$ORACLE_SID/bdump/alert_\$ORACLE_SID.log

# Parallel slave trace files (10g)
\$ORACLE_BASE/admin/\$ORACLE_SID/udump/<SID>_p0nn_<SPID>.trc

# Concurrent request log files (EBS app tier)
\$APPLCSF/\$APPLLOG/<request_id>.req

# EBS request log path from the database
SELECT logfile_name FROM fnd_concurrent_requests WHERE request_id = <id>;

# Immediate parallel restriction (run on each instance as SYSDBA)
ALTER SYSTEM SET PARALLEL_INSTANCE_GROUP = 'LOCAL_NODE' SCOPE=BOTH;

# Verify restriction is active
SELECT inst_id, name, value FROM gv\$parameter WHERE name = 'parallel_instance_group';

# Find all slave trace files from last 2 hours on both nodes
find \$ORACLE_BASE/admin/\$ORACLE_SID/udump/ -name "*_p0*.trc" -mmin -120 | sort
\`\`\`
`,
};

async function main() {
  console.log('Inserting EBS RAC parallel slave crash runbook...');
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
