import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'rman-active-duplicate-rac-to-single-instance-ora-15001-asm';

const content = `
RMAN Active Duplicate is one of the fastest ways to clone an Oracle database — no backup staging, no manual file copies, just a live block-for-block transfer from the source to the auxiliary instance over Oracle Net. But when the source is an Oracle RAC database and the target is a single-instance database on ASM, the duplicate process can fail at the very first step of control file creation with an error that appears contradictory: the disk group RMAN cannot find is visibly mounted and healthy when you query it directly.

This post walks through a real-world active duplicate failure, explains why the standard diagnostic instinct (check if the disk group is mounted) leads you in the wrong direction, identifies the two root causes that actually drive the ORA-15001, and shows the corrected RMAN script that resolves both.

---

## The Failure: ORA-15001 on Control File Creation

The duplicate command targets a single-instance database named \`TARGETDB\` with ASM disk groups \`DATA\` and \`RECO\`. The source is a multi-node RAC database. Seconds after the duplicate starts, RMAN aborts:

\`\`\`
RMAN-03002: failure of Duplicate Db command at 07/15/2026 12:49:08
RMAN-05501: aborting duplication of target database
RMAN-03015: error occurred in stored script Memory Script
ORA-19660: some files in the backup set could not be verified
ORA-19661: datafile 0 could not be verified due to corrupt blocks
ORA-19849: error while reading backup piece from service TARGETDB_OLD
ORA-19504: failed to create file "+DATA/TARGETDB/controlfile/control01.ctl"
ORA-17502: ksfdcre:3 Failed to create file +DATA/TARGETDB/controlfile/control01.ctl
ORA-15001: diskgroup "DATA" does not exist or is not mounted
ORA-59069: Oracle ASM file operation failed.
\`\`\`

Reading the error stack bottom-up, which is the correct direction for Oracle error stacks:

1. **ORA-59069 / ORA-15001** — The deepest cause: the ASM file operation failed because the disk group \`DATA\` is reported as non-existent or not mounted from the perspective of the process trying to create the file.
2. **ORA-17502** — The kernel-level create call failed.
3. **ORA-19504** — RMAN's file creation call wrapping the kernel failure.
4. **ORA-19849 / ORA-19661 / ORA-19660** — Cascading verification errors that fired because the control file could never be created to anchor the backup set.
5. **RMAN-03015 / RMAN-05501 / RMAN-03002** — RMAN surface-level abort messages.

---

## The Diagnostic Trap: The Disk Group Is Mounted

The natural first step when seeing ORA-15001 is to verify the ASM disk group on the target. On the target single-instance server:

\`\`\`sql
SQL> SELECT inst_id, name, state FROM gv\$asm_diskgroup;

   INST_ID NAME    STATE
---------- ------- -----------
         1 DATA    MOUNTED
         1 RECO    MOUNTED
\`\`\`

Both disk groups are mounted and healthy. If the disk group is MOUNTED, why does RMAN report ORA-15001?

The answer is that there are two completely separate reasons RMAN can report ORA-15001 even when the disk group is mounted, and neither of them is that the disk group is actually unmounted.

---

## Root Cause 1: Multi-Node Channel Allocation from a RAC Source

When you run \`DUPLICATE TARGET DATABASE FROM ACTIVE DATABASE\` against a RAC source without explicitly specifying auxiliary channels, RMAN generates an internal memory script that allocates channels based on the source database's parallelism configuration. If the source is a 4-node RAC with default parallelism, RMAN may try to use multiple source-side channel endpoints.

Evidence of this appears in the RMAN diagnostic traces, which are generated in directories named for specific database instances:

\`\`\`
/u01/app/oracle/diag/rdbms/sourcedb/SOURCEDB1/trace/...
/u01/app/oracle/diag/rdbms/sourcedb/SOURCEDB4/trace/...
\`\`\`

Instance \`SOURCEDB4\` generating a trace when the target is supposed to be single-instance is the diagnostic signal. It means RMAN channels allocated on the source RAC are trying to coordinate with the auxiliary, and those channels may be connecting from nodes where the auxiliary's ASM disk group path, TNS service, or OS environment is inconsistent.

The service name \`TARGETDB_OLD\` visible in the error stack is a TNS alias used by the source-side channels to connect to the auxiliary. If that alias resolves to a network path that reaches a node where either the ASM instance is different, the disk group is not accessible, or the oracle binary does not have the required OS permissions, the result is ORA-15001 even though the disk group is perfectly healthy when queried locally.

### Why this specific scenario triggers

When the source RAC uses a load-balanced SCAN service or a multi-address TNS alias for the connection back to the auxiliary, different RMAN channel sessions may end up routing through different physical paths. The auxiliary's nomount instance — which is what RMAN starts before creating the control file — resolves ASM paths using the OS environment of the process that received the connection, not the process on the node you explicitly connected to.

---

## Root Cause 2: OS Group Membership for ASM Access

Oracle separates the database and Grid Infrastructure installation users: the database binary typically runs as \`oracle\`, while the ASM instance and Grid Infrastructure run as \`grid\`. For the \`oracle\` user to create files in an ASM disk group, it must be a member of the \`asmdba\` OS group (in OSDBA-for-ASM installations) or have the equivalent privilege.

On a freshly built single-instance target where Grid Infrastructure was installed by a different team or using a different account profile, the \`oracle\` user may not have been added to \`asmdba\`. The ASM instance accepts the connection from the database instance, but the OS-level access check on the raw disk group devices fails, and Oracle translates this as ORA-15001.

This is the silent killer because it produces exactly the same error as a genuinely unmounted disk group, and it is invisible in the ASM instance itself — the disk group is mounted correctly for the \`grid\` user, but the \`oracle\` user is not authorized to use it.

### Verify OS group membership

On the target server, as root or with sudo:

\`\`\`bash
# Check oracle user's group memberships
id oracle

# Expected output includes asmdba:
# uid=54321(oracle) gid=54321(oinstall) groups=54321(oinstall),54322(dba),54330(asmdba),54331(asmsba)

# Check the asmdba group membership directly
grep asmdba /etc/group
\`\`\`

If \`asmdba\` is absent from the \`oracle\` user's groups, add it:

\`\`\`bash
# Add oracle to asmdba group (run as root)
usermod -a -G asmdba oracle

# Verify
id oracle
\`\`\`

After modifying group membership, the oracle user must establish a new OS session for the change to take effect — existing processes and connections retain the old group set.

### Verify ASM connectivity as oracle

After correcting groups, test the ASM connection directly from the oracle OS user on the target:

\`\`\`bash
# As the oracle OS user on the target
export ORACLE_SID=+ASM
export ORACLE_HOME=/u01/app/grid/product/19c/grid   # adjust to your Grid home
sqlplus / as sysasm

SQL> SELECT name, state FROM v\$asm_diskgroup;
\`\`\`

If this connects and shows the disk groups MOUNTED, the oracle user can reach ASM. If it fails with ORA-01031 (insufficient privileges) or ORA-15001, the OS group fix is needed or the Grid Infrastructure home path in the oracle user's environment is incorrect.

---

## Version-Specific Considerations

The ORA-15001 / multi-node channel problem exists across all Oracle Database versions that support Active Duplicate, but the RMAN script syntax and available parameters differ.

### Oracle 11.2.0.4

\`SECTION SIZE\` is not available in 11.2 for active duplicate. Use the \`USING COMPRESSED BACKUPSET\` clause if available in your patchset (introduced mid-11.2). Explicit auxiliary channel allocation is available and is the same fix. The \`cluster_database\` SPFILE override works identically.

\`\`\`text
RUN {
  ALLOCATE AUXILIARY CHANNEL aux1 DEVICE TYPE DISK;
  ALLOCATE AUXILIARY CHANNEL aux2 DEVICE TYPE DISK;

  DUPLICATE TARGET DATABASE TO 'TARGETDB'
    FROM ACTIVE DATABASE
    NOFILENAMECHECK
    SPFILE
      SET db_unique_name='TARGETDB'
      SET db_create_file_dest='+DATA'
      SET db_recovery_file_dest='+RECO'
      SET control_files='+DATA','+RECO'
      SET cluster_database='FALSE';
}
\`\`\`

### Oracle 12.1 and 12.2

\`SECTION SIZE\` is available from 12.1 for active duplicate, which parallelises the transfer of large datafiles by splitting them into sections. Useful for databases with very large individual datafiles. The channel and SPFILE approach is identical.

### Oracle 19c

All the above applies. In addition, 19c supports \`USING ENCRYPTED BACKUPSET\` for active duplicate when the source uses Transparent Data Encryption. The \`cluster_database=FALSE\` override and explicit auxiliary channel allocation remain the correct approach for RAC-to-single-instance duplicates.

---

## The Corrected RMAN Script

Once OS group membership is verified, the RMAN script must also explicitly allocate auxiliary channels and override the cluster-related SPFILE parameters.

\`\`\`text
RUN {
  -- Explicit local auxiliary channels prevent RMAN from allocating
  -- channels through multi-node RAC paths on the source
  ALLOCATE AUXILIARY CHANNEL aux1 DEVICE TYPE DISK;
  ALLOCATE AUXILIARY CHANNEL aux2 DEVICE TYPE DISK;

  DUPLICATE TARGET DATABASE TO 'TARGETDB'
    FROM ACTIVE DATABASE
    SECTION SIZE 32G
    USING COMPRESSED BACKUPSET
    NOFILENAMECHECK
    SPFILE
      SET db_unique_name='TARGETDB'
      SET db_create_file_dest='+DATA'
      SET db_recovery_file_dest='+RECO'
      SET control_files='+DATA','+RECO'
      SET cluster_database='FALSE';
}
\`\`\`

### Why each element matters

**\`ALLOCATE AUXILIARY CHANNEL aux1 DEVICE TYPE DISK;\`** — Manually defining local auxiliary channels prevents RMAN from spawning channel processes on unexpected RAC nodes. When channels are explicitly allocated, RMAN uses exactly those channels and no others. Without this, RMAN auto-allocates based on the source database's channel configuration and may route processes through RAC nodes that have no visibility into the target's ASM environment.

**\`SECTION SIZE 32G\`** — (12.1+) Splits large datafiles into 32 GB sections that can be transferred in parallel across the allocated channels. On a database with 10 TB datafiles, this can reduce total transfer time significantly. Remove this clause on Oracle 11.2.

**\`USING COMPRESSED BACKUPSET\`** — Applies compression to the active backup stream during transfer, reducing network bandwidth consumption between the source and target. The compression happens on the source side and the target receives a compressed stream. Effective when the network link between source and target is a bottleneck.

**\`NOFILENAMECHECK\`** — Suppresses the error that would otherwise fire when RMAN detects that the source and target use the same file path structure (common when duplicating on the same server or when using ASM disk groups with the same name).

**\`SET cluster_database='FALSE'\`** — This is the critical SPFILE override. Without it, if the source SPFILE has \`cluster_database=TRUE\`, the auxiliary instance reads this parameter during startup and attempts to register cluster-wide components, locate other RAC nodes, and operate as a cluster member — which is meaningless on a single-instance target and can cause the instance to fail to reach nomount cleanly.

**\`SET db_create_file_dest='+DATA'\` and \`SET control_files='+DATA','+RECO'\`** — Explicitly tells the auxiliary instance where to create datafiles and control files, overriding whatever the source SPFILE specified. Essential when the source RAC used different disk group names (e.g., \`+DATAC3\` on the source but \`+DATA\` on the target).

---

## Pre-Duplicate Checklist

Before running the duplicate:

\`\`\`bash
# 1. Source database is in ARCHIVELOG mode
sqlplus / as sysdba
SQL> SELECT log_mode FROM v\$database;
-- Expected: ARCHIVELOG

# 2. ASM disk groups mounted on target
export ORACLE_SID=+ASM
sqlplus / as sysasm
SQL> SELECT name, state FROM v\$asm_diskgroup WHERE name IN ('DATA','RECO');
-- Expected: both MOUNTED

# 3. oracle user is in asmdba
id oracle | grep asmdba

# 4. TNS alias for source resolves correctly from target server
tnsping SOURCEDB

# 5. RMAN can connect to source and auxiliary
rman target sys@SOURCEDB auxiliary sys@TARGETDB
RMAN> show all;  -- should connect without error
\`\`\`

---

## Summary

The ORA-15001 error during RMAN Active Duplicate from RAC to single-instance ASM is caused by one of two problems, or both simultaneously: the oracle OS user lacks membership in the \`asmdba\` group on the target server, and RMAN's auto-allocated channels route through unexpected RAC nodes that have no consistent path to the target's ASM environment.

The disk group being visibly MOUNTED when queried directly is not evidence that ORA-15001 is wrong — it is evidence that the disk group is healthy but the process receiving the RMAN connection does not have the OS-level authorization to interact with it, or that the connection arrived through a network path that bypasses the correctly-configured node.

The fix has two parts: add the oracle user to the \`asmdba\` group and establish a new OS session so the membership takes effect, and explicitly allocate local auxiliary channels in the RMAN RUN block while overriding \`cluster_database=FALSE\` in the SPFILE parameter set. Together these eliminate both failure paths and allow the memory script to create the control files in the target ASM disk group cleanly.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'Troubleshooting ORA-15001 and ORA-19504 During RMAN Active Duplicate from RAC to Single-Instance ASM',
    slug,
    excerpt: 'RMAN Active Duplicate from an Oracle RAC source to a single-instance ASM target can fail with ORA-15001 even when the target disk group is visibly MOUNTED. Two independent root causes drive this: the oracle OS user lacks asmdba group membership on the target, and RMAN auto-allocates channels through RAC nodes with no consistent path to the target ASM environment. This post traces the diagnostic steps, explains why querying the disk group state is not the right diagnostic, and gives the corrected RMAN script with explicit auxiliary channel allocation and cluster_database=FALSE override.',
    content,
    category: 'rac-clusterware',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
