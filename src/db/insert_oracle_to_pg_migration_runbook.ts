import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle to PostgreSQL Migration',
  slug: 'oracle-to-postgresql-migration-runbook',
  excerpt:
    'End-to-end migration runbook for moving an Oracle Database schema and data to PostgreSQL using ora2pg. Covers tool installation, assessment report generation, schema DDL conversion, data type mapping, PL/SQL to PL/pgSQL conversion patterns, bulk data migration with COPY, sequence reset, row-count and checksum validation, and the cutover procedure.',
  category: 'postgresql' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-09'),
  youtubeUrl: null,
  content: `## Purpose and Scope

This runbook provides the complete end-to-end procedure for migrating an Oracle Database schema and data to PostgreSQL using **ora2pg**. It covers assessment, schema conversion, data migration, validation, and cutover.

**Reference post:** [Migrating from Oracle to PostgreSQL: A Practical Guide](/posts/oracle-to-postgresql-migration)

**Tool versions:** ora2pg 23.x, Oracle 19c source, PostgreSQL 17 target.

---

## Prerequisites

| Item | Requirement |
|------|-------------|
| Oracle source | DBA read access; \`SELECT ANY TABLE\`, \`SELECT ANY DICTIONARY\` privileges |
| PostgreSQL target | Superuser or a role with \`CREATE DATABASE\` |
| Migration host | Linux server with network access to both databases |
| Perl | 5.10+ (for ora2pg) |
| Oracle Instant Client | Matching major version to source — needed by DBD::Oracle |

---

## Phase 1 — Install ora2pg

### 1.1 Install dependencies (RHEL/OEL)

\`\`\`bash
dnf install -y perl perl-DBI perl-DBD-Pg cpan
dnf install -y oracle-instantclient-basiclite oracle-instantclient-devel
\`\`\`

### 1.2 Install DBD::Oracle via CPAN

\`\`\`bash
export ORACLE_HOME=/usr/lib/oracle/19.24/client64
export LD_LIBRARY_PATH=\$ORACLE_HOME/lib:\$LD_LIBRARY_PATH

cpan install DBD::Oracle
\`\`\`

### 1.3 Install ora2pg

\`\`\`bash
cd /opt
curl -L https://github.com/darold/ora2pg/archive/refs/tags/v23.1.tar.gz | tar xz
cd ora2pg-23.1
perl Makefile.PL
make && make install
\`\`\`

Verify:

\`\`\`bash
ora2pg --version
# ora2pg version 23.1
\`\`\`

### 1.4 Install Ubuntu dependencies

\`\`\`bash
apt-get install -y libdbi-perl libdbd-pg-perl libaio1 cpanminus
cpanm DBD::Oracle
\`\`\`

---

## Phase 2 — Configure ora2pg

Create a working directory for the migration project:

\`\`\`bash
mkdir -p /opt/migration/{config,schema,data,reports}
cp /usr/local/share/ora2pg/ora2pg.conf /opt/migration/config/ora2pg.conf
\`\`\`

Edit \`/opt/migration/config/ora2pg.conf\` with the Oracle connection and target settings:

\`\`\`ini
# Oracle source connection
ORACLE_DSN      dbi:Oracle:host=oracle-host;sid=PRODDB;port=1521
ORACLE_USER     migration_user
ORACLE_PWD      YourOraclePassword

# Schema to migrate (leave blank to migrate all schemas)
SCHEMA          APPOWNER

# PostgreSQL target connection (used for direct import mode)
PG_DSN          dbi:Pg:dbname=appdb;host=pg-host;port=5432
PG_USER         postgres
PG_PWD          YourPGPassword

# Output encoding
NLS_LANG        AMERICAN_AMERICA.AL32UTF8

# Data type overrides — map Oracle DATE to PostgreSQL TIMESTAMP
DATA_TYPE       DATE:timestamp without time zone

# Preserve case — set to 1 if application uses quoted uppercase identifiers
PRESERVE_CASE   0

# Number of parallel export processes for data migration
JOBS            4

# Directory for output files
OUTPUT_DIR      /opt/migration/schema

# Disable Oracle-specific hints in converted SQL
DISABLE_COMMENT 1
\`\`\`

---

## Phase 3 — Assessment Report

Run the ora2pg assessment before any schema work. It scores each object type by migration complexity (A=trivial through E=requires manual rewrite).

\`\`\`bash
ora2pg -c /opt/migration/config/ora2pg.conf \
       --type SHOW_REPORT \
       --estimate_cost \
       --dump_as_html \
       -o /opt/migration/reports/assessment.html
\`\`\`

Open \`assessment.html\` in a browser. Key sections to review:

| Section | What to look for |
|---------|-----------------|
| **Migration level** | Overall A–E score — E means significant manual work |
| **Tables** | Count and any tables with unsupported column types |
| **Views** | Complex views using Oracle-specific syntax |
| **Procedures / Functions** | PL/SQL complexity — count of \`TODO\` markers ora2pg injects where manual rewrite is needed |
| **Packages** | High count = high manual effort (no direct equivalent in PostgreSQL) |
| **Triggers** | Trigger body complexity |
| **Sequences** | Should all convert cleanly |

Save the report to the project record. It becomes the work estimate baseline.

---

## Phase 4 — Schema Extraction and Conversion

Extract each object type separately so they can be reviewed and adjusted independently.

### 4.1 Tables

\`\`\`bash
ora2pg -c /opt/migration/config/ora2pg.conf \
       --type TABLE \
       -o /opt/migration/schema/01_tables.sql
\`\`\`

Review \`01_tables.sql\` for:
- \`NUMBER\` columns without precision — ora2pg maps these to \`NUMERIC\`. For integer-only columns, change to \`INTEGER\` or \`BIGINT\` for better performance.
- \`DATE\` columns — confirm all are mapped to \`TIMESTAMP\`, not \`DATE\`.
- \`VARCHAR2\` byte semantics — if the Oracle database used byte semantics and the app stores multibyte characters, column lengths may need increasing.
- \`CHAR\` columns — PostgreSQL pads with spaces exactly as Oracle does, but consider converting to \`VARCHAR\` if the fixed-length behaviour is not intentional.

### 4.2 Sequences

\`\`\`bash
ora2pg -c /opt/migration/config/ora2pg.conf \
       --type SEQUENCE \
       -o /opt/migration/schema/02_sequences.sql
\`\`\`

### 4.3 Indexes and Constraints

\`\`\`bash
ora2pg -c /opt/migration/config/ora2pg.conf \
       --type PKEY \
       -o /opt/migration/schema/03_primary_keys.sql

ora2pg -c /opt/migration/config/ora2pg.conf \
       --type UKEY \
       -o /opt/migration/schema/04_unique_keys.sql

ora2pg -c /opt/migration/config/ora2pg.conf \
       --type FKEY \
       -o /opt/migration/schema/05_foreign_keys.sql

ora2pg -c /opt/migration/config/ora2pg.conf \
       --type INDEX \
       -o /opt/migration/schema/06_indexes.sql

ora2pg -c /opt/migration/config/ora2pg.conf \
       --type CHECK \
       -o /opt/migration/schema/07_check_constraints.sql
\`\`\`

**Note:** Load foreign keys and indexes **after** data migration. Loading them before inserting data means every insert validates the constraint and updates the index — dramatically slower. The correct load order is:

1. Tables (no constraints except PK/NOT NULL)
2. Data
3. Primary keys
4. Unique keys
5. Indexes
6. Foreign keys
7. Check constraints

### 4.4 Views

\`\`\`bash
ora2pg -c /opt/migration/config/ora2pg.conf \
       --type VIEW \
       -o /opt/migration/schema/08_views.sql
\`\`\`

Review for: \`ROWNUM\` (→ \`LIMIT\`/\`ROW_NUMBER()\`), Oracle date functions, \`DECODE\` (→ \`CASE\`), \`NVL\` (→ \`COALESCE\`), \`(+)\` outer join syntax (→ standard \`LEFT JOIN\`).

### 4.5 Stored Procedures and Functions

\`\`\`bash
ora2pg -c /opt/migration/config/ora2pg.conf \
       --type PROCEDURE \
       -o /opt/migration/schema/09_procedures.sql

ora2pg -c /opt/migration/config/ora2pg.conf \
       --type FUNCTION \
       -o /opt/migration/schema/10_functions.sql
\`\`\`

Search for ora2pg TODO markers — these mark code ora2pg could not convert automatically:

\`\`\`bash
grep -n "TODO" /opt/migration/schema/09_procedures.sql
grep -n "TODO" /opt/migration/schema/10_functions.sql
\`\`\`

Each TODO requires manual review. Common manual rewrites:

**CONNECT BY → WITH RECURSIVE:**
\`\`\`sql
-- Replace in any function that uses hierarchical query
WITH RECURSIVE tree AS (
    SELECT id, parent_id, name, 1 AS depth
    FROM   categories WHERE parent_id IS NULL
    UNION ALL
    SELECT c.id, c.parent_id, c.name, t.depth + 1
    FROM   categories c JOIN tree t ON c.parent_id = t.id
)
SELECT * FROM tree;
\`\`\`

**Oracle cursor FOR loop → PostgreSQL FOR loop:**
\`\`\`sql
-- Oracle
FOR rec IN (SELECT * FROM orders WHERE status = 'PENDING') LOOP
    process_order(rec.order_id);
END LOOP;

-- PostgreSQL (nearly identical — often converts cleanly)
FOR rec IN SELECT * FROM orders WHERE status = 'PENDING' LOOP
    PERFORM process_order(rec.order_id);
END LOOP;
\`\`\`

**DBMS_OUTPUT → RAISE NOTICE:**
\`\`\`sql
-- Oracle
DBMS_OUTPUT.PUT_LINE('Processing order: ' || v_order_id);

-- PostgreSQL
RAISE NOTICE 'Processing order: %', v_order_id;
\`\`\`

### 4.6 Packages → Schemas

\`\`\`bash
ora2pg -c /opt/migration/config/ora2pg.conf \
       --type PACKAGE \
       -o /opt/migration/schema/11_packages.sql
\`\`\`

For each package, ora2pg creates a schema and places functions within it. Review the output and:
1. Create the schema on the target: \`CREATE SCHEMA pkg_orders;\`
2. Move package-level constants into a configuration table or application config
3. Refactor package-level variables (session state) — there is no direct equivalent

### 4.7 Triggers

\`\`\`bash
ora2pg -c /opt/migration/config/ora2pg.conf \
       --type TRIGGER \
       -o /opt/migration/schema/12_triggers.sql
\`\`\`

Oracle triggers embed their logic inline. PostgreSQL triggers call a separate trigger function. ora2pg generates a \`TRIGGER FUNCTION\` and a \`CREATE TRIGGER\` statement for each Oracle trigger. Review for \`:NEW\` / \`:OLD\` → \`NEW\` / \`OLD\` (already handled by ora2pg) and any Oracle-specific built-in calls.

---

## Phase 5 — Create the Target Database and Apply Schema

### 5.1 Create database and role

\`\`\`sql
-- On PostgreSQL
CREATE DATABASE appdb ENCODING 'UTF8' LC_COLLATE 'en_US.UTF-8' LC_CTYPE 'en_US.UTF-8';
CREATE ROLE appowner WITH LOGIN PASSWORD 'AppOwnerPassword!';
GRANT ALL PRIVILEGES ON DATABASE appdb TO appowner;
\`\`\`

### 5.2 Apply DDL in order

\`\`\`bash
PGPASSWORD=AppOwnerPassword! psql -h pg-host -U appowner -d appdb \
  -f /opt/migration/schema/01_tables.sql      2>&1 | tee /opt/migration/reports/ddl_01_tables.log

PGPASSWORD=AppOwnerPassword! psql -h pg-host -U appowner -d appdb \
  -f /opt/migration/schema/02_sequences.sql   2>&1 | tee /opt/migration/reports/ddl_02_sequences.log
\`\`\`

Check each log for \`ERROR\` lines before proceeding to the next file:

\`\`\`bash
grep -c "^ERROR" /opt/migration/reports/ddl_01_tables.log
\`\`\`

Zero errors before moving forward. Fix schema issues in the SQL files, re-run, and re-verify.

**Do not apply indexes and foreign keys yet** — load data first (Phase 6).

---

## Phase 6 — Data Migration

### 6.1 Export data from Oracle with ora2pg

\`\`\`bash
ora2pg -c /opt/migration/config/ora2pg.conf \
       --type COPY \
       --jobs 4 \
       -o /opt/migration/data/data_export.sql \
       --parallel_tables 4
\`\`\`

This generates PostgreSQL \`COPY ... FROM STDIN\` statements for each table. The \`--jobs 4\` flag uses four parallel export processes from Oracle.

For very large databases (>100 GB), export one table at a time and stream directly to PostgreSQL:

\`\`\`bash
# Export and import in a single pipeline — no intermediate file
ora2pg -c /opt/migration/config/ora2pg.conf \
       --type COPY \
       --table ORDERS \
       | psql -h pg-host -U appowner -d appdb
\`\`\`

### 6.2 Disable triggers during data load

\`\`\`sql
-- Disable all triggers to prevent trigger logic running on bulk-loaded data
-- (run as superuser on PostgreSQL target)
SET session_replication_role = replica;

-- Load data
\i /opt/migration/data/data_export.sql

-- Re-enable triggers
SET session_replication_role = DEFAULT;
\`\`\`

### 6.3 Apply indexes and constraints after data load

\`\`\`bash
PGPASSWORD=AppOwnerPassword! psql -h pg-host -U appowner -d appdb \
  -f /opt/migration/schema/03_primary_keys.sql
PGPASSWORD=AppOwnerPassword! psql -h pg-host -U appowner -d appdb \
  -f /opt/migration/schema/04_unique_keys.sql
PGPASSWORD=AppOwnerPassword! psql -h pg-host -U appowner -d appdb \
  -f /opt/migration/schema/05_foreign_keys.sql
PGPASSWORD=AppOwnerPassword! psql -h pg-host -U appowner -d appdb \
  -f /opt/migration/schema/06_indexes.sql
PGPASSWORD=AppOwnerPassword! psql -h pg-host -U appowner -d appdb \
  -f /opt/migration/schema/07_check_constraints.sql
\`\`\`

---

## Phase 7 — Reset Sequences

After data load, sequence current values must be set to the maximum existing ID per table. Otherwise the first application insert will try to use a sequence value already occupied by migrated data:

\`\`\`sql
-- Run for every table that has a sequence-backed primary key
-- Replace table_name, id_column, and sequence_name for each table

SELECT setval('orders_seq', (SELECT MAX(id) FROM orders));
SELECT setval('customers_seq', (SELECT MAX(id) FROM customers));
SELECT setval('order_items_seq', (SELECT MAX(id) FROM order_items));
\`\`\`

Generate the reset commands automatically:

\`\`\`sql
-- Find all sequences and their associated tables/columns
SELECT
    'SELECT setval(''' || s.relname || ''', (SELECT MAX(' || a.attname || ') FROM '
    || t.relname || '));' AS reset_cmd
FROM   pg_class s
JOIN   pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass
                   AND d.refclassid = 'pg_class'::regclass
JOIN   pg_class t ON t.oid = d.refobjid
JOIN   pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
WHERE  s.relkind = 'S'
ORDER  BY s.relname;
\`\`\`

Run the output of this query on the target database.

---

## Phase 8 — Validation

### 8.1 Row count comparison

Run this on both Oracle and PostgreSQL and compare:

\`\`\`sql
-- Oracle (run on source)
SELECT table_name, num_rows
FROM   dba_tables
WHERE  owner = 'APPOWNER'
ORDER  BY table_name;

-- PostgreSQL (run on target after ANALYZE)
ANALYZE;
SELECT relname AS table_name, reltuples::bigint AS estimated_rows
FROM   pg_class
WHERE  relkind = 'r'
  AND  relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
ORDER  BY relname;
\`\`\`

For an exact count (slower but definitive):

\`\`\`bash
#!/bin/bash
# compare_row_counts.sh — run on migration host
TABLES=$(psql -h pg-host -U appowner -d appdb -t -A \
  -c "SELECT relname FROM pg_class WHERE relkind='r' AND relnamespace=(SELECT oid FROM pg_namespace WHERE nspname='public') ORDER BY relname;")

for TABLE in \$TABLES; do
    ORA_COUNT=$(sqlplus -s migration_user/OraclePassword@PRODDB <<EOF
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF
SELECT COUNT(*) FROM APPOWNER.\${TABLE^^};
EXIT;
EOF
    )
    PG_COUNT=$(psql -h pg-host -U appowner -d appdb -t -A \
      -c "SELECT COUNT(*) FROM \$TABLE;")
    if [ "\$ORA_COUNT" != "\$PG_COUNT" ]; then
        echo "MISMATCH: \$TABLE — Oracle: \$ORA_COUNT, PG: \$PG_COUNT"
    else
        echo "OK: \$TABLE (\$PG_COUNT rows)"
    fi
done
\`\`\`

### 8.2 Checksum validation for critical tables

For high-value tables, compare aggregate checksums to catch any data corruption:

\`\`\`sql
-- Oracle: MD5 checksum of all rows in a table
SELECT DBMS_CRYPTO.HASH(
    UTL_RAW.CAST_TO_RAW(
        XMLAGG(XMLELEMENT(e, order_id||','||customer_id||','||TO_CHAR(amount)||','||status)
               ORDER BY order_id).GETCLOBVAL()
    ),
    DBMS_CRYPTO.HASH_MD5
) AS checksum
FROM orders;

-- PostgreSQL: equivalent checksum
SELECT MD5(STRING_AGG(
    order_id::text || ',' || customer_id::text || ',' || amount::text || ',' || status,
    '' ORDER BY order_id
)) AS checksum
FROM orders;
\`\`\`

Matching checksums confirm identical data. Any mismatch requires re-examining the data export and type conversion for that table.

### 8.3 Stored code smoke tests

Run a representative set of stored functions and procedures on both Oracle and PostgreSQL with identical inputs and compare outputs:

\`\`\`sql
-- Oracle
SELECT get_customer_balance(12345) FROM DUAL;

-- PostgreSQL
SELECT get_customer_balance(12345);
\`\`\`

Create a test script that covers at least one call to every migrated function and procedure. Record all output. Any function returning a different result is a regression that must be investigated before cutover.

### 8.4 Application smoke test on PostgreSQL

Point a staging instance of the application at the PostgreSQL target and run the critical user journeys manually:
- Login / authentication
- Core CRUD operations on the highest-traffic tables
- Any batch jobs or scheduled processes
- Report queries — compare output between Oracle and PostgreSQL

---

## Phase 9 — Cutover Procedure

### 9.1 Pre-cutover checklist

- [ ] All row counts match between Oracle and PostgreSQL
- [ ] Checksum validation passed for critical tables
- [ ] All stored functions/procedures produce identical output
- [ ] Sequences reset to MAX(id) + 1
- [ ] All indexes and constraints applied and verified (\`pg_constraint\`, \`pg_index\`)
- [ ] Application smoke test passed against PostgreSQL target
- [ ] Rollback procedure documented and tested
- [ ] DBA team on standby for cutover window
- [ ] Database connection string change prepared (not yet deployed)

### 9.2 Cutover steps

\`\`\`bash
# Step 1: Put Oracle in read-only / restricted mode to stop writes
# (via application — disable the write path, or set Oracle to restricted mode)
sqlplus / as sysdba <<'EOF'
ALTER SYSTEM ENABLE RESTRICTED SESSION;
EOF

# Step 2: Final incremental data sync (migrate any rows added since Phase 6)
ora2pg -c /opt/migration/config/ora2pg.conf \
       --type COPY \
       --where "modified_at > TO_DATE('CUTOVER_DATE', 'YYYY-MM-DD HH24:MI:SS')" \
       | psql -h pg-host -U appowner -d appdb

# Step 3: Final sequence reset
psql -h pg-host -U appowner -d appdb <<'EOF'
SELECT setval('orders_seq',    (SELECT MAX(id) FROM orders));
SELECT setval('customers_seq', (SELECT MAX(id) FROM customers));
-- ... all sequences
EOF

# Step 4: Final row count verification
# Run compare_row_counts.sh — must show all OK

# Step 5: Repoint application connection string to PostgreSQL
# (deploy application config change or update load balancer backend)

# Step 6: Smoke test against production PostgreSQL
# Run critical user journeys

# Step 7: Monitor application logs for errors for 30 minutes

# Step 8: Declare cutover complete
\`\`\`

### 9.3 Rollback procedure

If a critical issue is found within the cutover window:

\`\`\`bash
# Step 1: Repoint application back to Oracle
# (revert connection string / load balancer change)

# Step 2: Lift Oracle restricted session
sqlplus / as sysdba <<'EOF'
ALTER SYSTEM DISABLE RESTRICTED SESSION;
EOF

# Step 3: Document what failed and schedule a remediation window
\`\`\`

Keep the PostgreSQL instance running but idle. Do not decommission Oracle until the application has run stably on PostgreSQL for a minimum of 2–4 weeks.

---

## Post-Cutover Checklist

- [ ] Application running on PostgreSQL — no Oracle connections active
- [ ] Error rate in application logs within normal baseline
- [ ] PostgreSQL autovacuum running — check \`pg_stat_user_tables\` for \`last_autovacuum\`
- [ ] \`pg_stat_statements\` capturing query performance — top queries reviewed
- [ ] Backup strategy active: \`pg_basebackup\` or WAL archiving configured and tested
- [ ] Oracle instance placed in standby (not yet decommissioned) for minimum 2 weeks
- [ ] Decommission plan scheduled: Oracle licence return date, backup retention period
- [ ] Performance baseline collected after 1 week of production load on PostgreSQL`,
};

async function main() {
  console.log('Inserting Oracle to PostgreSQL migration runbook...');
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
