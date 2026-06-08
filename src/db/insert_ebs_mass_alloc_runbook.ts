import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Diagnosing Oracle EBS GL Mass Allocation Failures (R_AMAS0108)',
  slug: 'ebs-gl-mass-allocation-r-amas0108-runbook',
  excerpt:
    'Step-by-step incident runbook for an Oracle EBS General Ledger Mass Allocation failing with R_AMAS0108 on a period that appears open. Covers concurrent request log triage, FND_LOG_MESSAGES extraction, GL_PERIOD_STATUSES verification, 10046 Level 12 trace configuration, TKPROF analysis, and the period re-open/resubmission procedure.',
  category: 'ebs-functional' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-08'),
  youtubeUrl: null,
  content: `## Purpose and Scope

This runbook diagnoses and resolves an Oracle EBS General Ledger Mass Allocation process that fails with:

\`\`\`
R_AMAS0108: The period is not an open or future enterable period.
\`\`\`

...on a period that the GL Period Statuses screen shows as Open.

**Reference post:** [Behind the Scenes of a P1 Crisis: Troubleshooting Oracle EBS Mass Allocation Errors](/posts/ebs-gl-mass-allocation-r-amas0108-error)

**Applies to:** Oracle EBS 12.2.x, GL Mass Allocations (responsibility: General Ledger > Mass Allocations)

---

## Incident Signature

Proceed with this runbook when all of the following are true:

| Check | Expected |
|-------|---------|
| Mass Allocation concurrent request status | \`Error\` |
| Error in request log | \`R_AMAS0108: The period is not an open or future enterable period\` |
| Period status on GL > Setup > Financials > Accounting Calendar | Shows \`Open\` |
| Other GL transactions posting to same period | Working normally |

---

## Phase 0 — Immediate Triage

### 0.1 Locate the failed concurrent request

Navigate to: **Requests > View > All** (or use the Concurrent Requests screen in your GL responsibility).

Record:
- **Request ID** — visible in the Details column
- **Request Name** — should be \`Mass Allocation\` or your formula name
- **Start/End Time** — confirms the failure happened during period close

From SQL (run as APPS or a DBA account):

\`\`\`sql
SELECT request_id,
       concurrent_program_name,
       argument_text,
       phase_code,
       status_code,
       actual_start_date,
       actual_completion_date,
       logfile_name,
       outfile_name
FROM   fnd_concurrent_requests
WHERE  concurrent_program_name LIKE '%MASS%'
  AND  status_code = 'E'
ORDER BY actual_start_date DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

Note the \`REQUEST_ID\` and \`LOGFILE_NAME\` for the failed run.

### 0.2 Read the concurrent request log

\`\`\`bash
# On the EBS application server, as applmgr
# Replace with the path from logfile_name above
cat /u01/oracle/VIS/fs1/inst/apps/VIS_hostname/logs/appl/conc/log/<request_id>.req
\`\`\`

Confirm the exact error line. The log will show:

\`\`\`
R_AMAS0108: The period is not an open or future enterable period.
Formula: FY27 BENEFIT
Period: 04-26
Ledger: Vision Operations (USA)
\`\`\`

Record: **formula name**, **period**, **ledger name**.

### 0.3 Verify the period status in the database

The screen may show Open but the database row is the authoritative source:

\`\`\`sql
SELECT gps.ledger_id,
       gl.name                   AS ledger_name,
       gps.period_name,
       gps.period_year,
       gps.period_num,
       gps.period_type,
       gps.status,
       gps.closing_status,
       gps.start_date,
       gps.end_date
FROM   gl_period_statuses gps
JOIN   gl_ledgers          gl  ON gps.ledger_id = gl.ledger_id
WHERE  gps.period_name = '04-26'          -- replace with your failing period
  AND  gps.application_id = 101           -- 101 = GL
ORDER BY gps.ledger_id;
\`\`\`

| STATUS | CLOSING_STATUS | Interpretation |
|--------|---------------|----------------|
| \`O\` | \`O\` | Open — should work |
| \`O\` | \`C\` | Mismatch — this is the most common root cause |
| \`C\` | \`C\` | Closed — period genuinely closed |
| \`F\` | \`F\` | Future Entry only |
| \`N\` | \`N\` | Never Opened |

If \`STATUS = 'O'\` but \`CLOSING_STATUS = 'C'\` for any ledger, that inconsistency is the root cause — jump to Phase 4 (Fix).

---

## Phase 1 — FND_LOG_MESSAGES Extraction

Before pulling a 10046 trace, query the framework log. This often reveals the failure point immediately.

### 1.1 Get the transaction context for the failed request

\`\`\`sql
SELECT con.transaction_context_id,
       con.transaction_id,
       con.transaction_type,
       con.module,
       con.created_by
FROM   fnd_log_transaction_context con
WHERE  con.transaction_id   = &your_request_id
  AND  con.transaction_type = 'REQUEST';
\`\`\`

Substitute \`&your_request_id\` with the \`REQUEST_ID\` from Phase 0.1.

### 1.2 Extract the full framework log sequence

\`\`\`sql
SELECT log.log_sequence,
       log.module,
       log.message_text,
       log.timestamp
FROM   fnd_log_messages          log,
       fnd_log_transaction_context con
WHERE  con.transaction_id         = &your_request_id
  AND  con.transaction_type       = 'REQUEST'
  AND  con.transaction_context_id = log.transaction_context_id
ORDER BY log.log_sequence;
\`\`\`

Look for lines containing:
- \`period\` — shows which period validation call ran
- \`status\` — shows what status value was returned
- \`AMAS\` — the Mass Allocation package entries
- \`error\` or \`exception\` — the exact failure point

The log sequence immediately before the error message typically shows the period name and status value that the validation package evaluated.

### 1.3 Check if FND logging level was sufficient

If the query returns no rows or very few rows, the FND logging level may be set too low:

\`\`\`sql
-- Check current FND logging level profile
SELECT profile_option_name,
       profile_option_value
FROM   fnd_profile_option_values fpov
JOIN   fnd_profile_options fpo ON fpov.profile_option_id = fpo.profile_option_id
WHERE  fpo.profile_option_name = 'FND_DEBUG_LOG_ENABLED'
  AND  fpov.level_id = 10001;  -- site level
\`\`\`

If logging is off, proceed directly to Phase 2 (10046 trace).

---

## Phase 2 — 10046 Trace Configuration

Use this phase when \`FND_LOG_MESSAGES\` does not reveal the root cause and you need to see the exact SQL and bind variable values passed during the period status check.

### 2.1 Identify the EBS user who will reproduce the failure

The trace must be scoped to a specific EBS user to avoid generating noise from all concurrent sessions. Use the GL responsibility owner or the user who originally submitted the failed formula.

### 2.2 Set the trace initialization profile at the user level

Navigate to: **System Administrator > Profile > System**

- **Profile Name:** \`Initialization SQL Statement - Custom\`
- **Level:** User
- **User:** (the reproducing user's login name)
- **Value:**

\`\`\`sql
BEGIN
  FND_CTL.FND_SESS_CTL(
    '',
    '',
    'TRUE',
    'TRUE',
    'LOG',
    'ALTER SESSION SET max_dump_file_size=unlimited
     TRACEFILE_IDENTIFIER = ''MASSALLOC_DEBUG''
     EVENTS = ''10046 TRACE NAME CONTEXT FOREVER, LEVEL 12'''
  );
END;
\`\`\`

Paste this as a single value into the profile field. The \`TRACEFILE_IDENTIFIER\` tag lets you find the trace file immediately without searching.

Or set via SQL (faster during a P1):

\`\`\`sql
-- Get the user_id
SELECT user_id FROM fnd_user WHERE user_name = 'JSMITH';

-- Set the profile at user level (level_id 10004 = User)
BEGIN
  FND_PROFILE.SAVE(
    x_name         => 'FND_INIT_SQL',
    x_value        => 'BEGIN FND_CTL.FND_SESS_CTL('''','''',''TRUE'',''TRUE'',''LOG'',''ALTER SESSION SET max_dump_file_size=unlimited TRACEFILE_IDENTIFIER =''''MASSALLOC_DEBUG'''' EVENTS=''''10046 TRACE NAME CONTEXT FOREVER, LEVEL 12''''''''); END;',
    x_level_name   => 'USER',
    x_level_value  => '&user_id'
  );
  COMMIT;
END;
/
\`\`\`

### 2.3 Reproduce the failure

Ask the user (or simulate as them) to:
1. Log into EBS using the GL responsibility
2. Navigate to **GL > Mass Allocations > Define**
3. Open the failed formula (\`FY27 BENEFIT\` or your formula name)
4. Click **Generate** > select the failing period > click **Run**

### 2.4 Locate the trace file

On the database server, as the oracle OS user:

\`\`\`bash
# Find the trace file by the identifier tag
find $ORACLE_BASE/diag/rdbms -name "*MASSALLOC_DEBUG*" -newer /tmp -ls 2>/dev/null | sort -k8,9

# Or check the default trace directory
ls -lt $(sqlplus -s / as sysdba <<EOF
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT value FROM v\$parameter WHERE name = 'diagnostic_dest';
EXIT;
EOF
)/diag/rdbms/*/*/trace/ | head -20
\`\`\`

### 2.5 Run TKPROF on the trace file

\`\`\`bash
TRACE_FILE=$(find $ORACLE_BASE/diag/rdbms -name "*MASSALLOC_DEBUG*" | head -1)
TKPROF_OUT=/tmp/massalloc_trace_$(date +%Y%m%d).txt

tkprof "$TRACE_FILE" "$TKPROF_OUT" \
  sys=no \
  sort=exeela \
  explain=apps/apps_password@EBSDB

echo "TKPROF output written to $TKPROF_OUT"
\`\`\`

### 2.6 Analyse the TKPROF output

Open \`$TKPROF_OUT\` and search for:
- \`GL_PERIOD_STATUSES\` — the period status lookup query and what it returned
- \`CLOSING_STATUS\` or \`STATUS\` — the bind variable values passed and the rows returned
- \`call count\` rows = 0 — a fetch returning zero rows on a status check is the signature of the period-not-found condition

The query that returns 0 rows when it should return 1 is the exact bug location.

### 2.7 Clear the trace profile after collection

\`\`\`sql
BEGIN
  FND_PROFILE.SAVE(
    x_name         => 'FND_INIT_SQL',
    x_value        => NULL,
    x_level_name   => 'USER',
    x_level_value  => '&user_id'
  );
  COMMIT;
END;
/
\`\`\`

Do not leave Level 12 tracing active on a production user account. It generates very large trace files and adds overhead to every session the user opens.

---

## Phase 3 — Check Secondary Ledgers and Reporting Currencies

A common source of the status mismatch is that the primary ledger's period is Open, but an attached secondary ledger or reporting currency has its period in a different state.

\`\`\`sql
-- Check period status across all ledgers in the same ledger set or accounting configuration
SELECT gl.name                   AS ledger_name,
       gl.ledger_category_code,
       gps.period_name,
       gps.status,
       gps.closing_status,
       gl.currency_code
FROM   gl_period_statuses gps
JOIN   gl_ledgers          gl  ON gps.ledger_id = gl.ledger_id
WHERE  gps.period_name    = '04-26'
  AND  gps.application_id = 101
ORDER BY gl.ledger_category_code, gl.name;
\`\`\`

If any row shows \`STATUS = 'C'\` or \`CLOSING_STATUS = 'C'\` on a secondary or reporting ledger while the primary shows \`O\`, the Mass Allocation engine is evaluating that secondary ledger's period status and failing.

Resolution options:
1. Open the period in the secondary ledger (if permitted by accounting policy)
2. Exclude the secondary ledger from the Mass Allocation formula's ledger scope
3. Run the formula for the primary ledger only and handle secondary ledger postings separately

---

## Phase 4 — Fix: Correct GL_PERIOD_STATUSES Inconsistency

**Warning:** Do not update \`GL_PERIOD_STATUSES\` directly in a production environment without approval and an SR open with Oracle Support. Use the standard EBS period management API instead.

### 4.1 Standard fix — re-open the period via the UI

Navigate to: **GL > Setup > Open and Close Periods**

1. Select the affected ledger
2. Locate period \`04-26\`
3. If status shows \`Closed\`, click **Open** to reopen
4. If status shows \`Open\` but the error persists, close and re-open the period to force a status reset

### 4.2 API-based fix (for scripted environments)

\`\`\`sql
-- Open or reopen a period using the GL API
-- Run as APPS user
DECLARE
  l_status       VARCHAR2(1);
  l_industry     VARCHAR2(1);
  l_oracle_schema VARCHAR2(30);
BEGIN
  -- Re-open the period programmatically
  GL_PERIOD_STATUSES_PKG.UPDATE_ROW(
    x_application_id    => 101,
    x_ledger_id         => &your_ledger_id,
    x_period_name       => '04-26',
    x_closing_status    => 'O',
    x_start_date        => TO_DATE('2026-04-01','YYYY-MM-DD'),
    x_end_date          => TO_DATE('2026-04-30','YYYY-MM-DD'),
    x_last_update_date  => SYSDATE,
    x_last_updated_by   => -1
  );
  COMMIT;
  DBMS_OUTPUT.PUT_LINE('Period status updated.');
END;
/
\`\`\`

Substitute \`&your_ledger_id\` with the value from the \`gl_ledgers\` query in Phase 0.3.

### 4.3 Verify the fix

\`\`\`sql
SELECT ledger_id, period_name, status, closing_status
FROM   gl_period_statuses
WHERE  period_name    = '04-26'
  AND  application_id = 101
ORDER BY ledger_id;
\`\`\`

All rows should show \`STATUS = 'O'\` and \`CLOSING_STATUS = 'O'\`.

---

## Phase 5 — Resubmit and Verify the Mass Allocation

### 5.1 Resubmit the formula

Navigate to: **GL > Mass Allocations > Generate**

Select the same formula (\`FY27 BENEFIT\`) and period (\`04-26\`), then submit.

### 5.2 Monitor the concurrent request

\`\`\`sql
SELECT request_id,
       phase_code,
       status_code,
       actual_start_date,
       actual_completion_date
FROM   fnd_concurrent_requests
WHERE  concurrent_program_name LIKE '%MASS%'
ORDER BY actual_start_date DESC
FETCH FIRST 5 ROWS ONLY;
\`\`\`

A \`phase_code = 'C'\` (Completed) and \`status_code = 'N'\` (Normal) confirms success.

### 5.3 Verify journal entries were created

\`\`\`sql
SELECT gjh.je_header_id,
       gjh.name,
       gjh.period_name,
       gjh.status,
       gjh.running_total_dr,
       gjh.running_total_cr,
       gjh.creation_date
FROM   gl_je_headers gjh
WHERE  gjh.je_source = 'Mass Allocation'
  AND  gjh.period_name = '04-26'
  AND  gjh.creation_date >= TRUNC(SYSDATE)
ORDER BY gjh.creation_date DESC;
\`\`\`

Journal entries with \`STATUS = 'U'\` (Unposted) or \`'P'\` (Posted) confirm the allocation ran successfully.

---

## Post-Incident Checklist

- [ ] R_AMAS0108 error resolved — Mass Allocation formula completes with Normal status
- [ ] Journal entries generated for the correct period and ledger
- [ ] Journals posted (or queued for batch posting) to close the period
- [ ] FND trace profile cleared from the user account (Phase 2.7)
- [ ] GL_PERIOD_STATUSES consistency verified across all ledgers in the accounting configuration (Phase 3 query)
- [ ] Root cause documented: which ledger had the inconsistent CLOSING_STATUS, and how it got there
- [ ] SR opened with Oracle Support if the inconsistency recurred or if an API/data bug was identified
- [ ] Staging environment replication confirmed or noted as not feasible for period-sensitive data

---

## Reference SQL Cheat Sheet

\`\`\`sql
-- 1. Find the failed Mass Allocation request
SELECT request_id, argument_text, status_code, logfile_name
FROM   fnd_concurrent_requests
WHERE  concurrent_program_name LIKE '%MASS%'
  AND  status_code = 'E'
ORDER BY actual_start_date DESC
FETCH FIRST 5 ROWS ONLY;

-- 2. Check period status across all ledgers
SELECT gl.name, gl.ledger_category_code,
       gps.status, gps.closing_status
FROM   gl_period_statuses gps
JOIN   gl_ledgers gl ON gps.ledger_id = gl.ledger_id
WHERE  gps.period_name = '04-26'
  AND  gps.application_id = 101;

-- 3. Extract FND framework log for the failed request
SELECT log.log_sequence, log.module, log.message_text
FROM   fnd_log_messages log, fnd_log_transaction_context con
WHERE  con.transaction_id = &request_id
  AND  con.transaction_type = 'REQUEST'
  AND  con.transaction_context_id = log.transaction_context_id
ORDER BY log.log_sequence;

-- 4. Confirm journals created after fix
SELECT gjh.name, gjh.period_name, gjh.status,
       gjh.running_total_dr, gjh.running_total_cr
FROM   gl_je_headers gjh
WHERE  gjh.je_source = 'Mass Allocation'
  AND  gjh.period_name = '04-26'
ORDER BY gjh.creation_date DESC;
\`\`\``,
};

async function main() {
  console.log('Inserting EBS Mass Allocation R_AMAS0108 runbook...');
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
