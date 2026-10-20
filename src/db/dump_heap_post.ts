import { config } from 'dotenv';
config({ path: '.env.local' });
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL!);
async function main() {
  const rows = await sql`SELECT content FROM posts WHERE slug = 'java-heap-histogram-scheduled-analysis-cron'` as any[];
  const content: string = rows[0]?.content ?? '';
  const lines = content.split('\n');
  console.log(`Total lines: ${lines.length}, chars: ${content.length}`);
  const fences = lines.filter(l => l.startsWith('```'));
  console.log(`Code fence lines (${fences.length}):`, fences.map((f,i) => `${i+1}:${f}`).join(' | '));
  // Look for lines with < or > outside code blocks
  let inFence = false;
  const suspectLines: string[] = [];
  lines.forEach((l, idx) => {
    if (l.startsWith('```')) { inFence = !inFence; return; }
    if (!inFence && (l.includes('<') || l.includes('>') || l.includes('${') || l.includes('&'))) {
      suspectLines.push(`L${idx+1}: ${l.slice(0, 120)}`);
    }
  });
  if (suspectLines.length) {
    console.log('\nSuspect lines (outside code blocks):');
    suspectLines.forEach(s => console.log(' ', s));
  } else {
    console.log('\nNo suspect lines found.');
  }
  console.log('\nFull content:\n' + content);
}
main().catch(console.error);
