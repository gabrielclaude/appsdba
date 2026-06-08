import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Automated GoldenGate LogMiner Contention Monitoring',
  slug: 'goldengate-logminer-contention-monitoring-runbook',
  excerpt:
    'Production runbook for deploying monitor_gg_contention.sh — a cron-ready shell script that queries gv$session for enq: MN - contention and blocked LogMiner background processes, then fires an HTML-formatted email alert. Covers script deployment, crontab scheduling, alert interpretation, and the DBMS_STATS response procedure.',
  category: 'golden-gate-problems' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-08'),
  youtubeUrl: null,
  content: `## Purpose and Scope

This runbook deploys a cron-based monitoring script that watches an Oracle 19c database for GoldenGate LogMiner enqueue contention in real time. The script queries \`gv\$session\` every five minutes, identifies sessions blocked on \`enq: MN - contention\` or held by LogMiner background processes (MS00–MS99), and sends an HTML-formatted email alert to the DBA team when a problem is detected.

This runbook is a companion to the post [Extract Lags: A Real-World Masterclass in LogMiner Contention](/posts/goldengate-extract-lag-logminer-contention), which covers the root-cause diagnosis and fix. This document covers automated early detection so contention is caught before it builds into hours of Extract lag.

---

## Prerequisites

| Item | Requirement |
|------|-------------|
| OS user | \`oracle\` (or the GoldenGate software owner) |
| Oracle client | SQL*Plus must be in PATH (\`$ORACLE_HOME/bin\`) |
| Mail agent | \`/usr/sbin/sendmail\` installed and configured on the database host |
| Database access | OS authentication (\`/ as sysdba\`) must work without a password prompt |
| GoldenGate | Integrated Extract running on Oracle 19c with OGG 21.x |

Verify OS authentication before scheduling:

\`\`\`bash
sqlplus -s / as sysdba <<EOF
SELECT instance_name, status FROM v\\$instance;
EXIT;
EOF
\`\`\`

Verify \`sendmail\` is functional:

\`\`\`bash
echo "Subject: Test from $(hostname)" | /usr/sbin/sendmail dba_team@yourcompany.com
\`\`\`

---

## Script: monitor_gg_contention.sh

Create the file at \`/home/oracle/scripts/monitor_gg_contention.sh\`. Update the three environment variables at the top before deploying.

\`\`\`bash
#!/bin/bash
# ==============================================================================
# Script Name: monitor_gg_contention.sh
# Purpose:     Monitor Oracle Database for GoldenGate LogMiner Enqueue
#              contention (enq: MN - contention) and send alerts.
# Scheduling:  Designed to be run via Linux Crontab.
# ==============================================================================

# --- Configure Oracle Environment ---
export ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_SID=taxprd
export PATH=$ORACLE_HOME/bin:$PATH

# --- Configure Alert Recipients ---
EMAIL_RECEIVER="dba_team@yourcompany.com"
HOSTNAME=$(hostname)

# --- Define Log / Temporary Output File ---
ALERT_LOG="/tmp/gg_mn_contention_alert.txt"
rm -f \${ALERT_LOG}

# --- Execute SQL*Plus Diagnostic Check ---
sqlplus -s / as sysdba << EOF > /tmp/sql_output.txt
SET LINESIZE 200
SET PAGESIZE 100
SET FEEDBACK OFF
SET HEADING ON
SET TRIMSPOOL ON

COLUMN instance FORMAT 99
COLUMN sid FORMAT 99999
COLUMN serial# FORMAT 999999
COLUMN program FORMAT a30
COLUMN event FORMAT a30
COLUMN wait_class FORMAT a15
COLUMN blocker_sid FORMAT 999999
COLUMN sql_id FORMAT a14

-- Spool out only active blockages involving GoldenGate processes or MN contention
SPOOL \${ALERT_LOG}

SELECT
    inst_id AS instance,
    sid,
    serial#,
    program,
    event,
    wait_class,
    blocking_session AS blocker_sid,
    sql_id
FROM gv\\$session
WHERE (
        -- Capture anyone trapped in LogMiner metadata contention
        event LIKE '%enq: MN%'
        OR wait_class = 'Concurrency'
      )
  AND (
        -- Scope specifically to GoldenGate background architecture
        program LIKE '%(MS%)'
        OR program LIKE '%(OGG%)'
        -- Or any session actively being blocked by a LogMiner process
        OR blocking_session IN (SELECT sid FROM gv\\$session WHERE program LIKE '%(MS%)')
      )
  AND status = 'ACTIVE';

SPOOL OFF
EXIT;
EOF

# --- Evaluate Output and Trigger Notification ---
# Clean out white spaces or empty lines to see if rows were returned
if [ -s \${ALERT_LOG} ] && [ $(grep -c '[^[:space:]]' \${ALERT_LOG}) -gt 1 ]; then

    # Construct a clean email header and message body
    (
      echo "To: \${EMAIL_RECEIVER}"
      echo "Subject: ALERT: GoldenGate LogMiner Contention Detected on \${HOSTNAME} (\${ORACLE_SID})"
      echo "MIME-Version: 1.0"
      echo "Content-Type: text/html; charset=UTF-8"
      echo ""
      echo "<html>"
      echo "<body style='font-family: Arial, sans-serif; color: #333;'>"
      echo "<h2 style='color: #FF0000;'>WARNING: Active GoldenGate / LogMiner Bottleneck Detected</h2>"
      echo "<p>The database layer has flagged active sessions experiencing LogMiner lock delays or <code>enq: MN - contention</code>.</p>"
      echo "<p>Review the active process map captured below immediately:</p>"
      echo "<pre style='background-color: #f4f4f4; padding: 15px; border: 1px solid #ddd; font-family: monospace; overflow-x: auto;'>"
      cat \${ALERT_LOG}
      echo "</pre>"
      echo "<hr style='border: 0; border-top: 1px solid #ccc;' />"
      echo "<p style='font-size: 12px; color: #666;'><em>Action Plan: If bottlenecks persist, gather stats for LOGMN% dictionary tables using DBMS_STATS.</em></p>"
      echo "</body>"
      echo "</html>"
    ) | /usr/sbin/sendmail -t

fi

# Clean up temp files
rm -f /tmp/sql_output.txt \${ALERT_LOG}
\`\`\`

---

## What the Script Monitors

### Session Filter Logic

The script targets the intersection of two conditions, ANDed together:

**Condition 1 — Wait event scope:**
- \`event LIKE '%enq: MN%'\` — explicitly tracks the LogMiner Metadata enqueue. Any session waiting here has found another process holding the MN lock.
- \`wait_class = 'Concurrency'\` — catches related wait events in the same class (buffer busy waits on LogMiner-owned blocks, library cache locks on dictionary objects).

**Condition 2 — Process scope (GoldenGate only):**
- \`program LIKE '%(MS%)'\` — the Oracle-internal LogMiner background processes MS00 through MS99. These are spawned by the GoldenGate capture infrastructure and are the processes that hold and contend for the MN enqueue.
- \`program LIKE '%(OGG%)'\` — the GoldenGate Extract server process itself, which communicates with the LogMiner inbound server.
- \`blocking_session IN (...)\` — catches any session (including application sessions) that is being blocked by a MS-series process. This surfaces the downstream impact on user workloads.

### Why Both Conditions Are Required

The concurrency filter alone would fire on any database contention, flooding the DBA inbox. The program filter alone would alert on MS-series processes that are simply waiting on normal I/O (not contention). The AND intersection catches exactly the failure mode that causes Extract lag: a GoldenGate-related process stuck on an enqueue or concurrency wait.

---

## Deployment Steps

### Step 1 — Create the scripts directory

\`\`\`bash
mkdir -p /home/oracle/scripts
\`\`\`

### Step 2 — Write the script file

Copy the script above into \`/home/oracle/scripts/monitor_gg_contention.sh\` and update the three variables:

| Variable | Description | Example |
|----------|-------------|---------|
| \`ORACLE_HOME\` | Full path to the Oracle Database home | \`/u01/app/oracle/product/19.0.0/dbhome_1\` |
| \`ORACLE_SID\` | SID of the database hosting GoldenGate | \`PRODDB\` |
| \`EMAIL_RECEIVER\` | Recipient address for alert emails | \`dba-oncall@yourcompany.com\` |

For RAC environments, set \`ORACLE_SID\` to the local instance SID (e.g., \`PRODDB1\`). The script uses \`gv\$session\` so it queries all instances.

### Step 3 — Make it executable

\`\`\`bash
chmod +x /home/oracle/scripts/monitor_gg_contention.sh
\`\`\`

### Step 4 — Run once manually to verify

\`\`\`bash
/home/oracle/scripts/monitor_gg_contention.sh
echo "Exit code: $?"
\`\`\`

The exit code will always be 0 (the script does not use non-zero exits for alerting — alerts go to email). If no contention exists, the script exits silently. If contention is present, an email is sent.

To force a test email regardless of database state, temporarily replace the \`if [ -s ... ]\` condition with \`if true\`:

\`\`\`bash
# Temporary test — revert after confirming email delivery
sed -i 's/if \[ -s.*/if true; then  # TEST ONLY/' /home/oracle/scripts/monitor_gg_contention.sh
/home/oracle/scripts/monitor_gg_contention.sh
# Restore after test
\`\`\`

---

## Crontab Scheduling

Log in as the \`oracle\` OS user and open the crontab editor:

\`\`\`bash
crontab -e
\`\`\`

Add one of the following entries depending on the monitoring frequency required:

\`\`\`cron
# Check every 5 minutes — recommended for active GoldenGate replication environments
*/5 * * * * /home/oracle/scripts/monitor_gg_contention.sh > /dev/null 2>&1

# Check every 10 minutes — lower frequency for pre-production or batch-only environments
*/10 * * * * /home/oracle/scripts/monitor_gg_contention.sh > /dev/null 2>&1

# Check every minute — use only during an active incident for live tracking
* * * * * /home/oracle/scripts/monitor_gg_contention.sh > /dev/null 2>&1
\`\`\`

For critical production GoldenGate environments, **every 5 minutes** provides a reasonable balance between early detection and system overhead. At a 5-minute polling interval, the worst case is a 5-minute delay between contention onset and alert delivery — typically well before Extract lag reaches double-digit hours.

Verify the crontab entry was saved:

\`\`\`bash
crontab -l | grep monitor_gg
\`\`\`

---

## Alert Email Interpretation

When the alert fires, the HTML email body contains a formatted table from \`gv\$session\` with the following columns:

| Column | What to Look For |
|--------|-----------------|
| \`INSTANCE\` | In RAC, identifies which node the blocked session is on |
| \`SID\` / \`SERIAL#\` | Use with \`blocking_session\` to trace the full blocker-waiter chain |
| \`PROGRAM\` | \`(MS00)\`, \`(MS06)\` etc. — the specific LogMiner background process |
| \`EVENT\` | \`enq: MN - contention\` confirms the MN enqueue is held |
| \`WAIT_CLASS\` | \`Concurrency\` is the expected class for this event |
| \`BLOCKER_SID\` | The SID holding the resource that this session is waiting for |
| \`SQL_ID\` | If populated, use to pull the current SQL via \`v\$sql\` |

### Alert Severity Assessment

**Single row, BLOCKER_SID populated:**
A waiter exists but a blocker is active. Check how long the blocker has been running:

\`\`\`sql
SELECT sid, seconds_in_wait, event, sql_id
FROM gv\$session
WHERE sid = <blocker_sid>;
\`\`\`

If \`seconds_in_wait\` is under 60, this may be transient. Watch the next polling cycle.

**Multiple rows, same BLOCKER_SID:**
A single MS-series process is blocking multiple waiters. This is the pattern from the case study — a LogMiner process performing a large scattered read while holding the MN enqueue. Check the Extract lag immediately:

\`\`\`sql
SELECT capture_name, status,
       (SYSDATE - SCN_TO_TIMESTAMP(required_checkpoint_scn)) * 24 AS lag_hours
FROM dba_capture;
\`\`\`

If \`lag_hours\` is increasing, escalate to the Response Procedure below.

**Rows present across multiple alert cycles (15+ minutes):**
The contention is not self-resolving. Execute the DBMS_STATS fix immediately.

---

## Response Procedure

### Phase 1 — Confirm Active Contention

Run the diagnostic query manually to get the full session picture:

\`\`\`sql
SELECT
    s.inst_id,
    s.sid,
    s.serial#,
    s.status,
    s.program,
    s.event,
    s.seconds_in_wait,
    s.blocking_session,
    s.blocking_session_serial#,
    s.sql_id
FROM gv\$session s
WHERE s.program LIKE '%OGG%'
   OR s.program LIKE '%(MS%)'
   OR s.event    LIKE '%MN%'
ORDER BY s.seconds_in_wait DESC;
\`\`\`

### Phase 2 — Check LOGMN% Statistics Staleness

\`\`\`sql
SELECT owner, table_name, num_rows, last_analyzed, stale_stats
FROM   dba_tab_statistics
WHERE  table_name LIKE 'LOGMN%'
AND    owner IN ('SYS','SYSTEM')
ORDER BY last_analyzed NULLS FIRST;
\`\`\`

Tables showing \`STALE_STATS = YES\` or a \`LAST_ANALYZED\` date more than a week old are the root cause.

### Phase 3 — Apply the Targeted Fix

Execute during business hours if the Extract lag is not yet critical. This is safe to run on a live production database:

\`\`\`sql
BEGIN
    FOR c_tab IN (
        SELECT owner, table_name
        FROM dba_tables
        WHERE table_name LIKE 'LOGMN%'
          AND owner IN ('SYS','SYSTEM')
    ) LOOP
        DBMS_STATS.GATHER_TABLE_STATS(
            ownname          => c_tab.owner,
            tabname          => c_tab.table_name,
            estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,
            method_opt       => 'FOR ALL COLUMNS SIZE AUTO',
            degree           => 4,
            no_invalidate    => FALSE
        );
    END LOOP;
END;
/
\`\`\`

\`no_invalidate => FALSE\` forces immediate cursor invalidation. Cursors using the stale plans are invalidated as each table completes, so improvement is visible in \`gv\$session\` before the loop finishes.

### Phase 4 — Confirm Resolution

Poll \`gv\$session\` until the MN contention rows disappear and the Extract lag stabilizes:

\`\`\`sql
-- Should return zero rows once stats are gathered
SELECT COUNT(*) AS blocking_sessions
FROM gv\$session
WHERE event LIKE '%enq: MN%'
AND   status = 'ACTIVE';

-- Lag should stop increasing and begin dropping
SELECT capture_name, status,
       (SYSDATE - SCN_TO_TIMESTAMP(required_checkpoint_scn)) * 24 AS lag_hours
FROM dba_capture;
\`\`\`

### Phase 5 — Schedule Full Dictionary Stats (Maintenance Window)

After the immediate fix, schedule a full dictionary stats gather in the next maintenance window:

\`\`\`sql
EXEC DBMS_STATS.GATHER_DICTIONARY_STATS;
\`\`\`

This prevents recurrence by refreshing statistics on all system schema objects, not just the \`LOGMN%\` tables.

---

## Preventing Recurrence

Add a weekly dictionary stats job to DBMS_SCHEDULER so the automatic stats collection window no longer has sole responsibility for these tables:

\`\`\`sql
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'WEEKLY_LOGMN_STATS',
    job_type        => 'PLSQL_BLOCK',
    job_action      => 'BEGIN
                          FOR c_tab IN (
                            SELECT owner, table_name
                            FROM dba_tables
                            WHERE table_name LIKE ''LOGMN%''
                              AND owner IN (''SYS'',''SYSTEM'')
                          ) LOOP
                            DBMS_STATS.GATHER_TABLE_STATS(
                              ownname          => c_tab.owner,
                              tabname          => c_tab.table_name,
                              estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,
                              method_opt       => ''FOR ALL COLUMNS SIZE AUTO'',
                              degree           => 4,
                              no_invalidate    => FALSE
                            );
                          END LOOP;
                        END;',
    start_date      => TRUNC(SYSDATE) + 1 + 2/24,   -- Tomorrow at 02:00
    repeat_interval => 'FREQ=WEEKLY;BYDAY=SUN;BYHOUR=2;BYMINUTE=0',
    enabled         => TRUE,
    comments        => 'Weekly stats refresh for LOGMN% tables - prevents enq: MN contention'
  );
END;
/
\`\`\`

Verify the job was created:

\`\`\`sql
SELECT job_name, enabled, state, last_start_date, next_run_date
FROM dba_scheduler_jobs
WHERE job_name = 'WEEKLY_LOGMN_STATS';
\`\`\`

---

## Script Maintenance

| Task | Command |
|------|---------|
| View current crontab | \`crontab -l\` |
| Disable temporarily (comment out) | \`crontab -e\` — prefix line with \`#\` |
| Check last script execution | \`ls -la /tmp/gg_mn_contention_alert.txt\` (file is deleted on clean run; its presence indicates an error in the cleanup block) |
| Test SQL*Plus connectivity | \`sqlplus -s / as sysdba <<<'SELECT 1 FROM dual;'\` |
| Rotate/archive alert logs | Script uses \`/tmp\` — no rotation needed; files are removed after each run |

---

## Summary

| Component | Value |
|-----------|-------|
| Script location | \`/home/oracle/scripts/monitor_gg_contention.sh\` |
| Cron schedule | \`*/5 * * * *\` (every 5 minutes) |
| Alert trigger | Any active \`enq: MN - contention\` session on an MS-series or OGG program |
| Alert delivery | HTML email via \`/usr/sbin/sendmail\` |
| Root cause fix | \`DBMS_STATS.GATHER_TABLE_STATS\` on all \`LOGMN%\` tables with \`no_invalidate => FALSE\` |
| Long-term prevention | \`DBMS_SCHEDULER\` weekly job for \`DBMS_STATS.GATHER_DICTIONARY_STATS\` |`,
};

async function main() {
  console.log('Inserting GoldenGate LogMiner contention monitoring runbook...');
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
