import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'mulesoft-salesforce-oracle-database-integration-data-mining-runbook';

const content = `
This runbook provides step-by-step procedures for building, deploying, and operating a MuleSoft Anypoint Platform integration that extracts Salesforce data and loads it into Oracle Database for cross-system data mining. It covers Connected App setup in Salesforce, Oracle JDBC credential configuration, Anypoint Studio project structure, CloudHub deployment, scheduler configuration, the Oracle staging schema, monitoring setup, and troubleshooting for the common failure modes.

---

## Phase 1: Prerequisites

Before building the integration, confirm the following are in place.

### 1.1 Anypoint Platform account and licences

- An Anypoint Platform organisation account with at least one CloudHub 1.0 or CloudHub 2.0 worker vCore entitlement, or an on-premise Mule Runtime server
- MuleSoft Anypoint Studio 7.x installed locally for development
- Access to Anypoint Exchange for the Salesforce Connector and Database Connector

### 1.2 Salesforce access

- A Salesforce org (Developer, Sandbox, or Production)
- System Administrator profile or equivalent — required to create a Connected App
- API access enabled on the org (verify: Setup → API → Enabled)

### 1.3 Oracle access

- Oracle Database 12c or later (on-premise, RAC, or Autonomous Database)
- A dedicated service account with SELECT on the AR and customer tables, and INSERT/MERGE on the staging tables
- The Oracle JDBC driver — download \`ojdbc11.jar\` from the Oracle Maven repository or oracle.com/database/technologies/appdev/jdbc-downloads.html
- TNS connectivity confirmed from the MuleSoft runtime host to the Oracle listener

### 1.4 Java and Maven

\`\`\`bash
java -version   # Requires Java 11 or 17
mvn -version    # Maven 3.6+
\`\`\`

Anypoint Studio ships its own bundled JDK. If deploying to CloudHub, the Java version is managed by the platform — select the runtime version in the CloudHub deployment configuration.

---

## Phase 2: Salesforce Connected App Setup

### 2.1 Create the Connected App

1. In Salesforce, navigate to **Setup → App Manager → New Connected App**
2. Fill in the required fields:
   - **Connected App Name**: \`MuleSoft Oracle Data Mining\`
   - **API Name**: auto-populated
   - **Contact Email**: your admin email
3. Under **API (Enable OAuth Settings)**:
   - Check **Enable OAuth Settings**
   - **Callback URL**: \`https://login.salesforce.com/services/oauth2/success\` (placeholder for JWT flow)
   - **Selected OAuth Scopes**: add \`Full access (full)\` and \`Perform requests at any time (refresh_token, offline_access)\`
4. Check **Use digital signatures** and upload the public key certificate (see Phase 2.2)
5. Save. Note the **Consumer Key** (Client ID) — you will need it in the Mule configuration.

### 2.2 Generate the RSA key pair for JWT Bearer flow

\`\`\`bash
# Generate a 2048-bit private key
openssl genrsa -out mulesoft_sf.pem 2048

# Extract the public certificate (valid for 10 years)
openssl req -new -x509 -key mulesoft_sf.pem -out mulesoft_sf.crt -days 3650 \
  -subj "/CN=MuleSoft Salesforce Integration/O=YourOrg/C=US"

# Convert the private key to PKCS12 keystore for MuleSoft
openssl pkcs12 -export \
  -in mulesoft_sf.crt \
  -inkey mulesoft_sf.pem \
  -out mulesoft_sf.p12 \
  -name "mulesoft_sf" \
  -passout pass:changeit
\`\`\`

Upload \`mulesoft_sf.crt\` to the Connected App in Salesforce (step 4 above). Store \`mulesoft_sf.p12\` in the Mule project under \`src/main/resources/keystore/\`. Do not commit the private key or the P12 file to source control — inject them as a secure property or store in a vault.

### 2.3 Approve the Connected App for JWT

After saving the Connected App:
1. Navigate to **Setup → Connected Apps → Manage Connected Apps**
2. Click **Edit Policies** on the app you created
3. Set **Permitted Users** to \`Admin approved users are pre-authorized\`
4. Set **IP Relaxation** to \`Relax IP restrictions\` (or configure the MuleSoft runtime IP range)
5. Save, then navigate to **Profiles** or **Permission Sets** and add the integration user profile/permission set to the Connected App

### 2.4 Create or identify the integration API user

The JWT Bearer flow authenticates as a specific Salesforce user. This should be a dedicated integration user, not a named human user:

1. **Setup → Users → New User**
2. Profile: \`System Administrator\` or a custom minimal-permission profile with API access and read access to Accounts, Opportunities, and Cases
3. Note the username — this is the \`principal\` in the MuleSoft OAuth JWT configuration

---

## Phase 3: Oracle Staging Schema Setup

Run these statements as a DBA or as the schema owner before deploying the integration.

### 3.1 Create the staging user (if needed)

\`\`\`sql
-- As SYSDBA or DBA
CREATE USER mule_staging IDENTIFIED BY "<password>"
  DEFAULT TABLESPACE users
  QUOTA UNLIMITED ON users;

GRANT CREATE SESSION TO mule_staging;
GRANT CREATE TABLE   TO mule_staging;
GRANT CREATE INDEX   TO mule_staging;
\`\`\`

### 3.2 Create staging tables

\`\`\`sql
-- Connect as mule_staging or target schema

CREATE TABLE sf_account_dim (
  sf_id             VARCHAR2(18)   NOT NULL,
  account_name      VARCHAR2(255),
  industry          VARCHAR2(100),
  annual_revenue    NUMBER(15,2),
  balance_due       NUMBER(15,2)   DEFAULT 0,
  open_opp_count    NUMBER(5)      DEFAULT 0,
  last_modified_dt  TIMESTAMP,
  created_at        TIMESTAMP      DEFAULT SYSTIMESTAMP,
  updated_at        TIMESTAMP      DEFAULT SYSTIMESTAMP,
  CONSTRAINT sf_account_dim_pk PRIMARY KEY (sf_id)
);

CREATE TABLE sf_opportunity_staging (
  sf_id             VARCHAR2(18)   NOT NULL,
  account_sf_id     VARCHAR2(18),
  opportunity_name  VARCHAR2(255),
  amount            NUMBER(15,2),
  stage             VARCHAR2(100),
  close_date        DATE,
  owner_id          VARCHAR2(18),
  loaded_at         TIMESTAMP      DEFAULT SYSTIMESTAMP,
  CONSTRAINT sf_opp_staging_pk PRIMARY KEY (sf_id)
);

CREATE TABLE sf_oracle_customer_xref (
  sf_account_id          VARCHAR2(18)  NOT NULL,
  oracle_customer_number VARCHAR2(30)  NOT NULL,
  matched_on             VARCHAR2(50)  DEFAULT 'external_id',
  created_at             TIMESTAMP     DEFAULT SYSTIMESTAMP,
  CONSTRAINT sf_oracle_xref_pk PRIMARY KEY (sf_account_id)
);

CREATE TABLE mule_batch_log (
  log_id          NUMBER GENERATED ALWAYS AS IDENTITY,
  batch_name      VARCHAR2(100),
  run_date        TIMESTAMP      DEFAULT SYSTIMESTAMP,
  records_success NUMBER(10)     DEFAULT 0,
  records_failed  NUMBER(10)     DEFAULT 0,
  status          VARCHAR2(20),
  error_message   VARCHAR2(4000),
  CONSTRAINT mule_batch_log_pk PRIMARY KEY (log_id)
);

CREATE INDEX sf_opp_stage_idx ON sf_opportunity_staging (stage, close_date);
CREATE INDEX sf_opp_acct_idx  ON sf_opportunity_staging (account_sf_id);
CREATE INDEX sf_xref_cust_idx ON sf_oracle_customer_xref (oracle_customer_number);
\`\`\`

### 3.3 Grant access to EBS AR tables (if using EBS Oracle schema)

\`\`\`sql
-- As APPS or DBA
GRANT SELECT ON ar_payment_schedules_all TO mule_staging;
GRANT SELECT ON hz_cust_accounts         TO mule_staging;
GRANT SELECT ON hz_parties               TO mule_staging;
GRANT SELECT ON oe_order_headers_all     TO mule_staging;
\`\`\`

### 3.4 Verify connectivity from runtime host

\`\`\`bash
# From the MuleSoft runtime server or developer workstation
sqlplus mule_staging/<password>@//<oracle-host>:1521/<service>

SQL> SELECT COUNT(*) FROM sf_account_dim;
-- Expected: 0 (empty table, connection works)
SQL> EXIT;
\`\`\`

---

## Phase 4: Anypoint Studio Project Setup

### 4.1 Create a new Mule project

1. Open Anypoint Studio → **File → New → Mule Project**
2. Project name: \`salesforce-oracle-pipeline\`
3. Mule Runtime: select 4.6.x or latest
4. Click **Finish**

### 4.2 Add connector dependencies to pom.xml

Open \`pom.xml\` and add the following inside \`<dependencies>\`:

\`\`\`xml
<!-- Salesforce Connector -->
<dependency>
  <groupId>com.mulesoft.connectors</groupId>
  <artifactId>mule-salesforce-connector</artifactId>
  <version>10.18.0</version>
  <classifier>mule-plugin</classifier>
</dependency>

<!-- Database Connector -->
<dependency>
  <groupId>org.mule.connectors</groupId>
  <artifactId>mule-db-connector</artifactId>
  <version>1.14.3</version>
  <classifier>mule-plugin</classifier>
</dependency>

<!-- Oracle JDBC Driver -->
<dependency>
  <groupId>com.oracle.database.jdbc</groupId>
  <artifactId>ojdbc11</artifactId>
  <version>23.4.0.24.05</version>
</dependency>

<!-- Batch Module -->
<dependency>
  <groupId>com.mulesoft.modules</groupId>
  <artifactId>mule-batch-module</artifactId>
  <version>2.2.0</version>
  <classifier>mule-plugin</classifier>
</dependency>
\`\`\`

Save \`pom.xml\`. Studio will download the connectors from Anypoint Exchange.

### 4.3 Create the properties files

Create \`src/main/resources/config.yaml\`:

\`\`\`yaml
salesforce:
  consumer.key: "\${salesforce.consumer.key}"
  username: "\${salesforce.username}"
  keystore.path: "keystore/mulesoft_sf.p12"
  keystore.password: "\${salesforce.keystore.password}"

oracle:
  host: "\${oracle.host}"
  port: "\${oracle.port}"
  service: "\${oracle.service}"
  username: "\${oracle.username}"
  password: "\${oracle.password}"

batch:
  modified.days: "1"
  scheduler.cron: "0 0 2 * * ?"
  scheduler.timezone: "America/New_York"
\`\`\`

Create \`src/main/resources/config-local.yaml\` with actual development values (add to \`.gitignore\`):

\`\`\`yaml
salesforce:
  consumer.key: "3MVG9..."
  username: "integration@yourorg.com"
  keystore.password: "changeit"

oracle:
  host: "oradb01.example.com"
  port: "1521"
  service: "PRODDB"
  username: "mule_staging"
  password: "secure_password"
\`\`\`

### 4.4 Place the keystore in the project

\`\`\`bash
mkdir -p src/main/resources/keystore
cp /path/to/mulesoft_sf.p12 src/main/resources/keystore/
\`\`\`

Add to \`.gitignore\`:

\`\`\`
src/main/resources/keystore/
src/main/resources/config-local.yaml
\`\`\`

### 4.5 Create the global configuration file

Create \`src/main/mule/global-config.xml\`:

\`\`\`xml
<?xml version="1.0" encoding="UTF-8"?>
<mule xmlns="http://www.mulesoft.org/schema/mule/core"
      xmlns:salesforce="http://www.mulesoft.org/schema/mule/salesforce"
      xmlns:db="http://www.mulesoft.org/schema/mule/db"
      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
      xsi:schemaLocation="
        http://www.mulesoft.org/schema/mule/core
          http://www.mulesoft.org/schema/mule/core/current/mule.xsd
        http://www.mulesoft.org/schema/mule/salesforce
          http://www.mulesoft.org/schema/mule/salesforce/current/mule-salesforce.xsd
        http://www.mulesoft.org/schema/mule/db
          http://www.mulesoft.org/schema/mule/db/current/mule-db.xsd">

  <!-- Salesforce: OAuth JWT Bearer -->
  <salesforce:config name="Salesforce_Config" doc:name="Salesforce Config">
    <salesforce:oauth-jwt-bearer-connection
      consumerKey="\${salesforce.consumer.key}"
      keyStorePath="\${salesforce.keystore.path}"
      keyStorePassword="\${salesforce.keystore.password}"
      principal="\${salesforce.username}"
      tokenEndpoint="https://login.salesforce.com/services/oauth2/token" />
  </salesforce:config>

  <!-- Oracle Database -->
  <db:config name="Oracle_Config" doc:name="Oracle DB Config">
    <db:generic-connection
      url="jdbc:oracle:thin:@//\${oracle.host}:\${oracle.port}/\${oracle.service}"
      driverClassName="oracle.jdbc.OracleDriver"
      user="\${oracle.username}"
      password="\${oracle.password}">
      <reconnection failsDeployment="false">
        <reconnect frequency="30000" count="5" />
      </reconnection>
    </db:generic-connection>
  </db:config>

  <!-- Global error handler -->
  <error-handler name="GlobalErrorHandler">
    <on-error-continue type="DB:CONNECTIVITY" logException="true">
      <logger level="ERROR"
              message="#['[Oracle] Connectivity error: ' ++ error.description]" />
    </on-error-continue>
    <on-error-continue type="SALESFORCE:CONNECTIVITY" logException="true">
      <logger level="ERROR"
              message="#['[Salesforce] Connectivity error: ' ++ error.description]" />
    </on-error-continue>
    <on-error-propagate type="ANY">
      <logger level="ERROR"
              message="#['[Unhandled] ' ++ error.errorType ++ ': ' ++ error.description]" />
    </on-error-propagate>
  </error-handler>

  <!-- Configuration properties -->
  <configuration-properties
    file="config.yaml"
    doc:name="App Properties" />

</mule>
\`\`\`

---

## Phase 5: Build the Integration Flows

Create \`src/main/mule/nightly-extract.xml\` for the batch pipeline.

### 5.1 Scheduler trigger flow

\`\`\`xml
<flow name="NightlyExtractTrigger" doc:name="Nightly Extract Trigger">
  <scheduler doc:name="Nightly at 02:00">
    <scheduling-strategy>
      <cron expression="\${batch.scheduler.cron}"
            timeZone="\${batch.scheduler.timezone}" />
    </scheduling-strategy>
  </scheduler>

  <set-variable variableName="extractDays"
                value="\${batch.modified.days}"
                doc:name="Set modified days window" />

  <logger level="INFO"
          message="#['[Trigger] Starting nightly Salesforce extract. Days back: ' ++ vars.extractDays]" />

  <batch:execute name="NightlySalesforceExtract"
                 doc:name="Execute nightly batch" />
</flow>
\`\`\`

### 5.2 Batch job — account extract, enrich, upsert

\`\`\`xml
<batch:job name="NightlySalesforceExtract" doc:name="Nightly Salesforce Extract"
           maxFailedRecords="100">

  <batch:input>
    <salesforce:query-all config-ref="Salesforce_Config"
                          doc:name="Bulk query modified accounts">
      <salesforce:salesforce-query><![CDATA[
        SELECT Id, Name, Industry, AnnualRevenue, NumberOfEmployees,
               BillingCountry, ExternalCustomerNumber__c,
               LastModifiedDate,
               (SELECT Id, StageName, Amount, CloseDate
                FROM   Opportunities
                WHERE  IsClosed = false)
        FROM   Account
        WHERE  LastModifiedDate = LAST_N_DAYS:#[vars.extractDays]
      ]]></salesforce:salesforce-query>
    </salesforce:query-all>
  </batch:input>

  <!-- Step 1: Enrich with Oracle AR balance -->
  <batch:step name="EnrichWithARBalance">
    <set-variable variableName="sfRecord"
                  value="#[payload]"
                  doc:name="Save SF record" />
    <db:select config-ref="Oracle_Config"
               doc:name="Get AR balance from Oracle">
      <db:sql><![CDATA[
        SELECT NVL(SUM(ps.amount_due_remaining), 0) AS balance_due,
               COUNT(ps.payment_schedule_id)         AS open_invoices
        FROM   ar_payment_schedules_all ps
        JOIN   hz_cust_accounts c
               ON  c.cust_account_id = ps.customer_id
               AND c.account_number  = :custNum
        WHERE  ps.status = 'OP'
      ]]></db:sql>
      <db:input-parameters>
        #[{ custNum: vars.sfRecord.ExternalCustomerNumber__c default '' }]
      </db:input-parameters>
    </db:select>
    <set-variable variableName="arData"
                  value="#[payload[0]]"
                  doc:name="Save AR data" />
  </batch:step>

  <!-- Step 2: Upsert into Oracle staging table -->
  <batch:step name="UpsertAccountDim">
    <db:insert config-ref="Oracle_Config"
               doc:name="Upsert sf_account_dim">
      <db:sql><![CDATA[
        MERGE INTO sf_account_dim tgt
        USING (SELECT :sfId AS sf_id FROM dual) src
        ON (tgt.sf_id = src.sf_id)
        WHEN MATCHED THEN UPDATE SET
          tgt.account_name     = :accountName,
          tgt.industry         = :industry,
          tgt.annual_revenue   = :annualRevenue,
          tgt.balance_due      = :balanceDue,
          tgt.open_opp_count   = :openOppCount,
          tgt.last_modified_dt = :lastModifiedDt,
          tgt.updated_at       = SYSTIMESTAMP
        WHEN NOT MATCHED THEN INSERT
          (sf_id, account_name, industry, annual_revenue,
           balance_due, open_opp_count, last_modified_dt, created_at, updated_at)
        VALUES
          (:sfId, :accountName, :industry, :annualRevenue,
           :balanceDue, :openOppCount, :lastModifiedDt, SYSTIMESTAMP, SYSTIMESTAMP)
      ]]></db:sql>
      <db:input-parameters>
        #[{
          sfId:           vars.sfRecord.Id,
          accountName:    vars.sfRecord.Name,
          industry:       vars.sfRecord.Industry default null,
          annualRevenue:  vars.sfRecord.AnnualRevenue default 0,
          balanceDue:     vars.arData.BALANCE_DUE default 0,
          openOppCount:   (vars.sfRecord.Opportunities.records default []) sizeOf,
          lastModifiedDt: vars.sfRecord.LastModifiedDate as DateTime
        }]
      </db:input-parameters>
    </db:insert>
  </batch:step>

  <!-- On Complete: log results to Oracle -->
  <batch:on-complete>
    <db:insert config-ref="Oracle_Config"
               doc:name="Log batch result">
      <db:sql><![CDATA[
        INSERT INTO mule_batch_log
          (batch_name, run_date, records_success, records_failed, status)
        VALUES
          ('NightlySalesforceExtract', SYSTIMESTAMP, :success, :failed,
           CASE WHEN :failed = 0 THEN 'SUCCESS' ELSE 'PARTIAL' END)
      ]]></db:sql>
      <db:input-parameters>
        #[{
          success: payload.successfulRecords,
          failed:  payload.failedRecords
        }]
      </db:input-parameters>
    </db:insert>
    <logger level="INFO"
            message="#['[Batch] Complete — success: ' ++ payload.successfulRecords as String
                       ++ ' | failed: ' ++ payload.failedRecords as String]" />
  </batch:on-complete>

</batch:job>
\`\`\`

---

## Phase 6: Run and Test Locally

### 6.1 Configure local run configuration in Studio

1. Right-click the project → **Run As → Mule Application**
2. In the **Run Configurations** dialog, add a VM argument to load the local config:
   \`\`\`
   -Dmule.env=local
   \`\`\`
3. In \`global-config.xml\`, the properties loader reads \`config-local.yaml\` when \`mule.env=local\`.

Alternatively, use separate property file resolution:

\`\`\`xml
<configuration-properties
  file="config-\${mule.env}.yaml"
  doc:name="Environment properties" />
\`\`\`

### 6.2 Trigger the batch manually via HTTP (for testing)

Add a temporary HTTP trigger alongside the cron for local testing:

\`\`\`xml
<flow name="ManualTrigger" doc:name="Manual Test Trigger">
  <http:listener config-ref="HTTP_Listener_Config"
                 path="/trigger-extract"
                 doc:name="POST /trigger-extract" />
  <set-variable variableName="extractDays" value="7" />
  <batch:execute name="NightlySalesforceExtract" />
  <set-payload value="Batch submitted" />
</flow>
\`\`\`

\`\`\`bash
curl -X POST http://localhost:8081/trigger-extract
\`\`\`

### 6.3 Verify data loaded into Oracle

\`\`\`sql
-- Run after the batch completes
SELECT COUNT(*)          AS total_accounts,
       SUM(balance_due)  AS total_ar_balance,
       MAX(updated_at)   AS last_update
FROM   sf_account_dim;

SELECT batch_name, run_date, records_success, records_failed, status
FROM   mule_batch_log
ORDER  BY run_date DESC
FETCH FIRST 5 ROWS ONLY;
\`\`\`

### 6.4 Verify Salesforce connectivity

Add a test flow that runs a simple SOQL query and returns the count:

\`\`\`xml
<flow name="SalesforceConnectionTest">
  <http:listener config-ref="HTTP_Listener_Config"
                 path="/sf-test" />
  <salesforce:query config-ref="Salesforce_Config">
    <salesforce:salesforce-query>
      SELECT COUNT() FROM Account WHERE LastModifiedDate = TODAY
    </salesforce:salesforce-query>
  </salesforce:query>
  <set-payload value="#['Salesforce connected. Records today: ' ++ payload.totalSize as String]" />
</flow>
\`\`\`

\`\`\`bash
curl http://localhost:8081/sf-test
\`\`\`

---

## Phase 7: Deploy to CloudHub

### 7.1 Configure the CloudHub deployment descriptor

In \`pom.xml\`, add the CloudHub 1.0 deploy plugin:

\`\`\`xml
<plugin>
  <groupId>org.mule.tools.maven</groupId>
  <artifactId>mule-maven-plugin</artifactId>
  <version>3.8.5</version>
  <extensions>true</extensions>
  <configuration>
    <cloudhub10Deployment>
      <uri>https://anypoint.mulesoft.com</uri>
      <muleVersion>4.6.3</muleVersion>
      <username>\${anypoint.username}</username>
      <password>\${anypoint.password}</password>
      <applicationName>salesforce-oracle-pipeline</applicationName>
      <environment>Production</environment>
      <region>us-east-1</region>
      <workers>1</workers>
      <workerType>Micro</workerType>
      <objectStoreV2>true</objectStoreV2>
    </cloudhub10Deployment>
  </configuration>
</plugin>
\`\`\`

### 7.2 Set CloudHub application properties (Secure properties)

In Anypoint Runtime Manager → select the application → **Properties**:

| Property Key | Value |
|---|---|
| \`salesforce.consumer.key\` | Consumer Key from Connected App |
| \`salesforce.username\` | Integration user Salesforce username |
| \`salesforce.keystore.password\` | P12 keystore password |
| \`oracle.host\` | Oracle SCAN or hostname |
| \`oracle.port\` | 1521 |
| \`oracle.service\` | Oracle service name |
| \`oracle.username\` | mule_staging |
| \`oracle.password\` | mule_staging password |
| \`batch.modified.days\` | 1 |
| \`batch.scheduler.cron\` | 0 0 2 * * ? |
| \`batch.scheduler.timezone\` | America/New_York |

Mark \`salesforce.consumer.key\`, \`salesforce.keystore.password\`, \`oracle.password\` as **Secure** — CloudHub encrypts these at rest.

### 7.3 Upload the keystore as a secure property

The P12 keystore cannot be set as a string property. Instead, include it in the deployable JAR or upload it through the Anypoint Platform secrets manager. The simplest approach for initial deployment: bundle the P12 inside the JAR at \`src/main/resources/keystore/\` and reference it by classpath path.

### 7.4 Deploy via Maven

\`\`\`bash
mvn clean deploy -DmuleDeploy \
  -Danypoint.username=<your-anypoint-username> \
  -Danypoint.password=<your-anypoint-password>
\`\`\`

Or deploy manually through Runtime Manager:
1. Build the deployable: \`mvn clean package -DskipTests\`
2. In Runtime Manager → **Deploy Application** → upload the \`.jar\` from \`target/\`

---

## Phase 8: Monitoring and Alerting

### 8.1 Runtime Manager dashboard

After deployment, navigate to **Runtime Manager → Applications → salesforce-oracle-pipeline**:
- **Dashboard** tab: CPU, memory, message throughput, error count
- **Logs** tab: searchable log stream; filter by level to see \`ERROR\` entries only

### 8.2 Set up alerts in Runtime Manager

1. **Runtime Manager → Alerts → New Alert**
2. Configure:
   - **Name**: \`Pipeline Error Alert\`
   - **Severity**: Critical
   - **Source**: Application \`salesforce-oracle-pipeline\`
   - **Condition**: \`Number of errors\` is \`greater than\` 5 \`in the last\` 5 \`minutes\`
   - **Action**: Send email to on-call DBA address
3. Add a second alert for worker down:
   - **Condition**: \`Worker not responding\`
   - **Action**: Email + PagerDuty webhook

### 8.3 Verify batch results in Oracle each morning

\`\`\`sql
-- Run after the 02:00 batch window (e.g., at 06:00)
SELECT batch_name,
       TO_CHAR(run_date, 'YYYY-MM-DD HH24:MI:SS') AS run_time,
       records_success,
       records_failed,
       status,
       error_message
FROM   mule_batch_log
WHERE  run_date >= TRUNC(SYSDATE)
ORDER  BY run_date DESC;
\`\`\`

Expected: \`STATUS = SUCCESS\`, \`RECORDS_FAILED = 0\`. If \`RECORDS_FAILED > 0\`, check the CloudHub logs for the batch step that failed.

### 8.4 Monitor Oracle staging table freshness

\`\`\`sql
-- Check when accounts were last updated
SELECT TO_CHAR(MAX(updated_at), 'YYYY-MM-DD HH24:MI:SS') AS last_refresh,
       COUNT(*) AS account_count
FROM   sf_account_dim;
\`\`\`

If \`last_refresh\` is more than 26 hours ago, the nightly batch did not run or completed with failures. Check \`mule_batch_log\` and the CloudHub log.

---

## Phase 9: Cross-Reference Table Maintenance

The \`sf_oracle_customer_xref\` table links Salesforce Account IDs to Oracle Customer Numbers. It must be populated before the enrichment step can join correctly.

### 9.1 Initial population from Salesforce custom field

If the Salesforce Account has a custom field \`ExternalCustomerNumber__c\` that already holds the Oracle Customer Number:

\`\`\`sql
-- After running the first full extract, populate xref from sf_account_dim
-- (assumes ExternalCustomerNumber__c was loaded into a staging column)
INSERT INTO sf_oracle_customer_xref (sf_account_id, oracle_customer_number, matched_on)
SELECT d.sf_id,
       d.external_customer_number,
       'salesforce_custom_field'
FROM   sf_account_dim_staging d
WHERE  d.external_customer_number IS NOT NULL
AND    NOT EXISTS (
  SELECT 1 FROM sf_oracle_customer_xref x
  WHERE x.sf_account_id = d.sf_id
);
COMMIT;
\`\`\`

### 9.2 Match by account name where no external ID exists

\`\`\`sql
-- Fuzzy match by normalised account name — review before committing
SELECT s.sf_id,
       s.account_name     AS sf_name,
       c.account_number   AS oracle_cust_num,
       c.customer_name    AS oracle_name
FROM   sf_account_dim     s
JOIN   hz_cust_accounts   c
       ON UPPER(REGEXP_REPLACE(c.customer_name, '[^A-Z0-9]', ''))
        = UPPER(REGEXP_REPLACE(s.account_name,  '[^A-Z0-9]', ''))
WHERE  NOT EXISTS (
  SELECT 1 FROM sf_oracle_customer_xref x WHERE x.sf_account_id = s.sf_id
)
ORDER  BY s.account_name;
\`\`\`

Review this output before inserting — name-based matching can produce false positives. Insert only confirmed matches.

---

## Phase 10: Troubleshooting

### Salesforce OAuth JWT failure — INVALID_CLIENT or INVALID_JWT

\`\`\`
SALESFORCE:INVALID_CREDENTIALS: Failed to obtain token
\`\`\`

**Checklist:**
1. Confirm the Connected App has **Use digital signatures** enabled and the uploaded certificate matches the P12 keystore in use
2. Confirm the integration user's profile is added to the Connected App's pre-authorized profiles
3. Confirm the Consumer Key in the MuleSoft configuration matches the Connected App's Consumer Key exactly
4. Confirm the Salesforce token endpoint URL — use \`https://test.salesforce.com/services/oauth2/token\` for sandbox

### Oracle JDBC connection refused

\`\`\`
DB:CONNECTIVITY: Could not obtain connection from pool
\`\`\`

**Checklist:**
1. Test connectivity from the CloudHub region (CloudHub runs in AWS us-east-1 or eu-west-1): confirm the Oracle listener accepts inbound connections from the relevant AWS IP ranges
2. Verify the service name — connect with \`sqlplus\` from the Mule runtime host using the same JDBC URL
3. For RAC: use the SCAN hostname, not an individual VIP — the SCAN is load-balanced and highly available
4. If using Oracle Autonomous Database: confirm the wallet is bundled and \`TNS_ADMIN\` points to it correctly

### Batch records failing — Oracle MERGE constraint violations

\`\`\`
DB:EXECUTE_QUERY: ORA-00001: unique constraint violated
\`\`\`

This should not occur with the MERGE pattern, but can happen if the same \`sf_id\` appears in multiple batch records (duplicate source data). Check:

\`\`\`sql
SELECT sf_id, COUNT(*) FROM sf_account_dim GROUP BY sf_id HAVING COUNT(*) > 1;
\`\`\`

If duplicates exist, the batch input query returned duplicates from Salesforce. Add \`GROUP BY Id\` or \`DISTINCT\` to the SOQL query.

### Salesforce Bulk API query returning zero records

If \`query-all\` returns no records but records clearly changed:
1. Confirm the SOQL \`WHERE LastModifiedDate = LAST_N_DAYS:1\` filter matches the scheduler's timezone — LAST_N_DAYS uses UTC in Salesforce
2. Increase the window temporarily: change \`LAST_N_DAYS:1\` to \`LAST_N_DAYS:3\` to catch any time zone offset issue
3. Confirm the integration user has read access to the Account object and all selected fields

### CloudHub worker out of memory

If the batch job processes millions of records, the default CloudHub worker may exhaust heap:
1. Increase worker size from Micro (0.1 vCore, 500 MB) to Small (0.1 vCore, 1 GB) or Medium
2. Reduce batch job commit interval — smaller chunks per database transaction
3. Add \`maxFailedRecords="-1"\` to allow the batch to continue past failures rather than accumulating failed records in memory

---

## Quick Reference

| Task | Command / Location |
|---|---|
| Deploy via Maven | \`mvn clean deploy -DmuleDeploy\` |
| Trigger extract manually | \`POST http://localhost:8081/trigger-extract\` |
| Check batch log | \`SELECT * FROM mule_batch_log ORDER BY run_date DESC\` |
| Check staging freshness | \`SELECT MAX(updated_at) FROM sf_account_dim\` |
| Check Salesforce connectivity | \`GET http://localhost:8081/sf-test\` |
| View CloudHub logs | Runtime Manager → App → Logs |
| Rotate Oracle password | Update secure property in Runtime Manager; restart app |
| Rotate Salesforce keystore | Replace P12 in secrets; redeploy; update Connected App cert |
| Scale workers | Runtime Manager → App → Settings → Workers |
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'MuleSoft Salesforce to Oracle Data Mining Integration — Runbook',
    slug,
    excerpt: 'Step-by-step runbook for building and operating a MuleSoft Anypoint Platform integration that extracts Salesforce account and opportunity data into Oracle Database staging tables for cross-system data mining. Covers Salesforce Connected App and JWT Bearer OAuth setup, Oracle staging schema creation, Anypoint Studio project structure with Salesforce Connector and Oracle Database Connector, batch job XML for nightly extract with AR enrichment and MERGE upsert, CloudHub deployment with secure properties, monitoring and alerting, cross-reference table maintenance, and troubleshooting for OAuth, JDBC, and batch failure scenarios.',
    content,
    category: 'mulesoft',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
