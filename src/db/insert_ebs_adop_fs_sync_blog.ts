import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'ebs-adop-run-filesystem-sync-patch-edition';

const content = `
Oracle E-Business Suite 12.2 introduced Online Patching — the ability to apply patches while users remain on the system. The mechanism that makes this possible is a dual-filesystem architecture: at any moment, two complete copies of the application tier exist side by side. One is serving live traffic; the other is available for offline patching. When the patch is complete, the system switches between them in seconds.

Understanding how those two copies stay in sync — and what happens when they do not — is essential before running \`adop phase=apply\` on any EBS 12.2 system that receives ongoing configuration changes.

---

## The Two-Edition Filesystem Architecture

EBS 12.2 maintains two parallel application-tier filesystems, referred to as editions:

\`\`\`
/u01/oracle/EBS/
├── fs1/                          ← one edition
│   └── EBSapps/
│       ├── appl/                 ← APPL_TOP  (product code, forms, reports)
│       └── inst/                 ← INST_TOP  (configuration, logs, env files)
│
├── fs2/                          ← other edition
│   └── EBSapps/
│       ├── appl/
│       └── inst/
│
└── fs_ne/                        ← Non-Editioned: shared files, not edition-specific
    ├── EBSapps/log/
    └── EBSapps/appl/admin/
\`\`\`

At any time, one edition is the **RUN edition** (live, serving users) and the other is the **PATCH edition** (offline, available for patching). The active RUN edition is identified by \`EBSapps.env\`:

\`\`\`bash
# Show which filesystem is currently the RUN edition
cat /u01/oracle/EBS/EBSapps.env | grep -E 'fs_type|APPL_TOP' | head -4

# Source run environment
source /u01/oracle/EBS/EBSapps.env run
echo "RUN APPL_TOP: \$APPL_TOP"
\`\`\`

After each successful adop \`cutover\` phase, the editions swap roles: the patched PATCH edition becomes the new RUN edition, and the former RUN edition becomes the next PATCH edition.

---

## fs_clone: How the Patch Edition Is Populated

Before any patch file can be applied, the PATCH edition must be an exact copy of the RUN edition. This ensures that the patched system will be functionally identical to the live system except for the changes introduced by the patch.

The \`adop phase=prepare\` command performs this synchronisation using \`rsync\`:

\`\`\`
adop phase=prepare
     │
     └── fs_clone
           │
           └── rsync --checksum --delete \\
                     /u01/oracle/EBS/<run_fs>/EBSapps/ \\
                     /u01/oracle/EBS/<patch_fs>/EBSapps/
\`\`\`

This rsync copies every file from the RUN edition to the PATCH edition, checksums each file to detect changes, and removes files from the PATCH edition that no longer exist in the RUN edition. On a typical EBS system with a 20–60 GB \`APPL_TOP\`, this operation takes 20–90 minutes.

**The result after prepare completes:**

\`\`\`
fs1 (RUN)          fs2 (PATCH)
─────────          ───────────
  appl/    ──────►   appl/      ← identical content
  inst/    ──────►   inst/      ← identical content
\`\`\`

The two filesystems are in sync at the moment prepare finishes. The patch can now be applied safely to the PATCH edition while users continue working on the RUN edition.

---

## The Synchronisation Gap

The prepare/fs_clone step runs once at the start of an adop cycle. After it completes, the two editions begin diverging:

- The patch apply phase writes new and modified files into the PATCH edition
- Normal system operation continues writing into the RUN edition

This expected divergence is intentional — it is the point of the two-edition model. But a second, unintended class of divergence can occur when **changes are made directly to the RUN edition after prepare has run**.

\`\`\`
Timeline:

  adop phase=prepare      adop phase=apply        adop phase=cutover
  ──────────────────      ────────────────        ──────────────────
        │                       │                       │
  fs_clone runs          Patch writes to          Editions swap:
  RUN → PATCH            PATCH edition            PATCH becomes RUN
  (in sync)                                       (RUN changes LOST
                                                   if not re-synced)
        │
        ▼
  DANGER ZONE:
  Changes to RUN edition
  between prepare and cutover
  will NOT appear in the
  new RUN edition after cutover
\`\`\`

After cutover, the former PATCH edition (now serving traffic) does not contain any changes that were made to the RUN edition after prepare ran.

---

## What Types of Changes Are at Risk

### Custom scripts and executable files

Any shell script, executable, or utility copied directly to a directory under \`\$APPL_TOP\` or \`\$INST_TOP\` on the RUN edition after prepare will be absent from the new RUN edition after cutover.

\`\`\`bash
# Example: a DBA adds a monitoring script during an open adop cycle
cp /tmp/ebs_session_monitor.sh \$APPL_TOP/admin/scripts/

# This copy went to the RUN APPL_TOP only.
# After cutover, the PATCH edition becomes the new RUN edition.
# The script is gone.
\`\`\`

### Configuration file changes

EBS configuration files that live on the filesystem (not in the database) are particularly vulnerable:

| File | Location | Risk |
|---|---|---|
| \`default.env\` | \`\$INST_TOP/ora/10.1.2/forms/server/\` | FORMS_CATCHTERM, FORMS_TIMEOUT changes |
| \`appsweb.cfg\` | \`\$INST_TOP/ora/10.1.2/j2ee/\` | Web tier tuning parameters |
| \`sqlnet.ora\` / \`tnsnames.ora\` | \`\$TNS_ADMIN\` | Network configuration changes |
| Custom \`.env\` overrides | \`\$APPL_TOP/\*/\*/admin/\` | Product-level env customisations |
| Autoconfig context file | \`\$CONTEXT_FILE\` | Modifications not yet re-generated |

### Symbolic links

Symbolic links created on the RUN edition to point to shared resources (log directories, external file drop zones, custom library paths) will not exist in the PATCH edition and therefore will be absent from the new RUN edition after cutover.

### Java class files and custom libraries

Custom Java classes, JARs, or shared libraries deployed directly to RUN edition directories (rather than through the standard Oracle Applications Manager or adop workflow) will not be present after cutover.

### AUTOCONFIG-managed files (special case)

Files managed by AutoConfig — those generated from templates in \`\$FND_TOP/admin/template/\` — are regenerated during the adop finalize phase using the current context file. If the context file itself was changed on the RUN edition after prepare, and AutoConfig has not been re-run on the PATCH edition, the PATCH edition's configuration will differ from the RUN edition's.

---

## How to Detect Out-of-Sync Files

Before running \`adop phase=apply\` on any system where the prepare phase ran more than a few hours ago, compare the two editions:

\`\`\`bash
# Source run environment to get RUN and PATCH paths
source /u01/oracle/EBS/EBSapps.env run

# Identify which filesystem is RUN and which is PATCH
if [[ "\$APPL_TOP" == *"fs1"* ]]; then
  RUN_FS="/u01/oracle/EBS/fs1/EBSapps"
  PATCH_FS="/u01/oracle/EBS/fs2/EBSapps"
else
  RUN_FS="/u01/oracle/EBS/fs2/EBSapps"
  PATCH_FS="/u01/oracle/EBS/fs1/EBSapps"
fi

echo "RUN   filesystem: \$RUN_FS"
echo "PATCH filesystem: \$PATCH_FS"

# Dry-run rsync to show what would be copied — files in RUN but not in PATCH,
# or files where RUN is newer than PATCH
rsync --dry-run --checksum --delete --recursive \
  --out-format="%o %f %l bytes %t" \
  "\$RUN_FS/" "\$PATCH_FS/" 2>/dev/null | grep -v '/$' | head -40
\`\`\`

The output lists every file that differs between the two editions. Files marked \`send\` are in the RUN edition but absent or older in the PATCH edition. Files marked \`del.\` exist in the PATCH edition but have been removed from the RUN edition since prepare ran.

---

## Re-synchronising Before Apply

If files have been modified on the RUN edition after prepare, you have two options:

### Option A — Re-run fs_clone (recommended)

Running \`adop phase=fs_clone\` within an existing adop session re-runs the rsync and brings the PATCH edition back into sync with the current state of the RUN edition. This is safe because fs_clone only touches the PATCH edition, which is offline.

\`\`\`bash
# Source PATCH environment for adop commands
source /u01/oracle/EBS/EBSapps.env patch

# Re-run fs_clone within the current session
adop phase=fs_clone

# After fs_clone completes, proceed with apply
adop phase=apply patches=<patch_id>
\`\`\`

Re-running fs_clone resets the PATCH edition to an exact copy of the current RUN edition, including all changes made since the original prepare. The adop session ID is preserved — this is not a new session.

### Option B — Manual rsync of changed files only

If re-running a full fs_clone is impractical (large \`APPL_TOP\`, time constraints), you can manually copy only the known-changed files to the PATCH edition:

\`\`\`bash
source /u01/oracle/EBS/EBSapps.env run

RUN_FS="\$APPL_TOP"
PATCH_FS=\$(echo "\$APPL_TOP" | sed 's|/fs[12]/|/|; s|EBSapps/appl||')
# Adjust the sed expression to match your installation path

# Example: copy a specific changed file to its PATCH edition equivalent
SRC_FILE="\$INST_TOP/ora/10.1.2/forms/server/default.env"
DEST_FILE=\$(echo "\$SRC_FILE" | sed 's|/fs[12]/EBSapps/|/fs_PATCH/EBSapps/|')
# Replace fs_PATCH with the actual patch edition path (fs1 or fs2)

cp -p "\$SRC_FILE" "\$DEST_FILE"
echo "Copied: \$SRC_FILE → \$DEST_FILE"
\`\`\`

Manual synchronisation is appropriate for a small number of known files. For broad changes — multiple product directories, new scripts, config edits — re-running fs_clone is safer and less error-prone.

---

## Before Every adop Cycle: A Pre-Apply Checklist

The check below should be part of the standard process before running \`adop phase=apply\` on any system:

\`\`\`bash
#!/bin/bash
# Quick pre-apply sync check
source /u01/oracle/EBS/EBSapps.env run

if [[ "\$APPL_TOP" == *"fs1"* ]]; then
  RUN_FS="/u01/oracle/EBS/fs1/EBSapps"
  PATCH_FS="/u01/oracle/EBS/fs2/EBSapps"
else
  RUN_FS="/u01/oracle/EBS/fs2/EBSapps"
  PATCH_FS="/u01/oracle/EBS/fs1/EBSapps"
fi

# Count files that differ
DIFF_COUNT=\$(rsync --dry-run --checksum --delete --recursive "\$RUN_FS/" "\$PATCH_FS/" 2>/dev/null | grep -c '^send\\|^del\\.' || echo 0)

echo "Files out of sync between RUN and PATCH editions: \$DIFF_COUNT"

if [ "\$DIFF_COUNT" -gt 0 ]; then
  echo ""
  echo "Run 'adop phase=fs_clone' to re-synchronise before applying the patch."
fi
\`\`\`

Running this check takes under a minute and answers one question: has anything changed on the RUN edition since prepare ran? If yes, re-run fs_clone before apply. If no, proceed directly with apply.

---

## The Correct Workflow

The standard adop cycle for any system where the RUN edition receives ongoing changes:

\`\`\`
1. adop phase=prepare
   └── fs_clone: RUN → PATCH (full sync)

2. ← any changes to RUN edition during this window go here

3. Verify sync before apply:
   rsync --dry-run --checksum RUN → PATCH | count differences

4. If differences found:
   adop phase=fs_clone    (re-sync)

5. adop phase=apply patches=<id>
   └── writes patch files to PATCH edition only

6. adop phase=finalize
   └── re-runs AutoConfig on PATCH edition

7. adop phase=cutover
   └── PATCH becomes new RUN (atomic swap)

8. adop phase=cleanup
   └── removes stale files from old RUN edition (now PATCH)
\`\`\`

The re-sync check at step 3 adds one to five minutes to the patching process. Skipping it risks losing configuration and custom file changes at cutover — changes that were visible on the live system for days or weeks before the patch was applied.

---

## Summary

The EBS 12.2 Online Patching model uses two parallel filesystem editions and synchronises the PATCH edition from the RUN edition once, at the start of each adop cycle, during \`phase=prepare\`. Any modification to the RUN edition's filesystem after prepare — configuration file edits, custom scripts, deployed JARs, symbolic links — will not be present in the PATCH edition and will therefore disappear from the live system after cutover. The fix is either re-running \`adop phase=fs_clone\` within the current session to re-sync before applying the patch, or manually copying the changed files to the PATCH edition for small, known changes. A pre-apply rsync dry-run makes the out-of-sync state visible in under a minute and should be part of every patching process.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'EBS 12.2 adop: Run Filesystem Synchronisation and the Patch Edition',
    slug,
    excerpt: 'EBS 12.2 Online Patching synchronises the PATCH edition from the RUN edition once at prepare time. Any change to the RUN filesystem after that point — config file edits, custom scripts, deployed JARs, symbolic links — will be lost at cutover. Covers the dual-edition architecture, fs_clone internals, the classes of change at risk, how to detect out-of-sync files with rsync dry-run, and when to re-run fs_clone before apply.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
