import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-ldap-integration-runbook';

const content = `
Operations runbook for diagnosing, fixing, and monitoring EBS LDAP integration failures. Covers all five failure modes with step-by-step resolution procedures, a full automated diagnostic script, an extended monitoring script with alerting, and complete cron scheduling instructions for the oracle OS user.

**Applies to:** EBS 12.1.x / 12.2.x with OID, Active Directory, or OpenLDAP

---

## Phase 1 — Fast Triage (5 minutes)

Run these four commands in order. The first failure tells you which phase to go to.

\`\`\`bash
# Environment: run from the DATABASE SERVER as the oracle OS user

LDAP_HOST="ldapdir01.corp.example.com"
LDAP_PORT=389
DB_CONN="\${TWO_TASK:-EBSPROD}"

# 1. TCP (Phase 3A if this fails)
timeout 8 bash -c "echo > /dev/tcp/\$LDAP_HOST/\$LDAP_PORT" 2>/dev/null \
  && echo "TCP: OK" || echo "TCP: FAIL → go to Phase 3A"

# 2. Anonymous bind (Phase 3A if this fails after TCP passes)
ldapsearch -x -H "ldap://\$LDAP_HOST:\$LDAP_PORT" \
  -b "dc=corp,dc=example,dc=com" "(objectClass=*)" dn 2>&1 | \
  grep -qiE 'dn:|result: 0' && echo "ANON BIND: OK" || echo "ANON BIND: FAIL → Phase 3A"

# 3. Service account bind (Phase 3B if this fails after anon bind passes)
BIND_PWD=\$(cat /u01/scripts/.ldap_bind_pwd 2>/dev/null)
ldapsearch -x -H "ldap://\$LDAP_HOST:\$LDAP_PORT" \
  -D "cn=ebssvc,ou=ServiceAccounts,dc=corp,dc=example,dc=com" \
  -w "\$BIND_PWD" \
  -b "dc=corp,dc=example,dc=com" "(objectClass=organizationalUnit)" dn 2>&1 | \
  grep -qiE 'dn:|result: 0' && echo "SA BIND: OK" || echo "SA BIND: FAIL → Phase 3B"

# 4. SSL port (Phase 3C if this fails after plain port passes)
timeout 8 bash -c "echo > /dev/tcp/\$LDAP_HOST/636" 2>/dev/null \
  && echo "SSL PORT: OK" || echo "SSL PORT: FAIL → Phase 3C"
\`\`\`

---

## Phase 2 — Collect Configuration Snapshot

\`\`\`sql
-- Run as APPS in sqlplus

-- LDAP connection details
SELECT ldap_host, ldap_port, ldap_base, ldap_base_user,
       last_update_date  credentials_last_changed
FROM   applsys.fnd_ldap_credentials;

-- SSO/LDAP profile option values at site level
SELECT fpo.user_profile_option_name  option_name,
       fpov.profile_option_value     value
FROM   applsys.fnd_profile_option_values fpov
JOIN   applsys.fnd_profile_options       fpo
  ON   fpo.profile_option_name = fpov.profile_option_name
WHERE  fpo.profile_option_name IN (
         'APPS_SSO','APPS_SSO_LDAP_SYNCHRONIZATION',
         'APPS_AUTH_TYPE','APPS_SSO_LOGIN_TYPES',
         'LDAP_SYNCH_ROLES','APPS_SSO_LOCAL_LOGIN')
  AND  fpov.level_id = 10001
ORDER  BY fpo.profile_option_name;

-- Sync concurrent program last 5 runs
SELECT r.request_id,
       TO_CHAR(r.actual_start_date,'YYYY-MM-DD HH24:MI') started,
       r.status_code, r.completion_text, r.logfile_name
FROM   applsys.fnd_concurrent_requests r
JOIN   applsys.fnd_concurrent_programs p
  ON   p.concurrent_program_id = r.concurrent_program_id
  AND  p.application_id        = r.program_application_id
WHERE  p.concurrent_program_name IN ('WFMLRSUP','LDAPSYNCH')
ORDER  BY r.actual_start_date DESC
FETCH  FIRST 5 ROWS ONLY;
\`\`\`

---

## Phase 3A — Fix: Connection / LDAP Server Unreachable

\`\`\`bash
# Run from DB host

# 1. Confirm it is not just DNS
host ldapdir01.corp.example.com
nslookup ldapdir01.corp.example.com
ping -c 3 ldapdir01.corp.example.com

# 2. Test direct IP (bypass DNS)
LDAP_IP="192.168.10.50"    # replace with actual IP
timeout 8 bash -c "echo > /dev/tcp/\$LDAP_IP/389" 2>/dev/null \
  && echo "IP direct: OPEN" || echo "IP direct: CLOSED"

# 3. Check if the LDAP service is up (if you have access to the LDAP host)
ssh ldapdir01 "systemctl status slapd openldap oid 2>/dev/null || ps -ef | grep -i ldap"

# 4. Check DB host firewall rules
iptables -L OUTPUT -n | grep -E '389|636'
# Or on RHEL 9 with firewalld:
firewall-cmd --list-all

# 5. If firewall is blocking — add rule (run as root on DB host)
firewall-cmd --permanent --add-rich-rule='rule family=ipv4 destination address=192.168.10.50 port port=389 protocol=tcp accept'
firewall-cmd --permanent --add-rich-rule='rule family=ipv4 destination address=192.168.10.50 port port=636 protocol=tcp accept'
firewall-cmd --reload
\`\`\`

---

## Phase 3B — Fix: Bind Credential Failure

\`\`\`bash
# Confirm the exact error code from ldapsearch output
ldapsearch -x \
  -H "ldap://ldapdir01.corp.example.com:389" \
  -D "cn=ebssvc,ou=ServiceAccounts,dc=corp,dc=example,dc=com" \
  -w "$(cat /u01/scripts/.ldap_bind_pwd)" \
  -b "dc=corp,dc=example,dc=com" \
  "(objectClass=organizationalUnit)" dn 2>&1

# Error 49 = INVALID_CREDENTIALS (wrong password or DN)
# Error 32 = NO_SUCH_OBJECT (bind DN does not exist)
# Error 34 = INVALID_DN_SYNTAX (malformed bind DN)
\`\`\`

### Fix A — Update password in EBS

\`\`\`sql
-- Update the bind password stored in EBS
-- Do this through the EBS UI: System Admin → Security → LDAP Servers
-- Or via the API (run as APPS):

EXEC fnd_ldap_user.set_ldap_credentials(
  p_host      => 'ldapdir01.corp.example.com',
  p_port      => 389,
  p_base      => 'dc=corp,dc=example,dc=com',
  p_base_user => 'cn=ebssvc,ou=ServiceAccounts,dc=corp,dc=example,dc=com',
  p_passwd    => 'NewBindPassword#2024'
);
COMMIT;

-- Also update the local password file used by the monitoring script
\`\`\`

\`\`\`bash
# Update the monitoring script password file
echo -n 'NewBindPassword#2024' > /u01/scripts/.ldap_bind_pwd
chmod 600 /u01/scripts/.ldap_bind_pwd

# Re-test
BIND_PWD=\$(cat /u01/scripts/.ldap_bind_pwd)
ldapsearch -x -H "ldap://ldapdir01.corp.example.com:389" \
  -D "cn=ebssvc,ou=ServiceAccounts,dc=corp,dc=example,dc=com" \
  -w "\$BIND_PWD" -b "dc=corp,dc=example,dc=com" \
  "(objectClass=organizationalUnit)" dn 2>&1 | head -5
\`\`\`

### Fix B — Unlock a locked service account

If the account was locked by too many failed binds (error 49 with subcode 775 in AD):

\`\`\`bash
# In Active Directory — run on Windows or use ldapmodify
ldapmodify -x -H "ldap://ldapdir01.corp.example.com:389" \
  -D "cn=Administrator,cn=Users,dc=corp,dc=example,dc=com" \
  -w "<admin_password>" << 'EOF'
dn: cn=ebssvc,ou=ServiceAccounts,dc=corp,dc=example,dc=com
changetype: modify
replace: lockoutTime
lockoutTime: 0
EOF

# In OID — use oidpasswd or ODSM console
\`\`\`

---

## Phase 3C — Fix: SSL / Oracle Wallet

\`\`\`bash
# All commands on the DATABASE HOST as oracle

WALLET_DIR="/u01/oracle/product/19c/db_home/owm/wallets/ebsprod_ldap"
LDAP_HOST="ldapdir01.corp.example.com"

# 1. Fetch the current LDAP server certificate chain
echo | timeout 10 openssl s_client \
  -connect "\$LDAP_HOST:636" \
  -showcerts 2>/dev/null > /tmp/ldap_cert_chain.txt

# Extract PEM blocks
grep -n "BEGIN CERTIFICATE" /tmp/ldap_cert_chain.txt
# Certificate 0 = server cert, Certificate 1 = intermediate CA, Certificate 2 = root CA
# Import the CA certificates (intermediate and root) into the wallet

# 2. Extract root CA to a file (adjust awk line numbers from grep output above)
awk '/-----BEGIN CERTIFICATE-----/{c++} c==2' /tmp/ldap_cert_chain.txt \
  | awk '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/' \
  > /tmp/ldap_root_ca.pem

# 3. Verify the certificate you extracted
openssl x509 -in /tmp/ldap_root_ca.pem -noout -subject -issuer -dates

# 4. Create wallet if it does not exist
orapki wallet create \
  -wallet "\$WALLET_DIR" \
  -pwd WalletPwd#12345 \
  -auto_login

# 5. Import the CA certificate
orapki wallet add \
  -wallet "\$WALLET_DIR" \
  -trusted_cert \
  -cert /tmp/ldap_root_ca.pem \
  -pwd WalletPwd#12345

# 6. Verify wallet contents
orapki wallet display -wallet "\$WALLET_DIR"

# 7. Ensure sqlnet.ora on the DB host references the wallet
SQLNET=\$ORACLE_HOME/network/admin/sqlnet.ora
grep -i "WALLET_LOCATION" "\$SQLNET" || cat >> "\$SQLNET" << 'NETEOF'
SSL_CLIENT_AUTHENTICATION = FALSE
WALLET_LOCATION =
  (SOURCE =
    (METHOD = FILE)
    (METHOD_DATA =
      (DIRECTORY = /u01/oracle/product/19c/db_home/owm/wallets/ebsprod_ldap)))
NETEOF

# 8. Test SSL connection from DB
ldapsearch -x \
  -H "ldaps://\$LDAP_HOST:636" \
  -D "cn=ebssvc,ou=ServiceAccounts,dc=corp,dc=example,dc=com" \
  -w "\$(cat /u01/scripts/.ldap_bind_pwd)" \
  -b "dc=corp,dc=example,dc=com" \
  "(objectClass=organizationalUnit)" dn 2>&1 | head -10
\`\`\`

---

## Phase 3D — Fix: User Synchronisation Failure

\`\`\`sql
-- 1. Check the sync concurrent program log
-- Get logfile path
SELECT r.request_id, r.logfile_name, r.completion_text
FROM   applsys.fnd_concurrent_requests r
JOIN   applsys.fnd_concurrent_programs p
  ON   p.concurrent_program_id = r.concurrent_program_id
  AND  p.application_id        = r.program_application_id
WHERE  p.concurrent_program_name = 'WFMLRSUP'
  AND  r.status_code IN ('E','W')
ORDER  BY r.actual_start_date DESC
FETCH  FIRST 3 ROWS ONLY;
\`\`\`

\`\`\`bash
# Read the log (logfile_name from above query)
cat /u01/oracle/EBS/fs1/EBSapps/appl/log/WFMLRSUP_<request_id>.log | \
  grep -iE 'ora-|error|fail|ldap' | tail -30
\`\`\`

\`\`\`sql
-- 2. Identify users with sync discrepancies
SELECT wu.name,
       wu.status          wf_status,
       fu.end_date        fnd_end_date,
       fu.last_update_date
FROM   applsys.wf_local_users wu
JOIN   applsys.fnd_user       fu ON fu.user_name = wu.name
WHERE  wu.orig_system = 'FND'
  AND  wu.status     = 'INACTIVE'
  AND  (fu.end_date IS NULL OR fu.end_date > SYSDATE)
ORDER  BY fu.last_update_date DESC;

-- 3. Force sync for a single user
BEGIN
  fnd_ldap_user.synchronize_user(
    p_event_name => 'oracle.apps.fnd.user.update',
    p_user_name  => 'JSMITH'
  );
  COMMIT;
END;
/

-- 4. Re-run a full sync
BEGIN
  fnd_ldap_user.synchronize_all_users;
  COMMIT;
END;
/

-- 5. Or submit the concurrent program via the EBS Requests form
-- Program: Synchronize WF LOCAL tables
-- No parameters required
\`\`\`

---

## Phase 3E — Fix: DN Mismatch After Directory Restructure

\`\`\`bash
# 1. Find the user's new DN in the directory
ldapsearch -x \
  -H "ldap://ldapdir01.corp.example.com:389" \
  -D "cn=ebssvc,ou=ServiceAccounts,dc=corp,dc=example,dc=com" \
  -w "\$(cat /u01/scripts/.ldap_bind_pwd)" \
  -b "dc=corp,dc=example,dc=com" \
  "(|(uid=jsmith)(mail=j.smith@corp.example.com))" dn cn mail 2>&1
\`\`\`

\`\`\`sql
-- 2. Update stored DN for affected user
UPDATE applsys.fnd_user_preferences
SET    preference_value = 'cn=jsmith,ou=Staff,ou=London,dc=corp,dc=example,dc=com'
WHERE  preference_name  = 'LDAP_DN'
  AND  user_id = (SELECT user_id FROM applsys.fnd_user WHERE user_name = 'JSMITH');
COMMIT;

-- 3. For a full directory restructure — clear all stored DNs and re-sync
UPDATE applsys.fnd_user_preferences
SET    preference_value = NULL
WHERE  preference_name = 'LDAP_DN';
COMMIT;

-- Update base DN in credentials if the domain changed
EXEC fnd_ldap_user.set_ldap_credentials(
  p_host      => 'ldapdir01.corp.example.com',
  p_port      => 389,
  p_base      => 'dc=newcorp,dc=example,dc=com',   -- new base DN
  p_base_user => 'cn=ebssvc,ou=ServiceAccounts,dc=newcorp,dc=example,dc=com',
  p_passwd    => 'BindPassword#2024'
);
COMMIT;

BEGIN
  fnd_ldap_user.synchronize_all_users;
  COMMIT;
END;
/
\`\`\`

---

## Automated Full Diagnostic Script

\`\`\`bash
#!/bin/bash
# /u01/scripts/ebs_ldap_diagnose.sh
# Full diagnostic — run when LDAP integration is broken and you need a complete picture.
# Usage: ./ebs_ldap_diagnose.sh [apps_password]

LDAP_HOST="ldapdir01.corp.example.com"
BIND_DN="cn=ebssvc,ou=ServiceAccounts,dc=corp,dc=example,dc=com"
BIND_PWD=\$(cat /u01/scripts/.ldap_bind_pwd 2>/dev/null)
APPS_PWD=\${1:-\$(cat /u01/scripts/.apps_pwd 2>/dev/null)}
DB_CONN="\${TWO_TASK:-EBSPROD}"
REPORT=/tmp/ebs_ldap_diagnose_\$(date +%Y%m%d_%H%M%S).txt
DIV="=================================================================="

r(){ echo "\$1" | tee -a "\$REPORT"; }

r "\$DIV"
r "EBS LDAP Full Diagnostic — \$(date)"
r "Host: \$(hostname) | DB: \$DB_CONN | LDAP: \$LDAP_HOST"
r "\$DIV"

r ""; r "1. NETWORK"
for PORT in 389 636; do
  timeout 8 bash -c "echo > /dev/tcp/\$LDAP_HOST/\$PORT" 2>/dev/null \
    && r "  PORT \$PORT: OPEN" || r "  PORT \$PORT: CLOSED/BLOCKED"
done
host "\$LDAP_HOST" | head -3 | tee -a "\$REPORT"

r ""; r "2. LDAP BINDS"
ANON=\$(ldapsearch -x -H "ldap://\$LDAP_HOST:389" \
  -b "dc=corp,dc=example,dc=com" "(objectClass=*)" dn 2>&1 | grep -iE 'result:|error:' | head -2)
r "  Anonymous: \$ANON"

SA=\$(ldapsearch -x -H "ldap://\$LDAP_HOST:389" \
  -D "\$BIND_DN" -w "\$BIND_PWD" \
  -b "dc=corp,dc=example,dc=com" "(objectClass=organizationalUnit)" dn 2>&1 \
  | grep -iE 'result:|error:|dn:' | head -3)
r "  Service account: \$SA"

r ""; r "3. SSL CERTIFICATE"
CERT=\$(echo | timeout 10 openssl s_client -connect "\$LDAP_HOST:636" \
  -servername "\$LDAP_HOST" 2>/dev/null | openssl x509 -noout -subject -dates 2>/dev/null)
r "  \$CERT"

r ""; r "4. ORACLE WALLET"
WALLET_DIR=\$(grep -i 'DIRECTORY' \$ORACLE_HOME/network/admin/sqlnet.ora 2>/dev/null | \
  grep -oP '(?<=DIRECTORY = )[^)]+' | tr -d ' ')
if [ -n "\$WALLET_DIR" ]; then
  r "  Wallet: \$WALLET_DIR"
  orapki wallet display -wallet "\$WALLET_DIR" 2>/dev/null | grep -E 'Subject|Valid' | \
    head -10 | tee -a "\$REPORT"
else
  r "  Wallet: NOT CONFIGURED in sqlnet.ora"
fi

r ""; r "5. EBS CONFIGURATION (requires DB access)"
sqlplus -S "apps/\${APPS_PWD}@\${DB_CONN}" << 'SQLEOF' >> "\$REPORT" 2>&1
SET PAGESIZE 30 LINESIZE 150 FEEDBACK OFF

PROMPT --- fnd_ldap_credentials ---
SELECT ldap_host, ldap_port, ldap_base, ldap_base_user, last_update_date
FROM   applsys.fnd_ldap_credentials;

PROMPT --- APPS_SSO profile options ---
SELECT fpo.profile_option_name, fpov.profile_option_value
FROM   applsys.fnd_profile_option_values fpov
JOIN   applsys.fnd_profile_options fpo ON fpo.profile_option_name=fpov.profile_option_name
WHERE  fpo.profile_option_name IN
  ('APPS_SSO','APPS_SSO_LDAP_SYNCHRONIZATION','APPS_AUTH_TYPE',
   'APPS_SSO_LOGIN_TYPES','LDAP_SYNCH_ROLES')
  AND  fpov.level_id=10001;

PROMPT --- Last 5 sync runs ---
SELECT r.request_id, TO_CHAR(r.actual_start_date,'YYYY-MM-DD HH24:MI') started,
       r.status_code, SUBSTR(r.completion_text,1,60) completion
FROM   applsys.fnd_concurrent_requests r
JOIN   applsys.fnd_concurrent_programs p
  ON   p.concurrent_program_id=r.concurrent_program_id
  AND  p.application_id=r.program_application_id
WHERE  p.concurrent_program_name IN ('WFMLRSUP','LDAPSYNCH')
ORDER  BY r.actual_start_date DESC
FETCH  FIRST 5 ROWS ONLY;

PROMPT --- WF_LOCAL_USERS sync gap ---
SELECT COUNT(*) gap_count
FROM   applsys.wf_local_users wu
JOIN   applsys.fnd_user fu ON fu.user_name=wu.name
WHERE  wu.orig_system='FND' AND wu.status='INACTIVE'
  AND  (fu.end_date IS NULL OR fu.end_date>SYSDATE);

PROMPT --- DBMS_LDAP connectivity test ---
SET SERVEROUTPUT ON
DECLARE
  l_session DBMS_LDAP.SESSION;
  l_retval  PLS_INTEGER;
BEGIN
  DBMS_LDAP.USE_EXCEPTION := TRUE;
  l_session := DBMS_LDAP.INIT('ldapdir01.corp.example.com', 389);
  DBMS_OUTPUT.PUT_LINE('DBMS_LDAP.INIT: SUCCESS');
  l_retval := DBMS_LDAP.UNBIND_S(l_session);
EXCEPTION
  WHEN OTHERS THEN
    DBMS_OUTPUT.PUT_LINE('DBMS_LDAP.INIT FAILED: ' || SQLERRM);
END;
/
EXIT;
SQLEOF

r ""; r "\$DIV"
r "Diagnostic complete. Full report: \$REPORT"
echo "Report saved: \$REPORT"
\`\`\`

---

## Cron Scheduling — Complete Reference

### Setup checklist

\`\`\`bash
# 1. Script and log directories
mkdir -p /u01/scripts /var/log/ebs
chown oracle:dba /u01/scripts /var/log/ebs

# 2. Deploy scripts
chmod 750 /u01/scripts/ebs_ldap_monitor.sh /u01/scripts/ebs_ldap_diagnose.sh
chown oracle:dba /u01/scripts/ebs_ldap_*.sh

# 3. Secure credential files (never embed passwords in scripts or crontabs)
echo -n 'BindPassword#123' > /u01/scripts/.ldap_bind_pwd
echo -n 'AppsPassword#456' > /u01/scripts/.apps_pwd
chmod 600 /u01/scripts/.ldap_bind_pwd /u01/scripts/.apps_pwd
chown oracle:dba /u01/scripts/.ldap_bind_pwd /u01/scripts/.apps_pwd

# 4. Wrapper to source EBS environment cleanly in cron
cat > /u01/scripts/run_ldap_monitor.sh << 'EOF'
#!/bin/bash
unset ORACLE_BASE ORACLE_HOME ORACLE_SID
source /u01/oracle/EBS/EBSapps.env run 2>/dev/null
export TWO_TASK=EBSPROD
export ORACLE_HOME=/u01/oracle/product/19c/db_home
export PATH=\$ORACLE_HOME/bin:/usr/bin:/bin
exec /u01/scripts/ebs_ldap_monitor.sh
EOF
chmod 750 /u01/scripts/run_ldap_monitor.sh
chown oracle:dba /u01/scripts/run_ldap_monitor.sh

# 5. Test the wrapper manually before adding to cron
su - oracle -c "/u01/scripts/run_ldap_monitor.sh"
echo "Exit code: \$?"
\`\`\`

### Crontab entries (oracle user)

\`\`\`bash
# View current crontab
crontab -l -u oracle

# Edit crontab
crontab -e -u oracle
\`\`\`

Add these entries:

\`\`\`
# ─── EBS LDAP Monitoring ──────────────────────────────────────────────────────
#
# FORMAT: min hour day month weekday command
#
# Business hours (Mon–Fri 06:00–20:00): check every 15 minutes
*/15 6-20 * * 1-5    /u01/scripts/run_ldap_monitor.sh >> /var/log/ebs/ldap_cron.log 2>&1

# Off-hours and weekends: check once per hour
0 0-5,21-23 * * 1-5  /u01/scripts/run_ldap_monitor.sh >> /var/log/ebs/ldap_cron.log 2>&1
0 * * * 0,6           /u01/scripts/run_ldap_monitor.sh >> /var/log/ebs/ldap_cron.log 2>&1

# Post-maintenance full diagnostic (run once 10 min after any LDAP change)
# Schedule manually: crontab -e; add a one-shot line; remove after it runs
# Example: 30 14 7 7 * /u01/scripts/ebs_ldap_diagnose.sh >> /var/log/ebs/ldap_diag.log 2>&1

# ─── Log Maintenance ─────────────────────────────────────────────────────────
# Compress daily logs older than 7 days
0 3 * * 0             find /var/log/ebs -name "ldap_monitor_*.log" -mtime +7 -exec gzip -q {} \;
# Delete compressed logs older than 90 days
0 3 1 * *             find /var/log/ebs -name "ldap_monitor_*.log.gz" -mtime +90 -delete
# Delete temp diagnostic reports older than 30 days
0 3 * * 0             find /tmp -name "ebs_ldap_*.txt" -mtime +30 -delete
\`\`\`

### Verify cron is working

\`\`\`bash
# Check cron daemon is running
systemctl status crond

# Confirm oracle crontab was saved
crontab -l -u oracle | grep ldap

# After first scheduled run — check output
tail -50 /var/log/ebs/ldap_cron.log

# Check cron system log for dispatch records
grep -E 'oracle.*ldap_monitor|run_ldap_monitor' /var/log/cron | tail -10

# Verify daily log file is being created
ls -lh /var/log/ebs/ldap_monitor_\$(date +%Y%m%d).log

# Force a test run outside of cron schedule
su - oracle -c "/u01/scripts/run_ldap_monitor.sh"
echo "Exit code: \$?   (0=clean, 1=issues found)"
\`\`\`

---

## Post-Fix Verification Checklist

Run after each fix before returning to normal operations.

\`\`\`bash
# 1. Monitor script passes all checks
/u01/scripts/run_ldap_monitor.sh
echo "Exit: \$?"   # must be 0

# 2. Manual user login test (use a non-admin test account)
# Navigate to EBS login page and authenticate as test user

# 3. Sync program runs clean
\`\`\`

\`\`\`sql
-- Submit sync program manually and wait for completion
-- Check result
SELECT r.request_id, r.status_code, r.completion_text
FROM   applsys.fnd_concurrent_requests r
JOIN   applsys.fnd_concurrent_programs p
  ON   p.concurrent_program_id = r.concurrent_program_id
  AND  p.application_id        = r.program_application_id
WHERE  p.concurrent_program_name = 'WFMLRSUP'
ORDER  BY r.actual_start_date DESC
FETCH  FIRST 1 ROW ONLY;

-- Verify WF_LOCAL_USERS gap is zero
SELECT COUNT(*) gap_after_fix
FROM   applsys.wf_local_users wu
JOIN   applsys.fnd_user fu ON fu.user_name = wu.name
WHERE  wu.orig_system = 'FND'
  AND  wu.status = 'INACTIVE'
  AND  (fu.end_date IS NULL OR fu.end_date > SYSDATE);
-- Expected: 0
\`\`\`

---

## Quick Reference

| Symptom | Error code | Fix phase |
|---|---|---|
| Users cannot log in, no LDAP connection | TCP timeout | 3A |
| Bind fails in ldapsearch | Error 49 | 3B |
| Bind fails with account locked | Error 49 / subcode 775 | 3B |
| SSL port unreachable or cert error | — | 3C |
| SSL cert valid but wallet rejects it | ORA-31202 -1/-5 | 3C |
| Sync program errors, ORA-31202 49 | Error 49 | 3B then re-run sync |
| Sync program errors, ORA-31202 32 | Error 32 | 3E (DN mismatch) |
| Some users log in, others do not | — | 3E |
| Password change in EBS not in LDAP | — | 3D (sync gap) |
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'EBS LDAP Integration — Operations Runbook',
    slug,
    excerpt: 'Operations runbook for diagnosing and fixing all five EBS LDAP failure modes — connection failure, bind credential errors, SSL/Oracle wallet misconfigurations, user sync failures, and DN mismatches. Includes fast 5-minute triage procedure, phase-by-phase fixes, full automated diagnostic script, and complete cron scheduling instructions for the monitoring script.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
