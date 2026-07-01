import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Machine Learning Runbook: Schema Setup, Algorithm Execution, and Model Management',
  slug: 'oracle-machine-learning-implementation-runbook',
  excerpt:
    'A complete DBA-focused runbook for Oracle Machine Learning (OML4SQL): verifying prerequisites, cloning the Oracle GitHub examples, installing the SH sample schema, creating the DMUSER schema, running Decision Tree and K-Means models, managing model lifecycle, scheduling automated retraining, and monitoring scoring performance.',
  category: 'oracle-ml' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-01'),
  youtubeUrl: null,
  content: `## Overview

This runbook covers the full Oracle Machine Learning for SQL (OML4SQL) implementation lifecycle on Oracle Database 12.2 or later. It references the canonical Oracle GitHub repositories — [oracle-db-examples](https://github.com/oracle/oracle-db-examples/tree/master/machine-learning) and [db-sample-schemas](https://github.com/oracle/db-sample-schemas) — as the authoritative source of algorithm scripts and training data. Work through each phase sequentially on first installation; subsequent model refreshes only require Phases 5–9.

---

## Phase 1: Prerequisites and License Verification

### 1.1 Verify the Advanced Analytics Option Is Installed

OML4SQL requires the Advanced Analytics database option. A missing or FALSE result means the option is not installed and model creation calls will fail with ORA-40009.

\`\`\`sql
SELECT value FROM v\$option WHERE parameter = 'Data Mining';
-- Must return TRUE
\`\`\`

### 1.2 Verify Oracle Database Version

OML4SQL in its current form requires Oracle Database 12.2 at minimum. Oracle 19c or 21c is strongly recommended for the full algorithm set including Random Forest and Gradient Boosting.

\`\`\`sql
SELECT banner_full FROM v\$version;
\`\`\`

### 1.3 Verify DBMS_DATA_MINING Package Exists

Both the package specification and package body must be VALID. An INVALID status indicates a failed installation or a pending upgrade script.

\`\`\`sql
SELECT object_name, object_type, status
FROM   dba_objects
WHERE  object_name = 'DBMS_DATA_MINING'
  AND  object_type LIKE 'PACKAGE%';
\`\`\`

Expected output: two rows — \`PACKAGE\` and \`PACKAGE BODY\`, both with STATUS = VALID.

If either row is INVALID, recompile:

\`\`\`sql
ALTER PACKAGE sys.dbms_data_mining COMPILE;
ALTER PACKAGE sys.dbms_data_mining COMPILE BODY;
\`\`\`

### 1.4 Check Available Algorithms for This Version

The \`dm_algorithms\` view enumerates every algorithm available in your installed database version. Use this to confirm that the algorithms referenced later in this runbook are present before attempting to configure them.

\`\`\`sql
SELECT algorithm_name, function_name
FROM   dm_algorithms
ORDER  BY function_name, algorithm_name;
\`\`\`

On Oracle 19c you should see at minimum: DECISION_TREE, RANDOM_FOREST, GRADIENT_BOOSTING, SUPPORT_VECTOR_MACHINES, NAIVE_BAYES, GENERALIZED_LINEAR_MODEL, NEURAL_NETWORK, KMEANS, O_CLUSTER, NONNEGATIVE_MATRIX_FACTOR, EXPLICIT_SEMANTIC_ANALYSIS, and APRIORI_ASSOCIATION_RULES.

### 1.5 Estimate Storage Requirements

OML models are stored as LOBs in the SYS schema inside the SYSAUX tablespace. Large models (deep neural networks, random forests with many trees) can consume several hundred megabytes each. Check current SYSAUX usage and autoextend headroom before building models in bulk.

\`\`\`sql
SELECT tablespace_name,
       ROUND(SUM(bytes)/1024/1024, 0) AS used_mb
FROM   dba_segments
WHERE  tablespace_name = 'SYSAUX'
GROUP  BY tablespace_name;

SELECT file_name,
       ROUND(bytes/1024/1024, 0)      AS total_mb,
       ROUND(maxbytes/1024/1024, 0)   AS max_mb
FROM   dba_data_files
WHERE  tablespace_name = 'SYSAUX';
\`\`\`

As a guideline, reserve at least 2 GB of headroom in SYSAUX for a typical set of five to ten models trained on the SH schema. Extend the datafile before proceeding if max_mb − total_mb is under 2048.

\`\`\`sql
ALTER DATABASE DATAFILE '<sysaux_datafile_path>' RESIZE 8192M;
\`\`\`

---

## Phase 2: Clone Oracle GitHub Repository and Review Scripts

Oracle publishes reference implementations for every supported OML4SQL algorithm in the [oracle-db-examples](https://github.com/oracle/oracle-db-examples/tree/master/machine-learning) repository. These scripts are the most reliable source for correct constant names and hyperparameter keys — they are updated with each database release.

### 2.1 Clone the Repository

\`\`\`bash
git clone https://github.com/oracle/oracle-db-examples.git
cd oracle-db-examples/machine-learning/oml4sql
ls -la
\`\`\`

Expected directory contents — each file covers one algorithm end to end:

- \`oml4sql-classification-decision-tree.sql\`
- \`oml4sql-classification-naive-bayes.sql\`
- \`oml4sql-classification-random-forest.sql\`
- \`oml4sql-clustering-kmeans.sql\`
- \`oml4sql-anomaly-detection-svm.sql\`
- \`oml4sql-regression-neural-network.sql\`
- \`oml4sql-feature-extraction-nmf.sql\`
- \`oml4sql-association-rules.sql\`

### 2.2 Review a Script Before Running

Inspect the first 50 lines of any script to understand its structure before executing it against your database. This is especially important in production environments where you need to confirm the script will drop and recreate only its own artifacts.

\`\`\`bash
head -50 oml4sql-classification-decision-tree.sql
\`\`\`

### 2.3 Consistent Structure Across All GitHub Scripts

Every script in the repository follows the same seven-step pattern. Understanding this pattern lets you run any of them with confidence:

1. Drop the existing model if present (idempotent execution)
2. Create a settings table with \`VARCHAR2(30)\` / \`VARCHAR2(4000)\` columns
3. Insert the algorithm name constant and all relevant hyperparameter constants
4. Call \`DBMS_DATA_MINING.CREATE_MODEL\` with the settings table
5. Query \`USER_MINING_MODELS\` and \`USER_MINING_MODEL_ATTRIBUTES\` to verify the build
6. Apply the model to a test dataset using SQL scoring functions
7. Evaluate using confusion matrix, lift, or ROC as appropriate

---

## Phase 3: Install the SH (Sales History) Demo Schema

The Oracle Sales History schema is the canonical training dataset for OML4SQL demonstrations. It contains ~55,000 customers, ~900,000 sales rows, and the \`SUPPLEMENTARY_DEMOGRAPHICS\` table used in all classification examples. The schema is published in Oracle's [db-sample-schemas](https://github.com/oracle/db-sample-schemas) repository.

### 3.1 Clone the Sample Schemas Repository

\`\`\`bash
git clone https://github.com/oracle/db-sample-schemas.git
cd db-sample-schemas
\`\`\`

### 3.2 Verify SH Schema Is Not Already Installed

\`\`\`sql
SELECT username, account_status, created
FROM   dba_users
WHERE  username = 'SH';
\`\`\`

If the SH row exists with ACCOUNT_STATUS = OPEN, skip to Phase 3.5 to verify object counts before proceeding.

### 3.3 Install All Sample Schemas

The \`mksample.sql\` master script installs HR, OE, PM, SH, IX, and BI schemas in one pass. Supply all eight passwords, the permanent and temporary tablespace names, a log directory, and the connect string.

\`\`\`bash
sqlplus system/<password>@<db> @mksample.sql \\
  <sys_password> \\
  <system_password> \\
  <hr_password> \\
  <oe_password> \\
  <pm_password> \\
  <ix_password> \\
  <sh_password> \\
  <bi_password> \\
  USERS \\
  TEMP \\
  /tmp/schema_install_logs/ \\
  localhost:1521/<service_name>
\`\`\`

To install SH alone (faster for OML-only environments):

\`\`\`bash
cd db-sample-schemas/sales_history
sqlplus sys/<password>@<db> as sysdba \\
  @sh_main.sql <sh_password> USERS TEMP /tmp/
\`\`\`

### 3.4 Verify SH Schema Object Counts

\`\`\`sql
SELECT object_type, COUNT(*) AS obj_count
FROM   dba_objects
WHERE  owner = 'SH'
GROUP  BY object_type
ORDER  BY obj_count DESC;
-- Expected: TABLES (7+), INDEXES (20+), VIEWS, SYNONYMS, etc.
\`\`\`

### 3.5 Verify Key ML Training Tables

\`\`\`sql
SELECT COUNT(*) AS row_count FROM sh.supplementary_demographics;
-- Expected: ~4500 rows

SELECT COUNT(*) AS row_count FROM sh.customers;
-- Expected: ~55,000 rows

SELECT COUNT(*) AS row_count FROM sh.sales;
-- Expected: ~900,000+ rows

-- Preview training data structure
SELECT * FROM sh.supplementary_demographics FETCH FIRST 5 ROWS ONLY;
\`\`\`

\`SUPPLEMENTARY_DEMOGRAPHICS\` is the primary training table for classification exercises. It contains customer lifestyle attributes joined to \`AFFINITY_CARD\`, a binary target indicating whether a customer holds an affinity card. Confirm the target distribution before proceeding:

\`\`\`sql
SELECT affinity_card, COUNT(*) AS cnt,
       ROUND(COUNT(*) / SUM(COUNT(*)) OVER () * 100, 1) AS pct
FROM   sh.supplementary_demographics
GROUP  BY affinity_card;
\`\`\`

A healthy class distribution is roughly 70/30. If heavily imbalanced, plan to supply a cost matrix or class weight setting to the model.

---

## Phase 4: Create and Configure the DMUSER Schema

Create a dedicated schema for all OML work. Never build models directly in SH or SYS — this keeps model artifacts, settings tables, and scoring views isolated and auditable.

### 4.1 Create the Dedicated OML Schema

\`\`\`sql
-- As SYSDBA
CREATE USER dmuser IDENTIFIED BY "<password>"
  DEFAULT TABLESPACE users
  TEMPORARY TABLESPACE temp
  QUOTA UNLIMITED ON users;
\`\`\`

### 4.2 Grant Required Privileges

\`\`\`sql
GRANT CREATE SESSION          TO dmuser;
GRANT CREATE TABLE            TO dmuser;
GRANT CREATE VIEW             TO dmuser;
GRANT CREATE PROCEDURE        TO dmuser;
GRANT CREATE SEQUENCE         TO dmuser;
GRANT CREATE MINING MODEL     TO dmuser;
GRANT CREATE JOB              TO dmuser;

GRANT EXECUTE ON DBMS_DATA_MINING           TO dmuser;
GRANT EXECUTE ON DBMS_DATA_MINING_TRANSFORM TO dmuser;
GRANT EXECUTE ON DBMS_STAT_FUNCS            TO dmuser;
GRANT EXECUTE ON DBMS_OUTPUT                TO dmuser;

-- Access to SH training data
GRANT SELECT ON sh.customers                    TO dmuser;
GRANT SELECT ON sh.supplementary_demographics   TO dmuser;
GRANT SELECT ON sh.sales                        TO dmuser;
GRANT SELECT ON sh.products                     TO dmuser;
GRANT SELECT ON sh.channels                     TO dmuser;
GRANT SELECT ON sh.times                        TO dmuser;
\`\`\`

\`CREATE MINING MODEL\` is the key privilege. Without it, \`DBMS_DATA_MINING.CREATE_MODEL\` will raise ORA-40283. \`EXECUTE ON DBMS_DATA_MINING_TRANSFORM\` is needed for the transformation pipeline; omitting it causes silent failures when \`PREP_AUTO\` is ON.

### 4.3 Create Public Synonyms for Convenience (Optional)

\`\`\`sql
CREATE PUBLIC SYNONYM supplementary_demographics FOR sh.supplementary_demographics;
CREATE PUBLIC SYNONYM customers FOR sh.customers;
\`\`\`

### 4.4 Verify Privileges

\`\`\`sql
SELECT privilege FROM dba_sys_privs WHERE grantee = 'DMUSER'
UNION ALL
SELECT privilege FROM dba_tab_privs WHERE grantee = 'DMUSER'
ORDER BY 1;
\`\`\`

Confirm the following appear in the output: CREATE MINING MODEL, EXECUTE (on DBMS_DATA_MINING), and SELECT on each SH table you intend to use as training data.

---

## Phase 5: Run the Decision Tree Classification Model (from GitHub)

### 5.1 Run the GitHub Reference Script Directly

The fastest path is to execute Oracle's published script. It handles its own cleanup, settings, model build, attribute query, and scoring in a single pass.

\`\`\`bash
cd oracle-db-examples/machine-learning/oml4sql
sqlplus dmuser/<password>@<db> @oml4sql-classification-decision-tree.sql
\`\`\`

### 5.2 Manual Step-by-Step Equivalent

For environments where you need fine-grained control over hyperparameters, or where you want to extend the GitHub example, run the steps individually. Connect as dmuser first.

**Drop any existing model and create the settings table:**

\`\`\`sql
BEGIN
  DBMS_DATA_MINING.DROP_MODEL('DT_AFFINITY_V2');
EXCEPTION
  WHEN OTHERS THEN NULL;
END;
/

CREATE TABLE dt_settings_v2 (
  setting_name  VARCHAR2(30),
  setting_value VARCHAR2(4000)
);

INSERT INTO dt_settings_v2 VALUES (dbms_data_mining.algo_name,            dbms_data_mining.algo_decision_tree);
INSERT INTO dt_settings_v2 VALUES (dbms_data_mining.prep_auto,            dbms_data_mining.prep_auto_on);
INSERT INTO dt_settings_v2 VALUES (dbms_data_mining.tree_impurity_metric, dbms_data_mining.tree_impurity_gini);
INSERT INTO dt_settings_v2 VALUES (dbms_data_mining.tree_term_max_depth,  '7');
INSERT INTO dt_settings_v2 VALUES (dbms_data_mining.clas_cost_matrix_type, dbms_data_mining.clas_cost_matrix_none);
COMMIT;
\`\`\`

**Create the model:**

\`\`\`sql
BEGIN
  DBMS_DATA_MINING.CREATE_MODEL(
    model_name          => 'DT_AFFINITY_V2',
    mining_function     => DBMS_DATA_MINING.CLASSIFICATION,
    data_table_name     => 'SUPPLEMENTARY_DEMOGRAPHICS',
    case_id_column_name => 'CUST_ID',
    target_column_name  => 'AFFINITY_CARD',
    settings_table_name => 'DT_SETTINGS_V2'
  );
END;
/
\`\`\`

The \`data_table_name\` parameter accepts a table or view name visible to the calling schema. Because we created the public synonym in Phase 4.3, the unqualified name \`SUPPLEMENTARY_DEMOGRAPHICS\` resolves correctly. Without the synonym, use \`SH.SUPPLEMENTARY_DEMOGRAPHICS\`.

### 5.3 Verify the Model Was Created

\`\`\`sql
SELECT model_name, function_name, algorithm, build_duration, model_size
FROM   user_mining_models
WHERE  model_name = 'DT_AFFINITY_V2';
\`\`\`

\`BUILD_DURATION\` is reported in seconds. On a 4-CPU system with the full 4,500-row \`SUPPLEMENTARY_DEMOGRAPHICS\` table, expect 2–10 seconds. \`MODEL_SIZE\` is in bytes — a typical Decision Tree on this dataset is 50–500 KB.

### 5.4 View Attribute Importance

\`\`\`sql
SELECT attribute_name,
       attribute_importance_value,
       attribute_rank
FROM   user_mining_model_attributes
WHERE  model_name = 'DT_AFFINITY_V2'
ORDER  BY attribute_rank;
\`\`\`

Attributes with \`ATTRIBUTE_RANK = 1\` are the most predictive of the target. For the affinity card model, \`HOUSEHOLD_SIZE\`, \`YRS_RESIDENCE\`, and \`OCCUPATION\` typically appear in the top five.

### 5.5 Score New Data

\`\`\`sql
SELECT cust_id,
       affinity_card                                 AS actual,
       PREDICTION(DT_AFFINITY_V2 USING *)           AS predicted,
       ROUND(PREDICTION_PROBABILITY(DT_AFFINITY_V2, 1 USING *), 4) AS p_affinity
FROM   sh.supplementary_demographics
WHERE  cust_id BETWEEN 101500 AND 101550
ORDER  BY p_affinity DESC;
\`\`\`

\`PREDICTION()\` returns the most likely class. \`PREDICTION_PROBABILITY(model, class USING *)\` returns the probability that the row belongs to the specified class — here class 1 means the customer holds an affinity card. Probabilities near 1.0 indicate high model confidence.

---

## Phase 6: Run the K-Means Clustering Model (from GitHub)

### 6.1 Run the GitHub Script

\`\`\`bash
sqlplus dmuser/<password>@<db> @oml4sql-clustering-kmeans.sql
\`\`\`

### 6.2 Manual Execution Overview

The GitHub K-Means script creates an aggregated training view from the SH schema before building the model. If you are building the model manually, first create a training table or view that aggregates customer spending, age, and product diversity metrics by CUST_ID. All numeric features should be in a single row per customer — K-Means cannot handle multi-row-per-case inputs.

The settings table should include \`KMNS_CLUSTERS\` (recommended: 5–8 for SH data), \`KMNS_ITERATIONS\` (20), \`KMNS_CONV_TOL\` (0.001), and \`PREP_AUTO_ON\` to normalise features automatically before distance calculation.

### 6.3 Inspect Cluster Centroids

\`\`\`sql
SELECT t.cluster_id,
       a.attribute_name,
       a.mean,
       a.variance,
       a.mode_value
FROM   TABLE(DBMS_DATA_MINING.GET_MODEL_DETAILS_KM('KM_CUSTOMER_SEGMENTS')) t,
       TABLE(t.centroid) a
ORDER  BY t.cluster_id, a.attribute_name;
\`\`\`

The centroid mean for numeric attributes tells you the average value for customers in that cluster. Low variance indicates a tight, homogeneous segment; high variance indicates a diffuse cluster that may benefit from a higher K.

### 6.4 Assign All Customers to Clusters and Analyse Segment Profiles

\`\`\`sql
SELECT cluster_id,
       COUNT(*)                   AS customer_count,
       ROUND(AVG(total_spent), 2) AS avg_spend,
       ROUND(AVG(age), 1)         AS avg_age
FROM (
  SELECT CLUSTER_ID(KM_CUSTOMER_SEGMENTS USING *) AS cluster_id,
         total_spent,
         age
  FROM   dmuser.km_train_data
)
GROUP  BY cluster_id
ORDER  BY cluster_id;
\`\`\`

Segments with high average spend and middle age often correspond to premium customers; segments with low spend and young age may indicate acquisition targets. Use these profiles to drive downstream marketing or pricing decisions.

---

## Phase 7: Run the Anomaly Detection Model

### 7.1 Run the GitHub Anomaly Detection Script

Oracle's anomaly detection example uses One-Class SVM — it learns the boundary of normal behaviour from unlabelled data and flags rows that fall outside that boundary as anomalous. This is useful for fraud detection, hardware failure prediction, and data quality validation.

\`\`\`bash
sqlplus dmuser/<password>@<db> @oml4sql-anomaly-detection-svm.sql
\`\`\`

### 7.2 Retrieve Anomalous Customers for Investigation

\`PREDICTION(model USING *) = 0\` means the row is classified as anomalous (One-Class SVM uses 1 for typical, 0 for anomalous). Sort by \`PREDICTION_PROBABILITY(model, 0 USING *)\` to surface the most extreme outliers first.

\`\`\`sql
SELECT cust_id,
       total_spent,
       purchase_count,
       PREDICTION_PROBABILITY(SVM_ANOMALY_MODEL, 0 USING *) AS anomaly_score
FROM   dmuser.km_train_data
WHERE  PREDICTION(SVM_ANOMALY_MODEL USING *) = 0
ORDER  BY anomaly_score DESC
FETCH FIRST 50 ROWS ONLY;
\`\`\`

Customers at the top of this list have spending or behavioural patterns that most differ from the bulk of the dataset. Investigate manually before taking automated action — outliers in training data are sometimes data entry errors rather than genuinely anomalous customers.

---

## Phase 8: Model Management and Lifecycle

OML4SQL models are database objects managed through \`DBMS_DATA_MINING\` procedures. They do not follow the same DDL lifecycle as tables or indexes — there is no CREATE OR REPLACE syntax. Every model lifecycle operation goes through the package.

### 8.1 List All Models in the Current Schema

\`\`\`sql
SELECT model_name, function_name, algorithm,
       TO_CHAR(creation_date, 'YYYY-MM-DD HH24:MI') AS created,
       ROUND(model_size/1024, 1)  AS model_kb
FROM   user_mining_models
ORDER  BY creation_date DESC;
\`\`\`

Use \`DBA_MINING_MODELS\` (as SYSDBA) to view models across all schemas.

### 8.2 Export a Model for Deployment to Another Database

Model export uses Oracle Data Pump format. The \`DATA_PUMP_DIR\` directory object must exist and point to a filesystem path writable by the oracle OS user.

\`\`\`sql
BEGIN
  DBMS_DATA_MINING.EXPORT_MODEL(
    filename     => 'DT_AFFINITY_V2_EXPORT',
    directory    => 'DATA_PUMP_DIR',
    model_filter => 'name = ''DT_AFFINITY_V2'''
  );
END;
/
\`\`\`

Verify the export file was created:

\`\`\`bash
ls -lh <data_pump_dir>/DT_AFFINITY_V2_EXPORT*
\`\`\`

### 8.3 Import a Model on the Target Database

Copy the \`.dmp\` file to the target server's Data Pump directory, then:

\`\`\`sql
BEGIN
  DBMS_DATA_MINING.IMPORT_MODEL(
    filename   => 'DT_AFFINITY_V2_EXPORT01.dmp',
    directory  => 'DATA_PUMP_DIR',
    model_filter => 'name = ''DT_AFFINITY_V2'''
  );
END;
/
\`\`\`

### 8.4 Rename a Model

Rename a model when promoting it from a development name to a production name. All existing SQL scoring calls that reference the old name will break after the rename — update application code and views before renaming in production.

\`\`\`sql
BEGIN
  DBMS_DATA_MINING.RENAME_MODEL('DT_AFFINITY_V2', 'DT_AFFINITY_PROD');
END;
/
\`\`\`

### 8.5 Drop a Model

\`\`\`sql
BEGIN
  DBMS_DATA_MINING.DROP_MODEL('DT_AFFINITY_V2');
END;
/
\`\`\`

Dropping a model releases its SYSAUX storage immediately. There is no recycle bin for models.

### 8.6 Automate Stale Model Cleanup with a Registry Table

OML4SQL does not natively track the last time a model was scored. Create a metadata table to record scoring activity and drive retirement decisions:

\`\`\`sql
-- OML models don't track last-use natively; use a metadata table approach
CREATE TABLE dmuser.model_registry (
  model_name        VARCHAR2(128),
  purpose           VARCHAR2(256),
  created_by        VARCHAR2(30),
  last_scored_date  DATE,
  retire_after_days NUMBER DEFAULT 90
);
\`\`\`

Update \`last_scored_date\` from within scoring procedures or application code. A weekly DBMS_SCHEDULER job can then compare \`SYSDATE - last_scored_date\` against \`retire_after_days\` and alert the DBA team before auto-dropping.

---

## Phase 9: Scheduling Automated Model Refresh with DBMS_SCHEDULER

In production, models should be retrained periodically to prevent score drift as the underlying customer data changes. The recommended pattern is a stored procedure that drops, rebuilds, and registers the model, triggered weekly by a DBMS_SCHEDULER job.

\`\`\`sql
CREATE OR REPLACE PROCEDURE dmuser.refresh_affinity_model AS
BEGIN
  -- Drop old model
  BEGIN
    DBMS_DATA_MINING.DROP_MODEL('DT_AFFINITY_PROD');
  EXCEPTION
    WHEN OTHERS THEN NULL;
  END;

  -- Recreate settings
  EXECUTE IMMEDIATE 'DELETE FROM dt_settings_v2';

  INSERT INTO dt_settings_v2 VALUES (dbms_data_mining.algo_name,            dbms_data_mining.algo_decision_tree);
  INSERT INTO dt_settings_v2 VALUES (dbms_data_mining.prep_auto,            dbms_data_mining.prep_auto_on);
  INSERT INTO dt_settings_v2 VALUES (dbms_data_mining.tree_term_max_depth,  '7');
  COMMIT;

  -- Rebuild model on full current data
  DBMS_DATA_MINING.CREATE_MODEL(
    model_name          => 'DT_AFFINITY_PROD',
    mining_function     => DBMS_DATA_MINING.CLASSIFICATION,
    data_table_name     => 'SUPPLEMENTARY_DEMOGRAPHICS',
    case_id_column_name => 'CUST_ID',
    target_column_name  => 'AFFINITY_CARD',
    settings_table_name => 'DT_SETTINGS_V2'
  );

  -- Log
  INSERT INTO dmuser.model_registry (model_name, purpose, created_by, last_scored_date)
  VALUES ('DT_AFFINITY_PROD', 'Weekly refresh', USER, SYSDATE)
  ON CONFLICT DO NOTHING;
  COMMIT;
END;
/

-- Schedule weekly retraining at Sunday 01:00
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'DMUSER.WEEKLY_AFFINITY_MODEL_REFRESH',
    job_type        => 'STORED_PROCEDURE',
    job_action      => 'DMUSER.REFRESH_AFFINITY_MODEL',
    start_date      => SYSTIMESTAMP,
    repeat_interval => 'FREQ=WEEKLY; BYDAY=SUN; BYHOUR=1; BYMINUTE=0',
    enabled         => TRUE,
    comments        => 'Weekly Decision Tree model retraining'
  );
END;
/
\`\`\`

Verify the job was created and enabled:

\`\`\`sql
SELECT job_name, enabled, state, next_run_date
FROM   dba_scheduler_jobs
WHERE  job_name = 'WEEKLY_AFFINITY_MODEL_REFRESH';
\`\`\`

Check job run history after the first execution:

\`\`\`sql
SELECT job_name, status, actual_start_date, run_duration
FROM   dba_scheduler_job_run_details
WHERE  job_name = 'WEEKLY_AFFINITY_MODEL_REFRESH'
ORDER  BY actual_start_date DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

If a run fails, the \`ADDITIONAL_INFO\` column in \`DBA_SCHEDULER_JOB_RUN_DETAILS\` contains the Oracle error code and stack trace. Common causes are: training data view returning zero rows, SYSAUX space exhaustion, and stale statistics on the training table causing the optimizer to choose a bad plan for the internal feature extraction queries.

---

## Phase 10: Monitoring Scripts

### 10.1 oml_model_health_report.sql

Save as \`oml_model_health_report.sql\` and run as dmuser to get a ready-to-read status report covering all models in the schema.

\`\`\`sql
-- oml_model_health_report.sql
-- Run as: sqlplus dmuser/<password>@<db> @oml_model_health_report.sql

SET LINESIZE 200
SET PAGESIZE 60
SET TRIMOUT ON
COLUMN model_name   FORMAT A30
COLUMN algorithm    FORMAT A32
COLUMN age_days     FORMAT 9999
COLUMN model_kb     FORMAT 99999.9
COLUMN attr_count   FORMAT 9999
COLUMN top_attrs    FORMAT A60 WRAP

PROMPT ============================================================
PROMPT  OML Model Health Report
PROMPT  Generated: &_DATE
PROMPT ============================================================

SELECT
    m.model_name,
    m.algorithm,
    ROUND(SYSDATE - m.creation_date, 0)   AS age_days,
    ROUND(m.model_size / 1024, 1)          AS model_kb,
    COUNT(a.attribute_name)                AS attr_count,
    LISTAGG(
      CASE WHEN a.attribute_rank <= 3
           THEN a.attribute_name || '(' || a.attribute_rank || ')'
      END, ', '
    ) WITHIN GROUP (ORDER BY a.attribute_rank) AS top_attrs
FROM   user_mining_models m
LEFT JOIN user_mining_model_attributes a
       ON  a.model_name = m.model_name
      AND  a.attribute_rank <= 3
GROUP  BY m.model_name,
          m.algorithm,
          m.creation_date,
          m.model_size
ORDER  BY m.creation_date DESC;

PROMPT
PROMPT ============================================================
PROMPT  End of Report
PROMPT ============================================================
\`\`\`

### 10.2 oml_scoring_performance_test.sql

Save as \`oml_scoring_performance_test.sql\`. This script times three consecutive full-table \`PREDICTION()\` calls and reports rows per second for each run. Use it for regression testing after database upgrades or patch applications.

\`\`\`sql
-- oml_scoring_performance_test.sql
-- Run as: sqlplus dmuser/<password>@<db> @oml_scoring_performance_test.sql

SET SERVEROUTPUT ON SIZE UNLIMITED
SET TIMING OFF

DECLARE
  v_start    NUMBER;
  v_end      NUMBER;
  v_elapsed  NUMBER;
  v_rows     NUMBER;
  v_rps      NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_rows FROM sh.supplementary_demographics;
  DBMS_OUTPUT.PUT_LINE('Rows in scoring table: ' || v_rows);
  DBMS_OUTPUT.PUT_LINE('Model: DT_AFFINITY_PROD');
  DBMS_OUTPUT.PUT_LINE('---');

  FOR i IN 1..3 LOOP
    v_start := DBMS_UTILITY.GET_TIME;

    DECLARE v_dummy NUMBER; BEGIN
      SELECT COUNT(*)
      INTO   v_dummy
      FROM (
        SELECT PREDICTION(DT_AFFINITY_PROD USING *) AS pred
        FROM   sh.supplementary_demographics
      );
    END;

    v_end     := DBMS_UTILITY.GET_TIME;
    v_elapsed := (v_end - v_start) / 100;   -- GET_TIME returns centiseconds

    IF v_elapsed > 0 THEN
      v_rps := ROUND(v_rows / v_elapsed, 0);
    ELSE
      v_rps := 0;
    END IF;

    DBMS_OUTPUT.PUT_LINE(
      'Run ' || i || ': ' || v_elapsed || 's  |  ' || v_rps || ' rows/sec'
    );
  END LOOP;

  DBMS_OUTPUT.PUT_LINE('---');
  DBMS_OUTPUT.PUT_LINE('Done. Compare rows/sec across database versions to detect regression.');
END;
/
\`\`\`

### 10.3 oml_github_sync_and_run.sh

Save as \`oml_github_sync_and_run.sh\` and run from a cron job or manually to pull the latest Oracle examples and re-run only the scripts that have changed since the last pull. This keeps a demo environment current with Oracle's published algorithm reference implementations.

\`\`\`bash
#!/bin/bash
# oml_github_sync_and_run.sh
# Usage: ./oml_github_sync_and_run.sh
# Requires: git, sqlplus on PATH; ORACLE_HOME, DB_SERVICE, DMUSER_PASSWORD, REPO_DIR set

set -euo pipefail

ORACLE_HOME=\${ORACLE_HOME}
DB_SERVICE=\${DB_SERVICE}
DMUSER_PASSWORD=\${DMUSER_PASSWORD}
REPO_DIR=\${REPO_DIR:-/opt/oracle/oracle-db-examples}
OML_DIR="\${REPO_DIR}/machine-learning/oml4sql"
LOG_DIR="/var/log/oml_sync"
TIMESTAMP=\$(date +%Y%m%d_%H%M%S)
LOGFILE="\${LOG_DIR}/sync_\${TIMESTAMP}.log"

mkdir -p "\${LOG_DIR}"

echo "[\${TIMESTAMP}] Starting OML GitHub sync" | tee -a "\${LOGFILE}"

# Pull latest from GitHub
cd "\${REPO_DIR}"
git fetch origin 2>&1 | tee -a "\${LOGFILE}"

# Identify changed OML4SQL scripts since last pull
CHANGED=\$(git diff HEAD origin/master --name-only -- "machine-learning/oml4sql/*.sql" 2>/dev/null || true)

if [ -z "\${CHANGED}" ]; then
  echo "No OML4SQL scripts changed since last pull. Exiting." | tee -a "\${LOGFILE}"
  git pull --ff-only origin master 2>&1 | tee -a "\${LOGFILE}"
  exit 0
fi

# Pull the changes
git pull --ff-only origin master 2>&1 | tee -a "\${LOGFILE}"

echo "Changed scripts:" | tee -a "\${LOGFILE}"
echo "\${CHANGED}" | tee -a "\${LOGFILE}"

# Re-run each changed script
cd "\${OML_DIR}"
for SCRIPT in \${CHANGED}; do
  SCRIPT_NAME=\$(basename "\${SCRIPT}")
  echo "Running: \${SCRIPT_NAME}" | tee -a "\${LOGFILE}"
  "\${ORACLE_HOME}/bin/sqlplus" -S dmuser/"\${DMUSER_PASSWORD}"@"\${DB_SERVICE}" \\
    @"\${OML_DIR}/\${SCRIPT_NAME}" 2>&1 | tee -a "\${LOGFILE}"
  echo "Completed: \${SCRIPT_NAME}" | tee -a "\${LOGFILE}"
done

echo "[\$(date +%Y%m%d_%H%M%S)] OML sync complete. Log: \${LOGFILE}" | tee -a "\${LOGFILE}"
\`\`\`

Schedule this script to run weekly from the database server's cron:

\`\`\`bash
# Example crontab entry — runs every Sunday at 00:30
30 0 * * 0 /opt/oracle/scripts/oml_github_sync_and_run.sh >> /var/log/oml_sync/cron.log 2>&1
\`\`\`

---

## Quick Reference

### DBMS_DATA_MINING Key Procedures

| Procedure | Purpose |
|---|---|
| \`CREATE_MODEL\` | Build a new model from a training table or view |
| \`DROP_MODEL\` | Remove a model and release its SYSAUX storage |
| \`EXPORT_MODEL\` | Export a model to a Data Pump dump file |
| \`IMPORT_MODEL\` | Import a model from a Data Pump dump file |
| \`RENAME_MODEL\` | Rename a model (updates the catalog in place) |
| \`COMPUTE_CONFUSION_MATRIX\` | Evaluate classification accuracy against a test set |
| \`COMPUTE_LIFT\` | Compute cumulative lift and gain for a classification model |
| \`COMPUTE_ROC\` | Compute Receiver Operating Characteristic data |

### Algorithm Name Constants

| Constant | Algorithm |
|---|---|
| \`algo_decision_tree\` | Decision Tree |
| \`algo_random_forest\` | Random Forest |
| \`algo_support_vector_machines\` | Support Vector Machines (classification, regression, anomaly) |
| \`algo_neural_network\` | Multilayer Perceptron Neural Network |
| \`algo_naive_bayes\` | Naive Bayes |
| \`algo_generalized_linear_model\` | Generalized Linear Model (logistic / linear regression) |
| \`algo_kmeans\` | K-Means Clustering |
| \`algo_o_cluster\` | O-Cluster (grid-based clustering) |
| \`algo_nonnegative_matrix_factor\` | Non-Negative Matrix Factorisation (feature extraction) |

### Mining Function Constants

| Constant | Use Case |
|---|---|
| \`CLASSIFICATION\` | Binary or multiclass target prediction |
| \`REGRESSION\` | Continuous numeric target prediction |
| \`CLUSTERING\` | Unsupervised segment discovery |
| \`FEATURE_EXTRACTION\` | Dimensionality reduction, topic modelling |
| \`ANOMALY_DETECTION\` | Outlier and fraud detection |
| \`ASSOCIATION_RULES\` | Market basket, affinity analysis |

### SQL Scoring Functions

| Function | Description |
|---|---|
| \`PREDICTION(model USING *)\` | Returns the predicted class or value |
| \`PREDICTION_PROBABILITY(model, class USING *)\` | Probability for a specific class (classification) |
| \`PREDICTION_DETAILS(model USING *)\` | XML detail of contributing attributes and their weights |
| \`CLUSTER_ID(model USING *)\` | Cluster assignment for a row |
| \`CLUSTER_PROBABILITY(model USING *)\` | Probability of cluster membership |
| \`FEATURE_ID(model USING *)\` | ID of the dominant extracted feature |
| \`FEATURE_VALUE(model USING *)\` | Value of the dominant extracted feature |

### Key Data Dictionary Views

| View | Contents |
|---|---|
| \`USER_MINING_MODELS\` | Models in the current schema (name, algorithm, size, date) |
| \`USER_MINING_MODEL_ATTRIBUTES\` | Per-attribute metadata including importance rank |
| \`DM_ALGORITHMS\` | All algorithms available in this database installation |
| \`DBA_MINING_MODELS\` | Cross-schema view of all models (requires DBA privilege) |

### GitHub Reference Links

Oracle DB Examples (OML4SQL scripts by algorithm): https://github.com/oracle/oracle-db-examples/tree/master/machine-learning

Oracle DB Sample Schemas (SH, HR, OE, and others): https://github.com/oracle/db-sample-schemas

---

## Troubleshooting

| Error | Most Likely Cause | Resolution |
|---|---|---|
| \`ORA-40283: must have CREATE MINING MODEL privilege\` | Privilege not granted to DMUSER | Run Phase 4.2 \`GRANT CREATE MINING MODEL TO dmuser\` as SYSDBA |
| \`ORA-40009: Data Mining option is not installed\` | Advanced Analytics option missing | Verify with Phase 1.1; option must be installed at database creation time |
| \`ORA-00942: table or view does not exist\` during CREATE_MODEL | Training table not visible to DMUSER | Use fully qualified name \`SH.SUPPLEMENTARY_DEMOGRAPHICS\` or create synonym |
| \`ORA-40210: invalid setting value\` | Wrong constant name for this DB version | Query \`DM_ALGORITHMS\` in Phase 1.4; some constants differ between 12.2 and 19c |
| Model builds but has low accuracy | Class imbalance or wrong hyperparameters | Check target distribution; add \`CLAS_COST_MATRIX_TABLE\` setting |
| \`PREP_AUTO_ON\` skips columns | Null-heavy or zero-variance columns excluded | Normal — verify via \`USER_MINING_MODEL_ATTRIBUTES\` which attributes were used |
| DBMS_SCHEDULER job fails | ORA-01652 temp space during model build | Extend TEMP tablespace; verify DMUSER has TEMPORARY TABLESPACE temp |
| Export fails with \`ORA-39001\` | DATA_PUMP_DIR does not exist or is not writable | \`CREATE DIRECTORY data_pump_dir AS '/path'\` and grant \`READ, WRITE ON DIRECTORY\` to dmuser |`,
};

async function main() {
  console.log('Inserting Oracle ML runbook...');
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
