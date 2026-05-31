import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle GoldenGate Architecture: Capture Modes, Apply Modes, and Topology Patterns',
  slug: 'goldengate-capture-apply-topology-modes',
  excerpt:
    'A practical breakdown of how Oracle GoldenGate processes operate across its three replication phases — Capture, Routing, and Apply — covering Classic vs Integrated Capture, all four Replicat modes, and the three core topology patterns with configuration examples.',
  category: 'golden-gate' as const,
  published: true,
  publishedAt: new Date('2026-05-31'),
  youtubeUrl: null,
  content: `Oracle GoldenGate (OGG) is Oracle's flagship real-time replication platform. Its flexibility comes from a layered architecture: three distinct replication phases — **Capture**, **Routing**, and **Apply** — each with its own set of operating modes that you select based on your database version, workload characteristics, and availability requirements.

Understanding which mode combination to choose before you build your first Extract and Replicat group will save you significant rework later.

---

## The Three Phases at a Glance

Before diving into modes, it helps to map the full data path:

- **Capture (Extract)** reads committed change records directly from the database redo stream and writes them to trail files.
- **Routing (Data Pump / Collector)** moves trail files from the source system to the target, optionally filtering and transforming in transit.
- **Apply (Replicat)** reads trail files on the target and replays changes against the target database.

Each phase is independently configurable. You can combine Integrated Capture with Classic Replicat, or Classic Capture with Parallel Replicat — the modes are orthogonal.

---

## 1. Capture Modes

### Classic Capture

Classic Capture is the original OGG architecture. The Extract process connects directly to the database as a privileged user and reads redo and archive log files at the operating system level.

\`\`\`
-- GGSCI: add a Classic Extract
DBLOGIN USERID ggadmin PASSWORD ggpassword
ADD EXTRACT ext_classic, TRANLOG, BEGIN NOW
ADD EXTTRAIL ./dirdat/lt, EXTRACT ext_classic, MEGABYTES 500
\`\`\`

Classic Extract parameter file (\`dirprm/ext_classic.prm\`):

\`\`\`
EXTRACT ext_classic
USERID ggadmin@ORCL, PASSWORD ggpassword
EXTTRAIL ./dirdat/lt
TRANLOGOPTIONS DBLOGREADER
TABLE hr.*;
TABLE oe.orders;
\`\`\`

**When to use Classic Capture:**
- Oracle Database versions below 11.2.0.4 (logmining server not available)
- Non-CDB single-instance databases on complex storage (ASM raw volumes, third-party clustering)
- When the logmining server is unavailable due to licensing or DBA policy
- Downstream capture scenarios where the Extract runs on a separate host reading archived logs

**Limitations:**
- Reads raw redo log blocks — tightly coupled to Oracle internal log format changes
- Limited support for certain LOB types and XML storage
- Requires direct OS-level access to log files or ASM disk groups

---

### Integrated Capture

Integrated Capture delegates log mining to the Oracle Database **logmining server** (introduced in 11.2.0.4, matured in 12c+). Instead of reading raw redo blocks, the Extract receives pre-parsed **Logical Change Records (LCRs)** from Oracle's internal change capture engine.

\`\`\`
-- GGSCI: add an Integrated Extract
DBLOGIN USERID ggadmin@ORCL PASSWORD ggpassword
ADD EXTRACT ext_int, INTEGRATED TRANLOG, BEGIN NOW
ADD EXTTRAIL ./dirdat/li, EXTRACT ext_int, MEGABYTES 500
REGISTER EXTRACT ext_int DATABASE
\`\`\`

Integrated Extract parameter file (\`dirprm/ext_int.prm\`):

\`\`\`
EXTRACT ext_int
USERID ggadmin@ORCL, PASSWORD ggpassword
EXTTRAIL ./dirdat/li
LOGALLSUPCOLS
TABLE hr.*;
TABLE oe.*;
\`\`\`

The \`REGISTER EXTRACT\` command is critical — it registers the Extract as a logmining client with the database, ensuring Oracle retains redo logs until the Extract has consumed them. Without it, needed logs can be purged by RMAN.

**When to use Integrated Capture:**
- Oracle 12c and later (strongly recommended as default)
- Multitenant (CDB/PDB) environments — required for PDB-level extraction
- Tables with SecureFile LOBs, XMLType stored as binary XML, or compressed segments
- Oracle GoldenGate Microservices Architecture (MA) deployments
- Environments where the DBA prefers Oracle to manage supplemental logging automatically

**Advantages over Classic:**
- Oracle manages supplemental logging through \`LOGALLSUPCOLS\` — no per-table DDL required
- Handles internal data type conversions transparently
- Survives RAC node failover and switchover without manual intervention
- Performance scales with the logmining server's parallel mining capability

---

## 2. Apply Modes

### Classic Replicat

Classic Replicat is a single-threaded process. It reads trail records sequentially and applies them to the target using standard SQL via OCI, one transaction at a time.

\`\`\`
-- GGSCI
DBLOGIN USERID ggadmin@TARGET PASSWORD ggpassword
ADD REPLICAT rep_classic, EXTTRAIL ./dirdat/rt
\`\`\`

Classic Replicat parameter file (\`dirprm/rep_classic.prm\`):

\`\`\`
REPLICAT rep_classic
TARGETDB target@tns, USERID ggadmin, PASSWORD ggpassword
ASSUMETARGETDEFS
MAP hr.employees, TARGET hr.employees;
MAP oe.orders,    TARGET oe.orders;
\`\`\`

**When to use Classic Replicat:**
- Small databases or low-volume change streams
- Strict ordered apply requirements where transaction sequence must be preserved exactly
- Target databases on non-Oracle platforms (MySQL, SQL Server, PostgreSQL) — Parallel and Integrated modes are Oracle-target only
- Simple lab or development environments

**Limitation:** Throughput is bounded by a single thread. In high-TPS environments, Classic Replicat becomes the bottleneck.

---

### Coordinated Replicat

Coordinated Replicat introduces parallelism without the logmining dependency of Integrated mode. A coordinator thread reads the trail and dispatches independent transactions to a configurable pool of apply sub-threads. Dependent transactions (those that share keys or modified the same rows) are routed to the same sub-thread to preserve integrity.

\`\`\`
-- GGSCI
ADD REPLICAT rep_coord, EXTTRAIL ./dirdat/rt, COORDINATED, MAXTHREADS 8
\`\`\`

Coordinated Replicat parameter file (\`dirprm/rep_coord.prm\`):

\`\`\`
REPLICAT rep_coord
TARGETDB target@tns, USERID ggadmin, PASSWORD ggpassword
MAXTHREADS 8
THREADSOPTIONS MAXCOMMITPROPAGATIONDELAY 500
ASSUMETARGETDEFS
MAP hr.*, TARGET hr.*;
\`\`\`

The \`MAXCOMMITPROPAGATIONDELAY\` parameter (in milliseconds) controls how long a sub-thread waits before committing, allowing short-running dependent transactions to batch together.

**When to use Coordinated Replicat:**
- Oracle target databases that do not support Integrated Replicat (pre-12c targets)
- Scenarios requiring parallelism without the overhead of the apply server infrastructure
- Medium-to-high TPS environments with good transaction independence (few hot rows)

---

### Integrated Replicat

Integrated Replicat, like Integrated Capture, leverages Oracle database internals. Instead of issuing SQL via OCI, it passes LCRs directly to the **database inbound server**, which applies them through Oracle's parallel apply engine natively. This bypasses the SQL layer entirely for supported operations.

\`\`\`
-- GGSCI
DBLOGIN USERID ggadmin@TARGET PASSWORD ggpassword
ADD REPLICAT rep_int, INTEGRATED, EXTTRAIL ./dirdat/rt
\`\`\`

Integrated Replicat parameter file (\`dirprm/rep_int.prm\`):

\`\`\`
REPLICAT rep_int
TARGETDB target@tns, USERID ggadmin, PASSWORD ggpassword
DBOPTIONS INTEGRATEDPARAMS (PARALLELISM 4, MAX_SGA_SIZE 1024)
ASSUMETARGETDEFS
MAP hr.*, TARGET hr.*;
MAP oe.*, TARGET oe.*;
\`\`\`

The \`PARALLELISM\` parameter controls the number of parallel apply slaves the inbound server spawns. \`MAX_SGA_SIZE\` (in MB) reserves shared pool memory for the inbound server's LCR queue.

**When to use Integrated Replicat:**
- Oracle 12c and later targets (required)
- Highest-throughput requirements — native engine bypasses SQL overhead
- Tables with complex types (LOBs, XMLType, objects) — handled natively
- Active-Active topologies where conflict detection and resolution (CDR) is required
- CDB/PDB target environments

**Verify the inbound server is running after startup:**

\`\`\`sql
SELECT SERVER_NAME, STATUS, APPLIED_MESSAGE_NUMBER
FROM DBA_APPLY
WHERE SERVER_NAME LIKE 'OGG%';
\`\`\`

---

### Parallel Replicat

Parallel Replicat (introduced in OGG 18c/19c) is designed for bulk load scenarios and very high-throughput steady-state replication. It dynamically splits the trail workload across multiple parallel threads, automatically detecting and resolving data dependencies at runtime rather than routing by transaction assignment.

\`\`\`
-- GGSCI
ADD REPLICAT rep_parallel, PARALLEL, EXTTRAIL ./dirdat/rt
\`\`\`

Parallel Replicat parameter file (\`dirprm/rep_parallel.prm\`):

\`\`\`
REPLICAT rep_parallel
TARGETDB target@tns, USERID ggadmin, PASSWORD ggpassword
PARALLELISM 8
BATCHSQL
MAP hr.*, TARGET hr.*;
MAP oe.*, TARGET oe.*;
\`\`\`

\`BATCHSQL\` enables array processing — multiple row changes are batched into single SQL array operations, dramatically reducing round-trips. It is the primary reason Parallel Replicat can sustain substantially higher throughput than other modes.

**When to use Parallel Replicat:**
- Initial loads or bulk migrations where maximum apply throughput is required
- High-TPS OLTP targets with many independent tables receiving concurrent changes
- Scenarios where apply lag reduction is the primary operational goal
- OGG Microservices Architecture on Oracle 19c targets

**Monitoring Parallel Replicat apply workers:**

\`\`\`sql
SELECT APPLY_NAME, WORKER_NUMBER, STATUS, TOTAL_APPLIED, TOTAL_ERRORS
FROM DBA_APPLY_COORDINATOR
WHERE APPLY_NAME LIKE 'OGG%';
\`\`\`

---

## 3. Data Flow Topologies

The mode choices above apply equally to all three topology patterns. The topology defines *how many* Extract and Replicat process pairs you deploy and *in which directions*.

### Unidirectional

Data flows from one source to one or more targets in a single direction. This is the most common deployment pattern.

\`\`\`
Source DB  ──Extract──▶ Trail ──▶ Data Pump ──▶ Trail ──▶ Replicat──▶ Target DB
\`\`\`

**Typical use cases:**
- Real-time operational reporting (source = OLTP, target = reporting replica)
- Disaster recovery standby (non-Data Guard environments)
- Data migration to cloud (on-premises Oracle to Oracle Autonomous Database)
- Zero-downtime upgrades (replicate from 19c source to 21c target, then switchover)

Configuration notes:
- Use \`HANDLECOLLISIONS\` on the Replicat during initial load to absorb duplicate-key errors while the source continues taking writes
- Set \`DISCARDFILE\` to capture any apply errors rather than halting the Replicat

\`\`\`
REPLICAT rep_uni
...
HANDLECOLLISIONS
DISCARDFILE ./dirrpt/rep_uni.dsc, APPEND, MEGABYTES 100
MAP hr.*, TARGET hr.*;
\`\`\`

---

### Bidirectional (Active-Active)

Two databases each act as primary for their local users. Changes from Site A replicate to Site B and vice versa. A **loop-prevention** mechanism is mandatory: without it, a change applied by Replicat on Site B would be captured by Site B's Extract and sent back to Site A indefinitely.

\`\`\`
Site A DB ──ExtA──▶ Trail ──▶ RepB──▶ Site B DB
Site B DB ──ExtB──▶ Trail ──▶ RepA──▶ Site A DB
\`\`\`

**Loop prevention with \`TRANLOGOPTIONS EXCLUDETAG\`:**

\`\`\`
-- On the Replicat at Site B (applying changes that came from Site A)
REPLICAT rep_b
...
DBOPTIONS SETTAG 01
MAP hr.employees, TARGET hr.employees;

-- On the Extract at Site B (must exclude records tagged by the Replicat)
EXTRACT ext_b
...
TRANLOGOPTIONS EXCLUDETAG 01
TABLE hr.employees;
\`\`\`

Each site's Replicat stamps its applied transactions with a unique tag. Each site's Extract is configured to skip records carrying that tag, breaking the replication loop.

**Conflict Detection and Resolution (CDR):**

When the same row is updated on both sites concurrently, a conflict occurs. OGG provides built-in CDR directives:

\`\`\`
MAP hr.employees, TARGET hr.employees,
  RESOLVECONFLICT (UPDATEROWEXISTS,
    (DEFAULT, USEMAX (last_updated_date)));
\`\`\`

This configuration resolves update conflicts by keeping the row version with the later \`last_updated_date\` timestamp — a "last writer wins" policy. CDR requires a reliable timestamp or sequence column on every conflicting table.

**Typical use cases:**
- Active-active disaster recovery (both sites serve live traffic; failover is instantaneous)
- Geographic load balancing (users in Region A write to Site A; users in Region B write to Site B)
- Zero-RPO requirements where a passive standby is insufficient

---

### Peer-to-Peer (Multi-Master)

Peer-to-peer extends bidirectional replication to three or more nodes. Every node replicates to every other node, and every node applies from every other node. Loop prevention must account for the full mesh of paths.

\`\`\`
Node A ◀──▶ Node B
  ▲  ╲      ╱  ▲
  │   ╲    ╱   │
  ▼    ╲  ╱    ▼
Node C ◀──▶ Node D
\`\`\`

Each node requires:
- One Extract process (capturing local changes)
- One Data Pump per remote node (routing trail files outbound)
- One Replicat per remote source (applying inbound changes)

**Loop prevention for N nodes using unique tags:**

\`\`\`
-- Node A Replicat (applying from Node B) stamps with tag 02
DBOPTIONS SETTAG 02

-- Node A Extract excludes its own original changes (tag 01) AND
-- changes it received and applied from other nodes (tags 02, 03, 04)
TRANLOGOPTIONS EXCLUDETAG 01 02 03 04
\`\`\`

All CDR policies that apply to bidirectional topology also apply here, but conflict probability is higher in a multi-master mesh. Robust timestamp or sequence-based resolution is essential.

**Typical use cases:**
- Globally distributed SaaS applications with regional data residency requirements
- Multi-region active-active Oracle environments where users in each region write to their nearest node
- Regulatory environments where data must be present in multiple geographies simultaneously

---

## Choosing the Right Combination

- **Greenfield Oracle 19c to Oracle 19c replication:** Integrated Capture + Integrated Replicat + Unidirectional is the lowest-maintenance, highest-capability default.
- **High-throughput bulk load or migration:** Integrated Capture + Parallel Replicat with \`BATCHSQL\`.
- **Active-active DR between two Oracle sites:** Integrated Capture + Integrated Replicat + Bidirectional with CDR and \`EXCLUDETAG\`.
- **Legacy Oracle 11g source:** Classic Capture (logmining server not available) + Classic or Coordinated Replicat on the target.
- **Non-Oracle target:** Classic Capture + Classic Replicat — Integrated modes require Oracle on both ends.

Getting this matrix right before provisioning trail directories and process groups will determine whether your OGG environment is a low-maintenance platform or a constant source of apply lag and conflict headaches.`,
};

async function main() {
  console.log('Inserting GoldenGate modes post...');
  await db.insert(posts).values(post).onConflictDoNothing();
  console.log(`Inserted: "${post.title}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
