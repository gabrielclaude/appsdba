import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-frm40735-ora06502-profile-corruption-runbook';

const content = `
Operational runbook for investigating FRM-40735 / ORA-06502 in WHEN-NEW-FORM-INSTANCE when the failure is isolated to one or a small number of specific users. Run phases in sequence — each phase either identifies the root cause and stops, or rules out that path and hands off to the next.

**Pre-condition:** FRM-40735 has been confirmed as the actual error (not just "unable to communicate with runtime process" in JServ). The affected usernames are known.

---

## Phase 1: Profile Option Corruption Check

Run in SQL*Plus as \`APPS\` against the EBS database. Replace \`AFFECTED_USER_1\` and \`AFFECTED_USER_2\` with the actual EBS usernames.

### 1.1 All user-level profile options, ordered by recency

\`\`\`sql
SELECT u.user_name,
       p.profile_option_name,
       val.profile_option_value,
       LENGTH(val.profile_option_value) AS val_length,
       val.last_update_date
FROM   fnd_profile_options         p,
       fnd_profile_option_values   val,
       fnd_user                    u
WHERE  val.level_id    = 10004
  AND  val.level_value = u.user_id
  AND  u.user_name IN ('AFFECTED_USER_1', 'AFFECTED_USER_2')
ORDER BY val.last_update_date DESC;
\`\`\`

Flag any row where:
- \`VAL_LENGTH\` exceeds 30 characters for options that typically hold codes or IDs
- \`LAST_UPDATE_DATE\` is on or after the date the blank form issue started

### 1.2 Critical multi-org options — NULL check

\`\`\`sql
SELECT u.user_name,
       p.profile_option_name,
       NVL(val.profile_option_value, '** NULL **') AS profile_value
FROM   fnd_profile_options         p
JOIN   fnd_profile_option_values   val
       ON  val.profile_option_id = p.profile_option_id
      AND  val.level_id          = 10004
RIGHT JOIN fnd_user u
       ON  val.level_value = u.user_id
WHERE  u.user_name IN ('AFFECTED_USER_1', 'AFFECTED_USER_2')
  AND  p.profile_option_name IN (
         'MO_OPERATING_UNIT',
         'ORG_ID',
         'DEFAULT_ORG_ID',
         'GL_SET_OF_BKS_ID',
         'INV_CURRENT_ORGANIZATION_ID',
         'HR_BUSINESS_GROUP_ID'
       )
ORDER BY u.user_name, p.profile_option_name;
\`\`\`

Any \`** NULL **\` result for a multi-org option is a confirmed finding. The form's initialization code almost certainly assigns \`FND_PROFILE.VALUE\` for this option into a NOT NULL variable.

**If a finding is confirmed:** Correct the profile option value in **Profile > System** for the affected user. Test the form. If it loads, root cause is resolved. Document the corrected value and skip to Phase 5 (cleanup).

---

## Phase 2: Form Personalization Check

### 2.1 All active WHEN-NEW-FORM-INSTANCE personalizations

\`\`\`sql
SELECT ff.form_name,
       fp.trigger_event,
       fp.trigger_object,
       fp.sequence,
       fp.description,
       fp.enabled,
       fp.condition,
       fp.action_type,
       fp.last_update_date,
       fu.user_name AS last_updated_by_user
FROM   fnd_form_personalizations   fp
JOIN   fnd_form                    ff ON fp.form_id = ff.form_id
LEFT JOIN fnd_user                 fu ON fp.last_updated_by = fu.user_id
WHERE  fp.enabled       = 'Y'
  AND  fp.trigger_event = 'WHEN-NEW-FORM-INSTANCE'
ORDER BY ff.form_name, fp.sequence;
\`\`\`

### 2.2 Narrow to personalizations changed in the last 30 days

\`\`\`sql
SELECT ff.form_name,
       fp.trigger_event,
       fp.sequence,
       fp.description,
       fp.condition,
       fp.action_type,
       fp.last_update_date,
       fu.user_name AS last_updated_by_user
FROM   fnd_form_personalizations   fp
JOIN   fnd_form                    ff ON fp.form_id = ff.form_id
LEFT JOIN fnd_user                 fu ON fp.last_updated_by = fu.user_id
WHERE  fp.enabled           = 'Y'
  AND  fp.trigger_event     = 'WHEN-NEW-FORM-INSTANCE'
  AND  fp.last_update_date >= SYSDATE - 30
ORDER BY fp.last_update_date DESC;
\`\`\`

### 2.3 Test by disabling a suspect personalization

If a recently changed personalization looks suspicious, disable it temporarily for a test:

\`\`\`sql
-- Disable (note the personalization ID before running)
UPDATE fnd_form_personalizations
SET    enabled = 'N'
WHERE  personalization_id = &suspect_personalization_id;
COMMIT;
\`\`\`

Ask the affected user to open the form. If it loads, that personalization is the root cause. Re-enable it after identifying the problematic expression:

\`\`\`sql
UPDATE fnd_form_personalizations
SET    enabled = 'Y'
WHERE  personalization_id = &suspect_personalization_id;
COMMIT;
\`\`\`

**If the form loads with the personalization disabled:** Fix the condition expression or action and re-enable. The fix is in the EBS Personalization UI (**Help > Diagnostics > Custom Code > Personalize**). Test the corrected version before closing the incident.

---

## Phase 3: FND Debug Trace

Use this phase if Phases 1 and 2 produced no findings, or if you need to identify the exact package and variable raising ORA-06502 before attempting a fix.

### 3.1 Enable FND Debug — User level only

Log in to EBS as System Administrator. Navigate to **Profile > System**. Query the affected username. Set at **User** level:

| Profile Option | Value |
|----------------|-------|
| FND: Debug Log Enabled | Yes |
| FND: Debug Log Level | Exception |
| FND: Debug Module | % |

Confirm: these options are set at the **User** level, not Site or Application level.

### 3.2 Reproduce and record timestamp

Ask the affected user to:

1. Log out completely
2. Clear Java cache (Java Control Panel → General → Delete Files → All)
3. Log back in
4. Navigate to the problem form

Record the exact timestamp at reproduction. The format needed: \`YYYY-MM-DD HH24:MI:SS\`.

### 3.3 Query FND_LOG_MESSAGES

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
FETCH FIRST 100 ROWS ONLY;
\`\`\`

### 3.4 Interpret the trace

Read bottom-to-top (lowest \`log_sequence\` = earliest):

1. **Locate the ORA-06502 entry** — the MODULE column names the package and procedure where the assignment failed. Example: \`fnd_profile.value_specific\` or \`custom.pll.when_new_form_instance\`.

2. **Find the profile option or variable value** — the MESSAGE_TEXT for the entries just before the exception will show what \`FND_PROFILE.VALUE\` returned, or what data was read from the database before the assignment.

3. **Identify the call stack** — the MODULE hierarchy shows which packages called which. Trace back from the exception to the initial trigger call.

4. **Custom vs. standard** — entries with MODULE starting with \`custom.\` or a non-Oracle prefix point to CUSTOM.pll or a custom package. Standard Oracle packages use prefixes like \`fnd.\`, \`ar.\`, \`gl.\`, \`po.\`.

### 3.5 Disable FND Debug immediately

| Profile Option | Value |
|----------------|-------|
| FND: Debug Log Enabled | No |
| FND: Debug Log Level | (blank) |
| FND: Debug Module | (blank) |

---

## Phase 4: 10046 SQL Trace (Fallback)

Use this phase only if Phase 3 produces insufficient detail — typically when the failing code does not write to FND_LOG.

### 4.1 Enable trace via profile option

In **Profile > System** for the affected user, at the **User** level:

| Profile Option | Value |
|----------------|-------|
| Initialization SQL Statement - Custom | ALTER SESSION SET EVENTS '10046 trace name context forever, level 12' |

### 4.2 Get user_dump_dest

\`\`\`sql
SELECT value FROM v\$parameter WHERE name = 'user_dump_dest';
\`\`\`

### 4.3 Reproduce and identify trace file

Have the affected user reproduce the blank form issue. Identify the OS PID of the database session:

\`\`\`sql
SELECT s.sid,
       s.serial#,
       p.spid          AS os_pid,
       s.username,
       s.status,
       s.last_call_et  AS idle_seconds
FROM   v\$session s
JOIN   v\$process p ON s.paddr = p.addr
WHERE  s.username = UPPER('AFFECTED_USER_1')
  AND  s.program LIKE '%f60webmx%';
\`\`\`

The trace file is: \`<user_dump_dest>/<SID>_ora_<os_pid>.trc\`

### 4.4 Process with tkprof

Run on the database server as the Oracle OS user:

\`\`\`bash
tkprof \${USER_DUMP_DEST}/\${ORACLE_SID}_ora_\${SPID}.trc \\
       /tmp/affected_user_trace_\$(date +%Y%m%d).txt \\
       explain=apps/\${APPS_PWD} \\
       sys=no \\
       sort=exeela
\`\`\`

### 4.5 Locate the failure point

Open the processed trace file and navigate to the end. The last SQL statement or PL/SQL anonymous block before the session terminated is where ORA-06502 fired. The bind variable section (Level 12) shows the actual values being assigned.

### 4.6 Disable the trace profile option

Set \`Initialization SQL Statement - Custom\` back to blank at the User level.

---

## Phase 5: Apply the Fix

| Root cause identified | Fix |
|-----------------------|-----|
| Profile option value too long for variable | Correct value in **Profile > System** at User level; or patch the PL/SQL variable declaration if the value is legitimately long |
| Profile option NULL on mandatory field | Populate the missing value at User level or in the source table (HR assignment, operating unit) |
| Form personalization expression failure | Correct the condition or action in **Help > Diagnostics > Custom Code > Personalize**; changes are immediate for new sessions |
| CUSTOM.pll variable declaration too short | Copy \`.pll\` to /tmp, fix declaration, compile with \`f60gen\`, verify exit 0, copy \`.plx\` to \$AU_TOP/resource — never edit in place |
| Standard Oracle package bug (rare) | Raise SR with Oracle Support; apply patch to staging first |

---

## Automation Script

Save as \`ebs_frm40735_profile_check.sh\`. Run on the database server as the Oracle OS user. Outputs a report file and exits 1 if any finding requires attention.

\`\`\`bash
#!/bin/bash
# FRM-40735 / ORA-06502 Profile and Personalization Check
# Usage: ./ebs_frm40735_profile_check.sh <AFFECTED_USER> [AFFECTED_USER_2 ...]
# Example: ./ebs_frm40735_profile_check.sh JSMITH KWILLIAMS

if [ \$# -eq 0 ]; then
  echo "Usage: \$0 <EBS_USERNAME> [EBS_USERNAME_2 ...]"
  exit 1
fi

REPORT=/tmp/frm40735_profile_check_\$(date +%Y%m%d_%H%M%S).txt
FINDING=0

# Build single-quoted, comma-separated user list for SQL IN clause
USER_LIST=""
for u in "\$@"; do
  USER_LIST="\${USER_LIST}'$(echo \$u | tr '[:lower:]' '[:upper:]')',"
done
USER_LIST=\${USER_LIST%,}  # strip trailing comma

echo "============================================================" | tee "\${REPORT}"
echo "FRM-40735 / ORA-06502 Profile Investigation"               | tee -a "\${REPORT}"
echo "Affected users: \$*"                                        | tee -a "\${REPORT}"
echo "Date: \$(date)"                                             | tee -a "\${REPORT}"
echo "============================================================" | tee -a "\${REPORT}"

# Requires ORACLE_SID, ORACLE_HOME, and APPS password in environment
: "\${ORACLE_SID:?ORACLE_SID not set}"
: "\${ORACLE_HOME:?ORACLE_HOME not set}"
: "\${APPS_PWD:?APPS_PWD not set}"

SQLPLUS="\${ORACLE_HOME}/bin/sqlplus"

# --- Phase 1: Profile option NULL check ---
echo "" | tee -a "\${REPORT}"
echo "[1] Critical Profile Options — NULL Check" | tee -a "\${REPORT}"
echo "--------------------------------------------------------------" | tee -a "\${REPORT}"

NULL_CHECK=\$(\${SQLPLUS} -s apps/\${APPS_PWD} <<ENDSQL
SET PAGESIZE 100
SET LINESIZE 160
SET FEEDBACK OFF
SET HEADING ON
COLUMN user_name FORMAT A20
COLUMN profile_option_name FORMAT A40
COLUMN profile_value FORMAT A30

SELECT u.user_name,
       p.profile_option_name,
       NVL(val.profile_option_value, '** NULL **') AS profile_value
FROM   fnd_profile_options         p
JOIN   fnd_profile_option_values   val
       ON  val.profile_option_id = p.profile_option_id
      AND  val.level_id          = 10004
RIGHT JOIN fnd_user u
       ON  val.level_value = u.user_id
WHERE  u.user_name IN (\${USER_LIST})
  AND  p.profile_option_name IN (
         'MO_OPERATING_UNIT',
         'ORG_ID',
         'DEFAULT_ORG_ID',
         'GL_SET_OF_BKS_ID',
         'INV_CURRENT_ORGANIZATION_ID',
         'HR_BUSINESS_GROUP_ID'
       )
ORDER BY u.user_name, p.profile_option_name;
EXIT;
ENDSQL
)

echo "\${NULL_CHECK}" | tee -a "\${REPORT}"

NULL_HITS=\$(echo "\${NULL_CHECK}" | grep -c "\*\* NULL \*\*")
if [ "\${NULL_HITS}" -gt 0 ]; then
  echo "" | tee -a "\${REPORT}"
  echo "FINDING: \${NULL_HITS} NULL value(s) on critical profile options" | tee -a "\${REPORT}"
  echo "Action: populate the missing value in Profile > System at the User level" | tee -a "\${REPORT}"
  FINDING=1
fi

# --- Phase 2: Long profile option values ---
echo "" | tee -a "\${REPORT}"
echo "[2] User-Level Profile Options — Recency and Length" | tee -a "\${REPORT}"
echo "--------------------------------------------------------------" | tee -a "\${REPORT}"

LONG_CHECK=\$(\${SQLPLUS} -s apps/\${APPS_PWD} <<ENDSQL
SET PAGESIZE 100
SET LINESIZE 200
SET FEEDBACK OFF
COLUMN user_name FORMAT A20
COLUMN profile_option_name FORMAT A45
COLUMN profile_option_value FORMAT A40
COLUMN val_length FORMAT 999
COLUMN last_update_date FORMAT A20

SELECT u.user_name,
       p.profile_option_name,
       SUBSTR(val.profile_option_value, 1, 40) AS profile_option_value,
       LENGTH(val.profile_option_value)         AS val_length,
       TO_CHAR(val.last_update_date, 'YYYY-MM-DD HH24:MI') AS last_update_date
FROM   fnd_profile_options         p,
       fnd_profile_option_values   val,
       fnd_user                    u
WHERE  val.level_id    = 10004
  AND  val.level_value = u.user_id
  AND  u.user_name IN (\${USER_LIST})
ORDER BY val.last_update_date DESC
FETCH FIRST 30 ROWS ONLY;
EXIT;
ENDSQL
)

echo "\${LONG_CHECK}" | tee -a "\${REPORT}"

LONG_HITS=\$(echo "\${LONG_CHECK}" | awk 'NR>3 && \$4+0 > 50 {print}' | wc -l)
if [ "\${LONG_HITS}" -gt 0 ]; then
  echo "" | tee -a "\${REPORT}"
  echo "FINDING: \${LONG_HITS} profile option value(s) exceed 50 characters" | tee -a "\${REPORT}"
  echo "Action: verify these values against the receiving variable declaration in the relevant PL/SQL" | tee -a "\${REPORT}"
  FINDING=1
fi

# --- Phase 3: Recent form personalization changes ---
echo "" | tee -a "\${REPORT}"
echo "[3] Form Personalizations — WHEN-NEW-FORM-INSTANCE (last 30 days)" | tee -a "\${REPORT}"
echo "--------------------------------------------------------------" | tee -a "\${REPORT}"

PERS_CHECK=\$(\${SQLPLUS} -s apps/\${APPS_PWD} <<ENDSQL
SET PAGESIZE 100
SET LINESIZE 200
SET FEEDBACK OFF
COLUMN form_name FORMAT A30
COLUMN sequence FORMAT 999
COLUMN description FORMAT A40
COLUMN last_update_date FORMAT A20
COLUMN last_updated_by_user FORMAT A20

SELECT ff.form_name,
       fp.sequence,
       SUBSTR(fp.description, 1, 40) AS description,
       TO_CHAR(fp.last_update_date, 'YYYY-MM-DD HH24:MI') AS last_update_date,
       fu.user_name AS last_updated_by_user
FROM   fnd_form_personalizations   fp
JOIN   fnd_form                    ff ON fp.form_id = ff.form_id
LEFT JOIN fnd_user                 fu ON fp.last_updated_by = fu.user_id
WHERE  fp.enabled           = 'Y'
  AND  fp.trigger_event     = 'WHEN-NEW-FORM-INSTANCE'
  AND  fp.last_update_date >= SYSDATE - 30
ORDER BY fp.last_update_date DESC;
EXIT;
ENDSQL
)

echo "\${PERS_CHECK}" | tee -a "\${REPORT}"

PERS_HITS=\$(echo "\${PERS_CHECK}" | grep -c "2[0-9][0-9][0-9]-")
if [ "\${PERS_HITS}" -gt 0 ]; then
  echo "" | tee -a "\${REPORT}"
  echo "FINDING: \${PERS_HITS} form personalization(s) modified in the last 30 days" | tee -a "\${REPORT}"
  echo "Action: review each personalization; disable suspect ones and test the form" | tee -a "\${REPORT}"
  FINDING=1
fi

# --- Phase 4: FND Debug SQL for manual use ---
echo "" | tee -a "\${REPORT}"
echo "[4] FND Debug Query (run after enabling debug and reproducing issue)" | tee -a "\${REPORT}"
echo "--------------------------------------------------------------" | tee -a "\${REPORT}"
cat <<'ENDSQL' | tee -a "\${REPORT}"

-- Run this in SQL*Plus as APPS after reproduction.
-- Replace :affected_username and :reproduction_time with actual values.

SELECT log_sequence,
       module,
       message_text,
       timestamp
FROM   fnd_log_messages
WHERE  user_id = (
         SELECT user_id
         FROM   fnd_user
         WHERE  user_name = UPPER(:affected_username)
       )
  AND  timestamp >= :reproduction_time
ORDER BY log_sequence DESC
FETCH FIRST 100 ROWS ONLY;

ENDSQL

# --- Summary ---
echo "" | tee -a "\${REPORT}"
echo "============================================================" | tee -a "\${REPORT}"
if [ "\${FINDING}" -eq 1 ]; then
  echo "RESULT: One or more findings require attention (see above)" | tee -a "\${REPORT}"
else
  echo "RESULT: No profile corruption or recent personalization changes found" | tee -a "\${REPORT}"
  echo "Next step: enable FND Debug at User level and capture fnd_log_messages trace" | tee -a "\${REPORT}"
fi
echo "Report saved to: \${REPORT}" | tee -a "\${REPORT}"
echo "============================================================" | tee -a "\${REPORT}"

exit \${FINDING}
\`\`\`

Make executable and run:

\`\`\`bash
chmod +x ebs_frm40735_profile_check.sh

# Set environment
export ORACLE_SID=EBSPROD
export ORACLE_HOME=/u01/app/oracle/product/10.2.0/db_1
export APPS_PWD=<apps_password>

# Run for the affected users
./ebs_frm40735_profile_check.sh AFFECTED_USER_1 AFFECTED_USER_2
\`\`\`

The script exits with code 1 if any finding is detected, making it suitable for use in automated triage pipelines. Review \`/tmp/frm40735_profile_check_<timestamp>.txt\` for the full output.

---

## Summary

Blank EBS Forms for specific users with FRM-40735 / ORA-06502 in WHEN-NEW-FORM-INSTANCE is a data investigation, not an infrastructure investigation. The four-phase approach — profile option corruption, form personalization triggers, FND Debug trace, and 10046 SQL trace — narrows from the least invasive check to the most detailed. In most cases the issue resolves at Phase 1 (NULL or overlong profile option value) or Phase 2 (recently changed personalization with a type mismatch in its condition expression). FND Debug is the definitive tool when the source is unclear: it names the package, procedure, and step where the assignment failed without requiring code changes or broad session impact.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'EBS FRM-40735 / ORA-06502 Investigation Runbook: Profile Options, Form Personalizations, FND Debug, and 10046 Trace',
    slug,
    excerpt: 'Operational runbook for investigating WHEN-NEW-FORM-INSTANCE ORA-06502 failures isolated to specific EBS users. Four-phase approach: user-level profile option NULL and length checks, form personalization query and disable-test, FND Debug trace analysis to pinpoint the failing package and variable, and 10046 SQL trace as a fallback. Includes a shell automation script that runs all SQL checks and exits non-zero on findings.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
