import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle EBS OLAP, Data Mining, and Machine Learning — Setup, Training, and Operationalization',
  slug: 'oracle-ebs-olap-data-mining-machine-learning-runbook',
  excerpt:
    'Step-by-step runbook for deploying Oracle Machine Learning analytics on Oracle EBS data: enabling OML in the database, building GL materialized views and analytic views, creating feature engineering tables from AR/AP/inventory base tables, training classification and clustering models using DBMS_DATA_MINING, evaluating model accuracy, and operationalizing predictions through EBS concurrent programs, database triggers, and Oracle Analytics Cloud dashboards.',
  category: 'oracle-ml' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `## Prerequisites

Before starting this runbook:

- [ ] Oracle Database 19c or 21c (Oracle Machine Learning requires Enterprise Edition with Advanced Analytics option, or Oracle Database 19c+ where OML is included in EE)
- [ ] EBS 12.2.x running on this database (or connected to it)
- [ ] DBA access to the EBS database
- [ ] Oracle Advanced Analytics option licensed (or confirm OML is included in your DB license)
- [ ] Minimum 8 GB PGA aggregate target (OML training operations use in-memory sort and matrix operations)
- [ ] APPS schema SELECT access on core tables: GL_BALANCES, AR_PAYMENT_SCHEDULES_ALL, AP_INVOICES_ALL, MTL_MATERIAL_TRANSACTIONS
- [ ] Dedicated schema for OML objects: EBSML (created in Phase 1)
- [ ] At least 24 months of transaction history in the EBS database for meaningful model training

**License note**: Oracle Machine Learning for SQL (OML4SQL) is included with Oracle Database Enterprise Edition 19c and later at no additional cost. Oracle Advanced Analytics (the older name) required a separate option license on versions prior to 19c. Verify your license before proceeding.

---

## Phase 1: Enable Oracle Machine Learning and Create the Analytics Schema

### 1.1 Verify OML is Available

\`\`\`sql
-- Confirm OML components are installed
SELECT comp_name, version, status
FROM   dba_registry
WHERE  comp_name IN ('Oracle Data Mining', 'Oracle OLAP API',
                     'Oracle Label Security', 'Oracle Advanced Analytics');

-- Verify DBMS_DATA_MINING package is accessible
SELECT object_name, object_type, status
FROM   dba_objects
WHERE  object_name = 'DBMS_DATA_MINING'
AND    owner = 'SYS';
-- Expected: PACKAGE and PACKAGE BODY, both VALID
\`\`\`

If \`Oracle Data Mining\` does not appear in dba_registry with status VALID, the component must be installed using the \`catodm.sql\` script from the Oracle home:

\`\`\`bash
# Run as oracle OS user
sqlplus / as sysdba
@$ORACLE_HOME/rdbms/admin/catodm.sql
\`\`\`

### 1.2 Create the EBSML Analytics Schema

\`\`\`sql
-- Create dedicated schema for EBS ML objects
CREATE USER ebsml IDENTIFIED BY [secure_password]
  DEFAULT TABLESPACE users
  TEMPORARY TABLESPACE temp
  QUOTA UNLIMITED ON users;

-- Grant OML privileges
GRANT CREATE SESSION TO ebsml;
GRANT CREATE TABLE TO ebsml;
GRANT CREATE VIEW TO ebsml;
GRANT CREATE MATERIALIZED VIEW TO ebsml;
GRANT CREATE PROCEDURE TO ebsml;
GRANT CREATE JOB TO ebsml;

-- Grant Oracle Data Mining privileges
GRANT CREATE MINING MODEL TO ebsml;
GRANT SELECT ANY MINING MODEL TO ebsml;

-- Grant SELECT on EBS base tables needed for feature engineering
GRANT SELECT ON apps.gl_balances             TO ebsml;
GRANT SELECT ON apps.gl_code_combinations    TO ebsml;
GRANT SELECT ON apps.gl_periods              TO ebsml;
GRANT SELECT ON apps.gl_ledgers              TO ebsml;
GRANT SELECT ON apps.gl_je_headers           TO ebsml;
GRANT SELECT ON apps.gl_je_lines             TO ebsml;
GRANT SELECT ON apps.ar_payment_schedules_all TO ebsml;
GRANT SELECT ON apps.ra_customer_trx_all     TO ebsml;
GRANT SELECT ON apps.hz_cust_accounts        TO ebsml;
GRANT SELECT ON apps.hz_parties              TO ebsml;
GRANT SELECT ON apps.ap_invoices_all         TO ebsml;
GRANT SELECT ON apps.ap_suppliers            TO ebsml;
GRANT SELECT ON apps.mtl_material_transactions TO ebsml;
GRANT SELECT ON apps.mtl_system_items_b      TO ebsml;
GRANT SELECT ON apps.mtl_transaction_types   TO ebsml;

-- Verify grants
SELECT table_name, privilege
FROM   dba_tab_privs
WHERE  grantee = 'EBSML'
ORDER  BY table_name;
\`\`\`

### 1.3 Create Results Tables

\`\`\`sql
CONNECT ebsml/[password];

-- AP duplicate detection results
CREATE TABLE ap_dup_detection_results (
  invoice_id              NUMBER,
  invoice_num             VARCHAR2(50),
  vendor_id               NUMBER,
  invoice_amount          NUMBER,
  predicted_duplicate     NUMBER,     -- 1=duplicate, 0=legitimate
  duplicate_probability   NUMBER,     -- 0.0 to 1.0
  scored_date             DATE DEFAULT SYSDATE,
  model_version           VARCHAR2(50)
);

-- AR customer segment assignments
CREATE TABLE ar_customer_segments (
  cust_account_id         NUMBER,
  account_number          VARCHAR2(30),
  payment_segment         NUMBER,
  segment_confidence      NUMBER,
  segment_label           VARCHAR2(50),  -- populated after cluster analysis
  scored_date             DATE DEFAULT SYSDATE
);

-- Inventory demand predictions
CREATE TABLE inv_demand_predictions (
  item_number             VARCHAR2(40),
  organization_id         NUMBER,
  forecast_month          VARCHAR2(7),   -- YYYY-MM
  predicted_demand        NUMBER,
  actual_demand           NUMBER,        -- populated after the month closes
  model_version           VARCHAR2(50),
  scored_date             DATE DEFAULT SYSDATE
);

-- GL anomaly detection results
CREATE TABLE gl_anomaly_results (
  je_header_id            NUMBER,
  journal_name            VARCHAR2(100),
  created_by              NUMBER,
  period_name             VARCHAR2(15),
  is_anomaly              NUMBER,        -- 0=anomaly, 1=normal
  anomaly_score_pct       NUMBER,
  reviewed_flag           VARCHAR2(1) DEFAULT 'N',
  review_notes            VARCHAR2(500),
  scored_date             DATE DEFAULT SYSDATE
);
\`\`\`

---

## Phase 2: GL OLAP — Materialized View and Analytic View

### 2.1 Create the GL Aggregation Materialized View

\`\`\`sql
CONNECT ebsml/[password];

CREATE MATERIALIZED VIEW gl_mv_source
  BUILD IMMEDIATE
  REFRESH COMPLETE ON DEMAND
AS
SELECT gp.period_year,
       gp.quarter_num,
       gb.period_name,
       gcc.segment1                            AS company,
       gcc.segment2                            AS department,
       gcc.segment3                            AS account,
       gcc.account_type,
       gb.currency_code,
       gb.actual_flag,
       SUM(gb.period_net_dr - gb.period_net_cr)              AS net_activity,
       SUM(gb.begin_balance_dr - gb.begin_balance_cr
           + gb.period_net_dr - gb.period_net_cr)            AS period_end_balance,
       SUM(CASE WHEN gb.actual_flag = 'A' THEN gb.period_net_dr - gb.period_net_cr END)
                                               AS actual_net,
       SUM(CASE WHEN gb.actual_flag = 'B' THEN gb.period_net_dr - gb.period_net_cr END)
                                               AS budget_net
FROM   apps.gl_balances gb
JOIN   apps.gl_code_combinations gcc
       ON gcc.code_combination_id  = gb.code_combination_id
       AND gcc.chart_of_accounts_id = 1
JOIN   apps.gl_periods gp
       ON gp.period_name     = gb.period_name
       AND gp.period_set_name = 'Accounting'
WHERE  gb.ledger_id   = 2
AND    gb.actual_flag IN ('A', 'B')
AND    gcc.enabled_flag = 'Y'
AND    gcc.summary_flag = 'N'
GROUP  BY gp.period_year, gp.quarter_num, gb.period_name,
          gcc.segment1, gcc.segment2, gcc.segment3,
          gcc.account_type, gb.currency_code, gb.actual_flag;

-- Index the MV for common query patterns
CREATE INDEX gl_mv_dept_period_ix ON gl_mv_source(department, period_name);
CREATE INDEX gl_mv_acct_type_ix   ON gl_mv_source(account_type, period_year);
\`\`\`

### 2.2 Schedule MV Refresh

\`\`\`sql
-- Schedule nightly refresh (10pm, after EBS GL posting closes for the day)
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'EBSML_GL_MV_REFRESH',
    job_type        => 'PLSQL_BLOCK',
    job_action      => 'BEGIN DBMS_MVIEW.REFRESH(''EBSML.GL_MV_SOURCE'', ''C''); END;',
    start_date      => TRUNC(SYSDATE) + 22/24,
    repeat_interval => 'FREQ=DAILY; BYHOUR=22',
    enabled         => TRUE,
    comments        => 'Nightly refresh of GL analytics materialized view'
  );
END;
/
\`\`\`

### 2.3 Verify MV Content

\`\`\`sql
-- Quick sanity check: MV should have rows and recent period data
SELECT actual_flag, period_year, COUNT(*) AS row_count,
       SUM(net_activity) AS total_net_activity
FROM   gl_mv_source
GROUP  BY actual_flag, period_year
ORDER  BY period_year DESC, actual_flag;

-- Spot check: total actual net activity should match GL_BALANCES directly
SELECT SUM(gb.period_net_dr - gb.period_net_cr) AS direct_from_gl
FROM   apps.gl_balances gb
WHERE  gb.ledger_id   = 2
AND    gb.actual_flag = 'A'
AND    gb.period_name = 'JUN-26';

SELECT SUM(net_activity) AS from_mv
FROM   gl_mv_source
WHERE  actual_flag = 'A'
AND    period_name = 'JUN-26';
-- The two amounts must match exactly
\`\`\`

---

## Phase 3: AP Duplicate Invoice Detection Model

### 3.1 Create Feature Engineering Table

\`\`\`sql
CONNECT ebsml/[password];

CREATE TABLE ap_invoice_features AS
SELECT ai.invoice_id,
       ai.vendor_id,
       ai.invoice_amount,
       ai.invoice_date,
       ai.creation_date,
       TO_NUMBER(TO_CHAR(ai.creation_date, 'HH24'))   AS creation_hour,
       TO_NUMBER(TO_CHAR(ai.creation_date, 'D'))       AS creation_dow,
       -- Days between this invoice and the previous from same vendor
       ai.invoice_date - LAG(ai.invoice_date)
         OVER (PARTITION BY ai.vendor_id
               ORDER BY ai.invoice_date)               AS days_since_last_invoice,
       -- Normalized amount delta from vendor's mean
       ROUND((ai.invoice_amount - AVG(ai.invoice_amount)
           OVER (PARTITION BY ai.vendor_id))
         / NULLIF(STDDEV(ai.invoice_amount)
           OVER (PARTITION BY ai.vendor_id), 0), 3)    AS amount_zscore,
       -- How many invoices from this vendor in the past 7 days
       COUNT(*) OVER (
         PARTITION BY ai.vendor_id
         ORDER BY ai.invoice_date
         RANGE BETWEEN INTERVAL '7' DAY PRECEDING AND CURRENT ROW
       ) - 1                                           AS same_vendor_last_7d,
       -- Invoice number pattern similarity count (alpha-stripped)
       COUNT(*) OVER (
         PARTITION BY ai.vendor_id,
           REGEXP_REPLACE(UPPER(ai.invoice_num), '[^A-Z]', '')
       )                                               AS inv_num_alpha_pattern_count,
       -- Label: 1=duplicate (cancelled as duplicate), 0=legitimate
       CASE WHEN ai.cancelled_date IS NOT NULL
            AND  UPPER(ai.cancelled_reason_code) LIKE '%DUPLIC%'
            THEN 1 ELSE 0
       END                                             AS is_duplicate
FROM   apps.ap_invoices_all ai
WHERE  ai.org_id = 204
AND    ai.creation_date BETWEEN ADD_MONTHS(SYSDATE, -36) AND SYSDATE;

-- Verify class balance (duplicates vs legitimate)
SELECT is_duplicate, COUNT(*), ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) AS pct
FROM   ap_invoice_features
GROUP  BY is_duplicate;
-- If duplicates < 1%, the model needs class weights adjustment (see settings below)
\`\`\`

### 3.2 Train the Duplicate Detection Model

\`\`\`sql
DECLARE
  v_settings DBMS_DATA_MINING.SETTING_LIST;
BEGIN
  -- Use Decision Tree for interpretability — auditors can see the rule path
  v_settings('ALGO_NAME')              := 'ALGO_DECISION_TREE';
  v_settings('PREP_AUTO')              := 'ON';
  v_settings('TREE_IMPURITY_METRIC')   := 'TREE_IMPURITY_GINI';
  v_settings('TREE_TERM_MAX_DEPTH')    := '8';
  v_settings('TREE_TERM_MINREC_SPLIT') := '20';
  -- Handle class imbalance: duplicate invoices are rare
  v_settings('CLAS_PRIORS_ADJUSTMENT') := 'ON';

  -- Drop and recreate if model already exists
  BEGIN
    DBMS_DATA_MINING.DROP_MODEL('AP_DUPLICATE_DETECT_V1');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  DBMS_DATA_MINING.CREATE_MODEL(
    model_name          => 'AP_DUPLICATE_DETECT_V1',
    mining_function     => DBMS_DATA_MINING.CLASSIFICATION,
    data_table_name     => 'AP_INVOICE_FEATURES',
    case_id_column_name => 'INVOICE_ID',
    target_column_name  => 'IS_DUPLICATE',
    settings_array      => v_settings
  );
  DBMS_OUTPUT.PUT_LINE('Model AP_DUPLICATE_DETECT_V1 created successfully.');
END;
/
\`\`\`

### 3.3 Evaluate Model Accuracy

\`\`\`sql
-- Cross-validation: score the training data and compute a confusion matrix
SELECT actual_class,
       predicted_class,
       COUNT(*) AS count
FROM (
  SELECT is_duplicate AS actual_class,
         PREDICTION(ap_duplicate_detect_v1 USING *) AS predicted_class
  FROM   ap_invoice_features
)
GROUP  BY actual_class, predicted_class
ORDER  BY actual_class, predicted_class;

-- Expected output:
-- ACTUAL  PREDICTED  COUNT
-- 0       0          [true negatives — legitimate correctly identified]
-- 0       1          [false positives — legitimate flagged as duplicate]
-- 1       0          [false negatives — missed duplicates]
-- 1       1          [true positives — duplicates correctly caught]

-- Compute precision and recall
SELECT
  SUM(CASE WHEN actual_class=1 AND predicted_class=1 THEN 1 END) AS true_positives,
  SUM(CASE WHEN actual_class=0 AND predicted_class=1 THEN 1 END) AS false_positives,
  SUM(CASE WHEN actual_class=1 AND predicted_class=0 THEN 1 END) AS false_negatives,
  ROUND(
    SUM(CASE WHEN actual_class=1 AND predicted_class=1 THEN 1.0 END)
    / NULLIF(SUM(CASE WHEN predicted_class=1 THEN 1 END), 0) * 100, 1
  ) AS precision_pct,
  ROUND(
    SUM(CASE WHEN actual_class=1 AND predicted_class=1 THEN 1.0 END)
    / NULLIF(SUM(CASE WHEN actual_class=1 THEN 1 END), 0) * 100, 1
  ) AS recall_pct
FROM (
  SELECT is_duplicate AS actual_class,
         PREDICTION(ap_duplicate_detect_v1 USING *) AS predicted_class
  FROM   ap_invoice_features
);
\`\`\`

Target: Precision > 70%, Recall > 85%. A high-recall model is preferred — it is better to flag a legitimate invoice for review than to let a duplicate invoice reach payment.

### 3.4 Score New Invoices (Daily Job)

\`\`\`sql
-- Create scoring procedure
CREATE OR REPLACE PROCEDURE ebsml.score_ap_duplicates AS
BEGIN
  -- Clear previous day's results
  DELETE FROM ap_dup_detection_results
  WHERE  scored_date < TRUNC(SYSDATE);

  -- Score all invoices created in the last 24 hours
  INSERT INTO ap_dup_detection_results
    (invoice_id, invoice_num, vendor_id, invoice_amount,
     predicted_duplicate, duplicate_probability, model_version)
  SELECT f.invoice_id,
         ai.invoice_num,
         f.vendor_id,
         f.invoice_amount,
         PREDICTION(ap_duplicate_detect_v1 USING
           f.days_since_last_invoice,
           f.amount_zscore,
           f.same_vendor_last_7d,
           f.inv_num_alpha_pattern_count,
           f.creation_hour,
           f.creation_dow
         )                                       AS predicted_duplicate,
         PREDICTION_PROBABILITY(ap_duplicate_detect_v1, 1 USING
           f.days_since_last_invoice,
           f.amount_zscore,
           f.same_vendor_last_7d,
           f.inv_num_alpha_pattern_count,
           f.creation_hour,
           f.creation_dow
         )                                       AS duplicate_probability,
         'AP_DUPLICATE_DETECT_V1'               AS model_version
  FROM   ap_invoice_features f
  JOIN   apps.ap_invoices_all ai ON ai.invoice_id = f.invoice_id
  WHERE  f.is_duplicate IS NULL                  -- unlabeled (new) invoices
  OR     f.invoice_id IN (
           SELECT invoice_id FROM apps.ap_invoices_all
           WHERE  creation_date >= SYSDATE - 1
         );

  COMMIT;
END;
/

-- Schedule daily at 6am (after overnight AP import processing)
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'EBSML_AP_DUP_SCORE',
    job_type        => 'PLSQL_BLOCK',
    job_action      => 'BEGIN EBSML.SCORE_AP_DUPLICATES; END;',
    start_date      => TRUNC(SYSDATE + 1) + 6/24,
    repeat_interval => 'FREQ=DAILY; BYHOUR=6',
    enabled         => TRUE,
    comments        => 'Daily AP duplicate invoice scoring'
  );
END;
/
\`\`\`

---

## Phase 4: AR Customer Payment Clustering

### 4.1 Create Customer Payment Feature Table

\`\`\`sql
CREATE TABLE ar_customer_payment_features AS
SELECT hca.cust_account_id,
       hca.account_number,
       hp.party_name,
       COUNT(aps.payment_schedule_id)              AS invoice_count_12m,
       ROUND(AVG(aps.amount_due_original), 0)      AS avg_invoice_amount,
       ROUND(AVG(
         CASE WHEN aps.actual_date_closed IS NOT NULL
              THEN aps.actual_date_closed - aps.due_date
         END
       ), 1)                                       AS avg_days_late,
       ROUND(STDDEV(
         CASE WHEN aps.actual_date_closed IS NOT NULL
              THEN aps.actual_date_closed - aps.due_date
         END
       ), 1)                                       AS stddev_days_late,
       ROUND(COUNT(CASE WHEN aps.actual_date_closed > aps.due_date
                        THEN 1 END) * 100.0
             / NULLIF(COUNT(aps.actual_date_closed), 0), 1) AS pct_invoices_paid_late,
       ROUND(NVL(MAX(CASE WHEN aps.status = 'OP'
                          THEN SYSDATE - aps.due_date END), 0), 0)
                                                   AS max_days_overdue_open,
       ROUND(NVL(SUM(CASE WHEN aps.status = 'OP'
                          THEN aps.amount_due_remaining END), 0), 0)
                                                   AS total_open_balance,
       ROUND(NVL(SUM(aps.amount_due_original), 0), 0)
                                                   AS total_invoiced_12m
FROM   apps.hz_cust_accounts hca
JOIN   apps.hz_parties hp ON hp.party_id = hca.party_id
LEFT JOIN apps.ar_payment_schedules_all aps
       ON aps.customer_id = hca.cust_account_id
       AND aps.class      = 'INV'
       AND aps.trx_date   >= ADD_MONTHS(SYSDATE, -12)
WHERE  hca.status = 'A'
GROUP  BY hca.cust_account_id, hca.account_number, hp.party_name
HAVING COUNT(aps.payment_schedule_id) >= 3;   -- minimum 3 invoices for meaningful behavior
\`\`\`

### 4.2 Train K-Means Clustering Model

\`\`\`sql
DECLARE
  v_settings DBMS_DATA_MINING.SETTING_LIST;
BEGIN
  v_settings('ALGO_NAME')           := 'ALGO_KMEANS';
  v_settings('PREP_AUTO')           := 'ON';
  v_settings('KMNS_ITERATIONS')     := '50';
  v_settings('KMNS_NUM_CLUSTERS')   := '5';
  v_settings('KMNS_DISTANCE')       := 'KMNS_EUCLIDEAN';
  v_settings('KMNS_MIN_PCT_ATTR_SUPPORT') := '0.1';

  BEGIN DBMS_DATA_MINING.DROP_MODEL('AR_CUSTOMER_SEGMENTS_V1');
  EXCEPTION WHEN OTHERS THEN NULL; END;

  DBMS_DATA_MINING.CREATE_MODEL(
    model_name          => 'AR_CUSTOMER_SEGMENTS_V1',
    mining_function     => DBMS_DATA_MINING.CLUSTERING,
    data_table_name     => 'AR_CUSTOMER_PAYMENT_FEATURES',
    case_id_column_name => 'CUST_ACCOUNT_ID',
    target_column_name  => NULL,
    settings_array      => v_settings
  );
END;
/
\`\`\`

### 4.3 Analyze Cluster Characteristics and Label Them

\`\`\`sql
-- Compute cluster centroids to understand what each segment represents
SELECT cl.cluster_id,
       COUNT(*) AS customer_count,
       ROUND(AVG(f.avg_days_late), 1)       AS segment_avg_days_late,
       ROUND(AVG(f.pct_invoices_paid_late), 1) AS segment_pct_late,
       ROUND(AVG(f.total_open_balance), 0)  AS segment_avg_open_balance,
       ROUND(AVG(f.total_invoiced_12m), 0)  AS segment_avg_invoiced_12m
FROM   ar_customer_payment_features f
CROSS JOIN (
  SELECT DISTINCT CLUSTER_ID(ar_customer_segments_v1 USING
    f2.avg_days_late, f2.pct_invoices_paid_late, f2.total_open_balance,
    f2.avg_invoice_amount, f2.invoice_count_12m) AS cluster_id
  FROM   ar_customer_payment_features f2
) cl
WHERE  CLUSTER_ID(ar_customer_segments_v1 USING
    f.avg_days_late, f.pct_invoices_paid_late, f.total_open_balance,
    f.avg_invoice_amount, f.invoice_count_12m) = cl.cluster_id
GROUP  BY cl.cluster_id
ORDER  BY segment_avg_days_late;
\`\`\`

Based on the centroid analysis, assign segment labels in the AR_CUSTOMER_SEGMENTS table:

| Typical Cluster Profile | Suggested Label | Collections Strategy |
|------------------------|----------------|---------------------|
| avg_days_late < 0, pct_late < 10% | Prompt Payer | Standard — no action |
| avg_days_late 0–15, pct_late 20–40% | Occasional Late | Reminder at 5 days past due |
| avg_days_late 15–30, pct_late 40–70% | Chronically Late | Call at due date, escalate at 10 days |
| avg_days_late > 30, high open balance | High Risk | Credit hold review, weekly contact |
| Low invoice count, sporadic | Inactive/Intermittent | Confirm relationship still active |

\`\`\`sql
-- Update segment labels based on analysis
UPDATE ar_customer_segments
SET    segment_label = CASE payment_segment
         WHEN 1 THEN 'PROMPT_PAYER'
         WHEN 2 THEN 'OCCASIONAL_LATE'
         WHEN 3 THEN 'CHRONICALLY_LATE'
         WHEN 4 THEN 'HIGH_RISK'
         WHEN 5 THEN 'INTERMITTENT'
       END;
COMMIT;
\`\`\`

---

## Phase 5: Inventory Demand Forecasting Model

### 5.1 Create Demand History Feature Table

\`\`\`sql
CREATE TABLE inv_demand_features AS
SELECT msi.inventory_item_id,
       msi.segment1                                        AS item_number,
       msi.description,
       TO_CHAR(mtt.transaction_date, 'YYYY-MM')            AS demand_month,
       TO_NUMBER(TO_CHAR(mtt.transaction_date, 'MM'))      AS month_num,
       TO_NUMBER(TO_CHAR(mtt.transaction_date, 'Q'))       AS quarter_num,
       TO_NUMBER(TO_CHAR(mtt.transaction_date, 'YYYY'))    AS demand_year,
       SUM(ABS(mtt.transaction_quantity))                  AS total_demand,
       LAG(SUM(ABS(mtt.transaction_quantity)), 1)
         OVER (PARTITION BY msi.inventory_item_id
               ORDER BY TO_CHAR(mtt.transaction_date, 'YYYY-MM'))  AS demand_lag1,
       LAG(SUM(ABS(mtt.transaction_quantity)), 2)
         OVER (PARTITION BY msi.inventory_item_id
               ORDER BY TO_CHAR(mtt.transaction_date, 'YYYY-MM'))  AS demand_lag2,
       LAG(SUM(ABS(mtt.transaction_quantity)), 3)
         OVER (PARTITION BY msi.inventory_item_id
               ORDER BY TO_CHAR(mtt.transaction_date, 'YYYY-MM'))  AS demand_lag3,
       LAG(SUM(ABS(mtt.transaction_quantity)), 12)
         OVER (PARTITION BY msi.inventory_item_id
               ORDER BY TO_CHAR(mtt.transaction_date, 'YYYY-MM'))  AS demand_lag12
FROM   apps.mtl_material_transactions mtt
JOIN   apps.mtl_system_items_b msi
       ON msi.inventory_item_id = mtt.inventory_item_id
       AND msi.organization_id  = mtt.organization_id
WHERE  mtt.organization_id      = 204
AND    mtt.transaction_type_id  IN (
         SELECT transaction_type_id
         FROM   apps.mtl_transaction_types
         WHERE  transaction_type_name IN ('Sales Order Issue', 'Issue', 'Backflush')
       )
AND    mtt.transaction_date     >= ADD_MONTHS(SYSDATE, -36)
GROUP  BY msi.inventory_item_id, msi.segment1, msi.description,
          TO_CHAR(mtt.transaction_date, 'YYYY-MM'),
          TO_NUMBER(TO_CHAR(mtt.transaction_date, 'MM')),
          TO_NUMBER(TO_CHAR(mtt.transaction_date, 'Q')),
          TO_NUMBER(TO_CHAR(mtt.transaction_date, 'YYYY'));

-- Remove rows with NULL lags (not enough history)
DELETE FROM inv_demand_features
WHERE  demand_lag12 IS NULL
OR     demand_lag1 IS NULL;
\`\`\`

### 5.2 Train Regression Model

\`\`\`sql
DECLARE
  v_settings DBMS_DATA_MINING.SETTING_LIST;
BEGIN
  v_settings('ALGO_NAME')            := 'ALGO_GENERALIZED_LINEAR_MODEL';
  v_settings('PREP_AUTO')            := 'ON';
  v_settings('GLMS_SOLVER')          := 'GLMS_SOLVER_QR';
  v_settings('GLMS_RIDGE_REGRESSION'):= 'GLMS_RIDGE_REG_ENABLE';
  v_settings('GLMS_RIDGE_VALUE')     := '0.1';

  BEGIN DBMS_DATA_MINING.DROP_MODEL('INV_DEMAND_FORECAST_V1');
  EXCEPTION WHEN OTHERS THEN NULL; END;

  DBMS_DATA_MINING.CREATE_MODEL(
    model_name          => 'INV_DEMAND_FORECAST_V1',
    mining_function     => DBMS_DATA_MINING.REGRESSION,
    data_table_name     => 'INV_DEMAND_FEATURES',
    case_id_column_name => 'ITEM_NUMBER',
    target_column_name  => 'TOTAL_DEMAND',
    settings_array      => v_settings
  );
END;
/
\`\`\`

### 5.3 Evaluate Regression Accuracy

\`\`\`sql
-- Compute MAPE (Mean Absolute Percentage Error) on historical data
SELECT ROUND(AVG(
         ABS(actual - predicted) / NULLIF(actual, 0) * 100
       ), 2) AS mape_pct
FROM (
  SELECT total_demand AS actual,
         GREATEST(0,
           PREDICTION(inv_demand_forecast_v1 USING
             demand_lag1, demand_lag2, demand_lag3, demand_lag12,
             month_num, quarter_num)
         )            AS predicted
  FROM   inv_demand_features
  WHERE  total_demand > 0
);
-- Target: MAPE < 20%. If > 30%, consider training separate models per item category.
\`\`\`

### 5.4 Generate Monthly Predictions

\`\`\`sql
-- Score current month features to predict next month
INSERT INTO inv_demand_predictions
  (item_number, organization_id, forecast_month, predicted_demand, model_version)
SELECT item_number,
       204                                     AS organization_id,
       TO_CHAR(ADD_MONTHS(SYSDATE, 1), 'YYYY-MM') AS forecast_month,
       GREATEST(0, ROUND(
         PREDICTION(inv_demand_forecast_v1 USING
           demand_lag1, demand_lag2, demand_lag3, demand_lag12,
           month_num, quarter_num), 0
       ))                                      AS predicted_demand,
       'INV_DEMAND_FORECAST_V1'
FROM   inv_demand_features
WHERE  demand_month = TO_CHAR(SYSDATE, 'YYYY-MM');

COMMIT;
\`\`\`

---

## Phase 6: GL Anomaly Detection

### 6.1 Create Journal Feature Table

\`\`\`sql
CREATE TABLE gl_journal_features AS
SELECT gjh.je_header_id,
       gjh.name                               AS journal_name,
       gjh.created_by,
       gjh.creation_date,
       gjh.period_name,
       TO_NUMBER(TO_CHAR(gjh.creation_date, 'HH24'))  AS creation_hour,
       TO_NUMBER(TO_CHAR(gjh.creation_date, 'D'))      AS creation_dow,
       COUNT(gjl.je_line_num)                          AS line_count,
       ROUND(SUM(gjl.accounted_dr), 2)                 AS total_debit_amount,
       ROUND(SUM(gjl.accounted_cr), 2)                 AS total_credit_amount,
       COUNT(CASE WHEN UPPER(gjl.description) LIKE '%REVERS%' THEN 1 END)
         * 100.0 / COUNT(gjl.je_line_num)             AS pct_reversal_lines,
       COUNT(DISTINCT gjl.code_combination_id)         AS distinct_accounts,
       -- Ratio: this journal's total vs average journal for this source
       ROUND(SUM(gjl.accounted_dr) /
         NULLIF(AVG(SUM(gjl.accounted_dr))
           OVER (PARTITION BY gjh.je_source), 0), 2)   AS amount_ratio_to_source_avg
FROM   apps.gl_je_headers gjh
JOIN   apps.gl_je_lines gjl ON gjl.je_header_id = gjh.je_header_id
WHERE  gjh.ledger_id     = 2
AND    gjh.status        = 'P'
AND    gjh.creation_date >= ADD_MONTHS(SYSDATE, -24)
GROUP  BY gjh.je_header_id, gjh.name, gjh.created_by,
          gjh.creation_date, gjh.period_name,
          gjh.je_source;
\`\`\`

### 6.2 Train Anomaly Detection Model

\`\`\`sql
DECLARE
  v_settings DBMS_DATA_MINING.SETTING_LIST;
BEGIN
  v_settings('ALGO_NAME')             := 'ALGO_SUPPORT_VECTOR_MACHINES';
  v_settings('SVMS_KERNEL_FUNCTION')  := 'SVMS_RBF';
  v_settings('PREP_AUTO')             := 'ON';
  v_settings('SVMS_OUTLIER_RATE')     := '.05';   -- Top 5% flagged as anomalies

  BEGIN DBMS_DATA_MINING.DROP_MODEL('GL_ANOMALY_DETECT_V1');
  EXCEPTION WHEN OTHERS THEN NULL; END;

  DBMS_DATA_MINING.CREATE_MODEL(
    model_name          => 'GL_ANOMALY_DETECT_V1',
    mining_function     => DBMS_DATA_MINING.ANOMALY_DETECTION,
    data_table_name     => 'GL_JOURNAL_FEATURES',
    case_id_column_name => 'JE_HEADER_ID',
    target_column_name  => NULL,
    settings_array      => v_settings
  );
END;
/
\`\`\`

### 6.3 Score Current Period Journals

\`\`\`sql
-- Score all journals for the current accounting period
INSERT INTO gl_anomaly_results
  (je_header_id, journal_name, created_by, period_name,
   is_anomaly, anomaly_score_pct)
SELECT f.je_header_id,
       f.journal_name,
       f.created_by,
       f.period_name,
       PREDICTION(gl_anomaly_detect_v1 USING
         f.creation_hour, f.creation_dow, f.line_count,
         f.total_debit_amount, f.pct_reversal_lines,
         f.distinct_accounts, f.amount_ratio_to_source_avg
       )                                              AS is_anomaly,
       ROUND(
         PREDICTION_PROBABILITY(gl_anomaly_detect_v1, 0 USING
           f.creation_hour, f.creation_dow, f.line_count,
           f.total_debit_amount, f.pct_reversal_lines,
           f.distinct_accounts, f.amount_ratio_to_source_avg
         ) * 100, 1
       )                                              AS anomaly_score_pct
FROM   gl_journal_features f
WHERE  f.period_name = 'JUN-26'
AND    NOT EXISTS (
         SELECT 1 FROM gl_anomaly_results r
         WHERE  r.je_header_id = f.je_header_id
       );

COMMIT;

-- Review queue: anomalies sorted by severity
SELECT r.je_header_id,
       r.journal_name,
       fu.user_name    AS created_by_user,
       r.period_name,
       f.total_debit_amount,
       f.creation_hour,
       f.line_count,
       r.anomaly_score_pct
FROM   gl_anomaly_results r
JOIN   gl_journal_features f ON f.je_header_id = r.je_header_id
JOIN   apps.fnd_user fu       ON fu.user_id    = r.created_by
WHERE  r.is_anomaly   = 0            -- anomalous journals
AND    r.reviewed_flag = 'N'         -- not yet reviewed
AND    r.period_name  = 'JUN-26'
ORDER  BY r.anomaly_score_pct DESC;
\`\`\`

---

## Phase 7: Model Monitoring and Retraining

### 7.1 AP Duplicate Model — Monthly Accuracy Check

\`\`\`sql
-- After 30 days: compare predictions to actuals (invoices actually cancelled as duplicate)
SELECT
  SUM(CASE WHEN r.predicted_duplicate = 1 AND ai.cancelled_reason_code LIKE '%DUPLIC%'
           THEN 1 END)                      AS true_positives,
  SUM(CASE WHEN r.predicted_duplicate = 1
           AND (ai.cancelled_reason_code NOT LIKE '%DUPLIC%'
                OR ai.cancelled_date IS NULL) THEN 1 END) AS false_positives,
  SUM(CASE WHEN r.predicted_duplicate = 0 AND ai.cancelled_reason_code LIKE '%DUPLIC%'
           THEN 1 END)                      AS false_negatives,
  ROUND(
    SUM(CASE WHEN r.predicted_duplicate = 1 AND ai.cancelled_reason_code LIKE '%DUPLIC%'
             THEN 1.0 END)
    / NULLIF(SUM(CASE WHEN r.predicted_duplicate = 1 THEN 1 END), 0) * 100, 1
  ) AS precision_pct,
  ROUND(
    SUM(CASE WHEN r.predicted_duplicate = 1 AND ai.cancelled_reason_code LIKE '%DUPLIC%'
             THEN 1.0 END)
    / NULLIF(SUM(CASE WHEN ai.cancelled_reason_code LIKE '%DUPLIC%'
                       AND ai.cancelled_date IS NOT NULL THEN 1 END), 0) * 100, 1
  ) AS recall_pct
FROM   ap_dup_detection_results r
JOIN   apps.ap_invoices_all ai ON ai.invoice_id = r.invoice_id
WHERE  r.scored_date >= ADD_MONTHS(SYSDATE, -1)
AND    r.scored_date < SYSDATE;
\`\`\`

**Retrain trigger**: If Recall drops below 75% or Precision drops below 60%, retrain the model by re-running the CREATE_MODEL step with refreshed training data from the past 36 months.

### 7.2 Demand Forecast — MAPE Tracking

\`\`\`sql
-- After each month closes: compare predictions to actuals and compute MAPE
UPDATE inv_demand_predictions p
SET    p.actual_demand = (
         SELECT SUM(ABS(mtt.transaction_quantity))
         FROM   apps.mtl_material_transactions mtt
         JOIN   apps.mtl_system_items_b msi
                ON msi.inventory_item_id = mtt.inventory_item_id
                AND msi.organization_id  = mtt.organization_id
         WHERE  msi.segment1         = p.item_number
         AND    mtt.organization_id  = p.organization_id
         AND    TO_CHAR(mtt.transaction_date, 'YYYY-MM') = p.forecast_month
         AND    mtt.transaction_type_id IN (
                  SELECT transaction_type_id FROM apps.mtl_transaction_types
                  WHERE  transaction_type_name IN ('Sales Order Issue', 'Issue', 'Backflush')
                )
       )
WHERE  p.forecast_month = TO_CHAR(ADD_MONTHS(SYSDATE, -1), 'YYYY-MM');

-- Rolling 6-month MAPE
SELECT ROUND(AVG(ABS(actual_demand - predicted_demand)
               / NULLIF(actual_demand, 0) * 100), 2) AS rolling_mape_pct
FROM   inv_demand_predictions
WHERE  forecast_month >= TO_CHAR(ADD_MONTHS(SYSDATE, -6), 'YYYY-MM')
AND    actual_demand  IS NOT NULL
AND    actual_demand  > 0;
\`\`\`

---

## Model Inventory

| Model Name | Type | Target Table | Schedule | Retrain Trigger |
|-----------|------|-------------|---------|----------------|
| AP_DUPLICATE_DETECT_V1 | Classification (Decision Tree) | AP_DUP_DETECTION_RESULTS | Daily 6am | Recall < 75% |
| AR_CUSTOMER_SEGMENTS_V1 | Clustering (K-Means) | AR_CUSTOMER_SEGMENTS | Monthly 1st | Cluster silhouette drops > 20% |
| INV_DEMAND_FORECAST_V1 | Regression (GLM) | INV_DEMAND_PREDICTIONS | Monthly last day | MAPE > 30% |
| GL_ANOMALY_DETECT_V1 | Anomaly Detection (SVM) | GL_ANOMALY_RESULTS | Nightly after GL close | Annual retrain on 24-month window |`,
};

async function main() {
  console.log('Inserting EBS OLAP/ML runbook...');
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
