import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const blogPost = {
  title: 'Oracle GoldenGate 21c Initial Load: Methods, SCN Coordination, and HANDLECOLLISIONS',
  slug: 'goldengate-21c-initial-load',
  excerpt:
    'A practical guide to the GoldenGate 21c initial load — the process of seeding the target database before enabling ongoing replication — covering the three main load methods, the critical SCN coordination problem, the HANDLECOLLISIONS overlap window, and how to choose the right approach based on data volume and downtime tolerance.',
  category: 'golden-gate' as const,
  published: true,
  publishedAt: new Date('2026-06-03'),
  isPremium: false,
  youtubeUrl: null,
  content: `Before ongoing replication can begin, the target database must be populated with a consistent copy of the source data — and that copy must be coordinated precisely with the point in the redo stream where GoldenGate's change capture Extract begins reading. Get this coordination wrong and you end up with either missing rows, duplicate rows, or a Replicat that immediately abends on key violations. This is the initial load problem, and it is the step where most new GoldenGate implementations stumble.

---

## Why Initial Load Is a Separate Step

GoldenGate's ongoing Integrated Extract reads Oracle redo logs and captures every committed DML change. It does not, and cannot, replay the full history of a table from the beginning of time. When you first point an Extract at a source database, it begins capturing changes from that moment forward — but the target table starts empty.

You need two things to happen in coordination:

1. **A consistent snapshot** of the source data at a known point in time (System Change Number — SCN).
2. **Change capture starting from that exact SCN**, so that any DML that arrives after the snapshot is captured and applied to the target on top of the snapshot data.

If the snapshot is taken at SCN 1,000,000 and change capture begins at SCN 1,000,050, you have a 50-SCN gap — any rows inserted or updated during that gap will never reach the target. If change capture begins at SCN 999,000 (before the snapshot), you will try to apply inserts for rows that are already in the target from the Data Pump import — which is handled, but requires the \`HANDLECOLLISIONS\` parameter.

The industry-standard pattern is: **start change capture first, record the SCN, then take the snapshot using that SCN as the flashback point.** This creates a deliberate overlap window that is safely managed with \`HANDLECOLLISIONS\`.

---

## The Three Initial Load Methods

### Method 1: Data Pump Export/Import with GoldenGate SCN Coordination (Recommended)

The most reliable method for large datasets. Data Pump's \`FLASHBACK_SCN\` parameter produces a logically consistent export as of a specific SCN, even if DML is running against the source during the export. GoldenGate's CDC Extract starts before the export and captures all changes from that SCN forward. After the import completes on the target, Replicat starts at the Data Pump SCN and replays the captured changes forward, making the target consistent with the source.

**Best for:** Production databases of any size, zero or minimal application downtime.

### Method 2: GoldenGate SOURCEISTABLE Extract (Direct Table Read)

A special GoldenGate Extract mode that reads directly from the source tables (not from the redo log) and sends rows to the target via a trail file or direct-load Replicat. No Data Pump required. The Extract reads table data sequentially and writes it as if it were a stream of INSERTs.

**Best for:** Smaller datasets (under ~50 GB), non-production initial loads, schemas where Data Pump is unavailable or impractical.

### Method 3: Direct Bulk Load (SQL*Loader / External Tables)

Generate a flat file export from the source and load it using SQL*Loader or external tables on the target. GoldenGate then takes over from the SCN at which the export was taken. Rarely used for Oracle-to-Oracle replication but useful when the source and target are on different database platforms.

**Best for:** Cross-platform initial loads, very large tables where Data Pump performance is inadequate.

---

## SCN Coordination: The Critical Step

The most common question in GoldenGate initial load setups is: *which SCN do I use?*

\`\`\`sql
-- On the SOURCE database: capture the current SCN BEFORE starting the Data Pump export
-- This is the SCN you will use for both the FLASHBACK_SCN in Data Pump
-- and the aftercsn/atcsn positioning of the Replicat

SELECT current_scn FROM v\$database;
-- Record this value: e.g. 4872309011

-- Also capture the Extract trail file position at this point
-- (done via adminclient — see runbook Script 2)
\`\`\`

The sequence must be:
1. Start the CDC Extract (\`EXT_ORCL\`) — it begins writing to the trail file.
2. Capture the current SCN from \`v\$database\` — call this the **load SCN**.
3. Run Data Pump export with \`FLASHBACK_SCN=<load SCN>\`.
4. Transfer dump files to target and run Data Pump import.
5. Position Replicat to start at \`aftercsn <load SCN>\`.
6. Start Replicat with \`HANDLECOLLISIONS\` active.
7. Once Replicat has caught up to current, disable \`HANDLECOLLISIONS\`.

The Extract has been capturing every change since step 1. After import, the target has data as of the load SCN. Replicat replays all changes from the load SCN forward — some of which may be rows already present from the import (hence the need for \`HANDLECOLLISIONS\`).

---

## Understanding HANDLECOLLISIONS

\`HANDLECOLLISIONS\` is a Replicat parameter that instructs it to silently absorb certain DML errors that are expected during the initial catch-up period:

| Error | Without HANDLECOLLISIONS | With HANDLECOLLISIONS |
|---|---|---|
| INSERT of a row that already exists (from Data Pump import) | Replicat abends with ORA-00001 (unique constraint) | Converts INSERT to UPDATE; applies the row |
| DELETE of a row that does not exist | Replicat abends with "no rows affected" | Silently ignored |
| UPDATE of a row that does not exist | Replicat abends | Converts UPDATE to INSERT if possible |

Once Replicat has caught up to the current point in the trail and the overlap window has passed, \`HANDLECOLLISIONS\` must be removed. Leaving it enabled permanently masks genuine data integrity issues in production replication.

**The rule:** Add \`HANDLECOLLISIONS\` to the Replicat parameter file before starting the initial catch-up. Once the Replicat lag drops to zero (or within your acceptable threshold), remove the parameter and issue \`SEND REPLICAT REP_ORCL, NOHANDLECOLLISIONS\` to apply the change without a restart.

---

## Parallel Replicat for Initial Load Performance

GoldenGate 21c introduced **Parallel Replicat (Integrated)**, which splits the incoming trail into parallel apply streams based on data dependencies. For initial load catch-up with a large backlog of trail data, this dramatically reduces convergence time.

\`\`\`
-- In the Replicat parameter file:
REPLICAT REP_ORCL
USERIDALIAS tgtdb DOMAIN OracleGoldenGate
MAP hr.*, TARGET hr.*;
HANDLECOLLISIONS

-- Add the replicat as integrated parallel:
-- add replicat REP_ORCL, parallel, integrated, exttrail ./dirdat/rt ...
\`\`\`

Parallel Integrated Replicat is recommended for any initial load with more than a few hours of trail backlog.

---

## Choosing the Right Method

| Factor | Use Data Pump + GoldenGate | Use SOURCEISTABLE |
|---|---|---|
| Data volume | Any size — Data Pump handles TB-scale | Best under 50 GB |
| Source DB load | Data Pump at FLASHBACK_SCN adds minimal overhead | Extra DB connections reading tables |
| Downtime tolerance | Near-zero downtime with overlap window | Minimal, but target is empty during load |
| Network bandwidth | Dump file transfer can be parallelised | Trail file streamed in real time |
| Complexity | Higher (SCN coordination, Replicat positioning) | Lower (GoldenGate manages SCN internally) |
| Audit/compliance | Full export file retained | No intermediate file |

For any production-scale Oracle-to-Oracle replication setup, the Data Pump + SCN coordination method is the correct choice. The SOURCEISTABLE method is appropriate for developer environments, smaller schemas, and situations where a Data Pump export is not feasible.

The runbook that accompanies this post provides the complete step-by-step procedure for both methods with all commands, validation checks, and the HANDLECOLLISIONS removal checklist.
`,
};

