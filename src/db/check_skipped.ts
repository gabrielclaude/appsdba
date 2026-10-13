import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL!);
async function main() {
  const posts = await sql`SELECT id, slug, LEFT(content, 60) as preview FROM posts WHERE published = true ORDER BY id` as any[];
  const noByline    = posts.filter((p: any) => !p.preview.startsWith('By '));
  const noRefs      = await sql`SELECT id, slug FROM posts WHERE published = true AND content NOT LIKE '%## References%'` as any[];
  const noPS        = await sql`SELECT id, slug FROM posts WHERE published = true AND content NOT LIKE '%## Problem Statement%'` as any[];
  console.log(`\nMissing byline/rewrite (${noByline.length}):`);
  noByline.forEach((p: any) => console.log(' ', p.slug, '|', p.preview.trim()));
  console.log(`\nMissing References (${noRefs.length}):`);
  noRefs.forEach((p: any) => console.log(' ', p.slug));
  console.log(`\nMissing Problem Statement (${noPS.length} — only P&S posts matter):`);
  noPS.forEach((p: any) => console.log(' ', p.slug));
}
main().catch(console.error);
