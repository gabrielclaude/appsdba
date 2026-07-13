import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-exposed-endpoints-file-read-ssrf-runbook';

const content = `
This runbook covers the immediate response when an external penetration scan or security team alert identifies that Oracle EBS endpoints \`/OA_HTML/bispgraph.jsp\` and/or \`/OA_HTML/configurator/UiServlet\` are exploitable from the public internet. Execute phases in order. Phase 1 through Phase 3 can be completed in under 30 minutes.

**Affected advisories:** H3-2025-0044 (arbitrary file read via legacy graphing JSPs), CVE-2025-61884 (SSRF via Oracle Configurator servlet)

**Applicable versions:** Oracle EBS 12.1.x and 12.2.x instances with an externally accessible web tier

---

## Prerequisites

Before starting, confirm the following:

- Shell access to the EBS application/web tier (or access to ADC management interface)
- Knowledge of your Oracle HTTP Server instance home path (\`$ORACLE_INSTANCE\` or \`$IAS_ORACLE_HOME\`)
- Name or VIP of the external-facing EBS load balancer / reverse proxy
- Access to OHS access logs
- ADC management credentials (if applying network-layer block)

\`\`\`bash
# Verify environment variables are set
echo "ORACLE_HOME: $ORACLE_HOME"
echo "INST_TOP: $INST_TOP"      # EBS 12.1.x
echo "EBS_DOMAIN_HOME: $EBS_DOMAIN_HOME"  # EBS 12.2.x

# Source EBS environment if not already set
# 12.1.x:
. /u01/oracle/apps/apps_st/appl/APPSORA.env
# 12.2.x:
. /u01/oracle/apps/EBSapps.env run
\`\`\`

---

## Phase 1: Confirm Endpoint Exposure (5 minutes)

### 1.1 Test from the web tier host (internal baseline)

\`\`\`bash
# Identify the OHS port from the EBS environment
# 12.1.x — find the HTTP port
grep -i "^port\|listen" $IAS_ORACLE_HOME/instances/*/config/OHS/*/httpd.conf 2>/dev/null | head -5

# 12.2.x
grep -i "^port\|listen" $ORACLE_INSTANCE/config/OHS/*/httpd.conf 2>/dev/null | head -5

# Set the port for use in curl commands
OHS_PORT=8000   # Replace with actual value from above

# Test each vulnerable endpoint
echo "--- bispgraph.jsp ---"
curl -o /dev/null -sw "HTTP %{http_code}  bytes=%{size_download}\\n" \\
  "http://localhost:\${OHS_PORT}/OA_HTML/bispgraph.jsp"

echo "--- bscpgraph.jsp ---"
curl -o /dev/null -sw "HTTP %{http_code}  bytes=%{size_download}\\n" \\
  "http://localhost:\${OHS_PORT}/OA_HTML/jsp/bsc/bscpgraph.jsp"

echo "--- UiServlet ---"
curl -o /dev/null -sw "HTTP %{http_code}  bytes=%{size_download}\\n" \\
  "http://localhost:\${OHS_PORT}/OA_HTML/configurator/UiServlet"
\`\`\`

**Record the HTTP response codes.** A 200, 302, or 500 on any endpoint means it is present and reachable at the OHS layer.

### 1.2 Test from external network (confirm public exposure)

Run from a host outside your corporate network, or coordinate with your security team to test from their external scanner:

\`\`\`bash
# Replace <external-ebs-hostname> with your publicly resolvable EBS hostname
EBS_EXTERNAL="https://<external-ebs-hostname>"

curl -o /dev/null -sw "HTTP %{http_code}\\n" "\${EBS_EXTERNAL}/OA_HTML/bispgraph.jsp"
curl -o /dev/null -sw "HTTP %{http_code}\\n" "\${EBS_EXTERNAL}/OA_HTML/jsp/bsc/bscpgraph.jsp"
curl -o /dev/null -sw "HTTP %{http_code}\\n" "\${EBS_EXTERNAL}/OA_HTML/configurator/UiServlet"
\`\`\`

If external responses are 200 or 500, the endpoints are publicly exploitable. Proceed immediately to Phase 3 (containment).

### 1.3 Attempt the file-read proof of concept (internal only)

Run this from the web tier host to confirm whether the bispgraph endpoint is actually exploitable (not just reachable) on this instance:

\`\`\`bash
# Test arbitrary file read — request /etc/passwd via the ifl parameter
curl -s "http://localhost:\${OHS_PORT}/OA_HTML/bispgraph.jsp?ifl=/etc/passwd" | head -5
\`\`\`

If this returns OS user entries (e.g., \`root:x:0:0:root:/root:/bin/bash\`), the file-read vulnerability is confirmed active on this instance. Record and escalate to your security team.

---

## Phase 2: Investigate Historical Access (10 minutes)

### 2.1 Locate OHS access logs

\`\`\`bash
# EBS 12.1.x — OHS logs in instance diagnostics
find $IAS_ORACLE_HOME -path "*/diagnostics/logs/OHS/*/access_log*" 2>/dev/null

# EBS 12.2.x — OHS logs via ORACLE_INSTANCE
find $ORACLE_INSTANCE -name "access_log*" 2>/dev/null

# Set log directory variable for subsequent commands
LOG_DIR=$(find $IAS_ORACLE_HOME -path "*/diagnostics/logs/OHS*" -type d 2>/dev/null | head -1)
echo "Log dir: $LOG_DIR"
\`\`\`

### 2.2 Search for hits on the vulnerable endpoints

\`\`\`bash
# Search all available access logs (including rotated logs)
grep -ih "UiServlet\\|bispgraph\\|bscpgraph" \${LOG_DIR}/access_log* 2>/dev/null | \\
  awk '{print $1, $7, $9, $10}' | \\
  sort | uniq -c | sort -rn | head -30

# Output columns: count | source_IP | requested_path | HTTP_code | bytes_sent
\`\`\`

### 2.3 Flag suspicious entries

\`\`\`bash
# Show only non-internal source IPs (adjust RFC 1918 ranges as needed)
grep -ih "bispgraph\\|UiServlet" \${LOG_DIR}/access_log* 2>/dev/null | \\
  grep -v "10\\." | grep -v "172\\." | grep -v "192\\.168" | \\
  awk '{print $1, $7, $9, $10}' | sort | head -30
\`\`\`

**Decision point:**
- If you see external IPs with HTTP 200 responses and large byte counts on \`bispgraph.jsp\`, treat this as a potential data exfiltration event. Engage your security incident response team before proceeding.
- If hits are only from your security scanner's IP during the announced test window, proceed to containment.

---

## Phase 3: Immediate Containment — Virtual Patch (5–15 minutes)

Apply whichever option matches your infrastructure. Option A (ADC) is preferred — it blocks the attack before it reaches OHS.

### Option A: NetScaler / Citrix ADC

Log into the NetScaler CLI or management GUI and run:

\`\`\`
# 1. Create the responder action (returns 403 immediately)
add responder action act_block_ebs_exploits respondwith "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"

# 2. Create the policy matching all three vulnerable paths
add responder policy pol_block_ebs_exploits \
  "HTTP.REQ.URL.CONTAINS(\"/OA_HTML/configurator/UiServlet\") || \
   HTTP.REQ.URL.CONTAINS(\"/OA_HTML/bispgraph.jsp\") || \
   HTTP.REQ.URL.CONTAINS(\"/OA_HTML/jsp/bsc/bscpgraph.jsp\")" \
  act_block_ebs_exploits

# 3. Bind to the external EBS VIP — priority 10 ensures it fires before other policies
bind lb vserver <ebs_external_vip_name> \
  -policyName pol_block_ebs_exploits \
  -priority 10 \
  -gotoPriorityExpression END \
  -type REQUEST

# 4. Save the configuration
save ns config
\`\`\`

**Scope to external IPs only** (if internal teams use Configurator):

\`\`\`
add responder policy pol_block_ebs_external_only \
  "(HTTP.REQ.URL.CONTAINS(\"/UiServlet\") || HTTP.REQ.URL.CONTAINS(\"bispgraph\")) && \
   !CLIENT.IP.SRC.IN_SUBNET(10.0.0.0/8) && \
   !CLIENT.IP.SRC.IN_SUBNET(172.16.0.0/12) && \
   !CLIENT.IP.SRC.IN_SUBNET(192.168.0.0/16)" \
  act_block_ebs_exploits
\`\`\`

Replace the subnet ranges with your actual corporate network ranges and VPN pool.

---

### Option B: F5 BIG-IP iRule

In the BIG-IP management UI (Local Traffic → iRules → iRule List):

\`\`\`tcl
when HTTP_REQUEST {
    set blocked_paths {
        "/OA_HTML/configurator/UiServlet"
        "/OA_HTML/bispgraph.jsp"
        "/OA_HTML/jsp/bsc/bscpgraph.jsp"
    }
    set req_uri [string tolower [HTTP::uri]]
    foreach path $blocked_paths {
        if { $req_uri contains [string tolower $path] } {
            HTTP::respond 403 content "Forbidden" \\
                "Content-Type" "text/plain" \\
                "Connection" "close"
            event disable all
            return
        }
    }
}
\`\`\`

1. Create the iRule with the content above
2. Attach it to the external EBS virtual server (Virtual Servers → Resources → iRules)
3. Move it to the top of the iRule list to ensure it runs first

---

### Option C: Oracle HTTP Server location blocks (fallback — no ADC access)

Edit the OHS \`httpd.conf\` for the external-facing virtual host. The config file location:

\`\`\`bash
# 12.1.x
find $IAS_ORACLE_HOME -name "httpd.conf" 2>/dev/null | grep -i ohs | head -3

# 12.2.x
find $ORACLE_INSTANCE -name "httpd.conf" 2>/dev/null | head -3
\`\`\`

Add the following \`<Location>\` blocks inside the appropriate \`<VirtualHost>\` section (the one handling external traffic):

\`\`\`apache
# Block Oracle Configurator SSRF endpoint
<Location /OA_HTML/configurator/UiServlet>
    Require all denied
</Location>

# Block legacy graphing endpoints (arbitrary file read)
<Location /OA_HTML/bispgraph.jsp>
    Require all denied
</Location>

<Location /OA_HTML/jsp/bsc/bscpgraph.jsp>
    Require all denied
</Location>
\`\`\`

**Make this AutoConfig-safe:** If you allow AutoConfig to overwrite \`httpd.conf\`, add these blocks to the appropriate OHS template file instead:

\`\`\`bash
# Locate the OHS httpd template used for your context
find $FND_TOP/admin/template -name "httpd*.tmp" 2>/dev/null | head -5

# Add the Location blocks above into the template at the end of the VirtualHost section
# Use your preferred editor — changes survive AutoConfig reruns
\`\`\`

After editing, reload OHS:

\`\`\`bash
$ADMIN_SCRIPTS_HOME/adapcctl.sh stop
$ADMIN_SCRIPTS_HOME/adapcctl.sh start
\`\`\`

---

## Phase 4: Verify Containment (5 minutes)

### 4.1 Confirm external 403 responses

\`\`\`bash
EBS_EXTERNAL="https://<external-ebs-hostname>"

echo "--- bispgraph.jsp ---"
curl -o /dev/null -sw "HTTP %{http_code}\\n" "\${EBS_EXTERNAL}/OA_HTML/bispgraph.jsp"

echo "--- bscpgraph.jsp ---"
curl -o /dev/null -sw "HTTP %{http_code}\\n" "\${EBS_EXTERNAL}/OA_HTML/jsp/bsc/bscpgraph.jsp"

echo "--- UiServlet ---"
curl -o /dev/null -sw "HTTP %{http_code}\\n" "\${EBS_EXTERNAL}/OA_HTML/configurator/UiServlet"

# All three should return: HTTP 403
\`\`\`

### 4.2 Confirm internal access is unaffected (if scoped to external IPs)

If you applied an IP-scoped block (Option A scoped variant), test from an internal host:

\`\`\`bash
# From an internal corporate network host — should still return original response
curl -o /dev/null -sw "HTTP %{http_code}\\n" \\
  "http://<internal-ebs-hostname>/OA_HTML/configurator/UiServlet"
\`\`\`

### 4.3 Re-run the file-read proof of concept

\`\`\`bash
# This should now return 403 or empty — not file contents
curl -sw "HTTP %{http_code}\\n" \\
  "https://<external-ebs-hostname>/OA_HTML/bispgraph.jsp?ifl=/etc/passwd"
\`\`\`

If you still receive file content, the block is not in effect at the network layer. Verify the policy is bound to the correct VIP and that the priority is set to fire before pass-through rules.

---

## Phase 5: Document and Notify

### 5.1 Record actions taken

\`\`\`
Date/Time of alert:        ___________________________
Date/Time of block applied: ___________________________
Method used:               [ ] NetScaler  [ ] F5  [ ] OHS location block
VIP / host blocked on:     ___________________________
External test result (post-block): HTTP ___ on all three endpoints
Historical log findings:   [ ] No external hits  [ ] External hits found — see attached
\`\`\`

### 5.2 Notify your security team

Provide:
- Confirmation that both CVEs are now blocked at the network layer (403 from external)
- The OHS log summary from Phase 2 (external IP hits before the block)
- A statement on whether the file-read PoC was successful before containment

### 5.3 Open a patching ticket

The virtual patch is containment. Schedule the Oracle CPU application as a follow-up task:

- Check My Oracle Support for the CPU patch applicable to your EBS and Oracle Database release
- Clone a production snapshot to a test environment
- Apply and regression test on the clone before scheduling production maintenance

---

## Automated Verification Script

Save this to \`/home/oracle/check_ebs_exploit_exposure.sh\` and run it before and after applying the block to capture a before/after snapshot:

\`\`\`bash
#!/bin/bash
# EBS exploit endpoint exposure checker
# Usage: ./check_ebs_exploit_exposure.sh <base_url>
# Example: ./check_ebs_exploit_exposure.sh https://ebs.example.com

BASE_URL="\${1:-https://localhost}"

ENDPOINTS=(
  "/OA_HTML/bispgraph.jsp"
  "/OA_HTML/jsp/bsc/bscpgraph.jsp"
  "/OA_HTML/configurator/UiServlet"
)

echo "EBS Exploit Endpoint Check"
echo "Base URL: \${BASE_URL}"
echo "Timestamp: \$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "---"

ALL_BLOCKED=true

for ep in "\${ENDPOINTS[@]}"; do
  CODE=\$(curl -o /dev/null -sk -w "%{http_code}" --max-time 10 "\${BASE_URL}\${ep}" 2>/dev/null)
  STATUS="UNKNOWN"

  case "\${CODE}" in
    403) STATUS="BLOCKED (OK)"   ;;
    404) STATUS="NOT FOUND"      ;;
    200) STATUS="EXPOSED (CRITICAL)"; ALL_BLOCKED=false ;;
    302) STATUS="REDIRECT (CHECK)";   ALL_BLOCKED=false ;;
    500) STATUS="ERROR (CHECK)";      ALL_BLOCKED=false ;;
    000) STATUS="UNREACHABLE"         ;;
    *)   STATUS="HTTP \${CODE} (CHECK)"; ALL_BLOCKED=false ;;
  esac

  printf "  HTTP %-3s  %-20s  %s\\n" "\${CODE}" "\${STATUS}" "\${ep}"
done

echo "---"
if \${ALL_BLOCKED}; then
  echo "RESULT: All endpoints blocked or absent. No immediate action required."
else
  echo "RESULT: One or more endpoints are exposed. Apply virtual patch immediately."
  exit 1
fi
\`\`\`

\`\`\`bash
chmod +x /home/oracle/check_ebs_exploit_exposure.sh

# Run before the block:
./check_ebs_exploit_exposure.sh https://<external-ebs-hostname>

# Run after the block:
./check_ebs_exploit_exposure.sh https://<external-ebs-hostname>
\`\`\`

---

## Summary

| Phase | Task | Time |
|-------|------|------|
| 1 | Confirm endpoint presence and external accessibility via curl | 5 min |
| 2 | Search OHS access logs for historical external hits | 10 min |
| 3 | Apply virtual patch (NetScaler / F5 / OHS location block) | 5–15 min |
| 4 | Verify 403 responses from external network | 5 min |
| 5 | Document actions, notify security team, open patching ticket | 10 min |

**Total time to containment: 25–45 minutes.**

The virtual patch reduces both H3-2025-0044 and CVE-2025-61884 from externally exploitable to completely blocked without Oracle support involvement, application downtime, or risk to customized EBS configuration. Schedule Oracle CPU application in a separate maintenance window with full clone-based regression testing.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'Runbook: Containing EBS Arbitrary File Read (H3-2025-0044) and SSRF (CVE-2025-61884) on the External Web Tier',
    slug,
    excerpt: 'Step-by-step containment runbook for Oracle EBS instances where /OA_HTML/bispgraph.jsp and /OA_HTML/configurator/UiServlet are externally exploitable. Covers exposure verification via curl and OHS log analysis, virtual patching on NetScaler, F5 BIG-IP, and Oracle HTTP Server, scoped IP-based blocking, post-block verification, and an automated shell script for before/after snapshot comparison. Total time to containment: under 45 minutes.',
    content,
    category: 'oracle-security',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
