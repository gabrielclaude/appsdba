import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Configuring Your Browser for Oracle EBS Forms: Java, JRE, and Browser Compatibility',
  slug: 'ebs-forms-browser-configuration',
  excerpt:
    'A practical guide to setting up a client workstation for Oracle E-Business Suite Forms — covering the supported Java Runtime Environment versions, Internet Explorer and Chrome legacy configuration, Java Control Panel security exceptions, JVM memory parameters, and the common errors that appear when the browser or JRE is misconfigured.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-10'),
  youtubeUrl: null,
  content: `Oracle E-Business Suite Forms are Java applets — browser-hosted Java applications served from the EBS application tier and rendered by a Java Runtime Environment installed on the client machine. While OAF pages (like iStore, iSupplier, or self-service HR) work in any modern browser, Forms-based modules — GL, AP, AR, PO, OM, INV — require a correctly configured JRE and, for most EBS 12.2 versions, a browser that still supports the Java plugin.

This post explains the architecture, the supported configurations, and the most common client setup problems.

---

## How EBS Forms Work in the Browser

When a user navigates to a Forms-based EBS function, the following happens:

\`\`\`
1. Browser loads the Forms launcher page
   (e.g., https://ebs.corp.local:4443/forms/frmservlet?config=EBS)

2. The page contains a JNLP launch file reference
   or a legacy <APPLET> tag

3. Java Web Start (javaws) or the browser Java plugin
   downloads and launches the Forms applet

4. The Forms applet connects back to the EBS Forms server
   (Socket connection on port 9000 or via HTTP tunnel on 443/4443)

5. The Forms session runs entirely in the JRE on the client machine
   — not in the browser rendering engine
\`\`\`

The applet communicates with the Oracle Forms Services tier on the EBS application server. The actual Forms logic and data access happen server-side; the JRE on the client is responsible only for rendering the Forms UI and handling user input.

---

## Supported Java Versions for EBS 12.2

Oracle EBS 12.2 has specific certified JRE versions. Using an uncertified version causes Forms to fail silently or throw security exceptions.

| EBS 12.2 Release | Certified JRE | Notes |
|-----------------|---------------|-------|
| 12.2.0–12.2.5 | JRE 7u25–7u80 | Java 7 EOL — internal use only |
| 12.2.6–12.2.9 | JRE 8u131–8u391 | Standard for most environments |
| 12.2.10+ | JRE 8u261+ | JRE 11 supported via JDK 11 (see Note 2059276.1) |
| All versions | Not JRE 9, 10, 17, 21 | Module system breaks Forms plugin |

**Check the current certification on My Oracle Support:** Note 393931.1 (Desktop Requirements for Oracle E-Business Suite) is the authoritative source.

The safest approach for most EBS 12.2 environments is **JRE 8u361** or the latest 8u update certified in Note 393931.1 at time of deployment.

---

## Browser Support Matrix

The Java plugin was removed from all modern browsers. EBS Forms requires one of the following:

| Browser | Status | Notes |
|---------|--------|-------|
| Internet Explorer 11 | Works (legacy) | Java plugin still functional; IE11 EOL June 2022 |
| Chrome (older, pre-v45) | Removed NPAPI in 2015 | Standard Chrome cannot run EBS Forms |
| Firefox (older, pre-v52 ESR) | Removed NPAPI in 2017 | Standard Firefox cannot run EBS Forms |
| Oracle JRE 8 + Java Web Start | Recommended path | Uses JNLP, bypasses browser plugin entirely |
| Oracle Secure Global Desktop (SGD) | Enterprise option | Server-side rendering, no client JRE needed |

### The Modern Workaround: Java Web Start (JNLP)

For EBS 12.2.6 and later, Oracle ships a JNLP-based launcher. The browser downloads a \`.jnlp\` file and hands it off to Java Web Start (\`javaws\`), which launches the Forms session outside the browser entirely. This is the **supported path** for environments that cannot use Internet Explorer 11.

\`\`\`
Browser
  └── Downloads forms_config.jnlp
        └── Java Web Start (javaws.exe / javaws)
              └── Launches Oracle Forms applet
                    └── Connects to EBS Forms server
\`\`\`

---

## Java Control Panel Configuration

After installing the JRE, the Java Control Panel must be configured correctly before EBS Forms will launch.

### Security Tab — Exception Site List

Oracle forms require adding the EBS application server URL to the Java security exception list. Without this, Java blocks the applet with a "Application Blocked by Java Security" message.

**Windows:** Control Panel → Java → Security tab → Edit Site List

**Linux/Mac:** \`$JAVA_HOME/bin/javacpl\` or via command line

Add the following to the Exception Site List:

\`\`\`
https://ebs.corp.local:4443
http://ebs.corp.local:8000
\`\`\`

Add both the HTTPS and HTTP URLs, and include any load balancer or virtual hostname that the EBS Forms URL uses.

### Security Level Setting

Set the security slider to **High** (not Very High). "Very High" blocks self-signed certificates and unsigned applets even when they are on the exception list.

### Java Cache — Clear Before Testing

A corrupted Java cache can cause Forms to launch an old version or fail to download updated Forms jars. Clear it before troubleshooting:

**Windows:** Java Control Panel → General tab → Temporary Internet Files → Settings → Delete Files

**Command line:**
\`\`\`bash
# Windows
javaws -uninstall

# Linux/Mac
rm -rf ~/.java/deployment/cache
\`\`\`

---

## JVM Parameters for Forms Performance

Oracle Forms JVM parameters are set in the \`formsweb.cfg\` file on the **server** side — not on the client. The server passes them to the client JRE when the applet launches.

Location on EBS application tier:
\`\`\`
$ORACLE_INSTANCE/config/OHS/ohs1/moduleconf/
$FND_TOP/secure/formsweb.cfg
\`\`\`

Key JVM parameters in \`formsweb.cfg\`:

\`\`\`ini
# Heap size — increase for users working with large Forms datasets
jvmparams=-Xmx512m -Xms128m

# Verbose GC logging (for Forms freezing diagnosis)
# jvmparams=-Xmx512m -verbose:gc

# Client VM (faster startup, less memory)
jvmparams=-client -Xmx512m

# Disable IPv6 preference (resolves connection issues on some Windows systems)
jvmparams=-Xmx512m -Djava.net.preferIPv4Stack=true
\`\`\`

**Default is 256 MB.** Users working in AP Invoice entry, GL Journal entry, or OM order management with many lines commonly need 512 MB. Users who report Forms freezing or "out of memory" errors need the heap increased.

---

## Common Errors and Their Causes

### "Application Blocked by Java Security"

**Cause:** The EBS server URL is not in the Java exception site list, or the JAR file is unsigned.

**Fix:**
1. Add \`https://ebs.corp.local:4443\` to the Java Exception Site List
2. Set security level to High (not Very High)
3. Clear Java cache and retry

### "Unable to launch the application" (JNLP error)

**Cause:** JNLP file has an invalid URL, or Java Web Start cannot connect to the EBS server.

**Fix:**
\`\`\`bash
# Save the JNLP file and inspect it manually
# The codebase href must be reachable from the client
# Look for: <jnlp spec="1.0+" codebase="https://ebs.corp.local:4443/forms">
curl -v https://ebs.corp.local:4443/forms/lservlet?ifcmd=getinfo
# Should return a valid JNLP XML document
\`\`\`

### Forms Launches but Hangs at "Connecting..."

**Cause:** The Forms client cannot establish a socket connection back to the Forms server. This is almost always a firewall rule.

EBS Forms uses two communication modes:
- **Socket mode:** direct TCP from client to port 9000 (or the configured Forms port)
- **HTTP tunnel mode (HTTPS):** encapsulates Forms traffic inside HTTPS — works through firewalls

If the client is connecting through a corporate firewall that blocks non-standard ports, HTTP tunnel mode must be enabled. This is configured in \`formsweb.cfg\`:

\`\`\`ini
# Enable HTTP tunneling (for clients behind firewalls)
serverURL=https://ebs.corp.local:4443/forms/lservlet
\`\`\`

### "JRE version X is not supported"

**Cause:** Client has a non-certified JRE version (Java 11, 17, or 21 are common culprits).

**Fix:** Uninstall the non-certified version and install a certified JRE 8 update from the Java archive at java.com or the internal software repository.

### Forms Loads but Displays Blank or Misaligned

**Cause:** Display DPI scaling on Windows. EBS Forms was designed at 96 DPI. Windows 10/11 high-DPI displays at 125% or 150% scaling cause rendering issues.

**Fix:**
1. Right-click \`javaw.exe\` → Properties → Compatibility → Override high DPI scaling
2. Set "Scaling performed by:" to **Application**

Or use a manifest file override (for enterprise deployments via Group Policy).

---

## Internet Explorer 11 Configuration

For organisations still using IE11 for EBS Forms access:

### Trusted Sites

Add the EBS URL to Trusted Sites to avoid repeated security prompts:

IE → Tools → Internet Options → Security → Trusted Sites → Sites

Add:
\`\`\`
https://ebs.corp.local
\`\`\`

Uncheck "Require server verification (https:) for all sites in this zone" if using both HTTP and HTTPS.

### Enable Java Plugin in IE11

IE → Tools → Manage Add-ons → Show: All add-ons

Find **Java(tm) Plug-in 2 SSV Helper** and **Java(tm) Plug-in SSV Helper** — ensure both are Enabled.

### Compatibility View

Some EBS versions require IE Compatibility View. If the EBS login page renders incorrectly:

IE → Tools → Compatibility View Settings → Add the EBS domain.

---

## Deploying Client Configuration via Group Policy

For enterprise environments with many EBS users, automate the Java configuration via Group Policy or a managed deployment script:

**Exception Site List via registry (Windows):**
\`\`\`
HKEY_LOCAL_MACHINE\\Software\\JavaSoft\\DeploymentProperties
exception.sites=https://ebs.corp.local:4443
\`\`\`

Or deploy a \`deployment.properties\` file to:
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
\`\`\`

The companion runbook covers the complete workstation setup procedure, JRE installation, Java Control Panel configuration, and end-to-end Forms launch validation.`,
};

async function main() {
  console.log('Inserting EBS Forms browser configuration blog post...');
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
