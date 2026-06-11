import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'EBS_SYSTEM and SYSTEM Password Synchronization in Oracle EBS 12.2 on Database 19c CDB',
  slug: 'oracle-ebs-system-ebs-system-password-sync-19c-cdb',
  excerpt:
    'Why a routine EBS R12.2.4 password rotation script stalls on Oracle Database 19c CDB: the SYSTEM and EBS_SYSTEM synchronization dependency, how to apply changes safely with CONTAINER=ALL, which patches relax the identical-password requirement, and why special characters in these credentials silently break adop.',
  category: 'appsdba' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `Upgrading Oracle E-Business Suite to run on Oracle Database 19c introduces a fundamental architectural change: the move from a traditional non-CDB instance to a Multitenant Container Database (CDB) design. For most workloads, this transition is transparent. For password management of the specialized \`SYSTEM\` and \`EBS_SYSTEM\` schemas, it introduces a dependency that is easy to overlook and surprisingly disruptive when it surfaces.

This post documents a real-world support case where a routine security maintenance script stalled during an EBS R12.2.4 environment, explains the underlying CDB architecture that causes the hang, and provides the correct procedure for safely managing these credentials in a 19c environment.

---

## What Is EBS_SYSTEM and Why Does It Exist?

In Oracle EBS 12.2 running on a 19c CDB, \`EBS_SYSTEM\` is an administrative schema that manages cross-container and pluggable database (PDB) operational tasks. It was introduced as part of the EBS-on-CDB architecture to provide EBS application utilities — particularly the Online Patching framework (\`adop\`) — with a controlled, predictable point of entry across the container boundary.

The two schemas and their roles:

| Schema | Container | Primary Role |
|--------|-----------|-------------|
| \`SYSTEM\` | CDB\$ROOT and all PDBs | Oracle built-in DBA schema |
| \`EBS_SYSTEM\` | CDB\$ROOT and all PDBs | EBS administrative schema for cross-container patching operations |

Both schemas must exist in \`CDB\$ROOT\` and in every PDB associated with the EBS instance. Both must be accessible to \`adop\` during Online Patching cycles.

---

## The Problem: A Password Script That Hangs

The failure scenario: during a security maintenance window on EBS R12.2.4 running on Oracle Database 19c, a DBA team ran an automated script to rotate all application schema passwords. The script iterated through a list of schemas, issuing \`ALTER USER ... IDENTIFIED BY\` commands.

Several schemas updated cleanly. When the script reached \`EBS_SYSTEM\`, it hung. No error message, no timeout — the session simply stopped progressing.

### Why the Script Hung

The hang occurs because of the interaction between three factors:

**1. The identical-password constraint.** Oracle historically enforced that \`SYSTEM\` and \`EBS_SYSTEM\` must have identical passwords in an EBS CDB environment. The patching utilities (\`adop\`, AutoConfig, AD utilities) authenticate to both schemas during their execution. If the passwords differ, the utilities fail authentication on one schema even when the other succeeds.

**2. The container scope of the change.** In a CDB, \`ALTER USER SYSTEM IDENTIFIED BY\` without \`CONTAINER=ALL\` changes the password only in the current container context. If you are connected to \`CDB\$ROOT\` and change the password there, the password in the PDB may remain unchanged — or vice versa. When the next connection attempt is routed to the PDB context, authentication fails because the password stored there still reflects the old value.

**3. Script assumptions about non-CDB architecture.** Password rotation scripts written for pre-19c non-CDB environments issue single \`ALTER USER\` statements and expect them to propagate automatically. In a CDB, propagation is explicit and requires \`CONTAINER=ALL\`.

The combination: the script changed \`EBS_SYSTEM\` in one container but not the other, the EBS utility framework subsequently failed to authenticate, and the script's own health-check step waited for a confirmation signal that never came.

---

## The Architecture of a CDB Password Change

Before the fix, it is worth understanding exactly what Oracle does when you issue a password change in a CDB environment.

\`\`\`
CDB$ROOT
  ├─ SYSTEM   (common user, defined here)
  ├─ EBS_SYSTEM (common user, defined here)
  │
  └─ PDB (EBS application PDB)
       ├─ SYSTEM   (common user, visible from CDB$ROOT)
       └─ EBS_SYSTEM (common user, visible from CDB$ROOT)
\`\`\`

\`SYSTEM\` and \`EBS_SYSTEM\` are **common users** — they exist at the CDB root level and are visible in all PDBs. A password change issued in \`CDB\$ROOT\` without \`CONTAINER=ALL\` modifies only the CDB-level credential. The PDB-level view may cache or inherit the old value.

\`CONTAINER=ALL\` forces the change to propagate to the root container and every open PDB simultaneously — which is the correct scope for any common user password change in EBS.

---

## The Fix: Manual Password Synchronization

When an automated script stalls, the correct remediation is a manual password change using the proper CDB scope.

### Step 1: Confirm you are in CDB\$ROOT

\`\`\`sql
sqlplus / as sysdba

SHOW CON_NAME;
-- Expected: CDB\$ROOT

-- If connected to a PDB, switch:
ALTER SESSION SET CONTAINER = CDB\$ROOT;
SHOW CON_NAME;
\`\`\`

### Step 2: Check current account status across all containers

Before changing anything, establish a baseline:

\`\`\`sql
SELECT c.name          AS container_name,
       u.username,
       u.account_status,
       u.lock_date,
       u.expiry_date,
       u.password_versions
FROM   cdb_users   u
JOIN   v\$containers c ON c.con_id = u.con_id
WHERE  u.username IN ('SYSTEM','EBS_SYSTEM')
ORDER BY c.name, u.username;
\`\`\`

Note any containers where the account is LOCKED or EXPIRED — those will need to be unlocked explicitly after the password change.

### Step 3: Apply the password change across all containers

Both schemas must be changed to the **same password** in a single operation:

\`\`\`sql
-- Change SYSTEM — must use CONTAINER=ALL to propagate to all PDBs
ALTER USER SYSTEM     IDENTIFIED BY YourNewSecurePassword CONTAINER=ALL;
ALTER USER EBS_SYSTEM IDENTIFIED BY YourNewSecurePassword CONTAINER=ALL;
\`\`\`

**Password character restrictions:** Use alphanumeric characters only. Do not use \`$\`, \`@\`, \`%\`, \`!\`, or any other special character. Backend EBS shell scripts pass these credentials as positional arguments without quoting, and most special characters are interpreted as shell syntax operators — causing utilities to silently hang or fail with misleading errors.

### Step 4: Unlock accounts if needed

\`\`\`sql
ALTER USER EBS_SYSTEM ACCOUNT UNLOCK CONTAINER=ALL;
ALTER USER SYSTEM     ACCOUNT UNLOCK CONTAINER=ALL;
\`\`\`

### Step 5: Verify the change across all containers

\`\`\`sql
SELECT c.name          AS container_name,
       u.username,
       u.account_status,
       u.expiry_date
FROM   cdb_users   u
JOIN   v\$containers c ON c.con_id = u.con_id
WHERE  u.username IN ('SYSTEM','EBS_SYSTEM')
ORDER BY c.name, u.username;
\`\`\`

Both schemas should show \`OPEN\` status in all containers with matching expiry dates.

---

## Can SYSTEM and EBS_SYSTEM Have Different Passwords?

The identical-password requirement is a code-level enforcement in EBS utilities — not a database-level constraint. The question of whether they *can* be separated depends on your patch level.

### Patches That Relax the Requirement

| Patch | Purpose |
|-------|---------|
| **32573930** | Relaxes the EBS_SYSTEM/SYSTEM identical-password enforcement in adop |
| **31817501** | Updates AD utilities to tolerate separate SYSTEM and EBS_SYSTEM credentials |

If both patches are applied, the database permits different passwords for the two schemas. However, "permitted by the database" and "handled correctly by all EBS utilities" are different things.

### What Can Still Break With Separate Passwords

Even with the patches applied, these are known failure points when the passwords diverge:

**adop execution risk:** Certain adop phases (specifically \`prepare\` and \`cutover\`) run internal authentication checks against both schemas. If a standard EBS wrapper script was not updated to handle separate credentials, adop will fail with an ORA-01017 authentication error mid-cycle.

**AutoConfig:** AutoConfig reads schema credentials from the APPS schema and context files. If the context file has been generated assuming identical SYSTEM/EBS_SYSTEM passwords, AutoConfig will fail to authenticate to one of the schemas during the run.

**Password Verification Functions:** If the database security profile enforces a \`VerifyPassword\` function, the function is called for each schema independently. A complexity rule that accepts a password for one schema may reject the same string for the other (for example, if the function checks the previous password history per-schema and they are in different history states).

---

## Password Character Restrictions: Why This Matters More Than You Think

The most common cause of "password change worked in SQL but utilities still fail" is a special character in the password that is syntactically valid in SQL but breaks shell-level credential passing.

EBS administration scripts (\`adop\`, \`adadmin\`, \`txkCfgUtlCleanup.pl\`, AutoConfig) accept credentials on the command line or read them from files. These scripts are shell-executed wrappers. Special characters in positional arguments:

| Character | What Goes Wrong |
|-----------|----------------|
| \`$\` | Shell interprets it as a variable reference: \`$ORACLE_HOME\` becomes the env var |
| \`@\` | TNS connection syntax: \`apps/@DBSID\` becomes a failed TNS connect string |
| \`!\` | History expansion in bash: \`!abc\` triggers a history search |
| \`%\`, \`&\` | Various shell operators that truncate or background the command |
| \`(\` \`)\` | Subshell syntax: the argument is parsed as a subshell invocation |

**Use only: A-Z, a-z, 0-9, and underscore \`_\`.** Avoid even underscore at the start or end of the password as some utilities trim it.

---

## Testing Before Production: The adop Cycle Validation

Whether you are keeping the passwords identical or separating them after patching, the only reliable test is a complete \`adop\` cycle in a non-production environment.

\`\`\`bash
# As applmgr — run a complete adop cycle after the password change
# Each phase should complete cleanly without ORA-01017 or authentication errors

adop phase=prepare
# Verify: no SYSTEM or EBS_SYSTEM authentication failures in the log

adop phase=apply patches=<TEST_PATCH_NUMBER>
# Apply a low-risk test patch

adop phase=finalize
adop phase=cutover
adop phase=cleanup
\`\`\`

If any phase exits with an ORA-01017 error, an authentication failure, or hangs without progressing, the password configuration is not valid for the current patch level and utility set.

---

## Summary and Best Practices

### When Things Break and Why

| Symptom | Root Cause |
|---------|-----------|
| Password script hangs on EBS_SYSTEM | Missing \`CONTAINER=ALL\` or non-CDB script in CDB environment |
| adop fails with ORA-01017 after password change | SYSTEM and EBS_SYSTEM passwords differ without required patches |
| Utilities fail silently, no error message | Special character in password breaking shell argument parsing |
| Password "changed" but utilities still fail | Change applied to CDB\$ROOT only, PDB password unchanged |
| EBS_SYSTEM account LOCKED after rotation | Script changed password but previous lock state not cleared |

### Best Practices

1. **Always use \`CONTAINER=ALL\` for SYSTEM and EBS_SYSTEM password changes** in a 19c CDB. A change without \`CONTAINER=ALL\` is incomplete by definition.

2. **Keep SYSTEM and EBS_SYSTEM passwords identical unless both patches 32573930 and 31817501 are applied** — and even then, validate with a full adop cycle before trusting the configuration in production.

3. **Use only alphanumeric characters (A-Z, a-z, 0-9) in these passwords.** No exceptions. Every special character has a documented failure mode in at least one EBS utility.

4. **Verify account status across all containers before and after every rotation.** Use the \`cdb_users\` + \`v\$containers\` join — not \`dba_users\`, which only shows the current container.

5. **Run the full adop cycle validation in Dev/Test after every password rotation procedure change** before applying it to production. A password rotation that works in isolation but breaks adop during the next maintenance window is a failed rotation.

6. **Automate the drift check.** A scheduled job that compares the password hash of SYSTEM against EBS_SYSTEM across all containers will catch accidental divergence before it causes an adop failure during a critical patching cycle.

The companion runbook covers the complete step-by-step procedure, how to update the EBS context file after a password change, the AutoConfig re-run sequence, and a monitoring script that detects SYSTEM/EBS_SYSTEM password drift and account lock state across all CDB containers.`,
};

async function main() {
  console.log('Inserting EBS_SYSTEM password sync blog post...');
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
