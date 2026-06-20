import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'EBS to Essbase Integration Runbook: Staging, Outline Load, Monitoring, and Crontab Schedule',
  slug: 'ebs-essbase-integration-runbook',
  excerpt:
    'Operational runbook for the EBS-to-Essbase ETL pipeline: staging table setup and validation, Outline Load Utility configuration, incremental and full cube refresh procedures, shell monitoring scripts, crontab schedule, and a troubleshooting quick reference.',
  category: 'performance-dw' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-19'),
  youtubeUrl: null,
  content: `This runbook operationalises the four-layer EBS-to-Essbase integration architecture described in the companion blog post. It is structured as a sequence of phases that an operator follows during initial deployment and then re-enters selectively during monthly and nightly refresh cycles.

---

## Prerequisites

### EBS Database Access

The operator account used to run extraction queries must have SELECT privileges on the following EBS GL schema objects:

\`\`\`sql
-- Grant read access to integration service account (run as DBA)
GRANT SELECT ON APPS.GL_BALANCES              TO intg_svc;
GRANT SELECT ON APPS.GL_CODE_COMBINATIONS     TO intg_svc;
GRANT SELECT ON APPS.GL_PERIODS               TO intg_svc;
GRANT SELECT ON APPS.GL_BUDGET_ENTRIES        TO intg_svc;
GRANT SELECT ON APPS.FND_FLEX_VALUES          TO intg_svc;
GRANT SELECT ON APPS.FND_FLEX_VALUE_SETS      TO intg_svc;
GRANT SELECT ON APPS.FND_FLEX_VALUE_HIERARCHIES TO intg_svc;
GRANT SELECT ON APPS.RG_ROW_SETS              TO intg_svc;
GRANT SELECT ON APPS.RG_ROWS                  TO intg_svc;
GRANT SELECT ON APPS.RG_ROW_ORDERS            TO intg_svc;
\`\`\`

Verify access before proceeding:

\`\`\`sql
SELECT COUNT(*) FROM apps.gl_balances WHERE ROWNUM = 1;
SELECT COUNT(*) FROM apps.fnd_flex_value_sets WHERE ROWNUM = 1;
\`\`\`

If either query returns ORA-00942 (table or view does not exist), the synonym or grant is missing. Contact the EBS DBA to correct the APPS schema privileges.

### Essbase Server Connectivity

Verify that the integration host can reach the Essbase server on the configured agent port:

\`\`\`bash
# Replace essbase-host and port with your environment values
nc -zv essbase-host 1423 && echo "Essbase agent port reachable" || echo "Port blocked"

# Test XMLA endpoint if using XMLA connectivity
curl -s -o /dev/null -w "%{http_code}" \
  http://essbase-host:19000/aps/XMLA
\`\`\`

Expected: TCP connection succeeds; XMLA endpoint returns HTTP 200 or 401 (authentication required — port is open).

---

## Phase 1 — Staging Table Setup

### Create the Integration Schema and Staging Objects

\`\`\`sql
-- Run as DBA on the integration database (not EBS production)
CREATE USER intg_owner IDENTIFIED BY "ChangeMe2026#"
  DEFAULT TABLESPACE intg_data
  TEMPORARY TABLESPACE temp;

GRANT CONNECT, RESOURCE TO intg_owner;
GRANT CREATE TABLE, CREATE SEQUENCE, CREATE INDEX TO intg_owner;

-- GL balance staging table
CREATE TABLE intg_owner.ebs_essbase_staging (
  staging_id      NUMBER          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company         VARCHAR2(10)    NOT NULL,
  cost_center     VARCHAR2(10)    NOT NULL,
  account         VARCHAR2(10)    NOT NULL,
  product         VARCHAR2(10),
  period          VARCHAR2(10)    NOT NULL,
  fiscal_year     NUMBER(4)       NOT NULL,
  period_num      NUMBER(2)       NOT NULL,
  amount          NUMBER(20,2)    NOT NULL,
  balance_type    VARCHAR2(1)     NOT NULL,   -- A=Actual, B=Budget
  currency_code   VARCHAR2(3)     NOT NULL,
  source_ledger   NUMBER          NOT NULL,
  load_batch_id   VARCHAR2(30),
  load_timestamp  DATE            DEFAULT SYSDATE,
  load_status     VARCHAR2(10)    DEFAULT 'PENDING'
                  CHECK (load_status IN ('PENDING','LOADED','REJECTED','SKIPPED'))
);

CREATE INDEX intg_owner.idx_staging_status_yr
  ON intg_owner.ebs_essbase_staging (load_status, fiscal_year, period_num);

-- Hierarchy staging table
CREATE TABLE intg_owner.ebs_essbase_hierarchy (
  hier_id         NUMBER          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  value_set_name  VARCHAR2(60)    NOT NULL,
  dimension_name  VARCHAR2(30)    NOT NULL,
  parent_member   VARCHAR2(80)    NOT NULL,
  child_from      VARCHAR2(80)    NOT NULL,
  child_to        VARCHAR2(80)    NOT NULL,
  member_alias    VARCHAR2(255),
  is_rollup       VARCHAR2(1)     DEFAULT 'N',
  enabled_flag    VARCHAR2(1)     DEFAULT 'Y',
  load_timestamp  DATE            DEFAULT SYSDATE,
  load_status     VARCHAR2(10)    DEFAULT 'PENDING'
                  CHECK (load_status IN ('PENDING','LOADED','REJECTED'))
);

-- Load audit log
CREATE TABLE intg_owner.ebs_essbase_load_log (
  log_id          NUMBER          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id        VARCHAR2(30)    NOT NULL,
  phase           VARCHAR2(30)    NOT NULL,
  start_time      DATE,
  end_time        DATE,
  records_in      NUMBER          DEFAULT 0,
  records_loaded  NUMBER          DEFAULT 0,
  records_rejected NUMBER         DEFAULT 0,
  status          VARCHAR2(10)    DEFAULT 'RUNNING',
  error_message   VARCHAR2(4000)
);
\`\`\`

### Validate Staging Schema

\`\`\`sql
-- Confirm objects exist with correct column count
SELECT table_name, num_rows
FROM   user_tables
WHERE  table_name IN ('EBS_ESSBASE_STAGING','EBS_ESSBASE_HIERARCHY','EBS_ESSBASE_LOAD_LOG')
ORDER  BY table_name;

-- Confirm index is present
SELECT index_name, status FROM user_indexes
WHERE  table_name = 'EBS_ESSBASE_STAGING';
\`\`\`

---

## Phase 2 — Extraction and Staging Load

### Run the Extraction Script

The extraction script connects to EBS (read-only), queries GL and dimension tables, and inserts rows into the staging tables. Replace the parameter values for your environment before running.

\`\`\`bash
#!/usr/bin/env bash
# ebs_extract.sh — Extract GL balances and hierarchies from EBS into staging
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="\${SCRIPT_DIR}/logs"
mkdir -p "\${LOG_DIR}"

TIMESTAMP=\$(date '+%Y%m%d_%H%M%S')
BATCH_ID="EXTRACT_\${TIMESTAMP}"
LOG_FILE="\${LOG_DIR}/extract_\${TIMESTAMP}.log"

# Parameters — set via environment or config file
LEDGER_ID="\${LEDGER_ID:-1}"
FISCAL_YEAR="\${FISCAL_YEAR:-\$(date '+%Y')}"
CURRENCY="\${CURRENCY:-USD}"
VALUE_SET_NAMES="\${VALUE_SET_NAMES:-COMPANY_SEG COSTCENTER_SEG ACCOUNT_SEG PRODUCT_SEG}"

EBS_CONN="\${EBS_DB_USER}/\${EBS_DB_PASS}@\${EBS_DB_HOST}:\${EBS_DB_PORT}/\${EBS_DB_SERVICE}"
INTG_CONN="\${INTG_DB_USER}/\${INTG_DB_PASS}@\${INTG_DB_HOST}:\${INTG_DB_PORT}/\${INTG_DB_SERVICE}"

log() { echo "\$(date '+%Y-%m-%d %H:%M:%S') [\${BATCH_ID}] \$1" | tee -a "\${LOG_FILE}"; }

log "Starting extraction. Ledger=\${LEDGER_ID} Year=\${FISCAL_YEAR} Currency=\${CURRENCY}"

# Step 1: Extract GL balances into staging
log "Extracting GL balances..."
sqlplus -s "\${EBS_CONN}" <<EOF >> "\${LOG_FILE}" 2>&1
SET SERVEROUTPUT ON
SET FEEDBACK OFF
DECLARE
  v_batch  VARCHAR2(30) := '\${BATCH_ID}';
  v_rows   NUMBER := 0;
BEGIN
  INSERT INTO intg_owner.ebs_essbase_staging@intg_link
    (company, cost_center, account, product,
     period, fiscal_year, period_num,
     amount, balance_type, currency_code, source_ledger, load_batch_id)
  SELECT
    gcc.segment1, gcc.segment2, gcc.segment3, gcc.segment4,
    gp.period_name, gp.period_year, gp.period_num,
    SUM(gb.period_net_dr - gb.period_net_cr),
    gb.actual_flag, gb.currency_code, gb.ledger_id,
    v_batch
  FROM   gl_balances gb
  JOIN   gl_code_combinations gcc
         ON gcc.code_combination_id = gb.code_combination_id
  JOIN   gl_periods gp
         ON gp.period_name     = gb.period_name
        AND gp.period_set_name = gb.period_set_name
  WHERE  gb.ledger_id     = \${LEDGER_ID}
    AND  gb.actual_flag   IN ('A', 'B')
    AND  gp.period_year   = \${FISCAL_YEAR}
    AND  gb.currency_code = '\${CURRENCY}'
  GROUP  BY gcc.segment1, gcc.segment2, gcc.segment3, gcc.segment4,
            gp.period_name, gp.period_year, gp.period_num,
            gb.actual_flag, gb.currency_code, gb.ledger_id;

  v_rows := SQL%ROWCOUNT;
  COMMIT;
  DBMS_OUTPUT.PUT_LINE('GL rows inserted: ' || v_rows);
END;
/
EOF

log "GL extraction complete. Check log for row count."

# Step 2: Validate staging totals
log "Validating staging totals..."
sqlplus -s "\${INTG_CONN}" <<EOF >> "\${LOG_FILE}" 2>&1
SET PAGESIZE 50
SET LINESIZE 120
SELECT balance_type,
       fiscal_year,
       COUNT(*)        AS row_count,
       SUM(amount)     AS total_amount,
       load_status
FROM   intg_owner.ebs_essbase_staging
WHERE  load_batch_id = '\${BATCH_ID}'
GROUP  BY balance_type, fiscal_year, load_status
ORDER  BY fiscal_year, balance_type;
EOF

log "Extraction complete. Batch ID: \${BATCH_ID}"
\`\`\`

### Validate Before Proceeding to Cube Load

\`\`\`sql
-- Run against the integration database before triggering cube load
SELECT
  balance_type,
  fiscal_year,
  COUNT(*)          AS row_count,
  SUM(amount)       AS total_amount,
  MIN(period_num)   AS first_period,
  MAX(period_num)   AS last_period
FROM   intg_owner.ebs_essbase_staging
WHERE  load_status = 'PENDING'
GROUP  BY balance_type, fiscal_year
ORDER  BY fiscal_year, balance_type;
\`\`\`

Expected: Actuals (A) rows present for all closed periods; Budget (B) rows present if a budget exists in EBS. If row count is zero, the extraction WHERE clause or DB link is the problem.

---

## Phase 3 — Hierarchy Synchronisation

### Export Hierarchy File

Run this query and spool the output to a flat file for the Outline Load Utility. The file must be sorted so that parent members appear before their children across the full hierarchy.

\`\`\`sql
-- Spool to /intg/outlines/account_hier_YYYYMMDD.txt
SELECT
  ffvh.parent_flex_value         || '~' ||
  ffv_child.flex_value           || '~' ||
  ffv_child.description          || '~' ||
  '~' ||                                   -- Formula (blank for data members)
  CASE ffv_child.summary_flag
    WHEN 'Y' THEN '+'
    ELSE 'Never Share'
  END                            || '~' ||
  CASE ffv_child.summary_flag
    WHEN 'Y' THEN 'Y'
    ELSE 'N'
  END                            AS outline_record
FROM   fnd_flex_value_hierarchies ffvh
JOIN   fnd_flex_value_sets fvs
       ON fvs.flex_value_set_id = ffvh.flex_value_set_id
JOIN   fnd_flex_values ffv_child
       ON ffv_child.flex_value_set_id = ffvh.flex_value_set_id
      AND ffv_child.flex_value
          BETWEEN ffvh.child_flex_value_low AND ffvh.child_flex_value_high
WHERE  fvs.flex_value_set_name = 'ACCOUNT_SEG'
  AND  ffv_child.enabled_flag  = 'Y'
ORDER  BY ffvh.parent_flex_value, ffv_child.flex_value;
\`\`\`

### Check for Missing Essbase Members

Before running the outline load, identify any EBS segment values that have no corresponding Essbase member. These will cause data load rejections if not resolved.

\`\`\`sql
-- Segment values enabled in EBS but absent from the Essbase member map
SELECT ffv.flex_value,
       ffv.description,
       ffv.enabled_flag,
       ffv.summary_flag
FROM   fnd_flex_values ffv
JOIN   fnd_flex_value_sets fvs ON fvs.flex_value_set_id = ffv.flex_value_set_id
WHERE  fvs.flex_value_set_name = 'ACCOUNT_SEG'
  AND  ffv.enabled_flag = 'Y'
  AND  ffv.flex_value NOT IN (
         SELECT essbase_member_name
         FROM   intg_owner.ebs_essbase_member_map
         WHERE  dimension_name = 'Account'
       )
ORDER  BY ffv.flex_value;
\`\`\`

If this query returns rows, add the missing members to the hierarchy file before running the Outline Load.

---

## Phase 4 — Outline Load

The Outline Load Utility updates the Essbase database metadata. It must run and complete successfully before the data load begins.

### Outline Load Script

\`\`\`bash
#!/usr/bin/env bash
# essbase_outline_load.sh — Update Essbase cube outline from hierarchy file
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="\${SCRIPT_DIR}/logs"
OUTLINE_DIR="\${SCRIPT_DIR}/outlines"
TIMESTAMP=\$(date '+%Y%m%d_%H%M%S')
LOG_FILE="\${LOG_DIR}/outline_load_\${TIMESTAMP}.log"

ESS_SERVER="\${ESS_SERVER:-essbase-host}"
ESS_PORT="\${ESS_PORT:-1423}"
ESS_USER="\${ESS_ADMIN_USER}"
ESS_PASS="\${ESS_ADMIN_PASS}"
APP_NAME="\${ESS_APP_NAME:-FINPLAN}"
DB_NAME="\${ESS_DB_NAME:-ACTUALS}"

log() { echo "\$(date '+%Y-%m-%d %H:%M:%S') \$1" | tee -a "\${LOG_FILE}"; }

# Dimensions to load — order matters: load Account before Entity before Time
DIMENSIONS=("Account" "Entity" "CostCenter" "Product")

for DIM in "\${DIMENSIONS[@]}"; do
  HIER_FILE="\${OUTLINE_DIR}/\${DIM,,}_hier_\$(date '+%Y%m%d').txt"

  if [[ ! -f "\${HIER_FILE}" ]]; then
    log "WARNING: Hierarchy file not found for \${DIM}: \${HIER_FILE}"
    continue
  fi

  log "Loading outline for dimension: \${DIM}"

  # The Outline Load Utility is invoked via the ETL engine's command-line client.
  # Replace the command below with the invocation specific to your ETL tool.
  # Example using a generic outline load CLI:
  outline_load_cli \
    --server  "\${ESS_SERVER}" \
    --port    "\${ESS_PORT}"   \
    --user    "\${ESS_USER}"   \
    --pass    "\${ESS_PASS}"   \
    --app     "\${APP_NAME}"   \
    --db      "\${DB_NAME}"    \
    --dim     "\${DIM}"        \
    --file    "\${HIER_FILE}"  \
    --delimiter "~"            \
    --mode    "MERGE"          \
    >> "\${LOG_FILE}" 2>&1

  EXIT_CODE=\$?
  if [[ \${EXIT_CODE} -ne 0 ]]; then
    log "ERROR: Outline load failed for \${DIM}. Exit code: \${EXIT_CODE}"
    exit 1
  fi

  log "Outline load complete for \${DIM}"
done

log "All outline loads complete."
\`\`\`

### Verify Outline Load Success

Check the Essbase load log for the session and confirm member counts match expectations:

\`\`\`bash
# Count Essbase members via XMLA query (example using curl)
# Replace with your ETL tool's member count API call
curl -s -u "\${ESS_ADMIN_USER}:\${ESS_ADMIN_PASS}" \
  "http://\${ESS_SERVER}:19000/aps/XMLA" \
  -H "Content-Type: text/xml" \
  -d "<Envelope xmlns='http://schemas.xmlsoap.org/soap/envelope/'>
        <Body><Discover xmlns='urn:schemas-microsoft-com:xml-analysis'>
          <RequestType>MDSCHEMA_MEMBERS</RequestType>
          <Restrictions><RestrictionList>
            <CATALOG_NAME>\${ESS_APP_NAME}</CATALOG_NAME>
            <CUBE_NAME>\${ESS_DB_NAME}</CUBE_NAME>
            <DIMENSION_UNIQUE_NAME>[Account]</DIMENSION_UNIQUE_NAME>
          </RestrictionList></Restrictions>
          <Properties><PropertyList>
            <DataSourceInfo>Provider=Essbase;Data Source=\${ESS_SERVER}</DataSourceInfo>
            <Catalog>\${ESS_APP_NAME}</Catalog>
          </PropertyList></Properties>
        </Discover></Body>
      </Envelope>" | grep -c "MEMBER_NAME" || true
\`\`\`

---

## Phase 5 — Data Load

### Full Refresh (Month-End)

A full refresh clears existing data blocks for the target periods and reloads from staging. This is the correct procedure for month-end close and initial loads.

\`\`\`bash
#!/usr/bin/env bash
# essbase_data_load_full.sh — Full refresh for a given fiscal year
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="\${SCRIPT_DIR}/logs"
DATA_DIR="\${SCRIPT_DIR}/data"
TIMESTAMP=\$(date '+%Y%m%d_%H%M%S')
LOG_FILE="\${LOG_DIR}/data_load_full_\${TIMESTAMP}.log"
FISCAL_YEAR="\${FISCAL_YEAR:-\$(date '+%Y')}"
DATA_FILE="\${DATA_DIR}/gl_actuals_full_\${FISCAL_YEAR}_\${TIMESTAMP}.txt"

ESS_APP="\${ESS_APP_NAME:-FINPLAN}"
ESS_DB="\${ESS_DB_NAME:-ACTUALS}"

log() { echo "\$(date '+%Y-%m-%d %H:%M:%S') \$1" | tee -a "\${LOG_FILE}"; }

log "Generating data load file from staging..."

# Export staging data to tilde-delimited load file
sqlplus -s "\${INTG_CONN}" <<EOF > "\${DATA_FILE}"
SET PAGESIZE 0
SET FEEDBACK OFF
SET HEADING OFF
SET LINESIZE 500
SELECT
  company     || '~' ||
  cost_center || '~' ||
  account     || '~' ||
  NVL(product, 'No_Product') || '~' ||
  period      || '~' ||
  CASE balance_type WHEN 'A' THEN 'Actual' ELSE 'Budget' END || '~' ||
  currency_code || '~' ||
  TO_CHAR(amount, 'FM99999999999990.99')
FROM   intg_owner.ebs_essbase_staging
WHERE  load_status  = 'PENDING'
  AND  fiscal_year  = \${FISCAL_YEAR}
ORDER  BY period_num, company, account;
EOF

ROW_COUNT=\$(wc -l < "\${DATA_FILE}")
log "Data file generated: \${ROW_COUNT} rows -> \${DATA_FILE}"

if [[ \${ROW_COUNT} -eq 0 ]]; then
  log "ERROR: No staging rows found for year \${FISCAL_YEAR}. Aborting."
  exit 1
fi

# Clear target year data blocks before loading
log "Clearing existing data blocks for FY\${FISCAL_YEAR}..."
# Replace with your ETL tool's clear-data command
essbase_clear_cli \
  --app "\${ESS_APP}" --db "\${ESS_DB}" \
  --scenario Actual --year "\${FISCAL_YEAR}" \
  >> "\${LOG_FILE}" 2>&1

# Load data into Essbase
log "Loading data into Essbase..."
essbase_load_cli \
  --app  "\${ESS_APP}"   \
  --db   "\${ESS_DB}"    \
  --file "\${DATA_FILE}" \
  --rule "GL_LOAD_RULE"  \
  --abort-on-error       \
  >> "\${LOG_FILE}" 2>&1

EXIT_CODE=\$?
if [[ \${EXIT_CODE} -ne 0 ]]; then
  log "ERROR: Data load failed. Exit code: \${EXIT_CODE}"
  exit 1
fi

# Mark staging rows as loaded
sqlplus -s "\${INTG_CONN}" <<EOF >> "\${LOG_FILE}" 2>&1
UPDATE intg_owner.ebs_essbase_staging
SET    load_status = 'LOADED', load_timestamp = SYSDATE
WHERE  load_status = 'PENDING'
  AND  fiscal_year = \${FISCAL_YEAR};
COMMIT;
EOF

log "Full refresh complete for FY\${FISCAL_YEAR}."
\`\`\`

### Incremental Refresh (Nightly)

An incremental refresh loads only rows added or modified since the last successful run. It does not clear existing blocks.

\`\`\`bash
#!/usr/bin/env bash
# essbase_data_load_incremental.sh — Nightly incremental load
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="\${SCRIPT_DIR}/logs"
DATA_DIR="\${SCRIPT_DIR}/data"
TIMESTAMP=\$(date '+%Y%m%d_%H%M%S')
LOG_FILE="\${LOG_DIR}/data_load_incr_\${TIMESTAMP}.log"
DATA_FILE="\${DATA_DIR}/gl_actuals_incr_\${TIMESTAMP}.txt"
STATE_FILE="\${SCRIPT_DIR}/state/last_run_timestamp.txt"

log() { echo "\$(date '+%Y-%m-%d %H:%M:%S') \$1" | tee -a "\${LOG_FILE}"; }

# Determine last run time (default: yesterday midnight if no state file)
if [[ -f "\${STATE_FILE}" ]]; then
  LAST_RUN=\$(cat "\${STATE_FILE}")
else
  LAST_RUN=\$(date -d "yesterday 00:00:00" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || \
              date -v-1d -v0H -v0M -v0S '+%Y-%m-%d %H:%M:%S')
fi

log "Incremental load. Records since: \${LAST_RUN}"

sqlplus -s "\${INTG_CONN}" <<EOF > "\${DATA_FILE}"
SET PAGESIZE 0
SET FEEDBACK OFF
SET HEADING OFF
SET LINESIZE 500
SELECT
  company     || '~' ||
  cost_center || '~' ||
  account     || '~' ||
  NVL(product, 'No_Product') || '~' ||
  period      || '~' ||
  CASE balance_type WHEN 'A' THEN 'Actual' ELSE 'Budget' END || '~' ||
  currency_code || '~' ||
  TO_CHAR(amount, 'FM99999999999990.99')
FROM   intg_owner.ebs_essbase_staging
WHERE  load_status   = 'PENDING'
  AND  load_timestamp >= TO_DATE('\${LAST_RUN}', 'YYYY-MM-DD HH24:MI:SS')
ORDER  BY period_num, company, account;
EOF

ROW_COUNT=\$(wc -l < "\${DATA_FILE}")
log "Incremental file: \${ROW_COUNT} rows"

if [[ \${ROW_COUNT} -eq 0 ]]; then
  log "No new records since last run. Exiting cleanly."
  exit 0
fi

essbase_load_cli \
  --app  "\${ESS_APP_NAME:-FINPLAN}" \
  --db   "\${ESS_DB_NAME:-ACTUALS}"  \
  --file "\${DATA_FILE}"             \
  --rule "GL_LOAD_RULE"              \
  >> "\${LOG_FILE}" 2>&1

# Mark loaded rows and save new state
sqlplus -s "\${INTG_CONN}" <<EOF >> "\${LOG_FILE}" 2>&1
UPDATE intg_owner.ebs_essbase_staging
SET    load_status = 'LOADED', load_timestamp = SYSDATE
WHERE  load_status = 'PENDING'
  AND  load_timestamp >= TO_DATE('\${LAST_RUN}', 'YYYY-MM-DD HH24:MI:SS');
COMMIT;
EOF

date '+%Y-%m-%d %H:%M:%S' > "\${STATE_FILE}"
log "Incremental load complete. State file updated."
\`\`\`

---

## Phase 6 — Monitoring Scripts

### Pipeline Health Monitor

This script runs on a schedule and alerts when staging records are stuck in PENDING status beyond the expected load window.

\`\`\`bash
#!/usr/bin/env bash
# ebs_essbase_monitor.sh — Pipeline health check and alert
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="\${SCRIPT_DIR}/logs"
ALERT_EMAIL="\${ALERT_EMAIL:-dba-team@company.example}"
TIMESTAMP=\$(date '+%Y%m%d_%H%M%S')
LOG_FILE="\${LOG_DIR}/monitor_\${TIMESTAMP}.log"

# Thresholds
PENDING_AGE_WARN_HOURS=4    # Warn if PENDING record is older than this
PENDING_AGE_CRIT_HOURS=12   # Critical if older than this
REJECTION_WARN_COUNT=10     # Warn if rejected rows exceed this count

log() { echo "\$(date '+%Y-%m-%d %H:%M:%S') \$1" | tee -a "\${LOG_FILE}"; }

send_alert() {
  local SEVERITY="\$1"
  local MESSAGE="\$2"
  log "ALERT [\${SEVERITY}]: \${MESSAGE}"
  echo "Subject: [\${SEVERITY}] EBS-Essbase Integration Alert
\${MESSAGE}

Timestamp: \$(date)
Host: \$(hostname)
Log: \${LOG_FILE}" | sendmail "\${ALERT_EMAIL}"
}

log "Starting pipeline health check..."

# Check 1: Stale PENDING records
STALE_WARN=\$(sqlplus -s "\${INTG_CONN}" <<EOF
SET HEADING OFF FEEDBACK OFF PAGESIZE 0
SELECT COUNT(*) FROM intg_owner.ebs_essbase_staging
WHERE  load_status = 'PENDING'
  AND  load_timestamp < SYSDATE - \${PENDING_AGE_WARN_HOURS}/24;
EOF
)
STALE_CRIT=\$(sqlplus -s "\${INTG_CONN}" <<EOF
SET HEADING OFF FEEDBACK OFF PAGESIZE 0
SELECT COUNT(*) FROM intg_owner.ebs_essbase_staging
WHERE  load_status = 'PENDING'
  AND  load_timestamp < SYSDATE - \${PENDING_AGE_CRIT_HOURS}/24;
EOF
)

STALE_WARN=\$(echo "\${STALE_WARN}" | tr -d ' ')
STALE_CRIT=\$(echo "\${STALE_CRIT}" | tr -d ' ')

if [[ \${STALE_CRIT} -gt 0 ]]; then
  send_alert "CRITICAL" "\${STALE_CRIT} staging records have been PENDING for more than \${PENDING_AGE_CRIT_HOURS} hours. Cube data is stale."
elif [[ \${STALE_WARN} -gt 0 ]]; then
  send_alert "WARNING" "\${STALE_WARN} staging records have been PENDING for more than \${PENDING_AGE_WARN_HOURS} hours."
else
  log "Check 1 passed: No stale PENDING records."
fi

# Check 2: Rejected records
REJECTED=\$(sqlplus -s "\${INTG_CONN}" <<EOF
SET HEADING OFF FEEDBACK OFF PAGESIZE 0
SELECT COUNT(*) FROM intg_owner.ebs_essbase_staging
WHERE  load_status = 'REJECTED'
  AND  load_timestamp > SYSDATE - 1;
EOF
)
REJECTED=\$(echo "\${REJECTED}" | tr -d ' ')

if [[ \${REJECTED} -ge \${REJECTION_WARN_COUNT} ]]; then
  send_alert "WARNING" "\${REJECTED} staging records were rejected in the last 24 hours. Check for missing Essbase members."
else
  log "Check 2 passed: \${REJECTED} rejections in last 24h (below threshold \${REJECTION_WARN_COUNT})."
fi

# Check 3: Essbase server connectivity
if ! nc -zv "\${ESS_SERVER:-essbase-host}" "\${ESS_PORT:-1423}" 2>/dev/null; then
  send_alert "CRITICAL" "Cannot reach Essbase agent on \${ESS_SERVER}:\${ESS_PORT}. Spreadsheet users may be disconnected."
else
  log "Check 3 passed: Essbase agent port reachable."
fi

# Check 4: Member map completeness (new EBS segments not yet in Essbase)
UNMAPPED=\$(sqlplus -s "\${EBS_CONN}" <<EOF
SET HEADING OFF FEEDBACK OFF PAGESIZE 0
SELECT COUNT(*) FROM fnd_flex_values ffv
JOIN   fnd_flex_value_sets fvs ON fvs.flex_value_set_id = ffv.flex_value_set_id
WHERE  fvs.flex_value_set_name = 'ACCOUNT_SEG'
  AND  ffv.enabled_flag = 'Y'
  AND  ffv.flex_value NOT IN (
         SELECT essbase_member_name@intg_link
         FROM   intg_owner.ebs_essbase_member_map@intg_link
         WHERE  dimension_name = 'Account'
       );
EOF
)
UNMAPPED=\$(echo "\${UNMAPPED}" | tr -d ' ')

if [[ \${UNMAPPED} -gt 0 ]]; then
  send_alert "WARNING" "\${UNMAPPED} EBS account segment values are not mapped to Essbase members. Next data load will produce rejections."
else
  log "Check 4 passed: All active EBS account segments are mapped."
fi

log "Health check complete."
\`\`\`

### Load Log Summary Script

\`\`\`bash
#!/usr/bin/env bash
# ebs_essbase_load_summary.sh — Print last 7 days of load activity
set -euo pipefail

sqlplus -s "\${INTG_CONN}" <<EOF
SET PAGESIZE 100
SET LINESIZE 140
COLUMN batch_id     FORMAT A30
COLUMN phase        FORMAT A20
COLUMN status       FORMAT A10
COLUMN duration_min FORMAT 999.9
COLUMN loaded       FORMAT 999999
COLUMN rejected     FORMAT 999999

SELECT
  batch_id,
  phase,
  status,
  ROUND((end_time - start_time) * 1440, 1)  AS duration_min,
  records_loaded    AS loaded,
  records_rejected  AS rejected,
  TO_CHAR(start_time, 'YYYY-MM-DD HH24:MI') AS started_at
FROM   intg_owner.ebs_essbase_load_log
WHERE  start_time > SYSDATE - 7
ORDER  BY start_time DESC;
EOF
\`\`\`

---

## Phase 7 — Crontab Schedule

The schedule runs three tiers of jobs: nightly incremental loads, weekly hierarchy synchronisation, and monthly full refresh.

\`\`\`bash
# Install: crontab -e (as the integration service account)
# Environment variables must be set in the user profile or sourced from a config file

# Load environment
SHELL=/bin/bash
MAILTO=dba-team@company.example
PATH=/usr/local/bin:/usr/bin:/bin

# --- Nightly Incremental Load (Monday-Friday, 02:00) ---
# Loads GL balance rows added or modified since the previous run
0 2 * * 1-5 /opt/intg/scripts/ebs_extract.sh >> /opt/intg/logs/cron_extract.log 2>&1 && \
             /opt/intg/scripts/essbase_data_load_incremental.sh >> /opt/intg/logs/cron_load.log 2>&1

# --- Nightly Health Check (Monday-Friday, 03:30) ---
# Runs after the load window; alerts if PENDING records remain
30 3 * * 1-5 /opt/intg/scripts/ebs_essbase_monitor.sh >> /opt/intg/logs/cron_monitor.log 2>&1

# --- Weekly Hierarchy Sync (Sunday, 23:00) ---
# Re-exports all EBS segment hierarchies and reloads the Essbase outline
0 23 * * 0 /opt/intg/scripts/ebs_extract.sh --hier-only >> /opt/intg/logs/cron_hier.log 2>&1 && \
           /opt/intg/scripts/essbase_outline_load.sh >> /opt/intg/logs/cron_outline.log 2>&1

# --- Monthly Full Refresh (1st of each month, 20:00) ---
# Clears and reloads all data for the fiscal year
0 20 1 * * FISCAL_YEAR=$(date '+%Y') \
           /opt/intg/scripts/essbase_data_load_full.sh >> /opt/intg/logs/cron_full_load.log 2>&1

# --- Load Log Summary (Monday, 08:00) ---
# Emails the weekly load summary to the DBA team
0 8 * * 1 /opt/intg/scripts/ebs_essbase_load_summary.sh | mail -s "EBS-Essbase Weekly Load Summary" dba-team@company.example

# --- Log Rotation (Daily, 04:00) ---
0 4 * * * find /opt/intg/logs -name "*.log" -mtime +30 -delete
\`\`\`

---

## Phase 8 — Troubleshooting Quick Reference

### Diagnostic Queries

\`\`\`sql
-- 1. Staging status overview
SELECT load_status,
       COUNT(*)                           AS record_count,
       MIN(load_timestamp)                AS oldest_record,
       MAX(load_timestamp)                AS newest_record,
       SUM(amount)                        AS total_amount
FROM   intg_owner.ebs_essbase_staging
GROUP  BY load_status
ORDER  BY load_status;

-- 2. Rejected records with context
SELECT staging_id, company, cost_center, account, period,
       fiscal_year, amount, balance_type, load_timestamp
FROM   intg_owner.ebs_essbase_staging
WHERE  load_status = 'REJECTED'
  AND  load_timestamp > SYSDATE - 3
ORDER  BY load_timestamp DESC;

-- 3. Periods in EBS GL_PERIODS that are not in the staging data
-- (indicates periods not yet extracted or not yet open in EBS)
SELECT gp.period_name, gp.period_year, gp.period_num, gp.status
FROM   gl_periods gp
WHERE  gp.period_year  = EXTRACT(YEAR FROM SYSDATE)
  AND  gp.period_set_name = (
         SELECT period_set_name FROM gl_ledgers WHERE ledger_id = :ledger_id
       )
  AND  gp.period_name NOT IN (
         SELECT DISTINCT period
         FROM   intg_owner.ebs_essbase_staging@intg_link
         WHERE  fiscal_year = EXTRACT(YEAR FROM SYSDATE)
       )
ORDER  BY gp.period_num;

-- 4. Budget data check (confirm B rows exist before month-end)
SELECT balance_type, COUNT(*), SUM(amount)
FROM   intg_owner.ebs_essbase_staging
WHERE  fiscal_year = EXTRACT(YEAR FROM SYSDATE)
  AND  load_status IN ('PENDING','LOADED')
GROUP  BY balance_type;
\`\`\`

### Failure Decision Tree

| Symptom | First check | Likely cause | Resolution |
|---------|-------------|--------------|------------|
| Staging row count is zero | Check extract log for SQL errors | DB link down or EBS query returned no rows | Verify DB link; check ledger_id and fiscal_year parameters |
| Data load aborted: member not found | Query unmapped members (Phase 3) | New EBS segment added since last outline load | Run \`essbase_outline_load.sh\` then re-run data load |
| Cube shows prior period data | Check \`load_status\` in staging | Incremental load ran but data load failed silently | Check \`cron_load.log\`; rerun \`essbase_data_load_incremental.sh\` manually |
| Budget scenario missing from cube | Check for B rows in staging | \`ACTUAL_FLAG = 'B'\` excluded from extraction | Verify WHERE clause includes \`'B'\` in \`ebs_extract.sh\` |
| Hierarchy mismatch in reports | Re-query \`FND_FLEX_VALUE_HIERARCHIES\` | Parent-child reassignment in EBS not propagated | Run weekly hierarchy sync (\`essbase_outline_load.sh\`) immediately |
| Spreadsheet add-in timeout | \`nc -zv essbase-host 1423\` | Essbase agent process down or port blocked | Restart Essbase agent; check firewall rule on provider port |
| Outline load rejected members | Check outline load log file | Duplicate member name or invalid parent reference | Fix hierarchy file; remove duplicate entries before reloading |
| Full refresh took longer than expected | Check staging row count vs. previous month | Unusually large number of CCID combinations | Consider partitioning the clear by scenario or period range |

### Emergency: Revert to Previous Cube State

If a data load corrupts cube data, the safest recovery path depends on whether backups are current:

1. **Check last successful backup**: confirm the Essbase application backup completed before the failed load
2. **Restore from backup**: use the ETL engine's restore command to revert the cube to the pre-load state
3. **Mark staging rows as REJECTED**: update \`load_status = 'REJECTED'\` for the batch that caused the corruption so the rows are excluded from the next run
4. **Re-run outline load**: ensure the outline matches the restored cube state before loading any new data
5. **Run full refresh** from the corrected staging data after root cause is confirmed`,
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
