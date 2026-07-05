import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'OTM 6.4 Installation Runbook: WebLogic Domain Setup with Stuck and Hogging Thread Monitoring',
  slug: 'oracle-transportation-management-installation-runbook',
  excerpt:
    'Step-by-step installation runbook for Oracle Transportation Management 6.4 on Oracle Linux 8 with WebLogic 14c — including a WLST-based thread monitoring script that detects stuck threads, hogging threads, and blocked JVM stacks for OTM performance analysis.',
  category: 'otm' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-05'),
  youtubeUrl: null,
  content: `## OTM 6.4 Installation Runbook

**Platform:** Oracle Linux 8.9 | WebLogic 14.1.1 | Oracle DB 19c | OTM 6.4.3

---

## Pre-Installation Checklist

| Item | Required Value | Check |
|------|---------------|-------|
| RAM | 32 GB minimum (64 GB recommended) | \`free -h\` |
| CPU | 8+ cores | \`nproc\` |
| /u01 disk | 100 GB minimum | \`df -h /u01\` |
| /data disk | 200 GB minimum | \`df -h /data\` |
| OS | Oracle Linux 8.x or RHEL 8.x | \`cat /etc/os-release\` |
| DB reachable | Port 1521 open from app server | \`nc -zv DB_HOST 1521\` |
| Ports free | 7001, 7401, 7501, 10021 | \`ss -tlnp\` |
| SELinux | Permissive or enforcing with policy | \`getenforce\` |
| firewalld | Ports open or service disabled | \`firewall-cmd --list-ports\` |

---

## Phase 1: System Preparation

\`\`\`bash
#!/bin/bash
# phase1_system_prep.sh — run as root

set -euo pipefail
LOG=/var/log/otm_install/phase1.log
mkdir -p /var/log/otm_install
exec > >(tee -a \${LOG}) 2>&1

echo "=== Phase 1: System Preparation ==="
echo "Started: \$(date)"

# 1.1 Required packages
dnf install -y gcc gcc-c++ make binutils glibc glibc-devel libaio libaio-devel \
  libgcc libstdc++ libstdc++-devel ksh sysstat compat-openssl11 unzip tar nc

# 1.2 Kernel parameters
cat > /etc/sysctl.d/99-otm.conf << 'SYSCTL'
fs.file-max = 6815744
kernel.sem = 250 32000 100 128
kernel.shmmni = 4096
kernel.shmall = 1073741824
kernel.shmmax = 4398046511104
net.core.rmem_default = 262144
net.core.rmem_max = 4194304
net.core.wmem_default = 262144
net.core.wmem_max = 1048576
fs.aio-max-nr = 1048576
net.ipv4.ip_local_port_range = 9000 65500
vm.swappiness = 10
SYSCTL
sysctl -p /etc/sysctl.d/99-otm.conf

# 1.3 Disable THP
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag
cat >> /etc/rc.local << 'THP'
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag
THP
chmod +x /etc/rc.local

# 1.4 OS user and limits
groupadd -g 54321 oinstall 2>/dev/null || true
groupadd -g 54322 dba 2>/dev/null || true
useradd -u 54321 -g oinstall -G dba -m -s /bin/bash oracle 2>/dev/null || true

cat > /etc/security/limits.d/99-otm.conf << 'LIMITS'
oracle   soft   nofile    131072
oracle   hard   nofile    131072
oracle   soft   nproc     131072
oracle   hard   nproc     131072
oracle   soft   memlock   134217728
oracle   hard   memlock   134217728
oracle   soft   stack     10240
oracle   hard   stack     32768
LIMITS

# 1.5 Directory layout
mkdir -p /u01/app/oracle/product/jdk17
mkdir -p /u01/app/oracle/product/wls14
mkdir -p /u01/app/oracle/product/otm64
mkdir -p /u01/app/oracle/domains/otm_domain
mkdir -p /u01/app/oracle/logs
mkdir -p /data/otm/filestore/{inbound,outbound,error,ftp,archive}
chown -R oracle:oinstall /u01/app/oracle /data/otm

# 1.6 Open required firewall ports
firewall-cmd --permanent --add-port=7001/tcp   # AdminServer HTTP
firewall-cmd --permanent --add-port=7401/tcp   # OTM app HTTP
firewall-cmd --permanent --add-port=7501/tcp   # Integration GW
firewall-cmd --permanent --add-port=10021/tcp  # FTP control
firewall-cmd --permanent --add-port=10100-10200/tcp  # FTP passive
firewall-cmd --reload

echo "Phase 1 complete: \$(date)"
\`\`\`

---

## Phase 2: Database Preparation

Run against the Oracle DB 19c target database as SYSDBA.

\`\`\`sql
-- phase2_db_prep.sql

-- 2.1 Verify DB compatibility
SELECT name, db_unique_name, open_mode, log_mode FROM v\$database;
-- open_mode must be READ WRITE; log_mode must be ARCHIVELOG

-- 2.2 Create tablespaces
CREATE TABLESPACE glog_data
  DATAFILE '/data/oradata/OTMPRD/glog_data01.dbf' SIZE 10G
  AUTOEXTEND ON NEXT 1G MAXSIZE 200G
  EXTENT MANAGEMENT LOCAL UNIFORM SIZE 1M
  SEGMENT SPACE MANAGEMENT AUTO;

CREATE TABLESPACE glog_index
  DATAFILE '/data/oradata/OTMPRD/glog_index01.dbf' SIZE 5G
  AUTOEXTEND ON NEXT 512M MAXSIZE 100G
  EXTENT MANAGEMENT LOCAL UNIFORM SIZE 1M
  SEGMENT SPACE MANAGEMENT AUTO;

-- 2.3 Create GLOGOWNER user
CREATE USER glogowner
  IDENTIFIED BY "SecurePassword1"
  DEFAULT TABLESPACE glog_data
  TEMPORARY TABLESPACE temp
  QUOTA UNLIMITED ON glog_data
  QUOTA UNLIMITED ON glog_index;

GRANT CONNECT, RESOURCE, DBA TO glogowner;
GRANT SELECT ANY DICTIONARY TO glogowner;
GRANT CREATE ANY DIRECTORY TO glogowner;
GRANT EXECUTE ON dbms_lock TO glogowner;
GRANT EXECUTE ON dbms_pipe TO glogowner;
GRANT EXECUTE ON dbms_job TO glogowner;
GRANT EXECUTE ON dbms_scheduler TO glogowner;

-- 2.4 Tuning parameters
ALTER SYSTEM SET cursor_sharing = EXACT SCOPE=BOTH;
ALTER SYSTEM SET open_cursors = 2000 SCOPE=BOTH;
ALTER SYSTEM SET session_cached_cursors = 100 SCOPE=BOTH;
ALTER SYSTEM SET db_file_multiblock_read_count = 128 SCOPE=BOTH;
ALTER SYSTEM SET parallel_max_servers = 32 SCOPE=BOTH;

-- 2.5 Verify (checkpoint before installation)
SELECT username, account_status, default_tablespace
FROM dba_users WHERE username = 'GLOGOWNER';
-- Must be: OPEN, GLOG_DATA
\`\`\`

---

## Phase 3: JDK and WebLogic Installation

\`\`\`bash
#!/bin/bash
# phase3_wls_install.sh — run as oracle

set -euo pipefail
source ~/.bash_profile
LOG=/u01/app/oracle/logs/phase3_wls.log
exec > >(tee -a \${LOG}) 2>&1
echo "Phase 3 started: \$(date)"

# 3.1 Install JDK 17
tar xzf /tmp/jdk-17_linux-x64_bin.tar.gz \
  -C /u01/app/oracle/product/jdk17 --strip-components=1
\${JAVA_HOME}/bin/java -version
echo "JDK OK"

# 3.2 Create WLS silent response file
cat > /tmp/wls_install.rsp << 'RSP'
[ENGINE]
Response File Version=1.0.0.0.0
[GENERIC]
ORACLE_HOME=/u01/app/oracle/product/wls14
INSTALL_TYPE=FMW Infrastructure
RSP

# 3.3 Install WebLogic FMW Infrastructure
\${JAVA_HOME}/bin/java -jar /tmp/fmw_14.1.1.0.0_infrastructure.jar \
  -silent -responseFile /tmp/wls_install.rsp \
  -invPtrLoc /tmp/oraInst.loc

ls \${WL_HOME}/server/lib/weblogic.jar && echo "WebLogic jar OK"
ls \${MW_HOME}/oracle_common/bin/rcu && echo "RCU OK"
echo "Phase 3 complete: \$(date)"
\`\`\`

---

## Phase 4: RCU Schema Creation

\`\`\`bash
#!/bin/bash
# phase4_rcu.sh — run as oracle

source ~/.bash_profile

# Create password file (SYS first, then schema password for each component)
cat > /tmp/rcu_passwords.txt << 'PWDS'
SysPassword1
DevSchema1
DevSchema1
DevSchema1
DevSchema1
DevSchema1
DevSchema1
PWDS
chmod 600 /tmp/rcu_passwords.txt

# Run RCU
\${MW_HOME}/oracle_common/bin/rcu \
  -silent -createRepository \
  -connectString DB_HOST:1521/OTMPRD \
  -dbUser SYS -dbRole SYSDBA \
  -schemaPrefix DEV \
  -component STB \
  -component OPSS \
  -component MDS \
  -component IAU \
  -component IAU_APPEND \
  -component IAU_VIEWER \
  -f < /tmp/rcu_passwords.txt

rm -f /tmp/rcu_passwords.txt
echo "RCU complete: \$(date)"

# Verify schemas were created
sqlplus -S SYS/SysPassword1@DB_HOST:1521/OTMPRD as sysdba << 'EOF'
SELECT username, account_status FROM dba_users
WHERE username LIKE 'DEV%' ORDER BY username;
EXIT;
EOF
\`\`\`

---

## Phase 5: Domain Creation and OTM Deployment

\`\`\`bash
#!/bin/bash
# phase5_domain_otm.sh — run as oracle

source ~/.bash_profile

# 5.1 Create base domain
\${MW_HOME}/oracle_common/common/bin/wlst.sh << 'WLST'
readTemplate('/u01/app/oracle/product/wls14/oracle_common/common/templates/wls/oracle.wls_template.jar')
cd('Servers/AdminServer')
set('ListenPort', 7001)
cd('/')
set('DomainVersion', '14.1.1.0.0')
setOption('DomainName', 'otm_domain')
setOption('JavaHome', '/u01/app/oracle/product/jdk17')
cd('Security/otm_domain/User/weblogic')
cmo.setPassword('WlsAdmin1')
writeDomain('/u01/app/oracle/domains/otm_domain')
closeTemplate()
exit()
WLST

# 5.2 Install OTM application
cd /tmp/otm_installer
\${JAVA_HOME}/bin/java -jar otm_installer.jar \
  -silent -responseFile /tmp/otm_install.rsp

echo "OTM installation complete: \$(date)"

# 5.3 Set JVM options
cat > \${DOMAIN_HOME}/bin/setUserOverrides.sh << 'JVMOPT'
#!/bin/bash
if [ "\${SERVER_NAME}" = "otm_server1" ]; then
  JAVA_OPTIONS="\${JAVA_OPTIONS} -Xms8g -Xmx16g"
  JAVA_OPTIONS="\${JAVA_OPTIONS} -XX:+UseG1GC -XX:MaxGCPauseMillis=500"
  JAVA_OPTIONS="\${JAVA_OPTIONS} -XX:G1HeapRegionSize=32m"
  JAVA_OPTIONS="\${JAVA_OPTIONS} -XX:+ParallelRefProcEnabled"
  JAVA_OPTIONS="\${JAVA_OPTIONS} -XX:+DisableExplicitGC"
  JAVA_OPTIONS="\${JAVA_OPTIONS} -Djava.security.egd=file:/dev/./urandom"
  JAVA_OPTIONS="\${JAVA_OPTIONS} -Doracle.jdbc.fanEnabled=false"
  export JAVA_OPTIONS
fi
if [ "\${SERVER_NAME}" = "intg_server1" ]; then
  JAVA_OPTIONS="\${JAVA_OPTIONS} -Xms2g -Xmx4g -XX:+UseG1GC"
  export JAVA_OPTIONS
fi
JVMOPT
chmod +x \${DOMAIN_HOME}/bin/setUserOverrides.sh
\`\`\`

---

## Phase 6: Start and Validate

\`\`\`bash
#!/bin/bash
# phase6_start_validate.sh — run as oracle

source ~/.bash_profile

# Start AdminServer
nohup \${DOMAIN_HOME}/bin/startWebLogic.sh \
  > \${DOMAIN_HOME}/servers/AdminServer/logs/AdminServer.log 2>&1 &
echo \$! > /u01/app/oracle/logs/admin.pid

# Wait for AdminServer RUNNING
echo "Waiting for AdminServer..."
for i in \$(seq 1 60); do
  if grep -q "Server started in RUNNING mode" \
    \${DOMAIN_HOME}/servers/AdminServer/logs/AdminServer.log 2>/dev/null; then
    echo "AdminServer: RUNNING"
    break
  fi
  sleep 5
done

# Start OTM managed server
nohup \${DOMAIN_HOME}/bin/startManagedWebLogic.sh otm_server1 \
  t3://localhost:7001 \
  > /u01/app/oracle/logs/otm_server1.log 2>&1 &

# Start Integration Gateway
nohup \${DOMAIN_HOME}/bin/startManagedWebLogic.sh intg_server1 \
  t3://localhost:7001 \
  > /u01/app/oracle/logs/intg_server1.log 2>&1 &

# Validate all servers running
sleep 90
\${MW_HOME}/oracle_common/common/bin/wlst.sh << 'WLST'
connect('weblogic', 'WlsAdmin1', 't3://localhost:7001')
domainRuntime()
cd('ServerRuntimes')
for s in ls():
    cd(s)
    print(s + ' -> ' + get('State'))
    cd('..')
disconnect()
exit()
WLST
\`\`\`

---

## Monitoring: Stuck and Hogging Thread Analysis

Stuck threads (active > 600s) and hogging threads (active > 10 minutes) in the WebLogic execute thread pool are the primary indicator of OTM performance problems — almost always caused by slow database queries in the GLOGOWNER schema, lock contention on freight orders, or long-running route optimization calculations.

### Script 1: WLST Thread Pool Monitor

Save as \`/u01/app/oracle/scripts/check_threads.py\` and run via WLST.

\`\`\`python
#!/usr/bin/env python3
# check_threads.py — WLST thread pool monitor for OTM WebLogic servers
# Usage: wlst.sh check_threads.py <wls_password> <server_name> [threshold_seconds]

import sys
import datetime

WLS_USER     = 'weblogic'
WLS_PASSWORD = sys.argv[1] if len(sys.argv) > 1 else 'WlsAdmin1'
SERVER_NAME  = sys.argv[2] if len(sys.argv) > 2 else 'otm_server1'
HOGG_THRESH  = int(sys.argv[3]) if len(sys.argv) > 3 else 300  # 5 min default

SEPARATOR = '=' * 60

def check_thread_pool(server):
    print(SEPARATOR)
    print('OTM WebLogic Thread Analysis')
    print('Server:    ' + server)
    print('Timestamp: ' + str(datetime.datetime.now()))
    print(SEPARATOR)

    try:
        domainRuntime()
        cd('ServerRuntimes/' + server + '/ThreadPoolRuntime/ThreadPoolRuntime')

        stuck_count    = get('StuckThreadCount')
        hogg_count     = get('HoggingThreadCount')
        idle_count     = get('IdleThreadsCurrentCount')
        pending_count  = get('PendingUserRequestCount')
        throughput     = get('Throughput')
        completed      = get('CompletedRequestCount')

        print('')
        print('Thread Pool Summary:')
        print('  Stuck Threads:    ' + str(stuck_count))
        print('  Hogging Threads:  ' + str(hogg_count))
        print('  Idle Threads:     ' + str(idle_count))
        print('  Pending Requests: ' + str(pending_count))
        print('  Throughput req/s: ' + str(round(throughput, 2)))
        print('  Completed Total:  ' + str(completed))

        # Alert conditions
        if stuck_count > 0:
            print('')
            print('!!! ALERT: ' + str(stuck_count) + ' STUCK THREAD(S) DETECTED !!!')
        if hogg_count > 0:
            print('')
            print('WARNING: ' + str(hogg_count) + ' hogging thread(s) detected')
        if pending_count > 50:
            print('')
            print('WARNING: High pending request queue (' + str(pending_count) + ')')

        # Individual thread details
        cd('../../ExecuteThreadRuntimes')
        print('')
        print('Individual Thread Analysis (non-idle only):')
        print('-' * 60)

        threads = ls(returnMap='true')
        stuck_threads   = []
        hogging_threads = []
        active_threads  = []

        for thread_name in threads:
            try:
                cd(thread_name)
                is_stuck   = get('Stuck')
                is_idle    = get('Idle')
                state      = get('ExecuteState')

                if is_idle:
                    cd('..')
                    continue

                # Get runtime duration in ms if available
                try:
                    start_time_ms = get('CurrentRequestStartTime')
                    if start_time_ms and start_time_ms > 0:
                        elapsed_s = (java.lang.System.currentTimeMillis() - start_time_ms) / 1000.0
                    else:
                        elapsed_s = 0
                except:
                    elapsed_s = 0

                stack = None
                try:
                    stack = get('StackTrace')
                except:
                    pass

                thread_info = {
                    'name':     thread_name,
                    'state':    state,
                    'stuck':    is_stuck,
                    'elapsed':  elapsed_s,
                    'stack':    stack,
                }

                if is_stuck:
                    stuck_threads.append(thread_info)
                elif elapsed_s > HOGG_THRESH:
                    hogging_threads.append(thread_info)
                else:
                    active_threads.append(thread_info)

                cd('..')
            except:
                try:
                    cd('..')
                except:
                    pass
                continue

        # Print stuck threads first
        if stuck_threads:
            print('')
            print('>>> STUCK THREADS (' + str(len(stuck_threads)) + ') <<<')
            for t in stuck_threads:
                print('Thread: ' + t['name'])
                print('  State:   ' + str(t['state']))
                print('  Elapsed: ' + str(round(t['elapsed'], 0)) + 's')
                if t['stack']:
                    print('  Stack (top 12 frames):')
                    lines = str(t['stack']).split('\\n')[:12]
                    for line in lines:
                        if line.strip():
                            print('    ' + line.strip())
                print('')

        # Print hogging threads
        if hogging_threads:
            print('>>> HOGGING THREADS (' + str(len(hogging_threads)) + ') [>' + str(HOGG_THRESH) + 's] <<<')
            for t in hogging_threads:
                print('Thread: ' + t['name'])
                print('  State:   ' + str(t['state']))
                print('  Elapsed: ' + str(round(t['elapsed'], 0)) + 's')
                if t['stack']:
                    lines = str(t['stack']).split('\\n')[:8]
                    for line in lines:
                        if line.strip():
                            print('    ' + line.strip())
                print('')

        if not stuck_threads and not hogging_threads:
            print('No stuck or hogging threads detected.')
            if active_threads:
                print('Active (normal) threads: ' + str(len(active_threads)))

    except Exception as e:
        print('ERROR reading thread runtime: ' + str(e))

connect(WLS_USER, WLS_PASSWORD, 't3://localhost:7001')
check_thread_pool(SERVER_NAME)
disconnect()
exit()
\`\`\`

Run it:

\`\`\`bash
\${MW_HOME}/oracle_common/common/bin/wlst.sh \
  /u01/app/oracle/scripts/check_threads.py \
  WlsAdmin1 otm_server1 300
\`\`\`

---

### Script 2: Shell Wrapper with Cron and Alert

\`\`\`bash
#!/bin/bash
# /u01/app/oracle/scripts/monitor_otm_threads.sh
# Cron: */5 * * * * /u01/app/oracle/scripts/monitor_otm_threads.sh
# Alerts to log and optionally email when stuck/hogging threads found

set -euo pipefail

MW_HOME=/u01/app/oracle/product/wls14
WLS_PASS=WlsAdmin1
SERVERS="otm_server1 intg_server1"
LOG_DIR=/u01/app/oracle/logs/thread_monitor
ALERT_LOG=\${LOG_DIR}/alerts.log
THREAD_THRESH=300   # hogging threshold in seconds
EMAIL_TO=""         # set to email address for alerts, or leave empty

mkdir -p \${LOG_DIR}

TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
RUN_LOG=\${LOG_DIR}/run_\$(date '+%Y%m%d_%H%M%S').log

for SERVER in \${SERVERS}; do
  echo "[\${TIMESTAMP}] Checking \${SERVER}" | tee -a \${RUN_LOG}

  OUTPUT=\$(\${MW_HOME}/oracle_common/common/bin/wlst.sh \
    /u01/app/oracle/scripts/check_threads.py \
    \${WLS_PASS} \${SERVER} \${THREAD_THRESH} 2>/dev/null || echo "WLST_ERROR")

  echo "\${OUTPUT}" >> \${RUN_LOG}

  # Extract counts
  STUCK=\$(echo "\${OUTPUT}" | grep 'Stuck Threads:' | awk '{print \$3}')
  HOGG=\$(echo "\${OUTPUT}" | grep 'Hogging Threads:' | awk '{print \$3}')
  PENDING=\$(echo "\${OUTPUT}" | grep 'Pending Requests:' | awk '{print \$3}')

  STUCK=\${STUCK:-0}; HOGG=\${HOGG:-0}; PENDING=\${PENDING:-0}

  # Log summary
  echo "[\${TIMESTAMP}] \${SERVER}: stuck=\${STUCK} hogging=\${HOGG} pending=\${PENDING}" \
    | tee -a \${ALERT_LOG}

  # Alert on stuck threads
  if [ "\${STUCK}" -gt 0 ]; then
    ALERT_MSG="CRITICAL: \${SERVER} has \${STUCK} STUCK thread(s) at \${TIMESTAMP}"
    echo "\${ALERT_MSG}" | tee -a \${ALERT_LOG}
    [ -n "\${EMAIL_TO}" ] && echo "\${OUTPUT}" | mail -s "\${ALERT_MSG}" \${EMAIL_TO}

    # Auto-capture thread dump on stuck thread detection
    JVM_PID=\$(pgrep -f "weblogic.Name=\${SERVER}" | head -1)
    if [ -n "\${JVM_PID}" ]; then
      DUMP_FILE=\${LOG_DIR}/threaddump_\${SERVER}_\$(date '+%Y%m%d_%H%M%S').txt
      echo "[\${TIMESTAMP}] Thread dump: \${DUMP_FILE}"
      kill -3 \${JVM_PID}
      jstack -l \${JVM_PID} >> \${DUMP_FILE} 2>&1 || true
      echo "Thread dump saved to \${DUMP_FILE}" | tee -a \${ALERT_LOG}
    fi
  fi

  # Warn on hogging threads
  if [ "\${HOGG}" -gt 2 ]; then
    echo "WARNING: \${SERVER} has \${HOGG} hogging thread(s)" | tee -a \${ALERT_LOG}
  fi

  # Warn on high pending queue
  if [ "\${PENDING}" -gt 100 ]; then
    echo "WARNING: \${SERVER} pending queue = \${PENDING}" | tee -a \${ALERT_LOG}
  fi
done

# Rotate logs older than 7 days
find \${LOG_DIR} -name 'run_*.log' -mtime +7 -delete
find \${LOG_DIR} -name 'threaddump_*.txt' -mtime +14 -delete
\`\`\`

---

### Script 3: jstack Thread Dump Analyser

When stuck threads are detected, jstack gives the raw JVM view — including WAITING and BLOCKED threads that the WLST MBean may not fully expose.

\`\`\`bash
#!/bin/bash
# /u01/app/oracle/scripts/analyze_threaddump.sh
# Usage: ./analyze_threaddump.sh [server_name]

SERVER=\${1:-otm_server1}
JVM_PID=\$(pgrep -f "weblogic.Name=\${SERVER}" | head -1)

if [ -z "\${JVM_PID}" ]; then
  echo "ERROR: No JVM process found for \${SERVER}"
  exit 1
fi

DUMP_FILE=/tmp/threaddump_\${SERVER}_\$(date '+%Y%m%d_%H%M%S').txt
echo "Capturing thread dump from PID \${JVM_PID} (\${SERVER})"
jstack -l \${JVM_PID} > \${DUMP_FILE} 2>&1

echo ""
echo "=== THREAD DUMP SUMMARY ==="
echo "File: \${DUMP_FILE}"
echo ""

# Count thread states
echo "Thread State Counts:"
grep -oP '(?<=java.lang.Thread.State: )\S+' \${DUMP_FILE} | sort | uniq -c | sort -rn

echo ""
echo "=== BLOCKED THREADS ==="
# Show all threads waiting on a monitor (BLOCKED state)
awk '/java.lang.Thread.State: BLOCKED/,/^$/' \${DUMP_FILE} | head -100

echo ""
echo "=== THREADS WAITING ON JDBC/DB CALL ==="
# OTM threads waiting on JDBC — shows DB-side bottleneck
grep -B5 "oracle.jdbc\|OracleConnection\|OraclePreparedStatement\|socketRead\|SocketChannelImpl.read" \
  \${DUMP_FILE} | grep -E '"[^"]+"|oracle\.|socketRead' | head -40

echo ""
echo "=== THREADS IN OTM ROUTE OPTIMIZATION ==="
# Long-running OTM optimization threads
grep -B3 "glog.optim\|glog.foundation.schedule\|glog.server.engine" \${DUMP_FILE} | head -40

echo ""
echo "=== LOCK CONTENTION (WAITING ON:) ==="
grep -E "waiting to lock|locked <|waiting on" \${DUMP_FILE} | sort | uniq -c | sort -rn | head -20

echo ""
echo "Full dump saved to: \${DUMP_FILE}"
\`\`\`

---

### Script 4: Database-Side OTM Session Analysis

Stuck WebLogic threads almost always correlate with slow or blocked database sessions. Run this on the DB server to find the matching Oracle session.

\`\`\`sql
-- otm_db_session_analysis.sql
-- Run as SYSDBA to find blocking sessions and long-running OTM queries

-- 4.1 Active OTM sessions with wait events
SELECT
  s.sid,
  s.serial#,
  s.status,
  s.username,
  s.machine,
  s.program,
  s.sql_id,
  s.wait_class,
  s.event,
  s.seconds_in_wait,
  s.blocking_session,
  ROUND(sq.elapsed_time / 1e6, 1) AS elapsed_sec,
  SUBSTR(sq.sql_text, 1, 120)     AS sql_preview
FROM v\$session s
JOIN v\$sql sq ON s.sql_id = sq.sql_id AND s.sql_child_number = sq.child_number
WHERE s.username = 'GLOGOWNER'
  AND s.status = 'ACTIVE'
  AND s.seconds_in_wait > 30
ORDER BY s.seconds_in_wait DESC;

-- 4.2 Blocking chain — which session is blocking OTM threads
SELECT
  LPAD(' ', 2 * LEVEL) || s.sid || ' (' || s.status || ')' AS session_tree,
  s.username,
  s.event,
  s.seconds_in_wait,
  s.sql_id,
  SUBSTR(sq.sql_text, 1, 100) AS sql_text
FROM v\$session s
LEFT JOIN v\$sql sq ON s.sql_id = sq.sql_id
CONNECT BY PRIOR s.sid = s.blocking_session
START WITH s.blocking_session IS NULL
  AND s.sid IN (SELECT blocking_session FROM v\$session WHERE blocking_session IS NOT NULL)
ORDER SIBLINGS BY s.seconds_in_wait DESC;

-- 4.3 Top SQL by elapsed time in GLOGOWNER (last hour)
SELECT
  sql_id,
  executions,
  ROUND(elapsed_time / 1e6 / GREATEST(executions, 1), 2)  AS avg_elapsed_sec,
  ROUND(elapsed_time / 1e6, 0)                             AS total_elapsed_sec,
  buffer_gets,
  disk_reads,
  rows_processed,
  SUBSTR(sql_text, 1, 120)                                 AS sql_preview
FROM (
  SELECT s.*, sq.sql_text
  FROM v\$sql s
  JOIN v\$sqlstats sq USING (sql_id)
  WHERE parsing_schema_name = 'GLOGOWNER'
    AND last_active_time > SYSDATE - 1/24
  ORDER BY elapsed_time DESC
)
WHERE ROWNUM <= 20;

-- 4.4 Long-running OTM transactions (uncommitted work holding row locks)
SELECT
  t.start_time,
  ROUND((SYSDATE - TO_DATE(t.start_time, 'MM/DD/YY HH24:MI:SS')) * 86400) AS duration_sec,
  s.sid,
  s.serial#,
  s.username,
  s.machine,
  t.used_ublk * 8192 / 1048576 AS undo_mb,
  t.log_io
FROM v\$transaction t
JOIN v\$session s ON t.addr = s.taddr
WHERE s.username = 'GLOGOWNER'
  AND (SYSDATE - TO_DATE(t.start_time, 'MM/DD/YY HH24:MI:SS')) * 86400 > 300
ORDER BY duration_sec DESC;

-- 4.5 Kill a blocking session (replace SID and SERIAL# from query 4.2 above)
-- ALTER SYSTEM KILL SESSION '&SID,&SERIAL#' IMMEDIATE;
\`\`\`

---

### Script 5: Continuous Thread Health Dashboard

\`\`\`bash
#!/bin/bash
# /u01/app/oracle/scripts/otm_thread_dashboard.sh
# Live 30-second refresh dashboard — run in a dedicated terminal
# Usage: ./otm_thread_dashboard.sh [server_name]

SERVER=\${1:-otm_server1}
MW_HOME=/u01/app/oracle/product/wls14
WLS_PASS=WlsAdmin1

while true; do
  clear
  echo "========================================"
  echo " OTM Thread Dashboard: \${SERVER}"
  echo " \$(date '+%Y-%m-%d %H:%M:%S')"
  echo "========================================"

  \${MW_HOME}/oracle_common/common/bin/wlst.sh << WLST 2>/dev/null | \
    grep -E 'Stuck|Hogging|Idle|Pending|Throughput|ALERT|WARNING'
connect('weblogic', '\${WLS_PASS}', 't3://localhost:7001')
domainRuntime()
cd('ServerRuntimes/\${SERVER}/ThreadPoolRuntime/ThreadPoolRuntime')
print('Stuck Threads:    ' + str(get('StuckThreadCount')))
print('Hogging Threads:  ' + str(get('HoggingThreadCount')))
print('Idle Threads:     ' + str(get('IdleThreadsCurrentCount')))
print('Pending Requests: ' + str(get('PendingUserRequestCount')))
print('Throughput req/s: ' + str(round(get('Throughput'), 2)))
disconnect()
exit()
WLST

  # JVM heap from jstat
  JVM_PID=\$(pgrep -f "weblogic.Name=\${SERVER}" | head -1)
  if [ -n "\${JVM_PID}" ]; then
    echo ""
    echo "JVM Heap (jstat):"
    jstat -gcutil \${JVM_PID} | tail -1 | \
      awk '{printf "  S0=%.1f%% S1=%.1f%% E=%.1f%% O=%.1f%% M=%.1f%% GC=%s FGC=%s\\n",
        \$1, \$2, \$3, \$4, \$5, \$6, \$8}'
  fi

  sleep 30
done
\`\`\`

---

## Post-Install Health Checks

\`\`\`bash
#!/bin/bash
# phase7_health_check.sh

source ~/.bash_profile
MW_HOME=/u01/app/oracle/product/wls14

echo "=== OTM Post-Install Health Check ==="
echo "Timestamp: \$(date)"
echo ""

# 1. All servers running
echo "--- Server States ---"
\${MW_HOME}/oracle_common/common/bin/wlst.sh << 'WLST' 2>/dev/null | grep -v "^Initializing"
connect('weblogic', 'WlsAdmin1', 't3://localhost:7001')
domainRuntime()
cd('ServerRuntimes')
for s in ls():
    cd(s)
    print(s + ': ' + get('State') + ' | Health: ' + get('HealthState').getState())
    cd('..')
disconnect()
exit()
WLST

# 2. OTM application deployed and active
echo ""
echo "--- OTM Application State ---"
\${MW_HOME}/oracle_common/common/bin/wlst.sh << 'WLST' 2>/dev/null | grep -E "otm|intg|State"
connect('weblogic', 'WlsAdmin1', 't3://localhost:7001')
domainRuntime()
cd('ServerRuntimes/otm_server1/ApplicationRuntimes')
for app in ls():
    cd(app)
    print(app + ': ' + get('ApplicationName') + ' -> ' + str(get('StatusInfo')))
    cd('..')
disconnect()
exit()
WLST

# 3. JDBC pool health
echo ""
echo "--- JDBC Pool ---"
\${MW_HOME}/oracle_common/common/bin/wlst.sh << 'WLST' 2>/dev/null
connect('weblogic', 'WlsAdmin1', 't3://localhost:7001')
serverRuntime()
cd('JDBCServiceRuntime/otm_server1/JDBCDataSourceRuntimeMBeans/OTMDataSource')
print('Active:    ' + str(get('ActiveConnectionsCurrentCount')))
print('Available: ' + str(get('NumAvailable')))
print('Waiting:   ' + str(get('WaitingForConnectionCurrentCount')))
print('State:     ' + str(get('State')))
disconnect()
exit()
WLST

# 4. OTM ping
echo ""
echo "--- OTM HTTP Ping ---"
HTTP_CODE=\$(curl -so /dev/null -w "%{http_code}" http://localhost:7401/GC3/glog.webserver.util.Ping)
echo "HTTP \${HTTP_CODE} (expected 200)"

# 5. Filestore permissions
echo ""
echo "--- Filestore Write Test ---"
touch /data/otm/filestore/inbound/.write_test && \
  echo "Inbound: OK" && rm /data/otm/filestore/inbound/.write_test

echo ""
echo "=== Health check complete ==="
\`\`\`

---

## Quick Reference

| Task | Command |
|------|---------|
| Check thread pool | \`wlst.sh check_threads.py WlsAdmin1 otm_server1\` |
| Thread dump | \`jstack -l \$(pgrep -f otm_server1) > /tmp/dump.txt\` |
| Restart otm_server1 | \`stopManagedWebLogic.sh otm_server1 && startManagedWebLogic.sh otm_server1 t3://localhost:7001\` |
| JDBC pool stats | WLST: \`cd JDBCDataSourceRuntimeMBeans/OTMDataSource\` |
| Kill blocking DB session | \`ALTER SYSTEM KILL SESSION 'SID,SERIAL#' IMMEDIATE;\` |
| View stuck thread log | \`grep -i "stuck" \${DOMAIN_HOME}/servers/otm_server1/logs/otm_server1.log\` |
| GC analysis | \`jstat -gcutil \$(pgrep -f otm_server1) 5000 10\` |
`,
};

async function main() {
  await db.insert(posts).values(post);
  console.log('Inserted:', post.slug);
}

main().catch(console.error);
