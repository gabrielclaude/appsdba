import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle RAC Cluster Interconnect: Switch Hardware Selection and Network Architecture',
  slug: 'oracle-rac-cluster-interconnect-switch-hardware',
  excerpt:
    'Oracle RAC stability depends not just on database tuning but on the physical network beneath it — the private cluster interconnect carries Cache Fusion block transfers between node RAM in real time, and a single misconfigured switch port can trigger node evictions. This guide covers the two-network RAC architecture, MTU and STP configuration requirements, and the three enterprise switch vendors — Cisco Nexus, NVIDIA Spectrum, and Arista — with guidance on when to use each.',
  category: 'oracle-database' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-05'),
  youtubeUrl: null,
  content: `## Introduction

Oracle Real Application Clusters is often described as a database technology, but it is more accurately described as a distributed system that uses a database as its workload. The database files sit on shared storage accessible by every node, and each node runs an independent Oracle instance — its own System Global Area, its own background processes, its own connection pool. What binds these independent instances together into a coherent cluster is the network. Not the application network, not the storage network, but a dedicated private interconnect that must be fast, reliable, and exclusively controlled by the cluster.

Cache Fusion is the mechanism at the heart of RAC performance. When one Oracle instance on node A needs a database block that was last modified by node B, it does not fetch that block from disk. Instead, the current version of the block is transferred directly from node B's buffer cache to node A's buffer cache over the private interconnect in real time. The block moves through RAM, never touching disk, and arrives at its destination with microsecond latency on a well-configured network. This design allows RAC to achieve horizontal scalability without the enormous I/O amplification that would result from constantly writing and re-reading shared blocks from storage. The private interconnect is not a convenience — it is the reason RAC can function at the performance levels production systems demand.

The consequence of this design is that the network is as critical as the storage, and in many production environments, more frequently the source of instability. When the private interconnect experiences latency spikes, packet loss, or MTU mismatches, Cache Fusion transfers stall. Blocks that should transfer in sub-millisecond time begin to take tens or hundreds of milliseconds. The Oracle Cluster Synchronization Services daemon (CSSD) sends and expects heartbeat packets over this same network on a strict timer. If CSSD misses enough consecutive heartbeats — governed by the CSS misscount parameter — it concludes that the remote node is dead and initiates a node eviction. The evicted node reboots. If CSSD on both nodes simultaneously loses visibility of the other, a split-brain condition occurs, and both nodes evict each other. The resulting outage requires manual intervention to restart the cluster.

Database administrators routinely spend enormous effort tuning SQL execution plans, adjusting SGA component sizes, rebuilding indexes, and profiling wait events — all valuable work that can recover single-digit percentage improvements in throughput. Yet the same environment may be running on a switch with PortFast disabled, standard MTU 1500, and a private interconnect VLAN shared with general office LAN traffic. A topology change notification from a workstation unplugging in a conference room can trigger a 30-second STP reconvergence that evicts every RAC node simultaneously. These events are not theoretical. Post-mortem analysis of production RAC outages consistently traces the root cause to network configuration errors at the switch layer, not to database bugs or storage failures. Understanding switch hardware and configuration is not optional knowledge for a RAC DBA — it is foundational.

---

## RAC Network Architecture: Public vs Private

Every Oracle RAC node requires at minimum two physically separate network segments. Oracle's documentation and installation prerequisites are explicit on this point, and violating the separation requirement is one of the most common sources of both performance problems and cluster instability.

The public network carries client application connections, VIP (Virtual IP) addresses, and SCAN (Single Client Access Name) traffic. Each node has a standard hostname and IP address on the public network, plus a VIP — an additional IP address that floats to another node if the original node fails, allowing in-flight connections to be redirected transparently without requiring application-level reconnection logic. Oracle recommends deploying a minimum of three SCAN IP addresses, which are managed by Oracle Clusterware and round-robined by DNS to distribute incoming connections across all available nodes and their respective listeners. The public network is typically bonded for high availability using LACP (Link Aggregation Control Protocol, IEEE 802.3ad), connecting each node to the enterprise core switching infrastructure.

The private interconnect is an entirely separate physical network used exclusively for cluster-internal communication. Two categories of traffic flow over it: cluster heartbeats sent by the CSS daemon over UDP on a sub-second cadence to confirm node liveness, and Cache Fusion block transfers carried by the Oracle Cluster Interconnect Protocol (OCIP). The private interconnect must be a Layer 2 adjacency — no routing, no NAT, no firewalls, no proxies between the nodes. The moment an IP router sits in-path, you introduce routing latency, the risk of asymmetric routing, and the near-certainty that a stateful firewall will eventually mistake the high-frequency UDP heartbeat traffic for a denial-of-service attack and rate-limit or drop it. These are not edge cases; they are documented failure modes that Oracle Support sees regularly.

The recommended topology is two physical NICs per node for the private interconnect, bonded in active-active mode using LACP, connected to two physically independent private interconnect switches. The two switches carry no other traffic. They are connected to each other only through a vPC peer-link (on Cisco) or an equivalent multi-chassis LAG mechanism, which allows the two switches to appear as a single logical switch to the bonded NIC pair. This design provides both bandwidth aggregation and fault tolerance: if one NIC fails, the bond continues at full speed on the other. If one switch loses power, the peer-link allows the surviving switch to continue forwarding traffic from both NICs. There is no single point of failure in the interconnect path.

---

## Why Jumbo Frames Are Non-Negotiable

Oracle database blocks — the fundamental unit of I/O in every Oracle database — are 8 kilobytes by default, and 16 kilobytes is a common configuration for data warehouse and OLAP systems where large sequential reads benefit from the larger block size. Standard Ethernet frames have a Maximum Transmission Unit of 1500 bytes. This creates a fundamental arithmetic problem for Cache Fusion.

An 8KB Oracle block (8,192 bytes) transmitted over MTU 1500 Ethernet requires approximately six IP fragments. A 16KB block requires approximately eleven. Every fragmentation event adds CPU overhead on both the sending and receiving NICs, because the OS kernel must divide the block into fragments on transmission and reassemble them in the correct order on receipt. In a busy RAC cluster during peak load, hundreds of Cache Fusion transfers may be in flight simultaneously. The aggregate CPU overhead of constant fragmentation and reassembly becomes measurable — CPU cycles consumed by the kernel networking stack are CPU cycles not available to Oracle's foreground processes. More critically, if any single fragment of a multi-fragment transmission is lost, the entire block transfer must be retransmitted, multiplying the latency impact of any packet loss event.

Jumbo Frames — setting the MTU to 9000 bytes — allows each Oracle block to be transmitted in a single Ethernet frame with room to spare. Fragmentation is eliminated, CPU overhead drops dramatically, and Cache Fusion transfer latency falls by a measurable margin. The performance improvement is most visible under heavy write-heavy OLTP workloads where current block transfers (as opposed to consistent-read copies) dominate the interconnect traffic.

The MTU 9000 configuration must be consistent end-to-end across every hop in the path. This means configuring it on the physical NIC driver settings, the bond interface, and the OS network stack on every node, and simultaneously configuring it on every switch port that carries interconnect traffic. A single hop configured at MTU 1500 — even one switch port in the path — causes silent fragmentation at that hop. The packet arrives at the node with the correct data, but the MTU mismatch means every transfer has been fragmented anyway, negating the entire benefit. Worse, because IP fragmentation is performed silently by the network stack, the problem may not be immediately obvious from Oracle wait event statistics. The cluster runs, performance is degraded, and the root cause is invisible until someone thinks to test MTU end-to-end.

On Cisco Nexus switches, the correct MTU setting is 9216, not 9000. The 9216 byte setting is required because of Ethernet frame encapsulation overhead — the switch adds headers that consume the difference between the configured MTU and the 9000-byte payload visible to Oracle. The end-to-end verification command is \`ping -M do -s 8972 <interconnect_IP>\` — the 8972 value accounts for the 20-byte IP header and 8-byte ICMP header that are added to the 8972-byte payload to produce a 9000-byte frame. If this ping completes successfully, the path is configured correctly at Jumbo Frame MTU. If it fails with "Message too long" or "Frag needed", there is a misconfigured hop somewhere in the path.

---

## Spanning Tree Protocol: The Hidden Eviction Risk

Spanning Tree Protocol (STP) was designed for a different era of networking, when bridging loops were a common accidental misconfiguration and the protocol needed to detect and break those loops before they brought down the network. The original 802.1D STP standard resolves this by placing every switch port in one of several states — blocking, listening, learning, and forwarding — and progressing through them sequentially after any topology change. The total time to reach the forwarding state from a blocking state is 30 to 50 seconds under default timers.

Oracle Cluster Synchronization Services has its own timer: the CSS misscount. In Oracle 19c, the default misscount is 30 seconds, meaning that if CSSD fails to receive a heartbeat from a peer node for 30 consecutive seconds, it considers that node dead and initiates eviction. In some Oracle 12c configurations, the misscount is as low as 13 seconds. The arithmetic is unforgiving: if any topology change event — an uplink failure, a switch reboot, even a new device being connected to the network — triggers an STP reconvergence event on the private interconnect switch, and that reconvergence takes 30 to 50 seconds, every node on the network loses connectivity to every other node for that duration. The CSS timers expire. Node evictions fire. The cluster either self-heals after losing nodes or enters a complete outage.

PortFast (called Edge Port on some vendor platforms) is the solution for host-facing ports. When PortFast is enabled on a switch port, that port transitions directly from the administratively down state to the forwarding state without passing through blocking, listening, or learning. The host connected to that port can immediately send and receive traffic as soon as the link comes up. PortFast should be enabled on every switch port that connects to a server NIC — not just RAC interconnect ports, but any host-facing port. The risk of a bridging loop is avoided because PortFast does not disable the STP BPDU guard; if a switch or a device that generates BPDUs is connected to a PortFast port, the port detects the BPDU and disables itself.

Rapid Spanning Tree Protocol (RSTP, 802.1w) replaces standard 802.1D for inter-switch links. RSTP can converge in sub-second time — typically 200 to 500 milliseconds — by using a negotiation handshake between adjacent switches rather than waiting for fixed timers to expire. Configuring RSTP or its per-VLAN equivalent (Rapid-PVST+) on the private interconnect switches ensures that even inter-switch link failures recover before Oracle's CSS timers expire.

The most dangerous configuration is a private interconnect VLAN that is trunked across a larger campus switch infrastructure shared with general-purpose network traffic. Every topology change anywhere in that campus network — a workstation connecting, a phone rebooting, a wireless AP cycling — generates STP Topology Change Notifications that propagate throughout the spanning tree domain. Each TCN can cause switches to flush their MAC address tables and temporarily flood traffic, generating brief but repeated micro-disruptions on the interconnect. In aggregate, these constant micro-disruptions manifest as irregular Cache Fusion latency spikes that are nearly impossible to diagnose without packet capture at the switch level. The correct architecture keeps the private interconnect switches completely isolated from the general network.

---

## Cisco Nexus: The Enterprise Standard

Cisco's Nexus 9000 series switches represent the dominant choice for Oracle RAC interconnect in enterprise environments. Their prevalence is not simply a function of Cisco's market position; the Nexus architecture has specific features that directly address RAC networking requirements in ways that generic switches do not.

The Nexus 9000 uses a non-blocking, line-rate switching architecture with deeply configurable packet buffers. The deep buffer capability is particularly important for Cache Fusion: during periods of intense parallel Cache Fusion activity — for example, when many sessions are simultaneously requesting blocks held by a remote node — the interconnect can experience traffic micro-bursts that last for a few hundred microseconds. A switch with shallow buffers drops packets during these micro-bursts; a switch with deep buffers absorbs them and delivers them without loss. Packet loss at the interconnect layer forces TCP retransmissions (if TCP is in use) or causes Cache Fusion to time out and retry the block request, producing measurable latency spikes in Oracle wait events.

Virtual Port Channel (vPC) is the Nexus feature that enables the recommended dual-switch interconnect topology without requiring Spanning Tree to manage the redundancy. In a standard STP environment, connecting a server's bonded NIC pair to two different switches would cause a bridging loop — STP would block one of the uplinks, forcing all traffic through a single active path and requiring 30 seconds of STP reconvergence if that path fails. vPC makes the two physical Nexus switches appear as a single logical switch to the connected server. The server's LACP bond negotiates with what it perceives as one switch, and the two physical switches coordinate traffic forwarding through a private peer-link. The result is active-active bandwidth utilization across both physical uplinks, with sub-second failover if either switch or NIC fails. No STP blocking, no 30-second reconvergence.

Cisco publishes Cisco Validated Designs (CVDs) specifically for Oracle RAC on Nexus infrastructure. These documents provide exact configuration templates, cabling diagrams, and test results for specific Oracle and Nexus versions. When Oracle Support investigates a production RAC issue, a Cisco CVD-compliant configuration is the starting point that eliminates network architecture as a variable in the diagnosis. For organizations that value documented, tested, and vendor-supported configurations, the Nexus platform with available CVDs is the lowest-risk choice.

---

## NVIDIA/Mellanox Spectrum: For RoCE and Exadata-Class Performance

NVIDIA's Spectrum series switches, originally from Mellanox before the acquisition, occupy a specialized but increasingly important position in Oracle RAC deployments — specifically those environments targeting Exadata-equivalent performance on commodity hardware, or those deploying Oracle RAC with RDMA over Converged Ethernet (RoCE v2) for the cluster interconnect.

Standard Oracle RAC interconnect runs Cache Fusion over the standard OS TCP/IP stack. Every block transfer passes through the kernel networking stack, involving multiple memory copies, system call overhead, and interrupt processing. On a 10 or 25GbE network with a well-tuned OS, this path delivers microsecond-range latency. RoCE v2 is a fundamentally different architecture: it uses RDMA (Remote Direct Memory Access) to transfer data directly between the memory of two remote servers, completely bypassing the OS kernel on both ends. The sending server writes data to a registered memory buffer; the RDMA hardware reads it and transmits it over the network; the receiving server's RDMA hardware writes it directly into a target memory buffer. No system calls, no kernel context switches, no interrupt processing. The result is sub-microsecond latency — latency measured in hundreds of nanoseconds rather than microseconds.

RoCE v2 achieves this performance with a critical constraint: the underlying Ethernet fabric must be lossless. Standard TCP has built-in retransmission; if a packet is lost, the sender detects the loss via timeout or selective acknowledgment and retransmits. RDMA has no equivalent mechanism at the transport layer. If an RDMA packet is lost, the entire RDMA connection stalls and eventually times out at the application level. In a RAC cluster, a single lost Cache Fusion packet over RoCE causes a complete pause of all in-flight RDMA operations cluster-wide until the connection recovers. This behavior makes a lossless fabric not a preference but an absolute requirement for RoCE deployment.

NVIDIA Spectrum switches provide the hardware mechanisms necessary for a lossless fabric. Priority Flow Control (PFC) implements per-priority backpressure: when a switch port's receive buffer fills, the switch sends a PFC pause frame to the upstream sender instructing it to stop transmitting on that priority class. The sender holds the packets in its own buffer rather than dropping them, and transmission resumes when the downstream buffer drains. Explicit Congestion Notification (ECN) complements PFC by marking packets with a congestion signal before the buffer fills, allowing senders to proactively reduce their transmission rate and preventing the buffer-full condition that triggers PFC pauses. Together, PFC and ECN maintain a lossless fabric even under sustained high-load conditions at 25GbE, 100GbE, and higher speeds.

Oracle's own Exadata engineered system has used InfiniBand and RoCE for its internal cluster interconnect precisely because of these properties. Deploying NVIDIA Spectrum switches with RoCE-capable Mellanox ConnectX NICs on commodity servers replicates the Exadata interconnect performance profile at a fraction of the cost. For environments processing extremely high Cache Fusion volumes — data warehouses with large parallel query workloads, or OLTP systems with thousands of concurrent sessions — this investment in lossless fabric infrastructure can eliminate interconnect bottlenecks that would otherwise require adding more RAC nodes to distribute the load.

---

## Arista EOS: Automation and Scale

Arista Networks has built its reputation in hyperscaler and large-scale enterprise environments where network automation, operational consistency, and programmability are as important as raw switching performance. For Oracle RAC deployments at scale — multiple clusters, many nodes, frequent reconfiguration — the Arista platform's operational model offers advantages that are difficult to achieve with other vendors.

The foundation of Arista's differentiation is EOS (Extensible Operating System), which runs a standard, unmodified Linux kernel underneath the switching ASIC. Every Arista switch, from the entry-level 7050X (10/25GbE) to the large-scale 7060X (100GbE), runs the exact same EOS image. The CLI is identical, the SNMP OIDs are identical, the eAPI (a JSON-over-HTTP REST API) is identical. This uniformity means that an Ansible playbook written to configure VLAN 100 with MTU 9214 and rapid-PVST on one Arista switch applies unmodified to every Arista switch in the fleet. When a new RAC node is added and a new access port needs to be configured on the private interconnect switch, the automation runs the same playbook. No per-platform adaptation, no undocumented CLI differences, no manual verification that the command syntax is correct for this particular hardware generation.

VOQ (Virtual Output Queueing) is the Arista feature most directly relevant to RAC interconnect behavior. In a standard shared-memory switch, all traffic destined for all output ports shares a single input buffer. If one destination port is temporarily congested — for example, because one RAC node is experiencing a transient I/O spike and consuming its full 25GbE bandwidth — the backpressure from that congested port spills over into the shared buffer and affects unrelated traffic flows to other ports. This is the head-of-line blocking problem. In a RAC cluster, head-of-line blocking means that a performance problem on node A's storage path creates collateral Cache Fusion latency for nodes B and C, even though B and C have no interaction with A's I/O problem. VOQ assigns each destination port its own dedicated virtual queue, so congestion on one output port has zero impact on traffic destined for other ports. Node A's storage spike remains isolated to traffic flowing to node A; nodes B and C's Cache Fusion throughput is unaffected.

---

## Layer 2 Isolation and Multicast

Oracle Clusterware uses IP multicast for several cluster-wide group membership and notification mechanisms, including the Grid Naming Service (GNS) and Oracle Notification Services (ONS) that handle fast application failover. Multicast packets from Oracle Clusterware are sent to addresses in the 230.0.1.0 range and must reach all cluster nodes without loss or delay.

The default behavior of multicast on a managed Ethernet switch is subject to a protocol called IGMP (Internet Group Management Protocol) snooping. IGMP snooping allows the switch to listen to IGMP membership reports from hosts and build a table of which ports have hosts that have joined which multicast groups. Instead of flooding multicast traffic to every port in the VLAN, the switch forwards it only to ports with interested receivers. This optimization is generally beneficial on large networks where multicast flooding would waste bandwidth, but it introduces a dependency: for IGMP snooping to work correctly, there must be an IGMP querier on the network that periodically sends IGMP general queries to solicit membership reports from hosts. If there is no IGMP querier, the switch's snooping table entries expire, the switch stops forwarding multicast to the affected ports, and Oracle Clusterware's multicast-dependent services silently fail.

The correct configuration for the private interconnect VLAN depends on the environment. In the simplest and most reliable configuration, IGMP snooping is disabled entirely on the private interconnect VLAN. Multicast traffic is flooded to all ports in the VLAN, which is acceptable given that the VLAN contains only RAC nodes and the bandwidth consumed by Oracle Clusterware's multicast heartbeats is negligible compared to Cache Fusion traffic. The alternative — leaving IGMP snooping enabled and configuring the switch as the IGMP querier for the private VLAN — requires ongoing maintenance to ensure the querier configuration survives switch reboots and configuration changes.

Routing isolation is the other critical requirement. The private interconnect subnet — typically a dedicated RFC 1918 range such as 192.168.10.0/24 — must not be visible to any routing protocol. It must not be redistributed into OSPF, BGP, or any other routing domain. The addresses exist only within the Layer 2 domain of the private interconnect switches and should not be reachable from any other network segment. If the private subnet is inadvertently redistributed, packets destined for interconnect addresses may be routed through a router or firewall rather than delivered directly at Layer 2, introducing latency and the risk of stateful firewall inspection of UDP heartbeat traffic.

---

## Summary

The network infrastructure supporting an Oracle RAC cluster is not a component that can be configured generically and then forgotten. It is the substrate upon which the entire cluster's availability and performance depend. Cache Fusion's requirement for sub-millisecond block transfers, CSSD's strict heartbeat timers, and the volume and burstiness of cluster communication together impose specific, non-negotiable requirements on switch hardware and configuration that general-purpose enterprise networks do not face.

The two-network model — a public network for client connectivity and a completely isolated private network for cluster communication — is the architectural foundation. Mixing these networks, or sharing the private interconnect VLAN with any other traffic, is the single most common root cause of unexplained RAC instability in production. The private interconnect switches should be dedicated hardware with no other purpose.

MTU 9000 Jumbo Frames must be configured end-to-end: on the OS NIC driver, on the bond interface, and on every switch port in the private interconnect path. A single MTU 1500 hop silently re-introduces the fragmentation overhead that Jumbo Frames are designed to eliminate. Spanning Tree PortFast must be enabled on every host-facing port to prevent STP convergence delays from exceeding Oracle's CSS misscount and triggering node evictions. RSTP should be enabled globally to ensure sub-second inter-switch reconvergence.

For hardware selection, the guidance depends on operational context. Cisco Nexus is the choice for organizations that value documented, vendor-validated configurations, enterprise support contracts, and the specific capabilities of vPC for dual-switch redundancy without STP. NVIDIA Spectrum is the choice when RoCE v2 is required — either to match Exadata-class performance on commodity hardware or to deploy Oracle RAC with RDMA interconnect at scale. Arista EOS is the choice for automation-driven environments where the ability to manage switch configurations via Ansible playbooks, REST APIs, and event-driven automation is operationally critical.

The deployment checklist validates the configuration before nodes are added to the cluster: two physically separate switches for the private interconnect, MTU 9000 verified end-to-end with \`ping -M do -s 8972\`, PortFast/Edge enabled on all server-facing ports, RSTP or Rapid-PVST+ configured globally, private interconnect VLAN isolated from routing and from shared LAN segments, and IGMP snooping either disabled or configured with an explicit querier. A RAC cluster that passes this checklist starts with a network foundation that will not be the source of the next production outage.`,
};

async function main() {
  console.log('Inserting Oracle RAC Cluster Interconnect hardware post...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: { ...post },
  });
  console.log('Inserted: "' + post.title + '"');
}

main().catch(console.error);
