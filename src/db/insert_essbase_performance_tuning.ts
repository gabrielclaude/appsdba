import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const blogPost = {
  title: 'Oracle Essbase Performance Tuning: BSO, ASO, and System-Level Optimization',
  slug: 'essbase-performance-tuning',
  excerpt:
    'A comprehensive guide to Oracle Essbase performance tuning — BSO block size and cache optimization, dense and sparse redesign, calculation script efficiency, ASO aggregation views, data load parallelism, JVM heap sizing, and a diagnostic framework for identifying the root cause of slow queries and calculations.',
  category: 'essbase' as const,
  published: true,
  publishedAt: new Date('2026-06-02'),
  isPremium: false,
  youtubeUrl: null,
  content: `Essbase performance problems fall into a small number of root cause categories: poor outline design causing oversized or under-populated blocks, undersized caches causing excessive disk I/O, inefficient calculation scripts performing redundant passes, and JVM or OS resource contention. Identifying which category applies before making changes prevents the classic mistake of tuning the wrong layer.

This post walks through each layer from the database design down to the system, covering both BSO and ASO cubes.

---

## The Performance Tuning Hierarchy

Tune in this order. Problems at a higher layer dominate all layers below it:

1. **Outline design** — dense/sparse classification, hierarchy depth, block size
2. **Cache sizing** — data cache, index cache, calculator cache
3. **Calculation design** — script structure, FIX blocks, member formula complexity
4. **Data load design** — parallelism, buffer sizing, load method
5. **ASO aggregation views** — view materialisation for common query paths
6. **JVM and OS** — heap, GC, file handles, network stack

Do not increase JVM heap to fix a problem caused by an oversized block. The block will still fill memory; you will just delay the crash.

---

## BSO Performance Tuning

### 1. Block Size and Dense/Sparse Design

Block size is the single most impactful BSO design parameter. Every I/O operation reads or writes at least one full block, so an oversized block wastes I/O bandwidth, calculation time, and memory.

**Target block size: 8 KB – 100 KB.**

Block size is determined entirely by which dimensions are dense:

\`\`\`
Block size (bytes) = (product of all dense member counts) × 8
\`\`\`

**Check current block size and statistics:**

\`\`\`
/* MaxL */
query database BudgetPlanning.Revenue get statistics;
\`\`\`

Look for these values in the output:

| Statistic | Healthy | Investigate |
|---|---|---|
| Block size | 8 KB – 100 KB | > 200 KB or < 4 KB |
| Block density | 10% – 80% | < 5% (wasted allocation) |
| Existing blocks | — | Compare to theoretical maximum |
| Compression ratio | > 1.0 | < 1.0 indicates wrong compression type |

**Redesigning dense/sparse when block size is too large:**

Move dimensions from dense to sparse when:
- The dimension has high member count relative to its sparsity in data
- Most combinations of the dimension with other dense dimensions are empty

Example: if Scenario (5 members: Actual, Budget, Forecast, Variance, Variance%) is dense but most cubes only load Actual and Budget data, moving Scenario to sparse cuts block size by 60% and eliminates the allocation of three empty dimension arrays per block.

**Redesigning when block size is too small (<4 KB):**

Very small blocks cause excessive index lookups and I/O amplification — the index overhead per block is disproportionate. Move a small sparse dimension to dense to consolidate multiple small blocks into fewer larger ones. The Period/Month dimension (12 members) is typically the right candidate.

### 2. Database Cache Configuration

Essbase uses three independently configurable caches for BSO databases:

**Data cache** — holds decompressed data blocks in memory. Undersizing this cache forces Essbase to constantly read blocks from disk, decompress them, use them once, and discard them. For a heavily queried or calculated cube, the data cache should hold the entire working set.

**Index cache** — holds the block index (the sparse dimension index that maps sparse member combinations to block addresses on disk). Undersizing the index cache causes frequent index file seeks. The index cache should hold the entire index for best performance.

**Calculator cache** — holds blocks during multi-pass calculations. Too small a calculator cache causes the engine to write partial calculation results to disk and re-read them, dramatically slowing CALC scripts.

\`\`\`
/* MaxL — check current cache settings */
query database BudgetPlanning.Revenue get cache_settings;

/* MaxL — check cache hit statistics */
query database BudgetPlanning.Revenue get statistics;
/* Look for:
   Data Cache Hit Ratio: 92.4%   (target > 85%)
   Index Cache Hit Ratio: 99.1%  (target > 95%)
*/
\`\`\`

**Sizing the caches:**

\`\`\`
Index cache target = (number of existing blocks) × 48 bytes × 1.25 safety factor
Data cache target  = (number of blocks in working set) × block_size × 1.2
Calculator cache   = block_size × (number of parallel calculation threads) × 3
\`\`\`

\`\`\`
/* MaxL — alter cache settings dynamically */
alter database BudgetPlanning.Revenue set index_cache 512m;
alter database BudgetPlanning.Revenue set data_cache 2048m;
alter database BudgetPlanning.Revenue set calc_cache default_settings
  ('CACHECALCMEMSIZE', '200MB');
\`\`\`

Or set in \`essbase.cfg\` (server-wide default):

\`\`\`
/* essbase.cfg — server-wide cache defaults */
DATACACHESIZE       512
INDEXCACHESIZE      256
CALCCACHEDEFAULT    102400
CALCCACHEMAXSIZE    204800
\`\`\`

### 3. Database Compression

BSO databases store blocks in one of three compression modes:

- **None** — uncompressed. Fast to read/write; largest disk footprint.
- **Bitmap** — compresses blocks using bitmap encoding. Best for dense blocks with many zero values (typical for financial cubes). Up to 10:1 compression ratio.
- **RLE (Run-Length Encoding)** — best for blocks with long runs of identical values. Less common in financial cubes.

Most financial planning cubes benefit most from **Bitmap** compression:

\`\`\`
/* MaxL — check current compression */
query database BudgetPlanning.Revenue get storage_info;

/* MaxL — change compression (takes effect on next restructure) */
alter database BudgetPlanning.Revenue set compression bitmap;
\`\`\`

### 4. Calculation Script Optimization

Calculation performance problems come from three sources: redundant full-database passes, member formulas calculated in the wrong order, and unscoped FIX blocks that process more data than necessary.

**Use FIX blocks to scope calculations:**

Without a FIX block, a CALC script iterates over every block in the database. For a cube with 2 million blocks and a budget calc that only applies to Scenario → Budget, Version → Working, this means 1.9 million wasted block reads.

\`\`\`
/* Unscoped — processes every block */
CALC ALL;

/* Scoped — processes only Budget/Working blocks */
FIX("Budget", "Working")
  CALC DIM("Account", "Entity");
ENDFIX
\`\`\`

**Separate dense and sparse calculations:**

Dense dimension aggregations (member formulas within a block) and sparse dimension aggregations (rolling up across blocks) require separate passes. Mixing them in one script forces multiple full-database traversals.

\`\`\`
/* Two-pass approach: dense first, then sparse */
CALC DIM("Account");           /* dense pass — rolls up accounts within each block */
CALC DIM("Entity", "Period");  /* sparse pass — rolls up entities across blocks    */
\`\`\`

**Use SET commands to control the calculation engine:**

\`\`\`
/* Increase parallelism for large calculations */
SET CALCPARALLEL 8;   /* number of threads — set to number of CPU cores */
SET CALCTASKDIMS 2;   /* dimensions to parallelize across */

/* Reduce memory usage for deep hierarchies */
SET CACHE HIGH;
SET UPDATECALC OFF;   /* recalculate all dirty blocks, not just changed ones */

/* Compression during calculation */
SET CALCCACHE ON;
\`\`\`

**Member formulas vs calculation scripts:**

Member formulas (stored in the outline) are evaluated on every database read. Complex formulas on frequently queried members add latency to every retrieval. If a formula is only needed for batch reporting, consider moving it to a calculation script that is run explicitly and stores the result.

### 5. Aggregate Storage (ASO) Tuning

ASO cubes compute aggregations at query time. Tuning focuses on materialising views for the most common aggregation paths so the engine does not have to recompute them from input-level data on every query.

**Check current aggregation views:**

\`\`\`
/* MaxL */
query database GLReporting.Actuals get agg_view_info;
\`\`\`

**Query tracking — build views based on actual usage:**

\`\`\`
/* Enable query tracking for 24–48 hours during peak usage */
alter database GLReporting.Actuals enable query_tracking;

/* After the tracking period, materialise recommended views */
alter database GLReporting.Actuals merge data all;
execute aggregate process on database GLReporting.Actuals
  using aggregate_selection rule user_defined_views;
\`\`\`

**Incremental aggregation after data loads:**

For ASO cubes that receive incremental data updates, use slice merging and targeted aggregation instead of full re-aggregation:

\`\`\`
/* After loading a data slice */
alter database GLReporting.Actuals merge data all;    /* merge input slices */
execute aggregate process on database GLReporting.Actuals
  using aggregate_selection rule all_combinations;   /* refresh aggregation views */
\`\`\`

**ASO maximum aggregation size:**

Set a limit on the total size of materialised aggregation views to prevent unbounded disk growth:

\`\`\`
/* essbase.cfg */
ASOMAXAGGREGATIONSIZE 20480  /* MB — total size of all ASO aggregation views */
\`\`\`

---

## Data Load Performance

### Parallel Data Loads (BSO)

BSO supports parallel data loading using multiple load buffers. Each buffer operates on a separate set of blocks, allowing concurrent writes without lock contention.

\`\`\`
/* MaxL — parallel load using named buffers */
set load_buffer_block_size "BudgetPlanning" "Revenue" to 32;
set load_buffer "BudgetPlanning" "Revenue" to 1;
import database "BudgetPlanning"."Revenue" data
  from local_file "/data/revenue_q1.csv"
  using local_file "/rules/revenue_load.rul"
  buffer_id 1
  on error write to "/logs/revenue_q1_err.txt";
\`\`\`

### Data Load Buffer Sizing

The load buffer holds blocks in memory before committing them to disk. A larger buffer reduces disk writes but increases memory usage. For large loads (> 10 million cells), set:

\`\`\`
/* essbase.cfg */
DLSINGLETHREADPERSTAGE TRUE
DEXPSINGLETHREADPERSTAGE TRUE

/* Increase load buffer to reduce disk commits */
/* Default: 32 — increase to 256 or 512 for large loads */
LOADBUFFERMAXBLOCKSIZE 256
\`\`\`

### ASO Data Load — Streaming vs Batch

For ASO cubes, streaming loads (using the \`STREAM\` option) bypass the slice mechanism and write directly to the main aggregation store. This is faster for initial full loads but slower for incremental updates:

\`\`\`
/* Stream load — best for initial full population */
import database GLReporting.Actuals data
  from local_file "/data/gl_actuals_full.csv"
  using local_file "/rules/actuals_load.rul"
  to load_buffer_block_size 128
  on error write to "/logs/actuals_err.txt";
alter database GLReporting.Actuals merge data all;
\`\`\`

---

## JVM and System-Level Tuning

### JVM Heap Sizing

The Essbase server process runs inside a JVM. Inadequate heap causes frequent GC pauses that manifest as intermittent query slowdowns (users see the query hang for 2–30 seconds, then complete). Heap is configured in the Essbase startup arguments.

\`\`\`bash
# Recommended JVM arguments for a production Essbase server (16 GB RAM node)
JAVA_OPTIONS="-Xms4096m -Xmx8192m
  -XX:+UseG1GC
  -XX:MaxGCPauseMillis=500
  -XX:G1HeapRegionSize=32m
  -XX:InitiatingHeapOccupancyPercent=45
  -XX:+ParallelRefProcEnabled
  -Xss512k
  -XX:+HeapDumpOnOutOfMemoryError
  -XX:HeapDumpPath=/u01/app/oracle/essbase/logs/heapdumps"
\`\`\`

Rule of thumb: set \`-Xmx\` to no more than 50% of total system RAM, leaving headroom for OS file system cache, the Oracle repository database process, and Essbase's native off-heap memory for block storage.

### Monitoring GC Activity

\`\`\`bash
# Check JVM GC activity — look for long pauses or high frequency
grep "GC" /u01/app/oracle/domains/essbase_domain/servers/essbase_server1/logs/essbase_server1.log \
  | grep -E "pause|promotion|concurrent" | tail -50

# Enable GC logging (add to JVM args)
# -Xlog:gc*:file=/u01/app/oracle/essbase/logs/gc.log:time,uptime:filecount=5,filesize=50m
\`\`\`

### OS Kernel Parameters for Essbase

\`\`\`bash
# /etc/sysctl.conf additions for Essbase
vm.swappiness=10          # avoid swapping; Essbase is memory-intensive
vm.dirty_ratio=20         # allow more dirty pages before forcing writeback
vm.dirty_background_ratio=5
net.core.somaxconn=4096   # increase socket connection backlog for Smart View users
\`\`\`

### File Handle Limits

Each open cube file, each connected user session, and each network socket consumes a file handle. A 200-user Essbase deployment with 10 cubes can easily consume 50,000+ handles.

\`\`\`bash
# Verify limits are applied to the oracle process
cat /proc/$(pgrep -f ESSBASE)/limits | grep -i "open files"
# Should show hard limit >= 131072

# Check current usage
ls /proc/$(pgrep -f ESSBASE)/fd | wc -l
\`\`\`

---

## Performance Monitoring Checklist

Run these queries weekly and after any significant change:

\`\`\`
/* Check all databases on the server */
display database all;

/* Check active sessions and locks */
display session all;

/* Query database statistics */
query database BudgetPlanning.Revenue get statistics;
query database BudgetPlanning.Revenue get cache_settings;
query database GLReporting.Actuals get statistics;
query database GLReporting.Actuals get agg_view_info;

/* Check active calculations */
display active calcscript BudgetPlanning.Revenue all;
\`\`\`

\`\`\`bash
# Check Essbase application log for errors and performance warnings
grep -E "ERROR|WARNING|Elapsed|Cache|Block" \
  /u01/app/oracle/domains/essbase_domain/servers/essbase_server1/logs/essbase_server1.log \
  | grep "$(date +%Y-%m-%d)" | tail -100

# Monitor system resource usage during a calculation
vmstat 5 12    # CPU and memory every 5 seconds for 1 minute
iostat -x 5 6  # disk I/O every 5 seconds
\`\`\`

---

## Common Performance Problems and Root Causes

| Symptom | Most Likely Cause | First Fix |
|---|---|---|
| CALC ALL takes > 2 hours | No FIX scoping, processing all blocks | Add FIX to limit to active data scope |
| Query returns in < 1s locally, slow for remote users | Network latency or Smart View HTTP overhead | Enable HTTP compression; check MTU |
| Calculation fast first run, slow on reruns | Calculator cache too small | Increase \`CALCCACHEMAXSIZE\` |
| Database restructure takes > 30 minutes | Very large number of blocks, fragmented .pag files | Run \`alter database restructure\` during off-peak; consider outline simplification |
| Export to flat file slow | No parallelism, single-threaded export | Use \`MAXL EXPORT\` with \`LEVEL0\` and check \`EXPORTTHREADS\` setting |
| Intermittent 2–30 second hangs | JVM GC pause (stop-the-world GC) | Switch to G1GC with \`MaxGCPauseMillis\` limit; increase heap |
| ASO query fast initially, degrades over time | Aggregation views stale after incremental loads | Schedule regular \`merge data all\` and \`aggregate process\` |
| Login slow for all users | LDAP/Shared Services authentication delay | Check Shared Services connectivity; consider local security for batch accounts |
`,
};

