import { config } from 'dotenv';
config({ path: '.env.local' });

import { readFileSync } from 'fs';
import { join } from 'path';
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const content = readFileSync(join(__dirname, 'content/oracle19c-ebs1229-vmware-win11.md'), 'utf-8');

const post = {
  title: 'Installing Oracle 19c and EBS 12.2.9 on RHEL 8 with VMware Workstation Pro on Windows 11',
  slug: 'oracle-19c-ebs-12-2-9-rhel8-vmware-workstation-pro-windows11',
  excerpt: "How to build a full Oracle 19c Database and EBS 12.2.9 development environment on Windows 11 using VMware Workstation Pro — covering VM sizing, RHEL 8 prerequisites, Oracle installation, EBS Rapid Install, host-only networking, and a checkpoint snapshot strategy.",
  category: 'vmware' as const,
  content,
  isPremium: false,
  published: true,
  publishedAt: new Date('2026-10-22T09:00:00.000Z'),
  youtubeUrl: null,
  videoUrl: null,
};

async function main() {
  await db.insert(posts).values(post);
  console.log('Inserted:', post.slug);
}
main().catch(console.error);
