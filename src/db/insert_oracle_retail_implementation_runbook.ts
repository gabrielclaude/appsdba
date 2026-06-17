import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Retail Suite Implementation Runbook: RMS, RIB, RPAS, and Store Systems',
  slug: 'oracle-retail-implementation-runbook',
  excerpt:
    'A phased, command-level implementation runbook for the Oracle Retail Suite — covering database preparation, RMS schema installation, RIB messaging setup, item master data load, RPAS domain configuration, ORPOS store rollout, inventory initialisation, EBS financials integration, and a go-live checklist with a full validation matrix.',
  category: 'oracle-retail' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-17'),
  youtubeUrl: null,
  content: `This runbook covers a complete, phased implementation of the Oracle Retail Suite from bare infrastructure through to a production-ready environment. Each phase includes exact shell commands, SQL scripts, and configuration steps written for Oracle Retail 22.x on Oracle Database 19c and Oracle Linux 8. Follow the phases in sequence; later phases have hard dependencies on earlier ones.

---

## Phase 1 — Infrastructure and Database Preparation

### 1.1 Oracle Database 19c Prerequisites

Oracle Retail RMS requires specific \`init.ora\` (or SPFILE) parameters before the schema installation scripts will pass their pre-install checks. Apply these to the CDB or PDB that will host RMS.

\`\`\`sql
-- Connect as SYSDBA and apply parameters
ALTER SYSTEM SET db_block_size          = 8192          SCOPE=SPFILE;
ALTER SYSTEM SET sga_target             = 32G           SCOPE=BOTH;
ALTER SYSTEM SET pga_aggregate_target   = 8G            SCOPE=BOTH;
ALTER SYSTEM SET processes              = 1500          SCOPE=SPFILE;
ALTER SYSTEM SET open_cursors           = 1000          SCOPE=BOTH;
ALTER SYSTEM SET session_cached_cursors = 200           SCOPE=BOTH;
ALTER SYSTEM SET aq_tm_processes        = 4             SCOPE=BOTH;
ALTER SYSTEM SET enable_ddl_logging     = TRUE          SCOPE=BOTH;
ALTER SYSTEM SET nls_length_semantics   = CHAR          SCOPE=BOTH;
ALTER SYSTEM SET query_rewrite_enabled  = TRUE          SCOPE=BOTH;
ALTER SYSTEM SET job_queue_processes    = 20            SCOPE=BOTH;
\`\`\`

**Recommended values for retail workloads:**

| Parameter | Minimum | Recommended (500-store retailer) |
|---|---|---|
| \`sga_target\` | 8 GB | 32 GB |
| \`pga_aggregate_target\` | 4 GB | 8 GB |
| \`processes\` | 500 | 1500 |
| \`open_cursors\` | 300 | 1000 |
| \`aq_tm_processes\` | 1 | 4 |

**NLS_CHARACTERSET requirement — critical:** Oracle Retail requires \`AL32UTF8\` as the database character set. This cannot be changed post-installation without a full database recreation. Verify before running any installer:

\`\`\`sql
SELECT value FROM nls_database_parameters WHERE parameter = 'NLS_CHARACTERSET';
-- Must return: AL32UTF8
\`\`\`

If the character set is not \`AL32UTF8\`, recreate the database using DBCA and select Unicode (AL32UTF8) before proceeding.

Restart the database after SPFILE changes to \`db_block_size\` and \`processes\`:

\`\`\`bash
sqlplus / as sysdba <<'EOF'
SHUTDOWN IMMEDIATE;
STARTUP;
SELECT name, value FROM v\$parameter
WHERE name IN ('db_block_size','sga_target','pga_aggregate_target',
               'processes','open_cursors','aq_tm_processes');
EOF
\`\`\`

### 1.2 Tablespace Creation for RMS Schema

Create four dedicated tablespaces for the RMS schema. Use separate tablespaces for data, indexes, LOBs, and temporary segments to support independent storage management and partition maintenance.

\`\`\`sql
-- RETAIL_DATA: primary data tablespace, 8 GB initial, autoextend
CREATE TABLESPACE retail_data
  DATAFILE '/oradata/rmsdb/retail_data01.dbf' SIZE 8192M
  AUTOEXTEND ON NEXT 512M MAXSIZE 100G
  EXTENT MANAGEMENT LOCAL AUTOALLOCATE
  SEGMENT SPACE MANAGEMENT AUTO;

-- RETAIL_IDX: index tablespace
CREATE TABLESPACE retail_idx
  DATAFILE '/oradata/rmsdb/retail_idx01.dbf' SIZE 4096M
  AUTOEXTEND ON NEXT 256M MAXSIZE 50G
  EXTENT MANAGEMENT LOCAL AUTOALLOCATE
  SEGMENT SPACE MANAGEMENT AUTO;

-- RETAIL_TEMP: dedicated temporary tablespace for RMS sessions
CREATE TEMPORARY TABLESPACE retail_temp
  TEMPFILE '/oradata/rmsdb/retail_temp01.dbf' SIZE 2048M
  AUTOEXTEND ON NEXT 256M MAXSIZE 20G;

-- RETAIL_LOBS: LOB segments (item images, document attachments)
CREATE TABLESPACE retail_lobs
  DATAFILE '/oradata/rmsdb/retail_lobs01.dbf' SIZE 2048M
  AUTOEXTEND ON NEXT 256M MAXSIZE 20G
  EXTENT MANAGEMENT LOCAL AUTOALLOCATE
  SEGMENT SPACE MANAGEMENT AUTO;

-- Create the RMS application schema user
CREATE USER rms22 IDENTIFIED BY "<strong_password>"
  DEFAULT TABLESPACE retail_data
  TEMPORARY TABLESPACE retail_temp
  QUOTA UNLIMITED ON retail_data
  QUOTA UNLIMITED ON retail_idx
  QUOTA UNLIMITED ON retail_lobs;

GRANT CONNECT, RESOURCE, CREATE VIEW, CREATE SYNONYM,
      CREATE SEQUENCE, CREATE TABLE, CREATE INDEX,
      CREATE PROCEDURE, CREATE TYPE, CREATE TRIGGER TO rms22;
GRANT SELECT ANY DICTIONARY TO rms22;
GRANT EXECUTE ON dbms_aq TO rms22;
GRANT EXECUTE ON dbms_aqadm TO rms22;
\`\`\`

### 1.3 Oracle Partitioning Option Verification

RMS requires the Oracle Partitioning option. Verify before running the installer — the schema creation scripts will fail if Partitioning is not licensed and enabled:

\`\`\`sql
SELECT value FROM v\$option WHERE parameter = 'Partitioning';
-- Must return: TRUE
\`\`\`

If \`FALSE\`, you must license and enable the Partitioning option before proceeding. Contact Oracle licensing.

### 1.4 WebLogic 14.1.1 Domain Creation for RMS

\`\`\`bash
# Set environment
export ORACLE_HOME=/opt/oracle/wls14
export JAVA_HOME=/opt/oracle/jdk17
export DOMAIN_HOME=/opt/oracle/domains/rms_domain

# Create the WebLogic domain using the RMS domain template
\${ORACLE_HOME}/oracle_common/common/bin/config.sh -silent \
  -template \${ORACLE_HOME}/oracle_retail/rms/domain-template/rms-domain-template.jar \
  -domain \${DOMAIN_HOME} \
  -app_dir \${DOMAIN_HOME}/applications \
  -javaHome \${JAVA_HOME} \
  -adminUserName weblogic \
  -adminPassword "<strong_password>" \
  -domainMode production

# Start the Admin Server
\${DOMAIN_HOME}/bin/startWebLogic.sh &
sleep 60

# Verify Admin Server is up
curl -s http://localhost:7001/console/ | grep -i "weblogic"
\`\`\`

### 1.5 Linux OS Tuning

Apply these kernel and OS-level settings on both the Oracle Database server and the WebLogic application server hosts. Add to \`/etc/sysctl.conf\` on the database server:

\`\`\`bash
# Database server — kernel parameters for Oracle DB
cat >> /etc/sysctl.conf <<'SYSCTL'
kernel.shmmax = 137438953472
kernel.shmall = 33554432
kernel.shmmni = 4096
kernel.sem = 250 32000 100 128
net.ipv4.ip_local_port_range = 9000 65500
net.core.rmem_default = 262144
net.core.rmem_max = 4194304
net.core.wmem_default = 262144
net.core.wmem_max = 1048576
vm.nr_hugepages = 16384
vm.hugetlb_shm_group = 54321
SYSCTL

sysctl -p

# Open file limits for WebLogic (add to /etc/security/limits.conf)
cat >> /etc/security/limits.conf <<'LIMITS'
oracle   soft   nofile   65536
oracle   hard   nofile   65536
oracle   soft   nproc    16384
oracle   hard   nproc    16384
weblogic soft   nofile   65536
weblogic hard   nofile   65536
LIMITS
\`\`\`

---

## Phase 2 — RMS Schema Installation

### 2.1 Download and Stage Oracle Retail 22.x Installation Media

1. Log in to [Oracle eDelivery](https://edelivery.oracle.com) with your Oracle SSO account.
2. Search for **Oracle Retail Merchandising System 22.x** and select the Linux x86-64 media pack.
3. Download the following archives:
   - \`V1234567-01.zip\` — Oracle Retail Merchandising System 22.x (Application)
   - \`V1234568-01.zip\` — Oracle Retail Merchandising System 22.x (Database Objects)

\`\`\`bash
# Stage the installation media
mkdir -p /opt/oracle/install/rms22
cd /opt/oracle/install/rms22
unzip V1234567-01.zip
unzip V1234568-01.zip

# Verify the installation directory structure
ls -1
# Expected: rms_app/  rms_db/  rms_patch/  rms_utilities/  README.txt
\`\`\`

### 2.2 RMS Schema Creation Scripts

The RMS database object installer creates all schema objects in the correct dependency order. Run as the \`rms22\` schema owner:

\`\`\`bash
cd /opt/oracle/install/rms22/rms_db

# Run the top-level installer (reads installer.properties)
# Edit installer.properties first:
vi installer.properties
# Set: db.user=rms22 / db.password=<password> / db.tns_alias=rmsdb
# Set: data.tablespace=retail_data / idx.tablespace=retail_idx / lob.tablespace=retail_lobs

# Execute the schema creation
./install.sh -setup 2>&1 | tee /tmp/rms_install_\$(date +%Y%m%d_%H%M%S).log
\`\`\`

The installer runs the following SQL scripts in sequence:

| Script | Purpose |
|---|---|
| \`rms_ddl.sql\` | All table definitions |
| \`rms_idx.sql\` | All index definitions |
| \`rms_seqs.sql\` | All sequence definitions |
| \`rms_pkgs_spec.sql\` | Package specifications |
| \`rms_pkgs_body.sql\` | Package bodies |
| \`rms_trg.sql\` | Triggers |
| \`rms_grants.sql\` | Cross-schema grants |

Monitor the install log for ORA- errors. A successful install produces zero ORA- errors and ends with "RMS Database Object Installation Complete."

### 2.3 RMS Seed Data Load

After schema creation, load foundation seed data. Oracle Retail ships seed data as SQL scripts in \`rms_db/seed/\`:

\`\`\`bash
# Load seed data in the correct order
sqlplus rms22/<password>@rmsdb <<'EOF'
@seed/currencies.sql
@seed/countries.sql
@seed/vat_regions.sql
@seed/system_options_seed.sql
@seed/terms_codes.sql
@seed/org_unit.sql
@seed/cost_zone_group.sql
EOF
\`\`\`

Key seed data tables:

| Table | Purpose |
|---|---|
| \`CURRENCIES\` | ISO 4217 currency codes and descriptions |
| \`COUNTRIES\` | ISO 3166 country codes |
| \`VAT_REGION\` | VAT/tax jurisdiction definitions |
| \`TERMS\` | Payment terms codes |
| \`SYSTEM_OPTIONS\` | Global RMS system configuration flags |

### 2.4 Key RMS Configuration Tables

After seed load, configure the core system options:

\`\`\`sql
-- Set primary currency and base cost zone
UPDATE system_options
SET    primary_currency = 'USD',
       system_close_date = SYSDATE,
       base_cost_zone_grp_id = 1,
       default_tax_type = 'SVAT',
       multichannel_ind = 'Y',
       wf_control_level = 'ITEM';
COMMIT;

-- Verify SYSTEM_OPTIONS configuration
SELECT primary_currency, multichannel_ind, default_tax_type
FROM   system_options;

-- Check key configuration tables have been seeded
SELECT 'CURRENCIES'   AS tbl, COUNT(*) cnt FROM currencies
UNION ALL
SELECT 'COUNTRIES',   COUNT(*) FROM countries
UNION ALL
SELECT 'VAT_REGION',  COUNT(*) FROM vat_region
UNION ALL
SELECT 'TERMS',       COUNT(*) FROM terms;
\`\`\`

### 2.5 Post-Install Verification Queries

\`\`\`sql
-- Count schema objects — all should be VALID
SELECT object_type, COUNT(*) AS cnt,
       SUM(CASE WHEN status = 'INVALID' THEN 1 ELSE 0 END) AS invalid_cnt
FROM   user_objects
GROUP  BY object_type
ORDER  BY object_type;

-- Verify core tables exist
SELECT table_name FROM user_tables
WHERE  table_name IN ('ITEM_MASTER','STORE','SUPPLIER','SUPS',
                      'ITEM_LOC','ITEM_LOC_SOH','TRAN_DATA',
                      'ORDHEAD','ORDSKU','ORDLOC')
ORDER  BY table_name;

-- Confirm zero invalid objects
SELECT object_name, object_type, status
FROM   user_objects
WHERE  status = 'INVALID'
ORDER  BY object_type, object_name;
\`\`\`

### 2.6 Gather Schema Statistics After Initial Load

\`\`\`sql
-- Gather statistics on the entire RMS schema
EXEC dbms_stats.gather_schema_stats(
       ownname          => 'RMS22',
       options          => 'GATHER AUTO',
       estimate_percent => dbms_stats.auto_sample_size,
       degree           => 4,
       cascade          => TRUE
     );

-- Verify statistics are current
SELECT table_name,
       num_rows,
       TO_CHAR(last_analyzed, 'YYYY-MM-DD HH24:MI') AS last_analyzed
FROM   all_tables
WHERE  owner = 'RMS22'
  AND  last_analyzed IS NULL
ORDER  BY table_name;
-- Zero rows returned = all tables have statistics
\`\`\`

---

## Phase 3 — RIB (Retail Integration Bus) Setup

### 3.1 Install RIB on WebLogic

\`\`\`bash
# Stage RIB installation media
mkdir -p /opt/oracle/install/rib22
cd /opt/oracle/install/rib22
unzip rib-22.x.x.x-all-rms.zip

# Configure rib-deployment-env-info.xml
# Set: RIB_HOME, WLS_HOME, AQ_INSTALL_DIR, RMS_DB_HOST, RMS_DB_SID

# Deploy RIB EAR files for RMS
cd \${RIB_HOME}/tools-home/rib-app-builder
./rib-app-compiler.sh -setup-env
./rib-app-compiler.sh -compile-rib-app rib-rms
./rib-deployer.sh -deploy-rib-app rib-rms

# Deploy the TAFR (Translation and Filtering) EAR
./rib-app-compiler.sh -compile-rib-app rib-tafr
./rib-deployer.sh -deploy-rib-app rib-tafr

# Verify deployment in WebLogic
./rib-status.sh
\`\`\`

### 3.2 Configure Oracle AQ Queues

The RIB uses Oracle Advanced Queuing for all message transport. Create per-application queues:

\`\`\`sql
-- Create the RIB message queue table
EXEC dbms_aqadm.create_queue_table(
       queue_table        => 'ribrib.rib_out_qtab',
       queue_payload_type => 'SYS.AQ\$_JMS_TEXT_MESSAGE',
       multiple_consumers => TRUE,
       comment            => 'RIB outbound queue table'
     );

-- Create the RIB_OUT queue (RMS publishes here)
EXEC dbms_aqadm.create_queue(
       queue_name  => 'ribrib.rib_rms_out',
       queue_table => 'ribrib.rib_out_qtab'
     );
EXEC dbms_aqadm.start_queue(queue_name => 'ribrib.rib_rms_out');

-- Create the inbound queue for ORPOS
EXEC dbms_aqadm.create_queue_table(
       queue_table        => 'ribrib.rib_in_qtab',
       queue_payload_type => 'SYS.AQ\$_JMS_TEXT_MESSAGE',
       multiple_consumers => TRUE
     );
EXEC dbms_aqadm.create_queue(
       queue_name  => 'ribrib.rib_orpos_in',
       queue_table => 'ribrib.rib_in_qtab'
     );
EXEC dbms_aqadm.start_queue(queue_name => 'ribrib.rib_orpos_in');

-- Grant AQ privileges to RMS schema
EXEC dbms_aqadm.grant_queue_privilege(
       privilege => 'ENQUEUE',
       queue_name => 'ribrib.rib_rms_out',
       grantee => 'RMS22'
     );
\`\`\`

### 3.3 JMS Connection Factory Configuration in WebLogic Console

1. Log in to WebLogic Admin Console: \`http://<wls-host>:7001/console\`
2. Navigate to **Services → Messaging → JMS Servers** → New JMS Server named \`RIBJMSServer\`, targeting it to the RIB managed server.
3. Navigate to **Services → Messaging → JMS Modules** → Create Module \`RIBJMSModule\`.
4. Within the module, create a **Connection Factory** with these settings:

| Setting | Value |
|---|---|
| Name | \`RIBConnectionFactory\` |
| JNDI Name | \`jms/RIBConnectionFactory\` |
| Default Delivery Mode | Persistent |
| Acknowledge Policy | All |
| Transaction Timeout | 30 seconds |

5. Create **Uniform Distributed Queues** for each message family (ITEM, PRICE, POSLOG, INVUPD, ASN).

### 3.4 RIB Hospital Tables — Create Indexes

\`\`\`sql
-- RIB hospital tables are created by the RIB installer; add these indexes for performance
CREATE INDEX ribadm.ix_rib_msg_fam_state
  ON ribadm.rib_message (message_family, in_queue)
  TABLESPACE retail_idx;

CREATE INDEX ribadm.ix_rib_fail_time
  ON ribadm.rib_message_failure (error_time)
  TABLESPACE retail_idx;

CREATE INDEX ribadm.ix_rib_fail_fam
  ON ribadm.rib_message_failure (message_family, processed_ind)
  TABLESPACE retail_idx;
\`\`\`

### 3.5 Test Message Flow

\`\`\`sql
-- Publish a test ITEM message from RMS to verify RIB flow
-- (Use the RIB test harness in RIB_HOME/tools-home/rib-integration-tester)

-- After publishing, check the ORPOS inbound queue for the message
SELECT msg_id,
       msg_state,
       enq_time,
       deq_time,
       consumer_name
FROM   aq\$ribrib_orpos_in_qtab
WHERE  msg_state = 'READY'
ORDER  BY enq_time DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

### 3.6 RIB Error Hospital Monitoring Query

\`\`\`sql
-- RIB Error Hospital — unprocessed failures by message family
SELECT message_family,
       COUNT(*)                              AS failed_count,
       MIN(error_time)                       AS oldest_failure,
       MAX(error_time)                       AS newest_failure,
       MAX(num_retries)                      AS max_retries
FROM   ribadm.rib_message_failure
WHERE  processed_ind = 'N'
GROUP  BY message_family
ORDER  BY failed_count DESC;
\`\`\`

Alert if \`failed_count\` for any message family exceeds 100 during normal operations or 1000 during a batch data load.

---

## Phase 4 — Item Master Data Load

### 4.1 Item Hierarchy Setup

Oracle Retail uses a five-level merchandise hierarchy: Division → Department → Class → Subclass → Item → SKU (for style-color-size). Create the hierarchy from top down:

\`\`\`sql
-- Create a Division
INSERT INTO rms22.div (div, div_name, buyer, merch)
VALUES (1, 'APPAREL', 'BUYER01', 'MERCH01');

-- Create a Department under the Division
INSERT INTO rms22.deps (dept, dept_name, div, buyer, merch, profit_calc_type)
VALUES (1010, 'MENS TOPS', 1, 'BUYER01', 'MERCH01', 'R');

-- Create a Class under the Department
INSERT INTO rms22.class (dept, class, class_name)
VALUES (1010, 1, 'CASUAL SHIRTS');

-- Create a Subclass under the Class
INSERT INTO rms22.subclass (dept, class, subclass, sub_name)
VALUES (1010, 1, 1, 'SHORT SLEEVE');

COMMIT;
\`\`\`

### 4.2 UPC/GTIN Validation Before Load

Run this validation query against your staging table before inserting any items:

\`\`\`sql
-- Validate UPC length and check digit (GS1-12 = 12 digits, GS1-13 = 13 digits)
SELECT upc_ean,
       LENGTH(upc_ean) AS upc_len,
       CASE WHEN REGEXP_LIKE(upc_ean, '^[0-9]{12,14}\$') THEN 'OK' ELSE 'INVALID FORMAT' END AS fmt_check
FROM   rms22.item_staging
WHERE  REGEXP_LIKE(upc_ean, '^[0-9]{12,14}\$') = FALSE
   OR  upc_ean IS NULL;

-- Find duplicate UPCs in staging
SELECT upc_ean, COUNT(*) AS dup_count
FROM   rms22.item_staging
GROUP  BY upc_ean
HAVING COUNT(*) > 1
ORDER  BY dup_count DESC;

-- Find UPCs already in production (conflict detection)
SELECT s.upc_ean, s.item_desc, p.item AS existing_item
FROM   rms22.item_staging s
JOIN   rms22.upc_ean p ON p.upc = s.upc_ean
WHERE  p.item != s.item;
\`\`\`

Resolve all validation errors before proceeding to the batch load step.

### 4.3 Batch Load via RMS Item Upload API

\`\`\`sql
-- Populate the ITEM_UPLOAD staging table
INSERT INTO rms22.item_upload (
  upload_seq, item, item_desc, item_type, dept, class, subclass,
  item_level, tran_level, pack_ind, status, upc_ean,
  standard_uom, create_datetime, create_user
)
SELECT
  rms22.item_upload_seq.NEXTVAL,
  s.item_number,
  s.item_desc,
  'ITEM',
  s.dept_no,
  s.class_no,
  s.subclass_no,
  2,        -- item_level: 1=style, 2=item, 3=SKU
  2,        -- tran_level: level at which transactions are recorded
  'N',
  'W',      -- W = worksheet (pending activation)
  s.upc_ean,
  'EA',
  SYSDATE,
  'BATCH_LOAD'
FROM rms22.item_staging s
WHERE s.processed_ind = 'N';
COMMIT;

-- Submit the RMS Item Upload concurrent program via batch script
\${RMS_HOME}/batch/rfmirtab.ksh -user batch_user -job ITEMUPLOAD 2>&1 \
  | tee /logs/rms/item_upload_\$(date +%Y%m%d_%H%M%S).log
\`\`\`

### 4.4 Style-Color-Size Matrix Setup for Fashion Retail

\`\`\`sql
-- Create a Style (item_level=1)
INSERT INTO rms22.item_master (item, item_desc, item_type, dept, class, subclass,
  item_level, tran_level, pack_ind, status, create_datetime, create_user)
VALUES ('STYLE001', 'POLO SHIRT', 'ITEM', 1010, 1, 1, 1, 2, 'N', 'A', SYSDATE, 'SETUP');

-- Create Color differentiator values
INSERT INTO rms22.item_diff (item, diff_type, diff_id)
SELECT 'STYLE001', 'C', diff_id FROM rms22.diff_ids WHERE diff_group_id = 'COLORS';

-- Create Size differentiator values
INSERT INTO rms22.item_diff (item, diff_type, diff_id)
SELECT 'STYLE001', 'S', diff_id FROM rms22.diff_ids WHERE diff_group_id = 'SIZES_SM_XL';

COMMIT;

-- The RMS item matrix program will expand style → color/size SKUs
-- Run: rfmirskm.ksh (Style-Color-Size Matrix Creation batch)
\${RMS_HOME}/batch/rfmirskm.ksh -user batch_user -item STYLE001
\`\`\`

### 4.5 Supplier Item Relationship Setup

\`\`\`sql
-- Create supplier-item relationship (SUPS_ITEM)
INSERT INTO rms22.item_supp_country (
  item, supplier, origin_country_id, lead_time, supp_pack_size,
  ti, hi, supp_uom, supp_uom_qty, primary_supp_ind, primary_country_ind
)
VALUES (
  'STYLE001', 12345, 'US', 14, 12,
  6, 8, 'EA', 1, 'Y', 'Y'
);
COMMIT;

-- Verify supplier-item relationships
SELECT i.item, i.item_desc, s.supplier, sc.supp_name, isc.lead_time
FROM   rms22.item_master i
JOIN   rms22.item_supp_country isc ON isc.item = i.item
JOIN   rms22.sups sc ON sc.supplier = isc.supplier
WHERE  isc.primary_supp_ind = 'Y'
ORDER  BY i.item;
\`\`\`

### 4.6 Item-Location Relationship Setup

\`\`\`sql
-- Range-insert item-location relationships for all active stores
INSERT INTO rms22.item_loc (
  item, loc, loc_type, unit_retail, selling_unit_retail,
  taxable_ind, status, primary_variant
)
SELECT
  'STYLE001',
  s.store,
  'S',
  29.99,
  29.99,
  'Y',
  'A',
  NULL
FROM rms22.store s
WHERE s.store_close_date IS NULL;

-- Initialise ITEM_LOC_SOH (stock on hand) records at zero
INSERT INTO rms22.item_loc_soh (item, loc, loc_type, unit_cost, average_weight,
  stock_on_hand, non_sellable_qty, in_transit_qty, tsf_reserved_qty)
SELECT
  'STYLE001', s.store, 'S', 15.50, 0.25,
  0, 0, 0, 0
FROM rms22.store s
WHERE s.store_close_date IS NULL;

COMMIT;
\`\`\`

### 4.7 Post-Load Validation Queries

\`\`\`sql
-- Item counts by hierarchy level
SELECT item_level, COUNT(*) AS item_count, status
FROM   rms22.item_master
GROUP  BY item_level, status
ORDER  BY item_level, status;

-- Items with missing primary supplier
SELECT COUNT(*) AS items_missing_supplier
FROM   rms22.item_master i
WHERE  i.status = 'A'
  AND  NOT EXISTS (
         SELECT 1 FROM rms22.item_supp_country isc
         WHERE  isc.item = i.item
           AND  isc.primary_supp_ind = 'Y'
       );

-- Item-location setup count
SELECT COUNT(DISTINCT item) AS items, COUNT(*) AS item_loc_rows
FROM   rms22.item_loc
WHERE  status = 'A';
\`\`\`

---

## Phase 5 — RPAS/RDF Domain Configuration

### 5.1 RPAS Fusion Client Installation Prerequisites

RPAS requires the following on the application server (dedicated Linux host):

\`\`\`bash
# Verify Java version (RPAS 22.x requires JDK 17)
java -version

# Required OS packages
yum install -y gcc gcc-c++ glibc-devel libstdc++-devel \
               zlib-devel libxcrypt-compat ncurses-devel

# Set RPAS environment variables
export RPAS_HOME=/opt/oracle/rpas
export RPAS_RELEASE=22.x.x.x
export JAVA_HOME=/opt/oracle/jdk17
export PATH=\${RPAS_HOME}/bin:\${JAVA_HOME}/bin:\${PATH}

# Verify RPAS binary
rpasinstall -version
\`\`\`

### 5.2 Domain Creation

\`\`\`bash
# Create the RDF (Retail Demand Forecasting) domain
rpasinstall -install \
  -domain /opt/oracle/rpas/domains/rdf_domain \
  -config /opt/oracle/rpas/config/rdf_config.xml \
  -patch \${RPAS_HOME}/patches/rdf_22.x.x.x_base.patch

# Verify domain creation
ls -la /opt/oracle/rpas/domains/rdf_domain/
# Expected directories: config/ data/ export/ import/ log/ measures/ tmp/

# Check domain status
domainmaint -domain /opt/oracle/rpas/domains/rdf_domain -status
\`\`\`

### 5.3 Hierarchy Dimension Configuration

Edit \`rdf_config.xml\` to define the three standard RPAS hierarchies:

\`\`\`xml
<!-- Product hierarchy: style/color/size rollup to department/division -->
<hierarchy name="prod">
  <dimension name="sku"     label="SKU"      level="0"/>
  <dimension name="style"   label="Style"    level="1"/>
  <dimension name="sclass"  label="Subclass" level="2"/>
  <dimension name="class"   label="Class"    level="3"/>
  <dimension name="dept"    label="Dept"     level="4"/>
  <dimension name="div"     label="Division" level="5"/>
  <dimension name="clnd"    label="Company"  level="6"/>
</hierarchy>

<!-- Location hierarchy: store rollup to district/area/chain -->
<hierarchy name="loc">
  <dimension name="store"   label="Store"    level="0"/>
  <dimension name="dist"    label="District" level="1"/>
  <dimension name="area"    label="Area"     level="2"/>
  <dimension name="chain"   label="Chain"    level="3"/>
  <dimension name="co"      label="Company"  level="4"/>
</hierarchy>

<!-- Calendar hierarchy: day rollup to week/month/quarter/year -->
<hierarchy name="clnd">
  <dimension name="day"     label="Day"      level="0"/>
  <dimension name="week"    label="Week"     level="1"/>
  <dimension name="month"   label="Month"    level="2"/>
  <dimension name="quarter" label="Quarter"  level="3"/>
  <dimension name="half"    label="Half"     level="4"/>
  <dimension name="year"    label="Year"     level="5"/>
</hierarchy>
\`\`\`

### 5.4 Measure Workbook Setup

Configure the base measures required for RDF forecasting:

| Measure Name | Type | Dimensions | Description |
|---|---|---|---|
| \`r_ty_salesu\` | Real | sku/store/day | Actual sales units (this year) |
| \`r_ly_salesu\` | Real | sku/store/day | Last year sales units |
| \`r_adj_salesu\` | Real | sku/store/week | Adjusted/cleansed sales |
| \`r_fcst_salesu\` | Real | sku/store/week | Statistical forecast output |
| \`r_fcst_overrd\` | Real | sku/store/week | Planner override of forecast |

### 5.5 Domain Rebuild Command After Hierarchy Changes

After any hierarchy or measure configuration change, rebuild the domain:

\`\`\`bash
# Rebuild domain (brings down all users — schedule during maintenance window)
domainmaint -domain /opt/oracle/rpas/domains/rdf_domain \
            -rebuild \
            -keepdata \
            -log /opt/oracle/rpas/domains/rdf_domain/log/rebuild_\$(date +%Y%m%d).log

# Monitor rebuild progress
tail -f /opt/oracle/rpas/domains/rdf_domain/log/rebuild_\$(date +%Y%m%d).log
\`\`\`

### 5.6 RPAS Error Log Location and Common Errors

\`\`\`bash
# Primary RPAS error log
tail -200 /opt/oracle/rpas/domains/rdf_domain/log/rpas_error.log

# Batch program error log
ls -lt /opt/oracle/rpas/domains/rdf_domain/log/batch*.log | head -10

# Common errors and resolutions:
# "Hierarchy dimension not found" → check dimension names match exactly in config XML
# "Measure source not populated" → batch dependency order wrong; check batch job sequence
# "Domain lock file exists" → stale lock from crashed batch; remove /tmp/rdf_domain.lock
# "Disk quota exceeded" → RPAS data directory full; check df -h on domain filesystem
\`\`\`

---

## Phase 6 — Store Systems Rollout (ORPOS)

### 6.1 ORPOS Application Server Prerequisites

ORPOS can be deployed on either Apache Tomcat 10 or WebLogic 14.1.1. Tomcat is recommended for store servers (lower memory footprint). Central deployment server uses WebLogic.

\`\`\`bash
# Install Tomcat 10 on store server
yum install -y java-17-openjdk

# Download and extract Tomcat
mkdir -p /opt/orpos/tomcat
tar -xzf apache-tomcat-10.x.x.tar.gz -C /opt/orpos/tomcat --strip-components=1

# Deploy ORPOS WAR
cp /opt/oracle/install/orpos22/orpos.war /opt/orpos/tomcat/webapps/
cp /opt/oracle/install/orpos22/orpos-config/store_\${STORE_NUMBER}/*.properties \
   /opt/orpos/tomcat/webapps/orpos/WEB-INF/classes/

# Set JVM heap for store server (2-4 GB typical)
export CATALINA_OPTS="-Xms1024m -Xmx2048m -XX:+UseG1GC"

# Start ORPOS
/opt/orpos/tomcat/bin/startup.sh
\`\`\`

### 6.2 Store Database Setup

**Option A — Central Database (recommended for new implementations):**
ORPOS connects directly to the central RMS Oracle Database. No local store database required. Configure the JNDI datasource in Tomcat to point to the central database.

**Option B — Local Store Database:**
Each store has a local Oracle Database Express Edition (XE) instance that synchronises with central RMS:

\`\`\`bash
# Install Oracle XE on store server
yum install -y oracle-database-xe-21c

# Configure store DB
/etc/init.d/oracle-xe-21c configure

# Create the ORPOS store schema
sqlplus sys/<password>@//localhost/XEPDB1 as sysdba <<'EOF'
CREATE USER orpos IDENTIFIED BY "<store_password>"
  DEFAULT TABLESPACE users TEMPORARY TABLESPACE temp
  QUOTA UNLIMITED ON users;
GRANT CONNECT, RESOURCE TO orpos;
EOF
\`\`\`

### 6.3 Lane/Till Configuration in RMS

\`\`\`sql
-- Configure store → register → till hierarchy in RMS
-- Insert store record
INSERT INTO rms22.store (store, store_name, store_type, store_close_date,
  currency_code, lang, status, org_unit_id)
VALUES (101, 'DOWNTOWN FLAGSHIP', 'C', NULL, 'USD', 1, 'A', 1);

-- Insert register (lane)
INSERT INTO rms22.store_register (store, register, register_desc, status)
VALUES (101, 1, 'LANE 1', 'A'),
       (101, 2, 'LANE 2', 'A'),
       (101, 3, 'LANE 3', 'A');

-- Insert till
INSERT INTO rms22.tills (store, register, till, till_desc, status)
VALUES (101, 1, 1, 'TILL 1-1', 'A'),
       (101, 2, 1, 'TILL 2-1', 'A'),
       (101, 3, 1, 'TILL 3-1', 'A');

COMMIT;
\`\`\`

### 6.4 POS Transaction Upload to RMS (POSU Process)

\`\`\`bash
# The POSU (POS Upload) batch reads POSLOG XML files from the store drop directory
# and posts transactions to RMS TRAN_DATA

# Configure POSU drop directory
mkdir -p /poslog/incoming/store_101
mkdir -p /poslog/processed/store_101
mkdir -p /poslog/error/store_101

# Run POSU batch
\${RMS_HOME}/batch/rfmirpou.ksh \
  -user batch_user \
  -storedir /poslog/incoming \
  -archivedir /poslog/processed \
  -errordir /poslog/error \
  2>&1 | tee /logs/rms/posu_\$(date +%Y%m%d_%H%M%S).log
\`\`\`

### 6.5 Till Reconciliation

\`\`\`sql
-- End-of-day till balancing query
SELECT t.store,
       t.register,
       t.till,
       t.business_date,
       t.open_amount,
       t.close_amount,
       t.sales_total,
       t.returns_total,
       t.cash_drops_total,
       (t.open_amount + t.sales_total - t.returns_total - t.cash_drops_total - t.close_amount)
         AS variance
FROM   rms22.tills_detail t
WHERE  t.business_date = TRUNC(SYSDATE - 1)
  AND  t.store = 101
ORDER  BY t.register, t.till;

-- Identify tills with variance > \$5.00
SELECT store, register, till, business_date, variance
FROM   rms22.tills_detail
WHERE  ABS(open_amount + sales_total - returns_total - cash_drops_total - close_amount) > 5
  AND  business_date >= TRUNC(SYSDATE) - 7
ORDER  BY business_date DESC, ABS(open_amount + sales_total - returns_total
          - cash_drops_total - close_amount) DESC;
\`\`\`

### 6.6 ORPOS Log File Locations and Common Startup Errors

\`\`\`bash
# Tomcat ORPOS application log
tail -100 /opt/orpos/tomcat/logs/orpos.log

# Catalina stdout log (captures JVM startup errors)
tail -50 /opt/orpos/tomcat/logs/catalina.out

# Common startup errors:
# "Cannot connect to database" → check JNDI datasource config in context.xml
# "ItemNotFound for item XXXXXXX" → item not yet propagated via RIB to store DB
# "TillAlreadyOpen" → previous session not closed; run till recovery procedure
# "LicenseException" → ORPOS license key not configured in orpos.properties
# "ClassNotFoundException: oracle.jdbc.OracleDriver" → ojdbc8.jar missing from lib/
\`\`\`

---

## Phase 7 — Inventory and Replenishment Activation

### 7.1 Stock on Hand Initialisation

Load opening stock on hand figures from the physical inventory count:

\`\`\`sql
-- Load stock counts from inventory staging table
UPDATE rms22.item_loc_soh ils
SET    ils.stock_on_hand = (
         SELECT NVL(stg.counted_qty, 0)
         FROM   rms22.inv_count_staging stg
         WHERE  stg.item = ils.item
           AND  stg.loc  = ils.loc
           AND  stg.count_date = TO_DATE('2026-06-01','YYYY-MM-DD')
       )
WHERE  EXISTS (
         SELECT 1 FROM rms22.inv_count_staging stg
         WHERE  stg.item = ils.item AND stg.loc = ils.loc
       );
COMMIT;

-- Record the inventory adjustment transaction in TRAN_DATA
INSERT INTO rms22.tran_data (
  tran_id, tran_date, item, loc, loc_type, tran_type,
  units, unit_cost, amount, create_datetime, create_user
)
SELECT
  rms22.tran_data_seq.NEXTVAL,
  TRUNC(SYSDATE),
  ils.item,
  ils.loc,
  'S',
  '30',   -- tran_type 30 = inventory adjustment
  ils.stock_on_hand,
  ils.unit_cost,
  ils.stock_on_hand * ils.unit_cost,
  SYSDATE,
  'INV_INIT'
FROM rms22.item_loc_soh ils
WHERE ils.stock_on_hand > 0;
COMMIT;
\`\`\`

### 7.2 Replenishment Attribute Setup

\`\`\`sql
-- Set up replenishment attributes for auto-replenishment
INSERT INTO rms22.repl_attribute (
  item, loc, loc_type, repl_method,
  min_qty, max_qty, repl_qty,
  order_cycle, lead_time, review_cycle,
  presentation_min, presentation_max,
  status
)
VALUES (
  'STYLE001', 101, 'S',
  'M',         -- M = Min/Max replenishment method
  24,          -- min_qty: reorder point
  96,          -- max_qty: order up to
  72,          -- repl_qty: suggested replenishment quantity
  7,           -- order_cycle: order every 7 days
  14,          -- lead_time: 14 days supplier lead time
  7,           -- review_cycle: review every 7 days
  6,           -- presentation_min: minimum shelf presentation
  12,          -- presentation_max: maximum shelf presentation
  'A'
);
COMMIT;
\`\`\`

### 7.3 Activate Replenishment Batch Job

\`\`\`bash
# Run RPLATAB — Replenishment Attributes Batch
# This program calculates replenishment needs and creates transfer/PO suggestions
\${RMS_HOME}/batch/rplatab.ksh \
  -user batch_user \
  -store_date \$(date +%Y%m%d) \
  2>&1 | tee /logs/rms/rplatab_\$(date +%Y%m%d_%H%M%S).log

# Check replenishment suggestions created
sqlplus rms22/<password>@rmsdb <<'EOF'
SELECT repl_method, COUNT(*) AS suggestions, SUM(suggested_qty) AS total_units
FROM   rms22.repl_results
WHERE  suggest_date = TRUNC(SYSDATE)
GROUP  BY repl_method
ORDER  BY repl_method;
EOF
\`\`\`

### 7.4 Transfer Order Creation and Approval Workflow

\`\`\`sql
-- Create a transfer order header
INSERT INTO rms22.tsf_head (
  tsf_no, tsf_type, from_loc, from_loc_type, to_loc, to_loc_type,
  deliver_date, status, create_datetime, create_user
)
VALUES (
  rms22.tsf_head_seq.NEXTVAL, 'W', 9001, 'W', 101, 'S',
  TRUNC(SYSDATE) + 5, 'A', SYSDATE, 'REPL_BATCH'
);

-- Approve the transfer (update status to T = Transfer in Progress)
UPDATE rms22.tsf_head
SET    status = 'T', approve_datetime = SYSDATE, approve_user = 'BUYER01'
WHERE  tsf_no = (SELECT MAX(tsf_no) FROM rms22.tsf_head WHERE status = 'A');
COMMIT;
\`\`\`

### 7.5 Receiving Confirmation in ORPOS — ASN Processing

\`\`\`bash
# ORPOS receives ASN (Advance Shipping Notice) via RIB from RMS when transfer ships
# After physical receipt at store, ORPOS sends RCPT confirmation back via RIB

# Verify ASN messages arrived in ORPOS queue
sqlplus ribadm/<password>@rmsdb <<'EOF'
SELECT msg_id, message_family, msg_state, enq_time
FROM   aq\$ribrib_orpos_in_qtab
WHERE  message_family = 'ASN'
  AND  msg_state = 'READY'
ORDER  BY enq_time DESC
FETCH FIRST 10 ROWS ONLY;
EOF
\`\`\`

---

## Phase 8 — EBS Financials Integration

### 8.1 AP Supplier Sync: RMS SUPPLIER → EBS AP_SUPPLIERS

In environments using a database link, synchronise supplier records nightly:

\`\`\`sql
-- Create the database link from RMS DB to EBS DB (run as SYSDBA on RMS DB)
CREATE DATABASE LINK ebs_link
  CONNECT TO apps IDENTIFIED BY "<apps_password>"
  USING 'ebsdb';

-- Test the link
SELECT COUNT(*) FROM ap_suppliers@ebs_link WHERE vendor_active_flag = 'Y';

-- Sync new suppliers from EBS to RMS
INSERT INTO rms22.sups (
  supplier, supp_name, status, currency_code, payment_terms,
  primary_country, create_datetime, create_user
)
SELECT
  aps.vendor_id,
  aps.vendor_name,
  'A',
  NVL(aps.invoice_currency_code, 'USD'),
  NVL(aps.terms_id, 1),
  'US',
  SYSDATE,
  'EBS_SYNC'
FROM ap_suppliers@ebs_link aps
WHERE aps.vendor_active_flag = 'Y'
  AND aps.vendor_type_lookup_code = 'VENDOR'
  AND NOT EXISTS (
    SELECT 1 FROM rms22.sups s WHERE s.supplier = aps.vendor_id
  );
COMMIT;
\`\`\`

### 8.2 GL Posting: RMS TRAN_DATA → EBS GL_INTERFACE

\`\`\`bash
# Run the RMS GL Upload batch to generate journal entries for EBS
\${RMS_HOME}/batch/rfmirglb.ksh \
  -user batch_user \
  -gl_date \$(date +%Y%m%d) \
  2>&1 | tee /logs/rms/gl_upload_\$(date +%Y%m%d_%H%M%S).log

# Verify GL staging rows created in RMS
sqlplus rms22/<password>@rmsdb <<'EOF'
SELECT period_name, COUNT(*) AS journal_lines, SUM(entered_dr) AS total_dr
FROM   rms22.rms_gl_temp
WHERE  processed_ind = 'N'
GROUP  BY period_name
ORDER  BY period_name;
EOF
\`\`\`

\`\`\`sql
-- Load RMS GL entries into EBS GL_INTERFACE
INSERT INTO gl_interface@ebs_link (
  status, set_of_books_id, accounting_date, currency_code,
  date_created, created_by, actual_flag, user_je_source_name,
  user_je_category_name, entered_dr, entered_cr,
  segment1, segment2, segment3, segment4, segment5,
  reference10
)
SELECT
  'NEW',
  1,                        -- set_of_books_id
  rg.gl_date,
  rg.currency_code,
  SYSDATE,
  -1,                       -- FND_GLOBAL.USER_ID equivalent
  'A',
  'Oracle Retail',
  DECODE(rg.tran_type, 'SALE', 'Sales', 'Inventory'),
  DECODE(SIGN(rg.amount), 1, rg.amount, NULL),
  DECODE(SIGN(rg.amount), -1, ABS(rg.amount), NULL),
  rg.segment1, rg.segment2, rg.segment3, rg.segment4, rg.segment5,
  'RMS-' || rg.tran_id
FROM rms22.rms_gl_temp rg
WHERE rg.processed_ind = 'N';

-- Mark as processed
UPDATE rms22.rms_gl_temp SET processed_ind = 'Y', processed_date = SYSDATE
WHERE processed_ind = 'N';
COMMIT;
\`\`\`

### 8.3 Currency and Exchange Rate Sync

\`\`\`sql
-- Sync daily exchange rates from EBS to RMS
INSERT INTO rms22.currency_rates (from_currency, to_currency, exchange_date, exchange_rate)
SELECT
  gcr.from_currency,
  gcr.to_currency,
  gcr.conversion_date,
  gcr.conversion_rate
FROM gl_daily_rates@ebs_link gcr
WHERE gcr.conversion_date = TRUNC(SYSDATE)
  AND gcr.conversion_type = 'Corporate'
  AND NOT EXISTS (
    SELECT 1 FROM rms22.currency_rates cr
    WHERE  cr.from_currency = gcr.from_currency
      AND  cr.to_currency   = gcr.to_currency
      AND  cr.exchange_date  = gcr.conversion_date
  );
COMMIT;
\`\`\`

### 8.4 End-of-Day Verification

\`\`\`sql
-- Confirm GL_INTERFACE rows were inserted for today's retail accounting run
SELECT COUNT(*) AS gl_rows_inserted,
       SUM(NVL(entered_dr,0)) AS total_dr,
       SUM(NVL(entered_cr,0)) AS total_cr,
       SUM(NVL(entered_dr,0)) - SUM(NVL(entered_cr,0)) AS net_balance
FROM gl_interface@ebs_link
WHERE user_je_source_name = 'Oracle Retail'
  AND creation_date >= TRUNC(SYSDATE)
  AND status = 'NEW';
-- Net balance should be 0.00 (balanced journals)
\`\`\`

---

## Phase 9 — Performance Tuning and Go-Live Checklist

### 9.1 Critical Indexes for RMS

\`\`\`sql
-- Verify these indexes exist; create any that are missing

-- ITEM_LOC: most frequently accessed table in RMS
CREATE INDEX rms22.ix_item_loc_item_loc
  ON rms22.item_loc (item, loc)
  TABLESPACE retail_idx;

-- TRAN_DATA: primary partition key + type filter
CREATE INDEX rms22.ix_tran_data_date_type
  ON rms22.tran_data (tran_date, tran_type)
  LOCAL  -- local partitioned index (tran_data is range-partitioned by tran_date)
  TABLESPACE retail_idx;

-- ALLOC_HEADER: allocation processing performance
CREATE INDEX rms22.ix_alloc_head_wh_item
  ON rms22.alloc_header (wh, item, alloc_method)
  TABLESPACE retail_idx;

-- ITEM_LOC_SOH: inventory queries
CREATE INDEX rms22.ix_ils_loc_soh
  ON rms22.item_loc_soh (loc, stock_on_hand)
  TABLESPACE retail_idx;

-- ORDHEAD: purchase order status queries
CREATE INDEX rms22.ix_ordhead_status_date
  ON rms22.ordhead (status, not_before_date)
  TABLESPACE retail_idx;
\`\`\`

### 9.2 Gather Stats Schedule

Create a nightly statistics job:

\`\`\`sql
BEGIN
  dbms_scheduler.create_job(
    job_name        => 'RMS_NIGHTLY_STATS',
    job_type        => 'PLSQL_BLOCK',
    job_action      => q'[
      BEGIN
        dbms_stats.gather_schema_stats(
          ownname          => 'RMS22',
          options          => 'GATHER STALE',
          estimate_percent => dbms_stats.auto_sample_size,
          degree           => 4,
          cascade          => TRUE,
          no_invalidate    => FALSE
        );
      END;
    ]',
    start_date      => TRUNC(SYSDATE + 1) + INTERVAL '2' HOUR,
    repeat_interval => 'FREQ=DAILY; BYHOUR=2; BYMINUTE=0',
    enabled         => TRUE,
    comments        => 'Nightly RMS schema statistics gather'
  );
END;
/
\`\`\`

### 9.3 RIB Queue Depth Alert

\`\`\`sql
-- RIB queue depth monitoring — alert threshold
CREATE OR REPLACE PROCEDURE ribadm.check_queue_depth IS
  v_depth NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_depth
  FROM   aq\$ribrib_rms_out_qtab
  WHERE  msg_state = 'READY';

  IF v_depth > 10000 THEN
    -- Insert into alert table or call notification procedure
    INSERT INTO ribadm.rib_alerts (alert_time, queue_name, depth, severity)
    VALUES (SYSDATE, 'RIB_RMS_OUT', v_depth, 'WARNING');
    COMMIT;
  END IF;

  IF v_depth > 100000 THEN
    INSERT INTO ribadm.rib_alerts (alert_time, queue_name, depth, severity)
    VALUES (SYSDATE, 'RIB_RMS_OUT', v_depth, 'CRITICAL');
    COMMIT;
  END IF;
END;
/

-- Schedule the queue depth check every 5 minutes
BEGIN
  dbms_scheduler.create_job(
    job_name        => 'RIB_QUEUE_DEPTH_CHECK',
    job_type        => 'STORED_PROCEDURE',
    job_action      => 'RIBADM.CHECK_QUEUE_DEPTH',
    repeat_interval => 'FREQ=MINUTELY; INTERVAL=5',
    enabled         => TRUE,
    comments        => 'RIB queue depth monitoring — alert at 10K, critical at 100K'
  );
END;
/
\`\`\`

### 9.4 Go-Live Checklist

| # | Checklist Item | Responsible | Verified By | Status |
|---|---|---|---|---|
| 1 | Oracle Database 19c RMAN full backup verified and restorable | DBA | DBA Lead | |
| 2 | RMS schema statistics gathered within last 24 hours | DBA | DBA Lead | |
| 3 | All RIB adapters (rib-rms, rib-tafr, rib-orpos) running with zero hospital messages | DBA / Integration | Integration Lead | |
| 4 | Batch job schedule loaded and tested in production scheduler | DBA | Batch Admin | |
| 5 | RPAS/RDF domain rebuilt and forecasting batch completed end-to-end | RPAS Admin | RPAS Lead | |
| 6 | Pilot store connection tested from ORPOS to central DB | Store Sys Lead | Store Sys Lead | |
| 7 | EBS GL Interface tested: trial GL posting completed, balanced journals confirmed | EBS DBA | Finance Lead | |
| 8 | EBS AP supplier sync tested: 10 test suppliers synced from EBS to RMS | EBS DBA | Procurement Lead | |
| 9 | Item master load verified: item count matches expected from legacy | DBA | Merchandising Lead | |
| 10 | All stores registered in RMS with register/till hierarchy | Merch Admin | Store Sys Lead | |
| 11 | RIB queue depth monitoring alert emails confirmed working | DBA | Operations Lead | |
| 12 | ORPOS end-of-day batch (POSU) tested with representative transaction volume | DBA | Store Sys Lead | |
| 13 | Rollback procedure documented and rehearsed (see 9.5 below) | DBA Lead | Project Manager | |
| 14 | Hypercare support rota published (24×7 cover for weeks 1-4) | Project Manager | Sponsor | |
| 15 | Data archiving and partition maintenance jobs scheduled and tested | DBA | DBA Lead | |
| 16 | Network latency from store servers to central DB measured < 10ms P99 | Infra Lead | Infra Lead | |
| 17 | WebLogic managed server JVM heap and thread pool settings reviewed | DBA / Infra | WebLogic Admin | |

### 9.5 Rollback Procedure

If a critical defect is discovered during go-live that cannot be resolved in the cutover window, execute this rollback procedure:

\`\`\`bash
# Step 1: Stop all RIB adapters to halt message processing
\${RIB_HOME}/tools-home/rib-app-builder/rib-admin.sh -stop-all-adapters

# Step 2: Disable all RMS batch jobs in the scheduler
sqlplus rms22/<password>@rmsdb <<'EOF'
BEGIN
  FOR j IN (SELECT job_name FROM user_scheduler_jobs WHERE enabled = 'TRUE') LOOP
    dbms_scheduler.disable(j.job_name);
  END LOOP;
END;
/
EOF

# Step 3: Stop ORPOS at all stores (push config change or shut down Tomcat)
for STORE in 101 102 103 104 105; do
  ssh store-server-\${STORE} "/opt/orpos/tomcat/bin/shutdown.sh"
done

# Step 4: Restore from the pre-cutover RMAN backup
rman target / <<'EOF'
STARTUP MOUNT;
RESTORE DATABASE FROM TAG 'PRE_GOLIVE_BACKUP';
RECOVER DATABASE;
ALTER DATABASE OPEN RESETLOGS;
EOF

# Step 5: Verify database is restored to pre-cutover baseline
sqlplus rms22/<password>@rmsdb <<'EOF'
SELECT COUNT(*) FROM item_master;   -- should match pre-cutover count
SELECT MAX(create_datetime) FROM tran_data;  -- should be pre-cutover date
EOF

# Step 6: Notify project stakeholders and post-mortem team
\`\`\`

---

## Validation Matrix

Use this matrix after each phase to confirm readiness before advancing to the next phase.

| Phase | Check | Query / Command | Pass Criterion |
|---|---|---|---|
| 1 | DB character set | \`SELECT value FROM nls_database_parameters WHERE parameter='NLS_CHARACTERSET'\` | \`AL32UTF8\` |
| 1 | Partitioning option | \`SELECT value FROM v\$option WHERE parameter='Partitioning'\` | \`TRUE\` |
| 1 | SGA target | \`SELECT value FROM v\$parameter WHERE name='sga_target'\` | >= 8G |
| 1 | Tablespaces exist | \`SELECT tablespace_name FROM dba_tablespaces WHERE tablespace_name LIKE 'RETAIL%'\` | 4 rows: DATA, IDX, TEMP, LOBS |
| 2 | Schema objects valid | \`SELECT COUNT(*) FROM user_objects WHERE status='INVALID'\` | 0 |
| 2 | Core tables present | \`SELECT COUNT(*) FROM user_tables WHERE table_name IN ('ITEM_MASTER','TRAN_DATA','ORDHEAD')\` | 3 |
| 2 | Statistics gathered | \`SELECT COUNT(*) FROM all_tables WHERE owner='RMS22' AND last_analyzed IS NULL\` | 0 |
| 3 | AQ queues running | \`SELECT queue_name, enqueue_enabled, dequeue_enabled FROM user_queues\` | All ENABLED/ENABLED |
| 3 | RIB adapters up | \`./rib-status.sh\` | All adapters in RUNNING state |
| 3 | Hospital empty | \`SELECT COUNT(*) FROM ribadm.rib_message_failure WHERE processed_ind='N'\` | 0 |
| 4 | Item count meets plan | \`SELECT COUNT(*) FROM rms22.item_master WHERE status='A'\` | >= planned item count |
| 4 | All items have supplier | \`SELECT COUNT(*) FROM item_master i WHERE NOT EXISTS (SELECT 1 FROM item_supp_country isc WHERE isc.item=i.item)\` | 0 |
| 4 | Item-loc rows loaded | \`SELECT COUNT(*) FROM rms22.item_loc WHERE status='A'\` | >= items x stores |
| 5 | RPAS domain status | \`domainmaint -domain /opt/oracle/rpas/domains/rdf_domain -status\` | Domain: AVAILABLE |
| 5 | Forecast batch ran | \`ls -lt /opt/oracle/rpas/domains/rdf_domain/log/batch*.log\` | Today's date on latest log |
| 6 | ORPOS connects to DB | \`curl -s http://store-server-101:8080/orpos/health\` | HTTP 200, status: UP |
| 6 | Store registered in RMS | \`SELECT COUNT(*) FROM rms22.store WHERE store=101\` | 1 |
| 7 | SOH initialised | \`SELECT COUNT(*) FROM rms22.item_loc_soh WHERE stock_on_hand > 0\` | > 0 |
| 7 | Replenishment attributes | \`SELECT COUNT(*) FROM rms22.repl_attribute WHERE status='A'\` | >= expected item-loc count |
| 8 | DB link to EBS | \`SELECT COUNT(*) FROM ap_suppliers@ebs_link WHERE vendor_active_flag='Y'\` | > 0 (no ORA- error) |
| 8 | GL Interface balanced | See Phase 8.4 query | Net balance = 0.00 |
| 9 | Critical indexes present | \`SELECT index_name FROM user_indexes WHERE index_name IN ('IX_ITEM_LOC_ITEM_LOC','IX_TRAN_DATA_DATE_TYPE','IX_ALLOC_HEAD_WH_ITEM')\` | 3 rows |
| 9 | Stats job scheduled | \`SELECT job_name, enabled FROM user_scheduler_jobs WHERE job_name='RMS_NIGHTLY_STATS'\` | ENABLED = TRUE |
| 9 | RIB alert job active | \`SELECT job_name, enabled FROM user_scheduler_jobs WHERE job_name='RIB_QUEUE_DEPTH_CHECK'\` | ENABLED = TRUE |
| 9 | Backup verified | \`rman target / list backup summary;\` | Backup completed within last 24 hours |
`,
};

async function main() {
  console.log('Inserting Oracle Retail implementation runbook...');
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
