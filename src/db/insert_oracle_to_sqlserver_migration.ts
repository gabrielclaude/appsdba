import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Migrating from Oracle 19c to SQL Server 2022 on Linux: Architecture, Planning, and Pitfalls',
  slug: 'oracle-19c-to-sql-server-linux-migration',
  excerpt:
    'A comprehensive guide to migrating Oracle 19c databases to Microsoft SQL Server 2022 on Linux: licensing cost comparison, schema and data type mapping, PL/SQL to T-SQL conversion challenges, SQL Server on Linux architecture, migration tooling (SSMA, ora2pg, bcp), and the operational differences DBAs encounter post-migration.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-07'),
  youtubeUrl: null,
  content: `## Introduction

SQL Server on Linux has been production-ready since SQL Server 2017, and with SQL Server 2022's deepened Linux support, the platform has matured into a credible alternative to Oracle 19c for on-premises and hybrid workloads. For organisations carrying Oracle Database Enterprise Edition licensing costs — typically \$47,500 per processor core plus annual support — the SQL Server Standard Edition cap of 24 cores and significantly lower per-core pricing can represent millions in savings for mid-size deployments. The arrival of SQL Server on Red Hat Enterprise Linux, Oracle Linux, SUSE, and Ubuntu means that teams can consolidate on a single operating system without reintroducing Windows infrastructure.

This post covers the full picture of what migration from Oracle 19c to SQL Server 2022 on Linux involves: the architectural differences between the two engines, the data type and schema object mapping decisions, the PL/SQL to T-SQL conversion challenge, the tooling landscape, and the operational shifts that DBAs encounter after the migration. The companion runbook provides the step-by-step commands.

---

## Why Migrate: Licensing and Platform Context

### Oracle Database Licensing

Oracle Database 19c (Extended Support through November 2027, Sustaining Support thereafter) is licensed per processor using Oracle's core factor table. On Intel x86 processors the core factor is 0.5, meaning a 32-core server requires 16 Oracle processor licenses. At Enterprise Edition list price of \$47,500 per processor license, a single 32-core server costs \$760,000 in license fees before annual support (22% of license, approximately \$167,200/year). Real Application Clusters adds \$23,000 per processor. Partitioning, Advanced Security, and Diagnostics Pack each add further per-processor costs.

Options like Oracle Database Standard Edition 2 cap at 2 sockets and lack RAC, Partitioning, and most diagnostic tools — making SE2 an unsuitable replacement for Enterprise Edition workloads without significant application redesign.

### SQL Server 2022 Licensing

SQL Server 2022 Enterprise Edition lists at \$15,123 per core (2-core packs), making it approximately one-third the per-core cost of Oracle EE. Standard Edition lists at \$3,945 per core with a 24-core cap per instance. For workloads that fit Standard Edition's feature set, the total cost of ownership difference over a 5-year period on equivalent hardware is often in the 70–80% savings range.

SQL Server 2022 introduced enhanced Azure connectivity features (Azure Synapse Link, managed disaster recovery via Azure Arc) that Oracle does not offer natively. For organisations already using Azure, these integrations can justify migration independent of pure licensing cost.

### SQL Server on Linux Architecture

SQL Server on Linux runs via the SQL Platform Abstraction Layer (SQLPAL), a technology derived from the DrawBridge research project at Microsoft that wraps a Windows kernel API implementation inside the Linux process space. From a DBA perspective, this means SQL Server on Linux behaves identically to SQL Server on Windows at the T-SQL and client connectivity level — the same DMVs, the same system stored procedures, the same SSMS connection. The differences are in the OS-level tooling: backups go to Linux paths, SQL Server Agent jobs call Linux shell scripts rather than Windows CMD, and configuration is done via \`mssql-conf\` rather than Windows Registry.

Supported Linux distributions for SQL Server 2022:
- Red Hat Enterprise Linux 8.x, 9.x
- Oracle Linux 8.x, 9.x
- SUSE Linux Enterprise Server 15
- Ubuntu 20.04, 22.04
- Container images on Docker/Podman/Kubernetes

---

## Architectural Mapping: Oracle vs SQL Server Concepts

Understanding the conceptual mapping between Oracle and SQL Server is the foundation for migration planning. These are not one-to-one translations — each platform has opinions about data organisation, transaction management, and administration that must be understood rather than blindly mapped.

### Database and Schema Hierarchy

Oracle's hierarchy is: **Database → CDB/PDB (12c+) → Schema → Objects**. In Oracle, each schema is owned by a database user. The HR user owns the HR schema. You connect as a user and automatically have a context of that user's schema.

SQL Server's hierarchy is: **Instance → Database → Schema → Objects**. In SQL Server, a schema is a namespace within a database — it is not tied to a login. The \`dbo\` schema is the default. Multiple schemas (e.g., \`hr\`, \`finance\`) can exist in the same database and are owned by roles rather than logins. A user can be mapped to a login and granted access to multiple schemas.

Migration implication: if your Oracle instance has 10 schemas representing different application modules, the typical SQL Server approach is to create one database with 10 schemas. Each Oracle schema maps to a SQL Server schema within a single database.

### Tablespaces vs Filegroups

Oracle stores data in **tablespaces**, each backed by one or more datafiles. Every object is assigned to a tablespace. Tablespace management (autoextend, resize, add datafile) is a common DBA task.

SQL Server uses **filegroups**, each containing one or more data files (.mdf, .ndf). Every table and index is assigned to a filegroup. The PRIMARY filegroup is the default. Read-only filegroups enable read-only partitioned data — equivalent to Oracle read-only tablespaces.

Migration implication: tablespace-to-filegroup mapping is generally straightforward but requires decisions about file layout for optimal I/O distribution. Oracle AWR tablespace I/O statistics can guide filegroup placement.

### Sequences and Identity

Oracle uses **SEQUENCES** (separate objects, referenced with \`sequence_name.NEXTVAL\`) for surrogate keys. The sequence object is explicit and can be queried, reset, cached, and audited independently.

SQL Server offers two mechanisms:
- **IDENTITY** columns (implicit, per-table, \`IDENTITY(1,1)\`)
- **SEQUENCE** objects (SQL Server 2012+, functionally equivalent to Oracle sequences, referenced with \`NEXT VALUE FOR sequence_name\`)

For migrations, Oracle sequences map cleanly to SQL Server SEQUENCE objects. IDENTITY columns are simpler for single-table auto-increment keys but lose the ability to share a sequence across tables.

### Dual Table

Oracle's \`SELECT SYSDATE FROM DUAL\` has no SQL Server equivalent — SQL Server does not require a FROM clause for scalar expressions. Every Oracle query using DUAL must have DUAL removed: \`SELECT GETDATE()\` is the SQL Server equivalent.

This affects thousands of queries in typical Oracle applications. SSMA handles this automatically during schema conversion, but hand-written queries and stored procedures must be reviewed.

### NULL Handling Differences

Oracle treats empty string (\`''\`) as NULL. SQL Server does not — empty string is a valid non-null value. Any Oracle code that compares \`column = ''\` or inserts \`''\` expecting NULL behaviour will produce different results in SQL Server. This is one of the most subtle migration bugs.

### ROWNUM and Row Limiting

Oracle's \`WHERE ROWNUM <= 10\` for pagination maps to SQL Server's \`SELECT TOP 10\` or \`OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY\` (ANSI syntax, supported by SQL Server 2012+). Oracle 12c introduced \`FETCH FIRST N ROWS ONLY\` which is ANSI-compatible and works identically in SQL Server.

Applications using ROWNUM-based pagination require query rewriting. ORM frameworks (Hibernate, MyBatis) typically handle this transparently when the dialect is switched.

---

## Data Type Mapping

Accurate data type mapping is the most consequential technical decision in the migration. Incorrect mapping produces data truncation, precision loss, or performance regressions.

| Oracle Type | SQL Server Equivalent | Notes |
|---|---|---|
| \`NUMBER(p,s)\` | \`DECIMAL(p,s)\` | Exact mapping for precision ≤ 38 |
| \`NUMBER\` (no precision) | \`FLOAT(53)\` or \`DECIMAL(38,10)\` | Float loses precision; DECIMAL is safer |
| \`INTEGER\` / \`NUMBER(10,0)\` | \`INT\` or \`BIGINT\` | Use BIGINT if values exceed 2.1B |
| \`FLOAT\` | \`FLOAT(53)\` | IEEE 754 double-precision |
| \`VARCHAR2(n)\` | \`VARCHAR(n)\` | Byte vs char semantics — see below |
| \`NVARCHAR2(n)\` | \`NVARCHAR(n)\` | Unicode, direct mapping |
| \`CHAR(n)\` | \`CHAR(n)\` | Fixed-length, same semantics |
| \`DATE\` | \`DATETIME2(0)\` | Oracle DATE includes time; SQL DATE is date-only |
| \`TIMESTAMP\` | \`DATETIME2(6)\` | Up to 7 digits fractional seconds in SQL Server |
| \`TIMESTAMP WITH TIME ZONE\` | \`DATETIMEOFFSET\` | Stores offset, not zone name |
| \`INTERVAL\` | No direct equivalent | Must use computed columns or app logic |
| \`CLOB\` | \`VARCHAR(MAX)\` or \`NVARCHAR(MAX)\` | 2GB max; consider NVARCHAR for Unicode |
| \`BLOB\` | \`VARBINARY(MAX)\` | Binary large object |
| \`XMLTYPE\` | \`XML\` | SQL Server XML type has different query syntax (XQuery vs Oracle XMLQuery) |
| \`RAW(n)\` | \`VARBINARY(n)\` | Binary data |
| \`LONG\` | \`VARCHAR(MAX)\` | Deprecated in Oracle; migrate to CLOB/VARCHAR(MAX) |
| \`ROWID\` | No equivalent | Physical address concept; redesign queries |

**VARCHAR2 byte vs character semantics**: Oracle VARCHAR2(100) defaults to 100 bytes. In multibyte character sets (AL32UTF8), a single character may use 3–4 bytes, so VARCHAR2(100) stores fewer than 100 characters for non-ASCII content. SQL Server VARCHAR(n) counts characters. Size columns appropriately or you will have truncation errors on data load.

**Oracle DATE contains time**: This is the most common data migration surprise. \`TO_DATE('2026-06-07', 'YYYY-MM-DD')\` in Oracle stores midnight of that date, but Oracle DATE has time precision to seconds. Many Oracle DBAs assume DATE is date-only and discover time components in their data during migration. SQL Server \`DATE\` type is genuinely date-only — if time components exist, use \`DATETIME2\`.

---

## PL/SQL to T-SQL Conversion

PL/SQL is Oracle's procedural language extension to SQL. T-SQL is SQL Server's equivalent. The two languages share ANSI SQL but diverge significantly in procedural constructs, exception handling, package organisation, and built-in functions.

### Packages

Oracle **packages** (PACKAGE + PACKAGE BODY) group related procedures, functions, types, and variables under a namespace. SQL Server has no package concept. Each Oracle package typically maps to:
- A SQL Server **schema** (for namespace)
- Individual stored procedures and functions within that schema
- Package-level constants → SQL Server does not have constant variables; use a lookup table or embedded literals

### Exception Handling

Oracle:
\`\`\`sql
BEGIN
  ...
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    ...
  WHEN OTHERS THEN
    RAISE_APPLICATION_ERROR(-20001, 'Error: ' || SQLERRM);
END;
\`\`\`

SQL Server T-SQL:
\`\`\`sql
BEGIN TRY
  ...
END TRY
BEGIN CATCH
  IF ERROR_NUMBER() = 0 -- no equivalent for NO_DATA_FOUND
    ...
  THROW 50001, 'Error: ' + ERROR_MESSAGE(), 1;
END CATCH
\`\`\`

The NO_DATA_FOUND exception (Oracle raises this when SELECT INTO returns no rows) has no direct SQL Server equivalent — SQL Server SELECT INTO with no rows sets \`@@ROWCOUNT\` to 0 but does not raise an exception. Every Oracle procedure using SELECT INTO + NO_DATA_FOUND handler must be rewritten to check \`@@ROWCOUNT\` after the select.

### Cursors and Bulk Operations

Oracle's \`BULK COLLECT INTO\` and \`FORALL\` for set-based DML have T-SQL equivalents in table-valued variables and \`INSERT ... SELECT\` / \`UPDATE ... FROM\` joins. Cursor-based row-by-row processing should be refactored to set-based operations in both databases, but the T-SQL refactoring is an opportunity to improve performance.

### Common Built-in Function Differences

| Oracle Function | SQL Server Equivalent |
|---|---|
| \`NVL(x, y)\` | \`ISNULL(x, y)\` or \`COALESCE(x, y)\` |
| \`NVL2(x, y, z)\` | \`IIF(x IS NOT NULL, y, z)\` or \`CASE\` |
| \`DECODE(x, v1, r1, v2, r2, def)\` | \`CASE x WHEN v1 THEN r1 WHEN v2 THEN r2 ELSE def END\` |
| \`SUBSTR(str, pos, len)\` | \`SUBSTRING(str, pos, len)\` |
| \`INSTR(str, sub)\` | \`CHARINDEX(sub, str)\` (note: arg order reversed) |
| \`TO_CHAR(date, 'YYYY-MM-DD')\` | \`FORMAT(date, 'yyyy-MM-dd')\` or \`CONVERT(VARCHAR, date, 23)\` |
| \`TO_DATE(str, fmt)\` | \`CONVERT(DATETIME2, str)\` or \`CAST(str AS DATETIME2)\` |
| \`SYSDATE\` | \`GETDATE()\` |
| \`SYSTIMESTAMP\` | \`SYSDATETIME()\` |
| \`TRUNC(date)\` | \`CAST(date AS DATE)\` |
| \`ADD_MONTHS(d, n)\` | \`DATEADD(MONTH, n, d)\` |
| \`MONTHS_BETWEEN(d1, d2)\` | \`DATEDIFF(MONTH, d2, d1)\` (approximate) |
| \`CONNECT BY PRIOR\` (hierarchical) | \`WITH ... AS (recursive CTE)\` |
| \`LISTAGG(col, ',') WITHIN GROUP\` | \`STRING_AGG(col, ',')\` (SQL Server 2017+) |
| \`PIVOT\` / \`UNPIVOT\` | \`PIVOT\` / \`UNPIVOT\` (different syntax) |
| \`ROWNUM\` | \`TOP n\` or \`ROW_NUMBER() OVER (ORDER BY ...))\` |

### CONNECT BY Hierarchical Queries

Oracle's \`START WITH ... CONNECT BY PRIOR\` for tree traversal is one of the most frequently rewritten constructs. SQL Server uses recursive Common Table Expressions (CTEs):

Oracle:
\`\`\`sql
SELECT employee_id, manager_id, LEVEL
FROM employees
START WITH manager_id IS NULL
CONNECT BY PRIOR employee_id = manager_id;
\`\`\`

SQL Server:
\`\`\`sql
WITH emp_hierarchy AS (
  SELECT employee_id, manager_id, 1 AS level_num
  FROM employees
  WHERE manager_id IS NULL
  UNION ALL
  SELECT e.employee_id, e.manager_id, h.level_num + 1
  FROM employees e
  JOIN emp_hierarchy h ON e.manager_id = h.employee_id
)
SELECT employee_id, manager_id, level_num
FROM emp_hierarchy;
\`\`\`

---

## Migration Tooling

### SQL Server Migration Assistant (SSMA) for Oracle

SSMA is Microsoft's free migration tool, available as a Windows desktop application. It connects to both Oracle and SQL Server, performs schema assessment and automated conversion, and migrates data. SSMA handles:
- Schema object conversion (tables, views, indexes, constraints, procedures, functions, packages, triggers)
- Data type mapping with configurable overrides
- Data migration with row-count validation
- Assessment reports showing conversion complexity and manual intervention requirements

SSMA assessment reports are the best starting point for any migration — they quantify the scope of work, identify unconvertible objects, and estimate migration effort. Run the assessment before committing to a timeline.

### ora2pg

ora2pg is an open-source Perl-based migration tool that exports Oracle schema and data to PostgreSQL-compatible SQL. For SQL Server migrations, it is less directly applicable than SSMA, but it is useful for:
- Schema inventory and reporting
- Generating DDL for review
- Linux-native workflow (no Windows desktop required for SSMA)

### SQL Server Integration Services (SSIS) and BCP

For large data volumes, SSMA's built-in data migration may be too slow. SSIS packages or BCP (Bulk Copy Program) with Oracle Linked Server can achieve significantly higher throughput. BCP bulk loads can hit 100–200 MB/s on fast storage. SSIS Oracle connectors (ATTUNITY or Microsoft Oracle Connector) enable direct Oracle-to-SQL Server streaming.

On Linux, SSIS runs via the SSIS Scale Out feature or in containers. BCP is natively available in the \`mssql-tools\` package.

---

## SQL Server on Linux: DBA Operational Differences

### Configuration: mssql-conf

SQL Server on Windows uses the Registry for configuration. On Linux, \`mssql-conf\` is the command-line configuration tool:

\`\`\`bash
# Set max memory (equivalent to Oracle SGA/PGA sizing)
sudo /opt/mssql/bin/mssql-conf set memory.memorylimitmb 16384

# Set default data and log directories
sudo /opt/mssql/bin/mssql-conf set filelocation.defaultdatadir /data/sqlserver
sudo /opt/mssql/bin/mssql-conf set filelocation.defaultlogdir /data/sqlserver/log

# Enable SQL Server Agent
sudo /opt/mssql/bin/mssql-conf set sqlagent.enabled true
\`\`\`

### Backup and Restore

SQL Server on Linux writes backups to Linux file paths. The syntax is identical to Windows:
\`\`\`sql
BACKUP DATABASE mydb TO DISK = '/backup/mydb.bak'
WITH COMPRESSION, CHECKSUM, STATS = 10;
\`\`\`
SQL Server Agent on Linux executes T-SQL backup jobs. Backups can also be sent directly to Azure Blob Storage with the \`TO URL\` syntax — a capability Oracle requires separate Cloud Storage licensing to match.

### High Availability

SQL Server on Linux supports Always On Availability Groups (equivalent to Oracle Data Guard + RAC in terms of capability). AG setup on Linux uses Pacemaker as the cluster resource manager (on RHEL/SLES) or a cluster-independent endpoint for Azure environments. Always On AGs provide:
- Synchronous replication (RPO = 0)
- Automatic failover
- Readable secondary replicas (equivalent to Oracle Active Data Guard)

SQL Server Failover Cluster Instances (FCI) — shared-disk clustering equivalent to Oracle RAC — are also supported on Linux with shared storage.

---

## Features Oracle Has That SQL Server Does Not

Planning a migration requires honest assessment of Oracle features that have no SQL Server equivalent or require significant workaround:

**Flashback Technology**: Oracle's Flashback Query (\`AS OF TIMESTAMP\`), Flashback Table, and Flashback Database have no SQL Server equivalent. SQL Server's Temporal Tables provide point-in-time query capability for tables explicitly created as temporal, but not for all tables retroactively. Flashback Database recovery cannot be replicated in SQL Server without restoring from backup.

**Real Application Clusters (RAC)**: Oracle RAC allows multiple database instances to share a single physical database, providing both HA and scale-out read/write throughput. SQL Server's equivalent (FCI) provides HA via active/passive failover but not active/active shared-disk clustering. Always On AGs provide scale-out reads via readable secondaries but writes go to a single primary.

**Advanced Partitioning**: Oracle's range-interval, list-hash composite, and reference partitioning options exceed SQL Server's partitioning capabilities. SQL Server supports range and hash partitioning via partition functions and schemes, but composite and reference partitioning require application-level redesign.

**Materialized Views with Query Rewrite**: Oracle's query rewrite feature transparently redirects queries to a materialized view without application changes. SQL Server's indexed views offer some similar optimisation for simple queries, but the optimizer does not automatically rewrite complex queries to use indexed views.

**DBMS_SCHEDULER / DBMS_JOB**: Oracle's scheduler supports complex job chains, event-driven jobs, and external program execution within the database. SQL Server Agent provides similar functionality but with different syntax and concepts.

---

## Conclusion

Migrating from Oracle 19c to SQL Server 2022 on Linux is technically feasible and financially compelling for organisations carrying Enterprise Edition licensing costs. The migration is not a lift-and-shift — PL/SQL to T-SQL conversion, Oracle-specific feature replacement, and data type mapping require careful planning and testing. SSMA's assessment report is the essential first step: it quantifies the schema complexity, flags unconvertible objects, and gives the project team an honest view of the effort required.

The payoff is a modern, Linux-native database platform with strong HA capabilities, mature cloud integration, and a significantly lower licensing baseline. For teams already running RHEL or Oracle Linux for their application tier, consolidating the database tier on the same OS eliminates the Windows Server licensing and management overhead that previously came with SQL Server.

The companion runbook provides the step-by-step commands for a complete Oracle 19c to SQL Server 2022 on Linux migration.`,
};

async function main() {
  console.log('Inserting Oracle to SQL Server migration post...');
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
