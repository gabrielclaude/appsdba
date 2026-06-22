import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'NuGenesis on Oracle for Pharma: Scientific Data Management from Discovery to Submission',
  slug: 'nugenesis-oracle-pharma-sdms-overview',
  excerpt:
    'A practical introduction to Waters NuGenesis SDMS and ELN on Oracle Database — what the platform does, why it matters for GxP compliance, and how it integrates with laboratory instruments, LIMS, and regulatory submission workflows.',
  category: 'pharma-clinical-trials' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-22'),
  youtubeUrl: null,
  content: `Pharmaceutical laboratories generate enormous volumes of data from instruments — HPLC chromatograms, mass spectra, NMR free induction decays, dissolution profiles, stability data. Historically, this data lived in proprietary instrument software on individual workstation PCs, printed to paper notebooks, signed, dated, and filed in binders. The FDA and EMA consider that data to be part of the complete record of a product's development and manufacture. If the data cannot be found, accessed, or verified as unmodified — the product itself is at risk.

Waters NuGenesis is the Scientific Data Management System (SDMS) and Electronic Laboratory Notebook (ELN) platform built specifically to solve this problem for pharmaceutical organisations. Its backend runs on Oracle Database, which makes it directly relevant to Oracle DBAs supporting life sciences clients.

---

## What NuGenesis Is

NuGenesis is two integrated products:

### NuGenesis SDMS (Scientific Data Management System)

SDMS is an automated data capture and storage system. Collection agents — lightweight software deployed on each laboratory workstation or instrument controller PC — watch configured folders for new data files. When an instrument generates a result file (Empower 3 chromatogram, MassLynx spectrum, ACD/NMR file, any other format), the collection agent detects it and submits it to the NuGenesis Server, where it is stored, indexed, and made searchable.

The core value: data is captured automatically without manual intervention. The analyst does not "upload" results — the instrument produces the file and NuGenesis captures it. This eliminates a chain of human steps that would otherwise introduce opportunities for error or falsification.

### NuGenesis ELN (Electronic Laboratory Notebook)

ELN replaces paper laboratory notebooks. Analysts record experimental procedures, observations, calculations, and conclusions in a web-based form. The ELN enforces:

- **Version control**: every edit is recorded with the editor's identity and timestamp
- **Electronic signatures**: multi-step signature workflows (author → reviewer → approver) with configurable signature meanings
- **Audit trail**: immutable record of who did what and when
- **SDMS attachment**: raw instrument data captured by SDMS is linked directly to the ELN experiment record

The combination of SDMS + ELN creates a complete, traceable chain from instrument output through experimental record to the final approved result — all in Oracle Database.

---

## Why It Matters for GxP Compliance

### 21 CFR Part 11

FDA 21 CFR Part 11 (Electronic Records and Electronic Signatures) requires that electronic records used to satisfy FDA requirements must be:

- **Trustworthy**: protected from modification, stored with audit trail
- **Reliable**: computer systems must be validated (IQ/OQ/PQ)
- **Equivalent to paper**: electronic signatures must be legally equivalent to handwritten signatures

NuGenesis is specifically designed to meet these requirements. Key Part 11 controls in NuGenesis:

| Part 11 Requirement | NuGenesis Implementation |
|--------------------|------------------------|
| Audit trail (§11.10(e)) | Oracle Unified Auditing on the NuGenesis schema; NuGenesis application-level event log |
| Access controls (§11.10(d)) | Role-based access in NuGenesis; Oracle Database Vault optional |
| System validation (§11.10(a)) | IQ/OQ/PQ protocols provided by Waters; customer executes validation |
| Electronic signatures (§11.50) | Configurable signature workflows; signature meaning captured at signing time |
| Record protection (§11.10(c)) | RMAN backups; Data Guard; Oracle SecureFiles for LOB storage |

### EU Annex 11

EU Annex 11 (Computerised Systems) applies to GxP computerised systems used in clinical trials, manufacturing, and laboratory testing. Key Annex 11 requirements NuGenesis addresses:

- **Business Continuity (Annex 11 §16)**: documented disaster recovery; RTO/RPO in the validated system description. Oracle Data Guard on the NuGenesis Oracle Database satisfies this requirement.
- **Data Integrity (Annex 11 §7.1)**: data is attributed to an originator (the instrument and collection agent), timestamped, and unmodifiable after capture.
- **Change Control (Annex 11 §10)**: any change to NuGenesis or its Oracle Database goes through a documented change control process including impact assessment and abbreviated OQ.

---

## NuGenesis Architecture on Oracle Database

\`\`\`
┌─────────────────────────────────────────────────────────────────┐
│  Laboratory Infrastructure                                      │
│                                                                 │
│  HPLC (Empower 3)   MS (MassLynx)   NMR (TopSpin)  ...        │
│       ↓                   ↓               ↓                     │
│  Collection Agent    Collection Agent  Collection Agent         │
│       └──────────────────┬────────────────┘                     │
│                          ↓                                      │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  NuGenesis Server (Windows Server)                        │  │
│  │                                                           │  │
│  │  Document Manager  │  ELN Engine  │  Web Application     │  │
│  │  (file capture,    │  (experiment │  (browser client)    │  │
│  │   indexing,        │   records,   │                      │  │
│  │   search)          │   signatures)│                      │  │
│  └──────────────────────┬────────────────────────────────────┘  │
│                         │ JDBC / Oracle Net                      │
│  ┌──────────────────────▼────────────────────────────────────┐  │
│  │  Oracle Database 19c                                      │  │
│  │                                                           │  │
│  │  NGSDMS Schema: metadata, audit trail, ELN records       │  │
│  │  SecureFiles LOBs: instrument data files                  │  │
│  │  Oracle Unified Auditing: DBA activity log               │  │
│  │  RMAN → backup storage (tape or cloud)                   │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
\`\`\`

### Oracle Database Role

NuGenesis stores three categories of data in Oracle:

1. **Metadata**: document properties, user information, experiment records, workflow states, audit events. Stored in standard relational tables in the NGSDMS schema.

2. **Document content**: actual instrument data files (chromatograms, spectra, FIDs) stored as Oracle SecureFiles LOBs, or as filesystem files with Oracle storing the path reference. The LOB option is preferred for GxP because it keeps the data within Oracle's backup and security boundary.

3. **Audit trail**: every access, modification, and signature event recorded in audit tables. Oracle Unified Auditing adds a second layer (DBA-level actions on the schema).

Key Oracle requirements for NuGenesis:
- Character set: **AL32UTF8** (mandatory — mixed character set corrupts instrument data metadata from international instruments)
- Minimum Oracle version: 12.2 (NuGenesis 9.x); 19c recommended (NuGenesis 10.x)
- open_cursors: 3000+ (NuGenesis connection pool opens many cursors concurrently)
- Block size: 8KB default (no requirement for non-standard block size)

### Sizing Considerations

| Laboratory Size | Instruments | Annual Data Volume | Oracle DB Size (5yr) |
|----------------|------------|-------------------|---------------------|
| Small QC lab | 5–10 | 20–50 GB/year | ~300 GB |
| Mid-size R&D | 20–50 | 100–250 GB/year | ~1.5 TB |
| Large CRO/CDO | 100–200 | 500 GB–2 TB/year | 5–15 TB |

---

## Integration Points

### LIMS Integration

LIMS (Laboratory Information Management System) platforms — LabWare LIMS, STARLIMS, Labvantage — manage samples, test requests, and specifications. NuGenesis SDMS stores the raw instrument data. The integration links the two: when an analyst runs a sample in an HPLC system, the result is captured in NuGenesis and linked back to the LIMS sample record.

Integration methods:
- **Modern (NuGenesis 9.x+)**: REST API — LIMS calls NuGenesis REST endpoints to retrieve document metadata; NuGenesis calls LIMS REST API to update sample status
- **Legacy**: file-based — NuGenesis exports a result XML file to a LIMS watch folder; LIMS parses the XML and updates the sample record

### Instrument Integration

NuGenesis collection agents support the following instrument software natively (among others):

| Instrument Software | Instrument Type |
|--------------------|----------------|
| Empower 3 (Waters) | HPLC, UPLC, LC-MS |
| MassLynx (Waters) | Mass Spectrometry |
| OpenLAB CDS (Agilent) | HPLC, GC |
| Chromeleon (Thermo Fisher) | Ion Chromatography |
| ACD/NMR Workbook Suite | NMR |
| TopSpin (Bruker) | NMR (via generic file agent) |
| ModulyQ | Dissolution |

Generic file-watching agents support any instrument that writes data to a network share.

### Regulatory Submission Integration

For CTD (Common Technical Document) submissions, NuGenesis ELN experiments can be exported with full audit trail as PDF/A documents. The PDF/A format preserves digital content for long-term archival (required for regulatory submissions that must remain accessible for product lifecycle + post-market surveillance periods).

---

## DBA-Specific Responsibilities

### Character Set Validation (Pre-Installation)

\`\`\`sql
-- Verify character set before NuGenesis installation
SELECT value FROM nls_database_parameters WHERE parameter = 'NLS_CHARACTERSET';
-- Must return: AL32UTF8
-- If not: database must be recreated or converted (not patchable post-creation)
\`\`\`

### Required Init Parameters

\`\`\`sql
-- Verify NuGenesis-required parameters
SELECT name, value FROM v$parameter
WHERE name IN (
  'open_cursors',
  'session_cached_cursors',
  'shared_pool_size',
  'sga_target',
  'pga_aggregate_target',
  'db_block_size'
);
-- open_cursors: >= 3000
-- session_cached_cursors: >= 100
-- db_block_size: 8192 (8KB, default)
\`\`\`

### Backup Compliance

In a GxP environment, backup success is a regulatory requirement, not just an operational best practice. The validation documentation (IQ/OQ) includes backup verification test cases. Post-go-live, backup success must be monitored and failures escalated immediately.

\`\`\`sql
-- Verify RMAN backup succeeded in last 24 hours
SELECT status, start_time, end_time, input_bytes/1024/1024/1024 input_gb
FROM v$rman_backup_job_details
WHERE start_time > SYSDATE - 1
ORDER BY start_time DESC;
-- Expected: STATUS = 'COMPLETED'
\`\`\`

### Monitoring the NGSDMS Schema

\`\`\`sql
-- NuGenesis document count (total documents in SDMS)
SELECT COUNT(*) total_documents FROM ngsdms.ng_documents;

-- Documents added in last 24 hours (collection health indicator)
SELECT COUNT(*) new_today FROM ngsdms.ng_documents
WHERE created_date > SYSDATE - 1;

-- LOB storage consumption
SELECT s.segment_name, ROUND(s.bytes/1024/1024/1024, 2) lob_gb
FROM dba_segments s
JOIN dba_lobs l ON s.segment_name = l.segment_name
WHERE l.owner = 'NGSDMS'
ORDER BY s.bytes DESC
FETCH FIRST 5 ROWS ONLY;

-- Audit trail entries today (confirm auditing is active)
SELECT COUNT(*) audit_events_today FROM ngsdms.ng_audit_trail
WHERE event_date > SYSDATE - 1;
\`\`\`

---

## Platform Comparison

| Platform | Type | Oracle DB Backend | GxP Validation | Primary Use Case |
|----------|------|------------------|---------------|-----------------|
| Waters NuGenesis | SDMS + ELN | Yes (required) | Yes (IQ/OQ/PQ) | Analytical chemistry data capture |
| Thermo SampleManager | LIMS + ELN | Yes (option) | Yes | Sample management + lab scheduling |
| STARLIMS | LIMS | Yes (option) | Yes | Manufacturing QC, stability |
| LabArchives | ELN | No (proprietary) | Limited | Academic/research ELN |
| Benchling | ELN | No (SaaS) | Partial | Biotech/genomics research |

NuGenesis's differentiator is its native SDMS capability — the automated instrument data capture — combined with Oracle Database's enterprise-class storage, audit, and backup features. For regulated pharmaceutical manufacturing quality labs, this combination is the standard.

The companion runbook provides the complete installation and validation procedure for Oracle DBA and NuGenesis Administrator teams.`,
};

async function main() {
  console.log('Inserting NuGenesis Oracle pharma blog post...');
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
