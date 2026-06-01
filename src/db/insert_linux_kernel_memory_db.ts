import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Linux Kernel Memory Configuration for Oracle Database Hosts',
  slug: 'linux-kernel-memory-oracle-database',
  excerpt:
    'A deep dive into Linux kernel memory parameters for Oracle Database hosts — HugePages sizing and configuration, Transparent Huge Pages disable, shared memory limits, semaphores, NUMA topology, vm.swappiness, dirty page writeback tuning, and how each setting interacts with Oracle SGA management.',
  category: 'linux-admin' as const,
  published: true,
  publishedAt: new Date('2026-06-01'),
  youtubeUrl: null,
  content: `The Linux kernel memory subsystem has a significant impact on Oracle Database performance. Default kernel settings are tuned for general workloads — web servers, desktop applications, mixed-use environments — not for a process that allocates several hundred gigabytes of shared memory at startup and holds it exclusively for the duration of its lifetime. Getting the kernel configuration right for an Oracle host prevents GC-induced pauses from Transparent Huge Pages, eliminates unnecessary swap activity under memory pressure, avoids NUMA-induced remote memory allocation, and ensures the SGA is backed by large contiguous pages that the CPU's TLB can address efficiently.

This post covers every kernel memory parameter relevant to Oracle Database hosts, explains what each one does and why the default is wrong for database workloads, and provides the correct values.

---

## How Oracle Uses Memory on Linux

Oracle Database allocates its System Global Area (SGA) as a single contiguous block of shared memory at instance startup. The SGA holds the buffer cache, shared pool, large pool, redo log buffer, and in-memory areas. On a production host with an 8–512 GB SGA, this is the dominant memory consumer on the machine.

Oracle accesses the SGA through:
- **POSIX shared memory segments** (\`shmget\`/\`shmat\`) — the traditional mechanism, governed by \`kernel.shmmax\`, \`kernel.shmall\`, and \`kernel.shmmni\`
- **\`/dev/shm\`** — a tmpfs mount used by Oracle 11gR2+ with AMM (Automatic Memory Management) for both SGA and PGA; sized by the kernel at boot
- **HugePages** — large memory pages (2 MB default on x86-64) that map the SGA more efficiently than standard 4 KB pages

Understanding which mechanism your Oracle installation uses is the first step. AMM (when \`MEMORY_TARGET\` is set) uses \`/dev/shm\`. ASMM or manual SGA management (when \`SGA_TARGET\` or explicit component parameters are set) uses POSIX shared memory segments, which can be backed by HugePages.

**HugePages and AMM are mutually exclusive.** You cannot use both simultaneously. For large SGA instances where HugePages are beneficial, use \`SGA_TARGET\` rather than \`MEMORY_TARGET\`.

---

## HugePages

### Why HugePages matter

A standard Linux process maps memory through a page table — a hierarchical data structure that translates virtual addresses to physical page frames. The CPU's Translation Lookaside Buffer (TLB) caches recent page table entries to avoid traversing the hierarchy on every memory access. The TLB has limited capacity: typically 1,024–2,048 entries on modern CPUs.

With 4 KB pages, a 512 GB SGA requires 134,217,728 page table entries. The TLB can cache only a tiny fraction of these. Every SGA access that misses the TLB causes a full page table walk — multiple memory accesses before the real data access begins.

With 2 MB HugePages, the same 512 GB SGA requires only 262,144 entries — 512x fewer. TLB coverage improves dramatically. On large-memory Oracle hosts, HugePages can reduce CPU time spent in TLB misses by 20–40%.

Additional benefits: HugePages memory is **pinned** (never swapped out), **pre-allocated** at boot (no allocation latency at SGA startup), and protected from the OOM killer.

### Calculate HugePages count

\`\`\`bash
# Step 1: Get the current hugepage size on the system
grep Hugepagesize /proc/meminfo
# Typical output: Hugepagesize: 2048 kB  (= 2 MB)

# Step 2: Calculate the number of hugepages needed for the SGA
# Formula: ceil(SGA_bytes / hugepage_size_bytes)
# Example: 128 GB SGA, 2 MB pages:
# 128 * 1024 MB / 2 MB = 65536 hugepages
# Add 5% overhead: 65536 * 1.05 = ~68813, round up to 68900

# Step 3: Check what Oracle actually needs (run while instance is up)
grep -i "HugePages_Total\|HugePages_Free\|HugePages_Rsvd\|HugePages_Surp" /proc/meminfo
# HugePages_Rsvd shows how many are reserved by running Oracle instances
\`\`\`

A helper script from Oracle (available on MOS as Note 401749.1) calculates the exact count by reading the Oracle SGA size from running instances:

\`\`\`bash
#!/bin/bash
# Calculates hugepages needed for all running Oracle instances
KERN=\$(uname -r | awk -F. '{ printf("%d.%d\n",\$1,\$2) }')
HPG_SZ=\$(grep Hugepagesize /proc/meminfo | awk '{print \$2}')
if [ -z "\${HPG_SZ}" ]; then
  echo "ERROR: No Hugepagesize in /proc/meminfo"
  exit 1
fi
NUM_PG=0
for SEG in \$(ipcs -m | awk '{ print \$5 }' | grep "[0-9][0-9]*"); do
  MIN_PG=\$((\${SEG}/\${HPG_SZ}/1024+1))
  if [ \${MIN_PG} -gt 0 ]; then
    NUM_PG=\$((\${NUM_PG}+\${MIN_PG}+1))
  fi
done
echo "Recommended HugePages: \${NUM_PG}"
\`\`\`

### Configure HugePages

\`\`\`bash
# Set in /etc/sysctl.conf (as root)
vm.nr_hugepages = 68900

# Apply immediately (does not require reboot)
sysctl -w vm.nr_hugepages=68900

# Verify allocation succeeded
grep HugePages /proc/meminfo
# HugePages_Total should equal what you set
# If HugePages_Total < nr_hugepages, the system does not have enough
# contiguous physical memory — allocate at boot rather than runtime
\`\`\`

For best results, set \`vm.nr_hugepages\` at boot (in \`/etc/sysctl.conf\`) before any large memory allocations fragment the physical memory pool. At runtime, the kernel may fail to find contiguous 2 MB regions for HugePages if memory is fragmented.

### Allow oracle user to use HugePages

Oracle must run under a group that is permitted to lock huge pages:

\`\`\`bash
# Find the oracle user's primary GID
id oracle
# uid=54321(oracle) gid=54321(oinstall)

# Set the hugepages group to match oracle's group GID
sysctl -w vm.hugetlb_shm_group=54321

# Add to /etc/sysctl.conf permanently:
vm.hugetlb_shm_group=54321

# Also set memlock limit in /etc/security/limits.conf
# (allows oracle to lock the SGA pages in RAM)
oracle soft memlock unlimited
oracle hard memlock unlimited
\`\`\`

### Verify Oracle is using HugePages

After starting the Oracle instance:

\`\`\`bash
grep HugePages /proc/meminfo
# HugePages_Free should drop by the number consumed by Oracle
# HugePages_Rsvd will be non-zero if Oracle reserved but not yet fully mapped

# Confirm from Oracle side
sqlplus -s / as sysdba << 'EOF'
SELECT name, value FROM v\$parameter
WHERE name IN ('use_large_pages', 'sga_target', 'memory_target');

SELECT component, current_size/1073741824 AS current_gb
FROM v\$sga_dynamic_components
ORDER BY current_size DESC;
EOF

# Check Oracle alert log for hugepage confirmation
grep -i "huge\|large page" \$ORACLE_BASE/diag/rdbms/*/*/trace/alert_*.log | tail -10
# Should show: "Using Large Pages"
\`\`\`

### 1 GB HugePages (for very large SGAs)

On servers with SGAs above 256 GB, 1 GB pages (where supported by the CPU and kernel) provide even better TLB coverage. Check support:

\`\`\`bash
grep pdpe1gb /proc/cpuinfo | head -1
# If this returns output, 1 GB pages are supported

# Check if 1 GB hugepages are available
ls /sys/kernel/mm/hugepages/
# Should show: hugepages-1048576kB  hugepages-2048kB

# Configure 1 GB hugepages (must be set at boot — cannot be allocated at runtime)
# Add to GRUB kernel line in /etc/default/grub:
# GRUB_CMDLINE_LINUX="... hugepagesz=1G hugepages=128 default_hugepagesz=1G"
# Then: grub2-mkconfig -o /boot/grub2/grub.cfg && reboot
\`\`\`

---

## Transparent Huge Pages — Disable Completely

Transparent Huge Pages (THP) is a kernel feature that automatically promotes groups of standard 4 KB pages into 2 MB pages for any process. It sounds beneficial but is actively harmful for Oracle Database:

1. **Compaction pauses**: The kernel periodically runs memory compaction to create contiguous 2 MB regions for THP promotion. This compaction causes latency spikes that appear as random GC-like pauses in Oracle and are nearly impossible to diagnose without knowing to look for THP.
2. **Interference with HugePages**: THP and HugePages coexist poorly — the kernel may attempt THP operations on memory adjacent to the HugePages pool.
3. **SGA fragmentation**: THP may fragment the SGA backing pages in ways that degrade sequential access patterns.

\`\`\`bash
# Check current THP state
cat /sys/kernel/mm/transparent_hugepage/enabled
# If output contains [always] or [madvise], THP is active — disable it

cat /sys/kernel/mm/transparent_hugepage/defrag
# Should be [never]

# Disable immediately
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# Verify
cat /sys/kernel/mm/transparent_hugepage/enabled
# Expected: always madvise [never]

# Make persistent across reboots using a systemd unit (more reliable than rc.local):
cat > /etc/systemd/system/disable-thp.service << 'EOF'
[Unit]
Description=Disable Transparent Huge Pages
After=sysinit.target local-fs.target
Before=oracle.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c "echo never > /sys/kernel/mm/transparent_hugepage/enabled"
ExecStart=/bin/sh -c "echo never > /sys/kernel/mm/transparent_hugepage/defrag"
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable disable-thp
systemctl start disable-thp
\`\`\`

---

## Shared Memory Limits

When not using AMM (i.e., using \`SGA_TARGET\` or manual SGA parameters), Oracle allocates the SGA as one or more POSIX shared memory segments. The kernel enforces hard limits on these segments.

### kernel.shmmax — maximum single shared memory segment size

The default (often 32 MB on older kernels, or ULONG_MAX on modern kernels) must be at least as large as the Oracle SGA. Oracle 12c+ typically allocates the entire SGA as a single segment.

\`\`\`bash
# Check current value
sysctl kernel.shmmax
# On modern RHEL/OL 8+: kernel.shmmax = 18446744073692774399 (effectively unlimited)
# On older kernels you may see 33554432 (32 MB) — far too small

# Set to slightly more than the SGA size (bytes)
# Example: 256 GB SGA = 274877906944 bytes
sysctl -w kernel.shmmax=274877906944

# Rule of thumb: set to physical RAM size in bytes if unsure
PHYS_RAM_BYTES=\$(grep MemTotal /proc/meminfo | awk '{print \$2 * 1024}')
sysctl -w kernel.shmmax=\${PHYS_RAM_BYTES}

# Add to /etc/sysctl.conf:
# kernel.shmmax = 274877906944
\`\`\`

### kernel.shmall — total shared memory across all segments (in pages)

\`shmall\` sets the system-wide limit on shared memory in 4 KB pages. Set it to cover the full SGA plus overhead.

\`\`\`bash
# Formula: shmall >= sga_bytes / page_size
# Example: 256 GB SGA, 4 KB pages:
# 256 * 1024 * 1024 * 1024 / 4096 = 67108864 pages

sysctl kernel.shmall
# Modern default is often 18446744073692774399 (effectively unlimited)

# For older kernels, set explicitly:
sysctl -w kernel.shmall=67108864

# /etc/sysctl.conf:
# kernel.shmall = 67108864
\`\`\`

### kernel.shmmni — maximum number of shared memory segments

Oracle 12c with a standard SPFILE allocates relatively few segments (usually 1–4 per instance). The default of 4096 is adequate for most environments. Increase only if running many Oracle instances on the same host.

\`\`\`bash
sysctl kernel.shmmni
# Default: 4096 — sufficient for most deployments
\`\`\`

---

## Semaphore Configuration

Oracle uses System V semaphores for inter-process synchronization between Oracle background processes and server processes. The four values in \`kernel.sem\` define:

\`\`\`
kernel.sem = SEMMSL  SEMMNS  SEMOPM  SEMMNI
              250    32000    100     128
\`\`\`

| Parameter | Meaning | Recommended |
|---|---|---|
| \`SEMMSL\` | Max semaphores per set | \`250\` |
| \`SEMMNS\` | Total semaphores system-wide (\`SEMMSL * SEMMNI\`) | \`32000\` |
| \`SEMOPM\` | Max operations per \`semop()\` call | \`100\` |
| \`SEMMNI\` | Max number of semaphore sets | \`128\` |

For hosts running multiple Oracle instances or RAC, increase \`SEMMNI\` and \`SEMMNS\`:

\`\`\`bash
# Single instance
sysctl -w "kernel.sem=250 32000 100 128"

# Multiple instances or RAC (scale up proportionally)
sysctl -w "kernel.sem=250 131072 100 512"

# /etc/sysctl.conf:
# kernel.sem = 250 32000 100 128
\`\`\`

---

## vm.swappiness — Prevent Unnecessary Swapping

\`vm.swappiness\` controls how aggressively the kernel swaps anonymous memory (process heap, stack) to the swap device when physical memory is under pressure. The default of \`60\` means the kernel starts swapping active memory pages when memory pressure reaches moderate levels.

For a dedicated Oracle host, swapping is catastrophic:
- Swapping out any part of the Oracle SGA causes immediate \`buffer cache\` or \`shared pool\` performance degradation
- SGA pages backed by HugePages cannot be swapped, but PGA memory (sort areas, hash join areas) can be
- The OOM killer targeting Oracle processes is worse than swapping

Set \`vm.swappiness\` to \`1\` (not \`0\` — a value of \`0\` disables swap entirely on older kernels, which can cause OOM kills under extreme pressure):

\`\`\`bash
sysctl -w vm.swappiness=1

# Verify
sysctl vm.swappiness

# Check current swap usage
free -h
swapon --show

# If swap is currently in use, identify what is swapped
for proc in /proc/[0-9]*/status; do
  pid=\$(echo \${proc} | cut -d/ -f3)
  name=\$(grep Name \${proc} | awk '{print \$2}')
  vmswap=\$(grep VmSwap \${proc} 2>/dev/null | awk '{print \$2}')
  if [ -n "\${vmswap}" ] && [ "\${vmswap}" -gt 0 ]; then
    echo "\${vmswap} kB \${pid} \${name}"
  fi
done | sort -rn | head -10
\`\`\`

If the Oracle processes (\`ora_\`) appear in the swap list, increase physical memory or reduce the SGA size.

---

## vm.dirty Page Writeback Tuning

The kernel buffers filesystem writes in "dirty pages" in the page cache before flushing them to disk. For Oracle, the relevant I/O paths are:

- **Redo log writes** — handled directly by LGWR with \`O_DSYNC\`, bypassing the page cache entirely. Not affected by dirty page settings.
- **Datafile I/O** — Oracle uses \`O_DIRECT\` for datafile reads/writes (with ASM or direct I/O filesystems), bypassing the page cache. Not affected by dirty page settings.
- **OS-level I/O** (non-Oracle processes, ext4/xfs journaling) — affected by dirty page settings.

For hosts using ASM or \`O_DIRECT\` filesystems exclusively (which Oracle recommends), the dirty page tuning matters primarily for the OS metadata and logging paths:

\`\`\`bash
# vm.dirty_ratio: % of total RAM that can be dirty before writes are blocked (forced writeback)
# Default: 20 (20% of RAM). For a 512 GB host, that's 100 GB of dirty data before blocking.
# Lower this to limit the burst write penalty:
sysctl -w vm.dirty_ratio=15

# vm.dirty_background_ratio: % of RAM at which background writeback starts
# Default: 10. Keep background flushing active:
sysctl -w vm.dirty_background_ratio=5

# vm.dirty_expire_centisecs: age (in centiseconds) at which dirty data is considered expired
# Default: 3000 (30 seconds). Fine for database hosts.
sysctl -w vm.dirty_expire_centisecs=3000

# vm.dirty_writeback_centisecs: how often the kernel wakes up to flush dirty pages
# Default: 500 (5 seconds). Fine for database hosts.
sysctl -w vm.dirty_writeback_centisecs=500
\`\`\`

**Important**: If Oracle datafiles are on ext4 or xfs without \`O_DIRECT\` (rare but possible with older NFS configurations), set \`vm.dirty_ratio\` aggressively low (5–8%) to prevent a large dirty page buildup that causes a long burst write stall that Oracle experiences as I/O latency.

---

## vm.min_free_kbytes — Reserve Memory for the Kernel

The kernel maintains a reserve of free pages for interrupt handlers and atomic kernel operations. If this reserve is too small on a large-memory host, the kernel can enter memory reclaim paths at inconvenient times, causing latency spikes.

The default is calculated from the zone sizes and is typically a few thousand kilobytes — appropriate for small-memory systems, insufficient for large-memory Oracle hosts.

\`\`\`bash
# Check current value
sysctl vm.min_free_kbytes
# Default might be 45056 (45 MB) on a 512 GB host — too low

# Recommended: approximately 512 MB on hosts with > 128 GB RAM
sysctl -w vm.min_free_kbytes=524288

# Rule of thumb: sqrt(RAM_MB) * 1024 kB, capped at 1 GB
# 512 GB = 524288 MB → sqrt(524288) ≈ 724 → 724 * 1024 ≈ 741376 kB
sysctl -w vm.min_free_kbytes=741376
\`\`\`

---

## NUMA Configuration

Modern multi-socket servers have Non-Uniform Memory Access (NUMA) architecture — each CPU socket has local memory that it accesses faster than memory attached to another socket. On a 2-socket server with 512 GB RAM, each socket has 256 GB of local memory.

Oracle processes that access memory on a remote NUMA node incur a latency penalty (typically 30–50% slower for remote access vs local). The kernel's NUMA balancing policies can cause Oracle SGA pages to migrate between NUMA nodes, introducing unexpected latency spikes.

### Check NUMA topology

\`\`\`bash
numactl --hardware
# Shows: available: 2 nodes (0-1)
# node 0 cpus: 0-19 40-59
# node 0 size: 256000 MB
# node 1 cpus: 20-39 60-79
# node 1 size: 256000 MB
# node distances: 0 1 / 10 21 / 21 10

# Check current NUMA memory allocation for Oracle
numastat -p \$(pgrep -d' ' -f ora_pmon)
\`\`\`

### Disable automatic NUMA balancing for Oracle

NUMA automatic balancing (\`kernel.numa_balancing\`) migrates pages between NUMA nodes to bring them closer to the accessing CPU. For Oracle, this creates unpredictable page migrations of SGA content:

\`\`\`bash
# Check current state
sysctl kernel.numa_balancing
# 0 = disabled, 1 = enabled

# Disable for dedicated Oracle hosts (Oracle manages its own NUMA binding)
sysctl -w kernel.numa_balancing=0

# /etc/sysctl.conf:
# kernel.numa_balancing = 0
\`\`\`

### Disable zone_reclaim_mode

Zone reclaim mode controls whether the kernel reclaims memory from one NUMA zone before allocating from a remote zone. For Oracle, reclaiming local memory to avoid remote allocation can evict SGA pages:

\`\`\`bash
sysctl -w vm.zone_reclaim_mode=0
# 0 = disabled: prefer remote NUMA allocation over evicting local cache pages
# This is the correct setting for database hosts where the working set
# is too large to fit in one NUMA node anyway
\`\`\`

### Run Oracle with numactl for NUMA-aware binding

If Oracle is known to have a working set that fits within one NUMA node, pin it explicitly:

\`\`\`bash
# Bind Oracle startup to NUMA node 0's CPUs and memory
numactl --cpunodebind=0 --membind=0 \${ORACLE_HOME}/bin/oracle &

# For systemd-managed Oracle services:
# Add to the service unit:
# ExecStart=numactl --interleave=all /path/to/oracle_start_script
\`\`\`

For SGAs that span multiple NUMA nodes, use \`--interleave=all\` to distribute SGA pages evenly across all NUMA nodes, which avoids the worst-case scenario where all SGA access goes to a single remote node.

---

## /dev/shm Sizing (for AMM)

If Oracle uses AMM (\`MEMORY_TARGET\` parameter), it allocates both SGA and PGA from \`/dev/shm\`. The default \`/dev/shm\` size is 50% of physical RAM, which may be insufficient if \`MEMORY_TARGET\` plus other users approaches that limit.

\`\`\`bash
# Check current /dev/shm size
df -h /dev/shm
mount | grep shm

# If MEMORY_TARGET = 200 GB on a 256 GB host, /dev/shm must be > 200 GB
# Remount with a larger size (survives until next reboot):
mount -o remount,size=210g /dev/shm

# Make permanent in /etc/fstab:
# Replace existing tmpfs line or add:
# tmpfs  /dev/shm  tmpfs  defaults,size=210g  0 0
\`\`\`

---

## Complete /etc/sysctl.conf Reference

The complete set of kernel memory parameters for an Oracle Database host (adjust values to match your hardware):

\`\`\`bash
# /etc/sysctl.conf — Oracle Database host kernel memory settings

# Shared memory: set to physical RAM size in bytes (example: 256 GB)
kernel.shmmax = 274877906944
kernel.shmall = 67108864
kernel.shmmni = 4096

# Semaphores
kernel.sem = 250 32000 100 128

# HugePages: calculated for your SGA size (example: 128 GB SGA, 2 MB pages)
vm.nr_hugepages = 68900
vm.hugetlb_shm_group = 54321

# Prevent swapping of Oracle processes
vm.swappiness = 1

# Dirty page writeback
vm.dirty_ratio = 15
vm.dirty_background_ratio = 5
vm.dirty_expire_centisecs = 3000
vm.dirty_writeback_centisecs = 500

# Reserve memory for kernel operations (tune for host RAM size)
vm.min_free_kbytes = 524288

# NUMA: disable automatic balancing and zone reclaim for database hosts
kernel.numa_balancing = 0
vm.zone_reclaim_mode = 0

# Memory overcommit: never overcommit (safest for dedicated DB hosts)
vm.overcommit_memory = 2
vm.overcommit_ratio = 95
\`\`\`

Apply all settings:

\`\`\`bash
sysctl -p /etc/sysctl.conf

# Verify each critical parameter
for param in kernel.shmmax kernel.shmall kernel.sem vm.nr_hugepages \\
             vm.swappiness vm.min_free_kbytes kernel.numa_balancing \\
             vm.zone_reclaim_mode; do
  echo "\${param} = \$(sysctl -n \${param})"
done
\`\`\`

---

## vm.overcommit_memory — Memory Overcommit Policy

By default (\`vm.overcommit_memory = 0\`), Linux uses a heuristic to decide whether to grant a memory allocation request. For Oracle, the SGA allocation request is always honored because the SGA is pre-allocated (not virtual). However, OS-level overcommit affects PGA allocations — Oracle server processes request memory for sort areas, hash joins, and PL/SQL local variables.

For dedicated Oracle hosts:

\`\`\`bash
# vm.overcommit_memory = 2: never overcommit beyond overcommit_ratio % of RAM + swap
# This prevents the OOM killer from ever running on this host under normal conditions
sysctl -w vm.overcommit_memory=2

# vm.overcommit_ratio = 95: allow committing up to 95% of RAM + swap
# Leave 5% as headroom for the kernel and burst allocations
sysctl -w vm.overcommit_ratio=95

# With these settings, total committed virtual memory cannot exceed:
# (physical_ram * 0.95) + swap_space
# Ensure this covers SGA + max expected PGA + OS overhead
\`\`\`

---

## Verification Checklist

\`\`\`bash
echo "=== Oracle Kernel Memory Configuration Verification ==="

echo "--- HugePages ---"
grep -E "HugePages_Total|HugePages_Free|HugePages_Rsvd|Hugepagesize" /proc/meminfo

echo "--- Transparent Huge Pages ---"
echo "enabled: \$(cat /sys/kernel/mm/transparent_hugepage/enabled)"
echo "defrag:  \$(cat /sys/kernel/mm/transparent_hugepage/defrag)"

echo "--- Shared Memory ---"
echo "shmmax: \$(sysctl -n kernel.shmmax)"
echo "shmall: \$(sysctl -n kernel.shmall)"

echo "--- Semaphores ---"
sysctl kernel.sem

echo "--- Swap ---"
echo "swappiness: \$(sysctl -n vm.swappiness)"
free -h | grep -E "Mem|Swap"

echo "--- NUMA ---"
echo "numa_balancing:    \$(sysctl -n kernel.numa_balancing)"
echo "zone_reclaim_mode: \$(sysctl -n vm.zone_reclaim_mode)"
numactl --hardware 2>/dev/null | grep "node [0-9] size"

echo "--- min_free_kbytes ---"
echo "\$(sysctl -n vm.min_free_kbytes) kB"
\`\`\`

Expected output on a correctly configured Oracle host:

\`\`\`
HugePages_Total: 68900   ← matches your configured value
HugePages_Free:  3356    ← non-zero only before Oracle allocates
HugePages_Rsvd:  65544   ← Oracle has reserved these
enabled: always madvise [never]    ← THP disabled
defrag:  always defer defer+madvise [never]
swappiness: 1
numa_balancing: 0
zone_reclaim_mode: 0
\`\`\`

---

## Summary

The most impactful memory configuration changes for an Oracle Database host are, in order of impact:

1. **Disable Transparent Huge Pages** — this alone eliminates an entire class of unpredictable latency spikes
2. **Configure HugePages** — dramatically reduces TLB pressure on large-SGA instances
3. **Set vm.swappiness = 1** — prevents Oracle PGA from being swapped out under memory pressure
4. **Disable NUMA automatic balancing** — prevents random SGA page migrations on multi-socket hosts
5. **Set vm.zone_reclaim_mode = 0** — prevents local cache eviction in favor of remote NUMA allocation
6. **Size kernel.shmmax correctly** — without this, Oracle may fail to start on older kernels

These settings should be applied before Oracle is installed, verified after installation, and confirmed to persist across reboots. They are the non-negotiable baseline for any Oracle Database host, regardless of database size, workload type, or deployment model.`,
};

async function main() {
  console.log('Inserting Linux kernel memory post...');
  await db.insert(posts).values(post).onConflictDoNothing();
  console.log(`Inserted: "${post.title}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
