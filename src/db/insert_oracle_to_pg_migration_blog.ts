import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Migrating from Oracle to PostgreSQL: A Practical Guide',
  slug: 'oracle-to-postgresql-migration',
  excerpt:
    'A practical guide to migrating from Oracle Database to PostgreSQL — covering migration strategy, data type mapping, PL/SQL to PL/pgSQL conversion patterns, schema translation with ora2pg, sequences, NULL handling differences, and the common pitfalls that derail migrations at the last mile.',
  category: 'postgresql' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-09'),
  youtubeUrl: null,
  content: `Migrating from Oracle to PostgreSQL is the most common database migration path in the enterprise today, driven by Oracle licensing costs, cloud-native adoption, and PostgreSQL's maturity as a general-purpose RDBMS. It is also one of the more technically demanding migrations because Oracle and PostgreSQL agree on the SQL standard but diverge sharply in every proprietary layer on top of it.

This guide covers the conceptual differences, the tooling landscape, and the conversion patterns you need to understand before writing a single line of migration code.

---

## Choosing a Migration Strategy

### Big Bang

The entire schema, all stored code, and all data are migrated in a single cutover window. The application is taken offline, data is transferred to PostgreSQL, the application is repointed, and the old Oracle instance is decommissioned.

**Suitable when:** the database is small (under ~500 GB), the application is straightforward, and a maintenance window of several hours is acceptable.

**Risk:** if a data validation failure or performance problem surfaces after cutover, rollback means repointing to Oracle and re-synchronising any writes made to PostgreSQL during the window.

### Phased Migration with Dual-Write

Modules of the application are migrated one at a time. During the transition period, a replication layer (GoldenGate, Debezium, or logical replication via \`pglogical\`) keeps Oracle and PostgreSQL in sync. Each module is cutover independently.

**Suitable when:** the application is modular, the database is large, or zero-downtime cutover is required.

**Risk:** the dual-write period introduces complexity — schema differences between Oracle and PostgreSQL must be reconciled in the replication layer, and both databases must be kept healthy simultaneously.

### Strangler Fig

New features are written against PostgreSQL while existing features remain on Oracle. The Oracle footprint shrinks over time as modules are rewritten. No bulk data migration is ever performed — new data goes to PostgreSQL, historical data is archived or migrated on-demand.

**Suitable when:** the application is being significantly rearchitected alongside the database migration.

---

## Understanding the Key Differences

### Data Types

The single largest source of migration friction. Oracle and PostgreSQL have different native types, different default precisions, and different implicit conversion rules.

| Oracle Type | PostgreSQL Equivalent | Notes |
|-------------|----------------------|-------|
| \`NUMBER\` | \`NUMERIC\` / \`DECIMAL\` | \`NUMBER(p,s)\` → \`NUMERIC(p,s)\`; bare \`NUMBER\` → \`NUMERIC\` |
| \`NUMBER(5)\` | \`SMALLINT\` / \`INTEGER\` | Integer-only numbers map better to native int types |
| \`FLOAT\` / \`BINARY_FLOAT\` | \`DOUBLE PRECISION\` | IEEE 754 floating point — beware rounding differences |
| \`VARCHAR2(n)\` | \`VARCHAR(n)\` | Oracle \`VARCHAR2\` is byte-length by default; PostgreSQL uses character length |
| \`CHAR(n)\` | \`CHAR(n)\` | Same semantics; both pad with spaces |
| \`CLOB\` | \`TEXT\` | PostgreSQL \`TEXT\` has no length limit — direct replacement |
| \`BLOB\` | \`BYTEA\` | Binary data; ora2pg handles conversion |
| \`DATE\` | \`TIMESTAMP\` | Oracle \`DATE\` stores date **and** time to the second. PostgreSQL \`DATE\` stores date only. Map Oracle \`DATE\` to \`TIMESTAMP\` to avoid data loss. |
| \`TIMESTAMP WITH TIME ZONE\` | \`TIMESTAMPTZ\` | Direct equivalent |
| \`INTERVAL YEAR TO MONTH\` | \`INTERVAL\` | PostgreSQL interval is more flexible |
| \`RAW(n)\` | \`BYTEA\` | — |
| \`ROWID\` | No equivalent | ROWID is a physical address — should not be in application logic |
| \`XMLTYPE\` | \`XML\` | PostgreSQL has native XML support |

**The Oracle DATE trap** is the most common data migration error. Any Oracle column defined as \`DATE\` that contains time-of-day values (e.g., transaction timestamps) must be mapped to PostgreSQL \`TIMESTAMP\`, not \`DATE\`. Mapping it to \`DATE\` silently truncates all time information.

### NULL Handling

Oracle treats an empty string (\`''\`) as \`NULL\`. PostgreSQL treats them as distinct values.

\`\`\`sql
-- Oracle: returns the row (Oracle equates '' with NULL)
SELECT * FROM t WHERE col IS NULL;  -- matches rows where col = ''

-- PostgreSQL: does NOT return the row
SELECT * FROM t WHERE col IS NULL;  -- '' is not NULL in PostgreSQL
\`\`\`

Any application code or data that relies on Oracle's empty-string-as-NULL behaviour must be audited and fixed during migration. This commonly surfaces in:
- WHERE clause comparisons
- CHECK constraints that test for NULL
- NOT NULL constraints that previously allowed empty strings

### Sequences and Auto-Increment

Oracle uses standalone \`SEQUENCE\` objects with \`.NEXTVAL\` and \`.CURRVAL\` pseudo-columns. PostgreSQL supports the same sequence syntax but also offers the \`IDENTITY\` column (SQL standard) and the legacy \`SERIAL\` shorthand.

\`\`\`sql
-- Oracle
CREATE SEQUENCE orders_seq START WITH 1 INCREMENT BY 1;
INSERT INTO orders (id, ...) VALUES (orders_seq.NEXTVAL, ...);

-- PostgreSQL equivalent (IDENTITY column — preferred)
CREATE TABLE orders (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ...
);

-- PostgreSQL with explicit sequence (compatible with Oracle migration pattern)
CREATE SEQUENCE orders_seq START WITH 1 INCREMENT BY 1;
INSERT INTO orders (id, ...) VALUES (nextval('orders_seq'), ...);
\`\`\`

Migrated sequences need their current value set to the maximum existing ID in the table plus a buffer, or the first post-migration insert will collide with migrated data:

\`\`\`sql
SELECT setval('orders_seq', (SELECT MAX(id) FROM orders));
\`\`\`

### Dual Table

Oracle requires \`FROM DUAL\` for expressions not involving a table. PostgreSQL does not:

\`\`\`sql
-- Oracle
SELECT SYSDATE FROM DUAL;
SELECT 1 + 1 FROM DUAL;

-- PostgreSQL
SELECT NOW();
SELECT 1 + 1;
\`\`\`

### ROWNUM and LIMIT

Oracle uses \`ROWNUM\` and (in 12c+) \`FETCH FIRST n ROWS ONLY\` for pagination. PostgreSQL uses \`LIMIT\` and \`OFFSET\`:

\`\`\`sql
-- Oracle (pre-12c pattern)
SELECT * FROM (SELECT * FROM orders ORDER BY created_at DESC)
WHERE ROWNUM <= 10;

-- PostgreSQL
SELECT * FROM orders ORDER BY created_at DESC LIMIT 10;

-- Oracle pagination
SELECT * FROM (
    SELECT t.*, ROWNUM AS rn FROM (SELECT * FROM orders ORDER BY id) t
    WHERE ROWNUM <= 20
) WHERE rn > 10;

-- PostgreSQL pagination
SELECT * FROM orders ORDER BY id LIMIT 10 OFFSET 10;
\`\`\`

### Date Arithmetic

Oracle date arithmetic uses numeric offsets (days):

\`\`\`sql
-- Oracle: add 30 days
SELECT SYSDATE + 30 FROM DUAL;
SELECT order_date + 7 FROM orders;

-- PostgreSQL: use INTERVAL
SELECT NOW() + INTERVAL '30 days';
SELECT order_date + INTERVAL '7 days' FROM orders;
\`\`\`

### Common Oracle Functions and Their PostgreSQL Equivalents

| Oracle | PostgreSQL | Notes |
|--------|-----------|-------|
| \`NVL(a, b)\` | \`COALESCE(a, b)\` | \`COALESCE\` is SQL standard and accepts multiple arguments |
| \`NVL2(a, b, c)\` | \`CASE WHEN a IS NOT NULL THEN b ELSE c END\` | — |
| \`DECODE(x, v1, r1, v2, r2, def)\` | \`CASE x WHEN v1 THEN r1 WHEN v2 THEN r2 ELSE def END\` | — |
| \`SYSDATE\` | \`NOW()\` / \`CURRENT_TIMESTAMP\` | — |
| \`TRUNC(date)\` | \`DATE_TRUNC('day', ts)\` | — |
| \`TRUNC(number, n)\` | \`TRUNC(number, n)\` | Same function, same syntax |
| \`TO_DATE('2026-06-09', 'YYYY-MM-DD')\` | \`'2026-06-09'::DATE\` or \`TO_DATE('2026-06-09', 'YYYY-MM-DD')\` | PostgreSQL has \`TO_DATE\` too |
| \`TO_CHAR(date, fmt)\` | \`TO_CHAR(date, fmt)\` | Similar but format specifiers differ slightly |
| \`SUBSTR(s, 1, 5)\` | \`SUBSTRING(s FROM 1 FOR 5)\` or \`SUBSTR(s, 1, 5)\` | Both syntaxes work in PostgreSQL |
| \`INSTR(s, sub)\` | \`POSITION(sub IN s)\` or \`STRPOS(s, sub)\` | — |
| \`CONNECT BY\` (hierarchical) | Recursive CTE (\`WITH RECURSIVE\`) | Requires rewrite — see below |
| \`LISTAGG(col, sep)\` | \`STRING_AGG(col, sep)\` | — |
| \`REGEXP_LIKE(col, pat)\` | \`col ~ pat\` | PostgreSQL uses POSIX regex operators |
| \`SYS_GUID()\` | \`gen_random_uuid()\` | Requires \`pgcrypto\` or \`uuid-ossp\` extension |

### CONNECT BY → Recursive CTE

Hierarchical queries are one of the most common rewrites. Oracle's \`CONNECT BY\` has no direct syntax equivalent in PostgreSQL; it must be replaced with a recursive common table expression:

\`\`\`sql
-- Oracle: employee hierarchy
SELECT employee_id, manager_id, name, LEVEL
FROM   employees
START WITH manager_id IS NULL
CONNECT BY PRIOR employee_id = manager_id;

-- PostgreSQL equivalent
WITH RECURSIVE org_tree AS (
    -- Anchor: top-level rows (no manager)
    SELECT employee_id, manager_id, name, 1 AS depth
    FROM   employees
    WHERE  manager_id IS NULL

    UNION ALL

    -- Recursive: join children to current level
    SELECT e.employee_id, e.manager_id, e.name, ot.depth + 1
    FROM   employees e
    JOIN   org_tree ot ON e.manager_id = ot.employee_id
)
SELECT * FROM org_tree ORDER BY depth, employee_id;
\`\`\`

---

## PL/SQL to PL/pgSQL

Oracle's PL/SQL and PostgreSQL's PL/pgSQL are structurally similar but differ in syntax and available features.

### Stored Function Structure

\`\`\`sql
-- Oracle PL/SQL function
CREATE OR REPLACE FUNCTION get_customer_balance(p_cust_id IN NUMBER)
RETURN NUMBER
IS
    v_balance NUMBER;
BEGIN
    SELECT SUM(amount) INTO v_balance
    FROM   invoices
    WHERE  customer_id = p_cust_id;

    RETURN NVL(v_balance, 0);
EXCEPTION
    WHEN NO_DATA_FOUND THEN
        RETURN 0;
END;
/

-- PostgreSQL PL/pgSQL equivalent
CREATE OR REPLACE FUNCTION get_customer_balance(p_cust_id INTEGER)
RETURNS NUMERIC
LANGUAGE plpgsql
AS $$
DECLARE
    v_balance NUMERIC;
BEGIN
    SELECT COALESCE(SUM(amount), 0)
    INTO   v_balance
    FROM   invoices
    WHERE  customer_id = p_cust_id;

    RETURN v_balance;
EXCEPTION
    WHEN NO_DATA_FOUND THEN
        RETURN 0;
END;
$$;
\`\`\`

Key syntax differences:
- Oracle uses \`IS\` or \`AS\` before \`BEGIN\`; PostgreSQL uses \`LANGUAGE plpgsql AS $$...$$\`
- Parameter direction (\`IN\`, \`OUT\`, \`IN OUT\`) is supported in both, but PostgreSQL returns \`OUT\` parameters via the return type
- \`NVL\` → \`COALESCE\`
- Oracle \`NUMBER\` → PostgreSQL \`NUMERIC\` or \`INTEGER\`

### Packages → Schemas + Functions

Oracle packages (header + body) have no direct equivalent in PostgreSQL. The standard migration pattern is:

1. Create a **schema** named after the package to provide namespace isolation
2. Create all package functions and procedures as top-level functions within that schema
3. Package-level variables (session state) must be refactored — use a temp table, a session-local \`SET\` variable, or move state to the application layer

\`\`\`sql
-- Oracle package usage
pkg_orders.process_order(p_order_id => 12345);

-- PostgreSQL equivalent after migration
SELECT pkg_orders.process_order(12345);
-- where pkg_orders is a schema containing the process_order() function
\`\`\`

### Exception Handling

\`\`\`sql
-- Oracle
EXCEPTION
    WHEN DUP_VAL_ON_INDEX THEN ...
    WHEN NO_DATA_FOUND    THEN ...
    WHEN OTHERS           THEN
        DBMS_OUTPUT.PUT_LINE(SQLERRM);

-- PostgreSQL
EXCEPTION
    WHEN unique_violation  THEN ...
    WHEN no_data_found     THEN ...
    WHEN OTHERS            THEN
        RAISE NOTICE '%', SQLERRM;
\`\`\`

PostgreSQL exception names use lowercase with underscores. The full list is in the PostgreSQL documentation under "Error Codes".

---

## Migration Tooling

### ora2pg

The primary open-source tool for Oracle-to-PostgreSQL schema and data migration. It connects to Oracle via DBI/DBD::Oracle, introspects the schema, and generates PostgreSQL-compatible DDL and \`COPY\` commands.

Key features:
- Schema assessment report with an estimated migration complexity score
- DDL conversion: tables, indexes, sequences, views, triggers, constraints
- PL/SQL conversion to PL/pgSQL (partial — complex code needs manual review)
- Data export in PostgreSQL \`COPY\` format for fast bulk loading
- Type mapping configuration via \`ora2pg.conf\`

### AWS Schema Conversion Tool (SCT)

AWS's GUI-based migration assessment and conversion tool. Produces a schema compatibility report showing which objects can be auto-converted and which require manual intervention. Good for initial assessment before committing to a toolchain.

### pgloader

An alternative data loading tool that can pull data directly from Oracle (via ODBC) and load it into PostgreSQL in a single streaming pipeline. Useful for the data phase when the schema has already been manually translated.

---

## Common Migration Pitfalls

**Case sensitivity.** Oracle stores unquoted identifiers in UPPERCASE. PostgreSQL stores them in lowercase. An Oracle table named \`ORDERS\` becomes \`orders\` in PostgreSQL unless explicitly quoted. Application code that uses quoted uppercase identifiers (\`"ORDERS"\`) will need updating.

**Implicit type coercion.** Oracle is much more permissive about implicit casts (e.g., comparing a \`NUMBER\` column to a string literal). PostgreSQL is strict — mismatched types cause errors rather than silent coercions. These surface as runtime errors after migration.

**Triggers.** Oracle trigger syntax and the \`NEW\`/\`OLD\` row references differ from PostgreSQL's trigger function model. Oracle triggers execute the body inline; PostgreSQL triggers call a separate trigger function.

**Synonyms.** Oracle synonyms (public and private) have no native equivalent. Replace with \`SEARCH_PATH\` configuration, schema-qualified references, or views.

**Database Links.** Oracle DB Links are replaced by PostgreSQL's Foreign Data Wrappers (\`postgres_fdw\`, \`oracle_fdw\`).

**Materialized Views.** Both databases support materialized views, but Oracle's \`FAST REFRESH\` (incremental refresh) requires explicit \`MATERIALIZED VIEW LOG\` setup. PostgreSQL's \`REFRESH MATERIALIZED VIEW CONCURRENTLY\` is a full refresh but non-blocking.

**Hints.** Oracle execution plan hints (\`/*+ INDEX(...) */\`, \`/*+ FULL(...) */\`) are not supported in PostgreSQL. Use \`pg_hint_plan\` extension as a transitional measure, but treat the need for hints as a signal that statistics or configuration need improvement.

The companion runbook covers the complete end-to-end migration procedure: ora2pg installation, assessment reporting, schema conversion, data migration, validation, and cutover.`,
};

async function main() {
  console.log('Inserting Oracle to PostgreSQL migration blog post...');
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
