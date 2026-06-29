import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS 12.2.11 Online Patching with adop: Architecture and Lifecycle',
  slug: 'oracle-ebs-12211-adop-online-patching',
  excerpt:
    'A deep-dive into Oracle EBS 12.2 online patching using adop: the dual-filesystem architecture (fs1/fs2/fs_ne), Edition-Based Redefinition at the database layer, the five adop phases (prepare, apply, finalize, cutover, cleanup), the difference between online and hotpatch mode, why cutover is the only true outage window, and the common failure patterns that interrupt a patching cycle — with guidance on resume versus abort decisions.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-29'),
  youtubeUrl: null,
  content: `## Introduction

Oracle E-Business Suite 12.2 introduced a fundamentally different patching architecture from every prior EBS release. In EBS 11i and 12.1, applying a patch required a complete application downtime — all users were locked out, the application filesystem was modified in place, and database objects were rebuilt before the system could be restarted. For large EBS instances, this meant weekend maintenance windows measured in hours.

EBS 12.2 replaced this model with **online patching**, delivered through the **AD Online Patching** utility, known as **adop**. Under the online patching model, patches are applied to a parallel copy of the application filesystem and database objects while the live system continues to run and users continue to work. The switch from the old environment to the patched environment — called cutover — requires only a brief restart, typically under 15 minutes for a straightforward patch cycle.

This article explains how the architecture makes this possible, what each phase of the adop cycle does, and where the common failure points are.

---

## The Dual-Filesystem Architecture

The foundation of online patching is a dual-filesystem design. On every EBS 12.2 application server, two complete copies of the application filesystem exist side by side:

- **fs1** — one of the two alternating application filesystems
- **fs2** — the other alternating application filesystem
- **fs_ne** — a non-editioned filesystem shared between both, containing configuration files, concurrent manager logs, and other content that does not change during patching

At any given time, one filesystem is designated the **RUN** filesystem — the live environment serving users. The other is the **PATCH** filesystem — the target for the current patch application. After a successful cutover, the roles swap: the former PATCH filesystem becomes the new RUN filesystem, and the former RUN filesystem becomes the new PATCH filesystem, ready for the next patch cycle.

\`\`\`
Before cutover:
  fs1 = RUN  (serving users)
  fs2 = PATCH (receiving patch)
  fs_ne = shared config, logs

After cutover:
  fs2 = RUN  (now serving users — patched)
  fs1 = PATCH (ready for next cycle)
  fs_ne = shared config, logs
\`\`\`

The EBS context file tracks which filesystem is currently RUN versus PATCH. The \`adop\` utility reads this mapping at the start of every phase and directs all file operations to the correct target.

---

## Edition-Based Redefinition at the Database Layer

The dual-filesystem handles the application tier, but the database tier requires a different mechanism. Database objects — PL/SQL packages, views, synonyms — cannot simply be duplicated into two filesystem directories. Oracle Database solves this through **Edition-Based Redefinition (EBR)**, a feature introduced in Oracle Database 11g Release 2 and used extensively in EBS 12.2.

EBR allows multiple versions of editionable database objects (PL/SQL packages, package bodies, functions, procedures, triggers, views, synonyms) to coexist in the database simultaneously, each assigned to a named **edition**. Users connected to the RUN edition see the pre-patch version of every object. The adop patching process creates and populates a new PATCH edition without affecting the objects visible to RUN-edition sessions.

At cutover, the database switches the default edition from RUN to PATCH. New sessions connect to the patched edition. Existing long-running sessions remain on the old edition until they disconnect.

\`\`\`
Database editions during patching:
  ORA\$BASE → root
    EBS_RUNTIME_EDITION_R12 (current RUN — visible to users)
    EBS_PATCH_EDITION_R12   (PATCH edition — adop writes here)

At cutover:
  EBS_PATCH_EDITION_R12 becomes the new default edition (RUN)
  EBS_RUNTIME_EDITION_R12 is retained until cleanup
\`\`\`

This is why users can continue working during the apply and finalize phases — they are entirely isolated from the patched database objects until the moment of cutover.

---

## The Five adop Phases

A complete adop patch cycle consists of five sequential phases. Each phase is invoked as a separate \`adop\` command; a cycle can be paused between phases and resumed later.

### Phase 1: Prepare

The prepare phase initializes the patch cycle. It:

- Identifies the current RUN and PATCH filesystems
- Synchronizes the PATCH filesystem with the RUN filesystem (a full copy of \$APPL_TOP, \$OA_HTML, \$COMMON_TOP, etc., or an rsync-based differential update for subsequent patches)
- Creates a new database patch edition derived from the current run edition
- Runs prerequisite checks: disk space, database connectivity, filesystem permissions, adop worker availability
- Records the cycle start in the adop control tables

The prepare phase is the longest phase in a first-cycle synchronization, because it copies the full application filesystem to the patch side. Subsequent cycles use incremental synchronization and run much faster. Users are unaffected during prepare.

### Phase 2: Apply

The apply phase installs the patch onto the PATCH filesystem and the PATCH database edition. It:

- Reads the patch driver file (\`u\${PATCH_NUMBER}.drv\` or \`unified_driver\`)
- Applies file copies to the PATCH filesystem (\$APPL_TOP, \$OA_HTML, \$FND_TOP, etc.)
- Compiles INVALID database objects in the PATCH edition
- Creates or replaces PL/SQL packages, views, triggers, and synonyms in the PATCH edition
- Runs patch driver actions: seed data loads, profile option inserts, menu updates
- Runs AutoConfig on the PATCH filesystem (if \`apply_mode=online\`)

Workers run in parallel (controlled by \`-workers\` parameter). The number of workers scales the apply phase speed. Users remain on the RUN filesystem and RUN edition throughout apply. Apply can be paused (\`adop phase=apply status=pause\`) and resumed.

### Phase 3: Finalize

The finalize phase prepares for cutover. It:

- Generates the JSP and OAF page cache on the PATCH filesystem so users do not experience cold-cache load after cutover
- Compiles any remaining INVALID objects in the PATCH edition
- Verifies the patch edition is consistent and all objects are valid
- Runs final checks to confirm cutover readiness

Finalize can be run while users are active. It is typically the phase where the DBA verifies the patch edition has no compilation errors before committing to cutover.

### Phase 4: Cutover

Cutover is the only phase that requires user downtime. It:

- Quiesces the application: prevents new logins (ICM puts itself in emergency mode, WebLogic sessions drain)
- Bounces the application tier services, restarting them against the PATCH filesystem
- Switches the database default edition from the RUN edition to the PATCH edition
- Updates the EBS context file to reflect the new RUN/PATCH filesystem assignments
- Runs AutoConfig on the new RUN filesystem
- Restarts all EBS services against the patched environment

For a typical maintenance patch, cutover takes 10–20 minutes depending on the number of application tiers and the complexity of the AutoConfig run. Larger environments with many managed servers take longer.

### Phase 5: Cleanup

Cleanup runs after the environment has been validated in production and there is no intention to roll back. It:

- Drops the old (pre-patch) database edition and all objects that existed only in that edition
- Removes the old RUN filesystem snapshot or marks it as ready for the next prepare cycle
- Archives adop log files
- Resets the adop cycle state to allow the next patch cycle to begin

Cleanup is deferred by design — it is not run immediately after cutover. This gives the team time to validate the patched system under real production load before permanently destroying the rollback path. Cleanup should be run before beginning the next prepare phase, because prepare will fail if a prior cycle has not been cleaned up.

---

## Online Mode vs. Hotpatch Mode

adop supports two apply modes:

**Online mode** (default) applies the patch across all five phases as described above. The patch is applied to the PATCH edition/filesystem and delivered to users at cutover. This is the standard mode for all patches that modify database objects.

**Hotpatch mode** (\`apply_mode=hotpatch\`) applies a patch directly to the RUN filesystem and RUN edition, bypassing the dual-filesystem mechanism entirely. Hotpatch requires application downtime (the same as EBS 12.1 patching). It is reserved for patches that cannot be applied online — typically patches that modify non-editioned database objects such as tables, sequences, or synonyms that cannot be redefined under EBR, or patches to the adop infrastructure itself. Oracle explicitly identifies these patches in the patch readme with the directive: **"This patch must be applied using hotpatch mode."**

Never apply a standard patch in hotpatch mode to save time — hotpatch skips the edition isolation that prevents users from seeing partially applied changes.

---

## Patch Types and Merging

EBS patches fall into several categories:

**Individual patches**: A single fix for a specific bug, identified by a patch number (e.g., patch 12345678). Contains a platform-specific zip (\`p12345678_122110_LINUX.zip\`) with a driver file, object code, and seed data.

**Merged patches**: Multiple individual patches combined into a single driver by the DBA using the **AD Merge Patch** utility (\`admrgpch\`). Merging reduces apply time and the number of adop cycles because one cycle delivers multiple fixes. All patches in a merge must be for the same EBS release and platform.

**Release Update Packs (RUPs)**: Oracle-released bundles of all patches for a given EBS release up to a specific date. RUPs are the recommended way to keep EBS current and typically contain hundreds of individual fixes.

**Prerequisites**: Many patches have prerequisites — other patches that must be applied first. The patch readme lists prerequisites explicitly. The \`adop phase=apply\` command checks prerequisites against the applied patch registry (\`AD_BUGS\`) and fails if prerequisites are missing.

---

## Common Failure Patterns and Resume vs. Abort

adop failures during the apply phase are common and expected. They do not always require aborting the cycle.

**Worker failures**: An adop worker fails on a specific job (e.g., compiling an invalid object, running a seed data SQL script). The cycle pauses with status \`FAILED\`. The DBA investigates the worker log (\`adwork\${N}.log\`), fixes the underlying condition (recompile the object manually, correct a data issue), and resumes the cycle with \`adop phase=apply status=resume\`. The worker restarts from the failed job.

**Filesystem full during apply**: The PATCH filesystem fills during the file copy phase. adop stops. The DBA frees space, then resumes. adop continues from where it stopped.

**Network interruption during apply**: The adop session disconnects. The adop worker processes continue running on the server (they are not tied to the adop session). The DBA reconnects and runs \`adop phase=apply status=resume\` to reattach to the running cycle.

**Abort conditions**: An abort is warranted when the patch itself is wrong (wrong platform zip, wrong EBS release), when a prerequisite was missed and cannot be applied mid-cycle, or when a corruption is discovered in the patch edition that cannot be fixed without starting fresh. Abort with \`adop phase=abort\` — this drops the patch edition and resets the filesystem to the pre-prepare state. Cleanup is not required after abort.

---

## Rollback

The adop architecture provides an implicit rollback path until cleanup is run. If a defect is discovered after cutover:

1. Stop all EBS services
2. Restore the previous edition as the database default (\`ALTER DATABASE DEFAULT EDITION\`)
3. Restart services against the old filesystem (the former PATCH filesystem, now the old RUN)
4. Run AutoConfig against the restored environment

This is rarely done in practice because it is manual and risky, but it is architecturally possible. Most teams prefer to apply a corrective patch via a new adop cycle rather than rolling back. The cleanup phase permanently destroys this path, which is why cleanup should not be run immediately after cutover.

---

## Monitoring Patch Progress

adop writes detailed logs to \$NE_BASE/EBSapps/log/adop/ organized by session ID. The key log files are:

- **adoplog.log**: Top-level adop session log showing phase transitions, worker starts, and phase completion
- **adwork\${N}.log**: Individual worker logs showing each job attempted, the SQL or shell command run, and the error if it failed
- **adpatch.log**: Generated during apply for patches that invoke the underlying adpatch utility

Real-time progress can be monitored by querying the adop control tables in the database, which the companion runbook covers in detail.

---

## Summary

adop online patching is the defining operational capability of EBS 12.2. The dual-filesystem design (fs1/fs2/fs_ne) and Edition-Based Redefinition at the database layer allow patches to be applied without interrupting users. The five-phase cycle — prepare, apply, finalize, cutover, cleanup — maps directly to the stages of risk: prepare and apply are low-risk and reversible; cutover is the brief, controlled outage; cleanup is the permanent commit.

Understanding the architecture prevents the most common operational mistakes: applying standard patches in hotpatch mode, running cleanup before validating the patched system, attempting to roll back without understanding the edition structure, and not merging patches to reduce cycle count. The companion runbook provides the exact command sequence for each phase, the log monitoring queries, and the scripts for automated cycle health checking.`,
};

async function main() {
  console.log('Inserting EBS adop online patching blog post...');
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
