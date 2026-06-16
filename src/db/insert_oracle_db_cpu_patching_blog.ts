import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Applying Oracle Critical Patch Updates: OPatch Procedures for Linux and Windows',
  slug: 'oracle-critical-patch-update-opatch-linux-windows',
  excerpt:
    'Oracle Critical Patch Updates (CPUs) are the primary mechanism for remediating security vulnerabilities in Oracle Database. This guide covers the full OPatch workflow for Oracle Database 12.1.0.2 on both Linux and Windows — from downloading patch 6880880 (the OPatch utility itself) through applying the CPU, running datapatch, and verifying the patch inventory.',
  category: 'oracle-security' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-15'),
  youtubeUrl: null,
  content: `Oracle issues Critical Patch Updates (CPUs) on a quarterly schedule — January, April, July, and October. Each CPU is a cumulative collection of security fixes for Oracle products. For Oracle Database, the CPU is delivered as an OPatch bundle: a zip file you download from My Oracle Support, apply using the OPatch utility, and then complete with a datapatch run to update the data dictionary.

This guide covers the October 2020 CPU for Oracle Database 12.1.0.2 Standard Edition — the patch referenced in MOS support workflows for databases under Extended Support. The same workflow applies to other quarterly CPUs and to other 12.x patch levels; only the patch numbers differ.

---

## Understanding the Patch Stack

Before applying a CPU, understand what you are installing:

**OPatch (Patch 6880880)** — The patching utility itself. OPatch is versioned separately from the database. Before applying any CPU, you must first upgrade OPatch to the minimum version required by the CPU. The October 2020 CPU for 12.1.0.2 requires OPatch 12.2.0.1.23 or later. OPatch patch 6880880 is a self-contained zip that replaces the \`OPatch\` directory inside \`ORACLE_HOME\`.

**Database CPU Patch** — The security fix bundle for the database binaries. For 12.1.0.2, the October 2020 CPU patch number is listed in the CPU advisory on MOS (Note 2694866.1 for the October 2020 CPU advisory). The patch bundle targets the \`ORACLE_HOME\` binary layer.

**datapatch** — A post-OPatch step that applies SQL and PL/SQL changes to the data dictionary of each pluggable and container database. datapatch must run after OPatch completes and the database is started.

---

## Pre-Patch Assessment

Run these checks on the target system before the maintenance window opens.

### Check Current OPatch Version

\`\`\`bash
\$ORACLE_HOME/OPatch/opatch version
\`\`\`

If the version is below the minimum required by the CPU advisory, you must upgrade OPatch first.

### List Currently Applied Patches

\`\`\`bash
\$ORACLE_HOME/OPatch/opatch lsinventory -detail
\`\`\`

Save this output. It is your pre-patch baseline. Any conflict check failure will reference patch numbers from this list.

### Run a Conflict Check (Without Applying)

After downloading the CPU zip and extracting it to a staging directory:

\`\`\`bash
cd /stage/cpu_oct2020
\$ORACLE_HOME/OPatch/opatch prereq CheckConflictAgainstOHWithDetail -ph ./
\`\`\`

If OPatch reports conflicts, review the conflict details. A conflict typically means a one-off patch you applied previously is superseded by the CPU — in which case OPatch handles the merge automatically. If OPatch reports an unresolvable conflict, open a Service Request with Oracle Support before proceeding.

### Verify Disk Space

OPatch requires free space in \`ORACLE_HOME\` for the patch files and the rollback archive:

\`\`\`bash
df -h \$ORACLE_HOME
\`\`\`

Allow at least 2 GB free for a typical CPU patch on 12.1.0.2.

---

## Upgrading OPatch (Both Platforms)

Download patch 6880880 from My Oracle Support (Patches & Updates). Select platform: Linux x86-64 or Windows x86-64. The patch is a zip file named \`p6880880_<version>_<platform>.zip\`.

**Linux:**

\`\`\`bash
# Back up existing OPatch directory
mv \$ORACLE_HOME/OPatch \$ORACLE_HOME/OPatch_backup_\$(date +%Y%m%d)

# Extract new OPatch into ORACLE_HOME
unzip /stage/p6880880_122010123_Linux-x86-64.zip -d \$ORACLE_HOME

# Confirm version
\$ORACLE_HOME/OPatch/opatch version
\`\`\`

**Windows (run as Administrator in cmd.exe):**

\`\`\`cmd
REM Back up existing OPatch directory
rename %ORACLE_HOME%\OPatch OPatch_backup_%DATE:~10,4%%DATE:~4,2%%DATE:~7,2%

REM Extract new OPatch — use 7-Zip or built-in Windows zip extraction
REM Then confirm version
%ORACLE_HOME%\OPatch\opatch version
\`\`\`

---

## Applying the CPU on Linux

### 1. Set Environment Variables

\`\`\`bash
export ORACLE_HOME=/u01/app/oracle/product/12.1.0/dbhome_1
export ORACLE_SID=ORCL
export PATH=\$ORACLE_HOME/bin:\$ORACLE_HOME/OPatch:\$PATH
\`\`\`

### 2. Stop All Oracle Processes

Stop all database instances, listeners, and any other processes using the ORACLE_HOME being patched:

\`\`\`bash
# Stop the listener
lsnrctl stop

# Connect to SQL*Plus and shut down the database
sqlplus / as sysdba <<EOF
shutdown immediate;
exit
EOF
\`\`\`

If running Oracle Grid Infrastructure or ASM, stop those as well (as the grid user):

\`\`\`bash
# As grid user — if applicable
\$GRID_HOME/bin/crsctl stop has -f
\`\`\`

### 3. Apply the CPU Patch

Extract the CPU patch zip to a staging directory, then run OPatch:

\`\`\`bash
cd /stage/cpu_oct2020/31720776   # patch number varies; see CPU advisory
\$ORACLE_HOME/OPatch/opatch apply
\`\`\`

OPatch will:
1. Run prerequisite checks (conflict detection)
2. Apply binary patches to ORACLE_HOME
3. Create a rollback archive in \`\$ORACLE_HOME/.patch_storage\`

Accept the prompts. At completion, OPatch prints: **OPatch succeeded.**

### 4. Start the Database

\`\`\`bash
sqlplus / as sysdba <<EOF
startup
exit
EOF

lsnrctl start
\`\`\`

### 5. Run datapatch

datapatch applies the SQL-layer changes from the CPU to the data dictionary:

\`\`\`bash
cd \$ORACLE_HOME/OPatch
./datapatch -verbose
\`\`\`

datapatch connects to the database, detects which patches have been applied to the binaries but not yet to the data dictionary, and applies the corresponding SQL scripts. For a CDB, it patches all PDBs.

### 6. Compile Invalid Objects (If Prompted)

datapatch output will indicate if invalid objects need recompilation:

\`\`\`bash
sqlplus / as sysdba <<EOF
@\$ORACLE_HOME/rdbms/admin/utlrp.sql
exit
EOF
\`\`\`

---

## Applying the CPU on Windows

### 1. Stop Oracle Services

Open **Services** (services.msc) or use the command line as Administrator:

\`\`\`cmd
net stop OracleServiceORCL
net stop OracleOraDB12Home1TNSListener
\`\`\`

Stop all Oracle services associated with the ORACLE_HOME being patched. Check the service names in services.msc — they include the Oracle home name in the service name.

If Oracle Agent, OHSD, or other Oracle services are running from the same home, stop those as well:

\`\`\`cmd
net stop OracleDBConsoleORCL
net stop OracleMTSRecoveryService
\`\`\`

### 2. Open Administrator Command Prompt and Set Environment

\`\`\`cmd
set ORACLE_HOME=C:\app\oracle\product\\12.1.0\dbhome_1
set ORACLE_SID=ORCL
set PATH=%ORACLE_HOME%\\bin;%ORACLE_HOME%\OPatch;%PATH%
\`\`\`

### 3. Apply the CPU Patch

Extract the CPU zip, then run OPatch from the Administrator prompt:

\`\`\`cmd
cd C:\stage\cpu_oct2020\\31720776
%ORACLE_HOME%\OPatch\opatch apply
\`\`\`

OPatch on Windows requires that no Oracle processes hold locks on the ORACLE_HOME files. If OPatch reports a locked file, check Task Manager for oracle.exe, tnslsnr.exe, or agtctl.exe processes that must be terminated before proceeding.

### 4. Start Oracle Services

\`\`\`cmd
net start OracleServiceORCL
net start OracleOraDB12Home1TNSListener
\`\`\`

### 5. Run datapatch

\`\`\`cmd
cd %ORACLE_HOME%\OPatch
datapatch -verbose
\`\`\`

### 6. Compile Invalid Objects

\`\`\`cmd
sqlplus / as sysdba
SQL> @%ORACLE_HOME%\\rdbms\admin\\utlrp.sql
SQL> exit
\`\`\`

---

## Post-Patch Verification

These steps are identical on both platforms.

### Confirm Patch in OPatch Inventory

\`\`\`bash
\$ORACLE_HOME/OPatch/opatch lsinventory | grep -i "patch description"
\`\`\`

The CPU patch number should appear in the inventory output.

### Query the Data Dictionary Patch History

\`\`\`sql
SELECT patch_id, patch_uid, version, action, status, action_time, description
FROM   dba_registry_sqlpatch
ORDER  BY action_time DESC;
\`\`\`

Each CPU patch applied by datapatch appears as a row with STATUS = 'SUCCESS'. If any row shows STATUS = 'WITH ERRORS', run datapatch again and review the datapatch log at \`\$ORACLE_HOME/cfgtoollogs/sqlpatch/\`.

### Check the Alert Log

\`\`\`bash
tail -100 \$ORACLE_BASE/diag/rdbms/\$(echo \$ORACLE_SID | tr '[:upper:]' '[:lower:]')/\$ORACLE_SID/trace/alert_\$ORACLE_SID.log
\`\`\`

Look for ORA- errors after the startup sequence. A clean patch produces no ORA- errors post-startup.

### Verify No Invalid Objects Remain

\`\`\`sql
SELECT owner, object_type, COUNT(*)
FROM   dba_objects
WHERE  status = 'INVALID'
AND    owner NOT IN ('SYS','SYSTEM')
GROUP  BY owner, object_type
ORDER  BY owner, object_type;
\`\`\`

A handful of invalid objects in SYS or SYSTEM schemas immediately post-startup is normal — Oracle recompiles them on first use. If the count is large or non-SYS objects are invalid after utlrp.sql, investigate.

---

## Rollback Procedure

If the CPU causes an application regression and you must roll back:

**Linux:**

\`\`\`bash
# Shut down database first
sqlplus / as sysdba -S <<< "shutdown immediate"

# Roll back the patch
cd /stage/cpu_oct2020/31720776
\$ORACLE_HOME/OPatch/opatch rollback -id <patch_id>

# Restart and run datapatch to remove data dictionary changes
sqlplus / as sysdba -S <<< "startup"
\$ORACLE_HOME/OPatch/datapatch -verbose
\`\`\`

**Windows:**

\`\`\`cmd
net stop OracleServiceORCL
net stop OracleOraDB12Home1TNSListener

cd C:\stage\cpu_oct2020\\31720776
%ORACLE_HOME%\OPatch\opatch rollback -id <patch_id>

net start OracleServiceORCL
net start OracleOraDB12Home1TNSListener

cd %ORACLE_HOME%\OPatch
datapatch -verbose
\`\`\`

The \`<patch_id>\` is the numeric patch number (e.g., 31720776). Get it from \`opatch lsinventory\` if you are unsure.

---

## Oracle 12.1.0.2 and Extended Support Context

Oracle Database 12.1.0.2 reached the end of Premier Support in July 2018. Customers continuing on 12.1.0.2 after that date are under Extended Support, which continued through December 2021 (and into Sustaining Support beyond that). The October 2020 CPU was released during the Extended Support window, meaning security fixes were available but required an Extended Support fee.

Key implications for 12.1.0.2 patching:
- The CPU patch set available on MOS for 12.1.0.2 is the Database Patch Set Update (PSU) / Release Update (RU) bundle — not individual one-off patches.
- Confirm the minimum OPatch version in the CPU advisory README before upgrading OPatch. The README is inside the patch zip.
- Standard Edition 2 (SE2) customers on 12.1.0.2 have the same CPU patch availability as Enterprise Edition for the database binary patches.

---

## Summary

The CPU patching workflow has four invariant phases regardless of platform or patch version:

1. **Upgrade OPatch** to the minimum version required by the CPU advisory — OPatch cannot apply a CPU that requires a newer version of itself.
2. **Stop all Oracle processes** — OPatch cannot patch files held open by running processes (especially on Windows, where the file-lock model is strict).
3. **Apply with OPatch** — binary-layer changes only at this step; the database is not yet started.
4. **Run datapatch** — data dictionary SQL changes; requires the database to be started after OPatch completes.

The companion runbook contains the complete step-by-step checklist for both Linux and Windows, the pre-patch conflict detection procedure, the datapatch log interpretation guide, the dba_registry_sqlpatch validation queries, and the rollback checklist.`,
};

async function main() {
  console.log('Inserting Oracle CPU patching blog post...');
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
