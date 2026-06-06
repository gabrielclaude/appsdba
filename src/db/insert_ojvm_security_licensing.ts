import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Securing Oracle Databases: OJVM Vulnerabilities, Licensing Costs, and Safe Disablement',
  slug: 'oracle-ojvm-security-vulnerabilities-licensing-disable',
  excerpt:
    'A comprehensive guide to Oracle JVM (OJVM) security risk, the quarterly CVE landscape from Oracle Critical Patch Updates, why you cannot simply swap OJVM for an external JDK, what breaks when OJVM is removed, the safe procedure for disabling it in non-Java environments, and an honest breakdown of Oracle Java licensing costs — including the 2023 per-employee model change and how it interacts with OJVM, WebLogic, EBS, and standalone JDK deployments.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-06'),
  youtubeUrl: null,
  content: `## Introduction

Enterprise security teams have spent the better part of the last decade rationalising their Java runtimes. The migration from Oracle JDK to OpenJDK accelerated after Oracle changed its commercial licensing terms and became near-universal after the January 2023 Java SE Universal Subscription announcement, which moved Oracle Java SE to a per-employee pricing model regardless of actual usage. For most organisations, the combination of licensing cost certainty and a path to CVE reduction made OpenJDK an obvious choice for application servers, middleware, and development tooling.

The push to OpenJDK is sensible for external Java runtimes. But inside the Oracle Database, a separate Java engine operates under entirely different rules. The Oracle JVM — referred to as OJVM, and registered in the database as the JAVAVM component — is not an external process that can be swapped, upgraded independently, or replaced with an OpenJDK equivalent. It is compiled into the Oracle kernel and validated against each specific Database Release Update. When enterprise teams extend their Java audit to the database tier and ask "can we replace OJVM with OpenJDK?", the answer is no — and the consequences of attempting it range from ORA-29532 errors to data dictionary corruption.

This post covers the full picture that security and DBA teams need when evaluating OJVM in their environment. It examines the Oracle Java CVE landscape and why OJVM patches consistently appear in Oracle's quarterly Critical Patch Updates. It explains the architectural reason OJVM cannot be swapped. It inventories what breaks when OJVM is removed or disabled. It walks through the supported safe disablement path for environments that do not use Java features. And it provides an honest breakdown of Oracle Java licensing costs — what is covered by the Database license, what requires a separate Java SE subscription under the 2023 rules, and where EBS, WebLogic, and SOA Suite fit in.

---

## Oracle Java Vulnerabilities: The CVE Landscape

OJVM is one of the most consistently patched components in Oracle's quarterly Critical Patch Update (CPU) cycle. Across the last several years, each CPU has included between 5 and 15 Java-related CVEs affecting OJVM. This is not a recent trend — it reflects the fundamental complexity of running a general-purpose language runtime inside a database process with direct access to the database kernel's memory and file handles.

The CVSS scoring pattern for OJVM vulnerabilities is notable. OJVM CVEs frequently score 9.8 (Critical) on the CVSS v3.1 scale. The reason is the attack surface profile: a CVSS 9.8 score requires Network attack vector, Low attack complexity, No privileges required, No user interaction required, and High impact on Confidentiality, Integrity, and Availability. OJVM vulnerabilities can meet all of these conditions when the database listener is network-exposed and Java stored procedures or JDBC internal connections are reachable. An unauthenticated attacker who can reach the listener and trigger a vulnerable code path gets direct execution inside the RDBMS process.

The specific reason OJVM exploits are so dangerous is the in-process execution model. OJVM code does not run in a separate OS process that can be sandboxed or jailed. It runs inside the Oracle database process — the same process that holds the SGA, manages buffer cache blocks, writes redo, and reads datafiles. A successful OJVM exploit pivots directly from Java execution to database kernel memory. There is no OS-level boundary to cross. The OS user running the Oracle process, typically the oracle OS account, has read/write access to every datafile, redo log, and archive log. A compromised OJVM is a compromised database.

OJVM patches consistently lag behind the equivalent upstream OpenJDK patch for the same underlying vulnerability. This is not Oracle's negligence — it is the cost of the in-process architecture. Each OJVM fix must be validated against each supported Database Release Update. A vulnerability patched in OpenJDK 17 in, say, March cannot be incorporated into OJVM until Oracle has tested the fix against the RDBMS engine for every supported 19c, 21c, and 23ai RU. By the time the CPU arrives in April, the upstream fix has been public for weeks. This creates a window where the vulnerability is known and documented but OJVM in the database remains unpatched.

The quarterly CPU cycle runs on a fixed calendar: January, April, July, October. Each CPU supersedes the previous quarter's patches for OJVM. When teams miss a CPU, they are not just missing one quarter of fixes — they are missing all cumulative OJVM CVEs since their last applied patch. OJVM CVEs chain: a moderate-severity CVE in one quarter may enable exploitation of a Critical CVE in the next quarter. A database that is two CPUs behind (six months) may be carrying 10–30 unpatched Java CVEs, some of which form exploit chains that were theoretical individually but practical in combination.

The real-world execution entry points for OJVM CVE exploits are broader than most teams assume. Java stored procedures called via standard SQL execute OJVM code. JDBC internal connections (connecting from a Java stored procedure back to the same or a different database) are OJVM execution paths. XML processing through Oracle's XDK (XML Developer's Kit), which is a Java library that runs in OJVM, is an execution path. The SODA (Simple Oracle Document Access) API for JSON document storage has OJVM dependencies. Any application that touches these interfaces provides a potential entry point for an OJVM CVE exploit.

The database-specific risk amplification cannot be understated. A standalone JVM process running on an application server that is compromised is serious, but the blast radius is bounded: the attacker controls that JVM process. The OS can sandbox it, the network firewall limits outbound connections, and the damage is constrained to what that process can reach. OJVM compromise means DB files, SGA memory, active transactions, cryptographic keys stored in the database wallet, and every connected session's data are all in scope from a single exploit.

---

## Why You Cannot Simply Swap OJVM

The question "can we replace OJVM with OpenJDK?" reveals a common misunderstanding of OJVM's architecture. OJVM is not an external JDK installation that Oracle happens to ship alongside the database. It is embedded in the Oracle kernel — the shared library that is the Oracle RDBMS binary itself. There is no configuration option to point Oracle to a different JVM installation.

OJVM is tightly coupled to the SYS schema and the data dictionary at the object level. When Oracle installs JAVAVM, it creates thousands of Java class objects directly in the SYS schema. These are stored as \`JAVA CLASS\`, \`JAVA SOURCE\`, and \`JAVA RESOURCE\` object types in the data dictionary. The \`DBMS_JAVA\` package, the \`DBMS_JAVA_DEV\` package, and dozens of other PL/SQL packages that provide the bridge between SQL and Java execution are tied to these SYS-owned Java class objects. Removing or replacing the JVM binary would orphan all of these dictionary objects.

OJVM is version-locked to the specific Database Release Update installed on the system. The JAVAVM component in \`DBA_REGISTRY\` carries a version number that must match the installed RU. Introducing an external runtime that does not match this version causes ORA-29532 (Java call terminated by uncaught Java exception) and can produce data dictionary corruption if the version mismatch causes JAVAVM metadata to be written in an inconsistent state. Oracle does not support, test, or provide a path for running any Java runtime other than the one shipped with a given RU.

To verify the installed OJVM version and its current status:

\`\`\`sql
-- Check OJVM component registration in the data dictionary
SELECT comp_id,
       comp_name,
       version,
       version_full,
       status,
       modified,
       schema
FROM dba_registry
WHERE comp_id = 'JAVAVM'
ORDER BY comp_id;
-- STATUS should be VALID
-- VERSION should match your Database RU version (e.g., 19.22.0.0.0)
\`\`\`

To check which OJVM-related patches have been applied via \`datapatch\`:

\`\`\`sql
-- OJVM patches applied via datapatch (SQL patches)
SELECT patch_id,
       patch_uid,
       patch_type,
       status,
       action,
       action_time,
       description
FROM dba_registry_sqlpatch
WHERE UPPER(description) LIKE '%OJVM%'
   OR UPPER(description) LIKE '%JAVA%'
ORDER BY action_time DESC;
\`\`\`

The only supported path to update OJVM is Oracle's official CPU patch process: download the OJVM RU patch from My Oracle Support, apply it using \`opatch apply\` at the OS level, then run \`datapatch -verbose\` to apply the SQL-level data dictionary changes. Any attempt to modify OJVM outside this path is unsupported and will void Oracle Support's ability to assist with any resulting issues.

---

## What Breaks If You Lose OJVM

OJVM disablement or removal produces two categories of failure. The first category is direct dependencies — objects and packages that fail immediately upon any attempt to execute because they require an active JAVAVM engine. The second category is feature-based dependencies — Oracle Database features that happen to be implemented using OJVM internally, where the failure manifests as a feature outage rather than an obvious Java error.

**Direct Dependencies (instant failure):**

Java stored procedures, Java functions, and Java triggers all execute code stored as \`JAVA CLASS\` objects in the database. Any \`CALL\` to a Java stored procedure or any PL/SQL wrapper around a Java method fails with an OJVM error if the engine is disabled. Use the following queries to identify these objects before any disablement decision:

\`\`\`sql
-- Count Java objects by type across all schemas
SELECT object_type,
       owner,
       COUNT(*) AS object_count
FROM dba_objects
WHERE object_type LIKE 'JAVA%'
  AND owner NOT IN ('SYS', 'SYSTEM', 'OJVMSYS', 'DBSNMP', 'OUTLN', 'XDB')
ORDER BY owner, object_type;

-- Java stored procedures and functions (PL/SQL wrappers calling Java methods)
SELECT owner,
       object_name,
       procedure_name,
       aggregate,
       parallel
FROM dba_procedures
WHERE authid IS NOT NULL
  -- Oracle does not store LANGUAGE = 'JAVA' directly in DBA_PROCEDURES
  -- Instead look for the JAVA source wrapper pattern via DBA_SOURCE
ORDER BY owner, object_name;

-- More reliable: find PL/SQL units that contain LANGUAGE JAVA declarations
SELECT owner,
       name,
       type,
       line,
       text
FROM dba_source
WHERE UPPER(text) LIKE '%LANGUAGE JAVA%'
  AND owner NOT IN ('SYS', 'SYSTEM', 'OJVMSYS', 'XDB')
ORDER BY owner, name, line;
\`\`\`

The \`DBMS_JAVA\` package itself requires an active OJVM. Any application code that calls \`DBMS_JAVA.LOADJAVA\`, \`DBMS_JAVA.COMPILE_CLASS\`, or any other \`DBMS_JAVA\` subprogram will fail. Server-side JDBC — where a Java stored procedure opens a JDBC connection internally — is an OJVM execution path and will fail. Database web services built on top of the Oracle Web Services stack, which uses OJVM, will stop functioning.

**Feature-Based Dependencies (common surprises):**

Oracle Spatial (the \`MDSYS\` schema and SDO\_ types) uses OJVM internally for certain geometry processing operations. Environments running spatial queries may see unexpected errors after OJVM disablement even if no explicit Java code exists in the application schemas.

Oracle XML DB and the XDK (XML Developer's Kit) are Java libraries that run in OJVM. Applications that use \`XMLTYPE\` transformations, XSL processing, or Oracle's XML parsing APIs are exposed to OJVM disablement.

SODA (Simple Oracle Document Access) for JSON document storage has OJVM dependencies. The SODA PL/SQL API (\`DBMS_SODA\`) and the REST-based SODA interface both invoke OJVM components.

Oracle Text (the \`CTXSYS\` schema and \`CTX_\` packages) uses Java-based components for certain document filter and classification operations.

Oracle E-Business Suite mandates OJVM as part of its certified database baseline. Oracle's EBS certification documents explicitly require OJVM to be present and at the current CPU patch level. Attempting to disable OJVM on an EBS database renders it uncertified and will cause application errors in components that invoke Java-based database features.

\`\`\`sql
-- Check for active Oracle Spatial usage
SELECT COUNT(*) AS spatial_object_count
FROM dba_objects
WHERE object_type = 'TABLE'
  AND owner NOT IN ('SYS', 'SYSTEM', 'MDSYS', 'CTXSYS', 'XDB', 'DBSNMP', 'OUTLN')
  AND table_name IN (
    SELECT table_name FROM dba_tab_columns
    WHERE data_type LIKE 'SDO_%'
  );

-- Check for active Oracle Text indexes
SELECT idx_name, idx_table_owner, idx_table, idx_status
FROM ctxsys.ctx_indexes
ORDER BY idx_table_owner, idx_table;

-- Check for SODA collections
SELECT owner, collection_name, table_name
FROM all_soda_collections
WHERE owner NOT IN ('SYS', 'SYSTEM', 'APEX_PUBLIC_USER')
ORDER BY owner, collection_name;

-- Check if EBS FND tables exist (presence indicates EBS environment)
SELECT COUNT(*) AS ebs_present
FROM dba_tables
WHERE owner = 'APPLSYS'
  AND table_name = 'FND_PRODUCT_INSTALLATIONS';
\`\`\`

---

## Oracle Java Licensing: What You Are Actually Paying For

The Oracle Java licensing landscape is genuinely confusing, and it generates expensive mistakes in both directions — teams that think they owe Oracle Java licensing fees when they do not, and teams that do not know they owe fees when they do. Understanding where OJVM fits in this picture is essential for any DBA involved in a Java audit or an Oracle LMS engagement.

**Oracle Java SE licensing change (January 2023):** Oracle changed Java SE licensing in January 2023 to the "Java SE Universal Subscription," a per-employee pricing model. Under this model, an organisation licenses Oracle Java SE for the entire enterprise headcount regardless of how many employees actually use Java. A 10,000-employee company owes Oracle licensing fees based on all 10,000 employees — not just the developers or the servers running Oracle JDK. For large enterprises, this pricing change dramatically increased the cost of using Oracle JDK anywhere in the enterprise.

**The OJVM distinction:** OJVM inside the Oracle Database is not the same product as Oracle Java SE for desktop or server applications. OJVM is bundled with the Oracle Database license. It is part of the Oracle Database software that you license when you purchase Oracle Database Enterprise Edition or Standard Edition 2. You do not separately license OJVM as a Java SE product. This is a critical distinction that confuses many teams during Java audits — the auditors scanning for "Oracle Java" on servers will find OJVM in the database, but that component is covered by the Database license, not by Java SE subscriptions.

**What IS separately licensed under 2023 rules:** Oracle Java SE Universal Subscriptions cover external JDKs used anywhere in the enterprise — application servers, middleware, CI/CD pipelines, developer workstations, and standalone Java applications. WebLogic Server, Oracle SOA Suite, Oracle OBIEE, and Oracle Forms all use JVMs that run outside the database. If those JVMs run Oracle JDK, they fall under the Java SE Universal Subscription requirement.

**The OpenJDK migration cost trap:** Many teams have migrated external application tiers from Oracle JDK to OpenJDK specifically to avoid the 2023 Java SE subscription costs. This is a reasonable strategy for external runtimes. But the migration provides zero security benefit for OJVM inside the database. OJVM remains Oracle's runtime, requires Oracle's quarterly CPU patches, and cannot be replaced with OpenJDK. Teams that have migrated their WebLogic or application server JDKs to OpenJDK and consider their Java footprint "clean" may be surprised to discover that every Oracle Database in the environment still runs Oracle's Java engine requiring CPU patches.

**EBS and FMW licensing interaction:** Oracle E-Business Suite and Fusion Middleware (WebLogic Server, SOA Suite, Oracle Service Bus, OBIEE) each bring their own Java runtime requirements. The WebLogic Server license includes a Java SE subscription for the JVM that runs the WebLogic server process itself — but this coverage does not extend to other Java processes running on the same host. A WebLogic server host running ETL tools, reporting agents, or standalone Java applications in addition to WebLogic requires separate Java SE subscription coverage for those non-WebLogic processes.

**Database Options that use Java:** Oracle Spatial, Oracle Text, and Oracle XML DB are licensed Database Options (or included features depending on edition and version) that use OJVM internally. If your license includes these options, you are implicitly supporting the OJVM footprint they require. This does not change the licensing obligation — OJVM is still covered by the Database license — but it reinforces why disabling OJVM requires a thorough dependency audit.

**The audit trigger:** Oracle LMS (License Management Services) audits frequently flag Java usage that teams thought was covered by an existing product license but was not. The most common scenario is standalone Java processes — ETL tools, batch schedulers, reporting agents, custom integration scripts — running with Oracle JDK on the same server as an Oracle Database. The Database license covers the OJVM inside the database. It does not cover Oracle JDK processes running as separate OS processes on the same host. Each of those standalone processes requires Java SE subscription coverage under 2023 rules.

---

## The Safe Alternative: How to Properly Disable OJVM

For Oracle Database environments that genuinely do not use Java stored procedures, Java triggers, \`DBMS_JAVA\`, or any of the Java-dependent features described above, Oracle provides a supported path to lock the JAVAVM component so that no Java execution can occur. This is not the same as removing OJVM from the database — the JAVAVM component remains present in the data dictionary, which is necessary for database operation and patching. What changes is that the engine is placed in a locked state where execution is blocked.

The mechanism is the \`DBMS_JAVA_DEV\` package, specifically the \`DISABLE\` procedure. At the engine level, calling \`DBMS_JAVA_DEV.DISABLE\` marks the JAVAVM component in a locked state, prevents \`DBMS_JAVA.LOADJAVA\` from loading new Java classes into the database, and blocks \`DBMS_JAVA.COMPILE_CLASS\` from compiling Java source. Any attempt to execute a Java stored procedure or call a DBMS_JAVA subprogram after disablement returns an error. The JAVAVM component remains VALID in DBA_REGISTRY — it is locked, not removed.

For non-CDB (traditional single-instance) databases, the disable procedure is straightforward:

\`\`\`sql
-- Verify OJVM is VALID before disabling
SELECT comp_id, status, version FROM dba_registry WHERE comp_id = 'JAVAVM';

-- Connect as SYSDBA and disable OJVM
EXEC DBMS_JAVA_DEV.DISABLE;

-- Verify disabled state
SELECT comp_id, status FROM dba_registry WHERE comp_id = 'JAVAVM';

-- Verify V$OPTION reflects disabled Java
SELECT parameter, value FROM v\$option WHERE parameter = 'Java';
-- VALUE should be FALSE after disablement
\`\`\`

For CDB/PDB (container database) architectures, the requirement is more involved and the risk of incomplete disablement is real. OJVM must be disabled in CDB\$ROOT and in every open PDB. If even one PDB is missed, that PDB becomes a potential pivot point — a Java execution environment within the same database instance that nominally has Java disabled. This is the PDB drift problem.

\`\`\`sql
-- Connect to CDB$ROOT as SYSDBA
-- Step 1: Disable in CDB$ROOT
ALTER SESSION SET CONTAINER = CDB\$ROOT;
EXEC DBMS_JAVA_DEV.DISABLE;

-- Step 2: Disable in each open PDB
DECLARE
  v_sql VARCHAR2(200) := 'BEGIN DBMS_JAVA_DEV.DISABLE; END;';
BEGIN
  FOR p IN (SELECT pdb_name FROM dba_pdbs WHERE status = 'NORMAL') LOOP
    EXECUTE IMMEDIATE 'ALTER SESSION SET CONTAINER = ' || p.pdb_name;
    EXECUTE IMMEDIATE v_sql;
    DBMS_OUTPUT.PUT_LINE('Disabled OJVM in: ' || p.pdb_name);
  END LOOP;
  -- Return to CDB$ROOT
  EXECUTE IMMEDIATE 'ALTER SESSION SET CONTAINER = CDB\$ROOT';
END;
/

-- Verify all containers show disabled state
SELECT con_id, comp_id, status
FROM cdb_registry
WHERE comp_id = 'JAVAVM'
ORDER BY con_id;
\`\`\`

**The maintenance window timing rule is critical.** Before running \`datapatch\`, \`catctl.pl\`, or any database upgrade utility, OJVM must be re-enabled. These utilities interact directly with the JAVAVM component during their execution. If OJVM is in the disabled state when \`datapatch\` runs, it may complete partially, leaving the database component registry in an inconsistent state — some patches applied, others skipped because the Java engine was locked. The correct sequence for any patching operation:

1. Re-enable OJVM in CDB\$ROOT and all PDBs (see Phase 5 of the companion runbook)
2. Apply the OS-level patch using \`opatch apply\`
3. Run \`datapatch -verbose\`
4. Verify \`DBA_REGISTRY\` and \`DBA_REGISTRY_SQLPATCH\` show the patch as applied
5. Re-disable OJVM in CDB\$ROOT and all PDBs if the environment was previously disabled

For environments where OJVM cannot be disabled — EBS, environments with active Java stored procedures, or environments where Spatial, Text, or SODA are in active use — the risk mitigation path is regular CPU patching combined, optionally, with Oracle Advanced Security's virtual patching capabilities (available in environments licensed for the Advanced Security Option). Virtual patching can block specific exploit patterns at the SQL level while the CPU patch is being tested and scheduled for deployment, reducing the exposure window between CPU release and patch application.

---

## Summary: Oracle Java Licensing at a Glance

Oracle Java licensing is frequently mischaracterised in both directions — as simpler than it is, and as more complex than it needs to be for the database DBA's day-to-day work. The key to clarity is separating the three distinct Java footprints that exist in a typical Oracle environment and understanding which license covers each.

OJVM inside the Oracle Database is bundled with the Oracle Database license. There is no separate Java SE subscription required to run OJVM. The obligation for OJVM is not licensing — it is patching. Every quarterly CPU contains OJVM CVE fixes, and every unpatched CPU cycle is a compounding security debt. For the database DBA, the primary Java-related obligation is keeping OJVM patched via quarterly CPUs. OpenJDK migrations in the application tier do not change this obligation in any way.

Oracle Java SE Universal Subscription (2023 and later) is the per-employee licensing model that covers Oracle JDK usage anywhere in the enterprise outside of products that include their own Java runtime entitlement. This model fundamentally changed the economics of Oracle Java for external runtimes. A development team of 50 engineers and a production environment with no Oracle JDK usage still owes per-employee fees if Oracle JDK is installed on any developer workstation. The universal nature of the subscription is also its most expensive aspect — there is no "server only" option.

OpenJDK is free and carries no Oracle licensing obligation. The Adoptium (formerly AdoptOpenJDK) distribution, Amazon Corretto, Red Hat's OpenJDK distribution, and Azul Zulu all provide production-quality OpenJDK builds with no Oracle license fees. Teams running external application servers, middleware, or standalone Java applications can eliminate Oracle Java SE subscription costs by migrating to any of these distributions. The security maintenance terms vary by vendor — Adoptium provides long-term support builds, Amazon Corretto includes security patches aligned with AWS support lifecycle, and Red Hat OpenJDK is covered by RHEL subscription.

The three distinct Java footprints in a typical Oracle environment are: (1) OJVM inside the Oracle Database, covered by the Database license, patched via CPU; (2) Oracle JDK or Java SE in Oracle Middleware products — WebLogic Server, Oracle SOA Suite, Oracle Service Bus, OBIEE, Oracle Forms — which are covered by the product license or by an included Java SE subscription entitlement that comes with the WebLogic or middleware license; and (3) standalone Oracle JDK on application servers running non-Oracle-product Java processes — ETL tools, batch jobs, custom integrations, reporting agents — which require a Java SE Universal Subscription under 2023 rules. The mistake most teams make during Java audits is conflating categories 2 and 3, assuming that the Java SE entitlement bundled with WebLogic extends to all Java processes on that server. It does not.

Practical guidance for Oracle environments: audit which servers run Oracle JDK processes and categorise each process into one of the three footprint categories. For processes in category 2 (Oracle Middleware products), confirm the product license includes Java SE entitlement — WebLogic Server licenses do include this, but confirm for your specific product version and license type. For processes in category 3 (standalone Oracle JDK processes), evaluate migration to OpenJDK as a cost reduction measure. For all Oracle Databases, focus security effort on CPU patching OJVM on the quarterly schedule — not on OpenJDK swaps, which have no effect on the in-database Java runtime.

The bottom line for the database DBA is straightforward even if the broader Oracle Java licensing landscape is not. OJVM is covered by the Database license you already hold. The security obligation is quarterly CPU patching. In environments that do not use Java features, the supported operational security measure is disabling OJVM via \`DBMS_JAVA_DEV.DISABLE\` — remembering to re-enable before any patching or upgrade operation. The OpenJDK migration conversation is relevant to your application server colleagues and to your organisation's Oracle LMS preparation, but it does not change what you need to do with the database's own Java runtime. Patch it quarterly, audit it for active use before disabling it, and treat its CVE score as what it is: a measure of what is at stake if you let the patching cadence slip.`,
};

async function main() {
  console.log('Inserting Oracle OJVM security and licensing post...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: {
      title: post.title,
      excerpt: post.excerpt,
      content: post.content,
      published: post.published,
      publishedAt: post.publishedAt,
      isPremium: post.isPremium,
    },
  });
  console.log(`Inserted: "${post.title}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
