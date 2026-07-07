import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-ldap-integration-troubleshooting';

const content = `
Oracle E-Business Suite LDAP integration is one of those configurations that works quietly for months until it does not. When it breaks, the failure is rarely self-explanatory. Users report they cannot log in. The Concurrent Manager shows a failed synchronisation run. An EBS DBA opens the system and finds cryptic ORA-31202 errors or a dead ldapsearch connection — with no obvious trail from the symptom back to the cause.

This post maps the five most common EBS LDAP failure patterns, explains what each error actually means, and provides the SQL queries, shell diagnostics, and monitoring scripts needed to find and fix the problem cleanly.

---

## What EBS Uses LDAP For

EBS connects to an LDAP directory — typically Oracle Internet Directory (OID), Microsoft Active Directory, or OpenLDAP — for three purposes:

| Purpose | What EBS does |
|---|---|
| **Authentication delegation** | Validates user credentials against the directory instead of FND_USER passwords |
| **User synchronisation** | Propagates FND_USER creates, disables, and password changes to the directory |
| **SSO integration** | Participates in a Single Sign-On flow via mod_osso or Oracle Access Manager (OAM) where the directory is the authority |

Each of these can fail independently. A broken connection prevents all three. A misconfigured bind account breaks synchronisation but not read-only authentication. An expired SSL certificate in the Oracle wallet breaks only SSL-port connections. Understanding which path failed narrows the search to the right configuration layer.

---

## Architecture Overview

\`\`\`
EBS Application Tier (ebsapp01.corp.example.com)
│
│  FND_LDAP_WRAPPER (PL/SQL package)
│  ├── reads bind DN / password from FND_LDAP_CREDENTIALS
│  ├── reads host / port / base DN from FND profile options
│  └── calls DBMS_LDAP (built-in Oracle DB LDAP client)
│
│  Concurrent Manager
│  └── "Synchronize WF LOCAL tables" (WFMLRSUP)
│      └── calls FND_LDAP_USER.SYNCHRONIZE_ALL_USERS
│
Database Tier (Oracle DB)
│  └── DBMS_LDAP ──── TCP/SSL ───► LDAP Directory Server
│                                   ldapdir01.corp.example.com
│                                   Port 389 (plain) / 636 (SSL)
│                                   Base DN: dc=corp,dc=example,dc=com
\`\`\`

The DB-tier DBMS_LDAP package makes all network calls from the **database server**, not the application server. This means firewall rules must allow the **database host** to reach the LDAP server on port 389 or 636 — not just the application tier.

---

## EBS LDAP Configuration Reference

Before diagnosing failures, confirm the configured values. All live in FND profile options and the LDAP credentials table.

\`\`\`sql
-- LDAP server connection profile options
SELECT fpov.profile_option_name,
       fpo.user_profile_option_name,
       fpov.profile_option_value
FROM   applsys.fnd_profile_option_values fpov
JOIN   applsys.fnd_profile_options       fpo
  ON   fpo.profile_option_name = fpov.profile_option_name
WHERE  fpo.profile_option_name IN (
         'APPS_SSO',
         'APPS_SSO_LDAP_SYNCHRONIZATION',
         'APPS_SSO_LOGIN_TYPES',
         'APPS_AUTH_TYPE',
         'LDAP_SYNCH_ROLES',
         'APPS_SSO_LOCAL_LOGIN'
       )
  AND  fpov.level_id = 10001    -- SITE level
ORDER  BY fpov.profile_option_name;

-- LDAP directory connection details
SELECT ldap_host,
       ldap_port,
       ldap_base,
       ldap_base_user,
       ldap_change_password
FROM   applsys.fnd_ldap_credentials;

-- FND users linked to LDAP (non-null PERSON_PARTY_ID indicates HR-linked)
SELECT user_name,
       email_address,
       start_date,
       end_date,
       last_update_date
FROM   applsys.fnd_user
WHERE  user_name NOT IN ('GUEST','SYSADMIN')
  AND  end_date IS NULL
ORDER  BY last_update_date DESC
FETCH  FIRST 20 ROWS ONLY;
\`\`\`

---

## Failure Pattern 1 — Connection Refused or Timeout

### Symptoms

- Users cannot log in; EBS shows a generic "authentication failed" page
- "Synchronize WF LOCAL tables" concurrent program errors immediately
- ldapsearch from the DB host returns "Can't contact LDAP server"

### Root causes

| Cause | Evidence |
|---|---|
| LDAP server down | ldapsearch times out or refuses connection from **DB host** |
| Firewall blocking the DB host → LDAP port | ldapsearch from app tier works; from DB host fails |
| Wrong port configured in fnd_ldap_credentials | Port 636 configured but LDAP server only listens on 389 |
| DNS resolution failure on DB host | ldapsearch to IP works; to hostname fails |

### Investigation

\`\`\`bash
# Run all connectivity tests FROM THE DATABASE SERVER (not the app tier)
# SSH to the DB host first

LDAP_HOST="ldapdir01.corp.example.com"
LDAP_PORT=389
LDAP_SSL_PORT=636

# 1. Basic TCP connectivity
echo "--- TCP test (plain LDAP) ---"
timeout 10 bash -c "echo > /dev/tcp/\$LDAP_HOST/\$LDAP_PORT" && echo "OPEN" || echo "BLOCKED/DOWN"

echo "--- TCP test (LDAP SSL) ---"
timeout 10 bash -c "echo > /dev/tcp/\$LDAP_HOST/\$LDAP_SSL_PORT" && echo "OPEN" || echo "BLOCKED/DOWN"

# 2. DNS resolution
echo "--- DNS resolution from DB host ---"
host "\$LDAP_HOST"
nslookup "\$LDAP_HOST"

# 3. ldapsearch (anonymous bind — tests connectivity only)
echo "--- Anonymous LDAP search ---"
ldapsearch -x -H "ldap://\$LDAP_HOST:\$LDAP_PORT" \
  -b "dc=corp,dc=example,dc=com" \
  "(objectClass=*)" dn 2>&1 | head -20
\`\`\`

\`\`\`sql
-- Test DBMS_LDAP connectivity from inside the database
DECLARE
  l_session DBMS_LDAP.SESSION;
  l_retval  PLS_INTEGER;
BEGIN
  DBMS_LDAP.USE_EXCEPTION := TRUE;
  l_session := DBMS_LDAP.INIT('ldapdir01.corp.example.com', 389);
  DBMS_OUTPUT.PUT_LINE('LDAP INIT: SUCCESS — session handle returned');
  l_retval := DBMS_LDAP.UNBIND_S(l_session);
EXCEPTION
  WHEN OTHERS THEN
    DBMS_OUTPUT.PUT_LINE('LDAP INIT FAILED: ' || SQLERRM);
END;
/
\`\`\`

---

## Failure Pattern 2 — Bind Authentication Failure (ORA-31202)

### Symptoms

- ORA-31202: LDAP client operation failed — error code 49
- "Synchronize WF LOCAL tables" fails with "Invalid credentials"
- Error code 49 in LDAP is always INVALID_CREDENTIALS — the bind DN or bind password is wrong

### Investigation

\`\`\`bash
# Test the EBS bind DN and password from the DB host
LDAP_HOST="ldapdir01.corp.example.com"
BIND_DN="cn=ebssvc,ou=ServiceAccounts,dc=corp,dc=example,dc=com"
BIND_PWD="<configured_password>"   # retrieve from FND_LDAP_CREDENTIALS

ldapsearch -x \
  -H "ldap://\$LDAP_HOST:389" \
  -D "\$BIND_DN" \
  -w "\$BIND_PWD" \
  -b "dc=corp,dc=example,dc=com" \
  "(objectClass=organizationalUnit)" dn 2>&1 | head -20

# Expected success: dn: ou=People,dc=corp,dc=example,dc=com  (or similar)
# Expected failure: ldap_bind: Invalid credentials (49)
\`\`\`

\`\`\`sql
-- Retrieve the configured bind password (stored obfuscated — use this to confirm
-- the stored value is what you think it is)
SELECT ldap_host,
       ldap_port,
       ldap_base,
       ldap_base_user,
       -- ldap_passwd is encrypted — check update timestamp instead
       last_update_date       password_last_changed
FROM   applsys.fnd_ldap_credentials;

-- If the bind password needs to be updated:
-- Use the EBS System Administrator UI:
--   Security → LDAP Servers → update the Password field
-- Or call the API:
EXEC fnd_ldap_user.set_ldap_credentials(
  p_host     => 'ldapdir01.corp.example.com',
  p_port     => 389,
  p_base     => 'dc=corp,dc=example,dc=com',
  p_base_user=> 'cn=ebssvc,ou=ServiceAccounts,dc=corp,dc=example,dc=com',
  p_passwd   => 'NewStrongPassword#2024'
);
COMMIT;
\`\`\`

### Common bind failure causes

| Cause | Fix |
|---|---|
| Bind service account password expired | Reset password in LDAP, update FND_LDAP_CREDENTIALS |
| Bind DN changed after directory restructure | Update ldap_base_user in FND_LDAP_CREDENTIALS |
| Account locked after failed attempts | Unlock in LDAP admin console |
| Password contains special characters mishandled by EBS | Re-enter via EBS UI, avoid \` \` \\ characters |

---

## Failure Pattern 3 — SSL / TLS Certificate Errors

### Symptoms

- Connections on port 636 fail; connections on port 389 succeed
- ORA-31202 with error code -1 or -5 (SSL negotiation failure)
- ldapsearch with \`ldaps://\` fails with "Can't contact LDAP server" even though port 636 is open
- Oracle wallet error in DB alert log: "PKCS12 error" or "certificate verify failed"

### How SSL works for EBS LDAP

EBS uses the Oracle wallet (stored on the **database server**) to validate the LDAP server's SSL certificate. If:
- The wallet does not exist or is not configured in sqlnet.ora
- The LDAP server's CA certificate is not in the wallet
- The certificate has expired
- The certificate CN/SAN does not match the configured hostname

…the SSL handshake fails before the bind even occurs.

### Investigation

\`\`\`bash
# All commands run on the DATABASE HOST

WALLET_LOC="/u01/oracle/product/19c/db_home/owm/wallets/ebsprod_ldap"

# 1. Verify the wallet exists and is open (auto-login wallet = .p12 + cwallet.sso)
ls -lh "\$WALLET_LOC"/
# Expected: ewallet.p12, cwallet.sso

# 2. List certificates in the wallet
orapki wallet display -wallet "\$WALLET_LOC"

# 3. Check certificate expiry
orapki wallet display -wallet "\$WALLET_LOC" | grep -A3 "Valid"

# 4. Fetch the LDAP server's actual certificate and check it
echo | openssl s_client \
  -connect ldapdir01.corp.example.com:636 \
  -servername ldapdir01.corp.example.com 2>/dev/null \
  | openssl x509 -noout -dates -subject -issuer

# 5. Test ldapsearch over SSL
ldapsearch -x \
  -H "ldaps://ldapdir01.corp.example.com:636" \
  -D "cn=ebssvc,ou=ServiceAccounts,dc=corp,dc=example,dc=com" \
  -w "<bind_password>" \
  -b "dc=corp,dc=example,dc=com" \
  "(objectClass=organizationalUnit)" dn 2>&1 | head -10
\`\`\`

### Add a new CA certificate to the Oracle wallet

\`\`\`bash
WALLET_LOC="/u01/oracle/product/19c/db_home/owm/wallets/ebsprod_ldap"
CA_CERT="/tmp/ldap_ca.crt"   # CA certificate exported from LDAP server

# Import the CA certificate
orapki wallet add \
  -wallet "\$WALLET_LOC" \
  -trusted_cert \
  -cert "\$CA_CERT" \
  -pwd <wallet_password>

# Verify import
orapki wallet display -wallet "\$WALLET_LOC"

# sqlnet.ora must point to the wallet (on the DB server)
# $ORACLE_HOME/network/admin/sqlnet.ora
# SSL_CLIENT_AUTHENTICATION = FALSE
# WALLET_LOCATION = (SOURCE = (METHOD = FILE) (METHOD_DATA = (DIRECTORY = /u01/oracle/product/19c/db_home/owm/wallets/ebsprod_ldap)))
\`\`\`

---

## Failure Pattern 4 — User Synchronisation Failures

### Symptoms

- "Synchronize WF LOCAL tables" (WFMLRSUP) concurrent program fails or completes with errors
- New EBS users not appearing in the LDAP directory
- Password changes in EBS not propagating to LDAP
- Users disabled in EBS still authenticate via LDAP

### Investigation

\`\`\`sql
-- Recent sync concurrent program runs — last 7 days
SELECT r.request_id,
       r.actual_start_date,
       r.actual_completion_date,
       ROUND((r.actual_completion_date - r.actual_start_date)*24*60, 1) elapsed_min,
       r.status_code,
       r.completion_text
FROM   applsys.fnd_concurrent_requests r
JOIN   applsys.fnd_concurrent_programs p
  ON   p.concurrent_program_id = r.concurrent_program_id
  AND  p.application_id        = r.program_application_id
WHERE  p.concurrent_program_name IN ('WFMLRSUP', 'LDAPSYNCH')
  AND  r.actual_start_date     >= SYSDATE - 7
ORDER  BY r.actual_start_date DESC;

-- Check WF_LOCAL_USERS for sync status discrepancies
SELECT wu.name,
       wu.status,
       wu.orig_system,
       wu.orig_system_id,
       fu.user_name,
       fu.end_date         ebs_end_date,
       fu.last_update_date fnd_last_updated
FROM   applsys.wf_local_users wu
JOIN   applsys.fnd_user       fu ON fu.user_name = wu.name
WHERE  wu.orig_system = 'FND'
  AND  (
    -- Active in LDAP but disabled in EBS
    (wu.status = 'ACTIVE' AND fu.end_date < SYSDATE)
    OR
    -- Different status between FND and WF
    (wu.status = 'INACTIVE' AND (fu.end_date IS NULL OR fu.end_date > SYSDATE))
  )
ORDER  BY fu.last_update_date DESC
FETCH  FIRST 50 ROWS ONLY;

-- Users modified in the last 24 hours that should have synced
SELECT fu.user_name,
       fu.email_address,
       fu.start_date,
       fu.end_date,
       fu.last_update_date,
       fu.last_updated_by
FROM   applsys.fnd_user fu
WHERE  fu.last_update_date >= SYSDATE - 1
  AND  fu.user_name NOT IN ('GUEST','SYSADMIN')
ORDER  BY fu.last_update_date DESC;
\`\`\`

### Force a manual synchronisation

\`\`\`sql
-- Synchronise a single user immediately
DECLARE
  l_result VARCHAR2(100);
BEGIN
  l_result := fnd_ldap_user.synchronize_user(
    p_event_name => 'oracle.apps.fnd.user.update',
    p_user_name  => 'JSMITH'
  );
  DBMS_OUTPUT.PUT_LINE('Result: ' || l_result);
COMMIT;
END;
/

-- Synchronise all users (equivalent to running the concurrent program)
BEGIN
  fnd_ldap_user.synchronize_all_users;
  COMMIT;
END;
/
\`\`\`

---

## Failure Pattern 5 — Distinguished Name (DN) Mismatch

### Symptoms

- Users who existed before an LDAP directory restructure cannot log in
- Some users authenticate; others receive "user not found" errors
- ldapsearch returns users under a different OU than EBS expects

### Root cause

EBS stores the user's expected LDAP DN in \`FND_USER_PREFERENCES\` (or derives it from the base DN + username pattern). When the LDAP directory is restructured — OUs renamed, users moved, domain changed — the stored DN no longer matches where the user actually lives in the directory.

### Investigation

\`\`\`sql
-- Check stored LDAP DN for affected users
SELECT u.user_name,
       u.email_address,
       p.preference_value     stored_ldap_dn
FROM   applsys.fnd_user             u
JOIN   applsys.fnd_user_preferences p
  ON   p.user_id   = u.user_id
  AND  p.preference_name = 'LDAP_DN'
WHERE  u.user_name IN ('JSMITH', 'ADOE', 'BWILLIAMS')
ORDER  BY u.user_name;

-- Check the base DN configured in EBS
SELECT ldap_base, ldap_base_user
FROM   applsys.fnd_ldap_credentials;
\`\`\`

\`\`\`bash
# Verify where the user actually lives in the LDAP directory now
ldapsearch -x \
  -H "ldap://ldapdir01.corp.example.com:389" \
  -D "cn=ebssvc,ou=ServiceAccounts,dc=corp,dc=example,dc=com" \
  -w "<bind_password>" \
  -b "dc=corp,dc=example,dc=com" \
  "(uid=jsmith)" dn cn mail 2>&1
\`\`\`

### Fix: re-synchronise DN for affected users

\`\`\`sql
-- Update the stored DN to match the directory's current structure
-- Run once per affected user after confirming the new DN from ldapsearch
UPDATE applsys.fnd_user_preferences
SET    preference_value = 'cn=jsmith,ou=Staff,dc=corp,dc=example,dc=com'  -- new DN
WHERE  preference_name  = 'LDAP_DN'
  AND  user_id = (SELECT user_id FROM applsys.fnd_user WHERE user_name = 'JSMITH');
COMMIT;

-- Or clear stored DNs for all users and let EBS re-derive them on next sync
-- (only safe if base DN is correctly set and user naming is consistent)
UPDATE applsys.fnd_user_preferences
SET    preference_value = NULL
WHERE  preference_name  = 'LDAP_DN';
COMMIT;

-- Trigger a full sync to re-populate
BEGIN
  fnd_ldap_user.synchronize_all_users;
  COMMIT;
END;
/
\`\`\`

---

## Monitoring Script

Save as \`/u01/scripts/ebs_ldap_monitor.sh\`. The script tests connectivity, validates the bind account, checks for recent sync failures, and mails an alert when any check fails.

\`\`\`bash
#!/bin/bash
# /u01/scripts/ebs_ldap_monitor.sh
# EBS LDAP integration health monitor.
# Run as oracle OS user with EBS environment sourced.
# Usage: ./ebs_ldap_monitor.sh
# Scheduling: see cron block at the bottom of this post.

LDAP_HOST="ldapdir01.corp.example.com"
LDAP_PORT=389
LDAP_SSL_PORT=636
BIND_DN="cn=ebssvc,ou=ServiceAccounts,dc=corp,dc=example,dc=com"
BIND_PWD_FILE="/u01/scripts/.ldap_bind_pwd"   # file readable only by oracle, chmod 600
BASE_DN="dc=corp,dc=example,dc=com"
DB_CONN="\${TWO_TASK:-EBSPROD}"
APPS_PWD_FILE="/u01/scripts/.apps_pwd"         # chmod 600

ALERT_EMAIL="dba-alerts@corp.example.com"
LOG=/var/log/ebs/ldap_monitor_\$(date +%Y%m%d).log
REPORT=/tmp/ebs_ldap_health_\$(date +%Y%m%d_%H%M%S).txt

mkdir -p /var/log/ebs
BIND_PWD=\$(cat "\$BIND_PWD_FILE" 2>/dev/null)
APPS_PWD=\$(cat "\$APPS_PWD_FILE" 2>/dev/null)

FAIL_COUNT=0
ISSUES=""

r()  { echo "\$1" | tee -a "\$REPORT" "\$LOG"; }
err(){ FAIL_COUNT=\$((FAIL_COUNT+1)); ISSUES="\$ISSUES\n[\$1]"; r "  FAIL: \$1"; }
ok() { r "  PASS: \$1"; }

r "========================================"
r " EBS LDAP Health Check — \$(date)"
r "========================================"

# ── 1. TCP connectivity ───────────────────────────────────────────────────────
r ""
r "1. TCP CONNECTIVITY"
timeout 8 bash -c "echo > /dev/tcp/\$LDAP_HOST/\$LDAP_PORT" 2>/dev/null \
  && ok "Port \$LDAP_PORT reachable" \
  || err "Port \$LDAP_PORT UNREACHABLE — check firewall / LDAP server status"

timeout 8 bash -c "echo > /dev/tcp/\$LDAP_HOST/\$LDAP_SSL_PORT" 2>/dev/null \
  && ok "Port \$LDAP_SSL_PORT (SSL) reachable" \
  || err "Port \$LDAP_SSL_PORT (SSL) UNREACHABLE"

# ── 2. Anonymous bind ─────────────────────────────────────────────────────────
r ""
r "2. ANONYMOUS BIND"
ANON_RESULT=\$(ldapsearch -x -H "ldap://\$LDAP_HOST:\$LDAP_PORT" \
  -b "\$BASE_DN" "(objectClass=*)" dn 2>&1 | head -5)
echo "\$ANON_RESULT" | grep -qiE 'result:|dn:' \
  && ok "Anonymous bind succeeded" \
  || err "Anonymous bind FAILED: \$(echo "\$ANON_RESULT" | head -2)"

# ── 3. Service account bind ───────────────────────────────────────────────────
r ""
r "3. SERVICE ACCOUNT BIND"
if [ -z "\$BIND_PWD" ]; then
  err "Bind password file not found or empty: \$BIND_PWD_FILE"
else
  SA_RESULT=\$(ldapsearch -x \
    -H "ldap://\$LDAP_HOST:\$LDAP_PORT" \
    -D "\$BIND_DN" \
    -w "\$BIND_PWD" \
    -b "\$BASE_DN" \
    "(objectClass=organizationalUnit)" dn 2>&1 | head -5)
  echo "\$SA_RESULT" | grep -qiE 'result: 0|dn:' \
    && ok "Service account bind succeeded" \
    || err "Service account bind FAILED (check DN/password): \$(echo "\$SA_RESULT" | grep -i 'error\|result' | head -2)"
fi

# ── 4. SSL certificate expiry ──────────────────────────────────────────────────
r ""
r "4. SSL CERTIFICATE EXPIRY"
CERT_EXPIRY=\$(echo | timeout 10 openssl s_client \
  -connect "\$LDAP_HOST:\$LDAP_SSL_PORT" \
  -servername "\$LDAP_HOST" 2>/dev/null \
  | openssl x509 -noout -enddate 2>/dev/null \
  | cut -d= -f2)

if [ -n "\$CERT_EXPIRY" ]; then
  EXPIRY_EPOCH=\$(date -d "\$CERT_EXPIRY" +%s 2>/dev/null || date -j -f "%b %d %T %Y %Z" "\$CERT_EXPIRY" +%s 2>/dev/null)
  NOW_EPOCH=\$(date +%s)
  DAYS_LEFT=\$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))
  if [ "\$DAYS_LEFT" -le 14 ]; then
    err "SSL certificate expires in \$DAYS_LEFT days (\$CERT_EXPIRY) — renew immediately"
  elif [ "\$DAYS_LEFT" -le 30 ]; then
    err "SSL certificate expires in \$DAYS_LEFT days (\$CERT_EXPIRY) — schedule renewal"
  else
    ok "SSL certificate valid for \$DAYS_LEFT more days (expires \$CERT_EXPIRY)"
  fi
else
  err "Could not retrieve SSL certificate from \$LDAP_HOST:\$LDAP_SSL_PORT"
fi

# ── 5. Recent sync concurrent program status ──────────────────────────────────
r ""
r "5. SYNC CONCURRENT PROGRAM (last 48 hours)"
if [ -n "\$APPS_PWD" ]; then
SYNC_STATUS=\$(sqlplus -S "apps/\${APPS_PWD}@\${DB_CONN}" << 'SQLEOF' 2>/dev/null
SET PAGESIZE 0 LINESIZE 200 FEEDBACK OFF HEADING OFF
SELECT CASE
         WHEN COUNT(*) = 0 THEN 'NO_RUNS'
         WHEN SUM(CASE WHEN status_code='E' THEN 1 ELSE 0 END) > 0 THEN 'HAS_ERRORS'
         WHEN SUM(CASE WHEN status_code='C' THEN 1 ELSE 0 END) > 0 THEN 'OK'
         ELSE 'UNKNOWN'
       END
FROM   applsys.fnd_concurrent_requests r
JOIN   applsys.fnd_concurrent_programs p
  ON   p.concurrent_program_id = r.concurrent_program_id
  AND  p.application_id        = r.program_application_id
WHERE  p.concurrent_program_name IN ('WFMLRSUP', 'LDAPSYNCH')
  AND  r.actual_start_date     >= SYSDATE - 2;
EXIT;
SQLEOF
)
  SYNC_STATUS=\$(echo "\$SYNC_STATUS" | tr -d ' \n')
  case "\$SYNC_STATUS" in
    OK)        ok "WFMLRSUP/LDAPSYNCH: completed successfully within 48h" ;;
    HAS_ERRORS)err "WFMLRSUP/LDAPSYNCH: errors detected in last 48h — check concurrent request log" ;;
    NO_RUNS)   err "WFMLRSUP/LDAPSYNCH: no runs found in last 48h — schedule may have dropped" ;;
    *)         err "WFMLRSUP/LDAPSYNCH: unexpected status '\$SYNC_STATUS'" ;;
  esac
else
  r "  SKIP: APPS password not configured — skipping DB checks"
fi

# ── 6. WF_LOCAL_USERS sync gap ────────────────────────────────────────────────
r ""
r "6. WF_LOCAL_USERS SYNC GAP (users active in FND but inactive in WF)"
if [ -n "\$APPS_PWD" ]; then
GAP_COUNT=\$(sqlplus -S "apps/\${APPS_PWD}@\${DB_CONN}" << 'SQLEOF' 2>/dev/null
SET PAGESIZE 0 LINESIZE 50 FEEDBACK OFF HEADING OFF
SELECT COUNT(*)
FROM   applsys.wf_local_users wu
JOIN   applsys.fnd_user       fu ON fu.user_name = wu.name
WHERE  wu.orig_system = 'FND'
  AND  wu.status      = 'INACTIVE'
  AND  (fu.end_date IS NULL OR fu.end_date > SYSDATE);
EXIT;
SQLEOF
)
  GAP_COUNT=\$(echo "\$GAP_COUNT" | tr -d ' \n')
  [ "\${GAP_COUNT:-0}" -gt 0 ] \
    && err "\$GAP_COUNT FND user(s) active but showing INACTIVE in WF_LOCAL_USERS — sync needed" \
    || ok "WF_LOCAL_USERS is consistent with FND_USER"
fi

# ── 7. Summary and alert ──────────────────────────────────────────────────────
r ""
r "========================================"
r " Result: \$FAIL_COUNT issue(s) detected"
r "========================================"

if [ "\$FAIL_COUNT" -gt 0 ]; then
  r "Issues:"
  echo -e "\$ISSUES" | while read -r ISSUE; do [ -n "\$ISSUE" ] && r "  \$ISSUE"; done
  r ""
  r "Report: \$REPORT"

  if command -v mail > /dev/null 2>&1; then
    {
      echo "EBS LDAP Monitor — \$FAIL_COUNT issue(s) on \$(hostname) at \$(date)"
      echo ""
      echo -e "\$ISSUES"
      echo ""
      echo "Full report: \$REPORT"
    } | mail -s "EBS LDAP Alert: \$FAIL_COUNT issue(s) on \$(hostname)" "\$ALERT_EMAIL"
    r "Alert email sent to: \$ALERT_EMAIL"
  fi
  exit 1
else
  r "All LDAP integration checks passed."
  exit 0
fi
\`\`\`

---

## Scheduling the Monitor Script

### Initial setup

\`\`\`bash
# 1. Create the script and set permissions
mkdir -p /u01/scripts /var/log/ebs
cp ebs_ldap_monitor.sh /u01/scripts/
chmod 750 /u01/scripts/ebs_ldap_monitor.sh
chown oracle:dba /u01/scripts/ebs_ldap_monitor.sh

# 2. Create secure password files (not in the script itself)
echo -n 'BindPassword#123' > /u01/scripts/.ldap_bind_pwd
echo -n 'AppsPassword#456' > /u01/scripts/.apps_pwd
chmod 600 /u01/scripts/.ldap_bind_pwd /u01/scripts/.apps_pwd
chown oracle:dba /u01/scripts/.ldap_bind_pwd /u01/scripts/.apps_pwd

# 3. Test the script manually first
su - oracle -c "source /u01/oracle/EBS/EBSapps.env run && /u01/scripts/ebs_ldap_monitor.sh"
\`\`\`

### Cron schedule

\`\`\`bash
# Edit the oracle crontab
crontab -e -u oracle

# Add these lines:

# EBS LDAP health check — every 15 minutes during business hours
*/15 6-20 * * 1-5  source /u01/oracle/EBS/EBSapps.env run && /u01/scripts/ebs_ldap_monitor.sh >> /var/log/ebs/ldap_monitor_cron.log 2>&1

# EBS LDAP health check — hourly overnight and weekends
0 * * * 0,6       source /u01/oracle/EBS/EBSapps.env run && /u01/scripts/ebs_ldap_monitor.sh >> /var/log/ebs/ldap_monitor_cron.log 2>&1
0 0-5,21-23 * * 1-5 source /u01/oracle/EBS/EBSapps.env run && /u01/scripts/ebs_ldap_monitor.sh >> /var/log/ebs/ldap_monitor_cron.log 2>&1

# Weekly log rotation — compress logs older than 7 days
0 2 * * 0         find /var/log/ebs -name "ldap_monitor_*.log" -mtime +7 -exec gzip -q {} \;
0 2 * * 0         find /tmp -name "ebs_ldap_health_*.txt" -mtime +7 -delete
\`\`\`

### Cron without \`source\` (if EBS env is complex)

For environments where sourcing the EBS environment inline in cron is unreliable, wrap it in a launcher script:

\`\`\`bash
#!/bin/bash
# /u01/scripts/run_ldap_monitor.sh  — cron launcher

source /u01/oracle/EBS/EBSapps.env run 2>/dev/null
export TWO_TASK=EBSPROD
export ORACLE_HOME=/u01/oracle/product/19c/db_home
export PATH=\$ORACLE_HOME/bin:\$PATH

exec /u01/scripts/ebs_ldap_monitor.sh
\`\`\`

\`\`\`bash
chmod 750 /u01/scripts/run_ldap_monitor.sh
chown oracle:dba /u01/scripts/run_ldap_monitor.sh

# Then the crontab entry is simply:
*/15 6-20 * * 1-5  /u01/scripts/run_ldap_monitor.sh >> /var/log/ebs/ldap_monitor_cron.log 2>&1
\`\`\`

### Verify cron is running correctly

\`\`\`bash
# After the first scheduled run, check the cron log
tail -30 /var/log/ebs/ldap_monitor_cron.log

# Check the system cron log for errors
grep ldap_monitor /var/log/cron | tail -20

# Check that the daily log file is being created
ls -lh /var/log/ebs/ldap_monitor_\$(date +%Y%m%d).log
\`\`\`

---

## Summary

EBS LDAP integration failures always fall into one of five categories: a network layer problem between the database host and the directory server, a bind credential problem, an SSL/TLS certificate problem in the Oracle wallet, a user synchronisation failure in the WF concurrent program, or a distinguished name mismatch after a directory restructure. The diagnostic order is always the same: test TCP connectivity from the database server first, then test the bind, then check SSL, then check the synchronisation job logs and AD table state. The monitoring script covers all five categories automatically and emails an alert within 15 minutes of a failure when scheduled via cron. The most important operational habit is running the monitor for several days after any LDAP directory change — a DN restructure or service account password rotation that is not reflected in FND_LDAP_CREDENTIALS will cause a silent failure that only surfaces when users start calling.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'EBS LDAP Integration: Diagnosing and Fixing the Five Most Common Failures',
    slug,
    excerpt: 'EBS LDAP integration breaks in five predictable ways — connection refused, bind credential failure, SSL certificate errors, user sync failures, and DN mismatches after directory restructures. Covers identification queries, ldapsearch and DBMS_LDAP diagnostics, Oracle wallet certificate management, WF_LOCAL_USERS sync analysis, and a monitoring script with cron scheduling instructions.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
