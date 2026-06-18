import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { posts } from '@/db/schema';
import { eq, and, or, ilike, desc } from 'drizzle-orm';

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q')?.trim() ?? '';

  if (q.length < 2) {
    return NextResponse.json([]);
  }

  const pattern = `%${q}%`;

  const results = await db
    .select({ title: posts.title, slug: posts.slug, category: posts.category, isPremium: posts.isPremium })
    .from(posts)
    .where(
      and(
        eq(posts.published, true),
        or(ilike(posts.title, pattern), ilike(posts.excerpt, pattern))
      )
    )
    .orderBy(desc(posts.publishedAt))
    .limit(12);

  return NextResponse.json(results);
}
