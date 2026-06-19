import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS AP/AR Netting Runbook: Setup Validation, Batch Recovery, and Ongoing Operations',
  slug: 'oracle-ebs-ap-ar-netting-runbook',
  excerpt:
    'Step-by-step runbook for validating Oracle EBS AP/AR Netting configuration, diagnosing and recovering failed netting batches, resolving unapplied AR receipts and unpaid AP invoices, managing period close with netting, and operating the complete netting health check script via crontab.',
  category: 'ebs-functional' as const,
  isPremium: true,
  published: true,
  publishedAt: new Date('2026-06-19'),
  content: `## Phase 1 — Environment and Prerequisites

Before any netting diagnostic or setup task, confirm the environment context.

### 1.1 Confirm Application and DB Version

\`\`\`sql
-- EBS version
SELECT release_name FROM fnd_product_groups;

-- Database version
SELECT version FROM v\$instance;

-- Cash Management patch level
SELECT a.patch_level
FROM   fnd_application a
JOIN   fnd_product_installations fpi ON fpi.application_id = a.application_id
WHERE  a.application_short_name = 'CE';
\`\`\`

Expected: EBS R12.2.x, Oracle DB 19c+. Netting requires at minimum R12.1.3; several critical fixes are in R12.2 family patches.

### 1.2 Confirm Netting Profile Options

\`\`\`sql
SELECT fpov.profile_option_name,
       fpov.user_profile_option_name,
       fpo.profile_option_value
FROM   fnd_profile_options fpov
JOIN   fnd_profile_option_values fpo
       ON fpo.profile_option_id = fpov.profile_option_id
WHERE  fpov.profile_option_name IN (
         'CE_NETTING_ENABLED',
         'CE_NETTING_APPROVAL_REQUIRED',
         'CE_NETTING_SETTLEMENT_METHOD'
       )
  AND  fpo.level_id = 10001   -- site level
ORDER  BY fpov.profile_option_name;
\`\`\`

| Profile | Expected Value | Impact if Wrong |
|---------|---------------|-----------------|
| CE_NETTING_ENABLED | Y | Netting menus and process hidden entirely |
| CE_NETTING_APPROVAL_REQUIRED | Y or N | Y = batches require manual approval step |
| CE_NETTING_SETTLEMENT_METHOD | AUTO or MANUAL | AUTO runs settlement on approval |

### 1.3 Confirm Required Concurrent Programs Are Active

\`\`\`sql
SELECT fcp.concurrent_program_name,
       fcp.user_concurrent_program_name,
       fcp.enabled_flag,
       fce.enabled_flag AS executable_enabled
FROM   fnd_concurrent_programs fcp
JOIN   fnd_executables fce ON fce.executable_id = fcp.executable_id
WHERE  fcp.concurrent_program_name IN (
         'CENETSETTLEMENT',
         'CENETBATCH',
         'CENETCANCEL'
       )
ORDER  BY fcp.concurrent_program_name;
\`\`\`

All three must have ENABLED_FLAG = 'Y'. If disabled, re-enable via Concurrent Programs form (System Administrator → Concurrent → Programs).

---

## Phase 2 — Netting Agreement Validation

### 2.1 Full Agreement Configuration Audit

\`\`\`sql
-- Complete agreement profile
SELECT na.agreement_id,
       na.agreement_name,
       na.status,
       na.currency_code,
       na.settlement_days,
       na.maturity_date_type,
       na.lead_days,
       ba.bank_account_num,
       ba.account_name          AS bank_account_name,
       ba.account_inactive_date,
       glsv.name                AS ledger,
       hou.name                 AS operating_unit
FROM   ce_netting_agreements na
JOIN   ce_bank_accounts ba       ON ba.bank_account_id = na.bank_account_id
JOIN   gl_ledgers glsv           ON glsv.ledger_id = na.set_of_books_id
JOIN   hr_operating_units hou    ON hou.organization_id = na.org_id
ORDER  BY na.agreement_name;
\`\`\`

Verify:
- STATUS = ACTIVE for all agreements in use
- ACCOUNT_INACTIVE_DATE is null (bank account is active)
- SETTLEMENT_DAYS matches the finance team's expectation (0 = same day)
- MATURITY_DATE_TYPE is correct for the netting window (INVOICE_DATE, DUE_DATE, or DISCOUNT_DATE)

### 2.2 Vendor and Customer Site Coverage

\`\`\`sql
-- AP vendor sites per agreement
SELECT na.agreement_name,
       COUNT(DISTINCT nvs.vendor_site_id) AS vendor_site_count,
       LISTAGG(pvs.vendor_site_code, ', ') WITHIN GROUP (ORDER BY pvs.vendor_site_code) AS sites
FROM   ce_netting_agreements na
JOIN   ce_netting_vendor_sites nvs  ON nvs.agreement_id = na.agreement_id
JOIN   po_vendor_sites_all pvs      ON pvs.vendor_site_id = nvs.vendor_site_id
WHERE  na.status = 'ACTIVE'
GROUP  BY na.agreement_name;

-- AR customer sites per agreement
SELECT na.agreement_name,
       COUNT(DISTINCT ncs.customer_site_use_id) AS customer_site_count,
       LISTAGG(hcsua.location, ', ') WITHIN GROUP (ORDER BY hcsua.location) AS locations
FROM   ce_netting_agreements na
JOIN   ce_netting_cust_sites ncs    ON ncs.agreement_id = na.agreement_id
JOIN   hz_cust_site_uses_all hcsua  ON hcsua.site_use_id = ncs.customer_site_use_id
WHERE  na.status = 'ACTIVE'
GROUP  BY na.agreement_name;
\`\`\`

If a site is missing that should be included, add it through Cash Management → Setup → Netting Agreements → Sites tab.

### 2.3 Transaction Type Configuration Check

\`\`\`sql
-- AP transaction types on each agreement
SELECT na.agreement_name,
       'AP' AS side,
       natt.transaction_type,
       natt.include_flag
FROM   ce_netting_agreements na
JOIN   ce_netting_ap_trx_types natt ON natt.agreement_id = na.agreement_id
WHERE  na.status = 'ACTIVE'
UNION ALL
-- AR transaction types
SELECT na.agreement_name,
       'AR' AS side,
       nart.transaction_type,
       nart.include_flag
FROM   ce_netting_agreements na
JOIN   ce_netting_ar_trx_types nart ON nart.agreement_id = na.agreement_id
WHERE  na.status = 'ACTIVE'
ORDER  BY 1, 2, 3;
\`\`\`

Ensure all transaction types the business expects to net are set to INCLUDE_FLAG = 'Y'.

---

## Phase 3 — Batch Diagnosis and Recovery

### 3.1 Batch Status Overview

\`\`\`sql
SELECT cnb.batch_status,
       COUNT(*)                                AS batch_count,
       SUM(cnb.netting_amount)                 AS total_netting_amount,
       MIN(cnb.creation_date)                  AS oldest_batch,
       MAX(cnb.creation_date)                  AS newest_batch
FROM   ce_netting_batches cnb
WHERE  cnb.creation_date > SYSDATE - 90
GROUP  BY cnb.batch_status
ORDER  BY batch_count DESC;
\`\`\`

Status values and what they mean:

| Status | Meaning |
|--------|---------|
| PROPOSED | Batch created, awaiting review |
| APPROVED | Approved by user, awaiting settlement run |
| SETTLED | Settlement concurrent program completed successfully |
| CANCELLED | Manually cancelled |
| ERROR | Settlement attempted and failed |

### 3.2 Detail on a Specific Batch

\`\`\`sql
-- Replace :batch_id with the batch you are investigating
SELECT cnb.batch_id,
       cnb.batch_name,
       cnb.batch_status,
       na.agreement_name,
       cnb.netting_amount,
       cnb.currency_code,
       cnb.creation_date,
       cnb.last_update_date,
       cnb.created_by,
       fnd_user.user_name        AS created_by_user,
       cnb.settlement_date,
       cnb.ap_concurrent_request_id,
       cnb.ar_concurrent_request_id
FROM   ce_netting_batches cnb
JOIN   ce_netting_agreements na ON na.agreement_id = cnb.agreement_id
JOIN   fnd_user                 ON fnd_user.user_id = cnb.created_by
WHERE  cnb.batch_id = :batch_id;
\`\`\`

Note the AP and AR concurrent request IDs — these are the settlement jobs to check.

### 3.3 Concurrent Request Detail for Failed Settlement

\`\`\`sql
-- Check both AP and AR settlement request status
SELECT fcr.request_id,
       fcr.phase_code,
       fcr.status_code,
       SUBSTR(fcr.completion_text, 1, 200) AS completion_text,
       fcr.actual_start_date,
       fcr.actual_completion_date,
       fcp.user_concurrent_program_name
FROM   fnd_concurrent_requests fcr
JOIN   fnd_concurrent_programs fcp
       ON fcp.concurrent_program_id = fcr.concurrent_program_id
WHERE  fcr.request_id IN (:ap_request_id, :ar_request_id);
\`\`\`

Status codes: E = Error, G = Warning, C = Completed, X = Terminated.

### 3.4 Recovering a Batch Stuck in APPROVED Status

**Step 1** — Confirm no settlement request is running or pending:
\`\`\`sql
SELECT fcr.request_id, fcr.phase_code, fcr.status_code
FROM   fnd_concurrent_requests fcr
JOIN   fnd_concurrent_programs fcp ON fcp.concurrent_program_id = fcr.concurrent_program_id
WHERE  fcp.concurrent_program_name = 'CENETSETTLEMENT'
  AND  fcr.phase_code IN ('P','R')   -- Pending or Running
  AND  fcr.request_date > SYSDATE - 1;
\`\`\`

If a request is pending or running, wait for it to complete before re-submitting.

**Step 2** — Re-submit the settlement from the UI:
Navigate to Cash Management → Netting → Netting Batches → query the batch → Actions → Create Netting Settlements.

**Step 3** — If the UI submission fails, check for locks:
\`\`\`sql
SELECT obj.object_name,
       s.sid, s.serial#, s.username, s.status,
       l.type, l.lmode, l.request
FROM   v\$lock l
JOIN   v\$session s   ON s.sid = l.sid
JOIN   dba_objects obj ON obj.object_id = l.id1
WHERE  obj.object_name IN ('CE_NETTING_BATCHES','CE_NETTING_TRANSACTIONS')
  AND  l.lmode > 0;
\`\`\`

If a session holds a lock on CE_NETTING_BATCHES, identify the session and coordinate termination if it is an orphaned concurrent request.

### 3.5 Cancelling a Duplicate or Erroneous Batch

**Via UI**: Cash Management → Netting → Netting Batches → Actions → Cancel Batch

**Via SQL** (use only if UI cancel fails and batch is in PROPOSED or APPROVED status, never on SETTLED):
\`\`\`sql
-- Confirm batch is in cancellable state
SELECT batch_id, batch_name, batch_status FROM ce_netting_batches WHERE batch_id = :batch_id;

-- Update (requires Apps schema access and a service request if in production)
UPDATE ce_netting_batches
SET    batch_status = 'CANCELLED',
       last_update_date = SYSDATE,
       last_updated_by = :fnd_user_id
WHERE  batch_id = :batch_id
  AND  batch_status IN ('PROPOSED','APPROVED');

COMMIT;
\`\`\`

Log the cancellation in the change management system with the justification.

---

## Phase 4 — AR Receipt Cleanup

### 4.1 Identify Unapplied Netting Receipts

\`\`\`sql
SELECT acr.cash_receipt_id,
       acr.receipt_number,
       acr.amount,
       acr.currency_code,
       acr.status,
       acr.receipt_date,
       acr.comments,
       cnb.batch_id,
       cnb.batch_name,
       cnb.batch_status
FROM   ar_cash_receipts_all acr
JOIN   ce_netting_transactions cnt ON cnt.receipt_id = acr.cash_receipt_id
JOIN   ce_netting_batches cnb      ON cnb.batch_id = cnt.batch_id
WHERE  acr.status NOT IN ('APP','UNID','REV')
ORDER  BY acr.receipt_date DESC;
\`\`\`

### 4.2 Manual Receipt Application (When Automatic Application Failed)

When a netting receipt is in UNAPP (unapplied) status and the AR invoice is still open:

1. Navigate to Receivables → Receipts → Apply
2. Query the receipt by receipt number
3. On the Applications tab, find the open invoice and apply manually
4. Save and confirm the application

Alternatively, use the Lockbox Application program or the Apply Receipts concurrent program if bulk application is needed.

### 4.3 Reversing an Incorrect Netting Receipt

If the netting receipt should not have been created (wrong batch was settled):

\`\`\`sql
-- Confirm receipt has not been applied before reversing
SELECT acr.receipt_number, acr.status, acr.amount,
       NVL((SELECT SUM(ara.amount_applied)
            FROM ar_receivable_applications_all ara
            WHERE ara.cash_receipt_id = acr.cash_receipt_id
              AND ara.status = 'APP'), 0) AS applied_amount
FROM   ar_cash_receipts_all acr
WHERE  acr.cash_receipt_id = :receipt_id;
\`\`\`

If applied_amount > 0, unapply first (via Receivables → Receipts → Apply → remove application), then reverse via Receivables → Receipts → Reverse.

---

## Phase 5 — AP Side Integrity

### 5.1 AP Invoices Showing Unpaid Despite Settled Netting Batch

\`\`\`sql
-- Identify AP invoices in settled batches that still show payment_status_flag != 'Y'
SELECT aia.invoice_id,
       aia.invoice_num,
       aia.invoice_date,
       aia.invoice_amount,
       pv.vendor_name,
       pvs.vendor_site_code,
       aps.amount_remaining,
       aps.payment_status_flag,
       cnb.batch_name,
       cnb.batch_status,
       cnb.settlement_date
FROM   ce_netting_batches cnb
JOIN   ce_netting_transactions cnt  ON cnt.batch_id = cnb.batch_id
JOIN   ap_invoices_all aia          ON aia.invoice_id = cnt.ap_invoice_id
JOIN   ap_payment_schedules_all aps ON aps.invoice_id = aia.invoice_id
JOIN   po_vendors pv                ON pv.vendor_id = aia.vendor_id
JOIN   po_vendor_sites_all pvs      ON pvs.vendor_site_id = aia.vendor_site_id
WHERE  cnb.batch_status = 'SETTLED'
  AND  cnt.ap_invoice_id IS NOT NULL
  AND  aps.payment_status_flag != 'Y';
\`\`\`

### 5.2 Check Whether AP Payment Record Was Created

\`\`\`sql
SELECT ac.check_id,
       ac.check_number,
       ac.amount,
       ac.status_lookup_code,
       ac.void_date,
       aip.invoice_id,
       aip.amount AS invoice_payment_amount
FROM   ap_checks_all ac
JOIN   ap_invoice_payments_all aip ON aip.check_id = ac.check_id
WHERE  aip.invoice_id = :invoice_id
ORDER  BY ac.creation_date DESC;
\`\`\`

If no check record exists, the AP concurrent program failed to create the netting payment. Re-run CENETSETTLEMENT for the batch after validating the AP period is open.

### 5.3 Check AP Accounting Entries (SLA)

\`\`\`sql
SELECT xe.event_id,
       xe.event_type_code,
       xe.event_status_code,
       xe.on_hold_flag,
       xh.je_category_name,
       xh.accounting_date,
       xld.accounted_dr,
       xld.accounted_cr,
       gcc.concatenated_segments AS account
FROM   xla_events xe
JOIN   xla_ae_headers xh ON xh.event_id = xe.event_id
JOIN   xla_ae_lines xld   ON xld.ae_header_id = xh.ae_header_id
JOIN   gl_code_combinations_kfv gcc ON gcc.code_combination_id = xld.code_combination_id
WHERE  xe.source_id_int_1 = :check_id   -- AP check ID
  AND  xe.application_id = 200           -- AP
ORDER  BY xe.event_id, xld.ae_line_num;
\`\`\`

Events with EVENT_STATUS_CODE = 'I' (incomplete) or ON_HOLD_FLAG = 'Y' require the Create Accounting concurrent program to be re-run.

---

## Phase 6 — Period Close with Netting

### 6.1 Pre-Close Netting Checklist

Run this SQL before closing AP or AR:

\`\`\`sql
-- Any batches not settled that contain transactions in the period being closed?
SELECT cnb.batch_id,
       cnb.batch_name,
       cnb.batch_status,
       cnb.netting_amount,
       cnb.currency_code,
       na.agreement_name
FROM   ce_netting_batches cnb
JOIN   ce_netting_agreements na  ON na.agreement_id = cnb.agreement_id
JOIN   ce_netting_transactions cnt ON cnt.batch_id = cnb.batch_id
JOIN   ap_invoices_all aia       ON aia.invoice_id = cnt.ap_invoice_id
WHERE  cnb.batch_status NOT IN ('SETTLED','CANCELLED')
  AND  aia.invoice_date BETWEEN :period_start AND :period_end
GROUP  BY cnb.batch_id, cnb.batch_name, cnb.batch_status,
          cnb.netting_amount, cnb.currency_code, na.agreement_name;
\`\`\`

Any PROPOSED or APPROVED batch that covers transactions in the period being closed must either be settled or cancelled before close. Settling post-period-close requires reopening the period.

### 6.2 Confirm Netting Accounting Is Transferred to GL

\`\`\`sql
-- Netting journal entries transferred to GL
SELECT gjh.je_batch_id,
       gjh.je_batch_name,
       gjh.name          AS je_header_name,
       gjh.period_name,
       gjh.je_source,
       gjh.status,
       gjh.actual_flag,
       gjh.posted_date
FROM   gl_je_headers gjh
WHERE  gjh.je_source IN ('Payables','Receivables','Cash Management')
  AND  gjh.period_name = :period_name
  AND  gjh.je_category_name LIKE '%Netting%'
ORDER  BY gjh.creation_date DESC;
\`\`\`

Status should be P (Posted). If U (Unposted), run the Journal Import and Post Journals programs.

---

## Phase 7 — Complete Monitoring Script

Install and schedule the full AP/AR Netting Analyzer as the applmgr OS user.

### 7.1 Install

\`\`\`bash
cat > /opt/scripts/ebs_netting_check.sh << 'SCRIPT'
#!/bin/bash
# =====================================================
# Oracle EBS AP/AR Netting Analyzer
# Schedule: 0 6 * * 1-5   (weekdays at 6 AM)
# =====================================================

ORACLE_HOME=/u01/app/oracle/product/19c/dbhome_1
ORACLE_SID=EBSPROD
APPS_USER=apps
APPS_PASS=\${APPS_PASSWORD:-apps}
ALERT_EMAIL=ebs-finance-dba@example.com
LOG=/var/log/ebs_netting_check.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
ALERT=0
ALERT_BODY=""

export ORACLE_HOME ORACLE_SID
export PATH=\${ORACLE_HOME}/bin:\${PATH}
export NLS_DATE_FORMAT="YYYY-MM-DD HH24:MI:SS"

log()   { echo "[\${TIMESTAMP}] \$*" | tee -a "\${LOG}"; }
alert() { ALERT=1; ALERT_BODY="\${ALERT_BODY}\n\$*"; log "ALERT: \$*"; }

check_stale_batches() {
  log "--- Checking for stale approved netting batches ---"
  RESULT=\$(sqlplus -s "\${APPS_USER}/\${APPS_PASS}" <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMOUT ON TRIMSPOOL ON
SELECT 'BATCH_ID=' || cnb.batch_id
       || ' NAME=' || cnb.batch_name
       || ' AGREEMENT=' || na.agreement_name
       || ' DAYS_STALE=' || TRUNC(SYSDATE - cnb.last_update_date)
FROM   ce_netting_batches cnb
JOIN   ce_netting_agreements na ON na.agreement_id = cnb.agreement_id
WHERE  cnb.batch_status = 'APPROVED'
  AND  cnb.last_update_date < SYSDATE - 2
ORDER  BY cnb.last_update_date;
EXIT
SQLEOF
)
  if [ -n "\${RESULT}" ]; then
    while IFS= read -r line; do [ -n "\${line}" ] && alert "Stale approved batch: \${line}"; done <<< "\${RESULT}"
  else
    log "No stale approved netting batches"
  fi
}

check_settlement_failures() {
  log "--- Checking netting settlement failures (last 24h) ---"
  RESULT=\$(sqlplus -s "\${APPS_USER}/\${APPS_PASS}" <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMOUT ON TRIMSPOOL ON
SELECT 'REQ=' || fcr.request_id
       || ' STATUS=' || fcr.status_code
       || ' MSG=' || SUBSTR(fcr.completion_text,1,100)
FROM   fnd_concurrent_requests fcr
JOIN   fnd_concurrent_programs fcp ON fcp.concurrent_program_id = fcr.concurrent_program_id
WHERE  fcp.concurrent_program_name = 'CENETSETTLEMENT'
  AND  fcr.status_code IN ('E','G','X')
  AND  fcr.actual_start_date > SYSDATE - 1
ORDER  BY fcr.request_id DESC;
EXIT
SQLEOF
)
  if [ -n "\${RESULT}" ]; then
    while IFS= read -r line; do [ -n "\${line}" ] && alert "Settlement failure: \${line}"; done <<< "\${RESULT}"
  else
    log "No settlement failures in last 24 hours"
  fi
}

check_unapplied_receipts() {
  log "--- Checking unapplied AR netting receipts ---"
  RESULT=\$(sqlplus -s "\${APPS_USER}/\${APPS_PASS}" <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMOUT ON TRIMSPOOL ON
SELECT 'RECEIPT=' || acr.receipt_number
       || ' AMOUNT=' || acr.amount
       || ' STATUS=' || acr.status
       || ' BATCH=' || cnb.batch_name
FROM   ar_cash_receipts_all acr
JOIN   ce_netting_transactions cnt ON cnt.receipt_id = acr.cash_receipt_id
JOIN   ce_netting_batches cnb      ON cnb.batch_id = cnt.batch_id
WHERE  acr.status NOT IN ('APP','UNID','REV')
  AND  acr.creation_date > SYSDATE - 30
ORDER  BY acr.creation_date DESC
FETCH  FIRST 20 ROWS ONLY;
EXIT
SQLEOF
)
  if [ -n "\${RESULT}" ]; then
    while IFS= read -r line; do [ -n "\${line}" ] && alert "Unapplied netting receipt: \${line}"; done <<< "\${RESULT}"
  else
    log "No unapplied AR netting receipts"
  fi
}

check_ap_payment_integrity() {
  log "--- Checking AP payment integrity for settled batches ---"
  RESULT=\$(sqlplus -s "\${APPS_USER}/\${APPS_PASS}" <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMOUT ON TRIMSPOOL ON
SELECT 'INVOICE=' || aia.invoice_num
       || ' VENDOR=' || pv.vendor_name
       || ' REMAINING=' || aps.amount_remaining
       || ' BATCH=' || cnb.batch_name
FROM   ce_netting_batches cnb
JOIN   ce_netting_transactions cnt  ON cnt.batch_id = cnb.batch_id
JOIN   ap_invoices_all aia          ON aia.invoice_id = cnt.ap_invoice_id
JOIN   ap_payment_schedules_all aps ON aps.invoice_id = aia.invoice_id
JOIN   po_vendors pv                ON pv.vendor_id = aia.vendor_id
WHERE  cnb.batch_status = 'SETTLED'
  AND  cnb.last_update_date > SYSDATE - 7
  AND  aps.payment_status_flag != 'Y'
  AND  cnt.ap_invoice_id IS NOT NULL;
EXIT
SQLEOF
)
  if [ -n "\${RESULT}" ]; then
    while IFS= read -r line; do [ -n "\${line}" ] && alert "AP invoice unpaid in settled batch: \${line}"; done <<< "\${RESULT}"
  else
    log "AP payment integrity OK"
  fi
}

check_period_mismatch() {
  log "--- Checking AP/AR period alignment ---"
  RESULT=\$(sqlplus -s "\${APPS_USER}/\${APPS_PASS}" <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMOUT ON TRIMSPOOL ON
SELECT 'PERIOD=' || ap.period_name
       || ' AP_STATUS=' || ap.closing_status
       || ' AR_STATUS=' || ar.closing_status
FROM   gl_period_statuses ap, gl_period_statuses ar
WHERE  ap.application_id = 200
  AND  ar.application_id = 222
  AND  ap.period_name = ar.period_name
  AND  ap.set_of_books_id = ar.set_of_books_id
  AND  ap.closing_status != ar.closing_status
  AND  ap.period_year = TO_NUMBER(TO_CHAR(SYSDATE,'YYYY'))
ORDER  BY ap.period_name DESC
FETCH  FIRST 3 ROWS ONLY;
EXIT
SQLEOF
)
  if [ -n "\${RESULT}" ]; then
    while IFS= read -r line; do [ -n "\${line}" ] && alert "AP/AR period mismatch: \${line}"; done <<< "\${RESULT}"
  else
    log "AP/AR period statuses aligned"
  fi
}

check_inactive_agreements() {
  log "--- Checking for agreements with no recent batch activity ---"
  RESULT=\$(sqlplus -s "\${APPS_USER}/\${APPS_PASS}" <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMOUT ON TRIMSPOOL ON
SELECT 'AGREEMENT=' || na.agreement_name
       || ' LAST_BATCH=' || NVL(TO_CHAR(MAX(cnb.creation_date),'YYYY-MM-DD'),'NEVER')
FROM   ce_netting_agreements na
LEFT JOIN ce_netting_batches cnb ON cnb.agreement_id = na.agreement_id
WHERE  na.status = 'ACTIVE'
GROUP  BY na.agreement_name
HAVING MAX(cnb.creation_date) < SYSDATE - 30
    OR MAX(cnb.creation_date) IS NULL;
EXIT
SQLEOF
)
  if [ -n "\${RESULT}" ]; then
    while IFS= read -r line; do [ -n "\${line}" ] && log "INFO: Inactive agreement: \${line}"; done <<< "\${RESULT}"
  else
    log "All active agreements have recent batch activity"
  fi
}

send_alert() {
  if [ "\${ALERT}" -eq 1 ]; then
    printf "Oracle EBS AP/AR Netting Alert\nHost: \$(hostname)\nTime: \${TIMESTAMP}\n\nIssues:\n\${ALERT_BODY}\n\nLog: \${LOG}\n" \
      | mail -s "EBS Netting Alert - \$(hostname)" "\${ALERT_EMAIL}"
    log "Alert sent to \${ALERT_EMAIL}"
  else
    log "All netting checks passed"
  fi
}

log "====== EBS Netting Check Start ======"
check_stale_batches
check_settlement_failures
check_unapplied_receipts
check_ap_payment_integrity
check_period_mismatch
check_inactive_agreements
send_alert
log "====== EBS Netting Check End ======"
SCRIPT

chmod 750 /opt/scripts/ebs_netting_check.sh
chown applmgr:oinstall /opt/scripts/ebs_netting_check.sh
\`\`\`

### 7.2 Crontab Schedule

Add as applmgr user (\`crontab -e\`):

\`\`\`
# AP/AR Netting Analyzer — weekdays 6 AM
0 6 * * 1-5 APPS_PASSWORD=apps /opt/scripts/ebs_netting_check.sh >> /var/log/ebs_netting_cron.log 2>&1

# Pre-close additional check — 2 PM on the 28th through 31st (catches month-end)
0 14 28-31 * * APPS_PASSWORD=apps /opt/scripts/ebs_netting_check.sh >> /var/log/ebs_netting_cron.log 2>&1
\`\`\`

---

## Phase 8 — Maintenance Calendar

### Daily (automated by script)
- Stale approved batch detection (> 2 days)
- Settlement concurrent failure scan
- Unapplied AR netting receipt check
- AP payment integrity verification
- AP/AR period alignment check

### Weekly
- Review inactive agreements (active but no batch in 30 days)
- Audit CE_NETTING_TRANSACTIONS for any cancelled batch remnants
- Confirm bank account balances align with netting offset volumes

### Monthly (at period close)
- Run pre-close netting checklist SQL (Phase 6.1)
- Confirm all netting journal entries are posted in GL (Phase 6.2)
- Review netting volume trends: compare batch count and amount by agreement month-over-month
- Rotate APPS_PASSWORD in crontab if the apps password was changed

### Quarterly
- Re-validate netting agreement configuration against current vendor/customer master
- Review bank account status — confirm no accounts have been deactivated since last quarter
- Check for new Oracle patches addressing CE (Cash Management) netting bugs via MOS
- Test settlement concurrent programs in a non-production environment if patches were applied

---

## Phase 9 — Troubleshooting Quick Reference

| Symptom | Check | Fix |
|---------|-------|-----|
| Zero transactions in batch proposal | CE_NETTING_VENDOR_SITES / CE_NETTING_CUST_SITES | Add missing vendor or customer site to agreement |
| Credit memos excluded from netting | CE_NETTING_AP_TRX_TYPES / CE_NETTING_AR_TRX_TYPES | Set include_flag = Y for the transaction type |
| CENETSETTLEMENT ends with Warning | FND_CONCURRENT_REQUESTS.completion_text | Check AP period, payment document limit, XLA period |
| Batch stuck in APPROVED for days | FND_CONCURRENT_REQUESTS for CENETSETTLEMENT | Re-submit settlement from UI or check for session locks |
| AR receipt UNAPP after settlement | AR_CASH_RECEIPTS_ALL.status | Manually apply receipt to open AR invoice |
| AP invoice still open after settlement | AP_PAYMENT_SCHEDULES_ALL.payment_status_flag | Verify AP check was created; re-run CENETSETTLEMENT |
| Duplicate invoices in two batches | CE_NETTING_TRANSACTIONS cross-batch query | Cancel the duplicate batch before settlement |
| Settlement fails with XLA-95010 | GL_PERIOD_STATUSES for SLA (application_id 602) | Open the SLA period for the settlement date |
| Netting amounts not in GL | GL_JE_HEADERS for Netting journal | Run Journal Import then Post Journals |`,
};

async function main() {
  await db
    .insert(posts)
    .values(post)
    .onConflictDoUpdate({
      target: posts.slug,
      set: { title: post.title, content: post.content, excerpt: post.excerpt, updatedAt: new Date() },
    });
  console.log('Inserted:', post.slug);
}

main().catch(console.error);
