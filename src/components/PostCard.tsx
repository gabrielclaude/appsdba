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
    <Card className="hover:shadow-md transition-shadow border-gray-200">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <Link href={`/posts/${post.slug}`} className="group flex-1">
            <h2 className="text-lg font-semibold text-gray-900 group-hover:text-blue-600 transition-colors leading-snug">
              {post.title}
            </h2>
          </Link>
          <Badge className={`shrink-0 text-xs font-medium border-0 ${getCategoryColor(categoryKey)}`}>
            {getCategoryLabel(categoryKey)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {post.excerpt && (
          <p className="text-gray-600 text-sm leading-relaxed mb-3">{post.excerpt}</p>
        )}
        <div className="flex items-center justify-between">
          <time className="text-xs text-gray-400">
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
