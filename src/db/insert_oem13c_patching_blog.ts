import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'OEM 13c Patching and Upgrades: Architecture, Patch Types, and What Actually Breaks',
  slug: 'oem13c-patching-upgrades-guide',
  excerpt:
    'A technical guide to Oracle Enterprise Manager 13c patching and upgrades — how the OMS, repository, agent, and plugin components are patched independently, when to use OPatch versus OMSPatcher, the quarterly Bundle Patch release cadence, agent Gold Image management for mass patching, and the real-world failure modes that cause OEM patching to stall or corrupt the environment.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-24'),
  youtubeUrl: null,
  content: `## Overview

Oracle Enterprise Manager 13c is itself a complex Oracle application stack — WebLogic Server, a Management Repository database, OMS software, plugins, and agents deployed across every managed host. Patching this stack is not a single operation. It is a coordinated sequence involving multiple tools, multiple components, and a specific ordering that, if violated, produces errors ranging from failed agent communication to repository schema corruption that requires a full OEM reinstall to recover from.

This post explains the OEM 13c component architecture as it relates to patching, the patch types and tools involved, the quarterly Bundle Patch release cadence, how agent patching differs from OMS patching, and the most common failure modes encountered in production OEM patching operations.

---

## OEM 13c Component Architecture

Understanding what gets patched and in what order requires understanding the component relationships:

\`\`\`
Repository Database (Oracle DB 19c+)
  └── Management Repository Schema (SYSMAN, SYSMAN_MDS, etc.)
        └── Oracle Management Service (OMS)
              ├── WebLogic Server Domain (GCDomain)
              ├── EM Application (em.ear deployed on WebLogic)
              ├── OMS Software Home (\$OMS_HOME)
              └── Plugins (Database Plugin, Middleware Plugin, etc.)
                    └── Agents on managed hosts
                          ├── Agent Software Home (\$AGENT_HOME)
                          └── Agent-side Plugins (deployed from OMS)
\`\`\`

**Repository Database**: a standard Oracle database (19c or later for OEM 13.5) hosting the Management Repository schema. It is patched using standard Oracle OPatch like any other Oracle database — independently from the OEM patching process. Repository DB patching and OEM patching are separate maintenance activities with separate windows.

**OMS Software Home**: the Oracle home containing the OMS software, WebLogic binaries, and the OEM application. Patched with OPatch for software-only patches, or OMSPatcher for patches that also require repository schema changes.

**Plugins**: functional extensions deployed on top of OMS — Database Plugin, Middleware Plugin, Virtualization Plugin, and so on. Plugins have their own patch versions, separate from the OMS patch level. A plugin can be at a different patch level from the OMS.

**Agents**: lightweight processes deployed on every managed host. Each agent has its own Oracle home and its own patch level. Agent patching is separate from OMS patching, though agent patch levels must be compatible with the deployed OMS version.

---

## Patch Types and Tools

### OPatch

OPatch is the standard Oracle patching utility — the same tool used to patch Oracle Database and Oracle Fusion Middleware. For OEM 13c, OPatch applies to:
- The OMS software home for patches that affect only the OMS binary layer
- Each agent home for agent-side patches

OPatch does **not** run SQL scripts against the Management Repository. For any patch that requires repository schema changes, OMSPatcher must be used instead.

### OMSPatcher

OMSPatcher is an OEM-specific patching tool built on top of OPatch. It extends OPatch with the ability to:
- Stop and start the OMS automatically during patching
- Apply patches to the OMS software home (via embedded OPatch)
- Execute repository schema update SQL scripts (via OUI patching framework)
- Deploy updated plugin versions alongside OMS patches

Most OEM 13c Bundle Patches require OMSPatcher because they combine OMS software changes with repository schema updates. Attempting to apply a Bundle Patch with plain OPatch instead of OMSPatcher will partially apply the software change and leave the repository schema unmodified — producing version mismatch errors when OMS starts.

### emcli (Enterprise Manager Command Line Interface)

emcli is used for agent lifecycle management, including agent patching. From an OMS host with emcli configured, an administrator can:
- Push an Agent Gold Image to groups of agents
- Track the patching status of all agents across the estate
- Promote a Gold Image to become the new standard
- Trigger mass agent upgrades from the OMS

---

## Patch Release Cadence

Oracle releases OEM 13c patches on a quarterly schedule aligned with the CPU (Critical Patch Update) release dates (January, April, July, October).

### Bundle Patch

The primary patch vehicle for OEM 13c. Each quarterly Bundle Patch is cumulative — it includes all patches from prior BPs for the same release track. This means applying the latest BP applies all prior fixes simultaneously. There is no need to apply historical BPs sequentially.

A Bundle Patch for OEM 13c covers:
- OMS binary layer changes
- Repository schema updates (applied via OMSPatcher)
- OEM application and UI fixes
- Plugin updates (Database Plugin BP, Middleware Plugin BP, etc. — released on the same quarterly cadence but applied separately)

### Patch Set Update (PSU) vs Bundle Patch

For OEM 13c, Oracle moved away from PSUs (security-focused, smaller patches) in favour of Bundle Patches as the primary vehicle. Most security fixes are included in the Bundle Patch rather than released as standalone PSUs. Check the OEM patch readme on My Oracle Support (MOS) to confirm the security content of each BP.

### One-Off / Interim Patches

Specific bug fixes between quarterly releases. Applied with OPatch (software-only bugs) or OMSPatcher (if the fix includes repository changes). One-off patches must be checked for conflicts with the current BP level using \`opatch prereq CheckConflictAgainstOHWithDetail\` before application.

---

## Plugin Patching

Plugins are the most commonly overlooked aspect of OEM patching. The OMS and its plugins have separate patch versions, and they must be kept within a compatible range of each other. After applying an OMS Bundle Patch, check My Oracle Support for corresponding Plugin Bundle Patches for each deployed plugin and apply them in the same maintenance window.

Plugin patching steps differ from OMS patching:
1. Download the Plugin BP from MOS (separate patch number from the OMS BP)
2. Apply using OMSPatcher with the \`-pluginId\` flag targeting the specific plugin home
3. The plugin update must be deployed to agents after the OMS-side apply completes

Failing to patch plugins to the matching BP level after an OMS upgrade is the leading cause of "Plugin version mismatch" errors in the OEM console immediately after patching.

---

## Agent Gold Image Management

For environments with more than a handful of managed hosts, manual per-agent patching is impractical. The Agent Gold Image model is the correct approach:

A **Gold Image** is a snapshot of a correctly configured, fully patched agent Oracle home. The workflow is:

1. Patch one reference agent (the "master agent") to the target patch level using standard OPatch
2. Create a Gold Image from that agent's home via OEM console or emcli
3. Subscribe all other agents to the Gold Image
4. Trigger an "Update" of subscribed agents — OEM pushes the Gold Image software to each subscribed agent and restarts the agent at the new patch level

This model ensures all agents in the estate are at a consistent patch level, and rolling updates can be done in waves (test environment first, then production) with full tracking in the OEM console.

---

## OEM 13c Release Upgrades

Upgrading between OEM 13c minor releases (e.g., 13.4 → 13.5) is a different operation from applying a Bundle Patch. A release upgrade:
- Replaces the OMS software home entirely (in-place upgrade using the OEM installer in Upgrade mode)
- Upgrades the Management Repository schema to the new release version
- Requires agents to be upgraded afterward (agents from an older OEM 13c release are compatible for a limited time, but must eventually be upgraded)
- Requires plugins to be upgraded to versions compatible with the new release

The key difference from Bundle Patch application: a release upgrade uses the OEM installer (\`runInstaller\` or \`em13500_linux64.bin\`), not OMSPatcher. The installer handles both the software replacement and the repository upgrade in a single run.

**Upgrade path**: Oracle only supports upgrading from one or two prior OEM releases. Upgrading from OEM 12c to 13c, or from OEM 13.3 to 13.5, requires checking MOS for the supported upgrade path — unsupported direct upgrades require intermediate steps.

---

## Repository Database and OEM Patching: Keep Them Separate

A common mistake is attempting to patch the Repository Database and the OEM software in the same maintenance window. This creates two problems:

**If the repository DB patch fails**, the OEM software is at the new patch level but the repository is unmodified — version mismatch on OMS startup.

**If the OEM software patch fails**, the repository may have already been updated by the OMSPatcher workflow — leaving the repository at the new schema version with OMS still at the old software level.

Best practice: patch the Repository Database in a separate maintenance window, at least one week before the OEM software patching window. Confirm OEM is fully operational with the patched repository before proceeding to OMS patching.

---

## Common Failure Modes

**OMSPatcher prerequisite check failure**: OMSPatcher runs a prerequisite check before applying any patch. Common failure reasons:
- Insufficient disk space in \$OMS_HOME (need ~10 GB free for staging)
- OPatch version is older than required by the Bundle Patch — update OPatch first
- A conflicting one-off patch is already applied — requires rollback of the one-off before BP apply

**OMS fails to start after patching**: the most serious failure mode. Root causes:
- Repository schema update SQL did not complete (check OMSPatcher logs)
- WebLogic domain configuration file was corrupted by the patch — restore from backup and reapply
- Plugin version mismatch — the OMS was patched but plugins were not updated to matching levels

**Agent communication loss after OMS patching**: agents communicate on the upload port (4889). If the OMS certificate changed as part of the patching operation (uncommon but possible after full upgrades), agents lose trust and show as unreachable. Resolution: run agent re-secure from the OMS.

**Plugin deployment failure to agents**: after a Plugin BP is applied on the OMS, agents receive the updated plugin on their next heartbeat. If the agent software home lacks space or the agent is offline during the deployment window, the plugin version on the agent falls behind the OMS. Monitor plugin deployment status in the OEM console for 24 hours after patching.

---

## Pre-Patching and Post-Patching Health Checks

Before patching, the OEM environment should be confirmed healthy. Patching an OEM with pre-existing issues (agents already down, repository performance problems, pending jobs stuck) almost always results in a patching failure because OMSPatcher validates the environment state before proceeding.

Post-patching, validate in this order:
1. OMS is up and the console is accessible
2. Repository database connection is healthy (emctl status oms shows "Connected to Repository")
3. All previously-up agents have re-connected
4. Plugin versions in the console match the applied BP level
5. Scheduled jobs that were running before the maintenance window have resumed

---

## Summary

OEM 13c patching is a multi-component operation spanning the Repository Database (patched with standard OPatch, independently), the OMS software home (patched with OMSPatcher for Bundle Patches, OPatch for software-only one-offs), plugins (separate patch numbers, applied with OMSPatcher after OMS BP), and agents (managed via Agent Gold Image for mass patching at scale). The quarterly Bundle Patch is the primary patch vehicle and is cumulative — always apply the latest available BP rather than attempting to apply historical BPs in sequence. Release upgrades from one OEM 13c minor release to another use the OEM installer in Upgrade mode, not OMSPatcher, and must be planned as a separate activity from routine quarterly patching. Repository Database patching should always occur in a separate maintenance window from OEM software patching to prevent schema/software version mismatch. The companion runbook provides the complete step-by-step procedure, including pre-patch health checks, OMSPatcher apply sequence, agent Gold Image operations, and post-patch validation scripts.`,
};

async function main() {
  console.log('Inserting OEM 13c patching blog post...');
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
