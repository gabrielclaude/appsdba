import { config } from 'dotenv';
config({ path: '.env.local' });
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Agile PLM Implementation Runbook: Database Setup, Configuration, and EBS Integration',
  slug: 'oracle-agile-plm-implementation-runbook',
  excerpt:
    'Step-by-step premium runbook for implementing Oracle Agile PLM: Oracle Database 19c prerequisites and tablespace setup, WebLogic domain configuration, Agile schema installation and verification, class hierarchy and ECO workflow configuration, File Manager setup, EBS item/BOM/ECO integration via DB link, performance tuning for BOM explosions, and a complete go-live checklist with validation matrix.',
  category: 'oracle-agile' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-17'),
  youtubeUrl: null,
  content: `## Environment Assumptions

| Component | Value |
|-----------|-------|
| Agile PLM Version | 9.3.6 |
| Oracle Database | 19c (19.22 RU) |
| Application Server | Oracle WebLogic 12.2.1.4 |
| OS | Oracle Linux 8.x (x86_64) |
| Agile DB Host | agile-db-host.corp.local |
| Agile App Host | agile-app-host.corp.local |
| File Manager Host | agile-app-host.corp.local (co-located for single-server; separate server recommended for production) |
| Agile DB Service | AGILEDB |
| Agile Schema User | AGILE |
| EBS DB Service | EBSPROD |
| EBS Apps User | APPS |

---

## Phase 1 — Database Prerequisites

### 1.1 Verify Oracle Database Version

\`\`\`sql
-- Connect as SYSDBA
sqlplus / as sysdba

SELECT version, status FROM v\$instance;
-- Expected: 19.0.0.0.0, OPEN

SELECT banner FROM v\$version WHERE banner LIKE 'Oracle%';
\`\`\`

Agile 9.3.6 is certified on Oracle Database 12.2, 18c, and 19c. Use 19c for new installations — it receives LTS support through 2027+.

### 1.2 Verify Character Set

\`\`\`sql
SELECT value FROM nls_database_parameters WHERE parameter = 'NLS_CHARACTERSET';
-- Required: AL32UTF8 (preferred) or WE8ISO8859P1
-- If AL32UTF8: supports all Unicode characters including Asian scripts
-- If WE8ISO8859P1: supports Western European only; insufficient if supplier names
--   contain non-Latin characters

SELECT value FROM nls_database_parameters WHERE parameter = 'NLS_NCHAR_CHARACTERSET';
-- Should be AL16UTF16
\`\`\`

> **Critical**: Do NOT install Agile on a database with a single-byte character set other than WE8ISO8859P1. Changing the character set post-installation requires a full export/import — extremely disruptive.

### 1.3 Set init.ora Parameters

\`\`\`sql
-- Verify current parameter values
SELECT name, value, description
FROM   v\$parameter
WHERE  name IN (
  'db_block_size',
  'open_cursors',
  'processes',
  'sessions',
  'undo_retention',
  'session_cached_cursors',
  'pga_aggregate_target',
  'sga_target'
)
ORDER BY name;
\`\`\`

Required parameter values (set in \`/opt/oracle/product/19c/dbhome_1/dbs/initAGILEDB.ora\` or via \`ALTER SYSTEM\`):

\`\`\`ini
# Agile PLM 9.3.6 — Oracle 19c init.ora recommended settings
db_block_size          = 8192
open_cursors           = 1000
processes              = 500
sessions               = 750
undo_retention         = 7200
session_cached_cursors = 100
pga_aggregate_target   = 4G
sga_target             = 16G
enable_goldengate_replication = FALSE
# For environments with large BOM explosions (1000+ component BOMs):
# result_cache_max_size  = 512M
\`\`\`

\`\`\`sql
-- Apply dynamically (where SCOPE=BOTH is supported):
ALTER SYSTEM SET open_cursors       = 1000 SCOPE=BOTH;
ALTER SYSTEM SET processes          = 500  SCOPE=SPFILE;
ALTER SYSTEM SET sessions           = 750  SCOPE=SPFILE;
ALTER SYSTEM SET undo_retention     = 7200 SCOPE=BOTH;
ALTER SYSTEM SET session_cached_cursors = 100 SCOPE=BOTH;
-- Bounce the database after SPFILE-only changes:
SHUTDOWN IMMEDIATE;
STARTUP;
\`\`\`

### 1.4 Verify Oracle Partitioning Option

\`\`\`sql
SELECT value FROM v\$option WHERE parameter = 'Partitioning';
-- Required: TRUE
-- Agile uses range-partitioned tables for audit history and change log data
\`\`\`

If Partitioning is not enabled, the database license must include the Partitioning option before proceeding.

### 1.5 Create Agile Tablespaces

\`\`\`sql
-- Data tablespace (item master, BOM, ECO, class metadata)
CREATE TABLESPACE AGILE_DATA
  DATAFILE '/opt/oracle/oradata/AGILEDB/agile_data01.dbf' SIZE 10G
  AUTOEXTEND ON NEXT 1G MAXSIZE 50G
  EXTENT MANAGEMENT LOCAL UNIFORM SIZE 1M
  SEGMENT SPACE MANAGEMENT AUTO;

-- Index tablespace
CREATE TABLESPACE AGILE_IDX
  DATAFILE '/opt/oracle/oradata/AGILEDB/agile_idx01.dbf' SIZE 5G
  AUTOEXTEND ON NEXT 512M MAXSIZE 20G
  EXTENT MANAGEMENT LOCAL UNIFORM SIZE 256K
  SEGMENT SPACE MANAGEMENT AUTO;

-- LOB tablespace (file attachments stored as BLOBs, audit trail CLOBs)
CREATE TABLESPACE AGILE_LOB
  DATAFILE '/opt/oracle/oradata/AGILEDB/agile_lob01.dbf' SIZE 20G
  AUTOEXTEND ON NEXT 2G MAXSIZE 200G
  EXTENT MANAGEMENT LOCAL UNIFORM SIZE 8M
  SEGMENT SPACE MANAGEMENT AUTO;

-- Temporary tablespace
CREATE TEMPORARY TABLESPACE AGILE_TEMP
  TEMPFILE '/opt/oracle/oradata/AGILEDB/agile_temp01.dbf' SIZE 4G
  AUTOEXTEND ON NEXT 1G MAXSIZE 20G;

-- Verify tablespace creation
SELECT tablespace_name, status, contents, extent_management
FROM   dba_tablespaces
WHERE  tablespace_name LIKE 'AGILE%'
ORDER BY tablespace_name;
\`\`\`

> **LOB sizing note**: Plan AGILE_LOB for 10x your estimated initial file attachment size and grow at 2 GB/month for a 500-item/month new product introduction rate.

### 1.6 Create the Agile Database User

\`\`\`sql
CREATE USER agile
  IDENTIFIED BY "Agile_Str0ng_Pwd#2024"
  DEFAULT   TABLESPACE AGILE_DATA
  TEMPORARY TABLESPACE AGILE_TEMP
  QUOTA UNLIMITED ON AGILE_DATA
  QUOTA UNLIMITED ON AGILE_IDX
  QUOTA UNLIMITED ON AGILE_LOB;

-- Required grants
GRANT CONNECT          TO agile;
GRANT RESOURCE         TO agile;
GRANT CREATE VIEW      TO agile;
GRANT CREATE SEQUENCE  TO agile;
GRANT CREATE SYNONYM   TO agile;
GRANT CREATE DATABASE LINK TO agile;

-- Additional grants required by Agile 9.3.x installer
GRANT SELECT ON dba_objects     TO agile;
GRANT SELECT ON dba_indexes     TO agile;
GRANT SELECT ON dba_tables      TO agile;
GRANT SELECT ON dba_constraints TO agile;
GRANT SELECT ON v_\$session      TO agile;
GRANT SELECT ON v_\$parameter    TO agile;

-- Verify
SELECT username, default_tablespace, temporary_tablespace, account_status
FROM   dba_users
WHERE  username = 'AGILE';
\`\`\`

---

## Phase 2 — WebLogic Domain Setup

### 2.1 WebLogic Installation

Agile PLM 9.3.6 requires Oracle WebLogic Server 12.2.1.4. Download \`fmw_12.2.1.4.0_wls_Disk1_1of1.zip\` from Oracle Software Delivery Cloud.

\`\`\`bash
# Create directory structure
mkdir -p /opt/oracle/middleware/12.2.1.4
mkdir -p /opt/oracle/agile/domains

# Install WLS in silent mode
java -jar fmw_12.2.1.4.0_wls.jar -silent -responseFile /tmp/wls_response.rsp

# Verify installation
/opt/oracle/middleware/12.2.1.4/oracle_common/common/bin/wlst.sh -version
\`\`\`

### 2.2 Create the Agile WebLogic Domain

Use the Agile-provided domain template or the standard WLS \`config.sh\` wizard:

\`\`\`bash
# Create domain using WLS configuration wizard (console mode)
/opt/oracle/middleware/12.2.1.4/oracle_common/common/bin/config.sh -silent \
  -template /opt/oracle/agile/936/templates/agile_wls_template.jar \
  -domain_home /opt/oracle/agile/domains/agile_domain \
  -domain_name agile_domain \
  -admin_user weblogic \
  -admin_password "Weblogic_Str0ng#" \
  -admin_url t3://agile-app-host.corp.local:7001
\`\`\`

### 2.3 JVM Heap Configuration

Edit \`/opt/oracle/agile/domains/agile_domain/bin/setDomainEnv.sh\`:

\`\`\`bash
# AdminServer heap
if [ "\${SERVER_NAME}" = "AdminServer" ]; then
  export USER_MEM_ARGS="-Xms2g -Xmx4g -XX:+UseG1GC -XX:MaxGCPauseMillis=200"
fi

# Agile Managed Server heap (primary application server)
if [ "\${SERVER_NAME}" = "AgileServer1" ]; then
  export USER_MEM_ARGS="-Xms4g -Xmx16g -XX:+UseG1GC -XX:MaxGCPauseMillis=200 \
    -XX:G1HeapRegionSize=16m -XX:+HeapDumpOnOutOfMemoryError \
    -XX:HeapDumpPath=/opt/oracle/agile/dumps"
fi

# JVM options for Agile (required)
export EXTRA_JAVA_PROPERTIES="\
  -Dagile.server.home=/opt/oracle/agile/936 \
  -Dfile.encoding=UTF-8 \
  -Dsun.net.inetaddr.ttl=60"
\`\`\`

### 2.4 JDBC Data Source Configuration

Configure the Agile JDBC data source in the WebLogic Admin Console or via WLST:

\`\`\`bash
# Create JDBC data source via WLST
/opt/oracle/middleware/12.2.1.4/oracle_common/common/bin/wlst.sh <<'WLST'
connect('weblogic', 'Weblogic_Str0ng#', 't3://agile-app-host.corp.local:7001')
edit()
startEdit()

cd('/')
cmo.createJDBCSystemResource('AgileDS')
cd('JDBCSystemResources/AgileDS/JDBCResource/AgileDS')
cmo.setName('AgileDS')
cd('JDBCSystemResources/AgileDS/JDBCResource/AgileDS/JDBCDriverParams/AgileDS')
set('DriverName', 'oracle.jdbc.OracleDriver')
set('URL', 'jdbc:oracle:thin:@agile-db-host.corp.local:1521/AGILEDB')
set('PasswordEncrypted', 'Agile_Str0ng_Pwd#2024')
cd('Properties/AgileDS')
create('user', 'Property')
cd('user')
cmo.setValue('agile')

cd('/JDBCSystemResources/AgileDS/JDBCResource/AgileDS/JDBCConnectionPoolParams/AgileDS')
set('MinCapacity', 5)
set('MaxCapacity', 50)
set('CapacityIncrement', 5)
set('TestConnectionsOnReserve', true)
set('TestTableName', 'SQL SELECT 1 FROM DUAL')
set('SecondsToTrustAnIdlePoolConnection', 0)

save()
activate()
disconnect()
WLST
\`\`\`

\`\`\`sql
-- Verify JDBC connectivity from the DB side
-- After WLS is running with the data source active:
SELECT username, program, machine, status
FROM   v\$session
WHERE  username = 'AGILE'
ORDER BY logon_time DESC;
-- Should see connections from agile-app-host with program = JDBC Thin Client
\`\`\`

---

## Phase 3 — Agile Schema Installation

### 3.1 Run the Agile Installer

\`\`\`bash
# Extract Agile 9.3.6 media
unzip V1025987-01.zip -d /opt/oracle/agile/install

# Run installer in console mode
cd /opt/oracle/agile/install
./install.sh -mode console

# Key installer prompts:
# - Installation directory: /opt/oracle/agile/936
# - Database type: Oracle
# - DB host: agile-db-host.corp.local
# - DB port: 1521
# - DB service name: AGILEDB
# - Agile schema user: AGILE
# - Agile schema password: Agile_Str0ng_Pwd#2024
# - WebLogic home: /opt/oracle/middleware/12.2.1.4
# - Domain home: /opt/oracle/agile/domains/agile_domain
# - File Manager root: /opt/agile/filestore
\`\`\`

The installer creates all schema objects in the AGILE schema. For a full PC + PQM + PPM + PGC installation, this takes 20–45 minutes.

### 3.2 Post-Install Schema Verification

\`\`\`sql
-- Connect as AGILE user and verify table count
-- Full Agile PC + PQM + PPM + PGC installation creates 1,800+ tables
SELECT COUNT(*) AS table_count FROM all_tables WHERE owner = 'AGILE';
-- Expected range: 1,800 to 2,200 depending on modules installed

-- Verify seed data: base class records
SELECT COUNT(*) AS class_count FROM agile.classes;
-- Expected: 50+ base classes (Parts, Documents, Change Orders, Quality Objects, etc.)

-- Verify lifecycle phases are seeded
SELECT COUNT(*) AS phase_count FROM agile.lifecyclephases;
-- Expected: 10+ base lifecycle phases

-- Verify no invalid objects in Agile schema
SELECT object_type, COUNT(*) AS cnt
FROM   all_objects
WHERE  owner  = 'AGILE'
  AND  status = 'INVALID'
GROUP BY object_type;
-- Expected: 0 rows (no invalid objects after clean install)

-- Check for any failed constraints
SELECT constraint_name, constraint_type, status
FROM   all_constraints
WHERE  owner  = 'AGILE'
  AND  status = 'DISABLED'
ORDER BY constraint_type;
\`\`\`

### 3.3 Apply Post-Install Patch Set

\`\`\`bash
# Apply any Agile 9.3.6 patch set releases after base installation
cd /opt/oracle/agile/patches/936_PS3

# Read the patch README for specific instructions; typical flow:
./apply_patch.sh \
  -db_host agile-db-host.corp.local \
  -db_port 1521 \
  -db_service AGILEDB \
  -agile_user AGILE \
  -agile_pwd "Agile_Str0ng_Pwd#2024"
\`\`\`

---

## Phase 4 — Class and Attribute Configuration

### 4.1 Item Class Hierarchy Design

Access the Agile Admin Console at \`http://agile-app-host.corp.local:7001/Agile/secure/AgileApplet.jnlp\` (or the web admin URL for 9.3.x) and navigate to **Admin > System Settings > Classes**.

Recommended starting class hierarchy for a high-tech manufacturer:

\`\`\`
Parts (base class, do not modify)
├── Mechanical Parts          [prefix: MP-, auto-number]
│   ├── Sheet Metal           [prefix: SM-]
│   ├── Machined Parts        [prefix: MC-]
│   └── Plastic Parts         [prefix: PL-]
├── Electronic Parts          [prefix: EP-, auto-number]
│   ├── Active Components     [prefix: AC-]
│   ├── Passive Components    [prefix: PC-]
│   └── Connectors            [prefix: CN-]
├── Assemblies                [prefix: ASY-, auto-number]
├── Software                  [prefix: SW-, auto-number]
└── Documentation             [prefix: DOC-, auto-number]

Change Orders (base class)
├── Engineering Change Order  [prefix: ECO-, auto-number]
├── Manufacturing Change Order [prefix: MCO-, auto-number]
└── Deviation                 [prefix: DEV-, auto-number]

Quality Objects (base class)
├── Non-Conformance Report    [prefix: NCR-, auto-number]
└── CAPA                      [prefix: CAP-, auto-number]
\`\`\`

### 4.2 User-Defined Attributes (UDA)

UDAs extend the standard Agile attribute set. Configure via **Admin > System Settings > Classes > [Class] > [Page] > Attributes**.

Example Title Block UDAs for Electronic Parts:

| Attribute Name | Type | List/Default | Page |
|----------------|------|--------------|------|
| Product Family | List | [configure values] | Title Block |
| Package Type | List | DIP, SOIC, QFP, BGA, 0402, 0805 | Title Block |
| Temperature Grade | List | Commercial, Industrial, Military | Title Block |
| RoHS Compliant | List | Yes, No, Pending | Title Block |
| Preferred Status | List | Preferred, Approved, Alternate | Page Two |
| Lead Time (Days) | Numeric | — | Page Two |
| Safety Stock Qty | Numeric | — | Page Two |

### 4.3 Privilege Gates

Privilege gates control which user roles can view or modify which attributes at each lifecycle phase. Navigate to **Admin > System Settings > Classes > [Class] > Privilege Gates**.

Key privilege gate rules:
- Attributes on Title Block: read-only for all roles after lifecycle phase = Production (only ECO process can change released items)
- BOM (Page Two): read-only after lifecycle = Prototype without an approved ECO
- Lifecycle phase transitions: require Engineering Manager role for Prototype → Production promotion

### 4.4 Lifecycle Phases

Configure lifecycle phases per class via **Admin > System Settings > Lifecycles**. Standard phases for Parts:

| Phase | Numeric Code | Meaning |
|-------|-------------|---------|
| Preliminary | 10 | Item created, in design, not yet approved for prototypes |
| Prototype | 20 | Approved for prototype builds only |
| Production | 30 | Approved for production manufacturing |
| Obsolete | 40 | End-of-life; no new designs should reference this item |

### 4.5 List Values and Unit of Measure

\`\`\`sql
-- After configuration, verify list values are populated
SELECT list_name, COUNT(*) AS value_count
FROM   agile.listvalues
GROUP BY list_name
ORDER BY list_name;

-- Verify UOM codes match EBS UOM list (critical for EBS integration)
SELECT uom_code, unit_of_measure
FROM   agile.uom_codes
ORDER BY uom_code;
\`\`\`

---

## Phase 5 — ECO Workflow Configuration

### 5.1 Configure Approver Groups

Navigate to **Admin > System Settings > Workflow > Approver Groups**.

Create the following approver groups:

| Group Name | Members | Routing |
|------------|---------|---------|
| Engineering Review Board | Engineering Managers + Lead Engineers | Sequential within group (majority approval) |
| Manufacturing Engineering | Manufacturing Engineers | Parallel (any one approval sufficient) |
| Quality Assurance | Quality Engineers + QA Manager | Sequential (QA Manager final) |
| Procurement | Commodity Managers | Parallel (any one approval) |

### 5.2 Workflow Routing per Change Type

\`\`\`
Engineering Change Order (ECO):
  Route 1 (Full Routing — BOM structural changes):
    Step 1: Engineering Review Board     [Sequential, all required, escalate after 3 days]
    Step 2: Manufacturing Engineering    [Parallel, any 1 of N, escalate after 2 days]
    Step 3: Quality Assurance           [Sequential, QA Manager final, escalate after 3 days]

  Route 2 (Fast Track — documentation/attachment changes only):
    Step 1: Engineering Review Board     [Any 1 of N, escalate after 1 day]

Manufacturing Change Order (MCO):
    Step 1: Manufacturing Engineering   [Sequential, all required]
    Step 2: Quality Assurance           [Parallel, any 1 of N]

Deviation:
    Step 1: Engineering Review Board    [Any 1 of N]
    Step 2: Quality Assurance           [Any 1 of N]
\`\`\`

### 5.3 Escalation and Notification Configuration

Agile uses Apache Velocity templates for email notifications. Template location:

\`\`\`bash
ls /opt/oracle/agile/936/config/notification_templates/
# Files: ChangeOrderApproval.vm, ChangeOrderEscalation.vm,
#        ChangeOrderRelease.vm, NCR_Notification.vm, etc.
\`\`\`

Configure SMTP settings in Agile Admin Console: **Admin > System Settings > E-mail Settings**:

\`\`\`
SMTP Host: smtp.corp.local
SMTP Port: 25
From Address: agile-noreply@corp.local
Enable SSL: No (or Yes if using port 587/465)
\`\`\`

### 5.4 Test ECO End-to-End

\`\`\`bash
# Manual test procedure (execute from Agile Web Client):
# 1. Create a test item: P-TEST-001 (Electronic Parts > Active Components)
# 2. Create a BOM with 3 child components on P-TEST-001
# 3. Create an ECO: ECO-TEST-0001
# 4. Add P-TEST-001 as an Affected Item
# 5. Redline a BOM change (change quantity on one component)
# 6. Submit the ECO → confirm approver group members receive email notification
# 7. Approve as all required approver groups
# 8. Confirm ECO status = Released
# 9. Verify P-TEST-001 revision incremented (A → B)
# 10. Verify BOM change is reflected on released BOM
\`\`\`

\`\`\`sql
-- Verify ECO audit trail after test
SELECT change_id, change_number, status, modified_by, modified_date, action_taken
FROM   agile.changes_history
WHERE  change_number = 'ECO-TEST-0001'
ORDER BY modified_date;
-- Should show: Created, Submitted, Approved (×N), Released
\`\`\`

---

## Phase 6 — File Manager Configuration

### 6.1 File Manager Setup

\`\`\`bash
# Create file vault directory
mkdir -p /opt/agile/filestore
chown oracle:oinstall /opt/agile/filestore
chmod 750 /opt/agile/filestore

# For production: mount NFS or SAN volume here
# mount -t nfs agile-filestore-nas.corp.local:/exports/agile /opt/agile/filestore
\`\`\`

Configure File Manager in Agile Admin Console: **Admin > Server Configuration > File Manager**:

\`\`\`
File Manager URL: http://agile-app-host.corp.local:7001/Agile/filemanager
File Vault Root: /opt/agile/filestore
Maximum File Size: 500 MB
Allowed File Types: *.pdf, *.dwg, *.dxf, *.sldprt, *.sldasm, *.catpart, *.step, *.iges, *.xlsx, *.docx, *.zip
\`\`\`

### 6.2 Disk Sizing and Monitoring

\`\`\`bash
# Monitor file vault disk usage
df -h /opt/agile/filestore

# Set up cron-based disk alert (oracle user):
# */30 * * * * /home/oracle/scripts/check_filestore.sh

# check_filestore.sh:
#!/bin/bash
THRESHOLD=80
USAGE=\$(df /opt/agile/filestore | awk 'NR==2 {print \$5}' | tr -d '%')
if [ "\$USAGE" -gt "\$THRESHOLD" ]; then
  echo "Agile file vault disk usage at \${USAGE}%: /opt/agile/filestore" | \
    mail -s "ALERT: Agile File Vault Disk \${USAGE}%" dba-alerts@corp.local
fi
\`\`\`

\`\`\`sql
-- Verify file records in database vs disk (should match)
SELECT COUNT(*) AS db_file_count,
       ROUND(SUM(file_size) / 1024 / 1024, 2) AS total_mb
FROM   agile.files
WHERE  deleted = 'N';
-- Compare total_mb to: du -sm /opt/agile/filestore
\`\`\`

### 6.3 File Manager Backup

Include the file vault in your backup strategy alongside RMAN:

\`\`\`bash
# Nightly rsync to secondary storage (run after RMAN backup)
#!/bin/bash
# /home/oracle/scripts/backup_filestore.sh
FILESTORE_SRC="/opt/agile/filestore"
FILESTORE_DST="agile-backup-host.corp.local:/backup/agile/filestore"
LOG="/home/oracle/scripts/logs/filestore_backup_\$(date +%Y%m%d).log"

rsync -avz --delete --log-file="\$LOG" \
  "\$FILESTORE_SRC/" "\$FILESTORE_DST/"

if [ \$? -eq 0 ]; then
  echo "Agile filestore rsync completed successfully" >> "\$LOG"
else
  echo "Agile filestore rsync FAILED" | mail -s "ALERT: Agile Filestore Backup Failed" dba-alerts@corp.local
fi
\`\`\`

---

## Phase 7 — EBS Item Master Integration

### 7.1 Integration Method: Custom DB Link + Scheduled Procedure

For environments without Oracle SOA Suite, a DB link–based integration is pragmatic and maintainable.

#### Step 1: Create DB Link from Agile DB to EBS DB

\`\`\`sql
-- Connect to Agile DB as DBA
sqlplus / as sysdba

-- Create private DB link in AGILE schema
-- (run as AGILE user, or create public DB link as SYSDBA)
CREATE DATABASE LINK ebs_link
  CONNECT TO apps IDENTIFIED BY "apps_password"
  USING 'EBSPROD';

-- Test connectivity
SELECT COUNT(*) FROM mtl_system_items_b@ebs_link WHERE rownum = 1;
-- Expected: 1 (connection works)
\`\`\`

#### Step 2: Item Master Sync Procedure

\`\`\`sql
CREATE OR REPLACE PROCEDURE agile.sync_items_to_ebs (
  p_since_date IN DATE DEFAULT SYSDATE - 1/24  -- default: last 1 hour
) AS
  v_request_id NUMBER;
BEGIN
  -- Insert/update EBS Item Interface from Agile items modified since p_since_date
  INSERT INTO mtl_system_items_interface@ebs_link (
    segment1,
    description,
    primary_uom_code,
    item_type,
    transaction_type,
    set_process_id,
    process_flag,
    organization_id
  )
  SELECT
    ai.item_number,
    ai.description,
    COALESCE(ai.unit_of_measure, 'EA'),
    CASE ai.item_class
      WHEN 'Electronic Parts' THEN 'PF'
      WHEN 'Mechanical Parts' THEN 'PF'
      WHEN 'Documentation'    THEN 'DI'
      ELSE 'PF'
    END AS item_type,
    CASE
      WHEN EXISTS (SELECT 1 FROM mtl_system_items_b@ebs_link
                   WHERE segment1 = ai.item_number AND organization_id = 101)
      THEN 'UPDATE'
      ELSE 'CREATE'
    END AS transaction_type,
    99,   -- set_process_id: identify this batch
    1,    -- process_flag: 1 = unprocessed
    101   -- master organization_id (adjust to your EBS master org)
  FROM agile.items ai
  WHERE ai.modified_date >= p_since_date
    AND ai.deleted = 'N'
    AND ai.lifecycle_phase IN ('Prototype', 'Production');  -- only send usable items

  -- Submit EBS 'Import Items' concurrent request via DB link
  -- (requires APPS.FND_REQUEST.SUBMIT_REQUEST accessible via DB link)
  v_request_id := fnd_request.submit_request@ebs_link(
    application => 'INV',
    program     => 'INCOIN',
    description => 'Agile Item Sync - ' || TO_CHAR(SYSDATE, 'YYYYMMDD HH24:MI'),
    start_time  => NULL,
    sub_request => FALSE,
    argument1   => '1',    -- all organizations
    argument2   => '99',   -- set_process_id
    argument3   => '1'     -- process_flag
  );

  COMMIT;
  DBMS_OUTPUT.PUT_LINE('Item sync submitted. EBS request ID: ' || v_request_id);

EXCEPTION
  WHEN OTHERS THEN
    ROLLBACK;
    RAISE;
END sync_items_to_ebs;
/
\`\`\`

#### Step 3: BOM Sync Procedure

\`\`\`sql
CREATE OR REPLACE PROCEDURE agile.sync_bom_to_ebs (
  p_since_date IN DATE DEFAULT SYSDATE - 1/24
) AS
BEGIN
  -- Populate BOM_BILL_OF_MATERIALS and BOM_COMPONENTS_B via interface tables
  -- Step 1: Bill headers
  INSERT INTO bom_bill_of_mtls_interface@ebs_link (
    assembly_item_segment1,
    organization_id,
    alternate_bom_designator,
    common_assembly_item_segment1,
    transaction_type,
    process_flag,
    batch_id
  )
  SELECT DISTINCT
    ai.item_number,
    101,
    NULL,   -- primary BOM (no alternate designator)
    ai.item_number,
    CASE
      WHEN EXISTS (SELECT 1 FROM bom_bill_of_materials@ebs_link b
                   JOIN mtl_system_items_b@ebs_link i ON b.assembly_item_id = i.inventory_item_id
                   WHERE i.segment1 = ai.item_number AND b.organization_id = 101)
      THEN 'UPDATE'
      ELSE 'CREATE'
    END,
    1,
    TO_NUMBER(TO_CHAR(SYSDATE,'YYYYMMDDHH24MI'))
  FROM agile.bom_structure bs
  JOIN agile.items ai ON ai.item_id = bs.parent_item_id
  WHERE bs.modified_date >= p_since_date
    AND bs.deleted = 'N';

  -- Step 2: BOM component lines
  INSERT INTO bom_inventory_comps_interface@ebs_link (
    assembly_item_segment1,
    component_item_segment1,
    organization_id,
    quantity_per_assembly,
    effectivity_date,
    disable_date,
    reference_designator,
    find_number,
    transaction_type,
    process_flag,
    batch_id
  )
  SELECT
    parent.item_number,
    child.item_number,
    101,
    bs.quantity,
    NVL(bs.effectivity_start_date, TRUNC(SYSDATE)),
    bs.effectivity_end_date,
    bs.reference_designators,
    bs.find_number,
    'CREATE',
    1,
    TO_NUMBER(TO_CHAR(SYSDATE,'YYYYMMDDHH24MI'))
  FROM agile.bom_structure bs
  JOIN agile.items parent ON parent.item_id = bs.parent_item_id
  JOIN agile.items child  ON child.item_id  = bs.child_item_id
  WHERE bs.modified_date >= p_since_date
    AND bs.deleted = 'N';

  COMMIT;

EXCEPTION
  WHEN OTHERS THEN
    ROLLBACK;
    RAISE;
END sync_bom_to_ebs;
/
\`\`\`

#### Step 4: ECO Sync Procedure

\`\`\`sql
CREATE OR REPLACE PROCEDURE agile.sync_eco_to_ebs (
  p_since_date IN DATE DEFAULT SYSDATE - 1/24
) AS
BEGIN
  -- Sync Released Agile ECOs to EBS Engineering Changes
  INSERT INTO eng_eng_changes_interface@ebs_link (
    change_notice,
    organization_id,
    description,
    status_type,
    priority_code,
    reason_code,
    transaction_type,
    process_flag
  )
  SELECT
    ac.change_number,
    101,
    SUBSTR(ac.description, 1, 240),
    11,   -- EBS status_type 11 = Implemented
    'NORMAL',
    'ECO',
    CASE
      WHEN EXISTS (SELECT 1 FROM eng_engineering_changes@ebs_link
                   WHERE change_notice = ac.change_number AND organization_id = 101)
      THEN 'UPDATE'
      ELSE 'CREATE'
    END,
    1
  FROM agile.changes ac
  WHERE ac.change_type = 'ECO'
    AND ac.status      = 'RELEASED'
    AND ac.modified_date >= p_since_date;

  COMMIT;

EXCEPTION
  WHEN OTHERS THEN
    ROLLBACK;
    RAISE;
END sync_eco_to_ebs;
/
\`\`\`

#### Step 5: Post-Sync Verification

\`\`\`sql
-- Verify items successfully imported to EBS
SELECT COUNT(*) AS processed_ok,
       SUM(CASE WHEN process_flag = 3 THEN 1 ELSE 0 END) AS errors
FROM   mtl_system_items_interface@ebs_link
WHERE  set_process_id = 99
  AND  creation_date > SYSDATE - 1;

-- Check for errors in item interface
SELECT segment1, process_flag, last_update_date,
       SUBSTR(error_explanation, 1, 200) AS error_msg
FROM   mtl_system_items_interface@ebs_link
WHERE  set_process_id = 99
  AND  process_flag   = 3  -- 3 = error
  AND  creation_date  > SYSDATE - 1
ORDER BY last_update_date DESC;

-- Verify BOM interface errors
SELECT assembly_item_segment1, process_flag,
       SUBSTR(error_explanation, 1, 200) AS error_msg
FROM   bom_bill_of_mtls_interface@ebs_link
WHERE  process_flag = 3
  AND  creation_date > SYSDATE - 1;
\`\`\`

#### Step 6: Schedule the Sync Jobs

\`\`\`sql
-- Create DBMS_SCHEDULER jobs to run sync every 30 minutes
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'AGILE.SYNC_ITEMS_JOB',
    job_type        => 'STORED_PROCEDURE',
    job_action      => 'AGILE.SYNC_ITEMS_TO_EBS',
    start_date      => SYSTIMESTAMP,
    repeat_interval => 'FREQ=MINUTELY; INTERVAL=30',
    enabled         => TRUE,
    comments        => 'Agile to EBS item master synchronization'
  );

  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'AGILE.SYNC_BOM_JOB',
    job_type        => 'STORED_PROCEDURE',
    job_action      => 'AGILE.SYNC_BOM_TO_EBS',
    start_date      => SYSTIMESTAMP + INTERVAL '5' MINUTE,
    repeat_interval => 'FREQ=MINUTELY; INTERVAL=30',
    enabled         => TRUE,
    comments        => 'Agile to EBS BOM synchronization (runs 5 min after items)'
  );
END;
/

-- Verify scheduler jobs
SELECT job_name, state, last_start_date, last_run_duration, next_run_date
FROM   all_scheduler_jobs
WHERE  owner = 'AGILE'
ORDER BY job_name;
\`\`\`

---

## Phase 8 — Performance Tuning

### 8.1 Critical Index Review

\`\`\`sql
-- Verify key indexes exist on high-traffic Agile tables
-- Items table (primary lookup)
SELECT index_name, uniqueness, status
FROM   all_indexes
WHERE  owner = 'AGILE'
  AND  table_name = 'ITEMS'
ORDER BY index_name;

-- BOM structure (critical for BOM explosion)
SELECT index_name, column_name, column_position
FROM   all_ind_columns
WHERE  index_owner = 'AGILE'
  AND  table_name  = 'BOM_STRUCTURE'
ORDER BY index_name, column_position;
\`\`\`

If the following composite indexes do not exist, create them:

\`\`\`sql
-- Primary item lookup
CREATE INDEX agile.idx_items_number
  ON agile.items (item_number)
  TABLESPACE AGILE_IDX;

-- BOM explosion (parent → children)
CREATE INDEX agile.idx_bom_parent_child_eff
  ON agile.bom_structure (parent_item_id, child_item_id, effectivity_start_date)
  TABLESPACE AGILE_IDX;

-- Where-used (children → parents)
CREATE INDEX agile.idx_bom_child_parent
  ON agile.bom_structure (child_item_id, parent_item_id)
  TABLESPACE AGILE_IDX;

-- Item modification date (for EBS sync incremental queries)
CREATE INDEX agile.idx_items_modified_date
  ON agile.items (modified_date)
  TABLESPACE AGILE_IDX;

-- Changes by status and type (for ECO sync)
CREATE INDEX agile.idx_changes_status_type
  ON agile.changes (status, change_type, modified_date)
  TABLESPACE AGILE_IDX;
\`\`\`

### 8.2 Statistics Maintenance

\`\`\`sql
-- Gather Agile schema statistics (run during maintenance window)
EXEC DBMS_STATS.GATHER_SCHEMA_STATS(
  ownname  => 'AGILE',
  cascade  => TRUE,
  degree   => 4,
  method_opt => 'FOR ALL COLUMNS SIZE AUTO'
);

-- Verify stats freshness (flag tables with stale/missing stats)
SELECT table_name,
       num_rows,
       last_analyzed,
       ROUND((SYSDATE - last_analyzed) * 24, 1) AS hours_since_analyzed
FROM   all_tables
WHERE  owner = 'AGILE'
  AND  (last_analyzed IS NULL OR last_analyzed < SYSDATE - 7)
  AND  num_rows > 10000
ORDER BY num_rows DESC;
\`\`\`

### 8.3 Result Cache for BOM Explosions

\`\`\`sql
-- Enable result cache for Agile BOM-related packages (Oracle 19c)
ALTER SYSTEM SET result_cache_max_size = 512M SCOPE=BOTH;
ALTER SYSTEM SET result_cache_mode = MANUAL SCOPE=BOTH;

-- Force-cache frequently used BOM explosion query (add RESULT_CACHE hint):
-- This is applied in Agile configuration files or via DB profile:
ALTER PROFILE "AGILE_APP_PROFILE" LIMIT
  RESULT_CACHE_MODE MANUAL;

-- Monitor result cache hit ratio
SELECT name, value
FROM   v\$result_cache_statistics
WHERE  name IN ('Find Count', 'Found Count', 'Create Count Success');
-- Hit ratio = Found Count / Find Count * 100 (aim for > 60% for BOM queries)
\`\`\`

### 8.4 WebLogic Connection Pool Monitoring

\`\`\`bash
# Monitor JDBC connection pool via WLST
/opt/oracle/middleware/12.2.1.4/oracle_common/common/bin/wlst.sh <<'WLST'
connect('weblogic', 'Weblogic_Str0ng#', 't3://agile-app-host.corp.local:7001')
serverRuntime()
cd('JDBCServiceRuntime/AgileServer1/JDBCDataSourceRuntimeMBeans/AgileDS')
print('Active connections:     ' + str(cmo.getActiveConnectionsCurrentCount()))
print('Connections High:       ' + str(cmo.getActiveConnectionsHighCount()))
print('Wait seconds high:      ' + str(cmo.getWaitingForConnectionHighCount()))
print('Connection delay ms:    ' + str(cmo.getConnectionDelayTime()))
print('Failed reserves count:  ' + str(cmo.getFailedReserveRequestCount()))
disconnect()
WLST
\`\`\`

If \`WaitingForConnectionHighCount > 0\` during normal operations, increase \`MaxCapacity\` on the JDBC data source (current: 50 → try 75 or 100, but validate DB process limit first).

---

## Phase 9 — Go-Live Checklist and Validation Matrix

### 9.1 Pre-Go-Live Checklist

\`\`\`
[ ] 1.  RMAN full backup of AGILEDB completed and restored successfully (tested)
[ ] 2.  File vault backup (rsync) tested — restore drill completed
[ ] 3.  WebLogic heap settings confirmed (AgileServer1: -Xmx16g, AdminServer: -Xmx4g)
[ ] 4.  Agile license key installed and not expiring within 90 days
[ ] 5.  EBS DB link tested from Agile DB (SELECT 1 FROM DUAL@ebs_link)
[ ] 6.  Item sync job tested end-to-end (item created in Agile, verified in EBS MTL_SYSTEM_ITEMS_B)
[ ] 7.  BOM sync job tested end-to-end (BOM created in Agile, verified in EBS BOM_BILL_OF_MATERIALS)
[ ] 8.  ECO workflow tested end-to-end (Draft → Submit → Approve → Release → Verify revision)
[ ] 9.  Email notifications tested (approver received email for test ECO)
[ ] 10. File upload and download tested from Agile Web Client (PDF, XLSX)
[ ] 11. User accounts created and roles assigned (Engineering, QA, Procurement, Manufacturing)
[ ] 12. User training completed (Engineering: item/BOM/ECO; QA: NCR/CAPA; Admin: Admin Console)
[ ] 13. Rollback procedure documented and tested (stop app server, restore from backup)
[ ] 14. Monitoring alerts configured (disk, heap, connection pool, sync job failures)
[ ] 15. Cutover timing agreed with business (ECO freeze window, ERP cutover coordination)
\`\`\`

### 9.2 Validation Matrix

| Check | Query / Command | Pass Criterion |
|-------|-----------------|----------------|
| DB version | \`SELECT version FROM v\$instance\` | 19.x.x.x.x |
| Character set | \`SELECT value FROM nls_database_parameters WHERE parameter='NLS_CHARACTERSET'\` | AL32UTF8 |
| Agile schema tables | \`SELECT COUNT(*) FROM all_tables WHERE owner='AGILE'\` | ≥ 1,800 |
| Invalid objects | \`SELECT COUNT(*) FROM all_objects WHERE owner='AGILE' AND status='INVALID'\` | 0 |
| Base classes seeded | \`SELECT COUNT(*) FROM agile.classes\` | ≥ 50 |
| File vault accessible | \`ls -la /opt/agile/filestore\` | Writable by oracle user |
| File vault disk | \`df -h /opt/agile/filestore\` | < 60% used |
| WLS AdminServer | \`curl -s -o /dev/null -w "%{http_code}" http://agile-app-host:7001/console\` | 200 or 302 |
| Agile Web Client | \`curl -s -o /dev/null -w "%{http_code}" http://agile-app-host:7001/Agile/index.html\` | 200 |
| JDBC pool active | WLST: \`cmo.getActiveConnectionsCurrentCount()\` | > 0, < MaxCapacity |
| EBS DB link | \`SELECT COUNT(*) FROM dual@ebs_link\` | 1 (no ORA- error) |
| Item sync job | \`SELECT state FROM all_scheduler_jobs WHERE job_name='AGILE.SYNC_ITEMS_JOB'\` | SCHEDULED |
| BOM sync job | \`SELECT state FROM all_scheduler_jobs WHERE job_name='AGILE.SYNC_BOM_JOB'\` | SCHEDULED |
| ECO workflow | Create/approve/release test ECO | Status = RELEASED, revision incremented |
| File attach/retrieve | Upload 1 MB PDF, download and verify | File downloads successfully |
| Stats freshness | \`SELECT MAX(SYSDATE - last_analyzed)*24 FROM all_tables WHERE owner='AGILE'\` | < 168 hours (7 days) |

### 9.3 Rollback Procedure

If go-live issues require rollback:

\`\`\`bash
# Step 1: Stop Agile Application Server
/opt/oracle/agile/domains/agile_domain/bin/stopManagedWebLogic.sh \
  AgileServer1 t3://agile-app-host.corp.local:7001 weblogic Weblogic_Str0ng#

# Step 2: Stop WebLogic AdminServer
/opt/oracle/agile/domains/agile_domain/bin/stopWebLogic.sh

# Step 3: Disable EBS DB link (prevent any further data sync)
sqlplus agile/"Agile_Str0ng_Pwd#2024"@AGILEDB <<SQL
ALTER DATABASE LINK ebs_link COMPILE;  -- force disable if DROP too slow
-- Or drop it:
DROP DATABASE LINK ebs_link;
EXIT;
SQL

# Step 4: Restore AGILE schema from RMAN backup (if data corruption occurred)
rman target sys/sys_pwd@AGILEDB <<RMAN
RUN {
  SHUTDOWN IMMEDIATE;
  STARTUP MOUNT;
  RESTORE DATABASE;
  RECOVER DATABASE;
  ALTER DATABASE OPEN RESETLOGS;
}
RMAN

# Step 5: Restore file vault from rsync backup
rsync -avz agile-backup-host.corp.local:/backup/agile/filestore/ /opt/agile/filestore/

# Step 6: Validate DB is clean (post-restore)
sqlplus agile/"Agile_Str0ng_Pwd#2024"@AGILEDB <<SQL
SELECT COUNT(*) FROM agile.items;
SELECT COUNT(*) FROM agile.changes;
EXIT;
SQL
\`\`\`

> **Rollback decision criteria**: invoke rollback if (a) the Agile application is down and cannot be restarted within 2 hours, (b) data corruption is detected in the AGILE schema, or (c) the EBS sync has written incorrect data to production EBS that cannot be reversed by a counter-update. Do not invoke rollback for user interface issues or minor configuration errors that can be corrected without a restore.
`,
};

async function main() {
  console.log('Inserting Oracle Agile PLM implementation runbook...');
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
