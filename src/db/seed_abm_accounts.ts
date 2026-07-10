/**
 * Seed CRM with ABM target accounts for Oracle EBS outreach.
 *
 * Companies are publicly known Oracle EBS customers drawn from Oracle press
 * releases, OAUG conference speaker lists, and Oracle customer case studies.
 * Contacts are placeholder entries — replace email/name with real data obtained
 * from Apollo.io or ZoomInfo before running outreach.
 *
 * Tags encode: persona segment (apps-dba, ebs-engineer, ebs-manager, etc.)
 *              + deployment type (ebs-onprem or ebs-cloud)
 *              + vertical (manufacturing, healthcare, etc.)
 *
 * Run: env DATABASE_URL="..." npx tsx src/db/seed_abm_accounts.ts
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { crmProspects } from './schema';
import { eq } from 'drizzle-orm';

type Seed = {
  company: string;
  jobTitle: string;
  email: string;      // placeholder — replace with verified contact
  firstName?: string;
  lastName?: string;
  source: string;
  tags: string[];
  score: number;
  notes: string;
};

const SEEDS: Seed[] = [
  // ── Manufacturing ───────────────────────────────────────────────────────────
  {
    company: 'Whirlpool Corporation',
    jobTitle: 'Oracle Apps DBA',
    email: 'placeholder-whirlpool-dba@example.invalid',
    source: 'zoominfo',
    tags: ['apps-dba', 'ebs-onprem', 'manufacturing'],
    score: 75,
    notes: 'Large EBS 12.2 on-prem footprint; active OAUG participant. Verify contact via Apollo/ZoomInfo before outreach.',
  },
  {
    company: 'Whirlpool Corporation',
    jobTitle: 'IT Director, Oracle Applications',
    email: 'placeholder-whirlpool-mgr@example.invalid',
    source: 'zoominfo',
    tags: ['it-director', 'ebs-onprem', 'manufacturing'],
    score: 80,
    notes: 'Decision-maker for EBS licensing and upgrade. Verify contact before outreach.',
  },
  {
    company: 'Parker Hannifin',
    jobTitle: 'Senior Oracle DBA',
    email: 'placeholder-parker-dba@example.invalid',
    source: 'oracle-community',
    tags: ['apps-dba', 'ebs-onprem', 'manufacturing'],
    score: 65,
    notes: 'Multi-org EBS environment. Documented Oracle Community Forum presence.',
  },
  {
    company: 'Harley-Davidson',
    jobTitle: 'EBS Technical Lead',
    email: 'placeholder-hd-tech@example.invalid',
    source: 'oaug-quest',
    tags: ['ebs-engineer', 'ebs-onprem', 'manufacturing'],
    score: 60,
    notes: 'OAUG conference speakers in prior years. Verify current role.',
  },
  {
    company: 'Hershey Company',
    jobTitle: 'Oracle Applications Manager',
    email: 'placeholder-hershey-mgr@example.invalid',
    source: 'zoominfo',
    tags: ['ebs-manager', 'ebs-onprem', 'manufacturing'],
    score: 70,
    notes: 'Large EBS footprint including SCM and financials.',
  },

  // ── Retail / Wholesale ──────────────────────────────────────────────────────
  {
    company: 'Dollar General',
    jobTitle: 'Oracle EBS Architect',
    email: 'placeholder-dg-arch@example.invalid',
    source: 'zoominfo',
    tags: ['ebs-engineer', 'ebs-onprem', 'retail'],
    score: 65,
    notes: 'Known EBS financials deployment. High DBA headcount for store systems.',
  },
  {
    company: 'Sysco Corporation',
    jobTitle: 'Sr. Oracle DBA (Apps)',
    email: 'placeholder-sysco-dba@example.invalid',
    source: 'oracle-community',
    tags: ['apps-dba', 'ebs-onprem', 'retail'],
    score: 70,
    notes: 'EBS with complex distribution and procurement modules.',
  },
  {
    company: 'Genuine Parts Company',
    jobTitle: 'Oracle Technical Consultant',
    email: 'placeholder-gpc-tech@example.invalid',
    source: 'linkedin-abm',
    tags: ['ebs-engineer', 'ebs-onprem', 'retail'],
    score: 55,
    notes: 'EBS inventory and order management. LinkedIn ABM target.',
  },

  // ── Healthcare ──────────────────────────────────────────────────────────────
  {
    company: 'HCA Healthcare',
    jobTitle: 'Oracle EBS DBA',
    email: 'placeholder-hca-dba@example.invalid',
    source: 'zoominfo',
    tags: ['apps-dba', 'ebs-onprem', 'healthcare'],
    score: 80,
    notes: 'Large multi-org EBS for HR and financials across hospital network.',
  },
  {
    company: 'HCA Healthcare',
    jobTitle: 'VP, Oracle Applications',
    email: 'placeholder-hca-vp@example.invalid',
    source: 'zoominfo',
    tags: ['it-director', 'ebs-onprem', 'healthcare'],
    score: 85,
    notes: 'Senior decision-maker. Verify current title via ZoomInfo.',
  },
  {
    company: 'Cigna',
    jobTitle: 'Oracle Financials Lead',
    email: 'placeholder-cigna-fin@example.invalid',
    source: 'linkedin-abm',
    tags: ['functional', 'ebs-onprem', 'healthcare'],
    score: 60,
    notes: 'EBS GL/AP/AR implementation. Functional consultant persona.',
  },

  // ── Energy / Utilities ──────────────────────────────────────────────────────
  {
    company: 'Dominion Energy',
    jobTitle: 'Senior Oracle DBA',
    email: 'placeholder-dom-dba@example.invalid',
    source: 'oracle-community',
    tags: ['apps-dba', 'ebs-onprem', 'energy'],
    score: 65,
    notes: 'Utility sector EBS with custom work orders and asset mgmt.',
  },
  {
    company: 'Duke Energy',
    jobTitle: 'Oracle EBS Systems Manager',
    email: 'placeholder-duke-mgr@example.invalid',
    source: 'oaug-quest',
    tags: ['ebs-manager', 'ebs-onprem', 'energy'],
    score: 70,
    notes: 'OAUG active member. Duke has presented at COLLABORATE.',
  },

  // ── Financial Services ──────────────────────────────────────────────────────
  {
    company: 'MetLife',
    jobTitle: 'Oracle Apps DBA',
    email: 'placeholder-metlife-dba@example.invalid',
    source: 'zoominfo',
    tags: ['apps-dba', 'ebs-onprem', 'financial'],
    score: 70,
    notes: 'EBS HR and financials for insurance operations.',
  },
  {
    company: 'Lincoln Financial Group',
    jobTitle: 'Oracle EBS Functional Analyst',
    email: 'placeholder-lincoln-fa@example.invalid',
    source: 'linkedin-abm',
    tags: ['functional', 'ebs-onprem', 'financial'],
    score: 55,
    notes: 'EBS financials. LinkedIn profile visible — engage organically first.',
  },

  // ── Government / Defense ────────────────────────────────────────────────────
  {
    company: 'Leidos Holdings',
    jobTitle: 'Oracle EBS Technical Lead',
    email: 'placeholder-leidos-tech@example.invalid',
    source: 'linkedin-abm',
    tags: ['ebs-engineer', 'ebs-onprem', 'government'],
    score: 60,
    notes: 'Defense contractor with EBS financials and project costing.',
  },
  {
    company: 'SAIC',
    jobTitle: 'Senior Oracle DBA',
    email: 'placeholder-saic-dba@example.invalid',
    source: 'zoominfo',
    tags: ['apps-dba', 'ebs-onprem', 'government'],
    score: 65,
    notes: 'Large EBS deployment. Verify contact via ZoomInfo.',
  },

  // ── Higher Education ────────────────────────────────────────────────────────
  {
    company: 'Ohio State University',
    jobTitle: 'Oracle Apps DBA',
    email: 'placeholder-osu-dba@example.invalid',
    source: 'oracle-community',
    tags: ['apps-dba', 'ebs-onprem', 'education'],
    score: 55,
    notes: 'University EBS HR and financials. Oracle Community active.',
  },
  {
    company: 'University of Michigan',
    jobTitle: 'EBS Systems Analyst',
    email: 'placeholder-umich-sa@example.invalid',
    source: 'oaug-quest',
    tags: ['ebs-engineer', 'ebs-onprem', 'education'],
    score: 50,
    notes: 'Higher-ed EBS. OAUG academic track participant.',
  },

  // ── Cloud migrations ────────────────────────────────────────────────────────
  {
    company: 'Kraft Heinz',
    jobTitle: 'Oracle Cloud Migration Lead',
    email: 'placeholder-kh-cloud@example.invalid',
    source: 'linkedin-abm',
    tags: ['ebs-engineer', 'ebs-cloud', 'manufacturing'],
    score: 75,
    notes: 'Mid-EBS-to-OCI migration project. Actively seeking content on EBS cloud lift.',
  },
  {
    company: 'Pactiv Evergreen',
    jobTitle: 'Oracle EBS on OCI Admin',
    email: 'placeholder-pactiv-oci@example.invalid',
    source: 'oracle-community',
    tags: ['apps-dba', 'ebs-cloud', 'manufacturing'],
    score: 70,
    notes: 'EBS on OCI deployment. Oracle Community presence confirmed.',
  },
];

async function main() {
  let inserted = 0;
  let skipped = 0;

  for (const seed of SEEDS) {
    const existing = await db
      .select({ id: crmProspects.id })
      .from(crmProspects)
      .where(eq(crmProspects.email, seed.email))
      .limit(1);

    if (existing.length > 0) {
      console.log(`SKIP (exists): ${seed.email}`);
      skipped++;
      continue;
    }

    await db.insert(crmProspects).values({
      firstName:  seed.firstName ?? null,
      lastName:   seed.lastName ?? null,
      email:      seed.email,
      company:    seed.company,
      jobTitle:   seed.jobTitle,
      source:     seed.source,
      stage:      'lead',
      score:      seed.score,
      tags:       seed.tags,
      notes:      seed.notes,
    });

    console.log(`INSERTED: ${seed.company} — ${seed.jobTitle}`);
    inserted++;
  }

  console.log(`\nDone. ${inserted} inserted, ${skipped} skipped.`);
  console.log('\nNEXT STEP: Replace placeholder emails with verified contacts from Apollo.io or ZoomInfo before any outreach.');
}

main().catch(console.error);
