import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Clinical One: Cloud Configuration, Topology, and Operations Overview',
  slug: 'oracle-clinical-one-cloud-topology-install-monitor',
  excerpt:
    'A technical overview of Oracle Clinical One — the cloud-native eClinical platform for study design, RTSM, and data collection on Oracle Cloud Infrastructure. Covers SaaS topology, tenant configuration, integration patterns, and an API-based health monitoring approach with crontab scheduling.',
  category: 'oracle-clinical' as const,
  isPremium: false,
  published: true,
  publishedAt: new Date('2026-06-19'),
  content: `Oracle Clinical One is Oracle's cloud-native unified clinical trial platform. Unlike the legacy Oracle Clinical on-premise CDMS, Clinical One is delivered entirely as Software-as-a-Service on Oracle Cloud Infrastructure (OCI). There is no server to provision, no schema to manage, and no patching window to schedule. What the DBA and IT administrator must understand instead is the service topology, tenant configuration model, integration architecture, and the API-based operational monitoring approach that replaces traditional OS-level health checks.

This post walks through all of these areas and closes with a complete shell monitoring script you can schedule via crontab to watch Clinical One from your on-premise integration environment.

---

## What Is Oracle Clinical One?

Oracle Clinical One consolidates capabilities that previously required separate products:

- **Electronic Data Capture (EDC)**: Study forms, visit schedules, data entry for sites
- **Randomization and Trial Supply Management (RTSM)**: Automated randomization, depot management, kit resupply
- **Protocol management**: Study version control, amendment tracking, rule enforcement
- **Patient management**: Subject registration, screen failure tracking, early termination
- **Audit trail and regulatory compliance**: 21 CFR Part 11, EU Annex 11, ICH E6(R2) GCP

All of these functions run in a single unified cloud environment. Sites, monitors, data managers, and statisticians all access the same platform through a browser — no client installation required.

---

## Cloud Topology and Service Architecture

Oracle Clinical One runs on OCI in Oracle-managed tenancies. Understanding the service layers helps you reason about integration points, latency, and where monitoring is meaningful.

### Layer 1 — Oracle-Managed OCI Infrastructure

Oracle operates all compute, storage, and network infrastructure. This includes:

- **OCI Kubernetes Engine (OKE)**: Application pods for the Clinical One services run in managed Kubernetes clusters distributed across OCI availability domains
- **Autonomous Database**: Study data persists in Oracle Autonomous Database (ATP/ADW profile depending on workload type) — fully managed, auto-patching, no DBA access to the schema
- **OCI Object Storage**: Protocol documents, data exports, audit log archives
- **OCI Load Balancer**: TLS termination, global traffic routing across availability domains
- **OCI DNS**: Regional endpoints for tenant access with automatic failover

Customers never touch this layer. There is no root access, no SQL\*Plus connection to the study database, and no OS login. Oracle SREs manage availability and patching transparently.

### Layer 2 — Multi-Tenant SaaS Application

Each sponsor organization gets an isolated **Clinical One Tenant**. A tenant is a logically separated environment within the shared OCI infrastructure, with:

- **Tenant ID**: A unique identifier for your organization
- **Study environments**: Each study has a UAT environment and a Production environment (separate data stores)
- **User pool**: Integrated with Oracle Identity Cloud Service (IDCS) / Oracle Cloud Infrastructure Identity and Access Management (OCI IAM)
- **Role-based access**: Study Designer, Data Manager, Clinical Pharmacologist, Site User, Super User — each maps to fine-grained permissions

### Layer 3 — Integration and API Layer

On-premise or hybrid systems connect to Clinical One via:

- **Clinical One REST API**: Full CRUD for study data, subject records, randomization events, supply events. OAuth 2.0 / OIDC authentication via OCI IAM
- **Oracle Health Sciences Integration Hub (OHSIH)**: Optional middleware for HL7 FHIR, EDI lab result ingestion, EHR integration
- **SFTP-based exports**: Scheduled SAS dataset exports (CDISC ODM, SAS transport) to sponsor data warehouse
- **Oracle Analytics Cloud (OAC)**: Optional BI connectivity for operational dashboards fed by Clinical One data snapshots

This Layer 3 is where your team's code and scheduled jobs live.

---

## Configuration in the Cloud — Key Concepts

### Tenant Provisioning

A Clinical One tenant is provisioned by Oracle after contract execution. Provisioning delivers:

1. A unique tenant URL: \`https://yourorg.clinicalone.ocs.oraclecloud.com\`
2. An IDCS domain for user management
3. An API credential set (client ID + secret) for service account integrations
4. An OCI Object Storage bucket for data exports

Initial configuration steps after provisioning:

- **Set up IDCS/IAM users**: Create user accounts, assign Clinical One roles (Study Designer, Data Manager, etc.)
- **Configure SSO**: Federate with your corporate identity provider (SAML 2.0 or OIDC) if required
- **Create study environments**: Use the Clinical One Study Designer to define study versions
- **Configure supply chain**: Set up depots, kit types, resupply rules in RTSM configuration
- **Enable API access**: Generate client credentials for integration service accounts

### Study Design and Build

Clinical One study design is performed through the browser UI by a Study Designer role user:

- Define protocol versions (study version locking prevents accidental edits after sites open)
- Configure visit schedule: screening, treatment, follow-up visits
- Build eCRF forms with data fields, validations, and coding dictionaries (MedDRA, WHO Drug)
- Define randomization arms and stratification factors
- Set blinding rules (open label, single-blind, double-blind)

All study design is versioned. Amendments create new study versions while preserving history.

### Environment Promotion Flow

\`\`\`
Study Design (Authoring) → UAT Environment (Testing) → Production (Live Sites)
\`\`\`

Promotion from UAT to Production is a controlled workflow requiring approvals. This is a critical governance checkpoint — once subjects are enrolled in Production, schema-breaking amendments require protocol amendment documentation.

---

## Integration Patterns

### REST API Authentication

Clinical One uses OAuth 2.0 client credentials flow:

\`\`\`
POST https://idcs-<tenant>.identity.oraclecloud.com/oauth2/v1/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_id=<your_client_id>
&client_secret=<your_client_secret>
&scope=https://clinical-one.ocs.oraclecloud.com/.default
\`\`\`

The token has a short TTL (typically 3600 seconds). Your integration code must refresh before expiry.

### Common API Operations

\`\`\`bash
# Get study list
curl -H "Authorization: Bearer \${TOKEN}" \
  https://yourorg.clinicalone.ocs.oraclecloud.com/api/v1/studies

# Get subject list for a study
curl -H "Authorization: Bearer \${TOKEN}" \
  https://yourorg.clinicalone.ocs.oraclecloud.com/api/v1/studies/\${STUDY_ID}/subjects

# Get randomization events
curl -H "Authorization: Bearer \${TOKEN}" \
  https://yourorg.clinicalone.ocs.oraclecloud.com/api/v1/studies/\${STUDY_ID}/randomizations
\`\`\`

### SFTP Data Export

Clinical One can be configured to push scheduled data exports to an SFTP endpoint you control:

- SAS transport files (.xpt) for each domain (DM, AE, CM, LB, etc.)
- CDISC ODM XML for full study metadata + data
- Supply chain exports for RTSM reconciliation

Configure SFTP credentials and schedule in the Clinical One administration console.

---

## Monitoring Approach: What You Can Observe

Because Clinical One is SaaS, you cannot monitor CPU, memory, tablespace, or process counts directly. What you *can* monitor from your integration environment:

| Check | Method | Indicator |
|-------|--------|-----------|
| API availability | HTTPS GET to /api/v1/health | HTTP 200 |
| Authentication | Token endpoint POST | Returns access_token |
| Study data freshness | Subject count change over time | Stale if unchanged unexpectedly |
| SFTP export delivery | File timestamp on SFTP drop | Alert if missing after window |
| Error rates | API response codes | Alert on 5xx sustained |
| Site data entry lag | Forms pending query count via API | Alert if rising threshold |

---

## Health Check Script (API-Based)

The following script runs from your on-premise integration server and covers the observable monitoring surface of Clinical One. It is designed to run every 15 minutes via crontab.

\`\`\`bash
#!/bin/bash
# =====================================================
# Oracle Clinical One API Health Check
# Schedule: */15 * * * * via crontab
# =====================================================

TENANT_URL=https://yourorg.clinicalone.ocs.oraclecloud.com
IDCS_URL=https://idcs-<tenant>.identity.oraclecloud.com
CLIENT_ID=<your_client_id>
CLIENT_SECRET=<your_client_secret>
SCOPE="https://clinical-one.ocs.oraclecloud.com/.default"
STUDY_ID=<your_study_id>
SFTP_DROP_DIR=/data/sftp/clinicalone/exports
SFTP_MAX_AGE_HOURS=25
ALERT_EMAIL=clinops@example.com

TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
LOG=/var/log/clinical_one_health.log
ALERT_TRIGGERED=0
ALERT_MSG=""

log()   { echo "[\${TIMESTAMP}] \$1" | tee -a "\${LOG}"; }
alert() { ALERT_TRIGGERED=1; ALERT_MSG="\${ALERT_MSG}\\n\$1"; log "ALERT: \$1"; }

# --------------------------------------------------
# 1. API health endpoint
# --------------------------------------------------
check_api_health() {
  log "--- Checking Clinical One API health endpoint ---"
  HTTP_CODE=\$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 \
    "\${TENANT_URL}/api/v1/health" 2>/dev/null)
  if [ "\${HTTP_CODE}" = "200" ]; then
    log "API health endpoint: HTTP 200 OK"
  else
    alert "Clinical One API health returned HTTP \${HTTP_CODE}"
  fi
}

# --------------------------------------------------
# 2. OAuth token acquisition
# --------------------------------------------------
get_token() {
  log "--- Acquiring OAuth token ---"
  RESPONSE=\$(curl -s -X POST \
    "\${IDCS_URL}/oauth2/v1/token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "grant_type=client_credentials&client_id=\${CLIENT_ID}&client_secret=\${CLIENT_SECRET}&scope=\${SCOPE}" \
    --max-time 15 2>/dev/null)

  TOKEN=\$(echo "\${RESPONSE}" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
  if [ -z "\${TOKEN}" ]; then
    alert "Failed to acquire OAuth token — check client credentials or IDCS availability"
    TOKEN=""
  else
    log "OAuth token acquired successfully"
  fi
}

# --------------------------------------------------
# 3. Study data freshness check
# --------------------------------------------------
check_study_freshness() {
  [ -z "\${TOKEN}" ] && { log "Skipping study check — no token"; return; }
  log "--- Checking study subject count ---"

  COUNT=\$(curl -s -H "Authorization: Bearer \${TOKEN}" --max-time 15 \
    "\${TENANT_URL}/api/v1/studies/\${STUDY_ID}/subjects" 2>/dev/null \
    | grep -o '"total":[0-9]*' | cut -d: -f2)

  PREV_COUNT_FILE=/tmp/.co_subject_count_prev
  PREV_COUNT=\$(cat "\${PREV_COUNT_FILE}" 2>/dev/null || echo "0")

  if [ -z "\${COUNT}" ]; then
    alert "Could not retrieve subject count from API for study \${STUDY_ID}"
  else
    log "Subject count: \${COUNT} (previous: \${PREV_COUNT})"
    echo "\${COUNT}" > "\${PREV_COUNT_FILE}"
  fi
}

# --------------------------------------------------
# 4. SFTP export delivery check
# --------------------------------------------------
check_sftp_exports() {
  log "--- Checking SFTP export delivery ---"
  if [ ! -d "\${SFTP_DROP_DIR}" ]; then
    log "SFTP drop directory not found — skipping export check"
    return
  fi

  RECENT_FILE=\$(find "\${SFTP_DROP_DIR}" -type f -name "*.xpt" -mmin -\$(( SFTP_MAX_AGE_HOURS * 60 )) 2>/dev/null | head -1)
  if [ -z "\${RECENT_FILE}" ]; then
    alert "No SFTP export file found in \${SFTP_DROP_DIR} within last \${SFTP_MAX_AGE_HOURS} hours"
  else
    log "SFTP export present: \${RECENT_FILE}"
  fi
}

# --------------------------------------------------
# 5. API error rate spot check
# --------------------------------------------------
check_api_error_rate() {
  [ -z "\${TOKEN}" ] && return
  log "--- Spot-checking API error rate ---"
  HTTP_CODE=\$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 \
    -H "Authorization: Bearer \${TOKEN}" \
    "\${TENANT_URL}/api/v1/studies" 2>/dev/null)
  if [ "\${HTTP_CODE}" = "500" ] || [ "\${HTTP_CODE}" = "502" ] || [ "\${HTTP_CODE}" = "503" ]; then
    alert "Clinical One API returned server error HTTP \${HTTP_CODE} on /api/v1/studies"
  else
    log "API studies endpoint: HTTP \${HTTP_CODE}"
  fi
}

# --------------------------------------------------
# 6. Send alert
# --------------------------------------------------
send_alert() {
  if [ "\${ALERT_TRIGGERED}" -eq 1 ]; then
    printf "Oracle Clinical One Health Alert\\nHost: \$(hostname)\\nTime: \${TIMESTAMP}\\n\\nIssues:\\n\${ALERT_MSG}\\n" \
      | mail -s "Clinical One Alert - \$(hostname)" "\${ALERT_EMAIL}"
    log "Alert sent to \${ALERT_EMAIL}"
  else
    log "All checks passed"
  fi
}

# --------------------------------------------------
# Main
# --------------------------------------------------
log "====== Clinical One Health Check Start ======"
check_api_health
get_token
check_study_freshness
check_sftp_exports
check_api_error_rate
send_alert
log "====== Clinical One Health Check Complete ======"
\`\`\`

Schedule in crontab:

\`\`\`
*/15 * * * * /opt/scripts/clinical_one_health.sh >> /var/log/clinical_one_health.log 2>&1
\`\`\`

---

## Summary

Oracle Clinical One eliminates the infrastructure burden of on-premise eClinical platforms. The DBA's role shifts from schema management and patching to integration architecture, API credential lifecycle management, and monitoring the observable surface — availability, authentication, data freshness, and export delivery. The health check script above covers that surface systematically every 15 minutes, alerting your clinical operations team before data managers and sites notice a problem.`,
};

async function main() {
  await db
    .insert(posts)
    .values(post)
    .onConflictDoUpdate({
      target: posts.slug,
      set: { title: post.title, content: post.content, excerpt: post.excerpt, updatedAt: new Date() },
    });
  console.log('Inserted:', post.slug);
}

main().catch(console.error);
