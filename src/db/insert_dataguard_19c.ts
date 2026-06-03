import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const blogPost = {
  title: 'Oracle Data Guard 19c: Primary/Standby Setup and Failover',
  slug: 'oracle-data-guard-19c-setup-failover',
  excerpt:
    'A deep-dive into configuring Oracle Data Guard 19c with a physical standby — covering redo transport modes, log apply services, role transitions, and the difference between a graceful switchover and a fast-start failover.',
  category: 'oracle-database' as const,
  published: true,
  publishedAt: new Date('2026-06-03'),
  isPremium: false,
  youtubeUrl: null,
  content: `Oracle Data Guard is the foundation of high availability and disaster recovery for Oracle Database. Understanding it well means understanding the entire lifecycle: building the standby, keeping it in sync, verifying it, and — most critically — knowing exactly what happens when you trigger a role transition. This post focuses on 19c, the long-term support release that most production environments are running or targeting.

---

## Architecture Overview

Data Guard maintains one or more **standby databases** that are kept synchronised with a **primary database** by shipping and applying redo. The primary sends redo to standbys via dedicated network processes; standbys apply that redo and remain in a recoverable state, ready to become primary at any time.

### Standby Types

| Type | What It Stores | Openable Read-Only? | Use Case |
|---|---|---|---|
| **Physical standby** | Block-for-block copy via Media Recovery | Yes (Active Data Guard, extra licence) | DR, offload backups/reporting |
| **Logical standby** | SQL-level replica via LogMiner + SQL Apply | Yes, fully open | Reporting, rolling upgrades |
| **Snapshot standby** | Physical standby converted to writable for testing | Yes, writable | Testing patches without breaking DR |

Physical standby is the most common choice. It is simpler to manage, supports any object type, and has lower apply lag.

### Redo Transport Modes

The transport mode controls whether a commit on the primary waits for standby acknowledgement:

| Mode | Primary Waits For | Data Loss Risk | Typical Use |
|---|---|---|---|
| **SYNC** (LGWR SYNC) | Standby I/O acknowledgement before commit returns | Zero (RPO = 0) | Same-datacenter standby |
| **ASYNC** (LGWR ASYNC) | Nothing — redo is sent asynchronously | Up to network buffer lag | Cross-WAN standby |
| **FASTSYNC** | Standby redo receipt (not apply) before commit | Zero (RPO = 0) | Alternate to SYNC, less latency sensitive |

The \`LOG_ARCHIVE_DEST_n\` parameter controls transport; \`PROTECTION_MODE\` governs what level of acknowledgement is required for commit to succeed.

### Protection Modes

| Protection Mode | Requires | Behaviour if Standby Unavailable |
|---|---|---|
| **Maximum Protection** | SYNC to at least one standby | Primary shuts down |
| **Maximum Availability** | SYNC to at least one standby | Falls back to async — primary stays up |
| **Maximum Performance** | ASYNC | Primary unaffected — default |

Most shops run **Maximum Availability** with SYNC transport to a local standby, and ASYNC to a remote DR site.

---

## Key Processes

| Process | Location | Role |
|---|---|---|
| **LGWR / LNSn** | Primary | Redo log writer; LNS (Log Network Service) ships redo |
| **RFS** | Standby | Remote File Server — receives redo from primary, writes to standby redo logs |
| **MRP** | Standby | Managed Recovery Process — applies redo to the standby datafiles |
| **FAL** | Standby | Fetch Archive Log — requests missing archived logs from primary |

---

## Prerequisites

Before building the standby:

- Both servers must have the **same Oracle version and patch level** (including RU/RUR).
- The same \`ORACLE_SID\` can be used on standby, or a different name — but the **DB_UNIQUE_NAME must differ**.
- Standby server needs Oracle software installed, listener configured, and password file present.
- Network connectivity between primary and standby on the listener port (default 1521).
- Primary must be in **ARCHIVELOG mode** with \`FORCE LOGGING\` enabled.
- \`db_name\` must be identical; \`db_unique_name\` must be different.

---

## How Redo Flows

\`\`\`
Primary LGWR  ──► LNSn  ──►  [Network]  ──►  Standby RFS  ──►  Standby Redo Logs
                                                                         │
                                                                     MRP applies
                                                                         │
                                                                  Standby Datafiles
\`\`\`

When the standby redo log group fills, it is archived. MRP can apply from standby redo logs in real time (real-time apply) or wait for archives. Real-time apply is always preferred — it reduces apply lag to near zero.

---

## Role Transitions

### Switchover (Planned)

A switchover is a **graceful, zero-data-loss** role reversal — the current primary becomes a standby and the standby becomes primary. Used for planned maintenance: patching the primary OS, storage migrations, etc.

Steps at a high level:
1. Verify standby is in sync and no redo gaps exist.
2. Issue \`ALTER DATABASE COMMIT TO SWITCHOVER TO STANDBY\` on the primary.
3. Primary transitions to a mounted standby role.
4. Issue \`ALTER DATABASE COMMIT TO SWITCHOVER TO PRIMARY WITH SESSION SHUTDOWN\` on the standby.
5. Open the new primary: \`ALTER DATABASE OPEN\`.
6. Start MRP on the new standby.

No data is lost because the primary waits until all outstanding redo is acknowledged before completing step 2.

### Failover (Unplanned)

A failover is a **one-way** role transition used when the primary is unavailable and cannot be recovered quickly. The standby becomes the new primary, and the old primary must be **reinstated** (converted back to a standby) before it can rejoin Data Guard.

Steps:
1. Flush any redo the standby can still receive (\`ALTER SYSTEM FLUSH REDO TO target\`), if primary is still partially reachable.
2. Apply all available redo: \`ALTER DATABASE RECOVER MANAGED STANDBY DATABASE FINISH\`.
3. Failover: \`ALTER DATABASE COMMIT TO FAILOVER TO PRIMARY WITH SESSION SHUTDOWN\`.
4. Open the new primary: \`ALTER DATABASE OPEN RESETLOGS\`.
5. Reinstate old primary as standby via DGMGRL or manually using RMAN.

### Fast-Start Failover (FSFO)

FSFO is an automated failover triggered by the **Observer** process — a lightweight process that runs on a third host and monitors both primary and standby. When the primary is unreachable for longer than the \`FastStartFailoverThreshold\` (default 30 seconds), the Observer instructs the standby to failover automatically. FSFO requires:

- \`PROTECTION_MODE = Maximum Availability\` or higher.
- A synchronous standby.
- The Observer process running on a third host.

FSFO is the correct choice for environments where a human being cannot respond fast enough to an outage.

---

## Data Guard Broker (DGMGRL)

Oracle Data Guard Broker is the recommended management layer. It provides:

- A single interface (\`dgmgrl\`) to manage all members of a Data Guard configuration.
- Health checks and status across the configuration.
- Simplified switchover and failover commands.
- Integration with Grid Infrastructure for automatic Observer management.

In 19c, \`dgmgrl\` is the preferred tool. Manual \`ALTER DATABASE\` commands remain valid but are more error-prone.

---

## The Runbook

The companion runbook (linked below) walks through every step from a bare standby server to a working Data Guard configuration, including the switchover and failover procedures. It uses DGMGRL throughout for all post-build operations.

The runbook is structured as eight executable shell scripts:

1. **Preflight** — verify OS, network, Oracle install, and primary database settings
2. **Primary preparation** — ARCHIVELOG mode, FORCE LOGGING, supplemental logging, init params
3. **RMAN duplicate to standby** — build the physical standby from the active primary
4. **Data Guard Broker configuration** — enable broker, create configuration, verify
5. **Switchover test** — planned role reversal and reversal back
6. **Observer setup** — configure Fast-Start Failover and the Observer process
7. **Failover simulation** — controlled failover and old-primary reinstatement
8. **Ongoing health checks** — gap detection, apply lag, transport lag, alert log scanning
`,
};

