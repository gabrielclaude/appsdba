import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Data Guard: Architecture, Protection Modes, and Redo Transport',
  slug: 'oracle-data-guard-configuration',
  excerpt:
    'A technical deep-dive into Oracle Data Guard — covering physical vs logical standby architecture, the three redo transport modes, the three protection modes and their trade-offs, the key primary and standby init parameters, the Data Guard Broker, and the operational concepts behind switchover, failover, and reinstatement.',
  category: 'disaster-recovery' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-11'),
  youtubeUrl: null,
  content: `Oracle Data Guard is Oracle's high availability and disaster recovery solution. It maintains one or more synchronised copies of a production database — called standbys — and can switch any standby into the primary role within seconds (switchover) or minutes (failover). It has been part of Oracle Database Enterprise Edition since 9i and remains the most widely deployed Oracle HA solution.

Understanding Data Guard means understanding how redo flows, where it can be delayed, and what the trade-off is between durability and performance at each protection mode.

---

## Physical vs Logical Standby

Data Guard supports two standby types with fundamentally different architectures.

### Physical Standby

The most common type. The standby database is a **block-for-block identical copy** of the primary. Redo is applied using the same media recovery mechanism as RMAN restores — it operates at the block level, with no SQL parsing.

\`\`\`
Primary DB                         Physical Standby
──────────────────                 ──────────────────
Transactions write to              Redo Receive Process (RFS)
  Redo Log Files                     receives redo from primary
        │                                    │
        │ Redo transport                      │ writes to
        │ (LGWR or ARCH)                      ▼
        └──────────────────────►  Standby Redo Logs (SRL)
                                             │
                                    MRP (Managed Recovery Process)
                                    applies redo to standby datafiles
                                             │
                                             ▼
                                  Standby datafiles
                                  (block-identical to primary)
\`\`\`

**Key properties of physical standby:**
- Can be opened read-only while applying redo (Active Data Guard — requires ADG license)
- Applies all DDL, DML, and structural changes automatically
- No transformation of redo — applies exactly what the primary generated
- Supports all Oracle data types and features without exception

### Logical Standby

The standby database is kept in sync by extracting SQL statements from the redo stream (via LogMiner) and re-executing them on the standby. The standby can have different physical structure, additional indexes, or be open read-write for reporting.

**Key limitations:** not all data types are supported (LOBs, XMLType, and others have restrictions). Most new deployments use physical standby. Logical standby is chosen specifically when the standby must remain open for writes or have a different physical layout.

---

## The Three Protection Modes

Protection mode defines what happens when redo cannot be written to the standby — whether the primary waits or continues regardless.

### Maximum Performance (default)

Redo is shipped to the standby **asynchronously**. The primary transaction commits as soon as redo is written to the local redo log. The standby receives redo from a separate background process and applies it independently.

\`\`\`
Primary COMMIT → writes to local redo log → commits immediately
                                 ↓ (async, separate process)
                          Standby receives redo
                          (may be seconds to minutes behind)
\`\`\`

- **Zero performance impact** on the primary
- **Potential data loss:** if the primary fails before async redo is received by the standby, those transactions are lost
- Appropriate for: DR sites across WAN, test/dev standbys, non-critical workloads

### Maximum Availability

Redo is shipped **synchronously** — the primary waits for redo to be received and written to the standby's Standby Redo Logs before completing the commit. However, if the standby becomes unavailable (network failure, standby crash), the primary automatically falls back to Maximum Performance mode and continues.

\`\`\`
Primary COMMIT → writes to local redo log
              → sends redo to standby (waits for acknowledgment)
              → standby writes to SRL, sends ACK
              → primary commits
(If standby unavailable → falls back to async, primary continues)
\`\`\`

- **Zero data loss** while the standby is reachable
- **Automatic failback** to async if standby is unavailable (primary never hangs)
- The standard choice for production HA configurations

### Maximum Protection

Redo must be written to **at least one standby's SRL** before the primary commits. If no standby is available, the primary **shuts down** rather than allowing a commit that could be lost.

\`\`\`
Primary COMMIT → writes to local redo log
              → sends redo to standby (waits for acknowledgment)
              → standby writes to SRL, sends ACK
              → primary commits
(If standby unavailable → PRIMARY SHUTS DOWN — no data loss tolerated)
\`\`\`

- **Absolute zero data loss** — guaranteed by crashing the primary rather than allowing a divergent commit
- **Extreme availability risk** — a network partition between primary and standby takes down the primary
- Appropriate for: financial systems with regulatory zero-RPO requirements, and only when the standby is on a highly reliable, dedicated network

---

## Redo Transport Modes

The redo transport mode (set in the \`LOG_ARCHIVE_DEST_n\` parameter) determines how redo is sent and acknowledged.

| Transport Attribute | Behaviour | Used With |
|--------------------|-----------|-----------|
| \`ASYNC\` | Primary does not wait for standby acknowledgment | Maximum Performance |
| \`SYNC\` | Primary waits for standby to write redo to SRL before commit | Maximum Availability / Maximum Protection |
| \`FASTSYNC\` | Hybrid: synchronous for normal commits, falls back to async on standby lag | Available since 12.2 |

### LGWR vs ARCH Transport

Data Guard also has two transport agents:

**LGWR transport** (recommended): the LGWR process on the primary writes redo to the local redo log and sends it to the standby simultaneously. Latency is minimised because redo is in-flight while LGWR is still writing to disk.

**ARCH transport** (legacy): archived log files are shipped after the redo log fills and switches. Only suitable for Maximum Performance mode. Higher RPO (potential data loss = last incomplete redo log).

Modern configurations always use LGWR transport. This is the default when \`SYNC\` is specified.

---

## Key init.ora Parameters

### Primary Database

\`\`\`sql
-- Unique name for this database instance (must differ between primary and standby)
DB_UNIQUE_NAME=PRODDB

-- Enable redo generation in sufficient volume for standby
LOG_ARCHIVE_MODE=ARCHIVELOG

-- Supplemental logging required for logical standby; recommended for physical
SUPPLEMENTAL_LOG_DATA_MIN=YES

-- Redo transport destination — the standby
LOG_ARCHIVE_DEST_2='SERVICE=DRDB LGWR ASYNC VALID_FOR=(ONLINE_LOGFILES,PRIMARY_ROLE) DB_UNIQUE_NAME=DRDB'
LOG_ARCHIVE_DEST_STATE_2=ENABLE

-- If sending synchronously (Maximum Availability):
-- LOG_ARCHIVE_DEST_2='SERVICE=DRDB LGWR SYNC AFFIRM VALID_FOR=(ONLINE_LOGFILES,PRIMARY_ROLE) DB_UNIQUE_NAME=DRDB'

-- Standby redo logs on the primary (used when this database is in standby role)
-- Size must match online redo log size; count = (number of redo log groups + 1) * number of threads
-- These are also written by the primary's RFS process if it ever acts as standby

-- Protection mode
LOG_ARCHIVE_DEST_1='LOCATION=USE_DB_RECOVERY_FILE_DEST VALID_FOR=(ALL_LOGFILES,ALL_ROLES) DB_UNIQUE_NAME=PRODDB'

-- Allow DB to become standby (role transition support)
STANDBY_FILE_MANAGEMENT=AUTO
DB_FILE_NAME_CONVERT='/u01/oradata/DRDB/','/u01/oradata/PRODDB/'
LOG_FILE_NAME_CONVERT='/u01/oradata/DRDB/','/u01/oradata/PRODDB/'

-- FAL (Fetch Archive Log) for gap detection
FAL_SERVER=DRDB
FAL_CLIENT=PRODDB
\`\`\`

### Standby Database

\`\`\`sql
-- Unique name — different from primary
DB_UNIQUE_NAME=DRDB

-- Same DB_NAME as primary (must match)
DB_NAME=PRODDB

-- Transport back to primary when standby becomes primary (for switchback)
LOG_ARCHIVE_DEST_2='SERVICE=PRODDB LGWR ASYNC VALID_FOR=(ONLINE_LOGFILES,PRIMARY_ROLE) DB_UNIQUE_NAME=PRODDB'
LOG_ARCHIVE_DEST_STATE_2=ENABLE

-- FAL server — the primary, for gap resolution
FAL_SERVER=PRODDB
FAL_CLIENT=DRDB

-- Auto-manage standby datafile naming
STANDBY_FILE_MANAGEMENT=AUTO
DB_FILE_NAME_CONVERT='/u01/oradata/PRODDB/','/u01/oradata/DRDB/'
LOG_FILE_NAME_CONVERT='/u01/oradata/PRODDB/','/u01/oradata/DRDB/'
\`\`\`

---

## Standby Redo Logs

Standby Redo Logs (SRLs) are a critical, often misconfigured component. They are written by the RFS process on the standby as redo arrives from the primary. MRP then applies from the SRLs to the standby datafiles.

**Sizing rule:** same size as the primary's online redo logs. Count rule:

\`\`\`
SRL groups = (number of online redo log groups per thread + 1) × number of threads
\`\`\`

For a single-instance primary with 3 redo log groups: **4 SRL groups** minimum.

\`\`\`sql
-- Add SRLs on the standby database
ALTER DATABASE ADD STANDBY LOGFILE GROUP 4 '/u01/oradata/DRDB/srl04.log' SIZE 200M;
ALTER DATABASE ADD STANDBY LOGFILE GROUP 5 '/u01/oradata/DRDB/srl05.log' SIZE 200M;
ALTER DATABASE ADD STANDBY LOGFILE GROUP 6 '/u01/oradata/DRDB/srl06.log' SIZE 200M;
ALTER DATABASE ADD STANDBY LOGFILE GROUP 7 '/u01/oradata/DRDB/srl07.log' SIZE 200M;
\`\`\`

Also add SRLs on the **primary** — they are used when the primary becomes a standby after a switchover:

\`\`\`sql
-- On the primary
ALTER DATABASE ADD STANDBY LOGFILE GROUP 4 '/u01/oradata/PRODDB/srl04.log' SIZE 200M;
-- ... same count as standby
\`\`\`

---

## The Data Guard Broker

The Data Guard Broker (DMON process) is Oracle's management layer for Data Guard configurations. It provides:

- A single command-line interface (\`dgmgrl\`) for all switchover and failover operations
- Automatic redo gap detection and resolution
- Health monitoring and configuration validation
- Integration with Oracle Enterprise Manager

Every production Data Guard deployment should use the Broker. Manual Data Guard (without Broker) is fragile and difficult to operate at scale.

\`\`\`bash
# Start the Broker daemon on both primary and standby
# (requires DG_BROKER_START=TRUE in init.ora)

# Connect to the Broker
dgmgrl /

# Create the configuration
DGMGRL> CREATE CONFIGURATION 'ProdDG'
  AS PRIMARY DATABASE IS 'PRODDB'
  CONNECT IDENTIFIER IS PRODDB;

# Add the standby
DGMGRL> ADD DATABASE 'DRDB'
  AS CONNECT IDENTIFIER IS DRDB
  MAINTAINED AS PHYSICAL;

# Enable the configuration
DGMGRL> ENABLE CONFIGURATION;

# Check status
DGMGRL> SHOW CONFIGURATION;
DGMGRL> SHOW DATABASE VERBOSE PRODDB;
DGMGRL> SHOW DATABASE VERBOSE DRDB;
\`\`\`

---

## Apply Lag and Transport Lag

Two metrics define the standby's currency:

**Transport lag** — how far behind the standby is in *receiving* redo from the primary. Caused by network bandwidth or latency.

**Apply lag** — how far behind the standby is in *applying* redo to its datafiles. Caused by slow I/O on the standby, or deliberately delayed apply.

\`\`\`sql
-- On the standby — check both lags
SELECT name, value, time_computed
FROM   v\$dataguard_stats
WHERE  name IN ('transport lag', 'apply lag', 'apply finish time');
\`\`\`

A healthy configuration shows transport lag of 0 seconds and apply lag of seconds to minutes depending on I/O throughput.

---

## Switchover vs Failover

**Switchover** — a planned, zero-data-loss role transition. Both databases are healthy. The primary finishes all in-flight redo, the standby applies it all, they swap roles. The old primary becomes the new standby immediately — no reinstatement needed.

**Failover** — an unplanned transition because the primary is unavailable. The standby is promoted. If it was in Maximum Availability or Maximum Performance mode and not fully current, some data may be lost. The old primary cannot rejoin as a standby without flashback or re-creation.

### Broker-Managed Switchover (Recommended)

\`\`\`bash
dgmgrl /
DGMGRL> VALIDATE DATABASE DRDB;          -- pre-flight check
DGMGRL> SWITCHOVER TO DRDB;              -- executes the role swap
DGMGRL> SHOW CONFIGURATION;             -- verify new state
\`\`\`

### Broker-Managed Failover

\`\`\`bash
dgmgrl /
DGMGRL> FAILOVER TO DRDB;               -- immediate, no data loss guarantee
-- or
DGMGRL> FAILOVER TO DRDB IMMEDIATE;     -- skip any remaining apply (faster, may lose data)
\`\`\`

After failover, the old primary must be reinstated as a standby using Flashback Database (if enabled) or re-created from RMAN backup.

---

## Active Data Guard (ADG)

Active Data Guard allows the physical standby to be **open read-only while MRP is actively applying redo**. This requires an additional license (Active Data Guard option) beyond base Data Guard.

Without ADG, the standby can be opened read-only only by stopping MRP — it goes stale while open. With ADG, reporting workloads can run on the standby concurrently with redo apply.

\`\`\`sql
-- Open the standby in read-only mode with active apply (requires ADG license)
ALTER DATABASE OPEN READ ONLY;
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE USING CURRENT LOGFILE DISCONNECT;
\`\`\`

---

## Fast-Start Failover (FSFO)

Fast-Start Failover enables the Data Guard Broker observer process to automatically trigger a failover when the primary becomes unavailable, without human intervention. An observer process runs on a third host and monitors both databases.

\`\`\`bash
# Start the observer (on a third host, not primary or standby)
dgmgrl /
DGMGRL> ENABLE FAST_START FAILOVER;
DGMGRL> START OBSERVER;
\`\`\`

FSFO requires Maximum Availability or Maximum Protection mode. It is not appropriate for all environments — automatic failover without human review can cause split-brain if the network partitions rather than the primary truly failing.

The companion runbook covers the complete step-by-step process for building a physical standby from RMAN backup, configuring the Broker, validating redo transport, performing a switchover, and monitoring the configuration in production.`,
};

async function main() {
  console.log('Inserting Oracle Data Guard blog post...');
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
