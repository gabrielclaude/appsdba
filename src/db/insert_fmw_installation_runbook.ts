import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Installing Oracle Fusion Middleware 12c Infrastructure',
  slug: 'fusion-middleware-installation-runbook',
  excerpt:
    'Step-by-step runbook for installing Oracle Fusion Middleware 12c Infrastructure (12.2.1.4) — the WebLogic + JRF base layer required by SOA Suite, OSB, OIM, OAM, and every other FMW product. Covers OS prerequisites, JDK, installer, OPatch, RCU, domain creation, and patching workflow.',
  category: 'fusion-middleware' as const,
  published: true,
  publishedAt: new Date('2026-05-31'),
  youtubeUrl: null,
  content: `Oracle Fusion Middleware (FMW) Infrastructure is the base installation layer that every Oracle middleware product sits on top of. It delivers WebLogic Server, the Java Required Files (JRF) libraries, Oracle Platform Security Services (OPSS), Metadata Services (MDS), and the ADF runtime. Before you can install SOA Suite, Oracle Service Bus, Oracle Identity Manager, Oracle Access Manager, or any other FMW product, the Infrastructure must be installed and patched in the Oracle Home first.

This runbook installs a standalone FMW Infrastructure Oracle Home and creates a JRF-enabled WebLogic domain. Product-specific templates (SOA, OSB, OIM, etc.) are layered on top of this base in separate runbooks.

---

## What FMW Infrastructure Provides

| Component | Purpose |
|---|---|
| **WebLogic Server 12.2.1.4** | Java EE application server; hosts all FMW applications |
| **Java Required Files (JRF)** | Shared Oracle libraries (ADF, MDS, OPSS, logging, security) required by all FMW products |
| **Oracle Platform Security Services (OPSS)** | Credential store, policy store, identity virtualization layer used by all products for authentication and authorization |
| **Metadata Services (MDS)** | Versioned metadata repository; stores WSDLs, XSDs, ADF customizations, fault policies |
| **ADF Runtime** | Oracle Application Development Framework runtime; required by ADF-based applications including EBS OAF pages and many FMW consoles |
| **Enterprise Manager FMW Control** | Web-based management console for the entire FMW domain |
| **Oracle Coherence** | In-memory data grid; used for session replication and distributed caching across clustered managed servers |

---

## Environment Reference

| Item | Value |
|---|---|
| OS | Oracle Linux 8.x (x86_64) |
| Oracle DB | 19c |
| FMW version | 12.2.1.4.0 |
| JDK | Oracle JDK 8u361+ |
| Oracle Home | \`/u01/app/oracle/product/fmw/infra\` |
| Domain Home | \`/u01/app/oracle/config/domains/base_domain\` |
| Application Home | \`/u01/app/oracle/config/applications/base_domain\` |
| oraInventory | \`/u01/app/oraInventory\` |
| OS user | \`oracle\` |
| DB service | \`fmwdb.example.com:1521/FMWDB\` |
| RCU prefix | \`FMW\` |

All commands run as the \`oracle\` OS user unless noted. Commands requiring root are marked explicitly.

---

## Phase 1: OS Prerequisites

### 1.1 Required packages

Run as \`root\`:

\`\`\`bash
dnf install -y \\
  libaio libaio-devel \\
  gcc gcc-c++ make \\
  glibc glibc-devel \\
  libgcc libstdc++ libstdc++-devel \\
  sysstat binutils \\
  compat-openssl11 \\
  ksh unzip zip \\
  hostname

# Verify minimum memory (FMW Infrastructure + domain: minimum 4 GB RAM)
free -h

# Verify /tmp free space (minimum 1 GB)
df -h /tmp

# Verify /u01 free space (FMW OH alone: ~2 GB; domain + logs: plan 5–10 GB total)
df -h /u01
\`\`\`

### 1.2 Kernel parameters

Add to \`/etc/sysctl.conf\` (as root):

\`\`\`bash
fs.file-max = 6815744
kernel.sem = 250 32000 100 128
kernel.shmmni = 4096
kernel.shmall = 1073741824
kernel.shmmax = 4398046511104
net.core.rmem_default = 262144
net.core.rmem_max = 4194304
net.core.wmem_default = 262144
net.core.wmem_max = 1048576
\`\`\`

Apply:

\`\`\`bash
sysctl -p
\`\`\`

### 1.3 OS user and directory structure

\`\`\`bash
# As root
groupadd oinstall
groupadd dba
useradd -g oinstall -G dba -m -s /bin/bash oracle

mkdir -p /u01/app/oracle/product/fmw/infra
mkdir -p /u01/app/oracle/config/domains
mkdir -p /u01/app/oracle/config/applications
mkdir -p /u01/app/oraInventory
chown -R oracle:oinstall /u01/app/oracle
chown oracle:oinstall /u01/app/oraInventory

# Set /u01 permissions
chmod 755 /u01/app /u01/app/oracle
\`\`\`

### 1.4 oracle user environment

Add to \`/home/oracle/.bash_profile\`:

\`\`\`bash
# Oracle environment
export ORACLE_BASE=/u01/app/oracle
export MW_HOME=/u01/app/oracle/product/fmw/infra
export WL_HOME=\${MW_HOME}/wlserver
export DOMAIN_HOME=/u01/app/oracle/config/domains/base_domain
export JAVA_HOME=/u01/app/oracle/product/jdk8
export PATH=\${JAVA_HOME}/bin:\${MW_HOME}/oracle_common/common/bin:\${PATH}
export ORACLE_HOSTNAME=\$(hostname -f)

# OPatch path (added after FMW install)
export PATH=\${MW_HOME}/OPatch:\${PATH}
\`\`\`

\`\`\`bash
source ~/.bash_profile
\`\`\`

---

## Phase 2: Install Oracle JDK 8

FMW 12.2.1.4 requires Oracle JDK 8 (not OpenJDK, not JDK 11+). Download from Oracle Support (patch 35638318 or current JDK 8 CPU release).

\`\`\`bash
mkdir -p /u01/app/oracle/product/jdk8
tar -xzf jdk-8u361-linux-x64.tar.gz \\
  -C /u01/app/oracle/product/jdk8 --strip-components=1

# Verify
java -version
# Expected: java version "1.8.0_361"

which java
# Expected: /u01/app/oracle/product/jdk8/bin/java
\`\`\`

---

## Phase 3: Install FMW Infrastructure

**Installer file:** \`fmw_12.2.1.4.0_infrastructure.jar\`

Download from Oracle Software Delivery Cloud or Oracle Support (patch 30188493 or current infrastructure bundle).

### 3.1 Run the installer

\`\`\`bash
java -jar fmw_12.2.1.4.0_infrastructure.jar
\`\`\`

For silent/scripted installs, generate a response file first:

\`\`\`bash
java -jar fmw_12.2.1.4.0_infrastructure.jar -silent \\
  -responseFile /tmp/fmw_infra_install.rsp \\
  -invPtrLoc /u01/app/oraInventory/oraInst.loc
\`\`\`

### 3.2 Installer wizard steps

1. **Installation Inventory Setup**
   - Inventory Directory: \`/u01/app/oraInventory\`
   - OS Group: \`oinstall\`

2. **Welcome** — Next

3. **Auto Updates** — Skip (or configure Oracle Support credentials for live updates)

4. **Installation Location**
   - Oracle Home: \`/u01/app/oracle/product/fmw/infra\`
   - This directory must exist and be writable by oracle

5. **Installation Type** — Select **Fusion Middleware Infrastructure**
   - Do NOT select "Infrastructure With Examples" for production

6. **Prerequisite Checks** — The installer checks JDK version, OS packages, disk space, and memory. Resolve all failures before continuing. Warnings can be acknowledged.

7. **Installation Summary** — Review the Oracle Home path and disk space requirement (~1.8 GB), then **Install**

8. **Installation Progress** — Takes 5–10 minutes

9. **Installation Complete** — Note the Oracle Home path. Click **Finish**.

### 3.3 Post-install verification

\`\`\`bash
# Verify Oracle Home structure
ls /u01/app/oracle/product/fmw/infra/
# Expected directories: OPatch  coherence  em  inventory  jdeveloper
#                       modules  oracle_common  oraInst.loc  wlserver

# Verify WebLogic version
java -cp /u01/app/oracle/product/fmw/infra/wlserver/server/lib/weblogic.jar \\
  weblogic.version
# Expected: WebLogic Server 12.2.1.4.0

# Verify OPatch version
/u01/app/oracle/product/fmw/infra/OPatch/opatch version
# Expected: OPatch Version: 13.x.x.x.x (must be 13.9.4.2.2 or later for FMW 12.2.1.4)
\`\`\`

---

## Phase 4: Apply OPatch and Patches

Oracle recommends patching the Oracle Home immediately after installation, before creating any domain.

### 4.1 Upgrade OPatch if required

\`\`\`bash
# Check current OPatch version
/u01/app/oracle/product/fmw/infra/OPatch/opatch version

# If below 13.9.4.2.2, upgrade by replacing the OPatch directory
# Download p6880880_122140_Linux-x86-64.zip from Oracle Support
cd /u01/app/oracle/product/fmw/infra
mv OPatch OPatch.bak
unzip /tmp/p6880880_122140_Linux-x86-64.zip
/u01/app/oracle/product/fmw/infra/OPatch/opatch version
\`\`\`

### 4.2 Apply the quarterly Release Update patch

Oracle releases Bundle Patches (BPs) and Release Updates (RUs) for FMW quarterly. Find the latest patch for 12.2.1.4.0 on Oracle Support under patch family **Oracle Fusion Middleware 12.2.1.4 Patch Set Update**.

\`\`\`bash
# Example: applying patch 35940989 (substitute current RU number)
cd /tmp
unzip p35940989_122140_Generic.zip

# Stop all servers in the Oracle Home before patching
# (For a fresh install with no domain yet, skip this step)

# Apply the patch
/u01/app/oracle/product/fmw/infra/OPatch/opatch apply /tmp/35940989

# Verify the patch was applied
/u01/app/oracle/product/fmw/infra/OPatch/opatch lspatches | head -20
\`\`\`

### 4.3 Key OPatch commands

\`\`\`bash
# List all applied patches
opatch lspatches

# Check for patch conflicts before applying
opatch prereq CheckConflictAgainstOHWithDetail -ph /tmp/<patch_dir>

# Roll back a patch
opatch rollback -id <patch_number>

# Verify Oracle Home integrity
opatch lsinventory -detail
\`\`\`

---

## Phase 5: Run Repository Creation Utility (RCU)

RCU creates the database schemas that FMW components use for persistent storage.

### 5.1 Database prerequisites

Connect to the target Oracle DB as SYSDBA:

\`\`\`sql
-- FMW 12.2.1.4 requires Oracle DB 12.2.0.1 minimum (19c recommended)
SELECT version FROM v$instance;

-- AL32UTF8 character set is required
SELECT value FROM nls_database_parameters WHERE parameter = 'NLS_CHARACTERSET';

-- Verify undo tablespace is adequately sized (RCU generates significant undo)
SELECT tablespace_name, ROUND(SUM(bytes)/1073741824,2) AS size_gb
FROM dba_data_files WHERE tablespace_name = 'UNDOTBS1'
GROUP BY tablespace_name;
\`\`\`

Create a dedicated tablespace:

\`\`\`sql
CREATE TABLESPACE FMW_DATA
  DATAFILE '/u01/oradata/FMWDB/fmw_data01.dbf'
  SIZE 1G AUTOEXTEND ON NEXT 256M MAXSIZE 10G
  EXTENT MANAGEMENT LOCAL SEGMENT SPACE MANAGEMENT AUTO;
\`\`\`

### 5.2 Grant prerequisites to the RCU user

RCU connects as SYS, but the schemas it creates need specific grants. RCU handles this automatically when run as SYSDBA.

### 5.3 Run RCU

\`\`\`bash
/u01/app/oracle/product/fmw/infra/oracle_common/bin/rcu
\`\`\`

Wizard steps:

1. **Create Repository** — System Load and Product Load

2. **Database Connection Details**
   - Database Type: Oracle Database
   - Host Name: \`fmwdb.example.com\`
   - Port: \`1521\`
   - Service Name: \`FMWDB\`
   - Username: \`SYS\`, Role: SYSDBA

3. **Select Components** — Prefix: \`FMW\`, check:

   **AS Common Schemas (required for all FMW domains):**
   - Common Infrastructure Services — **STB**
   - Oracle Platform Security Services — **OPSS**
   - Audit Services — **IAU**
   - Audit Services Append — **IAU_APPEND**
   - Audit Services Viewer — **IAU_VIEWER**
   - Metadata Services — **MDS**
   - WebLogic Services — **WLS**

   Product schemas are added here when installing SOA Suite, OIM, OAM, etc. For a base Infrastructure-only install, the above seven are sufficient.

4. **Schema Passwords** — set passwords. Use the same password for all schemas during initial setup to simplify configuration.

5. **Map Tablespaces**
   - Set default tablespace to \`FMW_DATA\` for OPSS and MDS
   - Accept defaults for others (they are small)

6. **Summary** — review, then **Create**

7. **Completion Summary** — confirm all schemas created. Save the log file.

### 5.4 Verify schemas

\`\`\`sql
SELECT username, account_status, default_tablespace, created
FROM dba_users
WHERE username LIKE 'FMW%'
ORDER BY username;

-- All should show OPEN status
-- Expected: FMW_IAU, FMW_IAU_APPEND, FMW_IAU_VIEWER, FMW_MDS, FMW_OPSS, FMW_STB, FMW_WLS
\`\`\`

---

## Phase 6: Create the WebLogic Domain

### 6.1 Launch Configuration Wizard

\`\`\`bash
/u01/app/oracle/product/fmw/infra/oracle_common/common/bin/config.sh
\`\`\`

### 6.2 Wizard walkthrough

**Step 1 — Configuration Type**: Create a new domain

**Step 2 — Templates**: For a base JRF domain, select:
- Oracle JRF — \`jrf-template_12.2.1.jar\`
- Oracle Enterprise Manager — \`em-wls-template_12.2.1.jar\`
- WebLogic Coherence Cluster Extension — \`wlscoherence-template_12.2.1.jar\`

Product templates (SOA, OSB, OIM) are added here when installing those products on this Oracle Home. This base domain serves as the foundation — do not add product templates unless the product installer has already been run against this Oracle Home.

**Step 3 — Application Location**: \`/u01/app/oracle/config/applications/base_domain\`

**Step 4 — Administrator Account**: Set username (e.g., \`weblogic\`) and a strong password (min 8 chars, 1 numeric, 1 special character)

**Step 5 — Domain Mode and JDK**:
- Mode: **Production**
- JDK: \`/u01/app/oracle/product/jdk8\`

**Step 6 — Database Configuration Type**: RCU Data

**Step 7 — RCU Data**:
- Vendor: Oracle
- DBMS/Service: \`fmwdb.example.com:1521/FMWDB\`
- Schema Owner: \`FMW_STB\`
- Password: (STB schema password)
- Click **Get RCU Configuration** — auto-populates OPSS, MDS, IAU connection details

Run connection tests — all must pass.

**Step 8 — Advanced Configuration**: Check:
- Administration Server
- Node Manager
- Topology

**Step 9 — Administration Server**:
- Name: \`AdminServer\`
- Listen Port: \`7001\`
- SSL Listen Port: \`7002\` (optional)

**Step 10 — Managed Servers**: Add a managed server if needed, or skip for AdminServer-only deployment. For a pure infrastructure baseline with no product, one AdminServer is sufficient.

**Step 11 — Machines and Node Manager**:
- Machine Name: \`fmw_machine1\`
- Node Manager Type: Per Domain Custom Location
- NM Home: \`/u01/app/oracle/config/domains/base_domain/nodemanager\`
- NM Port: \`5556\`

**Step 12 — Configuration Summary**: Review, then **Create**

Domain creation takes 2–4 minutes.

---

## Phase 7: Post-Domain Patch Step — \`updateMatches\`

After domain creation, run the FMW patch assistant to apply any Oracle Home patches to the new domain's configuration:

\`\`\`bash
/u01/app/oracle/product/fmw/infra/oracle_common/bin/wlst.sh \\
  /u01/app/oracle/product/fmw/infra/oracle_common/common/wlst/wls.py
\`\`\`

For some patch bundles Oracle supplies a post-install script. Check the patch README:

\`\`\`bash
cat /tmp/<patch_dir>/README.txt | grep -A5 "Post-Installation"
\`\`\`

---

## Phase 8: Start the Domain

### 8.1 Create boot.properties for passwordless startup

\`\`\`bash
mkdir -p /u01/app/oracle/config/domains/base_domain/servers/AdminServer/security
cat > /u01/app/oracle/config/domains/base_domain/servers/AdminServer/security/boot.properties << 'EOF'
username=weblogic
password=<admin_password>
EOF
chmod 600 /u01/app/oracle/config/domains/base_domain/servers/AdminServer/security/boot.properties
\`\`\`

### 8.2 Start AdminServer

\`\`\`bash
nohup /u01/app/oracle/config/domains/base_domain/bin/startWebLogic.sh \\
  > /u01/app/oracle/config/domains/base_domain/servers/AdminServer/logs/AdminServer.out 2>&1 &

tail -f /u01/app/oracle/config/domains/base_domain/servers/AdminServer/logs/AdminServer.out
# Wait for: Server state changed to RUNNING
\`\`\`

### 8.3 Start Node Manager

\`\`\`bash
nohup /u01/app/oracle/config/domains/base_domain/bin/startNodeManager.sh \\
  > /u01/app/oracle/config/domains/base_domain/nodemanager/nodemanager.out 2>&1 &

# Wait for: Listener started on port 5556
\`\`\`

---

## Phase 9: Post-Install Verification

### 9.1 WebLogic Admin Console

\`http://<host>:7001/console\` — log in, confirm AdminServer is RUNNING.

### 9.2 EM Fusion Middleware Control

\`http://<host>:7001/em\` — log in. Confirm:
- WebLogic domain is visible
- No failed deployments
- OPSS, MDS datasources show Active status

### 9.3 OPSS and MDS connectivity

\`\`\`bash
# Confirm OPSS datasource from Admin Console:
# Home > Services > Data Sources > opss-data-source > Monitoring > Test

# Or via WLST:
/u01/app/oracle/product/fmw/infra/oracle_common/common/bin/wlst.sh << 'EOF'
connect('weblogic','<password>','t3://localhost:7001')
cd('/JDBCSystemResources/opss-data-source/JDBCResource/opss-data-source')
print(get('Name'))
exit()
EOF
\`\`\`

### 9.4 Verify OPSS keystore

\`\`\`bash
grep -i "opss\\|keystore\\|credential" \\
  /u01/app/oracle/config/domains/base_domain/servers/AdminServer/logs/AdminServer.log \\
  | grep -i "error\\|fail" | tail -10
# Should return no results if OPSS initialized cleanly
\`\`\`

### 9.5 Confirm OPatch inventory

\`\`\`bash
opatch lsinventory | grep -E "Oracle Home|Patch|WebLogic"
\`\`\`

---

## Phase 10: Directory Structure Reference

After a successful install, the Oracle Home contains:

\`\`\`
/u01/app/oracle/product/fmw/infra/
├── OPatch/              — OPatch utility for applying patches
├── coherence/           — Oracle Coherence data grid libraries
├── em/                  — Enterprise Manager FMW Control application
├── inventory/           — Oracle Universal Installer inventory (OH-level)
├── modules/             — OSGi and shared Java modules
├── oracle_common/       — JRF, OPSS, MDS, ADF shared libraries and tools
│   ├── bin/             — WLST, RCU, Config Wizard, opmnctl
│   ├── common/bin/      — config.sh, wlst.sh, pack.sh, unpack.sh
│   └── modules/         — shared module JARs
├── wlserver/            — WebLogic Server installation
│   ├── server/lib/      — weblogic.jar and WLS libraries
│   └── common/          — WLS common utilities
└── cfgtoollogs/         — Configuration Wizard and RCU logs
\`\`\`

Domain structure after \`config.sh\`:

\`\`\`
/u01/app/oracle/config/domains/base_domain/
├── bin/                 — startWebLogic.sh, stopWebLogic.sh, startNodeManager.sh
├── config/              — config.xml (domain configuration)
│   ├── config.xml
│   ├── jdbc/            — JDBC datasource descriptors
│   └── fmwconfig/       — JPS config, audit config
├── nodemanager/         — Node Manager data directory
├── servers/
│   └── AdminServer/
│       ├── logs/        — AdminServer.log, AdminServer.out
│       └── security/    — boot.properties
└── init-info/           — Domain creation logs
\`\`\`

---

## Phase 11: Ongoing Patching Workflow

FMW patches are released quarterly. The workflow for applying them to a running environment:

\`\`\`bash
# 1. Download patch from Oracle Support and unzip
unzip p<PATCH_ID>_122140_Generic.zip -d /tmp/patches/

# 2. Check for conflicts
opatch prereq CheckConflictAgainstOHWithDetail -ph /tmp/patches/<PATCH_ID>

# 3. Stop all managed servers in this Oracle Home
# (stop soa_server1, osb_server1, etc. if this OH hosts product servers)
# Stop AdminServer last

# 4. Apply patch
opatch apply /tmp/patches/<PATCH_ID>

# 5. For patches that include SQL changes, run post-patch SQL on SOAINFRA/MDS:
# /u01/app/oracle/product/fmw/infra/oracle_common/bin/wlst.sh
# Then call updateSchemas() if prompted by patch README

# 6. Start AdminServer and managed servers

# 7. Verify patch applied
opatch lspatches | grep <PATCH_ID>
\`\`\`

For patches requiring a complete Oracle Home shutdown, schedule a maintenance window. Apply the patch to a non-production Oracle Home first to validate.

---

## Troubleshooting

### AdminServer fails to start — JVM crash or OutOfMemoryError

The default JVM heap for AdminServer is often too small for a JRF domain with EM:

Edit \`/u01/app/oracle/config/domains/base_domain/bin/setUserOverrides.sh\`:

\`\`\`bash
#!/bin/bash
if [ "\${SERVER_NAME}" = "AdminServer" ]; then
  USER_MEM_ARGS="-Xms512m -Xmx1024m -XX:+UseG1GC"
  export USER_MEM_ARGS
fi
\`\`\`

### OPSS bootstrap fails — "Credential store not found"

Occurs when the OPSS schema password used in RCU does not match what was entered during domain creation. Re-run Config Wizard and re-enter RCU connection details, or manually update the OPSS datasource password in Admin Console.

### RCU fails with ORA-01031 (insufficient privileges)

The SYS account must connect with SYSDBA role, not just DBA. Verify the Role dropdown in the RCU connection screen shows SYSDBA.

### OPatch fails — "OUI-67302: Inventory could not be locked"

Another OPatch or installer process is running. Check:

\`\`\`bash
lsof /u01/app/oraInventory/.oracle_lock
\`\`\`

If stale, remove the lock file:

\`\`\`bash
rm /u01/app/oraInventory/.oracle_lock
\`\`\`

### config.sh fails on "Extracting domain" step

Usually a disk space issue under the domain home target. Verify:

\`\`\`bash
df -h /u01/app/oracle/config/
# Needs at least 2 GB free for a JRF domain
\`\`\`

---

## Rollback

\`\`\`bash
# 1. Stop all servers
/u01/app/oracle/config/domains/base_domain/bin/stopWebLogic.sh

# 2. Drop RCU schemas (as SYSDBA)
# Re-run RCU in Drop mode, or manually:
# DROP USER FMW_MDS CASCADE;
# DROP USER FMW_STB CASCADE;
# DROP USER FMW_OPSS CASCADE;
# DROP USER FMW_IAU CASCADE;
# DROP USER FMW_IAU_APPEND CASCADE;
# DROP USER FMW_IAU_VIEWER CASCADE;
# DROP USER FMW_WLS CASCADE;
# DROP TABLESPACE FMW_DATA INCLUDING CONTENTS AND DATAFILES;

# 3. Remove domain
rm -rf /u01/app/oracle/config/domains/base_domain
rm -rf /u01/app/oracle/config/applications/base_domain

# 4. Remove Oracle Home
rm -rf /u01/app/oracle/product/fmw/infra

# 5. Remove oraInventory if this is the only FMW install on the host
rm -rf /u01/app/oraInventory
\`\`\`

---

## Post-Install Checklist

- [ ] Oracle JDK 8 installed and \`java -version\` returns 1.8.0_361 or later
- [ ] FMW Infrastructure Oracle Home created at intended path
- [ ] \`weblogic.version\` returns 12.2.1.4.0
- [ ] OPatch version is 13.9.4.2.2 or later
- [ ] Latest quarterly patch applied and verified with \`opatch lspatches\`
- [ ] All RCU schemas created with OPEN status (STB, OPSS, IAU, IAU_APPEND, IAU_VIEWER, MDS, WLS)
- [ ] Domain created with Production mode and correct JDK path
- [ ] AdminServer starts and reaches RUNNING state
- [ ] Node Manager starts and listens on port 5556
- [ ] Admin Console accessible at \`:7001/console\`
- [ ] EM FMW Control accessible at \`:7001/em\`
- [ ] All JDBC datasources show Active in Admin Console
- [ ] \`boot.properties\` created with correct credentials (file mode 600)
- [ ] Oracle Home and domain paths documented for product installer runbooks`,
};

async function main() {
  console.log('Inserting FMW installation runbook...');
  await db.insert(posts).values(post).onConflictDoNothing();
  console.log(`Inserted: "${post.title}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
