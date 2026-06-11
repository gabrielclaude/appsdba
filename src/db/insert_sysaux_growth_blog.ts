import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS SYSAUX Tablespace Growth: Identification, Management, and Prevention',
  slug: 'oracle-ebs-sysaux-tablespace-growth-management',
  excerpt:
    'A complete guide to managing SYSAUX tablespace growth in Oracle EBS environments: identifying the top occupants (AWR, ASH, Optimizer Statistics, SQL Tuning Base), understanding what drives abnormal growth on EBS workloads, and applying the right retention, purge, and sizing strategies to keep SYSAUX under control without compromising performance diagnostics.',
  category: 'appsdba' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `SYSAUX is Oracle's auxiliary system tablespace — introduced in Oracle 10g to offload the growing number of database components that previously crowded SYSTEM. In an Oracle EBS environment, SYSAUX deserves close attention because EBS workloads are characteristically heavy: hundreds of concurrent sessions, long-running batch jobs, complex SQL plans, and non-stop AWR snapshot activity. Left unmanaged, SYSAUX fills up silently until critical database components start failing — AWR snapshots stop writing, optimizer statistics history is truncated, and monitoring tools lose visibility at exactly the moment you need them most.

This post explains what lives in SYSAUX, why EBS workloads cause it to grow faster than other Oracle deployments, and how to manage retention and purge policies for each major occupant.

---

## What Lives in SYSAUX

SYSAUX is a mandatory tablespace managed exclusively by Oracle — no user objects should ever be placed there. Its contents are partitioned into logical occupants, each managed by a separate Oracle component:

| Occupant | Schema/Component | Typical % of SYSAUX in EBS |
|----------|-----------------|---------------------------|
| **AWR** (Workload Repository) | \`SYS\` / \`DBSNMP\` | 40–60% |
| **ASH** (Active Session History) | Embedded in AWR | Included above |
| **Optimizer Statistics History** | \`SYS\` | 10–20% |
| **SQL Tuning Advisor / SQL Profiles** | \`SYS\` | 5–15% |
| **SQL Management Base (SPM)** | \`SYS\` | 5–10% |
| **Segment Advisor** | \`SYS\` | 1–5% |
| **XML DB** | \`XDB\` | 1–3% |
| **Streams / Advanced Queuing** | \`SYS\` | 1–5% (higher if Golden Gate in use) |
| **EM Express / DBMS_PERF** | \`SYSMAN\` | 1–5% |

In a well-tuned EBS environment, AWR alone typically accounts for more than half of SYSAUX — and it is the component most likely to grow uncontrolled.

---

## Why EBS Workloads Drive Abnormal SYSAUX Growth

### 1. AWR Snapshot Volume

AWR takes a snapshot every 60 minutes by default and retains them for 8 days (10,080 minutes). In an EBS environment with 200+ concurrent users, each snapshot captures thousands of SQL statistics rows. The \`WRH\$_SQLSTAT\` table — the largest single AWR table — accumulates one row per SQL ID per snapshot. An EBS instance running ASCP, Payroll, and Order Management simultaneously can generate 50,000+ distinct SQL IDs over a week.

At 8 days of retention with hourly snapshots, that is 192 snapshots × 50,000 SQL IDs = ~9.6 million rows in \`WRH\$_SQLSTAT\` alone, before counting bind captures, plan tables, and ASH data.

### 2. Active Session History (ASH) Volume

ASH samples every active session every second and retains samples in \`V\$ACTIVE_SESSION_HISTORY\` (in memory) and flushes them to \`WRH\$_ACTIVE_SESSION_HISTORY\` (in SYSAUX) every 10 minutes. During EBS peak periods — period close, payroll runs, ASCP plan launches — with 100+ active sessions, ASH generates:

\`\`\`
100 sessions × 60 samples/minute × 60 minutes × 8 days = 2.88 billion potential samples
\`\`\`

Oracle's AWR flush keeps only 1-in-10 ASH samples in the persistent store, but even at that rate the volume is substantial.

### 3. Optimizer Statistics History

Every time \`DBMS_STATS\` collects statistics on a table, Oracle saves the previous generation of statistics in \`SYS.WRI\$_OPTSTAT_*\` tables in SYSAUX. EBS runs the FND Gather Schema Statistics concurrent program (or equivalent) nightly, collecting stats on thousands of tables. The default retention for old statistics is **31 days** — meaning SYSAUX holds 31 generations of statistics for every EBS table.

### 4. SQL Tuning Base and SQL Plan Management

SQL Plan Management (SPM) saves plan baselines in \`SYS.SQLOBJ\$\` and related tables in SYSAUX. In EBS environments where Automatic SQL Tuning is enabled, Oracle can silently capture thousands of SQL plan baselines without the DBA's awareness. Each baseline stores full plan information, which accumulates persistently until explicitly purged.

### 5. SQL Tuning Advisor (STA) Findings

The Automatic SQL Tuning Advisor runs by default during the maintenance window and stores its findings and SQL profiles in SYSAUX. These accumulate indefinitely unless explicitly purged.

---

## Identifying What Is Consuming SYSAUX

The starting point for any SYSAUX investigation is the \`V\$SYSAUX_OCCUPANTS\` view, which shows the current space allocation per component:

\`\`\`sql
-- Current SYSAUX occupants sorted by space used
SELECT occupant_name,
       schema_name,
       move_procedure,
       ROUND(space_usage_kbytes / 1048576, 2) AS space_used_gb
FROM   v\$sysaux_occupants
ORDER BY space_usage_kbytes DESC;
\`\`\`

For AWR specifically, break down by individual table:

\`\`\`sql
-- Top AWR tables by size in SYSAUX
SELECT segment_name,
       ROUND(SUM(bytes) / 1048576, 0) AS size_mb
FROM   dba_segments
WHERE  tablespace_name = 'SYSAUX'
  AND  segment_name LIKE 'WR%'
GROUP BY segment_name
ORDER BY size_mb DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

For optimizer statistics history:

\`\`\`sql
-- Optimizer statistics history tables
SELECT segment_name,
       ROUND(SUM(bytes) / 1048576, 0) AS size_mb
FROM   dba_segments
WHERE  tablespace_name = 'SYSAUX'
  AND  segment_name LIKE 'WRI\$_OPTSTAT%' ESCAPE '\\'
GROUP BY segment_name
ORDER BY size_mb DESC;
\`\`\`

For SQL Management Base:

\`\`\`sql
-- SQL Plan Management objects
SELECT segment_name,
       ROUND(SUM(bytes) / 1048576, 0) AS size_mb
FROM   dba_segments
WHERE  tablespace_name = 'SYSAUX'
  AND  segment_name IN ('SQLOBJ\$','SQLOBJ\$AUXDATA','SQLOBJ\$DATA','SQL\$',
                        'SQL\$TEXT','SQLOBJ\$PLAN')
GROUP BY segment_name
ORDER BY size_mb DESC;
\`\`\`

---

## Managing AWR Retention and Snapshots

AWR retention is the single most impactful lever for SYSAUX size in EBS environments.

### Check current AWR settings

\`\`\`sql
SELECT snap_interval,
       retention,
       topnsql
FROM   dba_hist_wr_control;
-- SNAP_INTERVAL: +00000 01:00:00.0  (hourly)
-- RETENTION: +00008 00:00:00.0      (8 days default)
\`\`\`

### Reduce retention to match your needs

For most EBS environments, AWR data older than 14–30 days has limited operational value for real-time troubleshooting. If you have a separate AWR data warehouse (covered in a previous post), you can safely reduce in-database retention:

\`\`\`sql
-- Reduce AWR retention to 14 days (in minutes: 14 * 24 * 60 = 20160)
BEGIN
  DBMS_WORKLOAD_REPOSITORY.MODIFY_SNAPSHOT_SETTINGS(
    retention => 20160,    -- 14 days in minutes
    interval  => 60        -- Keep 60-minute intervals
  );
END;
/
\`\`\`

**Important:** Reducing retention does not immediately reclaim space. AWR uses a background purge process (\`MMON\`) that runs periodically. Space reclamation happens over hours to days after the retention change.

### Manually purge old AWR snapshots

To reclaim space immediately rather than waiting for background purge:

\`\`\`sql
-- Find the oldest and newest snapshot IDs
SELECT MIN(snap_id) AS oldest_snap,
       MAX(snap_id) AS newest_snap,
       MIN(begin_interval_time) AS oldest_date,
       MAX(end_interval_time)   AS newest_date
FROM   dba_hist_snapshot;

-- Delete snapshots older than 14 days manually
DECLARE
  v_low_snap  NUMBER;
  v_high_snap NUMBER;
BEGIN
  SELECT MIN(snap_id), MAX(snap_id)
  INTO   v_low_snap, v_high_snap
  FROM   dba_hist_snapshot
  WHERE  end_interval_time < SYSDATE - 14;

  IF v_low_snap IS NOT NULL THEN
    DBMS_WORKLOAD_REPOSITORY.DROP_SNAPSHOT_RANGE(
      low_snap_id  => v_low_snap,
      high_snap_id => v_high_snap
    );
    DBMS_OUTPUT.PUT_LINE('Dropped snapshots ' || v_low_snap || ' to ' || v_high_snap);
  END IF;
END;
/
\`\`\`

### Shrink AWR segments after purge

After purging old snapshots, reclaim free space from the underlying AWR table segments:

\`\`\`sql
-- Shrink the largest AWR table (run for each top consumer)
ALTER TABLE sys.wrh\$_sqlstat     ENABLE ROW MOVEMENT;
ALTER TABLE sys.wrh\$_sqlstat     SHRINK SPACE CASCADE;
ALTER TABLE sys.wrh\$_active_session_history ENABLE ROW MOVEMENT;
ALTER TABLE sys.wrh\$_active_session_history SHRINK SPACE CASCADE;
\`\`\`

---

## Managing Optimizer Statistics History

### Check current retention period

\`\`\`sql
SELECT dbms_stats.get_stats_history_retention AS retention_days
FROM   dual;
-- Default: 31 days
\`\`\`

### Reduce retention for EBS environments

In most EBS environments, 14 days of statistics history is sufficient for troubleshooting plan regressions:

\`\`\`sql
-- Reduce optimizer statistics history to 14 days
BEGIN
  DBMS_STATS.ALTER_STATS_HISTORY_RETENTION(14);
END;
/
\`\`\`

### Purge old statistics history immediately

\`\`\`sql
-- Purge statistics history older than 14 days
BEGIN
  DBMS_STATS.PURGE_STATS(SYSDATE - 14);
END;
/
\`\`\`

---

## Managing SQL Plan Management (SPM)

### Check current SPM configuration

\`\`\`sql
SELECT parameter_name, parameter_value
FROM   dba_advisor_parameters
WHERE  task_name = 'SYS_AUTO_SPM_EVOLVE_TASK'
ORDER BY parameter_name;

-- Check current SPM object counts
SELECT obj_type, COUNT(*), ROUND(SUM(obj_last_modified) / 1000) AS approx_kb
FROM   dba_sql_plan_baselines
GROUP BY obj_type;
\`\`\`

### Purge unaccepted and old plan baselines

\`\`\`sql
-- Remove unaccepted baselines older than 30 days
DECLARE
  v_count PLS_INTEGER;
BEGIN
  v_count := DBMS_SPM.DROP_SQL_PLAN_BASELINE(
    sql_handle  => NULL,
    plan_name   => NULL
  );
  DBMS_OUTPUT.PUT_LINE('Dropped ' || v_count || ' plan baseline(s)');
END;
/
\`\`\`

### Reduce automatic capture of plan baselines

If SPM automatic capture is not deliberately required:

\`\`\`sql
-- Disable automatic baseline capture (keeps manual baselines)
ALTER SYSTEM SET optimizer_capture_sql_plan_baselines = FALSE;
\`\`\`

---

## Tablespace Capacity Management

### Check SYSAUX current usage and free space

\`\`\`sql
SELECT df.tablespace_name,
       ROUND(df.total_mb)           AS total_mb,
       ROUND(df.total_mb - fs.free_mb) AS used_mb,
       ROUND(fs.free_mb)            AS free_mb,
       ROUND((df.total_mb - fs.free_mb) / df.total_mb * 100, 1) AS pct_used
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
WHERE df.tablespace_name = 'SYSAUX';
\`\`\`

### Add a datafile when SYSAUX reaches 85%

\`\`\`sql
-- Add a new autoextend datafile to SYSAUX
ALTER TABLESPACE sysaux
  ADD DATAFILE '/u01/oradata/EBSPRD/sysaux02.dbf'
  SIZE 4G
  AUTOEXTEND ON
  NEXT 512M
  MAXSIZE 16G;
\`\`\`

---

## Summary and Best Practices

### SYSAUX Growth Levers Ranked by Impact

| Component | Default Retention | Recommended for EBS | Space Saved |
|-----------|-----------------|---------------------|-------------|
| AWR | 8 days | 14–30 days + extract to DW | High |
| Optimizer Stats History | 31 days | 14 days | Medium |
| SQL Tuning Advisor Findings | Indefinite | Purge monthly | Medium |
| SQL Plan Management | Indefinite | Disable auto-capture if not needed | Medium |
| ASH (embedded in AWR) | With AWR | Follows AWR retention | High |

### Best Practices

1. **Check \`V\$SYSAUX_OCCUPANTS\` monthly.** A 5-minute query produces the complete picture of what is consuming SYSAUX and gives early warning before it becomes a crisis.

2. **Set AWR retention to match your operational needs, not the default.** The 8-day default was designed for environments without a separate performance repository. Most EBS shops with nightly AWR reports need at most 14–30 days in-database.

3. **Pair AWR retention reduction with an external AWR data warehouse** if historical SQL performance analysis is required. Reduce in-database retention to 14 days; extract to PostgreSQL for multi-month trending (see the AWR Data Warehouse post in this series).

4. **Reduce optimizer statistics history retention to 14 days.** The 31-day default is rarely needed for EBS environments that run nightly statistics collection — if you need to restore old statistics, it is almost always within the last week.

5. **Disable automatic SPM baseline capture unless you are deliberately managing plan stability.** Automatic capture silently accumulates thousands of baselines in SYSAUX over months. Explicit baseline management is safer and far more space-efficient.

6. **Never resize SYSAUX as the first response to growth.** Adding a datafile is the right emergency response to an immediate space crisis, but it does not address the cause. Always identify the top occupant and reduce its retention first.

The companion runbook covers the complete space management procedure, occupant-by-occupant purge commands, the SYSAUX growth monitoring script, and the alert thresholds appropriate for EBS production environments.`,
};

async function main() {
  console.log('Inserting SYSAUX growth management blog post...');
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
