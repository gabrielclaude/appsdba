import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const blogPost = {
  title: 'Oracle EBS 12.2 Workflow Topology, Queue Tables, and Metadata Management',
  slug: 'ebs-12-2-workflow-topology-queue-tables',
  excerpt:
    'A deep-dive into Oracle Workflow architecture inside EBS 12.2 — the key runtime tables, Advanced Queuing queue tables, Business Event System topology, Notification Mailer and Background Engine roles, and why workflow metadata purging is the most overlooked EBS performance lever.',
  category: 'ebs-suite' as const,
  published: true,
  publishedAt: new Date('2026-06-03'),
  isPremium: false,
  youtubeUrl: null,
  content: `Oracle Workflow is embedded in almost every EBS 12.2 business process — purchase order approvals, journal entries, expense reports, customer credit checks, and hundreds more. It runs quietly until it doesn't, and when it breaks, it tends to break loudly across multiple modules simultaneously. Understanding its internal structure is the difference between a 15-minute fix and a 4-hour war-room.

---

## Workflow Topology Overview

Oracle Workflow in EBS 12.2 is a four-layer system:

\`\`\`
┌──────────────────────────────────────────────────────────────────┐
│  EBS Application Tier                                            │
│                                                                  │
│  ┌─────────────────────┐   ┌──────────────────────────────────┐  │
│  │  Notification Mailer│   │  Workflow Agent Listener Service │  │
│  │  (Java, WF_MAILER)  │   │  (processes inbound queues)      │  │
│  └──────────┬──────────┘   └──────────────┬─────────────────┘  │
│             │                             │                      │
└─────────────┼─────────────────────────────┼──────────────────────┘
              │                             │
┌─────────────┼─────────────────────────────┼──────────────────────┐
│  Oracle Database (EBS DB Tier)            │                      │
│             │                             │                      │
│  ┌──────────▼──────────────────────────────▼──────────────────┐  │
│  │  Advanced Queuing (AQ) Layer                               │  │
│  │                                                            │  │
│  │  WF_DEFERRED          WF_INBOUND_NOTIFICATIONS             │  │
│  │  WF_OUTBOUND_NOTIFICATIONS  WF_JAVA_DEFERRED               │  │
│  │  WF_JAVA_ERROR        WF_CONTROL                           │  │
│  │  WF_BES_QUEUE (Business Event System)                      │  │
│  └────────────────────────┬───────────────────────────────────┘  │
│                           │                                      │
│  ┌────────────────────────▼───────────────────────────────────┐  │
│  │  Workflow Engine (PL/SQL + Java)                           │  │
│  │                                                            │  │
│  │  WF_ITEMS  WF_ITEM_ACTIVITY_STATUSES  WF_NOTIFICATIONS     │  │
│  │  WF_PROCESS_ACTIVITIES  WF_ACTIVITIES  WF_ROLES            │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Workflow Background Process (WFBG)                        │  │
│  │  Concurrent Program: Workflow Background Process           │  │
│  │  Handles: DEFERRED activities, TIMEOUT processing,        │  │
│  │           stuck notifications, retry on ERROR             │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
\`\`\`

### Components and Responsibilities

**Workflow Engine (PL/SQL)** — the synchronous processing core. Called inline by EBS forms and concurrent programs via \`WF_ENGINE.StartProcess\`, \`WF_ENGINE.CompleteActivity\`. Runs in the caller's session.

**Workflow Background Process (WFBG)** — the asynchronous processing engine. A concurrent program that polls for:
- Activities in \`DEFERRED\` status (heavy-weight processing moved off the user's session)
- Activities in \`ERROR\` status (optionally retried)
- Notifications that have timed out (\`TIMEOUT\` processing)

Should be scheduled to run every 1–5 minutes for most EBS environments. Multiple instances can run in parallel, scoped by item type.

**Notification Mailer** — a Java concurrent program (\`FNDWFMLR\`) that bridges Workflow notifications to email. It reads from \`WF_OUTBOUND_NOTIFICATIONS\` (AQ), sends email via JavaMail/SMTP, and processes replies by enqueuing messages to \`WF_INBOUND_NOTIFICATIONS\` (AQ). The mailer is also responsible for routing notifications to Worklist (OA Framework) via the Notification System.

**Workflow Agent Listener Service** — processes inbound AQ messages, routes Business Event System (BES) events, and handles inter-system messaging. Runs as part of the EBS Service Container framework.

---

## The Queue Tables

Oracle Workflow uses Oracle Advanced Queuing (AQ) for all asynchronous messaging. AQ queues are backed by queue tables — regular database tables with a specific structure that AQ manages. Understanding which queue is which is essential for diagnosing backlogs.

### Core Workflow Queues

| Queue Name | Queue Table | Direction | Purpose |
|---|---|---|---|
| \`WF_DEFERRED\` | \`WF_DEFERRED_QUEUE_M\` | Internal | Deferred workflow activities awaiting WFBG |
| \`WF_INBOUND_NOTIFICATIONS\` | \`WF_INBOUND_QUEUE_M\` | Inbound | Email replies from Notification Mailer |
| \`WF_OUTBOUND_NOTIFICATIONS\` | \`WF_OUTBOUND_QUEUE_M\` | Outbound | Notifications queued for delivery |
| \`WF_JAVA_DEFERRED\` | \`WF_JAVA_DEFERRED_M\` | Internal | Java-based deferred activities |
| \`WF_JAVA_ERROR\` | \`WF_JAVA_ERROR_M\` | Internal | Java activities that errored |
| \`WF_CONTROL\` | \`WF_CONTROL_QUEUE_M\` | Control | Service container control signals |

### Business Event System (BES) Queues

The BES is a pub/sub layer sitting on top of AQ. Applications raise events; the BES routes them to subscriptions (PL/SQL functions, agents, or external systems).

| Queue | Queue Table | Purpose |
|---|---|---|
| \`WF_BES_QUEUE\` | \`WF_BES_QUEUE_M\` | Main BES event delivery queue |
| \`WF_BES_DEADLETTER\` | \`WF_BES_DEADLETTER_M\` | BES events that could not be delivered |
| \`WF_ACCOUNT_OUT\` | \`WF_ACCOUNT_QUEUE_M\` | Outbound account-level event queue |
| \`WF_ACCOUNT_IN\` | \`WF_ACCOUNT_QUEUE_M\` | Inbound account-level event queue |

### Diagnosing Queue Backlogs

A backlog in \`WF_DEFERRED\` means WFBG is not keeping up — either it is not running, is running too infrequently, or a deferred activity is repeatedly failing. A backlog in \`WF_OUTBOUND_NOTIFICATIONS\` means the Notification Mailer is stopped or can't reach the SMTP server.

\`\`\`sql
-- Queue depths — run this first when Workflow is slow
SELECT  q.name                         queue_name,
        q.queue_type,
        NVL(m.ready_count, 0)          ready,
        NVL(m.waiting_count, 0)        waiting,
        NVL(m.expired_count, 0)        expired
FROM    user_queues q
LEFT JOIN (
    SELECT  queue_name,
            COUNT(CASE WHEN msg_state='READY'   THEN 1 END) ready_count,
            COUNT(CASE WHEN msg_state='WAIT'    THEN 1 END) waiting_count,
            COUNT(CASE WHEN msg_state='EXPIRED' THEN 1 END) expired_count
    FROM    aq\$wf_deferred_queue_m
    GROUP BY queue_name
    UNION ALL
    SELECT  queue_name,
            COUNT(CASE WHEN msg_state='READY'   THEN 1 END),
            COUNT(CASE WHEN msg_state='WAIT'    THEN 1 END),
            COUNT(CASE WHEN msg_state='EXPIRED' THEN 1 END)
    FROM    aq\$wf_outbound_queue_m
    GROUP BY queue_name
    UNION ALL
    SELECT  queue_name,
            COUNT(CASE WHEN msg_state='READY'   THEN 1 END),
            COUNT(CASE WHEN msg_state='WAIT'    THEN 1 END),
            COUNT(CASE WHEN msg_state='EXPIRED' THEN 1 END)
    FROM    aq\$wf_java_error_m
    GROUP BY queue_name
) m ON q.name = m.queue_name
WHERE   q.name LIKE 'WF%'
ORDER BY ready DESC, q.name;
\`\`\`

---

## The Runtime Tables

### WF_ITEMS — The Master Record

Every workflow process instance has exactly one row in \`WF_ITEMS\`. This is the entry point for all workflow status queries.

\`\`\`sql
-- Key columns
SELECT  item_type,          -- e.g. POAPPRV, APEXP, OEOL
        item_key,           -- unique identifier within item_type (often PO header id)
        root_activity,      -- top-level process name
        owner_role,         -- role that owns this item
        begin_date,         -- when process started
        end_date,           -- when process completed (NULL if still active)
        CASE
          WHEN end_date IS NOT NULL             THEN 'COMPLETE'
          WHEN parent_item_type IS NOT NULL     THEN 'SUBPROCESS'
          ELSE 'ACTIVE'
        END                                     status
FROM    wf_items
WHERE   item_type = 'POAPPRV'   -- Purchase Order Approval
  AND   end_date IS NULL        -- still active
  AND   begin_date < SYSDATE - 7  -- started more than 7 days ago (investigate)
ORDER BY begin_date;
\`\`\`

The \`end_date\` column is the single most important indicator: \`NULL\` means active; populated means complete. **COMPLETE rows in \`WF_ITEMS\` should be purged regularly** — they accumulate indefinitely if no purge job runs.

### WF_ITEM_ACTIVITY_STATUSES — The State Machine

One row per activity execution per workflow item. This table grows extremely quickly on active systems and is the primary target of metadata purge operations.

\`\`\`sql
-- Find items stuck in ERROR
SELECT  wias.item_type,
        wias.item_key,
        wa.display_name          activity_name,
        wias.activity_status,
        wias.activity_result_code,
        wias.error_name,
        wias.error_message,
        wias.error_stack,
        wias.begin_date,
        wias.end_date
FROM    wf_item_activity_statuses wias
JOIN    wf_process_activities wpa  ON wias.process_activity = wpa.instance_id
JOIN    wf_activities          wa  ON wpa.activity_item_type = wa.item_type
                                  AND wpa.activity_name      = wa.name
                                  AND wpa.activity_version   = wa.version
WHERE   wias.activity_status = 'ERROR'
ORDER BY wias.begin_date DESC
FETCH FIRST 50 ROWS ONLY;
\`\`\`

### WF_NOTIFICATIONS — The Notification Store

Every notification sent by Workflow has a row here. Notifications remain until explicitly closed or purged — a common source of unbounded table growth on environments without a purge job.

\`\`\`sql
-- Notifications by status — a healthy system has few OPEN rows
SELECT  status,
        mail_status,
        COUNT(*)        notification_count,
        MIN(begin_date) oldest,
        MAX(begin_date) newest
FROM    wf_notifications
GROUP BY status, mail_status
ORDER BY status, mail_status;
-- OPEN    SENT  → awaiting response, mailer delivered
-- OPEN    MAIL  → queued for mailer (backlog if large)
-- OPEN    FAILED → mailer failed to deliver
-- CLOSED  SENT  → normal completed notification
\`\`\`

### FND_WF_LOCAL_ROLES and WF_USER_ROLE_ASSIGNMENTS

These are the user/role tables that Workflow uses to resolve notification recipients. They are populated by the \`FNDWF_LOCAL_SYNCH\` concurrent program and should be kept in sync with \`FND_USER\` and \`FND_RESP\`. A stale local roles table causes "recipient not found" errors on notifications.

\`\`\`sql
-- Check for users in WF_NOTIFICATIONS with no local role (causes delivery failure)
SELECT  n.recipient_role,
        COUNT(*) stuck_notifications
FROM    wf_notifications n
WHERE   n.status = 'OPEN'
  AND   NOT EXISTS (
          SELECT 1 FROM wf_roles r
          WHERE  r.name = n.recipient_role
            AND  r.status = 'ACTIVE'
        )
GROUP BY n.recipient_role
ORDER BY 2 DESC;
\`\`\`

---

## Metadata Accumulation and Purging

### Why Tables Grow Without Bound

Oracle Workflow is designed with an append-only audit model: completed items, their activity statuses, and their notifications are all retained after process completion. Without a scheduled purge job, the following tables grow indefinitely:

| Table | Growth Driver | Typical row size |
|---|---|---|
| \`WF_ITEMS\` | 1 row per process instance | ~200 bytes |
| \`WF_ITEM_ACTIVITY_STATUSES\` | ~10–50 rows per instance | ~500 bytes |
| \`WF_NOTIFICATION_ATTRIBUTES\` | Variable per notification | Variable |
| \`WF_NOTIFICATIONS\` | 1+ row per notification sent | ~300 bytes |

On a busy EBS system processing 10,000 PO approvals per day, \`WF_ITEM_ACTIVITY_STATUSES\` accumulates roughly **500,000+ rows per day** for PO Approval alone. Without purging, it reaches hundreds of millions of rows within a year, causing:

- Full table scans on \`WF_ITEM_ACTIVITY_STATUSES\` during every workflow state transition
- \`wfstatus.jsp\` timeouts
- Slow WFBG cycles
- Block contention on the segment header during inserts

### The Purge API

Oracle provides the \`WF_PURGE\` package for metadata removal. The key procedure is \`WF_PURGE.TOTAL\`:

\`\`\`sql
-- Purge ALL item types — items completed more than 30 days ago
EXEC WF_PURGE.TOTAL(
  itemtype  => NULL,        -- NULL = all item types
  itemkey   => NULL,        -- NULL = all item keys
  enddate   => SYSDATE - 30, -- purge items completed before this date
  docommit  => TRUE,
  purgesigs => FALSE
);

-- Purge a specific item type only
EXEC WF_PURGE.ITEMS(
  itemtype  => 'POAPPRV',
  itemkey   => NULL,
  enddate   => SYSDATE - 30,
  docommit  => TRUE,
  purgesigs => FALSE
);

-- Purge closed notifications independently
EXEC WF_PURGE.NOTIFICATIONS(
  role      => NULL,         -- NULL = all roles
  enddate   => SYSDATE - 30,
  docommit  => TRUE
);
\`\`\`

### Recommended Purge Schedule

| Frequency | Scope | Retention |
|---|---|---|
| Daily | \`WF_PURGE.NOTIFICATIONS\` | 14 days |
| Weekly | \`WF_PURGE.TOTAL\` (standard item types) | 30 days |
| Monthly | \`WF_PURGE.TOTAL\` (all item types) | 90 days |
| Never purge | Items with \`ACTIVE\` status | — |

**Never purge active (open) workflow items.** The purge API checks \`end_date IS NOT NULL\` before removing rows — it will not delete open items — but confirm the retention window suits your audit requirements before scheduling.

### Concurrent Program Alternative

EBS provides the **Purge Obsolete Workflow Runtime Data** concurrent program (\`FNDWFPR\`), which calls \`WF_PURGE.TOTAL\` internally. It is the preferred mechanism for scheduled purges because it logs to concurrent requests and can be monitored via FND. Run it during off-peak hours; on large tables the first run can take several hours.

---

## Common Workflow Problems Quick Reference

| Symptom | Most Likely Cause | First Check |
|---|---|---|
| PO/Expense stuck "In Workflow" | WFBG not running or activity in ERROR | \`WF_ITEM_ACTIVITY_STATUSES\` where \`activity_status='ERROR'\` |
| Notifications not delivered | Mailer stopped or SMTP failure | Notification Mailer concurrent program status; \`WF_OUTBOUND_NOTIFICATIONS\` queue depth |
| \`wfstatus.jsp\` times out | \`WF_ITEM_ACTIVITY_STATUSES\` too large | Row count; missing index on \`(ITEM_TYPE, ITEM_KEY)\` |
| BES events not propagating | Agent Listener not running | \`WF_BES_QUEUE\` depth; check Service Container |
| "Recipient not found" errors | Local roles out of sync | Run \`FNDWF_LOCAL_SYNCH\`; check \`WF_ROLES\` |
| \`WF_DEFERRED\` queue growing | WFBG not running frequently enough | Schedule WFBG every 1 minute; check for deferred activities with errors |
`,
};

