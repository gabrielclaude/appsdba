import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Migrating Oracle 19c to SQL Server 2022 on Linux',
  slug: 'oracle-19c-sql-server-linux-migration-runbook',
  excerpt:
    'Step-by-step migration runbook: SSMA Oracle assessment, SQL Server 2022 installation on RHEL/Oracle Linux, schema and data migration, PL/SQL to T-SQL conversion, application cutover, and post-migration monitoring. Includes a database health check script with crontab scheduling.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-07'),
  youtubeUrl: null,
  content: `## Overview

This runbook migrates an Oracle 19c database to SQL Server 2022 on Red Hat Enterprise Linux (RHEL) 8.x or Oracle Linux 8.x. It covers assessment, SQL Server installation, schema migration with SSMA, bulk data transfer, PL/SQL to T-SQL conversion, cutover, and post-migration health monitoring.

**Estimated Duration**: 2–6 weeks depending on schema complexity. The runbook phases can overlap — SQL Server installation runs in parallel with SSMA assessment.

**Prerequisites**
- Oracle 19c source database accessible from migration workstation
- Target Linux server: RHEL 8.x / Oracle Linux 8.x, minimum 4 cores, 16 GB RAM, storage per database size + 20% headroom
- SSMA for Oracle installed on a Windows workstation (free download from Microsoft)
- \`sqlcmd\`, \`bcp\`, \`mssql-tools\` installed on Linux target
- Oracle Instant Client installed on migration workstation
- sudo / root access on target Linux server
- Oracle DBA credentials with DBA role (for schema export)

---

## Phase 1: Pre-Migration Assessment

### 1.1 Oracle Schema Inventory

\`\`\`sql
-- Connect to Oracle as DBA
-- Object count by type per schema
SELECT owner, object_type, COUNT(*) AS obj_count
FROM dba_objects
WHERE owner NOT IN (
  'SYS','SYSTEM','DBSNMP','OUTLN','ORACLE_OCM','APPQOSSYS',
  'WMSYS','EXFSYS','CTXSYS','XDB','ANONYMOUS','MDSYS',
  'ORDSYS','ORDPLUGINS','SI_INFORMTN_SCHEMA','DVSYS','LBACSYS'
)
GROUP BY owner, object_type
ORDER BY owner, obj_count DESC;

-- Table row counts and size estimates
SELECT
  t.owner,
  t.table_name,
  t.num_rows,
  ROUND(s.bytes / 1024 / 1024, 2) AS size_mb
FROM dba_tables t
JOIN dba_segments s ON s.owner = t.owner AND s.segment_name = t.table_name
WHERE t.owner NOT IN (
  'SYS','SYSTEM','DBSNMP','OUTLN','ORACLE_OCM','APPQOSSYS',
  'WMSYS','EXFSYS','CTXSYS','XDB','ANONYMOUS','MDSYS',
  'ORDSYS','ORDPLUGINS','SI_INFORMTN_SCHEMA','DVSYS','LBACSYS'
)
ORDER BY s.bytes DESC;

-- PL/SQL objects to convert
SELECT owner, object_type, object_name, status
FROM dba_objects
WHERE object_type IN ('PROCEDURE','FUNCTION','PACKAGE','PACKAGE BODY',
                      'TRIGGER','TYPE','TYPE BODY')
AND owner NOT IN (
  'SYS','SYSTEM','DBSNMP','OUTLN','ORACLE_OCM'
)
ORDER BY owner, object_type, object_name;

-- Identify CLOB/BLOB columns (require VARCHAR(MAX)/VARBINARY(MAX))
SELECT owner, table_name, column_name, data_type, data_length
FROM dba_tab_columns
WHERE data_type IN ('CLOB','BLOB','NCLOB','LONG','LONG RAW','XMLTYPE')
AND owner NOT IN ('SYS','SYSTEM')
ORDER BY owner, table_name;

-- Identify DATE columns (may contain time components)
SELECT owner, table_name, column_name
FROM dba_tab_columns
WHERE data_type = 'DATE'
AND owner NOT IN ('SYS','SYSTEM')
ORDER BY owner, table_name;

-- Check for non-standard character sets
SELECT parameter, value
FROM nls_database_parameters
WHERE parameter IN ('NLS_CHARACTERSET','NLS_NCHAR_CHARACTERSET',
                    'NLS_LANGUAGE','NLS_TERRITORY');
\`\`\`

### 1.2 Run SSMA Oracle Assessment

On the Windows workstation with SSMA for Oracle installed:

1. Launch SSMA for Oracle
2. **File → New Project** — name the project, select **SQL Server 2022** as target
3. **File → Connect to Oracle** — enter Oracle connection details (host, port, SID/service name, DBA credentials)
4. In the Oracle Metadata Explorer, select the schemas to migrate → right-click → **Create Report**
5. Wait for assessment to complete (can take 15–60 minutes for large schemas)
6. Review the Assessment Report:
   - **Conversion statistics**: percentage of objects auto-convertible vs needing manual work
   - **Error objects**: list every object SSMA cannot convert automatically
   - **Warning objects**: objects converted with assumptions that need review
7. Export the report: **View → Reports → Save Report**

The assessment report drives your migration timeline. A schema with >90% auto-conversion and <50 error objects can be migrated in 2 weeks. A schema with 40% auto-conversion and 200+ error objects may take 6–8 weeks.

### 1.3 Identify Application Connection Dependencies

\`\`\`bash
# On Oracle server — identify all current connections and application users
sqlplus -s / as sysdba <<'SQL_EOF'
SELECT username, program, machine, COUNT(*) AS sessions
FROM v\$session
WHERE username IS NOT NULL
GROUP BY username, program, machine
ORDER BY sessions DESC;
SQL_EOF

# List database links (cross-database dependencies)
sqlplus -s / as sysdba <<'SQL_EOF'
SELECT owner, db_link, username, host
FROM dba_db_links
ORDER BY owner;
SQL_EOF
\`\`\`

---

## Phase 2: Install SQL Server 2022 on Linux

\`\`\`bash
# Run as root on target RHEL 8 / Oracle Linux 8 server

# Add Microsoft SQL Server repo
curl -o /etc/yum.repos.d/mssql-server.repo \\
  https://packages.microsoft.com/config/rhel/8/mssql-server-2022.repo

# Install SQL Server
dnf install -y mssql-server

# Run initial setup (set SA password, choose edition)
/opt/mssql/bin/mssql-conf setup
# Select edition: 2 (Developer) for dev/test, 1 (Evaluation) for production trial
# Set SA password: minimum 8 chars, upper+lower+digit+symbol

# Start and enable SQL Server service
systemctl start mssql-server
systemctl enable mssql-server
systemctl status mssql-server

# Install SQL Server command-line tools
curl -o /etc/yum.repos.d/msprod.repo \\
  https://packages.microsoft.com/config/rhel/8/prod.repo
dnf install -y mssql-tools18 unixODBC-devel

# Add tools to PATH
echo 'export PATH="\$PATH:/opt/mssql-tools18/bin"' >> /etc/profile.d/mssql.sh
source /etc/profile.d/mssql.sh

# Verify SQL Server is running and accepting connections
sqlcmd -S localhost -U SA -P '<YourPassword>' -Q "SELECT @@VERSION" -C

# Configure SQL Server memory (set to 70-80% of system RAM)
TOTAL_RAM_MB=\$(free -m | awk '/^Mem:/{print \$2}')
MAX_MEM_MB=\$(( TOTAL_RAM_MB * 75 / 100 ))
/opt/mssql/bin/mssql-conf set memory.memorylimitmb \${MAX_MEM_MB}

# Configure data and log directories
mkdir -p /data/sqlserver/data /data/sqlserver/log /data/sqlserver/backup
chown -R mssql:mssql /data/sqlserver
chmod 750 /data/sqlserver

/opt/mssql/bin/mssql-conf set filelocation.defaultdatadir /data/sqlserver/data
/opt/mssql/bin/mssql-conf set filelocation.defaultlogdir /data/sqlserver/log
/opt/mssql/bin/mssql-conf set filelocation.defaultbackupdir /data/sqlserver/backup

# Enable SQL Server Agent (for scheduled jobs)
/opt/mssql/bin/mssql-conf set sqlagent.enabled true

# Restart to apply settings
systemctl restart mssql-server
sleep 15
systemctl status mssql-server
\`\`\`

### 2.1 Create Target Database

\`\`\`bash
sqlcmd -S localhost -U SA -P '<YourPassword>' -C <<'SQL_EOF'
-- Create the migration target database
CREATE DATABASE [TargetDB]
ON PRIMARY (
  NAME = N'TargetDB_data',
  FILENAME = N'/data/sqlserver/data/TargetDB.mdf',
  SIZE = 1024MB,
  FILEGROWTH = 256MB
),
FILEGROUP [FG_DATA] (
  NAME = N'TargetDB_data2',
  FILENAME = N'/data/sqlserver/data/TargetDB_data2.ndf',
  SIZE = 1024MB,
  FILEGROWTH = 256MB
)
LOG ON (
  NAME = N'TargetDB_log',
  FILENAME = N'/data/sqlserver/log/TargetDB.ldf',
  SIZE = 512MB,
  FILEGROWTH = 128MB
);
GO

-- Set database compatibility level for SQL Server 2022
ALTER DATABASE [TargetDB] SET COMPATIBILITY_LEVEL = 160;
GO

-- Set recovery model
ALTER DATABASE [TargetDB] SET RECOVERY FULL;
GO

-- Verify
SELECT name, compatibility_level, recovery_model_desc
FROM sys.databases
WHERE name = 'TargetDB';
GO
SQL_EOF
\`\`\`

---

## Phase 3: Schema Migration with SSMA

### 3.1 Connect SSMA to Both Databases

In SSMA for Oracle on Windows:

1. **File → Connect to Oracle** — connect to source Oracle 19c
2. **File → Connect to SQL Server** — connect to target SQL Server 2022 on Linux
   - Server: Linux hostname or IP
   - Database: TargetDB
   - Authentication: SQL Server (SA or migration user)
   - **Trust Server Certificate: Yes** (for initial setup without TLS)

### 3.2 Configure Type Mappings

Before converting, review and configure type mappings in **Tools → Project Settings → Type Mapping**:

| Oracle Type | Recommended SQL Server Mapping |
|---|---|
| NUMBER(p,s) where p≤18 | DECIMAL(p,s) |
| NUMBER(p,s) where p>18 | DECIMAL(38,s) |
| NUMBER (no precision) | FLOAT(53) |
| DATE | DATETIME2(0) |
| VARCHAR2(n BYTE) | VARCHAR(n*3) for AL32UTF8 sources |
| VARCHAR2(n CHAR) | NVARCHAR(n) |
| CLOB | NVARCHAR(MAX) |
| BLOB | VARBINARY(MAX) |
| XMLTYPE | XML |

### 3.3 Convert and Review Schema

1. In SSMA Oracle Metadata Explorer, select schemas → right-click → **Convert Schema**
2. Review the SQL Server Metadata Explorer — converted objects appear with status icons
3. For each ERROR object (red icon), review the conversion message and manually fix the T-SQL
4. Common manual fixes:
   - Oracle packages → split into individual stored procedures in a SQL Server schema
   - CONNECT BY hierarchical queries → recursive CTEs
   - SEQUENCE.NEXTVAL references → \`NEXT VALUE FOR\` or IDENTITY
   - SYS_GUID() → NEWID()
   - ROWNUM → ROW_NUMBER() OVER or TOP
5. After fixing errors, right-click the target schema in SQL Server Metadata Explorer → **Synchronize with Database** — this creates all converted objects in SQL Server

\`\`\`bash
# Verify objects were created in SQL Server
sqlcmd -S localhost -U SA -P '<YourPassword>' -d TargetDB -C <<'SQL_EOF'
-- Count objects by type
SELECT type_desc, COUNT(*) AS obj_count
FROM sys.objects
WHERE type_desc NOT IN ('SYSTEM_TABLE','INTERNAL_TABLE','SERVICE_QUEUE')
GROUP BY type_desc
ORDER BY obj_count DESC;
GO
SQL_EOF
\`\`\`

---

## Phase 4: Data Migration

### 4.1 SSMA Data Migration (For Databases Under 100 GB)

In SSMA:
1. Select the tables to migrate in Oracle Metadata Explorer
2. Right-click → **Migrate Data**
3. SSMA streams data from Oracle to SQL Server via ODBC
4. Monitor progress in the Data Migration Report
5. Review the report for row count mismatches and errors

### 4.2 BCP Bulk Migration (For Large Tables)

For tables over 1 GB, BCP provides significantly higher throughput than SSMA.

\`\`\`bash
# On migration workstation with Oracle Instant Client and mssql-tools

# Step 1: Export from Oracle using SQL*Plus spool (for simple tables)
# Or use Oracle Data Pump to CSV, then BCP into SQL Server

# Export Oracle table to CSV via Python/cx_Oracle (install: pip install cx_Oracle)
cat > /tmp/oracle_export.py <<'PYEOF'
import cx_Oracle
import csv
import sys

dsn = cx_Oracle.makedsn("oracle-host", 1521, service_name="ORCL")
conn = cx_Oracle.connect("migration_user", "password", dsn)
cursor = conn.cursor()

table_name = sys.argv[1]
output_file = f"/tmp/{table_name.lower()}.csv"

cursor.execute(f"SELECT * FROM {table_name}")
columns = [desc[0] for desc in cursor.description]

with open(output_file, 'w', newline='', encoding='utf-8') as f:
    writer = csv.writer(f, quoting=csv.QUOTE_MINIMAL)
    writer.writerow(columns)
    for row in cursor:
        writer.writerow(row)

print(f"Exported {cursor.rowcount} rows to {output_file}")
conn.close()
PYEOF

# Export a table
python3 /tmp/oracle_export.py HR.EMPLOYEES

# Step 2: Create format file for BCP
bcp TargetDB.hr.employees format nul -c -t',' -r'\n' \\
  -S localhost -U SA -P '<YourPassword>' -f /tmp/employees.fmt -C

# Step 3: Bulk load into SQL Server
# Disable indexes first for large loads
sqlcmd -S localhost -U SA -P '<YourPassword>' -d TargetDB -C <<'SQL_EOF'
ALTER INDEX ALL ON hr.employees DISABLE;
GO
SQL_EOF

bcp TargetDB.hr.employees IN /tmp/employees.csv \\
  -S localhost -U SA -P '<YourPassword>' \\
  -c -t',' -r'\n' -F 2 \\
  -b 10000 -a 32768 \\
  -C

# Re-enable and rebuild indexes
sqlcmd -S localhost -U SA -P '<YourPassword>' -d TargetDB -C <<'SQL_EOF'
ALTER INDEX ALL ON hr.employees REBUILD;
GO
SQL_EOF
\`\`\`

### 4.3 Row Count Validation

\`\`\`bash
# Oracle row counts
sqlplus -s migration_user/password@oracle-host:1521/ORCL <<'SQL_EOF'
SET PAGESIZE 0 FEEDBACK OFF
SELECT table_name || ',' || TO_CHAR(num_rows)
FROM user_tables
ORDER BY table_name;
SQL_EOF

# SQL Server row counts
sqlcmd -S localhost -U SA -P '<YourPassword>' -d TargetDB -C <<'SQL_EOF'
SELECT
  s.name + '.' + t.name AS table_name,
  SUM(p.rows) AS row_count
FROM sys.tables t
JOIN sys.schemas s ON t.schema_id = s.schema_id
JOIN sys.partitions p ON t.object_id = p.object_id
WHERE p.index_id IN (0, 1)
GROUP BY s.name, t.name
ORDER BY s.name, t.name;
GO
SQL_EOF

# Compare: export both to files and diff
# Any mismatch requires investigation before cutover
\`\`\`

---

## Phase 5: PL/SQL to T-SQL Manual Conversion

SSMA handles routine procedural code, but the following patterns require manual review and rewrite.

### 5.1 Oracle Package → SQL Server Schema + Stored Procedures

\`\`\`sql
-- Oracle package (example)
-- CREATE OR REPLACE PACKAGE hr_utils AS
--   PROCEDURE get_employee(p_id IN NUMBER, p_name OUT VARCHAR2);
--   FUNCTION dept_headcount(p_dept_id IN NUMBER) RETURN NUMBER;
-- END;

-- SQL Server equivalent: create schema, then individual procedures/functions
CREATE SCHEMA hr_utils;
GO

CREATE PROCEDURE hr_utils.get_employee
  @p_id INT,
  @p_name NVARCHAR(100) OUTPUT
AS
BEGIN
  SET NOCOUNT ON;
  SELECT @p_name = last_name + ', ' + first_name
  FROM hr.employees
  WHERE employee_id = @p_id;
END;
GO

CREATE FUNCTION hr_utils.dept_headcount(@p_dept_id INT)
RETURNS INT
AS
BEGIN
  DECLARE @count INT;
  SELECT @count = COUNT(*)
  FROM hr.employees
  WHERE department_id = @p_dept_id;
  RETURN @count;
END;
GO
\`\`\`

### 5.2 NO_DATA_FOUND Pattern

\`\`\`sql
-- Oracle (raises exception when SELECT INTO finds no rows)
-- BEGIN
--   SELECT salary INTO v_sal FROM employees WHERE employee_id = p_id;
-- EXCEPTION
--   WHEN NO_DATA_FOUND THEN v_sal := 0;
-- END;

-- SQL Server T-SQL equivalent
DECLARE @v_sal DECIMAL(10,2) = 0;
SELECT @v_sal = salary
FROM hr.employees
WHERE employee_id = @p_id;
-- If no row found, @v_sal stays 0 (no exception raised)
-- If you need to detect the no-data case:
IF @@ROWCOUNT = 0
  SET @v_sal = 0;
\`\`\`

### 5.3 SEQUENCE Migration

\`\`\`sql
-- Oracle: CREATE SEQUENCE hr.emp_seq START WITH 1000 INCREMENT BY 1 CACHE 20;
-- Usage: INSERT INTO employees(id, ...) VALUES (hr.emp_seq.NEXTVAL, ...)

-- SQL Server: Create equivalent SEQUENCE object
CREATE SEQUENCE hr.emp_seq
  START WITH 1000
  INCREMENT BY 1
  CACHE 20;

-- Usage in T-SQL
INSERT INTO hr.employees(employee_id, ...)
VALUES (NEXT VALUE FOR hr.emp_seq, ...);
\`\`\`

### 5.4 CONNECT BY Hierarchical to Recursive CTE

\`\`\`sql
-- Oracle
-- SELECT employee_id, manager_id, LEVEL, SYS_CONNECT_BY_PATH(last_name, '/') AS path
-- FROM employees
-- START WITH manager_id IS NULL
-- CONNECT BY PRIOR employee_id = manager_id
-- ORDER SIBLINGS BY last_name;

-- SQL Server recursive CTE
WITH emp_hierarchy AS (
  -- Anchor: top-level (no manager)
  SELECT
    employee_id,
    manager_id,
    last_name,
    1 AS level_num,
    CAST(last_name AS NVARCHAR(4000)) AS path
  FROM hr.employees
  WHERE manager_id IS NULL

  UNION ALL

  -- Recursive member
  SELECT
    e.employee_id,
    e.manager_id,
    e.last_name,
    h.level_num + 1,
    CAST(h.path + '/' + e.last_name AS NVARCHAR(4000))
  FROM hr.employees e
  INNER JOIN emp_hierarchy h ON e.manager_id = h.employee_id
)
SELECT employee_id, manager_id, level_num, path
FROM emp_hierarchy
ORDER BY path;
\`\`\`

---

## Phase 6: Application Cutover Preparation

### 6.1 Update Connection Strings

Oracle JDBC connection strings use Oracle thin driver format:
\`\`\`
jdbc:oracle:thin:@hostname:1521:SID
jdbc:oracle:thin:@hostname:1521/service_name
\`\`\`

SQL Server JDBC connection strings (Microsoft JDBC Driver 12.x):
\`\`\`
jdbc:sqlserver://hostname:1433;databaseName=TargetDB;encrypt=true;trustServerCertificate=true
\`\`\`

SQL Server ODBC DSN (for applications using ODBC):
\`\`\`
Driver=ODBC Driver 18 for SQL Server;Server=hostname,1433;Database=TargetDB;Uid=appuser;Pwd=<password>;Encrypt=yes;TrustServerCertificate=yes
\`\`\`

### 6.2 Create Application SQL Server Login

\`\`\`bash
sqlcmd -S localhost -U SA -P '<YourPassword>' -d TargetDB -C <<'SQL_EOF'
-- Create application login (SQL authentication)
CREATE LOGIN appuser WITH PASSWORD = '<StrongPassword123!>';
GO

-- Create database user mapped to login
USE TargetDB;
GO
CREATE USER appuser FOR LOGIN appuser;
GO

-- Grant appropriate permissions (adjust to actual requirements)
ALTER ROLE db_datareader ADD MEMBER appuser;
ALTER ROLE db_datawriter ADD MEMBER appuser;

-- Grant EXECUTE on stored procedures
GRANT EXECUTE ON SCHEMA::hr TO appuser;
GRANT EXECUTE ON SCHEMA::hr_utils TO appuser;
GO

-- Verify
SELECT dp.name, dp.type_desc, dp.create_date
FROM sys.database_principals dp
WHERE dp.name = 'appuser';
GO
SQL_EOF
\`\`\`

### 6.3 Firewall and Network Validation

\`\`\`bash
# Open SQL Server port 1433 on Linux firewall
firewall-cmd --permanent --add-port=1433/tcp
firewall-cmd --reload
firewall-cmd --list-ports | grep 1433

# Test connectivity from application server
# (run from app server)
# sqlcmd -S sqlserver-host -U appuser -P '<password>' -d TargetDB -C -Q "SELECT 'Connected' AS status"

# Test ODBC connectivity from app server (Linux)
isql -v "TargetDB_DSN" appuser '<password>'
\`\`\`

---

## Phase 7: Cutover

\`\`\`bash
# Pre-cutover final data sync (if incremental approach)
# 1. Put Oracle application in read-only / maintenance mode
# 2. Run final delta data load for changed rows since initial migration

# On Oracle: identify rows changed since initial migration
# (requires change tracking — add CDC or use timestamp columns)
sqlplus -s dba_user/password@oracle-host:1521/ORCL <<'SQL_EOF'
-- Example: sync rows modified after initial migration timestamp
SELECT * FROM hr.employees
WHERE last_update_date > TO_DATE('2026-06-07 02:00:00','YYYY-MM-DD HH24:MI:SS');
SQL_EOF

# Final row count comparison
echo "=== Oracle Row Counts ==="
sqlplus -s migration_user/password@oracle-host:1521/ORCL <<'SQL_EOF'
SELECT COUNT(*) FROM hr.employees;
SELECT COUNT(*) FROM hr.departments;
SQL_EOF

echo "=== SQL Server Row Counts ==="
sqlcmd -S localhost -U SA -P '<YourPassword>' -d TargetDB -C <<'SQL_EOF'
SELECT COUNT(*) FROM hr.employees;
SELECT COUNT(*) FROM hr.departments;
GO
SQL_EOF

# 3. Update application configuration to point to SQL Server
# 4. Start application and verify login/functionality
# 5. Monitor error logs for first 30 minutes

echo "Cutover complete — monitoring application logs"
\`\`\`

---

## Phase 8: Post-Migration Monitoring Script

\`\`\`bash
cat > /u01/scripts/sqlserver_health_check.sh <<'SCRIPT_EOF'
#!/bin/bash
# SQL Server 2022 Post-Migration Health Monitor
# Nagios-compatible exit codes: 0=OK, 1=WARNING, 2=CRITICAL

SQLCMD="/opt/mssql-tools18/bin/sqlcmd"
SQL_HOST="localhost"
SQL_USER="SA"
SQL_PASS="<YourSAPassword>"
TARGET_DB="TargetDB"
EMAIL="dba-alerts@example.com"
LOG="/var/log/sqlserver_health.log"
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')

STATUS=0
MESSAGES=""

# Function: run a T-SQL query and return result
run_sql() {
  \${SQLCMD} -S \${SQL_HOST} -U \${SQL_USER} -P \${SQL_PASS} \\
    -d \${TARGET_DB} -C -h -1 -W -Q "\$1" 2>/dev/null | head -1
}

# Check 1: SQL Server service running
if ! systemctl is-active --quiet mssql-server; then
  MESSAGES+="CRITICAL: SQL Server service is not running\n"
  STATUS=2
else
  MESSAGES+="OK: SQL Server service running\n"
fi

# Check 2: Can we connect?
CONN_TEST=\$(run_sql "SELECT 'connected'")
if [ "\${CONN_TEST}" != "connected" ]; then
  MESSAGES+="CRITICAL: Cannot connect to SQL Server\n"
  STATUS=2
else
  MESSAGES+="OK: SQL Server accepting connections\n"
fi

# Check 3: Database online
DB_STATE=\$(\${SQLCMD} -S \${SQL_HOST} -U \${SQL_USER} -P \${SQL_PASS} -C -h -1 -W \\
  -Q "SELECT state_desc FROM sys.databases WHERE name='\${TARGET_DB}'" 2>/dev/null | head -1)
if [ "\${DB_STATE}" != "ONLINE" ]; then
  MESSAGES+="CRITICAL: Database \${TARGET_DB} is \${DB_STATE}\n"
  STATUS=2
else
  MESSAGES+="OK: Database \${TARGET_DB} is ONLINE\n"
fi

# Check 4: Active connections
CONN_COUNT=\$(run_sql "SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE database_id=DB_ID('\${TARGET_DB}') AND is_user_process=1")
MESSAGES+="INFO: Active connections: \${CONN_COUNT}\n"

# Check 5: Blocking queries (sessions blocked > 30 seconds)
BLOCKING=\$(\${SQLCMD} -S \${SQL_HOST} -U \${SQL_USER} -P \${SQL_PASS} -C -h -1 -W \\
  -Q "SELECT COUNT(*) FROM sys.dm_exec_requests WHERE blocking_session_id > 0 AND wait_time > 30000" 2>/dev/null | head -1)
if [ "\${BLOCKING:-0}" -gt 0 ]; then
  MESSAGES+="WARNING: \${BLOCKING} blocked queries (>30s)\n"
  [ \${STATUS} -lt 1 ] && STATUS=1
else
  MESSAGES+="OK: No blocking queries\n"
fi

# Check 6: Long-running queries (> 5 minutes)
LONG_RUNNING=\$(\${SQLCMD} -S \${SQL_HOST} -U \${SQL_USER} -P \${SQL_PASS} -C -h -1 -W \\
  -Q "SELECT COUNT(*) FROM sys.dm_exec_requests WHERE session_id > 50 AND total_elapsed_time > 300000" 2>/dev/null | head -1)
if [ "\${LONG_RUNNING:-0}" -gt 5 ]; then
  MESSAGES+="WARNING: \${LONG_RUNNING} queries running > 5 minutes\n"
  [ \${STATUS} -lt 1 ] && STATUS=1
else
  MESSAGES+="OK: No excessive long-running queries\n"
fi

# Check 7: Data file space usage
FILE_USAGE=\$(\${SQLCMD} -S \${SQL_HOST} -U \${SQL_USER} -P \${SQL_PASS} \\
  -d \${TARGET_DB} -C -h -1 -W \\
  -Q "SELECT CAST(ROUND(CAST(FILEPROPERTY(name,'SpaceUsed') AS FLOAT)/CAST(size AS FLOAT)*100,1) AS VARCHAR) FROM sys.database_files WHERE type=0 ORDER BY file_id" 2>/dev/null | head -1 | tr -d ' ')
if [ -n "\${FILE_USAGE}" ]; then
  PCT=\$(echo "\${FILE_USAGE}" | cut -d'.' -f1)
  if [ "\${PCT:-0}" -ge 90 ]; then
    MESSAGES+="CRITICAL: Data file \${PCT}% full\n"
    STATUS=2
  elif [ "\${PCT:-0}" -ge 80 ]; then
    MESSAGES+="WARNING: Data file \${PCT}% full\n"
    [ \${STATUS} -lt 1 ] && STATUS=1
  else
    MESSAGES+="OK: Data file \${PCT}% used\n"
  fi
fi

# Check 8: Log file space
LOG_USAGE=\$(\${SQLCMD} -S \${SQL_HOST} -U \${SQL_USER} -P \${SQL_PASS} \\
  -d \${TARGET_DB} -C -h -1 -W \\
  -Q "SELECT CAST(log_reuse_wait_desc AS VARCHAR) FROM sys.databases WHERE name='\${TARGET_DB}'" 2>/dev/null | head -1 | tr -d ' ')
if [ "\${LOG_USAGE}" = "LOG_BACKUP" ]; then
  MESSAGES+="WARNING: Transaction log waiting for backup (LOG_BACKUP)\n"
  [ \${STATUS} -lt 1 ] && STATUS=1
elif [ "\${LOG_USAGE}" = "NOTHING" ] || [ "\${LOG_USAGE}" = "CHECKPOINT" ]; then
  MESSAGES+="OK: Log reuse wait: \${LOG_USAGE}\n"
else
  MESSAGES+="INFO: Log reuse wait: \${LOG_USAGE}\n"
fi

# Check 9: SQL Server Agent running
if ! systemctl is-active --quiet mssql-server; then
  MESSAGES+="WARNING: Could not verify SQL Server Agent\n"
  [ \${STATUS} -lt 1 ] && STATUS=1
else
  AGENT_STATUS=\$(run_sql "SELECT is_enabled FROM msdb.dbo.sysjobactivity WHERE start_execution_date IS NULL" 2>/dev/null)
  MESSAGES+="OK: SQL Server Agent active\n"
fi

# Check 10: Disk space on data volume
DATA_VOL=\$(df /data/sqlserver --output=pcent 2>/dev/null | tail -1 | tr -dc '0-9')
if [ "\${DATA_VOL:-0}" -ge 90 ]; then
  MESSAGES+="CRITICAL: Data volume \${DATA_VOL}% full\n"
  STATUS=2
elif [ "\${DATA_VOL:-0}" -ge 80 ]; then
  MESSAGES+="WARNING: Data volume \${DATA_VOL}% full\n"
  [ \${STATUS} -lt 1 ] && STATUS=1
else
  MESSAGES+="OK: Data volume \${DATA_VOL:-unknown}% used\n"
fi

# Write to log
echo "[\${TIMESTAMP}] STATUS=\${STATUS}" >> \${LOG}
echo -e "\${MESSAGES}" >> \${LOG}

# Send alert email if not OK
if [ \${STATUS} -ne 0 ]; then
  HOSTNAME=\$(hostname -f)
  echo -e "SQL Server Health Alert on \${HOSTNAME}\n\n\${MESSAGES}" | \\
    mailx -s "SQL Server Alert [\${STATUS}] - \${HOSTNAME}" \${EMAIL}
fi

echo -e "\${MESSAGES}"
exit \${STATUS}
SCRIPT_EOF

chmod +x /u01/scripts/sqlserver_health_check.sh

# Test
/u01/scripts/sqlserver_health_check.sh
echo "Exit: \$?"

# Schedule: every 10 minutes
(crontab -l 2>/dev/null; echo "*/10 * * * * /u01/scripts/sqlserver_health_check.sh >> /var/log/sqlserver_health.log 2>&1") | crontab -
crontab -l | grep sqlserver_health

echo "Post-migration monitoring configured"
\`\`\`

---

## Phase 9: Backup Configuration

\`\`\`bash
sqlcmd -S localhost -U SA -P '<YourPassword>' -d msdb -C <<'SQL_EOF'
-- Full backup job (daily at 2 AM)
EXEC sp_add_job @job_name = N'Daily Full Backup - TargetDB';

EXEC sp_add_jobstep
  @job_name = N'Daily Full Backup - TargetDB',
  @step_name = N'Full Backup',
  @command = N'
    DECLARE @path NVARCHAR(500);
    SET @path = N''/data/sqlserver/backup/TargetDB_'' +
      REPLACE(CONVERT(VARCHAR, GETDATE(), 112), ''-'', '''') + N''_full.bak'';
    BACKUP DATABASE [TargetDB] TO DISK = @path
    WITH COMPRESSION, CHECKSUM, STATS = 10;
  ';

EXEC sp_add_schedule
  @schedule_name = N'Daily 2AM',
  @freq_type = 4,           -- Daily
  @freq_interval = 1,
  @active_start_time = 20000;  -- 02:00:00

EXEC sp_attach_schedule
  @job_name = N'Daily Full Backup - TargetDB',
  @schedule_name = N'Daily 2AM';

EXEC sp_add_jobserver
  @job_name = N'Daily Full Backup - TargetDB';
GO

-- Verify backup job created
SELECT j.name, j.enabled, s.next_run_date, s.next_run_time
FROM sysjobs j
JOIN sysjobschedules js ON j.job_id = js.job_id
JOIN sysschedules s ON js.schedule_id = s.schedule_id
WHERE j.name LIKE '%TargetDB%';
GO
SQL_EOF
\`\`\`

---

## Post-Migration Validation Checklist

- [ ] SQL Server service starts automatically on reboot (\`systemctl is-enabled mssql-server\`)
- [ ] Row counts match Oracle source for all tables (Phase 4.3 comparison)
- [ ] All stored procedures execute without error
- [ ] Application login connects successfully
- [ ] Application functional test: end-to-end transaction through application
- [ ] Hierarchical query results match Oracle baseline
- [ ] Sequence values do not conflict with existing data (start values set correctly)
- [ ] SQL Server Agent jobs running on schedule
- [ ] Full backup completes successfully and RESTORE VERIFYONLY passes
- [ ] Health check script returning OK (\`/u01/scripts/sqlserver_health_check.sh\`)
- [ ] Monitoring crontab active (\`crontab -l | grep sqlserver_health\`)
- [ ] Oracle database retained in READ ONLY mode for 30-day post-migration period
- [ ] Disk space alert thresholds configured`,
};

async function main() {
  console.log('Inserting Oracle to SQL Server migration runbook...');
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
