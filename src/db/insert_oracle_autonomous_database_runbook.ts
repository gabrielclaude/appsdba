import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Autonomous Database Operations Runbook: Provisioning, Connectivity, Scaling, and Monitoring',
  slug: 'oracle-autonomous-database-runbook',
  excerpt: 'A comprehensive DBA operations runbook for Oracle Autonomous Database covering workload selection, provisioning via OCI Console and CLI/Terraform, wallet-based connectivity, schema setup, scaling, performance monitoring, backup/restore, AI Vector Search with 23ai, cost management, and ready-to-use monitoring scripts.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-01'),
  youtubeUrl: null,
  content: `# Oracle Autonomous Database Operations Runbook: Provisioning, Connectivity, Scaling, and Monitoring

Oracle Autonomous Database (ADB) is Oracle's cloud database service that automates provisioning, patching, tuning, backup, and scaling with no manual DBA intervention required for routine maintenance tasks. Despite that automation, DBAs must still make informed architectural decisions, manage connectivity, respond to performance events, orchestrate migrations, and control costs. This runbook consolidates every operational procedure a DBA team needs across the full ADB lifecycle — from selecting the right workload type through decommissioning.

---

## Phase 1: Pre-Provisioning Planning

### 1.1 Workload Type Decision Matrix

Oracle offers six distinct ADB variants. Selecting the wrong one at provisioning time is not catastrophic (you can migrate), but it creates unnecessary rework. Use this matrix to drive the initial decision:

| Workload | Recommended ADB Type | Reason |
|---|---|---|
| Data warehouse, BI reporting | ADW (Autonomous Data Warehouse) | Hybrid Columnar Compression (HCC), parallel query, columnar optimization |
| OLTP applications | ATP (Autonomous Transaction Processing) | RAC background, OLTP-tuned optimizer |
| JSON document storage, REST APIs | AJD (Autonomous JSON Database) | SODA API, lower cost than full ATP |
| Low-code APEX applications | APEX Service | Pre-configured APEX, optimized developer UX |
| Enterprise isolation requirements | ADB-D (Dedicated Exadata Infrastructure) | Dedicated Exadata hardware, custom maintenance windows |
| On-premises data residency | ADB-C@C (Cloud@Customer) | Customer data center deployment |

### 1.2 Deployment Model: Serverless vs. Dedicated

**Serverless** is the correct choice for most workloads. The database runs on shared Exadata infrastructure managed entirely by Oracle. Billing is measured in OCPU-hours (or ECPU-hours on newer SKUs), and the database scales without touching hardware.

**Dedicated** (ADB-D) is warranted when you need:
- Complete infrastructure isolation from other tenants
- Custom maintenance windows that do not follow Oracle's fleet-wide schedule
- Custom network topology requirements (specific VCN configurations, firewall rules)
- SLA commitments that require dedicated hardware fault domains

### 1.3 Sizing Guidance

CPU sizing mistakes are less costly in ADB than in on-premises deployments because auto-scaling corrects under-provisioning dynamically. However, starting too low can cause latency spikes before auto-scaling activates.

- **Development and test:** 1 OCPU (Always Free tier provides 1 OCPU and 20 GB storage at no cost)
- **Small production:** 2–4 OCPU with auto-scaling enabled
- **Medium production:** 4–8 OCPU base with auto-scaling; auto-scaling allows the database to burst up to 3× the base OCPU count automatically
- **Large production:** size at 50–70% of expected peak load; auto-scaling covers bursts

**Storage:** Provision at 125% of current data size. ADB allocates roughly 2× the provisioned storage for redo logs, temp space, and backups held locally before offloading to Object Storage. Under-provisioning storage is a common mistake that triggers \`ORA-01536\` errors at the worst possible time.

**Auto-scaling for CPU in production is non-negotiable.** The cost ceiling is bounded: if you provision 4 OCPU and auto-scaling fires to 12 OCPU for 2 hours, you pay for 2 OCPU-hours of burst, not a continuous 12 OCPU rate.

### 1.4 Network Planning

Choose the network access model before provisioning — changing it later requires a database update and a brief connectivity interruption.

**Private endpoint (VCN-based):** Recommended for all production workloads. The ADB is assigned a private IP inside your Virtual Cloud Network subnet. It is unreachable from the public internet. Applications connect from within the VCN or via FastConnect/VPN.

**Public endpoint with Access Control List (ACL):** Acceptable for development and test. The database is reachable at a public hostname but only from IP ranges in the ACL. Keep the ACL tight — a single \`0.0.0.0/0\` entry completely defeats the purpose.

**Mutual TLS (mTLS) wallet:** The default connection method. Both the client and the database present certificates, and the credentials are bundled in a downloaded wallet ZIP. Required for Oracle drivers older than 19c.

**TLS without wallet:** Supported with Oracle driver 19c+ (including \`python-oracledb\` thin mode). Requires disabling the mTLS requirement in the ADB console. Simplifies connection string management in containerized and serverless application environments.

---

## Phase 2: Provisioning via OCI Console

### 2.1 Navigate to the ADB creation form

Oracle Cloud Console → **Oracle Database** → **Autonomous Database** → **Create Autonomous Database**

### 2.2 Fill in core parameters

Complete each field as follows:

- **Display name:** A human-readable label (e.g., \`prod-analytics-adb\`). Does not need to be unique.
- **Database name:** Alphanumeric only, no spaces, maximum 14 characters (e.g., \`ANALYTICS01\`). This becomes part of the TNS service names in the wallet.
- **Workload type:** Data Warehouse / Transaction Processing / JSON / APEX — follow the Phase 1 matrix.
- **Deployment type:** Serverless or Dedicated Infrastructure.
- **Database version:** 19c or 23ai. **23ai is recommended for all new deployments.** It includes AI Vector Search, Select AI, and the full SQL:2023 standard feature set. 19c remains available for compatibility with older application drivers.
- **ECPU count:** Minimum 2 for production. Check **Compute auto scaling** to enable burst to 3×.
- **Storage:** Set in TB. Check **Storage auto scaling** to allow automatic storage expansion without manual intervention.
- **Password:** ADMIN user password. Must be 12–30 characters, contain at least one uppercase letter, one lowercase letter, one digit, and one special character. Oracle rejects passwords matching the username.
- **Network access:** Select **Private endpoint access only** for production. Choose your VCN and subnet. For dev/test, select **Secure access from allowed IPs and VCNs only** and specify your office/VPN CIDR ranges.

### 2.3 Advanced options

Expand the **Advanced** section before clicking Create:

- **Maintenance schedule:** Select a maintenance window during off-peak hours. Oracle applies patches during this window. Leave it at the default only if you have no business-hours constraints.
- **Encryption:** Oracle-managed key (default, no additional cost or configuration) or customer-managed key using OCI Vault (BYOK). Use BYOK only if a security policy mandates it — it introduces operational risk if the key is accidentally disabled or deleted.
- **Operations Insights:** Enable this option. It connects the ADB to Oracle's long-term performance analytics platform at no additional cost, providing 60+ days of SQL performance history and capacity trend analysis beyond what the built-in Performance Hub shows.

### 2.4 Create the database

Click **Create Autonomous Database**. Provisioning completes in 2–3 minutes for Serverless. Dedicated Infrastructure provisioning takes 15–20 minutes.

### 2.5 Verify provisioning

After provisioning completes, verify each of the following before handing off to application teams:

- **Lifecycle State:** AVAILABLE (displayed in green). If it shows PROVISIONING for more than 10 minutes, check the Work Requests log for errors.
- **Connection strings tab:** Confirm that all five service names (\`_high\`, \`_medium\`, \`_low\`, \`_tp\`, \`_tpurgent\`) are populated.
- **Service console:** Click **Database Actions** (formerly Service Console) and confirm that SQL Worksheet and APEX (if applicable) are accessible. A 404 or timeout here indicates a network configuration problem.
- **Autonomous Data Guard:** If configured, verify the standby status shows AVAILABLE in a different region.

---

## Phase 3: Provisioning via OCI CLI and Terraform

Automate all production provisioning. Console-based provisioning is appropriate only for ad-hoc exploration.

### 3.1 Install and configure OCI CLI

\`\`\`bash
bash -c "\$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)"
oci setup config
# Provide: tenancy OCID, user OCID, region identifier, path to API signing key
oci iam region list   # verify connectivity and authentication
\`\`\`

### 3.2 Provision ADB via OCI CLI

\`\`\`bash
oci db autonomous-database create \
  --compartment-id <compartment_ocid> \
  --db-name MYADB \
  --display-name "My Autonomous DB" \
  --db-workload DW \
  --cpu-core-count 2 \
  --data-storage-size-in-tbs 1 \
  --admin-password "<password>" \
  --is-auto-scaling-enabled true \
  --is-auto-scaling-for-storage-enabled true \
  --db-version 23ai \
  --license-model LICENSE_INCLUDED \
  --wait-for-state AVAILABLE
\`\`\`

The \`--wait-for-state AVAILABLE\` flag blocks until provisioning completes and exits non-zero on failure, making it safe to chain in CI/CD pipelines.

### 3.3 Terraform resource block

\`\`\`hcl
resource "oci_database_autonomous_database" "adb" {
  compartment_id           = var.compartment_id
  db_name                  = "MYADB"
  display_name             = "My Autonomous DB"
  db_workload              = "DW"
  cpu_core_count           = 2
  data_storage_size_in_tbs = 1
  admin_password           = var.admin_password
  is_auto_scaling_enabled  = true
  is_auto_scaling_for_storage_enabled = true
  db_version               = "23ai"
  license_model            = "LICENSE_INCLUDED"
}

output "adb_connection_strings" {
  value = oci_database_autonomous_database.adb.connection_strings
}
\`\`\`

Store the \`admin_password\` in OCI Vault or HashiCorp Vault and inject it as a Terraform variable at plan time. Never hard-code credentials in \`.tf\` files or check them into version control.

---

## Phase 4: Downloading the Wallet and Connecting

### 4.1 Download the client credentials wallet

\`\`\`bash
oci db autonomous-database generate-wallet \
  --autonomous-database-id <adb_ocid> \
  --password "<wallet_password>" \
  --file /tmp/adb_wallet.zip
unzip /tmp/adb_wallet.zip -d /opt/oracle/wallet/myadb/
\`\`\`

The wallet ZIP contains \`tnsnames.ora\`, \`sqlnet.ora\`, \`cwallet.sso\`, \`ewallet.p12\`, and the client certificate files. Protect it with the same controls you apply to private key material.

### 4.2 Configure sqlnet.ora

Update the \`DIRECTORY\` path in the extracted \`sqlnet.ora\` to the wallet location:

\`\`\`
WALLET_LOCATION = (SOURCE = (METHOD = file) (METHOD_DATA = (DIRECTORY="/opt/oracle/wallet/myadb")))
SSL_SERVER_DN_MATCH = yes
\`\`\`

### 4.3 Set environment variables

\`\`\`bash
export TNS_ADMIN=/opt/oracle/wallet/myadb
export ORACLE_HOME=/opt/oracle/instantclient_21_9
export PATH=\${ORACLE_HOME}:\${PATH}
export LD_LIBRARY_PATH=\${ORACLE_HOME}:\${LD_LIBRARY_PATH}
\`\`\`

### 4.4 Connect via SQL*Plus

\`\`\`bash
# List available service names from the wallet
grep '^\S' \${TNS_ADMIN}/tnsnames.ora | cut -d= -f1

# Connect to the _high service (parallel query, full resources)
sqlplus ADMIN/<password>@MYADB_high

# Connection types:
# _high      — parallel, full resources, for batch and analytics
# _medium    — some parallelism, for reporting
# _low       — no parallelism, maximum concurrency, for OLTP and many concurrent users
# _tp        — transaction processing, resource managed
# _tpurgent  — high priority OLTP, bypasses queuing
\`\`\`

### 4.5 Connect via SQLcl (recommended for developers)

\`\`\`bash
sql ADMIN/<password>@MYADB_high
\`\`\`

SQLcl includes Liquibase integration, JSON output format, and the \`/format\` command for pretty-printing results. It is the preferred interactive client for ADB work.

### 4.6 Connect via Python (python-oracledb)

\`\`\`python
import oracledb

connection = oracledb.connect(
    user="ADMIN",
    password="<password>",
    dsn="MYADB_high",
    config_dir="/opt/oracle/wallet/myadb",
    wallet_location="/opt/oracle/wallet/myadb",
    wallet_password="<wallet_password>"
)
cursor = connection.cursor()
cursor.execute("SELECT banner_full FROM v$version")
print(cursor.fetchone())
\`\`\`

Use \`oracledb.create_pool()\` for any production application — never create per-request connections.

### 4.7 JDBC connection string format (Java applications)

\`\`\`
jdbc:oracle:thin:@MYADB_high?TNS_ADMIN=/opt/oracle/wallet/myadb
\`\`\`

Set the \`oracle.net.tns_admin\` system property alternatively: \`-Doracle.net.tns_admin=/opt/oracle/wallet/myadb\`.

---

## Phase 5: Initial Schema and User Setup

### 5.1 Create an application schema user

Never use the ADMIN account for application connections. ADMIN is the equivalent of SYS/SYSTEM on a traditional Oracle database — it should be used only for administrative operations.

\`\`\`sql
-- Connect as ADMIN
CREATE USER appuser IDENTIFIED BY "<password>"
  DEFAULT TABLESPACE DATA
  TEMPORARY TABLESPACE TEMP
  QUOTA UNLIMITED ON DATA;

GRANT CREATE SESSION   TO appuser;
GRANT CREATE TABLE     TO appuser;
GRANT CREATE VIEW      TO appuser;
GRANT CREATE PROCEDURE TO appuser;
GRANT CREATE SEQUENCE  TO appuser;
GRANT CREATE TRIGGER   TO appuser;
\`\`\`

For applications that only need read access, grant only \`CREATE SESSION\` and object-level \`SELECT\` privileges rather than schema-level privileges.

### 5.2 Verify tablespace configuration

ADB simplifies tablespace management. There is one user tablespace (\`DATA\`), one temp tablespace (\`TEMP\`), and the system tablespaces. You cannot create additional user tablespaces in Serverless ADB.

\`\`\`sql
SELECT tablespace_name, status, contents
FROM   dba_tablespaces
ORDER  BY tablespace_name;
\`\`\`

Expected output includes: DATA (PERMANENT), SYSAUX (PERMANENT), SYSTEM (PERMANENT), TEMP (TEMPORARY), UNDOTBS1 (UNDO).

### 5.3 Load data via Data Pump and Object Storage

For migrations from on-premises or other databases, Data Pump via Object Storage is the standard path:

\`\`\`bash
# Step 1: Export from on-premises source database
expdp system/<password>@on_prem_db schemas=HR \
  dumpfile=hr_export.dmp \
  logfile=hr_export.log \
  directory=DATA_PUMP_DIR

# Step 2: Upload the dump file to OCI Object Storage
oci os object put --bucket-name adb-import --file hr_export.dmp

# Step 3: From SQL Worksheet or SQLcl connected to ADB,
# create a credential and a Data Pump import job
\`\`\`

For CSV and flat file loads, the Database Actions SQL Worksheet supports drag-and-drop import with automatic DDL inference. This is sufficient for tables up to a few hundred MB; use Data Pump for anything larger.

---

## Phase 6: Scaling Operations

One of the primary operational advantages of ADB is that CPU scaling is online and non-disruptive. Existing sessions are not terminated and in-flight transactions are not rolled back during a scale event.

### 6.1 Manual scale-up via CLI

\`\`\`bash
oci db autonomous-database update \
  --autonomous-database-id <adb_ocid> \
  --cpu-core-count 8 \
  --wait-for-state AVAILABLE
\`\`\`

### 6.2 Manual scale-down (no downtime for serverless ADB)

\`\`\`bash
oci db autonomous-database update \
  --autonomous-database-id <adb_ocid> \
  --cpu-core-count 2
\`\`\`

Scale-down takes effect immediately. Active parallel query slaves are throttled to the new CPU count within seconds. OLTP sessions are unaffected.

### 6.3 Enable or disable auto-scaling

\`\`\`bash
# Enable auto-scaling (CPU scales up to 3x base automatically)
oci db autonomous-database update \
  --autonomous-database-id <adb_ocid> \
  --is-auto-scaling-enabled true
\`\`\`

Auto-scaling activates when CPU utilization remains above 85% for more than 3 minutes. It deactivates after CPU drops below 50% for at least 20 minutes.

### 6.4 Verify current CPU allocation from inside the database

\`\`\`sql
SELECT cpu_count FROM v$parameter WHERE name = 'cpu_count';
-- During an auto-scale event, this value changes dynamically without a database restart
\`\`\`

### 6.5 Stop and start for cost control in development environments

\`\`\`bash
# Stop the database (OCPU billing pauses; storage charges continue)
oci db autonomous-database stop --autonomous-database-id <adb_ocid>

# Start the database
oci db autonomous-database start \
  --autonomous-database-id <adb_ocid> \
  --wait-for-state AVAILABLE
\`\`\`

For Always Free instances: the database auto-pauses after 7 consecutive days of inactivity and resumes on the next connection attempt (with a 30–90 second cold start delay).

---

## Phase 7: Monitoring and Performance

### 7.1 Performance Hub (built-in console tool)

OCI Console → ADB instance → **Performance Hub**

Performance Hub provides real-time and historical ASH (Active Session History), SQL Monitoring, and wait event analysis with no additional license. ADB includes the functionality of Oracle Diagnostics Pack and Tuning Pack — features that cost extra on on-premises databases.

Key tabs:
- **ASH Analytics:** Drag the time picker to zoom into a spike. Pivot by Wait Class, SQL ID, or user.
- **SQL Monitoring:** View individual SQL execution plans for long-running statements with real-time row count feedback at each plan step.
- **Automatic Workload Repository (AWR):** ADB captures AWR snapshots automatically at 60-minute intervals with a 35-day retention period.

### 7.2 SQL Monitoring via SQL

\`\`\`sql
-- Active SQL sorted by elapsed time (last 1 hour)
SELECT sql_id, sql_text, elapsed_time/1000000 AS elapsed_sec,
       buffer_gets, disk_reads, executions
FROM   v$sql
WHERE  last_active_time > SYSDATE - 1/24
ORDER  BY elapsed_time DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

### 7.3 Active session wait analysis

\`\`\`sql
SELECT event, state, COUNT(*) AS session_count,
       ROUND(AVG(seconds_in_wait), 2) AS avg_wait_sec
FROM   v$session
WHERE  status = 'ACTIVE'
  AND  type   = 'USER'
GROUP  BY event, state
ORDER  BY session_count DESC;
\`\`\`

A large count of sessions waiting on \`enq: TM - contention\` usually indicates missing foreign key indexes. Sessions waiting on \`db file sequential read\` on ADB almost always indicate a missing index or a full-table scan that should be using the columnar cache (ADW only).

### 7.4 Auto-index activity (ADB-specific)

ADB's Automatic Indexing continuously evaluates SQL workloads and creates, validates, and drops indexes without DBA intervention:

\`\`\`sql
-- Recent auto-index actions
SELECT index_name, table_name, indexing_status, last_modified, error_message
FROM   dba_auto_index_ind_actions
ORDER  BY last_modified DESC
FETCH FIRST 20 ROWS ONLY;

-- Auto-index configuration
SELECT parameter_name, parameter_value
FROM   dba_auto_index_config;
\`\`\`

To disable auto-indexing for a specific schema (e.g., a schema managed by a separate DBA team with its own index strategy):

\`\`\`sql
EXEC DBMS_AUTO_INDEX.CONFIGURE('AUTO_INDEX_SCHEMA', 'APPUSER', FALSE);
\`\`\`

### 7.5 Storage utilization

\`\`\`sql
SELECT tablespace_name,
       ROUND(used_space * 8192 / 1024 / 1024 / 1024, 2) AS used_gb,
       ROUND(tablespace_size * 8192 / 1024 / 1024 / 1024, 2) AS allocated_gb
FROM   dba_tablespace_usage_metrics
ORDER  BY used_gb DESC;
\`\`\`

### 7.6 OCI Metrics for ADB

Monitor these key metrics in OCI Metrics Explorer or via CLI:

- \`CpuUtilization\` — percentage of provisioned OCPU in use; alarm threshold: 80% for 5 minutes
- \`StorageUtilization\` — percentage of provisioned storage used; alarm threshold: 85%
- \`CurrentLogons\` — active connections; watch for connection pool exhaustion
- \`ExecuteCount\` — SQL executions per second; baseline this during normal operation
- \`UserCalls\` — user calls per second; useful for detecting application-side retry storms

Create an OCI Alarm for critical CPU thresholds:

\`\`\`bash
oci monitoring alarm create \
  --compartment-id <compartment_ocid> \
  --display-name "ADB CPU High" \
  --metric-compartment-id <compartment_ocid> \
  --namespace oracle_autonomous_database \
  --query "CpuUtilization[5m].mean() > 80" \
  --severity CRITICAL \
  --destinations "[\"<notification_topic_ocid>\"]" \
  --is-enabled true
\`\`\`

---

## Phase 8: Backup, Restore, and Clone

ADB provides automatic daily backups with a 60-day retention period (configurable from 1 to 60 days). Backups are stored in Oracle-managed Object Storage — you do not manage backup storage or RMAN configuration.

### 8.1 Verify automatic backup status

\`\`\`bash
oci db autonomous-database list-backups \
  --autonomous-database-id <adb_ocid> \
  --query "data[*].{name:\"display-name\",type:type,state:\"lifecycle-state\",time:\"time-started\"}" \
  --output table
\`\`\`

A healthy backup list shows at least one AUTOMATIC backup per day in ACTIVE state. An ACTIVE state means the backup is valid and restorable. If you see FAILED backups for two or more consecutive days, open an OCI Service Request immediately.

### 8.2 Create a manual backup before major changes

\`\`\`bash
oci db autonomous-database-backup create \
  --autonomous-database-id <adb_ocid> \
  --display-name "Pre-migration backup $(date +%Y%m%d)" \
  --wait-for-state ACTIVE
\`\`\`

Always create a manual backup before: schema migrations, major data loads, ADB version upgrades, or any operation that modifies large volumes of data.

### 8.3 Point-in-time restore

ADB supports point-in-time recovery to any second within the backup retention window:

\`\`\`bash
oci db autonomous-database restore \
  --autonomous-database-id <adb_ocid> \
  --timestamp "2026-06-30T22:00:00.000Z" \
  --wait-for-state AVAILABLE
\`\`\`

**WARNING:** Restore is destructive. The database is replaced in-place by the restored version. All changes made after the restore timestamp are permanently lost. For non-destructive point-in-time recovery that preserves the current state, use Clone (see 8.4) instead of Restore.

### 8.4 Clone to a new ADB (non-destructive)

Cloning creates a separate independent ADB from a backup or the live database. It does not affect the source database:

\`\`\`bash
oci db autonomous-database create-from-clone \
  --compartment-id <compartment_ocid> \
  --source-id <adb_ocid> \
  --clone-type FULL \
  --db-name MYADBCLONE \
  --display-name "ADB Clone for Testing" \
  --admin-password "<password>" \
  --cpu-core-count 2 \
  --data-storage-size-in-tbs 1 \
  --wait-for-state AVAILABLE
\`\`\`

Use \`--clone-type METADATA\` to clone the schema structure without data — useful for creating skeleton environments for development. Use \`--clone-type FULL\` for testing, staging, and disaster recovery validation.

---

## Phase 9: AI Vector Search and Select AI (23ai)

ADB on 23ai includes first-class support for AI workloads: the VECTOR datatype, VECTOR_DISTANCE similarity functions, and Select AI (natural language to SQL via an LLM).

### 9.1 Create a vector table and insert embeddings

\`\`\`sql
-- Create a table with a VECTOR column (23ai only)
CREATE TABLE product_embeddings (
  product_id    NUMBER PRIMARY KEY,
  product_name  VARCHAR2(200),
  description   VARCHAR2(4000),
  embedding     VECTOR(1536, FLOAT32)   -- 1536 dimensions for OpenAI text-embedding-3-small
);

-- Insert a vector (embeddings are normally generated externally and inserted as arrays)
INSERT INTO product_embeddings (product_id, product_name, embedding)
VALUES (1, 'Wireless Keyboard',
        TO_VECTOR('[0.1, 0.2, 0.3, ...]'));  -- truncated for brevity
\`\`\`

The VECTOR type accepts up to 65,535 dimensions. The \`FLOAT32\` storage format balances precision and storage efficiency for most embedding models. Use \`FLOAT64\` only if your embedding model explicitly requires double-precision.

### 9.2 Similarity search using VECTOR_DISTANCE

\`\`\`sql
-- Find the 5 products most similar to a query vector
SELECT product_id, product_name,
       VECTOR_DISTANCE(embedding, :query_vector, COSINE) AS distance
FROM   product_embeddings
ORDER  BY distance ASC
FETCH FIRST 5 ROWS ONLY;
\`\`\`

Supported distance metrics: COSINE (normalized similarity), EUCLIDEAN (L2 distance), DOT (inner product), MANHATTAN (L1 distance). For most embedding model outputs, COSINE is the correct choice. Create a VECTOR index using \`CREATE VECTOR INDEX\` to accelerate similarity search on large tables (100K+ rows):

\`\`\`sql
CREATE VECTOR INDEX product_embedding_idx
ON product_embeddings(embedding)
ORGANIZATION NEIGHBOR PARTITIONS
WITH TARGET ACCURACY 95
DISTANCE COSINE;
\`\`\`

### 9.3 Enable Select AI (natural language to SQL)

Select AI connects ADB to an LLM (OCI Generative AI, OpenAI, or Cohere) and allows users to query the database in plain English:

\`\`\`sql
-- Create an AI profile pointing to OCI Generative AI
BEGIN
  DBMS_CLOUD_AI.CREATE_PROFILE(
    profile_name => 'MY_AI_PROFILE',
    attributes   => '{"provider":"oci","credential_name":"OCI_CRED",
                      "object_list":[{"owner":"APPUSER","name":"CUSTOMERS"},
                                     {"owner":"APPUSER","name":"SALES"}]}'
  );
END;
/

-- Set the active profile for the current session
EXEC DBMS_CLOUD_AI.SET_PROFILE('MY_AI_PROFILE');

-- Natural language query — returns a narrated answer in plain English
SELECT DBMS_CLOUD_AI.GENERATE(
  prompt       => 'how many customers placed orders last month',
  profile_name => 'MY_AI_PROFILE',
  action       => 'narrate'
) AS answer FROM DUAL;
\`\`\`

The \`action\` parameter controls output format: \`narrate\` returns a prose answer, \`chat\` returns a conversational response, \`showsql\` returns the generated SQL for review, and \`runsql\` executes the SQL and returns the result set directly.

---

## Phase 10: Decommissioning and Cost Management

### 10.1 Identify idle and stopped databases

\`\`\`bash
oci db autonomous-database list \
  --compartment-id <compartment_ocid> \
  --lifecycle-state STOPPED \
  --query "data[*].{name:\"display-name\",db:\"db-name\",stopped:\"time-deletion-of-free-autonomous-database\"}" \
  --output table
\`\`\`

Also check for databases in AVAILABLE state with low CPU utilization over the past 30 days using OCI Metrics Explorer — these may be candidates for scale-down or termination.

### 10.2 Terminate an ADB instance

Termination is permanent and irreversible. All data is deleted and cannot be recovered.

\`\`\`bash
# Step 1: Create a final manual backup for audit purposes
oci db autonomous-database-backup create \
  --autonomous-database-id <adb_ocid> \
  --display-name "Final backup before termination"

# Step 2: Confirm with stakeholders, then terminate
oci db autonomous-database delete \
  --autonomous-database-id <adb_ocid> \
  --wait-for-state TERMINATED
\`\`\`

Note: The final manual backup is stored in Oracle-managed Object Storage and is deleted along with the database. If you need a long-term archive, export critical data via Data Pump to customer-owned Object Storage before terminating.

### 10.3 Monitor ADB costs via OCI Cost Analysis

\`\`\`bash
# Get ADB spending summary for the last 30 days
oci usage-api usage-summary request-summarized-usages \
  --tenant-id <tenancy_ocid> \
  --time-usage-started "2026-06-01T00:00:00Z" \
  --time-usage-ended "2026-07-01T00:00:00Z" \
  --granularity DAILY \
  --group-by '[{"type":"tag","namespace":"oracle","key":"ResourceType"}]' \
  --filter '{"dimensions":[{"key":"service","value":"DATABASE"}]}'
\`\`\`

Cost optimization checklist:
- Stop development ADB instances outside business hours (8 PM – 8 AM weekdays, all weekend)
- Use Always Free tier (1 OCPU, 20 GB) for any database that exists purely for connectivity testing or driver validation
- Review auto-scaling max scale factor — if your base is 4 OCPU and auto-scaling to 12 OCPU happens every day, consider setting the base to 6 OCPU to reduce burst frequency
- Enable Storage auto-scaling rather than over-provisioning fixed storage

---

## Phase 11: Monitoring Scripts

### 11.1 Shell Script: adb_health_check.sh

\`\`\`bash
#!/bin/bash
# adb_health_check.sh — Oracle ADB health check using OCI CLI
# Required environment variables:
#   ADB_OCID        — OCID of the target Autonomous Database
#   COMPARTMENT_ID  — Compartment OCID containing the ADB
#   OCI_PROFILE     — OCI CLI profile name (from ~/.oci/config)

set -euo pipefail
ADB_OCID=\${ADB_OCID:?ADB_OCID must be set}
COMPARTMENT_ID=\${COMPARTMENT_ID:?COMPARTMENT_ID must be set}
OCI_PROFILE=\${OCI_PROFILE:-DEFAULT}

PASS="[PASS]"
WARN="[WARN]"
FAIL="[FAIL]"

echo "================================================================"
echo " Oracle ADB Health Check — $(date '+%Y-%m-%d %H:%M:%S')"
echo " ADB OCID: \${ADB_OCID}"
echo "================================================================"

# --- Lifecycle State ---
LIFECYCLE=$(oci db autonomous-database get \
  --autonomous-database-id \${ADB_OCID} \
  --profile \${OCI_PROFILE} \
  --query "data.\"lifecycle-state\"" --raw-output)
if [ "\${LIFECYCLE}" = "AVAILABLE" ]; then
  echo "\${PASS} Lifecycle state: \${LIFECYCLE}"
else
  echo "\${FAIL} Lifecycle state: \${LIFECYCLE} (expected AVAILABLE)"
fi

# --- CPU Utilization (last 5 minutes average) ---
CPU_UTIL=$(oci monitoring metric-data summarize-metrics-data \
  --compartment-id \${COMPARTMENT_ID} \
  --profile \${OCI_PROFILE} \
  --namespace oracle_autonomous_database \
  --query-text "CpuUtilization[5m].mean()" \
  --query "data[0].\"aggregated-datapoints\"[-1].value" --raw-output 2>/dev/null || echo "N/A")
if [ "\${CPU_UTIL}" = "N/A" ]; then
  echo "\${WARN} CPU utilization: unable to retrieve metric"
elif (( $(echo "\${CPU_UTIL} > 85" | bc -l) )); then
  echo "\${FAIL} CPU utilization: \${CPU_UTIL}% (threshold: 85%)"
elif (( $(echo "\${CPU_UTIL} > 70" | bc -l) )); then
  echo "\${WARN} CPU utilization: \${CPU_UTIL}% (threshold: 70%)"
else
  echo "\${PASS} CPU utilization: \${CPU_UTIL}%"
fi

# --- Storage Utilization ---
STORAGE_UTIL=$(oci monitoring metric-data summarize-metrics-data \
  --compartment-id \${COMPARTMENT_ID} \
  --profile \${OCI_PROFILE} \
  --namespace oracle_autonomous_database \
  --query-text "StorageUtilization[5m].mean()" \
  --query "data[0].\"aggregated-datapoints\"[-1].value" --raw-output 2>/dev/null || echo "N/A")
if [ "\${STORAGE_UTIL}" = "N/A" ]; then
  echo "\${WARN} Storage utilization: unable to retrieve metric"
elif (( $(echo "\${STORAGE_UTIL} > 85" | bc -l) )); then
  echo "\${FAIL} Storage utilization: \${STORAGE_UTIL}% (threshold: 85%)"
elif (( $(echo "\${STORAGE_UTIL} > 75" | bc -l) )); then
  echo "\${WARN} Storage utilization: \${STORAGE_UTIL}% (threshold: 75%)"
else
  echo "\${PASS} Storage utilization: \${STORAGE_UTIL}%"
fi

# --- Last Backup Status ---
LAST_BACKUP_STATE=$(oci db autonomous-database list-backups \
  --autonomous-database-id \${ADB_OCID} \
  --profile \${OCI_PROFILE} \
  --query "data[?\"lifecycle-state\"=='ACTIVE'] | sort_by(@, &\"time-started\") | [-1].\"lifecycle-state\"" \
  --raw-output 2>/dev/null || echo "NONE")
if [ "\${LAST_BACKUP_STATE}" = "ACTIVE" ]; then
  echo "\${PASS} Last backup state: ACTIVE"
else
  echo "\${FAIL} Last backup state: \${LAST_BACKUP_STATE} (no ACTIVE backup found)"
fi

# --- Auto-Scaling State ---
AUTO_SCALE=$(oci db autonomous-database get \
  --autonomous-database-id \${ADB_OCID} \
  --profile \${OCI_PROFILE} \
  --query "data.\"is-auto-scaling-enabled\"" --raw-output)
if [ "\${AUTO_SCALE}" = "true" ]; then
  echo "\${PASS} Auto-scaling: enabled"
else
  echo "\${WARN} Auto-scaling: disabled (recommended for production)"
fi

echo "================================================================"
echo " Health check complete."
echo "================================================================"
\`\`\`

### 11.2 SQL Script: adb_performance_snapshot.sql

\`\`\`sql
-- adb_performance_snapshot.sql
-- Oracle ADB Performance Snapshot — run via SQLcl and pipe output to a dated file
-- Usage: sql ADMIN/<password>@\${ADB_SERVICE} @adb_performance_snapshot.sql >> \${REPORT_DIR}/perf_\$(date +%Y%m%d).log

SET PAGESIZE 200
SET LINESIZE 180
SET TRIMSPOOL ON
SET FEEDBACK OFF
SET ECHO OFF

PROMPT ================================================================
PROMPT  Oracle ADB Performance Snapshot
PROMPT  Generated: &&_DATE
PROMPT ================================================================

PROMPT
PROMPT --- SECTION 1: Top 20 SQL by Elapsed Time (Last Hour) ----------

SELECT sql_id,
       SUBSTR(sql_text, 1, 80)      AS sql_text_snippet,
       ROUND(elapsed_time/1000000, 2) AS elapsed_sec,
       executions,
       ROUND(elapsed_time/1000000 / NULLIF(executions,0), 4) AS avg_sec_per_exec,
       buffer_gets,
       disk_reads
FROM   v\$sql
WHERE  last_active_time > SYSDATE - 1/24
  AND  executions       > 0
ORDER  BY elapsed_time DESC
FETCH FIRST 20 ROWS ONLY;

PROMPT
PROMPT --- SECTION 2: Active Session Wait Events ----------------------

SELECT event,
       state,
       COUNT(*)                         AS session_count,
       ROUND(AVG(seconds_in_wait), 2)   AS avg_wait_sec,
       MAX(seconds_in_wait)             AS max_wait_sec
FROM   v\$session
WHERE  status = 'ACTIVE'
  AND  type   = 'USER'
GROUP  BY event, state
ORDER  BY session_count DESC;

PROMPT
PROMPT --- SECTION 3: Auto-Index Recent Actions (Last 7 Days) ---------

SELECT index_name,
       table_name,
       table_owner,
       indexing_status,
       TO_CHAR(last_modified, 'YYYY-MM-DD HH24:MI') AS last_modified,
       error_message
FROM   dba_auto_index_ind_actions
WHERE  last_modified > SYSDATE - 7
ORDER  BY last_modified DESC
FETCH FIRST 30 ROWS ONLY;

PROMPT
PROMPT --- SECTION 4: Auto-Index Configuration -----------------------

SELECT parameter_name, parameter_value
FROM   dba_auto_index_config
ORDER  BY parameter_name;

PROMPT
PROMPT --- SECTION 5: Tablespace Storage Utilization -----------------

SELECT tablespace_name,
       ROUND(used_space * 8192 / 1073741824, 2)       AS used_gb,
       ROUND(tablespace_size * 8192 / 1073741824, 2)  AS allocated_gb,
       ROUND(used_percent, 1)                          AS used_pct
FROM   dba_tablespace_usage_metrics
ORDER  BY used_gb DESC;

PROMPT
PROMPT ================================================================
PROMPT  End of Performance Snapshot
PROMPT ================================================================
EXIT
\`\`\`

### 11.3 Shell Script: adb_daily_report.sh

\`\`\`bash
#!/bin/bash
# adb_daily_report.sh — Daily ADB performance report
# Required environment variables:
#   TNS_ADMIN       — Path to wallet directory
#   ADB_SERVICE     — TNS service name (e.g., MYADB_low)
#   ADMIN_PASSWORD  — ADMIN user password
#   REPORT_DIR      — Directory to store report files
#   NOTIFY_ENDPOINT — OCI Notifications HTTPS endpoint URL

set -euo pipefail
TNS_ADMIN=\${TNS_ADMIN:?TNS_ADMIN must be set}
ADB_SERVICE=\${ADB_SERVICE:?ADB_SERVICE must be set}
ADMIN_PASSWORD=\${ADMIN_PASSWORD:?ADMIN_PASSWORD must be set}
REPORT_DIR=\${REPORT_DIR:?REPORT_DIR must be set}
NOTIFY_ENDPOINT=\${NOTIFY_ENDPOINT:-""}

DATESTAMP=$(date '+%Y%m%d')
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
REPORT_FILE="\${REPORT_DIR}/adb_perf_\${DATESTAMP}.log"
SCRIPT_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "\${REPORT_DIR}"

echo "Running ADB daily performance snapshot at \${TIMESTAMP}..."

# Run the SQL performance snapshot via SQLcl
export TNS_ADMIN
sql -S ADMIN/"\${ADMIN_PASSWORD}"@"\${ADB_SERVICE}" \
  @"\${SCRIPT_DIR}/adb_performance_snapshot.sql" >> "\${REPORT_FILE}" 2>&1

echo "Report appended to \${REPORT_FILE}"

# Build a short summary for notification
REPORT_LINES=$(wc -l < "\${REPORT_FILE}")
SUMMARY="ADB Daily Report - \${TIMESTAMP} | Report file: \${REPORT_FILE} | Total lines: \${REPORT_LINES}"

# Send notification via OCI Notifications endpoint if configured
if [ -n "\${NOTIFY_ENDPOINT}" ]; then
  curl -s -X POST "\${NOTIFY_ENDPOINT}" \
    -H "Content-Type: application/json" \
    -d "{\"subject\":\"ADB Daily Report \${DATESTAMP}\",\"body\":\"\${SUMMARY}\"}" \
    && echo "Notification sent to OCI Notifications endpoint." \
    || echo "WARNING: Notification delivery failed."
fi

echo "Done."
\`\`\`

---

## Quick Reference

### ADB Service Name Suffixes

| Suffix | Parallelism | Resource Priority | Recommended Use |
|---|---|---|---|
| \`_high\` | Full parallel | High | Batch loads, heavy analytics, single-user reporting |
| \`_medium\` | Partial parallel | Medium | Interactive BI tools, multi-user reporting |
| \`_low\` | None | Low | Maximum concurrency, OLTP, many short transactions |
| \`_tp\` | None | Transaction Processing managed | General OLTP applications |
| \`_tpurgent\` | None | Highest | Time-sensitive OLTP that must bypass queuing |

Connection pool applications (connection pools serving hundreds of application threads) should always connect via \`_low\` or \`_tp\` to avoid resource group starvation. Analytics and ETL jobs should use \`_high\`.

### Key OCI CLI Commands for ADB

| Operation | OCI CLI Command |
|---|---|
| Create ADB | \`oci db autonomous-database create\` |
| Scale CPU/storage | \`oci db autonomous-database update --cpu-core-count N\` |
| Stop ADB | \`oci db autonomous-database stop\` |
| Start ADB | \`oci db autonomous-database start\` |
| Delete ADB | \`oci db autonomous-database delete\` |
| Download wallet | \`oci db autonomous-database generate-wallet\` |
| List backups | \`oci db autonomous-database list-backups\` |
| Point-in-time restore | \`oci db autonomous-database restore --timestamp\` |
| Clone ADB | \`oci db autonomous-database create-from-clone\` |
| Get ADB details | \`oci db autonomous-database get\` |

### Key ADB-Specific Database Views

| View | Purpose |
|---|---|
| \`DBA_AUTO_INDEX_IND_ACTIONS\` | History of auto-index create, validate, and drop events |
| \`DBA_AUTO_INDEX_CONFIG\` | Current auto-indexing configuration parameters |
| \`V\$PDBS\` | ADB runs as a PDB internally; this view shows PDB status |
| \`DBA_TABLESPACE_USAGE_METRICS\` | Current storage usage by tablespace in 8KB blocks |
| \`V\$SQL\` | Library cache SQL performance statistics |
| \`V\$SESSION\` | Active session details and wait events |

### Key DBMS Packages Available in ADB

| Package | Purpose |
|---|---|
| \`DBMS_CLOUD\` | Load data from Object Storage, call REST APIs, manage credentials |
| \`DBMS_CLOUD_AI\` | Select AI profile management and natural language query generation |
| \`DBMS_VECTOR\` | Vector index management and embedding utilities |
| \`DBMS_DATA_MINING\` | In-database machine learning model training and scoring |
| \`DBMS_AUTO_INDEX\` | Configure and control the automatic indexing subsystem |
| \`DBMS_DATAPUMP\` | Programmatic Data Pump import/export for migrations |

### Always Free Tier Limits

- **CPU:** 1 OCPU per instance
- **Storage:** 20 GB per instance
- **Instances:** Maximum 2 Always Free ADB instances per tenancy
- **Auto-pause:** Database automatically pauses after 7 consecutive days of inactivity
- **Resume:** Resumes on the next connection attempt (30–90 second cold start)
- **Cannot be upgraded** to paid without reprovisioning

### Connecting Without a Wallet (TLS 1.2, No mTLS)

For containerized applications and serverless functions where distributing a wallet ZIP is impractical:

1. In the OCI Console: ADB instance → **Network** → **Edit** → **Mutual TLS Authentication** → set to **Disabled**
2. Use a standard JDBC thin URL or python-oracledb connection string with the TLS hostname from the ADB connection strings tab
3. Requires Oracle JDBC 21.1+ or python-oracledb 1.0+ in thin mode
4. The connection is still encrypted with TLS 1.2; only the client certificate requirement is removed
5. Re-enable mTLS if you move the database to production or if a security audit requires mutual authentication
`,
};

async function main() {
  console.log('Inserting Oracle Autonomous Database runbook...');
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
