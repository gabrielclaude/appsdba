import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle OBIEE: Architecture, EBS Integration, and Deployment Topology',
  slug: 'obiee-ebs-integration-topology',
  excerpt:
    'A comprehensive guide to Oracle Business Intelligence Enterprise Edition (OBIEE) — covering the core component architecture (BI Server, Presentation Services, Scheduler, JavaHost), the RPD semantic layer, how OBIEE integrates with Oracle E-Business Suite through the APPS schema, Oracle BI Applications, initialisation blocks, and row-level security, plus deployment topology patterns from single-node development to HA scale-out.',
  category: 'fusion-middleware' as const,
  published: true,
  publishedAt: new Date('2026-06-05'),
  isPremium: false,
  youtubeUrl: null,
  content: `Oracle Business Intelligence Enterprise Edition (OBIEE) is Oracle's on-premises enterprise BI platform. It provides a semantic layer that abstracts underlying data sources — including Oracle E-Business Suite — into a unified, governed model that business users query through dashboards, ad hoc analysis, and pixel-perfect reports. OBIEE 11g (11.1.1.x) introduced the WebLogic-based architecture; OBIEE 12c (12.2.1.x) refactored it onto Oracle Fusion Middleware 12c conventions. This post covers both, with emphasis on 11g/12c on-premises deployments that are still the dominant pattern in EBS environments.

---

## Core Component Architecture

OBIEE is a collection of cooperating processes. Understanding which process handles which responsibility is the prerequisite for both troubleshooting and topology design.

### Oracle BI Server (nqsserver)

The BI Server is the semantic core of OBIEE. It owns the Repository (RPD file), parses and optimises logical queries from Presentation Services, translates them into physical SQL against data sources, federates results across multiple sources when needed, and applies row-level security.

\`\`\`
Presentation Services  →  Logical SQL (ODBC/TCP 9703)
                                    │
                            ┌───────▼────────┐
                            │   BI Server    │
                            │  (nqsserver)   │
                            │                │
                            │  ┌──────────┐  │
                            │  │   RPD    │  │
                            │  │ Physical │  │
                            │  │ Business │  │
                            │  │ Presentn │  │
                            │  └──────────┘  │
                            └───────┬────────┘
                                    │  Physical SQL (JDBC/ODBC)
                            ┌───────▼────────┐
                            │  Data Sources  │
                            │  (APPS schema, │
                            │   DWH, etc.)   │
                            └────────────────┘
\`\`\`

The BI Server runs as a standalone process outside WebLogic. On Linux/Unix it is named \`nqsserver\`; its configuration lives in \`NQSConfig.INI\`. It listens on port **9703** (ODBC) by default and exposes a monitoring port on **9705**.

### Oracle BI Presentation Services (sawserver)

Presentation Services is the web application layer. It renders dashboards, answers queries, manages the Presentation Catalog (saved reports, dashboards, filters), and handles user session state. It communicates with the BI Server over ODBC (port 9703) and with WebLogic (where the analytics WAR is deployed) over HTTP.

On Linux the process is named \`sawserver\`; its main configuration file is \`instanceconfig.xml\`. Default HTTP port: **9710** (internal).

### Oracle BI Scheduler (schsrv / nqscheduler)

The Scheduler drives Intelligent Request Evaluation (iBot/Agent) execution — scheduled report delivery, alerts based on condition evaluation, and bursting. It stores job definitions in a relational schema (the Scheduler schema, created by RCU). Port: **9705** (management) / **9706** (cluster controller).

### Oracle BI JavaHost

JavaHost is a Java process that handles rendering tasks the C++ BI Server and Presentation Services cannot: Java-based chart rendering, PDF/RTF/Excel report formatting, graph generation, and custom Java-based BI components. It runs on port **9810** by default.

### WebLogic Server and Managed Servers

In OBIEE 11g/12c, WebLogic hosts the J2EE components:

| Managed Server | Hosts | Default Port |
|---|---|---|
| bi_server1 (AdminServer) | WLS Admin Console, MBeans | 7001 |
| bi_server1 (Managed) | analytics.war, xmlpserver.war, bimad.war | 9704 |
| bi_server1 (Managed) | Oracle BI Action Framework | 9704 |

The \`analytics\` WAR serves the main OBIEE web UI. The \`xmlpserver\` WAR serves Oracle BI Publisher (pixel-perfect reports). The two share the same managed server in standard deployments but can be separated for workload isolation.

### Oracle HTTP Server (OHS)

OHS sits in front of WebLogic and acts as the entry-point reverse proxy. It handles SSL termination, load distribution across WebLogic managed servers, and URL routing:

| URL Pattern | Backend |
|---|---|
| /analytics | WebLogic bi_server1 (OBIEE dashboards) |
| /xmlpserver | WebLogic bi_server1 (BI Publisher) |
| /analyticsRes | Static resource pass-through |

OHS listens on port **80** (HTTP) and **443** (HTTPS). Its integration with WebLogic is done via the WebLogic Web Server Plug-in (mod_wl_ohs).

### Component Port Summary

\`\`\`
Port  9703  │  BI Server ODBC listener         (nqsserver)
Port  9705  │  BI Server cluster controller    (nqsserver)
Port  9706  │  Scheduler cluster controller    (nqscheduler)
Port  9710  │  Presentation Services HTTP      (sawserver)
Port  9810  │  JavaHost                        (javahost)
Port  7001  │  WebLogic Admin Server           (WLS)
Port  9704  │  WebLogic Managed Server         (analytics, xmlpserver)
Port  80    │  Oracle HTTP Server (HTTP)       (OHS)
Port  443   │  Oracle HTTP Server (HTTPS)      (OHS)
Port  1521  │  Oracle Database                 (APPS, MDS, BIPlatform schemas)
\`\`\`

---

## The RPD: OBIEE's Semantic Layer

The Repository (RPD) file is a binary file that encodes the entire semantic model. It is the central artefact of OBIEE administration. All query behaviour — what SQL is generated, what security is applied, what aggregation rules are used — is governed by the RPD.

The RPD has three layers:

### Physical Layer

Maps to actual database objects. Each connection pool in the Physical Layer holds the JDBC/ODBC connection string and credentials for a data source. Tables and views in the Physical Layer correspond to tables and views in the underlying database.

For EBS integration, the Physical Layer holds a connection pool pointing to the APPS schema (or a read-only reporting user with grants on APPS views).

\`\`\`
Physical Layer
  └── Connection Pool: EBS_APPS
        Data Source Name: (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)
                           (HOST=ebsdb01)(PORT=1521))
                           (CONNECT_DATA=(SERVICE_NAME=EBSPROD)))
        User: apps_report
        └── Physical Schema: APPS
              ├── GL_BALANCES           (table)
              ├── AR_PAYMENT_SCHEDULES_ALL (table)
              ├── MTL_SYSTEM_ITEMS_B    (table)
              └── ... (thousands of EBS views/tables)
\`\`\`

### Business Model and Mapping Layer

The Business Model layer abstracts the Physical Layer into a dimensional model. Logical tables, logical columns, and logical dimension hierarchies are defined here. Join paths are expressed as logical joins rather than physical SQL joins. Aggregation rules (SUM, COUNT DISTINCT, etc.) are attached to measure columns here.

\`\`\`
Business Model: General Ledger
  ├── Logical Dimension Table: Dim - GL Account
  │     ├── Logical Column: Account Code Combination
  │     ├── Logical Column: Segment1 (Company)
  │     └── Logical Column: Account Description
  ├── Logical Dimension Table: Dim - Period
  │     ├── Logical Column: Period Name
  │     └── Logical Column: Fiscal Year
  └── Logical Fact Table: Fact - GL Balances
        ├── Logical Column: Actual Amount    (SUM)
        ├── Logical Column: Budget Amount    (SUM)
        └── Logical Column: Encumbrance Amt  (SUM)
\`\`\`

### Presentation Layer

The Presentation Layer defines what end users see — Subject Areas, folders, and column display names. It maps directly to the Business Model but can rename, reorganise, hide, or expose a subset of logical objects.

\`\`\`
Subject Area: "General Ledger - Balances"
  ├── Folder: Account
  │     ├── Column: Company
  │     ├── Column: Account
  │     └── Column: Account Description
  ├── Folder: Time
  │     ├── Column: Period Name
  │     └── Column: Fiscal Year
  └── Folder: Balances
        ├── Column: Actual Amount
        ├── Column: Budget Amount
        └── Column: Balance (Actual - Budget)
\`\`\`

---

## OBIEE Integration with Oracle E-Business Suite

### EBS as a Physical Data Source

The most direct integration is pointing OBIEE's Physical Layer at the APPS schema. OBIEE reads data from EBS database views — Oracle ships hundreds of pre-defined APPS views (e.g. \`GL_BALANCES\`, \`AR_AGING_7_BUCKET_V\`, \`PO_LINES_ACTIVE_V\`) that abstract multi-org complexity and present clean data surfaces.

**Recommended approach for EBS-OBIEE connectivity:**

1. Create a dedicated reporting user (not \`APPS\`) with SELECT grants on required views.
2. Use a read-only database service or a physical standby database to isolate reporting load from OLTP.
3. Tune the APPS views used by OBIEE queries — add function-based indexes on frequently filtered columns (period_name, org_id, set_of_books_id).

\`\`\`sql
-- Create a read-only reporting user for OBIEE
CREATE USER bi_reader IDENTIFIED BY "SecureP@ss1"
  DEFAULT TABLESPACE users TEMPORARY TABLESPACE temp;
GRANT CREATE SESSION TO bi_reader;

-- Grant access to commonly used EBS views
GRANT SELECT ON apps.gl_balances                    TO bi_reader;
GRANT SELECT ON apps.gl_code_combinations           TO bi_reader;
GRANT SELECT ON apps.gl_periods                     TO bi_reader;
GRANT SELECT ON apps.ar_payment_schedules_all        TO bi_reader;
GRANT SELECT ON apps.ap_invoices_all                 TO bi_reader;
GRANT SELECT ON apps.mtl_system_items_b              TO bi_reader;
GRANT SELECT ON apps.oe_order_headers_all            TO bi_reader;

-- Create synonyms in bi_reader schema (optional, cleaner RPD mapping)
CREATE SYNONYM bi_reader.gl_balances FOR apps.gl_balances;
\`\`\`

### Oracle BI Applications (OBIA)

Oracle BI Applications is a separate licensed product — a set of pre-built ETL mappings (Oracle Data Integrator or Informatica), a pre-built data warehouse schema, and a pre-built OBIEE RPD + Presentation Catalog for common EBS functional areas:

| OBIA Module | EBS Source | Analytics Provided |
|---|---|---|
| Financial Analytics | GL, AR, AP, FA | P&L, balance sheet, aging, payables performance |
| Supply Chain Analytics | INV, PO, OM | Inventory turns, order fulfilment, supplier performance |
| HR Analytics | HR, Payroll | Headcount, attrition, compensation |
| Project Analytics | Projects (PA) | Cost, revenue, margin by project |
| CRM Analytics | CRM (TCA, CS) | Pipeline, win/loss, service resolution |

OBIA uses a staging and warehouse schema (\`OBIA_DW\`) separate from APPS. ETL jobs run on a schedule to extract from APPS, transform, and load into the warehouse. OBIEE then reports against the warehouse rather than directly against APPS — isolating reporting load and enabling historical trend analysis beyond what APPS tables support.

### Multi-Org Security: Initialisation Blocks

EBS is a Multi-Org application. Data in tables like \`GL_BALANCES\`, \`AP_INVOICES_ALL\`, and \`MTL_SYSTEM_ITEMS_B\` is partitioned by \`ORG_ID\` (operating unit) and \`SET_OF_BOOKS_ID\` / \`LEDGER_ID\`. Security is enforced in EBS through Virtual Private Database (VPD) policies attached to the \`_ALL\` views.

When OBIEE connects to APPS, the VPD policies evaluate the database session context — specifically the values set by \`MO_GLOBAL.SET_POLICY_CONTEXT\` and \`FND_GLOBAL.APPS_INITIALIZE\`. Without these, the \`_ALL\` views return no rows.

**Initialisation Blocks** in the RPD solve this. An Init Block is a SQL or procedure call that executes at session start and populates OBIEE session variables. Those variables are then used in subsequent queries.

\`\`\`sql
-- Init Block: EBS Session Initialisation
-- Runs when a user logs in; sets ORG_ID and LEDGER_ID based on their
-- OBIEE group-to-responsibility mapping table
SELECT
  r.org_id,
  r.set_of_books_id
FROM
  bi_reader.obiee_user_org_map r
WHERE
  r.obiee_username = ':USER'
  AND ROWNUM = 1
\`\`\`

The Init Block populates session variables \`ORG_ID\` and \`LEDGER_ID\`, which are then injected into physical SQL via column filters or connection pool init SQL:

\`\`\`sql
-- Connection Pool Init SQL (runs for each new JDBC connection)
BEGIN
  MO_GLOBAL.SET_POLICY_CONTEXT('S', :ORG_ID);
  FND_GLOBAL.APPS_INITIALIZE(:USER_ID, :RESP_ID, :RESP_APPL_ID);
END;
\`\`\`

This ensures that every OBIEE query runs within the correct EBS Org context, and the VPD policies filter data to only the operating units the user is authorised to see.

### EBS Responsibility-Based Security in OBIEE

In a full EBS-SSO topology, OBIEE security is aligned with EBS responsibilities:

1. Users authenticate via Oracle Access Manager (OAM) or Oracle SSO — the same session used for EBS.
2. OBIEE receives the authenticated username from the web tier (via HTTP header or REMOTE_USER).
3. An Init Block maps the user to their EBS responsibilities and derives the corresponding \`ORG_ID\`, \`RESP_ID\`, and \`USER_ID\` values.
4. These values drive both the OBIEE Presentation Catalog permissions (which dashboards/reports are visible) and the physical-layer VPD context (which rows are returned).

\`\`\`
EBS User logs into OAM ──▶ OAM issues SSO token
        │
        ▼
OHS (OBIEE web tier) validates token via mod_osso
        │
        ▼
analytics WAR (WebLogic) — REMOTE_USER = 'JSMITH'
        │
        ▼
Presentation Services ──▶ BI Server
        │
        ▼
Init Block: SELECT resp_id, user_id, org_id
            FROM fnd_user_resp_groups
            WHERE user_name = 'JSMITH'
        │
        ▼
Physical SQL runs with:
  MO_GLOBAL.SET_POLICY_CONTEXT('S', 204);
  FND_GLOBAL.APPS_INITIALIZE(1234, 50631, 200);
        │
        ▼
VPD filters: only rows WHERE ORG_ID = 204 returned
\`\`\`

---

## Deployment Topology

### Single-Node Development Topology

\`\`\`
┌───────────────────────────────────────────────────────────┐
│                  OBIEE Server (1 host)                    │
│                                                           │
│  ┌──────────────────────────────────────────────────┐    │
│  │  Oracle HTTP Server (OHS)                         │    │
│  │  Port 80/443  →  mod_wl_ohs  →  WLS :9704        │    │
│  └──────────────────────────────────────────────────┘    │
│                                                           │
│  ┌─────────────────────────────────────────────────┐     │
│  │  WebLogic Domain (bifoundation_domain)           │     │
│  │  ┌──────────────────┐  ┌──────────────────────┐  │     │
│  │  │  AdminServer     │  │  bi_server1 (managed)│  │     │
│  │  │  Port: 7001      │  │  Port: 9704          │  │     │
│  │  │  WLS Console     │  │  analytics.war       │  │     │
│  │  └──────────────────┘  │  xmlpserver.war      │  │     │
│  │                        └──────────────────────┘  │     │
│  └─────────────────────────────────────────────────┘     │
│                                                           │
│  ┌───────────┐  ┌───────────┐  ┌──────────┐             │
│  │BI Server  │  │Presentn   │  │Scheduler │             │
│  │nqsserver  │  │Services   │  │schsrv    │             │
│  │Port: 9703 │  │sawserver  │  │Port: 9706│             │
│  └───────────┘  │Port: 9710 │  └──────────┘             │
│                 └───────────┘                             │
│  ┌──────────────────────────────────────────────────┐    │
│  │  JavaHost  Port: 9810                             │    │
│  └──────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────┘
                          │
                    (JDBC/ODBC :1521)
                          │
               ┌──────────▼──────────┐
               │   Oracle Database   │
               │   APPS schema       │
               │   MDS / BIPlatform  │
               │   Scheduler schema  │
               └─────────────────────┘
\`\`\`

Used for development, POC, and small single-user environments. All OBIEE processes run on one host. No HA — any component restart brings down the stack.

### Scale-Out HA Topology (OBIEE 11g/12c)

OBIEE supports horizontal scale-out by adding additional BI Server and Presentation Services instances behind the existing OHS. All BI Server instances share a single RPD file via a shared filesystem (NFS). The Cluster Controller (nqclustercontroller) arbitrates queries across BI Server nodes.

\`\`\`
         Internet / EBS Intranet
                  │
         ┌────────▼────────┐
         │  Load Balancer  │   (F5, OTD, or haproxy)
         │  VIP: :443      │
         └────────┬────────┘
                  │
      ┌───────────┼───────────┐
      │           │           │
┌─────▼──┐  ┌────▼───┐  ┌────▼───┐
│  OHS   │  │  OHS   │  │  OHS   │
│ Node 1 │  │ Node 2 │  │ Node 3 │
│ :80/:443│  │:80/:443│  │:80/:443│
└─────┬──┘  └────┬───┘  └────┬───┘
      └──────────┼────────────┘
                 │ mod_wl_ohs (round-robin to WLS cluster)
      ┌──────────┼────────────┐
      │          │            │
┌─────▼────┐ ┌───▼─────┐ ┌───▼─────┐
│ WLS Mgd  │ │ WLS Mgd │ │ WLS Mgd │
│ Server 1 │ │ Server 2 │ │ Server 3 │
│ :9704    │ │ :9704   │ │ :9704   │
│analytics │ │analytics│ │analytics│
└────┬─────┘ └────┬────┘ └────┬────┘
     │             │           │
     └─────────────┼───────────┘
                   │ ODBC :9703
     ┌─────────────┼───────────┐
     │             │           │
┌────▼────┐  ┌────▼────┐  ┌───▼─────┐
│  BISVR  │  │  BISVR  │  │  BISVR  │
│  Node 1 │  │  Node 2 │  │  Node 3 │
│nqsserver│  │nqsserver│  │nqsserver│
│  :9703  │  │  :9703  │  │  :9703  │
└────┬────┘  └────┬────┘  └─────┬───┘
     └────────────┼──────────────┘
                  │   Shared NFS: RPD file, log dirs
     ┌────────────▼──────────────┐
     │       NFS / Shared FS     │
     │  /u01/obiee/repository/   │
     │  StarRepository.rpd       │
     └────────────┬──────────────┘
                  │
     ┌────────────▼──────────────┐
     │       Oracle DB (RAC)     │
     │  APPS schema, MDS repo,   │
     │  BIPlatform schema        │
     └───────────────────────────┘
\`\`\`

**Key HA design decisions:**
- OHS nodes terminate SSL; WebLogic cluster handles session stickiness via JSESSIONID cookie.
- BI Server nodes are peer — the Cluster Controller balances logical query load across them.
- RPD file must live on a shared filesystem (NFS or cluster FS) so all BI Server nodes read from the same binary.
- The Presentation Catalog must also be on shared storage so all Presentation Services instances see the same dashboards and saved reports.

### Full EBS + OBIEE Integrated Topology

This is the production pattern for organisations running OBIEE as the reporting layer over a live EBS instance.

\`\`\`
┌──────────────────────────────────────────────────────────────────────┐
│                           DMZ / Intranet                             │
│                                                                      │
│  Browser / Smart View ───▶ Load Balancer (:443)                      │
└────────────────────────────────┬─────────────────────────────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
      ┌───────▼───────┐  ┌───────▼───────┐  ┌──────▼────────┐
      │   OHS Node 1  │  │   OHS Node 2  │  │  OHS Node 3   │
      │  (EBS + BI)   │  │  (EBS + BI)   │  │  (EBS + BI)   │
      │  mod_wl_ohs   │  │  mod_wl_ohs   │  │  mod_wl_ohs   │
      │  mod_osso     │  │  mod_osso     │  │  mod_osso     │
      └───────┬───────┘  └───────┬───────┘  └──────┬────────┘
              └──────────────────┼──────────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                                     │
     ┌────────▼──────────┐             ┌────────────▼──────────┐
     │  EBS App Tier     │             │  OBIEE App Tier        │
     │                   │             │                        │
     │  WLS Domain:      │             │  WLS Domain:           │
     │   oacore          │             │   bifoundation         │
     │   oafm            │             │   bi_server1 :9704     │
     │   forms           │             │                        │
     │                   │             │  nqsserver  :9703      │
     │  Port: 8000       │             │  sawserver  :9710      │
     └────────┬──────────┘             │  schsrv     :9706      │
              │                        │  javahost   :9810      │
              │ SSO (OAM token)        └────────────┬──────────┘
              │ shared via OHS                      │ JDBC :1521
              └──────────────┐                      │
                             │          ┌────────────▼──────────┐
                    ┌────────▼────────┐ │  Oracle DB (RAC)      │
                    │  Oracle Access  │ │                       │
                    │  Manager (OAM)  │ │  APPS schema          │
                    │  + Oracle SSO   │ │  (EBS data)           │
                    └─────────────────┘ │                       │
                                        │  MDS / BIPlatform     │
                                        │  (OBIEE repos)        │
                                        │                       │
                                        │  Scheduler schema     │
                                        └───────────────────────┘
\`\`\`

**Integration flow for an EBS user accessing OBIEE:**

1. User logs into EBS through OAM-protected OHS (single sign-on established).
2. User navigates to an OBIEE dashboard link in the EBS menu (embedded via FND_FUNCTION or personalisation).
3. OHS passes the SSO token (ORASSO_ATPPC cookie or SAML assertion) to the OBIEE-side OHS.
4. OBIEE Presentation Services validates the token with OAM; the authenticated username is extracted.
5. BI Server Init Block queries the EBS-OBIEE security mapping table to derive ORG_ID, RESP_ID, and USER_ID.
6. Physical SQL executes against APPS with the correct MO/FND context; VPD row filtering is active.
7. Results are rendered in the dashboard and returned to the user's browser.

---

## Key OBIEE Administrative Tasks

### Starting and Stopping OBIEE Processes

The OPMN (Oracle Process Manager and Notification Server) daemon manages the OBIEE system components (nqsserver, sawserver, etc.) in OBIEE 11g. In OBIEE 12c, the equivalent is the Node Manager + WebLogic scripting.

\`\`\`bash
# OBIEE 11g — start/stop all system components via OPMN
$ORACLE_INSTANCE/bin/opmnctl startall
$ORACLE_INSTANCE/bin/opmnctl stopall
$ORACLE_INSTANCE/bin/opmnctl status

# Start/stop individual components
$ORACLE_INSTANCE/bin/opmnctl start opmn:ohs:HTTP_SERVER1
$ORACLE_INSTANCE/bin/opmnctl start opmn:OracleBIServerComponent:coreapplication_obis1
$ORACLE_INSTANCE/bin/opmnctl start opmn:OracleBIPresentationServicesComponent:coreapplication_obips1

# OBIEE 12c — WebLogic Node Manager handles system components
# Start Admin Server
$DOMAIN_HOME/bin/startWebLogic.sh

# Start Managed Server and system components via WLS WLST or EM
wlst.sh
connect('weblogic','password','t3://localhost:7001')
startServer('bi_server1','bifoundation_domain','t3://localhost:9704')
\`\`\`

### RPD Deployment

\`\`\`bash
# OBIEE 11g — upload RPD via adminTool (GUI) or command line
# Upload using OBIEE Admin Tool command line (opatch must be current):
$ORACLE_BI_HOME/bifoundation/server/bin/AdminTool.sh \
  -import StarRepository.rpd \
  -password Admin1234 \
  -online localhost:9703 \
  -adminuser weblogic \
  -adminpassword password

# OBIEE 12c — use the datamodel-cmd utility
$ORACLE_HOME/bi/bitools/bin/datamodel.sh uploadrpd \
  -I StarRepository_prod.rpd \
  -P Admin1234 \
  -SI ssi \
  -U weblogic \
  -P password \
  -S localhost \
  -N 9502

# Check current loaded RPD
$ORACLE_HOME/bi/bitools/bin/datamodel.sh downloadrpd \
  -O /tmp/current_live.rpd \
  -W Admin1234 \
  -SI ssi \
  -U weblogic
\`\`\`

### Checking Usage Tracking

OBIEE Usage Tracking writes every query issued against the BI Server into a relational table — which is the primary operational data source for understanding what subject areas are used, which dashboards run slowly, and what the peak load hours are.

\`\`\`sql
-- Usage Tracking is written to S_NQ_ACCT table (configure in NQSConfig.INI)
-- Typical Usage Tracking analysis queries:

-- Top 20 slowest queries in the last 7 days
SELECT
  logical_query_text,
  ROUND(total_time_sec / num_cache_misses, 2) AS avg_exec_sec,
  num_cache_misses AS executions,
  start_dt
FROM s_nq_acct
WHERE start_dt >= SYSDATE - 7
  AND num_cache_misses > 0
ORDER BY avg_exec_sec DESC
FETCH FIRST 20 ROWS ONLY;

-- Subject area usage by day
SELECT
  TRUNC(start_dt) AS query_date,
  subject_area_name,
  COUNT(*) AS query_count
FROM s_nq_acct
WHERE start_dt >= SYSDATE - 30
GROUP BY TRUNC(start_dt), subject_area_name
ORDER BY 1 DESC, 3 DESC;
\`\`\`

### BI Server Query Cache

The BI Server maintains an in-memory query cache that stores the result sets of recently executed logical queries. Subsequent identical (or semantically equivalent) queries are served from cache without hitting the database.

\`\`\`
-- NQSConfig.INI cache settings
[ CACHE ]
  ENABLE = YES ;
  DATA_STORAGE_PATHS = "/u01/obiee/cache" 500 MB ;
  MAX_CACHE_ENTRIES = 1000 ;
  MAX_CACHE_ENTRY_SIZE = 20 MB ;
  CACHE_POLL_SECONDS = 60 ;
  GLOBAL_CACHE_STORAGE_PATH = "/u01/obiee/global_cache" 1 GB ;
\`\`\`

Purge the cache after EBS period-close processes complete to ensure OBIEE does not serve stale period-end data:

\`\`\`sql
-- Purge the entire BI Server cache via ODBC/XMLA (schedulable via iBot)
-- Connect to nqsserver as Administrator
CALL SAPurgeAllCache();

-- Purge cache for a specific subject area
CALL SAPurgeCacheBySubjectArea('General Ledger - Balances');
\`\`\`

---

## Common EBS-OBIEE Issues and Resolutions

| Symptom | Likely Cause | Resolution |
|---|---|---|
| OBIEE dashboards return no data for EBS views | MO/FND context not set on JDBC connection | Verify Connection Pool Init SQL calls \`MO_GLOBAL.SET_POLICY_CONTEXT\` with the correct ORG_ID session variable |
| VPD error: ORA-28110 on APPS views | BI Server connecting as a user without VPD context | Create a dedicated BI reporting user and grant it direct EXEMPT ACCESS POLICY or configure Init Block correctly |
| Init Block returns wrong org for user | Stale mapping in obiee_user_org_map / EBS resp mapping table | Refresh mapping table from FND_USER_RESP_GROUPS; check Init Block query filter on \`:USER\` variable |
| Users see "No Results" after EBS period close | Stale BI Server query cache serving pre-close data | Schedule cache purge (CALL SAPurgeAllCache) as part of period-close runbook |
| OBIEE dashboards inaccessible after EBS patching | OHS/SSO configuration changed by EBS AD patch | Verify mod_osso partner application registration in OAM; re-register if needed |
| nqsserver crash with "Segmentation fault" on large query | Large IN-list from Presentation Services filter expansion | Tune IN_PREDICATE_COLLAPSE_THRESHOLD in NQSConfig.INI; check for runaway member selections in filter |
| Slow OBIEE queries against GL_BALANCES | Missing index on PERIOD_NAME, LEDGER_ID in GL | Add function-based index; switch to APPS pre-aggregated summary tables where possible |
`,
};

async function main() {
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
  console.log('inserted:', post.slug);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
