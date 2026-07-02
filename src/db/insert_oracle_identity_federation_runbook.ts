import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Identity Federation — Configuration, Partner Setup, and Troubleshooting',
  slug: 'oracle-identity-federation-runbook',
  excerpt:
    'Step-by-step operational runbook for Oracle Identity Federation (OIF) embedded in OAM 12c: enabling federation, generating signing certificates, configuring SAML IDP for Salesforce, configuring SAML SP for Microsoft Entra ID, Circle of Trust setup, zero-downtime certificate rotation, debug logging, and a complete troubleshooting reference table.',
  category: 'identity-management' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-02'),
  youtubeUrl: null,
  content: `## Overview

This runbook covers the end-to-end operational procedures for Oracle Identity Federation (OIF) embedded in Oracle Access Manager 12c. It is intended for Oracle middleware administrators, identity management engineers, and DBAs who manage the OAM infrastructure. It covers enabling and verifying the federation module, certificate management, configuring outbound SAML federation to cloud SPs (Salesforce), configuring inbound SAML federation from external IDPs (Microsoft Entra ID / Azure AD), Circle of Trust configuration, zero-downtime certificate rotation, debug logging, and a complete troubleshooting reference.

---

## Prerequisites

### Software (OAM 12c embedded federation, recommended)

- Oracle Access Manager 12.2.1.4 (includes OIF)
- Oracle Unified Directory 12.2.1.4 (identity store)
- Oracle HTTP Server 12.2.1.4 (WebGate for SP protection)
- Valid X.509 certificates from a trusted CA (for federation signing; self-signed only for dev/test)

### Network Requirements

| Source | Destination | Port | Purpose |
|---|---|---|---|
| Browser | OAM/OIF | 443 (HTTPS) | SSO redirects and assertion POST |
| SP (cloud app) | OAM/OIF metadata URL | 443 | Metadata auto-refresh |
| OAM/OIF | SP SLO endpoint | 443 | Global logout callbacks |
| OAM/OIF | LDAP (OUD/AD) | 1636 | Identity store queries for attribute retrieval |

---

## Step 1: Verify Federation is Enabled in OAM 12c

\`\`\`bash
# Check that the OAM federation endpoints are responding
curl -sk "https://oam-host:14101/fed/idp/metadata" | head -5
# Should return XML starting with <EntityDescriptor ...>

# If not responding, verify the oam_server is running with federation module
\${DOMAIN_HOME}/bin/wlst.sh <<'EOF'
connect('weblogic','password','t3://admin-host:7001')
serverRuntime = getMBean('/ServerRuntimes/oam_server1')
print('State:', serverRuntime.getState())
EOF
\`\`\`

If the federation endpoints are not responding, enable the federation module:

1. OAM Admin Console (\`http://oam-host:14100/oamconsole\`) → System Configuration → Common Configuration → Federation
2. Enable Federation Services: **Yes**
3. IDP Entity ID: \`https://oam-host.example.com/fed/idp\`
4. Save → restart oam_server1

---

## Step 2: Generate or Import the Federation Signing Certificate

OIF requires a dedicated X.509 key pair for signing SAML assertions. Do NOT use the WebLogic SSL certificate for this purpose.

**Generate a self-signed certificate** (development/testing only):

\`\`\`bash
keytool -genkeypair \
  -alias oif-signing \
  -keyalg RSA \
  -keysize 2048 \
  -validity 825 \
  -dname "CN=oam-host.example.com,O=Example Corp,C=US" \
  -keystore /u01/oracle/domains/oam_domain/config/fmwconfig/oif-keystore.jks \
  -storepass \${KEYSTORE_PASSWORD} \
  -keypass \${KEY_PASSWORD}

# Export the signing certificate for distribution to SP partners
keytool -exportcert \
  -alias oif-signing \
  -keystore /u01/oracle/domains/oam_domain/config/fmwconfig/oif-keystore.jks \
  -storepass \${KEYSTORE_PASSWORD} \
  -file /tmp/oif-signing-cert.pem \
  -rfc
\`\`\`

**Import into OAM**:
1. OAM Admin Console → Federation → Identity Provider → Certificates → Add
2. Type: Signing Certificate
3. Upload the PEM file
4. Set as Primary Signing Certificate

For production, submit the CSR to your internal or public CA instead of using a self-signed certificate. The import procedure is the same — upload the CA-issued PEM.

---

## Step 3: Configure OAM as SAML IDP (Outbound — Enterprise to Cloud SP)

### Example: Configure Salesforce as SP Partner

**3.1 Get Salesforce metadata**:
- In Salesforce Setup → Identity → Single Sign-On Settings → Download Metadata
- Note the Entity ID (e.g., \`https://samltest.salesforce.com\`) and ACS URL

**3.2 Create SP Partner in OAM**:
1. OAM Admin Console → Federation → Service Provider Partners → Create
2. Fill in:
   - Partner Name: \`Salesforce_Production\`
   - SAML Version: 2.0
   - Partner Entity ID: \`https://samltest.salesforce.com\`
   - ACS URL: \`https://samltest.salesforce.com/saml/SSO\`
   - SLO Endpoint: \`https://samltest.salesforce.com/saml/logout\`
   - Signature Algorithm: RSA-SHA256
   - Name ID Format: \`urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress\`
   - Name ID Value: \`uid\` (LDAP attribute — maps to the user's email address)
3. Attribute Mapping:
   - \`uid\` → \`email\`
   - \`givenName\` → \`firstName\`
   - \`sn\` → \`lastName\`
   - \`memberOf\` → \`Role\` (Salesforce reads this for profile assignment)
4. Save

**3.3 Publish OAM metadata to Salesforce**:
- Metadata URL: \`https://oam-host.example.com/fed/idp/metadata\`
- In Salesforce: Setup → Identity → Single Sign-On Settings → New → Import Metadata → paste the URL or upload the XML
- Set Salesforce to auto-refresh metadata (recommended — picks up certificate rotations automatically)

**3.4 Test SP-initiated SSO**:
1. Open a private browser window
2. Navigate to \`https://salesforce.com/\` → click "Use Custom Domain" → enter your Salesforce org
3. Salesforce redirects to OAM login
4. Log in with LDAP credentials
5. Confirm you land in Salesforce without re-prompting for credentials

---

## Step 4: Configure OAM as SAML SP (Inbound — Partner IDP to Oracle Apps)

### Example: Accept Assertions from Microsoft Entra ID (Azure AD)

**4.1 Register OAM in Azure AD**:
1. Azure Portal → Entra ID → Enterprise Applications → New → Create your own
2. Choose: Integrate any other application (Non-gallery)
3. App name: \`OAM_Federation\`
4. Single Sign-On → SAML
5. Basic SAML Config:
   - Entity ID: \`https://oam-host.example.com/fed/sp\`
   - Reply URL (ACS): \`https://oam-host.example.com/fed/sp/samlv20\`
6. Download the Azure AD Federation Metadata XML

**4.2 Register Azure AD as IDP Partner in OAM**:
1. OAM Admin Console → Federation → Identity Provider Partners → Create
2. Partner Name: \`AzureAD_Partner\`
3. SAML Version: 2.0
4. Upload the Azure AD Federation Metadata XML (auto-populates entity ID, SSO URL, certificate)
5. Name ID Format: emailAddress
6. Claim mapping:
   - \`http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress\` → OAM attribute \`mail\`
   - \`http://schemas.microsoft.com/ws/2008/06/identity/claims/groups\` → \`memberOf\`

**4.3 Configure Just-in-Time Provisioning (optional)**:

If partner users authenticating from Azure AD don't have a pre-existing account in OUD, enable JIT provisioning to auto-create them:
- OAM Console → Federation → Service Provider → Provisioning → Just-in-Time Provisioning
- Enable JIT provisioning: create a local user record in OUD on first assertion if no matching account found
- Map assertion attributes to LDAP attributes (e.g., \`mail\` → \`uid\`, \`displayName\` → \`cn\`)

**4.4 Verify OAM SP metadata is reachable**:

\`\`\`bash
curl -sk "https://oam-host.example.com/fed/sp/metadata"
\`\`\`

Browse to the OAM SP-initiated SSO URL — you should be redirected to the Azure AD login prompt. After Azure AD authentication, you should land on the OAM-protected resource.

---

## Step 5: Configure Circle of Trust

Group all partners that share a federated SSO session into a Circle of Trust for global logout coordination:

1. OAM Admin Console → Federation → Circles of Trust → Create
2. Name: \`Enterprise_CoT\`
3. Add partners: \`Salesforce_Production\`, \`ServiceNow_Production\`, \`AzureAD_Partner\`
4. IDP: \`oam_idp\` (the local OAM IDP)
5. Enable Single Logout: **Yes**
6. SLO Timeout: 30 seconds
7. Save

**Test global logout**:
1. Log in via SP-initiated SSO to Salesforce (OAM session created)
2. Open a second tab → initiate SSO to ServiceNow (reuses OAM session)
3. Log out from Salesforce
4. OAM sends LogoutRequest to ServiceNow
5. Verify ServiceNow session is also terminated (ServiceNow shows the login screen)

---

## Step 6: Certificate Rotation (Production Procedure)

This is a zero-downtime rotation using OIF's dual-certificate capability. Do not remove the old certificate until all SP partners have confirmed they are accepting signatures from the new certificate.

**Step 6.1: Generate a new key pair**:

\`\`\`bash
keytool -genkeypair \
  -alias oif-signing-new \
  -keyalg RSA -keysize 2048 -validity 825 \
  -dname "CN=oam-host.example.com,O=Example Corp,C=US" \
  -keystore /u01/oracle/domains/oam_domain/config/fmwconfig/oif-keystore.jks \
  -storepass \${KEYSTORE_PASSWORD}
\`\`\`

**Step 6.2: Export the new certificate**:

\`\`\`bash
keytool -exportcert \
  -alias oif-signing-new \
  -keystore /u01/oracle/domains/oam_domain/config/fmwconfig/oif-keystore.jks \
  -storepass \${KEYSTORE_PASSWORD} \
  -file /tmp/oif-signing-cert-new.pem -rfc
\`\`\`

**Step 6.3: Add as secondary signing certificate**:
- OAM Admin Console → Federation → IDP → Certificates → Add Secondary Signing Certificate → upload \`/tmp/oif-signing-cert-new.pem\`

OIF now signs with the old (primary) certificate and publishes both certificates in its metadata.

**Step 6.4: Notify SP partners**:
- "Our signing certificate is rotating. Update your trust to accept the new certificate OR subscribe to our metadata URL for automatic refresh."
- Wait 24–48 hours for all SPs to update. SPs auto-refreshing metadata will update within their configured refresh interval.

**Step 6.5: Promote the new certificate**:
- OAM Admin Console → Federation → IDP → Certificates → Promote \`oif-signing-new\` to Primary

OIF now signs with the new certificate. The old certificate remains in metadata as a secondary (allows SPs that haven't updated yet to still validate).

**Step 6.6: Remove the old certificate**:
- After confirming all SPs are accepting the new signature (test SP-initiated SSO to at least one SP per partner)
- OAM Admin Console → Federation → IDP → Certificates → Remove old certificate

---

## Step 7: Troubleshooting

### Enable Federation Debug Logging

\`\`\`bash
# Enable FINE logging for the federation package
\${DOMAIN_HOME}/oracle_common/common/bin/wlst.sh <<'EOF'
connect('weblogic','password','t3://admin-host:7001')
setLogLevel(logger='oracle.security.fed', level='FINE', persist='0', target='oam_server1')
EOF
# Logs appear in:
# \${DOMAIN_HOME}/servers/oam_server1/logs/oam_server1-diagnostic.log
\`\`\`

Note: \`persist='0'\` means the log level resets after the next server restart. Set \`persist='1'\` if you want it to survive restarts (not recommended for FINE level in production).

### Decode a SAML Assertion for Debugging

When testing SP-initiated SSO, capture the HTTP POST body in browser developer tools (Network tab → look for the POST to \`/saml/SSO\`). The \`SAMLResponse\` parameter is base64-encoded XML:

\`\`\`bash
echo "<SAMLResponse_value>" | base64 -d | xmllint --format - 2>/dev/null | head -60
\`\`\`

Check the decoded assertion for:
- \`IssueInstant\` time vs current time (clock skew check)
- \`NotOnOrAfter\` time (is the assertion already expired?)
- \`Audience\` value (does it match the SP's entity ID exactly?)
- \`NameID\` value (is this the expected user identifier?)
- Attribute names and values (are the expected attributes present?)

### Test Signing Certificate Trust

\`\`\`bash
# Verify the cert in OAM metadata matches what OAM is actually signing with
# Fetch metadata cert
METADATA_CERT=\$(curl -sk "https://oam-host:14101/fed/idp/metadata" | \
  grep -oP '(?<=<ds:X509Certificate>)[^<]+' | head -1)

# Export current signing cert from keystore
keytool -exportcert -alias oif-signing \
  -keystore /u01/oracle/domains/oam_domain/config/fmwconfig/oif-keystore.jks \
  -storepass \${KEYSTORE_PASSWORD} -rfc 2>/dev/null | \
  grep -v "BEGIN\|END" | tr -d '\n'

# Compare — if different, OAM is signing with a cert not published in its metadata
\`\`\`

---

## Step 8: Troubleshooting Reference Table

| Symptom | Likely Cause | Fix |
|---|---|---|
| "Audience restriction validation failed" | SP entity ID mismatch | Verify SP entity ID in OIF partner config is a case-exact match |
| "Assertion not yet valid" / "Assertion expired" | Clock skew > 5 minutes | Sync NTP on IDP, SP, and reverse proxies |
| "Signature validation failed" | IDP cert rotated, SP has old cert | Re-import OIF metadata at the SP; verify cert in metadata |
| Browser loops between IDP and SP | SP ACS URL wrong or OAM session not persisting | Check ACS URL in partner config; verify OAM session cookie domain |
| "Unknown SP partner" in OAM log | SP entity ID in AuthnRequest not registered in OIF | Register the SP in OAM Federation → Service Provider Partners |
| SLO completes but user still logged in to one SP | SP SLO endpoint unreachable or returned error | Verify SP's SLO URL; test it manually; check SP's own SLO logs |
| Attributes missing from assertion | LDAP attribute not configured in OIF attribute profile | Add attribute to the SP partner's attribute mapping |
| "NameID format not supported" | SP requires a NameID format OIF is not sending | Change NameID format in partner config to match SP's requirement |
| Azure AD assertion rejected by OAM | Claim mapping missing or Azure AD cert untrusted | Import Azure AD metadata; verify claim-to-attribute mapping |
| JIT provisioning not creating user | Assertion attribute name mismatch in JIT mapping | Enable debug logging; compare assertion attribute names vs JIT config |

---

## Step 9: Monitoring

### Automated Assertion Validation Check

Deploy this script on your monitoring server (Nagios, Zabbix, custom check). It verifies the OIF metadata endpoint is reachable and the signing certificate has not expired or is within 30 days of expiry.

\`\`\`bash
#!/bin/bash
# Check OAM federation IDP metadata endpoint
OAM_HOST="oam-host.example.com"
METADATA_URL="https://\${OAM_HOST}:14101/fed/idp/metadata"

# Fetch metadata
HTTP_CODE=\$(curl -sk -o /tmp/oif_metadata.xml -w "%{http_code}" "\${METADATA_URL}")
if [ "\${HTTP_CODE}" != "200" ]; then
  echo "CRITICAL: OIF metadata endpoint returned HTTP \${HTTP_CODE}"
  exit 2
fi

# Check signing certificate expiry
CERT=\$(grep -oP '(?<=<ds:X509Certificate>)[^<]+' /tmp/oif_metadata.xml | head -1)
EXPIRY=\$(echo "-----BEGIN CERTIFICATE-----
\${CERT}
-----END CERTIFICATE-----" | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)

EXPIRY_EPOCH=\$(date -d "\${EXPIRY}" +%s 2>/dev/null || date -j -f "%b %d %T %Y %Z" "\${EXPIRY}" +%s)
NOW_EPOCH=\$(date +%s)
DAYS_LEFT=\$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))

if [ "\${DAYS_LEFT}" -lt 30 ]; then
  echo "WARNING: OIF signing certificate expires in \${DAYS_LEFT} days (\${EXPIRY})"
  exit 1
fi

echo "OK: OIF metadata healthy, signing certificate valid for \${DAYS_LEFT} more days"
exit 0
\`\`\`

Schedule this check to run every 15 minutes. Alert thresholds:
- WARNING at 30 days remaining
- CRITICAL at 14 days remaining (certificate rotation should already be in progress by this point)

### Key Operational Reminders

- Set a calendar reminder 180 days before the federation signing certificate expiry date. Coordinate with all SP partners for the rotation window.
- After any OAM patching or restart, run a quick SP-initiated SSO test to at least one SP per Circle of Trust to confirm the federation module came back up cleanly.
- If you add a new SP partner, test both SP-initiated SSO and global logout before announcing the integration as production-ready.
- Review the OAM audit log weekly for SAML assertion validation failures — a cluster of failures from a single SP partner often indicates a cert or entity ID mismatch that the SP's admin has not yet reported.`,
};

async function main() {
  console.log('Inserting...');
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
