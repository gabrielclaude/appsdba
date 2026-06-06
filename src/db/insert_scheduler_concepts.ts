import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle DBMS_SCHEDULER: Architecture, Job Types, and Advanced Scheduling',
  slug: 'oracle-dbms-scheduler-architecture-job-types',
  excerpt:
    'A deep-dive into Oracle DBMS_SCHEDULER: kernel-level architecture, job coordinator and slave processes, programs and reusable schedules, calendaring syntax, job classes and resource plans, Windows and AutoTask, multi-step Chains, File Watchers, RAC placement, external jobs, and a complete diagnostic guide for jobs that will not run.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-06'),
  youtubeUrl: null,
  content: `Oracle DBMS_SCHEDULER replaced DBMS_JOB as the primary job scheduling mechanism in Oracle 10g. Unlike DBMS_JOB, which was a thin wrapper around an internal queue, DBMS_SCHEDULER is a first-class kernel subsystem with its own background processes, a rich object model, resource plan integration, multi-step chains, and OS-level job execution. Understanding how it works internally makes debugging misfiring jobs much faster.

---

## 1. Architecture and Components

### Kernel integration

DBMS_SCHEDULER is not an external process or an agent. It lives entirely inside the Oracle kernel. The scheduler uses two classes of background processes:

- **CJQ0 (Job Queue Coordinator)**: the master coordinator process. It wakes up periodically (controlled by \`JOB_QUEUE_PROCESSES\`) and evaluates which jobs are due to run. CJQ0 spawns job queue slave processes (J000–J999) to execute jobs.
- **J000–J999 (Job Queue Slaves)**: spawned by CJQ0 on demand. Each slave executes one job at a time. The maximum number of concurrent slaves is bounded by \`JOB_QUEUE_PROCESSES\`.

The coordinator uses a short polling loop. When it finds a job whose \`NEXT_RUN_DATE\` is in the past and whose state is \`SCHEDULED\`, it dispatches a slave process to run it. For jobs that reference a Window, the coordinator also tracks when Windows open and close.

\`\`\`sql
-- Confirm CJQ0 is running
SELECT name, description, paddr, status
FROM v\$bgprocess
WHERE name = 'CJQ0';
-- STATUS = 'ACTIVE' means CJQ0 is alive; 'STOPPED' means JOB_QUEUE_PROCESSES=0

-- Check the parameter
SHOW PARAMETER job_queue_processes;
-- Minimum value of 1 enables the coordinator; 0 disables ALL scheduled jobs
\`\`\`

### Comparison with DBMS_JOB

DBMS_JOB is still supported but is effectively deprecated. Key differences:

| Feature | DBMS_JOB | DBMS_SCHEDULER |
|---|---|---|
| Object model | Single flat job record | Programs, Schedules, Job Classes, Chains |
| Calendaring | Interval expression (SYSDATE+1/24) | ICAL-like calendaring syntax |
| OS execution | No | Yes (EXECUTABLE type) |
| Resource management | None | Job class → resource consumer group |
| Logging | No built-in logging | DBA_SCHEDULER_JOB_LOG, JOB_RUN_DETAILS |
| RAC placement | Instance affinity via what(dbms_job) | Service-based placement via job class |
| Chain support | No | Yes |

### Key data dictionary objects

All scheduler objects are stored in the data dictionary and visible through \`DBA_SCHEDULER_*\` views:

\`\`\`sql
SELECT view_name
FROM dba_views
WHERE view_name LIKE 'DBA_SCHEDULER%'
ORDER BY view_name;
-- Returns: DBA_SCHEDULER_CHAINS, DBA_SCHEDULER_CHAIN_RULES, DBA_SCHEDULER_CHAIN_STEPS,
--          DBA_SCHEDULER_CREDENTIALS, DBA_SCHEDULER_DB_DESTS,
--          DBA_SCHEDULER_FILE_WATCHERS, DBA_SCHEDULER_JOB_ARGS,
--          DBA_SCHEDULER_JOB_CLASSES, DBA_SCHEDULER_JOB_LOG,
--          DBA_SCHEDULER_JOB_RUN_DETAILS, DBA_SCHEDULER_JOBS,
--          DBA_SCHEDULER_NOTIFICATIONS, DBA_SCHEDULER_PROGRAMS,
--          DBA_SCHEDULER_PROGRAM_ARGS, DBA_SCHEDULER_RUNNING_CHAINS,
--          DBA_SCHEDULER_RUNNING_JOBS, DBA_SCHEDULER_SCHEDULES,
--          DBA_SCHEDULER_WINDOW_DETAILS, DBA_SCHEDULER_WINDOW_GROUPS,
--          DBA_SCHEDULER_WINDOWS, DBA_SCHEDULER_WINGROUP_MEMBERS
\`\`\`

The object hierarchy:

\`\`\`
WINDOW GROUPS
  └── WINDOWS (tied to a resource plan + schedule)
       └── controls AutoTask clients

JOB CLASSES (resource group, logging level, log history, service)
  └── JOBs (inline or referencing PROGRAM + SCHEDULE)
       └── PROGRAMS (PL/SQL block, stored procedure, executable, chain)
            └── PROGRAM ARGUMENTS
       └── SCHEDULES (calendaring expressions)

CHAINS
  └── CHAIN STEPS (reference programs)
  └── CHAIN RULES (condition-based step sequencing)

FILE WATCHERS (trigger jobs on file arrival)
CREDENTIALS (OS authentication for EXECUTABLE jobs)
\`\`\`

---

## 2. Programs

A Program encapsulates *what* to run. By separating the program from the job, the same program can be reused across multiple jobs with different schedules or different argument values.

### Program types

- **PLSQL_BLOCK**: an anonymous PL/SQL block. Quick to create but not reusable by name from other contexts.
- **STORED_PROCEDURE**: references a named PL/SQL package procedure or standalone procedure. Best for maintainability.
- **EXECUTABLE**: runs an OS command or script via the Oracle scheduler agent (requires external job infrastructure).
- **CHAIN**: references a named chain object as the job's executable.

### Creating programs

\`\`\`sql
-- STORED_PROCEDURE program with two arguments
BEGIN
  DBMS_SCHEDULER.CREATE_PROGRAM(
    program_name   => 'MYAPP.PROC_PURGE_OLD_LOGS',
    program_type   => 'STORED_PROCEDURE',
    program_action => 'MYAPP.PKG_MAINTENANCE.PURGE_OLD_LOGS',
    number_of_arguments => 2,
    enabled        => FALSE,
    comments       => 'Purges audit log rows older than N days'
  );

  -- Define the arguments
  DBMS_SCHEDULER.DEFINE_PROGRAM_ARGUMENT(
    program_name      => 'MYAPP.PROC_PURGE_OLD_LOGS',
    argument_position => 1,
    argument_name     => 'P_RETENTION_DAYS',
    argument_type     => 'NUMBER',
    default_value     => '90'
  );

  DBMS_SCHEDULER.DEFINE_PROGRAM_ARGUMENT(
    program_name      => 'MYAPP.PROC_PURGE_OLD_LOGS',
    argument_position => 2,
    argument_name     => 'P_BATCH_SIZE',
    argument_type     => 'NUMBER',
    default_value     => '5000'
  );

  -- Enable the program so jobs can reference it
  DBMS_SCHEDULER.ENABLE('MYAPP.PROC_PURGE_OLD_LOGS');
END;
/
\`\`\`

\`\`\`sql
-- Anonymous PL/SQL block program (no arguments possible for PLSQL_BLOCK)
BEGIN
  DBMS_SCHEDULER.CREATE_PROGRAM(
    program_name   => 'MYAPP.PROG_REFRESH_MV',
    program_type   => 'PLSQL_BLOCK',
    program_action => 'BEGIN DBMS_MVIEW.REFRESH(''MYAPP.MV_DAILY_SUMMARY'', ''C''); END;',
    enabled        => TRUE,
    comments       => 'Complete refresh of the daily summary materialized view'
  );
END;
/
\`\`\`

\`\`\`sql
-- EXECUTABLE program referencing an OS shell script
BEGIN
  DBMS_SCHEDULER.CREATE_PROGRAM(
    program_name   => 'SYS.PROG_ARCHIVE_LOGS',
    program_type   => 'EXECUTABLE',
    program_action => '/u01/scripts/archive_archivelogs.sh',
    number_of_arguments => 1,
    enabled        => FALSE
  );

  DBMS_SCHEDULER.DEFINE_PROGRAM_ARGUMENT(
    program_name      => 'SYS.PROG_ARCHIVE_LOGS',
    argument_position => 1,
    argument_name     => 'P_DEST_DIR',
    argument_type     => 'VARCHAR2',
    default_value     => '/u02/archive_backup'
  );

  DBMS_SCHEDULER.ENABLE('SYS.PROG_ARCHIVE_LOGS');
END;
/
\`\`\`

\`\`\`sql
-- Verify program creation
SELECT owner, program_name, program_type, program_action,
       number_of_arguments, enabled, comments
FROM dba_scheduler_programs
WHERE owner = 'MYAPP'
ORDER BY program_name;

-- View program arguments
SELECT program_name, argument_position, argument_name,
       argument_type, default_value
FROM dba_scheduler_program_args
WHERE owner = 'MYAPP'
ORDER BY program_name, argument_position;
\`\`\`

**Why separate programs from jobs:** Once \`PROC_PURGE_OLD_LOGS\` is defined, you can create a weekly job for production (90-day retention) and a daily job for a test schema (7-day retention) that both reference the same program object. If the underlying procedure's package changes, the job and program definitions remain unchanged.

---

## 3. Schedules and Calendaring Syntax

A named Schedule encapsulates *when* to run. Like programs, schedules can be shared across multiple jobs.

### Creating schedules

\`\`\`sql
-- Named schedule: every weekday at 06:00
BEGIN
  DBMS_SCHEDULER.CREATE_SCHEDULE(
    schedule_name   => 'MYAPP.SCHED_WEEKDAYS_0600',
    start_date      => SYSTIMESTAMP AT TIME ZONE 'US/Eastern',
    repeat_interval => 'FREQ=WEEKLY;BYDAY=MON,TUE,WED,THU,FRI;BYHOUR=6;BYMINUTE=0;BYSECOND=0',
    comments        => 'Every weekday at 06:00 Eastern'
  );
END;
/
\`\`\`

\`\`\`sql
-- Named schedule: last day of every month at 23:00
BEGIN
  DBMS_SCHEDULER.CREATE_SCHEDULE(
    schedule_name   => 'MYAPP.SCHED_MONTH_END',
    start_date      => SYSTIMESTAMP AT TIME ZONE 'US/Eastern',
    repeat_interval => 'FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=23;BYMINUTE=0;BYSECOND=0',
    comments        => 'Last day of each month at 23:00'
  );
END;
/
\`\`\`

\`\`\`sql
-- Named schedule: first Monday of each month at 08:00
BEGIN
  DBMS_SCHEDULER.CREATE_SCHEDULE(
    schedule_name   => 'MYAPP.SCHED_FIRST_MON',
    start_date      => SYSTIMESTAMP AT TIME ZONE 'US/Eastern',
    repeat_interval => 'FREQ=MONTHLY;BYDAY=MON;BYSETPOS=1;BYHOUR=8;BYMINUTE=0;BYSECOND=0',
    comments        => 'First Monday of each month at 08:00'
  );
END;
/
\`\`\`

\`\`\`sql
-- Named schedule: every 4 hours during business hours (08:00, 12:00, 16:00)
BEGIN
  DBMS_SCHEDULER.CREATE_SCHEDULE(
    schedule_name   => 'MYAPP.SCHED_BIZ_HOURS_4H',
    start_date      => SYSTIMESTAMP AT TIME ZONE 'US/Eastern',
    repeat_interval => 'FREQ=DAILY;BYHOUR=8,12,16;BYMINUTE=0;BYSECOND=0',
    comments        => 'Three times per day during business hours'
  );
END;
/
\`\`\`

\`\`\`sql
-- Named schedule: every 15 minutes
BEGIN
  DBMS_SCHEDULER.CREATE_SCHEDULE(
    schedule_name   => 'MYAPP.SCHED_EVERY_15MIN',
    start_date      => SYSTIMESTAMP AT TIME ZONE 'US/Eastern',
    repeat_interval => 'FREQ=MINUTELY;INTERVAL=15',
    comments        => 'Every 15 minutes'
  );
END;
/
\`\`\`

### Calendaring syntax reference

The \`repeat_interval\` parameter follows a subset of the iCalendar (RFC 2445) recurrence rule format:

| Keyword | Values | Meaning |
|---|---|---|
| \`FREQ\` | YEARLY, MONTHLY, WEEKLY, DAILY, HOURLY, MINUTELY, SECONDLY | Base frequency |
| \`INTERVAL\` | positive integer | Run every N units of FREQ |
| \`BYDAY\` | MON, TUE, WED, THU, FRI, SAT, SUN | Day(s) of the week |
| \`BYMONTHDAY\` | 1–31, or -1 (last day), -2 (second to last) | Day(s) of the month |
| \`BYHOUR\` | 0–23 | Hour(s) |
| \`BYMINUTE\` | 0–59 | Minute(s) |
| \`BYSECOND\` | 0–59 | Second(s) |
| \`BYSETPOS\` | positive or negative integer | Position within the set (1=first, -1=last) |
| \`BYMONTH\` | 1–12 | Month(s) of the year |

Practical examples:

\`\`\`
FREQ=DAILY;BYHOUR=2;BYMINUTE=30;BYSECOND=0
  → Every day at 02:30:00

FREQ=WEEKLY;INTERVAL=2;BYDAY=SAT;BYHOUR=3;BYMINUTE=0;BYSECOND=0
  → Every other Saturday at 03:00

FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=0;BYMINUTE=0;BYSECOND=0
  → First day of every month at midnight

FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=22;BYMINUTE=0;BYSECOND=0
  → Last day of every month at 22:00

FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1;BYHOUR=0;BYMINUTE=0;BYSECOND=0
  → January 1st every year at midnight

FREQ=HOURLY;INTERVAL=6
  → Every 6 hours

FREQ=MINUTELY;INTERVAL=30
  → Every 30 minutes
\`\`\`

### Testing calendaring expressions

Always test a new \`repeat_interval\` before attaching it to a production job:

\`\`\`sql
-- EVALUATE_CALENDAR_STRING: show the next N fire times
DECLARE
  l_start   TIMESTAMP WITH TIME ZONE := SYSTIMESTAMP;
  l_next    TIMESTAMP WITH TIME ZONE;
  l_expr    VARCHAR2(200) := 'FREQ=MONTHLY;BYDAY=MON;BYSETPOS=1;BYHOUR=8;BYMINUTE=0;BYSECOND=0';
BEGIN
  FOR i IN 1..5 LOOP
    DBMS_SCHEDULER.EVALUATE_CALENDAR_STRING(
      calendar_string  => l_expr,
      start_date       => l_start,
      return_date_after => l_start,
      next_run_date    => l_next
    );
    DBMS_OUTPUT.PUT_LINE('Fire ' || i || ': ' || TO_CHAR(l_next, 'YYYY-MM-DD HH24:MI:SS TZH:TZM'));
    l_start := l_next;
  END LOOP;
END;
/
\`\`\`

### Named schedule vs. inline repeat_interval

A job can reference a named schedule or use an inline \`repeat_interval\`. Use a named schedule when:
- Multiple jobs share the same firing pattern
- You want to change all dependent jobs at once (change the schedule, all jobs update)
- The schedule has a meaningful business name (\`SCHED_MONTH_END\` is self-documenting)

Use inline \`repeat_interval\` for one-off jobs where sharing is not required.

---

## 4. Jobs

A Job is the runnable unit. It ties a program (or inline action) to a schedule (or inline repeat_interval), with execution policy, resource class, and operational parameters.

### Basic job creation

\`\`\`sql
-- Simple inline PL/SQL job
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'MYAPP.JOB_NIGHTLY_STATS',
    job_type        => 'PLSQL_BLOCK',
    job_action      => 'BEGIN MYAPP.PKG_MAINTENANCE.GATHER_STALE_STATS; END;',
    start_date      => TRUNC(SYSDATE+1) + 2/24,  -- next day at 02:00
    repeat_interval => 'FREQ=DAILY;BYHOUR=2;BYMINUTE=0;BYSECOND=0',
    end_date        => NULL,
    job_class       => 'DEFAULT_JOB_CLASS',
    enabled         => TRUE,
    auto_drop       => FALSE,
    comments        => 'Nightly statistics gather for stale tables'
  );
END;
/
\`\`\`

\`\`\`sql
-- Job using a named program + named schedule with argument values
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'MYAPP.JOB_WEEKLY_PURGE',
    program_name    => 'MYAPP.PROC_PURGE_OLD_LOGS',
    schedule_name   => 'MYAPP.SCHED_WEEKDAYS_0600',
    job_class       => 'MYAPP_MAINT_CLASS',
    enabled         => FALSE,
    auto_drop       => FALSE,
    restartable     => TRUE,
    max_failures    => 3,
    max_runs        => NULL,
    comments        => 'Weekly purge of audit logs older than 90 days'
  );

  -- Set argument values for this specific job
  DBMS_SCHEDULER.SET_JOB_ARGUMENT_VALUE(
    job_name          => 'MYAPP.JOB_WEEKLY_PURGE',
    argument_position => 1,
    argument_value    => '90'
  );

  DBMS_SCHEDULER.SET_JOB_ARGUMENT_VALUE(
    job_name          => 'MYAPP.JOB_WEEKLY_PURGE',
    argument_position => 2,
    argument_value    => '10000'
  );

  DBMS_SCHEDULER.ENABLE('MYAPP.JOB_WEEKLY_PURGE');
END;
/
\`\`\`

### Key job parameters

| Parameter | Meaning |
|---|---|
| \`job_type\` | PLSQL_BLOCK, STORED_PROCEDURE, EXECUTABLE, CHAIN |
| \`job_action\` | The code/procedure/script to run (for inline jobs) |
| \`start_date\` | When the job first becomes eligible to run |
| \`repeat_interval\` | Calendaring expression for recurring jobs |
| \`end_date\` | Stop scheduling after this date |
| \`job_class\` | Job class for resource management and logging |
| \`enabled\` | TRUE = job will fire; FALSE = job is paused |
| \`auto_drop\` | TRUE = drop the job after it runs once (for one-time jobs) |
| \`restartable\` | TRUE = retry the job if it fails (up to max_failures) |
| \`max_failures\` | Disable the job after this many consecutive failures |
| \`max_runs\` | Stop running after this many successful executions |
| \`max_run_duration\` | INTERVAL; stop the job if it runs longer than this |
| \`comments\` | Free text description |

### Modifying job properties after creation

\`\`\`sql
-- Change the schedule on a running job
BEGIN
  DBMS_SCHEDULER.SET_ATTRIBUTE(
    name      => 'MYAPP.JOB_NIGHTLY_STATS',
    attribute => 'REPEAT_INTERVAL',
    value     => 'FREQ=DAILY;BYHOUR=3;BYMINUTE=30;BYSECOND=0'
  );
END;
/

-- Change the job class
BEGIN
  DBMS_SCHEDULER.SET_ATTRIBUTE(
    name      => 'MYAPP.JOB_NIGHTLY_STATS',
    attribute => 'JOB_CLASS',
    value     => 'MYAPP_LOWPRIORITY_CLASS'
  );
END;
/

-- Set max_run_duration to 2 hours
BEGIN
  DBMS_SCHEDULER.SET_ATTRIBUTE(
    name      => 'MYAPP.JOB_NIGHTLY_STATS',
    attribute => 'MAX_RUN_DURATION',
    value     => INTERVAL '2' HOUR
  );
END;
/

-- Disable and enable a job
EXEC DBMS_SCHEDULER.DISABLE('MYAPP.JOB_NIGHTLY_STATS');
EXEC DBMS_SCHEDULER.ENABLE('MYAPP.JOB_NIGHTLY_STATS');
\`\`\`

### COPY_JOB

\`COPY_JOB\` clones an existing job, including all attributes and argument values, under a new name. Useful when creating similar jobs for multiple schemas:

\`\`\`sql
-- Clone JOB_WEEKLY_PURGE into a new job for a second schema
BEGIN
  DBMS_SCHEDULER.COPY_JOB(
    old_job => 'MYAPP.JOB_WEEKLY_PURGE',
    new_job => 'MYAPP2.JOB_WEEKLY_PURGE'
  );
  -- Then customize the new job as needed
  DBMS_SCHEDULER.SET_JOB_ARGUMENT_VALUE(
    job_name          => 'MYAPP2.JOB_WEEKLY_PURGE',
    argument_position => 1,
    argument_value    => '30'   -- shorter retention for MYAPP2
  );
  DBMS_SCHEDULER.ENABLE('MYAPP2.JOB_WEEKLY_PURGE');
END;
/
\`\`\`

---

## 5. Job Classes

Job Classes are the bridge between the scheduler and the Oracle Resource Manager. They also control logging behavior for all jobs assigned to the class.

### Creating a job class

\`\`\`sql
BEGIN
  DBMS_SCHEDULER.CREATE_JOB_CLASS(
    job_class_name          => 'MYAPP_MAINT_CLASS',
    resource_consumer_group => 'BATCH_GROUP',
    service                 => NULL,          -- NULL means any instance (set for RAC)
    logging_level           => DBMS_SCHEDULER.LOGGING_RUNS,
    log_history             => 30,            -- retain 30 days of log entries
    comments                => 'Job class for MYAPP maintenance jobs, bound to BATCH_GROUP'
  );
END;
/
\`\`\`

### Logging levels

| Level constant | Meaning |
|---|---|
| \`DBMS_SCHEDULER.LOGGING_OFF\` | No logging |
| \`DBMS_SCHEDULER.LOGGING_FAILED_RUNS\` | Log only failed runs |
| \`DBMS_SCHEDULER.LOGGING_RUNS\` | Log all runs (success and failure) |
| \`DBMS_SCHEDULER.LOGGING_FULL\` | Log runs plus all job operations (enable, disable, etc.) |

\`LOGGING_RUNS\` is the recommended default for production. Use \`LOGGING_FULL\` when troubleshooting; it generates substantially more log volume.

### Why job classes matter

1. **Resource Manager integration**: assigning a job class to a consumer group ensures that CPU and I/O intensive maintenance jobs do not compete with OLTP sessions. Configure the resource plan to limit \`BATCH_GROUP\` to 20% CPU during business hours.
2. **Log retention**: without a finite \`log_history\`, DBA_SCHEDULER_JOB_LOG grows unbounded. Setting 30–90 days is appropriate for most environments.
3. **RAC job placement**: the \`service\` attribute on the job class pins all jobs in the class to a specific database service (and therefore to specific RAC nodes).

\`\`\`sql
-- Assign a job to a job class (can also be done at CREATE_JOB time)
BEGIN
  DBMS_SCHEDULER.SET_ATTRIBUTE(
    name      => 'MYAPP.JOB_NIGHTLY_STATS',
    attribute => 'JOB_CLASS',
    value     => 'MYAPP_MAINT_CLASS'
  );
END;
/

-- Query job classes
SELECT job_class_name, resource_consumer_group,
       logging_level, log_history, service
FROM dba_scheduler_job_classes
ORDER BY job_class_name;
\`\`\`

---

## 6. Windows and Window Groups

A Window ties a time period (defined by a schedule) to a Resource Manager plan. When a Window opens, Oracle activates the associated resource plan. When it closes, the previous plan is restored. This allows maintenance jobs to automatically receive more resources during off-peak hours without any manual intervention.

### Creating a Window

\`\`\`sql
-- Maintenance window: every night 22:00–06:00
BEGIN
  DBMS_SCHEDULER.CREATE_WINDOW(
    window_name     => 'MYAPP_NIGHTLY_WINDOW',
    resource_plan   => 'MYAPP_MAINTENANCE_PLAN',
    schedule_name   => 'MYAPP.SCHED_WEEKDAYS_0600',  -- opens at 06:00? No — see below
    duration        => INTERVAL '8' HOUR,             -- window stays open 8 hours
    window_priority => LOW,
    comments        => 'Nightly maintenance window with elevated batch resource plan'
  );
END;
/
-- Note: start_date on the schedule determines when the window OPENS.
-- duration controls how long it stays open.
-- If two windows overlap, the higher-priority one takes precedence.
\`\`\`

### Manually opening and closing Windows

\`\`\`sql
-- Force a window open now (emergency: need to activate maintenance resource plan)
BEGIN
  DBMS_SCHEDULER.OPEN_WINDOW(
    window_name => 'MYAPP_NIGHTLY_WINDOW',
    duration    => INTERVAL '2' HOUR,
    force       => TRUE
  );
END;
/

-- Close a window early
BEGIN
  DBMS_SCHEDULER.CLOSE_WINDOW(window_name => 'MYAPP_NIGHTLY_WINDOW');
END;
/
\`\`\`

### Window Groups

A Window Group is a named collection of Windows. Jobs can reference a Window Group as their schedule; the job then runs during any window in the group.

\`\`\`sql
-- Create a window group for all maintenance windows
BEGIN
  DBMS_SCHEDULER.CREATE_WINDOW_GROUP(
    group_name => 'MYAPP_MAINTENANCE_GROUP',
    window_list => 'MYAPP_NIGHTLY_WINDOW',
    comments => 'All MYAPP maintenance windows'
  );

  -- Add more windows later
  DBMS_SCHEDULER.ADD_WINDOW_GROUP_MEMBER(
    group_name => 'MYAPP_MAINTENANCE_GROUP',
    window_list => 'MYAPP_WEEKEND_WINDOW'
  );
END;
/
\`\`\`

### AutoTask and the maintenance window group

Oracle's AutoTask framework uses the pre-built \`MAINTENANCE_WINDOW_GROUP\` to schedule three built-in maintenance operations:

- **auto optimizer stats collection**: gathers stale statistics on objects that have changed by more than 10% since the last gather
- **auto segment advisor**: identifies segments with significant free space (wasted from row deletions/updates)
- **auto space advisor**: identifies tablespace growth trends

\`\`\`sql
-- Check which maintenance windows are defined
SELECT window_name, schedule_name, duration, resource_plan, enabled, active
FROM dba_scheduler_windows
ORDER BY window_name;

-- Check AutoTask client status
SELECT client_name, status, consumer_group, mean_job_duration
FROM dba_autotask_client
ORDER BY client_name;

-- Disable auto optimizer stats collection (when you manage stats manually)
BEGIN
  DBMS_AUTO_TASK_ADMIN.DISABLE(
    client_name => 'auto optimizer stats collection',
    operation   => NULL,
    window_name => NULL
  );
END;
/
\`\`\`

---

## 7. Chains

A Chain is a directed graph of job steps where each step can execute a different program, and the transitions between steps are controlled by rules that evaluate step completion states.

### Chain step states

| State | Meaning |
|---|---|
| NOT_STARTED | Step has not been reached yet |
| RUNNING | Step is currently executing |
| SUCCEEDED | Step completed without error |
| FAILED | Step completed with an error |
| STOPPED | Step was stopped externally |
| PAUSED | Step is waiting on a dependency |

### Creating a Chain: ETL example

This chain runs three steps in sequence. The load step only runs if the transform step succeeded. If any step fails, a notification step runs.

\`\`\`sql
-- Step 1: Create the chain object
BEGIN
  DBMS_SCHEDULER.CREATE_CHAIN(
    chain_name   => 'MYAPP.CHAIN_ETL_DAILY',
    rule_set_name => NULL,
    evaluation_interval => NULL,
    comments     => 'Daily ETL: extract → transform → load, with failure notification'
  );
END;
/

-- Step 2: Define chain steps (each step references a program)
BEGIN
  -- Extract step
  DBMS_SCHEDULER.DEFINE_CHAIN_STEP(
    chain_name  => 'MYAPP.CHAIN_ETL_DAILY',
    step_name   => 'STEP_EXTRACT',
    program_name => 'MYAPP.PROG_ETL_EXTRACT'
  );

  -- Transform step
  DBMS_SCHEDULER.DEFINE_CHAIN_STEP(
    chain_name  => 'MYAPP.CHAIN_ETL_DAILY',
    step_name   => 'STEP_TRANSFORM',
    program_name => 'MYAPP.PROG_ETL_TRANSFORM'
  );

  -- Load step
  DBMS_SCHEDULER.DEFINE_CHAIN_STEP(
    chain_name  => 'MYAPP.CHAIN_ETL_DAILY',
    step_name   => 'STEP_LOAD',
    program_name => 'MYAPP.PROG_ETL_LOAD'
  );

  -- Error notification step
  DBMS_SCHEDULER.DEFINE_CHAIN_STEP(
    chain_name  => 'MYAPP.CHAIN_ETL_DAILY',
    step_name   => 'STEP_NOTIFY_FAILURE',
    program_name => 'MYAPP.PROG_SEND_FAILURE_EMAIL'
  );
END;
/

-- Step 3: Define chain rules (transition conditions)
BEGIN
  -- Start STEP_EXTRACT when the chain starts
  DBMS_SCHEDULER.DEFINE_CHAIN_RULE(
    chain_name  => 'MYAPP.CHAIN_ETL_DAILY',
    rule_name   => 'RULE_START_EXTRACT',
    condition   => 'TRUE',
    action      => 'START STEP_EXTRACT',
    comments    => 'Always start the extract step'
  );

  -- Start STEP_TRANSFORM only when STEP_EXTRACT succeeds
  DBMS_SCHEDULER.DEFINE_CHAIN_RULE(
    chain_name  => 'MYAPP.CHAIN_ETL_DAILY',
    rule_name   => 'RULE_EXTRACT_TO_TRANSFORM',
    condition   => 'STEP_EXTRACT SUCCEEDED',
    action      => 'START STEP_TRANSFORM',
    comments    => 'Run transform only if extract succeeded'
  );

  -- Start STEP_LOAD only when STEP_TRANSFORM succeeds
  DBMS_SCHEDULER.DEFINE_CHAIN_RULE(
    chain_name  => 'MYAPP.CHAIN_ETL_DAILY',
    rule_name   => 'RULE_TRANSFORM_TO_LOAD',
    condition   => 'STEP_TRANSFORM SUCCEEDED',
    action      => 'START STEP_LOAD',
    comments    => 'Run load only if transform succeeded'
  );

  -- Notify on any step failure
  DBMS_SCHEDULER.DEFINE_CHAIN_RULE(
    chain_name  => 'MYAPP.CHAIN_ETL_DAILY',
    rule_name   => 'RULE_ANY_FAILURE_NOTIFY',
    condition   => 'STEP_EXTRACT FAILED OR STEP_TRANSFORM FAILED OR STEP_LOAD FAILED',
    action      => 'START STEP_NOTIFY_FAILURE',
    comments    => 'Send failure email if any step fails'
  );

  -- End chain when load succeeds or notification runs
  DBMS_SCHEDULER.DEFINE_CHAIN_RULE(
    chain_name  => 'MYAPP.CHAIN_ETL_DAILY',
    rule_name   => 'RULE_END_ON_SUCCESS',
    condition   => 'STEP_LOAD SUCCEEDED',
    action      => 'END',
    comments    => 'End chain after successful load'
  );

  DBMS_SCHEDULER.DEFINE_CHAIN_RULE(
    chain_name  => 'MYAPP.CHAIN_ETL_DAILY',
    rule_name   => 'RULE_END_ON_NOTIFY',
    condition   => 'STEP_NOTIFY_FAILURE SUCCEEDED OR STEP_NOTIFY_FAILURE FAILED',
    action      => 'END 1',   -- end with error code 1
    comments    => 'End chain after failure notification'
  );
END;
/

-- Step 4: Enable the chain
EXEC DBMS_SCHEDULER.ENABLE('MYAPP.CHAIN_ETL_DAILY');

-- Step 5: Create a job that runs the chain on a schedule
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'MYAPP.JOB_ETL_DAILY',
    job_type        => 'CHAIN',
    job_action      => 'MYAPP.CHAIN_ETL_DAILY',
    repeat_interval => 'FREQ=DAILY;BYHOUR=1;BYMINUTE=0;BYSECOND=0',
    enabled         => TRUE,
    comments        => 'Daily ETL chain job'
  );
END;
/
\`\`\`

\`\`\`sql
-- Monitor running chain step states
SELECT job_name, chain_name, step_name, state, error_code,
       start_date, end_date
FROM dba_scheduler_running_chains
WHERE job_name = 'MYAPP.JOB_ETL_DAILY'
ORDER BY start_date;
\`\`\`

---

## 8. File Watchers

A File Watcher monitors a directory for the arrival of a file matching a pattern, then fires a job when the file appears. This is useful for event-driven ETL where a file drop from an upstream system triggers processing.

### Architecture

The File Watcher infrastructure requires the **Oracle Scheduler Agent** (\`schagent\`) to be running on the OS. The agent polls the monitored directory and raises a scheduler event when the file appears. Without a running scheduler agent, File Watchers do not work.

### Creating a credential for OS authentication

\`\`\`sql
-- Create an OS credential (the agent uses this to authenticate on the OS)
BEGIN
  DBMS_SCHEDULER.CREATE_CREDENTIAL(
    credential_name => 'MYAPP.CRED_ORACLE_OS',
    username        => 'oracle',
    password        => 'oracle_os_password'   -- the oracle OS user password
  );
END;
/
\`\`\`

### Creating a File Watcher

\`\`\`sql
BEGIN
  DBMS_SCHEDULER.CREATE_FILE_WATCHER(
    file_watcher_name => 'MYAPP.FW_INBOUND_ORDERS',
    directory_path    => '/u01/inbound/orders',
    file_name         => 'ORDERS_*.csv',
    credential_name   => 'MYAPP.CRED_ORACLE_OS',
    destination       => NULL,          -- NULL means local host
    enabled           => TRUE,
    comments          => 'Trigger ETL when an ORDERS_*.csv file arrives'
  );
END;
/

-- Create a job that is triggered by the file watcher event
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name          => 'MYAPP.JOB_PROCESS_ORDERS_FILE',
    program_name      => 'MYAPP.PROG_LOAD_ORDERS_CSV',
    schedule_name     => 'MYAPP.FW_INBOUND_ORDERS',  -- reference the file watcher
    enabled           => TRUE,
    auto_drop         => FALSE,
    comments          => 'Process inbound orders CSV on file arrival'
  );
END;
/
\`\`\`

### File Watcher limitations

- Requires Oracle Scheduler Agent on the OS — extra installation and configuration overhead
- The agent must be running continuously; agent restarts can cause missed file events
- Limited to local hosts or registered remote destinations
- No built-in duplicate prevention: if the same file is dropped twice, the job fires twice
- **Alternative**: for simpler environments, an external table or a PL/SQL job that polls a staging directory with \`UTL_FILE.FGETATTR\` can be more reliable than the file watcher infrastructure

---

## 9. Job Execution and Logging

### Logging views

\`\`\`sql
-- DBA_SCHEDULER_JOB_LOG: one row per job event (run start, run end, disable, etc.)
SELECT log_date, owner, job_name, operation, status, error#
FROM dba_scheduler_job_log
WHERE job_name = 'JOB_NIGHTLY_STATS'
ORDER BY log_date DESC
FETCH FIRST 10 ROWS ONLY;

-- DBA_SCHEDULER_JOB_RUN_DETAILS: one row per completed run with full detail
SELECT log_date, owner, job_name, status,
       error# AS error_code,
       run_duration,
       cpu_used,
       SUBSTR(additional_info, 1, 500) AS error_detail
FROM dba_scheduler_job_run_details
WHERE job_name = 'JOB_NIGHTLY_STATS'
ORDER BY log_date DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

The \`ADDITIONAL_INFO\` column in \`DBA_SCHEDULER_JOB_RUN_DETAILS\` contains the full ORA- error text when a job fails. This is the first place to look when a job is marked FAILED.

### Controlling log retention

\`\`\`sql
-- Set log history on a job class (retain 60 days)
BEGIN
  DBMS_SCHEDULER.SET_ATTRIBUTE(
    name      => 'MYAPP_MAINT_CLASS',
    attribute => 'LOG_HISTORY',
    value     => 60
  );
END;
/

-- Purge all log entries older than 30 days
BEGIN
  DBMS_SCHEDULER.PURGE_LOG(
    log_history => 30,   -- keep the last 30 days; purge everything older
    which_log   => 'JOB_AND_WINDOW_LOG'
  );
END;
/

-- Purge log entries for a specific job only
BEGIN
  DBMS_SCHEDULER.PURGE_LOG(
    log_history => 7,
    which_log   => 'JOB_LOG',
    job_name    => 'MYAPP.JOB_WEEKLY_PURGE'
  );
END;
/
\`\`\`

---

## 10. RAC Considerations

In a RAC environment, a scheduler job runs on whichever node CJQ0 is running on when the job fires. This is usually not what you want for maintenance jobs that need to access local resources or that you want to distribute across nodes.

### Service-based job placement

The recommended approach is to create a database service that runs on specific preferred nodes, and then assign jobs to a job class that specifies that service:

\`\`\`sql
-- Create a job class that ties to the MAINTENANCE service
-- (The MAINTENANCE service must be created in SRVCTL and started on the desired nodes)
BEGIN
  DBMS_SCHEDULER.CREATE_JOB_CLASS(
    job_class_name          => 'MYAPP_RAC_MAINT_CLASS',
    resource_consumer_group => 'BATCH_GROUP',
    service                 => 'MAINTENANCE',  -- DB service name
    logging_level           => DBMS_SCHEDULER.LOGGING_RUNS,
    log_history             => 30,
    comments                => 'Jobs run on nodes offering the MAINTENANCE service'
  );
END;
/
\`\`\`

When the job fires, the CJQ0 coordinator dispatches the job slave process on the instance currently offering the \`MAINTENANCE\` service. If that instance fails, Oracle restarts the service on another node, and subsequent job fires will run there automatically. This is more resilient than hard-coding an instance number.

### Instance stickiness

By default, a job that starts running on node 1 stays on node 1 for that run. If node 1 fails during the run, the job is marked as FAILED (not automatically restarted on another node). If \`restartable => TRUE\` is set on the job, the scheduler retries the job when it next fires (but does not immediately resume the failed run).

\`\`\`sql
-- Check which instance a running job is on
SELECT job_name, running_instance, session_id, elapsed_time
FROM dba_scheduler_running_jobs
ORDER BY job_name;
\`\`\`

---

## 11. External Jobs (EXECUTABLE Type)

External jobs run OS commands or scripts. They require more infrastructure than PL/SQL jobs and carry a higher security surface.

### The extjob/jssu helper process

When an EXECUTABLE job fires, Oracle does not directly exec() the OS command from the J000 slave. Instead, it communicates with a helper binary:

- **extjob** (pre-12c): a setuid binary owned by root that launches OS processes under a configured user
- **jssu** (12c+): the "Job Scheduler Slave User" binary, used when the Oracle Scheduler Agent is not in use

Both mechanisms exist to allow OS process launch without running the Oracle server as root.

### Creating and using an EXECUTABLE job

\`\`\`sql
-- 1. Create the OS credential
BEGIN
  DBMS_SCHEDULER.CREATE_CREDENTIAL(
    credential_name => 'SYS.CRED_DBA_OS',
    username        => 'oracle',
    password        => 'os_password_here'
  );
END;
/

-- 2. Create the job with EXECUTABLE type and credential
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'SYS.JOB_ARCHIVE_LOGS',
    job_type        => 'EXECUTABLE',
    job_action      => '/u01/scripts/archive_archivelogs.sh',
    number_of_arguments => 1,
    credential_name => 'SYS.CRED_DBA_OS',
    start_date      => SYSTIMESTAMP,
    repeat_interval => 'FREQ=HOURLY;INTERVAL=4',
    enabled         => FALSE,
    auto_drop       => FALSE
  );

  DBMS_SCHEDULER.SET_JOB_ARGUMENT_VALUE(
    job_name          => 'SYS.JOB_ARCHIVE_LOGS',
    argument_position => 1,
    argument_value    => '/u02/archivelog_backup'
  );

  DBMS_SCHEDULER.ENABLE('SYS.JOB_ARCHIVE_LOGS');
END;
/
\`\`\`

### Remote execution with destinations

For running scripts on remote hosts, register destination objects:

\`\`\`sql
-- Create a remote host destination
BEGIN
  DBMS_SCHEDULER.CREATE_DATABASE_DESTINATION(
    destination_name => 'SYS.DEST_STANDBY_HOST',
    agent            => 'AGENT_STANDBY@standby.example.com:1500',
    comments         => 'Oracle Scheduler Agent on the standby host'
  );
END;
/

-- Create a job that runs on the remote host
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'SYS.JOB_REMOTE_BACKUP',
    job_type        => 'EXECUTABLE',
    job_action      => '/u01/scripts/rman_backup.sh',
    credential_name => 'SYS.CRED_DBA_OS',
    destination_name => 'SYS.DEST_STANDBY_HOST',
    enabled         => TRUE
  );
END;
/
\`\`\`

---

## 12. Common Problems and Diagnostics

### Problem: Job is not running at all

Check these conditions in order:

\`\`\`sql
-- 1. Is the job enabled?
SELECT job_name, enabled, state, next_run_date, last_start_date
FROM dba_scheduler_jobs
WHERE job_name = 'JOB_NIGHTLY_STATS';
-- STATE should be 'SCHEDULED'; ENABLED should be TRUE
-- If STATE = 'DISABLED', the job has been manually disabled or max_failures was hit

-- 2. Is CJQ0 running and is JOB_QUEUE_PROCESSES > 0?
SELECT name, status FROM v\$bgprocess WHERE name = 'CJQ0';
SHOW PARAMETER job_queue_processes;
-- job_queue_processes=0 disables ALL jobs

-- 3. Is the job's Window closed?
-- (Window-based jobs only fire when the Window is open)
SELECT window_name, active, enabled, next_start_date
FROM dba_scheduler_windows
ORDER BY window_name;

-- 4. Is the resource plan blocking the job class consumer group?
SELECT plan, comments FROM dba_rsrc_plans WHERE status = 'ACTIVE';
-- Check if BATCH_GROUP is present in the active plan
SELECT plan, group_or_subplan, cpu_p1, active_sess_pool_p1
FROM dba_rsrc_plan_directives
WHERE plan = (SELECT plan FROM v\$rsrc_plan WHERE is_top_plan = 'TRUE');
\`\`\`

### Problem: Job runs but produces no output or results

\`\`\`sql
-- Read ADDITIONAL_INFO from the most recent run
SELECT log_date, status, error#, run_duration,
       ADDITIONAL_INFO
FROM dba_scheduler_job_run_details
WHERE owner = 'MYAPP'
  AND job_name = 'JOB_NIGHTLY_STATS'
ORDER BY log_date DESC
FETCH FIRST 5 ROWS ONLY;
-- ADDITIONAL_INFO contains the full ORA- error text for failed runs
-- For PLSQL_BLOCK jobs, errors in the block body appear here, not in DBMS_OUTPUT
\`\`\`

### Problem: Overlapping job runs

\`\`\`sql
-- Is the job still running from a previous fire?
SELECT job_name, running_instance, session_id, elapsed_time,
       cpu_used, slave_process_id
FROM dba_scheduler_running_jobs
WHERE job_name = 'JOB_NIGHTLY_STATS';

-- How many times has the job started vs completed?
SELECT run_count, failure_count, retry_count,
       last_start_date, last_run_duration, next_run_date
FROM dba_scheduler_jobs
WHERE job_name = 'JOB_NIGHTLY_STATS';
-- If run_count keeps incrementing but last_run_duration is growing, the job is slow
-- If the job takes longer than its repeat_interval, runs will overlap
\`\`\`

To prevent overlap, set \`MAX_RUN_DURATION\` to stop long-running jobs before the next fire:

\`\`\`sql
BEGIN
  DBMS_SCHEDULER.SET_ATTRIBUTE(
    name      => 'MYAPP.JOB_NIGHTLY_STATS',
    attribute => 'MAX_RUN_DURATION',
    value     => INTERVAL '4' HOUR
  );
END;
/
\`\`\`

### Problem: Job stuck in RUNNING state

This happens when the J000 slave process dies unexpectedly (OOM kill, signal, database crash followed by incomplete cleanup).

\`\`\`sql
-- Find the stuck job and its session
SELECT rj.job_name, rj.session_id, rj.slave_process_id,
       rj.elapsed_time, s.status, s.event
FROM dba_scheduler_running_jobs rj
JOIN v\$session s ON rj.session_id = s.sid
WHERE rj.job_name = 'JOB_NIGHTLY_STATS';

-- Force-stop the job
BEGIN
  DBMS_SCHEDULER.STOP_JOB(
    job_name => 'MYAPP.JOB_NIGHTLY_STATS',
    force    => TRUE   -- TRUE kills the slave process; FALSE requests graceful stop
  );
END;
/

-- If the session is still visible in v$session after STOP_JOB, kill it directly
ALTER SYSTEM KILL SESSION '145,2937' IMMEDIATE;
\`\`\`

### Problem: AutoTask consuming unexpected resources

\`\`\`sql
-- Find auto optimizer stats collection sessions
SELECT j.job_name, j.running_instance, j.elapsed_time,
       s.username, s.program, s.event
FROM dba_scheduler_running_jobs j
JOIN v\$session s ON j.session_id = s.sid
WHERE j.job_name LIKE '%OPT_STS%' OR j.job_name LIKE '%STATS%';

-- Check AutoTask history for the last 7 days
SELECT client_name, window_name, jobs_created, jobs_started,
       jobs_completed, window_start_time, window_end_time
FROM dba_autotask_client_history
WHERE window_start_time > SYSDATE - 7
ORDER BY window_start_time DESC;

-- Disable auto optimizer stats collection if you manage stats with a custom job
BEGIN
  DBMS_AUTO_TASK_ADMIN.DISABLE(
    client_name => 'auto optimizer stats collection',
    operation   => NULL,
    window_name => NULL
  );
END;
/
\`\`\`

### Problem: Chain not progressing

\`\`\`sql
-- Check step states for a running chain job
SELECT job_name, chain_name, step_name, state, error_code,
       start_date, end_date
FROM dba_scheduler_running_chains
WHERE job_name = 'MYAPP.JOB_ETL_DAILY'
ORDER BY start_date;

-- Check chain rules to understand why a step is not starting
SELECT chain_name, rule_name, condition, action, enabled
FROM dba_scheduler_chain_rules
WHERE chain_name = 'MYAPP.CHAIN_ETL_DAILY'
ORDER BY rule_name;
-- Compare condition expressions against actual step states above
-- A common error: rule condition uses step name that doesn't match exactly
\`\`\`

### Problem: DBA_SCHEDULER_JOB_LOG growing large

\`\`\`sql
-- Check log table size
SELECT owner, segment_name, bytes/1024/1024 AS size_mb
FROM dba_segments
WHERE segment_name IN ('SCHEDULER_JOB_LOG', 'SCHED\$_LOG')
  AND owner = 'SYS'
ORDER BY bytes DESC;

-- How many rows in the log?
SELECT COUNT(*) FROM dba_scheduler_job_log;

-- Set log_history on the default job class to limit retention
BEGIN
  DBMS_SCHEDULER.SET_ATTRIBUTE(
    name      => 'DEFAULT_JOB_CLASS',
    attribute => 'LOG_HISTORY',
    value     => 30
  );
END;
/

-- Purge old log entries immediately
BEGIN
  DBMS_SCHEDULER.PURGE_LOG(
    log_history => 30,
    which_log   => 'JOB_AND_WINDOW_LOG'
  );
END;
/
\`\`\`

---

## Summary

DBMS_SCHEDULER is one of Oracle's most capable built-in subsystems. The architecture — kernel coordinator, job slave processes, rich object model, resource plan integration — means that a well-designed scheduling configuration handles everything from simple nightly statistics gathers to complex multi-step ETL chains with failure branching and OS script execution.

The practical rules for maintainable scheduling:
- **Use named Programs and Schedules** for anything you will reuse across more than one job
- **Always test calendaring expressions** with \`EVALUATE_CALENDAR_STRING\` before deploying to production
- **Assign job classes** with sensible \`LOG_HISTORY\` to prevent log bloat
- **Use service-based placement** in RAC rather than instance numbers
- **Set MAX_RUN_DURATION** on any job whose repeat_interval is shorter than its worst-case runtime
- When a job fails, \`ADDITIONAL_INFO\` in \`DBA_SCHEDULER_JOB_RUN_DETAILS\` is always the first diagnostic step`,
};

async function main() {
  console.log('Inserting Oracle DBMS_SCHEDULER concepts post...');
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
