import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ora-12850-rman-catalog-resync-data-guard-switchover';

const content = `
Executing a planned Oracle Data Guard switchover to a standby cluster is supposed to be a seamless operation. The roles flip, the new primary opens read-write, and operations resume. Then the next scheduled RMAN backup runs — and fails in a way that has nothing to do with backup infrastructure.

\`\`\`
RMAN-03002: failure of backup command
RMAN-03014: implicit resync of recovery catalog failed
RMAN-03009: failure of full resync command on default channel
ORA-12850: Could not allocate slaves on all specified instances: needed, allocated
\`\`\`

The backup itself never started. RMAN failed during its catalog synchronisation phase, before a single block was read. The error is a parallel coordination failure — specifically, Oracle's inability to spin up query slaves across all active RAC instances to complete a cross-node metadata query.

This post explains exactly why this happens in Real Application Clusters environments after a Data Guard switchover, and how to both fix it permanently and work around it while a maintenance window is scheduled.

---

## What RMAN Is Doing When It Fails

When RMAN connects to a RAC target database using a centralised recovery catalog, it does not just inspect the instance it connected to. During the **implicit resynchronisation** step that precedes every backup, RMAN queries Oracle's \`GV\$\` (Global Dynamic Performance) views to inventory configuration details and archive log sequences across all nodes in the cluster.

Querying a \`GV\$\` view is inherently a parallel operation. The coordinator process on the local instance attempts to spawn parallel query slaves on every active instance in the cluster — each slave polls its local \`V\$\` view and returns the result to the coordinator, which assembles the global picture.

If any node fails to allocate its designated query slaves, the cross-instance query collapses entirely. There is no partial result. RMAN receives ORA-12850 and fails the resync.

In post-switchover environments, this failure has two common sources.

---

## Root Cause 1 — Asymmetric Node States

After a Data Guard switchover, every instance in the new primary cluster must reach an identical open state. In practice, some scenarios leave one or more nodes in a transitional or mismatched state:

- A node that was previously a passive standby may have mounted but not fully opened
- An instance running in \`READ ONLY WITH APPLY\` (Active Data Guard) may not have transitioned cleanly to \`READ WRITE\` post-switchover
- A node may have been bounced during the switchover window and rejoined in a different startup state than the others

The cluster interconnect relies on all participating instances being in consistent states to coordinate parallel slave allocation. An instance that is mounted but not open, or open in a different mode than the others, refuses to accept parallel slave requests from the coordinator — and ORA-12850 results.

\`\`\`sql
-- Quick check: are all instances in the same state?
SELECT inst_id,
       instance_name,
       status,
       database_status
FROM   gv\$instance
ORDER  BY inst_id;
\`\`\`

All rows should return identical \`status\` (\`OPEN\`) and \`database_status\` (\`ACTIVE\`) values. Any deviation points directly to the problem node.

---

## Root Cause 2 — Mismatched PARALLEL_EXECUTION_MESSAGE_SIZE

Parallel query slave coordination between RAC instances uses an inter-process messaging buffer. The size of this buffer is controlled by \`PARALLEL_EXECUTION_MESSAGE_SIZE\`. If this parameter differs between nodes — one instance running a value of 16384 and another running 4096, for example — the instances cannot establish the parallel communication channel, and the cross-node query fails.

This mismatch is most likely to occur after a switchover when:

- An SPFILE parameter change was applied to specific instances using \`SID=<instance_name>\` scope rather than \`SID=*\` (all instances)
- One or more nodes restarted from a local PFILE that predates a recent SPFILE update
- The new primary cluster was provisioned with a different SPFILE than the old primary, and the parameter values were not reconciled before the switchover

\`\`\`sql
-- Confirm PARALLEL_EXECUTION_MESSAGE_SIZE matches across all nodes
SELECT inst_id,
       name,
       value,
       description
FROM   gv\$parameter
WHERE  name = 'parallel_execution_message_size'
ORDER  BY inst_id;
\`\`\`

If the \`value\` column is not identical for every \`inst_id\`, you have a parameter mismatch. The instances will refuse to coordinate parallel slaves until they agree on the message buffer size.

---

## Extended Diagnosis

ORA-12850 during RMAN resync is almost always one of the two root causes above, but a complete diagnosis covers three areas.

### Instance states across the cluster

\`\`\`sql
SELECT inst_id,
       instance_name,
       host_name,
       status,
       database_status,
       active_state,
       logins,
       TO_CHAR(startup_time, 'YYYY-MM-DD HH24:MI:SS') AS startup_time
FROM   gv\$instance
ORDER  BY inst_id;
\`\`\`

Look for any instance where \`status\` is not \`OPEN\`, \`database_status\` is not \`ACTIVE\`, or \`active_state\` is not \`NORMAL\`.

### Parallel-related parameters across all nodes

\`\`\`sql
SELECT inst_id,
       name,
       value
FROM   gv\$parameter
WHERE  name IN (
  'parallel_execution_message_size',
  'parallel_max_servers',
  'parallel_min_servers',
  'parallel_degree_policy',
  'parallel_servers_target',
  'cluster_interconnects'
)
ORDER  BY name, inst_id;
\`\`\`

Any parameter where the value varies across \`inst_id\` rows is a candidate for the mismatch.

### Active parallel slaves at the time of failure

\`\`\`sql
SELECT inst_id,
       qcsid,
       server_name,
       status,
       req_degree,
       degree
FROM   gv\$px_session
ORDER  BY inst_id, qcsid;
\`\`\`

If this query itself fails with ORA-12850, the problem is confirmed: the cluster cannot coordinate GV$ queries at all.

### Data Guard role confirmation

\`\`\`sql
-- Confirm switchover completed and all instances see PRIMARY role
SELECT inst_id,
       db_unique_name,
       database_role,
       open_mode,
       protection_mode,
       switchover_status
FROM   gv\$database
ORDER  BY inst_id;
\`\`\`

All instances should report \`DATABASE_ROLE = PRIMARY\`, \`OPEN_MODE = READ WRITE\`. If any instance still shows \`STANDBY\` role or \`READ ONLY WITH APPLY\`, the switchover did not complete cleanly for that node.

---

## Solution 1 — Clean Cluster Bounce (Permanent Fix)

If the root cause is a stale cluster state from the standby transition — instances in mismatched open modes, orphaned parallel slave processes from the old standby role, or interconnect state inconsistencies — a coordinated rolling restart of all instances clears the holdover state and brings the cluster up uniformly in its new primary role.

\`\`\`bash
# Using srvctl on the new primary (run as oracle OS user)

# Step 1: Confirm current status before bouncing
srvctl status database -d EBSPROD

# Step 2: Stop the database across all nodes
srvctl stop database -d EBSPROD -o immediate

# Step 3: Verify all instances are down
srvctl status database -d EBSPROD

# Step 4: Start the database across all nodes
srvctl start database -d EBSPROD

# Step 5: Confirm all instances are OPEN
srvctl status database -d EBSPROD

# Step 6: Verify cluster-wide state from SQL*Plus
sqlplus / as sysdba
\`\`\`

\`\`\`sql
SELECT inst_id, instance_name, status, database_status FROM gv\$instance ORDER BY inst_id;
\`\`\`

After a clean cluster restart, re-run the RMAN backup script. The resync should succeed.

---

## Solution 2 — Fix PARALLEL_EXECUTION_MESSAGE_SIZE Mismatch

If the diagnosis identified a parameter mismatch, align all instances before restarting:

\`\`\`sql
-- Set the parameter identically across all instances in the SPFILE
ALTER SYSTEM SET parallel_execution_message_size = 16384
  SCOPE = SPFILE SID = '*';

-- Verify the SPFILE change took effect for all SIDs
SELECT name, value, sid
FROM   v\$spparameter
WHERE  name = 'parallel_execution_message_size';
\`\`\`

The \`SID = '*'\` clause is essential — it applies the parameter to all instances, not just the one you are connected to. After updating the SPFILE, a rolling restart picks up the new value on each node.

\`\`\`bash
# Rolling restart via srvctl — one node at a time to avoid downtime
srvctl stop instance  -d EBSPROD -i EBSPROD1 -o immediate
srvctl start instance -d EBSPROD -i EBSPROD1
# Wait for instance to open before proceeding to next node
srvctl stop instance  -d EBSPROD -i EBSPROD2 -o immediate
srvctl start instance -d EBSPROD -i EBSPROD2
\`\`\`

---

## Workaround — Bypass Cross-Instance Queries in RMAN

If a cluster restart is not immediately available — production is live, a maintenance window cannot be called on short notice — you can modify the RMAN script to force Oracle to resolve GV$ queries locally, treating them as single-instance V$ queries. This keeps scheduled backups running while you arrange the proper fix.

\`\`\`
RUN {
  -- Constrain parallel slave allocation to the local instance only
  SQL "ALTER SESSION SET PARALLEL_DEGREE_POLICY = MANUAL";

  -- Force GV$ resolution to the local instance (bypasses cross-node coordination)
  SQL "ALTER SESSION SET INSTANCE = 1";

  -- Proceed with standard backup
  ALLOCATE CHANNEL ch1 DEVICE TYPE DISK FORMAT ''/u01/backup/rman/%d_%T_%U.bkp'';
  BACKUP DATABASE PLUS ARCHIVELOG DELETE INPUT;
  RELEASE CHANNEL ch1;
}
\`\`\`

The \`ALTER SESSION SET INSTANCE = 1\` directive instructs Oracle to satisfy all GV$ queries from instance 1's local V$ views rather than spawning cross-cluster parallel slaves. RMAN's implicit resync completes using only local metadata, and the backup proceeds.

**Important limitations of this workaround:**

- The backup captures data and archive logs correctly — data integrity is not compromised
- The RMAN catalog resync will reflect only the metadata visible from instance 1; archive log entries generated exclusively on other nodes may not be recorded until the next full resync with all nodes healthy
- This is a session-level parameter change within the RMAN run block — it does not affect other sessions or persist beyond the RMAN connection
- Set \`INSTANCE = 1\` only when instance 1 is confirmed \`OPEN\` and \`ACTIVE\`; adjust to a different instance number if node 1 is the problem node

---

## After the Workaround: Confirming Full Resync

Once the cluster state is normalised and the root cause fixed, run a manual RMAN resync to ensure the catalog is fully up to date:

\`\`\`
RMAN TARGET / CATALOG rman_catalog_user/password@rman_catalog_db

RESYNC CATALOG;
\`\`\`

Then run a standard backup without the \`ALTER SESSION SET INSTANCE\` workaround and confirm it completes without ORA-12850.

---

## Summary

ORA-12850 during RMAN's implicit recovery catalog resync after a Data Guard switchover is a cluster coordination failure, not a backup or catalog problem. The resync step queries GV$ views, which require parallel query slaves on every active RAC instance. If any instance is in an inconsistent state from the switchover — not fully open, still in a standby mode, or running a different value of \`PARALLEL_EXECUTION_MESSAGE_SIZE\` — the cross-node parallel query collapses and the backup fails before it starts. Diagnosis takes under five minutes with two GV$ queries: one on \`gv\$instance\` to confirm all nodes are identically \`OPEN\` and \`ACTIVE\`, and one on \`gv\$parameter\` to confirm \`parallel_execution_message_size\` is consistent. The permanent fix is a coordinated cluster bounce to clear stale post-switchover state, combined with an SPFILE parameter alignment using \`SID='*'\`. The immediate workaround — \`ALTER SESSION SET INSTANCE=1\` in the RMAN run block — keeps scheduled backups running without cross-node coordination while the maintenance window is scheduled.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'Resolving ORA-12850 and RMAN Catalog Resync Failures After a Data Guard Switchover',
    slug,
    excerpt: 'ORA-12850 during RMAN implicit catalog resync after a Data Guard switchover is a RAC parallel coordination failure, not a backup problem. RMAN queries GV$ views during resync, which requires parallel slaves on every active instance. Covers both root causes (asymmetric node states and PARALLEL_EXECUTION_MESSAGE_SIZE mismatch), GV$ diagnosis queries, permanent fix via cluster bounce and SPFILE alignment, and an immediate workaround using ALTER SESSION SET INSTANCE to bypass cross-node coordination.',
    content,
    category: 'disaster-recovery',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
