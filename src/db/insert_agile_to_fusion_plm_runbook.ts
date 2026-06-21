import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Agile PLM to Fusion Cloud PLM Migration Runbook: Extract, Transform, Load, and Cutover',
  slug: 'oracle-agile-plm-to-fusion-cloud-plm-migration-runbook',
  excerpt:
    'Step-by-step operational runbook for migrating from Oracle Agile PLM to Oracle Fusion Cloud PLM: data extract scripts, FBDI transformation, OIC pipeline setup, validation queries, integration cutover, and rollback procedure.',
  category: 'fusion-cloud-erp' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-20'),
  youtubeUrl: null,
  content: `This runbook covers the operational execution of an Oracle Agile PLM to Fusion Cloud PLM migration. It is structured as a sequence of phases that the DBA, integration architect, and functional team execute in order. The companion blog post covers the architecture decisions; this document is the execution checklist.

Estimated duration: 8–16 weeks depending on data volume and integration complexity. Run Phases 1–4 iteratively in the test environment before executing in production.

---

## Prerequisites

- Oracle Agile PLM instance (9.x or 9.3.x) with DBA access to the Agile Oracle Database schema
- Oracle Fusion Cloud PLM provisioned (Product Hub + Product Development modules activated)
- Oracle Integration Cloud (OIC) instance for integration pipelines
- Oracle Content Management (OCM) instance for attachment migration
- Python 3.9+ on the extraction host for transformation scripts
- FBDI template files downloaded from Oracle Support (Doc ID varies by Fusion version)
- Fusion Cloud administrator account with Product Hub and Product Development setup roles

Verify Agile DB access:

\`\`\`sql
-- Run as AGILE schema owner or DBA with grants
SELECT owner, COUNT(*) AS table_count
FROM   all_tables
WHERE  owner IN ('AGILE', 'AGS')
GROUP  BY owner;

-- Confirm key tables are accessible
SELECT COUNT(*) FROM agile_parts WHERE ROWNUM = 1;
SELECT COUNT(*) FROM agile_bom   WHERE ROWNUM = 1;
SELECT COUNT(*) FROM agile_aml   WHERE ROWNUM = 1;
\`\`\`

---

## Phase 1 — Agile Data Assessment

### 1.1 Count Active Records

Run these queries to size the migration and identify data quality issues before starting.

\`\`\`sql
-- Part master summary by lifecycle phase
SELECT lifecycle_phase,
       COUNT(*)                         AS part_count,
       MIN(creation_date)               AS oldest_part,
       MAX(last_update_date)            AS last_modified
FROM   agile_parts
WHERE  delete_flag = 'N'
GROUP  BY lifecycle_phase
ORDER  BY part_count DESC;

-- BOM structure depth (maximum BOM levels)
-- Walk the self-join to find max depth — use CONNECT BY
SELECT MAX(LEVEL) AS max_bom_levels
FROM   agile_bom
CONNECT BY PRIOR child_part_number = parent_part_number
START WITH parent_part_number IN (
  SELECT DISTINCT parent_part_number FROM agile_bom
  WHERE  parent_part_number NOT IN (SELECT child_part_number FROM agile_bom)
);

-- AML entry count per approval status
SELECT approved_status, COUNT(*) AS entry_count
FROM   agile_aml
GROUP  BY approved_status
ORDER  BY entry_count DESC;

-- Open ECOs (not released)
SELECT status, COUNT(*) AS eco_count
FROM   agile_ecos
WHERE  status NOT IN ('RELEASED', 'CANCELLED', 'HOLD')
GROUP  BY status;

-- Attachment volume
SELECT COUNT(*)                              AS total_attachments,
       ROUND(SUM(file_size) / 1024 / 1024, 0) AS total_mb
FROM   agile_attachments
WHERE  delete_flag = 'N';
\`\`\`

### 1.2 Identify Data Quality Issues

\`\`\`sql
-- Parts with no description (required field in Fusion)
SELECT COUNT(*) AS parts_missing_description
FROM   agile_parts
WHERE  (description IS NULL OR TRIM(description) = '')
  AND  delete_flag = 'N'
  AND  lifecycle_phase = 'PRODUCTION';

-- Parts with non-standard UOM codes (must map to Fusion UOM values)
SELECT unit_of_measure, COUNT(*) AS usage_count
FROM   agile_parts
WHERE  delete_flag = 'N'
GROUP  BY unit_of_measure
ORDER  BY usage_count DESC;

-- BOM rows with missing quantity (invalid for Fusion)
SELECT COUNT(*) AS bom_rows_no_qty
FROM   agile_bom
WHERE  (quantity IS NULL OR quantity <= 0);

-- Duplicate part numbers (case-insensitive)
SELECT UPPER(part_number) AS normalised_pn, COUNT(*) AS dupe_count
FROM   agile_parts
WHERE  delete_flag = 'N'
GROUP  BY UPPER(part_number)
HAVING COUNT(*) > 1
ORDER  BY dupe_count DESC;
\`\`\`

Fix all data quality issues found before proceeding to extraction.

---

## Phase 2 — Extraction Scripts

### agile_extract_items.sh

\`\`\`bash
#!/usr/bin/env bash
# agile_extract_items.sh — Extract active parts from Agile PLM to CSV
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="\${SCRIPT_DIR}/extract"
LOG_DIR="\${SCRIPT_DIR}/logs"
mkdir -p "\${OUTPUT_DIR}" "\${LOG_DIR}"

TIMESTAMP=$(date '+%Y%m%d_%H%M%S')
LOG_FILE="\${LOG_DIR}/extract_items_\${TIMESTAMP}.log"
OUTPUT_FILE="\${OUTPUT_DIR}/agile_items_\${TIMESTAMP}.csv"

AGILE_CONN="\${AGILE_DB_USER}/\${AGILE_DB_PASS}@\${AGILE_DB_HOST}:\${AGILE_DB_PORT}/\${AGILE_DB_SERVICE}"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" | tee -a "\${LOG_FILE}"; }

log "Starting Agile item extraction"

sqlplus -s "\${AGILE_CONN}" <<ENDSQL > "\${OUTPUT_FILE}"
SET PAGESIZE 0
SET FEEDBACK OFF
SET HEADING OFF
SET LINESIZE 500
SET COLSEP '|'
SET TRIMSPOOL ON

-- Header row
SELECT 'PART_NUMBER|DESCRIPTION|LIFECYCLE_PHASE|UNIT_OF_MEASURE|ITEM_CLASS|REVISION|CREATION_DATE|LAST_UPDATE_DATE'
FROM dual;

-- Data rows
SELECT
    p.part_number                                    || '|' ||
    REPLACE(p.description, '|', ' ')                || '|' ||
    p.lifecycle_phase                                || '|' ||
    NVL(p.unit_of_measure, 'EA')                    || '|' ||
    NVL(c.class_name, 'Component')                  || '|' ||
    NVL(p.rev, 'A')                                 || '|' ||
    TO_CHAR(p.creation_date, 'YYYY-MM-DD')          || '|' ||
    TO_CHAR(p.last_update_date, 'YYYY-MM-DD')
FROM   agile_parts p
LEFT JOIN agile_classes c ON c.class_id = p.class_id
WHERE  p.delete_flag = 'N'
  AND  p.lifecycle_phase IN ('PRODUCTION', 'PRELIMINARY', 'PHASEOUT')
ORDER  BY p.part_number;
ENDSQL

ITEM_COUNT=$(wc -l < "\${OUTPUT_FILE}")
log "Extracted $((ITEM_COUNT - 1)) items to \${OUTPUT_FILE}"
\`\`\`

### agile_extract_bom.sh

\`\`\`bash
#!/usr/bin/env bash
# agile_extract_bom.sh — Extract BOM structures from Agile PLM
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="\${SCRIPT_DIR}/extract"
LOG_DIR="\${SCRIPT_DIR}/logs"
mkdir -p "\${OUTPUT_DIR}" "\${LOG_DIR}"

TIMESTAMP=$(date '+%Y%m%d_%H%M%S')
LOG_FILE="\${LOG_DIR}/extract_bom_\${TIMESTAMP}.log"
OUTPUT_FILE="\${OUTPUT_DIR}/agile_bom_\${TIMESTAMP}.csv"

AGILE_CONN="\${AGILE_DB_USER}/\${AGILE_DB_PASS}@\${AGILE_DB_HOST}:\${AGILE_DB_PORT}/\${AGILE_DB_SERVICE}"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" | tee -a "\${LOG_FILE}"; }

log "Starting Agile BOM extraction"

sqlplus -s "\${AGILE_CONN}" <<ENDSQL > "\${OUTPUT_FILE}"
SET PAGESIZE 0
SET FEEDBACK OFF
SET HEADING OFF
SET LINESIZE 500
SET TRIMSPOOL ON

SELECT 'PARENT_PART_NUMBER|CHILD_PART_NUMBER|QUANTITY|UOM|FIND_NUMBER|REF_DESIGNATOR|EFFECTIVE_DATE|OBSOLETE_DATE|NOTES'
FROM dual;

SELECT
    b.parent_part_number                                   || '|' ||
    b.child_part_number                                    || '|' ||
    TO_CHAR(NVL(b.quantity, 1))                           || '|' ||
    NVL(b.uom, 'EA')                                      || '|' ||
    TO_CHAR(NVL(b.find_number, 0))                        || '|' ||
    NVL(REPLACE(b.reference_designator, '|', ' '), '')    || '|' ||
    TO_CHAR(NVL(b.effective_date, SYSDATE), 'YYYY-MM-DD') || '|' ||
    NVL(TO_CHAR(b.obsolete_date, 'YYYY-MM-DD'), '')       || '|' ||
    NVL(REPLACE(b.notes, '|', ' '), '')
FROM   agile_bom b
JOIN   agile_parts p ON p.part_number = b.parent_part_number
WHERE  p.delete_flag       = 'N'
  AND  p.lifecycle_phase   = 'PRODUCTION'
  AND  b.obsolete_date    IS NULL
ORDER  BY b.parent_part_number, b.find_number;
ENDSQL

BOM_COUNT=$(wc -l < "\${OUTPUT_FILE}")
log "Extracted $((BOM_COUNT - 1)) BOM rows to \${OUTPUT_FILE}"
\`\`\`

### agile_extract_aml.sh

\`\`\`bash
#!/usr/bin/env bash
# agile_extract_aml.sh — Extract Approved Manufacturer List from Agile PLM
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="\${SCRIPT_DIR}/extract"
LOG_DIR="\${SCRIPT_DIR}/logs"
mkdir -p "\${OUTPUT_DIR}" "\${LOG_DIR}"

TIMESTAMP=$(date '+%Y%m%d_%H%M%S')
LOG_FILE="\${LOG_DIR}/extract_aml_\${TIMESTAMP}.log"
OUTPUT_FILE="\${OUTPUT_DIR}/agile_aml_\${TIMESTAMP}.csv"

AGILE_CONN="\${AGILE_DB_USER}/\${AGILE_DB_PASS}@\${AGILE_DB_HOST}:\${AGILE_DB_PORT}/\${AGILE_DB_SERVICE}"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" | tee -a "\${LOG_FILE}"; }

log "Starting Agile AML extraction"

sqlplus -s "\${AGILE_CONN}" <<ENDSQL > "\${OUTPUT_FILE}"
SET PAGESIZE 0
SET FEEDBACK OFF
SET HEADING OFF
SET LINESIZE 400
SET TRIMSPOOL ON

SELECT 'PART_NUMBER|MANUFACTURER_NAME|MFR_PART_NUMBER|APPROVED_STATUS|APPROVED_DATE'
FROM dual;

SELECT
    a.part_number                                       || '|' ||
    REPLACE(a.manufacturer_name, '|', ' ')             || '|' ||
    REPLACE(a.manufacturer_part_number, '|', ' ')      || '|' ||
    a.approved_status                                   || '|' ||
    NVL(TO_CHAR(a.approved_date, 'YYYY-MM-DD'), '')
FROM   agile_aml a
JOIN   agile_parts p ON p.part_number = a.part_number
WHERE  p.delete_flag     = 'N'
  AND  p.lifecycle_phase = 'PRODUCTION'
  AND  a.approved_status = 'APPROVED'
ORDER  BY a.part_number, a.manufacturer_name;
ENDSQL

AML_COUNT=$(wc -l < "\${OUTPUT_FILE}")
log "Extracted $((AML_COUNT - 1)) AML entries to \${OUTPUT_FILE}"
\`\`\`

---

## Phase 3 — Transformation

### transform_agile_to_fbdi.py

This script reads the Agile CSV extracts and produces FBDI-compatible import files for Fusion Cloud PLM.

\`\`\`python
#!/usr/bin/env python3
"""transform_agile_to_fbdi.py — Transform Agile extract CSVs to Fusion FBDI format."""

import csv
import os
import sys
import logging
from datetime import datetime
from pathlib import Path

LOG_FORMAT = '%(asctime)s %(levelname)s %(message)s'
logging.basicConfig(level=logging.INFO, format=LOG_FORMAT)
log = logging.getLogger(__name__)

EXTRACT_DIR = Path(os.environ.get('EXTRACT_DIR', './extract'))
OUTPUT_DIR  = Path(os.environ.get('OUTPUT_DIR', './fbdi'))
OUTPUT_DIR.mkdir(exist_ok=True)

TIMESTAMP = datetime.now().strftime('%Y%m%d_%H%M%S')

# UOM mapping: Agile code -> Fusion UOM code
UOM_MAP = {
    'EA':   'Ea',
    'EACH': 'Ea',
    'PC':   'Ea',
    'FT':   'Ft',
    'IN':   'In',
    'M':    'M',
    'CM':   'Cm',
    'LB':   'Lb',
    'KG':   'Kg',
    'GR':   'g',
    'L':    'L',
    'ML':   'Ml',
    'RL':   'Rl',
}

# Lifecycle phase mapping: Agile -> Fusion item status
LIFECYCLE_MAP = {
    'PRODUCTION':  'Active',
    'PRELIMINARY': 'Pending',
    'PHASEOUT':    'Inactive',
    'OBSOLETE':    'Inactive',
}

# Fusion organization for item master (update for your environment)
FUSION_ORG = os.environ.get('FUSION_ORG_CODE', 'M1')

ERRORS = []

def find_latest_extract(prefix: str) -> Path:
    files = sorted(EXTRACT_DIR.glob(f'{prefix}_*.csv'), reverse=True)
    if not files:
        raise FileNotFoundError(f"No extract file found with prefix {prefix} in {EXTRACT_DIR}")
    log.info(f"Using extract: {files[0]}")
    return files[0]

def transform_items():
    """Transform Agile item extract to Fusion Item FBDI format."""
    src = find_latest_extract('agile_items')
    out = OUTPUT_DIR / f'EgpItemImportTemplate_{TIMESTAMP}.csv'

    # Fusion FBDI column headers for Item Import
    fusion_headers = [
        'BATCH_ID', 'BATCH_NUMBER', 'ORGANIZATION_CODE',
        'ITEM_NUMBER', 'DESCRIPTION', 'LONG_DESCRIPTION',
        'ITEM_STATUS_CODE', 'PRIMARY_UOM_CODE',
        'ITEM_TYPE', 'USER_ITEM_TYPE',
        'CREATION_DATE', 'LAST_UPDATE_DATE',
    ]

    batch_id    = f"AGILE_MIG_{TIMESTAMP}"
    batch_num   = 1
    row_count   = 0

    with open(src, newline='', encoding='utf-8') as f_in, \
         open(out, 'w', newline='', encoding='utf-8') as f_out:

        reader = csv.DictReader(f_in, delimiter='|')
        writer = csv.DictWriter(f_out, fieldnames=fusion_headers)
        writer.writeheader()

        for row in reader:
            pn = row.get('PART_NUMBER', '').strip()
            if not pn:
                ERRORS.append(f"Skipping row with empty PART_NUMBER: {row}")
                continue

            uom_agile   = row.get('UNIT_OF_MEASURE', 'EA').strip().upper()
            uom_fusion  = UOM_MAP.get(uom_agile)
            if not uom_fusion:
                ERRORS.append(f"Unknown UOM '{uom_agile}' for part {pn} — defaulting to 'Ea'")
                uom_fusion = 'Ea'

            lifecycle   = row.get('LIFECYCLE_PHASE', 'PRODUCTION').strip().upper()
            status_code = LIFECYCLE_MAP.get(lifecycle, 'Inactive')

            writer.writerow({
                'BATCH_ID':          batch_id,
                'BATCH_NUMBER':      batch_num,
                'ORGANIZATION_CODE': FUSION_ORG,
                'ITEM_NUMBER':       pn,
                'DESCRIPTION':       row.get('DESCRIPTION', '').strip()[:240],
                'LONG_DESCRIPTION':  '',
                'ITEM_STATUS_CODE':  status_code,
                'PRIMARY_UOM_CODE':  uom_fusion,
                'ITEM_TYPE':         'Standard',
                'USER_ITEM_TYPE':    row.get('ITEM_CLASS', 'Purchased'),
                'CREATION_DATE':     row.get('CREATION_DATE', ''),
                'LAST_UPDATE_DATE':  row.get('LAST_UPDATE_DATE', ''),
            })
            row_count += 1

    log.info(f"Item FBDI written: {out} ({row_count} rows)")
    return out

def transform_bom():
    """Transform Agile BOM extract to Fusion Structure FBDI format."""
    src = find_latest_extract('agile_bom')
    out = OUTPUT_DIR / f'EgoStructureImportTemplate_{TIMESTAMP}.csv'

    fusion_headers = [
        'BATCH_ID', 'ORGANIZATION_CODE',
        'ASSEMBLY_ITEM_NUMBER', 'COMPONENT_ITEM_NUMBER',
        'QUANTITY', 'UOM_CODE',
        'ITEM_SEQUENCE', 'START_DATE', 'END_DATE',
        'REFERENCE_DESIGNATOR',
    ]

    batch_id  = f"AGILE_BOM_{TIMESTAMP}"
    row_count = 0

    with open(src, newline='', encoding='utf-8') as f_in, \
         open(out, 'w', newline='', encoding='utf-8') as f_out:

        reader = csv.DictReader(f_in, delimiter='|')
        writer = csv.DictWriter(f_out, fieldnames=fusion_headers)
        writer.writeheader()

        for row in reader:
            parent = row.get('PARENT_PART_NUMBER', '').strip()
            child  = row.get('CHILD_PART_NUMBER', '').strip()
            if not parent or not child:
                continue

            qty_str = row.get('QUANTITY', '1').strip()
            try:
                qty = float(qty_str)
                if qty <= 0:
                    qty = 1.0
            except ValueError:
                ERRORS.append(f"Invalid quantity '{qty_str}' for {parent}->{child}, defaulting to 1")
                qty = 1.0

            uom_agile  = row.get('UOM', 'EA').strip().upper()
            uom_fusion = UOM_MAP.get(uom_agile, 'Ea')

            writer.writerow({
                'BATCH_ID':              batch_id,
                'ORGANIZATION_CODE':     FUSION_ORG,
                'ASSEMBLY_ITEM_NUMBER':  parent,
                'COMPONENT_ITEM_NUMBER': child,
                'QUANTITY':              qty,
                'UOM_CODE':              uom_fusion,
                'ITEM_SEQUENCE':         row.get('FIND_NUMBER', '10').strip(),
                'START_DATE':            row.get('EFFECTIVE_DATE', ''),
                'END_DATE':              row.get('OBSOLETE_DATE', ''),
                'REFERENCE_DESIGNATOR':  row.get('REF_DESIGNATOR', '').strip()[:30],
            })
            row_count += 1

    log.info(f"BOM FBDI written: {out} ({row_count} rows)")
    return out

def write_error_report():
    if not ERRORS:
        log.info("No transformation errors.")
        return
    err_file = OUTPUT_DIR / f'transform_errors_{TIMESTAMP}.txt'
    with open(err_file, 'w') as f:
        for err in ERRORS:
            f.write(err + '\n')
    log.warning(f"{len(ERRORS)} transformation errors written to {err_file}")

if __name__ == '__main__':
    log.info("Starting Agile -> Fusion FBDI transformation")
    transform_items()
    transform_bom()
    write_error_report()
    log.info("Transformation complete")
\`\`\`

Run the transform:

\`\`\`bash
export EXTRACT_DIR=./extract
export OUTPUT_DIR=./fbdi
export FUSION_ORG_CODE=M1   # replace with your Fusion inventory organization code

python3 transform_agile_to_fbdi.py
\`\`\`

Review \`./fbdi/transform_errors_*.txt\` before proceeding. Every error must be resolved — either by fixing source data in Agile or by updating the UOM/lifecycle maps in the script.

---

## Phase 4 — Fusion Import (FBDI)

### 4.1 Upload FBDI Files to UCM

FBDI files must be uploaded to Oracle Content Management (UCM) before the import job can read them. Upload via the Fusion interface:

1. Navigate to **Tools → File Import and Export**
2. Upload \`EgpItemImportTemplate_<timestamp>.csv\` to the UCM account \`fin/productHub/import\`
3. Upload \`EgoStructureImportTemplate_<timestamp>.csv\` to \`fin/productDevelopment/import\`
4. Note the UCM file reference for each

Alternatively, use the UCM SOAP service to upload from the command line:

\`\`\`bash
# UCM upload via curl (replace credentials and UCM hostname)
curl -X POST \
  "https://<fusion-host>/idcws/GenericSoapPort" \
  -H "Content-Type: text/xml" \
  -u "\${FUSION_ADMIN_USER}:\${FUSION_ADMIN_PASS}" \
  --data-binary @ucm_upload_request.xml \
  -o ucm_upload_response.xml
\`\`\`

### 4.2 Schedule the Import Jobs

In Fusion, navigate to **Scheduled Processes → Schedule New Process**:

1. **Import Items in Batch** — provide the UCM file reference for the item FBDI
2. **Import Item Structures** — provide the UCM file reference for the BOM FBDI

Always run the Item import to completion and verify before running the Structure import. A BOM row referencing an item that does not yet exist in Fusion will be rejected with no diagnostic message on the item row itself.

### 4.3 Validate Import Results

\`\`\`sql
-- Run in Agile DB: confirm extract counts
SELECT COUNT(*) AS agile_active_parts
FROM   agile_parts
WHERE  delete_flag = 'N'
  AND  lifecycle_phase IN ('PRODUCTION', 'PRELIMINARY', 'PHASEOUT');
\`\`\`

In Fusion, verify via OTBI or REST API:

\`\`\`bash
# Count items via Fusion REST API
curl -s -u "\${FUSION_ADMIN_USER}:\${FUSION_ADMIN_PASS}" \
  "https://\${FUSION_HOST}/fscmRestApi/resources/11.13.18.05/items?onlyData=true&limit=1" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('Total items:', d.get('totalResults', 'N/A'))"
\`\`\`

Expected: Fusion item count equals Agile extract count minus any records intentionally excluded in the transformation.

---

## Phase 5 — Integration Cutover

### 5.1 Freeze the Agile-EBS Integration

Before go-live, freeze the Agile → EBS item sync so no new items flow from Agile to EBS during or after cutover:

\`\`\`bash
# In Agile PLM admin console: disable the EBS adapter job
# Or if using ODI: stop the ODI agent scenario for Agile-EBS sync
# Replace with the command appropriate for your integration tool

# Confirm the ODI scenario is stopped
odiparams -url jdbc:oracle:thin:@odi-host:1521/ODIDEV \
  -user SUPERVISOR -password "\${ODI_PASS}" \
  -exec "select scenario_name, last_exec_status from snp_scen_step where scenario_name like '%AGILE%'"
\`\`\`

Document the exact timestamp of the freeze. Any ECOs approved after this timestamp must be manually applied in Fusion after go-live.

### 5.2 Activate Fusion → Fusion Cloud ERP Integration

In Oracle Integration Cloud, activate the pre-built Product Hub to Inventory integration:

1. Navigate to OIC → Integrations
2. Locate **Oracle Product Hub to Inventory** integration
3. Configure the Fusion connection credentials (Product Hub and Inventory endpoints)
4. Activate and test with a single item sync before full activation

### 5.3 CAD Connector Cutover

If Agile CAD connectors (Creo, SolidWorks, CATIA) are in use:

1. Uninstall Agile CAD connector from engineering workstations
2. Install Fusion Cloud PLM CAD connector (download from Oracle Support)
3. Point the connector to the Fusion Cloud PLM endpoint
4. Validate a test file check-in from each CAD tool before engineering team cutover

---

## Phase 6 — Validation Queries

### Post-Migration Reconciliation

\`\`\`sql
-- Agile: count by lifecycle for comparison to Fusion OTBI
SELECT lifecycle_phase, COUNT(*) AS part_count
FROM   agile_parts
WHERE  delete_flag = 'N'
GROUP  BY lifecycle_phase
ORDER  BY part_count DESC;

-- Agile: total BOM rows for active parts
SELECT COUNT(*) AS active_bom_rows
FROM   agile_bom b
JOIN   agile_parts p ON p.part_number = b.parent_part_number
WHERE  p.delete_flag     = 'N'
  AND  p.lifecycle_phase = 'PRODUCTION'
  AND  b.obsolete_date  IS NULL;

-- Agile: AML count for active parts
SELECT COUNT(*) AS active_aml_rows
FROM   agile_aml a
JOIN   agile_parts p ON p.part_number = a.part_number
WHERE  p.delete_flag     = 'N'
  AND  p.lifecycle_phase = 'PRODUCTION'
  AND  a.approved_status = 'APPROVED';

-- Agile: open ECOs not yet migrated
SELECT status, COUNT(*) AS eco_count
FROM   agile_ecos
WHERE  status NOT IN ('RELEASED', 'CANCELLED')
GROUP  BY status;
\`\`\`

Run the equivalent OTBI reports in Fusion to confirm counts match within accepted tolerance (typically < 0.5% variance for active production items).

---

## Phase 7 — Monitoring Scripts

### migration_reconcile.sh

This script runs nightly during the parallel-run period to detect drift between Agile and Fusion item counts.

\`\`\`bash
#!/usr/bin/env bash
# migration_reconcile.sh — Compare Agile and Fusion item counts post-migration
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="\${SCRIPT_DIR}/logs"
mkdir -p "\${LOG_DIR}"

TIMESTAMP=$(date '+%Y%m%d_%H%M%S')
LOG_FILE="\${LOG_DIR}/reconcile_\${TIMESTAMP}.log"
ALERT_EMAIL="\${ALERT_EMAIL:-plm-dba@company.example}"
TOLERANCE_PCT=1   # alert if variance exceeds 1%

AGILE_CONN="\${AGILE_DB_USER}/\${AGILE_DB_PASS}@\${AGILE_DB_HOST}:\${AGILE_DB_PORT}/\${AGILE_DB_SERVICE}"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" | tee -a "\${LOG_FILE}"; }

log "Starting Agile vs Fusion reconciliation check"

# Count active parts in Agile
AGILE_COUNT=$(sqlplus -s "\${AGILE_CONN}" <<'ENDSQL' | tr -d ' \n'
SET HEADING OFF FEEDBACK OFF PAGESIZE 0
SELECT COUNT(*) FROM agile_parts
WHERE delete_flag = 'N' AND lifecycle_phase = 'PRODUCTION';
ENDSQL
)

log "Agile active production parts: \${AGILE_COUNT}"

# Count active items in Fusion via REST API
FUSION_COUNT=$(curl -s -u "\${FUSION_ADMIN_USER}:\${FUSION_ADMIN_PASS}" \
  "https://\${FUSION_HOST}/fscmRestApi/resources/11.13.18.05/items?q=LifecyclePhaseCode%3DActive&onlyData=true&limit=1" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('totalResults', 0))" 2>/dev/null || echo "0")

log "Fusion active items: \${FUSION_COUNT}"

# Calculate variance
if [[ "\${AGILE_COUNT}" -gt 0 && "\${FUSION_COUNT}" -gt 0 ]]; then
  VARIANCE=$(python3 -c "
agile=\${AGILE_COUNT}; fusion=\${FUSION_COUNT}
diff=abs(agile-fusion); pct=diff/agile*100
print(f'{pct:.2f}')
")
  log "Variance: \${VARIANCE}%"

  OVER_THRESHOLD=$(python3 -c "print('YES' if float('\${VARIANCE}') > \${TOLERANCE_PCT} else 'NO')")
  if [[ "\${OVER_THRESHOLD}" == "YES" ]]; then
    {
      echo "Subject: [WARNING] Agile/Fusion Item Count Variance: \${VARIANCE}%"
      echo ""
      echo "Agile active production parts : \${AGILE_COUNT}"
      echo "Fusion active items           : \${FUSION_COUNT}"
      echo "Variance                      : \${VARIANCE}% (threshold: \${TOLERANCE_PCT}%)"
      echo ""
      echo "Investigate items in Agile that may not have migrated to Fusion."
      echo "Log: \${LOG_FILE}"
    } | sendmail "\${ALERT_EMAIL}"
    log "ALERT sent: variance \${VARIANCE}% exceeds threshold"
  else
    log "OK: variance \${VARIANCE}% within tolerance"
  fi
fi

log "Reconciliation complete"
\`\`\`

### Crontab Schedule (Migration Period)

\`\`\`bash
# Install during the parallel-run period (typically 2–4 weeks post-cutover)
# crontab -e as the migration service account

SHELL=/bin/bash
MAILTO=plm-dba@company.example

# Nightly reconciliation: Agile vs Fusion item counts (02:00)
0 2 * * * ALERT_EMAIL=plm-dba@company.example \
  /opt/plm-migration/scripts/migration_reconcile.sh \
  >> /opt/plm-migration/logs/cron_reconcile.log 2>&1

# Weekly open ECO check in Agile (Monday 08:00)
# Alert if ECOs remain open in Agile beyond the cutover freeze date
0 8 * * 1 AGILE_DB_USER=agile_ro \
  /opt/plm-migration/scripts/agile_open_eco_check.sh \
  >> /opt/plm-migration/logs/cron_eco.log 2>&1

# Log cleanup (Sunday 04:00, keep 60 days)
0 4 * * 0 find /opt/plm-migration/logs -name "*.log" -mtime +60 -delete
\`\`\`

---

## Phase 8 — Rollback Procedure

Full rollback means reverting to Agile PLM as system of record and abandoning the Fusion items loaded. This is only feasible if the Agile-EBS integration has not yet been decommissioned.

### Rollback Checklist

\`\`\`bash
# 1. Confirm Agile application is still running and EBS adapter is intact
sqlplus "\${AGILE_CONN}" <<'ENDSQL'
SELECT COUNT(*) AS agile_part_count FROM agile_parts WHERE delete_flag = 'N';
ENDSQL

# 2. Re-enable Agile → EBS item sync (reverse the freeze in Phase 5.1)
# Command depends on your integration tool (ODI scenario, EBS adapter, etc.)

# 3. Notify engineering and supply chain teams to stop using Fusion PLM
# and return to Agile — this must be a coordinated communication

# 4. In Fusion: deactivate OIC integration flows to prevent further sync
# OIC console: Integrations → deactivate Product Hub to Inventory integration

# 5. In Fusion: delete migrated items if the environment will be reused
#    (use Fusion Scheduled Process: Delete Items in Batch with the batch ID used during import)
\`\`\`

---

## Quick Reference — FBDI Error Codes

| Error message | Cause | Fix |
|--------------|-------|-----|
| \`Item XXXXXX does not exist in organization M1\` | BOM import ran before item import completed | Re-run item import; wait for completion before BOM |
| \`Invalid unit of measure code\` | UOM code not in Fusion UOM lookup | Add missing UOM to UOM_MAP in transform script; re-seed in Fusion if needed |
| \`Item number exceeds maximum length\` | Agile part number > 40 characters (Fusion limit) | Truncate or reformat part numbers in transformation |
| \`Status code is invalid\` | Fusion item status code not in allowed values list | Check Fusion item status lookup; update LIFECYCLE_MAP |
| \`Manufacturer XXXX not found\` | AML import references a manufacturer not yet in Fusion | Seed manufacturer as Trading Partner before AML import |
| \`Duplicate item number\` | Part number already exists in Fusion from a previous migration run | Use \`onConflictDoUpdate\` logic or delete existing record before re-import |
| \`Structure component is the same as assembly\` | BOM self-reference (parent = child) — data quality issue in Agile | Identify and remove self-referencing BOM rows before extraction |`,
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
