import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'When Disk Space Disasters Break WebLogic: Cascading Failures and Embedded LDAP Corruption',
  slug: 'oracle-atg-weblogic-disk-ldap-corruption',
  excerpt:
    'A production Oracle ATG Web Commerce environment is down, disk space has been cleared, and WebLogic still refuses to start. This post traces the full chain from a filesystem exhaustion event through embedded LDAP corruption to the BEA-000386 MultiException, explains why renaming the AdminServer directory makes things worse, and provides the only reliable recovery path: restoring the domain from backup.',
  category: 'oracle-atg' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-30'),
  youtubeUrl: null,
  content: `This is one of the most stressful scenarios a middleware administrator faces. A production Oracle ATG Web Commerce application is down. WebLogic Server completely refuses to restart. The incident starts looking like a straightforward reboot issue, but it keeps unfolding into something deeper. The storefront is offline, checkout is unavailable, and every restart attempt ends with a wall of Java exceptions that look nothing like a disk space problem.

That is the trap. The disk was cleared. So why won't it boot?

The answer is that a full filesystem does not just prevent new writes. When it hits 100% at precisely the wrong moment, it leaves behind corrupted files that survive the cleanup. In WebLogic's case, the most dangerous files to corrupt are the ones that control security initialization. This post traces the full incident chain, explains the internal mechanics of each failure mode, and describes the recovery procedure that actually works.

---

## The Triggering Event: No Space Left on Device

The incident begins with a managed server termination. In the WebLogic server log, the last meaningful entry before the JVM exits looks like this:

\`\`\`
<WARNING> <base_domain> <prod_page_server1> <I/O error while writing to file ".../logs/prod_page_server1.out">
java.io.IOException: No space left on device
\`\`\`

This is \`ENOSPC\` — the Linux kernel's response when a write system call cannot place bytes on the filesystem because all allocated blocks are in use. The JVM's log appender received this error, logged the warning (to a different file descriptor that briefly succeeded before it too failed), and then the process terminated.

Understanding what happens at the OS level when a filesystem hits 100% capacity is essential to understanding why the recovery is difficult.

When a process issues a \`write()\` syscall and the filesystem has no free blocks, the kernel returns \`-1\` with \`errno\` set to \`ENOSPC\`. The write is not deferred or buffered for later — it fails immediately. Any file that was in the middle of a write operation at that moment has its content in an indeterminate state. If the write was of a fixed-size record and only half the bytes were committed before the block ran out, the file contains a partial record. If the operating system was flushing a dirty page that contained the tail of a sequential file, the tail is missing. If a file was being created from scratch and the header bytes were written but the remaining content was not, the file contains only a header with a zero-length body.

For WebLogic, this means far more than missing log lines. WebLogic actively writes to multiple categories of files during normal operation:

- **Application logs**: \`prod_page_server1.out\`, \`prod_page_server1.log\`
- **Transaction recovery logs**: used by the JTA transaction manager to recover in-flight XA transactions
- **LDAP data files**: updated on every security policy change, realm initialization, and on every server startup during the LDAP subsystem bootstrap

The files most at risk are those with the highest write frequency during the specific window when the disk filled. On a production ATG server under load, log files are written continuously. But the LDAP data files, while written less frequently, are written in structured binary format — and a partial write to a structured binary format is always corruption, not a recoverable truncation.

---

## The Embedded LDAP Store: What It Is and Where It Lives

WebLogic Server embeds a full LDAP directory server as its internal security provider. This is not an optional component and it is not replaceable in most WebLogic configurations — it is the default security realm's credential and policy store.

The Embedded LDAP server stores:

- User accounts and their credential hashes, including the WebLogic administrator account (\`weblogic\` by default)
- Security roles and group memberships
- Security policies attached to deployed applications and WebLogic resources
- Credential mappings used by outbound connector configuration
- Auditing configuration for the security realm

The physical files that back this store live in the domain directory. The canonical path is:

\`\`\`
<domain_home>/servers/AdminServer/data/ldap/
\`\`\`

Inside that directory, the relevant files and subdirectories are:

\`\`\`
ldap/
├── ldapfiles/          # Berkeley DB (BDB) data store — the actual credential and policy data
├── ldap.lck            # Lock file used to prevent concurrent LDAP server access
├── ldap.pid            # PID file written at LDAP server startup
└── EmbeddedLDAP.properties  # Configuration: port, sequence numbers, version counters
\`\`\`

The \`ldapfiles/\` directory contains the Berkeley DB data store. BDB is a key-value storage engine that uses a structured on-disk format consisting of page-aligned data files, transaction log files, and checkpoint metadata. Writes to BDB are not simple sequential appends — they involve structured page writes, metadata updates, and log sequence number (LSN) advancement. A write interrupted mid-page by an \`ENOSPC\` error leaves the BDB store in a state where its internal consistency checks will fail on the next open attempt.

The \`EmbeddedLDAP.properties\` file contains numeric parameters: port assignments, sequence number counters, and version identifiers. These are read during LDAP subsystem initialization. If this file was being written at the moment the disk filled, it may contain partial content — or, in the worst case, a zero-length file if the OS had truncated it before any bytes were committed.

---

## The Cascading Failure: BEA-000386 MultiException

After clearing disk space and attempting to restart WebLogic 12.1.3, the AdminServer log produces the following:

\`\`\`
<Critical> <WebLogicServer> <BEA-000386> <Server subsystem failed. Reason: A MultiException has 12 exceptions. They are:
1. java.lang.NumberFormatException: null
2. java.lang.IllegalStateException: Unable to perform operation: post construct on weblogic.ldap.PreEmbeddedLDAPService
3. java.lang.IllegalArgumentException: While attempting to resolve the dependencies of weblogic.ldap.EmbeddedLDAP errors were found
...
\`\`\`

Each exception in this chain is a symptom of the same underlying corruption. Working from the innermost outward:

**\`NumberFormatException: null\`** — This is the signature of a call to \`Integer.parseInt()\` or \`Long.parseLong()\` receiving a \`null\` argument. The LDAP subsystem reads \`EmbeddedLDAP.properties\` during \`PreEmbeddedLDAPService\` initialization and parses numeric fields from it. If the file was partially written or is zero-length, the properties parser returns \`null\` for any key that is missing or corrupt. The subsequent integer parse fails with this exception. This is not a code bug — it is the expected behavior when the configuration file is not intact.

**\`Unable to perform operation: post construct on weblogic.ldap.PreEmbeddedLDAPService\`** — The \`@PostConstruct\` lifecycle callback on the \`PreEmbeddedLDAPService\` Spring bean threw an unchecked exception (the \`NumberFormatException\` above). Spring's dependency injection container caught it and wrapped it in an \`IllegalStateException\`. The \`PreEmbeddedLDAPService\` component is responsible for verifying that the LDAP configuration is intact before the full \`EmbeddedLDAP\` service attempts to start. It failed that check.

**\`While attempting to resolve the dependencies of weblogic.ldap.EmbeddedLDAP errors were found\`** — Because \`PreEmbeddedLDAPService\` did not initialize successfully, the \`EmbeddedLDAP\` component cannot resolve its dependency graph. HK2 (the dependency injection framework WebLogic 12.1.3 uses internally) reports this as an \`IllegalArgumentException\` during dependency resolution.

The remaining exceptions in the MultiException are downstream consequences of the same root failure. Each service that depends on \`EmbeddedLDAP\` being available throws its own initialization error, which is why the MultiException count can reach 12 or more.

This is not a transient error. It is not resolved by restarting again. The \`BEA-000386\` MultiException with \`NumberFormatException\` on \`PreEmbeddedLDAPService\` is the definitive signature of embedded LDAP corruption. Every subsequent start attempt will produce the same result until the LDAP store is restored to a consistent state.

---

## The Failed Quick-Fix: Renaming the AdminServer Directory

Standard WebLogic troubleshooting practice includes renaming the \`servers/AdminServer\` directory to clear cached deployment state. The rationale is sound for many types of WebLogic startup failures: corrupted deployment staging directories, stale lock files, and obsolete temporary class data. For this particular failure, renaming the AdminServer directory does not fix the problem — it transforms it into a different, harder problem.

Here is why. The \`servers/AdminServer/data/ldap/\` directory is not a cache. It is the primary storage location for the embedded LDAP data store. When the AdminServer directory is renamed, WebLogic attempts to re-initialize the LDAP store from scratch. This means one of two things depending on the exact WebLogic behavior at that version:

1. WebLogic attempts to read the domain-level LDAP bootstrap configuration from \`config/config.xml\` and recreate the LDAP store — but encounters the same corrupt \`EmbeddedLDAP.properties\` file that caused the original failure, since that file may exist at the domain level as well.

2. WebLogic creates a new, empty LDAP store — but then cannot find the credential hash for the boot identity user because that hash was stored in the now-renamed (and absent) LDAP data directory.

Either way, the result is a new category of failure in the server log:

\`\`\`
1. weblogic.security.SecurityInitializationException: Authentication for user weblogic denied.
2. java.lang.IllegalStateException: Unable to perform operation: post construct on weblogic.security.SecurityService
\`\`\`

This is qualitatively different from the LDAP corruption failure. The AdminServer can now initialize \`PreEmbeddedLDAPService\` (the properties file is no longer the blocking issue), but the security subsystem cannot authenticate the boot identity. The \`weblogic\` administrator account exists in the WebLogic configuration as a reference, but its credential hash — the bcrypt or SHA hash of the password — was stored in the BDB data files that are now absent or empty.

WebLogic's startup sequence requires that the boot identity be verified against the security realm before the server completes initialization. Without a valid credential store, that verification cannot succeed. The server aborts.

At this point, the system is in a worse state than before the renaming: the original error was isolated to the LDAP initialization path; the new error means the entire security subsystem cannot start, and any further attempts to recreate or reinitialize the LDAP store without the correct credential hash will produce the same authentication failure.

---

## The WebLogic Startup Dependency Chain

To understand why security subsystem failure is fatal and unrecoverable-by-configuration, it helps to trace the WebLogic startup sequence explicitly.

When a WebLogic server JVM starts, initialization proceeds through a sequence of service groups, each of which must complete before the next can begin:

\`\`\`
1. JVM initialization
   |
   v
2. Kernel services (ports, network listeners, thread pools)
   |
   v
3. Security subsystem initialization
   |
   +-- PreEmbeddedLDAPService must complete
   +-- EmbeddedLDAP server must start and pass consistency checks
   +-- SecurityService must authenticate boot identity
   |
   v
4. AdminServer comes online (internal management channels active)
   |
   v
5. Managed servers connect to AdminServer
   |
   v
6. Applications deploy to managed servers
\`\`\`

If any step in the security subsystem initialization (step 3) throws an unchecked exception, WebLogic wraps all accumulated exceptions into the \`BEA-000386 MultiException\` and aborts the entire server process. There is no partial startup mode, no read-only security mode, and no bypass. Security initialization is a hard requirement for AdminServer startup.

Because managed servers in a WebLogic domain depend on the AdminServer for security realm access, a failed AdminServer startup means zero managed servers can connect. In an ATG deployment, \`prod_page_server1\` and all peer managed servers remain offline until AdminServer is healthy.

The dependency chain in object terms is:

\`\`\`
PreEmbeddedLDAPService
    must initialize before
        EmbeddedLDAP
            must initialize before
                SecurityService
                    must initialize before
                        AdminServer
                            must start before
                                prod_page_server1 and all managed servers
\`\`\`

A failure at \`PreEmbeddedLDAPService\` — the very first link in the chain — blocks every subsequent step. The entire ATG storefront remains down.

---

## Two Concrete Incident Cases

### Case 1: Production Storefront Outage

The incident described in this post involved a production ATG environment running WebLogic 12.1.3. The managed server \`prod_page_server1\` was handling high-traffic browse and checkout traffic when log rotation failed to cycle the output log file. Log growth continued uninterrupted until the filesystem hosting \`/opt/oracle/weblogic/user_projects/\` reached 100% capacity.

At the moment of exhaustion, the WebLogic managed server terminated with the \`ENOSPC\` I/O exception. The operations team cleared approximately 40GB of stale log files from the filesystem, verified that disk utilization had dropped to 62%, and attempted to restart the full domain.

AdminServer failed to start with the \`BEA-000386\` MultiException. The operations team, following standard troubleshooting runbooks, renamed the \`servers/AdminServer\` directory. The subsequent restart produced the authentication failure variant of the error. At this point the team escalated to middleware DBAs.

The root cause determination — LDAP corruption from disk exhaustion mid-write — was established by correlating the timestamp of the first \`ENOSPC\` log entry against the modification timestamps of the files in \`servers/AdminServer/data/ldap/\` and the \`EmbeddedLDAP.properties\` file.

Resolution required restoring the domain directory from the previous night's backup. Total downtime from initial crash to storefront recovery: approximately four hours. Business impact: ATG storefront completely unavailable for checkout and browse during a weekday business window.

### Case 2: Development Environment Domain Corruption

A developer running a local ATG development environment initiated a domain schema update that included modifications to security realm definitions. The update process involved WebLogic writing to the embedded LDAP store to persist the new role definitions. Midway through the update, the developer's local disk — an SSD with insufficient free space — hit 100% capacity.

The developer, recognizing that development environments are disposable, attempted to delete the domain directory entirely and recreate the domain from the provisioning scripts. This worked partially: the new domain initialized cleanly, but all security policy customizations, application-specific role mappings, and the developer's test user accounts were lost. The developer accepted this as acceptable for the development environment.

The important distinction from the production case is that in a development environment, recreating the domain is viable because the domain's security configuration is reproducible from scripts or documentation. In production, the domain's security configuration typically accumulates months or years of incremental changes — role definitions, user group additions, policy edits made through the WebLogic console — that are not fully captured in version-controlled configuration files. Recreating the production domain means permanently losing those accumulated changes. Domain restore from backup is not optional; it is the only path that preserves the full security configuration.

---

## The Resolution: Domain Directory Restore from Backup

The only reliable recovery from embedded LDAP corruption is restoring the domain directory from a backup taken before the disk exhaustion event. Every other approach either fails to resolve the initialization error or loses security configuration that cannot be recovered.

The restore procedure, in order:

**Step 1: Stop all restart attempts.**

Each failed startup attempt writes partial data to files in the domain directory. Continued restart attempts against a corrupted domain compound the damage. Once the \`BEA-000386\` MultiException is confirmed, halt all restart activity until the restore is ready.

**Step 2: Identify the correct backup.**

The backup must predate the disk exhaustion event. Identify the timestamp of the first \`ENOSPC\` log entry in the WebLogic or OS logs:

\`\`\`bash
grep -r "No space left on device" /opt/oracle/weblogic/user_projects/domains/base_domain/servers/*/logs/ \
  | head -5
\`\`\`

Cross-reference that timestamp against available backup sets. The backup immediately preceding the first \`ENOSPC\` entry is the target.

**Step 3: Restore the domain directory.**

The domain home is typically at a path similar to:

\`\`\`
/opt/oracle/weblogic/user_projects/domains/base_domain/
\`\`\`

At a minimum, the following subdirectories must be restored to a consistent state:

\`\`\`
base_domain/
├── config/          # Domain configuration, including config.xml and security realm definitions
├── security/        # Boot identity files (boot.properties for each server)
└── servers/
    └── AdminServer/
        └── data/
            └── ldap/   # The embedded LDAP store — the most critical component
\`\`\`

A full domain directory restore is safer than a selective restore if the backup system supports it, because partial restores risk leaving mixed-vintage files that create secondary inconsistencies.

**Step 4: Verify disk space before restart.**

Before initiating any server start, confirm that the filesystem is not at risk of refilling:

\`\`\`bash
df -h /opt/oracle/weblogic/user_projects/
\`\`\`

The filesystem should have at least 20% free space before restart. Identify what consumed the disk and confirm it has been removed or that log rotation is in place to prevent recurrence.

**Step 5: Start AdminServer and verify LDAP initialization.**

Start the AdminServer and monitor the server log for LDAP initialization messages. A clean initialization will contain:

\`\`\`
<Notice> <Security> <BEA-090905> <Disabling the CryptoJ JCE Provider self-integrity check for better startup performance...>
<Notice> <WebLogicServer> <BEA-000365> <Server state changed to STARTING>
<Notice> <Security> <BEA-090946> <Security pre-initializing using security realm: myrealm>
<Notice> <Security> <BEA-090947> <Security post-initializing using security realm: myrealm>
<Notice> <WebLogicServer> <BEA-000360> <Server started in RUNNING mode>
\`\`\`

The absence of \`BEA-000386\` and the presence of the \`RUNNING\` state message confirm that the LDAP store is intact and the security subsystem initialized cleanly.

**Step 6: Start managed ATG servers.**

Once AdminServer is confirmed running and the security realm is healthy, start the managed servers — \`prod_page_server1\` and any peer managed servers — in the normal sequence.

---

## Alternative Recovery When No Backup Is Available

If no domain backup exists and the environment cannot afford the full security configuration loss that domain recreation would cause, there is a riskier partial recovery path. This path is only viable if the LDAP corruption is isolated to the BDB data files and the \`EmbeddedLDAP.properties\` file is intact.

**Assessment: verify EmbeddedLDAP.properties integrity.**

\`\`\`bash
# Check that the file is non-zero and contains readable properties
wc -c /opt/oracle/weblogic/user_projects/domains/base_domain/servers/AdminServer/data/ldap/EmbeddedLDAP.properties
cat /opt/oracle/weblogic/user_projects/domains/base_domain/servers/AdminServer/data/ldap/EmbeddedLDAP.properties
\`\`\`

If the file is zero-length or contains garbled content, this path is not viable and domain recreation becomes the only option.

**If EmbeddedLDAP.properties is intact:**

Delete only the BDB data files while preserving the properties file:

\`\`\`bash
# Remove only the BDB data store directory
rm -rf /opt/oracle/weblogic/user_projects/domains/base_domain/servers/AdminServer/data/ldap/ldapfiles/

# Preserve EmbeddedLDAP.properties — do NOT delete it
\`\`\`

On next startup, WebLogic will detect the absent \`ldapfiles/\` directory, treat it as a first-time initialization scenario, and rebuild the LDAP store from the security realm definitions in \`config/config.xml\`.

**Risk acknowledgment:** The rebuilt LDAP store contains only the security realm structure defined in \`config.xml\` — user groups, role definitions, and the default administrator account. Any users, groups, or policy changes that were created through the WebLogic console or LDAP tools after the domain's initial configuration will not be present in the rebuilt store. This data loss is permanent.

This path is acceptable only for environments where the embedded LDAP store contains only the default \`weblogic\` administrator account and no additional users or policy customizations have been made. For any production environment where security policies have been modified post-installation, backup restore is the correct path.

---

## Prevention: Treating the Domain Directory as Data

### Filesystem Monitoring

Separate log filesystems from domain filesystems. WebLogic server output logs, ATG application logs, and GC logs should reside on a different mount point than the WebLogic domain directory. A runaway log file that fills \`/opt/oracle/weblogic/logs/\` should not be able to corrupt \`/opt/oracle/weblogic/user_projects/domains/\`.

Monitor filesystem utilization with tiered alerts. A minimal cron-based check:

\`\`\`bash
# Add to crontab: run every 5 minutes
*/5 * * * * df -h /opt/oracle/weblogic/user_projects/ | awk 'NR==2{gsub(/%/,"",$5); if($5>=80) print "WARNING: domain filesystem at "$5"% on $(hostname)"}' | mail -s "Disk Alert" ops-team@example.com
\`\`\`

Production thresholds:
- 80%: Warning alert — investigate and remediate before the window closes
- 90%: High-priority alert — treat as an active incident
- 95%: Emergency — stop non-critical services preemptively, do not wait for crash

### WebLogic Log Rotation Configuration

Configure WebLogic's built-in log rotation to prevent runaway log growth. In the domain's \`config/config.xml\`, within each server definition:

\`\`\`xml
<log>
  <file-name>logs/prod_page_server1.log</file-name>
  <rotation-type>bySize</rotation-type>
  <file-min-size>5000</file-min-size>
  <file-count>10</file-count>
  <rotate-log-on-startup>true</rotate-log-on-startup>
</log>
\`\`\`

This configuration limits each log file to 5MB with a maximum of 10 retained files — a ceiling of 50MB per server regardless of how long the server has been running. ATG application logs managed by Log4j or SLF4J should have equivalent rotation policies configured in their respective appender definitions.

### Domain Directory Backup

The WebLogic domain directory must be treated as operational data — not just configuration. It changes on every security policy modification, every LDAP store update, and every WebLogic console change. A version-controlled copy of \`config.xml\` is not a sufficient substitute.

Recommended backup approach: nightly compressed archive of the domain directory, excluding transient directories that add bulk without recovery value:

\`\`\`bash
#!/bin/bash
DOMAIN_HOME=/opt/oracle/weblogic/user_projects/domains/base_domain
BACKUP_DIR=/opt/backups/weblogic-domain
TIMESTAMP=\$(date +%Y%m%d_%H%M%S)

tar --exclude="\${DOMAIN_HOME}/servers/*/tmp" \
    --exclude="\${DOMAIN_HOME}/servers/*/cache" \
    -czf "\${BACKUP_DIR}/base_domain_\${TIMESTAMP}.tar.gz" \
    "\${DOMAIN_HOME}"

# Retain 14 days of backups
find "\${BACKUP_DIR}" -name "base_domain_*.tar.gz" -mtime +14 -delete
\`\`\`

At a minimum, take a manual backup before every WebLogic configuration change, before every ATG application deployment, and before every OS-level maintenance window.

### Embedded LDAP Export

WebLogic's administration console provides an export facility for the embedded LDAP store. Navigate to:

\`\`\`
Security Realms → myrealm → Migration tab → Export
\`\`\`

This exports the LDAP store contents as an LDIF file, which can be imported into a fresh LDAP store to restore users, groups, and policies without a full domain restore. Export the LDAP store after every security policy change. This provides a faster recovery option for scenarios where the domain structure is intact but only the LDAP data is lost.

---

## Summary

A full disk on a WebLogic host is not a recoverable-by-restart situation when the disk exhaustion event occurred while the embedded LDAP data files were being written. The mechanism is straightforward: Berkeley DB data files require page-aligned, consistent writes; a partial write caused by \`ENOSPC\` leaves the store in a state that the LDAP subsystem cannot open, verify, or recover automatically.

The \`BEA-000386\` Critical MultiException containing \`NumberFormatException: null\` and \`Unable to perform operation: post construct on weblogic.ldap.PreEmbeddedLDAPService\` is the definitive diagnostic signature. It is not a transient error. It is not resolved by clearing disk space, restarting the JVM, or renaming the AdminServer directory. Renaming the AdminServer directory converts the LDAP initialization failure into an authentication failure, which is a different and harder problem.

The only reliable recovery path is restoring the domain directory from a backup taken before the disk exhaustion event. The minimum restore scope is \`config/\`, \`security/\`, and \`servers/AdminServer/data/ldap/\` — but a full domain directory restore is preferable when the backup system supports it.

Prevention requires four parallel controls: separate mount points for logs and domain data; filesystem monitoring with tiered alerts at 80%, 90%, and 95% thresholds; WebLogic log rotation configured with size-based limits and file count caps; and nightly compressed backups of the domain directory treated with the same retention and verification discipline as database backups. The embedded LDAP store is not a cache. It is the credential and policy store for the entire WebLogic security realm. It deserves backup policies that reflect that fact.`,
};

async function main() {
  console.log('Inserting WebLogic LDAP corruption blog post...');
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
