import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL!);
async function main() {
  const rows = await sql`SELECT content FROM posts WHERE slug = 'weblogic-jvm-histogram-code-cache-sizing-automated-monitoring'` as any[];
  const content: string = rows[0]?.content ?? '';
  // Look for potential issues
  const lines = content.split('\n');
  console.log(`Total lines: ${lines.length}, chars: ${content.length}`);
  // Check for unclosed code fences
  const fences = lines.filter(l => l.startsWith('```'));
  console.log(`Code fence lines (${fences.length} — should be even):`, fences.map((f,i) => `${i+1}:${f}`).join(' | '));
  // Check for raw template literal syntax that might cause issues
  const templateIssues = lines.filter(l => l.includes('${') && !l.startsWith('```'));
  if (templateIssues.length) console.log('Template-like syntax in prose:', templateIssues.slice(0,3));
  // Print last 20 lines
  console.log('\nLast 20 lines:');
  lines.slice(-20).forEach((l, i) => console.log(`${lines.length - 20 + i}: ${l}`));
}
main().catch(console.error);
