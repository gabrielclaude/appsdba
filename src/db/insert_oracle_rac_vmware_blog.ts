import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle RAC on VMware and RHEL 9: Architecture, Deployment, and Production Considerations',
  slug: 'oracle-rac-vmware-rhel9',
  excerpt:
    'A technical deep-dive into deploying Oracle Real Application Clusters on VMware ESXi with RHEL 9 — covering VM architecture, multi-writer VMDK shared storage, private interconnect configuration with Jumbo Frames, Grid Infrastructure installation, and the production problems unique to virtualised RAC that you will not encounter on bare metal.',
  category: 'rac-clusterware' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-13'),
  youtubeUrl: null,
  content: `Running Oracle RAC on VMware is officially supported and increasingly common — but it is not the same as running RAC on bare metal, and treating it as such is the source of most production problems on virtualised clusters. The hypervisor introduces layers of abstraction around CPU scheduling, memory management, storage I/O, and networking that RAC was not designed around. Getting RAC to work on VMware is straightforward. Getting it to perform predictably under load, survive vSphere maintenance events, and behave like a real HA cluster requires understanding where those abstractions break down.

This post covers the architecture decisions, the deployment steps that differ from bare-metal RAC, and the production problems you will encounter on VMware that are absent on physical hardware.

---

## Why RHEL 9 on VMware for RAC

RHEL 9 (and its downstream clones: Oracle Linux 9, Rocky Linux 9) is the current supported OS for Oracle Grid Infrastructure 19c and 21c deployments. VMware ESXi 7.0 U3+ and 8.0 provide the guest OS support required for RHEL 9 VMs with the VMXNET3 network adapter and PVSCSI storage controller that Oracle's VMware support matrix requires.

The combination matters because RHEL 9 brings several changes that affect RAC:

- **Kernel 5.14+:** cgroup v2 by default, which changes how Oracle's memory management interacts with the kernel. Oracle 19.18+ is required; earlier 19c releases need the cgroup v1 workaround.
- **Chrony replaces ntpd:** RAC's Cluster Time Synchronization Service (CTSS) requires either NTP or chrony — RHEL 9 ships only chrony, so the Grid Infrastructure installer will attempt to manage chrony rather than ntpd.
- **Transparent Huge Pages (THP):** Still a problem, still must be disabled explicitly — RHEL 9 does not disable it for Oracle workloads by default.

---

## Architecture Overview

\`\`\`
                    ┌─────────────────────────────────────┐
                    │         VMware ESXi Cluster         │
                    │                                     │
  ┌─────────────────┴───────┐       ┌─────────────────────┴──────┐
  │  ESXi Host 1            │       │  ESXi Host 2               │
  │                         │       │                            │
  │  ┌──────────────────┐   │       │   ┌──────────────────┐     │
  │  │   RAC Node 1     │   │       │   │   RAC Node 2     │     │
  │  │  (VM, RHEL 9)    │   │       │   │  (VM, RHEL 9)    │     │
  │  │                  │   │       │   │                  │     │
  │  │ eth0 - Public    ├───┼───────┼───┤ eth0 - Public    │     │
  │  │ eth1 - Private   ├───┼──┐  ┌─┼───┤ eth1 - Private   │     │
  │  │        (RAC IC)  │   │  │  │ │   │        (RAC IC)  │     │
  │  │ eth2 - Private   ├───┼──┘  └─┼───┤ eth2 - Private   │     │
  │  │        (RAC IC)  │   │       │   │        (RAC IC)  │     │
  │  └────────┬─────────┘   │       │   └────────┬─────────┘     │
  │           │             │       │            │               │
  └───────────┼─────────────┘       └────────────┼───────────────┘
              │                                  │
              └──────────────┬───────────────────┘
                             │ PVSCSI
                             ▼
              ┌──────────────────────────────┐
              │   Shared VMDK Storage        │
              │   (VMFS or RDM datastore)    │
              │                              │
              │   asm_ocr1.vmdk  (10 GB)     │  ← OCR + Voting (3 disks min)
              │   asm_ocr2.vmdk  (10 GB)     │
              │   asm_ocr3.vmdk  (10 GB)     │
              │   asm_data01.vmdk (500 GB)   │  ← DATA disk group
              │   asm_data02.vmdk (500 GB)   │
              │   asm_fra01.vmdk  (300 GB)   │  ← FRA disk group
              └──────────────────────────────┘
\`\`\`

**Critical constraint:** Each RAC node VM must run on a **different** ESXi host. This is enforced with a VM anti-affinity DRS rule — without it, both RAC nodes on the same host means a host failure loses the entire cluster, defeating the purpose of RAC entirely.

---

## VM Configuration

### Compute

| Parameter | Recommendation | Reason |
|-----------|---------------|--------|
| vCPUs | 8–16 per node | Oracle licenses by core; use CPU reservation to guarantee allocation |
| RAM | 64–256 GB per node | Reserve 100% — prevents memory ballooning from touching SGA |
| NUMA | Keep vCPUs within single NUMA node | Cross-NUMA memory access adds latency to Cache Fusion |
| CPU reservation | Set to full vCPU count × GHz | Prevents CPU ready time during peak load |
| Memory reservation | 100% of VM RAM | Non-negotiable for database SGA |

### Storage Controller

Use **PVSCSI** for all disks:

\`\`\`
Device:  VMware Paravirtual (pvscsi)
Reason:  Lower CPU overhead than LSI Logic, higher queue depth (255 vs 64)
         Oracle requires PVSCSI for ASM shared disks on VMware
\`\`\`

Each shared VMDK must have the **multi-writer** attribute set in the VMX configuration. Without this, the second VM to attach the disk will fail with a lock conflict:

\`\`\`
# In the VM's .vmx file — set on each shared disk:
scsi1:1.filename = "asm_ocr1.vmdk"
scsi1:1.present = "TRUE"
scsi1:1.sharedBus = "virtual"
scsi1:1.mode = "independent-persistent"
disk.EnableUUID = "TRUE"

# Multi-writer flag — critical for shared disks:
scsi1:1.sharing = "multi-writer"
\`\`\`

This must be set on every shared VMDK (OCR, DATA, FRA disks) on every VM that attaches it. The vmx edit is done through vSphere Client (VM Settings → Add/Edit → Advanced) or directly in the .vmx file when the VM is powered off.

### Networking

RAC requires a minimum of two NICs per node — one public, one private. Three NICs (two private interconnects for redundancy) is the recommended production configuration.

\`\`\`
eth0  → Public network (client connections, VIP)
          VLAN: production client VLAN
          vSwitch: standard vSwitch or dvSwitch, shared with other VMs

eth1  → RAC Private Interconnect (Cache Fusion, cluster heartbeat)
eth2  → RAC Private Interconnect (redundant)
          VLAN: dedicated RAC interconnect VLAN (isolated, no other traffic)
          vSwitch: dedicated dvSwitch or separate vSwitch
          MTU: 9000 (Jumbo Frames)
\`\`\`

**Jumbo Frames configuration:** Cache Fusion transfers large database blocks (up to 32 KB) over the private interconnect. Jumbo Frames (MTU 9000) reduce the number of packets and CPU overhead for these transfers. Three things must be aligned:

1. vSwitch/dvPortGroup MTU set to 9000 in vSphere
2. VM NIC MTU set to 9000 in RHEL (\`nmcli\` or \`/etc/NetworkManager/system-connections/\`)
3. Physical switch uplinks set to 9000 (if using dvSwitch with uplinks to physical switches — this applies even if the interconnect VMs never leave the ESXi cluster, because traffic between VMs on different hosts traverses the physical uplinks)

---

## RHEL 9 Preparation

### Kernel Parameters and THP

Add to \`/etc/sysctl.d/98-oracle-rac.conf\`:

\`\`\`bash
# Semaphores: semmsl semmns semopm semmni
kernel.sem = 250 32000 100 128
kernel.shmmax = 137438953472
kernel.shmall = 33554432
kernel.shmmni = 4096
net.core.rmem_max = 4194304
net.core.wmem_max = 1048576
net.ipv4.conf.all.rp_filter = 2
net.ipv4.conf.default.rp_filter = 2

# RAC interconnect tuning
net.core.rmem_default = 262144
net.core.wmem_default = 262144
\`\`\`

Disable THP permanently:

\`\`\`bash
# /etc/rc.d/rc.local (ensure executable: chmod +x /etc/rc.d/rc.local)
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag
\`\`\`

Or via GRUB kernel parameter (survives reboot more reliably on RHEL 9):

\`\`\`bash
grubby --update-kernel=ALL --args="transparent_hugepage=never"
\`\`\`

### Chrony Configuration for RAC

Grid Infrastructure 19c manages NTP/chrony automatically if it detects the service running. The safest configuration for a VMware guest is to use VMware Tools clock synchronisation as the primary source and disable chrony's daemon mode so Grid CTSS can take over:

\`\`\`bash
# /etc/chrony.conf — replace default contents:
# Use VMware host as time source (VMware Tools provides this)
server 169.254.0.1 iburst prefer

# Allow large corrections on startup (RAC installs may hit this)
makestep 1.0 3

# CTSS will manage further sync; disable rtcsync to avoid conflict
# rtcsync

driftfile /var/lib/chrony/drift
logdir /var/log/chrony
\`\`\`

After Grid Infrastructure is installed, CTSS takes over time management. Leave chrony installed but Grid will configure it.

### Oracle Preinstall RPM

\`\`\`bash
dnf install -y oracle-database-preinstall-19c
# or for OL9:
dnf install -y oraclelinux-release-el9
dnf install -y oracle-database-preinstall-21c
\`\`\`

This RPM creates the oracle user, oinstall/dba/oper groups, sets kernel parameters in \`/etc/sysctl.d/99-oracle-database-preinstall.conf\`, and sets security limits in \`/etc/security/limits.d/\`.

---

## Shared Storage: UDEV Rules for ASM Disk Naming

When shared VMDKs are presented to a RHEL 9 VM via PVSCSI, they appear as \`/dev/sd*\` devices. The device letter assignment (\`sdb\`, \`sdc\`, etc.) is not guaranteed to be the same on both nodes — and it is not guaranteed to be the same after a reboot on the same node if the SCSI enumeration order changes.

UDEV rules bind a persistent name to each disk by its unique identifier:

\`\`\`bash
# Get the SCSI ID for each disk:
/usr/lib/udev/scsi_id --whitelisted --replace-whitespace --device=/dev/sdb
# Output: 36000c290a2b3c4d5e6f7a8b9c0d1e2f3   ← this is the disk UUID from vmware

# Create /etc/udev/rules.d/99-oracle-asm.rules:
KERNEL=="sd?", ENV{ID_SERIAL}=="36000c290a2b3c4d5e6f7a8b9c0d1e2f3", \
  SYMLINK+="oracleasm/asm-ocr1", \
  OWNER="grid", GROUP="asmadmin", MODE="0660"

KERNEL=="sd?", ENV{ID_SERIAL}=="36000c29...", \
  SYMLINK+="oracleasm/asm-ocr2", \
  OWNER="grid", GROUP="asmadmin", MODE="0660"

# ... repeat for each ASM disk
\`\`\`

After creating the rules file:

\`\`\`bash
udevadm control --reload-rules
udevadm trigger
ls -l /dev/oracleasm/    # should show all ASM disk symlinks
\`\`\`

The UDEV approach is preferred over oracleasm (ASMLIB) on RHEL 9 because ASMLIB kernel module support for RHEL 9 kernels has lagged behind kernel updates. UDEV rules work at the OS level and require no kernel module.

---

## Grid Infrastructure Installation

The Grid Infrastructure installer (OUI) must be run as the **grid** OS user, not oracle. The key parameters that differ on VMware from bare metal:

**Response file excerpt for silent install:**

\`\`\`
oracle.install.option=CRS_CONFIG
ORACLE_HOSTNAME=racnode1.corp.local
oracle.install.crs.config.clusterName=rac-cluster-01
oracle.install.crs.config.clusterNodes=racnode1:racnode1-vip,racnode2:racnode2-vip
oracle.install.crs.config.privateInterconnects=eth1:169.254.10.0/24,eth2:169.254.11.0/24
oracle.install.crs.config.storageOption=ASM
oracle.install.crs.config.sharedFileSystemStorage.diskDriveMapping=/dev/oracleasm/asm-ocr1,/dev/oracleasm/asm-ocr2,/dev/oracleasm/asm-ocr3
oracle.install.crs.config.useIPMI=false
\`\`\`

Grid Infrastructure creates the SCAN VIP (a single DNS name resolving to 3 IPs by default) which provides transparent load balancing for client connections. On VMware, the SCAN VIPs are managed by Oracle Clusterware — they float to different nodes via gratuitous ARP, exactly as on bare metal.

---

## Problems Unique to Virtualised RAC

### 1. vMotion and Cache Fusion Interruption

**Problem:** vSphere vMotion migrates a running VM from one ESXi host to another with a brief (milliseconds to seconds) "stun" — the VM is frozen while memory is transferred. For most workloads, this is invisible. For Oracle RAC, the private interconnect goes silent during the stun, which triggers the cluster interconnect health monitor. Depending on the duration:

- Short stun (<1 second): interconnect missed heartbeat, network timeout counter increments. No outage.
- Medium stun (1–5 seconds): Oracle's **Cluster Health Monitor (CHM)** may declare the interconnect degraded. May trigger a NIC fail-over to the secondary interconnect.
- Long stun (>5 seconds, possible during large VM migration): **may cause a node eviction**. The surviving node's CSSD declares the migrating node dead and evicts it from the cluster. The evicted node then attempts to rejoin.

**Solution:**
- Disable vMotion for RAC VMs during business hours, or completely. Use VM anti-affinity rules and tolerate host failure as a cold failover event.
- If vMotion is required (e.g., maintenance), drain the node first: put it in maintenance mode with \`srvctl stop instance -d ORCL -i ORCL1\` before vMotion, start it after.
- Set \`misscount\` to a higher value if vMotion cannot be avoided — but this also lengthens the time to detect a genuine node failure.

### 2. Memory Ballooning and SGA Corruption Risk

**Problem:** If ESXi is memory-overcommitted across the cluster, VMware's balloon driver (\`vmmemctl\`) reclaims guest RAM by inflating inside the guest OS, forcing the OS to swap out pages. For Oracle Database, if any SGA page is swapped out:

- Oracle may see I/O latency on SGA reads that looks like storage latency
- Worst case: SGA corruption if a page is swapped and the VMkernel returns inconsistent data on swap-in

**Solution:** Set **100% memory reservation** on all RAC VMs. This tells ESXi that none of this VM's memory is available for reclamation. It prevents ballooning, swapping, and transparent page sharing for the reserved pages. The cost is that ESXi cannot overcommit that memory — what you reserve is dedicated.

\`\`\`
vSphere Client → VM → Edit Settings → Memory → Reservation → Set to full VM memory size
\`\`\`

### 3. ASM Disk Visibility After VM Restart

**Problem:** After a RAC node VM is restarted, UDEV may not run \`udevadm trigger\` before Grid Infrastructure starts, causing ASM to fail to find its disks and not mount disk groups. This is more common when the OS boot is fast (small VM) and GI starts before \`udev\` has finished settling.

**Solution:** Add a \`udevadm settle\` call to the system startup sequence, before the GI init script fires:

\`\`\`bash
# /etc/rc.d/rc.local — runs before GI if configured:
udevadm settle --timeout=30
\`\`\`

Or, more reliably, add a systemd unit that orders itself before \`ohas.service\` (the Oracle High Availability Services daemon):

\`\`\`ini
[Unit]
Description=Settle udev before Oracle GI
Before=ohas.service
After=local-fs.target

[Service]
Type=oneshot
ExecStart=/usr/bin/udevadm settle --timeout=30
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
\`\`\`

### 4. Storage Latency Targets

Oracle RAC's redo log write path and ASM heartbeat are latency-sensitive. On bare metal with direct-attached SSD, redo write latency is typically sub-millisecond. On VMware, storage I/O goes through the PVSCSI controller, the VMkernel storage stack, and the datastore — adding latency. Targets:

| Operation | Bare Metal Target | VMware Acceptable | VMware Problem Threshold |
|-----------|------------------|-------------------|------------------------|
| Redo log write (LGWR) | <1 ms | <2 ms | >5 ms → alert |
| Voting disk I/O (CSSD) | <200 ms | <500 ms | >1 s → node eviction risk |
| ASM disk group mount | instantaneous | instantaneous | Timeout = disk not visible |

Monitor with:

\`\`\`sql
-- Redo write latency from AWR (run on each node)
SELECT stat_name, value
FROM   v$sys_time_model
WHERE  stat_name IN ('redo write time', 'log file sync time');

-- LGWR write latency histogram
SELECT event, wait_class, total_waits, time_waited, average_wait
FROM   v$system_event
WHERE  event LIKE 'log file%'
ORDER BY time_waited DESC;
\`\`\`

### 5. SCAN VIP Routing on Flat vSwitch Networks

**Problem:** Oracle SCAN uses 3 VIP addresses that rotate via round-robin DNS. On VMware, SCAN VIPs move between RAC nodes via ARP. If the client VM and the RAC VMs are on the same vSwitch/port group, ARP works normally. If they are on different port groups or different VLANs, SCAN VIP ARP replies may not be forwarded correctly depending on the vSwitch configuration.

**Solution:** Ensure SCAN VIPs, node VIPs, and client IPs are all reachable at Layer 3, and that the vSwitch/dvSwitch port group for the public network is set to **Accept** for promiscuous mode and forged transmits (required for VIP address floating):

\`\`\`
vSphere Client → dvSwitch → Port Group → Edit → Security:
  Promiscuous Mode: Accept
  MAC Address Changes: Accept
  Forged Transmits: Accept
\`\`\`

---

## Post-Deployment Validation

\`\`\`bash
# Cluster status (run as grid user)
crsctl stat res -t

# Verify all resources Online on both nodes
crsctl check crs

# ASM disk group status
asmcmd lsdg

# Test SCAN connectivity from a client host
tnsping SCAN_NAME

# Verify interconnect is using the correct NICs (not public NIC)
oifcfg getif
# Should show eth1 and eth2 as cluster_interconnect

# Check Cache Fusion traffic is on private NICs:
select inst_id, name, value
from gv$sysstat
where name like 'gc%'
order by inst_id, name;
\`\`\`

---

## Summary

Oracle RAC on VMware with RHEL 9 works reliably when the hypervisor layer is configured to support Oracle's assumptions about CPU scheduling, memory availability, storage latency, and network behaviour. The departures from default VMware behaviour that are non-negotiable for production RAC:

- **Anti-affinity DRS rule** — nodes on different ESXi hosts at all times
- **100% memory reservation** — no ballooning or swapping of SGA
- **CPU reservation** — no CPU ready time under load
- **PVSCSI + multi-writer VMDKs** — correct shared storage semantics
- **Dedicated private interconnect port group** with Jumbo Frames (MTU 9000)
- **vMotion disabled** or only used during planned maintenance with node drained first
- **UDEV rules** for persistent ASM disk naming across both nodes and reboots

The companion runbook covers the complete step-by-step deployment procedure: VMware storage preparation, VM creation, RHEL 9 OS configuration, UDEV rule creation, Grid Infrastructure silent installation, ASM disk group creation, Oracle Database software installation, and the post-install validation checks.`,
};

async function main() {
  console.log('Inserting Oracle RAC on VMware blog post...');
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
