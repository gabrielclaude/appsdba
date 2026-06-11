import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'EBS 12.2 on 19c CDB: SYSTEM and EBS_SYSTEM Password Rotation Runbook',
  slug: 'oracle-ebs-system-ebs-system-password-rotation-19c-cdb-runbook',
  excerpt:
    'Complete runbook for safely rotating SYSTEM and EBS_SYSTEM passwords in Oracle EBS 12.2 running on Oracle Database 19c CDB: pre-change verification, CONTAINER=ALL procedure, context file update, AutoConfig re-run, adop cycle validation, and a monitoring script that continuously detects password drift and account lock state across all CDB containers.',
  category: 'appsdba' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `## Scope

This runbook applies to Oracle EBS R12.2.x environments running on Oracle Database 19c with Multitenant Container Database (CDB) architecture. It covers the complete procedure for rotating \`SYSTEM\` and \`EBS_SYSTEM\` passwords, updating all EBS configuration artifacts, and validating that Online Patching continues to function after the change.

**Prerequisites:**
- Oracle Database 19c with CDB architecture (non-CDB 19c does not require \`CONTAINER=ALL\`)
- SYSDBA access on the database
- \`applmgr\` OS access on the EBS application tier
- Change management window — adop cannot be in progress during the rotation

---

## Phase 1: Pre-Change Assessment

### 1.1 Confirm the database is CDB

\`\`\`sql
sqlplus / as sysdba

SELECT cdb, con_id, name FROM v\$database;
-- CDB = YES confirms CDB architecture
-- Proceed with CONTAINER=ALL for all password changes

SHOW CON_NAME;
-- Must show CDB\$ROOT before making any changes
\`\`\`

### 1.2 Baseline account status across all containers

\`\`\`sql
SELECT c.name          AS container_name,
       u.username,
       u.account_status,
       u.lock_date,
       u.expiry_date,
       u.password_versions,
       u.profile
FROM   cdb_users   u
JOIN   v\$containers c ON c.con_id = u.con_id
WHERE  u.username IN ('SYSTEM','EBS_SYSTEM')
ORDER BY c.con_id, u.username;
\`\`\`

Record the output. Note any containers where status is not \`OPEN\`.

### 1.3 Confirm no adop session is active

\`\`\`bash
# As applmgr — check adop status
adop -status

# Also check from SQL
sqlplus apps/<APPS_PWD>@<DBSID> <<'EOF'
SELECT ad_patch_driver_id,
       patch_driver_status,
       start_date,
       end_date
FROM   ad_adop_sessions
WHERE  adop_session_status NOT IN ('C','F')  -- Not Complete, not Finalized
  AND  start_date > SYSDATE - 7;
EXIT;
EOF
\`\`\`

If any active adop session exists, complete or abort it before proceeding.

### 1.4 Check applied patches (required for separate passwords)

\`\`\`sql
-- Check if the patches that allow separate SYSTEM/EBS_SYSTEM passwords are applied
SELECT patch_name,
       patch_type,
       end_date
FROM   ad_applied_patches
WHERE  patch_name IN ('32573930','31817501')
ORDER BY end_date DESC;
\`\`\`

| Patch Applied | Implication |
|---------------|------------|
| Neither patch | Passwords **must** be identical |
| Both patches | Passwords *may* differ — but validate with full adop cycle |

---

## Phase 2: Password Change Procedure

### 2.1 Connect as SYSDBA and confirm root container

\`\`\`sql
sqlplus / as sysdba

SHOW CON_NAME;
-- Must be CDB\$ROOT

-- If in a PDB, switch to root first:
-- ALTER SESSION SET CONTAINER = CDB\$ROOT;
\`\`\`

### 2.2 Change both passwords with CONTAINER=ALL

\`\`\`sql
-- !!!  CHANGE BOTH IN THE SAME SESSION  !!!
-- Alphanumeric only — no $, @, !, %, (, ), &, #, or space
ALTER USER SYSTEM     IDENTIFIED BY <NewPassword> CONTAINER=ALL;
ALTER USER EBS_SYSTEM IDENTIFIED BY <NewPassword> CONTAINER=ALL;
\`\`\`

### 2.3 Unlock accounts if LOCKED after rotation

\`\`\`sql
-- Check for locks introduced by the change
SELECT c.name, u.username, u.account_status
FROM   cdb_users u
JOIN   v\$containers c ON c.con_id = u.con_id
WHERE  u.username IN ('SYSTEM','EBS_SYSTEM')
  AND  u.account_status != 'OPEN';

-- Unlock any LOCKED accounts
ALTER USER EBS_SYSTEM ACCOUNT UNLOCK CONTAINER=ALL;
ALTER USER SYSTEM     ACCOUNT UNLOCK CONTAINER=ALL;
\`\`\`

### 2.4 Post-change verification

\`\`\`sql
-- All rows must show OPEN status in all containers
SELECT c.name      AS container_name,
       u.username,
       u.account_status,
       u.expiry_date
FROM   cdb_users   u
JOIN   v\$containers c ON c.con_id = u.con_id
WHERE  u.username IN ('SYSTEM','EBS_SYSTEM')
ORDER BY c.con_id, u.username;
\`\`\`

### 2.5 Confirm passwords match across containers (hash comparison)

\`\`\`sql
-- Compare password hashes — all containers should show the same hash per user
SELECT c.name      AS container_name,
       u.username,
       u.spare4    AS password_hash  -- 12C verifier hash
FROM   cdb_users   u
JOIN   v\$containers c ON c.con_id = u.con_id
WHERE  u.username IN ('SYSTEM','EBS_SYSTEM')
ORDER BY u.username, c.con_id;
-- Within the same username, all hash values must match across containers
\`\`\`

---

## Phase 3: Update EBS Context File and Configuration

### 3.1 Update the context file (s_system_password)

The EBS context file (e.g., \`\$CONTEXT_FILE\`) stores the SYSTEM password in encrypted form. After a password change, the context file must be updated before running AutoConfig.

\`\`\`bash
# As applmgr — identify the context file location
echo \$CONTEXT_FILE
# e.g., /u01/prod/fs1/inst/apps/PROD_hostname/appl/admin/PROD_hostname.xml

# Update the system password in the context file
# Use the txkCfgUtlCleanup utility or adchkutl.sh depending on patch level

# Method 1: via txkCfgUtlCleanup.pl (EBS R12.2.4+)
perl $AD_TOP/bin/txkCfgUtlCleanup.pl \
  -contextfile=$CONTEXT_FILE \
  -configoption=setkeystorepasswd \
  apps/<APPS_PWD> <NewPassword>

# Method 2: via adupdlib.sh (older utility)
$AD_TOP/bin/adupdlib.sh <APPS_PWD> SYSTEM <NewPassword>
\`\`\`

### 3.2 Verify context file update

\`\`\`bash
# Confirm the s_system_password node is updated (value will be encrypted)
grep -i 's_system_password' $CONTEXT_FILE
# Should show a non-empty encrypted value (not the old plaintext)
\`\`\`

### 3.3 Run AutoConfig to propagate the change

\`\`\`bash
# Run AutoConfig on the application tier
cd $ADMIN_SCRIPTS_HOME
perl autoconfig.pl $CONTEXT_FILE

# Expected: AutoConfig completed successfully.
# Watch for any ORA-01017 errors in the AutoConfig log — these indicate
# the context file was not updated correctly before running AutoConfig.
\`\`\`

### 3.4 Run AutoConfig on the database tier

\`\`\`bash
# Log in to the database server as oracle
cd $ORACLE_HOME/appsutil/scripts/PROD_hostname
perl adconfig.pl contextfile=$ORACLE_HOME/appsutil/PROD_hostname.xml
\`\`\`

---

## Phase 4: Validate Online Patching (adop) After Password Change

This is the mandatory acceptance test. Do not declare the password rotation complete until adop clears all phases without authentication errors.

### 4.1 Prepare phase

\`\`\`bash
adop phase=prepare

# If prepare fails with ORA-01017:
# - The context file was not updated (repeat Phase 3)
# - The CONTAINER=ALL change did not reach all PDBs (re-run Phase 2)
\`\`\`

### 4.2 Apply a low-risk patch (or dummy patch)

\`\`\`bash
# Apply a previously-applied patch (re-apply is safe for validation)
# Or a known-small utility patch from Oracle Support
adop phase=apply patches=<PATCH_NUMBER> apply_mode=downtime

# Monitor the adop log for any SYSTEM or EBS_SYSTEM authentication failures
tail -f $APPL_TOP_NE/admin/log/adop*.log | grep -i 'ORA-\|error\|EBS_SYSTEM\|SYSTEM'
\`\`\`

### 4.3 Complete the adop cycle

\`\`\`bash
adop phase=finalize
adop phase=cutover
adop phase=cleanup
\`\`\`

All five phases must complete without ORA-01017, ORA-28000 (account locked), or authentication-related errors.

---

## Phase 5: Monitoring Script

Save as \`/usr/local/bin/ebs_system_pwd_monitor.sh\`. Schedule after every maintenance window and as a weekly health check. The script detects password drift between SYSTEM and EBS_SYSTEM, locked accounts, and expiring passwords across all CDB containers.

\`\`\`bash
#!/bin/bash
# ebs_system_pwd_monitor.sh
# Monitors SYSTEM and EBS_SYSTEM password synchronization across all CDB containers
# Detects: password hash drift, account locks, upcoming expiry, non-CDB OPEN status
#
# Usage:  ./ebs_system_pwd_monitor.sh [ORACLE_SID]
# Cron:   0 7 * * 1 /usr/local/bin/ebs_system_pwd_monitor.sh EBSPRD

ORACLE_SID="\${1:-EBSPRD}"
export ORACLE_SID
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
ALERT_LOG="/var/log/ebs_system_pwd_monitor_alerts.log"
EXPIRY_WARN_DAYS=30
FAILURES=0

log()   { echo "[$TIMESTAMP] $*"; }
alert() { echo "[$TIMESTAMP] ALERT: $*" | tee -a "$ALERT_LOG"; FAILURES=$((FAILURES + 1)); }

log "=== EBS SYSTEM/EBS_SYSTEM Password Monitor (SID: \$ORACLE_SID) ==="

source /home/oracle/.bash_profile 2>/dev/null || true
export ORACLE_HOME="\${ORACLE_HOME:-/u01/app/oracle/product/19.0.0/dbhome_1}"
export PATH="\$ORACLE_HOME/bin:\$PATH"
SQLPLUS="\$ORACLE_HOME/bin/sqlplus -s / as sysdba"

# -----------------------------------------------------------------------
# CHECK 1: Confirm CDB architecture
# -----------------------------------------------------------------------
log "Confirming CDB architecture..."

IS_CDB=\$(\$SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT cdb FROM v\$database;
EXIT;
SQLEOF
)
IS_CDB=$(echo "\$IS_CDB" | tr -d '[:space:]')

if [[ "\$IS_CDB" != "YES" ]]; then
  log "Non-CDB architecture detected — password synchronization check not applicable."
  log "All checks skipped. Exiting."
  exit 0
fi
log "CDB architecture confirmed. OK."

# -----------------------------------------------------------------------
# CHECK 2: Account status — must be OPEN in all containers
# -----------------------------------------------------------------------
log "Checking account status across all containers..."

LOCKED_ACCOUNTS=\$(\$SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT c.name || ':' || u.username || ':' || u.account_status
FROM   cdb_users   u
JOIN   v\$containers c ON c.con_id = u.con_id
WHERE  u.username IN ('SYSTEM','EBS_SYSTEM')
  AND  u.account_status != 'OPEN'
ORDER BY c.con_id, u.username;
EXIT;
SQLEOF
)

if [[ -n "\$LOCKED_ACCOUNTS" ]]; then
  while IFS= read -r line; do
    [[ -z "\$line" ]] && continue
    CONTAINER=$(echo "\$line" | cut -d: -f1)
    USER=$(echo "\$line" | cut -d: -f2)
    STATUS=$(echo "\$line" | cut -d: -f3)
    alert "\$USER in \$CONTAINER has status '\$STATUS' (not OPEN) — adop will fail"
  done <<< "\$LOCKED_ACCOUNTS"
else
  log "All SYSTEM/EBS_SYSTEM accounts: OPEN in all containers. OK."
fi

# -----------------------------------------------------------------------
# CHECK 3: Password hash drift — SYSTEM vs EBS_SYSTEM must match
# -----------------------------------------------------------------------
log "Checking for password hash drift between SYSTEM and EBS_SYSTEM..."

# Get distinct hash values per user across all containers
HASH_CHECK=\$(\$SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT username || ':' || COUNT(DISTINCT spare4) AS hash_count
FROM   cdb_users
WHERE  username IN ('SYSTEM','EBS_SYSTEM')
GROUP BY username;
EXIT;
SQLEOF
)

# Each username should have exactly 1 distinct hash (same across all containers)
while IFS= read -r line; do
  [[ -z "\$line" ]] && continue
  USERNAME=$(echo "\$line" | cut -d: -f1)
  HASH_COUNT=$(echo "\$line" | cut -d: -f2 | tr -d '[:space:]')
  if [[ "\$HASH_COUNT" -gt 1 ]]; then
    alert "\$USERNAME has \$HASH_COUNT different password hashes across containers — CONTAINER=ALL was not used during last rotation"
  else
    log "\$USERNAME: password hash consistent across all containers. OK."
  fi
done <<< "\$HASH_CHECK"

# Compare SYSTEM hash against EBS_SYSTEM hash (they must match when patches not applied)
CROSS_HASH=\$(\$SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT COUNT(DISTINCT spare4) AS distinct_hashes
FROM   cdb_users
WHERE  username IN ('SYSTEM','EBS_SYSTEM')
  AND  con_id    = 1;  -- CDB\$ROOT check only
EXIT;
SQLEOF
)
CROSS_HASH=$(echo "\$CROSS_HASH" | tr -d '[:space:]')

if [[ "\$CROSS_HASH" -gt 1 ]]; then
  # Check if patches that allow separate passwords are applied
  PATCH_CHECK=\$(\$SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT COUNT(*) FROM dba_registry_history
WHERE action_time IS NOT NULL
  AND (bundle_series LIKE '%32573930%' OR comments LIKE '%32573930%');
EXIT;
SQLEOF
  )
  PATCH_CHECK=$(echo "\$PATCH_CHECK" | tr -d '[:space:]')
  if [[ "\$PATCH_CHECK" -eq 0 ]]; then
    alert "SYSTEM and EBS_SYSTEM have DIFFERENT password hashes in CDB\$ROOT and patches 32573930/31817501 are NOT confirmed applied — adop WILL fail"
  else
    log "SYSTEM and EBS_SYSTEM hashes differ — separate-password patches appear applied. Monitor adop carefully."
  fi
else
  log "SYSTEM and EBS_SYSTEM: identical password hashes. OK."
fi

# -----------------------------------------------------------------------
# CHECK 4: Password expiry — warn before lock-out
# -----------------------------------------------------------------------
log "Checking password expiry dates..."

\$SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT c.name || ':' || u.username || ':' || u.account_status ||
       ':expiry=' || TO_CHAR(u.expiry_date,'YYYY-MM-DD')
FROM   cdb_users   u
JOIN   v\$containers c ON c.con_id = u.con_id
WHERE  u.username IN ('SYSTEM','EBS_SYSTEM')
  AND  u.expiry_date IS NOT NULL
  AND  u.expiry_date < SYSDATE + 30
ORDER BY u.expiry_date;
EXIT;
SQLEOF
| while IFS= read -r line; do
  [[ -z "\$line" ]] && continue
  CONTAINER=$(echo "\$line" | cut -d: -f1)
  USER=$(echo "\$line" | cut -d: -f2)
  EXPIRY=$(echo "\$line" | grep -o 'expiry=[0-9-]*' | cut -d= -f2)
  alert "\$USER in \$CONTAINER expires on \$EXPIRY — password rotation required within 30 days"
done

# -----------------------------------------------------------------------
# CHECK 5: Container count consistency
# -----------------------------------------------------------------------
log "Checking both users exist in all open containers..."

CONTAINER_COUNT=\$(\$SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT COUNT(*) FROM v\$containers WHERE open_mode = 'READ WRITE';
EXIT;
SQLEOF
)
CONTAINER_COUNT=$(echo "\$CONTAINER_COUNT" | tr -d '[:space:]')

USER_COUNTS=\$(\$SQLPLUS <<'SQLEOF'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 TRIMSPOOL ON
SELECT username || ':' || COUNT(*) AS user_container_count
FROM   cdb_users
WHERE  username IN ('SYSTEM','EBS_SYSTEM')
GROUP BY username;
EXIT;
SQLEOF
)

while IFS= read -r line; do
  [[ -z "\$line" ]] && continue
  USERNAME=$(echo "\$line" | cut -d: -f1)
  COUNT=$(echo "\$line" | cut -d: -f2 | tr -d '[:space:]')
  if [[ "\$COUNT" -lt "\$CONTAINER_COUNT" ]]; then
    alert "\$USERNAME found in \$COUNT container(s) but there are \$CONTAINER_COUNT open containers — user may be missing from a PDB"
  else
    log "\$USERNAME: present in all \$COUNT container(s). OK."
  fi
done <<< "\$USER_COUNTS"

# -----------------------------------------------------------------------
# CHECK 6: Context file password alignment (app tier check)
# -----------------------------------------------------------------------
log "Checking EBS context file for SYSTEM password entry..."

if [[ -n "\$CONTEXT_FILE" && -f "\$CONTEXT_FILE" ]]; then
  SYSTEM_PWD_IN_CTX=$(grep -c 's_system_password' "\$CONTEXT_FILE" 2>/dev/null || echo "0")
  if [[ "\$SYSTEM_PWD_IN_CTX" -eq 0 ]]; then
    alert "s_system_password not found in context file \$CONTEXT_FILE — context file may not have been updated after password rotation"
  else
    log "s_system_password entry present in context file. OK."
  fi
else
  log "CONTEXT_FILE not set or not accessible from this host — skipping context file check."
fi

# -----------------------------------------------------------------------
# CHECK 7: Recent adop authentication failures
# -----------------------------------------------------------------------
log "Checking for recent adop authentication errors..."

if [[ -d "\${APPL_TOP_NE:-/u01/prod/fs_ne}/admin/log" ]]; then
  ADOP_LOG_DIR="\${APPL_TOP_NE}/admin/log"
  RECENT_ADOP_ERRORS=$(find "\$ADOP_LOG_DIR" -name 'adop*.log' -newer \
    /tmp/.last_pwd_monitor_check 2>/dev/null \
    | xargs grep -l 'ORA-01017\|ORA-28000\|EBS_SYSTEM.*authentication\|SYSTEM.*authentication' \
    2>/dev/null | wc -l || echo "0")
  if [[ "\$RECENT_ADOP_ERRORS" -gt 0 ]]; then
    alert "\$RECENT_ADOP_ERRORS adop log file(s) contain authentication errors (ORA-01017/ORA-28000) since last check"
  else
    log "No recent adop authentication errors found. OK."
  fi
  touch /tmp/.last_pwd_monitor_check
fi

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
log "=== Monitor Complete: \$FAILURES alert(s) ==="

if [[ "\$FAILURES" -gt 0 ]]; then
  echo ""
  echo "ACTION REQUIRED: \$FAILURES password synchronization issue(s). See \$ALERT_LOG"
  exit 1
else
  log "All SYSTEM/EBS_SYSTEM password synchronization checks passed."
  exit 0
fi
\`\`\`

### Install and schedule

\`\`\`bash
chmod +x /usr/local/bin/ebs_system_pwd_monitor.sh

# Weekly check — every Monday at 07:00
crontab -e
\`\`\`

\`\`\`
0 7 * * 1 /usr/local/bin/ebs_system_pwd_monitor.sh EBSPRD >> /var/log/ebs_system_pwd_monitor.log 2>&1

# Also run immediately after any password rotation
# /usr/local/bin/ebs_system_pwd_monitor.sh EBSPRD
\`\`\`

---

## Emergency: Unlocking EBS_SYSTEM After a Failed Rotation

If the password rotation script left \`EBS_SYSTEM\` locked and adop is blocked:

\`\`\`sql
sqlplus / as sysdba

-- Confirm container
SHOW CON_NAME;
-- Must be CDB\$ROOT

-- Check status
SELECT c.name, u.username, u.account_status, u.lock_date
FROM   cdb_users u JOIN v\$containers c ON c.con_id = u.con_id
WHERE  u.username IN ('SYSTEM','EBS_SYSTEM');

-- Unlock and reset password in one operation
ALTER USER EBS_SYSTEM IDENTIFIED BY <NewPassword> ACCOUNT UNLOCK CONTAINER=ALL;
ALTER USER SYSTEM     IDENTIFIED BY <NewPassword> ACCOUNT UNLOCK CONTAINER=ALL;

-- Verify
SELECT c.name, u.username, u.account_status
FROM   cdb_users u JOIN v\$containers c ON c.con_id = u.con_id
WHERE  u.username IN ('SYSTEM','EBS_SYSTEM');
-- All rows must show OPEN
\`\`\`

---

## Troubleshooting Table

| Symptom | Root Cause | Fix |
|---------|-----------|-----|
| Password script hangs on EBS_SYSTEM | Missing \`CONTAINER=ALL\` or script not CDB-aware | Rerun manually with \`CONTAINER=ALL\` in CDB\$ROOT |
| adop fails with ORA-01017 after rotation | SYSTEM/EBS_SYSTEM passwords differ; patches not applied | Re-synchronize passwords; or apply patches 32573930 + 31817501 |
| \`ALTER USER\` succeeds but PDB still has old password | \`CONTAINER=ALL\` omitted | Rerun with \`CONTAINER=ALL\` |
| AutoConfig fails with authentication error | Context file not updated before AutoConfig | Update \`s_system_password\` in context file; rerun AutoConfig |
| Password rejected by database (special char) | \`\$\`, \`@\`, \`!\` etc. in password | Change to alphanumeric-only password |
| EBS_SYSTEM locked after rotation | Password complexity profile locked the account | \`ALTER USER EBS_SYSTEM ACCOUNT UNLOCK CONTAINER=ALL\` |
| Monitor reports hash drift | \`CONTAINER=ALL\` not used in last rotation | Re-run Phase 2 of this runbook |
| adop prepare succeeds but cutover ORA-01017 | EBS_SYSTEM auth checked at different phase than SYSTEM | Re-synchronize both passwords; re-run full adop cycle |`,
};

async function main() {
  console.log('Inserting EBS_SYSTEM password sync runbook...');
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
