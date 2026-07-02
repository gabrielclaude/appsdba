import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Access Manager: Web SSO, Policy Enforcement, and Federation Architecture',
  slug: 'oracle-access-manager-implementation',
  excerpt:
    'A comprehensive guide to Oracle Access Manager (OAM) architecture: WebGate agents, policy stores, authentication schemes, authorization policies, SAML 2.0/OAuth 2.0/OIDC federation, Oracle EBS SSO integration, and high-availability Coherence session clustering for enterprise web access management.',
  category: 'identity-management' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-02'),
  youtubeUrl: null,
  content: `## Introduction

Oracle Access Manager (OAM) is Oracle's centralized web access management and single sign-on platform. Where Oracle Identity Governance controls who has access — provisioning and lifecycle — OAM controls how that access is enforced at runtime. It intercepts every HTTP request to protected resources, evaluates authentication and authorization policies, issues session tokens, and federates identity across organizational boundaries via SAML 2.0, OAuth 2.0, and OpenID Connect. For enterprises running Oracle EBS, SOA Suite, WebLogic applications, and cloud services, OAM is the runtime enforcement point that ties the entire identity ecosystem together.

---

## OAM Architecture

OAM is a multi-tier Java EE platform deployed on WebLogic Server. Understanding each component and how it communicates is essential before deploying or troubleshooting.

### Core Components

**OAM Server**

A Java EE application running on WebLogic 12.2.1.4 or later. The OAM Server is the brain of the system. It processes authentication and authorization requests forwarded by WebGates, evaluates policies stored in the policy store, and issues OAM session cookies and tokens. In a production deployment you run at least two OAM Server instances behind a load balancer.

**WebGate**

A native web server plugin (for Apache HTTP Server, Oracle HTTP Server, or Microsoft IIS) or a Java agent (WLS WebGate for WebLogic-hosted applications) installed on each protected application server. WebGate intercepts all HTTP and HTTPS requests before they reach the application. When a request arrives for a protected resource, WebGate communicates with the OAM Server over Oracle Access Protocol (OAP) on port 5575, or over HTTPS in Cert security mode, and enforces the policy decision it receives: allow, deny, or redirect to the login page.

**Policy Store**

An LDAP directory — Oracle Unified Directory (OUD) or Oracle Internet Directory (OID) are recommended — that stores authentication schemes, authorization policies, host identifiers, application domains, and resource definitions. In OAM 12c the policy store is managed via the OAM Admin Console and the configuration lives in LDAP under \`cn=OAMConfig\`. The policy store can alternatively be a database, but LDAP is the standard for new deployments.

**Identity Store**

A separate LDAP directory where user attributes, group memberships, and credentials are held. OAM queries this directory for every authentication attempt and for attribute retrieval during authorization evaluation. Supported directories include Oracle Unified Directory, Oracle Internet Directory, Microsoft Active Directory, and any LDAP v3 compliant directory. Multiple identity stores can be registered and used by different authentication schemes.

**Credential Store Framework (CSF)**

The Oracle Wallet or JCEKS keystore that holds passwords and cryptographic keys used by OAM: the keystore password, the cookie encryption key, and the OAP communication certificate. The CSF is managed by the Oracle Platform Security Services (OPSS) layer within WebLogic.

**Admin Server and OAM Admin Console**

The WebLogic Admin Server hosts the OAM Administration Console at \`/oamconsole\`. This browser-based UI is used for policy management, WebGate registration, identity store configuration, federation partner setup, and diagnostics. Enterprise Manager (EM) is also available for JVM-level monitoring of the OAM managed servers.

**OAM Coherence Cluster**

OAM Server nodes form an Oracle Coherence distributed cache cluster for session replication in active-active high-availability deployments. Session state is stored in the Coherence cluster so that any OAM node can validate any session cookie — no sticky sessions are required at the load balancer. The Coherence cluster forms automatically when two or more OAM nodes are configured in the same WebLogic cluster.

### Architecture Diagram

\`\`\`
Browser / Client
      |
      | HTTP/HTTPS
      v
[WebGate on OHS/Apache/WLS]
      |                   \\
  Intercept              OAP (port 5575)
  request                    |
      |                      v
      |              [OAM Server Cluster]
      |              [Node 1] [Node 2]
      |                  |        |
      |           [Coherence Session Replication]
      |                  |
      |          +-----------------+
      |          | Identity Store  | (OUD/OID/AD)
      |          | Policy Store    | (LDAP)
      |          | Credential Store| (CSF/Wallet)
      |          +-----------------+
      |
  Allow/Deny/
  Redirect to login
\`\`\`

---

## Authentication Schemes and Modules

OAM uses a layered model: **Authentication Scheme → Authentication Module → Authentication Plugin/Step**. An Authentication Scheme defines the challenge mechanism and protection level. Each scheme references one or more Authentication Modules that implement the actual credential validation logic.

### Built-in Authentication Schemes

OAM ships with several built-in schemes ordered by assurance level:

**Basic**: HTTP Basic Auth. The browser prompts for credentials using the native browser dialog. Suitable only for internal tools where a polished login UI is not required. Credentials are sent in the Authorization header (Base64-encoded).

**Form-based**: OAM presents an HTML login form, either hosted by OAM itself (at \`/oam/server/obrareq.cgi\`) or a custom form on the application server. This is the most common scheme for enterprise web applications. After the user submits the form, OAM validates credentials against the identity store and issues the session cookie.

**X509**: Client certificate authentication. The browser (or device) presents a PKI certificate during the TLS handshake. OAM extracts the subject DN from the certificate and maps it to a directory user. Used for smartcard (CAC/PIV) access or mutual TLS device authentication.

**Kerberos**: Integrated Windows Authentication (IWA). When a user is already authenticated to an Active Directory domain, their browser automatically presents a Kerberos service ticket to OAM. The user sees no login prompt — authentication is transparent. This is the preferred scheme for internal enterprise users on Windows domain-joined machines.

**TAP (Token Auth Plugin)**: Validates a cryptographically signed token passed as an HTTP header or request parameter. Used primarily for Oracle EBS integrated SSO where a trusted intermediary (like Oracle Single Sign-On in legacy deployments) vouches for the user's identity.

**SAML 2.0 IDP-initiated / SP-initiated**: Federated login where OAM acts as the Identity Provider or Service Provider. Used for cross-domain SSO with cloud SaaS applications or partner organizations.

**OAuth 2.0 / OpenID Connect**: OAM 12c ships a full OAuth Authorization Server and OpenID Connect Provider, enabling token-based authentication for REST APIs and mobile applications.

### Multi-Step Authentication

OAM 12c supports chaining multiple authentication modules into a flow — for example, validating a password first, then requiring a one-time password (TOTP or SMS OTP) for step-up authentication to high-value resources. This is configured as an Authentication Flow in the Admin Console, where you define steps, success/failure transitions, and the overall result.

### LDAP Authentication Module

The most commonly deployed module. OAM binds to the identity store using the user's credentials to verify them. Key configuration parameters:

- LDAP bind DN and credential (stored in CSF automatically on save)
- User search base DN (e.g., \`ou=People,dc=example,dc=com\`)
- User search filter — typically \`uid={username}\` for OUD/OID or \`sAMAccountName={username}\` for Active Directory
- Group search base (used for group-based authorization conditions)

---

## Authorization Policies

After a user authenticates, OAM evaluates Authorization Policies to decide whether to permit or deny access to the specific resource requested.

### Policy Evaluation Order

1. The request arrives at WebGate.
2. WebGate extracts the host, port, and URL path.
3. OAM matches the request to an Application Domain via the **Host Identifier** (a logical grouping of host/port combinations).
4. Within the domain, OAM matches the resource URL against defined **Resource** patterns (supports wildcards and regular expressions).
5. OAM evaluates the **Authentication Policy** attached to the resource — this determines which authentication scheme to apply if the user is not yet authenticated.
6. After successful authentication, OAM evaluates the **Authorization Policy** — this contains allow/deny conditions based on identity attributes, group membership, IP address, and time.
7. OAM issues a session cookie (\`OAMAuthnCookie\`) and optionally injects HTTP response headers with user attributes before WebGate forwards the request to the application.

### Authorization Conditions

OAM authorization conditions support a rich set of predicates:

**Identity conditions**: LDAP group membership — for example, \`member of CN=AppAdmins,OU=Groups,DC=example,DC=com\`. Group membership is evaluated at policy check time against the identity store, not cached in the session.

**Attribute conditions**: LDAP attribute values on the user object — \`department=Finance\`, \`employeeType!=contractor\`. Any attribute retrievable from the identity store can be used.

**Temporal conditions**: Restrict access by time-of-day or day-of-week — for example, deny access to the payroll application between midnight and 6 AM or on weekends.

**IP conditions**: Restrict access to specific source IP ranges. Useful for ensuring that administrator interfaces are only reachable from the corporate network or a jump host.

**Composite conditions**: Combine the above with AND, OR, and NOT logic to build complex access rules, such as "allow if (group=Finance AND department=Accounting) OR IP=10.10.0.0/24".

### Response Actions

After a successful authorization decision, OAM can inject information into the request before it reaches the application. **Response Header** actions add HTTP headers containing user attributes. **Response Cookie** actions set cookies. This is how OAM integrates with applications that do not natively speak SAML or OIDC — the application simply reads a trusted HTTP header that OAM has populated.

---

## Session Management

### OAM Session Architecture

The **OAMAuthnCookie** is an encrypted, domain-scoped HTTP cookie. Its value is an opaque token that references a server-side session stored in the Coherence distributed cache. When WebGate receives a request with this cookie, it sends the token to OAM over OAP. OAM looks up the session in Coherence, validates that it has not expired, and returns the authorization decision. Because the session is in Coherence — shared across all nodes — any OAM server in the cluster can validate any cookie.

### Session Lifetime

Session lifetime is configured per Authentication Scheme:

- **Idle timeout**: The session expires if there is no activity for this period (default 8 hours / 480 minutes). Every validated request resets the idle timer.
- **Max session duration**: An absolute ceiling on session lifetime regardless of activity (default 24 hours / 1440 minutes). After this the user must re-authenticate.

Both values are configurable without restarting OAM.

### Global Logout

When a user logs out from any protected application, OAM invalidates the entire SSO session — not just the session for that one application. Applications register logout callback URLs with OAM. When the session is invalidated, OAM sends HTTP GET requests to each registered logout URL so that the application can clear its own local session state. For EBS, this is the EBS logout servlet URL.

### Session Persistence in HA

In a multi-node OAM cluster, Coherence handles session replication automatically. There is no requirement for sticky sessions at the load balancer. If one OAM node fails, the surviving nodes already hold all session data and continue serving requests without interruption. The only session data that is lost is the local in-memory cache on the failed node, which Coherence repopulates from the replicated copy on the surviving nodes.

---

## Federation: SAML 2.0, OAuth 2.0, and OpenID Connect

### SAML 2.0 — OAM as Identity Provider

In this topology, OAM is the authoritative identity source. Enterprise users authenticate to OAM once, and cloud SaaS applications — Salesforce, ServiceNow, Workday, and others — accept SAML 2.0 assertions from OAM without requiring a separate login.

Configuration in OAM:
1. Create an SP Partner profile with the Service Provider's EntityID, Assertion Consumer Service (ACS) URL, signing certificate, and attribute mapping.
2. OAM signs the SAML assertion with its private key. The SP validates the signature using OAM's public certificate, which is distributed via the OAM federation metadata URL.
3. Attribute mapping defines which LDAP attributes OAM includes in the assertion — commonly NameID (mapped to \`uid\`), email, department, and group memberships.

### SAML 2.0 — OAM as Service Provider

OAM can delegate authentication to an external IDP — ADFS, Azure AD, Okta, PingFederate. The user's browser is redirected to the external IDP, which authenticates the user and posts a SAML assertion back to OAM's ACS endpoint. OAM validates the assertion, maps the asserted identity to a local user in its identity store, and establishes an OAM session. This topology is used when Oracle applications need to trust identity from a parent organization or business partner.

### OAuth 2.0 and OpenID Connect

OAM 12c includes a full OAuth 2.0 Authorization Server and OpenID Connect Provider. Key endpoints:

- Token endpoint: \`/oauth2/rest/token\` — clients exchange credentials or authorization codes for access tokens
- Token introspection: \`/oauth2/rest/token/info\` — resource servers validate access tokens
- Authorization endpoint: \`/oauth2/rest/authorize\` — for authorization code and implicit flows
- OIDC Discovery: \`/.well-known/openid-configuration\` — publishes all endpoint URLs and supported capabilities

Client types supported:
- **Confidential clients**: Server-side applications with a client secret (web apps, APIs)
- **Public clients**: Mobile and single-page applications using PKCE

Scopes control what the token grants access to. ID tokens (OIDC) carry user identity claims: \`sub\`, \`email\`, \`name\`, and any custom claims mapped from LDAP attributes.

---

## Integration with Oracle EBS

OAM and Oracle E-Business Suite SSO integration is one of the most common OAM deployment scenarios. The integration works through OAM injecting an HTTP header that EBS trusts as proof of authentication.

### Integration Flow

1. WebGate is installed on the Oracle HTTP Server (OHS) instance that fronts EBS.
2. OAM protects the EBS login URL: \`/OA_HTML/AppsLogin\` and optionally the entire \`/OA_HTML/\` space.
3. When an unauthenticated user requests an EBS URL, WebGate intercepts the request and redirects to the OAM login page.
4. OAM authenticates the user against the LDAP identity store (or via Kerberos for Windows domain users).
5. After successful authentication, OAM evaluates the authorization policy and injects the HTTP header \`OAM_REMOTE_USER\` with the user's login name.
6. WebGate forwards the request to OHS/EBS with this header set.
7. EBS reads \`OAM_REMOTE_USER\` and logs the user in without a password prompt, bypassing its own credential validation.
8. **Critical**: The value in \`OAM_REMOTE_USER\` must exactly match \`FND_USER.USER_NAME\` in the EBS database — typically all uppercase, e.g., \`JSMITH\`.

### Global Logout for EBS

The EBS logout URL must be registered with OAM as a logout callback. When the user logs out from EBS, OAM invalidates the session and calls all registered logout URLs. Without this, the OAM session remains active even after the user logs out of EBS, creating a security gap.

### Common Integration Failure: Full DN in OAM_REMOTE_USER

**Symptom**: User authenticates in OAM but EBS shows "FRM-92101: There was a failure in the Forms Server" or the user is logged in as the wrong account.

**Root cause**: The OAM response header action is sending the full LDAP distinguished name — \`CN=jsmith,OU=Users,DC=example,DC=com\` — instead of just the login attribute \`jsmith\`.

**Fix**: Edit the Authorization Policy response header action. Change the Value from \`\${user.dn}\` to \`\${user.attr.uid}\` (for OUD/OID) or \`\${user.attr.sAMAccountName}\` (for Active Directory). Save and test.

---

## High Availability Architecture

### Active-Active OAM Cluster

In a production environment, OAM runs as a WebLogic cluster with at least two managed server nodes behind a hardware or software load balancer. Because Coherence handles session state, the load balancer does not need to maintain session affinity (sticky sessions). Any node in the cluster can serve any request.

**Recommended topology**:

\`\`\`
[LB VIP: oam.example.com:443]
        |           |
[OAM Node 1]  [OAM Node 2]
        |           |
[Coherence Cluster - session replication]
        |           |
[Identity Store: OUD Active-Passive]
\`\`\`

**Load balancer health check**: HTTP GET to \`/oam/server/logout?end_url=http://health\`. A healthy OAM server returns HTTP 302. If the server is down or starting up, the connection is refused.

**WebGate failover**: WebGate is configured with a primary OAM Server address and one or more secondary addresses. If the primary OAM node becomes unreachable, WebGate automatically fails over to a secondary without requiring a configuration change.

### Identity Store HA

The identity store (OUD or OID) should be deployed in Active-Passive or Active-Active replication with an LDAP load balancer (or virtual IP) in front. OAM connects to the LDAP VIP, so a failover of the directory tier is transparent to OAM.

---

## Key Diagnostic Queries and Logs

### OAM Diagnostic Log

The primary OAM log is:

\`\`\`
\${DOMAIN_HOME}/servers/oam_server1/logs/oam_server1-diagnostic.log
\`\`\`

To enable debug logging: OAM Admin Console → System Configuration → Common Configuration → Log Level → DEBUG. Use this sparingly in production — debug logging produces very high volume output and can impact performance.

### Check Active Sessions via REST

\`\`\`bash
# OAM 12c REST API to query sessions for a specific user
curl -u oamadmin:password \\
  "http://oam-host:14100/oam/services/rest/ssa/api/v1/admin/sessions?userId=jsmith"
\`\`\`

### WebGate Connectivity Test

\`\`\`bash
# Test TCP connectivity to the OAP port on the OAM Server
telnet oam-server1.example.com 5575

# Check that the WebGate logout URL is reachable (OHS must be running)
curl -v http://ohs-host/oam_logout_success
\`\`\`

### OAM Server Health Check

\`\`\`bash
# HTTP 302 = healthy; connection refused = server down or starting
curl -s http://oam-server1:14100/oam/server/logout?end_url=http://test
\`\`\`

---

## Common Issues and Diagnosis

### Issue 1: "Authentication Failed" Despite Correct Password

Check the OAM diagnostic log for entries containing "LDAP bind failed". Common root causes:
- The LDAP bind DN or credential stored in the LDAP Authentication Module is wrong (or the bind account password has expired)
- The user search filter returns zero results or multiple results — OAM requires exactly one match
- The user account is locked in the directory (check \`pwdAccountLocked\` or \`shadowExpire\` attributes)

To test the bind independently: run \`ldapsearch\` from the OAM server host using the same bind DN, credential, and search filter. If \`ldapsearch\` fails, the issue is in the directory, not OAM.

### Issue 2: SSO Cookie Not Propagating Across Subdomains

The OAM session cookie domain is configured as \`.example.com\` but applications are on \`app.sub.example.com\`. Browser cookie scope rules prevent the cookie from being sent to a different subdomain level.

Fix: Either expand the OAM cookie domain to cover the full subdomain hierarchy, or add the specific subdomain to the OAM cookie domain list in System Configuration → Access Manager → Cookie Settings.

### Issue 3: WebGate Returns "Access Denied" for Authenticated Users

The user is authenticated (the OAM cookie is valid) but the authorization policy condition is returning Deny. Steps to diagnose:
1. Check the user's group memberships in the identity store — confirm they are in the LDAP group required by the authorization condition.
2. Enable WebGate debug mode: add the request header \`oam_debug: 1\` and inspect the response headers for the policy decision trace.
3. Review the authorization policy in OAM Admin Console — verify the condition logic, especially AND/OR precedence in composite conditions.

### Issue 4: OAM Coherence Split-Brain (Cluster Partition)

**Symptom**: Valid sessions are intermittently rejected with "Invalid Session Token" or users are forced to re-authenticate unexpectedly.

**Cause**: A network partition between OAM cluster nodes caused the Coherence cluster to split. Each partition has an incomplete view of the session cache. A session created on one partition is invisible to the other.

**Fix**: Identify the isolated OAM node (check Coherence cluster membership logs for "MemberLeft" or "MemberJoined" events), then restart that node gracefully. It will rejoin the primary partition. Also review the Coherence network configuration — multicast must be reachable between all OAM nodes, or unicast well-known addresses must be correctly configured if multicast is not available on your network.

---

## Summary

Oracle Access Manager is the runtime enforcement layer of the Oracle Identity Management stack. Its WebGate plugin intercepts every HTTP request before it reaches the protected application. Its policy engine evaluates authentication and authorization rules in milliseconds, consulting the LDAP identity store for credentials and group memberships. Its Coherence-backed session store provides the SSO infrastructure that spans all protected applications — once a user authenticates, no application in the SSO domain needs to challenge them again until the session expires.

For DBAs and middleware administrators, the core operational skills are:

- **Policy management**: defining Application Domains, resources, authentication schemes, and authorization conditions correctly in the OAM Admin Console
- **WebGate registration and troubleshooting**: deploying WebGate artifacts, configuring OAP connectivity, and diagnosing connectivity failures on port 5575
- **Session and cookie debugging**: understanding the OAMAuthnCookie scope, lifetime, and Coherence replication behavior
- **Identity store connectivity**: LDAP bind credentials, search filter correctness, and directory HA — because every authentication decision depends on a successful LDAP operation
- **Federation**: configuring SAML SP partners for cloud SaaS and OAuth clients for modern API and mobile integration

OAM is not a simple product, but its architecture follows a consistent pattern: intercept at the web tier, evaluate policy centrally, replicate session state across the cluster, and delegate identity resolution to LDAP. Mastering each layer gives you the diagnostic framework to resolve almost any OAM issue systematically.
`,
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
