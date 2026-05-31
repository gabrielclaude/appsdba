import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const newPost = {
  title: 'Unmasking Memory Hogs: WebLogic JVM Histograms, Code Cache Sizing, and Automated Monitoring',
  slug: 'weblogic-jvm-histogram-code-cache-sizing-automated-monitoring',
  excerpt: 'How to generate and read JVM heap histograms with jcmd, identify memory-consuming object types in WebLogic/EBS environments, automatically collect histograms on a cron schedule, and use a WLST-driven shell advisor to safely size the Code Cache based on available Linux host memory.',
  category: 'weblogic' as const,
  published: true,
  publishedAt: new Date('2026-05-31'),
  youtubeUrl: 'https://www.youtube.com/watch?v=t4sAFxfUcWc',
  content: `Have you ever looked at your application metrics only to find a slow, menacing upward trend in memory utilization? It is the dreaded memory leak — or at minimum, severe memory bloat.

While grabbing a full heap dump (\`.hprof\` file) is the gold standard for finding memory leaks, generating a 30 GB heap dump can temporarily freeze your JVM, consume significant disk I/O, and take ages to transfer and analyze with tools like Eclipse MAT.

Fortunately there is a lighter, faster, and highly effective alternative: **heap histograms**. This post covers what histograms are, how to read them in a WebLogic/EBS context, how to automate collection on a cron schedule, and how to extend the analysis with a WLST script that also evaluates whether the JVM Code Cache should be increased given current Linux host memory.

## What Is a Heap Histogram?

A heap histogram is a lightweight footprint of your JVM's heap memory. Instead of saving every object instance and its references, a histogram groups objects by their fully qualified class name and shows:

1. The number of instances of that class
2. The total memory consumed by those instances (in bytes)

Because it only counts and aggregates, generating a histogram is much faster than a heap dump and typically has negligible production impact — making it ideal for routine monitoring.

## Generating a Histogram with jcmd

The modern and recommended approach uses \`jcmd\`, a versatile diagnostic tool bundled with the JDK:

\`\`\`bash
jcmd <PID> GC.class_histogram
\`\`\`

The older \`jmap -histo <PID>\` works too, but \`jcmd\` is preferred for modern JVMs (JDK 11+). To trigger a live GC pass first for a cleaner picture:

\`\`\`bash
jcmd <PID> GC.class_histogram -all false
\`\`\`

Or with \`jmap\`:

\`\`\`bash
jmap -histo:live <PID>
\`\`\`

## Deciphering the Output

\`\`\`
 num     #instances         #bytes  class name (module)
-------------------------------------------------------
   1:       2043122      120431224  [B (java.base@11.0.12)
   2:       1104322       48123920  [C (java.base@11.0.12)
   3:       1054322       25303728  java.lang.String (java.base@11.0.12)
   4:        210432       18431920  com.example.dto.UserSession
   5:        321041       10273312  java.util.HashMap\$Node
\`\`\`

**Column meanings:**
- **num** — rank by retained bytes
- **#instances** — live object count for this class
- **#bytes** — total heap bytes held by all instances
- **class name** — Java class or array type descriptor

**Array shorthand decoder:**

| Code | Type | Common source |
|------|------|---------------|
| \`[B\` | \`byte[]\` | Network buffers, file streams, image data |
| \`[C\` | \`char[]\` | Backs \`String\` objects on older JVMs |
| \`[I\` | \`int[]\` | Numeric arrays, hash tables |
| \`[Ljava.lang.Object;\` | \`Object[]\` | Collections, arrays of mixed objects |

If \`com.example.dto.UserSession\` is climbing by hundreds of thousands of instances every hour, you have found your leak. Even when generic types like \`[B\` or \`java.util.HashMap\$Node\` dominate, they usually map back to a data structure in application code — like a cache that never evicts entries.

### EBS / WebLogic Hotspot Reference

| Class pattern | What it means |
|---------------|---------------|
| \`oracle.apps.fnd.framework.webui.OAPageContext\` high count | Sessions not being released — check timeout and session cleanup |
| \`oracle.jdbc.driver.T4C*Accessor\` growing | JDBC result sets held open — look for unclosed cursors |
| \`weblogic.servlet.internal.ServletRequestImpl\` count > active threads | Requests queued or stuck — correlate with thread pool analysis |
| \`com.sun.org.apache.xerces.*DeferredDocumentImpl\` growing | XML DOM trees leaking — switch to SAX/StAX in custom code |
| \`[B\` dominating > 40% of heap | Large BLOBs in session, base64 attachments held in memory, or response buffering |
| \`java.lang.ref.Finalizer\` growing | Finalizer queue backlog — connections not properly closed |

## Automated Hourly Collection with heap_logger.sh

To spot a leak you need a trend, not a single snapshot. This script automatically finds your WebLogic process by name and writes a timestamped histogram file each run.

\`\`\`bash
#!/bin/bash
# heap_logger.sh
# Collects a JVM heap histogram for a named Java process and saves it to a log directory.
# Schedule hourly via cron to build a trend-analysis dataset.

# --- CONFIGURATION ---
APP_IDENTIFIER="my-application.jar"   # grep string to identify the target JVM process
OUTPUT_DIR="/var/log/java_histograms"
JCMD_BIN="/usr/lib/jvm/jdk-17/bin/jcmd"   # full path — cron has a bare PATH
# ---------------------

mkdir -p "$OUTPUT_DIR"

# Use jcmd's own process listing to find the PID by app name
PID=$(\${JCMD_BIN} -l | grep "$APP_IDENTIFIER" | awk '{print \$1}')

if [ -z "$PID" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') ERROR: process matching '$APP_IDENTIFIER' not found." \
        >> "$OUTPUT_DIR/error.log"
    exit 1
fi

TIMESTAMP=$(date '+%Y%m%d_%H%M%S')
OUTPUT_FILE="$OUTPUT_DIR/heap_histogram_$TIMESTAMP.txt"

\${JCMD_BIN} "$PID" GC.class_histogram > "$OUTPUT_FILE" 2>&1

if [ $? -eq 0 ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') OK  PID=$PID -> $OUTPUT_FILE" \
        >> "$OUTPUT_DIR/execution.log"
else
    echo "$(date '+%Y-%m-%d %H:%M:%S') FAIL PID=$PID histogram command failed" \
        >> "$OUTPUT_DIR/error.log"
fi
\`\`\`

Make it executable and schedule it:

\`\`\`bash
chmod +x /opt/scripts/heap_logger.sh

# Add to crontab (run as the OS user that owns the WebLogic process)
crontab -e
\`\`\`

\`\`\`
# Collect heap histogram every hour at minute 0
0 * * * * /opt/scripts/heap_logger.sh
\`\`\`

> **Cron path note:** Cron runs with a minimal environment. Always use the absolute path to \`jcmd\` in the \`JCMD_BIN\` variable, or export \`PATH\` at the top of the script.

To detect a leak between two consecutive snapshots:

\`\`\`bash
# Diff instance counts between the 02:00 and 03:00 snapshots
diff <(awk '{print \$4, \$2}' /var/log/java_histograms/heap_histogram_*020000.txt | sort) \\
     <(awk '{print \$4, \$2}' /var/log/java_histograms/heap_histogram_*030000.txt | sort) \\
  | grep '^[<>]' | sort -k3 -rn | head -20
\`\`\`

Classes with a rapidly growing \`#instances\` count in that diff are the leak candidates.

## Understanding JVM Memory Regions Beyond the Heap

Histograms show heap objects. But a WebLogic JVM has three other memory regions that cause production incidents:

| Region | JVM Flag | Typical size | What lives there |
|--------|----------|-------------|-----------------|
| Heap | \`-Xmx\` | 4–16 GB | All Java objects |
| Metaspace | \`-XX:MaxMetaspaceSize\` | 512 MB–2 GB | Class metadata, static fields |
| **Code Cache** | \`-XX:ReservedCodeCacheSize\` | **256 MB default** | JIT-compiled native code |
| Direct/Native | \`-XX:MaxDirectMemorySize\` | 1–4 GB | NIO buffers, SSL, WebLogic muxer |

The **Code Cache** is the most overlooked. When it fills, the JVM logs \`CodeCache is full. Compiler has been disabled\` and stops JIT-compiling hot methods. The process keeps running but performance degrades sharply as hot paths revert to interpreted execution. The symptom often looks like a slow memory leak or a CPU spike — not the obvious OOM you would expect.

## WLST Metrics Script (wls_jvm_metrics.py)

This script connects to a running WebLogic server, collects heap and thread pool metrics via the WebLogic MBean tree, and queries the JVM platform MBean server for Code Cache and GC statistics. It outputs \`KEY=VALUE\` pairs so the shell advisor script can \`eval\` them directly.

Save as \`wls_jvm_metrics.py\` in the same directory as the shell advisor.

\`\`\`python
# wls_jvm_metrics.py
# Outputs KEY=VALUE pairs to stdout for consumption by wls_cache_advisor.sh
# Called via: wlst.sh wls_jvm_metrics.py <host> <port> <user> <pass> <server_name>

import sys

def safe_int(val, default=0):
    try:
        return int(val)
    except:
        return default

def main():
    wls_host    = sys.argv[1] if len(sys.argv) > 1 else 'localhost'
    wls_port    = sys.argv[2] if len(sys.argv) > 2 else '7001'
    wls_user    = sys.argv[3] if len(sys.argv) > 3 else 'weblogic'
    wls_pass    = sys.argv[4] if len(sys.argv) > 4 else ''
    server_name = sys.argv[5] if len(sys.argv) > 5 else 'AdminServer'

    try:
        connect(wls_user, wls_pass, 't3://' + wls_host + ':' + wls_port)

        # ── Heap metrics from WLS JVMRuntime MBean ───────────────────────
        serverRuntime()
        cd('JVMRuntime/' + server_name)

        heap_free    = get('HeapFreeCurrent')
        heap_current = get('HeapSizeCurrent')
        heap_max     = get('HeapSizeMax')
        uptime_ms    = get('UpTime')

        heap_used_mb = safe_int((heap_current - heap_free) / 1024 / 1024)
        heap_max_mb  = safe_int(heap_max / 1024 / 1024)
        heap_pct     = safe_int(heap_used_mb * 100 / heap_max_mb) if heap_max_mb > 0 else 0

        print('WLS_HEAP_USED_MB=' + str(heap_used_mb))
        print('WLS_HEAP_MAX_MB='  + str(heap_max_mb))
        print('WLS_HEAP_PCT='     + str(heap_pct))
        print('WLS_UPTIME_HOURS=' + str(safe_int(uptime_ms / 1000 / 3600)))

        # ── Thread pool metrics ──────────────────────────────────────────
        cd('/')
        serverRuntime()
        cd('ThreadPoolRuntime/ThreadPoolRuntime')

        print('WLS_THREADS_TOTAL='  + str(safe_int(get('ExecuteThreadTotalCount'))))
        print('WLS_THREADS_IDLE='   + str(safe_int(get('ExecuteThreadIdleCount'))))
        print('WLS_THREADS_STUCK='  + str(safe_int(get('StuckThreadCount'))))
        print('WLS_PENDING_REQS='   + str(safe_int(get('PendingUserRequestCount'))))
        print('WLS_THROUGHPUT='     + str(safe_int(get('Throughput'))))

        # ── Code Cache and GC via JVM platform MBean server ─────────────
        cd('/')
        try:
            from javax.management import ObjectName

            mbs = getMBeanServer()

            # Code Cache memory pool
            cc_usage = mbs.getAttribute(
                ObjectName('java.lang:type=MemoryPool,name=Code Cache'), 'Usage')
            cc_used = safe_int(cc_usage.get('used') / 1024 / 1024)
            cc_max  = safe_int(cc_usage.get('max')  / 1024 / 1024)
            cc_pct  = safe_int(cc_used * 100 / cc_max) if cc_max > 0 else 0

            print('CODE_CACHE_USED_MB=' + str(cc_used))
            print('CODE_CACHE_MAX_MB='  + str(cc_max))
            print('CODE_CACHE_PCT='     + str(cc_pct))

            # Metaspace
            try:
                ms_usage = mbs.getAttribute(
                    ObjectName('java.lang:type=MemoryPool,name=Metaspace'), 'Usage')
                print('METASPACE_USED_MB=' + str(safe_int(ms_usage.get('used') / 1024 / 1024)))
                print('METASPACE_MAX_MB='  + str(safe_int(ms_usage.get('max')  / 1024 / 1024)))
            except:
                print('METASPACE_USED_MB=UNKNOWN')

            # GC collectors
            gc_names = mbs.queryNames(
                ObjectName('java.lang:type=GarbageCollector,*'), None)
            for gc_on in gc_names:
                label = gc_on.getKeyProperty('name').replace(' ', '_')
                count = mbs.getAttribute(gc_on, 'CollectionCount')
                ms    = mbs.getAttribute(gc_on, 'CollectionTime')
                avg   = safe_int(ms / count) if count > 0 else 0
                print('GC_' + label + '_COUNT='    + str(safe_int(count)))
                print('GC_' + label + '_TOTAL_MS=' + str(safe_int(ms)))
                print('GC_' + label + '_AVG_MS='   + str(avg))

        except Exception:
            print('CODE_CACHE_USED_MB=UNKNOWN')
            print('CODE_CACHE_MAX_MB=UNKNOWN')
            print('CODE_CACHE_PCT=UNKNOWN')

        disconnect()

    except Exception:
        print('WLST_CONNECT_FAILED=1')
        try:
            disconnect()
        except:
            pass

main()
\`\`\`

## Shell Advisor Script (wls_cache_advisor.sh)

This script orchestrates the full analysis. It reads Linux \`/proc/meminfo\`, resolves the WebLogic PID, calls the WLST script above via \`wlst.sh\`, collects a histogram with \`jcmd\`, and calculates a safe Code Cache recommendation using the available OS headroom.

\`\`\`bash
#!/bin/bash
# wls_cache_advisor.sh
# Analyzes WebLogic JVM histograms and recommends whether to increase the Code Cache
# based on available Linux host memory.
#
# Usage:
#   ./wls_cache_advisor.sh <wls_host> <wls_port> <wls_user> <wls_pass> \\
#                          <server_name> <middleware_home>
#
# Example:
#   ./wls_cache_advisor.sh ebsapp.int 7201 weblogic 'MyPass1' OAFM_server1 \\
#                          /u01/app/oracle/middleware

set -euo pipefail

WLS_HOST=\${1:-localhost}
WLS_PORT=\${2:-7001}
WLS_USER=\${3:-weblogic}
WLS_PASS=\${4:?"WebLogic password required as arg 4"}
SERVER_NAME=\${5:-AdminServer}
MW_HOME=\${6:-/u01/app/oracle/middleware}

WLST="\${MW_HOME}/oracle_common/common/bin/wlst.sh"
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
WLST_SCRIPT="\${SCRIPT_DIR}/wls_jvm_metrics.py"
JAVA_BIN="\${MW_HOME}/oracle_common/jdk/bin"
REPORT_TIME=$(date '+%Y-%m-%d %H:%M:%S')

# ── Prerequisites ─────────────────────────────────────────────────────────────
for tool in "\${WLST}" "\${JAVA_BIN}/jmap" "\${JAVA_BIN}/jcmd"; do
    [ -x "\${tool}" ] || { echo "ERROR: not found or not executable: \${tool}" >&2; exit 1; }
done
[ -f "\${WLST_SCRIPT}" ] || { echo "ERROR: WLST script not found: \${WLST_SCRIPT}" >&2; exit 1; }

# ── Linux memory from /proc/meminfo ──────────────────────────────────────────
TOTAL_MEM_MB=$(( $(grep -m1 '^MemTotal:'     /proc/meminfo | awk '{print \$2}') / 1024 ))
FREE_MEM_MB=$(( $(grep  -m1 '^MemAvailable:' /proc/meminfo | awk '{print \$2}') / 1024 ))

# Always reserve 20% of total RAM for OS + non-JVM processes
RESERVE_MB=$(( TOTAL_MEM_MB * 20 / 100 ))
USABLE_MB=$(( FREE_MEM_MB - RESERVE_MB ))
[ "\${USABLE_MB}" -lt 0 ] && USABLE_MB=0

# ── Resolve WebLogic server PID ───────────────────────────────────────────────
WLS_PID=$(ps -ef \
    | grep '[w]eblogic.Server' \
    | grep "\${SERVER_NAME}" \
    | awk '{print \$2}' \
    | head -1)

[ -z "\${WLS_PID}" ] && {
    echo "ERROR: no PID found for WebLogic server '\${SERVER_NAME}'" >&2
    echo "Running WebLogic processes:" >&2
    ps -ef | grep '[w]eblogic.Server' | awk '{print \$2, \$NF}' >&2
    exit 1
}

# ── Current Code Cache size from running JVM flags ───────────────────────────
RAW_CC_BYTES=$(\${JAVA_BIN}/jcmd "\${WLS_PID}" VM.flags 2>/dev/null \
    | grep -oP '(?<=-XX:ReservedCodeCacheSize=)\d+' | head -1 || true)

if [ -z "\${RAW_CC_BYTES}" ]; then
    CURRENT_CC_MB=256
    CC_SOURCE="(JVM default — flag not explicitly set)"
else
    CURRENT_CC_MB=$(( RAW_CC_BYTES / 1024 / 1024 ))
    CC_SOURCE="(from running VM flags)"
fi

# ── Collect JVM metrics via WLST ─────────────────────────────────────────────
echo "Connecting to WebLogic at \${WLS_HOST}:\${WLS_PORT} ..."
WLST_OUT=$(WLST_PROPERTIES=/dev/null "\${WLST}" \\
    "\${WLST_SCRIPT}" "\${WLS_HOST}" "\${WLS_PORT}" "\${WLS_USER}" "\${WLS_PASS}" "\${SERVER_NAME}" \\
    2>/dev/null | grep -E '^(WLS_|CODE_CACHE_|METASPACE_|GC_)' || true)

# Defaults when WLST cannot connect
WLS_HEAP_USED_MB=0; WLS_HEAP_MAX_MB=0; WLS_HEAP_PCT=0
WLS_THREADS_TOTAL=0; WLS_THREADS_IDLE=0; WLS_THREADS_STUCK=0
WLS_PENDING_REQS=0; WLS_UPTIME_HOURS=0
CODE_CACHE_USED_MB=UNKNOWN; CODE_CACHE_MAX_MB=UNKNOWN; CODE_CACHE_PCT=UNKNOWN
METASPACE_USED_MB=UNKNOWN

eval "\${WLST_OUT}"

# ── Heap histogram via jcmd (preferred) ──────────────────────────────────────
echo "Collecting heap histogram for PID \${WLS_PID} ..."
HISTOGRAM=$(\${JAVA_BIN}/jcmd "\${WLS_PID}" GC.class_histogram 2>/dev/null | head -35 \
    || echo "  jcmd unavailable — run as the oracle OS user or with sudo")

# ── Code Cache recommendation ─────────────────────────────────────────────────
RECOMMEND_ACTION="UNKNOWN"
RECOMMEND_NEW_MB=\${CURRENT_CC_MB}
RECOMMEND_DETAIL=""

if [ "\${CODE_CACHE_PCT}" != "UNKNOWN" ]; then
    if   [ "\${CODE_CACHE_PCT}" -ge 90 ]; then RISK="CRITICAL"
    elif [ "\${CODE_CACHE_PCT}" -ge 75 ]; then RISK="WARNING"
    else                                        RISK="OK"
    fi

    if [ "\${RISK}" != "OK" ]; then
        PROPOSED_ADD_MB=64
        PROPOSED_NEW_MB=$(( CURRENT_CC_MB + PROPOSED_ADD_MB ))

        if [ "\${USABLE_MB}" -ge "\${PROPOSED_ADD_MB}" ]; then
            RECOMMEND_ACTION="INCREASE"
            RECOMMEND_NEW_MB=\${PROPOSED_NEW_MB}
            RECOMMEND_DETAIL="OS has \${USABLE_MB} MB usable (MemAvailable minus 20% reserve). Adding \${PROPOSED_ADD_MB} MB is safe."
        else
            RECOMMEND_ACTION="CANNOT_INCREASE"
            RECOMMEND_DETAIL="Code Cache pressure detected but usable OS headroom is only \${USABLE_MB} MB — insufficient for a safe \${PROPOSED_ADD_MB} MB increase."
        fi
    else
        RECOMMEND_ACTION="NO_CHANGE"
        RECOMMEND_DETAIL="Code Cache at \${CODE_CACHE_PCT}% — within acceptable range."
    fi
fi

# ── Heap growth recommendation ────────────────────────────────────────────────
HEAP_NOTE=""
if [ "\${WLS_HEAP_PCT}" -gt 85 ] 2>/dev/null; then
    NEW_HEAP_MB=$(( WLS_HEAP_MAX_MB + 512 ))
    if [ "\${USABLE_MB}" -ge 512 ]; then
        HEAP_NOTE="  Heap at \${WLS_HEAP_PCT}% — OS has headroom. Consider increasing -Xmx to \${NEW_HEAP_MB}m."
    else
        HEAP_NOTE="  Heap at \${WLS_HEAP_PCT}% — OS headroom insufficient. Add RAM before increasing -Xmx."
    fi
fi

# ══════════════════════════════════════════════════════════════════════════════
cat <<REPORT
================================================================================
  WebLogic JVM Cache Advisor
  Server : \${SERVER_NAME}  (PID: \${WLS_PID})
  Report : \${REPORT_TIME}
================================================================================

── Linux Host Memory ─────────────────────────────────────────────────────────
  Total RAM       : \${TOTAL_MEM_MB} MB
  MemAvailable    : \${FREE_MEM_MB} MB
  OS Reserve (20%): \${RESERVE_MB} MB
  Usable Headroom : \${USABLE_MB} MB

── JVM Heap ──────────────────────────────────────────────────────────────────
  Used / Max      : \${WLS_HEAP_USED_MB} MB / \${WLS_HEAP_MAX_MB} MB  (\${WLS_HEAP_PCT}%)
  Server Uptime   : \${WLS_UPTIME_HOURS} hours
\${HEAP_NOTE}

── Code Cache ────────────────────────────────────────────────────────────────
  Reserved        : \${CURRENT_CC_MB} MB  \${CC_SOURCE}
  Used            : \${CODE_CACHE_USED_MB} MB / \${CODE_CACHE_MAX_MB} MB  (\${CODE_CACHE_PCT}%)

── Metaspace ─────────────────────────────────────────────────────────────────
  Used            : \${METASPACE_USED_MB} MB

── Thread Pool ───────────────────────────────────────────────────────────────
  Total / Idle    : \${WLS_THREADS_TOTAL} / \${WLS_THREADS_IDLE}
  Stuck Threads   : \${WLS_THREADS_STUCK}
  Pending Requests: \${WLS_PENDING_REQS}

── GC Statistics ─────────────────────────────────────────────────────────────
$(echo "\${WLST_OUT}" | grep '^GC_' | sed 's/^/  /' || echo "  (not available)")

── Heap Histogram (top 35 by retained bytes) ─────────────────────────────────
\${HISTOGRAM}

── RECOMMENDATION ────────────────────────────────────────────────────────────
REPORT

case "\${RECOMMEND_ACTION}" in
  INCREASE)
    cat <<REC
  ACTION REQUIRED — Code Cache should be increased.
  \${RECOMMEND_DETAIL}

  New value: -XX:ReservedCodeCacheSize=\${RECOMMEND_NEW_MB}m

  Edit setDomainEnv.sh for the target Managed Server:
    USER_MEM_ARGS="\${USER_MEM_ARGS} -XX:ReservedCodeCacheSize=\${RECOMMEND_NEW_MB}m"

  Bounce only the affected Managed Server, then verify:
    jcmd \${WLS_PID} VM.flags | grep ReservedCodeCacheSize
REC
    ;;
  CANNOT_INCREASE)
    cat <<REC
  WARNING — Code Cache pressure detected but OS headroom is insufficient.
  \${RECOMMEND_DETAIL}

  Options:
    1. Add physical RAM to the host.
    2. Reduce -Xmx on other JVMs sharing this host.
    3. Reduce Oracle DB SGA/PGA if the DB is co-located.
REC
    ;;
  NO_CHANGE)
    echo "  OK — \${RECOMMEND_DETAIL}"
    ;;
  *)
    echo "  WLST connection failed — check credentials or AdminServer availability."
    ;;
esac

echo "================================================================================"
\`\`\`

## Applying the Code Cache Change

Once the advisor recommends an increase:

\`\`\`bash
# 1. Find setDomainEnv.sh for the affected domain
find \${MW_HOME}/user_projects/domains -name setDomainEnv.sh

# 2. Locate the SERVER_NAME conditional block and append the flag
#    (targets only the affected Managed Server, not all servers in the domain)
if [ "\${SERVER_NAME}" = "OAFM_server1" ]; then
    USER_MEM_ARGS="\${USER_MEM_ARGS} -XX:ReservedCodeCacheSize=320m"
fi

# 3. Bounce only the affected Managed Server
srvctl stop  server -s OAFM_server1
srvctl start server -s OAFM_server1

# 4. Confirm the new value is active
jcmd $(ps -ef | grep '[w]eblogic.Server' | grep OAFM_server1 | awk '{print \$2}') \\
    VM.flags | grep ReservedCodeCacheSize
\`\`\`

## Combined Monitoring Strategy

| Tool | Schedule | Purpose |
|------|----------|---------|
| \`heap_logger.sh\` + cron | Hourly | Trend-based leak detection from histogram diffs |
| \`wls_cache_advisor.sh\` | On-demand or weekly | Point-in-time Code Cache + heap sizing recommendation |
| Stuck thread alerts | Continuous via WLS console | Correlate thread backlog with Code Cache saturation |

If thread counts are elevated *and* Code Cache is above 75%, the JIT shutdown is likely amplifying the thread backlog. Increase the Code Cache before tuning thread pool sizes or adding threads — adding threads to a JVM with disabled JIT only adds more interpreted-mode load.
`,
};

async function main() {
  console.log('Inserting new post...');
  await db.insert(posts).values(newPost).onConflictDoNothing();
  console.log(`Inserted: "${newPost.title}"`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
