import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Demystifying Oracle RAC on RHEL 9 and VMware ESXi: The Enterprise Blueprint',
  slug: 'oracle-rac-rhel9-vmware-esxi-enterprise-blueprint',
  excerpt:
    'A comprehensive guide to deploying Oracle Real Application Clusters on RHEL 9 inside VMware ESXi managed by vCenter — covering anti-affinity rules, multi-writer VMDK shared storage, private interconnect isolation with Jumbo Frames, RHEL 9 kernel preparation, UDEV-based ASM disk naming, and the production best practices that separate a stable RAC cluster from one that pages you at 2am.',
  category: 'exalogic' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-13'),
  youtubeUrl: null,
  content: `Deploying Oracle Real Application Clusters (RAC) has always been the gold standard for high availability and scalability in enterprise database environments. When you layer that workload onto Red Hat Enterprise Linux 9 running on VMware ESXi and managed by vCenter, you are not just building a database — you are engineering a high-performance, resilient, cloud-ready infrastructure.

Historically, running Oracle RAC on VMware was met with skepticism: licensing concerns, performance overhead from the hypervisor, and the complexity of shared storage on virtual infrastructure. Today, that narrative has flipped. Modern ESXi features, combined with RHEL 9's performance optimisations and Oracle's continued investment in virtualisation support, make this stack a deliberate enterprise choice.

---

## Why This Stack

**RHEL 9 Advantages**

Built on the upstream Linux 5.14 kernel, RHEL 9 introduces several changes that directly benefit Oracle RAC deployments:

- **cgroups v2 by default** — improved resource management for CPU and memory isolation, though Oracle 19.18+ is required for full compatibility (earlier 19c releases need the cgroup v1 workaround)
- **Enhanced NVMe-over-Fabrics support** — relevant when ASM disks are presented over NVMe-oF rather than SCSI
- **OpenSSL 3.0** — tighter default security posture for OS-level communication
- **chrony replaces ntpd** — Grid Infrastructure detects and manages chrony automatically on RHEL 9; no manual NTP daemon configuration required

**vSphere / vCenter Flexibility**

VMware vSphere provides the operational layer that makes virtualised RAC practical at scale:

- **Anti-affinity DRS rules** — enforce separation of RAC nodes across physical hosts automatically
- **vMotion** — live migration of RAC VMs is supported when configured correctly (the key word is "correctly" — see the production considerations section)
- **Snapshot-based patch testing** — snapshot a node VM before applying Oracle patches, validate, then commit or roll back
- **vCenter resource pools** — apply CPU/memory reservations to RAC VMs as a group, ensuring the cluster's resource entitlements are maintained

---

## Architecture Overview

\`\`\`
                    [ vCenter Server ]
                            |
      +---------------------+---------------------+
      |                                           |
[ ESXi Host 1 ]                             [ ESXi Host 2 ]
      |                                           |
  +---+----+                                 +----+---+
  |        |                                 |        |
[ VM:     ]|                               [ VM:     ]|
[ Node 1  ]|                               [ Node 2  ]|
[ RHEL 9  ]|                               [ RHEL 9  ]|
  |   eth0 +---[ Public Network ]-----------+ eth0   |
  |   eth1 +---[ Private IC 1   ]-----------+ eth1   |
  |   eth2 +---[ Private IC 2   ]-----------+ eth2   |
  +---+----+                                 +----+---+
      |                                           |
      +-------------------+---+-------------------+
                          |   |
               [ Shared VMDKs on VMFS Datastore ]
               [ multi-writer + PVSCSI           ]
               [  asm_ocr1.vmdk  (OCR/Voting)    ]
               [  asm_ocr2.vmdk  (OCR/Voting)    ]
               [  asm_ocr3.vmdk  (OCR/Voting)    ]
               [  asm_data01.vmdk (DATA)          ]
               [  asm_fra01.vmdk  (FRA)           ]
\`\`\`

---

## 1. Compute and VM Configuration

Each Oracle RAC node runs in its own VM on RHEL 9. For maximum availability these VMs must reside on separate physical ESXi hosts. This is enforced — not just recommended — via a **VM-Host Anti-Affinity DRS rule** in vCenter:

\`\`\`
vCenter → Cluster → Configure → VM/Host Rules → Add Rule
Type:    Separate Virtual Machines
Members: racnode1, racnode2
\`\`\`

Without this rule, vSphere DRS may schedule both nodes on the same host during low-load periods, silently eliminating the HA benefit of RAC until the next DRS rebalance cycle.

### VM Sizing Guidelines

| Resource | Minimum | Production Recommendation |
|----------|---------|--------------------------|
| vCPUs | 4 | 8–16 (match Oracle licensing unit) |
| RAM | 32 GB | 64–256 GB |
| OS disk | 60 GB | 100 GB (thin, private datastore) |
| CPU reservation | None | Full (vCPUs × GHz) |
| Memory reservation | None | **100% — non-negotiable** |
| SCSI controller | LSI Logic | **PVSCSI (required for ASM disks)** |

The memory reservation requirement is absolute. Allowing Oracle SGA/PGA memory to participate in ESXi's balloon driver reclamation will destroy database performance, and in worst cases cause SGA corruption when swapped pages are returned with inconsistent data.

---

## 2. Networking

Oracle RAC requires two distinct networks. In VMware these map to separate vSwitches or dvSwitch port groups with different MTU settings and physical uplink assignments.

### Network Matrix

| Network | Purpose | MTU | vSwitch Isolation |
|---------|---------|-----|------------------|
| Public (eth0) | Client connections, VIP, SCAN | 1500 | Shared production vSwitch |
| Private IC (eth1, eth2) | Cache Fusion, cluster heartbeat | **9000** | Dedicated RAC interconnect vSwitch |

The private interconnect carries Oracle Cache Fusion traffic — the mechanism by which RAC nodes share database blocks in memory across the cluster. Cache Fusion transfers blocks of 4–32 KB continuously under OLTP load. Jumbo Frames (MTU 9000) are not optional for production; they reduce CPU overhead for packet assembly and halve the packet count for large block transfers.

**Three places MTU 9000 must be set:**

1. vSwitch/dvPortGroup in vSphere (Edit Settings → MTU)
2. The RHEL 9 VM NIC (via \`nmcli con mod eth1 802-3-ethernet.mtu 9000\`)
3. Physical switch uplinks (even if both RAC VMs are on the same ESXi host today, they will eventually be on different hosts)

Verify end-to-end with a max-size ping:

\`\`\`bash
ping -M do -s 8972 -c 10 <node2_private_ip>
# -M do = prohibit fragmentation
# 8972 bytes payload + 28 bytes IP/ICMP header = 9000 bytes
# 100% success = Jumbo Frames working end-to-end
\`\`\`

If any hop has MTU < 9000, the ping fails with "Message too long" — pinpointing the misconfigured layer.

---

## 3. Multi-Writer VMDK Shared Storage

The cornerstone of Oracle RAC is shared storage. On VMware, this means VMDKs with the **multi-writer attribute** — the flag that permits multiple ESXi hosts to read and write the same virtual disk simultaneously without the VMkernel's standard exclusive locking.

### Storage Requirements

- **VMFS datastore** (not NFS — NFS datastores do not support multi-writer SCSI semantics required by ASM)
- **Thick Provision Eager Zeroed** VMDKs — Oracle ASM reads uninitialized blocks and expects zeros; thin-provisioned VMDKs may return garbage data, causing ASM to misidentify disk content
- **PVSCSI controller** for shared disks — required by Oracle's VMware support matrix; provides higher queue depth (255 vs 64) and lower CPU overhead than LSI Logic
- **SCSI Bus Sharing: Virtual** on the shared PVSCSI controller (enables cross-VM access within the same vCenter cluster)

### Enabling Multi-Writer

After adding a shared VMDK to a VM in vSphere Client, expand the disk entry under VM Settings and set:

\`\`\`
Disk Mode:  Independent - Persistent
Sharing:    Multi-writer
\`\`\`

Or verify directly in the .vmx file:

\`\`\`
scsi1:1.sharing = "multi-writer"
scsi1:1.mode = "independent-persistent"
disk.EnableUUID = "TRUE"
\`\`\`

The \`disk.EnableUUID = "TRUE"\` setting is required so that each disk has a stable UUID — this is the identifier that UDEV rules use to create persistent \`/dev/oracleasm/\` symlinks on both nodes.

---

## 4. Preparing RHEL 9

RHEL 9 introduces several changes that require attention before installing Oracle Grid Infrastructure.

### Disable Transparent Huge Pages

Oracle Database actively avoids THP because the kernel may reclaim and rebuild huge pages during runtime, causing latency spikes that look like I/O wait. Disable it persistently via GRUB:

\`\`\`bash
sudo grubby --update-kernel=ALL --args="transparent_hugepage=never"
# Reboot required. Verify after:
cat /sys/kernel/mm/transparent_hugepage/enabled
# Expected: always madvise [never]
\`\`\`

### Configure Chrony for RAC

Oracle RAC is sensitive to time drift between nodes. The Cluster Time Synchronisation Service (CTSS) monitors drift and will trigger a node restart if clocks diverge beyond its threshold. On RHEL 9 with VMware, configure chrony to use the VMware host as its time source:

\`\`\`bash
# /etc/chrony.conf
server 169.254.0.1 iburst prefer   # VMware Tools provides this source
makestep 1.0 3                      # Allow large corrections at startup
driftfile /var/lib/chrony/drift
\`\`\`

The \`-x\` flag on \`chronyd\` prevents slewing (gradual adjustment), which RAC tolerates. Step corrections at startup with \`makestep\` are safe; step corrections on a running cluster are not — keep nodes in sync from the start.

### Install the Oracle Preinstall RPM

Oracle provides a shortcut RPM that handles kernel parameters, sysctl settings, user/group creation, and security limits in a single package:

\`\`\`bash
# Oracle Linux 9:
dnf install -y oracle-database-preinstall-19c

# RHEL 9 (manual equivalent):
# Creates oracle and grid OS users, oinstall/dba/asm groups,
# sets /etc/sysctl.d/ and /etc/security/limits.d/ entries
\`\`\`

Validate after installation:

\`\`\`bash
id oracle && id grid
sysctl kernel.sem kernel.shmmax fs.aio-max-nr
\`\`\`

---

## 5. ASM Disk Naming with UDEV

In RHEL 9, the traditional raw device interface is gone. UDEV rules replace it — binding each physical disk to a persistent name by its unique identifier, so \`/dev/oracleasm/asm-data01\` always points to the same VMDK on both nodes regardless of SCSI enumeration order at boot.

Get the stable SCSI ID for each shared disk:

\`\`\`bash
/usr/lib/udev/scsi_id -g -u -d /dev/sdb
# Returns: 36000c29a2b3c4d5e6f7a8b9c0d1e2f3  ← VMDK UUID
\`\`\`

Create \`/etc/udev/rules.d/99-oracle-asm.rules\`:

\`\`\`
KERNEL=="sd[a-z]", SUBSYSTEM=="block", \
  PROGRAM=="/usr/lib/udev/scsi_id -g -u -d /dev/%k", \
  RESULT=="36000c29a2b3c4d5e6f7a8b9c0d1e2f3", \
  SYMLINK+="oracleasm/asm-ocr1", \
  OWNER="grid", GROUP="asmadmin", MODE="0660"
\`\`\`

One rule block per disk. After creating the file:

\`\`\`bash
udevadm control --reload-rules && udevadm trigger
ls -la /dev/oracleasm/    # verify all symlinks present
\`\`\`

The rules file is identical on both nodes (the SCSI IDs are the same because the IDs come from the shared VMDK UUID, not the local device letter).

---

## 6. Grid Infrastructure and Database Installation

With the infrastructure in place, the installation follows Oracle's standard RAC procedure:

**Grid Infrastructure (OUI as grid user):**
1. Run \`gridSetup.sh\` from the unzipped Grid home — in silent mode with a response file for repeatable deployments
2. Configure: cluster name, node list with VIPs, SCAN name, private interconnect NICs, OCR disk group pointing to \`/dev/oracleasm/asm-ocr*\`
3. Run \`root.sh\` on both nodes when prompted — racnode1 first, then racnode2 after racnode1's \`root.sh\` completes

**Oracle Database software:**
1. Run \`runInstaller\` from the DB home as oracle user — software-only install
2. Run \`root.sh\` on both nodes

**Database creation:**
1. Use DBCA with the \`-nodeinfo racnode1,racnode2\` parameter to create a clustered database
2. DBCA creates two instances (ORCL1 on racnode1, ORCL2 on racnode2) sharing the same DATA and FRA disk groups

---

## Production Best Practices

### vMotion: Use With Caution

vSphere vMotion can live-migrate a running RAC node VM between ESXi hosts. The "stun" — the period when the VM is frozen while memory state is transferred — is normally invisible to applications. For Oracle RAC it is not:

| Stun Duration | Impact |
|--------------|--------|
| < 1 second | Missed interconnect heartbeat; no outage |
| 1–5 seconds | CHM may declare interconnect degraded |
| > 5–10 seconds | **Node eviction risk** — surviving node declares migrating node dead |

The stun duration scales with VM memory size. A 256 GB RAC node VM with a high dirty memory rate can produce stuns of 10+ seconds on a busy ESXi host.

**Recommended approach:** Disable vMotion for RAC VMs during production hours. If maintenance requires migrating a node, drain it first:

\`\`\`bash
srvctl stop instance -d ORCL -i ORCL1
# vMotion the VM
srvctl start instance -d ORCL -i ORCL1
\`\`\`

### Memory Reservation: Non-Negotiable

Set 100% memory reservation on every RAC VM. ESXi's balloon driver (\`vmmemctl\`) and transparent page sharing must never reclaim pages that belong to the Oracle SGA.

\`\`\`
vSphere Client → VM → Edit Settings → Resources → Memory
Reservation: [VM memory size in MB]
\`\`\`

### Storage Latency Targets

Oracle RAC's redo log writer (LGWR) and ASM voting disk heartbeat are latency-sensitive. Target thresholds for a VMware environment:

| I/O Type | Target | Problem Threshold |
|----------|--------|------------------|
| Redo log write (LGWR) | < 2 ms | > 5 ms |
| Voting disk I/O (CSSD) | < 500 ms | > 1 second → eviction risk |
| ASM rebalance I/O | < 10 ms avg | > 30 ms → rebalance lag |

Monitor via vCenter's datastore performance charts (Average Read/Write Latency) and from Oracle:

\`\`\`sql
SELECT event, total_waits, time_waited, average_wait
FROM   v\$system_event
WHERE  event IN ('log file sync', 'log file parallel write')
ORDER BY time_waited DESC;
\`\`\`

---

## Common Problems and Solutions

### Problem: Cache Fusion Traffic on Public NIC

**Symptom:** High \`gc buffer busy acquire\` waits, slow inter-instance block transfers. Running \`SELECT * FROM v\$cluster_interconnects\` shows the public IP (10.x.x.x) instead of the private IP (169.254.x.x).

**Cause:** Grid Infrastructure chose the wrong NIC for the interconnect during installation — either because the private NIC wasn't configured when GI ran, or because \`oifcfg\` has incorrect assignments.

**Fix:**

\`\`\`bash
# Check current assignment:
oifcfg getif

# Correct it:
oifcfg setif -global eth0/10.10.1.0:public
oifcfg setif -global eth1/169.254.10.0:cluster_interconnect
oifcfg setif -global eth2/169.254.11.0:cluster_interconnect

# Restart GI for changes to take effect (requires cluster outage or rolling restart)
\`\`\`

### Problem: ASM Disks Not Found After Reboot

**Symptom:** Grid Infrastructure fails to start after a VM reboot. \`crsctl stat res -t\` shows ASM resources in OFFLINE state. \`/dev/oracleasm/\` directory is empty.

**Cause:** The GI init service (\`ohas.service\`) starts before \`udevadm settle\` completes, so UDEV hasn't created the symlinks when GI looks for its disks.

**Fix:** Add a systemd unit that runs \`udevadm settle\` and orders itself before \`ohas.service\`:

\`\`\`bash
cat > /etc/systemd/system/udev-settle-asm.service << 'EOF'
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
EOF

systemctl daemon-reload
systemctl enable udev-settle-asm.service
\`\`\`

### Problem: SCAN VIP ARP Not Reaching Clients

**Symptom:** Clients can ping node VIPs individually but \`tnsping\` to the SCAN name fails intermittently. \`nslookup rac-scan\` returns 3 A records but connections to one of the IPs time out.

**Cause:** The dvSwitch port group for the public network has **Forged Transmits** set to Reject. When a SCAN VIP moves from one node to another, it sends a gratuitous ARP from the new node with a MAC address that doesn't match the port group's assigned MAC. The dvSwitch drops it.

**Fix:**

\`\`\`
vSphere Client → dvSwitch → Port Group → Edit → Security:
  Promiscuous Mode:  Accept
  MAC Address Changes: Accept
  Forged Transmits:  Accept
\`\`\`

### Problem: Node Eviction After vMotion

**Symptom:** One RAC node is evicted from the cluster with CSSD error: \`Node 'racnode1' is being evicted due to a communication timeout\`. The vMotion event timestamp in vCenter correlates exactly with the eviction time in \`/u01/app/grid/diag/crs/racnode1/crs/trace/alert.log\`.

**Cause:** VM stun during vMotion exceeded the CSSD \`misscount\` threshold.

**Fix options:**
1. Stop the instance before vMotion (preferred): \`srvctl stop instance -d ORCL -i ORCL1\`
2. Increase misscount temporarily: \`crsctl set css misscount 60\` (default is 30) — gives more tolerance for stun, but also slows genuine failure detection
3. Disable vMotion for RAC VMs via DRS rules

---

## Summary

Oracle RAC on RHEL 9 and VMware ESXi delivers enterprise HA when the hypervisor layer is configured to match Oracle's requirements. The non-negotiable configuration points:

| Configuration | Default | Required |
|--------------|---------|---------|
| VM placement | DRS managed | Anti-affinity rule: nodes on separate hosts |
| Memory | Shared | 100% reservation |
| CPU | Shared | Reservation matching licensed cores |
| Storage controller | Any | PVSCSI |
| Shared VMDK attribute | Exclusive | multi-writer + independent-persistent |
| Private interconnect MTU | 1500 | 9000 (Jumbo Frames) |
| THP | Enabled | Disabled via GRUB |
| ASM disk naming | udev default | Persistent rules via SCSI UUID |
| vMotion | Enabled | Disabled or drain-first policy |

The companion runbook covers the complete deployment procedure step by step — from VMware storage preparation through Grid Infrastructure installation, ASM disk group creation, database creation, and post-deploy validation.`,
};

async function main() {
  console.log('Inserting Oracle RAC on VMware (Exalogic section) blog post...');
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
