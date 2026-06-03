import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const blogPost = {
  title: 'Oracle Data Guard Switchover and Failover: Concepts and Decision Framework',
  slug: 'dataguard-switchover-failover',
  excerpt:
    'A practical guide to Oracle Data Guard switchover and failover — understanding the difference, pre-operation checks, DGMGRL-based execution, redo apply lag assessment, post-operation validation, and how to re-synchronise the former primary after a failover.',
  category: 'disaster-recovery' as const,
  published: true,
  publishedAt: new Date('2026-06-02'),
  isPremium: false,
  youtubeUrl: null,
  content: `Data Guard protects Oracle databases by maintaining one or more standby databases that receive and apply redo from the primary. When something goes wrong with the primary — or when you need to move the primary role deliberately — you perform either a **switchover** or a **failover**. Choosing the wrong operation, or executing it without the right pre-checks, can cost data and extend downtime significantly.

This post explains both operations, how to decide which one to use, and the key checks to run before and after each.

---

## Switchover vs Failover

| | Switchover | Failover |
|---|---|---|
| When | Planned maintenance, patching, DR tests | Primary is unavailable or unrecoverable |
| Primary state | Online, accessible | Down or isolated |
| Data loss | Zero (synchronised before transition) | Potential loss equal to redo gap |
| Former primary fate | Automatically converted to standby | Must be manually reinstated or rebuilt |
| Reversibility | Easily reversed (switch back) | Requires full reinstatement to reverse |

**Use switchover** for: OS patching, storage migration, performance testing on primary hardware, planned DR drills.

**Use failover** only when: the primary is genuinely unavailable and cannot be recovered fast enough to meet your RTO.

Do not failover when a switchover is possible. Failover requires reinstating the former primary afterward — a multi-hour process for large databases.

---

## Data Guard Broker (DGMGRL) vs SQL*Plus

Oracle recommends using **Data Guard Broker** (\`dgmgrl\`) for all role transitions. Broker:
- Validates configuration health before allowing the operation
- Coordinates both databases atomically
- Handles the redo gap automatically during switchover
- Provides clear status at each step

SQL*Plus \`ALTER DATABASE SWITCHOVER TO\` is still supported but gives you less automation and requires more manual coordination. This post uses DGMGRL.

---

## Pre-Operation Checklist

Run these checks before every switchover or failover. Do not skip them — a switchover against an unhealthy configuration can corrupt both databases.

### 1. Confirm broker configuration is enabled and healthy

\`\`\`
DGMGRL> show configuration;

Configuration - EBS_DG

  Protection Mode: MaxAvailability
  Members:
    EBSPROD  - Primary database
    EBSDR    - Physical standby database

Fast-Start Failover:  Disabled

Configuration Status:
SUCCESS
\`\`\`

Any status other than \`SUCCESS\` must be resolved before proceeding. Common non-SUCCESS states:

- \`WARNING\` — redo transport lag exists but is within configured thresholds; check the lag value
- \`ERROR\` — broker cannot communicate with one or both members; investigate before proceeding
- \`DISABLED\` — broker is not managing the configuration; enable it or revert to SQL*Plus

### 2. Check redo apply lag on the standby

\`\`\`
DGMGRL> show database verbose EBSDR;
\`\`\`

Look for:
- **Apply Lag** — time the standby is behind the primary. For switchover this should be 0 or very small. For failover, record this value — it represents potential data loss.
- **Transport Lag** — time since the last redo was received. Should be 0 in MaxProtection or MaxAvailability mode.

From SQL*Plus on the standby:

\`\`\`sql
SELECT name,
       value,
       time_computed,
       datum_time
FROM   v\$dataguard_stats
WHERE  name IN ('transport lag','apply lag','apply finish time')
ORDER BY name;
\`\`\`

\`apply finish time\` tells you how long the standby needs to finish applying all received redo — useful during failover when you want to wait for full synchronisation before completing the role change.

### 3. Verify standby redo log configuration

Switchover requires the standby to have Standby Redo Logs (SRLs). The number of SRLs must be at least one more than the number of online redo log groups on the primary.

\`\`\`sql
-- On primary: count online redo log groups
SELECT COUNT(*) FROM v\$log;

-- On standby: count standby redo log groups
SELECT COUNT(*) FROM v\$standby_log;
-- Result must be >= (primary online log groups + 1)
\`\`\`

### 4. Check archive log gap

\`\`\`sql
-- On primary: check for any sequence gap between primary and standby
SELECT thread#,
       last_seq_received,
       last_seq_applied,
       last_seq_received - last_seq_applied AS apply_gap
FROM (
    SELECT thread#,
           MAX(sequence#) AS last_seq_received
    FROM   v\$archived_log
    WHERE  dest_id = 2  -- standby destination
    AND    applied = 'YES'
    GROUP BY thread#
) r,
(
    SELECT thread#,
           MAX(sequence#) AS last_seq_applied
    FROM   v\$archived_log
    WHERE  standby_dest = 'YES'
    AND    applied = 'YES'
    GROUP BY thread#
) a
WHERE r.thread# = a.thread#;
\`\`\`

A gap of 0 means the standby has applied everything the primary has generated. Any non-zero gap during a planned switchover should be allowed to close before proceeding.

### 5. Confirm no active transactions that cannot tolerate brief suspension

During the switchover, the primary briefly suspends new connections while the final redo is shipped to the standby. Check for long-running transactions:

\`\`\`sql
SELECT sid, serial#, username,
       ROUND(elapsed_time/1000000, 1) AS elapsed_secs,
       sql_id
FROM   v\$session
WHERE  status = 'ACTIVE'
AND    type   = 'USER'
AND    elapsed_time > 30000000   -- longer than 30 seconds
ORDER BY elapsed_time DESC;
\`\`\`

---

## Performing a Switchover

Switchover is safe to run from DGMGRL with a single command. Broker validates the configuration, flushes remaining redo, transitions both databases simultaneously, and opens the new primary.

\`\`\`
# Connect to broker on the primary host (or any host with tnsnames to both)
dgmgrl sys/password@EBSPROD

DGMGRL> show configuration;
-- Confirm SUCCESS before proceeding

DGMGRL> switchover to EBSDR;
Performing switchover NOW, please wait...
Operation requires a connection to instance "EBSDR1" on database "EBSDR"
Connecting to instance "EBSDR1"...
Connected as SYSDG.
New primary database "EBSDR" is opening...
Operation requires start up of instance "EBSPROD1" on database "EBSPROD"
Connecting to instance "EBSPROD1"...
Connected as SYSDG.
Waiting for instance "EBSPROD1" to start...
Instance "EBSPROD1" started
Connected to "EBSPROD"
Switchover succeeded, new primary is "EBSDR"
\`\`\`

The former primary (\`EBSPROD\`) is now a physical standby. No reinstatement is required.

### Post-switchover validation

\`\`\`
DGMGRL> show configuration;
-- Should show EBSDR as Primary, EBSPROD as Physical standby, status SUCCESS

DGMGRL> show database EBSDR;
-- Confirm Role: PRIMARY, Database Status: SUCCESS

DGMGRL> show database EBSPROD;
-- Confirm Role: PHYSICAL STANDBY, Apply State: Applying
\`\`\`

From the new primary:

\`\`\`sql
SELECT database_role, open_mode, protection_mode FROM v\$database;
-- DATABASE_ROLE = PRIMARY, OPEN_MODE = READ WRITE
\`\`\`

---

## Performing a Failover

Failover is irreversible without reinstatement. Run it only after confirming the primary is genuinely unavailable.

### Step 1: Attempt to mount the standby if it is not already mounted

\`\`\`sql
-- On standby (if not already started)
STARTUP MOUNT;
\`\`\`

### Step 2: Wait for all received redo to be applied (if time permits)

\`\`\`sql
-- On standby: check remaining redo to apply
SELECT name, value FROM v\$dataguard_stats
WHERE  name = 'apply finish time';
\`\`\`

If the value is seconds and your RTO allows it, wait for apply to complete. This minimises data loss.

To end redo apply and initiate failover immediately:

\`\`\`sql
-- Cancel managed recovery (if apply lag is acceptable)
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE CANCEL;
\`\`\`

### Step 3: Execute failover via DGMGRL

\`\`\`
dgmgrl sys/password@EBSDR

DGMGRL> failover to EBSDR;
Performing failover NOW, please wait...
Failover succeeded, new primary is "EBSDR"
\`\`\`

If DGMGRL cannot communicate with the primary to confirm it is down, it may ask you to confirm the primary is offline:

\`\`\`
DGMGRL> failover to EBSDR immediate;
\`\`\`

\`immediate\` skips the primary availability check and forces the failover. Use only when you are certain the primary cannot recover.

### Post-failover validation

\`\`\`sql
-- On new primary
SELECT database_role, open_mode, db_unique_name FROM v\$database;
-- DATABASE_ROLE = PRIMARY

-- Check for any data loss by examining the last applied sequence
SELECT thread#, MAX(sequence#) AS last_applied
FROM   v\$log_history
GROUP BY thread#;

-- Compare with last sequence generated on former primary (from its alert log or v$log_history backup)
\`\`\`

---

## Re-Establishing Data Guard After Failover

After a failover the former primary is no longer part of the configuration. You have two options:

### Option A: Flashback and Reinstate (fastest, requires Flashback Database)

If the former primary has Flashback Database enabled and the flashback retention covers the point of failover:

\`\`\`sql
-- On former primary (mount it first)
STARTUP MOUNT;

-- Flash back to the SCN at which the new primary diverged
-- (get this SCN from v$restore_point or the broker's failover log)
FLASHBACK DATABASE TO SCN <failover_scn>;
\`\`\`

Then from DGMGRL on the new primary:

\`\`\`
DGMGRL> reinstate database EBSPROD;
\`\`\`

Broker flashes back the former primary to the correct point and starts redo apply automatically. This typically completes in minutes.

### Option B: RMAN Duplicate (full rebuild)

If Flashback Database is not available, rebuild the standby from a fresh backup of the new primary:

\`\`\`bash
# On standby host — duplicate from active database
rman target sys/password@EBSDR auxiliary sys/password@EBSPROD

RMAN> DUPLICATE TARGET DATABASE
      FOR STANDBY
      FROM ACTIVE DATABASE
      DORECOVER
      SPFILE
        SET 'db_unique_name'='EBSPROD'
        SET 'log_archive_dest_2'='service=EBSDR async valid_for=(online_logfiles,primary_role) db_unique_name=EBSDR'
      NOFILENAMECHECK;
\`\`\`

After the duplicate completes, add the reinstated standby back to the broker:

\`\`\`
DGMGRL> add database EBSPROD as connect identifier is EBSPROD maintained as physical;
DGMGRL> enable database EBSPROD;
DGMGRL> show configuration;
\`\`\`

---

## Fast-Start Failover (FSFO)

Fast-Start Failover automates the failover decision when an observer process detects that the primary is unavailable. FSFO is appropriate for environments where:
- An observer host is available (separate from both primary and standby)
- The protection mode is MaxAvailability or MaxProtection
- The acceptable data loss target (FastStartFailoverTarget) is defined

\`\`\`
DGMGRL> enable fast_start failover;
DGMGRL> start observer;
\`\`\`

With FSFO enabled, manual failover is still possible but switchover requires FSFO to be temporarily disabled or the observer to be involved.

For EBS environments, FSFO is typically not enabled because EBS applications require coordinated application tier restart after a role transition — an automated database failover without application tier awareness can leave the application in a split-brain state.

---

## Common Errors and Resolutions

**ORA-16467: switchover target is not synchronized**
The standby has a redo gap. Wait for the gap to close (\`apply lag = 0\`) before retrying switchover.

**ORA-16470: Redo Apply is not running on switchover target**
Start managed recovery on the standby: \`ALTER DATABASE RECOVER MANAGED STANDBY DATABASE DISCONNECT FROM SESSION;\`

**DGM-17016: failed to retrieve data from member**
Broker cannot connect to the target database. Check listener, tnsnames, and network connectivity between primary and standby hosts. Check that the broker password file exists on the standby.

**ORA-16826: apply service state is inconsistent with the DelayMins property**
Standby has a configured apply delay. Remove or set to 0 before switchover: \`DGMGRL> edit database EBSDR set property DelayMins=0;\`
`,
};

