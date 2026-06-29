import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'SSL Certificate Chain Depth: Why Your Certificates Fail in Some Systems but Not Others',
  slug: 'ssl-certificate-chain-depth-oracle-ebs',
  excerpt:
    'A technical guide to SSL/TLS certificate chain depth: what chain depth means, how each layer of a chain is verified, why depth limits differ across Oracle Wallet, Java cacerts, OpenSSL, and browser trust stores, and why a certificate that validates perfectly in a browser fails with ORA-29024 in Oracle EBS or throws a PKIX path building failure in WebLogic. Includes concrete examples with three-tier and four-tier certificate chains and the exact verification logic each component applies.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-29'),
  youtubeUrl: null,
  content: `## Introduction

A production payment gateway migration completes and is declared successful — the browser team confirms that the new endpoint is reachable and the TLS handshake succeeds. Two days later the Apps DBA gets a call: Oracle EBS cannot connect to the payment gateway. The error is \`ORA-29024: Certificate validation failure\`. The browser still works. The Java-based integration test still works. Only the PL/SQL UTL_HTTP calls fail.

The root cause in most cases like this is **certificate chain depth**: the new gateway is using a certificate issued by a Certificate Authority that sits deeper in a chain than the calling component is configured to trust, or the chain includes a cross-signed root that one trust store recognizes and another does not.

Certificate chain depth is one of the most common and least well understood causes of TLS failures in enterprise application stacks. The same certificate chain can be trusted by a browser, rejected by the JVM, trusted by OpenSSL, and rejected by Oracle's database SSL library — simultaneously, without any of these systems being "wrong."

This article explains exactly what certificate chain depth means, why different components enforce it differently, and how to diagnose which component is rejecting a chain and why.

---

## What Is Certificate Chain Depth?

Every TLS certificate exists within a chain of trust. The chain has three roles:

**Leaf certificate** (depth 0): The certificate presented by the server you are connecting to. It contains the server's hostname (in the Subject CN or Subject Alternative Name), its public key, and the name of the CA that signed it. The leaf is at depth 0.

**Intermediate CA certificate(s)** (depth 1, 2, ...): One or more Certificate Authority certificates that form the chain between the leaf and the root. An intermediate CA is trusted because it was signed by the root CA (or by another intermediate). Depth 1 is the first intermediate above the leaf; depth 2 is the next, and so on.

**Root CA certificate** (depth N): The self-signed certificate at the top of the chain. It is trusted not because anything signed it but because it appears in the client's local trust store — a list of CAs that the client has been configured to trust unconditionally.

\`\`\`
Certificate Chain (depth increases toward the root):

  Depth 0: server.payment-gateway.com (leaf — signed by Intermediate CA 1)
  Depth 1: Intermediate CA 1 (signed by Root CA)
  Depth 2: Root CA (self-signed — trusted anchor)
\`\`\`

The **chain depth** is the number of certificates in the chain from the leaf to (and including) the root. The example above has a depth of 2 (leaf, one intermediate, root). A chain with two intermediates has a depth of 3.

### Why Intermediate CAs Exist

Root CAs are kept offline — their private keys are stored in hardware security modules in physically secure facilities, used only to sign intermediate CA certificates. The intermediates are online and do the actual day-to-day work of signing leaf certificates for servers. This model limits the blast radius of a compromise: if an intermediate's private key is stolen, only the intermediate is revoked. The root remains intact and the CA can issue a new intermediate.

The consequence for operations: every CA uses at least one intermediate. Modern CAs use two or more. A chain depth of 3 (leaf + two intermediates + root) is now common, and chains of depth 4 are not unusual for enterprise CAs that operate a policy CA between the root and the issuing CA.

---

## How Chain Verification Works

When a TLS client receives a certificate chain from a server, it verifies the chain by walking it from the leaf toward the root:

1. Is the leaf certificate's signature valid (i.e., was it signed by the key in the next certificate in the chain)?
2. Is the next certificate a valid CA certificate (has the CA:TRUE Basic Constraints extension)?
3. Is the leaf certificate's validity period current?
4. Repeat steps 1–3 for each intermediate until the root is reached
5. Is the root certificate in the local trust store?

Each step must pass. If any certificate in the chain has expired, been revoked, or was signed by a key that does not match the next certificate in the chain, verification fails. If the root is not in the local trust store, verification fails — even if every other check passes.

The **path length constraint** is a field in the Basic Constraints extension of a CA certificate that limits how many additional CA certificates can appear below it in the chain. A path length of 0 means the CA can only sign leaf certificates, not subordinate CAs. Path length of 1 means the CA can sign one level of subordinate CAs, but those subordinates can only sign leaves. This field is set by the CA when it creates the certificate and is enforced by the verifying client.

---

## Why Depth Limits Differ Across Components

Each TLS implementation has its own configured maximum chain depth and its own behavior when that maximum is exceeded. This is the core reason why the same chain works in one system and fails in another.

### Browser Trust Stores

Modern browsers (Chrome, Firefox, Safari, Edge) do not enforce a strict maximum chain depth in typical configurations. They use a path building algorithm that attempts to construct a valid chain from the leaf to any trusted root in the browser's trust store, trying multiple paths if necessary. Browsers also implement **AIA fetching** — if an intermediate CA certificate is missing from the chain the server sends, the browser fetches it automatically from the URI embedded in the leaf's Authority Information Access extension.

This is why browsers appear to work with almost any certificate: they actively help build the trust chain. PL/SQL UTL_HTTP does none of this.

### Oracle Wallet (UTL_HTTP)

Oracle's SSL/TLS library, used by UTL_HTTP, DBMS_LDAP_UTL, and Oracle Advanced Security network encryption, reads the Oracle Wallet for trusted CA certificates. It does not perform AIA fetching. It does not try alternative paths. It evaluates exactly the chain presented by the server against exactly the certificates in the wallet.

The Oracle Wallet library enforces a **maximum chain depth of 4** by default (configurable in \`sqlnet.ora\` via the \`SSL_VERSION\` and \`SSL_CIPHER_SUITES\` parameters, though depth itself is a compile-time limit in some versions).

A chain that includes a cross-certified root will fail if the cross-certification adds a fifth certificate to the chain. A chain where the server sends only the leaf and skips the intermediate will fail because Oracle cannot fetch the intermediate from AIA.

**Critical implication**: Every certificate in the chain that Oracle needs for verification must be present in the wallet. The server does not have to send every certificate (browsers tolerate this), but the Oracle Wallet must have them.

### Java / JVM (WebLogic, Concurrent Programs, Java-based Integrations)

The JVM uses the JSSE (Java Secure Socket Extension) SSL library. It validates chains against the JVM's truststore (\`cacerts\`) or a custom truststore configured for the application.

The Java JSSE implementation enforces a maximum path length of **5 by default** (configurable via the \`jdk.certpath.disabledAlgorithms\` and related security properties). Java also does not perform AIA fetching by default (this can be enabled with the \`com.sun.security.enableAIAcaIssuers=true\` JVM property, but it is off by default in most enterprise configurations).

Java's \`PKIX path building failed\` error is the Java equivalent of ORA-29024 — the JVM could not construct a valid path to a trusted root.

### OpenSSL (Command Line, Many Linux Applications)

OpenSSL uses the OS certificate store (on RHEL: \`/etc/pki/ca-trust/\`) or a specified CA bundle. The default maximum chain depth in OpenSSL is **100**, effectively unlimited for practical purposes. OpenSSL supports AIA fetching via the \`-verify_depth\` option.

This is why \`openssl s_client -connect host:443\` returns "Verify return code: 0 (ok)" but Oracle fails: OpenSSL's liberal defaults mask chain depth issues that strict verifiers catch.

### Oracle HTTP Server / mod_ssl

Oracle HTTP Server uses the Oracle SSL library (same as the database tier) for incoming TLS on port 443. For outbound SSL (proxied requests), it uses the system OpenSSL. Both have their own trust stores and depth limits.

---

## Example 1: Three-Certificate Chain (Standard — Works Everywhere)

\`\`\`
Server sends:
  [0] server.example.com (leaf)
      Signed by: DigiCert TLS RSA SHA256 2020 CA1
  [1] DigiCert TLS RSA SHA256 2020 CA1 (intermediate)
      Signed by: DigiCert Global Root CA

Client trust store has:
  DigiCert Global Root CA (depth 2 — root)

Verification path:
  server.example.com → DigiCert TLS RSA SHA256 2020 CA1 → DigiCert Global Root CA
  Chain depth: 3 (leaf + 1 intermediate + root)
  Path length: 2 (two hops from leaf to root)

Result: Valid in Oracle Wallet, Java, OpenSSL, browsers — all pass
\`\`\`

### Diagnosing This Chain

\`\`\`bash
# Verify the chain depth from the command line
openssl s_client -connect server.example.com:443 -showcerts 2>/dev/null | \\
  grep -c "BEGIN CERTIFICATE"
# Output: 2 (server sends leaf + 1 intermediate; root is in trust store, not sent)

# Show each certificate's subject and issuer
openssl s_client -connect server.example.com:443 -showcerts 2>/dev/null | \\
  openssl x509 -noout -subject -issuer
\`\`\`

---

## Example 2: Four-Certificate Chain (Long — Fails in Some Oracle Wallets)

Some enterprise CAs use a Policy CA between the Root CA and the Issuing CA:

\`\`\`
Server sends:
  [0] api.payment-gateway.com (leaf)
      Signed by: Gateway Issuing CA
  [1] Gateway Issuing CA (intermediate, depth 1)
      Signed by: Gateway Policy CA
  [2] Gateway Policy CA (intermediate, depth 2)
      Signed by: Enterprise Root CA

Client trust store has:
  Enterprise Root CA (depth 3 — root)

Verification path:
  api.payment-gateway.com
    → Gateway Issuing CA
    → Gateway Policy CA
    → Enterprise Root CA
  Chain depth: 4 (leaf + 2 intermediates + root)
  Path length: 3

Result:
  Browser: PASS (path building tolerates depth 4)
  OpenSSL: PASS (default depth limit 100)
  Java JVM: PASS (default depth limit 5 — depth 4 is under the limit)
  Oracle Wallet: DEPENDS on Oracle version and wallet configuration
                 (some versions reject at depth > 3 without wallet update)
\`\`\`

### Why This Fails in Oracle Wallet

If the Oracle Wallet contains only the Root CA and the Issuing CA (depth 1 intermediate) — the common minimum configuration — the Policy CA (depth 2 intermediate) is missing. Oracle does not fetch it from AIA. It evaluates the chain exactly as provided and cannot build a path from the Issuing CA to the Root CA without the Policy CA.

The fix: add the Policy CA certificate to the Oracle Wallet with \`orapki wallet add -trusted_cert\`.

\`\`\`bash
# Get all certificates in the chain
openssl s_client -connect api.payment-gateway.com:443 -showcerts 2>/dev/null > /tmp/chain.pem

# Extract each certificate block
# cert 0: leaf (skip)
# cert 1: Gateway Issuing CA
# cert 2: Gateway Policy CA
awk '/BEGIN CERT/{i++} i==2' /tmp/chain.pem > /tmp/issuing_ca.pem
awk '/BEGIN CERT/{i++} i==3' /tmp/chain.pem > /tmp/policy_ca.pem

# Verify what each cert is
openssl x509 -in /tmp/issuing_ca.pem -noout -subject -issuer
openssl x509 -in /tmp/policy_ca.pem -noout -subject -issuer

# Add both intermediates to the Oracle Wallet
WALLET=/path/to/oracle/wallet
orapki wallet add -wallet \${WALLET} -trusted_cert -cert /tmp/policy_ca.pem -pwd \${WALLET_PWD}
orapki wallet add -wallet \${WALLET} -trusted_cert -cert /tmp/issuing_ca.pem -pwd \${WALLET_PWD}
orapki wallet add -wallet \${WALLET} -trusted_cert -cert /tmp/root_ca.pem -pwd \${WALLET_PWD}

# Verify wallet contents
orapki wallet display -wallet \${WALLET} -complete
\`\`\`

---

## Example 3: Cross-Signed Root (Legacy Compatibility — Adds Invisible Depth)

When a CA migrates from an old root to a new root, it issues a **cross-certificate**: the new root signs the old root's public key, creating an alternate trust path. This allows clients that only have the old root to continue validating new certificates during the transition. Clients that have the new root use the shorter path.

\`\`\`
Server sends:
  [0] app.example.com (leaf)
  [1] Let's Encrypt R3 (intermediate)
  [2] ISRG Root X1 (new root — cross-signed by DST Root CA X3 for legacy)

Client trust store A (modern — has ISRG Root X1):
  Verification: app.example.com → R3 → ISRG Root X1
  Chain depth: 3 — PASS

Client trust store B (legacy — has DST Root CA X3 only):
  Server sends optional cross-cert: ISRG Root X1 signed by DST Root CA X3
  Verification: app.example.com → R3 → ISRG Root X1 (cross) → DST Root CA X3
  Chain depth: 4 — may fail in strict verifiers

Oracle Wallet with DST Root CA X3 (expired Sept 2021):
  DST Root CA X3 expired → ORA-29024 regardless of chain depth
  Fix: add ISRG Root X1 to the wallet as a trusted root
\`\`\`

This is the exact failure pattern that caused widespread Let's Encrypt certificate failures in September 2021, particularly in Oracle and Java environments that had not updated their trust stores.

---

## Diagnosing Depth Failures in Production

### Step 1: Fetch the Actual Chain

Always run \`openssl s_client\` from the **server where the failure occurs** — not from a workstation or jump box. The chain the server presents may vary by source IP, load balancer path, or TLS extension negotiation.

\`\`\`bash
# Fetch full chain from the server experiencing the failure
openssl s_client -connect api.gateway.example.com:443 -showcerts 2>/dev/null | \\
  awk '/BEGIN CERT/,/END CERT/' | \\
  csplit - '/BEGIN CERT/' '{*}' --prefix=/tmp/cert --suffix-format='%02d.pem' -z

# Examine each certificate
for CERT in /tmp/cert*.pem; do
  echo "=== \${CERT} ==="
  openssl x509 -in \${CERT} -noout -subject -issuer -dates
  echo ""
done
\`\`\`

### Step 2: Count the Depth

\`\`\`bash
# Count certificates in the chain (server-sent, not including trust store root)
openssl s_client -connect api.gateway.example.com:443 -showcerts 2>/dev/null | \\
  grep -c "BEGIN CERTIFICATE"
# Depth = this count + 1 (for the root, which is in trust store, not sent)
\`\`\`

### Step 3: Verify Against Each Trust Store

\`\`\`bash
# Test against Oracle Wallet (wallet path from UTL_HTTP.SET_WALLET or sqlnet.ora)
openssl verify -CAfile /path/to/oracle/wallet/cwallet.pem /tmp/cert00.pem

# Test against Java cacerts
keytool -printcert -file /tmp/cert00.pem -v | grep -A3 "Chain length"

# Test against system trust store
openssl verify -CApath /etc/pki/ca-trust/extracted/pem/ /tmp/cert00.pem
\`\`\`

### Step 4: Test via PL/SQL

\`\`\`sql
SET SERVEROUTPUT ON SIZE 1000000

DECLARE
  v_req  UTL_HTTP.REQ;
  v_resp UTL_HTTP.RESP;
BEGIN
  UTL_HTTP.SET_WALLET('file:/path/to/oracle/wallet', 'wallet_password');
  UTL_HTTP.SET_TRANSFER_TIMEOUT(30);
  v_req  := UTL_HTTP.BEGIN_REQUEST('https://api.gateway.example.com/', 'GET');
  v_resp := UTL_HTTP.GET_RESPONSE(v_req);
  DBMS_OUTPUT.PUT_LINE('HTTP status: ' || v_resp.status_code);
  UTL_HTTP.END_RESPONSE(v_resp);
EXCEPTION
  WHEN OTHERS THEN
    DBMS_OUTPUT.PUT_LINE('ERROR: ' || SQLERRM);
END;
/
-- ORA-29024 still here = wallet missing a CA cert for this chain depth
-- HTTP status returned = chain verified successfully
\`\`\`

---

## Summary

Certificate chain depth failures are consistent in one respect: the browser always works and something deeper in the stack does not. The reason is that browsers are intentionally liberal — they fetch missing intermediates, try multiple paths, and accept cross-certified chains. Oracle's UTL_HTTP, the JVM's JSSE, and other programmatic TLS clients are intentionally strict — they evaluate only what is presented and only against what is explicitly configured in their trust store.

The resolution is always one of two things:

1. **Add the missing intermediate or root CA certificate to the appropriate trust store** — Oracle Wallet, Java cacerts, or WebLogic custom truststore, depending on which component is failing.

2. **Understand which trust store governs which code path**: UTL_HTTP uses the Oracle Wallet. Java concurrent programs and WebLogic use the JVM cacerts or WebLogic truststore. Oracle HTTP Server inbound TLS uses the OHS wallet. Oracle HTTP Server outbound proxying uses the OS trust store. A fix in one trust store has no effect on the others.

The companion runbook provides the complete diagnostic command sequence, trust store update procedures for each component, and automated monitoring scripts that detect chain depth changes and expiry dates before they cause production outages.`,
};

async function main() {
  console.log('Inserting certificate chain depth blog post...');
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
