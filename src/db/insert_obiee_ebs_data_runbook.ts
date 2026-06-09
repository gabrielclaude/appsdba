import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Configuring OBIEE 12c to Pull Data from Oracle EBS 12.2.9',
  slug: 'obiee-ebs-12-2-data-integration-runbook',
  excerpt:
    'Step-by-step runbook for connecting OBIEE 12c to Oracle EBS 12.2.9 — covering EBS reporting user creation, JDBC connection pool setup in the RPD, FND_GLOBAL and MO_GLOBAL init string configuration, OBIEE Init Block creation for dynamic org context, Physical layer table import, and end-to-end validation from SQL*Plus through to a live OBIEE analysis.',
  category: 'fusion-middleware' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-09'),
  youtubeUrl: null,
  content: `## Purpose and Scope

This runbook configures an OBIEE 12c instance to connect to an Oracle E-Business Suite 12.2.9 database and report against its GL, AP, AR, and PO modules. It covers the complete path from EBS database user creation through RPD Physical layer setup, session context initialisation, and end-to-end validation.

**Reference post:** [Connecting OBIEE to Oracle EBS 12.2: Architecture and Data Access Patterns](/posts/obiee-pull-data-from-ebs-12-2)

**Applies to:** OBIEE 12.2.1.x, Oracle EBS 12.2.9, Oracle Database 19c.

---

## Prerequisites

| Item | Requirement |
|------|-------------|
| OBIEE | 12.2.1.4+ installed and running |
| EBS | 12.2.9, application tier and DB tier accessible from OBIEE host |
| OBIEE Admin Tool | Installed (Windows or Linux) with connectivity to OBIEE BI Server |
| Oracle DB Client | Oracle Instant Client or full client on the OBIEE server for JDBC |
| EBS DBA access | Ability to create users and grant privileges in the EBS database |
| OBIEE credentials | BIAdministrator role (Weblogic Console + BI Server admin) |

---

## Phase 1 — Create a Dedicated EBS Reporting User

Never connect OBIEE to EBS using the APPS schema. Create a read-only reporting user with the minimum necessary grants.

### 1.1 Create the database user

Run as SYSDBA or a DBA on the EBS database:

\`\`\`sql
-- Create the reporting user
CREATE USER bi_reporting
IDENTIFIED BY "BIReportingPass01!"
DEFAULT TABLESPACE users
TEMPORARY TABLESPACE temp
ACCOUNT UNLOCK;

-- Basic connect privilege
GRANT CREATE SESSION TO bi_reporting;

-- Grant execute on EBS session context packages
GRANT EXECUTE ON APPS.FND_GLOBAL     TO bi_reporting;
GRANT EXECUTE ON APPS.MO_GLOBAL      TO bi_reporting;
GRANT EXECUTE ON APPS.FND_PROFILE    TO bi_reporting;

-- Create a private synonym so the reporting user can call APPS packages without schema prefix
CREATE SYNONYM bi_reporting.FND_GLOBAL  FOR APPS.FND_GLOBAL;
CREATE SYNONYM bi_reporting.MO_GLOBAL   FOR APPS.MO_GLOBAL;
CREATE SYNONYM bi_reporting.FND_PROFILE FOR APPS.FND_PROFILE;
\`\`\`

### 1.2 Grant SELECT on EBS reporting objects

Create a grant script for the modules you need. Run as APPS or a DBA:

\`\`\`sql
-- General Ledger
GRANT SELECT ON APPS.GL_BALANCES                TO bi_reporting;
GRANT SELECT ON APPS.GL_CODE_COMBINATIONS       TO bi_reporting;
GRANT SELECT ON APPS.GL_JE_HEADERS              TO bi_reporting;
GRANT SELECT ON APPS.GL_JE_LINES                TO bi_reporting;
GRANT SELECT ON APPS.GL_LEDGERS                 TO bi_reporting;
GRANT SELECT ON APPS.GL_PERIODS                 TO bi_reporting;
GRANT SELECT ON APPS.GL_PERIOD_STATUSES         TO bi_reporting;

-- Accounts Payable
GRANT SELECT ON APPS.AP_INVOICES_ALL            TO bi_reporting;
GRANT SELECT ON APPS.AP_INVOICE_LINES_ALL       TO bi_reporting;
GRANT SELECT ON APPS.AP_INVOICE_DISTRIBUTIONS_ALL TO bi_reporting;
GRANT SELECT ON APPS.AP_PAYMENT_SCHEDULES_ALL   TO bi_reporting;
GRANT SELECT ON APPS.AP_CHECKS_ALL              TO bi_reporting;
GRANT SELECT ON APPS.AP_SUPPLIERS               TO bi_reporting;

-- Accounts Receivable
GRANT SELECT ON APPS.RA_CUSTOMER_TRX_ALL        TO bi_reporting;
GRANT SELECT ON APPS.RA_CUSTOMER_TRX_LINES_ALL  TO bi_reporting;
GRANT SELECT ON APPS.AR_PAYMENT_SCHEDULES_ALL   TO bi_reporting;
GRANT SELECT ON APPS.AR_CASH_RECEIPTS_ALL       TO bi_reporting;
GRANT SELECT ON APPS.HZ_PARTIES                 TO bi_reporting;
GRANT SELECT ON APPS.HZ_CUST_ACCOUNTS           TO bi_reporting;
GRANT SELECT ON APPS.HZ_PARTY_SITES             TO bi_reporting;

-- Purchasing
GRANT SELECT ON APPS.PO_HEADERS_ALL             TO bi_reporting;
GRANT SELECT ON APPS.PO_LINES_ALL               TO bi_reporting;
GRANT SELECT ON APPS.PO_LINE_LOCATIONS_ALL      TO bi_reporting;
GRANT SELECT ON APPS.PO_DISTRIBUTIONS_ALL       TO bi_reporting;
GRANT SELECT ON APPS.RCV_SHIPMENT_HEADERS       TO bi_reporting;
GRANT SELECT ON APPS.RCV_TRANSACTIONS           TO bi_reporting;

-- HR
GRANT SELECT ON APPS.PER_ALL_PEOPLE_F           TO bi_reporting;
GRANT SELECT ON APPS.PER_ALL_ASSIGNMENTS_F      TO bi_reporting;
GRANT SELECT ON APPS.HR_ALL_ORGANIZATION_UNITS  TO bi_reporting;

-- FND and Lookups
GRANT SELECT ON APPS.FND_LOOKUPS                TO bi_reporting;
GRANT SELECT ON APPS.FND_LOOKUP_VALUES          TO bi_reporting;
GRANT SELECT ON APPS.FND_FLEX_VALUES_VL         TO bi_reporting;
GRANT SELECT ON APPS.FND_FLEX_VALUE_SETS        TO bi_reporting;
GRANT SELECT ON APPS.FND_USER                   TO bi_reporting;
GRANT SELECT ON APPS.FND_RESPONSIBILITY_VL      TO bi_reporting;
GRANT SELECT ON APPS.HR_OPERATING_UNITS         TO bi_reporting;
GRANT SELECT ON APPS.MO_GLOB_ORG_ACCESS_TMP     TO bi_reporting;
\`\`\`

### 1.3 Create APPS synonyms for the reporting user

So the reporting user can reference objects without the APPS prefix:

\`\`\`sql
BEGIN
    FOR obj IN (
        SELECT object_name, object_type
        FROM   dba_objects
        WHERE  owner = 'APPS'
          AND  object_type IN ('TABLE', 'VIEW')
          AND  object_name IN (
                'GL_BALANCES','GL_CODE_COMBINATIONS','GL_JE_HEADERS','GL_JE_LINES',
                'GL_LEDGERS','GL_PERIODS','AP_INVOICES_ALL','AP_INVOICE_LINES_ALL',
                'AP_PAYMENT_SCHEDULES_ALL','AP_CHECKS_ALL','AP_SUPPLIERS',
                'RA_CUSTOMER_TRX_ALL','RA_CUSTOMER_TRX_LINES_ALL',
                'AR_PAYMENT_SCHEDULES_ALL','AR_CASH_RECEIPTS_ALL',
                'HZ_PARTIES','HZ_CUST_ACCOUNTS','HZ_PARTY_SITES',
                'PO_HEADERS_ALL','PO_LINES_ALL','PO_LINE_LOCATIONS_ALL',
                'PO_DISTRIBUTIONS_ALL','RCV_SHIPMENT_HEADERS','RCV_TRANSACTIONS',
                'PER_ALL_PEOPLE_F','PER_ALL_ASSIGNMENTS_F','HR_ALL_ORGANIZATION_UNITS',
                'FND_LOOKUPS','FND_LOOKUP_VALUES','FND_FLEX_VALUES_VL',
                'FND_FLEX_VALUE_SETS','FND_USER','FND_RESPONSIBILITY_VL',
                'HR_OPERATING_UNITS','MO_GLOB_ORG_ACCESS_TMP'
               )
    ) LOOP
        EXECUTE IMMEDIATE
            'CREATE OR REPLACE SYNONYM bi_reporting.' || obj.object_name
            || ' FOR APPS.' || obj.object_name;
    END LOOP;
END;
/
\`\`\`

### 1.4 Validate the reporting user context in SQL*Plus

Before touching OBIEE, confirm the init packages work correctly from the reporting user account:

\`\`\`sql
-- Connect as bi_reporting
conn bi_reporting/BIReportingPass01!@EBSDB

-- Replace with valid user_id, resp_id, and org_id from your EBS instance
BEGIN
    FND_GLOBAL.APPS_INITIALIZE(
        user_id      => 1234,
        resp_id      => 50001,
        resp_appl_id => 101
    );
    MO_GLOBAL.INIT('M');
    MO_GLOBAL.SET_POLICY_CONTEXT('M', 204);
END;
/

-- Test: should return rows for the specified org
SELECT COUNT(*) FROM ap_invoices_all WHERE org_id = 204;

-- Test: should return rows from GL balances
SELECT COUNT(*) FROM gl_balances WHERE ledger_id = 1;

-- Confirm FND context
SELECT FND_GLOBAL.USER_ID, FND_GLOBAL.RESP_ID, FND_GLOBAL.ORG_ID FROM DUAL;
\`\`\`

All three queries must return non-zero counts. If any return 0, the context init or the grants are incomplete.

---

## Phase 2 — Identify EBS Context Values

You need specific IDs from the EBS instance before configuring the RPD init string.

### 2.1 Find the BI reporting FND user ID

\`\`\`sql
SELECT user_id, user_name, description
FROM   fnd_user
WHERE  user_name = 'BI_REPORTING'   -- or whichever EBS application user to use
  AND  end_date IS NULL;
\`\`\`

If there is no dedicated EBS application user for BI, create one in EBS:
**System Administrator > Security > User > Define** — create a user named \`BI_REPORTING\` and assign a GL or cross-module responsibility.

### 2.2 Find the responsibility and application IDs

\`\`\`sql
SELECT r.responsibility_id,
       r.responsibility_name,
       r.application_id,
       a.application_short_name
FROM   fnd_responsibility_vl r
JOIN   fnd_application_vl    a ON r.application_id = a.application_id
WHERE  r.responsibility_name LIKE '%General Ledger%'
  AND  r.end_date IS NULL
ORDER BY r.responsibility_name;
\`\`\`

Record: \`RESPONSIBILITY_ID\`, \`APPLICATION_ID\`.

### 2.3 Find the operating unit ORG_ID values

\`\`\`sql
SELECT organization_id  AS org_id,
       name             AS operating_unit_name,
       short_code
FROM   hr_operating_units
WHERE  usable_flag = 'Y'
ORDER BY name;
\`\`\`

For single-org deployments, record the single \`ORG_ID\`. For multi-org, note all ORG_IDs that OBIEE should have access to.

### 2.4 Find the ledger ID for GL reports

\`\`\`sql
SELECT ledger_id, name, currency_code, period_set_name
FROM   gl_ledgers
WHERE  ledger_category_code = 'PRIMARY'
ORDER BY name;
\`\`\`

---

## Phase 3 — Configure the OBIEE RPD Connection Pool

Open the RPD in OBIEE Administration Tool (offline or online mode).

### 3.1 Create a new database entry in the Physical layer

1. In the Physical layer, right-click → **New Database**
2. **Name:** \`EBS_12_2_9\`
3. **Database type:** \`Oracle 19c\` (or the exact version of your EBS DB)
4. Click **OK**

### 3.2 Create a Connection Pool

1. Expand the new \`EBS_12_2_9\` database entry
2. Right-click **Connection Pools** → **New Connection Pool**
3. Configure:

| Field | Value |
|-------|-------|
| **Name** | \`EBS_CP_PRIMARY\` |
| **Call interface** | \`OCI 10g/11g\` or \`JDBC (JNDI)\` |
| **Data source name** | \`EBS_DB\` (tnsnames alias) or full JDBC URL |
| **User name** | \`bi_reporting\` |
| **Password** | \`BIReportingPass01!\` |
| **Maximum connections** | \`50\` (adjust for report concurrency) |
| **Connection lifetime** | \`1800\` seconds |
| **Require fully qualified table names** | Unchecked (synonyms handle schema prefix) |

**JDBC URL format (if not using tnsnames):**
\`\`\`
jdbc:oracle:thin:@//ebs-db-host:1521/EBSDB
\`\`\`

### 3.3 Set the Connection Pool Init String

In the Connection Pool dialog, click the **Connection Scripts** tab → **Execute on connect**:

\`\`\`sql
BEGIN
    FND_GLOBAL.APPS_INITIALIZE(
        user_id      => 1234,
        resp_id      => 50001,
        resp_appl_id => 101
    );
    MO_GLOBAL.INIT('M');
    MO_GLOBAL.SET_POLICY_CONTEXT('M', 204);
END;
\`\`\`

Replace \`1234\`, \`50001\`, \`101\`, and \`204\` with the values found in Phase 2.

**For NLS consistency**, also add to the init string:

\`\`\`sql
ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS';
ALTER SESSION SET NLS_NUMERIC_CHARACTERS = '.,';
\`\`\`

Click **Test Connection** to validate. The BI Server will open a connection, run the init string, and return success or the Oracle error from the init block.

---

## Phase 4 — Import Physical Layer Tables

### 4.1 Import tables via the Physical layer wizard

1. Right-click the \`EBS_12_2_9\` database → **Import Metadata**
2. Select \`EBS_CP_PRIMARY\` as the connection pool
3. Select the **BI_REPORTING** owner (or APPS if synonyms were not created)
4. Select the tables/views to import:
   - GL: \`GL_BALANCES\`, \`GL_CODE_COMBINATIONS\`, \`GL_JE_HEADERS\`, \`GL_JE_LINES\`, \`GL_LEDGERS\`, \`GL_PERIODS\`
   - AP: \`AP_INVOICES_ALL\`, \`AP_INVOICE_LINES_ALL\`, \`AP_PAYMENT_SCHEDULES_ALL\`
   - AR: \`RA_CUSTOMER_TRX_ALL\`, \`AR_PAYMENT_SCHEDULES_ALL\`, \`HZ_PARTIES\`, \`HZ_CUST_ACCOUNTS\`
   - PO: \`PO_HEADERS_ALL\`, \`PO_LINES_ALL\`, \`PO_LINE_LOCATIONS_ALL\`
   - Lookups: \`FND_LOOKUPS\`, \`FND_FLEX_VALUES_VL\`, \`FND_FLEX_VALUE_SETS\`
5. Click **Import** → tables appear under \`EBS_12_2_9\` in the Physical layer

### 4.2 Override column types for amount columns

In EBS, amount columns are typically \`NUMBER\` without precision. In the Physical layer, override them to prevent floating-point aggregation errors:

1. Expand the physical table (e.g., \`GL_BALANCES\`)
2. Double-click a column such as \`PERIOD_NET_DR\`
3. Change **Type** from \`DOUBLE\` to \`NUMERIC\`
4. Set **Length** to \`28\` and **Scale** to \`2\`
5. Repeat for all amount/monetary columns

### 4.3 Set physical joins

Define joins between related physical tables. Example for GL:

1. Right-click \`GL_BALANCES\` → **Physical Foreign Keys** → **New Join**
2. Set: \`GL_BALANCES.CODE_COMBINATION_ID\` = \`GL_CODE_COMBINATIONS.CODE_COMBINATION_ID\`
3. Add: \`GL_BALANCES.LEDGER_ID\` = \`GL_LEDGERS.LEDGER_ID\`
4. Add: \`GL_BALANCES.PERIOD_NAME\` = \`GL_PERIODS.PERIOD_NAME\`

---

## Phase 5 — Create OBIEE Init Blocks for Dynamic Context

For environments where OBIEE users should be scoped to their own EBS operating unit, replace the hardcoded init string with dynamic session variables.

### 5.1 Create session variables

In the RPD: **Manage > Variables** → **Session** → **New Session Variable**:

| Variable | Default Value | Notes |
|----------|--------------|-------|
| \`EBS_USER_ID\` | \`1234\` | Overridden by Init Block |
| \`EBS_RESP_ID\` | \`50001\` | Overridden by Init Block |
| \`EBS_RESP_APPL_ID\` | \`101\` | Overridden by Init Block |
| \`EBS_ORG_ID\` | \`204\` | Overridden by Init Block |

### 5.2 Create the Init Block SQL query

Create a new Init Block: **Manage > Variables** → **Init Blocks** → **New Init Block**

**Name:** \`EBS_USER_CONTEXT\`

**SQL query** (runs against the EBS connection pool to look up the user's context):

\`\`\`sql
SELECT
    fu.user_id,
    urg.responsibility_id,
    urg.responsibility_application_id,
    hou.organization_id
FROM   fnd_user              fu
JOIN   fnd_user_resp_groups  urg ON fu.user_id = urg.user_id
                                 AND urg.end_date IS NULL
JOIN   hr_operating_units    hou ON hou.usable_flag = 'Y'
WHERE  fu.user_name  = UPPER(':USER')   -- OBIEE session variable for logged-in user
  AND  urg.responsibility_id = (
           SELECT MIN(r.responsibility_id)
           FROM   fnd_responsibility_vl r
           WHERE  r.application_id = urg.responsibility_application_id
             AND  r.end_date IS NULL
       )
  AND  ROWNUM = 1
\`\`\`

Map the query columns to the session variables:
- Column 1 → \`EBS_USER_ID\`
- Column 2 → \`EBS_RESP_ID\`
- Column 3 → \`EBS_RESP_APPL_ID\`
- Column 4 → \`EBS_ORG_ID\`

### 5.3 Update the Connection Pool init string to use session variables

In the Connection Pool → **Connection Scripts** → **Execute on connect**, replace the hardcoded IDs:

\`\`\`sql
BEGIN
    FND_GLOBAL.APPS_INITIALIZE(
        user_id      => VALUEOF(NQ_SESSION.EBS_USER_ID),
        resp_id      => VALUEOF(NQ_SESSION.EBS_RESP_ID),
        resp_appl_id => VALUEOF(NQ_SESSION.EBS_RESP_APPL_ID)
    );
    MO_GLOBAL.INIT('M');
    MO_GLOBAL.SET_POLICY_CONTEXT('M', VALUEOF(NQ_SESSION.EBS_ORG_ID));
END;
\`\`\`

---

## Phase 6 — Build the Business Model Layer

### 6.1 Create a Logical Table Source for GL Balances

1. In the Business Model layer, create a new Business Model: \`EBS_Analytics\`
2. Create a Logical Table: \`Fact - GL Balances\`
3. Create a Logical Table Source, map it to \`EBS_12_2_9.GL_BALANCES\`
4. Map logical columns:
   - \`Period Net Amount\` → \`PERIOD_NET_DR - PERIOD_NET_CR\` (expression)
   - \`Opening Balance\` → \`BEGIN_BALANCE_DR - BEGIN_BALANCE_CR\` (expression)
   - \`Currency Code\` → \`CURRENCY_CODE\`
   - \`Actual Flag\` → \`ACTUAL_FLAG\`

### 6.2 Add dimension tables

Create Logical Tables for each dimension and define Logical Joins:

- \`Dim - Chart of Accounts\` → source: \`GL_CODE_COMBINATIONS\`
- \`Dim - Periods\` → source: \`GL_PERIODS\`
- \`Dim - Ledger\` → source: \`GL_LEDGERS\`

Logical Joins (in the Business Model):
- \`Fact - GL Balances\` [N] → [1] \`Dim - Chart of Accounts\` on \`CODE_COMBINATION_ID\`
- \`Fact - GL Balances\` [N] → [1] \`Dim - Periods\` on \`PERIOD_NAME\`
- \`Fact - GL Balances\` [N] → [1] \`Dim - Ledger\` on \`LEDGER_ID\`

### 6.3 Create the Presentation Layer

Drag the Business Model into the Presentation Layer. This creates a Subject Area named \`EBS_Analytics\`. Rename folders and columns to business-friendly labels:
- \`CODE_COMBINATION_ID\` → hidden (internal key)
- \`SEGMENT1\` → \`Company\`
- \`SEGMENT2\` → \`Cost Centre\`
- \`SEGMENT3\` → \`Account\`

---

## Phase 7 — Deploy and Validate

### 7.1 Save and upload the RPD

In Administration Tool: **File > Save** → **File > Upload to Server** (online mode), or use the OBIEE console to upload the RPD file:

\`\`\`bash
# Via command line (offline upload)
$ORACLE_HOME/user_projects/domains/bi/bitools/bin/datamodel.sh uploadrpd \
  -I /tmp/EBS_Analytics.rpd \
  -W RPD_Password \
  -U weblogic \
  -P weblogic_password \
  -SI ssi
\`\`\`

### 7.2 Restart OBIEE BI Server and Presentation Services

\`\`\`bash
cd $ORACLE_HOME/user_projects/domains/bi/bitools/bin

# Stop
./stop.sh

# Start
./start.sh

# Check status
./status.sh
\`\`\`

### 7.3 Test via nqcmd (BI Server command-line client)

\`\`\`bash
$ORACLE_HOME/Oracle_BI1/bifoundation/server/bin/nqcmd \
  -d AnalyticsWeb \
  -u weblogic \
  -p weblogic_password \
  -q "SELECT \"Dim - Periods\".\"Period Name\", \"Fact - GL Balances\".\"Period Net Amount\" FROM \"EBS_Analytics\" WHERE \"Fact - GL Balances\".\"Actual Flag\" = 'A' FETCH FIRST 5 ROWS ONLY;" \
  -s /tmp/nqcmd_test.txt

cat /tmp/nqcmd_test.txt
\`\`\`

Expected: 5 rows of period names with numeric net amounts. An Oracle error here (ORA-01403, ORA-20001) points to an init string or grant problem.

### 7.4 Test via the OBIEE Answers UI

1. Log into OBIEE Analytics (\`http://obiee-host:9502/analytics\`)
2. **New > Analysis**
3. Select the \`EBS_Analytics\` subject area
4. Drag \`Dim - Periods > Period Name\` and \`Fact - GL Balances > Period Net Amount\` to the Selected Columns
5. Click **Results**

Rows returned with correct amounts confirms end-to-end connectivity.

### 7.5 Validate Multi-Org scoping

Confirm data is scoped to the correct operating unit:

\`\`\`sql
-- On the EBS database — count rows visible to each ORG_ID
-- Run the same after logging into OBIEE as users assigned to different orgs
-- and confirm the OBIEE report row counts match

SELECT org_id, COUNT(*) AS invoice_count
FROM   ap_invoices_all
GROUP  BY org_id
ORDER  BY org_id;
\`\`\`

An OBIEE report on AP invoices should return the count for the session's initialised ORG_ID only.

---

## Phase 8 — Connection Pool Health Check Script

Deploy this script to the OBIEE server to confirm the EBS connection pool is operational and the session context is correctly initialised.

\`\`\`bash
#!/bin/bash
# check_ebs_connection_pool.sh — validates EBS init string from the OBIEE server
ORACLE_HOME=/u01/oracle/middleware/oracle_common
PATH=\$ORACLE_HOME/bin:\$PATH
TNS_ADMIN=/u01/oracle/middleware/user_projects/domains/bi/config/fmwconfig

sqlplus -s bi_reporting/BIReportingPass01!@EBS_DB <<'EOF'
SET PAGESIZE 50 LINESIZE 120 FEEDBACK ON HEADING ON

-- Run the init block
BEGIN
    FND_GLOBAL.APPS_INITIALIZE(1234, 50001, 101);
    MO_GLOBAL.INIT('M');
    MO_GLOBAL.SET_POLICY_CONTEXT('M', 204);
END;
/

-- Validate context
SELECT 'USER_ID='  || FND_GLOBAL.USER_ID
    || ' RESP_ID=' || FND_GLOBAL.RESP_ID
    || ' ORG_ID='  || FND_GLOBAL.ORG_ID AS session_context
FROM DUAL;

-- Test GL access
SELECT 'GL_BALANCES row count: ' || COUNT(*) AS result FROM GL_BALANCES WHERE ROWNUM <= 1000;

-- Test AP access
SELECT 'AP_INVOICES_ALL row count: ' || COUNT(*) AS result FROM AP_INVOICES_ALL;

-- Test AR access
SELECT 'RA_CUSTOMER_TRX_ALL row count: ' || COUNT(*) AS result FROM RA_CUSTOMER_TRX_ALL;

EXIT;
EOF
\`\`\`

\`\`\`bash
chmod +x /home/oracle/scripts/check_ebs_connection_pool.sh

# Schedule weekly to catch password changes or privilege drops
# 0 6 * * 1 /home/oracle/scripts/check_ebs_connection_pool.sh >> /var/log/obiee_ebs_health.log 2>&1
\`\`\`

---

## Post-Configuration Checklist

- [ ] \`bi_reporting\` user created in EBS DB with correct grants
- [ ] Synonyms created for all required EBS objects
- [ ] Init string validated in SQL*Plus as \`bi_reporting\` — all three SELECT tests return rows
- [ ] RPD Connection Pool test succeeds in OBIEE Admin Tool
- [ ] Physical layer tables imported and amount column types set to \`NUMERIC\`
- [ ] Physical joins defined between fact and dimension tables
- [ ] Business Model logical joins defined
- [ ] Presentation Layer subject area created and renamed to business labels
- [ ] RPD uploaded and OBIEE services restarted cleanly
- [ ] \`nqcmd\` command-line test returns rows
- [ ] OBIEE Answers UI test returns correct period/ledger-scoped rows
- [ ] Multi-Org scoping confirmed — users see only their ORG_ID's data
- [ ] \`check_ebs_connection_pool.sh\` deployed and scheduled
- [ ] APPS password rotation procedure documented — RPD connection pool password must be updated in sync`,
};

async function main() {
  console.log('Inserting OBIEE EBS data integration runbook...');
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
