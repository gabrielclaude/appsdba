import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Identity Federation (OIF) 12c: SAML 2.0, Circle of Trust, and Cross-Domain SSO',
  slug: 'oracle-identity-federation-oif-architecture-saml',
  excerpt:
    'A comprehensive guide to Oracle Identity Federation (OIF) 12c: SAML 2.0 and WS-Federation protocol architecture, IdP and SP roles, Circle of Trust, attribute mapping, federation with external partners (ADFS, Azure AD, Okta), OAuth 2.0 and OpenID Connect, and integration with OAM for enterprise cross-domain SSO.',
  category: 'identity-management' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-07'),
  youtubeUrl: null,
  content: `## Introduction

Oracle Identity Federation (OIF) is Oracle's standards-based federation server. It enables single sign-on across organisational boundaries — between enterprises, between an enterprise and cloud providers, and between Oracle applications and non-Oracle identity ecosystems. OIF speaks the federation protocols that allow a user authenticated in one organisation's identity system to be trusted by another organisation's applications without sharing credentials across the boundary.

In the context of the Oracle IAM stack, OIF sits alongside Oracle Access Manager (OAM) as a complementary SSO layer. OAM handles SSO within a single organisation's web tier — users authenticate once and access all OAM-protected applications. OIF extends that SSO across trust boundaries: a user authenticated by OAM at Company A can access a partner application at Company B, a SaaS application at Salesforce, or a Microsoft 365 tenant at Azure Active Directory, all within the same browser session and without re-entering credentials.

This post covers OIF's architecture, the federation protocols it supports, how SAML 2.0 assertions work end to end, the Circle of Trust concept, attribute mapping, and the most common deployment patterns for enterprise cross-domain SSO.

---

## Federation Protocols Supported by OIF

### SAML 2.0

Security Assertion Markup Language 2.0 (SAML 2.0) is the dominant enterprise federation standard. It defines an XML-based protocol for exchanging authentication and attribute assertions between an Identity Provider (IdP) and a Service Provider (SP).

OIF supports all four SAML 2.0 bindings:
- **HTTP-Redirect**: SAML messages encoded as URL query parameters (used for AuthnRequest)
- **HTTP-POST**: SAML messages as HTML form POST values (used for Response/Assertion)
- **HTTP-Artifact**: a short-lived reference token that the SP resolves to the full assertion via a direct IdP-to-SP back-channel call (artifact resolution service)
- **SOAP**: used for attribute queries, logout, and assertion queries over direct HTTP

OIF supports all three SAML 2.0 profiles:
- **Web Browser SSO Profile**: the standard browser-based SSO flow
- **Enhanced Client or Proxy (ECP)**: for non-browser clients (mobile apps, thick clients)
- **Identity Provider Discovery**: for multi-IdP deployments where the SP must discover which IdP to redirect to

### WS-Federation

WS-Federation (Web Services Federation) is Microsoft's federation protocol, used natively by Active Directory Federation Services (ADFS), SharePoint, and Microsoft 365 tenants before they adopted SAML. OIF's WS-Federation support enables Oracle-managed users to access Microsoft applications, and Microsoft AD users to access Oracle applications, without requiring either side to switch protocols.

WS-Federation uses Security Token Service (STS) endpoints rather than SAML metadata documents — OIF acts as an STS when federated with ADFS.

### OAuth 2.0 and OpenID Connect

OIF 12c includes an OAuth 2.0 Authorization Server and an OpenID Connect (OIDC) Provider. OIDC is the identity layer on top of OAuth 2.0 that modern applications use for SSO — it issues JSON Web Tokens (JWTs) instead of XML-based SAML assertions. Mobile applications, single-page apps (SPAs), and REST APIs use OIDC/OAuth rather than SAML.

OIF's OIDC endpoint enables Oracle-managed users to log in to OIDC Relying Parties (applications that support "Login with [IdP]") using their enterprise credentials. It also enables OIF to act as an OAuth 2.0 resource server — validating Bearer tokens issued by partner OAuth Authorization Servers.

---

## Identity Provider and Service Provider Roles

Every federation relationship has two roles:

**Identity Provider (IdP)**: The authoritative source of user identity. The IdP authenticates the user (typically via OAM or LDAP bind) and issues a signed assertion (SAML, JWT) that the SP can trust. The IdP is the "passport issuer" in the federation metaphor.

**Service Provider (SP)**: The application or service that the user is trying to access. The SP does not authenticate the user directly — it delegates authentication to the IdP and receives a signed assertion it can verify. The SP is the "border control" in the metaphor.

OIF can act as either an IdP or an SP, and in complex multi-party federations, it often acts as both simultaneously:
- OIF as **IdP**: Company A's users authenticate via OAM → OIF issues SAML assertions → Partner Company B's SP trusts and accepts them
- OIF as **SP**: Partner Company B's users authenticate via their own IdP → OIF acts as SP, validates the assertion → proxies the authenticated identity to OAM for local application access

This "hub and spoke" federation pattern — where OIF acts as a federation hub between many external IdPs and many internal SPs — is the most common enterprise OIF deployment.

---

## SAML 2.0 SSO: End-to-End Flow

Understanding the SAML 2.0 Web Browser SSO flow is essential for diagnosing federation failures.

### SP-Initiated SSO (Most Common)

1. **User accesses SP**: Browser requests \`https://partner-app.companyb.com/protected/resource\`
2. **SP detects no session**: The SP application (or its WebGate/OAM agent) finds no valid session for the user
3. **SP generates AuthnRequest**: The SP generates a SAML 2.0 \`<AuthnRequest>\` XML document, signs it with the SP's private key (optional but recommended), and base64-encodes it
4. **SP redirects to IdP**: Browser is redirected to the OIF IdP's SSO URL with the encoded AuthnRequest as a query parameter: \`https://oif.companya.com/fed/idp/sso?SAMLRequest=<encoded>&RelayState=<original_url>\`
5. **IdP authenticates user**: OIF receives the AuthnRequest, validates the SP's signature, and checks whether the user has an existing OAM session. If not, OIF redirects the user to OAM's login page. The user authenticates with OAM (username/password or MFA). OAM issues an OAM session cookie.
6. **OIF issues SAML Response**: OIF generates a SAML \`<Response>\` containing a \`<Assertion>\` with:
   - \`<Subject>\` — the user's identifier (NameID)
   - \`<AuthnStatement>\` — when and how the user authenticated
   - \`<AttributeStatement>\` — user attributes (email, groups, employee ID) as configured in the attribute mapping
   - Digital signature using OIF's IdP signing key
   - Validity window (NotBefore / NotOnOrAfter timestamps, typically ±5 minutes)
7. **IdP HTTP-POST to SP**: OIF posts the signed Response to the SP's Assertion Consumer Service (ACS) URL via an auto-submitted HTML form
8. **SP validates assertion**: The SP (or its SAML library) validates the assertion signature using OIF's IdP public certificate (obtained from OIF's SAML metadata), checks timestamps, verifies the Audience matches the SP's entity ID, and ensures the assertion is not replayed (reply attack prevention via assertion ID cache)
9. **SP creates local session**: The SP maps the SAML NameID or attributes to a local user account and creates an application session. The user is now logged in.

### IdP-Initiated SSO

In IdP-initiated SSO, the user starts at the IdP portal (not the SP). The IdP generates an unsolicited SAML Response — no AuthnRequest precedes it. The IdP knows which SP to target because the user selected it from a federated application catalogue. IdP-initiated SSO is simpler but less secure (no AuthnRequest means no SP-specified RelayState, and forged IdP-initiated SSO is a known attack vector). Most modern SPs support it but prefer SP-initiated.

---

## Circle of Trust

A Circle of Trust (CoT) in OIF is a set of federated partners that trust each other's identity assertions. CoT membership is established by exchanging SAML metadata documents — each partner publishes a metadata XML file containing their entity ID, public certificates, and endpoint URLs (SSO URL, SLO URL, ACS URL). OIF's admin console imports each partner's metadata and assigns them to a CoT.

All members of a CoT:
- Trust SAML assertions signed by any other CoT member
- Participate in Single Logout (SLO) when a user logs out — OIF propagates the logout to all SPs in the CoT that have active sessions for the user
- Share a consistent NameID format (persistent, transient, or email)

Practical CoT architecture in a large enterprise:
- **Internal CoT**: OIF + all internal Oracle applications that have their own SP agents (OBIEE, OAM-protected apps)
- **External CoT per partner**: A separate CoT for each external federation partner (CompanyB, Salesforce, Workday). Each external partner's trust is isolated — a breach of one partner's metadata does not affect other federation relationships.

---

## SAML Metadata

SAML metadata is the machine-readable configuration document that enables federation partners to establish trust without manual certificate exchange. OIF generates its IdP metadata automatically:

\`\`\`
https://oif.companya.com/fed/idp/metadata
\`\`\`

OIF's IdP metadata contains:
- **EntityDescriptor entityID**: OIF's unique identifier (typically a URL like \`https://oif.companya.com\`)
- **IDPSSODescriptor**: SAML bindings and SSO endpoint URLs (HTTP-Redirect, HTTP-POST, HTTP-Artifact)
- **SingleLogoutService**: SLO endpoint URLs for global logout
- **KeyDescriptor signing**: OIF's X.509 signing certificate (public key) — SPs use this to verify assertion signatures
- **KeyDescriptor encryption**: OIF's encryption certificate — SPs encrypt assertions to OIF with this key
- **NameIDFormat**: Supported NameID formats (persistent, transient, emailAddress, unspecified)

OIF similarly generates SP metadata at \`https://oif.companya.com/fed/sp/metadata\` when acting as an SP.

### Metadata Registration Workflow

1. Export OIF IdP metadata from OIF Admin Console and send to the partner SP administrator
2. Import partner SP metadata into OIF Admin Console → Federation → Partners → Import Metadata
3. Assign the partner to a Circle of Trust
4. Configure attribute mapping for the partner
5. Test SSO

For SaaS applications (Salesforce, ServiceNow, Workday), their SAML metadata is available from their admin console — import it into OIF the same way. These SaaS applications maintain static metadata (their certificates rarely change); OIF's certificate has a configurable validity period (typically 2–3 years) and must be rotated before expiry.

---

## NameID Formats

The NameID is the identifier in the SAML assertion that tells the SP who the authenticated user is. OIF supports several NameID formats:

**Persistent**: A permanent, opaque identifier unique to the IdP-SP pair. OIF generates a persistent NameID for each IdP-SP-user combination and stores it. The SP maps this opaque ID to a local account. Persistent NameIDs are privacy-preserving (no personal information exposed) and correlation-resistant (the same user gets different NameIDs for different SPs).

**Transient**: A temporary, one-time-use identifier generated fresh for each SSO session. No correlation between sessions is possible. Used when maximum privacy is required or when the SP just needs to know "a valid user authenticated" without a stable user identifier.

**emailAddress**: The user's email address is the NameID. Simple and universally understood, but exposes personal information and breaks when email addresses change. Common in SaaS integrations where the SaaS application uses email as the primary user identifier.

**Unspecified**: No format constraint. OIF sends whatever identifier is configured (often the LDAP uid). Works when IdP and SP have a pre-agreed identifier but it is not one of the standard formats.

For Oracle application integrations (EBS, OBIEE), unspecified or emailAddress NameID is typical since these applications identify users by login name or email. For external SaaS integrations, emailAddress is most common.

---

## Attribute Mapping

SAML assertions can carry user attributes beyond the NameID — email, department, job title, group memberships, employee number. The SP uses these attributes to make authorisation decisions or to pre-populate user profile data without querying a directory.

OIF attribute mapping defines:
1. **Source**: Which LDAP attribute from the user's OID/OUD entry to include (e.g., \`mail\`, \`departmentNumber\`, \`orclGroupMembership\`)
2. **Assertion attribute name**: What name the attribute has in the SAML assertion (e.g., \`Email\`, \`Department\`, \`Groups\`)
3. **Format**: Whether the attribute is a basic string, URI, or unspecified
4. **Per-partner**: Attribute mapping is configured per federation partner — Salesforce gets different attributes than a financial system SP

Example mapping for a Salesforce SP integration:
- LDAP \`mail\` → SAML attribute \`Email\`
- LDAP \`sn\` → SAML attribute \`LastName\`
- LDAP \`givenName\` → SAML attribute \`FirstName\`
- LDAP \`orclGroupMembership\` → SAML attribute \`Profile\` (mapped to Salesforce permission sets)

---

## Integration with Oracle Access Manager

OIF and OAM integrate at the authentication layer: OIF delegates authentication to OAM rather than implementing its own credential collection. The integration uses OAM's authentication API:

1. User arrives at OIF IdP SSO URL with an AuthnRequest
2. OIF checks whether the user has an active OAM session (reads the OAM SSO cookie)
3. If no OAM session: OIF redirects to OAM login page, OAM authenticates, issues OAM cookie, redirects back to OIF
4. If OAM session exists: OIF extracts the authenticated user identity from OAM's session API, skips re-authentication
5. OIF generates the SAML assertion with the authenticated identity and routes it to the SP

This integration means OIF respects OAM's MFA and step-up authentication configuration — if OAM required MFA for the login session, OIF's assertion reflects that authentication strength in the \`<AuthnContextClassRef>\` element. SPs that require a minimum authentication strength (SAML Authentication Context classes like \`PasswordProtectedTransport\` or \`TimeSyncToken\`) will accept or reject OIF's assertion based on this value.

---

## Federation with External Partners

### Microsoft ADFS / Azure AD

Federating OIF with ADFS or Azure AD is the most common enterprise federation scenario. The typical configuration:
- OIF acts as SP for Microsoft-authenticated users accessing Oracle applications
- OIF acts as IdP for Oracle-authenticated users accessing Microsoft applications (SharePoint, Exchange, Teams via SAML app registration)

Azure AD provides SAML metadata at its federation metadata endpoint. Import this into OIF as a trusted IdP. Configure attribute mapping to map Azure AD's \`http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name\` claim to OIF's NameID.

### Okta, PingFederate, Shibboleth

All major commercial and open-source federation servers support SAML 2.0 metadata exchange. The workflow is identical: export OIF's IdP metadata, import into the partner IdP; export the partner's metadata, import into OIF. Attribute mapping is configured per-partner to accommodate each partner's specific claim names and formats.

---

## Federation Certificate Management

OIF uses two types of certificates in SAML operations:

**Signing certificate**: OIF signs assertions and metadata with its private key. Partners use OIF's public certificate (in its metadata) to verify signatures. The signing certificate has a fixed validity period — when it expires, all partner SPs that trust OIF will reject its assertions. Certificate rotation requires:
1. Generating a new key pair in OIF
2. Updating OIF's metadata (new certificate appears in metadata)
3. All partner SPs re-importing OIF's updated metadata
4. Switching OIF to sign with the new key

The coordination requirement across all federation partners is the operationally difficult part. Certificate rotation with 60+ federation partners requires weeks of advance coordination. Set calendar alerts at 180 days, 90 days, and 30 days before expiry.

**Encryption certificate**: When SPs encrypt assertions to OIF (uncommon but possible), they use OIF's encryption public certificate. OIF decrypts with its private key.

---

## Single Logout (SLO)

SAML 2.0 defines a Single Logout (SLO) protocol that propagates a logout request from one CoT member to all others that have active sessions for the user. When a user clicks "Logout" on any application in the CoT:

1. The SP sends a SAML LogoutRequest to OIF's SLO endpoint
2. OIF invalidates the OAM session (via OAM API)
3. OIF sends LogoutRequest to all other SPs in the CoT that have sessions for this user
4. Each SP terminates its local session and returns a LogoutResponse
5. OIF returns a final LogoutResponse to the initiating SP

SLO is complex to implement reliably because: SP sessions may time out before SLO propagates; SPs may not implement SLO at all (SaaS vendors often don't); network errors mid-SLO leave orphan sessions. For most deployments, SLO works reliably for internal Oracle application federations but has gaps for external SaaS partners.

---

## Conclusion

Oracle Identity Federation 12c is the standards-based bridge between Oracle's internal IAM stack and external identity ecosystems. Its SAML 2.0 implementation enables enterprise cross-domain SSO with full metadata-based trust management, while its OAuth 2.0 / OIDC capabilities extend that reach to modern applications and APIs. The Circle of Trust model provides a structured way to manage multiple federation partnerships with appropriate isolation. Understanding NameID formats, attribute mapping, and certificate lifecycle management is the foundation for operating OIF reliably across a diverse partner landscape.

The companion runbook provides the step-by-step installation and configuration commands.`,
};

async function main() {
  console.log('Inserting OIF architecture post...');
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
