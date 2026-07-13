import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-exposed-endpoints-file-read-ssrf-mitigation';

const content = `
Few alerts hit harder than a message from your cybersecurity team stating that your Oracle E-Business Suite login panel is externally exposed and producing critical findings in an external penetration scan. The moment you see a tool successfully pulling \`/etc/passwd\` from an application server you manage, the clock starts. This post covers exactly that scenario: two vulnerabilities that affect the \`/OA_HTML/\` directory on externally accessible EBS instances, how to confirm your exposure, and how to contain both findings at the network layer without touching your EBS configuration or waiting for an Oracle Critical Patch Update cycle.

---

## Why EBS Ends Up Exposed

Oracle E-Business Suite was not designed to be a public-internet application. Its core financial and HR modules live entirely behind a corporate firewall. The exposure happens when organizations deploy self-service modules — iSupplier, iReceivables, iProcurement, iRecruitment — that require external supplier or partner access. A reverse proxy or application delivery controller (ADC) fronts the external web tier, and the \`/OA_HTML/\` directory becomes reachable from the public internet.

In a hardened configuration, this is manageable: the reverse proxy enforces TLS, blocks unused paths, and only exposes the specific endpoints those external modules need. In practice, the reverse proxy rules are often set to pass all traffic through, the assumption being that Oracle's web server handles path authorization internally. That assumption is wrong for a subset of legacy JSP and servlet endpoints that either predate authentication enforcement or have known implementation flaws.

External penetration testing tools find these endpoints quickly. The \`/OA_HTML/\` directory is publicly documented, and automated scanners fuzz it against known vulnerable paths as a standard step. When they find a hit, they escalate — and your security team gets the alert.

---

## The Two Vulnerabilities

### 1. Arbitrary File Read via Legacy Graphing Endpoints

**Advisory:** H3-2025-0044

The Oracle EBS business intelligence graphing subsystem exposes two JSP endpoints:

- \`/OA_HTML/bispgraph.jsp\`
- \`/OA_HTML/jsp/bsc/bscpgraph.jsp\`

These are legacy components dating from older EBS Business Intelligence and Balanced Scorecard integrations. On vulnerable versions, they accept \`ifl\` and \`ifn\` (image file location / image file name) parameters without validating or sandboxing the supplied path. An unauthenticated attacker can pass an arbitrary filesystem path through these parameters and receive the file contents in the HTTP response.

The standard proof-of-concept pulls \`/etc/passwd\` — which, while not itself a credential file on modern shadow-password systems, confirms read access to the OS filesystem from an unauthenticated HTTP request. From there, the same technique can reach application configuration files, wallet directories, Oracle \`tnsnames.ora\`, and any file readable by the Oracle OS user.

**Affected versions:** Present on EBS releases where the graphing components are installed and the endpoints are not explicitly blocked. Verified on 12.1.3 environments without recent Oracle Security patches applied. Later releases with Oracle CPU coverage may have server-side fixes, but the endpoint must still be blocked at the network layer if the EBS instance faces the public internet.

**CVSS context:** Unauthenticated, network-exploitable, no user interaction required. The reconnaissance potential is high: filesystem access to an application server in a production EBS environment provides direct paths to database credentials and key material.

---

### 2. Server-Side Request Forgery via Oracle Configurator Servlet

**CVE:** CVE-2025-61884

The Oracle Configurator module exposes a UI processing servlet at:

\`\`\`
/OA_HTML/configurator/UiServlet
\`\`\`

Oracle Configurator is an optional module used in manufacturing and order management implementations to handle complex product configuration rules. The servlet accepts parameters that cause the application server to initiate outbound HTTP or HTTPS requests as part of its processing.

An attacker exploits this by supplying parameters that redirect these outbound requests to an attacker-controlled server. The internal EBS application tier — which lives behind your firewall and is implicitly trusted by internal systems — then makes an outbound connection to an external IP. This is verified in external scans via out-of-band DNS callbacks: the attacker's server receives a DNS lookup from your application server's IP, confirming the SSRF is exploitable even without a direct HTTP response.

**The consequence of SSRF in a production EBS environment:**

- The application server's implicit trust within the network can be abused to reach internal services that are not directly accessible from the internet
- Outbound connections from a production application server bypass egress firewall rules that assume all outbound traffic from that host is legitimate
- SSRF can be chained with internal metadata services or other internal endpoints depending on the cloud or datacenter configuration

**Affected versions:** The Oracle Configurator module must be installed and the endpoint must be reachable. The vulnerability does not require Configurator to be licensed or actively used — the servlet may be present due to the standard EBS software installation regardless of whether the module is in production use.

---

## Step 1: Confirm the Endpoints Are Present and Accessible

Before implementing any mitigation, confirm what you are actually dealing with.

### Test from the application server directly

Connect to your EBS web tier and test both endpoints with \`curl\`. Test against localhost first to establish a baseline before testing against your external-facing URL.

\`\`\`bash
# Test the graphing endpoints
curl -o /dev/null -sw "%{http_code}" http://localhost:<port>/OA_HTML/bispgraph.jsp
curl -o /dev/null -sw "%{http_code}" http://localhost:<port>/OA_HTML/jsp/bsc/bscpgraph.jsp

# Test the Configurator servlet
curl -o /dev/null -sw "%{http_code}" http://localhost:<port>/OA_HTML/configurator/UiServlet
\`\`\`

**Response interpretation:**

| HTTP Code | Meaning | Action |
|-----------|---------|--------|
| 200 | Endpoint is active and responding | Block immediately |
| 500 | Endpoint is present; server error on this request | Block immediately |
| 302 | Redirect — likely to login page (endpoint present but auth-gated) | Block as a precaution |
| 404 | Endpoint not deployed on this instance | Verify; still block explicitly |

A 404 from the Oracle HTTP Server (OHS) web container means the path is not mapped. A 404 from the application tier after a proxy passthrough means the endpoint is present but returned an error. Treat both as block targets regardless of the initial response code.

---

## Step 2: Audit OHS Access Logs for Historical Hits

Determine whether these endpoints have been reached before — either by legitimate internal use or by external probing.

\`\`\`bash
# Locate OHS access logs — path varies by OHS version and configuration
# OHS 11.1.1.x (EBS 12.1.x):
find $IAS_ORACLE_HOME -name "access_log*" 2>/dev/null | head -5

# OHS 12.1.3 instance home pattern:
ls $ORACLE_INSTANCE/diagnostics/logs/OHS/*/access_log*

# Search both endpoints across all access log files
grep -i "UiServlet" $ORACLE_INSTANCE/diagnostics/logs/OHS/*/access_log*
grep -i "bispgraph" $ORACLE_INSTANCE/diagnostics/logs/OHS/*/access_log*
\`\`\`

For each hit, examine:
- **Source IP:** Internal corporate range vs. external/unknown IP
- **Timestamp:** Does it coincide with your security scan, or precede it?
- **Response code:** 200 responses indicate the endpoint returned data to the caller
- **Bytes transferred:** For the file-read vulnerability, a large response body from \`bispgraph.jsp\` may indicate a successful file read

If you see external IPs with 200 responses and non-trivial byte counts on the graphing endpoints before your security scan, treat this as a potential compromise event and initiate your incident response process in parallel with mitigation.

---

## Step 3: Virtual Patch at the Network Layer

If you cannot apply Oracle CPU patches immediately — due to EBS version constraints, complex customizations, business freeze periods, or third-party support models — implement a virtual patch at your reverse proxy or ADC. This blocks the vulnerable paths without modifying EBS configuration, without downtime, and without requiring Oracle support involvement.

### Option A: Application Delivery Controller (NetScaler / Citrix ADC)

A responder policy on the EBS Virtual IP (VIP) drops the request at the load balancer before it reaches the application tier. This is the fastest and most surgical option.

\`\`\`
# Step 1: Define the block action
add responder action act_block_ebs_exploits respondwith "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"

# Step 2: Define the policy — match either vulnerable path
add responder policy pol_block_ebs_exploits \\
  "HTTP.REQ.URL.CONTAINS(\\"/OA_HTML/configurator/UiServlet\\") || \\
   HTTP.REQ.URL.CONTAINS(\\"/OA_HTML/bispgraph.jsp\\") || \\
   HTTP.REQ.URL.CONTAINS(\\"/OA_HTML/jsp/bsc/bscpgraph.jsp\\")" \\
  act_block_ebs_exploits

# Step 3: Bind to the external EBS VIP at high priority
bind lb vserver <ebs_external_vip_name> \\
  -policyName pol_block_ebs_exploits \\
  -priority 10 \\
  -gotoPriorityExpression END \\
  -type REQUEST
\`\`\`

Replace \`<ebs_external_vip_name>\` with the name of your external-facing EBS load balancer virtual server.

### Option B: F5 BIG-IP iRule

\`\`\`tcl
when HTTP_REQUEST {
    set blocked_paths {
        "/OA_HTML/configurator/UiServlet"
        "/OA_HTML/bispgraph.jsp"
        "/OA_HTML/jsp/bsc/bscpgraph.jsp"
    }
    foreach path $blocked_paths {
        if { [string tolower [HTTP::uri]] contains [string tolower $path] } {
            HTTP::respond 403 content "Forbidden" "Content-Type" "text/plain"
            return
        }
    }
}
\`\`\`

Attach this iRule to the external EBS virtual server in your BIG-IP configuration.

### Option C: Oracle HTTP Server (OHS) Location Block

If your reverse proxy passes all traffic through and you need to block at the OHS layer, add location blocks to your OHS \`httpd.conf\` or to the \`VirtualHost\` configuration for the external web tier.

\`\`\`apache
# Block the Configurator SSRF endpoint
<Location /OA_HTML/configurator/UiServlet>
    Require all denied
</Location>

# Block the legacy graphing endpoints
<Location /OA_HTML/bispgraph.jsp>
    Require all denied
</Location>

<Location /OA_HTML/jsp/bsc/bscpgraph.jsp>
    Require all denied
</Location>
\`\`\`

After adding the location blocks, reload OHS (do not restart — reload preserves active connections):

\`\`\`bash
$ADMIN_SCRIPTS_HOME/adapcctl.sh stop
$ADMIN_SCRIPTS_HOME/adapcctl.sh start
\`\`\`

**Note:** OHS-level blocks survive AutoConfig unless you embed them in an AutoConfig-managed template. If you use this approach, add the location blocks to the appropriate \`.tmp\` template in \`$FND_TOP/admin/template/\` so they are regenerated on each AutoConfig run.

---

## Step 4: Scope the Block to External Traffic Only

If the Oracle Configurator module is actively used by internal teams, or if internal business intelligence users legitimately access the graphing endpoints, you do not want a blanket block. Scope the restriction to external source IP ranges.

### On an ADC (NetScaler / F5):

Create a client IP match expression that excludes internal subnets from the block:

\`\`\`
# NetScaler — block only external traffic (not from RFC 1918 / corporate subnets)
add responder policy pol_block_ebs_external \\
  "(HTTP.REQ.URL.CONTAINS(\\"/UiServlet\\") || HTTP.REQ.URL.CONTAINS(\\"bispgraph\\")) && \\
   !CLIENT.IP.SRC.IN_SUBNET(10.0.0.0/8) && \\
   !CLIENT.IP.SRC.IN_SUBNET(172.16.0.0/12) && \\
   !CLIENT.IP.SRC.IN_SUBNET(192.168.0.0/16)" \\
  act_block_ebs_exploits
\`\`\`

Replace the subnet ranges with your actual corporate VPN pool, internal office ranges, and any whitelisted partner IP ranges that require legitimate Configurator access.

---

## Step 5: Verify the Block Is Working

After applying the virtual patch, confirm the endpoints now return 403 from the external-facing URL:

\`\`\`bash
# Test from an external network or via curl with the public-facing host
curl -o /dev/null -sw "HTTP %{http_code}\\n" https://<external-ebs-hostname>/OA_HTML/bispgraph.jsp
curl -o /dev/null -sw "HTTP %{http_code}\\n" https://<external-ebs-hostname>/OA_HTML/configurator/UiServlet

# Expected: HTTP 403
\`\`\`

Also verify the OHS access logs stop receiving hits on these paths from external IPs after the block is in place.

---

## Long-Term Remediation

Virtual patching at the network layer is containment, not remediation. The underlying software vulnerability remains. Plan the following in parallel:

1. **Apply the relevant Oracle CPU or security patch.** Check My Oracle Support for the specific patch for your EBS release and database version that addresses H3-2025-0044 and CVE-2025-61884. Run the patch in a non-production clone first.

2. **Conduct a full \`/OA_HTML/\` path audit.** Document which paths are required for your active external modules (iSupplier, iReceivables, etc.) and block all others at the reverse proxy. The principle of minimum exposure: only the paths your external users actually need should be reachable from the internet.

3. **Enable OHS request logging for \`/OA_HTML/\` at the external tier.** If you do not already have centralized log forwarding to a SIEM, configure it now. External scans against \`/OA_HTML/\` are a persistent threat category, not a one-time event.

4. **Schedule a penetration test recheck.** After applying the virtual patch and the Oracle CPU, request a targeted retest from your security team to confirm both CVEs are no longer exploitable from the external network.

---

## Summary

When an external security scan flags \`/OA_HTML/bispgraph.jsp\` (H3-2025-0044, arbitrary file read) or \`/OA_HTML/configurator/UiServlet\` (CVE-2025-61884, SSRF) on your Oracle E-Business Suite instance, the path to containment does not require an immediate Oracle CPU application or application downtime. A targeted block at the reverse proxy or ADC — a single responder policy or iRule, applied in minutes — reduces both vulnerabilities from externally exploitable to completely unreachable from the public internet.

The same approach extends to the broader problem: any externally exposed EBS instance should have explicit allow-listing at the reverse proxy layer, permitting only the specific \`/OA_HTML/\` paths that your active external modules require. Every other path should default to 403. This posture eliminates the entire class of legacy-endpoint exposure, regardless of what future advisories emerge against the EBS web tier.

The Oracle CPU remains the definitive fix. The network-layer block buys you the time to patch correctly — in a non-production environment first, with full regression testing, on a schedule that does not create additional risk.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'Oracle EBS Exposed: Containing Arbitrary File Read and SSRF Vulnerabilities on the External Web Tier',
    slug,
    excerpt: 'When an external penetration scan flags /OA_HTML/bispgraph.jsp (H3-2025-0044, unauthenticated file read) and /OA_HTML/configurator/UiServlet (CVE-2025-61884, SSRF) on an Oracle EBS instance, the immediate fix is a virtual patch at the reverse proxy or ADC — not an Oracle CPU cycle. This post covers both vulnerabilities, how to confirm exposure via curl and OHS access logs, and how to implement targeted 403 blocks on NetScaler, F5 BIG-IP, and Oracle HTTP Server without touching EBS configuration or causing downtime.',
    content,
    category: 'oracle-security',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
