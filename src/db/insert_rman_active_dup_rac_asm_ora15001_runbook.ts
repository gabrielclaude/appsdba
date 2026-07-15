import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'rman-active-duplicate-rac-to-single-instance-ora-15001-asm-runbook';

const content = `
## Purpose

Use this runbook when an RMAN Active Duplicate from an Oracle RAC source to a single-instance ASM target fails with ORA-15001 (diskgroup does not exist or is not mounted), ORA-19504 (failed to create file), or ORA-17502 (kernel create call failed) — particularly when the target disk group queries as MOUNTED but RMAN still reports the error.

Phase flow: environment verification → OS group check → ASM connectivity → source connectivity → TNS resolution → corrected RMAN execution → progress monitoring → post-duplicate validation.

---

## Phase 1 — Identify the Oracle Database Version

The corrected RMAN script differs slightly between 11.2 and 12+. Establish the version on both source and target before proceeding.

\`\`\`bash
# On source (RAC node 1)
sqlplus / as sysdba
SQL> SELECT version FROM v\$instance;

# On target (single-instance)
sqlplus / as sysdba
SQL> SELECT version FROM v\$instance;
\`\`\`

Key differences by version:
- **11.2.0.4:** No \`SECTION SIZE\` clause; omit it from the RMAN script
- **12.1 and later:** \`SECTION SIZE\` available; recommended for datafiles > 32 GB
- **19c:** All features available; also supports \`USING ENCRYPTED BACKUPSET\` for TDE sources

---

## Phase 2 — Verify Target ASM Disk Groups

\`\`\`bash
# On the target server as the grid OS user
export ORACLE_SID=+ASM
export ORACLE_HOME=/u01/app/grid/product/19c/grid   # adjust to your Grid home
sqlplus / as sysasm << 'EOF'
SELECT inst_id,
       name,
       state,
       total_mb,
       free_mb
FROM   gv\$asm_diskgroup
ORDER  BY name;
EOF
\`\`\`

**Expected:** All target disk groups show \`STATE = MOUNTED\` with sufficient \`FREE_MB\` for the duplicate.

Estimate the required space before starting:

\`\`\`bash
# On the source, check total database size
sqlplus / as sysdba << 'EOF'
SELECT ROUND(SUM(bytes)/1024/1024/1024, 1) AS total_gb
FROM   dba_data_files;

SELECT ROUND(SUM(bytes)/1024/1024/1024, 1) AS redo_gb
FROM   v\$logfile lf
JOIN   v\$log l ON l.group# = lf.group#;
EOF
\`\`\`

The target DATA disk group needs at least the sum of datafile GB plus space for the control files and redo logs. RECO needs space for the standby redo logs and archived logs that accumulate during the duplicate.

---

## Phase 3 — OS Group Membership Check (Root Cause 2)

This is the most commonly missed prerequisite. On the target server, verify the oracle OS user belongs to the \`asmdba\` group.

\`\`\`bash
# Check oracle user groups on target
id oracle

# Look explicitly for asmdba
id oracle | grep -o 'asmdba' && echo "[PASS] oracle is in asmdba" || echo "[FAIL] oracle is NOT in asmdba"

# Check the asmdba group definition
grep ^asmdba /etc/group
\`\`\`

**If oracle is NOT in asmdba:**

\`\`\`bash
# Add oracle to asmdba (run as root)
usermod -a -G asmdba oracle

# Verify the change
id oracle | grep asmdba

# The oracle user must start a new OS session for the change to take effect.
# Existing oracle processes retain the old group set.
# If the target database instance is already running, bounce it after the group fix.
\`\`\`

**Verify oracle can connect to ASM directly after the group fix:**

\`\`\`bash
# As the oracle OS user on the target
export ORACLE_SID=+ASM
export ORACLE_HOME=/u01/app/grid/product/19c/grid
sqlplus / as sysasm << 'EOF'
SELECT name, state FROM v\$asm_diskgroup;
EOF
\`\`\`

If this succeeds and shows the disk groups MOUNTED, the oracle user has the correct ASM access. If it fails with ORA-01031 or ORA-15001, recheck the group membership and Oracle homes.

---

## Phase 4 — Auxiliary Instance Startup Check

Before running the duplicate, the auxiliary (target) instance must be able to reach NOMOUNT. If it cannot, the group membership issue or SPFILE problem will surface here rather than mid-duplicate.

\`\`\`bash
# On the target, start the auxiliary instance to nomount with a minimal pfile
# Create a temporary pfile if no spfile exists yet
cat > /tmp/init_targetdb_dup.ora << 'EOF'
db_name=TARGETDB
EOF

export ORACLE_SID=TARGETDB
sqlplus / as sysdba << 'EOF'
STARTUP NOMOUNT PFILE='/tmp/init_targetdb_dup.ora';
SELECT status FROM v\$instance;
EOF
\`\`\`

**Expected:** \`STATUS = STARTED\` (which is the internal representation of NOMOUNT).

If startup fails with ORA-15001 at this stage, the issue is confirmed as OS group membership or the oracle binary's access to the ASM instance — resolve Phase 3 before continuing.

Leave the auxiliary at NOMOUNT. RMAN will manage it from here.

---

## Phase 5 — Source Database Prerequisites

\`\`\`bash
# On the source (any RAC node), verify ARCHIVELOG mode
sqlplus / as sysdba << 'EOF'
SELECT log_mode FROM v\$database;
-- Expected: ARCHIVELOG

-- Verify the source is not in restricted mode
SELECT logins FROM v\$instance;
-- Expected: ALLOWED

-- Check for any active backup jobs that could conflict
SELECT status, count(*) FROM v\$rman_status
WHERE start_time > SYSDATE - 1/24
GROUP BY status;
EOF
\`\`\`

Active duplicate requires the source to be in ARCHIVELOG mode. It does not require the source to be in MOUNT — it runs against an open database.

---

## Phase 6 — TNS Connectivity Verification

The source RAC channels must be able to reach the target, and the RMAN client must be able to reach both. Verify all required TNS aliases resolve.

\`\`\`bash
# On the RMAN client server (or the target server if running RMAN there)
# Test source connectivity
tnsping SOURCEDB
sqlplus sys@SOURCEDB as sysdba << 'EOF'
SELECT name, open_mode FROM v\$database;
EOF

# Test auxiliary connectivity
tnsping TARGETDB
sqlplus sys@TARGETDB as sysdba << 'EOF'
SELECT name, status FROM v\$instance;
EOF
\`\`\`

**If TARGETDB does not have a TNS entry yet:** Add one to \`\$TNS_ADMIN/tnsnames.ora\` on the RMAN client server before proceeding. The auxiliary must be reachable by name from where RMAN is running.

\`\`\`
# Example entry for the target single-instance
TARGETDB =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = targetdb-host.example.com)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = TARGETDB)
    )
  )
\`\`\`

---

## Phase 7 — Multi-Node Channel Diagnosis

To confirm whether the source RAC is allocating channels across multiple nodes (Root Cause 1), check the RMAN diagnostic trace directory on the source after a failed attempt.

\`\`\`bash
# On the source RAC nodes — check which nodes generated traces during the failed run
ls -lt /u01/app/oracle/diag/rdbms/sourcedb/*/trace/ | grep -i "$(date +%Y%m%d)" | head -20

# Multiple instance directories (SOURCEDB1, SOURCEDB2, etc.) in the trace path
# confirms multi-node channel allocation was occurring
\`\`\`

If you see trace directories for more than one RAC instance, the default channel allocation is using multiple nodes. The corrected script in Phase 8 resolves this by explicitly allocating local auxiliary channels.

---

## Phase 8 — Execute the Corrected Duplicate

### Oracle 11.2.0.4

\`\`\`text
rman target sys@SOURCEDB auxiliary sys@TARGETDB

RUN {
  ALLOCATE AUXILIARY CHANNEL aux1 DEVICE TYPE DISK;
  ALLOCATE AUXILIARY CHANNEL aux2 DEVICE TYPE DISK;

  DUPLICATE TARGET DATABASE TO 'TARGETDB'
    FROM ACTIVE DATABASE
    USING COMPRESSED BACKUPSET
    NOFILENAMECHECK
    SPFILE
      SET db_unique_name='TARGETDB'
      SET db_create_file_dest='+DATA'
      SET db_recovery_file_dest='+RECO'
      SET control_files='+DATA','+RECO'
      SET cluster_database='FALSE';
}
\`\`\`

### Oracle 12.1, 12.2, 19c

\`\`\`text
rman target sys@SOURCEDB auxiliary sys@TARGETDB

RUN {
  ALLOCATE AUXILIARY CHANNEL aux1 DEVICE TYPE DISK;
  ALLOCATE AUXILIARY CHANNEL aux2 DEVICE TYPE DISK;

  DUPLICATE TARGET DATABASE TO 'TARGETDB'
    FROM ACTIVE DATABASE
    SECTION SIZE 32G
    USING COMPRESSED BACKUPSET
    NOFILENAMECHECK
    SPFILE
      SET db_unique_name='TARGETDB'
      SET db_create_file_dest='+DATA'
      SET db_recovery_file_dest='+RECO'
      SET control_files='+DATA','+RECO'
      SET cluster_database='FALSE';
}
\`\`\`

**Adjust before running:**
- Replace \`TARGETDB\` with the target \`DB_NAME\`
- Replace \`SOURCEDB\` with the TNS alias for the source RAC
- Replace \`+DATA\` and \`+RECO\` with the actual ASM disk group names on the target
- Adjust \`SECTION SIZE\` if the network bandwidth or datafile sizes suggest a different split
- Add additional \`SET\` parameters if the source SPFILE has parameters incompatible with a single-instance (e.g., \`thread\`, \`instance_number\`, \`undo_tablespace\` with RAC-specific names)

---

## Phase 9 — Monitor Duplicate Progress

Once the duplicate is running, monitor it from a second session. Do not interrupt the RMAN session.

\`\`\`bash
# In a separate sqlplus session connected to the auxiliary
sqlplus sys@TARGETDB as sysdba << 'EOF'
-- Progress of backup set restore (shows % complete for each file being transferred)
SELECT sid,
       serial#,
       opname,
       sofar,
       totalwork,
       ROUND(sofar/DECODE(totalwork,0,1,totalwork)*100,1) AS pct_done,
       elapsed_seconds,
       time_remaining
FROM   v\$session_longops
WHERE  opname LIKE '%RMAN%'
AND    totalwork > 0
ORDER  BY start_time;
EOF
\`\`\`

\`\`\`bash
# Monitor alert log on the target for progress and errors
tail -f /u01/app/oracle/diag/rdbms/targetdb/TARGETDB/trace/alert_TARGETDB.log
\`\`\`

Milestones in the alert log that confirm progress:

\`\`\`
Starting ORACLE instance (normal) ...       ← auxiliary starting nomount
Control autobackup written ...              ← control file created (ORA-15001 resolved)
Database mounted.                           ← moving to mount phase
Media Recovery Log ...                     ← archive log application
Completed: ALTER DATABASE OPEN RESETLOGS  ← duplicate complete
\`\`\`

---

## Phase 10 — Post-Duplicate Validation

After RMAN exits cleanly, verify the duplicate result.

\`\`\`bash
sqlplus / as sysdba << 'EOF'
-- Database is open
SELECT name, open_mode, db_unique_name, log_mode FROM v\$database;

-- cluster_database is FALSE
SELECT name, value FROM v\$parameter WHERE name = 'cluster_database';

-- db_unique_name matches what was set
SELECT name, value FROM v\$parameter WHERE name = 'db_unique_name';

-- All datafiles online and not needing recovery
SELECT file#, status, name FROM v\$datafile WHERE status != 'ONLINE';

-- No datafiles needing media recovery
SELECT file#, error FROM v\$datafile_header WHERE recover = 'YES';

-- Check data file counts match source
SELECT COUNT(*) FROM dba_data_files;
EOF
\`\`\`

Compare the datafile count against the source:

\`\`\`bash
# On source
sqlplus / as sysdba << 'EOF'
SELECT COUNT(*) FROM dba_data_files;
EOF
\`\`\`

---

## Automation Script

The \`rman_dup_precheck.sh\` script runs Phases 1–6 automatically and outputs a go/no-go summary before you start the duplicate. Run it on the target server after sourcing the oracle environment.

\`\`\`bash
#!/bin/bash
# rman_dup_precheck.sh
# Usage: ./rman_dup_precheck.sh <SOURCE_TNS_ALIAS> <TARGET_DB_NAME> <DATA_DG> <RECO_DG>
# Example: ./rman_dup_precheck.sh SOURCEDB TARGETDB DATA RECO
# Exits 0 if all checks pass, 1 if any check fails.

SOURCE_TNS="\${1:?Usage: \$0 <SOURCE_TNS> <TARGET_DB> <DATA_DG> <RECO_DG>}"
TARGET_DB="\${2:?}"
DATA_DG="\${3:?}"
RECO_DG="\${4:?}"

PASS=0
FAIL=0

check() {
  local label="\$1"
  local cmd="\$2"
  local expect="\$3"
  local out
  out=\$(eval "\$cmd" 2>&1)
  if echo "\$out" | grep -qi "\$expect"; then
    echo "[PASS] \${label}"
    PASS=\$((PASS+1))
  else
    echo "[FAIL] \${label}"
    echo "       Output: \$(echo \$out | head -c 200)"
    FAIL=\$((FAIL+1))
  fi
}

echo "========================================"
echo " RMAN Active Duplicate Pre-Check"
echo " \$(date)"
echo " Source : \${SOURCE_TNS}"
echo " Target : \${TARGET_DB}"
echo " DGs    : \${DATA_DG} / \${RECO_DG}"
echo "========================================"
echo ""

# 1. Oracle version on target
echo "=== Oracle Version (target) ==="
sqlplus -s / as sysdba << 'EOF'
SET FEEDBACK OFF HEADING OFF PAGESIZE 0
SELECT 'Version: ' || version FROM v\$instance;
EOF
echo ""

# 2. asmdba group membership
echo "=== OS Group Membership ==="
check "oracle user in asmdba" "id oracle" "asmdba"

# 3. ASM disk groups mounted
echo ""
echo "=== ASM Disk Groups ==="
ASM_RESULT=\$(sqlplus -s / as sysasm << EOF
SET FEEDBACK OFF HEADING OFF PAGESIZE 0
SELECT name || ':' || state FROM v\$asm_diskgroup WHERE name IN ('DATA','RECO');
EOF
)
echo "Disk group status: \${ASM_RESULT}"

for DG in \${DATA_DG} \${RECO_DG}; do
  check "Disk group \${DG} MOUNTED" \
    "sqlplus -s / as sysasm <<< \"SET FEEDBACK OFF HEADING OFF PAGESIZE 0
SELECT state FROM v\\\$asm_diskgroup WHERE name = '\${DG}';\"" \
    "MOUNTED"
done

# 4. oracle can connect to ASM
echo ""
echo "=== ASM Connectivity as oracle ==="
ASM_CONN=\$(export ORACLE_SID=+ASM; sqlplus -s / as sysasm << 'EOF' 2>&1
SET FEEDBACK OFF HEADING OFF PAGESIZE 0
SELECT 'CONNECTED' FROM dual;
EOF
)
echo "\${ASM_CONN}" | grep -q "CONNECTED" \
  && { echo "[PASS] oracle can connect to +ASM"; PASS=\$((PASS+1)); } \
  || { echo "[FAIL] oracle cannot connect to +ASM — check asmdba group and ORACLE_HOME"; FAIL=\$((FAIL+1)); }

# 5. Auxiliary instance can reach NOMOUNT
echo ""
echo "=== Auxiliary Instance NOMOUNT Test ==="
NOMOUNT_RESULT=\$(sqlplus -s / as sysdba << 'EOF' 2>&1
STARTUP NOMOUNT FORCE;
SELECT 'NOMOUNT_OK' FROM dual;
SHUTDOWN ABORT;
EOF
)
echo "\${NOMOUNT_RESULT}" | grep -q "NOMOUNT_OK" \
  && { echo "[PASS] Auxiliary instance started NOMOUNT successfully"; PASS=\$((PASS+1)); } \
  || { echo "[FAIL] Auxiliary instance could not start NOMOUNT"; FAIL=\$((FAIL+1)); echo "\${NOMOUNT_RESULT}" | tail -5; }

# 6. Source TNS resolves
echo ""
echo "=== TNS Connectivity ==="
check "Source TNS (\${SOURCE_TNS}) resolves" \
  "tnsping \${SOURCE_TNS} 2>&1" \
  "OK"

# 7. Source is in ARCHIVELOG mode
echo ""
echo "=== Source ARCHIVELOG Mode ==="
ARCHLOG=\$(sqlplus -s "sys@\${SOURCE_TNS} as sysdba" << 'EOF' 2>&1
SET FEEDBACK OFF HEADING OFF PAGESIZE 0
SELECT log_mode FROM v\$database;
EOF
)
echo "Source log_mode: \$(echo \${ARCHLOG} | grep -oE '[A-Z]+')"
echo "\${ARCHLOG}" | grep -q "ARCHIVELOG" \
  && { echo "[PASS] Source is in ARCHIVELOG mode"; PASS=\$((PASS+1)); } \
  || { echo "[FAIL] Source is NOT in ARCHIVELOG mode — active duplicate requires ARCHIVELOG"; FAIL=\$((FAIL+1)); }

# 8. Estimate required space
echo ""
echo "=== Source Database Size Estimate ==="
sqlplus -s "sys@\${SOURCE_TNS} as sysdba" << 'EOF'
SET FEEDBACK OFF PAGESIZE 40 LINESIZE 80
SELECT 'Datafiles: ' || ROUND(SUM(bytes)/1024/1024/1024,1) || ' GB' AS size_info
FROM   dba_data_files
UNION ALL
SELECT 'Temp files: ' || ROUND(SUM(bytes)/1024/1024/1024,1) || ' GB'
FROM   dba_temp_files;
EOF

# Summary
echo ""
echo "========================================"
echo " RESULT: \${PASS} passed, \${FAIL} failed"
if [ "\${FAIL}" -eq 0 ]; then
  echo " STATUS: GO — proceed with RMAN duplicate"
else
  echo " STATUS: NO-GO — resolve \${FAIL} failed check(s) before duplicating"
fi
echo "========================================"

[ "\${FAIL}" -eq 0 ]
\`\`\`

**Usage:**

\`\`\`bash
chmod +x rman_dup_precheck.sh

# Set oracle environment first
export ORACLE_SID=TARGETDB
export ORACLE_HOME=/u01/app/oracle/product/19c/dbhome_1
export PATH=\$ORACLE_HOME/bin:\$PATH

# Run checks
./rman_dup_precheck.sh SOURCEDB TARGETDB DATA RECO
\`\`\`

---

## Summary

| Phase | Check | Tool / Command |
|-------|-------|---------------|
| 1 | Oracle version on source and target | \`v\$instance.version\` |
| 2 | ASM disk groups MOUNTED on target | \`v\$asm_diskgroup\` via sysasm |
| 3 | oracle OS user in asmdba group | \`id oracle\` / \`usermod -a -G asmdba oracle\` |
| 4 | oracle can connect to +ASM instance | \`sqlplus / as sysasm\` as oracle OS user |
| 5 | Auxiliary instance starts to NOMOUNT | \`STARTUP NOMOUNT FORCE\` |
| 6 | Source ARCHIVELOG mode | \`v\$database.log_mode\` |
| 7 | TNS aliases resolve for both source and target | \`tnsping\` |
| 8 | Sufficient space in target ASM disk groups | \`dba_data_files\` sum vs \`v\$asm_diskgroup.free_mb\` |
| 9 | Execute corrected RMAN script | Explicit auxiliary channels + \`cluster_database=FALSE\` |
| 10 | Monitor progress | \`v\$session_longops\` + alert log |
| 11 | Post-duplicate validation | \`v\$database\`, \`v\$datafile\`, parameter checks |

The first RMAN failure is almost always control file creation. If the auxiliary instance reaches NOMOUNT cleanly but RMAN aborts at control file creation with ORA-15001, the root cause is either the asmdba group membership (Phase 3) or multi-node channel routing (Phase 8 fix). Both are resolved without changing anything about the ASM disk groups or the target server infrastructure.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'RMAN Active Duplicate RAC to Single-Instance ASM Runbook: Diagnosing ORA-15001 and ORA-19504 Pre-Checks and Corrected Script',
    slug,
    excerpt: 'Pre-duplicate checklist and diagnostic runbook for RMAN Active Duplicate failures from Oracle RAC to single-instance ASM targets. Covers oracle OS user asmdba group membership verification, ASM connectivity testing, auxiliary NOMOUNT startup check, TNS resolution, multi-node channel diagnosis, and the corrected RMAN RUN block with explicit auxiliary channel allocation and cluster_database=FALSE override. Includes the rman_dup_precheck.sh automation script for go/no-go assessment before starting the duplicate.',
    content,
    category: 'rac-clusterware',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
