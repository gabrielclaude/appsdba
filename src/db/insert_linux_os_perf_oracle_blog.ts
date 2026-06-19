import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Linux OS Performance Analysis for Oracle DBA: Host Monitoring and Scripting',
  slug: 'linux-os-performance-analysis-oracle-dba',
  excerpt:
    'A practical guide for Oracle DBAs who need to own the Linux layer: reading CPU, memory, I/O, and network metrics from the OS perspective, correlating them with Oracle wait events, and running a scheduled monitoring stack via crontab to catch host-level bottlenecks before they become database incidents.',
  category: 'linux-admin' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-19'),
  youtubeUrl: null,
  content: `Oracle Database performance problems are frequently blamed on SQL or database configuration when the real bottleneck is the Linux host. CPU steal time, memory pressure forcing the kernel into direct reclaim, I/O scheduler queue depth limits, and network retransmits can all degrade database throughput without producing a single Oracle wait event that points at the OS. The DBA who only looks inside the database will miss these. This post covers the Linux tools, metrics, and monitoring scripts that give an Oracle DBA full visibility into the host layer.

---

## The DBA's View of the Linux Host

An Oracle Database instance is a set of Linux processes and threads competing for five shared resources: CPU time, memory pages, I/O bandwidth and IOPS, network bandwidth, and inter-process communication (semaphores and shared memory segments). Each of those resources has its own set of Linux metrics, tools, and tuning knobs. The goal of OS performance analysis is not to replace AWR — it is to answer the question AWR cannot: what was the host doing when the database was slow?

The monitoring stack described in this post reads metrics from five sources:

| Source | What it measures |
|--------|-----------------|
| \`/proc/stat\` | CPU time per mode (user, system, iowait, steal, idle) |
| \`/proc/meminfo\` | Memory page allocation, swap activity, huge page usage |
| \`/proc/diskstats\` | Per-device I/O: IOPS, throughput, queue depth, await |
| \`/proc/net/dev\` | Per-interface network bytes, packets, errors, drops |
| \`/proc/<pid>/stat\` | Per-process CPU and memory for Oracle processes |

All of these are sampled directly from the kernel — no external agents, no open ports.

---

## CPU Analysis

### Reading CPU Metrics

\`\`\`bash
# One-second interval, 5 samples — shows real-time CPU split
mpstat -P ALL 1 5

# Cumulative since boot — useful for a quick health check
cat /proc/stat
\`\`\`

The fields that matter most for Oracle hosts:

| Field | Concern threshold | Oracle implication |
|-------|------------------|--------------------|
| \`%iowait\` | > 10% sustained | Storage is the bottleneck; check \`iostat\` |
| \`%steal\` | > 3% | Hypervisor is overcommitting CPU; escalate to infrastructure |
| \`%sys\` | > 30% of total CPU | Kernel work dominates; look for context switch storms |
| \`%user\` | 90%+ on all cores | CPU is saturated; Oracle is CPU-bound |
| \`%idle\` | 0% | System is fully saturated |

### Context Switches and Run Queue

\`\`\`bash
# vmstat: r = run queue, b = blocked on I/O, cs = context switches/sec
vmstat 1 10

# sar: run queue length and load average history
sar -q 1 10
\`\`\`

For an Oracle OLTP system, run queue length (\`r\`) should stay below 2× the number of physical CPU cores. A run queue of 60 on a 16-core host means processes are waiting an average of nearly 4 CPU turns before executing — this directly increases Oracle foreground wait times even when no Oracle wait event shows CPU contention.

### Per-Process CPU

\`\`\`bash
# Top Oracle processes by CPU — useful during high-load incidents
ps -eo pid,ppid,comm,%cpu,%mem,vsz,rss --sort=-%cpu | head -20

# Attach to a specific Oracle process and watch its CPU
pidstat -p <oracle_pid> 1 10
\`\`\`

Oracle shadow processes (named \`oracle<SID>\`) handle one session each. If a single process is pegging a core, find its session in the database:

\`\`\`sql
-- Map OS PID to Oracle session
SELECT s.sid, s.serial#, s.username, s.status,
       s.sql_id, s.event, s.seconds_in_wait,
       p.spid AS os_pid
FROM   v$session s
JOIN   v$process p ON p.addr = s.paddr
WHERE  p.spid = '&os_pid';
\`\`\`

---

## Memory Analysis

### Memory Page Accounting

\`\`\`bash
# Full memory breakdown
cat /proc/meminfo

# Key fields to watch:
# MemAvailable  — actual free memory including reclaimable cache
# SwapUsed      — any non-zero value is a concern on a DB host
# HugePages_Total / HugePages_Free — huge page inventory
# DirectMap2M / DirectMap1G — TLB coverage
# Dirty / Writeback — kernel dirty page queue depth
\`\`\`

### SGA Residency

The Oracle SGA must stay in physical RAM. If the kernel starts paging SGA pages to swap, every Oracle read from the buffer cache becomes a disk I/O, destroying performance silently.

\`\`\`bash
# Check if any Oracle SGA is swapped out
ORACLE_PID=$(pgrep -f "ora_pmon_\${ORACLE_SID}" | head -1)
cat /proc/\${ORACLE_PID}/status | grep -E 'VmSwap|VmRSS|VmPeak|VmSize'

# Check current swap usage
swapon --show
free -h

# Scan all oracle processes for swap usage
for pid in $(pgrep -f "oracle\${ORACLE_SID}"); do
  swap=$(awk '/VmSwap/{print $2}' /proc/\${pid}/status 2>/dev/null)
  [ "\${swap}" != "0" ] && echo "PID \${pid} has \${swap} kB swapped"
done
\`\`\`

### HugePages

\`\`\`bash
# HugePages status
grep -E 'HugePages|Hugepagesize' /proc/meminfo

# Calculate required HugePages for current SGA
sqlplus -s / as sysdba <<'EOF'
SELECT ROUND(SUM(bytes)/1024/1024/1024, 2) AS sga_gb,
       ROUND(SUM(bytes)/(2*1024*1024)) AS hugepages_2mb_needed
FROM   v$sgainfo
WHERE  name = 'Maximum SGA Size';
EOF
\`\`\`

If \`HugePages_Free\` is near zero while \`HugePages_Total\` is large, the SGA is consuming all available huge pages — which is correct. If \`HugePages_Total\` is 0, the SGA is backed by 4K pages and TLB pressure is likely impacting performance on large-memory hosts.

---

## I/O Analysis

I/O is the most common host-layer bottleneck for Oracle databases. The goal is to distinguish between the storage tier being saturated (throughput or IOPS limit reached) and the I/O scheduler introducing artificial latency.

### iostat — The Primary I/O Tool

\`\`\`bash
# Per-device I/O stats, 2-second interval
iostat -xdm 2 10

# Key columns:
# r/s, w/s    — read and write IOPS
# rMB/s, wMB/s — read and write throughput
# await       — average I/O latency (ms) including queue time
# svctm       — average service time (ms) at the device
# %util       — percentage of time the device was busy
# avgqu-sz    — average I/O queue depth
\`\`\`

**Oracle I/O latency thresholds:**

| Storage type | Acceptable await | Concern |
|-------------|-----------------|---------|
| NVMe SSD | < 0.5 ms | > 2 ms |
| SAN SSD | < 2 ms | > 5 ms |
| SAN HDD | < 10 ms | > 20 ms |
| NFS | < 5 ms | > 15 ms |

### Correlating OS I/O with Oracle Waits

When \`await\` spikes, find the Oracle sessions waiting on I/O:

\`\`\`sql
-- Sessions currently waiting on I/O
SELECT s.sid, s.username, s.event, s.wait_class,
       s.seconds_in_wait, s.p1, s.p2, s.p3,
       f.file# AS datafile_num, f.name AS datafile_name
FROM   v$session s
JOIN   v$datafile f ON f.file# = s.p1
WHERE  s.wait_class = 'User I/O'
  AND  s.state = 'WAITING'
ORDER  BY s.seconds_in_wait DESC;
\`\`\`

### I/O Scheduler

\`\`\`bash
# Check current I/O scheduler for each block device
for dev in $(lsblk -dno NAME | grep -v loop); do
  sched=$(cat /sys/block/\${dev}/queue/scheduler 2>/dev/null)
  echo "\${dev}: \${sched}"
done

# Oracle recommendation: none (noop) for SSDs/NVMe, deadline for HDDs
# Set for current boot:
echo none > /sys/block/sda/queue/scheduler

# Set permanently (add to /etc/rc.local or udev rule):
echo 'ACTION=="add|change", KERNEL=="sd*", ATTR{queue/rotational}=="0", ATTR{queue/scheduler}="none"' \
  > /etc/udev/rules.d/60-oracle-io-scheduler.rules
\`\`\`

---

## Network Analysis

### Interface Statistics

\`\`\`bash
# Per-interface statistics
ip -s link show

# Watch network traffic in real time
sar -n DEV 1 10

# TCP retransmit rate — non-zero is a concern on a DB host
ss -s
netstat -s | grep -i retran

# Active connections to Oracle listener port
ss -tnp | grep 1521
\`\`\`

### RAC Interconnect

For RAC environments, the private interconnect is critical:

\`\`\`bash
# Identify the private interconnect interface (typically bond0, eth1, or ib0)
# Watch for errors and drops on that interface
watch -n 2 'ip -s link show bond0'

# Check for packet loss on the private network
ping -c 100 -i 0.01 <node2_private_ip> | tail -3
\`\`\`

From the database, correlate with interconnect waits:

\`\`\`sql
-- RAC interconnect wait events
SELECT event, total_waits, time_waited_micro/1e6 AS time_waited_s
FROM   v$system_event
WHERE  event IN ('gc cr request','gc buffer busy acquire',
                  'gc current request','gcs log flush sync')
ORDER  BY time_waited_micro DESC;
\`\`\`

---

## The Monitoring Stack

The following scripts form a complete scheduled monitoring stack. They write to flat log files and send email alerts when thresholds are crossed. All are designed to run as the \`oracle\` or \`root\` OS user from crontab.

### Script 1 — CPU and Load Monitor

\`\`\`bash
#!/bin/bash
# /opt/oracle/scripts/monitor_cpu.sh
# Monitors CPU utilisation, load average, and context switches.
# Alerts when iowait or steal exceeds thresholds.

ORACLE_SID=\${ORACLE_SID:-PROD}
ALERT_EMAIL=dba-alerts@example.com
LOG_DIR=/var/log/oracle-monitor
CPU_IOWAIT_WARN=10
CPU_IOWAIT_CRIT=25
CPU_STEAL_WARN=3
LOAD_WARN_FACTOR=2   # Load avg warn at N * CPU count

mkdir -p "\${LOG_DIR}"
LOG="\${LOG_DIR}/cpu_$(date +%Y%m%d).log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
CPU_COUNT=$(nproc)
REPORT=""
ALERT=0

log()   { echo "[\${TIMESTAMP}] $*" | tee -a "\${LOG}"; }
alert() { ALERT=1; REPORT="\${REPORT}\nALERT: $*"; log "ALERT: $*"; }
info()  { log "INFO:  $*"; }

# Read CPU stats from /proc/stat (two samples, 5-second delta)
read_cpu() {
  local s1 s2
  s1=$(awk '/^cpu /{print $2,$3,$4,$5,$6,$7,$8,$9}' /proc/stat)
  sleep 5
  s2=$(awk '/^cpu /{print $2,$3,$4,$5,$6,$7,$8,$9}' /proc/stat)

  local u1 n1 s1_ i1 w1 ir1 so1 st1
  local u2 n2 s2_ i2 w2 ir2 so2 st2
  read u1 n1 s1_ i1 w1 ir1 so1 st1 <<< "\${s1}"
  read u2 n2 s2_ i2 w2 ir2 so2 st2 <<< "\${s2}"

  local total1=$((u1+n1+s1_+i1+w1+ir1+so1+st1))
  local total2=$((u2+n2+s2_+i2+w2+ir2+so2+st2))
  local delta=$((total2-total1))

  IOWAIT=$(( (w2-w1) * 100 / delta ))
  STEAL=$(( (st2-st1) * 100 / delta ))
  IDLE=$(( (i2-i1) * 100 / delta ))
  SYSCPU=$(( (s2_-s1_) * 100 / delta ))
  USERCPU=$(( (u2-u1) * 100 / delta ))
  TOTAL_UTIL=$(( 100 - IDLE ))
}

read_cpu

LOAD1=$(awk '{print $1}' /proc/loadavg)
LOAD_INT=\${LOAD1%.*}
LOAD_WARN=$((CPU_COUNT * LOAD_WARN_FACTOR))

info "CPU: user=\${USERCPU}% sys=\${SYSCPU}% iowait=\${IOWAIT}% steal=\${STEAL}% idle=\${IDLE}% total_util=\${TOTAL_UTIL}%"
info "Load: \${LOAD1} (\${CPU_COUNT} CPUs, warn at \${LOAD_WARN})"

[ "\${IOWAIT}" -ge "\${CPU_IOWAIT_CRIT}" ] && alert "iowait=\${IOWAIT}% (CRITICAL threshold=\${CPU_IOWAIT_CRIT}%)"
[ "\${IOWAIT}" -ge "\${CPU_IOWAIT_WARN}" ] && [ "\${IOWAIT}" -lt "\${CPU_IOWAIT_CRIT}" ] && alert "iowait=\${IOWAIT}% (WARN threshold=\${CPU_IOWAIT_WARN}%)"
[ "\${STEAL}" -ge "\${CPU_STEAL_WARN}" ] && alert "cpu_steal=\${STEAL}% — hypervisor CPU overcommit detected"
[ "\${LOAD_INT}" -ge "\${LOAD_WARN}" ] && alert "load_avg_1m=\${LOAD1} exceeds \${LOAD_WARN} (\${LOAD_WARN_FACTOR}x CPU count)"

if [ "\${ALERT}" -eq 1 ]; then
  printf "Oracle Host CPU Alert\nHost: $(hostname)\nSID: \${ORACLE_SID}\nTime: \${TIMESTAMP}\n%b\n" "\${REPORT}" \
    | mail -s "CPU Alert: $(hostname) [\${ORACLE_SID}]" "\${ALERT_EMAIL}"
fi
\`\`\`

### Script 2 — Memory and Swap Monitor

\`\`\`bash
#!/bin/bash
# /opt/oracle/scripts/monitor_memory.sh
# Monitors memory availability, swap usage, and HugePages inventory.

ORACLE_SID=\${ORACLE_SID:-PROD}
ALERT_EMAIL=dba-alerts@example.com
LOG_DIR=/var/log/oracle-monitor
SWAP_WARN_MB=512
MEM_AVAIL_WARN_PCT=15   # Alert if MemAvailable < 15% of MemTotal
HP_FREE_WARN=100        # Alert if HugePages_Free < 100

mkdir -p "\${LOG_DIR}"
LOG="\${LOG_DIR}/memory_$(date +%Y%m%d).log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
REPORT=""
ALERT=0

log()   { echo "[\${TIMESTAMP}] $*" | tee -a "\${LOG}"; }
alert() { ALERT=1; REPORT="\${REPORT}\nALERT: $*"; log "ALERT: $*"; }
info()  { log "INFO:  $*"; }

meminfo() { awk -v key="$1" '$1==key":"{print $2}' /proc/meminfo; }

MEM_TOTAL=$(meminfo MemTotal)
MEM_AVAIL=$(meminfo MemAvailable)
SWAP_TOTAL=$(meminfo SwapTotal)
SWAP_FREE=$(meminfo SwapFree)
HP_TOTAL=$(meminfo HugePages_Total)
HP_FREE=$(meminfo HugePages_Free)
HP_SIZE=$(meminfo Hugepagesize)
DIRTY=$(meminfo Dirty)

SWAP_USED=$(( (SWAP_TOTAL - SWAP_FREE) / 1024 ))
MEM_AVAIL_PCT=$(( MEM_AVAIL * 100 / MEM_TOTAL ))
HP_USED=$(( HP_TOTAL - HP_FREE ))

info "Memory: total=$((MEM_TOTAL/1024))MB avail=$((MEM_AVAIL/1024))MB avail_pct=\${MEM_AVAIL_PCT}%"
info "Swap: total=$((SWAP_TOTAL/1024))MB used=\${SWAP_USED}MB"
info "HugePages: total=\${HP_TOTAL} used=\${HP_USED} free=\${HP_FREE} size=$((HP_SIZE/1024))MB"
info "Dirty pages: $((DIRTY/1024))MB"

[ "\${SWAP_USED}" -ge "\${SWAP_WARN_MB}" ] && alert "Swap used=\${SWAP_USED}MB — Oracle SGA may be paging"
[ "\${MEM_AVAIL_PCT}" -lt "\${MEM_AVAIL_WARN_PCT}" ] && alert "MemAvailable=\${MEM_AVAIL_PCT}% of total — kernel near direct reclaim"
[ "\${HP_TOTAL}" -gt 0 ] && [ "\${HP_FREE}" -lt "\${HP_FREE_WARN}" ] && alert "HugePages_Free=\${HP_FREE} (warn threshold=\${HP_FREE_WARN}) — huge page pool nearly exhausted"

# Check Oracle process swap individually
PMON_PID=$(pgrep -f "ora_pmon_\${ORACLE_SID}" | head -1)
if [ -n "\${PMON_PID}" ]; then
  ORA_SWAP=0
  for pid in $(pgrep -f "oracle\${ORACLE_SID}" 2>/dev/null); do
    s=$(awk '/VmSwap/{print $2}' /proc/\${pid}/status 2>/dev/null || echo 0)
    ORA_SWAP=$((ORA_SWAP + s))
  done
  ORA_SWAP_MB=$((ORA_SWAP/1024))
  info "Oracle process swap total: \${ORA_SWAP_MB}MB"
  [ "\${ORA_SWAP_MB}" -gt 0 ] && alert "Oracle processes have \${ORA_SWAP_MB}MB swapped out"
else
  info "Oracle instance \${ORACLE_SID} not running — skipping process swap check"
fi

if [ "\${ALERT}" -eq 1 ]; then
  printf "Oracle Host Memory Alert\nHost: $(hostname)\nSID: \${ORACLE_SID}\nTime: \${TIMESTAMP}\n%b\n" "\${REPORT}" \
    | mail -s "Memory Alert: $(hostname) [\${ORACLE_SID}]" "\${ALERT_EMAIL}"
fi
\`\`\`

### Script 3 — I/O Performance Monitor

\`\`\`bash
#!/bin/bash
# /opt/oracle/scripts/monitor_io.sh
# Monitors per-device I/O latency, throughput, and utilisation.
# Computes delta from /proc/diskstats over a 10-second window.

ORACLE_SID=\${ORACLE_SID:-PROD}
ALERT_EMAIL=dba-alerts@example.com
LOG_DIR=/var/log/oracle-monitor
AWAIT_WARN_MS=10       # Alert if average I/O await > 10ms
AWAIT_CRIT_MS=30       # Critical if > 30ms
UTIL_WARN_PCT=85       # Alert if device utilisation > 85%
SAMPLE_SEC=10

mkdir -p "\${LOG_DIR}"
LOG="\${LOG_DIR}/io_$(date +%Y%m%d).log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
REPORT=""
ALERT=0

log()   { echo "[\${TIMESTAMP}] $*" | tee -a "\${LOG}"; }
alert() { ALERT=1; REPORT="\${REPORT}\nALERT: $*"; log "ALERT: $*"; }
info()  { log "INFO:  $*"; }

# Parse /proc/diskstats: fields 3=reads 4=read_merges 5=read_sectors 6=read_ms
#                         7=writes 8=write_merges 9=write_sectors 10=write_ms
#                         11=io_in_progress 12=io_ms 13=weighted_io_ms
snapshot() {
  awk '{if(NF>=14) print $3,$4,$6,$7,$9,$11,$13}' /proc/diskstats
}

S1=$(snapshot); sleep \${SAMPLE_SEC}; S2=$(snapshot)

while IFS= read -r line2; do
  DEV=$(echo "\${line2}" | awk '{print $1}')
  # Skip partitions and loop devices
  echo "\${DEV}" | grep -qE '^(sd[a-z]+|nvme[0-9]+n[0-9]+|xvd[a-z]+|vd[a-z]+|dm-[0-9]+)$' || continue

  line1=$(echo "\${S1}" | awk -v d="\${DEV}" '$1==d{print}')
  [ -z "\${line1}" ] && continue

  r1=$(echo "\${line1}" | awk '{print $2}'); r2=$(echo "\${line2}" | awk '{print $2}')
  rs1=$(echo "\${line1}" | awk '{print $3}'); rs2=$(echo "\${line2}" | awk '{print $3}')
  w1=$(echo "\${line1}" | awk '{print $4}'); w2=$(echo "\${line2}" | awk '{print $4}')
  ws1=$(echo "\${line1}" | awk '{print $5}'); ws2=$(echo "\${line2}" | awk '{print $5}')
  io_ms1=$(echo "\${line1}" | awk '{print $6}'); io_ms2=$(echo "\${line2}" | awk '{print $6}')
  wio_ms1=$(echo "\${line1}" | awk '{print $7}'); wio_ms2=$(echo "\${line2}" | awk '{print $7}')

  READS=$(( r2 - r1 ))
  WRITES=$(( w2 - w1 ))
  READ_MB=$(( (rs2 - rs1) * 512 / 1024 / 1024 ))
  WRITE_MB=$(( (ws2 - ws1) * 512 / 1024 / 1024 ))
  IO_MS=$((io_ms2 - io_ms1))
  WIO_MS=$((wio_ms2 - wio_ms1))
  TOTAL_IOS=$((READS + WRITES))

  UTIL_PCT=0
  AWAIT_MS=0
  [ "\${IO_MS}" -gt 0 ] && UTIL_PCT=$(( IO_MS * 100 / (SAMPLE_SEC * 1000) ))
  [ "\${TOTAL_IOS}" -gt 0 ] && AWAIT_MS=$(( WIO_MS / TOTAL_IOS ))

  RIOPS=$(( READS / SAMPLE_SEC ))
  WIOPS=$(( WRITES / SAMPLE_SEC ))
  READ_MBS=$(( READ_MB / SAMPLE_SEC ))
  WRITE_MBS=$(( WRITE_MB / SAMPLE_SEC ))

  info "IO [\${DEV}]: r=\${RIOPS} w=\${WIOPS} IOPS | r=\${READ_MBS} w=\${WRITE_MBS} MB/s | await=\${AWAIT_MS}ms | util=\${UTIL_PCT}%"

  [ "\${AWAIT_MS}" -ge "\${AWAIT_CRIT_MS}" ] && alert "IO [\${DEV}]: await=\${AWAIT_MS}ms CRITICAL (threshold=\${AWAIT_CRIT_MS}ms)"
  [ "\${AWAIT_MS}" -ge "\${AWAIT_WARN_MS}" ] && [ "\${AWAIT_MS}" -lt "\${AWAIT_CRIT_MS}" ] && alert "IO [\${DEV}]: await=\${AWAIT_MS}ms WARN (threshold=\${AWAIT_WARN_MS}ms)"
  [ "\${UTIL_PCT}" -ge "\${UTIL_WARN_PCT}" ] && alert "IO [\${DEV}]: utilisation=\${UTIL_PCT}% (threshold=\${UTIL_WARN_PCT}%)"

done <<< "\${S2}"

if [ "\${ALERT}" -eq 1 ]; then
  printf "Oracle Host I/O Alert\nHost: $(hostname)\nSID: \${ORACLE_SID}\nTime: \${TIMESTAMP}\n%b\n" "\${REPORT}" \
    | mail -s "IO Alert: $(hostname) [\${ORACLE_SID}]" "\${ALERT_EMAIL}"
fi
\`\`\`

### Script 4 — Oracle Process and Instance Health

\`\`\`bash
#!/bin/bash
# /opt/oracle/scripts/monitor_oracle_procs.sh
# Checks that critical Oracle background processes are alive and
# reports the top Oracle sessions by CPU and memory from the OS side.

ORACLE_SID=\${ORACLE_SID:-PROD}
ORACLE_HOME=\${ORACLE_HOME:-/u01/app/oracle/product/19c/dbhome_1}
ALERT_EMAIL=dba-alerts@example.com
LOG_DIR=/var/log/oracle-monitor
REQUIRED_PROCS="pmon smon lgwr dbw0 ckpt mmon reco"

mkdir -p "\${LOG_DIR}"
LOG="\${LOG_DIR}/oracle_procs_$(date +%Y%m%d).log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
REPORT=""
ALERT=0

log()   { echo "[\${TIMESTAMP}] $*" | tee -a "\${LOG}"; }
alert() { ALERT=1; REPORT="\${REPORT}\nALERT: $*"; log "ALERT: $*"; }
info()  { log "INFO:  $*"; }

for proc in \${REQUIRED_PROCS}; do
  pgrep -f "ora_\${proc}_\${ORACLE_SID}" > /dev/null 2>&1 \
    && info "RUNNING: ora_\${proc}_\${ORACLE_SID}" \
    || alert "MISSING background process: ora_\${proc}_\${ORACLE_SID}"
done

# Top Oracle processes by CPU
info "--- Top Oracle processes by CPU ---"
ps -eo pid,comm,%cpu,%mem,rsz --sort=-%cpu \
  | grep "oracle\${ORACLE_SID}" | head -10 \
  | while read pid comm cpu mem rsz; do
      info "  PID=\${pid} CPU=\${cpu}% MEM=\${mem}% RSS=$((rsz/1024))MB"
    done

# Alert file count
ALERT_FILES=$(find "\${ORACLE_BASE:-/u01/app/oracle}/diag" -name "*.trc" -newer /proc/1/cmdline 2>/dev/null | wc -l)
[ "\${ALERT_FILES}" -gt 5 ] && alert "\${ALERT_FILES} new trace files in ADR — check for ORA- errors"

if [ "\${ALERT}" -eq 1 ]; then
  printf "Oracle Process Alert\nHost: $(hostname)\nSID: \${ORACLE_SID}\nTime: \${TIMESTAMP}\n%b\n" "\${REPORT}" \
    | mail -s "Oracle Process Alert: $(hostname) [\${ORACLE_SID}]" "\${ALERT_EMAIL}"
fi
\`\`\`

### Script 5 — Hourly Performance Snapshot

\`\`\`bash
#!/bin/bash
# /opt/oracle/scripts/perf_snapshot.sh
# Writes a compact performance snapshot to a daily log file.
# Designed for post-incident analysis — gives a 24-hour picture of OS load.

ORACLE_SID=\${ORACLE_SID:-PROD}
LOG_DIR=/var/log/oracle-monitor/snapshots
mkdir -p "\${LOG_DIR}"
LOG="\${LOG_DIR}/perf_$(date +%Y%m%d).log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# CPU
read USER SYS IDLE IOWAIT STEAL <<< $(
  awk '/^cpu /{u=$2;n=$3;s=$4;i=$5;w=$6;ir=$7;so=$8;st=$9;
       tot=u+n+s+i+w+ir+so+st;
       printf "%d %d %d %d %d\n",(u+n)*100/tot,s*100/tot,i*100/tot,w*100/tot,st*100/tot}' \
  /proc/stat)

# Memory
MEM_TOTAL=$(awk '/MemTotal/{print $2}' /proc/meminfo)
MEM_AVAIL=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
SWAP_USED=$(awk '/SwapTotal/{t=$2} /SwapFree/{f=$2} END{print (t-f)/1024}' /proc/meminfo)

# Load
LOAD=$(awk '{print $1,$2,$3}' /proc/loadavg)

# Disk (first non-loop block device)
DEV=$(lsblk -dno NAME | grep -E '^(sd|nvme|xvd|vd)' | head -1)
DISK_STAT=""
if [ -n "\${DEV}" ]; then
  DISK_STAT=$(awk -v d="\${DEV}" '$4==d{printf "riops=%d wiops=%d util_raw=%d",\$6,$10,$13}' \
    /proc/diskstats 2>/dev/null || echo "n/a")
fi

echo "\${TIMESTAMP}|cpu_user=\${USER}%|cpu_sys=\${SYS}%|cpu_iowait=\${IOWAIT}%|cpu_steal=\${STEAL}%|cpu_idle=\${IDLE}%|load=\${LOAD// /,}|mem_avail_mb=$((MEM_AVAIL/1024))|mem_total_mb=$((MEM_TOTAL/1024))|swap_used_mb=\${SWAP_USED%.*}|\${DISK_STAT}" >> "\${LOG}"
\`\`\`

---

## Crontab Schedule

Install all scripts as the \`oracle\` OS user. The perf snapshot runs every 15 minutes to build a sub-hourly baseline; the heavier checks run every 5 minutes during business hours and every 10 minutes overnight.

\`\`\`
# Oracle DBA Host Monitoring — add to oracle user crontab
# Edit with: crontab -e (as oracle user)

ORACLE_SID=PROD
ORACLE_HOME=/u01/app/oracle/product/19c/dbhome_1
ORACLE_BASE=/u01/app/oracle
MAILTO=""

# CPU monitor — every 5 min during business hours (7am–8pm), every 10 min overnight
*/5  7-20 * * 1-5  /opt/oracle/scripts/monitor_cpu.sh    >> /var/log/oracle-monitor/cron.log 2>&1
*/10 0-6  * * *    /opt/oracle/scripts/monitor_cpu.sh    >> /var/log/oracle-monitor/cron.log 2>&1
*/10 21-23 * * *   /opt/oracle/scripts/monitor_cpu.sh    >> /var/log/oracle-monitor/cron.log 2>&1

# Memory monitor — every 5 min
*/5 * * * *  /opt/oracle/scripts/monitor_memory.sh       >> /var/log/oracle-monitor/cron.log 2>&1

# I/O monitor — every 5 min during business hours, every 10 min overnight
*/5  7-20 * * 1-5  /opt/oracle/scripts/monitor_io.sh     >> /var/log/oracle-monitor/cron.log 2>&1
*/10 0-6  * * *    /opt/oracle/scripts/monitor_io.sh     >> /var/log/oracle-monitor/cron.log 2>&1
*/10 21-23 * * *   /opt/oracle/scripts/monitor_io.sh     >> /var/log/oracle-monitor/cron.log 2>&1

# Oracle process health — every 3 minutes
*/3 * * * *  /opt/oracle/scripts/monitor_oracle_procs.sh >> /var/log/oracle-monitor/cron.log 2>&1

# Performance snapshot — every 15 minutes, 24 hours
*/15 * * * *  /opt/oracle/scripts/perf_snapshot.sh       >> /var/log/oracle-monitor/cron.log 2>&1

# Log rotation: keep 30 days of daily logs, compress after 7 days
0 1 * * *  find /var/log/oracle-monitor -name "*.log" -mtime +30 -delete
0 1 * * *  find /var/log/oracle-monitor -name "*.log" -mtime +7 ! -name "*.gz" -exec gzip {} \\;

# Weekly summary — every Sunday at 6 AM
0 6 * * 0  awk -F'|' 'BEGIN{max_iow=0; max_swap=0} \
  {for(i=1;i<=NF;i++){if($i~/cpu_iowait/){split($i,a,"=");gsub(/%/,"",a[2]);if(a[2]+0>max_iow+0)max_iow=a[2];} \
   if($i~/swap_used/){split($i,a,"=");if(a[2]+0>max_swap+0)max_swap=a[2];}}} \
  END{print "Week peak iowait="max_iow"% peak_swap_mb="max_swap}' \
  /var/log/oracle-monitor/snapshots/perf_$(date +%Y%m%d).log \
  | mail -s "Weekly OS Summary: $(hostname)" dba-alerts@example.com
\`\`\`

---

## Reading the Snapshot Logs

The perf_snapshot log is a pipe-delimited, timestamp-keyed record that can be grepped and awk'd for instant trend analysis:

\`\`\`bash
# Show all snapshots where iowait exceeded 15%
grep 'cpu_iowait' /var/log/oracle-monitor/snapshots/perf_$(date +%Y%m%d).log \
  | awk -F'|' '{for(i=1;i<=NF;i++) if($i~/cpu_iowait/){split($i,a,"="); gsub(/%/,"",a[2]); if(a[2]+0>15) print $1, $i}}'

# Show swap trend for the day
grep 'swap_used' /var/log/oracle-monitor/snapshots/perf_$(date +%Y%m%d).log \
  | awk -F'|' '{for(i=1;i<=NF;i++) if($i~/swap_used_mb/) print $1, $i}'

# Find the peak load period
sort -t',' -k2 -n /var/log/oracle-monitor/snapshots/perf_$(date +%Y%m%d).log | tail -5
\`\`\`

---

## Correlating OS Metrics with AWR

Once you have a timestamp from the OS monitoring logs showing a CPU or I/O spike, correlate it with the AWR period covering that window:

\`\`\`sql
-- Find AWR snapshots around the incident time
SELECT snap_id, begin_interval_time, end_interval_time
FROM   dba_hist_snapshot
WHERE  begin_interval_time >= TIMESTAMP '2026-06-19 14:00:00'
  AND  end_interval_time   <= TIMESTAMP '2026-06-19 15:00:00'
ORDER  BY snap_id;

-- Top wait events for that snapshot range
SELECT event, SUM(total_waits) AS waits,
       ROUND(SUM(time_waited_micro)/1e6, 1) AS time_s
FROM   dba_hist_system_event
WHERE  snap_id BETWEEN :begin_snap AND :end_snap
  AND  wait_class != 'Idle'
GROUP  BY event
ORDER  BY time_s DESC
FETCH  FIRST 10 ROWS ONLY;

-- DB time and CPU breakdown
SELECT stat_name, SUM(value)/1e6 AS seconds
FROM   dba_hist_sys_time_model
WHERE  snap_id BETWEEN :begin_snap AND :end_snap
  AND  stat_name IN ('DB time','DB CPU','background cpu time',
                     'parse time elapsed','hard parse elapsed time')
GROUP  BY stat_name
ORDER  BY seconds DESC;
\`\`\`

The OS snapshot timestamp narrows the AWR snap range to examine; the AWR data then tells you which Oracle operations were running during the OS-level event.

---

## Summary

An Oracle DBA who only monitors inside the database is working with half the picture. The Linux host surfaces problems — CPU steal from an overcommitted hypervisor, swap pressure from an undersized server, I/O latency from a saturated storage array, or network drops on a RAC interconnect — that have no Oracle wait event equivalent. The monitoring stack in this post reads directly from \`/proc\`, needs no external agents, and gives a complete timestamped record of host-layer performance that can be correlated with AWR and ASH whenever the database behaves unexpectedly.`,
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
