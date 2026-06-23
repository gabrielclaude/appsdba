import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'SAP S/4HANA Supply Chain for Manufacturing: Architecture, MRP Live, and What Actually Changes from ECC',
  slug: 'sap-s4hana-supply-chain-manufacturing-overview',
  excerpt:
    'A technical overview of SAP S/4HANA Supply Chain for Manufacturing — how MRP Live replaces overnight batch planning with real-time in-memory MRP, what changes across Production Planning, Materials Management, and Extended Warehouse Management, and the infrastructure architecture required to support it on RHEL 9.',
  category: 'sap-hana' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-22'),
  youtubeUrl: null,
  content: `## Overview

SAP S/4HANA Supply Chain for Manufacturing is not simply SAP ECC with a faster database underneath. It is a re-architected planning and execution environment where the shift from disk-based persistence to in-memory columnar storage fundamentally changes what is computationally practical: MRP runs that took eight hours as overnight batch jobs now complete in minutes, production capacity can be evaluated in real time, and planners can interact with live data rather than yesterday's snapshot.

This post covers what S/4HANA Supply Chain actually consists of, how the core modules differ from their ECC equivalents, what the in-memory HANA engine changes about planning logic, and the infrastructure foundation required to run it on RHEL 9.

---

## The Shift from ECC to S/4HANA Supply Chain

In SAP ECC, supply chain planning was fundamentally a batch-oriented architecture. Material Requirements Planning (MRP) was designed around the constraint that reading every material master, BOM, open order, and inventory record from disk and computing net requirements across thousands of materials was too slow to do interactively. The solution was to run it nightly, write the results to planning tables (\`MDKP\`, \`MDTB\`, \`PLAF\`), and have planners work from those static results throughout the day.

This created a structural lag: a demand change at 10:00 AM would not be reflected in planning proposals until the next morning's MRP run. For high-velocity manufacturing environments — automotive, electronics, consumer goods — this lag was a persistent planning quality problem.

S/4HANA collapses this lag through two architectural changes:

**1. All supply chain tables stored in SAP HANA columnar store.** Reads that required sequential disk I/O in ECC are satisfied from RAM. The core MRP computation that read millions of rows from \`MDKP\` and \`RESB\` now reads the same data from columnar-compressed in-memory tables at orders-of-magnitude lower latency.

**2. MRP Live replaces the classic MRP background job.** MRP Live is a re-implemented MRP engine that leverages HANA's in-memory speed to run planning for individual materials or entire plant segments interactively or in very short batch windows. It eliminates the planning file entry (\`MDVM\`) mechanism that ECC used to track what needed replanning, replacing it with a direct read of current data at run time.

---

## Core Modules: What Each One Does in Manufacturing

### Materials Management (MM)

MM covers the procurement and inventory management half of the supply chain. In S/4HANA, the key changes from ECC are:

- **Material ledger is mandatory.** In ECC, the material ledger was optional. In S/4HANA, it is activated by default for all materials. This means actual costing is always computed, and the distinction between standard price and actual price is always maintained.
- **Inventory management uses a single unified journal.** The \`MATDOC\` table replaces the ECC split between \`MSEG\` (material document lines) and \`MKPF\` (material document headers). Goods movements write to \`MATDOC\` and to the universal journal (\`ACDOCA\`) in a single posting.
- **Purchase order processing is simplified.** The Manage Purchase Orders Fiori app replaces the ME21N/ME22N transaction for most procurement scenarios, with approval workflows integrated directly rather than through separate workflow configuration.

### Production Planning (PP)

PP manages the conversion of demand signals into production orders and the execution of those orders on the shop floor.

The core PP objects remain conceptually the same as ECC: production orders, process orders (PP-PI for process industries), planned orders, capacities, routings, and Bills of Material. What changes is how planning proposals are generated and how planners interact with them:

- **MRP Live generates planned orders directly** from the current state of demand (sales orders, PIRs), supply (purchase orders, production orders, stock), and the BOM/routing structure — without the intermediate planning file mechanism.
- **The MRP Monitor (transaction \`MD06\` / Fiori equivalent)** shows exception messages in real time rather than from a batch snapshot. A planner can resolve a shortage, run MRP Live for that material segment, and see updated proposals within the same session.
- **Finite scheduling integration is tighter.** In ECC, capacity requirements planning (CRP) was a separate step after MRP. In S/4HANA with advanced production scheduling, capacity constraints can be considered during the planning run itself using the Production Planning and Detailed Scheduling (PP/DS) component.

### Demand-Driven MRP (DDMRP)

DDMRP is a planning methodology that positions strategic inventory buffers at decoupling points in the supply chain rather than at every BOM level. SAP S/4HANA includes native DDMRP support as an alternative planning method within the MRP Live framework.

In DDMRP:
- **Buffer zones** (red, yellow, green) replace traditional safety stock and reorder point logic
- **Demand-Driven replenishment** generates supply orders when on-hand inventory falls into the red zone
- **Decoupling points** absorb demand and supply variability, preventing the bullwhip effect from propagating upstream

DDMRP is particularly applicable in manufacturing environments with long lead times, high demand variability, or complex multilevel BOMs where traditional MRP generates excessive expediting.

### Extended Warehouse Management (EWM)

EWM handles the physical warehouse operations that MM's inventory management does not cover: put-away strategies, pick-pack-pass workflows, cross-docking, warehouse task assignment, and RF/voice-directed picking.

In S/4HANA, EWM is available as **embedded EWM** (running in the same ABAP system as the core S/4HANA instance) or as **decentralised EWM** (a separate system connected via CIF/qRFC). Embedded EWM eliminates the CIF replication delay that made decentralised EWM operationally complex and removes a significant integration point.

For manufacturing environments, the key EWM processes are:
- **Production supply** (issuing components to production orders, staging at production lines)
- **Goods receipt from production** (receiving finished goods into warehouse stock)
- **Handling unit management** (pallet/container tracking through production and distribution)

### Plant Maintenance / Asset Management (PM/AM)

Manufacturing environments depend on equipment reliability. SAP Asset Management in S/4HANA covers:
- Preventive maintenance plans and orders
- Corrective maintenance notification and order processing
- Integration with MM for spare parts procurement
- Equipment master and functional location hierarchy

The critical integration for supply chain is the link between maintenance orders and production capacity: a planned machine shutdown for maintenance should appear as a capacity constraint in PP/DS scheduling, preventing the system from planning production on unavailable equipment.

---

## The In-Memory Advantage: Where It Actually Shows Up

Not every supply chain process improves equally from in-memory execution. The gains are concentrated in:

**1. MRP runtime.** A classic ECC MRP run for a plant with 80,000 active materials might take 4–8 hours. The equivalent MRP Live run typically completes in 15–45 minutes, enabling multiple planning runs per day or near-real-time replanning on demand changes.

**2. ATP (Available-to-Promise) checks.** In ECC, ATP checks queried commitment records and available stock from disk on every sales order line. At high order volumes this created locking contention on the availability check tables. In S/4HANA, ATP reads from HANA memory and can support advanced ATP (aATP) with multi-level component availability checks (Product Availability Check with multi-level explosion) that were impractical in ECC.

**3. Embedded analytics.** S/4HANA replaces BW extraction with CDS (Core Data Services) views that allow analytical queries directly against operational tables. A manufacturing planner can open a Fiori analytical app that aggregates production order confirmations, capacity utilisation, and material consumption across a plant — reading live data, not a BW cube refreshed last night.

**4. Period-end closing.** The unified journal and mandatory material ledger allow actual costing settlement runs and account determination that took hours in ECC to complete in minutes, because the single \`ACDOCA\` table replaces the multi-table joins across CO, FI, and MM posting tables.

---

## Infrastructure Architecture on RHEL 9

### HANA Database Layer

SAP HANA is an in-memory database. Its sizing model is fundamentally different from disk-based databases:

- **RAM is the primary sizing driver.** HANA requires all active data to fit in physical RAM. For a mid-size S/4HANA manufacturing instance (100,000+ materials, 3 years of history, full PP/MM/EWM), the HANA database typically requires 512 GB to 2 TB of RAM on the production system.
- **Storage for HANA** is used for persistence (data volumes, log volumes, and backups) but is not on the critical read path. HANA log volumes require low-latency write performance (< 1 ms) — NVMe SSDs or equivalent. Data volumes require fast sequential I/O for savepoints and backup.
- **HANA System Replication (HSR)** provides high availability by replicating the in-memory state to a standby host. Combined with Pacemaker cluster management on RHEL 9, HSR enables automatic failover in under 60 seconds.

### Application Server Layer

S/4HANA ABAP application servers (the layer running PP, MM, EWM transactions and Fiori apps) are CPU and network bound rather than storage bound. They connect to the HANA database over a high-bandwidth network interface.

For manufacturing environments, the application server landscape typically includes:
- **Central Instance (CI)**: message server, enqueue server, dialog work processes
- **Additional Application Servers (AAS)**: additional dialog and background work processes
- **Batch server**: dedicated background work processes for MRP Live, period-end jobs, interface processing

### RHEL 9 Specifics for SAP

RHEL 9 is a supported platform for SAP HANA and S/4HANA as of SAP Note 3108316. The critical OS-level requirements differ from a standard RHEL 9 deployment:

- **\`saptune\`** replaces manual kernel parameter tuning. It applies a validated set of OS parameters (I/O scheduler, CPU governor, THP, vm.swappiness, network buffers) for the specific SAP solution being deployed.
- **Transparent HugePages must be disabled** — HANA manages its own memory allocation and THP interference causes fragmentation and performance degradation.
- **\`vm.swappiness = 10\`** for HANA hosts (not 1 as recommended for Oracle — HANA's memory management is different).
- **NUMA binding** of HANA processes is managed by HANA itself (\`numactl\` configuration in \`global.ini\`).
- **\`chronyd\`** for time synchronisation is required — clock skew between HANA primary and secondary in HSR causes replication errors.

---

## Integration Architecture

Manufacturing S/4HANA systems rarely run in isolation. The most common integration points are:

**EDI/IDoc for supplier and customer integration**: purchase orders to suppliers, order acknowledgements, advance shipping notices (ASN), and invoices flow via IDoc with EDI translation. The IDoc interface table (\`EDIDS\`, \`EDIDC\`) must be monitored for errors — a stuck outbound IDoc means a purchase order never reached the supplier.

**MES (Manufacturing Execution System) integration**: shop floor systems report production confirmations, quality inspection results, and machine data back to S/4HANA PP via IDocs (\`LOIPRO\`, \`LOIROU\`) or via the SAP Plant Connectivity (PCo) / SAP Manufacturing Integration and Intelligence (MII) layer.

**Third-party logistics (3PL) and WMS integration**: if a decentralised WMS is used instead of embedded EWM, warehouse stock movements must be confirmed back to S/4HANA MM via IDoc or RFC, with reconciliation processes to handle discrepancies.

**SAP IBP (Integrated Business Planning)** for demand planning and S&OP: if SAP IBP is deployed for medium/long-term demand planning, the consensus demand plan from IBP flows into S/4HANA as Planned Independent Requirements (PIRs) that drive MRP Live.

---

## Summary

SAP S/4HANA Supply Chain for Manufacturing represents a genuine architectural shift from ECC, not a cosmetic upgrade. The move from nightly batch MRP to real-time MRP Live, the mandatory unified journal eliminating the ECC multi-table financial/MM split, embedded EWM removing the CIF replication layer, and embedded analytics replacing BW extracts each resolve specific operational pain points that ECC customers managed around rather than eliminated.

The infrastructure requirement — primarily the HANA in-memory database demanding hundreds of gigabytes to terabytes of RAM on validated hardware — is the most significant change for infrastructure teams. RHEL 9 with \`saptune\` provides the certified OS foundation. HANA System Replication with Pacemaker provides HA. The companion runbook covers the RHEL 9 preparation, HANA installation, S/4HANA application server deployment, supply chain module configuration, and the monitoring scripts needed to operate a manufacturing S/4HANA environment reliably in production.`,
};

async function main() {
  console.log('Inserting SAP S/4HANA Supply Chain manufacturing blog post...');
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
