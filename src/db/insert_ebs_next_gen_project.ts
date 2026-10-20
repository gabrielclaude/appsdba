import { config } from 'dotenv';
config({ path: '.env.local' });

import { readFileSync } from 'fs';
import { join } from 'path';
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const content = readFileSync(join(__dirname, 'content/ebs-next-gen-project.md'), 'utf-8');

const post = {
  title: 'Oracle EBS Next Gen: Modernizing E-Business Suite Without Replacing It',
  slug: 'oracle-ebs-next-gen-project-overview-modernization-strategy',
  excerpt: "A deep dive into Oracle's multi-year EBS Next Generation program — why it exists, how the XDF/OAF/ISG architecture replaces Oracle Forms, and what it means for Apps DBAs managing EBS 12.2.x deployments.",
  category: 'ebs-next-gen' as const,
  content,
  isPremium: false,
  published: true,
  publishedAt: new Date('2026-10-20T12:00:00.000Z'),
  youtubeUrl: null,
  videoUrl: null,
};

async function main() {
  await db.insert(posts).values(post);
  console.log('Inserted:', post.slug);
}
main().catch(console.error);
