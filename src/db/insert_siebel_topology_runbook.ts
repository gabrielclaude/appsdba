import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Siebel CRM Administration Runbook — Install, Maintain, Monitor',
  slug: 'oracle-siebel-topology-install-maintain-runbook',
  excerpt:
    'Step-by-step Oracle Siebel CRM runbook covering pre-installation planning, Gateway Name Server and Enterprise Server setup, component group management, a complete bash health check script, crontab scheduling, and a routine maintenance calendar.',
  category: 'oracle-siebel' as const,
  isPremium: true,
  published: true,
  publishedAt: new Date('2026-06-18'),
  content: `## Phase 0: Pre-Installation Planning

Before installing any Siebel component confirm hardware sizing and OS baseline.

### Minimum Hardware per Siebel Server

- CPU: 16 cores (32 threads) — Siebel AOM processes are CPU-heavy under load
- RAM: 32 GB minimum; 64 GB for production with more than 500 concurrent users
- Disk: 200 GB for binaries, logs, and archive; separate spindle or SSD from database
- Network: 1 Gbps minimum between Siebel Server and database; 10 Gbps recommended

### OS Prerequisites (Oracle Linux 7 / 8)

Set kernel parameters in \`/etc/sysctl.conf\`:

\`\`\`bash
kernel.shmmax = 68719476736
kernel.shmall = 4294967296
kernel.sem = 250 32000 100 128
net.ipv4.ip_local_port_range = 9000 65500
net.core.rmem_max = 4194304
net.core.wmem_max = 1048576
fs.file-max = 6815744
\`\`\`

Apply immediately: \`sysctl -p\`

Set user limits in \`/etc/security/limits.conf\`:

\`\`\`
siebel soft nofile 65536
siebel hard nofile 65536
siebel soft nproc  16384
siebel hard nproc  16384
siebel soft stack  10240
siebel hard stack  32768
\`\`\`

Install required OS packages:

\`\`\`bash
yum install -y binutils compat-libstdc++ gcc gcc-c++ glibc glibc-devel \
  libaio libaio-devel libgcc libstdc++ libstdc++-devel make sysstat \
  unixODBC unixODBC-devel ksh xorg-x11-utils
\`\`\`

### Filesystem Layout

\`\`\`
/siebel/
  ses/           Siebel Enterprise Server binaries
    siebsrvr/    Siebel Server home (SIEBSRVR_ROOT)
    gtwysrvr/    Gateway Name Server home
    dbsrvr/      Database Server utilities
  log/           Runtime logs (symlink or mount)
  archive/       Log archives, patch archives
  install/       Installation media staging
\`\`\`

Create filesystem and set ownership:

\`\`\`bash
mkdir -p /siebel/{ses,log,archive,install}
useradd -m -s /bin/bash siebel
chown -R siebel:siebel /siebel
chmod 750 /siebel
\`\`\`

### Environment Variables (add to siebel .bash_profile)

\`\`\`bash
export SIEBEL_ROOT=/siebel/ses/siebsrvr
export SIEBEL_LOG=/siebel/log
export ORACLE_HOME=/opt/oracle/product/19c/dbhome_1
export LD_LIBRARY_PATH=\${ORACLE_HOME}/lib:\${SIEBEL_ROOT}/lib
export PATH=\${SIEBEL_ROOT}/bin:\${ORACLE_HOME}/bin:\${PATH}
export SIEBEL_ENTERPRISE=SiebelEnterprise
export SIEBEL_SERVER=siebsrvr01
export GATEWAY_HOST=siebgw01
export GATEWAY_PORT=2320
\`\`\`

---

## Phase 1: Gateway Name Server Installation

The Gateway Name Server is the central registry. Install it first on a dedicated host or on the primary Siebel Server host.

\`\`\`bash
cd /siebel/install/Siebel_Enterprise_Server
./install.sh -mode unattended -response /tmp/gtwysrvr.rsp
\`\`\`

Minimal response file \`/tmp/gtwysrvr.rsp\`:

\`\`\`
INSTALL_TYPE=GatewayServer
INSTALL_DIR=/siebel/ses/gtwysrvr
GATEWAY_PORT=2320
SIEBEL_ENTERPRISE=SiebelEnterprise
\`\`\`

### Start Gateway and verify

\`\`\`bash
cd /siebel/ses/gtwysrvr/bin
./start_ns
\`\`\`

Verify port is listening:

\`\`\`bash
nc -z localhost 2320 && echo "Gateway UP" || echo "Gateway DOWN"
\`\`\`

### Create systemd unit for Gateway

\`\`\`ini
[Unit]
Description=Oracle Siebel Gateway Name Server
After=network.target

[Service]
Type=forking
User=siebel
ExecStart=/siebel/ses/gtwysrvr/bin/start_ns
ExecStop=/siebel/ses/gtwysrvr/bin/stop_ns
PIDFile=/siebel/ses/gtwysrvr/log/siebns.pid
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
\`\`\`

\`\`\`bash
cp siebel-gateway.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable siebel-gateway
systemctl start siebel-gateway
\`\`\`

---

## Phase 2: Siebel Enterprise Server Installation

\`\`\`bash
cd /siebel/install/Siebel_Enterprise_Server
./install.sh -mode unattended -response /tmp/ses.rsp
\`\`\`

Key response file parameters:

\`\`\`
INSTALL_TYPE=EnterpriseServer
INSTALL_DIR=/siebel/ses
SIEBEL_ENTERPRISE=SiebelEnterprise
GATEWAY_HOST=siebgw01
GATEWAY_PORT=2320
DB_TYPE=Oracle
DB_HOST=dbhost01
DB_PORT=1521
DB_SERVICE=siebeldb
DB_USER=SADMIN
DB_PASSWORD=<your_sadmin_password>
LANGUAGE=enu
\`\`\`

### Configure Enterprise Parameters (via srvrmgr after first start)

\`\`\`
srvrmgr> change ent param MaxTasks=500
srvrmgr> change ent param MaxMTServers=4
srvrmgr> change ent param MinMTServers=1
srvrmgr> change ent param PersistConnection=TRUE
\`\`\`

---

## Phase 3: Database Configuration Utilities

Run the database configuration utility to create the Siebel schema and seed data:

\`\`\`bash
cd /siebel/ses/dbsrvr/bin
./dbsrvr -mode install \
  -dbtype Oracle \
  -dbhost dbhost01:1521/siebeldb \
  -dbuser SADMIN \
  -dbpassword <your_sadmin_password> \
  -language enu \
  -logfile /siebel/log/dbinstall.log
\`\`\`

Verify schema after install:

\`\`\`sql
-- Run as SADMIN or DBA
SELECT COUNT(*) FROM all_tables
WHERE owner = 'SIEBEL'
AND table_name LIKE 'S_%';
-- Expect 700+ tables for a full install
\`\`\`

Check for invalid objects after schema creation:

\`\`\`sql
SELECT object_name, object_type, status
FROM all_objects
WHERE owner = 'SIEBEL'
AND status != 'VALID'
ORDER BY object_type, object_name;
\`\`\`

Recompile invalids if found:

\`\`\`sql
EXEC DBMS_UTILITY.COMPILE_SCHEMA(schema => 'SIEBEL', compile_all => FALSE);
\`\`\`

---

## Phase 4: SWSE (Web Tier) Configuration

Install the Siebel Web Server Extension on each web server. After installation edit \`eapps.cfg\`:

\`\`\`ini
[GatewayServer]
GatewayAddress   = siebgw01
GatewayPort      = 2320
EnterpriseServer = SiebelEnterprise

[SWEApp]
ConnectString          = siebel.TCPIP.None.None://siebsrvr01:2321/SiebelEnterprise/SiebelCallCenter
EnableVirtualHosts     = FALSE
SiebelUsername         = SADMIN
SiebelPassword         = <hashed_via_encryptstring>
SessionTimeout         = 900
MaxSessions            = 1000
EnableFQDN             = TRUE
\`\`\`

Restart Apache / IIS after editing eapps.cfg. Verify SWSE health:

\`\`\`bash
curl -s -o /dev/null -w "%{http_code}" \
  http://siebweb01/callcenter_enu/start.swe?SWECmd=GetCachedPage
# Expect 200
\`\`\`

---

## Phase 5: Component Group Management

Connect to Server Manager and enable required component groups:

\`\`\`bash
srvrmgr /g siebgw01 /e SiebelEnterprise /s siebsrvr01 \
  /u SADMIN /p <your_sadmin_password>
\`\`\`

\`\`\`
srvrmgr> enable compgrp CallCenter
srvrmgr> enable compgrp CommMgmt
srvrmgr> enable compgrp ContentMgmt
srvrmgr> enable compgrp EAIObjMgr
srvrmgr> enable compgrp SCCObjMgr
srvrmgr> list compgrp
\`\`\`

Start all enabled groups:

\`\`\`
srvrmgr> start compgrp CallCenter
srvrmgr> start compgrp CommMgmt
\`\`\`

Verify component status — every component should show \`Running\`:

\`\`\`
srvrmgr> list comp show CP_NAME, CP_DISP_RUN_STATE, CP_NUM_RUN_TASKS, CP_MAX_TASKS
\`\`\`

---

## Phase 6: Complete Health Check Script

Save as \`/opt/scripts/siebel_health.sh\` and make executable.

\`\`\`bash
#!/bin/bash
# =============================================================
# Siebel CRM Health Check Script
# Schedule: */15 * * * * via crontab
# =============================================================

SIEBEL_ROOT=/siebel/ses/siebsrvr
GATEWAY_HOST=siebgw01
GATEWAY_PORT=2320
ENTERPRISE=SiebelEnterprise
SIEBEL_SERVER=siebsrvr01
SADMIN_PASS=<your_sadmin_password>
ALERT_EMAIL=dba@example.com
SIEBEL_LOG_DIR=/siebel/log
WEB_URL=http://siebweb01/callcenter_enu/start.swe?SWECmd=GetCachedPage
DISK_THRESHOLD=80

TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
REPORT=/tmp/siebel_health_\$(date +%Y%m%d_%H%M%S).log
ALERT_TRIGGERED=0
ALERT_MSG=""

log()   { echo "[\${TIMESTAMP}] \$1" | tee -a "\${REPORT}"; }
alert() { ALERT_TRIGGERED=1; ALERT_MSG="\${ALERT_MSG}\n\$1"; log "ALERT: \$1"; }

# ----------------------------------------------------------
# 1. Gateway Name Server port check
# ----------------------------------------------------------
check_gateway() {
  log "--- Checking Gateway Name Server \${GATEWAY_HOST}:\${GATEWAY_PORT} ---"
  if nc -z -w 5 "\${GATEWAY_HOST}" "\${GATEWAY_PORT}" 2>/dev/null; then
    log "Gateway: UP"
  else
    alert "Gateway Name Server \${GATEWAY_HOST}:\${GATEWAY_PORT} is NOT reachable"
  fi
}

# ----------------------------------------------------------
# 2. Siebel Server process check
# ----------------------------------------------------------
check_siebel_process() {
  log "--- Checking Siebel Server processes ---"
  SIEBMTSH_COUNT=\$(pgrep -c siebmtsh 2>/dev/null || echo 0)
  if [ "\${SIEBMTSH_COUNT}" -gt 0 ]; then
    log "siebmtsh processes running: \${SIEBMTSH_COUNT}"
  else
    alert "No siebmtsh processes found — Siebel Server may be down"
  fi

  SIEBSVC_COUNT=\$(pgrep -c siebsvc 2>/dev/null || echo 0)
  log "siebsvc (Siebel Service) processes: \${SIEBSVC_COUNT}"
}

# ----------------------------------------------------------
# 3. Component status via srvrmgr
# ----------------------------------------------------------
check_component_status() {
  log "--- Checking component run states via srvrmgr ---"
  SRVRMGR_OUTPUT=\$(
    \${SIEBEL_ROOT}/bin/srvrmgr \
      /g "\${GATEWAY_HOST}" \
      /e "\${ENTERPRISE}" \
      /s "\${SIEBEL_SERVER}" \
      /u SADMIN \
      /p "\${SADMIN_PASS}" <<'SRVREOF'
list comp show CP_NAME, CP_DISP_RUN_STATE, CP_NUM_RUN_TASKS, CP_MAX_TASKS
exit
SRVREOF
  )

  if echo "\${SRVRMGR_OUTPUT}" | grep -q "Offline\|Shutdown\|Fatal"; then
    PROBLEM_COMPS=\$(echo "\${SRVRMGR_OUTPUT}" | grep -E "Offline|Shutdown|Fatal")
    alert "Components not in Running state:\n\${PROBLEM_COMPS}"
  else
    log "All queried components appear Running"
  fi

  # Check for tasks approaching MaxTasks
  while IFS= read -r line; do
    if echo "\${line}" | grep -qE '^[A-Za-z]'; then
      NUM=\$(echo "\${line}" | awk '{print \$3}')
      MAX=\$(echo "\${line}" | awk '{print \$4}')
      NAME=\$(echo "\${line}" | awk '{print \$1}')
      if [ -n "\${NUM}" ] && [ -n "\${MAX}" ] && [ "\${MAX}" -gt 0 ] 2>/dev/null; then
        PCT=\$(( NUM * 100 / MAX ))
        if [ "\${PCT}" -ge 85 ]; then
          alert "Component \${NAME} task utilization at \${PCT}% (\${NUM}/\${MAX})"
        fi
      fi
    fi
  done <<< "\${SRVRMGR_OUTPUT}"
}

# ----------------------------------------------------------
# 4. Log error scan (last 60 minutes)
# ----------------------------------------------------------
check_log_errors() {
  log "--- Scanning logs for errors (last 60 min) ---"
  CUTOFF=\$(date -d '60 minutes ago' '+%Y-%m-%d %H:%M:%S' 2>/dev/null \
    || date -v -60M '+%Y-%m-%d %H:%M:%S')

  ERROR_COUNT=0
  while IFS= read -r logfile; do
    ERRORS=\$(find "\${logfile}" -newer /tmp/.siebel_health_last_check 2>/dev/null \
      | xargs grep -l "ORA-\|SBL-\|FATAL\|Error\|fatal" 2>/dev/null | wc -l)
    ERROR_COUNT=\$(( ERROR_COUNT + ERRORS ))
  done < <(find "\${SIEBEL_LOG_DIR}" -name "*.log" -mmin -60 2>/dev/null)

  if [ "\${ERROR_COUNT}" -gt 0 ]; then
    SAMPLE=\$(find "\${SIEBEL_LOG_DIR}" -name "*.log" -mmin -60 \
      -exec grep -l "ORA-\|SBL-\|FATAL" {} \; 2>/dev/null | head -3)
    alert "Found \${ERROR_COUNT} log file(s) with errors in last 60 min. Sample: \${SAMPLE}"
  else
    log "Log scan: no ORA- / SBL- / FATAL errors found in last 60 min"
  fi
  touch /tmp/.siebel_health_last_check
}

# ----------------------------------------------------------
# 5. Disk space check
# ----------------------------------------------------------
check_disk_space() {
  log "--- Checking disk usage ---"
  while IFS= read -r mount; do
    USAGE=\$(df -h "\${mount}" 2>/dev/null | awk 'NR==2 {gsub(/%/,""); print \$5}')
    if [ -n "\${USAGE}" ] && [ "\${USAGE}" -ge "\${DISK_THRESHOLD}" ]; then
      alert "Disk \${mount} at \${USAGE}% — above \${DISK_THRESHOLD}% threshold"
    else
      log "Disk \${mount}: \${USAGE}% used"
    fi
  done <<< "\$(echo -e '/siebel\n/siebel/log\n/siebel/archive')"
}

# ----------------------------------------------------------
# 6. Web tier connectivity check
# ----------------------------------------------------------
check_web_tier() {
  log "--- Checking SWSE web endpoint ---"
  HTTP_CODE=\$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "\${WEB_URL}" 2>/dev/null)
  if [ "\${HTTP_CODE}" = "200" ] || [ "\${HTTP_CODE}" = "302" ]; then
    log "SWSE endpoint: HTTP \${HTTP_CODE} OK"
  else
    alert "SWSE endpoint returned HTTP \${HTTP_CODE} — web tier may be degraded"
  fi
}

# ----------------------------------------------------------
# 7. Send alert email if any check failed
# ----------------------------------------------------------
send_alert() {
  if [ "\${ALERT_TRIGGERED}" -eq 1 ]; then
    printf "Siebel Health Alert\nHost: \$(hostname)\nTime: \${TIMESTAMP}\n\nIssues detected:\n\${ALERT_MSG}\n\nFull report: \${REPORT}" \
      | mail -s "Siebel Health Alert - \$(hostname)" "\${ALERT_EMAIL}"
    log "Alert email sent to \${ALERT_EMAIL}"
  else
    log "All checks passed — no alert sent"
  fi
}

# ----------------------------------------------------------
# Main
# ----------------------------------------------------------
log "====== Siebel Health Check Start ======"
check_gateway
check_siebel_process
check_component_status
check_log_errors
check_disk_space
check_web_tier
send_alert
log "====== Siebel Health Check Complete ======"
\`\`\`

Make the script executable:

\`\`\`bash
chmod 750 /opt/scripts/siebel_health.sh
chown siebel:siebel /opt/scripts/siebel_health.sh
\`\`\`

---

## Phase 7: Crontab Configuration

Add to the \`siebel\` user crontab (\`crontab -e\` as siebel):

\`\`\`
# Siebel health check every 15 minutes
*/15 * * * * /opt/scripts/siebel_health.sh >> /siebel/log/health_cron.log 2>&1

# Daily log compression at 01:00
0 1 * * * find /siebel/log -name "*.log" -mtime +1 -exec gzip {} \\;

# Weekly archive of compressed logs on Sunday 02:00
0 2 * * 0 find /siebel/log -name "*.log.gz" -mtime +7 -exec mv {} /siebel/archive/ \\;

# Monthly database stats update (first Sunday of month, 03:00)
0 3 1-7 * 0 /opt/scripts/siebel_db_stats.sh >> /siebel/log/db_stats.log 2>&1
\`\`\`

### Supporting Script: siebel_db_stats.sh

\`\`\`bash
#!/bin/bash
# Monthly statistics update for key Siebel tables
ORACLE_HOME=/opt/oracle/product/19c/dbhome_1
export ORACLE_HOME
PATH=\${ORACLE_HOME}/bin:\${PATH}

\${ORACLE_HOME}/bin/sqlplus -s / as sysdba <<'SQLEOF'
SET SERVEROUTPUT ON
BEGIN
  FOR t IN (
    SELECT owner, table_name
    FROM   dba_tables
    WHERE  owner = 'SIEBEL'
    AND    table_name IN (
             'S_CONTACT','S_OPTY','S_ACCOUNT','S_EVT_ACT',
             'S_ORG_EXT','S_PROD_INT','S_ORDER','S_QUOTE'
           )
  ) LOOP
    DBMS_STATS.GATHER_TABLE_STATS(
      ownname   => t.owner,
      tabname   => t.table_name,
      estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,
      method_opt => 'FOR ALL COLUMNS SIZE AUTO',
      cascade   => TRUE
    );
    DBMS_OUTPUT.PUT_LINE('Stats updated: ' || t.owner || '.' || t.table_name);
  END LOOP;
END;
/
EXIT
SQLEOF
\`\`\`

---

## Phase 8: Routine Maintenance Schedule

### Weekly Tasks
- Review \`/siebel/log/siebsrvr.log\` for ORA- and SBL- errors from the past 7 days
- Run \`list tasks\` in srvrmgr and terminate any tasks older than 24 hours that are not background jobs
- Confirm nightly backups completed (RMAN or OS snapshot of Siebel binaries)
- Verify disk usage on \`/siebel\` is below 70%
- Check SWSE access logs for 5xx error spikes

\`\`\`bash
# Quick weekly log review command
grep -E "ORA-|SBL-|FATAL" /siebel/log/siebsrvr.log \
  | awk -v d="\$(date -d '7 days ago' +%Y-%m-%d)" '\$1 >= d' \
  | sort | uniq -c | sort -rn | head -20
\`\`\`

### Monthly Tasks
- Update statistics on all S_ tables with more than 1 million rows
- Review MaxTasks and MaxMTServers against peak task counts observed in health logs
- Apply any available Quick Fix Engineering (QFE) patches to Siebel Server
- Verify Oracle Database patch level matches Siebel certification matrix
- Review and purge Siebel workflow process instances older than 90 days:

\`\`\`sql
-- Review workflow instance accumulation
SELECT status_cd, COUNT(*)
FROM   siebel.s_wfa_inst
GROUP  BY status_cd
ORDER  BY 2 DESC;

-- Purge completed instances older than 90 days (use Siebel Business Service preferred)
-- Never delete directly from S_ tables without Siebel guidance
\`\`\`

### Quarterly Tasks
- Full index rebuild on high-activity tables during maintenance window:

\`\`\`sql
-- Generate rebuild DDL for Siebel indexes with high fragmentation
SELECT 'ALTER INDEX ' || owner || '.' || index_name
       || ' REBUILD ONLINE PARALLEL 4;' AS ddl
FROM   dba_indexes
WHERE  owner = 'SIEBEL'
AND    table_name IN ('S_CONTACT','S_OPTY','S_ACCOUNT','S_EVT_ACT')
ORDER  BY table_name, index_name;
\`\`\`

- Review and archive Siebel application log files older than 90 days
- Test DR failover procedure (Gateway Name Server recovery)
- Review user license utilization vs active Siebel named users

---

## Troubleshooting Quick Reference

### Component Won't Start
1. Check \`/siebel/log/siebsrvr.log\` for the startup error
2. Verify Gateway is reachable: \`nc -z siebgw01 2320\`
3. Verify DB connect: \`sqlplus SADMIN/<pass>@siebeldb\`
4. Run \`list comp show CP_NAME, CP_DISP_RUN_STATE, CP_STARTMODE\` — confirm startmode is Auto

### High Task Count / Users Can't Log In
\`\`\`
srvrmgr> list tasks show TK_TASKID, TK_TASKNO, TK_START_DT, TK_DISP_RUNSTATE, TK_COMP_ALIAS
\`\`\`
Look for tasks running more than 4 hours. Kill stale tasks:
\`\`\`
srvrmgr> stop task for comp SiebelCallCenter_1 taskid <id>
\`\`\`

### ORA-00257 Archiver Stuck
Siebel stops writing to the database when archive log space fills. On the DB host:
\`\`\`bash
# Check archive log destination usage
sqlplus / as sysdba
SQL> SELECT dest_name, space_used, space_limit, space_reclaimable FROM v$flash_recovery_area_usage;
SQL> DELETE ARCHIVELOG ALL COMPLETED BEFORE 'SYSDATE-3';
\`\`\`

### SWSE Returns 503
1. Confirm Siebel Server AOM components are in Running state via srvrmgr
2. Verify \`eapps.cfg\` ConnectString host and port are correct
3. Check SWSE error log in the web server error log directory
4. Restart SWSE: \`apachectl restart\` or \`iisreset\`

### Slow Performance
1. Check S_ table statistics age: \`SELECT last_analyzed FROM dba_tables WHERE owner='SIEBEL' AND table_name='S_CONTACT'\`
2. Check SHARED_POOL_SIZE — Siebel heavily uses the shared pool for parsed cursors
3. Check MaxMTServers — too few MT servers creates a queuing bottleneck
4. Run AWR report during the slow period and look for top SQL against SIEBEL schema

---

## Summary

A healthy Siebel CRM environment rests on three pillars: Gateway Name Server availability, AOM component pool headroom, and current database statistics. The health script in Phase 6 covers all three automatically every 15 minutes. Keep the cron log monitored, rotate Siebel logs weekly, and treat any ORA- error in siebsrvr.log as a production incident until proven otherwise.`,
};

async function main() {
  await db
    .insert(posts)
    .values(post)
    .onConflictDoUpdate({
      target: posts.slug,
      set: { title: post.title, content: post.content, excerpt: post.excerpt, updatedAt: new Date() },
    });
  console.log('Inserted:', post.slug);
}

main().catch(console.error);
