import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL!);
async function main() {
  const rows = await sql`SELECT slug, LENGTH(content) as len, LEFT(content, 300) as preview FROM posts WHERE id = 488` as any[];
  if (rows[0]) console.log(`slug: ${rows[0].slug}\nlen: ${rows[0].len}\npreview: ${rows[0].preview}`);
}
main().catch(console.error);
