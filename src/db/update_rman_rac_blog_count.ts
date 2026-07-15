import { config } from 'dotenv';
config({ path: '.env.local' });

import { db } from './index';
import { posts } from './schema';
import { eq } from 'drizzle-orm';

const slug = 'rman-backup-strategy-oracle-rac-database';

async function main() {
  const allPosts = await db.select({ slug: posts.slug }).from(posts);
  const runbookCount = allPosts.filter(r => r.slug.endsWith('-runbook')).length;
  const blogCount = allPosts.filter(r => !r.slug.endsWith('-runbook')).length;

  const [current] = await db
    .select({ content: posts.content })
    .from(posts)
    .where(eq(posts.slug, slug));

  if (!current) {
    console.error('Post not found:', slug);
    process.exit(1);
  }

  const banner = `> **AppsDBA Library:** ${blogCount} blog posts · ${runbookCount} runbooks\n\n`;

  const updatedContent = banner + current.content;

  await db.update(posts).set({ content: updatedContent }).where(eq(posts.slug, slug));
  console.log(`Updated with counts: ${blogCount} blogs, ${runbookCount} runbooks`);
}

main().catch(console.error);
