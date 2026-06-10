import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Exadata and Exalogic: Engineered Systems Architecture and Administration',
  slug: 'oracle-exadata-exalogic-architecture',
  excerpt:
    'A technical overview of Oracle Exadata Database Machine and Oracle Exalogic Elastic Cloud — covering the Exadata hardware stack, Smart Scan offloading, Storage Indexes, IORM resource management, the InfiniBand fabric, Exalogic WebLogic deployment architecture, and the administration tasks that are unique to engineered systems.',
  category: 'exadata' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-11'),
  youtubeUrl: null,
  content: `Oracle's Engineered Systems — Exadata and Exalogic — are pre-integrated, pre-tested hardware and software stacks designed to eliminate the tuning and integration work that consumes most of a DBA or middleware administrator's time. Understanding what makes them different from commodity hardware is essential to administering them effectively.

---

## Oracle Exadata Database Machine

### Hardware Stack

An Exadata rack contains two categories of nodes connected by a private InfiniBand fabric:

\`\`\`
┌─────────────────────────────────────────────────────┐
│                  Exadata Rack                       │
│                                                     │
│  ┌──────────────┐  ┌──────────────┐                 │
│  │ DB Node 1    │  │ DB Node 2    │  ... (up to 8)  │
│  │ (compute)    │  │ (compute)    │                 │
│  │ Oracle DB    │  │ Oracle DB    │                 │
│  │ Oracle RAC   │  │ Oracle RAC   │                 │
│  └──────┬───────┘  └──────┬───────┘                 │
│         │                 │                         │
│         └────────┬────────┘                         │
│                  │ InfiniBand (40 Gb/s)             │
│         ┌────────┴────────┐                         │
│  ┌──────┴──────┐  ┌───────┴─────┐                   │
│  │ Storage     │  │ Storage     │  ... (up to 14)   │
│  │ Server 1    │  │ Server 2    │                   │
│  │ - Exadata   │  │ - Exadata   │                   │
│  │   Storage   │  │   Storage   │                   │
│  │   Software  │  │   Software  │                   │
│  │ - Flash     │  │ - Flash     │                   │
│  │ - Hard disk │  │ - Hard disk │                   │
│  └─────────────┘  └─────────────┘                   │
└─────────────────────────────────────────────────────┘
\`\`\`

**Database Nodes (Compute):** Standard x86 servers running Oracle Linux, Oracle RAC, and ASM. These are where SQL execution, PGA sorts, and buffer cache live. Each node has significant RAM (typically 512 GB–1.5 TB per node on current hardware) and NVMe flash for local swap and temporary storage.

**Storage Servers (Cells):** Intelligent storage nodes running Oracle Exadata Storage Server Software (the "cell" software). They contain NVMe flash and high-capacity hard disks exposed to the DB nodes via ASM over InfiniBand. The intelligence is in the cell software — not the disks themselves.

**InfiniBand Fabric:** The private interconnect between DB nodes and storage cells. Full-rack configurations have 40 Gb/s per link with redundant switches. InfiniBand is also used for Oracle RAC Cache Fusion (node-to-node block transfer), replacing the standard GigE interconnect used in commodity RAC.

### Exadata Storage Server Software

The cell software is where Exadata's performance advantage lives. It implements:

**Smart Scan** — full table scans are offloaded to the storage cells. Instead of shipping raw blocks to the DB node (which then applies the WHERE clause), the cell software applies predicates, projections, and column filters *at the storage layer*. Only the matching rows and requested columns traverse InfiniBand. On large analytical queries, this reduces the data transferred to the DB node by 10–100x.

\`\`\`sql
-- Smart Scan is used when the query optimizer chooses a full scan
-- and the segment is stored on Exadata cells
-- Watch for these in execution plans:
-- TABLE ACCESS STORAGE FULL  ← Smart Scan in use
-- TABLE ACCESS FULL          ← Smart Scan not used (e.g., small table, index used)
\`\`\`

**Storage Indexes** — the cell automatically maintains a min/max index per 1 MB storage region for each column referenced in WHERE clauses. If a query's predicate cannot match any row in a region, that region is skipped entirely — no I/O, no InfiniBand traffic. Storage Indexes are built automatically and maintained in cell memory. They persist across cell reboots but are rebuilt if the cell is reimaged.

**Hybrid Columnar Compression (HCC)** — a storage-level compression technology available only on Exadata (and Exadata Cloud). HCC groups similar column values together across rows before compressing, achieving 10–50x compression on warehouse workloads. It requires the data to be loaded in bulk (direct path INSERT, CTAS, or \`ALTER TABLE MOVE COMPRESS\`) — HCC blocks are not updated in place; updates trigger decompression to OLTP compression.

| HCC Level | Compression | Performance |
|-----------|------------|-------------|
| QUERY HIGH | Highest | Best for read-only warehouse |
| QUERY LOW | High | Read-mostly, moderate updates |
| ARCHIVE HIGH | Maximum | Cold data, minimal queries |
| ARCHIVE LOW | Very high | Cold data |

**I/O Resource Manager (IORM)** — controls how storage I/O is allocated across databases, pluggable databases, or consumer groups sharing an Exadata system. IORM prevents one database from monopolising storage bandwidth.

---

## Exadata Configuration Models

| Model | Rack Configuration | Typical Use |
|-------|-------------------|-------------|
| Full Rack | 8 DB nodes + 14 storage cells | Large OLTP or DW workloads |
| Half Rack | 4 DB nodes + 7 storage cells | Mid-size workloads |
| Quarter Rack | 2 DB nodes + 3 storage cells | Entry-level, dev/test |
| Eighth Rack | 2 DB nodes + 3 storage cells (lower specs) | Dev/test, small prod |
| X10M, X9M, X8M | Latest generations with NVMe flash only | Current purchase |

### Smart Flash Cache

Each storage cell includes NVMe flash accelerating reads for frequently accessed data. The Smart Flash Cache works transparently — the database does not need to be configured differently. Oracle Database reads that miss the buffer cache go to the flash tier before hitting the hard disk tier.

---

## Exadata Administration Specifics

### Cell CLI (cellcli)

The primary administration interface for storage cells is \`cellcli\`, run directly on each cell node via SSH.

\`\`\`bash
# SSH to a storage cell
ssh root@cell01

# Start cellcli
cellcli

# List all disk groups
CellCLI> LIST CELLDISK

# Check cell status
CellCLI> LIST CELL DETAIL

# Check flash cache size and utilisation
CellCLI> LIST FLASHCACHE DETAIL

# Check for cell alerts
CellCLI> LIST ALERTHISTORY
\`\`\`

### dcli — Run Commands Across All Cells

\`\`\`bash
# Run a cellcli command across all cells simultaneously
dcli -g /opt/oracle.SupportTools/hostgroups/cell_group \
  cellcli -e "LIST CELL ATTRIBUTES name, status, cellVersion"
\`\`\`

The \`/opt/oracle.SupportTools/hostgroups/\` directory contains pre-built host group files for \`dcli\` targeting all DB nodes (\`dbs_group\`) or all cells (\`cell_group\`).

### Smart Scan Eligibility

Smart Scan only fires under specific conditions. Common reasons it is bypassed:

- The segment is cached in the DB node's buffer cache (Smart Scan reads direct, bypassing cache)
- The table is small (optimizer chooses index or cached full scan)
- The query uses a non-storage-eligible function on the predicate column
- Row chaining or migration is present
- Direct NFS or non-Exadata storage

\`\`\`sql
-- Check Smart Scan statistics for a session
SELECT metric_name, value
FROM   v\$sql_plan_monitor
WHERE  sql_id = '&sql_id'
  AND  metric_name LIKE '%smart%';

-- Cell offload statistics at instance level
SELECT name, value
FROM   v\$sysstat
WHERE  name IN (
    'cell physical IO bytes eligible for predicate offload',
    'cell physical IO bytes saved by storage index',
    'cell physical IO interconnect bytes returned by smart scan'
);
\`\`\`

---

## Oracle Exalogic Elastic Cloud

Exalogic is Oracle's engineered system for Java middleware — specifically Oracle WebLogic Server and Oracle Coherence. It is a full-rack appliance containing compute nodes, InfiniBand networking, and Sun ZFS Storage Appliance (ZFSSA) shared storage.

### Exalogic Hardware

\`\`\`
┌──────────────────────────────────────────────────┐
│              Exalogic Full Rack                  │
│                                                  │
│  30 Compute Nodes (x86, 256 GB RAM each)         │
│  - Oracle Linux                                  │
│  - Oracle WebLogic Domain(s)                     │
│  - Oracle Coherence Cache Cluster                │
│                                                  │
│  2 × Sun ZFS Storage Appliances (ZFSSA)          │
│  - NFS shared storage for WebLogic domain        │
│  - WebLogic deployment artifacts                 │
│  - Coherence persistence (optional)              │
│                                                  │
│  InfiniBand fabric (QDR, 40 Gb/s)               │
│  - Compute-to-storage                            │
│  - Coherence cache cluster interconnect          │
│  - Exalogic-to-Exadata connectivity              │
│                                                  │
│  Cisco GigE switches (client-facing network)     │
└──────────────────────────────────────────────────┘
\`\`\`

### Exalogic WebLogic Architecture

Exalogic is designed for large-scale WebLogic clusters running Oracle Fusion Middleware, Oracle SOA Suite, Oracle ADF applications, or Oracle E-Business Suite R12.2.

**Key design pattern — single WebLogic domain spanning all 30 compute nodes:**
- Administration Server on a dedicated node
- Managed servers distributed across remaining nodes
- Node Manager on every compute node
- Shared domain directory on ZFSSA (all nodes mount the same NFS share)

\`\`\`
Admin Server (node01)
       │
       │ (NFS — ZFSSA)
       │ shared domain directory
       │
├── Managed Server cluster — node02–node30
│   ├── soa_server1  (node02)
│   ├── soa_server2  (node03)
│   ├── ...
│   └── soa_server29 (node30)
\`\`\`

### Oracle Coherence on Exalogic

Exalogic includes Oracle Coherence, a distributed in-memory data grid. On Exalogic, Coherence uses InfiniBand for cluster communication — cache invalidation, entry replication, and partition recovery all happen at 40 Gb/s, making large cache clusters practical.

Common Exalogic+Coherence patterns:
- HTTP session caching for WebLogic clusters (session affinity no longer required)
- Application data caching to reduce database load
- Near-cache for frequently-read reference data (country codes, product catalogue)

### Exalogic-to-Exadata Connectivity

Exalogic and Exadata racks are typically connected at the InfiniBand layer, not via GigE. This means JDBC connections from WebLogic on Exalogic to Oracle Database on Exadata traverse the InfiniBand fabric — sub-millisecond latency, full bandwidth.

\`\`\`
Exalogic (WebLogic)                Exadata (Oracle DB)
  soa_server1                         RAC Node 1
  soa_server2    ←── InfiniBand ──→   RAC Node 2
  soa_server3                         RAC Node 3
\`\`\`

This topology is unique to engineered systems — commodity WebLogic + commodity Oracle Database would use a regular network switch.

---

## Patching Engineered Systems

Patching Exadata and Exalogic follows Oracle's Engineered Systems patching process, distinct from standard Oracle Database patching:

**Exadata:** patches are applied using \`patchmgr\` (the Exadata patch manager) which coordinates rolling patches across DB nodes and cells. Quarterly Exadata Bundle Patches include OS updates, cell software updates, and Oracle Database patches in a single tested bundle.

**Exalogic:** patches are applied using OECA (Exalogic Configuration Assistant) and standard WebLogic/FMW patching tools. The ZFSSA firmware is patched separately.

Critical difference from commodity patching: Exadata bundle patches are tested as an integrated stack. Applying an individual Oracle Database patch from My Oracle Support to an Exadata DB node without using the bundle process is unsupported and voids the engineered system warranty.

The companion runbook covers the Exadata health check procedure, Smart Scan validation, IORM configuration, storage cell administration via \`cellcli\`, and the Exalogic WebLogic cluster health check process.`,
};

async function main() {
  console.log('Inserting Exadata/Exalogic blog post...');
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
