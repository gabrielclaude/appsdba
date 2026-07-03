import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle DB Host Performance Troubleshooting: vmstat, top, ps, mpstat, sar, and watch',
  slug: 'oracle-db-host-performance-troubleshooting-vmstat-top-ps-mpstat-sar',
  excerpt:
    'When an Oracle database slows down, the database wait events tell you what Oracle is waiting for — but the OS tools tell you whether the hardware has the capacity to deliver. This post covers vmstat, top, ps, mpstat, sar, and watch in the context of an Oracle database host, with every column heading explained and interpreted against real Oracle workload patterns.',
  category: 'linux-admin' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-03'),
  youtubeUrl: null,
  content: `## Introduction

Oracle AWR, ASH, and wait event analysis tell you what the database engine is doing. They do not tell you whether the underlying server has CPU headroom, whether memory pressure is forcing OS paging, whether I/O is saturated, or whether a single runaway process is consuming 95% of available CPU. For that you need the OS tools.

Every Oracle DBA who has ever received a "database is slow" call at 2 AM has gone through the same sequence: check active sessions, check wait events, then — when the database looks fine from inside — switch to the OS and run vmstat or top to find that a backup job has saturated I/O, a Java process is consuming all available RAM and triggering swapping, or an OS kernel update restarted the network interface and caused packet loss on the interconnect.

This post covers six tools in the context of an Oracle database host: vmstat, top, ps, mpstat, sar, and watch. Each section explains the tool, every column heading in its output, and how to interpret the values against Oracle-specific workload signatures. The runbook at the end chains them into a structured 15-minute diagnostic sequence.

---

## Summary

| Tool | What It Measures | Best For |
|------|-----------------|----------|
| vmstat | CPU, memory, swap, I/O, system calls — system-wide, sampled | First look at overall resource pressure |
| top | Per-process CPU and memory, system-wide headers | Identifying which process is consuming resources |
| ps | Point-in-time process list with detailed attributes | Confirming Oracle background process states |
| mpstat | Per-CPU utilization across all cores | Finding CPU imbalance, single-core saturation |
| sar | Historical resource data collected by sysstat | Proving a problem existed at a specific time in the past |
| watch | Repeating any command at an interval with diff highlight | Watching a metric change in real time without a loop |

---

## vmstat

vmstat (virtual memory statistics) samples CPU, memory, swap, I/O, and process state counters at a fixed interval. It is the first tool to run on a slow Oracle host because it gives a system-wide view in one line per sample.

### Basic Usage

\`\`\`bash
# Sample every 2 seconds, 30 samples (60 seconds of data)
vmstat 2 30

# With timestamps (requires -t flag on Linux procps version)
vmstat -t 2 30

# With active/inactive memory breakdown
vmstat -a 2 10
\`\`\`

### Output Format and Column Reference

\`\`\`
procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
 2  0      0 142340  18544 6241280    0    0     0   820 3412 6823 18  4 77  1  0
\`\`\`

**procs:**

| Column | Full Name | What It Means |
|--------|-----------|--------------|
| r | Run queue | Processes runnable and waiting for CPU time. On a 32-core host, r > 64 indicates CPU saturation. For Oracle, high r with low wa means CPU-bound queries (sorts, hash joins, PL/SQL) |
| b | Blocked | Processes blocked waiting for I/O or a lock to clear. Oracle LGWR, DBWR, or user processes waiting on disk I/O appear here. b > 10 sustained = I/O saturation |

**memory (kilobytes):**

| Column | Full Name | What It Means |
|--------|-----------|--------------|
| swpd | Swap used | Total virtual memory in swap. For Oracle, swpd > 0 and growing = OS is paging SGA segments or PGA — severe performance issue. Oracle SGA should never be swapped |
| free | Free memory | Unallocated RAM. Low free alone is not a problem — Linux caches aggressively. Concern only when free + buff + cache is exhausted |
| buff | Buffer cache | Kernel buffer cache for block device I/O metadata. Typically small (tens of MB) on a dedicated Oracle server |
| cache | Page cache | Filesystem page cache. On Oracle hosts using ASM, this is small. On hosts using filesystem-based datafiles (ext4, xfs), this can be large as the OS caches Oracle blocks |
| inact | Inactive pages | Pages in page cache not recently used (shown with -a flag). High inact = OS memory available for reclaim without paging |
| active | Active pages | Pages in page cache recently used (shown with -a flag) |

**swap:**

| Column | Full Name | What It Means |
|--------|-----------|--------------|
| si | Swap in | KB per second being read from swap back into RAM. Any sustained si > 0 = severe memory pressure. Oracle processes being swapped in cause log-on delays and ORA-04031 |
| so | Swap out | KB per second being written to swap. so > 0 = OS is evicting memory pages. If Oracle SGA is swapped out, the instance will hang |

**io:**

| Column | Full Name | What It Means |
|--------|-----------|--------------|
| bi | Blocks in | Blocks per second read from block devices. For Oracle ASM hosts: reads from disk. During full table scans, bi spikes. During RMAN restores, bi is sustained high |
| bo | Blocks out | Blocks per second written to block devices. LGWR (redo log writes) and DBWR (dirty block flushes) appear here. bo sustained at disk limit = I/O bottleneck |

**system:**

| Column | Full Name | What It Means |
|--------|-----------|--------------|
| in | Interrupts | Hardware interrupts per second. Very high in (> 100,000 on a 16-core host) can indicate a malfunctioning NIC or disk controller. Normal range: 3,000–30,000 on busy Oracle hosts |
| cs | Context switches | CPU context switches per second. For Oracle, cs correlates with active sessions. cs > 200,000 on a 16-core host often means too many foreground processes competing for CPU — consider connection pooling |

**cpu (percentages summing to 100%):**

| Column | Full Name | What It Means |
|--------|-----------|--------------|
| us | User CPU | CPU in user space (Oracle foreground processes, SQL execution, PGA operations). Sustained us > 80% = CPU-bound workload. Normal for batch/DSS: 60–80%. Normal for OLTP: 20–50% |
| sy | System CPU | CPU in kernel mode (I/O system calls, mutex operations, network). sy > 20% is high. sy > 30% with low us suggests I/O driver overhead or excessive system calls |
| id | Idle CPU | Unoccupied CPU. id = 0 for sustained periods = CPU saturated. id consistently near 100% = CPU not the bottleneck |
| wa | I/O wait | CPU idle because it is waiting for I/O to complete. wa > 20% indicates I/O is the bottleneck. During RMAN full backup: wa 40–70% is expected. During normal OLTP: wa > 10% needs investigation |
| st | Steal | CPU cycles stolen by the hypervisor (VMs only). st > 5% on an Oracle VM means the physical host is over-provisioned and Oracle is losing CPU cycles to other VMs. OCI Flex shapes do not have CPU steal because OCPU allocation is dedicated |

### Interpreting vmstat for Oracle

**Pattern 1 — CPU saturation, not I/O:**
r high (> 2× CPU count), wa near 0, us + sy near 100, id near 0.
Cause: sorts, hash joins, PL/SQL loops, or an unindexed full table scan on a large table. Check V\$SQL for high CPU queries.

**Pattern 2 — I/O bottleneck:**
b > 5 sustained, wa > 20, bi or bo at near-constant high value.
Cause: DBWR cannot flush dirty blocks fast enough, or a large scan is reading faster than the disk tier can serve. Check V\$FILESTAT for hot datafiles.

**Pattern 3 — Memory pressure / swapping:**
swpd growing, si or so > 0, free near 0.
Cause: SGA + PGA exceeds physical RAM, or another process (Java, OS daemon) is consuming memory. Check total Oracle memory: SELECT SUM(bytes)/1024/1024/1024 FROM v\$sgainfo; and ps aux sorted by RSS.

**Pattern 4 — Normal healthy Oracle host (OLTP):**
r 2–8, b 0–2, swpd 0, si 0, so 0, us 15–40, sy 3–8, id 50–75, wa 1–5.

---

## top

top is an interactive, continuously refreshing process viewer. On an Oracle host it is the fastest way to see which specific process is consuming CPU or memory.

### Basic Usage

\`\`\`bash
# Default: refresh every 3 seconds
top

# Refresh every 1 second (useful during active incidents)
top -d 1

# Non-interactive batch mode, 5 iterations, for scripting
top -b -n 5

# Show only Oracle processes
top -b -n 1 | grep -E 'ora_|oracle'

# Sort by memory instead of CPU
# Inside top: press M
# Or launch with: top -o %MEM
\`\`\`

### Header Lines

\`\`\`
top - 14:32:18 up 47 days,  3:11,  2 users,  load average: 4.21, 3.87, 3.45
Tasks: 412 total,   3 running, 408 sleeping,   1 stopped,   0 zombie
%Cpu(s): 22.4 us,  5.1 sy,  0.0 ni, 71.8 id,  0.5 wa,  0.1 hi,  0.1 si,  0.0 st
MiB Mem :  128000.0 total,   2140.2 free,  98430.5 used,  27429.3 buff/cache
MiB Swap:   8192.0 total,      0.0 free,   8192.0 used.  28100.2 avail Mem
\`\`\`

**Line 1 — System summary:**

| Field | Meaning |
|-------|---------|
| up 47 days | Uptime since last boot. Short uptime after an expected outage window is normal; unexpected short uptime = unplanned reboot |
| load average: 4.21, 3.87, 3.45 | 1-minute, 5-minute, 15-minute run queue averages. For a 32-core host, load > 32 = CPU saturated. Trending up (1-min > 15-min) = worsening problem |
| 2 users | Logged-in shell sessions — not Oracle sessions |

**Line 2 — Task summary:**

| Field | Meaning |
|-------|---------|
| running | Processes actively on CPU right now |
| sleeping | Waiting for I/O, a lock, or a timer — normal for idle Oracle background processes |
| stopped | SIGSTOP received — should be 0 on production |
| zombie | Processes that exited but parent did not reap. Zombies do not consume CPU/memory but indicate a process management bug |

**Line 3 — CPU percentages (same as vmstat but adds hi and si):**

| Column | Meaning |
|--------|---------|
| us | User space CPU |
| sy | Kernel/system CPU |
| ni | CPU for processes with adjusted nice value |
| id | Idle |
| wa | I/O wait |
| hi | Hardware IRQ handling — high value means NIC or disk controller is generating excessive interrupts |
| si | Software IRQ (softirq) — high value during network storms or when using software RAID |
| st | Steal (VMs only) |

**Lines 4–5 — Memory:**

| Field | Meaning |
|-------|---------|
| total | Physical RAM installed |
| free | Unallocated |
| used | Allocated (includes SGA, PGA, OS processes) |
| buff/cache | Kernel buffer and page cache — effectively available memory because Linux reclaims it when needed |
| avail Mem | Estimated memory available for new processes without swapping (more accurate than free alone) |

### Process Table Columns

\`\`\`
  PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND
24831 oracle    20   0   13.2g  11.8g  11.6g S  42.3   9.2  12:31.04 oracle
24219 oracle    20   0   13.2g  10.1g  10.0g S  18.7   7.9   8:14.22 oracle
  891 oracle    20   0   13.2g   1.2g   1.1g S   0.3   0.9   0:02.11 ora_dbw0_ORCL
\`\`\`

| Column | Full Name | Meaning |
|--------|-----------|---------|
| PID | Process ID | Use to drill into ps or strace |
| USER | Owner | Should be oracle for Oracle processes. root for OS services |
| PR | Priority | Kernel scheduling priority. Lower = higher priority. Oracle foreground: 20, background: 20 |
| NI | Nice value | User-adjustable priority offset. 0 = default. Positive = lower priority. Do not nice Oracle processes |
| VIRT | Virtual memory | Total virtual address space claimed by the process, including shared SGA segments. High VIRT for Oracle foreground processes is normal — they map the entire SGA |
| RES | Resident set size | Physical RAM pages currently in use. For Oracle foreground: RES ≈ PGA allocation. For SGA: RES is shared across all Oracle processes but counted per-process by top — do not sum RES across Oracle processes to estimate total memory use |
| SHR | Shared memory | Pages shared with other processes. For Oracle: SHR ≈ SGA pages mapped by this process. SHR is approximately equal across all foreground processes pointing to the same instance |
| S | State | R=running, S=sleeping (interruptible), D=disk wait (uninterruptible), Z=zombie, T=stopped |
| %CPU | CPU usage | Percentage of one CPU core. On a 32-core host, a value of 3200% theoretically means all cores busy, though top caps display at 100% in some modes |
| %MEM | Memory | RES as a percentage of total physical RAM |
| TIME+ | Total CPU time | Cumulative CPU time consumed by this process since it started. Rapidly growing TIME+ = currently active process |
| COMMAND | Process name | Oracle foreground: oracle. Background: ora_dbw0_SID, ora_lgwr_SID, ora_arc0_SID, etc. |

### Useful top Key Bindings During an Incident

| Key | Action |
|-----|--------|
| 1 | Toggle per-CPU breakdown (shows all cores individually) |
| M | Sort by memory (RES) |
| P | Sort by CPU |
| u | Filter by user (type oracle to show only Oracle processes) |
| k | Kill a process by PID (use with caution) |
| H | Show threads instead of processes |
| f | Field manager — add/remove columns |
| W | Write current settings to toprc for persistence |

---

## ps

ps is a point-in-time snapshot of the process table. Unlike top, it does not refresh — but it supports richer filtering, sorting, and output format options, making it better for scripted checks and for capturing Oracle process state at a specific moment.

### Useful ps Commands for Oracle Hosts

\`\`\`bash
# All Oracle processes with PID, CPU, memory, state, and command
ps aux | grep -v grep | grep oracle

# Oracle processes sorted by CPU descending
ps aux --sort=-%cpu | grep oracle | head -20

# Oracle processes sorted by RSS (resident memory) descending
ps aux --sort=-%mem | grep oracle | head -20

# Oracle background processes only (ora_ prefix)
ps -ef | grep ora_ | grep -v grep

# Detailed Oracle foreground process list: PID, PPID, state, priority, nice, RSS, command
ps -eo pid,ppid,stat,pri,ni,rss,comm | grep oracle

# Long format with full command line (shows ORACLE_SID and connect info)
ps -eo pid,lstart,etime,rss,%cpu,%mem,args | grep oracle | grep -v grep
\`\`\`

### ps aux Column Reference

\`\`\`
USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND
oracle   24831 42.3  9.2 13845632 12189204 ?  Ssl 10:01  12:31 oracle...
oracle     891  0.3  0.9 13845632 1258496 ?   Ssl 07:44   0:02 ora_dbw0_ORCL
\`\`\`

| Column | Meaning |
|--------|---------|
| USER | Process owner |
| PID | Process ID |
| %CPU | CPU usage since the process started (not an instantaneous reading — use top for real-time) |
| %MEM | RSS as a percentage of physical RAM |
| VSZ | Virtual size in KB — same as VIRT in top |
| RSS | Resident set size in KB — physical memory in use. For Oracle foreground processes, this approximates the session's PGA |
| TTY | Controlling terminal. ? means no terminal (daemon). Oracle background processes are always ? |
| STAT | Process state: R=running, S=sleeping, D=disk wait (uninterruptible I/O — these processes cannot be killed), Z=zombie, s=session leader, l=multi-threaded, +=foreground process group |
| START | Time the process was started. Recent starts during a supposed uptime indicate a process restart or crash |
| TIME | Cumulative CPU time consumed (hours:minutes) |
| COMMAND | Process command. Oracle foreground processes show the full oracle binary path. Background processes show ora_processname_SID |

**The D state matters for Oracle.** A foreground Oracle process stuck in D state (uninterruptible disk wait) is blocked on an I/O call that has not returned. If D-state processes accumulate (check with: ps aux | awk '$8 ~ /^D/ {print}'), the storage layer is not responding — the block device, ASM diskgroup, or NFS mount is stalled.

### Oracle-Specific ps Patterns

\`\`\`bash
# Count D-state processes (should be near 0 on healthy system)
ps aux | awk '$8 ~ /^D/ {count++} END {print "D-state:", count}'

# Find Oracle processes consuming unexpectedly high CPU (> 50%)
ps aux | awk 'NR>1 && $3>50 && /oracle/ {print $0}'

# Check if Oracle listener is running
ps -ef | grep tnslsnr | grep -v grep

# Check Oracle background processes for a specific SID
ps -ef | grep ora_ | grep ORCL | grep -v grep | awk '{print $8}' | sort
\`\`\`

---

## mpstat

mpstat (multiprocessor statistics) reports per-CPU utilization. It comes from the sysstat package alongside sar. On an Oracle RAC host or a multi-CPU server, mpstat reveals whether load is balanced across cores or whether a single CPU is saturated while others are idle.

### Basic Usage

\`\`\`bash
# All CPUs, sample every 2 seconds, 20 samples
mpstat -P ALL 2 20

# Single-CPU summary (average across all cores)
mpstat 2 20

# With interrupt breakdown per CPU
mpstat -P ALL -I ALL 2 5
\`\`\`

### Output and Column Reference

\`\`\`
Linux 5.15.0 (dbhost01)   07/03/2026   _x86_64_   (32 CPU)

14:45:02     CPU    %usr   %nice    %sys %iowait    %irq   %soft  %steal  %guest  %gnice   %idle
14:45:04     all    22.4    0.0     5.1     0.5      0.1     0.2     0.0     0.0     0.0    71.7
14:45:04       0    81.0    0.0     8.5     0.5      0.0     0.3     0.0     0.0     0.0     9.7
14:45:04       1    18.2    0.0     4.2     0.3      0.0     0.1     0.0     0.0     0.0    77.2
14:45:04       2    20.1    0.0     4.9     0.4      0.0     0.2     0.0     0.0     0.0    74.4
...
\`\`\`

| Column | Full Name | Meaning for Oracle |
|--------|-----------|-------------------|
| CPU | CPU number | 'all' = aggregate. Individual numbers = specific core |
| %usr | User CPU | Oracle SQL execution, PGA sorts, user-defined functions |
| %nice | Niced user CPU | CPU used by processes with a positive nice value — should be 0 for Oracle |
| %sys | System/kernel CPU | System calls from Oracle I/O, IPC, mutex operations |
| %iowait | I/O wait | CPU idle waiting for I/O. High on specific CPUs during DBWR or LGWR I/O |
| %irq | Hardware IRQ | Interrupt service routines. One CPU handling all NIC interrupts is a sign IRQ affinity is not set |
| %soft | Software IRQ | Network packet processing, timer callbacks |
| %steal | Steal | VM cycles stolen by hypervisor. Per-CPU steal helps identify noisy neighbor VMs on shared hosts |
| %guest | Guest CPU | CPU running a VM guest — relevant on KVM hypervisor hosts |
| %idle | Idle | CPU not doing useful work |

### Interpreting mpstat for Oracle

**CPU 0 at 100%, all others at 20% — single-threaded bottleneck.** A specific Oracle background process (LGWR writes sequentially, LMS on RAC, or a PL/SQL loop) is pinned to one core. This appears when PARALLEL_MAX_SERVERS is set to 0 or when a critical serial path (redo log write) is on a core with no headroom.

**All CPUs at 80%+ user — parallel query saturation.** A large parallel query with too many parallel slaves is consuming all cores. Check V\$PX_SESSION for active parallel sessions and V\$SQL for the statement. Reduce PARALLEL_DEGREE_POLICY or add a PARALLEL hint with a lower degree.

**%sys uniformly high across all CPUs (> 15%).** Kernel is spending significant time on system calls — usually I/O system calls from Oracle ASM or multiple threads doing network I/O. Check if redo transport (Data Guard) is generating unexpected network overhead.

---

## sar

sar (system activity reporter) reads from the sysstat binary data files collected by the sadc daemon, which runs every 10 minutes by default on systems with sysstat installed. On an Oracle host, sar is the tool for answering "what was happening at 3 AM when the batch job ran?" — it provides history that vmstat and top do not retain.

### Enabling and Configuring sysstat Collection

\`\`\`bash
# Install sysstat (RHEL/OL)
dnf install sysstat -y
systemctl enable --now sysstat

# Default collection interval (10 minutes) — change to 5 minutes for Oracle hosts
vi /etc/sysstat/sysstat
# Change: HISTORY=28
# Add: SADC_OPTIONS="-S ALL"

# Restart to apply
systemctl restart sysstat

# Data files stored here (one per day):
ls /var/log/sa/
# sa01, sa02, ... sa31
\`\`\`

### sar Usage Reference

\`\`\`bash
# CPU utilization from today's data, all entries
sar -u

# CPU for a specific historical date
sar -u -f /var/log/sa/sa01

# CPU between 02:00 and 04:00 AM (batch window)
sar -u -s 02:00:00 -e 04:00:00

# Memory utilization
sar -r

# Memory with hugepages (critical for Oracle SGA)
sar -r ALL

# I/O statistics (read/write per device)
sar -d

# I/O with device names instead of major:minor
sar -d -p

# Load average and run queue
sar -q

# Swap statistics
sar -W

# Network interface throughput
sar -n DEV

# Context switches and interrupts (system call overhead)
sar -w

# All statistics in one run (heavy — use selectively)
sar -A
\`\`\`

### sar -u (CPU) Column Reference

\`\`\`
14:00:01     CPU     %user   %nice  %system  %iowait   %steal   %idle
14:10:01     all     45.23    0.00    8.12     18.34     0.00    28.31
14:20:01     all     22.10    0.00    4.55      2.11     0.00    71.24
14:30:01     all     61.42    0.00    9.83     22.10     0.00     6.65
\`\`\`

Same columns as mpstat (user, nice, system, iowait, steal, idle). The value of sar is the time axis — you can see that the 14:10 interval had high iowait (18%) and high user (45%), indicating a parallel I/O-heavy workload, while 14:20 was quieter.

### sar -r (Memory) Column Reference

\`\`\`
14:00:01    kbmemfree  kbavail  kbmemused   %memused  kbbuffers   kbcached   kbcommit   %commit  kbactive   kbinact   kbdirty
14:10:01      142340  28100200   98430500      76.9%      18544    6241280  112000000     43.8%  72000000  20000000     82400
\`\`\`

| Column | Meaning for Oracle |
|--------|-------------------|
| kbmemfree | Free unallocated memory. Low alone is not a problem if kbavail is large |
| kbavail | Memory available without swapping (free + reclaimable cache). This is the real free memory figure |
| kbmemused | Memory in use (excludes buffers/cache) |
| %memused | Percentage of total RAM used |
| kbbuffers | Buffer cache for block device metadata |
| kbcached | Filesystem page cache. On ASM systems this is small. On filesystem-based Oracle, large kbcached is good — it means Oracle blocks are cached by the OS |
| kbcommit | Memory committed (allocated but not necessarily resident). Commit > physical RAM = swap risk |
| %commit | Commit as percentage of total virtual memory (RAM + swap) |
| kbactive | Recently used pages — harder to reclaim |
| kbinact | Inactive pages — reclaimable without swap |
| kbdirty | Pages modified in cache but not yet written to disk. Large dirty values during DBWR pressure can delay reclaim |

### sar -d (Disk I/O) Column Reference

\`\`\`
14:10:01  DEV    tps   rkB/s   wkB/s   areq-sz  aqu-sz   await   svctm   %util
14:10:01  sdb  845.0  6240.0  18420.0    29.2      3.4    4.02     1.18    99.7
14:10:01  sdc   12.0    80.0    240.0    26.7      0.1    0.82     0.81     0.9
\`\`\`

| Column | Full Name | Meaning for Oracle |
|--------|-----------|-------------------|
| DEV | Device | Disk device or ASM diskgroup device (use -p for names) |
| tps | Transactions per second | I/O operations per second. Oracle OLTP: 500–5000 tps per device is normal. Batch: up to physical IOPS limit of the device |
| rkB/s | Read KB/s | Read throughput. High during full table scans, RMAN restores, or large ASM rebalancing |
| wkB/s | Write KB/s | Write throughput. DBWR and LGWR show here. LGWR is typically small sequential writes; DBWR is larger random writes |
| areq-sz | Average request size KB | Small areq-sz (< 8 KB) = random OLTP I/O. Large areq-sz (> 64 KB) = sequential scan or RMAN. Oracle db_block_size (8 KB default) means OLTP reads appear as 8 KB requests |
| aqu-sz | Average queue depth | Requests in flight at the device. aqu-sz > 4 = device is behind. aqu-sz > 16 on a single spinner disk = severe saturation |
| await | Average wait time ms | Total time from I/O request to completion, including queue wait. Oracle considers disk latency acceptable at < 10 ms for redo logs, < 20 ms for datafiles. await > 50 ms = I/O bottleneck |
| svctm | Service time ms | Time the device actually spent on I/O (await minus queue wait). Deprecated in newer sysstat versions |
| %util | Device utilization | Percentage of time the device was busy. %util near 100% = device is at capacity. Applies per spindle; NVMe and SAN arrays can be saturated without hitting 100% because they service multiple queues |

### sar -q (Run Queue) Column Reference

\`\`\`
14:10:01   runq-sz  plist-sz  ldavg-1  ldavg-5  ldavg-15  blocked
14:10:01        12       412     4.21     3.87      3.45        3
\`\`\`

| Column | Meaning |
|--------|---------|
| runq-sz | Processes waiting for CPU. Same as vmstat r column |
| plist-sz | Total processes in the process list |
| ldavg-1/5/15 | Load averages — same as uptime and top header |
| blocked | Processes blocked on I/O or locks — same as vmstat b column |

### sar -W (Swap) Column Reference

\`\`\`
14:10:01  pswpin/s  pswpout/s
14:10:01      0.00       0.00
\`\`\`

| Column | Meaning |
|--------|---------|
| pswpin/s | Pages per second swapped in from disk. Any value > 0 sustained = Oracle memory pressure |
| pswpout/s | Pages per second swapped out to disk. Oracle SGA segments being swapped out cause an immediate performance emergency |

---

## watch

watch is not a statistics tool — it is a wrapper that runs any command repeatedly at a fixed interval and displays the output, optionally highlighting differences between refreshes. It is useful for watching a specific metric while you are investigating an active incident.

### Basic Usage

\`\`\`bash
# Run vmstat every 2 seconds, highlight differences between refreshes
watch -d -n 2 'vmstat 1 2 | tail -1'

# Watch Oracle listener status every 5 seconds
watch -n 5 'lsnrctl status | grep -E "Alias|Status|Uptime|Services"'

# Watch D-state process count (should stay near 0)
watch -d -n 3 "ps aux | awk '\$8 ~ /^D/ {count++} END {print \"D-state processes:\", count+0}'"

# Watch run queue and swap from vmstat
watch -d -n 2 'vmstat | tail -1 | awk "{print \"r:\",\$1,\"b:\",\$2,\"swpd:\",\$3,\"wa:\",\$16}"'

# Watch specific Oracle background processes
watch -n 3 'ps aux | grep -E "ora_lgwr|ora_dbw|ora_arc" | grep -v grep'

# Watch disk I/O summary
watch -d -n 2 'iostat -xz 1 2 | grep -v "^$" | grep -v "^Linux" | grep -v "^Device"'
\`\`\`

### watch Flags

| Flag | Meaning |
|------|---------|
| -n N | Refresh every N seconds (default: 2) |
| -d | Highlight differences between refreshes (changed values shown in bold/inverse) |
| -t | Suppress the header line (useful when piping or capturing output) |
| -e | Exit on non-zero exit code from the command (useful for alerting) |
| -x | Pass command to exec instead of sh (avoids shell quoting issues for complex commands) |

### watch for Oracle Incident Monitoring

\`\`\`bash
# One-liner dashboard: run queue, swap, iowait, D-state count
watch -d -n 2 '
echo "=== $(date) ==="
echo "--- vmstat snapshot ---"
vmstat 1 2 | tail -1
echo "--- D-state processes ---"
ps aux | awk "$8 ~ /^D/ {count++} END {print \"Count:\", count+0}"
echo "--- Top Oracle CPU ---"
ps aux --sort=-%cpu | grep oracle | grep -v grep | head -5
'
\`\`\`

---

## Conclusion

The six tools form a diagnostic stack. vmstat answers the first question in any incident: is this CPU, I/O, or memory? top and ps answer the second: which process is the cause? mpstat answers the third: is the problem on all cores or concentrated on one? sar answers the retrospective question: what happened before anyone noticed? And watch holds any of the above open during an active incident so you can watch the numbers change as you take corrective action.

None of these tools replaces Oracle AWR or ASH — they complement them. AWR tells you which SQL statement is running 10,000 disk reads per second. sar -d tells you whether the storage device those reads are hitting is saturated. Used together, they close the gap between "Oracle is waiting on db file sequential read" and "the SAN volume serving the USERS tablespace is at 99% utilization and 47 ms average latency."
`,
};

async function main() {
  await db.insert(posts).values(post);
  console.log('Inserted:', post.slug);
}

main().catch(console.error);
