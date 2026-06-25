import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS 12.2.11 Cloning Using PDB on RHEL 9: Architecture, Methods, and adpreclone/adcfgclone Framework',
  slug: 'oracle-ebs-12211-clone-pdb-rhel9',
  excerpt:
    'A technical guide to cloning Oracle E-Business Suite 12.2.11 to a Pluggable Database (PDB) on RHEL 9 — why PDB cloning accelerates EBS refresh cycles, how RMAN active duplication converts a non-CDB production database into a PDB, the mandatory noncdb_to_pdb.sql conversion step, the adpreclone and adcfgclone framework for both database and application tiers, and the post-clone hardening steps that prevent a clone from interfering with production.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-25'),
  youtubeUrl: null,
  content: `## Overview

Cloning Oracle E-Business Suite 12.2.11 for test, development, or UAT environments is a routine DBA operation that historically took 12–24 hours using traditional RMAN restore and adcfgclone. Oracle 19c's Pluggable Database (PDB) architecture changes this in two important ways. First, a non-CDB production database can be cloned directly into a PDB inside a Container Database (CDB) using RMAN active duplication, which streams the clone over the network without requiring a cold backup window. Second, once a test environment PDB exists, subsequent refreshes can use \`CREATE PLUGGABLE DATABASE ... FROM\` or PDB relocate operations that take minutes rather than hours.

This post covers the EBS 12.2.11 cloning architecture with PDB as the target, the non-CDB to PDB conversion path that most production environments need, the adpreclone and adcfgclone framework that Oracle's cloning procedure depends on, the application tier cloning workflow, and the post-clone configuration steps that protect production from a misconfigured clone.

---

## Why PDB for EBS Cloning

Most Oracle EBS 12.2.11 production environments run on a non-CDB Oracle 19c database — this has been the standard architecture because EBS 12.2 was certified on non-CDB long before Oracle published guidance for running EBS inside a PDB. The production database does not need to change. The PDB benefit comes entirely on the **clone side**: the test or development environment database runs as a PDB inside a CDB, which enables faster refresh cycles and easier multi-environment management.

### Speed Advantage: RMAN Active Duplication

Traditional EBS cloning requires an offline RMAN backup of the production database followed by a full restore on the target — typically 4–8 hours for a 2 TB EBS database. RMAN active duplication clones the database over a network connection from the running production instance directly to the target, with no offline backup required. When targeting a PDB, the same active duplication syntax works with the \`AS PLUGGABLE DATABASE\` clause.

### Multi-Environment Sharing

Once a CDB exists on the test server, multiple PDBs can share the same Oracle binary installation, SGA, and background processes. A 32 GB SGA on the CDB host can serve DEV, TEST, and UAT PDBs simultaneously, each with independent EBS application tier instances. Without CDB, each environment would require a dedicated non-CDB instance consuming its own SGA.

### Faster Refresh Cycles

After the initial clone, refreshing a PDB-based test environment can use \`CREATE PLUGGABLE DATABASE test_refresh FROM vis_prod@prod_link\`, which creates a new PDB clone from the production PDB without stopping either database. The old test PDB is dropped and the new one is renamed. This refresh cycle can complete in under 30 minutes — including the adcfgclone and service restart steps — compared to the 8+ hours of a traditional full RMAN restore refresh.

---

## EBS 12.2.11 and CDB/PDB Architecture

Oracle's support position for EBS with CDB/PDB is documented in MOS Note 2655882.1. Key points:

- EBS 12.2 is supported on Oracle 19c CDB/PDB
- The EBS application connects to the PDB using a PDB service name — the application does not know or care whether it is connecting to a CDB or non-CDB
- EBS does not use the CDB root container — the entire EBS schema set (APPS, APPLSYS, SYSTEM, product schemas) lives inside the PDB
- Oracle-managed features such as Edition-Based Redefinition (used by EBS online patching) work identically inside a PDB
- The EBS context file and AutoConfig do not require changes to support a PDB target — the connection string references the PDB service name, which AutoConfig treats the same as a non-CDB service name

### Non-CDB vs PDB Connection String

| Environment | tnsnames SERVICE_NAME | EBS context file s_db_name |
|-------------|----------------------|---------------------------|
| Production (non-CDB) | \`VIS\` | \`VIS\` |
| Test clone (PDB) | \`VIS_TEST\` (PDB service) | \`VIS_TEST\` |

The PDB service name is registered with the CDB listener automatically when the PDB is opened. AutoConfig on the test application tier uses \`VIS_TEST\` as its database connection target — the CDB layer is transparent.

---

## Clone Architecture: Non-CDB to PDB

The most common EBS cloning scenario has a non-CDB production database as the source and a PDB inside a target CDB as the destination. This path uses RMAN active duplication with the \`AS PLUGGABLE DATABASE\` clause, followed by the mandatory \`noncdb_to_pdb.sql\` conversion script.

\`\`\`
Production server:                    Clone server:
┌─────────────────────┐               ┌──────────────────────────────┐
│  Oracle 19c         │    RMAN       │  Oracle 19c CDB (CDBTEST)    │
│  Non-CDB: VIS       │ ──────────→  │  ├── PDB: VIS_TEST           │
│  EBS 12.2.11        │  Active Dup  │  └── (future PDB refreshes)  │
│  prod-db            │               │  clone-db                    │
└─────────────────────┘               └──────────────────────────────┘
       │                                          │
       │  adpreclone.pl                           │  adcfgclone.pl
       │  + tar/rsync                             │  (DB tier + App tier)
       ↓                                          ↓
┌─────────────────────┐               ┌──────────────────────────────┐
│  App Tier           │               │  Clone App Tier              │
│  prod-app           │               │  clone-app                   │
│  fs1/fs2/fs_ne      │               │  fs1/fs2/fs_ne               │
└─────────────────────┘               └──────────────────────────────┘
\`\`\`

### The noncdb_to_pdb.sql Requirement

When RMAN duplicates a non-CDB database as a PDB, the resulting PDB contains non-CDB system metadata that is incompatible with CDB architecture — internal dictionary tables reference the non-CDB \`SYS\` structure rather than the CDB's common user \`SYS\`. Oracle provides \`noncdb_to_pdb.sql\` (\`\$ORACLE_HOME/rdbms/admin/noncdb_to_pdb.sql\`) to convert these internal references.

This script must run inside the new PDB — connected \`AS SYSDBA\` at the PDB level — before the PDB is opened for normal connections. It rewrites thousands of internal dictionary rows, remaps the PDB's system views to their CDB-aware equivalents, and enables features such as AWR and ASH within the PDB context. For a 2 TB EBS database, \`noncdb_to_pdb.sql\` typically takes 30–90 minutes.

Skipping this step leaves the PDB in an internally inconsistent state: it appears to open normally but produces ORA-65090 errors on DDL operations and cannot run adcfgclone successfully.

---

## The EBS Cloning Framework: adpreclone and adcfgclone

Oracle EBS provides two scripts that handle the EBS-specific aspects of cloning. These scripts work alongside RMAN — RMAN handles the database copy, while adpreclone and adcfgclone handle the EBS metadata and configuration layers.

### adpreclone.pl

\`adpreclone.pl\` runs on the **source** environment before cloning begins. It prepares the EBS instance for cloning by:

- Generating a \`perl/lib\` snapshot of all Perl modules needed by the clone tools
- Generating a template context file that contains the source environment's topology (for use as a starting point on the target)
- Cleaning up environment-specific runtime files (PID files, lock files, socket files) that should not be present in the clone
- Updating the database-side \`FND_OAM_CONTEXT_FILE\` entries and \`FND_APP_SERVERS\` table entries used by AutoConfig

adpreclone runs separately for the database tier and the application tier:

\`\`\`bash
# DB tier — run on source DB host as oracle
perl \${AD_TOP}/bin/adpreclone.pl dbTier

# App tier — run on source app host as applmgr
source /u01/oracle/VIS/EBSapps.env run
perl \${AD_TOP}/bin/adpreclone.pl appsTier
\`\`\`

### adcfgclone.pl

\`adcfgclone.pl\` runs on the **target** environment after the RMAN clone and noncdb_to_pdb.sql conversion complete. It configures the cloned environment by:

- Reading the target's context XML file (which you populate with target-specific values: new hostnames, new database SID/service, new ports)
- Running AutoConfig against the cloned EBS file system, rewriting all 900+ configuration files to reflect the target environment
- Registering the clone's application tier nodes in the cloned database
- Updating database-resident EBS configuration (FND_APP_SERVERS, FNDNAM, listener configuration stored in the DB)
- Creating the target's WebLogic domain from the cloned domain template

adcfgclone also runs separately for each tier, with the database tier step running first:

\`\`\`bash
# DB tier — run on clone DB host
perl \${ORACLE_HOME}/appsutil/bin/adcfgclone.pl dbTier

# App tier — run on clone app host
perl \${CLONE_TOP}/bin/adcfgclone.pl appsTier
\`\`\`

---

## Application Tier Cloning

The EBS application tier filesystem (fs1, fs2, fs_ne under the EBS base directory) is not cloned by RMAN — RMAN only handles the Oracle database files. The application tier is cloned separately via tar archive or rsync.

After \`adpreclone.pl appsTier\` runs on the source, the entire EBS application base directory is archived:

\`\`\`bash
# On source app host — after adpreclone.pl completes
cd /u01/oracle
tar -czf /backup/VIS_apptier_\$(date +%Y%m%d).tar.gz VIS/
\`\`\`

The archive is transferred to the clone app host and extracted, then \`adcfgclone.pl appsTier\` is run with a context file populated with the clone environment's values (clone app hostname, clone DB service name, clone ports).

---

## Post-Clone Configuration

A freshly cloned EBS environment inherits production configuration. Several items must be changed before the clone is usable:

### Passwords

The clone contains the production \`APPS\` schema password, \`SYS\` password, and \`SYSTEM\` password. These must be changed on the clone to prevent the clone from being used with production credentials — and to prevent a compromised clone from being used to access production.

\`\`\`sql
-- Change SYS password on clone DB (run on clone)
ALTER USER SYS IDENTIFIED BY <new_sys_password>;
ALTER USER SYSTEM IDENTIFIED BY <new_system_password>;
-- APPS password change requires the EBS FNDCPASS utility (not plain ALTER USER)
-- because EBS stores the APPS hash internally in FND_USER and APPLSYS
\`\`\`

### Disable Production-Pointing Integrations

Cloned EBS environments inherit all production integration configuration: Oracle Workflow Mailer SMTP settings (which will send real email to real users), external system interface URLs, Oracle Payments gateway configuration, and any custom integration profile options. Each must be disabled or re-pointed to test analogs.

### Disable Scheduled Programs That Run Automatically

In a cloned environment, Concurrent Programs that run automatically — purge jobs, GL auto-post programs, interface programs that push data to external systems — must be disabled or their schedules deleted before the clone is made available to users.

### Environment Identification

As with DR environments, a clone must be visually distinct from production. The same three-layer approach applies: update \`FND_PRODUCT_GROUPS.APPLICATIONS_SYSTEM_NAME\` to reflect the clone name, set the \`HELP_UTIL_SERVLET_WELCOME_MESSAGE\` FND profile to a visible clone identifier, and change the OAF skin or global header color.

---

## Summary

PDB-based EBS cloning combines Oracle's RMAN active duplication capability with the EBS adpreclone/adcfgclone framework to produce a complete test environment without a production outage or a cold backup window. The source production database remains non-CDB; only the clone target is a PDB inside a CDB, which enables faster subsequent refresh cycles via \`CREATE PLUGGABLE DATABASE ... FROM\` and more efficient resource sharing when multiple test PDBs share one CDB. The mandatory \`noncdb_to_pdb.sql\` conversion step after RMAN duplication is non-negotiable — the PDB cannot run adcfgclone successfully without it, and the conversion takes 30–90 minutes for a typical EBS database. The application tier is cloned separately via tar and adcfgclone, with adpreclone on the source and adcfgclone on the target handling all EBS-specific metadata. Post-clone hardening — password changes, integration disabling, scheduled program review, and environment identification — is as important as the technical clone steps. The companion runbook provides the complete command sequence for each phase, including RMAN active duplication syntax, noncdb_to_pdb.sql execution, adpreclone and adcfgclone invocations for both tiers, post-clone SQL for password and configuration changes, and monitoring scripts for clone age tracking.`,
};

async function main() {
  console.log('Inserting EBS PDB clone blog post...');
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
