import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Clinical MLP Resource Allocation Runbook: Implementation, Training, and Integration',
  slug: 'oracle-clinical-mlp-resource-allocation-runbook',
  excerpt:
    'Step-by-step runbook for implementing a Multi-Layer Perceptron resource allocation model on Oracle Clinical data. Covers schema audit, feature extraction SQL, Python MLP training with Keras, model deployment, Oracle integration via python-oracledb, and the quarterly retraining schedule for DR, Principal Scientist, Medical Monitor, and CRA FTE prediction.',
  category: 'oracle-clinical' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-17'),
  youtubeUrl: null,
  content: `## Phase 1 — Prerequisites and Environment Assessment

### 1.1 Oracle Clinical Version Check

\`\`\`sql
-- Confirm Oracle Clinical version and patch level
SELECT product, version, status
FROM product_component_version
WHERE product LIKE '%Oracle%';

-- Check Oracle Clinical application version
SELECT parameter_name, parameter_value
FROM oc_system_parameters
WHERE parameter_name IN ('OC_VERSION', 'OC_PATCH_LEVEL', 'DB_VERSION');
\`\`\`

Required minimum: Oracle Clinical 5.2.1 or later (for complete adverse event and monitoring visit schema). Oracle Database 19c or later for optimal query performance on the feature extraction aggregations.

### 1.2 Key Table Existence Check

\`\`\`sql
-- Verify all source tables exist and are populated
SELECT table_name,
       num_rows,
       last_analyzed
FROM all_tables
WHERE table_name IN (
  'OC_STUDY_MASTER',
  'OC_STUDY_PHASES',
  'OC_PATIENT_POSITION',
  'OC_SITE',
  'OC_ADVERSE_EVENT',
  'OC_DISCREPANCY',
  'OC_CRF_PAGE',
  'OC_MONITORING_VISIT',
  'OC_PROTOCOL_AMENDMENT',
  'OC_MILESTONES',
  'OC_LAB_DATA',
  'OC_STAFF_ALLOCATION'
)
ORDER BY table_name;
\`\`\`

The \`OC_STAFF_ALLOCATION\` table is the training target. If it does not exist in Oracle Clinical, it must be created as a custom extension table populated from your HR or project management system.

### 1.3 Python Environment Setup

\`\`\`bash
# Create isolated environment
python3 -m venv /opt/oc_mlp/venv
source /opt/oc_mlp/venv/bin/activate

# Install dependencies
pip install \
  python-oracledb==2.4.1 \
  pandas==2.2.2 \
  numpy==1.26.4 \
  scikit-learn==1.5.0 \
  tensorflow==2.17.0 \
  keras==3.3.3 \
  joblib==1.4.2 \
  sqlalchemy==2.0.30 \
  matplotlib==3.9.0

# Verify Oracle Instant Client (required for python-oracledb thick mode)
ls /opt/oracle/instantclient_21_*/
\`\`\`

### 1.4 Oracle Connection Test

\`\`\`python
# /opt/oc_mlp/test_connection.py
import oracledb

oracledb.init_oracle_client(lib_dir="/opt/oracle/instantclient_21_13")

conn = oracledb.connect(
    user="oc_readonly",
    password=os.environ["OC_DB_PASSWORD"],
    dsn="oc-db-host:1521/OCPROD"
)

cursor = conn.cursor()
cursor.execute("SELECT COUNT(*) FROM oc_study_master WHERE study_status = 'ACTIVE'")
row = cursor.fetchone()
print(f"Active studies: {row[0]}")
conn.close()
\`\`\`

Expected output: a non-zero count of active studies. If zero, confirm the \`study_status\` column values against the Oracle Clinical data dictionary for your instance.

---

## Phase 2 — Staging Table Creation

Create the two staging tables that serve as the interface between Oracle Clinical and the Python pipeline:

\`\`\`sql
-- Feature staging table (written by Oracle, read by Python)
CREATE TABLE oc_ml_features_staging (
  study_id              NUMBER(10)     NOT NULL,
  study_name            VARCHAR2(200),
  scoring_month         DATE           DEFAULT TRUNC(SYSDATE, 'MM'),
  phase_encoded         NUMBER(4,2),
  enrollment_pct        NUMBER(5,4),
  enrollment_vel_ratio  NUMBER(6,4),
  active_sites_pct      NUMBER(5,4),
  sae_rate_normalized   NUMBER(8,6),
  query_density         NUMBER(8,6),
  sdv_backlog_pct       NUMBER(5,4),
  amendment_count_log   NUMBER(5,4),
  milestone_urgency     NUMBER(5,4),
  phase_elapsed_pct     NUMBER(5,4),
  lab_flag_rate         NUMBER(5,4),
  extract_timestamp     TIMESTAMP      DEFAULT SYSTIMESTAMP,
  CONSTRAINT pk_oc_ml_features PRIMARY KEY (study_id, scoring_month)
);

-- Allocation predictions table (written by Python, read by BI/reports)
CREATE TABLE oc_ml_allocation_scores (
  study_id                    NUMBER(10)   NOT NULL,
  scoring_month               DATE         NOT NULL,
  dr_fte                      NUMBER(4,2),
  principal_scientist_fte     NUMBER(4,2),
  medical_monitor_fte         NUMBER(4,2),
  cra_fte                     NUMBER(4,2),
  model_version               VARCHAR2(50),
  score_timestamp             TIMESTAMP    DEFAULT SYSTIMESTAMP,
  CONSTRAINT pk_oc_ml_alloc PRIMARY KEY (study_id, scoring_month)
);

-- Historical actuals table (populated from HR/PM system integration)
CREATE TABLE oc_actual_allocations (
  study_id                    NUMBER(10)   NOT NULL,
  allocation_month            DATE         NOT NULL,
  role_code                   VARCHAR2(20) NOT NULL,
  person_id                   NUMBER(10),
  fte_fraction                NUMBER(4,2),
  outcome_quality_score       NUMBER(5,2), -- 0-100 composite from milestone + data quality
  CONSTRAINT pk_oc_actual_alloc PRIMARY KEY (study_id, allocation_month, role_code, person_id)
);

-- Grant Python user access
GRANT INSERT, SELECT ON oc_ml_allocation_scores TO oc_mlp_svc;
GRANT SELECT ON oc_ml_features_staging TO oc_mlp_svc;
GRANT SELECT ON oc_actual_allocations TO oc_mlp_svc;
\`\`\`

---

## Phase 3 — Feature Extraction Procedure

\`\`\`sql
CREATE OR REPLACE PROCEDURE oc_extract_ml_features AS
BEGIN
  -- Clear current month's staging data
  DELETE FROM oc_ml_features_staging
  WHERE scoring_month = TRUNC(SYSDATE, 'MM');

  INSERT INTO oc_ml_features_staging (
    study_id, study_name, scoring_month,
    phase_encoded, enrollment_pct, enrollment_vel_ratio,
    active_sites_pct, sae_rate_normalized, query_density,
    sdv_backlog_pct, amendment_count_log, milestone_urgency,
    phase_elapsed_pct, lab_flag_rate
  )
  SELECT
    s.study_id,
    s.study_name,
    TRUNC(SYSDATE, 'MM') AS scoring_month,

    -- Phase encoding
    CASE sp.phase_code
      WHEN 'I'  THEN 0.25
      WHEN 'II' THEN 0.50
      WHEN 'III' THEN 0.75
      WHEN 'IV' THEN 1.00
      ELSE 0.50
    END AS phase_encoded,

    -- Enrollment completion
    LEAST(
      COUNT(DISTINCT pp.patient_id) / NULLIF(s.target_enrollment, 0),
      1.0
    ) AS enrollment_pct,

    -- Enrollment velocity vs plan
    LEAST(
      (COUNT(DISTINCT pp.patient_id)
        / NULLIF(MONTHS_BETWEEN(SYSDATE, sp.actual_start_date), 0))
        / NULLIF(s.planned_monthly_enrollment, 0),
      2.0
    ) / 2.0 AS enrollment_vel_ratio,  -- normalize 2x plan = 1.0

    -- Active sites fraction
    LEAST(
      SUM(CASE WHEN si.site_status = 'ACTIVE' THEN 1 ELSE 0 END)
        / NULLIF(s.planned_sites, 0),
      1.0
    ) AS active_sites_pct,

    -- SAE rate (log-normalized: log(1 + rate) / log(1 + 50))
    LOG(10, 1 + ROUND(
      (COUNT(DISTINCT ae.ae_id) * 100)
        / NULLIF(SUM(pp.exposure_days) / 365.25, 0), 3))
    / LOG(10, 51) AS sae_rate_normalized,

    -- Query density
    LEAST(
      COUNT(DISTINCT d.discrepancy_id)
        / NULLIF(COUNT(DISTINCT crf.crf_page_id), 0),
      1.0
    ) AS query_density,

    -- SDV backlog
    NVL(
      SUM(CASE WHEN mv.sdv_status = 'PENDING' THEN mv.page_count ELSE 0 END)
        / NULLIF(SUM(mv.page_count), 0),
      0
    ) AS sdv_backlog_pct,

    -- Protocol amendment count (log-normalized over 0-10 range)
    LEAST(LOG(10, 1 + COUNT(DISTINCT pa.amendment_id)) / LOG(10, 11), 1.0)
      AS amendment_count_log,

    -- Milestone urgency: 1.0 = overdue, 0 = 180+ days away
    GREATEST(
      1 - LEAST(MIN(mi.planned_date - SYSDATE), 180) / 180,
      0
    ) AS milestone_urgency,

    -- Phase time elapsed fraction
    LEAST(
      GREATEST(
        (SYSDATE - sp.actual_start_date)
          / NULLIF(sp.planned_end_date - sp.planned_start_date, 0),
        0
      ),
      1.0
    ) AS phase_elapsed_pct,

    -- Lab flag rate
    NVL(
      COUNT(CASE WHEN ld.flag_type IS NOT NULL THEN 1 END)
        / NULLIF(COUNT(ld.lab_result_id), 0),
      0
    ) AS lab_flag_rate

  FROM oc_study_master s
  JOIN oc_study_phases sp
    ON sp.study_id = s.study_id AND sp.is_current = 'Y'
  LEFT JOIN oc_patient_position pp
    ON pp.study_id = s.study_id AND pp.patient_status != 'SCREEN_FAIL'
  LEFT JOIN oc_site si
    ON si.study_id = s.study_id
  LEFT JOIN oc_adverse_event ae
    ON ae.study_id = s.study_id
    AND ae.sae_flag = 'Y'
    AND ae.event_date >= ADD_MONTHS(SYSDATE, -12)
  LEFT JOIN oc_discrepancy d
    ON d.study_id = s.study_id AND d.status = 'OPEN'
  LEFT JOIN oc_crf_page crf
    ON crf.study_id = s.study_id
  LEFT JOIN oc_monitoring_visit mv
    ON mv.study_id = s.study_id
    AND mv.visit_date >= ADD_MONTHS(SYSDATE, -6)
  LEFT JOIN oc_protocol_amendment pa
    ON pa.study_id = s.study_id
  LEFT JOIN oc_milestones mi
    ON mi.study_id = s.study_id
    AND mi.planned_date > SYSDATE
    AND mi.milestone_type IN (
      'REGULATORY_SUBMISSION','DATABASE_LOCK','CSR_COMPLETE','INTERIM_ANALYSIS'
    )
  LEFT JOIN oc_lab_data ld
    ON ld.study_id = s.study_id
    AND ld.result_date >= ADD_MONTHS(SYSDATE, -3)

  WHERE s.study_status = 'ACTIVE'
  GROUP BY
    s.study_id, s.study_name, sp.phase_code,
    sp.actual_start_date, sp.planned_start_date, sp.planned_end_date,
    s.target_enrollment, s.planned_monthly_enrollment, s.planned_sites;

  COMMIT;
  DBMS_OUTPUT.PUT_LINE('Feature extraction complete: ' || SQL%ROWCOUNT || ' studies');

EXCEPTION
  WHEN OTHERS THEN
    ROLLBACK;
    RAISE;
END oc_extract_ml_features;
/
\`\`\`

Schedule monthly execution:

\`\`\`sql
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'OC_ML_FEATURE_EXTRACT_MONTHLY',
    job_type        => 'STORED_PROCEDURE',
    job_action      => 'OC_EXTRACT_ML_FEATURES',
    start_date      => TRUNC(ADD_MONTHS(SYSDATE, 1), 'MM') + INTERVAL '2' HOUR,
    repeat_interval => 'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=2;BYMINUTE=0',
    enabled         => TRUE,
    comments        => 'Monthly Oracle Clinical ML feature extraction'
  );
END;
/
\`\`\`

---

## Phase 4 — Training Data Preparation

\`\`\`python
# /opt/oc_mlp/prepare_training_data.py
import oracledb
import pandas as pd
import numpy as np
from sklearn.preprocessing import MinMaxScaler
import joblib
import os

oracledb.init_oracle_client(lib_dir="/opt/oracle/instantclient_21_13")

FEATURE_COLS = [
    'phase_encoded', 'enrollment_pct', 'enrollment_vel_ratio',
    'active_sites_pct', 'sae_rate_normalized', 'query_density',
    'sdv_backlog_pct', 'amendment_count_log', 'milestone_urgency',
    'phase_elapsed_pct', 'lab_flag_rate'
]

TARGET_COLS = [
    'dr_fte', 'principal_scientist_fte', 'medical_monitor_fte', 'cra_fte'
]

TRAINING_QUERY = """
SELECT
    f.study_id,
    f.scoring_month,
    f.phase_encoded,
    f.enrollment_pct,
    f.enrollment_vel_ratio,
    f.active_sites_pct,
    f.sae_rate_normalized,
    f.query_density,
    f.sdv_backlog_pct,
    f.amendment_count_log,
    f.milestone_urgency,
    f.phase_elapsed_pct,
    f.lab_flag_rate,
    -- Aggregate actual allocations per role per month
    SUM(CASE WHEN a.role_code = 'DR' THEN a.fte_fraction ELSE 0 END) AS dr_fte,
    SUM(CASE WHEN a.role_code = 'PS' THEN a.fte_fraction ELSE 0 END) AS principal_scientist_fte,
    SUM(CASE WHEN a.role_code = 'MM' THEN a.fte_fraction ELSE 0 END) AS medical_monitor_fte,
    SUM(CASE WHEN a.role_code = 'CRA' THEN a.fte_fraction ELSE 0 END) AS cra_fte,
    -- Outcome quality weight: higher weight = better outcome = preferred allocation pattern
    AVG(a.outcome_quality_score) / 100.0 AS quality_weight
FROM oc_ml_features_staging f
JOIN oc_actual_allocations a
  ON a.study_id = f.study_id
  AND TRUNC(a.allocation_month, 'MM') = f.scoring_month
WHERE f.scoring_month < TRUNC(SYSDATE, 'MM')  -- exclude current month
GROUP BY
    f.study_id, f.scoring_month,
    f.phase_encoded, f.enrollment_pct, f.enrollment_vel_ratio,
    f.active_sites_pct, f.sae_rate_normalized, f.query_density,
    f.sdv_backlog_pct, f.amendment_count_log, f.milestone_urgency,
    f.phase_elapsed_pct, f.lab_flag_rate
HAVING SUM(CASE WHEN a.role_code = 'DR' THEN a.fte_fraction ELSE 0 END) > 0
"""

def load_training_data(conn):
    df = pd.read_sql(TRAINING_QUERY, conn)
    df.columns = df.columns.str.lower()

    # Clip allocation targets to [0, 1] for DR/PS/MM; CRA can exceed 1.0
    # so we normalize CRA by dividing by max observed (typically 4-5 FTE)
    df['cra_fte'] = df['cra_fte'] / 5.0
    for col in ['dr_fte', 'principal_scientist_fte', 'medical_monitor_fte', 'cra_fte']:
        df[col] = df[col].clip(0.0, 1.0)

    # Drop rows with any NaN in features or targets
    df = df.dropna(subset=FEATURE_COLS + TARGET_COLS)

    print(f"Training samples: {len(df)}")
    print(f"Studies covered: {df['study_id'].nunique()}")
    print(f"Date range: {df['scoring_month'].min()} to {df['scoring_month'].max()}")
    return df

def prepare_features(df, scaler=None, fit=True):
    X = df[FEATURE_COLS].values.astype(np.float32)
    y = df[TARGET_COLS].values.astype(np.float32)
    weights = df['quality_weight'].values.astype(np.float32) if 'quality_weight' in df.columns else None

    if fit:
        scaler = MinMaxScaler(feature_range=(0, 1))
        X = scaler.fit_transform(X)
        joblib.dump(scaler, '/opt/oc_mlp/models/feature_scaler.pkl')
    else:
        X = scaler.transform(X)

    return X, y, weights, scaler

if __name__ == '__main__':
    conn = oracledb.connect(
        user="oc_readonly",
        password=os.environ["OC_DB_PASSWORD"],
        dsn="oc-db-host:1521/OCPROD"
    )
    df = load_training_data(conn)
    conn.close()
    df.to_parquet('/opt/oc_mlp/data/training_data.parquet', index=False)
    print("Training data saved.")
\`\`\`

---

## Phase 5 — MLP Model Training

\`\`\`python
# /opt/oc_mlp/train_model.py
import numpy as np
import pandas as pd
import joblib
import os
import json
from datetime import datetime
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error
import tensorflow as tf
from tensorflow import keras
from tensorflow.keras import layers, callbacks

FEATURE_COLS = [
    'phase_encoded', 'enrollment_pct', 'enrollment_vel_ratio',
    'active_sites_pct', 'sae_rate_normalized', 'query_density',
    'sdv_backlog_pct', 'amendment_count_log', 'milestone_urgency',
    'phase_elapsed_pct', 'lab_flag_rate'
]

TARGET_COLS = [
    'dr_fte', 'principal_scientist_fte', 'medical_monitor_fte', 'cra_fte'
]

MODEL_DIR = '/opt/oc_mlp/models'
os.makedirs(MODEL_DIR, exist_ok=True)

def build_mlp(input_dim: int = 11, output_dim: int = 4) -> keras.Model:
    inputs = keras.Input(shape=(input_dim,), name='features')

    x = layers.Dense(64, activation='relu', name='hidden_1')(inputs)
    x = layers.Dropout(0.20, name='dropout_1')(x)

    x = layers.Dense(32, activation='relu', name='hidden_2')(x)
    x = layers.Dropout(0.20, name='dropout_2')(x)

    x = layers.Dense(16, activation='relu', name='hidden_3')(x)

    outputs = layers.Dense(output_dim, activation='sigmoid', name='allocation')(x)

    model = keras.Model(inputs=inputs, outputs=outputs, name='oc_resource_mlp')
    model.compile(
        optimizer=keras.optimizers.Adam(learning_rate=1e-3),
        loss='mae',
        metrics=['mae']
    )
    return model

def train(parquet_path: str):
    df = pd.read_parquet(parquet_path)

    scaler = joblib.load(f'{MODEL_DIR}/feature_scaler.pkl')
    X = scaler.transform(df[FEATURE_COLS].values.astype(np.float32))
    y = df[TARGET_COLS].values.astype(np.float32)
    w = df['quality_weight'].values.astype(np.float32)

    X_train, X_val, y_train, y_val, w_train, w_val = train_test_split(
        X, y, w, test_size=0.15, random_state=42
    )

    model = build_mlp()
    model.summary()

    training_callbacks = [
        callbacks.EarlyStopping(
            monitor='val_loss',
            patience=25,
            restore_best_weights=True
        ),
        callbacks.ReduceLROnPlateau(
            monitor='val_loss',
            factor=0.5,
            patience=10,
            min_lr=1e-5
        ),
        callbacks.ModelCheckpoint(
            filepath=f'{MODEL_DIR}/oc_mlp_best.keras',
            monitor='val_loss',
            save_best_only=True
        )
    ]

    history = model.fit(
        X_train, y_train,
        sample_weight=w_train,
        validation_data=(X_val, y_val, w_val),
        epochs=300,
        batch_size=32,
        callbacks=training_callbacks,
        verbose=1
    )

    # Evaluate per-role MAE on validation set
    y_pred = model.predict(X_val)
    for i, role in enumerate(TARGET_COLS):
        mae = mean_absolute_error(y_val[:, i], y_pred[:, i])
        print(f"{role} MAE: {mae:.4f} FTE")

    # Save final model
    model_version = datetime.now().strftime('%Y%m%d_%H%M')
    model.save(f'{MODEL_DIR}/oc_mlp_{model_version}.keras')
    model.save(f'{MODEL_DIR}/oc_mlp_current.keras')  # symlink-style overwrite

    # Save metadata
    meta = {
        'model_version': model_version,
        'feature_cols': FEATURE_COLS,
        'target_cols': TARGET_COLS,
        'training_samples': int(len(X_train)),
        'val_mae': {
            role: float(mean_absolute_error(y_val[:, i], y_pred[:, i]))
            for i, role in enumerate(TARGET_COLS)
        },
        'cra_fte_scale_factor': 5.0  # CRA was divided by 5 during prep
    }
    with open(f'{MODEL_DIR}/model_meta_{model_version}.json', 'w') as f:
        json.dump(meta, f, indent=2)

    print(f"Model saved: oc_mlp_{model_version}.keras")
    return model, model_version

if __name__ == '__main__':
    train('/opt/oc_mlp/data/training_data.parquet')
\`\`\`

**Expected validation MAE targets:**

| Role | Acceptable MAE | Action if Exceeded |
|------|---------------|-------------------|
| DR | ≤ 0.08 FTE | Review SAE rate feature normalization |
| Principal Scientist | ≤ 0.10 FTE | Check amendment_count_log distribution |
| Medical Monitor | ≤ 0.07 FTE | Verify lab_flag_rate completeness |
| CRA | ≤ 0.12 FTE (of 5-FTE scale) | Review SDV backlog data quality |

---

## Phase 6 — Scoring Pipeline

\`\`\`python
# /opt/oc_mlp/score_current_month.py
import oracledb
import pandas as pd
import numpy as np
import joblib
import json
import os
from datetime import datetime
from tensorflow import keras

MODEL_DIR = '/opt/oc_mlp/models'

FEATURE_COLS = [
    'phase_encoded', 'enrollment_pct', 'enrollment_vel_ratio',
    'active_sites_pct', 'sae_rate_normalized', 'query_density',
    'sdv_backlog_pct', 'amendment_count_log', 'milestone_urgency',
    'phase_elapsed_pct', 'lab_flag_rate'
]

SCORE_QUERY = """
SELECT study_id, study_name,
       phase_encoded, enrollment_pct, enrollment_vel_ratio,
       active_sites_pct, sae_rate_normalized, query_density,
       sdv_backlog_pct, amendment_count_log, milestone_urgency,
       phase_elapsed_pct, lab_flag_rate
FROM oc_ml_features_staging
WHERE scoring_month = TRUNC(SYSDATE, 'MM')
"""

def score_and_write(conn):
    with open(f'{MODEL_DIR}/model_meta_current.json') as f:
        meta = json.load(f)

    model = keras.models.load_model(f'{MODEL_DIR}/oc_mlp_current.keras')
    scaler = joblib.load(f'{MODEL_DIR}/feature_scaler.pkl')
    cra_scale = meta.get('cra_fte_scale_factor', 5.0)

    df = pd.read_sql(SCORE_QUERY, conn)
    df.columns = df.columns.str.lower()

    if df.empty:
        print("No features available for current month — run OC_EXTRACT_ML_FEATURES first.")
        return

    X = scaler.transform(df[FEATURE_COLS].values.astype(np.float32))
    predictions = model.predict(X)

    # Reverse CRA normalization
    predictions[:, 3] *= cra_scale

    cursor = conn.cursor()
    cursor.execute(
        "DELETE FROM oc_ml_allocation_scores WHERE scoring_month = TRUNC(SYSDATE, 'MM')"
    )

    insert_sql = """
        INSERT INTO oc_ml_allocation_scores
          (study_id, scoring_month, dr_fte, principal_scientist_fte,
           medical_monitor_fte, cra_fte, model_version)
        VALUES (:study_id, TRUNC(SYSDATE,'MM'), :dr_fte, :ps_fte, :mm_fte, :cra_fte, :ver)
    """

    rows = []
    for idx, row in df.iterrows():
        pred = predictions[idx]
        rows.append({
            'study_id': int(row['study_id']),
            'dr_fte':   round(float(pred[0]), 2),
            'ps_fte':   round(float(pred[1]), 2),
            'mm_fte':   round(float(pred[2]), 2),
            'cra_fte':  round(float(pred[3]), 2),
            'ver':      meta['model_version']
        })

    cursor.executemany(insert_sql, rows)
    conn.commit()
    print(f"Scored {len(rows)} studies for {datetime.now().strftime('%Y-%m')}")
    cursor.close()

if __name__ == '__main__':
    conn = oracledb.connect(
        user="oc_mlp_svc",
        password=os.environ["OC_MLP_SVC_PASSWORD"],
        dsn="oc-db-host:1521/OCPROD"
    )
    score_and_write(conn)
    conn.close()
\`\`\`

---

## Phase 7 — Portfolio Capacity View

\`\`\`sql
-- Portfolio demand vs capacity view
CREATE OR REPLACE VIEW oc_ml_portfolio_capacity AS
WITH current_scores AS (
  SELECT
    s.study_id,
    s.study_name,
    sp.phase_code,
    a.dr_fte,
    a.principal_scientist_fte AS ps_fte,
    a.medical_monitor_fte    AS mm_fte,
    a.cra_fte,
    a.model_version,
    a.scoring_month
  FROM oc_ml_allocation_scores a
  JOIN oc_study_master s ON s.study_id = a.study_id
  JOIN oc_study_phases sp ON sp.study_id = s.study_id AND sp.is_current = 'Y'
  WHERE a.scoring_month = TRUNC(SYSDATE, 'MM')
),
totals AS (
  SELECT
    SUM(dr_fte) AS total_dr_demand,
    SUM(ps_fte) AS total_ps_demand,
    SUM(mm_fte) AS total_mm_demand,
    SUM(cra_fte) AS total_cra_demand
  FROM current_scores
),
capacity AS (
  SELECT
    SUM(CASE WHEN role_code = 'DR' THEN available_fte ELSE 0 END) AS dr_capacity,
    SUM(CASE WHEN role_code = 'PS' THEN available_fte ELSE 0 END) AS ps_capacity,
    SUM(CASE WHEN role_code = 'MM' THEN available_fte ELSE 0 END) AS mm_capacity,
    SUM(CASE WHEN role_code = 'CRA' THEN available_fte ELSE 0 END) AS cra_capacity
  FROM oc_staff_capacity
  WHERE capacity_month = TRUNC(SYSDATE, 'MM')
)
SELECT
  c.study_id,
  c.study_name,
  c.phase_code,
  c.dr_fte,
  c.ps_fte,
  c.mm_fte,
  c.cra_fte,
  -- Portfolio-level utilization (same for all rows, used in rollup reports)
  ROUND(t.total_dr_demand  / NULLIF(cap.dr_capacity,  0) * 100, 1) AS dr_util_pct,
  ROUND(t.total_ps_demand  / NULLIF(cap.ps_capacity,  0) * 100, 1) AS ps_util_pct,
  ROUND(t.total_mm_demand  / NULLIF(cap.mm_capacity,  0) * 100, 1) AS mm_util_pct,
  ROUND(t.total_cra_demand / NULLIF(cap.cra_capacity, 0) * 100, 1) AS cra_util_pct,
  CASE WHEN t.total_mm_demand / NULLIF(cap.mm_capacity, 0) > 0.85 THEN 'ALERT' ELSE 'OK' END AS mm_status,
  CASE WHEN t.total_cra_demand / NULLIF(cap.cra_capacity, 0) > 0.90 THEN 'ALERT' ELSE 'OK' END AS cra_status,
  c.scoring_month,
  c.model_version
FROM current_scores c
CROSS JOIN totals t
CROSS JOIN capacity cap
ORDER BY c.cra_fte DESC;
\`\`\`

---

## Phase 8 — Monthly Orchestration Script

\`\`\`bash
#!/bin/bash
# /opt/oc_mlp/run_monthly_scoring.sh
set -euo pipefail

LOG_DIR="/opt/oc_mlp/logs"
LOG_FILE="\${LOG_DIR}/scoring_$(date +%Y%m).log"
VENV="/opt/oc_mlp/venv/bin/activate"

exec > >(tee -a "\${LOG_FILE}") 2>&1

echo "=== OC MLP Monthly Scoring: $(date) ==="

# Step 1: Trigger Oracle feature extraction
echo "Step 1: Feature extraction..."
sqlplus -S oc_readonly/"\${OC_DB_PASSWORD}"@oc-db-host:1521/OCPROD <<SQL
SET SERVEROUTPUT ON SIZE 1000000
EXEC OC_EXTRACT_ML_FEATURES;
EXIT;
SQL

# Step 2: Score current month
echo "Step 2: MLP scoring..."
source "\${VENV}"
python /opt/oc_mlp/score_current_month.py

# Step 3: Log portfolio summary
echo "Step 3: Portfolio summary..."
sqlplus -S oc_readonly/"\${OC_DB_PASSWORD}"@oc-db-host:1521/OCPROD <<SQL
SET LINESIZE 120 PAGESIZE 50
SELECT study_name, phase_code,
       dr_fte, ps_fte, mm_fte, cra_fte,
       mm_status, cra_status
FROM oc_ml_portfolio_capacity
ORDER BY cra_fte DESC;
EXIT;
SQL

echo "=== Scoring complete: $(date) ==="
\`\`\`

Schedule via cron on the Oracle Clinical application server:

\`\`\`bash
# Run on the 2nd of each month at 03:00 (after Oracle scheduler extracts on the 1st)
0 3 2 * * /opt/oc_mlp/run_monthly_scoring.sh
\`\`\`

---

## Phase 9 — Model Monitoring and Retraining

### Drift Detection Query

Run after each scoring cycle to compare predicted allocations to actuals from the prior month:

\`\`\`sql
-- Model drift report: compare predictions to actual allocations (prior month)
SELECT
  a.role_code,
  COUNT(*)                                       AS study_months,
  ROUND(AVG(ABS(
    CASE a.role_code
      WHEN 'DR'  THEN s.dr_fte
      WHEN 'PS'  THEN s.principal_scientist_fte
      WHEN 'MM'  THEN s.medical_monitor_fte
      WHEN 'CRA' THEN s.cra_fte / 5.0  -- re-normalize for comparison
    END - a.fte_fraction
  )), 4)                                         AS mean_abs_error,
  ROUND(STDDEV(ABS(
    CASE a.role_code
      WHEN 'DR'  THEN s.dr_fte
      WHEN 'PS'  THEN s.principal_scientist_fte
      WHEN 'MM'  THEN s.medical_monitor_fte
      WHEN 'CRA' THEN s.cra_fte / 5.0
    END - a.fte_fraction
  )), 4)                                         AS std_abs_error

FROM oc_ml_allocation_scores s
JOIN oc_actual_allocations a
  ON a.study_id = s.study_id
  AND TRUNC(a.allocation_month, 'MM') = s.scoring_month
WHERE s.scoring_month >= ADD_MONTHS(TRUNC(SYSDATE, 'MM'), -3)
GROUP BY a.role_code
ORDER BY a.role_code;
\`\`\`

**Retraining triggers:**
- Any role MAE > 0.15 FTE for two consecutive months
- Portfolio composition changes by > 20% (new therapeutic area, major study exits)
- Quarterly cadence regardless of drift metrics (minimum retraining schedule)

### Quarterly Retraining Procedure

\`\`\`bash
# On the first Saturday of each quarter
source /opt/oc_mlp/venv/bin/activate

# 1. Rebuild training dataset with latest actuals
python /opt/oc_mlp/prepare_training_data.py

# 2. Train new model version
python /opt/oc_mlp/train_model.py

# 3. Validate: new model must beat prior model MAE by >= 0.01 FTE on holdout
python /opt/oc_mlp/validate_model.py --compare-to-current

# 4. If validation passes, promote new model
cp /opt/oc_mlp/models/oc_mlp_best.keras /opt/oc_mlp/models/oc_mlp_current.keras
\`\`\`

---

## Phase 10 — Validation Matrix

| Check | Command / Query | Pass Criterion |
|-------|----------------|----------------|
| Feature extraction row count | \`SELECT COUNT(*) FROM oc_ml_features_staging WHERE scoring_month = TRUNC(SYSDATE,'MM')\` | Matches active study count |
| Null feature check | \`SELECT COUNT(*) FROM oc_ml_features_staging WHERE phase_encoded IS NULL\` | 0 |
| Score row count | \`SELECT COUNT(*) FROM oc_ml_allocation_scores WHERE scoring_month = TRUNC(SYSDATE,'MM')\` | Equals feature staging count |
| CRA FTE range | \`SELECT MIN(cra_fte), MAX(cra_fte) FROM oc_ml_allocation_scores WHERE scoring_month = TRUNC(SYSDATE,'MM')\` | MIN >= 0, MAX <= 5.0 |
| DR FTE range | \`SELECT MIN(dr_fte), MAX(dr_fte) FROM oc_ml_allocation_scores WHERE scoring_month = TRUNC(SYSDATE,'MM')\` | Between 0.0 and 1.0 |
| Portfolio utilization | \`SELECT mm_util_pct FROM oc_ml_portfolio_capacity WHERE ROWNUM = 1\` | Non-null, between 0 and 200 |
| Drift MAE (DR) | Drift detection query above | < 0.15 FTE |
| Drift MAE (CRA) | Drift detection query above | < 0.15 FTE (of 5-FTE scale) |
| Model metadata exists | \`ls -la /opt/oc_mlp/models/model_meta_current.json\` | File exists, modified this quarter |
| Scaler file exists | \`ls -la /opt/oc_mlp/models/feature_scaler.pkl\` | File exists |`,
};

async function main() {
  console.log('Inserting Oracle Clinical MLP runbook...');
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
