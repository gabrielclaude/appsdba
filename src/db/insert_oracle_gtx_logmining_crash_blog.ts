import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'oracle-rac-gtx-crash-supplemental-logging-ora00492';

const content = `
Few alerts raise the heart rate quite like a sudden PMON instance termination on a production RAC node. The alert log delivers a terse message, the instance is gone, and the investigation starts from a cold stop. What makes this class of failure particularly disorienting is that the triggering process — GTX1, the Global Transaction background process — is not one that most DBAs spend time monitoring proactively.

This post covers a production incident on a 2-node Oracle 19c RAC environment (19.28.0.0.0 DBRU) where supplemental logging was enabled on a highly active OLTP table approximately six weeks before the first crash, and where two identical GTX1 deaths occurred within that window. The post explains what the GTX processes do, why supplemental logging on XA-heavy tables creates a specific pressure on those processes, how to audit the logging footprint with precision SQL, and how to identify which tables are the largest redo contributors.

---

## The Crash: Anatomy of ORA-00492

Instance 1 of a 2-node RAC database was terminated by PMON without any preceding I/O error, network timeout, or OS-level signal. The alert log entry at the moment of failure:

\`\`\`
2026-07-14T17:10:05.978974+07:00
PMON (ospid: 3608964): terminating the instance due to ORA error 492

2026-07-14T17:10:05.980780+07:00
Cause - 'Instance is being terminated due to fatal process death (pid: 618, ospid: 1523719, GTX1)'

2026-07-14T17:10:06.004032+07:00
System state dump requested by (instance=1, osid=3608964 (PMON)), summary=[abnormal instance termination].
error - 'Instance is terminating.'
System State dumped to trace file:
/u01/app/oracle/diag/rdbms/proddb/PRODDB1/trace/PRODDB1_diag_3609083.trc

2026-07-14T17:10:06.604287+07:00
ORA-1092 : opitsk aborting process

2026-07-14T17:10:12.242445+07:00
Instance terminated by PMON, pid = 3608964
\`\`\`

**ORA-00492** is not an error that originates in user code. It is raised by PMON when it detects that a mandatory background process — one that the instance cannot function without — has died or become permanently unresponsive. PMON's only option at that point is to terminate the instance to prevent data corruption.

In this incident, the dying process was **GTX1**.

---

## What Are the GTX Processes?

The GTX background processes (\`GTX0\` through \`GTXn\`) manage global (distributed/XA) transactions in an Oracle RAC environment. Their responsibilities include:

- **Branch registration** — tracking the state of distributed transaction branches across instances
- **Auto-tuning** — Oracle can dynamically spawn or shut down GTX workers based on the volume of in-flight distributed transactions
- **Supplemental redo coordination** — when supplemental logging is enabled, GTX processes participate in ensuring that the additional redo written for XA operations is consistent across the RAC fabric

The number of GTX processes on each node is controlled by the initialization parameter \`global_txn_processes\`. In this environment it was set to 1 — meaning a single GTX1 process on each node bore the entire load.

\`\`\`sql
SHOW PARAMETER global_txn_processes;
-- NAME                    TYPE     VALUE
-- ----------------------- -------- -------
-- global_txn_processes    integer  1
\`\`\`

When \`global_txn_processes = 1\`, there is no redundancy. If GTX1 hangs, there is no GTX2 to take over. PMON detects the unresponsive process and terminates the instance.

---

## The Timeline: Two Crashes, One Common Cause

Two identical failures occurred within approximately three weeks of each other:

| Event | Date | Error |
|-------|------|-------|
| Supplemental logging enabled on active table | ~12 Jun 2026 | — |
| First crash (instance 1) | 23 Jun 2026 10:30 UTC+7 | GTX1 death, ORA-00492 |
| Second crash (instance 1) | 14 Jul 2026 17:10 UTC+7 | GTX1 death, ORA-00492 |

The first crash was initially attributed to a one-off XA transaction abort freezing the GTX process. No further investigation was done because the instance recovered and stayed stable for three weeks. The second identical crash on the same node, same process, three weeks later eliminated the "one-off" explanation.

The common factor between both crashes: supplemental logging was enabled on a high-frequency OLTP table that was also heavily involved in distributed (XA) transactions.

---

## Why Supplemental Logging Stresses GTX Processes

Supplemental logging instructs Oracle to write additional data into the redo stream beyond what is strictly necessary for crash recovery. This extra data — also called supplemental redo — is what makes LogMiner, GoldenGate, Debezium, and similar tools able to reconstruct the before-image and after-image of every row change.

In a standard INSERT/UPDATE/DELETE operation on a table without supplemental logging, Oracle writes minimal redo: enough to reapply or reverse the change during recovery. With supplemental logging enabled at the \`ALL COLUMNS\` or \`ALWAYS\` level, Oracle writes the values of all logged columns on every modification — including columns that were not changed — which can multiply the redo volume of a single DML by 3x to 10x on wide tables.

In a RAC environment where that same table is modified inside XA (distributed) transactions, the pressure compounds:

1. **Redo amplification** — the supplemental redo generated per XA operation spikes, increasing write pressure on the redo log writer
2. **GTX coordination overhead** — GTX processes must track and register each distributed transaction branch while simultaneously managing the supplemental redo stream
3. **XA abort interaction** — when an application abnormally aborts a large distributed transaction, the GTX process must roll back or clean up the branch state. If the cleanup coincides with high supplemental redo generation, the GTX process can fall behind Oracle's background process health check window
4. **PMON heartbeat miss** — PMON monitors background processes on a timer. If GTX1 is stuck in a long redo-coordination operation and misses its heartbeat window, PMON classifies it as dead and terminates the instance

The pattern in the DIAG trace file supports this. Before the crash, the alert log contained only LogMiner-related entries — no ORA- errors, no I/O warnings. The GTX process simply stopped responding while handling supplemental redo under XA load.

---

## Investigating the Crash

### Step 1: Confirm the failing process from the alert log

\`\`\`bash
grep -E "ORA-492|GTX|terminating the instance|fatal process" \\
  /u01/app/oracle/diag/rdbms/proddb/PRODDB1/alert/log.xml | tail -30
\`\`\`

Or for text-format alert log:

\`\`\`bash
grep -E "ORA-492|GTX|PMON.*terminat|fatal process" \\
  /u01/app/oracle/diag/rdbms/proddb/PRODDB1/trace/alert_PRODDB1.log | tail -50
\`\`\`

### Step 2: Extract the DIAG trace file

The system state dump written at crash time is the most information-dense artifact. Extract the call stack of the dying process:

\`\`\`bash
# Get the last 500 lines — the crash-time content is at the end
tail -500 /u01/app/oracle/diag/rdbms/proddb/PRODDB1/trace/PRODDB1_diag_<pid>.trc
\`\`\`

Look for the \`kjz*\` function calls — these belong to the Global Transaction (KJZ) layer. A GTX1 death typically shows the process stuck in a \`kjzgreconfig\` or \`kjzgpoll\` wait rather than completing its reconfiguration.

### Step 3: Check for OS-level I/O or storage errors around the crash time

Storage latency can independently freeze background processes. Rule it out before assuming the GTX death was purely application-driven:

\`\`\`bash
# Grep around the crash timestamp (adjust time window)
grep "Jul 14" /var/log/messages | grep -iE "scsi|io error|timeout|error|blk_update"
\`\`\`

No SCSI or block device errors in the messages file at the time of crash removes storage as a factor and points the investigation back to the in-database workload.

---

## Auditing Supplemental Logging

Once the GTX/supplemental logging connection is suspected, audit the exact logging configuration in place.

### Database-wide supplemental logging status

\`\`\`sql
SELECT supplemental_log_data_min  AS minimal,
       supplemental_log_data_pk   AS primary_key,
       supplemental_log_data_ui   AS unique_index,
       supplemental_log_data_fk   AS foreign_key,
       supplemental_log_data_all  AS all_columns,
       supplemental_log_data_pl   AS procedural
FROM   v\$database;
\`\`\`

| Column | Value | Meaning |
|--------|-------|---------|
| MINIMAL | YES | Basic supplemental logging on — required for any log mining |
| ALL_COLUMNS | YES | Every column on every update logged — maximum redo amplification |
| PRIMARY_KEY | YES | Only PK columns logged on updates — much lighter |

If \`ALL_COLUMNS = YES\` at the database level, the entire database is producing maximally amplified redo for every DML operation. This is rarely intentional for production environments and should be converted to table-level logging on specific columns.

### Table-level supplemental log groups

\`\`\`sql
SELECT owner,
       table_name,
       log_group_name,
       log_group_type,
       always
FROM   dba_log_groups
WHERE  owner NOT IN ('SYS', 'SYSTEM', 'AUDSYS')
ORDER BY owner, table_name;
\`\`\`

**LOG_GROUP_TYPE** values to watch for:

| Type | Implication |
|------|-------------|
| \`ALL COLUMNS\` | Maximum overhead — all columns logged every time |
| \`PRIMARY KEY COLUMNS\` | Minimum required for row identification — low overhead |
| \`UNIQUE KEY COLUMNS\` | Moderate overhead |

**ALWAYS** column: If \`ALWAYS = ALWAYS\`, Oracle writes the before-image of every logged column on every UPDATE — even when those columns were not modified. This is the highest-overhead configuration and the most likely to stress GTX under XA load.

### Map log group columns to specific table columns

\`\`\`sql
SELECT g.owner,
       g.table_name,
       g.log_group_name,
       g.log_group_type,
       g.always,
       c.column_name,
       c.position
FROM   dba_log_groups        g
JOIN   dba_log_group_columns c
       ON  g.owner          = c.owner
      AND  g.log_group_name = c.log_group_name
WHERE  g.owner NOT IN ('SYS', 'SYSTEM', 'AUDSYS')
ORDER BY g.owner, g.table_name, c.position;
\`\`\`

This is the definitive view of what data is being written to the redo stream beyond normal recovery requirements. Cross-reference the table names here against the high-redo analysis below.

### Check for active LogMiner sessions

\`\`\`sql
SELECT session_id,
       start_scn,
       end_scn,
       db_name,
       status
FROM   v\$logmnr_session;
\`\`\`

An active LogMiner session confirms that a process is actively consuming the supplemental redo. If the session belongs to a one-time migration or audit job that has since completed, the supplemental logging on the table is orphaned — it is generating overhead with no consumer and should be dropped.

---

## Identifying High-Redo Tables via Active Session History

Oracle does not expose redo generation per table directly, but Active Session History maps sampled sessions to object IDs at the time of the sample. Sessions waiting on write-related events while touching a specific object identify the heaviest redo contributors.

### ASH-based redo-heavy object identification

\`\`\`sql
SELECT *
FROM   (
  SELECT o.owner,
         o.object_name,
         o.subobject_name,
         o.object_type,
         ash.event,
         COUNT(*)                                              AS samples,
         ROUND(COUNT(*) * 100 / SUM(COUNT(*)) OVER (), 2)    AS pct_of_write_activity
  FROM   v\$active_session_history ash
  JOIN   dba_objects o ON ash.current_obj# = o.object_id
  WHERE  ash.sample_time > SYSDATE - 1/24
    AND  (ash.event LIKE 'db file%write'
       OR ash.event LIKE 'log file%'
       OR ash.event IS NULL)
    AND  o.owner NOT IN ('SYS', 'SYSTEM', 'AUDSYS')
  GROUP BY o.owner, o.object_name, o.subobject_name, o.object_type, ash.event
  ORDER BY samples DESC
)
WHERE  ROWNUM <= 20;
\`\`\`

Any table appearing at the top of this list that also has an entry in \`dba_log_groups\` is the primary candidate for the GTX bottleneck.

For historical analysis (AWR data — requires Diagnostics Pack):

\`\`\`sql
SELECT o.owner,
       o.object_name,
       o.object_type,
       COUNT(*) AS samples
FROM   dba_hist_active_sess_history ash
JOIN   dba_objects                  o ON ash.current_obj# = o.object_id
WHERE  ash.sample_time BETWEEN
         TO_TIMESTAMP('2026-07-14 16:00:00', 'YYYY-MM-DD HH24:MI:SS')
     AND TO_TIMESTAMP('2026-07-14 17:15:00', 'YYYY-MM-DD HH24:MI:SS')
  AND  (ash.event LIKE 'db file%write' OR ash.event LIKE 'log file%')
  AND  o.owner NOT IN ('SYS', 'SYSTEM', 'AUDSYS')
GROUP BY o.owner, o.object_name, o.object_type
ORDER BY samples DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

### Real-time redo generation by session

\`\`\`sql
SELECT s.sid,
       s.serial#,
       s.username,
       s.program,
       s.osuser,
       s.machine,
       ROUND(st.value / 1024 / 1024, 2) AS redo_mb
FROM   v\$sesstat  st
JOIN   v\$statname sn ON st.statistic# = sn.statistic#
JOIN   v\$session  s  ON st.sid        = s.sid
WHERE  sn.name   = 'redo size'
  AND  st.value  > 10485760
ORDER BY st.value DESC;
\`\`\`

Sessions generating more than 10 MB of redo since their last connection should be reviewed. In the presence of supplemental logging on the tables they are modifying, these sessions are driving the highest supplemental redo volume.

---

## Remediation

### Option 1: Drop the supplemental log group (if the consumer no longer needs it)

If the LogMiner or replication session that originally required the logging has ended, remove the log group:

\`\`\`sql
ALTER TABLE schema_name.table_name
  DROP SUPPLEMENTAL LOG GROUP log_group_name;
\`\`\`

Verify removal:

\`\`\`sql
SELECT count(*) FROM dba_log_groups
WHERE owner = 'SCHEMA_NAME' AND table_name = 'TABLE_NAME';
\`\`\`

### Option 2: Reduce logging scope from ALL COLUMNS to PRIMARY KEY

If the replication consumer only needs the primary key for row identification (the most common requirement for CDC tools):

\`\`\`sql
-- Drop the ALL COLUMNS group
ALTER TABLE schema_name.table_name
  DROP SUPPLEMENTAL LOG DATA (ALL COLUMNS);

-- Replace with minimal PK-only logging
ALTER TABLE schema_name.table_name
  ADD SUPPLEMENTAL LOG DATA (PRIMARY KEY) COLUMNS;
\`\`\`

This can reduce per-DML redo volume by 60–90% on wide tables.

### Option 3: Increase global_txn_processes

If distributed transactions cannot be reduced and supplemental logging must remain, increase the GTX process count so that a single process hang does not immediately take the instance down:

\`\`\`sql
ALTER SYSTEM SET global_txn_processes = 3 SCOPE = BOTH;
\`\`\`

This allows Oracle to spawn GTX1, GTX2, and GTX3 — if one hangs, the others continue and PMON does not classify the instance as fatally compromised. Verify the new processes:

\`\`\`bash
ps -ef | grep -i gtx | grep -v grep
\`\`\`

### Option 4: Offload log mining to a standby

If the business case for log mining is ongoing (active GoldenGate replication, real-time CDC), consider enabling supplemental logging on an Active Data Guard standby and running the mining consumer against the standby instead of the primary. The primary continues processing XA transactions at normal redo volume, and the supplemental redo overhead is absorbed by the standby.

---

## Summary

The GTX1 death pattern in this incident was not random. Supplemental logging enabled on a high-frequency table inside an XA-heavy workload created a specific, reproducible pressure: the single GTX1 process could not complete its redo coordination housekeeping fast enough under load, missed PMON's health check window, and was classified as dead. PMON then did exactly what it is designed to do and terminated the instance.

The investigation path is straightforward once the connection is recognized: check the alert log for the exact process name, extract the DIAG trace, rule out storage with \`/var/log/messages\`, audit \`dba_log_groups\` and \`v\$database\` supplemental logging columns, and cross-reference against ASH write activity to confirm which tables are driving the redo volume. Remediation is one of four options depending on whether the logging consumer is still active, whether the logging scope can be narrowed, whether the GTX pool can be widened, or whether the mining workload can be offloaded to a standby.

Enabling supplemental logging on any table in an XA-heavy environment should be treated as a production change with a formal change review, a redo volume baseline, and an agreed-upon exit plan for when the logging is no longer needed.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'Oracle RAC GTX1 Fatal Process Death and ORA-00492: When Supplemental Logging Crashes a Production Instance',
    slug,
    excerpt: 'A 2-node Oracle 19c RAC environment suffered two identical instance crashes within three weeks of enabling supplemental logging on a high-frequency OLTP table. Both crashes were caused by GTX1 — the Global Transaction background process — dying under the combined pressure of XA workload and supplemental redo generation. This post traces the full crash cascade, explains why supplemental logging on XA-heavy tables stresses GTX processes, and provides the SQL to audit logging footprint, identify redo-heavy tables via ASH, and remediate safely.',
    content,
    category: 'rac-clusterware',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
