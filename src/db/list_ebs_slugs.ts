import { config } from 'dotenv';
config({ path: '.env.local' });
import { db } from './index';
import { posts } from './schema';
import { eq } from 'drizzle-orm';

async function main() {
  const rows = await db.select({ slug: posts.slug, title: posts.title }).from(posts).where(eq(posts.category, 'ebs-suite'));
  for (const r of rows) console.log(r.slug + ' | ' + r.title);
}
main().catch(console.error);
