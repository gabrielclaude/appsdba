import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'AWR to PostgreSQL Data Warehouse + Python ML: Complete Deployment Runbook',
  slug: 'oracle-awr-data-warehouse-postgresql-python-ml-runbook',
  excerpt:
    'Step-by-step runbook for extracting Oracle AWR data via Data Pump and Python, building a PostgreSQL star schema data warehouse, running an incremental ETL pipeline, and executing Python machine learning analyses — regression, anomaly detection, K-Means clustering, and time-series forecasting — against SQL ID performance data.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-15'),
  youtubeUrl: null,
  content: `## Environment Reference

| Component | Value |
|-----------|-------|
| Oracle DB version | 19c (same works for 12.2+) |
| Oracle host | oradb01.corp.local:1521/ORCL |
| PostgreSQL version | 16 |
| PostgreSQL host | pgdw01.corp.local:5432/awrdw |
| Python version | 3.12 |
| Oracle OS user | oracle |
| DW OS user | awrdw |
| Project directory | /opt/awrdw |

---

## Phase 1 — Oracle: Prepare AWR Export Privileges

### 1.1 Create Dedicated Export User

\`\`\`sql
-- Connect as sysdba:
CREATE USER awr_export IDENTIFIED BY "StrongPassword1#"
  DEFAULT TABLESPACE USERS
  QUOTA UNLIMITED ON USERS;

GRANT CREATE SESSION         TO awr_export;
GRANT SELECT_CATALOG_ROLE    TO awr_export;     -- access to DBA_HIST_* views
GRANT SELECT ON dba_hist_snapshot              TO awr_export;
GRANT SELECT ON dba_hist_sqlstat               TO awr_export;
GRANT SELECT ON dba_hist_sqltext               TO awr_export;
GRANT SELECT ON dba_hist_sql_plan              TO awr_export;
GRANT SELECT ON dba_hist_sysstat               TO awr_export;
GRANT SELECT ON dba_hist_sys_time_model        TO awr_export;
GRANT SELECT ON dba_hist_active_sess_history   TO awr_export;
GRANT SELECT ON v_\$database                    TO awr_export;
GRANT SELECT ON v_\$instance                   TO awr_export;
-- Data Pump export (for bulk historical extract):
GRANT EXP_FULL_DATABASE      TO awr_export;
\`\`\`

### 1.2 Check AWR Retention and Snapshot Frequency

\`\`\`sql
-- Check current AWR settings:
SELECT retention/60/24  AS retention_days,
       snap_interval/60 AS snap_interval_minutes
FROM dba_hist_wr_control;

-- Extend retention to 30 days if shorter (optional — for initial backfill):
BEGIN
  DBMS_WORKLOAD_REPOSITORY.MODIFY_SNAPSHOT_SETTINGS(
    retention => 30 * 24 * 60,   -- 30 days in minutes
    interval  => 60               -- 60 minute snapshots
  );
END;
/

-- Count available snapshots:
SELECT COUNT(*), MIN(begin_interval_time), MAX(end_interval_time)
FROM dba_hist_snapshot;
\`\`\`

---

## Phase 2 — Oracle: Data Pump Historical Backfill

Use Data Pump for the initial bulk extract of historical AWR data (weeks or months). For ongoing incremental loads, use the Python extractor in Phase 5.

### 2.1 Create Oracle Directory Object

\`\`\`sql
-- As sysdba — create an OS directory for the dump files:
CREATE OR REPLACE DIRECTORY AWR_DUMP_DIR AS '/u01/oracle/awr_export';
GRANT READ, WRITE ON DIRECTORY AWR_DUMP_DIR TO awr_export;

-- Verify:
SELECT directory_name, directory_path FROM dba_directories
WHERE directory_name = 'AWR_DUMP_DIR';
\`\`\`

\`\`\`bash
# Create the OS directory as oracle:
su - oracle
mkdir -p /u01/oracle/awr_export
chmod 755 /u01/oracle/awr_export
\`\`\`

### 2.2 Export AWR Tables via expdp

\`\`\`bash
# Export key WRH$ tables (underlying AWR physical tables) with a 365-day filter:
expdp awr_export/"StrongPassword1#" \\
  DIRECTORY=AWR_DUMP_DIR \\
  DUMPFILE=awr_hist_%U.dmp \\
  LOGFILE=awr_hist_export.log \\
  TABLES=SYS.WRH\$_SNAPSHOT,SYS.WRH\$_SQLSTAT,SYS.WRH\$_SQLTEXT,\\
SYS.WRH\$_SQL_PLAN,SYS.WRH\$_SYSSTAT,SYS.WRH\$_SYS_TIME_MODEL \\
  QUERY="WRH\$_SNAPSHOT:\"WHERE BEGIN_INTERVAL_TIME > SYSDATE-365\"" \\
  PARALLEL=4 \\
  COMPRESSION=ALL \\
  FILESIZE=2G
\`\`\`

Monitor export progress:

\`\`\`bash
tail -f /u01/oracle/awr_export/awr_hist_export.log
\`\`\`

### 2.3 Import into Staging Schema

\`\`\`sql
-- Create staging schema to hold the imported AWR tables:
CREATE USER awr_stage IDENTIFIED BY "StrongPassword2#"
  DEFAULT TABLESPACE USERS
  QUOTA UNLIMITED ON USERS;
GRANT CREATE SESSION, CREATE TABLE TO awr_stage;
\`\`\`

\`\`\`bash
# Import, remapping SYS tables into awr_stage:
impdp awr_export/"StrongPassword1#" \\
  DIRECTORY=AWR_DUMP_DIR \\
  DUMPFILE=awr_hist_%U.dmp \\
  LOGFILE=awr_hist_import.log \\
  REMAP_SCHEMA=SYS:awr_stage \\
  REMAP_TABLE=WRH\$_SNAPSHOT:AWR_SNAPSHOT \\
  REMAP_TABLE=WRH\$_SQLSTAT:AWR_SQLSTAT \\
  REMAP_TABLE=WRH\$_SQLTEXT:AWR_SQLTEXT \\
  REMAP_TABLE=WRH\$_SQL_PLAN:AWR_SQL_PLAN \\
  REMAP_TABLE=WRH\$_SYSSTAT:AWR_SYSSTAT \\
  TABLE_EXISTS_ACTION=REPLACE \\
  PARALLEL=4
\`\`\`

Verify imported tables:

\`\`\`sql
SELECT table_name, num_rows
FROM dba_tables
WHERE owner = 'AWR_STAGE'
ORDER BY table_name;
\`\`\`

---

## Phase 3 — PostgreSQL: Create the Data Warehouse Schema

### 3.1 Create Database and User

\`\`\`sql
-- Connect as postgres:
CREATE DATABASE awrdw
  ENCODING 'UTF8'
  LC_COLLATE 'en_US.UTF-8'
  LC_CTYPE   'en_US.UTF-8';

CREATE USER awrdw_user WITH PASSWORD 'DWpassword1#';
GRANT ALL PRIVILEGES ON DATABASE awrdw TO awrdw_user;
\c awrdw
GRANT ALL ON SCHEMA public TO awrdw_user;
\`\`\`

### 3.2 Create Dimension Tables

\`\`\`sql
\c awrdw awrdw_user

CREATE TABLE dim_snapshot (
  snapshot_sk       SERIAL PRIMARY KEY,
  snap_id           INTEGER     NOT NULL,
  dbid              BIGINT      NOT NULL,
  instance_number   SMALLINT    NOT NULL,
  begin_time        TIMESTAMPTZ NOT NULL,
  end_time          TIMESTAMPTZ NOT NULL,
  interval_minutes  INTEGER,
  hour_of_day       SMALLINT,
  day_of_week       SMALLINT,
  week_of_year      SMALLINT,
  month             SMALLINT,
  year              SMALLINT,
  is_business_hours BOOLEAN,
  UNIQUE (snap_id, dbid, instance_number)
);

CREATE TABLE dim_database (
  db_sk           SERIAL PRIMARY KEY,
  dbid            BIGINT      NOT NULL UNIQUE,
  db_name         VARCHAR(9),
  instance_number SMALLINT,
  host_name       VARCHAR(128),
  platform_name   VARCHAR(101),
  db_version      VARCHAR(17)
);

CREATE TABLE dim_sql (
  sql_sk        SERIAL  PRIMARY KEY,
  sql_id        VARCHAR(13) NOT NULL,
  dbid          BIGINT      NOT NULL,
  sql_text      TEXT,
  sql_text_short VARCHAR(200),
  command_type  SMALLINT,
  command_name  VARCHAR(30),
  UNIQUE (sql_id, dbid)
);

CREATE TABLE dim_plan_hash (
  plan_hash_sk     SERIAL PRIMARY KEY,
  sql_id           VARCHAR(13) NOT NULL,
  dbid             BIGINT      NOT NULL,
  plan_hash_value  BIGINT      NOT NULL,
  plan_captured_at TIMESTAMPTZ,
  total_cost       NUMERIC,
  plan_steps       INTEGER,
  has_full_scan    BOOLEAN DEFAULT FALSE,
  has_sort         BOOLEAN DEFAULT FALSE,
  has_hash_join    BOOLEAN DEFAULT FALSE,
  has_nested_loop  BOOLEAN DEFAULT FALSE,
  plan_text        TEXT,
  UNIQUE (sql_id, dbid, plan_hash_value)
);
\`\`\`

### 3.3 Create Fact Table and Aggregate Table

\`\`\`sql
CREATE TABLE fact_sql_performance (
  fact_sk              BIGSERIAL PRIMARY KEY,
  snapshot_sk          INTEGER NOT NULL REFERENCES dim_snapshot(snapshot_sk),
  sql_sk               INTEGER NOT NULL REFERENCES dim_sql(sql_sk),
  db_sk                INTEGER NOT NULL REFERENCES dim_database(db_sk),
  plan_hash_value      BIGINT,
  executions           BIGINT  DEFAULT 0,
  elapsed_time_us      BIGINT  DEFAULT 0,
  cpu_time_us          BIGINT  DEFAULT 0,
  disk_reads           BIGINT  DEFAULT 0,
  buffer_gets          BIGINT  DEFAULT 0,
  rows_processed       BIGINT  DEFAULT 0,
  parse_calls          BIGINT  DEFAULT 0,
  iowait_us            BIGINT  DEFAULT 0,
  clwait_us            BIGINT  DEFAULT 0,
  apwait_us            BIGINT  DEFAULT 0,
  ccwait_us            BIGINT  DEFAULT 0,
  elapsed_ms_per_exec  NUMERIC(12,3),
  cpu_ms_per_exec      NUMERIC(12,3),
  disk_reads_per_exec  NUMERIC(10,2),
  buffer_gets_per_exec NUMERIC(12,2),
  rows_per_exec        NUMERIC(12,2),
  cpu_ratio            NUMERIC(5,4),
  io_ratio             NUMERIC(5,4),
  plan_changed         BOOLEAN DEFAULT FALSE,
  UNIQUE (snapshot_sk, sql_sk)
);

CREATE TABLE agg_sql_hourly (
  agg_sk             BIGSERIAL PRIMARY KEY,
  sql_sk             INTEGER     NOT NULL REFERENCES dim_sql(sql_sk),
  db_sk              INTEGER     NOT NULL REFERENCES dim_database(db_sk),
  hour_bucket        TIMESTAMPTZ NOT NULL,
  snapshot_count     INTEGER,
  total_executions   BIGINT,
  avg_elapsed_ms     NUMERIC(12,3),
  p50_elapsed_ms     NUMERIC(12,3),
  p95_elapsed_ms     NUMERIC(12,3),
  p99_elapsed_ms     NUMERIC(12,3),
  max_elapsed_ms     NUMERIC(12,3),
  total_buffer_gets  BIGINT,
  total_disk_reads   BIGINT,
  plan_changes       INTEGER,
  UNIQUE (sql_sk, db_sk, hour_bucket)
);

-- Watermark table — tracks last loaded snapshot per database:
CREATE TABLE etl_watermark (
  dbid            BIGINT PRIMARY KEY,
  last_snap_id    INTEGER,
  last_loaded_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes:
CREATE INDEX ON fact_sql_performance (snapshot_sk);
CREATE INDEX ON fact_sql_performance (sql_sk);
CREATE INDEX ON fact_sql_performance (db_sk);
CREATE INDEX ON fact_sql_performance (plan_changed) WHERE plan_changed = TRUE;
CREATE INDEX ON dim_snapshot (begin_time);
CREATE INDEX ON dim_snapshot (dbid, snap_id);
CREATE INDEX ON agg_sql_hourly (sql_sk, hour_bucket);
\`\`\`

---

## Phase 4 — Python Environment Setup

### 4.1 Create Project Directory

\`\`\`bash
useradd -m awrdw
mkdir -p /opt/awrdw/{etl,ml,logs,models,data}
chown -R awrdw:awrdw /opt/awrdw
su - awrdw
\`\`\`

### 4.2 Create Virtual Environment

\`\`\`bash
cd /opt/awrdw
python3.12 -m venv .venv
source .venv/bin/activate

pip install --upgrade pip
pip install \
  oracledb==2.3.0 \
  psycopg2-binary==2.9.9 \
  sqlalchemy==2.0.35 \
  pandas==2.2.2 \
  numpy==1.26.4 \
  scikit-learn==1.5.1 \
  prophet==1.1.5 \
  matplotlib==3.9.2 \
  seaborn==0.13.2 \
  python-dotenv==1.0.1 \
  click==8.1.7

pip freeze > requirements.txt
\`\`\`

### 4.3 Configuration File

\`\`\`bash
cat > /opt/awrdw/.env << 'EOF'
ORA_USER=awr_export
ORA_PASSWORD=StrongPassword1#
ORA_DSN=oradb01.corp.local:1521/ORCL
ORA_DBID=1234567890

PG_DSN=postgresql://awrdw_user:DWpassword1#@pgdw01.corp.local:5432/awrdw

LOG_DIR=/opt/awrdw/logs
MODEL_DIR=/opt/awrdw/models
EOF
chmod 600 /opt/awrdw/.env
\`\`\`

---

## Phase 5 — ETL Pipeline

### 5.1 etl/extract.py

\`\`\`python
#!/usr/bin/env python3
"""Incremental AWR extractor — Oracle -> PostgreSQL."""
import os, logging
from datetime import datetime, timezone
from dotenv import load_dotenv
import oracledb
import psycopg2
import psycopg2.extras

load_dotenv('/opt/awrdw/.env')
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
    handlers=[
        logging.FileHandler(f"{os.environ['LOG_DIR']}/etl.log"),
        logging.StreamHandler(),
    ]
)
log = logging.getLogger(__name__)

SQLSTAT_QUERY = """
SELECT
    sn.snap_id,
    sn.dbid,
    sn.instance_number,
    sn.begin_interval_time,
    sn.end_interval_time,
    s.sql_id,
    s.plan_hash_value,
    NVL(s.executions_delta,0)    AS executions_delta,
    NVL(s.elapsed_time_delta,0)  AS elapsed_time_delta,
    NVL(s.cpu_time_delta,0)      AS cpu_time_delta,
    NVL(s.disk_reads_delta,0)    AS disk_reads_delta,
    NVL(s.buffer_gets_delta,0)   AS buffer_gets_delta,
    NVL(s.rows_processed_delta,0) AS rows_processed_delta,
    NVL(s.parse_calls_delta,0)   AS parse_calls_delta,
    NVL(s.iowait_delta,0)        AS iowait_delta,
    NVL(s.clwait_delta,0)        AS clwait_delta,
    NVL(s.apwait_delta,0)        AS apwait_delta,
    NVL(s.ccwait_delta,0)        AS ccwait_delta
FROM dba_hist_sqlstat s
JOIN dba_hist_snapshot sn
  ON sn.snap_id        = s.snap_id
 AND sn.dbid           = s.dbid
 AND sn.instance_number= s.instance_number
WHERE sn.snap_id > :since_snap
  AND sn.dbid    = :dbid
  AND s.executions_delta > 0
ORDER BY sn.snap_id, s.sql_id
"""

SQLTEXT_QUERY = """
SELECT sql_id, sql_text, command_type
FROM dba_hist_sqltext
WHERE dbid = :dbid
  AND sql_id IN ({placeholders})
"""

def get_watermark(pg, dbid: int) -> int:
    with pg.cursor() as cur:
        cur.execute("SELECT last_snap_id FROM etl_watermark WHERE dbid = %s", (dbid,))
        row = cur.fetchone()
        return row[0] if row else 0

def set_watermark(pg, dbid: int, snap_id: int):
    with pg.cursor() as cur:
        cur.execute("""
            INSERT INTO etl_watermark (dbid, last_snap_id, last_loaded_at)
            VALUES (%s, %s, NOW())
            ON CONFLICT (dbid) DO UPDATE
              SET last_snap_id = EXCLUDED.last_snap_id,
                  last_loaded_at = NOW()
        """, (dbid, snap_id))
    pg.commit()

def upsert_db_dim(pg, dbid, db_name, host_name, platform_name, version) -> int:
    with pg.cursor() as cur:
        cur.execute("""
            INSERT INTO dim_database (dbid, db_name, host_name, platform_name, db_version)
            VALUES (%s,%s,%s,%s,%s)
            ON CONFLICT (dbid) DO UPDATE SET
              db_name = EXCLUDED.db_name, host_name = EXCLUDED.host_name
            RETURNING db_sk
        """, (dbid, db_name, host_name, platform_name, version))
        return cur.fetchone()[0]

def upsert_snapshot_dim(pg, snap_id, dbid, inst, begin_dt, end_dt) -> int:
    from datetime import timedelta
    interval = int((end_dt - begin_dt).total_seconds() / 60)
    biz = (1 <= begin_dt.isoweekday() <= 5) and (8 <= begin_dt.hour < 18)
    with pg.cursor() as cur:
        cur.execute("""
            INSERT INTO dim_snapshot
              (snap_id,dbid,instance_number,begin_time,end_time,
               interval_minutes,hour_of_day,day_of_week,
               week_of_year,month,year,is_business_hours)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (snap_id,dbid,instance_number)
            DO UPDATE SET end_time = EXCLUDED.end_time
            RETURNING snapshot_sk
        """, (snap_id, dbid, inst, begin_dt, end_dt, interval,
              begin_dt.hour, begin_dt.isoweekday(),
              begin_dt.isocalendar()[1],
              begin_dt.month, begin_dt.year, biz))
        return cur.fetchone()[0]

def upsert_sql_dims(pg, dbid, sql_texts: dict) -> dict:
    """sql_texts: {sql_id: (text, command_type)}. Returns {sql_id: sql_sk}."""
    result = {}
    COMMANDS = {1:'SELECT',2:'INSERT',3:'SELECT',6:'UPDATE',7:'DELETE',47:'PL/SQL'}
    with pg.cursor() as cur:
        for sql_id, (text, ctype) in sql_texts.items():
            cur.execute("""
                INSERT INTO dim_sql (sql_id,dbid,sql_text,sql_text_short,command_type,command_name)
                VALUES (%s,%s,%s,%s,%s,%s)
                ON CONFLICT (sql_id,dbid)
                DO UPDATE SET sql_text = COALESCE(EXCLUDED.sql_text, dim_sql.sql_text)
                RETURNING sql_sk
            """, (sql_id, dbid, text, (text or '')[:200], ctype,
                  COMMANDS.get(ctype,'OTHER')))
            result[sql_id] = cur.fetchone()[0]
    return result

def load_facts(pg, records):
    with pg.cursor() as cur:
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

def run():
    dbid = int(os.environ['ORA_DBID'])
    ora = oracledb.connect(user=os.environ['ORA_USER'],
                           password=os.environ['ORA_PASSWORD'],
                           dsn=os.environ['ORA_DSN'])
    pg  = psycopg2.connect(os.environ['PG_DSN'])
    pg.autocommit = False

    # Get source DB metadata:
    with ora.cursor() as c:
        c.execute("SELECT name FROM v\$database")
        db_name = c.fetchone()[0]
        c.execute("SELECT host_name, platform_name, version FROM v\$instance")
        host, platform, version = c.fetchone()
    db_sk = upsert_db_dim(pg, dbid, db_name, host, platform, version)

    watermark = get_watermark(pg, dbid)
    log.info(f"Extracting {db_name} (dbid={dbid}) from snap_id > {watermark}")

    with ora.cursor() as c:
        c.execute(SQLSTAT_QUERY, since_snap=watermark, dbid=dbid)
        cols = [d[0].lower() for d in c.description]
        rows = [dict(zip(cols, r)) for r in c.fetchall()]

    if not rows:
        log.info("No new snapshots to load.")
        return

    log.info(f"Fetched {len(rows)} sqlstat rows")

    # Fetch SQL text for all unique sql_ids in this batch:
    sql_ids = list({r['sql_id'] for r in rows})
    sql_texts = {}
    BATCH = 999
    for i in range(0, len(sql_ids), BATCH):
        batch = sql_ids[i:i+BATCH]
        ph = ','.join([':b' + str(j) for j in range(len(batch))])
        with ora.cursor() as c:
            c.execute(
                f"SELECT sql_id, sql_text, command_type FROM dba_hist_sqltext "
                f"WHERE dbid = :dbid AND sql_id IN ({ph})",
                dict({'dbid': dbid}, **{'b'+str(j): batch[j] for j in range(len(batch))})
            )
            for sql_id, text, ctype in c:
                sql_texts[sql_id] = (text, ctype or 0)

    # Build dimension lookups:
    snap_map = {}
    for r in rows:
        key = r['snap_id']
        if key not in snap_map:
            snap_map[key] = upsert_snapshot_dim(
                pg, r['snap_id'], r['dbid'], r['instance_number'],
                r['begin_interval_time'], r['end_interval_time']
            )

    sql_map = upsert_sql_dims(pg, dbid, sql_texts)

    # Build fact records with derived metrics:
    prev_plans = {}
    records = []
    for r in rows:
        sql_id   = r['sql_id']
        snap_sk  = snap_map[r['snap_id']]
        sql_sk   = sql_map.get(sql_id)
        if sql_sk is None:
            continue

        ex  = max(r['executions_delta'], 0)
        el  = max(r['elapsed_time_delta'], 0)
        cpu = max(r['cpu_time_delta'], 0)
        dr  = max(r['disk_reads_delta'], 0)
        bg  = max(r['buffer_gets_delta'], 0)

        el_ms = (el  / ex / 1000.0) if ex > 0 else 0
        cp_ms = (cpu / ex / 1000.0) if ex > 0 else 0
        dr_px = (dr  / ex)           if ex > 0 else 0
        bg_px = (bg  / ex)           if ex > 0 else 0
        rw_px = (max(r['rows_processed_delta'],0) / ex) if ex > 0 else 0
        cpu_r = (cpu / el) if el > 0 else None
        io_r  = (max(r['iowait_delta'],0) / el) if el > 0 else None

        prev = prev_plans.get(sql_id)
        changed = prev is not None and prev != r['plan_hash_value'] and ex > 0
        prev_plans[sql_id] = r['plan_hash_value']

        records.append((
            snap_sk, sql_sk, db_sk, r['plan_hash_value'],
            ex, el, cpu, dr, bg,
            max(r['rows_processed_delta'],0),
            max(r['parse_calls_delta'],0),
            max(r['iowait_delta'],0),
            max(r['clwait_delta'],0),
            max(r['apwait_delta'],0),
            max(r['ccwait_delta'],0),
            el_ms, cp_ms, dr_px, bg_px, rw_px,
            cpu_r, io_r, changed,
        ))

    load_facts(pg, records)
    max_snap = max(r['snap_id'] for r in rows)
    set_watermark(pg, dbid, max_snap)
    pg.commit()
    log.info(f"Loaded {len(records)} facts. New watermark: snap_id={max_snap}")

    # Refresh hourly aggregates for the loaded period:
    refresh_hourly_agg(pg, db_sk)
    ora.close()
    pg.close()

def refresh_hourly_agg(pg, db_sk: int):
    with pg.cursor() as cur:
        cur.execute("""
            INSERT INTO agg_sql_hourly
              (sql_sk, db_sk, hour_bucket, snapshot_count, total_executions,
               avg_elapsed_ms, p50_elapsed_ms, p95_elapsed_ms, p99_elapsed_ms,
               max_elapsed_ms, total_buffer_gets, total_disk_reads, plan_changes)
            SELECT
              f.sql_sk,
              f.db_sk,
              date_trunc('hour', sn.begin_time)   AS hour_bucket,
              COUNT(*)                              AS snapshot_count,
              SUM(f.executions)                    AS total_executions,
              AVG(f.elapsed_ms_per_exec)           AS avg_elapsed_ms,
              PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY f.elapsed_ms_per_exec) AS p50,
              PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY f.elapsed_ms_per_exec) AS p95,
              PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY f.elapsed_ms_per_exec) AS p99,
              MAX(f.elapsed_ms_per_exec)           AS max_elapsed_ms,
              SUM(f.buffer_gets)                   AS total_buffer_gets,
              SUM(f.disk_reads)                    AS total_disk_reads,
              SUM(f.plan_changed::int)             AS plan_changes
            FROM fact_sql_performance f
            JOIN dim_snapshot sn ON sn.snapshot_sk = f.snapshot_sk
            WHERE f.db_sk = %s
              AND sn.begin_time > NOW() - INTERVAL '48 hours'
            GROUP BY f.sql_sk, f.db_sk, date_trunc('hour', sn.begin_time)
            ON CONFLICT (sql_sk, db_sk, hour_bucket) DO UPDATE SET
              snapshot_count   = EXCLUDED.snapshot_count,
              total_executions = EXCLUDED.total_executions,
              avg_elapsed_ms   = EXCLUDED.avg_elapsed_ms,
              p95_elapsed_ms   = EXCLUDED.p95_elapsed_ms,
              plan_changes     = EXCLUDED.plan_changes
        """, (db_sk,))
    pg.commit()
    log.info("Hourly aggregates refreshed.")

if __name__ == '__main__':
    run()
\`\`\`

### 5.2 Schedule with Cron

\`\`\`bash
crontab -e   # as awrdw user

# Run ETL every hour, 10 minutes after the hour (after AWR snapshot completes):
10 * * * * cd /opt/awrdw && source .venv/bin/activate && python etl/extract.py >> logs/cron.log 2>&1
\`\`\`

---

## Phase 6 — ML Analysis Scripts

### 6.1 ml/regression.py — Train Performance Predictor

\`\`\`python
#!/usr/bin/env python3
"""Train a GBM regression model to predict elapsed_ms_per_exec."""
import os, joblib, logging
import pandas as pd, numpy as np
from sqlalchemy import create_engine
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.model_selection import train_test_split, cross_val_score
from sklearn.metrics import mean_absolute_error, r2_score
from dotenv import load_dotenv

load_dotenv('/opt/awrdw/.env')
log = logging.getLogger(__name__)
engine = create_engine(os.environ['PG_DSN'])

df = pd.read_sql("""
    SELECT f.elapsed_ms_per_exec, f.cpu_ms_per_exec,
           f.disk_reads_per_exec, f.buffer_gets_per_exec,
           f.rows_per_exec, COALESCE(f.cpu_ratio,0) AS cpu_ratio,
           COALESCE(f.io_ratio,0) AS io_ratio, f.executions,
           sn.hour_of_day, sn.day_of_week,
           sn.is_business_hours::int AS is_business_hours,
           sn.interval_minutes,
           f.plan_changed::int AS plan_changed,
           sq.command_type
    FROM fact_sql_performance f
    JOIN dim_snapshot sn ON sn.snapshot_sk = f.snapshot_sk
    JOIN dim_sql sq      ON sq.sql_sk      = f.sql_sk
    WHERE f.executions > 5
      AND f.elapsed_ms_per_exec BETWEEN 0.1 AND 300000
""", engine)

FEATURES = ['disk_reads_per_exec','buffer_gets_per_exec','rows_per_exec',
            'cpu_ratio','io_ratio','executions','hour_of_day','day_of_week',
            'is_business_hours','interval_minutes','plan_changed','command_type']

X = df[FEATURES].fillna(0)
y = np.log1p(df['elapsed_ms_per_exec'])

X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.2, random_state=42)
model = GradientBoostingRegressor(n_estimators=300, max_depth=5,
                                  learning_rate=0.05, subsample=0.8,
                                  random_state=42)
model.fit(X_tr, y_tr)
y_pred = model.predict(X_te)
print(f"MAE: {mean_absolute_error(np.expm1(y_te),np.expm1(y_pred)):.1f} ms")
print(f"R²:  {r2_score(y_te, y_pred):.3f}")

imp = pd.Series(model.feature_importances_, index=FEATURES)
print("\nFeature Importances:")
print(imp.sort_values(ascending=False).to_string())

joblib.dump({'model': model, 'features': FEATURES},
            f"{os.environ['MODEL_DIR']}/regression_model.pkl")
print("Model saved.")
\`\`\`

### 6.2 ml/anomaly.py — Detect Regressions per SQL ID

\`\`\`python
#!/usr/bin/env python3
"""Scan all SQL IDs for performance anomalies. Output: anomalies.csv"""
import os, pandas as pd, numpy as np
from sqlalchemy import create_engine
from sklearn.ensemble import IsolationForest
from dotenv import load_dotenv

load_dotenv('/opt/awrdw/.env')
engine = create_engine(os.environ['PG_DSN'])

# Load SQL IDs with enough history (>= 30 snapshots):
sql_ids = pd.read_sql("""
    SELECT sq.sql_id, sq.sql_text_short, f.sql_sk
    FROM fact_sql_performance f
    JOIN dim_sql sq ON sq.sql_sk = f.sql_sk
    GROUP BY sq.sql_id, sq.sql_text_short, f.sql_sk
    HAVING COUNT(*) >= 30
""", engine)

FEATURES = ['elapsed_ms_per_exec','buffer_gets_per_exec',
            'disk_reads_per_exec','cpu_ratio','io_ratio','executions']
all_anomalies = []

for _, row in sql_ids.iterrows():
    hist = pd.read_sql(f"""
        SELECT sn.begin_time, {', '.join('f.'+c for c in FEATURES)},
               f.plan_changed
        FROM fact_sql_performance f
        JOIN dim_snapshot sn ON sn.snapshot_sk = f.snapshot_sk
        WHERE f.sql_sk = {row['sql_sk']} AND f.executions > 0
        ORDER BY sn.begin_time
    """, engine)

    X = hist[FEATURES].fillna(0)
    if len(X) < 20:
        continue

    split = max(int(len(X)*0.8), 10)
    iso = IsolationForest(contamination=0.05, random_state=42)
    iso.fit(X.iloc[:split])
    scores = iso.decision_function(X)
    preds  = iso.predict(X)

    median_el = hist['elapsed_ms_per_exec'].median()
    regressions = hist[
        (preds == -1) &
        (hist['elapsed_ms_per_exec'] > median_el * 2) &
        (hist.index >= split)
    ].copy()

    if not regressions.empty:
        regressions['sql_id']       = row['sql_id']
        regressions['sql_text']     = row['sql_text_short']
        regressions['anomaly_score']= scores[regressions.index]
        regressions['median_ms']    = median_el
        all_anomalies.append(regressions)

if all_anomalies:
    out = pd.concat(all_anomalies, ignore_index=True)
    out = out.sort_values('begin_time', ascending=False)
    out.to_csv(f"{os.environ.get('LOG_DIR','/opt/awrdw/logs')}/anomalies.csv", index=False)
    print(f"Found {len(out)} anomaly events across {out['sql_id'].nunique()} SQL IDs")
    print(out[['begin_time','sql_id','elapsed_ms_per_exec','median_ms','plan_changed']].head(20).to_string())
else:
    print("No anomalies detected.")
\`\`\`

### 6.3 ml/cluster.py — Profile SQL IDs by Performance Cluster

\`\`\`python
#!/usr/bin/env python3
"""K-Means clustering of SQL IDs by aggregate performance profile."""
import os, pandas as pd, numpy as np
from sqlalchemy import create_engine
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler
from dotenv import load_dotenv

load_dotenv('/opt/awrdw/.env')
engine = create_engine(os.environ['PG_DSN'])

profiles = pd.read_sql("""
    SELECT sq.sql_id, sq.sql_text_short, sq.command_name,
           AVG(f.elapsed_ms_per_exec)     AS avg_elapsed_ms,
           PERCENTILE_CONT(0.95) WITHIN GROUP
             (ORDER BY f.elapsed_ms_per_exec) AS p95_elapsed_ms,
           AVG(f.buffer_gets_per_exec)    AS avg_buffer_gets,
           AVG(f.disk_reads_per_exec)     AS avg_disk_reads,
           AVG(COALESCE(f.cpu_ratio,0))   AS avg_cpu_ratio,
           AVG(COALESCE(f.io_ratio,0))    AS avg_io_ratio,
           SUM(f.executions)              AS total_executions,
           SUM(f.plan_changed::int)       AS plan_changes
    FROM fact_sql_performance f
    JOIN dim_sql sq ON sq.sql_sk = f.sql_sk
    WHERE f.executions > 10
    GROUP BY sq.sql_id, sq.sql_text_short, sq.command_name
    HAVING COUNT(*) > 20
""", engine)

CF = ['avg_elapsed_ms','p95_elapsed_ms','avg_buffer_gets',
      'avg_disk_reads','avg_cpu_ratio','avg_io_ratio']

scaler = StandardScaler()
X = scaler.fit_transform(profiles[CF].fillna(0))

kmeans = KMeans(n_clusters=5, random_state=42, n_init=15)
profiles['cluster'] = kmeans.fit_predict(X)

summary = profiles.groupby('cluster')[CF+['plan_changes']].mean().round(2)
summary['count'] = profiles.groupby('cluster').size()
print("Cluster Profiles:")
print(summary.sort_values('avg_elapsed_ms').to_string())

# Top candidates from the worst cluster:
worst = profiles.groupby('cluster')['avg_elapsed_ms'].mean().idxmax()
print(f"\nCluster {worst} — Top SQL candidates for tuning:")
top = profiles[profiles['cluster']==worst].sort_values('p95_elapsed_ms',ascending=False).head(15)
print(top[['sql_id','avg_elapsed_ms','p95_elapsed_ms','plan_changes','sql_text_short']].to_string())
\`\`\`

### 6.4 ml/forecast.py — Time Series Forecast for a SQL ID

\`\`\`python
#!/usr/bin/env python3
"""Prophet forecast for a specific SQL ID. Usage: python forecast.py <sql_id>"""
import os, sys
import pandas as pd
from sqlalchemy import create_engine
from prophet import Prophet
from dotenv import load_dotenv

load_dotenv('/opt/awrdw/.env')
engine = create_engine(os.environ['PG_DSN'])

SQL_ID = sys.argv[1] if len(sys.argv) > 1 else sys.exit("Usage: forecast.py <sql_id>")
SLO_MS = float(sys.argv[2]) if len(sys.argv) > 2 else 1000.0

ts = pd.read_sql("""
    SELECT hour_bucket AS ds, avg_elapsed_ms AS y
    FROM agg_sql_hourly ah
    JOIN dim_sql sq ON sq.sql_sk = ah.sql_sk
    WHERE sq.sql_id = %(sql_id)s AND avg_elapsed_ms > 0
    ORDER BY hour_bucket
""", engine, params={'sql_id': SQL_ID})

if len(ts) < 48:
    print(f"Insufficient data for {SQL_ID} ({len(ts)} hourly points, need >= 48)")
    sys.exit(1)

m = Prophet(weekly_seasonality=True, daily_seasonality=True,
            yearly_seasonality=False, changepoint_prior_scale=0.1)
m.fit(ts)

future   = m.make_future_dataframe(periods=168, freq='h')
forecast = m.predict(future)

future_only = forecast[forecast['ds'] > ts['ds'].max()]
breaches = future_only[future_only['yhat_upper'] > SLO_MS]

print(f"\nSQL ID: {SQL_ID}")
print(f"SLO threshold: {SLO_MS} ms")
print(f"Training period: {ts['ds'].min()} → {ts['ds'].max()}")
print(f"Forecast: next 168 hours")
if breaches.empty:
    print("No SLO breaches forecast in the next 7 days.")
else:
    print(f"WARNING: {len(breaches)} hours forecast to exceed SLO:")
    print(breaches[['ds','yhat','yhat_lower','yhat_upper']].head(10).to_string())
\`\`\`

---

## Phase 7 — Validation Queries

### 7.1 Verify Fact Table Load

\`\`\`sql
-- Row counts per database:
SELECT d.db_name, d.dbid, COUNT(*) AS fact_rows,
       MIN(sn.begin_time) AS earliest, MAX(sn.begin_time) AS latest
FROM fact_sql_performance f
JOIN dim_database d  ON d.db_sk      = f.db_sk
JOIN dim_snapshot sn ON sn.snapshot_sk = f.snapshot_sk
GROUP BY d.db_name, d.dbid;

-- ETL watermark status:
SELECT e.dbid, d.db_name, e.last_snap_id, e.last_loaded_at,
       NOW() - e.last_loaded_at AS age
FROM etl_watermark e
JOIN dim_database d ON d.dbid = e.dbid;
\`\`\`

### 7.2 Top SQL by Total Elapsed Time (Last 7 Days)

\`\`\`sql
SELECT sq.sql_id, sq.sql_text_short, sq.command_name,
       SUM(f.executions)                  AS total_execs,
       ROUND(SUM(f.elapsed_time_us)/1e9,1) AS total_elapsed_sec,
       ROUND(AVG(f.elapsed_ms_per_exec),2) AS avg_ms,
       SUM(f.plan_changed::int)            AS plan_changes
FROM fact_sql_performance f
JOIN dim_sql sq      ON sq.sql_sk      = f.sql_sk
JOIN dim_snapshot sn ON sn.snapshot_sk = f.snapshot_sk
WHERE sn.begin_time > NOW() - INTERVAL '7 days'
GROUP BY sq.sql_id, sq.sql_text_short, sq.command_name
ORDER BY total_elapsed_sec DESC
LIMIT 20;
\`\`\`

### 7.3 SQL IDs with Plan Changes in Last 48 Hours

\`\`\`sql
SELECT sq.sql_id, sn.begin_time,
       f.plan_hash_value,
       f.elapsed_ms_per_exec,
       f.buffer_gets_per_exec,
       LAG(f.plan_hash_value) OVER (PARTITION BY f.sql_sk ORDER BY sn.begin_time) AS prev_plan,
       LAG(f.elapsed_ms_per_exec) OVER (PARTITION BY f.sql_sk ORDER BY sn.begin_time) AS prev_ms
FROM fact_sql_performance f
JOIN dim_sql sq      ON sq.sql_sk      = f.sql_sk
JOIN dim_snapshot sn ON sn.snapshot_sk = f.snapshot_sk
WHERE f.plan_changed = TRUE
  AND sn.begin_time > NOW() - INTERVAL '48 hours'
ORDER BY sn.begin_time DESC;
\`\`\`

---

## Troubleshooting Reference

| Symptom | Check | Fix |
|---------|-------|-----|
| expdp fails: insufficient privileges | \`EXP_FULL_DATABASE\` grant | \`GRANT EXP_FULL_DATABASE TO awr_export;\` |
| expdp fails: ORA-39070 DIRECTORY not found | \`dba_directories\` | \`CREATE DIRECTORY AWR_DUMP_DIR AS '/path';\` |
| Python \`oracledb.DatabaseError: ORA-01017\` | Wrong credentials | Check \`.env\` ORA_USER/ORA_PASSWORD |
| Python \`psycopg2.OperationalError\` | PG connection | Check PG_DSN, firewall, pg_hba.conf |
| ETL loads 0 rows | Watermark ahead of data | Check \`etl_watermark\` vs \`dba_hist_snapshot\` max snap_id |
| ML model: poor R² (<0.5) | Insufficient data or too many outliers | Filter \`elapsed_ms_per_exec < 60000\`, require \`executions > 20\` |
| Anomaly detection: too many alerts | contamination too high | Reduce \`IsolationForest(contamination=0.02)\` |
| Prophet forecast error | < 48 data points | Ensure SQL ID has > 48 hourly entries in \`agg_sql_hourly\` |`,
};

async function main() {
  console.log('Inserting AWR DW ML runbook...');
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
