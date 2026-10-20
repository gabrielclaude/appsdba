import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL!);
async function main() {
  const rows = await sql`SELECT slug, category FROM posts WHERE published = true` as any[];
  const runbooks = rows.filter((r: any) => r.slug.includes('runbook'));
  const scripts  = rows.filter((r: any) => r.slug.includes('script') || r.slug.includes('monitor'));
  const rman     = rows.filter((r: any) => r.slug.includes('rman'));
  const byCat = (arr: any[]) =>
    Object.entries(arr.reduce((acc: any, r: any) => { acc[r.category] = (acc[r.category]||0)+1; return acc; }, {}))
      .sort((a: any, b: any) => b[1] - a[1]);
  console.log(`\nRUNBOOKS (${runbooks.length} total):`);
  byCat(runbooks).forEach(([c, n]) => console.log(`  ${c}: ${n}`));
  console.log(`\nSCRIPTS/MONITORING (${scripts.length} total):`);
  byCat(scripts).forEach(([c, n]) => console.log(`  ${c}: ${n}`));
  console.log(`\nRMAN (${rman.length} total):`);
  byCat(rman).forEach(([c, n]) => console.log(`  ${c}: ${n}`));
}
main().catch(console.error);