const runbookPost = {
  title: 'Runbook: Data Guard Switchover and Failover Execution Scripts',
  slug: 'dataguard-switchover-failover-runbook',
  excerpt:
    'Executable shell and DGMGRL scripts for Oracle Data Guard switchover and failover — pre-operation health checks, lag assessment, DGMGRL-driven role transition, post-operation validation, flashback reinstatement of the former primary, and configuration verification.',
  category: 'disaster-recovery' as const,
  published: true,
  publishedAt: new Date('2026-06-02'),
  isPremium: true,
  youtubeUrl: null,
  content: `This runbook accompanies the [Data Guard Switchover and Failover guide](/posts/dataguard-switchover-failover). It provides ready-to-run scripts for the full lifecycle: pre-check, role transition, post-validation, and reinstatement.

**Prerequisites:**
- Data Guard Broker configured and \`ENABLE_DG_BROKER=TRUE\` on both databases
- \`dgmgrl\` available on the DBA host
- TNS entries for both \`EBSPROD\` (primary) and \`EBSDR\` (standby)
- SYSDG or SYSDBA credentials
- For reinstatement via flashback: Flashback Database enabled on primary

Set environment variables once before running any script:

\`\`\`bash
export ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export PATH=$ORACLE_HOME/bin:$PATH
export DG_PRIMARY=EBSPROD
export DG_STANDBY=EBSDR
export DG_SYS_PASS=your_sys_password
\`\`\`

---

## Script 1: Pre-Operation Health Check

Run this before any switchover or failover. It checks broker status, apply lag, redo log counts, and archive gaps. Output is written to \`/tmp/dg_precheck_YYYYMMDD_HHMMSS.log\`.

### \`dg_precheck.sh\`

\`\`\`bash
#!/bin/bash
# dg_precheck.sh — Data Guard pre-operation health check
# Usage: ./dg_precheck.sh

LOGFILE="/tmp/dg_precheck_$(date +%Y%m%d_%H%M%S).log"
PASS=0; WARN=0; FAIL=0

log()  { echo "$1" | tee -a "$LOGFILE"; }
pass() { log "  [PASS] $1"; ((PASS++)); }
warn() { log "  [WARN] $1"; ((WARN++)); }
fail() { log "  [FAIL] $1"; ((FAIL++)); }
hr()   { log "$(printf '%.0s-' {1..70})"; }

hr; log "  Data Guard Pre-Operation Health Check"; log "  $(date)"; hr; log ""

# ── 1. Broker configuration status ─────────────────────────────────────────
log "[1] Broker Configuration Status"
DG_STATUS=$(dgmgrl -silent sys/"$DG_SYS_PASS"@"$DG_PRIMARY" \
  "show configuration" 2>&1)
log "$DG_STATUS"
log ""
if echo "$DG_STATUS" | grep -q "SUCCESS"; then
  pass "Broker configuration status is SUCCESS"
elif echo "$DG_STATUS" | grep -q "WARNING"; then
  warn "Broker configuration has WARNING — check lag and resolve before proceeding"
else
  fail "Broker configuration is not SUCCESS — resolve before any role transition"
fi
log ""

# ── 2. Apply and transport lag ─────────────────────────────────────────────
log "[2] Apply and Transport Lag"
sqlplus -S sys/"$DG_SYS_PASS"@"$DG_PRIMARY" as sysdba << 'EOF' | tee -a "$LOGFILE"
SET PAGESIZE 50 LINESIZE 120 FEEDBACK OFF
SELECT name, value, time_computed
FROM   v\$dataguard_stats
WHERE  name IN ('transport lag','apply lag','apply finish time')
ORDER BY name;
EXIT
EOF

APPLY_LAG=$(dgmgrl -silent sys/"$DG_SYS_PASS"@"$DG_PRIMARY" \
  "show database verbose $DG_STANDBY" 2>&1 | grep "Apply Lag" | awk '{print $NF}')
log ""
log "  Apply Lag: $APPLY_LAG"
if [ "$APPLY_LAG" = "+00:00:00.00" ] || [ "$APPLY_LAG" = "0 seconds" ] || [ -z "$APPLY_LAG" ]; then
  pass "Apply lag is zero"
else
  warn "Apply lag is $APPLY_LAG — wait for synchronisation before switchover"
fi
log ""

# ── 3. Standby redo log count ──────────────────────────────────────────────
log "[3] Standby Redo Log Configuration"
ONLINE_GROUPS=$(sqlplus -S sys/"$DG_SYS_PASS"@"$DG_PRIMARY" as sysdba << 'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT COUNT(*) FROM v\$log;
EXIT
EOF
)
SRL_GROUPS=$(sqlplus -S sys/"$DG_SYS_PASS"@"$DG_STANDBY" as sysdba << 'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT COUNT(*) FROM v\$standby_log;
EXIT
EOF
)
ONLINE_GROUPS=$(echo "$ONLINE_GROUPS" | tr -d ' ')
SRL_GROUPS=$(echo "$SRL_GROUPS" | tr -d ' ')
REQUIRED=$((ONLINE_GROUPS + 1))
log "  Online redo log groups (primary) : $ONLINE_GROUPS"
log "  Standby redo log groups          : $SRL_GROUPS"
log "  Required SRL groups              : >= $REQUIRED"
if [ "$SRL_GROUPS" -ge "$REQUIRED" ] 2>/dev/null; then
  pass "Standby redo log count is sufficient ($SRL_GROUPS >= $REQUIRED)"
else
  fail "Insufficient standby redo logs ($SRL_GROUPS < $REQUIRED) — switchover will fail"
fi
log ""

# ── 4. Archive log gap ─────────────────────────────────────────────────────
log "[4] Archive Log Gap"
sqlplus -S sys/"$DG_SYS_PASS"@"$DG_PRIMARY" as sysdba << 'EOF' | tee -a "$LOGFILE"
SET PAGESIZE 50 LINESIZE 120 FEEDBACK OFF
SELECT thread#,
       MAX(sequence#) AS last_primary_seq
FROM   v\$archived_log
WHERE  dest_id = 1
GROUP BY thread#
MINUS
SELECT thread#,
       MAX(sequence#) AS last_standby_seq
FROM   v\$archived_log
WHERE  dest_id = 2
AND    applied = 'YES'
GROUP BY thread#;
EXIT
EOF
log "(No rows = no gap)"
log ""

# ── 5. Long-running transactions ───────────────────────────────────────────
log "[5] Long-Running Active Transactions (> 30s)"
sqlplus -S sys/"$DG_SYS_PASS"@"$DG_PRIMARY" as sysdba << 'EOF' | tee -a "$LOGFILE"
SET PAGESIZE 50 LINESIZE 140 FEEDBACK OFF
SELECT sid, serial#, username,
       ROUND(elapsed_time/1000000,1) AS elapsed_secs,
       sql_id, status
FROM   v\$session
WHERE  status = 'ACTIVE'
AND    type   = 'USER'
AND    elapsed_time > 30000000
ORDER BY elapsed_time DESC
FETCH FIRST 10 ROWS ONLY;
EXIT
EOF
log ""

# ── 6. Database roles ──────────────────────────────────────────────────────
log "[6] Database Roles and Open Mode"
sqlplus -S sys/"$DG_SYS_PASS"@"$DG_PRIMARY" as sysdba << 'EOF' | tee -a "$LOGFILE"
SET PAGESIZE 10 LINESIZE 100 FEEDBACK OFF
SELECT db_unique_name, database_role, open_mode, protection_mode
FROM   v\$database;
EXIT
EOF
sqlplus -S sys/"$DG_SYS_PASS"@"$DG_STANDBY" as sysdba << 'EOF' | tee -a "$LOGFILE"
SET PAGESIZE 10 LINESIZE 100 FEEDBACK OFF
SELECT db_unique_name, database_role, open_mode, protection_mode
FROM   v\$database;
EXIT
EOF
log ""

# ── Summary ────────────────────────────────────────────────────────────────
hr
log "  Pre-Check Summary"
hr
log "  PASS : $PASS"
log "  WARN : $WARN"
log "  FAIL : $FAIL"
if [ "$FAIL" -gt 0 ]; then
  log ""
  log "  !! FAILED CHECKS MUST BE RESOLVED BEFORE PROCEEDING !!"
elif [ "$WARN" -gt 0 ]; then
  log ""
  log "  Warnings present — review before proceeding with role transition."
else
  log ""
  log "  All checks passed — safe to proceed."
fi
hr
log "  Report: $LOGFILE"
hr
\`\`\`

---

## Script 2: Switchover

Run this only after the pre-check reports zero failures and the apply lag is zero (or has been confirmed acceptable).

### \`dg_switchover.sh\`

\`\`\`bash
#!/bin/bash
# dg_switchover.sh — Planned Data Guard switchover
# Switches $DG_PRIMARY -> standby and $DG_STANDBY -> new primary
# Usage: ./dg_switchover.sh

LOGFILE="/tmp/dg_switchover_$(date +%Y%m%d_%H%M%S).log"
log() { echo "[$(date +%H:%M:%S)] $1" | tee -a "$LOGFILE"; }

log "================================================"
log "  Data Guard Switchover"
log "  Primary : $DG_PRIMARY  ->  Standby"
log "  Standby : $DG_STANDBY  ->  New Primary"
log "================================================"
log ""

# ── Confirm ────────────────────────────────────────────────────────────────
read -p "Proceed with switchover to $DG_STANDBY? [yes/NO]: " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  log "Switchover cancelled."
  exit 0
fi
log ""

# ── Execute switchover ─────────────────────────────────────────────────────
log "Executing switchover to $DG_STANDBY via DGMGRL..."
dgmgrl sys/"$DG_SYS_PASS"@"$DG_PRIMARY" << EOF | tee -a "$LOGFILE"
show configuration;
switchover to $DG_STANDBY;
show configuration;
show database $DG_STANDBY;
show database $DG_PRIMARY;
exit
EOF

RC=\${PIPESTATUS[0]}
log ""
if [ $RC -eq 0 ]; then
  log "DGMGRL switchover command completed (RC=$RC)."
else
  log "DGMGRL returned non-zero exit code ($RC) — review output above."
fi

# ── Validate new primary ───────────────────────────────────────────────────
log ""
log "Validating new primary ($DG_STANDBY)..."
sqlplus -S sys/"$DG_SYS_PASS"@"$DG_STANDBY" as sysdba << 'EOF' | tee -a "$LOGFILE"
SET PAGESIZE 10 LINESIZE 100 FEEDBACK OFF
SELECT db_unique_name,
       database_role,
       open_mode,
       switchover_status
FROM   v\$database;
EXIT
EOF

# ── Validate former primary (now standby) ─────────────────────────────────
log ""
log "Validating former primary ($DG_PRIMARY — now standby)..."
sqlplus -S sys/"$DG_SYS_PASS"@"$DG_PRIMARY" as sysdba << 'EOF' | tee -a "$LOGFILE"
SET PAGESIZE 10 LINESIZE 100 FEEDBACK OFF
SELECT db_unique_name,
       database_role,
       open_mode,
       switchover_status
FROM   v\$database;
EXIT
EOF

log ""
log "Switchover log: $LOGFILE"
log "Run dg_validate.sh to confirm full configuration health."
\`\`\`

---

## Script 3: Failover

Use only when the primary is confirmed down and unrecoverable within the required RTO. Read the output carefully — the script pauses before the irreversible step.

### \`dg_failover.sh\`

\`\`\`bash
#!/bin/bash
# dg_failover.sh — Emergency Data Guard failover
# Activates $DG_STANDBY as the new primary.
# Usage: ./dg_failover.sh [--immediate]
# --immediate skips primary availability check (use only if primary is confirmed dead)

LOGFILE="/tmp/dg_failover_$(date +%Y%m%d_%H%M%S).log"
IMMEDIATE_FLAG=""
[ "$1" = "--immediate" ] && IMMEDIATE_FLAG="immediate"

log() { echo "[$(date +%H:%M:%S)] $1" | tee -a "$LOGFILE"; }

log "================================================"
log "  !! DATA GUARD FAILOVER !!"
log "  New primary will be: $DG_STANDBY"
log "  Former primary ($DG_PRIMARY) requires reinstatement afterward"
log "  Immediate flag: \${IMMEDIATE_FLAG:-false}"
log "================================================"
log ""

# ── Measure current lag ────────────────────────────────────────────────────
log "Measuring apply lag on standby ($DG_STANDBY)..."
sqlplus -S sys/"$DG_SYS_PASS"@"$DG_STANDBY" as sysdba << 'EOF' | tee -a "$LOGFILE"
SET PAGESIZE 20 LINESIZE 120 FEEDBACK OFF
SELECT name, value, time_computed
FROM   v\$dataguard_stats
WHERE  name IN ('transport lag','apply lag','apply finish time')
ORDER BY name;
EXIT
EOF
log ""

# ── Offer to wait for full apply ───────────────────────────────────────────
read -p "Wait for all received redo to be applied before failover? [yes/NO]: " WAIT_APPLY
if [ "$WAIT_APPLY" = "yes" ]; then
  log "Waiting for standby apply to complete..."
  sqlplus -S sys/"$DG_SYS_PASS"@"$DG_STANDBY" as sysdba << 'EOF' | tee -a "$LOGFILE"
SET FEEDBACK OFF
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE WAIT;
EXIT
EOF
  log "Apply complete."
fi
log ""

# ── Final confirmation ─────────────────────────────────────────────────────
echo "================================================"
echo "  IRREVERSIBLE OPERATION"
echo "  This will activate $DG_STANDBY as the new primary."
echo "  The former primary ($DG_PRIMARY) must be reinstated afterward."
echo "================================================"
read -p "Type FAILOVER to confirm: " CONFIRM
if [ "$CONFIRM" != "FAILOVER" ]; then
  log "Failover cancelled."
  exit 0
fi
log ""

# ── Execute failover ───────────────────────────────────────────────────────
log "Executing failover to $DG_STANDBY..."
if [ -n "$IMMEDIATE_FLAG" ]; then
  log "(Using immediate flag — bypassing primary availability check)"
  FAILOVER_CMD="failover to $DG_STANDBY immediate;"
else
  FAILOVER_CMD="failover to $DG_STANDBY;"
fi

dgmgrl sys/"$DG_SYS_PASS"@"$DG_STANDBY" << EOF | tee -a "$LOGFILE"
$FAILOVER_CMD
show configuration;
show database $DG_STANDBY;
exit
EOF

log ""

# ── Validate new primary ───────────────────────────────────────────────────
log "Validating new primary ($DG_STANDBY)..."
sqlplus -S sys/"$DG_SYS_PASS"@"$DG_STANDBY" as sysdba << 'EOF' | tee -a "$LOGFILE"
SET PAGESIZE 10 LINESIZE 100 FEEDBACK OFF
SELECT db_unique_name,
       database_role,
       open_mode,
       resetlogs_time
FROM   v\$database;

SELECT thread#, MAX(sequence#) AS last_applied_sequence
FROM   v\$log_history
GROUP BY thread#;
EXIT
EOF

log ""
log "Failover log: $LOGFILE"
log ""
log "NEXT STEPS:"
log "  1. Redirect application connection strings to $DG_STANDBY"
log "  2. Run dg_reinstate.sh when $DG_PRIMARY is available again"
log "  3. Run dg_validate.sh after reinstatement"
\`\`\`

---

## Script 4: Reinstate Former Primary After Failover

After a failover, reinstate the former primary as a standby using flashback (fast) or RMAN duplicate (full rebuild).

### \`dg_reinstate.sh\`

\`\`\`bash
#!/bin/bash
# dg_reinstate.sh — Reinstate former primary as standby after failover
# Attempts flashback reinstatement first; falls back to RMAN duplicate if unavailable.
# Usage: ./dg_reinstate.sh

LOGFILE="/tmp/dg_reinstate_$(date +%Y%m%d_%H%M%S).log"
log() { echo "[$(date +%H:%M:%S)] $1" | tee -a "$LOGFILE"; }

# Current new primary (former standby)
NEW_PRIMARY=$DG_STANDBY
# Database to reinstate (former primary, now offline)
REINSTATE_DB=$DG_PRIMARY
REINSTATE_HOST="former-primary-host"     # SSH hostname
REINSTATE_ORACLE_HOME="/u01/app/oracle/product/19.0.0/dbhome_1"
DOMAIN_HOME="/u01/app/oracle/middleware/user_projects/domains/EBS_domain"

log "================================================"
log "  Data Guard Reinstatement"
log "  Reinstating : $REINSTATE_DB"
log "  New primary : $NEW_PRIMARY"
log "================================================"
log ""

# ── Step 1: Check flashback availability on former primary ─────────────────
log "[1] Checking Flashback Database on $REINSTATE_DB..."
FB_STATUS=$(sqlplus -S sys/"$DG_SYS_PASS"@"$REINSTATE_DB" as sysdba << 'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT flashback_on FROM v\$database;
EXIT
EOF
)
FB_STATUS=$(echo "$FB_STATUS" | tr -d ' \n')
log "  Flashback Database: $FB_STATUS"
log ""

if [ "$FB_STATUS" = "YES" ]; then
  log "[2] Flashback reinstatement path available."
  log "    Attempting broker reinstate..."
  log ""

  dgmgrl sys/"$DG_SYS_PASS"@"$NEW_PRIMARY" << EOF | tee -a "$LOGFILE"
show configuration;
reinstate database $REINSTATE_DB;
show configuration;
show database $REINSTATE_DB;
exit
EOF

  RC=$?
  log ""
  if [ $RC -eq 0 ] && dgmgrl -silent sys/"$DG_SYS_PASS"@"$NEW_PRIMARY" \
    "show database $REINSTATE_DB" 2>&1 | grep -q "SUCCESS\|Apply"; then
    log "Flashback reinstatement succeeded."
  else
    log "Flashback reinstatement failed or database not applying redo."
    log "Falling through to RMAN duplicate..."
    FB_STATUS="NO"
  fi
fi

if [ "$FB_STATUS" != "YES" ]; then
  log "[2] Performing RMAN active duplicate to rebuild $REINSTATE_DB as standby..."
  log ""

  # Shut down and mount the former primary
  ssh oracle@"$REINSTATE_HOST" "
    export ORACLE_HOME=$REINSTATE_ORACLE_HOME
    export PATH=\$ORACLE_HOME/bin:\$PATH
    export ORACLE_SID=\${REINSTATE_DB}1
    sqlplus -S sys/$DG_SYS_PASS as sysdba <<SQL
SHUTDOWN ABORT;
STARTUP NOMOUNT;
EXIT
SQL
  " 2>&1 | tee -a "$LOGFILE"

  log ""
  log "Running RMAN active duplicate from $NEW_PRIMARY to $REINSTATE_DB..."
  log "(This will take time proportional to database size)"
  log ""

  rman target sys/"$DG_SYS_PASS"@"$NEW_PRIMARY" \
       auxiliary sys/"$DG_SYS_PASS"@"$REINSTATE_DB" << EOF | tee -a "$LOGFILE"
RUN {
  ALLOCATE CHANNEL c1 TYPE DISK;
  ALLOCATE AUXILIARY CHANNEL a1 TYPE DISK;
  DUPLICATE TARGET DATABASE
    FOR STANDBY
    FROM ACTIVE DATABASE
    DORECOVER
    SPFILE
      SET 'db_unique_name'='$REINSTATE_DB'
      SET 'log_archive_dest_2'='service=$NEW_PRIMARY async valid_for=(online_logfiles,primary_role) db_unique_name=$NEW_PRIMARY'
      SET 'fal_server'='$NEW_PRIMARY'
      SET 'fal_client'='$REINSTATE_DB'
    NOFILENAMECHECK;
}
EXIT
EOF

  log ""
  log "RMAN duplicate complete. Adding $REINSTATE_DB back to broker configuration..."
  dgmgrl sys/"$DG_SYS_PASS"@"$NEW_PRIMARY" << EOF | tee -a "$LOGFILE"
add database $REINSTATE_DB as connect identifier is $REINSTATE_DB maintained as physical;
enable database $REINSTATE_DB;
show configuration;
exit
EOF
fi

log ""
log "Reinstatement log: $LOGFILE"
log "Run dg_validate.sh to confirm full configuration health."
\`\`\`

---

## Script 5: Post-Operation Validation

Run this after any switchover, failover, or reinstatement.

### \`dg_validate.sh\`

\`\`\`bash
#!/bin/bash
# dg_validate.sh — Data Guard post-operation validation
# Usage: ./dg_validate.sh [primary_db_name]
# If primary_db_name is provided, validates that database as primary.

LOGFILE="/tmp/dg_validate_$(date +%Y%m%d_%H%M%S).log"
EXPECTED_PRIMARY="\${1:-$DG_STANDBY}"   # default: DG_STANDBY (post-switchover/failover)
PASS=0; FAIL=0

log()  { echo "[$(date +%H:%M:%S)] $1" | tee -a "$LOGFILE"; }
pass() { log "  [PASS] $1"; ((PASS++)); }
fail() { log "  [FAIL] $1"; ((FAIL++)); }
hr()   { log "$(printf '%.0s-' {1..70})"; }

hr; log "  Data Guard Post-Operation Validation"; log "  $(date)"; hr; log ""
log "  Expected primary: $EXPECTED_PRIMARY"
log ""

# ── Broker configuration ───────────────────────────────────────────────────
log "[1] Broker Configuration"
DG_OUT=$(dgmgrl sys/"$DG_SYS_PASS"@"$EXPECTED_PRIMARY" "show configuration" 2>&1)
log "$DG_OUT"
log ""
echo "$DG_OUT" | grep -q "SUCCESS" \
  && pass "Broker configuration status SUCCESS" \
  || fail "Broker configuration is not SUCCESS"

# ── New primary role ───────────────────────────────────────────────────────
log "[2] New Primary Database Role"
ROLE=$(sqlplus -S sys/"$DG_SYS_PASS"@"$EXPECTED_PRIMARY" as sysdba << 'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT database_role FROM v\$database;
EXIT
EOF
)
ROLE=$(echo "$ROLE" | tr -d ' \n')
log "  $EXPECTED_PRIMARY role: $ROLE"
[ "$ROLE" = "PRIMARY" ] \
  && pass "$EXPECTED_PRIMARY is PRIMARY" \
  || fail "$EXPECTED_PRIMARY role is $ROLE (expected PRIMARY)"

# ── New primary open mode ──────────────────────────────────────────────────
OPEN=$(sqlplus -S sys/"$DG_SYS_PASS"@"$EXPECTED_PRIMARY" as sysdba << 'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT open_mode FROM v\$database;
EXIT
EOF
)
OPEN=$(echo "$OPEN" | tr -d ' \n')
log "  $EXPECTED_PRIMARY open mode: $OPEN"
[ "$OPEN" = "READWRITE" ] \
  && pass "$EXPECTED_PRIMARY is open READ WRITE" \
  || fail "$EXPECTED_PRIMARY open mode is $OPEN (expected READ WRITE)"

# ── Redo apply on standby ──────────────────────────────────────────────────
log ""
log "[3] Standby Apply State"
APPLY_STATE=$(dgmgrl -silent sys/"$DG_SYS_PASS"@"$EXPECTED_PRIMARY" \
  "show database verbose $DG_PRIMARY" 2>&1 | grep -E "Apply State|Apply Lag")
log "$APPLY_STATE"
echo "$APPLY_STATE" | grep -q "Applying" \
  && pass "Standby redo apply is running" \
  || fail "Standby redo apply is NOT running — check managed recovery"

# ── Apply lag ─────────────────────────────────────────────────────────────
log ""
log "[4] Apply Lag (allow up to 60 seconds post-operation)"
sqlplus -S sys/"$DG_SYS_PASS"@"$EXPECTED_PRIMARY" as sysdba << 'EOF' | tee -a "$LOGFILE"
SET PAGESIZE 20 LINESIZE 120 FEEDBACK OFF
SELECT name, value FROM v\$dataguard_stats
WHERE  name IN ('apply lag','transport lag')
ORDER BY name;
EXIT
EOF
log ""

# ── No stuck archive gaps ──────────────────────────────────────────────────
log "[5] Archive Log Gap Check"
GAP=$(sqlplus -S sys/"$DG_SYS_PASS"@"$EXPECTED_PRIMARY" as sysdba << 'EOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT COUNT(*) FROM v\$archive_gap;
EXIT
EOF
)
GAP=$(echo "$GAP" | tr -d ' \n')
log "  Archive gaps: $GAP"
[ "$GAP" = "0" ] \
  && pass "No archive log gaps" \
  || fail "$GAP archive log gap(s) detected — check v\$archive_gap and resolve"

# ── Summary ────────────────────────────────────────────────────────────────
log ""; hr
log "  Validation Summary"
hr
log "  PASS : $PASS"
log "  FAIL : $FAIL"
if [ "$FAIL" -eq 0 ]; then
  log "  STATUS: ALL CHECKS PASSED — Data Guard configuration is healthy."
else
  log "  STATUS: $FAIL CHECK(S) FAILED — review output above before resuming operations."
fi
hr
log "  Report: $LOGFILE"
hr
\`\`\`

---

## Quick Reference: Run Order

\`\`\`bash
chmod +x dg_precheck.sh dg_switchover.sh dg_failover.sh dg_reinstate.sh dg_validate.sh

# Set environment
export ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export PATH=$ORACLE_HOME/bin:$PATH
export DG_PRIMARY=EBSPROD
export DG_STANDBY=EBSDR
export DG_SYS_PASS=your_sys_password

# ── Planned switchover ─────────────────────────────────────────────────────
./dg_precheck.sh          # review report — must show zero FAIL
./dg_switchover.sh        # executes switchover, validates afterward
./dg_validate.sh          # confirms full configuration health

# ── Emergency failover ─────────────────────────────────────────────────────
./dg_failover.sh          # waits for apply, prompts FAILOVER confirmation
# -- or, if primary is confirmed dead and time is critical --
./dg_failover.sh --immediate
# Reinstate former primary when it is available again:
./dg_reinstate.sh
./dg_validate.sh
\`\`\`
`,
};

async function main() {
  await db.insert(posts).values(blogPost).onConflictDoUpdate({
    target: posts.slug,
    set: {
      title: blogPost.title,
      excerpt: blogPost.excerpt,
      content: blogPost.content,
      published: blogPost.published,
      publishedAt: blogPost.publishedAt,
      isPremium: blogPost.isPremium,
    },
  });
  console.log('inserted:', blogPost.slug);

  await db.insert(posts).values(runbookPost).onConflictDoUpdate({
    target: posts.slug,
    set: {
      title: runbookPost.title,
      excerpt: runbookPost.excerpt,
      content: runbookPost.content,
      published: runbookPost.published,
      publishedAt: runbookPost.publishedAt,
      isPremium: runbookPost.isPremium,
    },
  });
  console.log('inserted:', runbookPost.slug);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
