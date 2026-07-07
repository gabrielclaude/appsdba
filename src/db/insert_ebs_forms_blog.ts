import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-forms-frm40735-ora01001-invalid-cursor-troubleshooting';

const content = `
There is nothing quite as challenging as a production-only failure that refuses to replicate in any test environment. Users report it. You reproduce the steps exactly. Nothing happens. Then the call volume spikes again Monday morning.

A particularly frustrating example of this pattern is intermittent Oracle Forms crashes with this error during routine operations — sales order entry, receiving, inventory adjustments — on forms that have worked reliably for years:

\`\`\`
FRM-40735: ON-ERROR trigger raised unhandled exception ORA-01001
\`\`\`

The ORA-01001 code translates to "invalid cursor," which sends most DBAs immediately to custom PL/SQL and personalisations. When the same error appears across multiple unrelated standard Oracle EBS forms, the root cause is almost never in the application code. It is in the infrastructure — specifically, an abrupt disconnection between the Forms server process and the database that leaves an open cursor in an invalid state.

This post explains why this happens, how to capture the evidence you need, and what to fix.

---

## Why FRM-40735 / ORA-01001 Appears

### The Forms runtime architecture

Oracle EBS Forms operates through a three-tier stack:

\`\`\`
Browser / Oracle Forms Applet
        │
        │  HTTPS (Servlet Listener)
        ▼
Forms Services (frmweb / frmservlet)  ←── application server
        │
        │  Oracle Net / SQL*Net
        ▼
Oracle Database  (APPS schema)
\`\`\`

The \`frmweb\` process on the application server maintains a persistent database session for the life of the Forms user session. Every form action — querying records, posting changes, navigating between blocks — uses a named cursor that is opened and held within that session.

### How the cursor becomes invalid

When \`frmweb\` is terminated externally while a user is mid-transaction:

1. The OS kills the \`frmweb\` process (SIGKILL, SIGTERM, or session-kill script)
2. The Forms runtime loses its reference to the open cursor
3. On its next attempt to fetch from that cursor, the runtime receives ORA-01001
4. The ON-ERROR trigger in the form fires and raises an unhandled exception — FRM-40735

The form crashes. The user sees the combined error string. Because the cursor state is session-specific, the problem cannot be reproduced unless you can replicate the exact process-kill sequence that occurred in production.

---

## The Three Most Common Causes

### 1. OS-level session-kill scripts

Environment maintenance scripts that sweep idle processes are the most frequent root cause. A script designed to free resources by killing long-idle parent navigation processes will kill the user's Forms session even if the user is actively working inside a sub-form. From the script's perspective, the parent navigation form has not received input in N minutes. From the user's perspective, they are in the middle of entering a sales order.

\`\`\`bash
# Typical pattern — script targets processes idle for over 30 minutes
# If the login menu is the parent, it looks idle even during active sub-form use
ps aux | awk '\$10 > "0:30" && /frmweb/' | awk '{print \$2}' | xargs kill -9
\`\`\`

### 2. Database IDLE_TIME profile restriction

Oracle database profiles can enforce an \`IDLE_TIME\` limit (in minutes) on sessions. If the application server's database session is classified under a profile with an aggressive \`IDLE_TIME\`, the database pmon process will terminate it after the configured period — even if the user is actively entering data in a form that has not yet committed.

\`\`\`sql
-- Check which profile the APPS schema session is using
SELECT s.username, s.profile
FROM   dba_users s
WHERE  s.username IN ('APPS', 'APPLSYS');

-- Check the IDLE_TIME limit on that profile
SELECT p.profile, p.resource_name, p.limit
FROM   dba_profiles p
WHERE  p.resource_name = 'IDLE_TIME'
ORDER  BY p.profile;
\`\`\`

An \`IDLE_TIME\` of 10 or 15 minutes will intermittently kill Forms sessions during periods when the user pauses data entry — looking up a customer number, taking a phone call, waiting for a colleague to provide information.

### 3. Network timeout / TCP keepalive expiry

Long-idle connections can be dropped by firewalls or load balancers that enforce TCP idle-session timeouts. When the TCP connection between the Forms server and the database is silently dropped by an intermediate network device, subsequent fetch attempts return ORA-01001 because the cursor handle is no longer valid on the database side.

\`\`\`bash
# Check sqlnet.ora on the application server
cat \$TNS_ADMIN/sqlnet.ora | grep -iE 'expire_time|timeout|keepalive'

# Relevant parameter — sets TCP keepalive probe interval in minutes
# SQLNET.EXPIRE_TIME = 10  ← sends keepalive probes every 10 minutes
\`\`\`

---

## Investigation: Capturing Evidence

The default Forms configuration suppresses diagnostic output when a session terminates abnormally. Before you can identify the kill source, you need to enable crash trace collection.

### Enable FORMS_CATCHTERM

\`\`\`bash
# Application server — show current setting
grep FORMS_CATCHTERM \$INST_TOP/ora/10.1.2/forms/server/default.env

# If it returns 0 or is absent, edit the file:
# Located at: \$INST_TOP/ora/10.1.2/forms/server/default.env
\`\`\`

\`\`\`
# In default.env — add or modify this line:
FORMS_CATCHTERM=1
\`\`\`

With this set to 1, Forms writes a trace file to \`FORMS_TRACE_DIR\` whenever a session terminates abnormally. Sessions that end normally do not generate trace files — there is no performance impact on healthy sessions, and new sessions pick up the change without a middle-tier bounce.

### Identify the trace directory

\`\`\`bash
grep FORMS_TRACE_DIR \$INST_TOP/ora/10.1.2/forms/server/default.env

# Default if not explicitly set:
echo \$ORACLE_HOME/forms/trace
ls -lhrt \$ORACLE_HOME/forms/trace/ 2>/dev/null | tail -20

# Or check the instance trace directory
ls -lhrt \$INST_TOP/logs/forms/trace/ 2>/dev/null | tail -20
\`\`\`

### Read a crash trace

When a user reports FRM-40735, correlate the timestamp of their report with the most recently modified trace file:

\`\`\`bash
# Find trace files created in the last hour
TRACE_DIR=\$(grep FORMS_TRACE_DIR \$INST_TOP/ora/10.1.2/forms/server/default.env | cut -d= -f2)
find "\$TRACE_DIR" -name "*.trc" -newer "\$(date -d '1 hour ago' +%Y%m%d)" 2>/dev/null | sort -t_ -k2 | tail -10

# Read the most recent
LATEST_TRC=\$(ls -t "\$TRACE_DIR"/*.trc 2>/dev/null | head -1)
cat "\$LATEST_TRC"
\`\`\`

**What to look for in the trace:**

| Trace content | Indicates |
|---|---|
| \`Received signal 9 (SIGKILL)\` | OS or script explicitly killed the process |
| \`Received signal 15 (SIGTERM)\` | Graceful kill from maintenance script |
| \`ORA-03113: end-of-file on communication channel\` | TCP connection dropped before Oracle Net keepalive |
| \`ORA-02396: exceeded maximum idle time\` | Database IDLE_TIME profile enforced |
| No signal line — clean exit logged | Check if session-kill script was the culprit |

---

## Fixes by Root Cause

### Fix 1: Disable or reschedule aggressive kill scripts

Once you identify cron-based session-kill scripts on the application or database servers:

\`\`\`bash
# List all crontabs on the application server
crontab -l                     # applmgr user
sudo crontab -l                # root
sudo crontab -u oracle -l      # oracle OS user

# Show scheduled tasks from /etc/cron.d
ls -la /etc/cron.d/
cat /etc/cron.d/ebs_maintenance 2>/dev/null

# Temporarily disable a specific script for the observation window
# Comment out the cron entry — do not delete it
crontab -e
# Place a # before the kill-script line
\`\`\`

If the script must continue running, modify it to exclude active sub-form child processes:

\`\`\`bash
# Safer approach — check whether the frmweb process has child connections before killing
for PID in \$(pgrep -x frmweb); do
  CHILDREN=\$(pgrep -P \$PID | wc -l)
  IDLE_MIN=\$(((\$(date +%s) - \$(stat -c %Y /proc/\$PID 2>/dev/null || echo 0)) / 60))
  if [ "\$CHILDREN" -eq 0 ] && [ "\$IDLE_MIN" -gt 60 ]; then
    echo "Killing idle frmweb PID \$PID (idle \$IDLE_MIN min, no children)"
    kill -15 "\$PID"
  fi
done
\`\`\`

### Fix 2: Adjust the database IDLE_TIME profile

\`\`\`sql
-- Create a dedicated EBS application session profile with no idle time limit
CREATE PROFILE ebs_appsession_profile LIMIT
  IDLE_TIME          UNLIMITED
  CONNECT_TIME       UNLIMITED
  SESSIONS_PER_USER  DEFAULT
  FAILED_LOGIN_ATTEMPTS 10
  PASSWORD_LIFE_TIME UNLIMITED;

-- Apply it to the APPS schema (requires DBA privilege)
ALTER USER apps PROFILE ebs_appsession_profile;

-- Verify
SELECT username, profile FROM dba_users WHERE username = 'APPS';
SELECT profile, resource_name, limit FROM dba_profiles
WHERE  profile = 'EBS_APPSESSION_PROFILE'
ORDER  BY resource_name;
\`\`\`

Do not apply \`UNLIMITED\` to DBA accounts or end-user named schemas. The profile change is targeted at the application tier connection user (APPS).

### Fix 3: Enable SQL*Net keepalive probes

Add this parameter to \`sqlnet.ora\` on both the application server and database server:

\`\`\`bash
# Application server: \$TNS_ADMIN/sqlnet.ora
# Database server: \$ORACLE_HOME/network/admin/sqlnet.ora
\`\`\`

\`\`\`
# Send TCP keepalive probes every 10 minutes
# This prevents firewalls and load balancers from silently dropping idle connections
SQLNET.EXPIRE_TIME = 10
\`\`\`

\`\`\`bash
# Apply on application server — no bounce required, takes effect on next connection
grep SQLNET.EXPIRE_TIME \$TNS_ADMIN/sqlnet.ora || \
  echo "SQLNET.EXPIRE_TIME = 10" >> \$TNS_ADMIN/sqlnet.ora
\`\`\`

### Fix 4: Configure the Forms idle timeout to match infrastructure limits

If the network or database is enforcing a 30-minute idle limit, set the Forms session timeout to expire the session cleanly at 25 minutes — giving it a graceful exit before the infrastructure kills it ungracefully.

In \`default.env\`:

\`\`\`
# \$INST_TOP/ora/10.1.2/forms/server/default.env
# Set Forms session idle timeout (seconds) — set below the network/DB idle limit
FORMS_TIMEOUT=1500
\`\`\`

At 1,500 seconds (25 minutes), Forms will present the user with a timeout message and end the session cleanly before the TCP connection or DB profile kills it without warning.

---

## Observation Procedure

After enabling \`FORMS_CATCHTERM=1\`, collect evidence over a 48-hour observation window before making permanent changes.

1. **Enable FORMS_CATCHTERM** in default.env
2. **Document the FORMS_TRACE_DIR path** — you will monitor this directory
3. **Temporarily disable maintenance scripts** — comment out kill-script cron entries
4. **Ask users to record exact time** when FRM-40735 appears — correlate with trace file timestamps
5. **Run the monitoring script** (below) to alert on new crash traces
6. **After 48 hours** — review all trace files, identify the signal source, implement the appropriate fix

---

## Summary

FRM-40735 / ORA-01001 during standard Oracle EBS operations is almost always caused by the \`frmweb\` process being killed externally rather than by application code errors. The three infrastructure causes are OS-level session-kill scripts that misidentify active sub-form users as idle, database IDLE_TIME profile restrictions set aggressively low, and TCP keepalive gaps that allow intermediate network devices to silently drop long-running connections. Enabling \`FORMS_CATCHTERM=1\` in \`default.env\` makes the Forms runtime write a trace file on abnormal termination, revealing the exact kill signal and its source. Once the source is identified, the fix is either modifying the kill script to check for active child processes, setting \`IDLE_TIME=UNLIMITED\` on the APPS user profile, or adding \`SQLNET.EXPIRE_TIME=10\` to prevent silent TCP drops. None of these changes require a full middle-tier restart and all can be made during a maintenance window once evidence collection confirms the root cause.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'EBS Forms FRM-40735 / ORA-01001: Diagnosing and Fixing Invalid Cursor Crashes',
    slug,
    excerpt: 'Intermittent FRM-40735 ON-ERROR trigger with ORA-01001 (invalid cursor) in Oracle EBS Forms is almost always caused by the frmweb process being killed externally — by OS maintenance scripts, database IDLE_TIME profile restrictions, or silent TCP connection drops. Covers FORMS_CATCHTERM trace collection, crash log analysis, three root-cause fixes, and an observation procedure for production-only failures.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