const runbookPost = {
  title: 'Runbook: EBS 12.2 Workflow Health Check and Purge Assessment Script',
  slug: 'ebs-12-2-workflow-health-check-purge-runbook',
  excerpt:
    'A self-contained SQL and shell health check script for Oracle EBS 12.2 Workflow — assesses queue depths, stuck and errored items, notification backlog, table row counts and segment sizes, WFBG run recency, and produces a PURGE REQUIRED / MONITOR / OK recommendation with the exact WF_PURGE commands to execute.',
  category: 'ebs-suite' as const,
  published: true,
  publishedAt: new Date('2026-06-03'),
  isPremium: true,
  youtubeUrl: null,
  content: `This runbook provides a single script — \`wf_health_check.sh\` — that connects to the EBS database and produces a structured Workflow health report. The report ends with one of three verdicts:

- **PURGE REQUIRED** — table sizes or retention age have crossed thresholds; the script outputs ready-to-run purge commands.
- **MONITOR** — approaching thresholds; schedule a purge within the week.
- **OK** — no action needed.

Run as the \`applmgr\` OS user (or any user with \`SELECT\` on Workflow tables and \`EXECUTE\` on \`WF_PURGE\`).

---

## Prerequisites

\`\`\`bash
# Set EBS environment before running
source /u01/EBSapps/appl/EBSapps.env run
# or: . /u01/install/APPS/EBSapps.env run

# Required grants (run as APPS or SYSDBA if not already in place)
-- GRANT SELECT ON WF_ITEMS               TO apps;
-- GRANT SELECT ON WF_ITEM_ACTIVITY_STATUSES TO apps;
-- GRANT SELECT ON WF_NOTIFICATIONS        TO apps;
-- GRANT SELECT ON WF_NOTIFICATION_ATTRIBUTES TO apps;
-- GRANT EXECUTE ON WF_PURGE              TO apps;
\`\`\`

---

## The Health Check Script

\`\`\`bash
#!/bin/bash
# wf_health_check.sh — Oracle EBS 12.2 Workflow health and purge assessment
# Usage: ./wf_health_check.sh [--purge] [--retention-days N]
#   --purge            Execute purge commands if PURGE REQUIRED verdict reached
#   --retention-days N Override default 30-day retention window (default: 30)
# Requires: EBSapps.env sourced, APPS DB password in env or prompt

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────
RETENTION_DAYS=30
DO_PURGE=false
REPORT="/tmp/wf_health_\$(date +%Y%m%d_%H%M%S).txt"

# Thresholds
WF_ITEMS_WARN=5000000         # 5M rows
WF_ITEMS_CRIT=20000000        # 20M rows
WF_IAS_WARN=50000000          # 50M rows  (WF_ITEM_ACTIVITY_STATUSES)
WF_IAS_CRIT=200000000         # 200M rows
WF_NOTIF_WARN=2000000         # 2M rows
WF_NOTIF_CRIT=10000000        # 10M rows
DEFERRED_WARN=1000            # 1K READY messages
DEFERRED_CRIT=10000           # 10K READY messages
OUTBOUND_WARN=500             # 500 READY messages
OLDEST_COMPLETE_WARN=30       # days
OLDEST_COMPLETE_CRIT=90       # days
WFBG_STALE_WARN=30            # minutes since last WFBG run

# ── Argument parsing ───────────────────────────────────────────────────────
for arg in "\$@"; do
  case "\$arg" in
    --purge)           DO_PURGE=true ;;
    --retention-days)  shift; RETENTION_DAYS="\$1" ;;
  esac
done

# ── DB credentials ─────────────────────────────────────────────────────────
if [ -z "\${APPS_DB_PASS:-}" ]; then
  read -rsp "Enter APPS password: " APPS_DB_PASS; echo
fi

if [ -z "\${TWO_TASK:-}" ] && [ -z "\${ORACLE_SID:-}" ]; then
  read -rp "Enter DB connect string (e.g. EBSPROD): " CONNECT_STRING
else
  CONNECT_STRING="\${TWO_TASK:-\$ORACLE_SID}"
fi

SQLPLUS="sqlplus -s apps/\${APPS_DB_PASS}@\${CONNECT_STRING}"

# ── Utilities ──────────────────────────────────────────────────────────────
log()    { echo "\$1" | tee -a "\$REPORT"; }
hr()     { log "\$(printf '%.0s=' {1..68})"; }
hr_thin(){ log "\$(printf '%.0s-' {1..68})"; }

PASS=0; WARN=0; FAIL=0; VERDICT="OK"

pass()  { log "  [OK]   \$1"; ((PASS++)); }
warn()  { log "  [WARN] \$1"; ((WARN++)); [ "\$VERDICT" = "OK" ] && VERDICT="MONITOR"; }
fail()  { log "  [CRIT] \$1"; ((FAIL++)); VERDICT="PURGE REQUIRED"; }
info()  { log "         \$1"; }

# ── Run SQL block, return result ───────────────────────────────────────────
run_sql() {
  \$SQLPLUS << SQL 2>/dev/null
SET PAGES 0 FEEDBACK OFF HEADING OFF TRIMOUT ON TRIMSPOOL ON
\$1
EXIT;
SQL
}

# ── Header ─────────────────────────────────────────────────────────────────
hr
log "  Oracle EBS 12.2 — Workflow Health Check"
log "  \$(date)"
log "  Connect : \$CONNECT_STRING | Retention window: \${RETENTION_DAYS} days"
hr

# ══════════════════════════════════════════════════════════════════════════
log ""
log "  SECTION 1: TABLE ROW COUNTS"
hr_thin

# WF_ITEMS total and by status
log ""
log "  WF_ITEMS"
WF_ITEMS_TOTAL=\$(run_sql "SELECT COUNT(*) FROM wf_items;" | tr -d ' \n')
WF_ITEMS_ACTIVE=\$(run_sql "SELECT COUNT(*) FROM wf_items WHERE end_date IS NULL;" | tr -d ' \n')
WF_ITEMS_COMPLETE=\$(run_sql "SELECT COUNT(*) FROM wf_items WHERE end_date IS NOT NULL;" | tr -d ' \n')
WF_ITEMS_OLD=\$(run_sql "SELECT COUNT(*) FROM wf_items
WHERE end_date IS NOT NULL
  AND end_date < SYSDATE - \${RETENTION_DAYS};" | tr -d ' \n')

log "  Total rows         : \${WF_ITEMS_TOTAL:-0}"
log "  Active (end_date IS NULL)  : \${WF_ITEMS_ACTIVE:-0}"
log "  Complete (purgeable)       : \${WF_ITEMS_COMPLETE:-0}"
log "  Older than \${RETENTION_DAYS} days (target for purge): \${WF_ITEMS_OLD:-0}"

if [ "\${WF_ITEMS_TOTAL:-0}" -ge "\$WF_ITEMS_CRIT" ] 2>/dev/null; then
  fail "WF_ITEMS has \$WF_ITEMS_TOTAL rows (critical threshold: \$WF_ITEMS_CRIT)"
elif [ "\${WF_ITEMS_TOTAL:-0}" -ge "\$WF_ITEMS_WARN" ] 2>/dev/null; then
  warn "WF_ITEMS has \$WF_ITEMS_TOTAL rows (warning threshold: \$WF_ITEMS_WARN)"
else
  pass "WF_ITEMS: \${WF_ITEMS_TOTAL:-0} rows"
fi

# WF_ITEM_ACTIVITY_STATUSES
log ""
log "  WF_ITEM_ACTIVITY_STATUSES (WIAS)"
WF_IAS_TOTAL=\$(run_sql "SELECT COUNT(*) FROM wf_item_activity_statuses;" | tr -d ' \n')
WF_IAS_ERROR=\$(run_sql "SELECT COUNT(*) FROM wf_item_activity_statuses WHERE activity_status='ERROR';" | tr -d ' \n')
WF_IAS_DEFERRED=\$(run_sql "SELECT COUNT(*) FROM wf_item_activity_statuses WHERE activity_status='DEFERRED';" | tr -d ' \n')

log "  Total rows         : \${WF_IAS_TOTAL:-0}"
log "  ERROR status       : \${WF_IAS_ERROR:-0}"
log "  DEFERRED status    : \${WF_IAS_DEFERRED:-0}"

if [ "\${WF_IAS_TOTAL:-0}" -ge "\$WF_IAS_CRIT" ] 2>/dev/null; then
  fail "WF_ITEM_ACTIVITY_STATUSES has \$WF_IAS_TOTAL rows (critical threshold: \$WF_IAS_CRIT)"
elif [ "\${WF_IAS_TOTAL:-0}" -ge "\$WF_IAS_WARN" ] 2>/dev/null; then
  warn "WF_ITEM_ACTIVITY_STATUSES has \$WF_IAS_TOTAL rows (warning threshold: \$WF_IAS_WARN)"
else
  pass "WF_ITEM_ACTIVITY_STATUSES: \${WF_IAS_TOTAL:-0} rows"
fi

if [ "\${WF_IAS_ERROR:-0}" -gt 100 ] 2>/dev/null; then
  warn "\${WF_IAS_ERROR} activities in ERROR status — investigate before purging"
fi

# WF_NOTIFICATIONS
log ""
log "  WF_NOTIFICATIONS"
WF_NOTIF_TOTAL=\$(run_sql "SELECT COUNT(*) FROM wf_notifications;" | tr -d ' \n')
WF_NOTIF_OPEN=\$(run_sql "SELECT COUNT(*) FROM wf_notifications WHERE status='OPEN';" | tr -d ' \n')
WF_NOTIF_CLOSED=\$(run_sql "SELECT COUNT(*) FROM wf_notifications WHERE status='CLOSED';" | tr -d ' \n')
WF_NOTIF_FAILED=\$(run_sql "SELECT COUNT(*) FROM wf_notifications WHERE mail_status='FAILED';" | tr -d ' \n')

log "  Total rows         : \${WF_NOTIF_TOTAL:-0}"
log "  OPEN               : \${WF_NOTIF_OPEN:-0}"
log "  CLOSED (purgeable) : \${WF_NOTIF_CLOSED:-0}"
log "  FAILED mail_status : \${WF_NOTIF_FAILED:-0}"

if [ "\${WF_NOTIF_TOTAL:-0}" -ge "\$WF_NOTIF_CRIT" ] 2>/dev/null; then
  fail "WF_NOTIFICATIONS has \$WF_NOTIF_TOTAL rows (critical threshold: \$WF_NOTIF_CRIT)"
elif [ "\${WF_NOTIF_TOTAL:-0}" -ge "\$WF_NOTIF_WARN" ] 2>/dev/null; then
  warn "WF_NOTIFICATIONS has \$WF_NOTIF_TOTAL rows (warning threshold: \$WF_NOTIF_WARN)"
else
  pass "WF_NOTIFICATIONS: \${WF_NOTIF_TOTAL:-0} rows"
fi

if [ "\${WF_NOTIF_FAILED:-0}" -gt 0 ] 2>/dev/null; then
  warn "\${WF_NOTIF_FAILED} notifications with FAILED mail_status — check Notification Mailer"
fi

# ══════════════════════════════════════════════════════════════════════════
log ""
log "  SECTION 2: SEGMENT SIZES"
hr_thin

run_sql "
SELECT segment_name,
       ROUND(bytes/1073741824, 2) || ' GB'   segment_size
FROM   dba_segments
WHERE  segment_name IN (
         'WF_ITEMS','WF_ITEM_ACTIVITY_STATUSES','WF_NOTIFICATIONS',
         'WF_NOTIFICATION_ATTRIBUTES','WF_PROCESS_ACTIVITY_STATUSES'
       )
  AND  owner = 'APPLSYS'
ORDER BY bytes DESC;
" | while read -r line; do
  [ -n "\$line" ] && log "  \$line"
done

# ══════════════════════════════════════════════════════════════════════════
log ""
log "  SECTION 3: RETENTION AGE CHECK"
hr_thin

OLDEST_COMPLETE=\$(run_sql "
SELECT ROUND(SYSDATE - MIN(end_date))
FROM   wf_items
WHERE  end_date IS NOT NULL;" | tr -d ' \n')

if [ -n "\$OLDEST_COMPLETE" ] && [ "\$OLDEST_COMPLETE" != "" ] 2>/dev/null; then
  log ""
  log "  Oldest completed WF_ITEMS row: \${OLDEST_COMPLETE} days ago"
  if [ "\$OLDEST_COMPLETE" -ge "\$OLDEST_COMPLETE_CRIT" ] 2>/dev/null; then
    fail "Oldest complete item is \${OLDEST_COMPLETE} days old (critical: \${OLDEST_COMPLETE_CRIT} days)"
    info "Purge window set to \${RETENTION_DAYS} days — \${WF_ITEMS_OLD} items eligible for removal"
  elif [ "\$OLDEST_COMPLETE" -ge "\$OLDEST_COMPLETE_WARN" ] 2>/dev/null; then
    warn "Oldest complete item is \${OLDEST_COMPLETE} days old (warning: \${OLDEST_COMPLETE_WARN} days)"
  else
    pass "Oldest complete item: \${OLDEST_COMPLETE} days old (within retention window)"
  fi
fi

# Top item types by purgeable count
log ""
log "  Top purgeable item types (complete, older than \${RETENTION_DAYS} days):"
run_sql "
SELECT item_type,
       COUNT(*) purgeable_items
FROM   wf_items
WHERE  end_date IS NOT NULL
  AND  end_date < SYSDATE - \${RETENTION_DAYS}
GROUP BY item_type
ORDER BY 2 DESC
FETCH FIRST 10 ROWS ONLY;" | while read -r line; do
  [ -n "\$line" ] && log "  \$(printf '  %-30s %s' \$line)"
done

# ══════════════════════════════════════════════════════════════════════════
log ""
log "  SECTION 4: QUEUE DEPTHS (Advanced Queuing)"
hr_thin

check_queue_depth() {
  local Q_TABLE=\$1
  local Q_NAME=\$2
  local WARN_THRESH=\$3
  local CRIT_THRESH=\$4
  DEPTH=\$(run_sql "
SELECT COUNT(*)
FROM   \${Q_TABLE}
WHERE  q_name = '\${Q_NAME}'
  AND  msg_state = 'READY';" | tr -d ' \n')
  WAIT=\$(run_sql "
SELECT COUNT(*)
FROM   \${Q_TABLE}
WHERE  q_name = '\${Q_NAME}'
  AND  msg_state = 'WAIT';" | tr -d ' \n')
  EXPIRED=\$(run_sql "
SELECT COUNT(*)
FROM   \${Q_TABLE}
WHERE  q_name = '\${Q_NAME}'
  AND  msg_state = 'EXPIRED';" | tr -d ' \n')

  log "  \${Q_NAME}"
  log "    READY=\${DEPTH:-0}  WAIT=\${WAIT:-0}  EXPIRED=\${EXPIRED:-0}"

  if [ "\${DEPTH:-0}" -ge "\$CRIT_THRESH" ] 2>/dev/null; then
    fail "Queue \${Q_NAME} READY depth=\${DEPTH} (critical: \${CRIT_THRESH})"
  elif [ "\${DEPTH:-0}" -ge "\$WARN_THRESH" ] 2>/dev/null; then
    warn "Queue \${Q_NAME} READY depth=\${DEPTH} (warning: \${WARN_THRESH})"
  else
    pass "Queue \${Q_NAME}: READY=\${DEPTH:-0}"
  fi
}

log ""
check_queue_depth "AQ\\\$WF_DEFERRED_QUEUE_M"      "WF_DEFERRED"               "\$DEFERRED_WARN"  "\$DEFERRED_CRIT"
check_queue_depth "AQ\\\$WF_OUTBOUND_QUEUE_M"      "WF_OUTBOUND_NOTIFICATIONS" "\$OUTBOUND_WARN"  500
check_queue_depth "AQ\\\$WF_INBOUND_QUEUE_M"       "WF_INBOUND_NOTIFICATIONS"  100                1000
check_queue_depth "AQ\\\$WF_JAVA_ERROR_M"          "WF_JAVA_ERROR"             10                 100
check_queue_depth "AQ\\\$WF_BES_DEADLETTER_M"      "WF_BES_DEADLETTER"         1                  50

# ══════════════════════════════════════════════════════════════════════════
log ""
log "  SECTION 5: WFBG (Workflow Background Process) RECENCY"
hr_thin

WFBG_LAST=\$(run_sql "
SELECT ROUND((SYSDATE - MAX(actual_start_date)) * 1440)
FROM   fnd_concurrent_requests
WHERE  concurrent_program_id = (
         SELECT concurrent_program_id
         FROM   fnd_concurrent_programs
         WHERE  concurrent_program_name = 'WFBG'
           AND  application_id = 0
       )
  AND  phase_code = 'C'
  AND  status_code = 'C';" | tr -d ' \n')

if [ -n "\$WFBG_LAST" ] && [ "\$WFBG_LAST" != "" ] 2>/dev/null; then
  log ""
  log "  Last completed WFBG run: \${WFBG_LAST} minutes ago"
  if [ "\$WFBG_LAST" -ge "\$WFBG_STALE_WARN" ] 2>/dev/null; then
    warn "WFBG last completed \${WFBG_LAST} minutes ago — schedule more frequently (target: every 1–5 min)"
  else
    pass "WFBG last ran \${WFBG_LAST} minutes ago"
  fi
else
  warn "WFBG last run time could not be determined — verify it is scheduled"
fi

# Active WFBG instances right now
WFBG_RUNNING=\$(run_sql "
SELECT COUNT(*)
FROM   fnd_concurrent_requests
WHERE  concurrent_program_id = (
         SELECT concurrent_program_id
         FROM   fnd_concurrent_programs
         WHERE  concurrent_program_name = 'WFBG'
           AND  application_id = 0
       )
  AND  phase_code = 'R';" | tr -d ' \n')
log "  WFBG instances currently running: \${WFBG_RUNNING:-0}"

# ══════════════════════════════════════════════════════════════════════════
log ""
log "  SECTION 6: STUCK AND ERRORED ITEMS"
hr_thin

STUCK_ITEMS=\$(run_sql "
SELECT item_type || ' ' || item_key || ' since ' ||
       TO_CHAR(begin_date,'YYYY-MM-DD HH24:MI')
FROM   wf_items
WHERE  end_date IS NULL
  AND  begin_date < SYSDATE - 2
ORDER BY begin_date
FETCH FIRST 10 ROWS ONLY;" 2>/dev/null)

log ""
log "  Oldest 10 active items (started > 2 days ago):"
if [ -n "\$STUCK_ITEMS" ]; then
  echo "\$STUCK_ITEMS" | while read -r line; do
    [ -n "\$line" ] && log "  \$line"
  done
else
  log "  None — all active items are recent"
fi

ERROR_SUMMARY=\$(run_sql "
SELECT wias.item_type,
       wa.display_name,
       wias.error_name,
       COUNT(*) cnt
FROM   wf_item_activity_statuses wias
JOIN   wf_process_activities wpa  ON wias.process_activity = wpa.instance_id
JOIN   wf_activities wa           ON wpa.activity_item_type = wa.item_type
                                 AND wpa.activity_name      = wa.name
                                 AND wpa.activity_version   = wa.version
WHERE  wias.activity_status = 'ERROR'
GROUP BY wias.item_type, wa.display_name, wias.error_name
ORDER BY 4 DESC
FETCH FIRST 10 ROWS ONLY;" 2>/dev/null)

log ""
log "  Top ERROR activity types:"
if [ -n "\$ERROR_SUMMARY" ]; then
  echo "\$ERROR_SUMMARY" | while read -r line; do
    [ -n "\$line" ] && log "  \$line"
  done
else
  log "  No ERROR activities found"
fi

# ══════════════════════════════════════════════════════════════════════════
log ""
log "  SECTION 7: NOTIFICATION MAILER STATUS"
hr_thin

MAILER_STATUS=\$(run_sql "
SELECT fcr.status_code || ' / phase=' || fcr.phase_code
FROM   fnd_concurrent_requests fcr
WHERE  fcr.concurrent_program_id = (
         SELECT concurrent_program_id
         FROM   fnd_concurrent_programs
         WHERE  concurrent_program_name = 'FNDWFMLR'
           AND  application_id = 0
       )
ORDER BY fcr.request_id DESC
FETCH FIRST 1 ROW ONLY;" | tr -d ' \n')

log ""
if echo "\$MAILER_STATUS" | grep -q "R / phase=R" 2>/dev/null; then
  pass "Notification Mailer is RUNNING"
elif [ -n "\$MAILER_STATUS" ]; then
  fail "Notification Mailer status: \$MAILER_STATUS (expected R/R for Running)"
else
  warn "Notification Mailer status could not be determined"
fi

# ══════════════════════════════════════════════════════════════════════════
log ""
hr
log "  VERDICT: \$VERDICT"
log "  PASS=\$PASS  WARN=\$WARN  CRIT=\$FAIL"
hr

# ══════════════════════════════════════════════════════════════════════════
if [ "\$VERDICT" = "PURGE REQUIRED" ] || [ "\$VERDICT" = "MONITOR" ]; then
  log ""
  log "  RECOMMENDED PURGE COMMANDS"
  hr_thin
  log ""
  log "  Run these during off-peak hours. Estimated runtime: 15 min – 4 hours"
  log "  depending on volume. Run WF_PURGE.NOTIFICATIONS first (fastest)."
  log ""
  log "  -- Step 1: Purge closed notifications (quickest, least risk)"
  log "  EXEC WF_PURGE.NOTIFICATIONS("
  log "    role     => NULL,"
  log "    enddate  => SYSDATE - \${RETENTION_DAYS},"
  log "    docommit => TRUE"
  log "  );"
  log ""
  log "  -- Step 2: Purge completed items for top item types first"

  run_sql "
SELECT '  EXEC WF_PURGE.ITEMS(itemtype=>''' || item_type ||
       ''', itemkey=>NULL, enddate=>SYSDATE-\${RETENTION_DAYS}, docommit=>TRUE);'
FROM (
  SELECT item_type, COUNT(*) cnt
  FROM   wf_items
  WHERE  end_date IS NOT NULL
    AND  end_date < SYSDATE - \${RETENTION_DAYS}
  GROUP BY item_type
  ORDER BY 2 DESC
  FETCH FIRST 10 ROWS ONLY
);" | while read -r line; do
    [ -n "\$line" ] && log "\$line"
  done

  log ""
  log "  -- Step 3: Full purge (after per-type purge, catches any remaining)"
  log "  EXEC WF_PURGE.TOTAL("
  log "    itemtype  => NULL,"
  log "    itemkey   => NULL,"
  log "    enddate   => SYSDATE - \${RETENTION_DAYS},"
  log "    docommit  => TRUE,"
  log "    purgesigs => FALSE"
  log "  );"
  log ""
  log "  -- Step 4: Rebuild indexes after large purge (if > 20% rows removed)"
  log "  -- ALTER INDEX APPLSYS.WF_ITEM_ACTIVITY_STATUSES_N1 REBUILD ONLINE;"
  log "  -- ALTER INDEX APPLSYS.WF_NOTIFICATIONS_N1 REBUILD ONLINE;"

  if [ "\$DO_PURGE" = "true" ]; then
    log ""
    log "  --purge flag set — executing purge now..."
    \$SQLPLUS << SQLEOF
SET SERVEROUTPUT ON SIZE UNLIMITED
SET FEEDBACK ON
EXEC WF_PURGE.NOTIFICATIONS(role=>NULL, enddate=>SYSDATE-\${RETENTION_DAYS}, docommit=>TRUE);
EXEC WF_PURGE.TOTAL(itemtype=>NULL, itemkey=>NULL, enddate=>SYSDATE-\${RETENTION_DAYS}, docommit=>TRUE, purgesigs=>FALSE);
COMMIT;
EXIT;
SQLEOF
    log "  Purge complete."
  else
    log ""
    log "  To execute purge automatically, re-run: ./wf_health_check.sh --purge"
  fi
fi

# ══════════════════════════════════════════════════════════════════════════
log ""
hr
log "  Report written to: \$REPORT"
hr
\`\`\`

---

## Quick Reference: Run the Script

\`\`\`bash
# Health check only (no purge)
./wf_health_check.sh

# Health check with automatic purge if PURGE REQUIRED
./wf_health_check.sh --purge

# Custom retention window (keep 14 days instead of 30)
./wf_health_check.sh --retention-days 14

# Pass DB password via environment (for cron)
export APPS_DB_PASS=secret
./wf_health_check.sh --retention-days 30 --purge
\`\`\`

---

## Scheduling via Cron (Non-Interactive)

\`\`\`bash
# /etc/cron.d/ebs_wf_health — run health check nightly at 01:00
# Send report to DBA team; execute purge automatically

0 1 * * * applmgr bash -c '\
  source /u01/EBSapps/appl/EBSapps.env run; \
  export APPS_DB_PASS=\$(cat /home/applmgr/.dba_pass); \
  /home/applmgr/scripts/wf_health_check.sh --purge --retention-days 30 \
' > /tmp/wf_cron_\$(date +\\%Y\\%m\\%d).log 2>&1
\`\`\`

Store the password in a file readable only by \`applmgr\` (\`chmod 400\`), or use Oracle Wallet / EBS password manager.

---

## Interpreting the Report

| Section | Key indicator | Action |
|---|---|---|
| Row counts | Any CRIT threshold crossed | Immediate purge required |
| Segment sizes | Any table > 50 GB | Purge + \`SHRINK SPACE\` or rebuild |
| Retention age | Oldest complete > 90 days | Immediate purge; investigate missing schedule |
| Queue depths | \`WF_DEFERRED\` READY > 10K | Check WFBG; look for ERROR loops |
| Queue depths | \`WF_OUTBOUND\` READY > 500 | Check Notification Mailer status |
| Queue depths | \`WF_BES_DEADLETTER\` > 0 | BES subscription is failing; investigate event type |
| WFBG recency | Last run > 30 min ago | Reschedule WFBG; check concurrent manager |
| ERROR activities | Any count > 100 | Investigate before purge — errors indicate real process failures |
| Mailer status | Not R/R | Restart Notification Mailer concurrent program |
`,
};

async function main() {
  for (const post of [blogPost, runbookPost]) {
    await db
      .insert(posts)
      .values({
        title: post.title,
        slug: post.slug,
        excerpt: post.excerpt,
        content: post.content,
        category: post.category,
        youtubeUrl: post.youtubeUrl,
        isPremium: post.isPremium,
        published: post.published,
        publishedAt: post.publishedAt,
      })
      .onConflictDoUpdate({
        target: posts.slug,
        set: {
          title: post.title,
          excerpt: post.excerpt,
          content: post.content,
          isPremium: post.isPremium,
          published: post.published,
          publishedAt: post.publishedAt,
        },
      });
    console.log('inserted:', post.slug);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
