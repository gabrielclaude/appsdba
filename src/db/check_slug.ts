import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL!);
async function main() {
  const rows = await sql`SELECT id, slug, title, published, is_premium, published_at, LEFT(content, 300) as preview FROM posts WHERE slug = 'weblogic-jvm-histogram-code-cache-sizing-automated-monitoring'` as any[];
  console.log(`Found ${rows.length} matching posts:`);
  rows.forEach((r: any) => console.log(JSON.stringify(r, null, 2)));
}
main().catch(console.error);
