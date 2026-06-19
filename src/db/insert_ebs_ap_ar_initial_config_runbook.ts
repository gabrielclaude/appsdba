import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS AP/AR Initial Configuration Runbook: Step-by-Step Setup and Validation',
  slug: 'oracle-ebs-ap-ar-initial-configuration-runbook',
  excerpt:
    'Step-by-step runbook for completing Oracle EBS AP and AR initial configuration — ledger and operating unit validation, Financials Options, Payables Options, AR System Options, AutoAccounting, payment terms, bank accounts, transaction types, receipt classes, eBTax, and ongoing configuration health monitoring via crontab.',
  category: 'ebs-functional' as const,
  isPremium: true,
  published: true,
  publishedAt: new Date('2026-06-19'),
  content: `## Phase 1 — Pre-Configuration Validation

Before opening any setup form, confirm the foundation objects are in place. Every subsequent setup step depends on these.

### 1.1 Confirm Chart of Accounts and Calendar

\`\`\`sql
-- Verify Chart of Accounts exists and has segments defined
SELECT s.id_flex_code,
       s.id_flex_name,
       s.table_name,
       COUNT(seg.segment_num) AS segment_count
FROM   fnd_id_flexs s
JOIN   fnd_id_flex_segments seg ON seg.id_flex_code = s.id_flex_code
                                AND seg.application_id = s.application_id
WHERE  s.id_flex_code = 'GL#'
GROUP  BY s.id_flex_code, s.id_flex_name, s.table_name;

-- Accounting calendar: periods must be defined for the implementation year
SELECT period_set_name,
       period_name,
       period_type,
       start_date,
       end_date,
       quarter_num,
       period_year
FROM   gl_periods
WHERE  period_year = TO_NUMBER(TO_CHAR(SYSDATE,'YYYY'))
ORDER  BY start_date;
\`\`\`

If periods are missing for the current year, create them in General Ledger → Setup → Financials → Accounting Calendar before proceeding.

### 1.2 Confirm Ledger Is Complete

\`\`\`sql
SELECT gl.ledger_id,
       gl.name,
       gl.currency_code,
       gl.period_set_name,
       gl.chart_of_accounts_id,
       gl.completion_status,
       gl.ledger_category_code,
       gl.bal_seg_value_option_code
FROM   gl_ledgers gl
WHERE  gl.ledger_category_code = 'PRIMARY'
ORDER  BY gl.name;
\`\`\`

COMPLETION_STATUS must be 'COMPLETE'. If 'INCOMPLETE', go to General Ledger → Setup → Financials → Accounting Setup Manager and complete the accounting setup.

### 1.3 Confirm Operating Unit

\`\`\`sql
SELECT hou.organization_id,
       hou.name                   AS operating_unit,
       hou.short_code,
       hou.set_of_books_id,
       gl.name                    AS ledger,
       hou.default_legal_context_id,
       xle.name                   AS legal_entity,
       hou.business_group_id
FROM   hr_operating_units hou
JOIN   gl_ledgers gl              ON gl.ledger_id = hou.set_of_books_id
LEFT JOIN xle_entity_profiles xle ON xle.legal_entity_id = hou.default_legal_context_id
ORDER  BY hou.name;
\`\`\`

If DEFAULT_LEGAL_CONTEXT_ID is null, assign a legal entity via Accounting Setup Manager → Operating Unit → Legal Entity Assignment before configuring AP or AR.

### 1.4 Confirm MO: Operating Unit Profile Option

\`\`\`sql
-- Check the MO: Operating Unit profile is set at site or user level
SELECT fpov.profile_option_name,
       fpo.profile_option_value,
       DECODE(fpo.level_id,
              10001, 'Site',
              10002, 'Application',
              10003, 'Responsibility',
              10004, 'User') AS profile_level
FROM   fnd_profile_options fpov
JOIN   fnd_profile_option_values fpo ON fpo.profile_option_id = fpov.profile_option_id
WHERE  fpov.profile_option_name = 'ORG_ID'
ORDER  BY fpo.level_id;
\`\`\`

The ORG_ID profile must point to the correct operating unit at the responsibility or site level. A missing or wrong ORG_ID profile is the single most common cause of "No operating unit context" errors in AP and AR.

---

## Phase 2 — AP Financials Options

### 2.1 Navigate to Financials Options

Payables Responsibility → Setup → Options → Financials

This form writes to FND_FINANCIALS_SYSTEM_PARAMS_ALL. It must be saved at least once for the OU before any AP transaction can be entered.

### 2.2 Required Fields — Financials Options

| Tab | Field | Requirement |
|-----|-------|-------------|
| Accounting | Liability Account | Must point to an active AP liability GL account |
| Accounting | Prepayment Account | Required if prepayment invoices will be used |
| Accounting | Discount Taken Account | Required if early payment discounts are used |
| Accounting | Future Dated Payment Account | Required if future-dated checks are used |
| Supplier | Numbering | Set to Automatic or Manual consistently |
| Supplier | Invoice Match Option | PO or Receipt — must match procurement process |
| Human Resources | Business Group | Must match the HR business group for the OU |

### 2.3 Validate After Saving

\`\`\`sql
SELECT fsp.org_id,
       hou.name                            AS operating_unit,
       gcc_liab.concatenated_segments      AS liability_account,
       gcc_prep.concatenated_segments      AS prepayment_account,
       gcc_disc.concatenated_segments      AS discount_account,
       fsp.match_option,
       fsp.employee_numbering_option
FROM   fnd_financials_system_params_all fsp
JOIN   hr_operating_units hou              ON hou.organization_id = fsp.org_id
LEFT JOIN gl_code_combinations_kfv gcc_liab ON gcc_liab.code_combination_id = fsp.accts_pay_code_combination_id
LEFT JOIN gl_code_combinations_kfv gcc_prep ON gcc_prep.code_combination_id = fsp.prepayment_ccid
LEFT JOIN gl_code_combinations_kfv gcc_disc ON gcc_disc.code_combination_id = fsp.discount_taken_ccid
WHERE  fsp.org_id = :org_id;
\`\`\`

Verify that LIABILITY_ACCOUNT, PREPAYMENT_ACCOUNT return actual account segment strings, not null. If null after saving, the GL account segment combination was not valid — check that the account is not end-dated in GL_CODE_COMBINATIONS.

---

## Phase 3 — AP Payables Options

### 3.1 Navigate to Payables Options

Payables Responsibility → Setup → Options → Payables

This form writes to AP_SYSTEM_PARAMETERS_ALL. It must be saved for the OU.

### 3.2 Required Fields — Payables Options

| Tab | Field | Requirement |
|-----|-------|-------------|
| Accounting | Set of Books | Auto-populated from OU; verify it matches |
| Accounting | Accounting Method | Accrual (standard) or Cash |
| Accounting | Realized Gain Account | Required for foreign currency invoices |
| Accounting | Realized Loss Account | Required for foreign currency invoices |
| Payments | Payment Method | Set default (Check, Wire, EFT) |
| Payments | Pay Group | Set default pay group for payment batches |
| Payments | Payment Terms | Set organization-wide default payment terms |
| Invoice | Invoice Currency | Set functional currency or most common foreign currency |
| Invoice | Allow Adjustments to Posted Invoices | Set per policy |
| Matching | Invoice Tolerances | Set quantity and amount tolerance percentages |

### 3.3 Validate After Saving

\`\`\`sql
SELECT asp.org_id,
       asp.default_pay_group,
       asp.payment_method_lookup_code,
       apt.name                   AS default_payment_terms,
       asp.invoice_currency_code,
       asp.payment_currency_code,
       asp.po_matching_control,
       asp.qty_tolerance,
       asp.amt_tolerance,
       asp.create_awt_dists_type
FROM   ap_system_parameters_all asp
LEFT JOIN ap_terms apt ON apt.term_id = asp.terms_id
WHERE  asp.org_id = :org_id;
\`\`\`

---

## Phase 4 — Payment Terms

### 4.1 Create Required Payment Terms

Payables Responsibility → Setup → Payment → Payment Terms

\`\`\`sql
-- Verify payment terms after creation
SELECT apt.term_id,
       apt.name,
       apt.type,
       apt.enabled_flag,
       aptl.sequence_num,
       aptl.due_percent,
       aptl.due_days,
       aptl.due_day_of_month,
       aptl.discount_percent,
       aptl.discount_days
FROM   ap_terms apt
JOIN   ap_terms_lines aptl ON aptl.term_id = apt.term_id
WHERE  apt.enabled_flag = 'Y'
ORDER  BY apt.name, aptl.sequence_num;
\`\`\`

Minimum required: at least one Net term (e.g., Net 30) and Immediate. Create all terms referenced by the supplier master data before running the supplier import.

### 4.2 Verify AP and AR Terms Alignment

AR uses its own payment terms table (RA_TERMS). When both modules are active, ensure terms are created in both:

\`\`\`sql
-- AR payment terms
SELECT rt.term_id,
       rt.name,
       rt.type,
       rt.first_installment_code,
       rtl.sequence,
       rtl.due_percent,
       rtl.due_days,
       rtl.discount_percent,
       rtl.discount_days
FROM   ra_terms rt
JOIN   ra_terms_lines rtl ON rtl.term_id = rt.term_id
WHERE  rt.status = 'A'
ORDER  BY rt.name, rtl.sequence;
\`\`\`

---

## Phase 5 — Bank Account Configuration

### 5.1 Create or Assign Bank Accounts

Cash Management Responsibility → Setup → Bank Accounts

For each bank account used for AP payments or AR receipts:

1. Create the Bank (if not existing): Cash Management → Setup → Banks
2. Create the Bank Branch
3. Create the Bank Account and set:
   - Account Currency
   - Account Type (Checking)
   - GL Cash Account (maps to the bank's GL account)
4. Assign to Operating Unit with AP Use and/or AR Use enabled

### 5.2 Create AP Payment Documents

On each AP bank account, create at least one payment document:

Cash Management → Setup → Bank Accounts → select account → Payment Documents

| Field | Value |
|-------|-------|
| Payment Document Name | e.g., "CHECKS-USD-2026" |
| Payment Method | Check / Wire / EFT |
| First Available Document Number | Starting check number |
| Last Document Number | Ending check number |
| Payment Format | Matches the print format program |

### 5.3 Validate Bank Account Setup

\`\`\`sql
-- AP bank accounts and payment documents
SELECT hou.name                     AS operating_unit,
       cba.bank_account_num,
       cba.account_name,
       cba.currency_code,
       cba.account_inactive_date,
       cbau.ap_use_enable_flag,
       cbau.ar_use_enable_flag,
       cpd.payment_document_name,
       cpd.payment_method_code,
       cpd.next_available_document_num,
       cpd.last_document_num,
       cpd.payment_document_status
FROM   ce_bank_acct_uses_all cbau
JOIN   ce_bank_accounts cba          ON cba.bank_account_id = cbau.bank_account_id
JOIN   hr_operating_units hou        ON hou.organization_id = cbau.org_id
LEFT JOIN ce_payment_documents cpd   ON cpd.bank_account_id = cba.bank_account_id
WHERE  cbau.org_id = :org_id
ORDER  BY cba.bank_account_num, cpd.payment_document_name;
\`\`\`

Confirm: AP_USE_ENABLE_FLAG = 'Y' for AP bank accounts, AR_USE_ENABLE_FLAG = 'Y' for AR bank accounts, PAYMENT_DOCUMENT_STATUS = 'ACTIVE'.

---

## Phase 6 — AR System Options

### 6.1 Navigate to AR System Options

Receivables Responsibility → Setup → System → System Options

This form writes to AR_SYSTEM_PARAMETERS_ALL. Save once to initialize the OU.

### 6.2 Required Fields — AR System Options

| Tab | Field | Requirement |
|-----|-------|-------------|
| Accounting | Set of Books | Auto-populated; verify |
| Accounting | Accounting Method | Accrual (standard) |
| Accounting | Unallocated Revenue Account | Required GL account |
| Miscellaneous | Tax Method | VAT or Inclusive or None — drives eBTax |
| Miscellaneous | Default Country | ISO country code for address defaulting |
| Miscellaneous | Create Reciprocal Customer | Y if cross-billing between customers |
| Transactions | Allow Change to Printed Transactions | Set per policy |

### 6.3 Validate After Saving

\`\`\`sql
SELECT asp.org_id,
       hou.name                        AS operating_unit,
       asp.accounting_method,
       asp.tax_method,
       asp.default_country,
       asp.unearned_discount,
       asp.partial_discount_flag,
       gcc_rec.concatenated_segments   AS receivable_account,
       gcc_rev.concatenated_segments   AS default_revenue_account,
       gcc_unall.concatenated_segments AS unallocated_revenue_account
FROM   ar_system_parameters_all asp
JOIN   hr_operating_units hou               ON hou.organization_id = asp.org_id
LEFT JOIN gl_code_combinations_kfv gcc_rec  ON gcc_rec.code_combination_id  = asp.receivables_ccid
LEFT JOIN gl_code_combinations_kfv gcc_rev  ON gcc_rev.code_combination_id  = asp.code_combination_id
LEFT JOIN gl_code_combinations_kfv gcc_unall ON gcc_unall.code_combination_id = asp.unallocated_revenue_ccid
WHERE  asp.org_id = :org_id;
\`\`\`

---

## Phase 7 — AR AutoAccounting

AutoAccounting must be configured before any AR invoice can post to GL.

### 7.1 AutoAccounting Functions to Configure

Navigate: Receivables → Setup → Transactions → AutoAccounting

| Function | Required For |
|----------|-------------|
| Revenue | All invoices — revenue line accounting |
| Receivable | All invoices — AR debit entry |
| Tax | Invoices with tax lines |
| Freight | Invoices with freight charges |
| Unbilled Receivable | Revenue schedules with future periods |
| Unearned Revenue | Deferred revenue |
| AutoInvoice Clearing | AutoInvoice interface processing |

For each function, assign a table and column (or constant) for every active GL segment. The most common pattern: Company segment from the Transaction (Batch Source), Cost Center from constant, Natural Account from Revenue Account on the transaction type or line.

### 7.2 Validate AutoAccounting

\`\`\`sql
-- Check that all required functions have segment assignments
SELECT raf.name             AS function_name,
       COUNT(rads.segment_num) AS segment_assignments
FROM   ra_account_defaults rad
JOIN   ra_account_default_segments rads ON rads.account_default_id = rad.account_default_id
JOIN   ra_rules_for_transactions raf    ON raf.rule_id = rads.rule_id
GROUP  BY raf.name
ORDER  BY raf.name;
\`\`\`

If a required function has 0 segment assignments, AutoAccounting will fail for that transaction type. Add assignments through the AutoAccounting form.

### 7.3 Test AutoAccounting with a Dummy Transaction

After configuration, create a test invoice (do not complete/post) and check that the accounting preview populates correct account combinations. Verify in the Invoice Workbench → Actions → View Accounting.

---

## Phase 8 — AR Transaction Types

### 8.1 Create Required Transaction Types

Receivables → Setup → Transactions → Transaction Types

Minimum required transaction types:

| Type Code | Usage | POST_TO_GL | CREATION_SIGN |
|-----------|-------|-----------|---------------|
| INV | Standard invoices | Y | POSITIVE |
| CM | Credit memos | Y | NEGATIVE |
| DM | Debit memos | Y | POSITIVE |
| CB | Chargebacks | Y | POSITIVE |

### 8.2 Transaction Type Account Assignments

\`\`\`sql
-- Verify transaction types have required accounts
SELECT rtt.name,
       rtt.type,
       rtt.status,
       rtt.post_to_gl,
       rtt.creation_sign,
       rtt.allow_freight_flag,
       rtt.allow_overapplication_flag,
       gcc_rev.concatenated_segments  AS revenue_account,
       gcc_rec.concatenated_segments  AS receivable_account,
       gcc_tax.concatenated_segments  AS tax_account,
       gcc_frt.concatenated_segments  AS freight_account,
       gcc_ue.concatenated_segments   AS unearned_rev_account,
       gcc_ub.concatenated_segments   AS unbilled_rec_account
FROM   ra_cust_trx_types_all rtt
LEFT JOIN gl_code_combinations_kfv gcc_rev ON gcc_rev.code_combination_id = rtt.rev_ccid
LEFT JOIN gl_code_combinations_kfv gcc_rec ON gcc_rec.code_combination_id = rtt.rec_ccid
LEFT JOIN gl_code_combinations_kfv gcc_tax ON gcc_tax.code_combination_id = rtt.tax_ccid
LEFT JOIN gl_code_combinations_kfv gcc_frt ON gcc_frt.code_combination_id = rtt.freight_ccid
LEFT JOIN gl_code_combinations_kfv gcc_ue  ON gcc_ue.code_combination_id  = rtt.unearned_ccid
LEFT JOIN gl_code_combinations_kfv gcc_ub  ON gcc_ub.code_combination_id  = rtt.unbilled_ccid
WHERE  rtt.status = 'A'
  AND  rtt.org_id = :org_id
ORDER  BY rtt.type, rtt.name;
\`\`\`

---

## Phase 9 — AR Receipt Classes and Payment Methods

### 9.1 Create Receipt Classes

Receivables → Setup → Receipts → Receipt Classes

| Field | Manual Check | Automatic EFT |
|-------|-------------|---------------|
| Creation Method | Manual | Automatic |
| Remittance Method | No Remittance | Standard |
| Clearance Method | By Matching | Automatic |
| Require Confirmation | No | No |

### 9.2 Create Payment Methods

For each receipt class, create at least one payment method and assign a remittance bank account.

\`\`\`sql
-- Validate receipt methods have bank accounts
SELECT arc.name                  AS receipt_class,
       arc.creation_method_code,
       arc.remit_flag,
       arc.confirm_flag,
       arm.name                  AS payment_method,
       arm.payment_channel_code,
       arm.start_date,
       arm.end_date,
       cba.bank_account_num,
       cba.account_name,
       cba.currency_code
FROM   ar_receipt_classes arc
JOIN   ar_receipt_methods arm     ON arm.receipt_class_id = arc.receipt_class_id
JOIN   ar_receipt_method_accounts arma ON arma.receipt_method_id = arm.receipt_method_id
JOIN   ce_bank_accounts cba       ON cba.bank_account_id = arma.remit_bank_acct_use_id
WHERE  arm.end_date IS NULL OR arm.end_date > SYSDATE
ORDER  BY arc.name, arm.name;
\`\`\`

---

## Phase 10 — eBTax Configuration

### 10.1 Tax Regime Setup Sequence

EBS R12 eBTax configuration order (cannot be reversed):

1. **Tax Regime**: defines the tax type and geographic scope
2. **Tax**: belongs to a regime, defines the tax name and recovery rules
3. **Tax Status**: Active/Exempt/Zero-Rated classifications
4. **Tax Rates**: percentage or quantity rates per status
5. **Tax Rules**: determination rules — which rate applies to which transaction
6. **Party Tax Profiles**: assign tax behavior to legal entities and operating units
7. **Tax Registrations**: supplier/customer VAT registration numbers

### 10.2 Validate eBTax Minimum Configuration

\`\`\`sql
-- Tax regimes, taxes, statuses, and rates
SELECT zr.tax_regime_code,
       zr.regime_name,
       zt.tax,
       zt.tax_full_name,
       zts.tax_status_code,
       ztr.tax_rate_code,
       ztr.percentage_rate,
       ztr.effective_from,
       ztr.effective_to
FROM   zx_regimes_b zr
JOIN   zx_taxes_b zt         ON zt.tax_regime_code = zr.tax_regime_code
JOIN   zx_statuses_b zts     ON zts.tax = zt.tax
                             AND zts.tax_regime_code = zr.tax_regime_code
JOIN   zx_rates_b ztr        ON ztr.tax = zt.tax
                             AND ztr.tax_regime_code = zr.tax_regime_code
                             AND ztr.tax_status_code = zts.tax_status_code
WHERE  (zr.effective_to IS NULL OR zr.effective_to > SYSDATE)
  AND  (ztr.effective_to IS NULL OR ztr.effective_to > SYSDATE)
ORDER  BY zr.tax_regime_code, zt.tax, zts.tax_status_code;

-- Party tax profile for operating unit (required for tax determination)
SELECT zpp.party_type_code,
       zpp.party_id,
       zpp.effective_from_use,
       zpp.effective_to_use,
       zpp.allow_offset_tax_flag,
       zpp.use_le_as_subscriber_flag
FROM   zx_party_tax_profile zpp
WHERE  zpp.party_id = :org_id
  AND  zpp.party_type_code = 'OU';
\`\`\`

If no party tax profile exists for the OU, create it in Tax → Setup → Party Tax Profiles → Operating Units.

---

## Phase 11 — Open AP and AR Periods

### 11.1 Open the First AP Period

Payables Responsibility → Accounting → Control Payables Periods

Change the period status for the implementation start period from 'Never Opened' to 'Open'. For a new implementation, open the first period of the implementation year.

\`\`\`sql
-- Verify AP periods after opening
SELECT period_name,
       start_date,
       end_date,
       closing_status
FROM   gl_period_statuses
WHERE  application_id = 200
  AND  set_of_books_id = :ledger_id
ORDER  BY start_date DESC
FETCH  FIRST 6 ROWS ONLY;
\`\`\`

### 11.2 Open the First AR Period

Receivables Responsibility → Control → Accounting → Open and Close Periods

\`\`\`sql
-- Verify AR periods
SELECT period_name,
       start_date,
       end_date,
       closing_status
FROM   gl_period_statuses
WHERE  application_id = 222
  AND  set_of_books_id = :ledger_id
ORDER  BY start_date DESC
FETCH  FIRST 6 ROWS ONLY;
\`\`\`

Both AP and AR must have at least one OPEN period before any transaction entry or testing can begin.

---

## Phase 12 — Supplier and Customer Seed Data

### 12.1 Validate Supplier Import Interface

Before running the Supplier Open Interface Import concurrent program:

\`\`\`sql
-- Check for invalid TERMS_ID values in the interface table
SELECT ai.vendor_name,
       ai.terms_id,
       ai.pay_group_lookup_code
FROM   ap_suppliers_int ai
WHERE  ai.status IS NULL
  AND  ai.terms_id NOT IN (SELECT term_id FROM ap_terms WHERE enabled_flag = 'Y')
  AND  ai.terms_id IS NOT NULL;

-- Check for duplicate vendor numbers
SELECT vendor_num, COUNT(*) FROM ap_suppliers_int
WHERE status IS NULL
GROUP BY vendor_num HAVING COUNT(*) > 1;
\`\`\`

Fix any mismatches before running the import program. Failed interface records must be corrected and re-imported — there is no partial rollback.

### 12.2 Validate Customer Import (TCA)

\`\`\`sql
-- Check TCA import batch for errors before running
SELECT iface.party_name,
       iface.party_type,
       iface.interface_status,
       COUNT(*) AS record_count
FROM   hz_imp_parties_int iface
WHERE  iface.batch_id = :batch_id
GROUP  BY iface.party_name, iface.party_type, iface.interface_status
ORDER  BY iface.interface_status;
\`\`\`

---

## Phase 13 — Monitoring Script and Crontab

### 13.1 Install the Configuration Validator

\`\`\`bash
cat > /opt/scripts/ebs_ap_ar_config_check.sh << 'SCRIPT'
#!/bin/bash
ORACLE_HOME=/u01/app/oracle/product/19c/dbhome_1
ORACLE_SID=EBSPROD
APPS_USER=apps
APPS_PASS=\${APPS_PASSWORD:-apps}
ORG_ID=\${ORG_ID:-101}
ALERT_EMAIL=ebs-impl-dba@example.com
LOG=/var/log/ebs_ap_ar_config_check.log
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
ERRORS=0; WARNINGS=0; REPORT=""

export ORACLE_HOME ORACLE_SID
export PATH=\${ORACLE_HOME}/bin:\${PATH}
export NLS_DATE_FORMAT="YYYY-MM-DD HH24:MI:SS"

log()  { echo "[\${TIMESTAMP}] \$*" | tee -a "\${LOG}"; }
fail() { ERRORS=\$((ERRORS+1));     REPORT="\${REPORT}\nFAIL:  \$*"; log "FAIL:  \$*"; }
warn() { WARNINGS=\$((WARNINGS+1)); REPORT="\${REPORT}\nWARN:  \$*"; log "WARN:  \$*"; }
pass() { log "PASS:  \$*"; }

run_sql() { sqlplus -s "\${APPS_USER}/\${APPS_PASS}" <<< "SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMOUT ON TRIMSPOOL ON
\$1
EXIT"; }

# OU and Ledger
OU_STATUS=\$(run_sql "SELECT NVL(TO_CHAR(hou.set_of_books_id),'NULL')||'|'||NVL(gl.completion_status,'NULL')||'|'||NVL(TO_CHAR(hou.default_legal_context_id),'NULL') FROM hr_operating_units hou LEFT JOIN gl_ledgers gl ON gl.ledger_id=hou.set_of_books_id WHERE hou.organization_id=\${ORG_ID};")
SOB=\$(echo "\${OU_STATUS}" | cut -d'|' -f1)
LEDGER_COMP=\$(echo "\${OU_STATUS}" | cut -d'|' -f2)
LE=\$(echo "\${OU_STATUS}" | cut -d'|' -f3)
[ "\${SOB}" = "NULL" ]       && fail "OU \${ORG_ID}: no ledger assigned" || pass "OU ledger assigned SOB=\${SOB}"
[ "\${LEDGER_COMP}" != "COMPLETE" ] && fail "Ledger completion_status=\${LEDGER_COMP}" || pass "Ledger COMPLETE"
[ "\${LE}" = "NULL" ]        && warn "OU: no default legal entity" || pass "Legal entity assigned"

# AP Financials Options
AP_FIN=\$(run_sql "SELECT NVL(TO_CHAR(accts_pay_code_combination_id),'NULL') FROM fnd_financials_system_params_all WHERE org_id=\${ORG_ID};")
[ -z "\${AP_FIN}" ] && fail "AP Financials Options not saved for OU \${ORG_ID}" || { [ "\${AP_FIN}" = "NULL" ] && fail "AP liability account CCID is null" || pass "AP liability account configured"; }

# AP Payables Options
AP_OPT=\$(run_sql "SELECT NVL(invoice_currency_code,'NULL') FROM ap_system_parameters_all WHERE org_id=\${ORG_ID};")
[ -z "\${AP_OPT}" ] && fail "AP Payables Options not saved for OU \${ORG_ID}" || { [ "\${AP_OPT}" = "NULL" ] && fail "AP invoice currency null" || pass "AP Payables Options saved currency=\${AP_OPT}"; }

# AP Bank Account
AP_BA=\$(run_sql "SELECT COUNT(*) FROM ce_bank_acct_uses_all cbau JOIN ce_bank_accounts cba ON cba.bank_account_id=cbau.bank_account_id WHERE cbau.org_id=\${ORG_ID} AND cbau.ap_use_enable_flag='Y' AND (cba.account_inactive_date IS NULL OR cba.account_inactive_date>SYSDATE);")
[ "\${AP_BA}" -eq 0 ] && fail "No active AP-enabled bank account for OU \${ORG_ID}" || pass "\${AP_BA} active AP bank account(s)"

AP_DOC=\$(run_sql "SELECT COUNT(*) FROM ce_bank_acct_uses_all cbau JOIN ce_bank_accounts cba ON cba.bank_account_id=cbau.bank_account_id JOIN ce_payment_documents cpd ON cpd.bank_account_id=cba.bank_account_id WHERE cbau.org_id=\${ORG_ID} AND cbau.ap_use_enable_flag='Y' AND cpd.payment_document_status='ACTIVE';")
[ "\${AP_DOC}" -eq 0 ] && fail "No active AP payment documents for OU \${ORG_ID}" || pass "\${AP_DOC} active payment document(s)"

# AR System Options
AR_OPT=\$(run_sql "SELECT NVL(TO_CHAR(receivables_ccid),'NULL')||'|'||NVL(accounting_method,'NULL') FROM ar_system_parameters_all WHERE org_id=\${ORG_ID};")
[ -z "\${AR_OPT}" ] && fail "AR System Options not saved for OU \${ORG_ID}" || {
  AR_REC=\$(echo "\${AR_OPT}" | cut -d'|' -f1)
  AR_METH=\$(echo "\${AR_OPT}" | cut -d'|' -f2)
  [ "\${AR_REC}" = "NULL" ]  && fail "AR receivable account CCID null" || pass "AR receivable account CCID=\${AR_REC}"
  [ "\${AR_METH}" = "NULL" ] && fail "AR accounting method null"       || pass "AR accounting method=\${AR_METH}"
}

# AR AutoAccounting
for FUNC in Revenue Receivable Tax Freight; do
  CNT=\$(run_sql "SELECT COUNT(*) FROM ra_account_defaults rad WHERE rad.name='\${FUNC}';")
  [ "\${CNT}" -eq 0 ] && fail "AR AutoAccounting function '\${FUNC}' not configured" || pass "AR AutoAccounting: \${FUNC}"
done

# AR Transaction Types
AR_TT=\$(run_sql "SELECT COUNT(*) FROM ra_cust_trx_types_all WHERE status='A' AND org_id=\${ORG_ID};")
[ "\${AR_TT}" -eq 0 ] && fail "No active AR transaction types for OU \${ORG_ID}" || pass "\${AR_TT} active AR transaction type(s)"

# AR Receipt Methods
AR_RM=\$(run_sql "SELECT COUNT(DISTINCT arm.receipt_class_id) FROM ar_receipt_methods arm JOIN ar_receipt_method_accounts arma ON arma.receipt_method_id=arm.receipt_method_id WHERE arm.end_date IS NULL OR arm.end_date>SYSDATE;")
[ "\${AR_RM}" -eq 0 ] && fail "No active AR receipt methods with bank accounts" || pass "\${AR_RM} active AR receipt method(s)"

# Open Periods
AP_OPEN=\$(run_sql "SELECT COUNT(*) FROM gl_period_statuses WHERE application_id=200 AND closing_status='O' AND set_of_books_id=(SELECT set_of_books_id FROM ap_system_parameters_all WHERE org_id=\${ORG_ID});")
AR_OPEN=\$(run_sql "SELECT COUNT(*) FROM gl_period_statuses WHERE application_id=222 AND closing_status='O' AND set_of_books_id=(SELECT set_of_books_id FROM ar_system_parameters_all WHERE org_id=\${ORG_ID});")
[ "\${AP_OPEN}" -eq 0 ] && fail "No open AP periods" || pass "\${AP_OPEN} open AP period(s)"
[ "\${AR_OPEN}" -eq 0 ] && fail "No open AR periods" || pass "\${AR_OPEN} open AR period(s)"

# eBTax
EBTAX=\$(run_sql "SELECT COUNT(DISTINCT tax_regime_code) FROM zx_regimes_b WHERE effective_to IS NULL OR effective_to>SYSDATE;")
[ "\${EBTAX}" -eq 0 ] && warn "No active eBTax regimes — tax will not be calculated" || pass "\${EBTAX} eBTax regime(s)"

# Summary
log "====== Summary: ERRORS=\${ERRORS} WARNINGS=\${WARNINGS} ======"
if [ "\${ERRORS}" -gt 0 ] || [ "\${WARNINGS}" -gt 0 ]; then
  printf "EBS AP/AR Config Validator\nHost: \$(hostname)\nOU: \${ORG_ID}\nTime: \${TIMESTAMP}\n\nErrors: \${ERRORS}  Warnings: \${WARNINGS}\n\${REPORT}\n\nLog: \${LOG}\n" \
    | mail -s "EBS AP/AR Config Issues - \$(hostname)" "\${ALERT_EMAIL}"
  log "Email sent to \${ALERT_EMAIL}"
fi
SCRIPT

chmod 750 /opt/scripts/ebs_ap_ar_config_check.sh
chown applmgr:oinstall /opt/scripts/ebs_ap_ar_config_check.sh
\`\`\`

### 13.2 Crontab Schedule

\`\`\`
# EBS AP/AR config validator — daily 7 AM during implementation, remove after go-live
0 7 * * * ORG_ID=101 APPS_PASSWORD=apps /opt/scripts/ebs_ap_ar_config_check.sh >> /var/log/ebs_ap_ar_config_cron.log 2>&1
\`\`\`

---

## Phase 14 — Maintenance Calendar

### During Implementation (Weekly)
- Run configuration validator after each setup session
- Validate accounting entries on test invoices and receipts
- Confirm period statuses align with test timeline

### Go-Live Week
- Run full configuration validator once per day
- Verify first live invoice and receipt each day posts to GL without error
- Confirm AP and AR periods for the go-live month are both Open

### Monthly (Steady State)
- Validate bank account payment documents have not exhausted check numbers
- Confirm eBTax rate effectivity dates have not expired
- Review GL_PERIOD_STATUSES: close prior periods in AP and AR after month-end close

### Quarterly
- Audit Financials Options and Payables Options for any unintended changes
- Re-validate AutoAccounting segment assignments if the Chart of Accounts was modified
- Check that new suppliers and customers imported during the quarter have valid TERMS_ID and payment method assignments

---

## Phase 15 — Troubleshooting Quick Reference

| Error | Root Cause | Fix |
|-------|-----------|-----|
| "No liability account" on AP invoice | ACCTS_PAY_CODE_COMBINATION_ID null in Financials Options | Enter liability account in Payables → Setup → Options → Financials |
| "Organization context not set" | ORG_ID profile not set for responsibility | Set MO: Operating Unit profile at responsibility level |
| AP invoice saves but no accounting | AP period closed or liability account inactive | Open AP period; activate GL account |
| "Receipt class not found" | No active receipt method with bank account | Create receipt class, payment method, and bank account assignment |
| "AutoAccounting rule not found" | Missing AutoAccounting function for Revenue/Receivable | Configure all AutoAccounting functions in AR Setup |
| AR invoice POST_TO_GL = N | Transaction type was created with post_to_gl = N | Update transaction type or create new one with Y |
| Tax not generated on invoice | No eBTax regime or no party tax profile for OU | Create tax regime and assign OU party tax profile |
| Supplier import rejected INVALID_TERMS | TERMS_ID in interface does not exist in AP_TERMS | Create missing payment terms before re-running import |
| AR receipt cannot apply | ALLOW_OVERAPPLICATION_FLAG = N and receipt > invoice | Update transaction type or split receipt |
| AP payment batch: no payment document | No active payment document on bank account | Create payment document in Cash Management → Bank Accounts |`,
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
