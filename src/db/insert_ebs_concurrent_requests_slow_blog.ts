import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Diagnosing Slow Oracle EBS Concurrent Requests: Program Trace, AWR, ASH, ADDM, and OS Watcher',
  slug: 'ebs-concurrent-requests-slow-diagnosis',
  excerpt:
    'A practical guide to understanding why concurrent requests run slowly, which diagnostic tool to reach for first, and how to read the signals each tool produces.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-22'),
  youtubeUrl: null,
  content: `A concurrent request that used to complete in 20 minutes is now taking 3 hours. The business is waiting. You have five diagnostic tools available — Program Trace, AWR, ASH, ADDM, and OS Watcher — and approximately 45 minutes before someone escalates. Which tool do you reach for first?

The answer depends on whether the request is currently running. If it is running right now, use ASH. If it already finished, use AWR and Trace. This document explains what each tool tells you, what it cannot tell you, and how to combine them to reach a root cause quickly.

---

## Why Concurrent Request Diagnosis Is Different

Interactive EBS sessions have a human pressing Submit and waiting. If a form query runs for 30 seconds, the user complains immediately. The problem is observed in real time.

Concurrent requests run unattended, often overnight. When a payroll report takes 5 hours instead of 45 minutes, you're diagnosing a historical event — you weren't watching it happen. The diagnostic evidence is preserved in the database (AWR, trace files, ASH history) but requires knowing where to look.

Concurrent requests also have different workload profiles from interactive sessions:
- They often process millions of rows in a single run
- They use PL/SQL packages extensively (not just ad-hoc SQL)
- They run during batch windows when other heavyweight programs are competing for resources
- Their execution plans can be invalidated by statistics changes between runs

---

## Tool Selection

\`\`\`
Is the request running right now?
    ├── YES → Start with ASH (real-time view of what the session is doing)
    │         Then enable trace if you need per-SQL detail going forward
    └── NO  → Start with AWR (historical snapshot covering when it ran)
              Then Program Trace (if trace was enabled before the slow run)
              Then ADDM (automated interpretation of AWR data)
              Then OS Watcher (if AWR shows high CPU or I/O but no obvious bad SQL)
\`\`\`

---

## Tool 1: Program Trace (Event 10046)

### What It Is

Oracle's built-in SQL trace mechanism. When enabled for a session, it records every SQL statement executed, including execution counts, elapsed time, CPU time, physical and logical reads, and wait events at the individual statement level.

For EBS concurrent programs, trace is particularly valuable because concurrent programs often call PL/SQL packages that execute dozens of SQL statements internally. AWR shows aggregate SQL across the instance — trace shows exactly which SQL statements ran inside a specific concurrent program, in order, with timing.

### How to Enable for EBS Concurrent Requests

**Method 1: Via EBS System Administrator**

1. Navigate to: System Administrator > Concurrent > Programs
2. Find the program you want to trace
3. Edit the program and check "Enable Trace"
4. Submit the request — trace is automatically enabled when it starts

**Method 2: On a Running Session**

If the request is already running and you want to start tracing mid-run:

\`\`\`sql
-- Find the Oracle SID and SERIAL# for the running concurrent request
SELECT s.sid, s.serial#, s.program, s.module, s.action
FROM v$session s
JOIN applsys.fnd_concurrent_requests fcr
  ON s.client_info LIKE '%:' || fcr.request_id
WHERE fcr.phase_code = 'R'  -- Running
  AND fcr.request_id = &your_request_id;

-- Enable extended SQL trace (level 12 = SQL + waits + binds)
EXEC DBMS_SYSTEM.SET_EV(&sid, &serial, 10046, 12, '');

-- Later: disable trace
EXEC DBMS_SYSTEM.SET_EV(&sid, &serial, 10046, 0, '');
\`\`\`

### Where to Find the Trace File

\`\`\`bash
# Oracle 11g and later — ADR location
$ORACLE_BASE/diag/rdbms/$ORACLE_SID/$ORACLE_SID/trace/

# Find trace file by OS process ID (from v$process)
SELECT p.spid os_pid, s.sid, s.serial#
FROM v$session s JOIN v$process p ON s.paddr = p.addr
WHERE s.sid = &sid;

ls -lt $ORACLE_BASE/diag/rdbms/$ORACLE_SID/$ORACLE_SID/trace/ | grep <spid>
\`\`\`

### Reading with tkprof

\`\`\`bash
# Generate human-readable output, sorted by elapsed time
tkprof /path/to/tracefile.trc /tmp/output.txt sort=exeela explain=apps/<password>

# For large trace files — only show SQL with > 1 second elapsed
tkprof /path/to/tracefile.trc /tmp/output.txt sort=exeela waits=yes sys=no
\`\`\`

### What to Look for in tkprof Output

The tkprof output shows each SQL statement with:

\`\`\`
SQL ID: xxxxxxxxxxxxxxxx
SELECT item_id, order_qty FROM oe_order_lines_all WHERE header_id = :b1

call     count       cpu    elapsed       disk      query    current        rows
------- ------  -------- ---------- ---------- ---------- ----------  ----------
Parse        1      0.00       0.01          0          0          0           0
Execute 243891      8.32      11.45          0    2189019          0           0
Fetch   243891      2.14       3.22        125    2438910          0      243891

Misses in library cache during parse: 0
Optimizer mode: ALL_ROWS
Parsing user id: 35 (APPS)
\`\`\`

Key signals:
- **High EXECUTE count** (243,891 in the example): SQL being called in a loop — N+1 query pattern
- **High DISK reads** relative to QUERY (logical reads): missing index or poor execution plan
- **Elapsed >> CPU**: session waiting for I/O or locks (waits=yes flag shows detail)
- **Parse count >> 1**: excessive reparsing — check bind variable usage

---

## Tool 2: AWR (Automatic Workload Repository)

### When to Use It

AWR is your primary tool when the slow request has already completed and you need to understand what happened during the time window it was running.

### Capture Approach

If you know in advance that a request will run slowly (it ran slowly yesterday and will run again tonight), create manual snapshot markers:

\`\`\`sql
-- Before the request starts
EXEC DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT();
SELECT MAX(snap_id) FROM dba_hist_snapshot;  -- record this as start_snap

-- After the request completes
EXEC DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT();
SELECT MAX(snap_id) FROM dba_hist_snapshot;  -- record as end_snap
\`\`\`

### Generating the AWR Report

\`\`\`sql
@$ORACLE_HOME/rdbms/admin/awrrpt.sql
-- Select: 1 (HTML), start_snap, end_snap
-- Open the generated HTML file in a browser
\`\`\`

### What to Read First in the AWR Report

**Section: Top 5 Timed Foreground Events**

This is the most important section. It shows where DB time was spent:

| Event | Waits | Time(s) | % DB Time |
|-------|-------|---------|-----------|
| db file sequential read | 8,423,901 | 4,211 | 67.2% |
| CPU time | | 1,890 | 30.1% |
| db file scattered read | 23,411 | 84 | 1.3% |

Interpretation:
- **db file sequential read** dominant: index I/O. Either the execution plan is correct (and this is the expected I/O pattern) or the plan is using an index inefficiently. Cross-reference with Top SQL to find which SQL is driving the I/O.
- **CPU time** dominant with no significant waits: the code is CPU-bound — poor execution plan with excessive logical reads (buffer gets), or an inefficient PL/SQL loop
- **db file scattered read** significant: full table scan reads — check if the FTS is intentional (large table, no selective index) or a plan regression

**Section: Top SQL by Elapsed Time**

Lists the 10 SQL statements that consumed the most elapsed time. Drill into each via the SQL ID link to see the execution plan.

**Section: Top SQL by Buffer Gets**

High buffer gets = high CPU. A SQL with 50 million buffer gets per execution is almost certainly doing unnecessary logical reads due to a bad plan.

---

## Tool 3: ASH (Active Session History)

### What It Is

ASH samples active Oracle sessions every second, storing the sample in \`V$ACTIVE_SESSION_HISTORY\` (in-memory, last hour) and \`DBA_HIST_ACTIVE_SESS_HISTORY\` (written to AWR every 10 seconds, retained for the AWR retention period). Each sample captures: wait event, SQL ID, object being accessed, module/action.

### Real-Time ASH for a Running Request

\`\`\`sql
-- What is the concurrent request session doing RIGHT NOW?
SELECT ash.event, ash.sql_id, ash.current_obj#, o.object_name,
       COUNT(*) samples,
       ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) pct_time
FROM v$active_session_history ash
LEFT JOIN dba_objects o ON ash.current_obj# = o.object_id
WHERE ash.sample_time > SYSDATE - 5/1440  -- last 5 minutes
  AND ash.module LIKE '%FNDCPGSC%'        -- Concurrent Manager module
GROUP BY ash.event, ash.sql_id, ash.current_obj#, o.object_name
ORDER BY samples DESC;
\`\`\`

### Historical ASH for a Completed Request

\`\`\`sql
-- ASH for a specific time window (when the slow request ran)
SELECT event,
       sql_id,
       COUNT(*) * 10 estimated_seconds,  -- each sample = ~10 seconds in DBA_HIST
       ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) pct_time
FROM dba_hist_active_sess_history
WHERE sample_time BETWEEN TO_TIMESTAMP('2026-06-22 01:00:00', 'YYYY-MM-DD HH24:MI:SS')
                      AND TO_TIMESTAMP('2026-06-22 04:00:00', 'YYYY-MM-DD HH24:MI:SS')
  AND module = 'FNDCPGSC0001'  -- Concurrent Manager GSM agent
GROUP BY event, sql_id
ORDER BY estimated_seconds DESC
FETCH FIRST 15 ROWS ONLY;
\`\`\`

### ASH Limitation: The 1-in-10 Sampling Problem

ASH samples 1 in 10 active sessions per second. A SQL statement that executes in 50ms will not appear in ASH at all if the session was only active for that 50ms. ASH is reliable for identifying time consumers > 1 second per execution. For fast-executing SQL called millions of times in a loop, use Program Trace.

---

## Tool 4: ADDM (Automatic Database Diagnostic Monitor)

### What It Is

ADDM analyses AWR data between two snapshot pairs and generates findings ranked by DB time impact, with specific recommendations.

### Running ADDM

\`\`\`sql
@$ORACLE_HOME/rdbms/admin/addmrpt.sql
-- Select start and end snapshot IDs covering the slow request window
\`\`\`

### Reading ADDM Output

ADDM findings look like:

\`\`\`
FINDING 1: 67% impact (4,211 seconds)
--------------------------------------
SQL statements consuming significant database time were found.

RECOMMENDATION 1: SQL Tuning
  ACTION: Run SQL Tuning Advisor on SQL_ID "abc123def456gh" for
          SELECT * FROM oe_order_lines_all WHERE ...
          ESTIMATED BENEFIT: 3,200 seconds (76%)
\`\`\`

ADDM's value is automated triage — it tells you which problem is worth investigating first. When you have a 3-hour AWR report with dozens of wait events and hundreds of SQL statements, ADDM narrows focus to the 2–3 findings that account for 80% of the time.

ADDM is instance-wide. If 10 concurrent programs ran during the same AWR interval, ADDM cannot distinguish which program caused a specific finding. Cross-reference ADDM's SQL findings with trace output from the specific program you're investigating.

---

## Tool 5: OS Watcher (OSW)

### What It Is

OS Watcher is Oracle's system-level performance collector. It runs as a daemon, capturing \`vmstat\`, \`iostat\`, \`top\`, \`netstat\`, and \`ps\` output at configurable intervals (typically every 30–60 seconds). Output goes to flat files that can be parsed later.

OSW answers the question AWR cannot: was Oracle waiting for the OS to give it resources, or was Oracle itself the problem?

### Starting OSW

\`\`\`bash
# OSW is in $ORACLE_BASE/suptools/tfa/release/tfa_home/ext/oswbb/
cd $ORACLE_BASE/suptools/oswbb
./startOSW.sh 30 48
# Arguments: interval in seconds (30), hours of data to retain (48)
\`\`\`

### Key Files

| File | Content | Look For |
|------|---------|---------|
| \`oswvmstat.dat\` | CPU run queue, context switches, swap | Run queue > vCPU count = CPU saturation |
| \`oswiostat.dat\` | Per-device I/O: throughput, await, %util | %util > 80% on DB disk = I/O bottleneck |
| \`oswprvtop.dat\` | Per-process CPU usage | Oracle processes consuming > 90% CPU each |
| \`oswtop.dat\` | System-wide top output | Load average vs CPU count |

### Correlating OS Data with Oracle Wait Events

| Oracle ASH Shows | OS Watcher Shows | Diagnosis |
|-----------------|-----------------|-----------|
| db file sequential read dominant | I/O device %util < 30% | Bad execution plan — Oracle is doing excessive index I/O, but storage is not the bottleneck |
| db file sequential read dominant | I/O device %util > 80% | Storage I/O bottleneck — execution plan may be fine but storage is overwhelmed |
| CPU time dominant | Run queue consistently > vCPU count | CPU saturation — reschedule batch to off-peak, or add CPU capacity |
| CPU time dominant | Run queue < vCPU count | Oracle is using available CPU — bad SQL (too many buffer gets) rather than resource contention |
| log file sync | vmstat shows high context switches | REDO log I/O bottleneck — check redo log device %util |

---

## Putting It Together: A Diagnostic Workflow

1. **Identify the request**: get request_id, program name, actual start/end time, duration
2. **Check if currently running**: if yes → ASH immediately
3. **Pull AWR for the time window**: generate HTML report, read Top 5 Wait Events and Top SQL
4. **Run ADDM**: let Oracle summarize the findings
5. **Pull trace file**: if trace was enabled, run tkprof and identify the SQL that consumed > 50% of elapsed time
6. **Check OSW**: correlate the peak wait period with OS CPU run queue and I/O device utilization
7. **Form hypothesis**: based on all five tools together, state: "The program spent 67% of its time on db file sequential read against FND_CONCURRENT_REQUESTS index because the execution plan chose an index that returned 2 million rows"
8. **Verify and fix**: confirm hypothesis by checking the execution plan for the identified SQL, then implement the fix (index, hint, statistics update, partition)

The companion runbook steps through each tool with exact commands and a decision tree for reaching a root cause conclusion.`,
};

async function main() {
  console.log('Inserting EBS concurrent requests slow diagnosis blog post...');
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
