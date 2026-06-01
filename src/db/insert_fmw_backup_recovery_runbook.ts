import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle Fusion Middleware Backup and Recovery',
  slug: 'fusion-middleware-backup-recovery-runbook',
  excerpt:
    'Comprehensive backup and recovery runbook for Oracle Fusion Middleware 12c — what to back up, online and offline backup procedures, WLST config backup, RCU schema backups with DataPump and RMAN, JMS store protection, OPSS keystore recovery, and step-by-step recovery for the most common failure scenarios.',
  category: 'fusion-middleware' as const,
  published: true,
  publishedAt: new Date('2026-06-01'),
  youtubeUrl: null,
  content: `A complete FMW backup strategy covers three independent layers: the file system (Oracle Home and domain home), the database (RCU schemas), and the security credentials (OPSS keystore and boot.properties). Losing any one of these without a backup means rebuilding from scratch. This runbook establishes a regular backup cadence and documents recovery procedures for the most common failure scenarios.

---

## What Needs to Be Backed Up

| Asset | Location | Backup method | Frequency |
|---|---|---|---|
| Oracle Home | \`/u01/app/oracle/product/fmw/\` | Filesystem tar | After each patch |
| Domain Home | \`/u01/app/oracle/config/domains/\` | Filesystem tar + WLST config backup | Daily |
| config.xml | \`\${DOMAIN_HOME}/config/config.xml\` | Included in domain backup + WebLogic auto-versioning | Continuous (WLS keeps last 50 versions) |
| JDBC datasource configs | \`\${DOMAIN_HOME}/config/jdbc/\` | Included in domain backup | Daily |
| JPS / security config | \`\${DOMAIN_HOME}/config/fmwconfig/\` | Included in domain backup | Daily |
| OPSS keystore | \`\${DOMAIN_HOME}/config/fmwconfig/jceks/\` | Included in domain backup | Daily |
| SerializedSystemIni.dat | \`\${DOMAIN_HOME}/security/\` | Included in domain backup | Daily |
| Boot credentials | \`\${DOMAIN_HOME}/servers/*/security/boot.properties\` | Included in domain backup | Daily |
| JMS file stores | \`/u01/share/jms/\` (NFS) | Filesystem backup of NFS share | Daily |
| Transaction logs | \`/u01/share/tlogs/\` (NFS) | Included in NFS share backup | Daily |
| RCU schemas (SOAINFRA, MDS, OPSS, IAU, STB) | Oracle Database | DataPump export + RMAN | Daily (DataPump) + continuous (RMAN archivelog) |
| OPatch inventory | \`\${ORACLE_HOME}/OPatch\` | Included in Oracle Home backup | After each patch |

---

## Backup Naming Conventions

\`\`\`
/u01/backup/
├── oracle_home/
│   └── fmw_infra_OH_YYYYMMDD_HHMM.tar.gz
├── domain/
│   ├── soa_domain_YYYYMMDD_HHMM.tar.gz
│   └── wlst_config/
│       └── soa_domain_config_YYYYMMDD.jar
├── schemas/
│   ├── soainfra_YYYYMMDD.dmp
│   ├── mds_YYYYMMDD.dmp
│   └── opss_YYYYMMDD.dmp
└── opatch/
    └── lsinventory_YYYYMMDD.txt
\`\`\`

---

## Part 1: Domain Backup

### 1.1 WLST Online Configuration Backup

WebLogic provides a built-in backup mechanism via WLST that captures the domain configuration into a versioned JAR. This is an online backup — no server shutdown required.

\`\`\`bash
/u01/app/oracle/product/fmw/infra/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<admin_password>','t3://localhost:7001')

# Back up domain configuration to a versioned archive
backup_dir = '/u01/backup/domain/wlst_config'
import os
os.makedirs(backup_dir, exist_ok=True)

backup_file = backup_dir + '/soa_domain_config_' + \\
  java.text.SimpleDateFormat('yyyyMMdd_HHmm').format(java.util.Date()) + '.jar'

backup(backup_file)
print('Config backup written to:', backup_file)
exit()
EOF
\`\`\`

The resulting JAR contains config.xml, JDBC descriptors, security realm configuration, and all other domain configuration files. It does not contain keystores, boot.properties, or JMS file store data.

### 1.2 WebLogic Automatic Config Versioning

WebLogic automatically archives a copy of config.xml before every change under:

\`\`\`
\${DOMAIN_HOME}/config/config-archive/config-<timestamp>.jar
\`\`\`

The last 50 versions are retained by default. To restore a previous config version, simply extract the JAR and replace config.xml, then restart AdminServer.

### 1.3 Full Domain Home Filesystem Backup

Captures everything the WLST backup misses: keystores, credentials, application files, server-specific security directories.

**Offline backup (recommended for full fidelity — all servers stopped):**

\`\`\`bash
# Stop all managed servers and AdminServer first
BACKUP_DATE=\$(date +%Y%m%d_%H%M)
mkdir -p /u01/backup/domain

tar -czf /u01/backup/domain/soa_domain_\${BACKUP_DATE}.tar.gz \\
  -C /u01/app/oracle/config/domains soa_domain

# Verify
tar -tzf /u01/backup/domain/soa_domain_\${BACKUP_DATE}.tar.gz | \\
  grep -E "config.xml|fmwconfig|security" | head -20
\`\`\`

**Online backup (servers running — consistent for most files, keystores may be in use):**

\`\`\`bash
BACKUP_DATE=\$(date +%Y%m%d_%H%M)
rsync -avz --exclude='servers/*/tmp' --exclude='servers/*/cache' \\
  /u01/app/oracle/config/domains/soa_domain/ \\
  /u01/backup/domain/soa_domain_\${BACKUP_DATE}/

# Compress after rsync
tar -czf /u01/backup/domain/soa_domain_\${BACKUP_DATE}.tar.gz \\
  -C /u01/backup/domain soa_domain_\${BACKUP_DATE}
rm -rf /u01/backup/domain/soa_domain_\${BACKUP_DATE}/
\`\`\`

Exclude \`tmp/\` and \`cache/\` — they are rebuilt at startup and take significant space.

### 1.4 Critical files to back up separately

These small files are catastrophic to lose and should also be backed up individually:

\`\`\`bash
BACKUP_DATE=\$(date +%Y%m%d)
mkdir -p /u01/backup/domain/critical_\${BACKUP_DATE}

# Domain config
cp \${DOMAIN_HOME}/config/config.xml \\
   /u01/backup/domain/critical_\${BACKUP_DATE}/

# OPSS keystore and JPS config
cp -r \${DOMAIN_HOME}/config/fmwconfig/ \\
   /u01/backup/domain/critical_\${BACKUP_DATE}/

# Domain-level security (SerializedSystemIni.dat, DefaultAuthenticatorInit.ldift)
cp -r \${DOMAIN_HOME}/security/ \\
   /u01/backup/domain/critical_\${BACKUP_DATE}/

# Boot properties for each server
for SERVER in AdminServer soa_server1 soa_server2; do
  mkdir -p /u01/backup/domain/critical_\${BACKUP_DATE}/servers/\${SERVER}/security/
  cp \${DOMAIN_HOME}/servers/\${SERVER}/security/boot.properties \\
     /u01/backup/domain/critical_\${BACKUP_DATE}/servers/\${SERVER}/security/ 2>/dev/null || true
done
\`\`\`

---

## Part 2: Oracle Home Backup

Oracle Home backups are taken after each patch cycle, not daily. A daily OH backup is unnecessary since the OH only changes when patched.

\`\`\`bash
# Take before patching (see patching runbook)
BACKUP_DATE=\$(date +%Y%m%d_%H%M)
mkdir -p /u01/backup/oracle_home

tar -czf /u01/backup/oracle_home/fmw_infra_OH_\${BACKUP_DATE}.tar.gz \\
  -C /u01/app/oracle/product/fmw infra

# Save OPatch inventory alongside
/u01/app/oracle/product/fmw/infra/OPatch/opatch lspatches \\
  > /u01/backup/opatch/lsinventory_\${BACKUP_DATE}.txt

# Verify archive
tar -tzf /u01/backup/oracle_home/fmw_infra_OH_\${BACKUP_DATE}.tar.gz | \\
  grep -c "wlserver" | xargs echo "wlserver file count:"
\`\`\`

Keep the two most recent Oracle Home backups (pre-patch and post-patch). Older backups can be removed once the new patch cycle is stable.

---

## Part 3: RCU Schema Backups

The RCU schemas (SOAINFRA, MDS, OPSS, IAU, STB) hold all process instance state, metadata, security policies, and audit records. These are the most critical data to protect.

### 3.1 DataPump schema export

DataPump exports are consistent, portable, and can restore individual schemas without impacting others. Schedule daily.

\`\`\`bash
BACKUP_DATE=\$(date +%Y%m%d)
mkdir -p /u01/backup/schemas

# Create DataPump directory object if not already created (run as SYSDBA once)
# CREATE OR REPLACE DIRECTORY FMW_BACKUP_DIR AS '/u01/backup/schemas';
# GRANT READ, WRITE ON DIRECTORY FMW_BACKUP_DIR TO system;

# Export all RCU schemas (adjust prefix to match your installation)
expdp system/<password>@fmwdb.example.com:1521/FMWDB \\
  SCHEMAS=FMW_SOAINFRA,FMW_MDS,FMW_OPSS,FMW_IAU,FMW_IAU_APPEND,FMW_IAU_VIEWER,FMW_STB,FMW_UMS \\
  DIRECTORY=FMW_BACKUP_DIR \\
  DUMPFILE=fmw_schemas_\${BACKUP_DATE}_%U.dmp \\
  FILESIZE=2G \\
  LOGFILE=fmw_schemas_export_\${BACKUP_DATE}.log \\
  PARALLEL=2 \\
  COMPRESSION=ALL

# Verify export completed successfully
tail -5 /u01/backup/schemas/fmw_schemas_export_\${BACKUP_DATE}.log
# Should end with: "Job "SYSTEM"."SYS_EXPORT_SCHEMA_NN" successfully completed"
\`\`\`

### 3.2 SOAINFRA-only export (more frequent for active SOA environments)

In high-activity SOA environments, export SOAINFRA separately and more frequently:

\`\`\`bash
expdp system/<password>@fmwdb.example.com:1521/FMWDB \\
  SCHEMAS=FMW_SOAINFRA \\
  DIRECTORY=FMW_BACKUP_DIR \\
  DUMPFILE=soainfra_\${BACKUP_DATE}.dmp \\
  LOGFILE=soainfra_export_\${BACKUP_DATE}.log \\
  COMPRESSION=ALL
\`\`\`

### 3.3 RMAN backup of the FMW database

DataPump is a point-in-time logical backup. For point-in-time recovery to any moment between DataPump exports, RMAN archivelog backups of the target database are required.

\`\`\`bash
# Run on the DB host as oracle user
rman target / << 'EOF'
BACKUP DATABASE PLUS ARCHIVELOG DELETE INPUT;
BACKUP CURRENT CONTROLFILE;
CROSSCHECK ARCHIVELOG ALL;
DELETE EXPIRED ARCHIVELOG ALL;
LIST BACKUP SUMMARY;
EOF
\`\`\`

For databases hosting exclusively FMW schemas, a daily full RMAN backup with hourly archivelog backups provides a recovery point objective (RPO) of one hour.

### 3.4 Verify schema row counts (backup sanity check)

\`\`\`sql
-- Run after export to confirm schemas were not empty at backup time
SELECT 'FMW_SOAINFRA' AS schema_name,
       (SELECT COUNT(*) FROM FMW_SOAINFRA.CUBE_INSTANCE) AS composite_instances,
       (SELECT COUNT(*) FROM FMW_SOAINFRA.FAULT_INSTANCE) AS faults
FROM dual
UNION ALL
SELECT 'FMW_MDS',
       (SELECT COUNT(*) FROM FMW_MDS.MDS_COMPONENTS) AS components,
       NULL
FROM dual;
\`\`\`

---

## Part 4: JMS File Store Backup

JMS file stores on the shared NFS mount hold in-flight messages for BPEL dehydration queues, UMS notifications, and any custom JMS destinations. Back up the NFS mount daily.

\`\`\`bash
BACKUP_DATE=\$(date +%Y%m%d_%H%M)
mkdir -p /u01/backup/jms

# Backup all JMS stores (managed servers should be stopped for file-consistent backup)
tar -czf /u01/backup/jms/jms_stores_\${BACKUP_DATE}.tar.gz /u01/share/jms/
tar -czf /u01/backup/jms/tlogs_\${BACKUP_DATE}.tar.gz /u01/share/tlogs/
\`\`\`

For online JMS backups (servers running), use the storage array snapshot if available, as JMS file stores may be partially written during a tar operation.

---

## Part 5: Automated Backup Script

Schedule the following script via cron for daily domain and schema backups:

\`\`\`bash
cat > /u01/scripts/fmw_daily_backup.sh << 'SCRIPT'
#!/bin/bash
source /home/oracle/.bash_profile

BACKUP_DATE=\$(date +%Y%m%d_%H%M)
BACKUP_ROOT=/u01/backup
LOG=\${BACKUP_ROOT}/backup_\${BACKUP_DATE}.log
DOMAIN_HOME=/u01/app/oracle/config/domains/soa_domain

exec >> \${LOG} 2>&1

echo "=== FMW Daily Backup: \$(date) ==="

# 1. WLST domain config backup (online)
/u01/app/oracle/product/fmw/infra/oracle_common/common/bin/wlst.sh << 'WLSTEOF'
connect('weblogic','<password>','t3://localhost:7001')
backup('/u01/backup/domain/wlst_config/soa_domain_config_BACKUPDATE.jar'.replace('BACKUPDATE', java.text.SimpleDateFormat('yyyyMMdd_HHmm').format(java.util.Date())))
exit()
WLSTEOF

# 2. Critical files backup
mkdir -p \${BACKUP_ROOT}/domain/critical_\${BACKUP_DATE}
cp \${DOMAIN_HOME}/config/config.xml \${BACKUP_ROOT}/domain/critical_\${BACKUP_DATE}/
cp -r \${DOMAIN_HOME}/config/fmwconfig/ \${BACKUP_ROOT}/domain/critical_\${BACKUP_DATE}/
cp -r \${DOMAIN_HOME}/security/ \${BACKUP_ROOT}/domain/critical_\${BACKUP_DATE}/

# 3. Schema DataPump export
expdp system/<password>@fmwdb.example.com:1521/FMWDB \\
  SCHEMAS=FMW_SOAINFRA,FMW_MDS,FMW_OPSS,FMW_IAU,FMW_IAU_APPEND,FMW_IAU_VIEWER,FMW_STB \\
  DIRECTORY=FMW_BACKUP_DIR \\
  DUMPFILE=fmw_schemas_\${BACKUP_DATE}_%U.dmp \\
  LOGFILE=fmw_schemas_export_\${BACKUP_DATE}.log \\
  COMPRESSION=ALL \\
  PARALLEL=2

# 4. Prune backups older than 7 days
find \${BACKUP_ROOT}/domain/wlst_config -name "*.jar" -mtime +7 -delete
find \${BACKUP_ROOT}/domain -name "critical_*" -type d -mtime +7 -exec rm -rf {} + 2>/dev/null || true
find \${BACKUP_ROOT}/schemas -name "*.dmp" -mtime +7 -delete
find \${BACKUP_ROOT}/schemas -name "*.log" -mtime +7 -delete

echo "=== Backup complete: \$(date) ==="
SCRIPT

chmod 750 /u01/scripts/fmw_daily_backup.sh
\`\`\`

Add to oracle user crontab:

\`\`\`bash
crontab -e
# Add:
# 0 2 * * * /u01/scripts/fmw_daily_backup.sh
\`\`\`

---

## Recovery Scenarios

### Scenario 1: config.xml Corruption

**Symptom:** AdminServer fails to start with "Failed to parse config.xml" or similar XML error.

**Recovery using WebLogic config archive:**

\`\`\`bash
# Stop AdminServer if still running
# Navigate to the config archive
ls -lt \${DOMAIN_HOME}/config/config-archive/
# config-archive contains timestamped JARs of previous config versions

# Extract the most recent known-good config.xml
cd /tmp
jar -xf \${DOMAIN_HOME}/config/config-archive/config-<last-good-timestamp>.jar config.xml

# Replace the corrupt config.xml
cp \${DOMAIN_HOME}/config/config.xml \${DOMAIN_HOME}/config/config.xml.corrupt
cp /tmp/config.xml \${DOMAIN_HOME}/config/config.xml

# Restart AdminServer
\`\`\`

**Recovery from WLST backup JAR:**

\`\`\`bash
cd /tmp/config_restore
jar -xf /u01/backup/domain/wlst_config/soa_domain_config_<date>.jar

# The JAR extracts to a directory mirroring $DOMAIN_HOME/config/
# Copy the config files back
cp -r /tmp/config_restore/config/* \${DOMAIN_HOME}/config/

# Restart AdminServer
\`\`\`

### Scenario 2: Domain Home Directory Loss

**Symptom:** Domain home deleted or filesystem corruption — all server startup scripts, configuration, and keystores are gone.

\`\`\`bash
# 1. Stop any surviving processes
ps -ef | grep weblogic | grep -v grep | awk '{print \$2}' | xargs kill -9 2>/dev/null

# 2. Restore domain from filesystem backup
mkdir -p /u01/app/oracle/config/domains
tar -xzf /u01/backup/domain/soa_domain_<YYYYMMDD_HHMM>.tar.gz \\
  -C /u01/app/oracle/config/domains/

# 3. Restore boot.properties (they encrypt after first server start;
#    the decrypted plain-text versions from backup may need recreation)
# If boot.properties passwords are obfuscated (starts with {AES}), recreate:
cat > \${DOMAIN_HOME}/servers/AdminServer/security/boot.properties << 'EOF'
username=weblogic
password=<plain_text_password>
EOF
chmod 600 \${DOMAIN_HOME}/servers/AdminServer/security/boot.properties

# 4. Start AdminServer (WebLogic will re-obfuscate the plain-text password on startup)
nohup \${DOMAIN_HOME}/bin/startWebLogic.sh \\
  > \${DOMAIN_HOME}/servers/AdminServer/logs/AdminServer.out 2>&1 &

# 5. Start Node Manager and managed servers as normal
\`\`\`

### Scenario 3: Oracle Home Corruption or Accidental Deletion

**Symptom:** All FMW scripts and binaries missing or damaged.

\`\`\`bash
# 1. Stop all servers (if any are running)
# 2. Remove the damaged Oracle Home
rm -rf /u01/app/oracle/product/fmw/infra

# 3. Restore from Oracle Home backup
mkdir -p /u01/app/oracle/product/fmw
tar -xzf /u01/backup/oracle_home/fmw_infra_OH_<YYYYMMDD_HHMM>.tar.gz \\
  -C /u01/app/oracle/product/fmw/

# 4. Verify restored state
/u01/app/oracle/product/fmw/infra/OPatch/opatch lspatches
java -cp /u01/app/oracle/product/fmw/infra/wlserver/server/lib/weblogic.jar \\
  weblogic.version

# 5. Start servers as normal
\`\`\`

### Scenario 4: OPSS Keystore Loss

**Symptom:** AdminServer starts but applications fail with "JPS-00025: Opening of wallet failed" or credential store access errors.

The OPSS keystore (\`cwallet.sso\` and \`ewallet.p12\` under \`\${DOMAIN_HOME}/config/fmwconfig/jceks/\`) contains the master encryption key for the credential store. Without it, no application can retrieve stored credentials.

\`\`\`bash
# 1. Restore the fmwconfig directory from backup
cp -r /u01/backup/domain/critical_<date>/fmwconfig/ \\
  \${DOMAIN_HOME}/config/

# 2. Ensure file permissions are correct
chown -R oracle:oinstall \${DOMAIN_HOME}/config/fmwconfig/
chmod 600 \${DOMAIN_HOME}/config/fmwconfig/jceks/*.sso
chmod 600 \${DOMAIN_HOME}/config/fmwconfig/jceks/*.p12

# 3. Restart AdminServer
\`\`\`

If no fmwconfig backup is available, the OPSS store must be re-bootstrapped — all stored credentials (datasource passwords, adapter credentials, etc.) will be lost and must be reconfigured manually. This is why daily backups of fmwconfig are non-negotiable.

### Scenario 5: Single RCU Schema Recovery (SOAINFRA)

**Symptom:** SOAINFRA schema data loss or corruption — soa_server1 starts but faults, historical instances are missing, or the schema has physical corruption.

\`\`\`bash
# 1. Stop all SOA managed servers
# (AdminServer can remain running — only SOAINFRA-dependent servers need to stop)

# 2. Drop and recreate the SOAINFRA schema (as SYSDBA)
sqlplus / as sysdba << 'EOF'
DROP USER FMW_SOAINFRA CASCADE;
EOF

# 3. Recreate the empty schema via RCU
# Re-run RCU in Create mode, selecting only the SOAINFRA component,
# using the existing prefix FMW

# 4. Import from DataPump backup
impdp system/<password>@fmwdb.example.com:1521/FMWDB \\
  SCHEMAS=FMW_SOAINFRA \\
  DIRECTORY=FMW_BACKUP_DIR \\
  DUMPFILE=fmw_schemas_<date>_%U.dmp \\
  TABLE_EXISTS_ACTION=REPLACE \\
  LOGFILE=soainfra_import_\$(date +%Y%m%d).log

# 5. Run Upgrade Assistant if the schema version needs to be updated
#    after the import (check schema_version_registry)

# 6. Start SOA managed servers
\`\`\`

### Scenario 6: Point-in-Time Recovery of SOAINFRA (using RMAN)

When a DataPump export is too old and you need to recover to a specific point in time (e.g., just before a bad deployment corrupted instance data):

\`\`\`bash
# On the DB host, use RMAN to restore and recover to the target time
rman target / << 'EOF'
SHUTDOWN IMMEDIATE;
STARTUP MOUNT;
RESTORE DATABASE UNTIL TIME "TO_DATE('2026-06-01 03:00:00','YYYY-MM-DD HH24:MI:SS')";
RECOVER DATABASE UNTIL TIME "TO_DATE('2026-06-01 03:00:00','YYYY-MM-DD HH24:MI:SS')";
ALTER DATABASE OPEN RESETLOGS;
EOF
\`\`\`

Note: point-in-time database recovery affects all schemas in the database, not just SOAINFRA. In a shared database hosting both FMW schemas and application data, prefer DataPump-based schema restore over RMAN PITR.

### Scenario 7: JMS File Store Recovery

**Symptom:** Managed server fails to start with "Could not open persistent store" or JMS messages are lost after a crash.

\`\`\`bash
# 1. If the store file is corrupted, restore from NFS backup
# Stop the managed server first

# Backup the corrupt store for investigation
mv /u01/share/jms/soa_server1/ /u01/share/jms/soa_server1.corrupt.\$(date +%Y%m%d)

# Restore from backup
tar -xzf /u01/backup/jms/jms_stores_<date>.tar.gz \\
  -C / u01/share/jms/soa_server1/

# 2. If the store must be reset (accepting message loss):
mkdir -p /u01/share/jms/soa_server1_new
# Update the JMS File Store directory in Admin Console to point to the new empty directory
# Start the managed server — it will create a fresh store
\`\`\`

---

## Verifying Backup Integrity

Test backups monthly by performing a restore to a non-production environment:

\`\`\`bash
# 1. Restore domain to a test directory
mkdir -p /tmp/fmw_restore_test
tar -xzf /u01/backup/domain/soa_domain_<date>.tar.gz -C /tmp/fmw_restore_test/
ls /tmp/fmw_restore_test/soa_domain/config/config.xml
# Should exist and be valid XML

# 2. Verify the DataPump file is readable
impdp system/<password>@testdb:1521/TESTDB \\
  SCHEMAS=FMW_SOAINFRA \\
  DIRECTORY=FMW_BACKUP_DIR \\
  DUMPFILE=fmw_schemas_<date>_%U.dmp \\
  SQLFILE=/tmp/import_preview.sql \\
  LOGFILE=/tmp/impdp_verify.log
# SQLFILE mode generates a preview without actually importing — safe for verification

# 3. Check the OPatch inventory backup is readable
cat /u01/backup/opatch/lsinventory_<date>.txt | grep "WebLogic"
\`\`\`

---

## Backup Retention Policy

| Backup type | Retention |
|---|---|
| WLST config backup JARs | 14 days |
| Domain home filesystem backup | 7 days (keep pre/post patch backups permanently) |
| Critical files backup | 30 days |
| Oracle Home backup | Last 2 (pre-patch and post-patch) |
| DataPump schema exports | 7 days daily + monthly retained 90 days |
| RMAN archivelogs | 7 days |
| RMAN full database backup | 2 most recent |
| JMS/TLog backup | 3 days |

---

## Recovery Readiness Checklist

- [ ] Daily cron job running and producing backup files with non-zero size
- [ ] DataPump export log ends with "successfully completed" — no errors
- [ ] RMAN backup report shows no failed pieces
- [ ] Backup storage free space checked weekly (DataPump exports grow with SOAINFRA volume)
- [ ] Domain home backup includes fmwconfig, security, and boot.properties directories
- [ ] Oracle Home backup taken after most recent patch cycle
- [ ] Restore test performed in the last 30 days against a non-production target
- [ ] Recovery procedures documented and accessible outside the FMW server (this runbook)
- [ ] RTO and RPO targets defined and communicated to operations team
- [ ] Escalation contacts for DB team (RMAN recovery), storage team (NFS restore), and Oracle Support (MOS SR for license key recovery) documented`,
};

async function main() {
  console.log('Inserting FMW backup and recovery runbook...');
  await db.insert(posts).values(post).onConflictDoNothing();
  console.log(`Inserted: "${post.title}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
