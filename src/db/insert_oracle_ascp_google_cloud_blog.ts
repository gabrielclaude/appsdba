import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle ASCP on RHEL9 on Google Cloud: Architecture, EBS Integration, and What to Watch For',
  slug: 'oracle-ascp-rhel9-google-cloud-architecture',
  excerpt:
    'A deep-dive blog on running Oracle Advanced Supply Chain Planning on RHEL 9 in Google Cloud — how ASCP fits into EBS, what changes on GCP, and the database management problems that trip up every deployment.',
  category: 'oracle-google-cloud' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-22'),
  youtubeUrl: null,
  content: `Oracle Advanced Supply Chain Planning (ASCP) is one of the most operationally complex Oracle E-Business Suite modules to run in the cloud. It sits at the intersection of EBS transactional data, a separate planning database schema, and a native C++ planning engine binary — and each of those layers behaves differently on GCP and RHEL 9 compared to a traditional on-premises deployment.

This post documents the architecture, the EBS integration mechanics, and — most importantly — the database management problems that routinely surface in GCP/RHEL 9 deployments.

---

## ASCP Architecture Overview

Oracle ASCP is not a standalone application. It is a planning engine that runs against a dedicated schema — the MSC (Manufacturing Supply Chain) schema — that lives in the same Oracle Database as EBS or in a separate planning instance.

\`\`\`
┌──────────────────────────────────────────────────────────────┐
│  EBS Application Tier (GCE instance, RHEL 9)                │
│                                                              │
│  Oracle Applications (Forms, OAF, Concurrent Manager)       │
│  ┌───────────────────┐  ┌──────────────────────────────┐    │
│  │  EBS Operational  │  │  ASCP Planning Engine        │    │
│  │  DB (APPLSYS, GL, │  │  (mscnsp / mscfnclp binary)  │    │
│  │  INV, BOM, WIP)   │  │  Reads MSC schema            │    │
│  └─────────┬─────────┘  └──────────────┬───────────────┘    │
│            │ Collection                │ Plan results        │
│            ▼                           ▼                     │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Oracle Database (OD@GC Exadata or GCE VM)          │    │
│  │                                                      │    │
│  │  EBS Schemas: APPLSYS, GL, AP, INV, BOM, WIP        │    │
│  │  ODS (Operational Data Store): snapshot of EBS data  │    │
│  │  MSC Schema: planning data (supplies, demands, items)│    │
│  └─────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
\`\`\`

### The ODS and MSC Schemas

Collection is the process by which ASCP copies data from EBS operational tables into the ODS (a staging layer), then transforms ODS data into the MSC schema's planning model.

Key MSC tables and their EBS source:

| MSC Table | EBS Source | Description |
|-----------|-----------|-------------|
| MSC_SYSTEM_ITEMS | MTL_SYSTEM_ITEMS_B | Items and planning attributes |
| MSC_SUPPLIES | WIP_DISCRETE_JOBS, PO_HEADERS_ALL | On-hand inventory and WIP |
| MSC_DEMANDS | OE_ORDER_LINES_ALL, MRP_GROSS_REQUIREMENTS | Sales orders and forecasts |
| MSC_BOM_COMPONENTS | BOM_COMPONENTS_B | Bill of Materials |
| MSC_ROUTINGS | BOM_OPERATIONAL_ROUTINGS | Manufacturing routings |
| MSC_CALENDAR_DATES | BOM_CALENDAR_DATES | Working calendars |

### The Planning Engine Binary

ASCP's planning engine — \`mscnsp\` (the solver) and \`mscfnclp\` (the collection process) — are native C++ binaries compiled for the target OS and architecture. They are NOT Java applications. This matters for RHEL 9 compatibility: these binaries link against the system glibc, and glibc changed significantly between RHEL 7 (glibc 2.17) and RHEL 9 (glibc 2.34).

---

## What Changes on GCP vs. On-Premises

### Compute: GCE Instance Selection

For ASCP application tiers (where the mscnsp binary runs), CPU speed matters more than core count. ASCP's plan solver is partially serialized — it does not scale linearly with more CPUs for single-plan runs.

Recommended GCE instance families:
- **C3 series** (c3-highcpu-44, c3-highcpu-88): high per-core clock speed, ideal for ASCP solver workload
- **N2D series**: AMD EPYC, cost-effective for collection-only nodes

Avoid:
- **T2D**: designed for sustained throughput workloads, not the bursty, high-single-thread-performance ASCP solver

### Storage: Persistent Disk vs. Exadata

The MSC schema contains large tables (MSC_SUPPLIES, MSC_DEMANDS, MSC_BOM_COMPONENTS) that ASCP's collection process writes heavily and the planning engine reads sequentially. Storage choice is significant.

| Storage Option | Throughput | ASCP Impact |
|---------------|-----------|------------|
| Standard PD (pd-standard) | 120 MB/s | Plan runs 3–5x slower than on-prem |
| SSD PD (pd-ssd) | 1,200 MB/s | Comparable to on-prem SAN |
| Extreme PD (pd-extreme) | 2,400 MB/s | Exceeds most on-prem SAN |
| OD@GC Exadata | 40,000+ MB/s | Best option; Smart Scan for collection queries |

For MSC schema databases: use pd-ssd minimum, pd-extreme or OD@GC Exadata for production planning databases processing > 1M items.

### Network: Latency Between App Tier and DB

ASCP collection makes thousands of small queries against EBS operational tables followed by large bulk inserts into MSC tables. The app-tier-to-DB latency matters.

Rule: deploy the GCE ASCP application server in the same GCP zone as the OD@GC Exadata or GCE DB instance. Cross-zone latency (2–5ms) is acceptable; cross-region latency (50–100ms) will degrade collection run times dramatically.

\`\`\`bash
# Measure latency from ASCP app tier to Oracle DB
ping -c 20 <oracle_db_scan_ip>
# Target: < 1ms average for same-zone deployment
\`\`\`

---

## RHEL 9-Specific Considerations

### Oracle Database and ASCP Certification on RHEL 9

Oracle Database 19c requires patch set 19.17+ (RU 19.17.0.0) for RHEL 9 support. Earlier patch sets will fail OS prerequisite checks.

\`\`\`bash
# Verify Oracle patch level on DB server
$ORACLE_HOME/OPatch/opatch lsinventory | grep "Oracle Database 19c"
# Must show 19.17.0.0 or higher for RHEL 9 support
\`\`\`

### oracle-database-preinstall-19c on RHEL 9

The preinstall RPM automates kernel parameter and OS limit configuration. On RHEL 9, the RPM name changed:

\`\`\`bash
# RHEL 8 and earlier
sudo yum install oracle-database-preinstall-19c

# RHEL 9 (package available in Oracle Linux 9 repo or RHEL 9 with Oracle repo enabled)
sudo dnf install oracle-database-preinstall-19c
\`\`\`

Verify the key parameters it sets:

\`\`\`bash
sysctl kernel.shmmax   # Should be: 137438953472 (128 GB)
sysctl kernel.shmmni   # Should be: 4096
ulimit -n              # Should be: 65536 (open files)
ulimit -u              # Should be: 16384 (max user processes)
\`\`\`

### Transparent Hugepages on RHEL 9

RHEL 9 uses the \`tuned\` service to manage system profiles. For Oracle Database + ASCP:

\`\`\`bash
sudo tuned-adm profile oracle
# This profile: disables THP, sets kernel.numa_balancing=0, optimizes for Oracle workload

# Verify THP is disabled
cat /sys/kernel/mm/transparent_hugepage/enabled
# Should show: [never]
\`\`\`

### SELinux on GCP RHEL 9

GCP RHEL 9 images ship with SELinux in enforcing mode. Oracle DB installation requires specific file contexts:

\`\`\`bash
# Check SELinux status
sestatus

# If enforcing, set Oracle binary context
sudo semanage fcontext -a -t oracle_db_t "/u01/app/oracle(/.*)?"
sudo restorecon -Rv /u01/app/oracle

# If SELinux blocks Oracle startup (check /var/log/audit/audit.log):
sudo ausearch -c 'oracle' --raw | audit2allow -M oracle-policy
sudo semodule -i oracle-policy.pp
\`\`\`

---

## Known Database Management Problems on GCP/RHEL 9

These are the issues that appear in GCP/RHEL 9 ASCP deployments that do not occur on traditional on-premises configurations.

### Problem 1: MSCNSP Signal 11 (SIGSEGV) After Clone

**Symptom**: The ASCP planning engine (mscnsp) crashes with SIGSEGV immediately after the ASCP environment is cloned from production to non-production.

**Root cause**: ASCP's mscnsp binary loads shared libraries using absolute paths stored in the ASCP environment's Oracle Applications context file ($CONTEXT_FILE). After a clone, these paths still point to the source (production) system's directory layout, which either does not exist or contains the wrong content on the target (non-production) system.

**Resolution**:

\`\`\`bash
# Step 1: Verify the mismatch
echo $APPL_TOP          # Should point to current system
cat $CONTEXT_FILE | grep msc_top  # Look for wrong paths

# Step 2: Update library paths
cd $AD_TOP/bin
perl adupdlibpath.pl contextfile=$CONTEXT_FILE

# Step 3: Relink ASCP binaries
cd $MSC_TOP/bin
adrelink.sh force=y "msc mscnsp"

# Step 4: Re-run AutoConfig to regenerate all EBS config files
cd $AD_TOP/bin
perl adautocfg.pl appspass=<apps_password>

# Step 5: Bounce Concurrent Manager and retry plan
\`\`\`

### Problem 2: ORA-04031 During Collection on GCP

**Symptom**: Collection concurrent program fails with ORA-04031: unable to allocate X bytes of shared memory in shared pool.

**Root cause**: GCE instances default to a smaller SGA than typical on-premises Exadata. ASCP collection uses large SORT operations and PL/SQL stored procedures that require substantial shared pool for package caching. On GCP VMs with 64 GB RAM configured for SGA, shared_pool_size is often under-allocated.

**Diagnosis**:

\`\`\`sql
-- Check shared pool free memory
SELECT name, bytes/1024/1024 mb FROM v$sgastat
WHERE pool = 'shared pool' AND name IN ('free memory', 'sql area', 'library cache')
ORDER BY bytes DESC;

-- Check shared pool advice
SELECT shared_pool_size_for_estimate/1024/1024 mb,
       estd_lc_time_saved_factor,
       estd_lc_memory_object_hits
FROM v$shared_pool_advice;
\`\`\`

**Resolution**:

\`\`\`sql
-- Increase shared pool (adjust to 20-25% of SGA for ASCP workloads)
ALTER SYSTEM SET shared_pool_size = 4G SCOPE=SPFILE;
ALTER SYSTEM SET shared_pool_reserved_size = 400M SCOPE=SPFILE;

-- Restart DB and retry collection
SHUTDOWN IMMEDIATE;
STARTUP;
\`\`\`

### Problem 3: GCP VPC Firewall Drops Idle TCP Connections

**Symptom**: ASCP collection fails mid-run with ORA-03113 (end-of-file on communication channel) or ORA-03114 (not connected to Oracle). The failure occurs approximately 30 minutes after a period of low ASCP activity (e.g., during a long-running PL/SQL calculation step that generates no SQL traffic).

**Root cause**: GCP VPC's stateful firewall has a default TCP idle timeout of 1800 seconds (30 minutes). If the connection between the ASCP app tier and Oracle DB is idle for > 30 minutes, GCP silently drops the TCP session. Oracle only detects this when it next tries to send data through the dead connection.

**Resolution** — set sqlnet.expire_time in sqlnet.ora on the Oracle server:

\`\`\`
# $TNS_ADMIN/sqlnet.ora on Oracle DB server
SQLNET.EXPIRE_TIME = 10
# Sends a probe packet every 10 minutes on idle connections
# Keeps GCP firewall state alive and allows Oracle to detect dead connections
\`\`\`

Also set on the ASCP application tier's sqlnet.ora. Verify with:

\`\`\`bash
grep -i expire $ORACLE_HOME/network/admin/sqlnet.ora
\`\`\`

### Problem 4: Persistent Disk I/O Bottleneck During Plan Runs

**Symptom**: ASCP plan runs that completed in 2 hours on-premises take 8+ hours on a GCE instance with pd-standard storage.

**Diagnosis**:

\`\`\`bash
# On GCE DB host during plan run - check I/O device utilization
iostat -xm 5 | grep -E "Device|sdb|nvme"
# If %util > 80% for the data disk during plan run → storage bottleneck

# In Oracle DB: check wait events during plan run
SELECT event, total_waits, time_waited/100 secs_waited
FROM v$session_event
WHERE sid = (SELECT sid FROM v$session WHERE program LIKE '%mscnsp%')
ORDER BY time_waited DESC;
# High "db file scattered read" + high %util on OS → I/O bottleneck confirmed
\`\`\`

**Resolution**:

\`\`\`bash
# Upgrade disk type (live disk resize on GCE)
gcloud compute disks update oracle-data-disk \
  --zone=us-east4-b \
  --type=pd-ssd

# For immediate relief without disk migration: pre-warm the disk
fio --name=warmup --filename=/dev/sdb --rw=read --bs=128k --runtime=300 --time_based
\`\`\`

---

## Checking MSC Schema Health

\`\`\`sql
-- Collection status for last 5 runs
SELECT request_id, phase_code, status_code,
       actual_start_date, actual_completion_date,
       round((actual_completion_date - actual_start_date)*24*60, 1) dur_mins
FROM fnd_concurrent_requests
WHERE concurrent_program_id = (
  SELECT concurrent_program_id FROM fnd_concurrent_programs
  WHERE concurrent_program_name = 'MSCSCH'
  AND application_id = 724)
ORDER BY request_id DESC
FETCH FIRST 5 ROWS ONLY;

-- MSC key table row counts (plan health indicator)
SELECT 'MSC_SUPPLIES' tbl, COUNT(*) cnt FROM msc.msc_supplies WHERE plan_id = -1
UNION ALL
SELECT 'MSC_DEMANDS', COUNT(*) FROM msc.msc_demands WHERE plan_id = -1
UNION ALL
SELECT 'MSC_SYSTEM_ITEMS', COUNT(*) FROM msc.msc_system_items WHERE plan_id = -1;

-- Plan run status
SELECT plan_name, data_completion_date, last_run_duration_mins, plan_run_status
FROM msc_plans
ORDER BY data_completion_date DESC NULLS LAST
FETCH FIRST 10 ROWS ONLY;
\`\`\`

---

## Summary

Running ASCP on RHEL 9 on GCP is fully viable, but it requires attention to four infrastructure layers that differ from on-premises deployments: OS configuration (RHEL 9 preinstall RPM, THP, SELinux), Oracle DB configuration (RHEL 9 minimum patchset, shared pool sizing), network configuration (TCP keepalive for GCP firewall), and storage selection (pd-ssd minimum for production planning databases).

The four known failure patterns — signal 11 after clone, ORA-04031 during collection, TCP connection drops, and persistent disk I/O bottleneck — each have deterministic root causes and straightforward resolutions once identified. The companion runbook provides step-by-step procedures for each.`,
};

async function main() {
  console.log('Inserting Oracle ASCP on RHEL9 on Google Cloud blog post...');
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
