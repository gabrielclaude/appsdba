import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle 19c Distributed MV Hang: Deployment and Monitoring Runbook',
  slug: 'oracle-19c-materialized-view-distributed-query-hang-runbook',
  excerpt:
    'Step-by-step runbook for deploying the three-tier materialized view architecture that bypasses the Oracle 19c distributed query hang bug: DDL execution order, index strategy, refresh group configuration, refresh lag monitoring, and a diagnostic script for hung remote MV refreshes.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `## Scope

This runbook applies to Oracle Database 19c environments where a \`CREATE MATERIALIZED VIEW\` statement hangs indefinitely when the defining query joins local schema tables with remote tables via a database link. It covers the complete deployment of the three-tier MV workaround, refresh scheduling, and an ongoing monitoring script.

**Symptoms triggering this runbook:**
- \`CREATE MATERIALIZED VIEW ... BUILD IMMEDIATE\` session hangs with no DB errors
- Session wait event shows \`library cache lock\` or \`SQL*Net message from dblink\`
- The identical query runs successfully as a plain \`SELECT\`
- Problem only occurs when the query mixes local and remote (\`@DBLINK\`) objects

---

## Pre-Deployment Checklist

### 1. Confirm the standalone SELECT completes

Before deploying the workaround, confirm the underlying query is logically correct and executes in reasonable time:

\`\`\`sql
SET TIMING ON SERVEROUTPUT ON

-- Substitute your actual query here
SELECT COUNT(*)
FROM (
    SELECT p.customer_id, p.phone_id, t.type_name,
           c.region_id, c.account_id
    FROM   remote_table_phone@remote_link p
    JOIN   remote_table_type@remote_link  t ON t.type_id   = p.phone_type_id
    JOIN   local_schema.customers         c ON c.customer_id = p.customer_id
    JOIN   local_schema.orders            o ON o.order_id   = c.order_id
    WHERE  o.order_date >= TRUNC(SYSDATE) - 5
      AND  o.status_id   = 9
      AND  t.status      = 'ACTIVE'
);
\`\`\`

If this returns in under 5 minutes and produces the expected row count, proceed to deployment.

### 2. Verify dblink connectivity

\`\`\`sql
-- Test the database link is alive and the remote objects are accessible
SELECT COUNT(*) FROM remote_table_phone@remote_link;
SELECT COUNT(*) FROM remote_table_type@remote_link;

-- Confirm current user has SELECT privilege on remote objects via the link
SELECT * FROM all_db_links WHERE db_link LIKE '%REMOTE_LINK%';
\`\`\`

### 3. Verify target tablespace has sufficient space

\`\`\`sql
SELECT df.tablespace_name,
       ROUND(df.total_mb)     AS total_mb,
       ROUND(fs.free_mb)      AS free_mb,
       ROUND(fs.free_mb / df.total_mb * 100, 1) AS pct_free
FROM (
    SELECT tablespace_name, SUM(bytes) / 1048576 AS total_mb
    FROM   dba_data_files
    GROUP BY tablespace_name
) df
JOIN (
    SELECT tablespace_name, SUM(bytes) / 1048576 AS free_mb
    FROM   dba_free_space
    GROUP BY tablespace_name
) fs USING (tablespace_name)
WHERE df.tablespace_name = 'DATA_TS'
ORDER BY 1;
\`\`\`

Ensure at least 3× the estimated result set size is available — staging MVs plus the final MV all consume tablespace simultaneously during an initial build.

---

## Phase 1: Deploy Remote Staging MV

The remote staging MV must be created first. It contains only remote objects — no local tables.

\`\`\`sql
-- Drop if re-deploying
-- DROP MATERIALIZED VIEW mv_remote_stage;

CREATE MATERIALIZED VIEW mv_remote_stage
TABLESPACE data_ts
BUILD IMMEDIATE
REFRESH COMPLETE ON DEMAND
ENABLE QUERY REWRITE
AS
SELECT p.customer_id,
       p.phone_id,
       p.phone_number,
       t.type_name,
       t.status
FROM   remote_table_phone@remote_link p
JOIN   remote_table_type@remote_link  t
       ON t.type_id = p.phone_type_id
WHERE  t.status = 'ACTIVE';
\`\`\`

### Verify remote staging MV

\`\`\`sql
-- Check the MV compiled and has rows
SELECT mview_name,
       staleness,
       last_refresh_date,
       last_refresh_type
FROM   all_mviews
WHERE  mview_name = 'MV_REMOTE_STAGE';

-- Confirm row count matches standalone remote query
SELECT COUNT(*) FROM mv_remote_stage;
\`\`\`

### Create index on remote staging MV

\`\`\`sql
-- Index the join key that will be used by the final-tier MV
CREATE INDEX mv_remote_stage_cust_ix
    ON mv_remote_stage (customer_id)
    TABLESPACE data_ts;

-- If phone_id is also a frequently queried column
CREATE INDEX mv_remote_stage_phone_ix
    ON mv_remote_stage (phone_id)
    TABLESPACE data_ts;
\`\`\`

---

## Phase 2: Deploy Local Staging MV

\`\`\`sql
-- Drop if re-deploying
-- DROP MATERIALIZED VIEW mv_local_stage;

CREATE MATERIALIZED VIEW mv_local_stage
TABLESPACE data_ts
BUILD IMMEDIATE
REFRESH COMPLETE ON DEMAND
ENABLE QUERY REWRITE
AS
SELECT c.customer_id,
       c.region_id,
       c.account_id
FROM   local_schema.customers c
JOIN   local_schema.orders    o
       ON  o.order_id   = c.order_id
WHERE  o.order_date    >= TRUNC(SYSDATE) - 5
  AND  o.status_id      = 9;
\`\`\`

### Verify local staging MV

\`\`\`sql
SELECT mview_name,
       staleness,
       last_refresh_date,
       last_refresh_type
FROM   all_mviews
WHERE  mview_name = 'MV_LOCAL_STAGE';

SELECT COUNT(*) FROM mv_local_stage;
\`\`\`

### Create index on local staging MV

\`\`\`sql
CREATE INDEX mv_local_stage_cust_ix
    ON mv_local_stage (customer_id)
    TABLESPACE data_ts;

-- Index additional columns if they appear in WHERE clauses against the final MV
CREATE INDEX mv_local_stage_region_ix
    ON mv_local_stage (region_id)
    TABLESPACE data_ts;
\`\`\`

---

## Phase 3: Deploy Final Target MV

The final MV joins only the two staging MVs — zero database link references. This step will not hang.

\`\`\`sql
-- Drop if re-deploying
-- DROP MATERIALIZED VIEW app_schema.mv_final_target;

CREATE MATERIALIZED VIEW app_schema.mv_final_target
TABLESPACE data_ts
BUILD IMMEDIATE
REFRESH COMPLETE ON DEMAND
ENABLE QUERY REWRITE
AS
SELECT l.customer_id,
       l.region_id,
       l.account_id,
       r.phone_id,
       r.phone_number,
       r.type_name
FROM   mv_local_stage  l
JOIN   mv_remote_stage r
       ON r.customer_id = l.customer_id;
\`\`\`

### Verify final target MV

\`\`\`sql
SELECT mview_name,
       staleness,
       last_refresh_date,
       last_refresh_type,
       compile_state
FROM   all_mviews
WHERE  mview_name = 'MV_FINAL_TARGET';

-- Check row count is consistent with the original standalone SELECT
SELECT COUNT(*) FROM app_schema.mv_final_target;
\`\`\`

### Create indexes on final target MV

\`\`\`sql
-- Indexes depend on query patterns against this MV — at minimum, index the join key
CREATE INDEX mv_final_target_cust_ix
    ON app_schema.mv_final_target (customer_id)
    TABLESPACE data_ts;

-- Add composite or covering indexes for known access patterns
CREATE INDEX mv_final_target_region_cust_ix
    ON app_schema.mv_final_target (region_id, customer_id)
    TABLESPACE data_ts;

-- Gather statistics after initial build
EXEC DBMS_STATS.GATHER_TABLE_STATS('APP_SCHEMA', 'MV_FINAL_TARGET', cascade => TRUE);
\`\`\`

---

## Phase 4: Configure Refresh Scheduling

### Option A — DBMS_SCHEDULER job (recommended)

\`\`\`sql
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'REFRESH_MV_DISTRIBUTED_CHAIN',
    job_type        => 'PLSQL_BLOCK',
    job_action      => '
      BEGIN
        -- Tier 1: remote data first
        DBMS_MVIEW.REFRESH(
          list           => ''MV_REMOTE_STAGE'',
          method         => ''C'',
          atomic_refresh => FALSE
        );
        -- Tier 2: local data second
        DBMS_MVIEW.REFRESH(
          list           => ''MV_LOCAL_STAGE'',
          method         => ''C'',
          atomic_refresh => FALSE
        );
        -- Tier 3: join the materialized staging results
        DBMS_MVIEW.REFRESH(
          list           => ''APP_SCHEMA.MV_FINAL_TARGET'',
          method         => ''C'',
          atomic_refresh => FALSE
        );
      END;
    ',
    start_date      => TRUNC(SYSDATE) + 1 + 2/24,   -- Tomorrow at 02:00
    repeat_interval => 'FREQ=HOURLY;INTERVAL=1',
    enabled         => TRUE,
    comments        => 'Three-tier distributed MV refresh chain'
  );
END;
/
\`\`\`

### Option B — DBMS_REFRESH group (legacy, maintains atomicity)

\`\`\`sql
BEGIN
  DBMS_REFRESH.MAKE(
    name                 => 'MV_DISTRIBUTED_GRP',
    list                 => 'MV_REMOTE_STAGE, MV_LOCAL_STAGE, APP_SCHEMA.MV_FINAL_TARGET',
    next_date            => SYSDATE + 1/24,
    interval             => 'SYSDATE + 1/24',
    implicit_destroy     => FALSE,
    rollback_seg         => NULL,
    push_deferred_rpc    => TRUE,
    refresh_after_errors => FALSE
  );
END;
/
\`\`\`

**Note:** Refresh groups process MVs in the order they were added to the list. Verify order with:

\`\`\`sql
SELECT rname, name, implicit_destroy, next_date, interval
FROM   all_refresh_children
WHERE  rname = 'MV_DISTRIBUTED_GRP'
ORDER BY rorder;
\`\`\`

---

## Phase 5: Monitoring Script

Save as \`/usr/local/bin/mv_distributed_monitor.sh\`. Run after each scheduled refresh or on demand to detect staleness, refresh failures, and remote link connectivity issues.

\`\`\`bash
#!/bin/bash
# mv_distributed_monitor.sh
# Monitors the three-tier distributed MV refresh chain health
# Usage: ./mv_distributed_monitor.sh [ORACLE_SID]
# Schedule: 5 minutes after each scheduled refresh

ORACLE_SID="\${1:-ORCL}"
export ORACLE_SID
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
ALERT_LOG="/var/log/mv_distributed_monitor_alerts.log"
FAILURES=0

log()   { echo "[$TIMESTAMP] $*"; }
alert() { echo "[$TIMESTAMP] ALERT: $*" | tee -a "$ALERT_LOG"; FAILURES=\$((FAILURES + 1)); }

log "=== MV Distributed Monitor Start (SID: \$ORACLE_SID) ==="

# Set Oracle environment
source /home/oracle/.bash_profile 2>/dev/null || true
export ORACLE_HOME=\${ORACLE_HOME:-/u01/app/oracle/product/19.0.0/dbhome_1}
export PATH=\$ORACLE_HOME/bin:\$PATH

SQLPLUS="\$ORACLE_HOME/bin/sqlplus -s / as sysdba"

# -----------------------------------------------------------------------
# CHECK 1: MV freshness — all three tiers refreshed within last 2 hours
# -----------------------------------------------------------------------
log "Checking MV refresh timestamps..."

STALE_MVS=\$(\$SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT mview_name || ' (last: ' ||
       TO_CHAR(last_refresh_date,'YYYY-MM-DD HH24:MI') || ')'
FROM   all_mviews
WHERE  mview_name IN ('MV_REMOTE_STAGE','MV_LOCAL_STAGE','MV_FINAL_TARGET')
  AND  (last_refresh_date IS NULL
     OR last_refresh_date < SYSDATE - 2/24);
EXIT;
SQLEOF
)

if [[ -n "\$STALE_MVS" ]]; then
  alert "Stale MVs detected (not refreshed in last 2 hours):"
  echo "\$STALE_MVS"
else
  log "All three MV tiers refreshed within last 2 hours. OK."
fi

# -----------------------------------------------------------------------
# CHECK 2: MV compile state — must be VALID
# -----------------------------------------------------------------------
log "Checking MV compile states..."

INVALID_MVS=\$(\$SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT mview_name || ' (state: ' || compile_state || ')'
FROM   all_mviews
WHERE  mview_name    IN ('MV_REMOTE_STAGE','MV_LOCAL_STAGE','MV_FINAL_TARGET')
  AND  compile_state != 'VALID';
EXIT;
SQLEOF
)

if [[ -n "\$INVALID_MVS" ]]; then
  alert "MVs with invalid compile state:"
  echo "\$INVALID_MVS"
else
  log "All MV compile states: VALID. OK."
fi

# -----------------------------------------------------------------------
# CHECK 3: MV staleness flag
# -----------------------------------------------------------------------
log "Checking MV staleness..."

STALE_FLAG=\$(\$SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT mview_name || ' (' || staleness || ')'
FROM   all_mviews
WHERE  mview_name IN ('MV_REMOTE_STAGE','MV_LOCAL_STAGE','MV_FINAL_TARGET')
  AND  staleness  IN ('NEEDS_COMPILE','UNUSABLE','STALE');
EXIT;
SQLEOF
)

if [[ -n "\$STALE_FLAG" ]]; then
  alert "MVs flagged as stale or unusable:"
  echo "\$STALE_FLAG"
else
  log "MV staleness flags: all FRESH. OK."
fi

# -----------------------------------------------------------------------
# CHECK 4: Active sessions hung waiting on dblink during refresh
# -----------------------------------------------------------------------
log "Checking for hung sessions on dblink or library cache..."

HUNG_SESSIONS=\$(\$SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT s.sid || '/' || s.serial# ||
       ' ' || s.username ||
       ' wait=' || s.event ||
       ' secs=' || s.seconds_in_wait
FROM   v\$session s
WHERE  s.status       = 'ACTIVE'
  AND  s.seconds_in_wait > 300
  AND  s.event IN (
         'SQL*Net message from dblink',
         'library cache lock',
         'enq: JI - contention'
       );
EXIT;
SQLEOF
)

if [[ -n "\$HUNG_SESSIONS" ]]; then
  alert "Sessions hung on dblink/library cache for >5 minutes:"
  echo "\$HUNG_SESSIONS"
else
  log "No hung sessions on dblink or library cache. OK."
fi

# -----------------------------------------------------------------------
# CHECK 5: Database link connectivity
# -----------------------------------------------------------------------
log "Testing database link connectivity..."

LINK_TEST=\$(\$SQLPLUS <<'SQLEOF' 2>&1
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON TIMING OFF
SELECT 'OK' FROM dual@remote_link;
EXIT;
SQLEOF
)

if echo "\$LINK_TEST" | grep -q "^OK\$"; then
  log "Database link remote_link: reachable. OK."
else
  alert "Database link remote_link is NOT reachable. Response: \$LINK_TEST"
fi

# -----------------------------------------------------------------------
# CHECK 6: Refresh job status (if using DBMS_SCHEDULER)
# -----------------------------------------------------------------------
log "Checking scheduler job status..."

JOB_STATUS=\$(\$SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT job_name ||
       ' state=' || state ||
       ' last_run=' || TO_CHAR(last_start_date,'YYYY-MM-DD HH24:MI')
FROM   dba_scheduler_jobs
WHERE  job_name = 'REFRESH_MV_DISTRIBUTED_CHAIN';
EXIT;
SQLEOF
)

if echo "\$JOB_STATUS" | grep -q "state=BROKEN"; then
  alert "Scheduler job REFRESH_MV_DISTRIBUTED_CHAIN is BROKEN"
  echo "\$JOB_STATUS"
elif echo "\$JOB_STATUS" | grep -q "state=DISABLED"; then
  alert "Scheduler job REFRESH_MV_DISTRIBUTED_CHAIN is DISABLED"
else
  log "Scheduler job status: \$JOB_STATUS. OK."
fi

# -----------------------------------------------------------------------
# CHECK 7: Row count consistency check
# -----------------------------------------------------------------------
log "Checking row count consistency across tiers..."

ROW_COUNTS=\$(\$SQLPLUS <<'SQLEOF'
SET HEADING ON FEEDBACK OFF PAGESIZE 20 LINESIZE 80 TRIMSPOOL ON
SELECT 'MV_REMOTE_STAGE'  AS mv_name, COUNT(*) AS row_count FROM mv_remote_stage
UNION ALL
SELECT 'MV_LOCAL_STAGE',              COUNT(*) FROM mv_local_stage
UNION ALL
SELECT 'MV_FINAL_TARGET',             COUNT(*) FROM app_schema.mv_final_target;
EXIT;
SQLEOF
)

log "Row counts:"
echo "\$ROW_COUNTS"

# Alert if final target has 0 rows but staging MVs have data
FINAL_ROWS=\$(\$SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT COUNT(*) FROM app_schema.mv_final_target;
EXIT;
SQLEOF
)
FINAL_ROWS=\$(echo "\$FINAL_ROWS" | tr -d '[:space:]')

REMOTE_ROWS=\$(\$SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT COUNT(*) FROM mv_remote_stage;
EXIT;
SQLEOF
)
REMOTE_ROWS=\$(echo "\$REMOTE_ROWS" | tr -d '[:space:]')

if [[ "\$FINAL_ROWS" -eq 0 && "\$REMOTE_ROWS" -gt 0 ]]; then
  alert "MV_FINAL_TARGET has 0 rows but MV_REMOTE_STAGE has \$REMOTE_ROWS rows — possible join issue or failed refresh"
fi

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
log "=== Monitor Complete: \$FAILURES alert(s) ==="

if [[ "\$FAILURES" -gt 0 ]]; then
  echo ""
  echo "ACTION REQUIRED: \$FAILURES issue(s). See \$ALERT_LOG"
  exit 1
else
  log "All checks passed."
  exit 0
fi
\`\`\`

### Install and schedule

\`\`\`bash
chmod +x /usr/local/bin/mv_distributed_monitor.sh

# Add to oracle crontab — run 5 minutes after each hourly refresh
crontab -e
\`\`\`

\`\`\`
# Monitor runs at :05 past the hour (refresh job runs at :00)
5 * * * * /usr/local/bin/mv_distributed_monitor.sh ORCL >> /var/log/mv_distributed_monitor.log 2>&1
\`\`\`

---

## Diagnostic Queries for Hung Refresh Sessions

If the monitoring script reports a hung session, use these queries to diagnose and remediate.

### Identify the hung session

\`\`\`sql
SELECT s.sid,
       s.serial#,
       s.username,
       s.event,
       s.wait_class,
       s.seconds_in_wait,
       s.state,
       s.sql_id,
       s.module
FROM   v\$session s
WHERE  s.status = 'ACTIVE'
  AND  s.event  IN (
         'SQL*Net message from dblink',
         'library cache lock',
         'enq: JI - contention'
       )
ORDER BY s.seconds_in_wait DESC;
\`\`\`

### Check what SQL the hung session is running

\`\`\`sql
SELECT sq.sql_text,
       sq.elapsed_time / 1e6  AS elapsed_sec,
       sq.executions
FROM   v\$session s
JOIN   v\$sql     sq ON sq.sql_id = s.sql_id
WHERE  s.sid = &hung_sid;
\`\`\`

### Check for Library Cache lock holders

\`\`\`sql
SELECT lk.sid,
       lk.type,
       lk.id1,
       lk.id2,
       lk.lmode,
       lk.request,
       lk.block,
       s.username,
       s.event
FROM   v\$lock    lk
JOIN   v\$session s ON s.sid = lk.sid
WHERE  lk.type IN ('MR','KD','TS')
  AND  lk.block = 1
ORDER BY lk.block DESC;
\`\`\`

### Kill the hung session (if confirmed stuck)

\`\`\`sql
-- Only after confirming the session has been stuck for >10 minutes
-- with no progress in V$SESSION.SECONDS_IN_WAIT
ALTER SYSTEM KILL SESSION '&sid,&serial#' IMMEDIATE;
\`\`\`

After killing a hung CREATE MV session, verify the object was not partially created:

\`\`\`sql
SELECT object_name, object_type, status
FROM   dba_objects
WHERE  object_name IN ('MV_REMOTE_STAGE','MV_LOCAL_STAGE','MV_FINAL_TARGET')
ORDER BY object_name;
\`\`\`

If any object shows status \`INVALID\` or is listed with type \`TABLE\` but not \`MATERIALIZED VIEW\`, drop and recreate:

\`\`\`sql
-- Clean up a partially created MV that left orphaned objects
DROP MATERIALIZED VIEW mv_remote_stage;
-- or if the MV did not fully register:
DROP TABLE mv_remote_stage PURGE;
\`\`\`

---

## Troubleshooting Table

| Symptom | Diagnosis | Action |
|---------|-----------|--------|
| CREATE MV hangs, event = \`library cache lock\` | Distributed MV compiler bug | Use three-tier architecture; never mix local + remote in one MV |
| CREATE MV hangs, event = \`SQL*Net message from dblink\` | Remote dictionary metadata timeout | Check remote DB availability; also switch to three-tier |
| Remote staging MV fails with ORA-02068 | Fatal dblink error during refresh | Check remote DB alert log; verify dblink credentials with \`SELECT * FROM dual@REMOTE_LINK\` |
| Final target MV has 0 rows after refresh | Staging MVs empty or join produces no matches | Check staging MV row counts; verify join key data overlap |
| Scheduler job in BROKEN state | Unhandled exception during refresh | Check \`DBA_SCHEDULER_JOB_RUN_DETAILS\` for error; fix root cause; re-enable with \`DBMS_SCHEDULER.ENABLE\` |
| \`ATOMIC_REFRESH\` causing undo explosion | Large MV with default atomic=TRUE | Set \`ATOMIC_REFRESH => FALSE\` in \`DBMS_MVIEW.REFRESH\` call |
| Parallel hint on MV ignored | MV created without PARALLEL clause | Add \`PARALLEL n\` to the MV \`CREATE\` statement, or run \`ALTER TABLE mv_local_stage PARALLEL 4\` |
| Staleness shows NEEDS_COMPILE | Underlying base table changed DDL | Run \`DBMS_MVIEW.REFRESH\` with \`method => 'C'\` to force complete refresh and recompile |`,
};

async function main() {
  console.log('Inserting MV distributed query hang runbook...');
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
