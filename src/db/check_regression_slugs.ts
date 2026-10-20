import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL!);
async function main() {
  const rows = await sql`SELECT id, slug FROM posts WHERE slug IN ('ebs-concurrent-program-regression-z-score-pvalue-awr-ash-addm', 'ebs-concurrent-program-regression-z-score-pvalue-awr-ash-addm-runbook')` as any[];
  console.log(`Found ${rows.length}:`, rows.map((r: any) => r.slug));
}
main().catch(console.error);
