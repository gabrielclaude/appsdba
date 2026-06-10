import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Machine Learning: In-Database Analytics Without Moving Your Data',
  slug: 'oracle-machine-learning-overview',
  excerpt:
    'An introduction to Oracle Machine Learning — the in-database ML platform that runs algorithms directly inside Oracle Database 19c and 21c. Covers the OML architecture, the difference between OML4SQL and OML4Py, the available algorithm families, AutoML, and when in-database ML is the right choice over external tools.',
  category: 'oracle-ml' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-11'),
  youtubeUrl: null,
  content: `Most machine learning workflows follow a familiar pattern: extract data from the database, load it into Python or R, train a model, and deploy predictions back to an application. The data movement is expensive, security-sensitive, and operationally complex. Oracle Machine Learning (OML) takes a different approach: run the algorithms where the data already lives — inside the database engine itself.

OML is not a separate ML platform bolted onto Oracle Database. It is a set of SQL functions, PL/SQL packages, and Python/R APIs that invoke parallel, in-kernel ML algorithms on data that never leaves the database. This post covers the architecture, the API layers, the available algorithms, and when OML is the right choice.

---

## The OML Architecture

OML sits inside Oracle Database 19c and 21c (and Autonomous Database). The ML algorithms are implemented as native database operations, executed in the same parallel query engine that processes SQL joins and aggregations.

\`\`\`
┌──────────────────────────────────────────────────────┐
│                  Oracle Database                     │
│                                                      │
│  ┌─────────────┐   ┌─────────────┐  ┌────────────┐  │
│  │  OML4SQL    │   │  OML4Py     │  │  OML4R     │  │
│  │  (SQL/PLSQL)│   │  (Python)   │  │  (R)       │  │
│  └──────┬──────┘   └──────┬──────┘  └─────┬──────┘  │
│         │                 │               │          │
│         └─────────────────┴───────────────┘          │
│                           │                          │
│               ┌───────────▼───────────┐              │
│               │   In-DB ML Engine     │              │
│               │  - Parallel execution │              │
│               │  - Algorithm kernels  │              │
│               │  - Model store (DM$)  │              │
│               └───────────┬───────────┘              │
│                           │                          │
│               ┌───────────▼───────────┐              │
│               │   Database Storage    │              │
│               │  - Training data      │              │
│               │  - Model objects      │              │
│               │  - Predictions (views)│              │
│               └───────────────────────┘              │
└──────────────────────────────────────────────────────┘
         │                        │
   OML Notebooks             REST API / ORDS
   (Browser UI)              (Model serving)
\`\`\`

### Key Components

**OML4SQL** — PL/SQL-based API. Models are built and applied using SQL functions and the \`DBMS_DATA_MINING\` package. Every operation is a SQL statement — creating a model is an INSERT, applying it is a SELECT.

**OML4Py** — Python API (AutoML UI and Notebooks). Uses the same in-database algorithms via a Python interface. Computation happens inside the database; the Python process is just a driver. Supports transparency layer — OML4Py translates pandas/scikit-learn-style calls into parallel in-DB SQL.

**OML4R** — R API, similar pattern to OML4Py. Less commonly used in new deployments.

**OML AutoML** — automated model selection and hyperparameter tuning. Tries multiple algorithm families, ranks them by accuracy, and returns the best model with one API call or UI action.

**OML Notebooks** — Apache Zeppelin-based notebook server (available in Autonomous Database and on-premises via OML Server). Provides an interactive SQL/Python/R notebook environment with visualisation.

**Model Repository** — models are stored as database objects in the \`DM$\` schema namespace. A model is just a database object — it can be exported, imported, versioned, and queried like any other database object.

---

## OML4SQL: Machine Learning in Pure SQL

OML4SQL is the lowest-level OML API. Every ML operation is expressed as a SQL/PLSQL statement.

### Building a Model

\`\`\`sql
-- Create a training settings table
CREATE TABLE churn_model_settings (
    setting_name  VARCHAR2(30),
    setting_value VARCHAR2(4000)
);

INSERT INTO churn_model_settings VALUES
    (DBMS_DATA_MINING.ALGO_NAME,         DBMS_DATA_MINING.ALGO_RANDOM_FOREST);
INSERT INTO churn_model_settings VALUES
    (DBMS_DATA_MINING.PREP_AUTO,         DBMS_DATA_MINING.PREP_AUTO_ON);

COMMIT;

-- Build the model
BEGIN
    DBMS_DATA_MINING.CREATE_MODEL(
        model_name          => 'CHURN_RF_MODEL',
        mining_function     => DBMS_DATA_MINING.CLASSIFICATION,
        data_table_name     => 'CUSTOMER_TRAINING_DATA',
        case_id_column_name => 'CUSTOMER_ID',
        target_column_name  => 'CHURNED',
        settings_table_name => 'churn_model_settings'
    );
END;
/
\`\`\`

The model is stored in the database as an object. Training runs in parallel using Oracle's parallel query infrastructure — large datasets are handled natively.

### Applying a Model: Scoring in SQL

\`\`\`sql
-- Predict churn probability for all active customers
SELECT
    customer_id,
    PREDICTION(churn_rf_model USING *) AS predicted_churn,
    PREDICTION_PROBABILITY(churn_rf_model, 1 USING *) AS churn_probability
FROM active_customers
ORDER BY churn_probability DESC;
\`\`\`

\`PREDICTION()\` and \`PREDICTION_PROBABILITY()\` are SQL functions that apply the stored model to each row. They run in the parallel query engine — the same query that returns predictions can join to other tables, filter by date, aggregate by region.

### Inspect Model Details

\`\`\`sql
-- List all models in the current schema
SELECT model_name, mining_function, algorithm, build_duration
FROM   user_mining_models;

-- Model accuracy metrics
SELECT *
FROM   dm$vchurn_rf_model;   -- DM$V<model_name> is the model detail view

-- Feature importance (which input columns matter most)
SELECT attribute_name, attribute_importance_value
FROM   user_mining_model_attributes
WHERE  model_name = 'CHURN_RF_MODEL'
ORDER BY attribute_importance_value DESC;
\`\`\`

---

## OML Algorithm Families

OML includes a broad set of algorithms across ML task types, all running in-database:

### Classification

| Algorithm | OML Constant | Best For |
|-----------|-------------|---------|
| Random Forest | \`ALGO_RANDOM_FOREST\` | General classification, handles mixed feature types |
| Gradient Boosting | \`ALGO_GRADIENT_BOOSTING\` | High accuracy on tabular data |
| Decision Tree | \`ALGO_DECISION_TREE\` | Interpretable models, compliance use cases |
| Naive Bayes | \`ALGO_NAIVE_BAYES\` | Text classification, sparse features |
| SVM (Support Vector Machine) | \`ALGO_SUPPORT_VECTOR_MACHINES\` | Binary classification, high-dimensional data |
| Neural Network | \`ALGO_NEURAL_NETWORK\` | Complex non-linear patterns |
| Logistic Regression | \`ALGO_GENERALIZED_LINEAR_MODEL\` | Interpretable probability estimates |

### Regression

| Algorithm | OML Constant | Best For |
|-----------|-------------|---------|
| Random Forest | \`ALGO_RANDOM_FOREST\` | Non-linear regression |
| Gradient Boosting | \`ALGO_GRADIENT_BOOSTING\` | Competitive accuracy |
| Linear Regression (GLM) | \`ALGO_GENERALIZED_LINEAR_MODEL\` | Interpretable, regularised |
| SVM | \`ALGO_SUPPORT_VECTOR_MACHINES\` | Numeric prediction |

### Clustering

| Algorithm | OML Constant | Best For |
|-----------|-------------|---------|
| k-Means | \`ALGO_KMEANS\` | Customer segmentation |
| O-Cluster | \`ALGO_O_CLUSTER\` | Large datasets, automatic cluster count |
| Expectation Maximisation | \`ALGO_EXPECTATION_MAXIMIZATION\` | Probabilistic cluster assignments |

### Anomaly Detection

| Algorithm | OML Constant | Best For |
|-----------|-------------|---------|
| One-Class SVM | \`ALGO_SUPPORT_VECTOR_MACHINES\` | Fraud detection, outlier identification |

### Association Rules and Feature Extraction

| Algorithm | Use Case |
|-----------|---------|
| Apriori | Market basket analysis, EBS item co-purchase patterns |
| NMF (Non-Negative Matrix Factorisation) | Topic modelling, latent feature extraction |
| SVD (Singular Value Decomposition) | Dimensionality reduction |
| PCA | Dimensionality reduction, noise removal |

---

## AutoML: Automated Model Selection

OML AutoML automates the algorithm selection and hyperparameter tuning pipeline. It evaluates multiple algorithms and returns the best-performing model for your data and task.

\`\`\`sql
-- OML4SQL AutoML via DBMS_DATA_MINING
DECLARE
    v_set DBMS_DATA_MINING.SETTING_LIST;
BEGIN
    v_set('ALGO_NAME')  := DBMS_DATA_MINING.ALGO_AUTO_MODEL;
    v_set('PREP_AUTO')  := DBMS_DATA_MINING.PREP_AUTO_ON;
    -- Optimise for balanced accuracy
    v_set('AUTOML_ALGORITHM_LIST') :=
        'RANDOM_FOREST,GRADIENT_BOOSTING,DECISION_TREE,NEURAL_NETWORK';

    DBMS_DATA_MINING.CREATE_MODEL2(
        model_name          => 'AUTOML_CHURN_MODEL',
        mining_function     => 'CLASSIFICATION',
        data_query          => 'SELECT * FROM customer_training_data',
        set_list            => v_set,
        case_id_column_name => 'CUSTOMER_ID',
        target_column_name  => 'CHURNED'
    );
END;
/
\`\`\`

In OML4Py and the OML Notebook UI, AutoML provides a guided wizard — select the table, target column, and optimization metric, and OML tries multiple algorithms with cross-validation and returns a leaderboard.

---

## OML4Py: Python Interface to In-Database Algorithms

OML4Py brings the in-database algorithms to Python users. The key distinction from scikit-learn: **computation happens inside Oracle Database, not in the Python process.**

\`\`\`python
import oml

# Connect to the database
oml.connect(user='oml_user', password='<password>', dsn='ebsdb')

# Load a database table as an OML DataFrame (not pulled to Python memory)
customer_df = oml.sync(table='CUSTOMER_TRAINING_DATA', schema='APPS')

# Split training and test
train, test = customer_df.split(ratio=(0.8, 0.2), use_hash=True,
                                 hash_cols=['CUSTOMER_ID'])

# Build a Random Forest classifier — runs in the database
rf = oml.algo.RandomForestClassifier(mining_function='classification',
                                     target='CHURNED',
                                     case_id='CUSTOMER_ID')
rf.fit(train, case_id='CUSTOMER_ID', target='CHURNED')

# Score the test set — SQL executes in the database
predictions = rf.predict(test, supplemental_cols=['CUSTOMER_ID', 'CHURNED'])
print(predictions.head(10))

# Model accuracy
from oml.algo import EvalMetrics
metrics = EvalMetrics(model=rf, test_data=test,
                      target='CHURNED', case_id='CUSTOMER_ID')
print(metrics.get_metrics())
\`\`\`

### Transparency Layer

OML4Py's transparency layer maps Python expressions to SQL. Pandas-style operations on OML DataFrames generate SQL queries — you write Python, the database executes SQL.

\`\`\`python
# This looks like pandas — it executes as SQL in Oracle
high_value = customer_df[customer_df['CLV'] > 5000]
by_region  = high_value.groupby('REGION').agg({'REVENUE': 'sum'})
print(by_region)
\`\`\`

---

## When OML Is the Right Choice

**Use OML when:**
- Your training data is large and already in Oracle Database — avoid the cost and risk of extracting it
- You need predictions scored inline in SQL queries (joining predictions to transactions in real time)
- Compliance or security policy prohibits data leaving the database
- You want to version and manage models as database objects
- You are working in Autonomous Database and want zero infrastructure overhead

**Consider external tools (Python/scikit-learn, TensorFlow) when:**
- Your use case requires deep learning / convolutional neural networks — OML's neural network is a shallow multi-layer perceptron
- Your data is not in Oracle Database (images, audio, unstructured text)
- Your team's primary expertise is Python and external ML tooling
- You need specialised model architectures not available in OML

The companion runbook covers the complete installation of the OML sample schema and walks through hands-on exercises for building and applying classification, regression, and clustering models using OML4SQL and OML4Py.`,
};

async function main() {
  console.log('Inserting Oracle Machine Learning overview blog post...');
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
