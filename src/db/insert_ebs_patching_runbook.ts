import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle EBS Patching — End-to-End Patch Cycle Execution',
  slug: 'ebs-patching-end-to-end-runbook',
  excerpt:
    'Step-by-step operational runbook for planning, downloading, testing, and applying Oracle EBS patches — covering AD-TXK prerequisites, adop phases, AutoConfig, post-patch validation, and rollback procedures.',
  category: 'ebs-suite' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-22'),
  youtubeUrl: null,
  content: `This runbook provides the end-to-end procedure for applying Oracle EBS patches using adop. Assumptions: Oracle EBS R12.2.x with dual file system configured, Oracle Database 12.2 or later, Oracle MOS access for patch download, adop utility available on application server, change management process in place.

---

## Phase 0: Prerequisites and Environment Health

### Step 0.1 — Check adop Version

\`\`\`bash
# Source EBS environment
. /u01/oracle/EBSapps.env run

# Check adop version
adop -version
# Example output: adop version 12.2.0.x.y
\`\`\`

### Step 0.2 — Check AD-TXK Level

\`\`\`bash
cat $AD_TOP/patch/115/version.txt
# Note the current AD-TXK level
# Compare to the minimum AD-TXK version required in the target patch README
\`\`\`

If the current AD-TXK level is below the minimum required: apply the AD-TXK delta first (same adop procedure as any other patch), then apply the main patch.

### Step 0.3 — Verify No Pending adop Phase

\`\`\`bash
# Check adop status — must be NONE or COMPLETED before starting a new cycle
adop phase=status

# Expected output for a clean state:
# Current Phase : None
# Current Status: No Patch Cycle In Progress
\`\`\`

If a prior adop cycle is in an incomplete state (e.g., APPLY phase started but not finalized): investigate the prior cycle before starting a new one. Do not start a new cycle over an incomplete one.

### Step 0.4 — Verify Concurrent Manager Health

\`\`\`sql
-- No requests stuck in Running state for > 4 hours
SELECT request_id, concurrent_program_name,
       ROUND((SYSDATE - actual_start_date) * 24, 1) hours_running
FROM applsys.fnd_concurrent_requests fcr
JOIN applsys.fnd_concurrent_programs cp
  ON fcr.concurrent_program_id = cp.concurrent_program_id
  AND fcr.program_application_id = cp.application_id
WHERE fcr.phase_code = 'R'
  AND (SYSDATE - fcr.actual_start_date) > 4/24
ORDER BY hours_running DESC;
-- Expected: no rows
\`\`\`

### Step 0.5 — Check Disk Space

\`\`\`bash
# Check free space on critical file systems
df -h /u01/oracle/fs1 /u01/oracle/fs2 /u01/oracle/inst
# fs1 and fs2: need minimum 20 GB free each
# inst: need minimum 10 GB free for patch staging

# Check DB data and temp tablespace space
sqlplus / as sysdba <<'EOF'
SELECT tablespace_name,
       ROUND(SUM(bytes)/1024/1024/1024, 2) total_gb,
       ROUND(SUM(CASE WHEN autoextensible = 'YES' THEN maxbytes - bytes ELSE 0 END)/1024/1024/1024, 2) headroom_gb
FROM dba_data_files
WHERE tablespace_name IN ('SYSTEM', 'SYSAUX', 'APPS_TS_TX_DATA', 'APPS_TS_TX_IDX')
GROUP BY tablespace_name;
EXIT
EOF
\`\`\`

### Step 0.6 — Take Pre-Patch RMAN Backup

This backup is your rollback safety net. It is mandatory, not optional.

\`\`\`bash
rman target / <<'EOF'
BACKUP DATABASE PLUS ARCHIVELOG TAG 'PRE_PATCH_$(date +%Y%m%d)' DELETE INPUT;
LIST BACKUP TAG 'PRE_PATCH_$(date +%Y%m%d)';
EOF
# Verify backup completed with no failures before proceeding
\`\`\`

---

## Phase 1: Patch Download and Preparation

### Step 1.1 — Download Patch from Oracle MOS

1. Navigate to: https://support.oracle.com → Patches & Updates
2. Search by patch number (e.g., enter the RUP patch number)
3. Select platform: **Linux x86-64**
4. Download to patch staging directory: \`/u01/oracle/patches/\`

### Step 1.2 — Verify Patch Checksum

\`\`\`bash
# Verify MD5 checksum matches the MOS download page
md5sum /u01/oracle/patches/p<patch_number>_R12.EBSATG_GENERIC.zip
# Compare output to the checksum shown on the MOS patch page
\`\`\`

### Step 1.3 — Unzip Patch

\`\`\`bash
cd /u01/oracle/patches/
unzip p<patch_number>_R12.EBSATG_GENERIC.zip
ls -la <patch_number>/  # Verify README.txt and files/ subdirectory present
\`\`\`

### Step 1.4 — Read the Patch README

\`\`\`bash
less /u01/oracle/patches/<patch_number>/README.txt
\`\`\`

Record from the README:
- Minimum AD-TXK level required
- Minimum Oracle Database version required
- Prerequisite patches (apply these before the main patch)
- Post-installation instructions (SQL scripts to run, profile options to set)
- Known issues and workarounds

### Step 1.5 — Run OPatch Conflict Check for One-Off Patches

For one-off patches (not RUPs):

\`\`\`bash
cd /u01/oracle/patches/<patch_number>
$ORACLE_HOME/OPatch/opatch prereq CheckConflictAgainstOHWithDetail -ph .

# Expected: No conflicts detected
# If conflicts found: resolve before applying (see strategy blog for resolution options)
\`\`\`

---

## Phase 2: Apply to DEV (First Non-Production Environment)

### Step 2.1 — Log in to DEV Application Server

\`\`\`bash
ssh applmgr@dev-ebs-app-01
. /u01/oracle/EBSapps.env run
echo $TWO_TASK   # Verify pointing to DEV DB
echo $CONTEXT_FILE  # Verify correct context file for DEV
\`\`\`

### Step 2.2 — adop prepare

\`\`\`bash
adop phase=prepare

# Monitor: $APPLRGF/adop/adop_<pid>.log
tail -f $APPLRGF/adop/adop_$(ls -t $APPLRGF/adop/ | head -1)

# Expected completion: "prepare phase completed successfully"
# Duration: 20–45 minutes
\`\`\`

### Step 2.3 — adop apply

\`\`\`bash
# For a single one-off patch:
adop phase=apply patches=<patch_number> patching_mode=online

# For a RUP (larger — use nohup to prevent SSH session timeout):
nohup adop phase=apply patches=<rup_patch_number> patching_mode=online \
  workers=8 > /tmp/adop_apply_$(date +%Y%m%d).log 2>&1 &

# Monitor progress:
tail -f /tmp/adop_apply_$(date +%Y%m%d).log
tail -f $APPLRGF/adop/adop_*.log | grep -E "ERROR|WARNING|Phase|Complete"
\`\`\`

### Step 2.4 — adop finalize

\`\`\`bash
adop phase=finalize
# Duration: 30–60 minutes
# Expected: "finalize phase completed successfully"
\`\`\`

### Step 2.5 — adop cutover (DEV Maintenance Window)

\`\`\`bash
# Set maintenance mode (redirects users to maintenance page)
adop phase=cutover

# adop will prompt: "Cutover will bring down the application. Continue? [y/n]"
# Enter: y

# Duration: 10–30 minutes
# Expected: "cutover phase completed successfully"
# Verify new file system is active:
cat $INST_TOP/appl/admin/adovars.env | grep s_ebsndir
# Should now point to the previously-fs2 path
\`\`\`

### Step 2.6 — Run AutoConfig on All Tiers

\`\`\`bash
# Application tier (run from applmgr)
cd $AD_TOP/bin
perl adautocfg.pl appspass=<apps_password>
# Expected: "AutoConfig is exiting with status 0"

# Database tier (run from oracle user on DB server)
cd $ORACLE_HOME/appsutil/bin
perl adautocfg.pl appspass=<apps_password>
\`\`\`

### Step 2.7 — Restart EBS Services

\`\`\`bash
# Stop all services
$ADMIN_SCRIPTS_HOME/adstopall.sh apps/<apps_password>

# Start all services
$ADMIN_SCRIPTS_HOME/adstrtal.sh apps/<apps_password>

# Verify services started
$ADMIN_SCRIPTS_HOME/adapcctl.sh status
$ADMIN_SCRIPTS_HOME/adcmctl.sh status
\`\`\`

### Step 2.8 — Run Post-Install Steps from README

Apply any SQL scripts or profile option changes listed in the patch README:

\`\`\`bash
sqlplus apps/<apps_password> @/u01/oracle/patches/<patch_number>/files/post_install.sql
\`\`\`

### Step 2.9 — adop cleanup

\`\`\`bash
# Run cleanup to free disk space from old fs (safe to run after successful cutover)
adop phase=cleanup
# Duration: varies 30 min to 2 hours — can run during business hours (non-disruptive)
\`\`\`

---

## Phase 3: DEV Functional Validation

### Step 3.1 — Check for INVALID Database Objects

\`\`\`sql
-- Any newly INVALID objects post-patch?
SELECT owner, object_type, COUNT(*) invalid_count
FROM dba_objects
WHERE status = 'INVALID'
  AND owner NOT IN ('SYS', 'SYSTEM', 'DBSNMP', 'OUTLN')
GROUP BY owner, object_type
ORDER BY owner, invalid_count DESC;

-- Recompile INVALID objects if found
EXEC UTL_RECOMP.RECOMP_PARALLEL(4);
\`\`\`

### Step 3.2 — Functional Test Checklist

For each item: execute in EBS DEV, verify results match expected baseline.

| Test | Module | Expected Result |
|------|--------|----------------|
| Create and post GL journal | GL | Journal posts; trial balance updates |
| Create AP invoice, validate | AP | Invoice validates; accounting entries correct |
| Run AutoInvoice | AR | Invoices created; no interface errors |
| Run GL Transfer (from AR) | AR/GL | Journals transferred; no errors |
| Run concurrent program X (your critical program) | varies | Completes in normal duration |
| Check Concurrent Manager status | SysAdmin | ICM running; no stuck requests |
| Verify key custom concurrent programs compile | custom | No INVALID status for custom packages |

### Step 3.3 — Review Oracle Alert Log

\`\`\`bash
# Check for new ORA- errors in alert log since patch cutover
grep -E "ORA-|Error|error" $ORACLE_BASE/diag/rdbms/$ORACLE_SID/$ORACLE_SID/trace/alert_$ORACLE_SID.log \
  | tail -100
# Compare against pre-patch baseline — new ORA- errors must be investigated
\`\`\`

### Step 3.4 — DEV Sign-Off

Document DEV validation results in the change management ticket. Obtain sign-off from the functional lead before promoting to UAT.

---

## Phase 4: Promote to UAT

Repeat Phase 2 (Steps 2.1–2.9) on the UAT application server and database.

UAT validation is more thorough than DEV:
- Run the full functional test script with business users, not just the DBA team
- Duration: 1–2 weeks for a RUP, 1–3 days for a one-off
- UAT sign-off required from business owner before Production

---

## Phase 5: Production Deployment

### Step 5.1 — Pre-Production Checklist

| Item | Verified |
|------|---------|
| DEV validation signed off | ☐ |
| UAT validation signed off by business owner | ☐ |
| Change management ticket approved | ☐ |
| Maintenance window communicated to all users (72h notice minimum) | ☐ |
| RMAN backup completed and verified (Step 0.6) | ☐ |
| Rollback procedure documented and DBA on standby | ☐ |
| Oracle Support SR open (for SR-driven patches) | ☐ |

### Step 5.2 — Execute adop Phases on Production

Execute Steps 2.1–2.9 on the production application server.

**Critical difference for production cutover:**
- Set a specific maintenance window start/end time
- Notify users 15 minutes before cutover begins
- Have a DBA and a functional lead available during cutover
- Have the RMAN restore procedure ready (printed or accessible offline)

### Step 5.3 — Production Post-Patch Validation

Execute the same functional test checklist as DEV (Step 3.2), but on production with real data:

\`\`\`bash
# Verify the application is responding on production URL
curl -I https://ebs-prod.company.com/OA_HTML/AppsLocalLogin.jsp
# Expected: HTTP 200 or 302 (redirect to login)

# Check Concurrent Manager workers are available
# Navigate: System Administrator > Concurrent > Manager > Administer
# Verify: Standard Manager shows Active workers = configured capacity
\`\`\`

### Step 5.4 — Close Change Management

Document:
- Patch applied (number, date, time)
- Pre/post validation results
- Any issues encountered and resolution
- New patch level (adop version, AD-TXK level, RUP level)

---

## Phase 6: Rollback Procedures

### Rollback Option A: During apply Phase (Before Cutover) — Low Risk

\`\`\`bash
# If apply phase failed or produced unacceptable results in DEV/UAT:
adop phase=rollback

# This reverses the apply phase on fs2 without touching the running application on fs1
# Duration: 30–90 minutes
# Expected: "rollback phase completed successfully"
# After rollback: adop phase=cleanup to remove the aborted patch edition
\`\`\`

### Rollback Option B: After Cutover — High Risk, Production Emergency Only

If a critical issue is discovered AFTER production cutover and the issue cannot be resolved quickly:

#### Step B.1 — Determine the Pre-Cutover SCN

\`\`\`sql
-- Find the SCN at the time of cutover from adop log or alert log
-- Alternatively: use the RMAN backup from Step 0.6 (taken just before cutover)
SELECT DBMS_FLASHBACK.GET_SYSTEM_CHANGE_NUMBER FROM dual;
-- Note: this is the CURRENT SCN, not the pre-cutover SCN
-- Use the RMAN backup tag 'PRE_PATCH_YYYYMMDD' as the restore point
\`\`\`

#### Step B.2 — Restore Database from Pre-Patch RMAN Backup

\`\`\`bash
# STOP all EBS services first
$ADMIN_SCRIPTS_HOME/adstopall.sh apps/<apps_password>

# Restore from RMAN backup (PRE_PATCH tag)
rman target / <<'EOF'
SHUTDOWN IMMEDIATE;
STARTUP MOUNT;
RESTORE DATABASE FROM TAG 'PRE_PATCH_YYYYMMDD';
RECOVER DATABASE;
ALTER DATABASE OPEN RESETLOGS;
EOF
\`\`\`

#### Step B.3 — Switch File System Back to Pre-Patch State

\`\`\`bash
# Manually set the active file system back to the pre-patch fs
# Edit: $INST_TOP/appl/admin/adovars.env
# Change s_ebsndir back to the original fs path

# Run AutoConfig to regenerate all config files from the pre-patch file system
perl $AD_TOP/bin/adautocfg.pl appspass=<apps_password>

# Restart services
$ADMIN_SCRIPTS_HOME/adstrtal.sh apps/<apps_password>
\`\`\`

#### Step B.4 — Escalate to Oracle Support

Open a Severity 1 SR with Oracle Support immediately. Provide:
- Patch number applied
- Error messages from the EBS application log and alert log
- Steps you have already taken

Rollback B is a last resort. Commit to it only if: the business impact of the bug is greater than the business impact of the downtime required to restore.`,
};

async function main() {
  console.log('Inserting EBS patching runbook...');
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
