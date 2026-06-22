import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS Patching Strategy: A Practical Guide to Staying Current Without Breaking Production',
  slug: 'ebs-patching-strategy-guide',
  excerpt:
    'A comprehensive guide to Oracle EBS patch types, release strategy, risk management, and how to build a sustainable patching cadence that keeps your instance secure and supportable without disrupting operations.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-22'),
  youtubeUrl: null,
  content: `EBS patching has a reputation it does not entirely deserve. The reputation is: slow, risky, frequently breaks things, requires months of testing. The reality is more nuanced. Done with a systematic strategy and proper tooling, EBS patching is a manageable, repeatable process. Done ad hoc — applying whatever Oracle Support recommends in the moment, without a cadence or test plan — it becomes exactly as painful as the reputation suggests.

This post lays out the patch landscape, the tool that transformed EBS patching (adop), and a practical patching strategy for a production EBS R12.2.x instance.

---

## The EBS R12.2.x Patch Landscape

Oracle EBS R12.2 has two independent patch trains that you manage separately:

### Train 1: AD-TXK (Technology Stack Patches)

AD-TXK patches update the Oracle Applications technology layer — the infrastructure that supports EBS but is not the EBS application code itself:

- adop (the online patching utility) — the tool you use to apply all other patches
- OAM (Oracle Applications Manager) — the admin console
- JDK version bundled with EBS
- Oracle HTTP Server (OHS) and WebLogic Server versions
- E-Business Suite Coexistence with Oracle BI Publisher, OAF, and OBIEE
- Java-based workflow components

AD-TXK patches are released periodically. The current AD-TXK level is a prerequisite for applying application code patches (RUPs). Check the RUP README for the minimum AD-TXK version required before applying the RUP.

\`\`\`bash
# Check current AD-TXK level on application server
cat $AD_TOP/patch/115/version.txt
# Example output: 12.2.0 ADTXK DELTA 20
\`\`\`

### Train 2: RUP (Release Update Pack)

RUPs are cumulative patches to EBS application code. Each RUP includes all prior RUPs plus new fixes and features. As of mid-2026, EBS R12.2 is at RUP 13/14.

RUPs are large patches (multi-gigabyte download, tens of thousands of files). They update PL/SQL packages, Java classes, Forms FMB files, and XML/seeded data. A full RUP application on a typical EBS instance takes 4–8 hours of patch application time (apply phase), plus the cutover window (10–30 minutes of user-visible downtime).

### Individual Patches (One-Offs)

One-off patches fix specific bugs. They are ordered by patch number. You apply them when:
- Oracle Support recommends a specific patch to fix a production issue (SR-driven)
- A patch is listed as a prerequisite in another patch's README
- You are proactively applying known-issue fixes ahead of a Go-Live

One-offs are small and fast to apply, but require conflict checking — a one-off patch may conflict with a previously applied one-off, requiring Oracle to generate a merged patch.

### CPU (Critical Patch Update)

CPUs address security vulnerabilities. They are released quarterly (January, April, July, October). For Oracle EBS, CPUs patch:

1. **Oracle Database** (via OPatch directly on the DB home)
2. **Oracle Fusion Middleware** (WebLogic, OHS — via OPatch on the FMW home)
3. **Oracle E-Business Suite application code** (via adop for EBS-specific security patches)

CPU patches for EBS are listed in Oracle's quarterly CPU advisory, available on the Oracle Security Alerts page and via MOS (My Oracle Support). After each CPU release, Oracle provides an EBS-specific advisory listing which CPU patches apply to EBS.

---

## adop: How Online Patching Works

Oracle introduced adop (AD Online Patching) with EBS R12.2. It is the single most important change to EBS patching in the product's history. Before adop, applying any patch required a full application maintenance window — hours of downtime per patch. With adop, patches can be applied while users are working.

### The Dual File System

EBS R12.2 maintains two complete sets of application files on disk:
- **fs1** (or RUN): the currently active file system serving user requests
- **fs2** (or PATCH): the standby file system where patches are applied

At any given time, one file system is the active/run file system and the other is the patch file system. The adop cutover phase atomically swaps their roles.

### adop Phases

\`\`\`
prepare → apply → finalize → cutover → cleanup
   ↓         ↓         ↓         ↓          ↓
Sets up fs2  Applies  Final    Switches   Removes
for patch    patch    compile/ fs1↔fs2    old fs1
             to fs2   link     (downtime)  objects
\`\`\`

**prepare**: adop creates a new patch edition in the Oracle Database, prepares fs2 for the incoming patch. The application continues running on fs1. Duration: 20–40 minutes.

**apply**: adop applies the patch files to fs2 and the patch database edition. Users continue working on fs1. The patch may take 2–8 hours for a RUP. No user impact.

**finalize**: adop runs final compile and link operations on fs2. Users still on fs1. Duration: 30–60 minutes.

**cutover**: adop switches the active file system from fs1 to fs2. This requires a brief application restart. Users are directed to log out. Duration: 10–30 minutes. This is the only user-visible downtime.

**cleanup**: adop drops the old patch edition objects from the database and compresses fs1 to free disk space. Can run after cutover, often during business hours. Duration: varies, can take hours but is non-disruptive.

### Why cutover Is Only 10–30 Minutes

The preparation work — file deployment, SQL patching, compile/link — all happens during the apply phase while users are working. By the time cutover runs, the new code is already compiled and linked. Cutover only needs to: bounce the application services, switch the file system pointer, and verify services come up on the new file system.

---

## Patch Types and Their Risk Profiles

| Patch Type | Size | Risk | Testing Required | Target Cadence |
|-----------|------|------|-----------------|---------------|
| CPU — DB/FMW (OPatch) | Small | Low–Medium | Non-prod + prod rollout | Every quarter |
| CPU — EBS application (adop) | Medium | Low | DEV + UAT before prod | Every quarter |
| One-off (bug fix) | Small | Low–High (depends on scope) | DEV + targeted functional test | On-demand |
| AD-TXK delta | Medium | Low–Medium | DEV + basic smoke test | Before each RUP |
| RUP | Large | Medium–High | Full regression, DEV → SIT → UAT → Prod | Annually |

---

## Risk Management

### Test Environment Discipline

The mandatory pre-production path before any EBS production patch is:

\`\`\`
DEV (apply + functional test)
  → SIT (if you have one — integration testing)
    → UAT (user acceptance testing, 1–2 weeks for RUPs)
      → Production
\`\`\`

The biggest risk in EBS patching is not the patch itself — it is applying to production without adequate non-production testing. An EBS RUP touches thousands of database objects. Without UAT-level testing, regression bugs in critical business processes (AP invoice creation, GL journal generation, period close) will surface in production.

### What to Test

For each patch, define a test scope based on what the patch touches. Oracle's patch README includes a "List of Bugs Fixed" section. Map those bug fixes to EBS modules and test the corresponding business processes.

Minimum test scope for any RUP:
- Submit and post a GL journal
- Create and validate an AP invoice, run payment creation
- Create an AR invoice, apply a receipt
- Run a key concurrent program in each module (GL Transfer, AutoInvoice, etc.)
- Verify the Concurrent Manager starts correctly post-cutover
- Run 3–5 custom concurrent programs that are critical to your business

### The Baseline Document

Before any patch, document the current state:
- Key concurrent program run times (e.g., "GL Transfer typically completes in 23 minutes")
- Key report outputs (e.g., snapshot of the Trial Balance for a test set of books)
- Custom object compilation status (all INVALID packages before patch = known baseline)

Post-patch, compare these baselines. A concurrent program that took 23 minutes in DEV now takes 47 minutes → investigate before promoting to production.

### Rollback Plan

**Before cutover**: adop can roll back the apply phase completely. \`adop phase=rollback\` reverses the patch application on fs2 without affecting the running application on fs1. Low risk, clean rollback.

**After cutover**: Rolling back a cutover in production is a serious operation. It requires:
1. A full RMAN database backup taken immediately before cutover (non-negotiable)
2. Restoring the database to pre-cutover SCN
3. Switching the file system back to the pre-patch state

This is why the cutover backup is mandatory, not optional. Plan time for it in your maintenance window.

---

## The Patch Conflict Problem

Oracle EBS is a vast application. When two one-off patches both modify the same PL/SQL package body, they conflict. Oracle's OPatch utility detects these conflicts before applying:

\`\`\`bash
# Conflict check for a one-off patch before applying
cd /u01/oracle/patches/<patch_number>
opatch prereq CheckConflictAgainstOHWithDetail -ph .
\`\`\`

If a conflict is detected, the resolution options are:

1. **Apply in the correct order**: the patch README specifies which patch must be applied first
2. **Request a merged patch**: open an SR with Oracle Support, provide the conflicting patch numbers. Oracle generates a merged patch that includes both fixes in a single, conflict-free patch.
3. **Apply the later patch only**: if one patch is a superset of the other (later patch includes the earlier bug fix), applying only the later patch is sufficient

---

## Building a Sustainable Patching Cadence

### Annual Calendar Framework

\`\`\`
Q1 (January–March)
  Week 1: Oracle releases quarterly CPU
  Week 2–3: Apply CPU to DEV, test
  Week 4: Apply CPU to UAT, test
  Week 6: Apply CPU to Production (during scheduled maintenance window)

Q2 (April–June)
  Quarterly CPU cycle (repeat above)
  June: Apply AD-TXK delta to DEV (prepare for July RUP application)

Q3 (July–September)
  Quarterly CPU cycle
  July–August: Apply latest RUP to DEV and SIT
  August–September: RUP UAT (2–3 weeks)
  Late September: RUP Production (annual patching window — schedule 48 hours)

Q4 (October–December)
  October: Oracle releases quarterly CPU
  Apply CPU cycle
  November–December: Freeze (avoid patching during year-end close)
\`\`\`

This calendar applies CPUs every quarter (security posture) and one major RUP per year (functional currency with Oracle's development). It avoids patching during Q4 year-end close when business risk is highest.

### What Oracle Support Expects

When you open a Severity 1 SR about an EBS application issue, Oracle Support's first request is: "What is your current EBS patch level? Are you on the latest RUP?"

If you are more than one RUP behind, Oracle Support will often request that you patch to the current RUP before investigating. Being on a current RUP level is the baseline expectation for Oracle Support engagement.

The practical implication: if you have an unresolved critical SR in progress, check whether applying the latest RUP will be required before Oracle Support resolves it. If yes, plan the RUP patching cycle urgently.

### Patch Level Documentation

Maintain a patch inventory document (or MOS configuration record) that lists:
- Current EBS base release (R12.2)
- Current AD-TXK level
- Current RUP level
- All applied one-off patches (patch number, date applied, reason applied)
- Oracle Database patch level (current RU/PSU)
- Oracle Fusion Middleware patch level

This document is required for Oracle Support interactions and for any audit of your EBS instance compliance posture.

The companion runbook provides the step-by-step end-to-end patch execution procedure, from patch download through cutover to post-patch validation.`,
};

async function main() {
  console.log('Inserting EBS patching strategy blog post...');
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
