import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS AP/AR Initial Configuration: Setup Sequence, Common Errors, and Diagnostics',
  slug: 'oracle-ebs-ap-ar-initial-configuration-setup-errors',
  excerpt:
    'A technical walkthrough of Oracle EBS Accounts Payable and Accounts Receivable initial setup — the correct configuration sequence, the setup objects that must exist before transactions can be entered, the most common setup errors that block invoice and receipt entry, and a diagnostic shell script to validate the configuration state.',
  category: 'ebs-functional' as const,
  isPremium: false,
  published: true,
  publishedAt: new Date('2026-06-19'),
  content: `Getting Oracle EBS AP and AR configured correctly the first time requires understanding the dependency chain: each setup object depends on the one above it, and transactions cannot flow until every link in that chain is intact. Most initial configuration failures are not caused by wrong values — they are caused by missing steps that the system only surfaces as cryptic errors at transaction entry time, days or weeks after the setup work was done. This post maps the full dependency chain, documents the most common setup gaps, and shows how to query the configuration state directly from the database.

---

## The Setup Dependency Chain

Both AP and AR share a common foundation and then diverge into module-specific configuration. Everything flows from the top:

\`\`\`
Chart of Accounts
       ↓
Accounting Calendar
       ↓
Ledger (Set of Books)
       ↓
Legal Entity
       ↓
Operating Unit (OU)
       ↓
    ┌──┴──┐
   AP     AR
    │      │
Financials  System
 Options   Options
    │      │
Payables  AutoAccounting
 Options   Rules
    │      │
Payment   Transaction
 Terms     Types
    │      │
Bank      Receipt
Accounts  Classes
    │      │
Suppliers Customers
\`\`\`

A gap at any level prevents every object below it from functioning correctly.

---

## Foundation Layer: Ledger and Operating Unit

### Ledger Configuration

The Ledger (formerly Set of Books) binds together the Chart of Accounts, Accounting Calendar, and Currency. Both AP and AR post to the same ledger in a standard single-OU setup.

\`\`\`sql
-- Validate ledger configuration
SELECT gl.ledger_id,
       gl.name                    AS ledger_name,
       gl.currency_code,
       gl.period_set_name         AS calendar,
       gl.chart_of_accounts_id,
       gl.ledger_category_code,
       gl.completion_status
FROM   gl_ledgers gl
WHERE  gl.ledger_category_code = 'PRIMARY'
ORDER  BY gl.name;
\`\`\`

COMPLETION_STATUS must be 'COMPLETE'. A ledger in 'INCOMPLETE' state blocks period open and subledger accounting.

### Operating Unit Assignment

The Operating Unit connects the ledger to AP and AR transactions. Every invoice, receipt, and payment belongs to an OU.

\`\`\`sql
-- Verify OU is assigned to a ledger and has a legal entity
SELECT hou.organization_id,
       hou.name                   AS operating_unit,
       hou.short_code,
       gl.name                    AS ledger,
       xle.name                   AS legal_entity,
       mo.org_id                  AS mo_default_org
FROM   hr_operating_units hou
JOIN   gl_ledgers gl              ON gl.ledger_id = hou.set_of_books_id
JOIN   xle_entity_profiles xle   ON xle.legal_entity_id = hou.default_legal_context_id
LEFT JOIN mo_glob_org_access_tmp mo ON mo.org_id = hou.organization_id
ORDER  BY hou.name;
\`\`\`

If DEFAULT_LEGAL_CONTEXT_ID is null, tax and legal entity defaulting will fail silently on invoices.

---

## AP Configuration Layer

### Financials Options

Financials Options (FND_FINANCIALS_SYSTEM_PARAMS_ALL) define the AP and AR accounting defaults at the OU level. This is the single most-missed setup step in initial configurations.

\`\`\`sql
SELECT fsp.org_id,
       hou.name                   AS operating_unit,
       fsp.liability_posting_flag,
       fsp.discount_posting_flag,
       fsp.bill_to_location_id,
       fsp.ship_to_location_id,
       fsp.set_of_books_id,
       fsp.future_dated_payment_ccid,
       fsp.prepayment_ccid,
       gcc_liab.concatenated_segments  AS default_liability_account,
       gcc_prep.concatenated_segments  AS prepayment_account
FROM   fnd_financials_system_params_all fsp
JOIN   hr_operating_units hou     ON hou.organization_id = fsp.org_id
LEFT JOIN gl_code_combinations_kfv gcc_liab ON gcc_liab.code_combination_id = fsp.accts_pay_code_combination_id
LEFT JOIN gl_code_combinations_kfv gcc_prep ON gcc_prep.code_combination_id = fsp.prepayment_ccid
ORDER  BY hou.name;
\`\`\`

**Common errors**:
- ACCTS_PAY_CODE_COMBINATION_ID is null → every AP invoice posting fails with "No liability account"
- PREPAYMENT_CCID is null → prepayment invoices cannot be entered
- SET_OF_BOOKS_ID does not match the OU's ledger → accounting goes to the wrong ledger

### Payables Options

Payables Options (AP_SYSTEM_PARAMETERS_ALL) define AP-specific defaults: default payment terms, payment method, invoice tolerances, and matching options.

\`\`\`sql
SELECT asp.org_id,
       hou.name                   AS operating_unit,
       asp.default_pay_group,
       asp.invoice_currency_code,
       asp.payment_currency_code,
       asp.payment_method_lookup_code,
       apt.name                   AS default_payment_terms,
       asp.create_awt_dists_type,
       asp.po_matching_control,
       asp.invoice_tolerance_id,
       asp.qty_tolerance,
       asp.amt_tolerance
FROM   ap_system_parameters_all asp
JOIN   hr_operating_units hou     ON hou.organization_id = asp.org_id
LEFT JOIN ap_terms apt            ON apt.term_id = asp.terms_id
ORDER  BY hou.name;
\`\`\`

**Common errors**:
- No row in AP_SYSTEM_PARAMETERS_ALL for the OU → AP cannot be opened; the Payables Options form has never been saved
- DEFAULT_PAY_GROUP is null → payment batches cannot default a pay group and may error
- PAYMENT_METHOD_LOOKUP_CODE does not match an active payment method → payment creation fails

### Payment Terms

Payment terms must exist before they can be assigned to suppliers or invoices.

\`\`\`sql
-- Active payment terms
SELECT apt.term_id,
       apt.name,
       apt.type,
       apt.description,
       aptl.sequence_num,
       aptl.due_percent,
       aptl.due_days,
       aptl.discount_percent,
       aptl.discount_days
FROM   ap_terms apt
JOIN   ap_terms_lines aptl ON aptl.term_id = apt.term_id
WHERE  apt.enabled_flag = 'Y'
ORDER  BY apt.name, aptl.sequence_num;
\`\`\`

**Common error**: Suppliers imported via interface have TERMS_ID values that do not exist in AP_TERMS → invoice entry defaults to null terms, blocking payment scheduling.

### Bank Accounts and Payment Documents

AP payments require a bank account with at least one active payment document.

\`\`\`sql
-- Bank accounts accessible to AP with payment documents
SELECT cba.bank_account_num,
       cba.account_name,
       cba.currency_code,
       cba.account_inactive_date,
       cpd.payment_document_name,
       cpd.payment_method_code,
       cpd.next_available_document_num,
       cpd.last_document_num,
       cpd.payment_document_status,
       hou.name                    AS operating_unit
FROM   ce_bank_accounts cba
JOIN   ce_bank_acct_uses_all cbau  ON cbau.bank_account_id = cba.bank_account_id
JOIN   hr_operating_units hou      ON hou.organization_id = cbau.org_id
LEFT JOIN ce_payment_documents cpd ON cpd.bank_account_id = cba.bank_account_id
WHERE  cbau.ap_use_enable_flag = 'Y'
ORDER  BY hou.name, cba.bank_account_num;
\`\`\`

**Common errors**:
- AP_USE_ENABLE_FLAG = 'N' → bank account exists but is invisible to AP payment processing
- No payment document exists → payment batch creation fails with "no payment document available"
- LAST_DOCUMENT_NUM is reached → check numbers exhausted, no new payments can be created until document is extended

---

## AR Configuration Layer

### AR System Options

AR System Options (AR_SYSTEM_PARAMETERS_ALL) are the AR equivalent of Financials Options. They must be saved for each OU before any AR transaction can be created.

\`\`\`sql
SELECT asp.org_id,
       hou.name                    AS operating_unit,
       asp.set_of_books_id,
       asp.default_country,
       asp.tax_method,
       asp.accounting_method,
       asp.unearned_discount,
       asp.partial_discount_flag,
       asp.create_reciprocal_flag,
       asp.default_cb_due_date,
       gcc_rev.concatenated_segments  AS default_revenue_account,
       gcc_rec.concatenated_segments  AS default_receivable_account
FROM   ar_system_parameters_all asp
JOIN   hr_operating_units hou     ON hou.organization_id = asp.org_id
LEFT JOIN gl_code_combinations_kfv gcc_rev ON gcc_rev.code_combination_id = asp.code_combination_id
LEFT JOIN gl_code_combinations_kfv gcc_rec ON gcc_rec.code_combination_id = asp.receivables_ccid
ORDER  BY hou.name;
\`\`\`

**Common errors**:
- No row in AR_SYSTEM_PARAMETERS_ALL → AR is effectively unconfigured; every transaction form will error on open
- RECEIVABLES_CCID is null → AR invoice accounting cannot be generated
- ACCOUNTING_METHOD is wrong ('ACCRUAL' vs 'CASH') → revenue recognition behaves unexpectedly

### AutoAccounting Rules

AutoAccounting is how AR derives the GL account for each transaction line. If AutoAccounting is not configured, AR invoice posting fails with "No AutoAccounting rule found."

\`\`\`sql
-- AutoAccounting function assignments
SELECT raf.name                   AS function_name,
       raf.trans_type,
       rat.type                   AS table_type,
       rat.name                   AS table_name,
       rac.segment_num,
       fif.segment_name,
       rac.constant,
       rac.table_name             AS source_table,
       rac.column_name            AS source_column
FROM   ra_account_defaults rad
JOIN   ra_account_default_segments rads ON rads.account_default_id = rad.account_default_id
JOIN   ra_rules_for_transactions raf    ON raf.rule_id = rads.rule_id
JOIN   ra_account_rules rat             ON rat.account_rule_id = rads.account_rule_id
JOIN   ra_account_rule_combinations rac ON rac.account_rule_id = rat.account_rule_id
JOIN   fnd_id_flex_segments fif         ON fif.application_column_name = rac.segment_name
                                       AND fif.id_flex_num = (
                                             SELECT chart_of_accounts_id FROM gl_ledgers
                                             WHERE ledger_id = (SELECT set_of_books_id FROM ar_system_parameters_all WHERE ROWNUM = 1))
ORDER  BY raf.trans_type, rads.segment_num;
\`\`\`

The minimum required AutoAccounting functions are: Revenue, Receivable, Tax, Freight, Unbilled Receivable, Unearned Revenue. A missing function for any of these blocks that transaction type from posting.

### Transaction Types

AR transaction types define the accounting class and GL account behavior for invoices, credit memos, debit memos, and chargebacks.

\`\`\`sql
SELECT rtt.name                   AS transaction_type_name,
       rtt.type,
       rtt.status,
       rtt.creation_sign,
       rtt.allow_freight_flag,
       rtt.allow_overapplication_flag,
       rtt.natural_application_only_flag,
       rtt.post_to_gl,
       gcc_rev.concatenated_segments AS revenue_account,
       gcc_rec.concatenated_segments AS receivable_account,
       gcc_tax.concatenated_segments AS tax_account
FROM   ra_cust_trx_types_all rtt
LEFT JOIN gl_code_combinations_kfv gcc_rev ON gcc_rev.code_combination_id = rtt.rev_ccid
LEFT JOIN gl_code_combinations_kfv gcc_rec ON gcc_rec.code_combination_id = rtt.rec_ccid
LEFT JOIN gl_code_combinations_kfv gcc_tax ON gcc_tax.code_combination_id = rtt.tax_ccid
WHERE  rtt.status = 'A'
  AND  rtt.org_id = :org_id
ORDER  BY rtt.type, rtt.name;
\`\`\`

**Common errors**:
- Transaction type has POST_TO_GL = 'N' → invoices create no accounting, making reconciliation impossible
- CREATION_SIGN is wrong (e.g., 'POSITIVE' on a credit memo type) → amounts post with wrong sign

### Receipt Classes and Payment Methods

Receipts cannot be entered until at least one receipt class exists with an associated payment method.

\`\`\`sql
SELECT arc.name                   AS receipt_class_name,
       arc.creation_method_code,
       arc.remit_flag,
       arc.confirm_flag,
       arm.name                   AS payment_method_name,
       arm.payment_channel_code,
       arc.notes_receivable,
       cba.bank_account_num,
       cba.account_name
FROM   ar_receipt_classes arc
JOIN   ar_payment_schedules_all aps ON aps.actual_date_closed IS NULL  -- just for join path reference
-- Correct join via receipt methods
LEFT JOIN ar_receipt_methods arm   ON arm.receipt_class_id = arc.receipt_class_id
LEFT JOIN ar_receipt_method_accounts arma ON arma.receipt_method_id = arm.receipt_method_id
LEFT JOIN ce_bank_accounts cba     ON cba.bank_account_id = arma.remit_bank_acct_use_id
WHERE  ROWNUM <= 50
ORDER  BY arc.name, arm.name;
\`\`\`

The minimal viable configuration: one Manual receipt class (CREATION_METHOD_CODE = 'MANUAL'), CONFIRM_FLAG = 'N', REMIT_FLAG = 'N', with one payment method (typically Check or Wire) and a remittance bank account.

---

## Common Setup Error Patterns

### Error 1 — "No Accounting Entries Generated" on AP Invoice Validation

**Root cause options** (check in order):
1. ACCTS_PAY_CODE_COMBINATION_ID is null in FND_FINANCIALS_SYSTEM_PARAMS_ALL
2. The GL account in the liability account is end-dated or has ENABLED_FLAG = 'N' in GL_CODE_COMBINATIONS
3. The AP period for the invoice date is closed (GL_PERIOD_STATUSES, application_id = 200)

\`\`\`sql
-- Quick check: is the default liability account active?
SELECT gcc.concatenated_segments,
       gcc.enabled_flag,
       gcc.start_date_active,
       gcc.end_date_active
FROM   gl_code_combinations_kfv gcc
JOIN   fnd_financials_system_params_all fsp
       ON fsp.accts_pay_code_combination_id = gcc.code_combination_id
WHERE  fsp.org_id = :org_id;
\`\`\`

### Error 2 — "Receipt Cannot Be Applied" in AR

**Root cause options**:
1. Transaction type on the invoice has ALLOW_OVERAPPLICATION_FLAG = 'N' and the receipt amount exceeds the invoice balance
2. The receipt's payment method does not match the remittance bank account currency
3. The AR period for the receipt date is not open

\`\`\`sql
-- AR period status
SELECT period_name, closing_status
FROM   gl_period_statuses
WHERE  application_id = 222
  AND  set_of_books_id = :ledger_id
  AND  closing_status = 'O'
ORDER  BY start_date DESC
FETCH  FIRST 3 ROWS ONLY;
\`\`\`

### Error 3 — Supplier Import Errors (AP_SUPPLIERS Interface)

\`\`\`sql
-- Check AP supplier open interface for errors
SELECT ai.vendor_name,
       ai.vendor_num,
       ai.status,
       ai.reject_code,
       ai.creation_date
FROM   ap_suppliers_int ai
WHERE  ai.status = 'REJECTED'
ORDER  BY ai.creation_date DESC
FETCH  FIRST 20 ROWS ONLY;
\`\`\`

Common reject codes: DUPLICATE_VENDOR (vendor number already exists), INVALID_TERMS (TERMS_ID not in AP_TERMS), INVALID_ORG (org_id not valid for this instance).

### Error 4 — Customer Import Errors (HZ Interface)

\`\`\`sql
-- TCA interface errors for customer import
SELECT iface.party_name,
       iface.party_type,
       iface.interface_status,
       err.message_text,
       err.column_name
FROM   hz_imp_parties_int iface
LEFT JOIN hz_imp_work_units wu  ON wu.batch_id = iface.batch_id
LEFT JOIN hz_imp_errors err     ON err.int_row_id = iface.rowid
WHERE  iface.interface_status = 'R'
ORDER  BY iface.creation_date DESC
FETCH  FIRST 20 ROWS ONLY;
\`\`\`

### Error 5 — eBTax Not Configured (Tax Errors on Invoice Save)

EBS R12 uses eBusiness Tax (eBTax / ZX) for all tax determination. If the tax regime, rates, and rules are not configured before invoice entry, invoices fail to save with "No applicable tax rate found" or save with zero tax where tax is expected.

\`\`\`sql
-- Check tax regime configuration
SELECT zr.tax_regime_code,
       zr.regime_name,
       zr.effective_from,
       zr.effective_to,
       zt.tax,
       zt.tax_full_name,
       zt.effective_from       AS tax_effective_from,
       zts.tax_status_code,
       ztr.tax_rate_code,
       ztr.percentage_rate
FROM   zx_regimes_b zr
JOIN   zx_taxes_b zt        ON zt.tax_regime_code = zr.tax_regime_code
JOIN   zx_statuses_b zts    ON zts.tax = zt.tax AND zts.tax_regime_code = zr.tax_regime_code
JOIN   zx_rates_b ztr       ON ztr.tax = zt.tax AND ztr.tax_regime_code = zr.tax_regime_code
WHERE  zr.effective_to IS NULL OR zr.effective_to > SYSDATE
ORDER  BY zr.tax_regime_code, zt.tax, zts.tax_status_code, ztr.tax_rate_code;
\`\`\`

---

## Diagnostic Script

The following script validates the critical AP/AR initial configuration objects for a given operating unit. It runs as a scheduled cron job or on demand during implementation.

\`\`\`bash
#!/bin/bash
# =====================================================
# Oracle EBS AP/AR Initial Configuration Validator
# Schedule: on-demand or daily during implementation
# Usage: ORG_ID=101 APPS_PASSWORD=apps ./ebs_ap_ar_config_check.sh
# =====================================================

ORACLE_HOME=/u01/app/oracle/product/19c/dbhome_1
ORACLE_SID=EBSPROD
APPS_USER=apps
APPS_PASS=\${APPS_PASSWORD:-apps}
ORG_ID=\${ORG_ID:-101}
ALERT_EMAIL=ebs-impl-dba@example.com
LOG=/var/log/ebs_ap_ar_config_check.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
ERRORS=0
WARNINGS=0
REPORT=""

export ORACLE_HOME ORACLE_SID
export PATH=\${ORACLE_HOME}/bin:\${PATH}
export NLS_DATE_FORMAT="YYYY-MM-DD HH24:MI:SS"

log()  { echo "[\${TIMESTAMP}] \$*" | tee -a "\${LOG}"; }
fail() { ERRORS=\$((ERRORS+1));  REPORT="\${REPORT}\\nFAIL:  \$*"; log "FAIL:  \$*"; }
warn() { WARNINGS=\$((WARNINGS+1)); REPORT="\${REPORT}\\nWARN:  \$*"; log "WARN:  \$*"; }
pass() { log "PASS:  \$*"; }

run_sql() {
  sqlplus -s "\${APPS_USER}/\${APPS_PASS}" <<SQLEOF
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMOUT ON TRIMSPOOL ON
\$1
EXIT
SQLEOF
}

# --------------------------------------------------
# 1. Operating Unit and Ledger
# --------------------------------------------------
check_ou_ledger() {
  log "--- Checking Operating Unit and Ledger ---"
  RESULT=\$(run_sql "
SELECT NVL(TO_CHAR(hou.organization_id),'MISSING')
       || '|' || NVL(hou.name,'MISSING')
       || '|' || NVL(TO_CHAR(hou.set_of_books_id),'MISSING')
       || '|' || NVL(gl.name,'NO_LEDGER')
       || '|' || NVL(gl.completion_status,'NO_LEDGER')
       || '|' || NVL(TO_CHAR(hou.default_legal_context_id),'NO_LEGAL_ENTITY')
FROM   hr_operating_units hou
LEFT JOIN gl_ledgers gl ON gl.ledger_id = hou.set_of_books_id
WHERE  hou.organization_id = \${ORG_ID};")

  if [ -z "\${RESULT}" ]; then
    fail "Operating unit \${ORG_ID} not found in hr_operating_units"
    return
  fi

  OU_NAME=\$(echo "\${RESULT}" | cut -d'|' -f2)
  LEDGER_NAME=\$(echo "\${RESULT}" | cut -d'|' -f4)
  LEDGER_STATUS=\$(echo "\${RESULT}" | cut -d'|' -f5)
  LEGAL_ENTITY=\$(echo "\${RESULT}" | cut -d'|' -f6)

  [ "\${LEDGER_NAME}" = "NO_LEDGER" ] && fail "OU \${OU_NAME}: no ledger assigned" || pass "OU \${OU_NAME}: ledger=\${LEDGER_NAME}"
  [ "\${LEDGER_STATUS}" != "COMPLETE" ] && fail "Ledger \${LEDGER_NAME}: completion_status=\${LEDGER_STATUS}" || pass "Ledger \${LEDGER_NAME}: COMPLETE"
  [ "\${LEGAL_ENTITY}" = "NO_LEGAL_ENTITY" ] && warn "OU \${OU_NAME}: no default legal entity — tax defaulting will fail" || pass "Legal entity assigned: \${LEGAL_ENTITY}"
}

# --------------------------------------------------
# 2. AP Financials Options
# --------------------------------------------------
check_ap_financials_options() {
  log "--- Checking AP Financials Options ---"
  RESULT=\$(run_sql "
SELECT NVL(TO_CHAR(fsp.accts_pay_code_combination_id),'NULL')
       || '|' || NVL(TO_CHAR(fsp.prepayment_ccid),'NULL')
       || '|' || NVL(TO_CHAR(fsp.set_of_books_id),'NULL')
FROM   fnd_financials_system_params_all fsp
WHERE  fsp.org_id = \${ORG_ID};")

  if [ -z "\${RESULT}" ]; then
    fail "No Financials Options row found for OU \${ORG_ID} — Financials Options have never been saved"
    return
  fi

  LIAB_CCID=\$(echo "\${RESULT}" | cut -d'|' -f1)
  PREP_CCID=\$(echo "\${RESULT}" | cut -d'|' -f2)
  SOB=\$(echo "\${RESULT}" | cut -d'|' -f3)

  [ "\${LIAB_CCID}" = "NULL" ] && fail "AP Financials Options: default liability account (ACCTS_PAY_CODE_COMBINATION_ID) is null" || pass "AP liability account CCID=\${LIAB_CCID}"
  [ "\${PREP_CCID}" = "NULL" ]  && warn "AP Financials Options: prepayment account (PREPAYMENT_CCID) is null" || pass "AP prepayment account CCID=\${PREP_CCID}"
  [ "\${SOB}" = "NULL" ]        && fail "AP Financials Options: set_of_books_id is null" || pass "AP Financials Options ledger ID=\${SOB}"
}

# --------------------------------------------------
# 3. AP Payables Options
# --------------------------------------------------
check_ap_payables_options() {
  log "--- Checking AP Payables Options ---"
  RESULT=\$(run_sql "
SELECT NVL(asp.default_pay_group,'NULL')
       || '|' || NVL(asp.payment_method_lookup_code,'NULL')
       || '|' || NVL(TO_CHAR(asp.terms_id),'NULL')
       || '|' || NVL(asp.invoice_currency_code,'NULL')
FROM   ap_system_parameters_all asp
WHERE  asp.org_id = \${ORG_ID};")

  if [ -z "\${RESULT}" ]; then
    fail "No Payables Options row found for OU \${ORG_ID} — Payables Options have never been saved"
    return
  fi

  PAY_GROUP=\$(echo "\${RESULT}" | cut -d'|' -f1)
  PAY_METHOD=\$(echo "\${RESULT}" | cut -d'|' -f2)
  TERMS=\$(echo "\${RESULT}" | cut -d'|' -f3)
  CURR=\$(echo "\${RESULT}" | cut -d'|' -f4)

  [ "\${PAY_GROUP}" = "NULL" ] && warn "Payables Options: default pay group is null — payment batches will not default" || pass "Default pay group: \${PAY_GROUP}"
  [ "\${PAY_METHOD}" = "NULL" ] && warn "Payables Options: default payment method is null" || pass "Default payment method: \${PAY_METHOD}"
  [ "\${TERMS}" = "NULL" ]     && warn "Payables Options: default payment terms not set" || pass "Default terms ID: \${TERMS}"
  [ "\${CURR}" = "NULL" ]      && fail "Payables Options: invoice currency code is null" || pass "Invoice currency: \${CURR}"
}

# --------------------------------------------------
# 4. AP Bank Accounts
# --------------------------------------------------
check_ap_bank_accounts() {
  log "--- Checking AP Bank Accounts ---"
  COUNT=\$(run_sql "
SELECT COUNT(*)
FROM   ce_bank_acct_uses_all cbau
JOIN   ce_bank_accounts cba ON cba.bank_account_id = cbau.bank_account_id
WHERE  cbau.org_id = \${ORG_ID}
  AND  cbau.ap_use_enable_flag = 'Y'
  AND  (cba.account_inactive_date IS NULL OR cba.account_inactive_date > SYSDATE);")

  [ "\${COUNT}" -eq 0 ] && fail "No active AP-enabled bank account for OU \${ORG_ID}" || pass "\${COUNT} active AP bank account(s)"

  DOC_COUNT=\$(run_sql "
SELECT COUNT(*)
FROM   ce_bank_acct_uses_all cbau
JOIN   ce_bank_accounts cba ON cba.bank_account_id = cbau.bank_account_id
JOIN   ce_payment_documents cpd ON cpd.bank_account_id = cba.bank_account_id
WHERE  cbau.org_id = \${ORG_ID}
  AND  cbau.ap_use_enable_flag = 'Y'
  AND  cpd.payment_document_status = 'ACTIVE';")

  [ "\${DOC_COUNT}" -eq 0 ] && fail "No active payment documents found for AP bank accounts in OU \${ORG_ID}" || pass "\${DOC_COUNT} active payment document(s)"
}

# --------------------------------------------------
# 5. AR System Options
# --------------------------------------------------
check_ar_system_options() {
  log "--- Checking AR System Options ---"
  RESULT=\$(run_sql "
SELECT NVL(TO_CHAR(asp.receivables_ccid),'NULL')
       || '|' || NVL(asp.accounting_method,'NULL')
       || '|' || NVL(asp.tax_method,'NULL')
       || '|' || NVL(TO_CHAR(asp.set_of_books_id),'NULL')
FROM   ar_system_parameters_all asp
WHERE  asp.org_id = \${ORG_ID};")

  if [ -z "\${RESULT}" ]; then
    fail "No AR System Options row found for OU \${ORG_ID} — AR System Options have never been saved"
    return
  fi

  REC_CCID=\$(echo "\${RESULT}" | cut -d'|' -f1)
  ACCT_METHOD=\$(echo "\${RESULT}" | cut -d'|' -f2)
  TAX_METHOD=\$(echo "\${RESULT}" | cut -d'|' -f3)

  [ "\${REC_CCID}" = "NULL" ]    && fail "AR System Options: default receivable account (RECEIVABLES_CCID) is null" || pass "AR receivable account CCID=\${REC_CCID}"
  [ "\${ACCT_METHOD}" = "NULL" ] && fail "AR System Options: accounting method not set" || pass "AR accounting method: \${ACCT_METHOD}"
  [ "\${TAX_METHOD}" = "NULL" ]  && warn "AR System Options: tax method not set — eBTax will not initialize" || pass "AR tax method: \${TAX_METHOD}"
}

# --------------------------------------------------
# 6. AR AutoAccounting
# --------------------------------------------------
check_ar_autoaccounting() {
  log "--- Checking AR AutoAccounting ---"
  REQUIRED="Revenue Receivable Tax Freight"
  for FUNC in \${REQUIRED}; do
    COUNT=\$(run_sql "
SELECT COUNT(*) FROM ra_account_defaults rad
WHERE rad.name = '\${FUNC}';")
    [ "\${COUNT}" -eq 0 ] && fail "AR AutoAccounting: function '\${FUNC}' not configured" || pass "AR AutoAccounting: '\${FUNC}' configured"
  done
}

# --------------------------------------------------
# 7. AR Transaction Types
# --------------------------------------------------
check_ar_trx_types() {
  log "--- Checking AR Transaction Types ---"
  COUNT=\$(run_sql "
SELECT COUNT(*) FROM ra_cust_trx_types_all
WHERE status = 'A' AND org_id = \${ORG_ID};")

  [ "\${COUNT}" -eq 0 ] && fail "No active AR transaction types for OU \${ORG_ID}" || pass "\${COUNT} active AR transaction type(s)"

  BAD_POST=\$(run_sql "
SELECT COUNT(*) FROM ra_cust_trx_types_all
WHERE status = 'A' AND org_id = \${ORG_ID} AND post_to_gl = 'N';")

  [ "\${BAD_POST}" -gt 0 ] && warn "\${BAD_POST} AR transaction type(s) have POST_TO_GL=N — these will create no accounting" || pass "All active AR transaction types post to GL"
}

# --------------------------------------------------
# 8. AR Receipt Classes
# --------------------------------------------------
check_ar_receipt_classes() {
  log "--- Checking AR Receipt Classes and Payment Methods ---"
  COUNT=\$(run_sql "
SELECT COUNT(DISTINCT arm.receipt_class_id)
FROM   ar_receipt_methods arm
JOIN   ar_receipt_method_accounts arma ON arma.receipt_method_id = arm.receipt_method_id
WHERE  arm.end_date IS NULL OR arm.end_date > SYSDATE;")

  [ "\${COUNT}" -eq 0 ] && fail "No active AR receipt methods with bank accounts configured — receipts cannot be entered" || pass "\${COUNT} active AR receipt method(s) with bank accounts"
}

# --------------------------------------------------
# 9. Open AP and AR Periods
# --------------------------------------------------
check_open_periods() {
  log "--- Checking open AP and AR periods ---"
  AP_OPEN=\$(run_sql "
SELECT COUNT(*) FROM gl_period_statuses
WHERE application_id = 200 AND closing_status = 'O'
  AND set_of_books_id = (SELECT set_of_books_id FROM ap_system_parameters_all WHERE org_id = \${ORG_ID});")

  AR_OPEN=\$(run_sql "
SELECT COUNT(*) FROM gl_period_statuses
WHERE application_id = 222 AND closing_status = 'O'
  AND set_of_books_id = (SELECT set_of_books_id FROM ar_system_parameters_all WHERE org_id = \${ORG_ID});")

  [ "\${AP_OPEN}" -eq 0 ] && fail "No open AP periods — invoice entry will fail" || pass "\${AP_OPEN} open AP period(s)"
  [ "\${AR_OPEN}" -eq 0 ] && fail "No open AR periods — transaction entry will fail" || pass "\${AR_OPEN} open AR period(s)"
}

# --------------------------------------------------
# 10. eBTax Configuration
# --------------------------------------------------
check_ebtax() {
  log "--- Checking eBTax regime configuration ---"
  COUNT=\$(run_sql "
SELECT COUNT(DISTINCT zr.tax_regime_code)
FROM   zx_regimes_b zr
WHERE  (zr.effective_to IS NULL OR zr.effective_to > SYSDATE);")

  [ "\${COUNT}" -eq 0 ] && warn "No active eBTax tax regimes — tax lines will not be generated on invoices" || pass "\${COUNT} active eBTax regime(s)"
}

# --------------------------------------------------
# Summary and alert
# --------------------------------------------------
print_summary() {
  log "====== Configuration Check Summary ======"
  log "ERRORS:   \${ERRORS}"
  log "WARNINGS: \${WARNINGS}"
  if [ "\${ERRORS}" -gt 0 ] || [ "\${WARNINGS}" -gt 0 ]; then
    printf "EBS AP/AR Configuration Check\\nHost: \$(hostname)\\nOU: \${ORG_ID}\\nTime: \${TIMESTAMP}\\n\\nErrors: \${ERRORS}  Warnings: \${WARNINGS}\\n\${REPORT}\\n\\nSee full log: \${LOG}\\n" \
      | mail -s "EBS AP/AR Config Issues - \$(hostname)" "\${ALERT_EMAIL}"
    log "Summary email sent to \${ALERT_EMAIL}"
  else
    log "All checks passed — no issues found"
  fi
}

log "====== EBS AP/AR Config Check Start (OU=\${ORG_ID}) ======"
check_ou_ledger
check_ap_financials_options
check_ap_payables_options
check_ap_bank_accounts
check_ar_system_options
check_ar_autoaccounting
check_ar_trx_types
check_ar_receipt_classes
check_open_periods
check_ebtax
print_summary
log "====== EBS AP/AR Config Check End ======"
\`\`\`

Schedule during implementation (run daily as applmgr):

\`\`\`
# AP/AR config validator — daily at 7 AM during implementation
0 7 * * * ORG_ID=101 APPS_PASSWORD=apps /opt/scripts/ebs_ap_ar_config_check.sh >> /var/log/ebs_ap_ar_config_cron.log 2>&1
\`\`\`

---

## Summary

AP/AR initial configuration in EBS is a strict dependency chain. The most common cause of failed implementations is not misconfiguration — it is uncompleted configuration where a required step was deferred and its absence only surfaces during transaction testing. The diagnostic script above covers every link in the chain: OU/ledger binding, AP Financials and Payables Options, bank accounts and payment documents, AR System Options, AutoAccounting, transaction types, receipt classes, open periods, and eBTax. Running it daily during implementation gives implementers a live view of what is blocking transactions before users hit the errors themselves.`,
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
