import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL!);
async function main() {
  const rows = await sql`SELECT category, COUNT(*) as n FROM posts WHERE published = true GROUP BY category ORDER BY category`;
  console.table(rows);
  const total = rows.reduce((s: number, r: any) => s + Number(r.n), 0);
  console.log('Total:', total);
}
main().catch(console.error);
