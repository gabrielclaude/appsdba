import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Troubleshooting Slow Oracle EBS Concurrent Requests with Trace, AWR, ASH, ADDM, and OS Watcher',
  slug: 'ebs-concurrent-requests-slow-runbook',
  excerpt:
    'End-to-end step-by-step runbook for diagnosing slow concurrent requests — from triage through trace collection, AWR/ASH/ADDM analysis, OS Watcher correlation, root cause identification, and resolution.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-22'),
  youtubeUrl: null,
  content: `This runbook provides end-to-end procedures for diagnosing slow Oracle EBS concurrent requests. Assumptions: Oracle EBS R12.2.x, Oracle Database 12.2 or later, Oracle Diagnostic Pack licence (required for AWR/ASH/ADDM), DBA access, OS access to Oracle DB server.

---

## Phase 0: Triage

### Step 0.1 — Identify the Slow Request

Gather: request_id, program name, actual start time, current duration, and whether it is still running.

\`\`\`sql
-- Currently running requests and their duration
SELECT fcr.request_id,
       cp.concurrent_program_name,
       cp.user_concurrent_program_name,
       fcr.actual_start_date,
       ROUND((SYSDATE - fcr.actual_start_date) * 60, 1) mins_running,
       fcr.phase_code || '/' || fcr.status_code status
FROM applsys.fnd_concurrent_requests fcr
JOIN applsys.fnd_concurrent_programs cp
  ON fcr.concurrent_program_id = cp.concurrent_program_id
  AND fcr.program_application_id = cp.application_id
WHERE fcr.phase_code = 'R'
ORDER BY mins_running DESC;
\`\`\`

\`\`\`sql
-- Recently completed requests — find the slow one
SELECT fcr.request_id,
       cp.concurrent_program_name,
       fcr.actual_start_date,
       fcr.actual_completion_date,
       ROUND((fcr.actual_completion_date - fcr.actual_start_date) * 60, 1) mins_total,
       fcr.phase_code || '/' || fcr.status_code status
FROM applsys.fnd_concurrent_requests fcr
JOIN applsys.fnd_concurrent_programs cp
  ON fcr.concurrent_program_id = cp.concurrent_program_id
  AND fcr.program_application_id = cp.application_id
WHERE fcr.actual_start_date > SYSDATE - 1
ORDER BY mins_total DESC NULLS LAST
FETCH FIRST 20 ROWS ONLY;
\`\`\`

### Step 0.2 — Historical Duration Baseline

\`\`\`sql
-- How long has this program run historically? (last 30 occurrences)
SELECT request_id,
       actual_start_date,
       ROUND((actual_completion_date - actual_start_date) * 60, 1) mins,
       phase_code || '/' || status_code status
FROM applsys.fnd_concurrent_requests
WHERE concurrent_program_id = (
  SELECT concurrent_program_id FROM applsys.fnd_concurrent_programs
  WHERE concurrent_program_name = '&program_name'
  AND application_id = (SELECT application_id FROM applsys.fnd_application WHERE application_short_name = '&app_short_name'))
ORDER BY actual_start_date DESC
FETCH FIRST 30 ROWS ONLY;
\`\`\`

Record: median duration, standard deviation. Define "slow" as: > 2x median duration.

### Step 0.3 — Decision: Running or Completed?

| Situation | First Tool | Second Tool |
|-----------|-----------|------------|
| Currently running, > 30 mins | ASH (Phase 3 first) | Trace (Phase 1) |
| Completed slowly, trace was enabled | Trace/tkprof (Phase 1) | AWR (Phase 2) |
| Completed slowly, no trace | AWR (Phase 2) | ASH history (Phase 3) |
| Systemic (all programs slow) | AWR + OS Watcher | ADDM |

### Step 0.4 — Check for Systemic Slowdown

\`\`\`sql
-- Are multiple programs slow simultaneously?
SELECT cp.concurrent_program_name,
       COUNT(*) cnt,
       AVG(ROUND((fcr.actual_completion_date - fcr.actual_start_date) * 60, 1)) avg_mins
FROM applsys.fnd_concurrent_requests fcr
JOIN applsys.fnd_concurrent_programs cp
  ON fcr.concurrent_program_id = cp.concurrent_program_id
  AND fcr.program_application_id = cp.application_id
WHERE fcr.actual_start_date > SYSDATE - 1
  AND fcr.phase_code = 'C'
GROUP BY cp.concurrent_program_name
ORDER BY avg_mins DESC NULLS LAST
FETCH FIRST 20 ROWS ONLY;
\`\`\`

If 5+ programs are running slow simultaneously → the issue is systemic (resource contention or infrastructure), not program-specific. Skip to Phase 5 (OS Watcher) immediately.

---

## Phase 1: Enable and Collect Program Trace

### Step 1.1 — Find the Oracle Session for the Running Request

\`\`\`sql
SELECT s.sid, s.serial#, s.osuser, s.program, s.module,
       p.spid os_process_id
FROM v$session s
JOIN v$process p ON s.paddr = p.addr
WHERE s.client_info LIKE '%:' || &request_id
   OR s.module = 'FNDCPGSC' || LPAD(&request_id, 10, '0');
\`\`\`

If the above returns no rows, try:

\`\`\`sql
SELECT s.sid, s.serial#, s.module, s.action, s.client_info
FROM v$session s
WHERE s.module LIKE 'FNDCPGSC%'
  AND s.status = 'ACTIVE';
\`\`\`

### Step 1.2 — Enable 10046 Trace Level 12

\`\`\`sql
-- Level 12 = SQL text + execution statistics + wait events + bind variable values
EXEC DBMS_SYSTEM.SET_EV(&sid, &serial, 10046, 12, '');

-- Confirm trace is active
SELECT s.sid, s.serial#, t.tracefile
FROM v$session s
JOIN v$process p ON s.paddr = p.addr
CROSS JOIN (SELECT value tracefile FROM v$diag_info WHERE name = 'Default Trace File') t
WHERE s.sid = &sid;
\`\`\`

### Step 1.3 — Wait for the Problem to Reproduce

Let the request continue running with trace enabled. For batch programs, you typically need to let it run for at least 10–15 minutes to capture a meaningful trace sample.

### Step 1.4 — Disable Trace

\`\`\`sql
EXEC DBMS_SYSTEM.SET_EV(&sid, &serial, 10046, 0, '');
\`\`\`

### Step 1.5 — Locate and Copy the Trace File

\`\`\`bash
# Oracle DB host
TRACE_DIR=$(sqlplus -S / as sysdba <<'EOF'
SET HEADING OFF FEEDBACK OFF
SELECT value FROM v\$diag_info WHERE name = 'Diag Trace';
EXIT
EOF
)

# Find trace file for the OS process (spid from Step 1.1)
ls -lt $TRACE_DIR | grep <spid>

# Copy to working directory
cp $TRACE_DIR/<tracefile>.trc /tmp/
\`\`\`

### Step 1.6 — Run tkprof

\`\`\`bash
# Standard tkprof — sort by elapsed time, show waits, suppress recursive SQL
tkprof /tmp/<tracefile>.trc /tmp/tkprof_output.txt \
  sort=exeela \
  waits=yes \
  sys=no \
  explain=apps/<apps_password>

# View the output
head -200 /tmp/tkprof_output.txt
\`\`\`

### Step 1.7 — Interpret tkprof — Key Signals

Open tkprof_output.txt and look for these patterns in the top 5 SQL statements:

| Pattern | Meaning | Action |
|---------|---------|--------|
| EXECUTE count > 100,000 | SQL called in a tight loop | Find and rewrite the N+1 query |
| disk reads >> (query - disk) | Missing index, reading from disk | Check execution plan, add index |
| elapsed >> cpu, no obvious waits | Row lock contention | Check v$lock for blocking sessions |
| elapsed >> cpu, high waits on "db file sequential read" | Index scan but I/O slow | Check disk %util via OS Watcher |

---

## Phase 2: AWR Analysis

### Step 2.1 — Create Manual Snapshots

\`\`\`sql
-- Before the next scheduled run of the slow program
EXEC DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT();
SELECT MAX(snap_id) FROM dba_hist_snapshot;
-- Record: start_snap_id = <value>

-- After the program completes
EXEC DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT();
SELECT MAX(snap_id) FROM dba_hist_snapshot;
-- Record: end_snap_id = <value>
\`\`\`

### Step 2.2 — Generate AWR HTML Report

\`\`\`sql
@$ORACLE_HOME/rdbms/admin/awrrpt.sql
-- Choose: 1 (HTML format)
-- Enter start_snap_id and end_snap_id
-- Save the output as awr_report.html
\`\`\`

### Step 2.3 — Navigate to Top 5 Wait Events

Record the top 3 wait events and their percentage of DB time. This determines your diagnostic direction:

- **db file sequential read > 50%**: index I/O dominant. Proceed to Step 2.5 (Top SQL by physical reads)
- **CPU time > 50%, no other significant waits**: CPU-bound execution. Proceed to Step 2.4 (Top SQL by buffer gets)
- **log file sync > 20%**: REDO I/O bottleneck. Check redo log device I/O in OS Watcher
- **enq: TX – row lock contention > 20%**: row locking. Check v$lock and application logic for lock conflicts

### Step 2.4 — Navigate to Top SQL by Buffer Gets

Each SQL ID in this list is a candidate for being the CPU consumer. For the top 3 SQL IDs:

\`\`\`sql
-- Get the SQL text
SELECT sql_text FROM dba_hist_sqltext WHERE sql_id = '&sql_id';

-- Get the execution plan from AWR
@$ORACLE_HOME/rdbms/admin/awrsqrpt.sql
-- Enter the SQL ID and snapshot range
\`\`\`

### Step 2.5 — Navigate to Top SQL by Elapsed Time

Same approach as Step 2.4. Record top 3 SQL IDs and their execution plans.

### Step 2.6 — Check for Plan Regressions

\`\`\`sql
-- Has the execution plan for a specific SQL changed recently?
SELECT plan_hash_value, executions, elapsed_time/1000000 elapsed_secs,
       buffer_gets / NULLIF(executions, 0) gets_per_exec,
       snap_id
FROM dba_hist_sqlstat
WHERE sql_id = '&sql_id'
ORDER BY snap_id DESC
FETCH FIRST 20 ROWS ONLY;
-- If plan_hash_value changed between recent snap_ids: plan regression confirmed
\`\`\`

---

## Phase 3: ASH Drill-Down

### Step 3.1 — ASH for a Running Session (Real-Time)

\`\`\`sql
-- Top wait events for the concurrent request session in the last 15 minutes
SELECT event,
       sql_id,
       COUNT(*) samples,
       ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) pct_time
FROM v$active_session_history
WHERE sample_time > SYSDATE - 15/1440
  AND session_id = &sid
  AND session_serial# = &serial
GROUP BY event, sql_id
ORDER BY samples DESC;
\`\`\`

### Step 3.2 — ASH for a Completed Session (Historical)

\`\`\`sql
-- Historical ASH for a specific request (replace time window with actual run times)
SELECT event,
       sql_id,
       COUNT(*) * 10 est_seconds,
       ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) pct_time
FROM dba_hist_active_sess_history
WHERE sample_time BETWEEN
  TO_TIMESTAMP('&start_time', 'YYYY-MM-DD HH24:MI:SS')
  AND TO_TIMESTAMP('&end_time', 'YYYY-MM-DD HH24:MI:SS')
  AND program LIKE 'FNDCPGSC%'
GROUP BY event, sql_id
ORDER BY est_seconds DESC
FETCH FIRST 15 ROWS ONLY;
\`\`\`

### Step 3.3 — Identify Hot Objects from ASH

\`\`\`sql
SELECT o.owner, o.object_name, o.object_type,
       COUNT(*) samples
FROM dba_hist_active_sess_history ash
JOIN dba_objects o ON ash.current_obj# = o.object_id
WHERE ash.sample_time BETWEEN
  TO_TIMESTAMP('&start_time', 'YYYY-MM-DD HH24:MI:SS')
  AND TO_TIMESTAMP('&end_time', 'YYYY-MM-DD HH24:MI:SS')
GROUP BY o.owner, o.object_name, o.object_type
ORDER BY samples DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

---

## Phase 4: ADDM Report

### Step 4.1 — Generate ADDM for the Request Window

\`\`\`sql
@$ORACLE_HOME/rdbms/admin/addmrpt.sql
-- Enter: start_snap_id, end_snap_id (same as AWR report)
-- Save output as addm_report.txt
\`\`\`

### Step 4.2 — Record Top 3 ADDM Findings

From the ADDM report, record:
1. Finding description
2. Estimated benefit (seconds of DB time)
3. Recommendation (SQL ID to tune, parameter to change, etc.)

### Step 4.3 — Cross-Reference with Trace

For each SQL ID that ADDM recommends tuning: check whether that SQL_ID appears in your tkprof output from Phase 1. If the same SQL appears in both ADDM and tkprof as a top consumer → high confidence that SQL is the root cause.

---

## Phase 5: OS Watcher Correlation

### Step 5.1 — Verify OSW is Active

\`\`\`bash
# Check OSW process is running
ps -ef | grep -i osw
# Expected: java process for oswbb

# Check dat files are being updated (within last 5 minutes)
ls -lt $ORACLE_BASE/suptools/oswbb/archive/ | head -5
\`\`\`

### Step 5.2 — Extract OSW Data for the Problem Window

\`\`\`bash
# Parse OSW iostat data for the time window when the slow request ran
grep -A 30 "$(date -d '&start_time' '+%m/%d/%y %H:%M')" \
  $ORACLE_BASE/suptools/oswbb/archive/oswiostat/*.dat | head -200
\`\`\`

### Step 5.3 — Key OS Metrics to Record

From OSW data covering the slow request time window:

| Metric | Source File | Alarm Threshold |
|--------|------------|-----------------|
| CPU run queue | oswvmstat.dat — r column | > number of vCPUs |
| Swap in/out | oswvmstat.dat — si/so columns | > 0 (any swap = problem) |
| DB disk %util | oswiostat.dat — %util column | > 70% |
| DB disk await | oswiostat.dat — await column | > 10ms for SSD, > 20ms for HDD |

### Step 5.4 — Draw the Conclusion

| Oracle Wait Profile | OS Profile | Root Cause |
|--------------------|-----------|------------|
| High db file sequential read | Disk %util < 30% | Bad execution plan — excessive index I/O |
| High db file sequential read | Disk %util > 80% | Storage bottleneck — I/O saturation |
| High CPU time | Run queue > vCPU count | CPU saturation — reschedule batch |
| High CPU time | Run queue ≤ vCPU count | SQL doing excessive logical reads (bad plan) |
| High log file sync | Redo log disk await > 20ms | Redo I/O bottleneck |

---

## Phase 6: Root Cause and Resolution

### Resolution Decision Table

| Root Cause | Resolution |
|-----------|-----------|
| Missing index on large table | Create index: \`CREATE INDEX ... ON table(col) ONLINE;\` |
| Plan regression (plan_hash_value changed) | Pin old plan via SQL Plan Management: \`DBMS_SPM.LOAD_PLANS_FROM_CURSOR_CACHE\` |
| N+1 query (SQL called 1M times in loop) | Rewrite PL/SQL to use bulk FORALL or set-based SQL — requires app change |
| Stale optimizer statistics | \`EXEC DBMS_STATS.GATHER_TABLE_STATS('OWNER', 'TABLE_NAME', CASCADE=>TRUE);\` |
| CPU saturation (run queue > vCPU) | Reschedule batch to off-peak; increase CPU allocation |
| Storage I/O bottleneck | Migrate to faster storage (pd-ssd → pd-extreme, or Exadata); add I/O channels |
| Row lock contention | Identify blocking session: \`SELECT * FROM v\$lock WHERE block = 1;\` — investigate application logic |

### Escalating to Oracle Support

If root cause is unclear after completing all phases, gather:

1. AWR report (HTML) for the slow period
2. ADDM report for the same period
3. tkprof output from the trace file
4. ASH extract (DBA_HIST_ACTIVE_SESS_HISTORY for the problem window)
5. OS Watcher archive for the problem window
6. Oracle alert log covering the problem window
7. Concurrent request log file (\`fcr.logfile_name\` from the FCR row)

Open a Severity 2 SR with Oracle Support, attaching all of the above.`,
};

async function main() {
  console.log('Inserting EBS concurrent requests slow runbook...');
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
