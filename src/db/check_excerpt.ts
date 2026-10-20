import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL!);
async function main() {
  const rows = await sql`
    SELECT slug, excerpt, category, is_premium
    FROM posts 
    WHERE slug IN (
      'java-heap-histogram-scheduled-analysis-cron',
      'weblogic-jvm-histogram-code-cache-sizing-automated-monitoring'
    )
  ` as any[];
  rows.forEach((r: any) => console.log(JSON.stringify(r)));
}
main().catch(console.error);
