import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-adtmplreport-sh-overview-db-app-tier';

const content = `
Every Oracle EBS environment accumulates patches, one-off fixes, and emergency rollups over its lifetime. After a patching cycle — especially after a large CPU or family pack — the question that comes up repeatedly is: are all the template files on this tier consistent with what the patch history says should be here? \`adtmplreport.sh\` is the AD utility that answers that question cleanly and completely, for both the application tier and the database tier.

This post covers what \`adtmplreport.sh\` does, how it differs from other AD file-reporting tools, and how to run it correctly on each tier of an EBS environment.

---

## What Is adtmplreport.sh?

\`adtmplreport.sh\` is a shell script in \`\$AD_TOP/bin/\` that generates a report of the Oracle Applications template files registered in the AD schema. It reads patch driver metadata stored in the Applications DBA tables — primarily \`AD_FILES\`, \`AD_FILE_VERSIONS\`, and \`AD_PATCH_DRIVERS\` — and compares the registered file versions against the currently applied patch history.

The term "template" in this context refers to the driver file templates that Oracle Applications patches use to describe which files get installed, on which tier, at which version. Every \`adpatch\` run processes one or more driver files (\`u<patch>.drv\`, \`c<patch>.drv\`, \`d<patch>.drv\`, \`g<patch>.drv\`). The \`adtmplreport.sh\` tool reports on the state of these templates and the files they track.

### What it is not

\`adtmplreport.sh\` is distinct from:

- **adident** — reports the version header of a single file on disk. \`adident\` reads the \`$Header\` tag embedded in a source file. \`adtmplreport.sh\` reads the AD schema and compares registered versions.
- **adsplice** — adds new products to an EBS environment. No overlap.
- **adaimgr / AutoPatch log analysis** — \`adtmplreport.sh\` is not a patch log parser. It reads the persistent AD schema state, not transient log files.

### Driver file types

Oracle EBS patch drivers are classified by the tier they target:

| Driver prefix | Target | Content |
|---------------|--------|---------|
| \`c\` | Application tier | Forms, reports, libraries, Java, C programs |
| \`d\` | Database tier | SQL, PL/SQL, views, packages, triggers |
| \`g\` | Generic (both tiers) | Seed data, setup files, shared resources |

\`adtmplreport.sh\` can report on all driver types, filtered by tier when run on the appropriate node.

---

## Prerequisites

### Environment variables

Before running \`adtmplreport.sh\`, the EBS environment must be fully initialized. The script requires:

| Variable | Purpose |
|----------|---------|
| \`ORACLE_HOME\` | Database Oracle Home (for sqlplus) |
| \`TWO_TASK\` or \`ORACLE_SID\` | Database connection identifier |
| \`APPL_TOP\` | Root of the EBS application file system |
| \`AD_TOP\` | Applications DBA product home |
| \`APPS_JDBC_URL\` | JDBC URL for some invocations |

Source the EBS environment before running the script:

\`\`\`bash
# EBS 11i
source /u01/applmgr/EBSPRD/appsutil/env/EBSPRD_appnode01.env

# EBS R12
source /u01/applmgr/EBSPRD/EBSprd/EBSprd_appnode01.env
\`\`\`

### Apps password

\`adtmplreport.sh\` connects to the EBS database as the APPS schema to read the AD metadata tables. Have the APPS password available before running.

### Disk space for output

The report can be several megabytes in large environments with extensive patch histories. Direct output to a known location with adequate space:

\`\`\`bash
mkdir -p /tmp/adtmpl_reports
\`\`\`

---

## Running on the Application Tier

The application tier run reports on files registered under the \`c\` (copy) and \`g\` (generic) driver categories — the files that live in \`\$APPL_TOP\`, \`\$AU_TOP\`, \`\$JAVA_TOP\`, and the various product \`*_TOP\` directories.

### Basic invocation

\`\`\`bash
cd \$AD_TOP/bin

adtmplreport.sh \\
  apps=<apps_password> \\
  report_file=/tmp/adtmpl_reports/apptier_tmpl_\$(date +%Y%m%d).txt
\`\`\`

### With explicit database connection

When the environment's \`TWO_TASK\` is not set or you need to target a specific service:

\`\`\`bash
adtmplreport.sh \\
  apps=<apps_password> \\
  database=EBSPRD \\
  report_file=/tmp/adtmpl_reports/apptier_tmpl_\$(date +%Y%m%d).txt
\`\`\`

### Filtering by product

To scope the report to a specific EBS product (useful when investigating a known issue in a single module):

\`\`\`bash
adtmplreport.sh \\
  apps=<apps_password> \\
  product=AR \\
  report_file=/tmp/adtmpl_reports/apptier_AR_\$(date +%Y%m%d).txt
\`\`\`

### What the app tier report covers

The application tier report includes:

- **Forms and report template versions** — registered versions in \`AD_FILE_VERSIONS\` for \`.fmb\`, \`.rdf\`, \`.pll\`, \`.lct\` files
- **Java class and jar versions** — \`.class\` and \`.jar\` files registered under the AD schema
- **C programs and library versions** — executables and shared libraries in \`\$FND_TOP/bin\` and product bin directories
- **Seed data and loader files** — \`.ldt\` files and their registered patch level
- **Version discrepancies** — files where the version registered in AD differs from the version stamp on disk

### Key output sections on the app tier

\`\`\`
AD Template Report — Application Tier
======================================
Requested by: APPS
Date:         YYYY-MM-DD HH:MM:SS
Tier:         Application

SECTION 1: Files registered in AD_FILE_VERSIONS not found on disk
SECTION 2: Files on disk whose version does not match AD_FILE_VERSIONS
SECTION 3: Files registered in multiple patches with conflicting versions
SECTION 4: Summary counts by product
\`\`\`

Section 1 is the most critical: files that the AD schema records as installed but that are absent from the file system indicate an incomplete patch application or a file system problem on one of the application nodes.

---

## Running on the Database Tier

The database tier run reports on files registered under the \`d\` (database) driver category — the SQL and PL/SQL objects that live in the Oracle database rather than on the file system.

### Invocation from the database server

Source the EBS environment from the database node and run:

\`\`\`bash
source /u01/oracle/EBSPRD/appsutil/env/EBSPRD_<dbhostname>.env

cd \$AD_TOP/bin

adtmplreport.sh \\
  apps=<apps_password> \\
  tier=db \\
  report_file=/tmp/adtmpl_reports/dbtier_tmpl_\$(date +%Y%m%d).txt
\`\`\`

The \`tier=db\` parameter scopes the report to database-side driver templates. Without it, the script defaults to the tier it detects from the environment, which may be the application tier if the environment was sourced from an app node home.

### What the database tier report covers

The database tier report includes:

- **PL/SQL package and body versions** — registered versions for compiled objects in the APPS schema
- **View definitions** — \`CREATE OR REPLACE VIEW\` statements registered by database driver files
- **Trigger versions** — database trigger registrations
- **Sequence and table DDL registrations** — structural changes tracked by \`d\` driver files
- **Invalid object correlation** — packages and views that are registered as current but are currently invalid in \`USER_OBJECTS\`

### Correlating with invalid objects

The database tier report is most useful when combined with an invalid object check. A file registered as current in AD but invalid in the database indicates that the \`d\` driver completed the file registration step but the PL/SQL compilation failed silently:

\`\`\`sql
SELECT object_name,
       object_type,
       status,
       last_ddl_time
FROM   dba_objects
WHERE  owner  = 'APPS'
  AND  status = 'INVALID'
ORDER BY object_type, object_name;
\`\`\`

Cross-reference the invalid object names against Section 2 of the database tier \`adtmplreport.sh\` output (version mismatches). Objects appearing in both places were likely patched but failed to compile during the patch run.

### Running on both tiers for a full-environment view

In large EBS environments with multiple application nodes, run \`adtmplreport.sh\` on each node separately and compare the Section 1 outputs. Application nodes should have identical file versions — any discrepancy indicates that a patch was applied on some nodes but not all.

\`\`\`bash
# On appnode01
adtmplreport.sh apps=<password> report_file=/tmp/node01_tmpl_report.txt

# On appnode02
adtmplreport.sh apps=<password> report_file=/tmp/node02_tmpl_report.txt

# Diff the two reports (exclude timestamp header lines)
diff <(grep -v "^Date:" /tmp/node01_tmpl_report.txt) \\
     <(grep -v "^Date:" /tmp/node02_tmpl_report.txt)
\`\`\`

Any diff output outside the timestamp header indicates a genuine version difference between nodes.

---

## Interpreting the Output

### Section 1: Files in AD not found on disk (app tier)

This section lists files that \`AD_FILE_VERSIONS\` records as installed at a specific version, but that cannot be located at the expected path on the current node. Possible causes:

- Patch applied on one application node but not all nodes in a multi-node environment
- File system mount point not available at time of report
- File manually deleted or moved after patching
- \`adpatch\` ran but the file copy step was skipped due to a worker failure

**Resolution:** Re-run \`adpatch\` with the patch that last installed the missing file, using the \`restart\` option if the patch was partially applied.

### Section 2: Version mismatch (on disk vs. AD)

The on-disk file has a \`$Header\` version stamp that differs from the version recorded in \`AD_FILE_VERSIONS\`. Possible causes:

- A manual file replacement that bypassed \`adpatch\`
- A hotfix applied directly without updating the AD schema
- Correct AD version but the file was replaced by a different patch at the file system level without proper AD registration

**Resolution:** Apply or re-apply the correct patch to bring the registered and actual versions into alignment. Do not manually edit \`$Header\` tags to force a match.

### Section 3: Conflicting registrations

A file appears in multiple patch drivers with different version numbers and it is not clear which version the current state represents. This happens when patches overlap or when an older patch was applied after a newer one.

**Resolution:** Identify which patch is the authoritative source for the file (typically the most recently released patch containing that file) and re-apply it. Oracle Support can confirm the correct version for a specific patch level.

### Section 4: Summary counts

The summary section is useful for trending. In a healthy environment after a clean patch cycle, Sections 1, 2, and 3 should have zero entries or only a small number of known exceptions. An increase in counts after a patching event without a corresponding explanation warrants investigation before the environment is released back to users.

---

## Common Use Cases

### Pre-upgrade environment audit

Before applying a major EBS upgrade — CPU, RUP, or family pack — run \`adtmplreport.sh\` on all tiers and save the output. If the upgrade introduces unexpected issues, the pre-upgrade report establishes a baseline that shows whether the environment was clean going in.

### Post-patch verification

After any significant \`adpatch\` run, run \`adtmplreport.sh\` to confirm that the patch completed cleanly and all expected files are registered at the correct versions. This is faster than scanning \`adpatch.log\` for individual file copy confirmations in large patches.

### Multi-node consistency check

In a 3-node or larger EBS environment, \`adtmplreport.sh\` provides the cleanest way to confirm that all nodes are at the same file version level. The diff approach above catches any node that missed a patch propagation.

### Support SR evidence

When opening an Oracle Support SR for a file-level bug or unexpected behavior after patching, the \`adtmplreport.sh\` output provides Support with the definitive statement of what is registered at what version in your environment, which is more reliable than a manual \`adident\` run on a single file.

---

## Summary

\`adtmplreport.sh\` is the authoritative AD schema-based file version report for Oracle EBS environments. Unlike \`adident\`, which reads a single file's header on disk, \`adtmplreport.sh\` reads the full AD metadata schema and reports on the relationship between what the patch history says is installed and what is actually present. Run it on the application tier to verify forms, reports, Java, and executable files. Run it on the database tier — with \`tier=db\` — to verify PL/SQL packages, views, and triggers. In multi-node environments, run it on each node and diff the outputs to catch any node that missed a patch propagation step. The tool is most valuable as a bookend: run it before and after every significant patching event to establish a clean baseline and confirm a clean result.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'adtmplreport.sh in Oracle EBS: What It Does and How to Run It on the Application and Database Tier',
    slug,
    excerpt: 'adtmplreport.sh is the Oracle AD utility for reporting on template file versions registered in the AD schema — comparing what the patch history says is installed against what is actually on disk or compiled in the database. This post covers what the tool does, how it differs from adident and AutoPatch log analysis, how to run it correctly on the application tier and database tier, how to interpret each output section, and how to use it as a multi-node consistency check after patching.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
