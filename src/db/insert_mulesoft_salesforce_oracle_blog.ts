import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'mulesoft-salesforce-oracle-database-integration-data-mining';

const content = `
Salesforce holds the authoritative record of customer interactions, pipeline activity, opportunity history, and support cases. Oracle Database holds the authoritative record of financial transactions, inventory positions, ERP journal entries, and operational data. Neither system was designed to answer questions that require both sources simultaneously — and yet those are exactly the questions that drive revenue and operational decisions: which customers have open opportunities and overdue invoices, which accounts show pipeline growth but declining order volume, which support case patterns correlate with churn.

MuleSoft Anypoint Platform provides the integration layer that connects Salesforce to Oracle without embedding point-to-point logic in either system. This post covers the Anypoint Platform architecture, the API-led connectivity model, the Salesforce and Oracle Database connector configuration, DataWeave transformation for cross-system data shaping, batch processing for large data extracts, and the patterns for building data mining pipelines that aggregate Salesforce activity data with Oracle transactional records for analysis.

---

## Anypoint Platform Architecture

MuleSoft Anypoint Platform consists of three runtime environments and a design toolchain:

**Anypoint Studio**: the Eclipse-based desktop IDE for building Mule applications. Flows are assembled visually using drag-and-drop connectors and configured with XML or the visual editor. DataWeave transformations are written directly in the studio editor with live preview.

**CloudHub** (Anypoint Runtime): MuleSoft's managed iPaaS runtime on AWS. Mule applications are deployed as worker instances (vCores) and scale independently. CloudHub handles SSL termination, monitoring, alerts, and log aggregation. The alternative deployment targets are hybrid (on-premise Mule runtime servers) and Runtime Fabric (containerized, on Kubernetes).

**Anypoint Exchange**: the catalog of connectors, templates, APIs, and reusable integration assets. The Salesforce Connector and Database Connector (for Oracle) are published here and pulled into Studio projects as Maven dependencies.

**API Manager**: manages API policies (rate limiting, OAuth, IP allowlisting), client credentials, and SLA tiers for APIs published on the Anypoint Platform. Relevant when the integration exposes REST endpoints that Salesforce flows or Oracle ETL jobs call.

---

## API-Led Connectivity for Salesforce–Oracle Pipelines

API-led connectivity organises integration logic into three layers that each serve a distinct purpose. This structure prevents the point-to-point sprawl that makes integrations brittle and expensive to change.

### System APIs

System APIs wrap a single backend system and expose its data through a stable, versioned REST interface. The Salesforce System API translates REST calls into Salesforce SOQL queries or DML operations. The Oracle System API translates REST calls into SQL queries against the Oracle schema.

Each System API:
- Handles authentication to its own system (OAuth 2.0 for Salesforce, JDBC credentials for Oracle)
- Returns data in a canonical JSON schema that hides backend-specific field names
- Absorbs breaking changes in the backend without affecting upstream consumers

### Process APIs

Process APIs implement business logic that spans multiple systems. A customer 360 Process API calls the Salesforce System API for opportunity and case data, calls the Oracle System API for AR balance and order history, and merges the results into a unified customer record. The Process API does not know or care how the System APIs retrieve their data.

### Experience APIs

Experience APIs shape the merged data for a specific consumer: a Salesforce Lightning component, an Oracle APEX dashboard, a Python analytics notebook, or a Tableau data source. They handle pagination, projection (returning only the fields the consumer needs), and consumer-specific authentication.

---

## Salesforce Connector Configuration

The MuleSoft Salesforce Connector uses the Salesforce REST API or Bulk API, depending on the operation volume.

### Connection configuration in Anypoint Studio

In the Global Elements panel, create a new Salesforce configuration:

\`\`\`xml
<salesforce:config name="Salesforce_Config" doc:name="Salesforce Config">
  <salesforce:basic-connection
    username="\${salesforce.username}"
    password="\${salesforce.password}"
    securityToken="\${salesforce.security.token}"
    url="https://login.salesforce.com/services/Soap/u/58.0" />
</salesforce:config>
\`\`\`

For OAuth 2.0 with a Connected App (preferred for production):

\`\`\`xml
<salesforce:config name="Salesforce_OAuth_Config" doc:name="Salesforce OAuth Config">
  <salesforce:oauth-jwt-bearer-connection
    consumerKey="\${salesforce.consumer.key}"
    keyStorePath="\${salesforce.keystore.path}"
    keyStorePassword="\${salesforce.keystore.password}"
    principal="\${salesforce.username}"
    tokenEndpoint="https://login.salesforce.com/services/oauth2/token" />
</salesforce:config>
\`\`\`

Store credentials in \`src/main/resources/config.yaml\` and reference them with \`\${property}\` substitution. Never hardcode credentials in flow XML.

### Querying Salesforce with SOQL

The \`query\` operation executes a SOQL statement and returns a list of SObject records:

\`\`\`xml
<salesforce:query config-ref="Salesforce_OAuth_Config"
                  doc:name="Query Opportunities">
  <salesforce:salesforce-query>
    SELECT Id, Name, AccountId, Amount, StageName, CloseDate,
           Account.Name, OwnerId
    FROM   Opportunity
    WHERE  StageName NOT IN ('Closed Won','Closed Lost')
    AND    CloseDate >= :startDate
    ORDER BY CloseDate ASC
  </salesforce:salesforce-query>
  <salesforce:parameters>
    #[{ startDate: vars.queryStartDate }]
  </salesforce:parameters>
</salesforce:query>
\`\`\`

The result is a MuleMessage payload containing a List of Maps, where each Map corresponds to one SObject record with field names as keys.

### Bulk API for large data extracts

For extracting more than 2,000 records — which is the default SOQL query limit before pagination is required — use the Bulk API operation:

\`\`\`xml
<salesforce:query-all config-ref="Salesforce_OAuth_Config"
                      doc:name="Bulk Query All Accounts">
  <salesforce:salesforce-query>
    SELECT Id, Name, Industry, AnnualRevenue, BillingCountry,
           NumberOfEmployees, CreatedDate, LastModifiedDate
    FROM   Account
    WHERE  LastModifiedDate >= LAST_N_DAYS:90
  </salesforce:salesforce-query>
</salesforce:query-all>
\`\`\`

\`query-all\` uses the Salesforce Bulk API 2.0, which handles pagination automatically and streams results back as a single iterable collection. Use this for any extract that will feed an Oracle bulk insert.

---

## Oracle Database Connector Configuration

The MuleSoft Database Connector uses JDBC to connect to Oracle. The Oracle JDBC driver (\`ojdbc11.jar\`) must be added to the project as a Maven dependency or dropped into the project's \`lib\` folder.

### Maven dependency for Oracle JDBC

\`\`\`xml
<!-- pom.xml -->
<dependency>
  <groupId>com.oracle.database.jdbc</groupId>
  <artifactId>ojdbc11</artifactId>
  <version>23.4.0.24.05</version>
</dependency>
\`\`\`

### Database global configuration

\`\`\`xml
<db:config name="Oracle_Config" doc:name="Oracle DB Config">
  <db:generic-connection
    url="jdbc:oracle:thin:@//\${oracle.host}:\${oracle.port}/\${oracle.service}"
    driverClassName="oracle.jdbc.OracleDriver"
    user="\${oracle.username}"
    password="\${oracle.password}" />
</db:config>
\`\`\`

For RAC environments, use the SCAN address and service name:

\`\`\`xml
url="jdbc:oracle:thin:@//scan.example.com:1521/PRODDB"
\`\`\`

For wallets with TLS (Oracle Autonomous Database or on-premise with wallet authentication):

\`\`\`xml
url="jdbc:oracle:thin:@\${oracle.tns.alias}?TNS_ADMIN=\${oracle.wallet.path}"
\`\`\`

### Querying Oracle

\`\`\`xml
<db:select config-ref="Oracle_Config" doc:name="Get AR Balances">
  <db:sql>
    SELECT c.customer_number,
           c.customer_name,
           SUM(ps.amount_due_remaining) AS balance_due,
           MAX(ps.due_date)             AS oldest_due_date
    FROM   hz_cust_accounts   c
    JOIN   ar_payment_schedules_all ps
           ON  ps.customer_id = c.cust_account_id
           AND ps.status      = 'OP'
    WHERE  c.customer_number IN (:customerNumbers)
    GROUP  BY c.customer_number, c.customer_name
  </db:sql>
  <db:input-parameters>
    #[{ customerNumbers: vars.customerNumbers }]
  </db:input-parameters>
</db:select>
\`\`\`

The result is a List of Maps, one per row, with column names as keys. Column names are returned in uppercase by Oracle JDBC by default.

### Bulk insert into Oracle

\`\`\`xml
<db:bulk-insert config-ref="Oracle_Config" doc:name="Load Salesforce Data to Staging">
  <db:sql>
    INSERT INTO sf_opportunity_staging
      (sf_id, account_id, opportunity_name, amount, stage, close_date, loaded_at)
    VALUES
      (:sfId, :accountId, :opportunityName, :amount, :stage, :closeDate, SYSDATE)
  </db:sql>
  <db:bulk-input-parameters>
    #[payload]
  </db:bulk-input-parameters>
</db:bulk-insert>
\`\`\`

\`db:bulk-insert\` sends the entire payload (a List of Maps) as a JDBC batch, which is significantly faster than looping with individual inserts. Each Map in the list must contain keys matching the named parameters.

---

## DataWeave Transformation

DataWeave is MuleSoft's functional transformation language. It runs inside Mule flows and converts payloads between formats and schemas without requiring Java code.

### Transforming Salesforce query results for Oracle insert

A Salesforce \`query\` operation returns records with camelCase field names and Salesforce ID formats. The Oracle staging table uses snake_case column names and requires date format normalisation.

\`\`\`dataweave
%dw 2.0
output application/java

---
payload map (opp) -> {
  sfId:            opp.Id,
  accountId:       opp.AccountId,
  accountName:     opp.Account.Name default "",
  opportunityName: opp.Name,
  amount:          opp.Amount default 0,
  stage:           opp.StageName,
  closeDate:       opp.CloseDate as Date {format: "yyyy-MM-dd"},
  ownerId:         opp.OwnerId
}
\`\`\`

### Merging Salesforce and Oracle records

After calling both System APIs, a Process API merges the two result sets on a shared key — in this case \`customer_number\` from Oracle and the Salesforce Account's external ID field:

\`\`\`dataweave
%dw 2.0
output application/json

var sfAccounts  = vars.salesforceAccounts groupBy $.ExternalCustomerNumber__c
var orAccounts  = vars.oracleCustomers    groupBy $.CUSTOMER_NUMBER

---
(orAccounts pluck (rows, custNum) -> do {
  var sfMatch = sfAccounts[custNum][0] default {}
  ---
  {
    customerNumber: custNum,
    customerName:   rows[0].CUSTOMER_NAME,
    balanceDue:     rows[0].BALANCE_DUE,
    oldestDueDate:  rows[0].OLDEST_DUE_DATE,
    sfAccountId:    sfMatch.Id default null,
    sfOpportunities: sfMatch.OpenOpportunityCount default 0,
    sfLastActivity:  sfMatch.LastActivityDate default null,
    riskFlag: (rows[0].BALANCE_DUE > 10000 and sfMatch.OpenOpportunityCount > 0)
  }
})
\`\`\`

The \`groupBy\` operator indexes each list by a key field, allowing O(1) lookup when joining on the shared customer identifier rather than a nested loop.

---

## Batch Processing for Large Data Mining Pipelines

For extracting large Salesforce data sets into Oracle for analysis — account history, case trends, opportunity pipeline snapshots — the MuleSoft Batch module provides parallel processing with error isolation.

### Batch job structure

A batch job has three phases:

1. **On Input**: the trigger that starts the job (a scheduler, an HTTP request, or an inbound message). The payload at the end of On Input becomes the batch input.
2. **Batch Steps**: the processing logic applied to each record. Multiple steps can run sequentially; each step processes records in parallel.
3. **On Complete**: runs once after all records have been processed or failed. Reports results, sends notifications, or triggers downstream processes.

### Salesforce-to-Oracle nightly extract

\`\`\`xml
<batch:job name="NightlySalesforceExtract" doc:name="Nightly Salesforce Extract">

  <!-- Phase 1: Load all modified accounts from Salesforce -->
  <batch:input>
    <salesforce:query-all config-ref="Salesforce_OAuth_Config">
      <salesforce:salesforce-query>
        SELECT Id, Name, Industry, AnnualRevenue, NumberOfEmployees,
               BillingCountry, LastModifiedDate,
               (SELECT Id, StageName, Amount, CloseDate
                FROM   Opportunities
                WHERE  IsClosed = false)
        FROM   Account
        WHERE  LastModifiedDate = LAST_N_DAYS:1
      </salesforce:salesforce-query>
    </salesforce:query-all>
  </batch:input>

  <!-- Phase 2: Enrich each account with Oracle AR data -->
  <batch:step name="EnrichWithARData">
    <db:select config-ref="Oracle_Config">
      <db:sql>
        SELECT SUM(amount_due_remaining) AS balance_due
        FROM   ar_payment_schedules_all ps
        JOIN   hz_cust_accounts c ON c.cust_account_id = ps.customer_id
        WHERE  c.account_number = :sfAccountId
        AND    ps.status = 'OP'
      </db:sql>
      <db:input-parameters>
        #[{ sfAccountId: payload.Id }]
      </db:input-parameters>
    </db:select>
    <ee:transform doc:name="Merge AR data into record">
      <ee:message>
        <ee:set-payload>
          <![CDATA[
            %dw 2.0
            output application/java
            ---
            vars.originalRecord ++ {
              balanceDue: payload[0].BALANCE_DUE default 0
            }
          ]]>
        </ee:set-payload>
      </ee:message>
    </ee:transform>
  </batch:step>

  <!-- Phase 3: Upsert into Oracle analytics staging table -->
  <batch:step name="UpsertToOracle">
    <db:insert config-ref="Oracle_Config">
      <db:sql>
        MERGE INTO sf_account_dim tgt
        USING (SELECT :sfId AS sf_id FROM dual) src
        ON (tgt.sf_id = src.sf_id)
        WHEN MATCHED THEN UPDATE SET
          tgt.account_name      = :accountName,
          tgt.industry          = :industry,
          tgt.annual_revenue    = :annualRevenue,
          tgt.balance_due       = :balanceDue,
          tgt.last_modified_dt  = :lastModifiedDate,
          tgt.updated_at        = SYSDATE
        WHEN NOT MATCHED THEN INSERT
          (sf_id, account_name, industry, annual_revenue,
           balance_due, last_modified_dt, created_at, updated_at)
        VALUES
          (:sfId, :accountName, :industry, :annualRevenue,
           :balanceDue, :lastModifiedDate, SYSDATE, SYSDATE)
      </db:sql>
      <db:input-parameters>
        #[{
          sfId:             payload.Id,
          accountName:      payload.Name,
          industry:         payload.Industry,
          annualRevenue:    payload.AnnualRevenue,
          balanceDue:       payload.balanceDue,
          lastModifiedDate: payload.LastModifiedDate as DateTime
        }]
      </db:input-parameters>
    </db:insert>
  </batch:step>

  <!-- On Complete: log results -->
  <batch:on-complete>
    <logger level="INFO"
            message="#['Batch complete. Processed: ' ++ vars.batchJobInstanceId
                       ++ ' | Success: ' ++ payload.successfulRecords as String
                       ++ ' | Failed: ' ++ payload.failedRecords as String]" />
  </batch:on-complete>

</batch:job>
\`\`\`

The Batch module processes records in parallel (default 4 threads, configurable) and tracks failures per record without aborting the entire job. Records that fail the Oracle MERGE are logged individually and do not block processing of subsequent records.

---

## Scheduler Configuration

Batch jobs are typically triggered on a schedule:

\`\`\`xml
<flow name="NightlyExtractTrigger">
  <scheduler doc:name="Nightly at 02:00">
    <scheduling-strategy>
      <cron expression="0 0 2 * * ?" timeZone="America/New_York" />
    </scheduling-strategy>
  </scheduler>

  <set-variable variableName="extractDate"
                value="#[now() |> \$$ as Date]"
                doc:name="Set extract date" />

  <batch:execute name="NightlySalesforceExtract"
                 doc:name="Trigger nightly extract" />
</flow>
\`\`\`

The \`cron\` expression \`0 0 2 * * ?\` fires at 02:00 every day. Adjust the timezone to match your Oracle database server timezone so that SYSDATE comparisons in the Oracle queries align correctly.

---

## Error Handling and Retry

### Global error handler

\`\`\`xml
<error-handler name="GlobalErrorHandler">
  <on-error-continue type="DB:CONNECTIVITY" enableNotifications="true"
                     logException="true">
    <logger level="ERROR"
            message="#['Oracle connectivity error: ' ++ error.description]" />
  </on-error-continue>

  <on-error-continue type="SALESFORCE:CONNECTIVITY" enableNotifications="true"
                     logException="true">
    <logger level="ERROR"
            message="#['Salesforce connectivity error: ' ++ error.description]" />
  </on-error-continue>

  <on-error-propagate type="ANY">
    <logger level="ERROR"
            message="#['Unhandled error: ' ++ error.description]" />
  </on-error-propagate>
</error-handler>
\`\`\`

### Reconnection strategy on Database Connector

\`\`\`xml
<db:config name="Oracle_Config">
  <db:generic-connection url="\${oracle.jdbc.url}"
                         user="\${oracle.username}"
                         password="\${oracle.password}">
    <reconnection failsDeployment="false">
      <reconnect frequency="30000" count="5" />
    </reconnection>
  </db:generic-connection>
</db:config>
\`\`\`

This retries the Oracle connection 5 times at 30-second intervals before propagating the error. On CloudHub, the worker process will restart automatically after a fatal connectivity failure if configured in the CloudHub deployment settings.

---

## Oracle Staging Schema for Salesforce Data

Design a dedicated schema (or set of tables in an existing schema) to hold Salesforce data extracted for analysis. Keep it separate from the transactional ERP schema to avoid contention and to allow independent refresh cycles.

\`\`\`sql
-- Staging table for Salesforce Account dimension
CREATE TABLE sf_account_dim (
  sf_id             VARCHAR2(18)      NOT NULL,
  account_name      VARCHAR2(255),
  industry          VARCHAR2(100),
  annual_revenue    NUMBER(15,2),
  balance_due       NUMBER(15,2)      DEFAULT 0,
  open_opp_count    NUMBER(5)         DEFAULT 0,
  last_modified_dt  TIMESTAMP,
  created_at        TIMESTAMP         DEFAULT SYSTIMESTAMP,
  updated_at        TIMESTAMP         DEFAULT SYSTIMESTAMP,
  CONSTRAINT sf_account_dim_pk PRIMARY KEY (sf_id)
);

-- Staging table for Salesforce Opportunity fact
CREATE TABLE sf_opportunity_staging (
  sf_id             VARCHAR2(18)      NOT NULL,
  account_sf_id     VARCHAR2(18),
  opportunity_name  VARCHAR2(255),
  amount            NUMBER(15,2),
  stage             VARCHAR2(100),
  close_date        DATE,
  owner_id          VARCHAR2(18),
  loaded_at         TIMESTAMP         DEFAULT SYSTIMESTAMP,
  CONSTRAINT sf_opp_staging_pk PRIMARY KEY (sf_id)
);

-- Cross-reference: Salesforce Account ID to Oracle Customer Number
CREATE TABLE sf_oracle_customer_xref (
  sf_account_id     VARCHAR2(18)      NOT NULL,
  oracle_customer_number VARCHAR2(30) NOT NULL,
  matched_on        VARCHAR2(50)      DEFAULT 'external_id',
  created_at        TIMESTAMP         DEFAULT SYSTIMESTAMP,
  CONSTRAINT sf_oracle_xref_pk PRIMARY KEY (sf_account_id)
);

CREATE INDEX sf_opp_stage_idx ON sf_opportunity_staging (stage, close_date);
CREATE INDEX sf_opp_acct_idx  ON sf_opportunity_staging (account_sf_id);
\`\`\`

The cross-reference table is the critical piece for joining Salesforce records to Oracle ERP records. Salesforce Accounts are linked to Oracle Customer accounts through a shared identifier — typically an account number or ERP customer ID stored as a custom field in Salesforce (\`ExternalCustomerNumber__c\`) and in a reference column in Oracle.

---

## Monitoring on Anypoint Platform

### Runtime Manager — application monitoring

In the Anypoint Runtime Manager (CloudHub or hybrid), each deployed application shows:
- CPU and memory utilisation per worker
- Message throughput (messages per second)
- Error count over time
- Log stream with searchable history

### Custom metrics

Publish custom metrics from within flows using the Anypoint Monitoring Custom Metrics connector:

\`\`\`xml
<custom-metrics:emit-metric
  applicationName="salesforce-oracle-pipeline"
  metricName="records_loaded"
  value="#[vars.recordCount]"
  namespace="data-mining" />
\`\`\`

Custom metrics appear on Anypoint Monitoring dashboards and can trigger alerts when thresholds are crossed — for example, alerting when the nightly batch loads fewer than 100 records, which may indicate a Salesforce API failure or an empty extract window.

---

## Summary

MuleSoft Anypoint Platform connects Salesforce and Oracle through the API-led connectivity model, where System APIs encapsulate each backend, Process APIs implement cross-system business logic, and Experience APIs serve consumer-specific views of the merged data.

The Salesforce Connector handles SOQL queries and Bulk API operations for large data extracts. The Oracle Database Connector provides JDBC-based SQL access for both reads and bulk inserts. DataWeave transforms data between the two systems' schemas without Java code, handling type coercion, field renaming, and record merging in functional transformation scripts.

For nightly data mining pipelines — extracting Salesforce activity data and merging it with Oracle ERP transactional records — the Batch module provides parallel processing, per-record error isolation, and completion hooks. A dedicated Oracle staging schema with a cross-reference table linking Salesforce Account IDs to Oracle Customer numbers is the foundation for all downstream analysis, whether in Oracle APEX, OBIEE, Tableau, or Python analytics notebooks.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'MuleSoft Anypoint Platform: Salesforce to Oracle Database Integration for Data Mining',
    slug,
    excerpt: 'MuleSoft Anypoint Platform connects Salesforce and Oracle Database through API-led connectivity — System APIs that encapsulate each backend, Process APIs that implement cross-system business logic, and DataWeave transformations that merge Salesforce opportunity and account records with Oracle AR balances and order history. This post covers Salesforce Connector SOQL and Bulk API configuration, Oracle Database Connector JDBC setup for RAC and Autonomous Database, DataWeave join patterns, the Batch module for nightly extract pipelines, Oracle staging schema design, and Anypoint monitoring for production pipelines.',
    content,
    category: 'mulesoft',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
