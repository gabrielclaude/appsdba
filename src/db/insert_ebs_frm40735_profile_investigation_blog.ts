import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-frm40735-ora06502-profile-corruption-investigation';

const content = `
When a call comes in reporting blank EBS Forms windows for two specific users out of a 400-user concurrent workload, the investigation has to resist the pull toward infrastructure. The JServ log shows session abort messages. Apache, JServ, and all three Forms runtime nodes are healthy. Load balancer session persistence is in place. Everything at the tier level is fine.

The root is not a network or infrastructure failure — it is a localized data or runtime exception occurring during form initialization. The "Forms session aborted: unable to communicate with runtime process" entries in \`FormsGroup.*.stdout\` are a downstream side-effect: when the f60webmx runtime process aborts due to an unhandled PL/SQL exception, the parent JServ listener servlet loses its socket connection and logs the abortion. The message is a consequence, not a cause.

This post covers the targeted SQL investigation approach for identifying what exactly ORA-06502 is evaluating when WHEN-NEW-FORM-INSTANCE fires for those specific users: profile option corruption, form personalization triggers, FND Debug trace analysis, and a 10046 SQL trace as a secondary fallback.

---

## Environment and Symptom Summary

**EBS version:** 11.5.10.2 (EBS 11i)
**Middle tier:** Three application nodes running Oracle HTTP Server / Apache JServ / Forms 6i
**Database:** Oracle 10.2.0.5
**Active users:** 400+ concurrent, all other users unaffected
**Affected users:** Two specific accounts — blank Forms window on every responsibility

The Forms applet initializes, the window opens, and then renders nothing. No field labels, no menu bar content, no status message. The session dies within a few seconds. The status bar at the bottom of the Forms applet — briefly visible during a live troubleshooting session before the session closes — shows:

\`\`\`
FRM-40735: WHEN-NEW-FORM-INSTANCE trigger raised unhandled exception ORA-06502
\`\`\`

ORA-06502 is PL/SQL: numeric or value error. Common causes at form initialization:

- Assigning a profile option value into a variable declared too short (VARCHAR2 overflow)
- Assigning NULL into a variable declared NOT NULL
- Failing a character-to-number or character-to-date conversion on a user-specific record

With 400 users unaffected, the error is not in the shared code path — it is in the data evaluated for these two users specifically.

---

## Investigation Path 1: User Profile Option Corruption

The WHEN-NEW-FORM-INSTANCE trigger in standard EBS forms calls \`FND_PROFILE.VALUE\` extensively during initialization to load user preferences, responsibility-specific settings, and form behavior options. If a user-level profile option value is longer than the variable declared to receive it, or contains characters that break a type conversion, ORA-06502 fires immediately.

Query the user-level profile option values for the affected accounts:

\`\`\`sql
SELECT u.user_name,
       p.profile_option_name,
       val.profile_option_value,
       val.last_update_date
FROM   fnd_profile_options         p,
       fnd_profile_option_values   val,
       fnd_user                    u
WHERE  val.level_id    = 10004   -- User Level
  AND  val.level_value = u.user_id
  AND  u.user_name IN ('AFFECTED_USER_1', 'AFFECTED_USER_2')
ORDER BY val.last_update_date DESC;
\`\`\`

**What to look for:**

- **Unusually long values** — a department code, cost center, or printer name that was extended beyond what the form's PL/SQL variable can hold. If the standard variable is declared \`VARCHAR2(30)\` and the value is 50 characters, ORA-06502 fires on assignment.
- **Recently changed values** — the \`last_update_date\` descending order brings the most recently modified options to the top. If the issue started on a specific date, look for profile option changes on or before that date.
- **NULL values in options declared mandatory by initialization code** — some forms assume that options like the operating unit, inventory organization, or default warehouse will always return a value. A NULL returned by \`FND_PROFILE.VALUE\` assigned to a \`NOT NULL\` variable raises ORA-06502.
- **Special characters or embedded newlines** — values entered through custom scripts or integrations sometimes contain characters that break TO_NUMBER or TO_DATE conversions inside initialization code.

### Narrow to recently modified profiles

\`\`\`sql
SELECT u.user_name,
       p.profile_option_name,
       val.profile_option_value,
       val.last_update_date,
       LENGTH(val.profile_option_value) AS value_length
FROM   fnd_profile_options         p,
       fnd_profile_option_values   val,
       fnd_user                    u
WHERE  val.level_id    = 10004
  AND  val.level_value = u.user_id
  AND  u.user_name IN ('AFFECTED_USER_1', 'AFFECTED_USER_2')
  AND  val.last_update_date >= SYSDATE - 7
ORDER BY val.last_update_date DESC;
\`\`\`

### Check for NULLs on critical options

\`\`\`sql
SELECT u.user_name,
       p.profile_option_name,
       NVL(val.profile_option_value, '** NULL **') AS profile_value
FROM   fnd_profile_options         p
JOIN   fnd_profile_option_values   val
       ON val.profile_option_id = p.profile_option_id
      AND val.level_id = 10004
RIGHT JOIN fnd_user u
       ON val.level_value = u.user_id
WHERE  u.user_name IN ('AFFECTED_USER_1', 'AFFECTED_USER_2')
  AND  p.profile_option_name IN (
         'MO_OPERATING_UNIT',
         'ORG_ID',
         'DEFAULT_ORG_ID',
         'GL_SET_OF_BKS_ID',
         'INV_CURRENT_ORGANIZATION_ID'
       )
ORDER BY u.user_name, p.profile_option_name;
\`\`\`

A \`** NULL **\` result for \`MO_OPERATING_UNIT\` or \`ORG_ID\` on a user in a multi-org environment will crash most financial forms during initialization.

---

## Investigation Path 2: Form Personalizations

Form Personalizations are PL/SQL expressions stored in the database and executed at runtime during form events — including WHEN-NEW-FORM-INSTANCE. A poorly declared variable or an expression that fails a type conversion inside a personalization raises ORA-06502 just as a compiled trigger would, and the error surfaces identically.

Query active personalizations triggered on WHEN-NEW-FORM-INSTANCE:

\`\`\`sql
SELECT ff.form_name,
       fp.trigger_event,
       fp.trigger_object,
       fp.sequence,
       fp.description,
       fp.enabled,
       fp.condition,
       fp.action_type,
       fp.action_object
FROM   fnd_form_personalizations   fp
JOIN   fnd_form                    ff ON fp.form_id = ff.form_id
WHERE  fp.enabled       = 'Y'
  AND  fp.trigger_event = 'WHEN-NEW-FORM-INSTANCE'
ORDER BY ff.form_name, fp.sequence;
\`\`\`

**What to look for:**

- **Condition expressions that reference user-specific data** — if a condition checks \`FND_PROFILE.VALUE('SOME_OPTION') = 'expected_value'\` and the profile option returns a value longer than the implicit variable Oracle allocates during expression evaluation, ORA-06502 fires.
- **Action objects calling custom packages** — if the personalization action calls a procedure in a custom package that declares a variable too small for what it reads from the database, the error originates in that package but surfaces as FRM-40735 at the Forms layer.
- **Personalizations scoped to the affected users' responsibilities** — narrow by the function or responsibility the affected users are navigating to when the blank form appears.

### Narrow by responsibility

\`\`\`sql
SELECT rr.responsibility_name,
       ff.form_name,
       fp.trigger_event,
       fp.sequence,
       fp.description,
       fp.condition,
       fp.action_type
FROM   fnd_form_personalizations   fp
JOIN   fnd_form                    ff  ON fp.form_id           = ff.form_id
JOIN   fnd_responsibility_tl       rr  ON rr.responsibility_id = fp.responsibility_id
                                      AND rr.language          = USERENV('LANG')
WHERE  fp.enabled       = 'Y'
  AND  fp.trigger_event = 'WHEN-NEW-FORM-INSTANCE'
  AND  rr.responsibility_name LIKE '%&responsibility_keyword%'
ORDER BY ff.form_name, fp.sequence;
\`\`\`

### Check recent personalization changes

\`\`\`sql
SELECT ff.form_name,
       fp.trigger_event,
       fp.sequence,
       fp.last_update_date,
       fp.last_updated_by
FROM   fnd_form_personalizations   fp
JOIN   fnd_form                    ff ON fp.form_id = ff.form_id
WHERE  fp.enabled           = 'Y'
  AND  fp.trigger_event     = 'WHEN-NEW-FORM-INSTANCE'
  AND  fp.last_update_date >= SYSDATE - 14
ORDER BY fp.last_update_date DESC;
\`\`\`

If a personalization was modified within the last two weeks and the blank form issue started around the same time, that personalization is a primary suspect. The \`last_updated_by\` column maps to \`fnd_user.user_id\` — join to \`fnd_user\` to get the name of who changed it.

---

## Investigation Path 3: FND Debug Trace Analysis

FND Diagnostics enabled at the User level writes entries to \`FND_LOG_MESSAGES\` as the session executes. This is the most targeted way to identify the exact package, procedure, and variable assignment raising ORA-06502 — without modifying code, without a code compile cycle, and without affecting any other user.

### Enable FND Debug for the affected user

Log in to EBS as System Administrator. Navigate to **Profile > System**. Query the affected user name. At the **User** level only, set:

| Profile Option | Value |
|----------------|-------|
| FND: Debug Log Enabled | Yes |
| FND: Debug Log Level | Exception |
| FND: Debug Module | % |

Setting these at the User level confines the trace to only that user's session.

### Reproduce the issue

Ask the affected user to:

1. Log out completely (end the EBS session, not just close the browser)
2. Clear Java cache (Java Control Panel → General → Delete Files → All)
3. Log back in
4. Navigate to the form that produces the blank window

Record the reproduction timestamp precisely.

### Query FND_LOG_MESSAGES

\`\`\`sql
SELECT log_sequence,
       module,
       message_text,
       timestamp
FROM   fnd_log_messages
WHERE  user_id = (
         SELECT user_id
         FROM   fnd_user
         WHERE  user_name = UPPER('AFFECTED_USER_1')
       )
  AND  timestamp >= TO_DATE('&reproduction_timestamp', 'YYYY-MM-DD HH24:MI:SS')
ORDER BY log_sequence DESC
FETCH FIRST 50 ROWS ONLY;
\`\`\`

### Interpreting the trace

Work backward from the last entries:

1. **Search for ORA-06502** — the entry containing \`ORA-06502\` will name the MODULE. The MODULE column uses dot-separated naming: \`packagename.procedurename.step\`. This is the exact PL/SQL object where the assignment failed.

2. **Search for FRM-40735** — immediately preceding or co-located with the ORA-06502 entry. The module logged here is the Forms trigger context.

3. **Trace back to the last successfully logged step** — the entry just before the exception shows what was executing when the variable was assigned. If it shows \`FND_PROFILE.VALUE('SOME_OPTION')\`, check that profile option value for the affected user using Investigation Path 1.

4. **Custom package entries** — if the MODULE column shows \`custom.pll.*\` or a package not prefixed with \`FND\` or \`AR\`/\`GL\`/\`PO\` etc., the failure is in a custom PL/SQL library rather than a standard Oracle package.

### Disable FND Debug after capture

| Profile Option | Value |
|----------------|-------|
| FND: Debug Log Enabled | No |
| FND: Debug Log Level | (blank) |
| FND: Debug Module | (blank) |

---

## Investigation Path 4: 10046 SQL Trace (Fallback)

If the FND Debug log does not contain enough detail — for example, the custom package does not write to FND_LOG — use a raw 10046 SQL trace to capture every SQL statement and PL/SQL block executed by the affected user's database session up to the point of abort.

### Step 1: Enable SQL trace via profile option

In **Profile > System** for the affected user, at the **User** level, set:

| Profile Option | Value |
|----------------|-------|
| Initialization SQL Statement - Custom | \`ALTER SESSION SET EVENTS '10046 trace name context forever, level 12'\` |

Level 12 captures bind variables and wait events in addition to SQL text, which is necessary to see what values the PL/SQL was working with when ORA-06502 fired.

### Step 2: Reproduce and locate the trace file

Have the user reproduce the blank form issue. The trace file is written to the \`user_dump_dest\` on the database server:

\`\`\`sql
SELECT value FROM v$parameter WHERE name = 'user_dump_dest';
\`\`\`

The file is named \`<SID>_ora_<os_pid>.trc\`. To find the most recent trace associated with the affected user's session:

\`\`\`sql
SELECT s.sid,
       s.serial#,
       p.spid       AS os_pid,
       s.username,
       s.program,
       s.status,
       s.last_call_et
FROM   v\$session s
JOIN   v\$process p ON s.paddr = p.addr
WHERE  s.username = UPPER('AFFECTED_USER_1')
  AND  s.program LIKE '%f60webmx%';
\`\`\`

The \`spid\` value is the OS PID to use in the trace filename.

### Step 3: Process with tkprof

\`\`\`bash
tkprof /u01/oracle/diag/rdbms/<SID>/<SID>/trace/<SID>_ora_<spid>.trc \\
       /tmp/affected_user_trace.txt \\
       explain=apps/<apps_password> \\
       sys=no \\
       sort=exeela
\`\`\`

### Step 4: Analyze the trace output

Open \`/tmp/affected_user_trace.txt\` and navigate to the end. The last SQL statement or PL/SQL anonymous block before the session terminated is where ORA-06502 fired. Look for:

- The variable name and declared size in any DECLARE block
- The value being assigned at the point of failure (in the bind variable section if Level 12 was captured)
- The call stack leading to the exception

### Step 5: Disable the trace profile option

Set \`Initialization SQL Statement - Custom\` back to blank at the User level immediately after capture.

---

## Narrowing to the Exact Fix

Once the investigation identifies the failing assignment:

**Profile option value too long:** Update the profile option to a shorter value, or patch the PL/SQL variable declaration to accommodate the actual maximum length. Profile option values are stored in \`FND_PROFILE_OPTION_VALUES.PROFILE_OPTION_VALUE\` as VARCHAR2(240) — the value itself is rarely the issue. The issue is in the PL/SQL that reads it into a shorter variable.

**NULL on a mandatory field:** Populate the missing data in the source table (HR assignment, operating unit, or user attribute). Do not work around NULLs by changing the PL/SQL — the data model requires the value.

**Form personalization raising the error:** Disable the personalization for the affected user's responsibility, correct the expression or action, and re-enable. Personalization changes take effect immediately for new sessions.

**CUSTOM.pll raising the error:** Apply the fix through the safe compile procedure: copy \`CUSTOM.pll\` to a working directory, edit, compile with \`f60gen\`, verify exit code zero, then copy only the \`.plx\` to \`\$AU_TOP/resource/\`. Never edit in place while users are active.

---

## Summary

When FRM-40735 / ORA-06502 crashes a WHEN-NEW-FORM-INSTANCE trigger for specific users only, the failure is in data evaluated for those users — not in the shared code path. Four investigation paths, in order of increasing invasiveness: check user-level profile option values for length or NULL violations; check form personalizations active for the affected responsibility; enable FND Debug at the User level and query \`fnd_log_messages\` for the MODULE and step where the exception originated; and fall back to a 10046 SQL trace if the FND log lacks sufficient detail. The fix follows directly from the root cause — no broad code changes, no bouncing nodes, no infrastructure work.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'EBS FRM-40735 / ORA-06502 Deep Investigation: Profile Corruption, Form Personalizations, and FND Debug Trace Analysis',
    slug,
    excerpt: 'When WHEN-NEW-FORM-INSTANCE raises ORA-06502 for two users out of hundreds, the failure is in user-specific data — not infrastructure. This post covers four targeted investigation paths: querying user-level profile option corruption, identifying form personalization trigger failures, analyzing FND Debug trace output to pinpoint the exact package and variable, and capturing a 10046 SQL trace as a fallback when the FND log lacks sufficient detail.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
