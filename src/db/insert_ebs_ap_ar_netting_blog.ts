import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS AP/AR Netting Analyzer: Diagnosing and Resolving Batch and Setup Errors',
  slug: 'oracle-ebs-ap-ar-netting-analyzer-batch-setup-errors',
  excerpt:
    'A technical deep-dive into the Oracle EBS AP/AR Netting feature — how netting agreements, batch creation, and settlement processing work under the hood, what goes wrong with setup mismatches and concurrent program failures, and a complete diagnostic shell script with crontab scheduling to catch netting errors before they hit the close.',
  category: 'ebs-functional' as const,
  isPremium: false,
  published: true,
  publishedAt: new Date('2026-06-19'),
  content: `Oracle EBS AP/AR Netting allows a company to offset open payables against receivables for the same trading partner — reducing payment volume, cutting bank fees, and simplifying reconciliation. When it works, it is nearly invisible. When it breaks, it surfaces at the worst possible time: period close, vendor payment run, or a customer dispute where the offset the controller assumed happened simply did not. This post covers how netting works, what the common failure modes look like from the database and concurrent program output, and how to diagnose them systematically.

---

## How AP/AR Netting Works in EBS

Netting in EBS R12 is orchestrated through three objects:

### 1. Netting Agreements
A **Netting Agreement** (CE_NETTING_AGREEMENTS) defines the rules for a netting relationship:
- Which legal entity and operating unit participates
- Which bank account receives settlement entries
- The settlement currency and currency conversion rule
- Whether to net ALL invoices or only those meeting a maturity date window
- The AP and AR transaction types eligible for netting

Agreements are set up in **Cash Management → Setup → Netting Agreements**. A single trading partner can have multiple agreements (e.g., one per currency or one per line of business), but each agreement must have a unique combination of legal entity + bank account + currency.

### 2. Netting Batches
A **Netting Batch** (CE_NETTING_BATCHES) is a run of the netting process for a specific agreement. When a batch is created, EBS:
1. Selects open AP invoices that match the agreement criteria (vendor site, transaction type, due date)
2. Selects open AR transactions that match (customer site, transaction type, due date)
3. Creates a proposed offset — netting the two sides against each other
4. Writes the proposed netting to CE_NETTING_TRANSACTIONS

The batch sits in **Proposed** status until a user reviews and approves it.

### 3. Settlement Processing
When the batch is approved and the **Create Netting Settlements** concurrent program runs, EBS:
- Creates AP payment records in AP_PAYMENT_SCHEDULES_ALL (marking invoices as paid)
- Creates AR receipt records in AR_CASH_RECEIPTS_ALL (applying receipts to invoices)
- Creates accounting entries in CE_STATEMENT_HEADERS / XLA_EVENTS for the bank account side
- Advances batch status to **Settled**

Each step leaves audit trails in the batch header and individual transaction records, which is where diagnosis starts.

---

## Common Failure Modes

### Setup Error 1 — Netting Agreement Bank Account Mismatch

**Symptom**: Batch creates with zero transactions selected despite known open payables and receivables for the vendor/customer.

**Root cause**: The bank account on the netting agreement is not assigned to the operating unit, or the bank account is inactive.

**Where to look**:
\`\`\`sql
-- Check bank account assignment for netting agreement
SELECT na.agreement_name,
       na.agreement_id,
       ba.bank_account_num,
       ba.account_name,
       ba.account_inactive_date,
       aou.name AS operating_unit
FROM   ce_netting_agreements na
JOIN   ce_bank_accounts ba       ON ba.bank_account_id = na.bank_account_id
JOIN   ce_bank_acct_uses_all bau ON bau.bank_account_id = ba.bank_account_id
JOIN   hr_operating_units aou    ON aou.organization_id = bau.org_id
WHERE  na.agreement_name LIKE '%&agreement_name%';
\`\`\`

**Fix**: In Cash Management → Bank Accounts, verify the bank account is active and the operating unit is included in the account access list. If the account was deactivated as part of a bank migration, create a new agreement pointing to the replacement account.

---

### Setup Error 2 — Vendor/Customer Site Not Linked

**Symptom**: AP invoices for a vendor exist but do not appear in the netting batch proposal.

**Root cause**: The netting agreement references a different vendor site than the invoices, or the trading partner link between the AP supplier and AR customer is not configured.

**Where to look**:
\`\`\`sql
-- Check which vendor sites are on the netting agreement
SELECT na.agreement_name,
       nvs.vendor_id,
       pvs.vendor_name,
       pvs.segment1 AS vendor_num,
       nvs.vendor_site_id,
       pvss.vendor_site_code
FROM   ce_netting_agreements na
JOIN   ce_netting_vendor_sites nvs  ON nvs.agreement_id = na.agreement_id
JOIN   po_vendors pvs               ON pvs.vendor_id = nvs.vendor_id
JOIN   po_vendor_sites_all pvss     ON pvss.vendor_site_id = nvs.vendor_site_id
WHERE  na.agreement_id = &agreement_id;

-- Check corresponding customer link
SELECT na.agreement_name,
       ncs.customer_id,
       hca.account_number,
       hca.account_name,
       ncs.customer_site_use_id,
       hcsua.location
FROM   ce_netting_agreements na
JOIN   ce_netting_cust_sites ncs    ON ncs.agreement_id = na.agreement_id
JOIN   hz_cust_accounts hca         ON hca.cust_account_id = ncs.customer_id
JOIN   hz_cust_site_uses_all hcsua  ON hcsua.site_use_id = ncs.customer_site_use_id
WHERE  na.agreement_id = &agreement_id;
\`\`\`

If the vendor and customer rows are missing or mismatched, re-open the agreement in the UI and add the correct sites.

---

### Setup Error 3 — Transaction Type Exclusion

**Symptom**: Some invoice types (e.g., debit memos, credit memos) never appear in netting proposals.

**Root cause**: The netting agreement's transaction type configuration excludes those invoice types. EBS allows agreements to restrict netting to specific AP invoice types (Standard, Credit, Debit Memo) and AR transaction types (Invoice, Debit Memo, Credit Memo, Chargeback).

**Where to look**:
\`\`\`sql
-- AP invoice types eligible on agreement
SELECT na.agreement_name,
       natt.transaction_type,
       natt.include_flag
FROM   ce_netting_agreements na
JOIN   ce_netting_ap_trx_types natt ON natt.agreement_id = na.agreement_id
WHERE  na.agreement_id = &agreement_id
ORDER  BY natt.transaction_type;

-- Verify open invoices by type that should be netting
SELECT aia.invoice_type_lookup_code,
       COUNT(*)             AS invoice_count,
       SUM(aps.amount_remaining) AS remaining_amount
FROM   ap_invoices_all aia
JOIN   ap_payment_schedules_all aps ON aps.invoice_id = aia.invoice_id
JOIN   po_vendors pv                ON pv.vendor_id = aia.vendor_id
WHERE  pv.vendor_id = &vendor_id
  AND  aps.payment_status_flag = 'N'
  AND  aia.cancelled_date IS NULL
GROUP  BY aia.invoice_type_lookup_code;
\`\`\`

---

### Batch Error 1 — Concurrent Program Failure on Netting Settlement

**Symptom**: Batch status stays at **Approved** and never advances to **Settled**. The concurrent request for **Create Netting Settlements** (CENETSETTLEMENT) completes with a Warning or Error status.

**Where to look in the concurrent output**:
\`\`\`sql
-- Find the failed concurrent request
SELECT fcr.request_id,
       fcr.phase_code,
       fcr.status_code,
       fcr.completion_text,
       fcr.actual_start_date,
       fcr.actual_completion_date,
       fcp.user_concurrent_program_name
FROM   fnd_concurrent_requests fcr
JOIN   fnd_concurrent_programs_vl fcp
       ON fcp.concurrent_program_id = fcr.concurrent_program_id
WHERE  fcp.concurrent_program_name = 'CENETSETTLEMENT'
ORDER  BY fcr.request_id DESC
FETCH  FIRST 10 ROWS ONLY;
\`\`\`

The completion_text often contains the short error. For the full log, check \`fnd_file.put_line\` output in the concurrent log file or query:
\`\`\`sql
SELECT fl.file_name,
       fl.file_type,
       fl.file_content_type
FROM   fnd_concurrent_requests fcr
JOIN   fnd_lobs fl ON fl.file_name LIKE '%' || fcr.request_id || '%'
WHERE  fcr.request_id = &request_id;
\`\`\`

---

### Batch Error 2 — AP Payment Creation Failure (ORA-20001 or FND Error)

**Symptom**: Settlement concurrent program errors with an AP-specific error. Common causes:

| Error | Cause |
|-------|-------|
| AP-04567: Payment cannot be created | Payment document on bank account exhausted or inactive |
| ORA-20001: PAYGROUP mismatch | Invoice pay group does not match payment document |
| FND-SQLAP-10771 | AP period is closed — cannot create payment in this period |
| XLA-95010 | Subledger accounting period is closed |

**Check AP period and payment document**:
\`\`\`sql
-- AP period status
SELECT fpsv.period_name,
       fpsv.closing_status,
       fpsv.set_of_books_id
FROM   gl_period_statuses fpsv
JOIN   ap_system_parameters_all asp ON asp.set_of_books_id = fpsv.set_of_books_id
WHERE  fpsv.application_id = 200   -- AP application
  AND  fpsv.period_name = (SELECT period_name FROM gl_date_period_map
                            WHERE trunc(sysdate) BETWEEN start_date AND end_date
                              AND ROWNUM = 1);

-- Payment document status on netting bank account
SELECT cba.bank_account_num,
       cpd.payment_document_name,
       cpd.payment_method_code,
       cpd.next_available_document_num,
       cpd.last_document_num,
       cpd.payment_document_status
FROM   ce_bank_accounts cba
JOIN   ce_payment_documents cpd ON cpd.bank_account_id = cba.bank_account_id
WHERE  cba.bank_account_id = &bank_account_id;
\`\`\`

---

### Batch Error 3 — AR Receipt Application Failure

**Symptom**: AP side of the netting settles (payment created) but AR side fails — receipts are created but remain unapplied, leaving the AR invoice still open.

**Check for unapplied netting receipts**:
\`\`\`sql
-- Netting receipts that failed to apply
SELECT acr.cash_receipt_id,
       acr.receipt_number,
       acr.amount,
       acr.status,
       acr.comments,
       cnb.batch_name,
       cnb.batch_id
FROM   ar_cash_receipts_all acr
JOIN   ce_netting_transactions cnt ON cnt.receipt_id = acr.cash_receipt_id
JOIN   ce_netting_batches cnb      ON cnb.batch_id = cnt.batch_id
WHERE  acr.status NOT IN ('APP', 'UNID')
  AND  acr.comments LIKE '%Netting%'
ORDER  BY acr.creation_date DESC;
\`\`\`

Unapplied netting receipts usually indicate that the AR invoice was already closed (paid by another receipt) between batch proposal and settlement, or an AR period close issue.

---

### Batch Error 4 — Duplicate Netting Batch for Same Transactions

**Symptom**: Two netting batches both contain the same AP invoice or AR transaction. One settles; the other fails at settlement with an "already applied" or "already paid" error.

**Root cause**: The lock on transactions at proposal time does not prevent a second batch proposal before the first is approved. This happens when two batches are created in quick succession for the same agreement.

**Find duplicate netting of an invoice**:
\`\`\`sql
SELECT cnt.ap_invoice_id,
       aia.invoice_num,
       cnt.batch_id,
       cnb.batch_name,
       cnb.batch_status,
       cnt.netting_amount
FROM   ce_netting_transactions cnt
JOIN   ce_netting_batches cnb ON cnb.batch_id = cnt.batch_id
JOIN   ap_invoices_all aia    ON aia.invoice_id = cnt.ap_invoice_id
WHERE  cnt.ap_invoice_id IS NOT NULL
  AND  cnb.batch_status NOT IN ('CANCELLED')
GROUP  BY cnt.ap_invoice_id, aia.invoice_num, cnt.batch_id, cnb.batch_name, cnb.batch_status, cnt.netting_amount
HAVING COUNT(*) > 1
   OR  cnt.ap_invoice_id IN (
         SELECT ap_invoice_id FROM ce_netting_transactions
         WHERE  batch_id != cnt.batch_id
           AND  ap_invoice_id IS NOT NULL);
\`\`\`

Resolution: cancel the duplicate batch using the CE: Netting Batches UI or directly update CE_NETTING_BATCHES.BATCH_STATUS = 'CANCELLED' after confirming which batch should survive.

---

## Monitoring and Alerting

### AP/AR Netting Diagnostic Script

The following script runs as a scheduled job and produces a summary of netting issues: stale approved batches, failed settlement programs, unapplied AR receipts from netting, and AP/AR period close mismatches.

\`\`\`bash
#!/bin/bash
# =====================================================
# Oracle EBS AP/AR Netting Analyzer
# Schedule: 0 6 * * 1-5   (weekdays at 6 AM, as applmgr)
# =====================================================

ORACLE_HOME=/u01/app/oracle/product/19c/dbhome_1
ORACLE_SID=EBSPROD
APPS_USER=apps
APPS_PASS=\${APPS_PASSWORD:-apps}   # set APPS_PASSWORD in environment
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

# --------------------------------------------------
# 1. Stale approved batches (approved > 2 days, not settled)
# --------------------------------------------------
check_stale_batches() {
  log "--- Checking for stale approved netting batches ---"
  RESULT=\$(sqlplus -s "\${APPS_USER}/\${APPS_PASS}" <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMOUT ON TRIMSPOOL ON
SELECT 'BATCH_ID=' || cnb.batch_id
       || ' NAME=' || cnb.batch_name
       || ' AGREEMENT=' || na.agreement_name
       || ' STATUS=' || cnb.batch_status
       || ' APPROVED=' || TO_CHAR(cnb.last_update_date,'YYYY-MM-DD')
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
    while IFS= read -r line; do
      [ -n "\${line}" ] && alert "Stale approved netting batch: \${line}"
    done <<< "\${RESULT}"
  else
    log "No stale approved netting batches found"
  fi
}

# --------------------------------------------------
# 2. Failed CENETSETTLEMENT concurrent requests (last 24h)
# --------------------------------------------------
check_settlement_failures() {
  log "--- Checking netting settlement concurrent failures ---"
  RESULT=\$(sqlplus -s "\${APPS_USER}/\${APPS_PASS}" <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMOUT ON TRIMSPOOL ON
SELECT 'REQ_ID=' || fcr.request_id
       || ' STATUS=' || fcr.status_code
       || ' COMPLETION=' || SUBSTR(fcr.completion_text,1,80)
       || ' START=' || TO_CHAR(fcr.actual_start_date,'YYYY-MM-DD HH24:MI')
FROM   fnd_concurrent_requests fcr
JOIN   fnd_concurrent_programs fcp
       ON fcp.concurrent_program_id = fcr.concurrent_program_id
WHERE  fcp.concurrent_program_name = 'CENETSETTLEMENT'
  AND  fcr.status_code IN ('E','G','X')
  AND  fcr.actual_start_date > SYSDATE - 1
ORDER  BY fcr.request_id DESC;
EXIT
SQLEOF
)
  if [ -n "\${RESULT}" ]; then
    while IFS= read -r line; do
      [ -n "\${line}" ] && alert "Netting settlement failure: \${line}"
    done <<< "\${RESULT}"
  else
    log "No netting settlement failures in last 24 hours"
  fi
}

# --------------------------------------------------
# 3. Unapplied AR receipts from netting (status not APP)
# --------------------------------------------------
check_unapplied_receipts() {
  log "--- Checking for unapplied AR netting receipts ---"
  RESULT=\$(sqlplus -s "\${APPS_USER}/\${APPS_PASS}" <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMOUT ON TRIMSPOOL ON
SELECT 'RECEIPT=' || acr.receipt_number
       || ' AMOUNT=' || acr.amount
       || ' CURRENCY=' || acr.currency_code
       || ' STATUS=' || acr.status
       || ' BATCH=' || cnb.batch_name
       || ' CREATED=' || TO_CHAR(acr.creation_date,'YYYY-MM-DD')
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
    while IFS= read -r line; do
      [ -n "\${line}" ] && alert "Unapplied AR netting receipt: \${line}"
    done <<< "\${RESULT}"
  else
    log "No unapplied AR netting receipts found"
  fi
}

# --------------------------------------------------
# 4. AP invoices in settled batches still showing unpaid
# --------------------------------------------------
check_ap_payment_integrity() {
  log "--- Checking AP payment integrity for settled batches ---"
  RESULT=\$(sqlplus -s "\${APPS_USER}/\${APPS_PASS}" <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMOUT ON TRIMSPOOL ON
SELECT 'INVOICE=' || aia.invoice_num
       || ' VENDOR=' || pv.vendor_name
       || ' REMAINING=' || aps.amount_remaining
       || ' BATCH=' || cnb.batch_name
       || ' BATCH_STATUS=' || cnb.batch_status
FROM   ce_netting_batches cnb
JOIN   ce_netting_transactions cnt ON cnt.batch_id = cnb.batch_id
JOIN   ap_invoices_all aia         ON aia.invoice_id = cnt.ap_invoice_id
JOIN   ap_payment_schedules_all aps ON aps.invoice_id = aia.invoice_id
JOIN   po_vendors pv               ON pv.vendor_id = aia.vendor_id
WHERE  cnb.batch_status = 'SETTLED'
  AND  cnb.last_update_date > SYSDATE - 7
  AND  aps.payment_status_flag != 'Y'
  AND  cnt.ap_invoice_id IS NOT NULL
ORDER  BY cnb.last_update_date DESC;
EXIT
SQLEOF
)
  if [ -n "\${RESULT}" ]; then
    while IFS= read -r line; do
      [ -n "\${line}" ] && alert "AP invoice not fully paid despite settled netting batch: \${line}"
    done <<< "\${RESULT}"
  else
    log "AP payment integrity: all settled netting invoices show paid"
  fi
}

# --------------------------------------------------
# 5. AP/AR period close mismatch check
# --------------------------------------------------
check_period_mismatch() {
  log "--- Checking AP/AR period status alignment ---"
  RESULT=\$(sqlplus -s "\${APPS_USER}/\${APPS_PASS}" <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMOUT ON TRIMSPOOL ON
SELECT 'AP_PERIOD=' || ap.period_name || ' STATUS=' || ap.closing_status
       || '  AR_PERIOD=' || ar.period_name || ' STATUS=' || ar.closing_status
       || '  MISMATCH=YES'
FROM   gl_period_statuses ap,
       gl_period_statuses ar
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
    while IFS= read -r line; do
      [ -n "\${line}" ] && alert "AP/AR period status mismatch (blocks netting settlement): \${line}"
    done <<< "\${RESULT}"
  else
    log "AP/AR period statuses are aligned"
  fi
}

# --------------------------------------------------
# 6. Agreements with no batches in 30 days (possible setup issue)
# --------------------------------------------------
check_inactive_agreements() {
  log "--- Checking for agreements with no recent activity ---"
  RESULT=\$(sqlplus -s "\${APPS_USER}/\${APPS_PASS}" <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMOUT ON TRIMSPOOL ON
SELECT 'AGREEMENT=' || na.agreement_name
       || ' STATUS=' || na.status
       || ' LAST_BATCH=' || NVL(TO_CHAR(MAX(cnb.creation_date),'YYYY-MM-DD'),'NEVER')
FROM   ce_netting_agreements na
LEFT JOIN ce_netting_batches cnb ON cnb.agreement_id = na.agreement_id
WHERE  na.status = 'ACTIVE'
GROUP  BY na.agreement_name, na.status
HAVING MAX(cnb.creation_date) < SYSDATE - 30
    OR MAX(cnb.creation_date) IS NULL
ORDER  BY MAX(cnb.creation_date) NULLS FIRST;
EXIT
SQLEOF
)
  if [ -n "\${RESULT}" ]; then
    while IFS= read -r line; do
      [ -n "\${line}" ] && log "INFO - Inactive netting agreement: \${line}"
    done <<< "\${RESULT}"
  else
    log "All active agreements have had recent batch activity"
  fi
}

# --------------------------------------------------
# 7. Send alert email
# --------------------------------------------------
send_alert() {
  if [ "\${ALERT}" -eq 1 ]; then
    printf "Oracle EBS AP/AR Netting Alert\\nHost: \$(hostname)\\nTime: \${TIMESTAMP}\\n\\nIssues detected:\\n\${ALERT_BODY}\\n\\nSee full log: \${LOG}\\n" \
      | mail -s "EBS Netting Alert - \$(hostname)" "\${ALERT_EMAIL}"
    log "Alert email sent to \${ALERT_EMAIL}"
  else
    log "All netting checks passed — no alert sent"
  fi
}

# --------------------------------------------------
# Main
# --------------------------------------------------
log "====== EBS AP/AR Netting Check Start ======"
check_stale_batches
check_settlement_failures
check_unapplied_receipts
check_ap_payment_integrity
check_period_mismatch
check_inactive_agreements
send_alert
log "====== EBS AP/AR Netting Check End ======"
\`\`\`

Schedule in crontab (as applmgr):

\`\`\`
# EBS AP/AR Netting Analyzer — weekdays at 6 AM
0 6 * * 1-5 APPS_PASSWORD=apps /opt/scripts/ebs_netting_check.sh >> /var/log/ebs_netting_cron.log 2>&1

# Additional check at 2 PM on last day of month (pre-close safety check)
0 14 28-31 * * [ "\$(date +\\%d)" = "\$(cal | awk '/[0-9]/{last=\$NF} END{print last}')" ] && APPS_PASSWORD=apps /opt/scripts/ebs_netting_check.sh >> /var/log/ebs_netting_cron.log 2>&1
\`\`\`

---

## Quick Diagnosis Reference

| Symptom | First SQL to run | Likely fix |
|---------|-----------------|------------|
| Batch proposal returns zero rows | Check vendor/customer sites on agreement | Add missing site to agreement |
| Specific invoice type missing from proposal | Query CE_NETTING_AP_TRX_TYPES | Enable excluded invoice type |
| CENETSETTLEMENT ends with Warning | Query FND_CONCURRENT_REQUESTS completion_text | Check AP period, payment document |
| AR receipts created but not applied | Query AR_CASH_RECEIPTS_ALL status | Manual receipt application or reverse |
| Batch stuck in Approved > 2 days | Check for prior failed settlement request | Re-submit CENETSETTLEMENT |
| Duplicate transactions in two batches | Query CE_NETTING_TRANSACTIONS | Cancel the duplicate batch |

---

## Summary

AP/AR Netting in EBS touches three subledgers (AP, AR, Cash Management) and requires period alignment, bank account configuration, and trading partner site setup to all be correct simultaneously. Most failures fall into two categories: setup mismatches that silently exclude transactions from batch proposals, and settlement concurrent program errors that leave batches stranded in Approved status. The diagnostic script above covers both categories — stale batch detection, settlement failure scanning, AR receipt integrity, AP payment verification, and period alignment checks — running daily before the business day starts so that netting problems surface before the finance team tries to close the month.`,
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
