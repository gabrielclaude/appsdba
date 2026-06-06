import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Cisco Nexus Switch Configuration for Oracle RAC Private Interconnect',
  slug: 'cisco-nexus-rac-private-interconnect-configuration',
  excerpt:
    'A deep-dive into configuring Cisco Nexus switches for Oracle RAC private interconnect — covering vPC topology for active-active dual-switch redundancy, end-to-end MTU 9000/9216 jumbo frame configuration, RSTP PortFast to eliminate 30-second STP convergence delays, and IGMP snooping isolation to protect Oracle Clusterware multicast heartbeats.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-05'),
  youtubeUrl: null,
  content: `The Oracle RAC private interconnect is the highest-stakes network in the enterprise data centre. Every block transfer via Cache Fusion, every cluster heartbeat from CSS, and every GCS lock-coordination message travels over it. Unlike the public network — where occasional retransmits are absorbed by TCP and go unnoticed — the private interconnect is loss-intolerant and latency-sensitive. A single dropped heartbeat packet can contribute to a node eviction. A 50-millisecond MTU mismatch-induced fragmentation storm can saturate the interconnect and bring down all nodes simultaneously.

The Cisco Nexus platform has become the de facto standard for this role in Oracle reference architectures. Its virtual Port Channel (vPC) technology solves the fundamental dual-switch redundancy problem: traditional LACP across two switches forces one port into STP blocking state, halving available bandwidth and creating a failover dependency. vPC makes both switches appear as a single LACP peer, so both uplinks are active simultaneously. Combined with deep packet buffers, non-blocking Clos fabric, and a rich NX-OS feature set, Nexus switches give the RAC interconnect the reliability and performance characteristics Oracle requires.

This post covers the complete Cisco Nexus configuration for a 2-node and 4-node RAC cluster private interconnect — from physical topology and VLAN design through MTU configuration, STP, QoS, and IGMP isolation. It is written from the perspective of an Oracle DBA who needs to understand, validate, and troubleshoot the network layer, not just hand it off to a network team. You should be able to sit down with a Nexus switch, work through these sections in order, and produce a correctly configured private interconnect that passes Oracle's own validation tests.

Every decision in this guide is made in service of a single goal: ensuring that Cache Fusion block transfers and CSS heartbeats are delivered with sub-millisecond latency and zero loss, even during a switch failover or NIC failure.

---

## Physical Topology: Dual-Switch Redundancy

The single most important physical decision for an Oracle RAC private interconnect is: use two physically separate switches. Never use a single switch. A single switch is a single point of failure that will take down every RAC node simultaneously when it fails — a far worse outcome than the individual node failure that RAC is designed to tolerate.

The two-switch design requires that each RAC node has two physical NICs dedicated to the private interconnect — one connected to each switch. The OS bonds these two NICs into a single logical interface using LACP (IEEE 802.3ad, bond mode 4). Under normal operation, both links are active and traffic is load-balanced across them by the bond's transmit hash policy (typically layer3+4 for Oracle interconnect traffic, which ensures that Cache Fusion flows between the same node pair always use the same physical link, avoiding out-of-order delivery). If one switch fails or one NIC fails, the bond fails over to the surviving link within the miimon interval (typically 100ms) — well inside the CSS misscount window.

The vPC technology on the Nexus side is what makes this dual-switch LACP bond work. Without vPC, the two switches would each have their own independent STP domain, and one leg of the LACP bond would be forced into STP blocking state to prevent Layer 2 loops. vPC creates a shared STP domain between the two switches and presents a single LACP peer identity to the server, so both uplinks negotiate as active LACP members simultaneously.

\`\`\`
Physical Topology: 4-Node Oracle RAC Private Interconnect

  RAC Node 1            RAC Node 2            RAC Node 3            RAC Node 4
  +-----------+         +-----------+         +-----------+         +-----------+
  | eth1 eth2 |         | eth1 eth2 |         | eth1 eth2 |         | eth1 eth2 |
  +--+----+---+         +--+----+---+         +--+----+---+         +--+----+---+
     |    |                |    |                |    |                |    |
     |    +----------------+    +----------------+    +----------------+    |
     |         (to Nexus-B)              (to Nexus-B)                       |
     |                                                                       |
     +---------+---------+---------+         +---------+---------+----------+
               |         |         |         |         |         |
          Eth1/1    Eth1/2    Eth1/3     Eth1/1    Eth1/2    Eth1/3
  +------------------------+             +------------------------+
  |   Cisco Nexus-A        |             |   Cisco Nexus-B        |
  |   (Primary)            |=============|   (Secondary)          |
  +------------------------+  vPC        +------------------------+
          Peer-Link             Peer-Keepalive (mgmt network)
\`\`\`

In this topology each RAC node has eth1 going to Nexus-A and eth2 going to Nexus-B. The OS bonds them into bond0 (or the platform equivalent). Traffic from RAC Node 1 to RAC Node 2 may traverse either switch depending on the hash outcome — and both paths are always active. The vPC peer-link (a dedicated trunk port-channel between the two Nexus switches, typically 2×40GE or 2×100GE) carries synchronisation traffic between the switches and serves as a transit path for traffic destined to orphan ports (ports connected to only one switch).

The peer-keepalive is a separate L3 connection, typically through the management network, used to detect whether the peer switch is alive when the peer-link fails. This distinction is critical: if the peer-link fails but both switches are alive, the vPC secondary (Nexus-B) must not bring up orphan ports, because the primary (Nexus-A) is still forwarding and bringing up both would create a split-brain loop. The peer-keepalive allows the secondary to verify whether the primary is truly gone before taking over.

---

## vPC: Virtual Port Channel Architecture

Standard LACP has a fundamental limitation when applied to dual-switch topologies: LACP requires all member ports of a port-channel to share the same MAC address and the same LACP system ID. Two different physical switches have two different LACP system IDs. A server connecting to both switches with LACP sees two separate LACP peers and can only form one active port-channel — the other link is blocked by STP. This is the problem vPC solves.

vPC creates a vPC domain — a shared logical entity between two Nexus switches. Within the domain, both switches present the same vPC system MAC and the same LACP system ID to downstream devices. From the server's perspective, it is talking to a single LACP peer, and all member ports are active. Both uplinks carry traffic simultaneously. The vPC configuration requires a domain ID (a number from 1–1000, unique in the network), a peer-link (the inter-switch trunk), and a peer-keepalive (the management-plane liveness check).

\`\`\`
vPC Control Plane

  Nexus-A                          Nexus-B
  +------------------+             +------------------+
  |  vPC Domain 10   |             |  vPC Domain 10   |
  |                  |             |                  |
  |  Role: Primary   |             |  Role: Secondary |
  |  Priority: 100   |             |  Priority: 200   |
  |                  |             |                  |
  |  [Peer-Link]     +====Po1======+  [Peer-Link]     |
  |  2x40GE trunk    | (Port-Ch 1) |  2x40GE trunk    |
  |                  |             |                  |
  |  [Keepalive]     +--mgmt0------+  [Keepalive]     |
  |  via mgmt VRF    |    UDP      |  via mgmt VRF    |
  +------------------+             +------------------+
          |                                  |
          +------ RAC Node bond0 (LACP) -----+
                  (both legs active)
\`\`\`

The vPC role (primary/secondary) is determined by the role priority — lower number wins primary. The primary switch makes spanning tree decisions and originates BPDUs. In practice, for a private interconnect VLAN that is a closed L2 domain with no uplinks to the rest of the network, the primary/secondary distinction has limited operational impact, but it matters during peer-link failure scenarios.

The \`peer-gateway\` feature (enabled in the vPC domain config) allows the vPC secondary to forward traffic destined to the primary's MAC address — important when one leg of a server bond sends ARP traffic or control-plane frames addressed to the wrong switch MAC. The \`auto-recovery\` feature allows the vPC secondary to take over as primary if it cannot reach the primary via the peer-keepalive for a configurable timeout — protecting against scenarios where the primary switch has completely failed and the secondary is left in a suspended state waiting for guidance that will never come.

The \`ip arp synchronize\` feature in the vPC domain keeps ARP tables consistent between both switches. This is particularly important for the RAC interconnect because Cache Fusion communication is UDP-based and relies on ARP resolution to work. If one switch has a stale or missing ARP entry, Cache Fusion traffic may be silently dropped.

---

## VLAN Design for RAC Networks

Oracle RAC clusters have several distinct network roles, and each should be assigned a dedicated VLAN. Mixing RAC traffic types on the same VLAN increases risk and complicates troubleshooting. The key principle for the private interconnect VLAN is isolation: it must be a closed Layer 2 domain with no routing, no default gateway, and no connectivity to the rest of the network.

\`\`\`
VLAN Assignment for Oracle RAC

  +--------+---------------------------+------------------+-------------------+
  | VLAN   | Purpose                   | Subnet           | Notes             |
  +--------+---------------------------+------------------+-------------------+
  | 100    | RAC Private Interconnect  | 192.168.10.0/24  | Isolated, no GW   |
  | 200    | Public Network / VIP      | 10.0.1.0/24      | Routed to clients |
  | 300    | SCAN Listener             | 10.0.2.0/24      | DNS: 3 SCAN IPs   |
  | 400    | iSCSI / NFS Storage       | 192.168.20.0/24  | Jumbo MTU 9000    |
  | 999    | Management (Nexus OOB)    | 10.0.99.0/24     | OOBM only         |
  +--------+---------------------------+------------------+-------------------+
\`\`\`

VLAN 100 is the most sensitive. Configure an SVI (Layer 3 interface) for it if you need a local IP for management purposes — specifically, as an IGMP querier — but do not assign a default gateway and do not route it. The no \`ip redirects\` and no \`ip proxy-arp\` settings on the SVI ensure the switch does not respond to network-layer requests in ways that could confuse the OS stack on the RAC nodes.

VLAN 200 (public network) and VLAN 300 (SCAN) are routed networks. The SCAN network carries SCAN listener traffic — Oracle recommends three SCAN IP addresses, all in DNS, with single-client access name (SCAN) resolving to all three via round-robin DNS. SCAN listeners are managed by Oracle Clusterware and can run on any node.

VLAN 400 (storage) should also carry jumbo frames if you are using iSCSI or NFS. The MTU requirements are identical to the private interconnect: 9216 at the Nexus interface level, 9000 at the OS level.

---

## Jumbo Frames: MTU End-to-End

Oracle's 8 KB default block size creates an immediate Ethernet fragmentation problem. A single 8 KB block, when wrapped in a Cache Fusion UDP message with IP and Ethernet headers, produces a packet that is far larger than the standard Ethernet MTU of 1500 bytes. Without jumbo frames, that single block transfer requires approximately 6 standard Ethernet frames, each with its own header overhead and — more critically — each adding switch processing latency and increasing the probability that one fragment arrives out of order or is dropped.

Oracle strongly recommends and documents a 9000-byte OS-level MTU for the private interconnect. The path from sending NIC to receiving NIC must support this MTU at every hop — and the Cisco Nexus platform adds one level of complexity here: NX-OS interface MTU must be set to 9216, not 9000, because the 216 bytes of difference account for Ethernet frame overhead (14-byte Ethernet header, 4-byte 802.1Q tag, 4-byte FCS) plus internal NX-OS processing overhead. The OS sees 9000 bytes of payload; the switch needs 9216 at the interface level to deliver it without fragmentation.

\`\`\`
MTU Chain: Every hop must be 9000+

  RAC Node NIC          OS Bond           Nexus Port        Peer-Link
  +-----------+        +---------+        +----------+      +----------+
  | eth1 eth2 |        | bond0   |        | Eth1/1   |      | Po1      |
  | mtu 9000  |<------>| mtu 9000|<------>| mtu 9216 |<---->| mtu 9216 |
  +-----------+        +---------+        +----------+      +----------+

  Verification command (Linux):
  ping -M do -s 8972 192.168.10.2
       ^^^^^ ^^^^^^
       |     8972 = 9000 - 20 (IP) - 8 (ICMP) = max ICMP payload for 9000 MTU path
       Don't Fragment bit

  Expected: 4 packets transmitted, 4 received, 0% packet loss
  Failure:  "Message too long" or "Frag needed and DF set" = MTU mismatch
\`\`\`

The most common MTU misconfiguration is a partial deployment: the Nexus interface is set to 9216 but the NX-OS system-wide QoS policy is not updated. On NX-OS 7.x and several 9.x releases, interface-level \`mtu 9216\` alone does not enable jumbo frames — the switch still honours the system network-QoS policy MTU, which defaults to 1500. You must apply a system QoS policy that sets \`mtu 9216\` in the default class to make jumbo frames work end-to-end. The runbook companion to this post contains the exact NX-OS policy-map commands.

The second most common misconfiguration is a one-sided deployment: the interface to the RAC node is configured for 9216, but the vPC peer-link port-channel is left at 1500. Any Cache Fusion traffic that arrives on Nexus-A and needs to be forwarded to a node connected to Nexus-B will traverse the peer-link — and will be fragmented or dropped. The peer-link must also be configured for 9216.

For storage VLANs carrying iSCSI or NFS traffic, the same rules apply. iSCSI in particular benefits enormously from jumbo frames: an iSCSI write of a 32 KB Oracle block produces 22 standard Ethernet frames at 1500 MTU vs. 4 frames at 9000 MTU. The CPU overhead of the TCP segmentation and reassembly is measurable on the database server and the storage array controller.

---

## Spanning Tree Configuration

Spanning Tree Protocol is a critical correctness protocol on the Nexus switches — it prevents Layer 2 loops that would otherwise broadcast-storm the private interconnect into silence. But its default convergence timers are fundamentally incompatible with Oracle Clusterware's expectations.

Standard STP (802.1D) takes 15 seconds in Blocking state, 15 seconds in Listening state, and 15 seconds in Learning state before a port reaches Forwarding — 45 seconds total. Rapid PVST+ (802.1w, the NX-OS default) dramatically reduces this, but still requires a proposal-agreement handshake that takes several seconds on a port that has just come up or had a topology change event.

Oracle CSS has a misscount of 30 seconds by default. If a RAC node's interconnect port goes through STP convergence during a link bounce or switch failover, it will be offline for the CSS heartbeat for the duration of the convergence — and if that duration exceeds 30 seconds, the node is evicted. Even with RSTP, topology change notifications (TCNs) can flush MAC tables and cause temporary flooding that disrupts Cache Fusion during failover events.

\`\`\`
Standard STP (without PortFast)        With PortFast Edge
------------------------------------   -------------------
BLOCKING   (15s default)               DISABLED
     |                                      |
LISTENING  (15s)                       FORWARDING  <-- immediate
     |
LEARNING   (15s)
     |
FORWARDING
------------------------------------
Total: up to 50s  <-- RAC node evicted
       CSS misscount: 30s
\`\`\`

The solution on Cisco Nexus is PortFast Edge (\`spanning-tree port type edge\` in NX-OS). PortFast places the port directly into Forwarding state when the link comes up, bypassing all STP convergence stages. It is appropriate on host-facing ports where you know there will never be a switch or hub connected — only a server NIC or bond. PortFast Edge also suppresses TCN generation when the port state changes, which prevents the MAC table flush that would otherwise disrupt all forwarding on the VLAN during a link bounce.

BPDU Guard should be enabled on all PortFast Edge ports. If a BPDU (bridge protocol data unit) is received on a PortFast port, it means someone has connected a switch or hub to that port — which could create a loop. BPDU Guard immediately places the port in \`err-disabled\` state, shutting it down. This is the correct behaviour: a mis-cabled switch on the private interconnect is more dangerous than a port being administratively down.

The peer-link between the two Nexus switches must never have PortFast configured. Use \`spanning-tree port type network\` on the peer-link to ensure it participates correctly in STP topology decisions and does not generate or suppress BPDUs inappropriately.

---

## QoS: Prioritising Cache Fusion Traffic

Oracle Cache Fusion uses UDP for block transfer messages. UDP has no built-in congestion control — if the private interconnect switch queue fills up, UDP packets are tail-dropped without any TCP-style backoff signalling to the sender. On a dedicated private interconnect switch this is rarely a problem, because the only traffic present is Cache Fusion and cluster heartbeats. But in environments where the private interconnect VLAN is shared with backup traffic, management traffic, or cluster-interconnect-adjacent workloads, QoS is essential.

The recommended approach is a two-queue model. Mark Cache Fusion traffic with DSCP Expedited Forwarding (DSCP 46, or EF) at the Oracle level — Oracle supports this via the \`CLUSTER_INTERCONNECTS\` parameter and OS-level DSCP marking. On the Nexus switch, match DSCP EF in a QoS class map and assign it to the strict-priority queue. All remaining traffic falls into the default best-effort queue. The strict-priority queue is served before the best-effort queue whenever both are congested, ensuring Cache Fusion transfers are never delayed by backup jobs filling the switch queue.

On a dedicated private interconnect switch — where all ports carry only RAC interconnect traffic — QoS is less operationally critical for preventing starvation, but still recommended for monitoring purposes. Flow analysis tools like Nexus flow exporter (NetFlow/IPFIX) can use the DSCP markings to identify and report on Cache Fusion traffic volumes, latencies, and trends. This data is invaluable when debugging intermittent cluster performance issues.

For the QoS configuration to take effect, the system-wide network-QoS policy must be updated to accommodate the marked traffic classes. The same policy that enables jumbo MTU 9216 globally is the right place to add the Cache Fusion priority class.

---

## IGMP and Multicast Isolation

Oracle Clusterware uses IP multicast for several critical cluster communication functions. Oracle GNS (Grid Naming Service) uses multicast for cluster member discovery. ONS (Oracle Notification Service) uses multicast for Fast Application Notification (FAN) events. The multicast range Oracle typically uses for cluster communication is 230.0.1.x — verify the specific addresses on your cluster with \`netstat -gn\` on any RAC node.

The problem with IGMP snooping on a Nexus switch configured for the RAC private interconnect is that IGMP snooping requires an IGMP querier to be present on the VLAN. The IGMP querier is responsible for sending periodic IGMP query messages that cause group members to refresh their membership registrations. Without a querier, IGMP snooping ages out the multicast group memberships after a timeout (typically 260 seconds) and stops forwarding multicast to the registered ports — replacing it with either flooding (if the switch floods for unknown multicast) or silent dropping (if the switch drops it).

Silent dropping of IGMP-snooped multicast on VLAN 100 means Oracle Clusterware heartbeat and GNS traffic stops being forwarded to some or all nodes. The cluster may appear healthy from a unicast Cache Fusion perspective while slowly degrading from a cluster-membership perspective. This class of failure is notoriously difficult to diagnose because the symptoms (intermittent node connectivity warnings in the alert log, GNS resolution failures, ONS FAN event delivery delays) do not obviously point to IGMP snooping as the cause.

The simplest and most reliable solution for the private interconnect VLAN is to disable IGMP snooping entirely on VLAN 100:

\`\`\`
no ip igmp snooping vlan 100
\`\`\`

With IGMP snooping disabled, all multicast traffic on VLAN 100 is flooded to all ports in the VLAN — exactly like broadcast traffic. For a private interconnect VLAN with 2–8 nodes and Oracle-specific multicast traffic at very low rates, flooding is completely acceptable and avoids the entire IGMP querier dependency.

The alternative — configuring the Nexus SVI as the IGMP querier — is also valid but introduces a dependency: if the SVI is not configured (which we recommend for isolation reasons, since VLAN 100 should have no IP address), there is no querier. If you do configure an IP on the VLAN 100 SVI for IGMP querier purposes, use a dedicated management address, document it clearly, and ensure the \`ip igmp snooping querier\` command is present on both switches.

---

## Summary and Deployment Checklist

The Cisco Nexus configuration for an Oracle RAC private interconnect is not complex, but it requires precision. Every element described in this post serves a specific RAC requirement: vPC eliminates the dual-switch STP blocking problem and provides active-active bandwidth; jumbo MTU 9216 end-to-end eliminates Cache Fusion fragmentation; PortFast Edge eliminates the 30-second STP convergence window that would trigger node evictions; QoS DSCP marking protects Cache Fusion from traffic starvation; and IGMP snooping must be disabled to prevent silent dropping of Clusterware multicast.

The most common deployment failures are partial configurations — jumbo MTU set on host-facing ports but not the peer-link, PortFast Edge configured but BPDU Guard omitted, or IGMP snooping left enabled with no querier configured. Each of these partial configurations will work for days or weeks before a specific event (a link bounce, a switch failover, an IGMP timeout) exposes the gap, and the failure will appear as a mysterious cluster instability rather than a network misconfiguration. The checklist below is designed to catch these gaps before go-live.

The companion runbook to this post provides the complete NX-OS command blocks for each configuration step, plus OS-level bond configuration, Oracle verification commands, and a monitoring script that checks the entire chain continuously.

\`\`\`
Pre-Go-Live Checklist

  +---+------------------------------------------------+--------+
  | # | Check                                          | Status |
  +---+------------------------------------------------+--------+
  | 1 | Two physically separate Nexus switches         | [ ]    |
  | 2 | vPC domain configured and peer-link UP         | [ ]    |
  | 3 | vPC peer-keepalive reachable                   | [ ]    |
  | 4 | MTU 9216 on all RAC-facing ports               | [ ]    |
  | 5 | Jumbo QoS policy applied system-wide           | [ ]    |
  | 6 | RSTP enabled globally (spanning-tree mode)     | [ ]    |
  | 7 | PortFast edge on all host-facing ports         | [ ]    |
  | 8 | BPDU Guard on all host-facing ports            | [ ]    |
  | 9 | IGMP snooping disabled on VLAN 100             | [ ]    |
  |10 | ping -M do -s 8972 passes between all nodes    | [ ]    |
  |11 | iperf3 >= 9.5 Gbps between node pairs          | [ ]    |
  |12 | oifcfg getif shows correct interconnect iface  | [ ]    |
  +---+------------------------------------------------+--------+
\`\`\`
`,
};

async function main() {
  console.log('Inserting Cisco Nexus RAC Private Interconnect concept post...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: { ...post },
  });
  console.log('Inserted: "' + post.title + '"');
}

main().catch(console.error);
