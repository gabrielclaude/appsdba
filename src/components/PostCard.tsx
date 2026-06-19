import Link from 'next/link';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getCategoryLabel, getCategoryColor } from '@/lib/categories';
import type { Post } from '@/db/schema';
import type { CategoryKey } from '@/lib/categories';

interface PostCardProps {
  post: Post;
}

export function PostCard({ post }: PostCardProps) {
  const categoryKey = post.category as CategoryKey;

  return (
    <Card className="hover:shadow-lg transition-shadow bg-[#FFF3B0] ring-[#C8A84B] paper-texture">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <Link href={`/posts/${post.slug}`} className="group flex-1">
            <h2 className="text-xl font-semibold text-[#0D1F3C] group-hover:text-[#E8693C] transition-colors leading-snug">
              {post.title}
            </h2>
          </Link>
          <div className="flex items-center gap-1.5 shrink-0">
            {post.isPremium && (
              <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">
                Premium
              </span>
            )}
            <Badge className={`text-xs font-medium border-0 ${getCategoryColor(categoryKey)}`}>
              {getCategoryLabel(categoryKey)}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {post.excerpt && (
          <p className="text-[#2D1B00] text-base leading-relaxed mb-3">{post.excerpt}</p>
        )}
        <div className="flex items-center justify-between">
          <time className="text-sm text-[#6B4F1A]">
            {post.publishedAt
              ? new Date(post.publishedAt).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })
              : ''}
          </time>
          {post.youtubeUrl && (
            <span className="text-xs text-red-500 font-medium flex items-center gap-1">
              ▶ Video
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
