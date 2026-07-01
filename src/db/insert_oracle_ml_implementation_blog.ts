import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Implementing Oracle Machine Learning: From Schema Setup to In-Database Algorithm Execution',
  slug: 'oracle-machine-learning-implementation',
  excerpt:
    'A hands-on implementation guide for Oracle Machine Learning (OML4SQL) covering schema setup, the DBMS_DATA_MINING API, and complete worked examples for classification with Decision Tree, clustering with K-Means, and anomaly detection with One-Class SVM — all running inside the Oracle Database engine without moving data to external tools.',
  category: 'oracle-ml' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-01'),
  youtubeUrl: null,
  content: `Oracle Machine Learning is Oracle's in-database machine learning platform, allowing data scientists and DBAs to build, train, and deploy predictive models directly within the Oracle Database engine — without moving data to external tools. This post covers the OML architecture, the official Oracle GitHub repository of examples, installing the prerequisite schemas, and running supervised and unsupervised learning algorithms using \`DBMS_DATA_MINING\` and OML4SQL.

The key insight that differentiates OML from external ML frameworks: the model training and scoring happen where the data lives. A table with 100 million rows can be trained against without a single byte leaving the database, eliminating the ETL overhead and data governance risks associated with exporting data to Python or R environments for modeling.

---

## The Oracle ML Ecosystem

Oracle Machine Learning has four delivery mechanisms:

1. **OML4SQL** — SQL and PL/SQL APIs for machine learning via \`DBMS_DATA_MINING\`. This is the oldest and most mature component, available since Oracle 9i Data Mining. It runs entirely inside the Oracle kernel.

2. **OML4Py** — Python interface that translates Python/scikit-learn-style code into Oracle SQL and runs the computation inside the database. Requires the OML4Py client install and a connection to Oracle Database 21c or above (or Oracle Autonomous Database).

3. **OML4R** — R interface for Oracle ML, similar to OML4Py but using the R language. Requires Oracle R Enterprise (ORE).

4. **OML AutoML UI** — A web-based interface (available on Oracle Autonomous Database and Oracle Database 21c with APEX) that automates algorithm selection, feature engineering, and hyperparameter tuning.

This post focuses on **OML4SQL** — the most broadly applicable path because it requires only a licensed Oracle Database 12c or above (Enterprise Edition with the Advanced Analytics option, or any Autonomous Database tier).

---

## The Oracle GitHub Repository

Oracle maintains an official GitHub repository of machine learning examples at:

https://github.com/oracle/oracle-db-examples/tree/master/machine-learning

This repo contains subdirectories organized by technology:
- \`oml4sql/\` — SQL and PL/SQL scripts demonstrating DBMS_DATA_MINING workflows for classification, regression, clustering, feature extraction, and anomaly detection
- \`oml4py/\` — Jupyter notebooks and Python scripts for OML4Py
- \`oml4r/\` — R scripts for Oracle R Enterprise
- \`oml-services/\` — REST API examples for OML Services (model deployment endpoints)

The \`oml4sql/\` directory is the most useful starting point for DBAs. It includes complete workflows organized by use case:
- \`oml4sql-classification-decision-tree.sql\`
- \`oml4sql-classification-random-forest.sql\`
- \`oml4sql-regression-neural-network.sql\`
- \`oml4sql-clustering-kmeans.sql\`
- \`oml4sql-anomaly-detection-svm.sql\`
- \`oml4sql-feature-extraction-nmf.sql\`

These scripts follow a consistent structure: create settings table → create model → view model details → apply model to test data → evaluate. Understanding this pattern is the key to writing custom OML4SQL workflows.

---

## Prerequisites and License Check

OML4SQL requires Oracle Advanced Analytics (OAA), which is a separately licensed option for Enterprise Edition. Verify it is enabled:

\`\`\`sql
SELECT value FROM v\$option WHERE parameter = 'Data Mining';
-- Expected: VALUE = TRUE
-- If FALSE: Advanced Analytics option is not installed or not licensed
\`\`\`

Also confirm the database version:

\`\`\`sql
SELECT banner FROM v\$version WHERE banner LIKE 'Oracle%';
-- OML4SQL is fully supported on 12.2, 18c, 19c, 21c, and 23ai
\`\`\`

On Oracle Autonomous Database (ADB-S or ADB-D), the Advanced Analytics option is included by default and no license check is needed. The \`DBMS_DATA_MINING\` package is available to all ADB users without additional grants.

---

## Installing the Demo Schemas

Oracle ships two demo schemas most relevant to machine learning:

**SH (Sales History) schema** — the standard OML demo data source. Contains the \`CUSTOMERS\`, \`SALES\`, \`PRODUCTS\`, and \`SUPPLEMENTARY_DEMOGRAPHICS\` tables. The \`SUPPLEMENTARY_DEMOGRAPHICS\` table has 4,500 rows of customer attributes (age, income, education, household size, affinity card ownership) — the canonical target dataset for OML classification examples.

**DMUSER schema** — a dedicated Data Mining user schema created for isolation. The Oracle GitHub examples and official documentation recommend running OML models under a dedicated schema rather than SH or SYSTEM.

**Install SH schema** (if not already present — it ships with Oracle sample schemas):

\`\`\`bash
# From \${ORACLE_HOME}/demo/schema/sales_history/
sqlplus sys/<password>@<db> as sysdba @sh_main.sql <sh_password> <default_ts> <temp_ts> <log_dir>
\`\`\`

Or using the official sample schema installer from https://github.com/oracle/db-sample-schemas:

\`\`\`bash
git clone https://github.com/oracle/db-sample-schemas.git
cd db-sample-schemas
sqlplus system/<password>@<db> @mksample.sql <sys_password> <system_password> \\
  <hr_password> <oe_password> <pm_password> <ix_password> <sh_password> \\
  <bi_password> <default_tablespace> <temp_tablespace> <log_dir>
\`\`\`

**Create the DMUSER schema** (for running models in isolation):

\`\`\`sql
-- Connect as SYSDBA
CREATE USER dmuser IDENTIFIED BY <password>
  DEFAULT TABLESPACE users
  TEMPORARY TABLESPACE temp;

-- Required privileges for OML4SQL
GRANT CREATE SESSION TO dmuser;
GRANT CREATE TABLE TO dmuser;
GRANT CREATE VIEW TO dmuser;
GRANT CREATE MINING MODEL TO dmuser;
GRANT EXECUTE ON DBMS_DATA_MINING TO dmuser;
GRANT EXECUTE ON DBMS_DATA_MINING_TRANSFORM TO dmuser;
GRANT EXECUTE ON DBMS_STAT_FUNCS TO dmuser;
GRANT SELECT ON sh.customers TO dmuser;
GRANT SELECT ON sh.supplementary_demographics TO dmuser;
GRANT SELECT ON sh.sales TO dmuser;
GRANT SELECT ON sh.products TO dmuser;
GRANT UNLIMITED TABLESPACE TO dmuser;
\`\`\`

The \`CREATE MINING MODEL\` privilege is the critical one — without it, \`DBMS_DATA_MINING.CREATE_MODEL\` raises \`ORA-01031: insufficient privileges\`. On pre-12c databases (where this privilege did not exist), the workaround was granting \`DBA\`, but that is not appropriate for production. On 12c and above, always use \`CREATE MINING MODEL\`.

---

## The OML4SQL Workflow

Every \`DBMS_DATA_MINING\` model follows the same five-step pattern:

1. **Prepare training data** — create or identify a view or table with one row per case, one column per feature, and a target column (for supervised learning)
2. **Create a settings table** — a two-column table (\`setting_name\`, \`setting_value\`) that configures the algorithm and its hyperparameters
3. **Create the model** — call \`DBMS_DATA_MINING.CREATE_MODEL\`
4. **Evaluate the model** — use \`DBMS_DATA_MINING.COMPUTE_CONFUSION_MATRIX\`, \`COMPUTE_LIFT\`, or \`COMPUTE_ROC\`
5. **Apply the model** — use SQL functions \`PREDICTION()\`, \`PREDICTION_PROBABILITY()\`, or \`CLUSTER_ID()\` in a SELECT statement

The settings table pattern is worth understanding. Every algorithm has a fixed set of \`setting_name\` constants defined as package-level constants in \`DBMS_DATA_MINING\`. The \`setting_value\` is always a \`VARCHAR2\`, even for numeric parameters — the database coerces internally. When \`PREP_AUTO\` is set to \`PREP_AUTO_ON\`, Oracle handles missing value imputation, outlier treatment, normalization, and categorical encoding automatically. This is almost always the right default for initial exploration.

---

## Algorithm Families Available in OML4SQL

| Mining Function | Algorithms |
|---|---|
| CLASSIFICATION | Decision Tree (DT), Naive Bayes (NB), Support Vector Machine (SVM), Generalized Linear Model (GLM), Neural Network (NN), Random Forest (RF), Gradient Boosting (XGBoost) |
| REGRESSION | GLM, SVM, Neural Network, Random Forest, Gradient Boosting |
| CLUSTERING | K-Means, O-Cluster (orthogonal partitioning) |
| FEATURE_EXTRACTION | Non-Negative Matrix Factorization (NMF), Singular Value Decomposition (SVD), Explicit Semantic Analysis (ESA), CUR Matrix Decomposition |
| ASSOCIATION_RULES | Apriori |
| ANOMALY_DETECTION | One-Class SVM |
| ATTRIBUTE_IMPORTANCE | Minimum Description Length (MDL) |

XGBoost and Random Forest were added in Oracle 18c. Gradient Boosting with tree-based learners matches the behavior of external gradient boosting libraries but executes entirely inside the Oracle kernel. The \`ALGO_XGBOOST\` constant maps to the embedded XGBoost implementation licensed from the open-source XGBoost project.

---

## Example 1: Classification with Decision Tree (CUST_AFFINITY_CARD Prediction)

Objective: predict which customers are likely to have an affinity card (binary: 0 or 1) based on demographic attributes.

\`\`\`sql
-- Connect as dmuser

-- Step 1: Create the training view (exclude the target from the features by keeping it as-is)
CREATE OR REPLACE VIEW dmuser.dt_train_data AS
SELECT cust_id,
       age,
       cust_marital_status,
       cust_income_level,
       education,
       household_size,
       occupation,
       yrs_residence,
       affinity_card        -- target column
FROM   sh.supplementary_demographics
WHERE  cust_id <= 100000;   -- 80% for training

CREATE OR REPLACE VIEW dmuser.dt_test_data AS
SELECT cust_id,
       age,
       cust_marital_status,
       cust_income_level,
       education,
       household_size,
       occupation,
       yrs_residence,
       affinity_card
FROM   sh.supplementary_demographics
WHERE  cust_id > 100000;    -- 20% for testing
\`\`\`

\`\`\`sql
-- Step 2: Create settings table
CREATE TABLE dmuser.dt_settings (
  setting_name  VARCHAR2(30),
  setting_value VARCHAR2(4000)
);

INSERT INTO dmuser.dt_settings VALUES
  (dbms_data_mining.algo_name,            dbms_data_mining.algo_decision_tree);
INSERT INTO dmuser.dt_settings VALUES
  (dbms_data_mining.prep_auto,            dbms_data_mining.prep_auto_on);
INSERT INTO dmuser.dt_settings VALUES
  (dbms_data_mining.tree_impurity_metric, dbms_data_mining.tree_impurity_gini);
INSERT INTO dmuser.dt_settings VALUES
  (dbms_data_mining.tree_term_max_depth,  '7');
COMMIT;
\`\`\`

The \`TREE_IMPURITY_GINI\` setting selects Gini impurity as the split criterion. The alternative is \`TREE_IMPURITY_ENTROPY\` (information gain). For most binary classification problems the difference is minor; Gini is computationally cheaper. \`TREE_TERM_MAX_DEPTH\` caps tree depth at 7 levels to prevent overfitting on this small dataset.

\`\`\`sql
-- Step 3: Create the model
BEGIN
  DBMS_DATA_MINING.CREATE_MODEL(
    model_name          => 'DT_AFFINITY_MODEL',
    mining_function     => DBMS_DATA_MINING.CLASSIFICATION,
    data_table_name     => 'DT_TRAIN_DATA',
    case_id_column_name => 'CUST_ID',
    target_column_name  => 'AFFINITY_CARD',
    settings_table_name => 'DT_SETTINGS'
  );
END;
/
\`\`\`

The \`data_table_name\` parameter accepts a table name or view name — both work. The \`case_id_column_name\` identifies the primary key of each training row (used for tracking during evaluation); it is excluded from the feature set automatically. The \`target_column_name\` is the label column for supervised learning.

\`\`\`sql
-- Step 4: View model attributes and feature importance
SELECT attribute_name, attribute_rank
FROM   dm_user_model_attributes
WHERE  model_name = 'DT_AFFINITY_MODEL'
ORDER  BY attribute_rank;
\`\`\`

The \`DM_USER_MODEL_ATTRIBUTES\` view (or \`ALL_MINING_MODEL_ATTRIBUTES\` for cross-schema visibility) shows every feature the model used during training along with its computed importance rank. For Decision Tree, rank 1 is the most discriminative attribute.

Apply the model (scoring):

\`\`\`sql
-- Predict affinity card likelihood for all customers in test set
SELECT cust_id,
       affinity_card                                              AS actual,
       PREDICTION(DT_AFFINITY_MODEL USING *)                    AS predicted,
       ROUND(PREDICTION_PROBABILITY(DT_AFFINITY_MODEL, 1 USING *), 4) AS prob_affinity
FROM   dmuser.dt_test_data
ORDER  BY prob_affinity DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

The \`USING *\` syntax tells the scoring function to draw all columns from the current row as features. The model ignores \`CUST_ID\` (it knows from training metadata that it is the case ID) and \`AFFINITY_CARD\` (it knows that is the target). \`PREDICTION_PROBABILITY(model, 1 USING *)\` returns the probability that the target is class \`1\` (has affinity card).

Evaluate with confusion matrix:

\`\`\`sql
-- Create a table to hold the apply results
CREATE TABLE dmuser.dt_apply_results AS
SELECT cust_id,
       PREDICTION(DT_AFFINITY_MODEL USING *) AS predicted_target,
       affinity_card                          AS actual_target
FROM   dmuser.dt_test_data;

-- Compute confusion matrix
DECLARE
  v_accuracy NUMBER;
BEGIN
  DBMS_DATA_MINING.COMPUTE_CONFUSION_MATRIX(
    accuracy                    => v_accuracy,
    apply_result_table_name     => 'DT_APPLY_RESULTS',
    target_table_name           => 'DT_TEST_DATA',
    case_id_column_name         => 'CUST_ID',
    target_column_name          => 'AFFINITY_CARD',
    confusion_matrix_table_name => 'DT_CONFUSION_MATRIX',
    score_column_name           => 'PREDICTED_TARGET',
    score_criterion_column_name => NULL,
    cost_matrix_table_name      => NULL
  );
  DBMS_OUTPUT.PUT_LINE('Accuracy: ' || ROUND(v_accuracy * 100, 2) || '%');
END;
/

SELECT * FROM dmuser.dt_confusion_matrix;
\`\`\`

The \`DT_CONFUSION_MATRIX\` table has three columns: \`ACTUAL_TARGET_VALUE\`, \`PREDICTED_TARGET_VALUE\`, and \`VALUE\` (count). A correct binary classification model on this dataset typically achieves 78–83% accuracy with a Decision Tree at max depth 7.

---

## Example 2: K-Means Clustering (Customer Segmentation)

Objective: segment customers into clusters based on purchasing behavior and demographics — no predefined target, unsupervised.

\`\`\`sql
-- Step 1: Training data (customer-level aggregates)
CREATE OR REPLACE VIEW dmuser.km_train_data AS
SELECT c.cust_id,
       c.cust_income_level,
       c.education,
       sd.age,
       sd.household_size,
       sd.yrs_residence,
       NVL(SUM(s.amount_sold), 0) AS total_spent,
       COUNT(s.prod_id)           AS purchase_count
FROM   sh.customers c
JOIN   sh.supplementary_demographics sd ON c.cust_id = sd.cust_id
LEFT JOIN sh.sales s ON c.cust_id = s.cust_id
GROUP  BY c.cust_id, c.cust_income_level, c.education,
          sd.age, sd.household_size, sd.yrs_residence;
\`\`\`

\`\`\`sql
-- Step 2: Settings for K-Means
CREATE TABLE dmuser.km_settings (
  setting_name  VARCHAR2(30),
  setting_value VARCHAR2(4000)
);

INSERT INTO dmuser.km_settings VALUES
  (dbms_data_mining.algo_name,         dbms_data_mining.algo_kmeans);
INSERT INTO dmuser.km_settings VALUES
  (dbms_data_mining.prep_auto,         dbms_data_mining.prep_auto_on);
INSERT INTO dmuser.km_settings VALUES
  (dbms_data_mining.kmns_iterations,   '20');
INSERT INTO dmuser.km_settings VALUES
  (dbms_data_mining.kmns_num_bins,     '10');
-- Number of clusters:
INSERT INTO dmuser.km_settings VALUES
  (dbms_data_mining.clus_num_clusters, '5');
COMMIT;
\`\`\`

The Oracle K-Means implementation uses an enhanced K-Means algorithm that is more stable than vanilla K-Means: it initializes cluster centroids using a distance-based sampling method (similar to K-Means++) rather than random initialization, so results are more consistent across runs. \`KMNS_ITERATIONS\` controls the maximum number of Lloyd's iterations. \`KMNS_NUM_BINS\` controls the histogram bins used for distance computation on continuous attributes.

\`\`\`sql
-- Step 3: Create the clustering model
BEGIN
  DBMS_DATA_MINING.CREATE_MODEL(
    model_name          => 'KM_CUSTOMER_SEGMENTS',
    mining_function     => DBMS_DATA_MINING.CLUSTERING,
    data_table_name     => 'KM_TRAIN_DATA',
    case_id_column_name => 'CUST_ID',
    target_column_name  => NULL,   -- no target for clustering
    settings_table_name => 'KM_SETTINGS'
  );
END;
/
\`\`\`

\`\`\`sql
-- Step 4: Assign customers to clusters
SELECT cust_id,
       CLUSTER_ID(KM_CUSTOMER_SEGMENTS USING *)              AS cluster_id,
       ROUND(CLUSTER_PROBABILITY(KM_CUSTOMER_SEGMENTS USING *), 4) AS cluster_prob
FROM   dmuser.km_train_data
ORDER  BY cluster_id, cluster_prob DESC;
\`\`\`

\`CLUSTER_ID()\` returns the integer cluster label assigned to each row. \`CLUSTER_PROBABILITY()\` returns the probability that the row belongs to its assigned cluster (computed from the distance to the cluster centroid relative to all cluster distances).

\`\`\`sql
-- Cluster profile: what characterizes each cluster
-- Use the CLUSTER_DETAILS function for a ranked attribute breakdown per case
SELECT cust_id,
       CLUSTER_ID(KM_CUSTOMER_SEGMENTS USING *) AS cluster_id,
       CLUSTER_DETAILS(KM_CUSTOMER_SEGMENTS USING *)         AS details
FROM   dmuser.km_train_data
WHERE  ROWNUM <= 10;
\`\`\`

For a summary profile across all cases in each cluster, aggregate the scored output:

\`\`\`sql
-- Create a cluster assignment table
CREATE TABLE dmuser.km_assignments AS
SELECT cust_id,
       CLUSTER_ID(KM_CUSTOMER_SEGMENTS USING *)              AS cluster_id,
       ROUND(CLUSTER_PROBABILITY(KM_CUSTOMER_SEGMENTS USING *), 4) AS cluster_prob
FROM   dmuser.km_train_data;

-- Summarize cluster sizes
SELECT cluster_id,
       COUNT(*)                              AS member_count,
       ROUND(AVG(cluster_prob), 4)          AS avg_probability,
       ROUND(MIN(cluster_prob), 4)          AS min_probability
FROM   dmuser.km_assignments
GROUP  BY cluster_id
ORDER  BY cluster_id;
\`\`\`

This summary reveals whether your cluster sizes are balanced. Highly imbalanced clusters (one cluster with 80% of members, others with 5% each) usually indicates the number of clusters is too high or the features have dominant high-cardinality attributes that need additional preprocessing.

---

## Example 3: Anomaly Detection with One-Class SVM

Objective: identify customers whose behavior deviates significantly from the norm — useful for fraud detection or outlier identification.

One-Class SVM trains on only the "normal" cases (it does not need labeled anomalies) and learns a boundary around the normal population. At scoring time, cases outside the boundary are flagged as anomalies. The \`SVMS_OUTLIER_RATE\` setting controls the fraction of training cases expected to fall outside the boundary.

\`\`\`sql
CREATE TABLE dmuser.svm_anomaly_settings (
  setting_name  VARCHAR2(30),
  setting_value VARCHAR2(4000)
);

INSERT INTO dmuser.svm_anomaly_settings VALUES
  (dbms_data_mining.algo_name,         dbms_data_mining.algo_support_vector_machines);
INSERT INTO dmuser.svm_anomaly_settings VALUES
  (dbms_data_mining.prep_auto,         dbms_data_mining.prep_auto_on);
INSERT INTO dmuser.svm_anomaly_settings VALUES
  (dbms_data_mining.svms_outlier_rate, '0.05');  -- expect 5% outliers
COMMIT;

BEGIN
  DBMS_DATA_MINING.CREATE_MODEL(
    model_name          => 'SVM_ANOMALY_MODEL',
    mining_function     => DBMS_DATA_MINING.ANOMALY_DETECTION,
    data_table_name     => 'KM_TRAIN_DATA',
    case_id_column_name => 'CUST_ID',
    target_column_name  => NULL,
    settings_table_name => 'SVM_ANOMALY_SETTINGS'
  );
END;
/
\`\`\`

\`\`\`sql
-- Score: PREDICTION returns 1 (typical) or 0 (anomaly)
SELECT cust_id,
       PREDICTION(SVM_ANOMALY_MODEL USING *)                  AS is_typical,
       PREDICTION_PROBABILITY(SVM_ANOMALY_MODEL, 0 USING *)   AS anomaly_prob
FROM   dmuser.km_train_data
WHERE  PREDICTION(SVM_ANOMALY_MODEL USING *) = 0
ORDER  BY anomaly_prob DESC;
\`\`\`

The convention for \`ANOMALY_DETECTION\` is inverted from classification: \`PREDICTION\` = 1 means typical, \`PREDICTION\` = 0 means anomalous. \`PREDICTION_PROBABILITY(model, 0 USING *)\` gives the probability of being an anomaly — sort descending to rank the most extreme outliers at the top.

A practical production use of this pattern: schedule a nightly job that scores all new transactions with the SVM anomaly model and inserts flagged rows (score = 0, anomaly_prob > 0.8) into a review queue table for fraud analysts.

---

## Example 4: Random Forest Classification (Oracle 18c and Above)

Decision Tree is interpretable but can underfit complex datasets. Random Forest builds an ensemble of trees using bootstrap sampling and random feature subsets — it is almost always more accurate than a single tree at the cost of interpretability.

\`\`\`sql
CREATE TABLE dmuser.rf_settings (
  setting_name  VARCHAR2(30),
  setting_value VARCHAR2(4000)
);

INSERT INTO dmuser.rf_settings VALUES
  (dbms_data_mining.algo_name,             dbms_data_mining.algo_random_forest);
INSERT INTO dmuser.rf_settings VALUES
  (dbms_data_mining.prep_auto,             dbms_data_mining.prep_auto_on);
INSERT INTO dmuser.rf_settings VALUES
  (dbms_data_mining.rfor_num_trees,        '100');  -- 100 trees in the ensemble
INSERT INTO dmuser.rf_settings VALUES
  (dbms_data_mining.rfor_sampling_ratio,   '0.7');  -- 70% bootstrap sample per tree
INSERT INTO dmuser.rf_settings VALUES
  (dbms_data_mining.tree_term_max_depth,   '10');   -- deeper trees for ensemble
COMMIT;

BEGIN
  DBMS_DATA_MINING.CREATE_MODEL(
    model_name          => 'RF_AFFINITY_MODEL',
    mining_function     => DBMS_DATA_MINING.CLASSIFICATION,
    data_table_name     => 'DT_TRAIN_DATA',
    case_id_column_name => 'CUST_ID',
    target_column_name  => 'AFFINITY_CARD',
    settings_table_name => 'RF_SETTINGS'
  );
END;
/

-- Compare accuracy between DT and RF
SELECT cust_id,
       affinity_card                                                  AS actual,
       PREDICTION(RF_AFFINITY_MODEL USING *)                        AS rf_predicted,
       PREDICTION(DT_AFFINITY_MODEL USING *)                        AS dt_predicted,
       ROUND(PREDICTION_PROBABILITY(RF_AFFINITY_MODEL, 1 USING *), 4) AS rf_prob,
       ROUND(PREDICTION_PROBABILITY(DT_AFFINITY_MODEL, 1 USING *), 4) AS dt_prob
FROM   dmuser.dt_test_data
ORDER  BY rf_prob DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

Random Forest models on this dataset typically achieve 84–88% accuracy, a meaningful improvement over the 78–83% for a single Decision Tree.

---

## Transformations and the DBMS_DATA_MINING_TRANSFORM Package

When \`PREP_AUTO = ON\`, Oracle handles transformations automatically. When you need explicit control — custom binning, specific normalization ranges, or manual outlier caps — use the \`DBMS_DATA_MINING_TRANSFORM\` package to build a transformation list and pass it to \`CREATE_MODEL\`.

\`\`\`sql
-- Example: manual normalization using min-max scaling
DECLARE
  xform_list DBMS_DATA_MINING_TRANSFORM.TRANSFORM_LIST;
BEGIN
  -- Normalize AGE to [0, 1] using min-max
  DBMS_DATA_MINING_TRANSFORM.SET_TRANSFORM(
    xform_list,
    'AGE',         -- attribute name
    NULL,          -- attribute spec (NULL = scalar)
    'AGE',         -- expression (identity — normalization is a separate step)
    'AGE_REVERSE', -- reverse expression
    'NORM_LINEAR'  -- normalization hint
  );

  DBMS_DATA_MINING.CREATE_MODEL2(
    model_name          => 'DT_MANUAL_XFORM_MODEL',
    mining_function     => DBMS_DATA_MINING.CLASSIFICATION,
    data_query          => 'SELECT * FROM dmuser.dt_train_data',
    set_list            => NULL,
    case_id_column_name => 'CUST_ID',
    target_column_name  => 'AFFINITY_CARD',
    xform_list          => xform_list
  );
END;
/
\`\`\`

Note the \`CREATE_MODEL2\` variant (introduced in Oracle 12.2): it accepts an inline SQL query string via \`data_query\` instead of requiring a named table or view. This is useful for applying ad-hoc filters or joins without creating intermediate objects.

---

## Managing Models

\`\`\`sql
-- List all models owned by current user
SELECT model_name,
       function_name,
       algorithm,
       build_duration,
       model_size
FROM   user_mining_models
ORDER  BY build_duration DESC;
\`\`\`

| View | Scope |
|---|---|
| \`USER_MINING_MODELS\` | Models owned by current schema |
| \`ALL_MINING_MODELS\` | Models accessible to current schema (including granted) |
| \`DBA_MINING_MODELS\` | All models in the database (requires DBA privilege) |
| \`USER_MINING_MODEL_ATTRIBUTES\` | Feature metadata for models in current schema |
| \`USER_MINING_MODEL_SETTINGS\` | Settings used to build each model |

\`\`\`sql
-- Drop a model
BEGIN
  DBMS_DATA_MINING.DROP_MODEL('DT_AFFINITY_MODEL');
END;
/

-- Rename a model (useful for promoting a champion model)
BEGIN
  DBMS_DATA_MINING.RENAME_MODEL(
    model_name     => 'RF_AFFINITY_MODEL',
    new_model_name => 'AFFINITY_CHAMPION_MODEL'
  );
END;
/
\`\`\`

\`\`\`sql
-- Export a model to another schema or database (for deployment)
BEGIN
  DBMS_DATA_MINING.EXPORT_MODEL(
    filename     => 'rf_affinity_export',
    directory    => 'DATA_PUMP_DIR',
    model_filter => 'name = ''RF_AFFINITY_MODEL'''
  );
END;
/

-- Import on the target database
BEGIN
  DBMS_DATA_MINING.IMPORT_MODEL(
    filename     => 'rf_affinity_export01.dmp',
    directory    => 'DATA_PUMP_DIR',
    model_filter => 'name = ''RF_AFFINITY_MODEL'''
  );
END;
/
\`\`\`

The export and import use Oracle Data Pump format under the hood. The \`DATA_PUMP_DIR\` directory object must point to a writable filesystem path and the user must have \`READ\` and \`WRITE\` privileges on that directory object.

---

## ROC Curve and Lift Chart Evaluation

For classification models in production, accuracy alone is insufficient. The ROC curve and lift chart reveal model discrimination power across all probability thresholds.

\`\`\`sql
-- Compute ROC curve
DECLARE
  v_auc NUMBER;
BEGIN
  DBMS_DATA_MINING.COMPUTE_ROC(
    roc_area_under_curve       => v_auc,
    apply_result_table_name    => 'DT_APPLY_RESULTS',
    target_table_name          => 'DT_TEST_DATA',
    case_id_column_name        => 'CUST_ID',
    target_column_name         => 'AFFINITY_CARD',
    roc_table_name             => 'DT_ROC_TABLE',
    positive_target_value      => '1',
    score_column_name          => 'PREDICTED_TARGET',
    score_criterion_column_name => NULL
  );
  DBMS_OUTPUT.PUT_LINE('AUC: ' || ROUND(v_auc, 4));
END;
/

-- Inspect ROC points
SELECT probability,
       true_positive_fraction,
       false_positive_fraction
FROM   dmuser.dt_roc_table
ORDER  BY probability DESC;
\`\`\`

\`\`\`sql
-- Compute lift chart (10 quantiles)
BEGIN
  DBMS_DATA_MINING.COMPUTE_LIFT(
    apply_result_table_name    => 'DT_APPLY_RESULTS',
    target_table_name          => 'DT_TEST_DATA',
    case_id_column_name        => 'CUST_ID',
    target_column_name         => 'AFFINITY_CARD',
    lift_table_name            => 'DT_LIFT_TABLE',
    positive_target_value      => '1',
    score_column_name          => 'PREDICTED_TARGET',
    score_criterion_column_name => NULL,
    num_quantiles              => 10
  );
END;
/

SELECT quantile_number,
       quantile_total_count,
       lift_cumulative,
       target_density
FROM   dmuser.dt_lift_table
ORDER  BY quantile_number;
\`\`\`

A lift of 2.5 at quantile 1 means: if you target the top 10% of customers ranked by model probability, you capture 2.5x more affinity card holders than random selection would. This translates directly into campaign efficiency metrics for marketing use cases.

---

## The Oracle GitHub Workflow in Practice

The oracle-db-examples repo scripts are structured to run as a complete tutorial. A recommended first run:

\`\`\`bash
git clone https://github.com/oracle/oracle-db-examples.git
cd oracle-db-examples/machine-learning/oml4sql
sqlplus dmuser/<password>@<db> @oml4sql-classification-decision-tree.sql
\`\`\`

Each script self-documents its expected output. Running them in sequence against the SH schema gives a complete ML workflow reference in under 30 minutes.

The repository also includes a \`README.md\` for each subdirectory that lists the minimum Oracle Database version required for each script. Some scripts (especially those using XGBoost or the \`CREATE_MODEL2\` API) require 18c or 19c and will raise \`ORA-00904: invalid identifier\` on 12.1.

---

## Performance Considerations for Large Datasets

OML4SQL builds models in parallel using the Oracle parallel query engine. The degree of parallelism defaults to the table's DOP setting. For large training datasets (tens of millions of rows), set DOP explicitly:

\`\`\`sql
-- Set parallel DOP on the training view
ALTER VIEW dmuser.km_train_data PARALLEL 8;

-- Or use a hint in CREATE_MODEL2's data_query
BEGIN
  DBMS_DATA_MINING.CREATE_MODEL2(
    model_name          => 'KM_PARALLEL_MODEL',
    mining_function     => DBMS_DATA_MINING.CLUSTERING,
    data_query          => 'SELECT /*+ PARALLEL(8) */ * FROM dmuser.km_train_data',
    set_list            => NULL,
    case_id_column_name => 'CUST_ID',
    target_column_name  => NULL
  );
END;
/
\`\`\`

Build time also depends on the algorithm. K-Means and Decision Tree build very fast (seconds to minutes on millions of rows). Neural Network and SVM are slower because they require iterative gradient-based convergence. Random Forest with 100 trees on a wide dataset can take 10–30 minutes without parallelism but drops to 2–5 minutes at DOP 8.

Monitor active model builds using \`V\$SESSION\` filtered by the DMUSER schema:

\`\`\`sql
SELECT sid, serial#, status, sql_id, event, seconds_in_wait
FROM   v\$session
WHERE  username = 'DMUSER'
AND    status   = 'ACTIVE';
\`\`\`

---

## Summary

Oracle Machine Learning's OML4SQL component brings the full machine learning lifecycle — data preparation, model training, evaluation, and scoring — inside the Oracle Database engine. The \`DBMS_DATA_MINING\` package provides a consistent API across classification (Decision Tree, Random Forest, SVM, Neural Network), regression (GLM, SVM), clustering (K-Means, O-Cluster), feature extraction (NMF, SVD), and anomaly detection (One-Class SVM). The Oracle GitHub repository at https://github.com/oracle/oracle-db-examples/tree/master/machine-learning provides working, runnable scripts for each algorithm.

The schema setup — granting \`CREATE MINING MODEL\`, \`EXECUTE ON DBMS_DATA_MINING\`, and access to the SH demo tables — takes under 10 minutes and unlocks in-database ML for any Enterprise Edition instance with the Advanced Analytics option. The five-step workflow (prepare data → settings table → create model → evaluate → score with SQL functions) is consistent across all algorithm families, so mastering it with Decision Tree transfers directly to Random Forest, K-Means, and One-Class SVM without learning a new API.

The core production advantage of OML4SQL over external ML frameworks is operational simplicity: models are database objects, subject to Oracle's standard backup, recovery, export, and access control mechanisms. There is no Python environment to manage, no model registry to maintain separately, and no serialization format to version. The model lives where the data lives, and scoring is a SQL function call.`,
};

async function main() {
  console.log('Inserting Oracle ML implementation blog post...');
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
