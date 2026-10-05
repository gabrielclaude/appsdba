import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';

const slug = 'oracle-19c-ebs-122-oci-provisioning-availability-zones-load-balancing-runbook';

const content = `
This runbook covers the complete provisioning sequence for Oracle Database 19c and Oracle E-Business Suite 12.2 in Oracle Cloud Infrastructure with high availability. It is organized as sequential phases with explicit verification steps, includes the \`oci_ebs_health_check.sh\` script for post-provisioning validation and ongoing monitoring, and provides troubleshooting procedures for the most common provisioning failures.

---

## Phase 1: Pre-Provisioning Checklist

Complete all items in this phase before creating any OCI resource. Provisioning failures traced back to service limits, missing IAM policies, or VCN CIDR conflicts cost significantly more time to unwind than the few minutes this checklist requires.

### 1.1 Verify OCI service limits

\`\`\`bash
# Check DB System service limit in the target compartment and AD
oci limits value list \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --service-name "database" \\
  --query "data[?name=='vm-db-system-count']" \\
  --output table

# Check compute instance limits for the shape
oci limits value list \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --service-name "compute" \\
  --query "data[?contains(name,'standard-e4-flex-ocpu-count')]" \\
  --output table

# Check block volume limits (in TBs)
oci limits value list \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --service-name "block-storage" \\
  --query "data[?name=='total-storage-gb']" \\
  --output table
\`\`\`

Compare the available limit against the planned allocation. If limits are insufficient, file a service limit increase request through the OCI console (Support → Limits) before proceeding — increases typically take 1–3 business days.

### 1.2 Verify IAM policies

The OCI user account or instance principal executing the provisioning commands requires the following policies in the target compartment:

\`\`\`
Allow group DBAdmins to manage db-systems in compartment ebs-prd
Allow group DBAdmins to manage db-homes in compartment ebs-prd
Allow group DBAdmins to manage databases in compartment ebs-prd
Allow group DBAdmins to manage virtual-network-family in compartment ebs-prd
Allow group DBAdmins to manage instance-family in compartment ebs-prd
Allow group DBAdmins to manage volume-family in compartment ebs-prd
Allow group DBAdmins to manage load-balancers in compartment ebs-prd
Allow group DBAdmins to manage certificates in compartment ebs-prd
Allow group DBAdmins to manage data-guard-associations in compartment ebs-prd
\`\`\`

Verify the policy is active:

\`\`\`bash
oci iam policy list \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --query "data[?contains(statements[0],'DBAdmins')].{name:name}" \\
  --output table
\`\`\`

### 1.3 Confirm target Availability Domain names

OCI AD names are region-specific and not predictable. Retrieve them before scripting:

\`\`\`bash
oci iam availability-domain list \\
  --compartment-id "ocid1.tenancy.oc1..aaaaaa..." \\
  --output table
\`\`\`

Sample output for \`us-phoenix-1\`:
\`\`\`
IwGV:PHX-AD-1
IwGV:PHX-AD-2
IwGV:PHX-AD-3
\`\`\`

Record the exact AD name strings — you will pass them verbatim to provisioning commands.

### 1.4 Plan and record IP allocations

Before VCN creation, record the full IP plan in a change record or runbook entry:

| Resource | Planned IP | Hostname |
|---|---|---|
| DB Node Primary | 10.10.1.11 | ebsdb01 |
| DB Node Standby | 10.10.1.21 | ebsdbstby01 |
| App Node 1 | 10.10.2.11 | ebsapp01 |
| App Node 2 | 10.10.2.12 | ebsapp02 |
| Load Balancer | public IP | ebs-prod.example.com |

IP conflicts discovered after provisioning (especially when connecting to on-premises via FastConnect or VPN) require reprovisioning — confirm the CIDR does not overlap with any existing connected network.

---

## Phase 2: Network Provisioning

### 2.1 Create the VCN

\`\`\`bash
VCN_ID=\$(oci network vcn create \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --display-name "vcn-ebs-prd" \\
  --cidr-block "10.10.0.0/16" \\
  --dns-label "ebsprd" \\
  --query "data.id" --raw-output)

echo "VCN ID: \${VCN_ID}"
\`\`\`

### 2.2 Create the Internet Gateway and NAT Gateway

\`\`\`bash
# Internet Gateway (for load balancer subnet outbound and inbound)
IGW_ID=\$(oci network internet-gateway create \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --vcn-id "\${VCN_ID}" \\
  --display-name "igw-ebs-prd" \\
  --is-enabled true \\
  --query "data.id" --raw-output)

# NAT Gateway (for private subnet outbound to internet/Oracle repos)
NAT_ID=\$(oci network nat-gateway create \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --vcn-id "\${VCN_ID}" \\
  --display-name "nat-ebs-prd" \\
  --query "data.id" --raw-output)
\`\`\`

### 2.3 Create route tables

\`\`\`bash
# Public route table (for LB subnet)
RT_PUBLIC_ID=\$(oci network route-table create \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --vcn-id "\${VCN_ID}" \\
  --display-name "rt-public" \\
  --route-rules "[{\"networkEntityId\":\"\${IGW_ID}\",\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\"}]" \\
  --query "data.id" --raw-output)

# Private route table (for DB and app subnets)
RT_PRIVATE_ID=\$(oci network route-table create \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --vcn-id "\${VCN_ID}" \\
  --display-name "rt-private" \\
  --route-rules "[{\"networkEntityId\":\"\${NAT_ID}\",\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\"}]" \\
  --query "data.id" --raw-output)
\`\`\`

### 2.4 Create subnets

\`\`\`bash
# DB private subnet (AD-1)
SN_DB_ID=\$(oci network subnet create \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --vcn-id "\${VCN_ID}" \\
  --display-name "sn-db-private" \\
  --cidr-block "10.10.1.0/24" \\
  --availability-domain "IwGV:PHX-AD-1" \\
  --dns-label "ebsdb" \\
  --prohibit-public-ip-on-vnic true \\
  --route-table-id "\${RT_PRIVATE_ID}" \\
  --query "data.id" --raw-output)

# App tier private subnet (AD-1, spans multiple FDs)
SN_APP_ID=\$(oci network subnet create \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --vcn-id "\${VCN_ID}" \\
  --display-name "sn-app-private" \\
  --cidr-block "10.10.2.0/24" \\
  --availability-domain "IwGV:PHX-AD-1" \\
  --dns-label "ebsapp" \\
  --prohibit-public-ip-on-vnic true \\
  --route-table-id "\${RT_PRIVATE_ID}" \\
  --query "data.id" --raw-output)

# Load balancer public subnet (regional, not AD-specific)
SN_LB_ID=\$(oci network subnet create \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --vcn-id "\${VCN_ID}" \\
  --display-name "sn-lb-public" \\
  --cidr-block "10.10.3.0/24" \\
  --dns-label "ebslb" \\
  --prohibit-public-ip-on-vnic false \\
  --route-table-id "\${RT_PUBLIC_ID}" \\
  --query "data.id" --raw-output)

# Admin/bastion subnet (AD-3)
SN_ADMIN_ID=\$(oci network subnet create \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --vcn-id "\${VCN_ID}" \\
  --display-name "sn-admin" \\
  --cidr-block "10.10.4.0/24" \\
  --availability-domain "IwGV:PHX-AD-3" \\
  --dns-label "ebsadmin" \\
  --prohibit-public-ip-on-vnic true \\
  --route-table-id "\${RT_PRIVATE_ID}" \\
  --query "data.id" --raw-output)
\`\`\`

### 2.5 Configure Security Lists

\`\`\`bash
# Get the default security list of the VCN to update
DEFAULT_SL_ID=\$(oci network security-list list \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --vcn-id "\${VCN_ID}" \\
  --query "data[0].id" --raw-output)

# Create DB subnet security list
oci network security-list create \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --vcn-id "\${VCN_ID}" \\
  --display-name "sl-db-private" \\
  --ingress-security-rules '[
    {"source":"10.10.2.0/24","protocol":"6","tcpOptions":{"destinationPortRange":{"min":1521,"max":1521}},"isStateless":false,"description":"App tier to DB listener"},
    {"source":"10.10.4.0/24","protocol":"6","tcpOptions":{"destinationPortRange":{"min":1521,"max":1521}},"isStateless":false,"description":"Admin to DB"},
    {"source":"10.10.4.0/24","protocol":"6","tcpOptions":{"destinationPortRange":{"min":22,"max":22}},"isStateless":false,"description":"Bastion SSH to DB"},
    {"source":"10.10.1.0/24","protocol":"all","isStateless":false,"description":"Intra-DB subnet (ASM SCAN VIP)"}
  ]' \\
  --egress-security-rules '[
    {"destination":"0.0.0.0/0","protocol":"all","isStateless":false,"description":"Outbound via NAT"}
  ]'

# Create App tier security list
oci network security-list create \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --vcn-id "\${VCN_ID}" \\
  --display-name "sl-app-private" \\
  --ingress-security-rules '[
    {"source":"10.10.3.0/24","protocol":"6","tcpOptions":{"destinationPortRange":{"min":8000,"max":8000}},"isStateless":false,"description":"LB to OHS"},
    {"source":"10.10.3.0/24","protocol":"6","tcpOptions":{"destinationPortRange":{"min":4443,"max":4443}},"isStateless":false,"description":"LB to OHS SSL"},
    {"source":"10.10.4.0/24","protocol":"6","tcpOptions":{"destinationPortRange":{"min":22,"max":22}},"isStateless":false,"description":"Bastion SSH"},
    {"source":"10.10.2.0/24","protocol":"all","isStateless":false,"description":"Intra-app (WLS cluster)"}
  ]' \\
  --egress-security-rules '[
    {"destination":"10.10.1.0/24","protocol":"6","tcpOptions":{"destinationPortRange":{"min":1521,"max":1521}},"isStateless":false,"description":"App to DB"},
    {"destination":"0.0.0.0/0","protocol":"all","isStateless":false,"description":"Outbound via NAT"}
  ]'
\`\`\`

Verification after subnet creation:

\`\`\`bash
oci network subnet list \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --vcn-id "\${VCN_ID}" \\
  --output table \\
  --query "data[*].{Name:\"display-name\",CIDR:\"cidr-block\",State:\"lifecycle-state\"}"
\`\`\`

Expected: all four subnets in \`AVAILABLE\` state.

---

## Phase 3: Database System Provisioning

### 3.1 Store the DB admin password in OCI Vault (recommended)

\`\`\`bash
# Create a Vault secret for the DB admin password
oci vault secret create-base64 \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --vault-id "ocid1.vault.oc1..aaaaaa..." \\
  --key-id "ocid1.key.oc1..aaaaaa..." \\
  --secret-name "ebs-db-admin-password" \\
  --secret-content-content "\$(echo -n 'YourStrongPassword1#' | base64)"

# Retrieve for use in scripts (never hardcode inline)
DB_PASS=\$(oci secrets secret-bundle get \\
  --secret-id "ocid1.vaultsecret.oc1..aaaaaa..." \\
  --query "data.\"secret-bundle-content\".content" --raw-output | base64 -d)
\`\`\`

### 3.2 Provision the primary DB System

\`\`\`bash
oci db system launch \\
  --availability-domain "IwGV:PHX-AD-1" \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --subnet-id "\${SN_DB_ID}" \\
  --shape "VM.Standard.E4.Flex" \\
  --shape-config '{"ocpuCount": 8, "memoryInGBs": 128}' \\
  --hostname-prefix "ebsdb" \\
  --database-edition "ENTERPRISE_EDITION_EXTREME_PERFORMANCE" \\
  --data-storage-size-in-gbs 2048 \\
  --db-home "{
    \"dbVersion\": \"19.0.0.0\",
    \"database\": {
      \"dbName\": \"EBSPRD\",
      \"adminPassword\": \"\${DB_PASS}\",
      \"dbWorkload\": \"OLTP\",
      \"characterSet\": \"AL32UTF8\",
      \"ncharacterSet\": \"AL16UTF16\"
    }
  }" \\
  --fault-domain "FAULT-DOMAIN-1" \\
  --node-count 1 \\
  --display-name "EBS-PRD-DB-01" \\
  --license-model "BRING_YOUR_OWN_LICENSE" \\
  --ssh-public-keys "[\"ssh-rsa AAAA...\"]"
\`\`\`

### 3.3 Wait for DB System to reach AVAILABLE state

\`\`\`bash
DB_SYSTEM_ID="ocid1.dbsystem.oc1..aaaaaa..."  # from launch output

until oci db system get --db-system-id "\${DB_SYSTEM_ID}" \\
  --query "data.\"lifecycle-state\"" --raw-output | grep -q "AVAILABLE"; do
  echo "Waiting for DB System... \$(date '+%H:%M:%S')"
  sleep 60
done
echo "DB System AVAILABLE: \$(date)"
\`\`\`

Typical provisioning time: 20–40 minutes.

### 3.4 Verify character set and block size

SSH to the DB node as opc, then sudo to oracle:

\`\`\`bash
ssh -i ~/.ssh/id_rsa opc@<db_node_ip>
sudo su - oracle
sqlplus / as sysdba << 'EOF'
SET LINESIZE 120
SELECT name, value FROM nls_database_parameters
WHERE  name IN ('NLS_CHARACTERSET','NLS_NCHAR_CHARACTERSET','NLS_LANGUAGE','NLS_TERRITORY');
SHOW PARAMETER db_block_size;
SHOW PARAMETER db_name;
SELECT open_mode, database_role FROM v\$database;
EXIT;
EOF
\`\`\`

Expected values:

| Parameter | Expected |
|---|---|
| NLS_CHARACTERSET | AL32UTF8 |
| NLS_NCHAR_CHARACTERSET | AL16UTF16 |
| db_block_size | 8192 |
| open_mode | READ WRITE |

If NLS_CHARACTERSET is not AL32UTF8, the DB System must be re-created — character set cannot be changed post-creation without data loss.

### 3.5 Apply EBS mandatory init.ora parameters

\`\`\`sql
-- Connect as SYSDBA
ALTER SYSTEM SET open_cursors=600             SCOPE=BOTH;
ALTER SYSTEM SET session_cached_cursors=200   SCOPE=BOTH;
ALTER SYSTEM SET cursor_sharing=EXACT         SCOPE=BOTH;
ALTER SYSTEM SET aq_tm_processes=1            SCOPE=BOTH;
ALTER SYSTEM SET db_securefile=PERMITTED      SCOPE=BOTH;
ALTER SYSTEM SET max_string_size=STANDARD     SCOPE=SPFILE;

-- NLS settings (require bounce)
ALTER SYSTEM SET nls_language='AMERICAN'      SCOPE=SPFILE;
ALTER SYSTEM SET nls_territory='AMERICA'      SCOPE=SPFILE;
ALTER SYSTEM SET nls_date_format='DD-MON-RR'  SCOPE=SPFILE;
ALTER SYSTEM SET nls_numeric_characters='.,'  SCOPE=SPFILE;

-- Memory (adjust for your shape — these are for 128 GB)
ALTER SYSTEM SET sga_target=96G               SCOPE=SPFILE;
ALTER SYSTEM SET pga_aggregate_target=24G     SCOPE=SPFILE;
ALTER SYSTEM SET memory_target=0              SCOPE=SPFILE;

-- Undo
ALTER SYSTEM SET undo_management=AUTO         SCOPE=SPFILE;
ALTER SYSTEM SET undo_tablespace=UNDOTBS1     SCOPE=SPFILE;
\`\`\`

Bounce the database to apply SPFILE-only parameters:

\`\`\`bash
srvctl stop database -d EBSPRD
srvctl start database -d EBSPRD
srvctl status database -d EBSPRD
\`\`\`

### 3.6 Register EBS database services

\`\`\`bash
# Add primary EBS service
srvctl add service -d EBSPRD -s EBSPRD -r EBSPRD
srvctl start service -d EBSPRD -s EBSPRD

# Add restricted service for ADOP (online patching)
srvctl add service -d EBSPRD -s EBSPRDR -r EBSPRD
srvctl start service -d EBSPRD -s EBSPRDR

# Verify both services are online
srvctl status service -d EBSPRD

# Verify listener registrations
lsnrctl status | grep -i "EBSPRD\|EBSPRDR"
\`\`\`

Verify tnsnames resolution from the planned app tier subnet:

\`\`\`bash
tnsping EBSPRD
# Expected: OK (N msec)
\`\`\`

---

## Phase 4: Application Tier Provisioning

### 4.1 Provision compute instances

\`\`\`bash
# App Node 1 — Fault Domain 2
APP1_ID=\$(oci compute instance launch \\
  --availability-domain "IwGV:PHX-AD-1" \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --subnet-id "\${SN_APP_ID}" \\
  --shape "VM.Standard.E4.Flex" \\
  --shape-config '{"ocpuCount": 8, "memoryInGBs": 64}' \\
  --image-id "ocid1.image.oc1.phx.ol8.aaaaaa..." \\
  --fault-domain "FAULT-DOMAIN-2" \\
  --display-name "EBS-APP-01" \\
  --hostname-label "ebsapp01" \\
  --ssh-authorized-keys-file ~/.ssh/id_rsa.pub \\
  --boot-volume-size-in-gbs 200 \\
  --assign-public-ip false \\
  --query "data.id" --raw-output)

# App Node 2 — Fault Domain 3
APP2_ID=\$(oci compute instance launch \\
  --availability-domain "IwGV:PHX-AD-1" \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --subnet-id "\${SN_APP_ID}" \\
  --shape "VM.Standard.E4.Flex" \\
  --shape-config '{"ocpuCount": 8, "memoryInGBs": 64}' \\
  --image-id "ocid1.image.oc1.phx.ol8.aaaaaa..." \\
  --fault-domain "FAULT-DOMAIN-3" \\
  --display-name "EBS-APP-02" \\
  --hostname-label "ebsapp02" \\
  --ssh-authorized-keys-file ~/.ssh/id_rsa.pub \\
  --boot-volume-size-in-gbs 200 \\
  --assign-public-ip false \\
  --query "data.id" --raw-output)

echo "App Node 1: \${APP1_ID}"
echo "App Node 2: \${APP2_ID}"
\`\`\`

### 4.2 Attach and format block volumes

Repeat for each node. Variable \`NODE_IP\` is the private IP of the instance.

\`\`\`bash
# Create volumes first
VOL_U01=\$(oci bv volume create \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --availability-domain "IwGV:PHX-AD-1" \\
  --display-name "ebsapp01-u01" \\
  --size-in-gbs 500 \\
  --vpus-per-gb 20 \\
  --query "data.id" --raw-output)

VOL_U02=\$(oci bv volume create \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --availability-domain "IwGV:PHX-AD-1" \\
  --display-name "ebsapp01-u02" \\
  --size-in-gbs 1024 \\
  --vpus-per-gb 20 \\
  --query "data.id" --raw-output)

VOL_U03=\$(oci bv volume create \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --availability-domain "IwGV:PHX-AD-1" \\
  --display-name "ebsapp01-u03" \\
  --size-in-gbs 500 \\
  --vpus-per-gb 10 \\
  --query "data.id" --raw-output)

# Attach paravirtualized (better performance than iSCSI for sequential I/O)
for VOL_ID in \$VOL_U01 \$VOL_U02 \$VOL_U03; do
  oci compute volume-attachment attach \\
    --instance-id "\${APP1_ID}" \\
    --type paravirtualized \\
    --volume-id "\${VOL_ID}" \\
    --is-read-only false
done
\`\`\`

On the instance OS, format and mount (run as root):

\`\`\`bash
# Identify the new devices (typically /dev/oracleoci/oraclevdb, vdc, vdd)
lsblk

# Format as XFS
mkfs.xfs /dev/oracleoci/oraclevdb   # u01
mkfs.xfs /dev/oracleoci/oraclevdc   # u02
mkfs.xfs /dev/oracleoci/oraclevdd   # u03

# Create mount points
mkdir -p /u01 /u02 /u03

# Add to fstab (use device labels for reliability)
xfs_admin -L U01VOL /dev/oracleoci/oraclevdb
xfs_admin -L U02VOL /dev/oracleoci/oraclevdc
xfs_admin -L U03VOL /dev/oracleoci/oraclevdd

cat >> /etc/fstab << 'EOF'
LABEL=U01VOL  /u01  xfs  defaults,noatime,_netdev  0 2
LABEL=U02VOL  /u02  xfs  defaults,noatime,_netdev  0 2
LABEL=U03VOL  /u03  xfs  defaults,noatime,_netdev  0 2
EOF

mount -a
df -h /u01 /u02 /u03
\`\`\`

### 4.3 Apply OS prerequisites

Run as root on both app nodes:

\`\`\`bash
# Required packages
dnf install -y binutils compat-libcap1 gcc gcc-c++ glibc glibc-devel \\
  ksh libaio libaio-devel libgcc libstdc++ libstdc++-devel libXi libXtst \\
  make sysstat unzip zip wget nfs-utils smartmontools

# Kernel parameters
cat > /etc/sysctl.d/99-oracle-ebs.conf << 'EOF'
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
sysctl -p /etc/sysctl.d/99-oracle-ebs.conf

# OS user limits
cat > /etc/security/limits.d/99-oracle-ebs.conf << 'EOF'
oracle   soft   nofile   65536
oracle   hard   nofile   65536
oracle   soft   nproc    16384
oracle   hard   nproc    16384
applmgr  soft   nofile   65536
applmgr  hard   nofile   65536
applmgr  soft   nproc    16384
applmgr  hard   nproc    16384
EOF

# Create OS users and groups
groupadd -g 1000 dba
groupadd -g 1001 oinstall
useradd -u 1100 -g oinstall -G dba -d /home/oracle  -m -s /bin/bash oracle
useradd -u 1101 -g oinstall -G dba -d /home/applmgr -m -s /bin/bash applmgr

# Set ownership on mount points
chown oracle:oinstall /u01
chown applmgr:oinstall /u02 /u03
chmod 755 /u01 /u02 /u03
\`\`\`

Verify prerequisites:

\`\`\`bash
# Confirm kernel parameters applied
sysctl fs.file-max kernel.shmmax kernel.sem | grep -E "6815744|68719476736|250 32000"

# Confirm users exist
id oracle && id applmgr

# Confirm mount points
df -hT /u01 /u02 /u03 | grep xfs
\`\`\`

---

## Phase 5: Load Balancer Provisioning

### 5.1 Create the Load Balancer

\`\`\`bash
LB_ID=\$(oci lb load-balancer create \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --display-name "EBS-PRD-LB" \\
  --shape-name "flexible" \\
  --shape-details '{"minimumBandwidthInMbps": 100, "maximumBandwidthInMbps": 1000}' \\
  --subnet-ids "[\"\${SN_LB_ID}\"]" \\
  --is-private false \\
  --query "data.id" --raw-output)

echo "LB ID: \${LB_ID}"

# Wait for ACTIVE state
until oci lb load-balancer get --load-balancer-id "\${LB_ID}" \\
  --query "data.\"lifecycle-state\"" --raw-output | grep -q "ACTIVE"; do
  echo "Waiting for LB... \$(date '+%H:%M:%S')"
  sleep 15
done
echo "LB ACTIVE"
\`\`\`

### 5.2 Create the backend set

\`\`\`bash
oci lb backend-set create \\
  --load-balancer-id "\${LB_ID}" \\
  --name "ebs-ohs-backend-set" \\
  --policy "ROUND_ROBIN" \\
  --health-checker '{
    "protocol": "HTTP",
    "urlPath": "/OA_HTML/AppsLocalLogin.jsp",
    "port": 8000,
    "returnCode": 200,
    "intervalInMillis": 10000,
    "timeoutInMillis": 5000,
    "retries": 3
  }' \\
  --session-persistence-configuration '{
    "cookieName": "EBSLBSESSION",
    "disableFallback": false
  }'
\`\`\`

### 5.3 Add backend nodes

\`\`\`bash
# Add App Node 1 (replace with actual private IP)
oci lb backend create \\
  --load-balancer-id "\${LB_ID}" \\
  --backend-set-name "ebs-ohs-backend-set" \\
  --ip-address "10.10.2.11" \\
  --port 8000 \\
  --weight 1

# Add App Node 2
oci lb backend create \\
  --load-balancer-id "\${LB_ID}" \\
  --backend-set-name "ebs-ohs-backend-set" \\
  --ip-address "10.10.2.12" \\
  --port 8000 \\
  --weight 1
\`\`\`

### 5.4 Upload SSL certificate and create HTTPS listener

\`\`\`bash
# Import certificate to OCI Certificates service
oci certs-mgmt certificate create-by-importing-config \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --name "ebs-prd-ssl-cert" \\
  --config-type IMPORTED \\
  --certificate-pem-file /tmp/ebs-prd.crt \\
  --private-key-pem-file /tmp/ebs-prd.key \\
  --cert-chain-pem-file /tmp/ebs-prd-chain.crt

# Create HTTPS listener (port 443)
oci lb listener create \\
  --load-balancer-id "\${LB_ID}" \\
  --name "ebs-https-listener" \\
  --default-backend-set-name "ebs-ohs-backend-set" \\
  --port 443 \\
  --protocol "HTTPS" \\
  --ssl-configuration '{
    "certificateName": "ebs-prd-ssl-cert",
    "verifyDepth": 0,
    "verifyPeerCertificate": false
  }'

# Create HTTP redirect listener (port 80)
oci lb listener create \\
  --load-balancer-id "\${LB_ID}" \\
  --name "ebs-http-listener" \\
  --default-backend-set-name "ebs-ohs-backend-set" \\
  --port 80 \\
  --protocol "HTTP"

# Create redirect rule set
oci lb rule-set create \\
  --load-balancer-id "\${LB_ID}" \\
  --name "https-redirect" \\
  --items '[{
    "action": "REDIRECT",
    "redirectUri": {"protocol":"HTTPS","host":"{host}","port":443,"path":"{path}","query":"{query}"},
    "responseCode": 301,
    "conditions": [{"attributeName":"PATH","operator":"FORCE_LONGEST_PREFIX_MATCH","attributeValue":"/"}]
  }]'
\`\`\`

### 5.5 Update EBS AutoConfig for the load balancer hostname

On each app node, update the context file and run AutoConfig:

\`\`\`bash
# Edit context file (replace values with your LB DNS name)
APP_CTX=\$CONTEXT_FILE   # set after sourcing the EBS env file

# Update load balancer-facing parameters
perl -i -pe 's|(<oa_var name="s_webentryhost"[^/]*/?>)|<oa_var name="s_webentryhost" value="ebs-prod.example.com"/>|g' "\${APP_CTX}"
perl -i -pe 's|(<oa_var name="s_webentryurlport"[^/]*/?>)|<oa_var name="s_webentryurlport" value="443"/>|g' "\${APP_CTX}"
perl -i -pe 's|(<oa_var name="s_active_webport"[^/]*/?>)|<oa_var name="s_active_webport" value="8000"/>|g' "\${APP_CTX}"

# Run AutoConfig
source /u01/applmgr/EBSPRD/EBSprd_appnode01.env
perl \$AD_TOP/bin/adconfig.pl \\
  contextfile=\$CONTEXT_FILE \\
  logfile=\$APPL_TOP/admin/log/autoconfig_\$(date +%Y%m%d_%H%M).log

# Bounce application services
\$ADMIN_SCRIPTS_HOME/adstpall.sh apps/<apps_password>
\$ADMIN_SCRIPTS_HOME/adstrtal.sh apps/<apps_password>
\`\`\`

---

## Phase 6: Data Guard Configuration

### 6.1 Provision standby DB System with Data Guard Association

\`\`\`bash
DG_ASSOC_ID=\$(oci db data-guard-association create-with-new-db-system \\
  --database-id "ocid1.database.oc1..primary.aaaaaa..." \\
  --protection-mode "MAXIMUM_AVAILABILITY" \\
  --transport-type "ASYNC" \\
  --display-name "EBS-PRD-DG-STANDBY" \\
  --hostname "ebsdbstby" \\
  --availability-domain "IwGV:PHX-AD-2" \\
  --subnet-id "\${SN_DB_ID}" \\
  --shape "VM.Standard.E4.Flex" \\
  --shape-config '{"ocpuCount": 8, "memoryInGBs": 128}' \\
  --fault-domain "FAULT-DOMAIN-1" \\
  --query "data.id" --raw-output)

echo "DG Association ID: \${DG_ASSOC_ID}"
\`\`\`

### 6.2 Monitor Data Guard synchronization

\`\`\`bash
# Check DG association state
oci db data-guard-association get \\
  --database-id "ocid1.database.oc1..primary.aaaaaa..." \\
  --data-guard-association-id "\${DG_ASSOC_ID}" \\
  --query "data.{Role:\"role\",State:\"lifecycle-state\",Lag:\"apply-lag\",Rate:\"apply-rate\"}" \\
  --output table
\`\`\`

On the primary DB, verify redo transport to the standby:

\`\`\`sql
-- Check Data Guard status
SELECT name, value, datum_time FROM v\$dataguard_stats
WHERE  name IN ('transport lag','apply lag','apply finish time')
ORDER  BY name;

-- Check redo destinations
SELECT dest_id, dest_name, status, target, archiver,
       schedule, destination, error
FROM   v\$archive_dest
WHERE  status != 'INACTIVE'
ORDER  BY dest_id;

-- Verify standby is receiving redo
SELECT sequence#, applied, first_time, next_time
FROM   v\$archived_log
WHERE  dest_id = 2
ORDER  BY sequence# DESC
FETCH FIRST 10 ROWS ONLY;
\`\`\`

Expected: \`transport lag\` and \`apply lag\` within seconds. A lag growing beyond 5 minutes indicates a transport issue — check network connectivity between AD-1 and AD-2 on port 1521.

---

## Phase 7: Health Check Script — oci_ebs_health_check.sh

This script validates the full OCI EBS stack: database listener, TNS connectivity, OHS status on each app node, WebLogic managed server state, load balancer backend health, and Data Guard lag. Run it from the bastion or admin host as a user with SSH access to both app nodes and SQL access to the database.

\`\`\`bash
#!/bin/bash
# oci_ebs_health_check.sh
# Validates the OCI EBS 19c + EBS 12.2 HA stack health.
# Usage: oci_ebs_health_check.sh <APPS_PASSWORD> <DB_HOST> <APP1_IP> <APP2_IP> <LB_HOST>
#
# Requires: oci CLI, sqlplus, tnsping, curl, ssh key access to app nodes
# Run as: applmgr or DBA user with SSH to app nodes and SQL access

set -uo pipefail

APPS_PASS="\${1:?Usage: \$0 <APPS_PASSWORD> <DB_HOST> <APP1_IP> <APP2_IP> <LB_HOST>}"
DB_HOST="\${2:?DB hostname or IP}"
APP1_IP="\${3:?App Node 1 IP}"
APP2_IP="\${4:?App Node 2 IP}"
LB_HOST="\${5:?Load Balancer hostname}"
SSH_USER="opc"
SSH_KEY="\${HOME}/.ssh/id_rsa"

LOG_DIR="/tmp/ebs_health_\$(date +%Y%m%d_%H%M%S)"
mkdir -p "\${LOG_DIR}"
LOG_FILE="\${LOG_DIR}/health_check.log"
FAIL_COUNT=0
WARN_COUNT=0

log()  { echo "[$(date '+%H:%M:%S')] \$*" | tee -a "\${LOG_FILE}"; }
pass() { log "  [PASS] \$*"; }
fail() { log "  [FAIL] \$*"; ((FAIL_COUNT++)) || true; }
warn() { log "  [WARN] \$*"; ((WARN_COUNT++)) || true; }
section() { log ""; log "══════════════════════════════════════════════════"; log "  \$*"; log "══════════════════════════════════════════════════"; }

log "OCI EBS Health Check — \$(date)"
log "DB: \${DB_HOST} | App1: \${APP1_IP} | App2: \${APP2_IP} | LB: \${LB_HOST}"

# ── Section 1: Database Listener ─────────────────────────────────────────────
section "1. Database Listener and TNS"

for SVC in EBSPRD EBSPRDR; do
  RESULT=\$(tnsping "\${SVC}" 2>&1 | tail -1)
  if echo "\${RESULT}" | grep -qi "OK"; then
    pass "tnsping \${SVC}: \${RESULT}"
  else
    fail "tnsping \${SVC} failed: \${RESULT}"
  fi
done

# Check listener status on the DB host via SSH
ssh -i "\${SSH_KEY}" -o StrictHostKeyChecking=no -o ConnectTimeout=10 \\
  "\${SSH_USER}@\${DB_HOST}" \\
  "sudo -u oracle bash -c 'source /home/oracle/.bash_profile 2>/dev/null; lsnrctl status 2>&1'" \\
  2>&1 | tee -a "\${LOG_FILE}" | grep -E "^Service|^STATUS|Listening|TNS" | head -20

# ── Section 2: Database Instance Health ──────────────────────────────────────
section "2. Database Instance Health"

sqlplus -s "/ as sysdba" << 'SQLEOF' 2>&1 | tee -a "\${LOG_FILE}"
SET LINESIZE 140 PAGESIZE 50 FEEDBACK OFF VERIFY OFF

PROMPT Database open mode and role:
SELECT name, open_mode, database_role, log_mode, protection_mode
FROM   v\$database;

PROMPT
PROMPT Instance status:
SELECT instance_name, status, database_status, active_state
FROM   v\$instance;

PROMPT
PROMPT SGA component sizes (GB):
SELECT component,
       ROUND(current_size/1073741824,1) AS current_gb,
       ROUND(min_size/1073741824,1)     AS min_gb,
       ROUND(max_size/1073741824,1)     AS max_gb
FROM   v\$sga_dynamic_components
WHERE  current_size > 0
ORDER  BY current_size DESC;

PROMPT
PROMPT Top wait events (last 5 minutes):
SELECT event, total_waits, time_waited, average_wait
FROM   v\$system_event
WHERE  wait_class != 'Idle'
ORDER  BY time_waited DESC
FETCH FIRST 10 ROWS ONLY;

PROMPT
PROMPT Active sessions count:
SELECT status, COUNT(*) AS session_count
FROM   v\$session
WHERE  type = 'USER'
GROUP  BY status
ORDER  BY status;

PROMPT
PROMPT Cursor sharing validation (must be EXACT for EBS):
SELECT name, value FROM v\$parameter WHERE name = 'cursor_sharing';

EXIT;
SQLEOF

# ── Section 3: Tablespace Usage ───────────────────────────────────────────────
section "3. Tablespace Space Usage"

sqlplus -s "/ as sysdba" << 'SQLEOF' 2>&1 | tee -a "\${LOG_FILE}"
SET LINESIZE 140 PAGESIZE 50 FEEDBACK OFF VERIFY OFF
COLUMN tablespace_name FORMAT A20
COLUMN total_gb        FORMAT 99,990.0
COLUMN used_gb         FORMAT 99,990.0
COLUMN free_gb         FORMAT 99,990.0
COLUMN pct_used        FORMAT 990.0

PROMPT Tablespace utilization:
SELECT t.tablespace_name,
       ROUND(t.total_mb / 1024, 1)                           AS total_gb,
       ROUND((t.total_mb - NVL(f.free_mb,0)) / 1024, 1)     AS used_gb,
       ROUND(NVL(f.free_mb,0) / 1024, 1)                     AS free_gb,
       ROUND((t.total_mb - NVL(f.free_mb,0)) / t.total_mb * 100, 1) AS pct_used
FROM (
  SELECT tablespace_name, SUM(bytes/1048576) AS total_mb
  FROM   dba_data_files
  GROUP  BY tablespace_name
) t
LEFT JOIN (
  SELECT tablespace_name, SUM(bytes/1048576) AS free_mb
  FROM   dba_free_space
  GROUP  BY tablespace_name
) f ON f.tablespace_name = t.tablespace_name
ORDER  BY pct_used DESC;

PROMPT
PROMPT Temp tablespace usage:
SELECT t.tablespace_name,
       ROUND(t.alloc_mb/1024,1) AS allocated_gb,
       ROUND(t.used_mb/1024,1)  AS used_gb,
       ROUND(t.free_mb/1024,1)  AS free_gb
FROM (
  SELECT tablespace_name,
         SUM(bytes_cached/1048576)  AS alloc_mb,
         SUM(bytes_used/1048576)    AS used_mb,
         SUM(bytes_free/1048576)    AS free_mb
  FROM   v\$temp_space_header
  GROUP  BY tablespace_name
) t;

PROMPT
PROMPT ASM disk group usage:
SELECT name,
       ROUND(total_mb/1024,1)    AS total_gb,
       ROUND(free_mb/1024,1)     AS free_gb,
       ROUND((total_mb - free_mb) / total_mb * 100, 1) AS pct_used,
       state
FROM   v\$asm_diskgroup
ORDER  BY name;

EXIT;
SQLEOF

# ── Section 4: Data Guard Status ─────────────────────────────────────────────
section "4. Data Guard Status"

sqlplus -s "apps/\${APPS_PASS}" << 'SQLEOF' 2>&1 | tee -a "\${LOG_FILE}"
SET LINESIZE 140 PAGESIZE 50 FEEDBACK OFF

PROMPT Data Guard lag statistics:
SELECT name, value, unit, datum_time
FROM   v\$dataguard_stats
WHERE  name IN ('transport lag','apply lag','redo generation rate','apply rate')
ORDER  BY name;

PROMPT
PROMPT Redo transport destination status:
SELECT dest_id, target, status, error,
       archived_seq#, applied_seq#
FROM   v\$archive_dest_status
WHERE  status != 'INACTIVE'
ORDER  BY dest_id;

EXIT;
SQLEOF

# Check if apply lag exceeds threshold (5 minutes = 300 seconds)
LAG_CHECK=\$(sqlplus -s "/ as sysdba" << 'SQLEOF' 2>/dev/null
SET PAGESIZE 0 FEEDBACK OFF VERIFY OFF HEADING OFF
SELECT NVL(TO_CHAR(ROUND(TO_NUMBER(SUBSTR(value, 1, 2))*3600 +
       TO_NUMBER(SUBSTR(value, 4, 2))*60 +
       TO_NUMBER(SUBSTR(value, 7, 2)))), '0')
FROM   v\$dataguard_stats
WHERE  name = 'apply lag';
EXIT;
SQLEOF
)

LAG_SECS=\$(echo "\${LAG_CHECK}" | tr -d ' \n')
if [ "\${LAG_SECS:-0}" -le 300 ] 2>/dev/null; then
  pass "DG apply lag: \${LAG_SECS} seconds (within 5-min threshold)"
else
  warn "DG apply lag: \${LAG_SECS} seconds exceeds 300-second threshold"
fi

# ── Section 5: OHS Process Check on App Nodes ────────────────────────────────
section "5. Oracle HTTP Server Status"

for APP_IP in "\${APP1_IP}" "\${APP2_IP}"; do
  log "Checking OHS on \${APP_IP}..."
  OHS_STATUS=\$(ssh -i "\${SSH_KEY}" -o StrictHostKeyChecking=no -o ConnectTimeout=10 \\
    "\${SSH_USER}@\${APP_IP}" \\
    "sudo -u applmgr bash -c 'ps -ef | grep -c [o]hs 2>/dev/null || echo 0'" 2>/dev/null || echo "0")
  if [ "\${OHS_STATUS:-0}" -gt 0 ]; then
    pass "OHS process running on \${APP_IP} (\${OHS_STATUS} process(es))"
  else
    fail "OHS not running on \${APP_IP}"
  fi

  # HTTP connectivity test to OHS port 8000
  OHS_HTTP=\$(curl -sk -o /dev/null -w "%{http_code}" \\
    --connect-timeout 5 --max-time 10 \\
    "http://\${APP_IP}:8000/OA_HTML/AppsLocalLogin.jsp" 2>/dev/null || echo "000")
  case "\${OHS_HTTP}" in
    200) pass "OHS HTTP 200 on \${APP_IP}:8000" ;;
    302) pass "OHS redirect (302) on \${APP_IP}:8000 (expected for some EBS configs)" ;;
    000) fail "OHS not reachable at \${APP_IP}:8000" ;;
    *)   warn "OHS returned HTTP \${OHS_HTTP} on \${APP_IP}:8000" ;;
  esac
done

# ── Section 6: WebLogic Managed Server Check ──────────────────────────────────
section "6. WebLogic Managed Server Status"

for APP_IP in "\${APP1_IP}" "\${APP2_IP}"; do
  log "Checking WLS managed servers on \${APP_IP}..."

  # Check for running WLS Java processes
  WLS_PROCS=\$(ssh -i "\${SSH_KEY}" -o StrictHostKeyChecking=no -o ConnectTimeout=10 \\
    "\${SSH_USER}@\${APP_IP}" \\
    "sudo -u applmgr bash -c 'ps -ef | grep -E \"weblogic|oacore|forms|oafm\" | grep -v grep | wc -l'" 2>/dev/null || echo "0")
  if [ "\${WLS_PROCS:-0}" -gt 0 ]; then
    pass "WLS: \${WLS_PROCS} JVM process(es) on \${APP_IP}"
  else
    warn "No WLS JVM processes found on \${APP_IP} — verify app services status"
  fi

  # Check JVM heap via admin console (port 7001 or configured admin port)
  WLS_ADMIN_CHECK=\$(curl -sk -o /dev/null -w "%{http_code}" \\
    --connect-timeout 5 --max-time 10 \\
    "http://\${APP_IP}:7001/console/login/LoginForm.jsp" 2>/dev/null || echo "000")
  case "\${WLS_ADMIN_CHECK}" in
    200|302) pass "WLS Admin Console reachable on \${APP_IP}:7001" ;;
    000)     warn "WLS Admin Console not reachable on \${APP_IP}:7001 (may be intentionally restricted)" ;;
    *)       warn "WLS Admin Console HTTP \${WLS_ADMIN_CHECK} on \${APP_IP}:7001" ;;
  esac
done

# ── Section 7: Load Balancer Health ──────────────────────────────────────────
section "7. Load Balancer Connectivity"

# Test HTTPS through load balancer
LB_HTTPS=\$(curl -sk -o /dev/null -w "%{http_code}" \\
  --connect-timeout 10 --max-time 20 \\
  "https://\${LB_HOST}/OA_HTML/AppsLocalLogin.jsp" 2>/dev/null || echo "000")
case "\${LB_HTTPS}" in
  200) pass "LB HTTPS 200: https://\${LB_HOST}/OA_HTML/AppsLocalLogin.jsp" ;;
  302) pass "LB HTTPS 302 redirect: EBS login redirect as expected" ;;
  000) fail "LB HTTPS not reachable at https://\${LB_HOST}" ;;
  *)   warn "LB HTTPS returned \${LB_HTTPS} — investigate backend health" ;;
esac

# Test HTTP redirect (should redirect to HTTPS)
LB_HTTP=\$(curl -sk -o /dev/null -w "%{http_code}" \\
  --connect-timeout 5 --max-time 10 \\
  "http://\${LB_HOST}/" 2>/dev/null || echo "000")
case "\${LB_HTTP}" in
  301|302) pass "LB HTTP redirect to HTTPS: HTTP \${LB_HTTP}" ;;
  000)     warn "LB HTTP port not responding (check if port 80 listener is configured)" ;;
  *)       warn "LB HTTP returned \${LB_HTTP} — expected 301/302 redirect" ;;
esac

# Check backend health via OCI CLI (requires OCI CLI configured)
if command -v oci &>/dev/null; then
  log "Checking backend set health via OCI CLI..."
  BACKEND_HEALTH=\$(oci lb backend-health get \\
    --load-balancer-id "ocid1.loadbalancer.oc1..aaaaaa..." \\
    --backend-set-name "ebs-ohs-backend-set" \\
    --backend-name "10.10.2.11:8000" \\
    --query "data.status" --raw-output 2>/dev/null || echo "UNKNOWN")
  case "\${BACKEND_HEALTH}" in
    OK)      pass "Backend 10.10.2.11:8000 health: OK" ;;
    WARNING) warn "Backend 10.10.2.11:8000 health: WARNING" ;;
    CRITICAL|UNKNOWN) fail "Backend 10.10.2.11:8000 health: \${BACKEND_HEALTH}" ;;
  esac
fi

# ── Section 8: EBS Application-Level Checks ───────────────────────────────────
section "8. EBS Application Status"

sqlplus -s "apps/\${APPS_PASS}" << 'SQLEOF' 2>&1 | tee -a "\${LOG_FILE}"
SET LINESIZE 140 PAGESIZE 50 FEEDBACK OFF VERIFY OFF
COLUMN component_name FORMAT A40
COLUMN component_status FORMAT A15
COLUMN startup_mode FORMAT A12

PROMPT EBS service component status:
SELECT component_name, component_status, startup_mode,
       TO_CHAR(last_update_date,'YYYY-MM-DD HH24:MI') AS last_updated
FROM   fnd_svc_components
ORDER  BY component_status DESC, component_name;

PROMPT
PROMPT Internal Concurrent Manager status:
SELECT concurrent_queue_name, concurrent_queue_id,
       running_processes, max_processes,
       cache_size, worker_count
FROM   fnd_concurrent_queues
WHERE  manager_type = 'ConcurrentManager'
AND    enabled_flag = 'Y'
ORDER  BY concurrent_queue_name;

PROMPT
PROMPT Workflow Notification Mailer status:
SELECT component_name, component_status
FROM   fnd_svc_components
WHERE  component_type = 'WF_MAILER';

PROMPT
PROMPT APPS schema object invalids:
SELECT COUNT(*) AS invalid_count
FROM   all_objects
WHERE  status = 'INVALID'
AND    owner  = 'APPS';

PROMPT
PROMPT Recent OAM alert log entries (last hour):
SELECT target_name, metric_column, value, collection_timestamp
FROM   sysman.mgmt\$metric_current
WHERE  collection_timestamp > SYSDATE - 1/24
AND    metric_column LIKE '%CPU%'
ORDER  BY collection_timestamp DESC
FETCH FIRST 10 ROWS ONLY;

EXIT;
SQLEOF

# ── Section 9: OCI DB System Block Volume Space ───────────────────────────────
section "9. DB Node OS Filesystem Space"

ssh -i "\${SSH_KEY}" -o StrictHostKeyChecking=no -o ConnectTimeout=10 \\
  "\${SSH_USER}@\${DB_HOST}" "df -h" 2>&1 | tee -a "\${LOG_FILE}"

# Alert on filesystems over 85%
FS_OVER=\$(ssh -i "\${SSH_KEY}" -o StrictHostKeyChecking=no "\${SSH_USER}@\${DB_HOST}" \\
  "df -h | awk 'NR>1 && \$5+0 >= 85 {print \$5, \$6}'" 2>/dev/null || echo "")
if [ -n "\${FS_OVER}" ]; then
  warn "DB node filesystem(s) at or above 85%: \${FS_OVER}"
else
  pass "DB node filesystems all below 85%"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
section "SUMMARY"
log "Failures : \${FAIL_COUNT}"
log "Warnings : \${WARN_COUNT}"
log "Log file : \${LOG_FILE}"
if [ "\${FAIL_COUNT}" -gt 0 ]; then
  log "STATUS   : UNHEALTHY — \${FAIL_COUNT} check(s) failed"
  exit 1
elif [ "\${WARN_COUNT}" -gt 0 ]; then
  log "STATUS   : DEGRADED — \${WARN_COUNT} warning(s) — investigate"
  exit 2
else
  log "STATUS   : HEALTHY — all checks passed"
  exit 0
fi
\`\`\`

Deploy and use the script:

\`\`\`bash
chmod 750 /u01/scripts/oci_ebs_health_check.sh

# Run a full health check
/u01/scripts/oci_ebs_health_check.sh \\
  <apps_password> \\
  10.10.1.11 \\
  10.10.2.11 \\
  10.10.2.12 \\
  ebs-prod.example.com

# Schedule via cron for continuous monitoring (every 15 minutes)
# 0,15,30,45 * * * * /u01/scripts/oci_ebs_health_check.sh <pass> 10.10.1.11 10.10.2.11 10.10.2.12 ebs-prod.example.com >> /var/log/ebs_health.log 2>&1
\`\`\`

---

## Phase 8: Troubleshooting

### DB System provisioning stuck in PROVISIONING

\`\`\`bash
# Check DB System lifecycle state
oci db system get \\
  --db-system-id "\${DB_SYSTEM_ID}" \\
  --query "data.{State:\"lifecycle-state\",Time:\"time-created\"}"

# Check for any failed work requests in the compartment
oci work-requests work-request list \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --resource-id "\${DB_SYSTEM_ID}" \\
  --query "data[?status=='FAILED']"
\`\`\`

If stuck beyond 60 minutes, open an OCI Support request referencing the work request ID. Do not attempt to delete and re-create the DB System while the work request is in FAILED state — wait for OCI to clean up internal state first.

### Character set mismatch after provisioning

\`\`\`sql
-- Verify from the database
SELECT value FROM nls_database_parameters WHERE parameter = 'NLS_CHARACTERSET';
\`\`\`

If the character set is not AL32UTF8, the DB System cannot be used for EBS 12.2. You must:
1. Terminate the DB System
2. Re-create it with the explicit character set parameter (the OCI CLI \`adminPassword\` JSON block must include \`"characterSet": "AL32UTF8"\`)

Character set cannot be migrated post-creation without a full export/import cycle using Data Pump with \`CONVERT\` — this is not supported as part of OCI DB System lifecycle management.

### OHS not starting on app nodes

\`\`\`bash
# Source the EBS environment and check OHS status
source /u01/applmgr/EBSPRD/EBSprd_appnode01.env
\$ADMIN_SCRIPTS_HOME/adapcctl.sh status

# Check OHS error log
tail -100 \$LOG_HOME/ora/10.1.3/Apache/error_log | grep -i "error\|fail\|cannot"

# Common cause: AutoConfig not run yet, or httpd.conf references old hostname
grep "ServerName\|Listen" \$IAS_ORACLE_HOME/Apache/Apache/conf/httpd.conf | head -10
\`\`\`

### Load balancer backend unhealthy despite OHS running

The health check URL \`/OA_HTML/AppsLocalLogin.jsp\` requires EBS to be fully started. If the WebLogic oacore server or the database is down, OHS is running but the URL returns 5xx and the health check fails.

\`\`\`bash
# Test the health check URL directly from the app node
curl -v http://localhost:8000/OA_HTML/AppsLocalLogin.jsp

# If 5xx: check WebLogic oacore status
\$ADMIN_SCRIPTS_HOME/adoacorectl.sh status

# If oacore is down: start it
\$ADMIN_SCRIPTS_HOME/adoacorectl.sh start
\`\`\`

Alternatively, use a simpler health check URL that only requires OHS to be running (not the full EBS stack) by changing the backend set health check URL to \`/\` and \`returnCode: 302\`.

### Data Guard apply lag growing

\`\`\`sql
-- On the standby DB, check MRP (Managed Recovery Process) status
SELECT process, status, thread#, sequence#, block#, active_agents
FROM   v\$managed_standby
ORDER  BY process;

-- Expected: one MRP0 process in APPLYING_LOG status

-- If MRP is not running, start it
ALTER DATABASE RECOVER MANAGED STANDBY DATABASE DISCONNECT FROM SESSION;
\`\`\`

\`\`\`bash
# Check network connectivity between primary and standby on port 1521
# Run from primary DB node
nc -zv <standby_ip> 1521

# Check redo transport on primary — any errors in alert log
grep -i "ORA-\|error\|FAL" \$ORACLE_BASE/diag/rdbms/ebsprd/EBSPRD/trace/alert_EBSPRD.log | tail -20
\`\`\`

### TNS connectivity from app tier to DB fails

\`\`\`bash
# From app node, verify tnsnames.ora entry
cat \$TNS_ADMIN/tnsnames.ora | grep -A 10 "EBSPRD"

# Test raw TCP connection to DB listener
nc -zv <db_ip> 1521

# Verify the security list allows port 1521 from app subnet
oci network security-list list \\
  --compartment-id "ocid1.compartment.oc1..aaaaaa..." \\
  --query "data[?\"display-name\"=='sl-db-private'].ingress-security-rules" \\
  --output json | python3 -m json.tool | grep -A 3 "1521"
\`\`\`

---

## Quick Reference

| Task | Command |
|---|---|
| Run full health check | \`/u01/scripts/oci_ebs_health_check.sh <pass> <db_ip> <app1_ip> <app2_ip> <lb_host>\` |
| Check DB System state | \`oci db system get --db-system-id <id> --query "data.lifecycle-state"\` |
| Check DG apply lag | \`SELECT name,value FROM v\$dataguard_stats WHERE name='apply lag'\` |
| Start MRP on standby | \`ALTER DATABASE RECOVER MANAGED STANDBY DATABASE DISCONNECT;\` |
| Verify EBS services | \`SELECT component_name,component_status FROM fnd_svc_components\` |
| Check LB backend health | \`oci lb backend-health get --load-balancer-id <id> --backend-set-name ebs-ohs-backend-set --backend-name <ip:port>\` |
| Run AutoConfig | \`perl \$AD_TOP/bin/adconfig.pl contextfile=\$CONTEXT_FILE\` |
| Bounce EBS services | \`\$ADMIN_SCRIPTS_HOME/adstpall.sh apps/<pass> && \$ADMIN_SCRIPTS_HOME/adstrtal.sh apps/<pass>\` |
| Scale app node OCPUs | \`oci compute instance update --instance-id <id> --shape-config '{"ocpuCount":N}'\` |
| Expand block volume | \`oci bv volume update --volume-id <id> --size-in-gbs <new_size>\` (online, no downtime) |
| Check ASM disk space | \`SELECT name, free_mb, total_mb FROM v\$asm_diskgroup\` |
| Verify character set | \`SELECT value FROM nls_database_parameters WHERE parameter='NLS_CHARACTERSET'\` |
`.trim();

async function main() {
  await db.insert(posts).values({
    title: 'Oracle 19c and EBS 12.2 OCI Provisioning — Runbook',
    slug,
    excerpt: 'Step-by-step provisioning runbook for Oracle Database 19c and Oracle E-Business Suite 12.2 in Oracle Cloud Infrastructure with high availability. Covers OCI service limit verification, VCN and subnet creation with security list rules, DB System launch with character set and parameter validation, application tier block volume setup and OS prerequisites, OCI Load Balancer with sticky session configuration and AutoConfig integration, Data Guard cross-AD provisioning, and the oci_ebs_health_check.sh script that validates the full stack: DB listener, TNS connectivity, OHS process status, WebLogic JVM health, load balancer backend health, and Data Guard apply lag.',
    content,
    category: 'ebs-suite',
    isPremium: false,
    published: true,
    publishedAt: new Date(),
  });
  console.log('Inserted:', slug);
}

main().catch(console.error);