const runbookPost = {
  title: 'Runbook: GoldenGate 21c Initial Load — Data Pump SCN Method and SOURCEISTABLE',
  slug: 'goldengate-21c-initial-load-runbook',
  excerpt:
    'Step-by-step scripts for GoldenGate 21c initial load using both the Data Pump FLASHBACK_SCN method and the SOURCEISTABLE direct-read method — SCN capture, Extract start, Data Pump export/import coordination, Replicat positioning, HANDLECOLLISIONS management, convergence monitoring, and cutover validation.',
  category: 'golden-gate' as const,
  published: true,
  publishedAt: new Date('2026-06-03'),
  isPremium: true,
  youtubeUrl: null,
  content: `This runbook completes the initial load steps for a GoldenGate 21c environment built using the [GoldenGate 21c installation runbook](/posts/goldengate-21c-installation-microservices-runbook). It assumes the Extract (\`EXT_ORCL\`), Distribution Path (\`DP_TO_TGT\`), and Replicat (\`REP_ORCL\`) have been created but **not yet started**.

Two methods are provided:
- **Method A** — Data Pump \`FLASHBACK_SCN\` (production-recommended, any data volume)
- **Method B** — \`SOURCEISTABLE\` direct read (dev/test, smaller schemas)

Run one method only. Method A is documented first and in full.

Set these before starting:

\`\`\`bash
export OGG_ADMIN_USER=oggadmin
export OGG_ADMIN_PORT=9012
export OGG_DEPLOYMENT=ora21c
export DB_CONN_SRC=ORCLSRC
export DB_CONN_TGT=ORCLTGT
export OGG_HOME=/u01/app/oracle/goldengate/21c
export OGG_VAR_HOME=/u01/app/oracle/gg_deployments/ora21c
export DUMP_DIR=/u01/datapump_dumps     # host path — must match Oracle directory object
export ORACLE_HOME=/u01/app/oracle/product/19.3.0/dbhome_1
export PATH=\${ORACLE_HOME}/bin:\${OGG_HOME}/bin:\${PATH}
export LD_LIBRARY_PATH=\${ORACLE_HOME}/lib:\${OGG_HOME}/lib:\${LD_LIBRARY_PATH:-}
\`\`\`

---

## METHOD A: Data Pump + SCN Coordination

### Script A-1: Start CDC Extract and Capture the Load SCN (Source Server)

This is the most important step. The Extract must be running before the SCN is captured.

\`\`\`bash
#!/bin/bash
# gg_initial_load_a1_start_extract.sh
# Run as oracle on SOURCE server

set -euo pipefail
source ~/.bash_profile

read -rsp "GoldenGate Admin Console password: " OGG_ADMIN_PASS; echo
read -rsp "GGS DB user (c##ggadmin) password: " GG_DB_PASS; echo

echo "[$(date +%H:%M:%S)] Starting CDC Extract EXT_ORCL..."

adminclient << ADMEOF
connect http://localhost:\${OGG_ADMIN_PORT} deployment \${OGG_DEPLOYMENT} as \${OGG_ADMIN_USER} password \${OGG_ADMIN_PASS}
start extract EXT_ORCL
info extract EXT_ORCL
exit
ADMEOF

# Wait for Extract to reach RUNNING state
echo -n "  Waiting for Extract to reach RUNNING state..."
for i in \$(seq 1 30); do
  STATUS=\$(curl -s -u "\${OGG_ADMIN_USER}:\${OGG_ADMIN_PASS}" \
    "http://localhost:\${OGG_ADMIN_PORT}/services/v2/extracts/EXT_ORCL/status" \
    2>/dev/null | python3 -c \
    "import sys,json; print(json.load(sys.stdin).get('response',{}).get('status',''))" \
    2>/dev/null)
  [ "\$STATUS" = "RUNNING" ] && { echo " RUNNING."; break; }
  sleep 3; echo -n "."
  [ "\$i" -eq 30 ] && { echo " TIMEOUT — check Extract logs."; exit 1; }
done

# Capture the SCN immediately after confirming Extract is running
LOAD_SCN=\$(sqlplus -s c##ggadmin/\${GG_DB_PASS}@\${DB_CONN_SRC} << SQLEOF 2>/dev/null
SET PAGES 0 FEEDBACK OFF HEADING OFF
SELECT current_scn FROM v\\\$database;
EXIT;
SQLEOF
)
LOAD_SCN=\$(echo "\$LOAD_SCN" | tr -d ' \n')

echo ""
echo "[$(date +%H:%M:%S)] *** LOAD SCN = \${LOAD_SCN} ***"
echo "  Save this value — it is needed for Data Pump export and Replicat positioning."
echo "\$LOAD_SCN" > /tmp/gg_load_scn.txt
echo "[$(date +%H:%M:%S)] SCN written to /tmp/gg_load_scn.txt"

# Also record the Extract trail position at this SCN for reference
adminclient << ADMEOF2
connect http://localhost:\${OGG_ADMIN_PORT} deployment \${OGG_DEPLOYMENT} as \${OGG_ADMIN_USER} password \${OGG_ADMIN_PASS}
info extract EXT_ORCL, detail
exit
ADMEOF2
\`\`\`

---

### Script A-2: Data Pump Export from Source (Source Server)

\`\`\`bash
#!/bin/bash
# gg_initial_load_a2_datapump_export.sh
# Run as oracle on SOURCE server

set -euo pipefail
source ~/.bash_profile

LOAD_SCN=\$(cat /tmp/gg_load_scn.txt | tr -d ' \n')
[ -z "\$LOAD_SCN" ] && { echo "ERROR: /tmp/gg_load_scn.txt not found — run Script A-1 first"; exit 1; }

echo "[$(date +%H:%M:%S)] Starting Data Pump export at FLASHBACK_SCN=\${LOAD_SCN}..."

# Create Oracle directory object if it doesn't exist
sqlplus -s / as sysdba << SQLEOF
CREATE OR REPLACE DIRECTORY gg_dp_dir AS '\${DUMP_DIR}';
GRANT READ, WRITE ON DIRECTORY gg_dp_dir TO c##ggadmin;
EXIT;
SQLEOF

mkdir -p "\$DUMP_DIR"
DUMP_FILE="gg_load_\${LOAD_SCN}_%U.dmp"
LOG_FILE="gg_load_\${LOAD_SCN}.log"

expdp c##ggadmin/\${GG_DB_PASS}@\${DB_CONN_SRC} \
  directory=gg_dp_dir \
  dumpfile="\${DUMP_FILE}" \
  logfile="\${LOG_FILE}" \
  schemas=HR \
  flashback_scn=\${LOAD_SCN} \
  parallel=4 \
  compression=ALL \
  cluster=NO

echo "[$(date +%H:%M:%S)] Data Pump export complete"
echo "  Dump files : \${DUMP_DIR}/\${DUMP_FILE}"
echo "  Log        : \${DUMP_DIR}/\${LOG_FILE}"
ls -lh \${DUMP_DIR}/gg_load_\${LOAD_SCN}*.dmp

# Verify export SCN in the log — must match LOAD_SCN
echo ""
grep -iE "flashback|scn|estimate|exported" "\${DUMP_DIR}/\${LOG_FILE}" | tail -20
\`\`\`

---

### Script A-3: Transfer Dump Files and Import on Target (Both Servers)

\`\`\`bash
#!/bin/bash
# gg_initial_load_a3_transfer_import.sh
# Transfer: run on source server to push to target
# Import:   run on target server

set -euo pipefail
source ~/.bash_profile

LOAD_SCN=\$(cat /tmp/gg_load_scn.txt | tr -d ' \n')
TARGET_HOST=target.example.com       # FQDN or IP of target server
TARGET_DUMP_DIR=/u01/datapump_dumps
TARGET_SSH_USER=oracle

# ── TRANSFER: run on source ────────────────────────────────────────────────
echo "[$(date +%H:%M:%S)] Transferring dump files to \$TARGET_HOST..."
ssh \${TARGET_SSH_USER}@\${TARGET_HOST} "mkdir -p \${TARGET_DUMP_DIR}"

rsync -avz --progress \
  \${DUMP_DIR}/gg_load_\${LOAD_SCN}*.dmp \
  \${DUMP_DIR}/gg_load_\${LOAD_SCN}.log \
  \${TARGET_SSH_USER}@\${TARGET_HOST}:\${TARGET_DUMP_DIR}/

echo "[$(date +%H:%M:%S)] Transfer complete"

# ── IMPORT: run on target server ───────────────────────────────────────────
# SSH to target and run the import (or run directly if on target already)
ssh \${TARGET_SSH_USER}@\${TARGET_HOST} bash << REMOTE
set -euo pipefail
source ~/.bash_profile

# Create directory object on target DB
sqlplus -s / as sysdba << SQLEOF
CREATE OR REPLACE DIRECTORY gg_dp_dir AS '\${TARGET_DUMP_DIR}';
GRANT READ, WRITE ON DIRECTORY gg_dp_dir TO ggadmin;
EXIT;
SQLEOF

echo "[\$(date +%H:%M:%S)] Starting Data Pump import on target..."

impdp ggadmin/\${GG_DB_PASS}@\${DB_CONN_TGT} \
  directory=gg_dp_dir \
  dumpfile="gg_load_\${LOAD_SCN}_%U.dmp" \
  logfile="gg_import_\${LOAD_SCN}.log" \
  schemas=HR \
  remap_schema=HR:HR \
  parallel=4 \
  cluster=NO \
  table_exists_action=REPLACE

echo "[\$(date +%H:%M:%S)] Data Pump import complete"
grep -E "imported|error|ORA-" \${TARGET_DUMP_DIR}/gg_import_\${LOAD_SCN}.log | tail -20
REMOTE
\`\`\`

---

### Script A-4: Position Replicat and Enable HANDLECOLLISIONS (Target Server)

\`\`\`bash
#!/bin/bash
# gg_initial_load_a4_position_replicat.sh
# Run as oracle on TARGET server

set -euo pipefail
source ~/.bash_profile

# Retrieve the load SCN (copy /tmp/gg_load_scn.txt from source if needed)
LOAD_SCN=\$(cat /tmp/gg_load_scn.txt | tr -d ' \n')
[ -z "\$LOAD_SCN" ] && { echo "ERROR: LOAD_SCN not set — copy /tmp/gg_load_scn.txt from source"; exit 1; }

read -rsp "GoldenGate Admin Console password: " OGG_ADMIN_PASS; echo

echo "[$(date +%H:%M:%S)] Configuring Replicat REP_ORCL for initial load catch-up..."
echo "  Load SCN: \$LOAD_SCN"

# ── Add HANDLECOLLISIONS to the Replicat parameter file ───────────────────
# First retrieve current params, then rewrite with HANDLECOLLISIONS added
CURRENT_PARAMS=\$(curl -s -u "\${OGG_ADMIN_USER}:\${OGG_ADMIN_PASS}" \
  "http://localhost:\${OGG_ADMIN_PORT}/services/v2/replicats/REP_ORCL/parameterFile" \
  2>/dev/null | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print(d.get('response',{}).get('content',''))" \
  2>/dev/null)

# Append HANDLECOLLISIONS if not already present
if echo "\$CURRENT_PARAMS" | grep -qi "HANDLECOLLISIONS"; then
  echo "  HANDLECOLLISIONS already in parameter file"
else
  NEW_PARAMS="\${CURRENT_PARAMS}
HANDLECOLLISIONS"
  curl -s -u "\${OGG_ADMIN_USER}:\${OGG_ADMIN_PASS}" \
    -X PUT "http://localhost:\${OGG_ADMIN_PORT}/services/v2/replicats/REP_ORCL/parameterFile" \
    -H "Content-Type: application/json" \
    -d "{\"content\":\"\$(echo "\$NEW_PARAMS" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))" | tr -d '\"')\"}" \
    > /dev/null
  echo "  HANDLECOLLISIONS added to parameter file"
fi

# ── Position Replicat at the load SCN ─────────────────────────────────────
adminclient << ADMEOF
connect http://localhost:\${OGG_ADMIN_PORT} deployment \${OGG_DEPLOYMENT} as \${OGG_ADMIN_USER} password \${OGG_ADMIN_PASS}
alter replicat REP_ORCL, aftercsn \${LOAD_SCN}
info replicat REP_ORCL, detail
exit
ADMEOF

echo "[$(date +%H:%M:%S)] Replicat positioned at SCN \${LOAD_SCN} with HANDLECOLLISIONS active"
echo "  Proceed to Script A-5 to start Replicat."
\`\`\`

---

### Script A-5: Start Replicat and Monitor Convergence (Target Server)

\`\`\`bash
#!/bin/bash
# gg_initial_load_a5_start_monitor.sh
# Run as oracle on TARGET server — starts Replicat and monitors lag to zero

set -euo pipefail
source ~/.bash_profile

read -rsp "GoldenGate Admin Console password: " OGG_ADMIN_PASS; echo

echo "[$(date +%H:%M:%S)] Starting Replicat REP_ORCL..."

adminclient << ADMEOF
connect http://localhost:\${OGG_ADMIN_PORT} deployment \${OGG_DEPLOYMENT} as \${OGG_ADMIN_USER} password \${OGG_ADMIN_PASS}
start replicat REP_ORCL
exit
ADMEOF

# ── Monitor lag until convergence ─────────────────────────────────────────
echo "[$(date +%H:%M:%S)] Monitoring Replicat lag (checking every 60s)..."
echo "  Ctrl-C to stop monitoring; process continues in background."
echo ""
printf "  %-25s  %-12s  %-12s  %-10s\n" "Timestamp" "Status" "Lag (HH:MI:SS)" "Trail Seq"
printf "  %-25s  %-12s  %-12s  %-10s\n" "-------------------------" "------------" "------------" "----------"

CONVERGED=false
while true; do
  REP_INFO=\$(curl -s -u "\${OGG_ADMIN_USER}:\${OGG_ADMIN_PASS}" \
    "http://localhost:\${OGG_ADMIN_PORT}/services/v2/replicats/REP_ORCL" \
    2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin).get('response', {})
status = d.get('status', 'UNKNOWN')
lag    = d.get('lag', 'N/A')
seq    = d.get('positionSCN', 'N/A')
print(f'{status}|{lag}|{seq}')
" 2>/dev/null || echo "UNKNOWN|N/A|N/A")

  STATUS=\$(echo "\$REP_INFO" | cut -d'|' -f1)
  LAG=\$(echo "\$REP_INFO" | cut -d'|' -f2)
  SEQ=\$(echo "\$REP_INFO" | cut -d'|' -f3)

  printf "  %-25s  %-12s  %-12s  %-10s\n" "\$(date '+%Y-%m-%d %H:%M:%S')" "\$STATUS" "\$LAG" "\$SEQ"

  # Check for ABEND
  if [ "\$STATUS" = "ABENDED" ]; then
    echo ""
    echo "  [ERROR] Replicat ABENDED — check logs:"
    echo "    \${OGG_VAR_HOME}/deployments/\${OGG_DEPLOYMENT}/var/log/REP_ORCL*.log"
    exit 1
  fi

  # Lag at zero = convergence
  if echo "\$LAG" | grep -qE "^00:00:0[0-9]$"; then
    echo ""
    echo "[$(date +%H:%M:%S)] *** Replicat lag is at zero — initial load catch-up COMPLETE ***"
    CONVERGED=true
    break
  fi

  sleep 60
done

if \$CONVERGED; then
  echo "[$(date +%H:%M:%S)] Proceed to Script A-6 to remove HANDLECOLLISIONS."
fi
\`\`\`

---

### Script A-6: Remove HANDLECOLLISIONS and Validate (Target Server)

\`\`\`bash
#!/bin/bash
# gg_initial_load_a6_remove_handlecollisions.sh
# Run ONLY after Replicat lag has reached zero

set -euo pipefail
source ~/.bash_profile

read -rsp "GoldenGate Admin Console password: " OGG_ADMIN_PASS; echo
read -rsp "GGS DB user password (target ggadmin): " GG_DB_PASS_TGT; echo
read -rsp "GGS DB user password (source c##ggadmin): " GG_DB_PASS_SRC; echo

# ── Confirm lag is still zero before proceeding ───────────────────────────
LAG=\$(curl -s -u "\${OGG_ADMIN_USER}:\${OGG_ADMIN_PASS}" \
  "http://localhost:\${OGG_ADMIN_PORT}/services/v2/replicats/REP_ORCL" \
  2>/dev/null | python3 -c \
  "import sys,json; print(json.load(sys.stdin).get('response',{}).get('lag','99:99:99'))" \
  2>/dev/null)

if ! echo "\$LAG" | grep -qE "^00:00:[0-2][0-9]$"; then
  echo "WARNING: Replicat lag is \$LAG — wait for convergence before removing HANDLECOLLISIONS"
  echo "         Re-run this script once lag is below 00:00:30"
  exit 1
fi

echo "[$(date +%H:%M:%S)] Lag is \$LAG — safe to remove HANDLECOLLISIONS"

# ── Send NOHANDLECOLLISIONS without restart ────────────────────────────────
adminclient << ADMEOF
connect http://localhost:\${OGG_ADMIN_PORT} deployment \${OGG_DEPLOYMENT} as \${OGG_ADMIN_USER} password \${OGG_ADMIN_PASS}
send replicat REP_ORCL, nohandlecollisions
exit
ADMEOF

# ── Remove HANDLECOLLISIONS from the parameter file (persists across restart) ──
CURRENT_PARAMS=\$(curl -s -u "\${OGG_ADMIN_USER}:\${OGG_ADMIN_PASS}" \
  "http://localhost:\${OGG_ADMIN_PORT}/services/v2/replicats/REP_ORCL/parameterFile" \
  2>/dev/null | python3 -c \
  "import sys,json; print(json.load(sys.stdin).get('response',{}).get('content',''))" \
  2>/dev/null)

CLEAN_PARAMS=\$(echo "\$CURRENT_PARAMS" | grep -v -i "HANDLECOLLISIONS")

curl -s -u "\${OGG_ADMIN_USER}:\${OGG_ADMIN_PASS}" \
  -X PUT "http://localhost:\${OGG_ADMIN_PORT}/services/v2/replicats/REP_ORCL/parameterFile" \
  -H "Content-Type: application/json" \
  -d "{\"content\":\"\$(echo "\$CLEAN_PARAMS" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))" | tr -d '\"')\"}" \
  > /dev/null

echo "[$(date +%H:%M:%S)] HANDLECOLLISIONS removed from parameter file"

# ── Row count validation ───────────────────────────────────────────────────
echo ""
echo "  Row count comparison (source vs target):"
printf "  %-35s  %-12s  %-12s  %-8s\n" "Table" "Source" "Target" "Match?"
printf "  %-35s  %-12s  %-12s  %-8s\n" "-----------------------------------" "------------" "------------" "--------"

for TABLE in employees departments jobs job_history locations countries regions; do
  SRC_CNT=\$(sqlplus -s c##ggadmin/\${GG_DB_PASS_SRC}@\${DB_CONN_SRC} << SQLEOF 2>/dev/null
SET PAGES 0 FEEDBACK OFF HEADING OFF
SELECT COUNT(*) FROM hr.\${TABLE};
EXIT;
SQLEOF
)
  TGT_CNT=\$(sqlplus -s ggadmin/\${GG_DB_PASS_TGT}@\${DB_CONN_TGT} << SQLEOF 2>/dev/null
SET PAGES 0 FEEDBACK OFF HEADING OFF
SELECT COUNT(*) FROM hr.\${TABLE};
EXIT;
SQLEOF
)
  SRC_CNT=\$(echo "\$SRC_CNT" | tr -d ' \n')
  TGT_CNT=\$(echo "\$TGT_CNT" | tr -d ' \n')
  MATCH=\$([ "\$SRC_CNT" = "\$TGT_CNT" ] && echo "YES" || echo "*** NO ***")
  printf "  %-35s  %-12s  %-12s  %-8s\n" "hr.\${TABLE}" "\${SRC_CNT:-ERR}" "\${TGT_CNT:-ERR}" "\$MATCH"
done

echo ""
echo "[$(date +%H:%M:%S)] Initial load validation complete."
echo "  Replication is now in steady-state change data capture mode."
echo "  Monitor lag via: http://\$(hostname -f):\${OGG_ADMIN_PORT}"
\`\`\`

---

## METHOD B: SOURCEISTABLE Direct Read

Use this method for smaller schemas where Data Pump is unnecessary.

### Script B-1: Configure and Run the SOURCEISTABLE Extract (Source Server)

\`\`\`bash
#!/bin/bash
# gg_initial_load_b1_sourceistable.sh
# Run as oracle on SOURCE server
# NOTE: A separate CDC Extract must ALREADY be running (EXT_ORCL)
# before starting this initial load extract

set -euo pipefail
source ~/.bash_profile

read -rsp "GoldenGate Admin Console password: " OGG_ADMIN_PASS; echo

# ── Capture SCN while CDC Extract is running ──────────────────────────────
read -rsp "GGS DB user (c##ggadmin) password: " GG_DB_PASS; echo

LOAD_SCN=\$(sqlplus -s c##ggadmin/\${GG_DB_PASS}@\${DB_CONN_SRC} << SQLEOF 2>/dev/null
SET PAGES 0 FEEDBACK OFF HEADING OFF
SELECT current_scn FROM v\\\$database;
EXIT;
SQLEOF
)
LOAD_SCN=\$(echo "\$LOAD_SCN" | tr -d ' \n')
echo "\$LOAD_SCN" > /tmp/gg_load_scn.txt
echo "[$(date +%H:%M:%S)] Load SCN = \$LOAD_SCN"

# ── Create the SOURCEISTABLE (initial load) Extract ───────────────────────
adminclient << ADMEOF
connect http://localhost:\${OGG_ADMIN_PORT} deployment \${OGG_DEPLOYMENT} as \${OGG_ADMIN_USER} password \${OGG_ADMIN_PASS}

edit params EXT_LOAD
EXTRACT EXT_LOAD
SOURCEISTABLE
USERIDALIAS srcdb DOMAIN OracleGoldenGate
RMTHOST target.example.com, MGRPORT \${OGG_RECV_PORT}, COMPRESS
RMTTRAIL ./dirdat/il
TABLE hr.*;

add extract EXT_LOAD, sourceistable
add rmttrail ./dirdat/il, extract EXT_LOAD, megabytes 500

start extract EXT_LOAD

info extract EXT_LOAD, detail
exit
ADMEOF

echo "[$(date +%H:%M:%S)] SOURCEISTABLE Extract started — monitoring until complete..."

# Poll until Extract stops (it stops automatically when the table scan is done)
while true; do
  STATUS=\$(curl -s -u "\${OGG_ADMIN_USER}:\${OGG_ADMIN_PASS}" \
    "http://localhost:\${OGG_ADMIN_PORT}/services/v2/extracts/EXT_LOAD/status" \
    2>/dev/null | python3 -c \
    "import sys,json; print(json.load(sys.stdin).get('response',{}).get('status',''))" \
    2>/dev/null)
  echo "  [$(date +%H:%M:%S)] EXT_LOAD status: \$STATUS"
  [ "\$STATUS" = "STOPPED" ] && { echo "  Extract complete."; break; }
  [ "\$STATUS" = "ABENDED" ] && { echo "  Extract ABENDED — check logs."; exit 1; }
  sleep 30
done
\`\`\`

### Script B-2: Configure Replicat for SOURCEISTABLE Trail (Target Server)

\`\`\`bash
#!/bin/bash
# gg_initial_load_b2_sourceistable_replicat.sh
# Run as oracle on TARGET server

set -euo pipefail
source ~/.bash_profile

LOAD_SCN=\$(cat /tmp/gg_load_scn.txt | tr -d ' \n')
read -rsp "GoldenGate Admin Console password: " OGG_ADMIN_PASS; echo

adminclient << ADMEOF
connect http://localhost:\${OGG_ADMIN_PORT} deployment \${OGG_DEPLOYMENT} as \${OGG_ADMIN_USER} password \${OGG_ADMIN_PASS}

-- Create a dedicated initial-load Replicat that reads the il trail
edit params REP_LOAD
REPLICAT REP_LOAD
USERIDALIAS tgtdb DOMAIN OracleGoldenGate
HANDLECOLLISIONS
ASSUMETARGETDEFS
MAP hr.*, TARGET hr.*;

add replicat REP_LOAD, exttrail ./dirdat/il, checkpointtable ggadmin.gg_checkpoint
start replicat REP_LOAD

-- Once REP_LOAD completes (STOPPED), position the main Replicat
-- at the load SCN and start it
alter replicat REP_ORCL, aftercsn \${LOAD_SCN}
start replicat REP_ORCL

info all
exit
ADMEOF

echo "[$(date +%H:%M:%S)] Initial load Replicat started."
echo "  Monitor REP_LOAD until STOPPED, then run Script A-6 to remove HANDLECOLLISIONS from REP_ORCL."
\`\`\`

---

## Initial Load Quick Reference

| Step | Method A (Data Pump) | Method B (SOURCEISTABLE) |
|---|---|---|
| 1 | Start CDC Extract, capture SCN | Start CDC Extract, capture SCN |
| 2 | \`expdp\` with \`FLASHBACK_SCN\` | Create \`SOURCEISTABLE\` Extract |
| 3 | Transfer dumps to target | Extract scans tables, writes trail |
| 4 | \`impdp\` on target | Start initial load Replicat |
| 5 | \`alter replicat ... aftercsn\` | Wait for load Replicat to STOP |
| 6 | Start Replicat with \`HANDLECOLLISIONS\` | Start CDC Replicat with \`HANDLECOLLISIONS\` |
| 7 | Monitor lag to zero | Monitor lag to zero |
| 8 | \`NOHANDLECOLLISIONS\`, row count check | \`NOHANDLECOLLISIONS\`, row count check |
`,
};

async function main() {
  for (const post of [blogPost, runbookPost]) {
    await db
      .insert(posts)
      .values({
        title: post.title,
        slug: post.slug,
        excerpt: post.excerpt,
        content: post.content,
        category: post.category,
        youtubeUrl: post.youtubeUrl,
        isPremium: post.isPremium,
        published: post.published,
        publishedAt: post.publishedAt,
      })
      .onConflictDoUpdate({
        target: posts.slug,
        set: {
          title: post.title,
          excerpt: post.excerpt,
          content: post.content,
          isPremium: post.isPremium,
          published: post.published,
          publishedAt: post.publishedAt,
        },
      });
    console.log('inserted:', post.slug);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
