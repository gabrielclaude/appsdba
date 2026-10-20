import { config } from 'dotenv';
config({ path: '.env.local' });

import { readFileSync } from 'fs';
import { join } from 'path';
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const content = readFileSync(join(__dirname, 'content/ebs-forms-odf-to-xdf.md'), 'utf-8');

const post = {
  title: 'EBS Forms Migration: From ODF Binary to XDF — A Technical Field Guide',
  slug: 'ebs-forms-migration-odf-to-xdf-technical-guide',
  excerpt: "A practitioner's guide to migrating Oracle EBS custom Forms from the legacy ODF binary format to the modern XML Forms Definition (XDF) — covering FMA conversion, compilation, custom form merging, and a regression testing strategy.",
  category: 'ebs-next-gen' as const,
  content,
  isPremium: false,
  published: true,
  publishedAt: new Date('2026-10-20T13:00:00.000Z'),
  youtubeUrl: null,
  videoUrl: null,
};

async function main() {
  await db.insert(posts).values(post);
  console.log('Inserted:', post.slug);
}
main().catch(console.error);