const runbookPost = {
  title: 'Oracle Data Guard 19c Setup and Failover Runbook',
  slug: 'oracle-data-guard-19c-setup-failover-runbook',
  excerpt:
    'Step-by-step runbook for building an Oracle Data Guard 19c physical standby from scratch, configuring the Broker, testing switchover, setting up Fast-Start Failover with an Observer, performing a controlled failover, and reinstating the old primary.',
  category: 'oracle-database' as const,
  published: true,
  publishedAt: new Date('2026-06-03'),
  isPremium: true,
  youtubeUrl: null,
  content: `# Oracle Data Guard 19c Setup and Failover Runbook

## Overview

This runbook builds a two-node Oracle Data Guard 19c configuration (one primary, one physical standby) using RMAN active duplicate and Data Guard Broker. All role-transition procedures use DGMGRL.

**Assumptions:**
- Primary: \`primary.example.com\`, \`ORACLE_SID=ORCL\`, \`DB_UNIQUE_NAME=ORCL_PRI\`
- Standby: \`standby.example.com\`, \`ORACLE_SID=ORCL\`, \`DB_UNIQUE_NAME=ORCL_STB\`
- Oracle 19c (19.x RU) installed on both servers, same patch level
- Oracle user: \`oracle\`, ORACLE_HOME: \`/u01/app/oracle/product/19.0.0/dbhome_1\`
- ASM or filesystem storage — scripts use filesystem (\`/u02/oradata\`, \`/u03/fra\`)
- Listener running on 1521 on both servers

---

## Script 1 — Preflight Checks (run on both servers)

\`\`\`bash
#!/bin/bash
# dg_preflight.sh  — run as oracle on BOTH servers
set -euo pipefail
LOGFILE=/tmp/dg_preflight_\$(hostname -s)_\$(date +%Y%m%d_%H%M%S).log
exec > >(tee -a "\$LOGFILE") 2>&1

ORACLE_SID=ORCL
ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_SID ORACLE_HOME
PATH=\$ORACLE_HOME/bin:\$PATH

echo "===== Data Guard Preflight: \$(hostname) ====="
echo "Date: \$(date)"
echo ""

# ── Oracle binary version ─────────────────────────────────────────────────────
echo "[1] Oracle binary version"
\$ORACLE_HOME/bin/sqlplus -version | grep -i "SQL*Plus"
echo ""

# ── Patch level ───────────────────────────────────────────────────────────────
echo "[2] OPatch version and applied patches"
\$ORACLE_HOME/OPatch/opatch version
\$ORACLE_HOME/OPatch/opatch lsinventory -bugs_fixed 2>/dev/null | tail -20
echo ""

# ── Listener status ───────────────────────────────────────────────────────────
echo "[3] Listener status"
\$ORACLE_HOME/bin/lsnrctl status 2>&1 | grep -E 'Status|Service|PORT'
echo ""

# ── Network connectivity between nodes ───────────────────────────────────────
echo "[4] Network connectivity"
OTHER_HOST=\${1:-standby.example.com}}
ping -c 3 "\$OTHER_HOST" && echo "PING OK" || echo "PING FAILED — check network"
nc -z -w 5 "\$OTHER_HOST" 1521 && echo "Port 1521 OPEN" || echo "Port 1521 CLOSED — check firewall"
echo ""

# ── OS limits ─────────────────────────────────────────────────────────────────
echo "[5] OS limits for oracle user"
ulimit -a | grep -E 'open files|max user processes'
echo ""

# ── Storage — check oradata and fra directories ───────────────────────────────
echo "[6] Storage"
df -h /u02 /u03 2>/dev/null || echo "/u02 or /u03 not found — adjust paths for your storage layout"
echo ""

# ── Password file present ─────────────────────────────────────────────────────
echo "[7] Password file"
ls -lh "\$ORACLE_HOME/dbs/orapw\${ORACLE_SID}" 2>/dev/null || \
  ls -lh "\$ORACLE_BASE/dbs/orapw\${ORACLE_SID}" 2>/dev/null || \
  echo "Password file NOT found — create with: orapwd file=\$ORACLE_HOME/dbs/orapw\$ORACLE_SID password=<SYS_PWD> entries=5"
echo ""

# ── On primary only: check ARCHIVELOG and FORCE LOGGING ──────────────────────
echo "[8] Primary database mode (run on primary only — will show error on standby)"
sqlplus -s / as sysdba <<'SQLEOF'
  set lines 120 pages 0 feedback off
  select 'LOG_MODE='||log_mode||
         '  FORCE_LOGGING='||force_logging||
         '  DB_UNIQUE_NAME='||db_unique_name
  from   v\$database;
SQLEOF
echo ""

echo "===== Preflight complete. Review output above. ====="
\`\`\`

---

## Script 2 — Primary Database Preparation

\`\`\`bash
#!/bin/bash
# dg_prepare_primary.sh  — run as oracle on PRIMARY
set -euo pipefail
LOGFILE=/tmp/dg_prepare_primary_\$(date +%Y%m%d_%H%M%S).log
exec > >(tee -a "\$LOGFILE") 2>&1

ORACLE_SID=ORCL
ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
ORACLE_BASE=/u01/app/oracle
DB_UNIQUE_NAME_PRI=ORCL_PRI
DB_UNIQUE_NAME_STB=ORCL_STB
STANDBY_HOST=standby.example.com
PRIMARY_HOST=primary.example.com
FRA_DEST=/u03/fra
LOG_SIZE_MB=200
STANDBY_REDO_GROUPS=4        # should be primary redo groups + 1
export ORACLE_SID ORACLE_HOME
PATH=\$ORACLE_HOME/bin:\$PATH

echo "===== Primary Preparation: \$(hostname) ====="

sqlplus -s / as sysdba <<SQLEOF
-- ─── Enable ARCHIVELOG mode ───────────────────────────────────────────────────
whenever sqlerror exit failure
set lines 160 pages 0 feedback on

select 'Current log_mode: '||log_mode from v\$database;

declare
  v_mode varchar2(20);
begin
  select log_mode into v_mode from v\$database;
  if v_mode != 'ARCHIVELOG' then
    execute immediate 'shutdown immediate';
    execute immediate 'startup mount';
    execute immediate 'alter database archivelog';
    execute immediate 'alter database open';
    dbms_output.put_line('ARCHIVELOG mode enabled.');
  else
    dbms_output.put_line('Already in ARCHIVELOG mode.');
  end if;
end;
/

-- ─── Enable FORCE LOGGING ─────────────────────────────────────────────────────
alter database force logging;
select 'FORCE_LOGGING: '||force_logging from v\$database;

-- ─── Enable supplemental logging (required for logical standby / GoldenGate) ─
alter database add supplemental log data;

-- ─── Standby redo logs ────────────────────────────────────────────────────────
-- One more group than the primary, same size as primary redo logs.
-- Adjust group numbers and sizes to match your environment.
alter database add standby logfile thread 1
  group 11 ('\$FRA_DEST/\${DB_UNIQUE_NAME_PRI}}/standby_redo11.log') size \${LOG_SIZE_MB}}M;
alter database add standby logfile thread 1
  group 12 ('\$FRA_DEST/\${DB_UNIQUE_NAME_PRI}}/standby_redo12.log') size \${LOG_SIZE_MB}}M;
alter database add standby logfile thread 1
  group 13 ('\$FRA_DEST/\${DB_UNIQUE_NAME_PRI}}/standby_redo13.log') size \${LOG_SIZE_MB}}M;
alter database add standby logfile thread 1
  group 14 ('\$FRA_DEST/\${DB_UNIQUE_NAME_PRI}}/standby_redo14.log') size \${LOG_SIZE_MB}}M;

select group#, members, bytes/1048576 mb, status from v\$standby_log order by 1;

-- ─── Data Guard init parameters ───────────────────────────────────────────────
alter system set db_unique_name='\${DB_UNIQUE_NAME_PRI}}' scope=spfile;
alter system set log_archive_config='DG_CONFIG=(\${DB_UNIQUE_NAME_PRI}},\${DB_UNIQUE_NAME_STB}})' scope=both;
alter system set log_archive_dest_1='LOCATION=USE_DB_RECOVERY_FILE_DEST VALID_FOR=(ALL_LOGFILES,ALL_ROLES) DB_UNIQUE_NAME=\${DB_UNIQUE_NAME_PRI}}' scope=both;
alter system set log_archive_dest_2='SERVICE=\${DB_UNIQUE_NAME_STB}} LGWR ASYNC VALID_FOR=(ONLINE_LOGFILES,PRIMARY_ROLE) DB_UNIQUE_NAME=\${DB_UNIQUE_NAME_STB}}' scope=both;
alter system set log_archive_dest_state_1=ENABLE scope=both;
alter system set log_archive_dest_state_2=ENABLE scope=both;
alter system set remote_login_passwordfile=EXCLUSIVE scope=spfile;
alter system set log_archive_format='%t_%s_%r.dbf' scope=spfile;
alter system set log_archive_max_processes=4 scope=both;
alter system set fal_server='\${DB_UNIQUE_NAME_STB}}' scope=both;
alter system set fal_client='\${DB_UNIQUE_NAME_PRI}}' scope=both;
alter system set standby_file_management=AUTO scope=both;
alter system set db_file_name_convert='\${DB_UNIQUE_NAME_STB}}','\${DB_UNIQUE_NAME_PRI}}' scope=spfile;
alter system set log_file_name_convert='\${DB_UNIQUE_NAME_STB}}','\${DB_UNIQUE_NAME_PRI}}' scope=spfile;

-- ─── DB_RECOVERY_FILE_DEST ────────────────────────────────────────────────────
alter system set db_recovery_file_dest='\$FRA_DEST' scope=both;
alter system set db_recovery_file_dest_size=50G scope=both;

-- ─── Enable Data Guard Broker ─────────────────────────────────────────────────
alter system set dg_broker_start=TRUE scope=both;

select name, value from v\$parameter
where name in ('db_unique_name','log_archive_config','dg_broker_start','remote_login_passwordfile')
order by 1;

SQLEOF

echo ""
echo "===== Primary preparation complete. ====="
echo "Next: add TNS entries on both servers, then run dg_build_standby.sh"
\`\`\`

---

## Script 3 — TNS Entries (add to tnsnames.ora on both servers)

Add the following to \`\$ORACLE_HOME/network/admin/tnsnames.ora\` on **both** servers:

\`\`\`bash
#!/bin/bash
# dg_tns_setup.sh  — run as oracle on BOTH servers
ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
TNS_FILE=\$ORACLE_HOME/network/admin/tnsnames.ora

cat >> "\$TNS_FILE" << 'TNSEOF'

ORCL_PRI =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = primary.example.com)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = ORCL)
      (UR = A)
    )
  )

ORCL_STB =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = standby.example.com)(PORT = 1521))
    (CONNECT_DATA =
      (SERVER = DEDICATED)
      (SERVICE_NAME = ORCL)
      (UR = A)
    )
  )
TNSEOF

echo "TNS entries added to \$TNS_FILE"

# Verify connectivity from this server to both nodes
\$ORACLE_HOME/bin/tnsping ORCL_PRI
\$ORACLE_HOME/bin/tnsping ORCL_STB
\`\`\`

---

## Script 4 — Build Physical Standby with RMAN Active Duplicate

\`\`\`bash
#!/bin/bash
# dg_build_standby.sh  — run as oracle on STANDBY SERVER
# The RMAN DUPLICATE command connects to the primary and copies the database over the network.
set -euo pipefail
LOGFILE=/tmp/dg_build_standby_\$(date +%Y%m%d_%H%M%S).log
exec > >(tee -a "\$LOGFILE") 2>&1

ORACLE_SID=ORCL
ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
ORACLE_BASE=/u01/app/oracle
DB_UNIQUE_NAME_STB=ORCL_STB
DB_UNIQUE_NAME_PRI=ORCL_PRI
ORADATA=/u02/oradata/\$DB_UNIQUE_NAME_STB
FRA_DEST=/u03/fra/\$DB_UNIQUE_NAME_STB
LOG_SIZE_MB=200
export ORACLE_SID ORACLE_HOME
PATH=\$ORACLE_HOME/bin:\$PATH

read -rsp "Enter SYS password: " SYS_PASS; echo

echo "===== Build Physical Standby via RMAN Active Duplicate ====="

# ── Create directories on standby ────────────────────────────────────────────
mkdir -p "\$ORADATA" "\$FRA_DEST"
mkdir -p "\$ORACLE_BASE/admin/\$ORACLE_SID/adump"

# ── Minimal init.ora for standby (enough to start in nomount) ────────────────
cat > \$ORACLE_HOME/dbs/init\${ORACLE_SID}.ora <<INIEOF
db_name=ORCL
db_unique_name=\$DB_UNIQUE_NAME_STB
INIEOF

# ── Start standby instance in NOMOUNT ────────────────────────────────────────
sqlplus -s / as sysdba << 'SQLEOF'
  startup nomount pfile='/u01/app/oracle/product/19.0.0/dbhome_1/dbs/initORCL.ora';
  exit;
SQLEOF

echo "Standby instance started in NOMOUNT — beginning RMAN active duplicate..."
echo "(This will take time proportional to database size — do not interrupt)"

# ── RMAN Active Duplicate ─────────────────────────────────────────────────────
rman target sys/\$SYS_PASS@ORCL_PRI auxiliary sys/\$SYS_PASS@ORCL_STB <<RMANEOF
duplicate target database for standby from active database
  spfile
    parameter_value_convert '\${DB_UNIQUE_NAME_PRI}}','\${DB_UNIQUE_NAME_STB}}'
  set db_unique_name='\${DB_UNIQUE_NAME_STB}}'
  set db_recovery_file_dest='\$FRA_DEST'
  set db_recovery_file_dest_size='50G'
  set log_archive_dest_1='LOCATION=USE_DB_RECOVERY_FILE_DEST VALID_FOR=(ALL_LOGFILES,ALL_ROLES) DB_UNIQUE_NAME=\${DB_UNIQUE_NAME_STB}}'
  set fal_server='\${DB_UNIQUE_NAME_PRI}}'
  set fal_client='\${DB_UNIQUE_NAME_STB}}'
  set log_archive_config='DG_CONFIG=(\${DB_UNIQUE_NAME_PRI}},\${DB_UNIQUE_NAME_STB}})'
  set standby_file_management='AUTO'
  set dg_broker_start='TRUE'
  nofilenamecheck;
RMANEOF

echo ""
echo "===== RMAN duplicate complete. Verifying standby is mounted... ====="

sqlplus -s / as sysdba << 'SQLEOF'
  set lines 120 pages 0 feedback off
  select 'DB_UNIQUE_NAME='||db_unique_name||
         '  ROLE='||database_role||
         '  OPEN_MODE='||open_mode
  from v\$database;
  exit;
SQLEOF

# ── Add standby redo logs on standby ─────────────────────────────────────────
sqlplus -s / as sysdba << SQLEOF
  alter database add standby logfile thread 1
    group 11 ('\$FRA_DEST/standby_redo11.log') size \${LOG_SIZE_MB}M;
  alter database add standby logfile thread 1
    group 12 ('\$FRA_DEST/standby_redo12.log') size \${LOG_SIZE_MB}M;
  alter database add standby logfile thread 1
    group 13 ('\$FRA_DEST/standby_redo13.log') size \${LOG_SIZE_MB}M;
  alter database add standby logfile thread 1
    group 14 ('\$FRA_DEST/standby_redo14.log') size \${LOG_SIZE_MB}M;
  exit;
SQLEOF

# ── Start Managed Recovery ────────────────────────────────────────────────────
sqlplus -s / as sysdba << 'SQLEOF'
  alter database recover managed standby database using current logfile disconnect;
  exit;
SQLEOF

echo ""
echo "===== Standby is live. MRP started (real-time apply). ====="
echo "Verify apply lag with: select name, value, time_computed from v\$dataguard_stats where name in ('transport lag','apply lag');"
\`\`\`

---

## Script 5 — Data Guard Broker Configuration

\`\`\`bash
#!/bin/bash
# dg_broker_setup.sh  — run as oracle on PRIMARY
set -euo pipefail
LOGFILE=/tmp/dg_broker_setup_\$(date +%Y%m%d_%H%M%S).log
exec > >(tee -a "\$LOGFILE") 2>&1

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_HOME
PATH=\$ORACLE_HOME/bin:\$PATH

read -rsp "Enter SYS password: " SYS_PASS; echo

echo "===== Data Guard Broker Configuration ====="

dgmgrl sys/\$SYS_PASS@ORCL_PRI <<'DGEOF'
-- Create the broker configuration
create configuration 'DG_ORCL' as
  primary database is 'ORCL_PRI'
  connect identifier is ORCL_PRI;

-- Add the physical standby
add database 'ORCL_STB' as
  connect identifier is ORCL_STB
  maintained as physical;

-- Enable the configuration (starts redo transport and log apply if not running)
enable configuration;

-- Wait a moment and check health
show configuration;
show database verbose 'ORCL_PRI';
show database verbose 'ORCL_STB';
DGEOF

echo ""
echo "===== Broker configuration complete. ====="
echo "Expected output: 'ORA-16819: fast-start failover observer not started' is normal at this stage."
echo "Configuration status should be: SUCCESS or WARNING (pending observer)."
\`\`\`

### Verify Transport and Apply Lag

\`\`\`sql
-- Run on primary
set lines 160 pages 50
col name format a25
col value format a20
col time_computed format a30
select name, value, time_computed
from   v\$dataguard_stats
where  name in ('transport lag','apply lag','apply finish time')
order by name;

-- Verify redo gap
select thread#, low_sequence#, high_sequence#
from   v\$archive_gap;
-- Should return no rows.

-- MRP status on standby
select process, status, sequence#, block#, active_agents, known_agents
from   v\$managed_standby
where  process in ('MRP0','RFS')
order by process;
\`\`\`

---

## Script 6 — Switchover Test (Planned Role Reversal)

Run this during a maintenance window to validate the configuration before you need it in anger.

\`\`\`bash
#!/bin/bash
# dg_switchover.sh  — run as oracle on PRIMARY
# After switchover, STANDBY becomes primary and PRIMARY becomes standby.
set -euo pipefail
LOGFILE=/tmp/dg_switchover_\$(date +%Y%m%d_%H%M%S).log
exec > >(tee -a "\$LOGFILE") 2>&1

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_HOME
PATH=\$ORACLE_HOME/bin:\$PATH

read -rsp "Enter SYS password: " SYS_PASS; echo

echo "===== Switchover: Primary → Standby ====="
echo "Current time: \$(date)"

dgmgrl sys/\$SYS_PASS@ORCL_PRI <<'DGEOF'
-- Verify readiness before proceeding
validate database 'ORCL_STB';
show configuration;

-- Perform switchover
-- DGMGRL handles all steps: drains sessions, ships final redo, transitions roles
switchover to 'ORCL_STB';

-- After switchover, ORCL_STB is the new primary.
-- Connect to new primary to verify.
connect sys@ORCL_STB
show configuration;
show database verbose 'ORCL_STB';
show database verbose 'ORCL_PRI';
DGEOF

echo ""
echo "===== Switchover complete. ====="
echo "ORCL_STB is now primary. ORCL_PRI is now standby."
echo "Verify applications can connect to the new primary."
echo "To switch back, run this script again (swapping the target to ORCL_PRI)."
\`\`\`

### Switch Back

\`\`\`bash
# After verifying the new primary, switch back in the same maintenance window:
dgmgrl sys/\$SYS_PASS@ORCL_STB <<'EOF'
switchover to 'ORCL_PRI';
show configuration;
EOF
\`\`\`

---

## Script 7 — Fast-Start Failover and Observer Setup

\`\`\`bash
#!/bin/bash
# dg_fsfo_setup.sh  — run as oracle on the OBSERVER HOST (third server)
# The observer must be on a separate host — not primary or standby.
set -euo pipefail

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
OBSERVER_LOG=/u01/app/oracle/admin/fsfo_observer.log
export ORACLE_HOME
PATH=\$ORACLE_HOME/bin:\$PATH

read -rsp "Enter SYS password: " SYS_PASS; echo

echo "===== Fast-Start Failover Configuration ====="

dgmgrl sys/\$SYS_PASS@ORCL_PRI <<'DGEOF'
-- Set protection mode to Maximum Availability (required for FSFO)
edit configuration set protection mode as maxavailability;

-- Set SYNC transport on the standby
edit database 'ORCL_STB' set property LogXptMode='SYNC';

-- Set FSFO threshold (seconds of primary unreachability before failover)
edit configuration set property FastStartFailoverThreshold = 30;

-- Enable Fast-Start Failover targeting the standby
enable fast_start failover;

show configuration;
DGEOF

echo ""
echo "Starting Observer (foreground — use nohup or systemd for production)..."
echo "Observer log: \$OBSERVER_LOG"

# Start observer — this blocks; run in background or via systemd in production
nohup dgmgrl -logfile "\$OBSERVER_LOG" sys/\$SYS_PASS@ORCL_PRI "start observer" &
OBSERVER_PID=\$!
echo "Observer started with PID \$OBSERVER_PID"

sleep 15
echo "Observer status:"
dgmgrl sys/\$SYS_PASS@ORCL_PRI "show observer"
\`\`\`

### Observer systemd Unit

\`\`\`ini
# /etc/systemd/system/oracle-dg-observer.service
[Unit]
Description=Oracle Data Guard Observer
After=network.target

[Service]
Type=simple
User=oracle
Environment=ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
Environment=PATH=/u01/app/oracle/product/19.0.0/dbhome_1/bin:/usr/bin:/bin
ExecStart=/u01/app/oracle/product/19.0.0/dbhome_1/bin/dgmgrl -logfile /u01/app/oracle/admin/fsfo_observer.log sys/<SYS_PASS>@ORCL_PRI "start observer"
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
\`\`\`

> **Security note:** Replace \`<SYS_PASS>\` with the actual password, then \`chmod 640\` and \`chown root:oracle\` the unit file, or use a wallet/external password store.

---

## Script 8 — Controlled Failover and Reinstatement

Use this procedure when the primary is down and cannot be recovered within your RTO.

\`\`\`bash
#!/bin/bash
# dg_failover.sh  — run as oracle on STANDBY (new primary after failover)
set -euo pipefail
LOGFILE=/tmp/dg_failover_\$(date +%Y%m%d_%H%M%S).log
exec > >(tee -a "\$LOGFILE") 2>&1

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_HOME
PATH=\$ORACLE_HOME/bin:\$PATH

read -rsp "Enter SYS password: " SYS_PASS; echo

echo "===== Data Guard Failover ====="
echo "WARNING: This is a one-way operation. The old primary must be reinstated."
echo "Current time: \$(date)"

# ── Step 1: Attempt to flush redo from primary (if partially reachable) ──────
echo "[1] Attempting to flush outstanding redo from primary (may fail if primary is down)..."
sqlplus -s sys/\$SYS_PASS@ORCL_STB as sysdba <<'SQLEOF' || echo "Flush failed or primary unreachable — continuing"
  alter system flush redo to 'ORCL_PRI';
  exit;
SQLEOF

# ── Step 2: Finish recovery — apply all available redo ───────────────────────
echo "[2] Finishing recovery — applying all available redo..."
sqlplus -s / as sysdba <<'SQLEOF'
  alter database recover managed standby database finish;
  exit;
SQLEOF

# ── Step 3: Failover via DGMGRL ───────────────────────────────────────────────
echo "[3] Executing failover..."
dgmgrl sys/\$SYS_PASS@ORCL_STB <<'DGEOF'
failover to 'ORCL_STB';
show configuration;
DGEOF

# ── Step 4: Verify new primary is open ───────────────────────────────────────
echo "[4] Verifying new primary..."
sqlplus -s sys/\$SYS_PASS@ORCL_STB as sysdba <<'SQLEOF'
  select 'ROLE='||database_role||'  OPEN_MODE='||open_mode from v\$database;
  exit;
SQLEOF

echo ""
echo "===== Failover complete. ORCL_STB is now primary. ====="
echo ""
echo "Next steps:"
echo "  1. Point applications to \$ORACLE_STB (update SCAN/load balancer/TNS)"
echo "  2. When old primary is recovered, reinstate it as standby (Script 8b below)"
\`\`\`

### Script 8b — Reinstate Old Primary as Standby

After the old primary host is repaired and the Oracle instance can start:

\`\`\`bash
#!/bin/bash
# dg_reinstate.sh  — run as oracle on OLD PRIMARY (now being reinstated as standby)
set -euo pipefail
LOGFILE=/tmp/dg_reinstate_\$(date +%Y%m%d_%H%M%S).log
exec > >(tee -a "\$LOGFILE") 2>&1

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
ORACLE_SID=ORCL
export ORACLE_HOME ORACLE_SID
PATH=\$ORACLE_HOME/bin:\$PATH

read -rsp "Enter SYS password: " SYS_PASS; echo

echo "===== Reinstate Old Primary as Standby ====="

# Start old primary in MOUNT state (not OPEN)
sqlplus / as sysdba <<'SQLEOF'
  startup mount;
  exit;
SQLEOF

# Reinstate via DGMGRL — connect to the CURRENT primary (ORCL_STB)
dgmgrl sys/\$SYS_PASS@ORCL_STB <<'DGEOF'
reinstate database 'ORCL_PRI';
show configuration;
show database verbose 'ORCL_PRI';
DGEOF

echo ""
echo "===== Reinstatement complete. ====="
echo "ORCL_PRI is now a physical standby. Verify MRP is running and apply lag is closing."
\`\`\`

---

## Script 9 — Ongoing Health Checks

\`\`\`bash
#!/bin/bash
# dg_health_check.sh  — run as oracle on PRIMARY (or any node)
# Safe to run at any time. No changes made.
set -euo pipefail

ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
export ORACLE_HOME
PATH=\$ORACLE_HOME/bin:\$PATH

read -rsp "Enter SYS password: " SYS_PASS; echo

TIMESTAMP=\$(date +%Y-%m-%d\ %H:%M:%S)
echo "===== Data Guard Health Check: \$TIMESTAMP ====="

# ── DGMGRL configuration overview ────────────────────────────────────────────
echo ""
echo "[1] Broker configuration status"
dgmgrl -silent sys/\$SYS_PASS@ORCL_PRI <<'DGEOF'
show configuration;
show database verbose 'ORCL_PRI';
show database verbose 'ORCL_STB';
show fast_start failover;
DGEOF

# ── Transport and apply lag ───────────────────────────────────────────────────
echo ""
echo "[2] Transport and apply lag (from primary)"
sqlplus -s sys/\$SYS_PASS@ORCL_PRI as sysdba <<'SQLEOF'
  set lines 160 pages 50
  col name format a25
  col value format a20
  col time_computed format a30
  select name, value, time_computed
  from   v\$dataguard_stats
  where  name in ('transport lag','apply lag','apply finish time','estimated startup time')
  order by 1;
SQLEOF

# ── Archive gap check ─────────────────────────────────────────────────────────
echo ""
echo "[3] Archive gap check (no rows = healthy)"
sqlplus -s sys/\$SYS_PASS@ORCL_PRI as sysdba <<'SQLEOF'
  set lines 120 pages 50
  select thread#, low_sequence#, high_sequence#
  from   v\$archive_gap;
SQLEOF

# ── Standby: MRP and RFS process status ──────────────────────────────────────
echo ""
echo "[4] MRP and RFS status (from standby)"
sqlplus -s sys/\$SYS_PASS@ORCL_STB as sysdba <<'SQLEOF'
  set lines 160 pages 50
  col process format a10
  col status  format a15
  col client_process format a20
  select process, status, sequence#, block#, active_agents, known_agents
  from   v\$managed_standby
  where  process in ('MRP0','RFS','ARCH')
  order by process, sequence#;
SQLEOF

# ── Last 5 archived logs on standby (confirm archives arriving) ──────────────
echo ""
echo "[5] Last 5 archived logs registered on standby"
sqlplus -s sys/\$SYS_PASS@ORCL_STB as sysdba <<'SQLEOF'
  set lines 160 pages 50
  col name format a70
  select sequence#, first_time, next_time, applied, name
  from   v\$archived_log
  where  standby_dest = 'NO'
  order by sequence# desc
  fetch first 5 rows only;
SQLEOF

# ── Alert log scan for ORA- errors (last 100 lines) ──────────────────────────
echo ""
echo "[6] Alert log ORA- errors (last 100 lines, primary)"
ALERT_LOG_PRI=\$(find /u01/app/oracle/diag -name alert_ORCL.log 2>/dev/null | grep -i ORCL_PRI | head -1)
if [[ -f "\$ALERT_LOG_PRI" ]]; then
  tail -100 "\$ALERT_LOG_PRI" | grep -E 'ORA-|Error|error' || echo "No ORA- errors in last 100 lines."
else
  echo "Alert log not found at \$ALERT_LOG_PRI — check ADR_HOME."
fi

echo ""
echo "===== Health check complete: \$(date) ====="
\`\`\`

---

## Common Issues and Fixes

### ORA-16009: redo transport is suspended

The standby archive destination is in error state. Check:

\`\`\`sql
-- On primary
col status format a15
col error  format a60
select dest_id, target, archiver, schedule, destination, status, error
from   v\$archive_dest
where  target = 'STANDBY';
\`\`\`

Common causes: password file mismatch, listener not running on standby, TNS misconfiguration.

Fix password file mismatch — copy primary password file to standby:

\`\`\`bash
scp \$ORACLE_HOME/dbs/orapwORCL oracle@standby.example.com:\$ORACLE_HOME/dbs/orapwORCL
\`\`\`

### ORA-16191: Primary log shipping client not logged on standby

The standby RFS process cannot authenticate. Verify \`remote_login_passwordfile=EXCLUSIVE\` on both instances and that the password file on the standby matches the primary's SYS password.

### Apply Lag Growing / MRP Not Running

\`\`\`sql
-- On standby — restart MRP with real-time apply
alter database recover managed standby database cancel;
alter database recover managed standby database using current logfile disconnect;
\`\`\`

### Redo Gap

\`\`\`sql
-- On primary — force archive of current log to trigger FAL gap resolution
alter system archive log current;
-- FAL (Fetch Archive Log) on standby will automatically request missing sequences
\`\`\`

### Configuration Status: ORA-16820 (fast-start failover observer not started)

The FSFO observer process is not running. Restart it on the observer host:

\`\`\`bash
nohup dgmgrl sys/\$SYS_PASS@ORCL_PRI "start observer" > /u01/app/oracle/admin/fsfo_observer.log 2>&1 &
\`\`\`

---

## Post-Switchover Checklist

After any role transition, verify:

- [ ] Applications can connect to the new primary
- [ ] DGMGRL \`show configuration\` shows SUCCESS
- [ ] MRP is running on the new standby (\`v\$managed_standby\`)
- [ ] No archive gaps (\`v\$archive_gap\`)
- [ ] Apply lag is under 30 seconds and closing
- [ ] Observer (if FSFO enabled) is connected to new primary
- [ ] Monitoring/alerting tools updated to point to new primary
- [ ] Backup jobs verified on new primary (RMAN catalog updated)
`,
};

async function main() {
  await db.insert(posts).values(blogPost);
  console.log('inserted:', blogPost.slug);

  await db.insert(posts).values(runbookPost);
  console.log('inserted:', runbookPost.slug);
}

main().catch(console.error);
