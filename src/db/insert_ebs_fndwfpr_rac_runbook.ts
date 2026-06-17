import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'EBS FNDWFPR RAC Instance Pinning Runbook: DBMS_SCHEDULER Service Configuration and Parallel Worker Control',
  slug: 'ebs-fndwfpr-rac-instance-pinning-runbook',
  excerpt:
    'Step-by-step runbook for diagnosing and resolving FNDWFPR-driven RAC interconnect saturation caused by DBMS_PARALLEL_EXECUTE worker jobs spreading across instances. Covers AWR/ASH diagnosis, srvctl service creation, DBMS_SCHEDULER job class configuration, EBS profile option setting, verification queries, WF table sizing, monitoring, and full rollback procedure.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-17'),
  youtubeUrl: null,
  content: `This runbook provides the complete implementation procedure for resolving RAC interconnect saturation caused by FNDWFPR (Oracle EBS Workflow Background Process Purge) distributing its internal DBMS_PARALLEL_EXECUTE worker jobs across multiple RAC instances. Work through each phase in order. All SQL runs as SYSDBA unless otherwise noted.

**Prerequisites:**
- Oracle Grid Infrastructure (srvctl) access on the database tier nodes
- SYSDBA access to the RAC database
- EBS System Administrator access (for profile option changes)
- Confirmed maintenance window for the verification run (FNDWFPR execution)

---

## Phase 1 — Diagnose: Confirm FNDWFPR Is the Interconnect Source

Before making any changes, confirm that FNDWFPR's parallel workers are actually the source of the interconnect saturation. Do not skip this phase — the fix changes RAC Scheduler behavior system-wide for FNDWFPR jobs, and you need the baseline data for post-fix comparison.

### 1.1 — AWR Top RAC Wait Events During the Problem Window

Run this against AWR history for the nights when the problem occurred. Substitute your actual problem window dates.

\`\`\`sql
-- Top RAC Cache Fusion wait events during the FNDWFPR window
SELECT event,
       ROUND(SUM(wait_delta)/1000000, 2) AS total_wait_sec,
       COUNT(*)                           AS ash_samples
FROM   dba_hist_active_sess_history
WHERE  sample_time BETWEEN TO_DATE('2026-01-15 23:00','YYYY-MM-DD HH24:MI')
                       AND TO_DATE('2026-01-16 01:00','YYYY-MM-DD HH24:MI')
  AND  event LIKE 'gc%'
GROUP BY event
ORDER BY total_wait_sec DESC;
\`\`\`

**Expected finding if FNDWFPR is the source:** \`gc buffer busy acquire\`, \`gc current block 2-way\`, and \`gc cr multi block request\` in the top results with hundreds or thousands of total wait-seconds.

### 1.2 — ASH Session Distribution During the Window

Confirm that the sessions generating the gc waits are FNDWFPR parallel workers spread across instances.

\`\`\`sql
-- FNDWFPR and parallel worker sessions by instance during the problem window
SELECT ash.inst_id,
       ash.program,
       ash.module,
       ash.action,
       ash.event,
       COUNT(*) AS samples
FROM   dba_hist_active_sess_history ash
WHERE  ash.sample_time BETWEEN TO_DATE('2026-01-15 23:00','YYYY-MM-DD HH24:MI')
                           AND TO_DATE('2026-01-16 01:00','YYYY-MM-DD HH24:MI')
  AND  (ash.program LIKE '%FNDWFPR%'
     OR ash.module  LIKE '%FNDWFPR%'
     OR ash.action  LIKE '%parallel%'
     OR ash.program LIKE '%PARALLEL_EXECUTE%')
GROUP BY ash.inst_id, ash.program, ash.module, ash.action, ash.event
ORDER BY ash.inst_id, samples DESC;
\`\`\`

**Expected finding:** Rows with \`inst_id = 2\` and \`inst_id = 3\` mixed in with \`inst_id = 1\`, all associated with FNDWFPR-related program or module names. If all rows show \`inst_id = 1\`, the problem is not cross-instance distribution — investigate further before proceeding.

### 1.3 — Live Session Distribution (Run During Active FNDWFPR Execution)

If FNDWFPR runs on a regular schedule, run this query during the window to see the live distribution:

\`\`\`sql
-- Live: FNDWFPR and its parallel workers across all RAC instances
SELECT inst_id,
       program,
       module,
       action,
       status,
       event,
       COUNT(*) AS sessions
FROM   gv\$session
WHERE  (program LIKE '%FNDWFPR%'
     OR module  LIKE '%FNDWFPR%'
     OR action  LIKE '%parallel%'
     OR program LIKE '%PARALLEL_EXECUTE%')
GROUP BY inst_id, program, module, action, status, event
ORDER BY inst_id;
\`\`\`

### 1.4 — Historical DBMS_SCHEDULER Job Run Details

Check the last 7 nights of FNDWFPR-related scheduler job runs to see which instances they used:

\`\`\`sql
-- FNDWFPR parallel worker job history: which instance did each worker run on?
SELECT job_name,
       instance_id,
       TO_CHAR(start_date, 'YYYY-MM-DD HH24:MI:SS') AS start_time,
       run_duration,
       status,
       additional_info
FROM   dba_scheduler_job_run_details
WHERE  (job_name LIKE 'FNDWFPR%' OR job_name LIKE 'PARALLEL_EXECUTE%')
  AND  start_date > SYSDATE - 7
ORDER BY start_date DESC;
\`\`\`

**Expected finding:** \`instance_id\` values of 2 and 3 appearing regularly alongside 1. Save this output — you will compare it after the fix to confirm all workers moved to instance 1.

### 1.5 — Interconnect Statistics Baseline

Capture the interconnect statistic counters at the START of the FNDWFPR window on all instances. Run this at 11:00 PM, immediately before FNDWFPR fires:

\`\`\`sql
-- Capture gc statistic baseline (run at start of window, save output)
SELECT inst_id,
       name,
       value
FROM   gv\$sysstat
WHERE  name IN (
  'gc cr blocks received',
  'gc current blocks received',
  'gc cr blocks served',
  'gc current blocks served',
  'gc cr block receive time',
  'gc current block receive time'
)
ORDER BY inst_id, name;
\`\`\`

Run the same query at 1:00 AM (end of window) and compute the delta. The delta on instances 2 and 3 for \`gc cr blocks received\` and \`gc current blocks received\` represents the cross-instance Cache Fusion traffic driven by the FNDWFPR workers. Record this number — it is your pre-fix baseline.

### 1.6 — Confirm FNDWFPR's EBS Concurrent Manager Pin

Verify which node FNDWFPR itself is pinned to in EBS:

\`\`\`sql
-- Confirm the concurrent request node assignment for FNDWFPR
SELECT r.request_id,
       r.concurrent_program_name,
       r.node_name,
       r.phase_code,
       r.status_code,
       r.actual_start_date
FROM   fnd_concurrent_requests r
WHERE  r.concurrent_program_name = 'FNDWFPR'
ORDER BY r.actual_start_date DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

Confirm that \`node_name\` matches the application tier node connected to instance 1. This confirms FNDWFPR itself is pinned — the problem is the parallel workers it spawns.

---

## Phase 2 — Create a RAC Service Pinned to Instance 1

A RAC service with no failover node acts as a hard instance affinity anchor for DBMS_SCHEDULER. Any job class referencing this service will only execute on the instance where the service is running.

Run these commands at the OS level on one of the Grid Infrastructure nodes (as the \`oracle\` or \`grid\` user with srvctl access).

\`\`\`bash
# Step 1: Add the service restricted to instance 1
# Replace PRODDB with your DB unique name
# Replace PROD1 with your instance 1 name (check: srvctl status database -db PRODDB)
srvctl add service \
  -db PRODDB \
  -service FNDWFPR_SVC \
  -preferred PROD1 \
  -available "" \
  -role PRIMARY

# Step 2: Start the service
srvctl start service -db PRODDB -service FNDWFPR_SVC

# Step 3: Verify the service is running only on instance 1
srvctl status service -db PRODDB -service FNDWFPR_SVC
\`\`\`

Expected output from the status command:
\`\`\`
Service FNDWFPR_SVC is running on instance(s) PROD1
\`\`\`

If you see PROD2 or PROD3 in the output, the service is not correctly restricted. Re-check the \`-preferred\` and \`-available\` parameters.

**Verify at the database level:**

\`\`\`sql
-- Confirm the service appears only on instance 1 in GV\$SERVICES
SELECT inst_id, name, network_name, enabled
FROM   gv\$services
WHERE  name = 'FNDWFPR_SVC'
ORDER BY inst_id;
\`\`\`

Only one row should be returned with \`inst_id = 1\`. If the service appears on multiple instances, the srvctl configuration was not applied correctly — stop, remove, and re-add the service.

---

## Phase 3 — Create the DBMS_SCHEDULER Job Class Using the Service

All SQL in this phase runs as SYSDBA.

\`\`\`sql
-- Drop the class if a previous attempt left a partial definition
BEGIN
  DBMS_SCHEDULER.DROP_JOB_CLASS('FNDWFPR_INST1_CLASS', FORCE => TRUE);
EXCEPTION
  WHEN OTHERS THEN NULL;
END;
/

-- Create the job class bound to the instance-1-only service
BEGIN
  DBMS_SCHEDULER.CREATE_JOB_CLASS(
    job_class_name          => 'FNDWFPR_INST1_CLASS',
    resource_consumer_group => NULL,
    service                 => 'FNDWFPR_SVC',
    logging_level           => DBMS_SCHEDULER.LOGGING_RUNS,
    log_history             => 30,
    comments                => 'Pins FNDWFPR parallel workers to RAC instance 1'
  );
END;
/

-- Enable instance stickiness: once a worker starts on instance 1 it stays there
BEGIN
  DBMS_SCHEDULER.SET_ATTRIBUTE(
    'FNDWFPR_INST1_CLASS',
    'instance_stickiness',
    TRUE
  );
END;
/

-- Grant EXECUTE to the APPS schema so EBS can submit jobs under this class
GRANT EXECUTE ON SYS.FNDWFPR_INST1_CLASS TO APPS;

-- Verify the job class was created correctly
SELECT job_class_name,
       service,
       instance_stickiness,
       logging_level,
       log_history
FROM   dba_scheduler_job_classes
WHERE  job_class_name = 'FNDWFPR_INST1_CLASS';
\`\`\`

Expected output:

| JOB_CLASS_NAME | SERVICE | INSTANCE_STICKINESS | LOGGING_LEVEL | LOG_HISTORY |
|----------------|---------|--------------------:|---------------|------------:|
| FNDWFPR_INST1_CLASS | FNDWFPR_SVC | TRUE | RUNS | 30 |

Verify that the APPS grant was applied:

\`\`\`sql
SELECT grantee, privilege, table_name
FROM   dba_tab_privs
WHERE  grantee     = 'APPS'
  AND  table_name  = 'FNDWFPR_INST1_CLASS';
\`\`\`

Expected: one row with \`PRIVILEGE = EXECUTE\`.

---

## Phase 4 — Configure FNDWFPR to Use the Custom Job Class

There are three ways to wire the job class into FNDWFPR. Attempt Option A first; fall back to Option B or C only if A is not available.

### Option A — EBS Profile Option (Preferred)

First, identify whether your EBS version has a profile option for the FNDWFPR job class:

\`\`\`sql
-- Find FNDWFPR-related profile options
SELECT profile_option_name,
       user_profile_option_name
FROM   fnd_profile_options_vl
WHERE  profile_option_name LIKE '%WFPR%'
    OR profile_option_name LIKE '%PARALLEL%'
    OR user_profile_option_name LIKE '%Workflow%Purge%'
ORDER BY profile_option_name;
\`\`\`

If a profile option controls the job class (look for names containing \`JOB_CLASS\` or \`SCHEDULER\`), set it at site level:

\`\`\`sql
BEGIN
  FND_PROFILE.SAVE(
    x_name       => 'FND_WFPR_JOB_CLASS',   -- use actual profile name from query above
    x_value      => 'FNDWFPR_INST1_CLASS',
    x_level_name => 'SITE'
  );
  COMMIT;
END;
/
\`\`\`

Verify:

\`\`\`sql
SELECT pov.profile_option_value
FROM   fnd_profile_option_values pov
JOIN   fnd_profile_options        po ON po.profile_option_id = pov.profile_option_id
WHERE  po.profile_option_name = 'FND_WFPR_JOB_CLASS'
  AND  pov.level_id           = 10001; -- 10001 = SITE level
\`\`\`

### Option B — Concurrent Program Definition

Some EBS 12.2 configurations expose the job class as a parameter in the concurrent program definition:

\`\`\`sql
-- Check what parameters FNDWFPR accepts
SELECT cp.concurrent_program_name,
       cpt.user_concurrent_program_name,
       cpa.column_seq_num,
       cpa.form_left_prompt,
       cpa.enabled_flag
FROM   fnd_concurrent_programs     cp
JOIN   fnd_concurrent_programs_tl  cpt ON  cpt.concurrent_program_id = cp.concurrent_program_id
                                       AND cpt.language = 'US'
JOIN   fnd_descr_flex_col_usage_vl cpa ON  cpa.descriptive_flexfield_name = cp.srs_type_code
WHERE  cp.concurrent_program_name = 'FNDWFPR'
ORDER BY cpa.column_seq_num;
\`\`\`

If a \`JOB_CLASS\` or \`SCHEDULER_CLASS\` parameter is listed, update it through the EBS Define Concurrent Program form (System Administrator > Concurrent > Program > Define) rather than by direct SQL update.

### Option C — Temporary DEFAULT_JOB_CLASS Modification (Emergency Fallback Only)

Use this option only if Options A and B are not available and you need a fix before the next maintenance window. This approach modifies the DEFAULT_JOB_CLASS service — which affects ALL scheduler jobs in the database during the window, not just FNDWFPR jobs. It must be reversed after each FNDWFPR run.

**Before FNDWFPR fires (capture current DEFAULT_JOB_CLASS service):**

\`\`\`sql
SELECT service
FROM   dba_scheduler_job_classes
WHERE  job_class_name = 'DEFAULT_JOB_CLASS';
\`\`\`

Record the output. If the service is NULL (the default), record that explicitly.

**Set DEFAULT_JOB_CLASS to use the instance 1 service:**

\`\`\`sql
BEGIN
  DBMS_SCHEDULER.SET_ATTRIBUTE('DEFAULT_JOB_CLASS', 'service', 'FNDWFPR_SVC');
END;
/
\`\`\`

**After FNDWFPR completes, reset to the original value (NULL for cluster-wide):**

\`\`\`sql
BEGIN
  DBMS_SCHEDULER.SET_ATTRIBUTE('DEFAULT_JOB_CLASS', 'service', '');
END;
/
\`\`\`

**Risk:** While DEFAULT_JOB_CLASS is pointing to FNDWFPR_SVC, every DBMS_SCHEDULER job that does not specify its own class will run on instance 1 only. If other critical scheduler jobs run during the FNDWFPR window and require cluster-wide distribution, this approach will serialize them onto instance 1 and may cause performance issues. Do not use Option C in production unless you have inventoried all scheduler jobs that run during the 11 PM–1 AM window.

---

## Phase 5 — Alternative: Disable FNDWFPR Parallelism

If service pinning cannot be implemented (for example, Grid Infrastructure access requires a separate change window), disable FNDWFPR parallel execution as an immediate mitigation.

**Via EBS System Administrator UI:**

\`\`\`
Navigate: System Administrator → Profile → System
Search for profile: FNDWFPR (or "Workflow Purge")
Profile option: FNDWFPR: Number of Parallel Workers
Set value: 0
Level: Site
Save
\`\`\`

**Via SQL:**

\`\`\`sql
BEGIN
  FND_PROFILE.SAVE(
    x_name       => 'FND_WFPR_PARALLEL_WORKERS',
    x_value      => '0',
    x_level_name => 'SITE'
  );
  COMMIT;
END;
/
\`\`\`

Verify the setting was applied:

\`\`\`sql
SELECT pov.profile_option_value
FROM   fnd_profile_option_values pov
JOIN   fnd_profile_options        po ON po.profile_option_id = pov.profile_option_id
WHERE  po.profile_option_name = 'FND_WFPR_PARALLEL_WORKERS'
  AND  pov.level_id           = 10001; -- SITE level
\`\`\`

**Trade-off comparison:**

| Configuration | Parallel Workers | Interconnect Load | Purge Runtime | Maintenance Window Risk |
|---------------|:----------------:|:-----------------:|:-------------:|:-----------------------:|
| Default (broken) | 4, distributed | Very High | ~2 hours | Interconnect saturation |
| Sequential (parallel = 0) | 0 | None | 3–6+ hours | Window may be too short for large WF tables |
| Service-pinned (this runbook) | 4, on instance 1 | Near-zero | ~2 hours | None after fix |

For WF table sizes above 5 GB total, the sequential option may extend the purge beyond the acceptable maintenance window. In that case, implement the service pinning approach even if it requires an additional change window for the srvctl step.

---

## Phase 6 — Verification After Change

Run FNDWFPR in the next scheduled maintenance window. After it completes, run all of the following verification queries.

### 6.1 — Confirm All Workers Ran on Instance 1

\`\`\`sql
SELECT job_name,
       instance_id,
       TO_CHAR(start_date, 'YYYY-MM-DD HH24:MI:SS') AS start_time,
       run_duration,
       status,
       additional_info
FROM   dba_scheduler_job_run_details
WHERE  (job_name LIKE 'FNDWFPR%' OR job_name LIKE 'PARALLEL_EXECUTE%')
  AND  start_date > SYSDATE - 1
ORDER BY start_date;
\`\`\`

**Pass criterion:** All rows show \`instance_id = 1\`. Zero rows with \`instance_id = 2\` or \`instance_id = 3\`.

### 6.2 — Compare Interconnect Statistics Delta to Baseline

Run the same GV\$SYSSTAT query from Phase 1.5 at the start and end of the FNDWFPR window. Compute the delta and compare to the pre-fix baseline recorded in Phase 1.5.

\`\`\`sql
SELECT inst_id,
       name,
       value
FROM   gv\$sysstat
WHERE  name IN (
  'gc cr blocks received',
  'gc current blocks received',
  'gc cr blocks served',
  'gc current blocks served',
  'gc cr block receive time',
  'gc current block receive time'
)
ORDER BY inst_id, name;
\`\`\`

**Pass criterion:** Delta for \`gc cr blocks received\` and \`gc current blocks received\` on instances 2 and 3 drops from the pre-fix baseline (typically >100,000 per run) to under 1,000.

### 6.3 — Confirm No gc Waits in Live ASH During the Window

\`\`\`sql
-- Check for any residual gc waits from FNDWFPR sessions (last 1 hour)
SELECT inst_id,
       event,
       COUNT(*) AS samples
FROM   gv\$active_session_history
WHERE  sample_time > SYSDATE - 1/24
  AND  event LIKE 'gc%'
GROUP BY inst_id, event
ORDER BY samples DESC;
\`\`\`

**Pass criterion:** Zero \`gc%\` events for FNDWFPR-related sessions. Any remaining gc events should come from unrelated workloads.

### 6.4 — Verify Job Class Assignment

\`\`\`sql
-- Confirm that FNDWFPR parallel jobs used the custom class
SELECT job_name, job_class, state, last_start_date
FROM   dba_scheduler_jobs
WHERE  job_class = 'FNDWFPR_INST1_CLASS'
ORDER BY last_start_date DESC;
\`\`\`

**Pass criterion:** Rows appear corresponding to the FNDWFPR parallel workers from the most recent run, all with \`job_class = FNDWFPR_INST1_CLASS\`.

---

## Phase 7 — WF Table Sizing and Purge Tuning

Now that the interconnect problem is resolved, right-size the purge schedule to keep WF tables from growing uncontrolled.

### 7.1 — Current WF Table Sizes

\`\`\`sql
SELECT segment_name,
       ROUND(SUM(bytes)/1024/1024/1024, 2) AS size_gb,
       COUNT(*)                             AS extent_count
FROM   dba_segments
WHERE  segment_name IN (
         'WF_ITEMS','WF_ITEM_ACTIVITY_STATUSES','WF_NOTIFICATIONS',
         'WF_NOTIFICATION_ATTRIBUTES','WF_ITEM_ATTRIBUTE_VALUES','WF_DEFERRED'
       )
  AND  owner = 'APPS'
GROUP BY segment_name
ORDER BY size_gb DESC;
\`\`\`

If WF_ITEMS or WF_ITEM_ACTIVITY_STATUSES are above 10 GB, the backlog is significant. Plan for a backfill purge campaign before relying on nightly FNDWFPR runs to stabilize the size.

### 7.2 — WF_ITEMS Backlog Analysis by Item Type

\`\`\`sql
SELECT item_type,
       CASE WHEN end_date IS NULL THEN 'OPEN' ELSE 'CLOSED' END AS item_status,
       COUNT(*)         AS item_count,
       MIN(begin_date)  AS oldest_item
FROM   wf_items
WHERE  end_date < SYSDATE - 90
GROUP BY item_type, CASE WHEN end_date IS NULL THEN 'OPEN' ELSE 'CLOSED' END
ORDER BY item_count DESC;
\`\`\`

This identifies which workflow item types have the most data older than 90 days. Use the results to target FNDWFPR runs by item_type when doing a backfill purge.

### 7.3 — Recommended FNDWFPR Parameters for Large Backlogs

When submitting FNDWFPR via the EBS Concurrent Manager for a backfill purge run:

\`\`\`
Item Type:             (blank = all types, or specify the highest-volume type from 7.2)
Begin Date:            (blank)
End Date:              <SYSDATE - 90>        (purge items older than 90 days)
Persistence Type:      TEMP                  (purge temporary items first)
Core Workflow Only:    N                     (do not restrict to seeded processes)
\`\`\`

For the initial backfill, run FNDWFPR for each high-volume item type separately so you can monitor progress and abort individual runs if they run too long without affecting other item types.

---

## Phase 8 — Scheduling and Monitoring

### 8.1 — Alert Query: Cross-Instance Workers After Each Run

Add this query to your post-maintenance monitoring checklist or wrap it in a shell script that sends an alert if the result is non-zero:

\`\`\`sql
-- Count FNDWFPR workers that ran on a non-1 instance (expect 0 after fix)
SELECT COUNT(*) AS cross_instance_workers
FROM   dba_scheduler_job_run_details
WHERE  (job_name LIKE 'FNDWFPR%' OR job_name LIKE 'PARALLEL_EXECUTE%')
  AND  instance_id != 1
  AND  start_date > SYSDATE - 1;
\`\`\`

If this returns a non-zero value after the fix is applied, it means the job class is not being picked up by one or more workers. Revisit Phase 4 (Option A profile option) and confirm the APPS grant from Phase 3 is still in place.

### 8.2 — Daily Interconnect Load Comparison

Capture this snapshot nightly as part of an after-hours database health report:

\`\`\`sql
SELECT inst_id,
       ROUND(SUM(CASE WHEN name = 'gc cr blocks received'      THEN value ELSE 0 END)/1000, 0) AS gc_cr_rcv_k,
       ROUND(SUM(CASE WHEN name = 'gc current blocks received' THEN value ELSE 0 END)/1000, 0) AS gc_curr_rcv_k
FROM   gv\$sysstat
WHERE  name IN ('gc cr blocks received', 'gc current blocks received')
GROUP BY inst_id
ORDER BY inst_id;
\`\`\`

After the fix, the cumulative values on instances 2 and 3 should grow much more slowly than before. A sudden spike in the nightly delta is an early indicator that FNDWFPR workers are spreading again (for example, if the FNDWFPR_SVC service was accidentally relocated to another instance during a maintenance operation).

### 8.3 — Service Status Check (Add to Daily Health Check)

\`\`\`bash
# Verify FNDWFPR_SVC is still on instance 1 after every RAC cluster maintenance
srvctl status service -db PRODDB -service FNDWFPR_SVC
\`\`\`

Automate this check in your daily RAC health check script and alert if the service is not running or is running on a non-primary instance.

---

## Phase 9 — Rollback Procedure

If the service-based job class causes unexpected issues (for example, if instance 1 becomes overloaded with all FNDWFPR workers plus normal instance 1 workload), roll back in this order:

**Step 1 — Remove the service from the job class (revert to cluster-wide execution):**

\`\`\`sql
-- Option A: remove service attribute, keep job class
BEGIN
  DBMS_SCHEDULER.SET_ATTRIBUTE('FNDWFPR_INST1_CLASS', 'service', '');
END;
/

-- Option B: drop the class entirely
BEGIN
  DBMS_SCHEDULER.DROP_JOB_CLASS('FNDWFPR_INST1_CLASS', FORCE => TRUE);
END;
/
\`\`\`

**Step 2 — Stop and remove the RAC service:**

\`\`\`bash
srvctl stop service -db PRODDB -service FNDWFPR_SVC
srvctl remove service -db PRODDB -service FNDWFPR_SVC
\`\`\`

**Step 3 — Reset the EBS profile options to original values:**

\`\`\`sql
-- Remove job class profile
BEGIN
  FND_PROFILE.SAVE('FND_WFPR_JOB_CLASS', NULL, 'SITE');
  COMMIT;
END;
/

-- If you also changed the parallel workers profile, restore it
BEGIN
  FND_PROFILE.SAVE('FND_WFPR_PARALLEL_WORKERS', '4', 'SITE');  -- or original value
  COMMIT;
END;
/
\`\`\`

After rollback, confirm that FNDWFPR runs successfully in the next window before closing the change.

---

## Validation Matrix

| Check | Method | Pass Criterion |
|-------|--------|----------------|
| RAC service running on instance 1 only | \`srvctl status service -db PRODDB -service FNDWFPR_SVC\` | Active on instance 1 only |
| Service visible in database | \`SELECT inst_id FROM gv\$services WHERE name='FNDWFPR_SVC'\` | Only inst_id=1 returned |
| Job class created with correct service | \`SELECT service FROM dba_scheduler_job_classes WHERE job_class_name='FNDWFPR_INST1_CLASS'\` | FNDWFPR_SVC |
| Instance stickiness enabled | \`SELECT instance_stickiness FROM dba_scheduler_job_classes WHERE job_class_name='FNDWFPR_INST1_CLASS'\` | TRUE |
| APPS has EXECUTE privilege | \`SELECT privilege FROM dba_tab_privs WHERE grantee='APPS' AND table_name='FNDWFPR_INST1_CLASS'\` | EXECUTE |
| EBS profile option set | Profile option query from Phase 4 | FNDWFPR_INST1_CLASS |
| Workers ran on instance 1 only | \`SELECT DISTINCT instance_id FROM dba_scheduler_job_run_details WHERE job_name LIKE 'PARALLEL_EXECUTE%' AND start_date > SYSDATE-1\` | Only 1 |
| Interconnect delta reduced | GV\$SYSSTAT gc cr blocks received delta (instances 2 and 3) during window | Under 1,000 (was over 100,000) |
| No gc waits for FNDWFPR sessions | ASH query from Phase 6.3 | 0 gc% events for FNDWFPR sessions |
| WF table sizes stable | Segment size query from Phase 7.1 run weekly | Not growing week over week |
| Cross-instance worker alert | Phase 8.1 query after each FNDWFPR run | 0 cross-instance workers |

---

## Notes and Edge Cases

**If the FNDWFPR_SVC service fails over:** If instance 1 crashes during an FNDWFPR run and the RAC service was configured with no available (failover) instance, FNDWFPR's parallel workers will fail rather than migrate to another instance. This is the intended behavior — the purge job will need to be resubmitted. If you require failover for the purge itself (rather than just instance affinity), configure the service with a failover instance but accept that interconnect traffic will return during the failover event.

**If FNDWFPR is not using the job class despite configuration:** Confirm the APPS grant is present (Phase 3 verification). Some EBS patch levels create a new APPS schema synonym that loses the privilege grant. If the grant is missing, re-apply it and bounce the Internal Concurrent Manager to pick up the change.

**Oracle Scheduler version behavior:** On Oracle 12c and later, DBMS_PARALLEL_EXECUTE passes the \`job_class\` parameter directly to DBMS_SCHEDULER.CREATE_JOB. On Oracle 11g, the behavior may differ — confirm by checking the PARALLEL_EXECUTE source in DBA_SOURCE or reviewing Oracle Support note for your specific patch level.`,
};

async function main() {
  console.log('Inserting EBS FNDWFPR RAC instance pinning runbook...');
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
