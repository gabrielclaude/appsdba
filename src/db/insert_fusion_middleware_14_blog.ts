import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Oracle Fusion Middleware 14: Architecture, Component Stack, and What Changes from FMW 12c',
  slug: 'oracle-fusion-middleware-14-architecture-overview',
  excerpt:
    'A technical overview of Oracle Fusion Middleware 14 — the updated WebLogic 14.1.1 foundation, JRF and OPSS changes, RCU schema requirements, JDK 17 compatibility, how SOA Suite, Service Bus, and MFT fit into the FMW 14 stack, migration paths from FMW 12c, and the installation and domain configuration decisions that determine long-term operability.',
  category: 'fusion-middleware' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-24'),
  youtubeUrl: null,
  content: `## Overview

Oracle Fusion Middleware 14 (FMW 14, based on WebLogic Server 14.1.1) is the current long-term release of Oracle's middleware platform. It delivers the most significant updates to the WebLogic foundation since the 12c series: JDK 17 support, Jakarta EE 8 compliance, updated OPSS security framework, and a retooled patching model aligned with Oracle's quarterly CPU release cadence. For organisations running FMW 12.2.1.x, FMW 14 is both the current upgrade target and the platform required for Oracle's latest SOA, Service Bus, OSB, and MFT releases.

This post covers the FMW 14 component architecture, what changed from FMW 12c, the Java and OS requirements, the RCU schema structure, domain topology design, and the migration considerations most relevant to existing FMW environments.

---

## FMW 14 Stack Overview

Oracle Fusion Middleware 14 is not a single product — it is a collection of components built on a common WebLogic Server foundation:

\`\`\`
Oracle Fusion Middleware 14
  ├── WebLogic Server 14.1.1  (application server foundation)
  │     ├── Java Required Files (JRF)  — ADF, OPSS, MDS, Audit
  │     └── Oracle Platform Security Services (OPSS)
  ├── Repository Creation Utility (RCU)  — creates DB schemas
  ├── Oracle SOA Suite 12.2.1.4+  (BPEL, Mediator, B2B, BAM)
  ├── Oracle Service Bus (OSB)  (proxy/business services, pipelines)
  ├── Oracle Managed File Transfer (MFT)
  ├── Oracle Identity Governance (OIG)
  ├── Oracle Access Manager (OAM)
  └── Oracle HTTP Server (OHS)  (optional reverse proxy)
\`\`\`

Each product installs into the same Middleware Home directory but deploys as separate applications within a WebLogic domain. Multiple products can share a single WebLogic domain (common in SOA+OSB collocated deployments) or occupy separate domains (preferred for production isolation).

---

## WebLogic 14.1.1 Foundation Changes

### JDK 17 Support

FMW 14 / WebLogic 14.1.1 is the first WebLogic release certified for JDK 17 (LTS). FMW 12.2.1.x ran on JDK 8 (with limited JDK 11 support). JDK 17 brings:

- Strong module encapsulation (Java Platform Module System from Java 9+) — some third-party libraries that use reflective access to internal JDK APIs will fail on JDK 17 without JVM flags
- Removal of deprecated APIs present in JDK 8 (Nashorn JavaScript engine, RMI activation, some security algorithms)
- Improved GC options: ZGC and Shenandoah available in addition to G1GC

**JDK compatibility during migration**: FMW 14 supports JDK 8, JDK 11, and JDK 17. A migration from FMW 12c can be performed first on JDK 11 to verify application compatibility, then moved to JDK 17 as a separate step — reducing the number of variables in play during migration.

### Jakarta EE 8

WebLogic 14.1.1 implements Jakarta EE 8 (the open-source successor to Java EE 8). For most applications, Jakarta EE 8 is API-compatible with Java EE 8. The key difference is the package namespace change: the \`javax.*\` packages in Java EE have been renamed to \`jakarta.*\` in Jakarta EE 9+. FMW 14 uses Jakarta EE 8 which retains the \`javax.*\` namespace — applications written for Java EE 8 run without code changes.

Applications referencing specific Java EE 7 APIs removed in Jakarta EE 8 (JAX-RPC, JAXR, some deprecated EJB APIs) will need remediation before deploying on FMW 14.

### Updated Security Framework (OPSS)

Oracle Platform Security Services (OPSS) in FMW 14 includes:
- Updated credential store framework (CSF) with stronger key derivation
- TLS 1.3 support in addition to TLS 1.2 (TLS 1.0 and 1.1 disabled by default)
- Updated cipher suite defaults — weaker ciphers (3DES, RC4, export-grade) disabled
- FIPS 140-2 mode support via JDK's SunPKCS11 provider

The cipher suite changes are the most common cause of integration failures after upgrading to FMW 14 — external systems that connect to WebLogic SSL listeners using older cipher suites (3DES_EDE_CBC, RC4_128) will fail TLS handshake. Audit all inbound SSL connections before migration.

---

## JRF and MDS

Java Required Files (JRF) is the minimum Oracle middleware layer required by all JRF-enabled applications (SOA Suite, OSB, OAM, OIG). JRF provides:

- ADF (Application Development Framework) libraries
- Oracle Metadata Services (MDS) — stores customisations, metadata, and configuration for ADF applications
- OPSS — security policy store, credential store, identity store connection
- Oracle Audit Framework
- Oracle Logging Services

JRF requires the following RCU schemas in the repository database (names prefixed with the RCU schema prefix):

| Schema | Purpose |
|--------|---------|
| \`<PREFIX>_STB\` | Service Table — central registry for all RCU schemas |
| \`<PREFIX>_OPSS\` | OPSS security policy store |
| \`<PREFIX>_IAU\` | Audit services |
| \`<PREFIX>_IAU_APPEND\` | Audit append-only data |
| \`<PREFIX>_IAU_VIEWER\` | Audit viewer |
| \`<PREFIX>_MDS\` | Oracle Metadata Services |
| \`<PREFIX>_WLS\` | WebLogic Server data (JMS, JDBC persistence, etc.) |
| \`<PREFIX>_WLS_RUNTIME\` | WebLogic runtime data |

SOA Suite adds additional schemas (\`_SOAINFRA\`, \`_ESS\`) on top of these JRF schemas.

---

## Repository Database Requirements

The RCU repository database must meet these minimum requirements for FMW 14:

| Requirement | Value |
|-------------|-------|
| Oracle Database version | 19c (19.3+) or 21c |
| Character set | AL32UTF8 |
| Minimum tablespace for SOAINFRA | 4 GB (production: 20+ GB) |
| Minimum TEMP tablespace | 1 GB |
| OPEN_CURSORS | 500+ (recommended 1000) |
| PROCESSES | 500+ (more if many Managed Servers) |

Oracle Database 19c is the minimum for FMW 14 SOA Suite. Running RCU against Oracle Database 12c is not supported for new FMW 14 installations.

The \`_SOAINFRA\` schema stores all BPEL instance data — composite state, dehydration points, conversation IDs. This schema grows rapidly with BPEL workflow volume. In production SOA environments, \`SOAINFRA\` requires dedicated tablespace with autoextend, and the DBA must implement purging policies to prevent unbounded growth.

---

## Domain Topology Design

A WebLogic domain is the fundamental administrative unit — it contains an Administration Server and zero or more Managed Servers (or clusters). FMW 14 domain design follows the same topology patterns as FMW 12c with some updated recommendations:

### Administration Server

The Administration Server (AdminServer) manages domain configuration. It must be running for domain configuration changes but does not need to be running for application traffic. In production:
- Run AdminServer on a dedicated host or shared with one Managed Server
- Never run production traffic through AdminServer
- Protect AdminServer with Node Manager for automatic restart

### SOA + OSB Collocated Domain

The most common topology for organisations deploying both SOA Suite and Service Bus — both products deployed in the same WebLogic domain:

\`\`\`
Domain: soa_domain
  ├── AdminServer (config mgmt only)
  ├── Cluster: soa_cluster
  │     ├── soa_server1 (SOA Suite + OSB)
  │     └── soa_server2 (SOA Suite + OSB)
  └── (optional) soa_server_osb_only  -- if routing separation is needed
\`\`\`

A collocated domain reduces the number of JVM processes and database connection pools, at the cost of a single failure domain — a misconfigured SOA deployment can affect OSB routing and vice versa.

### Separate Domain Topology

For environments where SOA and OSB have independent change cycles, separate domains provide fault isolation:

\`\`\`
soa_domain: AdminServer + soa_cluster (SOA Suite only)
osb_domain: AdminServer + osb_cluster (Service Bus only)
\`\`\`

Separate domains require separate RCU schema prefixes and separate Node Manager instances (or a single Node Manager managing multiple domains).

---

## What Changed from FMW 12.2.1.x to FMW 14

### Supported Upgrades

FMW 14 supports in-place upgrade from:
- FMW 12.2.1.3 (SOA, OSB, OAM, OIG)
- FMW 12.2.1.4 (SOA, OSB, MFT, OAM, OIG)

FMW 12.2.1.2 and earlier require an intermediate upgrade to 12.2.1.4 before upgrading to FMW 14.

### UA (Upgrade Assistant)

The Upgrade Assistant (UA) tool handles in-place upgrades of RCU schemas and domain configuration from FMW 12.2.1.x to FMW 14. UA runs in two modes:
- **Schema Upgrade**: upgrades the RCU schemas in the repository database to FMW 14 versions
- **Domain Upgrade**: upgrades the WebLogic domain configuration files, OPSS policy store, and MDS metadata

UA is not optional — you cannot run FMW 14 Managed Servers against FMW 12c RCU schemas. The schema upgrade must complete successfully before starting FMW 14 servers.

### Removed Features

Features removed or deprecated between FMW 12c and FMW 14 that commonly affect existing deployments:
- **OWSM 12c policy configurations**: some older WSM-PM policy configurations are not forward-compatible; they must be reviewed and migrated using WSM migration utilities
- **EclipseLink 2.5.x APIs**: internal JPA implementation updated; applications using implementation-specific EclipseLink APIs may require changes
- **ActiveMQ integration via JMS bridge**: some pre-12c JMS bridge configurations require recreation
- **Java EE 7 deprecated APIs**: applications using JAX-RPC must migrate to JAX-WS

---

## Node Manager

Node Manager is the WebLogic agent that manages server lifecycle (start, stop, restart) independently of the Administration Server. FMW 14 Node Manager runs as a per-domain service or as a per-machine service.

Configuration recommendation for FMW 14:
- Use the **per-domain Node Manager** (introduced in 12c, standard in FMW 14) rather than the per-machine Node Manager
- Configure Node Manager to use secure (SSL) communication with WebLogic Managed Servers
- Register Node Manager as a systemd service on RHEL 9 for automatic restart on host reboot

---

## Patching in FMW 14

FMW 14 uses the same OPatch-based patching model as FMW 12c, with patches delivered on Oracle's quarterly CPU schedule. For FMW 14:
- **Oracle WebLogic Server patches**: applied with OPatch to the WLS\_HOME
- **FMW component patches** (SOA, OSB, MFT): applied with OPatch to the product Oracle home
- **Bundle Patches**: released quarterly, cumulative — always apply the latest BP rather than sequentially

After applying any FMW 14 patch that includes schema changes, the Upgrade Assistant must be run again to apply the schema-level changes to the repository database. This is the most commonly missed step in FMW patching — applying software patches without the corresponding UA run leaves the schema at the prior patch level and causes server startup errors.

---

## Summary

Oracle Fusion Middleware 14, built on WebLogic Server 14.1.1, delivers JDK 17 support, Jakarta EE 8 compliance, updated TLS defaults, and FIPS 140-2 support as the primary changes from FMW 12c. The JRF foundation (OPSS, MDS, Audit) and RCU schema requirements follow the same structure as FMW 12c, but the repository database must be Oracle 19c or later. The key migration risk from FMW 12c is cipher suite incompatibility — TLS 1.0/1.1 and older cipher suites are disabled by default in FMW 14, and external integrations that relied on these must be updated before cutover. In-place upgrade from FMW 12.2.1.4 uses the Upgrade Assistant for both schema and domain upgrade; the schema upgrade step is mandatory and must run before FMW 14 servers start. The companion runbook covers the complete installation procedure on RHEL 9: pre-installation checks, RCU schema creation, WebLogic and JRF installation, domain creation, Node Manager configuration, SOA Suite deployment, and the crontab monitoring scripts for server health, SOAINFRA tablespace growth, and composite instance backlog alerting.`,
};

async function main() {
  console.log('Inserting Oracle Fusion Middleware 14 blog post...');
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
