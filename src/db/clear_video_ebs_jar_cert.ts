import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';
import { eq } from 'drizzle-orm';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

async function main() {
  const result = await db
    .update(posts)
    .set({ youtubeUrl: null, videoUrl: null })
    .where(eq(posts.slug, 'ebs-12-2-jar-certificate-audit'))
    .returning({ slug: posts.slug, title: posts.title });

  if (result.length === 0) {
    console.log('No post found with slug: ebs-12-2-jar-certificate-audit');
  } else {
    console.log('Video cleared for:', result[0].title);
  }
}

main().catch(console.error);
