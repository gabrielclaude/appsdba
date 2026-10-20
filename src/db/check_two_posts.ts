import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL!);
async function main() {
  const rows = await sql`
    SELECT id, slug, title, published, is_premium, LENGTH(content) as content_len,
           LEFT(content, 200) as preview
    FROM posts 
    WHERE slug IN (
      'java-heap-histogram-scheduled-analysis-cron',
      'weblogic-jvm-histogram-code-cache-sizing-automated-monitoring'
    )
  ` as any[];
  rows.forEach((r: any) => {
    console.log(`\n--- ${r.slug} ---`);
    console.log(`id=${r.id} published=${r.published} premium=${r.is_premium} len=${r.content_len}`);
    console.log(`preview: ${r.preview}`);
  });
}
main().catch(console.error);
