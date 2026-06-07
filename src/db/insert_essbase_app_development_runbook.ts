import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Essbase Application Build, Calculation, and Data Load',
  slug: 'oracle-essbase-application-build-calculation-runbook',
  excerpt:
    'A phased operational runbook for Essbase 21c covering MaxL commands for application and database creation, outline dimension and member management, calculation script development and execution, flat-file and SQL data loading, application administration, and a health-check shell script scheduled via crontab.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-05'),
  youtubeUrl: null,
  content: `This runbook covers Oracle Essbase 21c (and Hyperion 11.2.x) application build, calculation scripting, and data loading operations end to end. All commands are MaxL or shell. Run each phase in order. Assumes \${ARBORPATH} is set, MaxL Shell is available, and you are logged in as the essbase OS user.

---

## Phase 0: Application and Database Creation

### Step 0.1: Create application and BSO database (MaxL)

\`\`\`
/* create_app.mxl */
CREATE APPLICATION 'FinPlan' USING SERVER RULES;

CREATE DATABASE 'FinPlan'.'Plan1'
  TYPE BSO
  USING SERVER RULES;
\`\`\`

### Step 0.2: Set database cache properties

\`\`\`
ALTER DATABASE 'FinPlan'.'Plan1'
  SET CACHE MEMBASE 64 MB
  SET DATACACHE SIZE 128 MB
  SET INDEXCACHE SIZE 32 MB;
\`\`\`

### Step 0.3: Run MaxL from OS shell

\`\`\`bash
\${ARBORPATH}/bin/startMaxl.sh \\
  -u admin \\
  -p "\${ESSBASE_ADMIN_PASS}" \\
  -s essbase-host \\
  /u01/scripts/create_app.mxl
\`\`\`

---

## Phase 1: Outline Dimension and Member Management

### Step 1.1: Add dimensions

\`\`\`
/* Add Account dimension — DENSE */
ALTER DATABASE 'FinPlan'.'Plan1'
  ADD DIMENSION "Accounts"
  TYPE ACCOUNTS
  DENSE;

/* Add Time dimension — SPARSE */
ALTER DATABASE 'FinPlan'.'Plan1'
  ADD DIMENSION "Year"
  TYPE TIME
  SPARSE;

/* Add Scenario and Entity — SPARSE */
ALTER DATABASE 'FinPlan'.'Plan1'
  ADD DIMENSION "Scenario" SPARSE;

ALTER DATABASE 'FinPlan'.'Plan1'
  ADD DIMENSION "Entity" SPARSE;
\`\`\`

### Step 1.2: Add Time hierarchy (Year > Quarter > Month)

\`\`\`
ALTER DATABASE 'FinPlan'.'Plan1'
  ADD MEMBER "FY2026" AS CHILD OF "Year" TYPE DYNAMIC_CALC;

ALTER DATABASE 'FinPlan'.'Plan1'
  ADD MEMBER "Q1" AS CHILD OF "FY2026" TYPE DYNAMIC_CALC;

ALTER DATABASE 'FinPlan'.'Plan1'
  ADD MEMBER "Jan" AS CHILD OF "Q1";
ALTER DATABASE 'FinPlan'.'Plan1'
  ADD MEMBER "Feb" AS CHILD OF "Q1";
ALTER DATABASE 'FinPlan'.'Plan1'
  ADD MEMBER "Mar" AS CHILD OF "Q1";
\`\`\`

### Step 1.3: Add Account members with consolidation operators

\`\`\`
/* Revenue — additive */
ALTER DATABASE 'FinPlan'.'Plan1'
  ADD MEMBER "Total Revenue" AS CHILD OF "Accounts"
  CONSOLIDATION "+" DATA_STORAGE STORE_DATA;

ALTER DATABASE 'FinPlan'.'Plan1'
  ADD MEMBER "Product Revenue" AS CHILD OF "Total Revenue"
  CONSOLIDATION "+";

ALTER DATABASE 'FinPlan'.'Plan1'
  ADD MEMBER "Service Revenue" AS CHILD OF "Total Revenue"
  CONSOLIDATION "+";

/* COGS — Expense tag for correct variance sign */
ALTER DATABASE 'FinPlan'.'Plan1'
  ADD MEMBER "Total COGS" AS CHILD OF "Accounts"
  CONSOLIDATION "+" EXPENSE;

/* Gross Profit — dynamic calc, no consolidation (~) */
ALTER DATABASE 'FinPlan'.'Plan1'
  ADD MEMBER "Gross Profit" AS CHILD OF "Accounts"
  CONSOLIDATION "~"
  TYPE DYNAMIC_CALC
  FORMULA "\\"Total Revenue\\" - \\"Total COGS\\"";
\`\`\`

### Step 1.4: Add Scenario members

\`\`\`
ALTER DATABASE 'FinPlan'.'Plan1'
  ADD MEMBER "Actual"   AS CHILD OF "Scenario";
ALTER DATABASE 'FinPlan'.'Plan1'
  ADD MEMBER "Budget"   AS CHILD OF "Scenario";
ALTER DATABASE 'FinPlan'.'Plan1'
  ADD MEMBER "Forecast" AS CHILD OF "Scenario";

/* Variance — dynamic calc */
ALTER DATABASE 'FinPlan'.'Plan1'
  ADD MEMBER "Variance"
  AS CHILD OF "Scenario"
  TYPE DYNAMIC_CALC
  FORMULA "\\"Actual\\" - \\"Budget\\"";

ALTER DATABASE 'FinPlan'.'Plan1'
  ADD MEMBER "Variance %"
  AS CHILD OF "Scenario"
  TYPE DYNAMIC_CALC
  FORMULA "\\"Variance\\" / @ABS(\\"Budget\\") * 100";
\`\`\`

### Step 1.5: Verify outline integrity

\`\`\`
QUERY DATABASE 'FinPlan'.'Plan1' GET OUTLINE ERRORS;
QUERY DATABASE 'FinPlan'.'Plan1' GET DIMENSIONS;
\`\`\`

---

## Phase 2: Calculation Scripts

### Step 2.1: Default aggregation script (calc_default.csc)

\`\`\`
SET AGGMISSG ON;
SET UPDATECALC OFF;
CALC ALL;
\`\`\`

### Step 2.2: Budget calculation with FIX scope (calc_budget.csc)

\`\`\`
SET UPDATECALC OFF;
SET CALCPARALLEL 4;

FIX("Budget", @RELATIVE("All Years", 0))

  "Gross Profit"     = "Total Revenue" - "Total COGS";
  "Operating Income" = "Gross Profit" - "Total Opex";
  "Net Income"       = "Operating Income" - "Total Other";

ENDFIX

AGG("Accounts", "Entity", "Year");
\`\`\`

### Step 2.3: Allocation — spread annual budget evenly to months

\`\`\`
FIX("Budget", "FY2026")

  @RELATIVE("All Entities", 0)(
    @RELATIVE("All Accounts", 0)(
      @ALLOCATE("FY2026",
        @LIST("Jan","Feb","Mar","Apr","May","Jun",
              "Jul","Aug","Sep","Oct","Nov","Dec"),
        EVENLY,
        "FY2026");
    )
  )

ENDFIX
\`\`\`

### Step 2.4: Execute a calculation script via MaxL

\`\`\`
EXECUTE CALCULATION 'FinPlan'.'Plan1'.'calc_budget';
\`\`\`

### Step 2.5: Shell wrapper for calculation execution

\`\`\`bash
#!/bin/bash
# run_calc.sh
APP="FinPlan"
DB="Plan1"
CALC="\${1:-calc_budget}"
LOG="/u01/logs/calc_\${APP}_\${DB}_\$(date +%Y%m%d_%H%M%S).log"

\${ARBORPATH}/bin/startMaxl.sh \\
  -u admin \\
  -p "\${ESSBASE_ADMIN_PASS}" \\
  -s essbase-host \\
  -L "\${LOG}" << 'MAXLEOF'
EXECUTE CALCULATION 'FinPlan'.'Plan1'.'calc_budget';
MAXLEOF

RC=\$?
if [ \${RC} -ne 0 ]; then
  echo "ERROR: Calc failed (RC=\${RC}). See \${LOG}" >&2
  exit \${RC}
fi
echo "Calc complete. Log: \${LOG}"
\`\`\`

---

## Phase 3: Data Loading

### Step 3.1: Create a data load rule

\`\`\`
CREATE RULEFILE 'FinPlan'.'Plan1'.'load_actuals'
  DATA_FILE '/u01/data/actuals_202601.csv';

ALTER RULEFILE 'FinPlan'.'Plan1'.'load_actuals'
  SET FIELD 0 TO DIMENSION "Entity"
  SET FIELD 1 TO DIMENSION "Accounts"
  SET FIELD 2 TO DIMENSION "Year"
  SET FIELD 3 TO DATAVALUE;
\`\`\`

### Step 3.2: Load from flat file

\`\`\`
IMPORT DATABASE 'FinPlan'.'Plan1'
  DATA FROM LOCAL DATA_FILE '/u01/data/actuals_202601.csv'
  USING RULES_FILE 'FinPlan'.'Plan1'.'load_actuals'
  ON ERROR WRITE TO '/u01/logs/actuals_errors.txt';
\`\`\`

### Step 3.3: Load from SQL/ODBC source

\`\`\`
IMPORT DATABASE 'FinPlan'.'Plan1'
  DATA FROM SERVER ODBC_DSN 'FinanceDW'
  SQL 'SELECT entity_code, account_code, period_key, amount
       FROM fact_financials
       WHERE scenario = ''ACTUAL'' AND fiscal_year = 2026'
  USING RULES_FILE 'FinPlan'.'Plan1'.'load_sql_actuals'
  ON ERROR WRITE TO '/u01/logs/sql_errors.txt';
\`\`\`

### Step 3.4: Clear a FIX slice and reload

\`\`\`
/* Clear Budget FY2026 */
FIX ("Budget", "FY2026")
  CLEARDATA;
ENDFIX

/* Reload */
IMPORT DATABASE 'FinPlan'.'Plan1'
  DATA FROM LOCAL DATA_FILE '/u01/data/budget_2026.csv'
  USING RULES_FILE 'FinPlan'.'Plan1'.'load_budget';
\`\`\`

### Step 3.5: Data load shell script with error checking

\`\`\`bash
#!/bin/bash
# load_essbase.sh
DATA_FILE="\${1:-/u01/data/actuals_202601.csv}"
RULE_FILE="load_actuals"
LOG="/u01/logs/essbase_load_\$(date +%Y%m%d_%H%M%S).log"
ERROR_FILE="/u01/logs/essbase_load_errors_\$(date +%Y%m%d_%H%M%S).txt"

\${ARBORPATH}/bin/startMaxl.sh \\
  -u admin -p "\${ESSBASE_ADMIN_PASS}" \\
  -s essbase-host -L "\${LOG}" << MAXLEOF
IMPORT DATABASE 'FinPlan'.'Plan1'
  DATA FROM LOCAL DATA_FILE '\${DATA_FILE}'
  USING RULES_FILE 'FinPlan'.'Plan1'.'\${RULE_FILE}'
  ON ERROR WRITE TO '\${ERROR_FILE}';
MAXLEOF

RC=\$?
ERR_COUNT=\$(wc -l < "\${ERROR_FILE}" 2>/dev/null || echo 0)
[ \${RC} -ne 0 ] && { echo "ERROR: load failed. Log: \${LOG}" >&2; exit \${RC}; }
[ "\${ERR_COUNT}" -gt 0 ] && echo "WARNING: \${ERR_COUNT} records rejected — see \${ERROR_FILE}"
echo "Load complete. Log: \${LOG}"
\`\`\`

---

## Phase 4: Application Administration

### Step 4.1: Export all data (backup)

\`\`\`
EXPORT DATABASE 'FinPlan'.'Plan1'
  ALL DATA TO DATA_FILE '/u01/backup/finplan_plan1_\$(date +%Y%m%d).txt';
\`\`\`

### Step 4.2: Restructure after outline changes

\`\`\`
ALTER DATABASE 'FinPlan'.'Plan1'
  RESTRUCTURE KEEP_ALL_DATA;
/* Options: KEEP_ALL_DATA | KEEP_INPUT_DATA | DISCARD_ALL_DATA */
\`\`\`

### Step 4.3: Check database statistics

\`\`\`
QUERY DATABASE 'FinPlan'.'Plan1' GET STATISTICS;
/* Shows: block count, existing/potential ratio, compression, cluster ratio */
/* Target cluster ratio > 0.8. Below 0.6 = fragmented — export and re-import */
\`\`\`

### Step 4.4: Set user permissions

\`\`\`
GRANT READ ON DATABASE 'FinPlan'.'Plan1' TO USER "finance_users";
GRANT WRITE ON DATABASE 'FinPlan'.'Plan1' TO USER "budget_owners";
GRANT DATABASE_ACCESS ON DATABASE 'FinPlan'.'Plan1' TO USER "essbase_admin";
\`\`\`

### Step 4.5: Start and stop application

\`\`\`
START APPLICATION 'FinPlan';

ALTER APPLICATION 'FinPlan' DISABLE CONNECTS;
STOP APPLICATION 'FinPlan';
\`\`\`

---

## Phase 5: Performance Monitoring

### Step 5.1: List active sessions

\`\`\`
QUERY SYSTEM LIST ACTIVE SESSIONS ONLY;
QUERY APPLICATION 'FinPlan' LIST DATABASES;
\`\`\`

### Step 5.2: Check application logs for errors

\`\`\`bash
# Application log:
tail -100 \${ARBORPATH}/app/FinPlan/Plan1/Plan1.log

# Server log:
tail -100 \${ARBORPATH}/bin/essbase.log

# Filter for errors:
grep -iE "error|warning|aborted|failed" \\
  \${ARBORPATH}/app/FinPlan/Plan1/Plan1.log | tail -30
\`\`\`

### Step 5.3: Tune BSO cache settings

\`\`\`
ALTER DATABASE 'FinPlan'.'Plan1'
  SET CACHE MEMBASE 128 MB
  SET DATACACHE SIZE 256 MB
  SET INDEXCACHE SIZE 64 MB;
/* Increase DataCache until cache hit rate > 95% (visible in server log) */
\`\`\`

---

## Phase 6: Health Check Script

\`\`\`bash
#!/bin/bash
# essbase_health_check.sh
ESSBASE_HOST="\${1:-essbase-host}"
APP="\${2:-FinPlan}"
DB="\${3:-Plan1}"
LOG_DIR="/u01/app/oracle/scripts/essbase_health/logs"
LOG_FILE="\${LOG_DIR}/essbase_health_\$(date +%Y%m%d_%H%M%S).log"
ALERT_EMAIL="dba-team@yourcompany.com"
ISSUES=0

mkdir -p "\${LOG_DIR}"
exec > >(tee -a "\${LOG_FILE}") 2>&1
echo "=== Essbase Health Check: \$(date) ==="
echo "Host: \${ESSBASE_HOST}  App: \${APP}  DB: \${DB}"

# Check application status via MaxL
STATUS=\$(\${ARBORPATH}/bin/startMaxl.sh \\
  -u admin -p "\${ESSBASE_ADMIN_PASS}" -s "\${ESSBASE_HOST}" << 'MAXLEOF' 2>&1
QUERY APPLICATION 'FinPlan' LIST DATABASES;
MAXLEOF
)
if echo "\${STATUS}" | grep -qi "error\|not started\|cannot connect"; then
  echo "CRITICAL: Essbase application not reachable or not started"
  ISSUES=\$((ISSUES + 1))
else
  echo "OK: Essbase application responding"
fi

# Check app log for errors in last 60 minutes
APP_LOG="\${ARBORPATH}/app/\${APP}/\${DB}/\${DB}.log"
if [ -f "\${APP_LOG}" ]; then
  RECENT_ERRORS=\$(find "\${APP_LOG}" -newer /tmp -exec grep -ciE "error|aborted|failed" {} \\; 2>/dev/null || echo 0)
  LOG_ERRORS=\$(awk -v d="\$(date -d '60 minutes ago' '+%H:%M:%S')" '\$1 >= d' "\${APP_LOG}" 2>/dev/null | grep -ciE "error|aborted" || echo 0)
  if [ "\${LOG_ERRORS}" -gt 0 ]; then
    echo "WARNING: \${LOG_ERRORS} error entries in app log in last 60 minutes"
    ISSUES=\$((ISSUES + 1))
  else
    echo "OK: No recent errors in app log"
  fi
fi

# Check disk space on Essbase data directory
DATA_DIR="\${ARBORPATH}/app/\${APP}/\${DB}"
if [ -d "\${DATA_DIR}" ]; then
  DISK_PCT=\$(df "\${DATA_DIR}" | awk 'NR==2{gsub(/%/,""); print \$5}')
  if [ "\${DISK_PCT:-0}" -gt 85 ]; then
    echo "WARNING: Essbase data directory is \${DISK_PCT}% full — \${DATA_DIR}"
    ISSUES=\$((ISSUES + 1))
  else
    echo "OK: Disk usage \${DISK_PCT}% on \${DATA_DIR}"
  fi
fi

echo "=== Total issues: \${ISSUES} ==="

if [ "\${ISSUES}" -gt 0 ]; then
  echo "Sending alert to \${ALERT_EMAIL}"
  mailx -s "Essbase Health Alert: \${ISSUES} issue(s) on \${ESSBASE_HOST}/\${APP}/\${DB}" \\
    "\${ALERT_EMAIL}" < "\${LOG_FILE}" 2>/dev/null || true
fi

exit \${ISSUES}
\`\`\`

Crontab entry:
\`\`\`
*/15  *  *  *  *  /u01/app/oracle/scripts/essbase_health/essbase_health_check.sh essbase-host FinPlan Plan1 >> /u01/app/oracle/scripts/essbase_health/logs/cron_essbase.log 2>&1
\`\`\`

---

## Quick Reference

**Key MaxL commands:**
\`\`\`
CREATE APPLICATION 'App' USING SERVER RULES
CREATE DATABASE 'App'.'DB' TYPE BSO
START APPLICATION 'App'
STOP APPLICATION 'App'
EXECUTE CALCULATION 'App'.'DB'.'script_name'
IMPORT DATABASE 'App'.'DB' DATA FROM LOCAL DATA_FILE '...' USING RULES_FILE '...'
EXPORT DATABASE 'App'.'DB' ALL DATA TO DATA_FILE '...'
QUERY DATABASE 'App'.'DB' GET STATISTICS
QUERY SYSTEM LIST ACTIVE SESSIONS ONLY
GRANT READ ON DATABASE 'App'.'DB' TO USER 'username'
\`\`\`

**Key calculation functions:**
\`\`\`
FIX / ENDFIX            Scope restriction
@CHILDREN(mbr)          Immediate children
@DESCENDANTS(mbr)       All descendants
@RELATIVE(mbr, 0)       Leaf-level members
@SUM(list)              Sum of member list
@PRIOR(mbr)             Prior period member
@PTD                    Period-to-date
@ALLOCATE               Proportional allocation
@XREF                   Cross-database reference
@ISUDA(mbr, "uda")      Test UDA membership
CALC ALL                Calculate entire database
AGG(dim1, dim2, ...)    Aggregate specified dimensions
CLEARDATA               Clear data in FIX scope
\`\`\`

**Key log file paths:**
\`\`\`
\${ARBORPATH}/bin/essbase.log                  Server-level log
\${ARBORPATH}/app/{App}/{DB}/{DB}.log           Application/database log
\${ARBORPATH}/app/{App}/{DB}/{DB}.err           Error log
\`\`\``,
};

async function main() {
  console.log('Inserting Essbase application build runbook...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: { ...post },
  });
  console.log('Inserted: "' + post.title + '"');
}

main().catch(console.error);
