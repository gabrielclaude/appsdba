import { config } from 'dotenv';
config({ path: '.env.local' });

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL!);

async function main() {
  const result = await sql`
    UPDATE posts
    SET content = regexp_replace(content, '^By (Dr\.|Prof\.|Mr\.|Ms\.|Mrs\.) ', 'By ', 'n')
    WHERE published = true
      AND content ~ '^By (Dr\.|Prof\.|Mr\.|Ms\.|Mrs\.)'
    RETURNING id
  `;
  console.log(`Updated ${result.length} posts.`);
}

main().catch(console.error);
