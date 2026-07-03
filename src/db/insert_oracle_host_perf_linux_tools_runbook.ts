import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle DB Host Performance Troubleshooting with vmstat, top, ps, mpstat, sar, and watch',
  slug: 'oracle-db-host-performance-runbook-vmstat-top-ps-mpstat-sar',
  excerpt:
    'A structured 15-minute diagnostic sequence for Oracle database host performance incidents using vmstat, top, ps, mpstat, sar, and watch. Covers triage, root cause isolation by resource type (CPU, I/O, memory, swap), historical analysis, and escalation criteria — with copy-paste commands for every step.',
  category: 'linux-admin' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-03'),
  youtubeUrl: null,
  content: `## Overview

This runbook provides a structured sequence for diagnosing Oracle database host performance problems using OS-level tools. It is designed to be executed in order, with each step building on the previous one. Total elapsed time for the triage phase is 10–15 minutes if all tools are available.

**Prerequisite:** sysstat must be installed for mpstat and sar. Install with: dnf install sysstat -y (Oracle Linux / RHEL).

**Target audience:** Oracle DBAs and Linux system administrators responding to a performance incident on a database host.

---

## Phase 1 — First Look (2 minutes)

Run these commands immediately on login. They establish the system baseline and tell you which resource category to investigate.

### Step 1.1 — System Uptime and Load Average

\`\`\`bash
uptime
\`\`\`

**Expected output:**
\`\`\`
14:32:18 up 47 days,  3:11,  2 users,  load average: 4.21, 3.87, 3.45
\`\`\`

**Interpret:**
- Load average should be below the CPU core count for a healthy system
- Get core count: nproc (or grep -c processor /proc/cpuinfo)
- Load > 2× core count = severe CPU saturation
- Load trending up (1-min > 15-min) = problem is getting worse right now
- Recent uptime (minutes or hours) = recent reboot — check OS and Oracle alert logs

### Step 1.2 — vmstat Triage (60 seconds of data)

\`\`\`bash
vmstat -t 2 30
\`\`\`

Read the first three samples, then note the pattern:

**Triage decision tree based on vmstat:**

\`\`\`
Is wa > 15?
  YES → I/O bottleneck — go to Phase 3 (I/O)
  NO →
    Is r > (2 × CPU core count)?
      YES → CPU saturation — go to Phase 2 (CPU)
      NO →
        Is swpd > 0 and (si > 0 or so > 0)?
          YES → Memory/swap pressure — go to Phase 4 (Memory)
          NO →
            Is b > 5 sustained with wa near 0?
              YES → Lock or IPC contention — check Oracle wait events
              NO → OS looks healthy — check Oracle AWR/ASH directly
\`\`\`

**Column quick reference for triage:**

| Column | Alert Threshold | Meaning When Exceeded |
|--------|---------------|----------------------|
| r | > 2× CPU count | CPU run queue saturation |
| b | > 5 sustained | I/O or lock blocking |
| swpd | > 0 and growing | Memory exhaustion |
| si / so | > 0 | Swap I/O — severe memory pressure |
| wa | > 15% | I/O wait dominating CPU cycles |
| us + sy | > 95% | CPU fully consumed |
| st | > 5% | Hypervisor stealing CPU (VMs) |

### Step 1.3 — Check Oracle Listener and Processes Are Running

\`\`\`bash
# Verify listener is up
ps -ef | grep tnslsnr | grep -v grep

# Verify Oracle background processes for each SID
ps -ef | grep ora_ | grep -v grep | awk '{print $8}' | sort | uniq

# Quick count of Oracle foreground processes (active sessions)
ps aux | grep -c "oracle\b"
\`\`\`

**Alert if:**
- No tnslsnr process: listener is down — new connections will fail
- Missing ora_lgwr, ora_dbw0, ora_pmon, ora_smon: instance may be crashed or starting up
- Foreground process count far below expected concurrent user count: sessions are failing to connect

---

## Phase 2 — CPU Investigation

Enter this phase when vmstat shows r > 2× CPU count, us + sy > 90%, or load average well above core count.

### Step 2.1 — Identify the CPU Consumer

\`\`\`bash
# Top 10 processes by CPU right now
ps aux --sort=-%cpu | head -12

# Real-time top sorted by CPU, Oracle processes only, refresh every 1 second
top -d 1 -b -n 1 | grep -E "oracle|ora_" | head -15
\`\`\`

**Interpret:**
- Single oracle process at > 80% CPU: one SQL statement or PL/SQL program consuming a full core
- Many oracle processes each at 10–30% CPU: parallel query consuming multiple cores — expected if DBA ran a parallel query intentionally
- ora_dbw0 or ora_lgwr at high CPU: checkpoint or redo pressure — check I/O simultaneously
- A non-Oracle process (Java, Python, backup agent) at > 30% CPU: competing workload — identify and schedule away from Oracle

### Step 2.2 — Per-Core Breakdown

\`\`\`bash
# Show per-CPU utilization every 2 seconds for 10 samples
mpstat -P ALL 2 10
\`\`\`

**Interpret:**
- One CPU at > 90% while others are at 20%: single-threaded bottleneck — a serial process (LGWR, PL/SQL loop, archive process) saturating one core
- All CPUs evenly at > 80%: genuine parallel CPU saturation — consider restricting parallel degrees
- High %sys on most CPUs: kernel overhead from I/O system calls or IPC (cross-RAC interconnect or DBWR I/O)

### Step 2.3 — Identify the Specific Oracle Session

Once you have the OS PID of the high-CPU process from ps, link it to an Oracle session:

\`\`\`sql
-- Link OS PID to Oracle session and current SQL
SELECT s.sid,
       s.serial#,
       s.username,
       s.status,
       s.osuser,
       s.machine,
       s.program,
       q.sql_text
FROM   v\$session s
JOIN   v\$process p ON p.addr = s.paddr
LEFT JOIN v\$sql q ON q.sql_id = s.sql_id
WHERE  p.spid = '&os_pid';
\`\`\`

Replace &os_pid with the PID from ps. If the session is executing a SQL statement, capture the sql_id and check its execution plan in V\$SQL_PLAN.

### Step 2.4 — Historical CPU with sar

\`\`\`bash
# CPU usage for the past 24 hours (today's log)
sar -u

# CPU usage for a specific date (e.g., two days ago)
sar -u -f /var/log/sa/sa01

# CPU usage during a specific window (e.g., 2 AM batch)
sar -u -s 02:00:00 -e 04:00:00 -f /var/log/sa/sa01
\`\`\`

**Use case:** The DBA reports the database was slow at 3 AM. sar shows 95% user CPU from 02:50 to 03:30. An ETL job ran during that window and consumed all available CPU — confirmed.

### Step 2.5 — Watch CPU During Remediation

If you are taking corrective action (killing a session, reducing parallel degree), keep the CPU view open:

\`\`\`bash
watch -d -n 2 'mpstat 1 2 | tail -2'
\`\`\`

The -d flag highlights values that changed between refreshes. Watch us + sy drop as the high-CPU session is terminated.

---

## Phase 3 — I/O Investigation

Enter this phase when vmstat shows wa > 15%, b > 5 sustained, or sar -d shows a device at high %util or await.

### Step 3.1 — Identify the I/O Source

\`\`\`bash
# Live I/O per device, 2-second samples, skip idle devices
iostat -xz 2 10

# With device names (if udev rules name disks)
iostat -xz -p 2 10
\`\`\`

**iostat extended column reference:**

| Column | Meaning for Oracle |
|--------|-------------------|
| r/s | Reads per second (IOPS for reads) |
| w/s | Writes per second (DBWR checkpoints, LGWR redo) |
| rkB/s | Read throughput — high during full scans or RMAN restore |
| wkB/s | Write throughput — LGWR (small sequential), DBWR (larger random) |
| r_await | Average read latency ms. Oracle target: < 20 ms for datafiles, < 5 ms for redo |
| w_await | Average write latency ms |
| aqu-sz | I/O queue depth. > 4 = device is congested |
| %util | Device utilization. Near 100% = saturated |

**Identify which Oracle file is on the saturated device:**

\`\`\`sql
-- Map device to Oracle datafile
SELECT file#, name, status
FROM   v\$datafile
WHERE  name LIKE '%<device_or_path>%';

-- Check I/O per datafile (reads and writes since startup)
SELECT df.name,
       fs.phyrds,
       fs.phywrts,
       fs.readtim / NULLIF(fs.phyrds, 0) AS avg_read_ms,
       fs.writetim / NULLIF(fs.phywrts, 0) AS avg_write_ms
FROM   v\$filestat fs
JOIN   v\$datafile df ON df.file# = fs.file#
ORDER  BY fs.phyrds + fs.phywrts DESC
FETCH FIRST 15 ROWS ONLY;
\`\`\`

### Step 3.2 — Distinguish LGWR from DBWR Pressure

LGWR and DBWR have different I/O profiles:

\`\`\`bash
# LGWR PID
ps -ef | grep ora_lgwr | grep -v grep

# DBWR PID (there may be multiple: dbw0, dbw1...)
ps -ef | grep ora_dbw | grep -v grep

# Check if these processes are in D state (blocked on I/O)
ps aux | awk '$8 ~ /^D/ && /ora_lgwr|ora_dbw/ {print $0}'
\`\`\`

LGWR in D state = redo log writes are stalling — all commits are blocked. This is the most critical I/O issue for Oracle OLTP.

\`\`\`sql
-- Confirm LGWR is the bottleneck
SELECT event, total_waits, time_waited_micro / 1e6 AS time_waited_s
FROM   v\$system_event
WHERE  event IN ('log file sync', 'log file parallel write')
ORDER  BY time_waited_micro DESC;
\`\`\`

High log file parallel write time = LGWR I/O latency. High log file sync = sessions waiting for LGWR to complete — the symptom at the user level.

### Step 3.3 — Historical I/O with sar

\`\`\`bash
# I/O per device for today
sar -d -p

# I/O during the incident window
sar -d -p -s 02:00:00 -e 04:00:00 -f /var/log/sa/sa01
\`\`\`

### Step 3.4 — Watch I/O in Real Time During Fix

\`\`\`bash
# Watch await and %util on the device under investigation
watch -d -n 2 'iostat -xz 1 2 | grep -E "Device|sdb|sdc|dm-"'
\`\`\`

---

## Phase 4 — Memory and Swap Investigation

Enter this phase when vmstat shows swpd > 0, si > 0, or so > 0, or when Oracle foreground processes are crashing with ORA-04031.

### Step 4.1 — Quantify Memory Usage

\`\`\`bash
# Total memory picture
free -m

# Detailed memory with slab, hugepages, and dirty pages
cat /proc/meminfo | grep -E 'MemTotal|MemFree|MemAvailable|SwapTotal|SwapFree|HugePages|Shmem|Dirty'
\`\`\`

**Critical for Oracle:** Check HugePages allocation. Oracle SGA should use HugePages (large pages) to avoid memory pressure from small-page overhead.

\`\`\`bash
# HugePages allocated vs in use
grep -E 'HugePages_Total|HugePages_Free|HugePages_Rsvd|Hugepagesize' /proc/meminfo
\`\`\`

If HugePages_Free is near HugePages_Total, Oracle is not using HugePages — the SGA is mapped as regular 4 KB pages, which increases TLB pressure and vulnerability to OOM eviction.

### Step 4.2 — Identify the Memory Consumer

\`\`\`bash
# Processes sorted by RSS (resident memory)
ps aux --sort=-%mem | head -15

# Total Oracle memory (sum of all oracle process RSS)
# Note: SGA is shared and counted once; do not sum all processes
ps aux | grep -v grep | grep oracle | awk '{sum += $6} END {print "Total RSS:", sum/1024, "MB"}'
\`\`\`

If a non-Oracle process (backup agent, monitoring tool, Java application) has high RSS, it is competing for the memory Oracle needs.

### Step 4.3 — Oracle SGA and PGA Sizes

\`\`\`sql
-- Current SGA allocation
SELECT name, bytes / 1024 / 1024 / 1024 AS gb FROM v\$sgainfo
WHERE  name IN ('Maximum SGA Size', 'Free SGA Memory Available')
UNION ALL
SELECT 'Total PGA Target', value / 1024 / 1024 / 1024 FROM v\$parameter WHERE name = 'pga_aggregate_target';
\`\`\`

If Total SGA + PGA Target > physical RAM, swapping is inevitable under full load.

### Step 4.4 — Historical Memory with sar

\`\`\`bash
# Memory with reclaimable detail
sar -r ALL

# Swap paging statistics
sar -W
\`\`\`

Look for pswpin/s and pswpout/s > 0 during the incident window. Any swap I/O on an Oracle host is a red flag.

### Step 4.5 — Watch Memory During Fix

\`\`\`bash
# Watch free memory and swap I/O together
watch -d -n 5 'free -m; echo "---"; vmstat 1 2 | tail -1 | awk "{print \"si:\",\$7,\"so:\",\$8}"'
\`\`\`

---

## Phase 5 — Collect Evidence for Retrospective Analysis

After the incident is resolved or stabilized, collect the historical record before log rotation overwrites it.

### Step 5.1 — Capture sar History for the Incident Window

\`\`\`bash
#!/bin/bash
# Save sar data for incident report
INCIDENT_DATE=\${1:-$(date +%Y-%m-%d)}
SAR_DAY=\${2:-$(date +%d)}
OUTPUT_DIR=/tmp/incident_\${INCIDENT_DATE}
mkdir -p \${OUTPUT_DIR}

sar -u -f /var/log/sa/sa\${SAR_DAY}  > \${OUTPUT_DIR}/cpu.txt
sar -r -f /var/log/sa/sa\${SAR_DAY}  > \${OUTPUT_DIR}/memory.txt
sar -d -p -f /var/log/sa/sa\${SAR_DAY} > \${OUTPUT_DIR}/disk.txt
sar -q -f /var/log/sa/sa\${SAR_DAY}  > \${OUTPUT_DIR}/runqueue.txt
sar -W -f /var/log/sa/sa\${SAR_DAY}  > \${OUTPUT_DIR}/swap.txt
sar -n DEV -f /var/log/sa/sa\${SAR_DAY} > \${OUTPUT_DIR}/network.txt

echo "Incident data saved to \${OUTPUT_DIR}"
ls -lh \${OUTPUT_DIR}
\`\`\`

### Step 5.2 — Capture Oracle AWR Snapshot for Same Window

\`\`\`sql
-- Create a manual AWR snapshot at the end of the incident
EXEC DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT;

-- Get snapshot IDs bracketing the incident
SELECT snap_id, begin_interval_time, end_interval_time
FROM   dba_hist_snapshot
WHERE  begin_interval_time > SYSDATE - 1
ORDER  BY snap_id;

-- Generate AWR report for the incident window
SELECT output FROM TABLE(
  DBMS_WORKLOAD_REPOSITORY.AWR_REPORT_TEXT(
    l_dbid       => (SELECT dbid FROM v\$database),
    l_inst_num   => 1,
    l_bid        => &begin_snap_id,
    l_eid        => &end_snap_id
  )
);
\`\`\`

Correlate the AWR Top 5 Wait Events against the sar data: if sar shows I/O wait spiking at 14:10, the AWR snapshot covering that window should show db file sequential read or log file parallel write at the top of the wait event list.

---

## Phase 6 — Ongoing Monitoring Setup

After resolving the incident, set up lightweight continuous monitoring to catch the next problem before users report it.

### Step 6.1 — Automated sar Alerting Script

\`\`\`bash
#!/bin/bash
# /opt/oracle/scripts/os_health_check.sh
# Run every 5 minutes via cron: */5 * * * * /opt/oracle/scripts/os_health_check.sh

LOG=/var/log/oracle_os_health.log
ALERT_FILE=/tmp/oracle_os_alert.txt
rm -f \${ALERT_FILE}

# CPU iowait check
IOWAIT=\$(vmstat 1 3 | tail -1 | awk '{print \$16}')
if [ "\${IOWAIT%.*}" -gt 20 ]; then
  echo "ALERT CPU: iowait=\${IOWAIT}% exceeds 20%" >> \${ALERT_FILE}
fi

# Run queue check (alert if > 2× CPU count)
CPU_COUNT=\$(nproc)
RUNQ=\$(vmstat 1 2 | tail -1 | awk '{print \$1}')
THRESHOLD=\$((CPU_COUNT * 2))
if [ "\${RUNQ}" -gt "\${THRESHOLD}" ]; then
  echo "ALERT CPU: run queue=\${RUNQ} exceeds threshold \${THRESHOLD} (CPUs: \${CPU_COUNT})" >> \${ALERT_FILE}
fi

# Swap check
SWPD=\$(vmstat 1 2 | tail -1 | awk '{print \$3}')
SI=\$(vmstat 1 2 | tail -1 | awk '{print \$7}')
if [ "\${SWPD}" -gt 0 ] && [ "\${SI%.*}" -gt 0 ]; then
  echo "ALERT MEM: swap in active (swpd=\${SWPD} KB, si=\${SI} KB/s)" >> \${ALERT_FILE}
fi

# D-state process check
DSTATE=\$(ps aux | awk '\$8 ~ /^D/ {count++} END {print count+0}')
if [ "\${DSTATE}" -gt 5 ]; then
  echo "ALERT IO: \${DSTATE} processes in D (uninterruptible) state" >> \${ALERT_FILE}
fi

# Oracle listener check
if ! ps -ef | grep -v grep | grep -q tnslsnr; then
  echo "ALERT ORA: Oracle listener not running" >> \${ALERT_FILE}
fi

# Log and send alert if triggered
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
if [ -s \${ALERT_FILE} ]; then
  echo "=== \${TIMESTAMP} ===" >> \${LOG}
  cat \${ALERT_FILE} >> \${LOG}
  # Send email (requires mailx or sendmail)
  mail -s "Oracle Host Alert: \$(hostname)" dba-oncall@yourcompany.com < \${ALERT_FILE}
fi
\`\`\`

### Step 6.2 — Watch Dashboard for Active Incidents

Run this during an active incident to monitor all key metrics simultaneously:

\`\`\`bash
watch -d -n 3 '
printf "=== %s ===\n" "$(date)"
printf "\n--- Load & CPU ---\n"
uptime
vmstat 1 2 | tail -1 | awk "{printf \"r=%s b=%s swpd=%s si=%s so=%s us=%s%% sy=%s%% wa=%s%%\n\",\$1,\$2,\$3,\$7,\$8,\$13,\$14,\$16}"
printf "\n--- D-state ---\n"
ps aux | awk "$8 ~ /^D/ {print \$1,\$8,\$11}" | head -5
printf "\n--- Top Oracle CPU ---\n"
ps aux --sort=-%cpu | awk "/oracle/ && NR>0 {printf \"%s %s%% %s\n\",\$2,\$3,\$11}" | grep -v grep | head -5
printf "\n--- Memory ---\n"
free -m | grep -E "Mem|Swap"
'
\`\`\`

### Step 6.3 — Verify sysstat Is Collecting Continuously

\`\`\`bash
# Confirm sadc is running and collecting
systemctl status sysstat

# Confirm data files are being written
ls -lh /var/log/sa/sa$(date +%d)

# Check last collection timestamp
sar -u | tail -5
\`\`\`

If sysstat is not installed or the service is stopped, you lose the ability to do post-incident historical analysis. Install and enable it immediately on all Oracle database hosts.

---

## Escalation Criteria

Escalate to storage or infrastructure teams if:

- sar -d shows await > 50 ms sustained on datafile devices AND the wait is not caused by an Oracle-initiated large scan
- vmstat shows si or so > 0 sustained AND Oracle SGA memory has not changed (indicates OS OOM pressure from another source)
- mpstat shows all CPUs at > 90% user AND the high-CPU SQL has been killed but CPU has not dropped (indicates another process took over)
- ps shows ora_lgwr or ora_dbw in D state for more than 30 seconds (storage layer not responding)

Escalate to Oracle Support if:

- All OS metrics are normal (wa < 5%, r < CPU count, no swap) but Oracle reports high wait times in V\$SYSTEM_EVENT — the bottleneck is inside Oracle (latch, library cache, buffer cache)
- Oracle alert log shows ORA-00600 or ORA-07445 in the same window as the performance degradation
- The instance has restarted unexpectedly (short uptime, ora_pmon not matching expected start time)
`,
};

async function main() {
  await db.insert(posts).values(post);
  console.log('Inserted:', post.slug);
}

main().catch(console.error);
