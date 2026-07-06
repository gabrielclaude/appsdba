import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'oracle-database-19c-docker-rhel9-runbook';

const content = `
Day-two operations runbook for Oracle Database 19c running in Docker on RHEL 9. Covers container lifecycle, RMAN backup, patching workflow, and a complete performance monitoring script suite — container-level cgroup metrics, Oracle session analysis, I/O profiling, and AWR-based diagnostics.

---

## Phase 1 — Container Lifecycle

### Start / Stop / Restart

\`\`\`bash
# Graceful shutdown (waits for Oracle to close cleanly)
docker exec oracle-db sqlplus -S / as sysdba <<< "shutdown immediate;"
docker stop oracle-db

# Start existing container (volumes preserved)
docker start oracle-db

# Restart with graceful stop
docker restart --time 120 oracle-db

# Emergency kill (last resort — may corrupt redo)
docker kill oracle-db
\`\`\`

### Check database state after restart

\`\`\`bash
docker logs oracle-db 2>&1 | tail -30
docker exec oracle-db sqlplus -S / as sysdba <<< "
SELECT instance_name, status FROM v\\\$instance;
SELECT name, open_mode FROM v\\\$pdbs;
"
\`\`\`

### Open PDB if it did not auto-open

\`\`\`bash
docker exec oracle-db sqlplus -S / as sysdba <<< "
ALTER PLUGGABLE DATABASE ORCLPDB1 OPEN;
ALTER PLUGGABLE DATABASE ORCLPDB1 SAVE STATE;
"
\`\`\`

---

## Phase 2 — RMAN Backup

### Configure RMAN retention and channels

\`\`\`bash
docker exec -it oracle-db rman target / <<< "
CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 7 DAYS;
CONFIGURE BACKUP OPTIMIZATION ON;
CONFIGURE DEFAULT DEVICE TYPE TO DISK;
CONFIGURE CONTROLFILE AUTOBACKUP ON;
CONFIGURE CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE DISK TO '/opt/oracle/oradata/rman/%F';
CONFIGURE CHANNEL DEVICE TYPE DISK FORMAT '/opt/oracle/oradata/rman/%U';
CONFIGURE PARALLELISM 2;
"
\`\`\`

### Full backup script

\`\`\`bash
#!/bin/bash
# /opt/oracle/scripts/rman_full_backup.sh

LOG=/var/log/oracle/rman_\$(date +%Y%m%d_%H%M%S).log
mkdir -p /var/log/oracle

docker exec oracle-db rman target / >> "\$LOG" 2>&1 <<'RMAN'
RUN {
  ALLOCATE CHANNEL c1 DEVICE TYPE DISK;
  ALLOCATE CHANNEL c2 DEVICE TYPE DISK;
  BACKUP AS COMPRESSED BACKUPSET FULL DATABASE
    INCLUDE CURRENT CONTROLFILE
    PLUS ARCHIVELOG DELETE INPUT;
  DELETE NOPROMPT OBSOLETE;
  RELEASE CHANNEL c1;
  RELEASE CHANNEL c2;
}
RMAN

RC=\$?
if [ \$RC -ne 0 ]; then
  echo "RMAN backup FAILED — rc=\$RC" | mail -s "OracleDB Backup FAILED \$(hostname)" dba@company.com
fi
exit \$RC
\`\`\`

\`\`\`bash
chmod +x /opt/oracle/scripts/rman_full_backup.sh

# Cron: full backup daily at 01:00
echo "0 1 * * * root /opt/oracle/scripts/rman_full_backup.sh" >> /etc/cron.d/oracle-backup
\`\`\`

---

## Phase 3 — Patching Workflow

Oracle patches apply inside the container image. Patch → rebuild image → replace container (volumes survive).

\`\`\`bash
# 1. Download latest RU from MOS, place in 19.3.0/ dir
#    e.g. p35943989_190000_Linux-x86-64.zip (19.22 RU)

# 2. Rebuild image with patch
./buildContainerImage.sh -v 19.3.0 -e -p 35943989 -t oracle/database:19.22-ee

# 3. Stop and remove old container (volumes are safe)
docker exec oracle-db sqlplus -S / as sysdba <<< "shutdown immediate;"
docker stop oracle-db
docker rm oracle-db

# 4. Run new container using same volumes
docker run -d --name oracle-db \
  --network oracle-net --ip 172.20.0.10 \
  -p 1521:1521 -p 5500:5500 \
  --memory 8g --shm-size 4g \
  -e ORACLE_SID=ORCLCDB -e ORACLE_PDB=ORCLPDB1 \
  -e ORACLE_PWD=Oracle19c_Strong#Pwd \
  -v oracle-data:/opt/oracle/oradata \
  oracle/database:19.22-ee

# 5. Verify patch level
docker exec oracle-db sqlplus -S / as sysdba <<< "SELECT patch_id, version, status FROM dba_registry_sqlpatch ORDER BY action_time;"
\`\`\`

---

## Phase 4 — Performance Monitoring Scripts

### Script 1: Container Resource Monitor (cgroup metrics)

\`\`\`bash
#!/bin/bash
# /opt/oracle/scripts/perf/container_stats.sh
# Real-time Docker cgroup metrics — CPU throttling, memory pressure, I/O wait.
# Run: ./container_stats.sh [interval_seconds]

CONTAINER="oracle-db"
INTERVAL=\${1:-5}
LOG=/var/log/oracle/perf/container_stats_\$(date +%Y%m%d).log
mkdir -p /var/log/oracle/perf

print_header() {
  printf "%-20s %-8s %-8s %-12s %-12s %-14s %-14s %-12s\\n" \\
    "Timestamp" "CPU%" "ThrottPct" "MemUsed_MB" "MemLimit_MB" "BlockRd_MB/s" "BlockWr_MB/s" "NetTx_KB/s"
}

prev_cpu_total=0; prev_cpu_sys=0; prev_blk_r=0; prev_blk_w=0

print_header | tee -a "\$LOG"

while true; do
  STATS=\$(docker stats --no-stream --format "{{json .}}" "\$CONTAINER" 2>/dev/null)
  [ -z "\$STATS" ] && { echo "Container \$CONTAINER not running"; sleep "\$INTERVAL"; continue; }

  # Parse docker stats JSON
  CPU_PCT=\$(echo "\$STATS"      | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['CPUPerc'].rstrip('%'))")
  MEM_USAGE=\$(echo "\$STATS"   | python3 -c "import sys,json; d=json.load(sys.stdin); u=d['MemUsage'].split('/')[0].strip(); print(u)")
  MEM_LIMIT=\$(echo "\$STATS"   | python3 -c "import sys,json; d=json.load(sys.stdin); l=d['MemUsage'].split('/')[1].strip(); print(l)")
  BLOCK_IO=\$(echo "\$STATS"    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['BlockIO'])")
  NET_IO=\$(echo "\$STATS"      | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['NetIO'])")

  # Cgroup throttling (requires root or cgroup access)
  CGROUP_PATH=\$(docker inspect --format '{{.HostConfig.CgroupParent}}' "\$CONTAINER" 2>/dev/null)
  CGROUP_MOUNT=\$(findmnt -t cgroup2 -n -o TARGET 2>/dev/null | head -1)
  THROTTLE_PCT="N/A"
  if [ -n "\$CGROUP_MOUNT" ]; then
    CONTAINER_ID=\$(docker inspect --format '{{.Id}}' "\$CONTAINER" 2>/dev/null)
    CPU_STAT="\$CGROUP_MOUNT/system.slice/docker-\${CONTAINER_ID}.scope/cpu.stat"
    if [ -f "\$CPU_STAT" ]; then
      THROTTLED_US=\$(grep throttled_usec "\$CPU_STAT" | awk '{print \$2}')
      USAGE_US=\$(grep usage_usec     "\$CPU_STAT" | awk '{print \$2}')
      if [ "\$USAGE_US" -gt 0 ] 2>/dev/null; then
        THROTTLE_PCT=\$(awk "BEGIN {printf \"%.1f\", \$THROTTLED_US/(\$USAGE_US+\$THROTTLED_US)*100}")
      fi
    fi
  fi

  printf "%-20s %-8s %-8s %-12s %-12s %-14s %-14s %-12s\\n" \\
    "\$(date '+%Y-%m-%d %H:%M:%S')" "\$CPU_PCT" "\$THROTTLE_PCT" \\
    "\$MEM_USAGE" "\$MEM_LIMIT" "\$BLOCK_IO" "\$NET_IO" "see stats" \\
    | tee -a "\$LOG"

  # Alert on CPU throttling > 20%
  if [[ "\$THROTTLE_PCT" != "N/A" ]] && (( \$(echo "\$THROTTLE_PCT > 20" | bc -l) )); then
    echo "ALERT: CPU throttling \${THROTTLE_PCT}% — consider increasing --cpus" \\
      | tee -a "\$LOG"
  fi

  # Alert on memory > 90% of limit
  # (docker stats reports in human units; use /sys/fs/cgroup for exact bytes)
  CONTAINER_ID=\$(docker inspect --format '{{.Id}}' "\$CONTAINER" 2>/dev/null)
  MEM_CURRENT=\$(cat /sys/fs/cgroup/system.slice/docker-\${CONTAINER_ID}.scope/memory.current 2>/dev/null || echo 0)
  MEM_MAX=\$(cat    /sys/fs/cgroup/system.slice/docker-\${CONTAINER_ID}.scope/memory.max      2>/dev/null || echo 1)
  if [ "\$MEM_MAX" != "max" ] && [ "\$MEM_MAX" -gt 0 ] && [ "\$MEM_CURRENT" -gt 0 ]; then
    MEM_PCT=\$(awk "BEGIN {printf \"%.0f\", \$MEM_CURRENT/\$MEM_MAX*100}")
    if [ "\$MEM_PCT" -gt 90 ]; then
      echo "ALERT: Container memory at \${MEM_PCT}% of limit (\${MEM_CURRENT} / \${MEM_MAX} bytes)" \\
        | tee -a "\$LOG"
    fi
  fi

  sleep "\$INTERVAL"
done
\`\`\`

---

### Script 2: Oracle Session and Wait Event Monitor

\`\`\`bash
#!/bin/bash
# /opt/oracle/scripts/perf/session_monitor.sh
# Top Oracle wait events, blocking sessions, and hot SQL — refreshes every 30s.
# Run: ./session_monitor.sh [interval_seconds]

INTERVAL=\${1:-30}
DB_USER="sys"
DB_PASS="Oracle19c_Strong#Pwd"
DB_SID="ORCLCDB"

run_sql() {
  docker exec oracle-db sqlplus -S "\${DB_USER}/\${DB_PASS}@\${DB_SID} as sysdba" <<< "\$1"
}

while true; do
  clear
  echo "========================================"
  echo " Oracle 19c Session Monitor — \$(date)"
  echo "========================================"

  echo ""
  echo "--- Active Sessions by Wait Class ---"
  run_sql "
SET PAGESIZE 50 LINESIZE 120 FEEDBACK OFF
SELECT wait_class, COUNT(*) sessions, ROUND(AVG(seconds_in_wait),1) avg_wait_sec
FROM   v\\\$session
WHERE  status = 'ACTIVE' AND type = 'USER'
GROUP BY wait_class
ORDER BY sessions DESC
FETCH FIRST 10 ROWS ONLY;
"

  echo ""
  echo "--- Top 10 Wait Events (current) ---"
  run_sql "
SET PAGESIZE 50 LINESIZE 120 FEEDBACK OFF
SELECT event, COUNT(*) sessions, ROUND(AVG(seconds_in_wait),1) avg_sec
FROM   v\\\$session
WHERE  status = 'ACTIVE' AND type = 'USER' AND wait_class != 'Idle'
GROUP BY event
ORDER BY sessions DESC
FETCH FIRST 10 ROWS ONLY;
"

  echo ""
  echo "--- Blocking Lock Chain ---"
  run_sql "
SET PAGESIZE 50 LINESIZE 150 FEEDBACK OFF
SELECT LPAD(' ', 2*(LEVEL-1)) || s.sid        AS sid_tree,
       s.username, s.status, s.wait_class, s.event,
       s.seconds_in_wait,
       SUBSTR(q.sql_text,1,60)                 AS sql_text
FROM   v\\\$session s
       LEFT JOIN v\\\$sql q ON s.sql_id = q.sql_id AND s.sql_child_number = q.child_number
WHERE  s.type = 'USER'
START  WITH s.blocking_session IS NULL AND EXISTS (
         SELECT 1 FROM v\\\$session s2 WHERE s2.blocking_session = s.sid)
CONNECT BY PRIOR s.sid = s.blocking_session
ORDER SIBLINGS BY s.sid;
"

  echo ""
  echo "--- Top 5 SQL by Elapsed Time (last 5 min) ---"
  run_sql "
SET PAGESIZE 50 LINESIZE 150 FEEDBACK OFF
SELECT ROUND(elapsed_time/1e6,2) elapsed_sec,
       executions,
       ROUND(elapsed_time/GREATEST(executions,1)/1e6,4) ela_per_exec,
       SUBSTR(sql_text,1,80) sql_text
FROM   v\\\$sql
WHERE  last_active_time > SYSDATE - INTERVAL '5' MINUTE
  AND  executions > 0
ORDER BY elapsed_time DESC
FETCH FIRST 5 ROWS ONLY;
"

  echo ""
  echo "--- Memory: SGA / PGA / Buffer Cache ---"
  run_sql "
SET PAGESIZE 20 LINESIZE 80 FEEDBACK OFF
SELECT name, ROUND(value/1024/1024,0) MB
FROM   v\\\$pgastat WHERE name IN ('total PGA allocated','aggregate PGA target parameter','cache hit percentage')
UNION ALL
SELECT 'SGA Target', ROUND(value/1024/1024,0) FROM v\\\$parameter WHERE name='sga_target'
UNION ALL
SELECT 'Buffer Cache Hit%',
       ROUND((1 - phyrds/(dbgr + phyrds + NULLIF(phywrts,0)))*100, 1)
FROM  (SELECT SUM(DECODE(name,'db block gets',value,0))         dbgr,
              SUM(DECODE(name,'consistent gets',value,0))        cgets,
              SUM(DECODE(name,'physical reads',value,0))         phyrds,
              SUM(DECODE(name,'physical writes',value,0))        phywrts
         FROM v\\\$sysstat) x
ORDER BY 1;
"

  echo ""
  echo "Next refresh in \${INTERVAL}s — Ctrl+C to exit"
  sleep "\$INTERVAL"
done
\`\`\`

---

### Script 3: I/O Performance Profiler

\`\`\`bash
#!/bin/bash
# /opt/oracle/scripts/perf/io_profiler.sh
# Per-datafile I/O throughput, latency, and hot-block analysis.
# Combines docker stats block I/O with Oracle v$filestat / v$tempstat.

DB_USER="sys"
DB_PASS="Oracle19c_Strong#Pwd"
DB_SID="ORCLCDB"
CONTAINER="oracle-db"
INTERVAL=60
LOG=/var/log/oracle/perf/io_profile_\$(date +%Y%m%d_%H%M%S).log
mkdir -p /var/log/oracle/perf

run_sql() {
  docker exec "\$CONTAINER" sqlplus -S "\${DB_USER}/\${DB_PASS}@\${DB_SID} as sysdba" <<< "\$1"
}

echo "Oracle 19c I/O Profiler — \$(date)" | tee "\$LOG"
echo "Sampling every \${INTERVAL}s — Ctrl+C to stop" | tee -a "\$LOG"

while true; do
  echo "" | tee -a "\$LOG"
  echo "=== \$(date '+%Y-%m-%d %H:%M:%S') ===" | tee -a "\$LOG"

  echo "" | tee -a "\$LOG"
  echo "-- Container Block I/O (cumulative) --" | tee -a "\$LOG"
  docker stats --no-stream --format "BlockIO: {{.BlockIO}}   NetIO: {{.NetIO}}" "\$CONTAINER" 2>/dev/null | tee -a "\$LOG"

  echo "" | tee -a "\$LOG"
  echo "-- Top 10 Datafiles by Physical Reads (since startup) --" | tee -a "\$LOG"
  run_sql "
SET PAGESIZE 30 LINESIZE 130 FEEDBACK OFF
SELECT f.file#,
       SUBSTR(f.name,INSTR(f.name,'/',-1)+1,30) filename,
       fs.phyrds,
       fs.phywrts,
       ROUND(fs.readtim/GREATEST(fs.phyrds,1),2)  avg_read_ms,
       ROUND(fs.writetim/GREATEST(fs.phywrts,1),2) avg_write_ms,
       fs.singleblkrds,
       ROUND(fs.singleblkrdtim/GREATEST(fs.singleblkrds,1),2) avg_sblk_ms
FROM   v\\\$filestat fs JOIN v\\\$datafile f ON fs.file# = f.file#
ORDER BY fs.phyrds DESC
FETCH FIRST 10 ROWS ONLY;
" | tee -a "\$LOG"

  echo "" | tee -a "\$LOG"
  echo "-- Temp File I/O (sort spill indicator) --" | tee -a "\$LOG"
  run_sql "
SET PAGESIZE 10 LINESIZE 100 FEEDBACK OFF
SELECT tf.file#,
       SUBSTR(tf.name,INSTR(tf.name,'/',-1)+1,30) filename,
       ts.phyrds, ts.phywrts,
       ROUND(ts.readtim/GREATEST(ts.phyrds,1),2) avg_read_ms
FROM   v\\\$tempstat ts JOIN v\\\$tempfile tf ON ts.file# = tf.file#
ORDER BY ts.phyrds DESC;
" | tee -a "\$LOG"

  echo "" | tee -a "\$LOG"
  echo "-- Top 5 Hot Segments (buffer busy waits) --" | tee -a "\$LOG"
  run_sql "
SET PAGESIZE 10 LINESIZE 130 FEEDBACK OFF
SELECT owner, segment_name, segment_type,
       obj_buf.value              buffer_busy_waits,
       obj_phyr.value             physical_reads
FROM   v\\\$segstat_name n
       JOIN v\\\$segstat obj_buf  ON n.statistic# = obj_buf.statistic#  AND n.name = 'buffer busy waits'
       JOIN v\\\$segstat obj_phyr ON obj_phyr.ts# = obj_buf.ts#
         AND obj_phyr.obj# = obj_buf.obj#
       JOIN dba_objects o ON o.object_id = obj_buf.obj#
WHERE  obj_buf.value > 0
ORDER BY obj_buf.value DESC
FETCH FIRST 5 ROWS ONLY;
" | tee -a "\$LOG"

  echo "" | tee -a "\$LOG"
  echo "-- Redo Log Activity --" | tee -a "\$LOG"
  run_sql "
SET PAGESIZE 10 LINESIZE 80 FEEDBACK OFF
SELECT name, ROUND(value/1024/1024,2) MB
FROM   v\\\$sysstat
WHERE  name IN ('redo size','redo writes','redo write time','redo log space requests')
ORDER BY name;
" | tee -a "\$LOG"

  sleep "\$INTERVAL"
done
\`\`\`

---

### Script 4: AWR Snapshot and Report Generator

\`\`\`bash
#!/bin/bash
# /opt/oracle/scripts/perf/awr_report.sh
# Takes an AWR snapshot, waits N minutes, takes another, generates HTML report.
# Requires: Oracle Diagnostics Pack license.
# Usage: ./awr_report.sh [duration_minutes]

DURATION=\${1:-60}
DB_USER="sys"
DB_PASS="Oracle19c_Strong#Pwd"
DB_SID="ORCLCDB"
CONTAINER="oracle-db"
REPORT_DIR=/var/log/oracle/awr
mkdir -p "\$REPORT_DIR"

run_sql() {
  docker exec "\$CONTAINER" sqlplus -S "\${DB_USER}/\${DB_PASS}@\${DB_SID} as sysdba" <<< "\$1"
}

echo "Taking begin AWR snapshot..."
BEGIN_SNAP=\$(run_sql "SET FEEDBACK OFF HEADING OFF; SELECT dbms_workload_repository.create_snapshot() FROM dual;" | tr -d ' ')
echo "Begin snap_id: \$BEGIN_SNAP"

echo "Waiting \${DURATION} minutes..."
sleep \$(( DURATION * 60 ))

echo "Taking end AWR snapshot..."
END_SNAP=\$(run_sql "SET FEEDBACK OFF HEADING OFF; SELECT dbms_workload_repository.create_snapshot() FROM dual;" | tr -d ' ')
echo "End snap_id: \$END_SNAP"

DBID=\$(run_sql "SET FEEDBACK OFF HEADING OFF; SELECT dbid FROM v\\\$database;" | tr -d ' ')
REPORT_FILE="\$REPORT_DIR/awr_\${DBID}_\${BEGIN_SNAP}_\${END_SNAP}_\$(date +%Y%m%d_%H%M).html"

echo "Generating AWR HTML report → \$REPORT_FILE"
run_sql "
SET PAGESIZE 0 LINESIZE 32767 FEEDBACK OFF TRIMSPOOL ON
SPOOL /tmp/awr_report.html
SELECT output FROM TABLE(
  dbms_workload_repository.awr_report_html(
    l_dbid       => \$DBID,
    l_inst_num   => 1,
    l_bid        => \$BEGIN_SNAP,
    l_eid        => \$END_SNAP
  )
);
SPOOL OFF
" > /dev/null

docker cp "\$CONTAINER":/tmp/awr_report.html "\$REPORT_FILE"
echo "AWR report saved: \$REPORT_FILE"

# Extract top 5 wait events from report
echo ""
echo "--- Top Wait Events (from AWR) ---"
grep -A2 'Top.*Foreground Events' "\$REPORT_FILE" | head -20
\`\`\`

---

### Script 5: Full Performance Dashboard (live, auto-refresh)

\`\`\`bash
#!/bin/bash
# /opt/oracle/scripts/perf/oracle_dashboard.sh
# Unified live dashboard — cgroup + Oracle sessions + I/O + memory.
# Run: ./oracle_dashboard.sh [refresh_seconds]

REFRESH=\${1:-15}
CONTAINER="oracle-db"
DB_USER="sys"
DB_PASS="Oracle19c_Strong#Pwd"
DB_SID="ORCLCDB"

run_sql() {
  docker exec "\$CONTAINER" sqlplus -S "\${DB_USER}/\${DB_PASS}@\${DB_SID} as sysdba" <<< "\$1" 2>/dev/null
}

cgroup_mem_pct() {
  CID=\$(docker inspect --format '{{.Id}}' "\$CONTAINER" 2>/dev/null)
  CUR=\$(cat /sys/fs/cgroup/system.slice/docker-\${CID}.scope/memory.current 2>/dev/null || echo 0)
  MAX=\$(cat /sys/fs/cgroup/system.slice/docker-\${CID}.scope/memory.max      2>/dev/null || echo 0)
  [ "\$MAX" = "max" ] || [ "\$MAX" -eq 0 ] && echo "N/A" && return
  awk "BEGIN {printf \"%.1f%%\", \$CUR/\$MAX*100}"
}

while true; do
  clear
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║       Oracle 19c Docker Dashboard — \$(date '+%H:%M:%S')           ║"
  echo "╠══════════════════════════════════════════════════════════════╣"

  # Docker stats line
  STATS=\$(docker stats --no-stream --format "CPU: {{.CPUPerc}}  MEM: {{.MemUsage}}  BLOCK: {{.BlockIO}}  NET: {{.NetIO}}" "\$CONTAINER" 2>/dev/null)
  echo "  \$STATS"
  echo "  cgroup mem%: \$(cgroup_mem_pct)"
  echo "╠══════════════════════════════════════════════════════════════╣"

  echo "  ACTIVE SESSIONS BY WAIT CLASS"
  run_sql "
SET PAGESIZE 10 LINESIZE 60 FEEDBACK OFF HEADING OFF
SELECT RPAD(wait_class,25) || LPAD(COUNT(*),5) || ' sessions'
FROM   v\\\$session
WHERE  status='ACTIVE' AND type='USER'
GROUP BY wait_class ORDER BY COUNT(*) DESC
FETCH FIRST 8 ROWS ONLY;" | grep -v '^$'

  echo "╠══════════════════════════════════════════════════════════════╣"
  echo "  LONGEST RUNNING SQL (> 5s)"
  run_sql "
SET PAGESIZE 10 LINESIZE 80 FEEDBACK OFF HEADING OFF
SELECT ROUND(s.last_call_et,0) || 's  SID=' || s.sid || '  ' ||
       SUBSTR(q.sql_text,1,45)
FROM   v\\\$session s JOIN v\\\$sql q ON s.sql_id=q.sql_id AND s.sql_child_number=q.child_number
WHERE  s.status='ACTIVE' AND s.type='USER' AND s.last_call_et > 5
ORDER BY s.last_call_et DESC
FETCH FIRST 5 ROWS ONLY;" | grep -v '^$'

  echo "╠══════════════════════════════════════════════════════════════╣"
  echo "  TOP WAIT EVENTS (non-idle)"
  run_sql "
SET PAGESIZE 10 LINESIZE 70 FEEDBACK OFF HEADING OFF
SELECT RPAD(event,35) || LPAD(total_waits,8) || ' waits  ' || LPAD(ROUND(time_waited_micro/1e6,1),7) || 's'
FROM   v\\\$system_event
WHERE  wait_class != 'Idle'
ORDER BY time_waited_micro DESC
FETCH FIRST 8 ROWS ONLY;" | grep -v '^$'

  echo "╠══════════════════════════════════════════════════════════════╣"
  echo "  MEMORY"
  run_sql "
SET PAGESIZE 10 LINESIZE 60 FEEDBACK OFF HEADING OFF
SELECT RPAD(name,35) || ROUND(value/1048576,0) || ' MB'
FROM   v\\\$pgastat
WHERE  name IN ('total PGA allocated','aggregate PGA target parameter')
UNION ALL
SELECT RPAD('SGA Target',35) || ROUND(value/1048576,0) || ' MB'
FROM   v\\\$parameter WHERE name='sga_target';" | grep -v '^$'

  echo "╚══════════════════════════════════════════════════════════════╝"
  echo "  Refreshing every \${REFRESH}s — Ctrl+C to exit"
  sleep "\$REFRESH"
done
\`\`\`

---

## Phase 5 — Diagnostics Quick Reference

### Alert log

\`\`\`bash
# Live tail
docker exec oracle-db tail -f /opt/oracle/diag/rdbms/orclcdb/ORCLCDB/trace/alert_ORCLCDB.log

# Filter ORA- errors only
docker exec oracle-db grep "ORA-" /opt/oracle/diag/rdbms/orclcdb/ORCLCDB/trace/alert_ORCLCDB.log | tail -50
\`\`\`

### Kill a blocking session

\`\`\`sql
-- Find blocking session
SELECT sid, serial#, username, status, seconds_in_wait, event
FROM   v$session
WHERE  blocking_session IS NOT NULL
ORDER BY seconds_in_wait DESC;

-- Kill it
ALTER SYSTEM KILL SESSION 'SID,SERIAL#' IMMEDIATE;
\`\`\`

### Flush shared pool / buffer cache (emergency only)

\`\`\`sql
ALTER SYSTEM FLUSH SHARED_POOL;
ALTER SYSTEM FLUSH BUFFER_CACHE;
\`\`\`

### Resize SGA / PGA without restart (19c dynamic SGA)

\`\`\`sql
-- Requires ALLOW_GROUP_ACCESS_TO_SGA = TRUE in 19.12+
ALTER SYSTEM SET sga_target = 6G;
ALTER SYSTEM SET pga_aggregate_target = 3G;
\`\`\`

### Space usage

\`\`\`bash
# Volume disk usage
docker exec oracle-db du -sh /opt/oracle/oradata/ORCLCDB/

# Tablespace usage inside Oracle
docker exec oracle-db sqlplus -S / as sysdba <<< "
SET LINESIZE 100 PAGESIZE 30 FEEDBACK OFF
SELECT tablespace_name,
       ROUND(used_space*8192/1024/1024/1024,2) used_gb,
       ROUND(tablespace_size*8192/1024/1024/1024,2) total_gb,
       ROUND(used_percent,1) pct_used
FROM   dba_tablespace_usage_metrics
ORDER BY pct_used DESC;
"
\`\`\`

---

## Cron Schedule Summary

\`\`\`
# /etc/cron.d/oracle-docker
# Full RMAN backup — daily 01:00
0 1 * * *  root  /opt/oracle/scripts/rman_full_backup.sh

# Container stats log — every 5 min
*/5 * * * * root /opt/oracle/scripts/perf/container_stats.sh 1 >> /var/log/oracle/perf/cron_stats.log 2>&1

# Hourly AWR snapshot (keeps retention history without a full report)
0 * * * *  root  docker exec oracle-db sqlplus -S / as sysdba <<< "exec dbms_workload_repository.create_snapshot();"

# Weekly AWR report — Sunday 03:00
0 3 * * 0  root  /opt/oracle/scripts/perf/awr_report.sh 60
\`\`\`

---

## Monitoring Script Deployment

\`\`\`bash
mkdir -p /opt/oracle/scripts/perf
chmod +x /opt/oracle/scripts/perf/*.sh
mkdir -p /var/log/oracle/perf /var/log/oracle/awr

# Test container stats script (5 samples, 2s interval)
/opt/oracle/scripts/perf/container_stats.sh 2 &
BGPID=\$!
sleep 12
kill \$BGPID

# Test dashboard
/opt/oracle/scripts/perf/oracle_dashboard.sh 5
\`\`\`
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'Oracle Database 19c Docker on RHEL 9 — Operations Runbook with Performance Monitoring',
    slug,
    excerpt: 'Day-two operations runbook for Oracle 19c in Docker on RHEL 9. Container lifecycle, RMAN backup, patching workflow, and five production-grade performance monitoring scripts: cgroup metrics, session/wait event analysis, I/O profiling, AWR report generation, and a live unified dashboard.',
    content,
    category: 'docker-oracle',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
