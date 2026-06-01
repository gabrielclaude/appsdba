import { put } from '@vercel/blob';
import { readFileSync } from 'fs';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { posts } from './schema';
import { eq } from 'drizzle-orm';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql);

async function main() {
  // Add video_url column if not exists
  await sql`ALTER TABLE posts ADD COLUMN IF NOT EXISTS video_url VARCHAR(500)`;
  console.log('Ensured video_url column exists');

  const videoPath = '/Users/claudegabriel/Documents/2026/Blog/video/ebs-jar-audit.mp4';
  console.log('Uploading video to Vercel Blob...');
  const data = readFileSync(videoPath);

  const blob = await put('ebs-jar-audit.mp4', data, {
    access: 'public',
    contentType: 'video/mp4',
  });

  console.log('Uploaded:', blob.url);

  await db
    .update(posts)
    .set({ videoUrl: blob.url })
    .where(eq(posts.slug, 'ebs-12-2-jar-certificate-audit'));

  console.log('Post updated with video URL.');
}

main().catch(console.error);
