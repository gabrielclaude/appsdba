import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL!);
async function main() {
  const rows = await sql`
    SELECT id, slug, category, content FROM posts 
    WHERE slug IN (
      'java-heap-histogram-scheduled-analysis-cron',
      'weblogic-jvm-histogram-code-cache-sizing-automated-monitoring'
    )
  ` as any[];
  
  for (const r of rows) {
    console.log(`\n=== ${r.slug} (category: ${r.category}) ===`);
    const lines = r.content.split('\n');
    let inFence = false;
    let fenceDepth = 0;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('```')) {
        inFence = !inFence;
        fenceDepth++;
        continue;
      }
      if (!inFence) {
        // Check for HTML tags that would survive escaping AND be valid HTML
        // The issue: if formatInline produces unclosed/malformed HTML from inline patterns
        // Check for ** that might not close properly
        const boldMatches = (line.match(/\*\*/g) || []).length;
        if (boldMatches % 2 !== 0) {
          console.log(`  L${i+1} ODD BOLD: ${line.slice(0, 100)}`);
        }
        // Check for backticks that might not close
        const btMatches = (line.match(/`/g) || []).length;
        if (btMatches % 2 !== 0) {
          console.log(`  L${i+1} ODD BACKTICK: ${line.slice(0, 100)}`);
        }
        // Check for raw HTML-like content
        if (/<[a-zA-Z]/.test(line)) {
          console.log(`  L${i+1} RAW HTML: ${line.slice(0, 100)}`);
        }
      }
    }
    console.log(`  Fence state at end: ${inFence ? 'OPEN (BAD!)' : 'closed (ok)'}`);
  }
}
main().catch(console.error);
