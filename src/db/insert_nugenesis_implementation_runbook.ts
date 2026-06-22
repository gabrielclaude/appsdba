import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Installing and Implementing NuGenesis SDMS/ELN on Oracle for Pharmaceutical Organisations',
  slug: 'nugenesis-sdms-eln-oracle-implementation-runbook',
  excerpt:
    'End-to-end implementation runbook covering Oracle prerequisite configuration, NuGenesis Server installation, instrument collection agent deployment, ELN template configuration, CSV validation execution, and post-go-live operational procedures.',
  category: 'pharma-clinical-trials' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-22'),
  youtubeUrl: null,
  content: `This runbook covers the complete Oracle DBA and NuGenesis Administrator procedures for installing and validating NuGenesis SDMS/ELN in a GxP pharmaceutical environment. Assumptions: NuGenesis 9.x or 10.x, Oracle Database 19c on Oracle Linux 8, Windows Server 2019 for NuGenesis Server, GxP-regulated environment requiring IQ/OQ/PQ validation, Oracle DBA and Waters-certified NuGenesis Administrator available.

---

## Phase 0: Oracle Database Prerequisite Configuration

### Step 0.1 — Verify Oracle Version and Patch Level

\`\`\`sql
-- Verify Oracle version and patchset
SELECT banner FROM v$version;
SELECT patch_id, patch_uid, description, action, status, action_time
FROM dba_registry_sqlpatch
ORDER BY action_time DESC
FETCH FIRST 5 ROWS ONLY;

-- Cross-check with NuGenesis compatibility matrix (Waters support portal)
-- NuGenesis 9.x: Oracle 12.2, 18c, 19c supported
-- NuGenesis 10.x: Oracle 19c recommended
\`\`\`

### Step 0.2 — Verify Character Set (CRITICAL)

\`\`\`sql
-- This check must pass before proceeding. Character set cannot be changed post-installation.
SELECT value FROM nls_database_parameters WHERE parameter = 'NLS_CHARACTERSET';
-- Required: AL32UTF8

-- Also verify national character set
SELECT value FROM nls_database_parameters WHERE parameter = 'NLS_NCHAR_CHARACTERSET';
-- Required: AL16UTF16
\`\`\`

If the character set is NOT AL32UTF8: the database must be recreated with the correct character set before installing NuGenesis. There is no patch to change character set post-creation. This is a hard stop.

### Step 0.3 — Create NuGenesis Tablespaces

\`\`\`sql
-- Data tablespace for NuGenesis metadata and relational tables
CREATE TABLESPACE ngsdms_data
  DATAFILE '/u02/oradata/NGPROD/ngsdms_data01.dbf'
  SIZE 20G AUTOEXTEND ON NEXT 5G MAXSIZE 200G
  EXTENT MANAGEMENT LOCAL UNIFORM SIZE 1M
  SEGMENT SPACE MANAGEMENT AUTO;

-- Index tablespace
CREATE TABLESPACE ngsdms_index
  DATAFILE '/u02/oradata/NGPROD/ngsdms_index01.dbf'
  SIZE 10G AUTOEXTEND ON NEXT 2G MAXSIZE 100G
  EXTENT MANAGEMENT LOCAL UNIFORM SIZE 256K
  SEGMENT SPACE MANAGEMENT AUTO;

-- LOB tablespace for instrument data files (largest tablespace)
CREATE TABLESPACE ngsdms_lob
  DATAFILE '/u02/oradata/NGPROD/ngsdms_lob01.dbf'
  SIZE 200G AUTOEXTEND ON NEXT 50G MAXSIZE 2000G
  EXTENT MANAGEMENT LOCAL UNIFORM SIZE 8M
  SEGMENT SPACE MANAGEMENT AUTO;

-- Temp tablespace for NuGenesis processes
CREATE TEMPORARY TABLESPACE ngsdms_temp
  TEMPFILE '/u02/oradata/NGPROD/ngsdms_temp01.dbf'
  SIZE 10G AUTOEXTEND ON NEXT 2G MAXSIZE 50G;
\`\`\`

### Step 0.4 — Create NuGenesis Schema Owner

\`\`\`sql
CREATE USER ngsdms
  IDENTIFIED BY "<strong_password_from_wallet>"
  DEFAULT TABLESPACE ngsdms_data
  TEMPORARY TABLESPACE ngsdms_temp
  QUOTA UNLIMITED ON ngsdms_data
  QUOTA UNLIMITED ON ngsdms_index
  QUOTA UNLIMITED ON ngsdms_lob;

-- Grant required Oracle system privileges
GRANT CREATE SESSION TO ngsdms;
GRANT CREATE TABLE TO ngsdms;
GRANT CREATE INDEX TO ngsdms;
GRANT CREATE VIEW TO ngsdms;
GRANT CREATE PROCEDURE TO ngsdms;
GRANT CREATE SEQUENCE TO ngsdms;
GRANT CREATE TRIGGER TO ngsdms;
GRANT CREATE SYNONYM TO ngsdms;
GRANT CREATE TYPE TO ngsdms;
GRANT CREATE JOB TO ngsdms;
GRANT CREATE ANY DIRECTORY TO ngsdms;
GRANT EXECUTE ON DBMS_LOB TO ngsdms;
GRANT EXECUTE ON DBMS_CRYPTO TO ngsdms;
GRANT EXECUTE ON UTL_FILE TO ngsdms;
GRANT SELECT ON DBA_OBJECTS TO ngsdms;
GRANT SELECT ON V_$SESSION TO ngsdms;
\`\`\`

### Step 0.5 — Configure Oracle Init Parameters

\`\`\`sql
-- Parameters required/recommended for NuGenesis
ALTER SYSTEM SET open_cursors = 3000 SCOPE=SPFILE;
ALTER SYSTEM SET session_cached_cursors = 100 SCOPE=SPFILE;
ALTER SYSTEM SET job_queue_processes = 20 SCOPE=SPFILE;   -- NuGenesis uses DBMS_SCHEDULER
ALTER SYSTEM SET processes = 500 SCOPE=SPFILE;
ALTER SYSTEM SET sessions = 1000 SCOPE=SPFILE;

-- SGA/PGA (adjust to server RAM)
ALTER SYSTEM SET sga_target = 16G SCOPE=SPFILE;
ALTER SYSTEM SET pga_aggregate_target = 4G SCOPE=SPFILE;

-- Enable unified auditing (required for 21 CFR Part 11)
-- Note: Unified Auditing mode change requires DB restart
ALTER SYSTEM SET enable_unified_auditing = TRUE SCOPE=SPFILE;

SHUTDOWN IMMEDIATE;
STARTUP;
\`\`\`

### Step 0.6 — Enable Oracle Unified Auditing for DBA Actions

\`\`\`sql
-- Create audit policy for DBA actions on NuGenesis schema
CREATE AUDIT POLICY ngsdms_dba_audit
  ACTIONS ALL ON SCHEMA ngsdms
  BY USERS WITH GRANTED ROLES DBA;

AUDIT POLICY ngsdms_dba_audit;

-- Verify policy is active
SELECT policy_name, enabled_opt, user_name FROM audit_unified_enabled_policies
WHERE policy_name = 'NGSDMS_DBA_AUDIT';
\`\`\`

### Step 0.7 — Configure Oracle Wallet for Password-less Connection

\`\`\`bash
# Create wallet directory
mkdir -p /u01/oracle/wallet/ngsdms
chmod 700 /u01/oracle/wallet/ngsdms

# Create wallet
orapki wallet create -wallet /u01/oracle/wallet/ngsdms -auto_login_local

# Add NuGenesis credentials to wallet
mkstore -wrl /u01/oracle/wallet/ngsdms -createCredential NGPROD ngsdms "<password>"

# Add wallet location to sqlnet.ora
echo "WALLET_LOCATION = (SOURCE = (METHOD = FILE)(METHOD_DATA = (DIRECTORY = /u01/oracle/wallet/ngsdms)))" >> $ORACLE_HOME/network/admin/sqlnet.ora
echo "SQLNET.WALLET_OVERRIDE = TRUE" >> $ORACLE_HOME/network/admin/sqlnet.ora

# Test wallet connection
sqlplus /@NGPROD
# Should connect as NGSDMS without prompting for password
\`\`\`

### Step 0.8 — Configure RMAN Backup for NuGenesis DB

\`\`\`bash
# /u01/oracle/scripts/rman_ngprod_backup.sh
#!/bin/bash
export ORACLE_SID=NGPROD
export ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export PATH=$ORACLE_HOME/bin:$PATH

rman target / <<'EOF'
CONFIGURE RETENTION POLICY TO RECOVERY WINDOW OF 30 DAYS;
CONFIGURE BACKUP OPTIMIZATION ON;
CONFIGURE CONTROLFILE AUTOBACKUP ON;
CONFIGURE DEFAULT DEVICE TYPE TO DISK;
CONFIGURE CHANNEL 1 DEVICE TYPE DISK FORMAT '/u03/rman/NGPROD/bkp_%d_%T_%U';

BACKUP AS COMPRESSED BACKUPSET DATABASE PLUS ARCHIVELOG DELETE INPUT;
DELETE NOPROMPT OBSOLETE;
EOF
\`\`\`

\`\`\`bash
# Schedule daily backup at 11 PM (after lab closes, before next day's instrument runs)
crontab -e
# Add: 0 23 * * * /u01/oracle/scripts/rman_ngprod_backup.sh >> /u01/oracle/logs/rman_ngprod_$(date +\%Y\%m\%d).log 2>&1
\`\`\`

---

## Phase 1: NuGenesis Server Installation

### Step 1.1 — Windows Server Pre-Installation Checklist

On the Windows Server 2019 NuGenesis Server host:

\`\`\`powershell
# Verify required Windows features
Get-WindowsFeature Web-Server, Web-Mgmt-Tools, Web-ASP-Net45, .NET-Framework-45-Core |
  Select-Object Name, InstallState

# Install missing features
Install-WindowsFeature Web-Server, Web-Mgmt-Tools, Web-ASP-Net45, .NET-Framework-45-Core
\`\`\`

### Step 1.2 — Install Oracle Client on NuGenesis Server

Install Oracle Database Client 19c (64-bit) on the Windows Server:
- Download from Oracle MOS: Oracle Database 19c Client for Microsoft Windows x64
- Run installer, select: Administrator install type
- Configure \`tnsnames.ora\` to reach Oracle DB:

\`\`\`
# C:\\oracle\\19c\\client\\network\\admin\\tnsnames.ora
NGPROD =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = ng-oracle-db.company.com)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = NGPROD)
    )
  )
\`\`\`

### Step 1.3 — Test Oracle Connectivity from NuGenesis Server

\`\`\`cmd
# From Windows command prompt on NuGenesis Server
tnsping NGPROD
sqlplus ngsdms/<password>@NGPROD
# Expected: Connected to Oracle Database 19c
\`\`\`

### Step 1.4 — Run NuGenesis Server Installer

1. Mount the NuGenesis installation media (ISO or network share)
2. Run \`Setup.exe\` as Administrator
3. Key parameters in the installer wizard:

| Parameter | Value |
|-----------|-------|
| Oracle TNS Name | NGPROD |
| Oracle Schema User | ngsdms |
| Oracle Schema Password | (from wallet or manual entry) |
| NuGenesis Document Vault Path | D:\NuGenesisVault\ (dedicated drive) |
| NuGenesis Application Port | 9001 (default) |
| Installation Directory | C:\Program Files\Waters\NuGenesis |

4. Click Install. Monitor the installation log: \`C:\ProgramData\Waters\NuGenesis\Install\install.log\`

### Step 1.5 — Verify Windows Services Started

\`\`\`powershell
# Check NuGenesis services
Get-Service | Where-Object {$_.Name -like "*NuGenesis*" -or $_.Name -like "*Waters*"} |
  Select-Object Name, Status, StartType

# Expected: Running for all NuGenesis services
\`\`\`

### Step 1.6 — Verify Oracle Schema Objects Created

\`\`\`sql
-- Connect as DBA on Oracle DB host
SELECT object_type, COUNT(*) cnt, MAX(last_ddl_time) last_created
FROM dba_objects
WHERE owner = 'NGSDMS'
GROUP BY object_type
ORDER BY cnt DESC;

-- Expected: 150–400+ TABLE objects, 100+ INDEX objects, various PROCEDURE/VIEW/SEQUENCE
\`\`\`

### Step 1.7 — Access NuGenesis Web Client

From a browser on the network:
\`\`\`
https://<nugenesis-server-hostname>/NuGenesis
\`\`\`

Expected: NuGenesis login page appears. Log in with the NuGenesis administrator account created during installation.

---

## Phase 2: Instrument Collection Agent Deployment

### Step 2.1 — Inventory Instrument Workstations

Create a spreadsheet listing each instrument workstation:

| Workstation | Instrument | Instrument Software | OS | IP Address | Watch Folder |
|------------|-----------|-------------------|----|-----------|-------------|
| HPLC-WS-01 | Waters UPLC H-Class | Empower 3 | Win10 | 10.1.1.101 | C:\Empower3\Projects |
| MS-WS-02 | Waters TQ-S Micro | MassLynx 4.2 | Win10 | 10.1.1.102 | D:\MassLynxData |

### Step 2.2 — Install Collection Agent on Each Workstation

1. Copy the NuGenesis Collection Agent installer from the NuGenesis Server: \`\\<ng-server>\Share\CollectionAgent\setup.exe\`
2. Run as Administrator on the instrument workstation
3. Configure:
   - NuGenesis Server hostname: \`<ng-server-hostname>\`
   - Port: 9001
   - Agent credentials: (NuGenesis service account credentials)

### Step 2.3 — Configure Watch Folders

In NuGenesis SDMS Client (or Web Client → Administration → Collection):
- Add watch folder rule for each instrument workstation
- Specify: workstation name, watch folder path, file type filter (e.g., \*.arw for Empower 3)
- Set collection rule: On file create → collect immediately

### Step 2.4 — Test Collection End-to-End

\`\`\`bash
# Create a test file in the Empower 3 watch folder on HPLC-WS-01
# (use Empower 3 to generate a test injection result)

# Verify collection within 60 seconds:
# NuGenesis Web Client → Search → All Documents → filter by date = today
# Expected: test file appears with correct metadata
\`\`\`

\`\`\`sql
-- Verify on Oracle DB:
SELECT document_id, document_name, created_date, collected_by
FROM ngsdms.ng_documents
WHERE created_date > SYSDATE - 1/24  -- last hour
ORDER BY created_date DESC;
-- Should show the test document
\`\`\`

---

## Phase 3: ELN Template Configuration

### Step 3.1 — Create Experiment Templates

In NuGenesis ELN (NuGenesis Web Client → ELN → Templates → New):

For each experiment type in scope, define:
- Template name (e.g., "HPLC Method Validation")
- Required fields: Compound ID, Batch Number, Protocol Reference, Analyst Name
- Optional fields: Instrument ID, Column Serial Number, Run Notes
- Attached documents section (link to SDMS data)

### Step 3.2 — Configure Electronic Signature Workflows

Navigate: ELN → Administration → Signature Workflows

Create workflow for production experiments:

| Step | Role | Signature Meaning (per 21 CFR 11.50) |
|------|------|--------------------------------------|
| 1 | Analyst (Author) | "I attest that this experiment was performed as described and results are accurate" |
| 2 | Reviewer | "I have reviewed this experiment and confirm it meets the experimental requirements" |
| 3 | Approver | "I approve this experiment for release/reporting" |

### Step 3.3 — Test Complete ELN Workflow

1. Create a new experiment using the HPLC Method Validation template
2. Fill in all required fields
3. Attach a test SDMS document (collected in Phase 2)
4. Sign as Analyst: verify signature dialog appears with correct signature meaning text
5. Sign as Reviewer: verify reviewer can sign and previous signature remains visible
6. Sign as Approver: verify experiment locked after approval

---

## Phase 4: Computer System Validation (CSV) Execution

### Step 4.1 — Execute IQ (Installation Qualification) Protocol

IQ verifies that the system was installed correctly and matches the approved configuration.

Key IQ checks:

\`\`\`sql
-- IQ Check: Oracle version
SELECT banner FROM v$version WHERE banner LIKE 'Oracle Database%';
-- Record exact version string; compare to IQ specification document

-- IQ Check: NuGenesis schema object count
SELECT object_type, COUNT(*) FROM dba_objects WHERE owner = 'NGSDMS' GROUP BY object_type;
-- Compare to expected object counts from NuGenesis installation guide

-- IQ Check: Tablespace configuration
SELECT tablespace_name, ROUND(SUM(bytes)/1024/1024/1024, 2) size_gb
FROM dba_data_files
WHERE tablespace_name LIKE 'NGSDMS%'
GROUP BY tablespace_name;
\`\`\`

\`\`\`powershell
# IQ Check: NuGenesis Server version
Get-ItemProperty "HKLM:\SOFTWARE\Waters\NuGenesis" | Select-Object Version
# Record; compare to IQ specification

# IQ Check: NuGenesis Windows services configured for automatic startup
Get-Service | Where-Object {$_.Name -like "*NuGenesis*"} | Select-Object Name, StartType
# Expected: StartType = Automatic for all NuGenesis services
\`\`\`

Document all IQ checks with: check description, expected result, actual result, pass/fail, and DBA/NuGenesis Admin initials.

### Step 4.2 — Execute OQ (Operational Qualification) Test Scripts

OQ tests that the system performs its intended functions. Waters provides a standard OQ test script library. Execute each test and record results.

Key OQ areas:

| OQ Area | Test Count | Example Test |
|---------|-----------|-------------|
| User management | 5–10 | Create user, assign role, verify access |
| Document collection | 10–20 | Collect file, verify metadata, search |
| ELN experiment | 10–20 | Create, edit, sign, approve experiment |
| Audit trail | 5–10 | Verify audit trail entry for each user action |
| Access control | 5–10 | Verify user without role cannot access restricted function |
| Backup and restore | 3–5 | Restore from backup, verify document accessibility |

### Step 4.3 — Document Deviations

Any OQ test that does not match the expected result is a deviation. For each deviation:
- Document: test ID, expected result, actual result, deviation description
- Perform impact assessment: does the deviation affect system fitness for intended use?
- Resolve: fix the configuration issue and re-execute the failed test, or raise a formal deviation with QA

### Step 4.4 — Obtain QA Approval

Submit completed IQ and OQ execution evidence (all test records with signatures) to the QA team. QA reviews, signs the validation report, and authorises system use in GxP workflows.

### Step 4.5 — PQ (Performance Qualification) — Concurrent Load Test

\`\`\`bash
# Simulate concurrent user load (20 users simultaneously uploading instrument data)
# Use Waters' performance test scripts or a load testing tool (JMeter)

# During PQ load test, monitor Oracle DB:
sqlplus / as sysdba <<'EOF'
SELECT event, COUNT(*) wait_count
FROM v$session
WHERE wait_class != 'Idle'
GROUP BY event
ORDER BY wait_count DESC;
EXIT
EOF

# Target: no ORA- errors during PQ test
# Target: document upload time < 5 seconds for files < 10 MB
\`\`\`

---

## Phase 5: Post-Go-Live Operational Procedures

### Step 5.1 — Daily Monitoring Checklist

\`\`\`bash
# Daily DBA checks (automate in monitoring script)

# 1. NuGenesis services running
ssh ng-server "powershell Get-Service | Where-Object {\$_.Name -like '*NuGenesis*'} | Select-Object Name, Status"

# 2. Oracle alert log clean
grep -c "ORA-" $ORACLE_BASE/diag/rdbms/NGPROD/NGPROD/trace/alert_NGPROD.log

# 3. RMAN backup completed
sqlplus / as sysdba <<'EOF'
SELECT status, start_time, end_time FROM v\$rman_backup_job_details
WHERE start_time > SYSDATE - 1 ORDER BY start_time DESC;
EXIT
EOF

# 4. Disk space
df -h /u02/oradata/NGPROD /u03/rman/NGPROD

# 5. New documents collected (confirms collection agents are active)
sqlplus ngsdms/<password>@NGPROD <<'EOF'
SELECT COUNT(*) docs_today FROM ng_documents WHERE created_date > TRUNC(SYSDATE);
EXIT
EOF
\`\`\`

### Step 5.2 — Weekly Tasks

- Review Oracle audit trail for any unauthorized schema access
- Verify RMAN backup recovery test schedule is on track (quarterly minimum)
- Review LOB tablespace growth rate

\`\`\`sql
-- Weekly LOB growth report
SELECT tablespace_name,
       ROUND(SUM(bytes)/1024/1024/1024, 2) used_gb,
       ROUND(SUM(maxbytes)/1024/1024/1024, 2) max_gb,
       ROUND(SUM(bytes)/SUM(maxbytes)*100, 1) pct_full
FROM dba_data_files
WHERE tablespace_name LIKE 'NGSDMS%'
GROUP BY tablespace_name;
\`\`\`

### Step 5.3 — Oracle Patch Process in GxP (Change Control Required)

Every Oracle patch applied to the NuGenesis production database requires:

1. **Change control ticket** raised with: patch number, description, risk assessment, rollback plan
2. **Impact assessment**: does the patch affect any NuGenesis-validated functionality?
3. **Test environment**: apply patch to NuGenesis TEST environment first; execute abbreviated OQ
4. **QA review**: QA reviews impact assessment and approves production change
5. **Production implementation**: apply patch during approved maintenance window
6. **Post-implementation OQ**: execute abbreviated OQ in production to verify NuGenesis still functions correctly after patch
7. **Change control closure**: document actual implementation time, results, QA sign-off

This process is not optional in a GxP environment. Uncontrolled changes to the NuGenesis production database infrastructure are a 21 CFR Part 11 violation and an Annex 11 deviation.`,
};

async function main() {
  console.log('Inserting NuGenesis SDMS/ELN Oracle implementation runbook...');
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
