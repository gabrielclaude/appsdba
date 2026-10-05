import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'oracle-19c-ebs-122-oci-provisioning-availability-zones-load-balancing';

const content = `
Oracle Cloud Infrastructure was not designed as a generic cloud platform with Oracle software running on top of it. It was designed from the ground up around the assumption that most workloads would be Oracle workloads — databases, middleware, ERP systems — and the infrastructure choices that would make those workloads perform and survive hardware failure were built into the platform's physical architecture before a single service was offered. Understanding that design intent is the starting point for provisioning Oracle Database 19c and Oracle E-Business Suite 12.2 in OCI with high availability. The infrastructure decisions and the application configuration decisions are not independent — they reinforce each other, and making the wrong infrastructure choice early constrains what the application tier can do later.

This post covers the OCI physical architecture that determines fault isolation, how Availability Domains and Fault Domains translate into database and application tier placement decisions, the correct provisioning sequence for a 19c DB System and an EBS 12.2 application tier, how the OCI Load Balancer integrates with EBS WebLogic, and the network design choices that affect both security and performance.

---

## The Physical Architecture You Are Actually Deploying Into

Before touching a provisioning screen, it is worth understanding what OCI's availability guarantees are based on physically. This matters because the terms "Availability Domain" and "Fault Domain" are used constantly in OCI documentation, but their meaning is architectural before it is definitional.

An OCI **Region** is a geographic area containing one or more data centers. Most OCI regions now have three Availability Domains. A region is the unit at which services are offered — you create a VCN in a region, and resources within that VCN can span multiple Availability Domains within the same region.

An **Availability Domain** (AD) is a physically isolated data center within a region. The word "isolated" here is meaningful: separate power infrastructure, separate cooling, separate physical buildings. ADs within a region are connected by a low-latency, high-bandwidth network (Oracle calls this the "dark fiber" inter-AD backbone), but a catastrophic failure in AD-1 — power loss, cooling failure, flooding — does not affect AD-2 or AD-3. For Oracle Database with Data Guard, this is the correct unit of isolation for a standby database: the primary runs in AD-1, the standby runs in AD-2, and a single-site disaster cannot take both down simultaneously.

A **Fault Domain** (FD) is a grouping of hardware within a single Availability Domain. Each AD contains three Fault Domains. A Fault Domain is not a separate building — it is a separate rack or set of racks sharing a top-of-rack switch and power distribution unit. A hardware failure that takes down a single switch or PDU affects only one Fault Domain. For resources that must remain in the same AD (because latency across ADs is non-trivial for synchronous operations), Fault Domains provide a layer of isolation against hardware failures within that AD.

The practical implication for an EBS 12.2 deployment: the database and the primary application tier node should be in the same AD (to minimize DB-to-app latency), but distributed across different Fault Domains to avoid a single rack failure taking both down simultaneously. If you have multiple application tier nodes behind a load balancer, spread them across at least two Fault Domains within the same AD. The standby database, if using Data Guard for HA or DR, should be in a different AD entirely.

\`\`\`
OCI Region: us-phoenix-1
├── Availability Domain 1 (PHX-AD-1)
│   ├── Fault Domain 1 → Primary DB System (19c)
│   ├── Fault Domain 2 → EBS App Tier Node 1 (WebLogic + OHS)
│   └── Fault Domain 3 → EBS App Tier Node 2 (WebLogic + OHS)
├── Availability Domain 2 (PHX-AD-2)
│   ├── Fault Domain 1 → Standby DB System (19c Data Guard)
│   └── Fault Domain 2 → OCI Load Balancer (backend set)
└── Availability Domain 3 (PHX-AD-3)
    └── Bastion / Admin Node
\`\`\`

A single-AD region (some newer OCI regions have only one AD) changes this calculus: your primary and standby must coexist in the same AD, and Fault Domain separation becomes the only physical isolation layer available. OCI does offer a "Local Peering" pattern and stretched clusters for single-AD regions, but those are outside the scope of a standard EBS HA deployment.

---

## Network Design: VCN, Subnets, and Security

The network must be designed before any compute or database resource is provisioned, because compute and DB instances are placed into subnets at creation time and cannot be moved without re-creation.

### VCN Design

Create a single VCN for the EBS deployment. The CIDR block should be large enough to accommodate the database tier, application tier, load balancer, admin hosts, and any future growth without overlap with on-premises networks if you will use FastConnect or VPN.

A practical CIDR for an EBS production deployment: \`10.10.0.0/16\` with the following subnet breakdown:

| Subnet | CIDR | Access | Purpose |
|---|---|---|---|
| \`sn-db-private\` | \`10.10.1.0/24\` | Private | DB System nodes |
| \`sn-app-private\` | \`10.10.2.0/24\` | Private | EBS app tier nodes |
| \`sn-lb-public\` | \`10.10.3.0/24\` | Public | OCI Load Balancer |
| \`sn-admin\` | \`10.10.4.0/24\` | Private | Bastion, admin hosts |

The database and application tier subnets are private — no public IP, no Internet Gateway route. Outbound traffic from these subnets to Oracle software repositories, patches, or OCI services routes through a NAT Gateway. Inbound connections to the database come only from the app-tier subnet. Inbound connections to the app tier nodes come only from the load balancer subnet.

The load balancer subnet is public, fronted by an Internet Gateway. This is the only ingress point for user traffic. The OCI Load Balancer itself holds the public IP — the EBS application nodes never have public IPs.

### Security Groups vs. Security Lists

OCI provides two mechanisms for network-layer security: Security Lists (associated with subnets, applied to all resources in the subnet) and Network Security Groups (NSGs, associated with individual VNICs and applied selectively). For an EBS deployment:

Use **Security Lists** for broad subnet-level rules that apply to everything in that subnet — for example, allowing the entire DB subnet to accept traffic from the app subnet on port 1521. Use **NSGs** for resource-specific rules — for example, allowing the load balancer NSG to accept inbound HTTPS on port 443 from anywhere (0.0.0.0/0), but allowing EBS app nodes to accept traffic only from the load balancer NSG, not from arbitrary sources.

The NSG model is more expressive and more auditable. The Security List model is simpler for initial setup. A reasonable production approach is to use Security Lists for the initial deployment and migrate to NSGs during the operational hardening phase.

Critical firewall rules for the EBS topology:

\`\`\`
DB Subnet Security List (sn-db-private):
  Ingress:
    10.10.2.0/24  TCP  1521  ACCEPT   (EBS app tier → DB listener)
    10.10.4.0/24  TCP  1521  ACCEPT   (Admin hosts → DB for DBA access)
    10.10.1.0/24  ALL  ALL   ACCEPT   (Intra-DB-subnet: ASM, SCAN, VIP)
  Egress:
    0.0.0.0/0     ALL  ALL   ACCEPT   (Via NAT Gateway for patches)

App Tier Subnet Security List (sn-app-private):
  Ingress:
    10.10.3.0/24  TCP  8000  ACCEPT   (Load Balancer → OHS port)
    10.10.3.0/24  TCP  4443  ACCEPT   (Load Balancer → OHS SSL port)
    10.10.4.0/24  TCP  22    ACCEPT   (Admin/Bastion → SSH)
    10.10.2.0/24  ALL  ALL   ACCEPT   (Intra-app-subnet: WLS cluster comms)
  Egress:
    10.10.1.0/24  TCP  1521  ACCEPT   (App tier → DB listener)
    0.0.0.0/0     ALL  ALL   ACCEPT   (Via NAT Gateway for patches)

Load Balancer Subnet Security List (sn-lb-public):
  Ingress:
    0.0.0.0/0     TCP  443   ACCEPT   (User HTTPS to EBS)
    0.0.0.0/0     TCP  80    ACCEPT   (HTTP → redirect to HTTPS)
  Egress:
    10.10.2.0/24  TCP  8000  ACCEPT   (LB → OHS on app nodes)
    10.10.2.0/24  TCP  4443  ACCEPT   (LB → OHS SSL on app nodes)
\`\`\`

---

## Provisioning the Oracle Database 19c DB System

OCI provides Oracle Database through its **DB System** service — a managed offering where Oracle provisions the underlying compute, storage, and Oracle Database software within your tenancy's VCN. This is distinct from provisioning a raw compute instance and installing Oracle Database manually. DB Systems abstract the OS configuration, grid infrastructure, and Oracle Home installation while giving you full SQL access and DBA control over the database itself.

### Choosing the DB System Shape

DB System shapes divide into two fundamental types: **Virtual Machine (VM) DB Systems** and **Bare Metal (BM) DB Systems**.

VM DB Systems run on Oracle's hypervisor (Oracle VM) and share underlying hardware. They are the correct choice for most EBS deployments:

- Shapes from \`VM.Standard.E4.Flex\` (1–64 OCPUs, 1–1024 GB memory) to \`VM.Standard3.Flex\`
- Support for single-node (without RAC) and 2-node RAC configurations
- OCI manages the host OS, Grid Infrastructure installation, and firmware
- Standard block volume storage (NVMe-backed)

Bare Metal DB Systems give you a dedicated physical server with no hypervisor. They are appropriate for extremely high-throughput OLTP workloads or environments where hypervisor overhead is unacceptable for performance SLAs. For EBS 12.2 production workloads that are not pushing against hardware limits, the VM DB System is the correct choice — it provides the flexibility to resize (OCPU and memory can be scaled online) without the operational overhead of a dedicated bare metal host.

For an EBS 12.2 production database, start with:

- **Shape:** \`VM.Standard.E4.Flex\` with 4–8 OCPUs and 64–128 GB memory
- **Nodes:** 1 (single node with Data Guard standby) or 2 (RAC, if PCP is required for concurrent manager HA)
- **Oracle Database Version:** 19c with the latest RU applied at provisioning time
- **Storage:** OCI Block Volumes via ASM, 2 TB initial allocation (expandable online)

### Provisioning with OCI CLI

The OCI CLI is the most repeatable and auditable provisioning mechanism. The following command provisions a 19c VM DB System:

\`\`\`bash
oci db system launch \\
  --availability-domain "IwGV:PHX-AD-1" \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --subnet-id "ocid1.subnet.oc1..aaaaaa..." \\
  --shape "VM.Standard.E4.Flex" \\
  --shape-config '{"ocpuCount": 8, "memoryInGBs": 128}' \\
  --hostname-prefix "ebsdb" \\
  --database-edition "ENTERPRISE_EDITION_EXTREME_PERFORMANCE" \\
  --cpu-core-count 8 \\
  --data-storage-size-in-gbs 2048 \\
  --db-home '{
    "dbVersion": "19.0.0.0",
    "database": {
      "dbName": "EBSPRD",
      "pdbName": "EBSPRD",
      "adminPassword": "<vault-retrieved-password>",
      "dbWorkload": "OLTP",
      "characterSet": "AL32UTF8",
      "ncharacterSet": "AL16UTF16"
    }
  }' \\
  --fault-domain "FAULT-DOMAIN-1" \\
  --node-count 1 \\
  --display-name "EBS-PRD-DB-01" \\
  --license-model "BRING_YOUR_OWN_LICENSE"
\`\`\`

Key parameters to understand:

**\`--database-edition\`**: EBS 12.2 requires Oracle Database Enterprise Edition. The \`ENTERPRISE_EDITION_EXTREME_PERFORMANCE\` edition includes all Enterprise Edition options, which you need for Partitioning (if used), Advanced Compression (for backup efficiency), and the Oracle Advanced Security TDE option (mandatory if the instance handles regulated data). If you have Oracle EE licenses with specific options, use \`ENTERPRISE_EDITION\` and add only the options you're licensed for.

**\`--license-model\`**: \`BRING_YOUR_OWN_LICENSE\` applies if you have existing Oracle Database EE licenses covered under your Universal License Agreement. \`LICENSE_INCLUDED\` is the hourly license model — more expensive per hour but requires no existing license entitlement.

**\`pdbName\`**: EBS 12.2.0 is a non-CDB (non-container database) by default. From EBS 12.2.10 onward, Oracle supports and recommends a pluggable database (PDB) configuration. If you are deploying EBS 12.2.10 or later with the PDB-enabled configuration (following Oracle Doc ID 2774025.1), specify the \`pdbName\`. For earlier 12.2 releases without the PDB configuration, leave \`pdbName\` blank and specify only \`dbName\`.

**\`--fault-domain\`**: Always specify this explicitly. If you omit it, OCI places the resource in Fault Domain 1 by default, which concentrates risk.

### Post-Provisioning Database Configuration

After the DB System is provisioned, OCI has created the Oracle Home, Grid Infrastructure, listener, and the initial database. Several configuration items must be adjusted before EBS installation:

**Verify character set:** EBS 12.2 requires \`AL32UTF8\` for the database character set. Confirm:

\`\`\`sql
SELECT value FROM nls_database_parameters WHERE parameter = 'NLS_CHARACTERSET';
-- Expected: AL32UTF8

SELECT value FROM nls_database_parameters WHERE parameter = 'NLS_NCHAR_CHARACTERSET';
-- Expected: AL16UTF16
\`\`\`

**Check db_block_size:** EBS requires \`db_block_size = 8192\`. OCI provisions with 8K blocks by default.

\`\`\`sql
SHOW PARAMETER db_block_size;
-- Expected: 8192
\`\`\`

**Configure the listener for EBS services:** EBS uses two database services — a primary service and a restricted service used during patching (ADOP). These services need to be registered with the listener. On OCI DB Systems, you can add services through Grid Infrastructure:

\`\`\`bash
# SSH to the DB System node as the opc user, then sudo to oracle
sudo su - oracle

# Add the EBS primary database service
srvctl add service -d EBSPRD -s EBSPRD -r EBSPRD

# Add the EBS restricted service for ADOP
srvctl add service -d EBSPRD -s EBSPRDR -r EBSPRD

# Start both services
srvctl start service -d EBSPRD -s EBSPRD
srvctl start service -d EBSPRD -s EBSPRDR

# Verify
srvctl status service -d EBSPRD
\`\`\`

**Set the mandatory init.ora parameters for EBS 12.2:**

Connect as SYSDBA and apply the required parameter changes:

\`\`\`sql
-- EBS 12.2 mandatory parameters
ALTER SYSTEM SET aq_tm_processes=1 SCOPE=BOTH;
ALTER SYSTEM SET db_securefile=PERMITTED SCOPE=BOTH;
ALTER SYSTEM SET enable_goldengate_replication=TRUE SCOPE=BOTH;  -- If GoldenGate will be used
ALTER SYSTEM SET open_cursors=600 SCOPE=BOTH;
ALTER SYSTEM SET session_cached_cursors=200 SCOPE=BOTH;
ALTER SYSTEM SET undo_management=AUTO SCOPE=SPFILE;
ALTER SYSTEM SET undo_tablespace=UNDOTBS1 SCOPE=SPFILE;
ALTER SYSTEM SET nls_language='AMERICAN' SCOPE=SPFILE;
ALTER SYSTEM SET nls_territory='AMERICA' SCOPE=SPFILE;
ALTER SYSTEM SET nls_date_format='DD-MON-RR' SCOPE=SPFILE;
ALTER SYSTEM SET nls_numeric_characters='.,' SCOPE=SPFILE;
ALTER SYSTEM SET cursor_sharing=EXACT SCOPE=BOTH;
ALTER SYSTEM SET max_string_size=STANDARD SCOPE=SPFILE;

-- Memory parameters (adjust for your shape)
ALTER SYSTEM SET sga_target=48G SCOPE=SPFILE;
ALTER SYSTEM SET pga_aggregate_target=16G SCOPE=SPFILE;
ALTER SYSTEM SET memory_target=0 SCOPE=SPFILE;  -- Disable AMM, use ASMM
\`\`\`

The \`cursor_sharing=EXACT\` setting is mandatory for EBS. EBS PL/SQL packages emit SQL with literal values intentionally, and the application's SQL management relies on exact text matching for cursor sharing. Setting \`FORCE\` causes unpredictable behavior in EBS because bind variable peeking interacts poorly with EBS's cursor management in high-volume batch processing.

---

## Provisioning the EBS 12.2 Application Tier (Mid-Tier)

The EBS mid-tier is the application server layer: Oracle HTTP Server (OHS, based on Apache), Oracle WebLogic Server, and the OAFM (Oracle Application Framework Management) managed server that handles Forms and Self-Service pages. In a cloud deployment, you provision one or more compute instances to host this tier, then install EBS's application services on them.

### Compute Instance Shape Selection

The application tier is primarily CPU and memory bound, with I/O needs centered on the $APPL_TOP filesystem reads (shared library code, form files, reports) and temporary processing. Choose a shape that matches EBS's threading model:

- **Shape:** \`VM.Standard.E4.Flex\` with 4–8 OCPUs and 64 GB memory for a single-node app tier
- **For multi-node (load-balanced):** Two \`VM.Standard.E4.Flex\` instances, each with 4 OCPUs and 64 GB memory

EBS WebLogic managed servers are multithreaded, and each WebLogic thread pool consumes memory proportional to its stack size and the number of concurrent sessions. For a production EBS instance handling 200–500 concurrent users, 64 GB per app tier node is a reasonable starting point. Monitor JVM heap utilization in the first 4 weeks and resize (OCI allows live OCPU/memory scaling on Flex shapes) based on actual consumption.

### Compute Instance Provisioning

\`\`\`bash
# Node 1 - Fault Domain 2
oci compute instance launch \\
  --availability-domain "IwGV:PHX-AD-1" \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --subnet-id "ocid1.subnet.oc1.phx.app.aaaaaa..." \\
  --shape "VM.Standard.E4.Flex" \\
  --shape-config '{"ocpuCount": 8, "memoryInGBs": 64}' \\
  --image-id "ocid1.image.oc1.phx.ol8.aaaaaa..." \\
  --fault-domain "FAULT-DOMAIN-2" \\
  --display-name "EBS-APP-01" \\
  --hostname-label "ebsapp01" \\
  --ssh-authorized-keys-file ~/.ssh/id_rsa.pub \\
  --boot-volume-size-in-gbs 200 \\
  --assign-public-ip false

# Node 2 - Fault Domain 3
oci compute instance launch \\
  --availability-domain "IwGV:PHX-AD-1" \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --subnet-id "ocid1.subnet.oc1.phx.app.aaaaaa..." \\
  --shape "VM.Standard.E4.Flex" \\
  --shape-config '{"ocpuCount": 8, "memoryInGBs": 64}' \\
  --image-id "ocid1.image.oc1.phx.ol8.aaaaaa..." \\
  --fault-domain "FAULT-DOMAIN-3" \\
  --display-name "EBS-APP-02" \\
  --hostname-label "ebsapp02" \\
  --ssh-authorized-keys-file ~/.ssh/id_rsa.pub \\
  --boot-volume-size-in-gbs 200 \\
  --assign-public-ip false
\`\`\`

**Image selection:** Use the Oracle-provided Oracle Linux 8 (OL8) platform image. EBS 12.2 is certified on OL7 and OL8. The OL8 images pre-configure SELinux, kernel parameters, and \`/etc/security/limits.conf\` with values appropriate for Oracle workloads. Start with Oracle Linux because OCI's DB Systems run Oracle Linux, and Oracle Support troubleshooting assumes OS consistency between DB and app tiers.

### Storage Layout for the Application Tier

EBS 12.2 distributes its filesystem across several mount points. On OCI, attach block volumes for each:

| Mount Point | Size | Purpose |
|---|---|---|
| \`/u01\` | 500 GB | Oracle software homes ($ORACLE_HOME for FMW, $ORACLE_HOME for DB client) |
| \`/u02\` | 1 TB | EBS application top ($APPL_TOP, $COMMON_TOP) |
| \`/u03\` | 500 GB | EBS data files (concurrent output, attachments) |
| Boot | 200 GB | OS, swap, Oracle Inventory |

Attach and format block volumes on each app node:

\`\`\`bash
# Attach the /u01 block volume (repeat for each volume)
oci compute volume-attachment attach \\
  --instance-id "ocid1.instance.oc1..app01.aaaaaa..." \\
  --type paravirtualized \\
  --volume-id "ocid1.volume.oc1..u01.aaaaaa..." \\
  --is-read-only false

# On the instance OS (after attaching):
sudo mkfs.xfs /dev/oracleoci/oraclevdb
sudo mkdir -p /u01
echo '/dev/oracleoci/oraclevdb /u01 xfs defaults,noatime 0 2' | sudo tee -a /etc/fstab
sudo mount -a
\`\`\`

Use **XFS** for the EBS filesystem mount points. XFS handles the mixed workload of EBS (many small concurrent reads for Java class files and form definitions, large sequential writes for concurrent program output) better than ext4 at the block sizes EBS generates. Oracle's own documentation recommends XFS for Oracle Linux application tier deployments.

### OS Prerequisites for EBS 12.2

Before running the EBS installer (RapidInstall or cloning from an existing instance), the OS must meet specific prerequisites. Run these on both app nodes:

\`\`\`bash
# Install required OS packages
sudo dnf install -y \\
  binutils compat-libcap1 compat-libstdc++-33 gcc gcc-c++ glibc glibc-devel \\
  ksh libaio libaio-devel libgcc libstdc++ libstdc++-devel libXi libXtst \\
  make sysstat unzip zip wget curl nfs-utils

# Set kernel parameters
cat >> /etc/sysctl.conf << 'EOF'
fs.file-max = 6815744
kernel.shmmax = 68719476736
kernel.shmall = 4294967296
kernel.shmmni = 4096
kernel.sem = 250 32000 100 128
net.ipv4.ip_local_port_range = 9000 65500
net.core.rmem_default = 262144
net.core.rmem_max = 4194304
net.core.wmem_default = 262144
net.core.wmem_max = 1048586
fs.aio-max-nr = 1048576
EOF
sysctl -p

# Set OS user limits for oracle and applmgr
cat >> /etc/security/limits.conf << 'EOF'
oracle   soft   nofile   65536
oracle   hard   nofile   65536
oracle   soft   nproc    16384
oracle   hard   nproc    16384
applmgr  soft   nofile   65536
applmgr  hard   nofile   65536
applmgr  soft   nproc    16384
applmgr  hard   nproc    16384
EOF

# Create OS users
groupadd -g 1000 dba
groupadd -g 1001 oinstall
useradd -u 1100 -g oinstall -G dba -m oracle
useradd -u 1101 -g oinstall -G dba -m applmgr
\`\`\`

The \`oracle\` OS user owns the database client Oracle Home on the app tier. The \`applmgr\` OS user owns the EBS application software ($APPL_TOP, $FMW_HOME, $OHS_INSTANCE_HOME). This separation is the Oracle-recommended ownership model for EBS 12.2 and allows independent software maintenance on each layer.

---

## Load Balancing in OCI: Architecture for EBS 12.2

OCI provides a managed load balancer service — the **OCI Load Balancer** — that runs in the load balancer subnet and distributes inbound connections across the EBS application tier nodes. For EBS 12.2, the load balancer's job is:

1. Terminate TLS (HTTPS) from users
2. Forward decrypted HTTP to OHS on the app nodes (or re-encrypt in TLS passthrough mode)
3. Distribute requests across app nodes based on configured load balancing policy
4. Health-check OHS on each node and remove failed nodes from the backend set automatically

### Why EBS Load Balancing Is Not Trivial

EBS 12.2 uses both stateless and stateful request patterns, and the load balancer must handle both correctly.

**Oracle HTTP Server requests** (OAF pages, Self-Service modules, SSWA) are effectively stateless at the HTTP level — each page request carries sufficient context in the URL and cookies. These requests can be load-balanced across any OHS node using round-robin.

**Oracle Forms sessions** are stateful and long-lived. An EBS Forms session maintains a persistent connection from the user's browser (via the Forms Java applet or HTML5 Forms client) to a specific OHS listener socket, which forwards to a specific Forms server process on a specific app node. If the load balancer breaks this connection mid-session (because it selected a different backend for a subsequent request in the same session), the Forms session corrupts.

The correct load balancing policy for EBS Forms is **session persistence (sticky sessions)** using cookie-based affinity. The OCI Load Balancer's cookie-based session persistence inserts a session cookie on the first request and routes all subsequent requests from that session to the same backend node.

### OCI Load Balancer Configuration

**Create the load balancer:**

\`\`\`bash
oci lb load-balancer create \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --display-name "EBS-PRD-LB" \\
  --shape-name "flexible" \\
  --shape-details '{"minimumBandwidthInMbps": 100, "maximumBandwidthInMbps": 1000}' \\
  --subnet-ids '["ocid1.subnet.oc1.phx.lb.aaaaaa..."]' \\
  --is-private false
\`\`\`

The **Flexible** load balancer shape is the correct choice for EBS. It scales bandwidth automatically between your specified minimum and maximum without requiring a shape change. The alternative (predefined shapes like 100 Mbps, 400 Mbps, 8 Gbps) require a shape change operation if you need to adjust bandwidth, which causes a brief interruption.

**Create the backend set (OHS nodes on port 8000):**

\`\`\`bash
oci lb backend-set create \\
  --load-balancer-id "ocid1.loadbalancer.oc1..aaaaaa..." \\
  --name "ebs-ohs-backend-set" \\
  --policy "ROUND_ROBIN" \\
  --health-checker '{
    "protocol": "HTTP",
    "urlPath": "/OA_HTML/AppsLocalLogin.jsp",
    "port": 8000,
    "returnCode": 200,
    "intervalInMillis": 10000,
    "timeoutInMillis": 3000,
    "retries": 3
  }' \\
  --session-persistence-configuration '{
    "cookieName": "EBSLBSESSION",
    "disableFallback": false
  }'
\`\`\`

The health check URL (\`/OA_HTML/AppsLocalLogin.jsp\`) is the EBS login page. If OHS is running and EBS is reachable, this URL returns HTTP 200. If OHS is down, the DB is unreachable, or EBS is in restricted mode, the health check fails and the load balancer stops sending traffic to that node. This is a functional health check, not just a TCP port check — it validates the full OHS-to-WLS-to-DB path.

**Add the app tier nodes as backends:**

\`\`\`bash
# Add App Node 1
oci lb backend create \\
  --load-balancer-id "ocid1.loadbalancer.oc1..aaaaaa..." \\
  --backend-set-name "ebs-ohs-backend-set" \\
  --ip-address "10.10.2.11" \\
  --port 8000 \\
  --weight 1 \\
  --backup false

# Add App Node 2
oci lb backend create \\
  --load-balancer-id "ocid1.loadbalancer.oc1..aaaaaa..." \\
  --backend-set-name "ebs-ohs-backend-set" \\
  --ip-address "10.10.2.12" \\
  --port 8000 \\
  --weight 1 \\
  --backup false
\`\`\`

**Create the HTTPS listener (port 443):**

\`\`\`bash
# First, upload your SSL certificate to OCI Certificates service
oci certs-mgmt certificate create-by-importing-config \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --name "ebs-prd-ssl-cert" \\
  --config-type IMPORTED \\
  --certificate-pem-file ebs-prd.crt \\
  --private-key-pem-file ebs-prd.key \\
  --cert-chain-pem-file ebs-prd-chain.crt

# Create the HTTPS listener referencing the SSL certificate
oci lb listener create \\
  --load-balancer-id "ocid1.loadbalancer.oc1..aaaaaa..." \\
  --name "ebs-https-listener" \\
  --default-backend-set-name "ebs-ohs-backend-set" \\
  --port 443 \\
  --protocol "HTTPS" \\
  --ssl-configuration '{
    "certificateName": "ebs-prd-ssl-cert",
    "verifyDepth": 0,
    "verifyPeerCertificate": false
  }'

# Create HTTP listener for redirect to HTTPS
oci lb listener create \\
  --load-balancer-id "ocid1.loadbalancer.oc1..aaaaaa..." \\
  --name "ebs-http-listener" \\
  --default-backend-set-name "ebs-ohs-backend-set" \\
  --port 80 \\
  --protocol "HTTP"
\`\`\`

**Configure HTTP-to-HTTPS redirect using a rule set:**

\`\`\`bash
oci lb rule-set create \\
  --load-balancer-id "ocid1.loadbalancer.oc1..aaaaaa..." \\
  --name "https-redirect-rules" \\
  --items '[{
    "action": "REDIRECT",
    "redirectUri": {
      "protocol": "HTTPS",
      "host": "{host}",
      "port": 443,
      "path": "{path}",
      "query": "{query}"
    },
    "responseCode": 301,
    "conditions": [{
      "attributeName": "PATH",
      "operator": "FORCE_LONGEST_PREFIX_MATCH",
      "attributeValue": "/"
    }]
  }]'
\`\`\`

### EBS Configuration for Load Balancer

Once the OCI Load Balancer is provisioned, the EBS application tier must be configured to know the load balancer's hostname and port. EBS uses AutoConfig to manage URL profiles and hostname references.

On each app node, update the AutoConfig context file (\`$CONTEXT_FILE\`) with the load balancer's DNS name:

\`\`\`xml
<!-- In $CONTEXT_FILE (Context_<hostname>.xml) -->
<oa_var name="s_webentryhost" value="ebs-prod.example.com" />
<oa_var name="s_webentrydomain" value="example.com" />
<oa_var name="s_webentryurlport" value="443" />
<oa_var name="s_active_webport" value="8000" />
<oa_var name="s_login_page" value="https://ebs-prod.example.com/OA_HTML/AppsLocalLogin.jsp" />
\`\`\`

After updating the context file, run AutoConfig on each node:

\`\`\`bash
source /u01/applmgr/EBSPRD/EBSprd_appnode01.env
perl $AD_TOP/bin/adconfig.pl contextfile=$CONTEXT_FILE logfile=$APPL_TOP/admin/log/autoconfig_$(date +%Y%m%d_%H%M).log
\`\`\`

AutoConfig regenerates the Oracle HTTP Server configuration (\`httpd.conf\`, \`apps.conf\`), the WebLogic configuration (\`config.xml\`), and the EBS profile values that store the application URL. After AutoConfig completes, bounce the application services:

\`\`\`bash
# Stop
$ADMIN_SCRIPTS_HOME/adstpall.sh apps/<apps_password>

# Start
$ADMIN_SCRIPTS_HOME/adstrtal.sh apps/<apps_password>
\`\`\`

---

## Data Guard Configuration for Database HA

With the primary DB System in AD-1 and the standby DB System in AD-2, OCI's **Data Guard Association** feature configures Oracle Data Guard between them. This is an OCI-managed Data Guard configuration — OCI handles the redo log transport configuration, the standby redo logs, and the managed recovery process.

\`\`\`bash
# Create the standby DB System and Data Guard Association in one step
oci db data-guard-association create-with-new-db-system \\
  --database-id "ocid1.database.oc1..primary.aaaaaa..." \\
  --protection-mode "MAXIMUM_AVAILABILITY" \\
  --transport-type "ASYNC" \\
  --display-name "EBS-PRD-DG-STANDBY" \\
  --hostname "ebsdbstby" \\
  --availability-domain "IwGV:PHX-AD-2" \\
  --subnet-id "ocid1.subnet.oc1.phx.db.aaaaaa..." \\
  --shape "VM.Standard.E4.Flex" \\
  --shape-config '{"ocpuCount": 8, "memoryInGBs": 128}' \\
  --fault-domain "FAULT-DOMAIN-1"
\`\`\`

**\`MAXIMUM_AVAILABILITY\` with \`ASYNC\` transport**: This configuration commits transactions on the primary without waiting for the standby to acknowledge receipt (ASYNC). It is the correct mode for cross-AD or cross-region Data Guard when network latency is a factor. The tradeoff is a small potential data loss window (seconds, bounded by the \`log_archive_dest\` lag) compared to \`MAXIMUM_PROTECTION\` (synchronous commit, zero data loss, but primary performance affected by network round-trip to standby). For EBS 12.2 with an intra-region standby, ASYNC provides a Recovery Point Objective of seconds to minutes with no primary-side performance penalty.

---

## Putting It Together: The Full HA Architecture

The completed architecture positions every component for fault isolation and load distribution:

\`\`\`
Internet
    │
    ▼
OCI Load Balancer (Public IP, Port 443)
  ├── HTTPS Listener → Backend Set (cookie-based sticky sessions)
  ├── Health Check: GET /OA_HTML/AppsLocalLogin.jsp
  └── SSL Termination (OCI Certificates)
    │
    ├─────────────────────────────────────────┐
    ▼                                         ▼
EBS App Node 1 (PHX-AD-1, FD-2)       EBS App Node 2 (PHX-AD-1, FD-3)
  VM.Standard.E4.Flex 8 OCPU / 64 GB    VM.Standard.E4.Flex 8 OCPU / 64 GB
  OHS (Port 8000) → WLS → OAFM           OHS (Port 8000) → WLS → OAFM
    │                                         │
    └──────────────┬──────────────────────────┘
                   │  DB connection via TNS (Port 1521)
                   ▼
    Oracle 19c DB System (PHX-AD-1, FD-1)
      VM.Standard.E4.Flex 8 OCPU / 128 GB
      Data Guard Primary
                   │
                   │  Redo log shipping (ASYNC, port 1521)
                   ▼
    Oracle 19c DB System (PHX-AD-2, FD-1)
      VM.Standard.E4.Flex 8 OCPU / 128 GB
      Data Guard Standby (Managed Recovery)
\`\`\`

The failure scenarios this architecture handles:

**Single app node failure (FD-2 hardware fault):** EBS App Node 1 goes offline. The load balancer's health check detects OHS is unreachable within 30 seconds (3 retries × 10-second interval). The load balancer removes App Node 1 from the backend set. All traffic routes to App Node 2. Active Forms sessions on App Node 1 are lost — users must reconnect. OAF sessions reconnect transparently due to cookie-based affinity resetting to the surviving node.

**Entire AD-1 failure:** The primary database and both app nodes are offline. EBS is unavailable. Data Guard on the standby in AD-2 detects the primary is gone and can be failed over (manually or automatically via Observer) to become the new primary. New app nodes must be provisioned in AD-2 and pointed at the new primary before EBS is accessible again. For automatic failover of the application tier, consider OCI Instance Pools with autoscaling across ADs.

**Database node failure (FD-1 hardware fault within AD-1):** OCI DB Systems on a single-node configuration do not automatically failover — the DB System will restart the instance on a surviving host within the same Fault Domain assignment. For automatic DB-level failover without Data Guard switchover, provision a 2-node RAC DB System rather than a single-node DB System.

---

## Monitoring and Alerting

OCI provides native monitoring for DB Systems and Load Balancers through the **Monitoring** service. Create alarms for:

**DB System alarms:**
- \`CpuUtilization > 80%\` for 5 minutes → notify DBA team
- \`StorageUtilization > 85%\` → notify DBA team immediately
- \`DataGuardLag > 300\` seconds → escalate (standby is falling behind)

**Load Balancer alarms:**
- \`BackendHttpRequests5xx > 50\` per minute → investigate OHS/WLS errors
- \`UnhealthyBackendCount > 0\` → at least one app node is offline
- \`ResponseTimeMs > 5000\` → EBS response time degraded

**Compute Instance alarms (app nodes):**
- \`CpuUtilization > 90%\` for 10 minutes → WebLogic thread pool saturation
- \`MemoryUtilization > 85%\` → JVM heap pressure, consider GC analysis

\`\`\`bash
# Example: Create alarm for unhealthy load balancer backends
oci monitoring alarm create \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --display-name "EBS-LB-Unhealthy-Backend" \\
  --metric-compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --namespace "oci_lbaas" \\
  --query-string "UnhealthyBackendCount[1m].max() > 0" \\
  --severity "CRITICAL" \\
  --destinations '["ocid1.onstopic.oc1..aaaaaa..."]' \\
  --is-enabled true
\`\`\`

---

## Summary

Provisioning Oracle Database 19c and EBS 12.2 in OCI for high availability is a structured process where the sequence of decisions matters: network design and subnet layout must precede compute provisioning, DB System provisioning must precede application tier installation, and load balancer configuration must be completed before AutoConfig runs on the application nodes.

The OCI Availability Domain and Fault Domain model maps directly to Oracle's HA recommendations: primary database and application nodes in the same AD (to minimize latency) but spread across Fault Domains (to isolate rack-level failures), with the Data Guard standby in a separate AD (to survive site-level failures). The OCI Load Balancer's flexible shape with cookie-based session persistence satisfies both EBS Forms session stickiness and OAF stateless request distribution.

Character set (\`AL32UTF8\`), \`db_block_size\` (8192), \`cursor_sharing=EXACT\`, and the two-service listener configuration (primary service and restricted ADOP service) are the database configuration items most likely to surface as issues during EBS installation if not addressed immediately after DB System provisioning. The OS prerequisites on the application tier — kernel parameters, user limits, XFS mount points, and the \`oracle\`/\`applmgr\` user separation — are equally mandatory before the EBS installer runs.

The architecture described here provides a Recovery Time Objective measured in minutes for node-level failures and a Recovery Point Objective measured in seconds for database-level failures with Data Guard ASYNC transport. Extending to zero-RPO requires switching Data Guard to MAXIMUM_PROTECTION with synchronous transport, which adds a latency requirement on the inter-AD network that must be validated before production cut-over.
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'Provisioning Oracle Database 19c and EBS 12.2 in Oracle Cloud: Availability Domains, Load Balancing, and High Availability Architecture',
    slug,
    excerpt: 'Oracle Cloud Infrastructure was designed from the ground up for Oracle workloads. This post covers the OCI Availability Domain and Fault Domain model, provisioning a 19c DB System with the correct EBS character set and parameter configuration, provisioning EBS 12.2 application tier compute nodes with the correct storage layout and OS prerequisites, and configuring the OCI Load Balancer with cookie-based session persistence for EBS Forms. Includes Data Guard cross-AD configuration, VCN subnet design, security list rules, and the full AutoConfig integration for the load balancer hostname.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
