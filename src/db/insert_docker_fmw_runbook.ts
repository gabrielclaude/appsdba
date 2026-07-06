import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'oracle-fusion-middleware-14-docker-rhel9-runbook';

const content = `
Day-two operations runbook for Oracle Fusion Middleware 14 (WebLogic 14.1.2) running in Docker on RHEL 9. Covers container lifecycle, log management, JDBC pool administration, and a complete performance monitoring script suite — cgroup resource metrics, WLST thread pool analysis, JVM heap profiling, JDBC connection pool diagnostics, and a live unified dashboard.

---

## Phase 1 — Container Lifecycle

### Start / Stop sequence

Always stop Managed Servers before the AdminServer to allow clean deregistration.

\`\`\`bash
# --- Graceful shutdown ---
# Stop Managed Server first
docker exec fmw-managed1 \
  /u01/oracle/user_projects/domains/fmw_domain/bin/stopManagedWebLogic.sh \
  ManagedServer1 http://fmw-admin:7001 weblogic Welcome1#Weblogic
docker stop fmw-managed1

# Stop AdminServer
docker exec fmw-admin \
  /u01/oracle/user_projects/domains/fmw_domain/bin/stopWebLogic.sh \
  weblogic Welcome1#Weblogic
docker stop fmw-admin

# --- Start (AdminServer first) ---
docker start fmw-admin
# Wait for AdminServer RUNNING state
docker logs -f fmw-admin 2>&1 | grep -m1 "Server started in RUNNING mode"

docker start fmw-managed1
docker logs -f fmw-managed1 2>&1 | grep -m1 "Server started in RUNNING mode"
\`\`\`

### Check server state via REST

\`\`\`bash
# AdminServer state
curl -s -u weblogic:Welcome1#Weblogic \
  http://localhost:7001/management/weblogic/latest/serverRuntime \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('State:', d['state'], '| Health:', d['healthState']['state'])"

# All server states
curl -s -u weblogic:Welcome1#Weblogic \
  http://localhost:7001/management/weblogic/latest/domainRuntime/serverRuntimes \
  | python3 -c "
import sys, json
for s in json.load(sys.stdin)['items']:
    print(f\"{s['name']:30s}  {s['state']:10s}  {s['healthState']['state']}\")"
\`\`\`

### Restart a Managed Server without touching AdminServer

\`\`\`bash
docker exec fmw-admin /u01/oracle/oracle_common/common/bin/wlst.sh -skipADMinCheck << 'EOF'
connect('weblogic', 'Welcome1#Weblogic', 't3://fmw-admin:7001')
shutdown('ManagedServer1', 'Server', ignoreSessions='true', timeOut=60)
start('ManagedServer1', 'Server')
state('ManagedServer1')
disconnect()
exit()
EOF
\`\`\`

---

## Phase 2 — Log Management

### Key log locations inside fmw-domain volume

\`\`\`
/u01/oracle/user_projects/domains/fmw_domain/servers/
├── AdminServer/logs/
│   ├── AdminServer.log          ← main server log
│   ├── AdminServer.out          ← stdout (start/stop messages)
│   ├── access.log               ← HTTP access log
│   └── gc.log                   ← JVM GC log (if configured)
└── ManagedServer1/logs/
    ├── ManagedServer1.log
    ├── ManagedServer1.out
    └── access.log
\`\`\`

\`\`\`bash
# Live tail AdminServer log
docker exec fmw-admin tail -f \
  /u01/oracle/user_projects/domains/fmw_domain/servers/AdminServer/logs/AdminServer.log

# Filter WARN/ERROR only
docker exec fmw-admin grep -E '<Warning>|<Error>|<Critical>|<Emergency>' \
  /u01/oracle/user_projects/domains/fmw_domain/servers/AdminServer/logs/AdminServer.log | tail -50

# Alert log via docker logs (stdout from startWebLogic.sh)
docker logs --since 1h fmw-admin 2>&1 | grep -iE 'stuck|error|exception|ORA-'
\`\`\`

---

## Phase 3 — JDBC Connection Pool Administration

\`\`\`bash
# List all datasources and active connections
docker exec fmw-admin /u01/oracle/oracle_common/common/bin/wlst.sh -skipADMinCheck << 'EOF'
connect('weblogic', 'Welcome1#Weblogic', 't3://fmw-admin:7001')
domainRuntime()
cd('ServerRuntimes/AdminServer/JDBCServiceRuntime/AdminServer/JDBCDataSourceRuntimeMBeans')
dsList = ls(returnMap='true')
for ds in dsList:
    cd(ds)
    print ds, '| Active:', get('ActiveConnectionsCurrentCount'), \
              '| High:', get('ActiveConnectionsHighCount'), \
              '| Wait:', get('WaitingForConnectionCurrentCount'), \
              '| Leaked:', get('LeakedConnectionCount')
    cd('..')
disconnect()
exit()
EOF
\`\`\`

### Reset a leaked/stuck connection pool

\`\`\`bash
docker exec fmw-admin /u01/oracle/oracle_common/common/bin/wlst.sh -skipADMinCheck << 'EOF'
connect('weblogic', 'Welcome1#Weblogic', 't3://fmw-admin:7001')
domainRuntime()
cd('ServerRuntimes/AdminServer/JDBCServiceRuntime/AdminServer/JDBCDataSourceRuntimeMBeans/LocalSvcTblDataSource')
cmo.reset()
print 'Pool reset complete'
disconnect()
exit()
EOF
\`\`\`

---

## Phase 4 — Performance Monitoring Scripts

### Script 1: Container Resource Monitor (cgroup v2 + docker stats)

\`\`\`bash
#!/bin/bash
# /opt/fmw/scripts/perf/container_stats.sh
# Monitors cgroup CPU throttling and memory pressure for all FMW containers.
# Usage: ./container_stats.sh [interval_seconds]

CONTAINERS="fmw-admin fmw-managed1"
INTERVAL=\${1:-10}
LOG=/var/log/fmw/perf/container_stats_$(date +%Y%m%d).log
mkdir -p /var/log/fmw/perf

printf "%-20s %-14s %-8s %-10s %-12s %-12s %-14s\n" \
  "Timestamp" "Container" "CPU%" "Throttle%" "MemUsed_MB" "MemLimit_MB" "BlockIO" \
  | tee -a "$LOG"

while true; do
  TS=$(date '+%Y-%m-%d %H:%M:%S')
  for CONTAINER in $CONTAINERS; do
    RUNNING=$(docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null)
    [ "$RUNNING" != "true" ] && {
      printf "%-20s %-14s %s\n" "$TS" "$CONTAINER" "NOT RUNNING" | tee -a "$LOG"
      continue
    }

    CID=$(docker inspect --format '{{.Id}}' "$CONTAINER")
    SCOPE="system.slice/docker-\${CID}.scope"
    CGROOT=$(findmnt -t cgroup2 -n -o TARGET 2>/dev/null | head -1)

    # CPU throttle from cgroup v2
    THROTTLE_PCT="N/A"
    CPU_STAT="$CGROOT/$SCOPE/cpu.stat"
    if [ -f "$CPU_STAT" ]; then
      THROTTLED=$(grep throttled_usec "$CPU_STAT" | awk '{print $2}')
      USAGE=$(grep 'usage_usec' "$CPU_STAT" | awk '{print $2}')
      [ "$USAGE" -gt 0 ] 2>/dev/null && \
        THROTTLE_PCT=$(awk "BEGIN {printf \"%.1f\", $THROTTLED/($USAGE+$THROTTLED)*100}")
    fi

    # Memory from cgroup v2
    MEM_CURRENT=$(cat "$CGROOT/$SCOPE/memory.current" 2>/dev/null || echo 0)
    MEM_MAX=$(cat "$CGROOT/$SCOPE/memory.max" 2>/dev/null || echo 0)
    MEM_USED_MB=$(awk "BEGIN {printf \"%.0f\", $MEM_CURRENT/1048576}")
    MEM_LIMIT_MB="N/A"
    [ "$MEM_MAX" != "max" ] && [ "$MEM_MAX" -gt 0 ] && \
      MEM_LIMIT_MB=$(awk "BEGIN {printf \"%.0f\", $MEM_MAX/1048576}")

    # docker stats (non-blocking)
    DSTATS=$(docker stats --no-stream --format "{{.CPUPerc}}|{{.BlockIO}}" "$CONTAINER" 2>/dev/null)
    CPU_PCT=$(echo "$DSTATS" | cut -d'|' -f1)
    BLOCK_IO=$(echo "$DSTATS" | cut -d'|' -f2)

    printf "%-20s %-14s %-8s %-10s %-12s %-12s %-14s\n" \
      "$TS" "$CONTAINER" "$CPU_PCT" "$THROTTLE_PCT%" \
      "$MEM_USED_MB" "$MEM_LIMIT_MB" "$BLOCK_IO" | tee -a "$LOG"

    # Alert thresholds
    [[ "$THROTTLE_PCT" != "N/A" ]] && \
      (( $(echo "$THROTTLE_PCT > 25" | bc -l) )) && \
      echo "  ALERT: $CONTAINER CPU throttling \${THROTTLE_PCT}% — increase --cpus" | tee -a "$LOG"

    if [ "$MEM_LIMIT_MB" != "N/A" ] && [ "$MEM_USED_MB" -gt 0 ]; then
      MEM_PCT=$(awk "BEGIN {printf \"%.0f\", $MEM_USED_MB/$MEM_LIMIT_MB*100}")
      [ "$MEM_PCT" -gt 88 ] && \
        echo "  ALERT: $CONTAINER memory at \${MEM_PCT}% of limit" | tee -a "$LOG"
    fi
  done
  echo "---"
  sleep "$INTERVAL"
done
\`\`\`

---

### Script 2: WLST Thread Pool and Stuck Thread Monitor

\`\`\`bash
#!/bin/bash
# /opt/fmw/scripts/perf/wls_thread_monitor.sh
# Polls WebLogic thread pool metrics for all servers every N seconds.
# Captures thread dumps on stuck thread detection.
# Usage: ./wls_thread_monitor.sh [interval_seconds]

INTERVAL=\${1:-30}
WLS_HOST="localhost"
WLS_PORT="7001"
WLS_USER="weblogic"
WLS_PASS="Welcome1#Weblogic"
DOMAIN_NAME="fmw_domain"
LOG=/var/log/fmw/perf/thread_monitor_$(date +%Y%m%d).log
DUMP_DIR=/var/log/fmw/thread_dumps
mkdir -p "$LOG_DIR" "$DUMP_DIR" /var/log/fmw/perf

WLST_SCRIPT=$(mktemp /tmp/wls_thread_XXXXXX.py)
cat > "$WLST_SCRIPT" << 'PYEOF'
import datetime, sys

WLS_HOST = sys.argv[1]
WLS_PORT = sys.argv[2]
WLS_USER = sys.argv[3]
WLS_PASS = sys.argv[4]

try:
    connect(WLS_USER, WLS_PASS, 't3://' + WLS_HOST + ':' + WLS_PORT)
except:
    print('CONNECT_FAILED')
    exit()

domainRuntime()
servers = ls('ServerRuntimes', returnMap='true')
ts = str(datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'))

for srv in servers:
    try:
        cd('ServerRuntimes/' + srv + '/ThreadPoolRuntime/ThreadPoolRuntime')
        total     = get('ExecuteThreadTotalCount')
        idle      = get('IdleThreadsCurrentCount')
        stuck     = get('StuckThreadCount')
        hogging   = get('HoggingThreadCount')
        pending   = get('PendingUserRequestCount')
        throughput= get('Throughput')

        print('THREAD_STATS|' + ts + '|' + srv +
              '|total=' + str(total) +
              '|idle=' + str(idle) +
              '|stuck=' + str(stuck) +
              '|hogging=' + str(hogging) +
              '|pending=' + str(pending) +
              '|throughput=' + str(throughput))

        # Per-thread details when stuck or hogging
        if stuck > 0 or hogging > 0:
            cd('../ExecuteThreadRuntimes')
            threads = ls(returnMap='true')
            for t in threads:
                cd(t)
                state   = get('CurrentOperation')
                elapsed = get('Elapsed')
                name    = get('ExecuteThread')
                if elapsed and int(elapsed) > 60000:
                    print('SLOW_THREAD|' + ts + '|' + srv + '|' + name +
                          '|elapsed_ms=' + str(elapsed) + '|op=' + str(state))
                cd('..')
        cd('/ServerRuntimes/' + srv)
    except Exception as e:
        print('ERROR|' + srv + '|' + str(e))

disconnect()
exit()
PYEOF

echo "FMW Thread Monitor started — interval \${INTERVAL}s" | tee -a "$LOG"
echo "Log: $LOG" | tee -a "$LOG"

while true; do
  OUTPUT=$(docker exec fmw-admin \
    /u01/oracle/oracle_common/common/bin/wlst.sh -skipADMinCheck \
    /dev/stdin <<< "$(cat "$WLST_SCRIPT")" 2>/dev/null)

  if echo "$OUTPUT" | grep -q "CONNECT_FAILED"; then
    echo "$(date) WARN: Cannot connect to AdminServer — is it running?" | tee -a "$LOG"
    sleep "$INTERVAL"
    continue
  fi

  echo "$OUTPUT" | grep "^THREAD_STATS" | while IFS='|' read -r tag ts srv rest; do
    echo "[$ts] $srv — $rest" | tee -a "$LOG"
  done

  # Stuck thread detection → capture thread dump
  STUCK_COUNT=$(echo "$OUTPUT" | grep "^THREAD_STATS" | grep -oP 'stuck=\K[0-9]+' | awk '{s+=$1}END{print s+0}')
  if [ "\${STUCK_COUNT:-0}" -gt 0 ]; then
    echo "$(date) ALERT: $STUCK_COUNT stuck thread(s) detected — capturing thread dumps" | tee -a "$LOG"
    for CONTAINER in fmw-admin fmw-managed1; do
      RUNNING=$(docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null)
      [ "$RUNNING" != "true" ] && continue
      PID=$(docker exec "$CONTAINER" pgrep -f weblogic.Server 2>/dev/null | head -1)
      if [ -n "$PID" ]; then
        DUMPFILE="$DUMP_DIR/\${CONTAINER}_$(date +%Y%m%d_%H%M%S).jstack"
        docker exec "$CONTAINER" jstack "$PID" > "$DUMPFILE" 2>&1
        echo "  Thread dump saved: $DUMPFILE" | tee -a "$LOG"
        # Quick analysis
        echo "  BLOCKED threads: $(grep -c 'BLOCKED' "$DUMPFILE")" | tee -a "$LOG"
        echo "  WAITING threads: $(grep -c 'in Object.wait' "$DUMPFILE")" | tee -a "$LOG"
      fi
    done
  fi

  echo "$OUTPUT" | grep "^SLOW_THREAD" | while IFS='|' read -r tag ts srv tname elapsed op; do
    echo "  [$ts] SLOW $srv / $tname — $elapsed — $op" | tee -a "$LOG"
  done

  sleep "$INTERVAL"
done

rm -f "$WLST_SCRIPT"
\`\`\`

---

### Script 3: JVM Heap and GC Profiler

\`\`\`bash
#!/bin/bash
# /opt/fmw/scripts/perf/jvm_heap_profiler.sh
# Samples JVM heap usage via jstat for AdminServer and ManagedServer1.
# Detects heap pressure and triggers heap dump on critical threshold.
# Usage: ./jvm_heap_profiler.sh [interval_seconds]

INTERVAL=\${1:-30}
HEAP_ALERT_PCT=85
HEAP_DUMP_PCT=92
LOG=/var/log/fmw/perf/jvm_heap_$(date +%Y%m%d).log
DUMP_DIR=/var/log/fmw/heap_dumps
mkdir -p /var/log/fmw/perf "$DUMP_DIR"

printf "%-20s %-14s %-8s %-8s %-8s %-8s %-8s %-8s %-10s\n" \
  "Timestamp" "Container" "S0%" "S1%" "E%" "O%" "M%" "GC_cnt" "GC_time_s" \
  | tee -a "$LOG"

while true; do
  TS=$(date '+%Y-%m-%d %H:%M:%S')
  for CONTAINER in fmw-admin fmw-managed1; do
    RUNNING=$(docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null)
    [ "$RUNNING" != "true" ] && continue

    PID=$(docker exec "$CONTAINER" pgrep -f weblogic.Server 2>/dev/null | head -1)
    [ -z "$PID" ] && continue

    # jstat -gcutil: S0% S1% E% O% M% CCS% YGC YGCT FGC FGCT GCT
    JSTAT=$(docker exec "$CONTAINER" jstat -gcutil "$PID" 2>/dev/null | tail -1)
    [ -z "$JSTAT" ] && continue

    S0=$(echo "$JSTAT" | awk '{print $1}')
    S1=$(echo "$JSTAT" | awk '{print $2}')
    E=$(echo  "$JSTAT" | awk '{print $3}')
    O=$(echo  "$JSTAT" | awk '{print $4}')
    M=$(echo  "$JSTAT" | awk '{print $5}')
    YGC=$(echo "$JSTAT" | awk '{print $7}')
    YGCT=$(echo "$JSTAT" | awk '{print $8}')
    FGC=$(echo "$JSTAT" | awk '{print $9}')
    GCT=$(echo "$JSTAT" | awk '{print $11}')
    TOTAL_GC=$(echo "$YGC $FGC" | awk '{print $1+$2}')

    printf "%-20s %-14s %-8s %-8s %-8s %-8s %-8s %-8s %-10s\n" \
      "$TS" "$CONTAINER" "$S0" "$S1" "$E" "$O" "$M" "$TOTAL_GC" "$GCT" \
      | tee -a "$LOG"

    # Old gen pressure alert
    O_INT=$(echo "$O" | cut -d. -f1)
    if [ "\${O_INT:-0}" -ge "$HEAP_DUMP_PCT" ]; then
      DUMPFILE="$DUMP_DIR/\${CONTAINER}_heapdump_$(date +%Y%m%d_%H%M%S).hprof"
      echo "  CRITICAL: $CONTAINER Old Gen at \${O}% — capturing heap dump → $DUMPFILE" | tee -a "$LOG"
      docker exec "$CONTAINER" jmap -dump:format=b,file=/tmp/heapdump.hprof "$PID" 2>/dev/null
      docker cp "$CONTAINER":/tmp/heapdump.hprof "$DUMPFILE" 2>/dev/null
      docker exec "$CONTAINER" rm -f /tmp/heapdump.hprof 2>/dev/null
    elif [ "\${O_INT:-0}" -ge "$HEAP_ALERT_PCT" ]; then
      echo "  WARN: $CONTAINER Old Gen at \${O}% — approaching heap limit" | tee -a "$LOG"
    fi

    # Full GC frequency alert (> 1 per 10 min is concerning for FMW)
    if [ "\${FGC:-0}" -gt 0 ]; then
      echo "  INFO: $CONTAINER Full GC count=$FGC total_time=\${FGCT}s" | tee -a "$LOG"
    fi
  done
  sleep "$INTERVAL"
done
\`\`\`

---

### Script 4: JDBC Connection Pool Diagnostics

\`\`\`bash
#!/bin/bash
# /opt/fmw/scripts/perf/jdbc_pool_monitor.sh
# Polls all JDBC datasource pools via WLST. Alerts on pool exhaustion and leaks.
# Usage: ./jdbc_pool_monitor.sh [interval_seconds]

INTERVAL=\${1:-60}
LOG=/var/log/fmw/perf/jdbc_pool_$(date +%Y%m%d).log
WAIT_ALERT=5       # alert if >5 requests waiting for connection
LEAK_ALERT=3       # alert if >3 leaked connections
mkdir -p /var/log/fmw/perf

WLST_SCRIPT=$(mktemp /tmp/jdbc_mon_XXXXXX.py)
cat > "$WLST_SCRIPT" << 'PYEOF'
import sys, datetime
connect('weblogic', 'Welcome1#Weblogic', 't3://fmw-admin:7001')
domainRuntime()
ts = str(datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'))
servers = ls('ServerRuntimes', returnMap='true')
for srv in servers:
    try:
        path = 'ServerRuntimes/' + srv + '/JDBCServiceRuntime/' + srv + '/JDBCDataSourceRuntimeMBeans'
        cd(path)
        dsList = ls(returnMap='true')
        for ds in dsList:
            cd(ds)
            print('JDBC|' + ts + '|' + srv + '|' + ds +
                  '|active='    + str(get('ActiveConnectionsCurrentCount')) +
                  '|high='      + str(get('ActiveConnectionsHighCount')) +
                  '|waiting='   + str(get('WaitingForConnectionCurrentCount')) +
                  '|leaked='    + str(get('LeakedConnectionCount')) +
                  '|created='   + str(get('ConnectionsTotalCount')) +
                  '|failed='    + str(get('FailedReservationCount')) +
                  '|capacity='  + str(get('CurrCapacity')))
            cd('..')
        cd('/')
    except Exception as e:
        print('JDBC_ERR|' + srv + '|' + str(e))
disconnect()
exit()
PYEOF

echo "JDBC Pool Monitor — interval \${INTERVAL}s — $(date)" | tee -a "$LOG"

while true; do
  OUTPUT=$(docker exec fmw-admin \
    /u01/oracle/oracle_common/common/bin/wlst.sh -skipADMinCheck \
    /dev/stdin <<< "$(cat "$WLST_SCRIPT")" 2>/dev/null)

  echo "$OUTPUT" | grep "^JDBC|" | while IFS='|' read -r tag ts srv ds rest; do
    echo "[$ts] $srv / $ds — $rest" | tee -a "$LOG"

    WAITING=$(echo "$rest" | grep -oP 'waiting=\K[0-9]+')
    LEAKED=$(echo "$rest"  | grep -oP 'leaked=\K[0-9]+')
    FAILED=$(echo "$rest"  | grep -oP 'failed=\K[0-9]+')

    [ "\${WAITING:-0}" -ge "$WAIT_ALERT" ] && \
      echo "  ALERT: $ds pool exhaustion — \${WAITING} requests waiting" | tee -a "$LOG"
    [ "\${LEAKED:-0}" -ge "$LEAK_ALERT" ] && \
      echo "  ALERT: $ds connection leak — \${LEAKED} leaked connections" | tee -a "$LOG"
    [ "\${FAILED:-0}" -gt 0 ] && \
      echo "  WARN:  $ds \${FAILED} failed connection reservations" | tee -a "$LOG"
  done

  sleep "$INTERVAL"
done

rm -f "$WLST_SCRIPT"
\`\`\`

---

### Script 5: Live FMW Performance Dashboard

\`\`\`bash
#!/bin/bash
# /opt/fmw/scripts/perf/fmw_dashboard.sh
# Unified live dashboard: cgroup resources + WLS thread pools + JVM heap + JDBC pools.
# Usage: ./fmw_dashboard.sh [refresh_seconds]

REFRESH=\${1:-20}
CONTAINERS="fmw-admin fmw-managed1"
WLS_URL="t3://fmw-admin:7001"
WLS_USER="weblogic"
WLS_PASS="Welcome1#Weblogic"

wls_snapshot() {
  docker exec fmw-admin \
    /u01/oracle/oracle_common/common/bin/wlst.sh -skipADMinCheck /dev/stdin 2>/dev/null <<< "
import sys
try:
    connect('$WLS_USER', '$WLS_PASS', '$WLS_URL')
    domainRuntime()
    servers = ls('ServerRuntimes', returnMap='true')
    for srv in servers:
        try:
            cd('ServerRuntimes/' + srv + '/ThreadPoolRuntime/ThreadPoolRuntime')
            print('TP|' + srv + '|idle=' + str(get('IdleThreadsCurrentCount')) +
                  '|stuck=' + str(get('StuckThreadCount')) +
                  '|hogging=' + str(get('HoggingThreadCount')) +
                  '|pending=' + str(get('PendingUserRequestCount')) +
                  '|throughput=' + str(get('Throughput')))
            cd('/')
        except:
            pass
    for srv in servers:
        try:
            jpath = 'ServerRuntimes/' + srv + '/JDBCServiceRuntime/' + srv + '/JDBCDataSourceRuntimeMBeans'
            cd(jpath)
            for ds in ls(returnMap='true'):
                cd(ds)
                print('DS|' + srv + '|' + ds +
                      '|active=' + str(get('ActiveConnectionsCurrentCount')) +
                      '|wait='   + str(get('WaitingForConnectionCurrentCount')) +
                      '|cap='    + str(get('CurrCapacity')))
                cd('..')
            cd('/')
        except:
            pass
    disconnect()
except Exception as e:
    print('ERR|' + str(e))
exit()
"
}

while true; do
  clear
  echo "╔════════════════════════════════════════════════════════════════╗"
  echo "║        Oracle FMW 14 Docker Dashboard — $(date '+%H:%M:%S')           ║"
  echo "╠════════════════════════════════════════════════════════════════╣"

  for CONTAINER in $CONTAINERS; do
    RUNNING=$(docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null)
    if [ "$RUNNING" != "true" ]; then
      echo "  $CONTAINER: NOT RUNNING"
      continue
    fi

    DSTATS=$(docker stats --no-stream --format \
      "CPU:{{.CPUPerc}} MEM:{{.MemUsage}} BLK:{{.BlockIO}}" "$CONTAINER" 2>/dev/null)

    CID=$(docker inspect --format '{{.Id}}' "$CONTAINER")
    CGROOT=$(findmnt -t cgroup2 -n -o TARGET 2>/dev/null | head -1)
    SCOPE="system.slice/docker-\${CID}.scope"
    MEM_CUR=$(cat "$CGROOT/$SCOPE/memory.current" 2>/dev/null || echo 0)
    MEM_MAX=$(cat "$CGROOT/$SCOPE/memory.max"     2>/dev/null || echo 0)
    MEM_PCT="N/A"
    [ "$MEM_MAX" != "max" ] && [ "$MEM_MAX" -gt 0 ] && \
      MEM_PCT=$(awk "BEGIN {printf \"%.0f%%\", $MEM_CUR/$MEM_MAX*100}")

    PID=$(docker exec "$CONTAINER" pgrep -f weblogic.Server 2>/dev/null | head -1)
    HEAP_INFO=""
    if [ -n "$PID" ]; then
      JSTAT=$(docker exec "$CONTAINER" jstat -gcutil "$PID" 2>/dev/null | tail -1)
      O=$(echo "$JSTAT" | awk '{print $4}')
      HEAP_INFO="OldGen:\${O}%"
    fi

    echo "  $CONTAINER: $DSTATS  cgroup:$MEM_PCT  $HEAP_INFO"
  done

  echo "╠════════════════════════════════════════════════════════════════╣"
  echo "  WLS THREAD POOLS"

  SNAPSHOT=$(wls_snapshot)
  echo "$SNAPSHOT" | grep "^TP|" | while IFS='|' read -r tag srv rest; do
    IDLE=$(echo "$rest"     | grep -oP 'idle=\K[0-9]+')
    STUCK=$(echo "$rest"    | grep -oP 'stuck=\K[0-9]+')
    HOGGING=$(echo "$rest"  | grep -oP 'hogging=\K[0-9]+')
    PENDING=$(echo "$rest"  | grep -oP 'pending=\K[0-9]+')
    TPS=$(echo "$rest"      | grep -oP 'throughput=\K[0-9.]+')
    STATUS=""
    [ "\${STUCK:-0}" -gt 0 ]   && STATUS=" *** STUCK:$STUCK ***"
    [ "\${HOGGING:-0}" -gt 0 ] && STATUS="$STATUS HOG:$HOGGING"
    printf "  %-20s idle=%-4s stuck=%-3s hogg=%-3s pend=%-4s tps=%-8s%s\n" \
      "$srv" "$IDLE" "$STUCK" "$HOGGING" "$PENDING" "$TPS" "$STATUS"
  done

  echo "╠════════════════════════════════════════════════════════════════╣"
  echo "  JDBC CONNECTION POOLS"

  echo "$SNAPSHOT" | grep "^DS|" | while IFS='|' read -r tag srv ds rest; do
    ACTIVE=$(echo "$rest" | grep -oP 'active=\K[0-9]+')
    WAIT=$(echo "$rest"   | grep -oP 'wait=\K[0-9]+')
    CAP=$(echo "$rest"    | grep -oP 'cap=\K[0-9]+')
    STATUS=""
    [ "\${WAIT:-0}" -gt 3 ] && STATUS=" *** POOL WAIT:$WAIT ***"
    printf "  %-20s %-30s active=%-4s wait=%-3s cap=%-4s%s\n" \
      "$srv" "$ds" "$ACTIVE" "$WAIT" "$CAP" "$STATUS"
  done

  [ -n "$(echo "$SNAPSHOT" | grep "^ERR|")" ] && {
    echo "  WLS UNREACHABLE — AdminServer may be starting..."
  }

  echo "╚════════════════════════════════════════════════════════════════╝"
  echo "  Refreshing every \${REFRESH}s — Ctrl+C to exit"
  sleep "$REFRESH"
done
\`\`\`

---

## Phase 5 — Diagnostics Quick Reference

### Force thread dump from all FMW containers

\`\`\`bash
for CONTAINER in fmw-admin fmw-managed1; do
  PID=$(docker exec "$CONTAINER" pgrep -f weblogic.Server 2>/dev/null | head -1)
  [ -z "$PID" ] && continue
  OUTFILE="/var/log/fmw/thread_dumps/\${CONTAINER}_$(date +%Y%m%d_%H%M%S).jstack"
  docker exec "$CONTAINER" jstack "$PID" > "$OUTFILE"
  echo "Saved: $OUTFILE"
  echo "BLOCKED: $(grep -c BLOCKED "$OUTFILE")"
  echo "WAITING: $(grep -c 'Object.wait' "$OUTFILE")"
done
\`\`\`

### MDS / OPSS schema health

\`\`\`sql
-- Run in Oracle DB against PDB
SELECT comp_name, status, version FROM dba_registry ORDER BY comp_name;
SELECT schema_name, status FROM dba_registry_schemas
WHERE schema_name LIKE 'FMW14%' ORDER BY schema_name;
\`\`\`

### WebLogic console access

\`\`\`
http://localhost:7001/console
EM Fusion Middleware Control: http://localhost:7001/em
\`\`\`

### GC log analysis (parse gc.log)

\`\`\`bash
docker exec fmw-admin grep -E 'Pause Full|GC\(' \
  /u01/oracle/user_projects/domains/fmw_domain/servers/AdminServer/logs/gc.log \
  | tail -20
\`\`\`

---

## Monitoring Script Deployment

\`\`\`bash
mkdir -p /opt/fmw/scripts/perf
cp container_stats.sh wls_thread_monitor.sh jvm_heap_profiler.sh \
   jdbc_pool_monitor.sh fmw_dashboard.sh /opt/fmw/scripts/perf/
chmod +x /opt/fmw/scripts/perf/*.sh
mkdir -p /var/log/fmw/perf /var/log/fmw/thread_dumps /var/log/fmw/heap_dumps
\`\`\`

\`\`\`
# /etc/cron.d/fmw-monitor
# Container stats — every 5 min
*/5 * * * * root /opt/fmw/scripts/perf/container_stats.sh 1 >> /var/log/fmw/perf/cron_stats.log 2>&1

# Thread monitor — every 2 min (run as one-shot probe, not daemon)
*/2 * * * * root /opt/fmw/scripts/perf/wls_thread_monitor.sh 0 >> /var/log/fmw/perf/threads.log 2>&1

# JVM heap snapshot — every 5 min
*/5 * * * * root /opt/fmw/scripts/perf/jvm_heap_profiler.sh 0 >> /var/log/fmw/perf/heap.log 2>&1

# JDBC pool check — every minute
* * * * *   root /opt/fmw/scripts/perf/jdbc_pool_monitor.sh 0 >> /var/log/fmw/perf/jdbc.log 2>&1
\`\`\`
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'Oracle Fusion Middleware 14 Docker on RHEL 9 — Operations Runbook with Performance Monitoring',
    slug,
    excerpt: 'Day-two operations runbook for Oracle FMW 14 (WebLogic 14.1.2) in Docker on RHEL 9. Container lifecycle, log management, JDBC pool administration, and five performance monitoring scripts: cgroup resource monitor, WLST thread pool and stuck thread analysis, JVM heap profiler with automatic heap dumps, JDBC connection pool diagnostics, and a live unified dashboard.',
    content,
    category: 'docker-oracle',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
