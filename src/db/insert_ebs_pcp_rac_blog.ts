import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle EBS Parallel Concurrent Processing (PCP) on RAC: Configuration, Failover, and Real-World Troubleshooting',
  slug: 'oracle-ebs-pcp-rac-failover-configuration-troubleshooting',
  excerpt:
    'A deep dive into configuring Oracle EBS Parallel Concurrent Processing (PCP) for Real Application Clusters: the two valid configuration matrices, the golden rule that causes most production incidents, and four real-world failure scenarios with root causes and fixes — including managers hanging on node crash, reviver.sh errors, failed requests not restarting, and Pending Standby lockups.',
  category: 'appsdba' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-16'),
  youtubeUrl: null,
  content: `Configuring Oracle E-Business Suite to handle seamless failover across a Real Application Clusters database environment is deceptively hard. The mechanics look straightforward: when a RAC node crashes, the concurrent managers connected to that node should detect the failure, release their database locks, and allow requests to be picked up by managers on the surviving node.

In practice, the wrong combination of a single profile option and a TNS alias type produces some of the most frustrating EBS support incidents in existence — managers stuck in "Target node/queue unavailable," requests piling up in "Pending Standby" for an hour, and failover tests that work on node 1 but silently break on node 2.

This post explains the two valid PCP+RAC configuration matrices, the exact conditions that trigger each failure pattern, and how to resolve them.

---

## What Is Parallel Concurrent Processing?

EBS Parallel Concurrent Processing (PCP) is the architecture that allows multiple application-tier nodes to share responsibility for running concurrent requests against a single EBS database. Each application node runs its own set of concurrent managers. The Internal Concurrent Manager (ICM) on each node coordinates which managers own which work queues and which requests are currently running.

In a RAC environment, each concurrent manager node connects to a specific (or load-balanced) database instance. When that instance goes down, the ICM must:

1. Detect the database connection loss
2. Determine which requests were running on the failed instance
3. Restart eligible requests on a surviving manager

The question of *how* the ICM detects the database connection loss — and therefore how reliably it responds — is controlled entirely by two settings: the **\`Concurrent:PCP Instance Check\`** profile option and the **\`TWO_TASK\` / \`cp_twotask\`** network alias.

---

## The Two Valid Configurations

### Configuration Option 1: Dedicated Instance Routing

| Setting | Value |
|---------|-------|
| \`TWO_TASK\` / \`cp_twotask\` | Dedicated instance alias (e.g., \`EBSPROD1\`, \`EBSPROD2\`) |
| Concurrent:PCP Instance Check | **ON** |

**How it works:** Each application node's concurrent managers connect to a specific database instance by name (via its Virtual IP or dedicated service). The ICM actively checks whether the target instance is alive before routing work to that node. When an instance goes down, the ICM detects the failure explicitly — the dedicated alias does not transparently reroute — and triggers the failover logic.

**TNS example (dedicated alias):**

\`\`\`
EBSPROD1 =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = rac-node1-vip.example.com)(PORT = 1521))
    (CONNECT_DATA =
      (SERVICE_NAME = EBSPROD)
      (INSTANCE_NAME = EBSPROD1)
    )
  )

EBSPROD2 =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = rac-node2-vip.example.com)(PORT = 1521))
    (CONNECT_DATA =
      (SERVICE_NAME = EBSPROD)
      (INSTANCE_NAME = EBSPROD2)
    )
  )
\`\`\`

**App-tier script configuration (\`adcmctl.sh\`):**

\`\`\`bash
# Node 1 app tier
export TWO_TASK=EBSPROD1

# Node 2 app tier
export TWO_TASK=EBSPROD2
\`\`\`

**When to use:** Environments where automatic request restart after node failure is mandatory. The ICM can unambiguously detect which instance went down and restart requests on the surviving node.

---

### Configuration Option 2: Load-Balanced / SCAN Routing

| Setting | Value |
|---------|-------|
| \`TWO_TASK\` / \`cp_twotask\` | SCAN or load-balanced alias |
| Concurrent:PCP Instance Check | **OFF** |

**How it works:** All concurrent manager connections go through the RAC SCAN listener. Oracle's connection load balancing distributes sessions across available instances. The EBS application layer does not attempt to verify which specific instance a manager is connected to — it defers that responsibility entirely to the Oracle Net layer.

**TNS example (SCAN alias):**

\`\`\`
DB_SCAN_LINK =
  (DESCRIPTION =
    (LOAD_BALANCE = ON)
    (FAILOVER = ON)
    (ADDRESS = (PROTOCOL = TCP)(HOST = your-scan-cluster.vcn.com)(PORT = 1521))
    (CONNECT_DATA =
      (SERVICE_NAME = ebs_service)
    )
  )
\`\`\`

**App-tier script configuration (\`adcmctl.sh\`):**

\`\`\`bash
# All nodes use the same SCAN alias
export TWO_TASK=DB_SCAN_LINK
\`\`\`

**When to use:** Cloud and engineered system environments where SCAN DNS is the standard connection method, and where connection load balancing is managed at the database tier. Simpler to administer — one TNS alias across all app nodes.

---

## The Golden Rule

> **Mixing a load-balanced SCAN alias (\`LOAD_BALANCE=ON\`) with \`Concurrent:PCP Instance Check = ON\` is an invalid state.**

When \`PCP Instance Check\` is \`ON\`, the ICM attempts to verify a specific backend database instance status before routing work. A SCAN alias resolves to whichever instance the listener chooses — the ICM cannot interrogate that specific instance check reliably through a load-balanced gateway. The result: managers stall, requests pile up, and failover appears to work until it catastrophically doesn't during a cascade failure test.

---

## Four Real-World Failure Scenarios

### Scenario 1: Managers Hang with "Target Node/Queue Unavailable"

**Symptom:** A RAC node crashes. Concurrent managers connected to that node display status **"Target node/queue unavailable"** in the CM Administration console. Requests stay in Running or Pending status and never shift to the surviving node.

**Root cause:** The environment was configured with a load-balanced SCAN TNS alias but had \`Concurrent:PCP Instance Check = ON\`. The ICM was attempting to verify the specific backend instance state through a load-balanced connection — which is architecturally impossible. The instance check logic broke down and left the manager in an unresolvable state.

**Diagnosis:**

\`\`\`sql
-- Check the current profile option setting
SELECT profile_option_value
FROM   fnd_profile_option_values  pov
JOIN   fnd_profile_options         po USING (profile_option_id)
WHERE  po.profile_option_name = 'CONC_PCP_INSTANCE_CHECK'
  AND  pov.level_id            = 10001;  -- Site level

-- Check the TWO_TASK currently in use by running managers
SELECT concurrent_queue_name,
       running_processes,
       max_processes,
       node_name
FROM   fnd_concurrent_queues
WHERE  running_processes > 0;
\`\`\`

**Fix:** Switch to Configuration Option 2. Keep the SCAN/load-balanced TNS alias. Set \`Concurrent:PCP Instance Check\` to **OFF** at Site level:

\`\`\`sql
-- As SYSADMIN: System Administrator → Profiles → System → CONC_PCP_INSTANCE_CHECK
-- Or via SQL (requires SYS access to update FND tables directly — use the UI in production)
\`\`\`

After changing the profile, bounce all concurrent managers:

\`\`\`bash
# As applmgr on each app node
$ADMIN_SCRIPTS_HOME/adcmctl.sh stop apps/<APPS_PWD>
sleep 30
$ADMIN_SCRIPTS_HOME/adcmctl.sh start apps/<APPS_PWD>
\`\`\`

---

### Scenario 2: reviver.sh Script Errors

**Symptom:** The Internal Concurrent Manager log contains these errors:

\`\`\`
reviver.sh: line 175: ]: command not found
reviver.sh: line 211: .../pids/appl/reviver.sh_...pid: No such file or directory
\`\`\`

The reviver process is responsible for monitoring concurrent manager processes and restarting them if they exit unexpectedly. When reviver.sh itself fails, managers that die do not get restarted automatically.

**Root cause — error at line 175:** A stray trailing \`]\` character in the script's shell test expression. This is typically introduced by a corrupted patch application or a manual edit error.

**Fix for line 175:**

\`\`\`bash
# View the problem area
sed -n '170,180p' $FND_TOP/bin/reviver.sh

# The error looks like:
# if [ "$VAR" = "value" ] ]   <-- extra ] at end
# Fix: remove the extra ]
\`\`\`

Edit the file and remove the stray \`]\` from line 175. After editing, verify the shell syntax is clean:

\`\`\`bash
bash -n $FND_TOP/bin/reviver.sh && echo "Syntax OK"
\`\`\`

**Root cause — error at line 211:** The \`$INST_TOP/pids/appl\` directory does not exist. reviver.sh writes its PID file to this path to track whether it is already running. If the directory is missing — which can happen after a clone, a fresh file system setup, or after an \`adcfgclone\` that did not fully create the runtime directory tree — the script fails before any monitoring begins.

**Fix for line 211:**

\`\`\`bash
# Create the missing directory
mkdir -p $INST_TOP/pids/appl
chown applmgr:dba $INST_TOP/pids/appl
chmod 755 $INST_TOP/pids/appl

# Verify the path resolves correctly
ls -la $INST_TOP/pids/appl/
\`\`\`

After both fixes, restart the ICM and verify the reviver process starts without errors:

\`\`\`bash
$ADMIN_SCRIPTS_HOME/adcmctl.sh start apps/<APPS_PWD>

# Check the ICM log for reviver errors
grep -i 'reviver' $APPLCSF/log/*/cm*.req | tail -30
\`\`\`

---

### Scenario 3: Failed Tasks Not Automatically Restarting

**Symptom:** Using Configuration Option 2 (SCAN + PCP Instance Check OFF). A RAC node drops. The concurrent requests that were running on that node terminate, but they do not restart on the surviving node. They remain in an error or incomplete status indefinitely.

**The ICM restart conditions:** The ICM will only automatically restart a failed request when **all** of the following are true:

1. The ICM successfully acquires the database lock previously held by the dead manager (PMON must have cleared the dead session's resources)
2. The request phase code is \`R\` (Running)
3. The concurrent program definition has **"Restart on Failure"** checked
4. **At least one of:**
   - The ICM itself is going through its initial startup sequence
   - The concurrent manager node itself went down (not just the DB session)
   - The specific database instance assigned to that node is down

**Why SCAN creates a gap:** With a SCAN alias, Oracle Net handles connection failover transparently at the network layer. From the EBS application layer's perspective, the connection did not explicitly die — it was rerouted. Condition 4c (specific database instance is down) is therefore not registered by the ICM, which means automatic restart logic may not fire for requests that were mid-execution during the network-layer failover.

**Fix options:**

| Requirement | Recommended Configuration |
|-------------|--------------------------|
| Automatic restart is critical | Switch to Option 1 (Dedicated Instance Routing + PCP Instance Check ON) |
| SCAN is required (cloud/OCI) | Accept manual restart for failed requests; use a monitoring job to detect and resubmit |
| Hybrid | Use dedicated service names (not SCAN) but with \`FAILOVER=ON\` for protection — not load balanced |

**Checking which requests need manual restart:**

\`\`\`sql
SELECT r.request_id,
       p.user_concurrent_program_name,
       r.phase_code,
       r.status_code,
       r.actual_start_date,
       r.actual_completion_date,
       r.node_name
FROM   fnd_concurrent_requests  r
JOIN   fnd_concurrent_programs_tl p
       ON  p.concurrent_program_id = r.concurrent_program_id
       AND p.language               = 'US'
WHERE  r.phase_code    = 'R'   -- Still marked Running
  AND  r.status_code   = 'R'
  AND  r.actual_start_date < SYSDATE - 1/24  -- Running for > 1 hour
ORDER BY r.actual_start_date;
\`\`\`

---

### Scenario 4: Pending Standby Lockup During Cascade Failover Test

**Symptom:** During a two-node failover test:

1. Node 2 is aborted → concurrent managers recover correctly ✓
2. Node 2 is brought back up → normal ✓
3. Node 1 is then aborted → requests suddenly pile up in **"Pending Standby"** for 60+ minutes

The queue only flushes after a manual hard stop and restart of all concurrent managers via \`adcmctl.sh\`.

**Root cause:** This is the SCAN + \`PCP Instance Check = ON\` mismatch in cascade form. After step 2 (node 2 returns), the ICM re-establishes connections through the SCAN listener. When node 1 is then aborted in step 3, the application tier attempts to check the specific instance state that the load-balanced connection was previously routing to — but the SCAN listener has already rerouted those connections. The ICM cannot reconcile the instance check result with the current connection state and enters a wait loop, placing requests into "Pending Standby" until the state machine is reset by a manager restart.

**Fix:**

\`\`\`sql
-- Verify profile option — must be OFF when using SCAN
SELECT profile_option_value
FROM   fnd_profile_option_values  pov
JOIN   fnd_profile_options         po USING (profile_option_id)
WHERE  po.profile_option_name = 'CONC_PCP_INSTANCE_CHECK'
  AND  pov.level_id            = 10001;

-- Expected: 'N' or null when OFF
\`\`\`

The fix is to set \`Concurrent:PCP Instance Check\` to **OFF** before production deployment — not after discovering the issue during a cascade failure in production.

---

## Summary and Best Practices

### Configuration Decision Matrix

| TNS Alias Type | PCP Instance Check | Result |
|---------------|-------------------|--------|
| Dedicated VIP (\`INSTANCE_NAME\` specified) | ON | Valid — Option 1 |
| SCAN / \`LOAD_BALANCE=ON\` | OFF | Valid — Option 2 |
| SCAN / \`LOAD_BALANCE=ON\` | ON | **INVALID — causes all four failures above** |
| Dedicated VIP | OFF | Technically works but loses restart detection precision |

### Pre-Production Deployment Checklist

\`\`\`
[ ] Identify TNS alias type: dedicated VIP or SCAN load-balanced?
[ ] If SCAN: confirm Concurrent:PCP Instance Check = OFF at Site level
[ ] If Dedicated: confirm Concurrent:PCP Instance Check = ON, one alias per node
[ ] Inspect adcmctl.sh on each app node: TWO_TASK variable matches intended alias
[ ] Verify $INST_TOP/pids/appl directory exists on ALL app nodes
[ ] Validate reviver.sh syntax: bash -n $FND_TOP/bin/reviver.sh
[ ] Check concurrent program definitions: "Restart on Failure" enabled where needed
[ ] Run cascade failover test in non-production before production migration
\`\`\`

### Best Practices

1. **Choose one configuration and enforce it consistently.** Mixed environments — where some app nodes use dedicated aliases and others use SCAN — produce race conditions during failover that are nearly impossible to reproduce in non-production.

2. **Document the TWO_TASK value for every app node.** The value in \`adcmctl.sh\` is the runtime truth. Profile options are consulted per-connection. If they do not agree, the ICM behaves unpredictably.

3. **Run the cascade failover test before every production configuration change.** A single-node failover test (abort node 1, verify recovery) is not sufficient. The cascade scenario (abort node 2, restore node 2, abort node 1) reliably exposes SCAN + PCP Instance Check mismatches that single-node tests miss.

4. **Monitor the ICM log for reviver.sh errors after every clone or file system refresh.** The \`$INST_TOP/pids/appl\` directory is routinely missing after \`adcfgclone\` runs that do not fully complete the runtime directory tree.

5. **If using SCAN and automatic request restart is required, use a compensation monitor job.** Oracle's ICM will not always restart SCAN-transparent failover victims. A scheduled job that detects requests stuck in \`phase_code = 'R'\` beyond a threshold and resubmits them provides the safety net.

The companion runbook covers the complete configuration procedure for both options, the exact profile option navigation path, \`adcmctl.sh\` variable verification, reviver.sh repair steps, and a monitoring script that continuously checks for the failure patterns described in this post.`,
};

async function main() {
  console.log('Inserting EBS PCP RAC blog post...');
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
