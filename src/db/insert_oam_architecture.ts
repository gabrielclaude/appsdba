import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Access Manager (OAM) 12c: Architecture, SSO, and WebGate Integration',
  slug: 'oracle-access-manager-oam-architecture-sso',
  excerpt:
    'A deep-dive into Oracle Access Manager 12c architecture: the OAM Server, WebGate agent, Policy Manager, and LDAP identity store. Covers SSO token lifecycle, authentication policies, authorisation policies, resource protection, OHS/Apache WebGate deployment, and integration with Oracle Internet Directory and Oracle Unified Directory.',
  category: 'identity-management' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-07'),
  youtubeUrl: null,
  content: `## Introduction

Oracle Access Manager (OAM) 12c is Oracle's enterprise single sign-on (SSO) and web access management platform. It sits at the boundary between unauthenticated user traffic and protected web applications, providing centralised authentication, authorisation, and session management for any HTTP-accessible resource in the enterprise. OAM is the access management component of Oracle Identity and Access Management (IAM) Suite, and in production deployments it is almost always paired with Oracle Internet Directory (OID) or Oracle Unified Directory (OUD) as the identity store, and Oracle Identity Manager (OIM) as the provisioning engine.

OAM's core promise is that users authenticate once — providing username, password, and optionally a second factor — and receive an SSO token (the OAM cookie) that grants transparent access to all protected applications without repeated credential prompts. For enterprises running Oracle E-Business Suite, Oracle OBIEE, Oracle SOA Suite, or any custom Java EE or .NET application behind Apache/OHS, OAM provides the web tier security layer without modifying the application itself.

This post covers the OAM 12c architecture, how SSO works end-to-end, WebGate deployment models, authentication and authorisation policies, and integration with the identity store tier.

---

## OAM 12c Architecture Components

### OAM Server

The OAM Server is a Java EE application deployed on WebLogic Server. It is the policy decision point (PDP) — it receives authentication and authorisation requests from WebGate agents, evaluates them against configured policies, and returns access decisions. The OAM Server has two administrative roles:

- **OAM Admin Server**: The WebLogic Administration Server hosts the OAM administration console (policy management, WebGate registration, system configuration).
- **OAM Managed Server**: One or more OAM Managed Servers handle runtime authentication and authorisation requests. In high-availability deployments, multiple Managed Servers sit behind a hardware load balancer.

OAM stores its policy configuration in an LDAP directory (OID or OUD) or a database (Oracle DB via JDBC). The policy store choice is made at installation — LDAP is typical for colocated OAM+OID deployments; database is used when OIM integration requires a shared policy store.

The OAM Server listens on two ports:
- **Admin port** (typically 7001): WebLogic Console and OAM Admin Console
- **OAP port** (typically 5575): OAP protocol communication with WebGate agents

### WebGate

WebGate is the policy enforcement point (PEP). It is a plug-in installed into Oracle HTTP Server (OHS/Apache) or IIS that intercepts every inbound HTTP request before it reaches the protected application. WebGate communicates with the OAM Server over the Oracle Access Protocol (OAP) — a proprietary binary protocol that carries authentication and authorisation requests between WebGate and OAM.

WebGate operates in two modes:
- **Embedded credential collector (ECC)**: WebGate redirects unauthenticated requests to the OAM login page hosted on OAM Server itself (typically \`/oam/server/auth_cred_submit\`). The credential never touches the WebGate host.
- **Detached credential collector (DCC)**: WebGate hosts the login page itself. Credentials are collected at the WebGate OHS and passed securely to OAM Server. DCC is preferred for environments where the OAM Server URL must not be exposed to end users, and for custom login page requirements.

Each WebGate registration in OAM has an access client profile: password, access client type (OHS 11g, OHS 12c, Apache, IIS), preferred host, and communication key (a shared secret used to encrypt OAP traffic).

### Identity Store

OAM requires an LDAP directory as the identity store — the authoritative source for user accounts, credentials, and group memberships used in policy evaluation. Supported identity stores:

- **Oracle Internet Directory (OID)**: Oracle's mature LDAP server, typically colocated with OAM in legacy IAM deployments
- **Oracle Unified Directory (OUD)**: Oracle's modern LDAP server (no Oracle DB dependency), preferred for new deployments
- **Microsoft Active Directory**: Supported via the LDAP connector; common in mixed Oracle/Microsoft environments
- **Oracle Directory Server Enterprise Edition (ODSEE)**: Supported but being phased out

OAM connects to the identity store via LDAP to bind and authenticate user credentials, retrieve user profile attributes for policy evaluation (department, role, employee type), and resolve group memberships for group-based authorisation policies.

### Policy Store

OAM's policy store holds authentication schemes, authentication policies, authorisation policies, and resource definitions. The policy store can be:
- **Oracle Internet Directory (LDAP)**: Policy objects are stored as LDAP entries under a dedicated DIT branch
- **Oracle Database**: Policies stored in database tables via JDBC; required when OAM and OIM share a common domain

### Session Store

OAM Server stores active user sessions in a distributed coherence cache (Oracle Coherence). Session data includes the authenticated user identity, session creation time, last access time, and the set of applications accessed in the current SSO session. Coherence replicates session state across all OAM Managed Server nodes, enabling any OAM node to validate a session token originally issued by a different node — the foundation of stateless load balancing for OAM.

---

## SSO Token Lifecycle

Understanding how OAM handles a first-time authentication request and subsequent SSO requests is essential for diagnosing access failures.

### First Access (Unauthenticated User)

1. User browser requests \`https://app.example.com/protected/page\`
2. WebGate on the OHS in front of \`app.example.com\` intercepts the request
3. WebGate queries OAM Server (OAP): "Is this resource protected? Is this user authenticated?"
4. OAM Server: resource is protected by the "HR Applications" policy. User has no OAM session cookie — not authenticated.
5. OAM Server returns: DENY + redirect to login URL
6. WebGate sets a cookie indicating the originally-requested URL (\`TARGET\` parameter) and redirects the browser to the OAM login page
7. User submits username/password on the OAM login page
8. OAM Server validates credentials against the identity store (LDAP bind)
9. On success, OAM Server creates a session, stores it in Coherence, and sets the OAM SSO cookie (\`OAMAuthnCookie\` or custom-named cookie) in the browser
10. OAM Server redirects the browser back to the original \`TARGET\` URL
11. WebGate intercepts the request again, now sees the OAM SSO cookie
12. WebGate queries OAM Server: "Validate this session token for this resource"
13. OAM Server validates the session in Coherence, evaluates the authorisation policy, returns ALLOW
14. WebGate forwards the request to the backend application, optionally injecting HTTP header variables (user identity, groups, email) from the user's LDAP profile

### Subsequent SSO Access (Authenticated User)

When the same user (with a valid OAM SSO cookie) accesses a different protected application:

1. WebGate on the second application's OHS intercepts the request
2. WebGate queries OAM Server: validate the session cookie
3. OAM Server finds the session in Coherence — no re-authentication required
4. OAM Server evaluates the authorisation policy for the new resource — ALLOW
5. WebGate forwards the request with injected headers
6. User accesses the second application without any credential prompt — this is SSO

The OAM SSO cookie is domain-scoped. All applications under \`.example.com\` share the SSO cookie. Applications on different domains (e.g., partner portals at \`partner-app.com\`) require federation (SAML 2.0 or OAuth) — OAM supports both as the identity provider.

### Session Expiry and Logout

OAM sessions have two timeouts:
- **Idle timeout**: session invalidated if no resource is accessed within N minutes (configurable per application domain, default 30 minutes)
- **Max session lifetime**: absolute session expiry regardless of activity (default 8 hours)

Global logout (OAM's federated logout) invalidates the session in Coherence and clears the SSO cookie. Applications that maintain their own session cookies (HTTP session or application-level cookie) must be configured to participate in OAM's logout flow to avoid stranded application sessions after SSO logout.

---

## Authentication Schemes

An authentication scheme defines how OAM authenticates a user. OAM ships with several built-in schemes:

| Scheme | Description | Use Case |
|---|---|---|
| BasicScheme | HTTP Basic Authentication | API endpoints, legacy apps |
| FormScheme | HTML form login page | Default for web SSO |
| LDAPScheme | LDAP bind only | Internal tools |
| X509Scheme | Certificate-based auth | High-security environments |
| KerberosScheme | Windows Integrated Auth | Corporate intranet, IE/Edge |
| OAuthScheme | OAuth 2.0 / OIDC token | Modern web apps, mobile |
| MFAScheme | Multi-factor (TOTP, SMS) | Privileged access, admin UIs |

Authentication schemes have a **challenge method** (how credentials are collected) and a **challenge redirect** URL (where to redirect unauthenticated users). Schemes also have a **level** (1–5 numeric priority): a higher-level scheme is considered stronger than a lower-level scheme. OAM uses scheme levels to determine whether an existing session is strong enough for a given resource — if a user authenticated at level 2 (form login) tries to access a resource requiring level 3 (MFA), OAM step-up authenticates them.

---

## Policies: Resources, Authentication, and Authorisation

### Application Domains

An Application Domain is the top-level policy container in OAM. It groups resources (URLs), authentication policies, and authorisation policies for one or more related applications. Best practice: one Application Domain per application or per logical group of applications that share a WebGate and SSO requirements.

### Resource Definitions

Resources in OAM are URL patterns that define what is protected. Resources have:
- **Resource type**: HTTP
- **Host Identifier**: the virtual host name (matched against the HTTP Host header)
- **Resource URL**: path pattern, e.g., \`/hrms/**\`, \`/finance/reports/*.jsp\`, \`/public/**\` (excluded)

Resources can be **protected** (require authentication+authorisation), **excluded** (always allowed, no authentication), or **public** (no OAM processing at all).

### Authentication Policies

An authentication policy maps resources to an authentication scheme. Example:
- \`/hrms/admin/**\` → MFAScheme (level 3)
- \`/hrms/**\` → FormScheme (level 2)
- \`/hrms/public/**\` → Anonymous (level 0, excluded)

When a request matches multiple patterns, OAM selects the most specific matching policy.

### Authorisation Policies

Authorisation policies define conditions under which an authenticated user is allowed or denied access to a resource. Conditions can use:
- **Identity conditions**: user is member of group "HR-Managers", user attribute \`department=HR\`, user attribute \`employeeType=FTE\`
- **Temporal conditions**: access only Monday–Friday, 08:00–18:00
- **IP conditions**: access only from IP range 10.0.0.0/8

Authorisation policies also define **response** actions — HTTP header variables to inject into the forwarded request:
\`\`\`
Header: OAM_REMOTE_USER = \${user.attr.uid}
Header: OAM_GROUPS = \${user.attr.groupMembership}
Header: OAM_EMAIL = \${user.attr.mail}
\`\`\`
Applications use these injected headers as the authenticated user identity — this is how EBS (\`APPS_REMOTE_USER\`), OBIEE (\`OAM_REMOTE_USER\`), and custom Java EE applications receive the authenticated username from OAM without managing authentication themselves.

---

## WebGate Deployment Models

### Colocated WebGate (OHS on Application Server)

In this model, OHS with WebGate runs on the same host as the application server. Requests flow: Browser → OHS+WebGate (port 443) → App Server (port 8080 or AJP). Simple to deploy; OHS and the application restart together.

### Standalone WebGate (DMZ Proxy)

OHS with WebGate runs in the DMZ as a reverse proxy. The application server sits on an internal network with no direct external access. This is the recommended architecture for EBS, OBIEE, and other Oracle products:

\`\`\`
Internet → [Firewall] → OHS+WebGate (DMZ) → [Firewall] → App Server (internal)
                              ↕ OAP port 5575
                         OAM Server (internal)
\`\`\`

The DMZ OHS never passes unauthenticated requests to the application tier. The OAP connection (WebGate → OAM Server) crosses the internal firewall on port 5575.

### Multiple WebGate Instances for HA

In high-availability deployments, two or more OHS+WebGate instances sit behind a hardware load balancer. Each WebGate instance uses the same WebGate registration and shared secret from OAM. The OAM SSO cookie is domain-scoped and session data is in Coherence — any OHS instance can serve any authenticated request without affinity.

---

## Integration with Oracle E-Business Suite

EBS 12.2 integrates with OAM via the EBS AccessGate and the OAM WebGate on the OHS tier. The integration flow:

1. OAM authenticates the user
2. OAM injects \`OAM_REMOTE_USER\` header with the authenticated LDAP uid
3. EBS OHS (mod_oc4j or mod_wl_ohs) forwards the request to EBS with the header
4. EBS AccessGate reads \`OAM_REMOTE_USER\`, looks up the corresponding EBS user account, and creates an EBS session

EBS user accounts must be linked to LDAP accounts (uid matching) via Oracle Directory Integration Platform (DIP) or manual provisioning. When OIM is deployed, OIM provisions EBS accounts automatically and maintains the LDAP-EBS linkage.

---

## High Availability Architecture

A production OAM deployment requires:
- Minimum 2 OAM Managed Server instances (active/active via load balancer)
- Coherence cluster spanning all OAM nodes for session replication
- Redundant LDAP identity store (OID/OUD with master/replica or multi-master)
- Redundant WebGate OHS instances behind hardware LB
- OAP firewall rule: WebGate hosts → OAM Managed Server hosts on port 5575

OAM failover is transparent to users — if one OAM Managed Server fails, the load balancer routes OAP requests to the remaining node. Sessions stored in Coherence survive individual OAM node failure.

---

## Common Failure Modes

**OAP connection refused (WebGate cannot reach OAM)**: Check firewall on port 5575 between WebGate host and OAM Managed Server. Check OAM Managed Server is running. Check WebGate registration in OAM Admin Console — agent password may have been rotated.

**"Access Denied" for authenticated user**: The authorisation policy condition is not met (group membership, IP condition, time condition). Check OAM audit log at \`\${DOMAIN_HOME}/servers/oam_server1/logs/\` for the policy evaluation result.

**SSO cookie not propagating across applications**: Cookie domain mismatch. The OAM SSO cookie domain must match the domain of all applications that need SSO. If apps are on \`hr.example.com\` and \`finance.example.com\`, the cookie domain must be \`.example.com\`.

**Session lost after OAM restart**: Coherence session store configuration issue — Coherence cluster membership is not surviving OAM restart. Check Coherence multicast/unicast configuration and network multicast availability.

**Step-up authentication loop**: A user authenticated at level 2 is being redirected to a level-3 scheme, completes MFA, but is still redirected. Usually caused by an incorrect scheme level assignment — verify the authentication scheme level in OAM Admin Console matches the policy requirement.

---

## Conclusion

Oracle Access Manager 12c provides centralised SSO and web access management for heterogeneous Oracle and non-Oracle application portfolios. Its strength is policy-driven, externalised access control — applications do not need to implement authentication or authorisation logic; they rely on injected HTTP headers from OAM. The WebGate + OAM Server + LDAP identity store triad is the foundation of every OAM deployment. Understanding the SSO token lifecycle, authentication scheme levels, and authorisation policy condition evaluation is the foundation for diagnosing access issues and designing secure, seamless user experiences.

The companion runbook provides the step-by-step commands for installing OAM 12c, configuring WebGate, and setting up SSO policies.`,
};

async function main() {
  console.log('Inserting OAM architecture post...');
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
