import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS 12.2.11 Cloning: Architecture, adpreclone, and adcfgclone',
  slug: 'oracle-ebs-12211-cloning',
  excerpt:
    'A technical guide to cloning Oracle EBS 12.2.11 using the standard adpreclone and adcfgclone framework: why EBS cloning is architecturally different from a pure database copy, what adpreclone captures and why it must run on a live source, how adcfgclone reconstructs the EBS identity on the target using the context file, the dual-filesystem complication introduced by online patching, and the post-clone hardening steps that prevent a refreshed environment from interfering with production systems.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-29'),
  youtubeUrl: null,
  content: `## Introduction

Cloning an Oracle E-Business Suite instance is one of the most operationally significant tasks an Apps DBA performs. A clone creates a fully functional copy of a production environment — typically for development, testing, training, or disaster recovery staging — and it must do so in a way that makes the target environment completely independent of the source. Users on the cloned instance must not accidentally affect production data, send production emails, trigger production integrations, or share production wallet or payment gateway credentials.

EBS 12.2 cloning is substantially more complex than cloning a standalone Oracle database. A production EBS environment spans multiple tiers: the Oracle Database tier (which may itself be a multi-node RAC cluster with Data Guard standby), one or more application tiers running WebLogic, Oracle HTTP Server, Oracle Forms Server, and Concurrent Processing Server, and shared filesystems for concurrent logs and patches. Copying the database alone produces nothing useful. All tiers must be cloned in a coordinated sequence, and the target environment must be reconfigured with its own hostname, ports, URLs, database service names, and application passwords before it can start.

This is what the **adpreclone** and **adcfgclone** utilities were built to handle.

---

## The Two Utilities and What They Do

### adpreclone — Prepare the Source

\`adpreclone.pl\` runs on the **source** (production) environment before the copy begins. It does not copy any files itself — it prepares the source filesystem and database so that the subsequent copy produces a self-contained, relocatable snapshot.

For the **database tier**, adpreclone:
- Generates a serialized representation of the current database configuration (ORACLE_HOME, SID, TNS aliases, listener configuration, init parameters)
- Copies the current EBS context file into the ORACLE_HOME/appsutil directory where adcfgclone will find it
- Removes any target-specific artifacts from the previous clone preparation
- Creates the adcfgclone infrastructure scripts inside the ORACLE_HOME that will be carried over in the database home copy

For the **application tier**, adpreclone:
- Serializes the application tier configuration: all directory paths, ports, WebLogic domain structure, Forms configuration, AutoConfig context variables
- Packages the AutoConfig template library so the target can regenerate all configuration files from scratch using its own context values
- Removes cached and compiled artifacts (JSP work directories, OAF object cache, WebLogic tmp/cache directories) from the APPL_TOP so the copy does not include stale state
- Prepares the tar manifest for a clean application tier transport

adpreclone must run against a **live EBS source** — or more precisely, against an EBS environment where the database is accessible at the point of preparation. It does not require users to be logged out, but the database must be open.

### adcfgclone — Configure the Target

\`adcfgclone.pl\` runs on the **target** environment after the copy is complete. It is the workhorse of the EBS clone. Given a new context file populated with the target's hostnames, ports, database service name, and directory paths, adcfgclone:

- Generates all EBS configuration files (tnsnames.ora, listener.ora, dbc files, WebLogic domain config, Forms server configuration, OPMN configuration, httpd.conf, and dozens more) by running AutoConfig against the target context
- Relinks the Oracle binaries against the target ORACLE_HOME
- Registers the new instance in the EBS database (FND_NODES, FND_CONCURRENT_QUEUES)
- Updates database parameters that reference the source hostname or instance name
- Configures the WebLogic domain with the target passwords and admin server URL
- Creates the systemd or init.d service configuration for the target host

The context file is the pivot point of the entire clone. It is an XML file (~3,000 parameters) that describes every configuration variable in the EBS environment. The DBA creates the target context file by editing the source context file and replacing every source-specific value (hostname, IP, database SID, ports, admin passwords) with target values. adcfgclone reads this file and uses it to drive AutoConfig across the entire application and database tier configuration.

---

## The Clone Workflow

The standard EBS 12.2.11 clone sequence has four stages:

### Stage 1: Prepare the Source

Run adpreclone on the source database tier and all source application tiers while the source is live. This is a read-only preparation — it does not modify any data or configuration that users depend on.

\`\`\`
Source DB server:    perl $ORACLE_HOME/appsutil/scripts/$CONTEXT_NAME/adpreclone.pl dbTier
Source App server:   perl $COMMON_TOP/clone/bin/adpreclone.pl appsTier
\`\`\`

### Stage 2: Copy the Source to the Target

After adpreclone completes, copy the filesystems to the target hosts. The database tier copy uses RMAN (active duplicate or backup-based duplicate). The application tier uses tar with compression, typically piped over SSH or written to shared storage.

The database copy must be consistent — either a cold backup (database shut down) or an RMAN active duplicate (hot, from a live source). The application tier copy does not need to be synchronized to the exact same SCN as the database, because the application tier contains no transactional data. Application tier files are configuration and code, not data.

### Stage 3: Configure the Target

Run adcfgclone on the target database tier first, then on each target application tier. adcfgclone drives AutoConfig which regenerates all configuration files from the target context.

\`\`\`
Target DB server:    perl $ORACLE_HOME/appsutil/clone/bin/adcfgclone.pl dbTier
Target App server:   perl $COMMON_TOP/clone/bin/adcfgclone.pl appsTier
\`\`\`

### Stage 4: Post-Clone Hardening

The most critical and most often skipped stage. A freshly cloned EBS instance has the source environment's application passwords, workflow mailer configuration, external integration endpoints, Oracle Payments configuration, and system name. Without hardening, the clone is a production environment wearing a different hostname — and it can cause production incidents.

---

## The Dual-Filesystem Complication in EBS 12.2

EBS 12.2 introduces a clone-specific complication that did not exist in EBS 12.1: the dual-filesystem architecture used for online patching (fs1/fs2/fs_ne). The source has two complete application filesystems — the active RUN filesystem and the dormant PATCH filesystem — plus the non-editioned shared filesystem.

When cloning, the DBA must decide:

**Option A: Clone the RUN filesystem only.** Copy only the active RUN filesystem (e.g., fs1 if fs1 is currently RUN) to the target. The target will have a single application filesystem, and adcfgclone will create the fs2 structure as empty, ready for the first adop prepare cycle. This is the recommended approach for test and development clones where the adop cycle history does not matter.

**Option B: Clone both filesystems.** Copy both fs1 and fs2 to the target. This preserves the complete dual-filesystem state including any in-progress adop cycle. This approach is used when the clone is for a near-production DR purpose and the target must be immediately patchable without a full prepare cycle.

For most operational clones (refresh DEV or TEST from PROD), Option A is standard. The adop infrastructure is rebuilt on the target from scratch when the first adop prepare runs.

The fs_ne (non-editioned) filesystem always goes to the target — it contains the AutoConfig context file, concurrent log directories, and other shared content that adcfgclone needs.

---

## The Context File: Source of Identity

The context file is the single most important artifact in an EBS clone. It is an XML file stored at:

\`\`\`
$INST_TOP/appl/admin/<CONTEXT_NAME>.xml   (application tier)
$ORACLE_HOME/appsutil/<CONTEXT_NAME>.xml  (database tier)
\`\`\`

where CONTEXT_NAME is the compound identifier \`<SID>_<hostname>\`. For a production instance on host \`ebsprod01\` with SID \`EBSPRD\`, the context name is \`EBSPRD_ebsprod01\`.

Before running adcfgclone on the target, the DBA creates the target context file by:
1. Copying the source context file to the target
2. Running the \`adbldxml.pl\` script to create a fresh skeleton from the target's OS parameters, or
3. Editing the source context file directly and substituting all source-specific values

The most critical substitutions are:
- \`s_dbSid\`: target database SID
- \`s_dbhost\`: target database hostname
- \`s_hostname\`: target application server hostname
- \`s_base\`, \`s_appl_top\`, \`s_inst_top\`, \`s_common_top\`: target directory paths
- \`s_webentryurlprotocol\`, \`s_webentryhost\`, \`s_webentryport\`: target application URL
- \`s_apps_passwd\`, \`s_wls_admin_passwd\`: target application passwords
- All port numbers if the target uses different ports than the source

AutoConfig uses the context file as the template source for every configuration file it generates. An incorrect value in the context file produces incorrect configuration across dozens of downstream files — and the resulting adcfgclone run either fails or produces an environment that cannot start.

---

## Database Tier Clone: RMAN Active Duplicate

The standard method for copying the EBS database to the target is RMAN active duplicate. This streams the database directly from the source to the target over the network while the source continues to run — no production outage is required.

The RMAN command runs on the target auxiliary instance (the target database in nomount state) and pulls data from the source:

\`\`\`sql
DUPLICATE TARGET DATABASE TO <target_sid>
  FROM ACTIVE DATABASE
  USING BACKUPSET
  PASSWORD FILE
  SPFILE
    SET DB_UNIQUE_NAME='<target_sid>'
    SET DB_NAME='<target_sid>'
    SET CONTROL_FILES='<target_controlfile_paths>'
    SET LOG_FILE_NAME_CONVERT='<source_redo_path>','<target_redo_path>'
    SET DB_FILE_NAME_CONVERT='<source_data_path>','<target_data_path>'
    NOFILENAMECHECK;
\`\`\`

After the duplicate completes, the target database is open with the source's data. adcfgclone then reconfigures it for the target environment: renaming the database service, updating the APPS schema parameters, and running AutoConfig against the target context.

---

## Post-Clone Hardening: The Critical Safety Layer

A cloned environment that has not been hardened is dangerous. The following changes must be made before the target environment is used for any purpose other than DBA-controlled testing.

### Change Application Passwords

The APPS and SYSADMIN passwords are identical to production immediately after clone. Change them immediately:

\`\`\`bash
# Change APPS schema password
FNDCPASS apps/<current_apps_passwd> 0 Y system/<system_passwd> SYSTEM APPSUSER APPS <new_apps_passwd>

# Change SYSADMIN user password
FNDCPASS apps/<new_apps_passwd> 0 Y system/<system_passwd> USER SYSADMIN <new_sysadmin_passwd>
\`\`\`

### Disable Workflow Mailer

The Workflow Notification Mailer will send emails to real users if left enabled. Disable it before starting EBS:

\`\`\`sql
UPDATE WF_MAILER_PARAMETERS
SET PARAMETER_VALUE = 'N'
WHERE PARAMETER_NAME = 'SEND_EMAIL'
AND ITEM_TYPE = 'WFMLRSND';
COMMIT;
\`\`\`

### Disable External Integrations and Concurrent Programs

Disable any concurrent programs or scheduled jobs that interface with external systems: payment gateways, EDI trading partners, procurement punchout sites, tax engines, and credit check services. A cloned instance running these programs against production endpoints causes real-world transactions from test data.

### Change the System Name

EBS stores the instance name in FND_PRODUCT_GROUPS. Change it so users can distinguish the clone from production:

\`\`\`sql
UPDATE FND_PRODUCT_GROUPS
SET APPLICATIONS_SYSTEM_NAME = 'DEV_CLONE'
WHERE ROWNUM = 1;
COMMIT;
\`\`\`

### Oracle Payments Configuration

Oracle Payments stores payment gateway connection details (URLs, credentials, encryption keys) in the database. These must be cleared or redirected to a test gateway on the clone. Running Oracle Payments against a production gateway from a test instance can charge real credit cards or trigger real settlements.

### Purge Workflow Notification Queue

Clear any pending workflow notifications that were queued in production but not yet processed:

\`\`\`sql
EXEC WF_PURGE.TOTAL(ITEMTYPE => NULL, ITEMKEY => NULL, ENDDATE => SYSDATE, DOCOMMIT => TRUE);
\`\`\`

---

## Summary

EBS 12.2.11 cloning is a multi-stage, multi-tier operation governed by the adpreclone and adcfgclone framework. adpreclone captures the source configuration while it runs; adcfgclone reconstructs the environment's identity on the target using the context file as its guide. The dual-filesystem architecture of EBS 12.2 adds the choice of cloning only the active RUN filesystem (recommended for most operational clones) versus both filesystems.

The database tier copies via RMAN active duplicate — no source outage required. The application tier copies via tar transport. After adcfgclone completes on both tiers, the environment starts with the source's application passwords and all of its external integration configuration intact. Post-clone hardening is not optional: changing passwords, disabling the workflow mailer, disabling external integration programs, and changing the system name are the minimum steps before handing any clone to users.

The companion runbook provides the exact command sequence for each stage, the context file variables that must be updated for the target, and post-clone validation queries.`,
};

async function main() {
  console.log('Inserting EBS 12.2.11 cloning blog post...');
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