const runbookPost = {
  title: 'Runbook: Essbase Performance Diagnosis and Tuning Scripts',
  slug: 'essbase-performance-tuning-runbook',
  excerpt:
    'Executable MaxL and shell scripts for Essbase performance diagnosis and tuning — block size analysis, cache hit ratio assessment, calculation profiling, ASO aggregation view management, JVM heap analysis, data load optimisation, and an automated recommendation report covering both BSO and ASO cubes.',
  category: 'essbase' as const,
  published: true,
  publishedAt: new Date('2026-06-02'),
  isPremium: true,
  youtubeUrl: null,
  content: `This runbook accompanies the [Essbase Performance Tuning guide](/posts/essbase-performance-tuning). It provides ready-to-run MaxL and shell scripts that diagnose the current state of BSO and ASO cubes, produce a written recommendation report, and apply approved tuning changes.

**Prerequisites:**
- \`essmsh\` (MaxL shell) available at \`\$ESSBASE_HOME/bin/essmsh\`
- Essbase admin credentials
- Write access to the Essbase server for configuration changes
- For JVM tuning: access to the WebLogic Admin Console or managed server startup script

Set once before running any script:

\`\`\`bash
export ESSBASE_HOME=/u01/app/oracle/product/essbase21
export ESS_HOST=localhost
export ESS_ADMIN=admin
export ESS_PASS=your_admin_password
export ESS_APP=BudgetPlanning      # change to your application name
export ESS_DB=Revenue              # change to your database name
export PATH=\$ESSBASE_HOME/bin:\$PATH
\`\`\`

---

## Script 1: Full Database Inventory

Connects to Essbase and collects statistics for all running databases. Run this first to understand what is deployed and identify candidates for investigation.

\`\`\`bash
#!/bin/bash
# ess_inventory.sh — list all applications, databases, and key stats
# Usage: ./ess_inventory.sh

REPORT="/tmp/ess_inventory_$(date +%Y%m%d_%H%M%S).txt"

essmsh << EOF | tee "$REPORT"
login \$ESS_ADMIN '\$ESS_PASS' on \$ESS_HOST;

/* All applications and their running state */
display application all;

/* All databases */
display database all;

logout;
EOF

echo ""
echo "Inventory written to: \$REPORT"
\`\`\`

---

## Script 2: BSO Block Size and Cache Diagnosis

For each BSO database, collect block size, density, and cache hit statistics. Produces a PASS/WARN/FAIL report.

\`\`\`bash
#!/bin/bash
# ess_bso_diagnosis.sh — BSO block size, density, and cache analysis
# Usage: ./ess_bso_diagnosis.sh [app_name] [db_name]
# If app/db not specified, uses ESS_APP/ESS_DB env vars

APP=\${1:-\$ESS_APP}
DB=\${2:-\$ESS_DB}
REPORT="/tmp/ess_bso_diag_\${APP}_\${DB}_$(date +%Y%m%d_%H%M%S).txt"
PASS=0; WARN=0; FAIL=0

log()  { echo "\$1" | tee -a "\$REPORT"; }
pass() { log "  [PASS] \$1"; ((PASS++)); }
warn() { log "  [WARN] \$1"; ((WARN++)); }
fail() { log "  [FAIL] \$1"; ((FAIL++)); }
hr()   { log "$(printf '%.0s-' {1..70})"; }

hr; log "  BSO Diagnosis: \$APP.\$DB"; log "  $(date)"; hr

# ── Collect statistics via MaxL ────────────────────────────────────────────
STATS_FILE="/tmp/ess_stats_\$\$.txt"
essmsh << EOF > "\$STATS_FILE" 2>&1
login \$ESS_ADMIN '\$ESS_PASS' on \$ESS_HOST;
query database \$APP.\$DB get statistics;
query database \$APP.\$DB get cache_settings;
query database \$APP.\$DB get storage_info;
logout;
EOF
cat "\$STATS_FILE" | tee -a "\$REPORT"

# ── Parse key metrics ──────────────────────────────────────────────────────
BLOCK_SIZE=$(grep -i "block size" "\$STATS_FILE" | grep -oP '[0-9,]+' | head -1 | tr -d ',')
BLOCK_DENSITY=$(grep -i "block density\|density" "\$STATS_FILE" | grep -oP '[0-9]+\.[0-9]+' | head -1)
EXIST_BLOCKS=$(grep -i "existing blocks\|number of.*blocks" "\$STATS_FILE" | grep -oP '[0-9,]+' | head -1 | tr -d ',')
DATA_CACHE_HIT=$(grep -i "data cache hit\|datacache hit" "\$STATS_FILE" | grep -oP '[0-9]+\.[0-9]+' | head -1)
IDX_CACHE_HIT=$(grep -i "index cache hit\|indexcache hit" "\$STATS_FILE" | grep -oP '[0-9]+\.[0-9]+' | head -1)
COMPRESSION=$(grep -i "compression" "\$STATS_FILE" | head -1)

log ""
hr
log "  Parsed Metrics"
hr
log "  Block size         : \${BLOCK_SIZE:-unknown} bytes"
log "  Block density      : \${BLOCK_DENSITY:-unknown}%"
log "  Existing blocks    : \${EXIST_BLOCKS:-unknown}"
log "  Data cache hit %   : \${DATA_CACHE_HIT:-unknown}%"
log "  Index cache hit %  : \${IDX_CACHE_HIT:-unknown}%"
log "  Compression        : \$COMPRESSION"
log ""

# ── Checks ─────────────────────────────────────────────────────────────────
hr; log "  Analysis"; hr

if [ -n "\$BLOCK_SIZE" ] && [ "\$BLOCK_SIZE" -gt 0 ] 2>/dev/null; then
  if [ "\$BLOCK_SIZE" -gt 200000 ]; then
    fail "Block size is \${BLOCK_SIZE} bytes (> 200 KB) — dense/sparse redesign required"
    log "     Action: move dimensions from dense to sparse to reduce block size."
    log "     Target: 8 KB – 100 KB. Review dimensions with high member counts."
  elif [ "\$BLOCK_SIZE" -lt 4096 ]; then
    warn "Block size is \${BLOCK_SIZE} bytes (< 4 KB) — blocks too small, index overhead excessive"
    log "     Action: move a small-cardinality dimension (e.g. Period) from sparse to dense."
  else
    pass "Block size is \${BLOCK_SIZE} bytes (within 4 KB – 200 KB range)"
  fi
fi

if [ -n "\$BLOCK_DENSITY" ] 2>/dev/null; then
  DENSITY_INT=\${BLOCK_DENSITY%.*}
  if [ "\$DENSITY_INT" -lt 5 ]; then
    warn "Block density is \${BLOCK_DENSITY}% — many allocated blocks are empty"
    log "     Action: review sparse dimensions; consider moving very sparse dims"
    log "     further out in the outline (affects block creation threshold)."
  elif [ "\$DENSITY_INT" -gt 80 ]; then
    warn "Block density is \${BLOCK_DENSITY}% — blocks are very full; may indicate dense dims are too small"
  else
    pass "Block density is \${BLOCK_DENSITY}% (healthy range: 5% – 80%)"
  fi
fi

if [ -n "\$DATA_CACHE_HIT" ] 2>/dev/null; then
  HIT_INT=\${DATA_CACHE_HIT%.*}
  if [ "\$HIT_INT" -lt 75 ]; then
    fail "Data cache hit rate is \${DATA_CACHE_HIT}% — data cache is too small"
    log "     Action: increase data cache size. Run Script 4 to calculate recommended size."
  elif [ "\$HIT_INT" -lt 85 ]; then
    warn "Data cache hit rate is \${DATA_CACHE_HIT}% — consider increasing data cache"
  else
    pass "Data cache hit rate is \${DATA_CACHE_HIT}% (target > 85%)"
  fi
fi

if [ -n "\$IDX_CACHE_HIT" ] 2>/dev/null; then
  IDX_INT=\${IDX_CACHE_HIT%.*}
  if [ "\$IDX_INT" -lt 90 ]; then
    fail "Index cache hit rate is \${IDX_CACHE_HIT}% — index cache is too small"
    log "     Action: increase index cache. Recommended: num_blocks × 48 × 1.25 bytes."
  elif [ "\$IDX_INT" -lt 95 ]; then
    warn "Index cache hit rate is \${IDX_CACHE_HIT}% — consider a modest index cache increase"
  else
    pass "Index cache hit rate is \${IDX_CACHE_HIT}% (target > 95%)"
  fi
fi

rm -f "\$STATS_FILE"

log ""
hr
log "  Summary: PASS=\$PASS  WARN=\$WARN  FAIL=\$FAIL"
[ "\$FAIL" -gt 0 ] && log "  Run Script 4 (implement_bso_tuning.sh) after reviewing failures." \
                   || log "  No critical issues detected."
hr
log "  Report: \$REPORT"
\`\`\`

---

## Script 3: Calculation Script Profiler

Times individual calculation scripts and calculates efficiency metrics. Run during a maintenance window when you can trigger a full calculation.

\`\`\`bash
#!/bin/bash
# ess_calc_profiler.sh — Profile BSO calculation performance
# Usage: ./ess_calc_profiler.sh [app] [db] [calc_script_name|"DEFAULT"]
#
# Runs the calculation with timing and checks the application log for
# block read/write counts and elapsed time per pass.

APP=\${1:-\$ESS_APP}
DB=\${2:-\$ESS_DB}
CALC=\${3:-DEFAULT}    # DEFAULT runs CALC ALL; otherwise specify script name
LOG_DIR=/u01/app/oracle/domains/essbase_domain/servers/essbase_server1/logs

echo "============================================"
echo "  Essbase Calculation Profiler"
echo "  Target  : \$APP.\$DB"
echo "  Script  : \$CALC"
echo "  Started : $(date)"
echo "============================================"

# Record the log file size before the calculation (to isolate new log entries)
LOG_FILE="\$LOG_DIR/essbase_server1.log"
LOG_START_LINE=\$(wc -l < "\$LOG_FILE" 2>/dev/null || echo 0)

START_TS=\$(date +%s)

if [ "\$CALC" = "DEFAULT" ]; then
  essmsh << EOF
login \$ESS_ADMIN '\$ESS_PASS' on \$ESS_HOST;
execute calculation \$APP.\$DB default;
logout;
EOF
else
  essmsh << EOF
login \$ESS_ADMIN '\$ESS_PASS' on \$ESS_HOST;
execute calculation \$APP.\$DB calc_script '\$CALC';
logout;
EOF
fi

END_TS=\$(date +%s)
ELAPSED=\$((END_TS - START_TS))

echo ""
echo "============================================"
echo "  Calculation completed in \${ELAPSED}s"
echo "  Scanning application log for pass details..."
echo "============================================"

# Extract calc-related log entries since the calculation started
tail -n +"\$LOG_START_LINE" "\$LOG_FILE" 2>/dev/null \
  | grep -E "Elapsed|Pass|blocks read|blocks written|Calculating|CALCPARALLEL|Cache" \
  | head -60

echo ""
echo "Block I/O summary:"
tail -n +"\$LOG_START_LINE" "\$LOG_FILE" 2>/dev/null \
  | grep -E "blocks (read|written)" | awk '
    /blocks read/    {reads  += \$1}
    /blocks written/ {writes += \$1}
    END {
      print "  Total blocks read   : " reads
      print "  Total blocks written: " writes
      print "  Read/Write ratio    : " (writes > 0 ? reads/writes : "N/A")
    }'

echo ""
echo "Profiling complete. Total elapsed: \${ELAPSED}s"
echo "Full log entries appended to: /tmp/ess_calc_profile_\${APP}_\${DB}_$(date +%Y%m%d_%H%M%S).txt"

tail -n +"\$LOG_START_LINE" "\$LOG_FILE" 2>/dev/null \
  | grep -E "Elapsed|Pass|blocks|Calc|ERROR|WARN" \
  > "/tmp/ess_calc_profile_\${APP}_\${DB}_$(date +%Y%m%d_%H%M%S).txt"
\`\`\`

---

## Script 4: Apply BSO Cache and Setting Changes

Edit the configuration block at the top. Run after reviewing the diagnosis from Script 2.

\`\`\`bash
#!/bin/bash
# implement_bso_tuning.sh — Apply BSO cache and performance settings
# Review all values before running.

APP=\${1:-\$ESS_APP}
DB=\${2:-\$ESS_DB}

# ── Configuration — review before running ─────────────────────────────────
NEW_DATA_CACHE="2048m"      # increase if data cache hit rate < 85%
NEW_INDEX_CACHE="512m"      # increase if index cache hit rate < 95%
NEW_COMPRESSION="bitmap"    # bitmap (financial) or rle or none
NEW_CALC_PARALLEL=8         # number of calc threads — set to CPU core count
NEW_CALC_CACHE_MAX="400m"   # calculator cache max size

APPLY_COMPRESSION=false     # set true only if you want to change compression
                             # (requires a database restructure)
# ─────────────────────────────────────────────────────────────────────────

log() { echo "[$(date +%H:%M:%S)] \$1"; }

log "Applying BSO performance settings to \$APP.\$DB"

essmsh << EOF | tee /tmp/ess_tuning_\${APP}_\${DB}_$(date +%Y%m%d_%H%M%S).log
login \$ESS_ADMIN '\$ESS_PASS' on \$ESS_HOST;

/* ── Cache settings ─────────────────────────────────────── */
alter database \$APP.\$DB set index_cache \$NEW_INDEX_CACHE;
alter database \$APP.\$DB set data_cache \$NEW_DATA_CACHE;

/* ── Calculator cache ────────────────────────────────────── */
alter database \$APP.\$DB set calc_cache default_settings
  ('CACHECALCMEMSIZE', '\$NEW_CALC_CACHE_MAX');

/* ── Parallel calculation ────────────────────────────────── */
alter database \$APP.\$DB set formula_cache
  ('CALCPARALLEL', '\$NEW_CALC_PARALLEL');

/* ── Verify applied settings ─────────────────────────────── */
query database \$APP.\$DB get cache_settings;

logout;
EOF

if [ "\$APPLY_COMPRESSION" = "true" ]; then
  log ""
  log "Applying compression change to \$COMPRESSION..."
  log "WARNING: This will trigger a database restructure."
  read -p "Confirm compression change to \$NEW_COMPRESSION on \$APP.\$DB? [yes/NO]: " CONFIRM
  if [ "\$CONFIRM" = "yes" ]; then
    essmsh << EOF
login \$ESS_ADMIN '\$ESS_PASS' on \$ESS_HOST;
alter database \$APP.\$DB set compression \$NEW_COMPRESSION;
alter database \$APP.\$DB restructure;
logout;
EOF
    log "Compression set to \$NEW_COMPRESSION and restructure completed."
  else
    log "Compression change skipped."
  fi
fi

log "BSO tuning complete."
\`\`\`

---

## Script 5: ASO Aggregation View Management

Diagnoses ASO aggregation view efficiency and applies view materialisation.

\`\`\`bash
#!/bin/bash
# ess_aso_agg_views.sh — ASO aggregation view diagnosis and tuning
# Usage: ./ess_aso_agg_views.sh [app] [db] [action: diagnose|rebuild|track]

APP=\${1:-GLReporting}
DB=\${2:-Actuals}
ACTION=\${3:-diagnose}

log() { echo "[$(date +%H:%M:%S)] \$1"; }

case "\$ACTION" in

  diagnose)
    log "=== ASO Aggregation View Diagnosis: \$APP.\$DB ==="
    essmsh << EOF
login \$ESS_ADMIN '\$ESS_PASS' on \$ESS_HOST;
query database \$APP.\$DB get statistics;
query database \$APP.\$DB get agg_view_info;
logout;
EOF
    ;;

  track)
    log "=== Enabling query tracking on \$APP.\$DB ==="
    log "Query tracking will run for 24 hours. Run with action=rebuild afterward."
    essmsh << EOF
login \$ESS_ADMIN '\$ESS_PASS' on \$ESS_HOST;
alter database \$APP.\$DB enable query_tracking;
display database \$APP.\$DB;
logout;
EOF
    ;;

  rebuild)
    log "=== Rebuilding ASO aggregation views for \$APP.\$DB ==="
    log "Step 1: Merging data slices..."
    essmsh << EOF
login \$ESS_ADMIN '\$ESS_PASS' on \$ESS_HOST;
alter database \$APP.\$DB merge data all;
logout;
EOF

    log "Step 2: Running aggregate process (this may take several minutes)..."
    essmsh << EOF
login \$ESS_ADMIN '\$ESS_PASS' on \$ESS_HOST;
execute aggregate process on database \$APP.\$DB
  using aggregate_selection rule all_combinations
  stop after 3600;    /* stop after 1 hour if not complete */
logout;
EOF

    log "Step 3: Disabling query tracking..."
    essmsh << EOF
login \$ESS_ADMIN '\$ESS_PASS' on \$ESS_HOST;
alter database \$APP.\$DB disable query_tracking;
query database \$APP.\$DB get agg_view_info;
logout;
EOF

    log "ASO aggregation views rebuilt."
    ;;

  *)
    echo "Usage: \$0 [app] [db] [diagnose|rebuild|track]"
    exit 1
    ;;
esac
\`\`\`

---

## Script 6: JVM Heap Analysis and Tuning

\`\`\`bash
#!/bin/bash
# ess_jvm_analysis.sh — Analyse Essbase JVM heap usage and GC activity

DOMAIN_HOME=/u01/app/oracle/domains/essbase_domain
SERVER_NAME=essbase_server1
LOG_DIR="\$DOMAIN_HOME/servers/\$SERVER_NAME/logs"
JAVA_HOME=/usr/lib/jvm/jdk-11
export JAVA_HOME PATH="\$JAVA_HOME/bin:\$PATH"

log() { echo "[$(date +%H:%M:%S)] \$1"; }

# ── Find Essbase JVM PID ───────────────────────────────────────────────────
ESS_PID=\$(pgrep -f "essbase_server1" 2>/dev/null | head -1)
if [ -z "\$ESS_PID" ]; then
  echo "ERROR: Essbase managed server process not found."
  exit 1
fi
log "Essbase JVM PID: \$ESS_PID"

# ── Live heap usage via jcmd ───────────────────────────────────────────────
log ""
log "=== Live JVM Heap Usage ==="
jcmd "\$ESS_PID" GC.heap_info 2>/dev/null || jmap -heap "\$ESS_PID" 2>/dev/null

# ── GC summary ────────────────────────────────────────────────────────────
log ""
log "=== GC Statistics ==="
jstat -gcutil "\$ESS_PID" 1000 5 2>/dev/null

# ── Parse GC pauses from application log ──────────────────────────────────
log ""
log "=== GC Pauses from Server Log (last 500 lines) ==="
tail -500 "\$LOG_DIR/\$SERVER_NAME.log" 2>/dev/null \
  | grep -E "\[GC|GC pause|Full GC|Stop-the-world|pause time" \
  | tail -30

# ── Check current JVM args ─────────────────────────────────────────────────
log ""
log "=== Current JVM Arguments ==="
cat /proc/"\$ESS_PID"/cmdline 2>/dev/null | tr '\\0' '\\n' | grep -E "^-X|^-XX|^-Dfile" | sort

# ── Recommendations ────────────────────────────────────────────────────────
log ""
log "=== Recommendations ==="
XMX=\$(cat /proc/"\$ESS_PID"/cmdline 2>/dev/null | tr '\\0' '\\n' | grep "^-Xmx" | grep -oP '[0-9]+')
XMX_UNIT=\$(cat /proc/"\$ESS_PID"/cmdline 2>/dev/null | tr '\\0' '\\n' | grep "^-Xmx" | grep -oP '[mgMG]$' | tr '[:upper:]' '[:lower:]')
TOTAL_MEM_GB=\$(awk '/MemTotal/ {printf "%d", \$2/1048576}' /proc/meminfo)
HALF_MEM_MB=\$((TOTAL_MEM_GB * 512))

if [ -z "\$XMX" ]; then
  log "  [WARN] -Xmx not set — JVM using default heap sizing. Set explicitly."
  log "         Recommended: -Xmx\${HALF_MEM_MB}m (50% of \${TOTAL_MEM_GB} GB RAM)"
elif [ "\$XMX_UNIT" = "g" ] && [ "\$XMX" -lt 4 ]; then
  log "  [WARN] Heap is -Xmx\${XMX}g — may be too small for production Essbase."
  log "         Recommended: at least -Xmx8g for a production server."
else
  log "  [OK]  Heap is set: -Xmx\${XMX}\${XMX_UNIT}"
fi

GC_TYPE=\$(cat /proc/"\$ESS_PID"/cmdline 2>/dev/null | tr '\\0' '\\n' | grep -E "UseG1GC|UseParallelGC|UseConcMarkSweepGC" | head -1)
if echo "\$GC_TYPE" | grep -q "G1GC"; then
  log "  [OK]  G1GC is configured."
elif [ -z "\$GC_TYPE" ]; then
  log "  [WARN] GC type not explicitly set — add -XX:+UseG1GC for Essbase workloads."
else
  log "  [INFO] GC type: \$GC_TYPE — G1GC is preferred for Essbase."
fi
\`\`\`

---

## Script 7: Full Performance Report

Ties all diagnostics together into a single timestamped report covering all running databases.

\`\`\`bash
#!/bin/bash
# ess_full_perf_report.sh — Full Essbase performance report
# Iterates all running databases and produces a consolidated report.

REPORT="/tmp/ess_perf_report_$(date +%Y%m%d_%H%M%S).txt"
PASS=0; WARN=0; FAIL=0

log() { echo "\$1" | tee -a "\$REPORT"; }
hr()  { log "$(printf '%.0s=' {1..70})"; }

hr; log "  Essbase Performance Report"; log "  Server: \$ESS_HOST"; log "  $(date)"; hr
log ""

# ── 1. Server overview ─────────────────────────────────────────────────────
log "[1] Server Overview"
essmsh << EOF | tee -a "\$REPORT"
login \$ESS_ADMIN '\$ESS_PASS' on \$ESS_HOST;
display application all;
logout;
EOF

# ── 2. Per-database statistics ─────────────────────────────────────────────
log ""
log "[2] Per-Database Statistics"

# Get list of running databases
DB_LIST=\$(essmsh << 'EOF' 2>/dev/null
login admin 'your_password' on localhost;
display database all;
logout;
EOF
)

# For each known app/db pair (extend this list for your environment)
for APP_DB in "\$ESS_APP.\$ESS_DB" "GLReporting.Actuals"; do
  APP_NAME=\${APP_DB%%.*}
  DB_NAME=\${APP_DB##*.}
  log ""
  log "--- \$APP_DB ---"
  essmsh << EOF | tee -a "\$REPORT"
login \$ESS_ADMIN '\$ESS_PASS' on \$ESS_HOST;
query database \$APP_NAME.\$DB_NAME get statistics;
query database \$APP_NAME.\$DB_NAME get cache_settings;
logout;
EOF
done

# ── 3. Active sessions and locks ───────────────────────────────────────────
log ""
log "[3] Active Sessions"
essmsh << EOF | tee -a "\$REPORT"
login \$ESS_ADMIN '\$ESS_PASS' on \$ESS_HOST;
display session all;
logout;
EOF

# ── 4. JVM analysis ────────────────────────────────────────────────────────
log ""
log "[4] JVM Heap"
ESS_PID=\$(pgrep -f "essbase_server1" | head -1)
if [ -n "\$ESS_PID" ]; then
  jstat -gcutil "\$ESS_PID" 1000 3 2>/dev/null | tee -a "\$REPORT"
fi

# ── 5. OS resource usage ───────────────────────────────────────────────────
log ""
log "[5] OS Resource Snapshot"
{
  echo "--- CPU & Memory ---"
  vmstat 1 3
  echo ""
  echo "--- Disk I/O ---"
  iostat -x 1 3 2>/dev/null | head -30
  echo ""
  echo "--- File handles (oracle process) ---"
  if [ -n "\$ESS_PID" ]; then
    echo "Open file handles: \$(ls /proc/\$ESS_PID/fd 2>/dev/null | wc -l)"
    cat /proc/"\$ESS_PID"/limits 2>/dev/null | grep "open files"
  fi
} | tee -a "\$REPORT"

# ── Summary ────────────────────────────────────────────────────────────────
log ""
hr
log "  Report complete: \$REPORT"
hr
\`\`\`

---

## Quick Reference: Run Order

\`\`\`bash
chmod +x ess_inventory.sh ess_bso_diagnosis.sh ess_calc_profiler.sh
chmod +x implement_bso_tuning.sh ess_aso_agg_views.sh
chmod +x ess_jvm_analysis.sh ess_full_perf_report.sh

# Set environment
export ESSBASE_HOME=/u01/app/oracle/product/essbase21
export ESS_HOST=localhost
export ESS_ADMIN=admin
export ESS_PASS=your_admin_password
export ESS_APP=BudgetPlanning
export ESS_DB=Revenue
export PATH=\$ESSBASE_HOME/bin:\$PATH

# 1. Inventory all running databases
./ess_inventory.sh

# 2. Diagnose BSO block size and cache hit rates
./ess_bso_diagnosis.sh \$ESS_APP \$ESS_DB

# 3. Profile a calculation (run during a maintenance window)
./ess_calc_profiler.sh \$ESS_APP \$ESS_DB DEFAULT

# 4. Apply approved BSO tuning changes
./implement_bso_tuning.sh \$ESS_APP \$ESS_DB

# 5. For ASO cubes — diagnose, enable tracking, then rebuild views
./ess_aso_agg_views.sh GLReporting Actuals diagnose
./ess_aso_agg_views.sh GLReporting Actuals track
# ... wait 24 hours ...
./ess_aso_agg_views.sh GLReporting Actuals rebuild

# 6. Analyse JVM heap and GC
./ess_jvm_analysis.sh

# 7. Full consolidated report
./ess_full_perf_report.sh
\`\`\`
`,
};

async function main() {
  for (const post of [blogPost, runbookPost]) {
    await db.insert(posts).values(post).onConflictDoUpdate({
      target: posts.slug,
      set: {
        title: post.title,
        excerpt: post.excerpt,
        content: post.content,
        published: post.published,
        publishedAt: post.publishedAt,
        isPremium: post.isPremium,
      },
    });
    console.log('inserted:', post.slug);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
