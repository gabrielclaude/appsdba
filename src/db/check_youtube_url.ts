import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL!);
async function main() {
  const rows = await sql`SELECT id, slug, youtube_url FROM posts WHERE youtube_url IS NOT NULL ORDER BY id` as any[];
  console.log(`Posts with YouTube URLs: ${rows.length}`);
  rows.forEach((r: any) => console.log(`  ${r.id}: ${r.slug} => ${r.youtube_url}`));
}
main().catch(console.error);
