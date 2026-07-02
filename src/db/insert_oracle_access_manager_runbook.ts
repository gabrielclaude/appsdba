import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Access Manager — Installation, WebGate Configuration, and Troubleshooting',
  slug: 'oracle-access-manager-runbook',
  excerpt:
    'Step-by-step operational runbook for Oracle Access Manager 12c: RCU schema creation, domain configuration, start/stop sequences, identity store registration, WebGate installation, Application Domain policy setup, certificate rotation, session management, and a comprehensive troubleshooting table.',
  category: 'identity-management' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-07-02'),
  youtubeUrl: null,
  content: `## Overview

This runbook covers the full lifecycle of an Oracle Access Manager (OAM) 12c deployment: from infrastructure prerequisites through RCU schema creation, domain configuration, WebGate installation, Application Domain policy setup, certificate management, session operations, and daily health monitoring. Follow the steps in sequence for a new installation. For ongoing operations, jump directly to the relevant section.

---

## Prerequisites

### Hardware Minimums Per Node (Production)

| Component | CPU | RAM | Storage |
|---|---|---|---|
| OAM Server | 8 cores | 32 GB | 100 GB /u01 |
| Oracle DB (policy/session store) | 4 cores | 16 GB | 200 GB |
| OHS + WebGate | 4 cores | 8 GB | 50 GB |

For development or staging, you can consolidate OAM Server and OHS on a single 8-core / 32 GB host, but never run OAM Server and the identity store LDAP on the same host in production — LDAP CPU spikes will starve OAM.

### Software Stack

- Oracle Linux 8 or RHEL 8 (kernel 4.18+)
- Oracle JDK 11 (not OpenJDK — use the Oracle-signed JDK for WebLogic compatibility)
- Oracle WebLogic Server 12.2.1.4
- Oracle HTTP Server 12.2.1.4 (for WebGate host)
- Oracle Unified Directory 12.2.1.4 (identity store and policy store)
- Oracle Access Manager 12.2.1.4

### Pre-Installation Checklist

- [ ] All hostnames resolve correctly in both directions (forward and reverse DNS)
- [ ] NTP synchronized across all hosts (clock skew breaks SAML assertions and Coherence)
- [ ] Oracle DB listener running and \`ORCL\` (or target) service reachable from OAM host
- [ ] Ports open: 7001 (WLS Admin), 14100 (OAM Managed), 5575 (OAP), 1389 (OUD LDAP)
- [ ] \`/u01/oracle\` filesystem mounted with sufficient space
- [ ] OAM installer binary downloaded and checksum verified

---

## Step 1: RCU Schema Creation

Repository Creation Utility (RCU) creates the database schemas that OAM requires for audit logging (IAU), platform security (OPSS), metadata (MDS), and service table (STB).

\`\`\`bash
export ORACLE_HOME=/u01/oracle/middleware/Oracle_Home
export JAVA_HOME=/u01/oracle/jdk11

\${ORACLE_HOME}/oracle_common/bin/rcu \\
  -silent \\
  -createRepository \\
  -databaseType ORACLE \\
  -connectString db-host:1521:orcl \\
  -dbUser sys \\
  -dbRole sysdba \\
  -schemaPrefix OAM \\
  -component IAU \\
  -component IAU_APPEND \\
  -component IAU_VIEWER \\
  -component OPSS \\
  -component MDS \\
  -component STB \\
  -f < /tmp/rcu_passwords.txt
\`\`\`

The file \`/tmp/rcu_passwords.txt\` must contain one password per line: the SYS DBA password on the first line, then a schema password for all OAM schemas on the second line. Delete this file immediately after RCU completes.

### Post-RCU Validation

Connect to the database as SYS or DBA and confirm all schemas were created:

\`\`\`sql
SELECT username, account_status, created
FROM dba_users
WHERE username LIKE 'OAM%'
   OR username LIKE 'IAU%'
ORDER BY created;
\`\`\`

Expected output: \`OAM_IAU\`, \`OAM_IAU_APPEND\`, \`OAM_IAU_VIEWER\`, \`OAM_OPSS\`, \`OAM_MDS\`, \`OAM_STB\` — all with status \`OPEN\`.

---

## Step 2: Domain Creation

### Run the Config Wizard

\`\`\`bash
\${ORACLE_HOME}/oracle_common/common/bin/config.sh -silent \\
  -responseFile /tmp/oam_domain.rsp
\`\`\`

### Key Response File Parameters

\`\`\`
DOMAIN_NAME=oam_domain
ADMIN_SERVER_PORT=7001
ADMIN_SERVER_SSL_PORT=7002
OAM_MANAGED_SERVER_PORT=14100
OAM_MANAGED_SERVER_SSL_PORT=14101
DOMAIN_HOME=/u01/oracle/domains/oam_domain
\`\`\`

Ensure \`DOMAIN_HOME\` is on a filesystem with at least 10 GB free — OAM diagnostic logs grow quickly.

### Run OAM Configuration Assistant

After domain creation completes, run the OAM-specific configuration assistant to wire the database schemas:

\`\`\`bash
\${ORACLE_HOME}/idm/bin/config.sh
\`\`\`

In the GUI wizard:
1. Select **Configure Oracle Access Manager**
2. Database: provide the connect string, schema prefix (\`OAM\`), and schema password
3. Admin credentials: set the OAM administrator username and password
4. Complete and wait for the "Configuration Successful" confirmation

---

## Step 3: Start and Stop Sequence

The start sequence is critical. Starting components out of order will cause OAM managed server to fail while attempting to connect to the Admin Server.

### Start Order

\`\`\`bash
# 1. Node Manager (must start first on each host)
cd /u01/oracle/domains/oam_domain/bin
nohup ./startNodeManager.sh > /u01/logs/nm.log 2>&1 &

# 2. Admin Server (wait until log shows "Server state changed to RUNNING")
nohup ./startWebLogic.sh > /u01/logs/admin.log 2>&1 &

# Monitor until RUNNING:
tail -f /u01/logs/admin.log | grep -m1 "RUNNING"

# 3. OAM Managed Server (via WLST)
\${ORACLE_HOME}/oracle_common/common/bin/wlst.sh <<'EOF'
connect('weblogic','password','t3://admin-host:7001')
start('oam_server1','Server')
EOF
\`\`\`

### Stop Order (Reverse)

\`\`\`bash
\${ORACLE_HOME}/oracle_common/common/bin/wlst.sh <<'EOF'
connect('weblogic','password','t3://admin-host:7001')
shutdown('oam_server1','Server',ignoreSessions=true)
shutdown('AdminServer','Server')
EOF
\`\`\`

Stop Node Manager last, after Admin Server is fully down:

\`\`\`bash
kill $(cat /u01/oracle/domains/oam_domain/nodemanager/nodemanager.process.id)
\`\`\`

### Key URLs

| URL | Purpose |
|---|---|
| http://host:7001/console | WebLogic Admin Console |
| http://host:7001/em | Enterprise Manager (FMW Control) |
| http://host:14100/oamconsole | OAM Administration Console |
| http://host:14100/oam/server/logout | OAM health check endpoint |

---

## Step 4: Identity Store Configuration

Register your LDAP directory as the OAM identity store. This is how OAM knows where to look up user credentials and attributes.

### Registration Steps

1. Navigate to: **OAM Admin Console → System Configuration → Data Sources → User Identity Stores → Create**
2. Fill in the following fields:

| Field | Value |
|---|---|
| Store Name | Corporate_LDAP |
| Store Type | OUD / Oracle Directory Server / Active Directory (select appropriate) |
| Location | oud-host.example.com:1389 |
| Bind DN | cn=oam-bind,cn=Users,dc=example,dc=com |
| Bind Password | (entered once, stored in CSF automatically) |
| User Search Base | ou=People,dc=example,dc=com |
| User Attribute | uid (OUD/OID) or sAMAccountName (Active Directory) |

3. Click **Test Connection** — it must succeed before saving. If it fails, verify network connectivity to port 1389 (or 389/636) and that the bind DN and password are correct.
4. Click **Save**.
5. Set as Primary Store: **System Configuration → Access Manager Settings → Primary Identity Store** → select \`Corporate_LDAP\` → Save.

### Validate Identity Store

Test that OAM can find a known user:

1. OAM Admin Console → System Configuration → Data Sources → User Identity Stores → Corporate_LDAP → **Test**
2. Enter a valid username and password
3. Confirm "Authentication Successful" and that user attributes (uid, cn, mail) are returned

---

## Step 5: WebGate Installation and Registration

WebGate must be installed on every application server (OHS or Apache) that you want OAM to protect. There are two phases: register the WebGate in OAM (which generates the configuration artifacts), then install the WebGate binary and artifacts on the OHS host.

### Step 5a — Register WebGate in OAM Console

1. OAM Admin Console → System Configuration → Access Manager → SSO Agents → **Create OAM WebGate**
2. Configure:
   - **Name**: ohs_webgate_prod
   - **Security**: Open (development) or Cert (production — requires certificate exchange)
   - **Primary OAM Server**: oam-server1.example.com:5575
   - **Secondary OAM Server**: oam-server2.example.com:5575 (for HA)
3. Save, then click **Download** to retrieve the generated artifacts: \`cwallet.sso\` (the credential wallet) and \`ObAccessClient.xml\` (the WebGate configuration file). Save both to \`/tmp/webgate_artifacts/\` on your workstation.

### Step 5b — Install WebGate on OHS Host

Transfer the artifacts to the OHS host, then run the WebGate deployment tool:

\`\`\`bash
# Deploy WebGate into the OHS instance directory
\${ORACLE_HOME}/webgate/ohs/tools/deployWebGate/deployWebGateInstance.sh \\
  -w \${ORACLE_HOME}/user_projects/domains/ohs_domain/config/fmwconfig/components/OHS/ohs1 \\
  -oh \${ORACLE_HOME}

# Copy the OAM-generated artifacts into the WebGate config directory
cp /tmp/webgate_artifacts/cwallet.sso \\
  \${OHS_DOMAIN}/config/fmwconfig/components/OHS/ohs1/webgate/config/
cp /tmp/webgate_artifacts/ObAccessClient.xml \\
  \${OHS_DOMAIN}/config/fmwconfig/components/OHS/ohs1/webgate/config/
\`\`\`

### Step 5c — Configure OHS to Load the WebGate Module

Add the following directives to the OHS \`httpd.conf\` (or a \`webgate.conf\` include file):

\`\`\`
LoadModule webgate_module "\${ORACLE_HOME}/webgate/ohs/lib/libwebgate.so"
WebGateInstalldir "\${OHS_DOMAIN}/config/fmwconfig/components/OHS/ohs1/webgate"
WebGateMode ObResourceRequired
\`\`\`

Restart OHS and verify the module loaded without errors:

\`\`\`bash
grep -i "webgate" \${OHS_DOMAIN}/servers/ohs1/logs/ohs1-access.log
\`\`\`

You should see a WebGate initialization message. If OHS fails to start, check the OHS error log for \`libwebgate.so\` dependency issues — typically a missing \`libgcc\` or \`libstdc++\` version on RHEL.

---

## Step 6: Application Domain and Policy Configuration

An Application Domain is the container for all OAM policies protecting a given application. For an EBS deployment, you create one domain per EBS environment (prod, stage, dev).

### Create the Application Domain

1. OAM Admin Console → Application Domains → **Create**
2. Name: \`EBS_Application_Domain\`
3. Host Identifiers: \`ebs.example.com\` (port 443) — add all hostnames (and ports) through which users access EBS
4. Save

### Define Protected Resources

1. Within the domain, go to **Resources → Create**
2. Resource URL: \`/OA_HTML/.*\` (protects all EBS HTML URLs with a regex pattern)
3. Resource Type: HTTP
4. Save

### Create the Authentication Policy

1. **Application Domains → EBS_Application_Domain → Authentication Policies → Create**
2. Policy Name: \`EBS_Auth_Policy\`
3. Resources: \`/OA_HTML/.*\`
4. Authentication Scheme: \`LDAPScheme\` (form-based LDAP login)
5. Save

### Create the Authorization Policy

1. **Application Domains → EBS_Application_Domain → Authorization Policies → Create**
2. Policy Name: \`EBS_Authz_Policy\`
3. Resources: \`/OA_HTML/.*\`
4. Condition:
   - Type: Identity Condition
   - Group: \`CN=EBS-Users,OU=Groups,DC=example,DC=com\`
5. Response — add an HTTP Header action:
   - Name: \`OAM_REMOTE_USER\`
   - Value: \`\${user.attr.uid}\`
6. Save

The response header action is what passes the authenticated username to EBS. Without it, EBS will not know who the user is even though OAM successfully authenticated them.

---

## Step 7: Policy Store Maintenance

The OAM policy store lives in LDAP under \`cn=OAMConfig\`. OAM versions every policy object it manages, so the policy store grows over time. Periodically export the policy store to a backup location.

### Export Policy Store

\`\`\`bash
\${ORACLE_HOME}/oracle_common/common/bin/wlst.sh <<'EOF'
connect('weblogic','password','t3://admin-host:7001')
exportMetadata(application='oam',server='oam_server1',
  toLocation='/tmp/oam_policy_backup_20260702')
EOF
\`\`\`

### Import Policy Store (After Restore)

\`\`\`bash
\${ORACLE_HOME}/oracle_common/common/bin/wlst.sh <<'EOF'
connect('weblogic','password','t3://admin-host:7001')
importMetadata(application='oam',server='oam_server1',
  fromLocation='/tmp/oam_policy_backup_20260702')
EOF
\`\`\`

Import requires a running OAM server. Stop all applications accessing OAM before importing to avoid serving stale policies during the import window.

---

## Step 8: Certificate Management

OAM uses certificates in three contexts: WebGate-to-OAM communication (OAP Cert mode), SAML 2.0 signing and encryption, and SSL/TLS on the OAM managed server port.

### Rotate WebGate Communication Certificate (Cert Mode)

\`\`\`bash
# Generate a new key pair for the WebGate
keytool -genkeypair \\
  -alias webgate_key \\
  -keyalg RSA \\
  -keysize 2048 \\
  -validity 825 \\
  -keystore \${WEBGATE_CONFIG}/aaa_key.pem \\
  -storetype PKCS12

# Export the public certificate to send to the OAM administrator
keytool -exportcert \\
  -alias webgate_key \\
  -keystore \${WEBGATE_CONFIG}/aaa_key.pem \\
  -file webgate_cert.pem \\
  -rfc
\`\`\`

Send \`webgate_cert.pem\` to the OAM administrator, who uploads it to the WebGate registration in OAM Admin Console → System Configuration → SSO Agents → [webgate name] → Certificate. After uploading, regenerate and re-download the \`cwallet.sso\` artifact, redeploy it to the OHS host, and restart OHS.

### Update SAML Signing Certificate

SAML signing certificates have a finite validity period. Plan rotation 60 days before expiry to give SP partners time to update their trust.

1. OAM Admin Console → Federation → Identity Provider → Signing Certificate → **Upload** new PEM
2. Update the federation metadata URL published to SP partners: \`https://oam.example.com/fed/idp/metadata\`
3. Notify all SP partner administrators that metadata has been updated. They must either re-import the metadata or manually update the OAM signing certificate in their SP configuration.
4. After all SPs have been updated, remove the old certificate from the OAM keystore.

### Renew OAM Managed Server SSL Certificate

\`\`\`bash
# Generate CSR for the OAM managed server (use the FQDN that users reach)
keytool -certreq \\
  -alias oam_server \\
  -keystore \${DOMAIN_HOME}/config/fmwconfig/oam_keystore.jks \\
  -file oam_server.csr \\
  -sigalg SHA256withRSA

# Submit CSR to CA, receive signed certificate
# Import CA chain and signed cert back into the keystore
keytool -importcert -trustcacerts -alias root_ca \\
  -file root_ca.pem \\
  -keystore \${DOMAIN_HOME}/config/fmwconfig/oam_keystore.jks

keytool -importcert -alias oam_server \\
  -file oam_server_signed.pem \\
  -keystore \${DOMAIN_HOME}/config/fmwconfig/oam_keystore.jks
\`\`\`

Restart the OAM managed server after importing the new certificate. Update the WLS SSL configuration in the Admin Console to reference the correct keystore alias.

---

## Step 9: Session Management Operations

### Force-Invalidate a User's Sessions

Use this during a security incident (compromised account) or when an account is being disabled:

\`\`\`bash
curl -u oamadmin:password -X DELETE \\
  "http://oam-host:14100/oam/services/rest/ssa/api/v1/admin/sessions?userId=jsmith"
\`\`\`

A successful response returns HTTP 200 with the number of sessions deleted. If zero sessions are returned, the user had no active sessions.

### Check Active Session Count

\`\`\`bash
# Via WLST — connect to the OAM managed server
\${ORACLE_HOME}/oracle_common/common/bin/wlst.sh <<'EOF'
connect('weblogic','password','t3://oam-server1:14100')
serverRuntime()
cd('OAMRuntime/oam_server1')
print("Active sessions:", get('ActiveSessionCount'))
EOF
\`\`\`

A rapidly growing session count combined with high CPU on the OAM server usually indicates a session not expiring correctly — check idle timeout configuration.

### Adjust Session Timeout Without Restart

Session timeout changes take effect for new sessions immediately — no OAM server restart is required.

1. OAM Admin Console → Authentication Schemes → **[select scheme]** → Session Lifetime
2. Idle Timeout: 480 minutes (8 hours)
3. Max Session Duration: 1440 minutes (24 hours)
4. Save

---

## Step 10: Troubleshooting Table

| Symptom | Likely Cause | Diagnostic Step | Fix |
|---|---|---|---|
| Login page loops infinitely | Cookie domain mismatch | Check OAMAuthnCookie domain in browser developer tools | Set OAM cookie domain to match application domain |
| "LDAP Bind Failed" in OAM log | Wrong bind credentials | Run \`ldapsearch\` from OAM host with same bind DN | Update bind password in OAM identity store config |
| WebGate returns HTTP 403 | Authorization policy denying user | Check user's group membership in LDAP | Add user to required LDAP group |
| WebGate returns HTTP 503 | OAM Server unreachable on OAP port 5575 | \`telnet oam-server1 5575\` | Check OAM server status and firewall rules |
| SSO not working across apps | Different cookie domains | Inspect cookies in browser for both apps | Consolidate all apps under same cookie domain |
| Coherence split-brain | Network partition between OAM nodes | Check Coherence log for "MemberLeft" events | Restart isolated node; fix network partition |
| SAML assertion rejected by SP | Clock skew greater than 5 minutes | Compare NTP time on OAM server vs SP host | Sync NTP on all servers |
| OAM_REMOTE_USER has full DN | Response header action missing uid extraction | Inspect response headers in WebGate debug mode | Fix authorization policy response to use \`\${user.attr.uid}\` |
| High CPU on OAM server | Policy evaluation loop or large group membership | Check OAM diagnostic log for slow policy eval | Optimize LDAP group search base; add memberOf index to OUD |
| Memory leak on oam_server1 | Session accumulation without expiry | Check heap via JConsole; inspect active session count | Reduce session lifetime; add idle timeout |

---

## Step 11: Backup and Recovery

### Daily Backup Items

Automate backup of these items every night before the maintenance window:

1. **Policy store**: LDAP export via \`ldapsearch\` or Oracle Directory Services Manager (ODSM) export
2. **OAM domain configuration**: \`\${DOMAIN_HOME}/config/\` directory tree
3. **WebGate config artifacts**: \`ObAccessClient.xml\` and \`cwallet.sso\` from each OHS host
4. **CSF wallet**: \`\${DOMAIN_HOME}/config/fmwconfig/jps-config.xml\` and all referenced keystores

### Quick Config Backup Script

\`\`\`bash
tar czf /backup/oam_domain_config_$(date +%Y%m%d).tar.gz \\
  /u01/oracle/domains/oam_domain/config \\
  /u01/oracle/domains/oam_domain/servers/oam_server1/logs
\`\`\`

Keep at least 7 days of daily backups and one monthly archive. Rotate logs older than 30 days from \`/u01/oracle/domains/oam_domain/servers/oam_server1/logs/\` — they grow large in active environments.

### Recovery from Policy Corruption

If an incorrect policy change locks out users or causes authentication failures across all applications:

1. Stop the OAM managed server (leave Admin Server running)
2. Restore the LDAP policy store from the last known-good backup using \`ldapadd\` or ODSM import
3. Start the OAM managed server
4. Test a protected resource end-to-end before declaring recovery complete

Do not attempt to hand-edit LDAP policy entries directly — OAM policy objects have internal references that must be consistent. Always use the OAM Admin Console or the export/import WLST commands.

---

## Step 12: Health Monitoring Script

Deploy this script on your monitoring server and run it every 5 minutes via cron. It checks both the OAM server health endpoint and that the WebGate is active (returning 302 to the login page rather than 503).

\`\`\`bash
#!/bin/bash
# OAM health check — run from monitoring server via cron every 5 minutes
OAM_HOST="oam-server1.example.com"
OAM_PORT="14100"
WEBGATE_HOST="ohs.example.com"

# Check OAM server health endpoint — healthy = HTTP 302 redirect
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \\
  "http://\${OAM_HOST}:\${OAM_PORT}/oam/server/logout?end_url=http://check")
if [ "\${STATUS}" != "302" ]; then
  echo "CRITICAL: OAM server not responding (HTTP \${STATUS})"
  exit 2
fi

# Check WebGate is active
# A protected resource returns 302 redirect to login page when WebGate is healthy
# It returns 503 when WebGate cannot reach OAM Server on OAP port 5575
WG_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \\
  "https://\${WEBGATE_HOST}/protected_test_resource")
if [ "\${WG_STATUS}" = "503" ]; then
  echo "CRITICAL: WebGate returning 503 — OAP connection to OAM Server is down"
  exit 2
fi

echo "OK: OAM server healthy (HTTP \${STATUS}), WebGate active (HTTP \${WG_STATUS})"
exit 0
\`\`\`

Add a cron entry:

\`\`\`
*/5 * * * * /u01/scripts/oam_health_check.sh >> /u01/logs/oam_health.log 2>&1
\`\`\`

For Nagios/Icinga integration, the exit codes (0=OK, 2=CRITICAL) are compatible with the NRPE plugin framework directly.

---

## Summary Checklist

Use this checklist when bringing up a new OAM environment or verifying a restored environment:

- [ ] RCU schemas present in database — all with status OPEN
- [ ] WebLogic Admin Server running and accessible at :7001/console
- [ ] OAM managed server running and accessible at :14100/oamconsole
- [ ] Identity store registered and test connection passes
- [ ] At least one Application Domain created with Host Identifiers matching protected app URLs
- [ ] Authentication Policy and Authorization Policy defined for protected resources
- [ ] WebGate registered in OAM and artifacts deployed to OHS host
- [ ] OHS restart successful with WebGate module loading confirmed in logs
- [ ] End-to-end SSO test: unauthenticated request → OAM login page → credentials → redirect to app with OAM_REMOTE_USER header
- [ ] Global logout test: logout from app → OAM session invalidated → re-accessing protected URL prompts for login again
- [ ] Health monitoring script deployed and returning OK
- [ ] Backup job scheduled and first backup verified restorable
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
