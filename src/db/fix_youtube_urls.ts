import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL!);
async function main() {
  await sql`
    UPDATE posts SET youtube_url = NULL
    WHERE slug IN (
      'java-heap-histogram-scheduled-analysis-cron',
      'weblogic-jvm-histogram-code-cache-sizing-automated-monitoring'
    )
  `;
  console.log('Cleared youtube_url for both posts');
}
main().catch(console.error);
