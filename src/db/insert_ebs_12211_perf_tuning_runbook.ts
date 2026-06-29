import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS 12.2.11 Performance Tuning Runbook',
  slug: 'oracle-ebs-12211-performance-tuning-runbook',
  excerpt:
    'Step-by-step runbook for tuning Oracle EBS 12.2.11 performance: AWR/ASH baseline collection, EBS-specific Oracle 19c parameter changes, FND_STATS scheduling, SQL plan baseline capture for top EBS SQL, WebLogic JVM and JDBC connection pool configuration, Concurrent Manager specialization, Oracle Resource Manager consumer group setup, and crontab monitoring scripts for wait events, shared pool hit rate, concurrent program queue depth, and JVM GC metrics.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-29'),
  youtubeUrl: null,
  content: `## Overview

This runbook covers the complete sequence for performance tuning Oracle EBS 12.2.11 on Oracle Database 19c. Work through each phase in order during a maintenance window. All database parameter changes use SPFILE and take effect at the next database restart unless otherwise noted; some can be applied with ALTER SYSTEM SCOPE=BOTH for immediate effect without restart.

**Prerequisites**:
- Oracle EBS 12.2.11 running on Oracle Database 19c
- DBA access to database server and EBS application tier
- AWR and ASH licensed (Enterprise Edition with Diagnostics Pack)
- Maintenance window of 4–6 hours for parameter changes and restart
- Current RMAN backup completed before starting

---

## Phase 1: AWR/ASH Baseline Collection

Collect a minimum of two AWR snapshots under representative workload before making any changes. This baseline is your reference for before/after comparison.

### 1.1 Verify AWR Snapshot Interval

\`\`\`sql
-- Check current AWR snapshot settings
SELECT SNAP_INTERVAL, RETENTION
FROM DBA_HIST_WR_CONTROL;

-- Set to 30-minute intervals if not already (default is 60 min)
BEGIN
  DBMS_WORKLOAD_REPOSITORY.MODIFY_SNAPSHOT_SETTINGS(
    retention => 30 * 24 * 60,  -- 30 days in minutes
    interval  => 30             -- every 30 minutes
  );
END;
/
\`\`\`

### 1.2 Capture Manual AWR Snapshots Around Peak Load

\`\`\`sql
-- Take a snapshot at start of peak period
EXEC DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT;

-- Record the snapshot ID
SELECT MAX(SNAP_ID), TO_CHAR(END_INTERVAL_TIME, 'YYYY-MM-DD HH24:MI:SS')
FROM DBA_HIST_SNAPSHOT;

-- After peak period ends, take end snapshot
EXEC DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT;
\`\`\`

### 1.3 Generate AWR Report

\`\`\`sql
-- Get the snap IDs for the peak window
SELECT SNAP_ID, TO_CHAR(END_INTERVAL_TIME, 'MM/DD HH24:MI') AS SNAP_TIME
FROM DBA_HIST_SNAPSHOT
WHERE END_INTERVAL_TIME > SYSDATE - 2
ORDER BY SNAP_ID;

-- Generate HTML AWR report (replace snap IDs and DBID)
SELECT OUTPUT FROM TABLE(
  DBMS_WORKLOAD_REPOSITORY.AWR_REPORT_HTML(
    l_dbid    => (SELECT DBID FROM V\$DATABASE),
    l_inst_num => 1,
    l_bid     => &begin_snap_id,
    l_eid     => &end_snap_id
  )
);
\`\`\`

### 1.4 Identify Top Wait Events and SQL

\`\`\`sql
-- Top 10 wait events from AWR history
SELECT EVENT,
       ROUND(SUM(TOTAL_WAITS_DELTA)) AS TOTAL_WAITS,
       ROUND(SUM(TIME_WAITED_MICRO_DELTA)/1e6, 1) AS SECONDS_WAITED
FROM DBA_HIST_SYSTEM_EVENT
WHERE SNAP_ID BETWEEN &begin_snap AND &end_snap
AND WAIT_CLASS != 'Idle'
GROUP BY EVENT
ORDER BY SECONDS_WAITED DESC
FETCH FIRST 10 ROWS ONLY;

-- Top 10 SQL by elapsed time
SELECT SQL_ID,
       ROUND(SUM(ELAPSED_TIME_DELTA)/1e6) AS ELAPSED_SEC,
       SUM(EXECUTIONS_DELTA) AS EXECS,
       ROUND(SUM(ELAPSED_TIME_DELTA)/NULLIF(SUM(EXECUTIONS_DELTA),0)/1e6, 3) AS SECS_PER_EXEC
FROM DBA_HIST_SQLSTAT
WHERE SNAP_ID BETWEEN &begin_snap AND &end_snap
GROUP BY SQL_ID
ORDER BY ELAPSED_SEC DESC
FETCH FIRST 10 ROWS ONLY;

-- Top SQL by library cache misses (high parse overhead)
SELECT SQL_ID,
       SUM(PARSE_CALLS_DELTA) AS PARSES,
       SUM(EXECUTIONS_DELTA) AS EXECS,
       ROUND(SUM(PARSE_CALLS_DELTA)/NULLIF(SUM(EXECUTIONS_DELTA),0)*100,1) AS PARSE_PCT
FROM DBA_HIST_SQLSTAT
WHERE SNAP_ID BETWEEN &begin_snap AND &end_snap
GROUP BY SQL_ID
HAVING SUM(PARSE_CALLS_DELTA) > 100
ORDER BY PARSES DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

### 1.5 ASH Analysis for EBS Module Breakdown

\`\`\`sql
-- Wait time by EBS module from ASH
SELECT MODULE,
       ROUND(COUNT(*) * 10 / 60, 1) AS ACTIVE_MINUTES,
       ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS PCT
FROM DBA_HIST_ACTIVE_SESS_HISTORY
WHERE SAMPLE_TIME > SYSDATE - 0.25  -- last 6 hours
AND SESSION_TYPE = 'FOREGROUND'
GROUP BY MODULE
ORDER BY ACTIVE_MINUTES DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

---

## Phase 2: Database Memory Parameter Sizing

Apply memory parameters. On a server with 256 GB RAM dedicated to Oracle:

### 2.1 Review Current Memory Configuration

\`\`\`sql
SHOW PARAMETER SGA_TARGET;
SHOW PARAMETER SGA_MAX_SIZE;
SHOW PARAMETER PGA_AGGREGATE_TARGET;
SHOW PARAMETER MEMORY_TARGET;

-- Check current SGA component usage
SELECT COMPONENT, CURRENT_SIZE/1024/1024/1024 AS CURRENT_GB,
       MIN_SIZE/1024/1024/1024 AS MIN_GB
FROM V\$SGA_DYNAMIC_COMPONENTS
ORDER BY CURRENT_SIZE DESC;
\`\`\`

### 2.2 Set SGA and PGA Parameters

\`\`\`sql
-- Disable AMM (MEMORY_TARGET) — use ASMM (SGA_TARGET + PGA_AGGREGATE_TARGET) for EBS
ALTER SYSTEM SET MEMORY_TARGET=0 SCOPE=SPFILE;
ALTER SYSTEM SET MEMORY_MAX_TARGET=0 SCOPE=SPFILE;

-- Set SGA: 160 GB total
ALTER SYSTEM SET SGA_MAX_SIZE=160G SCOPE=SPFILE;
ALTER SYSTEM SET SGA_TARGET=160G SCOPE=SPFILE;

-- Pin shared pool and buffer cache floors
ALTER SYSTEM SET SHARED_POOL_SIZE=6G SCOPE=SPFILE;
ALTER SYSTEM SET DB_CACHE_SIZE=120G SCOPE=SPFILE;

-- PGA: 32 GB aggregate target
ALTER SYSTEM SET PGA_AGGREGATE_TARGET=32G SCOPE=SPFILE;
ALTER SYSTEM SET PGA_AGGREGATE_LIMIT=64G SCOPE=SPFILE;

-- Large pool for parallel query and shared server (if used)
ALTER SYSTEM SET LARGE_POOL_SIZE=512M SCOPE=SPFILE;
\`\`\`

### 2.3 Verify After Restart

\`\`\`sql
-- Run after database restart
SELECT COMPONENT, CURRENT_SIZE/1024/1024/1024 AS GB
FROM V\$SGA_DYNAMIC_COMPONENTS
ORDER BY CURRENT_SIZE DESC;

SELECT NAME, VALUE/1024/1024/1024 AS GB
FROM V\$PGASTAT
WHERE NAME IN ('aggregate PGA target parameter','aggregate PGA auto target');
\`\`\`

---

## Phase 3: EBS-Specific Optimizer Parameters

These parameters disable optimizer features that produce unstable execution plans in the EBS SQL workload. Apply immediately with BOTH scope — no restart required.

### 3.1 Apply Optimizer Fixes

\`\`\`sql
-- Disable adaptive plans — EBS queries with bind variables get unstable plans
ALTER SYSTEM SET "_optimizer_adaptive_plans"=FALSE SCOPE=BOTH;

-- Disable adaptive statistics — prevents automatic extended stats from altering plans
ALTER SYSTEM SET "_optimizer_adaptive_statistics"=FALSE SCOPE=BOTH;

-- Disable cardinality feedback — prevents plan changes mid-workload
ALTER SYSTEM SET "_optimizer_use_feedback"=FALSE SCOPE=BOTH;

-- Disable bitmap plans for B-tree index tables — EBS tables are not optimized for bitmap joins
ALTER SYSTEM SET "_b_tree_bitmap_plans"=FALSE SCOPE=BOTH;

-- CURSOR_SHARING=EXACT — EBS generates well-parameterized SQL; FORCE causes excess parsing
ALTER SYSTEM SET CURSOR_SHARING=EXACT SCOPE=BOTH;
\`\`\`

### 3.2 Parallel Execution Limits

\`\`\`sql
-- Allow parallel execution for batch concurrent programs
-- Limit degree to prevent parallel runaway during interactive hours
ALTER SYSTEM SET PARALLEL_MAX_SERVERS=32 SCOPE=BOTH;
ALTER SYSTEM SET PARALLEL_DEGREE_LIMIT=8 SCOPE=BOTH;
ALTER SYSTEM SET PARALLEL_DEGREE_POLICY=AUTO SCOPE=BOTH;
ALTER SYSTEM SET PARALLEL_MIN_PERCENT=0 SCOPE=BOTH;

-- Prevent parallel on small tables
ALTER SYSTEM SET PARALLEL_AUTOMATIC_TUNING=FALSE SCOPE=SPFILE;
\`\`\`

### 3.3 Undo and Redo Settings

\`\`\`sql
-- Undo retention: 1800 seconds to support long-running EBS batch queries with ORA-01555 risk
ALTER SYSTEM SET UNDO_RETENTION=1800 SCOPE=BOTH;
ALTER SYSTEM SET UNDO_TABLESPACE='UNDOTBS1' SCOPE=BOTH;

-- Verify undo tablespace has AUTOEXTEND ON
SELECT FILE_NAME, BYTES/1024/1024 AS MB, AUTOEXTENSIBLE, MAXBYTES/1024/1024 AS MAX_MB
FROM DBA_DATA_FILES
WHERE TABLESPACE_NAME = 'UNDOTBS1';
\`\`\`

---

## Phase 4: Shared Pool Pinning for Core EBS Packages

Pin the eight most-called EBS PL/SQL packages into the shared pool at database startup to prevent them from aging out under memory pressure.

### 4.1 Create Startup Trigger

\`\`\`sql
-- Run as SYS
CREATE OR REPLACE PROCEDURE pin_ebs_packages IS
BEGIN
  DBMS_SHARED_POOL.KEEP('SYS.STANDARD',        'P');
  DBMS_SHARED_POOL.KEEP('APPS.FND_GLOBAL',      'P');
  DBMS_SHARED_POOL.KEEP('APPS.FND_PROFILE',     'P');
  DBMS_SHARED_POOL.KEEP('APPS.FND_REQUEST',     'P');
  DBMS_SHARED_POOL.KEEP('APPS.MO_GLOBAL',       'P');
  DBMS_SHARED_POOL.KEEP('APPS.HR_GENERAL',      'P');
  DBMS_SHARED_POOL.KEEP('APPS.HR_SECURITY',     'P');
  DBMS_SHARED_POOL.KEEP('APPS.FND_DATE',        'P');
  DBMS_SHARED_POOL.KEEP('APPS.FND_NUMBER',      'P');
END;
/

CREATE OR REPLACE TRIGGER pin_ebs_on_startup
  AFTER STARTUP ON DATABASE
BEGIN
  pin_ebs_packages;
END;
/
\`\`\`

### 4.2 Verify Packages Are Pinned

\`\`\`sql
SELECT OWNER, NAME, TYPE, KEPT
FROM V\$DB_OBJECT_CACHE
WHERE KEPT = 'YES'
AND TYPE IN ('PACKAGE','PACKAGE BODY')
ORDER BY OWNER, NAME;
\`\`\`

---

## Phase 5: FND_STATS Configuration and Scheduling

### 5.1 Gather Schema Statistics with FND_STATS

\`\`\`sql
-- Run as APPS user
-- Full gather on APPS schema (schedule during off-peak, may take 4–8 hours on large instances)
BEGIN
  FND_STATS.GATHER_SCHEMA_STATISTICS(
    schemaname => 'APPS',
    percent    => 10,
    degree     => 4
  );
END;
/

-- Gather statistics on a specific EBS table with histogram
BEGIN
  FND_STATS.GATHER_TABLE_STATS(
    ownname   => 'APPS',
    tabname   => 'RA_CUSTOMER_TRX_ALL',
    percent   => 20,
    degree    => 4,
    hmode     => 'FULL'
  );
END;
/
\`\`\`

### 5.2 Verify Statistics Currency

\`\`\`sql
-- Tables with stale or missing statistics in APPS schema
SELECT TABLE_NAME,
       TO_CHAR(LAST_ANALYZED, 'YYYY-MM-DD') AS LAST_ANALYZED,
       NUM_ROWS,
       STALE_STATS
FROM DBA_TAB_STATISTICS
WHERE OWNER = 'APPS'
AND (LAST_ANALYZED IS NULL OR LAST_ANALYZED < SYSDATE - 7 OR STALE_STATS = 'YES')
AND NUM_ROWS > 10000
ORDER BY NUM_ROWS DESC
FETCH FIRST 30 ROWS ONLY;
\`\`\`

### 5.3 Schedule FND_STATS via DBMS_SCHEDULER

\`\`\`sql
-- Run as SYS or APPS DBA account
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'APPS.GATHER_APPS_STATS_WEEKLY',
    job_type        => 'PLSQL_BLOCK',
    job_action      => 'BEGIN FND_STATS.GATHER_SCHEMA_STATISTICS(schemaname=>''APPS'', percent=>10, degree=>4); END;',
    start_date      => TRUNC(NEXT_DAY(SYSDATE, 'SATURDAY')) + 22/24,  -- Saturday 10 PM
    repeat_interval => 'FREQ=WEEKLY; BYDAY=SAT; BYHOUR=22; BYMINUTE=0',
    enabled         => TRUE,
    comments        => 'Weekly APPS schema statistics gather via FND_STATS'
  );
END;
/
\`\`\`

---

## Phase 6: SQL Plan Baselines for Top EBS SQL

Capture stable plans for the top SQL identified in Phase 1. This prevents plan regressions after optimizer statistics changes.

### 6.1 Load Plans from Cursor Cache

\`\`\`sql
-- Load plans from cursor cache for a specific SQL_ID into SPM baseline
DECLARE
  v_count PLS_INTEGER;
BEGIN
  v_count := DBMS_SPM.LOAD_PLANS_FROM_CURSOR_CACHE(
    sql_id         => '&top_sql_id',
    plan_hash_value => NULL,     -- capture all plans for this SQL
    fixed          => 'NO',      -- not fixed; allows optimizer to accept better plans
    enabled        => 'YES'
  );
  DBMS_OUTPUT.PUT_LINE('Plans loaded: ' || v_count);
END;
/
\`\`\`

### 6.2 Load Plans from AWR for Historical Baselines

\`\`\`sql
-- Load the known-good plan from AWR history
DECLARE
  v_count PLS_INTEGER;
BEGIN
  v_count := DBMS_SPM.LOAD_PLANS_FROM_AWR(
    begin_snap => &good_snap_id,
    end_snap   => &good_snap_id + 1,
    basic_filter => 'sql_id = ''&top_sql_id'''
  );
  DBMS_OUTPUT.PUT_LINE('Plans loaded from AWR: ' || v_count);
END;
/
\`\`\`

### 6.3 View Captured Baselines

\`\`\`sql
SELECT SQL_HANDLE, PLAN_NAME, ENABLED, ACCEPTED, FIXED, LAST_EXECUTED,
       SUBSTR(SQL_TEXT, 1, 80) AS SQL_PREVIEW
FROM DBA_SQL_PLAN_BASELINES
ORDER BY LAST_EXECUTED DESC NULLS LAST
FETCH FIRST 20 ROWS ONLY;
\`\`\`

---

## Phase 7: WebLogic JVM and JDBC Connection Pool Tuning

### 7.1 Locate the WebLogic Domain Start Scripts

\`\`\`bash
# EBS app tier — identify the oacore managed server start script
ls \${EBS_ENV_HOME}/inst/apps/\${TWO_TASK}_\${HOSTNAME}/appl/admin/scripts/
# File: oacore_server1.sh or adstrtal.sh

# WebLogic setUserOverrides.sh location
ls \${EBS_DOMAIN_HOME}/bin/setUserOverrides.sh
\`\`\`

### 7.2 Set JVM Parameters in setUserOverrides.sh

\`\`\`bash
# Edit \${EBS_DOMAIN_HOME}/bin/setUserOverrides.sh
# Add or update the JAVA_OPTIONS block for oacore:

JAVA_OPTIONS="\${JAVA_OPTIONS} -Xms8192m -Xmx8192m"
JAVA_OPTIONS="\${JAVA_OPTIONS} -XX:+UseG1GC"
JAVA_OPTIONS="\${JAVA_OPTIONS} -XX:G1HeapRegionSize=16m"
JAVA_OPTIONS="\${JAVA_OPTIONS} -XX:MaxGCPauseMillis=500"
JAVA_OPTIONS="\${JAVA_OPTIONS} -XX:+ParallelRefProcEnabled"
JAVA_OPTIONS="\${JAVA_OPTIONS} -XX:+DisableExplicitGC"
JAVA_OPTIONS="\${JAVA_OPTIONS} -XX:+PrintGCDateStamps"
JAVA_OPTIONS="\${JAVA_OPTIONS} -Xloggc:\${LOG_HOME}/oacore_gc.log"
export JAVA_OPTIONS
\`\`\`

### 7.3 Set JDBC Connection Pool via WLST

\`\`\`bash
# Connect to WebLogic Admin Server
\${FMW_HOME}/oracle_common/common/bin/wlst.sh << 'WLST'
connect('weblogic', '<password>', 't3://ebsadmin.example.com:7001')
edit()
startEdit()

# Navigate to the EBS JDBC data source
cd('/JDBCSystemResources/EBSDataSource/JDBCResource/EBSDataSource/JDBCConnectionPoolParams/EBSDataSource')

# Set connection pool parameters
set('MaxCapacity', 200)
set('MinCapacity', 20)
set('InitialCapacity', 20)
set('CapacityIncrement', 5)
set('ConnectionReserveTimeoutSecs', 30)
set('TestConnectionsOnReserve', 'true')
set('TestTableName', 'SQL SELECT 1 FROM DUAL')

# Statement cache
cd('/JDBCSystemResources/EBSDataSource/JDBCResource/EBSDataSource/JDBCDriverParams/EBSDataSource/Properties/EBSDataSource')
cmo.lookupProperty('oracle.jdbc.implicitStatementCacheSize').setValue('100')

save()
activate()
disconnect()
exit()
WLST
\`\`\`

### 7.4 Bounce oacore to Apply JVM Changes

\`\`\`bash
# Bounce oacore managed server only (no full EBS restart needed for JVM change)
\${ADMIN_SCRIPTS_HOME}/adopmnctl.sh stop
\${ADMIN_SCRIPTS_HOME}/adopmnctl.sh start

# Or using admanagedsrvctl.sh:
\${ADMIN_SCRIPTS_HOME}/admanagedsrvctl.sh stop oacore_server1
\${ADMIN_SCRIPTS_HOME}/admanagedsrvctl.sh start oacore_server1
\`\`\`

---

## Phase 8: OAF Metadata Cache Configuration

\`\`\`sql
-- Set OAF page cache limit via FND_PROFILE
-- Run as APPS
BEGIN
  FND_PROFILE.SAVE(
    x_name        => 'FND_CACHE_MAX_PAGES',
    x_value       => '5000',
    x_level_name  => 'SITE',
    x_level_value => NULL
  );
  COMMIT;
END;
/

-- Verify the setting
SELECT PROFILE_OPTION_VALUE
FROM FND_PROFILE_OPTION_VALUES FPOV
JOIN FND_PROFILE_OPTIONS FPO
  ON FPO.PROFILE_OPTION_ID = FPOV.PROFILE_OPTION_ID
WHERE FPO.PROFILE_OPTION_NAME = 'FND_CACHE_MAX_PAGES'
AND FPOV.LEVEL_ID = 10001;
\`\`\`

---

## Phase 9: Concurrent Manager Specialization

### 9.1 Create Manager Specialization Rules via SQL*Plus

\`\`\`sql
-- Assign high-priority concurrent programs to a dedicated manager
-- Run as APPS
-- Step A: Query available manager IDs
SELECT CONCURRENT_QUEUE_ID, USER_CONCURRENT_QUEUE_NAME, ENABLED_FLAG
FROM FND_CONCURRENT_QUEUES_VL
WHERE ENABLED_FLAG = 'Y'
ORDER BY USER_CONCURRENT_QUEUE_NAME;

-- Step B: Query program IDs to specialize
SELECT CONCURRENT_PROGRAM_ID, CONCURRENT_PROGRAM_NAME, USER_CONCURRENT_PROGRAM_NAME
FROM FND_CONCURRENT_PROGRAMS_VL
WHERE USER_CONCURRENT_PROGRAM_NAME LIKE '%Payroll%'
AND ENABLED_FLAG = 'Y';
\`\`\`

### 9.2 Set Max Processes on Standard Manager

\`\`\`sql
-- Increase worker processes on Standard Manager (CONCURRENT_QUEUE_ID = 1)
-- Must be done through Oracle Forms (System Administrator > Concurrent > Manager > Define)
-- or via direct table update (requires careful coordination):

-- Check current setting
SELECT CONCURRENT_QUEUE_ID, MAX_PROCESSES, WORK_ASSIGNMENTS
FROM FND_CONCURRENT_QUEUES
WHERE CONCURRENT_QUEUE_ID = 1;

-- Typical target: 40–60 workers for a large EBS instance
-- Apply via: System Administrator > Concurrent: Manager > Define > Standard Manager > Max Processes
\`\`\`

### 9.3 Restart Concurrent Managers

\`\`\`bash
# Bounce the concurrent manager tier
\${ADMIN_SCRIPTS_HOME}/adcmctl.sh stop apps/\${APPS_PASSWORD}
\${ADMIN_SCRIPTS_HOME}/adcmctl.sh start apps/\${APPS_PASSWORD}

# Verify managers are up
\${ADMIN_SCRIPTS_HOME}/adcmctl.sh status apps/\${APPS_PASSWORD}
\`\`\`

---

## Phase 10: Oracle Resource Manager for EBS

### 10.1 Create EBS Resource Plan

\`\`\`sql
-- Run as SYS
BEGIN
  -- Create the plan
  DBMS_RESOURCE_MANAGER.CREATE_SIMPLE_PLAN(
    simple_plan             => 'EBS_RESOURCE_PLAN',
    consumer_group1         => 'EBS_INTERACTIVE',
    group1_percent          => 70,
    consumer_group2         => 'EBS_BATCH',
    group2_percent          => 30
  );
END;
/

-- Create consumer groups
BEGIN
  DBMS_RESOURCE_MANAGER.CREATE_CONSUMER_GROUP(
    consumer_group => 'EBS_INTERACTIVE',
    comment        => 'EBS Forms, OAF, and self-service users'
  );
  DBMS_RESOURCE_MANAGER.CREATE_CONSUMER_GROUP(
    consumer_group => 'EBS_BATCH',
    comment        => 'EBS Concurrent Programs and batch jobs'
  );
END;
/
\`\`\`

### 10.2 Map EBS Session Attributes to Consumer Groups

\`\`\`sql
BEGIN
  -- Map FNDCPGSC (Concurrent Manager) module to EBS_BATCH
  DBMS_RESOURCE_MANAGER.SET_CONSUMER_GROUP_MAPPING(
    attribute      => DBMS_RESOURCE_MANAGER.MODULE_NAME,
    value          => 'FNDCPGSC%',
    consumer_group => 'EBS_BATCH'
  );

  -- Map e-Business Suite Forms sessions to EBS_INTERACTIVE
  DBMS_RESOURCE_MANAGER.SET_CONSUMER_GROUP_MAPPING(
    attribute      => DBMS_RESOURCE_MANAGER.MODULE_NAME,
    value          => 'FRMWEB%',
    consumer_group => 'EBS_INTERACTIVE'
  );

  -- Map OAF sessions to EBS_INTERACTIVE
  DBMS_RESOURCE_MANAGER.SET_CONSUMER_GROUP_MAPPING(
    attribute      => DBMS_RESOURCE_MANAGER.MODULE_NAME,
    value          => 'FNDSM%',
    consumer_group => 'EBS_INTERACTIVE'
  );
END;
/

-- Activate the plan
ALTER SYSTEM SET RESOURCE_MANAGER_PLAN='EBS_RESOURCE_PLAN' SCOPE=BOTH;
\`\`\`

### 10.3 Verify Resource Manager Activity

\`\`\`sql
SELECT CONSUMER_GROUP_NAME, ACTIVE_SESSIONS, EXECUTION_WAITERS,
       CPU_WAIT_TIME/1000 AS CPU_WAIT_MS
FROM V\$RSRC_CONSUMER_GROUP
WHERE CONSUMER_GROUP_NAME IN ('EBS_INTERACTIVE','EBS_BATCH')
ORDER BY ACTIVE_SESSIONS DESC;
\`\`\`

---

## Phase 11: Post-Tuning Validation

### 11.1 AWR Comparison Report

After running the tuned system under representative load, generate a second AWR report covering the same duration and compare:

\`\`\`sql
-- Get new snap IDs
SELECT SNAP_ID, TO_CHAR(END_INTERVAL_TIME, 'MM/DD HH24:MI') AS SNAP_TIME
FROM DBA_HIST_SNAPSHOT
ORDER BY SNAP_ID DESC
FETCH FIRST 10 ROWS ONLY;

-- Generate AWR comparison (period report)
SELECT OUTPUT FROM TABLE(
  DBMS_WORKLOAD_REPOSITORY.AWR_DIFF_REPORT_HTML(
    dbid1     => (SELECT DBID FROM V\$DATABASE),
    inst_num1 => 1,
    bid1      => &baseline_begin,
    eid1      => &baseline_end,
    dbid2     => (SELECT DBID FROM V\$DATABASE),
    inst_num2 => 1,
    bid2      => &post_tuning_begin,
    eid2      => &post_tuning_end
  )
);
\`\`\`

### 11.2 Shared Pool Health Check

\`\`\`sql
-- Library cache hit rate (target: > 99%)
SELECT ROUND((1 - SUM(RELOADS)/SUM(PINS)) * 100, 2) AS LIBRARY_CACHE_HIT_PCT
FROM V\$LIBRARYCACHE
WHERE NAMESPACE IN ('SQL AREA','TABLE/PROCEDURE','BODY','TRIGGER');

-- Shared pool free memory
SELECT NAME, BYTES/1024/1024 AS MB
FROM V\$SGASTAT
WHERE POOL = 'shared pool'
AND NAME IN ('free memory','library cache','sql area')
ORDER BY BYTES DESC;
\`\`\`

---

## Phase 12: Monitoring Scripts

Deploy these scripts on the database server. Add crontab entries to schedule them.

### Script 1: Wait Event Monitor

\`\`\`bash
#!/bin/bash
# File: /home/oracle/scripts/ebs_wait_events.sh
# Monitor top wait events and alert on EBS-critical waits

DB_SID=\${ORACLE_SID:-EBSDB}
ALERT_EMAIL="dba-alerts@example.com"
THRESHOLD_SECS=30

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_HOME
export ORACLE_SID=\${DB_SID}

WAIT_OUTPUT=\$(\${ORACLE_HOME}/bin/sqlplus -s / as sysdba << 'SQL'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT EVENT || '|' || ROUND(TIME_WAITED/100,1) || '|' || TOTAL_WAITS
FROM V\$SYSTEM_EVENT
WHERE WAIT_CLASS != 'Idle'
AND TIME_WAITED/100 > 30
ORDER BY TIME_WAITED DESC
FETCH FIRST 5 ROWS ONLY;
EXIT;
SQL
)

TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
LOG=/home/oracle/scripts/logs/wait_events.log

echo "\${TIMESTAMP}" >> \${LOG}
if [[ -n "\${WAIT_OUTPUT}" ]]; then
  echo "HIGH WAIT EVENTS DETECTED:" >> \${LOG}
  echo "\${WAIT_OUTPUT}" >> \${LOG}
  echo "" >> \${LOG}

  ALERT_EVENTS=\$(echo "\${WAIT_OUTPUT}" | awk -F'|' -v thresh=\${THRESHOLD_SECS} '\$2 > thresh')
  if [[ -n "\${ALERT_EVENTS}" ]]; then
    echo -e "Subject: [EBS ALERT] High wait events on \${DB_SID}\n\n\${WAIT_OUTPUT}" | \
      /usr/sbin/sendmail \${ALERT_EMAIL}
  fi
else
  echo "Wait events within normal range" >> \${LOG}
fi
\`\`\`

### Script 2: Shared Pool Hit Rate Monitor

\`\`\`bash
#!/bin/bash
# File: /home/oracle/scripts/ebs_shared_pool.sh
# Alert if library cache hit rate drops below threshold

DB_SID=\${ORACLE_SID:-EBSDB}
ALERT_EMAIL="dba-alerts@example.com"
MIN_HIT_PCT=99

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_HOME
export ORACLE_SID=\${DB_SID}

read HIT_PCT FREE_MB << SQL_EOF
\$(\${ORACLE_HOME}/bin/sqlplus -s / as sysdba << 'SQL'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT ROUND((1-SUM(RELOADS)/SUM(PINS))*100,2),
       ROUND(SUM(CASE WHEN NAME='free memory' AND POOL='shared pool' THEN BYTES ELSE 0 END)/1024/1024,0)
FROM V\$LIBRARYCACHE, V\$SGASTAT
WHERE V\$LIBRARYCACHE.NAMESPACE IN ('SQL AREA','TABLE/PROCEDURE','BODY');
EXIT;
SQL
)
SQL_EOF

TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
LOG=/home/oracle/scripts/logs/shared_pool.log
echo "\${TIMESTAMP} | Library Cache Hit: \${HIT_PCT}% | Free: \${FREE_MB} MB" >> \${LOG}

if (( \$(echo "\${HIT_PCT} < \${MIN_HIT_PCT}" | bc -l) )); then
  MSG="Subject: [EBS ALERT] Shared pool hit rate low on \${DB_SID}\n\nLibrary cache hit rate: \${HIT_PCT}%\nFree shared pool: \${FREE_MB} MB\n\nInvestigate parse activity and consider increasing SHARED_POOL_SIZE."
  echo -e "\${MSG}" | /usr/sbin/sendmail \${ALERT_EMAIL}
fi
\`\`\`

### Script 3: Concurrent Manager Queue Depth Monitor

\`\`\`bash
#!/bin/bash
# File: /home/oracle/scripts/ebs_cm_queue.sh
# Alert when concurrent request queue depth exceeds threshold

APPS_CONN="apps/\${APPS_PASSWORD}@\${DB_SERVICE}"
ALERT_EMAIL="dba-alerts@example.com"
QUEUE_WARN=50
QUEUE_CRIT=100

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_HOME

read PENDING_COUNT RUNNING_COUNT << SQL_EOF
\$(\${ORACLE_HOME}/bin/sqlplus -s "\${APPS_CONN}" << 'SQL'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT
  NVL(SUM(CASE WHEN STATUS_CODE='P' THEN 1 ELSE 0 END),0),
  NVL(SUM(CASE WHEN STATUS_CODE='R' THEN 1 ELSE 0 END),0)
FROM FND_CONCURRENT_REQUESTS
WHERE STATUS_CODE IN ('P','R')
AND REQUESTED_START_DATE <= SYSDATE;
EXIT;
SQL
)
SQL_EOF

TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
LOG=/home/oracle/scripts/logs/cm_queue.log
echo "\${TIMESTAMP} | Pending: \${PENDING_COUNT} | Running: \${RUNNING_COUNT}" >> \${LOG}

if [ "\${PENDING_COUNT}" -ge "\${QUEUE_CRIT}" ]; then
  MSG="Subject: [EBS CRITICAL] Concurrent Manager queue backed up on \$(hostname)\n\nPending requests: \${PENDING_COUNT}\nRunning requests: \${RUNNING_COUNT}\n\nCheck for manager outages or long-running concurrent programs blocking the queue."
  echo -e "\${MSG}" | /usr/sbin/sendmail \${ALERT_EMAIL}
elif [ "\${PENDING_COUNT}" -ge "\${QUEUE_WARN}" ]; then
  MSG="Subject: [EBS WARN] Concurrent Manager queue elevated on \$(hostname)\n\nPending requests: \${PENDING_COUNT}\nRunning requests: \${RUNNING_COUNT}"
  echo -e "\${MSG}" | /usr/sbin/sendmail \${ALERT_EMAIL}
fi
\`\`\`

### Script 4: JVM GC Log Monitor

\`\`\`bash
#!/bin/bash
# File: /home/oracle/scripts/ebs_gc_monitor.sh
# Parse oacore GC log for full GC pause frequency and duration

GC_LOG=\${LOG_HOME}/oacore_gc.log
ALERT_EMAIL="dba-alerts@example.com"
MAX_FULL_GC_PER_HOUR=3
MAX_PAUSE_MS=2000

TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
LOG=/home/oracle/scripts/logs/gc_monitor.log

# Count full GCs in the last hour from the GC log
# G1GC logs full GCs as "Pause Full"
FULL_GC_COUNT=\$(awk -v cutoff="\$(date -d '1 hour ago' '+%Y-%m-%dT%H:%M')" '
  /Pause Full/ && \$1 >= cutoff { count++ }
  END { print count+0 }
' "\${GC_LOG}" 2>/dev/null)

# Find max GC pause in ms
MAX_PAUSE=\$(awk '
  /Pause/ {
    match(\$0, /([0-9]+\.[0-9]+)ms/, arr)
    if (arr[1]+0 > max) max = arr[1]+0
  }
  END { printf "%d", max }
' "\${GC_LOG}" 2>/dev/null)

echo "\${TIMESTAMP} | Full GCs last hour: \${FULL_GC_COUNT} | Max pause: \${MAX_PAUSE}ms" >> \${LOG}

ALERT=0
MSG="EBS oacore JVM GC alert on \$(hostname)\n\nFull GCs last hour: \${FULL_GC_COUNT} (threshold: \${MAX_FULL_GC_PER_HOUR})\nMax pause: \${MAX_PAUSE}ms (threshold: \${MAX_PAUSE_MS}ms)\n\nGC log: \${GC_LOG}"

[ "\${FULL_GC_COUNT}" -ge "\${MAX_FULL_GC_PER_HOUR}" ] && ALERT=1
[ "\${MAX_PAUSE}" -ge "\${MAX_PAUSE_MS}" ] && ALERT=1

if [ "\${ALERT}" -eq 1 ]; then
  echo -e "Subject: [EBS ALERT] JVM GC pressure on oacore\n\n\${MSG}" | /usr/sbin/sendmail \${ALERT_EMAIL}
fi
\`\`\`

### Crontab Setup

\`\`\`bash
# Add to oracle user crontab: crontab -e

# Wait events: every 5 minutes during business hours (07:00–22:00)
*/5 7-22 * * * /home/oracle/scripts/ebs_wait_events.sh >> /dev/null 2>&1

# Shared pool: every 10 minutes
*/10 * * * * /home/oracle/scripts/ebs_shared_pool.sh >> /dev/null 2>&1

# Concurrent Manager queue: every 5 minutes during business hours
*/5 6-23 * * * /home/oracle/scripts/ebs_cm_queue.sh >> /dev/null 2>&1

# JVM GC monitor: every 30 minutes
*/30 * * * * /home/oracle/scripts/ebs_gc_monitor.sh >> /dev/null 2>&1

# Log rotation: weekly
0 2 * * 0 find /home/oracle/scripts/logs -name "*.log" -mtime +30 -delete
\`\`\`

---

## Rollback Procedure

If any database parameter change causes instability:

\`\`\`sql
-- Revert optimizer parameters immediately (no restart needed)
ALTER SYSTEM SET "_optimizer_adaptive_plans"=TRUE SCOPE=BOTH;
ALTER SYSTEM SET "_optimizer_adaptive_statistics"=TRUE SCOPE=BOTH;
ALTER SYSTEM SET "_optimizer_use_feedback"=TRUE SCOPE=BOTH;
ALTER SYSTEM SET "_b_tree_bitmap_plans"=TRUE SCOPE=BOTH;

-- Revert memory parameters (requires restart)
ALTER SYSTEM RESET SGA_TARGET SCOPE=SPFILE;
ALTER SYSTEM RESET SHARED_POOL_SIZE SCOPE=SPFILE;
ALTER SYSTEM RESET DB_CACHE_SIZE SCOPE=SPFILE;
ALTER SYSTEM RESET PGA_AGGREGATE_TARGET SCOPE=SPFILE;

-- Remove Resource Manager plan
ALTER SYSTEM SET RESOURCE_MANAGER_PLAN='' SCOPE=BOTH;

-- Drop SPM baselines if a baseline is causing a regression
SELECT SQL_HANDLE, PLAN_NAME FROM DBA_SQL_PLAN_BASELINES;
DECLARE
  v_count PLS_INTEGER;
BEGIN
  v_count := DBMS_SPM.DROP_SQL_PLAN_BASELINE(
    sql_handle => '&sql_handle',
    plan_name  => '&plan_name'
  );
END;
/
\`\`\``,
};

async function main() {
  console.log('Inserting EBS 12.2.11 performance tuning runbook...');
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
