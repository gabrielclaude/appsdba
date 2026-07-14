import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-forms-blank-frm40735-ora06502-runbook';

const content = `
This runbook covers the operational response to blank EBS Forms sessions accompanied by "unable to communicate with runtime process" messages in the JServ log. Work through phases in order — each phase narrows scope before escalating to more invasive investigation.

---

## Phase 1: Establish Scope of Impact

Before touching infrastructure, determine how many users are affected. This single number dictates every subsequent decision.

### 1.1 Query active EBS sessions

\`\`\`sql
SELECT COUNT(*) AS active_sessions
FROM   icx_sessions
WHERE  disabled_flag = 'N'
  AND  last_connect >= SYSDATE - (30/1440);
\`\`\`

### 1.2 Count reported blank-form users

Contact the help desk or query the incident system: how many users have opened tickets for blank forms in the last hour?

**Decision gate:**

| Affected count | Next step |
|----------------|-----------|
| Majority of users | Go to Phase 2 (infrastructure) |
| 1–5 users out of hundreds | Skip to Phase 4 (FND Debug) |

---

## Phase 2: Infrastructure Triage (global failures only)

Run on each application node. Skip this phase if fewer than ~10% of users are affected.

### 2.1 OS memory and OOM checks

\`\`\`bash
# Solaris
dmesg | egrep -i "killed|oom|segfault"
grep -i oom /var/adm/messages
grep -i killed /var/adm/messages

# Linux
dmesg | grep -E "oom|killed|segfault"
grep -i oom-killer /var/log/messages
\`\`\`

No output expected. Any OOM kill output points to memory pressure — check swap and JVM heap before continuing.

### 2.2 JServ log for crash signals

\`\`\`bash
LOG_DIR=\${IAS_ORACLE_HOME}/Apache/Jserv/logs

grep -i "SIG"          \${LOG_DIR}/FormsGroup*.stdout
grep -i "Segmentation" \${LOG_DIR}/FormsGroup*.stdout
grep -i "ORA-7445"     \${LOG_DIR}/FormsGroup*.stdout
grep -i "ORA-600"      \${LOG_DIR}/FormsGroup*.stdout
\`\`\`

Any ORA-600 or ORA-7445 output requires an Oracle SR. ORA-7445 with a signal number points to a Forms binary bug.

### 2.3 Forms process status

\`\`\`bash
ps -ef | grep f60webmx | grep -v grep
ps -ef | grep jserv    | grep -v grep
\`\`\`

Verify: JServ is running, f60webmx processes are present, no processes in zombie state (\`Z\` in the STAT column).

### 2.4 JVM heap

Check JVM heap parameters in \`jserv.conf\` or the startup wrapper:

\`\`\`bash
grep -i "Xmx\|Xms\|heap" \${IAS_ORACLE_HOME}/Apache/Jserv/conf/jserv.conf
\`\`\`

Compare the configured max heap against available physical memory. If processes are running but sessions abort immediately after startup, a full heap is unlikely — continue to Phase 3.

---

## Phase 3: Confirm the Real Error

The JServ "unable to communicate with runtime process" message is a consequence, not a cause. Look for the actual Forms error in the applet status bar or in Forms trace.

### 3.1 Reproduce in a controlled session

Ask one affected user to:

1. Clear browser Java cache (Java Control Panel → General → Delete Files)
2. Log in to EBS
3. Navigate to the form that shows blank
4. Immediately read the **status bar** at the bottom of the Forms applet window before the session closes

The status bar will briefly display the real error before the session dies. Common pattern:

\`\`\`
FRM-40735: WHEN-NEW-FORM-INSTANCE trigger raised unhandled exception ORA-06502
\`\`\`

If the user cannot capture the status bar, enable Forms client-side logging:

\`\`\`
http://<host>:<port>/dev60cgi/f60cgi?play=&config=<appname>&record=forms&log=1
\`\`\`

The log file on the client will contain the full error sequence including the ORA number.

### 3.2 Confirm FRM-40735 in the Forms trace (optional)

If you have access to a Forms server trace, search for TRIGGER events:

\`\`\`bash
grep -i "FRM-40735\|ORA-06502\|WHEN-NEW-FORM" \${IAS_ORACLE_HOME}/forms/trace/*.trc 2>/dev/null
\`\`\`

---

## Phase 4: FND Debug Tracing

Enable FND diagnostics **at the User level** for the affected account. This traces only that user's session and has no impact on anyone else.

### 4.1 Enable FND Debug

Log in as System Administrator. Navigate to **Profile > System**. Query the affected username. At the **User** level, set:

| Profile Option | Value |
|----------------|-------|
| FND: Debug Log Enabled | Yes |
| FND: Debug Log Level | Exception |
| FND: Debug Module | % |

### 4.2 Reproduce the issue

Ask the user to log out completely (not just close the browser — end the EBS session), then log back in and navigate to the problem form. Record the exact timestamp.

### 4.3 Query the trace

\`\`\`sql
-- Replace &affected_username and &ts with actual values
SELECT log_sequence,
       module,
       message_text,
       timestamp
FROM   fnd_log_messages
WHERE  user_id = (
         SELECT user_id
         FROM   fnd_user
         WHERE  user_name = UPPER('&affected_username')
       )
  AND  timestamp >= TO_DATE('&ts', 'YYYY-MM-DD HH24:MI:SS')
ORDER BY log_sequence DESC;
\`\`\`

Look for the last entries logged before the session aborted. The MODULE column will name the package body and the MESSAGE_TEXT will show the variable state at the point of failure.

### 4.4 Disable FND Debug immediately after capture

| Profile Option | Value |
|----------------|-------|
| FND: Debug Log Enabled | No |
| FND: Debug Log Level | (blank) |
| FND: Debug Module | (blank) |

---

## Phase 5: Root Cause Identification

### 5.1 If the trace points to a standard EBS package

Check the user's profile options and data for the constraint being violated:

**VARCHAR2 overflow** — the user's profile option value (common culprits: department code, employee number, location name) exceeds the variable's declared length:

\`\`\`sql
SELECT profile_option_name,
       profile_option_value
FROM   fnd_profile_option_values pov
JOIN   fnd_profile_options po ON po.profile_option_id = pov.profile_option_id
WHERE  pov.level_id = 10004  -- User level
  AND  pov.level_value = (
         SELECT user_id FROM fnd_user WHERE user_name = UPPER('&affected_username')
       );
\`\`\`

**NULL where NOT NULL expected** — check HR assignment, employee record, or email address:

\`\`\`sql
SELECT employee_id, email_address, organization_id, primary_flag
FROM   per_all_assignments_f
WHERE  person_id = (
         SELECT employee_id FROM fnd_user WHERE user_name = UPPER('&affected_username')
       )
  AND  SYSDATE BETWEEN effective_start_date AND effective_end_date
  AND  primary_flag = 'Y';
\`\`\`

A missing row here (no active assignment) causes NULLs to flow into form initialization code that declares its variables NOT NULL.

### 5.2 If the trace points to CUSTOM.pll

The CUSTOM package runs for every form event. To confirm CUSTOM.pll is the trigger, bypass it without a code change:

\`\`\`
http://<host>:<port>/dev60cgi/f60cgi?play=&config=<appname>&custom_status=UNKNOWN
\`\`\`

If the form now loads cleanly for the affected user, CUSTOM.pll is confirmed.

Identify the event and form where it fails by enabling silent tracing in CUSTOM.pll (see Phase 6 before making any CUSTOM.pll change).

---

## Phase 6: CUSTOM.pll Safe Debugging

### 6.1 Add user-gated debug output

Never add unconditional code to CUSTOM.pll. Gate everything by a test account:

\`\`\`sql
DECLARE
  v_user VARCHAR2(100);
BEGIN
  v_user := FND_PROFILE.VALUE('USERNAME');
  IF v_user = 'DBA_DEBUG_ACCOUNT' THEN
    FND_MESSAGE.SET_STRING(
      'DEBUG [' || event_name || ']: form=' ||
      name_in('SYSTEM.CURRENT_FORM') ||
      ' block=' || name_in('SYSTEM.CURRENT_BLOCK')
    );
    FND_MESSAGE.SHOW;
  END IF;
END;
\`\`\`

### 6.2 FND_LOG silent tracing

For production without popup interruptions, write to FND_LOG_MESSAGES instead:

\`\`\`sql
IF FND_LOG.LEVEL_EXCEPTION >= FND_LOG.G_CURRENT_RUNTIME_LEVEL THEN
  FND_LOG.STRING(
    LOG_LEVEL => FND_LOG.LEVEL_EXCEPTION,
    MODULE    => 'custom.pll.debug.when_new_form_instance',
    MESSAGE   => 'User: '  || FND_PROFILE.VALUE('USERNAME') ||
                 ' Form: ' || name_in('SYSTEM.CURRENT_FORM')
  );
END IF;
\`\`\`

Enable debug profile options only for your test account (Phase 4.1 procedure). Query results:

\`\`\`sql
SELECT timestamp, module, message_text
FROM   fnd_log_messages
WHERE  module LIKE 'custom.pll.%'
ORDER BY log_sequence DESC;
\`\`\`

### 6.3 Safe compile procedure

Never edit CUSTOM.pll in \$AU_TOP while users are active. Always compile from a working copy:

\`\`\`bash
# 1. Copy source to working directory
cp \${AU_TOP}/resource/CUSTOM.pll /tmp/CUSTOM_work.pll

# 2. Edit /tmp/CUSTOM_work.pll with your fix

# 3. Compile the working copy — check exit code
f60gen module=/tmp/CUSTOM_work.pll \\
        userid=apps/<apps_password> \\
        output_file=/tmp/CUSTOM_work.plx \\
        module_type=LIBRARY

if [ \$? -ne 0 ]; then
  echo "Compile failed — do not deploy"
  exit 1
fi

# 4. Verify the .plx was produced
ls -lh /tmp/CUSTOM_work.plx

# 5. Deploy only after successful compile
cp /tmp/CUSTOM_work.plx \${AU_TOP}/resource/CUSTOM.plx
\`\`\`

New sessions pick up the updated \`.plx\` immediately. Existing sessions continue using the in-memory copy until they re-authenticate.

---

## Phase 7: f60webmx Memory Leak Assessment

Run this check if the session abort rate increases gradually over days rather than appearing suddenly for specific users. Gradual increase points to memory exhaustion.

### 7.1 Monitor RSS per process

\`\`\`bash
# EBS 11i (f60webmx):
ps -eo pid,ppid,user,vsz,rss,args | grep f60webmx | grep -v grep | sort -nk5

# EBS R12 (frmweb):
ps -eo pid,ppid,user,vsz,rss,args | grep frmweb | grep -v grep | sort -nk5
\`\`\`

| RSS range | Action |
|-----------|--------|
| < 200 MB | Normal |
| 200–400 MB | Monitor — may be a long session |
| > 400 MB | Suspect leak — map to user (Phase 7.2) |
| > 500 MB | Terminate — swap risk |

### 7.2 Map OS PID to EBS user

\`\`\`sql
-- Replace &os_pid with the PID from ps output
SELECT u.user_name,
       s.process    AS client_os_pid,
       p.spid       AS db_server_pid,
       s.program,
       s.status,
       s.last_call_et AS idle_seconds
FROM   v\$session s
JOIN   v\$process p ON s.paddr = p.addr
LEFT JOIN fnd_user u ON TO_NUMBER(s.client_identifier) = u.user_id
WHERE  s.process = '&os_pid';
\`\`\`

If \`idle_seconds\` is above 3600 (1 hour), the session is orphaned and safe to terminate.

### 7.3 Check FORMS_TIMEOUT configuration

\`\`\`bash
grep -i heartbeat   \${IAS_ORACLE_HOME}/forms60/server/appsweb.cfg
grep -i connectMode \${IAS_ORACLE_HOME}/forms60/server/appsweb.cfg
grep -i max_requests \${IAS_ORACLE_HOME}/Apache/Jserv/conf/jserv.properties
\`\`\`

Recommended values:

\`\`\`
# appsweb.cfg
heartbeat=3
connectMode=socket

# jserv.properties
wrapper.max_requests=5000
\`\`\`

A \`max_requests\` setting causes JServ to recycle the JVM after N requests, clearing accumulated memory fragmentation.

---

## Automation Script

Save as \`ebs_forms_frm40735_triage.sh\`. Run on each application node as the Oracle OS user.

\`\`\`bash
#!/bin/bash
# EBS Forms blank session triage — FRM-40735 / ORA-06502 investigation
# Usage: ./ebs_forms_frm40735_triage.sh [jserv_log_dir]

LOG_DIR=\${1:-\${IAS_ORACLE_HOME}/Apache/Jserv/logs}
REPORT=/tmp/frm40735_triage_\$(date +%Y%m%d_%H%M%S).txt

echo "============================================================" | tee "\${REPORT}"
echo "EBS Forms FRM-40735 Triage — \$(date)"                        | tee -a "\${REPORT}"
echo "Host: \$(hostname)"                                           | tee -a "\${REPORT}"
echo "============================================================" | tee -a "\${REPORT}"

# --- OS Memory ---
echo "" | tee -a "\${REPORT}"
echo "[1] OS Memory Pressure" | tee -a "\${REPORT}"
echo "--------------------------------------------------------------" | tee -a "\${REPORT}"
SWAP_FREE=\$(free -m 2>/dev/null | awk '/^Swap/{print \$4}')
if [ -n "\${SWAP_FREE}" ]; then
  echo "Swap free (MB): \${SWAP_FREE}" | tee -a "\${REPORT}"
  [ "\${SWAP_FREE}" -lt 512 ] && echo "WARNING: Less than 512 MB swap free" | tee -a "\${REPORT}"
fi

OOM_HITS=\$(dmesg 2>/dev/null | grep -ci "oom\|killed\|segfault")
echo "OOM/kill/segfault hits in dmesg: \${OOM_HITS}" | tee -a "\${REPORT}"
[ "\${OOM_HITS}" -gt 0 ] && echo "WARNING: Possible OS kill events detected — check dmesg output" | tee -a "\${REPORT}"

# --- JServ Crash Signals ---
echo "" | tee -a "\${REPORT}"
echo "[2] JServ Log — Crash Signals" | tee -a "\${REPORT}"
echo "--------------------------------------------------------------" | tee -a "\${REPORT}"
if [ -d "\${LOG_DIR}" ]; then
  for pattern in "SIG" "Segmentation" "ORA-7445" "ORA-600"; do
    COUNT=\$(grep -ic "\${pattern}" "\${LOG_DIR}"/FormsGroup*.stdout 2>/dev/null)
    echo "\${pattern}: \${COUNT} hits" | tee -a "\${REPORT}"
    [ "\${COUNT}" -gt 0 ] && grep -i "\${pattern}" "\${LOG_DIR}"/FormsGroup*.stdout | tail -5 | tee -a "\${REPORT}"
  done
else
  echo "Log directory not found: \${LOG_DIR}" | tee -a "\${REPORT}"
fi

# --- Session Abort Count ---
echo "" | tee -a "\${REPORT}"
echo "[3] JServ Log — Session Abort Rate" | tee -a "\${REPORT}"
echo "--------------------------------------------------------------" | tee -a "\${REPORT}"
if [ -d "\${LOG_DIR}" ]; then
  ABORT_COUNT=\$(grep -c "unable to communicate with runtime process" "\${LOG_DIR}"/FormsGroup*.stdout 2>/dev/null)
  echo "Total 'unable to communicate' messages: \${ABORT_COUNT}" | tee -a "\${REPORT}"
  echo "Most recent 5 abort messages:" | tee -a "\${REPORT}"
  grep "unable to communicate with runtime process" "\${LOG_DIR}"/FormsGroup*.stdout 2>/dev/null | tail -5 | tee -a "\${REPORT}"
fi

# --- Forms Process Status ---
echo "" | tee -a "\${REPORT}"
echo "[4] Forms Runtime Process Status" | tee -a "\${REPORT}"
echo "--------------------------------------------------------------" | tee -a "\${REPORT}"
echo "f60webmx processes:" | tee -a "\${REPORT}"
ps -eo pid,vsz,rss,stat,args 2>/dev/null | grep f60webmx | grep -v grep | tee -a "\${REPORT}"
echo "" | tee -a "\${REPORT}"
echo "frmweb processes (R12):" | tee -a "\${REPORT}"
ps -eo pid,vsz,rss,stat,args 2>/dev/null | grep frmweb | grep -v grep | tee -a "\${REPORT}"

# --- High RSS Warning ---
echo "" | tee -a "\${REPORT}"
echo "[5] f60webmx RSS over 400 MB (memory leak candidates)" | tee -a "\${REPORT}"
echo "--------------------------------------------------------------" | tee -a "\${REPORT}"
ps -eo pid,vsz,rss,args 2>/dev/null | grep -E "f60webmx|frmweb" | grep -v grep | awk '{ if (\$3+0 > 409600) print "PID "\$1" RSS "\$3/1024" MB — INVESTIGATE" }' | tee -a "\${REPORT}"

# --- FRM-40735 Detection ---
echo "" | tee -a "\${REPORT}"
echo "[6] JServ Log — FRM-40735 Hits" | tee -a "\${REPORT}"
echo "--------------------------------------------------------------" | tee -a "\${REPORT}"
if [ -d "\${LOG_DIR}" ]; then
  FRM_COUNT=\$(grep -c "FRM-40735" "\${LOG_DIR}"/FormsGroup*.stdout 2>/dev/null)
  echo "FRM-40735 messages: \${FRM_COUNT}" | tee -a "\${REPORT}"
  if [ "\${FRM_COUNT}" -gt 0 ]; then
    echo "Sample FRM-40735 entries:" | tee -a "\${REPORT}"
    grep "FRM-40735" "\${LOG_DIR}"/FormsGroup*.stdout 2>/dev/null | tail -10 | tee -a "\${REPORT}"
  fi
fi

# --- FND Debug SQL ---
echo "" | tee -a "\${REPORT}"
echo "[7] FND Debug SQL (run in EBS database as APPS)" | tee -a "\${REPORT}"
echo "--------------------------------------------------------------" | tee -a "\${REPORT}"
cat <<'ENDSQL' | tee -a "\${REPORT}"

-- Enable FND Debug for affected user (run in SQL*Plus as APPS):
-- Set at USER level via EBS GUI: Profile > System > [username] > User level
--   FND: Debug Log Enabled  = Yes
--   FND: Debug Log Level    = Exception
--   FND: Debug Module       = %
--
-- After reproduction, query:

SELECT log_sequence,
       module,
       message_text,
       timestamp
FROM   fnd_log_messages
WHERE  user_id = (
         SELECT user_id FROM fnd_user WHERE user_name = UPPER(:affected_username)
       )
  AND  timestamp >= :reproduction_time
ORDER BY log_sequence DESC;

-- Disable after capture:
--   FND: Debug Log Enabled  = No
--   FND: Debug Log Level    = (blank)
--   FND: Debug Module       = (blank)

ENDSQL

# --- CUSTOM.pll Bypass URL ---
echo "" | tee -a "\${REPORT}"
echo "[8] CUSTOM.pll Bypass Test" | tee -a "\${REPORT}"
echo "--------------------------------------------------------------" | tee -a "\${REPORT}"
cat <<'ENDBYPASS' | tee -a "\${REPORT}"
To test whether CUSTOM.pll is causing the crash, ask the affected user to open:

  http://<host>:<port>/dev60cgi/f60cgi?play=&config=<appname>&custom_status=UNKNOWN

If the form loads cleanly with custom_status=UNKNOWN, CUSTOM.pll is confirmed as the source.
EBS R12 equivalent: set profile 'Diagnostics: Legacy Customization' = No at User level.
ENDBYPASS

echo "" | tee -a "\${REPORT}"
echo "Report saved to: \${REPORT}"
echo "============================================================" | tee -a "\${REPORT}"
\`\`\`

Make the script executable:

\`\`\`bash
chmod +x ebs_forms_frm40735_triage.sh
./ebs_forms_frm40735_triage.sh
\`\`\`

Run on each of the three application nodes and compare the abort counts. A node with significantly more aborts than the others may have been assigned a disproportionate share of the affected users' sessions by the load balancer — or it may have a higher-RSS memory pressure situation independent of the FRM-40735 issue.

---

## Decision Matrix

| Observation | Root cause | Action |
|-------------|------------|--------|
| All users affected, OOM in dmesg | OS memory exhaustion | Bounce nodes, increase swap, tune JVM heap |
| All users affected, ORA-600 in JServ logs | Forms binary defect or DB-layer crash | Open Oracle SR, apply patches |
| 1–5 users, FRM-40735 in status bar | ORA-06502 in WHEN-NEW-FORM-INSTANCE | Phase 4 FND Debug to identify the package and variable |
| CUSTOM.pll bypass (custom_status=UNKNOWN) fixes the issue | CUSTOM.pll code path fails for user-specific data | Phase 6: user-gated debug, identify the event and fix the variable declaration or data |
| Gradual increase over days, high f60webmx RSS | Memory leak in Forms session | Phase 7: cursor audit in CUSTOM.pll, set wrapper.max_requests, tune heartbeat |

---

## Summary

The "unable to communicate with runtime process" JServ message is a tombstone — it is logged after the f60webmx process has already crashed. Do not investigate infrastructure based on that message alone. The diagnostic path is: confirm scope (how many users?) → reproduce and capture the status bar error → enable FND Debug for the specific user → identify the package and line → fix the data or the variable declaration. CUSTOM.pll changes always go through the copy-compile-deploy cycle, never in-place. Memory leak monitoring is a standing preventative task, not a reactive one.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'EBS Forms Blank Window / FRM-40735 Runbook: Scoping, FND Debug Tracing, CUSTOM.pll Diagnosis, and f60webmx Leak Detection',
    slug,
    excerpt: 'Operational runbook for blank EBS Forms sessions and "unable to communicate with runtime process" JServ errors. Covers scope triage (global vs. user-specific), OS/JServ infrastructure checks, FND Debug enablement and log query, CUSTOM.pll safe bypass and production debugging, f60webmx RSS monitoring, and a triage automation script.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
