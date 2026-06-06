import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Oracle RAC Cluster Interconnect Configuration and Validation',
  slug: 'oracle-rac-cluster-interconnect-runbook',
  excerpt:
    'A phased operational runbook for configuring and validating the Oracle RAC cluster interconnect — covering OS-level MTU and bonding configuration, Cisco Nexus and Arista switch setup, Oracle Clusterware validation, and a production monitoring script with Cache Fusion latency alerting.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-05'),
  youtubeUrl: null,
  content: `## Purpose and Scope

This runbook provides step-by-step procedures for configuring, validating, and monitoring the Oracle RAC cluster interconnect from the OS network layer through the Oracle Clusterware layer. It assumes Oracle RAC 12.2 or later (procedures are identical for 19c and 21c), Red Hat Enterprise Linux or Oracle Linux as the host OS with root and oracle user access, SYSDBA access to the cluster database, Oracle Diagnostics Pack licensing for the AWR-based steps, and network administrator access to the private interconnect switches.

All phases can be executed independently — use Phase 0 for pre-installation audits, Phase 2 or 3 for switch configuration, Phase 5 for post-installation Oracle validation, and Phase 7 as an ongoing monitoring deployment.

---

## Phase 0: Pre-Installation Network Audit

### Step 0.1 — Identify Current Interconnect Interfaces from Clusterware

Run as the oracle user to see what Oracle currently knows about the network interfaces and their assigned roles.

\`\`\`bash
# Run as oracle user
oifcfg getif
# Expected output shows 'cluster_interconnect' role
# Example:
# eth0  10.0.0.0  global  public
# eth1  192.168.10.0  global  cluster_interconnect
# bond1  192.168.10.0  global  cluster_interconnect
\`\`\`

If the interconnect interface is not listed, or is listed with the wrong subnet, it must be reconfigured before proceeding.

### Step 0.2 — Check Current MTU on All Interconnect Interfaces

\`\`\`bash
ip link show | grep -E '(eth|ens|bond|ib)' | grep -v lo
# Or for a specific interface:
ip link show eth1 | grep mtu
# Look for: mtu 9000  (or 9216 on some configurations)
# A value of 1500 means Jumbo Frames are not configured
\`\`\`

### Step 0.3 — Verify MTU End-to-End with Ping

This is the definitive test. The 8972 value accounts for the 20-byte IP header and 8-byte ICMP header, producing a 9000-byte frame.

\`\`\`bash
# 8972 = 9000 - 20 (IP header) - 8 (ICMP header)
ping -M do -s 8972 -c 4 <interconnect_IP_of_remote_node>
# Must complete without fragmentation errors
# "Message too long" or "Frag needed" = MTU mismatch somewhere in the path
# Success output: 64 bytes from 192.168.10.2: icmp_seq=1 ttl=64 time=0.X ms
\`\`\`

Run this test from every node to every other node's interconnect IP. A failure on any pair indicates a misconfigured switch port or NIC on that path.

### Step 0.4 — Check Current Bond/NIC Configuration

\`\`\`bash
cat /proc/net/bonding/bond1   # adjust interface name as needed
# Key fields to verify:
# Bonding Mode: IEEE 802.3ad Dynamic link aggregation
# MII Status: up  (for each slave)
# Speed: 10000 Mbps  (or 25000 for 25GbE)
# Active Aggregator: shows active LACP aggregation
\`\`\`

---

## Phase 1: OS-Level Interconnect Configuration (RHEL/OL)

### Step 1.1 — Configure Jumbo Frames on Physical NICs (Persistent)

Edit the network interface configuration files. On RHEL/OL 7:

\`\`\`bash
# /etc/sysconfig/network-scripts/ifcfg-eth1
# Add or update the following line:
MTU=9000
\`\`\`

On RHEL/OL 8+ using NetworkManager, use nmcli instead:

\`\`\`bash
nmcli connection modify eth1 802-3-ethernet.mtu 9000
nmcli connection modify eth2 802-3-ethernet.mtu 9000
\`\`\`

### Step 1.2 — Configure Bond Interface with Jumbo Frames

\`\`\`bash
# /etc/sysconfig/network-scripts/ifcfg-bond1
DEVICE=bond1
TYPE=Bond
BONDING_MASTER=yes
BOOTPROTO=none
IPADDR=192.168.10.1
PREFIX=24
MTU=9000
BONDING_OPTS="mode=4 miimon=100 lacp_rate=1"
# mode=4 is IEEE 802.3ad LACP
# lacp_rate=1 = fast LACPDU exchange (1-second intervals)
# miimon=100 = link state check every 100ms
\`\`\`

### Step 1.3 — Apply MTU Without Reboot (Temporary)

Apply the MTU change to the running interfaces immediately. These changes do not survive a reboot — they complement the persistent configuration in Step 1.1 and 1.2.

\`\`\`bash
ip link set eth1 mtu 9000
ip link set eth2 mtu 9000
ip link set bond1 mtu 9000
# Verify:
ip link show bond1 | grep mtu
\`\`\`

### Step 1.4 — Verify OS Interconnect Parameters Oracle Cares About

Oracle recommends UDP socket buffer sizes of at least 4MB for high-traffic RAC interconnects.

\`\`\`bash
# Check UDP buffer sizes
sysctl net.core.rmem_max
sysctl net.core.wmem_max
sysctl net.core.rmem_default
sysctl net.core.wmem_default
# Recommended minimums for RAC:
# net.core.rmem_max = 4194304
# net.core.wmem_max = 4194304
# net.core.rmem_default = 262144
# net.core.wmem_default = 262144
\`\`\`

### Step 1.5 — Set UDP Buffer Sizes Persistently

\`\`\`bash
# Create or append to the Oracle-specific sysctl config file:
cat >> /etc/sysctl.d/99-oracle-rac.conf << 'EOF'
net.core.rmem_max = 4194304
net.core.wmem_max = 4194304
net.core.rmem_default = 262144
net.core.wmem_default = 262144
net.ipv4.conf.all.rp_filter = 2
EOF

sysctl -p /etc/sysctl.d/99-oracle-rac.conf
# Verify:
sysctl net.core.rmem_max
\`\`\`

Note: \`net.ipv4.conf.all.rp_filter = 2\` sets loose mode reverse path filtering, required for RAC with multiple NICs to prevent the kernel from dropping packets that arrive on an unexpected interface.

---

## Phase 2: Cisco Nexus Switch Configuration

### Host-Facing Port Configuration (Private Interconnect Ports)

Apply this configuration to every port that connects a server NIC to the private interconnect switch. The MTU of 9216 on Nexus delivers a 9000-byte payload after encapsulation overhead.

\`\`\`
interface Ethernet1/1
  description ORACLE_RAC_PRIVATE_NODE01_NIC1
  switchport mode access
  switchport access vlan 100
  mtu 9216
  spanning-tree port type edge
  no cdp enable
  no shutdown

interface Ethernet1/2
  description ORACLE_RAC_PRIVATE_NODE01_NIC2
  switchport mode access
  switchport access vlan 100
  mtu 9216
  spanning-tree port type edge
  no cdp enable
  no shutdown

interface Ethernet1/3
  description ORACLE_RAC_PRIVATE_NODE02_NIC1
  switchport mode access
  switchport access vlan 100
  mtu 9216
  spanning-tree port type edge
  no cdp enable
  no shutdown

interface Ethernet1/4
  description ORACLE_RAC_PRIVATE_NODE02_NIC2
  switchport mode access
  switchport access vlan 100
  mtu 9216
  spanning-tree port type edge
  no cdp enable
  no shutdown
\`\`\`

\`spanning-tree port type edge\` is Nexus NX-OS terminology for PortFast. It forces the port directly into the forwarding state on link-up, bypassing the standard STP listening and learning phases that would otherwise take 30 seconds and trigger node evictions.

\`no cdp enable\` prevents Cisco Discovery Protocol advertisements from the switch to the Oracle servers, which is a security best practice for interconnect-only ports.

### vPC Peer-Link Configuration (Between the Two Nexus Switches)

The vPC peer-link is the inter-switch link that makes the two physical Nexus switches appear as a single logical switch to the LACP-bonded server NICs. It carries vPC control traffic and forwarded data frames. Configure this on both switches.

\`\`\`
vpc domain 10
  peer-keepalive destination <mgmt_IP_switch_B> source <mgmt_IP_switch_A>
  peer-gateway
  auto-recovery
  delay restore 150

interface port-channel1
  description VPC_PEER_LINK
  switchport mode trunk
  switchport trunk allowed vlan 100
  spanning-tree port type network
  vpc peer-link
  no shutdown
\`\`\`

\`peer-keepalive\` uses the out-of-band management network to verify that the peer switch is alive even if the peer-link itself fails, preventing a split-brain condition where both switches simultaneously act as the primary.

### VLAN and STP Global Settings

\`\`\`
vlan 100
  name ORACLE_RAC_PRIVATE_INTERCONNECT

spanning-tree mode rapid-pvst
spanning-tree vlan 100 priority 4096
! Priority 4096 makes this switch the STP root for VLAN 100
! on the primary switch; set 8192 on the secondary switch

interface vlan 100
  description RAC_PRIVATE_SVI
  no ip redirects
  no ip proxy-arp
  no ip address
  ! No IP address on the SVI — the private interconnect is Layer 2 only
\`\`\`

### Jumbo Frames — Global QoS Policy (Nexus NX-OS)

On Nexus, the system MTU for data-plane traffic is set via a QoS policy applied system-wide, not per-interface alone. The per-interface \`mtu 9216\` must be combined with this system-level policy.

\`\`\`
policy-map type network-qos jumbo
  class type network-qos class-default
    mtu 9216

system qos
  service-policy type network-qos jumbo
\`\`\`

Verify after applying:

\`\`\`
show queuing interface Ethernet1/1
show interface Ethernet1/1 | include MTU
\`\`\`

### Disable IGMP Snooping on Private Interconnect VLAN

\`\`\`
vlan 100
  no ip igmp snooping
\`\`\`

This prevents Oracle Clusterware multicast traffic from being silently blocked when no IGMP querier is present.

---

## Phase 3: Arista EOS Configuration (Alternative to Cisco)

### Host-Facing Port Configuration

Arista uses 9214 as the MTU value for Jumbo Frames (versus Nexus 9216) due to different encapsulation overhead accounting.

\`\`\`
interface Ethernet1
   description ORACLE_RAC_PRIVATE_NODE01_NIC1
   switchport access vlan 100
   switchport mode access
   spanning-tree portfast
   no spanning-tree bpduguard
   mtu 9214
   no shutdown

interface Ethernet2
   description ORACLE_RAC_PRIVATE_NODE01_NIC2
   switchport access vlan 100
   switchport mode access
   spanning-tree portfast
   no spanning-tree bpduguard
   mtu 9214
   no shutdown

interface Ethernet3
   description ORACLE_RAC_PRIVATE_NODE02_NIC1
   switchport access vlan 100
   switchport mode access
   spanning-tree portfast
   no spanning-tree bpduguard
   mtu 9214
   no shutdown

interface Ethernet4
   description ORACLE_RAC_PRIVATE_NODE02_NIC2
   switchport access vlan 100
   switchport mode access
   spanning-tree portfast
   no spanning-tree bpduguard
   mtu 9214
   no shutdown
\`\`\`

### Global STP and MTU Settings on Arista

\`\`\`
spanning-tree mode rapid-pvst
spanning-tree vlan 100 priority 4096

management defaults
   ip mtu 9214

vlan 100
   name ORACLE_RAC_PRIVATE_INTERCONNECT
   no igmp-snooping
\`\`\`

Verify Arista configuration:

\`\`\`
show interfaces Ethernet1 | grep MTU
show spanning-tree vlan 100
show vlan 100
\`\`\`

---

## Phase 4: IGMP and Multicast Isolation

### Step 4.1 — Disable IGMP Snooping on Cisco Nexus

If not already done in Phase 2:

\`\`\`
configure terminal
vlan 100
  no ip igmp snooping
exit
copy running-config startup-config
\`\`\`

### Step 4.2 — Verify Multicast Group Membership from Linux

Oracle Clusterware registers multicast group memberships on the interconnect interface. Verify these are present after clusterware is started.

\`\`\`bash
# Check Oracle multicast group membership
netstat -gn | grep -E '(224|239|230)\.'
# Oracle Clusterware typically uses the 230.0.1.0 range
# Expected output shows the interconnect interface (bond1 or eth1) in the group
\`\`\`

Alternatively, check with the ip command:

\`\`\`bash
ip maddr show dev bond1
# Look for 'link' entries showing multicast group addresses
\`\`\`

### Step 4.3 — Configure IGMP Querier (If Snooping Is Left Enabled)

If your security policy requires IGMP snooping to remain enabled, configure the switch as the IGMP querier for the private VLAN:

\`\`\`
! Cisco Nexus:
vlan 100
  ip igmp snooping querier 192.168.10.254
  ip igmp snooping querier version 2

! Verify:
show ip igmp snooping querier vlan 100
\`\`\`

---

## Phase 5: Oracle Clusterware Interconnect Validation

### Step 5.1 — Check Oracle's View of the Interconnect Interfaces

\`\`\`bash
# Run as oracle user (or grid user)
oifcfg getif
# Expected: each interconnect NIC/bond listed with 'cluster_interconnect' role
# Example:
# bond1  192.168.10.0  global  cluster_interconnect
# bond2  192.168.20.0  global  cluster_interconnect
\`\`\`

If an interface is missing or assigned the wrong role, register it explicitly:

\`\`\`bash
# Register the interface with Oracle Clusterware:
oifcfg setif -global bond1/192.168.10.0:cluster_interconnect
\`\`\`

### Step 5.2 — Check Cluster Interconnect Statistics via oradebug

\`\`\`bash
# As oracle user, connect to a running instance:
sqlplus / as sysdba <<'SQLEOF'
oradebug setmypid
oradebug ipc
exit
SQLEOF
# The oradebug ipc output shows:
# Waiting connections: (should be 0 or very low)
# Send/receive rates per interconnect interface
# Errors: (any non-zero value indicates problems)
\`\`\`

### Step 5.3 — Check CSS Misscount and Disk Timeout

\`\`\`bash
# Run as grid or root user
crsctl get css misscount
# Default: 30 seconds — do NOT lower below 30 without Oracle Support guidance

crsctl get css disktimeout
# Default: 200 seconds — time before a disk is declared failed

crsctl get css reboottime
# Default: 3 seconds — time between node eviction decision and forced reboot
\`\`\`

These values define the window between a network failure and a node eviction. The STP PortFast configuration in Phase 2 ensures that link flap recovery (sub-second) stays well within the CSS misscount window (30 seconds).

### Step 5.4 — Check for Node Eviction History in Clusterware Alert Log

\`\`\`bash
# Find and search the Grid Infrastructure alert log:
grep -i "evict\|reboot\|splitbrain\|network\|css" \
  \${GRID_HOME}/log/\$(hostname -s)/alert\$(hostname -s).log 2>/dev/null | tail -50

# Alternative: find all alert logs and check for eviction events:
find \${GRID_HOME}/log -name "alert*.log" -newer /tmp -exec grep -l "evict" {} \;

# Check the CRS daemon log for recent errors:
tail -100 \${GRID_HOME}/log/\$(hostname -s)/crsd/crsd.log | grep -i "error\|evict\|fail"
\`\`\`

### Step 5.5 — Test Interconnect Bandwidth with iperf3 (Before Go-Live)

Run this test before adding nodes to the cluster to verify that the switch and NIC configuration delivers expected throughput.

\`\`\`bash
# On node 2 — start iperf3 in server mode bound to interconnect IP:
iperf3 -s -B 192.168.10.2 -p 5201 -D
# -D runs as daemon in background

# On node 1 — run the client test with 4 parallel streams for 30 seconds:
iperf3 -c 192.168.10.2 -B 192.168.10.1 -p 5201 -t 30 -P 4
# -P 4 = 4 parallel streams to stress-test the interconnect
# Expected: >= 9.5 Gbps for a 10GbE interconnect
# Expected: >= 23 Gbps for a 25GbE interconnect

# Clean up server on node 2:
pkill iperf3
\`\`\`

A result significantly below the expected bandwidth (more than 10% degradation) indicates switch configuration issues, NIC driver problems, or LACP negotiation failures.

---

## Phase 6: Cache Fusion Performance Monitoring (Oracle SQL)

### Step 6.1 — Check Current Interconnect Configuration from GV$CLUSTER_INTERCONNECTS

\`\`\`sql
SELECT inst_id,
       name,
       ip_address,
       is_public,
       source
FROM gv\$cluster_interconnects
ORDER BY inst_id, name;
-- is_public = 'NO' confirms these are the private interconnect interfaces
-- source = 'OCR' means Oracle retrieved the interface from the OCR
-- source = 'OIFCFG' means it was manually configured via oifcfg
\`\`\`

### Step 6.2 — Cache Fusion Send and Receive Rates

\`\`\`sql
SELECT inst_id,
       name,
       value
FROM gv\$sysstat
WHERE name IN (
  'gc cr blocks served',
  'gc cr blocks received',
  'gc current blocks served',
  'gc current blocks received',
  'gc cr block receive time',
  'gc current block receive time'
)
ORDER BY inst_id, name;
-- 'served' = blocks sent to other nodes
-- 'received' = blocks fetched from other nodes
-- 'receive time' = cumulative time in centiseconds waiting for blocks
\`\`\`

### Step 6.3 — Average Cache Fusion Block Transfer Latency

\`\`\`sql
SELECT inst_id,
       round(
         sum(CASE WHEN name = 'gc cr block receive time' THEN value END) /
         nullif(sum(CASE WHEN name = 'gc cr blocks received' THEN value END), 0),
         2
       ) as avg_cr_latency_cs,
       round(
         sum(CASE WHEN name = 'gc current block receive time' THEN value END) /
         nullif(sum(CASE WHEN name = 'gc current blocks received' THEN value END), 0),
         2
       ) as avg_current_latency_cs
FROM gv\$sysstat
WHERE name IN (
  'gc cr block receive time',
  'gc cr blocks received',
  'gc current block receive time',
  'gc current blocks received'
)
GROUP BY inst_id
ORDER BY inst_id;
-- Latency is in centiseconds (1 cs = 10ms)
-- Target: < 1.0 cs for nodes in the same datacenter
-- Target: < 3.0 cs for stretched clusters across datacenters
-- Alert threshold: > 5.0 cs indicates network or load problem
\`\`\`

### Step 6.4 — Top Global Cache Wait Events from AWR

Requires Oracle Diagnostics Pack. Substitute the AWR snapshot IDs for the time window you want to analyze.

\`\`\`sql
SELECT e.event_name,
       sum(e.total_waits_fg)                      as total_waits,
       round(sum(e.time_waited_fg) / 1e6, 2)      as time_waited_sec,
       round(
         sum(e.time_waited_fg) /
         nullif(sum(e.total_waits_fg), 0) / 1e4,
         3
       )                                           as avg_wait_ms
FROM dba_hist_system_event e
WHERE e.snap_id BETWEEN &start_snap AND &end_snap
  AND e.event_name LIKE 'gc%'
GROUP BY e.event_name
ORDER BY sum(e.time_waited_fg) DESC
FETCH FIRST 10 ROWS ONLY;
-- High 'gc buffer busy acquire' or 'gc buffer busy release' = hot block contention
-- High 'gc cr multi block request' = large-block sequential read across nodes
-- High 'gc current block busy' = write contention on shared blocks
\`\`\`

### Step 6.5 — Detect Hot Blocks Causing Excessive Cache Fusion Traffic

\`\`\`sql
SELECT inst_id,
       obj#,
       count(*) as cr_requests
FROM gv\$cr_block_server
GROUP BY inst_id, obj#
ORDER BY count(*) DESC
FETCH FIRST 10 ROWS ONLY;
-- obj# identifies the object; join to dba_objects for name:
\`\`\`

\`\`\`sql
SELECT b.inst_id,
       b.obj#,
       o.owner,
       o.object_name,
       o.object_type,
       b.cr_requests
FROM (
  SELECT inst_id,
         obj#,
         count(*) as cr_requests
  FROM gv\$cr_block_server
  GROUP BY inst_id, obj#
  ORDER BY count(*) DESC
  FETCH FIRST 10 ROWS ONLY
) b
JOIN dba_objects o ON o.object_id = b.obj#
ORDER BY b.cr_requests DESC;
-- Hot blocks usually indicate missing or suboptimal indexes, or application
-- design issues (e.g., sequence generators, frequently updated control rows)
\`\`\`

---

## Phase 7: Interconnect Monitoring Shell Script

Save the following script to \`/u01/app/oracle/scripts/rac_interconnect/rac_interconnect_check.sh\` and make it executable with \`chmod 750\`.

\`\`\`bash
#!/bin/bash
# rac_interconnect_check.sh
# Oracle RAC Cluster Interconnect Health Check
# Usage: rac_interconnect_check.sh <ORACLE_SID> <REMOTE_INTERCONNECT_IP>
# Returns: exit code = number of issues found (Nagios-compatible)
# Dependencies: ping, sqlplus, oifcfg, mailx
#
# Example: rac_interconnect_check.sh PRODDB 192.168.10.2

##############################################################################
# Configuration
##############################################################################
ORACLE_SID=\${1:-PRODDB}
REMOTE_IC_IP=\${2:-192.168.10.2}
ALERT_EMAIL="dba-alerts@example.com"
GRID_HOME=/u01/app/grid/19.0.0
ORACLE_HOME=/u01/app/oracle/product/19.0.0/dbhome_1
ORACLE_BASE=/u01/app/oracle
BOND_IFACE=bond1
LOG_DIR=/u01/app/oracle/scripts/rac_interconnect/logs
LOG_FILE=\${LOG_DIR}/rac_interconnect_\$(date +%Y%m%d).log
WARN_LATENCY_CS=1.0
CRIT_LATENCY_CS=3.0
ISSUE_COUNT=0

export ORACLE_SID ORACLE_HOME ORACLE_BASE GRID_HOME

##############################################################################
# Setup
##############################################################################
mkdir -p "\${LOG_DIR}"
HOSTNAME=\$(hostname -s)
TIMESTAMP=\$(date '+%Y-%m-%d %H:%M:%S')

log() {
  echo "[\${TIMESTAMP}] \$1" | tee -a "\${LOG_FILE}"
}

alert() {
  local msg="\$1"
  log "ALERT: \${msg}"
  ISSUE_COUNT=\$((ISSUE_COUNT + 1))
  ALERT_BODY="\${ALERT_BODY}\n\${msg}"
}

log "===== RAC Interconnect Health Check START: \${HOSTNAME} ====="
log "Checking SID=\${ORACLE_SID}, Remote IC IP=\${REMOTE_IC_IP}"

##############################################################################
# Check 1: MTU end-to-end
##############################################################################
log "--- Check 1: MTU end-to-end ping ---"
if ping -M do -s 8972 -c 4 -W 3 "\${REMOTE_IC_IP}" > /dev/null 2>&1; then
  log "OK: MTU 9000 verified to \${REMOTE_IC_IP}"
else
  alert "MTU FAIL: ping -M do -s 8972 to \${REMOTE_IC_IP} failed. Possible MTU mismatch on switch or OS interface."
fi

##############################################################################
# Check 2: Bond/NIC status
##############################################################################
log "--- Check 2: Bond interface status ---"
BOND_FILE=/proc/net/bonding/\${BOND_IFACE}
if [ -f "\${BOND_FILE}" ]; then
  BOND_MODE=\$(grep "Bonding Mode" "\${BOND_FILE}" | awk -F': ' '{print \$2}')
  BOND_ACTIVE=\$(grep "Active Aggregator ID" "\${BOND_FILE}" | wc -l)
  MII_DOWN=\$(grep "MII Status: down" "\${BOND_FILE}" | wc -l)
  log "Bond mode: \${BOND_MODE}"
  if [ "\${MII_DOWN}" -gt 0 ]; then
    alert "BOND DEGRADED: \${MII_DOWN} slave interface(s) are down in \${BOND_IFACE}. Check physical cabling and switch port status."
  else
    log "OK: All bond slaves are up on \${BOND_IFACE}"
  fi
  # Check MTU of bond interface
  BOND_MTU=\$(ip link show "\${BOND_IFACE}" 2>/dev/null | grep -oP 'mtu \K[0-9]+')
  if [ "\${BOND_MTU}" -lt 9000 ]; then
    alert "MTU LOW: \${BOND_IFACE} MTU is \${BOND_MTU}, expected 9000 or higher. Run: ip link set \${BOND_IFACE} mtu 9000"
  else
    log "OK: \${BOND_IFACE} MTU=\${BOND_MTU}"
  fi
else
  alert "BOND FILE MISSING: /proc/net/bonding/\${BOND_IFACE} not found. Verify bond interface name and configuration."
fi

##############################################################################
# Check 3: Oracle interconnect interface configuration
##############################################################################
log "--- Check 3: Oracle interconnect interface (oifcfg) ---"
IC_IFACE=\$(\${GRID_HOME}/bin/oifcfg getif 2>/dev/null | grep cluster_interconnect | awk '{print \$1}' | head -1)
if [ -z "\${IC_IFACE}" ]; then
  alert "OIFCFG FAIL: No cluster_interconnect interface found via oifcfg getif. Oracle Clusterware may be using the public network for Cache Fusion."
else
  log "OK: Oracle interconnect interface = \${IC_IFACE}"
fi

##############################################################################
# Check 4: Cache Fusion latency via SQL
##############################################################################
log "--- Check 4: Cache Fusion latency ---"
CF_LATENCY=\$(sqlplus -s / as sysdba <<'SQLEOF' 2>/dev/null
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF TRIMOUT ON
SELECT round(
         sum(CASE WHEN name = 'gc cr block receive time' THEN value END) /
         nullif(sum(CASE WHEN name = 'gc cr blocks received' THEN value END), 0),
         2
       )
FROM v\$sysstat
WHERE name IN (
  'gc cr block receive time',
  'gc cr blocks received'
);
exit
SQLEOF
)
CF_LATENCY=\$(echo "\${CF_LATENCY}" | tr -d ' \n\r')

if [ -z "\${CF_LATENCY}" ] || [ "\${CF_LATENCY}" = "" ]; then
  log "INFO: Could not retrieve Cache Fusion latency (database may be down or no Cache Fusion activity)"
else
  log "Cache Fusion avg CR latency: \${CF_LATENCY} cs"
  # Use awk for floating point comparison
  WARN_CHECK=\$(awk -v lat="\${CF_LATENCY}" -v warn="\${WARN_LATENCY_CS}" 'BEGIN{print (lat+0 > warn+0) ? "1" : "0"}')
  CRIT_CHECK=\$(awk -v lat="\${CF_LATENCY}" -v crit="\${CRIT_LATENCY_CS}" 'BEGIN{print (lat+0 > crit+0) ? "1" : "0"}')
  if [ "\${CRIT_CHECK}" = "1" ]; then
    alert "CRITICAL: Cache Fusion CR latency \${CF_LATENCY} cs exceeds critical threshold \${CRIT_LATENCY_CS} cs. Check interconnect utilization, hot blocks, and network errors."
  elif [ "\${WARN_CHECK}" = "1" ]; then
    alert "WARNING: Cache Fusion CR latency \${CF_LATENCY} cs exceeds warning threshold \${WARN_LATENCY_CS} cs. Monitor for escalation."
  else
    log "OK: Cache Fusion CR latency \${CF_LATENCY} cs is within threshold"
  fi
fi

##############################################################################
# Check 5: Clusterware alert log for eviction events in last 24 hours
##############################################################################
log "--- Check 5: Clusterware eviction events (last 24h) ---"
ALERT_LOG="\${GRID_HOME}/log/\${HOSTNAME}/alert\${HOSTNAME}.log"
if [ -f "\${ALERT_LOG}" ]; then
  # Find events in the last 24 hours — extract from lines newer than yesterday
  EVICT_COUNT=\$(find "\${GRID_HOME}/log/\${HOSTNAME}" -name "alert*.log" \
    -newer "\$(find /tmp -maxdepth 0 -printf '%p')" 2>/dev/null | \
    xargs grep -il "evict\|splitbrain\|node.*down\|css.*evict" 2>/dev/null | wc -l)

  # Direct grep on alert log (last 2000 lines covers ~24h on a busy cluster)
  EVICT_LINES=\$(tail -2000 "\${ALERT_LOG}" 2>/dev/null | \
    grep -ic "evict\|splitbrain\|css.*error\|network.*interrupt" 2>/dev/null || echo 0)

  if [ "\${EVICT_LINES}" -gt 0 ]; then
    alert "EVICTION EVENTS: Found \${EVICT_LINES} eviction/network error line(s) in \${ALERT_LOG} (last 2000 lines). Review immediately."
    tail -2000 "\${ALERT_LOG}" | grep -i "evict\|splitbrain\|css.*error" | tail -10 >> "\${LOG_FILE}"
  else
    log "OK: No eviction events found in clusterware alert log"
  fi
else
  log "WARNING: Alert log not found at \${ALERT_LOG} — check GRID_HOME setting"
fi

##############################################################################
# Summary and alerting
##############################################################################
log "===== RAC Interconnect Health Check COMPLETE: \${ISSUE_COUNT} issue(s) found ====="

if [ "\${ISSUE_COUNT}" -gt 0 ]; then
  SUBJECT="RAC Interconnect Alert: \${ISSUE_COUNT} issue(s) on \${HOSTNAME} at \${TIMESTAMP}"
  BODY="RAC Interconnect Health Check Report
Host: \${HOSTNAME}
SID: \${ORACLE_SID}
Remote IC IP: \${REMOTE_IC_IP}
Timestamp: \${TIMESTAMP}
Issues Found: \${ISSUE_COUNT}

\$(echo -e "\${ALERT_BODY}")

Full log: \${LOG_FILE}
"
  echo "\${BODY}" | mailx -s "\${SUBJECT}" "\${ALERT_EMAIL}" 2>/dev/null || \
    echo "\${BODY}" | sendmail "\${ALERT_EMAIL}" 2>/dev/null || \
    log "WARNING: Could not send alert email (mailx/sendmail not configured)"
fi

exit \${ISSUE_COUNT}
\`\`\`

### Crontab Entry

Add the following entry to the oracle user's crontab on each RAC node. The script is idempotent — running it on all nodes provides per-node visibility since each node reports its own interface status and Cache Fusion latency.

\`\`\`bash
# Edit oracle user crontab:
crontab -u oracle -e
\`\`\`

\`\`\`
# RAC interconnect health check — every 15 minutes
*/15  *  *  *  *  /u01/app/oracle/scripts/rac_interconnect/rac_interconnect_check.sh PRODDB 192.168.10.2 >> /u01/app/oracle/scripts/rac_interconnect/logs/cron_rac.log 2>&1
\`\`\`

---

## Quick Reference

**Essential Commands**

| Command | Purpose |
|---|---|
| \`oifcfg getif\` | Show Oracle's registered network interfaces and their roles |
| \`crsctl get css misscount\` | Show the CSS heartbeat timeout (default 30s) |
| \`crsctl get css disktimeout\` | Show the disk failure detection timeout |
| \`oradebug ipc\` | Show interconnect IPC statistics from inside sqlplus |
| \`iperf3 -c <ip> -P 4 -t 30\` | Measure raw interconnect bandwidth with 4 parallel streams |
| \`ping -M do -s 8972 <ip>\` | Verify MTU 9000 end-to-end to the remote interconnect IP |

**Essential Oracle Views**

| View | Purpose |
|---|---|
| \`GV\$CLUSTER_INTERCONNECTS\` | Current interconnect interfaces as seen by Oracle — verify all nodes are using the correct private interface |
| \`GV\$SYSSTAT\` (gc stats) | Raw Cache Fusion block transfer counts and cumulative wait times |
| \`GV\$CR_BLOCK_SERVER\` | Per-object Cache Fusion consistent-read request counts — identifies hot blocks |
| \`DBA_HIST_SYSTEM_EVENT\` | Historical AWR data; filter on \`gc%\` events for interconnect wait history |

**Latency Thresholds**

| Metric | Healthy | Warning | Critical |
|---|---|---|---|
| Avg CR block receive time | < 1.0 cs | 1.0–3.0 cs | > 3.0 cs |
| Avg current block receive time | < 1.0 cs | 1.0–3.0 cs | > 3.0 cs |
| iperf3 bandwidth (10GbE) | >= 9.5 Gbps | 8–9.5 Gbps | < 8 Gbps |
| ping latency (same rack) | < 0.2 ms | 0.2–1.0 ms | > 1.0 ms |

**Switch Configuration Checklist**

1. Private interconnect VLAN (e.g., VLAN 100) is dedicated — no other hosts or traffic
2. MTU 9216 on Nexus or 9214 on Arista set on all host-facing ports and globally
3. \`spanning-tree port type edge\` (Nexus) or \`spanning-tree portfast\` (Arista) on all server-facing ports
4. RSTP/Rapid-PVST+ enabled globally on both switches
5. vPC peer-link (Nexus) or MLAG (Arista) configured between the two private interconnect switches
6. IGMP snooping disabled on the private interconnect VLAN
7. No IP routing configured for the private interconnect subnet`,
};

async function main() {
  console.log('Inserting Oracle RAC Cluster Interconnect runbook...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: { ...post },
  });
  console.log('Inserted: "' + post.title + '"');
}

main().catch(console.error);
