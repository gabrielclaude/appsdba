import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Investigating and Resolving Oracle Database Hang from Swap Exhaustion on Linux and GCP',
  slug: 'oracle-linux-swap-memory-runbook',
  excerpt:
    'Step-by-step runbook for triaging a hung Oracle Database caused by swap exhaustion — OS swap scan, NUMA imbalance check, Oracle V$ wait event analysis, GCP disk throttle correlation, HugePages configuration, kernel parameter hardening, and six crontab-scheduled monitoring scripts that detect recurrence before it causes another outage.',
  category: 'oracle-google-cloud' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-22'),
  youtubeUrl: null,
  content: `## Overview

This runbook covers the complete procedure for investigating and resolving an Oracle Database hang caused by swap space exhaustion on a Linux host. It applies to Oracle Database 19c on Oracle Linux 8/9 or RHEL 8/9, including instances running on Google Cloud Platform (GCP) Compute Engine with Persistent Disk or Hyperdisk storage. The runbook ends with six monitoring scripts deployed via crontab that detect the conditions leading to this class of outage before they cause a hang.

Assumptions: root or sudo access on the database server, Oracle DBA access (SYSDBA), ADRCI available on the database host, and (for GCP instances) the Google Cloud CLI installed on the host or accessible from a jump server.

---

## Phase 0: Emergency Triage

Run these steps immediately if the database is currently unresponsive.

### Step 0.1 — Check for OOM Killer Intervention

\`\`\`bash
# Check if any Oracle process was killed by the Linux OOM Killer
dmesg -T | grep -iE 'oom|kill' | tail -30

# On systems using journald
journalctl -k --since "2 hours ago" | grep -iE 'oom|killed'
\`\`\`

If output shows an Oracle process (e.g., \`oracle_pmon_DBNAME\`, \`oracle_lgwr_DBNAME\`) was killed, the OOM Killer fired. The database instance is dead and needs a clean restart. Do not attempt to recover a partially running instance — proceed to Step 0.4.

### Step 0.2 — Check the Oracle Alert Log

\`\`\`bash
# Source the Oracle environment first
. /home/oracle/.bash_profile   # or equivalent env script

# Open alert log in ADRCI
adrci <<'EOF'
show alert -tail 100
EXIT
EOF
\`\`\`

Look for any of these errors in the minutes before the hang:
- \`ORA-04030: out of process memory when trying to allocate\`
- \`ORA-04031: unable to allocate N bytes of shared memory\`
- \`ORA-27102: out of memory\`
- \`LGWR: terminating instance due to error\`

Record the exact timestamp of the first error — this is your anchor point for correlating OS and GCP metrics.

### Step 0.3 — Attempt Memory Reclamation

If the OS is still responsive (terminal commands return, even slowly):

\`\`\`bash
# Drop page cache, dentry cache, and inode cache (safe — OS rebuilds them on demand)
sync; echo 3 > /proc/sys/vm/drop_caches

# Check if swap has reduced after drop_caches
free -m
\`\`\`

This sometimes gives the OS enough breathing room to allow Oracle to respond to a shutdown command.

### Step 0.4 — Shut Down the Database Instance

\`\`\`bash
sqlplus / as sysdba <<'EOF'
SHUTDOWN IMMEDIATE;
EXIT
EOF
\`\`\`

If \`SHUTDOWN IMMEDIATE\` hangs (> 3 minutes with no response), use abort:

\`\`\`bash
sqlplus / as sysdba <<'EOF'
SHUTDOWN ABORT;
EXIT
EOF
\`\`\`

After \`SHUTDOWN ABORT\`, the next \`STARTUP\` will perform instance recovery automatically — this is safe.

### Step 0.5 — Free Swap Before Restarting

Restarting Oracle with swap still 100% full risks an immediate re-hang. Clear swap first:

\`\`\`bash
# Verify current swap state
swapon --show
free -m

# Turn swap off and back on to flush swap to RAM
# Only do this if free -m shows enough free RAM to absorb the swap contents
swapoff -a
swapon -a

# Verify swap is now empty
free -m
\`\`\`

If \`free -m\` does not show enough free RAM to absorb the current swap contents, do not run \`swapoff\` — the OOM Killer will fire again. In this case, reboot the server to clear all state, then investigate post-restart.

---

## Phase 1: OS Memory Investigation

### Step 1.1 — Identify Top Memory Consumers

\`\`\`bash
# Top 10 processes by physical memory usage
ps aux --sort=-%mem | head -n 11

# Top 10 processes by virtual memory size
ps aux --sort=-%vsz | head -n 11
\`\`\`

### Step 1.2 — Identify Which Processes Own Swap

\`\`\`bash
# Show all processes with their swap usage (VmSwap), sorted descending
for file in /proc/[0-9]*/status; do
  awk '/Name|Pid|VmSwap/ {printf $0 " "}; END {print ""}' "\$file" 2>/dev/null
done | grep -v " VmSwap:       0 kB" | sort -k 3 -n -r | head -n 15
\`\`\`

If Oracle processes (identified by name \`oracle\` or the specific SID process names) appear at the top with large VmSwap values (> 1 GB), the Oracle SGA or PGA memory was pushed to disk.

### Step 1.3 — Check HugePages Status

\`\`\`bash
grep -i huge /proc/meminfo
\`\`\`

Key values to examine:

| Field | What It Means |
|-------|--------------|
| \`HugePages_Total\` | Number of 2MB HugePages allocated to the OS |
| \`HugePages_Free\` | HugePages not yet claimed by any process |
| \`HugePages_Rsvd\` | Reserved by Oracle but not yet faulted in |
| \`AnonHugePages\` | Transparent HugePages in use (should be 0 on Oracle servers) |

If \`HugePages_Total\` is 0, Oracle SGA is using standard 4KB pages and is eligible for swapping. This is the most common root cause.

### Step 1.4 — Check NUMA Node Balance

\`\`\`bash
# Show memory balance across NUMA nodes (columnar output)
numastat -cm

# Show which processes are bound to which NUMA node
numastat -p $(pgrep -d, -x oracle)
\`\`\`

If the "Free" row in \`numastat -cm\` shows near 0 MB on one node while another node shows thousands of MB free, you have confirmed a NUMA starvation event. The Oracle SGA was allocated primarily on the exhausted node.

### Step 1.5 — Check Current Kernel Parameters

\`\`\`bash
# Check the three parameters that matter for this class of issue
sysctl vm.swappiness
sysctl vm.zone_reclaim_mode
sysctl vm.nr_hugepages

# Compare against recommended values:
# vm.swappiness        = 1
# vm.zone_reclaim_mode = 0
# vm.nr_hugepages      >= (SGA_MAX_SIZE / 2097152) + 10% buffer
\`\`\`

---

## Phase 2: Oracle Memory Investigation

### Step 2.1 — Check SGA vs. Available RAM

\`\`\`sql
-- Current SGA allocation
SELECT
  name,
  ROUND(bytes/1024/1024/1024, 2) size_gb
FROM v$sgainfo
WHERE name IN (
  'Maximum SGA Size',
  'Fixed SGA Size',
  'Redo Buffers',
  'Buffer Cache Size',
  'Shared Pool Size',
  'Large Pool Size'
)
ORDER BY bytes DESC;

-- Compare against OS total RAM
-- (Also run: free -m on the OS to get total RAM in MB)
\`\`\`

The SGA should not exceed 70% of total physical RAM. Leave at least 20% for the OS and 10% for Oracle PGA overhead.

### Step 2.2 — Check PGA Over-Allocation

\`\`\`sql
SELECT
  name,
  ROUND(value/1024/1024, 1) "MB"
FROM v$pgastat
WHERE name IN (
  'aggregate PGA target parameter',
  'aggregate PGA auto target',
  'total PGA allocated',
  'maximum PGA allocated',
  'total PGA used for auto workareas'
);
\`\`\`

If \`maximum PGA allocated\` substantially exceeds \`aggregate PGA target parameter\`, sessions have exceeded their PGA budget. Check which sessions consumed the most PGA:

\`\`\`sql
-- Top 10 sessions by current PGA allocation
SELECT
  s.sid,
  s.serial#,
  s.username,
  s.program,
  s.module,
  ROUND(st.value/1024/1024, 1) pga_mb
FROM v$sesstat st
JOIN v$statname sn ON st.statistic# = sn.statistic#
JOIN v$session s ON st.sid = s.sid
WHERE sn.name = 'session pga memory'
  AND s.username IS NOT NULL
ORDER BY st.value DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

### Step 2.3 — Check Wait Events at the Time of the Hang

\`\`\`sql
-- Top wait events since instance startup (or from AWR if restart wiped v$ stats)
SELECT
  event,
  total_waits,
  ROUND(time_waited_micro/1000000, 1) "Total Wait (sec)",
  ROUND(average_wait * 10, 2) "Avg Wait (ms)",
  wait_class
FROM v$system_event
WHERE wait_class NOT IN ('Idle', 'User I/O')
ORDER BY time_waited_micro DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

High \`log file parallel write\` or \`db file parallel write\` alongside the memory event indicates that the swap storm saturated the I/O path, degrading LGWR and DBWR simultaneously.

---

## Phase 3: GCP Storage Investigation

### Step 3.1 — Check iostat During Load

Run this during a period of elevated activity (or replay from a monitoring tool):

\`\`\`bash
# Sample every 1 second, 30 samples
iostat -xmt 1 30 | tee /tmp/iostat_sample_$(date +%Y%m%d_%H%M).txt
\`\`\`

For each disk device hosting Oracle files (redo logs, datafiles):

| Metric | Concerning Threshold |
|--------|---------------------|
| \`w_await\` | > 5 ms on redo log device; > 15 ms on datafile device |
| \`aqu-sz\` | > 1 and rising |
| \`%util\` | > 90% |

### Step 3.2 — Query GCP Disk Throttle Metrics via CLI

\`\`\`bash
# Identify your instance and zone
INSTANCE="db-server-01"
ZONE="us-central1-a"
PROJECT="my-project-id"

# Check throttled write bytes over the last 2 hours
gcloud monitoring metrics list \
  --filter="metric.type=compute.googleapis.com/instance/disk/throttled_write_bytes_count" \
  --project=\${PROJECT}

# Pull time series for throttled writes during the incident window
gcloud monitoring read \
  "metric.type=\"compute.googleapis.com/instance/disk/throttled_write_bytes_count\"
   resource.labels.instance_id=\"\${INSTANCE}\"" \
  --start="2026-06-22T01:00:00Z" \
  --end="2026-06-22T04:00:00Z" \
  --project=\${PROJECT}
\`\`\`

Any non-zero value for throttled write bytes during the Oracle hang window confirms GCP was hard-capping your disk I/O.

### Step 3.3 — Check Current Disk Type and Size

\`\`\`bash
# List disks attached to the instance
gcloud compute disks list --filter="users~\${INSTANCE}" --project=\${PROJECT}

# Describe specific disk to see type and size
gcloud compute disks describe DISK_NAME --zone=\${ZONE} --project=\${PROJECT} \
  --format="yaml(type,sizeGb,status)"
\`\`\`

GCP \`pd-ssd\` IOPS = min(30 * disk_size_gb, machine_type_limit). If your disk is too small for your Oracle workload, buying a larger disk (even with excess space) is the correct resolution.

---

## Phase 4: Remediation

### Step 4.1 — Set Kernel Parameters Immediately (Temporary)

\`\`\`bash
# Apply immediately without reboot
sysctl -w vm.swappiness=1
sysctl -w vm.zone_reclaim_mode=0

# Verify
sysctl vm.swappiness vm.zone_reclaim_mode
\`\`\`

### Step 4.2 — Make Kernel Parameters Permanent

\`\`\`bash
# Add to /etc/sysctl.d/99-oracle-db.conf (preferred over /etc/sysctl.conf on RHEL 8/9)
cat > /etc/sysctl.d/99-oracle-db.conf <<'EOF'
# Oracle Database kernel tuning
vm.swappiness = 1
vm.zone_reclaim_mode = 0
EOF

sysctl --system
# Verify the new file is active
sysctl -a 2>/dev/null | grep -E 'swappiness|zone_reclaim'
\`\`\`

### Step 4.3 — Disable Transparent HugePages

\`\`\`bash
# Check current THP state
cat /sys/kernel/mm/transparent_hugepage/enabled
# If output shows [always] or [madvise], THP is active — disable it

# Disable immediately
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# Make permanent via GRUB (RHEL/OL 8/9)
grubby --update-kernel=ALL \
  --args="transparent_hugepage=never"

# Verify after reboot
cat /sys/kernel/mm/transparent_hugepage/enabled
# Expected output: always madvise [never]
\`\`\`

### Step 4.4 — Configure Static HugePages

\`\`\`sql
-- Calculate required HugePages from Oracle
-- HugePage size on x86-64 Linux is 2MB = 2097152 bytes
SELECT
  CEIL(
    TO_NUMBER((SELECT value FROM v$parameter WHERE name = 'sga_max_size'))
    / 2097152
  ) + 10 AS nr_hugepages_recommended
FROM dual;
-- Add 10 as buffer for kernel overhead
\`\`\`

\`\`\`bash
# Set HugePages count (replace NNN with value from SQL above)
NNN=32780

echo "vm.nr_hugepages = \${NNN}" >> /etc/sysctl.d/99-oracle-db.conf
sysctl -w vm.nr_hugepages=\${NNN}

# Verify allocation
grep HugePages /proc/meminfo
# HugePages_Total should equal NNN
# HugePages_Free should be > 0 until Oracle starts and claims them
\`\`\`

\`\`\`sql
-- Set Oracle to use HugePages (disable AMM — incompatible with HugePages)
-- In spfile:
ALTER SYSTEM SET memory_target = 0 SCOPE=SPFILE;
ALTER SYSTEM SET memory_max_target = 0 SCOPE=SPFILE;
-- Ensure SGA_TARGET and SGA_MAX_SIZE are set explicitly instead
ALTER SYSTEM SET sga_target = 64G SCOPE=SPFILE;
ALTER SYSTEM SET sga_max_size = 64G SCOPE=SPFILE;
ALTER SYSTEM SET use_large_pages = ONLY SCOPE=SPFILE;
-- ONLY causes Oracle to refuse to start if HugePages are insufficient
-- This prevents silent fallback to 4KB pages
SHUTDOWN IMMEDIATE;
STARTUP;
\`\`\`

### Step 4.5 — Set PGA Hard Cap

\`\`\`sql
-- pga_aggregate_limit = hard ceiling; sessions exceeding it are terminated
-- Recommended: total RAM - SGA_MAX_SIZE - 10% OS headroom
-- Example: 256GB RAM - 64GB SGA - 26GB OS = 166GB limit
ALTER SYSTEM SET pga_aggregate_limit = 166G SCOPE=BOTH;
ALTER SYSTEM SET pga_aggregate_target = 32G SCOPE=BOTH;
\`\`\`

---

## Phase 5: Monitoring Scripts and Crontab

Place all scripts in \`/u01/oracle/scripts/monitor/\`. Run them as the \`oracle\` OS user.

### Script 1: Swap Usage Alert

\`\`\`bash
cat > /u01/oracle/scripts/monitor/check_swap.sh <<'SCRIPT'
#!/bin/bash
# check_swap.sh — alert when swap usage exceeds threshold
ALERT_EMAIL="dba-team@company.com"
THRESHOLD_PCT=50
LOG=/u01/oracle/scripts/monitor/logs/swap_check.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')

SWAP_TOTAL=\$(free | awk '/Swap:/ {print \$2}')
SWAP_USED=\$(free | awk '/Swap:/ {print \$3}')

if [ "\$SWAP_TOTAL" -gt 0 ]; then
  SWAP_PCT=\$(( SWAP_USED * 100 / SWAP_TOTAL ))
else
  SWAP_PCT=0
fi

if [ "\$SWAP_PCT" -ge "\$THRESHOLD_PCT" ]; then
  echo "\$TIMESTAMP ALERT: Swap is \${SWAP_PCT}% used (\${SWAP_USED}kB / \${SWAP_TOTAL}kB)" >> \$LOG
  SUBJECT="ALERT: Oracle Host Swap at \${SWAP_PCT}% on \$(hostname)"
  BODY="Swap usage on \$(hostname) is \${SWAP_PCT}% as of \$TIMESTAMP.

Current memory state:
\$(free -m)

Top swap-consuming processes:
\$(for f in /proc/[0-9]*/status; do awk '/Name|Pid|VmSwap/ {printf \$0 \" \"}; END {print \"\"}' \"\$f\" 2>/dev/null; done | grep -v 'VmSwap:       0 kB' | sort -k 3 -n -r | head -n 10)

Action required: investigate memory pressure before database hangs."
  echo "\$BODY" | mail -s "\$SUBJECT" \$ALERT_EMAIL
else
  echo "\$TIMESTAMP OK: Swap is \${SWAP_PCT}% used" >> \$LOG
fi
SCRIPT
chmod +x /u01/oracle/scripts/monitor/check_swap.sh
\`\`\`

### Script 2: HugePages Configuration Check

\`\`\`bash
cat > /u01/oracle/scripts/monitor/check_hugepages.sh <<'SCRIPT'
#!/bin/bash
# check_hugepages.sh — alert if HugePages are unconfigured or undersized
ALERT_EMAIL="dba-team@company.com"
LOG=/u01/oracle/scripts/monitor/logs/hugepages_check.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')

HP_TOTAL=\$(grep HugePages_Total /proc/meminfo | awk '{print \$2}')
HP_FREE=\$(grep HugePages_Free /proc/meminfo | awk '{print \$2}')
THP_STATE=\$(cat /sys/kernel/mm/transparent_hugepage/enabled 2>/dev/null)

ALERTS=""

if [ "\$HP_TOTAL" -eq 0 ]; then
  ALERTS="\$ALERTS\n- HugePages_Total is 0. Oracle SGA is NOT pinned in RAM and is eligible for swapping."
fi

if echo "\$THP_STATE" | grep -qE '\[always\]|\[madvise\]'; then
  ALERTS="\$ALERTS\n- Transparent HugePages are ENABLED (\$THP_STATE). This must be disabled for Oracle."
fi

if [ -n "\$ALERTS" ]; then
  echo "\$TIMESTAMP ALERT: HugePages misconfiguration detected" >> \$LOG
  echo -e "HugePages alerts on \$(hostname) at \$TIMESTAMP:\$ALERTS\n\nFix: configure Static HugePages and disable Transparent HugePages." \
    | mail -s "ALERT: Oracle HugePages Misconfigured on \$(hostname)" \$ALERT_EMAIL
else
  echo "\$TIMESTAMP OK: HugePages_Total=\${HP_TOTAL}, HugePages_Free=\${HP_FREE}, THP=\${THP_STATE}" >> \$LOG
fi
SCRIPT
chmod +x /u01/oracle/scripts/monitor/check_hugepages.sh
\`\`\`

### Script 3: NUMA Balance Check

\`\`\`bash
cat > /u01/oracle/scripts/monitor/check_numa.sh <<'SCRIPT'
#!/bin/bash
# check_numa.sh — alert when a NUMA node has critically low free memory
ALERT_EMAIL="dba-team@company.com"
LOG=/u01/oracle/scripts/monitor/logs/numa_check.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
THRESHOLD_MB=512  # alert if any node drops below 512 MB free

# numastat -m outputs free memory per node; extract the Free row
FREE_VALUES=\$(numastat -m 2>/dev/null | awk '/^MemFree/ {for(i=2;i<=NF;i++) print i-1, \$i}')

ALERT_NODES=""
while IFS= read -r line; do
  NODE=\$(echo "\$line" | awk '{print \$1}')
  FREE_MB=\$(echo "\$line" | awk '{printf "%d", \$2}')
  if [ "\$FREE_MB" -lt "\$THRESHOLD_MB" ]; then
    ALERT_NODES="\$ALERT_NODES\n  Node \${NODE}: \${FREE_MB} MB free (threshold: \${THRESHOLD_MB} MB)"
  fi
done <<< "\$FREE_VALUES"

if [ -n "\$ALERT_NODES" ]; then
  echo "\$TIMESTAMP ALERT: NUMA node(s) critically low" >> \$LOG
  echo -e "NUMA memory starvation detected on \$(hostname) at \$TIMESTAMP:\$ALERT_NODES\n\nFull numastat output:\n\$(numastat -m)" \
    | mail -s "ALERT: NUMA Node Low Memory on \$(hostname)" \$ALERT_EMAIL
else
  echo "\$TIMESTAMP OK: All NUMA nodes above \${THRESHOLD_MB} MB free" >> \$LOG
fi
SCRIPT
chmod +x /u01/oracle/scripts/monitor/check_numa.sh
\`\`\`

### Script 4: Oracle Wait Event Monitor

\`\`\`bash
cat > /u01/oracle/scripts/monitor/check_oracle_waits.sh <<'SCRIPT'
#!/bin/bash
# check_oracle_waits.sh — alert when key I/O wait events exceed latency thresholds
source /home/oracle/.bash_profile 2>/dev/null
ALERT_EMAIL="dba-team@company.com"
LOG=/u01/oracle/scripts/monitor/logs/oracle_waits.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
ORACLE_SID=\${ORACLE_SID:-ORCL}

RESULT=\$(sqlplus -s / as sysdba 2>/dev/null <<'EOF'
SET PAGESIZE 0 FEEDBACK OFF VERIFY OFF HEADING OFF TRIMOUT ON
SELECT event || '|' || ROUND(average_wait * 10, 2)
FROM v\$system_event
WHERE event IN (
  'log file parallel write',
  'db file parallel write',
  'control file parallel write',
  'log file sync'
)
AND total_waits > 100
ORDER BY average_wait DESC;
EXIT
EOF
)

ALERTS=""
while IFS='|' read -r EVENT AVG_MS; do
  EVENT=\$(echo "\$EVENT" | xargs)
  case "\$EVENT" in
    "log file parallel write")
      [ "\$(echo "\$AVG_MS > 5" | bc -l 2>/dev/null)" = "1" ] && \
        ALERTS="\$ALERTS\n  \$EVENT: \${AVG_MS}ms (threshold 5ms)" ;;
    "db file parallel write")
      [ "\$(echo "\$AVG_MS > 15" | bc -l 2>/dev/null)" = "1" ] && \
        ALERTS="\$ALERTS\n  \$EVENT: \${AVG_MS}ms (threshold 15ms)" ;;
    "log file sync")
      [ "\$(echo "\$AVG_MS > 10" | bc -l 2>/dev/null)" = "1" ] && \
        ALERTS="\$ALERTS\n  \$EVENT: \${AVG_MS}ms (threshold 10ms)" ;;
  esac
done <<< "\$RESULT"

if [ -n "\$ALERTS" ]; then
  echo "\$TIMESTAMP ALERT: High Oracle I/O wait events" >> \$LOG
  echo -e "Oracle I/O wait event thresholds exceeded on \$(hostname)/\${ORACLE_SID} at \$TIMESTAMP:\$ALERTS\n\nIndicates storage subsystem pressure. Check iostat and GCP disk throttle metrics." \
    | mail -s "ALERT: Oracle I/O Wait Events High on \$(hostname)" \$ALERT_EMAIL
else
  echo "\$TIMESTAMP OK: Oracle I/O wait events within thresholds" >> \$LOG
fi
SCRIPT
chmod +x /u01/oracle/scripts/monitor/check_oracle_waits.sh
\`\`\`

### Script 5: OOM Killer Log Scanner

\`\`\`bash
cat > /u01/oracle/scripts/monitor/check_oom_killer.sh <<'SCRIPT'
#!/bin/bash
# check_oom_killer.sh — alert if OOM Killer has fired since last check
ALERT_EMAIL="dba-team@company.com"
LOG=/u01/oracle/scripts/monitor/logs/oom_check.log
MARKER=/u01/oracle/scripts/monitor/logs/.oom_last_check
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')

# Get dmesg entries newer than the marker file
if [ -f "\$MARKER" ]; then
  OOM_EVENTS=\$(dmesg -T --since "\$(cat \$MARKER)" 2>/dev/null | grep -iE 'oom|out of memory|killed process' | head -20)
else
  OOM_EVENTS=\$(dmesg -T 2>/dev/null | grep -iE 'oom|out of memory|killed process' | tail -20)
fi

date '+%Y-%m-%dT%H:%M:%S' > "\$MARKER"

if [ -n "\$OOM_EVENTS" ]; then
  echo "\$TIMESTAMP ALERT: OOM Killer events detected" >> \$LOG
  echo "\$OOM_EVENTS" >> \$LOG
  echo "OOM Killer has fired on \$(hostname) as of \$TIMESTAMP.

Events:
\$OOM_EVENTS

Immediate action: check Oracle instance status, review /var/log/messages, investigate memory pressure." \
    | mail -s "CRITICAL: OOM Killer Fired on \$(hostname)" \$ALERT_EMAIL
else
  echo "\$TIMESTAMP OK: No OOM Killer events detected" >> \$LOG
fi
SCRIPT
chmod +x /u01/oracle/scripts/monitor/check_oom_killer.sh
\`\`\`

### Script 6: GCP Disk Throttle Check

\`\`\`bash
cat > /u01/oracle/scripts/monitor/check_gcp_throttle.sh <<'SCRIPT'
#!/bin/bash
# check_gcp_throttle.sh — detect GCP disk throttling via iostat sustained high latency
# (Use gcloud metrics for historical analysis; iostat for live detection)
ALERT_EMAIL="dba-team@company.com"
LOG=/u01/oracle/scripts/monitor/logs/gcp_throttle.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
LATENCY_THRESHOLD_MS=10  # Alert if w_await exceeds this for 3+ consecutive samples

# Sample iostat 5 times, 2 seconds apart
IOSTAT_OUT=\$(iostat -xm 2 5 2>/dev/null)

# Extract devices and their average w_await across samples
# Focus on devices likely hosting Oracle files (adjust pattern for your environment)
ALERT_DEVICES=\$(echo "\$IOSTAT_OUT" | awk -v thresh="\$LATENCY_THRESHOLD_MS" '
  /^sd|^nvme|^xvd/ {
    dev=\$1; wait=\$11+0;
    if (wait > thresh) {
      count[dev]++; total[dev]+=wait
    }
  }
  END {
    for (d in count) {
      if (count[d] >= 3) {
        printf "%s avg_w_await=%.1fms\\n", d, total[d]/count[d]
      }
    }
  }
')

if [ -n "\$ALERT_DEVICES" ]; then
  echo "\$TIMESTAMP ALERT: Sustained high disk write latency detected" >> \$LOG
  echo "\$ALERT_DEVICES" >> \$LOG
  echo "Sustained high disk write latency on \$(hostname) at \$TIMESTAMP.

Affected devices (w_await > \${LATENCY_THRESHOLD_MS}ms for 3+ samples):
\$ALERT_DEVICES

On GCP: check Cloud Console > Compute Engine > \$(hostname) > Monitoring for throttled_write_bytes_count.
Oracle action: check v\\\$system_event for 'log file parallel write' and 'db file parallel write' average wait times." \
    | mail -s "ALERT: High Disk Latency on \$(hostname) — Possible GCP Throttle" \$ALERT_EMAIL
else
  echo "\$TIMESTAMP OK: Disk write latency within threshold" >> \$LOG
fi
SCRIPT
chmod +x /u01/oracle/scripts/monitor/check_gcp_throttle.sh
\`\`\`

### Step 5.7 — Create Log Directory and Set Up Crontab

\`\`\`bash
mkdir -p /u01/oracle/scripts/monitor/logs
chown -R oracle:oinstall /u01/oracle/scripts/monitor

# Edit oracle user crontab
crontab -u oracle -e
\`\`\`

\`\`\`cron
# Oracle Memory and Storage Monitoring — crontab for oracle OS user
# Format: minute hour day-of-month month day-of-week command

# Swap usage — check every 5 minutes
*/5 * * * * /u01/oracle/scripts/monitor/check_swap.sh >> /u01/oracle/scripts/monitor/logs/cron.log 2>&1

# HugePages configuration — check every 30 minutes
*/30 * * * * /u01/oracle/scripts/monitor/check_hugepages.sh >> /u01/oracle/scripts/monitor/logs/cron.log 2>&1

# NUMA balance — check every 10 minutes
*/10 * * * * /u01/oracle/scripts/monitor/check_numa.sh >> /u01/oracle/scripts/monitor/logs/cron.log 2>&1

# Oracle wait events — check every 15 minutes
*/15 * * * * /u01/oracle/scripts/monitor/check_oracle_waits.sh >> /u01/oracle/scripts/monitor/logs/cron.log 2>&1

# OOM Killer scan — check every 5 minutes
*/5 * * * * /u01/oracle/scripts/monitor/check_oom_killer.sh >> /u01/oracle/scripts/monitor/logs/cron.log 2>&1

# GCP disk throttle — check every 10 minutes during business hours
*/10 6-22 * * * /u01/oracle/scripts/monitor/check_gcp_throttle.sh >> /u01/oracle/scripts/monitor/logs/cron.log 2>&1

# Weekly: purge monitor logs older than 30 days
0 4 * * 0 find /u01/oracle/scripts/monitor/logs -name "*.log" -mtime +30 -delete
\`\`\`

\`\`\`bash
# Verify crontab is active
crontab -u oracle -l

# Confirm cron daemon is running
systemctl status crond

# Test one script manually to confirm end-to-end
su - oracle -c "/u01/oracle/scripts/monitor/check_hugepages.sh"
cat /u01/oracle/scripts/monitor/logs/hugepages_check.log | tail -3
\`\`\`

---

## Phase 6: Post-Fix Validation

\`\`\`bash
# Verify all kernel parameters are set
sysctl vm.swappiness vm.zone_reclaim_mode vm.nr_hugepages
# Expected: swappiness=1, zone_reclaim_mode=0, nr_hugepages>0

# Verify THP is disabled
cat /sys/kernel/mm/transparent_hugepage/enabled
# Expected: always madvise [never]

# Verify Oracle is using HugePages
grep HugePages /proc/meminfo
# HugePages_Total should be set; HugePages_Free should drop after Oracle startup
\`\`\`

\`\`\`sql
-- Verify Oracle started with HugePages
SELECT name, value FROM v\$parameter
WHERE name IN ('use_large_pages', 'memory_target', 'sga_target', 'pga_aggregate_limit');
-- use_large_pages should be ONLY
-- memory_target should be 0 (incompatible with HugePages)
-- pga_aggregate_limit should be set to a value that leaves OS headroom

-- Confirm no SGA components are in swap (after HugePages fix)
-- Run the OS swap-per-process scan — Oracle processes should show VmSwap: 0 kB
\`\`\`

---

## Summary

A hung Oracle Database with full swap and free RAM is caused by one or more of three kernel-level misconfigurations: \`vm.swappiness\` too high, missing Static HugePages, or NUMA zone reclaim. On GCP, a swap storm compounds into a storage throttle event as disk I/O is shared between swap activity and database background process writes. The investigation follows three layers: OS memory commands, Oracle V$ wait statistics, and GCP disk throttle metrics. The permanent resolution requires four kernel changes (swappiness=1, zone_reclaim_mode=0, Static HugePages configured, Transparent HugePages disabled) plus Oracle parameter adjustments (\`use_large_pages=ONLY\`, \`pga_aggregate_limit\` set, AMM disabled). The six crontab-scheduled monitoring scripts provide early warning for each root cause — swap threshold, HugePages misconfiguration, NUMA imbalance, Oracle I/O wait events, OOM Killer activity, and GCP disk latency — before any of them escalate to a database hang.`,
};

async function main() {
  console.log('Inserting Oracle swap/memory runbook...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: {
      title: post.title,
      excerpt: post.excerpt,
      content: post.content,
      category: post.category,
      published: post.published,
      isPremium: post.isPremium,
      publishedAt: post.publishedAt,
      youtubeUrl: post.youtubeUrl,
    },
  });
  console.log('Inserted:', JSON.stringify(post.title));
}

main().catch(console.error);
