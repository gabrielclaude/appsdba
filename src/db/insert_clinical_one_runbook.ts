import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Clinical One Administration Runbook — Cloud Config, Integration, Monitoring, and Health Scripts',
  slug: 'oracle-clinical-one-cloud-admin-runbook',
  excerpt:
    'Step-by-step Oracle Clinical One SaaS administration runbook: tenant provisioning, IDCS/IAM user setup, REST API integration, SFTP export configuration, complete bash health monitoring scripts, crontab scheduling, and a full operational maintenance calendar.',
  category: 'oracle-clinical' as const,
  isPremium: true,
  published: true,
  publishedAt: new Date('2026-06-19'),
  content: `## Phase 0: Tenant Provisioning Checklist

Oracle provisions the Clinical One tenant after contract execution. Before going further, confirm receipt of all of the following from Oracle:

- [ ] Tenant URL: \`https://<orgname>.clinicalone.ocs.oraclecloud.com\`
- [ ] IDCS tenant URL: \`https://idcs-<tenantid>.identity.oraclecloud.com\`
- [ ] Initial administrator credentials (one-time use; rotate immediately)
- [ ] API client ID and client secret (for service account integrations)
- [ ] OCI Object Storage bucket name and namespace for data exports
- [ ] SFTP endpoint details if using managed SFTP export delivery
- [ ] Oracle support identifier (CSI) for SR logging

If any item is missing, open an SR with Oracle Health Sciences Support before proceeding.

---

## Phase 1: OCI IAM / IDCS User and Role Configuration

Clinical One uses Oracle Identity Cloud Service (IDCS) — or OCI IAM Identity Domains on newer tenancies — for all authentication. User management is done via the IDCS console, not within Clinical One itself.

### 1.1 Log in to IDCS Admin Console

Navigate to: \`https://idcs-<tenantid>.identity.oraclecloud.com/ui/v1/adminconsole\`

Use the initial administrator credentials provided at provisioning.

### 1.2 Rotate Initial Administrator Password

Immediately change the initial administrator password via My Profile → Change Password. Store the new credential in your secrets manager (HashiCorp Vault, OCI Vault, or equivalent).

### 1.3 Create Service Account for API Integration

\`\`\`
IDCS Console → Users → Add User
  First Name: Clinical
  Last Name:  OneAPI
  Username:   svc-clinicalone-api
  Email:      svc-clinicalone-api@yourorg.com
\`\`\`

Assign the user to the \`Clinical_One_API_User\` IDCS group (or the equivalent application role).

Generate API credentials:
\`\`\`
IDCS Console → Users → svc-clinicalone-api → OAuth → Add
  Client Type: Confidential
  Allowed Grant Types: Client Credentials
  Scope: <Clinical One API scope>
\`\`\`

Record the **Client ID** and **Client Secret** — these are shown only once.

### 1.4 Federate Corporate Identity Provider (Optional but Recommended)

For sponsor staff who already have corporate credentials, configure SAML 2.0 federation:

\`\`\`
IDCS Console → Security → Identity Providers → Add SAML IdP
  Provider Name: Corporate-ADFS
  Metadata URL: https://adfs.yourorg.com/FederationMetadata/2007-06/FederationMetadata.xml
  NameID Format: email
  Attribute Mapping: mail → email, sAMAccountName → username
\`\`\`

After federation, assign federated users to Clinical One application roles without requiring separate Clinical One passwords.

### 1.5 Assign Clinical One Application Roles

Within the IDCS console, navigate to Applications → Clinical One → Application Roles and assign users to:

| Role | Purpose |
|------|---------|
| Study Designer | Build study versions, forms, visit schedules |
| Study Admin | Manage study environments, promote versions |
| Data Manager | Review and query eCRF data |
| Clinical Pharmacologist | View PK/PD data and RTSM supply data |
| Site User | Data entry at investigative sites |
| Super User | Cross-study visibility, user management |

---

## Phase 2: Study Environment Configuration

### 2.1 Create a New Study

Log in to Clinical One as Study Designer:

\`\`\`
Clinical One UI → Studies → New Study
  Protocol Number: PROTOCOL-2026-001
  Study Phase:     Phase III
  Therapeutic Area: Oncology
  Study Type:      Interventional
  Blinding:        Double-blind
  Randomized:      Yes
\`\`\`

### 2.2 Configure Study Environments

Every study has at minimum two environments:

\`\`\`
Studies → PROTOCOL-2026-001 → Environments
  [+] Add Environment
    Name: UAT
    Type: User Acceptance Testing
  [+] Add Environment
    Name: Production
    Type: Production
\`\`\`

**Never perform study design testing directly in the Production environment.** Always validate in UAT first.

### 2.3 Build Study Design

Within the UAT environment:

1. **Define visit schedule**: Screening (Day -14), Baseline (Day 1), Treatment visits (Day 8, 15, 22), End of Treatment, Follow-Up
2. **Build eCRF forms**: Demographics, Adverse Events, Concomitant Medications, Lab Results, Vital Signs, Disposition
3. **Configure edit checks**: Required fields, range checks, cross-form consistency rules
4. **Set up randomization**: Arms (Active 2:1 Placebo), stratification factors, block size
5. **Configure supply**: Kit types (Active/Placebo), depot structure, resupply rules, expiry tracking

### 2.4 UAT Testing Protocol

Before promoting to Production:

- [ ] Execute all visit CRF entries with synthetic subject data
- [ ] Trigger randomization and verify arm assignment distribution
- [ ] Test all edit checks (valid data + intentionally invalid data)
- [ ] Verify SFTP export delivers correctly structured ODM XML and SAS XPT files
- [ ] Test API endpoints with service account credentials
- [ ] Confirm audit trail entries are correct for all data changes
- [ ] Obtain Study Designer and Data Manager sign-off on UAT completion

### 2.5 Promote to Production

\`\`\`
Studies → PROTOCOL-2026-001 → UAT → Actions → Promote to Production
  Approval required: Study Administrator
  Change description: Initial study go-live
\`\`\`

Once promoted, the study version is locked. Any protocol amendment requires a formal study version increment.

---

## Phase 3: REST API Integration Configuration

### 3.1 Token Acquisition Script

Save as \`/opt/scripts/co_get_token.sh\`:

\`\`\`bash
#!/bin/bash
IDCS_URL=https://idcs-<tenantid>.identity.oraclecloud.com
CLIENT_ID=\$(cat /etc/secrets/co_client_id)
CLIENT_SECRET=\$(cat /etc/secrets/co_client_secret)
SCOPE="https://clinical-one.ocs.oraclecloud.com/.default"
TOKEN_CACHE=/tmp/.co_token_cache

# Return cached token if fresh (within 3500 seconds)
if [ -f "\${TOKEN_CACHE}" ]; then
  CACHE_AGE=\$(( \$(date +%s) - \$(stat -c %Y "\${TOKEN_CACHE}" 2>/dev/null || echo 0) ))
  if [ "\${CACHE_AGE}" -lt 3500 ]; then
    cat "\${TOKEN_CACHE}"
    exit 0
  fi
fi

# Acquire fresh token
TOKEN=\$(curl -s -X POST "\${IDCS_URL}/oauth2/v1/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=\${CLIENT_ID}&client_secret=\${CLIENT_SECRET}&scope=\${SCOPE}" \
  | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)

if [ -z "\${TOKEN}" ]; then
  echo "ERROR: Token acquisition failed" >&2
  exit 1
fi

echo "\${TOKEN}" > "\${TOKEN_CACHE}"
chmod 600 "\${TOKEN_CACHE}"
echo "\${TOKEN}"
\`\`\`

### 3.2 Common API Operations

\`\`\`bash
TENANT=https://yourorg.clinicalone.ocs.oraclecloud.com
TOKEN=\$(/opt/scripts/co_get_token.sh)

# List studies
curl -s -H "Authorization: Bearer \${TOKEN}" \
  "\${TENANT}/api/v1/studies" | python3 -m json.tool

# Get subject enrollment summary for a study
STUDY_ID=study-abc123
curl -s -H "Authorization: Bearer \${TOKEN}" \
  "\${TENANT}/api/v1/studies/\${STUDY_ID}/subjects?limit=1" \
  | python3 -m json.tool

# Get randomization events (last 24 hours)
curl -s -H "Authorization: Bearer \${TOKEN}" \
  "\${TENANT}/api/v1/studies/\${STUDY_ID}/randomizations?createdAfter=\$(date -d '24 hours ago' -Iseconds 2>/dev/null || date -v-24H -Iseconds)" \
  | python3 -m json.tool

# Export study data snapshot (triggers async export job)
curl -s -X POST -H "Authorization: Bearer \${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"format":"SAS_XPT","environments":["Production"]}' \
  "\${TENANT}/api/v1/studies/\${STUDY_ID}/exports"
\`\`\`

### 3.3 API Credential Rotation (Every 90 Days)

\`\`\`
IDCS Console → Applications → Clinical One → Configuration → OAuth
  Select current client credential → Rotate Secret → Confirm
  Download new client_secret
  Update /etc/secrets/co_client_secret on all integration servers
  Test token acquisition: /opt/scripts/co_get_token.sh
  Verify integration jobs run successfully
  Revoke old client secret
\`\`\`

Document rotation in your change management system. Automate reminder via crontab:

\`\`\`
# Remind 2 weeks before 90-day credential expiry
0 9 * * 1 /opt/scripts/check_co_credential_age.sh
\`\`\`

---

## Phase 4: SFTP Export Configuration

### 4.1 Configure Export Destination

In Clinical One administration console:

\`\`\`
Administration → Integrations → Data Exports → Add Export Configuration
  Name: Production-SAS-Daily
  Environment: Production
  Format: SAS Transport (XPT)
  Frequency: Daily at 02:00 UTC
  Delivery: SFTP
    Host: sftp.yourorg.com
    Port: 22
    Path: /incoming/clinicalone/production
    Credentials: SSH key (paste public key)
    Fingerprint: <SHA256 fingerprint of SFTP server host key>
\`\`\`

Upload the SSH public key that your SFTP server uses. Clinical One will use the corresponding private key (managed by Oracle) to authenticate.

### 4.2 Verify SFTP Delivery

\`\`\`bash
# Check for files delivered in the last 26 hours
find /incoming/clinicalone/production -name "*.xpt" -mtime -1 | while read f; do
  echo "\$(ls -lh \$f)"
done

# Validate XPT file structure
python3 -c "
import struct, os, sys
f = sys.argv[1]
with open(f, 'rb') as fh:
    header = fh.read(80)
    if b'LIBRARY' in header or b'MEMBER' in header:
        print(f'{f}: Valid SAS transport format')
    else:
        print(f'{f}: WARNING — unexpected format')
" /incoming/clinicalone/production/DM.xpt
\`\`\`

---

## Phase 5: Complete Health Monitoring Script

Save as \`/opt/scripts/clinical_one_health.sh\`:

\`\`\`bash
#!/bin/bash
# =====================================================
# Oracle Clinical One Comprehensive Health Check
# Run every 15 minutes via crontab
# =====================================================

TENANT_URL=https://yourorg.clinicalone.ocs.oraclecloud.com
IDCS_URL=https://idcs-<tenantid>.identity.oraclecloud.com
CLIENT_ID_FILE=/etc/secrets/co_client_id
CLIENT_SECRET_FILE=/etc/secrets/co_client_secret
SCOPE="https://clinical-one.ocs.oraclecloud.com/.default"
STUDY_ID=<your_primary_study_id>
SFTP_DROP_DIR=/incoming/clinicalone/production
SFTP_MAX_AGE_HOURS=26
ALERT_EMAIL=clinops-oncall@yourorg.com
STATE_DIR=/var/lib/co_health
LOG=/var/log/clinical_one_health.log

mkdir -p "\${STATE_DIR}"
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')
ALERT_TRIGGERED=0
ALERT_MSGS=()

log()   { echo "[\${TIMESTAMP}] \$1" | tee -a "\${LOG}"; }
alert() { ALERT_TRIGGERED=1; ALERT_MSGS+=("\$1"); log "ALERT: \$1"; }

# ---- 1. API health endpoint ----
check_api_health() {
  log "--- API health endpoint ---"
  CODE=\$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 \
    "\${TENANT_URL}/api/v1/health" 2>/dev/null)
  [ "\${CODE}" = "200" ] && log "API health: OK (\${CODE})" \
    || alert "API health endpoint returned \${CODE} (expected 200)"
}

# ---- 2. OAuth token check ----
acquire_token() {
  log "--- OAuth token acquisition ---"
  CLIENT_ID=\$(cat "\${CLIENT_ID_FILE}" 2>/dev/null)
  CLIENT_SECRET=\$(cat "\${CLIENT_SECRET_FILE}" 2>/dev/null)
  if [ -z "\${CLIENT_ID}" ] || [ -z "\${CLIENT_SECRET}" ]; then
    alert "Cannot read API credentials from \${CLIENT_ID_FILE} or \${CLIENT_SECRET_FILE}"
    TOKEN=""
    return
  fi

  RESP=\$(curl -s -X POST "\${IDCS_URL}/oauth2/v1/token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --max-time 15 \
    -d "grant_type=client_credentials&client_id=\${CLIENT_ID}&client_secret=\${CLIENT_SECRET}&scope=\${SCOPE}" 2>/dev/null)

  TOKEN=\$(echo "\${RESP}" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
  [ -n "\${TOKEN}" ] && log "Token acquired" || alert "Token acquisition failed — IDCS may be unreachable or credentials invalid"
}

# ---- 3. Study subject count freshness ----
check_subject_freshness() {
  [ -z "\${TOKEN}" ] && { log "Skipping subject check (no token)"; return; }
  log "--- Subject count freshness ---"
  RESP=\$(curl -s --max-time 15 \
    -H "Authorization: Bearer \${TOKEN}" \
    "\${TENANT_URL}/api/v1/studies/\${STUDY_ID}/subjects?limit=1" 2>/dev/null)

  COUNT=\$(echo "\${RESP}" | grep -o '"total":[0-9]*' | grep -o '[0-9]*')
  PREV_FILE="\${STATE_DIR}/subject_count_\${STUDY_ID}"
  PREV=\$(cat "\${PREV_FILE}" 2>/dev/null || echo "UNKNOWN")

  if [ -z "\${COUNT}" ]; then
    alert "Could not retrieve subject count for study \${STUDY_ID}"
  else
    log "Study \${STUDY_ID} subject count: \${COUNT} (was: \${PREV})"
    echo "\${COUNT}" > "\${PREV_FILE}"
  fi
}

# ---- 4. API error rate ----
check_api_errors() {
  [ -z "\${TOKEN}" ] && return
  log "--- API error rate ---"
  for ENDPOINT in "studies" "studies/\${STUDY_ID}/subjects?limit=1"; do
    CODE=\$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 \
      -H "Authorization: Bearer \${TOKEN}" \
      "\${TENANT_URL}/api/v1/\${ENDPOINT}" 2>/dev/null)
    if echo "\${CODE}" | grep -qE '^5'; then
      alert "API /api/v1/\${ENDPOINT} returned server error \${CODE}"
    else
      log "GET /api/v1/\${ENDPOINT}: \${CODE}"
    fi
  done
}

# ---- 5. SFTP export delivery ----
check_sftp_exports() {
  log "--- SFTP export delivery ---"
  if [ ! -d "\${SFTP_DROP_DIR}" ]; then
    log "SFTP drop dir \${SFTP_DROP_DIR} not found — skipping"
    return
  fi
  CUTOFF_MINS=\$(( SFTP_MAX_AGE_HOURS * 60 ))
  RECENT=\$(find "\${SFTP_DROP_DIR}" -name "*.xpt" -mmin -"\${CUTOFF_MINS}" 2>/dev/null | head -1)
  if [ -z "\${RECENT}" ]; then
    alert "No SAS XPT file in \${SFTP_DROP_DIR} within last \${SFTP_MAX_AGE_HOURS} hours — export may have failed"
  else
    SIZE=\$(du -sh "\${RECENT}" 2>/dev/null | cut -f1)
    log "SFTP export present: \${RECENT} (\${SIZE})"
  fi
}

# ---- 6. IDCS credential age check ----
check_credential_age() {
  log "--- API credential age ---"
  CRED_AGE_FILE="\${STATE_DIR}/credential_last_rotated"
  if [ -f "\${CRED_AGE_FILE}" ]; then
    LAST_ROTATED=\$(cat "\${CRED_AGE_FILE}")
    DAYS_AGO=\$(( ( \$(date +%s) - LAST_ROTATED ) / 86400 ))
    log "API credentials last rotated \${DAYS_AGO} days ago"
    if [ "\${DAYS_AGO}" -ge 75 ]; then
      alert "API credentials are \${DAYS_AGO} days old — rotate within \$(( 90 - DAYS_AGO )) days"
    fi
  else
    log "No credential rotation timestamp found — create \${CRED_AGE_FILE} after next rotation"
  fi
}

# ---- 7. Integration server connectivity ----
check_dns_connectivity() {
  log "--- DNS and connectivity ---"
  if ! host "\${TENANT_URL#https://}" >/dev/null 2>&1; then
    alert "DNS resolution failed for \${TENANT_URL#https://} — check network/DNS from integration server"
  else
    log "DNS OK for \${TENANT_URL#https://}"
  fi
}

# ---- 8. Log local error summary (last run interval) ----
summarize_log_errors() {
  log "--- Log error summary (last 15 min) ---"
  ERROR_COUNT=\$(awk -v ts="\$(date -d '15 minutes ago' '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date -v-15M '+%Y-%m-%d %H:%M:%S')" \
    '\$0 >= ts && /ALERT/' "\${LOG}" 2>/dev/null | wc -l)
  log "ALERT lines in log in last 15 min: \${ERROR_COUNT}"
}

# ---- 9. Send alert email ----
send_alert() {
  if [ "\${ALERT_TRIGGERED}" -eq 1 ]; then
    {
      echo "Oracle Clinical One Health Alert"
      echo "Host: \$(hostname)"
      echo "Time: \${TIMESTAMP}"
      echo ""
      echo "Issues detected:"
      for msg in "\${ALERT_MSGS[@]}"; do
        echo "  - \${msg}"
      done
      echo ""
      echo "Log: \${LOG}"
    } | mail -s "Clinical One Alert [\$(hostname)]" "\${ALERT_EMAIL}"
    log "Alert email sent to \${ALERT_EMAIL}"
  else
    log "All checks passed — no alert"
  fi
}

# ---- Main ----
log "====== Clinical One Health Check Start ======"
check_dns_connectivity
check_api_health
acquire_token
check_subject_freshness
check_api_errors
check_sftp_exports
check_credential_age
summarize_log_errors
send_alert
log "====== Clinical One Health Check Complete ======"
\`\`\`

Make executable and secure:

\`\`\`bash
chmod 750 /opt/scripts/clinical_one_health.sh
chmod 700 /etc/secrets
chmod 600 /etc/secrets/co_client_id /etc/secrets/co_client_secret
chown clinops:clinops /opt/scripts/clinical_one_health.sh /etc/secrets/co_client_*
\`\`\`

---

## Phase 6: Crontab Configuration

Add to the \`clinops\` service account crontab (\`crontab -e\` as clinops):

\`\`\`
# Clinical One health check every 15 minutes
*/15 * * * * /opt/scripts/clinical_one_health.sh >> /var/log/co_health_cron.log 2>&1

# Daily SFTP export validation at 06:00 (export runs at 02:00 UTC)
0 6 * * * /opt/scripts/co_validate_sftp_export.sh >> /var/log/co_sftp_validate.log 2>&1

# Weekly API credential age check Monday 09:00
0 9 * * 1 /opt/scripts/co_check_credential_age.sh >> /var/log/co_credential.log 2>&1

# Monthly data completeness report first of month 07:00
0 7 1 * * /opt/scripts/co_completeness_report.sh >> /var/log/co_completeness.log 2>&1

# Log rotation: compress logs older than 7 days, delete older than 90 days
0 2 * * * find /var/log -name "co_*.log" -mtime +7 -exec gzip {} \\;
0 3 * * * find /var/log -name "co_*.log.gz" -mtime +90 -delete
\`\`\`

### SFTP Validation Script (daily)

\`\`\`bash
#!/bin/bash
# co_validate_sftp_export.sh — verify last night's export is complete
SFTP_DIR=/incoming/clinicalone/production
EXPECTED_DOMAINS="DM AE CM LB VS DS EX"
REPORT_EMAIL=clinops@yourorg.com
MISSING=""

for DOMAIN in \${EXPECTED_DOMAINS}; do
  FILE=\$(find "\${SFTP_DIR}" -name "\${DOMAIN}.xpt" -mtime -1 2>/dev/null | head -1)
  if [ -z "\${FILE}" ]; then
    MISSING="\${MISSING} \${DOMAIN}"
  else
    BYTES=\$(stat -c %s "\${FILE}" 2>/dev/null || echo 0)
    [ "\${BYTES}" -eq 0 ] && MISSING="\${MISSING} \${DOMAIN}(empty)"
    echo "[\$(date)] OK: \${DOMAIN} — \${FILE} (\${BYTES} bytes)"
  fi
done

if [ -n "\${MISSING}" ]; then
  echo "MISSING or empty export domains: \${MISSING}" \
    | mail -s "Clinical One Export Incomplete" "\${REPORT_EMAIL}"
fi
\`\`\`

---

## Phase 7: Maintenance Calendar

### Daily
- Review \`/var/log/clinical_one_health.log\` for ALERT lines from overnight runs
- Confirm SFTP export delivered (co_validate_sftp_export.sh output)
- Check Clinical One status page at \`https://cloudhealthstatus.oracle.com\` for any active incidents

### Weekly
- Review API error rate trends from health log aggregation
- Verify all study environments (UAT, Production) accessible via browser login test
- Review IDCS user access — remove any departed staff or CRO contacts
- Check data export file sizes vs prior week — anomalous drop may indicate site data entry stall

### Monthly
- Rotate API client credentials if approaching 90-day mark; update STATE_DIR timestamp
- Pull API-based enrollment metrics for each active study and compare to study timeline
- Review and archive Clinical One audit trail exports (Administration → Audit Trail → Export)
- Test DR failover: verify you can reach the tenant URL from secondary network path
- Review site user list — deactivate inactive sites that have completed enrollment

### Quarterly
- Full access recertification: loop through all Clinical One user accounts and confirm each user's role assignment is still appropriate
- Review integration performance metrics — API response time trends from health logs
- Update credential age timestamp file after scheduled rotation
- Test end-to-end integration pipeline: trigger manual export, validate in data warehouse

---

## Troubleshooting Quick Reference

### API Returns 401 Unauthorized
1. Confirm token is being sent: \`Bearer \${TOKEN}\` header present
2. Check token expiry: tokens expire after 3600 seconds
3. Verify client credentials: \`cat /etc/secrets/co_client_id\` matches IDCS console
4. Confirm scope is correct for the API being called
5. Re-generate client secret in IDCS if still failing and update secret file

### SFTP Export Not Delivered
1. Check Clinical One Administration → Integrations → Export Jobs for last run status
2. Verify SFTP server is reachable from Oracle's delivery IP range (request ranges from Oracle support)
3. Confirm SSH host key fingerprint in Clinical One matches your SFTP server
4. Check SFTP server logs for connection attempts and authentication errors

### Study Version Promotion Blocked
1. Confirm all UAT test cases are marked complete and sign-offs are recorded
2. Check for open issues in Clinical One study validation (red indicators in Study Designer)
3. Confirm the promoting user has Study Administrator role in IDCS
4. Review study amendment documentation if this is an amendment promotion

### Randomization Not Working at Site
1. Confirm subject meets all eligibility rules (edit checks must pass before randomization)
2. Check supply inventory — if kit count is zero, resupply rules trigger before randomization can complete
3. Verify the site user has the correct role to perform randomization
4. Check Clinical One audit trail for the specific subject and step to identify where the flow stopped

### OCI / Oracle Managed Outage
1. Check \`https://cloudhealthstatus.oracle.com\` for active incidents
2. Open a P1 SR with Oracle Health Sciences Support — Clinical One SLAs are defined in your contract
3. Notify clinical operations team with estimated impact to site data entry
4. Document outage window and impact for regulatory deviation log if required under your SOPs

---

## Summary

Oracle Clinical One removes infrastructure complexity from eClinical operations but introduces a new operational model: API-based integration management, credential lifecycle governance, and SFTP export validation replace the schema tuning and patching cycles of on-premise CDMS. The health check script in Phase 5 gives you automated 15-minute coverage of every observable surface. Pair it with a weekly access recertification discipline and a 90-day credential rotation cadence, and your clinical data operations team has a solid, audit-ready monitoring baseline.`,
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
