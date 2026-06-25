import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS 12.2.11 DR Testing with Snapshot Standby: Cache Clearing, AutoConfig, and Site Identification',
  slug: 'oracle-ebs-12211-dr-snapshot-standby-test',
  excerpt:
    'A technical guide to Oracle EBS 12.2.11 DR testing using Oracle snapshot standby — how snapshot standby preserves redo transport during tests, the adautoconfig sequence required on the DR app tier, what cache layers must be cleared before EBS is usable, and how to configure a visible DR site identifier through the system name, banner profile options, and color scheme change so users never mistake the DR environment for production.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-25'),
  youtubeUrl: null,
  content: `## Overview

DR tests for Oracle E-Business Suite 12.2.11 using a physical standby database have a fundamental problem: activating the standby as a primary (failover or switchover) breaks the replication relationship, and rebuilding it takes hours. Most EBS environments cannot afford to lose their standby protection for the 6–12 hours a full DR test and rebuild cycle requires.

Oracle snapshot standby solves this. A snapshot standby is a physical standby database that has been converted to read-write mode for testing while Oracle continues to receive and buffer redo from the primary — but does not apply it. When the test is complete, the standby is converted back to a physical standby, flashes back to the pre-test state using a guaranteed restore point that Oracle created automatically, and resumes redo apply. The entire DR test happens without dismantling the replication relationship.

This post covers the snapshot standby mechanism, the EBS 12.2.11 application tier preparation required to make the DR environment functional, the cache clearing steps that are missed most often, and the DR site identification approach — system name, banner, and color scheme — that prevents users from confusing the DR site with production.

---

## Snapshot Standby: What It Is and How It Works

A physical standby in managed recovery mode applies redo continuously from the primary. To run a DR test, the standby must be opened read-write — which is incompatible with applying redo. Snapshot standby resolves this conflict through a three-part mechanism:

**1. Guaranteed Restore Point**: when you issue \`ALTER DATABASE CONVERT TO SNAPSHOT STANDBY\`, Oracle automatically creates a system-managed guaranteed restore point (named \`SNAPSHOT_STANDBY_REQUIRED_XXXXXXXXXX\`). This restore point pins the SCN at the moment of conversion so the database can be flashed back to exactly this state later.

**2. Read-Write Access**: the standby database is opened read-write. Any changes you make — EBS transactions, AutoConfig writes, schema modifications — are written to the standby's datafiles normally. The primary has no knowledge of these changes.

**3. Redo Buffering Without Application**: while the standby is in snapshot mode, redo transport from the primary continues. Archived logs from the primary arrive at the standby and are stored in the archive destination, but the MRP (Media Recovery Process) does not apply them. The transport lag stays near zero; the apply lag grows for the duration of the test.

When the test is complete and you issue \`ALTER DATABASE CONVERT TO PHYSICAL STANDBY\`, Oracle:
1. Shuts down the read-write instance
2. Flashes back the database to the guaranteed restore point, discarding all changes made during the test
3. Opens the database in mount mode
4. Resumes managed recovery

The standby then applies all buffered redo that accumulated during the test window, catching up to the primary. For a 4-hour DR test with a 10 GB/hour redo rate, the standby will need to apply approximately 40 GB of buffered redo. On a well-sized system, this catchup completes in minutes.

### What Is and Is Not Preserved

| Item | During Snapshot Test | After Convert Back |
|------|---------------------|-------------------|
| Primary database changes | Replicated (buffered) | Applied after catchup |
| Standby DB changes (EBS transactions, AutoConfig) | Present | **Discarded** |
| Redo transport | Active | Active |
| Apply lag | Grows during test | Catches up automatically |
| Replication relationship | Intact | Intact |
| Guaranteed restore point | Present | Dropped automatically |

The key implication for EBS: any EBS data entered into the DR site during the test (test invoices, test journal entries, user sessions) is permanently discarded when the standby converts back. This makes snapshot standby ideal for DR testing — the DR environment is a real production-grade test without creating a contamination problem.

---

## Snapshot Standby Prerequisites

Before converting to snapshot standby:

**Flashback Database must be enabled on the standby**. The guaranteed restore point requires Flashback Database. Check and enable if needed:

\`\`\`sql
SELECT FLASHBACK_ON FROM V\$DATABASE;
-- If NO:
ALTER DATABASE FLASHBACK ON;
\`\`\`

**Fast Recovery Area (FRA) must be sized appropriately**. The FRA on the standby stores flashback logs for the duration of the test. For a 4-hour test at 10 GB/hour redo rate, the FRA needs at least 40–60 GB of free space beyond its normal backup requirements.

**DB_FLASHBACK_RETENTION_TARGET** must be set to at least the planned test duration in minutes:

\`\`\`sql
ALTER SYSTEM SET DB_FLASHBACK_RETENTION_TARGET=480; -- 8 hours, in minutes
\`\`\`

---

## EBS Application Tier Preparation

Converting the standby database to snapshot standby makes the database writable, but the EBS application tier on the DR server is not automatically ready to serve traffic. Two preparation steps are mandatory: adautoconfig and cache clearing.

### Why adautoconfig Is Required

The EBS application tier configuration files — \`dbc\` files, WebLogic \`jdbc.xml\` descriptors, OHS \`apps.conf\`, Forms \`appsweb.cfg\`, Concurrent Manager configuration — contain environment-specific values: the database hostname, service name, port, and in some cases the JDBC URL written with the primary's hostname. After an rsync from the primary app tier, these files contain the primary's connection details.

AutoConfig (adautoconfig or adconfig.pl) reads the EBS context XML file and rewrites all environment-specific configuration files from scratch. Running AutoConfig on the DR app tier with a DR-specific context file — one that references the DR database hostname — rewrites all connection strings to point to the snapshot standby database. Without this step, EBS services will start but silently fail to process requests because they attempt to connect to the primary database rather than the local snapshot standby.

### What adautoconfig Writes

AutoConfig writes over 900 files across the EBS application tier filesystem. The most operationally significant:

| File | Why It Matters |
|------|---------------|
| \`\$FND_SECURE/\${TWO_TASK}.dbc\` | Applications JDBC connection descriptor — every database session uses this |
| \`\$DOMAIN_HOME/config/jdbc/*.xml\` | WebLogic datasource JDBC URLs |
| \`\$OHS_CONF_DIR/apps.conf\` | OHS mod_wl_ohs directives, virtual host settings |
| \`\$FORMS_WEB_CFG/appsweb.cfg\` | Oracle Forms server and DB connection parameters |
| \`\$ADMIN_SCRIPTS_HOME/addbctl.sh\` | Database control script — must reference correct SID/host |
| Concurrent Manager config | Database connection for CM processes |

The context file at \`\$CONTEXT_FILE\` (an XML file under \`fs_ne/inst/\`) must be updated before running AutoConfig to reflect:
- \`s_dbhost\`: DR database hostname
- \`s_db_name\` / \`s_apps_jdbc_connect_alias\`: DR service name
- \`s_apps_hostname\`: DR application tier hostname

### Why Cache Clearing Is Required

EBS 12.2 has multiple cache layers that must be cleared after AutoConfig to ensure the application serves the reconfigured connection details rather than stale cached values:

**OA Framework (OAF) object cache**: stores compiled page metadata, menu structures, and profile values in memory and on the filesystem. After AutoConfig changes profile values and database connection details, the OAF cache must be cleared so it reads from the DR database rather than serving cached data from the primary.

**WebLogic class cache** (\`\$DOMAIN_HOME/servers/*/cache/\`): the JVM's class loading cache for deployed applications. After stopping and clearing this, WebLogic reloads all class files and picks up the reconfigured JDBC datasources.

**WebLogic tmp directory** (\`\$DOMAIN_HOME/servers/*/tmp/\`): contains unpacked EAR/WAR deployment artifacts. Clearing this forces a clean redeployment on next server start.

**Oracle HTTP Server (OHS) cache**: OHS caches SSL sessions and static content. Clearing and restarting OHS ensures it uses the reconfigured \`apps.conf\` directives.

**Forms cache**: compiled Forms binaries are cached in \`\$FORMS_OAF_JINI_TOP\`. Clearing this forces Forms to use the newly configured connection parameters.

If any of these cache layers is not cleared, EBS will appear to start normally but will exhibit unexplained connection errors, stale menu structures, or forms that open but fail to query data — all of which are symptoms of cached connection details pointing to the primary rather than the DR database.

---

## DR Site Identification

A DR test that leaves the environment indistinguishable from production is a DR test that will eventually produce a production incident. Users who believe they are accessing production will submit real transactions; integrations that are re-pointed to the DR environment will process real data; and DBAs who switch between browser tabs may inadvertently run a destructive command on production while thinking they are on DR.

Three layers of identification are used together:

### Layer 1: System Name in FND_PRODUCT_GROUPS

EBS writes the application system name from \`FND_PRODUCT_GROUPS.APPLICATIONS_SYSTEM_NAME\` into the browser window title and the EBS header instance identifier. Updating this to \`DR SITE — VIS\` is a database-level change that propagates to all users immediately, requires no application restart, and survives AutoConfig because AutoConfig does not overwrite this table value.

\`\`\`sql
UPDATE FND_PRODUCT_GROUPS SET APPLICATIONS_SYSTEM_NAME = 'DR SITE — VIS';
COMMIT;
\`\`\`

### Layer 2: Login Page and Welcome Banner

The EBS FND profile option \`FND: Branding Image\` (and the companion \`FND: Branding Size\`) allows a custom image or banner to be displayed in the EBS header on every page. Setting a site-level FND profile value for \`APPS_FRAMEWORK_AGENT\` hostname banner or using the \`GUEST_USER_PWD\` login page header configuration allows a visible "DR SITE" message before users even authenticate.

For a text-based banner that persists without image file management, the \`FND_USER_PREFERENCES\` and site-level FND profile \`FND: Display Name\` can inject a site identifier into the application header.

The most reliable EBS 12.2 approach — one that survives AutoConfig and requires no image management — is setting the FND profile \`HELP_UTIL_SERVLET_WELCOME_MESSAGE\` at site level to a string containing \`*** DR SITE ***\`. This value appears in the EBS Help header visible from every page.

### Layer 3: Color Scheme Change

EBS 12.2 OA Framework applies a skin (CSS theme) to all pages. The skin is controlled by the FND profile option \`FND_LOOK_AND_FEEL\` at site level. Oracle ships several skins with EBS 12.2. Changing the skin on the DR environment provides an immediate, full-page visual indicator that every user sees on every page — without touching any EBS application code.

The Oracle Functional Administrator responsibility (\`FNDSCSGN\` function) provides a UI path to change the branding color scheme: **Functional Administrator → Core Services → Branding**. The Branding page allows uploading a custom logo, setting a header background color, and selecting a skin.

For a fast color change via profile option:

\`\`\`sql
BEGIN
  FND_PROFILE.SAVE(
    X_NAME  => 'FND_LOOK_AND_FEEL',
    X_VALUE => 'BLAF',   -- Oracle Blue Application Look and Feel (different from default)
    X_LEVEL_NAME => 'SITE',
    X_LEVEL_VALUE => NULL
  );
  COMMIT;
END;
/
\`\`\`

Available skin values in EBS 12.2 include \`BLAF\` (Oracle blue), \`BLAF+\` (Oracle blue plus), and custom skins loaded into \`\$OA_HTML/cabo/styles/\`. A custom skin with a red or amber global header — placed in \`\$OA_HTML/cabo/styles/\` and synced to DR — provides the most visually distinctive DR identifier.

---

## RPO and RTO for Snapshot Standby DR Tests

### Test Impact on RPO

During the snapshot standby test, redo transport continues from primary to standby — the transport lag remains at its normal 1–30 second value. However, the apply lag grows for the entire test duration. If the test runs for 4 hours:

- **Transport lag at test end**: still 1–30 seconds (redo is arriving and being stored)
- **Apply lag at test end**: 4 hours
- **Time to full catchup after converting back**: dependent on redo volume, typically 10–30 minutes for a 4-hour test on a well-resourced standby

During the catchup window after converting back, the standby is applying redo and is in a transient state. The effective RPO during catchup is the volume of unapplied redo still outstanding.

### Test Sequence Timing

| Activity | Typical Duration |
|----------|----------------|
| Convert physical to snapshot standby | 2–5 minutes |
| Rsync verification and context file update | 15–30 minutes |
| adautoconfig on DR app tier | 10–20 minutes |
| Cache clearing and service start | 5–10 minutes |
| DR site identification (system name, banner, color) | 5 minutes |
| Functional validation | 30–60 minutes |
| Document results | 15 minutes |
| Convert snapshot back to physical standby | 2–5 minutes |
| Redo catchup after conversion | 10–30 minutes |
| **Total test window** | **~90–150 minutes** |

The ability to run a 2-hour DR test without breaking the replication relationship — and to repeat it quarterly — is the primary operational advantage of snapshot standby over traditional DR tests.

---

## Monitoring During a Snapshot Standby Test

Two metrics require active monitoring during the test window:

**FRA space usage**: the standby is writing flashback logs and buffering redo for the entire test duration. If the FRA fills, the snapshot standby test cannot be reverted — Oracle will have consumed the flashback logs needed to roll back, and the standby must be rebuilt. Monitor \`V\$RECOVERY_FILE_DEST\` for space consumption throughout the test.

**Redo transport status**: confirm that redo from the primary continues to arrive at the standby's archive destination during the test. The \`V\$ARCHIVED_LOG\` view on the standby should show primary-generated archived logs arriving with recent timestamps. A gap in received logs means either a network issue or a redo transport misconfiguration that will leave the standby behind when it converts back.

---

## Summary

Snapshot standby is the correct mechanism for quarterly EBS 12.2.11 DR tests because it provides read-write access to the standby database without dismantling the replication relationship. The database-level procedure — convert, test, convert back — takes less than 10 minutes in each direction. The dominant time cost is the EBS application tier preparation: adautoconfig to rewrite 900+ configuration files with DR connection details, and a systematic cache clear across the OAF object cache, WebLogic class cache, WebLogic tmp directories, and OHS cache. Skipping either step produces a partially-functional EBS environment that passes superficial checks but fails under load. DR site identification must use all three layers — system name (FND_PRODUCT_GROUPS), banner (FND profile), and color scheme (OAF skin) — because any single identifier is too easy to overlook when an administrator is switching between environments under pressure. The companion runbook provides the complete command sequence for each phase, including the SQL commands for site identification, the specific cache directories to clear, the crontab monitoring scripts for FRA space and redo transport health during the test window, and the post-test validation checklist.`,
};

async function main() {
  console.log('Inserting EBS DR snapshot standby blog post...');
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
