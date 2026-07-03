import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Essbase Outlines, Applications, and Hosting: On-Premise vs Oracle Cloud Infrastructure',
  slug: 'essbase-outlines-applications-onprem-oci',
  excerpt:
    'The Essbase outline is the blueprint for every cube — it defines dimensions, hierarchies, member formulas, and data storage classification. This post covers how outlines are built and maintained, how Essbase applications are structured and administered, and how on-premise deployments compare to OCI Marketplace and Oracle Cloud Essbase in terms of architecture, sizing, patching, and operational overhead.',
  category: 'essbase' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-03'),
  youtubeUrl: null,
  content: `## Introduction

Oracle Essbase organises data in cubes. Each cube is defined by an **outline** — a hierarchical metadata structure that describes every dimension, every member, and the rules governing how data rolls up, consolidates, and is calculated. If the cube is a building, the outline is the architectural drawing. Change the outline incorrectly and data integrity breaks. Change it correctly and you gain performance, flexibility, and reporting accuracy.

An **application** in Essbase is a container: one application holds one or more cubes (databases), each with its own outline, data files, calc scripts, substitution variables, and security filters. Understanding the relationship between applications and cubes, and how they map to physical resources, is the foundation for every Essbase administration, tuning, and migration task.

The hosting decision — on-premise versus Oracle Cloud Infrastructure (OCI) — changes the operational model significantly. On-premise Essbase gives you full control over hardware, storage layout, and network isolation, but you own patching, capacity planning, and infrastructure availability. OCI Marketplace Essbase moves the VM and storage to Oracle-managed infrastructure without changing the Essbase software model. Oracle Cloud Essbase (the managed PaaS offering) removes the OS layer entirely, but introduces constraints on customization and patching cadence.

This post covers all three: the outline in depth, the application structure, and a practical comparison of on-premise versus OCI hosting with the operational implications of each.

---

## Summary

| Topic | Key Points |
|-------|-----------|
| Outline structure | Dimensions → members → consolidation operators → formulas → storage type |
| BSO vs ASO | BSO for write-back and complex calcs; ASO for large read-only aggregations |
| Dense vs sparse | Dense dimensions stored per block; sparse stored as block addresses |
| Application layout | One application = one or more databases; each database = one outline + data files |
| On-premise | Full control; manual patching; direct filesystem access; all calc tuning available |
| OCI Marketplace | Same Essbase binary on Oracle-managed VM; Infrastructure-as-Code via Terraform |
| Oracle Cloud Essbase | Managed PaaS; browser-based administration; limited OS access; subscription billing |
| Migration path | On-premise outline exports (OTL/XML) load directly to cloud; LCM for full apps |

---

## Essbase Outline Structure

### What an Outline Is

Every Essbase database has exactly one outline, stored in a binary file named after the database (e.g., Sample.otl). The outline defines:

- All dimensions and their members, in hierarchy order
- Consolidation operators for each member (+ Add, - Subtract, ~ Ignore, ^ Share, | Never)
- Member aliases, UDAs (User Defined Attributes), and attribute associations
- Data storage classification for each member (Store, Dynamic Calc, Dynamic Calc and Store, Never Share, Label Only, Shared)
- Member formulas (MDX or Essbase calc syntax for derived values)
- Dimension type tags (Accounts, Time, Country, Attribute, None)
- BSO/ASO designation, which applies to the entire database

### Dimension Types and Their Special Behaviour

**Accounts dimension** — the tagged Accounts dimension enables Essbase to apply time-balance properties (First, Last, Average) and variance reporting (Expense flag for sign reversal). Only one dimension can carry the Accounts tag per outline.

**Time dimension** — the tagged Time dimension enables time-series functions (LAG, LEAD, @PRIOR) and controls how the Period-to-Date (@PTD) and Year-to-Date (@YTD) functions scan data.

**Attribute dimensions** — linked to a base dimension (e.g., a Product Color attribute linked to Product), attribute dimensions allow filtering and grouping without creating sparse dimension members. They do not add blocks to a BSO cube.

**Dense dimensions** — stored within every data block. The number of cells in a BSO block equals the product of the member counts of all dense dimensions. Year (13 members) × Scenario (3 members) × Measures (50 members) = 1,950 cells per block.

**Sparse dimensions** — define which blocks exist. A block is created only when data exists at a sparse intersection. Entity × Product defines the block address; if no data exists for Entity=West, Product=Widget, no block is stored.

### Consolidation Operators

Every member in a dimension carries a consolidation operator that controls how it rolls up to its parent:

| Operator | Meaning |
|----------|---------|
| + | Add to parent |
| - | Subtract from parent |
| * | Multiply into parent |
| / | Divide into parent |
| % | Percentage of parent |
| ~ | Ignore (do not roll up) |
| ^ | Shared member reference |
| | | Never share |

Setting a member to ~ is common for input-only members at the leaf level when the parent is calculated by formula rather than simple aggregation.

### Member Formulas

Formulas attached to members are evaluated during calculation. A Dynamic Calc member's formula runs at query time; a stored member's formula runs during a calc script execution.

Example: Gross Margin formula on a Dynamic Calc member:

\`\`\`
"Gross Margin" = Revenue - "Cost of Goods Sold";
\`\`\`

Cross-dimensional reference example:

\`\`\`
"Budget Variance" = Budget - Actual;
\`\`\`

Time-balance example using @PRIOR:

\`\`\`
"Sequential Growth" = (Sales - @PRIOR(Sales)) / @PRIOR(Sales) * 100;
\`\`\`

### BSO vs ASO Outlines

The choice between Block Storage Option (BSO) and Aggregate Storage Option (ASO) is made at the database level and determines how the outline is used at runtime.

| Factor | BSO | ASO |
|--------|-----|-----|
| Write-back | Yes — users can input data | Read-only (except slice load) |
| Calc scripts | Full PL/SQL-like scripting | Limited; uses MDX queries |
| Dense/sparse classification | Critical to performance | Not applicable |
| Aggregation method | Explicit calc or automatic | On-the-fly from atomic data |
| Dimension count | Typically 6–12 dimensions | Can handle 20+ dimensions |
| Data volume | Best under ~100M cells stored | Handles billions of cells |
| Typical use case | Planning, budgeting, write-back | Reporting, analysis, large dimensions |

Most EPM deployments run BSO cubes for Planning and ASO cubes for reporting aggregations.

### Outline Compression and Optimisation

For BSO cubes, outline design directly determines storage efficiency and calculation speed. Key rules:

- **Dense dimensions first** in the outline — Essbase processes the outline top-to-bottom when computing block layouts
- **Minimize dense dimension member count** — each dense member multiplies block size; Dynamic Calc members do not consume storage
- **Accounts and Time are typically dense** — they are accessed together on every query
- **Entity, Product, Customer are typically sparse** — not every combination has data
- **Use Dynamic Calc for derived members** — do not store Variance or Ratio members that can be computed on the fly

---

## Essbase Application Structure

### Application and Database Hierarchy

\`\`\`
Essbase Server
├── Application: FinPlan
│   ├── Database: Budget (BSO)
│   │   ├── Outline: Budget.otl
│   │   ├── Data files: *.pag, *.ind (BSO page and index files)
│   │   ├── Calc scripts: *.csc
│   │   ├── Report scripts: *.rep
│   │   └── Rules files: *.rul (for data load)
│   └── Database: Actuals (BSO)
│       └── Outline: Actuals.otl
├── Application: SalesASO
│   └── Database: Sales (ASO)
│       ├── Outline: Sales.otl
│       └── Data files: *.dat (ASO compressed store)
└── Application: Consolidation
    └── Database: HFM_Linked (BSO)
\`\`\`

Each application runs as a separate process on the Essbase server (ESSBASE.EXE on Windows or the Essbase agent process on Linux). Applications are started and stopped independently. A crashed application does not affect other running applications.

### Application Directories on Disk

On a standard on-premise install, application data lives under ARBORPATH/app:

\`\`\`
$ARBORPATH/app/
├── FinPlan/
│   ├── FinPlan.app          -- application metadata
│   ├── Budget/
│   │   ├── Budget.otl       -- outline binary
│   │   ├── Budget.db        -- database config
│   │   ├── Budget00001.pag  -- BSO page file (data blocks)
│   │   ├── Budget00001.ind  -- BSO index file (block addresses)
│   │   └── Budget.log       -- database log
│   └── Actuals/
│       └── ...
└── SalesASO/
    └── Sales/
        ├── Sales.otl
        └── *.dat            -- ASO compressed aggregate store
\`\`\`

The .pag and .ind files grow as data is loaded. The index maps sparse intersections to block locations in the page file. For large cubes, multiple .pag files are created as page file size limits are reached.

### Substitution Variables

Substitution variables are server-wide or application-level named values used in calc scripts, MDX queries, and report scripts to avoid hardcoding time periods or scenario names.

\`\`\`
CurYr  = FY2026
CurPer = Jun
PriorYr = FY2025
\`\`\`

Used in a calc script: FIX(&CurYr, &CurPer) ... ENDFIX

Substitution variables are updated each period as part of the period-close process.

### Security: Filters and Groups

Essbase security operates through filters attached to groups. A filter defines member-level access: read, write, metadata-read, or none. Users are assigned to groups; groups are assigned filters.

A common pattern:

- Group EMEA_READONLY — filter restricts Entity dimension to EMEA subtree, read access only
- Group PLANNING_USERS — filter on Scenario dimension restricts to Budget and Forecast, write access
- Group ADMIN — no filter (full access)

On-premise Essbase stores users and groups in Shared Services (LDAP-backed). Cloud Essbase uses OCI Identity and Access Management (IAM) or IDCS.

---

## On-Premise Essbase

### Architecture

A standard on-premise Essbase deployment runs on Oracle Linux or Windows Server:

\`\`\`
On-Premise Server
├── Oracle WebLogic Server (Admin Server)
├── Essbase Agent (port 1423)
├── Oracle HTTP Server / OHS (reverse proxy)
├── Essbase Studio (optional — dimension build orchestration)
├── Shared Services (EPM System Security)
└── Storage: local SAN/NAS volumes for ARBORPATH
\`\`\`

For high availability, a second node runs a passive Essbase instance pointing to shared storage (typically NFS or cluster filesystem), with failover managed by Oracle Clusterware or a load balancer.

### Sizing Guidelines for On-Premise

BSO cube sizing is driven by block count and block density:

- **Block size** = product of all dense member counts × 8 bytes (double precision)
- **Block count** ≈ number of populated sparse intersections
- **Total data size** = block count × block size × compression ratio (typically 0.3–0.6 after compression)

Example: Entity(500) × Product(2000) = 1M possible blocks. If 30% are populated: 300,000 blocks. Block size = Year(13) × Scenario(5) × Account(200) × 8 bytes = 104,000 bytes. Estimated data: 300,000 × 104KB × 0.4 = ~12 GB.

RAM should accommodate the hot block set — frequently accessed blocks cached in memory. A working set of 500,000 blocks at 104KB = ~50 GB RAM needed for full cache.

### Patching On-Premise

Essbase patches ship as Oracle Patch Set Updates (PSU) and standalone patches applied with OPatch. A typical patching cycle:

\`\`\`bash
# 1. Stop Essbase and WebLogic
$ORACLE_HOME/bin/stopComponent.sh ESSBASE1
$MW_HOME/bin/stopWebLogic.sh

# 2. Apply OPatch
$ORACLE_HOME/OPatch/opatch apply /patches/p<patch_number>/

# 3. Run config wizard if required
$MW_HOME/oracle_common/bin/reconfig.sh

# 4. Start services
$MW_HOME/bin/startWebLogic.sh
$ORACLE_HOME/bin/startComponent.sh ESSBASE1
\`\`\`

The critical constraint: applying an Essbase patch requires stopping all applications. Plan patching windows carefully — calc scripts, data loads, and Smart View sessions all terminate.

---

## OCI Marketplace Essbase

### Architecture on OCI

OCI Marketplace provides a pre-built Essbase VM image that can be provisioned through the OCI Console or Terraform. The Essbase software is identical to on-premise; what changes is the infrastructure layer.

\`\`\`
OCI Region
├── Compartment: EssbaseProduction
│   ├── VCN (Virtual Cloud Network)
│   │   ├── Public Subnet: Load Balancer
│   │   └── Private Subnet: Essbase VM
│   ├── Compute: VM.Standard.E4.Flex (16 OCPU / 256 GB RAM)
│   ├── Block Volume: 2 TB (for ARBORPATH — Essbase data)
│   ├── Object Storage Bucket: Essbase backups
│   └── ATP Database (optional — for Essbase metadata schema)
\`\`\`

The Essbase process runs inside the VM exactly as on-premise. You have full OS access, can run SQL*Plus, edit configuration files, and apply patches. The difference is that Oracle manages the underlying hardware, network switches, and data center availability.

### Provisioning with Terraform (OCI Marketplace)

The Essbase Marketplace listing ships with a Terraform stack. Key variables:

\`\`\`hcl
# terraform.tfvars
essbase_listing_resource_version = "21.6.0.0.0"
compartment_id        = "ocid1.compartment.oc1..exampleid"
availability_domain   = "AD-1"
shape                 = "VM.Standard.E4.Flex"
ocpus                 = 16
memory_in_gbs         = 256
data_volume_size_in_gbs = 2048
idcs_tenant           = "https://idcs-<tenant>.identity.oraclecloud.com"
idcs_client_id        = "<client_id>"
\`\`\`

After apply, Terraform outputs the Essbase URL, the admin user, and the block volume OCID for backup configuration.

### Storage Layout on OCI

Block Volumes on OCI provide consistent sub-millisecond latency with 0-10 ms sustained I/O. For Essbase, mount the block volume at ARBORPATH:

\`\`\`bash
# Format and mount the Essbase data volume (run once after provisioning)
mkfs.xfs /dev/sdb
mkdir -p /u01/config/essbase
mount -o defaults,noatime /dev/sdb /u01/config/essbase
echo '/dev/sdb /u01/config/essbase xfs defaults,noatime 0 2' >> /etc/fstab
\`\`\`

Essbase I/O is sequential for large calc passes and random for block cache misses. The OCI Block Volume Ultra High Performance tier (120 IOPS/GB) is recommended for cubes with high concurrency or frequent large calc scripts.

### Backup to OCI Object Storage

\`\`\`bash
# Export application to local LCM archive, then push to Object Storage
$ORACLE_HOME/bin/lcm/bin/esscmd.sh export_app FinPlan /tmp/FinPlan_backup.zip

# Upload to Object Storage bucket
oci os object put \
  --bucket-name essbase-backups \
  --file /tmp/FinPlan_backup.zip \
  --name "FinPlan/$(date +%Y%m%d)/FinPlan_backup.zip"
\`\`\`

### Patching on OCI Marketplace

Patching on OCI Marketplace is the same process as on-premise — you own the patch cycle. Oracle updates the Marketplace listing with new versions, but existing VMs are not automatically patched. You provision a new VM from the updated listing, migrate applications, validate, and decommission the old VM.

This is the operational trade-off: OCI Marketplace Essbase has the same patching overhead as on-premise. The advantage is that you can snapshot the Block Volume before patching, giving you a reliable rollback path that is harder to achieve on-premise without SAN clones.

---

## Oracle Cloud Essbase (Managed PaaS)

### Architecture

Oracle Cloud Essbase (the native cloud service, not Marketplace) provisions Essbase as a fully managed service inside OCI. You do not have OS access.

\`\`\`
Oracle Cloud Essbase Service
├── Essbase Web Interface (browser-based admin, outline editor, calc runner)
├── REST API (full application lifecycle management)
├── Smart View connectivity (same XMLA/Essbase provider as on-premise)
├── Autonomous Database (ATP) — Essbase metadata
├── Object Storage — cube data and backups (managed by Oracle)
└── Identity: OCI IAM / IDCS
\`\`\`

### What Changes in Cloud Essbase

**You lose:**
- OS-level access (no SSH to the Essbase server)
- Direct filesystem access (no .pag/.ind file inspection)
- Custom startup scripts and ESSBASE.CFG edits beyond what the UI exposes
- ESSCMD and MaxL direct command-line execution (replaced by REST API and web UI)
- Control over patch timing (Oracle patches the service on its schedule)

**You gain:**
- Zero infrastructure management
- Built-in backup (Oracle-managed daily snapshots)
- Elastic scaling — change shape (OCPU/memory) without downtime via the Console
- Automatic HA — Oracle manages failover
- Pay-per-use billing — stop the service when not needed and stop paying

### REST API Management

Cloud Essbase is administered via the Essbase REST API. Every operation available in the web UI is also available via API:

\`\`\`bash
# List all applications
curl -X GET https://<essbase-url>/essbase/rest/v1/applications \
  -H "Authorization: Bearer $TOKEN"

# Download outline as XML
curl -X GET \
  "https://<essbase-url>/essbase/rest/v1/applications/FinPlan/databases/Budget/outline?download=true" \
  -H "Authorization: Bearer $TOKEN" \
  -o Budget_outline.xml

# Run a calculation script
curl -X POST \
  "https://<essbase-url>/essbase/rest/v1/applications/FinPlan/databases/Budget/jobs" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jobType":"calc","jobParams":{"script":"Calcall.csc"}}'
\`\`\`

### Outline Management in Cloud Essbase

In cloud Essbase, outlines are managed through the web-based outline editor or via outline file upload (OTL binary or XML format). The REST API accepts outline files directly:

\`\`\`bash
# Upload updated outline (OTL binary)
curl -X PUT \
  "https://<essbase-url>/essbase/rest/v1/applications/FinPlan/databases/Budget/outline" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @Budget_updated.otl
\`\`\`

Outline locks still apply in cloud Essbase — only one session can hold the write lock at a time. Outline edits made in the web editor acquire the lock automatically.

---

## On-Premise vs OCI: Decision Framework

| Factor | On-Premise | OCI Marketplace | Oracle Cloud Essbase |
|--------|-----------|-----------------|----------------------|
| OS access | Full | Full (SSH) | None |
| Patching control | Full, manual | Full, manual | Oracle-managed |
| Hardware cost | Capital expense | OCI compute billing | PaaS subscription |
| Storage | SAN/NAS, capital | Block Volume, metered | Managed, included |
| Scale-up | Hardware procurement | Change VM shape | Console resize |
| HA | Manual clustering | Multi-AD with snapshots | Managed by Oracle |
| Backup | Manual + tape/NFS | OCI Object Storage | Oracle-managed |
| Calc script access | Full | Full | Via UI and REST API |
| ESSBASE.CFG tuning | Full | Full | Limited to exposed params |
| Network isolation | Full control | OCI VCN/Security Lists | OCI VCN (limited) |
| Migration path | Source | Same binary as on-prem | LCM export/import |

**Choose on-premise** when you have data residency constraints that prohibit any cloud hosting, or when existing hardware investment makes cloud cost-prohibitive in the near term.

**Choose OCI Marketplace** when you want to eliminate hardware management while retaining full administrative control — the migration from on-premise is a lift-and-shift: copy the ARBORPATH directory, start Essbase, and the applications are available. No retraining of administrators required.

**Choose Oracle Cloud Essbase** when operational simplicity is the priority, usage is periodic (monthly close, quarterly planning), or the team does not have Essbase infrastructure expertise. The pay-per-use model and managed backups reduce total cost of ownership for smaller deployments.

---

## Runbook

### Task 1 — Export an Outline from On-Premise for Migration to OCI

\`\`\`bash
# Export outline to XML format using MaxL
essmsh -l admin -p password -s localhost << 'EOF'
export database FinPlan.Budget outline to xml_file '/tmp/Budget_outline.xml';
logout;
EOF

# Compress for transfer
gzip /tmp/Budget_outline.xml
scp /tmp/Budget_outline.xml.gz opc@<oci-host>:/tmp/
\`\`\`

### Task 2 — Import Outline to OCI Marketplace Essbase

\`\`\`bash
# On OCI Marketplace host — create the application and import outline
essmsh -l admin -p password -s localhost << 'EOF'
create application FinPlan;
create database FinPlan.Budget type BSO;
import database FinPlan.Budget outline from xml_file '/tmp/Budget_outline.xml' overwrite_outline;
logout;
EOF
\`\`\`

### Task 3 — Migrate Application Data (On-Premise to OCI)

\`\`\`bash
# Export all data from on-premise cube to text
essmsh -l admin -p password -s localhost << 'EOF'
export database FinPlan.Budget all data to data_file '/tmp/Budget_data.txt';
logout;
EOF

# Compress and transfer
gzip /tmp/Budget_data.txt
scp /tmp/Budget_data.txt.gz opc@<oci-host>:/tmp/

# On OCI host — load into target cube
essmsh -l admin -p password -s localhost << 'EOF'
import database FinPlan.Budget data from data_file '/tmp/Budget_data.txt'
  using rules_file '' on error write to '/tmp/Budget_load_error.txt';
logout;
EOF
\`\`\`

### Task 4 — Migrate Application Using LCM (Full App Bundle)

LCM (Lifecycle Management) packages the outline, data, calc scripts, rules, security filters, and substitution variables into a single zip. This is the preferred approach for full application migrations.

\`\`\`bash
# On source server — export via LCM (EPM System LCM utility)
$ORACLE_HOME/EPMSystem11R1/products/Foundation/LCM/bin/epmlcm.sh \
  -user admin -password <pw> \
  -server localhost -port 19000 \
  -export /tmp/FinPlan_LCM.zip \
  -application FinPlan

# Transfer and import on OCI host
scp /tmp/FinPlan_LCM.zip opc@<oci-host>:/tmp/

# On OCI host
$ORACLE_HOME/EPMSystem11R1/products/Foundation/LCM/bin/epmlcm.sh \
  -user admin -password <pw> \
  -server localhost -port 19000 \
  -import /tmp/FinPlan_LCM.zip \
  -application FinPlan
\`\`\`

### Task 5 — Update Substitution Variables After Migration

Verify substitution variables carried over correctly and update if needed:

\`\`\`bash
essmsh -l admin -p password -s localhost << 'EOF'
-- List all substitution variables
query database FinPlan.Budget get all variables;

-- Update current period variable
alter system change variable CurPer to 'Jul';
alter system change variable CurYr  to 'FY2026';
logout;
EOF
\`\`\`

### Task 6 — Verify Outline Integrity After Migration

\`\`\`bash
# Restructure database to validate outline after import
essmsh -l admin -p password -s localhost << 'EOF'
alter database FinPlan.Budget force restructure;
logout;
EOF
\`\`\`

Then run a test calculation and compare output against the source system for a known data point.

### Task 7 — Configure ESSBASE.CFG for On-Premise Performance

Key configuration parameters for on-premise and OCI Marketplace (edit $ARBORPATH/essbase.cfg):

\`\`\`
-- Cache settings (tune based on available RAM)
CALCLOCKBLOCK         DEFAULT
DATACACHESIZE         512000      -- 512 MB data block cache
INDEXCACHESIZE        128000      -- 128 MB index cache (BSO)
CACHELOCKINGPOLICY    0           -- non-locking cache (recommended for most workloads)

-- Concurrency
AGENTTHREADS          5           -- max simultaneous application startup threads
NETDELAY              200
NETTIMEOUT            3600

-- Calculator
CALCPARALLEL          8           -- parallel calc threads (set to vCPU count)
CALCTASKDIMS          8

-- Data compression
DATACOMPRESSION       BITMAP      -- recommended for most BSO cubes
\`\`\`

Restart Essbase after editing essbase.cfg.

### Task 8 — Schedule Application Backup on OCI

\`\`\`bash
#!/bin/bash
# /opt/essbase/scripts/backup_app.sh
# Run via cron: 0 2 * * * /opt/essbase/scripts/backup_app.sh

APP=$1
DB=$2
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=/tmp/essbase_backup
BUCKET=essbase-backups

mkdir -p $BACKUP_DIR

# Export app via MaxL
essmsh -l admin -p $ESSBASE_PASS -s localhost << EOF
export database \${APP}.\${DB} all data to data_file '\${BACKUP_DIR}/\${APP}_\${DB}_\${DATE}.txt';
logout;
EOF

# Compress and upload to OCI Object Storage
gzip \${BACKUP_DIR}/\${APP}_\${DB}_\${DATE}.txt
oci os object put \
  --bucket-name $BUCKET \
  --file \${BACKUP_DIR}/\${APP}_\${DB}_\${DATE}.txt.gz \
  --name "\${APP}/\${DATE}/\${APP}_\${DB}_\${DATE}.txt.gz"

rm -f \${BACKUP_DIR}/\${APP}_\${DB}_\${DATE}.txt.gz
echo "Backup complete: \${APP}.\${DB} at \${DATE}"
\`\`\`

---

## Monitoring

### Monitor 1 — Essbase Application Status

\`\`\`bash
# Check which applications are running (MaxL)
essmsh -l admin -p password -s localhost << 'EOF'
query system list applications on server;
logout;
EOF
\`\`\`

Expected output: each application shows RUNNING or STOPPED. An application that should be running but shows STOPPED indicates a process crash — check the Essbase agent log at $ARBORPATH/app/<appname>/<dbname>.log.

### Monitor 2 — Essbase Agent Log for Errors

\`\`\`bash
# Scan agent log for errors in the last 100 lines
tail -100 $ARBORPATH/essbase.log | grep -i 'error\|warning\|fatal\|crash\|denied'

# Per-application log
tail -200 $ARBORPATH/app/FinPlan/FinPlan.log | grep -i 'error\|warning'
\`\`\`

### Monitor 3 — Active User Sessions and Locks

\`\`\`bash
# List active connections and any outline/data locks
essmsh -l admin -p password -s localhost << 'EOF'
query system list users;
query database FinPlan.Budget list all objects;
logout;
EOF
\`\`\`

Outline locks held for more than a few minutes typically indicate a crashed client that did not release the lock. Clear stale locks with: alter database FinPlan.Budget unlock object outline;

### Monitor 4 — BSO Cache Hit Rate

\`\`\`bash
# Check block cache statistics after a calc pass
essmsh -l admin -p password -s localhost << 'EOF'
query database FinPlan.Budget get db_stats;
logout;
EOF
\`\`\`

Look for the block cache hit ratio in the output. A ratio below 80% indicates the DATACACHESIZE is too small — blocks are being evicted before reuse. Increase DATACACHESIZE in essbase.cfg.

### Monitor 5 — Page and Index File Growth (On-Premise / OCI Marketplace)

\`\`\`bash
# Check size and count of BSO data files
du -sh $ARBORPATH/app/FinPlan/Budget/*.pag
ls -lh $ARBORPATH/app/FinPlan/Budget/*.pag | wc -l

# Alert if data directory exceeds threshold
DATA_SIZE_GB=$(du -sg $ARBORPATH/app/FinPlan/Budget/ | cut -f1)
THRESHOLD_GB=500
if [ $DATA_SIZE_GB -gt $THRESHOLD_GB ]; then
  echo "ALERT: FinPlan.Budget data size \${DATA_SIZE_GB}GB exceeds threshold \${THRESHOLD_GB}GB"
fi
\`\`\`

### Monitor 6 — OCI Block Volume Utilization

\`\`\`bash
# Check filesystem usage on the Essbase data volume (OCI Marketplace)
df -h /u01/config/essbase

# OCI CLI — get block volume metrics
oci monitoring metric-data summarize-metrics-data \
  --compartment-id ocid1.compartment.oc1..exampleid \
  --query-text 'VolumeReadOps[1m].mean()' \
  --namespace oci_blockstore \
  --start-time "$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
\`\`\`

### Monitor 7 — Cloud Essbase Job Status (REST API)

\`\`\`bash
# Get recent job history (calc scripts, data loads, outline edits)
curl -X GET \
  "https://<essbase-url>/essbase/rest/v1/applications/FinPlan/databases/Budget/jobs?limit=20" \
  -H "Authorization: Bearer $TOKEN" | jq '.items[] | {jobType, status, startTime, endTime}'
\`\`\`

Failed jobs in cloud Essbase surface here. A failed calc job with status ERROR indicates a syntax error in the calc script or a timeout — retrieve the job log via the REST API for the specific job ID.

### Monitor 8 — Substitution Variable Consistency Check

After each period close, verify substitution variables are updated correctly:

\`\`\`bash
essmsh -l admin -p password -s localhost << 'EOF'
query system get all variables;
logout;
EOF
# Compare output against expected CurYr and CurPer values
\`\`\`

A calc script referencing a stale CurPer will silently produce incorrect results — this check catches it before users run reports.

---

## Conclusion

The Essbase outline is the single most consequential design decision for cube performance and accuracy. Dense/sparse classification, Dynamic Calc usage, and consolidation operator choices determine whether a calc that should take 2 minutes takes 20. Get the outline right first; everything else is operational procedure.

On hosting: the gap between on-premise and OCI Marketplace is narrower than most administrators expect. The Essbase binary is identical, the administration commands are the same, and a migration is a file copy. The gap between either self-managed option and Oracle Cloud Essbase is wider — you trade OS access and full configurability for zero infrastructure management. For teams that run Essbase seasonally or who lack dedicated Essbase infrastructure expertise, the managed service is the better total cost of ownership option. For teams who run complex, frequently calculated cubes with custom ESSBASE.CFG tuning, the control of on-premise or OCI Marketplace is worth preserving.
`,
};

async function main() {
  await db.insert(posts).values(post);
  console.log('Inserted:', post.slug);
}

main().catch(console.error);
