import { config } from 'dotenv';
config({ path: '.env.local' });
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS 12.2 Outbound SOAP SSLHandshakeException: Fixing PKIX Path Validation Failures',
  slug: 'ebs-12-2-outbound-soap-pkix-ssl-truststore-fix',
  excerpt:
    'Outbound SOAP calls from Oracle EBS 12.2 fail with javax.net.ssl.SSLHandshakeException: PKIX path building failed when a vendor rotates their TLS certificate and the new CA chain is not in the EBS JVM truststore. This post explains exactly why the JVM rejects the handshake, where every affected truststore lives in an EBS 12.2 landscape, and how to import the correct certificates and make the change survive AutoConfig.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-17'),
  youtubeUrl: null,
  content: `Enterprise Oracle E-Business Suite 12.2 installations typically integrate with a dozen or more external services: a third-party compliance screening service, a logistics carrier API, a financial data aggregator, a payment gateway. These outbound SOAP connections run reliably for years — and then one day, without any change on the EBS side, they stop working.

The concurrent program fires, the integration layer attempts the outbound call, and the log file contains a stack trace that starts with:

\`\`\`
javax.net.ssl.SSLHandshakeException: sun.security.validator.ValidatorException:
PKIX path building failed: sun.security.provider.certpath.SunCertPathBuilderException:
unable to find valid certification path to requested target
\`\`\`

The integration worked in DEV, it worked in TEST, and it worked in PROD for years. What changed? Almost certainly: the external vendor renewed their TLS certificate, switched Certificate Authority providers, or added an intermediate CA to their chain — and the EBS JVM's truststore was not updated to recognise the new CA.

This post explains what the JVM is doing during a TLS handshake, why PKIX path validation fails, where the truststore lives in an EBS 12.2 installation, and how to fix it permanently in a way that survives AutoConfig.

---

## Understanding the PKIX Error — What the JVM Is Doing

When a Java application opens an HTTPS or SOAP/HTTPS connection, the underlying JVM executes the TLS handshake protocol. The sequence relevant to PKIX validation is:

1. The client (the EBS JVM) opens a TCP connection to the remote endpoint on port 443.
2. The server presents its certificate chain. A correctly configured server sends: the leaf certificate (the domain cert), one or more intermediate CA certificates, and sometimes the root CA certificate.
3. The JVM attempts to build a trusted certification path. It walks the chain from the leaf certificate upward, checking each issuer's signature against the next certificate in the chain. At the top, it must find a certificate whose issuer is itself — a self-signed root — that is present in the JVM's truststore (\`cacerts\`).
4. If the JVM reaches the top of the presented chain without finding a trusted anchor in \`cacerts\`, it throws \`SunCertPathBuilderException: unable to find valid certification path\`.

The critical asymmetry between browsers and Java: modern browsers aggressively download missing intermediate CA certificates using the Authority Information Access (AIA) extension embedded in certificates. The Java TLS implementation does **not** do this by default. The server must present the complete chain, **and** the root must already be in \`cacerts\`.

There are two common root causes:

**Root cause A — The vendor switched CA providers.** The old CA's root was in the default JDK \`cacerts\` (because it was a well-known CA included by Oracle). The new CA's root is not in \`cacerts\` (perhaps a less common CA, or a private/enterprise CA the vendor now uses).

**Root cause B — The vendor's server is misconfigured.** Their server presents only the leaf certificate without the intermediate CA. The JVM has the root in \`cacerts\` but cannot bridge from the leaf to the root without the intermediate. This is still a PKIX failure, even though the root CA is trusted. The fix is the same: import the intermediate CA explicitly into the EBS \`cacerts\`.

**EBS-specific complication:** EBS 12.2 may use the JDK's default \`cacerts\` file, or it may use a custom truststore specified via \`-Djavax.net.ssl.trustStore\` in the WLS startup arguments. If a custom truststore is in use, the standard JDK \`cacerts\` is completely bypassed — only the custom truststore matters, and it must receive the imported certificates.

---

## Oracle EBS 12.2 Architecture and Where the JVM Lives

A typical EBS 12.2 application tier runs multiple JVM processes, each with its own truststore configuration:

**WebLogic Managed Servers (oacore, oafm, forms-c4ws, oaea):** Each managed server runs as a separate JVM process managed by the WebLogic Node Manager. Outbound SOAP calls made from OA Framework application code, Java stored procedure integrations surfaced through the web tier, or any EBS module that calls an external web service from the application layer will use the truststore configured for these JVMs.

**Concurrent Processing Tier:** Java concurrent programs — programs whose execution method is set to "Java" in the Concurrent Programs form — run under a separate JVM that is independent of the WebLogic managed servers. If your outbound SOAP call is triggered from a concurrent program (the most common case for batch integrations), the concurrent tier JVM is involved, and it may use a completely different JDK and truststore than the WLS tier.

**Identifying which tier is making the call:** Check \`FND_LOG_MESSAGES\` for the request ID of the failing concurrent program. The stack trace will confirm whether the call is coming from the concurrent tier. If the SOAP call is made from a button or page in the EBS UI, the WLS managed server logs (typically under \`\$DOMAIN_HOME/servers/*/logs/\`) will contain the exception.

### Finding the Active Truststore

The JVM looks for its truststore in this order:

1. If \`-Djavax.net.ssl.trustStore=<path>\` is set in the WLS startup arguments, that file is used exclusively. The default \`cacerts\` is ignored.
2. If the system property is not set, the JVM defaults to \`\$JAVA_HOME/jre/lib/security/cacerts\`.

To find whether a custom truststore is configured:

\`\`\`bash
# Search WLS domain configuration for trustStore JVM arguments
grep -r "trustStore" \${DOMAIN_HOME}/config/config.xml 2>/dev/null | head -20

# Search EBS admin scripts for trustStore references
grep -r "trustStore" \${ADMIN_SCRIPTS_HOME}/*.sh 2>/dev/null | head -10

# Search WLS startup scripts and environment files
grep -r "trustStore" \${DOMAIN_HOME}/bin/ 2>/dev/null | head -10
\`\`\`

If no \`-Djavax.net.ssl.trustStore\` is found anywhere, the default \`cacerts\` at \`\$JAVA_HOME/jre/lib/security/cacerts\` is the truststore in use.

---

## Step-by-Step Fix: Identifying the Endpoint and Extracting the Certificate Chain

### Step 1 — Back Up the Truststore (Non-Negotiable)

Before modifying any \`cacerts\` file, take a timestamped backup. If you import a wrong or corrupt certificate, you need to be able to restore to a known-good state immediately.

\`\`\`bash
BACKUP_DATE=\$(date +%Y%m%d_%H%M%S)
FMW_CACERTS="\${FMW_HOME}/oracle_common/jdk/jre/lib/security/cacerts"

cp "\${FMW_CACERTS}" "\${FMW_CACERTS}.bak_\${BACKUP_DATE}"
echo "Backed up: \${FMW_CACERTS}.bak_\${BACKUP_DATE}"
ls -lh "\${FMW_CACERTS}"*
\`\`\`

### Step 2 — Identify the Failing Endpoint

From the stack trace or from the integration configuration (ISG endpoint configuration, WebADI setup, concurrent program parameters), extract the hostname and port of the external SOAP endpoint. Typical SOAP over HTTPS uses port 443.

\`\`\`sql
-- Find the failing concurrent request and its arguments to identify the endpoint
SELECT fcr.request_id,
       fcr.concurrent_program_name,
       fcr.argument_text,
       fcr.actual_completion_date
FROM fnd_concurrent_requests fcr
WHERE fcr.phase_code = 'C'
  AND fcr.status_code = 'E'
  AND fcr.actual_completion_date > SYSDATE - 1
ORDER BY fcr.actual_completion_date DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

### Step 3 — Fetch the Full Certificate Chain with OpenSSL

Run this from the EBS application tier (not from your laptop — the network path from the EBS tier is what matters):

\`\`\`bash
openssl s_client -connect external-api.example.com:443 -showcerts 2>/dev/null
\`\`\`

The \`-showcerts\` flag is critical. Without it, OpenSSL only displays the leaf certificate. With it, you see every certificate the server sends during the TLS handshake.

The output contains multiple \`-----BEGIN CERTIFICATE-----\` ... \`-----END CERTIFICATE-----\` blocks:
- **Block 0** (first): The leaf certificate — the domain cert for \`external-api.example.com\`
- **Block 1** (second): Intermediate CA certificate
- **Block 2** (third, if present): Another intermediate or the root CA

If the server is correctly configured, the last block will be the root CA (self-signed: Subject = Issuer). If only one block appears, the server is sending only the leaf, and you will need to track down the intermediate and root CA certificates separately (usually available from the CA's website or via the AIA extension in the leaf cert).

### Step 4 — Save Individual Certificates to Files

\`\`\`bash
# Redirect the full chain output
openssl s_client -connect external-api.example.com:443 -showcerts 2>/dev/null \
  > /tmp/full_chain.pem

# Extract individual certificates using awk
awk '/-----BEGIN CERTIFICATE-----/{n++; f="/tmp/cert_"n".pem"} f{print > f}
     /-----END CERTIFICATE-----/{f=""}' /tmp/full_chain.pem

ls -l /tmp/cert_*.pem
\`\`\`

### Step 5 — Verify Each Certificate Before Importing

Check the subject, issuer, and validity dates of each extracted certificate to confirm you know what you are about to import:

\`\`\`bash
for cert in /tmp/cert_*.pem; do
  echo "=== \${cert} ==="
  openssl x509 -in "\${cert}" -noout -subject -issuer -dates
  echo ""
done
\`\`\`

The last certificate in the chain (where Subject equals Issuer) is the root CA. That is the one that must be in \`cacerts\`. Intermediate CAs should also be imported to cover the case where the remote server does not send them.

### Step 6 — Import with keytool

\`\`\`bash
FMW_CACERTS="\${FMW_HOME}/oracle_common/jdk/jre/lib/security/cacerts"
KEYTOOL="\${FMW_HOME}/oracle_common/jdk/bin/keytool"

# Import intermediate CA
"\${KEYTOOL}" -importcert -trustcacerts -noprompt \
  -file /tmp/cert_2.pem \
  -alias vendor_intermediate_ca \
  -keystore "\${FMW_CACERTS}" \
  -storepass changeit

# Import root CA
"\${KEYTOOL}" -importcert -trustcacerts -noprompt \
  -file /tmp/cert_3.pem \
  -alias vendor_root_ca \
  -keystore "\${FMW_CACERTS}" \
  -storepass changeit
\`\`\`

The default \`cacerts\` password is \`changeit\`. If your site has changed this, use the site-specific password.

### Step 7 — Verify the Import

\`\`\`bash
"\${KEYTOOL}" -list -v \
  -keystore "\${FMW_CACERTS}" \
  -storepass changeit \
  | grep -A 8 "vendor_root_ca\|vendor_intermediate_ca"
\`\`\`

The output should show \`Entry type: trustedCertEntry\` and the correct subject and validity dates.

---

## The AutoConfig Trap — Making Changes Persistent

This is the most important section for EBS-specific deployments, and it is the step most commonly missed by administrators who have fixed the cacerts issue before in other Java environments.

EBS 12.2 uses AutoConfig to manage its configuration. AutoConfig reads the EBS context file (an XML file located at \`\$CONTEXT_FILE\` or found via \`\$APPL_TOP/admin/<SID>_<hostname>.xml\`) and regenerates WLS configuration files, WLS startup scripts, and environment files from templates.

**Any JVM argument set directly in the WLS Admin Console is overwritten the next time AutoConfig runs.**

This means: if you set \`-Djavax.net.ssl.trustStore=/u01/oracle/custom_cacerts\` in the WLS Admin Console's Server Start arguments tab, your fix will be silently undone the next time a DBA runs AutoConfig — typically as part of an EBS patch application.

### If You Are Using a Custom Truststore Path

If the investigation in the earlier section revealed that a custom truststore is in use (i.e., \`-Djavax.net.ssl.trustStore\` is already set somewhere), the JVM is not using the default \`cacerts\`. You must import into that custom file AND ensure the custom path persists through AutoConfig.

Use \`txkSetContextEV.sh\` to persist the JVM argument in the EBS context file:

\`\`\`bash
# Persist custom truststore JVM args in the EBS context file
\${FND_TOP}/bin/txkSetContextEV.sh \
  -contextfile="\${CONTEXT_FILE}" \
  -evname=s_weblogic_java_options \
  -evvalue="-Djavax.net.ssl.trustStore=/u01/oracle/custom_cacerts -Djavax.net.ssl.trustStorePassword=changeit"
\`\`\`

After running this command, verify the context file was updated:

\`\`\`bash
grep -A 2 "trustStore" "\${CONTEXT_FILE}"
\`\`\`

Then run AutoConfig to propagate the change to the WLS configuration files:

\`\`\`bash
\${ADMIN_SCRIPTS_HOME}/adautocfg.sh apps/<apps_password>
\`\`\`

After AutoConfig completes, verify the WLS startup configuration now reflects the truststore path:

\`\`\`bash
grep -r "trustStore" \${DOMAIN_HOME}/config/config.xml
\`\`\`

### If You Are Using the Default JDK cacerts

If no custom truststore path is configured and you are importing into the default \`\$JAVA_HOME/jre/lib/security/cacerts\`, the picture is simpler — no JVM argument needs to be added, and no AutoConfig persistence step is needed for the argument itself.

**However**, there is still an AutoConfig risk: AutoConfig may regenerate the \`\$JAVA_HOME\` symlink or replace the JDK directory as part of patching. If the JDK is replaced, the new \`cacerts\` will not contain your imported certificates. Document every certificate you have imported and maintain a script that re-applies the imports after a JDK replacement.

---

## Multi-Tier Coverage — Don't Fix Only Half the Problem

A common error is importing the certificate into the FMW JDK (used by WebLogic managed servers) but forgetting the RDBMS JDK (used by concurrent manager Java programs). If both tiers make SOAP calls, both must be fixed.

### Identifying Which JDK Each Tier Uses

\`\`\`bash
# FMW JDK (used by WebLogic managed servers)
FMW_JDK=\$(readlink -f \${FMW_HOME}/oracle_common/jdk 2>/dev/null || echo "NOT FOUND")
echo "FMW JDK: \${FMW_JDK}"
echo "FMW cacerts: \${FMW_JDK}/jre/lib/security/cacerts"

# RDBMS JDK (used by Java concurrent programs via the Concurrent Manager)
RDBMS_JDK=\$(readlink -f \${ORACLE_HOME}/jdk 2>/dev/null || echo "NOT FOUND")
echo "RDBMS JDK: \${RDBMS_JDK}"
echo "RDBMS cacerts: \${RDBMS_JDK}/jre/lib/security/cacerts"
\`\`\`

If the RDBMS JDK is different from the FMW JDK (they almost always are), repeat the \`keytool -importcert\` steps against the RDBMS JDK's \`cacerts\` as well:

\`\`\`bash
RDBMS_CACERTS="\${ORACLE_HOME}/jdk/jre/lib/security/cacerts"
RDBMS_KEYTOOL="\${ORACLE_HOME}/jdk/bin/keytool"

"\${RDBMS_KEYTOOL}" -importcert -trustcacerts -noprompt \
  -file /tmp/cert_2.pem \
  -alias vendor_intermediate_ca \
  -keystore "\${RDBMS_CACERTS}" \
  -storepass changeit

"\${RDBMS_KEYTOOL}" -importcert -trustcacerts -noprompt \
  -file /tmp/cert_3.pem \
  -alias vendor_root_ca \
  -keystore "\${RDBMS_CACERTS}" \
  -storepass changeit
\`\`\`

---

## Verification — Test Without Restarting First

Before cycling services, confirm that the TLS handshake now passes using the updated truststore:

\`\`\`bash
# Test 1: OpenSSL with the updated cacerts as the trust anchor
openssl s_client -connect external-api.example.com:443 \
  -CAfile "\${FMW_HOME}/oracle_common/jdk/jre/lib/security/cacerts" \
  -verify_return_error 2>&1 | grep -E "Verify return code|subject|issuer"

# Expected output: Verify return code: 0 (ok)
# If still failing: the root CA import did not succeed — verify the alias
\`\`\`

\`\`\`bash
# Test 2: Check that the alias is present in cacerts
"\${FMW_HOME}/oracle_common/jdk/bin/keytool" -list \
  -keystore "\${FMW_HOME}/oracle_common/jdk/jre/lib/security/cacerts" \
  -storepass changeit \
  -alias vendor_root_ca
\`\`\`

If the OpenSSL test returns \`Verify return code: 0 (ok)\` but the JVM still fails after restart, confirm that the JVM is actually reading the cacerts file you modified (check for \`-Djavax.net.ssl.trustStore\` in the running process arguments with \`ps -ef | grep trustStore\`).

---

## Restart Procedure

After importing the certificates, both the WebLogic managed servers and the Concurrent Manager must be restarted for the changes to take effect. JVMs do not hot-reload the truststore.

\`\`\`bash
# Full EBS application tier service stop
\${ADMIN_SCRIPTS_HOME}/adstpall.sh apps/<apps_password>

# Confirm all services have stopped
sleep 30
ps -ef | grep -E "oacore|oafm|forms|AdminServer|FNDLIBR" | grep -v grep

# Full EBS application tier service start
\${ADMIN_SCRIPTS_HOME}/adstrtal.sh apps/<apps_password>
\`\`\`

For a targeted restart (only the managed server affected by the SOAP call), use the WLS Admin Console — navigate to the managed server under Environment → Servers, then use Control → Restart. However, after a truststore change, a full bounce is strongly recommended to ensure consistency across all JVMs.

Monitor the startup in the Admin Server log:

\`\`\`bash
tail -f \${DOMAIN_HOME}/servers/AdminServer/logs/AdminServer.log
\`\`\`

---

## Certificate Lifecycle Management — Preventing the Next Incident

The core problem is reactive: you discovered the certificate issue when the integration broke. The fix for this is a proactive monitoring script that checks every external SOAP endpoint certificate against the EBS truststore on a weekly schedule.

Key items to build into a monitoring runbook:

**1. Inventory all external SOAP endpoints.** The EBS ISG configuration, WebADI definitions, and any custom concurrent program source code are the sources of truth. Document every hostname:port that EBS calls outbound.

**2. Weekly expiry check.** A cron script that runs \`openssl s_client | openssl x509 -noout -enddate\` against each endpoint and alerts if the certificate expires within 60 days gives you time to import the new CA chain before the failure.

**3. Trust check.** Beyond expiry, run a nightly check that verifies each endpoint's current certificate chain is trusted by the current EBS cacerts:

\`\`\`bash
openssl s_client -connect external-api.example.com:443 \
  -CAfile \${FMW_HOME}/oracle_common/jdk/jre/lib/security/cacerts \
  -verify_return_error 2>&1 | grep "Verify return code"
\`\`\`

A return code other than 0 triggers an immediate alert.

**4. Coordinate with vendors.** For any critical integration, ask your external service provider to notify you at least 90 days before they rotate their TLS certificate or change CA providers. Many enterprise vendors have a change management process that includes customer notification.

**5. Document the cacerts state.** After every import, run \`keytool -list\` and save the output to a file tracked in version control. This makes it trivial to audit what was added, by whom, and when.

---

## Summary

PKIX path validation failures in EBS 12.2 outbound SOAP are always a JVM trust problem. The chain of causation: a vendor rotates their TLS certificate, the new CA chain is not in the EBS JVM's \`cacerts\`, and every outbound SOAP call to that endpoint fails with \`SSLHandshakeException\`.

The resolution path:

1. Identify the failing endpoint from the FND log or WLS server log.
2. Determine which truststore the affected JVM is actually using (default \`cacerts\` or a custom truststore via \`-Djavax.net.ssl.trustStore\`).
3. Extract the full certificate chain from the remote endpoint using \`openssl s_client -showcerts\`.
4. Import the intermediate and root CA certificates into the correct \`cacerts\` file — and into **both** the FMW JDK and the RDBMS JDK if both tiers make outbound SOAP calls.
5. If a custom truststore path is in use, persist that path through AutoConfig using \`txkSetContextEV.sh\` so it survives the next EBS patch application.
6. Verify the TLS handshake passes with \`openssl s_client -CAfile\` before restarting services.
7. Bounce all EBS application services to force JVMs to reload the truststore.
8. Deploy a proactive monitoring script that checks all SOAP endpoints for trust and expiry on a weekly schedule.

The companion premium runbook includes the full diagnostic and import scripts, the AutoConfig persistence steps, and the complete endpoint monitoring script ready to drop into cron.`,
};

async function main() {
  console.log('Inserting EBS PKIX SSL truststore blog post...');
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
