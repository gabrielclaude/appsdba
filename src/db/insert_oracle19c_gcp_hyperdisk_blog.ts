import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle 19c on RHEL 9 and Google Cloud: Hyperdisk Extreme for Redo Logs, PD-SSD for Data and Index Tablespaces',
  slug: 'oracle-19c-rhel9-gcp-hyperdisk-extreme-redo',
  excerpt:
    'A technical guide to storage architecture for Oracle 19c on Google Cloud RHEL 9 — why redo log write latency is commit latency and demands Hyperdisk Extreme, how Hyperdisk Extreme IOPS and throughput provisioning works, why PD-SSD covers data and index tablespace I/O patterns cost-effectively, GCP block storage tier comparison, Oracle FILESYSTEMIO_OPTIONS for direct I/O on GCP, redo log sizing and multiplexing strategy, and the monitoring approach for redo write latency and disk IOPS on GCP.',
  category: 'oracle-google-cloud' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-25'),
  youtubeUrl: null,
  content: `## Overview

Oracle database performance on any platform is governed by two I/O profiles that are fundamentally different: **redo log writes** and **data file I/O**. Redo log writes are small, frequent, synchronous, and on the critical path of every database commit — any storage latency on the redo path adds directly to user-visible response time. Data file I/O is asynchronous, can be batched, and benefits far more from throughput than from raw write latency. Treating both with the same storage tier wastes money in one direction (overprovisioning data file storage with ultra-low latency) while creating a hidden bottleneck in the other (redo logs waiting behind data file writes on a shared tier).

Google Cloud's storage portfolio — Hyperdisk Extreme, Hyperdisk Balanced, and Persistent Disk SSD — maps cleanly to these two profiles. This post explains the I/O profiles in detail, how Google Cloud block storage tiers perform against each profile, and the configuration decisions that translate this understanding into an Oracle 19c on RHEL 9 deployment that performs predictably under production load.

---

## Google Cloud Block Storage Options for Oracle

Google Cloud offers multiple block storage products with meaningfully different performance characteristics:

| Product | Type | IOPS (max per disk) | Latency | Throughput | Best For |
|---------|------|---------------------|---------|-----------|----------|
| Hyperdisk Extreme | NVMe | 350,000 | Sub-millisecond | 3,600 MB/s | Redo logs, critical latency paths |
| Hyperdisk Balanced | NVMe | 160,000 | Low | 2,400 MB/s | Data files, OLTP tablespaces |
| Hyperdisk Throughput | HDD-class | 7,200 | Moderate | 2,400 MB/s | Archive logs, batch sequential reads |
| PD-SSD | NVMe | 100,000 | Low | 1,200 MB/s | Data files, indexes, general Oracle |
| PD-Balanced | NVMe | 80,000 | Low | 1,200 MB/s | Dev/test, non-critical tablespaces |
| PD-Standard | Magnetic | 3,000 | High | 400 MB/s | Archive logs, cold backup storage |

**Hyperdisk Extreme** is distinct from all other options because its IOPS and throughput are **provisioned independently of capacity**. A 200 GB Hyperdisk Extreme disk can be provisioned with 100,000 IOPS — something that would require a 6 TB PD-SSD to reach at the 16.5 IOPS/GB PD-SSD ratio. This decoupling of capacity from performance is critical for redo logs, which are small in size (typically 1–10 GB total) but require maximum IOPS headroom.

### VM-Level IOPS and Throughput Limits

Disk-level IOPS limits are per-disk, but the VM also has an aggregate IOPS and throughput ceiling across all attached disks. For Oracle workloads, machine types with high per-VM limits matter:

| Machine Type | vCPUs | Max Total Disk IOPS | Max Total Throughput |
|-------------|-------|--------------------|--------------------|
| n2-highmem-16 | 16 | 160,000 | 1,600 MB/s |
| n2-highmem-32 | 32 | 240,000 | 2,400 MB/s |
| n2-highmem-64 | 64 | 350,000 | 3,500 MB/s |
| c2-standard-16 | 16 | 100,000 | 800 MB/s |
| c2-standard-30 | 30 | 160,000 | 1,600 MB/s |

If the VM's aggregate limit is lower than the sum of provisioned disk limits, the VM becomes the bottleneck regardless of how much IOPS is provisioned on the Hyperdisk. Size the VM machine type first, then provision disk IOPS up to the VM's ceiling.

---

## Why Redo Log Latency Is Commit Latency

The Oracle Log Writer (LGWR) is the background process responsible for writing the redo log buffer to redo log files on disk. LGWR writes are triggered by:

- A user process issuing \`COMMIT\`
- The redo log buffer becoming one-third full
- A \`DBWR\` write is about to start (LGWR must write first)
- Three seconds elapse (background checkpoint)

The critical path is the commit trigger: **a user's \`COMMIT\` call does not return to the application until LGWR has written the corresponding redo to disk and acknowledged the write**. This means:

\`\`\`
Application calls COMMIT
  → Oracle finds uncommitted redo in the log buffer
  → LGWR issues a write to the redo log file
  → LGWR waits for the I/O to complete (log file parallel write wait event)
  → LGWR signals the user process
  → COMMIT returns to the application
\`\`\`

If the redo log write takes 2 ms on a PD-SSD, every commit takes at least 2 ms — regardless of how fast the rest of the SQL executed. On Hyperdisk Extreme with sub-millisecond write latency, that 2 ms drops to 0.1–0.3 ms, reducing commit latency by 85–95%.

For OLTP workloads with thousands of commits per second, the difference compounds:
- 2 ms commit latency × 1,000 commits/second = 2 seconds of commit wait accumulating per second (bottleneck)
- 0.2 ms commit latency × 1,000 commits/second = 0.2 seconds of commit wait per second (manageable)

### The log file sync Wait Event

In Oracle, the \`log file sync\` wait event captures exactly this cost: it is the time a user session spends waiting for LGWR to write its redo and signal back. High average wait times on \`log file sync\` are the primary diagnostic indicator of a redo log storage bottleneck. Hyperdisk Extreme's sub-millisecond write latency minimizes this wait class directly.

---

## Why Data File I/O Is Asynchronous and Latency-Tolerant

The Oracle Database Writer (DBWR) writes dirty buffers from the buffer cache to data files on disk. Unlike LGWR, DBWR writes are:

**Asynchronous**: DBWR does not hold any user session waiting for its write to complete. User sessions submit write requests to DBWR and continue executing. DBWR batches and issues writes independently.

**Deferred**: Blocks are only written when they age out of the buffer cache (LRU eviction), when a checkpoint occurs, or when free buffer space is needed. A buffer that was modified 50 times stays in cache through all 50 modifications and is written to disk once.

**Throughput-driven not latency-driven**: DBWR's performance characteristic is **MB/s written**, not write latency per I/O. A disk that writes at 500 MB/s with 5 ms latency outperforms a disk that writes at 200 MB/s with 0.5 ms latency for DBWR workloads — because DBWR issues large batched writes where throughput dominates.

Data file **reads** (cache misses causing physical I/O) do have latency sensitivity — a user query that needs a block not in cache must wait for the physical read to complete. But PD-SSD provides 1–3 ms read latency at its IOPS range, which is acceptable for production OLTP. The extreme sub-millisecond latency of Hyperdisk Extreme provides minimal incremental benefit for data file reads while costing significantly more per GB.

---

## Storage Tier Mapping for Oracle 19c on GCP

Based on the I/O profiles above, the storage tier assignment is:

| Oracle Storage Component | GCP Storage Tier | Rationale |
|--------------------------|-----------------|-----------|
| Redo log files | Hyperdisk Extreme | Synchronous writes on commit critical path; sub-ms latency required |
| Standby redo logs (Data Guard) | Hyperdisk Extreme | Same write path as online redo |
| Data files (SYSTEM, SYSAUX, UNDO) | PD-SSD | Asynchronous writes; random read latency acceptable at 1–3 ms |
| Data tablespace files | PD-SSD | DBWR throughput-driven; PD-SSD throughput is sufficient |
| Index tablespace files | PD-SSD | Index range scans benefit from PD-SSD random read IOPS |
| TEMP tablespace | PD-SSD | Sort spills are random I/O; PD-SSD handles well |
| Fast Recovery Area (FRA) | PD-Balanced | Archive logs are sequential writes; balanced cost vs performance |
| Archive log destination | PD-Balanced | Same as FRA — sequential, throughput-oriented |
| Oracle binaries (ORACLE_HOME) | PD-Balanced | Mostly reads, not I/O sensitive |

---

## Hyperdisk Extreme Provisioning Strategy for Redo Logs

Redo logs are small but must have IOPS headroom to avoid queuing. Sizing:

**Disk capacity**: Redo log groups are typically 512 MB to 4 GB each. With 4 groups × 2 members, total redo log storage is 4–32 GB. A 100–200 GB Hyperdisk Extreme disk provides ample capacity with significant headroom.

**IOPS provisioning**: LGWR write size varies from 8 KB (light commit) to several MB (heavy batch commit). At 100,000 IOPS × 8 KB average write = 800 MB/s throughput potential. For Oracle OLTP with up to 5,000 commits/second, provisioning 50,000–100,000 IOPS on the redo disk eliminates LGWR queuing under all but the most extreme loads.

**Throughput provisioning**: Hyperdisk Extreme minimum throughput is 2,400 MB/s at maximum configuration. For redo logs, 1,000 MB/s provisioned throughput is sufficient for most production OLTP loads. Scale up if the workload generates more than 500 MB/s of sustained redo.

---

## Oracle Direct I/O on GCP Block Storage

Oracle on Linux should use direct I/O (bypassing the OS page cache) for data files and redo logs. This avoids double-buffering — Oracle's buffer cache is already managing memory for data blocks, and the page cache would simply duplicate that at the OS level, wasting memory and adding latency.

The \`FILESYSTEMIO_OPTIONS\` initialization parameter controls Oracle's I/O behaviour on filesystem-mounted block devices:

| Value | Behaviour |
|-------|-----------|
| \`NONE\` | Buffered I/O through OS page cache (default, not recommended for Oracle) |
| \`DIRECTIO\` | Direct I/O for data files only |
| \`ASYNCH\` | Asynchronous I/O using Linux AIO (libaio) |
| \`SETALL\` | Direct I/O + Asynchronous I/O (recommended for Oracle on GCP) |

\`SETALL\` is the recommended setting for Oracle on GCP because:
- Direct I/O eliminates the page cache overhead, exposing the full Hyperdisk Extreme latency advantage
- Asynchronous I/O allows DBWR to issue multiple concurrent writes without blocking, maximizing PD-SSD throughput utilization

---

## Redo Log Sizing and Multiplexing on GCP

### Log Group Sizing

Small redo log files cause frequent log switches. Each log switch triggers a checkpoint, which causes DBWR to flush dirty buffers to data files — this creates I/O spikes on the data disk and momentary LGWR pauses during the archive phase. Best practice on GCP with Hyperdisk Extreme:

- Minimum redo log size: **512 MB per group member**
- Recommended for OLTP: **1 GB–4 GB per group member**
- Target log switch frequency: **1 switch per 15–30 minutes** (adjust log size to achieve this)
- Minimum groups: 4 (3 is the Oracle minimum, but 4 provides headroom for archiving lag)

### Multiplexing Approach on GCP

Traditional Oracle multiplexing (placing redo members on different physical disks) protects against disk failure. On GCP, all Persistent Disk types are already replicated internally by Google — a single Hyperdisk Extreme disk is durable without multiplexing. However:

- Oracle Multimedia and some Oracle tools require at least 2 members per group
- Multiplexing still protects against Oracle-level file corruption (not disk failure)
- Recommended: **2 members per group** — both members on the Hyperdisk Extreme disk (GCP durability handles disk failure; the two members protect against file-level corruption)

For environments with Data Guard, standby redo logs must also be created, ideally on the same Hyperdisk Extreme disk, sized identically to the online redo logs.

---

## Performance Monitoring for Oracle on GCP

Two monitoring planes are required: Oracle-internal wait event monitoring, and GCP-level disk IOPS/throughput monitoring.

**Oracle wait event targets for a well-configured GCP deployment**:

| Wait Event | Acceptable Average | Action if Exceeded |
|------------|-------------------|-------------------|
| \`log file sync\` | < 1 ms | Check Hyperdisk Extreme IOPS provisioning; check LGWR scheduling |
| \`log file parallel write\` | < 0.5 ms | Directly indicates redo disk latency |
| \`db file sequential read\` | < 3 ms | Check PD-SSD IOPS utilization; may need more provisioned capacity |
| \`db file scattered read\` | < 5 ms | Typically full table scan; may be query plan issue, not storage |
| \`db file parallel write\` | < 5 ms | DBWR write latency; PD-SSD is acceptable if not sustained |

**GCP Cloud Monitoring metrics to watch**:
- \`compute.googleapis.com/instance/disk/write_ops_count\` — per-disk IOPS
- \`compute.googleapis.com/instance/disk/write_bytes_count\` — per-disk throughput
- \`compute.googleapis.com/instance/disk/average_io_latency\` — per-disk average latency

---

## Summary

Oracle 19c on Google Cloud RHEL 9 performs best when storage tiers match I/O profiles precisely. Redo logs require Hyperdisk Extreme because LGWR writes are synchronous and on the commit critical path — every millisecond of redo write latency adds directly to user-visible commit response time. Data file and index tablespace I/O is asynchronous (DBWR), throughput-sensitive rather than latency-sensitive, and well served by PD-SSD at a fraction of Hyperdisk Extreme's cost. Hyperdisk Extreme's IOPS and throughput are provisioned independently of disk capacity — a 200 GB disk can carry 100,000 IOPS — which makes it practical to use for redo logs, which are small in size but enormous in I/O demand. Oracle's \`FILESYSTEMIO_OPTIONS=SETALL\` configures direct and asynchronous I/O, exposing the full latency advantage of Hyperdisk Extreme to LGWR while allowing DBWR to maximise PD-SSD throughput via concurrent async writes. The companion runbook provides the complete GCP disk creation commands, RHEL 9 mount procedures with direct I/O options, Oracle 19c installation and DBCA with the tiered storage layout, Oracle initialization parameters for GCP, redo log and tablespace creation SQL, and crontab monitoring scripts for redo write latency, log switch frequency, and disk IOPS utilization.`,
};

async function main() {
  console.log('Inserting Oracle 19c GCP Hyperdisk blog post...');
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
