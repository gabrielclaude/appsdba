import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Behind the Scenes: The Mystery of the Hung Oracle Database, Full Swap, and GCP Storage Bottlenecks',
  slug: 'oracle-linux-swap-memory-hung-database-investigation',
  excerpt:
    'Why your Oracle Database hangs when swap hits 100% yet free RAM is still showing available — the three root causes (vm.swappiness, missing HugePages, NUMA starvation), how to prove them with OS and Oracle diagnostics, and how GCP disk throttling turns a memory crisis into a full database outage.',
  category: 'oracle-google-cloud' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-22'),
  youtubeUrl: null,
  content: `## Overview

It's the alert every DBA dreads: the database is completely unresponsive. SQL*Plus hangs on connection, the terminal is painfully sluggish, and OS metrics show memory utilisation is through the roof.

As you dig into the Linux statistics (\`free -m\` or \`top\`), you notice a bizarre paradox: swap space is 100% full, yet the system reports free physical RAM is still available. If your Oracle Database suddenly hung under these conditions — especially when running on cloud infrastructure such as Google Cloud Platform — you are not seeing things. This is a classic infrastructure bottleneck where the OS kernel, Oracle's memory structures, and cloud storage limits collide.

This post explains why the paradox occurs, how to identify the exact cause from both the OS and Oracle layers, how to detect GCP storage throttling as a secondary cascade, and what to change so it never recurs.

---

## Why Swap Fills Up While Free RAM Remains

The intuitive expectation is: if RAM is available, the OS should use it. In practice, Linux makes this more complicated for database workloads through three distinct mechanisms.

### 1. The vm.swappiness Trap

Linux uses a kernel tuning parameter called \`swappiness\` (0–100) to control how aggressively it moves process memory out of physical RAM and into swap to keep the OS page cache large.

The default value on most Linux distributions is 60. For Oracle, this is disastrous. The kernel observes parts of the Oracle SGA (System Global Area) or idle background processes as "inactive" and swaps them out to disk to make room for filesystem caching. When Oracle then needs to read from that swapped-out SGA memory — on any query, on any checkpoint, on the next redo write — the database grinds to a halt waiting on disk I/O that is orders of magnitude slower than RAM.

The fix is to lower swappiness to 1. This tells the kernel: do not use swap unless physical RAM is almost completely exhausted.

### 2. Missing Static HugePages

By default, Linux manages memory in 4 KB pages. A 64 GB Oracle SGA requires the OS to track over 16 million page table entries. That page table itself consumes gigabytes of RAM.

Linux cannot swap out the page table, but it can swap out the Oracle SGA or background processes to make room for the page table. This is the mechanism behind SGA appearing on swap despite available free RAM.

Static HugePages (2 MB chunks) eliminate this by pinning Oracle's SGA into physical RAM permanently. The Linux kernel is physically forbidden from swapping HugePages. The page table overhead drops by a factor of 512.

One critical distinction: Transparent HugePages (THP) — which Linux enables by default — must be **disabled** on Oracle Database servers. THP's compaction and defragmentation threads cause erratic latency spikes and have known issues in Oracle RAC environments.

### 3. NUMA Node Memory Starvation

Modern multi-socket database servers use Non-Uniform Memory Access (NUMA) architecture. Each CPU socket has its own locally attached physical RAM bank.

\`\`\`
+-----------------------------------+-----------------------------------+
|            NUMA NODE 0            |            NUMA NODE 1            |
|  +--------------+  +-----------+  |  +--------------+  +-----------+  |
|  |   CPU 0-7    |  | Local RAM |  |  |   CPU 8-15   |  | Local RAM |  |
|  +--------------+  +-----------+  |  +--------------+  +-----------+  |
|    (Memory Exhausted — SWAP!)     |    (Gigabytes of Free RAM)        |
+-----------------------------------+-----------------------------------+
\`\`\`

If Oracle allocates the majority of its memory on NUMA Node 0, that node can exhaust its local RAM while Node 1 still has plenty free. By default, Linux prefers to swap out local memory rather than traverse the interconnect bus to access remote free memory. The result is the paradox: \`free -m\` shows free RAM system-wide, swap is 100% full, and Oracle is hung.

---

## The Three-Layer Investigation

### Layer 1: OS-Level Memory Evidence

**Which process is consuming the most memory?**

\`\`\`bash
ps aux --sort=-%mem | head -n 10
\`\`\`

**Which processes are holding swap space?**

\`\`\`bash
for file in /proc/[0-9]*/status; do
  awk '/Name|Pid|VmSwap/ {printf $0 " "}; END {print ""}' "$file"
done | sort -k 3 -n -r | head -n 10
\`\`\`

If your Oracle shadow processes or background processes (pmon, smon, lgwr, dbwr) appear at the top with large \`VmSwap\` values, the database's memory is sitting on disk.

**Is HugePages configured?**

\`\`\`bash
grep -i huge /proc/meminfo
\`\`\`

If \`HugePages_Total\` is 0, HugePages are not configured. Everything your Oracle SGA uses is eligible to be swapped.

**Is a NUMA imbalance present?**

\`\`\`bash
numastat -cm
\`\`\`

If the "Free" row shows near 0 MB on one node while another has thousands of MB free, you have a NUMA starvation scenario.

**Did the OOM Killer fire?**

\`\`\`bash
dmesg -T | grep -i -E 'oom|kill'
# or on older systems:
grep -i 'oom' /var/log/messages
\`\`\`

If Oracle background processes were killed by the OOM Killer, you will see their PIDs and names in this output. This is not the root cause — it is the kernel's last-resort response to the root cause.

### Layer 2: Oracle-Level Evidence

**Check the alert log for memory errors:**

\`\`\`bash
adrci> show alert
\`\`\`

Look for \`ORA-04030: out of process memory\` or \`ORA-04031: unable to allocate bytes of shared memory\`. These confirm Oracle could not satisfy a memory allocation request at the OS level.

**Check PGA over-allocation:**

\`\`\`sql
SELECT name, value/1024/1024 "Size (MB)"
FROM v$pgastat
WHERE name IN (
  'aggregate PGA target parameter',
  'maximum PGA allocated',
  'total PGA allocated'
);
\`\`\`

If \`maximum PGA allocated\` far exceeds \`aggregate PGA target parameter\`, user sessions are over-consuming PGA memory, driving the OS into swap to compensate. Set \`PGA_AGGREGATE_LIMIT\` (Oracle 12c+) to hard-cap PGA and terminate runaway sessions before they destabilise the OS.

### Layer 3: GCP Storage Evidence

When a severe memory/swap event occurs on GCP, a secondary cascade frequently follows: Oracle background processes LGWR and DBWR begin stalling on disk I/O because the GCP Persistent Disk is throttled while also serving the OS's frantic swap traffic.

**Check Oracle wait events for I/O bottleneck:**

\`\`\`sql
SELECT event,
       total_waits,
       ROUND(time_waited_micro / 1000000, 1) "Time Waited (Sec)",
       ROUND(average_wait * 10, 2) "Avg Wait (ms)"
FROM v$system_event
WHERE event IN (
  'log file parallel write',
  'db file parallel write',
  'control file parallel write',
  'log file sync'
)
ORDER BY time_waited_micro DESC;
\`\`\`

Thresholds that indicate a storage problem on GCP SSD (\`pd-ssd\`):
- \`log file parallel write\` average > 5 ms: redo log writes are too slow
- \`db file parallel write\` average > 10–15 ms: DBWR is struggling to flush dirty blocks
- \`log file sync\` high alongside \`log file parallel write\`: user commits are waiting on disk

**Check OS-level disk latency with iostat:**

\`\`\`bash
iostat -xmt 1 10
\`\`\`

Watch the disk device hosting your Oracle redo logs and datafiles:
- \`w_await\` > 5–10 ms: write latency is elevated
- \`aqu-sz\` > 1 and rising: I/O requests are queuing faster than the disk serves them
- \`%util\` approaching 100%: the disk is saturated

**Check GCP throttling metrics in the Cloud Console:**

Navigate to Compute Engine → your instance → Monitoring tab. Look for:
- \`instance/disk/throttled_write_bytes_count\`
- \`instance/disk/throttled_read_bytes_count\`

If these metrics spike at the same time Oracle slows down or hangs, GCP has enforced a hard I/O cap on your disk. GCP Persistent Disk IOPS and throughput ceilings are set by disk type and disk size — a swap storm can push a correctly-sized database disk past its provisioned ceiling.

---

## What to Fix

| Symptom | Root Cause | Fix |
|---------|-----------|-----|
| Swap full, free RAM visible | \`vm.swappiness\` too high | Set \`vm.swappiness = 1\` in \`/etc/sysctl.conf\` |
| Swap used, free RAM visible | NUMA node starvation | Set \`vm.zone_reclaim_mode = 0\` in \`/etc/sysctl.conf\` |
| Oracle SGA swapping out | Missing memory pinning | Configure Static HugePages; disable Transparent HugePages |
| ORA-04030 / ORA-04031 | Runaway PGA or SGA over-allocation | Set \`PGA_AGGREGATE_LIMIT\`; review SGA sizing |
| High \`log file parallel write\` on GCP | Hit GCP disk IOPS/throughput ceiling | Isolate redo logs on \`pd-ssd\` or Hyperdisk Extreme; increase disk size to scale IOPS |
| LGWR / DBWR hangs post-swap event | Swap I/O competing with DB I/O | Add a dedicated swap device; separate redo, data, and swap onto distinct disk volumes |

**HugePages sizing formula:**

\`\`\`sql
-- Determine required HugePages count from Oracle
SELECT CEIL(
  (SELECT TO_NUMBER(value) FROM v$parameter WHERE name = 'sga_max_size') /
  (SELECT TO_NUMBER(value) FROM v$parameter WHERE name = 'db_block_size')
) * 2 AS hugepages_needed
FROM dual;
-- More accurately: sga_max_size / 2097152 (2MB HugePage size), rounded up
\`\`\`

\`\`\`bash
# Set HugePages in /etc/sysctl.conf
# vm.nr_hugepages = <calculated value from above + 10% buffer>

# Disable Transparent HugePages permanently (RHEL/OL)
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag
# Make permanent: add to /etc/rc.d/rc.local or a systemd unit
\`\`\`

---

## Summary

A hung Oracle Database with swap at 100% and free RAM visible is almost always one of three OS-level misconfigurations: \`vm.swappiness\` too high (kernel swaps Oracle memory to preserve page cache), missing Static HugePages (Oracle SGA is evictable), or NUMA node starvation (kernel swaps local node memory rather than using remote free RAM). On GCP, a fourth dimension exists: swap I/O and database I/O compete for the same Persistent Disk I/O budget, and GCP throttling turns a recoverable memory event into a full outage.

The investigation follows three layers — OS commands (\`numastat\`, \`iostat\`, \`/proc\` swap scan), Oracle V$ views (\`v$pgastat\`, \`v$system_event\`), and GCP throttle metrics — each confirming or eliminating a root cause. The permanent fixes (swappiness, zone_reclaim_mode, HugePages, redo log disk isolation) take under an hour to implement and collectively eliminate the most common class of unplanned Oracle outages on Linux infrastructure. The companion runbook provides the step-by-step procedure and monitoring scripts to detect recurrence before it causes another hang.`,
};

async function main() {
  console.log('Inserting Oracle swap/memory hung database blog post...');
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
