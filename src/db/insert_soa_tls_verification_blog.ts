import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Scripting TLS 1.2 Verification Across the SOA Suite 12c Topology',
  slug: 'oracle-soa-suite-tls-1-2-verification-scripting',
  excerpt:
    'How to design and structure automated TLS 1.2 verification scripts for Oracle SOA Suite 12c: verifying inbound TLS on OHS and WebLogic, checking JVM flags on running processes, validating TCPS database connectivity, confirming LDAPS, auditing composite outbound trust stores, and scheduling continuous verification with alerting.',
  category: 'soa-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-07'),
  youtubeUrl: null,
  content: `## Introduction

Implementing TLS 1.2 across the SOA Suite 12c topology is a multi-phase exercise that touches OHS, WebLogic, the JVM, the database connection, and the LDAP identity store. But implementation is a one-time event — or so it appears. In practice, TLS 1.2 compliance in a running SOA environment degrades continuously: certificates expire, patches reset \`setDomainEnv.sh\`, DBAs reconfigure listeners, EBS AutoConfig regenerates OHS configuration, new composites are deployed that call untrusted HTTPS endpoints. A manual verification check done at implementation time provides no ongoing assurance.

Scripted TLS 1.2 verification addresses this. A well-structured verification script runs daily, checks every TLS channel in the topology, reports pass/warn/fail with specific diagnostics, and alerts on drift before it causes a compliance failure or an outage. This post explains the architecture of a comprehensive SOA Suite TLS 1.2 verification script — what to check at each layer, which tools to use, how to structure the output, and how to schedule continuous verification.

The companion runbook provides the complete, production-ready script with all functions implemented.

---

## What a Complete Verification Covers

A complete SOA Suite TLS 1.2 verification script must check four categories of evidence:

**Protocol enforcement** — that TLS 1.2 is the minimum accepted protocol and that TLS 1.0/1.1 connections are actively rejected. Evidence: live TLS handshake tests with \`openssl s_client -tls1_1\` returning a handshake failure.

**Certificate health** — that no certificate in the stack (server certs, CA certs in trust JKS, Oracle Wallet entries) is within 90 days of expiry. Evidence: \`keytool -list -v\` and \`orapki wallet display\` output parsed for \`Valid Until\` dates.

**Configuration consistency** — that the JVM flags are present in the running process (not just in \`setDomainEnv.sh\`), that the WebLogic \`MinimumTLSProtocolVersion\` is set in the live domain config, and that the LDAP provider port is 636. Evidence: \`ps aux\` grep, WLST MBean read, XML config parse.

**Connectivity** — that each TLS channel in the topology is actually reachable and functioning: LDAPS bind succeeds, TCPS database connection succeeds, SOA DataSources show zero failed connections. Evidence: live \`ldapsearch\`, JDBC ping, WebLogic DataSource monitoring API.

---

## The Verification Layers

The script mirrors the implementation layers in the same topology order.

### Layer 1: OHS Inbound TLS

The OHS check is the most straightforward: \`openssl s_client\` performs a live TLS handshake and reports the negotiated protocol.

\`\`\`bash
# TLS 1.2 must be accepted
openssl s_client -connect soa.company.com:443 -tls1_2 </dev/null 2>&1

# TLS 1.1 must be rejected — expect "alert handshake failure"
openssl s_client -connect soa.company.com:443 -tls1_1 </dev/null 2>&1

# TLS 1.0 must be rejected
openssl s_client -connect soa.company.com:443 -tls1 </dev/null 2>&1
\`\`\`

The script should verify both the positive case (TLS 1.2 accepted) and the negative case (TLS 1.0/1.1 rejected). Checking only the positive case misses a configuration where TLS 1.2 is accepted but earlier versions are also still accepted — which is the most common misconfiguration in environments where \`SSLProtocol TLSv1.2\` was added without the \`-ALL\` prefix to disable earlier protocols.

**OHS-specific check**: verify that the OHS wallet certificate is not self-signed (self-signed certs are rejected by strict TLS 1.2 clients):

\`\`\`bash
# Check if issuer equals subject (self-signed)
openssl s_client -connect soa.company.com:443 </dev/null 2>&1 | \
    openssl x509 -noout -issuer -subject 2>/dev/null
# Issuer and Subject should differ in a properly signed certificate
\`\`\`

### Layer 2: WebLogic SSL Listeners

Each managed server — \`soa_server1\`, \`osb_server1\`, and AdminServer — needs its own TLS check. In a clustered deployment with multiple nodes, every node in each cluster must be checked independently. A misconfigured cluster node may receive traffic through the load balancer even if the primary node is correctly configured.

\`\`\`bash
# soa_server1
openssl s_client -connect soa_server1.company.com:8002 -tls1_2 </dev/null 2>&1
openssl s_client -connect soa_server1.company.com:8002 -tls1_1 </dev/null 2>&1

# osb_server1
openssl s_client -connect osb_server1.company.com:7005 -tls1_2 </dev/null 2>&1

# AdminServer
openssl s_client -connect admin-server.company.com:7002 -tls1_2 </dev/null 2>&1
\`\`\`

**KeyStore freshness check**: the script also reads the identity JKS to verify the server certificate common name matches the expected hostname and that the certificate has not been replaced with a self-signed or expired substitute:

\`\`\`bash
keytool -list -v -keystore /u01/oracle/keystores/soa-identity.jks \
    -storepass Identity1 -alias soa-server 2>/dev/null | \
    grep -E "Owner|Valid|Alias"
\`\`\`

### Layer 3: JVM Flag Verification

The \`setDomainEnv.sh\` file can be edited at any time — by a patch, by a DBA, or by a well-intentioned team member who adds a JVM flag and accidentally removes an adjacent flag. The file state is less important than the running process state. The script verifies the JVM flag against the live process:

\`\`\`bash
# Find the PID of soa_server1 JVM
SOA_PID=\$(pgrep -f "weblogic.Name=soa_server1")

# Verify disabledAlgorithms flag is present in the running JVM
if [ -n "\$SOA_PID" ]; then
    cat /proc/\${SOA_PID}/cmdline | tr '\\0' '\\n' | grep "disabledAlgorithms"
fi

# Also verify trustStore flag
cat /proc/\${SOA_PID}/cmdline | tr '\\0' '\\n' | grep "trustStore"
\`\`\`

On Linux, \`/proc/<pid>/cmdline\` contains the full JVM command line with null byte separators. On macOS or Solaris, use \`ps aux | grep <server_name>\` instead.

**setDomainEnv.sh check**: also verify the flag is present in the file for persistence across restarts:

\`\`\`bash
grep "disabledAlgorithms" \$DOMAIN_HOME/bin/setDomainEnv.sh
grep "TLSv1,TLSv1.1" \$DOMAIN_HOME/bin/setDomainEnv.sh
\`\`\`

### Layer 4: WebLogic Configuration — WLST MBean Read

The WLST-based check reads the live WebLogic MBean tree to verify that \`MinimumTLSProtocolVersion\` is set to \`TLSv1.2\` and that custom keystores are configured. This check is more reliable than parsing \`config.xml\` because it reflects the currently active configuration, not just what is on disk:

\`\`\`python
# WLST verification script fragment
connect('weblogic', 'password', 't3s://admin-server:7002')

for server_name in ['soa_server1', 'osb_server1']:
    cd('/Servers/' + server_name + '/SSL/' + server_name)
    tls_version = cmo.getMinimumTLSProtocolVersion()
    ssl_enabled = cmo.getEnabled()
    print(server_name + ' SSL enabled: ' + str(ssl_enabled))
    print(server_name + ' Min TLS version: ' + str(tls_version))
    if tls_version != 'TLSv1.2':
        print('FAIL: ' + server_name + ' MinimumTLSProtocolVersion is not TLSv1.2')

disconnect()
\`\`\`

### Layer 5: LDAPS Connectivity

The LDAPS check performs a live bind against port 636 to verify that the LDAP authentication channel is working with TLS 1.2. A bind failure here means LDAP authentication for human workflow and OSB security policies is broken:

\`\`\`bash
# Attempt an anonymous search over LDAPS (tests TLS + connectivity, no auth required)
ldapsearch -H ldaps://oid-server.company.com:636 \
    -x -b "dc=company,dc=com" -s base "(objectclass=*)" 2>&1 | \
    grep -E "result:|error:|ldap_"

# Test the port TLS version
openssl s_client -connect oid-server.company.com:636 -tls1_2 </dev/null 2>&1 | \
    grep -E "Protocol|CONNECTED|alert"
\`\`\`

### Layer 6: TCPS Database Connectivity

The database TCPS check verifies that the SOA Infrastructure DataSources can reach the database over the encrypted channel. The most practical check without a SQL*Plus session is to verify the TCPS port is open and the TLS handshake succeeds:

\`\`\`bash
# Test TCPS port reachability
openssl s_client -connect db-server.company.com:1522 \
    -tls1_2 </dev/null 2>&1 | grep -E "Protocol|CONNECTED|alert"

# Check DataSource status via WebLogic REST API
curl -s -k -u weblogic:password \
    "https://admin-server.company.com:7002/management/weblogic/latest/domainRuntime/serverRuntimes/soa_server1/JDBCServiceRuntime/JDBCDataSourceRuntimeMBeans/SOADataSource" | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print('State:', d.get('state'), 'Failed:', d.get('failedReserveRequestCount'))"
\`\`\`

### Layer 7: SOA Trust JKS — Outbound HTTPS Coverage

This is the check that is most often missing from ad-hoc TLS verification procedures. The trust JKS must contain a CA certificate for every HTTPS endpoint that SOA composites or OSB business services call. The script audits the trust JKS contents and cross-references them against the composite reference endpoints:

\`\`\`bash
# List all CAs in the trust JKS with their expiry dates
keytool -list -v -keystore /u01/oracle/keystores/soa-trust.jks \
    -storepass TrustStore1 2>/dev/null | \
    awk '/Alias name:|Valid from:/{print}' | \
    paste - - | \
    awk '{print \$3, \$NF}'

# Check that the trust JKS is configured in setDomainEnv.sh
grep "trustStore" \$DOMAIN_HOME/bin/setDomainEnv.sh
\`\`\`

For a more thorough outbound check, the script can test connectivity from the SOA server host to each known external HTTPS endpoint and verify TLS 1.2 is accepted:

\`\`\`bash
# For each known external HTTPS endpoint called by composites:
for endpoint in partner1.company.com:443 api.service.com:8443 payments.bank.com:443; do
    result=\$(openssl s_client -connect "\$endpoint" -tls1_2 </dev/null 2>&1)
    if echo "\$result" | grep -q "CONNECTED"; then
        echo "OK: \$endpoint accepts TLS 1.2"
    else
        echo "FAIL: \$endpoint TLS 1.2 handshake failed"
    fi
done
\`\`\`

---

## Script Architecture

The verification script is structured as a set of check functions that each return a Nagios-compatible exit code (0=OK, 1=WARNING, 2=CRITICAL, 3=UNKNOWN), plus a summary reporter that aggregates all results.

\`\`\`
soa_tls_verify.sh
│
├── Configuration block (hostnames, ports, paths, thresholds)
│
├── Helper functions
│   ├── check_ssl_protocol()      — openssl s_client TLS test
│   ├── check_tls_rejection()     — verify TLS 1.1/1.0 are rejected
│   ├── check_cert_expiry()       — days until certificate expiry
│   ├── check_jks_alias_expiry()  — keytool alias expiry
│   ├── check_wallet_expiry()     — orapki wallet cert expiry
│   └── check_process_jvm_flag()  — /proc/<pid>/cmdline flag presence
│
├── Layer check functions
│   ├── check_layer1_ohs()
│   ├── check_layer2_wls()
│   ├── check_layer3_jvm()
│   ├── check_layer4_wls_config()   (WLST sub-script)
│   ├── check_layer5_ldaps()
│   ├── check_layer6_tcps()
│   └── check_layer7_trust_jks()
│
└── Main
    ├── Run all layer checks
    ├── Collect results
    ├── Generate report (console + log file)
    └── Send alert email if any WARNING or CRITICAL
\`\`\`

### Output Format

Each check function outputs a single line with a status prefix:

\`\`\`
[OK]       OHS :443 TLS 1.2 accepted — cipher: ECDHE-RSA-AES256-GCM-SHA384
[OK]       OHS :443 TLS 1.1 rejected — handshake failure confirmed
[WARNING]  soa-server cert in soa-identity.jks expires in 73 days (2026-08-19)
[CRITICAL] partner-ca in soa-trust.jks expires in 12 days (2026-06-19)
[OK]       soa_server1 :8002 TLS 1.2 accepted
[FAIL]     osb_server1 :7005 TLS 1.1 NOT rejected — TLS 1.1 connection succeeded
[OK]       JVM flag -Djdk.tls.disabledAlgorithms present in soa_server1 PID 24381
[FAIL]     -Djdk.tls.disabledAlgorithms NOT found in setDomainEnv.sh
[OK]       LDAPS oid-server.company.com:636 TLS 1.2 accepted
[OK]       TCPS db-server.company.com:1522 TLS 1.2 accepted
[OK]       SOADataSource state: Running, failed reserves: 0
\`\`\`

This format allows the script output to be parsed by monitoring systems (Nagios, Zabbix, Datadog) and aggregated into dashboards.

### Exit Code Strategy

The script exits with:
- \`0\` — all checks passed
- \`1\` — at least one WARNING (cert expiry within 90 days, non-critical drift)
- \`2\` — at least one CRITICAL or FAIL (active TLS enforcement gap, imminent expiry, connectivity failure)
- \`3\` — UNKNOWN (cannot reach target, tool not available)

This makes the script directly usable as a Nagios check plugin.

---

## Scheduling and Alerting

### Cron Schedule

\`\`\`bash
# Daily full verification at 06:00
0 6 * * * /u01/oracle/scripts/soa_tls_verify.sh >> /u01/oracle/logs/tls_verify.log 2>&1

# Certificate expiry quick-check every 4 hours (certs can expire mid-day)
0 */4 * * * /u01/oracle/scripts/soa_tls_verify.sh --certs-only >> /u01/oracle/logs/tls_cert_check.log 2>&1

# Post-maintenance verification (run manually after any OHS or WLS restart)
# /u01/oracle/scripts/soa_tls_verify.sh --verbose
\`\`\`

### Log Rotation

\`\`\`bash
# /etc/logrotate.d/soa-tls-verify
/u01/oracle/logs/tls_verify.log {
    daily
    rotate 30
    compress
    missingok
    notifempty
}
\`\`\`

### Integration with Enterprise Monitoring

The script's Nagios-compatible exit codes make it easy to integrate with any monitoring platform:

- **Nagios/Icinga**: Register as an \`NRPE\` check — the monitoring server polls the SOA host and interprets exit codes
- **Zabbix**: Use \`UserParameter\` in the Zabbix agent config to expose the script result
- **OEM**: Create a custom metric target that runs the script and publishes the line count of FAIL/CRITICAL results
- **Splunk/ELK**: Forward \`/u01/oracle/logs/tls_verify.log\` to the log aggregator; build an alert on \`CRITICAL\` or \`FAIL\` events

---

## Handling Configuration Drift

The most operationally valuable feature of a scripted TLS 1.2 verification is detecting configuration drift — changes that undo TLS 1.2 enforcement after the initial implementation. Common drift sources in SOA environments:

**OHS ssl.conf reset by AutoConfig**: If OHS is managed by EBS AutoConfig, a patch application can reset \`SSLProtocol\` to the template default. The OHS layer check catches this immediately — the next daily run will detect that TLS 1.1 is accepted again.

**setDomainEnv.sh overwritten by WLS patch**: Some WebLogic patch procedures regenerate \`setDomainEnv.sh\`. The JVM flag check on both the file and the running process distinguishes between "flag is in the file" (will be active after next restart) and "flag is in the running JVM" (currently active).

**New JDBC DataSource added without TCPS URL**: A new composite deployment that adds a DataSource via WLST may use a plain TCP URL. The DataSource URL check catches this — any DataSource with a \`jdbc:oracle:thin:@//\` URL (plain TCP) rather than a TCPS URL is flagged.

**Trust JKS not updated for new partner**: A new OSB business service calling an HTTPS endpoint whose CA is not in the trust JKS will fail at runtime. The outbound connectivity check catches this if the external endpoints list is kept up to date.

---

## Conclusion

A scripted TLS 1.2 verification strategy for SOA Suite 12c is not a post-implementation nicety — it is the mechanism that keeps TLS 1.2 actually enforced in a production environment that changes continuously. The script structure mirrors the implementation topology: one check function per layer, each producing a single-line pass/fail result, all aggregated into a daily report that alerts on any drift. The critical insight is that verification must cover both the negative case (TLS 1.0/1.1 rejected, not just TLS 1.2 accepted) and configuration consistency (JVM flags in the running process, not just in configuration files). The companion runbook provides the complete production-ready script with all check functions, the WLST WebLogic configuration reader, log rotation, cron scheduling, and email alerting.`,
};

async function main() {
  console.log('Inserting SOA TLS verification blog post...');
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
