import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS and In-Database Analytics: OLAP, Data Mining, and Machine Learning on ERP Data',
  slug: 'oracle-ebs-olap-data-mining-machine-learning',
  excerpt:
    'Oracle EBS sits on top of one of the richest transactional data stores in enterprise software — years of GL postings, AR aging patterns, AP payment behaviors, and inventory demand signals. Oracle Machine Learning runs inside the same database engine, which means the ML models live next to the data rather than requiring extraction pipelines. This guide covers building OLAP cubes on EBS financial data, training Oracle ML models on AR, AP, and inventory datasets, and operationalizing predictions back into EBS workflows.',
  category: 'oracle-ml' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `Oracle EBS accumulates transactional data for years — sometimes decades. GL_BALANCES holds the complete financial history of every subsidiary and cost center. AR_PAYMENT_SCHEDULES_ALL records every invoice and every payment, building a behavioral dataset on thousands of customers. AP_INVOICES_ALL logs every supplier transaction, including late payments, short pays, and duplicates. MTL_DEMAND captures the supply and demand signals that drive every inventory replenishment decision.

The analytical problem is not a data availability problem. The problem is that EBS was designed as a transactional system, and transactional systems answer point-in-time questions: what is the current AR balance? which invoices are overdue? what is the on-hand quantity? They do not, by default, answer predictive questions: which customers are likely to pay late next month? which invoices are statistically probable duplicates? what demand should we plan for in Q3?

Oracle Machine Learning (OML) resolves this directly. Because OML runs inside Oracle Database — the same database engine that houses EBS — the ML algorithms operate on the same tables that EBS reads and writes. There is no ETL pipeline to build and maintain, no data warehouse to provision, and no synchronization lag between the operational data and the analytical result. A payment prediction model trained on AR_PAYMENT_SCHEDULES_ALL can score new invoices as they are created in the same transaction.

This guide covers three analytics layers on EBS data: OLAP for multi-dimensional financial analysis, Oracle Data Mining for pattern detection and classification, and Oracle Machine Learning for predictive modeling — with the EBS base tables as the data source for each.

---

## The EBS Analytics Stack

Oracle's analytics tooling for EBS has evolved through several generations:

**Generation 1 — Oracle Discoverer**: The original EBS reporting tool. End-of-life. Replaced.

**Generation 2 — Oracle Business Intelligence Enterprise Edition (OBIEE)**: The full BI stack with pre-built EBS data models (Oracle Business Intelligence Applications, or OBIA). Provides dashboards, OLAP-style pivot analysis, and pre-built KPIs for GL, AR, AP, and supply chain. Still deployed at many sites running EBS 12.2.

**Generation 3 — Oracle Analytics Cloud (OAC)**: The SaaS successor to OBIEE. Connects to EBS via ODI (Oracle Data Integrator) or direct JDBC. Adds embedded machine learning, AutoML, and natural language query on top of the BI foundation.

**In-Database Analytics — Oracle Machine Learning (OML)**: Runs entirely within Oracle Database. No separate analytics server required. Uses SQL, PL/SQL, Python, and R interfaces to train and apply models directly against EBS base tables. This is the layer this guide focuses on — not because OBIEE and OAC are unimportant, but because in-database ML is where the most powerful and least-utilized EBS analytics capability lives.

---

## Part 1: OLAP on EBS Financial Data

### The GL Data Structure

Oracle EBS general ledger data is organized across three primary tables:

- **GL_BALANCES**: period-end balances by code combination, currency, ledger, and balance type (Actual, Budget, Encumbrance)
- **GL_CODE_COMBINATIONS**: the account segments that define each unique financial dimension combination
- **GL_PERIODS**: the accounting calendar periods

For OLAP purposes, GL_BALANCES is the fact table and the dimension tables are GL_CODE_COMBINATIONS (for account segments: company, department, account, sub-account), GL_PERIODS (for time), and GL_LEDGERS (for the ledger/subsidiary hierarchy).

### Building an OLAP Analytical View

Oracle Database's OLAP option provides cube objects that store pre-aggregated multi-dimensional data. For organizations that do not have OBIEE or OAC deployed, the in-database OLAP cube provides the same pivot-and-drill capability directly from SQL.

The financial cube dimensions for EBS:

\`\`\`sql
-- Create a GL analytical view (Oracle 12c+ syntax with ANALYTIC VIEW)
CREATE OR REPLACE ANALYTIC VIEW gl_financial_av
  USING gl_mv_source   -- materialized view of GL_BALANCES joined to dimensions
  DIMENSION BY (
    -- Time dimension
    period_hier HIERARCHY (
      period_name MEMBER OF periods_dim
      CHILD OF quarter_name MEMBER OF quarters_dim
      CHILD OF fiscal_year  MEMBER OF years_dim
    ),
    -- Account hierarchy
    account_hier HIERARCHY (
      account       MEMBER OF accounts_dim
      CHILD OF account_category MEMBER OF acct_cat_dim
    ),
    -- Department dimension
    dept_hier HIERARCHY (
      department MEMBER OF depts_dim
    )
  )
  MEASURES (
    actual_balance FACT gl_balances.net_activity,
    budget_balance FACT gl_balances.budget_dr - gl_balances.budget_cr,
    variance       AS (actual_balance - budget_balance),
    variance_pct   AS (CASE WHEN budget_balance != 0
                            THEN variance / budget_balance * 100
                       END)
  );
\`\`\`

Once the analytic view is defined, queries that would otherwise require complex GROUP BY ROLLUP or CUBE syntax become straightforward:

\`\`\`sql
-- Actual vs budget by department and period with hierarchy rollup
SELECT dept_hier.department,
       period_hier.quarter_name,
       actual_balance,
       budget_balance,
       variance,
       ROUND(variance_pct, 1) AS variance_pct
FROM   gl_financial_av
WHERE  period_hier.fiscal_year = 2026
HIERARCHIES (dept_hier, period_hier)
ORDER  BY dept_hier.department, period_hier.quarter_name;
\`\`\`

### Materialized View Foundation for EBS GL OLAP

For production OLAP on EBS, build a materialized view that pre-joins the necessary tables and refreshes on a schedule (daily or weekly depending on analytical latency requirements):

\`\`\`sql
CREATE MATERIALIZED VIEW gl_mv_source
  BUILD IMMEDIATE
  REFRESH COMPLETE ON DEMAND
AS
SELECT gb.period_name,
       gp.quarter_num,
       gp.period_year,
       gcc.segment1                       AS company,
       gcc.segment2                       AS department,
       gcc.segment3                       AS account,
       gcc.account_type,
       gb.currency_code,
       gb.actual_flag,
       SUM(gb.period_net_dr - gb.period_net_cr) AS net_activity,
       SUM(gb.begin_balance_dr - gb.begin_balance_cr) AS begin_balance,
       SUM(gb.begin_balance_dr - gb.begin_balance_cr
         + gb.period_net_dr - gb.period_net_cr)   AS end_balance
FROM   gl_balances gb
JOIN   gl_code_combinations gcc
       ON gcc.code_combination_id = gb.code_combination_id
JOIN   gl_periods gp
       ON gp.period_name    = gb.period_name
       AND gp.period_set_name = 'Accounting'
WHERE  gb.actual_flag IN ('A', 'B')   -- Actual and Budget
GROUP  BY gb.period_name, gp.quarter_num, gp.period_year,
          gcc.segment1, gcc.segment2, gcc.segment3,
          gcc.account_type, gb.currency_code, gb.actual_flag;
\`\`\`

This materialized view runs the expensive GL aggregation once per refresh cycle. All subsequent OLAP queries run against the MV rather than hitting GL_BALANCES directly.

---

## Part 2: Data Mining on EBS Transaction Data

Oracle Data Mining (now part of Oracle Machine Learning for SQL, or OML4SQL) provides a library of in-database algorithms accessible via the DBMS_DATA_MINING package. No data needs to leave the database.

### Use Case 1: Duplicate Invoice Detection in AP

Duplicate invoices are a persistent problem in accounts payable. EBS validates exact duplicates (same invoice number + same vendor), but near-duplicates — same amount with slightly different invoice numbers, or the same invoice submitted by different vendor sites — pass validation and create duplicate payments.

The approach: train a classification model on historical AP data where confirmed duplicates have been identified, then score incoming invoices.

**Feature engineering from AP tables:**

\`\`\`sql
-- Training dataset: features that distinguish duplicates from legitimate invoices
CREATE TABLE ap_invoice_features AS
SELECT ai.invoice_id,
       ai.invoice_amount,
       ai.vendor_id,
       ai.invoice_date,
       -- Days between this invoice date and the most recent prior invoice
       -- from the same vendor for a similar amount
       ai.invoice_date - LAG(ai.invoice_date)
         OVER (PARTITION BY ai.vendor_id
               ORDER BY ai.invoice_date)            AS days_since_last_similar,
       -- Count of invoices from this vendor in the past 30 days
       COUNT(*) OVER (
         PARTITION BY ai.vendor_id
         ORDER BY ai.invoice_date
         RANGE BETWEEN INTERVAL '30' DAY PRECEDING AND CURRENT ROW
       )                                            AS vendor_invoice_frequency_30d,
       -- Variance from this vendor's average invoice amount
       ai.invoice_amount - AVG(ai.invoice_amount)
         OVER (PARTITION BY ai.vendor_id)           AS amount_variance_from_mean,
       -- How unique is this invoice number pattern (1=unique, >1=suspect)
       COUNT(*) OVER (
         PARTITION BY ai.vendor_id,
           REGEXP_REPLACE(ai.invoice_num, '[0-9]', 'N')
       )                                            AS invoice_num_pattern_count,
       -- Target: 1=confirmed duplicate, 0=legitimate
       NVL(ai.cancelled_date, DATE '9999-12-31')   AS cancelled_date,
       CASE WHEN ai.cancelled_reason_code = 'DUPLICATE' THEN 1 ELSE 0 END AS is_duplicate
FROM   ap_invoices_all ai
WHERE  ai.org_id = 204
AND    ai.creation_date >= ADD_MONTHS(SYSDATE, -24);
\`\`\`

**Training the model with OML4SQL:**

\`\`\`sql
-- Build a Decision Tree classification model for duplicate detection
DECLARE
  v_settings DBMS_DATA_MINING.SETTING_LIST;
BEGIN
  v_settings('ALGO_NAME')             := 'ALGO_DECISION_TREE';
  v_settings('PREP_AUTO')             := 'ON';
  v_settings('TREE_IMPURITY_METRIC')  := 'TREE_IMPURITY_GINI';
  v_settings('TREE_TERM_MAX_DEPTH')   := '8';
  v_settings('CLAS_PRIORS_ADJUSTMENT'):= 'ON';

  DBMS_DATA_MINING.CREATE_MODEL(
    model_name          => 'AP_DUPLICATE_DETECT_V1',
    mining_function     => DBMS_DATA_MINING.CLASSIFICATION,
    data_table_name     => 'AP_INVOICE_FEATURES',
    case_id_column_name => 'INVOICE_ID',
    target_column_name  => 'IS_DUPLICATE',
    settings_table_name => NULL,
    settings_array      => v_settings
  );
END;
/
\`\`\`

**Scoring new invoices in real time:**

\`\`\`sql
-- Score new AP invoices as they arrive (run as part of AP interface processing)
SELECT ai.invoice_id,
       ai.invoice_num,
       aps.vendor_name,
       ai.invoice_amount,
       PREDICTION(ap_duplicate_detect_v1 USING *) AS predicted_duplicate,
       ROUND(
         PREDICTION_PROBABILITY(ap_duplicate_detect_v1, 1 USING *) * 100,
         1
       )                                           AS duplicate_probability_pct
FROM   ap_invoices_all ai
JOIN   ap_suppliers aps ON aps.vendor_id = ai.vendor_id
-- Join to features view
JOIN   ap_invoice_features_v feat ON feat.invoice_id = ai.invoice_id
WHERE  ai.creation_date >= TRUNC(SYSDATE)   -- today's new invoices
ORDER  BY duplicate_probability_pct DESC;
\`\`\`

Invoices with \`duplicate_probability_pct\` above 80% are flagged for manual review before payment processing.

### Use Case 2: Customer Clustering for AR Collections Strategy

K-Means clustering segments customers into groups based on payment behavior — without needing predefined labels. Each cluster represents a payment behavior archetype that drives a different collections strategy.

\`\`\`sql
-- Feature set: AR payment behavior per customer (last 12 months)
CREATE TABLE ar_customer_payment_features AS
SELECT hca.cust_account_id,
       hca.account_number,
       hp.party_name,
       COUNT(aps.payment_schedule_id)           AS invoice_count,
       ROUND(AVG(aps.amount_due_original), 0)   AS avg_invoice_amount,
       ROUND(AVG(
         CASE WHEN aps.actual_date_closed IS NOT NULL
              THEN aps.actual_date_closed - aps.due_date
         END
       ), 1)                                    AS avg_days_late,
       COUNT(CASE WHEN aps.actual_date_closed > aps.due_date THEN 1 END)
         / COUNT(*) * 100                       AS pct_paid_late,
       MAX(CASE WHEN aps.status = 'OP'
                THEN SYSDATE - aps.due_date END) AS max_days_overdue_open,
       SUM(CASE WHEN aps.status = 'OP'
                THEN aps.amount_due_remaining END) AS total_open_balance
FROM   hz_cust_accounts hca
JOIN   hz_parties hp        ON hp.party_id = hca.party_id
JOIN   ar_payment_schedules_all aps
       ON aps.customer_id  = hca.cust_account_id
       AND aps.class       = 'INV'
       AND aps.trx_date    >= ADD_MONTHS(SYSDATE, -12)
GROUP  BY hca.cust_account_id, hca.account_number, hp.party_name;
\`\`\`

\`\`\`sql
-- Train K-Means clustering model
DECLARE
  v_settings DBMS_DATA_MINING.SETTING_LIST;
BEGIN
  v_settings('ALGO_NAME')        := 'ALGO_KMEANS';
  v_settings('PREP_AUTO')        := 'ON';
  v_settings('KMNS_ITERATIONS')  := '30';
  v_settings('KMNS_NUM_CLUSTERS'):= '5';   -- 5 payment behavior clusters

  DBMS_DATA_MINING.CREATE_MODEL(
    model_name          => 'AR_CUSTOMER_SEGMENTS_V1',
    mining_function     => DBMS_DATA_MINING.CLUSTERING,
    data_table_name     => 'AR_CUSTOMER_PAYMENT_FEATURES',
    case_id_column_name => 'CUST_ACCOUNT_ID',
    target_column_name  => NULL,   -- Clustering is unsupervised
    settings_array      => v_settings
  );
END;
/

-- Assign clusters to customers
SELECT cust_account_id,
       account_number,
       party_name,
       avg_days_late,
       pct_paid_late,
       total_open_balance,
       CLUSTER_ID(ar_customer_segments_v1 USING *) AS payment_segment,
       CLUSTER_PROBABILITY(ar_customer_segments_v1 USING *) AS segment_confidence
FROM   ar_customer_payment_features
ORDER  BY payment_segment, avg_days_late DESC;
\`\`\`

The resulting segments typically resolve to recognizable behavioral groups: chronic late payers, prompt payers, high-value strategic accounts, intermittent customers, and high-risk outstanding. Each segment receives a different collections contact cadence configured in the EBS Collections module.

---

## Part 3: Machine Learning for EBS Demand Forecasting

### Inventory Demand Prediction

EBS ASCP (Advanced Supply Chain Planning) includes built-in forecasting, but it relies on exponential smoothing and Croston's method — statistical techniques that perform poorly on intermittent demand and items with strong causal relationships (promotional lifts, seasonal patterns, macroeconomic correlations).

Oracle Machine Learning adds regression and time-series models that outperform traditional ERP forecasting for non-stationary demand patterns.

**Feature engineering from EBS inventory tables:**

\`\`\`sql
-- Demand history feature set by item and period
CREATE TABLE inv_demand_features AS
SELECT msi.segment1          AS item_number,
       msi.description,
       TO_CHAR(mtt.transaction_date, 'YYYY-MM') AS demand_month,
       SUM(ABS(mtt.transaction_quantity))        AS total_demand,
       -- Lagged demand (prior 3 months) as predictors
       LAG(SUM(ABS(mtt.transaction_quantity)), 1)
         OVER (PARTITION BY msi.inventory_item_id
               ORDER BY TO_CHAR(mtt.transaction_date, 'YYYY-MM')) AS demand_lag1,
       LAG(SUM(ABS(mtt.transaction_quantity)), 2)
         OVER (PARTITION BY msi.inventory_item_id
               ORDER BY TO_CHAR(mtt.transaction_date, 'YYYY-MM')) AS demand_lag2,
       LAG(SUM(ABS(mtt.transaction_quantity)), 3)
         OVER (PARTITION BY msi.inventory_item_id
               ORDER BY TO_CHAR(mtt.transaction_date, 'YYYY-MM')) AS demand_lag3,
       -- Same month prior year
       LAG(SUM(ABS(mtt.transaction_quantity)), 12)
         OVER (PARTITION BY msi.inventory_item_id
               ORDER BY TO_CHAR(mtt.transaction_date, 'YYYY-MM')) AS demand_same_month_py,
       -- Month number (seasonal signal)
       TO_NUMBER(TO_CHAR(mtt.transaction_date, 'MM'))             AS month_num,
       -- Quarter (seasonal grouping)
       TO_NUMBER(TO_CHAR(mtt.transaction_date, 'Q'))              AS quarter_num
FROM   mtl_material_transactions mtt
JOIN   mtl_system_items_b msi
       ON msi.inventory_item_id = mtt.inventory_item_id
       AND msi.organization_id  = mtt.organization_id
WHERE  mtt.organization_id = 204
AND    mtt.transaction_type_id IN (33, 52, 11818)  -- Issue, Sales Order Issue
AND    mtt.transaction_date >= ADD_MONTHS(SYSDATE, -36)
GROUP  BY msi.inventory_item_id, msi.segment1, msi.description,
          TO_CHAR(mtt.transaction_date, 'YYYY-MM'),
          TO_NUMBER(TO_CHAR(mtt.transaction_date, 'MM')),
          TO_NUMBER(TO_CHAR(mtt.transaction_date, 'Q'));
\`\`\`

**Train a GLM (Generalized Linear Model) regression for demand:**

\`\`\`sql
DECLARE
  v_settings DBMS_DATA_MINING.SETTING_LIST;
BEGIN
  v_settings('ALGO_NAME')           := 'ALGO_GENERALIZED_LINEAR_MODEL';
  v_settings('PREP_AUTO')           := 'ON';
  v_settings('GLMS_SOLVER')         := 'GLMS_SOLVER_QR';
  v_settings('GLMS_RIDGE_REGRESSION'):= 'GLMS_RIDGE_REG_ENABLE';

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

**Generate next-month demand predictions:**

\`\`\`sql
-- Score the model for all active items for next month
SELECT item_number,
       description,
       demand_lag1                                AS last_month_actual,
       demand_same_month_py                       AS same_month_prior_year,
       ROUND(
         PREDICTION(inv_demand_forecast_v1 USING *), 0
       )                                          AS predicted_demand_next_month
FROM   inv_demand_features
WHERE  demand_month = TO_CHAR(SYSDATE, 'YYYY-MM')  -- current month features
ORDER  BY item_number;
\`\`\`

The predicted demand values can be loaded into the MSD_DEMAND_PLANS table to seed the ASCP demand plan, replacing or supplementing the EBS native forecast.

---

## Part 4: GL Anomaly Detection

Unusual journal entries — large one-time postings, entries made outside business hours, reversals with unusual amounts — are signals that warrant investigation. Outlier detection finds them without requiring rule-based threshold configuration.

**Feature engineering from GL tables:**

\`\`\`sql
-- Journal entry feature set for anomaly detection
CREATE TABLE gl_journal_features AS
SELECT gjh.je_header_id,
       gjh.name                           AS journal_name,
       gjh.created_by,
       gjh.creation_date,
       -- Time-of-day signal: hour of creation (off-hours = higher risk)
       TO_NUMBER(TO_CHAR(gjh.creation_date, 'HH24')) AS creation_hour,
       -- Day-of-week signal
       TO_NUMBER(TO_CHAR(gjh.creation_date, 'D'))    AS creation_dow,
       -- Journal line count (unusually high = complex/suspect)
       COUNT(gjl.je_line_num)             AS line_count,
       -- Total absolute value (unusually large = high materiality)
       SUM(ABS(gjl.accounted_dr))         AS total_debit_amount,
       -- Proportion of lines that are reversals
       COUNT(CASE WHEN gjl.description LIKE '%REVERSAL%'
                       OR gjl.description LIKE '%REVERSE%' THEN 1 END)
         / COUNT(*) * 100                 AS pct_reversal_lines,
       -- Number of distinct accounts touched
       COUNT(DISTINCT gjl.code_combination_id) AS distinct_accounts,
       -- Whether it was posted in an already-closed period
       gjh.period_name
FROM   gl_je_headers gjh
JOIN   gl_je_lines gjl ON gjl.je_header_id = gjh.je_header_id
WHERE  gjh.ledger_id = 2
AND    gjh.creation_date >= ADD_MONTHS(SYSDATE, -12)
AND    gjh.status = 'P'   -- Posted journals only
GROUP  BY gjh.je_header_id, gjh.name, gjh.created_by,
          gjh.creation_date, gjh.period_name;
\`\`\`

\`\`\`sql
-- Train a One-Class SVM for outlier detection
-- (One-Class SVM identifies the normal boundary; points outside = anomalies)
DECLARE
  v_settings DBMS_DATA_MINING.SETTING_LIST;
BEGIN
  v_settings('ALGO_NAME')           := 'ALGO_SUPPORT_VECTOR_MACHINES';
  v_settings('SVMS_KERNEL_FUNCTION'):= 'SVMS_RBF';
  v_settings('PREP_AUTO')           := 'ON';
  v_settings('SVMS_OUTLIER_RATE')   := '.05';   -- Flag top 5% as anomalies

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

-- Score current period journals
SELECT je_header_id,
       journal_name,
       created_by,
       creation_date,
       creation_hour,
       total_debit_amount,
       line_count,
       PREDICTION(gl_anomaly_detect_v1 USING *) AS is_anomaly,   -- 1=normal, 0=anomaly
       ROUND(
         PREDICTION_PROBABILITY(gl_anomaly_detect_v1, 0 USING *) * 100, 1
       )                                         AS anomaly_score_pct
FROM   gl_journal_features
WHERE  period_name = 'JUN-26'
AND    PREDICTION(gl_anomaly_detect_v1 USING *) = 0   -- anomalies only
ORDER  BY anomaly_score_pct DESC;
\`\`\`

---

## Operationalizing Models in EBS

A model that scores a CSV file once a month is a report. A model that scores every new invoice before it reaches the payables queue is a control. The difference is operationalization.

**Three integration patterns for EBS:**

**1. Concurrent Program scoring**: Create an EBS concurrent program that runs an OML scoring query and writes results to a results table. EBS workflow reads the results table to trigger holds, alerts, or approvals. This pattern works for batch scoring — duplicate detection on overnight AP imports, demand forecast updates fed to ASCP.

**2. Database trigger scoring**: A BEFORE INSERT trigger on AP_INVOICES_INTERFACE calls PREDICTION() and sets a flag column based on the result. The EBS import process reads the flag and routes high-risk invoices to a review queue. This pattern works for real-time scoring at data entry.

**3. APEX or OBIEE dashboard**: The scoring results are exposed in a read-only Saved Search, a custom EBS tab (via OAF personalization), or a connected Oracle Analytics Cloud dashboard. Users see anomaly scores, cluster assignments, and demand predictions without any change to EBS transaction processing.

---

## Summary

Oracle EBS is not a passive data warehouse — it is an active transactional system that generates analytical signal with every transaction. The in-database ML capability in Oracle Database eliminates the architectural gap between where the data lives and where the analysis runs.

The five analytical investments with the highest return on EBS data:

1. **GL materialized view + analytic view**: replaces ad-hoc cross-tab reports with sub-second dimensional queries. The setup cost is one materialized view and one SQL analytic view definition.

2. **AP duplicate detection**: prevents duplicate payments. The model trains on historical cancelled-as-duplicate invoices and scores new invoices before they are approved for payment.

3. **AR customer clustering**: segments customers by payment behavior and drives differentiated collections strategies. The model runs monthly and feeds the EBS Collections module.

4. **Inventory demand prediction**: supplements ASCP native forecasting for items with intermittent or causally-driven demand patterns. The predictions load directly into the MSD demand plan.

5. **GL anomaly detection**: flags unusual journal entries for review before period close. The one-class SVM identifies the outer boundary of normal posting behavior and surfaces everything outside it.

The companion runbook covers the full setup procedure for each model: creating the feature tables, configuring the OML model settings, training and evaluating each model, and wiring the predictions back into EBS through concurrent programs, triggers, or dashboard views.`,
};

async function main() {
  console.log('Inserting EBS OLAP/ML blog post...');
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
