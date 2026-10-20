import { config } from 'dotenv';
config({ path: '.env.local' });

import { readFileSync } from 'fs';
import { join } from 'path';
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const content = readFileSync(join(__dirname, 'content/ebs-forms-odf-to-xdf-runbook.md'), 'utf-8');

const post = {
  title: 'EBS ODF to XDF Migration Runbook: End-to-End Forms Modernization Procedure',
  slug: 'ebs-forms-odf-to-xdf-migration-runbook',
  excerpt: "Step-by-step operational runbook for migrating Oracle EBS Forms from ODF binary to XDF — covering ETCC prerequisites, FMA bulk conversion, custom form merging with frmxmlconv, frmcmp_batch compilation, middle-tier deployment, functional regression testing, adop cutover, and rollback procedure.",
  category: 'ebs-next-gen' as const,
  content,
  isPremium: true,
  published: true,
  publishedAt: new Date('2026-10-20T14:00:00.000Z'),
  youtubeUrl: null,
  videoUrl: null,
};

async function main() {
  await db.insert(posts).values(post);
  console.log('Inserted:', post.slug);
}
main().catch(console.error);
