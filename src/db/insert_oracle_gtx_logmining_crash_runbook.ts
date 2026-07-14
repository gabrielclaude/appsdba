import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'oracle-rac-gtx-crash-supplemental-logging-runbook';

const content = `
Operational runbook for investigating and remediating Oracle RAC instance crashes caused by GTX (Global Transaction) background process death, specifically in environments where supplemental logging or LogMiner has been enabled. Covers immediate triage, root cause confirmation, supplemental logging audit, redo volume analysis, and safe remediation.

**Trigger conditions:** Alert log shows \`ORA-00492\` or \`fatal process death\` with process name \`GTX0\`, \`GTX1\`, or \`GTXn\`; prior to crash, alert log contains primarily LogMiner activity entries with no other errors.

---

## Phase 1: Immediate Triage

### 1.1 Confirm the instance is down and restart if appropriate

\`\`\`bash
# Check instance status on the affected node
srvctl status database -db PRODDB

# If the instance is down and no active investigation requires it to stay down:
srvctl start instance -db PRODDB -instance PRODDB1
\`\`\`

Before restarting, confirm the other RAC instance is still up and serving traffic:

\`\`\`bash
srvctl status instance -db PRODDB -instance PRODDB2
\`\`\`

### 1.2 Capture the alert log crash window

\`\`\`bash
# Locate the alert log
ALERT_LOG=/u01/app/oracle/diag/rdbms/proddb/PRODDB1/trace/alert_PRODDB1.log

# Extract the crash context — last 200 lines captures most incidents
tail -200 "\${ALERT_LOG}" > /tmp/alert_crash_\$(date +%Y%m%d_%H%M%S).txt
cat /tmp/alert_crash_\$(date +%Y%m%d_%H%M%S).txt | grep -E "ORA-|GTX|PMON|terminat|fatal"
\`\`\`

Confirm the pattern:
\`\`\`
PMON (ospid: <pid>): terminating the instance due to ORA error 492
Cause - 'Instance is being terminated due to fatal process death (pid: N, ospid: M, GTX1)'
\`\`\`

If the dying process is not GTX, stop this runbook and open the appropriate process-specific investigation.

### 1.3 Note the DIAG trace file path

The alert log will reference the system state trace file written at crash time:

\`\`\`
System State dumped to trace file /u01/app/oracle/diag/rdbms/proddb/PRODDB1/trace/PRODDB1_diag_<pid>.trc
\`\`\`

Record the full path. This file is needed in Phase 2.

### 1.4 Check for prior GTX crashes in the same alert log

\`\`\`bash
grep -n "GTX\|ORA-492\|fatal process" "\${ALERT_LOG}" | grep -v "^Binary"
\`\`\`

Multiple GTX crash entries confirm a recurring pattern rather than a one-off event. Recurring crashes are the most important indicator that the root cause is structural (workload + logging configuration) rather than transient (a single bad transaction).

---

## Phase 2: Root Cause Confirmation

### 2.1 Extract the DIAG trace — crash-time call stack

\`\`\`bash
DIAG_TRC=/u01/app/oracle/diag/rdbms/proddb/PRODDB1/trace/PRODDB1_diag_<pid>.trc

# Extract the last 500 lines — crash events are at the end
tail -500 "\${DIAG_TRC}" > /tmp/diag_crash_tail.txt

# Look for KJZ (Global Transaction layer) function calls
grep -i "kjz\|gtx\|xa\|distributed" /tmp/diag_crash_tail.txt | head -30
\`\`\`

GTX-related crash stacks typically show the process stuck in one of these internal functions:
- \`kjzgreconfig\` — reconfiguration of the global transaction fabric
- \`kjzgpoll\` — polling loop for transaction messages
- \`kjzdattdlm\` — waiting for DLM (Distributed Lock Manager) initialization
- \`kjzgpoll -> kjzgmsghdlr\` — message handler loop

A process stuck in any of these while holding no lock and generating no forward progress is the signature of a GTX hang under supplemental redo pressure.

### 2.2 Rule out OS-level I/O as a cause

\`\`\`bash
# Check /var/log/messages for SCSI, block device, or I/O errors within the crash window
CRASH_DATE="Jul 14"   # adjust to match the crash date
grep "\${CRASH_DATE}" /var/log/messages | grep -iE "scsi|io error|timeout|blk_update|ata|nvme" | tail -50
\`\`\`

If no SCSI or I/O errors appear in the messages file at the crash time, storage is not a factor. If SCSI errors do appear, treat the case as a storage-layer incident first.

### 2.3 Confirm what the alert log contained before the crash

\`\`\`bash
# Look at the 30 minutes before the crash timestamp
grep -A 5 "2026-07-14T16:4\|2026-07-14T16:5\|2026-07-14T17:0" "\${ALERT_LOG}" | head -100
\`\`\`

A clean alert log in the pre-crash window — showing only LogMiner activity messages with no ORA- errors — is the strongest indicator that the GTX death was workload-driven rather than error-driven. The absence of preceding errors rules out most other common crash causes.

### 2.4 Check global_txn_processes

\`\`\`sql
SHOW PARAMETER global_txn_processes;
\`\`\`

A value of 1 means a single GTX process per instance. Any hang in that process immediately puts the instance at risk of PMON termination. Record this value.

\`\`\`bash
# Also verify from OS level that only one GTX process exists per node
ps -ef | grep -i gtx | grep -v grep
\`\`\`

---

## Phase 3: Supplemental Logging Audit

### 3.1 Database-wide supplemental logging status

\`\`\`sql
SELECT supplemental_log_data_min  AS minimal,
       supplemental_log_data_pk   AS primary_key,
       supplemental_log_data_ui   AS unique_index,
       supplemental_log_data_fk   AS foreign_key,
       supplemental_log_data_all  AS all_columns,
       supplemental_log_data_pl   AS procedural
FROM   v\$database;
\`\`\`

| Column | Safe value | Investigate if |
|--------|------------|----------------|
| MINIMAL | YES or NO | — |
| ALL_COLUMNS | NO | YES — full-column DB-wide logging |
| PRIMARY_KEY | YES | Only if PK logging was intentionally enabled |

### 3.2 Table-level supplemental log groups

\`\`\`sql
SELECT owner,
       table_name,
       log_group_name,
       log_group_type,
       always,
       generated
FROM   dba_log_groups
WHERE  owner NOT IN ('SYS', 'SYSTEM', 'AUDSYS', 'ORDDATA')
ORDER BY owner, table_name;
\`\`\`

Note every table returned. For each table, record:
- \`LOG_GROUP_TYPE\` — \`ALL COLUMNS\` is highest risk
- \`ALWAYS\` — \`ALWAYS\` means before-images written even for unmodified columns

### 3.3 Expand to column detail for high-risk tables

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
  AND  g.log_group_type IN ('ALL COLUMNS', 'USER LOG GROUP')
ORDER BY g.owner, g.table_name, c.position;
\`\`\`

### 3.4 Check for active LogMiner sessions

\`\`\`sql
SELECT session_id,
       start_scn,
       end_scn,
       db_name,
       status
FROM   v\$logmnr_session;
\`\`\`

No active sessions means the supplemental logging is orphaned — generating redo overhead with no active consumer. This is the most common scenario after a one-time migration or audit job completes without cleaning up the logging configuration.

### 3.5 Correlate logged tables with XA transaction activity

\`\`\`sql
-- Identify tables from dba_log_groups that are also involved in active distributed transactions
SELECT DISTINCT
       dl.owner,
       dl.table_name,
       dl.log_group_type,
       x.formatid,
       x.status
FROM   dba_log_groups  dl
JOIN   dba_2pc_pending  x ON 1=1
WHERE  dl.owner NOT IN ('SYS', 'SYSTEM', 'AUDSYS')
ORDER BY dl.owner, dl.table_name;
\`\`\`

Any result here — a logged table with concurrent in-doubt XA transactions — confirms the interaction. Also check for recent XA activity:

\`\`\`sql
SELECT formatid,
       globalid,
       branchid,
       tran_comment,
       fail_time,
       state
FROM   dba_2pc_pending
ORDER BY fail_time DESC;
\`\`\`

In-doubt or failed 2PC transactions left behind by the crash should be force-committed or force-rolled back after business confirmation:

\`\`\`sql
-- ONLY after confirming with the application team which outcome is correct
EXECUTE DBMS_TRANSACTION.PURGE_LOST_DB_ENTRY('local_tran_id');
-- or
ROLLBACK FORCE 'local_tran_id';
-- or
COMMIT FORCE 'local_tran_id';
\`\`\`

---

## Phase 4: Redo Volume Analysis

### 4.1 ASH write-activity by object (recent — last 1 hour)

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

### 4.2 Historical redo analysis centered on the crash window (AWR)

\`\`\`sql
-- Adjust timestamps to match your crash window
SELECT o.owner,
       o.object_name,
       o.object_type,
       COUNT(*) AS ash_samples
FROM   dba_hist_active_sess_history ash
JOIN   dba_objects                  o ON ash.current_obj# = o.object_id
WHERE  ash.sample_time BETWEEN
         TO_TIMESTAMP('2026-07-14 16:00:00', 'YYYY-MM-DD HH24:MI:SS')
     AND TO_TIMESTAMP('2026-07-14 17:15:00', 'YYYY-MM-DD HH24:MI:SS')
  AND  (ash.event LIKE 'db file%write' OR ash.event LIKE 'log file%')
  AND  o.owner NOT IN ('SYS', 'SYSTEM', 'AUDSYS')
GROUP BY o.owner, o.object_name, o.object_type
ORDER BY ash_samples DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

### 4.3 Real-time redo by session

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
WHERE  sn.name  = 'redo size'
  AND  st.value > 10485760
ORDER BY st.value DESC;
\`\`\`

Cross-reference: any session in this list that is modifying a table in the \`dba_log_groups\` output is directly contributing to the supplemental redo pressure.

---

## Phase 5: Remediation

### 5.1 If the LogMiner consumer is no longer active — drop the log group

\`\`\`sql
-- Drop a specific supplemental log group
ALTER TABLE <owner>.<table_name>
  DROP SUPPLEMENTAL LOG GROUP <log_group_name>;

-- Verify removal
SELECT count(*)
FROM   dba_log_groups
WHERE  owner      = UPPER('<owner>')
  AND  table_name = UPPER('<table_name>');
-- Expected: 0
\`\`\`

### 5.2 If logging must remain — narrow scope from ALL COLUMNS to PRIMARY KEY

\`\`\`sql
-- Remove the broad ALL COLUMNS group
ALTER TABLE <owner>.<table_name>
  DROP SUPPLEMENTAL LOG DATA (ALL COLUMNS);

-- Add minimal PK-only logging
ALTER TABLE <owner>.<table_name>
  ADD SUPPLEMENTAL LOG DATA (PRIMARY KEY) COLUMNS;

-- Confirm the new narrower log group
SELECT log_group_name, log_group_type, always
FROM   dba_log_groups
WHERE  owner      = UPPER('<owner>')
  AND  table_name = UPPER('<table_name>');
\`\`\`

### 5.3 Increase global_txn_processes to reduce single-point-of-failure risk

\`\`\`sql
-- Increase from 1 to 3 — allows Oracle to spawn GTX0, GTX1, GTX2
ALTER SYSTEM SET global_txn_processes = 3 SCOPE = BOTH;

-- Verify new processes appear
-- (Run from OS after a brief pause for Oracle to spawn them)
\`\`\`

\`\`\`bash
sleep 10
ps -ef | grep -i gtx | grep -v grep
# Expect to see GTX0, GTX1, GTX2 processes on each instance
\`\`\`

### 5.4 Resolve any in-doubt 2PC transactions left by the crash

\`\`\`sql
-- List all in-doubt transactions
SELECT local_tran_id,
       global_tran_id,
       state,
       mixed,
       advice,
       tran_comment,
       fail_time
FROM   dba_2pc_pending
ORDER BY fail_time;
\`\`\`

For each row with \`STATE = 'prepared'\` — the transaction was in the prepared phase when the instance died. Coordinate with the application team to determine whether to commit or roll back, then execute:

\`\`\`sql
-- Force rollback (confirm with app team first)
ROLLBACK FORCE '<local_tran_id>';

-- Force commit (confirm with app team first)
COMMIT FORCE '<local_tran_id>';

-- Purge the entry if the remote side is permanently gone
EXECUTE DBMS_TRANSACTION.PURGE_LOST_DB_ENTRY('<local_tran_id>');
\`\`\`

---

## Automation Script

Save as \`gtx_crash_audit.sh\`. Performs a full read-only audit: alert log crash pattern, active GTX processes, supplemental logging footprint, and real-time redo leaders. Exits 1 if any high-risk finding is detected. Run on the database server as the Oracle OS user with the DB environment sourced.

\`\`\`bash
#!/bin/bash
# GTX Crash / Supplemental Logging Audit
# Usage: ./gtx_crash_audit.sh <APPS_OR_SYSTEM_PWD>
# Requires: ORACLE_SID, ORACLE_HOME set; DB up; run as oracle OS user

DB_PWD=\${1:?"Usage: \$0 <db_password> (SYSTEM or DBA-privileged user)"}
DB_USER="system"
REPORT=/tmp/gtx_audit_\$(date +%Y%m%d_%H%M%S).txt
FINDING=0
ALERT_LOG=\${ORACLE_BASE}/diag/rdbms/\$(echo \${ORACLE_SID} | tr '[:upper:]' '[:lower:]')/\${ORACLE_SID}/trace/alert_\${ORACLE_SID}.log

echo "============================================================" | tee "\${REPORT}"
echo "GTX / Supplemental Logging Crash Audit"                      | tee -a "\${REPORT}"
echo "Instance  : \${ORACLE_SID}"                                   | tee -a "\${REPORT}"
echo "Host      : \$(hostname -s)"                                  | tee -a "\${REPORT}"
echo "Date      : \$(date)"                                         | tee -a "\${REPORT}"
echo "============================================================" | tee -a "\${REPORT}"

# --- Phase 1: Alert log GTX crash scan ---
echo "" | tee -a "\${REPORT}"
echo "[1] Alert Log — GTX Crash History" | tee -a "\${REPORT}"
echo "--------------------------------------------------------------" | tee -a "\${REPORT}"

if [ -f "\${ALERT_LOG}" ]; then
  GTX_HITS=\$(grep -c "GTX\|ORA-492\|fatal process" "\${ALERT_LOG}" 2>/dev/null)
  echo "GTX/ORA-492 entries in alert log: \${GTX_HITS}" | tee -a "\${REPORT}"
  if [ "\${GTX_HITS}" -gt 0 ]; then
    echo "Recent GTX/ORA-492 entries (last 10):" | tee -a "\${REPORT}"
    grep -E "GTX|ORA-492|fatal process" "\${ALERT_LOG}" | tail -10 | tee -a "\${REPORT}"
    [ "\${GTX_HITS}" -gt 1 ] && echo "FINDING: Multiple GTX crash entries — recurring pattern" | tee -a "\${REPORT}" && FINDING=1
  fi
else
  echo "Alert log not found at: \${ALERT_LOG}" | tee -a "\${REPORT}"
  echo "Try: find \${ORACLE_BASE}/diag -name 'alert_\${ORACLE_SID}.log' 2>/dev/null" | tee -a "\${REPORT}"
fi

# --- Phase 2: Active GTX processes ---
echo "" | tee -a "\${REPORT}"
echo "[2] Active GTX Background Processes" | tee -a "\${REPORT}"
echo "--------------------------------------------------------------" | tee -a "\${REPORT}"
GTX_PROCS=\$(ps -ef | grep -i gtx | grep -v grep)
GTX_COUNT=\$(echo "\${GTX_PROCS}" | grep -c "gtx" 2>/dev/null)
echo "GTX processes running: \${GTX_COUNT}" | tee -a "\${REPORT}"
echo "\${GTX_PROCS}" | tee -a "\${REPORT}"

# --- Phase 3: Supplemental logging audit ---
echo "" | tee -a "\${REPORT}"
echo "[3] Database-Wide Supplemental Logging (v\$database)" | tee -a "\${REPORT}"
echo "--------------------------------------------------------------" | tee -a "\${REPORT}"

SUPPLOG=\$("\${ORACLE_HOME}/bin/sqlplus" -s \${DB_USER}/\${DB_PWD} <<ENDSQL
SET PAGESIZE 10
SET LINESIZE 120
SET FEEDBACK OFF
SET HEADING ON
COLUMN minimal FORMAT A8
COLUMN primary_key FORMAT A12
COLUMN all_columns FORMAT A12
COLUMN procedural FORMAT A12

SELECT supplemental_log_data_min  AS minimal,
       supplemental_log_data_pk   AS primary_key,
       supplemental_log_data_all  AS all_columns,
       supplemental_log_data_pl   AS procedural
FROM   v\\\$database;
EXIT;
ENDSQL
)
echo "\${SUPPLOG}" | tee -a "\${REPORT}"

ALL_COL=\$(echo "\${SUPPLOG}" | grep -i "YES" | grep -v "NO" | head -1)
if echo "\${SUPPLOG}" | awk 'NR>3{print \$3}' | grep -q "YES"; then
  echo "FINDING: Database-wide ALL_COLUMNS supplemental logging is ENABLED" | tee -a "\${REPORT}"
  echo "         This multiplies redo volume for every DML on every table" | tee -a "\${REPORT}"
  FINDING=1
fi

# --- Phase 4: Table-level log groups ---
echo "" | tee -a "\${REPORT}"
echo "[4] Table-Level Supplemental Log Groups (dba_log_groups)" | tee -a "\${REPORT}"
echo "--------------------------------------------------------------" | tee -a "\${REPORT}"

LOGGROUPS=\$("\${ORACLE_HOME}/bin/sqlplus" -s \${DB_USER}/\${DB_PWD} <<ENDSQL
SET PAGESIZE 200
SET LINESIZE 160
SET FEEDBACK OFF
COLUMN owner FORMAT A20
COLUMN table_name FORMAT A30
COLUMN log_group_name FORMAT A30
COLUMN log_group_type FORMAT A25
COLUMN always FORMAT A8

SELECT owner,
       table_name,
       log_group_name,
       log_group_type,
       always
FROM   dba_log_groups
WHERE  owner NOT IN ('SYS','SYSTEM','AUDSYS','ORDDATA','XDB')
ORDER BY owner, table_name;
EXIT;
ENDSQL
)
echo "\${LOGGROUPS}" | tee -a "\${REPORT}"

LG_COUNT=\$(echo "\${LOGGROUPS}" | grep -c "COLUMNS\|LOG GROUP" 2>/dev/null)
if [ "\${LG_COUNT}" -gt 0 ]; then
  echo "FINDING: \${LG_COUNT} supplemental log group(s) on user tables" | tee -a "\${REPORT}"
  echo "         Check if the replication/LogMiner consumer is still active" | tee -a "\${REPORT}"
  FINDING=1
fi

# --- Phase 5: Active LogMiner sessions ---
echo "" | tee -a "\${REPORT}"
echo "[5] Active LogMiner Sessions (v\$logmnr_session)" | tee -a "\${REPORT}"
echo "--------------------------------------------------------------" | tee -a "\${REPORT}"

LOGMNR=\$("\${ORACLE_HOME}/bin/sqlplus" -s \${DB_USER}/\${DB_PWD} <<ENDSQL
SET PAGESIZE 50
SET LINESIZE 120
SET FEEDBACK OFF
COLUMN db_name FORMAT A15
COLUMN status FORMAT A15

SELECT session_id, start_scn, end_scn, db_name, status
FROM   v\\\$logmnr_session;
EXIT;
ENDSQL
)
echo "\${LOGMNR}" | tee -a "\${REPORT}"

# --- Phase 6: Top redo generators (current) ---
echo "" | tee -a "\${REPORT}"
echo "[6] Top Redo Generators — Sessions > 10 MB" | tee -a "\${REPORT}"
echo "--------------------------------------------------------------" | tee -a "\${REPORT}"

REDOSESS=\$("\${ORACLE_HOME}/bin/sqlplus" -s \${DB_USER}/\${DB_PWD} <<ENDSQL
SET PAGESIZE 50
SET LINESIZE 160
SET FEEDBACK OFF
COLUMN username FORMAT A20
COLUMN program FORMAT A25
COLUMN machine FORMAT A25
COLUMN redo_mb FORMAT 999.99

SELECT s.sid,
       s.username,
       SUBSTR(s.program,1,25) AS program,
       SUBSTR(s.machine,1,25) AS machine,
       ROUND(st.value/1024/1024,2) AS redo_mb
FROM   v\\\$sesstat  st
JOIN   v\\\$statname sn ON st.statistic# = sn.statistic#
JOIN   v\\\$session  s  ON st.sid        = s.sid
WHERE  sn.name  = 'redo size'
  AND  st.value > 10485760
  AND  s.username IS NOT NULL
ORDER BY st.value DESC
FETCH FIRST 10 ROWS ONLY;
EXIT;
ENDSQL
)
echo "\${REDOSESS}" | tee -a "\${REPORT}"

# --- Phase 7: global_txn_processes setting ---
echo "" | tee -a "\${REPORT}"
echo "[7] global_txn_processes Parameter" | tee -a "\${REPORT}"
echo "--------------------------------------------------------------" | tee -a "\${REPORT}"

GTP=\$("\${ORACLE_HOME}/bin/sqlplus" -s \${DB_USER}/\${DB_PWD} <<ENDSQL
SET PAGESIZE 10
SET LINESIZE 80
SET FEEDBACK OFF
COLUMN value FORMAT A10

SELECT value FROM v\\\$parameter WHERE name = 'global_txn_processes';
EXIT;
ENDSQL
)
GTP_VAL=\$(echo "\${GTP}" | grep -E "^[0-9]" | tr -d ' ')
echo "global_txn_processes = \${GTP_VAL}" | tee -a "\${REPORT}"
if [ "\${GTP_VAL}" = "1" ]; then
  echo "FINDING: global_txn_processes = 1 — single GTX process, no redundancy" | tee -a "\${REPORT}"
  echo "         Consider increasing to 3 if XA transaction volume is high" | tee -a "\${REPORT}"
  FINDING=1
fi

# --- Phase 8: In-doubt 2PC transactions ---
echo "" | tee -a "\${REPORT}"
echo "[8] In-Doubt 2PC Transactions (dba_2pc_pending)" | tee -a "\${REPORT}"
echo "--------------------------------------------------------------" | tee -a "\${REPORT}"

TPC=\$("\${ORACLE_HOME}/bin/sqlplus" -s \${DB_USER}/\${DB_PWD} <<ENDSQL
SET PAGESIZE 50
SET LINESIZE 160
SET FEEDBACK OFF
COLUMN local_tran_id FORMAT A20
COLUMN state FORMAT A12
COLUMN advice FORMAT A8
COLUMN fail_time FORMAT A22

SELECT local_tran_id, state, advice,
       TO_CHAR(fail_time,'YYYY-MM-DD HH24:MI:SS') AS fail_time
FROM   dba_2pc_pending
ORDER BY fail_time DESC;
EXIT;
ENDSQL
)
echo "\${TPC}" | tee -a "\${REPORT}"
TPC_COUNT=\$(echo "\${TPC}" | grep -cE "prepared|collecting|committed|rolled" 2>/dev/null)
if [ "\${TPC_COUNT}" -gt 0 ]; then
  echo "FINDING: \${TPC_COUNT} in-doubt 2PC transaction(s) — coordinate with app team to ROLLBACK FORCE or COMMIT FORCE" | tee -a "\${REPORT}"
  FINDING=1
fi

# --- Final result ---
echo "" | tee -a "\${REPORT}"
echo "============================================================" | tee -a "\${REPORT}"
if [ \${FINDING} -eq 1 ]; then
  echo "RESULT: Findings detected — see above for details" | tee -a "\${REPORT}"
else
  echo "RESULT: No high-risk configuration found" | tee -a "\${REPORT}"
fi
echo "Report saved to: \${REPORT}" | tee -a "\${REPORT}"
echo "============================================================" | tee -a "\${REPORT}"

exit \${FINDING}
\`\`\`

### Usage

\`\`\`bash
chmod +x gtx_crash_audit.sh

# Source the Oracle environment
export ORACLE_SID=PRODDB1
export ORACLE_HOME=/u01/app/oracle/product/19c
export ORACLE_BASE=/u01/app/oracle
export PATH=\${ORACLE_HOME}/bin:\$PATH

# Run the audit
./gtx_crash_audit.sh <system_password>
\`\`\`

The script exits 1 if any of the following are found: multiple GTX crash entries in the alert log, database-wide ALL_COLUMNS supplemental logging, user table log groups with no active consumer, \`global_txn_processes = 1\`, or unresolved in-doubt 2PC transactions.

---

## Decision Matrix

| Finding | Most likely cause | Recommended action |
|---------|------------------|--------------------|
| Single GTX crash, no recurrence | One-off XA transaction abort | Monitor; no immediate change required |
| Multiple GTX crashes after supplemental logging enabled | Logging on XA-heavy table creating GTX overload | Audit log groups; narrow or remove logging on the identified table |
| Log groups present but no active LogMiner session | Orphaned supplemental logging from completed migration | Drop the log group immediately |
| Log group type is ALL COLUMNS or ALWAYS | Maximum redo amplification | Downgrade to PRIMARY KEY columns only |
| global_txn_processes = 1 | Single GTX process — no redundancy | Increase to 3 with \`ALTER SYSTEM SET global_txn_processes = 3 SCOPE=BOTH\` |
| In-doubt 2PC transactions after crash | Unresolved distributed transaction branches | Coordinate with application team; ROLLBACK FORCE or COMMIT FORCE per their guidance |
| SCSI/IO errors in /var/log/messages at crash time | Storage-layer process freeze | Treat as storage incident; file SR with storage vendor and Oracle Support |

---

## Summary

GTX background process death is a self-protecting mechanism: PMON terminates the instance because it cannot allow a mandatory process to remain dead. In environments where supplemental logging is enabled on high-frequency XA tables, the GTX death is not random — it is reproducible and will recur until the logging configuration is corrected or the GTX pool is made large enough to absorb the load. The audit script above surfaces the complete picture in one pass: crash history, active processes, logging footprint, redo leaders, and unresolved transactions. Fix the logging configuration first; increase \`global_txn_processes\` as a defense-in-depth measure second.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'Oracle RAC GTX Crash / ORA-00492 Runbook: Supplemental Logging Audit, Redo Analysis, and Safe Remediation',
    slug,
    excerpt: 'Operational runbook for diagnosing and remediating Oracle RAC instance crashes caused by GTX background process death in environments with supplemental logging enabled. Covers alert log triage, DIAG trace analysis, OS-level I/O exclusion, supplemental log group auditing via dba_log_groups and v$database, redo volume identification via ASH and v$sesstat, in-doubt 2PC transaction cleanup, and a full automation script that audits the complete configuration chain and exits non-zero on any high-risk finding.',
    content,
    category: 'rac-clusterware',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
