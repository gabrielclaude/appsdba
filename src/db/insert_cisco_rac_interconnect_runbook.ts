import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Runbook: Cisco Nexus Configuration for Oracle RAC Private Interconnect',
  slug: 'cisco-nexus-rac-interconnect-runbook',
  excerpt:
    'A step-by-step operational runbook for configuring Cisco Nexus 9000 switches for Oracle RAC 19c/21c private interconnect — covering complete NX-OS vPC domain setup, host-facing port configuration with MTU 9216 and PortFast Edge, system-wide jumbo QoS policy, OS-level LACP bond configuration on RHEL/OL 8, and Oracle Clusterware verification commands to confirm Cache Fusion is using the correct interconnect interface.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-05'),
  youtubeUrl: null,
  content: `This runbook provides complete, copy-paste-ready NX-OS and OS-level commands to configure a Cisco Nexus switch pair for Oracle RAC private interconnect. Follow the phases in order. Each step includes verification commands and expected output.

**Assumptions:**
- Cisco Nexus 9000 series running NX-OS 9.x or later (commands also apply to NX-OS 7.x with minor syntax differences noted)
- Oracle RAC 19c or 21c with Oracle Grid Infrastructure
- RHEL or Oracle Linux 8 or 9 on the RAC nodes
- Root access on the RAC nodes; network admin access on both Nexus switches
- 2-node RAC cluster in examples; 4-node differences called out explicitly
- Switch hostnames: Nexus-A (primary, role priority 100) and Nexus-B (secondary, role priority 200)
- Private interconnect VLAN: 100, subnet 192.168.10.0/24
- Management network: 10.0.99.0/24 (used for vPC peer-keepalive)

\`\`\`
Lab/Production Reference Topology

  RAC Node 1 (192.168.10.1)     RAC Node 2 (192.168.10.2)
  +--------------------------+   +--------------------------+
  | eth1 (to Nexus-A Eth1/1) |   | eth1 (to Nexus-A Eth1/2) |
  | eth2 (to Nexus-B Eth1/1) |   | eth2 (to Nexus-B Eth1/2) |
  | bond0 mtu 9000           |   | bond0 mtu 9000           |
  +-----------+--------------+   +-----------+--------------+
              |                              |
      Eth1/1  |                      Eth1/2  |
  +---+-------+-----+             +----------+------+
  |   Nexus-A       |             |   Nexus-B       |
  |   vPC Domain 10 +====Po1======+   vPC Domain 10 |
  |   Role: Primary |  Peer-Link  |   Role: Secondary|
  |   mgmt0:        +-mgmt0------+   mgmt0:         |
  |   10.0.99.1     |  keepalive  |   10.0.99.2     |
  +-----------------+             +-----------------+
\`\`\`

---

## Phase 0: Nexus Switch Initial Preparation

Run all Phase 0 steps on **both** Nexus-A and Nexus-B unless noted otherwise.

### Step 0.1: Enable Required NX-OS Features

NX-OS uses an explicit feature-enable model — protocols are not active until enabled. SSH into each switch and run:

\`\`\`
configure terminal
feature lacp
feature vpc
feature lldp
end
copy running-config startup-config
\`\`\`

LACP is required for the active-active server bonds. vPC is required for dual-switch operation. LLDP is useful for physical cable tracing and neighbour verification — especially helpful when cross-checking that eth1 on each node lands on Nexus-A and eth2 lands on Nexus-B.

**Verify features are enabled:**
\`\`\`
show feature | grep -E "lacp|vpc|lldp"
\`\`\`

Expected output:
\`\`\`
lacp                    1          enabled
lldp                    1          enabled
vpc                     1          enabled
\`\`\`

### Step 0.2: Configure the vPC Domain

Run on **Nexus-A** (role priority 100 = primary):
\`\`\`
configure terminal
vpc domain 10
  peer-keepalive destination 10.0.99.2 source 10.0.99.1 vrf management
  role priority 100
  peer-gateway
  auto-recovery
  auto-recovery reload-delay 240
  ip arp synchronize
  delay restore 150
end
copy running-config startup-config
\`\`\`

Run on **Nexus-B** (role priority 200 = secondary):
\`\`\`
configure terminal
vpc domain 10
  peer-keepalive destination 10.0.99.1 source 10.0.99.2 vrf management
  role priority 200
  peer-gateway
  auto-recovery
  auto-recovery reload-delay 240
  ip arp synchronize
  delay restore 150
end
copy running-config startup-config
\`\`\`

**Parameter notes:**
- \`peer-gateway\`: allows the secondary to forward frames destined to the primary's MAC — prevents black-holing of ARP traffic during asymmetric forwarding scenarios
- \`auto-recovery reload-delay 240\`: after a switch reboot, wait 240 seconds before declaring the peer dead to allow the peer time to reload before triggering auto-recovery
- \`ip arp synchronize\`: keeps ARP tables consistent between both switches — critical for UDP-based Cache Fusion forwarding
- \`delay restore 150\`: waits 150 seconds after the vPC peer-link comes up before restoring vPC member ports, allowing STP and LACP to converge first

### Step 0.3: Configure the vPC Peer-Link Port-Channel

The peer-link must be a dedicated port-channel — do not share it with other traffic. Use the highest-bandwidth available ports (40GE or 100GE). Run on **both** switches:

\`\`\`
configure terminal

! Member interfaces for the peer-link
interface Ethernet1/49
  description VPC_PEER_LINK_MEMBER_1
  switchport
  switchport mode trunk
  switchport trunk allowed vlan 100,200,300,400
  channel-group 1 mode active
  no shutdown

interface Ethernet1/50
  description VPC_PEER_LINK_MEMBER_2
  switchport
  switchport mode trunk
  switchport trunk allowed vlan 100,200,300,400
  channel-group 1 mode active
  no shutdown

! The peer-link port-channel
interface port-channel1
  description VPC_PEER_LINK
  switchport
  switchport mode trunk
  switchport trunk allowed vlan 100,200,300,400
  spanning-tree port type network
  mtu 9216
  vpc peer-link
  no shutdown

end
copy running-config startup-config
\`\`\`

**Critical:** \`spanning-tree port type network\` on the peer-link ensures it participates in STP correctly and is never inadvertently placed in PortFast mode.

### Step 0.4: Verify vPC Peer-Link Status

\`\`\`
show vpc
show vpc peer-keepalive
show port-channel summary
\`\`\`

Expected output from \`show vpc\`:
\`\`\`
vPC domain id                     : 10
Peer status                       : peer adjacency formed ok
vPC keep-alive status             : peer is alive
Configuration consistency status  : success
Per-vlan consistency status       : success
Type-2 consistency status         : success
vPC role                          : primary
Number of vPCs configured         : 0
Peer Gateway                      : Enabled
Dual-active excluded VLANs        : -
Graceful Consistency Check        : Enabled
Auto-recovery status              : Enabled
Delay-restore status              : Timer is off.(timeout = 150s)
Delay-restore SVI status          : Timer is off.(timeout = 10s)
\`\`\`

Expected output from \`show vpc peer-keepalive\`:
\`\`\`
vPC keep-alive status             : peer is alive
--Peer is alive--
vPC Keep-alive Tx                 : 1234
vPC Keep-alive Rx                 : 1234
vPC Keep-alive last Tx            : 00:00:00:123456
vPC Keep-alive last Rx            : 00:00:00:123456
\`\`\`

If \`Peer status\` shows anything other than \`peer adjacency formed ok\`, verify the peer-link cables and that both switches have the same \`vpc domain 10\` configuration. If \`vPC keep-alive status\` shows \`peer is unreachable\`, verify the management IP addresses and that the mgmt0 interfaces are in the management VRF.

---

## Phase 1: VLAN Configuration

Run on **both** Nexus-A and Nexus-B.

### Step 1.1: Create the RAC VLANs

\`\`\`
configure terminal
vlan 100
  name ORACLE_RAC_PRIVATE_INTERCONNECT
vlan 200
  name ORACLE_RAC_PUBLIC
vlan 300
  name ORACLE_SCAN
vlan 400
  name ORACLE_STORAGE_ISCSI
end
copy running-config startup-config
\`\`\`

**Verify:**
\`\`\`
show vlan brief
\`\`\`

### Step 1.2: Configure SVI for Private VLAN — No Routing

The VLAN 100 SVI should exist but carry no IP address and no routing. Its only permitted role is as an optional IGMP querier source (covered in Step 1.3).

\`\`\`
configure terminal
interface vlan 100
  description RAC_PRIVATE_NO_ROUTING
  no ip redirects
  no ip proxy-arp
  no ip address
  no shutdown
end
\`\`\`

**Do NOT assign an IP address or default gateway to VLAN 100.** It must remain a closed Layer 2 domain. Routing on the private interconnect VLAN has caused subtle RAC failures where inter-node traffic was accidentally routed through a gateway instead of being switched directly — adding latency and occasionally losing packets at the gateway.

### Step 1.3: Disable IGMP Snooping on the Private VLAN

\`\`\`
configure terminal
no ip igmp snooping vlan 100
end
copy running-config startup-config
\`\`\`

**Verify:**
\`\`\`
show ip igmp snooping vlan 100
\`\`\`

Expected: \`IGMP snooping: Disabled\`

This ensures Oracle Clusterware multicast traffic (GNS, ONS, CSS — typically in the 230.0.1.x range) is flooded to all ports in VLAN 100 without requiring an IGMP querier. On a small private interconnect VLAN with 2–8 nodes, the flooding overhead is negligible.

---

## Phase 2: Host-Facing Port Configuration (RAC Private Interconnect Ports)

These steps configure the physical ports that connect to RAC node NICs. The pattern is: access mode on VLAN 100, MTU 9216, PortFast Edge, BPDU Guard. For active-active dual-switch LACP bonds, each port must also be a vPC member via a port-channel.

### Step 2.1: Configure a Single RAC Node Port (Nexus-A, Node 1)

\`\`\`
configure terminal

! Physical interface — add to port-channel
interface Ethernet1/1
  description RAC_NODE01_PRIV_NIC1
  switchport
  switchport mode access
  switchport access vlan 100
  mtu 9216
  spanning-tree port type edge
  spanning-tree bpduguard enable
  no cdp enable
  no lldp transmit
  no lldp receive
  channel-group 101 mode active
  no shutdown

! vPC port-channel for this RAC node
interface port-channel101
  description RAC_NODE01_BOND0_VPC
  switchport
  switchport mode access
  switchport access vlan 100
  mtu 9216
  spanning-tree port type edge
  spanning-tree bpduguard enable
  vpc 101
  no shutdown

end
copy running-config startup-config
\`\`\`

**Key detail:** \`vpc 101\` on port-channel101 binds this port-channel into the vPC fabric. The matching port-channel101 on Nexus-B with the same \`vpc 101\` number completes the dual-switch LACP bond from the server's perspective. The vPC number (101) must match exactly between both switches for each RAC node.

\`no cdp enable\` and \`no lldp transmit/receive\` on host-facing ports are hardening measures — they prevent the switch from advertising topology information to the server and reduce unnecessary protocol traffic on the private interconnect.

### Step 2.2: Corresponding Configuration on Nexus-B for the Same Node

Run on **Nexus-B**:
\`\`\`
configure terminal

interface Ethernet1/1
  description RAC_NODE01_PRIV_NIC2
  switchport
  switchport mode access
  switchport access vlan 100
  mtu 9216
  spanning-tree port type edge
  spanning-tree bpduguard enable
  no cdp enable
  no lldp transmit
  no lldp receive
  channel-group 101 mode active
  no shutdown

interface port-channel101
  description RAC_NODE01_BOND0_VPC
  switchport
  switchport mode access
  switchport access vlan 100
  mtu 9216
  spanning-tree port type edge
  spanning-tree bpduguard enable
  vpc 101
  no shutdown

end
copy running-config startup-config
\`\`\`

### Step 2.3: 4-Node Cluster — Port Assignment Summary

\`\`\`
! Nexus-A: all RAC node private NIC connections
interface Ethernet1/1  -> RAC_NODE01_PRIV_NIC1  (vpc 101)
interface Ethernet1/2  -> RAC_NODE02_PRIV_NIC1  (vpc 102)
interface Ethernet1/3  -> RAC_NODE03_PRIV_NIC1  (vpc 103)
interface Ethernet1/4  -> RAC_NODE04_PRIV_NIC1  (vpc 104)

! Nexus-B: matching connections
interface Ethernet1/1  -> RAC_NODE01_PRIV_NIC2  (vpc 101)
interface Ethernet1/2  -> RAC_NODE02_PRIV_NIC2  (vpc 102)
interface Ethernet1/3  -> RAC_NODE03_PRIV_NIC2  (vpc 103)
interface Ethernet1/4  -> RAC_NODE04_PRIV_NIC2  (vpc 104)
\`\`\`

Repeat the port-channel and vpc configurations for 102, 103, 104 on both switches. The vPC number must match between Nexus-A and Nexus-B for each RAC node.

### Step 2.4: Verify LACP Bond from Switch Side

\`\`\`
show port-channel summary
show vpc brief
show lacp neighbor interface port-channel101
\`\`\`

Expected from \`show vpc brief\`:
\`\`\`
vPC Status
-----------------------------------------------------
Id    Port          Status Consistency Reason
101   Po101         up     success     -
102   Po102         up     success     -
\`\`\`

Expected from \`show lacp neighbor interface port-channel101\`:
\`\`\`
Flags:  S - Device is requesting Slow LACPDUs
        F - Device is requesting Fast LACPDUs
        A - Device is in Active mode
        P - Device is in Passive mode

Partner's information for port-channel101
  Partner    System ID: 32768,aa:bb:cc:dd:ee:ff
  Port  Flags  Oper Key  Port Priority  Port State
  Eth1/1   SA    0x65       32768        bundled
\`\`\`

---

## Phase 3: Jumbo Frames — System-Wide QoS Policy

NX-OS requires a system network-QoS policy to activate jumbo frames globally. On NX-OS 7.x and several 9.x releases, setting \`mtu 9216\` on an interface alone is not sufficient — the system-wide network-QoS policy controls the actual maximum frame size accepted and forwarded. Run on **both** switches.

### Step 3.1: Create and Apply the Jumbo QoS Policy

\`\`\`
configure terminal

policy-map type network-qos JUMBO_MTU_9216
  class type network-qos class-default
    mtu 9216

system qos
  service-policy type network-qos JUMBO_MTU_9216

end
copy running-config startup-config
\`\`\`

### Step 3.2: Verify Jumbo Frames Are Active

\`\`\`
show queuing interface Ethernet1/1
show interface Ethernet1/1 | include MTU
show policy-map system type network-qos
\`\`\`

Expected from \`show interface Ethernet1/1 | include MTU\`:
\`\`\`
  MTU 9216 bytes, BW 10000000 Kbit
\`\`\`

Expected from \`show policy-map system type network-qos\`:
\`\`\`
  Type network-qos policy-maps
  ==============================
  policy-map type network-qos JUMBO_MTU_9216
    class type network-qos class-default
      mtu 9216
      multicast-optimize
\`\`\`

If you do not see MTU 9216 after applying the system QoS policy, reload the policy: \`no system qos\` followed by re-applying the service-policy.

### Step 3.3: Optional — DSCP-Based QoS to Prioritise Cache Fusion

If the private interconnect VLAN carries any non-Cache-Fusion traffic (uncommon but possible in shared environments), apply a DSCP-based strict-priority queue for Oracle traffic:

\`\`\`
configure terminal

! Match Cache Fusion traffic marked with DSCP EF (46)
class-map type qos match-all CACHE_FUSION
  match dscp 46

! Input policy: re-mark to qos-group 1
policy-map type qos CACHE_FUSION_PRIORITY
  class CACHE_FUSION
    set qos-group 1
  class class-default
    set qos-group 0

! Output queuing policy: strict priority for qos-group 1
policy-map type queuing CACHE_FUSION_QUEUE
  class type queuing c-out-q1
    priority level 1
    bandwidth remaining percent 40
  class type queuing c-out-q-default
    bandwidth remaining percent 60

! Apply to all RAC-facing interfaces
interface Ethernet1/1
  service-policy type qos input CACHE_FUSION_PRIORITY
  service-policy type queuing output CACHE_FUSION_QUEUE

end
copy running-config startup-config
\`\`\`

For Oracle to mark Cache Fusion traffic with DSCP 46, configure the OS-level DSCP marking using \`ip route\` with \`tos\` on Linux, or use Oracle's \`CLUSTER_INTERCONNECTS\` configuration. Verify marking with \`tcpdump -i eth1 -c 100 -n | grep dscp\` on the RAC nodes.

---

## Phase 4: Spanning Tree Configuration

Run on **both** switches.

### Step 4.1: Enable RSTP Globally

\`\`\`
configure terminal
spanning-tree mode rapid-pvst
end
copy running-config startup-config
\`\`\`

### Step 4.2: Set STP Priority — Nexus-A as Root for VLAN 100

On **Nexus-A** (primary):
\`\`\`
configure terminal
spanning-tree vlan 100 priority 4096
end
\`\`\`

On **Nexus-B** (secondary):
\`\`\`
configure terminal
spanning-tree vlan 100 priority 8192
end
copy running-config startup-config
\`\`\`

Lower priority wins the root election. Nexus-A with priority 4096 will be the STP root for VLAN 100. This ensures STP topology decisions for the private interconnect are made by the vPC primary.

### Step 4.3: Verify STP Topology

\`\`\`
show spanning-tree vlan 100
show spanning-tree vlan 100 detail
\`\`\`

Expected output on Nexus-A:
\`\`\`
VLAN0100
  Spanning tree enabled protocol rstp
  Root ID    Priority    4096
             Address     aaaa.bbbb.cccc
             This bridge is the root
             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec

  Bridge ID  Priority    4096   (priority 4096 sys-id-ext 100)
             Address     aaaa.bbbb.cccc

Interface           Role Sts Cost      Prio.Nbr Type
------------------- ---- --- --------- -------- ----
Po1                 Desg FWD 1         128.4097 Network P2p
Po101               Desg FWD 1         128.4198 Edge P2p
Po102               Desg FWD 1         128.4199 Edge P2p
\`\`\`

All host-facing port-channels should show \`Type: Edge P2p\` and state \`FWD\`. The peer-link (Po1) should show \`Type: Network P2p\`.

### Step 4.4: Verify BPDU Guard Status

\`\`\`
show spanning-tree summary
show spanning-tree bpduguard
\`\`\`

If any port shows \`BPDU Guard inconsistent\` in \`show spanning-tree inconsistentports\`, it has received a BPDU — a switch or hub is connected to that port. Investigate immediately:

\`\`\`
show spanning-tree bpduguard
! Check for any err-disabled ports:
show interface status | include err-disabled
! To recover a BPDU-guard err-disabled port after fixing the cable:
interface Ethernet1/1
  shutdown
  no shutdown
\`\`\`

---

## Phase 5: OS-Level (Linux) Interconnect Configuration

Run on **each RAC node** as root.

### Step 5.1: Configure Bond Interface for LACP

Using NetworkManager (nmcli) on RHEL/OL 8 and 9:

\`\`\`bash
# Remove any existing conflicting configurations
nmcli connection delete bond0 2>/dev/null || true
nmcli connection delete bond0-eth1 2>/dev/null || true
nmcli connection delete bond0-eth2 2>/dev/null || true

# Create the LACP bond (mode 4 = 802.3ad)
nmcli connection add type bond con-name bond0 ifname bond0 \
  bond.options "mode=4,miimon=100,lacp_rate=1,xmit_hash_policy=layer3+4"

# Add slave interfaces
nmcli connection add type ethernet con-name bond0-eth1 ifname eth1 \
  master bond0

nmcli connection add type ethernet con-name bond0-eth2 ifname eth2 \
  master bond0

# Configure IP address and jumbo MTU
nmcli connection modify bond0 \
  ipv4.method manual \
  ipv4.addresses 192.168.10.1/24 \
  802-3-ethernet.mtu 9000

# Bring up the bond
nmcli connection up bond0
\`\`\`

**Node IP assignments:**
- RAC Node 1: 192.168.10.1
- RAC Node 2: 192.168.10.2
- RAC Node 3: 192.168.10.3 (4-node)
- RAC Node 4: 192.168.10.4 (4-node)

**xmit_hash_policy=layer3+4** is important: it uses IP source/destination and port numbers to hash traffic across the LACP members. For Cache Fusion UDP traffic between two specific nodes, all traffic for that flow pair consistently uses the same physical NIC, avoiding out-of-order delivery that would require reassembly.

### Step 5.2: Set Kernel UDP Buffer Sizes

Oracle requires larger-than-default UDP buffers for Cache Fusion performance:

\`\`\`bash
cat >> /etc/sysctl.d/99-oracle-rac-net.conf <<'EOF'
net.core.rmem_max = 4194304
net.core.wmem_max = 4194304
net.core.rmem_default = 262144
net.core.wmem_default = 262144
net.ipv4.udp_mem = 102400 873800 16777216
EOF
sysctl -p /etc/sysctl.d/99-oracle-rac-net.conf
\`\`\`

Verify the settings were applied:
\`\`\`bash
sysctl net.core.rmem_max net.core.wmem_max net.ipv4.udp_mem
\`\`\`

### Step 5.3: Verify Bond Status

\`\`\`bash
cat /proc/net/bonding/bond0
\`\`\`

Expected output:
\`\`\`
Ethernet Channel Bonding Driver: v3.7.1 (April 27, 2011)

Bonding Mode: IEEE 802.3ad Dynamic link aggregation
Transmit Hash Policy: layer3+4 (1)
MII Status: up
MII Polling Interval (ms): 100
Up Delay (ms): 0
Down Delay (ms): 0

802.3ad info
LACP rate: fast
Min links: 0
Aggregator selection policy (ad_select): stable
System priority: 65535
System MAC address: aa:bb:cc:dd:ee:ff
Active Aggregator Info:
        Aggregator ID: 1
        Number of ports: 2
        Actor Key: 101
        Partner Key: 101
        Partner Mac Address: dd:ee:ff:00:11:22

Slave Interface: eth1
MII Status: up
Speed: 10000 Mbps
Duplex: full
Link Failure Count: 0
Permanent HW addr: aa:bb:cc:dd:ee:ff
Slave queue ID: 0
Aggregator ID: 1
Actor Churn State: none
Partner Churn State: none
Actor Churned Count: 0
Partner Churned Count: 0
details actor lacp pdu:
    system priority: 65535
    ...
LACP rate: fast

Slave Interface: eth2
MII Status: up
Speed: 10000 Mbps
Duplex: full
\`\`\`

**Check:** Both slave interfaces must show \`MII Status: up\` and \`Speed: 10000 Mbps\`. \`Number of ports: 2\` in the Aggregator info confirms both legs are active in the LACP bond — not just one.

If only one port is active (Number of ports: 1), the vPC configuration on the Nexus side is incorrect — the vpc IDs may not match between the two switches, or the \`feature vpc\` was not enabled.

### Step 5.4: Verify MTU End-to-End (ping with DF bit)

\`\`\`bash
# From node 1 to node 2 — 10 packets, DF bit set, 8972 bytes payload
# 8972 = 9000 (MTU) - 20 (IP header) - 8 (ICMP header)
ping -M do -s 8972 -c 10 192.168.10.2

# From node 1 to node 3 (if 4-node cluster)
ping -M do -s 8972 -c 10 192.168.10.3

# From node 1 to node 4 (if 4-node cluster)
ping -M do -s 8972 -c 10 192.168.10.4
\`\`\`

Expected output:
\`\`\`
PING 192.168.10.2 (192.168.10.2) 8972(9000) bytes of data.
8980 bytes from 192.168.10.2: icmp_seq=1 ttl=64 time=0.231 ms
8980 bytes from 192.168.10.2: icmp_seq=2 ttl=64 time=0.189 ms
...
--- 192.168.10.2 ping statistics ---
10 packets transmitted, 10 received, 0% packet loss
rtt min/avg/max/mdev = 0.172/0.211/0.251/0.025 ms
\`\`\`

If you see \`Message too long (mtu = XXXX)\` or \`Frag needed and DF set (mtu = XXXX)\`, the MTU is misconfigured somewhere in the path. Check in order: (1) bond0 MTU on the OS (\`ip link show bond0\`), (2) Nexus interface MTU (\`show interface Eth1/1 | include MTU\`), (3) system QoS policy MTU (\`show policy-map system type network-qos\`), (4) peer-link MTU (\`show interface Po1 | include MTU\`).

### Step 5.5: Bandwidth Test with iperf3

\`\`\`bash
# On the destination node (node 2) — run as server:
iperf3 -s -B 192.168.10.2 -D
# -D runs it as a daemon in the background

# On the source node (node 1) — TCP throughput test:
iperf3 -c 192.168.10.2 -B 192.168.10.1 -t 30 -P 4
# -P 4: 4 parallel streams (simulates multiple Cache Fusion flows)

# UDP latency test:
iperf3 -c 192.168.10.2 -B 192.168.10.1 -t 10 -u -b 1G
\`\`\`

Expected TCP results on 10GbE:
\`\`\`
[SUM]  0.00-30.00  sec  35.1 GBytes  10.1 Gbits/sec  0   sender
[SUM]  0.00-30.00  sec  35.1 GBytes  10.1 Gbits/sec       receiver
\`\`\`

Acceptable: >= 9.5 Gbits/sec aggregate throughput. If below 9 Gbits/sec, check for: LACP hash imbalance (only one NIC active in the bond), jumbo MTU not enabled (smaller packets = more overhead), or CPU saturation on the node from other workloads during the test.

Expected UDP latency (1 Gbps target):
\`\`\`
[ ID] Interval       Transfer     Bitrate         Jitter    Lost/Total Datagrams
[  5]  0.00-10.00  sec  1.19 GBytes  1.02 Gbits/sec  0.011 ms  0/850312 (0%)
\`\`\`

Jitter should be below 0.1ms on a dedicated interconnect. Lost datagrams on a 1 Gbps UDP test on a 10GbE network should be 0 or very close to 0.

---

## Phase 6: Oracle Clusterware Interconnect Verification

Run as the \`grid\` OS user or \`root\` on any RAC node.

### Step 6.1: Verify Oracle Sees the Correct Interconnect Interface

\`\`\`bash
oifcfg getif
\`\`\`

Expected output:
\`\`\`
bond0  192.168.10.0  global  cluster_interconnect
eth0   10.0.1.0      global  public
\`\`\`

The \`cluster_interconnect\` role must be assigned to the bond0 interface (or whatever the private interconnect interface is named) on the 192.168.10.x subnet. If eth0 or any public interface appears as \`cluster_interconnect\`, Oracle is using the wrong network for Cache Fusion.

### Step 6.2: Correct a Wrong Interface Registration

If the interconnect is registered to the wrong interface, update it without a cluster restart using \`oifcfg\`:

\`\`\`bash
# Show all current registrations
oifcfg getif

# Remove the incorrectly registered interface
# (replace eth0 and the IP with the actual wrong values shown)
oifcfg delif -global eth0/10.0.1.0

# Register the correct interface
oifcfg setif -global bond0/192.168.10.0:cluster_interconnect

# Verify
oifcfg getif
\`\`\`

**Note:** After changing the cluster interconnect interface registration, bounce the Oracle instances (not the Grid Infrastructure) for the change to take effect in the running cluster. GI itself picks up the change dynamically for new connections.

### Step 6.3: Check CSS Misscount and Disktimeout

\`\`\`bash
crsctl get css misscount
# Default: 30 (seconds)

crsctl get css disktimeout
# Default: 200 (seconds)

crsctl get css reboottime
# Default: 3 (seconds — OS reboot time after CSS decides to self-fence)
\`\`\`

Do NOT lower the misscount below 30 without Oracle guidance. The misscount must be higher than the longest possible interconnect disruption during normal operations (including switch failover). With a properly configured vPC setup, the bond failover time (miimon=100ms) plus LACP negotiation is well under 1 second — so the 30-second misscount provides a large safety margin.

Raising the misscount above 30 is sometimes done in virtualised environments where hypervisor CPU scheduling can cause CSS heartbeat delays. This is not recommended for physical RAC nodes.

### Step 6.4: Verify Cache Fusion is Using the Correct Interface (Oracle SQL)

\`\`\`sql
-- Run as SYS or with SELECT ANY DICTIONARY privilege
-- gv$ view queries all instances simultaneously
SELECT inst_id, name, ip_address, is_public, source
FROM gv\$cluster_interconnects
ORDER BY inst_id, name;
\`\`\`

Expected output:
\`\`\`
INST_ID  NAME   IP_ADDRESS      IS_PUBLIC  SOURCE
-------  -----  --------------  ---------  ------
1        bond0  192.168.10.1    NO         OCR
2        bond0  192.168.10.2    NO         OCR
\`\`\`

\`IS_PUBLIC = NO\` confirms Oracle is using the private interconnect, not the public network. \`SOURCE = OCR\` means the interface was configured via \`oifcfg setif\` (stored in OCR). \`SOURCE = GPnP\` means it was auto-discovered — verify the auto-discovery picked the right interface.

If \`IS_PUBLIC = YES\` for any instance, that instance is running Cache Fusion over the public network. This is a serious configuration error that will cause severe performance degradation and must be corrected immediately.

### Step 6.5: Check for Recent Node Evictions in Clusterware Alert Log

\`\`\`bash
# Get the Grid Infrastructure home directory
GRID_HOME=\$(crsctl query has releaseversion 2>/dev/null | awk '{print \$NF}' | sed 's|/bin.*||' || echo "/u01/app/19.0.0/grid")
echo "Grid home: \${GRID_HOME}"

# Check alert log for eviction-related messages in the last 4 hours
grep -iE "evict|reboot|splitbrain|css.*fatal|network.*error|clssnm" \
  \${GRID_HOME}/log/\$(hostname -s)/alert\$(hostname -s).log | \
  awk -v cutoff="\$(date -d '4 hours ago' '+%Y-%m-%d %H:%M:%S')" '\$0 >= cutoff' | \
  tail -50
\`\`\`

Keywords to investigate:
- \`EVICTED\` or \`eviction\` — a node was kicked from the cluster
- \`reboot\` — CSS triggered a node reboot (self-fencing)
- \`splitbrain\` — cluster detected split-brain condition
- \`css.*fatal\` — critical CSS failure
- \`clssnm.*misscount\` — approaching or exceeded misscount threshold
- \`network.*error\` or \`NIC.*error\` — underlying network problems

---

## Phase 7: Verification and Monitoring Script

Save the following script as \`/u01/app/oracle/scripts/nexus_verify/nexus_rac_verify.sh\` and make it executable.

\`\`\`bash
#!/bin/bash
# nexus_rac_verify.sh — Oracle RAC Nexus Interconnect Health Check
# Usage: nexus_rac_verify.sh <ORACLE_SID> <remote_interconnect_IP> [bond_interface]
# Example: nexus_rac_verify.sh PRODDB 192.168.10.2 bond0
#
# Exit code = number of issues found (0 = healthy)

set -euo pipefail

ORACLE_SID="\${1:-}"
REMOTE_IP="\${2:-}"
BOND_IF="\${3:-bond0}"

if [[ -z "\${ORACLE_SID}" ]] || [[ -z "\${REMOTE_IP}" ]]; then
  echo "Usage: \$0 <ORACLE_SID> <remote_interconnect_IP> [bond_interface]"
  exit 1
fi

SCRIPT_DIR="/u01/app/oracle/scripts/nexus_verify"
LOG_DIR="\${SCRIPT_DIR}/logs"
LOG_FILE="\${LOG_DIR}/nexus_verify_\$(date +%Y%m%d_%H%M%S).log"
ALERT_EMAIL="dba-alerts@example.com"
HOSTNAME="\$(hostname -s)"
TIMESTAMP="\$(date '+%Y-%m-%d %H:%M:%S')"
ISSUES=0
ISSUE_DETAILS=""

mkdir -p "\${LOG_DIR}"

log() {
  echo "[\${TIMESTAMP}] \$*" | tee -a "\${LOG_FILE}"
}

warn() {
  ISSUES=\$((ISSUES + 1))
  ISSUE_DETAILS="\${ISSUE_DETAILS}\n[WARN] \$*"
  log "WARN: \$*"
}

log "=== Nexus RAC Interconnect Health Check ==="
log "Node: \${HOSTNAME}  SID: \${ORACLE_SID}  Remote: \${REMOTE_IP}  Bond: \${BOND_IF}"

# --- Check 1: Bond slave status ---
log "--- Check 1: Bond interface \${BOND_IF} slave status"
BOND_FILE="/proc/net/bonding/\${BOND_IF}"
if [[ ! -f "\${BOND_FILE}" ]]; then
  warn "Bond interface \${BOND_IF} not found — /proc/net/bonding/\${BOND_IF} missing"
else
  DOWN_SLAVES=\$(grep -A2 "Slave Interface" "\${BOND_FILE}" | grep "MII Status: down" | wc -l)
  if [[ "\${DOWN_SLAVES}" -gt 0 ]]; then
    warn "Bond \${BOND_IF}: \${DOWN_SLAVES} slave(s) are DOWN — check NIC and switch port"
  else
    log "Bond \${BOND_IF}: all slaves UP"
  fi
  ACTIVE_COUNT=\$(grep "Number of ports:" "\${BOND_FILE}" | awk '{print \$NF}')
  if [[ "\${ACTIVE_COUNT}" -lt 2 ]]; then
    warn "Bond \${BOND_IF}: only \${ACTIVE_COUNT} active LACP port(s) — expected 2. vPC config may be incorrect"
  else
    log "Bond \${BOND_IF}: \${ACTIVE_COUNT} LACP ports active (expected 2)"
  fi
fi

# --- Check 2: MTU on bond interface ---
log "--- Check 2: MTU on \${BOND_IF}"
CURRENT_MTU=\$(ip link show "\${BOND_IF}" 2>/dev/null | grep -oP 'mtu \K[0-9]+' || echo "0")
if [[ "\${CURRENT_MTU}" -ne 9000 ]]; then
  warn "Bond \${BOND_IF} MTU is \${CURRENT_MTU} — expected 9000. Run: ip link set \${BOND_IF} mtu 9000"
else
  log "Bond \${BOND_IF} MTU: \${CURRENT_MTU} (correct)"
fi

# --- Check 3: End-to-end MTU ping ---
log "--- Check 3: End-to-end jumbo MTU ping to \${REMOTE_IP}"
# 8972 = 9000 - 20 (IP) - 8 (ICMP)
if ping -M do -s 8972 -c 4 -W 2 "\${REMOTE_IP}" > /dev/null 2>&1; then
  log "Jumbo MTU ping to \${REMOTE_IP}: OK (9000-byte path is clear)"
else
  warn "Jumbo MTU ping to \${REMOTE_IP} FAILED — MTU mismatch in path. Check Nexus mtu 9216 and system QoS policy"
fi

# --- Check 4: Cache Fusion interconnect interface via SQL ---
log "--- Check 4: Oracle Cache Fusion interconnect interface"
if command -v sqlplus > /dev/null 2>&1; then
  ORACLE_HOME=\$(ls -d /u01/app/oracle/product/*/dbhome_1 2>/dev/null | tail -1)
  export ORACLE_HOME ORACLE_SID
  export PATH="\${ORACLE_HOME}/bin:\${PATH}"
  export LD_LIBRARY_PATH="\${ORACLE_HOME}/lib:\${LD_LIBRARY_PATH:-}"

  PUBLIC_INTERCONNECT=\$(sqlplus -s "/ as sysdba" <<'SQLEOF'
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF VERIFY OFF TRIMSPOOL ON
SELECT COUNT(*) FROM gv\$cluster_interconnects WHERE is_public = 'YES';
EXIT;
SQLEOF
)
  PUBLIC_INTERCONNECT=\$(echo "\${PUBLIC_INTERCONNECT}" | tr -d ' ')
  if [[ "\${PUBLIC_INTERCONNECT}" -gt 0 ]]; then
    warn "Oracle Cache Fusion: \${PUBLIC_INTERCONNECT} instance(s) using PUBLIC network for interconnect — check oifcfg getif"
  else
    log "Oracle Cache Fusion: all instances using private interconnect (correct)"
  fi
else
  log "sqlplus not found in PATH — skipping Cache Fusion interface check"
fi

# --- Check 5: Clusterware alert log — eviction keywords (last 4 hours) ---
log "--- Check 5: Clusterware alert log eviction scan"
GRID_HOME=\$(ls -d /u01/app/*/grid 2>/dev/null | tail -1 || echo "")
if [[ -n "\${GRID_HOME}" ]]; then
  ALERT_LOG="\${GRID_HOME}/log/\${HOSTNAME}/alert\${HOSTNAME}.log"
  if [[ -f "\${ALERT_LOG}" ]]; then
    CUTOFF=\$(date -d '4 hours ago' '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date -v-4H '+%Y-%m-%d %H:%M:%S')
    EVICT_COUNT=\$(grep -iE "evict|reboot|splitbrain|css.*fatal" "\${ALERT_LOG}" 2>/dev/null | \
      awk -v c="\${CUTOFF}" '\$0 >= c' | wc -l || echo "0")
    if [[ "\${EVICT_COUNT}" -gt 0 ]]; then
      warn "Clusterware alert log: \${EVICT_COUNT} eviction/reboot/splitbrain message(s) in last 4 hours"
    else
      log "Clusterware alert log: no eviction events in last 4 hours"
    fi
  else
    log "Alert log not found at \${ALERT_LOG} — skipping"
  fi
else
  log "Grid home not found — skipping alert log check"
fi

# --- Check 6: Optional iperf3 bandwidth check ---
log "--- Check 6: iperf3 bandwidth check (optional)"
if command -v iperf3 > /dev/null 2>&1; then
  LOCAL_IP=\$(ip addr show "\${BOND_IF}" | grep -oP 'inet \K[\d.]+' | head -1)
  if [[ -n "\${LOCAL_IP}" ]]; then
    # Quick 10-second TCP test with 2 streams
    THROUGHPUT=\$(iperf3 -c "\${REMOTE_IP}" -B "\${LOCAL_IP}" -t 10 -P 2 -f m 2>/dev/null | \
      grep -E "SUM.*receiver" | awk '{print \$(NF-1)}' || echo "0")
    if [[ -n "\${THROUGHPUT}" ]] && [[ "\${THROUGHPUT%.*}" -lt 8000 ]]; then
      warn "iperf3 throughput to \${REMOTE_IP}: \${THROUGHPUT} Mbps — below 8000 Mbps threshold. Check bond LACP balance and MTU"
    else
      log "iperf3 throughput to \${REMOTE_IP}: \${THROUGHPUT} Mbps (acceptable)"
    fi
  fi
else
  log "iperf3 not installed — skipping bandwidth check"
fi

# --- Final Report ---
log "=== Health Check Complete: \${ISSUES} issue(s) found ==="

if [[ "\${ISSUES}" -gt 0 ]]; then
  log "Issues:"
  echo -e "\${ISSUE_DETAILS}" | tee -a "\${LOG_FILE}"

  # Send email alert if mailx is available
  if command -v mailx > /dev/null 2>&1; then
    SUBJECT="[ALERT] RAC Nexus Interconnect: \${ISSUES} issue(s) on \${HOSTNAME} [\${ORACLE_SID}]"
    {
      echo "RAC Nexus Interconnect Health Check Report"
      echo "Node: \${HOSTNAME}  SID: \${ORACLE_SID}"
      echo "Timestamp: \${TIMESTAMP}"
      echo "Issues Found: \${ISSUES}"
      echo ""
      echo -e "\${ISSUE_DETAILS}"
      echo ""
      echo "Full log: \${LOG_FILE}"
    } | mailx -s "\${SUBJECT}" "\${ALERT_EMAIL}"
    log "Alert email sent to \${ALERT_EMAIL}"
  fi
fi

# Rotate logs older than 30 days
find "\${LOG_DIR}" -name "nexus_verify_*.log" -mtime +30 -delete 2>/dev/null || true

exit "\${ISSUES}"
\`\`\`

**Make the script executable and create the directory:**
\`\`\`bash
mkdir -p /u01/app/oracle/scripts/nexus_verify/logs
chmod 750 /u01/app/oracle/scripts/nexus_verify/nexus_rac_verify.sh
chown oracle:oinstall /u01/app/oracle/scripts/nexus_verify/nexus_rac_verify.sh
\`\`\`

**Add to oracle user's crontab (runs every 30 minutes):**
\`\`\`bash
crontab -e -u oracle
\`\`\`

Add this line:
\`\`\`
*/30  *  *  *  *  /u01/app/oracle/scripts/nexus_verify/nexus_rac_verify.sh PRODDB 192.168.10.2 bond0 >> /u01/app/oracle/scripts/nexus_verify/logs/cron_nexus.log 2>&1
\`\`\`

**Test the script manually first:**
\`\`\`bash
sudo -u oracle /u01/app/oracle/scripts/nexus_verify/nexus_rac_verify.sh PRODDB 192.168.10.2 bond0
echo "Exit code: \$?"
# 0 = all checks passed
# >0 = number of issues found
\`\`\`

---

## Quick Reference: NX-OS Verification Commands

\`\`\`
! vPC status and member port health
show vpc
show vpc brief
show vpc peer-keepalive

! LACP bond status from switch perspective
show port-channel summary
show lacp neighbor interface port-channel101

! MTU verification
show interface Eth1/1 | include MTU
show policy-map system type network-qos

! Spanning Tree — root, port states, BPDU Guard
show spanning-tree vlan 100
show spanning-tree vlan 100 detail
show spanning-tree summary
show spanning-tree bpduguard

! MAC address table on private VLAN (should show all node MACs)
show mac address-table vlan 100

! QoS queue and MTU
show queuing interface Eth1/1

! IGMP snooping status
show ip igmp snooping vlan 100

! LLDP neighbours (verify cable connections)
show lldp neighbors
\`\`\`

## Quick Reference: Linux Commands

\`\`\`bash
# Bond member and LACP status
cat /proc/net/bonding/bond0

# Interface MTU and state
ip link show bond0

# End-to-end MTU test (DF bit, 8972 bytes)
ping -M do -s 8972 -c 10 192.168.10.2

# Throughput test (4 parallel streams, 30 seconds)
iperf3 -c 192.168.10.2 -B 192.168.10.1 -t 30 -P 4

# UDP latency test (1 Gbps target)
iperf3 -c 192.168.10.2 -B 192.168.10.1 -t 10 -u -b 1G

# Check kernel UDP buffer sizes
sysctl net.core.rmem_max net.core.wmem_max
\`\`\`

## Quick Reference: Oracle Verification Commands

\`\`\`bash
# Verify registered interconnect interfaces
oifcfg getif

# Set correct interconnect interface (if needed)
oifcfg setif -global bond0/192.168.10.0:cluster_interconnect

# CSS eviction timer
crsctl get css misscount

# Check voting disk availability
crsctl query css votedisk
\`\`\`

\`\`\`sql
-- Runtime interconnect interface in use by all instances
SELECT inst_id, name, ip_address, is_public, source
FROM gv\$cluster_interconnects
ORDER BY inst_id;

-- Cache Fusion statistics (per instance)
SELECT inst_id, name, value
FROM gv\$sysstat
WHERE name IN (
  'gc cr blocks received',
  'gc current blocks received',
  'gc cr block receive time',
  'gc current block receive time'
)
ORDER BY inst_id, name;
\`\`\`
`,
};

async function main() {
  console.log('Inserting Cisco Nexus RAC Private Interconnect runbook...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: { ...post },
  });
  console.log('Inserted: "' + post.title + '"');
}

main().catch(console.error);
