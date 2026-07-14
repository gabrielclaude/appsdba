import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-forms-blank-frm40735-ora06502-when-new-form-instance';

const content = `
The JServ log starts filling up with one of the most alarming messages an Oracle EBS administrator can see:

\`\`\`
Forms session <4,233> aborted: unable to communicate with runtime process.
Forms session <4,264> aborted: unable to communicate with runtime process.
Forms session <4,257> aborted: unable to communicate with runtime process.
\`\`\`

Simultaneously, users call in to report that their EBS forms are completely blank — the application loads the Forms applet, the window appears, and then nothing. No field labels, no data, no toolbar. A frozen canvas.

The immediate instinct is infrastructure. Load balancer session persistence. JVM heap exhaustion. Firewall terminating idle TCP connections between the Apache/JServ tier and the Forms runtime. These are all legitimate hypotheses, and they are almost always wrong when the failure is this selective.

This post covers a production incident where blank forms and aborted sessions in a 3-node EBS 11.5.10.2 environment led through every infrastructure check before the actual culprit — a single unhandled ORA-06502 exception inside a WHEN-NEW-FORM-INSTANCE trigger — was identified. It also covers the safe techniques for tracing CUSTOM.pll in production and detecting memory leaks in the f60webmx runtime process.

---

## Environment and Initial Symptoms

**EBS version:** 11.5.10.2 (EBS 11i)
**Middle tier:** Three application nodes running Oracle HTTP Server / Apache JServ / Forms 6i (f60webmx runtime)
**Operating system:** Solaris 10 (Oracle Solaris zones)
**Database:** Oracle 10.2.0.5

Affected users saw a completely blank Forms window after navigating to any responsibility. The Forms applet initialized but rendered nothing — no controls, no menu bar content, no status message. Attempting a different responsibility from the Navigator sometimes cleared the issue temporarily.

The JVM stdout log on all three application nodes showed a continuous stream of session abort messages, logged at the JServ layer:

\`\`\`
Forms session <4,233> aborted: unable to communicate with runtime process.
Forms session <4,264> aborted: unable to communicate with runtime process.
Forms session <4,319> aborted: unable to communicate with runtime process.
\`\`\`

A full bounce of all three application nodes did not resolve the issue. Sessions continued aborting after restart.

---

## The Infrastructure Red Herrings

The first line of investigation for "unable to communicate with runtime process" errors always goes to infrastructure. These checks are correct to perform first, and in this case, they all came back clean:

### OS memory and process signals

On each Solaris application node, checking for kernel OOM kills, segmentation faults, and process signals:

\`\`\`bash
dmesg | egrep -i "killed|oom|segfault"
grep -i oom /var/adm/messages
grep -i killed /var/adm/messages
grep -i segfault /var/adm/messages
\`\`\`

All returned empty. No OOM kills. No segmentation faults. The OS was not killing f60webmx processes.

### JServ log for signal errors and ORA-600

\`\`\`bash
cd \$IAS_ORACLE_HOME/Apache/Jserv/logs
grep -i "SIG" FormsGroup*.stdout
grep -i "Segmentation" FormsGroup*.stdout
grep -i ORA-7445 FormsGroup*.stdout
grep -i ORA-600 FormsGroup*.stdout
\`\`\`

No ORA-600 or ORA-7445 errors. No signal-related crashes. No segmentation faults at the JVM layer.

### Forms process inspection

\`\`\`bash
ps -ef | grep f60webmx
ps -ef | grep frmweb
ps -ef | grep jserv
\`\`\`

Multiple f60webmx processes were running normally. The JServ process was healthy. No processes were in zombie state or consuming abnormal CPU.

### Load balancer and network

The load balancer configuration was reviewed. Session persistence was enabled. No firewall rules had recently changed. No network timeout policy matched the session abort timeline.

---

## The Critical Clue: Scope of Impact

With all infrastructure checks clear, the question became: who exactly was affected?

Out of more than 400 active EBS users, only two reported the blank form issue.

This single data point changes everything. A load balancer misconfiguration, a JVM memory leak, a network firewall terminating idle connections — any infrastructure-layer failure affects users broadly, typically on specific nodes or subnets. A failure that targets exactly two users while hundreds of others work normally is not an infrastructure failure. It is a data failure: something specific to those users' records, profile options, or session context is triggering a code path that fails.

---

## The Real Error: FRM-40735 and ORA-06502

When an affected user's session was monitored at the Forms applet level, the Forms window status bar — typically a single-line text area at the bottom of the applet — briefly displayed an error before the session died:

\`\`\`
FRM-40735: WHEN-NEW-FORM-INSTANCE trigger raised unhandled exception ORA-06502
\`\`\`

This is the root cause. Everything else — the blank window, the "unable to communicate with runtime process" messages — is a consequence.

### ORA-06502: PL/SQL: numeric or value error

ORA-06502 is raised when PL/SQL attempts an operation that violates a value constraint:

- Assigning a string longer than the declared VARCHAR2 length: \`v_name VARCHAR2(20) := some_value_that_is_100_chars\`
- Assigning NULL to a variable declared \`NOT NULL\`
- A character-to-number conversion that encounters a non-numeric value
- A character-to-date conversion against a malformed date string
- Arithmetic operations producing a result outside the variable's declared numeric precision

In the WHEN-NEW-FORM-INSTANCE trigger, this happens the moment the form loads. The trigger fires before the user sees anything — before any field labels render, before any data appears. The exception is raised, the trigger aborts unhandled, and the Forms runtime process (f60webmx) terminates the session.

### The error cascade

\`\`\`
User logs in and opens a form
         │
         ▼
WHEN-NEW-FORM-INSTANCE trigger fires
         │
         ▼
PL/SQL executes and encounters ORA-06502
(user-specific data violates a variable constraint)
         │
         ▼
Exception is unhandled — trigger exits abnormally
         │
         ▼
Oracle Forms runtime process (f60webmx) crashes the session
         │
         ▼
JServ loses socket connection to the dead runtime process
         │
         ▼
JServ logs: "Forms session <N> aborted: unable to communicate with runtime process"
         │
         ▼
User sees: blank window, then session dies
\`\`\`

The "unable to communicate" message in the JServ log is logged **after** the crash. It is a consequence, not a cause. Searching for infrastructure failures based on that message alone sends the investigation in the wrong direction.

### Why only two users?

The ORA-06502 fires because of something specific to those users' data. Common causes in WHEN-NEW-FORM-INSTANCE:

- A user profile option value that is longer than expected — for example, a custom profile option that stores a department code, and those two users have unusually long values that exceed what the PL/SQL variable was declared to hold
- A NULL value in a mandatory field used during form initialization — the users have a missing email address, employee number, or HR assignment that a standard startup query expects to be populated
- A date value in a user-specific table that is stored in an unexpected format, failing a TO_DATE conversion inside the trigger
- Data in a personalization or customization that was not validated before saving, and now fails a type-check on load

---

## Tracing the Root Cause with FND Debug

To identify the exact PL/SQL object and line number raising the ORA-06502, enable FND Diagnostics for the affected user only. This generates a detailed trace into the FND_LOG_MESSAGES table without affecting any other user.

### Step 1: Enable FND Debug for the affected user

Log in to EBS as System Administrator. Navigate to **Profile > System**. Query the affected username and set the following at the **User** level:

| Profile Option | Value |
|----------------|-------|
| FND: Debug Log Enabled | Yes |
| FND: Debug Log Level | Exception |
| FND: Debug Module | % |

Setting these at the User level ensures no other session is affected.

### Step 2: Reproduce the issue

Ask the affected user to log out, clear browser and Java cache, log back in, and navigate to the form that produces the blank window. Record the exact timestamp.

### Step 3: Query FND_LOG_MESSAGES

\`\`\`sql
SELECT log_sequence,
       module,
       message_text,
       timestamp
FROM   fnd_log_messages
WHERE  user_id = (SELECT user_id FROM fnd_user WHERE user_name = UPPER('&affected_username'))
  AND  timestamp >= TO_DATE('&reproduction_timestamp', 'YYYY-MM-DD HH24:MI:SS')
ORDER BY log_sequence DESC;
\`\`\`

The entries logged immediately before the session died will show the package body and line number where the ORA-06502 originated. Common locations:

- \`CUSTOM\` package (CUSTOM.pll)
- A standard Oracle initialization package that queries user-profile data during form startup
- A form personalization's condition expression

### Step 4: Disable debug logging

After capturing the log, immediately reset the profile options to avoid unnecessary overhead:

| Profile Option | Value |
|----------------|-------|
| FND: Debug Log Enabled | No |
| FND: Debug Log Level | (blank) |
| FND: Debug Module | (blank) |

---

## Debugging CUSTOM.pll Safely in Production

If the FND_LOG_MESSAGES trace points to the CUSTOM package, the root cause is in CUSTOM.pll — the shared PL/SQL library that runs for every user on every form. Any change to CUSTOM.pll requires extreme care.

### Rule 1: Gate all debug code by user name

Never add unconditional debug logic or message popups to CUSTOM.pll in a live environment. Every change fires for every user. Gate all debug hooks inside a user check:

\`\`\`sql
DECLARE
  v_user VARCHAR2(100);
BEGIN
  v_user := FND_PROFILE.VALUE('USERNAME');

  IF v_user = 'DBA_TEST_ACCOUNT' THEN
    FND_MESSAGE.SET_STRING('DEBUG [' || event_name || ']: ' ||
                           name_in('SYSTEM.CURRENT_FORM'));
    FND_MESSAGE.SHOW;
  END IF;
END;
\`\`\`

This popup is visible only to \`DBA_TEST_ACCOUNT\`. All other users are unaffected.

### Rule 2: Use FND_LOG for silent tracing

Write debug output to FND_LOG_MESSAGES instead of popup messages. These entries only generate if the user's profile has debug logging enabled:

\`\`\`sql
IF FND_LOG.LEVEL_EXCEPTION >= FND_LOG.G_CURRENT_RUNTIME_LEVEL THEN
  FND_LOG.STRING(
    LOG_LEVEL => FND_LOG.LEVEL_EXCEPTION,
    MODULE    => 'custom.pll.debug.when_new_form_instance',
    MESSAGE   => 'User: ' || FND_PROFILE.VALUE('USERNAME') ||
                 ' Form: ' || name_in('SYSTEM.CURRENT_FORM')
  );
END IF;
\`\`\`

Enable the trace for only your test account via **Profile > System**, then query results:

\`\`\`sql
SELECT timestamp, module, message_text
FROM   fnd_log_messages
WHERE  module LIKE 'custom.pll.%'
ORDER BY log_sequence DESC;
\`\`\`

### Rule 3: Bypass CUSTOM.pll without a code change

To confirm whether CUSTOM.pll is causing the crash, bypass it entirely for a test session by appending the custom_status parameter to the Forms URL:

\`\`\`
http://<hostname>:<port>/dev60cgi/f60cgi?play=&config=<appname>&custom_status=UNKNOWN
\`\`\`

If the form loads cleanly without the custom_status parameter causing issues, CUSTOM.pll is confirmed as the source. In EBS R12, the equivalent is setting the profile option \`Diagnostics: Legacy Customization\` to \`No\` at the User level.

### Rule 4: Safe CUSTOM.pll compilation

Never edit and compile CUSTOM.pll directly in the production AU_TOP. A compile failure mid-execution corrupts the shared runtime object for all active users.

\`\`\`bash
# Step 1: Copy to a working directory
cp \$AU_TOP/resource/CUSTOM.pll /tmp/CUSTOM.pll

# Step 2: Edit and compile in /tmp
# (Use Oracle Forms Builder or f60gen on the working copy)
f60gen module=/tmp/CUSTOM.pll userid=apps/apps output_file=/tmp/CUSTOM.plx module_type=LIBRARY

# Step 3: Verify no errors before deploying
# f60gen returns non-zero exit code on compile error

# Step 4: Copy only the compiled .plx to the live directory
cp /tmp/CUSTOM.plx \$AU_TOP/resource/CUSTOM.plx
\`\`\`

The Forms runtime engine loads the \`.plx\` binary. The \`.pll\` source is only used at compile time.

---

## Detecting f60webmx Memory Leaks

In long-running EBS 11i environments, f60webmx processes accumulate memory over their session lifetime. Left unchecked, individual processes grow from an expected 50–120 MB to 500 MB or more, eventually exhausting swap space and causing cascading aborts across the application tier.

### Monitor RSS and VSZ of Forms runtime processes

\`\`\`bash
# EBS 11i (f60webmx):
ps -eo pid,ppid,user,vsz,rss,args | grep f60webmx | sort -nk5

# EBS R12 (frmweb):
ps -eo pid,ppid,user,vsz,rss,args | grep frmweb | sort -nk5
\`\`\`

Column 4 is VSZ (virtual memory), column 5 is RSS (resident set size). Processes with RSS above 300 MB warrant investigation. Processes above 500 MB should be treated as leaking.

### Map a leaking OS process to an EBS user

\`\`\`sql
SELECT u.user_name,
       s.process    AS client_os_pid,
       p.spid       AS db_server_pid,
       s.program,
       s.status,
       s.last_call_et AS idle_seconds
FROM   v\$session s
JOIN   v\$process p ON s.paddr = p.addr
LEFT JOIN fnd_user u ON TO_NUMBER(s.client_identifier) = u.user_id
WHERE  s.process = '&os_pid_from_ps_output';
\`\`\`

This identifies which EBS user owns the leaking process and how long it has been idle, which guides the decision to terminate the session.

### Common PL/SQL causes of f60webmx memory leaks

**1. Unclosed explicit cursors**

Every open cursor pins memory in the process's PGA. Cursors not closed on exception or normal exit accumulate across the session lifetime:

\`\`\`sql
-- Leaking pattern:
OPEN c_vendor;
FETCH c_vendor INTO v_name;
-- Missing: CLOSE c_vendor;

-- Fix: use cursor FOR loops — Oracle closes automatically
FOR r IN (SELECT name FROM po_vendors WHERE vendor_id = p_id) LOOP
  v_name := r.name;
END LOOP;
\`\`\`

**2. Package-level collections that grow unbounded**

Associative arrays declared at the package level persist for the entire session. If rows are added on each form navigation without clearing the collection, memory grows continuously:

\`\`\`sql
-- After processing, explicitly free the collection:
my_global_collection.DELETE;
\`\`\`

**3. FORMS_TIMEOUT not configured**

Users who leave sessions open overnight or over weekends hold f60webmx processes alive indefinitely. In \`appsweb.cfg\`, set a reasonable heartbeat timeout:

\`\`\`
heartbeat=3
connectMode=socket
\`\`\`

And in \`jserv.properties\`, set automatic JVM recycling:

\`\`\`
wrapper.max_requests=5000
\`\`\`

These two parameters ensure orphaned sessions are terminated and JVM instances are periodically refreshed before memory fragmentation accumulates.

---

## Summary

When JServ logs show "Forms session aborted: unable to communicate with runtime process" and users report blank EBS forms, the investigation should split into two paths based on the scope of impact. If the failure is global or affects a broad user population, investigate infrastructure: load balancer session persistence, JVM heap limits, network timeouts, OS memory pressure. If the failure is isolated to a small number of users, investigate data: the user's profile options, responsibility assignments, HR records, and the PL/SQL executed during WHEN-NEW-FORM-INSTANCE initialization.

In the incident covered here, FRM-40735 and ORA-06502 were the real errors. The "unable to communicate with runtime process" message in the JServ log was logged after the f60webmx process crashed — it is a consequence, not a cause. FND Debug tracing at the User level identified the exact package and line number raising the constraint violation in under an hour.

The preventative strategy is straightforward: enable exception-level FND logging by default for a small set of test accounts, run CUSTOM.pll changes through a working-directory compile cycle rather than editing in place, and monitor f60webmx RSS periodically to catch memory growth before it reaches swap exhaustion.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'Oracle EBS Blank Forms and FRM-40735: When "Unable to Communicate with Runtime Process" Is Not an Infrastructure Problem',
    slug,
    excerpt: 'Forms session abort messages in the JServ log and blank EBS forms look like infrastructure failures — load balancer, JVM heap, network timeout. When only two out of 400 users are affected, the real culprit is FRM-40735 / ORA-06502 in the WHEN-NEW-FORM-INSTANCE trigger crashing the f60webmx runtime process. This post traces the full error cascade, the FND Debug procedure for isolating the broken PL/SQL code path, safe CUSTOM.pll debugging techniques for production, and f60webmx memory leak detection.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
