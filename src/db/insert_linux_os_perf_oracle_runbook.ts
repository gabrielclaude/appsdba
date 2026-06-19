import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Linux OS Performance Monitoring for Oracle DBA: Complete Setup Runbook',
  slug: 'linux-os-performance-oracle-dba-runbook',
  excerpt:
    'Step-by-step runbook to deploy the full Oracle DBA Linux host monitoring stack: script installation, permissions, crontab configuration, log directory setup, alert email testing, and a structured troubleshooting guide for CPU, memory, I/O, and Oracle process incidents.',
  category: 'linux-admin' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-19'),
  youtubeUrl: null,
  content: `## Phase 1 — Pre-Deployment Checklist

Before installing any monitoring scripts, confirm the host meets the prerequisites.

### 1.1 Required Packages

\`\`\`bash
# RHEL / OL 7, 8, 9
rpm -q sysstat procps-ng util-linux mailx || yum install -y sysstat procps-ng util-linux mailx

# Verify key tools are available
for cmd in mpstat iostat vmstat sar pidstat ss lsblk awk grep pgrep; do
  which \${cmd} &>/dev/null && echo "OK: \${cmd}" || echo "MISSING: \${cmd}"
done
\`\`\`

### 1.2 Mail Relay

The monitoring scripts send email via the system \`mail\` command. Confirm SMTP is working:

\`\`\`bash
# Test mail relay
echo "Test alert from $(hostname) at $(date)" | mail -s "Oracle Monitor Test" dba-alerts@example.com

# If mail is not configured, install and configure postfix
yum install -y postfix
systemctl enable --now postfix
postconf -e "relayhost = [smtp.example.com]:587"
systemctl restart postfix
\`\`\`

### 1.3 Confirm Oracle Environment Variables

\`\`\`bash
# Verify as oracle user
sudo -u oracle bash -c 'echo "SID=\${ORACLE_SID} HOME=\${ORACLE_HOME} BASE=\${ORACLE_BASE}"'

# If empty, add to oracle user profile:
grep -q ORACLE_SID /home/oracle/.bash_profile || cat >> /home/oracle/.bash_profile <<'PROFILE'
export ORACLE_SID=PROD
export ORACLE_HOME=/u01/app/oracle/product/19c/dbhome_1
export ORACLE_BASE=/u01/app/oracle
export PATH=\${ORACLE_HOME}/bin:\${PATH}
PROFILE
\`\`\`

---

## Phase 2 — Directory and Script Installation

### 2.1 Create Directory Structure

\`\`\`bash
# Run as root
mkdir -p /opt/oracle/scripts
mkdir -p /var/log/oracle-monitor/snapshots
chown -R oracle:oinstall /opt/oracle/scripts
chown -R oracle:oinstall /var/log/oracle-monitor
chmod 750 /opt/oracle/scripts
chmod 755 /var/log/oracle-monitor
chmod 755 /var/log/oracle-monitor/snapshots
\`\`\`

### 2.2 Install Monitoring Scripts

Copy each script from the blog post into the following paths and set permissions:

| Script | Path | Purpose |
|--------|------|---------|
| monitor_cpu.sh | /opt/oracle/scripts/monitor_cpu.sh | CPU, iowait, steal, load |
| monitor_memory.sh | /opt/oracle/scripts/monitor_memory.sh | RAM, swap, HugePages |
| monitor_io.sh | /opt/oracle/scripts/monitor_io.sh | Disk IOPS, latency, util |
| monitor_oracle_procs.sh | /opt/oracle/scripts/monitor_oracle_procs.sh | BG process health |
| perf_snapshot.sh | /opt/oracle/scripts/perf_snapshot.sh | 15-min baseline record |

\`\`\`bash
# After creating each script file:
chmod 750 /opt/oracle/scripts/*.sh
chown oracle:oinstall /opt/oracle/scripts/*.sh

# Verify
ls -l /opt/oracle/scripts/
\`\`\`

### 2.3 Customise Alert Thresholds

Edit the threshold variables at the top of each script to match the environment:

\`\`\`bash
# Example: lower iowait threshold for an NVMe-backed host
sed -i 's/CPU_IOWAIT_WARN=10/CPU_IOWAIT_WARN=5/' /opt/oracle/scripts/monitor_cpu.sh
sed -i 's/CPU_IOWAIT_CRIT=25/CPU_IOWAIT_CRIT=15/' /opt/oracle/scripts/monitor_cpu.sh
sed -i 's/AWAIT_WARN_MS=10/AWAIT_WARN_MS=2/' /opt/oracle/scripts/monitor_io.sh
sed -i 's/AWAIT_CRIT_MS=30/AWAIT_CRIT_MS=5/' /opt/oracle/scripts/monitor_io.sh

# Update alert email address in all scripts
sed -i 's/dba-alerts@example.com/your-team@company.com/g' /opt/oracle/scripts/*.sh

# Update ORACLE_SID in all scripts
sed -i "s/ORACLE_SID:-PROD/ORACLE_SID:-\${ORACLE_SID}/" /opt/oracle/scripts/*.sh
\`\`\`

---

## Phase 3 — Smoke Test Each Script

Run each script manually before scheduling it. Verify: no errors in output, log file created, email sent if thresholds exceeded.

\`\`\`bash
# Run as oracle user
sudo -u oracle ORACLE_SID=PROD /opt/oracle/scripts/monitor_cpu.sh
sudo -u oracle ORACLE_SID=PROD /opt/oracle/scripts/monitor_memory.sh
sudo -u oracle ORACLE_SID=PROD /opt/oracle/scripts/monitor_io.sh
sudo -u oracle ORACLE_SID=PROD /opt/oracle/scripts/monitor_oracle_procs.sh
sudo -u oracle ORACLE_SID=PROD /opt/oracle/scripts/perf_snapshot.sh

# Verify log files created
ls -lh /var/log/oracle-monitor/
ls -lh /var/log/oracle-monitor/snapshots/
\`\`\`

Expected log file names (today's date):

\`\`\`
/var/log/oracle-monitor/cpu_20260619.log
/var/log/oracle-monitor/memory_20260619.log
/var/log/oracle-monitor/io_20260619.log
/var/log/oracle-monitor/oracle_procs_20260619.log
/var/log/oracle-monitor/snapshots/perf_20260619.log
\`\`\`

### 3.1 Force an Alert to Test Email

Temporarily lower a threshold to trigger an alert without waiting for a real event:

\`\`\`bash
# Force a CPU alert by setting iowait warn threshold to 0
ORACLE_SID=PROD CPU_IOWAIT_WARN=0 /opt/oracle/scripts/monitor_cpu.sh

# Check that email arrived
# Restore threshold after test — use the sed commands from Phase 2.3
\`\`\`

---

## Phase 4 — Crontab Installation

### 4.1 Install the Crontab

\`\`\`bash
# Switch to oracle user and edit crontab
sudo -u oracle crontab -e
\`\`\`

Paste the full crontab block (from the blog post), replacing \`PROD\` with the correct SID and updating paths as needed. After saving:

\`\`\`bash
# Verify crontab was saved
sudo -u oracle crontab -l

# Confirm crond is running
systemctl status crond || systemctl status cron
\`\`\`

### 4.2 Verify First Scheduled Run

\`\`\`bash
# Watch cron log for the first execution at the next 5-minute mark
tail -f /var/log/cron | grep oracle

# Or watch the monitor cron log
tail -f /var/log/oracle-monitor/cron.log
\`\`\`

### 4.3 RAC: Deploy on All Nodes

For RAC environments, repeat Phases 2–4 on every node. Each node monitors its own host; aggregate alerts at the email level or via a centralised log collector.

\`\`\`bash
# Copy scripts to node 2
scp -r /opt/oracle/scripts/ oracle@node2:/opt/oracle/
ssh oracle@node2 'chmod 750 /opt/oracle/scripts/*.sh'

# Install crontab on node 2
ssh oracle@node2 'crontab -e'
\`\`\`

---

## Phase 5 — Log Rotation Configuration

The crontab includes inline log rotation, but for production hosts configure logrotate as well:

\`\`\`bash
cat > /etc/logrotate.d/oracle-monitor <<'LOGROTATE'
/var/log/oracle-monitor/*.log {
    daily
    missingok
    rotate 30
    compress
    delaycompress
    notifempty
    create 0644 oracle oinstall
    sharedscripts
    postrotate
        find /var/log/oracle-monitor -name "*.log" -mtime +30 -delete
    endscript
}

/var/log/oracle-monitor/snapshots/*.log {
    daily
    missingok
    rotate 90
    compress
    delaycompress
    notifempty
    create 0644 oracle oinstall
}
LOGROTATE

# Test logrotate config
logrotate -d /etc/logrotate.d/oracle-monitor
\`\`\`

---

## Phase 6 — Performance Baseline

After 48–72 hours of data collection, establish a performance baseline. The baseline defines normal operating ranges that separate expected behaviour from anomalies.

### 6.1 Extract CPU Baseline from Snapshots

\`\`\`bash
# Average and peak iowait for the past 48 hours of snapshots
awk -F'|' '
  /cpu_iowait/ {
    for(i=1;i<=NF;i++) {
      if($i~/cpu_iowait/) {
        split($i,a,"="); gsub(/%/,"",a[2]);
        sum+=a[2]+0; count++
        if(a[2]+0>peak) peak=a[2]
      }
    }
  }
  END { printf "avg_iowait=%.1f%%  peak_iowait=%.1f%%  samples=%d\n", sum/count, peak, count }
' /var/log/oracle-monitor/snapshots/perf_*.log
\`\`\`

### 6.2 Extract Memory Baseline

\`\`\`bash
# Minimum MemAvailable seen over snapshot period (closest to OOM risk)
awk -F'|' '
  /mem_avail_mb/ {
    for(i=1;i<=NF;i++) {
      if($i~/mem_avail_mb/) {
        split($i,a,"=");
        if(min=="" || a[2]+0 < min+0) { min=a[2]; ts=$1 }
      }
    }
  }
  END { print "min_mem_avail_mb=" min " at " ts }
' /var/log/oracle-monitor/snapshots/perf_*.log
\`\`\`

### 6.3 Tune Thresholds Based on Baseline

After reviewing the baseline, update thresholds to reflect the environment's normal operating range. Thresholds set too low generate noise; set too high they miss real events. A good starting point is: warn at mean + 2σ, critical at mean + 4σ.

\`\`\`bash
# Example: set iowait warn to baseline_avg + 5%, crit to baseline_avg + 15%
# If baseline avg is 3%, set warn=8%, crit=18%
sed -i 's/CPU_IOWAIT_WARN=[0-9]*/CPU_IOWAIT_WARN=8/' /opt/oracle/scripts/monitor_cpu.sh
sed -i 's/CPU_IOWAIT_CRIT=[0-9]*/CPU_IOWAIT_CRIT=18/' /opt/oracle/scripts/monitor_cpu.sh
\`\`\`

---

## Phase 7 — Incident Response Procedures

### 7.1 CPU Incident

**Alert received**: \`CPU Alert: cpu_iowait=28% (CRITICAL threshold=25%)\`

\`\`\`bash
# Step 1: confirm current CPU state
mpstat -P ALL 1 5

# Step 2: identify top consumers
ps -eo pid,comm,%cpu,%mem --sort=-%cpu | head -20

# Step 3: check if Oracle is driving the I/O
iostat -xdm 1 5
sar -q 1 5  # run queue and load

# Step 4: map OS PID to Oracle session (run as oracle user)
export ORACLE_SID=PROD
export ORACLE_HOME=/u01/app/oracle/product/19c/dbhome_1
TOP_PID=$(ps -eo pid,%cpu --sort=-%cpu | grep -v PID | head -2 | tail -1 | awk '{print $1}')

sqlplus -s / as sysdba <<EOF
SELECT s.sid, s.serial#, s.username, s.sql_id, s.event, s.state
FROM   v\$session s
JOIN   v\$process p ON p.addr = s.paddr
WHERE  p.spid = '\${TOP_PID}';
EOF

# Step 5: get the SQL
sqlplus -s / as sysdba <<'EOF'
SELECT s.sql_id, s.sql_text
FROM   v\$sql s
WHERE  s.sql_id = '&sql_id'
FETCH FIRST 1 ROWS ONLY;
EOF
\`\`\`

### 7.2 Memory / Swap Incident

**Alert received**: \`Swap used=1024MB — Oracle SGA may be paging\`

\`\`\`bash
# Step 1: confirm current memory state
free -h
cat /proc/meminfo | grep -E 'MemTotal|MemAvailable|SwapTotal|SwapFree|HugePages'

# Step 2: identify which processes are swapped
for pid in $(pgrep -f "oracle\${ORACLE_SID}"); do
  swap=$(awk '/VmSwap/{print $2}' /proc/\${pid}/status 2>/dev/null)
  comm=$(awk '/Name/{print $2}' /proc/\${pid}/status 2>/dev/null)
  [ "\${swap:-0}" -gt 0 ] && echo "PID=\${pid} NAME=\${comm} SWAP=\${swap}kB"
done

# Step 3: check if SGA is correctly using HugePages
sqlplus -s / as sysdba <<'EOF'
SELECT component, current_size/1024/1024 AS mb
FROM   v\$memory_current_resize_ops
ORDER  BY mb DESC
FETCH FIRST 5 ROWS ONLY;

-- Check large pool, java pool, etc.
SELECT name, bytes/1024/1024 AS mb
FROM   v\$sgainfo
ORDER  BY bytes DESC;
EOF

# Step 4: emergency swap relief (last resort — requires root)
# swapoff -a  -- only if memory is not under pressure
# swapon -a
\`\`\`

### 7.3 I/O Incident

**Alert received**: \`IO [sdb]: await=45ms CRITICAL (threshold=30ms)\`

\`\`\`bash
# Step 1: current I/O state
iostat -xdm 1 10
lsblk -o NAME,TYPE,SIZE,ROTA,SCHED,MODEL

# Step 2: check I/O scheduler
cat /sys/block/sdb/queue/scheduler
cat /sys/block/sdb/queue/nr_requests  # queue depth

# Step 3: identify Oracle datafiles on the slow device
df -h | grep sdb
ls -la /dev/disk/by-path/ | grep sdb

# Step 4: find Oracle files on that mount
export ORACLE_SID=PROD
sqlplus -s / as sysdba <<'EOF'
-- Datafiles on mount point /data (adjust as needed)
SELECT file#, name, bytes/1024/1024 AS mb, status
FROM   v\$datafile
WHERE  name LIKE '/data/%'
ORDER  BY bytes DESC;

-- Current I/O waits on those files
SELECT f.file#, f.name, s.event, COUNT(*) AS sessions
FROM   v\$session s
JOIN   v\$datafile f ON f.file# = s.p1
WHERE  s.wait_class = 'User I/O'
GROUP  BY f.file#, f.name, s.event
ORDER  BY sessions DESC;
EOF

# Step 5: check for I/O scheduler tuning opportunity
echo "Current nr_requests: $(cat /sys/block/sdb/queue/nr_requests)"
echo "Current scheduler: $(cat /sys/block/sdb/queue/scheduler)"
# For SSD: set to none; for HDD: set to deadline
echo none > /sys/block/sdb/queue/scheduler
echo 256 > /sys/block/sdb/queue/nr_requests
\`\`\`

### 7.4 Oracle Process Missing

**Alert received**: \`MISSING background process: ora_lgwr_PROD\`

\`\`\`bash
# Step 1: check all Oracle processes
ps -ef | grep "ora_.*\${ORACLE_SID}" | grep -v grep

# Step 2: check alert log for the crash
ALERT_LOG=$(find /u01/app/oracle/diag -name "alert_\${ORACLE_SID}.log" 2>/dev/null | head -1)
tail -100 "\${ALERT_LOG}"

# Step 3: check for ORA- errors in trace directory
find /u01/app/oracle/diag -name "*.trc" -newer /proc/1/cmdline 2>/dev/null | \
  xargs grep -l "ORA-" 2>/dev/null | head -5

# Step 4: if instance crashed, assess for restart
sqlplus / as sysdba <<'EOF'
STARTUP
EOF

# Step 5: after restart, verify all BG processes
for proc in pmon smon lgwr dbw0 ckpt mmon reco arch; do
  pgrep -f "ora_\${proc}_\${ORACLE_SID}" > /dev/null \
    && echo "RUNNING: ora_\${proc}_\${ORACLE_SID}" \
    || echo "MISSING: ora_\${proc}_\${ORACLE_SID}"
done
\`\`\`

---

## Phase 8 — Weekly Review Process

Run the following review every week to ensure monitoring is healthy and thresholds remain appropriate.

\`\`\`bash
#!/bin/bash
# /opt/oracle/scripts/weekly_review.sh
# Run manually or schedule Sunday 6 AM

ORACLE_SID=\${ORACLE_SID:-PROD}
LOG_DIR=/var/log/oracle-monitor
SNAP_DIR=\${LOG_DIR}/snapshots
REPORT_FILE=\${LOG_DIR}/weekly_review_$(date +%Y%m%d).txt
ALERT_EMAIL=dba-alerts@example.com

{
echo "======================================="
echo " Oracle Host Weekly Review"
echo " Host:  $(hostname)"
echo " SID:   \${ORACLE_SID}"
echo " Date:  $(date)"
echo "======================================="

echo ""
echo "--- CPU Summary (past 7 days) ---"
awk -F'|' '
  /cpu_iowait/ {
    for(i=1;i<=NF;i++) {
      if($i~/cpu_iowait/){split($i,a,"=");gsub(/%/,"",a[2]);
        sum+=a[2]+0; count++; if(a[2]+0>peak) {peak=a[2]; ptime=$1}}
    }
  }
  END {printf "  avg_iowait=%.1f%%  peak_iowait=%.1f%% (at %s)  samples=%d\n", sum/count, peak, ptime, count}
' \${SNAP_DIR}/perf_*.log 2>/dev/null

echo ""
echo "--- Memory Summary (past 7 days) ---"
awk -F'|' '
  /mem_avail_mb/ {
    for(i=1;i<=NF;i++){
      if($i~/mem_avail_mb/){split($i,a,"=");
        sum+=a[2]+0; count++; if(min==""||a[2]+0<min+0){min=a[2];mtime=$1}}
    }
  }
  /swap_used_mb/ {
    for(i=1;i<=NF;i++){
      if($i~/swap_used_mb/){split($i,a,"=");
        if(a[2]+0>maxswap+0)maxswap=a[2]}
    }
  }
  END {printf "  avg_mem_avail=%.0fMB  min_mem_avail=%sMB (at %s)\n  peak_swap_used=%sMB\n", sum/count, min, mtime, maxswap}
' \${SNAP_DIR}/perf_*.log 2>/dev/null

echo ""
echo "--- Alert Count by Script (past 7 days) ---"
for f in \${LOG_DIR}/cpu_*.log \${LOG_DIR}/memory_*.log \${LOG_DIR}/io_*.log \${LOG_DIR}/oracle_procs_*.log; do
  [ -f "\${f}" ] && echo "  $(basename \${f}): $(grep -c ALERT \${f} 2>/dev/null || echo 0) alerts"
done

echo ""
echo "--- Crontab Status ---"
sudo -u oracle crontab -l 2>/dev/null | grep -v '^#' | grep -v '^$'

echo ""
echo "--- Log File Sizes ---"
du -sh \${LOG_DIR}/* 2>/dev/null

echo ""
echo "--- Disk Space on Monitor Log Filesystem ---"
df -h \${LOG_DIR}

echo ""
echo "--- Oracle Instance Status ---"
export ORACLE_HOME=/u01/app/oracle/product/19c/dbhome_1
export PATH=\${ORACLE_HOME}/bin:\${PATH}
sqlplus -s / as sysdba <<'EOF' 2>/dev/null
SET PAGESIZE 20 LINESIZE 100
SELECT instance_name, status, version, startup_time,
       host_name, database_status
FROM   v\$instance;
EOF

} | tee "\${REPORT_FILE}"

mail -s "Oracle Host Weekly Review: $(hostname) [\${ORACLE_SID}]" "\${ALERT_EMAIL}" < "\${REPORT_FILE}"
echo "Weekly review sent to \${ALERT_EMAIL} — saved to \${REPORT_FILE}"
\`\`\`

\`\`\`
# Add to crontab for automated weekly run
0 6 * * 0  ORACLE_SID=PROD /opt/oracle/scripts/weekly_review.sh >> /var/log/oracle-monitor/cron.log 2>&1
\`\`\`

---

## Phase 9 — Maintenance and Troubleshooting

### Script Not Running

\`\`\`bash
# Check cron daemon
systemctl status crond

# Check that oracle user's crontab has the entries
sudo -u oracle crontab -l

# Check cron log for errors
grep oracle /var/log/cron | tail -20

# Run the script manually with full debug output
sudo -u oracle bash -x /opt/oracle/scripts/monitor_cpu.sh 2>&1 | head -50
\`\`\`

### No Email Received

\`\`\`bash
# Check mail queue
mailq

# Check postfix log
tail -20 /var/log/maillog

# Test mail directly
echo "test" | mail -s "test" dba-alerts@example.com

# Check that threshold was actually breached
grep ALERT /var/log/oracle-monitor/cpu_$(date +%Y%m%d).log | tail -5
\`\`\`

### Log Files Not Created

\`\`\`bash
# Check permissions
ls -la /var/log/oracle-monitor/
ls -la /opt/oracle/scripts/

# Check that oracle user can write to log dir
sudo -u oracle touch /var/log/oracle-monitor/test && echo "Write OK" && sudo -u oracle rm /var/log/oracle-monitor/test
\`\`\`

### I/O Script Reports No Devices

\`\`\`bash
# List block devices as oracle user
lsblk -dno NAME
cat /proc/diskstats | awk '{print $4}' | sort -u

# Verify the device regex in monitor_io.sh matches your device names
# NVMe: nvme0n1, nvme1n1
# SAN: sda, sdb
# XEN/KVM: xvda, vda
# Update the grep pattern in monitor_io.sh accordingly
\`\`\`

---

## Quick Reference Card

| Symptom | First command | Oracle correlation |
|---------|--------------|-------------------|
| DB slow, no obvious wait | \`mpstat -P ALL 1 5\` | CPU steal or iowait |
| High DB CPU in AWR | \`ps --sort=-%cpu\` + \`pidstat\` | Map PID to session |
| Buffer cache miss spike | \`iostat -xdm 1 5\` | I/O await + v$session wait_class |
| ORA-04031 shared pool | \`cat /proc/meminfo\` | MemAvailable low |
| RAC GC waits | \`ip -s link\` on private NIC | Packet errors/drops |
| Slow full table scans | \`iostat avgqu-sz\` | I/O queue depth |
| Random OOM kills | \`dmesg | grep -i oom\` | SGA over-allocated |
| Listener connection delay | \`ss -tnp | grep 1521\` | Connection queue backlog |`,
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
