import { config } from 'dotenv';
config({ path: '.env.local' });

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL!);

async function main() {
  const posts = await sql`
    SELECT id, slug, content FROM posts WHERE published = true
  ` as { id: number; slug: string; content: string }[];

  console.log(`Processing ${posts.length} posts…`);

  let updated = 0;
  let skipped = 0;

  for (const post of posts) {
    // Match: *By Author Name — Country*\n\n  OR  *By Author Name — Country*\n
    const cleaned = post.content.replace(
      /^\*By (.+?) — [^\n*]+\*\n\n?/,
      'By $1\n\n'
    );

    if (cleaned === post.content) {
      skipped++;
      continue;
    }

    await sql`UPDATE posts SET content = ${cleaned} WHERE id = ${post.id}`;
    updated++;
    if (updated % 20 === 0) console.log(`  ${updated} updated…`);
  }

  console.log(`\nDone. Updated: ${updated}, Skipped (no byline match): ${skipped}`);
}

main().catch(console.error);
