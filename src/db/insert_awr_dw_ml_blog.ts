import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Building an AWR Data Warehouse in PostgreSQL with Python ML SQL Performance Analysis',
  slug: 'oracle-awr-data-warehouse-postgresql-python-ml',
  excerpt:
    'A technical guide to extracting Oracle AWR data with Data Pump and Python, loading it into a PostgreSQL star schema data warehouse, and applying Python machine learning — regression, clustering, and anomaly detection — to analyse SQL ID performance trends, detect execution plan regressions, and predict future resource consumption.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-15'),
  youtubeUrl: null,
  content: `Oracle's Automatic Workload Repository (AWR) is one of the richest performance data sources in enterprise software — snapshots of every significant SQL execution, system statistic, and wait event taken every 60 minutes (by default) and retained for 8 days (by default). The problem is that 8 days is almost never enough for trend analysis, the data is locked inside SYSAUX on the Oracle instance you are monitoring, and Oracle's own AWR reporting tools produce static HTML — not the dynamic, cross-time, cross-database views that a DBA actually needs to answer questions like:

- Which SQL IDs have degraded over the last 6 months?
- Do specific queries perform worse on certain days of the week or at specific times?
- Which queries are outliers — consuming disproportionate CPU relative to their peer group?
- Can we predict which SQL IDs will become problems next week based on current trends?

The answer is to extract AWR data, move it to a PostgreSQL data warehouse with a proper star schema, and apply Python machine learning algorithms against the structured fact table. This post covers the complete architecture: extraction, schema design, ETL pipeline, and ML analysis.

---

## AWR Data Model: What We Extract

AWR stores performance data in two layers:
- **\`DBA_HIST_*\` views** — the queryable interface (what we read)
- **\`WRH\$_*\` tables** — the underlying physical tables in SYS (what Data Pump accesses)

The tables relevant to SQL performance analysis:

| View | Physical Table | Key Data |
|------|---------------|---------|
| \`DBA_HIST_SNAPSHOT\` | \`WRH\$_SNAPSHOT\` | Snapshot time boundaries, instance info |
| \`DBA_HIST_SQLSTAT\` | \`WRH\$_SQLSTAT\` | Per-SQL execution statistics per snapshot (delta values) |
| \`DBA_HIST_SQLTEXT\` | \`WRH\$_SQLTEXT\` | Full SQL text for each sql_id |
| \`DBA_HIST_SQL_PLAN\` | \`WRH\$_SQL_PLAN\` | Execution plan steps with cost/cardinality estimates |
| \`DBA_HIST_SYSSTAT\` | \`WRH\$_SYSSTAT\` | Instance-level system statistics per snapshot |
| \`DBA_HIST_SYS_TIME_MODEL\` | \`WRH\$_SYS_TIME_MODEL\` | DB time breakdown (CPU, parse, etc.) |
| \`DBA_HIST_ACTIVE_SESS_HISTORY\` | \`WRH\$_ACTIVE_SESSION_HISTORY\` | Sampled ASH data (1-in-10 sample of V\$ACTIVE_SESSION_HISTORY) |

The \`SQLSTAT\` table is the fact source — it contains the cumulative delta of every tracked SQL metric between consecutive snapshots: executions, elapsed time, CPU time, disk reads, buffer gets, rows processed. Everything else is dimensional context.

---

## Extraction Strategy: Data Pump + Python

There are two complementary extraction paths:

### Path 1 — Oracle Data Pump (Full Historical Extract)

Data Pump can export the physical \`WRH\$_*\` tables into a portable dump file. This is the right approach for a one-time historical backfill — extracting months or years of AWR data that would be expensive to pull row-by-row over a network connection.

\`\`\`bash
# Export specific AWR tables from SYS schema:
expdp system/<password> \\
  DIRECTORY=DATA_PUMP_DIR \\
  DUMPFILE=awr_extract_%U.dmp \\
  LOGFILE=awr_extract.log \\
  SCHEMAS=SYS \\
  INCLUDE=TABLE:"IN ('WRH\$_SNAPSHOT','WRH\$_SQLSTAT','WRH\$_SQLTEXT','WRH\$_SQL_PLAN','WRH\$_SYSSTAT','WRH\$_SYS_TIME_MODEL')" \\
  QUERY=WRH\$_SNAPSHOT:'"WHERE BEGIN_INTERVAL_TIME > SYSDATE - 365"' \\
  PARALLEL=4 \\
  COMPRESSION=ALL
\`\`\`

The dump file is Oracle-proprietary format — it cannot be read directly by PostgreSQL. The workflow for using it:

\`\`\`
expdp → .dmp file
              │
              ▼
     impdp into staging schema
     (separate Oracle DB or same DB)
              │
              ▼
     Query staging schema via Python
     (python-oracledb)
              │
              ▼
     Transform + load into PostgreSQL
     (psycopg2 / SQLAlchemy)
\`\`\`

Alternatively, export to delimited flat files using Oracle's external table unload pattern (see runbook Phase 2 for exact steps).

### Path 2 — Python Direct Extraction (Incremental Loads)

For ongoing incremental loads (daily or hourly), Python with \`python-oracledb\` queries \`DBA_HIST_*\` views directly and writes to PostgreSQL — no intermediate dump file needed.

\`\`\`python
import oracledb
import psycopg2
from datetime import datetime, timedelta

# Connect to Oracle (Thin mode — no Oracle client required):
ora_conn = oracledb.connect(
    user="system",
    password=ORA_PASSWORD,
    dsn="host:1521/ORCL"
)

# Connect to PostgreSQL:
pg_conn = psycopg2.connect(DSN=PG_DSN)

# Extract last 24h of snapshots not yet loaded:
SQLSTAT_QUERY = """
SELECT
    s.snap_id,
    s.dbid,
    s.instance_number,
    sn.begin_interval_time,
    sn.end_interval_time,
    s.sql_id,
    s.plan_hash_value,
    s.executions_delta,
    s.elapsed_time_delta,
    s.cpu_time_delta,
    s.disk_reads_delta,
    s.buffer_gets_delta,
    s.rows_processed_delta,
    s.parse_calls_delta,
    s.iowait_delta,
    s.clwait_delta,
    s.apwait_delta,
    s.ccwait_delta
FROM dba_hist_sqlstat s
JOIN dba_hist_snapshot sn
  ON sn.snap_id = s.snap_id
  AND sn.dbid   = s.dbid
  AND sn.instance_number = s.instance_number
WHERE sn.begin_interval_time > :since
  AND s.executions_delta > 0
ORDER BY sn.begin_interval_time, s.sql_id
"""
\`\`\`

---

## PostgreSQL Star Schema Design

The warehouse has a classic star schema: one central fact table recording SQL performance metrics per snapshot, surrounded by dimension tables that provide context for slicing and filtering.

\`\`\`
                    dim_snapshot
                    (time dimension)
                         │
                         │ snapshot_sk
dim_database ────────────┼──────────── dim_sql
(source DB info)         │             (SQL text, command type)
                         ▼
                  fact_sql_performance
                  (one row per sql_id
                   per snapshot)
                         │
                         │ plan_hash_sk
                    dim_plan_hash
                    (execution plan identity)
\`\`\`

### Schema DDL

\`\`\`sql
-- Time / snapshot dimension
CREATE TABLE dim_snapshot (
  snapshot_sk       SERIAL PRIMARY KEY,
  snap_id           INTEGER NOT NULL,
  dbid              BIGINT  NOT NULL,
  instance_number   SMALLINT NOT NULL,
  begin_time        TIMESTAMPTZ NOT NULL,
  end_time          TIMESTAMPTZ NOT NULL,
  interval_minutes  INTEGER,
  hour_of_day       SMALLINT,      -- 0-23
  day_of_week       SMALLINT,      -- 1=Mon … 7=Sun
  week_of_year      SMALLINT,
  month             SMALLINT,
  year              SMALLINT,
  is_business_hours BOOLEAN,       -- Mon-Fri 08:00-18:00
  UNIQUE (snap_id, dbid, instance_number)
);

-- Source database dimension
CREATE TABLE dim_database (
  db_sk           SERIAL PRIMARY KEY,
  dbid            BIGINT  NOT NULL UNIQUE,
  db_name         VARCHAR(9),
  instance_number SMALLINT,
  host_name       VARCHAR(128),
  platform_name   VARCHAR(101),
  db_version      VARCHAR(17)
);

-- SQL text dimension
CREATE TABLE dim_sql (
  sql_sk        SERIAL PRIMARY KEY,
  sql_id        VARCHAR(13) NOT NULL,
  dbid          BIGINT      NOT NULL,
  sql_text      TEXT,
  sql_text_short VARCHAR(200),   -- first 200 chars for display
  command_type  SMALLINT,
  command_name  VARCHAR(30),     -- SELECT / INSERT / UPDATE / DELETE / PL/SQL
  module        VARCHAR(64),
  action        VARCHAR(64),
  UNIQUE (sql_id, dbid)
);

-- Plan hash dimension (one row per unique plan)
CREATE TABLE dim_plan_hash (
  plan_hash_sk    SERIAL PRIMARY KEY,
  sql_id          VARCHAR(13) NOT NULL,
  dbid            BIGINT      NOT NULL,
  plan_hash_value BIGINT      NOT NULL,
  plan_captured_at TIMESTAMPTZ,
  -- Aggregated plan attributes from DBA_HIST_SQL_PLAN:
  total_cost      NUMERIC,
  total_rows      BIGINT,
  plan_steps      INTEGER,
  has_full_scan   BOOLEAN,
  has_sort        BOOLEAN,
  has_hash_join   BOOLEAN,
  has_nested_loop BOOLEAN,
  plan_text       TEXT,          -- full plan as formatted text
  UNIQUE (sql_id, dbid, plan_hash_value)
);

-- Central fact table
CREATE TABLE fact_sql_performance (
  fact_sk             BIGSERIAL PRIMARY KEY,
  snapshot_sk         INTEGER NOT NULL REFERENCES dim_snapshot(snapshot_sk),
  sql_sk              INTEGER NOT NULL REFERENCES dim_sql(sql_sk),
  db_sk               INTEGER NOT NULL REFERENCES dim_database(db_sk),
  plan_hash_sk        INTEGER REFERENCES dim_plan_hash(plan_hash_sk),

  -- Raw delta metrics (between consecutive snapshots):
  executions          BIGINT  DEFAULT 0,
  elapsed_time_us     BIGINT  DEFAULT 0,   -- microseconds total
  cpu_time_us         BIGINT  DEFAULT 0,
  disk_reads          BIGINT  DEFAULT 0,
  buffer_gets         BIGINT  DEFAULT 0,
  rows_processed      BIGINT  DEFAULT 0,
  parse_calls         BIGINT  DEFAULT 0,
  iowait_us           BIGINT  DEFAULT 0,
  clwait_us           BIGINT  DEFAULT 0,   -- cluster wait (RAC)
  apwait_us           BIGINT  DEFAULT 0,   -- application wait
  ccwait_us           BIGINT  DEFAULT 0,   -- concurrency wait

  -- Per-execution derived metrics (computed on load):
  elapsed_ms_per_exec NUMERIC(12,3),
  cpu_ms_per_exec     NUMERIC(12,3),
  disk_reads_per_exec NUMERIC(10,2),
  buffer_gets_per_exec NUMERIC(12,2),
  rows_per_exec       NUMERIC(12,2),
  cpu_ratio           NUMERIC(5,4),        -- cpu_time / elapsed_time (efficiency)
  io_ratio            NUMERIC(5,4),        -- iowait / elapsed_time

  -- Plan change flag:
  plan_changed        BOOLEAN DEFAULT FALSE,

  UNIQUE (snapshot_sk, sql_sk)
);

-- Aggregate support table (pre-aggregated hourly for ML feature engineering):
CREATE TABLE agg_sql_hourly (
  agg_sk              BIGSERIAL PRIMARY KEY,
  sql_sk              INTEGER NOT NULL REFERENCES dim_sql(sql_sk),
  db_sk               INTEGER NOT NULL REFERENCES dim_database(db_sk),
  hour_bucket         TIMESTAMPTZ NOT NULL,   -- truncated to hour
  snapshot_count      INTEGER,
  total_executions    BIGINT,
  avg_elapsed_ms      NUMERIC(12,3),
  p50_elapsed_ms      NUMERIC(12,3),
  p95_elapsed_ms      NUMERIC(12,3),
  p99_elapsed_ms      NUMERIC(12,3),
  max_elapsed_ms      NUMERIC(12,3),
  total_buffer_gets   BIGINT,
  total_disk_reads    BIGINT,
  plan_changes        INTEGER,               -- plan flips in this hour
  UNIQUE (sql_sk, db_sk, hour_bucket)
);

-- Indexes for analytical queries:
CREATE INDEX ON fact_sql_performance (snapshot_sk);
CREATE INDEX ON fact_sql_performance (sql_sk);
CREATE INDEX ON fact_sql_performance (db_sk);
CREATE INDEX ON dim_snapshot (begin_time);
CREATE INDEX ON dim_snapshot (hour_of_day, day_of_week);
CREATE INDEX ON agg_sql_hourly (sql_sk, hour_bucket);
\`\`\`

---

## ETL Pipeline

The ETL runs in three stages: extract from Oracle, transform into star schema keys, load into PostgreSQL fact and dimension tables.

\`\`\`python
# etl/pipeline.py — core extraction and load logic

import oracledb
import psycopg2
import psycopg2.extras
from datetime import datetime, timezone

class AWRExtractor:
    def __init__(self, ora_dsn: str, ora_user: str, ora_pwd: str,
                 pg_dsn: str, dbid: int):
        self.ora = oracledb.connect(user=ora_user, password=ora_pwd, dsn=ora_dsn)
        self.pg  = psycopg2.connect(pg_dsn)
        self.dbid = dbid

    # ── Dimension loaders ──────────────────────────────────────────────────

    def upsert_snapshot_dim(self, snap_id: int, begin_time: datetime,
                            end_time: datetime, instance_number: int) -> int:
        interval = int((end_time - begin_time).total_seconds() / 60)
        hour = begin_time.hour
        dow  = begin_time.isoweekday()      # 1=Mon
        biz  = (1 <= dow <= 5) and (8 <= hour < 18)

        with self.pg.cursor() as cur:
            cur.execute("""
                INSERT INTO dim_snapshot
                  (snap_id, dbid, instance_number, begin_time, end_time,
                   interval_minutes, hour_of_day, day_of_week, week_of_year,
                   month, year, is_business_hours)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (snap_id, dbid, instance_number)
                DO UPDATE SET end_time = EXCLUDED.end_time
                RETURNING snapshot_sk
            """, (snap_id, self.dbid, instance_number,
                  begin_time, end_time, interval, hour, dow,
                  begin_time.isocalendar()[1],
                  begin_time.month, begin_time.year, biz))
            return cur.fetchone()[0]

    def upsert_sql_dim(self, sql_id: str, sql_text: str,
                       command_type: int) -> int:
        COMMAND_NAMES = {1:'SELECT',2:'INSERT',3:'SELECT',
                         6:'UPDATE',7:'DELETE',47:'PL/SQL'}
        name = COMMAND_NAMES.get(command_type, 'OTHER')
        short_text = (sql_text or '')[:200]

        with self.pg.cursor() as cur:
            cur.execute("""
                INSERT INTO dim_sql (sql_id, dbid, sql_text, sql_text_short,
                                     command_type, command_name)
                VALUES (%s,%s,%s,%s,%s,%s)
                ON CONFLICT (sql_id, dbid)
                DO UPDATE SET sql_text = COALESCE(EXCLUDED.sql_text, dim_sql.sql_text)
                RETURNING sql_sk
            """, (sql_id, self.dbid, sql_text, short_text, command_type, name))
            return cur.fetchone()[0]

    # ── Fact loader ────────────────────────────────────────────────────────

    def load_sqlstat_batch(self, rows: list[dict],
                           snap_map: dict, sql_map: dict,
                           db_sk: int, prev_plan_map: dict):
        records = []
        for r in rows:
            snap_sk  = snap_map[r['snap_id']]
            sql_sk   = sql_map[r['sql_id']]
            execs    = max(r['executions_delta'], 0)
            elapsed  = max(r['elapsed_time_delta'], 0)
            cpu      = max(r['cpu_time_delta'], 0)
            dreads   = max(r['disk_reads_delta'], 0)
            bgets    = max(r['buffer_gets_delta'], 0)

            # Per-execution derived metrics:
            el_ms = (elapsed / execs / 1000.0) if execs > 0 else 0
            cp_ms = (cpu     / execs / 1000.0) if execs > 0 else 0
            dr_px = (dreads  / execs)            if execs > 0 else 0
            bg_px = (bgets   / execs)            if execs > 0 else 0
            rw_px = (max(r['rows_processed_delta'],0) / execs) if execs > 0 else 0
            cpu_ratio = (cpu / elapsed) if elapsed > 0 else None
            io_ratio  = (max(r['iowait_delta'],0) / elapsed) if elapsed > 0 else None

            # Detect plan change:
            prev_plan = prev_plan_map.get(r['sql_id'])
            plan_changed = (prev_plan is not None and
                            prev_plan != r['plan_hash_value'] and
                            execs > 0)
            prev_plan_map[r['sql_id']] = r['plan_hash_value']

            records.append((
                snap_sk, sql_sk, db_sk, r['plan_hash_value'],
                execs, elapsed, cpu, dreads, bgets,
                max(r['rows_processed_delta'],0),
                max(r['parse_calls_delta'],0),
                max(r['iowait_delta'],0),
                max(r['clwait_delta'],0),
                max(r['apwait_delta'],0),
                max(r['ccwait_delta'],0),
                el_ms, cp_ms, dr_px, bg_px, rw_px,
                cpu_ratio, io_ratio, plan_changed,
            ))

        with self.pg.cursor() as cur:
            psycopg2.extras.execute_values(cur, """
                INSERT INTO fact_sql_performance (
                  snapshot_sk, sql_sk, db_sk, plan_hash_value,
                  executions, elapsed_time_us, cpu_time_us,
                  disk_reads, buffer_gets, rows_processed, parse_calls,
                  iowait_us, clwait_us, apwait_us, ccwait_us,
                  elapsed_ms_per_exec, cpu_ms_per_exec,
                  disk_reads_per_exec, buffer_gets_per_exec, rows_per_exec,
                  cpu_ratio, io_ratio, plan_changed
                ) VALUES %s
                ON CONFLICT (snapshot_sk, sql_sk) DO NOTHING
            """, records, page_size=500)
        self.pg.commit()
\`\`\`

---

## Python ML Analysis

With the star schema populated, the fact table becomes the feature matrix for ML. Four analyses are valuable for SQL performance monitoring:

### 1. Regression: Predicting Execution Time

Train a model to predict \`elapsed_ms_per_exec\` from load and context features. Use this to build a baseline — execution times predicted to be above baseline indicate a regression.

\`\`\`python
import pandas as pd
import numpy as np
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import mean_absolute_error, r2_score

# Load feature dataset from PostgreSQL:
FEATURE_QUERY = """
SELECT
    f.elapsed_ms_per_exec,
    f.cpu_ms_per_exec,
    f.disk_reads_per_exec,
    f.buffer_gets_per_exec,
    f.rows_per_exec,
    COALESCE(f.cpu_ratio, 0)          AS cpu_ratio,
    COALESCE(f.io_ratio, 0)           AS io_ratio,
    f.executions,
    sn.hour_of_day,
    sn.day_of_week,
    sn.is_business_hours::int         AS is_business_hours,
    sn.interval_minutes,
    f.plan_changed::int               AS plan_changed,
    sq.command_type
FROM fact_sql_performance f
JOIN dim_snapshot sn ON sn.snapshot_sk = f.snapshot_sk
JOIN dim_sql sq      ON sq.sql_sk      = f.sql_sk
WHERE f.executions > 5
  AND f.elapsed_ms_per_exec > 0
  AND f.elapsed_ms_per_exec < 300000     -- exclude outliers > 5 minutes
"""

df = pd.read_sql(FEATURE_QUERY, pg_engine)

FEATURES = [
    'disk_reads_per_exec', 'buffer_gets_per_exec', 'rows_per_exec',
    'cpu_ratio', 'io_ratio', 'executions',
    'hour_of_day', 'day_of_week', 'is_business_hours',
    'interval_minutes', 'plan_changed', 'command_type',
]
TARGET = 'elapsed_ms_per_exec'

X = df[FEATURES].fillna(0)
y = np.log1p(df[TARGET])    # log-transform: elapsed time is right-skewed

X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, random_state=42)

model = GradientBoostingRegressor(
    n_estimators=200, max_depth=5, learning_rate=0.05,
    subsample=0.8, random_state=42
)
model.fit(X_train, y_train)

y_pred = model.predict(X_test)
mae  = mean_absolute_error(np.expm1(y_test), np.expm1(y_pred))
r2   = r2_score(y_test, y_pred)
print(f"MAE: {mae:.1f} ms   R²: {r2:.3f}")

# Feature importance — which factors most drive execution time:
importance = pd.Series(model.feature_importances_, index=FEATURES)
print(importance.sort_values(ascending=False).head(8))
\`\`\`

### 2. Anomaly Detection: SQL Performance Regression

Isolation Forest identifies SQL executions that deviate from their historical norm — the core of automated regression detection.

\`\`\`python
from sklearn.ensemble import IsolationForest

# For a specific SQL ID, get all historical measurements:
SQL_ID = 'abc123defgh45'

history = pd.read_sql("""
    SELECT
        sn.begin_time,
        f.elapsed_ms_per_exec,
        f.buffer_gets_per_exec,
        f.disk_reads_per_exec,
        f.cpu_ratio,
        f.plan_changed::int AS plan_changed,
        sn.hour_of_day,
        f.executions
    FROM fact_sql_performance f
    JOIN dim_snapshot sn ON sn.snapshot_sk = f.snapshot_sk
    JOIN dim_sql sq ON sq.sql_sk = f.sql_sk
    WHERE sq.sql_id = %(sql_id)s
      AND f.executions > 0
    ORDER BY sn.begin_time
""", pg_engine, params={'sql_id': SQL_ID})

ANOMALY_FEATURES = [
    'elapsed_ms_per_exec', 'buffer_gets_per_exec',
    'disk_reads_per_exec', 'cpu_ratio', 'hour_of_day',
]

X_sql = history[ANOMALY_FEATURES].fillna(0)

# Train on the first 80% (historical baseline), score all data:
split = int(len(X_sql) * 0.8)
iso = IsolationForest(contamination=0.05, random_state=42)
iso.fit(X_sql.iloc[:split])

history['anomaly_score'] = iso.decision_function(X_sql)
history['is_anomaly']    = iso.predict(X_sql) == -1

# Anomalies where elapsed time is above the historical median:
regressions = history[
    history['is_anomaly'] &
    (history['elapsed_ms_per_exec'] > history['elapsed_ms_per_exec'].median() * 2)
].sort_values('begin_time')

print(f"Detected {len(regressions)} performance regressions for {SQL_ID}:")
print(regressions[['begin_time','elapsed_ms_per_exec','plan_changed','anomaly_score']].to_string())
\`\`\`

### 3. Clustering: Group SQLs by Performance Profile

K-Means clustering groups SQL IDs by their aggregate performance characteristics. This surfaces natural categories: fast read queries, expensive analytical scans, write-heavy DML, I/O-bound queries, and so on.

\`\`\`python
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler
import matplotlib.pyplot as plt
import seaborn as sns

# Aggregate per SQL ID for clustering:
sql_profiles = pd.read_sql("""
    SELECT
        sq.sql_id,
        sq.sql_text_short,
        sq.command_name,
        AVG(f.elapsed_ms_per_exec)    AS avg_elapsed_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP
          (ORDER BY f.elapsed_ms_per_exec) AS p95_elapsed_ms,
        AVG(f.buffer_gets_per_exec)   AS avg_buffer_gets,
        AVG(f.disk_reads_per_exec)    AS avg_disk_reads,
        AVG(COALESCE(f.cpu_ratio,0))  AS avg_cpu_ratio,
        AVG(COALESCE(f.io_ratio,0))   AS avg_io_ratio,
        SUM(f.executions)             AS total_executions,
        COUNT(DISTINCT f.plan_hash_value) AS plan_variations,
        SUM(f.plan_changed::int)      AS plan_changes
    FROM fact_sql_performance f
    JOIN dim_sql sq ON sq.sql_sk = f.sql_sk
    WHERE f.executions > 10
    GROUP BY sq.sql_id, sq.sql_text_short, sq.command_name
    HAVING COUNT(*) > 20
""", pg_engine)

CLUSTER_FEATURES = [
    'avg_elapsed_ms', 'p95_elapsed_ms', 'avg_buffer_gets',
    'avg_disk_reads', 'avg_cpu_ratio', 'avg_io_ratio',
]

X_cluster = sql_profiles[CLUSTER_FEATURES].fillna(0)
scaler = StandardScaler()
X_scaled = scaler.fit_transform(X_cluster)

# Choose k=5: fast selects, expensive reads, heavy writes, I/O bound, pathological
kmeans = KMeans(n_clusters=5, random_state=42, n_init=10)
sql_profiles['cluster'] = kmeans.fit_predict(X_scaled)

# Profile each cluster:
cluster_summary = sql_profiles.groupby('cluster')[CLUSTER_FEATURES].mean().round(2)
cluster_summary['size'] = sql_profiles.groupby('cluster').size()
print(cluster_summary.sort_values('avg_elapsed_ms'))

# The highest avg_elapsed_ms cluster contains the candidate SQL IDs for tuning:
problem_cluster = cluster_summary['avg_elapsed_ms'].idxmax()
candidates = sql_profiles[sql_profiles['cluster'] == problem_cluster] \
    .sort_values('p95_elapsed_ms', ascending=False) \
    .head(10)
print("\\nTop SQL IDs to investigate:")
print(candidates[['sql_id','sql_text_short','avg_elapsed_ms','p95_elapsed_ms','plan_changes']].to_string())
\`\`\`

### 4. Time Series: Trend Analysis per SQL ID

ARIMA or Prophet forecasting projects future execution time for a given SQL ID. This enables proactive alerting before a query degrades past a service level objective.

\`\`\`python
from prophet import Prophet

# Load hourly aggregated data for a SQL ID:
ts_data = pd.read_sql("""
    SELECT
        hour_bucket        AS ds,
        avg_elapsed_ms     AS y
    FROM agg_sql_hourly ah
    JOIN dim_sql sq ON sq.sql_sk = ah.sql_sk
    WHERE sq.sql_id = %(sql_id)s
      AND avg_elapsed_ms > 0
    ORDER BY hour_bucket
""", pg_engine, params={'sql_id': SQL_ID})

# Prophet handles seasonality and missing data gracefully:
m = Prophet(
    yearly_seasonality=False,
    weekly_seasonality=True,
    daily_seasonality=True,
    changepoint_prior_scale=0.1,    # lower = less sensitive to regime changes
)
m.fit(ts_data)

# Forecast 7 days forward:
future = m.make_future_dataframe(periods=168, freq='H')
forecast = m.predict(future)

# Identify where forecast exceeds SLO (e.g., 500 ms):
SLO_MS = 500
breaches = forecast[forecast['yhat_upper'] > SLO_MS][['ds','yhat','yhat_lower','yhat_upper']]
if not breaches.empty:
    print(f"Forecast SLO breach for {SQL_ID}:")
    print(breaches.head())
\`\`\`

---

## Analytical Queries on the Star Schema

With the warehouse populated, the star schema enables queries that are impossible directly against AWR's narrow time window:

\`\`\`sql
-- Top 20 SQL IDs by total elapsed time over 90 days:
SELECT
  sq.sql_id,
  sq.sql_text_short,
  sq.command_name,
  SUM(f.executions)                  AS total_executions,
  ROUND(SUM(f.elapsed_time_us)/1e9,1) AS total_elapsed_sec,
  ROUND(AVG(f.elapsed_ms_per_exec),2) AS avg_ms_per_exec,
  COUNT(DISTINCT f.plan_hash_value)   AS plan_variations
FROM fact_sql_performance f
JOIN dim_sql sq      ON sq.sql_sk = f.sql_sk
JOIN dim_snapshot sn ON sn.snapshot_sk = f.snapshot_sk
WHERE sn.begin_time > NOW() - INTERVAL '90 days'
GROUP BY sq.sql_id, sq.sql_text_short, sq.command_name
ORDER BY total_elapsed_sec DESC
LIMIT 20;
\`\`\`

\`\`\`sql
-- SQL IDs with execution time variance by hour of day (for scheduling insight):
SELECT
  sq.sql_id,
  sn.hour_of_day,
  ROUND(AVG(f.elapsed_ms_per_exec),2)  AS avg_ms,
  ROUND(STDDEV(f.elapsed_ms_per_exec),2) AS stddev_ms,
  COUNT(*)                              AS sample_count
FROM fact_sql_performance f
JOIN dim_sql sq      ON sq.sql_sk      = f.sql_sk
JOIN dim_snapshot sn ON sn.snapshot_sk = f.snapshot_sk
WHERE sq.sql_id = 'abc123defgh45'
  AND f.executions > 0
GROUP BY sq.sql_id, sn.hour_of_day
ORDER BY sn.hour_of_day;
\`\`\`

\`\`\`sql
-- Plan changes and their performance impact:
SELECT
  sq.sql_id,
  sn.begin_time,
  f.plan_hash_value,
  f.elapsed_ms_per_exec,
  f.buffer_gets_per_exec,
  LAG(f.plan_hash_value) OVER
    (PARTITION BY f.sql_sk ORDER BY sn.begin_time) AS prev_plan,
  LAG(f.elapsed_ms_per_exec) OVER
    (PARTITION BY f.sql_sk ORDER BY sn.begin_time) AS prev_elapsed_ms
FROM fact_sql_performance f
JOIN dim_sql sq      ON sq.sql_sk      = f.sql_sk
JOIN dim_snapshot sn ON sn.snapshot_sk = f.snapshot_sk
WHERE f.plan_changed = TRUE
  AND sq.sql_id = 'abc123defgh45'
ORDER BY sn.begin_time;
\`\`\`

---

## Summary

The architecture — Oracle AWR → Data Pump extraction → PostgreSQL star schema → Python ML — gives Oracle DBAs capabilities that AWR reports alone cannot provide:

| Capability | AWR Reports | This Architecture |
|-----------|------------|------------------|
| Retention period | 8 days default | Unlimited |
| Cross-database comparison | No | Yes (multiple DBID values) |
| SQL regression detection | Manual inspection | Automated (Isolation Forest) |
| Execution time forecasting | No | Yes (Prophet/ARIMA) |
| SQL clustering by profile | No | Yes (K-Means) |
| Historical trend charts | No | Full time series |
| Ad-hoc SQL analytics | Limited | Full PostgreSQL + Python |

The companion runbook covers the complete deployment: Oracle Data Pump export configuration, Python extraction pipeline installation, PostgreSQL schema creation and incremental load setup, and the ML analysis scripts.`,
};

async function main() {
  console.log('Inserting AWR DW ML blog post...');
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
