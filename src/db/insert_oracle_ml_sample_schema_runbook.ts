import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Installing the OML Sample Schema and Machine Learning Exercises',
  slug: 'oracle-machine-learning-sample-schema-runbook',
  excerpt:
    'Step-by-step runbook for installing the Oracle Machine Learning sample schema (SH and OML sample data) on Oracle Database 19c, configuring the OML user, and running hands-on exercises in classification, regression, clustering, and AutoML using OML4SQL and OML4Py.',
  category: 'oracle-ml' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-11'),
  youtubeUrl: null,
  content: `## Prerequisites

- Oracle Database 19c or 21c (Enterprise Edition recommended; Standard Edition 2 supports most OML algorithms)
- Oracle Machine Learning feature licensed (included in EE; check your license for SE2)
- DBA access to the target database
- Oracle Database software home with the SH (Sales History) sample schema installer, or access to Oracle Database Examples media
- \`sqlplus\` available on the database server
- Optional: Python 3.8+ and OML4Py client for Python exercises

---

## Phase 1: Verify OML Is Available

### 1.1 Check OML Component Status

\`\`\`sql
-- Connect as SYSDBA
sqlplus / as sysdba

-- Verify Data Mining component is installed
SELECT comp_name, version, status
FROM   dba_registry
WHERE  comp_id = 'ODM';

-- Expected: COMP_NAME = 'Oracle Data Mining', STATUS = 'VALID'
\`\`\`

If the component is missing, it needs to be installed via \`$ORACLE_HOME/rdbms/admin/odmrpmt.sql\`.

### 1.2 Verify Database Edition

\`\`\`sql
SELECT name, value
FROM   v\$parameter
WHERE  name = 'enable_goldengate_replication';

-- Also check edition directly
SELECT banner FROM v\$version WHERE banner LIKE '%Enterprise%';
\`\`\`

---

## Phase 2: Install the SH Sample Schema

The Sales History (SH) schema is Oracle's standard sample dataset — it contains customer, product, sales, and time dimension tables well-suited for ML exercises.

### 2.1 Locate the Sample Schema Scripts

Oracle Database Examples media (or the DBCA-installed samples) typically places scripts at:

\`\`\`bash
\$ORACLE_HOME/demo/schema/sales_history/
\`\`\`

Or download from Oracle's GitHub: oracle/db-sample-schemas

### 2.2 Create the SH Schema (if not already present)

\`\`\`sql
-- Check if SH already exists
SELECT username FROM dba_users WHERE username = 'SH';

-- If not present, install from the schema scripts
-- (Run as SYSDBA from the sales_history directory)
@sh_main.sql sh <sh_password> <system_password> <sh_tablespace> <temp_tablespace> <log_directory>
\`\`\`

Example:
\`\`\`
@sh_main.sql sh Welcome1 system users temp /tmp
\`\`\`

### 2.3 Verify SH Schema Objects

\`\`\`sql
CONNECT sh/<sh_password>@DBNAME

SELECT table_name, num_rows
FROM   user_tables
ORDER BY table_name;
\`\`\`

Expected tables (approximate row counts):

| Table | Rows |
|-------|------|
| CUSTOMERS | 55,500 |
| PRODUCTS | 72 |
| SALES | 918,843 |
| TIMES | 1,826 |
| CHANNELS | 5 |
| COUNTRIES | 23 |
| PROMOTIONS | 503 |

---

## Phase 3: Create the OML User

### 3.1 Create a Dedicated OML User

\`\`\`sql
-- Connect as SYSDBA
sqlplus / as sysdba

CREATE USER oml_user IDENTIFIED BY "Welcome1#OML"
    DEFAULT TABLESPACE users
    QUOTA UNLIMITED ON users;

-- Grant minimum privileges for OML
GRANT CREATE SESSION            TO oml_user;
GRANT CREATE TABLE              TO oml_user;
GRANT CREATE VIEW               TO oml_user;
GRANT CREATE MINING MODEL       TO oml_user;
GRANT CREATE PROCEDURE          TO oml_user;
GRANT CREATE SEQUENCE           TO oml_user;
GRANT EXECUTE ON DBMS_DATA_MINING TO oml_user;

-- Grant access to the SH sample data
GRANT SELECT ON sh.customers    TO oml_user;
GRANT SELECT ON sh.sales        TO oml_user;
GRANT SELECT ON sh.products     TO oml_user;
GRANT SELECT ON sh.times        TO oml_user;
GRANT SELECT ON sh.channels     TO oml_user;
GRANT SELECT ON sh.countries    TO oml_user;
GRANT SELECT ON sh.promotions   TO oml_user;
\`\`\`

### 3.2 Create Synonyms (Optional — Simplifies Queries)

\`\`\`sql
CONNECT oml_user/Welcome1#OML@DBNAME

CREATE OR REPLACE SYNONYM customers FOR sh.customers;
CREATE OR REPLACE SYNONYM sales     FOR sh.sales;
CREATE OR REPLACE SYNONYM products  FOR sh.products;
CREATE OR REPLACE SYNONYM times     FOR sh.times;
CREATE OR REPLACE SYNONYM channels  FOR sh.channels;
CREATE OR REPLACE SYNONYM countries FOR sh.countries;
CREATE OR REPLACE SYNONYM promotions FOR sh.promotions;
\`\`\`

---

## Phase 4: Prepare Training Datasets

### 4.1 Create a Customer Churn Training View

We will simulate a churn prediction use case. A customer is flagged as "churned" if they have had no purchases in the last 3 years.

\`\`\`sql
CONNECT oml_user/Welcome1#OML@DBNAME

CREATE OR REPLACE VIEW v_customer_churn AS
SELECT
    c.cust_id,
    c.cust_gender,
    c.cust_year_of_birth,
    c.cust_marital_status,
    c.cust_income_level,
    c.cust_credit_limit,
    c.cust_city,
    cnt.country_name,
    SUM(s.amount_sold)    AS total_spend,
    COUNT(DISTINCT s.prod_id) AS distinct_products,
    COUNT(s.quantity_sold) AS total_orders,
    MAX(t.time_id)        AS last_purchase_date,
    CASE
        WHEN MAX(t.time_id) < DATE '2000-01-01' THEN 1
        ELSE 0
    END                   AS churned
FROM       sh.customers c
JOIN       sh.countries  cnt ON c.country_id    = cnt.country_id
LEFT JOIN  sh.sales      s   ON c.cust_id       = s.cust_id
LEFT JOIN  sh.times      t   ON s.time_id       = t.time_id
GROUP BY
    c.cust_id, c.cust_gender, c.cust_year_of_birth, c.cust_marital_status,
    c.cust_income_level, c.cust_credit_limit, c.cust_city, cnt.country_name;

-- Verify
SELECT COUNT(*), SUM(churned) AS churned_count FROM v_customer_churn;
\`\`\`

### 4.2 Create a Sales Revenue Regression Dataset

\`\`\`sql
CREATE OR REPLACE VIEW v_product_sales_regression AS
SELECT
    p.prod_id,
    p.prod_name,
    p.prod_category,
    p.prod_subcategory,
    p.prod_list_price,
    p.prod_min_price,
    pr.promo_cost,
    pr.promo_category,
    ch.channel_desc,
    SUM(s.amount_sold)   AS total_revenue,
    SUM(s.quantity_sold) AS total_units,
    COUNT(DISTINCT s.cust_id) AS unique_buyers
FROM   sh.products   p
JOIN   sh.sales      s  ON p.prod_id    = s.prod_id
JOIN   sh.promotions pr ON s.promo_id   = pr.promo_id
JOIN   sh.channels   ch ON s.channel_id = ch.channel_id
GROUP BY
    p.prod_id, p.prod_name, p.prod_category, p.prod_subcategory,
    p.prod_list_price, p.prod_min_price,
    pr.promo_cost, pr.promo_category, ch.channel_desc;
\`\`\`

---

## Phase 5: Exercise 1 — Classification (Churn Prediction)

### 5.1 Create Model Settings

\`\`\`sql
CONNECT oml_user/Welcome1#OML@DBNAME

-- Drop if re-running
DROP TABLE IF EXISTS churn_rf_settings;

CREATE TABLE churn_rf_settings (
    setting_name  VARCHAR2(30),
    setting_value VARCHAR2(4000)
);

INSERT INTO churn_rf_settings VALUES
    (DBMS_DATA_MINING.ALGO_NAME,    DBMS_DATA_MINING.ALGO_RANDOM_FOREST);
INSERT INTO churn_rf_settings VALUES
    (DBMS_DATA_MINING.PREP_AUTO,    DBMS_DATA_MINING.PREP_AUTO_ON);
-- Number of trees
INSERT INTO churn_rf_settings VALUES ('RFOR_NUM_TREES', '100');
-- Maximum depth
INSERT INTO churn_rf_settings VALUES ('RFOR_MAX_DEPTH', '10');

COMMIT;
\`\`\`

### 5.2 Train the Model

\`\`\`sql
BEGIN
    -- Drop model if it exists from a previous run
    BEGIN
        DBMS_DATA_MINING.DROP_MODEL('CHURN_RF_MODEL');
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    DBMS_DATA_MINING.CREATE_MODEL(
        model_name          => 'CHURN_RF_MODEL',
        mining_function     => DBMS_DATA_MINING.CLASSIFICATION,
        data_table_name     => 'V_CUSTOMER_CHURN',
        case_id_column_name => 'CUST_ID',
        target_column_name  => 'CHURNED',
        settings_table_name => 'CHURN_RF_SETTINGS'
    );
END;
/

-- Verify model was created
SELECT model_name, algorithm, build_duration, model_size
FROM   user_mining_models
WHERE  model_name = 'CHURN_RF_MODEL';
\`\`\`

### 5.3 Evaluate Model Accuracy

\`\`\`sql
-- Apply model to all customers and compare predictions to actuals
SELECT
    SUM(CASE WHEN predicted_churn = churned THEN 1 ELSE 0 END) AS correct,
    COUNT(*)                                                    AS total,
    ROUND(SUM(CASE WHEN predicted_churn = churned THEN 1 ELSE 0 END)
          / COUNT(*) * 100, 2)                                  AS accuracy_pct
FROM (
    SELECT
        cust_id,
        churned,
        PREDICTION(churn_rf_model USING *) AS predicted_churn
    FROM v_customer_churn
);
\`\`\`

### 5.4 Score New Customers with Probability

\`\`\`sql
-- Top 20 customers most likely to churn
SELECT
    cust_id,
    cust_income_level,
    total_spend,
    PREDICTION(churn_rf_model USING *)                      AS predicted_churn,
    ROUND(PREDICTION_PROBABILITY(churn_rf_model, 1 USING *) * 100, 1) AS churn_pct
FROM v_customer_churn
WHERE churned = 0   -- currently active customers only
ORDER BY churn_pct DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

### 5.5 Inspect Feature Importance

\`\`\`sql
SELECT attribute_name,
       ROUND(attribute_importance_value, 4) AS importance
FROM   user_mining_model_attributes
WHERE  model_name = 'CHURN_RF_MODEL'
ORDER BY attribute_importance_value DESC;
\`\`\`

---

## Phase 6: Exercise 2 — Regression (Revenue Prediction)

### 6.1 Build a Gradient Boosting Regressor

\`\`\`sql
DROP TABLE IF EXISTS revenue_gb_settings;
CREATE TABLE revenue_gb_settings (
    setting_name  VARCHAR2(30),
    setting_value VARCHAR2(4000)
);

INSERT INTO revenue_gb_settings VALUES
    (DBMS_DATA_MINING.ALGO_NAME, DBMS_DATA_MINING.ALGO_GRADIENT_BOOSTING);
INSERT INTO revenue_gb_settings VALUES
    (DBMS_DATA_MINING.PREP_AUTO, DBMS_DATA_MINING.PREP_AUTO_ON);
-- Number of boosting rounds
INSERT INTO revenue_gb_settings VALUES ('GBMT_N_ITER', '200');
-- Learning rate
INSERT INTO revenue_gb_settings VALUES ('GBMT_LEARNING_RATE', '0.1');

COMMIT;

BEGIN
    BEGIN DBMS_DATA_MINING.DROP_MODEL('REVENUE_GB_MODEL'); EXCEPTION WHEN OTHERS THEN NULL; END;

    DBMS_DATA_MINING.CREATE_MODEL(
        model_name          => 'REVENUE_GB_MODEL',
        mining_function     => DBMS_DATA_MINING.REGRESSION,
        data_table_name     => 'V_PRODUCT_SALES_REGRESSION',
        case_id_column_name => 'PROD_ID',
        target_column_name  => 'TOTAL_REVENUE',
        settings_table_name => 'REVENUE_GB_SETTINGS'
    );
END;
/
\`\`\`

### 6.2 Evaluate Regression Accuracy

\`\`\`sql
SELECT
    ROUND(AVG(ABS(predicted_revenue - total_revenue)), 2) AS mean_abs_error,
    ROUND(SQRT(AVG(POWER(predicted_revenue - total_revenue, 2))), 2) AS rmse,
    ROUND(CORR(predicted_revenue, total_revenue), 4) AS r_squared_approx
FROM (
    SELECT
        prod_id,
        total_revenue,
        PREDICTION(revenue_gb_model USING *) AS predicted_revenue
    FROM v_product_sales_regression
);
\`\`\`

---

## Phase 7: Exercise 3 — Clustering (Customer Segmentation)

### 7.1 Build a k-Means Clustering Model

\`\`\`sql
DROP TABLE IF EXISTS cust_kmeans_settings;
CREATE TABLE cust_kmeans_settings (
    setting_name  VARCHAR2(30),
    setting_value VARCHAR2(4000)
);

INSERT INTO cust_kmeans_settings VALUES
    (DBMS_DATA_MINING.ALGO_NAME,        DBMS_DATA_MINING.ALGO_KMEANS);
INSERT INTO cust_kmeans_settings VALUES
    (DBMS_DATA_MINING.PREP_AUTO,        DBMS_DATA_MINING.PREP_AUTO_ON);
-- Number of clusters
INSERT INTO cust_kmeans_settings VALUES ('KMNS_CLUSTERS', '5');
INSERT INTO cust_kmeans_settings VALUES ('KMNS_ITERATIONS', '20');
INSERT INTO cust_kmeans_settings VALUES ('KMNS_CONV_TOL', '0.001');

COMMIT;

BEGIN
    BEGIN DBMS_DATA_MINING.DROP_MODEL('CUST_SEGMENT_MODEL'); EXCEPTION WHEN OTHERS THEN NULL; END;

    DBMS_DATA_MINING.CREATE_MODEL(
        model_name          => 'CUST_SEGMENT_MODEL',
        mining_function     => DBMS_DATA_MINING.CLUSTERING,
        data_table_name     => 'V_CUSTOMER_CHURN',
        case_id_column_name => 'CUST_ID',
        settings_table_name => 'CUST_KMEANS_SETTINGS'
    );
END;
/
\`\`\`

### 7.2 Assign Customers to Clusters

\`\`\`sql
-- Which cluster does each customer belong to?
SELECT
    cust_id,
    cust_income_level,
    total_spend,
    CLUSTER_ID(cust_segment_model USING *)          AS cluster_id,
    ROUND(CLUSTER_PROBABILITY(cust_segment_model USING *), 3) AS cluster_prob
FROM v_customer_churn
ORDER BY cluster_id, cluster_prob DESC;
\`\`\`

### 7.3 Profile Each Cluster

\`\`\`sql
SELECT
    cluster_id,
    COUNT(*) AS customer_count,
    ROUND(AVG(total_spend), 2) AS avg_spend,
    ROUND(AVG(total_orders), 1) AS avg_orders,
    ROUND(AVG(cust_credit_limit), 0) AS avg_credit_limit,
    ROUND(AVG(churned), 3) AS churn_rate
FROM (
    SELECT
        cust_id, total_spend, total_orders, cust_credit_limit, churned,
        CLUSTER_ID(cust_segment_model USING *) AS cluster_id
    FROM v_customer_churn
)
GROUP BY cluster_id
ORDER BY cluster_id;
\`\`\`

---

## Phase 8: Exercise 4 — AutoML

### 8.1 Run AutoML for Classification

\`\`\`sql
DECLARE
    v_set DBMS_DATA_MINING.SETTING_LIST;
BEGIN
    v_set(DBMS_DATA_MINING.ALGO_NAME)  := DBMS_DATA_MINING.ALGO_AUTO_MODEL;
    v_set(DBMS_DATA_MINING.PREP_AUTO) := DBMS_DATA_MINING.PREP_AUTO_ON;
    -- List of algorithms to evaluate
    v_set('AUTOML_ALGORITHM_LIST') :=
        'RANDOM_FOREST,GRADIENT_BOOSTING,DECISION_TREE,NAIVE_BAYES';

    BEGIN
        DBMS_DATA_MINING.DROP_MODEL('AUTOML_CHURN_MODEL');
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    DBMS_DATA_MINING.CREATE_MODEL2(
        model_name          => 'AUTOML_CHURN_MODEL',
        mining_function     => 'CLASSIFICATION',
        data_query          => 'SELECT * FROM v_customer_churn',
        set_list            => v_set,
        case_id_column_name => 'CUST_ID',
        target_column_name  => 'CHURNED'
    );
END;
/
\`\`\`

### 8.2 Compare AutoML vs Manual Model

\`\`\`sql
-- Compare accuracy of the AutoML model vs. the manually configured RF
SELECT 'AUTOML_CHURN_MODEL' AS model_name,
    ROUND(SUM(CASE WHEN PREDICTION(automl_churn_model USING *) = churned THEN 1 ELSE 0 END)
          / COUNT(*) * 100, 2) AS accuracy_pct
FROM v_customer_churn
UNION ALL
SELECT 'CHURN_RF_MODEL',
    ROUND(SUM(CASE WHEN PREDICTION(churn_rf_model USING *) = churned THEN 1 ELSE 0 END)
          / COUNT(*) * 100, 2)
FROM v_customer_churn;
\`\`\`

---

## Phase 9: OML4Py Installation and Python Exercises

### 9.1 Install OML4Py Client

\`\`\`bash
# Python 3.8 or 3.9 required (check OML4Py release notes for your DB version)
python3 --version

# Install OML4Py from the Oracle Database client installation
# (bundled in $ORACLE_HOME/oml4py/)
cd \$ORACLE_HOME/oml4py/client
pip install oml4py-<version>.zip

# Or install the OML4Py wheel from My Oracle Support
pip install oracledb oml4py
\`\`\`

### 9.2 Verify OML4Py Connection

\`\`\`python
import oml

# Connect to the database
oml.connect(
    user='oml_user',
    password='Welcome1#OML',
    dsn='<db_host>:1521/<service_name>'
)

print("OML4Py connected:", oml.isconnected())

# List tables visible to the OML user
print(oml.dir(type='TABLE'))
\`\`\`

### 9.3 Python Classification Exercise

\`\`\`python
import oml
from oml.algo import RandomForestClassifier

oml.connect(user='oml_user', password='Welcome1#OML',
            dsn='<db_host>:1521/<service_name>')

# Load the training view as an OML DataFrame (data stays in the database)
churn_data = oml.sync(query="SELECT * FROM v_customer_churn",
                       oml_user='oml_user')

# Train/test split using CUST_ID hash (reproducible)
train, test = churn_data.split(ratio=(0.8, 0.2), use_hash=True,
                                hash_cols=['CUST_ID'])

print(f"Training rows: {len(train)}, Test rows: {len(test)}")

# Build Random Forest classifier in the database
rf_py = RandomForestClassifier(
    mining_function='classification',
    target='CHURNED',
    case_id='CUST_ID',
    auto_data_prep=True,
    n_estimators=100,
    max_depth=10
)

rf_py.fit(train)
print("Model built. Algorithm:", rf_py.algorithm)

# Score the test set
predictions = rf_py.predict(test,
                             supplemental_cols=['CUST_ID', 'CHURNED'])

# Accuracy
correct = predictions[predictions['PREDICTION'] == predictions['CHURNED']]
accuracy = len(correct) / len(predictions)
print(f"Test accuracy: {accuracy:.2%}")
\`\`\`

### 9.4 Python AutoML Exercise

\`\`\`python
import oml
from oml.automl import AutoML

oml.connect(user='oml_user', password='Welcome1#OML',
            dsn='<db_host>:1521/<service_name>')

churn_data = oml.sync(query="SELECT * FROM v_customer_churn",
                       oml_user='oml_user')
train, test = churn_data.split(ratio=(0.8, 0.2), use_hash=True,
                                hash_cols=['CUST_ID'])

# AutoML — automatically selects best algorithm
auto = AutoML(
    mining_function='classification',
    target='CHURNED',
    case_id='CUST_ID'
)
auto.fit(train, algorithms=['RandomForest', 'GradientBoosting',
                              'DecisionTree', 'NaiveBayes'])

print("Best algorithm:", auto.best_algorithm_name)
print("Best model accuracy:", auto.best_score)

# Score with best model
preds = auto.predict(test, supplemental_cols=['CUST_ID', 'CHURNED'])
print(preds.head(10))
\`\`\`

---

## Phase 10: Cleanup

\`\`\`sql
CONNECT oml_user/Welcome1#OML@DBNAME

-- Drop all models created during exercises
BEGIN
    FOR m IN (SELECT model_name FROM user_mining_models) LOOP
        DBMS_DATA_MINING.DROP_MODEL(m.model_name);
    END LOOP;
END;
/

-- Drop training tables and views
DROP VIEW v_customer_churn;
DROP VIEW v_product_sales_regression;
DROP TABLE churn_rf_settings;
DROP TABLE revenue_gb_settings;
DROP TABLE cust_kmeans_settings;

-- Verify models removed
SELECT COUNT(*) FROM user_mining_models;
-- Expected: 0
\`\`\`

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| \`ORA-40283: must have CREATE MINING MODEL privilege\` | OML privilege not granted | Grant \`CREATE MINING MODEL\` to the OML user (Phase 3.1) |
| \`ORA-00942: table or view does not exist\` during \`CREATE_MODEL\` | Training table/view not visible | Verify synonyms or use fully qualified name (\`SH.CUSTOMERS\`) |
| \`ORA-40210: invalid setting value\` | Wrong setting constant name | Check \`DBMS_DATA_MINING\` package constants for your DB version |
| Model creates but has low accuracy | Imbalanced target classes | Add \`CLAS_COST_MATRIX_TABLE\` or \`CLAS_WEIGHTS_TABLE\` settings |
| OML4Py connection fails | \`oracledb\` not installed or \`DSN\` incorrect | \`pip install oracledb\` and verify TNS or EZConnect string |
| \`PREP_AUTO_ON\` warning about skipped columns | Null-heavy or low-variance columns excluded automatically | Normal behaviour — check \`user_mining_model_attributes\` |`,
};

async function main() {
  console.log('Inserting Oracle Machine Learning sample schema runbook...');
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
