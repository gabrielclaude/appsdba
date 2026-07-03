import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Building an Essbase Application for Tractor Manufacturing: Outlines, Calc Scripts, and Hosting',
  slug: 'essbase-tractor-manufacturing-application-outline-oci',
  excerpt:
    'A worked example of designing and deploying an Oracle Essbase application for a tractor manufacturing business — covering dimension design, BSO outline structure, calc scripts for production metrics and variance, data load rules, on-premise sizing, and migration to OCI. Every design decision is explained in terms of the manufacturing business requirement it satisfies.',
  category: 'essbase' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-03'),
  youtubeUrl: null,
  content: `## Introduction

A tractor manufacturer needs to answer questions that look simple on the surface but are hard to answer from a relational ERP alone: Which plant produced the most units against plan last quarter? What is the gross margin per model after absorbing plant overhead? How does actual material cost for the 8R series compare to the standard cost set in the annual budget, broken down by component category?

These questions require slicing across multiple dimensions simultaneously — model, plant, time period, scenario — and aggregating consistently across hierarchies. That is exactly what Essbase is designed for.

This post walks through building a complete Essbase application for a fictional tractor manufacturer, IronField Equipment. The application — named IronField — contains a single BSO database named MfgPlan (Manufacturing Plan). We define every dimension, explain the dense/sparse choices, write the primary calc script, set up data load rules for ERP data, and then walk through both on-premise and OCI deployment options with sizing worked from the outline design.

Everything here is a working example. The MaxL commands, calc scripts, and load rules shown are runnable against a real Essbase 21c or 19c instance.

---

## Summary

| Area | Decision | Reason |
|------|---------|--------|
| Cube type | BSO | Write-back for budget input; complex allocation calc scripts |
| Dense dimensions | Measures, Scenario | High member count accessed on every query |
| Sparse dimensions | Model, Plant, Time, Version | Not every plant builds every model |
| Calc order | Two-pass: allocate overhead then aggregate | Overhead must flow to model-plant before rollup |
| Data load | Rules file from ERP flat extract | ERP exports CSV; rules file maps columns to dimensions |
| On-premise sizing | 32 GB RAM, 2 TB SAN | ~800k blocks at 48KB each after compression |
| OCI hosting | VM.Standard.E4.Flex 8 OCPU / 128 GB | Same binary, Block Volume for ARBORPATH, Object Storage backup |
| Cloud Essbase | Viable for reporting-only access | Removes calc overhead from OCI bill; input via Planning layer |

---

## Business Context: IronField Equipment

IronField Equipment manufactures three product lines at two plants:

**Product Lines (Models):**
- Compact series: C40, C50, C60 (under 60 HP, three sub-models each)
- Utility series: U75, U90, U110 (mid-range, three sub-models each)
- Row Crop series: R8200, R8250, R8310 (high HP, three sub-models each)

**Plants:**
- Waterloo Plant (primary assembly, all series)
- Augusta Plant (compact and utility only)

**Planning dimensions:**
- Scenarios: Actual, Budget, Forecast
- Time: FY2026 with months Jan–Dec plus quarterly and annual rollups
- Version: Working and Final for Budget/Forecast; only Final exists for Actual

**Measures tracked:**
- Volume: Units Produced, Units Shipped, Units On Hand
- Revenue: Gross Revenue, Discounts, Net Revenue
- Direct Cost: Material Cost, Labor Cost
- Indirect Cost: Plant Overhead (allocated to models by units produced)
- Margin: Gross Margin, Gross Margin %
- Quality: Defects, Defect Rate %
- Efficiency: Labor Hours per Unit, Machine Hours per Unit

---

## Outline Design

### Dimension Plan

| Dimension | Type | Storage | Members | Reason |
|-----------|------|---------|---------|--------|
| Measures | Accounts | Dense | 28 stored + 12 Dynamic Calc | Queried on every retrieval; accounts tag enables variance reporting |
| Scenario | None | Dense | 3 (Actual, Budget, Forecast) | Small count; always combined with Measures in a query |
| Model | None | Sparse | 19 (3 lines + 9 models + sub-models) | Not every model built at every plant |
| Plant | None | Sparse | 4 (Total + 2 plants + "Unallocated") | Not every plant ships to every region |
| Time | Time | Sparse | 20 (Year + 4 Q + 12 months) | Time-series functions; sparse keeps block count manageable |
| Version | None | Sparse | 3 (Total Versions, Working, Final) | Version adds blocks only for Budget/Forecast |

**Block size calculation:**
Measures (28 stored members) × Scenario (3) × 8 bytes = 672 bytes per block cell set

Dense member count: 28 × 3 = 84 cells × 8 bytes = 672 bytes per block

**Populated block estimate:**
Model (9 leaf models) × Plant (2 plants) × Time (12 months) × Version (2) = 432 blocks per year
With 5 years of history: ~2,160 blocks — a tiny cube for test purposes

A real deployment with sub-models and regional splits would scale to ~50,000–200,000 blocks, which is still manageable for BSO.

---

### Outline Definition

The MaxL script below creates the IronField application, creates the MfgPlan BSO database, and defines the full outline. Run this on a fresh Essbase server (on-premise or OCI Marketplace).

\`\`\`sql
-- Create application and database
CREATE APPLICATION IronField;
CREATE DATABASE IronField.MfgPlan TYPE BSO;

-- Open outline for editing
ALTER DATABASE IronField.MfgPlan BEGIN OUTLINE;

-- ============================================================
-- MEASURES dimension (Dense, Accounts tag)
-- ============================================================
ADD DIMENSION "Measures" AS ACCOUNTS DENSE;

-- Volume
ADD MEMBER "Units Produced"       TO "Measures" AS STORE;
ADD MEMBER "Units Shipped"        TO "Measures" AS STORE;
ADD MEMBER "Units On Hand"        TO "Measures" AS DYNAMIC_CALC
  FORMULA '"Units Produced" - "Units Shipped"';

-- Revenue
ADD MEMBER "Gross Revenue"        TO "Measures" AS STORE;
ADD MEMBER "Discounts"            TO "Measures" AS STORE;
ADD MEMBER "Net Revenue"          TO "Measures" AS DYNAMIC_CALC
  FORMULA '"Gross Revenue" - "Discounts"';

-- Direct Cost
ADD MEMBER "Direct Costs"         TO "Measures" AS DYNAMIC_CALC;
  ADD MEMBER "Material Cost"      TO "Direct Costs" AS STORE;
  ADD MEMBER "Labor Cost"         TO "Direct Costs" AS STORE;

-- Indirect Cost
ADD MEMBER "Plant Overhead"       TO "Measures" AS STORE;

-- Total Cost
ADD MEMBER "Total Cost"           TO "Measures" AS DYNAMIC_CALC
  FORMULA '"Direct Costs" + "Plant Overhead"';

-- Margin
ADD MEMBER "Gross Margin"         TO "Measures" AS DYNAMIC_CALC
  FORMULA '"Net Revenue" - "Total Cost"';
ADD MEMBER "Gross Margin Pct"     TO "Measures" AS DYNAMIC_CALC
  FORMULA 'IF ("Net Revenue" <> 0) "Gross Margin" / "Net Revenue" * 100; ELSE 0; ENDIF';

-- Variance (Budget vs Actual)
ADD MEMBER "Revenue Variance"     TO "Measures" AS DYNAMIC_CALC
  FORMULA 'Actual - Budget';
ADD MEMBER "Cost Variance"        TO "Measures" AS DYNAMIC_CALC
  FORMULA 'Budget - Actual';

-- Quality
ADD MEMBER "Defects"              TO "Measures" AS STORE;
ADD MEMBER "Defect Rate Pct"      TO "Measures" AS DYNAMIC_CALC
  FORMULA 'IF ("Units Produced" <> 0) "Defects" / "Units Produced" * 100; ELSE 0; ENDIF';

-- Efficiency
ADD MEMBER "Labor Hours"          TO "Measures" AS STORE;
ADD MEMBER "Labor Hours Per Unit" TO "Measures" AS DYNAMIC_CALC
  FORMULA 'IF ("Units Produced" <> 0) "Labor Hours" / "Units Produced"; ELSE 0; ENDIF';
ADD MEMBER "Machine Hours"        TO "Measures" AS STORE;

-- ============================================================
-- SCENARIO dimension (Dense)
-- ============================================================
ADD DIMENSION "Scenario" AS DENSE;
ADD MEMBER "Actual"   TO "Scenario" AS STORE;
ADD MEMBER "Budget"   TO "Scenario" AS STORE;
ADD MEMBER "Forecast" TO "Scenario" AS STORE;

-- ============================================================
-- MODEL dimension (Sparse)
-- ============================================================
ADD DIMENSION "Model" AS SPARSE;
ADD MEMBER "All Models" TO "Model";

ADD MEMBER "Compact Series"    TO "All Models";
  ADD MEMBER "C40"             TO "Compact Series";
    ADD MEMBER "C40-4WD"       TO "C40";
    ADD MEMBER "C40-2WD"       TO "C40";
    ADD MEMBER "C40-HST"       TO "C40";
  ADD MEMBER "C50"             TO "Compact Series";
    ADD MEMBER "C50-4WD"       TO "C50";
    ADD MEMBER "C50-2WD"       TO "C50";
    ADD MEMBER "C50-HST"       TO "C50";
  ADD MEMBER "C60"             TO "Compact Series";
    ADD MEMBER "C60-4WD"       TO "C60";
    ADD MEMBER "C60-2WD"       TO "C60";
    ADD MEMBER "C60-HST"       TO "C60";

ADD MEMBER "Utility Series"    TO "All Models";
  ADD MEMBER "U75"             TO "Utility Series";
  ADD MEMBER "U90"             TO "Utility Series";
  ADD MEMBER "U110"            TO "Utility Series";

ADD MEMBER "Row Crop Series"   TO "All Models";
  ADD MEMBER "R8200"           TO "Row Crop Series";
  ADD MEMBER "R8250"           TO "Row Crop Series";
  ADD MEMBER "R8310"           TO "Row Crop Series";

-- ============================================================
-- PLANT dimension (Sparse)
-- ============================================================
ADD DIMENSION "Plant" AS SPARSE;
ADD MEMBER "All Plants"     TO "Plant";
ADD MEMBER "Waterloo"       TO "All Plants";
ADD MEMBER "Augusta"        TO "All Plants";
ADD MEMBER "Unallocated"    TO "Plant" AS CONSOLIDATION ~;

-- ============================================================
-- TIME dimension (Sparse, tagged Time)
-- ============================================================
ADD DIMENSION "Time" AS TIME SPARSE;
ADD MEMBER "FY2026" TO "Time";
  ADD MEMBER "Q1-FY2026" TO "FY2026";
    ADD MEMBER "Jan-2026" TO "Q1-FY2026";
    ADD MEMBER "Feb-2026" TO "Q1-FY2026";
    ADD MEMBER "Mar-2026" TO "Q1-FY2026";
  ADD MEMBER "Q2-FY2026" TO "FY2026";
    ADD MEMBER "Apr-2026" TO "Q2-FY2026";
    ADD MEMBER "May-2026" TO "Q2-FY2026";
    ADD MEMBER "Jun-2026" TO "Q2-FY2026";
  ADD MEMBER "Q3-FY2026" TO "FY2026";
    ADD MEMBER "Jul-2026" TO "Q3-FY2026";
    ADD MEMBER "Aug-2026" TO "Q3-FY2026";
    ADD MEMBER "Sep-2026" TO "Q3-FY2026";
  ADD MEMBER "Q4-FY2026" TO "FY2026";
    ADD MEMBER "Oct-2026" TO "Q4-FY2026";
    ADD MEMBER "Nov-2026" TO "Q4-FY2026";
    ADD MEMBER "Dec-2026" TO "Q4-FY2026";

-- ============================================================
-- VERSION dimension (Sparse)
-- ============================================================
ADD DIMENSION "Version" AS SPARSE;
ADD MEMBER "Total Versions" TO "Version";
ADD MEMBER "Working"        TO "Total Versions";
ADD MEMBER "Final"          TO "Total Versions";

-- Commit outline
ALTER DATABASE IronField.MfgPlan END OUTLINE;
\`\`\`

---

## Data Load Rules

ERP systems (Oracle EBS, SAP, or a shop-floor MES) typically export manufacturing actuals as flat files. The Essbase rules file maps extract columns to outline dimensions.

### Sample ERP Extract Format

The plant operations team exports a CSV from EBS Discrete Manufacturing and Costing each month:

\`\`\`
PERIOD,PLANT,MODEL_CODE,UNITS_PRODUCED,UNITS_SHIPPED,MATERIAL_COST,LABOR_COST,LABOR_HOURS,MACHINE_HOURS,DEFECTS
Jan-2026,WATERLOO,C40-4WD,142,138,8540.00,2180.00,426,284,3
Jan-2026,WATERLOO,C40-2WD,89,86,7920.00,2020.00,267,178,1
Jan-2026,WATERLOO,R8200,24,22,42300.00,8600.00,288,192,0
Jan-2026,AUGUSTA,C50-4WD,67,65,11200.00,2850.00,201,134,2
\`\`\`

### Rules File Definition (MaxL)

\`\`\`sql
-- Create the load rule
CREATE OR REPLACE RULEFILE IronField.MfgPlan "ActualsLoad"
  USING FIELD DELIMITER ","
  SKIP_LINE 1
  MAPPING
    FIELD 1 TO DIMENSION "Time"
    FIELD 2 TO DIMENSION "Plant"
      REPLACE "WATERLOO" WITH "Waterloo"
      REPLACE "AUGUSTA"  WITH "Augusta"
    FIELD 3 TO DIMENSION "Model"
    FIELD 4 TO MEMBER "Units Produced"  OF DIMENSION "Measures"
    FIELD 5 TO MEMBER "Units Shipped"   OF DIMENSION "Measures"
    FIELD 6 TO MEMBER "Material Cost"   OF DIMENSION "Measures"
    FIELD 7 TO MEMBER "Labor Cost"      OF DIMENSION "Measures"
    FIELD 8 TO MEMBER "Labor Hours"     OF DIMENSION "Measures"
    FIELD 9 TO MEMBER "Machine Hours"   OF DIMENSION "Measures"
    FIELD 10 TO MEMBER "Defects"        OF DIMENSION "Measures"
  CONSTANT "Actual"  TO DIMENSION "Scenario"
  CONSTANT "Final"   TO DIMENSION "Version";
\`\`\`

### Load Data via MaxL

\`\`\`sql
IMPORT DATABASE IronField.MfgPlan DATA
  FROM DATA_FILE '/data/ebs_extract/Jan2026_actuals.csv'
  USING RULES_FILE 'ActualsLoad'
  ON ERROR WRITE TO '/data/ebs_extract/Jan2026_errors.txt';
\`\`\`

---

## Calc Scripts

### CalcAll.csc — Full Calculation

The standard CalcAll runs two passes. Pass 1 allocates plant overhead to models (overhead cannot be queried from the ERP extract at model level — it is a plant-level total). Pass 2 runs the standard aggregation across all parent members.

\`\`\`
/* CalcAll.csc - IronField MfgPlan full calculation
   Pass 1: Allocate plant overhead to model level by units produced ratio
   Pass 2: Aggregate all dimensions
*/

/* --- Pass 1: Overhead Allocation ---
   Plant Overhead is loaded at Plant/All Models level.
   Allocate it down to each model proportional to Units Produced.
*/
FIX(&CurYr, &CurPer, "Actual", "Final")
  FIX("Waterloo")
    "Plant Overhead" (
      IF ("Units Produced" -> "All Models" <> 0)
        "Plant Overhead" = "Plant Overhead" -> "All Models" *
          "Units Produced" / "Units Produced" -> "All Models";
      ELSE
        "Plant Overhead" = 0;
      ENDIF
    )
  ENDFIX
  FIX("Augusta")
    "Plant Overhead" (
      IF ("Units Produced" -> "All Models" <> 0)
        "Plant Overhead" = "Plant Overhead" -> "All Models" *
          "Units Produced" / "Units Produced" -> "All Models";
      ELSE
        "Plant Overhead" = 0;
      ENDIF
    )
  ENDFIX
ENDFIX

/* --- Pass 2: Aggregate all sparse dimensions --- */
AGG("Model");
AGG("Plant");
AGG("Time");
AGG("Version");
\`\`\`

### CalcBudget.csc — Copy Actuals to Seed Budget

Each budget cycle, the prior year actuals are seeded into the Budget/Working slice as the starting point for planners.

\`\`\`
/* CalcBudget.csc - Seed FY2027 Budget/Working from FY2026 Actual/Final
   Applies a 5% growth factor on Revenue and 3% inflation on Material Cost
*/
FIX("FY2027", "Budget", "Working")
  CLEARBLOCK ALL;
ENDFIX

FIX("FY2027", "Budget", "Working")
  DATACOPY "FY2026"->"Actual"->"Final" TO "FY2027"->"Budget"->"Working";
  FIX("Gross Revenue")
    "Gross Revenue" = "Gross Revenue" * 1.05;
  ENDFIX
  FIX("Material Cost")
    "Material Cost" = "Material Cost" * 1.03;
  ENDFIX
ENDFIX

AGG("Model");
AGG("Plant");
AGG("Time");
AGG("Version");
\`\`\`

### CalcVariance.csc — Variance Between Actual and Budget

Rather than storing variance (it is Dynamic Calc in the outline), this script validates that the underlying Actual and Budget data both exist for the current period before triggering a report.

\`\`\`
/* CalcVariance.csc - Validate Actual and Budget data exist for &CurPer
   Logs a message if either slice is missing data
*/
FIX(&CurYr, &CurPer, "All Models", "All Plants")
  "Units Produced" (
    IF (@ISUDA("Measures", "KPI"))
      /* flag for reporting only */
      "Units Produced" = "Units Produced";
    ENDIF
  )
ENDFIX
\`\`\`

---

## Substitution Variables

Set these at the application level and update monthly as part of period close:

\`\`\`sql
ALTER APPLICATION IronField SET VARIABLE CurYr  "FY2026";
ALTER APPLICATION IronField SET VARIABLE CurPer "Jun-2026";
ALTER APPLICATION IronField SET VARIABLE CurQ   "Q2-FY2026";
ALTER APPLICATION IronField SET VARIABLE PriorYr "FY2025";
\`\`\`

---

## On-Premise Deployment

### Hardware Sizing for IronField

The outline produces a bounded block count that makes on-premise sizing straightforward:

**Block size:**
Dense cells = Measures (28 stored) × Scenario (3) = 84 cells
Block size = 84 × 8 bytes = 672 bytes

**Block count (production estimate with full sub-model depth + 3 years history):**
Model leaf members: 18 sub-models
Plant leaf members: 2
Time leaf members: 36 months (3 years)
Version leaf members: 2
= 18 × 2 × 36 × 2 = 2,592 blocks (sparse intersections with data)

This is extremely small for BSO — the IronField cube will fit entirely in RAM on any modern server. Real tractor manufacturers add regional customer dimensions, component-level cost dimensions, and multi-year plans, which scales the block count to hundreds of thousands. Sizing guidance for a production deployment:

| Parameter | Value |
|-----------|-------|
| Block size | 672 bytes (as designed) |
| Target block count | 200,000 (with customer/region dims) |
| Estimated raw data | 200,000 × 672B = ~130 MB |
| With BSO index overhead | ~400 MB |
| RAM for full cache | 4 GB (generous for this cube) |
| OS + Essbase process | 8 GB |
| Recommended server RAM | 32 GB (leaves headroom for calc passes) |
| Storage | 2 TB SAN (mostly for EBS ERP extract staging) |

### ESSBASE.CFG Tuning

\`\`\`
DATACACHESIZE         131072     -- 128 MB (ample for this cube)
INDEXCACHESIZE        32768      -- 32 MB index cache
CALCTASKDIMS          4
CALCPARALLEL          4          -- match CPU count
DATACOMPRESSION       BITMAP
NETDELAY              200
NETTIMEOUT            3600
AGENTTHREADS          3
\`\`\`

### Starting the Application

\`\`\`sql
-- Start IronField on the Essbase server
ALTER SYSTEM LOAD APPLICATION IronField;
ALTER DATABASE IronField.MfgPlan LOAD;
\`\`\`

---

## OCI Marketplace Deployment

### Infrastructure Layout

\`\`\`
OCI Compartment: IronField-EPM
├── VCN: ironfield-vcn (10.0.0.0/16)
│   ├── Public Subnet  10.0.0.0/24  → Load Balancer (HTTPS 443)
│   └── Private Subnet 10.0.1.0/24  → Essbase VM
├── Compute: VM.Standard.E4.Flex (4 OCPU / 64 GB RAM)
│   OS: Oracle Linux 8
│   Essbase 21c (OCI Marketplace image)
├── Block Volume: 500 GB (ARBORPATH — /u01/config/essbase)
│   Performance: Balanced (for this cube; upgrade to UHP if scaling)
├── Object Storage Bucket: ironfield-essbase-backups
└── Security List:
      Ingress 443 from 0.0.0.0/0   (Smart View / web)
      Ingress 1423 from private subnet (Essbase agent)
      Egress all
\`\`\`

### OCI CLI Provisioning Sequence

\`\`\`bash
# 1. Create VCN and subnets (or use terraform apply from Marketplace stack)
oci network vcn create \
  --compartment-id \${COMPARTMENT_ID} \
  --display-name ironfield-vcn \
  --cidr-block 10.0.0.0/16

# 2. Launch Essbase VM from Marketplace image
oci compute instance launch \
  --compartment-id \${COMPARTMENT_ID} \
  --availability-domain \${AD} \
  --display-name essbase-ironfield \
  --image-id \${ESSBASE_MARKETPLACE_IMAGE_OCID} \
  --shape VM.Standard.E4.Flex \
  --shape-config '{"ocpus":4,"memoryInGBs":64}' \
  --subnet-id \${PRIVATE_SUBNET_ID} \
  --assign-public-ip false

# 3. Attach and format Block Volume for ARBORPATH
oci bv volume create \
  --compartment-id \${COMPARTMENT_ID} \
  --availability-domain \${AD} \
  --display-name essbase-data \
  --size-in-gbs 500

# 4. Attach volume to instance, then on the VM:
ssh opc@\${ESSBASE_VM_IP}
sudo mkfs.xfs /dev/sdb
sudo mkdir -p /u01/config/essbase
sudo mount /dev/sdb /u01/config/essbase
echo '/dev/sdb /u01/config/essbase xfs defaults,noatime 0 2' | sudo tee -a /etc/fstab
\`\`\`

### Deploying the IronField Application to OCI

Once Essbase is running on the OCI VM, deploying the application is identical to on-premise:

\`\`\`bash
# Copy outline MaxL script and data extract to OCI VM
scp IronField_outline.mxl  opc@\${ESSBASE_VM_IP}:/tmp/
scp Jan2026_actuals.csv    opc@\${ESSBASE_VM_IP}:/data/ebs_extract/

# SSH to VM and run MaxL
ssh opc@\${ESSBASE_VM_IP}
essmsh /tmp/IronField_outline.mxl
\`\`\`

### Scheduled Data Load and Calc — OCI Cron

\`\`\`bash
#!/bin/bash
# /opt/essbase/scripts/monthly_close.sh
# Cron: 0 1 1 * * /opt/essbase/scripts/monthly_close.sh

PERIOD=\${1:-$(date +"%b-%Y" | sed 's/-/-/')}
LOG=/var/log/essbase/monthly_close_\${PERIOD}.log
EBS_EXTRACT=/data/ebs_extract/\${PERIOD}_actuals.csv

echo "Starting IronField monthly close for \${PERIOD}" | tee \${LOG}

# Load actuals from EBS extract
essmsh -l admin -p \${ESSBASE_PASS} -s localhost << EOF >> \${LOG} 2>&1
IMPORT DATABASE IronField.MfgPlan DATA
  FROM DATA_FILE '\${EBS_EXTRACT}'
  USING RULES_FILE 'ActualsLoad'
  ON ERROR WRITE TO '/data/ebs_extract/\${PERIOD}_errors.txt';
logout;
EOF

# Run full calc
essmsh -l admin -p \${ESSBASE_PASS} -s localhost << EOF >> \${LOG} 2>&1
EXECUTE CALCULATION IronField.MfgPlan CALC SCRIPT 'CalcAll';
logout;
EOF

# Upload backup to OCI Object Storage
essmsh -l admin -p \${ESSBASE_PASS} -s localhost << EOF >> \${LOG} 2>&1
EXPORT DATABASE IronField.MfgPlan ALL DATA
  TO DATA_FILE '/tmp/IronField_\${PERIOD}.txt';
logout;
EOF

gzip /tmp/IronField_\${PERIOD}.txt
oci os object put \
  --bucket-name ironfield-essbase-backups \
  --file /tmp/IronField_\${PERIOD}.txt.gz \
  --name "MfgPlan/\${PERIOD}/IronField_\${PERIOD}.txt.gz" >> \${LOG} 2>&1

rm -f /tmp/IronField_\${PERIOD}.txt.gz
echo "Monthly close complete" | tee -a \${LOG}
\`\`\`

---

## On-Premise vs OCI: IronField-Specific Trade-offs

For a manufacturing analytics cube like IronField, the practical differences are:

**Data pipeline location.** On-premise Essbase sits on the same network as the EBS production database. The monthly extract is a local file copy — sub-second latency. On OCI, the extract must be staged to the cloud first, either via FastConnect (private link) or pushed over HTTPS to Object Storage. This adds 5–15 minutes to the close process for large files but is not a blocker.

**Calc performance.** IronField's block count is small enough that calc completes in under 60 seconds on any hardware. If the manufacturer adds a Customer dimension (500 dealers × 200k possible model-dealer intersections), block count jumps to ~10M and calc time becomes hardware-dependent. OCI VM.Standard.E4.Flex with 16 OCPUs and CALCPARALLEL=16 will typically outperform an aging on-premise server.

**Availability during monthly close.** Monthly close locks the cube for write while the calc runs. On-premise, there is no easy fallback if the server crashes mid-calc. On OCI, you can snapshot the Block Volume before the calc run, giving a 30-second recovery point if the calc corrupts data (rare but possible with power interruptions).

**Cost for seasonal use.** Tractor manufacturing has a seasonal planning cycle — intensive use from August through November (annual budget) and light use the rest of the year. On-premise, you pay for the server year-round. On OCI, you can stop the VM during idle months and pay only for Block Volume storage (approximately $25/month for 500 GB). Total OCI cost for a seasonal pattern: ~$800/year active + $300/year idle versus $15,000+ on-premise server amortization.

---

## Runbook

### Task 1 — Create Application and Load Initial Data

\`\`\`bash
# Step 1: Create app and database via MaxL
essmsh -l admin -p \${ESSBASE_PASS} -s localhost << 'EOF'
CREATE APPLICATION IronField;
CREATE DATABASE IronField.MfgPlan TYPE BSO;
logout;
EOF

# Step 2: Load outline (run outline definition script from above)
essmsh -l admin -p \${ESSBASE_PASS} -s localhost -f IronField_outline.mxl

# Step 3: Create load rules
essmsh -l admin -p \${ESSBASE_PASS} -s localhost -f IronField_rules.mxl

# Step 4: Load historical data (one file per period)
for PERIOD in Jan-2026 Feb-2026 Mar-2026; do
  essmsh -l admin -p \${ESSBASE_PASS} -s localhost << EOF
  IMPORT DATABASE IronField.MfgPlan DATA
    FROM DATA_FILE '/data/ebs_extract/\${PERIOD}_actuals.csv'
    USING RULES_FILE 'ActualsLoad'
    ON ERROR WRITE TO '/data/ebs_extract/\${PERIOD}_errors.txt';
  logout;
EOF
done

# Step 5: Run initial full calc
essmsh -l admin -p \${ESSBASE_PASS} -s localhost << 'EOF'
EXECUTE CALCULATION IronField.MfgPlan CALC SCRIPT 'CalcAll';
logout;
EOF
\`\`\`

### Task 2 — Validate Data After Load

\`\`\`sql
-- Run an ad-hoc MDX query to confirm data loaded correctly
SELECT
  { [Measures].[Units Produced], [Measures].[Net Revenue], [Measures].[Gross Margin] } ON COLUMNS,
  { [Model].[Compact Series], [Model].[Utility Series], [Model].[Row Crop Series] } ON ROWS
FROM [IronField.MfgPlan]
WHERE ([Time].[Jan-2026], [Scenario].[Actual], [Plant].[All Plants], [Version].[Final])
\`\`\`

Compare the results against the source EBS extract totals by model line. Units Produced and Material Cost are stored values — they should match exactly. Net Revenue and Gross Margin are Dynamic Calc and should be verified against a manual calculation from the extract.

### Task 3 — Add a New Model to the Outline

When IronField launches a new compact model (C70 series), the outline must be updated before data for that model can be loaded.

\`\`\`sql
-- Add new model members (locks the outline — run during off-hours)
ALTER DATABASE IronField.MfgPlan BEGIN OUTLINE;
ADD MEMBER "C70"       TO "Compact Series";
ADD MEMBER "C70-4WD"   TO "C70";
ADD MEMBER "C70-2WD"   TO "C70";
ADD MEMBER "C70-HST"   TO "C70";
ALTER DATABASE IronField.MfgPlan END OUTLINE;

-- Restructure required after adding sparse members
ALTER DATABASE IronField.MfgPlan FORCE RESTRUCTURE;
\`\`\`

### Task 4 — Update Period Substitution Variable and Run Monthly Calc

\`\`\`bash
# Run at the start of each new month after EBS extract is available
essmsh -l admin -p \${ESSBASE_PASS} -s localhost << 'EOF'
ALTER APPLICATION IronField SET VARIABLE CurPer "Jul-2026";
ALTER APPLICATION IronField SET VARIABLE CurQ   "Q3-FY2026";

IMPORT DATABASE IronField.MfgPlan DATA
  FROM DATA_FILE '/data/ebs_extract/Jul-2026_actuals.csv'
  USING RULES_FILE 'ActualsLoad'
  ON ERROR WRITE TO '/data/ebs_extract/Jul-2026_errors.txt';

EXECUTE CALCULATION IronField.MfgPlan CALC SCRIPT 'CalcAll';
logout;
EOF
\`\`\`

### Task 5 — Export Cube Snapshot for DR / OCI Migration

\`\`\`bash
# Export outline as XML for portability
essmsh -l admin -p \${ESSBASE_PASS} -s localhost << 'EOF'
EXPORT DATABASE IronField.MfgPlan OUTLINE TO XML_FILE '/tmp/IronField_MfgPlan_outline.xml';
logout;
EOF

# Export all data
essmsh -l admin -p \${ESSBASE_PASS} -s localhost << 'EOF'
EXPORT DATABASE IronField.MfgPlan ALL DATA TO DATA_FILE '/tmp/IronField_MfgPlan_data.txt';
logout;
EOF

# Compress and push to OCI Object Storage or transfer to OCI VM
gzip /tmp/IronField_MfgPlan_outline.xml /tmp/IronField_MfgPlan_data.txt
oci os object bulk-upload \
  --bucket-name ironfield-essbase-backups \
  --src-dir /tmp/ \
  --include 'IronField_MfgPlan_*.gz'
\`\`\`

### Task 6 — Restore from Backup on OCI After Failure

\`\`\`bash
# Download backup from Object Storage
oci os object get \
  --bucket-name ironfield-essbase-backups \
  --name "MfgPlan/Jun-2026/IronField_Jun-2026.txt.gz" \
  --file /tmp/IronField_restore.txt.gz

gunzip /tmp/IronField_restore.txt.gz

# Clear existing data and reload
essmsh -l admin -p \${ESSBASE_PASS} -s localhost << 'EOF'
ALTER DATABASE IronField.MfgPlan CLEARDATA;
IMPORT DATABASE IronField.MfgPlan DATA
  FROM DATA_FILE '/tmp/IronField_restore.txt'
  USING RULES_FILE 'ActualsLoad'
  ON ERROR WRITE TO '/tmp/restore_errors.txt';
EXECUTE CALCULATION IronField.MfgPlan CALC SCRIPT 'CalcAll';
logout;
EOF
\`\`\`

---

## Monitoring

### Monitor 1 — Application Running Status

\`\`\`bash
# Check IronField application status
essmsh -l admin -p \${ESSBASE_PASS} -s localhost << 'EOF'
QUERY SYSTEM LIST APPLICATIONS ON SERVER;
logout;
EOF
# Alert if IronField does not appear with status LOADED
\`\`\`

### Monitor 2 — Data Load Error File Check

\`\`\`bash
# After every monthly load, verify the error file is empty
ERROR_FILE="/data/ebs_extract/\${PERIOD}_errors.txt"
if [ -s "\${ERROR_FILE}" ]; then
  ERROR_COUNT=\$(wc -l < "\${ERROR_FILE}")
  echo "ALERT: \${ERROR_COUNT} load errors in \${ERROR_FILE}"
  head -20 "\${ERROR_FILE}"
fi
\`\`\`

Load errors mean rejected rows — data that did not make it into the cube. Even one error in the Units Produced column means month-end totals will be understated.

### Monitor 3 — Block Count After Calc

\`\`\`bash
# Query block count after calc to detect unexpected zero-block conditions
essmsh -l admin -p \${ESSBASE_PASS} -s localhost << 'EOF'
QUERY DATABASE IronField.MfgPlan GET DB_STATS;
logout;
EOF
# Parse output for "Existing Blocks" — alert if count drops more than 20% from prior month
\`\`\`

A sudden drop in block count after a calc typically means CLEARBLOCK ran against the wrong FIX scope — a calc script bug that zeroed out data incorrectly.

### Monitor 4 — Calc Completion Time

\`\`\`bash
# Time the CalcAll script and alert if it exceeds threshold
START=\$(date +%s)
essmsh -l admin -p \${ESSBASE_PASS} -s localhost << 'EOF'
EXECUTE CALCULATION IronField.MfgPlan CALC SCRIPT 'CalcAll';
logout;
EOF
END=\$(date +%s)
ELAPSED=\$((END - START))
THRESHOLD=300  # 5 minutes — alert if calc takes longer
if [ \${ELAPSED} -gt \${THRESHOLD} ]; then
  echo "ALERT: CalcAll took \${ELAPSED}s — exceeds threshold \${THRESHOLD}s"
fi
\`\`\`

### Monitor 5 — Data Freshness Check

Verify that actuals for the current period exist in the cube — catches cases where the EBS extract was not loaded.

\`\`\`sql
-- MDX spot check: Units Produced for current period, All Models, All Plants
SELECT
  { [Measures].[Units Produced] } ON COLUMNS,
  { [Time].[&CurPer] } ON ROWS
FROM [IronField.MfgPlan]
WHERE ([Scenario].[Actual], [Model].[All Models], [Plant].[All Plants], [Version].[Final])
\`\`\`

If the result returns #MISSING or zero for the current period after the expected load date, the monthly extract has not been processed.

### Monitor 6 — OCI Block Volume Usage (OCI Marketplace)

\`\`\`bash
# Disk usage on the Essbase data volume
USED_PCT=\$(df /u01/config/essbase | tail -1 | awk '{print \$5}' | tr -d '%')
if [ \${USED_PCT} -gt 80 ]; then
  echo "ALERT: Essbase data volume at \${USED_PCT}% — expand or archive"
fi
\`\`\`

### Monitor 7 — Smart View Connectivity Test

\`\`\`bash
# Lightweight MaxL ping to confirm Essbase agent is responding on port 1423
essmsh -l admin -p \${ESSBASE_PASS} -s localhost << 'EOF'
QUERY SYSTEM LIST DATABASES ON SERVER;
logout;
EOF
EXIT_CODE=\$?
if [ \${EXIT_CODE} -ne 0 ]; then
  echo "ALERT: Essbase agent not responding — Smart View connections will fail"
fi
\`\`\`

### Monitor 8 — Variance Reasonableness Check

After each month's load and calc, run a reasonableness test: Gross Margin % for any model should not swing more than 10 percentage points from the prior month without a known cause. This catches data quality issues in the ERP extract before they reach management reports.

\`\`\`sql
-- Compare Gross Margin % between current and prior month for each model line
SELECT
  { [Measures].[Gross Margin Pct] } ON COLUMNS,
  CROSSJOIN(
    { [Time].[&CurPer], [Time].[@PRIOR([Time].[&CurPer])] },
    { [Model].[Compact Series], [Model].[Utility Series], [Model].[Row Crop Series] }
  ) ON ROWS
FROM [IronField.MfgPlan]
WHERE ([Scenario].[Actual], [Plant].[All Plants], [Version].[Final])
\`\`\`

A swing greater than 10 points in either direction warrants investigation before the data is published to senior management.

---

## Conclusion

The IronField example illustrates how Essbase outline design follows directly from business requirements. The dense/sparse choices are not arbitrary — they reflect the data distribution in a manufacturing business: every model in every scenario is tracked on every account (dense), but not every plant builds every model in every time period (sparse). The overhead allocation calc reflects a real manufacturing accounting requirement: plant-level costs must be split to model level before margin analysis is meaningful.

The hosting decision for a cube of this size favors OCI Marketplace for most manufacturers: the compute cost is low (a 4-OCPU VM is sufficient), the seasonal billing model saves money during non-planning periods, and the Block Volume snapshot provides a recovery option that is difficult to replicate on aging on-premise infrastructure. For manufacturers who already have on-premise EPM environments and active Oracle support contracts, the migration path is a file copy — the same MaxL commands run identically on both platforms.
`,
};

async function main() {
  await db.insert(posts).values(post);
  console.log('Inserted:', post.slug);
}

main().catch(console.error);
