import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Siebel CRM Implementation Runbook: Server Configuration, Schema, AOM Tuning, and EAI Integration',
  slug: 'oracle-siebel-crm-implementation-runbook',
  excerpt:
    'Step-by-step premium runbook for implementing Oracle Siebel CRM: Oracle Database 19c prerequisites and tablespace setup, Siebel schema DDL installation and seed data load, Gateway Server and Enterprise registration, Application Object Manager sizing and configuration, Siebel Web Server Extension setup, SRF repository deployment, EAI outbound and AQ-based inbound integration, EBS account sync procedures, performance tuning (cursor_sharing, indexes, nightly stats), upgrade path from 8.1.1.x to IP 2019/2021, and a complete go-live checklist with validation matrix.',
  category: 'oracle-siebel' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-17'),
  youtubeUrl: null,
  content: `## Environment Assumptions

| Component | Value |
|-----------|-------|
| Siebel Version | Innovation Pack 2019 (IP 2019) |
| Oracle Database | 19c (19.22 RU) |
| OS | Oracle Linux 8.x (x86_64) |
| Siebel DB Host | siebel-db-host.corp.local |
| Siebel App Host | siebel-app-host.corp.local |
| Siebel DB Service | SIEBELDB |
| Siebel Schema User | SIEBEL |
| Siebel Enterprise | SiebelEnterprise |
| EBS DB Service | EBSPROD |
| Gateway Port | 2320 |
| SISNAPI Port | 2321 |

---

## Phase 1 — Database Prerequisites and Siebel Schema Installation

### 1.1 Oracle DB Requirements Check

\`\`\`sql
-- Verify DB version (19c minimum for Siebel IP 2019+)
SELECT version FROM v\$instance;

-- NLS settings — Siebel requires AL32UTF8
SELECT value FROM nls_database_parameters WHERE parameter = 'NLS_CHARACTERSET';

-- Required init.ora parameters for Siebel
-- cursor_sharing = EXACT (Siebel does NOT work with SIMILAR or FORCE)
-- optimizer_features_enable = 19.1.0
-- _b_tree_bitmap_plans = FALSE
-- open_cursors = 1000
-- processes = 500
-- sessions = 750 (1.1 * processes + 5)
-- undo_retention = 7200
-- db_block_size = 8192
SHOW PARAMETER cursor_sharing;
SHOW PARAMETER open_cursors;
\`\`\`

> **Critical**: \`cursor_sharing = EXACT\` is non-negotiable for Siebel. Siebel generates bind-variable SQL internally and relies on exact literal matching in the cursor cache. Setting \`SIMILAR\` or \`FORCE\` causes plan instability and random ORA-01000 (maximum open cursors exceeded) errors under load.

### 1.2 Tablespace Creation

\`\`\`sql
-- Siebel data tablespace (start 20GB, autoextend to 200GB)
CREATE TABLESPACE SIEBEL
  DATAFILE '/oradata/SIEBELDB/siebel01.dbf' SIZE 20G
  AUTOEXTEND ON NEXT 2G MAXSIZE 200G
  EXTENT MANAGEMENT LOCAL UNIFORM SIZE 1M
  SEGMENT SPACE MANAGEMENT AUTO;

-- Index tablespace
CREATE TABLESPACE SIEBEL_IDX
  DATAFILE '/oradata/SIEBELDB/siebel_idx01.dbf' SIZE 10G
  AUTOEXTEND ON NEXT 1G MAXSIZE 100G
  EXTENT MANAGEMENT LOCAL UNIFORM SIZE 512K
  SEGMENT SPACE MANAGEMENT AUTO;

-- Temp tablespace for Siebel user
CREATE TEMPORARY TABLESPACE SIEBEL_TEMP
  TEMPFILE '/oradata/SIEBELDB/siebel_temp01.dbf' SIZE 4G
  AUTOEXTEND ON NEXT 1G MAXSIZE 32G;
\`\`\`

Verify tablespace creation:

\`\`\`sql
SELECT tablespace_name, status, contents, extent_management, block_size
FROM dba_tablespaces
WHERE tablespace_name IN ('SIEBEL', 'SIEBEL_IDX', 'SIEBEL_TEMP')
ORDER BY tablespace_name;
\`\`\`

### 1.3 Siebel DB User Creation

\`\`\`sql
CREATE USER SIEBEL IDENTIFIED BY "<secure_password>"
  DEFAULT TABLESPACE SIEBEL
  TEMPORARY TABLESPACE SIEBEL_TEMP
  QUOTA UNLIMITED ON SIEBEL
  QUOTA UNLIMITED ON SIEBEL_IDX;

GRANT CREATE SESSION, CREATE TABLE, CREATE VIEW, CREATE SEQUENCE,
      CREATE PROCEDURE, CREATE TRIGGER, CREATE TYPE,
      CREATE SYNONYM, CREATE MATERIALIZED VIEW TO SIEBEL;
GRANT SELECT ON SYS.V_\$SESSION TO SIEBEL;
GRANT SELECT ON SYS.V_\$SQL TO SIEBEL;
GRANT EXECUTE ON SYS.DBMS_LOCK TO SIEBEL;
\`\`\`

Verify the user:

\`\`\`sql
SELECT username, default_tablespace, temporary_tablespace, account_status
FROM dba_users
WHERE username = 'SIEBEL';
\`\`\`

### 1.4 Siebel Schema DDL

Run Siebel schema DDL from installation media:

\`\`\`bash
# From Siebel Database Server installation directory
cd \${SIEBEL_ROOT}/dbsrvr/oracle

# Run schema DDL (creates ~2,300 base tables)
sqlplus SIEBEL/<password>@SIEBELDB @ddlinit.sql

# Verify table count
sqlplus -S SIEBEL/<password>@SIEBELDB << 'SQL'
SELECT COUNT(*) FROM user_tables;
-- Expected: 2200-2400 tables for full Siebel install
SQL

# Run indexes
sqlplus SIEBEL/<password>@SIEBELDB @indexes_ora.sql
\`\`\`

Monitor progress during DDL execution — the \`ddlinit.sql\` script logs to a spool file in the current directory. A clean run produces zero ORA- errors in the spool file:

\`\`\`bash
grep -i "ORA-" \${SIEBEL_ROOT}/dbsrvr/oracle/ddlinit.log | wc -l
# Expected: 0
\`\`\`

### 1.5 Seed Data Load

\`\`\`bash
# Load Siebel seed data (system configuration, list of values, base workflows)
\${SIEBEL_ROOT}/bin/dataimp.exe /u SIEBEL /p <password> /c "DSN=SIEBELDB" \
  /f \${SIEBEL_ROOT}/dbsrvr/common/seed_data.dat /e Y /x Y

# Verify seed data
sqlplus -S SIEBEL/<password>@SIEBELDB << 'SQL'
SELECT COUNT(*) FROM SIEBEL.S_LST_OF_VAL;    -- List of values: expect 15,000+
SELECT COUNT(*) FROM SIEBEL.S_REPOSITORY;     -- Repository: expect 1 row (seed SRF)
SQL
\`\`\`

If the seed data load reports errors, check the \`dataimp.log\` in the working directory. Common cause: \`NLS_LANG\` environment variable mismatch — set \`NLS_LANG=AMERICAN_AMERICA.AL32UTF8\` before running \`dataimp\`.

---

## Phase 2 — Siebel Gateway Server Installation

### 2.1 Prerequisites

\`\`\`bash
# OS requirements (Linux 8.x or RHEL 8.x)
ulimit -n 65536
ulimit -u 16384

# Verify JAVA_HOME for Siebel Gateway
java -version  # Requires JDK 11.x (Siebel IP 2019+) or JDK 17 (IP 2023)

# Create Siebel OS user and directories
useradd -m -s /bin/bash siebel
mkdir -p /opt/oracle/siebel/{ses,gtwysrvr,swse}
chown -R siebel:siebel /opt/oracle/siebel
\`\`\`

Add the following to \`/etc/security/limits.conf\` for the siebel OS user:

\`\`\`
siebel soft nofile 65536
siebel hard nofile 65536
siebel soft nproc 16384
siebel hard nproc 16384
\`\`\`

### 2.2 Gateway Server Configuration

\`\`\`bash
# Source Siebel environment
su - siebel
source \${SIEBEL_ROOT}/gtwysrvr/bin/siebenv.sh

# Start Gateway Server
\${SIEBEL_ROOT}/gtwysrvr/bin/start_ns

# Verify Gateway is listening on port 2320 (default)
netstat -tlnp | grep 2320
\`\`\`

Expected output from \`netstat\`:

\`\`\`
tcp  0  0 0.0.0.0:2320  0.0.0.0:*  LISTEN  <pid>/siebnsrvr
\`\`\`

If the port is not open, review \`\${SIEBEL_ROOT}/gtwysrvr/log/siebnsrvr.log\` for startup errors.

### 2.3 Siebel Enterprise Registration

\`\`\`bash
# Register the Siebel Enterprise via Server Manager
\${SIEBEL_ROOT}/ses/siebsrvr/bin/srvrmgr \
  /g localhost /e SiebelEnterprise /u SADMIN /p <sadmin_password>

# At srvrmgr prompt:
# configure enterprise parameter AutoStopCmpOnError = TRUE
# configure enterprise parameter MaxMTServers = 10
\`\`\`

After registering the enterprise, start the first Siebel Server (SES):

\`\`\`bash
\${SIEBEL_ROOT}/ses/siebsrvr/bin/start_server
\`\`\`

Verify all system components start cleanly:

\`\`\`bash
# In srvrmgr:
list comp status
# All system components (FSMSrvr, SCBroker, SRBroker, etc.) should show Running
\`\`\`

---

## Phase 3 — Application Object Manager (AOM) Configuration

### 3.1 AOM Process Sizing

The Application Object Manager is the middle-tier process handling user sessions. Each AOM process is multi-threaded:

- **MinMTServers**: minimum AOM processes to keep running (warm standby)
- **MaxMTServers**: maximum AOM processes (scale ceiling)
- **MaxTasks**: maximum concurrent user sessions per AOM process (typically 50–100)

Sizing formula:

\`\`\`
MinMTServers = CEIL(expected_concurrent_users / MaxTasks / 2)
MaxMTServers = CEIL(peak_concurrent_users / MaxTasks) + 2
\`\`\`

Example for 500 concurrent users, MaxTasks=50:

\`\`\`
MinMTServers = CEIL(500/50/2) = 5
MaxMTServers = CEIL(500/50) + 2 = 12
\`\`\`

> **Sizing note**: Do not set MaxMTServers too high on a shared server. Each AOM process consumes 1.5–3 GB of RAM (see Phase 3.3). Over-allocating MaxMTServers causes the OS to swap, which is catastrophic for Siebel response times.

### 3.2 AOM Configuration via Server Manager

\`\`\`bash
# Connect to Server Manager
srvrmgr /g <gateway_host> /e SiebelEnterprise /s <siebel_server> \
        /u SADMIN /p <sadmin_password>

# Configure Sales AOM
change param MinMTServers=5 for comp SCCObjMgr_enu
change param MaxMTServers=12 for comp SCCObjMgr_enu
change param MaxTasks=50 for comp SCCObjMgr_enu
change param DSSSOEnable=FALSE for comp SCCObjMgr_enu

# Configure Service AOM
change param MinMTServers=5 for comp SSEObjMgr_enu
change param MaxMTServers=12 for comp SSEObjMgr_enu
change param MaxTasks=50 for comp SSEObjMgr_enu

# Show all components and status
list comp status
\`\`\`

After changing parameters, restart the component to pick up the new values:

\`\`\`bash
# In srvrmgr:
shutdown comp SCCObjMgr_enu
start comp SCCObjMgr_enu
list comp status for comp SCCObjMgr_enu
\`\`\`

### 3.3 Memory Planning

Each AOM process consumes approximately 1.5–3 GB of RAM depending on repository size and session load. For 12 MaxMTServers:

\`\`\`
Estimated RAM for AOMs = 12 × 2.5 GB = 30 GB
Add Siebel Server base = 4 GB
Add OS overhead        = 4 GB
Minimum server RAM     = 38 GB (round to 48 GB for headroom)
\`\`\`

Monitor actual AOM memory usage in production and adjust MaxMTServers accordingly:

\`\`\`bash
# Check per-process memory for siebmtsh (AOM worker) processes
ps -eo pid,rss,comm | grep siebmtsh | awk '{total += \$2} END {print "Total RSS (KB):", total}'
\`\`\`

---

## Phase 4 — Siebel Web Server Extension (SWE) Setup

### 4.1 Apache Configuration

\`\`\`bash
# Install Apache 2.4 (or use existing IIS on Windows)
dnf install httpd -y

# Copy SWE plugin from Siebel SWSE install
cp \${SIEBEL_ROOT}/swse/lib/libswepl.so /etc/httpd/modules/

# Add to /etc/httpd/conf/httpd.conf:
# LoadModule swepl_module modules/libswepl.so
# <Location /sales_enu>
#   SetHandler swepl-handler
#   SWEServer <siebel_server_host>
#   SWEPort 2321
#   SWEConnectTimeout 10
# </Location>

# Restart Apache
systemctl restart httpd

# Verify SWE is responding
curl -I http://localhost/sales_enu/start.swe?SWECmd=GetSessionInfo
\`\`\`

Expected response: \`HTTP/1.1 200 OK\` with a Siebel session cookie in the response headers. An ORA- or "Server Unavailable" page indicates the SWE cannot reach the AOM on port 2321.

### 4.2 SWE Connection Pool

Key parameters in \`\${SIEBEL_ROOT}/swse/config/eapps.cfg\`:

\`\`\`
ConnectString = siebel.TCPIP.none.none://<siebel_server>:2321/SiebelEnterprise/SCCObjMgr_enu
MaxPoolSize   = 50      # Max pooled SISNAPI connections per SWE process
MinPoolSize   = 5
PoolTimeout   = 600     # Seconds idle connection is kept in pool
\`\`\`

> **MaxPoolSize guidance**: Set \`MaxPoolSize\` to at least the number of concurrent browser sessions expected per SWE instance. Each active Siebel browser session holds one SISNAPI connection. If \`MaxPoolSize\` is exceeded, new logins receive a "Server Busy" error.

### 4.3 SWE Load Balancing (Multi-Server)

For high-availability deployments, configure a hardware load balancer (F5, A10) or Apache \`mod_proxy_balancer\` in front of multiple SWE instances:

\`\`\`
<Proxy "balancer://siebel_cluster">
  BalancerMember http://swse-host1.corp.local route=swse1
  BalancerMember http://swse-host2.corp.local route=swse2
  ProxySet stickysession=WEB_ID
</Proxy>
ProxyPass /sales_enu balancer://siebel_cluster/sales_enu
\`\`\`

Session stickiness (\`WEB_ID\` cookie) is required because Siebel's SISNAPI session state is maintained on the specific SWE instance that created the session.

---

## Phase 5 — Repository File (SRF) Deployment

### 5.1 Siebel Tools Compile

Siebel Tools (Windows) compiles all repository customizations into the SRF:

\`\`\`
1. Open Siebel Tools → Repository → siebel.srf
2. Apply all pending customizations (applets, views, workflows, BCs)
3. Tools → Compile → Full Compile
   - Output: siebel.srf (typically 200-800 MB for heavily customized repos)
4. Copy siebel.srf to Siebel Server:
   scp siebel.srf siebel@siebelapp:/opt/oracle/siebel/ses/siebsrvr/objects/enu/siebel.srf
5. Restart AOMs to pick up new SRF
\`\`\`

Always take a backup of the current SRF before deploying a new one:

\`\`\`bash
TIMESTAMP=\$(date +%Y%m%d_%H%M%S)
cp \${SIEBEL_ROOT}/ses/siebsrvr/objects/enu/siebel.srf \
   /backup/siebel/siebel_pre_deploy_\${TIMESTAMP}.srf
\`\`\`

### 5.2 Repository Verification

\`\`\`sql
-- Verify SRF version in database
SELECT repo_name, version_str, created
FROM SIEBEL.S_REPOSITORY
ORDER BY created DESC;

-- Check for invalid workflow processes after SRF change
SELECT name, status
FROM SIEBEL.S_WFR_DEFN
WHERE status = 'In Error';
\`\`\`

A non-zero count of workflows in "In Error" status after deploying a new SRF indicates a customization conflict or missing object reference. Resolve in Siebel Tools before proceeding to production deployment.

### 5.3 Workflow Activation

\`\`\`sql
-- Activate workflows via Siebel UI (Siebel Admin → Business Process → Workflow)
-- Or verify active workflows:
SELECT name, status, activation_dt
FROM SIEBEL.S_WFR_DEFN
WHERE status = 'Active'
ORDER BY name;

-- Check running workflow instances
SELECT COUNT(*), status
FROM SIEBEL.S_WFR_INST
GROUP BY status;
\`\`\`

Workflows must be individually activated in the Siebel UI after every SRF deployment — compiling the SRF alone does not re-activate workflows that were active before. Build a checklist of all business-critical workflows and verify activation status as part of every deployment.

---

## Phase 6 — Siebel EAI Integration Setup

### 6.1 Integration Object Definition

Integration Objects define the XML schema for data exchange. Created in Siebel Tools:

\`\`\`
1. Tools → New Object Wizard → Integration Object
2. Source BC: Account BC (maps to S_ACCOUNT)
3. Select fields: Name, Type, Revenue, Primary Address
4. Generate Integration Object XML Schema
\`\`\`

After creating the Integration Object in Siebel Tools, recompile the SRF and redeploy. The Integration Object will not be available to EAI workflows until the SRF containing it is active on the Siebel Server.

### 6.2 Outbound EAI Workflow (Siebel → External)

\`\`\`
Workflow: Account Sync to EBS
  Step 1: Start (On Record Update event on Account BC)
  Step 2: Siebel EAI Adapter (Read Account Integration Object)
  Step 3: EAI XML Converter (serialize to XML)
  Step 4: EAI HTTP Transport (POST to EBS interface endpoint)
  Step 5: Error handling branch → log to S_SY_ERROR_LOG
\`\`\`

Key workflow properties:

\`\`\`
EAI HTTP Transport URL: http://ebs-host:8010/webservices/AccountImport
Method: SendReceive
RequestMsgType: Siebel Message
\`\`\`

Verify the workflow runs after activation by monitoring \`S_SY_ERROR_LOG\`:

\`\`\`sql
SELECT created, error_msg, wf_proc_name
FROM SIEBEL.S_SY_ERROR_LOG
WHERE created > SYSDATE - 1/24
ORDER BY created DESC;
\`\`\`

### 6.3 Inbound EAI via Oracle AQ

For high-volume integration, AQ transport is more reliable than HTTP:

\`\`\`sql
-- Create AQ queue for Siebel inbound messages
BEGIN
  DBMS_AQADM.CREATE_QUEUE_TABLE(
    queue_table        => 'SIEBEL.SIEBEL_IN_QT',
    queue_payload_type => 'SYS.AQ\$_JMS_TEXT_MESSAGE'
  );
  DBMS_AQADM.CREATE_QUEUE(
    queue_name  => 'SIEBEL.SIEBEL_IN',
    queue_table => 'SIEBEL.SIEBEL_IN_QT'
  );
  DBMS_AQADM.START_QUEUE(queue_name => 'SIEBEL.SIEBEL_IN');
END;
/
\`\`\`

Configure Siebel MQ/AQ receiver component:

\`\`\`bash
# In srvrmgr:
change param AQURL=jdbc:oracle:thin:@dbhost:1521/SIEBELDB for comp MQSeriesAMIRcvr
change param AQQueue=SIEBEL_IN for comp MQSeriesAMIRcvr
start comp MQSeriesAMIRcvr
\`\`\`

Verify the AQ consumer is dequeuing:

\`\`\`sql
-- Check queue depth (should trend to 0 as consumer processes messages)
SELECT COUNT(*) AS pending_messages
FROM SIEBEL.SIEBEL_IN
WHERE msg_state = 'READY';
\`\`\`

### 6.4 EBS Account Sync Procedure

\`\`\`sql
-- Sync Siebel accounts to EBS HZ_PARTIES via DB link
CREATE OR REPLACE PROCEDURE sync_siebel_accounts_to_ebs AS
  CURSOR c_accounts IS
    SELECT row_id, name, ou_type_cd, x_revenue, last_upd
    FROM SIEBEL.S_ORG_EXT
    WHERE last_upd > (
      SELECT NVL(MAX(last_sync_date), DATE '2000-01-01')
      FROM siebel_ebs_sync_log
      WHERE object_type = 'ACCOUNT'
    )
    AND row_status_cd = 'Y';
BEGIN
  FOR r IN c_accounts LOOP
    -- Insert/update EBS HZ_PARTIES via interface table on db link
    MERGE INTO hz_parties@ebs_link p
    USING (SELECT r.row_id AS siebel_id, r.name AS party_name FROM dual) src
    ON (p.orig_system_reference = src.siebel_id)
    WHEN MATCHED THEN
      UPDATE SET p.party_name = src.party_name
    WHEN NOT MATCHED THEN
      INSERT (party_id, party_type, party_name, orig_system_reference, status)
      VALUES (hz_parties_s.nextval@ebs_link, 'ORGANIZATION',
              src.party_name, src.siebel_id, 'A');
  END LOOP;
  UPDATE siebel_ebs_sync_log
    SET last_sync_date = SYSDATE
  WHERE object_type = 'ACCOUNT';
  COMMIT;
END;
/
\`\`\`

Schedule the sync procedure:

\`\`\`sql
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'SIEBEL_ACCOUNT_SYNC',
    job_type        => 'STORED_PROCEDURE',
    job_action      => 'SYNC_SIEBEL_ACCOUNTS_TO_EBS',
    start_date      => SYSTIMESTAMP,
    repeat_interval => 'FREQ=MINUTELY; INTERVAL=30',
    enabled         => TRUE,
    comments        => 'Siebel to EBS account synchronization every 30 minutes'
  );
END;
/
\`\`\`

---

## Phase 7 — Performance Tuning

### 7.1 Critical Index Verification

\`\`\`sql
-- Siebel uses its own index naming; verify key indexes exist
SELECT index_name, table_name, uniqueness, status
FROM user_indexes
WHERE table_name IN ('S_CONTACT','S_OPTY','S_SRV_REQ','S_ACCOUNT','S_WFR_INST')
ORDER BY table_name, index_name;

-- S_CONTACT key indexes (must exist)
-- S_CONTACT_P1: (ROW_ID) UNIQUE
-- S_CONTACT_M1: (LAST_NAME, FIRST_NAME)
-- S_CONTACT_M4: (EMAIL_ADDR)

-- S_OPTY key indexes
-- S_OPTY_P1: (ROW_ID) UNIQUE
-- S_OPTY_M3: (CLOSE_DT, SALES_STAGE_CD)
\`\`\`

If any primary or foreign key indexes are missing (can happen after botched imports or partial DDL runs), rebuild them from the Siebel index script:

\`\`\`bash
sqlplus SIEBEL/<password>@SIEBELDB @\${SIEBEL_ROOT}/dbsrvr/oracle/indexes_ora.sql
\`\`\`

### 7.2 Siebel-Specific DB Parameters

\`\`\`sql
-- cursor_sharing MUST be EXACT for Siebel
ALTER SYSTEM SET cursor_sharing = EXACT;

-- Disable bitmap plans (Siebel star schema joins perform poorly with bitmap)
ALTER SYSTEM SET "_b_tree_bitmap_plans" = FALSE;

-- Siebel uses many small commits — tune log buffer
ALTER SYSTEM SET log_buffer = 32M;

-- Result cache for Siebel list-of-values queries (IP 2017+)
ALTER SYSTEM SET result_cache_max_size = 512M;
\`\`\`

Verify all parameters are in effect after restart:

\`\`\`sql
SELECT name, value, description
FROM v\$parameter
WHERE name IN (
  'cursor_sharing',
  'log_buffer',
  'result_cache_max_size',
  'open_cursors',
  'processes'
)
ORDER BY name;
\`\`\`

### 7.3 Gather Statistics Schedule

\`\`\`sql
BEGIN
  DBMS_SCHEDULER.CREATE_JOB(
    job_name        => 'SIEBEL_GATHER_STATS_NIGHTLY',
    job_type        => 'PLSQL_BLOCK',
    job_action      => 'BEGIN DBMS_STATS.GATHER_SCHEMA_STATS(
                          ownname    => ''SIEBEL'',
                          cascade    => TRUE,
                          degree     => 4,
                          options    => ''GATHER STALE''
                        ); END;',
    start_date      => TRUNC(SYSDATE + 1) + INTERVAL '1' HOUR,
    repeat_interval => 'FREQ=DAILY;BYHOUR=1;BYMINUTE=0',
    enabled         => TRUE,
    comments        => 'Nightly Siebel schema stats gather'
  );
END;
/
\`\`\`

Verify the job is scheduled correctly:

\`\`\`sql
SELECT job_name, state, last_start_date, last_run_duration, next_run_date
FROM all_scheduler_jobs
WHERE job_name = 'SIEBEL_GATHER_STATS_NIGHTLY';
\`\`\`

### 7.4 AOM Session Monitoring

\`\`\`sql
-- Monitor active Siebel sessions in the database
SELECT s.username, s.status, s.program,
       s.module, s.action,
       ROUND(s.last_call_et/60, 1) AS idle_minutes,
       q.sql_text
FROM v\$session s
LEFT JOIN v\$sql q ON q.sql_id = s.sql_id
WHERE s.username = 'SIEBEL'
  AND s.type = 'USER'
ORDER BY idle_minutes DESC;

-- Count sessions per AOM component
SELECT module, COUNT(*) AS session_count
FROM v\$session
WHERE username = 'SIEBEL'
GROUP BY module
ORDER BY session_count DESC;
\`\`\`

> **Idle session threshold**: Siebel sessions idle for more than 30 minutes in the database while the application shows the user as active typically indicate a zombie session — the AOM process has crashed but the DB session was not cleaned up. Identify and kill them:

\`\`\`sql
-- Identify and kill zombie Siebel sessions
SELECT 'ALTER SYSTEM KILL SESSION ''' || sid || ',' || serial# || ''' IMMEDIATE;' AS kill_stmt
FROM v\$session
WHERE username = 'SIEBEL'
  AND last_call_et > 1800   -- idle > 30 minutes
  AND status = 'INACTIVE';
\`\`\`

### 7.5 Shared Pool Sizing for Siebel

Siebel's 2,300+ tables generate enormous cursor library cache pressure. Tune the shared pool accordingly:

\`\`\`sql
-- Check shared pool free memory
SELECT name, bytes/1024/1024 AS mb
FROM v\$sgastat
WHERE pool = 'shared pool'
  AND name IN ('free memory', 'library cache', 'sql area', 'row cache')
ORDER BY bytes DESC;

-- If free memory < 20% of shared pool, increase:
ALTER SYSTEM SET shared_pool_size = 4G SCOPE=BOTH;

-- Reserve pool for large allocations (Siebel SRF load)
ALTER SYSTEM SET shared_pool_reserved_size = 200M SCOPE=SPFILE;
\`\`\`

---

## Phase 8 — Upgrade Path: 8.1.1.x to IP 2019/2021

### 8.1 Pre-Upgrade Assessment

\`\`\`bash
# Run Siebel Upgrade Wizard assessment (Windows — Siebel Tools)
# Generates upgrade log showing customization conflicts

# Key items to inventory before upgrade:
# 1. Count custom BCs, applets, views
# 2. List all custom scripting (eScript/VB)
# 3. Document all workflow customizations
# 4. Identify any direct SQL customizations in workflows

sqlplus -S SIEBEL/<password>@SIEBELDB << 'SQL'
-- Count custom objects (non-seed row_ids starting with 0- or 1- are seed)
SELECT obj_type, COUNT(*) AS custom_count
FROM (
  SELECT 'BusComp' AS obj_type FROM SIEBEL.S_BUSCOMP
  WHERE ROW_ID NOT LIKE '0-%' AND ROW_ID NOT LIKE '1-%'
  UNION ALL
  SELECT 'Applet' FROM SIEBEL.S_APPLET
  WHERE ROW_ID NOT LIKE '0-%' AND ROW_ID NOT LIKE '1-%'
  UNION ALL
  SELECT 'View' FROM SIEBEL.S_VIEW
  WHERE ROW_ID NOT LIKE '0-%' AND ROW_ID NOT LIKE '1-%'
)
GROUP BY obj_type;
SQL
\`\`\`

### 8.2 Database-Level Pre-Upgrade Steps

\`\`\`sql
-- Create pre-upgrade snapshot of row counts for reconciliation
CREATE TABLE SIEBEL.UPGRADE_SNAPSHOT AS
SELECT 'S_CONTACT' AS tname, COUNT(*) AS row_count FROM SIEBEL.S_CONTACT
UNION ALL
SELECT 'S_ACCOUNT',  COUNT(*) FROM SIEBEL.S_ACCOUNT
UNION ALL
SELECT 'S_OPTY',     COUNT(*) FROM SIEBEL.S_OPTY
UNION ALL
SELECT 'S_SRV_REQ',  COUNT(*) FROM SIEBEL.S_SRV_REQ
UNION ALL
SELECT 'S_WFR_DEFN', COUNT(*) FROM SIEBEL.S_WFR_DEFN;

-- Take RMAN backup BEFORE running any upgrade scripts
-- RMAN: BACKUP DATABASE PLUS ARCHIVELOG;
\`\`\`

### 8.3 Repository Merge

\`\`\`
Upgrade Wizard steps:
1. Export current customer repository (SRF → XML export via Tools)
2. Import new seed repository for target version
3. Run Repository Merge Utility:
   - Auto-merges non-conflicting changes
   - Flags conflicts (customer change vs. seed change on same object)
4. Resolve conflicts manually in Siebel Tools
5. Recompile full SRF
6. Run upgrade scripts on database (upgrep.sql, upgreq.sql)
\`\`\`

Post-merge, run the Siebel upgrade database scripts:

\`\`\`bash
cd \${SIEBEL_ROOT}/dbsrvr/oracle/upgrade
sqlplus SIEBEL/<password>@SIEBELDB @upgrep.sql   # repository upgrade
sqlplus SIEBEL/<password>@SIEBELDB @upgreq.sql   # required upgrades

# Verify upgrade completion
sqlplus -S SIEBEL/<password>@SIEBELDB << 'SQL'
SELECT script_name, status, run_date
FROM SIEBEL.S_UPGRADES
ORDER BY run_date DESC;
SQL
\`\`\`

### 8.4 Post-Upgrade Validation

After upgrade, reconcile row counts against the pre-upgrade snapshot:

\`\`\`sql
SELECT u.tname,
       u.row_count AS pre_upgrade,
       c.current_count AS post_upgrade,
       c.current_count - u.row_count AS delta
FROM SIEBEL.UPGRADE_SNAPSHOT u
JOIN (
  SELECT 'S_CONTACT' AS tname, COUNT(*) AS current_count FROM SIEBEL.S_CONTACT
  UNION ALL
  SELECT 'S_ACCOUNT',  COUNT(*) FROM SIEBEL.S_ACCOUNT
  UNION ALL
  SELECT 'S_OPTY',     COUNT(*) FROM SIEBEL.S_OPTY
  UNION ALL
  SELECT 'S_SRV_REQ',  COUNT(*) FROM SIEBEL.S_SRV_REQ
  UNION ALL
  SELECT 'S_WFR_DEFN', COUNT(*) FROM SIEBEL.S_WFR_DEFN
) c ON c.tname = u.tname
ORDER BY u.tname;
-- Delta should be 0 or positive (upgrades never delete business data)
\`\`\`

---

## Phase 9 — Go-Live Checklist and Validation Matrix

### 9.1 Go-Live Checklist

| # | Item | Owner | Verified |
|---|------|-------|---------|
| 1 | Siebel DB RMAN backup verified and tested | DBA | ☐ |
| 2 | AOM MinMTServers/MaxMTServers set per sizing | DBA/Admin | ☐ |
| 3 | cursor_sharing=EXACT confirmed | DBA | ☐ |
| 4 | SRF deployed to all Siebel Servers | Admin | ☐ |
| 5 | All workflows activated (no In Error status) | Admin | ☐ |
| 6 | SWE load balancer health checks passing | Infra | ☐ |
| 7 | EAI outbound endpoint tested end-to-end | Integration | ☐ |
| 8 | AQ inbound queue verified and consumer running | DBA | ☐ |
| 9 | Nightly stats gather scheduled | DBA | ☐ |
| 10 | SADMIN password rotated from default | Security | ☐ |
| 11 | User responsibility assignments validated | Functional | ☐ |
| 12 | CTI connector tested (if applicable) | Infra | ☐ |
| 13 | EBS DB link connectivity tested | DBA | ☐ |
| 14 | File system (SIEBSRVR_ROOT/FS) backup included | DBA | ☐ |
| 15 | Rollback procedure documented and tested | DBA | ☐ |

### 9.2 Validation Matrix

| Check | Command / Query | Pass Criterion |
|-------|----------------|----------------|
| DB table count | \`SELECT COUNT(*) FROM user_tables WHERE owner='SIEBEL'\` | 2200–2400 |
| Seed list of values | \`SELECT COUNT(*) FROM SIEBEL.S_LST_OF_VAL\` | ≥ 15,000 |
| cursor_sharing | \`SHOW PARAMETER cursor_sharing\` | EXACT |
| Gateway listening | \`netstat -tlnp \| grep 2320\` | Port open |
| AOM running | \`list comp status\` in srvrmgr | Running state |
| Workflow errors | \`SELECT COUNT(*) FROM SIEBEL.S_WFR_DEFN WHERE status='In Error'\` | 0 |
| SWE response | \`curl -s http://swse-host/sales_enu/start.swe?SWECmd=GetSessionInfo\` | HTTP 200 |
| AQ queue depth | \`SELECT COUNT(*) FROM SIEBEL.SIEBEL_IN WHERE msg_state='READY'\` | 0 (empty after test) |
| Stats freshness | \`SELECT MAX(last_analyzed) FROM all_tables WHERE owner='SIEBEL'\` | Within 24 hours |
| Session count (load test) | \`v\$session\` query above | No idle > 30 min |
| EBS DB link | \`SELECT COUNT(*) FROM dual@ebs_link\` | 1 (no ORA- error) |
| Scheduler job | \`SELECT state FROM all_scheduler_jobs WHERE job_name='SIEBEL_ACCOUNT_SYNC'\` | SCHEDULED |
| Shared pool free | \`SELECT bytes FROM v\$sgastat WHERE name='free memory' AND pool='shared pool'\` | > 20% of shared_pool_size |

### 9.3 Rollback Procedure

\`\`\`bash
# 1. Notify users — maintenance window
# 2. Stop all AOMs
srvrmgr /g <gateway> /e SiebelEnterprise /u SADMIN /p <pwd> << 'SRVM'
shutdown comp SCCObjMgr_enu
shutdown comp SSEObjMgr_enu
SRVM

# 3. Stop Gateway Server
\${SIEBEL_ROOT}/gtwysrvr/bin/stop_ns

# 4. Restore database from RMAN backup
rman target / << 'REOF'
SHUTDOWN IMMEDIATE;
STARTUP MOUNT;
RESTORE DATABASE;
RECOVER DATABASE;
ALTER DATABASE OPEN RESETLOGS;
REOF

# 5. Restore previous SRF
cp /backup/siebel_pre_golive.srf \${SIEBEL_ROOT}/ses/siebsrvr/objects/enu/siebel.srf

# 6. Restart Gateway and AOMs
\${SIEBEL_ROOT}/gtwysrvr/bin/start_ns

srvrmgr /g <gateway> /e SiebelEnterprise /u SADMIN /p <pwd> << 'SRVM'
start comp SCCObjMgr_enu
start comp SSEObjMgr_enu
list comp status
SRVM
\`\`\`

> **Rollback decision criteria**: invoke rollback if (a) the Siebel application is down and cannot be restarted within 2 hours, (b) data corruption is detected in the SIEBEL schema, or (c) the EAI sync has written incorrect data to production EBS that cannot be reversed. Do not invoke rollback for user interface issues or minor parameter configuration errors that can be corrected without a database restore.
`,
};

async function main() {
  console.log('Inserting Oracle Siebel implementation runbook...');
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
