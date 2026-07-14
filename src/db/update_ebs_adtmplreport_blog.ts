import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';
import { eq } from 'drizzle-orm';

const slug = 'ebs-adtmplreport-sh-overview-db-app-tier';

const content = `
Every Oracle EBS environment accumulates patches, one-off fixes, and emergency rollups over its lifetime. After a patching cycle — especially after a large CPU or family pack — the question that comes up repeatedly is: are all the template files on this tier consistent with what the patch history says should be here? \`adtmplreport.sh\` is the AD utility that answers that question cleanly and completely, for both the application tier and the database tier.

The tool has been present across all major EBS releases — 11i, R12.1, and R12.2 — but its operating context changes meaningfully between versions. In 11i and 12.1.3, the invocation is straightforward: source the environment, run the script, check the output. In 12.2.x, Oracle's Online Patching architecture introduces a dual file system with run and patch editions, which changes when to run the report and against which edition to run it.

This post covers what \`adtmplreport.sh\` does, how to run it on both tiers across all three EBS release families, and how to interpret what it produces.

---

## What Is adtmplreport.sh?

\`adtmplreport.sh\` is a shell script in \`\$AD_TOP/bin/\` that generates a report of the Oracle Applications template files registered in the AD schema. It reads patch driver metadata stored in the Applications DBA tables — primarily \`AD_FILES\`, \`AD_FILE_VERSIONS\`, and \`AD_PATCH_DRIVERS\` — and compares the registered file versions against the currently applied patch history.

The term "template" in this context refers to the driver file templates that Oracle Applications patches use to describe which files get installed, on which tier, at which version. Every patch run processes one or more driver files. \`adtmplreport.sh\` reports on the state of those templates and the files they govern.

### What it is not

\`adtmplreport.sh\` is distinct from:

- **adident** — reports the version header (\`\$Header\` tag) of a single file on disk. \`adtmplreport.sh\` reads the full AD schema and reports across all registered files.
- **adsplice** — adds new products to an EBS installation. No overlap with template reporting.
- **adpatch / adop log analysis** — \`adtmplreport.sh\` reads the persistent AD schema state, not transient log files from a specific patch run.

### Driver file types

Oracle EBS patch drivers are classified by the tier they target:

| Driver prefix | Target | Content |
|---------------|--------|---------|
| \`c\` | Application tier | Forms, reports, libraries, Java, C programs |
| \`d\` | Database tier | SQL, PL/SQL, views, packages, triggers |
| \`g\` | Generic (both tiers) | Seed data, setup files, shared resources |

\`adtmplreport.sh\` reports on all driver types, filtered by tier when run on the appropriate node.

---

## Version-Specific Context

### EBS 11i (11.5.10.x)

In EBS 11i, patching is handled exclusively by \`adpatch\`. There is a single file system per application tier node — no edition concept. The AD schema tables (\`AD_FILES\`, \`AD_FILE_VERSIONS\`, \`AD_APPLIED_PATCHES\`) hold the authoritative record of what has been installed.

The 11i environment is sourced from the \`appsutil\` directory:

\`\`\`bash
# Database node
source /u01/oracle/EBSPRD/appsutil/env/EBSPRD_\$(hostname -s).env

# Application node
source /u01/applmgr/EBSPRD/appsutil/env/EBSPRD_\$(hostname -s).env
\`\`\`

Key 11i variables consumed by \`adtmplreport.sh\`:

| Variable | 11i typical value |
|----------|------------------|
| \`APPL_TOP\` | \`/u01/applmgr/EBSPRD/apps/apps_st/appl\` |
| \`AD_TOP\` | \`\$APPL_TOP/ad/11.5.0\` |
| \`TWO_TASK\` | Net service name for the EBS database |
| \`ORACLE_HOME\` | Database Oracle Home used for sqlplus |

In multi-node 11i clusters, each application node has its own \`APPL_TOP\` on local disk (or a node-specific NFS mount). Running \`adtmplreport.sh\` on each node independently and diffing the outputs is the standard way to confirm all nodes received the same patch.

### EBS R12.1.3

R12.1.3 retains the single-file-system model and \`adpatch\`-based patching. The primary differences from 11i are the directory layout and the increased role of Java/OA Framework in the application stack.

\`\`\`bash
# Application node
source /u01/applmgr/EBSPRD/EBSprd/EBSprd_\$(hostname -s).env
\`\`\`

Key R12.1 variables:

| Variable | R12.1 typical value |
|----------|---------------------|
| \`APPL_TOP\` | \`/u01/applmgr/EBSPRD/apps/apps_st/appl\` |
| \`AD_TOP\` | \`\$APPL_TOP/ad/12.0.0\` |
| \`JAVA_TOP\` | \`/u01/applmgr/EBSPRD/apps/apps_st/comn/java\` |
| \`TWO_TASK\` | Net service name |

\`adtmplreport.sh\` behavior is essentially identical to 11i. The same arguments work. The output format is the same. The only meaningful difference is the expanded file set: R12 introduced significantly more Java class registrations and OA Framework page metadata that appear in the report.

### EBS R12.2.x — Online Patching and the Dual File System

R12.2 introduces the most significant change in how \`adtmplreport.sh\` fits into the patching workflow. Oracle's AD Online Patching (\`adop\`) framework maintains two parallel copies of the application file system — the **run edition** (what users are currently accessing) and the **patch edition** (where the patch is being applied). After the patch cycle completes and \`adop phase=cutover\` promotes the patch edition, the editions swap roles.

This means there are now two file systems to consider:

| Edition | Description | Active during |
|---------|-------------|---------------|
| Run edition | Serves current user traffic | Normal operations and during patching |
| Patch edition | Receives patch files | \`adop phase=apply\` |

#### Sourcing the R12.2 environment

Unlike 11i and 12.1, the R12.2 environment script takes an explicit edition argument:

\`\`\`bash
# Source the run edition (for post-cutover validation)
source /u01/applmgr/EBSPRD/EBSapps.env run

# Source the patch edition (to inspect what was applied before cutover)
source /u01/applmgr/EBSPRD/EBSapps.env patch
\`\`\`

When you source the run edition, \`\$APPL_TOP\` points to the run edition file system. When you source the patch edition, \`\$APPL_TOP\` points to the patch edition file system.

Key R12.2 variables:

| Variable | R12.2 typical value |
|----------|---------------------|
| \`APPL_TOP\` | Edition-specific path under \`/u01/applmgr/EBSPRD/fs1/EBSapps/appl\` or \`fs2\` |
| \`AD_TOP\` | \`\$APPL_TOP/ad/12.0.0\` |
| \`JAVA_TOP\` | \`/u01/applmgr/EBSPRD/fs1/EBSapps/comn/java\` |
| \`APPL_TOP_PATCH\` | The patch edition path (populated after sourcing \`run\`) |
| \`TWO_TASK\` | Net service name |

#### When to run adtmplreport.sh in R12.2

In 11i and 12.1, the right time to run the report is straightforward: after \`adpatch\` completes. In 12.2, the patching cycle has four major phases:

\`\`\`
adop phase=prepare   → initializes patch edition
adop phase=apply     → applies patch files to patch edition
adop phase=finalize  → compiles, generates, seeds data
adop phase=cutover   → promotes patch edition to run edition
adop phase=cleanup   → removes old run edition
\`\`\`

| When to run | Which edition to source | Purpose |
|-------------|------------------------|---------|
| After \`phase=apply\` | \`patch\` | Verify patch files landed correctly in patch edition before cutover |
| After \`phase=cutover\` | \`run\` | Validate the promoted edition is complete before releasing users |
| After \`phase=cleanup\` | \`run\` | Final baseline capture — the old edition is gone |

Running the report against the patch edition before cutover allows you to catch missing files or version mismatches before the edition becomes live. Running it after cutover against the run edition is the definitive post-patch validation.

---

## Prerequisites

### Disk space

The report can be several megabytes in large environments with extensive patch histories:

\`\`\`bash
mkdir -p /tmp/adtmpl_reports
df -h /tmp/adtmpl_reports   # confirm at least 500 MB free
\`\`\`

### Database connectivity

\`adtmplreport.sh\` connects as the APPS schema to read AD metadata tables. Verify connectivity before running:

\`\`\`bash
echo "SELECT 'OK' FROM dual;" | \\
  \${ORACLE_HOME}/bin/sqlplus -s apps/<apps_password>@\${TWO_TASK}
\`\`\`

Expected output: \`OK\`. Any ORA- error requires investigation before proceeding.

---

## Running on the Application Tier

The application tier run reports on \`c\` (copy) and \`g\` (generic) driver files — the files that live in \`\$APPL_TOP\`, \`\$AU_TOP\`, \`\$JAVA_TOP\`, and the product \`*_TOP\` directories.

### EBS 11i — Application Tier

\`\`\`bash
source /u01/applmgr/EBSPRD/appsutil/env/EBSPRD_\$(hostname -s).env

cd \${AD_TOP}/bin

adtmplreport.sh \\
  apps=<apps_password> \\
  report_file=/tmp/adtmpl_reports/apptier_11i_\$(date +%Y%m%d).txt
\`\`\`

### EBS R12.1.3 — Application Tier

\`\`\`bash
source /u01/applmgr/EBSPRD/EBSprd/EBSprd_\$(hostname -s).env

cd \${AD_TOP}/bin

adtmplreport.sh \\
  apps=<apps_password> \\
  report_file=/tmp/adtmpl_reports/apptier_r1213_\$(date +%Y%m%d).txt
\`\`\`

### EBS R12.2.x — Application Tier (post-cutover validation)

\`\`\`bash
# Source the run edition — this is the file system now serving users
source /u01/applmgr/EBSPRD/EBSapps.env run

cd \${AD_TOP}/bin

adtmplreport.sh \\
  apps=<apps_password> \\
  report_file=/tmp/adtmpl_reports/apptier_r122_run_\$(date +%Y%m%d).txt
\`\`\`

To inspect the patch edition before cutover:

\`\`\`bash
# Source the patch edition — inspect what was applied but not yet promoted
source /u01/applmgr/EBSPRD/EBSapps.env patch

cd \${AD_TOP}/bin

adtmplreport.sh \\
  apps=<apps_password> \\
  report_file=/tmp/adtmpl_reports/apptier_r122_patch_\$(date +%Y%m%d).txt
\`\`\`

### Filtering by product (all versions)

\`\`\`bash
adtmplreport.sh \\
  apps=<apps_password> \\
  product=AR \\
  report_file=/tmp/adtmpl_reports/apptier_AR_\$(date +%Y%m%d).txt
\`\`\`

Replace \`AR\` with any EBS product short name: \`GL\`, \`AP\`, \`PO\`, \`INV\`, \`FND\`, etc.

### What the application tier report covers

- **Forms and report template versions** — \`.fmb\`, \`.rdf\`, \`.pll\`, \`.lct\` files and their registered versions
- **Java class and jar versions** — \`.class\` and \`.jar\` files registered in the AD schema
- **C programs and library versions** — executables in \`\$FND_TOP/bin\` and product bin directories
- **Seed data and loader files** — \`.ldt\` files and their registered patch level
- **Version discrepancies** — files where the on-disk version stamp differs from \`AD_FILE_VERSIONS\`

---

## Running on the Database Tier

The database tier run reports on \`d\` (database) driver files — PL/SQL objects, views, triggers, and DDL changes registered in the AD schema.

### EBS 11i — Database Tier

\`\`\`bash
source /u01/oracle/EBSPRD/appsutil/env/EBSPRD_\$(hostname -s).env

cd \${AD_TOP}/bin

adtmplreport.sh \\
  apps=<apps_password> \\
  tier=db \\
  report_file=/tmp/adtmpl_reports/dbtier_11i_\$(date +%Y%m%d).txt
\`\`\`

### EBS R12.1.3 — Database Tier

\`\`\`bash
source /u01/oracle/EBSPRD/appsutil/env/EBSPRD_\$(hostname -s).env

cd \${AD_TOP}/bin

adtmplreport.sh \\
  apps=<apps_password> \\
  tier=db \\
  report_file=/tmp/adtmpl_reports/dbtier_r1213_\$(date +%Y%m%d).txt
\`\`\`

### EBS R12.2.x — Database Tier

In R12.2, database objects are not edition-specific in the file system sense — the database schema itself is shared. Run the database tier report from the application server after sourcing the run edition:

\`\`\`bash
source /u01/applmgr/EBSPRD/EBSapps.env run

cd \${AD_TOP}/bin

adtmplreport.sh \\
  apps=<apps_password> \\
  tier=db \\
  report_file=/tmp/adtmpl_reports/dbtier_r122_\$(date +%Y%m%d).txt
\`\`\`

In R12.2, the database tier report is particularly relevant after \`adop phase=finalize\`, which is where PL/SQL compilation and view generation occur. If finalize completes with errors, the database tier report will show which objects have version mismatches, and the invalid object query below will identify what failed to compile.

### Correlating with invalid database objects (all versions)

\`\`\`sql
SELECT object_name,
       object_type,
       status,
       TO_CHAR(last_ddl_time, 'YYYY-MM-DD HH24:MI') AS last_ddl
FROM   dba_objects
WHERE  owner  = 'APPS'
  AND  status = 'INVALID'
ORDER BY object_type, object_name;
\`\`\`

Objects appearing in both the adtmplreport.sh Section 2 output (version mismatch) and the invalid objects list were patched but failed to compile. The patch registered the new version in the AD schema, but the actual compilation step produced an error.

### Multi-node comparison (11i and R12.1.3)

In multi-node 11i and 12.1 environments, all application nodes must carry identical file versions:

\`\`\`bash
# Run on each node, save to shared location
SHARED=/nfs/ebs_reports

# appnode01
adtmplreport.sh apps=<password> report_file=\${SHARED}/node01_\$(date +%Y%m%d).txt

# appnode02
adtmplreport.sh apps=<password> report_file=\${SHARED}/node02_\$(date +%Y%m%d).txt

# Compare — exclude timestamp header lines
diff \\
  <(grep -v "^Date:\|^Requested" \${SHARED}/node01_\$(date +%Y%m%d).txt) \\
  <(grep -v "^Date:\|^Requested" \${SHARED}/node02_\$(date +%Y%m%d).txt)
\`\`\`

Zero diff output means the nodes are at the same file level.

### Multi-node comparison in R12.2

R12.2 uses a shared application file system — both nodes mount the same \`fs1\` and \`fs2\` NFS paths. A per-node diff is usually not necessary because there is only one copy of each file system. However, if your R12.2 environment uses node-local copies of any component, run the report on each node against the run edition and diff as above.

---

## Interpreting the Output

The report structure is consistent across 11i, 12.1.3, and 12.2.

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

### Section 1: Files in AD not found on disk

Files that the AD schema records as installed but that cannot be located at the expected path. Possible causes across all versions:

- **11i / R12.1.3:** Patch applied on one node but not propagated to all nodes; file system mount not available; \`adpatch\` worker failed after the AD registration step but before the file copy
- **R12.2:** Report run against the wrong edition — if sourcing \`run\` but the patch was only applied to \`patch\` edition, files will appear missing; or the patch edition was not fully applied before this report

**Resolution:** Re-apply the patch on the node or edition with missing files. In R12.2, confirm the correct edition is sourced before re-running.

### Section 2: Version mismatch (on disk vs. AD)

The on-disk \`\$Header\` version stamp differs from what \`AD_FILE_VERSIONS\` records. Common causes:

- A manual file replacement that bypassed \`adpatch\` or \`adop\`
- A hotfix applied directly to the file system without AD registration
- In R12.2: report run mid-cycle against the run edition while the patch edition has a newer version (expected during an active patch cycle — re-run after cutover)

**Resolution:** Apply or re-apply the authoritative patch. Never manually edit \`\$Header\` tags.

### Section 3: Conflicting registrations

A file appears in multiple patch drivers with different version numbers and the current installed version is ambiguous. This typically happens when patches overlap in their file ownership or when patches are applied out of recommended sequence.

**Resolution:** Identify the authoritative patch for the file from Oracle Support; re-apply it to establish a definitive registration.

### Section 4: Summary counts

In a healthy environment after a complete patch cycle, Sections 1, 2, and 3 should have zero entries or only a small number of known exceptions carried over from historical one-off patches. Track the counts before and after patching events — an unexplained increase warrants investigation before the environment is released back to users.

---

## Common Use Cases by Version

### Pre-upgrade baseline (all versions)

Before any major patch event — CPU, RUP, EBS family pack, or an \`adop\` cycle — run \`adtmplreport.sh\` and save the output. If the upgrade introduces unexpected issues, the pre-patch report establishes a clean baseline and shows whether the environment was consistent going in.

### Post-\`adpatch\` verification (11i and R12.1.3)

After any significant \`adpatch\` run, use \`adtmplreport.sh\` to confirm all copy-driver and database-driver files are registered at the expected versions. This is faster than scanning the \`adpatch.log\` for individual file confirmations in large patches.

### adop cycle validation (R12.2)

Use \`adtmplreport.sh\` at two points in every \`adop\` cycle:

1. **After \`phase=apply\`** — source the patch edition and run the report. Any Section 1 or Section 2 entries at this stage indicate apply-phase failures. Fix them before running \`phase=finalize\`.
2. **After \`phase=cutover\`** — source the run edition and run the report. This is the definitive post-patch validation that the promoted edition is complete and consistent.

### Support SR evidence (all versions)

When opening an Oracle Support SR for a file-level bug or unexpected behavior after patching, the \`adtmplreport.sh\` output provides Support with the definitive statement of what version is registered in your environment for the files in question. It is more reliable than a manual \`adident\` run on a single file because it reflects the full AD schema state, not just a single file's header tag.

---

## Summary

\`adtmplreport.sh\` serves the same purpose across EBS 11i, R12.1.3, and R12.2.x: it reads the AD schema and reports where the registered patch history disagrees with what is actually installed. The invocation is identical across versions — source the environment, run the script with \`apps=\` and \`report_file=\`, optionally add \`tier=db\` for the database tier and \`product=\` to scope to a single module.

The meaningful difference is in R12.2, where the dual file system requires you to source the correct edition before running the report. Against the patch edition (after \`adop phase=apply\`) the report validates what was applied before you promote it. Against the run edition (after \`adop phase=cutover\`) the report confirms the promoted file system is complete. In 11i and 12.1.3, run it on each application node separately and diff the outputs to catch any node that missed a patch propagation.

In all three versions, the tool is most valuable as a bookend: run it before and after every significant patching event to establish a clean baseline and confirm a clean result.
`.trim();

async function main() {
  await db.update(posts)
    .set({
      title: 'adtmplreport.sh in Oracle EBS 11i, R12.1.3, and R12.2: What It Does and How to Run It on the Application and Database Tier',
      excerpt: 'adtmplreport.sh is the Oracle AD utility for reporting on template file versions registered in the AD schema — comparing what the patch history says is installed against what is actually on disk or compiled in the database. This post covers the tool across all three EBS release families: standard adpatch environments in 11i and R12.1.3, and the dual run/patch edition file system in R12.2 where the timing and edition selection matter as much as the command itself.',
      content,
    })
    .where(eq(posts.slug, slug));
  console.log('Updated:', slug);
}

main().catch(console.error);
