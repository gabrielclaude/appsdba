import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL!);
async function main() {
  const rows = await sql`SELECT id, slug, title FROM posts WHERE published = true AND (slug LIKE '%wlst%' OR (category = 'weblogic' AND (slug LIKE '%script%' OR slug LIKE '%monitor%' OR title ILIKE '%wlst%')))` as any[];
  console.log(`WLST posts (${rows.length}):`);
  rows.forEach((r: any) => console.log(' ', r.slug));
}
main().catch(console.error);
