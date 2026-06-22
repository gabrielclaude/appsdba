import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: EBS to Oracle Cloud Fusion ERP Migration',
  slug: 'ebs-to-fusion-erp-migration-runbook',
  excerpt:
    'End-to-end phase-by-phase runbook covering discovery, enterprise structure design, data extraction and cleansing, FBDI loading, integration rebuild, cutover, and post-go-live stabilisation.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-22'),
  youtubeUrl: null,
  content: `This runbook provides the operational steps for migrating from Oracle EBS to Oracle Cloud Fusion ERP. Assumptions: Oracle EBS R12.2.x source, Oracle Fusion Cloud ERP subscription active, Oracle Integration Cloud (OIC) provisioned, DBA and functional SME availability for each EBS module in scope.

---

## Phase 0: Discovery and Current-State Documentation

### Step 0.1 — Document EBS Modules in Use

\`\`\`sql
-- Extract installed and active EBS products
SELECT fpi.application_short_name,
       fa.application_name,
       fpi.product_version,
       DECODE(fpi.status, 'I', 'Installed', 'S', 'Shared', 'N', 'Not Installed', fpi.status) status
FROM applsys.fnd_product_installations fpi
JOIN applsys.fnd_application_tl fa
  ON fpi.application_id = fa.application_id
  AND fa.language = 'US'
WHERE fpi.status IN ('I', 'S')
ORDER BY fa.application_name;
\`\`\`

### Step 0.2 — Extract EBS Enterprise Structure

\`\`\`sql
-- Legal Entities
SELECT le.legal_entity_id, le.name legal_entity_name, le.registration_number
FROM xle_entity_profiles le
ORDER BY le.name;

-- Operating Units
SELECT ou.organization_id, ou.name ou_name,
       le.name legal_entity_name,
       sob.name set_of_books
FROM hr_operating_units ou
JOIN xle_entity_profiles le ON ou.legal_entity_id = le.legal_entity_id
JOIN gl_sets_of_books sob ON ou.set_of_books_id = sob.set_of_books_id
ORDER BY ou.name;

-- Chart of Accounts structure
SELECT fifs.id_flex_structure_name, fifs.description,
       COUNT(fifc.segment_num) segment_count
FROM fnd_id_flex_structures fifs
JOIN fnd_id_flex_segments fifc
  ON fifs.application_id = fifc.application_id
  AND fifs.id_flex_code = fifc.id_flex_code
  AND fifs.id_flex_num = fifc.id_flex_num
WHERE fifs.id_flex_code = 'GL#'
GROUP BY fifs.id_flex_structure_name, fifs.description
ORDER BY fifs.id_flex_structure_name;
\`\`\`

### Step 0.3 — Customisation Inventory

\`\`\`sql
-- Custom concurrent programs (APPLICATION_SHORT_NAME not starting with standard Oracle codes)
SELECT application_short_name, COUNT(*) custom_programs
FROM applsys.fnd_concurrent_programs fcp
JOIN applsys.fnd_application fa ON fcp.application_id = fa.application_id
WHERE fcp.enabled_flag = 'Y'
  AND fa.application_short_name LIKE 'XX%'  -- custom apps typically XX prefix
GROUP BY application_short_name
ORDER BY custom_programs DESC;

-- Custom database objects in APPS schema
SELECT object_type, COUNT(*) cnt
FROM dba_objects
WHERE owner = 'APPS'
  AND object_name LIKE 'XX%'
  AND status = 'VALID'
GROUP BY object_type
ORDER BY cnt DESC;
\`\`\`

### Step 0.4 — Interface Inventory

\`\`\`sql
-- FTP / file-based interfaces registered in EBS
SELECT interface_name, description, direction_flag,
       last_update_date
FROM applsys.fnd_flex_workflow_processes
WHERE object_type = 'INTERFACE'
ORDER BY interface_name;
\`\`\`

Supplement with interviews of the EBS team and the integration/middleware team. Document each interface in a spreadsheet: name, direction (inbound/outbound), frequency, source system, target system, current technology (SQL, SOA, flat file).

### Step 0.5 — Data Volume Assessment

\`\`\`sql
-- Key table volumes for migration sizing
SELECT 'AP_INVOICES_ALL' tbl, COUNT(*) total_rows,
       COUNT(CASE WHEN payment_status_flag != 'Y' THEN 1 END) open_rows
FROM ap.ap_invoices_all
UNION ALL
SELECT 'RA_CUSTOMER_TRX_ALL', COUNT(*),
       COUNT(CASE WHEN complete_flag = 'Y' AND status_code != 'CL' THEN 1 END)
FROM ar.ra_customer_trx_all
UNION ALL
SELECT 'AP_SUPPLIERS', COUNT(*), COUNT(CASE WHEN vendor_type_lookup_code != 'EMPLOYEE' THEN 1 END)
FROM ap.ap_suppliers
UNION ALL
SELECT 'HZ_PARTIES (customers)', COUNT(*), COUNT(CASE WHEN party_type = 'ORGANIZATION' THEN 1 END)
FROM hz.hz_parties
UNION ALL
SELECT 'GL_BALANCES', COUNT(*), COUNT(CASE WHEN period_type = 'Month' THEN 1 END)
FROM gl.gl_balances;
\`\`\`

---

## Phase 1: Enterprise Structure Design in Fusion

This phase is performed in Oracle Fusion, not in EBS. Work with functional consultants to complete it.

### Step 1.1 — Map EBS Organisations to Fusion

Create a mapping spreadsheet:

| EBS Structure | EBS Value | Fusion Structure | Fusion Value |
|--------------|-----------|-----------------|-------------|
| Set of Books | Global Corp US Ledger | Ledger | Global Corp US |
| Legal Entity | Global Corp Inc | Legal Entity | Global Corp Inc |
| Operating Unit | US Operations | Business Unit | US Operations BU |
| Inventory Org | M1 (Manufacturing) | Inventory Org | M1 |

Note: EBS allows many-to-many between Operating Units and Sets of Books. Fusion has stricter relationships between Business Units and Ledgers. Rationalise any M:M relationships before go-live.

### Step 1.2 — Design Fusion Chart of Accounts

EBS CoA uses key flexfields with independent segments (Company-Cost Centre-Account-Product-Intercompany-Future). Fusion uses a structured account model.

For each EBS CoA segment, document:
- Segment name and purpose
- Number of active values
- Whether segment maps directly to a Fusion segment or requires consolidation
- Value set migration (all active values must be loaded to Fusion)

### Step 1.3 — Configure Fusion Accounting Calendar

Match Fusion period names exactly to EBS period names for the periods you will load as beginning balances. A mismatch causes FBDI import failures.

### Step 1.4 — Configure Reference Data Sets

Fusion uses Reference Data Sets to share common data across Business Units (payment terms, currencies, tax codes). Map EBS lookup codes to Fusion reference data.

---

## Phase 2: Data Extraction from EBS

### Step 2.1 — Extract Supplier Master

\`\`\`sql
-- Full supplier extract for FBDI (AP suppliers and sites)
SELECT aps.vendor_id,
       aps.vendor_name,
       aps.vendor_number,
       aps.vendor_type_lookup_code,
       aps.enabled_flag,
       apss.vendor_site_id,
       apss.vendor_site_code,
       apss.address_line1,
       apss.address_line2,
       apss.city,
       apss.state,
       apss.zip,
       apss.country,
       apss.pay_site_flag,
       apss.purchasing_site_flag
FROM ap.ap_suppliers aps
JOIN ap.ap_supplier_sites_all apss ON aps.vendor_id = apss.vendor_id
WHERE aps.enabled_flag = 'Y'
  AND apss.inactive_date IS NULL
ORDER BY aps.vendor_name, apss.vendor_site_code;
\`\`\`

### Step 2.2 — Extract Customer Master

\`\`\`sql
-- Customer master extract
SELECT hp.party_id, hp.party_name, hp.party_number,
       hca.account_number, hca.account_name,
       hcas.site_use_id, hcas.site_use_code,
       hps.address1, hps.address2, hps.city, hps.state,
       hps.postal_code, hps.country
FROM hz.hz_parties hp
JOIN hz.hz_cust_accounts hca ON hp.party_id = hca.party_id
JOIN hz.hz_cust_acct_sites_all hcas ON hca.cust_account_id = hcas.cust_account_id
JOIN hz.hz_party_sites hps ON hcas.party_site_id = hps.party_site_id
WHERE hca.status = 'A'
  AND hcas.status = 'A'
ORDER BY hp.party_name;
\`\`\`

### Step 2.3 — Extract Open AP Invoices

\`\`\`sql
-- Open AP invoices at cutover date (adjust &cutover_date)
SELECT ai.invoice_id, ai.invoice_num, ai.invoice_date,
       ai.vendor_id, ai.vendor_site_id,
       ai.invoice_amount, ai.amount_paid,
       ai.invoice_amount - ai.amount_paid outstanding_amount,
       ai.invoice_currency_code, ai.due_date,
       ai.description
FROM ap.ap_invoices_all ai
WHERE ai.payment_status_flag != 'Y'   -- not fully paid
  AND ai.cancelled_date IS NULL
  AND ai.invoice_date <= TO_DATE('&cutover_date', 'YYYY-MM-DD')
ORDER BY ai.vendor_id, ai.invoice_date;
\`\`\`

### Step 2.4 — Extract GL Beginning Balances

\`\`\`sql
-- GL beginning balances at cutover period (net of all periods up to cutover)
SELECT gcc.segment1 company, gcc.segment2 cost_center, gcc.segment3 account,
       gb.currency_code,
       gb.period_name,
       gb.begin_balance_dr,
       gb.begin_balance_cr,
       gb.period_net_dr,
       gb.period_net_cr
FROM gl.gl_balances gb
JOIN gl.gl_code_combinations gcc ON gb.code_combination_id = gcc.code_combination_id
WHERE gb.ledger_id = &ledger_id
  AND gb.period_name = '&cutover_period'
  AND (gb.begin_balance_dr + gb.period_net_dr - gb.begin_balance_cr - gb.period_net_cr) != 0
ORDER BY gcc.segment1, gcc.segment3;
\`\`\`

---

## Phase 3: Data Cleansing

### Step 3.1 — Deduplicate Suppliers

\`\`\`sql
-- Find duplicate supplier names (different vendor_id, same name)
SELECT UPPER(TRIM(vendor_name)) clean_name, COUNT(*) dup_count,
       LISTAGG(vendor_id, ', ') WITHIN GROUP (ORDER BY vendor_id) vendor_ids
FROM ap.ap_suppliers
WHERE enabled_flag = 'Y'
GROUP BY UPPER(TRIM(vendor_name))
HAVING COUNT(*) > 1
ORDER BY dup_count DESC
FETCH FIRST 50 ROWS ONLY;
\`\`\`

For each duplicate: decide which vendor_id is the master record; update all AP_INVOICES and AP_SUPPLIER_SITES to the master vendor_id; disable the duplicate.

### Step 3.2 — Validate Payment Terms Exist in Fusion

Extract all distinct payment terms used in open AP invoices, then cross-check against Fusion's payment terms list. Create any missing terms in Fusion before loading invoices.

\`\`\`sql
SELECT terms_id, terms_name, COUNT(*) invoice_count
FROM ap.ap_invoices_all ai
JOIN ap.ap_terms apt ON ai.terms_id = apt.term_id
WHERE ai.payment_status_flag != 'Y'
GROUP BY terms_id, terms_name
ORDER BY invoice_count DESC;
\`\`\`

### Step 3.3 — Map EBS GL Accounts to Fusion COA

For each EBS CoA segment value, create the corresponding Fusion value set entry. Use a Python or Excel transformation to generate the Fusion COA Values FBDI template from the EBS extract.

---

## Phase 4: FBDI Loading

### Step 4.1 — Download FBDI Templates

Navigate in Fusion: Tools → File Import and Export → Templates

Download templates for each object you are loading. Templates are versioned — always use the template that matches your Fusion instance version.

### Step 4.2 — Transform EBS Data into FBDI Format

Each FBDI template has a specific column mapping. Example for Supplier FBDI:

| FBDI Column | EBS Source |
|------------|-----------|
| Supplier Name | AP_SUPPLIERS.VENDOR_NAME |
| Supplier Number | AP_SUPPLIERS.VENDOR_NUMBER |
| Supplier Type | AP_SUPPLIERS.VENDOR_TYPE_LOOKUP_CODE → map to Fusion lookup |
| Tax Registration Number | AP_SUPPLIERS.NUM_1099 |
| Site Name | AP_SUPPLIER_SITES_ALL.VENDOR_SITE_CODE |
| Country | AP_SUPPLIER_SITES_ALL.COUNTRY → ISO code |

Use Python/pandas or Excel macros to transform the EBS extract. Validate: row counts match, required fields are populated, lookup codes are valid.

### Step 4.3 — Upload FBDI File to Oracle UCM

\`\`\`bash
# Upload via Fusion REST API
curl -X POST \
  "https://<fusion_host>/fscmRestApi/resources/11.13.18.05/erpintegrations" \
  -H "Content-Type: application/json" \
  -u <username>:<password> \
  -d '{
    "OperationName": "uploadFileToUCM",
    "DocumentContent": "<base64-encoded-zip>",
    "DocumentName": "SupplierImport.zip",
    "ContentType": "zip",
    "DocumentAccount": "fin$/payables$/import$"
  }'
\`\`\`

### Step 4.4 — Submit Import Process in Fusion

Navigate: Tools → Scheduled Processes → Schedule New Process

Select the appropriate import process (e.g., "Import Suppliers") and provide the UCM document reference from Step 4.3.

### Step 4.5 — Review Import Errors

Navigate: Tools → Scheduled Processes → find your process → View Log

All FBDI errors are logged at the row level. Download the error report, correct the data in the source FBDI file, and re-upload.

### Step 4.6 — Reconcile Loaded Counts

\`\`\`sql
-- EBS source count (from Step 2.x extract)
-- Fusion loaded count (from Fusion REST API or OTBI report)
-- Delta must be zero or explained by intentional exclusions (disabled records, etc.)
\`\`\`

---

## Phase 5: Integration Rebuild Checklist

### Step 5.1 — Provision OIC Instance

Navigate: OCI Console → Oracle Integration → Create Instance

Configure: Enterprise edition, sufficient message pack for your volume (1M messages/hour minimum for mid-sized ERP).

### Step 5.2 — Create Fusion Connections in OIC

In OIC → Connections:
- Create Oracle ERP Cloud connection (adapter type: Oracle ERP Cloud)
- Test: invoke a Suppliers REST API to verify connectivity
- Create connections for each external system in your integration inventory

### Step 5.3 — Rebuild Each Integration

For each integration identified in Phase 0 Step 0.4:

1. Define the OIC integration (trigger + action + mapping)
2. Map fields from source to Fusion REST API schema
3. Handle error scenarios (failed Fusion API call → notification to ERP team)
4. Deploy to OIC Test environment
5. Execute integration test with representative data volume
6. Document the integration with OIC integration ID and endpoint URL

### Step 5.4 — Load Test Integrations

Run each integration at 2x expected production volume. Verify:
- OIC message processing time within SLA
- No dropped messages under load
- Fusion accepts all records without API rate limit errors

---

## Phase 6: Cutover Execution

### Step 6.1 — Pre-Cutover Checklist (D-7)

| Item | Owner | Status |
|------|-------|--------|
| All FBDI loads completed in pre-production | DBA | ☐ |
| All OIC integrations tested and signed off | Integration Lead | ☐ |
| Cutover dry run completed (D-14) | Project Manager | ☐ |
| EBS freeze communication sent to all users | Change Manager | ☐ |
| Fusion user access provisioned for all go-live users | Security | ☐ |
| Support model agreed (hypercare team, escalation path) | Programme Lead | ☐ |

### Step 6.2 — EBS Freeze (Cutover Start)

\`\`\`sql
-- Lock EBS users (prevent new transactions while extracting final delta)
-- Set EBS system profile to disable new logins (except DBAs)
UPDATE applsys.fnd_user
SET end_date = SYSDATE
WHERE end_date IS NULL
  AND user_name NOT IN ('SYSADMIN', 'APPS_NE');
COMMIT;
\`\`\`

### Step 6.3 — Final Delta Extracts

Extract any transactions created or modified since the last full extract (Step 2.x). Focus on: new open AP invoices, new customers, GL journal adjustments.

Load the delta via FBDI (same process as Phase 4).

### Step 6.4 — Balance Reconciliation Before Go-Live

\`\`\`sql
-- EBS trial balance at cutover date
SELECT gcc.segment1 || '-' || gcc.segment3 account,
       SUM(gb.period_net_dr - gb.period_net_cr) balance
FROM gl.gl_balances gb
JOIN gl.gl_code_combinations gcc ON gb.code_combination_id = gcc.code_combination_id
WHERE gb.ledger_id = &ledger_id
  AND gb.period_name = '&cutover_period'
GROUP BY gcc.segment1, gcc.segment3
ORDER BY 1;
\`\`\`

Compare to Fusion trial balance (via OTBI: General Ledger → Trial Balance Report). Any unexplained variance must be resolved before go-live sign-off.

### Step 6.5 — Go/No-Go Decision

| Criterion | Target | Actual | Go? |
|-----------|--------|--------|-----|
| AP invoice load reconciliation | 0 variance | | ☐ |
| GL beginning balance reconciliation | 0 variance | | ☐ |
| OIC integrations active and tested | 100% | | ☐ |
| Fusion user access validated by 5 pilot users | Pass | | ☐ |
| Hypercare team available on call | Confirmed | | ☐ |

---

## Phase 7: Post-Go-Live Stabilisation

### Step 7.1 — Daily Checks (Week 1–2)

\`\`\`bash
# OIC monitoring: check for failed integrations
curl -X GET "https://<oic_host>/ic/api/integration/v1/monitoring/instances?status=FAILED" \
  -H "Authorization: Bearer <token>"
\`\`\`

Monitor Fusion ESS (Enterprise Scheduler Service) for failed processes daily.

### Step 7.2 — Balance Reconciliation (Month 1)

Run EBS vs Fusion trial balance comparison for each accounting period in the first month post-go-live. Any variance triggers a reconciliation task before period close.

### Step 7.3 — Hypercare Support Model

| Issue Severity | Response Time | Escalation Path |
|---------------|--------------|----------------|
| P1: Business cannot transact | Immediate | Project Manager + Oracle Support |
| P2: Process impaired | 4 hours | Functional Lead + OIC Admin |
| P3: Report discrepancy | Next business day | Functional Analyst |`,
};

async function main() {
  console.log('Inserting EBS to Fusion migration runbook...');
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
