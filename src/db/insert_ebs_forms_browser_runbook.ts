import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Setting Up a Workstation for Oracle EBS Forms Access',
  slug: 'ebs-forms-browser-configuration-runbook',
  excerpt:
    'Step-by-step workstation setup runbook for Oracle EBS Forms — covering JRE installation and version selection, Java Control Panel security configuration, Java Web Start JNLP launch testing, HTTP tunnel configuration, IE11 setup, Group Policy deployment of Java settings, and a diagnostic decision tree for the most common Forms launch failures.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-10'),
  youtubeUrl: null,
  content: `## Prerequisites

- Access to the EBS application server URL and port (confirm with your DBA or EBS admin)
- Windows 10/11 workstation (procedures for Linux/Mac noted where different)
- Administrator rights on the workstation (required for JRE installation)
- My Oracle Support access to verify the certified JRE version for your EBS release (Note 393931.1)
- EBS login credentials for a test user with access to at least one Forms-based responsibility

---

## Phase 1: Determine the Certified JRE Version

Before installing Java, confirm which JRE version is certified for your specific EBS release.

### 1.1 Check Your EBS Release

Connect to the EBS application server or ask your DBA:

\`\`\`sql
-- On the EBS database as APPS
SELECT release_name
FROM   fnd_product_groups;
-- Example output: 12.2.9
\`\`\`

### 1.2 Look Up the Certified JRE

Reference: My Oracle Support Note **393931.1** — "Oracle E-Business Suite Release 12 Technology Stack Certification Matrix"

For EBS 12.2.6–12.2.9, the safe default is **JRE 8u361** (or the latest 8u build certified at your patch level). Avoid JRE 9, 10, 11, 17, and 21 — these versions break the Java Plug-in and JNLP launcher in EBS.

---

## Phase 2: Remove Conflicting JRE Versions

Conflicting JRE versions cause Java to pick the wrong one at runtime.

### 2.1 Windows — Uninstall Non-Certified JREs

\`\`\`
Control Panel → Programs → Uninstall a Program
\`\`\`

Remove all Java entries except the one you are about to install. Common conflicting entries:
- Java 11.x (OpenJDK or Oracle JDK)
- Java 17.x
- Java 21.x
- Any JRE 8 update higher than the certified maximum

### 2.2 Verify No Java Remains

\`\`\`cmd
java -version
:: Expected: 'java' is not recognized as an internal or external command
\`\`\`

---

## Phase 3: Install the Certified JRE

### 3.1 Download JRE

Download from the Java Archive at java.com (for JRE 8) or from your internal software repository. Example for JRE 8u361:

\`\`\`
jre-8u361-windows-x64.exe
\`\`\`

### 3.2 Install (Silent, for scripted deployment)

\`\`\`cmd
:: Silent install — suppresses all prompts, installs 64-bit JRE only
jre-8u361-windows-x64.exe /s INSTALL_SILENT=Enable REBOOT=Disable

:: Verify installation
"C:\\Program Files\\Java\\jre1.8.0_361\\bin\\java.exe" -version
:: Expected: java version "1.8.0_361"
\`\`\`

### 3.3 Linux Install

\`\`\`bash
# RHEL/OL — using RPM from the Java archive
rpm -ivh jre-8u361-linux-x64.rpm

# Ubuntu — using the .tar.gz
tar -xzf jre-8u361-linux-x64.tar.gz -C /opt/java/
ln -sf /opt/java/jre1.8.0_361 /opt/java/current

# Set JAVA_HOME
export JAVA_HOME=/opt/java/current
export PATH=\$JAVA_HOME/bin:\$PATH

java -version
# Expected: java version "1.8.0_361"
\`\`\`

---

## Phase 4: Configure the Java Control Panel

### 4.1 Open Java Control Panel

**Windows:** Start → search "Configure Java" → open Java Control Panel

Or via command line:
\`\`\`cmd
"C:\\Program Files\\Java\\jre1.8.0_361\\bin\\javacpl.exe"
\`\`\`

**Linux:**
\`\`\`bash
/opt/java/current/bin/jcontrol
\`\`\`

### 4.2 Security Tab — Set Security Level

1. Click the **Security** tab
2. Set the slider to **High** (not Very High)
3. Click Apply

> "Very High" blocks self-signed certificates and applets that are not signed by a trusted CA. Most EBS environments use internally-signed certificates that only "High" will accept.

### 4.3 Security Tab — Add EBS to Exception Site List

1. In the Security tab, click **Edit Site List**
2. Click **Add**
3. Enter the EBS URL exactly as it appears in the browser address bar:
   \`\`\`
   https://ebs.corp.local:4443
   \`\`\`
4. If your EBS also serves Forms over HTTP (uncommon for production), also add:
   \`\`\`
   http://ebs.corp.local:8000
   \`\`\`
5. Click **OK** → **Continue** on the security warning → **OK**

### 4.4 General Tab — Clear Java Cache

1. Click the **General** tab
2. Under **Temporary Internet Files**, click **Settings**
3. Click **Delete Files**
4. Check all boxes and click **OK**

Or via command line:
\`\`\`cmd
"C:\\Program Files\\Java\\jre1.8.0_361\\bin\\javaws.exe" -uninstall
\`\`\`

### 4.5 Advanced Tab — Optional Performance Settings

In the **Advanced** tab:

- Under **Java Plug-in**: check **Enable the next-generation Java Plug-in**
- Under **Debugging**: uncheck all logging options (logging causes significant Forms slow-down in production)
- Under **Mixed code**: set to **Enable — hide warning and run with protections**

Click **Apply → OK**.

---

## Phase 5: Test Java Web Start (JNLP Launch)

For EBS 12.2.6+, Forms launch via JNLP is the recommended path.

### 5.1 Verify Java Web Start Is Registered

\`\`\`cmd
:: Check that .jnlp files are associated with javaws
assoc .jnlp
:: Expected: .jnlp=JNLPFile

ftype JNLPFile
:: Expected: JNLPFile="C:\\Program Files\\Java\\jre1.8.0_361\\bin\\javaws.exe" "%1"
\`\`\`

If the association is missing:
\`\`\`cmd
assoc .jnlp=JNLPFile
ftype JNLPFile="C:\\Program Files\\Java\\jre1.8.0_361\\bin\\javaws.exe" "%%1"
\`\`\`

### 5.2 Download and Launch the JNLP Manually

\`\`\`cmd
:: Download the Forms JNLP file
curl -k -o C:\\Temp\\forms_test.jnlp "https://ebs.corp.local:4443/forms/frmservlet?config=EBS"

:: Inspect the downloaded file — look for a valid codebase URL
type C:\\Temp\\forms_test.jnlp

:: Launch it directly with javaws
"C:\\Program Files\\Java\\jre1.8.0_361\\bin\\javaws.exe" C:\\Temp\\forms_test.jnlp
\`\`\`

**Expected:** Oracle Forms splash screen appears, then the EBS login page or a Forms session.

### 5.3 Inspect the JNLP File

A valid JNLP should start with:
\`\`\`xml
<?xml version="1.0" encoding="UTF-8"?>
<jnlp spec="1.0+" codebase="https://ebs.corp.local:4443/forms"
      href="frmservlet?config=EBS">
  <information>
    <title>Oracle Forms</title>
    ...
  </information>
\`\`\`

If the \`codebase\` URL contains \`localhost\` or an internal hostname that is not reachable from the client, the Forms server's \`serverURL\` configuration needs to be corrected.

---

## Phase 6: Validate Network Connectivity

### 6.1 Test OHS HTTPS Port

\`\`\`cmd
:: Test HTTPS port
curl -v -k https://ebs.corp.local:4443/OA_HTML/AppsLocalLogin.jsp
:: Expected: HTTP 200 or 302

:: Test Forms servlet
curl -v -k https://ebs.corp.local:4443/forms/frmservlet
:: Expected: HTTP 200 with JNLP content
\`\`\`

### 6.2 Test Forms Socket Port (if not using HTTP tunnel)

\`\`\`cmd
:: Test TCP connectivity to the Forms socket port (default 9000)
Test-NetConnection -ComputerName ebs.corp.local -Port 9000
:: Expected: TcpTestSucceeded : True

:: Or using telnet
telnet ebs.corp.local 9000
:: Expected: Connects (blank screen) — not refused or timed out
\`\`\`

If port 9000 is blocked by a corporate firewall, HTTP tunnel mode must be used (see Phase 7).

### 6.3 Check the Forms Server URL Configuration

On the EBS application tier:

\`\`\`bash
grep -i "serverURL\|serverPort\|httptunnelURL" \$FND_TOP/secure/formsweb.cfg
\`\`\`

Output for socket mode:
\`\`\`ini
serverPort=9000
serverHost=ebs.corp.local
\`\`\`

Output for HTTP tunnel mode:
\`\`\`ini
serverURL=https://ebs.corp.local:4443/forms/lservlet
\`\`\`

---

## Phase 7: Enable HTTP Tunnel Mode (Firewall Environments)

When the client workstation is behind a corporate firewall that blocks port 9000, the Forms server must be configured to use HTTP tunneling. This routes all Forms traffic through HTTPS on port 443 or 4443.

### 7.1 Modify formsweb.cfg on the EBS Server

On the EBS application tier (as the oracle user):

\`\`\`bash
vi \$FND_TOP/secure/formsweb.cfg
\`\`\`

Change (or add):
\`\`\`ini
# HTTP tunnel — all Forms traffic goes through HTTPS
serverURL=https://ebs.corp.local:4443/forms/lservlet

# Remove or comment out direct socket settings
# serverPort=9000
# serverHost=ebs.corp.local
\`\`\`

### 7.2 Bounce OHS to Apply the Change

\`\`\`bash
# EBS application tier — as oracle user
\$ADMIN_SCRIPTS_HOME/adapcctl.sh stop
\$ADMIN_SCRIPTS_HOME/adapcctl.sh start
\`\`\`

### 7.3 Verify the JNLP Reflects the Tunnel URL

\`\`\`cmd
curl -k "https://ebs.corp.local:4443/forms/frmservlet?config=EBS" | findstr serverURL
:: Expected: serverURL=https://ebs.corp.local:4443/forms/lservlet
\`\`\`

---

## Phase 8: Internet Explorer 11 Configuration

For organisations still using IE11 as the Forms browser:

### 8.1 Add EBS to Trusted Sites

\`\`\`
IE → Tools (Alt+T) → Internet Options → Security tab
Select "Trusted sites" → click "Sites"
Add: https://ebs.corp.local
Uncheck "Require server verification (https:)..." if needed
Click Add → Close → OK
\`\`\`

### 8.2 Enable Java Add-ons

\`\`\`
IE → Tools → Manage Add-ons → Show: All add-ons
Locate: "Java(tm) Plug-in 2 SSV Helper"  → Enable
Locate: "Java(tm) Plug-in SSV Helper"     → Enable
\`\`\`

### 8.3 Enable Compatibility View (if needed)

\`\`\`
IE → Tools → Compatibility View Settings
Add the EBS hostname (e.g., ebs.corp.local) → Add → Close
\`\`\`

### 8.4 Disable Enhanced Protected Mode

Enhanced Protected Mode in IE11 blocks the Java plugin on 64-bit systems.

\`\`\`
IE → Tools → Internet Options → Advanced tab
Uncheck: "Enable Enhanced Protected Mode"
Restart Internet Explorer
\`\`\`

---

## Phase 9: Enterprise Deployment via Group Policy or Script

### 9.1 Deploy deployment.properties (Windows)

Create the file:
\`\`\`
C:\\Windows\\Sun\\Java\\Deployment\\deployment.properties
\`\`\`

Contents:
\`\`\`properties
deployment.security.level=HIGH
deployment.security.SSLv2Hello.enabled=false
deployment.security.TLSv1.enabled=false
deployment.security.TLSv1.1.enabled=false
deployment.security.TLSv1.2.enabled=true
exception.sites=https://ebs.corp.local:4443,http://ebs.corp.local:8000
deployment.cache.max.size=500
\`\`\`

This file overrides individual user Java Control Panel settings.

### 9.2 PowerShell Deployment Script

\`\`\`powershell
# deploy_java_ebs_config.ps1
# Run as administrator — deploys Java config for EBS Forms access

\$javaDeployDir = "C:\\Windows\\Sun\\Java\\Deployment"
\$propsFile = "\$javaDeployDir\\deployment.properties"

# Create directory if it doesn't exist
if (-not (Test-Path \$javaDeployDir)) {
    New-Item -ItemType Directory -Path \$javaDeployDir | Out-Null
}

# Write deployment.properties
@"
deployment.security.level=HIGH
deployment.security.SSLv2Hello.enabled=false
deployment.security.TLSv1.enabled=false
deployment.security.TLSv1.1.enabled=false
deployment.security.TLSv1.2.enabled=true
exception.sites=https://ebs.corp.local:4443,http://ebs.corp.local:8000
deployment.cache.max.size=500
"@ | Set-Content -Path \$propsFile -Encoding UTF8

Write-Host "Java deployment.properties written to \$propsFile"

# Clear Java cache
\$javaExe = "C:\\Program Files\\Java\\jre1.8.0_361\\bin\\javaws.exe"
if (Test-Path \$javaExe) {
    & \$javaExe -uninstall 2>\$null
    Write-Host "Java cache cleared"
}

Write-Host "EBS Forms Java configuration complete."
\`\`\`

---

## Phase 10: End-to-End Forms Launch Validation

### 10.1 Navigate to EBS Login Page

\`\`\`
https://ebs.corp.local:4443/OA_HTML/AppsLocalLogin.jsp
\`\`\`

Log in with a test user that has a Forms-based responsibility (e.g., General Ledger Super User).

### 10.2 Launch a Forms Function

Navigate to: **General Ledger → Journals → Enter**

Expected sequence:
1. Browser navigates to the Forms launcher URL
2. Java Web Start dialog appears briefly
3. Forms splash screen / Oracle logo loads
4. Journal Entry form appears with a blank transaction

### 10.3 Verify the Java Version in Use

Once inside a Forms session, press **F1** to open the About Oracle E-Business Suite dialog, or check:

**Help → About Oracle Applications**

This shows the JRE version the Forms session is using. Confirm it matches your certified version.

### 10.4 Test Data Entry and Navigation

1. Enter a test journal entry (do not save)
2. Tab through fields — verify no freezes or hangs
3. Press F11 (Query Mode) — verify the query bar appears
4. Press Ctrl+F11 — verify records are returned
5. Open a second Forms window (e.g., navigate to a second responsibility) — verify both windows are functional

---

## Troubleshooting Decision Tree

\`\`\`
Forms does not launch
│
├── Error: "Application Blocked by Java Security"
│   └── Fix: Add EBS URL to Java Exception Site List (Phase 4.3)
│         Set Security Level to High, not Very High (Phase 4.2)
│
├── Error: "Unable to launch the application" (JNLP)
│   ├── Download and inspect the JNLP file (Phase 5.2)
│   │   └── Is codebase URL reachable from client?
│   │       ├── No → Fix DNS or EBS server URL config
│   │       └── Yes → Clear Java cache (Phase 4.4) and retry
│   └── Is .jnlp associated with javaws? (Phase 5.1)
│       └── No → Recreate file association
│
├── Forms splash screen loads but hangs at "Connecting..."
│   └── Is port 9000 reachable from client? (Phase 6.2)
│       ├── No → Enable HTTP tunnel mode (Phase 7)
│       └── Yes → Check WebLogic forms-c4ws_server1 is running
│
├── Forms loads but displays blank or misaligned
│   └── Windows DPI scaling issue
│       └── Fix: javaw.exe → Compatibility → Override DPI scaling → Application
│
├── Forms loads but is very slow
│   └── Check JVM heap: default 256MB may be too low
│       └── Increase jvmparams in formsweb.cfg to -Xmx512m
│
└── "JRE version X is not supported"
    └── Uninstall current JRE and install certified JRE 8 update (Phase 2–3)
\`\`\`

---

## Log Locations for Forms Diagnostics

### Client-Side Java Logs

\`\`\`
# Windows
%USERPROFILE%\\AppData\\LocalLow\\Sun\\Java\\Deployment\\log\\

# Linux/Mac
~/.java/deployment/log/
\`\`\`

Enable Java console logging during troubleshooting:

Java Control Panel → Advanced → Java Console → **Show console**

Then reproduce the issue and copy the console output.

### Server-Side Forms Logs

\`\`\`bash
# EBS application tier
# OHS access log (captures Forms launcher requests)
\$ORACLE_INSTANCE/diagnostics/logs/OHS/ohs1/access_log

# Forms servlet log
\$ORACLE_INSTANCE/diagnostics/logs/OHS/ohs1/ohs_component.log

# WebLogic forms-c4ws managed server log (if Forms via WebLogic)
\$DOMAIN_HOME/servers/forms-c4ws_server1/logs/forms-c4ws_server1.log
\`\`\`

### Enable Detailed Forms Logging (Temporary — For Diagnosis Only)

In \`formsweb.cfg\`:
\`\`\`ini
# Enable verbose logging — DISABLE after diagnosis (causes significant overhead)
log=true
logLevel=fine
logFile=/tmp/forms_debug.log
\`\`\`

Restart OHS and reproduce the issue. Disable logging immediately after capturing the trace.`,
};

async function main() {
  console.log('Inserting EBS Forms browser configuration runbook...');
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
