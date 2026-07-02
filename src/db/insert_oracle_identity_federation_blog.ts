import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Identity Federation: SAML 2.0, Cross-Domain SSO, and Cloud Integration',
  slug: 'oracle-identity-federation-implementation',
  excerpt:
    'A comprehensive guide to Oracle Identity Federation (OIF): SAML 2.0 architecture, SP-initiated and IDP-initiated SSO flows, OIF embedded in OAM 12c, attribute mapping, WS-Federation, OpenID Connect, certificate management, Single Logout, EBS integration, and troubleshooting common federation failures in production.',
  category: 'identity-management' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-02'),
  youtubeUrl: null,
  content: `## Introduction

Oracle Identity Federation (OIF) is Oracle's standards-based federation platform that enables Single Sign-On across organizational and domain boundaries. While Oracle Access Manager handles SSO within an enterprise — authenticating users once and granting access to internal applications — OIF extends that capability outward: it allows an enterprise's authenticated users to access SaaS cloud applications (Salesforce, ServiceNow, Workday, Microsoft 365), partner portals, and government systems without re-authenticating. Conversely, it allows partner or cloud identities to access Oracle applications within the enterprise.

OIF implements the major federation standards: SAML 2.0, WS-Federation 1.2, and OpenID Connect, making it interoperable with virtually every enterprise identity platform and cloud provider. In Oracle's 12c product line, OIF functionality is embedded within Oracle Access Manager rather than shipped as a separate product, making the OAM server the single platform for both internal SSO and external federation.

---

## What Federation Solves

Without federation, cross-organizational access requires one of three approaches, all of which are problematic:

1. **Shadow accounts**: Each partner user gets a local account in the enterprise directory — creates an administrative burden and a security risk (accounts outlive the relationship)
2. **Shared credentials**: Users share a service account — no individual accountability, impossible to audit
3. **No access**: The simplest but least useful option

Federation solves this by allowing a user authenticated in one security domain (the **Identity Provider** or IDP) to be trusted and granted access in another domain (the **Service Provider** or SP) without the SP needing to know the user's credentials or maintain a local account. The SP trusts assertions from the IDP, validated cryptographically using X.509 certificates.

---

## SAML 2.0 Architecture

SAML 2.0 (Security Assertion Markup Language) is the dominant federation standard for enterprise applications. OIF implements the full SAML 2.0 profile set.

**Core SAML 2.0 concepts**:
- **Assertion**: An XML document signed by the IDP that states facts about the user (who they are, what groups they belong to, when they authenticated)
- **Identity Provider (IDP)**: The authority that authenticates the user and issues SAML assertions. In an Oracle environment, OAM/OIF is often the IDP for outbound federation to cloud apps.
- **Service Provider (SP)**: The application that trusts and consumes SAML assertions to grant access. Salesforce, ServiceNow, and SAP are common SPs that accept SAML from enterprise IDPs.
- **Metadata**: An XML document describing an IDP or SP — contains the entity ID, SSO endpoint URLs, SLO endpoint URLs, and signing/encryption X.509 certificate. Partners exchange metadata to establish trust.
- **Binding**: How SAML messages are transported — HTTP Redirect (assertion in URL query parameter, suitable for small assertions), HTTP POST (assertion in HTML form body, most common for full assertions), Artifact (assertion retrieved from IDP via back-channel)

**SAML 2.0 assertion structure** (simplified):

\`\`\`xml
<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  ID="_abc123" IssueInstant="2026-07-02T10:00:00Z"
  Version="2.0">
  <saml:Issuer>https://oam.example.com/fed/idp</saml:Issuer>
  <ds:Signature><!-- IDP signs with private key --></ds:Signature>
  <saml:Subject>
    <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">
      jsmith@example.com
    </saml:NameID>
    <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
      <saml:SubjectConfirmationData
        Recipient="https://salesforce.com/saml/SSO"
        NotOnOrAfter="2026-07-02T10:05:00Z"/>
    </saml:SubjectConfirmation>
  </saml:Subject>
  <saml:Conditions NotBefore="2026-07-02T09:59:55Z"
    NotOnOrAfter="2026-07-02T10:05:00Z">
    <saml:AudienceRestriction>
      <saml:Audience>https://samltest.salesforce.com</saml:Audience>
    </saml:AudienceRestriction>
  </saml:Conditions>
  <saml:AttributeStatement>
    <saml:Attribute Name="email">
      <saml:AttributeValue>jsmith@example.com</saml:AttributeValue>
    </saml:Attribute>
    <saml:Attribute Name="firstName">
      <saml:AttributeValue>John</saml:AttributeValue>
    </saml:Attribute>
    <saml:Attribute Name="memberOf">
      <saml:AttributeValue>SalesTeam</saml:AttributeValue>
    </saml:Attribute>
  </saml:AttributeStatement>
  <saml:AuthnStatement AuthnInstant="2026-07-02T10:00:00Z">
    <saml:AuthnContext>
      <saml:AuthnContextClassRef>
        urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport
      </saml:AuthnContextClassRef>
    </saml:AuthnContext>
  </saml:AuthnStatement>
</saml:Assertion>
\`\`\`

---

## SSO Flow Patterns

### SP-Initiated SSO (most common)

1. User visits Salesforce — not logged in — Salesforce generates a SAML AuthnRequest
2. Salesforce redirects browser to OAM/OIF IDP SSO endpoint with the AuthnRequest
3. OAM/OIF checks if user has an existing OAM session — if not, presents login form
4. After authentication, OIF generates a signed SAML assertion
5. OIF returns the assertion to the browser via HTTP POST to Salesforce's ACS (Assertion Consumer Service) URL
6. Salesforce validates the signature, checks the assertion conditions (time, audience), creates a local session, and grants access

### IDP-Initiated SSO

1. User logs in to the enterprise portal (already has OAM session)
2. User clicks "Launch Salesforce" from the portal
3. OAM/OIF generates a SAML assertion unsolicited (no AuthnRequest)
4. OIF POSTs the assertion directly to Salesforce's ACS URL
5. Salesforce validates and grants access

SP-initiated flow (text diagram):

\`\`\`
Browser     Salesforce (SP)        OAM/OIF (IDP)         LDAP/OUD
  |              |                       |                    |
  |--GET /app--> |                       |                    |
  |              |--AuthnRequest-------> |                    |
  |<-redirect----|                       |                    |
  |--GET /idp/sso with AuthnRequest----> |                    |
  |                                      |--bind/search-----> |
  |<--login form------------------------ |<---user attrs----- |
  |--POST credentials------------------> |                    |
  |                                      |--validate creds--> |
  |<--HTTP POST with SAML assertion----- |<---OK------------- |
  |--POST assertion to /saml/ACS-------> |                    |
  |              |<--validate sig--------|                    |
  |              |                                            |
  |<--session granted (access granted)---|                    |
\`\`\`

---

## OIF in OAM 12c — Embedded Federation

In OAM 12c (12.2.1+), OIF is not a separate product installation. The federation capabilities are built into the OAM server and configured entirely through the OAM Admin Console. This simplifies deployment significantly — there is no separate OIF install, no separate OIF managed server, and no separate OIF configuration tool.

**OAM 12c federation endpoints**:
- IDP SSO endpoint: \`https://oam-host:14101/fed/idp/samlv20\`
- IDP SLO endpoint: \`https://oam-host:14101/fed/idp/samlv20/slo\`
- Federation metadata URL: \`https://oam-host:14101/fed/idp/metadata\`
- SP ACS endpoint (when OAM acts as SP): \`https://oam-host:14101/fed/sp/samlv20\`

**Configuring OAM as SAML IDP for Salesforce**:
1. OAM Admin Console → Federation → Identity Provider → Create
2. Enter provider details: Entity ID, signing certificate, attribute mapping
3. Create SP Partner: upload Salesforce's metadata XML
4. Configure attribute mapping: \`uid\` → \`email\`, \`givenName\` → \`firstName\`, etc.
5. Publish OAM metadata URL to Salesforce

---

## Partner Types and Trust Models

### OAM/OIF as IDP (outbound federation)

- Enterprise users authenticate to OAM
- OAM issues SAML assertions consumed by cloud SPs (Salesforce, ServiceNow, Workday, Microsoft 365, Zoom)
- The enterprise maintains control — OAM determines who can access which SP via authorization policies

### OAM/OIF as SP (inbound federation)

- Partner users or cloud identities authenticate to an external IDP (Microsoft Entra ID/Azure AD, ADFS, Okta, Ping)
- External IDP issues SAML assertion
- OAM validates the assertion and grants access to Oracle applications
- Used for: B2B partner access, acquisitions (trusting the acquired company's IDP), government federated access

### Circle of Trust

OAM 12c uses a **Circle of Trust** (CoT) concept to group IDP and SP partners that share a common SSO session. All partners within a CoT participate in global logout — when the user logs out from any SP, OAM propagates the logout to all other SPs in the CoT.

---

## Attribute Mapping and Claim Transformation

One of the most complex aspects of federation deployments is mapping the identity provider's user attributes to what the service provider expects. OIF provides a configurable attribute mapping engine.

**Common mapping scenarios**:

| OAM/LDAP Attribute | SAML Claim Name | Cloud SP Expects |
|---|---|---|
| uid | email | User's email for account lookup |
| givenName | firstName | Display name |
| sn | lastName | Display name |
| memberOf | groups | Role-based access in SP |
| employeeNumber | employeeId | HR system correlation |
| department | department | Licensing tier or org unit |

**OAM attribute profile** (configured in federation partner settings):

\`\`\`
Assertion Type: Attribute Statement
Name Format: urn:oasis:names:tc:SAML:2.0:attrname-format:basic
Attribute Mappings:
  LDAP uid → SAML email
  LDAP givenName → SAML firstName
  LDAP sn → SAML lastName
  LDAP memberOf (multi-value) → SAML groups
\`\`\`

**NameID format selection**: The NameID is the primary identifier in the SAML assertion. Common formats:
- \`emailAddress\`: User's email address — most compatible with cloud SaaS
- \`transient\`: Opaque random ID — maximum privacy, no correlation across sessions
- \`persistent\`: Stable opaque ID — allows SP to link sessions without exposing the real username
- \`unspecified\`: Raw value (uid, sAMAccountName) — used when SP and IDP agree on format out of band

---

## WS-Federation and OpenID Connect

### WS-Federation 1.2

WS-Federation is used primarily for Microsoft ecosystem integration (SharePoint, ADFS-connected apps, older Microsoft 365 configurations). OIF implements the passive requester profile. The flow is similar to SAML but uses SOAP-based messaging and WS-Trust tokens.

### OpenID Connect (OIDC) in OAM 12c

OAM 12c includes a full OAuth 2.0 Authorization Server and OIDC Provider:
- Authorization endpoint: \`/oauth2/rest/authorize\`
- Token endpoint: \`/oauth2/rest/token\`
- UserInfo endpoint: \`/oauth2/rest/userinfo\`
- JWKS endpoint: \`/oauth2/rest/.well-known/jwks.json\`
- Discovery document: \`/oauth2/rest/.well-known/openid-configuration\`

OIDC is the preferred protocol for modern SaaS integrations and mobile applications. Unlike SAML (which is browser-redirect based), OIDC uses OAuth 2.0 bearer tokens — more suitable for REST APIs and native mobile clients.

---

## Certificate Management in Federation

Federation security depends entirely on certificate trust. The IDP signs assertions with its private key; the SP validates with the IDP's public certificate. Certificate expiry is one of the most common causes of federation failures in production.

**OIF signing certificate rotation procedure**:
1. Generate a new key pair and obtain a CA-signed certificate (or self-signed for dev)
2. In OAM Admin Console → Federation → Identity Provider → Certificates: add the new certificate as a secondary signing certificate (OIF supports dual certificates during rotation)
3. Update all SP partners: publish updated metadata URL; SPs that auto-refresh metadata will pick up the new cert; SPs with manually imported certs need a cert update from their admin
4. After all SPs have updated, remove the old certificate from OIF
5. Monitor: test an SP-initiated SSO login to each partner after rotation

**Certificate validity check** from the federation metadata endpoint:

\`\`\`bash
# Fetch OIF metadata and extract the signing certificate
curl -s "https://oam-host:14101/fed/idp/metadata" | \
  grep -oP '(?<=<ds:X509Certificate>)[^<]+' | \
  base64 -d | \
  openssl x509 -inform DER -noout -dates -subject
\`\`\`

---

## Single Logout (SLO)

Global logout in a federated environment must propagate across all SP sessions. SAML 2.0 defines the Single Logout profile:

1. User initiates logout from one SP or the IDP portal
2. The initiating party sends a LogoutRequest to the IDP (OAM/OIF)
3. OAM/OIF identifies all active SP sessions in the same Circle of Trust
4. OAM/OIF sends LogoutRequest messages to each SP
5. Each SP terminates its local session and returns a LogoutResponse
6. After all SPs respond (or timeout), OAM/OIF terminates the IDP session and redirects to a logout landing page

**Common SLO failure**: An SP is offline or slow to respond. OAM/OIF has a configurable SLO timeout — if an SP doesn't respond within the timeout, OAM/OIF proceeds with logout for the remaining SPs. This leaves an orphaned session on the non-responding SP, which is a minor security gap but preferable to blocking the entire logout.

---

## Integration with Oracle E-Business Suite

OAM/OIF can act as the IDP for Oracle EBS, allowing:
- External partner users to access EBS via a partner IDP (B2B scenario)
- EBS users to access external SaaS applications via OAM as the IDP (employees using Salesforce, Workday)
- Government/regulatory portal access using federated government credentials (e.g., PIV cards via a government IDP)

For B2B EBS access via federation:
1. Partner company's IDP authenticates the partner user
2. Partner IDP sends SAML assertion to OAM/OIF (OAM acts as SP)
3. OAM validates the assertion, maps the partner identity to an EBS FND_USER account or dynamically provisions one
4. OAM injects OAM_REMOTE_USER header for EBS SSO
5. EBS grants access based on the mapped FND_USER

---

## Monitoring and Diagnostic Queries

**Check federation session activity** (OAM database):

\`\`\`sql
-- Active federation sessions (OAM session store)
SELECT s.session_id,
       s.user_name,
       s.idp_entity_id,
       s.sp_entity_id,
       s.created_time,
       s.last_access_time,
       ROUND((SYSDATE - s.created_time) * 60, 0) AS age_minutes
FROM oam_fed_sessions s
WHERE s.created_time > SYSDATE - 1/24
ORDER BY s.created_time DESC
FETCH FIRST 20 ROWS ONLY;
\`\`\`

**Audit federation events** (OAM audit store):

\`\`\`sql
-- Failed SAML assertion validations in last hour
SELECT a.event_time,
       a.user_id,
       a.partner_id,
       a.event_type,
       a.failure_reason
FROM iau_common.iau_base a
WHERE a.event_type LIKE 'SAML%'
  AND a.outcome = 'FAILURE'
  AND a.event_time > SYSTIMESTAMP - INTERVAL '1' HOUR
ORDER BY a.event_time DESC;
\`\`\`

---

## Common Failure Patterns

### Pattern 1: "Audience restriction validation failed"

**Cause**: The SP entity ID in the SAML assertion doesn't match what the SP expects. Often caused by a typo in the partner configuration or a case-sensitivity mismatch (SAML entity IDs are case-sensitive).

**Fix**: Verify the SP entity ID in OIF's partner configuration exactly matches the SP's configured entity ID.

### Pattern 2: "Assertion expired" / "NotOnOrAfter in the past"

**Cause**: Clock skew between the IDP and SP exceeds the assertion's validity window (typically 5 minutes). SAML assertions have a tight validity window to prevent replay attacks.

**Fix**: Sync NTP on all servers (IDP, SP, any reverse proxies). Standard tolerance is ±5 minutes.

### Pattern 3: "Signature validation failed"

**Cause**: The signing certificate the SP has on file for this IDP doesn't match the certificate used to sign the assertion — the IDP certificate was rotated but the SP wasn't updated.

**Fix**: Re-import the IDP's metadata or certificate into the SP's configuration.

### Pattern 4: SLO leaves sessions on some SPs

**Cause**: SP's SLO endpoint is unreachable or returned an error during the global logout sequence.

**Fix**: Verify SP's SLO endpoint URL in the partner configuration; test the endpoint manually; increase the SLO timeout if the SP is slow.

---

## Summary

Oracle Identity Federation — embedded in OAM 12c or deployed as standalone OIF 11g — provides the standards-based SSO bridge between Oracle's enterprise identity infrastructure and the modern cloud-first application landscape. Its SAML 2.0 IDP role enables enterprise users to reach Salesforce, ServiceNow, and hundreds of other SaaS platforms with a single sign-on from their corporate credentials. Its SP role enables partner and cloud identities to access Oracle EBS and other enterprise applications without requiring shadow accounts.

Certificate management, attribute mapping, and Single Logout are the three operational areas that consume the most DBA and middleware administrator attention in a running federation deployment. The companion runbook provides step-by-step configuration procedures for OAM 12c embedded federation, including Salesforce and Azure AD partner setup, certificate rotation, and the most common troubleshooting workflows.`,
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
