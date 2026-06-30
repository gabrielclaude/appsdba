import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'WebLogic Embedded LDAP Corruption Runbook: Recovering from Disk-Space-Induced Domain Failures',
  slug: 'oracle-atg-weblogic-disk-ldap-corruption-runbook',
  excerpt: 'Step-by-step runbook for diagnosing and recovering a WebLogic domain after disk exhaustion corrupts the Embedded LDAP store, causing BEA-000386 / NumberFormatException startup failures in Oracle ATG Web Commerce environments.',
  category: 'oracle-atg' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-30'),
  youtubeUrl: null,
  content: `## Overview

This runbook addresses a specific and severe failure mode that affects Oracle ATG Web Commerce environments running on WebLogic Server 12.1.x (concepts apply equally to 10.3.x through 14.x): **disk space exhaustion that corrupts the WebLogic Embedded LDAP store**, rendering the domain unable to start.

The embedded LDAP server is a Berkeley DB-format datastore that WebLogic uses to persist the default security realm — user credentials, groups, roles, and security policies. When the underlying filesystem fills to 100% capacity during a write operation to one of these Berkeley DB files, the result is a partial write that invalidates the file's internal checksums and page structure. WebLogic detects this on the next startup and refuses to initialize the security subsystem, producing a cascade of errors that prevents the AdminServer from reaching RUNNING state.

**Symptoms at a glance:**
- WebLogic AdminServer refuses to start after a disk-fill event
- \`BEA-000386\` MultiException in AdminServer.log referencing \`PreEmbeddedLDAPService\`
- \`NumberFormatException: null\` nested inside the MultiException stack trace
- \`SecurityInitializationException\` preventing security realm bootstrap
- If the AdminServer data directory was renamed as a troubleshooting step: weblogic user authentication denied with a \`SecurityService post-construct failure\`

**Recovery paths:**
- **Path A (preferred):** Restore the domain from a backup taken before the disk-fill event
- **Path B (data loss risk):** Delete the corrupted LDAP store and allow WebLogic to rebuild it from \`config.xml\`

**Environment scope:** Oracle ATG Web Commerce on WebLogic 12.1.x. All file paths use \`/opt/oracle/weblogic/user_projects/domains/base_domain\` as the domain root — substitute your actual domain path throughout.

---

## Root Cause Explained

WebLogic's Embedded LDAP server stores its data in a set of Berkeley DB files located at:

\`\`\`
<domain_root>/servers/AdminServer/data/ldap/ldapfiles/
\`\`\`

These files use a transactional page-based format. Under normal operation, WebLogic holds write locks and uses Berkeley DB's internal journaling to ensure atomicity. However, when the OS returns \`ENOSPC\` (No space left on device) mid-write, the Java layer receives an \`IOException\` that Berkeley DB cannot recover from cleanly. The partially written page is now on disk, but the file's internal page directory no longer matches its contents.

On the next JVM startup, the Berkeley DB library attempts to open and validate the files. It encounters a page it cannot parse — often manifesting as a \`NumberFormatException: null\` when WebLogic's internal LDAP bootstrapper tries to read a property value from the corrupted \`EmbeddedLDAP.properties\` file, or as a structural exception inside the Berkeley DB open routine itself. Either way, the \`PreEmbeddedLDAPService\` init step throws, which causes a MultiException (BEA-000386) that aborts the entire server startup sequence.

The secondary symptom — authentication denied after renaming the AdminServer directory — occurs because WebLogic caches certain security initialization state in the \`servers/AdminServer/data/\` tree. Renaming that directory without also clearing related in-memory state (which only exists across restarts) forces WebLogic to treat the domain as if no security realm has ever been initialized, triggering a different failure path.

---

## Phase 1: Incident Confirmation (5 minutes)

**Objective:** Confirm disk exhaustion is the root cause, not a network partition, database connectivity issue, or unrelated exception. Do NOT attempt a server restart until disk space is confirmed free — each failed restart attempt can write additional partial data to the LDAP store, worsening corruption and complicating recovery.

### 1.1 Check Current Disk State

\`\`\`bash
df -h
\`\`\`

Identify the filesystem that hosts the WebLogic domain. Look for \`Use%\` at or near 100%. A current reading of less than 100% does not rule out a past fill event — something may have already been deleted.

\`\`\`bash
du -sh /opt/oracle/weblogic/user_projects/domains/base_domain/servers/*/logs/
\`\`\`

This shows log directory sizes per server. WebLogic \`.out\` files and ATG application logs are the most common culprits for runaway disk consumption.

### 1.2 Find the Disk-Fill Timestamp

\`\`\`bash
grep -i "no space left" /opt/oracle/weblogic/user_projects/domains/base_domain/servers/*/logs/*.out | head -20
\`\`\`

Note the earliest timestamp. This is your reference point — any backup taken before this timestamp is potentially clean.

### 1.3 Confirm LDAP Corruption Signature

\`\`\`bash
grep -i "BEA-000386\|NumberFormatException\|PreEmbeddedLDAPService\|EmbeddedLDAP" \
  /opt/oracle/weblogic/user_projects/domains/base_domain/servers/AdminServer/logs/AdminServer.log \
  | tail -50
\`\`\`

**Decision table:**

| Log Pattern | Interpretation | Next Step |
|---|---|---|
| BEA-000386 with NumberFormatException + PreEmbeddedLDAPService | LDAP corruption confirmed | Proceed to Phase 2 |
| BEA-000386 with a different nested exception | Different root cause — investigate separately | Do not use this runbook |
| AdminServer starts cleanly on retry | Problem self-resolved (transient) | Monitor disk, implement Phase 5 hardening |
| BEA-000362 or BEA-000283 | Boot identity keystore issue | Different runbook |

---

## Phase 2: Free Disk Space and Assess Damage

**Objective:** Restore enough free disk space to enable safe recovery operations, then assess the extent of LDAP file corruption.

### 2.1 Identify the Disk Consumer

\`\`\`bash
du -sh /opt/oracle/weblogic/user_projects/domains/base_domain/servers/*/logs/ | sort -rh | head -20
\`\`\`

**Common culprits in ATG environments:**
- WebLogic server \`.out\` log (unbounded by default — can grow to tens of gigabytes)
- ATG \`/atg/dynamo/service/logging/\` output redirected to managed server logs
- JVM GC logs (\`-Xloggc:/path/gc.log\`) with no rotation
- Heap dumps (\`java_pidNNNN.hprof\`) generated during OOM events that preceded the disk fill
- Thread dumps written by ATG's internal thread dump facility

### 2.2 Safe Log Cleanup

Truncate the offending log file without deleting it (avoids breaking open file handles held by a still-running process):

\`\`\`bash
> /opt/oracle/weblogic/user_projects/domains/base_domain/servers/AdminServer/logs/AdminServer.out
\`\`\`

Archive and compress old rotated logs:

\`\`\`bash
gzip /opt/oracle/weblogic/user_projects/domains/base_domain/servers/*/logs/*.log.0* 2>/dev/null
\`\`\`

Remove heap dumps if confirmed safe (verify with application team before deleting):

\`\`\`bash
find /opt/oracle/weblogic/user_projects/domains/base_domain -name "*.hprof" -ls
# Delete only after confirming with the team:
# rm -f /path/to/java_pidNNNN.hprof
\`\`\`

**Target: at least 20% free space on the domain filesystem before proceeding.** Confirm:

\`\`\`bash
df -h /opt/oracle/weblogic/user_projects/domains/
\`\`\`

### 2.3 Check LDAP File Integrity

\`\`\`bash
ls -la /opt/oracle/weblogic/user_projects/domains/base_domain/servers/AdminServer/data/ldap/
ls -la /opt/oracle/weblogic/user_projects/domains/base_domain/servers/AdminServer/data/ldap/ldapfiles/
\`\`\`

**Red flags:**
- Any file with \`0\` bytes in the size column (definitive corruption indicator)
- Files with modification timestamps that match the disk-fill event from Phase 1
- The \`ldapfiles/\` directory entirely missing (indicates WebLogic attempted cleanup on a prior failed restart)

Check the LDAP properties file specifically:

\`\`\`bash
cat /opt/oracle/weblogic/user_projects/domains/base_domain/servers/AdminServer/data/ldap/EmbeddedLDAP.properties
\`\`\`

A healthy \`EmbeddedLDAP.properties\` contains key-value pairs such as:

\`\`\`
LDAPHost=localhost
LDAPPort=7001
...
\`\`\`

A corrupted file will be empty, contain a single partial line, or contain binary garbage.

---

## Phase 3: Backup Assessment — Choose Recovery Path

**Objective:** Determine whether a viable backup exists, and choose the appropriate recovery path.

### 3.1 Find the Most Recent Pre-Event Backup

\`\`\`bash
ls -lt /backup/weblogic/base_domain/ | head -10
\`\`\`

Compare the backup timestamps against the disk-fill event timestamp identified in Phase 1.2. A backup is viable only if its timestamp is **earlier** than the first "No space left on device" message.

### 3.2 Enumerate the Domain's Managed Servers

\`\`\`bash
ls /opt/oracle/weblogic/user_projects/domains/base_domain/servers/
\`\`\`

Document all servers listed. Recovery must account for all of them. In a typical ATG Commerce deployment you will see AdminServer plus one or more ATG managed servers (e.g., \`atg_server1\`, \`atg_server2\`).

### 3.3 Stop Automatic Restart Mechanisms

Before any recovery operation, prevent automated processes from interfering:

\`\`\`bash
# Stop systemd-managed WLS services if present:
systemctl stop wls_managed_service 2>/dev/null
systemctl stop nodemanager 2>/dev/null

# Kill any remaining WebLogic Java processes for this domain:
ps aux | grep weblogic | grep -v grep

# Confirm with kill if any are found — replace PID list as appropriate:
# kill -15 <pid>   # SIGTERM first; escalate to kill -9 if they don't stop within 30 seconds
\`\`\`

### 3.4 Recovery Path Decision

| Condition | Recovery Path |
|---|---|
| Backup exists with timestamp before disk-fill event | **Phase 4A — Domain Directory Restore** |
| No backup exists; \`config.xml\` is intact and XML-valid | **Phase 4B — LDAP Store Rebuild** |
| No backup exists; \`config.xml\` is also corrupted | Rebuild domain from scratch using WLST \`readDomain\`/\`createDomain\` — outside scope of this runbook; engage Oracle Support |

---

## Phase 4A: Recovery Path A — Domain Directory Restore

**Prerequisite:** Verified clean backup with timestamp before the disk-fill event.

**Expected outcome:** Full domain restored to pre-incident state; no data loss; all security policies, users, and groups intact.

### Step 1: Stop ALL WebLogic Processes

Ensure no Java process for this domain is running:

\`\`\`bash
kill -9 $(ps aux | grep 'base_domain' | grep -v grep | awk '{print $2}') 2>/dev/null
\`\`\`

Wait 10 seconds and confirm the process list is clear:

\`\`\`bash
ps aux | grep 'base_domain' | grep -v grep
\`\`\`

### Step 2: Rename the Corrupted Domain Directory

Preserve the corrupted state for forensic analysis or rollback:

\`\`\`bash
mv /opt/oracle/weblogic/user_projects/domains/base_domain \
   /opt/oracle/weblogic/user_projects/domains/base_domain_CORRUPTED_$(date +%Y%m%d_%H%M%S)
\`\`\`

**Do not delete the corrupted directory at this stage.** It may be needed for forensic root-cause analysis or Oracle Support engagement.

### Step 3: Restore from Backup

\`\`\`bash
tar -xzf /backup/weblogic/base_domain_YYYYMMDD_HHMMSS.tar.gz \
    -C /opt/oracle/weblogic/user_projects/domains/
\`\`\`

Replace \`YYYYMMDD_HHMMSS\` with the actual backup filename. Verify the extraction completed without errors (tar exit code should be 0).

### Step 4: Verify Restored LDAP Files

\`\`\`bash
ls -la /opt/oracle/weblogic/user_projects/domains/base_domain/servers/AdminServer/data/ldap/ldapfiles/
\`\`\`

All files must be non-zero size. Then verify \`EmbeddedLDAP.properties\`:

\`\`\`bash
cat /opt/oracle/weblogic/user_projects/domains/base_domain/servers/AdminServer/data/ldap/EmbeddedLDAP.properties
\`\`\`

Confirm it contains valid key-value content, not empty output.

### Step 5: Verify Boot Properties

\`\`\`bash
cat /opt/oracle/weblogic/user_projects/domains/base_domain/servers/AdminServer/security/boot.properties
\`\`\`

This file should exist and contain either encrypted credential values (if the domain has started at least once after backup) or plaintext credentials. An empty or missing \`boot.properties\` will cause AdminServer to prompt for credentials on the console — acceptable for manual restart but incompatible with automated startup scripts.

### Step 6: Start AdminServer and Watch Logs

\`\`\`bash
nohup /opt/oracle/weblogic/user_projects/domains/base_domain/bin/startWebLogic.sh \
  > /opt/oracle/weblogic/user_projects/domains/base_domain/servers/AdminServer/logs/AdminServer.out 2>&1 &

tail -f /opt/oracle/weblogic/user_projects/domains/base_domain/servers/AdminServer/logs/AdminServer.log
\`\`\`

**Expected success indicators:**
\`\`\`
<Notice> <WebLogicServer> <BEA-000365> <Server state changed to RUNNING>
<Notice> <EmbeddedLDAP> ... started
\`\`\`

**Failure indicators requiring escalation:**
- Any recurrence of \`BEA-000386\` — the backup itself may be from after the disk-fill event
- \`BEA-000402\` — Node Manager connection refused (start Node Manager first if required)

Allow up to 5 minutes for AdminServer to reach RUNNING state before declaring the restart failed.

### Step 7: Start Managed ATG Servers

Once AdminServer is in RUNNING state, start managed servers via Node Manager or the startup script:

\`\`\`bash
nohup /opt/oracle/weblogic/user_projects/domains/base_domain/bin/startManagedWebLogic.sh \
  atg_server1 t3://adminhost:7001 \
  > /opt/oracle/weblogic/user_projects/domains/base_domain/servers/atg_server1/logs/atg_server1.out 2>&1 &
\`\`\`

### Step 8: Verify ATG Application Health

- Access WebLogic Admin Console: \`https://<admin_host>:7001/console\`
- Access Dynamo Admin on each managed server: \`http://<managed_host>:<port>/dyn/admin\`
- Navigate to **Components > Repository** in Dynamo Admin and confirm all ATG repositories show \`Running\` status
- Run a test product page request and confirm HTTP 200 response

---

## Phase 4B: Recovery Path B — LDAP Store Rebuild (No Backup)

**WARNING: This path results in data loss.** Any security configuration changes made after domain creation — including manually added users, custom groups, fine-grained security policies, and LDAP-stored role mappings — will be lost. Only the structural security realm definition in \`config.xml\` and the boot credential in \`boot.properties\` survive. Communicate this to stakeholders before proceeding.

**Prerequisites:** \`config.xml\` is intact and XML-valid; \`boot.properties\` is intact.

### Step 1: Validate config.xml Integrity

\`\`\`bash
wc -l /opt/oracle/weblogic/user_projects/domains/base_domain/config/config.xml
xmllint --noout /opt/oracle/weblogic/user_projects/domains/base_domain/config/config.xml && echo "XML valid"
\`\`\`

If \`xmllint\` reports errors, \`config.xml\` is also corrupted. Check the config backup at \`config/config.xml.booted\` — WebLogic writes this file on each successful boot:

\`\`\`bash
ls -la /opt/oracle/weblogic/user_projects/domains/base_domain/config/config.xml.booted
cp /opt/oracle/weblogic/user_projects/domains/base_domain/config/config.xml.booted \
   /opt/oracle/weblogic/user_projects/domains/base_domain/config/config.xml
\`\`\`

### Step 2: Forensic Backup of Corrupted LDAP

Before destroying evidence, preserve it:

\`\`\`bash
cp -r /opt/oracle/weblogic/user_projects/domains/base_domain/servers/AdminServer/data/ldap/ \
      /tmp/ldap_backup_$(date +%Y%m%d_%H%M%S)/
\`\`\`

### Step 3: Delete Corrupted LDAP Data Files

Remove only the Berkeley DB data files and lock files. Leave \`EmbeddedLDAP.properties\` in place unless it is also corrupted (zero-byte or unreadable):

\`\`\`bash
rm -rf /opt/oracle/weblogic/user_projects/domains/base_domain/servers/AdminServer/data/ldap/ldapfiles/
rm -f  /opt/oracle/weblogic/user_projects/domains/base_domain/servers/AdminServer/data/ldap/ldap.lck
rm -f  /opt/oracle/weblogic/user_projects/domains/base_domain/servers/AdminServer/data/ldap/ldap.pid
\`\`\`

If \`EmbeddedLDAP.properties\` is also corrupted:

\`\`\`bash
rm -f /opt/oracle/weblogic/user_projects/domains/base_domain/servers/AdminServer/data/ldap/EmbeddedLDAP.properties
\`\`\`

WebLogic regenerates \`EmbeddedLDAP.properties\` from \`config.xml\` defaults on next startup.

### Step 4: Start AdminServer — LDAP Rebuild Triggered

\`\`\`bash
nohup /opt/oracle/weblogic/user_projects/domains/base_domain/bin/startWebLogic.sh \
  > /opt/oracle/weblogic/user_projects/domains/base_domain/servers/AdminServer/logs/AdminServer.out 2>&1 &

tail -f /opt/oracle/weblogic/user_projects/domains/base_domain/servers/AdminServer/logs/AdminServer.log
\`\`\`

WebLogic detects the absent LDAP store and automatically initializes a new Berkeley DB from the security realm configuration in \`config.xml\`. Watch for:

\`\`\`
<Notice> <EmbeddedLDAP> ... Embedded LDAP server started
<Notice> <WebLogicServer> <BEA-000365> <Server state changed to RUNNING>
\`\`\`

This initialization may take 60–90 seconds longer than a normal start — the Berkeley DB schema creation and initial population are occurring.

### Step 5: Reset Boot Properties if Authentication Fails

If AdminServer starts but the weblogic administrator account cannot authenticate (login to Admin Console fails), the boot credential hash in the rebuilt LDAP store does not match \`boot.properties\`. Reset it by providing plaintext credentials — WebLogic re-encrypts on next startup:

\`\`\`bash
cat > /opt/oracle/weblogic/user_projects/domains/base_domain/servers/AdminServer/security/boot.properties << 'EOF'
username=weblogic
password=<your_admin_password>
EOF
\`\`\`

Stop and restart AdminServer after writing this file:

\`\`\`bash
kill $(ps aux | grep 'base_domain' | grep -v grep | awk '{print $2}') 2>/dev/null
# Wait 15 seconds, then restart:
nohup /opt/oracle/weblogic/user_projects/domains/base_domain/bin/startWebLogic.sh \
  > /opt/oracle/weblogic/user_projects/domains/base_domain/servers/AdminServer/logs/AdminServer.out 2>&1 &
\`\`\`

### Step 6: Restore Security Policies

After recovery via Path B, re-apply any security policy changes that were lost. Consult change records or any LDAP exports performed before the incident. Going forward, establish a post-change LDAP export procedure (see Phase 5).

---

## Phase 5: Post-Recovery Hardening

**Objective:** Eliminate the conditions that allowed this incident to occur and establish monitoring to detect disk pressure before it causes corruption.

### 5.1 Configure WebLogic Log Rotation

Prevent unbounded log growth by configuring log rotation in \`config.xml\`. Add or modify the \`<log>\` element for each server:

\`\`\`xml
<server>
  <name>AdminServer</name>
  <log>
    <name>AdminServer</name>
    <rotation-type>bySize</rotation-type>
    <file-min-size>50000</file-min-size>
    <file-count>10</file-count>
    <rotate-log-on-startup>true</rotate-log-on-startup>
  </log>
</server>
\`\`\`

This limits each server log to approximately 50 MB per file, retaining 10 rotations (500 MB maximum per server). Apply equivalent configuration to managed servers.

Also configure the \`.out\` stdout log (which is separate from the WebLogic log) by passing \`-log.rotation\` arguments to the JVM startup, or by redirecting through a log rotation tool such as \`rotatelogs\` from the Apache HTTP Server utilities.

### 5.2 Separate Log Volume from Domain Volume

The single highest-impact architectural change: mount WebLogic logs on a separate filesystem from the domain data:

\`\`\`
/opt/oracle/weblogic/user_projects/domains/   →  dedicated volume, 20 GB minimum
/opt/oracle/weblogic/logs/                    →  separate volume, sized for log retention policy
\`\`\`

Configure the domain's \`startWebLogic.sh\` (or the Node Manager startup script) to redirect \`.out\` output to the separate log volume. Even if the log volume fills, the domain volume remains healthy and the LDAP store is protected.

### 5.3 Disk Monitoring Cron Job

Add a cron job that alerts before disk reaches a critical threshold. This example alerts at 80% usage:

\`\`\`bash
# crontab -e — add the following line:
*/10 * * * * df -h /opt/oracle | awk 'NR>1 && $5+0 > 80 {print "DISK ALERT: " $0}' | mail -s "WLS Disk Warning" admin@company.com
\`\`\`

For environments without a local mail relay, replace the \`mail\` command with a curl call to a webhook or alerting API endpoint.

### 5.4 Nightly Domain Backup Cron Job

\`\`\`bash
# crontab -e — add the following line (% must be escaped in crontab):
0 2 * * * tar -czf /backup/weblogic/base_domain_$(date +\%Y\%m\%d).tar.gz --exclude='*/servers/*/tmp' --exclude='*/servers/*/logs/*.out' /opt/oracle/weblogic/user_projects/domains/base_domain/ >> /var/log/wls_backup.log 2>&1
\`\`\`

This runs at 02:00 daily, excludes temp directories and large \`.out\` files, and logs results.

### 5.5 LDAP Export After Security Changes

After every change to the WebLogic security realm (adding users, modifying groups, changing policies), export the LDAP store via the Admin Console:

1. Log in to Admin Console: \`https://<admin_host>:7001/console\`
2. Navigate to **Security Realms → myrealm → Migration → Export**
3. Export to a file outside the domain directory
4. Store the export alongside the domain backup

This export can be reimported via Path B recovery to restore security data without a full domain restore.

---

## Phase 6: Verification Checklist

Run through this checklist sequentially before declaring the incident resolved.

| Check | Command / Method | Expected Result |
|---|---|---|
| AdminServer process running | \`ps aux \| grep AdminServer\` | Java process present |
| AdminServer in RUNNING state | WebLogic console or WLST | State = RUNNING |
| No BEA-000386 in AdminServer.log | \`grep BEA-000386 AdminServer.log\` | Zero matches |
| LDAP files present and non-zero | \`ls -la .../ldap/ldapfiles/\` | All files > 0 bytes |
| Admin console login successful | Browser: \`https://<admin_host>:7001/console\` | Login accepted |
| All managed servers in RUNNING state | Admin console Servers page | All RUNNING |
| Dynamo Admin accessible | \`http://<managed_host>:<port>/dyn/admin\` | HTTP 200 |
| ATG repositories connected | Dynamo Admin → Components → Repository | Status: Running |
| Storefront test request | \`curl -s -o /dev/null -w "%{http_code}" http://<store_host>/browse/productId/TEST\` | HTTP 200 or 302 |
| Disk usage within safe range | \`df -h /opt/oracle\` | Use% < 80% |

---

## Diagnostic Scripts

### Script 1: LDAP Corruption and Disk Warning Monitor

Save as \`/opt/oracle/scripts/wls_ldap_monitor.sh\` and invoke from cron every 5 minutes.

\`\`\`bash
#!/bin/bash
# wls_ldap_monitor.sh — WebLogic LDAP corruption and disk pressure monitor
# Runs every 5 minutes via cron. Sends alert email on anomaly detection.

DOMAIN_HOME=\${DOMAIN_HOME:-/opt/oracle/weblogic/user_projects/domains/base_domain}
ADMIN_HOST=\${ADMIN_HOST:-adminserver.internal}
ALERT_EMAIL=\${ALERT_EMAIL:-admin@company.com}
LDAP_DIR="\${DOMAIN_HOME}/servers/AdminServer/data/ldap"
LOG_FILE="\${DOMAIN_HOME}/servers/AdminServer/logs/AdminServer.log"
THRESHOLD_PCT=80
ALERT_SUBJECT="[WLS ALERT] \$(hostname) - WebLogic Disk/LDAP Warning"

send_alert() {
  local message="\$1"
  echo "\${message}" | mail -s "\${ALERT_SUBJECT}" "\${ALERT_EMAIL}"
}

# Check disk usage on the domain filesystem
DISK_PCT=\$(df "\${DOMAIN_HOME}" | awk 'NR==2 {gsub(/%/,""); print \$5}')
if [ "\${DISK_PCT}" -ge "\${THRESHOLD_PCT}" ]; then
  send_alert "DISK WARNING: Domain filesystem is \${DISK_PCT}% full on \$(hostname). Domain: \${DOMAIN_HOME}. Risk of LDAP corruption if disk reaches 100%."
fi

# Check for BEA-000386 in the last 100 lines of AdminServer.log
if [ -f "\${LOG_FILE}" ]; then
  if tail -100 "\${LOG_FILE}" | grep -q "BEA-000386\|NumberFormatException.*null\|PreEmbeddedLDAPService"; then
    send_alert "LDAP CORRUPTION DETECTED: BEA-000386 or LDAP-related exception found in \${LOG_FILE} on \$(hostname). Immediate investigation required."
  fi
fi

# Check for zero-byte LDAP files
if [ -d "\${LDAP_DIR}/ldapfiles" ]; then
  ZERO_FILES=\$(find "\${LDAP_DIR}/ldapfiles" -size 0 -type f)
  if [ -n "\${ZERO_FILES}" ]; then
    send_alert "LDAP FILE CORRUPTION: Zero-byte LDAP files detected on \$(hostname):\n\${ZERO_FILES}\nWebLogic will fail to start. Initiate LDAP runbook immediately."
  fi
else
  # ldapfiles directory missing is also a corruption indicator (if AdminServer is supposed to be running)
  if ps aux | grep -q "[A]dminServer"; then
    send_alert "LDAP DIRECTORY MISSING: \${LDAP_DIR}/ldapfiles does not exist but AdminServer process is running on \$(hostname). Investigate immediately."
  fi
fi

# Check for 'no space left on device' in recent log entries
if [ -f "\${LOG_FILE}" ]; then
  if tail -200 "\${LOG_FILE}" | grep -iq "no space left on device"; then
    send_alert "DISK FULL EVENT DETECTED IN LOG: 'No space left on device' found in \${LOG_FILE} on \$(hostname). Check LDAP integrity and free disk space immediately."
  fi
fi

exit 0
\`\`\`

Cron entry (run every 5 minutes):
\`\`\`
*/5 * * * * /opt/oracle/scripts/wls_ldap_monitor.sh >> /var/log/wls_ldap_monitor.log 2>&1
\`\`\`

---

### Script 2: Pre-Restart Health Check

Save as \`/opt/oracle/scripts/wls_prestart_check.sh\`. Run this script and confirm GO status before every manual AdminServer restart following an incident.

\`\`\`bash
#!/bin/bash
# wls_prestart_check.sh — Pre-restart health check for WebLogic AdminServer
# Verifies disk space, LDAP file integrity, and config.xml validity.
# Prints GO or NO-GO determination.

DOMAIN_HOME=\${DOMAIN_HOME:-/opt/oracle/weblogic/user_projects/domains/base_domain}
LDAP_DIR="\${DOMAIN_HOME}/servers/AdminServer/data/ldap"
CONFIG_XML="\${DOMAIN_HOME}/config/config.xml"
BOOT_PROPS="\${DOMAIN_HOME}/servers/AdminServer/security/boot.properties"
PASS=0
FAIL=0

check() {
  local description="\$1"
  local result="\$2"  # 0=pass, 1=fail
  local detail="\$3"
  if [ "\${result}" -eq 0 ]; then
    echo "  [PASS] \${description}"
    PASS=\$((PASS+1))
  else
    echo "  [FAIL] \${description}: \${detail}"
    FAIL=\$((FAIL+1))
  fi
}

echo "========================================"
echo " WebLogic Pre-Restart Health Check"
echo " Domain: \${DOMAIN_HOME}"
echo " Time:   \$(date)"
echo "========================================"
echo ""

echo "--- Disk Space ---"
DISK_PCT=\$(df "\${DOMAIN_HOME}" | awk 'NR==2 {gsub(/%/,""); print \$5}')
echo "  Filesystem usage: \${DISK_PCT}%"
[ "\${DISK_PCT}" -lt 80 ] && check "Disk usage below 80%" 0 "" || check "Disk usage below 80%" 1 "Currently \${DISK_PCT}% — free space before starting WebLogic"

echo ""
echo "--- LDAP Files ---"
if [ -d "\${LDAP_DIR}/ldapfiles" ]; then
  check "ldapfiles directory exists" 0 ""
  ZERO_COUNT=\$(find "\${LDAP_DIR}/ldapfiles" -size 0 -type f | wc -l)
  check "No zero-byte LDAP files" \$([ "\${ZERO_COUNT}" -eq 0 ] && echo 0 || echo 1) "\${ZERO_COUNT} zero-byte file(s) found — LDAP store is corrupted"
  FILE_COUNT=\$(ls "\${LDAP_DIR}/ldapfiles" | wc -l)
  check "LDAP store contains files" \$([ "\${FILE_COUNT}" -gt 0 ] && echo 0 || echo 1) "Directory is empty"
else
  check "ldapfiles directory exists" 1 "Directory absent — WebLogic will rebuild LDAP on start (data loss)"
fi

if [ -f "\${LDAP_DIR}/EmbeddedLDAP.properties" ]; then
  PROP_SIZE=\$(wc -c < "\${LDAP_DIR}/EmbeddedLDAP.properties")
  check "EmbeddedLDAP.properties non-empty" \$([ "\${PROP_SIZE}" -gt 0 ] && echo 0 || echo 1) "File is zero bytes — corrupted"
else
  check "EmbeddedLDAP.properties exists" 1 "File missing — WebLogic will regenerate"
fi

echo ""
echo "--- config.xml ---"
if [ -f "\${CONFIG_XML}" ]; then
  check "config.xml exists" 0 ""
  CONFIG_LINES=\$(wc -l < "\${CONFIG_XML}")
  check "config.xml non-empty" \$([ "\${CONFIG_LINES}" -gt 10 ] && echo 0 || echo 1) "Only \${CONFIG_LINES} lines — possibly truncated"
  if command -v xmllint > /dev/null 2>&1; then
    xmllint --noout "\${CONFIG_XML}" 2>/dev/null
    check "config.xml is valid XML" \$? "xmllint reported parse errors"
  else
    echo "  [SKIP] xmllint not available — install libxml2-utils for XML validation"
  fi
else
  check "config.xml exists" 1 "CRITICAL: config.xml missing — domain cannot start"
fi

echo ""
echo "--- Boot Properties ---"
if [ -f "\${BOOT_PROPS}" ]; then
  BOOT_SIZE=\$(wc -c < "\${BOOT_PROPS}")
  check "boot.properties exists and non-empty" \$([ "\${BOOT_SIZE}" -gt 0 ] && echo 0 || echo 1) "File is empty"
else
  check "boot.properties exists" 1 "Missing — AdminServer will prompt for credentials on console"
fi

echo ""
echo "--- Running Processes ---"
WLS_PROCS=\$(ps aux | grep 'base_domain' | grep -v grep | wc -l)
check "No stale WebLogic processes running" \$([ "\${WLS_PROCS}" -eq 0 ] && echo 0 || echo 1) "\${WLS_PROCS} process(es) still running — stop them before restarting"

echo ""
echo "========================================"
echo " Results: \${PASS} passed, \${FAIL} failed"
if [ "\${FAIL}" -eq 0 ]; then
  echo " DETERMINATION: GO — safe to start AdminServer"
else
  echo " DETERMINATION: NO-GO — resolve \${FAIL} failed check(s) before starting"
fi
echo "========================================"
exit \${FAIL}
\`\`\`

---

### Script 3: Nightly Domain Backup with Retention Management

Save as \`/opt/oracle/scripts/wls_domain_backup.sh\`.

\`\`\`bash
#!/bin/bash
# wls_domain_backup.sh — Nightly WebLogic domain backup with 7-day retention
# Logs success/failure to BACKUP_LOG. Intended for cron at 02:00 daily.

DOMAIN_HOME=\${DOMAIN_HOME:-/opt/oracle/weblogic/user_projects/domains/base_domain}
BACKUP_DIR=\${BACKUP_DIR:-/backup/weblogic}
RETENTION_DAYS=7
BACKUP_LOG="\${BACKUP_DIR}/backup.log"
TIMESTAMP=\$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="\${BACKUP_DIR}/base_domain_\${TIMESTAMP}.tar.gz"
DOMAIN_NAME=\$(basename "\${DOMAIN_HOME}")

log() {
  echo "\$(date '+%Y-%m-%d %H:%M:%S') \$1" >> "\${BACKUP_LOG}"
}

# Ensure backup directory exists
mkdir -p "\${BACKUP_DIR}"

log "INFO: Starting backup of \${DOMAIN_HOME} to \${BACKUP_FILE}"

# Create compressed archive, excluding large transient files
tar -czf "\${BACKUP_FILE}" \
  --exclude="\${DOMAIN_HOME}/servers/*/tmp" \
  --exclude="\${DOMAIN_HOME}/servers/*/logs/*.out" \
  --exclude="\${DOMAIN_HOME}/servers/*/logs/*.hprof" \
  --exclude="\${DOMAIN_HOME}/servers/*/cache" \
  "\${DOMAIN_HOME}" 2>> "\${BACKUP_LOG}"

TAR_EXIT=\$?

if [ \${TAR_EXIT} -eq 0 ]; then
  BACKUP_SIZE=\$(du -sh "\${BACKUP_FILE}" | awk '{print \$1}')
  log "INFO: Backup completed successfully. File: \${BACKUP_FILE}, Size: \${BACKUP_SIZE}"
else
  log "ERROR: Backup failed with exit code \${TAR_EXIT}. File may be incomplete: \${BACKUP_FILE}"
  rm -f "\${BACKUP_FILE}"
  exit 1
fi

# Retention management: delete backups older than RETENTION_DAYS
log "INFO: Applying \${RETENTION_DAYS}-day retention policy in \${BACKUP_DIR}"
DELETED=\$(find "\${BACKUP_DIR}" -name "base_domain_*.tar.gz" -mtime +\${RETENTION_DAYS} -print -delete | wc -l)
log "INFO: Deleted \${DELETED} backup archive(s) older than \${RETENTION_DAYS} days"

# Report remaining backups
REMAINING=\$(ls -1 "\${BACKUP_DIR}"/base_domain_*.tar.gz 2>/dev/null | wc -l)
log "INFO: Backup cycle complete. \${REMAINING} archive(s) retained."

exit 0
\`\`\`

Cron entry (run nightly at 02:00):
\`\`\`
0 2 * * * /opt/oracle/scripts/wls_domain_backup.sh >> /var/log/wls_domain_backup_cron.log 2>&1
\`\`\`

---

## Quick Reference

### BEA-000386 Error Code

**BEA-000386** is a WebLogic MultiException that indicates the server failed to initialize one or more services during startup. It is a container error — the meaningful diagnostic information is in the nested exception(s) inside the MultiException stack trace. When BEA-000386 references \`PreEmbeddedLDAPService\` with a \`NumberFormatException: null\`, it specifically means the Embedded LDAP server initialization failed because a configuration or data file could not be parsed — the primary cause is a corrupted or truncated Berkeley DB file or \`EmbeddedLDAP.properties\`.

---

### LDAP File Locations

| File / Directory | Path (relative to domain root) | Purpose | Corruption Check |
|---|---|---|---|
| \`ldapfiles/\` directory | \`servers/AdminServer/data/ldap/ldapfiles/\` | Berkeley DB data files for the Embedded LDAP store | \`ls -la\` — any zero-byte file = corrupted |
| \`EmbeddedLDAP.properties\` | \`servers/AdminServer/data/ldap/EmbeddedLDAP.properties\` | LDAP server configuration (host, port, base DN, credentials) | \`wc -c\` — zero bytes = corrupted; \`cat\` to verify readable content |
| \`ldap.lck\` | \`servers/AdminServer/data/ldap/ldap.lck\` | Berkeley DB environment lock file | Delete if present and no WLS process is running |
| \`ldap.pid\` | \`servers/AdminServer/data/ldap/ldap.pid\` | LDAP server process ID file | Delete if present and no WLS process is running |
| \`boot.properties\` | \`servers/AdminServer/security/boot.properties\` | Encrypted (or plaintext) WebLogic admin username/password for automated startup | \`wc -c\` — zero bytes or missing = manual credentials required |
| \`config.xml\` | \`config/config.xml\` | Master domain configuration — security realm structure, server definitions, JDBC, JMS | \`xmllint --noout\` — any parse error = corrupted |
| \`config.xml.booted\` | \`config/config.xml.booted\` | Copy of config.xml from last successful boot — use to restore corrupted config.xml | Same as config.xml |

---

### Recovery Decision Tree

\`\`\`
DISK FILL EVENT CONFIRMED
        │
        ▼
  Disk space freed?
        │
   NO ──┴── YES
   │            │
   │            ▼
   │    BEA-000386 with NumberFormatException
   │    in PreEmbeddedLDAPService?
   │            │
   │       YES ─┴─ NO
   │        │         └── Different failure mode
   │        │             Investigate separately
   │        ▼
   │    Backup exists (timestamp < disk-fill event)?
   │            │
   │       YES ─┴─ NO
   │        │         │
   │        │         ▼
   │        │    config.xml intact and XML-valid?
   │        │            │
   │        │       YES ─┴─ NO
   │        │        │         └── CRITICAL: Rebuild domain
   │        │        │             from scratch using WLST.
   │        │        │             Engage Oracle Support.
   │        │        ▼
   │        │    Path B: Delete ldapfiles/,
   │        │    restart AdminServer.
   │        │    DATA LOSS: security policies reset.
   │        ▼
   │    Path A: Restore domain directory
   │    from backup. No data loss.
   │
   └── Do not attempt restart.
       Free disk space first.
\`\`\`

---

### Boot Sequence Order

Follow this order during every recovery restart:

1. **Disk check** — confirm filesystem \`Use%\` is below 80% (run \`wls_prestart_check.sh\`)
2. **AdminServer** — start and wait for \`RUNNING\` state before proceeding
3. **Verify LDAP** — confirm \`ldapfiles/\` contains non-zero-byte files; no BEA-000386 in log
4. **Node Manager** (if used) — start Node Manager, confirm it connects to AdminServer
5. **Managed Servers** — start ATG managed servers in dependency order (if servers depend on each other, start the dependency first)
6. **Application verification** — confirm Dynamo Admin, repository status, storefront HTTP response

---

### Key Log Files to Monitor During Recovery

| Log File | Path | What to Look For |
|---|---|---|
| AdminServer.log | \`servers/AdminServer/logs/AdminServer.log\` | BEA-000386, BEA-000365 (RUNNING), EmbeddedLDAP init messages |
| AdminServer.out | \`servers/AdminServer/logs/AdminServer.out\` | JVM stdout — stack traces, GC output, OOM events |
| Managed server logs | \`servers/<name>/logs/<name>.log\` | Managed server state transitions, ATG nucleus startup |
| Node Manager log | \`NodeManager/<host>/NodeManager.log\` | Node Manager connection status, server start/stop commands |
| ATG nucleus log | \`servers/<name>/logs/\` (ATG-configured path) | ATG component initialization, repository connection errors |
`,
};

async function main() {
  console.log('Inserting WebLogic LDAP corruption runbook...');
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
