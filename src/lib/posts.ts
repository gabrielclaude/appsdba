import { db } from '@/db';
import { posts } from '@/db/schema';
import { eq, desc } from 'drizzle-orm';
import type { CategoryKey } from './categories';

export async function getAllPosts() {
  return db.select().from(posts).where(eq(posts.published, true)).orderBy(desc(posts.publishedAt));
}

export async function getPostsByCategory(category: CategoryKey) {
  return db.select().from(posts)
    .where(eq(posts.category, category))
    .orderBy(desc(posts.publishedAt));
}

export async function getPostBySlug(slug: string) {
  const result = await db.select().from(posts).where(eq(posts.slug, slug)).limit(1);
  return result[0] ?? null;
}

export function extractYoutubeId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}
