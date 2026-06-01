import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Patching Oracle Fusion Middleware 12c',
  slug: 'fusion-middleware-patching-runbook',
  excerpt:
    'Complete patching runbook for Oracle Fusion Middleware 12c (12.2.1.4) — patch types, OPatch upgrade, conflict analysis, Oracle Home patching, schema updates via Upgrade Assistant, cluster rolling patch strategy, verification, and rollback.',
  category: 'fusion-middleware' as const,
  published: true,
  publishedAt: new Date('2026-05-31'),
  youtubeUrl: null,
  content: `Oracle releases Fusion Middleware patches quarterly as Release Updates (RUs) and continuously as one-off patches for individual bugs. Keeping FMW current is mandatory for security compliance and is required before Oracle Support will assist with most escalations. This runbook covers the end-to-end patching process for a 12.2.1.4 Oracle Home hosting WebLogic Server, SOA Suite, or Oracle Service Bus — from pre-patch preparation through post-patch verification and rollback.

---

## Patch Types and Release Schedule

| Patch type | Cadence | Description |
|---|---|---|
| **Release Update (RU)** | Quarterly (Jan, Apr, Jul, Oct) | Cumulative bundle — includes all prior RUs plus new fixes. Apply the latest RU rather than stacking individual patches. |
| **Release Update Revision (RUR)** | Between RUs | Targeted subset of fixes on top of an RU for specific critical issues |
| **One-off patch** | Continuous | Single bug fix not yet included in an RU. Always check if the fix is in the next RU before applying one-offs. |
| **Merge patch** | On request | Multiple one-off patches combined into a single OPatch artifact to resolve conflicts between individual patches |
| **Security Alert (Alert)** | As needed | Out-of-cycle security fix for a critical vulnerability. Apply immediately regardless of patching schedule. |

**Oracle Support search path for latest RU:**
MOS > Patches & Updates > search for product **Oracle Fusion Middleware 12.2.1.4.0**, release **12.2.1.4.0**, platform **Linux x86-64**, type **Patch Set Update/Release Update**.

---

## Environment Reference

| Item | Value |
|---|---|
| Oracle Home | \`/u01/app/oracle/product/fmw/infra\` |
| Domain Home | \`/u01/app/oracle/config/domains/soa_domain\` |
| OPatch location | \`/u01/app/oracle/product/fmw/infra/OPatch\` |
| Patch staging | \`/u01/patches\` |
| Backup location | \`/u01/backup\` |
| OS user | \`oracle\` |
| DB service | \`fmwdb.example.com:1521/FMWDB\` |

---

## Pre-Patch Preparation

### Step 1 — Identify installed patches and current RU level

\`\`\`bash
# Full patch inventory
/u01/app/oracle/product/fmw/infra/OPatch/opatch lsinventory

# Summary of applied patches (patch number + description only)
/u01/app/oracle/product/fmw/infra/OPatch/opatch lspatches

# Check OPatch version (must be 13.9.4.2.2 or later for FMW 12.2.1.4)
/u01/app/oracle/product/fmw/infra/OPatch/opatch version
\`\`\`

Record the current patch level. The highest-numbered RU in the \`lspatches\` output is the installed RU baseline.

### Step 2 — Identify the target patch

1. Log in to My Oracle Support (MOS)
2. Search for the current quarterly RU for your product (Infrastructure, SOA Suite, OSB)
3. Download the patch ZIP and its README
4. **Always read the README before applying** — note any special pre/post steps, prerequisites, and whether a schema upgrade is required

### Step 3 — Check OPatch version requirement

Each patch README specifies a minimum OPatch version. If the installed OPatch is below the minimum:

\`\`\`bash
# Upgrade OPatch (download p6880880_122140_Linux-x86-64.zip from MOS)
cd /u01/app/oracle/product/fmw/infra
mv OPatch OPatch.bak.\$(date +%Y%m%d)
unzip /u01/patches/p6880880_122140_Linux-x86-64.zip
/u01/app/oracle/product/fmw/infra/OPatch/opatch version
\`\`\`

### Step 4 — Stage the patch

\`\`\`bash
mkdir -p /u01/patches
cp /path/to/download/p<PATCH_ID>_122140_Generic.zip /u01/patches/
cd /u01/patches
unzip p<PATCH_ID>_122140_Generic.zip
ls /u01/patches/<PATCH_ID>/
# Should contain: README.txt  files/  etc/
\`\`\`

### Step 5 — Conflict check

Always run the conflict check before applying. A conflict means two patches modify the same file with incompatible changes — applying without resolving conflicts corrupts the Oracle Home.

\`\`\`bash
/u01/app/oracle/product/fmw/infra/OPatch/opatch prereq \\
  CheckConflictAgainstOHWithDetail \\
  -ph /u01/patches/<PATCH_ID>
\`\`\`

Possible outcomes:

- **OPatch succeeded** — no conflicts, safe to proceed
- **Conflict with patch XXXXXXX** — contact Oracle Support for a merge patch that combines the conflicting patches

### Step 6 — Backup the Oracle Home

\`\`\`bash
mkdir -p /u01/backup
tar -czf /u01/backup/fmw_infra_OH_\$(date +%Y%m%d_%H%M).tar.gz \\
  -C /u01/app/oracle/product/fmw infra

# Verify archive integrity
tar -tzf /u01/backup/fmw_infra_OH_*.tar.gz | tail -5

# Also export current OPatch inventory for reference
/u01/app/oracle/product/fmw/infra/OPatch/opatch lsinventory \\
  > /u01/backup/opatch_lsinventory_before_\$(date +%Y%m%d).txt
\`\`\`

### Step 7 — Backup the RCU schemas (if patch includes schema changes)

Check the README for lines like "This patch requires a schema upgrade" or "Run the Upgrade Assistant after applying this patch."

If schema changes are included:

\`\`\`bash
# Export relevant schemas using DataPump (as oracle DBA user or sysdba)
expdp system/<password>@FMWDB \\
  SCHEMAS=FMW_SOAINFRA,FMW_MDS,FMW_OPSS \\
  DIRECTORY=DATA_PUMP_DIR \\
  DUMPFILE=fmw_schemas_\$(date +%Y%m%d).dmp \\
  LOGFILE=fmw_schemas_export_\$(date +%Y%m%d).log
\`\`\`

---

## Applying the Patch

### Step 8 — Stop all servers in the Oracle Home

Stop in reverse startup order — managed servers first, then AdminServer, then Node Manager last.

\`\`\`bash
# Connect via WLST to gracefully stop managed servers
/u01/app/oracle/product/fmw/infra/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<password>','t3://localhost:7001')
shutdown('soa_server1', 'Server', ignoreSessions=true, force=true)
shutdown('AdminServer', 'Server', ignoreSessions=true, force=true)
exit()
EOF

# Stop Node Manager
kill \$(cat /u01/app/oracle/config/domains/soa_domain/nodemanager/nodemanager.pid)

# Verify no WLS processes remain
ps -ef | grep -i weblogic | grep -v grep
\`\`\`

### Step 9 — Apply the patch

\`\`\`bash
/u01/app/oracle/product/fmw/infra/OPatch/opatch apply \\
  /u01/patches/<PATCH_ID>
\`\`\`

OPatch will:
1. Validate the patch against the Oracle Home inventory
2. Back up files it will overwrite (stored in \`OPatch/.patch_storage\`)
3. Copy new/modified files into the Oracle Home
4. Update the inventory

Respond **y** to any prompts about updating the inventory.

Successful output ends with:
\`\`\`
OPatch succeeded.
\`\`\`

If applying multiple patches in sequence (e.g., an OPatch upgrade + RU + one-off), apply them in the order specified in the README.

### Step 10 — Verify patch applied to Oracle Home

\`\`\`bash
/u01/app/oracle/product/fmw/infra/OPatch/opatch lspatches | grep <PATCH_ID>
# Should show the patch number and description
\`\`\`

---

## Post-Patch Schema Update (if required)

Some RUs include changes to the MDS, SOAINFRA, OPSS, or other RCU schemas. The patch README will state whether a schema upgrade is needed. There are two mechanisms.

### Option A: Upgrade Assistant (UA)

The Upgrade Assistant is the standard tool for schema-level changes in 12.2.1.4.

\`\`\`bash
# Launch the Upgrade Assistant
/u01/app/oracle/product/fmw/infra/oracle_common/upgrade/bin/ua
\`\`\`

In the UA wizard:

1. **All Schemas Used by a Domain** — select this option and point to the domain home
2. **Component List** — UA will auto-detect all schemas used by the domain. Verify the detected schemas match the RCU prefix (e.g., FMW_SOAINFRA, FMW_MDS)
3. **Prerequisites** — confirm all prerequisites pass
4. **Examine** — UA examines current schema versions against the target version
5. **Upgrade** — if schemas are at an older version, UA upgrades them
6. **Summary and results** — review and confirm all schemas upgraded successfully

UA logs are written to:
\`\`\`
/u01/app/oracle/product/fmw/infra/oracle_common/upgrade/logs/
\`\`\`

### Option B: WLST \`updateMatches\` script (minor schema updates)

For minor patch schema updates Oracle sometimes ships a WLST script:

\`\`\`bash
# Check README for WLST post-patch instructions
grep -A10 "WLST\\|post.install\\|updateMatch" /u01/patches/<PATCH_ID>/README.txt

# If a script is specified, run it:
/u01/app/oracle/product/fmw/infra/oracle_common/common/bin/wlst.sh \\
  /u01/patches/<PATCH_ID>/post_install.py \\
  <domain_home>
\`\`\`

### Verify schema versions after upgrade

\`\`\`sql
-- Check MDS schema version
SELECT comp_name, version, status
FROM schema_version_registry
WHERE comp_name IN ('MDS','SOAINFRA','OPSS','IAU','STB','UMS')
ORDER BY comp_name;

-- All should show STATUS = 'VALID' and version matching the target RU
\`\`\`

---

## Start Servers and Verify

### Step 11 — Start servers in order

\`\`\`bash
# 1. Start Node Manager
nohup /u01/app/oracle/config/domains/soa_domain/bin/startNodeManager.sh \\
  > /u01/app/oracle/config/domains/soa_domain/nodemanager/nodemanager.out 2>&1 &

# 2. Start AdminServer
nohup /u01/app/oracle/config/domains/soa_domain/bin/startWebLogic.sh \\
  > /u01/app/oracle/config/domains/soa_domain/servers/AdminServer/logs/AdminServer.out 2>&1 &

# Wait for AdminServer RUNNING
tail -f /u01/app/oracle/config/domains/soa_domain/servers/AdminServer/logs/AdminServer.out

# 3. Start managed servers via WLST
/u01/app/oracle/product/fmw/infra/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<password>','t3://localhost:7001')
nm()
nmStart('soa_server1')
exit()
EOF

tail -f /u01/app/oracle/config/domains/soa_domain/servers/soa_server1/logs/soa_server1.log
\`\`\`

### Step 12 — Post-patch verification

\`\`\`bash
# 1. Confirm patch is present in Oracle Home
opatch lspatches | grep <PATCH_ID>

# 2. Confirm WebLogic version reports correctly
java -cp /u01/app/oracle/product/fmw/infra/wlserver/server/lib/weblogic.jar \\
  weblogic.version

# 3. Confirm no ERROR or FATAL lines in server logs at startup
grep -E "ERROR|FATAL|Exception" \\
  /u01/app/oracle/config/domains/soa_domain/servers/soa_server1/logs/soa_server1.log \\
  | grep -v "^#" | tail -20

# 4. Confirm SOA Infrastructure is running (if SOA Suite domain)
curl -s -o /dev/null -w "%{http_code}" \\
  -u weblogic:<password> http://localhost:8001/soa-infra/
# Expected: 200

# 5. Confirm EM FMW Control loads
curl -s -o /dev/null -w "%{http_code}" \\
  http://localhost:7001/em
# Expected: 200 or 302
\`\`\`

### Step 13 — Update patch inventory log

\`\`\`bash
# Record post-patch state for comparison
/u01/app/oracle/product/fmw/infra/OPatch/opatch lspatches \\
  > /u01/backup/opatch_lsinventory_after_\$(date +%Y%m%d).txt

# Diff before and after to confirm the new patch is the only change
diff /u01/backup/opatch_lsinventory_before_*.txt \\
     /u01/backup/opatch_lsinventory_after_*.txt
\`\`\`

---

## Cluster / HA Rolling Patch Strategy

In clustered environments (multiple managed servers across multiple hosts), patches should be applied with zero-downtime using a rolling approach:

### Rolling patch prerequisites

- All nodes must run the same OS and JDK version
- Load balancer must be capable of draining sessions from individual nodes
- Cluster must be fully operational (all nodes RUNNING) before starting a rolling patch

### Rolling patch sequence

\`\`\`
Node 1 (active)  ──────────────────────────────▶ patched, restarted, back in rotation
Node 2 (active)  ─────────────▶ drained, patched, restarted, back in rotation
\`\`\`

1. **Drain Node 2 from load balancer** — set Node 2's managed servers to ADMIN or SUSPENDED mode so no new sessions are routed there
2. **Stop managed servers on Node 2** gracefully
3. **Apply patch to Node 2 Oracle Home**
4. **Run schema upgrade (if needed)** — run UA only once, from any node, against the shared DB schemas
5. **Start managed servers on Node 2**, verify RUNNING
6. **Re-add Node 2 to load balancer rotation**
7. **Repeat for Node 1**

AdminServer is typically on a dedicated node and patched last, during a brief maintenance window.

### Using \`opatchauto\` for automated cluster patching

For SOA Suite environments, Oracle recommends \`opatchauto\` which handles stopping/starting managed servers automatically:

\`\`\`bash
# opatchauto requires the patch to be a supported type (RU or opatchauto-enabled bundle)
# Run as root or with sudo

/u01/app/oracle/product/fmw/infra/OPatch/opatchauto apply \\
  /u01/patches/<PATCH_ID> \\
  -oh /u01/app/oracle/product/fmw/infra \\
  -walletDir /u01/app/oracle/config/domains/soa_domain/config/fmwconfig/jceks \\
  -invPtrLoc /u01/app/oraInventory/oraInst.loc

# opatchauto log
cat /u01/app/oracle/product/fmw/infra/cfgtoollogs/opatchauto/opatchauto_<timestamp>.log
\`\`\`

Not all patches support \`opatchauto\` — check the README. For patches that do not, use the manual procedure.

---

## Applying Multiple Patches (Merge Scenario)

When multiple one-off patches are needed simultaneously and they conflict with each other, request a merge patch from Oracle Support. If they do not conflict, apply them sequentially:

\`\`\`bash
# Check combined conflict across all patches at once
/u01/app/oracle/product/fmw/infra/OPatch/opatch prereq \\
  CheckConflictAgainstOHWithDetail \\
  -ph /u01/patches/<PATCH_A>,/u01/patches/<PATCH_B>

# Apply in the order specified in each README
opatch apply /u01/patches/<PATCH_A>
opatch apply /u01/patches/<PATCH_B>
\`\`\`

For RU + one-off scenarios: apply the RU first, then the one-off on top. If the one-off is already included in the RU, OPatch will report it as already applied.

---

## Rollback

### Option A: \`opatch rollback\` (preferred)

OPatch stores the original files before overwriting them in \`OPatch/.patch_storage/<PATCH_ID>/\`. Rollback restores those files.

\`\`\`bash
# All servers must be stopped before rollback
# Stop servers (same as Step 8)

# Roll back the patch
/u01/app/oracle/product/fmw/infra/OPatch/opatch rollback -id <PATCH_ID>

# Verify patch is no longer listed
opatch lspatches | grep <PATCH_ID>
# Should return no output

# Restart servers
\`\`\`

### Option B: Oracle Home restore from backup

If \`opatch rollback\` fails or the \`.patch_storage\` directory was deleted:

\`\`\`bash
# Stop all servers

# Remove the patched Oracle Home
rm -rf /u01/app/oracle/product/fmw/infra

# Restore from backup
tar -xzf /u01/backup/fmw_infra_OH_<date>.tar.gz -C /u01/app/oracle/product/fmw/

# Verify restored inventory
opatch lspatches

# Restart servers
\`\`\`

### Rolling back schema changes

If the patch included schema changes and UA was run, schema rollback requires restoring the DataPump backup taken in the pre-patch step. This is a significant operation — coordinate with affected teams before proceeding.

\`\`\`bash
# Stop servers
# Drop and recreate schemas from DataPump backup
impdp system/<password>@FMWDB \\
  SCHEMAS=FMW_SOAINFRA,FMW_MDS,FMW_OPSS \\
  DIRECTORY=DATA_PUMP_DIR \\
  DUMPFILE=fmw_schemas_<date>.dmp \\
  TABLE_EXISTS_ACTION=REPLACE \\
  LOGFILE=fmw_schemas_import_\$(date +%Y%m%d).log
\`\`\`

---

## Troubleshooting

### OPatch fails — "Inventory lock could not be acquired"

\`\`\`bash
# Check for stale lock
ls -la /u01/app/oraInventory/.oracle_lock
lsof /u01/app/oraInventory/.oracle_lock

# If no process holds it, remove the stale lock
rm /u01/app/oraInventory/.oracle_lock
\`\`\`

### OPatch fails — "No such file or directory" on a patch file

The patch ZIP was not fully extracted or was corrupted. Re-download from MOS and verify:

\`\`\`bash
unzip -t /u01/patches/p<PATCH_ID>_122140_Generic.zip
# All files should show "OK"
\`\`\`

### Managed server fails to start after patch — ClassNotFoundException

A JAR that the application depends on was modified by the patch and the deployment cache is stale. Clear the server's tmp and cache directories:

\`\`\`bash
rm -rf /u01/app/oracle/config/domains/soa_domain/servers/soa_server1/tmp
rm -rf /u01/app/oracle/config/domains/soa_domain/servers/soa_server1/cache
\`\`\`

Restart the managed server. WebLogic rebuilds the deployment cache on next startup.

### Schema version mismatch after patch — \`SOAINFRA\` shows INVALID

UA was not run or failed partway through. Re-run the Upgrade Assistant:

\`\`\`bash
/u01/app/oracle/product/fmw/infra/oracle_common/upgrade/bin/ua
\`\`\`

If UA fails, check its log at \`oracle_common/upgrade/logs/\` for the specific SQL statement that failed, and resolve the DB-level error before re-running.

### OPatch reports patch already applied but behavior suggests it is not

The inventory was updated but the files were not — this can happen if OPatch was interrupted mid-apply. Run:

\`\`\`bash
opatch lsinventory -bugs_fixed | grep <bug_number>
\`\`\`

If the bug is not listed, roll back and re-apply cleanly.

---

## Patching Quick Reference

\`\`\`bash
# Current patch inventory
opatch lspatches

# Detailed inventory with bug numbers
opatch lsinventory -detail

# Conflict check before applying
opatch prereq CheckConflictAgainstOHWithDetail -ph /u01/patches/<PATCH_ID>

# Apply a patch (servers must be down)
opatch apply /u01/patches/<PATCH_ID>

# Roll back a patch (servers must be down)
opatch rollback -id <PATCH_ID>

# Upgrade OPatch utility
mv OPatch OPatch.bak && unzip p6880880_122140_Linux-x86-64.zip

# Run Upgrade Assistant for schema changes
oracle_common/upgrade/bin/ua

# Verify schema versions in DB
# SELECT comp_name, version, status FROM schema_version_registry;
\`\`\`

---

## Patching Checklist

- [ ] Current OPatch inventory exported to \`/u01/backup/opatch_lsinventory_before_<date>.txt\`
- [ ] OPatch version meets patch minimum requirement
- [ ] Patch README read in full — pre/post steps, schema change requirement noted
- [ ] Conflict check passed with no conflicts
- [ ] Oracle Home backup archived to \`/u01/backup/\`
- [ ] RCU schema DataPump export completed (if patch includes schema changes)
- [ ] All managed servers stopped gracefully
- [ ] AdminServer stopped
- [ ] Node Manager stopped
- [ ] Patch applied — OPatch reports "OPatch succeeded"
- [ ] New patch visible in \`opatch lspatches\`
- [ ] Upgrade Assistant run and all schemas show VALID (if schema changes required)
- [ ] Servers started in order: Node Manager → AdminServer → managed servers
- [ ] No ERROR/FATAL lines in server logs at startup
- [ ] Application endpoints return 200
- [ ] Post-patch OPatch inventory exported and diff verified`,
};

async function main() {
  console.log('Inserting FMW patching runbook...');
  await db.insert(posts).values(post).onConflictDoNothing();
  console.log(`Inserted: "${post.title}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
