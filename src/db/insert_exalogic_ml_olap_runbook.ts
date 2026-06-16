import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Exalogic OLAP and ML Runbook: Analytic Workspace Setup, EBS Cube Refresh, and In-Database ML Scoring',
  slug: 'exalogic-olap-molap-machine-learning-runbook',
  excerpt:
    'Step-by-step runbook for configuring Oracle OLAP Analytic Workspaces on Exadata, wiring EBS concurrent request cube refresh through Exalogic, configuring OBIEE/OAS data sources against the RAC cluster, and deploying in-database ML models for AP anomaly detection, GL forecasting, inventory demand, and AR risk scoring.',
  category: 'exalogic' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `## Overview

This runbook covers the end-to-end configuration of Oracle OLAP and in-database machine learning on an Oracle Exalogic + Exadata engineered systems deployment running Oracle E-Business Suite 12.2.x. All OLAP and ML execution runs on Exadata; all cube refresh scheduling, BI connectivity, and result surfacing runs on Exalogic.

**Prerequisites:**
- Oracle EBS 12.2.x installed and running on Exalogic WebLogic Server
- Oracle Database 19c or 21c on Exadata with RAC enabled
- Oracle OLAP option licensed and enabled in the database
- Oracle Business Intelligence Enterprise Edition (OBIEE 12c) or Oracle Analytics Server (OAS) deployed on Exalogic
- APPS schema access on the EBS database

---

## Phase 1: Verify OLAP Option on Exadata

Connect to the Exadata database as SYSDBA and confirm the OLAP option is installed and active.

\`\`\`sql
-- Confirm OLAP is in the registry
SELECT comp_name, version, status
FROM   dba_registry
WHERE  comp_name = 'Oracle OLAP API';

-- Confirm the OLAP option is enabled
SELECT value
FROM   v$option
WHERE  parameter = 'OLAP';

-- Confirm OLAP catalog objects are valid
SELECT object_name, object_type, status
FROM   dba_objects
WHERE  object_name LIKE 'AW$%'
AND    status != 'VALID';
\`\`\`

Expected: \`Oracle OLAP API\` with STATUS = \`VALID\`; \`OLAP\` = \`TRUE\`; zero rows from the third query.

If OLAP is not installed, install it from the database home:

\`\`\`bash
# On Exadata database node (as oracle OS user)
cd $ORACLE_HOME/olap/admin
sqlplus / as sysdba @catnoamd.sql    # remove invalid stub objects if present
sqlplus / as sysdba @catnoadm.sql   # install OLAP catalog
\`\`\`

---

## Phase 2: Create the OLAP Schema and Tablespaces on Exadata

Create dedicated tablespaces for Analytic Workspace storage. Analytic Workspaces store cube data in LOB columns; HCC (Hybrid Columnar Compression) on Exadata significantly reduces their footprint.

\`\`\`sql
-- Connect as SYSDBA on Exadata
CREATE TABLESPACE OLAP_DATA
  DATAFILE SIZE 10G AUTOEXTEND ON NEXT 1G MAXSIZE 200G
  EXTENT MANAGEMENT LOCAL
  SEGMENT SPACE MANAGEMENT AUTO;

CREATE TABLESPACE OLAP_INDEX
  DATAFILE SIZE 2G AUTOEXTEND ON NEXT 512M MAXSIZE 50G
  EXTENT MANAGEMENT LOCAL
  SEGMENT SPACE MANAGEMENT AUTO;

-- Temporary tablespace for OLAP intermediate calculations
CREATE TEMPORARY TABLESPACE OLAP_TEMP
  TEMPFILE SIZE 20G AUTOEXTEND ON NEXT 2G MAXSIZE 500G;

-- Undo: Exadata OLAP calculations generate significant undo
-- Confirm undo_retention is at least 3600 seconds
SHOW PARAMETER undo_retention;
ALTER SYSTEM SET undo_retention = 7200 SCOPE=BOTH;
\`\`\`

Create the OLAP schema that will own the Analytic Workspaces:

\`\`\`sql
CREATE USER EBSOLAP
  IDENTIFIED BY "<strong_password>"
  DEFAULT TABLESPACE OLAP_DATA
  TEMPORARY TABLESPACE OLAP_TEMP
  QUOTA UNLIMITED ON OLAP_DATA
  QUOTA UNLIMITED ON OLAP_INDEX;

GRANT CREATE SESSION TO EBSOLAP;
GRANT CREATE TABLE TO EBSOLAP;
GRANT CREATE VIEW TO EBSOLAP;
GRANT CREATE SEQUENCE TO EBSOLAP;
GRANT CREATE PROCEDURE TO EBSOLAP;
GRANT OLAP_USER TO EBSOLAP;
GRANT OLAP_XS_ADMIN TO EBSOLAP;
GRANT SELECT ANY DICTIONARY TO EBSOLAP;

-- Grant read access to EBS base tables
GRANT SELECT ON APPS.GL_BALANCES TO EBSOLAP;
GRANT SELECT ON APPS.GL_CODE_COMBINATIONS TO EBSOLAP;
GRANT SELECT ON APPS.GL_PERIODS TO EBSOLAP;
GRANT SELECT ON APPS.GL_LEDGERS TO EBSOLAP;
GRANT SELECT ON APPS.AP_INVOICES_ALL TO EBSOLAP;
GRANT SELECT ON APPS.AP_INVOICE_DISTRIBUTIONS_ALL TO EBSOLAP;
GRANT SELECT ON APPS.AR_PAYMENT_SCHEDULES_ALL TO EBSOLAP;
GRANT SELECT ON APPS.MTL_MATERIAL_TRANSACTIONS TO EBSOLAP;
GRANT SELECT ON APPS.MTL_SYSTEM_ITEMS_B TO EBSOLAP;
GRANT SELECT ON APPS.CST_PERIOD_CLOSE_SUMMARY TO EBSOLAP;
\`\`\`

---

## Phase 3: Build the GL Analytic Workspace

Use Analytic Workspace Manager (AWM) on a workstation connected to the Exadata database, or use DBMS_AW for scriptable setup. The following procedure creates the GL cube programmatically.

### 3.1 Create the GL Staging View

\`\`\`sql
-- Connect as EBSOLAP
CREATE OR REPLACE VIEW GL_CUBE_SOURCE_V AS
SELECT
  b.ledger_id,
  l.name                           AS ledger_name,
  b.period_name,
  p.period_year,
  p.period_num,
  b.code_combination_id,
  c.segment1                       AS company,
  c.segment2                       AS cost_center,
  c.segment3                       AS account,
  c.segment4                       AS product,
  b.currency_code,
  b.period_net_dr                  AS debit_amount,
  b.period_net_cr                  AS credit_amount,
  b.period_net_dr - b.period_net_cr AS net_amount,
  b.begin_balance_dr,
  b.begin_balance_cr,
  b.period_to_date_dr,
  b.period_to_date_cr
FROM apps.gl_balances b
JOIN apps.gl_ledgers l    ON l.ledger_id    = b.ledger_id
JOIN apps.gl_periods p    ON p.period_name  = b.period_name
                         AND p.period_type  = l.period_type
                         AND p.application_id = 101
JOIN apps.gl_code_combinations c ON c.code_combination_id = b.code_combination_id
WHERE b.actual_flag = 'A'
AND   b.translated_flag IS NULL;
\`\`\`

### 3.2 Create the Analytic Workspace

\`\`\`sql
-- As EBSOLAP
EXECUTE DBMS_AW.EXECUTE('AW CREATE GL_CUBE');
EXECUTE DBMS_AW.EXECUTE('AW ATTACH GL_CUBE RW');

-- Define the Period dimension
EXECUTE DBMS_AW.EXECUTE('DEFINE PERIOD DIMENSION TEXT');
EXECUTE DBMS_AW.EXECUTE('DEFINE PERIOD_YEAR VARIABLE INTEGER <PERIOD>');
EXECUTE DBMS_AW.EXECUTE('DEFINE PERIOD_NUM  VARIABLE INTEGER <PERIOD>');

-- Define the Account dimension (Company.CostCenter.Account.Product)
EXECUTE DBMS_AW.EXECUTE('DEFINE COMPANY      DIMENSION TEXT');
EXECUTE DBMS_AW.EXECUTE('DEFINE COST_CENTER  DIMENSION TEXT');
EXECUTE DBMS_AW.EXECUTE('DEFINE ACCOUNT      DIMENSION TEXT');
EXECUTE DBMS_AW.EXECUTE('DEFINE PRODUCT      DIMENSION TEXT');

-- Define the Currency dimension
EXECUTE DBMS_AW.EXECUTE('DEFINE CURRENCY DIMENSION TEXT');

-- Define the Ledger dimension
EXECUTE DBMS_AW.EXECUTE('DEFINE LEDGER DIMENSION TEXT');

-- Define GL measures
EXECUTE DBMS_AW.EXECUTE('DEFINE GL_NET_AMOUNT   VARIABLE DECIMAL <PERIOD COMPANY COST_CENTER ACCOUNT PRODUCT CURRENCY LEDGER>');
EXECUTE DBMS_AW.EXECUTE('DEFINE GL_DEBIT_AMT    VARIABLE DECIMAL <PERIOD COMPANY COST_CENTER ACCOUNT PRODUCT CURRENCY LEDGER>');
EXECUTE DBMS_AW.EXECUTE('DEFINE GL_CREDIT_AMT   VARIABLE DECIMAL <PERIOD COMPANY COST_CENTER ACCOUNT PRODUCT CURRENCY LEDGER>');
EXECUTE DBMS_AW.EXECUTE('DEFINE GL_BEG_BAL      VARIABLE DECIMAL <PERIOD COMPANY COST_CENTER ACCOUNT PRODUCT CURRENCY LEDGER>');

-- Update (save) the workspace definition
EXECUTE DBMS_AW.EXECUTE('UPDATE');
EXECUTE DBMS_AW.EXECUTE('COMMIT');
EXECUTE DBMS_AW.EXECUTE('AW DETACH GL_CUBE');
\`\`\`

### 3.3 Create the GL Cube Refresh Procedure

\`\`\`sql
CREATE OR REPLACE PROCEDURE EBSOLAP.REFRESH_GL_CUBE AS
BEGIN
  DBMS_AW.EXECUTE('AW ATTACH GL_CUBE RW');

  -- Load dimension values
  DBMS_AW.EXECUTE(
    'MAINTAIN PERIOD ADD SQL.PERIOD_NAME ' ||
    'FROM GL_CUBE_SOURCE_V USING period_name'
  );

  DBMS_AW.EXECUTE(
    'MAINTAIN COMPANY ADD SQL.COMPANY ' ||
    'FROM GL_CUBE_SOURCE_V USING company'
  );

  DBMS_AW.EXECUTE(
    'MAINTAIN COST_CENTER ADD SQL.COST_CENTER ' ||
    'FROM GL_CUBE_SOURCE_V USING cost_center'
  );

  DBMS_AW.EXECUTE(
    'MAINTAIN ACCOUNT ADD SQL.ACCOUNT ' ||
    'FROM GL_CUBE_SOURCE_V USING account'
  );

  DBMS_AW.EXECUTE(
    'MAINTAIN CURRENCY ADD SQL.CURRENCY ' ||
    'FROM GL_CUBE_SOURCE_V USING currency_code'
  );

  DBMS_AW.EXECUTE(
    'MAINTAIN LEDGER ADD SQL.LEDGER ' ||
    'FROM GL_CUBE_SOURCE_V USING ledger_name'
  );

  -- Load measure data
  DBMS_AW.EXECUTE(
    'LOAD GL_NET_AMOUNT FROM GL_CUBE_SOURCE_V USING net_amount ' ||
    'AT PERIOD period_name COMPANY company COST_CENTER cost_center ' ||
    'ACCOUNT account PRODUCT product CURRENCY currency_code LEDGER ledger_name'
  );

  DBMS_AW.EXECUTE('UPDATE');
  DBMS_AW.EXECUTE('COMMIT');
  DBMS_AW.EXECUTE('AW DETACH GL_CUBE');

  DBMS_OUTPUT.PUT_LINE('GL_CUBE refresh complete: ' || TO_CHAR(SYSDATE, 'YYYY-MM-DD HH24:MI:SS'));
EXCEPTION
  WHEN OTHERS THEN
    DBMS_AW.EXECUTE('AW DETACH GL_CUBE');
    RAISE;
END REFRESH_GL_CUBE;
/
\`\`\`

---

## Phase 4: Schedule Cube Refresh as EBS Concurrent Request (Exalogic)

Register the cube refresh as a PL/SQL stored procedure concurrent program so it runs on the Exalogic concurrent processing tier and calls back to the Exadata database.

### 4.1 Register the Concurrent Program

In EBS System Administrator responsibility:

1. Navigate to **Concurrent > Program > Define**
2. Set Program Name: \`EBSOLAP_GL_CUBE_REFRESH\`
3. Set Short Name: \`EBSGLCUBE\`
4. Set Executable: PL/SQL Stored Procedure
5. Set Execution File Name: \`EBSOLAP.REFRESH_GL_CUBE\`
6. Set Output Type: Text
7. Save.

Add the program to the **System Administrator** request group so it can be submitted from the concurrent manager.

### 4.2 Schedule the Nightly Refresh

In System Administrator:

1. Navigate to **Concurrent > Manager > Schedule**
2. Submit request: \`EBSOLAP_GL_CUBE_REFRESH\`
3. Schedule: Repeat daily at 02:00 AM (after nightly journal posting completes)
4. Save.

Verify the request appears in the concurrent request queue:

\`\`\`sql
-- Query from EBS database (as APPS or a reporting user)
SELECT request_id,
       program_short_name,
       phase_code,
       status_code,
       TO_CHAR(requested_start_date, 'YYYY-MM-DD HH24:MI:SS') AS scheduled_time,
       TO_CHAR(actual_start_date, 'YYYY-MM-DD HH24:MI:SS')    AS actual_start,
       TO_CHAR(actual_completion_date, 'YYYY-MM-DD HH24:MI:SS') AS actual_end
FROM   fnd_concurrent_requests
WHERE  program_short_name = 'EBSGLCUBE'
ORDER  BY request_id DESC
FETCH  FIRST 10 ROWS ONLY;
\`\`\`

---

## Phase 5: Configure OBIEE/OAS Data Source Against Exadata RAC

Oracle Business Intelligence on Exalogic connects to Exadata via JDBC thin driver using a RAC SCAN (Single Client Access Name) connection string.

### 5.1 Configure the RPD Physical Layer Connection Pool

In the OBIEE Administration Tool (or OAS equivalent):

1. In the Physical layer, create a new database: type **Oracle 19c/21c**
2. Create a connection pool:
   - **Call Interface**: OCI 10g/11g (use JDBC Thin for pure-Java deployments)
   - **Data Source Name**: \`//exadata-scan.internal.company.com:1521/EBSPRD\`
   - **User**: \`EBSOLAP\`
   - **Password**: (vault-managed)
   - **Max Connections**: 50 (tune based on peak concurrent BI sessions)
   - **Connection Pool Timeout**: 300 seconds

3. In the connection pool **advanced** settings:
   - Enable **Enable connection binding for OLAP sessions**: Yes
   - Set **Session variable** \`NLS_DATE_FORMAT\` = \`YYYY-MM-DD\`

### 5.2 Verify OLAP Connectivity from OAS

On the Exalogic node running OAS, test the JDBC SCAN connection:

\`\`\`bash
# As oracle or middleware OS user on Exalogic
cd $MIDDLEWARE_HOME/oracle_common/bin

# Test JDBC thin connection to Exadata SCAN
java -cp $ORACLE_HOME/jdbc/lib/ojdbc8.jar \
  oracle.jdbc.driver.OracleDriver \
  "jdbc:oracle:thin:EBSOLAP/<password>@//exadata-scan.internal:1521/EBSPRD"
\`\`\`

If the connection fails, confirm:
- The Exadata SCAN listener is running: \`srvctl status scan_listener\`
- The Exalogic compute node can reach the SCAN VIP on port 1521 (InfiniBand routing or 10GbE management network)
- The EBSPRD service is registered with all RAC instances

### 5.3 Create the GL Cube Subject Area

In the OAS Data Model or RPD:

1. Import the \`GL_CUBE_SOURCE_V\` view from the EBSOLAP schema as a logical table source.
2. Define logical dimensions: Period (hierarchy: Year > Quarter > Period), Account (hierarchy: Company > Cost Center > Account > Product), Currency, Ledger.
3. Define logical measures: Net Amount, Debit Amount, Credit Amount, Beginning Balance — all with aggregation rule = SUM.
4. Deploy the RPD and verify a test analysis returns data.

---

## Phase 6: Deploy In-Database ML Models on Exadata

### 6.1 Create Model Settings Tables

\`\`\`sql
-- Connect as EBSOLAP on Exadata
-- Settings for AP Anomaly Detection (One-Class SVM)
CREATE TABLE AP_ANOMALY_SETTINGS (
  setting_name  VARCHAR2(30),
  setting_value VARCHAR2(4000)
);

INSERT INTO AP_ANOMALY_SETTINGS VALUES
  (DBMS_DATA_MINING.ALGO_NAME, DBMS_DATA_MINING.ALGO_SUPPORT_VECTOR_MACHINES);
INSERT INTO AP_ANOMALY_SETTINGS VALUES
  (DBMS_DATA_MINING.SVMS_OUTLIER_RATE, '0.05');
INSERT INTO AP_ANOMALY_SETTINGS VALUES
  (DBMS_DATA_MINING.PREP_AUTO, DBMS_DATA_MINING.PREP_AUTO_ON);
COMMIT;

-- Settings for AR Risk Scoring (Decision Tree)
CREATE TABLE AR_RISK_SETTINGS (
  setting_name  VARCHAR2(30),
  setting_value VARCHAR2(4000)
);

INSERT INTO AR_RISK_SETTINGS VALUES
  (DBMS_DATA_MINING.ALGO_NAME, DBMS_DATA_MINING.ALGO_DECISION_TREE);
INSERT INTO AR_RISK_SETTINGS VALUES
  (DBMS_DATA_MINING.PREP_AUTO, DBMS_DATA_MINING.PREP_AUTO_ON);
INSERT INTO AR_RISK_SETTINGS VALUES
  (DBMS_DATA_MINING.TREE_IMPURITY_METRIC, DBMS_DATA_MINING.TREE_IMPURITY_ENTROPY);
COMMIT;

-- Settings for Inventory Demand Forecast (GLM)
CREATE TABLE INV_FORECAST_SETTINGS (
  setting_name  VARCHAR2(30),
  setting_value VARCHAR2(4000)
);

INSERT INTO INV_FORECAST_SETTINGS VALUES
  (DBMS_DATA_MINING.ALGO_NAME, DBMS_DATA_MINING.ALGO_GENERALIZED_LINEAR_MODEL);
INSERT INTO INV_FORECAST_SETTINGS VALUES
  (DBMS_DATA_MINING.PREP_AUTO, DBMS_DATA_MINING.PREP_AUTO_ON);
INSERT INTO INV_FORECAST_SETTINGS VALUES
  (DBMS_DATA_MINING.GLMS_RIDGE_REGRESSION, DBMS_DATA_MINING.GLMS_RIDGE_REG_ENABLE);
COMMIT;
\`\`\`

### 6.2 Create Training Views

\`\`\`sql
-- AP Anomaly training view (last 2 years of paid invoices as "normal" baseline)
CREATE OR REPLACE VIEW AP_INVOICE_TRAINING_V AS
SELECT
  i.invoice_id,
  i.invoice_amount,
  i.vendor_id,
  i.pay_group_lookup_code        AS pay_group,
  i.invoice_type_lookup_code     AS invoice_type,
  i.org_id,
  NVL(i.discount_amount_taken, 0) AS discount_taken,
  TRUNC(i.invoice_date, 'MM')   AS invoice_month,
  EXTRACT(DOW FROM i.invoice_date) AS day_of_week,
  d.dist_count,
  d.avg_dist_amount
FROM apps.ap_invoices_all i
JOIN (
  SELECT invoice_id,
         COUNT(*)        AS dist_count,
         AVG(amount)     AS avg_dist_amount
  FROM   apps.ap_invoice_distributions_all
  GROUP  BY invoice_id
) d ON d.invoice_id = i.invoice_id
WHERE i.payment_status_flag = 'Y'
AND   i.invoice_date >= ADD_MONTHS(SYSDATE, -24);

-- AR Risk training view
CREATE OR REPLACE VIEW AR_RISK_TRAINING_V AS
SELECT
  s.customer_id,
  s.customer_trx_id,
  s.amount_due_original,
  s.amount_due_remaining,
  s.days_past_due,
  CASE WHEN s.days_past_due > 60 THEN 'HIGH'
       WHEN s.days_past_due > 30 THEN 'MEDIUM'
       ELSE 'LOW' END            AS risk_tier,
  s.payment_schedule_id,
  t.trx_type_id,
  NVL(dispute_count.cnt, 0)     AS dispute_count
FROM apps.ar_payment_schedules_all s
JOIN apps.ra_cust_trx_types_all t ON t.cust_trx_type_id = s.cust_trx_type_id
LEFT JOIN (
  SELECT customer_trx_id, COUNT(*) AS cnt
  FROM   apps.ar_adjustments_all
  WHERE  adjustment_type = 'D'
  GROUP  BY customer_trx_id
) dispute_count ON dispute_count.customer_trx_id = s.customer_trx_id
WHERE s.class = 'INV'
AND   s.invoice_currency_code = 'USD';

-- Inventory demand training view
CREATE OR REPLACE VIEW INV_DEMAND_TRAINING_V AS
SELECT
  t.inventory_item_id,
  t.organization_id,
  TRUNC(t.transaction_date, 'MM')           AS demand_month,
  SUM(ABS(t.primary_quantity))              AS demand_qty,
  AVG(ABS(t.primary_quantity))              AS avg_daily_demand,
  LAG(SUM(ABS(t.primary_quantity)), 1) OVER (
    PARTITION BY t.inventory_item_id, t.organization_id
    ORDER BY TRUNC(t.transaction_date, 'MM')
  )                                          AS prior_month_demand,
  LAG(SUM(ABS(t.primary_quantity)), 12) OVER (
    PARTITION BY t.inventory_item_id, t.organization_id
    ORDER BY TRUNC(t.transaction_date, 'MM')
  )                                          AS prior_year_demand
FROM apps.mtl_material_transactions t
WHERE t.transaction_type_id IN (32, 33, 261)  -- issue types
AND   t.transaction_date >= ADD_MONTHS(SYSDATE, -36)
GROUP BY t.inventory_item_id, t.organization_id,
         TRUNC(t.transaction_date, 'MM');
\`\`\`

### 6.3 Train the Models

\`\`\`sql
-- Train AP Anomaly model
BEGIN
  DBMS_DATA_MINING.CREATE_MODEL(
    model_name          => 'AP_ANOMALY_SVM',
    mining_function     => DBMS_DATA_MINING.ANOMALY_DETECTION,
    data_table_name     => 'AP_INVOICE_TRAINING_V',
    case_id_column_name => 'INVOICE_ID',
    target_column_name  => NULL,
    settings_table_name => 'AP_ANOMALY_SETTINGS'
  );
  DBMS_OUTPUT.PUT_LINE('AP_ANOMALY_SVM trained: ' || SYSDATE);
END;
/

-- Train AR Risk model
BEGIN
  DBMS_DATA_MINING.CREATE_MODEL(
    model_name          => 'AR_RISK_DT',
    mining_function     => DBMS_DATA_MINING.CLASSIFICATION,
    data_table_name     => 'AR_RISK_TRAINING_V',
    case_id_column_name => 'PAYMENT_SCHEDULE_ID',
    target_column_name  => 'RISK_TIER',
    settings_table_name => 'AR_RISK_SETTINGS'
  );
  DBMS_OUTPUT.PUT_LINE('AR_RISK_DT trained: ' || SYSDATE);
END;
/

-- Train Inventory Demand model
BEGIN
  DBMS_DATA_MINING.CREATE_MODEL(
    model_name          => 'INV_DEMAND_GLM',
    mining_function     => DBMS_DATA_MINING.REGRESSION,
    data_table_name     => 'INV_DEMAND_TRAINING_V',
    case_id_column_name => 'INVENTORY_ITEM_ID',
    target_column_name  => 'DEMAND_QTY',
    settings_table_name => 'INV_FORECAST_SETTINGS'
  );
  DBMS_OUTPUT.PUT_LINE('INV_DEMAND_GLM trained: ' || SYSDATE);
END;
/
\`\`\`

### 6.4 Verify Model Quality

\`\`\`sql
-- Check model attributes and accuracy metrics
SELECT model_name, mining_function, algorithm, build_duration,
       model_size, creation_date
FROM   user_mining_models
ORDER  BY creation_date DESC;

-- Confusion matrix for AR Risk model
DECLARE
  v_accuracy NUMBER;
BEGIN
  DBMS_DATA_MINING.COMPUTE_CONFUSION_MATRIX(
    accuracy            => v_accuracy,
    apply_result_table  => 'AR_RISK_TEST_RESULTS',
    target_table        => 'AR_RISK_TRAINING_V',
    case_id_column      => 'PAYMENT_SCHEDULE_ID',
    target_column       => 'RISK_TIER',
    score_column        => 'PREDICTION',
    score_criterion_column => 'PROBABILITY',
    cost_matrix_table   => NULL,
    apply_result_schema => NULL,
    target_schema       => NULL,
    cost_matrix_schema  => NULL,
    confusion_matrix_table => 'AR_RISK_CONFUSION'
  );
  DBMS_OUTPUT.PUT_LINE('AR Risk model accuracy: ' || ROUND(v_accuracy * 100, 2) || '%');
END;
/

SELECT * FROM AR_RISK_CONFUSION ORDER BY actual_target_value, predicted_target_value;
\`\`\`

---

## Phase 7: Create Scoring Views for Exalogic BI Layer

\`\`\`sql
-- AP invoice anomaly scoring view
CREATE OR REPLACE VIEW AP_INVOICE_ANOMALY_V AS
SELECT
  i.invoice_id,
  i.invoice_num,
  i.vendor_id,
  i.invoice_amount,
  i.invoice_date,
  i.invoice_type_lookup_code,
  PREDICTION(AP_ANOMALY_SVM USING
    i.invoice_amount,
    i.vendor_id,
    i.pay_group_lookup_code,
    i.invoice_type_lookup_code,
    i.org_id
  )                  AS anomaly_label,
  PREDICTION_PROBABILITY(AP_ANOMALY_SVM USING
    i.invoice_amount,
    i.vendor_id,
    i.pay_group_lookup_code,
    i.invoice_type_lookup_code,
    i.org_id
  )                  AS anomaly_probability
FROM apps.ap_invoices_all i
WHERE i.payment_status_flag = 'N'
AND   i.invoice_date >= TRUNC(SYSDATE) - 90;

-- AR customer risk scoring view
CREATE OR REPLACE VIEW AR_CUSTOMER_RISK_V AS
SELECT
  s.customer_id,
  s.payment_schedule_id,
  s.amount_due_remaining,
  s.days_past_due,
  PREDICTION(AR_RISK_DT USING
    s.amount_due_original,
    s.amount_due_remaining,
    s.days_past_due
  )                  AS predicted_risk_tier,
  PREDICTION_PROBABILITY(AR_RISK_DT USING
    s.amount_due_original,
    s.amount_due_remaining,
    s.days_past_due
  )                  AS risk_probability
FROM apps.ar_payment_schedules_all s
WHERE s.class = 'INV'
AND   s.status = 'OP';

-- Inventory demand forecast view
CREATE OR REPLACE VIEW INV_DEMAND_FORECAST_V AS
SELECT
  inventory_item_id,
  organization_id,
  demand_month,
  demand_qty                                     AS actual_demand,
  PREDICTION(INV_DEMAND_GLM USING
    inventory_item_id,
    organization_id,
    prior_month_demand,
    prior_year_demand,
    avg_daily_demand
  )                                              AS forecast_demand,
  ABS(demand_qty - PREDICTION(INV_DEMAND_GLM USING
    inventory_item_id,
    organization_id,
    prior_month_demand,
    prior_year_demand,
    avg_daily_demand
  )) / NULLIF(demand_qty, 0)                    AS mape_contribution
FROM inv_demand_training_v;
\`\`\`

Grant scoring view access to BI reporting users:

\`\`\`sql
GRANT SELECT ON EBSOLAP.AP_INVOICE_ANOMALY_V   TO OBIEE_REPORT_USER;
GRANT SELECT ON EBSOLAP.AR_CUSTOMER_RISK_V      TO OBIEE_REPORT_USER;
GRANT SELECT ON EBSOLAP.INV_DEMAND_FORECAST_V   TO OBIEE_REPORT_USER;
\`\`\`

---

## Phase 8: Schedule Model Retraining

Models must be retrained periodically to remain accurate as EBS transactional patterns evolve.

\`\`\`sql
-- Retrain procedure (replace existing model)
CREATE OR REPLACE PROCEDURE EBSOLAP.RETRAIN_ML_MODELS AS
BEGIN
  -- Drop and recreate AP Anomaly model
  BEGIN
    DBMS_DATA_MINING.DROP_MODEL('AP_ANOMALY_SVM');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  DBMS_DATA_MINING.CREATE_MODEL(
    model_name          => 'AP_ANOMALY_SVM',
    mining_function     => DBMS_DATA_MINING.ANOMALY_DETECTION,
    data_table_name     => 'AP_INVOICE_TRAINING_V',
    case_id_column_name => 'INVOICE_ID',
    target_column_name  => NULL,
    settings_table_name => 'AP_ANOMALY_SETTINGS'
  );

  -- Drop and recreate AR Risk model
  BEGIN
    DBMS_DATA_MINING.DROP_MODEL('AR_RISK_DT');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  DBMS_DATA_MINING.CREATE_MODEL(
    model_name          => 'AR_RISK_DT',
    mining_function     => DBMS_DATA_MINING.CLASSIFICATION,
    data_table_name     => 'AR_RISK_TRAINING_V',
    case_id_column_name => 'PAYMENT_SCHEDULE_ID',
    target_column_name  => 'RISK_TIER',
    settings_table_name => 'AR_RISK_SETTINGS'
  );

  -- Drop and recreate Inventory Forecast model
  BEGIN
    DBMS_DATA_MINING.DROP_MODEL('INV_DEMAND_GLM');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  DBMS_DATA_MINING.CREATE_MODEL(
    model_name          => 'INV_DEMAND_GLM',
    mining_function     => DBMS_DATA_MINING.REGRESSION,
    data_table_name     => 'INV_DEMAND_TRAINING_V',
    case_id_column_name => 'INVENTORY_ITEM_ID',
    target_column_name  => 'DEMAND_QTY',
    settings_table_name => 'INV_FORECAST_SETTINGS'
  );

  DBMS_OUTPUT.PUT_LINE('All ML models retrained: ' || TO_CHAR(SYSDATE, 'YYYY-MM-DD HH24:MI:SS'));
END RETRAIN_ML_MODELS;
/

-- Schedule monthly retraining via DBMS_SCHEDULER on Exadata
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'EBSOLAP_ML_RETRAIN_MONTHLY',
    job_type        => 'STORED_PROCEDURE',
    job_action      => 'EBSOLAP.RETRAIN_ML_MODELS',
    start_date      => SYSTIMESTAMP,
    repeat_interval => 'FREQ=MONTHLY; BYMONTHDAY=1; BYHOUR=3; BYMINUTE=0',
    enabled         => TRUE,
    comments        => 'Monthly ML model retraining from EBS base tables'
  );
END;
/
\`\`\`

---

## Phase 9: Validation and Sign-Off Checklist

### OLAP Validation

\`\`\`sql
-- Confirm GL cube has data
DECLARE
  v_count NUMBER;
BEGIN
  DBMS_AW.EXECUTE('AW ATTACH GL_CUBE RO');
  DBMS_AW.EXECUTE('REPORT GL_NET_AMOUNT');
  DBMS_AW.EXECUTE('AW DETACH GL_CUBE');
  DBMS_OUTPUT.PUT_LINE('GL_CUBE contains data');
END;
/

-- Reconcile cube sum to GL_BALANCES relational total
SELECT 'CUBE_TOTAL', SUM(net_amount) FROM gl_cube_source_v;

-- Compare to a direct GL_BALANCES query for same scope
SELECT 'GL_BALANCES_TOTAL',
       SUM(period_net_dr - period_net_cr)
FROM apps.gl_balances
WHERE actual_flag = 'A'
AND translated_flag IS NULL;
\`\`\`

The two totals must match within rounding tolerance (< 0.01 USD equivalent).

### ML Validation

\`\`\`sql
-- Confirm all three models exist
SELECT model_name, mining_function, algorithm, creation_date
FROM   user_mining_models
WHERE  model_name IN ('AP_ANOMALY_SVM', 'AR_RISK_DT', 'INV_DEMAND_GLM');

-- Confirm scoring views return rows
SELECT COUNT(*) AS anomaly_rows   FROM ebsolap.ap_invoice_anomaly_v;
SELECT COUNT(*) AS risk_rows      FROM ebsolap.ar_customer_risk_v;
SELECT COUNT(*) AS forecast_rows  FROM ebsolap.inv_demand_forecast_v;

-- Confirm prediction values are populated (not null)
SELECT COUNT(*) AS null_predictions
FROM ebsolap.ap_invoice_anomaly_v
WHERE anomaly_label IS NULL;
\`\`\`

### OAS Connectivity Validation

From the Exalogic OAS node:

\`\`\`bash
# Test SCAN listener reachability
tnsping EBSPRD

# Confirm OAS can execute an OLAP query
# Submit a test analysis in OAS that hits GL_CUBE_SOURCE_V and confirm row count
\`\`\`

### Sign-Off Matrix

| Component | Validation | Owner | Pass? |
|-----------|-----------|-------|-------|
| GL_CUBE exists on Exadata | AW ATTACH / REPORT | DBA | |
| Cube total reconciles to GL_BALANCES | SQL comparison | DBA + Finance | |
| Nightly refresh concurrent request schedules | FND_CONCURRENT_REQUESTS query | DBA + EBS Admin | |
| OAS connects to Exadata SCAN | tnsping + test analysis | BI Admin | |
| AP Anomaly model trained and scoring | user_mining_models + anomaly view | DBA | |
| AR Risk model accuracy > 75% | confusion matrix | DBA + AR Manager | |
| INV Demand MAPE < 20% | mape_contribution from forecast view | DBA + Supply Chain | |
| Monthly retraining job enabled | DBMS_SCHEDULER job status | DBA | |
| Scoring views granted to BI user | SELECT privilege check | DBA | |

---

## Summary

This runbook establishes the full analytical stack on an Exalogic + Exadata deployment:

- **Exadata hosts**: GL Analytic Workspace (OLAP cube), three in-database ML models, all training and scoring views, the OLAP_DATA/OLAP_INDEX/OLAP_TEMP tablespaces, and the EBSOLAP schema.
- **Exalogic hosts**: the EBS concurrent request that triggers nightly cube refresh, the OAS/OBIEE BI Server with its connection pool to Exadata's SCAN listener, and the web dashboards that surface OLAP aggregations and ML predictions to EBS users.
- **InfiniBand** moves cube result sets and ML scoring results from Exadata to Exalogic with sub-millisecond overhead per result row.

Retraining runs monthly via DBMS_SCHEDULER on Exadata; cube refresh runs nightly via EBS concurrent manager on Exalogic. Both are fully automated after initial setup.`,
};

async function main() {
  console.log('Inserting Exalogic ML/OLAP/MOLAP runbook...');
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
