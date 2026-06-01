import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Fusion Middleware Monitoring and Alerting',
  slug: 'fusion-middleware-monitoring-alerting-runbook',
  excerpt:
    'Monitoring and alerting runbook for Oracle Fusion Middleware 12c — server health checks, JVM and thread pool metrics, JDBC pool utilization, SOA composite fault monitoring, SOAINFRA growth alerts, ODL log analysis, WebLogic Diagnostic Framework watch rules, email notification configuration, and automated health check scripts.',
  category: 'fusion-middleware' as const,
  published: true,
  publishedAt: new Date('2026-06-01'),
  youtubeUrl: null,
  content: `Effective FMW monitoring requires visibility across four layers simultaneously: the JVM (heap, GC, threads), the WebLogic runtime (server state, connection pools, work managers), the SOA Infrastructure (composite faults, dehydration queues, SOAINFRA table growth), and the OS (CPU, memory, disk). This runbook establishes the monitoring baseline, defines alert thresholds, implements WLDF watch rules for real-time notification, and provides health check scripts suitable for cron scheduling.

---

## What to Monitor — Alert Thresholds

| Metric | Warning | Critical | Action |
|---|---|---|---|
| Server state | ADMIN or STANDBY | SHUTDOWN or FAILED | Restart via Node Manager |
| JVM heap utilization | > 75% | > 90% | Investigate GC logs, resize heap |
| GC pause time | > 1s | > 5s | Tune GC settings |
| Thread pool queue length | > 5 | > 20 | Increase max threads or investigate slow callers |
| Thread pool idle count | < 5 | = 0 | Thread pool saturation — urgent |
| JDBC active connections | > 70% of max | > 90% of max | Increase pool max capacity |
| JDBC wait failures | > 0 in 5 min | > 10 in 5 min | Pool exhausted — investigate slow queries |
| SOA faulted instances (new) | > 10/hour | > 50/hour | Investigate fault patterns |
| SOAINFRA CUBE_INSTANCE rows | > 10M | > 50M | Run purge immediately |
| SOAINFRA table space used | > 70% of tablespace | > 90% | Extend tablespace or purge |
| Disk: DOMAIN_HOME filesystem | > 70% | > 85% | Rotate logs, archive old server output |
| Node Manager state | Not running | Not running for > 5 min | Restart NM; investigate why it stopped |
| ODL log ERROR rate | > 5/min | > 50/min | Review error patterns |

---

## Part 1: EM Fusion Middleware Control

EM FMW Control at \`http://<host>:7001/em\` is the primary operational dashboard. It provides:

- Real-time server state across all domain members
- JVM heap and GC charts per server
- JDBC datasource active connection counts
- SOA composite deployment status and fault counts
- Application deployment health

### 1.1 SOA composite monitoring in EM

Navigate to **SOA > soa-infra (soa_server1) > Dashboard**:

- **Instance Statistics** — running, completed, faulted instance counts per composite
- **Fault Rate** — faults per minute trend chart; spikes indicate integration failures
- **Throughput** — instances/minute trend; flat lines indicate the upstream trigger has stopped

Navigate to **SOA > soa-infra > Faults and Rejected Messages** to see the fault list with message text, enabling triage without touching SQL directly.

### 1.2 JDBC datasource monitoring in EM

Navigate to **WebLogic Domain > \`soa_domain\` > JDBC Datasources**:

- Active connections column shows current pool utilization per datasource per server
- Sort by Active Connections descending to immediately identify the most consumed pool

### 1.3 Setting EM metric alert thresholds

In EM FMW Control, alert thresholds are configurable per target:

1. Navigate to **WebLogic Domain > \`soa_domain\`**
2. Click **Monitoring > Metric and Collection Settings**
3. Expand **JVM** metrics — set Warning threshold for **JVM Heap Usage (%)** to 75, Critical to 90
4. Expand **Server** metrics — set Critical threshold for **Server State** to any value other than RUNNING

EM sends alerts to configured notification channels (email, PagerDuty, etc.) when thresholds are crossed.

---

## Part 2: WLST Real-Time Monitoring Scripts

### 2.1 Server health poll

\`\`\`bash
cat > /u01/scripts/fmw_server_health.sh << 'SCRIPT'
#!/bin/bash
source /home/oracle/.bash_profile

WLST=/u01/app/oracle/product/fmw/infra/oracle_common/common/bin/wlst.sh
ADMIN_URL=t3://localhost:7001
WLS_USER=weblogic
WLS_PASS=\${WLS_ADMIN_PASS}
LOG=/u01/scripts/logs/health_\$(date +%Y%m%d).log
ALERT_EMAIL=dba-alerts@example.com

\${WLST} /dev/stdin << EOF >> \${LOG} 2>&1
import datetime, smtplib
from email.mime.text import MIMEText

connect('\${WLS_USER}','\${WLS_PASS}','\${ADMIN_URL}')
domainRuntime()

alerts = []
timestamp = str(datetime.datetime.now())

servers = cmo.getServerRuntimes()
for s in servers:
    state = s.getState()
    name  = s.getName()
    if state not in ('RUNNING',):
        alerts.append(timestamp + ' CRITICAL: ' + name + ' state=' + state)
        print('ALERT:', name, state)
    else:
        # Check heap
        jvm = s.getJVMRuntime()
        heap_pct = int(jvm.getHeapSizeCurrent() * 100 / jvm.getHeapSizeMax())
        if heap_pct > 90:
            alerts.append(timestamp + ' CRITICAL: ' + name + ' heap=' + str(heap_pct) + '%')
        elif heap_pct > 75:
            alerts.append(timestamp + ' WARNING: '  + name + ' heap=' + str(heap_pct) + '%')
        # Check thread pool queue
        tp = s.getThreadPoolRuntime()
        queue = tp.getPendingUserRequestCount()
        if queue > 20:
            alerts.append(timestamp + ' CRITICAL: ' + name + ' thread_queue=' + str(queue))
        elif queue > 5:
            alerts.append(timestamp + ' WARNING: '  + name + ' thread_queue=' + str(queue))
        print('OK:', name, '| heap:', str(heap_pct)+'%', '| queue:', queue, '| state:', state)

if alerts:
    msg = MIMEText('\\n'.join(alerts))
    msg['Subject'] = 'FMW Alert: ' + str(len(alerts)) + ' issue(s) on ' + '\$(hostname)'
    msg['From']    = 'fmw-monitor@example.com'
    msg['To']      = '\${ALERT_EMAIL}'
    try:
        s = smtplib.SMTP('mailrelay.example.com', 25)
        s.sendmail(msg['From'], [msg['To']], msg.as_string())
        s.quit()
        print('Alert email sent')
    except Exception as e:
        print('Email failed:', str(e))

exit()
EOF
SCRIPT
chmod 750 /u01/scripts/fmw_server_health.sh
\`\`\`

Create the credentials environment file \`/etc/sysconfig/fmw-monitor\`:

\`\`\`bash
WLS_ADMIN_PASS=<admin_password>
\`\`\`

### 2.2 JDBC pool utilization check

\`\`\`bash
/u01/app/oracle/product/fmw/infra/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<password>','t3://localhost:8001')
serverRuntime()
cd('JDBCServiceRuntime/soa_server1')
datasources = cmo.getJDBCDataSourceRuntimeMBeans()
for ds in datasources:
    active   = ds.getActiveConnectionsCurrentCount()
    max_cap  = ds.getConnectionsTotalCount()
    waiting  = ds.getWaitingForConnectionCurrentCount()
    failures = ds.getWaitingForConnectionFailureTotal()
    pct      = int(active * 100 / max_cap) if max_cap > 0 else 0
    status   = 'WARN' if pct > 70 else 'OK'
    print(status, '|', ds.getName(), '| active:', active,
          '| max:', max_cap, '| pct:', str(pct)+'%',
          '| waiting:', waiting, '| wait_failures:', failures)
exit()
EOF
\`\`\`

### 2.3 SOA composite fault summary

\`\`\`bash
/u01/app/oracle/product/fmw/infra/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<password>','t3://localhost:8001')
cd('oracle.as.soainfra.engine:Server=soa_server1,name=SoaInfraEngine,type=SoaInfraEngine')
print('Instances running:  ', get('OpenInstancesCount'))
print('Instances completed:', get('ClosedInstancesCount'))
print('Instances faulted:  ', get('FaultedInstancesCount'))
print('Recovery pending:   ', get('PendingRecoveryCount'))
exit()
EOF
\`\`\`

---

## Part 3: SOA Infrastructure Monitoring via SQL

### 3.1 Faulted instance dashboard

\`\`\`sql
-- Faults in the last hour, grouped by composite and fault type
SELECT composite_name,
       SUBSTR(fault_name, INSTR(fault_name, '.', -1) + 1) AS fault_type,
       COUNT(*) AS fault_count,
       MAX(fault_time) AS last_fault,
       SUBSTR(MAX(fault_message), 1, 120) AS sample_message
FROM fault_instance fi
JOIN cube_instance ci ON fi.instance_id = ci.instance_id
WHERE fi.fault_time > SYSDATE - 1/24
GROUP BY composite_name, SUBSTR(fault_name, INSTR(fault_name, '.', -1) + 1)
ORDER BY fault_count DESC;
\`\`\`

### 3.2 Composite throughput trend

\`\`\`sql
-- Instance creation rate per composite for the last 6 hours (30-min buckets)
SELECT composite_name,
       TRUNC(creation_date, 'MI') - MOD(TO_NUMBER(TO_CHAR(creation_date,'MI')), 30) / 1440 AS period_start,
       COUNT(*) AS instances
FROM cube_instance
WHERE creation_date > SYSDATE - 6/24
GROUP BY composite_name,
         TRUNC(creation_date, 'MI') - MOD(TO_NUMBER(TO_CHAR(creation_date,'MI')), 30) / 1440
ORDER BY composite_name, period_start;
\`\`\`

### 3.3 SOAINFRA table growth monitoring

\`\`\`sql
-- Current row counts and segment sizes for hot SOAINFRA tables
SELECT s.segment_name,
       TO_CHAR(t.num_rows, '999,999,999') AS row_count,
       ROUND(s.bytes / 1073741824, 2) AS size_gb,
       TO_CHAR(t.last_analyzed, 'YYYY-MM-DD HH24:MI') AS last_stats
FROM dba_segments s
JOIN dba_tables t ON s.owner = t.owner AND s.segment_name = t.table_name
WHERE s.owner = 'FMW_SOAINFRA'
  AND s.segment_name IN ('CUBE_INSTANCE','AUDIT_TRAIL','AUDIT_DETAILS',
                         'CUBE_SCOPE','FAULT_INSTANCE','MEDIATOR_INSTANCE',
                         'HWF_TASK','DOCUMENT_CI_REF')
ORDER BY s.bytes DESC;
\`\`\`

### 3.4 Long-running and stale instances

\`\`\`sql
-- Instances running for more than 24 hours (may indicate stuck processes)
SELECT composite_name,
       instance_id,
       state,
       TO_CHAR(creation_date, 'YYYY-MM-DD HH24:MI') AS created,
       ROUND((SYSDATE - creation_date) * 24, 1) AS age_hours
FROM cube_instance
WHERE state IN (0, 1)  -- open/running or open/suspended
  AND creation_date < SYSDATE - 1
ORDER BY age_hours DESC
FETCH FIRST 25 ROWS ONLY;
\`\`\`

### 3.5 Human Workflow task SLA monitoring

\`\`\`sql
-- Tasks approaching or past their expiration deadline
SELECT task_id,
       task_name,
       assignees,
       state,
       TO_CHAR(created_date, 'YYYY-MM-DD HH24:MI') AS created,
       TO_CHAR(expiration_date, 'YYYY-MM-DD HH24:MI') AS expires,
       ROUND((expiration_date - SYSDATE) * 24, 1) AS hours_remaining
FROM FMW_SOAINFRA.HWF_TASK
WHERE state NOT IN ('COMPLETED','WITHDRAWN','EXPIRED')
  AND expiration_date IS NOT NULL
  AND expiration_date < SYSDATE + 4/24  -- expiring within 4 hours
ORDER BY expiration_date ASC;
\`\`\`

---

## Part 4: ODL Log Monitoring

Oracle FMW uses Oracle Diagnostic Logging (ODL) format. Logs are stored under:

\`\`\`
\${DOMAIN_HOME}/servers/<server>/logs/<server>.log   — ODL format, structured
\${DOMAIN_HOME}/servers/<server>/logs/<server>.out   — stdout/stderr, unstructured
\`\`\`

### 4.1 ODL log structure

Each ODL entry has the format:

\`\`\`
[YYYY-MM-DDTHH:MM:SS.sss+TZ] [LEVEL] [COMPONENT] [HOST] [THREAD] [] [ECID] [APP] MESSAGE
\`\`\`

Example:
\`\`\`
[2026-06-01T08:14:32.441+00:00] [soa_server1] [ERROR] [] [oracle.soa.bpel.engine]
[host: soa-node1] [tid: 145] [] [] BEA-000000
Could not dehydrate instance id 40832: ORA-01555: snapshot too old
\`\`\`

### 4.2 Extract errors from ODL logs

\`\`\`bash
# All ERROR and CRITICAL entries from the last hour
SINCE=\$(date -d '1 hour ago' '+%Y-%m-%dT%H:%M')
grep -E '\\[(ERROR|CRITICAL|ALERT|EMERGENCY)\\]' \\
  \${DOMAIN_HOME}/servers/soa_server1/logs/soa_server1.log \\
  | awk -v since="\${SINCE}" '\$1 >= "["since"]"' \\
  | tail -50

# Count errors per component in the last 1000 lines
grep -E '\\[ERROR\\]' \${DOMAIN_HOME}/servers/soa_server1/logs/soa_server1.log \\
  | tail -1000 \\
  | grep -oP '\\[oracle\\.\\S+\\]' \\
  | sort | uniq -c | sort -rn | head -15
\`\`\`

### 4.3 Watch for critical SOA error patterns

\`\`\`bash
# Patterns that require immediate attention
CRITICAL_PATTERNS=(
  "ORA-01555"                # Snapshot too old — UNDO undersized
  "ORA-04031"                # Shared pool/large pool OOM
  "Connection refused"       # DB or upstream service unavailable
  "BEA-000337"               # Server failed to bind port
  "BEA-002627"               # MDB message lost
  "SOA-20056"                # BPEL dehydration failure
  "ORABPEL-02025"            # Correlation set not found
  "java.lang.OutOfMemoryError"  # JVM OOM
  "Stuck ExecuteThread"      # Stuck thread detected
)

for pattern in "\${CRITICAL_PATTERNS[@]}"; do
  count=\$(grep -c "\${pattern}" \\
    \${DOMAIN_HOME}/servers/soa_server1/logs/soa_server1.log 2>/dev/null || echo 0)
  if [ "\${count}" -gt 0 ]; then
    echo "FOUND \${count}x [\${pattern}]"
  fi
done
\`\`\`

### 4.4 Centralized log shipping

For environments with a SIEM or log aggregation platform (Splunk, Elasticsearch, Graylog), configure syslog forwarding or a file beat agent to ship the ODL logs. Key fields to extract for structured indexing:

\`\`\`bash
# Use awk to convert ODL to JSON for shipping to Elasticsearch
awk '
/^\[20[0-9]{2}-/ {
  match(\$0, /^\[([^\]]+)\] \[([^\]]+)\] \[([^\]]+)\] \[([^\]]*)\] \[([^\]]*)\]/, arr)
  printf "{\"@timestamp\":\"%s\",\"server\":\"%s\",\"level\":\"%s\",\"component\":\"%s\"}\n",
    arr[1], arr[2], arr[3], arr[5]
}' \${DOMAIN_HOME}/servers/soa_server1/logs/soa_server1.log
\`\`\`

---

## Part 5: WebLogic Diagnostic Framework (WLDF)

WLDF is WebLogic's built-in observability framework. It provides watch rules that trigger notifications when metrics cross thresholds — without requiring external monitoring agents.

### 5.1 Create a WLDF diagnostic module

In Admin Console: **Diagnostics > Diagnostic Modules > New**

Name: \`FMW_Watch_Module\`

Target: \`soa_cluster\` (or individual servers)

### 5.2 Configure watch rules

Under the diagnostic module, add **Watches and Notifications > New Watch**:

**Watch 1: Heap high**
\`\`\`
Name:           HeapHighWatch
Severity:       Warning
Rule Expression: (JVMRuntime.HeapSizeCurrent / JVMRuntime.HeapSizeMax) * 100 > 80
Alarm Reset Period: 300 seconds
\`\`\`

**Watch 2: Thread pool queue saturated**
\`\`\`
Name:           ThreadQueueWatch
Severity:       Critical
Rule Expression: ThreadPoolRuntime.PendingUserRequestCount > 10
Alarm Reset Period: 60 seconds
\`\`\`

**Watch 3: Server not in RUNNING state**
\`\`\`
Name:           ServerStateWatch
Severity:       Critical
Rule Expression: ServerRuntime.State != 'RUNNING'
Alarm Reset Period: 120 seconds
\`\`\`

**Watch 4: JDBC pool wait failures**
\`\`\`
Name:           JDBCWaitFailWatch
Severity:       Critical
Rule Expression: JDBCDataSourceRuntime.WaitingForConnectionFailureTotal > 0
Alarm Reset Period: 60 seconds
\`\`\`

### 5.3 Configure email notification

In Admin Console: **Diagnostics > Diagnostic Modules > FMW_Watch_Module > Watches and Notifications > Notifications > New SMTP Notification**

\`\`\`
Name:             EmailNotification
SMTP Server:      mailrelay.example.com
SMTP Port:        25
From Address:     fmw-alerts@example.com
To Addresses:     dba-team@example.com, ops-team@example.com
Subject Pattern:  FMW Alert: {SEVERITY} on {SERVER_NAME} - {WATCH_NAME}
Body Pattern:     Watch {WATCH_NAME} triggered on {SERVER_NAME} at {TIMESTAMP}.
                  Rule: {RULE_EXPRESSION}
                  Value: {TRIGGER_VALUE}
\`\`\`

Assign this notification to each watch rule.

### 5.4 WLDF JMX notification for external monitoring

For integration with Nagios, Zabbix, Prometheus, or similar external monitoring platforms, configure a JMX notification. The external tool polls or subscribes to the JMX MBean and converts WLDF events to its own alert format.

\`\`\`bash
# Test JMX connectivity (confirm the JMX port is open)
# WLS JMX service URL: service:jmx:iiop://<host>:7001/jndi/weblogic.management.mbeanservers.domainruntime
# Use JConsole or any JMX client to verify

# Prometheus JMX Exporter can be added as a JVM agent to expose WLS MBeans as /metrics:
# -javaagent:/u01/agents/jmx_prometheus_javaagent.jar=9090:\${DOMAIN_HOME}/config/jmx_exporter.yml
\`\`\`

---

## Part 6: Node Manager Monitoring

Node Manager must be running for automatic server restart to function. If Node Manager itself goes down, crashed managed servers will not be restarted.

### 6.1 Node Manager health check script

\`\`\`bash
cat > /u01/scripts/check_nodemanager.sh << 'SCRIPT'
#!/bin/bash
NM_PORT=5556
NM_HOST=localhost
LOG=/u01/scripts/logs/nm_check_\$(date +%Y%m%d).log

if nc -zv \${NM_HOST} \${NM_PORT} > /dev/null 2>&1; then
  echo "\$(date) OK: Node Manager listening on \${NM_PORT}" >> \${LOG}
else
  echo "\$(date) CRITICAL: Node Manager NOT listening on \${NM_PORT}" >> \${LOG}
  # Attempt restart
  nohup /u01/app/oracle/config/domains/soa_domain/bin/startNodeManager.sh \\
    > /u01/app/oracle/config/domains/soa_domain/nodemanager/nodemanager.out 2>&1 &
  echo "\$(date) ACTION: Node Manager restart initiated" >> \${LOG}
  # Send alert
  echo "Node Manager was down and has been restarted on \$(hostname) at \$(date)" | \\
    mail -s "CRITICAL: FMW Node Manager restarted" dba-alerts@example.com
fi
SCRIPT
chmod 750 /u01/scripts/check_nodemanager.sh
\`\`\`

Add to crontab:

\`\`\`bash
# Check Node Manager every 5 minutes
*/5 * * * * /u01/scripts/check_nodemanager.sh
\`\`\`

---

## Part 7: OS-Level Monitoring

### 7.1 Disk space monitoring for FMW directories

FMW log files grow continuously. The server log directory and the server output file are the most common sources of unexpected disk fills.

\`\`\`bash
cat > /u01/scripts/check_disk.sh << 'SCRIPT'
#!/bin/bash
THRESHOLD_WARN=70
THRESHOLD_CRIT=85
ALERT_EMAIL=dba-alerts@example.com

while IFS= read -r line; do
  USE=\$(echo "\${line}" | awk '{print \$5}' | tr -d '%')
  MNT=\$(echo "\${line}" | awk '{print \$6}')
  if [ "\${USE}" -ge "\${THRESHOLD_CRIT}" ]; then
    echo "CRITICAL: \${MNT} is \${USE}% full on \$(hostname)" | \\
      mail -s "CRITICAL: Disk \${MNT} \${USE}% on \$(hostname)" "\${ALERT_EMAIL}"
  elif [ "\${USE}" -ge "\${THRESHOLD_WARN}" ]; then
    echo "WARNING: \${MNT} is \${USE}% full" >> /u01/scripts/logs/disk_warn.log
  fi
done < <(df -h /u01 /tmp /var | tail -n +2)
SCRIPT
chmod 750 /u01/scripts/check_disk.sh
\`\`\`

### 7.2 Log rotation for FMW server output files

The \`*.out\` files (stdout redirect from startup scripts) are not rotated by WebLogic. They grow without bound unless rotated externally.

Create \`/etc/logrotate.d/fmw\`:

\`\`\`
/u01/app/oracle/config/domains/*/servers/*/logs/*.out {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}

/u01/app/oracle/config/domains/*/servers/*/logs/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
\`\`\`

WebLogic also has built-in log rotation. In Admin Console: **Environment > Servers > \`<server>\` > Logging**:
- Log File Rotation Type: **By Size**
- Log File Min Size: \`10000\` KB
- Number Of Files Limited: checked
- File Count: \`10\`

---

## Part 8: Consolidated Health Check Script

This script runs all key checks and outputs a health dashboard suitable for a cron-driven daily report or a Nagios/Icinga passive check.

\`\`\`bash
cat > /u01/scripts/fmw_health_report.sh << 'SCRIPT'
#!/bin/bash
source /home/oracle/.bash_profile

DATE=\$(date '+%Y-%m-%d %H:%M:%S')
HOST=\$(hostname -s)
REPORT=/u01/scripts/logs/health_report_\$(date +%Y%m%d).txt
WLST=/u01/app/oracle/product/fmw/infra/oracle_common/common/bin/wlst.sh
SQLPLUS=/u01/app/oracle/product/fmw/infra/oracle_common/bin/sqlplus

{
echo "======================================================"
echo " FMW Health Report — \${HOST} — \${DATE}"
echo "======================================================"

# --- Process checks ---
echo ""
echo "--- JVM Processes ---"
for SRV in AdminServer soa_server1 soa_server2; do
  PID=\$(ps -ef | grep "\${SRV}" | grep -v grep | awk '{print \$2}' | head -1)
  if [ -n "\${PID}" ]; then
    echo "  OK: \${SRV} running (PID \${PID})"
  else
    echo "  CRITICAL: \${SRV} NOT running"
  fi
done

NM_PID=\$(ps -ef | grep NodeManager | grep -v grep | awk '{print \$2}' | head -1)
if [ -n "\${NM_PID}" ]; then
  echo "  OK: NodeManager running (PID \${NM_PID})"
else
  echo "  CRITICAL: NodeManager NOT running"
fi

# --- Server state and metrics via WLST ---
echo ""
echo "--- Server State and JVM Metrics ---"
\${WLST} /dev/stdin << 'WLSTEOF' 2>/dev/null
connect('weblogic','<password>','t3://localhost:7001')
domainRuntime()
for s in cmo.getServerRuntimes():
    jvm   = s.getJVMRuntime()
    tp    = s.getThreadPoolRuntime()
    h_pct = int(jvm.getHeapSizeCurrent() * 100 / jvm.getHeapSizeMax())
    queue = tp.getPendingUserRequestCount()
    state = s.getState()
    flag  = 'OK   ' if state == 'RUNNING' and h_pct < 75 and queue < 5 else 'WARN '
    print(' ', flag + s.getName(),
          '| state:', state,
          '| heap:', str(h_pct)+'%',
          '| queue:', queue,
          '| uptime:', round(s.getActivationTime()/3600000.0, 1), 'hr')
exit()
WLSTEOF

# --- SOAINFRA quick stats ---
echo ""
echo "--- SOAINFRA Instance Counts (last 1 hour) ---"
\${SQLPLUS} -s FMW_SOAINFRA/<db_password>@fmwdb.example.com:1521/FMWDB << 'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT '  Running: '   || COUNT(*) FROM cube_instance WHERE state = 0;
SELECT '  Completed: ' || COUNT(*) FROM cube_instance WHERE state = 2 AND creation_date > SYSDATE - 1/24;
SELECT '  Faulted: '   || COUNT(*) FROM cube_instance WHERE state = 4 AND creation_date > SYSDATE - 1/24;
SELECT '  CUBE_INSTANCE total rows: ' || TO_CHAR(COUNT(*), '999,999,999') FROM cube_instance;
EXIT;
SQLEOF

# --- Disk usage ---
echo ""
echo "--- Disk Usage ---"
df -h /u01 /tmp | tail -n +2 | awk '{
  gsub(/%/,"",$5)
  flag = ($5 >= 85) ? "CRITICAL" : ($5 >= 70) ? "WARNING " : "OK      "
  print "  " flag ": " $6 " " $5 "% used"
}'

echo ""
echo "======================================================"
echo " Report complete: \$(date '+%Y-%m-%d %H:%M:%S')"
echo "======================================================"
} | tee \${REPORT}

# Email report if any CRITICAL or WARNING found
if grep -qE "CRITICAL|WARNING" "\${REPORT}"; then
  mail -s "FMW Health Alert — \${HOST} — \$(date +%Y-%m-%d)" \\
    dba-alerts@example.com < "\${REPORT}"
fi
SCRIPT
chmod 750 /u01/scripts/fmw_health_report.sh
\`\`\`

Schedule the health report:

\`\`\`bash
crontab -e
# Add:
# */15 * * * *  /u01/scripts/fmw_server_health.sh     # Frequent: server/JVM/pool checks
# */5  * * * *  /u01/scripts/check_nodemanager.sh     # Node Manager watchdog
# 0    * * * *  /u01/scripts/fmw_health_report.sh     # Hourly full report
# 0    6 * * *  /u01/scripts/check_disk.sh            # Daily disk check
\`\`\`

---

## Part 9: SOAINFRA Growth Alert via Database Scheduler

Schedule an Oracle DBMS_SCHEDULER job that alerts when SOAINFRA exceeds row count thresholds:

\`\`\`sql
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'SOAINFRA_GROWTH_CHECK',
    job_type        => 'PLSQL_BLOCK',
    job_action      => q'[
DECLARE
  v_count NUMBER;
  v_msg   VARCHAR2(4000);
BEGIN
  SELECT COUNT(*) INTO v_count FROM FMW_SOAINFRA.CUBE_INSTANCE WHERE state IN (0,1,4);
  IF v_count > 10000000 THEN
    v_msg := 'SOAINFRA CUBE_INSTANCE has ' || TO_CHAR(v_count,'999,999,999') ||
             ' open/faulted rows. Purge required immediately.';
    -- Send email via UTL_MAIL (requires UTL_MAIL setup) or write to an alert table
    INSERT INTO DBA_ALERTS (alert_time, severity, message)
    VALUES (SYSTIMESTAMP, 'CRITICAL', v_msg);
    COMMIT;
  END IF;
END;]',
    start_date      => SYSTIMESTAMP,
    repeat_interval => 'FREQ=HOURLY;INTERVAL=1',
    enabled         => TRUE,
    comments        => 'Alert when SOAINFRA CUBE_INSTANCE exceeds 10M open rows'
  );
END;
/
\`\`\`

---

## Monitoring Quick Reference

\`\`\`
Check                         | Tool              | Command / Location
------------------------------|-------------------|------------------------------------------
Server states                 | EM or WLST        | domainRuntime() > getServerRuntimes()
JVM heap utilization          | EM or WLST        | JVMRuntime.HeapSizeCurrent/HeapSizeMax
Thread pool queue             | WLST              | ThreadPoolRuntime.PendingUserRequestCount
JDBC active connections       | Admin Console     | Services > DataSources > Monitoring
SOA fault counts              | EM / SQL          | SELECT FROM fault_instance WHERE fault_time > SYSDATE-1/24
SOAINFRA table sizes          | SQL               | dba_segments WHERE owner='FMW_SOAINFRA'
Long-running instances        | SQL               | cube_instance WHERE state=0 AND creation_date < SYSDATE-1
ODL error count               | grep              | grep '[ERROR]' server.log | wc -l
Node Manager state            | nc / ps           | nc -zv localhost 5556
Disk usage                    | df                | df -h /u01
Active DB sessions from SOA   | SQL               | v\$session WHERE username='FMW_SOAINFRA'
\`\`\`

---

## Monitoring Checklist

- [ ] EM FMW Control accessible and all servers showing RUNNING
- [ ] EM metric alert thresholds set for heap (75% warn, 90% crit) and server state
- [ ] WLDF diagnostic module deployed to soa_cluster with heap, thread queue, and JDBC watches
- [ ] Email notification configured in WLDF and test email received
- [ ] Server health poll cron job running every 15 minutes
- [ ] Node Manager watchdog cron running every 5 minutes
- [ ] Hourly health report cron job running and emailing on alerts
- [ ] Log rotation configured for \`*.out\` and \`*.log\` files
- [ ] SOAINFRA growth alert job active in DB scheduler
- [ ] ODL error pattern scan confirmed working (known pattern returns count)
- [ ] JDBC pool utilization baseline recorded — alert thresholds set relative to max capacity
- [ ] Human Workflow SLA query run and no expired tasks found
- [ ] Disk space check active on all FMW mount points`,
};

async function main() {
  console.log('Inserting FMW monitoring and alerting runbook...');
  await db.insert(posts).values(post).onConflictDoNothing();
  console.log(`Inserted: "${post.title}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
