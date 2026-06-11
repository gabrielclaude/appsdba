import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'EBS Concurrent Program Performance Data Warehouse: Deployment Runbook',
  slug: 'ebs-concurrent-program-performance-data-warehouse-runbook',
  excerpt:
    'Step-by-step deployment runbook for building the EBS concurrent program performance data warehouse: Oracle privilege grants, Python ETL pipeline setup, PostgreSQL star schema creation, incremental load scheduling, and Python ML analysis scripts for duration prediction, anomaly detection, program clustering, and SQL correlation.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `## Phase 1: Oracle EBS Privilege Grants

All commands run as **SYSDBA** on the Oracle 19c instance hosting EBS 12.2.

### 1.1 Create extraction user

\`\`\`sql
-- Run as SYSDBA
CREATE USER ebs_extract IDENTIFIED BY "ExtractPwd#2026"
  DEFAULT TABLESPACE users
  TEMPORARY TABLESPACE temp
  QUOTA 0 ON users;

GRANT CREATE SESSION TO ebs_extract;
\`\`\`

### 1.2 Grant EBS FND table access

\`\`\`sql
GRANT SELECT ON apps.fnd_concurrent_requests    TO ebs_extract;
GRANT SELECT ON apps.fnd_concurrent_programs    TO ebs_extract;
GRANT SELECT ON apps.fnd_concurrent_programs_tl TO ebs_extract;
GRANT SELECT ON apps.fnd_concurrent_queues      TO ebs_extract;
GRANT SELECT ON apps.fnd_concurrent_queues_tl   TO ebs_extract;
GRANT SELECT ON apps.fnd_user                   TO ebs_extract;
GRANT SELECT ON apps.fnd_application_tl         TO ebs_extract;
GRANT SELECT ON apps.fnd_responsibility_tl      TO ebs_extract;
\`\`\`

### 1.3 Grant AWR access

\`\`\`sql
GRANT SELECT_CATALOG_ROLE TO ebs_extract;

-- Explicit grants for DBA_HIST views (belt and suspenders)
GRANT SELECT ON sys.dba_hist_snapshot             TO ebs_extract;
GRANT SELECT ON sys.dba_hist_sqlstat              TO ebs_extract;
GRANT SELECT ON sys.dba_hist_sqltext              TO ebs_extract;
GRANT SELECT ON sys.dba_hist_active_sess_history  TO ebs_extract;
GRANT SELECT ON sys.dba_hist_sql_plan             TO ebs_extract;
\`\`\`

### 1.4 Create a synonym for convenience

\`\`\`sql
CREATE SYNONYM ebs_extract.fnd_concurrent_requests    FOR apps.fnd_concurrent_requests;
CREATE SYNONYM ebs_extract.fnd_concurrent_programs    FOR apps.fnd_concurrent_programs;
CREATE SYNONYM ebs_extract.fnd_concurrent_programs_tl FOR apps.fnd_concurrent_programs_tl;
CREATE SYNONYM ebs_extract.fnd_concurrent_queues      FOR apps.fnd_concurrent_queues;
CREATE SYNONYM ebs_extract.fnd_concurrent_queues_tl   FOR apps.fnd_concurrent_queues_tl;
CREATE SYNONYM ebs_extract.fnd_user                   FOR apps.fnd_user;
\`\`\`

### 1.5 Verify

\`\`\`sql
CONNECT ebs_extract/"ExtractPwd#2026"@EBSPROD

-- Confirm FND access
SELECT COUNT(*) FROM fnd_concurrent_requests
WHERE actual_start_date > SYSDATE - 1;

-- Confirm AWR access
SELECT COUNT(*) FROM dba_hist_snapshot
WHERE end_interval_time > SYSDATE - 1;
\`\`\`

Expected: both queries return a row count > 0 with no ORA- errors.

---

## Phase 2: PostgreSQL Schema Creation

Connect to the target PostgreSQL 16 instance as a superuser or schema owner.

### 2.1 Create database and schema

\`\`\`sql
CREATE DATABASE ebs_perf_dw;
\\c ebs_perf_dw

CREATE USER dw_owner WITH PASSWORD 'DwOwnerPwd#2026';
ALTER DATABASE ebs_perf_dw OWNER TO dw_owner;
\\c ebs_perf_dw dw_owner
\`\`\`

### 2.2 Dimension tables

\`\`\`sql
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
  ('C','C','Complete','Normal',     TRUE,  FALSE),
  ('C','E','Complete','Error',      TRUE,  TRUE),
  ('C','G','Complete','Warning',    TRUE,  FALSE),
  ('C','X','Complete','Terminated', TRUE,  TRUE),
  ('R','R','Running', 'Running',    FALSE, FALSE),
  ('P','I','Pending', 'Normal',     FALSE, FALSE),
  ('P','S','Pending', 'Scheduled',  FALSE, FALSE),
  ('I','H','Inactive','On Hold',    FALSE, FALSE),
  ('I','X','Inactive','Terminated', FALSE, TRUE);

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

### 2.3 Fact tables

\`\`\`sql
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

CREATE INDEX fact_cr_program_sk ON fact_concurrent_requests (program_sk);
CREATE INDEX fact_cr_start_ts   ON fact_concurrent_requests (start_ts);
CREATE INDEX fact_cr_status_sk  ON fact_concurrent_requests (status_sk);
CREATE INDEX fact_cr_duration   ON fact_concurrent_requests (duration_seconds);

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

### 2.4 Watermark table

\`\`\`sql
CREATE TABLE etl_watermark (
  feed          VARCHAR(50) PRIMARY KEY,
  last_extracted TIMESTAMPTZ NOT NULL
);

INSERT INTO etl_watermark (feed, last_extracted) VALUES
  ('ebs_requests', NOW() - INTERVAL '90 days'),
  ('awr_snapshots', NOW() - INTERVAL '90 days');
\`\`\`

### 2.5 Verify schema

\`\`\`sql
SELECT table_name, pg_size_pretty(pg_total_relation_size(table_name::regclass))
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;
\`\`\`

Expected: 6 tables listed — dim_concurrent_program, dim_request_status, dim_snapshot, etl_watermark, fact_concurrent_requests, fact_sql_performance.

---

## Phase 3: Python ETL Environment

### 3.1 OS prerequisites

\`\`\`bash
# Python 3.11+ required
python3 --version

# Oracle Instant Client 21c (needed by python-oracledb thick mode)
# Download oracle-instantclient21-basiclite-21.x.x.x86_64.rpm from Oracle
sudo rpm -ivh oracle-instantclient21-basiclite-21.x.x.x86_64.rpm
export LD_LIBRARY_PATH=/usr/lib/oracle/21/client64/lib:$LD_LIBRARY_PATH
echo 'export LD_LIBRARY_PATH=/usr/lib/oracle/21/client64/lib:$LD_LIBRARY_PATH' >> ~/.bashrc
\`\`\`

### 3.2 Python virtual environment

\`\`\`bash
python3 -m venv ~/ebs_perf_dw_venv
source ~/ebs_perf_dw_venv/bin/activate
\`\`\`

### 3.3 requirements.txt

\`\`\`
python-oracledb==2.5.0
psycopg2-binary==2.9.10
pandas==2.2.3
numpy==1.26.4
scikit-learn==1.6.1
scipy==1.13.1
\`\`\`

\`\`\`bash
pip install -r requirements.txt
\`\`\`

### 3.4 Environment variables

\`\`\`bash
cat > ~/ebs_perf_dw_venv/.env << 'EOF'
ORACLE_DSN=ebsprod:1521/EBSPROD
ORACLE_USER=ebs_extract
ORACLE_PASSWORD=ExtractPwd#2026
PG_DSN=postgresql://dw_owner:DwOwnerPwd#2026@pg-host:5432/ebs_perf_dw
EOF
chmod 600 ~/ebs_perf_dw_venv/.env
\`\`\`

---

## Phase 4: Full ETL Script (main.py)

\`\`\`python
#!/usr/bin/env python3
"""EBS concurrent program performance DW — incremental ETL main."""

import os
import logging
from datetime import datetime, timedelta, timezone

import oracledb
import psycopg2
from psycopg2.extras import execute_values
from dotenv import load_dotenv

load_dotenv(os.path.expanduser('~/ebs_perf_dw_venv/.env'))
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger(__name__)

# --- Oracle connection -------------------------------------------------

def get_oracle_conn():
    oracledb.init_oracle_client()
    return oracledb.connect(
        user=os.environ['ORACLE_USER'],
        password=os.environ['ORACLE_PASSWORD'],
        dsn=os.environ['ORACLE_DSN'],
    )

# --- PostgreSQL connection ---------------------------------------------

def get_pg_conn():
    return psycopg2.connect(os.environ['PG_DSN'])

# --- Watermark helpers ------------------------------------------------

def get_watermark(pg_conn, feed: str) -> datetime:
    with pg_conn.cursor() as cur:
        cur.execute("SELECT last_extracted FROM etl_watermark WHERE feed = %s", (feed,))
        row = cur.fetchone()
    return row[0] if row else datetime.now(timezone.utc) - timedelta(days=90)

def set_watermark(pg_conn, feed: str, ts: datetime):
    with pg_conn.cursor() as cur:
        cur.execute("""
            INSERT INTO etl_watermark (feed, last_extracted) VALUES (%s, %s)
            ON CONFLICT (feed) DO UPDATE SET last_extracted = EXCLUDED.last_extracted
        """, (feed, ts))
    pg_conn.commit()

# --- EBS extraction ---------------------------------------------------

EBS_QUERY = """
SELECT
    r.request_id,
    r.parent_request_id,
    r.concurrent_program_id,
    p.application_id,
    p.concurrent_program_name,
    t.user_concurrent_program_name,
    p.execution_method_code,
    u.user_name,
    r.phase_code,
    r.status_code,
    r.actual_start_date,
    r.actual_completion_date,
    ROUND((r.actual_completion_date - r.actual_start_date) * 86400, 3) AS duration_seconds,
    ROUND((r.actual_start_date - r.request_date)           * 86400, 3) AS wait_seconds,
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
LEFT JOIN fnd_concurrent_queues    qb ON  qb.concurrent_queue_id = r.controlling_manager
LEFT JOIN fnd_concurrent_queues_tl q  ON  q.concurrent_queue_id  = qb.concurrent_queue_id
                                       AND q.application_id       = qb.application_id
                                       AND q.language              = 'US'
WHERE r.actual_start_date >= :since
  AND r.phase_code IN ('C','R')
ORDER BY r.actual_start_date
"""

def extract_ebs(ora_conn, since: datetime) -> list[dict]:
    log.info("Extracting EBS requests since %s", since)
    with ora_conn.cursor() as cur:
        cur.execute(EBS_QUERY, since=since)
        cols = [d[0].lower() for d in cur.description]
        rows = [dict(zip(cols, row)) for row in cur.fetchall()]
    log.info("Extracted %d EBS requests", len(rows))
    return rows

# --- AWR extraction ---------------------------------------------------

AWR_SNAP_QUERY = """
SELECT snap_id, dbid, instance_number, begin_interval_time, end_interval_time
FROM dba_hist_snapshot
WHERE end_interval_time >= :since
ORDER BY snap_id
"""

AWR_SQL_QUERY = """
SELECT
    st.snap_id,
    st.dbid,
    st.instance_number,
    st.sql_id,
    st.plan_hash_value,
    TO_NUMBER(st.action)         AS request_id,
    st.executions_delta          AS executions,
    st.elapsed_time_delta / 1e6  AS elapsed_sec,
    st.cpu_time_delta     / 1e6  AS cpu_sec,
    st.disk_reads_delta          AS disk_reads,
    st.buffer_gets_delta         AS buffer_gets,
    st.rows_processed_delta      AS rows_processed,
    SUBSTR(tx.sql_text, 1, 200)  AS sql_text
FROM dba_hist_sqlstat   st
LEFT JOIN dba_hist_sqltext tx ON tx.sql_id = st.sql_id AND tx.dbid = st.dbid
WHERE st.snap_id        >= :min_snap
  AND st.module          = 'FND'
  AND st.action         IS NOT NULL
  AND REGEXP_LIKE(st.action, '^[0-9]+$')
  AND st.executions_delta > 0
"""

def extract_awr(ora_conn, since: datetime) -> tuple[list[dict], list[dict]]:
    with ora_conn.cursor() as cur:
        cur.execute(AWR_SNAP_QUERY, since=since)
        snap_cols = [d[0].lower() for d in cur.description]
        snaps     = [dict(zip(snap_cols, r)) for r in cur.fetchall()]
    log.info("Extracted %d AWR snapshots", len(snaps))

    if not snaps:
        return snaps, []

    min_snap = min(s['snap_id'] for s in snaps)
    with ora_conn.cursor() as cur:
        cur.execute(AWR_SQL_QUERY, min_snap=min_snap)
        sql_cols = [d[0].lower() for d in cur.description]
        sqlstat  = [dict(zip(sql_cols, r)) for r in cur.fetchall()]
    log.info("Extracted %d AWR sqlstat rows", len(sqlstat))
    return snaps, sqlstat

# --- PostgreSQL loaders -----------------------------------------------

def load_programs(pg_conn, requests: list[dict]):
    rows = list({
        (r['concurrent_program_id'], r['application_id']): (
            r['concurrent_program_id'],
            r['application_id'],
            r['concurrent_program_name'],
            r['user_concurrent_program_name'],
            r['execution_method_code'],
        )
        for r in requests if r.get('concurrent_program_id')
    }.values())
    if not rows:
        return
    with pg_conn.cursor() as cur:
        execute_values(cur, """
            INSERT INTO dim_concurrent_program
              (concurrent_program_id, application_id, short_name, user_name, execution_method)
            VALUES %s
            ON CONFLICT (concurrent_program_id, application_id) DO UPDATE SET
              short_name       = EXCLUDED.short_name,
              user_name        = EXCLUDED.user_name,
              execution_method = EXCLUDED.execution_method
        """, rows)
    pg_conn.commit()
    log.info("Upserted %d program dimension rows", len(rows))

def load_snapshots(pg_conn, snaps: list[dict]) -> dict:
    if not snaps:
        return {}
    rows = [(
        s['snap_id'], s['dbid'], int(s['instance_number']),
        s['begin_interval_time'], s['end_interval_time'],
        s['begin_interval_time'].hour,
        s['begin_interval_time'].weekday(),
        int(s['begin_interval_time'].strftime('%W')),
        s['begin_interval_time'].month,
        s['begin_interval_time'].year,
        s['begin_interval_time'].weekday() >= 5,
    ) for s in snaps]
    with pg_conn.cursor() as cur:
        execute_values(cur, """
            INSERT INTO dim_snapshot
              (oracle_snap_id, dbid, instance_number, begin_interval_ts, end_interval_ts,
               snap_hour, snap_dow, snap_week, snap_month, snap_year, is_weekend)
            VALUES %s
            ON CONFLICT (oracle_snap_id, dbid, instance_number) DO NOTHING
        """, rows)
        cur.execute("SELECT snapshot_sk, oracle_snap_id, dbid, instance_number FROM dim_snapshot")
        snap_map = {(r[1], r[2], r[3]): r[0] for r in cur.fetchall()}
    pg_conn.commit()
    log.info("Loaded %d snapshots", len(rows))
    return snap_map

def load_requests(pg_conn, requests: list[dict]) -> dict:
    if not requests:
        return {}
    with pg_conn.cursor() as cur:
        cur.execute("SELECT program_sk, concurrent_program_id, application_id FROM dim_concurrent_program")
        prog_map = {(r[1], r[2]): r[0] for r in cur.fetchall()}

    rows = []
    for r in requests:
        if not r.get('actual_start_date'):
            continue
        prog_sk = prog_map.get((r['concurrent_program_id'], r['application_id']))
        phase_status = (r.get('phase_code','C') or 'C') + (r.get('status_code','C') or 'C')
        rows.append((
            r['request_id'], r.get('parent_request_id'),
            prog_sk, phase_status,
            r.get('user_name'), r.get('org_id'), r.get('responsibility_id'),
            r['actual_start_date'], r.get('actual_completion_date'),
            r.get('duration_seconds'), r.get('wait_seconds'),
            r.get('argument_text'), r.get('manager_name'),
        ))
    if not rows:
        return {}

    with pg_conn.cursor() as cur:
        execute_values(cur, """
            INSERT INTO fact_concurrent_requests
              (request_id, parent_request_id, program_sk, status_sk,
               requested_by_user, org_id, responsibility_id,
               start_ts, end_ts, duration_seconds, wait_seconds,
               argument_text, manager_name)
            SELECT r.*, ds.status_sk
            FROM (VALUES %s) AS r(request_id, parent_request_id, program_sk, phase_status,
                 requested_by_user, org_id, responsibility_id, start_ts, end_ts,
                 duration_seconds, wait_seconds, argument_text, manager_name)
            JOIN dim_request_status ds
              ON ds.phase_code || ds.status_code = r.phase_status
            ON CONFLICT (request_id) DO UPDATE SET
              end_ts           = EXCLUDED.end_ts,
              duration_seconds = EXCLUDED.duration_seconds,
              status_sk        = EXCLUDED.status_sk
        """, rows)
    pg_conn.commit()
    log.info("Loaded %d concurrent request rows", len(rows))
    return {}

def load_sqlstat(pg_conn, sqlstat: list[dict], snap_map: dict):
    if not sqlstat:
        return
    rows = []
    for s in sqlstat:
        snap_sk = snap_map.get((s['snap_id'], s['dbid'], int(s.get('instance_number', 1))))
        if not snap_sk:
            continue
        elapsed = float(s['elapsed_sec'] or 0)
        cpu     = float(s['cpu_sec'] or 0)
        execs   = int(s['executions'] or 0)
        rows.append((
            snap_sk, s['request_id'], s['sql_id'], s.get('plan_hash_value'),
            s.get('sql_text'), execs, elapsed, cpu,
            s.get('disk_reads'), s.get('buffer_gets'), s.get('rows_processed'),
            elapsed / execs if execs else None,
            cpu / elapsed   if elapsed else None,
        ))
    if not rows:
        return
    with pg_conn.cursor() as cur:
        execute_values(cur, """
            INSERT INTO fact_sql_performance
              (snapshot_sk, request_id, sql_id, plan_hash_value, sql_text_snippet,
               executions, elapsed_sec, cpu_sec, disk_reads, buffer_gets, rows_processed,
               elapsed_per_exec_sec, cpu_ratio)
            VALUES %s
            ON CONFLICT DO NOTHING
        """, rows)
    pg_conn.commit()
    log.info("Loaded %d SQL performance rows", len(rows))

# --- Main ETL loop ----------------------------------------------------

def run_etl():
    ora = get_oracle_conn()
    pg  = get_pg_conn()
    try:
        ebs_since = get_watermark(pg, 'ebs_requests')
        awr_since = get_watermark(pg, 'awr_snapshots')
        now       = datetime.now(timezone.utc)

        requests         = extract_ebs(ora, ebs_since)
        snaps, sqlstat   = extract_awr(ora, awr_since)

        load_programs(pg, requests)
        snap_map = load_snapshots(pg, snaps)
        load_requests(pg, requests)
        load_sqlstat(pg, sqlstat, snap_map)

        set_watermark(pg, 'ebs_requests', now)
        set_watermark(pg, 'awr_snapshots', now)
        log.info("ETL complete.")
    finally:
        ora.close()
        pg.close()

if __name__ == '__main__':
    run_etl()
\`\`\`

---

## Phase 5: ML Analysis Scripts

### 5.1 Duration regression

\`\`\`bash
cat > ~/ebs_perf_dw/ml/duration_regression.py << 'PYEOF'
import os
import pandas as pd
import numpy as np
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error, r2_score
import psycopg2
from dotenv import load_dotenv

load_dotenv(os.path.expanduser('~/ebs_perf_dw_venv/.env'))

def main():
    pg = psycopg2.connect(os.environ['PG_DSN'])
    df = pd.read_sql("""
        SELECT
            cr.duration_seconds, cr.wait_seconds,
            dp.short_name AS program_name,
            EXTRACT(HOUR  FROM cr.start_ts)  AS start_hour,
            EXTRACT(DOW   FROM cr.start_ts)  AS start_dow,
            EXTRACT(MONTH FROM cr.start_ts)  AS start_month,
            ds.is_weekend,
            COUNT(*) OVER (
                PARTITION BY DATE_TRUNC('hour', cr.start_ts)
            ) AS concurrent_load
        FROM fact_concurrent_requests cr
        JOIN dim_concurrent_program   dp ON dp.program_sk = cr.program_sk
        JOIN dim_request_status       rs ON rs.status_sk  = cr.status_sk
        JOIN dim_snapshot              ds ON ds.begin_interval_ts <= cr.start_ts
                                         AND ds.end_interval_ts   >  cr.start_ts
        WHERE rs.is_complete = TRUE AND rs.is_error = FALSE
          AND cr.duration_seconds > 0
    """, pg)

    df = df.dropna(subset=['duration_seconds'])
    df['log_duration'] = np.log1p(df['duration_seconds'])
    df['log_wait']     = np.log1p(df['wait_seconds'].fillna(0))
    dummies = pd.get_dummies(df['program_name'], prefix='prog', drop_first=True)
    X = pd.concat([df[['start_hour','start_dow','start_month','concurrent_load','log_wait']].astype(float), dummies], axis=1)
    y = df['log_duration']

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    model = GradientBoostingRegressor(n_estimators=300, max_depth=5, learning_rate=0.05, random_state=42)
    model.fit(X_train, y_train)

    preds   = np.expm1(model.predict(X_test))
    actuals = np.expm1(y_test)
    print(f"MAE  : {mean_absolute_error(actuals, preds):.1f} seconds")
    print(f"R²   : {r2_score(np.log1p(actuals), model.predict(X_test)):.4f}")
    print("\nTop 10 features:")
    print(pd.Series(model.feature_importances_, index=X.columns).nlargest(10).to_string())

if __name__ == '__main__':
    main()
PYEOF
\`\`\`

### 5.2 Anomaly detection

\`\`\`bash
cat > ~/ebs_perf_dw/ml/anomaly_detection.py << 'PYEOF'
import os
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler
import psycopg2
from dotenv import load_dotenv

load_dotenv(os.path.expanduser('~/ebs_perf_dw_venv/.env'))

def main():
    pg = psycopg2.connect(os.environ['PG_DSN'])
    df = pd.read_sql("""
        SELECT cr.request_id, cr.start_ts, cr.duration_seconds,
               dp.short_name AS program_name,
               ds.is_weekend,
               EXTRACT(HOUR FROM cr.start_ts) AS start_hour
        FROM fact_concurrent_requests cr
        JOIN dim_concurrent_program   dp ON dp.program_sk = cr.program_sk
        JOIN dim_request_status       rs ON rs.status_sk  = cr.status_sk
        JOIN dim_snapshot              ds ON ds.begin_interval_ts <= cr.start_ts
                                         AND ds.end_interval_ts   >  cr.start_ts
        WHERE rs.is_complete = TRUE AND cr.duration_seconds > 0
    """, pg)

    results = []
    for program, grp in df.groupby('program_name'):
        if len(grp) < 20:
            continue
        X = StandardScaler().fit_transform(grp[['duration_seconds','start_hour']].fillna(0))
        iso = IsolationForest(contamination=0.05, random_state=42)
        g = grp.copy()
        g['anomaly']       = iso.fit_predict(X)
        g['anomaly_score'] = iso.decision_function(X)
        flagged = g[g['anomaly'] == -1].copy()
        flagged['program'] = program
        results.append(flagged)

    if not results:
        print("No anomalies detected.")
        return

    all_anomalies = pd.concat(results)
    print(f"\n{len(all_anomalies)} anomalous requests across {all_anomalies['program'].nunique()} programs")
    print("\nTop 20 anomalies:")
    print(all_anomalies.nsmallest(20, 'anomaly_score')[
        ['program','request_id','start_ts','duration_seconds','anomaly_score']
    ].to_string(index=False))

if __name__ == '__main__':
    main()
PYEOF
\`\`\`

### 5.3 Program clustering

\`\`\`bash
cat > ~/ebs_perf_dw/ml/program_clustering.py << 'PYEOF'
import os
import pandas as pd
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler
import psycopg2
from dotenv import load_dotenv

load_dotenv(os.path.expanduser('~/ebs_perf_dw_venv/.env'))

LABELS = {0:'Fast & Reliable',1:'Slow & I/O Bound',2:'CPU Intensive',3:'Erratic',4:'Rarely Runs'}

def main():
    pg = psycopg2.connect(os.environ['PG_DSN'])
    df = pd.read_sql("""
        SELECT dp.short_name AS program_name,
               COUNT(*)                                        AS total_runs,
               AVG(cr.duration_seconds)                        AS avg_duration,
               PERCENTILE_CONT(0.95) WITHIN GROUP
                 (ORDER BY cr.duration_seconds)                AS p95_duration,
               AVG(sp.cpu_sec)                                 AS avg_cpu_sec,
               AVG(sp.disk_reads)                              AS avg_disk_reads,
               AVG(sp.buffer_gets)                             AS avg_buffer_gets,
               SUM(CASE WHEN rs.is_error THEN 1 ELSE 0 END)::FLOAT
                 / COUNT(*)                                    AS error_rate,
               STDDEV(cr.duration_seconds)
                 / NULLIF(AVG(cr.duration_seconds), 0)         AS cv_duration
        FROM fact_concurrent_requests  cr
        JOIN dim_concurrent_program    dp ON dp.program_sk = cr.program_sk
        JOIN dim_request_status        rs ON rs.status_sk  = cr.status_sk
        LEFT JOIN fact_sql_performance sp ON sp.request_id = cr.request_id
        GROUP BY dp.short_name HAVING COUNT(*) >= 10
    """, pg)

    features = ['avg_duration','p95_duration','avg_cpu_sec','avg_disk_reads','avg_buffer_gets','error_rate','cv_duration']
    X = StandardScaler().fit_transform(df[features].fillna(0))
    df['cluster']       = KMeans(n_clusters=5, random_state=42, n_init=10).fit_predict(X)
    df['cluster_label'] = df['cluster'].map(LABELS)

    for label, grp in df.groupby('cluster_label'):
        print(f"\n--- {label} ({len(grp)} programs) ---")
        print(grp.nlargest(10, 'avg_duration')[['program_name','total_runs','avg_duration','error_rate']].to_string(index=False))

if __name__ == '__main__':
    main()
PYEOF
\`\`\`

### 5.4 SQL-load correlation

\`\`\`bash
cat > ~/ebs_perf_dw/ml/sql_correlation.py << 'PYEOF'
import os
import pandas as pd
import scipy.stats as stats
import psycopg2
from dotenv import load_dotenv

load_dotenv(os.path.expanduser('~/ebs_perf_dw_venv/.env'))

def main():
    pg = psycopg2.connect(os.environ['PG_DSN'])
    df = pd.read_sql("""
        SELECT DATE_TRUNC('hour', cr.start_ts)      AS hour_bucket,
               COUNT(DISTINCT cr.request_id)         AS concurrent_requests,
               AVG(cr.duration_seconds)               AS avg_request_duration,
               SUM(CASE WHEN rs.is_error THEN 1 ELSE 0 END) AS errors,
               AVG(sp.elapsed_per_exec_sec)           AS avg_sql_elapsed,
               AVG(sp.cpu_ratio)                      AS avg_cpu_ratio,
               SUM(sp.disk_reads)                     AS total_disk_reads
        FROM fact_concurrent_requests  cr
        JOIN dim_request_status        rs ON rs.status_sk  = cr.status_sk
        LEFT JOIN fact_sql_performance sp ON sp.request_id = cr.request_id
        GROUP BY DATE_TRUNC('hour', cr.start_ts)
        HAVING COUNT(DISTINCT cr.request_id) > 0
        ORDER BY 1
    """, pg)

    df = df.dropna(subset=['avg_sql_elapsed'])
    pairs = [
        ('concurrent_requests','avg_sql_elapsed','Load vs SQL elapsed time'),
        ('concurrent_requests','avg_request_duration','Load vs request duration'),
        ('concurrent_requests','total_disk_reads','Load vs disk reads'),
        ('avg_cpu_ratio','avg_request_duration','CPU ratio vs request duration'),
    ]
    print("Pearson correlations:")
    for x, y, label in pairs:
        r, p = stats.pearsonr(df[x].fillna(0), df[y].fillna(0))
        sig  = '***' if p < 0.001 else '**' if p < 0.01 else '*' if p < 0.05 else ''
        print(f"  {label:<40} r={r:+.3f}  p={p:.4f} {sig}")

    thr  = df['concurrent_requests'].quantile(0.75)
    low  = df[df['concurrent_requests'] <  thr]['avg_sql_elapsed'].dropna()
    high = df[df['concurrent_requests'] >= thr]['avg_sql_elapsed'].dropna()
    _, p = stats.ttest_ind(low, high)
    print(f"\nSQL elapsed — low load: {low.mean():.3f}s | high load: {high.mean():.3f}s | t-test p={p:.4f}")

if __name__ == '__main__':
    main()
PYEOF
\`\`\`

---

## Phase 6: Scheduling

### 6.1 Cron job (hourly ETL)

\`\`\`bash
crontab -e
\`\`\`

Add:

\`\`\`
10 * * * * source ~/ebs_perf_dw_venv/bin/activate && python ~/ebs_perf_dw/main.py >> /var/log/ebs_perf_dw_etl.log 2>&1
0  2 * * * source ~/ebs_perf_dw_venv/bin/activate && python ~/ebs_perf_dw/ml/anomaly_detection.py >> /var/log/ebs_perf_dw_ml.log 2>&1
0  3 * * 1 source ~/ebs_perf_dw_venv/bin/activate && python ~/ebs_perf_dw/ml/program_clustering.py >> /var/log/ebs_perf_dw_ml.log 2>&1
0  3 * * 1 source ~/ebs_perf_dw_venv/bin/activate && python ~/ebs_perf_dw/ml/duration_regression.py >> /var/log/ebs_perf_dw_ml.log 2>&1
\`\`\`

### 6.2 Log rotation

\`\`\`bash
cat > /etc/logrotate.d/ebs_perf_dw << 'EOF'
/var/log/ebs_perf_dw_*.log {
    daily
    rotate 14
    compress
    missingok
    notifempty
}
EOF
\`\`\`

---

## Phase 7: Validation

### 7.1 Row counts

\`\`\`sql
\\c ebs_perf_dw

SELECT 'dim_concurrent_program'  AS tbl, COUNT(*) FROM dim_concurrent_program
UNION ALL
SELECT 'dim_snapshot',                   COUNT(*) FROM dim_snapshot
UNION ALL
SELECT 'fact_concurrent_requests',       COUNT(*) FROM fact_concurrent_requests
UNION ALL
SELECT 'fact_sql_performance',           COUNT(*) FROM fact_sql_performance
UNION ALL
SELECT 'etl_watermark',                  COUNT(*) FROM etl_watermark
ORDER BY 1;
\`\`\`

### 7.2 Spot check: recent requests

\`\`\`sql
SELECT cr.request_id, dp.short_name, cr.start_ts, cr.duration_seconds, rs.status_desc
FROM fact_concurrent_requests  cr
JOIN dim_concurrent_program    dp ON dp.program_sk = cr.program_sk
JOIN dim_request_status        rs ON rs.status_sk  = cr.status_sk
ORDER BY cr.start_ts DESC
LIMIT 20;
\`\`\`

### 7.3 Confirm SQL linkage

\`\`\`sql
SELECT cr.request_id, sp.sql_id, sp.elapsed_sec, sp.cpu_ratio
FROM fact_concurrent_requests cr
JOIN fact_sql_performance     sp ON sp.request_id = cr.request_id
ORDER BY sp.elapsed_sec DESC
LIMIT 10;
\`\`\`

Expected: rows returned with non-null sql_id values linked to request IDs present in \`fact_concurrent_requests\`.

### 7.4 Check watermarks advanced

\`\`\`sql
SELECT feed, last_extracted FROM etl_watermark ORDER BY feed;
\`\`\`

Expected: both feeds show a timestamp within the last hour.

---

## Troubleshooting

| Symptom | Diagnosis | Fix |
|---------|-----------|-----|
| \`ORA-01031: insufficient privileges\` on FND tables | ebs_extract missing grant | Run Phase 1.2 grants as SYSDBA |
| \`ORA-00942: table or view does not exist\` on DBA_HIST_* | Missing SELECT_CATALOG_ROLE | \`GRANT SELECT_CATALOG_ROLE TO ebs_extract\` |
| ETL finds 0 rows for FND requests | Wrong module filter or no requests in window | Check \`SELECT COUNT(*) FROM apps.fnd_concurrent_requests WHERE actual_start_date > SYSDATE - 1\` directly as APPS |
| \`psycopg2.errors.ForeignKeyViolation\` on status_sk | phase_code+status_code combination not in dim_request_status | Add missing row to dim_request_status |
| ML script returns "insufficient data" | Less than 20 runs per program | Extend the extraction window — re-run ETL with watermark reset to 180 days ago |
| AWR module filter returns 0 rows | EBS session context not set — old EBS or non-standard config | Try \`module LIKE '%FND%'\` and inspect distinct MODULE values from dba_hist_sqlstat |
| Python \`cx_Oracle\` import error | Wrong package name | Library is \`python-oracledb\`, import as \`import oracledb\` |`,
};

async function main() {
  console.log('Inserting EBS concurrent program performance DW runbook...');
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
