import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL!);
async function main() {
  const rows = await sql`SELECT id, title, slug, category, content FROM posts WHERE slug = 'weblogic-clustering-load-balancing-monitoring'` as any[];
  console.log(JSON.stringify(rows[0], null, 2));
}
main().catch(console.error);
