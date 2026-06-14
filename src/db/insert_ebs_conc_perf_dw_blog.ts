import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'EBS Concurrent Program Performance: Building a Data Warehouse with AWR Correlation and Python ML',
  slug: 'ebs-concurrent-program-performance-data-warehouse-python-ml',
  excerpt:
    'A complete architecture for extracting Oracle EBS concurrent request history and AWR SQL performance data into a PostgreSQL star schema data warehouse, then applying Python machine learning — regression, anomaly detection, clustering, and correlation analysis — to identify slow programs, detect runtime anomalies, predict future durations, and correlate concurrent load spikes with SQL degradation.',
  category: 'performance-dw' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `Oracle E-Business Suite runs hundreds of concurrent programs every day: interfaces, purges, reports, workflow mailers, cost rollups, payroll processes. Each one is a black box to most monitoring tools — you can see that it ran, how long it took, and whether it succeeded, but you cannot answer questions like:

- Which programs are running slower this month compared to last month?
- Does the GL Period Close concurrent manager show longer SQL execution times when more than 20 programs run simultaneously?
- Which programs are anomalies — running 3× their historical average without any apparent reason?
- Can we predict whether tonight's payroll run will finish before the 2 AM SLA?

The answer is to extract concurrent request history from the EBS \`FND_*\` tables, join it to Oracle AWR data using the MODULE and ACTION columns that EBS stamps on every database session, load both into a PostgreSQL star schema data warehouse, and run Python machine learning against the structured fact tables. This post covers the complete architecture end to end.

---

## How EBS Stamps Database Sessions

Every EBS concurrent request sets Oracle client context on its database session:

\`\`\`sql
-- What EBS sets on the database session for concurrent requests
SELECT module, action, client_info
FROM   v\$session
WHERE  module LIKE 'FND%'
AND    type = 'USER';
\`\`\`

| Column | Example Value | Meaning |
|--------|--------------|---------|
| \`MODULE\` | \`FND\` or \`FNDRSSUB\` | Identifies EBS concurrent manager subsystem |
| \`ACTION\` | \`1234567\` | The \`REQUEST_ID\` from \`FND_CONCURRENT_REQUESTS\` |
| \`CLIENT_INFO\` | \`00001:PROD:SYSADMIN\` | Responsibility ID, DB name, username |

AWR captures this context in \`DBA_HIST_ACTIVE_SESSION_HISTORY\` and aggregates it into \`DBA_HIST_SQLSTAT\` via the \`MODULE\` and \`ACTION\` columns. This is the join key between EBS request history and Oracle SQL performance data.

---

## EBS Source Tables

### FND_CONCURRENT_REQUESTS

The primary fact table in EBS — one row per concurrent program execution:

\`\`\`sql
SELECT
  r.request_id,
  r.parent_request_id,
  r.concurrent_program_id,
  r.requested_by,
  r.phase_code,          -- R=Running, C=Complete, P=Pending, I=Inactive
  r.status_code,         -- C=Normal, E=Error, G=Warning, X=Terminated
  r.actual_start_date,
  r.actual_completion_date,
  r.actual_completion_date - r.actual_start_date AS run_duration,
  r.argument_text,
  r.logfile_name,
  r.outfile_name,
  r.org_id,
  r.responsibility_id
FROM fnd_concurrent_requests r
WHERE r.actual_start_date IS NOT NULL
ORDER BY r.actual_start_date DESC;
\`\`\`

### FND_CONCURRENT_PROGRAMS and FND_CONCURRENT_PROGRAMS_TL

Program metadata — the dimension describing what each request ran:

\`\`\`sql
SELECT
  p.concurrent_program_id,
  p.concurrent_program_name,   -- Short name (e.g., XLAACCPB)
  t.user_concurrent_program_name,
  p.application_id,
  p.enabled_flag,
  p.execution_method_code,     -- P=PL/SQL, H=Host, J=Java, S=Spawned
  p.min_proc_num_of_args,
  p.max_proc_num_of_args
FROM fnd_concurrent_programs   p
JOIN fnd_concurrent_programs_tl t
     ON  t.concurrent_program_id = p.concurrent_program_id
     AND t.application_id        = p.application_id
     AND t.language               = 'US';
\`\`\`

### FND_CONCURRENT_QUEUES (Concurrent Managers)

Which concurrent manager processed each request:

\`\`\`sql
SELECT
  q.concurrent_queue_id,
  q.concurrent_queue_name,
  t.user_concurrent_queue_name,
  q.max_processes,
  q.running_processes
FROM fnd_concurrent_queues    q
JOIN fnd_concurrent_queues_tl t
     ON  t.concurrent_queue_id  = q.concurrent_queue_id
     AND t.application_id       = q.application_id
     AND t.language              = 'US';
\`\`\`

---

## AWR Source: Linking SQL to Concurrent Requests

AWR captures SQL execution statistics per snapshot period. The link to concurrent requests is through two paths:

**Path 1 — Direct via DBA_HIST_ACTIVE_SESSION_HISTORY (exact)**

\`\`\`sql
SELECT
  ash.snap_id,
  ash.sql_id,
  ash.module,
  ash.action,
  TO_NUMBER(ash.action) AS request_id,
  COUNT(*)              AS ash_samples,
  COUNT(*) * 10         AS estimated_active_seconds
FROM dba_hist_active_sess_history ash
WHERE ash.module = 'FND'
  AND ash.action IS NOT NULL
  AND REGEXP_LIKE(ash.action, '^[0-9]+$')
GROUP BY ash.snap_id, ash.sql_id, ash.module, ash.action;
\`\`\`

**Path 2 — Via DBA_HIST_SQLSTAT (aggregate, higher volume)**

\`\`\`sql
SELECT
  s.snap_id,
  s.sql_id,
  s.plan_hash_value,
  s.module,
  s.action,
  TO_NUMBER(s.action) AS request_id,
  s.executions_delta,
  s.elapsed_time_delta / 1e6   AS elapsed_sec,
  s.cpu_time_delta     / 1e6   AS cpu_sec,
  s.disk_reads_delta,
  s.buffer_gets_delta,
  s.rows_processed_delta
FROM dba_hist_sqlstat s
WHERE s.module = 'FND'
  AND s.action IS NOT NULL
  AND REGEXP_LIKE(s.action, '^[0-9]+$')
  AND s.executions_delta > 0;
\`\`\`

---

## PostgreSQL Star Schema

The data warehouse uses five tables: three dimensions and two facts.

### Dimensions

\`\`\`sql
-- Programs dimension
CREATE TABLE dim_concurrent_program (
  program_sk              BIGSERIAL PRIMARY KEY,
  concurrent_program_id   INTEGER    NOT NULL,
  application_id          INTEGER    NOT NULL,
  short_name              VARCHAR(30) NOT NULL,
  user_name               VARCHAR(240),
  execution_method        CHAR(1),
  application_short_name  VARCHAR(50),
  UNIQUE (concurrent_program_id, application_id)
);

-- Request status dimension (phase + status code combinations)
CREATE TABLE dim_request_status (
  status_sk    SERIAL PRIMARY KEY,
  phase_code   CHAR(1)     NOT NULL,
  status_code  CHAR(1)     NOT NULL,
  phase_desc   VARCHAR(30) NOT NULL,
  status_desc  VARCHAR(30) NOT NULL,
  is_complete  BOOLEAN     NOT NULL DEFAULT FALSE,
  is_error     BOOLEAN     NOT NULL DEFAULT FALSE,
  UNIQUE (phase_code, status_code)
);

INSERT INTO dim_request_status (phase_code, status_code, phase_desc, status_desc, is_complete, is_error) VALUES
  ('C', 'C', 'Complete',  'Normal',     TRUE,  FALSE),
  ('C', 'E', 'Complete',  'Error',      TRUE,  TRUE),
  ('C', 'G', 'Complete',  'Warning',    TRUE,  FALSE),
  ('C', 'X', 'Complete',  'Terminated', TRUE,  TRUE),
  ('R', 'R', 'Running',   'Running',    FALSE, FALSE),
  ('P', 'I', 'Pending',   'Normal',     FALSE, FALSE),
  ('P', 'S', 'Pending',   'Scheduled',  FALSE, FALSE),
  ('I', 'H', 'Inactive',  'On Hold',    FALSE, FALSE),
  ('I', 'X', 'Inactive',  'Terminated', FALSE, TRUE);

-- Snapshot dimension (shared with AWR DW, indexed by Oracle snap_id + dbid)
CREATE TABLE dim_snapshot (
  snapshot_sk       BIGSERIAL PRIMARY KEY,
  oracle_snap_id    INTEGER     NOT NULL,
  dbid              BIGINT      NOT NULL,
  instance_number   SMALLINT    NOT NULL,
  begin_interval_ts TIMESTAMPTZ NOT NULL,
  end_interval_ts   TIMESTAMPTZ NOT NULL,
  snap_hour         SMALLINT    NOT NULL,
  snap_dow          SMALLINT    NOT NULL,
  snap_week         SMALLINT    NOT NULL,
  snap_month        SMALLINT    NOT NULL,
  snap_year         SMALLINT    NOT NULL,
  is_weekend        BOOLEAN     NOT NULL,
  UNIQUE (oracle_snap_id, dbid, instance_number)
);
\`\`\`

### Facts

\`\`\`sql
-- Concurrent request fact (one row per completed/errored request)
CREATE TABLE fact_concurrent_requests (
  request_sk          BIGSERIAL   PRIMARY KEY,
  request_id          BIGINT      NOT NULL UNIQUE,
  parent_request_id   BIGINT,
  program_sk          BIGINT      REFERENCES dim_concurrent_program,
  status_sk           INTEGER     REFERENCES dim_request_status,
  requested_by_user   VARCHAR(100),
  org_id              INTEGER,
  responsibility_id   INTEGER,
  start_ts            TIMESTAMPTZ NOT NULL,
  end_ts              TIMESTAMPTZ,
  duration_seconds    NUMERIC(12,3),
  wait_seconds        NUMERIC(12,3),
  argument_text       TEXT,
  manager_name        VARCHAR(240),
  log_lines           INTEGER,
  extracted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX fact_cr_program_sk    ON fact_concurrent_requests (program_sk);
CREATE INDEX fact_cr_start_ts      ON fact_concurrent_requests (start_ts);
CREATE INDEX fact_cr_status_sk     ON fact_concurrent_requests (status_sk);
CREATE INDEX fact_cr_duration      ON fact_concurrent_requests (duration_seconds);

-- SQL performance fact (AWR-linked, foreign-keyed to concurrent request)
CREATE TABLE fact_sql_performance (
  perf_sk              BIGSERIAL PRIMARY KEY,
  snapshot_sk          BIGINT    REFERENCES dim_snapshot,
  request_id           BIGINT    REFERENCES fact_concurrent_requests (request_id),
  sql_id               VARCHAR(13) NOT NULL,
  plan_hash_value      BIGINT,
  sql_text_snippet     TEXT,
  executions           INTEGER,
  elapsed_sec          NUMERIC(14,3),
  cpu_sec              NUMERIC(14,3),
  disk_reads           BIGINT,
  buffer_gets          BIGINT,
  rows_processed       BIGINT,
  elapsed_per_exec_sec NUMERIC(12,6),
  cpu_ratio            NUMERIC(6,4),
  io_ratio             NUMERIC(6,4),
  plan_changed         BOOLEAN     NOT NULL DEFAULT FALSE,
  extracted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX fact_sp_sql_id     ON fact_sql_performance (sql_id);
CREATE INDEX fact_sp_request_id ON fact_sql_performance (request_id);
CREATE INDEX fact_sp_snap_sk    ON fact_sql_performance (snapshot_sk);
\`\`\`

---

## Python ETL Pipeline

### Project Structure

\`\`\`
ebs_perf_dw/
├── etl/
│   ├── extract_ebs.py       # EBS FND_* extraction
│   ├── extract_awr.py       # AWR DBA_HIST_* extraction
│   ├── load_postgres.py     # Dimension upserts + fact inserts
│   └── watermark.py         # Incremental load state
├── ml/
│   ├── duration_regression.py
│   ├── anomaly_detection.py
│   ├── program_clustering.py
│   └── sql_correlation.py
├── requirements.txt
└── main.py
\`\`\`

### EBS Extraction (extract_ebs.py)

\`\`\`python
import oracledb
import psycopg2
from psycopg2.extras import execute_values
from datetime import datetime, timedelta

EBS_QUERY = """
SELECT
    r.request_id,
    r.parent_request_id,
    r.concurrent_program_id,
    p.application_id,
    p.concurrent_program_name,
    t.user_concurrent_program_name,
    p.execution_method_code,
    r.requested_by,
    u.user_name,
    r.phase_code,
    r.status_code,
    r.actual_start_date,
    r.actual_completion_date,
    ROUND(
      (r.actual_completion_date - r.actual_start_date) * 86400, 3
    ) AS duration_seconds,
    ROUND(
      (r.actual_start_date - r.request_date) * 86400, 3
    ) AS wait_seconds,
    q.user_concurrent_queue_name  AS manager_name,
    r.argument_text,
    r.org_id,
    r.responsibility_id
FROM fnd_concurrent_requests r
JOIN fnd_concurrent_programs    p ON  p.concurrent_program_id = r.concurrent_program_id
                                  AND p.application_id        = r.program_application_id
JOIN fnd_concurrent_programs_tl t ON  t.concurrent_program_id = p.concurrent_program_id
                                  AND t.application_id        = p.application_id
                                  AND t.language               = 'US'
JOIN fnd_user                   u ON  u.user_id = r.requested_by
LEFT JOIN fnd_concurrent_queues    qb ON  qb.concurrent_queue_id  = r.controlling_manager
LEFT JOIN fnd_concurrent_queues_tl q  ON  q.concurrent_queue_id   = qb.concurrent_queue_id
                                       AND q.application_id        = qb.application_id
                                       AND q.language               = 'US'
WHERE r.actual_start_date >= :since
  AND r.phase_code         IN ('C', 'R')
ORDER BY r.actual_start_date
"""

def extract_ebs_requests(oracle_conn, since: datetime) -> list[dict]:
    with oracle_conn.cursor() as cur:
        cur.execute(EBS_QUERY, since=since)
        cols = [d[0].lower() for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]
\`\`\`

### AWR Extraction (extract_awr.py)

\`\`\`python
AWR_SNAP_QUERY = """
SELECT
    s.snap_id,
    s.dbid,
    s.instance_number,
    s.begin_interval_time,
    s.end_interval_time
FROM dba_hist_snapshot s
WHERE s.end_interval_time >= :since
ORDER BY s.snap_id
"""

AWR_SQLSTAT_QUERY = """
SELECT
    st.snap_id,
    st.dbid,
    st.sql_id,
    st.plan_hash_value,
    st.module,
    st.action,
    TO_NUMBER(st.action)         AS request_id,
    st.executions_delta          AS executions,
    st.elapsed_time_delta / 1e6  AS elapsed_sec,
    st.cpu_time_delta     / 1e6  AS cpu_sec,
    st.disk_reads_delta          AS disk_reads,
    st.buffer_gets_delta         AS buffer_gets,
    st.rows_processed_delta      AS rows_processed,
    tx.sql_text
FROM dba_hist_sqlstat   st
LEFT JOIN dba_hist_sqltext tx ON tx.sql_id = st.sql_id AND tx.dbid = st.dbid
WHERE st.snap_id        >= :min_snap
  AND st.module          = 'FND'
  AND st.action         IS NOT NULL
  AND REGEXP_LIKE(st.action, '^[0-9]+$')
  AND st.executions_delta > 0
ORDER BY st.snap_id, st.sql_id
"""

def extract_awr_snapshots(oracle_conn, since: datetime) -> list[dict]:
    with oracle_conn.cursor() as cur:
        cur.execute(AWR_SNAP_QUERY, since=since)
        cols = [d[0].lower() for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]

def extract_awr_sqlstat(oracle_conn, min_snap_id: int) -> list[dict]:
    with oracle_conn.cursor() as cur:
        cur.execute(AWR_SQLSTAT_QUERY, min_snap=min_snap_id)
        cols = [d[0].lower() for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]
\`\`\`

### PostgreSQL Loader (load_postgres.py)

\`\`\`python
from psycopg2.extras import execute_values
import psycopg2

def upsert_programs(pg_conn, requests: list[dict]):
    rows = list({
        (r['concurrent_program_id'], r['application_id']): (
            r['concurrent_program_id'],
            r['application_id'],
            r['concurrent_program_name'],
            r['user_concurrent_program_name'],
            r['execution_method_code'],
        )
        for r in requests
    }.values())
    sql = """
        INSERT INTO dim_concurrent_program
          (concurrent_program_id, application_id, short_name, user_name, execution_method)
        VALUES %s
        ON CONFLICT (concurrent_program_id, application_id)
        DO UPDATE SET
          short_name       = EXCLUDED.short_name,
          user_name        = EXCLUDED.user_name,
          execution_method = EXCLUDED.execution_method
    """
    with pg_conn.cursor() as cur:
        execute_values(cur, sql, rows)
    pg_conn.commit()

def upsert_snapshots(pg_conn, snaps: list[dict]):
    rows = [(
        s['snap_id'], s['dbid'], s['instance_number'],
        s['begin_interval_time'], s['end_interval_time'],
        s['begin_interval_time'].hour,
        s['begin_interval_time'].weekday(),
        int(s['begin_interval_time'].strftime('%W')),
        s['begin_interval_time'].month,
        s['begin_interval_time'].year,
        s['begin_interval_time'].weekday() >= 5,
    ) for s in snaps]
    sql = """
        INSERT INTO dim_snapshot
          (oracle_snap_id, dbid, instance_number,
           begin_interval_ts, end_interval_ts,
           snap_hour, snap_dow, snap_week, snap_month, snap_year, is_weekend)
        VALUES %s
        ON CONFLICT (oracle_snap_id, dbid, instance_number) DO NOTHING
    """
    with pg_conn.cursor() as cur:
        execute_values(cur, sql, rows)
    pg_conn.commit()

def insert_requests(pg_conn, requests: list[dict], program_sk_map: dict):
    rows = [(
        r['request_id'],
        r['parent_request_id'],
        program_sk_map.get((r['concurrent_program_id'], r['application_id'])),
        r['phase_code'] + r['status_code'],   # resolved to status_sk in SQL
        r['user_name'],
        r['org_id'],
        r['responsibility_id'],
        r['actual_start_date'],
        r['actual_completion_date'],
        r['duration_seconds'],
        r['wait_seconds'],
        r['argument_text'],
        r['manager_name'],
    ) for r in requests if r.get('actual_start_date')]
    sql = """
        INSERT INTO fact_concurrent_requests
          (request_id, parent_request_id, program_sk, status_sk,
           requested_by_user, org_id, responsibility_id,
           start_ts, end_ts, duration_seconds, wait_seconds,
           argument_text, manager_name)
        SELECT
          r.request_id, r.parent_request_id, r.program_sk,
          ds.status_sk,
          r.requested_by_user, r.org_id, r.responsibility_id,
          r.start_ts, r.end_ts, r.duration_seconds, r.wait_seconds,
          r.argument_text, r.manager_name
        FROM (VALUES %s) AS r(request_id, parent_request_id, program_sk,
               phase_status, requested_by_user, org_id, responsibility_id,
               start_ts, end_ts, duration_seconds, wait_seconds,
               argument_text, manager_name)
        JOIN dim_request_status ds
          ON ds.phase_code || ds.status_code = r.phase_status
        ON CONFLICT (request_id) DO UPDATE SET
          end_ts           = EXCLUDED.end_ts,
          duration_seconds = EXCLUDED.duration_seconds,
          status_sk        = EXCLUDED.status_sk
    """
    with pg_conn.cursor() as cur:
        execute_values(cur, sql, rows)
    pg_conn.commit()

def insert_sql_performance(pg_conn, sqlstat: list[dict], snap_sk_map: dict):
    rows = []
    for s in sqlstat:
        snap_key = (s['snap_id'], s['dbid'], s.get('instance_number', 1))
        snap_sk  = snap_sk_map.get(snap_key)
        if not snap_sk:
            continue
        elapsed = float(s['elapsed_sec'] or 0)
        cpu     = float(s['cpu_sec'] or 0)
        execs   = int(s['executions'] or 0)
        rows.append((
            snap_sk,
            s['request_id'],
            s['sql_id'],
            s['plan_hash_value'],
            (s['sql_text'] or '')[:200],
            execs,
            elapsed,
            cpu,
            s['disk_reads'],
            s['buffer_gets'],
            s['rows_processed'],
            elapsed / execs if execs else None,
            cpu / elapsed   if elapsed else None,
        ))
    sql = """
        INSERT INTO fact_sql_performance
          (snapshot_sk, request_id, sql_id, plan_hash_value, sql_text_snippet,
           executions, elapsed_sec, cpu_sec, disk_reads, buffer_gets, rows_processed,
           elapsed_per_exec_sec, cpu_ratio)
        VALUES %s
        ON CONFLICT DO NOTHING
    """
    with pg_conn.cursor() as cur:
        execute_values(cur, sql, rows)
    pg_conn.commit()
\`\`\`

---

## Machine Learning Analysis

### 1. Run Duration Regression (duration_regression.py)

Predict expected duration for a concurrent program given time-of-day, day-of-week, and system load:

\`\`\`python
import pandas as pd
import numpy as np
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error
import psycopg2

QUERY = """
SELECT
    cr.duration_seconds,
    cr.wait_seconds,
    dp.short_name              AS program_name,
    EXTRACT(HOUR  FROM cr.start_ts)    AS start_hour,
    EXTRACT(DOW   FROM cr.start_ts)    AS start_dow,
    EXTRACT(MONTH FROM cr.start_ts)    AS start_month,
    ds.is_weekend,
    COUNT(*) OVER (
        PARTITION BY DATE_TRUNC('hour', cr.start_ts)
    )                          AS concurrent_load
FROM fact_concurrent_requests cr
JOIN dim_concurrent_program   dp ON dp.program_sk = cr.program_sk
JOIN dim_request_status       rs ON rs.status_sk  = cr.status_sk
JOIN dim_snapshot              ds ON ds.begin_interval_ts <=  cr.start_ts
                                 AND ds.end_interval_ts    >   cr.start_ts
WHERE rs.is_complete = TRUE
  AND rs.is_error    = FALSE
  AND cr.duration_seconds IS NOT NULL
  AND cr.duration_seconds  > 0
"""

def train_duration_model(pg_conn):
    df = pd.read_sql(QUERY, pg_conn)
    df = df.dropna(subset=['duration_seconds'])
    df['log_duration'] = np.log1p(df['duration_seconds'])
    df['log_wait']     = np.log1p(df['wait_seconds'].fillna(0))

    programs = pd.get_dummies(df['program_name'], prefix='prog', drop_first=True)
    X = pd.concat([
        df[['start_hour','start_dow','start_month','concurrent_load','log_wait']].astype(float),
        programs,
    ], axis=1)
    y = df['log_duration']

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    model = GradientBoostingRegressor(n_estimators=300, max_depth=5, learning_rate=0.05)
    model.fit(X_train, y_train)

    preds = np.expm1(model.predict(X_test))
    actuals = np.expm1(y_test)
    mae = mean_absolute_error(actuals, preds)
    print(f"Duration model MAE: {mae:.1f} seconds")

    importances = pd.Series(model.feature_importances_, index=X.columns)
    print("\\nTop 10 feature importances:")
    print(importances.nlargest(10).to_string())
    return model
\`\`\`

### 2. Duration Anomaly Detection (anomaly_detection.py)

Detect programs running significantly longer than their historical baseline:

\`\`\`python
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler

ANOMALY_QUERY = """
SELECT
    cr.request_id,
    cr.start_ts,
    cr.duration_seconds,
    dp.short_name       AS program_name,
    ds.is_weekend,
    EXTRACT(HOUR FROM cr.start_ts)  AS start_hour
FROM fact_concurrent_requests cr
JOIN dim_concurrent_program   dp ON dp.program_sk = cr.program_sk
JOIN dim_request_status       rs ON rs.status_sk  = cr.status_sk
JOIN dim_snapshot              ds ON ds.begin_interval_ts <= cr.start_ts
                                 AND ds.end_interval_ts   >  cr.start_ts
WHERE rs.is_complete     = TRUE
  AND cr.duration_seconds > 0
ORDER BY cr.start_ts
"""

def detect_anomalies(pg_conn):
    df = pd.read_sql(ANOMALY_QUERY, pg_conn)

    results = []
    for program, grp in df.groupby('program_name'):
        if len(grp) < 20:
            continue
        X = StandardScaler().fit_transform(
            grp[['duration_seconds','start_hour']].fillna(0)
        )
        iso = IsolationForest(contamination=0.05, random_state=42)
        grp = grp.copy()
        grp['anomaly'] = iso.fit_predict(X)
        grp['anomaly_score'] = iso.decision_function(X)
        flagged = grp[grp['anomaly'] == -1].copy()
        flagged['program'] = program
        results.append(flagged)

    if not results:
        print("No anomalies detected.")
        return

    anomalies = pd.concat(results)
    print(f"\\n{len(anomalies)} anomalous requests detected across {anomalies['program'].nunique()} programs")
    print("\\nTop anomalies by severity:")
    print(
        anomalies.nsmallest(20, 'anomaly_score')[
            ['program','request_id','start_ts','duration_seconds','anomaly_score']
        ].to_string(index=False)
    )
    return anomalies
\`\`\`

### 3. Program Performance Clustering (program_clustering.py)

Group concurrent programs by their performance profile — CPU-heavy vs I/O-heavy vs fast vs slow:

\`\`\`python
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler

CLUSTER_QUERY = """
SELECT
    dp.short_name                              AS program_name,
    COUNT(*)                                   AS total_runs,
    AVG(cr.duration_seconds)                   AS avg_duration,
    PERCENTILE_CONT(0.95) WITHIN GROUP
      (ORDER BY cr.duration_seconds)           AS p95_duration,
    AVG(sp.cpu_sec)                            AS avg_cpu_sec,
    AVG(sp.disk_reads)                         AS avg_disk_reads,
    AVG(sp.buffer_gets)                        AS avg_buffer_gets,
    SUM(CASE WHEN rs.is_error THEN 1 ELSE 0 END)::FLOAT
      / COUNT(*)                               AS error_rate,
    STDDEV(cr.duration_seconds)
      / NULLIF(AVG(cr.duration_seconds), 0)    AS cv_duration
FROM fact_concurrent_requests  cr
JOIN dim_concurrent_program    dp ON dp.program_sk  = cr.program_sk
JOIN dim_request_status        rs ON rs.status_sk   = cr.status_sk
LEFT JOIN fact_sql_performance sp ON sp.request_id  = cr.request_id
GROUP BY dp.short_name
HAVING COUNT(*) >= 10
"""

CLUSTER_LABELS = {
    0: 'Fast & Reliable',
    1: 'Slow & I/O Bound',
    2: 'CPU Intensive',
    3: 'Erratic / High Variance',
    4: 'Rarely Runs',
}

def cluster_programs(pg_conn):
    df = pd.read_sql(CLUSTER_QUERY, pg_conn)
    features = ['avg_duration','p95_duration','avg_cpu_sec',
                'avg_disk_reads','avg_buffer_gets','error_rate','cv_duration']
    X = df[features].fillna(0)
    X_scaled = StandardScaler().fit_transform(X)

    km = KMeans(n_clusters=5, random_state=42, n_init=10)
    df['cluster'] = km.fit_predict(X_scaled)
    df['cluster_label'] = df['cluster'].map(CLUSTER_LABELS)

    print("Program clusters:")
    print(df.groupby('cluster_label')[features].mean().round(2).to_string())
    print("\\nPrograms in each cluster:")
    for label, grp in df.groupby('cluster_label'):
        print(f"\\n--- {label} ({len(grp)} programs) ---")
        print(grp.nlargest(10, 'avg_duration')[['program_name','total_runs','avg_duration','error_rate']].to_string(index=False))
    return df
\`\`\`

### 4. Concurrent Load vs SQL Degradation Correlation (sql_correlation.py)

The critical question: does running more concurrent programs in an hour cause SQL execution times to spike?

\`\`\`python
import scipy.stats as stats

CORR_QUERY = """
SELECT
    DATE_TRUNC('hour', cr.start_ts)    AS hour_bucket,
    COUNT(DISTINCT cr.request_id)      AS concurrent_requests,
    AVG(cr.duration_seconds)           AS avg_request_duration,
    SUM(CASE WHEN rs.is_error THEN 1 ELSE 0 END) AS errors,
    AVG(sp.elapsed_per_exec_sec)       AS avg_sql_elapsed,
    AVG(sp.cpu_ratio)                  AS avg_cpu_ratio,
    SUM(sp.disk_reads)                 AS total_disk_reads,
    SUM(sp.buffer_gets)                AS total_buffer_gets
FROM fact_concurrent_requests  cr
JOIN dim_request_status        rs ON rs.status_sk  = cr.status_sk
LEFT JOIN fact_sql_performance sp ON sp.request_id = cr.request_id
GROUP BY DATE_TRUNC('hour', cr.start_ts)
HAVING COUNT(DISTINCT cr.request_id) > 0
ORDER BY 1
"""

def analyze_load_correlation(pg_conn):
    df = pd.read_sql(CORR_QUERY, pg_conn)
    df = df.dropna(subset=['avg_sql_elapsed'])

    pairs = [
        ('concurrent_requests', 'avg_sql_elapsed',   'Load vs SQL elapsed time'),
        ('concurrent_requests', 'avg_request_duration','Load vs request duration'),
        ('concurrent_requests', 'total_disk_reads',  'Load vs disk reads'),
        ('avg_cpu_ratio',       'avg_request_duration','CPU ratio vs request duration'),
    ]

    print("Pearson correlation analysis:")
    for x_col, y_col, label in pairs:
        r, p = stats.pearsonr(df[x_col].fillna(0), df[y_col].fillna(0))
        sig  = '***' if p < 0.001 else '**' if p < 0.01 else '*' if p < 0.05 else ''
        print(f"  {label:<40} r={r:+.3f}  p={p:.4f} {sig}")

    high_load_threshold = df['concurrent_requests'].quantile(0.75)
    low  = df[df['concurrent_requests'] <  high_load_threshold]['avg_sql_elapsed'].dropna()
    high = df[df['concurrent_requests'] >= high_load_threshold]['avg_sql_elapsed'].dropna()
    t, p = stats.ttest_ind(low, high)
    print(f"\\nSQL elapsed time (low load): {low.mean():.3f}s  |  (high load): {high.mean():.3f}s")
    print(f"t-test p-value: {p:.4f} — {'significant' if p < 0.05 else 'not significant'}")
    return df
\`\`\`

---

## Key Analytical Queries

### Programs With Increasing Duration Trend

\`\`\`sql
WITH weekly_stats AS (
    SELECT
        dp.short_name                              AS program_name,
        DATE_TRUNC('week', cr.start_ts)            AS week_start,
        AVG(cr.duration_seconds)                   AS avg_duration,
        COUNT(*)                                   AS run_count
    FROM fact_concurrent_requests  cr
    JOIN dim_concurrent_program    dp ON dp.program_sk = cr.program_sk
    JOIN dim_request_status        rs ON rs.status_sk  = cr.status_sk
    WHERE rs.is_complete = TRUE
    GROUP BY dp.short_name, DATE_TRUNC('week', cr.start_ts)
),
trend AS (
    SELECT
        program_name,
        week_start,
        avg_duration,
        AVG(avg_duration) OVER (
            PARTITION BY program_name
            ORDER BY week_start
            ROWS BETWEEN 3 PRECEDING AND CURRENT ROW
        ) AS moving_avg_4w,
        LAG(avg_duration, 4) OVER (
            PARTITION BY program_name ORDER BY week_start
        ) AS avg_4w_ago
    FROM weekly_stats
)
SELECT
    program_name,
    week_start,
    avg_duration,
    moving_avg_4w,
    avg_4w_ago,
    ROUND((avg_duration - avg_4w_ago) / NULLIF(avg_4w_ago, 0) * 100, 1) AS pct_change_4w
FROM trend
WHERE avg_4w_ago IS NOT NULL
  AND (avg_duration - avg_4w_ago) / NULLIF(avg_4w_ago, 0) > 0.25
ORDER BY pct_change_4w DESC;
\`\`\`

### SQL IDs Executing During High-Error Windows

\`\`\`sql
SELECT
    sp.sql_id,
    sp.sql_text_snippet,
    COUNT(DISTINCT cr.request_id)       AS requests_during_errors,
    AVG(sp.elapsed_per_exec_sec)        AS avg_elapsed_sec,
    AVG(sp.disk_reads)                  AS avg_disk_reads,
    SUM(CASE WHEN rs.is_error THEN 1 ELSE 0 END) AS error_count
FROM fact_sql_performance    sp
JOIN fact_concurrent_requests cr ON cr.request_id = sp.request_id
JOIN dim_request_status       rs ON rs.status_sk  = cr.status_sk
GROUP BY sp.sql_id, sp.sql_text_snippet
HAVING SUM(CASE WHEN rs.is_error THEN 1 ELSE 0 END) > 0
ORDER BY error_count DESC, avg_elapsed_sec DESC
LIMIT 30;
\`\`\`

### Concurrency Heatmap (Hour × Program)

\`\`\`sql
SELECT
    dp.short_name                          AS program_name,
    EXTRACT(DOW  FROM cr.start_ts)::INT    AS day_of_week,
    EXTRACT(HOUR FROM cr.start_ts)::INT    AS hour_of_day,
    COUNT(*)                               AS runs,
    ROUND(AVG(cr.duration_seconds))        AS avg_seconds,
    MAX(cr.duration_seconds)               AS max_seconds
FROM fact_concurrent_requests  cr
JOIN dim_concurrent_program    dp ON dp.program_sk = cr.program_sk
JOIN dim_request_status        rs ON rs.status_sk  = cr.status_sk
WHERE rs.is_complete = TRUE
GROUP BY dp.short_name, EXTRACT(DOW FROM cr.start_ts), EXTRACT(HOUR FROM cr.start_ts)
ORDER BY dp.short_name, day_of_week, hour_of_day;
\`\`\`

---

## Architecture Summary

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Source (EBS) | Oracle 19c — FND_* tables | Concurrent request history |
| Source (AWR) | Oracle 19c — DBA_HIST_* views | SQL execution statistics |
| Extraction | python-oracledb | Direct Oracle DB connection |
| Staging | PostgreSQL 16 | Star schema DW |
| ETL | Python + psycopg2 | Incremental watermark-based load |
| ML | scikit-learn + scipy | Regression, clustering, anomaly, correlation |
| Scheduling | cron / pg_cron | Hourly incremental loads |

The companion runbook covers every step of the deployment: Oracle privilege grants, Python environment setup, PostgreSQL schema creation, ETL scheduling, and the complete ML script execution workflow.`,
};

async function main() {
  console.log('Inserting EBS concurrent program performance DW blog post...');
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
