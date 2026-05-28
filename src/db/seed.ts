import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const seedPosts = [
  {
    title: 'Getting Started with Oracle Database 19c: A DBA Primer',
    slug: 'oracle-database-19c-dba-primer',
    excerpt: 'A comprehensive introduction to Oracle Database 19c for both new and experienced DBAs, covering architecture, memory structures, and background processes.',
    content: `Oracle Database 19c is the long-term support release of the Oracle 12.2 family. As a DBA, understanding its core architecture is essential for effective administration.

## Memory Architecture

Oracle Database uses two main memory areas: the System Global Area (SGA) and the Program Global Area (PGA). The SGA is shared among all processes and contains the buffer cache, shared pool, redo log buffer, and large pool.

## Background Processes

Key background processes include:
- **SMON** (System Monitor): Instance recovery and cleanup
- **PMON** (Process Monitor): Failed process cleanup
- **DBWn** (Database Writer): Writes dirty buffers to disk
- **LGWR** (Log Writer): Writes redo log entries
- **CKPT** (Checkpoint): Updates control file and data file headers

## Storage Architecture

Oracle organizes storage into tablespaces, segments, extents, and data blocks. Understanding this hierarchy is critical for performance tuning and space management.

## Getting Started

Connect to the database using SQL*Plus:

\`\`\`sql
sqlplus / as sysdba
SELECT instance_name, status FROM v$instance;
\`\`\``,
    category: 'oracle-database' as const,
    youtubeUrl: null,
    published: true,
    publishedAt: new Date('2025-01-15'),
  },
  {
    title: 'Oracle E-Business Suite 12.2: Patching with Online Patching (adop)',
    slug: 'ebs-12-2-online-patching-adop',
    excerpt: 'Deep dive into Oracle EBS 12.2 online patching using the adop utility, covering the patch cycle phases and common troubleshooting techniques.',
    content: `Oracle E-Business Suite 12.2 introduced online patching (adop), eliminating the need for system downtime during patching operations.

## Online Patching Architecture

EBS 12.2 uses a dual filesystem architecture — the run edition and the patch edition. When you apply a patch, it goes to the patch edition while users continue working on the run edition.

## The adop Patch Cycle

The cycle consists of five phases:

### 1. Prepare Phase
\`\`\`bash
adop phase=prepare
\`\`\`
Creates the patch edition in the database.

### 2. Apply Phase
\`\`\`bash
adop phase=apply patches=<patch_number>
\`\`\`
Applies the patch to the patch edition.

### 3. Finalize Phase
\`\`\`bash
adop phase=finalize
\`\`\`
Prepares for the edition cutover.

### 4. Cutover Phase
\`\`\`bash
adop phase=cutover
\`\`\`
Brief outage window — swaps run and patch editions.

### 5. Cleanup Phase
\`\`\`bash
adop phase=cleanup
\`\`\`
Removes the old edition artifacts.

## Common Issues

- **AD Worker failures**: Check adop log files under \`$APPL_TOP/admin/<SID>/log\`
- **Edition-based redefinition errors**: Ensure all sessions are on the correct edition
- **File system sync issues**: Run \`adop phase=fs_clone\` to resync`,
    category: 'ebs-suite' as const,
    youtubeUrl: null,
    published: true,
    publishedAt: new Date('2025-02-03'),
  },
  {
    title: 'WebLogic Server Administration for Oracle EBS: Tuning JVM and Thread Pools',
    slug: 'weblogic-ebs-jvm-thread-pool-tuning',
    excerpt: 'Practical WebLogic Server tuning guide for EBS environments — JVM heap sizing, thread pool configuration, and monitoring with WLST.',
    content: `WebLogic Server is the application server that powers Oracle E-Business Suite 12.x. Proper tuning is critical for EBS performance.

## JVM Heap Sizing

The most impactful tuning parameter is the JVM heap size. Edit \`setDomainEnv.sh\`:

\`\`\`bash
USER_MEM_ARGS="-Xms4096m -Xmx8192m -XX:+UseG1GC -XX:MaxGCPauseMillis=200"
\`\`\`

Guidelines:
- Start heap at 4-8GB for mid-size EBS environments
- Never exceed 85% of available physical memory
- Use G1GC for heaps larger than 4GB

## Thread Pool Configuration

In the WebLogic Console, navigate to your Managed Server → Configuration → Tuning:

- **Execute Queue Size**: Set to 65 (default) or increase for high-concurrency EBS
- **Self-Tuning Thread Pool**: Enable and set Min/Max Threads to match CPU count × 2

## Monitoring with WLST

\`\`\`python
connect('weblogic', 'password', 't3://hostname:7001')
domainRuntime()
cd('ServerRuntimes/your_managed_server/ThreadPoolRuntime/ThreadPoolRuntime')
ls()
print(get('ExecuteThreadTotalCount'))
print(get('StandbyThreadCount'))
\`\`\`

## Key Metrics to Watch

- **Stuck threads**: Alert if > 0 for more than 5 minutes
- **Heap usage**: Alert at > 80%
- **Request queue wait**: Alert if average > 500ms`,
    category: 'weblogic' as const,
    youtubeUrl: null,
    published: true,
    publishedAt: new Date('2025-02-20'),
  },
  {
    title: 'Oracle GoldenGate: Setting Up Real-Time Data Replication',
    slug: 'oracle-goldengate-real-time-replication-setup',
    excerpt: 'Step-by-step guide to configuring Oracle GoldenGate for real-time transactional data replication between Oracle databases.',
    content: `Oracle GoldenGate (OGG) provides real-time, log-based change data capture and replication. It is the industry standard for zero-downtime migrations and real-time analytics feeds.

## Architecture Overview

GoldenGate uses three main components:
- **Extract**: Captures changes from the source database redo logs
- **Trail Files**: Intermediate storage for captured changes
- **Replicat**: Applies changes to the target database

## Configuring the Source (Extract)

### Enable Supplemental Logging
\`\`\`sql
ALTER DATABASE ADD SUPPLEMENTAL LOG DATA;
ALTER DATABASE ADD SUPPLEMENTAL LOG DATA (PRIMARY KEY, UNIQUE) COLUMNS;
\`\`\`

### Create Extract Process
\`\`\`
GGSCI> ADD EXTRACT ext1, INTEGRATED TRANLOG, BEGIN NOW
GGSCI> ADD EXTTRAIL ./dirdat/lt, EXTRACT ext1
GGSCI> EDIT PARAMS ext1
\`\`\`

Extract parameter file:
\`\`\`
EXTRACT ext1
USERID ggadmin@source, PASSWORD ggpassword
EXTTRAIL ./dirdat/lt
TABLE hr.*;
\`\`\`

## Configuring the Target (Replicat)

\`\`\`
GGSCI> ADD REPLICAT rep1, INTEGRATED, EXTTRAIL ./dirdat/lt
GGSCI> EDIT PARAMS rep1
\`\`\`

Replicat parameter file:
\`\`\`
REPLICAT rep1
TARGETDB target@tns, USERID ggadmin, PASSWORD ggpassword
MAP hr.*, TARGET hr.*;
\`\`\`

## Monitoring Lag

\`\`\`
GGSCI> INFO ALL
GGSCI> LAG EXTRACT ext1
GGSCI> STATS REPLICAT rep1
\`\`\`

Keep replication lag under 5 seconds for OLTP workloads.`,
    category: 'golden-gate' as const,
    youtubeUrl: null,
    published: true,
    publishedAt: new Date('2025-03-10'),
  },
  {
    title: 'Oracle Data Guard: Building a Physical Standby for Disaster Recovery',
    slug: 'oracle-data-guard-physical-standby-disaster-recovery',
    excerpt: 'Complete walkthrough for creating and managing an Oracle Data Guard physical standby database for enterprise disaster recovery.',
    content: `Oracle Data Guard is Oracle\'s built-in solution for high availability and disaster recovery using a synchronized standby database.

## What Is a Physical Standby?

A physical standby is a block-for-block copy of the primary database, kept synchronized via redo log shipping. It can be opened read-only for reporting (Active Data Guard license required) while still receiving redo.

## Prerequisites

- Both primary and standby must be on the same Oracle version
- Archivelog mode must be enabled on primary
- FORCE LOGGING should be enabled

\`\`\`sql
-- On primary
ALTER DATABASE FORCE LOGGING;
ALTER DATABASE ARCHIVELOG;
\`\`\`

## Primary Database Configuration

\`\`\`sql
-- Enable Data Guard broker
ALTER SYSTEM SET LOG_ARCHIVE_DEST_1 = 'LOCATION=USE_DB_RECOVERY_FILE_DEST VALID_FOR=(ALL_LOGFILES,ALL_ROLES)';
ALTER SYSTEM SET LOG_ARCHIVE_DEST_2 = 'SERVICE=standby_tns ASYNC VALID_FOR=(ONLINE_LOGFILES,PRIMARY_ROLE) DB_UNIQUE_NAME=STANDBY';
ALTER SYSTEM SET LOG_ARCHIVE_DEST_STATE_2 = ENABLE;
ALTER SYSTEM SET FAL_SERVER = standby_tns;
ALTER SYSTEM SET STANDBY_FILE_MANAGEMENT = AUTO;
\`\`\`

## Creating the Standby with RMAN

\`\`\`bash
rman target sys/password@primary auxiliary sys/password@standby

DUPLICATE TARGET DATABASE FOR STANDBY FROM ACTIVE DATABASE
  DORECOVER
  SPFILE
    SET db_unique_name='STANDBY'
    SET LOG_ARCHIVE_DEST_2=''
  NOFILENAMECHECK;
\`\`\`

## Starting Redo Apply

\`\`\`sql
-- On standby
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE DISCONNECT FROM SESSION;
\`\`\`

## Monitoring Replication

\`\`\`sql
-- Check apply lag
SELECT NAME, VALUE, TIME_COMPUTED FROM V$DATAGUARD_STATS WHERE NAME LIKE '%lag%';

-- Verify transport status
SELECT DEST_ID, STATUS, TARGET, ARCHIVER, SCHEDULE, DESTINATION FROM V$ARCHIVE_DEST WHERE STATUS = 'VALID';
\`\`\`

## Failover vs Switchover

- **Switchover**: Planned, graceful role reversal (no data loss)
- **Failover**: Unplanned, primary is unavailable (potential data loss without maximum protection mode)`,
    category: 'disaster-recovery' as const,
    youtubeUrl: null,
    published: true,
    publishedAt: new Date('2025-03-25'),
  },
  {
    title: 'Oracle RAC and Clusterware: Architecture and Administration Essentials',
    slug: 'oracle-rac-clusterware-architecture-administration',
    excerpt: 'Comprehensive guide to Oracle Real Application Clusters architecture, Grid Infrastructure components, and day-to-day RAC administration tasks.',
    content: `Oracle Real Application Clusters (RAC) allows multiple instances to access a single database simultaneously, providing both high availability and horizontal scalability.

## Grid Infrastructure Components

Oracle Grid Infrastructure consists of:
- **Oracle Clusterware**: Cluster management layer (CRS, CRSD, OCSSD, EVMD)
- **Oracle ASM**: Automated Storage Management for shared disk
- **SCAN**: Single Client Access Name — load balances connections across nodes

## Cluster Services Hierarchy

\`\`\`
Grid Infrastructure Stack:
  ├── ohasd (Oracle High Availability Services Daemon)
  │   ├── cssd (Cluster Synchronization Services)
  │   ├── diskmon (Disk Monitor)
  │   ├── crsd (Cluster Ready Services)
  │   │   ├── SCAN Listeners
  │   │   ├── Node VIPs
  │   │   └── Database Services
  │   └── evmd (Event Volume Manager Daemon)
\`\`\`

## Key Administration Commands

### Checking Cluster Status
\`\`\`bash
# Check all cluster resources
crsctl stat res -t

# Check specific node status
olsnodes -v -n

# Verify voting disk
crsctl query css votedisk
\`\`\`

### Managing Services with srvctl
\`\`\`bash
# Start/stop database across all nodes
srvctl start database -db MYDB
srvctl stop database -db MYDB

# Check instance status
srvctl status database -db MYDB -verbose

# Add a service for workload routing
srvctl add service -db MYDB -service OLTP_SVC -preferred MYDB1,MYDB2
\`\`\`

### ASM Management
\`\`\`sql
-- Connect to ASM instance
sqlplus / as sysasm

-- Check disk group status
SELECT NAME, STATE, TOTAL_MB, FREE_MB FROM V$ASM_DISKGROUP;

-- Check ASM disk health
SELECT PATH, HEADER_STATUS, MODE_STATUS FROM V$ASM_DISK;
\`\`\`

## RAC-Specific Performance Views

\`\`\`sql
-- Global Cache statistics
SELECT * FROM GV$INSTANCE;

-- Cache fusion traffic
SELECT INST_ID, GC_CR_BLOCKS_RECEIVED, GC_CURRENT_BLOCKS_RECEIVED FROM GV$SYSSTAT
WHERE NAME IN ('gc cr blocks received', 'gc current blocks received');

-- Interconnect throughput
SELECT INST_ID, NAME, VALUE FROM GV$SYSSTAT
WHERE NAME = 'gc cr blocks received';
\`\`\`

## Common Issues

- **Split-brain**: Voting disk loss causes node eviction — ensure 3+ voting disks
- **Interconnect saturation**: Monitor with OSW and look for high GC wait events
- **Node eviction**: Check \`/u01/app/grid/diag/crs/<hostname>/crs/trace/ocssd.trc\``,
    category: 'rac-clusterware' as const,
    youtubeUrl: null,
    published: true,
    publishedAt: new Date('2025-04-05'),
  },
];

async function main() {
  console.log('Seeding database...');
  await db.insert(posts).values(seedPosts).onConflictDoNothing();
  console.log(`Inserted ${seedPosts.length} posts.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
