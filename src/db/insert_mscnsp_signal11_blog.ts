import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'EBS ASCP Memory-Based Snapshot: Troubleshooting Signal 11 After a Production Clone',
  slug: 'ebs-ascp-mscnsp-signal11-troubleshooting-after-clone',
  excerpt:
    'A real-world EBS R12.2.9 troubleshooting case study: a Memory-Based Snapshot (MSCNSP) crash with Signal 11 after a production clone — traced through ulimit configuration, MSCCPP relinking, 64-bit profile option fixes, and a final data corruption diagnosis in the cloned environment.',
  category: 'appsdba' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `Every Oracle Apps DBA has been there: a production clone completes, smoke testing begins, and a critical concurrent program crashes with a low-level, cryptic error that wasn't present in production. The environment looks identical — same OS, same database version, same EBS release — yet something is fundamentally wrong.

This post walks through a real-world Oracle EBS R12.2.9 support case where the Advanced Supply Chain Planning (ASCP) Memory-Based Snapshot program (MSCNSP) crashed with a Signal 11 segmentation fault after a production-to-DEV clone on Oracle Linux 7.3. The investigation evolved through four distinct phases over four weeks, ultimately revealing that the Signal 11 was only the first symptom — the underlying problem was post-clone data corruption in the planning data.

---

## Environment

| Component | Version |
|-----------|---------|
| Oracle E-Business Suite | R12.2.9 |
| Oracle Database | 19c |
| Operating System | Oracle Linux Server 7.3 |
| Affected Program | MSCNSP (Memory-Based Snapshot) |
| Module | Oracle ASCP / Value Chain Planning |
| Affected Instance | DEV (cloned from PRD) |

---

## The Initial Symptom: Signal 11

Immediately after cloning production into DEV, the Memory-Based Snapshot concurrent program — which pre-processes planning data into memory-optimized structures for ASCP plan launches — failed with a bare-bones error:

\`\`\`
/u01/dev/fs1/EBSapps/appl/msc/12.0.0/bin/MSCNSP
Program was terminated by signal 11
\`\`\`

**Signal 11 is a segmentation fault** — the binary tried to read or write a memory address it was not permitted to access. The process was killed by the OS. No Oracle error code, no stack trace, no SQL exception — just the OS pulling the plug.

The critical clue: QA and PRD instances were running the exact same EBS patchset and the exact same MSCNSP executable without any issue. The problem was definitively DEV-specific.

---

## Phase 1: OS Limits Investigation (ulimit)

When a C or C++ Oracle binary crashes with a segmentation fault, the first diagnostic question is: **did the OS allow the process enough room to operate?**

On Oracle Linux, shell limits are controlled per-user via \`ulimit\`. Comparing DEV against QA and PRD revealed a critical difference — not in open file limits or process counts, but in two specific settings:

**DEV ulimit output:**
\`\`\`
core file size (blocks, -c)   0           ← core dumps DISABLED
stack size (kbytes, -s)       10240       ← 10 MB stack limit
\`\`\`

**QA and PRD showed identical values** — so ulimit was not the reason QA/PRD worked. But the disabled core dump was masking diagnostic information. When \`MSCNSP\` crashed, no core file was written to \`$APPLCSF/log\` or \`/tmp\`, making it impossible to inspect the stack trace at the moment of failure.

### Fix: Enable Core Dumps and Expand Stack

As root, update \`/etc/security/limits.conf\`:

\`\`\`
* soft core  unlimited
* hard core  unlimited
* soft stack unlimited
* hard stack unlimited
\`\`\`

And ensure \`/etc/profile\` does not override:

\`\`\`bash
ulimit -S -c unlimited > /dev/null 2>&1
ulimit -S -s unlimited > /dev/null 2>&1
\`\`\`

After bouncing the middle tier and re-running \`ulimit -a\` as \`appldev\`, confirm:

\`\`\`
core file size (blocks, -c)   unlimited
stack size (kbytes, -s)       unlimited
\`\`\`

---

## Phase 2: Relinking the MSC Executable

With OS limits addressed, the next question was **executable integrity**. During an EBS clone, the file system layers (fs1, fs2) are copied or refreshed. A partial copy or permission mismatch during the clone could produce a binary that links correctly at relink time but crashes at runtime due to mismatched shared library offsets.

Using \`adadmin\`:

1. Navigate to **Maintain Applications Executables → Relink Applications programs**
2. Select product: **MSC**
3. Select specific binary: **MSCCPP / MSCNSP**
4. Enable link debug: **Yes**

The relink completed with exit status 0:

\`\`\`
Done with link of msc executable 'MSCCPP' on Wed May 27 11:49:41 CDT 2026
adrelink is exiting with status 0
\`\`\`

The MSCNSP binary was rebuilt from its object files against the correct shared libraries. Despite a clean relink, the Signal 11 persisted on retest.

---

## Phase 3: Enabling Debug Tracing

With the binary ruled out, the team enabled full debug logging to capture what MSCNSP was doing immediately before the crash.

### Profile Options to Enable

| Profile Option | Value | Level |
|---------------|-------|-------|
| Concurrent: Allow Debugging | Yes | Site |
| FND: Debug Log Enabled | Yes | Site |
| FND: Debug Log Level | Statement | Site |
| FND: Debug Log Module | \`%MSC%\` | Site |

Additionally, when submitting the MSC plan concurrent program, select the **Debug** option and configure **SQL Trace with Binds and Waits** before clicking Submit.

### Checking the DB Tier

Beyond application-tier tracing, the database alert log and trace directory must be checked simultaneously:

\`\`\`bash
# Watch alert log for ORA- errors during the run
tail -f $ORACLE_BASE/diag/rdbms/<DBNAME>/<SID>/trace/alert_<SID>.log

# List any new trace files generated during the run
ls -ltr $ORACLE_BASE/diag/rdbms/<DBNAME>/<SID>/trace/*.trc | tail -20
\`\`\`

The traces alone did not pinpoint the exact crash address, but they eliminated SQL-level errors as the cause — the process was crashing in native C memory operations, not in Oracle SQL execution.

---

## Phase 4: The 64-Bit Profile Fix — Signal 11 Resolved

The breakthrough came when the team examined how MSCNSP allocates its in-memory planning data structures. ASCP's snapshot engine builds large memory-mapped arrays to represent supply chain networks. On a 64-bit OS with a 32-bit execution boundary, these allocations can exceed addressable space and trigger a segmentation fault.

Two profile options control this behaviour:

### MSC 64-bit Platform

**Navigation:** System Administrator → Profiles → search \`MSC 64-bit Platform\`

This field was **blank** in DEV. It must explicitly identify the OS architecture:

| Setting | Value |
|---------|-------|
| MSC 64-bit Platform | Linux 64 bit |

### MSC Enable 64 bit Snapshot

**Navigation:** System Administrator → Profiles → search \`MSC Enable 64 bit snapshot\`

This flag was **Disabled** (the default in freshly cloned environments that inherit a baseline system profile set). Set it to **Yes**.

After saving both profiles and resubmitting MSCNSP, the Signal 11 **did not appear**. The program successfully spawned its child worker processes and continued beyond the point of previous failure. This confirmed the root cause of the segmentation fault: the snapshot engine was attempting 64-bit memory allocations in a session that believed it was running in a 32-bit execution context.

---

## Phase 5: The Next Error — APP-MRP-22075

With the memory crash resolved, the program ran further — and then failed again with a completely different error class:

\`\`\`
worker got task to run= 10043
APP-MRP-22075: An internal error has occurred (mrnspxt, 46, 10043, )
APP-MRP-22075: An internal error has occurred (mrnspgpt, 14, 202 , 10043, )
APP-MRP-22075: An internal error has occurred (main, 13, , )
\`\`\`

**APP-MRP-22075** is an ASCP internal framework error, not a memory error. The \`mrnspxt\` and \`mrnspgpt\` routines are responsible for data extraction and gathering phases of the snapshot — reading planning data from EBS base tables and constructing the in-memory network.

These errors indicate that the planning data the snapshot engine is trying to read is **invalid or inconsistent**. Common causes in cloned environments:

| Data Problem | Description |
|-------------|-------------|
| Invalid calendar dates | Planning calendars reference non-existent workday patterns |
| Bad UOM conversions | Unit of measure conversion rules missing or zero-valued |
| Broken BOM structures | Bill of Materials with orphaned components post-clone |
| Invalid item/org combinations | Items assigned to orgs that don't exist in the cloned org structure |
| Corrupt sourcing rules | Sourcing rules referencing deleted suppliers or invalid ship methods |

The support engineer's diagnosis: **the clone itself introduced data integrity issues** — likely because the cloned DEV database was not a clean transactional snapshot, or because reference data (calendars, UOM conversions, organizational parameters) was partially refreshed post-clone and left in an inconsistent state.

---

## Resolution: Reclone from Production

With the data corruption diagnosis confirmed, the resolution path was clear:

1. **Perform a fresh production clone** to DEV, ensuring the clone script captures a transactional-consistent point (using RMAN with \`consistent=y\` or a cold backup)
2. **Immediately apply the 64-bit profile options** post-clone (before testing MSCNSP)
3. **Validate planning data** using the ASCP diagnostic queries before submitting the snapshot

---

## Summary and Best Practices

### What Happened

| Phase | Error | Root Cause |
|-------|-------|-----------|
| 1 | Signal 11 crash on MSCNSP start | MSC 64-bit profile options blank after clone |
| 2 | APP-MRP-22075 internal errors | Corrupt planning data (calendars, UOM, BOM) in cloned schema |

### Post-Clone Checklist for ASCP Environments

**Profile options to verify immediately after every clone:**

\`\`\`sql
-- Check MSC profile options from the database
SELECT p.profile_option_name,
       v.profile_option_value
FROM   fnd_profile_options      p
JOIN   fnd_profile_option_values v
       ON  v.profile_option_id  = p.profile_option_id
       AND v.level_id           = 10001   -- Site level
WHERE  p.profile_option_name IN (
         'MSC_64BIT_PLATFORM',
         'MSC_ENABLE_64BIT_SNAPSHOT'
       );
\`\`\`

Expected results: both must have non-null values. \`MSC_ENABLE_64BIT_SNAPSHOT\` must be \`Y\`.

**OS limits to verify as root after clone:**

\`\`\`bash
su - appldev -c "ulimit -a" | grep -E 'core|stack'
# Expected:
# core file size (blocks, -c)  unlimited
# stack size (kbytes, -s)      unlimited
\`\`\`

**Validate planning data before MSCNSP:**

\`\`\`sql
-- Check for items with no valid UOM
SELECT COUNT(*) FROM msc_system_items
WHERE  primary_uom_code IS NULL
AND    plan_id = -1;

-- Check for null calendar dates
SELECT COUNT(*) FROM msc_calendars
WHERE  calendar_start_date IS NULL
OR     calendar_end_date   IS NULL;

-- Verify org count is consistent with PRD
SELECT COUNT(DISTINCT organization_id) FROM msc_system_items WHERE plan_id = -1;
\`\`\`

### Best Practices for EBS ASCP Environments

1. **Document and automate post-clone profile option restoration.** ASCP 64-bit profile options are not always preserved when cloning to lower environments with custom site-level profiles. Keep a post-clone runbook that explicitly sets these values.

2. **Enable core dumps permanently in non-production.** A Signal 11 with no core file is nearly impossible to diagnose without months of trial and error. Lower environments should always have \`ulimit -c unlimited\` configured in \`/etc/security/limits.conf\`.

3. **Run ASCP data validation queries before the first snapshot.** The APP-MRP-22075 family of errors almost always points to bad reference data. Running a pre-flight validation script immediately after cloning and before testing prevents multi-week investigation cycles.

4. **Treat a cloned environment as untrusted until MSCNSP completes successfully.** The ASCP snapshot is the canary — if it fails, other planning processes (plan launch, ATP, DRP) will also fail with equally cryptic internal errors.

5. **Compare ulimit between environments before chasing application-layer bugs.** OS configuration drift between PRD and cloned environments is a systematic source of errors that appear application-specific but are infrastructure-rooted.

6. **Log the Signal 11 instance name and timestamp.** When a Signal 11 occurs, capture \`ps -ef | grep MSC\` output immediately — the PID and working directory often identify which data task caused the crash before the process table is cleaned up.

The companion runbook covers the complete post-clone verification procedure, the monitoring script for MSCNSP health, and the exact SQL queries to validate planning data integrity before submitting the snapshot.`,
};

async function main() {
  console.log('Inserting EBS ASCP MSCNSP Signal 11 blog post...');
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
