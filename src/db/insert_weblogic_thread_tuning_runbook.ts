import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: WebLogic Thread Pool Diagnosis and Remediation for iStore DMZ',
  slug: 'weblogic-thread-tuning-istore-dmz-runbook',
  excerpt:
    'Step-by-step runbook with executable WLST and shell scripts to diagnose hogging and stuck threads, generate tuning recommendations, and implement thread pool, JDBC pool, and JVM changes on a WebLogic iStore server in the DMZ — with before/after validation.',
  category: 'weblogic' as const,
  published: true,
  publishedAt: new Date('2026-06-02'),
  isPremium: true,
  youtubeUrl: null,
  content: `This runbook accompanies the [WebLogic Thread Tuning guide](/posts/weblogic-thread-tuning-istore-dmz). It provides a self-contained set of scripts that assess the current state of an iStore managed server, produce a written recommendation report, and implement the approved changes — all without requiring manual navigation of the Admin Console.

**Prerequisites:**
- WLST available at \`$MW_HOME/oracle_common/common/bin/wlst.sh\`
- WebLogic admin credentials
- SSH access to the iStore DMZ host
- A maintenance window or low-traffic period for the managed server restart

---

## Phase 1: Diagnosis Script

This script connects to the Admin Server, collects the current thread pool configuration and live metrics, inspects all JDBC data sources, and writes a plain-text recommendation report to \`/tmp/wls_thread_report.txt\`.

Run it before making any changes. Review the report, then proceed to Phase 2.

### \`diagnose_threads.py\`

\`\`\`python
#!/usr/bin/env python
# diagnose_threads.py
# Usage: wlst.sh diagnose_threads.py
# Generates /tmp/wls_thread_report.txt with current state and recommendations.

import time, os

# ── Configuration ────────────────────────────────────────────────────────────
ADMIN_URL    = 't3://istore-dmz-admin:7001'   # update to your Admin Server URL
ADMIN_USER   = 'weblogic'
ADMIN_PASS   = 'your_password'
SERVER_NAME  = 'istore_server1'
REPORT_FILE  = '/tmp/wls_thread_report.txt'

# Tuning thresholds
MIN_IDLE_FLOOR        = 10    # warn if idle threads fall below this
STUCK_WARN_THRESHOLD  =  1    # any stuck thread is a warning
HOGGING_WARN_THRESHOLD = 5    # more than this is a problem
PENDING_WARN_THRESHOLD = 20   # queued requests waiting for a thread
DS_WAITING_THRESHOLD   =  1   # any connection wait is a warning
# ─────────────────────────────────────────────────────────────────────────────

lines = []

def log(msg=''):
    lines.append(msg)
    print(msg)

def hr():
    log('-' * 72)

def banner(title):
    hr()
    log('  ' + title)
    hr()

connect(ADMIN_USER, ADMIN_PASS, ADMIN_URL)
domainRuntime()

banner('WebLogic Thread & JDBC Diagnosis Report')
log('  Server  : ' + SERVER_NAME)
log('  Time    : ' + time.strftime('%Y-%m-%d %H:%M:%S'))
log('  Host    : ' + ADMIN_URL)
log()

# ── 1. Thread Pool ────────────────────────────────────────────────────────────
banner('1. Thread Pool — Live Metrics')

cd('/ServerRuntimes/' + SERVER_NAME + '/ThreadPoolRuntime/ThreadPoolRuntime')
total    = int(get('ExecuteThreadTotalCount'))
idle     = int(get('ExecuteThreadIdleCount'))
hogging  = int(get('HoggingThreadCount'))
stuck    = int(get('StuckThreadCount'))
pending  = int(get('PendingUserRequestCount'))
throughput = get('Throughput')

log('  Total threads      : %d' % total)
log('  Idle threads       : %d' % idle)
log('  Hogging threads    : %d' % hogging)
log('  Stuck threads      : %d' % stuck)
log('  Pending requests   : %d' % pending)
log('  Throughput (req/s) : %.1f' % throughput)
log()

# ── 2. Thread Pool Config ─────────────────────────────────────────────────────
banner('2. Thread Pool — Configuration')

cd('/ServerRuntimes/' + SERVER_NAME)
stuck_max_time   = get('StuckThreadMaxTime')
stuck_timer      = get('StuckThreadTimerInterval')

try:
    cd('/Servers/' + SERVER_NAME + '/SelfTuning/' + SERVER_NAME)
    min_threads = get('MinThreadsConstraintCount')
    max_threads = get('MaxThreadsConstraintCount')
except:
    min_threads = 'n/a'
    max_threads = 'n/a'

log('  SelfTuning MinThreads    : %s' % str(min_threads))
log('  SelfTuning MaxThreads    : %s' % str(max_threads))
log('  StuckThreadMaxTime (s)   : %s' % str(stuck_max_time))
log('  StuckThreadTimerInterval : %s' % str(stuck_timer))
log()

# ── 3. JDBC Data Sources ──────────────────────────────────────────────────────
banner('3. JDBC Data Sources — Live State')

domainRuntime()
ds_path = '/ServerRuntimes/' + SERVER_NAME + '/JDBCServiceRuntime/' + SERVER_NAME + '/JDBCDataSourceRuntimeMBeans'
cd(ds_path)
datasources = ls(returnMap='true')

ds_issues = []

if datasources:
    for ds in sorted(datasources.keys()):
        try:
            cd(ds_path + '/' + ds)
            active   = int(get('ActiveConnectionsCurrentCount'))
            waiting  = int(get('WaitingForConnectionCurrentCount'))
            high     = int(get('ActiveConnectionsHighCount'))
            failed   = int(get('FailedReserveRequestCount'))
            state    = get('State')
            log('  [%s]' % ds)
            log('    State           : %s' % str(state))
            log('    Active conns    : %d  (high watermark: %d)' % (active, high))
            log('    Waiting threads : %d' % waiting)
            log('    Failed reserves : %d' % failed)
            log()
            if waiting >= DS_WAITING_THRESHOLD:
                ds_issues.append((ds, waiting, failed))
        except Exception as e:
            log('  [%s] ERROR: %s' % (ds, str(e)))
            log()
else:
    log('  No JDBC data sources found on ' + SERVER_NAME)
    log()

# ── 4. Server Health ──────────────────────────────────────────────────────────
banner('4. Server Health State')

domainRuntime()
cd('/ServerRuntimes/' + SERVER_NAME)
health = get('HealthState')
log('  Health : %s' % str(health))
log()

# ── 5. Recommendations ───────────────────────────────────────────────────────
banner('5. Recommendations')

problems  = []
rec_lines = []

# Thread pool checks
if stuck >= STUCK_WARN_THRESHOLD:
    problems.append('CRITICAL: %d stuck thread(s) detected' % stuck)
    rec_lines.append('  [CRITICAL] Stuck threads present — immediate action required.')
    rec_lines.append('    - Take a thread dump now: jstack <pid> > /tmp/threaddump_$(date +%%H%%M%%S).txt')
    rec_lines.append('    - Identify blocking thread and root cause before tuning.')

if hogging >= HOGGING_WARN_THRESHOLD:
    problems.append('WARNING: %d hogging thread(s)' % hogging)
    rec_lines.append('  [WARNING] High hogging thread count.')
    rec_lines.append('    - Check for slow DB queries, missing HTTP timeouts, or large catalog renders.')

if idle < MIN_IDLE_FLOOR and total > 0:
    problems.append('WARNING: only %d idle thread(s) — pool near exhaustion' % idle)
    rec_lines.append('  [WARNING] Thread pool near exhaustion (idle=%d).' % idle)
    new_min = max(75, total + 25)
    rec_lines.append('    - Increase SelfTuning MinThreadsConstraintCount to at least %d.' % new_min)
    rec_lines.append('    - Run implement_threads.py to apply this change dynamically.')

if pending >= PENDING_WARN_THRESHOLD:
    problems.append('WARNING: %d request(s) queued waiting for a thread' % pending)
    rec_lines.append('  [WARNING] %d requests pending — clients are waiting for a thread.' % pending)
    rec_lines.append('    - Increase thread pool minimum immediately.')

if stuck_max_time > 300:
    rec_lines.append('  [INFO] StuckThreadMaxTime is %ds — consider reducing to 300s for faster detection.' % stuck_max_time)

if stuck_timer > 30:
    rec_lines.append('  [INFO] StuckThreadTimerInterval is %ds — consider reducing to 30s.' % stuck_timer)

# JDBC checks
for (ds, waiting, failed) in ds_issues:
    problems.append('WARNING: data source %s has %d thread(s) waiting for a connection' % (ds, waiting))
    rec_lines.append('  [WARNING] JDBC pool exhaustion on %s (waiting=%d, failed_reserves=%d).' % (ds, waiting, failed))
    rec_lines.append('    - Increase MaxCapacity on this data source to match the thread pool minimum.')
    rec_lines.append('    - Enable TestConnectionsOnReserve to detect stale DMZ firewall-dropped connections.')

if not problems:
    log('  No critical issues detected at time of report.')
    log('  Review config values above against recommended settings in the tuning guide.')
else:
    for p in problems:
        log('  !! ' + p)
    log()
    for r in rec_lines:
        log(r)

log()
hr()
log('  Report complete: ' + time.strftime('%Y-%m-%d %H:%M:%S'))
hr()

# Write report file
with open(REPORT_FILE, 'w') as f:
    f.write('\n'.join(lines))

print()
print('Report written to: ' + REPORT_FILE)
disconnect()
\`\`\`

Run it:

\`\`\`bash
$MW_HOME/oracle_common/common/bin/wlst.sh diagnose_threads.py
cat /tmp/wls_thread_report.txt
\`\`\`

---

## Phase 2: Implementation Script

Review the report from Phase 1. When you are ready to apply changes, edit the configuration block at the top of this script to match your environment and approved values, then run it.

Changes to the thread pool minimum and stuck thread timers are applied **dynamically** — no restart required. Changes to JVM startup arguments and JDBC MaxCapacity require a managed server restart.

### \`implement_threads.py\`

\`\`\`python
#!/usr/bin/env python
# implement_threads.py
# Usage: wlst.sh implement_threads.py
# Applies thread pool, stuck thread timer, and JDBC pool changes.
# Review all values in the Configuration block before running.

import time

# ── Configuration — review before running ─────────────────────────────────────
ADMIN_URL   = 't3://istore-dmz-admin:7001'
ADMIN_USER  = 'weblogic'
ADMIN_PASS  = 'your_password'
SERVER_NAME = 'istore_server1'

# Thread pool
NEW_MIN_THREADS = 75     # SelfTuning minimum — applied dynamically
NEW_MAX_THREADS = 400    # SelfTuning maximum — applied dynamically

# Stuck thread detection
NEW_STUCK_MAX_TIME   = 300   # seconds before a thread is marked stuck (default 600)
NEW_STUCK_TIMER_INTV = 30    # check interval in seconds (default 60)

# JDBC data sources to tune — list of (datasource_name, new_max_capacity)
# Set to [] to skip JDBC changes
JDBC_CHANGES = [
    ('EBSDataSource',  100),
    ('EBSDataSource2', 100),
]

# JVM arguments to add to the managed server startup
# These require a managed server restart to take effect
JVM_ARGS = (
    '-Dsun.net.client.defaultConnectTimeout=10000 '
    '-Dsun.net.client.defaultReadTimeout=30000 '
    '-XX:+UseG1GC '
    '-XX:MaxGCPauseMillis=200 '
    '-XX:G1HeapRegionSize=16m '
    '-Xss512k'
)

RESTART_REQUIRED = len(JDBC_CHANGES) > 0 or len(JVM_ARGS) > 0
# ─────────────────────────────────────────────────────────────────────────────

def log(msg=''):
    print(msg)

connect(ADMIN_USER, ADMIN_PASS, ADMIN_URL)

log()
log('=' * 60)
log('  WebLogic Thread Remediation — ' + time.strftime('%Y-%m-%d %H:%M:%S'))
log('  Target server: ' + SERVER_NAME)
log('=' * 60)

edit()
startEdit()

# ── Thread Pool ───────────────────────────────────────────────────────────────
log()
log('[1/4] Applying thread pool settings...')

try:
    cd('/Servers/' + SERVER_NAME + '/SelfTuning/' + SERVER_NAME)
    set('MinThreadsConstraintCount', NEW_MIN_THREADS)
    set('MaxThreadsConstraintCount', NEW_MAX_THREADS)
    log('  MinThreadsConstraintCount -> %d' % NEW_MIN_THREADS)
    log('  MaxThreadsConstraintCount -> %d' % NEW_MAX_THREADS)
except Exception as e:
    log('  WARN: Could not set SelfTuning constraints: ' + str(e))
    log('  Falling back to server-level thread count...')
    cd('/Servers/' + SERVER_NAME)
    set('SelfTuningThreadPoolSizeMin', NEW_MIN_THREADS)
    set('SelfTuningThreadPoolSizeMax', NEW_MAX_THREADS)
    log('  SelfTuningThreadPoolSizeMin -> %d' % NEW_MIN_THREADS)
    log('  SelfTuningThreadPoolSizeMax -> %d' % NEW_MAX_THREADS)

# ── Stuck Thread Timers ───────────────────────────────────────────────────────
log()
log('[2/4] Applying stuck thread timer settings...')

cd('/Servers/' + SERVER_NAME)
set('StuckThreadMaxTime', NEW_STUCK_MAX_TIME)
set('StuckThreadTimerInterval', NEW_STUCK_TIMER_INTV)
log('  StuckThreadMaxTime       -> %d' % NEW_STUCK_MAX_TIME)
log('  StuckThreadTimerInterval -> %d' % NEW_STUCK_TIMER_INTV)

# ── JDBC Data Sources ─────────────────────────────────────────────────────────
log()
log('[3/4] Applying JDBC data source changes...')

if JDBC_CHANGES:
    for (ds_name, new_max) in JDBC_CHANGES:
        try:
            cd('/JDBCSystemResources/' + ds_name +
               '/JDBCResource/' + ds_name +
               '/JDBCConnectionPoolParams/' + ds_name)
            old_max = get('MaxCapacity')
            set('MaxCapacity', new_max)
            set('TestConnectionsOnReserve', true)
            set('TestTableName', 'SQL SELECT 1 FROM DUAL')
            log('  %s: MaxCapacity %s -> %d, TestConnectionsOnReserve=true' % (ds_name, str(old_max), new_max))
        except Exception as e:
            log('  WARN: Could not update data source %s: %s' % (ds_name, str(e)))
else:
    log('  No JDBC changes configured — skipping.')

# ── JVM Arguments ─────────────────────────────────────────────────────────────
log()
log('[4/4] Applying JVM startup arguments...')

if JVM_ARGS:
    try:
        cd('/Servers/' + SERVER_NAME + '/ServerStart/' + SERVER_NAME)
        existing = get('Arguments') or ''
        if existing:
            log('  Existing args: ' + existing)
        new_args = (existing + ' ' + JVM_ARGS).strip()
        set('Arguments', new_args)
        log('  Updated args: ' + new_args)
    except Exception as e:
        log('  WARN: Could not set JVM arguments: ' + str(e))
else:
    log('  No JVM argument changes configured — skipping.')

# ── Activate ──────────────────────────────────────────────────────────────────
log()
log('Activating changes...')
activate()
log('Changes activated.')

if RESTART_REQUIRED:
    log()
    log('*** RESTART REQUIRED ***')
    log('JDBC MaxCapacity and JVM argument changes require a managed server restart.')
    log('Thread pool and stuck thread timer changes are already active.')
    log()
    log('To restart the managed server:')
    log('  nmConnect and nmKill / nmStart, OR use the Admin Console.')
    log('  See restart_istore.py below.')
else:
    log()
    log('All changes are dynamic — no restart required.')

log()
log('=' * 60)
log('  Remediation complete — ' + time.strftime('%Y-%m-%d %H:%M:%S'))
log('=' * 60)

disconnect()
\`\`\`

---

## Phase 3: Managed Server Restart (if required)

If JDBC or JVM changes were applied, restart the managed server using Node Manager. This avoids needing shell access to the DMZ host.

### \`restart_istore.py\`

\`\`\`python
#!/usr/bin/env python
# restart_istore.py
# Usage: wlst.sh restart_istore.py
# Gracefully stops and restarts the iStore managed server via Node Manager.

import time

ADMIN_URL   = 't3://istore-dmz-admin:7001'
ADMIN_USER  = 'weblogic'
ADMIN_PASS  = 'your_password'
SERVER_NAME = 'istore_server1'

NM_HOST = 'istore-dmz-host'
NM_PORT = 5556
NM_TYPE = 'plain'             # use 'SSL' if Node Manager is configured for SSL

DOMAIN_NAME = 'EBS_domain'
DOMAIN_HOME = '/u01/app/oracle/middleware/user_projects/domains/EBS_domain'

GRACEFUL_TIMEOUT = 120        # seconds to wait for in-flight requests to complete

def log(msg=''):
    print('[%s] %s' % (time.strftime('%H:%M:%S'), msg))

log('Connecting to Admin Server...')
connect(ADMIN_USER, ADMIN_PASS, ADMIN_URL)

# ── Graceful shutdown ─────────────────────────────────────────────────────────
log('Initiating graceful shutdown of %s (timeout=%ds)...' % (SERVER_NAME, GRACEFUL_TIMEOUT))
try:
    shutdown(SERVER_NAME, 'Server', ignoreSessions=False,
             timeOut=GRACEFUL_TIMEOUT, force=False, block=True)
    log('Server stopped gracefully.')
except Exception as e:
    log('Graceful shutdown timed out or failed: ' + str(e))
    log('Forcing shutdown...')
    shutdown(SERVER_NAME, 'Server', ignoreSessions=True, force=True, block=True)
    log('Server force-stopped.')

disconnect()

# ── Start via Node Manager ────────────────────────────────────────────────────
log('Connecting to Node Manager at %s:%d...' % (NM_HOST, NM_PORT))
nmConnect(ADMIN_USER, ADMIN_PASS, NM_HOST, str(NM_PORT),
          DOMAIN_NAME, DOMAIN_HOME, NM_TYPE)

log('Starting %s...' % SERVER_NAME)
nmStart(SERVER_NAME)

log('Waiting for server to reach RUNNING state...')
timeout = 300
elapsed = 0
while elapsed < timeout:
    try:
        state = nmServerStatus(SERVER_NAME)
        log('  State: ' + str(state))
        if str(state) == 'RUNNING':
            break
    except Exception:
        pass
    time.sleep(10)
    elapsed += 10

if elapsed >= timeout:
    log('ERROR: Server did not reach RUNNING state within %ds.' % timeout)
    log('Check Node Manager and server logs.')
else:
    log('%s is RUNNING.' % SERVER_NAME)

nmDisconnect()
log('Restart complete.')
\`\`\`

---

## Phase 4: Validation Script

Run this after Phase 2 (and Phase 3 if a restart was done) to confirm the changes took effect and the server is healthy.

### \`validate_threads.py\`

\`\`\`python
#!/usr/bin/env python
# validate_threads.py
# Usage: wlst.sh validate_threads.py
# Verifies applied settings and prints a pass/fail summary.

import time

ADMIN_URL   = 't3://istore-dmz-admin:7001'
ADMIN_USER  = 'weblogic'
ADMIN_PASS  = 'your_password'
SERVER_NAME = 'istore_server1'

# Expected values — should match what you set in implement_threads.py
EXPECTED_MIN_THREADS     = 75
EXPECTED_STUCK_MAX_TIME  = 300
EXPECTED_STUCK_TIMER     = 30

def log(msg=''):
    print(msg)

def check(label, actual, expected, condition=None):
    passed = condition if condition is not None else (str(actual) == str(expected))
    status = 'PASS' if passed else 'FAIL'
    log('  [%s] %-45s actual=%-10s expected=%s' % (status, label, str(actual), str(expected)))
    return passed

connect(ADMIN_USER, ADMIN_PASS, ADMIN_URL)

log()
log('=' * 72)
log('  Thread Pool Validation — ' + time.strftime('%Y-%m-%d %H:%M:%S'))
log('=' * 72)

results = []

# ── Configuration checks ──────────────────────────────────────────────────────
log()
log('Configuration:')

domainRuntime()

try:
    cd('/Servers/' + SERVER_NAME + '/SelfTuning/' + SERVER_NAME)
    min_t = int(get('MinThreadsConstraintCount'))
except:
    min_t = None

cd('/Servers/' + SERVER_NAME)
stuck_max   = int(get('StuckThreadMaxTime'))
stuck_timer = int(get('StuckThreadTimerInterval'))

results.append(check('SelfTuning MinThreads', min_t, EXPECTED_MIN_THREADS))
results.append(check('StuckThreadMaxTime', stuck_max, EXPECTED_STUCK_MAX_TIME))
results.append(check('StuckThreadTimerInterval', stuck_timer, EXPECTED_STUCK_TIMER))

# ── Live state checks ─────────────────────────────────────────────────────────
log()
log('Live State (sampled at validation time — run under load for accuracy):')

domainRuntime()
cd('/ServerRuntimes/' + SERVER_NAME + '/ThreadPoolRuntime/ThreadPoolRuntime')
total   = int(get('ExecuteThreadTotalCount'))
idle    = int(get('ExecuteThreadIdleCount'))
hogging = int(get('HoggingThreadCount'))
stuck   = int(get('StuckThreadCount'))
pending = int(get('PendingUserRequestCount'))

results.append(check('Stuck thread count', stuck, 0))
results.append(check('Hogging thread count < 5', hogging, '<5', condition=(hogging < 5)))
results.append(check('Idle threads >= 10', idle, '>=10', condition=(idle >= 10)))
results.append(check('Pending requests = 0', pending, 0))

# ── Server health ─────────────────────────────────────────────────────────────
log()
log('Server Health:')

domainRuntime()
cd('/ServerRuntimes/' + SERVER_NAME)
health = str(get('HealthState'))
results.append(check('Server health state', health, 'HEALTH_OK',
                     condition=('HEALTH_OK' in health)))

# ── Summary ───────────────────────────────────────────────────────────────────
log()
log('=' * 72)
passed = sum(1 for r in results if r)
total_checks = len(results)
log('  Result: %d / %d checks passed' % (passed, total_checks))
if passed == total_checks:
    log('  STATUS: ALL CHECKS PASSED — thread tuning applied successfully.')
else:
    log('  STATUS: SOME CHECKS FAILED — review output above.')
log('=' * 72)

disconnect()
\`\`\`

---

## Quick Reference: Run Order

\`\`\`bash
WLST=$MW_HOME/oracle_common/common/bin/wlst.sh

# Step 1 — diagnose current state and generate report
$WLST diagnose_threads.py
cat /tmp/wls_thread_report.txt

# Step 2 — review report, edit configuration block in implement_threads.py, then:
$WLST implement_threads.py

# Step 3 — only if JDBC or JVM changes were made
$WLST restart_istore.py

# Step 4 — confirm changes took effect
$WLST validate_threads.py
\`\`\`

---

## Rollback

If the server behaves worse after changes, revert via WLST:

\`\`\`python
#!/usr/bin/env python
# rollback_threads.py — restore previous thread pool settings

ADMIN_URL   = 't3://istore-dmz-admin:7001'
ADMIN_USER  = 'weblogic'
ADMIN_PASS  = 'your_password'
SERVER_NAME = 'istore_server1'

# Previous values — fill in from the diagnosis report
PREV_MIN_THREADS     = 25
PREV_STUCK_MAX_TIME  = 600
PREV_STUCK_TIMER     = 60

connect(ADMIN_USER, ADMIN_PASS, ADMIN_URL)
edit()
startEdit()

try:
    cd('/Servers/' + SERVER_NAME + '/SelfTuning/' + SERVER_NAME)
    set('MinThreadsConstraintCount', PREV_MIN_THREADS)
except:
    cd('/Servers/' + SERVER_NAME)
    set('SelfTuningThreadPoolSizeMin', PREV_MIN_THREADS)

cd('/Servers/' + SERVER_NAME)
set('StuckThreadMaxTime', PREV_STUCK_MAX_TIME)
set('StuckThreadTimerInterval', PREV_STUCK_TIMER)

activate()
print('Rollback applied.')
disconnect()
\`\`\`
`,
};

async function main() {
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

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
