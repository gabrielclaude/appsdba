import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle DBMS_SCHEDULER Job Creation, Monitoring, and Maintenance',
  slug: 'oracle-dbms-scheduler-runbook',
  excerpt:
    'A phased operational runbook for Oracle DBAs covering the complete DBMS_SCHEDULER workflow: privilege checks, named programs and schedules with calendaring syntax, job creation and control, job classes, multi-step chains with conditional branching, Windows and AutoTask management, monitoring dashboards, log management, email notifications, and a full troubleshooting guide.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-06'),
  youtubeUrl: null,
  content: `This runbook covers Oracle DBMS_SCHEDULER operations end to end. All code is SQL or PL/SQL. Work through each phase in order and verify results before proceeding.

**Assumptions:**
- Oracle Database 12.2 or later
- Working schema: \`MYAPP\` (substitute your schema throughout)
- DBA-level access for job class creation, window management, and monitoring queries
- SET SERVEROUTPUT ON for PL/SQL output blocks

---

## Phase 0: Environment and Privilege Check

### Step 0.1: Verify CJQ0 is running

\`\`\`sql
-- Check that the Job Queue Coordinator is active
SELECT name, description, paddr, status
FROM v\$bgprocess
WHERE name = 'CJQ0';
-- STATUS = 'ACTIVE' means the coordinator is alive
-- STATUS = 'STOPPED' means JOB_QUEUE_PROCESSES=0; ALL scheduled jobs are disabled

-- Check the parameter value
SHOW PARAMETER job_queue_processes;
-- Minimum value of 1 needed; 0 disables the entire scheduler
-- Recommended: 10-50 depending on concurrent job count

-- If JOB_QUEUE_PROCESSES is 0, enable the scheduler:
-- ALTER SYSTEM SET job_queue_processes = 20 SCOPE=BOTH;
\`\`\`

### Step 0.2: Verify user privileges

\`\`\`sql
-- Check CREATE JOB and MANAGE SCHEDULER system privileges
SELECT privilege, admin_option
FROM dba_sys_privs
WHERE grantee = 'MYAPP'
  AND privilege IN ('CREATE JOB', 'MANAGE SCHEDULER',
                    'CREATE EXTERNAL JOB', 'EXECUTE ANY PROGRAM',
                    'MANAGE ANY JOB')
ORDER BY privilege;

-- Check role grants (CREATE JOB is included in DBA role)
SELECT grantee, granted_role, admin_option
FROM dba_role_privs
WHERE grantee = 'MYAPP'
ORDER BY granted_role;

-- Grant minimum required privilege if missing:
-- GRANT CREATE JOB TO MYAPP;
-- For DBA-level operations (job classes, windows):
-- GRANT MANAGE SCHEDULER TO MYAPP;
\`\`\`

### Step 0.3: Check existing job classes

\`\`\`sql
SELECT job_class_name,
       resource_consumer_group,
       service,
       logging_level,
       log_history,
       comments
FROM dba_scheduler_job_classes
ORDER BY job_class_name;
-- Default job class is DEFAULT_JOB_CLASS
-- Note any existing custom classes and their consumer group bindings
\`\`\`

### Step 0.4: Check active maintenance windows

\`\`\`sql
SELECT window_name,
       resource_plan,
       enabled,
       active,
       next_start_date,
       duration,
       schedule_name,
       comments
FROM dba_scheduler_windows
ORDER BY window_name;

-- Which window is currently active (if any)?
SELECT window_name, resource_plan
FROM dba_scheduler_windows
WHERE active = 'TRUE';

-- Check current active resource plan
SELECT plan, is_top_plan
FROM v\$rsrc_plan
WHERE is_top_plan = 'TRUE';
\`\`\`

---

## Phase 1: Create Named Program and Schedule (Reusable Components)

### Step 1.1: Create a STORED_PROCEDURE program with arguments

\`\`\`sql
BEGIN
  -- Drop if already exists from a previous attempt
  BEGIN
    DBMS_SCHEDULER.DROP_PROGRAM('MYAPP.PROG_PURGE_AUDIT_LOG', TRUE);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  DBMS_SCHEDULER.CREATE_PROGRAM(
    program_name        => 'MYAPP.PROG_PURGE_AUDIT_LOG',
    program_type        => 'STORED_PROCEDURE',
    program_action      => 'MYAPP.PKG_MAINTENANCE.PURGE_AUDIT_LOG',
    number_of_arguments => 2,
    enabled             => FALSE,
    comments            => 'Purge audit log rows older than P_DAYS, batching P_BATCH_SIZE rows'
  );

  DBMS_SCHEDULER.DEFINE_PROGRAM_ARGUMENT(
    program_name      => 'MYAPP.PROG_PURGE_AUDIT_LOG',
    argument_position => 1,
    argument_name     => 'P_DAYS',
    argument_type     => 'NUMBER',
    default_value     => '90'
  );

  DBMS_SCHEDULER.DEFINE_PROGRAM_ARGUMENT(
    program_name      => 'MYAPP.PROG_PURGE_AUDIT_LOG',
    argument_position => 2,
    argument_name     => 'P_BATCH_SIZE',
    argument_type     => 'NUMBER',
    default_value     => '5000'
  );

  DBMS_SCHEDULER.ENABLE('MYAPP.PROG_PURGE_AUDIT_LOG');
  DBMS_OUTPUT.PUT_LINE('Program PROG_PURGE_AUDIT_LOG created and enabled.');
END;
/
\`\`\`

### Step 1.2: Create a PLSQL_BLOCK program

\`\`\`sql
BEGIN
  BEGIN
    DBMS_SCHEDULER.DROP_PROGRAM('MYAPP.PROG_REFRESH_SUMMARY_MV', TRUE);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  DBMS_SCHEDULER.CREATE_PROGRAM(
    program_name   => 'MYAPP.PROG_REFRESH_SUMMARY_MV',
    program_type   => 'PLSQL_BLOCK',
    program_action => '
      BEGIN
        DBMS_MVIEW.REFRESH(
          list   => ''MYAPP.MV_DAILY_ORDER_SUMMARY'',
          method => ''C'',
          atomic_refresh => FALSE
        );
        DBMS_MVIEW.REFRESH(
          list   => ''MYAPP.MV_MONTHLY_REVENUE'',
          method => ''C'',
          atomic_refresh => FALSE
        );
      END;',
    enabled        => TRUE,
    comments       => 'Complete refresh of daily order summary and monthly revenue MVs'
  );
  DBMS_OUTPUT.PUT_LINE('Program PROG_REFRESH_SUMMARY_MV created and enabled.');
END;
/
\`\`\`

### Step 1.3: Create named schedules with calendaring expressions

\`\`\`sql
BEGIN
  -- Schedule 1: Every weekday at 02:00
  BEGIN
    DBMS_SCHEDULER.DROP_SCHEDULE('MYAPP.SCHED_WEEKDAYS_0200', TRUE);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  DBMS_SCHEDULER.CREATE_SCHEDULE(
    schedule_name   => 'MYAPP.SCHED_WEEKDAYS_0200',
    start_date      => SYSTIMESTAMP AT TIME ZONE 'US/Eastern',
    repeat_interval => 'FREQ=WEEKLY;BYDAY=MON,TUE,WED,THU,FRI;BYHOUR=2;BYMINUTE=0;BYSECOND=0',
    comments        => 'Every weekday at 02:00 Eastern'
  );

  -- Schedule 2: Last day of each month at 22:00
  BEGIN
    DBMS_SCHEDULER.DROP_SCHEDULE('MYAPP.SCHED_MONTH_END_2200', TRUE);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  DBMS_SCHEDULER.CREATE_SCHEDULE(
    schedule_name   => 'MYAPP.SCHED_MONTH_END_2200',
    start_date      => SYSTIMESTAMP AT TIME ZONE 'US/Eastern',
    repeat_interval => 'FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=22;BYMINUTE=0;BYSECOND=0',
    comments        => 'Last day of each month at 22:00 Eastern'
  );

  -- Schedule 3: Every 15 minutes
  BEGIN
    DBMS_SCHEDULER.DROP_SCHEDULE('MYAPP.SCHED_EVERY_15MIN', TRUE);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  DBMS_SCHEDULER.CREATE_SCHEDULE(
    schedule_name   => 'MYAPP.SCHED_EVERY_15MIN',
    start_date      => SYSTIMESTAMP AT TIME ZONE 'US/Eastern',
    repeat_interval => 'FREQ=MINUTELY;INTERVAL=15',
    comments        => 'Every 15 minutes'
  );

  -- Schedule 4: First Monday of each month at 08:00
  BEGIN
    DBMS_SCHEDULER.DROP_SCHEDULE('MYAPP.SCHED_FIRST_MON_0800', TRUE);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  DBMS_SCHEDULER.CREATE_SCHEDULE(
    schedule_name   => 'MYAPP.SCHED_FIRST_MON_0800',
    start_date      => SYSTIMESTAMP AT TIME ZONE 'US/Eastern',
    repeat_interval => 'FREQ=MONTHLY;BYDAY=MON;BYSETPOS=1;BYHOUR=8;BYMINUTE=0;BYSECOND=0',
    comments        => 'First Monday of each month at 08:00 Eastern'
  );

  DBMS_OUTPUT.PUT_LINE('All schedules created.');
END;
/
\`\`\`

### Step 1.4: Verify programs and schedules

\`\`\`sql
-- Verify programs
SELECT owner, program_name, program_type, program_action,
       number_of_arguments, enabled
FROM dba_scheduler_programs
WHERE owner = 'MYAPP'
ORDER BY program_name;

-- Verify program arguments
SELECT program_name, argument_position, argument_name,
       argument_type, default_value
FROM dba_scheduler_program_args
WHERE owner = 'MYAPP'
ORDER BY program_name, argument_position;

-- Verify schedules
SELECT owner, schedule_name, repeat_interval,
       start_date, comments
FROM dba_scheduler_schedules
WHERE owner = 'MYAPP'
ORDER BY schedule_name;
\`\`\`

### Step 1.5: Test calendar string — show next 5 fire times

\`\`\`sql
SET SERVEROUTPUT ON SIZE 100000

DECLARE
  l_start  TIMESTAMP WITH TIME ZONE := SYSTIMESTAMP;
  l_next   TIMESTAMP WITH TIME ZONE;
  l_expr   VARCHAR2(200);
BEGIN
  -- Test the monthly BYSETPOS expression
  l_expr := 'FREQ=MONTHLY;BYDAY=MON;BYSETPOS=1;BYHOUR=8;BYMINUTE=0;BYSECOND=0';
  DBMS_OUTPUT.PUT_LINE('Schedule: ' || l_expr);
  DBMS_OUTPUT.PUT_LINE('Next 5 fire times:');

  FOR i IN 1..5 LOOP
    DBMS_SCHEDULER.EVALUATE_CALENDAR_STRING(
      calendar_string   => l_expr,
      start_date        => l_start,
      return_date_after => l_start,
      next_run_date     => l_next
    );
    DBMS_OUTPUT.PUT_LINE('  ' || i || ': ' ||
      TO_CHAR(l_next, 'YYYY-MM-DD HH24:MI:SS TZH:TZM'));
    l_start := l_next;
  END LOOP;
END;
/
\`\`\`

---

## Phase 2: Create and Manage Jobs

### Step 2a: Simple inline PL/SQL job running daily

\`\`\`sql
BEGIN
  BEGIN
    DBMS_SCHEDULER.DROP_JOB('MYAPP.JOB_NIGHTLY_STATS', TRUE);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'MYAPP.JOB_NIGHTLY_STATS',
    job_type        => 'PLSQL_BLOCK',
    job_action      => '
      BEGIN
        DBMS_STATS.GATHER_SCHEMA_STATS(
          ownname          => ''MYAPP'',
          estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,
          cascade          => TRUE,
          degree           => 4,
          options          => ''GATHER AUTO''
        );
      END;',
    start_date      => TRUNC(SYSDATE + 1) + 2/24,
    repeat_interval => 'FREQ=DAILY;BYHOUR=2;BYMINUTE=0;BYSECOND=0',
    end_date        => NULL,
    job_class       => 'DEFAULT_JOB_CLASS',
    enabled         => TRUE,
    auto_drop       => FALSE,
    comments        => 'Nightly GATHER AUTO statistics for the MYAPP schema'
  );
  DBMS_OUTPUT.PUT_LINE('Job JOB_NIGHTLY_STATS created.');
END;
/
\`\`\`

### Step 2b: Job using named program + named schedule with argument values

\`\`\`sql
BEGIN
  BEGIN
    DBMS_SCHEDULER.DROP_JOB('MYAPP.JOB_DAILY_PURGE', TRUE);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  DBMS_SCHEDULER.CREATE_JOB(
    job_name      => 'MYAPP.JOB_DAILY_PURGE',
    program_name  => 'MYAPP.PROG_PURGE_AUDIT_LOG',
    schedule_name => 'MYAPP.SCHED_WEEKDAYS_0200',
    job_class     => 'DEFAULT_JOB_CLASS',
    enabled       => FALSE,
    auto_drop     => FALSE,
    restartable   => TRUE,
    comments      => 'Purge audit log rows daily, 90-day retention, 5000-row batches'
  );

  -- Override the default argument values for this job
  DBMS_SCHEDULER.SET_JOB_ARGUMENT_VALUE(
    job_name          => 'MYAPP.JOB_DAILY_PURGE',
    argument_position => 1,
    argument_value    => '90'
  );

  DBMS_SCHEDULER.SET_JOB_ARGUMENT_VALUE(
    job_name          => 'MYAPP.JOB_DAILY_PURGE',
    argument_position => 2,
    argument_value    => '5000'
  );

  DBMS_SCHEDULER.ENABLE('MYAPP.JOB_DAILY_PURGE');
  DBMS_OUTPUT.PUT_LINE('Job JOB_DAILY_PURGE created and enabled.');
END;
/
\`\`\`

### Step 2c: EXECUTABLE job with OS credential

\`\`\`sql
-- First create the OS credential
BEGIN
  BEGIN
    DBMS_SCHEDULER.DROP_CREDENTIAL('SYS.CRED_ORACLE_OS', TRUE);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  DBMS_SCHEDULER.CREATE_CREDENTIAL(
    credential_name => 'SYS.CRED_ORACLE_OS',
    username        => 'oracle',
    password        => 'oracle_os_password_here'
  );
END;
/

-- Create the EXECUTABLE job
BEGIN
  BEGIN
    DBMS_SCHEDULER.DROP_JOB('SYS.JOB_RMAN_BACKUP', TRUE);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'SYS.JOB_RMAN_BACKUP',
    job_type        => 'EXECUTABLE',
    job_action      => '/u01/scripts/rman_incremental_backup.sh',
    number_of_arguments => 1,
    credential_name => 'SYS.CRED_ORACLE_OS',
    start_date      => SYSTIMESTAMP,
    repeat_interval => 'FREQ=DAILY;BYHOUR=0;BYMINUTE=30;BYSECOND=0',
    enabled         => FALSE,
    auto_drop       => FALSE,
    comments        => 'Daily incremental RMAN backup via OS script'
  );

  DBMS_SCHEDULER.SET_JOB_ARGUMENT_VALUE(
    job_name          => 'SYS.JOB_RMAN_BACKUP',
    argument_position => 1,
    argument_value    => 'INCREMENTAL'
  );

  DBMS_SCHEDULER.ENABLE('SYS.JOB_RMAN_BACKUP');
  DBMS_OUTPUT.PUT_LINE('EXECUTABLE job JOB_RMAN_BACKUP created.');
END;
/
\`\`\`

### Step 2d: Job with failure handling and duration controls

\`\`\`sql
BEGIN
  BEGIN
    DBMS_SCHEDULER.DROP_JOB('MYAPP.JOB_LOAD_STAGING', TRUE);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'MYAPP.JOB_LOAD_STAGING',
    job_type        => 'STORED_PROCEDURE',
    job_action      => 'MYAPP.PKG_ETL.LOAD_STAGING_DATA',
    repeat_interval => 'FREQ=HOURLY;INTERVAL=1',
    start_date      => SYSTIMESTAMP,
    job_class       => 'DEFAULT_JOB_CLASS',
    enabled         => FALSE,
    auto_drop       => FALSE,
    restartable     => TRUE,       -- retry on failure
    max_failures    => 5,          -- disable after 5 consecutive failures
    max_runs        => NULL,       -- run indefinitely
    comments        => 'Hourly staging load; disable after 5 consecutive failures'
  );

  -- Set max_run_duration to 45 minutes
  DBMS_SCHEDULER.SET_ATTRIBUTE(
    name      => 'MYAPP.JOB_LOAD_STAGING',
    attribute => 'MAX_RUN_DURATION',
    value     => INTERVAL '45' MINUTE
  );

  DBMS_SCHEDULER.ENABLE('MYAPP.JOB_LOAD_STAGING');
  DBMS_OUTPUT.PUT_LINE('Job JOB_LOAD_STAGING created with failure handling.');
END;
/
\`\`\`

### Step 2e: Disable/enable, SET_ATTRIBUTE, COPY_JOB, DROP_JOB

\`\`\`sql
-- Disable a job (stops future scheduling; currently running job is not affected)
EXEC DBMS_SCHEDULER.DISABLE('MYAPP.JOB_NIGHTLY_STATS');

-- Re-enable a job
EXEC DBMS_SCHEDULER.ENABLE('MYAPP.JOB_NIGHTLY_STATS');

-- Change the repeat_interval
BEGIN
  DBMS_SCHEDULER.SET_ATTRIBUTE(
    name      => 'MYAPP.JOB_NIGHTLY_STATS',
    attribute => 'REPEAT_INTERVAL',
    value     => 'FREQ=DAILY;BYHOUR=3;BYMINUTE=0;BYSECOND=0'
  );
END;
/

-- Change the job class (affects resource management and logging)
BEGIN
  DBMS_SCHEDULER.SET_ATTRIBUTE(
    name      => 'MYAPP.JOB_NIGHTLY_STATS',
    attribute => 'JOB_CLASS',
    value     => 'MYAPP_MAINT_CLASS'
  );
END;
/

-- Change the comments
BEGIN
  DBMS_SCHEDULER.SET_ATTRIBUTE(
    name      => 'MYAPP.JOB_NIGHTLY_STATS',
    attribute => 'COMMENTS',
    value     => 'Nightly statistics gather, moved to 03:00 after load analysis'
  );
END;
/

-- Clone the job for a second schema
BEGIN
  DBMS_SCHEDULER.COPY_JOB(
    old_job => 'MYAPP.JOB_DAILY_PURGE',
    new_job => 'MYAPP2.JOB_DAILY_PURGE'
  );
  -- Override retention for the new schema
  DBMS_SCHEDULER.SET_JOB_ARGUMENT_VALUE(
    job_name          => 'MYAPP2.JOB_DAILY_PURGE',
    argument_position => 1,
    argument_value    => '30'
  );
  DBMS_SCHEDULER.ENABLE('MYAPP2.JOB_DAILY_PURGE');
END;
/

-- Drop a job permanently (force=TRUE drops even if running)
EXEC DBMS_SCHEDULER.DROP_JOB('MYAPP2.JOB_DAILY_PURGE', force => TRUE);
\`\`\`

---

## Phase 3: Job Classes

### Step 3.1: Create a job class with resource management and logging

\`\`\`sql
BEGIN
  BEGIN
    DBMS_SCHEDULER.DROP_JOB_CLASS('MYAPP_MAINT_CLASS', TRUE);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  DBMS_SCHEDULER.CREATE_JOB_CLASS(
    job_class_name          => 'MYAPP_MAINT_CLASS',
    resource_consumer_group => 'BATCH_GROUP',
    service                 => NULL,
    logging_level           => DBMS_SCHEDULER.LOGGING_RUNS,
    log_history             => 45,   -- keep 45 days of log history
    comments                => 'MYAPP maintenance jobs, bound to BATCH_GROUP consumer group'
  );
  DBMS_OUTPUT.PUT_LINE('Job class MYAPP_MAINT_CLASS created.');
END;
/
\`\`\`

### Step 3.2: Assign jobs to the class and verify

\`\`\`sql
-- Assign JOB_NIGHTLY_STATS to the new class
BEGIN
  DBMS_SCHEDULER.SET_ATTRIBUTE(
    name      => 'MYAPP.JOB_NIGHTLY_STATS',
    attribute => 'JOB_CLASS',
    value     => 'MYAPP_MAINT_CLASS'
  );
END;
/

-- Verify the assignment
SELECT job_name, job_class, enabled, state, next_run_date
FROM dba_scheduler_jobs
WHERE owner = 'MYAPP'
ORDER BY job_name;

-- Query all job classes
SELECT job_class_name, resource_consumer_group,
       logging_level, log_history, service, comments
FROM dba_scheduler_job_classes
ORDER BY job_class_name;
\`\`\`

---

## Phase 4: Create a Chain

This phase creates a complete 3-step ETL chain where step3 only runs if step2 succeeded, and a failure notification step runs if any step fails.

### Step 4.1: Create the chain and steps

\`\`\`sql
BEGIN
  -- Drop existing chain
  BEGIN
    DBMS_SCHEDULER.DROP_CHAIN('MYAPP.CHAIN_ETL_DAILY', TRUE);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  -- Create the chain object
  DBMS_SCHEDULER.CREATE_CHAIN(
    chain_name => 'MYAPP.CHAIN_ETL_DAILY',
    comments   => 'Daily ETL: extract -> transform -> load with failure notification'
  );

  -- Define chain steps (each references a named program)
  DBMS_SCHEDULER.DEFINE_CHAIN_STEP(
    chain_name   => 'MYAPP.CHAIN_ETL_DAILY',
    step_name    => 'STEP1_EXTRACT',
    program_name => 'MYAPP.PROG_ETL_EXTRACT'
  );

  DBMS_SCHEDULER.DEFINE_CHAIN_STEP(
    chain_name   => 'MYAPP.CHAIN_ETL_DAILY',
    step_name    => 'STEP2_TRANSFORM',
    program_name => 'MYAPP.PROG_ETL_TRANSFORM'
  );

  DBMS_SCHEDULER.DEFINE_CHAIN_STEP(
    chain_name   => 'MYAPP.CHAIN_ETL_DAILY',
    step_name    => 'STEP3_LOAD',
    program_name => 'MYAPP.PROG_ETL_LOAD'
  );

  DBMS_SCHEDULER.DEFINE_CHAIN_STEP(
    chain_name   => 'MYAPP.CHAIN_ETL_DAILY',
    step_name    => 'STEP_ERR_NOTIFY',
    program_name => 'MYAPP.PROG_SEND_FAILURE_EMAIL'
  );

  DBMS_OUTPUT.PUT_LINE('Chain and steps defined.');
END;
/
\`\`\`

### Step 4.2: Define chain rules

\`\`\`sql
BEGIN
  -- Rule 1: Always start the extract step (chain entry point)
  DBMS_SCHEDULER.DEFINE_CHAIN_RULE(
    chain_name => 'MYAPP.CHAIN_ETL_DAILY',
    rule_name  => 'RULE_START',
    condition  => 'TRUE',
    action     => 'START STEP1_EXTRACT',
    comments   => 'Always start extraction'
  );

  -- Rule 2: Run transform only if extract succeeded
  DBMS_SCHEDULER.DEFINE_CHAIN_RULE(
    chain_name => 'MYAPP.CHAIN_ETL_DAILY',
    rule_name  => 'RULE_EXTRACT_OK',
    condition  => 'STEP1_EXTRACT SUCCEEDED',
    action     => 'START STEP2_TRANSFORM',
    comments   => 'Proceed to transform only when extract succeeds'
  );

  -- Rule 3: Run load only if transform succeeded
  DBMS_SCHEDULER.DEFINE_CHAIN_RULE(
    chain_name => 'MYAPP.CHAIN_ETL_DAILY',
    rule_name  => 'RULE_TRANSFORM_OK',
    condition  => 'STEP2_TRANSFORM SUCCEEDED',
    action     => 'START STEP3_LOAD',
    comments   => 'Proceed to load only when transform succeeds'
  );

  -- Rule 4: Send failure notification if any step fails
  DBMS_SCHEDULER.DEFINE_CHAIN_RULE(
    chain_name => 'MYAPP.CHAIN_ETL_DAILY',
    rule_name  => 'RULE_ANY_FAIL',
    condition  => 'STEP1_EXTRACT FAILED OR STEP2_TRANSFORM FAILED OR STEP3_LOAD FAILED',
    action     => 'START STEP_ERR_NOTIFY',
    comments   => 'Send failure email if any ETL step fails'
  );

  -- Rule 5: End chain successfully when load completes
  DBMS_SCHEDULER.DEFINE_CHAIN_RULE(
    chain_name => 'MYAPP.CHAIN_ETL_DAILY',
    rule_name  => 'RULE_END_OK',
    condition  => 'STEP3_LOAD SUCCEEDED',
    action     => 'END',
    comments   => 'End chain after successful load'
  );

  -- Rule 6: End chain with error after notification runs
  DBMS_SCHEDULER.DEFINE_CHAIN_RULE(
    chain_name => 'MYAPP.CHAIN_ETL_DAILY',
    rule_name  => 'RULE_END_ERR',
    condition  => 'STEP_ERR_NOTIFY SUCCEEDED OR STEP_ERR_NOTIFY FAILED',
    action     => 'END 1',
    comments   => 'End chain with error after failure notification'
  );

  DBMS_OUTPUT.PUT_LINE('Chain rules defined.');
END;
/
\`\`\`

### Step 4.3: Enable chain and create the job

\`\`\`sql
-- Enable the chain
EXEC DBMS_SCHEDULER.ENABLE('MYAPP.CHAIN_ETL_DAILY');

-- Create a job that runs the chain on a daily schedule
BEGIN
  BEGIN
    DBMS_SCHEDULER.DROP_JOB('MYAPP.JOB_ETL_DAILY', TRUE);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'MYAPP.JOB_ETL_DAILY',
    job_type        => 'CHAIN',
    job_action      => 'MYAPP.CHAIN_ETL_DAILY',
    repeat_interval => 'FREQ=DAILY;BYHOUR=1;BYMINUTE=0;BYSECOND=0',
    enabled         => TRUE,
    auto_drop       => FALSE,
    comments        => 'Daily ETL chain job'
  );
  DBMS_OUTPUT.PUT_LINE('ETL chain job created.');
END;
/

-- Run the chain immediately for testing (asynchronous)
BEGIN
  DBMS_SCHEDULER.RUN_CHAIN(
    chain_name   => 'MYAPP.CHAIN_ETL_DAILY',
    job_name     => 'MYAPP.JOB_ETL_DAILY_TEST',
    start_steps  => 'STEP1_EXTRACT'
  );
END;
/

-- Monitor running chain steps
SELECT job_name, chain_name, step_name, state, error_code,
       start_date, end_date
FROM dba_scheduler_running_chains
WHERE job_name LIKE 'MYAPP.JOB_ETL%'
ORDER BY start_date;
\`\`\`

---

## Phase 5: Windows and AutoTask Management

### Step 5.1: Query maintenance windows and resource plans

\`\`\`sql
-- All defined windows with their resource plans and schedules
SELECT w.window_name,
       w.resource_plan,
       w.enabled,
       w.active,
       w.duration,
       w.next_start_date,
       w.schedule_name,
       w.window_priority
FROM dba_scheduler_windows w
ORDER BY w.window_name;

-- Which resource plan is currently active?
SELECT plan, is_top_plan, start_time
FROM v\$rsrc_plan
ORDER BY is_top_plan DESC;

-- Window group memberships (shows which windows are in MAINTENANCE_WINDOW_GROUP)
SELECT wg.window_group_name, wgm.window_name
FROM dba_scheduler_window_groups wg
JOIN dba_scheduler_wingroup_members wgm
  ON wg.window_group_name = wgm.window_group_name
ORDER BY wg.window_group_name, wgm.window_name;
\`\`\`

### Step 5.2: Open and close a window manually

\`\`\`sql
-- Open the nightly maintenance window immediately for 2 hours
-- (Useful during emergency maintenance when you need the maintenance resource plan active)
BEGIN
  DBMS_SCHEDULER.OPEN_WINDOW(
    window_name => 'WEEKNIGHT_WINDOW',
    duration    => INTERVAL '2' HOUR,
    force       => TRUE
  );
  DBMS_OUTPUT.PUT_LINE('Window opened.');
END;
/

-- Verify the window is now active
SELECT window_name, active, resource_plan
FROM dba_scheduler_windows
WHERE active = 'TRUE';

-- Close the window early when maintenance is complete
BEGIN
  DBMS_SCHEDULER.CLOSE_WINDOW(window_name => 'WEEKNIGHT_WINDOW');
  DBMS_OUTPUT.PUT_LINE('Window closed.');
END;
/
\`\`\`

### Step 5.3: List AutoTask clients and their status

\`\`\`sql
-- AutoTask clients: the three built-in maintenance operations
SELECT client_name,
       status,
       consumer_group,
       window_group,
       mean_job_duration,
       service_name
FROM dba_autotask_client
ORDER BY client_name;
-- Clients: 'auto optimizer stats collection'
--          'auto segment advisor'
--          'auto space advisor'

-- Disable auto optimizer stats collection
-- (Use this if you manage statistics with a custom DBMS_STATS job)
BEGIN
  DBMS_AUTO_TASK_ADMIN.DISABLE(
    client_name => 'auto optimizer stats collection',
    operation   => NULL,
    window_name => NULL   -- disable across all windows; specify a window name to disable for one only
  );
END;
/

-- Re-enable it
BEGIN
  DBMS_AUTO_TASK_ADMIN.ENABLE(
    client_name => 'auto optimizer stats collection',
    operation   => NULL,
    window_name => NULL
  );
END;
/
\`\`\`

### Step 5.4: Check AutoTask job history

\`\`\`sql
-- AutoTask execution history per maintenance window (last 14 days)
SELECT client_name,
       window_name,
       jobs_created,
       jobs_started,
       jobs_completed,
       window_start_time,
       window_end_time
FROM dba_autotask_client_history
WHERE window_start_time > SYSDATE - 14
ORDER BY window_start_time DESC, client_name;
\`\`\`

---

## Phase 6: Monitoring Dashboard

### Step 6.1: All enabled jobs with status summary

\`\`\`sql
SELECT j.owner,
       j.job_name,
       j.job_type,
       j.job_class,
       j.enabled,
       j.state,
       j.next_run_date,
       j.last_start_date,
       j.run_count,
       j.failure_count,
       j.last_run_duration,
       d.status AS last_run_status,
       d.error# AS last_error_code
FROM dba_scheduler_jobs j
LEFT JOIN (
  SELECT owner, job_name, status, error#,
         ROW_NUMBER() OVER (PARTITION BY owner, job_name ORDER BY log_date DESC) AS rn
  FROM dba_scheduler_job_run_details
) d ON j.owner = d.owner AND j.job_name = d.job_name AND d.rn = 1
WHERE j.enabled = 'TRUE'
ORDER BY j.owner, j.job_name;
\`\`\`

### Step 6.2: Currently running jobs with elapsed time

\`\`\`sql
SELECT rj.owner,
       rj.job_name,
       rj.running_instance,
       rj.session_id,
       rj.slave_process_id,
       rj.elapsed_time,
       rj.cpu_used,
       s.username,
       s.program,
       s.event AS current_wait,
       s.wait_class,
       ROUND(s.last_call_et / 60, 1) AS mins_in_current_state,
       SUBSTR(sq.sql_text, 1, 80) AS current_sql
FROM dba_scheduler_running_jobs rj
JOIN v\$session s ON rj.session_id = s.sid
LEFT JOIN v\$sql sq ON s.sql_id = sq.sql_id AND s.sql_child_number = sq.child_number
ORDER BY rj.elapsed_time DESC;
\`\`\`

### Step 6.3: Recently failed jobs with error details

\`\`\`sql
SELECT d.log_date,
       d.owner,
       d.job_name,
       d.status,
       d.error# AS error_code,
       d.run_duration,
       d.cpu_used,
       SUBSTR(d.additional_info, 1, 500) AS error_detail
FROM dba_scheduler_job_run_details d
WHERE d.status = 'FAILED'
  AND d.log_date > SYSDATE - 1
ORDER BY d.log_date DESC
FETCH FIRST 30 ROWS ONLY;
\`\`\`

---

## Phase 7: Job Control

### Step 7.1: Run a job immediately (asynchronous)

\`\`\`sql
-- RUN_JOB with use_current_session=>FALSE: runs asynchronously in a J000 slave
-- The call returns immediately; the job executes in the background
BEGIN
  DBMS_SCHEDULER.RUN_JOB(
    job_name            => 'MYAPP.JOB_NIGHTLY_STATS',
    use_current_session => FALSE
  );
  DBMS_OUTPUT.PUT_LINE('Job dispatched asynchronously.');
END;
/

-- RUN_JOB with use_current_session=>TRUE: runs in the calling session (synchronous, blocking)
-- Use for quick testing; output visible in SQL*Plus via DBMS_OUTPUT
BEGIN
  DBMS_SCHEDULER.RUN_JOB(
    job_name            => 'MYAPP.JOB_NIGHTLY_STATS',
    use_current_session => TRUE
  );
  DBMS_OUTPUT.PUT_LINE('Job completed in current session.');
END;
/
\`\`\`

### Step 7.2: Stop a running job

\`\`\`sql
-- Graceful stop: requests the job to stop at the next safe point
BEGIN
  DBMS_SCHEDULER.STOP_JOB(
    job_name => 'MYAPP.JOB_NIGHTLY_STATS',
    force    => FALSE
  );
END;
/

-- Force stop: immediately terminates the slave process
BEGIN
  DBMS_SCHEDULER.STOP_JOB(
    job_name => 'MYAPP.JOB_NIGHTLY_STATS',
    force    => TRUE
  );
END;
/

-- Check that the job is no longer running
SELECT job_name, state FROM dba_scheduler_jobs WHERE job_name = 'JOB_NIGHTLY_STATS';
-- STATE should be SCHEDULED (not RUNNING)
\`\`\`

### Step 7.3: Pause and resume a job schedule

\`\`\`sql
-- Pause a job's schedule (job stays defined but will not fire)
-- Equivalent to DISABLE but uses different internal mechanism for window-based jobs
EXEC DBMS_SCHEDULER.DISABLE('MYAPP.JOB_LOAD_STAGING');

-- Resume (re-enable) the schedule
EXEC DBMS_SCHEDULER.ENABLE('MYAPP.JOB_LOAD_STAGING');
\`\`\`

### Step 7.4: Handle a job stuck in RUNNING state

\`\`\`sql
-- Step 1: Identify the stuck job and its session
SELECT rj.job_name,
       rj.session_id,
       rj.slave_process_id,
       rj.elapsed_time,
       s.status AS session_status,
       s.event AS session_wait,
       s.serial#
FROM dba_scheduler_running_jobs rj
JOIN v\$session s ON rj.session_id = s.sid
WHERE rj.owner = 'MYAPP';

-- Step 2: Attempt graceful stop first
BEGIN
  DBMS_SCHEDULER.STOP_JOB(
    job_name => 'MYAPP.JOB_NIGHTLY_STATS',
    force    => FALSE
  );
END;
/

-- Step 3: If graceful stop does not work within 60 seconds, force stop
BEGIN
  DBMS_SCHEDULER.STOP_JOB(
    job_name => 'MYAPP.JOB_NIGHTLY_STATS',
    force    => TRUE
  );
END;
/

-- Step 4: If the job still shows in DBA_SCHEDULER_RUNNING_JOBS,
-- kill the slave session directly
-- (substitute SID and SERIAL# from the query in Step 1)
ALTER SYSTEM KILL SESSION '145,2937' IMMEDIATE;

-- Step 5: Verify the job is no longer running
SELECT job_name, state
FROM dba_scheduler_jobs
WHERE owner = 'MYAPP' AND job_name = 'JOB_NIGHTLY_STATS';
\`\`\`

---

## Phase 8: Log Management

### Step 8.1: Check log table size

\`\`\`sql
-- Scheduler log segment sizes in SYS schema
SELECT owner, segment_name, segment_type,
       bytes / 1024 / 1024 AS size_mb,
       blocks
FROM dba_segments
WHERE owner = 'SYS'
  AND segment_name IN (
    SELECT table_name
    FROM dba_tables
    WHERE owner = 'SYS'
      AND table_name LIKE 'SCHED\$%'
  )
ORDER BY bytes DESC;

-- Row counts in the scheduler log views
SELECT 'DBA_SCHEDULER_JOB_LOG' AS view_name,
       COUNT(*) AS row_count,
       MIN(log_date) AS oldest_entry,
       MAX(log_date) AS newest_entry
FROM dba_scheduler_job_log
UNION ALL
SELECT 'DBA_SCHEDULER_JOB_RUN_DETAILS',
       COUNT(*),
       MIN(log_date),
       MAX(log_date)
FROM dba_scheduler_job_run_details;
\`\`\`

### Step 8.2: Adjust log_history on the default job class

\`\`\`sql
-- Reduce DEFAULT_JOB_CLASS log retention to 30 days
BEGIN
  DBMS_SCHEDULER.SET_ATTRIBUTE(
    name      => 'DEFAULT_JOB_CLASS',
    attribute => 'LOG_HISTORY',
    value     => 30
  );
  DBMS_OUTPUT.PUT_LINE('DEFAULT_JOB_CLASS log_history set to 30 days.');
END;
/

-- Set log_history on MYAPP_MAINT_CLASS
BEGIN
  DBMS_SCHEDULER.SET_ATTRIBUTE(
    name      => 'MYAPP_MAINT_CLASS',
    attribute => 'LOG_HISTORY',
    value     => 45
  );
END;
/
\`\`\`

### Step 8.3: Archive log entries before purging

\`\`\`sql
-- Create an audit table to archive log entries before purging
CREATE TABLE myapp.scheduler_log_archive AS
SELECT * FROM dba_scheduler_job_run_details WHERE 1=0;

-- Archive entries older than 30 days that have not yet been archived
INSERT INTO myapp.scheduler_log_archive
SELECT jrd.*
FROM dba_scheduler_job_run_details jrd
WHERE jrd.owner = 'MYAPP'
  AND jrd.log_date < SYSDATE - 30
  AND NOT EXISTS (
    SELECT 1 FROM myapp.scheduler_log_archive arc
    WHERE arc.log_id = jrd.log_id
  );

COMMIT;
SELECT COUNT(*) AS archived_rows FROM myapp.scheduler_log_archive;
\`\`\`

### Step 8.4: PURGE_LOG — selective and full purge

\`\`\`sql
-- Purge ALL log entries older than 30 days (both job log and window log)
BEGIN
  DBMS_SCHEDULER.PURGE_LOG(
    log_history => 30,
    which_log   => 'JOB_AND_WINDOW_LOG'
  );
  DBMS_OUTPUT.PUT_LINE('Purge complete.');
END;
/

-- Purge only the job run details for a specific job (keep 7 days)
BEGIN
  DBMS_SCHEDULER.PURGE_LOG(
    log_history => 7,
    which_log   => 'JOB_LOG',
    job_name    => 'MYAPP.JOB_NIGHTLY_STATS'
  );
END;
/

-- Verify the purge
SELECT COUNT(*) AS remaining_rows,
       MIN(log_date) AS oldest_entry
FROM dba_scheduler_job_log
WHERE owner = 'MYAPP';
\`\`\`

---

## Phase 9: Notifications via Email

### Step 9.1: Job-based failure detection using UTL_MAIL

This creates a monitoring job that queries \`DBA_SCHEDULER_JOB_RUN_DETAILS\` for recent failures and sends an email alert via \`UTL_MAIL\`.

\`\`\`sql
-- Prerequisites: UTL_MAIL must be configured
-- ALTER SYSTEM SET smtp_out_server = 'mail.example.com:25' SCOPE=BOTH;
-- GRANT EXECUTE ON UTL_MAIL TO MYAPP;

BEGIN
  BEGIN
    DBMS_SCHEDULER.DROP_JOB('MYAPP.JOB_FAILURE_ALERT', TRUE);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'MYAPP.JOB_FAILURE_ALERT',
    job_type        => 'PLSQL_BLOCK',
    job_action      => '
DECLARE
  v_subject  VARCHAR2(200);
  v_body     CLOB;
  v_count    NUMBER := 0;
BEGIN
  -- Check for failures in the last 30 minutes
  FOR r IN (
    SELECT job_name, log_date, error#, run_duration,
           SUBSTR(additional_info, 1, 300) AS error_detail
    FROM dba_scheduler_job_run_details
    WHERE owner = ''MYAPP''
      AND status = ''FAILED''
      AND log_date > SYSDATE - 30/1440
    ORDER BY log_date DESC
  ) LOOP
    v_count := v_count + 1;
    v_body := v_body ||
      ''Job: '' || r.job_name || CHR(10) ||
      ''Time: '' || TO_CHAR(r.log_date, ''YYYY-MM-DD HH24:MI:SS'') || CHR(10) ||
      ''Error: '' || r.error# || CHR(10) ||
      ''Detail: '' || r.error_detail || CHR(10) ||
      ''---'' || CHR(10);
  END LOOP;

  IF v_count > 0 THEN
    v_subject := ''ALERT: '' || v_count || '' MYAPP scheduler job(s) failed on '' || SYS_CONTEXT(''USERENV'', ''DB_NAME'');
    UTL_MAIL.SEND(
      sender     => ''oracle-alerts@example.com'',
      recipients => ''dba-team@example.com'',
      subject    => v_subject,
      message    => TO_CHAR(v_body),
      mime_type  => ''text/plain; charset=us-ascii''
    );
  END IF;
END;',
    repeat_interval => 'FREQ=MINUTELY;INTERVAL=30',
    enabled         => TRUE,
    auto_drop       => FALSE,
    comments        => 'Check for MYAPP job failures every 30 minutes and email DBA team'
  );
  DBMS_OUTPUT.PUT_LINE('Job JOB_FAILURE_ALERT created.');
END;
/
\`\`\`

### Step 9.2: Native scheduler email notifications (ADD_EVENT_EMAIL_NOTIFICATION)

Oracle 12c+ supports native scheduler notifications that fire automatically on job events without requiring a polling job.

\`\`\`sql
-- Step 1: Configure the SMTP server for native notifications
BEGIN
  DBMS_SCHEDULER.SET_SCHEDULER_ATTRIBUTE(
    attribute => 'email_server',
    value     => 'mail.example.com:25'
  );
  DBMS_SCHEDULER.SET_SCHEDULER_ATTRIBUTE(
    attribute => 'email_sender',
    value     => 'oracle-scheduler@example.com'
  );
END;
/

-- Step 2: Verify the scheduler attributes
SELECT attribute_name, value
FROM dba_scheduler_global_attribute
WHERE attribute_name IN ('EMAIL_SERVER', 'EMAIL_SENDER');

-- Step 3: Add email notification for a specific job on failure
BEGIN
  DBMS_SCHEDULER.ADD_EVENT_EMAIL_NOTIFICATION(
    job_name  => 'MYAPP.JOB_NIGHTLY_STATS',
    recipient => 'dba-team@example.com',
    sender    => 'oracle-scheduler@example.com',
    subject   => 'Scheduler Job \${job_owner}.\${job_name} \${event_type}',
    body      => 'Job: \${job_owner}.\${job_name}' || CHR(10) ||
                 'Event: \${event_type}' || CHR(10) ||
                 'Time: \${event_timestamp}' || CHR(10) ||
                 'Error: \${error_message}' || CHR(10) ||
                 'Run Duration: \${run_duration}',
    events    => 'JOB_FAILED'
  );
  DBMS_OUTPUT.PUT_LINE('Email notification added for JOB_NIGHTLY_STATS.');
END;
/

-- Available event types for notifications:
-- JOB_STARTED, JOB_SUCCEEDED, JOB_FAILED, JOB_BROKEN,
-- JOB_COMPLETED, JOB_STOPPED, JOB_SCH_LIM_REACHED,
-- JOB_DISABLED, JOB_CHAIN_STALLED

-- Remove a notification
BEGIN
  DBMS_SCHEDULER.REMOVE_EVENT_EMAIL_NOTIFICATION(
    job_name  => 'MYAPP.JOB_NIGHTLY_STATS',
    recipient => 'dba-team@example.com',
    events    => 'JOB_FAILED'
  );
END;
/

-- View current notifications
SELECT owner, job_name, recipient, event_type, subject
FROM dba_scheduler_notifications
WHERE owner = 'MYAPP'
ORDER BY job_name;
\`\`\`

---

## Phase 10: Troubleshooting Runbook

### Step 10.1: Job is not firing

\`\`\`sql
-- Check 1: Is the job enabled and what is its state?
SELECT job_name, enabled, state, next_run_date, last_start_date,
       failure_count, max_failures, run_count
FROM dba_scheduler_jobs
WHERE job_name = 'JOB_NIGHTLY_STATS'
  AND owner = 'MYAPP';
-- STATE values: SCHEDULED (waiting), RUNNING, DISABLED, FAILED, SUCCEEDED, BROKEN
-- If DISABLED: manually disabled or max_failures was hit
-- If SCHEDULED but next_run_date is far in the future: check the calendaring expression

-- Check 2: Is JOB_QUEUE_PROCESSES > 0 and CJQ0 running?
SHOW PARAMETER job_queue_processes;
SELECT name, status FROM v\$bgprocess WHERE name = 'CJQ0';

-- Check 3: Is the job's window open? (window-based jobs only)
SELECT window_name, active, next_start_date, enabled
FROM dba_scheduler_windows
ORDER BY window_name;

-- Check 4: Is a resource plan blocking the consumer group?
SELECT p.plan, d.group_or_subplan, d.cpu_p1, d.active_sess_pool_p1
FROM v\$rsrc_plan rp
JOIN dba_rsrc_plan_directives d ON d.plan = rp.plan
JOIN dba_rsrc_plans p ON p.plan = rp.plan
WHERE rp.is_top_plan = 'TRUE'
ORDER BY d.group_or_subplan;

-- Check 5: What does the job log say?
SELECT log_date, operation, status, error#, additional_info
FROM dba_scheduler_job_log
WHERE job_name = 'JOB_NIGHTLY_STATS'
  AND owner = 'MYAPP'
ORDER BY log_date DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

### Step 10.2: Job runs but produces no results

\`\`\`sql
-- Read ADDITIONAL_INFO from the most recent run
SELECT log_date, status, error# AS error_code, run_duration, cpu_used,
       ADDITIONAL_INFO
FROM dba_scheduler_job_run_details
WHERE job_name = 'JOB_NIGHTLY_STATS'
  AND owner = 'MYAPP'
ORDER BY log_date DESC
FETCH FIRST 5 ROWS ONLY;
-- For PLSQL_BLOCK jobs, exceptions caught inside the block but not re-raised
-- will show status SUCCEEDED but ADDITIONAL_INFO may contain diagnostic output.
-- Unhandled exceptions show status FAILED with ORA- text in ADDITIONAL_INFO.

-- Check for exceptions swallowed by WHEN OTHERS THEN NULL in the job action
-- If the job completes in < 1 second but should take minutes, the block is exiting early
SELECT job_name, last_run_duration, run_count
FROM dba_scheduler_jobs
WHERE job_name = 'JOB_NIGHTLY_STATS' AND owner = 'MYAPP';
\`\`\`

### Step 10.3: Identify and kill a stuck running job

\`\`\`sql
-- Step 1: Find all running jobs and their sessions
SELECT rj.owner, rj.job_name,
       rj.session_id, rj.slave_process_id,
       rj.running_instance, rj.elapsed_time,
       s.serial#, s.status, s.event, s.wait_class,
       ROUND(s.last_call_et / 60, 1) AS mins_in_state
FROM dba_scheduler_running_jobs rj
JOIN v\$session s ON rj.session_id = s.sid
ORDER BY rj.elapsed_time DESC;

-- Step 2: Identify if the job is actually doing work or is stuck
-- (event = 'SQL*Net message from client' or long idle waits = likely stuck)

-- Step 3: Force-stop via DBMS_SCHEDULER
BEGIN
  DBMS_SCHEDULER.STOP_JOB(
    job_name => 'MYAPP.JOB_NIGHTLY_STATS',
    force    => TRUE
  );
END;
/

-- Step 4: If still showing in DBA_SCHEDULER_RUNNING_JOBS, kill the session
-- (Get SID and SERIAL# from the query above)
ALTER SYSTEM KILL SESSION '145,2937' IMMEDIATE;

-- Step 5: Confirm cleanup
SELECT COUNT(*) AS still_running
FROM dba_scheduler_running_jobs
WHERE job_name = 'JOB_NIGHTLY_STATS' AND owner = 'MYAPP';
\`\`\`

### Step 10.4: Diagnose a chain that is not advancing

\`\`\`sql
-- Step 1: Check the current state of all chain steps
SELECT job_name, chain_name, step_name, state, error_code,
       start_date, end_date
FROM dba_scheduler_running_chains
WHERE job_name = 'MYAPP.JOB_ETL_DAILY'
ORDER BY start_date;

-- Step 2: If a step shows RUNNING for too long, check its session
SELECT rj.job_name, rj.session_id, rj.elapsed_time,
       s.event, s.wait_class, s.status
FROM dba_scheduler_running_jobs rj
JOIN v\$session s ON rj.session_id = s.sid
WHERE rj.job_name = 'MYAPP.JOB_ETL_DAILY';

-- Step 3: Review the chain rules to verify conditions match the actual step states
SELECT rule_name, condition, action, enabled
FROM dba_scheduler_chain_rules
WHERE chain_name = 'MYAPP.CHAIN_ETL_DAILY'
ORDER BY rule_name;
-- Look for: rule condition references a step name with a typo,
-- or the condition requires a state the step never reached
-- Example: rule condition 'STEP1_EXTRACT SUCCEEDED' will never fire
-- if STEP1_EXTRACT completed with state FAILED

-- Step 4: Check the job run details for the chain job itself
SELECT log_date, status, run_duration, error#, additional_info
FROM dba_scheduler_job_run_details
WHERE job_name = 'JOB_ETL_DAILY' AND owner = 'MYAPP'
ORDER BY log_date DESC
FETCH FIRST 5 ROWS ONLY;
\`\`\`

### Step 10.5: Find the session belonging to a running job

\`\`\`sql
-- Join DBA_SCHEDULER_RUNNING_JOBS to V$SESSION for full session context
SELECT rj.owner AS job_owner,
       rj.job_name,
       rj.running_instance AS rac_instance,
       rj.elapsed_time,
       rj.cpu_used,
       s.sid,
       s.serial#,
       s.username,
       s.osuser,
       s.machine,
       s.program,
       s.module,
       s.action,
       s.status AS session_status,
       s.event AS current_wait,
       s.wait_class,
       s.blocking_session,
       SUBSTR(sq.sql_text, 1, 100) AS current_sql_fragment
FROM dba_scheduler_running_jobs rj
JOIN v\$session s ON rj.session_id = s.sid
LEFT JOIN v\$sql sq ON s.sql_id = sq.sql_id
                    AND s.sql_child_number = sq.child_number
ORDER BY rj.elapsed_time DESC;
\`\`\`

---

## Quick Reference: Essential DBMS_SCHEDULER One-Liners

\`\`\`sql
-- Run a job immediately (async)
EXEC DBMS_SCHEDULER.RUN_JOB('MYAPP.JOB_NIGHTLY_STATS', use_current_session => FALSE);

-- Enable a job
EXEC DBMS_SCHEDULER.ENABLE('MYAPP.JOB_NIGHTLY_STATS');

-- Disable a job
EXEC DBMS_SCHEDULER.DISABLE('MYAPP.JOB_NIGHTLY_STATS');

-- Force-stop a running job
EXEC DBMS_SCHEDULER.STOP_JOB('MYAPP.JOB_NIGHTLY_STATS', force => TRUE);

-- Drop a job (force drops even if running)
EXEC DBMS_SCHEDULER.DROP_JOB('MYAPP.JOB_NIGHTLY_STATS', force => TRUE);

-- Change repeat_interval
EXEC DBMS_SCHEDULER.SET_ATTRIBUTE('MYAPP.JOB_NIGHTLY_STATS', 'REPEAT_INTERVAL', 'FREQ=DAILY;BYHOUR=3;BYMINUTE=0;BYSECOND=0');

-- Check next 5 fire times for a calendaring expression
-- (Use the EVALUATE_CALENDAR_STRING DECLARE block from Phase 1, Step 1.5)

-- Show all enabled jobs and their next run time
SELECT owner, job_name, state, next_run_date FROM dba_scheduler_jobs WHERE enabled = 'TRUE' ORDER BY next_run_date;

-- Show currently running jobs
SELECT owner, job_name, session_id, elapsed_time FROM dba_scheduler_running_jobs ORDER BY elapsed_time DESC;

-- Show last 10 failures
SELECT owner, job_name, log_date, error#, SUBSTR(additional_info,1,200) FROM dba_scheduler_job_run_details WHERE status='FAILED' ORDER BY log_date DESC FETCH FIRST 10 ROWS ONLY;

-- Purge log entries older than 30 days
EXEC DBMS_SCHEDULER.PURGE_LOG(log_history => 30, which_log => 'JOB_AND_WINDOW_LOG');

-- Test a calendar string (show next fire time)
DECLARE l_next TIMESTAMP WITH TIME ZONE; BEGIN DBMS_SCHEDULER.EVALUATE_CALENDAR_STRING('FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=22;BYMINUTE=0;BYSECOND=0', SYSTIMESTAMP, SYSTIMESTAMP, l_next); DBMS_OUTPUT.PUT_LINE(TO_CHAR(l_next,'YYYY-MM-DD HH24:MI:SS TZH:TZM')); END; /

-- Check JOB_QUEUE_PROCESSES
SHOW PARAMETER job_queue_processes;

-- Enable all jobs scheduler-wide (set JOB_QUEUE_PROCESSES > 0)
ALTER SYSTEM SET job_queue_processes = 20 SCOPE=BOTH;

-- Open a maintenance window manually for 1 hour
EXEC DBMS_SCHEDULER.OPEN_WINDOW('WEEKNIGHT_WINDOW', INTERVAL '1' HOUR, TRUE);

-- Close a maintenance window early
EXEC DBMS_SCHEDULER.CLOSE_WINDOW('WEEKNIGHT_WINDOW');
\`\`\``,
};

async function main() {
  console.log('Inserting Oracle DBMS_SCHEDULER runbook post...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: {
      title: post.title,
      excerpt: post.excerpt,
      content: post.content,
      published: post.published,
      publishedAt: post.publishedAt,
      isPremium: post.isPremium,
    },
  });
  console.log(`Inserted: "${post.title}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
